# MVP4：浏览器内嵌终端（Codex/Claude Code）

## 背景
当前页面的「Codex 输出」更像日志窗口：可以看到运行输出，但无法像本地终端一样完整交互；同时 Codex 的 TUI 输出存在字符/布局错位（通常与终端尺寸不同步有关）。

本 MVP 目标是在网页中提供“近似 VS Code 集成终端”的体验：多终端标签、可输入、可切换、可新建，并内置 Codex CLI 与 Claude Code 的启动配置。

## 目标
1. 在 Dashboard 中提供终端面板（Terminal Panel），具备 VS Code 风格的多终端 tab 切换与“新建终端”。
2. 终端支持完整交互：键盘输入、粘贴、方向键等控制序列透传到后端 PTY。
3. 修复 Codex/终端显示错位：前端 xterm 的 cols/rows 变化实时同步到后端 PTY resize。
4. 增加「Claude Code（全自动）」终端配置：运行 `claude --dangerously-skip-permissions`。
5. 原子任务列表中点击“开始”，在终端中启动 Codex CLI（交互模式），并自动注入任务执行文档路径作为初始 prompt。

## 范围（In Scope）
- Dashboard：终端 UI、创建/切换/关闭终端、输入与输出渲染、尺寸同步。
- Bridge：多终端会话管理（多 PTY 进程并存）、WebSocket 推送每个终端的输出、按终端 ID 转发输入与 resize。
- Spec 流程：原子任务“开始”生成 run doc（保持现有 run doc 产出），并启动一个 Codex 终端会话。

## 非目标（Out of Scope）
- 不做完整 VS Code 的所有终端功能（分屏、搜索、终端复用策略等）。
- 不做复杂的权限沙箱策略 UI（仍由 Codex/Claude 的参数决定）。
- 不保证在所有浏览器/字体下像素级一致（以“无错位、可用”为准）。

## 关键用户故事
1. 作为开发者，我在网页里点“开始”，能看到 Codex 的完整 CLI 界面，并能继续输入指令/文字与之交互。
2. 作为开发者，我可以新建多个终端（PowerShell / Claude Code / Codex），并像 VS Code 一样在 tab 间切换。
3. 作为开发者，当我拖动页面或窗口尺寸变化时，Codex 的界面不会出现字符错位、换行错乱。

## 验收标准（AC）
- AC1：在 `tasks_atomic` 视图中可见终端面板，默认显示一个终端 tab；点击 “+ 新建终端” 可创建第二个终端并切换。
- AC2：Codex 终端可输入（至少：输入文字、回车、方向键不会失效），并能在终端中看到回显/响应。
- AC3：终端在容器尺寸变化（窗口缩放、面板高度变化）后，Codex/Claude 的 TUI 不出现明显字符错位；后端 PTY 的 cols/rows 会更新。
- AC4：存在“Claude Code（全自动）”终端配置，一键启动 `claude --dangerously-skip-permissions`。
- AC5：执行 `npm run build`（dashboard）通过；Bridge 服务启动后可正常创建/关闭终端，不影响既有 spec 编辑与原子化功能。

