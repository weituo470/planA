/**
 * dependency-analyzer.service.js
 * 依赖分析引擎
 * 从任务描述中提取文件操作、API调用、数据流等依赖关系
 */

/**
 * 文件操作模式匹配
 */
const FILE_PATTERNS = {
  // 读取操作
  read: [
    /读取\s+['"`]?([^'"`\s]+)['"`]?/gi,
    /read\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /fs\.readFile\s*\(\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /fs\.readFileSync\s*\(\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /import\s+.*?from\s+['"`]?([^'"`\s]+)['"`]?/gi,
    /require\s*\(\s*['"`]?([^'"`\s]+)['"`]?/gi,
  ],
  // 写入操作
  write: [
    /写入\s+['"`]?([^'"`\s]+)['"`]?/gi,
    /写[入到]{0,3}\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /创建\s+['"`]?([^'"`\s]+)['"`]?/gi,
    /生成\s+['"`]?([^'"`\s]+)['"`]?/gi,
    /fs\.writeFile\s*\(\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /fs\.writeFileSync\s*\(\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /export\s+/gi, // 可能是写入模块
  ],
  // 删除操作
  delete: [
    /删除\s+['"`]?([^'"`\s]+)['"`]?/gi,
    /移除\s+['"`]?([^'"`\s]+)['"`]?/gi,
    /fs\.unlink\s*\(\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /fs\.unlinkSync\s*\(\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /rm\s+-rf?\s+['"`]?([^'"`\s]+)['"`]?/gi,
  ],
  // 移动/重命名
  move: [
    /移动\s+['"`]?([^'"`\s]+)['"`]?\s*到\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /重命名\s+['"`]?([^'"`\s]+)['"`]?\s*为\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /mv\s+['"`]?([^'"`\s]+)['"`]?\s+['"`]?([^'"`\s]+)['"`]?/gi,
  ],
};

/**
 * API 调用模式匹配
 */
const API_PATTERNS = {
  request: [
    /fetch\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    /axios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    /http\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    /request\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
  ],
  graphql: [
    /graphql\s*$/gi,
    /gql\s*$/gi,
    /query\s+\w+\s*\{/gi,
    /mutation\s+\w+\s*\{/gi,
  ],
};

/**
 * 数据库操作模式
 */
const DATABASE_PATTERNS = {
  query: [
    /SELECT\s+.*?FROM\s+['"`]?([^\s'"`]+)['"`]?/gi,
    /db\.collection\s*\(\s*['"`]?([^'"`\s]+)['"`]?/gi,
    /find\s*\(\s*\{/gi,
    /findOne\s*\(\s*\{/gi,
  ],
  write: [
    /INSERT\s+INTO\s+['"`]?([^\s'"`]+)['"`]?/gi,
    /UPDATE\s+['"`]?([^\s'"`]+)['"`]?\s+SET/gi,
    /DELETE\s+FROM\s+['"`]?([^\s'"`]+)['"`]?/gi,
    /create\s*\(\s*\{/gi,
    /updateOne\s*\(\s*\{/gi,
    /deleteOne\s*\(\s*\{/gi,
    /save\s*\(\s*\{/gi,
  ],
};

/**
 * 显式依赖标记
 */
const EXPLICIT_DEPENDENCY_PATTERNS = [
  /after:\s*\[?([^\]]+)\]?/gi,
  /depends[_-]?on:\s*\[?([^\]]+)\]?/gi,
  /依赖[：:]\s*([^\n]+)/gi,
  /等待[：:]\s*([^\n]+)/gi,
];

/**
 * 从任务文本中提取文件路径
 * @param {string} text - 任务描述文本
 * @returns {Object} - 提取的文件操作 { read: [], write: [], delete: [], move: [] }
 */
function extractFileOperations(text) {
  if (!text || typeof text !== 'string') {
    return { read: [], write: [], delete: [], move: [] };
  }

  const operations = {
    read: new Set(),
    write: new Set(),
    delete: new Set(),
    move: new Set(),
  };

  // 检查读取操作
  FILE_PATTERNS.read.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(m => {
      if (m[1]) operations.read.add(m[1]);
    });
  });

  // 检查写入操作
  FILE_PATTERNS.write.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(m => {
      if (m[1]) operations.write.add(m[1]);
    });
  });

  // 检查删除操作
  FILE_PATTERNS.delete.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(m => {
      if (m[1]) operations.delete.add(m[1]);
    });
  });

  // 检查移动操作
  FILE_PATTERNS.move.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(m => {
      if (m[1] && m[2]) operations.move.add(`${m[1]} -> ${m[2]}`);
    });
  });

  // 转换为数组并去重
  return {
    read: [...operations.read].filter(Boolean),
    write: [...operations.write].filter(Boolean),
    delete: [...operations.delete].filter(Boolean),
    move: [...operations.move].filter(Boolean),
  };
}

/**
 * 从任务文本中提取 API 调用
 * @param {string} text - 任务描述文本
 * @returns {Object} - 提取的 API 调用
 */
function extractApiOperations(text) {
  if (!text || typeof text !== 'string') {
    return { endpoints: [], hasGraphQL: false };
  }

  const endpoints = new Set();
  let hasGraphQL = false;

  // 检查 HTTP 请求
  API_PATTERNS.request.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(m => {
      const endpoint = m[1] || m[2];
      if (endpoint) endpoints.add(endpoint);
    });
  });

  // 检查 GraphQL
  API_PATTERNS.graphql.forEach(pattern => {
    if (pattern.test(text)) hasGraphQL = true;
  });

  return {
    endpoints: [...endpoints].filter(Boolean),
    hasGraphQL,
  };
}

/**
 * 从任务文本中提取数据库操作
 * @param {string} text - 任务描述文本
 * @returns {Object} - 提取的数据库操作
 */
function extractDatabaseOperations(text) {
  if (!text || typeof text !== 'string') {
    return { tables: [], collections: [], isWrite: false };
  }

  const tables = new Set();
  const collections = new Set();
  let isWrite = false;

  // 检查查询操作
  DATABASE_PATTERNS.query.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(m => {
      if (m[1]) {
        if (text.toLowerCase().includes('collection')) {
          collections.add(m[1]);
        } else {
          tables.add(m[1]);
        }
      }
    });
  });

  // 检查写入操作
  DATABASE_PATTERNS.write.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(m => {
      if (m[1]) {
        isWrite = true;
        if (text.toLowerCase().includes('collection')) {
          collections.add(m[1]);
        } else {
          tables.add(m[1]);
        }
      }
    });
  });

  return {
    tables: [...tables].filter(Boolean),
    collections: [...collections].filter(Boolean),
    isWrite,
  };
}

/**
 * 提取显式依赖
 * @param {string} text - 任务描述文本
 * @param {Array} allTaskIds - 所有任务ID列表
 * @returns {Array} - 依赖的任务ID数组
 */
function extractExplicitDependencies(text, allTaskIds = []) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const dependencies = new Set();

  EXPLICIT_DEPENDENCY_PATTERNS.forEach(pattern => {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(m => {
      const depsStr = m[1] || m[0];
      if (depsStr) {
        // 尝试解析任务ID
        const possibleIds = depsStr
          .replace(/after:|depends[_-]?on:|依赖[：:]|等待[：:]/gi, '')
          .replace(/[\[\]'"`]/g, '')
          .split(/[,，\s]+/)
          .map(s => s.trim())
          .filter(Boolean);

        possibleIds.forEach(id => {
          // 检查是否是有效的任务ID
          if (allTaskIds.includes(id) || /^\d+$/.test(id) || /^task-?\d*/i.test(id)) {
            dependencies.add(id);
          }
        });
      }
    });
  });

  return [...dependencies];
}

/**
 * 分析单个任务的依赖
 * @param {Object} task - 任务对象 { id, title, description, ... }
 * @param {Array} allTasks - 所有任务列表
 * @returns {Object} - 依赖分析结果
 */
function analyzeTaskDependencies(task, allTasks = []) {
  if (!task) return null;

  const allTaskIds = allTasks.map(t => t.id);
  const text = `${task.title || ''}\n${task.description || ''}\n${task.details || ''}\n${task.core || ''}`;

  // 提取各类操作
  const fileOps = extractFileOperations(text);
  const apiOps = extractApiOperations(text);
  const dbOps = extractDatabaseOperations(text);
  const explicitDeps = extractExplicitDependencies(text, allTaskIds);

  return {
    taskId: task.id,
    fileOperations: fileOps,
    apiOperations: apiOps,
    databaseOperations: dbOps,
    explicitDependencies: explicitDeps,
    hasFileOps: fileOps.read.length > 0 || fileOps.write.length > 0 ||
                fileOps.delete.length > 0 || fileOps.move.length > 0,
    hasApiOps: apiOps.endpoints.length > 0,
    hasDbOps: dbOps.tables.length > 0 || dbOps.collections.length > 0,
    hasExplicitDeps: explicitDeps.length > 0,
  };
}

/**
 * 分析所有任务的依赖关系
 * @param {Array} tasks - 任务数组
 * @returns {Object} - 完整的依赖分析结果
 */
function analyzeAllDependencies(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { tasks: [], dependencies: [], warnings: [] };
  }

  // 分析每个任务的依赖
  const taskAnalyses = tasks.map(task => analyzeTaskDependencies(task, tasks));

  // 构建任务ID到索引的映射
  const taskIndexMap = {};
  tasks.forEach((task, index) => {
    taskIndexMap[task.id] = index;
  });

  const dependencies = [];
  const warnings = [];

  // 分析任务间的依赖关系
  for (let i = 0; i < tasks.length; i++) {
    const taskA = tasks[i];
    const analysisA = taskAnalyses[i];

    for (let j = 0; j < tasks.length; j++) {
      if (i === j) continue;

      const taskB = tasks[j];
      const analysisB = taskAnalyses[j];

      // 检测文件依赖：任务A写入 -> 任务B读取
      analysisA.fileOperations.write.forEach(fileA => {
        analysisB.fileOperations.read.forEach(fileB => {
          if (pathsMatch(fileA, fileB)) {
            dependencies.push({
              from: taskA.id,
              to: taskB.id,
              type: 'file',
              description: `文件依赖: ${taskA.id} 写入 "${fileA}" -> ${taskB.id} 读取`,
              strength: 'strong',
            });
          }
        });

        // 检测写入冲突（两个任务写入同一文件）
        analysisB.fileOperations.write.forEach(fileB => {
          if (pathsMatch(fileA, fileB)) {
            dependencies.push({
              from: taskA.id,
              to: taskB.id,
              type: 'conflict',
              description: `写入冲突: ${taskA.id} 和 ${taskB.id} 都写入 "${fileA}"`,
              strength: 'strong',
            });
            warnings.push(`任务 ${taskA.id} 和 ${taskB.id} 存在写入冲突: ${fileA}`);
          }
        });
      });

      // 检测 API 依赖链
      analysisA.apiOperations.endpoints.forEach(apiA => {
        analysisB.apiOperations.endpoints.forEach(apiB => {
          // 如果任务A POST 某个API，任务B GET 同个API
          if (endpointsMatch(apiA, apiB)) {
            dependencies.push({
              from: taskA.id,
              to: taskB.id,
              type: 'api',
              description: `API依赖: ${taskA.id} 调用 ${apiA} -> ${taskB.id} 可能依赖结果`,
              strength: 'weak',
            });
          }
        });
      });

      // 检测数据库依赖：任务A写入 -> 任务B查询
      if (analysisA.databaseOperations.isWrite && !analysisB.databaseOperations.isWrite) {
        const commonTables = analysisA.databaseOperations.tables.filter(t =>
          analysisB.databaseOperations.tables.includes(t)
        );
        const commonCollections = analysisA.databaseOperations.collections.filter(c =>
          analysisB.databaseOperations.collections.includes(c)
        );

        [...commonTables, ...commonCollections].forEach(entity => {
          dependencies.push({
            from: taskA.id,
            to: taskB.id,
            type: 'data',
            description: `数据依赖: ${taskA.id} 写入 ${entity} -> ${taskB.id} 查询`,
            strength: 'strong',
          });
        });
      }
    }

    // 添加显式依赖
    analysisA.explicitDependencies.forEach(depId => {
      if (taskIndexMap[depId] !== undefined) {
        dependencies.push({
          from: depId,
          to: taskA.id,
          type: 'explicit',
          description: `显式依赖: ${taskA.id} 等待 ${depId}`,
          strength: 'strong',
        });
      }
    });
  }

  return {
    tasks: taskAnalyses,
    dependencies,
    warnings: [...new Set(warnings)], // 去重
  };
}

/**
 * 检查两个路径是否匹配
 * @param {string} path1 - 路径1
 * @param {string} path2 - 路径2
 * @returns {boolean} - 是否匹配
 */
function pathsMatch(path1, path2) {
  if (!path1 || !path2) return false;

  // 规范化路径进行比较
  const normalize = p => p
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '')
    .toLowerCase();

  const n1 = normalize(path1);
  const n2 = normalize(path2);

  if (n1 === n2) return true;

  // 检查前缀匹配（目录匹配）
  if (n1.startsWith(n2 + '/') || n2.startsWith(n1 + '/')) return true;

  return false;
}

/**
 * 检查两个 API 端点是否匹配
 * @param {string} endpoint1 - 端点1
 * @param {string} endpoint2 - 端点2
 * @returns {boolean} - 是否匹配
 */
function endpointsMatch(endpoint1, endpoint2) {
  if (!endpoint1 || !endpoint2) return false;

  // 移除查询参数后比较
  const normalize = e => e.split('?')[0].toLowerCase();
  return normalize(endpoint1) === normalize(endpoint2);
}

/**
 * 解析 tasks_atomic.md 内容为任务数组
 * @param {string} content - tasks_atomic.md 的内容
 * @returns {Array} - 任务数组
 */
function parseAtomicTasks(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const tasks = [];
  const lines = content.split('\n');

  let currentTask = null;
  let taskIdCounter = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 匹配任务条目：- [ ] 或 - [x]
    const taskMatch = line.match(/^-\s*\[[ x]\]\s*(.+)$/);
    if (taskMatch) {
      if (currentTask) {
        tasks.push(currentTask);
      }

      const title = taskMatch[1].trim();
      currentTask = {
        id: `task-${taskIdCounter++}`,
        title,
        description: '',
        details: '',
        completed: line.includes('[x]'),
      };
      continue;
    }

    // 如果有当前任务，收集详情
    if (currentTask) {
      // 缩进的内容是任务详情
      if (line.startsWith('  ') || line.startsWith('\t')) {
        const detailLine = line.trim();
        if (detailLine) {
          // 识别不同的详情字段
          if (detailLine.startsWith('core:') || detailLine.startsWith('核心:')) {
            currentTask.core = detailLine.replace(/^(core:|核心:)\s*/, '');
          } else if (detailLine.startsWith('ac:') || detailLine.startsWith('验收:')) {
            currentTask.ac = detailLine.replace(/^(ac:|验收:)\s*/, '');
          } else {
            currentTask.details += detailLine + '\n';
          }
        }
      } else if (line === '' && currentTask) {
        // 空行表示任务结束
        tasks.push(currentTask);
        currentTask = null;
      }
    }
  }

  // 添加最后一个任务
  if (currentTask) {
    tasks.push(currentTask);
  }

  return tasks;
}

module.exports = {
  extractFileOperations,
  extractApiOperations,
  extractDatabaseOperations,
  extractExplicitDependencies,
  analyzeTaskDependencies,
  analyzeAllDependencies,
  pathsMatch,
  endpointsMatch,
  parseAtomicTasks,
};
