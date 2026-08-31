# dsh-gsv 音色市场 · 静态下载/试音站点

「dsh-gsv 音色市场」的浏览器端门户：浏览、试听、获取音色。纯静态，可托管于 GitHub Pages，与插件 `dsh-gsv-tts` 的音色市场共用同一份 `voices.json`。

## 目录结构

```
GSV市场/
├── index.html            单页站点：音色卡片 + 试听 + 复制安装命令
├── voices.json           音色清单（与插件 `voiceRegistryUrl` 共用）
├── build-meta.json       缓存键（voices.json 的 commitHash，CI 自动重写）
└── .github/workflows/
    └── build-meta.yml    每次 push 自动重算缓存键，实现零人工缓存刷新
```

## 使用

1. `voices.json` 中新增/修改音色条目。
2. 推送到 GitHub（需在仓库设置中启用 Pages，分支选择 `master` 或 `main`）。
3. CI 自动重写 `build-meta.json`，站点下次访问即加载新清单。

## 音色条目

每条 `voice` 与 `docs/voices.json`（插件仓库内）结构一致，含：

- `id`：唯一标识
- `name` / `author` / `license`
- `speaker` / `prompt`：试听与模型用音频直链
- `promptText`：试音文本
- `sizeBytes` / `sha256`：体积与完整性校验

## 约定

- 试听音频建议 `≤30s、≤1.5MB`；仓库内只放试音小段，完整资源另走对象存储。
- 站点通过 `build-meta.json` 的动态缓存键加载 `voices.json?v=<hash>`，更新音色无需改动 HTML。