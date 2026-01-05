/**
 * dag-builder.service.js
 * DAG（有向无环图）构建器
 * 基于依赖分析结果构建任务拓扑图，识别并行组、关键路径
 */

/**
 * 构建邻接表
 * @param {Array} tasks - 任务数组
 * @param {Array} dependencies - 依赖数组
 * @returns {Object} - 邻接表 { taskId: { in: [], out: [] } }
 */
function buildAdjacencyList(tasks, dependencies) {
  const adjacency = {};

  // 初始化所有任务
  tasks.forEach(task => {
    adjacency[task.id] = { in: [], out: [] };
  });

  // 填充边
  dependencies.forEach(dep => {
    if (adjacency[dep.from] && adjacency[dep.to]) {
      adjacency[dep.from].out.push({ to: dep.to, type: dep.type, strength: dep.strength });
      adjacency[dep.to].in.push({ from: dep.from, type: dep.type, strength: dep.strength });
    }
  });

  return adjacency;
}

/**
 * 拓扑排序（Kahn 算法）
 * @param {Array} tasks - 任务数组
 * @param {Object} adjacency - 邻接表
 * @returns {Object} - { sorted: 任务ID数组, hasCycle: 是否有循环 }
 */
function topologicalSort(tasks, adjacency) {
  const inDegree = {};
  const queue = [];
  const sorted = [];

  // 初始化入度
  tasks.forEach(task => {
    inDegree[task.id] = adjacency[task.id]?.in.length || 0;
    if (inDegree[task.id] === 0) {
      queue.push(task.id);
    }
  });

  // Kahn 算法
  while (queue.length > 0) {
    const current = queue.shift();
    sorted.push(current);

    // 减少邻居的入度
    if (adjacency[current]) {
      adjacency[current].out.forEach(edge => {
        inDegree[edge.to]--;
        if (inDegree[edge.to] === 0) {
          queue.push(edge.to);
        }
      });
    }
  }

  // 检查是否有循环
  const hasCycle = sorted.length !== tasks.length;

  return { sorted, hasCycle };
}

/**
 * 检测循环依赖
 * @param {Array} tasks - 任务数组
 * @param {Object} adjacency - 邻接表
 * @returns {Object} - { hasCycle: boolean, cycles: 循环数组 }
 */
function detectCycles(tasks, adjacency) {
  const WHITE = 0; // 未访问
  const GRAY = 1;  // 访问中
  const BLACK = 2; // 已访问

  const color = {};
  const cycles = [];

  tasks.forEach(task => {
    color[task.id] = WHITE;
  });

  function dfs(nodeId, path = []) {
    color[nodeId] = GRAY;
    path.push(nodeId);

    if (adjacency[nodeId]) {
      for (const edge of adjacency[nodeId].out) {
        if (color[edge.to] === GRAY) {
          // 找到循环
          const cycleStart = path.indexOf(edge.to);
          const cycle = path.slice(cycleStart).concat(edge.to);
          cycles.push(cycle.join(' -> '));
        } else if (color[edge.to] === WHITE) {
          dfs(edge.to, [...path]);
        }
      }
    }

    color[nodeId] = BLACK;
  }

  tasks.forEach(task => {
    if (color[task.id] === WHITE) {
      dfs(task.id);
    }
  });

  return {
    hasCycle: cycles.length > 0,
    cycles,
  };
}

/**
 * 计算任务的层级（从入口任务开始）
 * @param {Array} tasks - 任务数组
 * @param {Object} adjacency - 邻接表
 * @returns {Object} - 层级映射 { taskId: level }
 */
function calculateLevels(tasks, adjacency) {
  const levels = {};

  // 初始化：无入度的任务层级为0
  tasks.forEach(task => {
    const hasIncoming = adjacency[task.id]?.in.length > 0;
    levels[task.id] = hasIncoming ? -1 : 0;
  });

  // 动态规划计算层级
  let changed = true;
  let iterations = 0;
  const maxIterations = tasks.length * 2;

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    tasks.forEach(task => {
      const id = task.id;
      if (adjacency[id]) {
        const maxIncomingLevel = Math.max(
          -1,
          ...adjacency[id].in.map(edge => levels[edge.from] ?? -1)
        );
        if (levels[id] < maxIncomingLevel + 1) {
          levels[id] = maxIncomingLevel + 1;
          changed = true;
        }
      }
    });
  }

  return levels;
}

