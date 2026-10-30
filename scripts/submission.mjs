#!/usr/bin/env node
// 音色投稿校验与发布脚本（GitHub Actions 调用）。
//
//   node scripts/submission.mjs validate --body <issue-body.md> --out <dir>
//   node scripts/submission.mjs publish  --body <issue-body.md> --out <dir> --issue <number>
//
// 数据来源：Issue 正文里拖入的 .gsvvoice（= voice.json + speaker.*）。
// voice.json 是元数据唯一来源；校验通过后由 ffmpeg 统一转码为单声道 64kbps MP3。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readZip } from './zip.mjs';

const REPO = 'TaoruiLiu19/gsv-market';
const PAGES_BASE = 'https://taoruiliu19.github.io/gsv-market/voices/';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
const MIN_DURATION = 1;
const MAX_DURATION = 30;
const MAX_NAME = 60;
const MAX_AUTHOR = 40;
const MAX_PROMPT = 2000;
const LICENSES = ['CC0 1.0（公共领域）', 'CC BY 4.0（署名）', 'CC BY-SA 4.0（署名-相同方式共享）', '作者明确授权分发'];

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function die(message) {
  throw new Error(message);
}

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    die(`${bin} 执行失败：${String(result.stderr || result.stdout || '').slice(0, 500)}`);
  }
  return result;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function cleanText(value, max, field) {
  if (typeof value !== 'string') die(`${field} 必须是字符串`);
  const text = value.trim();
  if (!text) die(`${field} 不能为空`);
  if (text.length > max) die(`${field} 过长（上限 ${max} 字）`);
  if (/[\u0000-\u001f\u007f]/.test(text)) die(`${field} 含有非法控制字符`);
  return text;
}

function extractMeta(files) {
  if (!files.has('voice.json')) die('音色包缺少 voice.json');
  const raw = files.get('voice.json');
  if (raw.length > 64 * 1024) die('voice.json 过大');
  let meta;
  try {
    meta = JSON.parse(raw.toString('utf8'));
  } catch {
    die('voice.json 不是合法 JSON');
  }
  if (!meta || typeof meta !== 'object') die('voice.json 格式错误');

  const name = cleanText(meta.name, MAX_NAME, '名称');
  const author = cleanText(meta.author, MAX_AUTHOR, '作者');
  const license = cleanText(meta.license, 60, '许可');
  if (!LICENSES.includes(license)) die(`许可必须从以下选项中选择：${LICENSES.join(' / ')}`);
  if (meta.consent !== true) die('必须勾选授权声明');
  const promptText = typeof meta.promptText === 'string' ? meta.promptText.trim() : '';
  if (promptText.length > MAX_PROMPT) die(`提示文本过长（上限 ${MAX_PROMPT} 字）`);
  let tags = meta.tags;
  if (tags === undefined) tags = [];
  if (!Array.isArray(tags) || tags.length > 10) die('标签必须是最多 10 个的数组');
  tags = tags.map((tag) => cleanText(tag, 20, '标签'));
  let language = typeof meta.language === 'string' ? meta.language.trim() : 'zh-CN';
  if (!language || language.length > 20) die('语言字段非法');

  return { name, author, license, promptText, tags, language };
}

