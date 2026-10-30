# dsh-gsv 音色市场 · 静态下载/试音站点

「dsh-gsv 音色市场」的浏览器端门户：浏览、试听、获取音色。纯静态，托管于 GitHub Pages，与插件 `dsh-gsv-tts` 的音色市场共用同一份 `voices.json`。

投稿指南（中英双语）：[VOICE_MARKET.md](VOICE_MARKET.md)

## 目录结构

```
GSV市场/
├── index.html                     单页站点：音色卡片 + 试听 + 复制安装命令
├── upload.html                    上传页：裁剪/转码/生成 .gsvvoice/预填 Issue
├── assets/
│   └── pack.mjs                   WAV 编码、ZIP 打包、SHA-256（浏览器与 Node 共用）
├── scripts/
│   ├── submission.mjs             Issue 校验与发布（GitHub Actions 调用）
│   ├── review.mjs                 本地审核：拉取投稿包、解压、试听
│   └── zip.mjs                    安全 ZIP 读取器（拒绝路径穿越/加密/超大包）
├── voices.json                    音色清单（与插件 `voiceRegistryUrl` 共用）
├── voices/                        已上架音频（单声道 24kHz 64kbps MP3）
├── build-meta.json                缓存键（voices.json 的 git hash，CI 自动重写）
└── .github/
    ├── ISSUE_TEMPLATE/voice-submission.md
    └── workflows/
        ├── build-meta.yml         每次 push 自动重算缓存键
        └── voice-submission.yml   投稿校验 / 审核后自动发布
```

## 浏览页

1. `index.html` 先读 `build-meta.json` 拿缓存键，再拉 `voices.json?v=<hash>`。
2. 卡片展示名称、**作者**、许可、大小、提示文本；试听优先走 jsDelivr，失败自动回落到清单里的原始地址。
3. 支持“下载音频”和“复制安装命令”。

## 上传流程（无需后端、无需域名）

1. 打开 `upload.html`，选择或录制音频（自动截取前 30 秒，转单声道 24kHz WAV）。
2. 填写名称、**作者姓名**、许可、语言、标签、提示文本，勾选授权声明。
3. 点击“生成音色包并打开 GitHub”，浏览器本地生成 `.gsvvoice`（`voice.json` + `speaker.wav`），并打开预填好的 Issue 页面。
4. **把 `.gsvvoice` 拖进 Issue 正文**（不是只写文件名），确认正文出现文件链接后再提交。
5. Actions 自动校验：解压、`ffprobe` 检查时长/声道/采样率、`ffmpeg` 转单声道 64kbps MP3、算 SHA-256、查重；通过后评论摘要并打 `validated` 标签。
6. 维护者试听后添加 `approved` 标签：Actions 重新校验并发布到 `voices/`、更新 `voices.json`，评论安装命令并关闭 Issue。
7. Pages 部署完成后，站点与插件市场同时可见。

> ⚠️ 最常见的失败是**附件没拖进去**：如果正文里只有 `voice-xxxxxxxx.gsvvoice` 文件名、没有文件链接，校验会失败并打上 `needs-attachment`。编辑 Issue 正文，把文件拖进去后保存即可自动重跑。
>
> 手机端不方便拖拽附件，建议用桌面浏览器；本地文件删了可重新打开上传页生成。

### 校验规则

| 项 | 限制 |
|---|---|
| 音频格式 | wav / mp3 / ogg / flac / m4a |
| 时长 | 1–30 秒（上传页超过 30 秒自动截取） |
| 声道 / 采样率 | ≤2 声道；≥16kHz |
| 原始体积 | ≤15MB |
| 转码后 | 单声道 24kHz 64kbps MP3，≤3MB |
| 元数据 | 名称 ≤60 字、作者 ≤40 字、提示文本 ≤2000 字、标签 ≤10 个 |
| 许可 | CC0 1.0 / CC BY 4.0 / CC BY-SA 4.0 / 作者明确授权分发 |
| 去重 | 按最终 MP3 的 SHA-256 与清单查重；名称与 id 唯一 |

### 标签

| 标签 | 含义 |
|---|---|
| `validated` | 自动校验通过，等待人工试听 |
| `invalid` | 校验未通过，按评论提示修改后编辑 Issue 重试 |
| `needs-attachment` | 正文缺少 `.gsvvoice` 附件，按评论步骤拖入文件 |
| `approved` | 维护者批准，触发自动发布 |
| `published` | 已发布并关闭 Issue |

## 审核（维护者）

审核队列在仓库 Issues 里：

```
https://github.com/TaoruiLiu19/gsv-market/issues?q=is%3Aissue+is%3Aopen+label%3Avalidated
```

每条投稿的机器人评论会列出名称、作者、许可、时长、大小和音色 ID。试听推荐用本地脚本（会自动下载附件、解压、校验哈希并调用系统播放器）：

```bash
node scripts/review.mjs <issue编号>
node scripts/review.mjs <issue编号> --no-open   # 只解压，不自动播放
```

如果本机访问 github.com 不稳定，可以在浏览器里手动下载 Issue 里的 `.gsvvoice`，再本地审核：

```bash
node scripts/review.mjs --zip path/to/voice-xxxxxxxx.gsvvoice
```

试听满意后，在 Issue 右侧 Labels 里添加 `approved`，工作流会自动发布并关闭 Issue；不满意则加 `invalid` 或评论后关闭。

## 音频地址

- 上架音频：`https://taoruiliu19.github.io/gsv-market/voices/<id>.mp3`（清单里的 `speaker`/`prompt`）。
- 站点试听会改写为 `https://cdn.jsdelivr.net/gh/TaoruiLiu19/gsv-market@main/voices/<id>.mp3`，失败自动回落到 Pages 地址。
- 旧条目仍指向 `raw.githubusercontent.com/.../dsh-gsv/...`，站点会改写为 jsDelivr。

## 本地测试

```bash
# 校验一个本地音色包（需要本机有 ffmpeg/ffprobe）
node scripts/submission.mjs validate --zip path/to/voice-xxxxxxxx.gsvvoice --out /tmp/submission

# 只验证元数据/打包逻辑（没有 ffmpeg 时）
GSV_FAKE_PROBE='{"format":{"duration":"5.0"},"streams":[{"codec_type":"audio","channels":1,"sample_rate":"24000"}]}' \
GSV_FAKE_TRANSCODE=1 \
node scripts/submission.mjs validate --zip path/to/voice-xxxxxxxx.gsvvoice --out /tmp/submission
```

## 约定

- 试听音频建议 `≤30s、≤1.5MB`；完整参考音频同样限制在 30 秒内。
- 站点通过 `build-meta.json` 的动态缓存键加载 `voices.json?v=<hash>`，更新音色无需改动 HTML。
- 社区投稿一律 `reviewed: true`，但插件对远端清单仍会二次确认；包内清单才是 `trusted: true`。
