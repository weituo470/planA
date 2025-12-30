# MVP2 需求（requirements）

## 背景
MVP2 目标是将 Kiro 的 Spec 驱动开发流程（requirements → design → tasks）复刻到浏览器端，并通过确认步骤控制顺序与可编辑性，提升人类在环的可视化与可控性。

## 用户故事
- 作为产品负责人，我希望在浏览器中创建 Spec 并按顺序填写三份文档，以便严格执行规范驱动流程。
- 作为开发者，我希望每一步都需要确认才能进入下一步，以减少需求遗漏与返工。
- 作为协作者，我希望看到每个 Spec 的文件存在与确认状态，以便快速判断当前进度。

## 验收标准（EARS）
- WHEN 用户在浏览器创建 Spec
  THE SYSTEM SHALL 仅生成 requirements.md 并锁定 design/tasks 的编辑入口。
- WHEN 用户确认 requirements 文档
  THE SYSTEM SHALL 解锁 design 文档并自动创建 design.md。
- WHEN 用户确认 design 文档
  THE SYSTEM SHALL 解锁 tasks 文档并自动创建 tasks.md。
- WHEN 用户尝试跳过顺序编辑或确认
  THE SYSTEM SHALL 拒绝操作并提示“请先确认上一步文档”。
- WHEN 文档被保存或确认
  THE SYSTEM SHALL 在日志区输出对应的 spec 事件记录。