function pickAudio(files) {
  const audioExt = /\.(wav|mp3|ogg|flac|m4a)$/i;
  const preferred = [...files.keys()].find((n) => /^speaker\.(wav|mp3|ogg|flac|m4a)$/i.test(n));
  const name = preferred || [...files.keys()].find((n) => audioExt.test(n));
  if (!name) die('音色包缺少音频文件（speaker.wav/mp3/ogg/flac/m4a）');
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
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'gsv-market-submission' } });
  if (!res.ok) die(`下载附件失败：HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_UPLOAD_BYTES) die('附件超过 15MB 上限');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_UPLOAD_BYTES) die('附件超过 15MB 上限');
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) die('附件不是 ZIP/.gsvvoice 文件');
  return buffer;
}

function probe(file) {
  const fake = process.env.GSV_FAKE_PROBE;
  if (fake) return JSON.parse(fake);
  const bin = process.env.FFPROBE_BIN || 'ffprobe';
  const out = run(bin, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,channels,sample_rate,duration',
    '-of', 'json',
    file,
  ]).stdout;
  return JSON.parse(out);
}

function transcode(input, output) {
  if (process.env.GSV_FAKE_TRANSCODE === '1') {
    copyFileSync(input, output);
    return;
  }
  const bin = process.env.FFMPEG_BIN || 'ffmpeg';
  run(bin, ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '24000', '-b:a', '64k', '-map_metadata', '-1', output]);
}

function nextVersion(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return '1.0.1';
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

async function validate(bodyPath, outDir, root, zipPath) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let zipBytes;
  if (zipPath) {
    zipBytes = readFileSync(zipPath);
    if (zipBytes.length > MAX_UPLOAD_BYTES) die('附件超过 15MB 上限');
    if (!(zipBytes[0] === 0x50 && zipBytes[1] === 0x4b)) die('不是 ZIP/.gsvvoice 文件');
  } else {
    const body = readFileSync(bodyPath, 'utf8');
    const attachments = findAttachment(body);
    if (attachments.length === 0) {
      if (/\.gsvvoice\b/i.test(body)) {
        die('检测到文件名，但没有附件链接：文件没有真正拖进 Issue 正文。请在编辑正文时把 `.gsvvoice` 文件拖进去，确认正文出现文件链接后再保存。');
      }
      die('Issue 正文里没有找到附件：请把 `.gsvvoice` 文件拖进正文。');
    }
    zipBytes = null;
    let lastError = null;
    for (const url of attachments) {
      try {
        zipBytes = await download(url);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!zipBytes) die(lastError ? lastError.message : '下载附件失败');
  }

  const files = readZip(zipBytes);
  const meta = extractMeta(files);
  const audio = pickAudio(files);
  const ext = audio.name.split('.').pop().toLowerCase();
  const inputPath = join(outDir, `input.${ext}`);
  writeFileSync(inputPath, audio.data);

  const info = probe(inputPath);
  const stream = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!stream) die('文件里没有音频轨道');
  const duration = Number(info.format?.duration ?? stream.duration);
  if (!Number.isFinite(duration) || duration < MIN_DURATION) die(`音频过短（至少 ${MIN_DURATION} 秒）`);
  if (duration > MAX_DURATION + 0.5) die(`音频过长（上限 ${MAX_DURATION} 秒，当前 ${duration.toFixed(1)} 秒）`);
  const channels = Number(stream.channels || 0);
  if (channels > 2) die('音频声道数过多（最多 2 声道）');
  const sampleRate = Number(stream.sample_rate || 0);
  if (sampleRate < 16000) die(`采样率过低（至少 16kHz，当前 ${sampleRate}Hz）`);

  const outputPath = join(outDir, 'voice.mp3');
  transcode(inputPath, outputPath);
  if (!existsSync(outputPath)) die('转码失败：没有生成 mp3');
  const mp3 = readFileSync(outputPath);
  if (mp3.length === 0) die('转码失败：mp3 为空');
  if (mp3.length > MAX_OUTPUT_BYTES) die('转码后文件过大（超过 3MB）');

  const manifestPath = join(root, 'voices.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.voices)) die('voices.json 缺少 voices 数组');
  const names = new Set(manifest.voices.map((v) => v.name));
  if (names.has(meta.name)) die(`名称已存在：${meta.name}，请换一个名称`);
  const hash = sha256(mp3);
  const dup = manifest.voices.find((v) => v.sha256 && (v.sha256.speaker === hash || v.sha256.prompt === hash));
  if (dup) die(`该音频已存在（音色 ${dup.id}），请勿重复上传`);

  const ids = new Set(manifest.voices.map((v) => v.id));
  let id = `voice-${hash.slice(0, 8)}`;
  let suffix = 10;
  while (ids.has(id)) {
    id = `voice-${hash.slice(0, suffix)}`;
    suffix += 2;
  }

  const entry = {
    id,
    name: meta.name,
    author: meta.author,
    license: meta.license,
    speaker: `${PAGES_BASE}${id}.mp3`,
    prompt: `${PAGES_BASE}${id}.mp3`,
    promptText: meta.promptText,
    sizeBytes: mp3.length,
    sha256: { speaker: hash, prompt: hash },
    tags: meta.tags,
    language: meta.language,
    reviewed: true,
  };
  writeFileSync(join(outDir, 'entry.json'), JSON.stringify(entry, null, 2) + '\n');
  writeFileSync(join(outDir, 'status.json'), JSON.stringify({ ok: true, id, name: meta.name, author: meta.author }, null, 2) + '\n');
  writeFileSync(
    join(outDir, 'summary.md'),
    [
      '### ✅ 投稿校验通过',
      '',
      `- **名称**：${meta.name}`,
      `- **作者**：${meta.author}`,
      `- **许可**：${meta.license}`,
      `- **时长**：${duration.toFixed(1)} 秒`,
      `- **大小**：${(mp3.length / 1024).toFixed(0)} KB`,
      `- **音色 ID**：\`${id}\``,
      `- **提示文本**：${meta.promptText ? meta.promptText.slice(0, 80) : '（空，引擎将尝试自动转写）'}`,
      '',
      '维护者试听确认后，给本 Issue 添加 `approved` 标签即可发布到音色市场。',
    ].join('\n') + '\n',
  );
  console.log(`validated ${id} (${meta.name} by ${meta.author})`);
}

