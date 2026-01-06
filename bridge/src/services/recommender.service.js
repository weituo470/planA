/**
 * recommender.service.js
 * 推荐方案生成引擎
 * 基于 DAG 分析结果，生成多种执行策略推荐
 */

const { estimateTaskDuration } = require('./dag-builder.service');

function normalizeMaxCliConcurrency(value, fallback = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  if (int < 1) return 1;
  if (int > 8) return 8;
  return int;
}

function estimateParallelMakespan(durations, concurrency) {
  const clean = Array.isArray(durations)
    ? durations.filter((d) => Number.isFinite(d) && d > 0)
    : [];
  if (clean.length === 0) return 0;

  const nRaw = Math.floor(Number(concurrency));
  const n = Math.max(1, Math.min(clean.length, Number.isFinite(nRaw) ? nRaw : 1));

  const loads = new Array(n).fill(0);
  const sorted = clean.slice().sort((a, b) => b - a);
  for (const d of sorted) {
    let minIdx = 0;
    for (let i = 1; i < loads.length; i += 1) {
      if (loads[i] < loads[minIdx]) minIdx = i;
    }
    loads[minIdx] += d;
  }
  return Math.max(...loads);
}

function buildBatchedExecutionPhases(dag, cliAllocation, maxCliConcurrency) {
  if (!dag || dag.hasCycle) return [];

  const concurrency = normalizeMaxCliConcurrency(maxCliConcurrency, 8);
  const tasks = Array.isArray(dag.tasks) ? dag.tasks : [];
  const adjacency = dag.adjacency && typeof dag.adjacency === 'object' ? dag.adjacency : {};
  const topo = Array.isArray(dag.topologicalOrder) ? dag.topologicalOrder : [];
  const orderIndex = {};
  topo.forEach((id, idx) => {
    orderIndex[id] = idx;
  });

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const inDegree = {};
  const outgoing = {};
  tasks.forEach((task) => {
    const id = task.id;
    const incoming = Array.isArray(adjacency?.[id]?.in) ? adjacency[id].in : [];
    const out = Array.isArray(adjacency?.[id]?.out) ? adjacency[id].out : [];
    inDegree[id] = incoming.length;
    outgoing[id] = out.map((e) => e.to).filter(Boolean);
  });

  const ready = tasks.filter((t) => (inDegree[t.id] || 0) === 0).map((t) => t.id);
  const sortReady = () => {
    ready.sort((a, b) => {
      const ai = orderIndex[a] ?? Number.MAX_SAFE_INTEGER;
      const bi = orderIndex[b] ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return String(a).localeCompare(String(b));
    });
  };

  const phases = [];
  const scheduled = new Set();
  sortReady();

  while (scheduled.size < tasks.length) {
    if (ready.length === 0) {
      // Should not happen when dag.hasCycle is false, but guard anyway.
      break;
    }

    const batch = ready.splice(0, concurrency);
    batch.forEach((id) => scheduled.add(id));

    batch.forEach((id) => {
      (outgoing[id] || []).forEach((to) => {
        if (scheduled.has(to)) return;
        inDegree[to] = (inDegree[to] || 0) - 1;
        if (inDegree[to] === 0) ready.push(to);
      });
    });

    sortReady();

    const maxConcurrency = Math.max(1, Math.min(concurrency, batch.length));
    const stageClis = new Set(batch.map((id) => cliAllocation?.[id]).filter(Boolean));
    const hasCodex = stageClis.has('codex');
    const hasClaude = stageClis.has('claude');
    let suggestedCli = 'mixed';
    if (hasCodex && !hasClaude) suggestedCli = 'codex';
    if (!hasCodex && hasClaude) suggestedCli = 'claude';

    const durations = batch.map((id) => estimateTaskDuration(taskById.get(id) || {}));
    const estimatedDuration = estimateParallelMakespan(durations, maxConcurrency);

    const phaseIndex = phases.length;
    phases.push({
      phaseId: `phase-${phaseIndex + 1}`,
      phaseIndex,
      type: maxConcurrency > 1 && batch.length > 1 ? 'parallel' : 'serial',
      taskIds: batch,
      canRunSimultaneously: maxConcurrency > 1 && batch.length > 1,
      maxConcurrency,
      dependsOnPhases: phaseIndex > 0 ? [`phase-${phaseIndex}`] : [],
      suggestedCli,
      estimatedDuration,
    });
  }

  // Fallback: if we failed to schedule everything, return the original level-based groups.
  if (scheduled.size !== tasks.length && Array.isArray(dag.parallelGroups)) {
    return dag.parallelGroups.map((group, index) => {
      const maxConcurrency = Math.max(1, Math.min(concurrency, group.taskIds.length));
      const stageClis = new Set(group.taskIds.map((id) => cliAllocation?.[id]).filter(Boolean));
      const hasCodex = stageClis.has('codex');
      const hasClaude = stageClis.has('claude');
      let suggestedCli = 'mixed';
      if (hasCodex && !hasClaude) suggestedCli = 'codex';
      if (!hasCodex && hasClaude) suggestedCli = 'claude';

      const durations = group.taskIds.map((id) => estimateTaskDuration(taskById.get(id) || {}));
      const estimatedDuration = estimateParallelMakespan(durations, maxConcurrency);

      return {
        phaseId: `phase-${index + 1}`,
        phaseIndex: index,
        type: maxConcurrency > 1 && group.taskIds.length > 1 ? 'parallel' : 'serial',
        taskIds: group.taskIds,
        canRunSimultaneously: maxConcurrency > 1 && group.taskIds.length > 1,
        maxConcurrency,
        dependsOnPhases: index > 0 ? [`phase-${index}`] : [],
        suggestedCli,
        estimatedDuration,
      };
    });
  }

  return phases;
}

