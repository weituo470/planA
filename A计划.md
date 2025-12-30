# A计划（Project Plan A）阶段性总结

## 1. 项目愿景（Vision）
A计划旨在构建一个基于 CODEX CLI 的、超越传统规范驱动开发（如 Kiro）的下一代 AI 自动化开发编排系统。通过引入浏览器实时监控、多 Agent 协同、MCP 协议以及自主调试机制，将开发者从“编码者”提升为“首席指挥官（Commander）”，实现高透明、低介入、可观测的无人值守开发模式。

## 2. 核心亮点（Core Highlights）

### 2.1 浏览器实时指挥塔（Mission Control）
- 可视化任务拓扑图（DAG）：将需求自动拆解为有向无环图，实时展示任务状态（Pending、Thinking、Executing、Success、Failed）。
- 交互式对话窗口：允许在浏览器端直接打断 Agent、修正需求或提供实时反馈。
- 实时状态流：每一行日志、每一个思考步骤、每一次代码 Diff 都会实时推送到前端，消除“黑盒”恐惧。

### 2.2 多 Agent 协同与并行（Multi-Agent Swarm）
- 并行开发：支持主 Agent（CODEX）负责核心架构，子 Agent（如搭载 GLM-4.7 的 Claude-Code）负责文档、测试和样式，实现任务并行化。
- MCP 协议集成：整体架构作为 MCP Server 交付，使「A计划」成为一种标准化的“开发元能力”，可被 Cursor、Claude Desktop 等工具调用。

### 2.3 智能工程化管理
- Git-Ops 自动化：自动创建分支、原子化提交（Commit）以及冲突处理，确保开发过程具备完整的版本溯源。
- 检查点（Checkpoint）机制：在关键架构变动或风险操作前强制停顿，由人类程序员进行安全性与逻辑性的“一键确权”。
- 浏览器原生调试：集成 Chrome DevTools 能力，Agent 可自主开启浏览器进行 UI 验证、捕获 Console 报错并自动修复。

### 2.4 自愈与稳定性
- 自动重试机制：失败任务自动触发多轮不同策略的重试（如换思路、换库实现）。
- 死循环检测：实时监控 Diff 熵值，防止 Agent 在同一个错误逻辑上无限徘徊，必要时请求人类介入。

## 3. 技术架构（Technical Architecture）
| 层次 | 组件 | 职责 |
| --- | --- | --- |
| 表现层 | React + Tailwind + React Flow | 任务可视化、Diff 预览、交互控制台 |
| 调度层 | Node.js / Python（MCP Server） | 任务拆解、多 Agent 路由、上下文同步 |
| 执行层 | CODEX CLI / Claude-Code（GLM） | 代码生成、Shell 执行、文件读写 |
| 观测层 | Puppeteer / Chrome CDP | 浏览器环境模拟、前端自动化调试 |
| 存储层 | Local Git / Shared Context | 版本控制、Agent 间共享记忆 |

## 4. 交付阶段（Milestones）

### 第一阶段：透明化（MVP）
- 实现 CODEX CLI 实时日志推送到 Web 端。
- 实现基础的 Spec → Task List 渲染。

### 第二阶段：工程化增强
- 接入自动 Git 管理与分支策略。
- 实现基于风险分级的“人类检查点”机制。
- 加入方案切换重试机制。

### 第三阶段：多 Agent 与 MCP
- 支持通过 MCP 协议调用多模型并行作业。
- 集成浏览器调试工具（DevTools Integration）。

### 第四阶段：完全体（The Dev Cockpit）
- 实现高度自动化、无人值守的闭环开发模式。
- 作为标准的 MCP 插件适配所有主流 IDE。

## 5. 用户故事（User Story）
开发者输入一个需求，“A计划”自动在浏览器生成一张包含 10 个任务的拓扑图。两个 Agent 同时开工：一个在改后端 API，另一个在调前端 CSS。开发者坐在屏幕前，看着代码 Diff 像瀑布一样流过，只在 Agent 请求架构确认时点一下“Approve”。半小时后，一个经过完整 Git 提交和浏览器自动化测试的功能完美交付。

## 项目备注
- A计划不只是工具，它是 AI 时代的本地开发操作系统。