async function publish(bodyPath, outDir, root, issue, noPush) {
  const status = JSON.parse(readFileSync(join(outDir, 'status.json'), 'utf8'));
  if (!status.ok) die('校验未通过，不能发布');
  const entry = JSON.parse(readFileSync(join(outDir, 'entry.json'), 'utf8'));
  const mp3Path = join(outDir, 'voice.mp3');
  const mp3 = readFileSync(mp3Path);
  if (sha256(mp3) !== entry.sha256.speaker) die('音频哈希与校验结果不一致，请重新投稿');

  const manifestPath = join(root, 'voices.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.voices.some((v) => v.id === entry.id)) die(`id 已存在：${entry.id}`);
  if (manifest.voices.some((v) => v.name === entry.name)) die(`名称已存在：${entry.name}`);
  if (manifest.voices.some((v) => v.sha256 && v.sha256.speaker === entry.sha256.speaker)) die('音频已存在');

  mkdirSync(join(root, 'voices'), { recursive: true });
  const target = join(root, 'voices', `${entry.id}.mp3`);
  copyFileSync(mp3Path, target);

  manifest.version = nextVersion(manifest.version);
  manifest.voices.push(entry);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  // GITHUB_TOKEN 触发的 push 不会再次触发 build-meta 工作流，这里直接刷新缓存键。
  const voicesHash = run('git', ['hash-object', 'voices.json'], { cwd: root }).stdout.trim();
  writeFileSync(join(root, 'build-meta.json'), `{"voicesHash":"${voicesHash}"}\n`);

  run('git', ['add', 'voices.json', 'build-meta.json', `voices/${entry.id}.mp3`], { cwd: root });
  run('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `feat(voice): add ${entry.id} (#${issue})`], { cwd: root });
  if (noPush) {
    console.log('skip git push (--no-push)');
  } else {
    try {
      run('git', ['push'], { cwd: root });
    } catch (error) {
      run('git', ['pull', '--rebase', '--autostash'], { cwd: root });
      run('git', ['push'], { cwd: root });
    }
  }

  writeFileSync(
    join(outDir, 'published.md'),
    [
      '### 🎉 已发布到音色市场',
      '',
      `- **名称**：${entry.name}`,
      `- **作者**：${entry.author}`,
      `- **许可**：${entry.license}`,
      `- **音色 ID**：\`${entry.id}\``,
      '',
      '安装命令：',
      '```',
      `帮我安装音色 ${entry.id}（来自 dsh-gsv-tts 音色市场）`,
      '```',
      '',
      'GitHub Pages 部署完成后即可在 https://taoruiliu19.github.io/gsv-market/ 看到。',
    ].join('\n') + '\n',
  );
  console.log(`published ${entry.id} (#${issue})`);
}

async function main() {
  const command = process.argv[2];
  const bodyPath = arg('body');
  const zipPath = arg('zip');
  const outDir = arg('out');
  const root = resolve(arg('repo-root', process.cwd()));
  if (!outDir || (command === 'validate' && !bodyPath && !zipPath)) {
    console.error('usage: submission.mjs <validate|publish> (--body <file> | --zip <pack>) --out <dir> [--repo-root <dir>] [--issue <n>] [--no-push]');
    process.exit(2);
  }
  try {
    if (command === 'validate') {
      await validate(bodyPath, outDir, root, zipPath);
    } else if (command === 'publish') {
      const issue = arg('issue', '0');
      await publish(bodyPath, outDir, root, issue, process.argv.includes('--no-push'));
    } else {
      die(`未知命令：${command}`);
    }
  } catch (error) {
    const message = String(error?.message || error);
    mkdirSync(outDir, { recursive: true });
    const validateFailed = command === 'validate';
    const reason = validateFailed && /附件/.test(message) ? 'missing-attachment' : 'invalid';
    writeFileSync(join(outDir, 'status.json'), JSON.stringify({ ok: false, error: message, reason }, null, 2) + '\n');
    const footer = validateFailed
      ? [
          '',
          '---',
          '',
          '### 如何修复',
          '',
          '1. 打开上传页重新生成（本地文件已删除时）：https://taoruiliu19.github.io/gsv-market/upload.html',
          '2. 点击本 Issue 右上角 **Edit**，把 `.gsvvoice` 文件拖进正文（不是只写文件名）',
          '3. 保存后会自动重新校验；通过后标签会变为 `validated`',
          '',
          '> 手机端不方便拖拽附件，建议用桌面浏览器。',
          '',
        ].join('\n')
      : '\n请查看 Actions 日志；修复后重新添加 `approved` 标签重试。\n';
    writeFileSync(join(outDir, 'error.md'), `### ❌ ${validateFailed ? '投稿未通过' : '发布失败'}\n\n${message}\n${footer}`);
    console.log(`::error::${message}`);
    process.exitCode = 1;
  }
}

main();