/**
 * CLI 工具能力评估
 */
const CLI_CAPABILITIES = {
  codex: {
    strengths: ['文件操作', '代码生成', '测试执行', '文档编写'],
    weaknesses: ['复杂逻辑推理', '多文件重构'],
    preferredTasks: ['创建', '生成', '测试', '文档'],
  },
  claude: {
    strengths: ['复杂逻辑', '架构设计', '多文件重构', '问题诊断'],
    weaknesses: ['快速迭代'],
    preferredTasks: ['重构', '优化', '分析', '设计'],
  },
};

/**
 * 评估任务适合的 CLI
 * @param {Object} task - 任务对象
 * @returns {string} - 'codex' 或 'claude'
 */
function recommendCliForTask(task) {
  if (!task) return 'codex';

  const text = `${task.title || ''} ${task.description || ''} ${task.details || ''}`.toLowerCase();

  // Claude 擅长的任务类型
  const claudeKeywords = [
    '重构', '优化', '分析', '诊断', '调试',
    '架构', '设计', '审查', 'review',
    '复杂', '抽象', '模式',
  ];

  // Codex 擅长的任务类型
  const codexKeywords = [
    '创建', '生成', '新建', '初始化',
    '测试', '验证', '文档', '注释',
    '配置', '设置', '部署',
  ];

  let claudeScore = 0;
  let codexScore = 0;

  claudeKeywords.forEach(keyword => {
    if (text.includes(keyword)) claudeScore += 2;
  });

  codexKeywords.forEach(keyword => {
    if (text.includes(keyword)) codexScore += 2;
  });

  // 检查是否需要人工交互
  if (text.includes('交互') || text.includes('确认') || text.includes('选择')) {
    codexScore += 1; // Codex 更适合交互式任务
  }

  // 检查是否是大型任务
  if (text.length > 500) {
    claudeScore += 1; // Claude 更擅长处理复杂描述
  }

  return claudeScore > codexScore ? 'claude' : 'codex';
}

/**
 * 评估任务风险等级
 * @param {Object} task - 任务对象
 * @returns {string} - 'low', 'medium', 'high'
 */
function assessTaskRisk(task) {
  if (!task) return 'medium';

  const text = `${task.title || ''} ${task.description || ''} ${task.details || ''}`.toLowerCase();

  // 高风险关键词
  const highRiskKeywords = [
    '删除', '移除', '清空', '覆盖',
    'destructive', 'remove', 'delete', 'drop',
  ];

  // 低风险关键词
  const lowRiskKeywords = [
    '创建', '新建', '添加', '读取',
    '查看', '获取', '查询',
  ];

  for (const keyword of highRiskKeywords) {
    if (text.includes(keyword)) return 'high';
  }

  for (const keyword of lowRiskKeywords) {
    if (text.includes(keyword)) return 'low';
  }

  return 'medium';
}

/**
 * 检查任务是否需要人工交互
 * @param {Object} task - 任务对象
 * @returns {boolean}
 */
