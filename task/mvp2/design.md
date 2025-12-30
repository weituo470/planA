# MVP2 设计（design）

## 技术架构
- Bridge（Node/Express）：
  - 文件系统持久化：`workflow/specs/<spec>/` 存放三个文档与 `status.json`。
  - API：`/specs` 列表与创建、`/specs/:name/:artifact` 读取/保存、`/specs/:name/confirm` 顺序确认。
- Dashboard（Vite + React）：
  - Spec 面板展示文件存在状态与确认状态。
  - 顺序锁定逻辑：requirements 可编辑；design/tasks 需前置确认。
  - 确认按钮触发 `/confirm` 并自动切换到下一阶段。

## 序列流程
1) 新建 Spec → Bridge 创建 `requirements.md` + `status.json`。
2) 用户编辑并保存 requirements → 日志记录保存事件。
3) 用户确认 requirements → Bridge 写入确认状态并创建 `design.md`。
4) 用户编辑并确认 design → Bridge 创建 `tasks.md`。
5) tasks 确认后标记完成；后续可扩展自动生成执行任务。

## 实现考虑
- 状态一致性：以 `status.json` 为真值来源，前端只读不推断。
- 顺序锁定：前端禁用按钮 + 后端校验双重保证。
- 错误提示：禁用与提示同时存在，防止“无响应”的误解。
- 扩展性：后续可在确认后触发自动任务拆解与 DAG 生成。
