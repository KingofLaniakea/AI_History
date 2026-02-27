# AI History

本项目是一个本地离线的 AI 对话归档平台：桌面应用（Tauri + React）+ 浏览器插件（Chrome/Edge）。

## 已实现能力

- 对话文件夹：多级目录、会话归档
- 一键导入：文件导入 + 链接抓取
- 快速问答跳转：Q1/Q2 导航、`J/K`、`Cmd/Ctrl+G`
- 多平台：ChatGPT / Gemini / AI Studio
- 本地桥接：插件直接将当前会话发送到桌面应用（`127.0.0.1:48765`）
- 数据层：SQLite + FTS5

## 目录

- `apps/desktop`：桌面应用前端
- `apps/desktop/src-tauri`：桌面应用 Rust 后端（SQLite、HTTP Bridge）
- `apps/extension`：Chrome/Edge 插件（WXT）
- `docs/extension-architecture-baseline.md`：插件解耦架构基线与后续接入约束
- `packages/core-types`：共享类型
- `packages/parsers`：导入解析器（JSON/Markdown/HTML）
- `packages/ui`：共享 UI 组件
- `packages/test-fixtures`：解析测试样本
- `tests/parsers`：解析器测试

## 开发命令

```bash
pnpm install
pnpm dev:desktop
pnpm dev:extension
pnpm test:parsers
pnpm build
```

## 关键用法

1. 启动桌面应用（Tauri dev）。
2. 安装插件并打开 ChatGPT/Gemini/AI Studio 页面。
3. 在插件点“抓取当前会话”，自动导入桌面数据库。
4. 若有链接，可在桌面 `链接抓取` 直接导入。
5. 同一会话链接重复抓取时默认覆盖更新，保持最新版本。

## 注意事项

- 需要登录态的会话链接，优先使用插件抓取（桌面直接抓取无法复用浏览器 Cookie）。
- 桌面应用默认纯本地离线，不上传云端。