function requiresInteraction(task) {
  if (!task) return false;

  const text = `${task.title || ''} ${task.description || ''} ${task.details || ''}`.toLowerCase();

  const interactionKeywords = [
    '确认', '选择', '审核', '批准',
    'review', 'approve', 'confirm', 'choose',
  ];

  return interactionKeywords.some(keyword => text.includes(keyword));
}

/**
 * 计算并行度评分
 * @param {Object} dag - DAG 对象
 * @param {number} maxCliConcurrency - 最大 CLI 并发数（上限 8）
 * @returns {Object} - { score: 0-100, description: string }
 */
function calculateParallelismScore(dag, maxCliConcurrency = 8) {
  if (!dag || !dag.parallelGroups || dag.parallelGroups.length === 0) {
    return { score: 0, description: '无可并行任务' };
  }

  const concurrency = normalizeMaxCliConcurrency(maxCliConcurrency, 8);
  const totalTasks = dag.tasks.length;
  const groupSizes = dag.parallelGroups.map((g) => Math.min(g.taskIds.length, concurrency));
  const maxParallelGroupSize = Math.max(...groupSizes);
  const avgParallelGroupSize = groupSizes.reduce((sum, size) => sum + size, 0) / groupSizes.length;

  // 计算并行度评分
  let score = 0;
  const denom = Math.max(1, Math.min(totalTasks, concurrency));
  score = (avgParallelGroupSize / denom) * 100;

  let description = '';
  if (score >= 70) {
    description = '高度可并行';
  } else if (score >= 40) {
    description = '中度可并行';
  } else if (score >= 20) {
    description = '低度可并行';
  } else {
    description = '主要串行执行';
  }

  return { score: Math.round(score), description, maxParallelGroupSize, maxCliConcurrency: concurrency };
}

/**
 * 生成推荐方案
 * @param {Object} dag - DAG 对象
 * @param {Object} options - 选项
 * @returns {Object} - 推荐方案
 */
function generateRecommendation(dag, options = {}) {
  if (!dag || dag.hasCycle) {
    return {
      feasible: false,
      reason: dag?.hasCycle ? '检测到循环依赖，无法执行' : '无效的 DAG',
    };
  }

  const { cliAvailability = { codex: true, claude: true } } = options;
  const maxCliConcurrency = normalizeMaxCliConcurrency(options.maxCliConcurrency, 8);
  const forcedCli = options.forceCli === 'codex' || options.forceCli === 'claude'
    ? options.forceCli
    : null;
  const cliAllocationOverride =
    options.cliAllocationOverride && typeof options.cliAllocationOverride === 'object'
      ? options.cliAllocationOverride
      : null;

  // 为每个任务推荐 CLI
  const cliAllocation = {};
  dag.tasks.forEach(task => {
    const taskObj = { title: task.title, description: task.description };
    const overrideCli = cliAllocationOverride?.[task.id];
    let recommendedCli =
      forcedCli ||
      (overrideCli === 'codex' || overrideCli === 'claude' ? overrideCli : null) ||
      recommendCliForTask(taskObj);

    // 如果某个 CLI 不可用，切换到另一个
    if (recommendedCli === 'claude' && !cliAvailability.claude) {
      recommendedCli = 'codex';
    } else if (recommendedCli === 'codex' && !cliAvailability.codex) {
      recommendedCli = 'claude';
    }

    cliAllocation[task.id] = recommendedCli;
  });

  // 生成执行阶段（并发分批，而不是“同层全部并行”）
  const phases = buildBatchedExecutionPhases(dag, cliAllocation, maxCliConcurrency);

  // 计算总耗时
  const totalDuration = phases.reduce((sum, phase) => sum + (phase.estimatedDuration || 0), 0);

  // 并行度评分
  const parallelism = calculateParallelismScore(dag, maxCliConcurrency);

  // 确定推荐类型
  let type = 'serial';
  if (parallelism.score >= 40) {
    type = 'parallel';
  } else if (parallelism.score >= 20) {
    type = 'hybrid';
  }

  return {
    feasible: true,
    type,
    description: generateDescription(type, parallelism, dag.tasks.length, phases.length, maxCliConcurrency),
    phases,
    estimatedTotalTime: totalDuration,
    cliAllocation,
    maxCliConcurrency,
    parallelism,
    rationale: generateRationale(dag, cliAllocation, parallelism, maxCliConcurrency),
  };
}

