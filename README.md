# Open Director

Clean-room 架构重构的开源代码式视频剪辑与 `.motion` 确定性引擎，覆盖从协议规范、模板系统、渲染导出到 Web 时间线编辑器与多轮 AI 导演协作的全部阶段。完全在本地运行，零商业账号、积分钱包或闭源模板依赖。

## 架构总览

- **`packages/protocol`** (`@open-director/protocol`)：核心协议库。涵盖 `motion.json`（模板与工程）校验、`composition.html`（`parse5`）双向解析与序列化、`overrides` / `film.params` CSS 自定义属性编解码、`cues.json`（词点 / 片段边界 / 音乐小节拍点）、WebVTT / SRT 字幕映射与合并导出、`FCPXML 1.10` 导出、结构化原子操作（`move` / `trim` / `split` / `set` / `fade` / `text` / `style` / `param` / `box` / `add` / `remove` / `ripple` / `attr` / `track`）与 SHA-256 冲突校验撤销日志，以及内置 `/__film/motion-primitives.mjs`。
- **`packages/engine`** (`@open-director/engine`)：确定性渲染与导出引擎。提供 `window.filmHost` 时钟注入、本地 HTTP Range 预览服务、10 种内置程序化合成 SFX（`/__film/sfx/<id>`）、Headless Chrome 逐帧渲染与 `data-film-sample` / 文本溢出检测、FFmpeg `image2pipe` 视频编码 + 多轨音频独立混音（支持 `film.sfx` 声相增益与 `data-adudir-duck` 人声自动闪避）、`.motion` ZIP 打包/解包与 `integrity.json` 校验、实测 LUFS 响度与节拍检测、dHash 帧哈希以及模板发现与实例化。
- **`packages/mcp-server`** (`@open-director/mcp-server`)：AI 导演协作接口与命令行工具 `open-director`（支持 `init` / `templates` / `new` / `validate` / `audit` / `params` / `look` / `render` / `edit` / `undo` / `history` / `beats` / `sfx` / `fcpxml` / `srt` / `pack` / `unpack` / `mcp`）。
- **`packages/studio-server`** (`@open-director/studio-server`)：Web 编辑器本地后端（REST + WebSocket），支持工程切换、模板实例化、素材上传、响度一键统一、节拍分析、多轮工具调用 AI 导演循环（含无 Key 本地规则引擎）、Follow-along 变更广播与操作代码 Diff 计算。
- **`apps/studio-web`** (`@open-director/studio-web`)：React + TypeScript 三栏 NLE Web 编辑器（左栏：素材导入/模板库/预检与响度匹配；中栏：实时舞台预览 + 画布拖拽缩放 Gizmo + SFX/字幕同步；底栏：时间线移动/双边裁剪/播放头切开/字幕轨/Cues 标记/Follow-along 高亮脉冲；右栏：属性与 `film.params` 面板/多轮 AI 导演/操作历史与源码 Diff）。
- **`services/analyzer`** (`open-director-analyzer`)：轻量 Python FastAPI 音视频分析微服务，整合 `adudir-open` 的 MIT 开源算法（音乐格式检测、响度规划、SFX 匹配、近重复聚类、时间线质量检查）以及基于 NumPy/Pillow 的真实帧黑屏/模糊/静止/dHash 检测。
- **`templates/`**：3 套完整可运行 `.motion` 模板（`paper-perspective-talking-head`、`knowledge-cards`、`product-launch-promo`）。
- **`examples/demo-talking-head`** ：标准可运行的 `.motion` 示例工程。

## 快速开始

```bash
# 1. 安装 Node 依赖并编译全部包
npm install
npm run build

# 2. 运行全部 TS/Node 测试（覆盖协议、确定性渲染、SFX/Ducking、3 套模板、MCP、Studio Server）
npm test

# 3. 命令行体验（验证 / 抽帧 / 导出 MP4 / 导出 FCPXML / 导出 SRT）
node packages/mcp-server/dist/cli.js templates
node packages/mcp-server/dist/cli.js audit examples/demo-talking-head
node packages/mcp-server/dist/cli.js render examples/demo-talking-head --out /tmp/demo.mp4
node packages/mcp-server/dist/cli.js fcpxml examples/demo-talking-head --out /tmp/timeline.fcpxml

# 4. 启动完整 Web 编辑器
npm run dev:studio
# 浏览器打开 http://127.0.0.1:4173
```

## Python 音视频分析服务

```bash
cd services/analyzer
uv sync --extra dev
uv run pytest -v
uv run uvicorn open_director_analyzer.main:app --port 8765
```
