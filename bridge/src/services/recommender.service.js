/**
 * recommender.service.js
 * 推荐方案生成引擎
 * 基于 DAG 分析结果，生成多种执行策略推荐
 */

const { estimateTaskDuration } = require('./dag-builder.service');

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
 * @returns {Object} - { score: 0-100, description: string }
 */
function calculateParallelismScore(dag) {
  if (!dag || !dag.parallelGroups || dag.parallelGroups.length === 0) {
    return { score: 0, description: '无可并行任务' };
  }

  const totalTasks = dag.tasks.length;
  const maxParallelGroupSize = Math.max(...dag.parallelGroups.map(g => g.taskIds.length));
  const avgParallelGroupSize = dag.parallelGroups.reduce((sum, g) => sum + g.taskIds.length, 0) / dag.parallelGroups.length;

  // 计算并行度评分
  let score = 0;
  if (totalTasks > 1) {
    score = (avgParallelGroupSize / totalTasks) * 100;
  }

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

  return { score: Math.round(score), description, maxParallelGroupSize };
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

  // 为每个任务推荐 CLI
  const cliAllocation = {};
  dag.tasks.forEach(task => {
    const taskObj = { title: task.title, description: task.description };
    let recommendedCli = recommendCliForTask(taskObj);

    // 如果某个 CLI 不可用，切换到另一个
    if (recommendedCli === 'claude' && !cliAvailability.claude) {
      recommendedCli = 'codex';
    } else if (recommendedCli === 'codex' && !cliAvailability.codex) {
      recommendedCli = 'claude';
    }

    cliAllocation[task.id] = recommendedCli;
  });

  // 生成执行阶段
  const phases = dag.parallelGroups.map((group, index) => {
    // 确定该阶段使用的 CLI
    const stageClis = new Set(group.taskIds.map(id => cliAllocation[id]));
    const hasCodex = stageClis.has('codex');
    const hasClaude = stageClis.has('claude');

    let suggestedCli = 'mixed';
    if (hasCodex && !hasClaude) suggestedCli = 'codex';
    if (!hasCodex && hasClaude) suggestedCli = 'claude';

    // 计算阶段预计耗时
    const maxDuration = Math.max(
      ...group.taskIds.map(id => estimateTaskDuration({ title: dag.tasks.find(t => t.id === id)?.title }))
    );

    return {
      phaseId: `phase-${index + 1}`,
      phaseIndex: index,
      type: group.taskIds.length > 1 ? 'parallel' : 'serial',
      taskIds: group.taskIds,
      canRunSimultaneously: true,
      dependsOnPhases: index > 0 ? [`phase-${index}`] : [],
      suggestedCli,
      estimatedDuration: maxDuration,
    };
  });

  // 计算总耗时
  const totalDuration = phases.reduce((sum, phase) => sum + phase.estimatedDuration, 0);

  // 并行度评分
  const parallelism = calculateParallelismScore(dag);

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
    description: generateDescription(type, parallelism, dag.tasks.length, phases.length),
    phases,
    estimatedTotalTime: totalDuration,
    cliAllocation,
    parallelism,
    rationale: generateRationale(dag, cliAllocation, parallelism),
  };
}

/**
 * 生成方案描述
 */
function generateDescription(type, parallelism, totalTasks, totalPhases) {
  const timeText = `${Math.round(parallelism.score)}%`;
  return `${type === 'parallel' ? '并行' : type === 'hybrid' ? '混合' : '串行'}执行方案：${totalTasks} 个任务分为 ${totalPhases} 个阶段，并行度 ${timeText}`;
}

/**
 * 生成推荐理由
 */
function generateRationale(dag, cliAllocation, parallelism) {
  const reasons = [];

  // CLI 分配统计
  const codexCount = Object.values(cliAllocation).filter(cli => cli === 'codex').length;
  const claudeCount = Object.values(cliAllocation).filter(cli => cli === 'claude').length;

  if (codexCount > 0) {
    reasons.push(`${codexCount} 个任务分配给 Codex（适合快速生成和测试）`);
  }
  if (claudeCount > 0) {
    reasons.push(`${claudeCount} 个任务分配给 Claude Code（适合复杂分析和重构）`);
  }

  // 并行度说明
  if (parallelism.score >= 40) {
    reasons.push(`高并行度：最多 ${parallelism.maxParallelGroupSize} 个任务可同时执行`);
  }

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
      // 强制所有任务用 Codex
      const allCodexAllocation = {};
      Object.keys(codexRec.cliAllocation).forEach(id => {
        allCodexAllocation[id] = 'codex';
      });
      codexRec.cliAllocation = allCodexAllocation;
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
      // 强制所有任务用 Claude
      const allClaudeAllocation = {};
      Object.keys(claudeRec.cliAllocation).forEach(id => {
        allClaudeAllocation[id] = 'claude';
      });
      claudeRec.cliAllocation = allClaudeAllocation;
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

  const { graph, warnings } = analysisResult;
  const { tasks, edges, parallelGroups, criticalPath } = graph;

  return {
    totalTasks: tasks.length,
    totalDependencies: edges.length,
    parallelGroups: parallelGroups.length,
    maxParallelGroupSize: Math.max(...parallelGroups.map(g => g.taskIds.length), 0),
    criticalPathLength: criticalPath.path.length,
    estimatedDuration: criticalPath.totalDuration,
    warnings: warnings || [],
    hasCycle: graph.hasCycle,
    hasConflicts: edges.some(e => e.type === 'conflict'),
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
