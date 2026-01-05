# MVP5 设计：智能任务编排系统

## 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Dashboard（前端）                              │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │ 依赖分析面板 │  │  DAG 可视化  │  │ 执行控制面板 │                 │
│  │ (AI Analysis)│  │ (React Flow)│  │ (Approval)  │                 │
│  └─────────────┘  └─────────────┘  └─────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ Socket.IO / REST
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Bridge（后端）                               │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │依赖分析引擎  │  │  DAG 构建器  │  │ 推荐方案生成 │                 │
│  │(Analyzer)   │  │ (DAGBuilder)│  │(Recommender)│                 │
│  └─────────────┘  └─────────────┘  └─────────────┘                 │
│  ┌─────────────┐  ┌─────────────┐                                  │
│  │ 跨平台适配器 │  │ 执行调度器   │                                  │
│  │(PathAdapter)│  │(Scheduler)  │                                  │
│  └─────────────┘  └─────────────┘                                  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      CLI 层（Codex / Claude Code）                    │
└─────────────────────────────────────────────────────────────────────┘
```

## 数据结构设计

### 1. 任务依赖图（TaskDependencyGraph）

```typescript
interface TaskDependencyGraph {
  specId: string;
  tasks: TaskNode[];
  edges: DependencyEdge[];
  parallelGroups: TaskGroup[];
  criticalPath: string[]; // 任务ID数组
}

interface TaskNode {
  id: string;
  title: string;
  description: string;
  cliType?: 'codex' | 'claude' | 'manual'; // 推荐的 CLI
  estimatedDuration?: number; // 预计耗时（秒）
  riskLevel: 'low' | 'medium' | 'high';
  requiresInteraction: boolean; // 是否需要人工干预
}

interface DependencyEdge {
  from: string; // 任务ID
  to: string;   // 任务ID
  type: 'file' | 'api' | 'data' | 'explicit' | 'conflict';
  description: string;
  strength: 'strong' | 'weak'; // 强依赖必须等待，弱依赖可尝试并行
}

interface TaskGroup {
  id: string;
  type: 'parallel' | 'serial';
  taskIds: string[];
  canRunSimultaneously: boolean;
  suggestedCli?: 'codex' | 'claude' | 'mixed';
}
```

### 2. 依赖分析结果（DependencyAnalysisResult）

```typescript
interface DependencyAnalysisResult {
  specId: string;
  analyzedAt: string;
  graph: TaskDependencyGraph;
  recommendations: ExecutionRecommendation[];
  warnings: string[];
  platformNotes?: PlatformNote;
}

interface ExecutionRecommendation {
  type: 'parallel' | 'serial' | 'hybrid';
  description: string;
  phases: ExecutionPhase[];
  estimatedTotalTime: number;
  cliAllocation: Record<string, 'codex' | 'claude'>; // taskId → cli
  rationale: string;
}

interface ExecutionPhase {
  phaseId: string;
  type: 'parallel' | 'serial';
  taskIds: string[];
  dependsOnPhases: string[];
}

interface PlatformNote {
  devPlatform: 'windows' | 'linux' | 'macos';
  targetPlatform: 'windows' | 'linux' | 'macos';
  pathMappings: Record<string, string>; // 源路径 → 目标路径
  compatibilityIssues: string[];
}
```

### 3. 执行状态（ExecutionState）

```typescript
interface ExecutionState {
  executionId: string;
  specId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused';
  currentPhase: number;
  tasks: Record<string, TaskExecutionStatus>;
  failures: TaskFailure[];
  startedAt: string;
  updatedAt: string;
}

interface TaskExecutionStatus {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  cli: 'codex' | 'claude' | 'manual';
  startedAt?: string;
  completedAt?: string;
  error?: string;
  retryCount: number;
}

