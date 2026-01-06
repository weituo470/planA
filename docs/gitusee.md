

要在 ACTION（你的 CLI 任务编排工具）中落地 Git 集成，核心目标只有两个：
1.  **隔离风险**：AI 写的代码不能弄脏用户当前的工作区。
2.  **版本原子性**：一个任务要么全成功提交，要么全失败回滚。

以下是剥离了所有修辞的**技术实现方案**：

### 1. 核心工作流设计 (The Workflow)

不要让 AI 决定 Git 策略，**代码逻辑（Hardcode）写死 Git 策略**。
任何一个 CLI 任务启动时，强制执行以下标准流程：

*   **Step 1: 环境脏检查 (Dirty Check)**
    *   执行 `git status --porcelain`。
    *   **逻辑**：如果用户当前工作区有未提交的修改，**立即报错并终止**。
    *   *原因*：防止 AI 的修改和用户未保存的修改混在一起，导致无法回滚。

*   **Step 2: 强制切分支 (Checkout Sandbox)**
    *   根据 Task ID 生成唯一分支名：`action/task-<timestamp>-<short_id>`。
    *   执行 `git checkout -b action/task-xxx`。
    *   *原因*：物理隔离。无论 AI 把代码改得多烂，删分支就行，主分支毫发无损。

*   **Step 3: 任务执行 (Execution)**
    *   调用 CLI 工具（如 Claude Code）在这个分支上修改代码。

*   **Step 4: 变更捕获 (Diff Capture)**
    *   任务结束后，执行 `git diff --name-only`。
    *   **逻辑**：如果没有文件变动，视为任务失败或无操作，删除分支并提示。

*   **Step 5: 自动化提交 (Auto Commit)**
    *   执行 `git add .`。
    *   执行 `git commit -m \"Action: <Task Description>\"`。
    *   *注意*：这里不需要 AI 写 Commit Message，直接用任务描述即可，保持 Traceability（可追溯性）。

### 2. 交互层落地 (UI Implementation)

在你的网页端（Action Dashboard），Git 不是一个“功能”，而是**状态指示器**。

*   **状态 A：Pending (等待中)**
    *   Git 无操作。
*   **状态 B：Running (运行中)**
    *   前端显示：`Current Branch: action/task-101`。
    *   此时网页端应**锁定**，禁止用户开启新任务，除非支持多目录并发。
*   **状态 C：Review (待确认)**
    *   任务执行完，Action 不要自动合并回 `main`。
    *   **关键点**：在网页上展示 `git diff` 的结果（或者 GitHub PR 的链接）。
    *   提供两个按钮：
        1.  **[Accept / Merge]** -> 后台执行 `git checkout main && git merge action/task-101 && git branch -d action/task-101`。
        2.  **[Reject / Discard]** -> 后台执行 `git checkout main && git branch -D action/task-101`。

### 3. 并发场景下的冲突处理 (Technical Fallback)

你提到之前的需求是“并发执行”。在 Git 层面，并发是最大的难点。

**落地建议：**
初期 MVP 阶段，**放弃 Git 层面的并发**，或者采用**目录级隔离**。

**方案 A：目录锁（推荐）**
*   如果 Task A 改 `/frontend`，Task B 改 `/backend`。
*   两个任务分别开分支：`feat/frontend` 和 `feat/backend`。
*   合并时：通常不会冲突。

**方案 B：冲突硬着陆**
*   如果合并时 `git merge` 返回非 0 状态（即发生冲突）。
*   **系统行为**：不要尝试让 AI 修复冲突（成功率极低且危险）。
*   **落地行为**：系统直接**挂起**，在网页提示：“Task A 与 Task B 产生文件冲突，请前往 IDE 手动解决。”
*   这是最安全、最负责任的做法。

### 4. 总结：系统开发指令

如果要让你的开发工具去实现这个功能，请给它这段具体的 Spec：

> **Git Integration Spec:**
> 1.  **Pre-flight**: Before any LLM execution, run `git status`. If dirty, throw error \"Please commit or stash changes first\".
> 2.  **Branching**: Always create a new branch `ai-feat/<id>` from current HEAD.
> 3.  **Post-flight**: After execution, run `git status`. If clean (no changes), delete branch and report \"No changes made\".
> 4.  **Commit**: If changes exist, `git add .` and `git commit -m \"<Task Title>\"`.
> 5.  **Merge Strategy**: Never auto-merge to main. Leave the branch for user review. Provide a UI command to merge or discard.

这是最稳健、最符合工程伦理的落地方式。
