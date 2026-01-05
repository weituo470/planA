# MVP4 设计：浏览器内嵌终端（Codex/Claude Code）

## 架构概览
- Dashboard（前端）：
  - 使用 `@xterm/xterm` 渲染终端；
  - 使用 `socket.io-client` 与 Bridge 建立连接，订阅“指定终端 ID”的输出流；
  - 将 xterm 的 `onData` 输入透传到 Bridge：`POST /terminals/:id/input`；
  - 将 xterm 的尺寸（cols/rows）透传到 Bridge：`POST /terminals/:id/resize`；
  - 提供 tab UI：多个终端会话（terminalId）可切换、可关闭、可新建。

- Bridge（后端）：
  - 用 `node-pty` 管理多个 PTY 进程（每个终端一个）；
  - 通过 Socket.IO 推送 `terminal:data`、`terminal:exit` 事件（携带 terminalId）；
  - 提供 REST API：创建/列表/输入/resize/关闭。

## Bridge API 设计
### 数据结构
TerminalSession（内存态）：
- `id`: string
- `title`: string
- `command`: string
- `args`: string[]
- `cwd`: string
- `pid`: number
- `running`: boolean
- `createdAt`: string
- `exitedAt`: string | null
- `exitCode`: number | null

### REST
- `GET /terminals`
  - 返回终端列表（不含输出内容）。

- `POST /terminals`
  - body: `{ title?: string, command: string, args?: string[], cwd?: string }`
  - 创建终端并返回 `{ id, pid, title }`

- `POST /terminals/:id/input`
  - body: `{ input: string }`
  - 向对应 PTY 写入输入。

- `POST /terminals/:id/resize`
  - body: `{ cols: number, rows: number }`
  - 调用 `pty.resize(cols, rows)`，用于修复 TUI 布局错位。

- `DELETE /terminals/:id`
  - 关闭终端（kill PTY），并从列表移除。

### WebSocket（Socket.IO）
- `terminal:data`
  - payload: `{ terminalId: string, data: string }`
- `terminal:exit`
  - payload: `{ terminalId: string, exitCode: number }`

> 说明：终端输出可能非常大，不写入 Bridge 的 events.jsonl，避免日志文件膨胀。

## Dashboard UI 设计（VS Code 风格）
终端面板布局（位于原子任务视图下方）：
- 顶部 tab bar：
  - 终端 tab（标题 + 关闭按钮）
  - “+” 新建按钮（弹出选择：PowerShell / Claude Code（全自动）/ Codex（空会话））
- 内容区：
  - 每个 tab 对应一个 xterm 容器（非激活的隐藏）。

## Codex / Claude Code 启动策略
- Codex（原子任务）：
  - Bridge 仍生成 `runDoc`；
  - 以交互模式启动 `codex`（无 `exec` 子命令），并把“任务执行文档绝对路径”作为 `PROMPT` 参数传入。

- Claude Code（全自动）：
  - 启动命令：`claude --dangerously-skip-permissions`
  - 工作目录默认 `REPO_DIR`。

## 关键实现要点
1. 终端尺寸同步：xterm FitAddon `fit()` 后获取 cols/rows，调用 `/terminals/:id/resize`。
2. 输入透传：xterm `onData` 直接 POST 到 `/terminals/:id/input`。
3. 多终端并行：Bridge 使用 `Map` 管理 PTY，不再复用单个全局 `ptyProcess`。

