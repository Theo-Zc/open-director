# Open Director 架构设计说明

本项目是以 Clean-room 方式基于 `.motion` 开放协议与代码式剪辑理念重构的新一代本地视频生产工作台。与原版商业安装包相比，本重构版本专注于以下工程化边界：

## 1. 剥离项（Non-Goals）

- 剥离所有商业登录态、积分钱包、`adudir.com` / `motiongit.com` 远端同步与内测闸门。
- 剥离加密模板封存（`adudir-sealed`）与跨进程私钥解密链路，所有模板与工程文件均明文可读、可对比、可版本控制。
- 剥离第三方平台爬虫与特定商业供应商硬编码，AI 助手改工程通过本地自带 API Key（BYO Key）或标准 MCP stdio 接入任意外部 Agent（如 Claude Code、Cursor、Antigravity、Codex）。

## 2. 分层架构

```text
apps/studio-web (React + Vite)
   │ HTTP / WebSocket (localhost:4173)
   ▼
packages/studio-server ──► services/analyzer (Python FastAPI: 响度 / 质量 / SFX / 近重复)
   │
   ├──► packages/protocol (motion.json, composition.html, overrides, cues.json, VTT, edit-ops + undo)
   └──► packages/engine   (window.filmHost 时钟接管, stage 合成播放器, Playwright 逐帧捕获 + FFmpeg 混音导出)
           ▲
packages/mcp-server (open-director CLI + stdio MCP Server)
```

## 3. 确定性核心保证

1. **同一时间 `t` 永远得到同一帧**：`packages/engine/src/clock-prelude.ts` 在页面任何模块脚本加载前注入 `window.filmHost`，接管 `performance.now()`、`Date`、`requestAnimationFrame`、`Math.random` 与 Web Animations 时钟。
2. **数据与代码分离**：用户参数调优不改页面源码，而是写入 `composition.html` 片段上的 `overrides` 属性（`:root` CSS 自定义属性与选择器局部变换）。
3. **结构化可撤销修改**：所有人和 AI 的操作均通过 `applyEditOps` 原子校验（防同轨重叠、防越权改锁轨）并追加到 `.open-director/history.jsonl`，支持 SHA-256 冲突检测的单步撤销。
4. **音画分离合成**：页面不发声；所有音轨和视频原声在导出阶段通过 FFmpeg `filter_complex` 精确裁剪（`atrim`）、保持音高变速（`atempo`）、包络淡入淡出（`afade`）与毫秒延时（`adelay`）混音。
