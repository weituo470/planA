# MVP5 任务清单

## 阶段一：依赖分析引擎（Bridge 后端）

### 1.1 核心分析器
- [ ] 实现 `DependencyAnalyzer` 类：解析原子任务提取操作
- [ ] 文件操作检测：读取/写入/删除文件（正则匹配）
- [ ] API 调用检测：fetch/axios/http 请求模式
- [ ] 数据库操作检测：SQL 语句、ORM 调用
- [ ] 显式依赖解析：`after`/`dependsOn` 字段

### 1.2 依赖图构建
- [ ] 实现 `DAGBuilder` 类：构建任务依赖图
- [ ] 依赖矩阵计算：task[i][j] 依赖关系
- [ ] 传递闭包计算：识别间接依赖
- [ ] 循环依赖检测：报错并定位问题
- [ ] 入度/出度计算：用于拓扑排序

### 1.3 分组与优化
- [ ] 可并行任务分组：无依赖关系的任务合并
- [ ] 关键路径识别：耗时最长的依赖链
- [ ] 资源冲突检测：同时写入同一路径

### 1.4 跨平台适配
- [ ] 实现 `PathAdapter` 类：路径规范化
- [ ] Windows ↔ Linux 路径转换
- [ ] 环境变量格式转换：`%VAR%` ↔ `$VAR`
- [ ] 兼容性警告生成

## 阶段二：推荐方案生成（Bridge 后端）

### 2.1 推荐引擎
- [ ] 实现 `Recommender` 类：生成执行方案
- [ ] 并行度评估：基于依赖图计算最大并行
- [ ] CLI 分配建议：任务特性匹配 CLI 能力
- [ ] 耗时估算：基于任务复杂度/历史数据

### 2.2 方案生成
- [ ] 多方案生成：推荐 2-3 种可选策略
- [ ] 风险评估：标记高风险任务
- [ ] 方案解释：生成推荐理由

## 阶段三：API 层（Bridge 后端）

### 3.1 REST API
- [ ] `POST /api/analyze-dependencies` - 触发分析
- [ ] `GET /api/analyze-dependencies/:id` - 获取结果
- [ ] `POST /api/execution-plans` - 创建执行计划
- [ ] `POST /api/execution-plans/:id/start` - 启动执行
- [ ] `POST /api/execution-plans/:id/pause` - 暂停执行
- [ ] `POST /api/execution-plans/:id/retry/:taskId` - 重启任务
- [ ] `GET /api/execution-plans/:id/status` - 获取状态

### 3.2 WebSocket 事件
- [ ] `execution:phase_started` - 阶段开始
- [ ] `execution:phase_completed` - 阶段完成
- [ ] `execution:task_started` - 任务开始
- [ ] `execution:task_completed` - 任务完成
- [ ] `execution:task_failed` - 任务失败
- [ ] `execution:completed` - 执行完成

## 阶段四：前端可视化（Dashboard）

### 4.1 依赖分析面板
- [ ] 分析触发按钮
- [ ] 分析摘要展示（任务数、并行组、预计耗时）
- [ ] 警告信息显示

### 4.2 DAG 可视化
- [ ] 集成 `reactflow` 库
- [ ] 节点渲染：任务卡片（标题、状态、CLI 标签）
- [ ] 边渲染：依赖关系（实线/虚线）
- [ ] 分组框：可并行任务标识
- [ ] 自动布局：`dagre` 算法
- [ ] 交互：点击查看详情、拖拽调整

### 4.3 推荐方案面板
- [ ] 方案列表展示
- [ ] 方案详情（阶段划分、CLI 分配、预计耗时）
- [ ] 采用方案按钮
- [ ] 自定义方案编辑器

### 4.4 执行控制台
- [ ] 阶段进度展示
- [ ] 任务状态实时更新
- [ ] 暂停/恢复控制

### 4.5 失败处理
- [ ] 失败任务详情展示
- [ ] 重启按钮
- [ ] 跳过继续选项
- [ ] 影响范围可视化

## 阶段五：执行调度器（Bridge 后端）

### 5.1 调度核心
- [ ] 实现 `Scheduler` 类：管理任务执行
- [ ] 阶段推进逻辑：完成当前阶段后启动下一阶段
- [ ] 并行任务管理：多任务同时执行

### 5.2 状态管理
- [ ] 执行状态持久化（`execution-state.jsonl`）
- [ ] 断点续传支持
- [ ] 失败恢复逻辑

### 5.3 CLI 集成
- [ ] Codex 集成：生成 runDoc + 交互模式
- [ ] Claude Code 集成：直接调用
- [ ] 输出统一捕获

## 自测验收

- [ ] AC1：分析依赖后展示 DAG，正确标识并行组
- [ ] AC2：推荐方案包含 CLI 分配和预计时间
- [ ] AC3：支持修改方案后执行
- [ ] AC4：任务失败显示错误，重启不影响已完成任务
- [ ] AC5：跨平台路径处理正确
- [ ] AC6：`npm run build` 通过（dashboard）
- [ ] AC7：Bridge 服务正常，API 可访问
