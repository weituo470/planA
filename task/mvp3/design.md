# MVP3 设计（design）

## 架构概览
- Dashboard（前端）：解析 `tasks_atomic.md` → 结构化渲染 → 点击“开始”调用 Bridge API → 轮询 Bridge `/state` 展示状态与日志。
- Bridge（后端）：接收“启动某条原子任务”请求 → 从磁盘读取/解析 `tasks_atomic.md` → 生成任务执行文档 → 通过 `node-pty` 启动 `codex exec`。

## 关键数据与目录
- Spec 根目录：`workflow/specs/<specName>/`
  - `requirements.md`
  - `design.md`
  - `tasks.md`
  - `tasks_atomic.md`
- 任务执行文档目录（新增）：`.runlogs/codex-runs/<specName>/`
  - `task-<taskId>-<timestamp>.md`（每次点击开始生成一个文件）
  - 可选：`last-message-<taskId>-<timestamp>.md`（Codex 输出摘要落盘）

## API 设计
### 1) 启动 Codex 执行某条原子任务
- `POST /specs/:name/tasks_atomic/codex`
- Body：
  - `taskId`：字符串，例如 `1.2`
  - `model`（可选）：传给 `codex -m <model>`；默认不传，使用用户本地 codex 配置
  - `sandbox`（可选）：`read-only|workspace-write|danger-full-access`；默认 `workspace-write`
- Response：
  - `pid`：pty pid
  - `runDocPath`：本次任务执行文档路径（相对 ROOT）
  - `lastMessagePath`：本次 Codex last message 输出路径（相对 ROOT）

### 2) 运行状态与日志（已存在）
- `GET /state`
  - `status`：`Thinking|Executing|Reviewing`
  - `logs[]`：最近日志（含 pty 输出）

## 执行命令形态
- 使用非交互方式：`codex exec`。
- Bridge 通过 `node-pty` 启动：
  - `codex -a never -s <sandbox> -C <repoRoot> exec --output-last-message <file> "<prompt>"`
- prompt 只引用本次 `runDocPath`，避免在命令行参数里塞入多行大文本：
  - `请按任务文档 <runDocPath> 实现该任务，完成后自检并输出简要总结。`

## 安全与约束
- Bridge 只允许启动固定命令 `codex`（不可由前端传入任意 command），避免命令注入。
- `specName` 与 `taskId` 需校验/清洗。
- 默认 `sandbox=workspace-write`，降低对工作区外的风险。