/**
 * 识别可并行任务组
 * @param {Array} tasks - 任务数组
 * @param {Object} adjacency - 邻接表
 * @returns {Array} - 并行组数组
 */
function identifyParallelGroups(tasks, adjacency) {
  const levels = calculateLevels(tasks, adjacency);
  const groups = {};

  // 按层级分组
  tasks.forEach(task => {
    const level = levels[task.id] ?? 0;
    if (!groups[level]) {
      groups[level] = [];
    }
    groups[level].push(task.id);
  });

  // 转换为数组格式
  return Object.entries(groups)
    .map(([level, taskIds]) => ({
      level: parseInt(level, 10),
      taskIds,
      canRunSimultaneously: true,
    }))
    .sort((a, b) => a.level - b.level);
}

/**
 * 计算关键路径（最长路径）
 * @param {Array} tasks - 任务数组
 * @param {Object} adjacency - 邻接表
 * @param {Object} durations - 任务耗时估算 { taskId: seconds }
 * @returns {Object} - { path: 任务ID数组, totalDuration: 总耗时 }
 */
function calculateCriticalPath(tasks, adjacency, durations = {}) {
  // 使用默认耗时（如果未提供）
  const taskDuration = {};
  tasks.forEach(task => {
    taskDuration[task.id] = durations[task.id] || estimateTaskDuration(task);
  });

  // 动态规划：计算从每个任务到终点的最长路径
  const memo = {};

  function longestPathFrom(taskId) {
    if (memo[taskId] !== undefined) {
      return memo[taskId];
    }

    let maxDuration = taskDuration[taskId];
    let maxPath = [taskId];

    if (adjacency[taskId]) {
      adjacency[taskId].out.forEach(edge => {
        const result = longestPathFrom(edge.to);
        if (result.duration > maxDuration - taskDuration[taskId]) {
          maxDuration = taskDuration[taskId] + result.duration;
          maxPath = [taskId, ...result.path];
        }
      });
    }

    memo[taskId] = { path: maxPath, duration: maxDuration - taskDuration[taskId] };
    return memo[taskId];
  }

  // 找出所有起点任务（无入度）
  const startTasks = tasks.filter(task =>
    !adjacency[task.id] || adjacency[task.id].in.length === 0
  );

  // 找出最长路径
  let criticalPath = [];
  let maxTotalDuration = 0;

  startTasks.forEach(task => {
    const result = longestPathFrom(task.id);
    if (result.duration > maxTotalDuration) {
      maxTotalDuration = result.duration;
      criticalPath = result.path;
    }
  });

  return {
    path: criticalPath,
    totalDuration: maxTotalDuration,
  };
}

/**
 * 估算任务耗时（基于规则）
 * @param {Object} task - 任务对象
 * @returns {number} - 预估耗时（秒）
 */
function estimateTaskDuration(task) {
  if (!task) return 300; // 默认5分钟

  const text = `${task.title || ''} ${task.description || ''} ${task.details || ''}`.toLowerCase();

  // 基于关键词的估算规则
  if (text.includes('创建') || text.includes('新建') || text.includes('初始化')) {
    return 120; // 2分钟
  }
  if (text.includes('配置') || text.includes('设置')) {
    return 180; // 3分钟
  }
  if (text.includes('重构') || text.includes('优化')) {
    return 600; // 10分钟
  }
  if (text.includes('测试') || text.includes('验证')) {
    return 300; // 5分钟
  }
  if (text.includes('部署') || text.includes('发布')) {
    return 240; // 4分钟
  }
  if (text.includes('文档') || text.includes('注释')) {
    return 120; // 2分钟
  }

  // 基于文本长度的估算
  const textLength = text.length;
  if (textLength < 100) return 120;
  if (textLength < 300) return 300;
  if (textLength < 500) return 420;
  return 600;
}