/**
 * 生成方案描述
 */
function generateDescription(type, parallelism, totalTasks, totalPhases, maxCliConcurrency) {
  const timeText = `${Math.round(parallelism.score)}%`;
  return `${type === 'parallel' ? '并发' : type === 'hybrid' ? '混合' : '串行'}执行方案：${totalTasks} 个任务分为 ${totalPhases} 个阶段，并行度 ${timeText}（并发上限 ${maxCliConcurrency}）`;
}

/**
 * 生成推荐理由
 */
function generateRationale(dag, cliAllocation, parallelism, maxCliConcurrency) {
  const reasons = [];

  reasons.push(`并发上限：${maxCliConcurrency}`);

  // CLI 分配统计
  const codexCount = Object.values(cliAllocation).filter(cli => cli === 'codex').length;
  const claudeCount = Object.values(cliAllocation).filter(cli => cli === 'claude').length;

  if (codexCount > 0) {
    reasons.push(`${codexCount} 个任务分配给 Codex（适合快速生成和测试）`);
  }
  if (claudeCount > 0) {
    reasons.push(`${claudeCount} 个任务分配给 Claude Code（适合复杂分析和重构）`);
  }

  reasons.push(`单阶段最多并发：${parallelism.maxParallelGroupSize}`);

  return reasons.join('；');
}

/**
 * 生成多个可选方案
 * @param {Object} dag - DAG 对象
 * @param {Object} options - 选项
 * @returns {Array} - 推荐方案数组
 */
function generateRecommendations(dag, options = {}) {
  if (!dag || dag.hasCycle) {
    return [];
  }

  const recommendations = [];

  // 方案1：默认推荐（最优）
  const defaultRec = generateRecommendation(dag, options);
  if (defaultRec.feasible) {
    recommendations.push({
      ...defaultRec,
      priority: 'high',
      label: '推荐方案',
    });
  }

  // 方案2：全 Codex 方案（如果可用）
  if (options.cliAvailability?.codex !== false) {
    const codexRec = generateRecommendation(dag, {
      ...options,
      forceCli: 'codex',
    });
    if (codexRec.feasible) {
      codexRec.label = '全 Codex 方案';
      codexRec.priority = 'medium';
      codexRec.description += '，全部使用 Codex 执行';
      recommendations.push(codexRec);
    }
  }

  // 方案3：全 Claude 方案（如果可用）
  if (options.cliAvailability?.claude !== false) {
    const claudeRec = generateRecommendation(dag, {
      ...options,
      forceCli: 'claude',
    });
    if (claudeRec.feasible) {
      claudeRec.label = '全 Claude 方案';
      claudeRec.priority = 'low';
      claudeRec.description += '，全部使用 Claude Code 执行';
      recommendations.push(claudeRec);
    }
  }

  return recommendations;
}

/**
 * 生成执行摘要
 * @param {Object} analysisResult - 分析结果
 * @returns {Object} - 执行摘要
 */
function generateExecutionSummary(analysisResult) {
  if (!analysisResult || !analysisResult.graph) {
    return null;
  }

  const maxCliConcurrency = normalizeMaxCliConcurrency(analysisResult?.maxCliConcurrency, 8);
  const { graph, warnings } = analysisResult;
  const { tasks, edges, parallelGroups, criticalPath } = graph;

  const uncappedMaxParallelGroupSize = Math.max(...parallelGroups.map(g => g.taskIds.length), 0);
  const maxParallelGroupSize = Math.min(uncappedMaxParallelGroupSize, maxCliConcurrency);

  return {
    totalTasks: tasks.length,
    totalDependencies: edges.length,
    parallelGroups: parallelGroups.length,
    maxParallelGroupSize,
    criticalPathLength: criticalPath.path.length,
    estimatedDuration: criticalPath.totalDuration,
    warnings: warnings || [],
    hasCycle: graph.hasCycle,
    hasConflicts: edges.some(e => e.type === 'conflict'),
    maxCliConcurrency,
    uncappedMaxParallelGroupSize,
  };
}

module.exports = {
  CLI_CAPABILITIES,
  recommendCliForTask,
  assessTaskRisk,
  requiresInteraction,
  calculateParallelismScore,
  generateRecommendation,
  generateRecommendations,
  generateExecutionSummary,
};
