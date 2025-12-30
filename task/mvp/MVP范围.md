# MVP 范围

## 包含功能
- Bridge 服务：Socket.io 事件流、node-pty CLI 接入、事件日志
- 任务流可视化：React Flow DAG
- 状态流转：Thinking / Executing / Reviewing
- 反馈通道：ApprovalRequest + Requirement Patch
- Diff 预览：文件变动实时推送
- 测试报告弹窗：PASS/FAIL + Submit/Retry

## 必须可演示的场景
1. CLI 输出日志实时推送到 Web
2. 修改文件触发 Diff 侧栏更新
3. Web 发起审批，状态进入 Reviewing，再回到 Thinking
4. Web 发送需求补丁并记录到事件流
5. DAG 节点拖拽后回写任务图
