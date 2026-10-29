#!/usr/bin/env node
// 本地审核助手：拉取一个投稿 Issue 的 .gsvvoice，解压、校验、用系统播放器试听。
//
//   node scripts/review.mjs 12            # 按 Issue 编号审核
//   node scripts/review.mjs 12 --no-open  # 只解压，不自动播放
//   node scripts/review.mjs --zip path/to/voice-xxxxxxxx.gsvvoice
//
// 公开仓库读取不需要 token；也可用 GITHUB_TOKEN 提高速率限制。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip } from './zip.mjs';

const DEFAULT_REPO = process.env.GSV_REPO || 'TaoruiLiu19/gsv-market';
const API = 'https://api.github.com';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function fail(message) {
  console.error(`\n[审核失败] ${message}\n`);
  process.exit(1);
}

function authHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gsv-market-review',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function getJson(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    if (res.status === 404) fail(`找不到 Issue（${url}）。请确认编号和仓库。`);
    fail(`GitHub API 返回 ${res.status}：${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

function extractMeta(files) {
  if (!files.has('voice.json')) fail('音色包缺少 voice.json');
  let meta;
  try {
    meta = JSON.parse(files.get('voice.json').toString('utf8'));
  } catch {
    fail('voice.json 不是合法 JSON');
  }
  if (!meta || typeof meta !== 'object') fail('voice.json 格式错误');
  return meta;
}

function pickAudio(files) {
  const audioExt = /\.(wav|mp3|ogg|flac|m4a)$/i;
  const name = [...files.keys()].find((n) => /^speaker\.(wav|mp3|ogg|flac|m4a)$/i.test(n))
    || [...files.keys()].find((n) => audioExt.test(n));
  if (!name) fail('音色包缺少音频文件');
  return { name, data: files.get(name) };
}

function findAttachment(body) {
  const matches = [
    ...body.matchAll(/https:\/\/github\.com\/user-attachments\/[^\s)<>"']+/g),
    ...body.matchAll(/https:\/\/user-images\.githubusercontent\.com\/[^\s)<>"']+/g),
  ].map((m) => m[0].replace(/[.,;]+$/, ''));
  return [...new Set(matches)];
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'gsv-market-review' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw new Error('不是 ZIP/.gsvvoice 文件');
  return buffer;
}

function report(meta, audioName, audioHash, sourceHash, outDir) {
  const lines = [
    '',
    '================ 音色投稿审核 ================',
    `名称：${meta.name || '（缺失）'}`,
    `作者：${meta.author || '（缺失）'}`,
    `许可：${meta.license || '（缺失）'}`,
    `语言：${meta.language || '（未填）'}    标签：${Array.isArray(meta.tags) && meta.tags.length ? meta.tags.join('、') : '（无）'}`,
    `提示文本：${meta.promptText ? meta.promptText.slice(0, 120) : '（空，引擎可能自动转写）'}`,
    `音频文件：${audioName}（${(audioHash ? '已' : '未')}计算 SHA-256）`,
    `文件 SHA-256：${audioHash || '（未计算）'}`,
    `声明 SHA-256：${sourceHash || '（未声明）'}`,
  ];
  if (audioHash && sourceHash) {
    lines.push(audioHash === sourceHash ? '哈希校验：一致 ✅' : '哈希校验：不一致 ⚠️（请谨慎审核）');
  }
  lines.push(`解压目录：${outDir}`);
  lines.push('==============================================');
  lines.push('');
  console.log(lines.join('\n'));
}

function openWithDefaultPlayer(file) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '', `"${file}"`];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [file];
  } else {
    command = 'xdg-open';
    args = [file];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => console.log(`无法自动播放，请手动打开：${file}`));
  child.unref();
}

async function main() {
  const issueArg = process.argv.slice(2).find((value) => /^\d+$/.test(value)) || arg('issue');
  const zipPath = arg('zip');
  const noOpen = process.argv.includes('--no-open');

  if (!issueArg && !zipPath) {
    console.log('用法：node scripts/review.mjs <issue编号> [--no-open]');
    console.log('  或：node scripts/review.mjs --zip <本地 .gsvvoice> [--no-open]');
    process.exit(2);
  }

  let zipBytes;
  let issueInfo = null;
  let comments = [];
  if (zipPath) {
    if (!existsSync(zipPath)) fail(`找不到文件：${zipPath}`);
    zipBytes = readFileSync(zipPath);
    if (!(zipBytes[0] === 0x50 && zipBytes[1] === 0x4b)) fail('不是 ZIP/.gsvvoice 文件');
  } else {
    issueInfo = await getJson(`${API}/repos/${DEFAULT_REPO}/issues/${issueArg}`);
    console.log(`Issue #${issueInfo.number}：${issueInfo.title}`);
    console.log(`状态：${issueInfo.state}    标签：${(issueInfo.labels || []).map((l) => l.name).join('、') || '（无）'}`);
    console.log(`链接：${issueInfo.html_url}`);
    comments = await getJson(`${API}/repos/${DEFAULT_REPO}/issues/${issueArg}/comments?per_page=100`);
    const summary = comments.find((c) => c.body && (c.body.includes('投稿校验通过') || c.body.includes('已发布到音色市场')));
    if (summary) {
      console.log('\n--- 自动校验摘要 ---');
      console.log(summary.body);
      console.log('-------------------\n');
    }

    const attachments = findAttachment(issueInfo.body || '');
    if (attachments.length === 0) fail('Issue 正文里没有 .gsvvoice 附件。');
    let lastError = null;
    for (const url of attachments) {
      try {
        zipBytes = await download(url);
        break;
      } catch (error) {
        lastError = error;
        console.warn(`附件下载失败（${error.message}），尝试下一个…`);
      }
    }
    if (!zipBytes) {
      fail(
        `附件下载失败：${lastError ? lastError.message : '未知错误'}。\n` +
        'github.com / objects.githubusercontent.com 在部分网络不可达；请在浏览器里打开 Issue 手动下载附件，' +
        '再用 --zip 参数审核本地文件。',
      );
    }
  }

  const files = readZip(zipBytes);
  const meta = extractMeta(files);
  const audio = pickAudio(files);

  const outDir = join(tmpdir(), `gsv-review-${issueArg || 'local'}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const ext = audio.name.split('.').pop().toLowerCase();
  const audioPath = join(outDir, `speaker.${ext}`);
  writeFileSync(audioPath, audio.data);

  let audioHash = '';
  try {
    audioHash = createHash('sha256').update(audio.data).digest('hex');
  } catch { /* ignore */ }
  const sourceHash = meta.source && typeof meta.source.sha256 === 'string' ? meta.source.sha256 : '';

  report(meta, audio.name, audioHash, sourceHash, outDir);

  if (issueInfo) {
    console.log('满意就去 Issue 右侧添加 `approved` 标签，自动发布会把音频转成 64kbps MP3 并上架。');
    console.log(`不满意可加 \`invalid\` 或直接评论后关闭：${issueInfo.html_url}`);
    const labels = (issueInfo.labels || []).map((l) => l.name);
    if (!labels.includes('validated')) {
      console.log('注意：该 Issue 目前没有 `validated` 标签，可能还未通过自动校验。');
    }
  }

  if (noOpen) {
    console.log(`已跳过自动播放（--no-open）。音频：${audioPath}`);
  } else {
    console.log(`正在用系统默认播放器打开：${audioPath}`);
    openWithDefaultPlayer(audioPath);
  }
}

main().catch((error) => fail(String(error?.message || error)));
