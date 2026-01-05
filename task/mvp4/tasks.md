# MVP4 任务清单

## 后端（Bridge）
- [ ] 新增多终端会话管理：创建/列表/输入/resize/关闭（`/terminals` 系列 API）。
- [ ] Socket.IO 推送 `terminal:data` / `terminal:exit`（携带 terminalId）。
- [ ] 为原子任务“开始”提供终端模式启动接口：生成 run doc 后创建 Codex 终端会话并返回 terminalId。

## 前端（Dashboard）
- [ ] 增加终端面板 UI：tab bar（切换/关闭）+ “新建终端”菜单。
- [ ] 接入 Bridge 多终端 API：创建终端、列出终端、关闭终端。
- [ ] 每个终端使用 xterm 渲染：输出流写入、输入透传、resize 同步。
- [ ] 原子任务“开始”改为启动 Codex 终端会话并自动切到该终端 tab。

## 自测
- [ ] `npm run build`（dashboard）通过。
- [ ] 手动验证：创建 PowerShell 终端输入 `echo hello` 有输出；创建 Claude 终端可进入交互；启动 Codex 终端可显示 TUI 且无明显错位。