/**
 * 构建完整的 DAG
 * @param {Array} tasks - 任务数组
 * @param {Array} dependencies - 依赖数组
 * @returns {Object} - DAG 对象
 */
function buildDAG(tasks, dependencies) {
  const adjacency = buildAdjacencyList(tasks, dependencies);
  const { sorted, hasCycle } = topologicalSort(tasks, adjacency);
  const cycleDetection = detectCycles(tasks, adjacency);
  const levels = calculateLevels(tasks, adjacency);
  const parallelGroups = identifyParallelGroups(tasks, adjacency);
  const criticalPath = calculateCriticalPath(tasks, adjacency);

  return {
    tasks: tasks.map(task => ({
      id: task.id,
      title: task.title,
      description: task.description || '',
      level: levels[task.id] ?? 0,
      inDegree: adjacency[task.id]?.in.length || 0,
      outDegree: adjacency[task.id]?.out.length || 0,
    })),
    edges: dependencies.map(dep => ({
      from: dep.from,
      to: dep.to,
      type: dep.type,
      strength: dep.strength,
      description: dep.description,
    })),
    adjacency,
    topologicalOrder: sorted,
    hasCycle: hasCycle || cycleDetection.hasCycle,
    cycles: cycleDetection.cycles,
    parallelGroups,
    criticalPath,
  };
}

/**
 * 获取任务的执行顺序（分阶段）
 * @param {Object} dag - DAG 对象
 * @returns {Array} - 执行阶段数组
 */
function getExecutionPhases(dag) {
  if (!dag || dag.hasCycle) {
    return [];
  }

  return dag.parallelGroups.map((group, index) => ({
    phaseId: `phase-${index + 1}`,
    phaseIndex: index,
    type: 'parallel',
    taskIds: group.taskIds,
    canRunSimultaneously: true,
    dependsOnPhases: index > 0 ? [`phase-${index}`] : [],
  }));
}

/**
 * 获取可立即执行的任务（无依赖）
 * @param {Object} dag - DAG 对象
 * @returns {Array} - 可执行任务ID数组
 */
function getExecutableTasks(dag) {
  if (!dag) return [];

  return dag.tasks
    .filter(task => task.inDegree === 0)
    .map(task => task.id);
}

/**
 * 获取任务的直接依赖
 * @param {Object} dag - DAG 对象
 * @param {string} taskId - 任务ID
 * @returns {Array} - 依赖任务ID数组
 */
function getTaskDependencies(dag, taskId) {
  if (!dag || !dag.adjacency || !dag.adjacency[taskId]) {
    return [];
  }

  return dag.adjacency[taskId].in.map(edge => edge.from);
}

/**
 * 获取任务的下游任务
 * @param {Object} dag - DAG 对象
 * @param {string} taskId - 任务ID
 * @returns {Array} - 下游任务ID数组
 */
function getTaskDownstream(dag, taskId) {
  if (!dag || !dag.adjacency || !dag.adjacency[taskId]) {
    return [];
  }

  return dag.adjacency[taskId].out.map(edge => edge.to);
}

/**
 * 获取所有下游任务（递归）
 * @param {Object} dag - DAG 对象
 * @param {string} taskId - 任务ID
 * @returns {Array} - 所有下游任务ID数组
 */
function getAllDownstream(dag, taskId) {
  const visited = new Set();

  function dfs(id) {
    if (visited.has(id)) return;
    visited.add(id);

    const downstream = getTaskDownstream(dag, id);
    downstream.forEach(d => dfs(d));
  }

  dfs(taskId);
  visited.delete(taskId); // 移除自己

  return [...visited];
}

module.exports = {
  buildAdjacencyList,
  topologicalSort,
  detectCycles,
  calculateLevels,
  identifyParallelGroups,
  calculateCriticalPath,
  estimateTaskDuration,
  buildDAG,
  getExecutionPhases,
  getExecutableTasks,
  getTaskDependencies,
  getTaskDownstream,
  getAllDownstream,
};
