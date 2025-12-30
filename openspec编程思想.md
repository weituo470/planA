# OpenSpec 编程思想（规范驱动开发 / Spec-Driven Development）

> 基于仓库 `openspec/` 目录中的 OpenSpec 文档与规范（如 `openspec/README.md`、`openspec/openspec/specs/openspec-conventions/spec.md`、`openspec/schemas/*/schema.yaml` 等）整理。

## 1. 一句话
OpenSpec 的核心是：**先把“要做什么/为什么”固化为可解析的规范与变更增量，再让 AI/人按任务清单实现代码，并用验证与归档把“已部署的现实”同步回规范**。

它解决的痛点是：需求只存在聊天记录里时，AI 输出不可控、不可审计；OpenSpec 用轻量文件结构把“意图”锁定在仓库中，使实现变得更确定、可 review。

## 2. 核心目标与价值
- **对齐（Alignment）**：人和 AI 先在“规范/提案”层面达成一致，再写代码。
- **确定性（Determinism）**：同一组规格文件是可复用的输入，减少“聊天上下文漂移”。
- **可审计（Auditability）**：每个改动是一个目录（proposal/tasks/spec-deltas），可 diff、可回溯。
- **适配存量项目（Brownfield-first）**：修改既有行为时，明确区分“当前真相”和“提议变更”。

## 3. 两层真相模型：`specs/` 与 `changes/`
OpenSpec 把“系统的真实状态”和“计划中的改变”分离：

- `openspec/specs/`：**当前已构建/已部署（IS）的能力说明**，是长期维护的“活文档”。
- `openspec/changes/<change-name>/`：**一次变更（SHOULD）的完整上下文**：为什么改、要改什么、怎么改、做哪些任务、以及对规格的增量（delta）。

这种分离带来两个直接好处：
1) 你可以在不污染当前真相的情况下，讨论/迭代未来状态；
2) 变更被归档（archive）后，增量会被合并回 `specs/`，让规范始终贴近已部署代码。

### 目录结构（概念）
- `openspec/project.md`：项目级约束/习惯/架构上下文（供 AI 与人统一口径）。
- `openspec/AGENTS.md`：对 AI 工具的“交接说明”，把流程与模板前置。
- `openspec/specs/<capability>/spec.md`：单一能力的规格（WHAT/WHY）。
- `openspec/changes/<change-name>/`：本次改动的提案、任务、设计与规格增量。
- `openspec/archive/`：已完成变更的归档快照。

## 4. 规格写法：可解析的“需求 + 场景”
OpenSpec 不是随意写文档，而是把规格约束成稳定结构，便于人读、也便于工具与 AI 稳定生成/验证。

### 4.1 基本结构
- **需求（Requirement）**：用三级标题作为唯一标识：`### Requirement: <Name>`
- **场景（Scenario）**：每个需求至少一个四级标题：`#### Scenario: <Desc>`
- **步骤关键字**：用加粗关键字描述行为流（类似 BDD）：
  - **GIVEN**（可选，初始状态）
  - **WHEN**（触发条件）
  - **THEN**（期望结果）
  - **AND**（补充条件/结果）
- **规范动词**：在需求正文中倾向使用 SHALL/MUST 等可验证措辞。

### 4.2 “标题即 ID” 的设计思想
OpenSpec 约定 `### Requirement: ...` 的标题本身就是**可程序匹配的唯一标识**。
- 工具在归档/合并 delta 时，会用规范化后的标题做精确匹配。
- 因此要求同一份 spec 内需求标题唯一；重命名需显式声明。

### 4.3 重命名的显式化
当需求名变更时，不靠“猜”，而用专门章节标注（示意）：

```markdown
## RENAMED Requirements
- FROM: `### Requirement: Old Name`
- TO: `### Requirement: New Name`
```

这体现了 OpenSpec 的一贯取向：**减少隐式语义，增加可被机器校验的显式约束**。

## 5. 变更表达：用 Delta 而不是直接改动“当前真相”
OpenSpec 的变更规格不是在 `specs/` 里直接改，而是在 change 目录里写“补丁式”的 delta：

- `## ADDED Requirements`：新增能力
- `## MODIFIED Requirements`：修改后的完整新文本（不做行内 diff）
- `## REMOVED Requirements`：移除能力
- `## RENAMED Requirements`：需求重命名（先处理 rename，再处理 remove/modify/add）