interface TaskFailure {
  taskId: string;
  phaseId: string;
  error: string;
  canRetry: boolean;
  downstreamAffected: string[]; // 受影响的下游任务ID
}
```

## 依赖分析算法

### 分析流程

```
1. 解析原子任务 → 提取文件操作/API调用/数据操作
2. 构建依赖矩阵 → task[i][j] = dependency_type
3. 计算传递闭包 → 识别间接依赖
4. 检测循环依赖 → 报错并提示
5. 计算入度/出度 → 识别可并行任务
6. 生成 DAG 图 → 拓扑排序
7. 分组优化 → 合并可并行任务
8. CLI 分配 → 基于任务特性推荐
9. 风险评估 → 标记高风险任务
```

### 依赖检测规则

| 规则 | 检测逻辑 | 依赖类型 |
|------|----------|----------|
| 写后读 | 任务A写 `path`，任务B读 `path` | A → B (file) |
| 读写冲突 | 任务A、B都写 `path` | 冲突（需串行） |
| API链 | 任务A调 `POST /x`，任务B调 `GET /x` | A → B (api) |
| 数据库写后读 | 任务A `INSERT/UPDATE`，任务B `SELECT` | A → B (data) |
| 显式声明 | `after: [task1, task2]` | 强依赖 |
| 路径前缀 | 任务A写 `dir/`，任务B写 `dir/file` | 冲突检测 |

### 跨平台路径处理

```typescript
// Windows → Linux 路径转换
function normalizePath(path: string, targetPlatform: 'windows' | 'linux'): string {
  if (targetPlatform === 'linux') {
    return path
      .replace(/\\/g, '/')
      .replace(/^C:\//i, '/')
      .replace(/^([A-Z]):\//i, '/mnt/$1/');
  }
  // Linux → Windows
  return path
    .replace(/^\/mnt\/([a-z])\//i, '$1:\\')
    .replace(/^\//, 'C:\\')
    .replace(/\//g, '\\');
}
```

## Bridge API 设计

### REST API

#### 1. 依赖分析

```http
POST /api/analyze-dependencies
Content-Type: application/json

{
  "specId": "string",
  "atomicTasks": Array<AtomicTask>,
  "options": {
    "targetPlatform": "linux",
    "strictMode": false
  }
}

Response:
{
  "analysisId": "string",
  "graph": TaskDependencyGraph,
  "recommendations": ExecutionRecommendation[],
  "warnings": string[]
}
```

#### 2. 获取分析结果

```http
GET /api/analyze-dependencies/:analysisId

Response: DependencyAnalysisResult
```

#### 3. 创建执行计划

```http
POST /api/execution-plans
Content-Type: application/json

{
  "specId": "string",
  "analysisId": "string",
  "selectedRecommendation": number, // 推荐方案索引
  "modifications": {
    "taskCliOverrides": Record<string, 'codex' | 'claude'>,
    "excludedTasks": string[]
  }
}

Response:
{
  "executionPlanId": "string",
  "phases": ExecutionPhase[],
  "estimatedDuration": number
}
```

#### 4. 执行控制

```http
# 启动执行
POST /api/execution-plans/:planId/start

# 暂停执行
POST /api/execution-plans/:planId/pause

# 重启失败任务
POST /api/execution-plans/:planId/retry/:taskId

# 获取执行状态
GET /api/execution-plans/:planId/status
```

### WebSocket 事件

```typescript
// 服务端推送
socket.on('execution:phase_started', { phaseId, taskIds });
socket.on('execution:phase_completed', { phaseId, results });
socket.on('execution:task_started', { taskId, cli });
socket.on('execution:task_completed', { taskId, duration });
socket.on('execution:task_failed', { taskId, error, downstreamAffected });
socket.on('execution:completed', { executionId, summary });
```

## Dashboard UI 设计

### 1. 依赖分析面板

布局：
```
┌────────────────────────────────────────────────────────────────┐
│  [分析依赖]  [刷新]                                              │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  分析摘要：                                                      │
│  • 总任务数：12                                                  │
│  • 可并行组：4 组                                               │
│  • 串行任务：3 个                                               │
│  • 预计耗时：~8 分钟                                            │
│                                                                 │
│  ⚠️ 检测到 2 个路径冲突，1 个跨平台兼容性问题                    │
│                                                                 │
│  [查看详情]                                                     │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 2. DAG 可视化

使用 `reactflow` 库：
- 节点：任务卡片（标题、状态、CLI 标签）
- 边：依赖关系（实线=强依赖，虚线=弱依赖）
- 分组：可并行任务用虚线框标识
- 交互：点击节点查看详情、拖拽调整布局

### 3. 推荐方案面板

```
┌────────────────────────────────────────────────────────────────┐
│  AI 推荐方案                                                     │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  方案 A（推荐）：混合并行 + Codex 为主                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 预计耗时：6-8 分钟                                        │  │
│  │ 并行度：3 组并行                                           │  │
│  │ CLI 分配：8 个 Codex，4 个 Claude Code                    │  │
│  │                                                            │  │
│  │ 执行计划：                                                 │  │
│  │ Phase 1 (并行): Task1, Task2, Task3 → Codex               │  │
│  │ Phase 2 (并行): Task4, Task5 → Claude Code               │  │
│  │ Phase 3 (串行): Task6 → Codex                            │  │
│  │ ...                                                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  [采用此方案]  [自定义方案]                                      │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 4. 执行控制台

```
┌────────────────────────────────────────────────────────────────┐
│  执行状态                                                        │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Phase 1 (并行): Task1, Task2, Task3                             │
│  ├─ Task1 [████████████████████] 100% Codex ✓                  │
│  ├─ Task2 [████████████████░░░░] 80% Claude Code ⟳             │
│  └─ Task3 [████████████████████] 100% Codex ✓                  │
│                                                                 │
│  Phase 2 (等待中): Task4, Task5                                  │
│                                                                 │
│  [暂停执行]                                                     │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 5. 失败处理

```
┌────────────────────────────────────────────────────────────────┐
│  ⚠️ Task3 执行失败                                               │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  错误信息：                                                      │
│  Error: ENOENT: no such file or directory, open 'src/config.js' │
│                                                                 │
│  影响范围：                                                      │
│  • 直接下游：Task4, Task5（已暂停）                              │
│  • 间接影响：Task7（等待中）                                     │
│                                                                 │
│  [重启 Task3]  [跳过 Task3 继续执行]  [查看日志]                  │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

## 关键实现要点

### 1. 并行任务隔离
- 每个任务在独立的临时目录执行
- 输出通过隔离的文件描述符捕获
- 失败不影响其他并行任务的工作目录

### 2. 状态恢复
- 执行状态持久化到 `execution-state.jsonl`
- 重启时读取状态，跳过已完成任务
- 支持断点续传

### 3. CLI 适配
- Codex：生成 `runDoc`，交互模式启动
- Claude Code：直接调用 `claude --prompt`
- 两者统一输出格式捕获

### 4. 风险检测
- 循环依赖 → 拒绝执行
- 资源冲突 → 警告用户
- 路径跨平台 → 自动转换或警告
- 高风险操作（删除、覆盖）→ 二次确认

## 依赖库

### 前端
- `reactflow` - DAG 可视化
- `dagre` - 自动布局算法
- `@tanstack/react-query` - 状态管理

### 后端
- `toposort` - 拓扑排序
- `lodash.groupby` - 分组
- 现有 Socket.IO 基础设施
