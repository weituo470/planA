# OpenSpec 规范驱动开发启动要点

## 核心定位
- OpenSpec 不是流程引擎，而是“带依赖感知的工件（artifact）跟踪器”。
- 以文件系统为数据库，工件是否完成由文件是否存在判断，天然可审计、可版本控制。
- 依赖是“可创建的前置条件”，不是强制关卡，强调可行性提示而非强制流程。

## 目录与变更模型
- 事实规范（source of truth）：`openspec/specs/`
- 变更提案与任务：`openspec/changes/<change-name>/`
  - `proposal.md`：需求与变更动机
  - `specs/`：规范增量（delta）
  - `design.md`：设计决策（可选）
  - `tasks.md`：任务拆解
- 归档：`openspec/changes/archive/`（完成后合并回 specs）

## 规范驱动流程（默认）
1. Draft Change Proposal
2. Review & Align（在 proposal/specs/tasks 上循环）
3. Implement Tasks
4. Archive & Update Specs

## 工件与依赖图（Artifact Graph）
- 默认 spec-driven schema：
  - proposal → specs → design → tasks
- 工件存在即可视为完成，支持 glob（如 `specs/*.md`）。

## Schema 与模板机制
- Schema 定义：`schemas/<schema>/schema.yaml`
- 模板定义：`schemas/<schema>/templates/<artifact>.md`
- XDG 两级覆盖：
  1. `${XDG_DATA_HOME}/openspec/schemas/<schema>/...`（用户覆盖）
  2. `<package>/schemas/<schema>/...`（内置默认）
- 不做多层级继承，路径可预期。

## CLI 与 AI 协作原则
- CLI 必须显式指定 `--change`，保持确定性（Deterministic CLI）。
- AI 负责推断与确认变更上下文（Inferring Agent）。
- 常用命令：
  - `openspec init` / `openspec list` / `openspec show <change>`
  - `openspec validate <change>` / `openspec archive <change>`

## Delta 规范要点
- 使用 `## ADDED / MODIFIED / REMOVED Requirements` 分区
- Requirement 必须包含 `#### Scenario` 场景
- 规范语气使用 SHALL / MUST

## 对我们的启发
- 将“工件状态”视为系统最小真相：由文件存在+内容变更驱动 UI 状态。
- DAG 可视化对应 schema 中 artifacts 的依赖关系。
- Approval/Reviewing 可以对齐 OpenSpec 的 “Review & Align” 阶段。
- 通过 change 目录隔离变更，适合多任务并行与回溯审计。
