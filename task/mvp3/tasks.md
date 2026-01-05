# MVP3 任务（tasks）

## AI IDE 使用说明
- 本目录为 planA 工作流自身的开发任务文档。
- 实现过程中优先按本任务清单推进，必要时补充并保持与代码同步。

## 任务清单
- [ ] 1. Bridge：新增“启动 Codex 执行原子任务”API（解析 tasks_atomic、生成 run doc、启动 codex exec）。
- [ ] 2. Dashboard：解析 tasks_atomic.md 并结构化渲染原子任务卡片（含开始按钮）。
- [ ] 3. Dashboard：点击开始按钮调用 Bridge API，并提供运行可见性（轮询 /state 显示 status + logs）。
- [ ] 4. 验证：本地启动 bridge + dashboard，生成/加载 tasks_atomic 后可点击开始并看到 Codex 输出。

