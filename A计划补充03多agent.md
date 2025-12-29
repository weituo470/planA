# A计划补充03（Project Plan A）Subagents 机制实现规划书

## 1. 核心理念（Philosophy）
在 A计划 中，Subagents 不仅仅是简单的递归调用，而是一套高度自治、可并行、跨模型的“任务执行单元集群”。主 Agent（指挥官）负责架构决策与任务拆解，Subagents（工人）负责具体任务的落地。

## 2. 架构设计（Architecture）

### 2.1 调度层：Bridge Dispatcher
- 职责：监听主 Agent 发出的 spawn_worker 指令，负责初始化子进程环境、切割上下文并分发任务。
- 实现：基于 node-pty 创建独立的伪终端实例，支持并行运行多个 Subagents。

### 2.2 执行层：Worker Cluster
- 模型混合方案：
  - 主控（Commander）：使用 OpenAI Codex / o1（处理深度逻辑）。
  - 工人（Workers）：根据任务性质动态调用 GLM-4.7（快速、低成本）、Claude-3-Haiku（文档/样式）或 o1-mini（复杂算法）。
- 沙箱环境：每个 Subagent 运行在受限的本地目录空间内。

## 3. 核心工具协议：spawn_worker
- 主 Agent 通过调用此 MCP 工具启动子智能体：

```json
{
  "name": "spawn_worker",
  "description": "派生一个子智能体并行处理特定子任务",
  "parameters": {
    "worker_id": "string (e.g., frontend_fix_01)",
    "model": "string (glm4.7 | claude-haiku | gpt-4o-mini)",
    "task_goal": "string (详细的任务描述)",
    "context_files": ["string (需要读取的文件列表)"],
    "priority": "number (1-5)"
  }
}
```

## 4. 关键流程（Key Workflow）

### 4.1 上下文切割（Context Slicing）
为了解决 Token 上限问题，Bridge 仅为 Subagent 准备以下信息：
- 局部代码：仅限 context_files 中定义的文件。
- 任务约束：design.md 中相关的片段。
- 思维快照：主 Agent 传递的“意图片段”。

### 4.2 状态追踪与可视化（Browser UI）
- 树状视图：浏览器仪表盘实时渲染任务树，主节点分裂出子节点。
- 实时心跳：每一个 Subagent 的实时 Log 流（stdout）以抽屉窗形式展示在任务节点旁。

### 4.3 结果聚合（Result Aggregator）
- Handoff 文件：Subagent 完成后生成 .plan-a/handoff/[worker_id].json。
- 冲突检测：如果多个 Subagent 修改了同一个文件，由 Bridge 触发 Git 冲突解决流程，或交给“观察者（Observer）”进行仲裁。

## 5. 进化增强：Observer 角色介入
「A计划」特有的自我进化能力在此处的体现：
- 效率评估：观察者监控 Subagent 的重试次数。如果某个模型在特定任务（如写单元测试）中表现不佳，观察者会自动在《迭代建议》中建议下次更换模型。
- 死循环终止：观察者拥有“杀进程”权限。一旦判定 Subagent 陷入逻辑死循环，立即强制终止并向主 Agent 报错。

## 6. 与 Claude Code 的差异化优势
| 特性 | Claude Code Subagents | A计划 Subagents |
| --- | --- | --- |
| 运行模式 | 串行/阻塞式为主 | 真正的本地多进程并行 |
| 模型支持 | 仅限 Claude 系列 | 跨模型自由配比（Codex + GLM + Claude） |
| 可观测性 | 终端命令行输出 | 浏览器可视化任务拓扑图 + 实时 Log 流 |
| 长效记忆 | 会话结束即消失 | 错题本持久化 + 自动更新至项目文档 |

## 7. 实施路线图（Milestones）
- Phase 1 (MVP)：实现 spawn_worker 工具，支持在本地开启第二个 node-pty 窗口执行简单任务。
- Phase 2 (Parallel UI)：在浏览器端实现多路 Agent 状态的同时展示。
- Phase 3 (Smart Routing)：实现基于任务复杂度的“自动模型选择”逻辑。
- Phase 4 (Conflict Guard)：完善多 Subagent 协作时的 Git 分支自动合并机制。

## 项目备注
- A计划 指挥部：“将大型任务拆解为精密的并行行动，是实现无人值守开发的必经之路。”