其关键思想是：
- **变更只存差异，不存未来全量**（让 review 聚焦在变化点）。
- **不用行内 diff 语法**，而用明确分区 + “完整替换文本”来减少歧义。

## 6. 变更的四类产物：Proposal / Specs / Design / Tasks
OpenSpec 把一次变更拆成几类“产物”，并用模板约束它们的最小结构：

- `proposal.md`：为什么要改、改什么、影响面（意图对齐）。
- `specs/*.md`（delta）：“行为应如何变化”的结构化规格（可验证）。
- `design.md`（可选）：技术决策与取舍（HOW）。
- `tasks.md`：按清单拆解到可执行的实现步骤（落地路径）。

这一拆分把讨论从“直接写代码”拉回到更稳定的中间层：
- Proposal 锁定动机与范围
- Specs 锁定行为与边界
- Design 解释实现策略
- Tasks 驱动执行与验收

## 7. 用“产物依赖图（Artifact Graph）”驱动流程
OpenSpec 用 schema（YAML）定义一个工作流里有哪些产物、产物输出路径、以及依赖关系。例如：

- `spec-driven`：`proposal → (specs, design) → tasks`
- `tdd`：`spec → tests → implementation → docs`

工具可以据此：
- 计算产物的**构建顺序**（拓扑排序）；
- 扫描文件系统判断哪些产物已完成；
- 告知“下一步该生成哪些文件”、哪些被依赖阻塞；

这背后的思想是：**把开发流程从“人的记忆/对话”变成“可执行的状态机”**。

## 8. 校验与归档：让规范持续贴近代码
OpenSpec 明确区分两个重要动作：

- **Validate（验证）**：检查规范格式与结构是否满足约束（如需求/场景结构、标题唯一性、delta 分区等）。
- **Archive（归档）**：在变更完成后，把 change 里的 delta 按规则合并回 `openspec/specs/`，并把该 change 移入 `archive/`。

归档合并强调顺序与可验证性：
1) 先处理 RENAMED
2) 再处理 REMOVED
3) 再处理 MODIFIED
4) 最后处理 ADDED
并对“要改/要删的需求是否存在”“要加的需求是否已存在”等进行冲突检测。

这使得“规范不是一次性文档”，而是**随着每次变更归档而演化的系统说明书**。

## 9. 面向 AI 编程的协作原则（把 AI 变成可控的执行者）
OpenSpec 不把 AI 当“神奇的代码生成器”，而把它纳入一个可控管道：

1) **先规格、后实现**：先产出 proposal/spec/tasks，经过人审与迭代对齐。
2) **用文件结构替代聊天上下文**：需求与边界落在仓库，避免上下文漂移。
3) **以任务清单约束行动**：AI 按 tasks 实施，减少随意扩展范围。
4) **以规范作为验收基准**：实现完成后回到 specs 检查行为是否吻合。
5) **用工具做格式/一致性守门**：validate + archive 把流程固定下来。

## 10. 可直接复用的写作清单（Checklist）
在一个 change 完成“可实现、可审查”的状态前，至少满足：
- `proposal.md` 能用一句话回答：为什么做、做什么、不做什么、影响谁。
- 每条 `### Requirement:` 都有明确、可验证的 SHALL/MUST 描述。
- 每条需求至少一个 `#### Scenario:`，并用 WHEN/THEN/AND 描述行为。
- delta 仅包含 ADDED/MODIFIED/REMOVED/RENAMED（按约定分区）。
- `tasks.md` 能拆到“谁来做都能按步骤执行并验收”。

## 11. 你可以如何把这种思想迁移到自己的项目
即使不使用 OpenSpec CLI，也可以直接借鉴其思想：
- 用“当前规格（IS）+ 变更增量（SHOULD）”替代“直接改文档/直接改代码”。
- 用稳定的结构化语法（Requirement/Scenario）表达行为，避免含糊描述。
- 用“标题即 ID”来实现可自动化的合并、校验与追踪。
- 把开发流程拆成可审查的中间产物（proposal/spec/design/tasks），让 AI/人协作更稳定。

---

附：OpenSpec 常用命令（来自项目文档）

```bash
openspec list
openspec view
openspec show <change>
openspec validate <change>
openspec archive <change> [--yes|-y]
```
