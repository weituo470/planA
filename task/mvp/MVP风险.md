# MVP 风险

## 风险点
- node-pty 在 Windows 上的稳定性
- 文件监听对大文件的性能影响
- DAG 重排频繁更新导致事件风暴

## 缓解措施
- 提供 pty 关闭开关与降级为手动事件推送
- Diff 限流与截断（已实现）
- 对 task:replace 做节流
