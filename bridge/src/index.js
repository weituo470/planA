const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const chokidar = require('chokidar');
const { createTwoFilesPatch } = require('diff');
const pty = require('node-pty');

// MVP5: 智能任务编排服务
const pathAdapter = require('./services/path-adapter.service');
const dependencyAnalyzer = require('./services/dependency-analyzer.service');
const dagBuilder = require('./services/dag-builder.service');
const recommender = require('./services/recommender.service');

// MVP5: 依赖分析结果存储
const analysisResults = new Map();
const executionPlans = new Map();
const executionStates = new Map();
const mvp5ExecutionRunners = new Map();

function nanoid(size = 21) {
  return crypto.randomBytes(size).toString('base64url').slice(0, size);
}

const PORT = process.env.WORKFLOW_BRIDGE_PORT || 4100;
const DATA_DIR = path.join(__dirname, '..', 'data');
const EVENT_LOG = path.join(DATA_DIR, 'events.jsonl');
const LLM_CONFIG_FILE = path.join(DATA_DIR, 'llm-config.json');
// Prompts are editable via Dashboard and stored in a single, repo-local file for easy management.
const PROMPT_CONFIG_FILE = path.resolve(__dirname, '..', '..', 'workflow', 'prompt-config.json');
// Reset-to-defaults reads from this repo-tracked baseline file.
const PROMPT_CONFIG_DEFAULTS_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  'workflow',
  'prompt-config.defaults.json',
);
// Backward-compat: previous versions stored prompts under bridge/data (ignored by git).
const PROMPT_CONFIG_LEGACY_FILE = path.join(DATA_DIR, 'prompt-config.json');
const PROMPT_PRESETS_FILE = path.join(DATA_DIR, 'prompt-presets.json');
const WORKSPACE_CONFIG_FILE = path.join(DATA_DIR, 'workspace-config.json');
const CLI_TOOLS_CONFIG_FILE = path.join(DATA_DIR, 'cli-tools.json');
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');
const REPO_DIR = path.resolve(__dirname, '..', '..');
const DOCS_DIR = path.join(REPO_DIR, 'docs');
const WATCH_DIRS =
  process.env.WORKFLOW_WATCH_DIRS || '.codex,task,workflow';
const MAX_DIFF_CHARS = 8000;
const SPEC_ROOT = path.join(ROOT_DIR, 'workflow', 'specs');
const DEFAULT_TESTCLI_DIR = path.join(os.homedir(), 'testcli');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SPEC_ROOT, { recursive: true });
try {
  fs.mkdirSync(DEFAULT_TESTCLI_DIR, { recursive: true });
} catch {
  // ignore
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

const state = {
  status: 'Thinking',
  tasks: { nodes: [], edges: [] },
  lastDiff: null,
  approvals: {},
  testReport: null,
  logs: [],
};

const atomizeJobs = new Map();
const reportScoreJobs = new Map();

const fileSnapshots = new Map();
let isPaused = false;
const SPEC_ARTIFACTS = ['requirements', 'design', 'tasks'];
const SPEC_TEMPLATES = {
  requirements: `# 需求（requirements）\n\n## 背景\n\n## 用户故事\n\n## 验收标准（EARS）\n- 当[条件/事件]时，系统应[期望行为]。\n`,
  design: `# 设计（design）\n\n## 架构概览\n\n## 关键流程/时序\n\n## 实现考虑\n`,
  tasks: `# 任务（tasks）\n\n## 说明\n- 任务粒度：模块级/交付物级（建议 ≤ 25），不要原子化。\n- 编排系统会解析下方 TASKS_JSON 区块生成 DAG，并据此限制并发（≤ 8）调度 CLI worker 池。\n- 参考：docs/任务编排.md\n\n## TASKS_JSON\n{\n  \"tasks\": []\n}\n## END_TASKS_JSON\n\n## 回写记录\n- （可选）记录实现进度、关键变更与验证结果。\n`,
};
const DEFAULT_SPEC_STATUS = {
  requirementsConfirmed: false,
  designConfirmed: false,
  tasksConfirmed: false,
  techStackConfirmed: false,
  prompt: '',
  projectCategory: null,
  requirementsReview: {
    notes: '',
    points: [],
    updatedAt: null,
    confirmedAt: null,
  },
  requirementsClarifications: {
    questions: [],
    updatedAt: null,
    confirmedAt: null,
  },
  techStackClarifications: {
    questions: [],
    updatedAt: null,
    confirmedAt: null,
  },
  lastError: null,
  flowReport: {
    activeRunId: null,
    history: [],
  },
};

const LLM_PROVIDERS = [
  { id: 'openai', label: 'OpenAI / OpenAI-Compatible' },
  { id: 'google', label: 'Google / Gemini (OpenAI-Compatible Gateway)' },
  { id: 'anthropic', label: 'Anthropic / Claude (OpenAI-Compatible Gateway)' },
];

const LLM_MODEL_OPTIONS = [
  { id: 'gpt-5.2-codex', providerId: 'openai', label: 'ChatGPT-5.2-Codex' },
  // NOTE: Some gateways expose Gemini/Claude under provider-specific ids.
  { id: 'gemini-3-pro-preview[x6]', providerId: 'google', label: 'Gemini 3 Pro' },
  { id: 'claude-opus-4-5-20251101', providerId: 'anthropic', label: 'Claude 4.5 Opus' },
];

const LLM_MODEL_ALIASES = {
  // Backward-compatible aliases (previous UI labels).
  'gemini-3-pro': 'gemini-3-pro-preview[x6]',
  'claude-4.5-opus': 'claude-opus-4-5-20251101',
};

const PROMPT_STAGE_KEYS = [
  'projectCategory',
  'requirementsClarifications',
  'requirements',
  'design',
  'tasks',
  'reportScore',
  'mvp5Plan',
];

const DEFAULT_PROMPT_CONFIG = {
  version: 5,
  meta: {
    projectOverview:
      '本文件集中管理本项目所有可编辑的 LLM 提示词模板（system/user）。\n' +
      '每个 stages.<key> 对应一个自动化步骤：生成/澄清/评分/编排；Bridge 调用模型时会读取这里的模板，并用 {{变量}} 注入上下文。\n' +
      '统一约定：默认只输出 JSON（不要 Markdown/解释），以便被程序可靠解析。\n' +
      'MVP5 智能任务编排会优先使用 Claude 4.5 Opus（claude-opus-4-5-20251101）生成“并发受限、worker 池复用”的执行方案；失败会自动降级为规则方案。',
  },
  stages: {
    projectCategory: {
      label: '项目类型识别',
      scenario:
        '在创建/更新 Spec 时调用。用于判断输入需求属于“软件项目”还是“非软件项目”，并输出 projectCategory 供 UI 与后续流程分支使用。',
      variables: ['prompt'],
      system:
        '你是项目类型识别助手。只输出 JSON，不要解释，不要包含分析或思考过程。',
      user:
        `原始需求：{{prompt}}\n\n` +
        '请判断该需求属于“软件项目”还是“非软件项目”。\n' +
        '- 软件项目：需要开发/修改应用、网站、脚本、后端服务、数据库、API、自动化工具等，以代码交付为主。\n' +
        '- 非软件项目：主要产出是文案/策划/报告/制度/流程/课程/活动方案等，不以写代码交付为目标。\n\n' +
        '请严格只输出 JSON：{"projectCategory":"software|non_software","confidence":0-1,"reason":"一句话理由"}。\n' +
        '要求：projectCategory 只能是 software 或 non_software；confidence 为 0-1 数字；reason 用简体中文 1 句。',
    },
    requirements: {
      label: '需求生成',
      scenario:
        '在用户完成“提问确认”并提交回答后调用。用于生成 requirements.md 的结构化内容（background/user_stories/acceptance），并综合用户回答的澄清结论，且 acceptance 必须是可验证语句。',
      variables: ['prompt', 'clarificationsSummary'],
      system:
        '你是产品需求助手。只输出 JSON，不要解释，不要包含分析或思考过程。',
      user:
        `需求描述：{{prompt}}\n\n` +
        `需求澄清结论（来自用户回答，可能为空）：\n{{clarificationsSummary}}\n\n` +
        '请只输出 JSON，必须包含字段：background（字符串）, user_stories（字符串数组）, acceptance（字符串数组）。\n' +
        '要求：所有内容必须为简体中文；acceptance 每条为“当...时，系统应...”风格的可验证语句。\n' +
        '不要输出除 JSON 以外的任何内容。',
    },
    requirementsClarifications: {
      label: '需求确认问题生成',
      scenario:
        '在用户提交“原始需求”后调用。用于产出可点击选项的澄清问题列表，帮助用户确认口径与边界（questions 数组）。',
      variables: ['prompt'],
      system:
        '你是需求澄清助手。只输出 JSON，不要解释，不要包含分析或思考过程。',
      user:
        `原始需求：{{prompt}}\n\n` +
        '请生成 5-8 个“需求确认问题”，用于对齐开发口径：\n' +
        '- 必须结合原始需求的领域/关键词（至少 2 题需要直接引用关键词）\n' +
        '- 每题都要给出 3-6 个可点击选项，并允许“其他（用户输入）”\n' +
        '- 避免泛泛而谈（例如“还有什么需求？”、“预算多少？”）\n\n' +
        '仅输出 JSON，结构如下（示例字段，不要输出示例说明文字）：\n' +
        '{"questions":[{"id":"q1","question":"...","mode":"single","required":true,"allowOther":true,"options":[{"id":"a","label":"..."}]}]}',
    },
    design: {
      label: '设计生成',
      scenario:
        '在需求确认后调用。用于基于 requirements + prompt 生成 design.md 草案（overview/flows/considerations），为任务拆解提供依据。',
      variables: ['requirements', 'prompt'],
      system:
        '你是软件设计助手。只输出 JSON，不要解释，不要包含分析或思考过程。',
      user:
        `需求内容如下：\n{{requirements}}\n\n补充描述：{{prompt}}\n\n` +
        '请只输出 JSON，字段：overview（字符串）, flows（字符串数组）, considerations（字符串数组）。不要输出除 JSON 以外的任何内容。',
    },
	    tasks: {
	      label: '任务生成',
	      scenario:
	        '在设计确认后调用。用于将设计草案拆成 tasks.md 的任务列表（模块/流程级别，不要求原子化），并要求每条任务可执行、可验收、无占位符路径。',
	      variables: ['design', 'prompt', 'minTasks', 'maxTasks'],
	      system:
	        '你是项目任务拆解助手。你的输出将作为后续“任务原子化”的输入，并会交付给 AI IDE 执行。只输出 JSON，不要解释。',
	      user:
	        `设计内容如下：\n{{design}}\n\n补充描述：{{prompt}}\n\n` +
	        '请输出 {{minTasks}}-{{maxTasks}} 条任务（不要求原子化）。' +
	        '每条任务必须包含 title/core/details/ac/depends 五个字段，简体中文；严禁输出 TBD/待定/[path]/占位符。\n' +
	        'title 写清任务名称与产出（模块/流程级别即可）。\n' +
	        'core 写清关键目标与范围边界（做什么/不做什么）。\n' +
	        'details 写清关键技术点/接口/数据结构/页面与路由，不要空泛。\n' +
	        'ac 必须可验证：写清验证步骤（命令/接口/页面路径/可观察结果）。\n' +
	        'depends 声明依赖关系：如果本任务依赖其他任务完成后才能执行，填写依赖任务在 JSON 数组中的索引（从 0 开始）。\n' +
	        '   - 示例：depends:[0] 表示依赖第 1 个任务；depends:[0,2] 表示依赖第 1 和第 3 个任务。\n' +
	        '   - 如果任务可以独立执行（无依赖），填写 depends:[]。\n' +
	        '   - 重要：文件写入冲突（多任务操作同一文件）必须串行；API 依赖（调用上一任务创建的接口）必须声明依赖。\n' +
	        '请严格输出 JSON：{"tasks":[{title,core,details,ac,depends}]}。',
	    },
	    atomize: {
	      label: '任务原子化',
	      scenario:
	        '在任务页点击“开始原子化”时调用。用于把 tasks.md 拆成 tasks_atomic.md（单任务单文件、5-10 分钟可完成、包含明确路径/命令/验收），并显式声明依赖以避免冲突。',
	      variables: ['context', 'main', 'reasonBlock'],
	      system:
	        'Role: 硬核工程架构师 (Hardcore Engineering Lead)。你擅长把任务拆解为“原子级执行指令”。只输出 JSON。',
	      user:
	        `{{context}}{{main}}\n\n{{reasonBlock}}` +
	        '要求：\n' +
	        '1) 输出为原子级任务，不要摘要，拆到无法再拆；单条任务建议 5-10 分钟内可完成。\n' +
	        '2) 任务对象字段：title/core/details/ac/depends。\n' +
	        '3) title 必须以"创建/修改/删除 <相对文件路径>"开头，且 <相对文件路径> 必须是动作后的第一个 token（后续说明用"｜"追加）。\n' +
	        '   - depends 声明依赖：填写依赖任务的索引数组，无依赖填 []。文件写入冲突或 API 调用依赖必须声明。\n' +
	        '   - 文件路径必须包含扩展名（.ts/.tsx/.js/.md/.css/.json 等），且必须为最终可用路径。\n' +
	        '   - 绝对禁止使用 TBD/待定/[path]/占位符。\n' +
	        '   - 绝对禁止在 title/core/details/ac 任一字段中出现 TBD/待定/[path]/占位符（需要表达不确定性时，用“待确认点：...”并写入 docs/assumptions.md）。\n' +
	        '   - 若 {{context}} 中包含“项目结构/文件树”，路径必须优先从中选择；若需新建文件，也必须落在合理目录并与现有结构一致。\n' +
	        '4) 一条任务只允许涉及 1 个文件；若需要改多个文件，拆成多条。\n' +
	        '5) core/details 必须具体可执行，包含关键导出名/函数名/接口字段/API 路由/组件 Props/CSS 类名；避免空泛措辞。\n' +
	        '6) 遵循定义先行：先 types/interfaces/schema/DTO，再业务逻辑，再 UI/交互。\n' +
	        '7) ac 必须“机器可验证”，至少包含 1 条可执行的验证方式（命令/接口/页面路径/可观察结果）。\n' +
	        '   - 禁止仅用 rg/grep/搜索 作为唯一验收；必须至少包含 1 条“行为验证”（接口响应/构建或测试通过/页面交互可观察结果）。\n' +
	        '8) 信息不足时：先补 1 条“创建 docs/assumptions.md”记录假设/待确认点（写清缺失信息），再继续拆分。\n' +
	        '9) 简体中文。\n' +
	        '只输出 JSON：{"tasks":[{title,core,details,ac,depends}]}。',
	    },
    reportScore: {
      label: '流程报告评分',
      scenario:
        '在生成 flow report 后调用。用于从 requirements/design/tasks/tasks_atomic 快照中评审原子任务质量并打分，同时输出可直接作为下一轮生成约束的 suggestions。',
      variables: [
        'specName',
        'prompt',
        'requirements',
        'design',
        'tasks',
        'tasksAtomic',
      ],
      system:
        '你是项目经理 + 资深工程评审。你将对 planA 的“任务拆解质量（尤其 tasks_atomic.md）”打分。只输出 JSON，不要解释。',
      user:
        `Spec：{{specName}}\n` +
        `原始需求：{{prompt}}\n\n` +
        '以下是该需求的核心文档快照：\n\n' +
        '【requirements.md】\n{{requirements}}\n\n' +
        '【design.md】\n{{design}}\n\n' +
        '【tasks.md】\n{{tasks}}\n\n' +
        '【tasks_atomic.md】\n{{tasksAtomic}}\n\n' +
        '请按“任务可执行性与可验收性”评审并评分（0-100）。评分维度建议：\n' +
        '1) 覆盖度：是否覆盖需求与关键边界\n' +
	        '2) 原子性：单任务是否 15 分钟内可完成，是否拆到无法再拆\n' +
	        '3) 具体性：是否包含明确文件路径/函数名/变量名/命令/验证步骤\n' +
	        '4) 顺序合理：是否遵循定义先行，先 types/schema 再逻辑\n' +
	        '5) 验收清晰：AC 是否可复现、可证明（最好可用 CLI/接口/页面操作验证）\n' +
	        '6) 路径精确：是否存在 TBD/待定/[path]/占位符路径（出现则应显著扣分）\n' +
	        '7) 可改进性：suggestions 是否足够具体，能直接转化为下一轮生成约束\n\n' +
	        '请严格只输出 JSON，字段必须包含：\n' +
	        '- score：0-100 的整数\n' +
	        '- summary：一句话总评\n' +
	        '- strengths：3-8 条字符串数组\n' +
        '- weaknesses：3-8 条字符串数组\n' +
        '- suggestions：3-10 条字符串数组（每条以“必须/禁止/确保”开头，可直接作为下一轮约束）\n',
    },
    mvp5Plan: {
      label: 'MVP5 执行方案生成',
      scenario:
        '在 MVP5 智能任务编排中调用。输入为 DAG（任务/依赖/风险/交互）摘要，输出为可落地的执行方案：并发 <= 8、禁止一任务一终端、按 worker 池复用，并给出默认 CLI 与必要 overrides。',
      variables: ['specId', 'maxCliConcurrency', 'cliAvailability', 'tasks', 'dependencies', 'summary'],
      system:
        '你是资深“任务编排 / 执行计划”专家。目标：给出可落地的 CLI 执行方案（并发受限、避免一任务一终端）。只输出 JSON，不要解释，不要包含分析或思考过程。',
      user:
        `SpecId：{{specId}}\n` +
        `并发硬上限：{{maxCliConcurrency}}（必须 <= 8）\n` +
        `可用 CLI：{{cliAvailability}}\n\n` +
        '任务清单（id｜title｜risk｜interaction）：\n' +
        '{{tasks}}\n\n' +
        '已识别依赖（from -> to｜type｜strength）：\n' +
        '{{dependencies}}\n\n' +
        '摘要：{{summary}}\n\n' +
        '请严格只输出 JSON，必须包含字段：\n' +
        '- maxCliConcurrency：整数 1-8，且必须 <= 并发硬上限（建议值）\n' +
        '- defaultCli：\"codex\" 或 \"claude\"（默认分配）\n' +
        '- cliOverrides：对象，key 为 taskId，value 为 \"codex\" 或 \"claude\"（只写与 defaultCli 不同的任务）\n' +
        '- rationale：一句话说明方案（简体中文）\n' +
        '要求：\n' +
        '- 禁止输出“每个任务一个 CLI/终端”的方案；必须假设用固定数量 worker 池复用（上限 = maxCliConcurrency）\n' +
        '- 若任务包含人工交互/高风险操作，建议降低并发并在 rationale 中点明\n',
    },
  },
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyPromptTemplate(template, vars = {}) {
  const raw = typeof template === 'string' ? template : '';
  return raw.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return '';
    const value = vars[key];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}

function normalizePromptConfig(input) {
  const defaults = cloneJson(DEFAULT_PROMPT_CONFIG);
  const raw = input && typeof input === 'object' ? input : {};
  const rawStages = raw?.stages && typeof raw.stages === 'object' ? raw.stages : {};
  const rawMeta = raw?.meta && typeof raw.meta === 'object' ? raw.meta : {};

  const meta = {
    projectOverview:
      typeof rawMeta.projectOverview === 'string'
        ? rawMeta.projectOverview.slice(0, 20000)
        : defaults?.meta?.projectOverview || '',
  };

  const stages = {};
  for (const key of PROMPT_STAGE_KEYS) {
    const fallback = defaults.stages[key];
    const candidate =
      rawStages && rawStages[key] && typeof rawStages[key] === 'object'
        ? rawStages[key]
        : {};
    stages[key] = {
      label:
        typeof candidate.label === 'string' && candidate.label.trim()
          ? candidate.label.trim()
          : fallback.label,
      scenario:
        typeof candidate.scenario === 'string'
          ? candidate.scenario.slice(0, 20000)
          : (fallback.scenario || ''),
      variables: Array.isArray(candidate.variables)
        ? candidate.variables.map((v) => String(v)).filter(Boolean)
        : fallback.variables,
      system: typeof candidate.system === 'string' ? candidate.system : fallback.system,
      user: typeof candidate.user === 'string' ? candidate.user : fallback.user,
    };
  }

  const updatedAt =
    typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : null;

  return {
    version: defaults.version,
    updatedAt,
    meta,
    stages,
  };
}

function migratePromptConfig(normalized) {
  const defaults = cloneJson(DEFAULT_PROMPT_CONFIG);
  const current = normalized && typeof normalized === 'object' ? normalized : normalizePromptConfig({});
  const next = cloneJson(current);
  let changed = false;

  if (!next.meta || typeof next.meta !== 'object') {
    next.meta = cloneJson(defaults.meta || { projectOverview: '' });
    changed = true;
  } else if (typeof next.meta.projectOverview !== 'string') {
    next.meta.projectOverview = String(defaults?.meta?.projectOverview || '');
    changed = true;
  }

  for (const key of PROMPT_STAGE_KEYS) {
    if (!next?.stages?.[key] || typeof next.stages[key] !== 'object') continue;
    if (typeof next.stages[key].scenario !== 'string' || !next.stages[key].scenario.trim()) {
      next.stages[key].scenario = String(defaults?.stages?.[key]?.scenario || '');
      changed = true;
    }
  }

  // Ensure requirements stage can consume clarification answers.
  const reqStage = next?.stages?.requirements && typeof next.stages.requirements === 'object'
    ? next.stages.requirements
    : null;
  if (reqStage) {
    const vars = Array.isArray(reqStage.variables) ? reqStage.variables.map((v) => String(v)) : [];
    if (!vars.includes('clarificationsSummary')) {
      reqStage.variables = Array.from(new Set([...vars, 'clarificationsSummary'])).filter(Boolean);
      changed = true;
    }
    const user = typeof reqStage.user === 'string' ? reqStage.user : '';
    if (user && !user.includes('{{clarificationsSummary}}')) {
      const injection = `\n\n需求澄清结论（来自用户回答，可能为空）：\n{{clarificationsSummary}}\n\n`;
      if (user.includes('请只输出 JSON')) {
        reqStage.user = user.replace('请只输出 JSON', `${injection}请只输出 JSON`);
      } else {
        reqStage.user = `${user}${injection}`;
      }
      changed = true;
    }
  }

  const atomizeUser = next?.stages?.atomize?.user;
  if (typeof atomizeUser === 'string' && atomizeUser.includes('路径不确定用 TBD')) {
    next.stages.atomize.user = defaults.stages.atomize.user;
    changed = true;
  }

  const reportScoreUser = next?.stages?.reportScore?.user;
  if (
    typeof reportScoreUser === 'string' &&
    reportScoreUser.includes('评分维度') &&
    !reportScoreUser.includes('每条以“必须/禁止/确保”开头')
  ) {
    next.stages.reportScore.user = defaults.stages.reportScore.user;
    changed = true;
  }

  return { changed, config: next };
}

function loadPromptDefaultsRaw() {
  if (fs.existsSync(PROMPT_CONFIG_DEFAULTS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROMPT_CONFIG_DEFAULTS_FILE, 'utf8'));
    } catch {
      // fall through to embedded defaults
    }
  }
  return cloneJson(DEFAULT_PROMPT_CONFIG);
}

function loadPromptDefaults() {
  return normalizePromptConfig(loadPromptDefaultsRaw());
}

function loadPromptConfig() {
  if (!fs.existsSync(PROMPT_CONFIG_FILE)) {
    // Migrate from legacy location if present.
    if (fs.existsSync(PROMPT_CONFIG_LEGACY_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(PROMPT_CONFIG_LEGACY_FILE, 'utf8'));
        return persistPromptConfig(raw);
      } catch {
        // fall through to defaults
      }
    }
    try {
      return persistPromptConfig(loadPromptDefaultsRaw());
    } catch {
      return loadPromptDefaults();
    }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(PROMPT_CONFIG_FILE, 'utf8'));
    const normalized = normalizePromptConfig(raw);
    const migrated = migratePromptConfig(normalized);

    // If older configs were missing documentation fields, persist the normalized version once.
    let shouldPersist = Boolean(migrated.changed);
    const rawMeta = raw?.meta && typeof raw.meta === 'object' ? raw.meta : null;
    if (!rawMeta || typeof rawMeta.projectOverview !== 'string') {
      shouldPersist = true;
    }
    const rawStages = raw?.stages && typeof raw.stages === 'object' ? raw.stages : null;
    for (const key of PROMPT_STAGE_KEYS) {
      const stage = rawStages && rawStages[key] && typeof rawStages[key] === 'object' ? rawStages[key] : null;
      if (!stage || typeof stage.scenario !== 'string') {
        shouldPersist = true;
        break;
      }
    }

    if (shouldPersist) {
      try {
        return persistPromptConfig(migrated.config);
      } catch {
        // ignore migration write failures
      }
      return normalizePromptConfig(migrated.config);
    }
    return normalized;
  } catch {
    try {
      return persistPromptConfig(loadPromptDefaultsRaw());
    } catch {
      return loadPromptDefaults();
    }
  }
}

function persistPromptConfig(nextConfig) {
  const normalized = normalizePromptConfig(nextConfig);
  const persisted = { ...normalized, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(PROMPT_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(PROMPT_CONFIG_FILE, JSON.stringify(persisted, null, 2), 'utf8');
  return persisted;
}

function loadPromptPresets() {
  if (!fs.existsSync(PROMPT_PRESETS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(PROMPT_PRESETS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function persistPromptPresets(presets) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    PROMPT_PRESETS_FILE,
    JSON.stringify(presets || [], null, 2),
    'utf8',
  );
}

const DEFAULT_CLI_TOOLS_CONFIG = {
  version: 1,
  tools: [
    {
      id: 'codex-cli',
      label: 'Codex CLI',
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'codex'],
      baseUrl: '',
      apiKey: '',
      baseUrlEnvKey: '',
      apiKeyEnvKey: '',
      env: {},
    },
    {
      id: 'claude-code-auto',
      label: 'Claude Code（全自动）',
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'claude', '--dangerously-skip-permissions'],
      baseUrl: '',
      apiKey: '',
      baseUrlEnvKey: '',
      apiKeyEnvKey: '',
      env: {},
    },
  ],
};

function sanitizeEnvVarName(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return '';
  return raw.slice(0, 64);
}

function normalizeCliToolId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return normalized.slice(0, 48);
}

function normalizeCliToolArgs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .slice(0, 40)
    .map((v) => v.slice(0, 240));
}

function normalizeCliToolEnv(value) {
  const obj = value && typeof value === 'object' ? value : null;
  if (!obj) return {};
  const env = {};
  for (const [key, val] of Object.entries(obj)) {
    const envKey = sanitizeEnvVarName(key);
    if (!envKey) continue;
    const envVal = typeof val === 'string' ? val : val == null ? '' : String(val);
    env[envKey] = envVal.slice(0, 2000);
  }
  return env;
}

function normalizeCliToolBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return '';
  } catch {
    return '';
  }
  return raw.slice(0, 400);
}

function normalizeCliToolApiKey(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.slice(0, 4000);
}

function normalizeCliToolInput(input, existing = null) {
  const obj = input && typeof input === 'object' ? input : {};
  const prev = existing && typeof existing === 'object' ? existing : null;

  const label = typeof obj.label === 'string' ? obj.label.trim().slice(0, 60) : prev?.label || '';
  const command =
    typeof obj.command === 'string' ? obj.command.trim().slice(0, 260) : prev?.command || '';
  const args = Object.prototype.hasOwnProperty.call(obj, 'args')
    ? normalizeCliToolArgs(obj.args)
    : prev?.args || [];

  const baseUrl = Object.prototype.hasOwnProperty.call(obj, 'baseUrl')
    ? normalizeCliToolBaseUrl(obj.baseUrl)
    : prev?.baseUrl || '';

  const baseUrlEnvKey = Object.prototype.hasOwnProperty.call(obj, 'baseUrlEnvKey')
    ? sanitizeEnvVarName(obj.baseUrlEnvKey)
    : prev?.baseUrlEnvKey || '';

  const apiKeyEnvKey = Object.prototype.hasOwnProperty.call(obj, 'apiKeyEnvKey')
    ? sanitizeEnvVarName(obj.apiKeyEnvKey)
    : prev?.apiKeyEnvKey || '';

  let apiKey = prev?.apiKey || '';
  if (Object.prototype.hasOwnProperty.call(obj, 'clearApiKey') && obj.clearApiKey === true) {
    apiKey = '';
  } else if (typeof obj.apiKey === 'string' && obj.apiKey.trim()) {
    apiKey = normalizeCliToolApiKey(obj.apiKey);
  }

  const env = Object.prototype.hasOwnProperty.call(obj, 'env')
    ? normalizeCliToolEnv(obj.env)
    : prev?.env || {};

  return {
    id: prev?.id || '',
    label,
    command,
    args,
    baseUrl,
    apiKey,
    baseUrlEnvKey,
    apiKeyEnvKey,
    env,
  };
}

function loadCliToolsConfig() {
  const defaults = cloneJson(DEFAULT_CLI_TOOLS_CONFIG);
  if (!fs.existsSync(CLI_TOOLS_CONFIG_FILE)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(CLI_TOOLS_CONFIG_FILE, 'utf8'));
    const rawTools = Array.isArray(parsed?.tools) ? parsed.tools : [];
    const normalized = rawTools
      .map((t) => (t && typeof t === 'object' ? t : null))
      .filter(Boolean)
      .map((t) => {
        const id = normalizeCliToolId(t.id);
        if (!id) return null;
        return normalizeCliToolInput(t, { id });
      })
      .filter(Boolean);

    // Merge persisted config on top of built-in defaults so Codex/Claude templates
    // remain available for reference.
    const byId = new Map();
    (defaults.tools || []).forEach((tool) => {
      if (tool?.id) byId.set(String(tool.id), tool);
    });
    normalized.forEach((tool) => {
      if (tool?.id) byId.set(String(tool.id), tool);
    });
    const mergedTools = Array.from(byId.values());

    return { ...defaults, ...parsed, tools: mergedTools };
  } catch {
    return defaults;
  }
}

function persistCliToolsConfig(nextConfig) {
  const cfg = nextConfig && typeof nextConfig === 'object' ? nextConfig : {};
  const rawTools = Array.isArray(cfg.tools) ? cfg.tools : [];
  const tools = rawTools
    .map((t) => (t && typeof t === 'object' ? t : null))
    .filter(Boolean)
    .map((t) => {
      const id = normalizeCliToolId(t.id);
      if (!id) return null;
      return normalizeCliToolInput(t, { id });
    })
    .filter(Boolean);
  const next = { ...DEFAULT_CLI_TOOLS_CONFIG, ...cfg, tools, updatedAt: new Date().toISOString() };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CLI_TOOLS_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function toPublicCliTool(tool) {
  const obj = tool && typeof tool === 'object' ? tool : {};
  return {
    id: String(obj.id || ''),
    label: String(obj.label || ''),
    command: String(obj.command || ''),
    args: Array.isArray(obj.args) ? obj.args : [],
    baseUrl: obj.baseUrl ? String(obj.baseUrl) : '',
    baseUrlPresent: Boolean(obj.baseUrl),
    apiKeyPresent: Boolean(obj.apiKey),
    baseUrlEnvKey: obj.baseUrlEnvKey ? String(obj.baseUrlEnvKey) : '',
    apiKeyEnvKey: obj.apiKeyEnvKey ? String(obj.apiKeyEnvKey) : '',
    env: obj.env && typeof obj.env === 'object' ? obj.env : {},
  };
}

function normalizePresetName(name) {
  const normalized = typeof name === 'string' ? name.trim() : '';
  if (!normalized) return '';
  return normalized.slice(0, 48);
}

function loadLocalEnv() {
  const envPath = path.join(ROOT_DIR, 'workflow', 'task', 'mvp2', '.mvp2env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match =
      trimmed.match(/^\$?env:([A-Za-z0-9_]+)\s*=\s*"(.*)"$/) ||
      trimmed.match(/^\$?env:([A-Za-z0-9_]+)\s*=\s*'(.*)'$/) ||
      trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*"(.*)"$/) ||
      trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*'(.*)'$/) ||
      trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!match) return;
    const key = match[1];
    const value = match[2];
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

loadLocalEnv();

function loadPersistedLlmConfig() {
  if (!fs.existsSync(LLM_CONFIG_FILE)) return;
  try {
    const raw = fs.readFileSync(LLM_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    let model = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
    if (model && LLM_MODEL_ALIASES[model]) {
      model = LLM_MODEL_ALIASES[model];
    }
    if (model) process.env.LLM_MODEL = model;

    const providers = parsed?.providers && typeof parsed.providers === 'object' ? parsed.providers : null;
    if (providers) {
      process.env.LLM_PROVIDER_OPENAI_BASE_URL =
        typeof providers?.openai?.baseUrl === 'string' ? providers.openai.baseUrl : '';
      process.env.LLM_PROVIDER_OPENAI_API_KEY =
        typeof providers?.openai?.apiKey === 'string' ? providers.openai.apiKey : '';

      process.env.LLM_PROVIDER_GOOGLE_BASE_URL =
        typeof providers?.google?.baseUrl === 'string' ? providers.google.baseUrl : '';
      process.env.LLM_PROVIDER_GOOGLE_API_KEY =
        typeof providers?.google?.apiKey === 'string' ? providers.google.apiKey : '';

      process.env.LLM_PROVIDER_ANTHROPIC_BASE_URL =
        typeof providers?.anthropic?.baseUrl === 'string' ? providers.anthropic.baseUrl : '';
      process.env.LLM_PROVIDER_ANTHROPIC_API_KEY =
        typeof providers?.anthropic?.apiKey === 'string' ? providers.anthropic.apiKey : '';
    }
  } catch (error) {
    // Ignore malformed local config.
  }
}

function persistLlmConfig(patch) {
  const existing = {};
  if (fs.existsSync(LLM_CONFIG_FILE)) {
    try {
      Object.assign(existing, JSON.parse(fs.readFileSync(LLM_CONFIG_FILE, 'utf8')));
    } catch {
      // ignore
    }
  }
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LLM_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
}

function isSupportedModel(model) {
  return LLM_MODEL_OPTIONS.some((opt) => opt.id === model);
}

function getProviderForModel(model) {
  return LLM_MODEL_OPTIONS.find((opt) => opt.id === model)?.providerId || null;
}

function setLlmModel(model) {
  let normalized = typeof model === 'string' ? model.trim() : '';
  if (!normalized) {
    throw new Error('Model is required');
  }
  if (LLM_MODEL_ALIASES[normalized]) {
    normalized = LLM_MODEL_ALIASES[normalized];
  }
  if (!isSupportedModel(normalized)) {
    throw new Error(`Unsupported model: ${normalized}`);
  }
  process.env.LLM_MODEL = normalized;
  persistLlmConfig({ model: normalized });
  return normalized;
}

loadPersistedLlmConfig();

function getProviderEnv(providerId, kind) {
  const key = `LLM_PROVIDER_${String(providerId || '').toUpperCase()}_${String(kind || '').toUpperCase()}`;
  return (process.env[key] || '').trim();
}

function getLlmConfigForModel(model) {
  const normalizedModel = (model || '').trim();
  const responseFormat = (process.env.LLM_RESPONSE_FORMAT || 'none').trim();
  const providerId = getProviderForModel(normalizedModel);

  const providerBaseUrl = providerId ? getProviderEnv(providerId, 'base_url') : '';
  const providerApiKey = providerId ? getProviderEnv(providerId, 'api_key') : '';

  // Backward compat: allow single env var config as fallback for active provider.
  const fallbackBaseUrl = (process.env.LLM_BASE_URL || '').trim();
  const fallbackApiKey = (process.env.LLM_API_KEY || '').trim();

  const baseUrl = providerBaseUrl || fallbackBaseUrl;
  const apiKey = providerApiKey || fallbackApiKey;

  return { baseUrl, apiKey, model: normalizedModel, providerId, responseFormat };
}

function getActiveLlmConfig() {
  return getLlmConfigForModel((process.env.LLM_MODEL || '').trim());
}

function hasLlmConfig() {
  const { baseUrl, apiKey, model } = getActiveLlmConfig();
  return Boolean(baseUrl && apiKey && model);
}


function describeLlmConfig(config) {
  return {
    baseUrl: String(config?.baseUrl || ''),
    model: String(config?.model || ''),
    providerId: String(config?.providerId || ''),
    responseFormat: String(config?.responseFormat || ''),
  };
}

function assertValidLlmConfig(config) {
  const missing = [];
  if (!config?.baseUrl) missing.push('base_url');
  if (!config?.apiKey) missing.push('api_key');
  if (!config?.model) missing.push('model');
  if (missing.length) {
    const err = new Error(`LLM config missing: ${missing.join(', ')}`);
    err.llmContext = describeLlmConfig(config);
    throw err;
  }
  let parsed;
  try {
    parsed = new URL(String(config.baseUrl));
  } catch (error) {
    const err = new Error(`LLM base_url invalid: ${String(config.baseUrl)}`);
    err.llmContext = describeLlmConfig(config);
    throw err;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    const err = new Error(`LLM base_url invalid protocol: ${parsed.protocol}`);
    err.llmContext = describeLlmConfig(config);
    throw err;
  }
}

function recordSpecError(status, stage, error, extra = null) {
  const now = new Date().toISOString();
  const message = error?.message || String(error || '');
  status.lastError = {
    stage,
    message,
    at: now,
    context: error?.llmContext || null,
    ...(extra || {}),
  };
}

function normalizeLlmUsage(usage) {
  const obj = usage && typeof usage === 'object' ? usage : null;
  if (!obj) return null;
  const toInt = (value) => {
    const num = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(num) ? num : null;
  };
  const promptTokens = toInt(obj.prompt_tokens ?? obj.promptTokens ?? obj.input_tokens ?? obj.inputTokens);
  const completionTokens = toInt(
    obj.completion_tokens ?? obj.completionTokens ?? obj.output_tokens ?? obj.outputTokens,
  );
  const totalTokens = toInt(
    obj.total_tokens ??
      obj.totalTokens ??
      (promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null),
  );
  if (promptTokens == null && completionTokens == null && totalTokens == null) return null;
  return { promptTokens, completionTokens, totalTokens };
}

function isRetryableLlmError(error) {
  const message = String(error?.message || '');
  if (!message) return false;
  if (/LLM response empty/i.test(message)) return true;
  if (/fetch failed/i.test(message)) return true;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)) return true;
  if (/LLM request failed:\s*(429|500|502|503|504)\b/i.test(message)) return true;
  if (/request timeout after/i.test(message)) return true;
  return false;
}

function getLlmRetryLimit() {
  const raw = Number(process.env.LLM_RETRY_LIMIT);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(0, Math.min(3, Math.floor(raw)));
}

function getLlmRetryDelayMs(attemptIndex) {
  const baseRaw = Number(process.env.LLM_RETRY_BASE_MS);
  const base = Number.isFinite(baseRaw) && baseRaw > 0 ? baseRaw : 500;
  const multiplier = Math.max(1, attemptIndex + 1);
  return base * multiplier;
}

async function callLlm(messages, overrideConfig = null, handlers = {}) {
  const activeConfig = getActiveLlmConfig();
  const mergedConfig = overrideConfig ? { ...activeConfig, ...overrideConfig } : activeConfig;
  const { baseUrl, apiKey, model, responseFormat, providerId } = mergedConfig;
  assertValidLlmConfig(mergedConfig);
  const llmContext = describeLlmConfig(mergedConfig);
  const timeoutMsOverride = Number(mergedConfig?.timeoutMs || 0) || null;
  const onUsage = typeof handlers?.onUsage === 'function' ? handlers.onUsage : null;

  const tryOnce = async (rootUrl) => {
    const url = `${String(rootUrl || '').replace(/\/$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timeoutMs = timeoutMsOverride || Number(process.env.LLM_TIMEOUT_MS || 60000);
    let hardTimer = null;
    const hardTimeout = new Promise((_, reject) => {
      hardTimer = setTimeout(() => {
        controller.abort();
        const err = new Error(`LLM request timeout after ${timeoutMs}ms`);
        err.llmContext = llmContext;
        reject(err);
      }, timeoutMs);
    });
    const body = {
      model,
      temperature: 0.3,
      messages,
    };
    if (responseFormat && responseFormat !== 'none' && responseFormat !== 'text') {
      body.response_format = { type: responseFormat };
    }

    const requestPromise = (async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        const message = text ? `${response.status}: ${text}` : `${response.status}`;
        const err = new Error(`LLM request failed: ${message}`);
        err.llmContext = llmContext;
        throw err;
      }
      const data = await response.json();
      onUsage?.(normalizeLlmUsage(data?.usage));
      const content = data?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string') {
        const err = new Error('LLM response empty');
        err.llmContext = llmContext;
        throw err;
      }
      return content.trim();
    })();

    try {
      return await Promise.race([requestPromise, hardTimeout]);
    } catch (error) {
      if (error?.name === 'AbortError') {
        const err = new Error(`LLM request timeout after ${timeoutMs}ms`);
        err.llmContext = llmContext;
        throw err;
      }
      throw error;
    } finally {
      if (hardTimer) clearTimeout(hardTimer);
    }
  };

  const withV1Fallback = async () => {
    // Some gateways require /v1 prefix; retry once if the first attempt fails.
    const trimmed = String(baseUrl || '').replace(/\/$/, '');
    const v1Url = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;

    try {
      return await tryOnce(trimmed);
    } catch (error) {
      if (trimmed === v1Url) {
        throw error;
      }
      try {
        return await tryOnce(v1Url);
      } catch (error2) {
        // Preserve the original error for easier debugging when both fail.
        throw error;
      }
    }
  };

  try {
    return await withV1Fallback();
  } catch (error) {
    console.error('LLM call failed:', error?.message || error, error?.llmContext || llmContext);
    throw error;
  }
}

async function callLlmStream(messages, overrideConfig = null, handlers = {}) {
  const activeConfig = getActiveLlmConfig();
  const mergedConfig = overrideConfig ? { ...activeConfig, ...overrideConfig } : activeConfig;
  const { baseUrl, apiKey, model, responseFormat } = mergedConfig;
  assertValidLlmConfig(mergedConfig);
  const llmContext = describeLlmConfig(mergedConfig);
  const timeoutMsOverride = Number(mergedConfig?.timeoutMs || 0) || null;
  const onToken = typeof handlers?.onToken === 'function' ? handlers.onToken : null;
  const onUsage = typeof handlers?.onUsage === 'function' ? handlers.onUsage : null;

  const readResponseTextStream = async (response, onTextChunk) => {
    const body = response.body;
    if (!body) return;
    const decoder = new TextDecoder();
    if (typeof body.getReader === 'function') {
      const reader = body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) onTextChunk(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) onTextChunk(tail);
      return;
    }
    // Fallback for Node streams / async iterables.
    for await (const chunk of body) {
      if (chunk) onTextChunk(decoder.decode(chunk, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onTextChunk(tail);
  };

  const tryOnce = async (rootUrl) => {
    const url = `${String(rootUrl || '').replace(/\/$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timeoutMs = timeoutMsOverride || Number(process.env.LLM_TIMEOUT_MS || 60000);
    let hardTimer = null;
    const hardTimeout = new Promise((_, reject) => {
      hardTimer = setTimeout(() => {
        controller.abort();
        const err = new Error(`LLM request timeout after ${timeoutMs}ms`);
        err.llmContext = llmContext;
        reject(err);
      }, timeoutMs);
      hardTimer.unref?.();
    });

    const body = {
      model,
      temperature: 0.3,
      messages,
      stream: true,
      stream_options: { include_usage: Boolean(onUsage) },
    };
    if (responseFormat && responseFormat !== 'none' && responseFormat !== 'text') {
      body.response_format = { type: responseFormat };
    }

    const requestPromise = (async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        const message = text ? `${response.status}: ${text}` : `${response.status}`;
        const err = new Error(`LLM request failed: ${message}`);
        err.llmContext = llmContext;
        throw err;
      }

      // Some gateways ignore stream=true and still return a JSON payload.
      const contentType = String(response.headers.get('content-type') || '');
      if (/application\/json/i.test(contentType)) {
        const data = await response.json();
        onUsage?.(normalizeLlmUsage(data?.usage));
        const content = data?.choices?.[0]?.message?.content;
        if (!content || typeof content !== 'string') {
          const err = new Error('LLM response empty');
          err.llmContext = llmContext;
          throw err;
        }
        onToken?.(content);
        return content.trim();
      }

      let buffer = '';
      let full = '';
      const emitDelta = (delta) => {
        if (typeof delta !== 'string' || !delta) return;
        full += delta;
        onToken?.(delta);
      };

      await readResponseTextStream(response, (chunk) => {
        buffer += chunk;
        // Parse SSE line-by-line. We only care about `data:` lines.
        while (true) {
          const idx = buffer.indexOf('\n');
          if (idx < 0) break;
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (!trimmed.startsWith('data:')) continue;
          const dataText = trimmed.slice('data:'.length).trim();
          if (!dataText) continue;
          if (dataText === '[DONE]') return;
          let payload;
          try {
            payload = JSON.parse(dataText);
          } catch {
            continue;
          }
          if (payload?.usage) {
            onUsage?.(normalizeLlmUsage(payload.usage));
          }
          const delta =
            payload?.choices?.[0]?.delta?.content ??
            payload?.choices?.[0]?.delta?.text ??
            payload?.choices?.[0]?.text;
          emitDelta(delta);
        }
      });

      if (!full.trim()) {
        const err = new Error('LLM response empty');
        err.llmContext = llmContext;
        throw err;
      }
      return full.trim();
    })();

    try {
      return await Promise.race([requestPromise, hardTimeout]);
    } catch (error) {
      if (error?.name === 'AbortError') {
        const err = new Error(`LLM request timeout after ${timeoutMs}ms`);
        err.llmContext = llmContext;
        throw err;
      }
      throw error;
    } finally {
      if (hardTimer) clearTimeout(hardTimer);
    }
  };

  const withV1Fallback = async () => {
    const trimmed = String(baseUrl || '').replace(/\/$/, '');
    const v1Url = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
    try {
      return await tryOnce(trimmed);
    } catch (error) {
      if (trimmed === v1Url) throw error;
      try {
        return await tryOnce(v1Url);
      } catch {
        throw error;
      }
    }
  };

  const retryLimit = getLlmRetryLimit();
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      return await withV1Fallback();
    } catch (error) {
      const canRetry = attempt < retryLimit && isRetryableLlmError(error);
      if (!canRetry) {
        console.error('LLM call failed:', error?.message || error, error?.llmContext || llmContext);
        throw error;
      }
      const delayMs = getLlmRetryDelayMs(attempt);
      console.warn(
        `[llm] retry ${attempt + 1}/${retryLimit} after ${delayMs}ms: ${error?.message || error}`,
        error?.llmContext || llmContext,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const unreachable = new Error('LLM call retry loop exhausted');
  unreachable.llmContext = llmContext;
  throw unreachable;
}

function isNdjsonStreamRequest(req) {
  const value = req?.query?.stream;
  if (value === '1' || value === 1 || value === true) return true;
  const header = String(req?.headers?.['x-stream'] || '').trim();
  return header === '1' || header.toLowerCase() === 'true';
}

function createNdjsonStream(res) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let ended = false;
  const write = (payload) => {
    if (ended || res.writableEnded) return;
    try {
      res.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Ignore serialization errors to keep the stream alive.
    }
  };
  const end = () => {
    if (ended || res.writableEnded) return;
    ended = true;
    res.end();
  };
  return { write, end };
}

function sanitizeSpecName(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.endsWith('.')) return null;
  if (/[<>:"/\\|?*\u0000-\u001F]/.test(trimmed)) return null;
  const reservedNames = new Set([
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  ]);
  if (reservedNames.has(trimmed.toUpperCase())) return null;
  return trimmed;
}

function resolveSpecDir(name) {
  return path.join(SPEC_ROOT, name);
}

function resolveSpecFile(name, artifact) {
  return path.join(resolveSpecDir(name), `${artifact}.md`);
}

function resolveSpecStatusFile(name) {
  return path.join(resolveSpecDir(name), 'status.json');
}

function readSpecStatus(name) {
  const filePath = resolveSpecStatusFile(name);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_SPEC_STATUS };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SPEC_STATUS, ...parsed };
  } catch (error) {
    return { ...DEFAULT_SPEC_STATUS };
  }
}

function writeSpecStatus(name, status) {
  fs.mkdirSync(resolveSpecDir(name), { recursive: true });
  fs.writeFileSync(
    resolveSpecStatusFile(name),
    JSON.stringify(status, null, 2),
    'utf8',
  );
}

function ensureSpecStatus(name, overrides = null) {
  const filePath = resolveSpecStatusFile(name);
  if (!fs.existsSync(filePath)) {
    writeSpecStatus(name, { ...DEFAULT_SPEC_STATUS, ...(overrides || {}) });
  }
}

function writeSpecFile(name, artifact, content) {
  fs.mkdirSync(resolveSpecDir(name), { recursive: true });
  fs.writeFileSync(resolveSpecFile(name, artifact), content, 'utf8');
}

function normalizeFlowReportMeta(input) {
  const obj = input && typeof input === 'object' ? input : {};
  const activeRunId =
    typeof obj.activeRunId === 'string' && obj.activeRunId.trim()
      ? obj.activeRunId.trim()
      : null;
  const history = Array.isArray(obj.history)
    ? obj.history.filter((item) => item && typeof item === 'object')
    : [];
  return { activeRunId, history };
}

function resolveFlowRunDir(specName) {
  return path.join(resolveSpecDir(specName), 'flow-runs');
}

function resolveFlowRunFile(specName, runId) {
  return path.join(resolveFlowRunDir(specName), `${runId}.json`);
}

function readFlowRun(specName, runId) {
  if (!runId) return null;
  const filePath = resolveFlowRunFile(specName, runId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (String(parsed.runId || '') !== String(runId)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeFlowRun(specName, run) {
  if (!run || typeof run !== 'object') return;
  const runId = String(run.runId || '').trim();
  if (!runId) return;
  const dir = resolveFlowRunDir(specName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolveFlowRunFile(specName, runId), JSON.stringify(run, null, 2), 'utf8');
}

function createFlowRun(specName, status, reason = '') {
  const now = new Date().toISOString();
  const runId = `${formatTimestamp(new Date())}-${nanoid(6)}`;
  const run = {
    runId,
    specName,
    prompt: String(status?.prompt || ''),
    createdAt: now,
    updatedAt: now,
    reason: String(reason || ''),
    stages: {},
    ratings: { updatedAt: null, byModel: {} },
    userRatings: [],
    artifacts: null,
    report: null,
  };
  writeFlowRun(specName, run);
  return run;
}

function ensureActiveFlowRun(specName, status, options = {}) {
  const normalizedStatus = { ...DEFAULT_SPEC_STATUS, ...(status || {}) };
  const flowReport = normalizeFlowReportMeta(normalizedStatus.flowReport);
  const forceNew = options?.forceNew === true;
  const reason = String(options?.reason || '');

  if (!forceNew && flowReport.activeRunId) {
    const existing = readFlowRun(specName, flowReport.activeRunId);
    if (existing) {
      return { status: { ...normalizedStatus, flowReport }, run: existing };
    }
  }

  const run = createFlowRun(specName, normalizedStatus, reason);
  const nextStatus = {
    ...normalizedStatus,
    flowReport: {
      ...flowReport,
      activeRunId: run.runId,
    },
  };
  writeSpecStatus(specName, nextStatus);
  return { status: nextStatus, run };
}

function appendFlowRunStageAttempt(specName, stageKey, attempt, options = {}) {
  const key = String(stageKey || '').trim();
  if (!key) return null;
  const status = readSpecStatus(specName);
  const { status: nextStatus, run } = ensureActiveFlowRun(specName, status, {
    forceNew: options?.forceNew === true,
    reason: options?.reason || '',
  });
  const now = new Date().toISOString();
  const attemptRecord =
    attempt && typeof attempt === 'object'
      ? { ...attempt }
      : { value: String(attempt || '') };
  if (!attemptRecord.id) attemptRecord.id = nanoid();
  attemptRecord.stageKey = key;
  attemptRecord.recordedAt = now;

  const existingStage =
    run.stages && typeof run.stages === 'object' && run.stages[key]
      ? run.stages[key]
      : {};
  const attempts = Array.isArray(existingStage.attempts) ? existingStage.attempts : [];
  attempts.push(attemptRecord);

  const nextRun = {
    ...run,
    updatedAt: now,
    stages: {
      ...(run.stages && typeof run.stages === 'object' ? run.stages : {}),
      [key]: {
        ...existingStage,
        attempts,
        last: attemptRecord,
      },
    },
  };
  writeFlowRun(specName, nextRun);
  // Persist flowReport in case it was missing.
  if (nextStatus.flowReport?.activeRunId !== run.runId) {
    writeSpecStatus(specName, nextStatus);
  }
  return attemptRecord;
}

function appendFlowRunStageAttemptToRun(specName, runId, stageKey, attempt) {
  const key = String(stageKey || '').trim();
  const id = String(runId || '').trim();
  if (!key || !id) return null;
  const run = readFlowRun(specName, id);
  if (!run) return null;

  const now = new Date().toISOString();
  const attemptRecord =
    attempt && typeof attempt === 'object'
      ? { ...attempt }
      : { value: String(attempt || '') };
  if (!attemptRecord.id) attemptRecord.id = nanoid();
  attemptRecord.stageKey = key;
  attemptRecord.recordedAt = now;

  const existingStage =
    run.stages && typeof run.stages === 'object' && run.stages[key]
      ? run.stages[key]
      : {};
  const attempts = Array.isArray(existingStage.attempts) ? existingStage.attempts : [];
  attempts.push(attemptRecord);

  const nextRun = {
    ...run,
    updatedAt: now,
    stages: {
      ...(run.stages && typeof run.stages === 'object' ? run.stages : {}),
      [key]: {
        ...existingStage,
        attempts,
        last: attemptRecord,
      },
    },
  };
  writeFlowRun(specName, nextRun);
  return attemptRecord;
}

function sanitizeFilenamePart(value, fallback = 'spec') {
  const raw = typeof value === 'string' ? value.trim() : '';
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 80) || fallback;
}

function extractPromptExcerpt(prompt, maxLen = 24) {
  const cleaned = normalizePrompt(prompt).replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).trimEnd();
}

function buildFlowReportFileName(specName, prompt, runId) {
  const safeSpec = sanitizeFilenamePart(specName, 'spec');
  const excerpt = extractPromptExcerpt(prompt, 24);
  const safePrompt = sanitizeFilenamePart(excerpt, safeSpec);
  return `flow_${safePrompt}_${runId}.md`;
}

function formatDurationMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return 'n/a';
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}m${rest.toFixed(0)}s`;
}

function sumUsage(usages) {
  const out = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let hasAny = false;
  for (const u of usages) {
    if (!u || typeof u !== 'object') continue;
    const pt = Number(u.promptTokens);
    const ct = Number(u.completionTokens);
    const tt = Number(u.totalTokens);
    if (Number.isFinite(pt)) out.promptTokens += pt;
    if (Number.isFinite(ct)) out.completionTokens += ct;
    if (Number.isFinite(tt)) out.totalTokens += tt;
    hasAny = true;
  }
  if (!hasAny) return null;
  return out;
}

function renderClarificationQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return '（无）';
  const lines = [];
  questions.forEach((q, idx) => {
    const title = String(q?.question || '').trim() || `问题 ${idx + 1}`;
    lines.push(`${idx + 1}. ${title}`);
    const opts = Array.isArray(q?.options) ? q.options : [];
    if (opts.length) {
      lines.push('   - 选项：');
      opts.forEach((opt) => {
        const label = String(opt?.label || '').trim();
        if (label) lines.push(`     - ${label}`);
      });
    }
    const ans = q?.answer && typeof q.answer === 'object' ? q.answer : null;
    if (ans) {
      const selected = Array.isArray(ans.selectedOptionIds) ? ans.selectedOptionIds : [];
      const other = String(ans.otherText || '').trim();
      const selectedLabels = selected
        .map((id) => opts.find((o) => String(o?.id) === String(id))?.label)
        .filter(Boolean);
      if (selectedLabels.length) {
        lines.push(`   - 已选：${selectedLabels.join(' / ')}`);
      }
      if (other) {
        lines.push(`   - 其他：${other}`);
      }
      if (!selectedLabels.length && !other) {
        lines.push('   - 已选：（未填写）');
      }
    }
  });
  return lines.join('\n');
}

function renderStageAttempts(stage) {
  const attempts = Array.isArray(stage?.attempts) ? stage.attempts : [];
  if (!attempts.length) return '（无记录）';
  const blocks = [];
  for (const attempt of attempts) {
    const startedAt = attempt?.startedAt || null;
    const endedAt = attempt?.endedAt || null;
    const durationMs = attempt?.durationMs ?? null;
    const stream = attempt?.stream === true;
    const llm = attempt?.llmContext || attempt?.llm || null;
    const usage = attempt?.usage || null;
    const header = [
      `- attemptId: ${attempt?.id || ''}`,
      startedAt ? `  - startedAt: ${startedAt}` : null,
      endedAt ? `  - endedAt: ${endedAt}` : null,
      durationMs != null ? `  - duration: ${formatDurationMs(durationMs)}` : null,
      `  - stream: ${stream ? 'true' : 'false'}`,
      llm ? `  - llm: ${JSON.stringify(llm)}` : null,
      usage ? `  - usage: ${JSON.stringify(usage)}` : null,
      attempt?.error ? `  - error: ${JSON.stringify(attempt.error)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    blocks.push(header);

    const prompt = attempt?.prompt && typeof attempt.prompt === 'object' ? attempt.prompt : null;
    if (prompt) {
      if (typeof prompt.templates?.system === 'string') {
        blocks.push(`\n  - prompt.system(template):\n\n\`\`\`text\n${prompt.templates.system}\n\`\`\``);
      }
      if (typeof prompt.templates?.user === 'string') {
        blocks.push(`\n  - prompt.user(template):\n\n\`\`\`text\n${prompt.templates.user}\n\`\`\``);
      }
      if (typeof prompt.rendered?.system === 'string') {
        blocks.push(`\n  - prompt.system(rendered):\n\n\`\`\`text\n${prompt.rendered.system}\n\`\`\``);
      }
      if (typeof prompt.rendered?.user === 'string') {
        blocks.push(`\n  - prompt.user(rendered):\n\n\`\`\`text\n${prompt.rendered.user}\n\`\`\``);
      }
    }
  }
  return blocks.join('\n\n');
}

function buildFlowReportMarkdown(specName, status, run, artifacts) {
  const now = new Date().toISOString();
  const requirements = artifacts?.requirements || '';
  const design = artifacts?.design || '';
  const tasks = artifacts?.tasks || '';

  const projectCategory = normalizeProjectCategoryValue(status?.projectCategory) || 'unknown';
  const projectCategoryMeta =
    status?.projectCategoryMeta && typeof status.projectCategoryMeta === 'object'
      ? status.projectCategoryMeta
      : null;
  const projectCategorySource = projectCategoryMeta?.source ? String(projectCategoryMeta.source) : '';
  const projectCategoryConfidence =
    Number.isFinite(Number(projectCategoryMeta?.confidence)) ? Number(projectCategoryMeta.confidence) : null;
  const projectCategoryReason =
    typeof projectCategoryMeta?.reason === 'string' ? projectCategoryMeta.reason.trim() : '';

  const requirementsReview = status?.requirementsReview || {};
  const requirementsClarifications = status?.requirementsClarifications || {};
  const techStackClarifications = status?.techStackClarifications || {};

  const stages = run?.stages && typeof run.stages === 'object' ? run.stages : {};
  const stageKeys = PROMPT_STAGE_KEYS;

  const modelIds = Array.from(
    new Set(LLM_MODEL_OPTIONS.map((m) => String(m?.id || '')).filter(Boolean)),
  );
  const ratings = run?.ratings && typeof run.ratings === 'object' ? run.ratings : {};
  const byModel =
    ratings?.byModel && typeof ratings.byModel === 'object' ? ratings.byModel : {};
  const scoreTable = (() => {
    const header = ['| 模型 | 分数 | 总评 | 状态 |', '|---|---:|---|---|'];
    const rows = modelIds.map((modelId) => {
      const label =
        LLM_MODEL_OPTIONS.find((m) => String(m?.id || '') === modelId)?.label || modelId;
      const item = byModel?.[modelId] && typeof byModel[modelId] === 'object'
        ? byModel[modelId]
        : null;
      const score = item?.result?.score ?? null;
      const summary = item?.result?.summary ?? '';
      const statusText = item?.ok
        ? 'ok'
        : item?.skipped
          ? 'skipped'
          : item?.error
            ? 'error'
            : '未评分';
      const scoreText =
        typeof score === 'number' && Number.isFinite(score) ? String(score) : '-';
      const summaryText = String(summary || '').replace(/\r?\n/g, ' ').slice(0, 120);
      return `| ${label} | ${scoreText} | ${summaryText || '-'} | ${statusText} |`;
    });
    return [...header, ...rows].join('\n');
  })();

  const userRatings = Array.isArray(run?.userRatings) ? run.userRatings : [];
  const userRatingsText = userRatings.length
    ? userRatings
        .map((r) => {
          const at = r?.createdAt ? String(r.createdAt) : '';
          const score = Number(r?.score);
          const scoreText =
            Number.isFinite(score) && score >= 0 && score <= 100 ? `${score}/100` : 'n/a';
          const comment = String(r?.comment || '').trim();
          return `- ${at || 'unknown'}：${scoreText}${comment ? `｜${comment}` : ''}`;
        })
        .join('\n')
    : '（无）';

  const usageByStage = {};
  const durationByStage = {};
  for (const key of stageKeys) {
    const attempts = Array.isArray(stages?.[key]?.attempts) ? stages[key].attempts : [];
    usageByStage[key] = sumUsage(attempts.map((a) => a?.usage).filter(Boolean));
    const durationMs = attempts
      .map((a) => Number(a?.durationMs))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .reduce((acc, n) => acc + n, 0);
    durationByStage[key] = durationMs || null;
  }

  const totalUsage = sumUsage(Object.values(usageByStage).filter(Boolean));
  const totalDurationMs = Object.values(durationByStage)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .reduce((acc, n) => acc + n, 0);

  return [
    `# planA 流程报告：${specName}`,
    '',
    `- 生成时间：${now}`,
    `- runId：${run?.runId || ''}`,
    `- SpecRoot：${SPEC_ROOT}`,
    `- SpecDir：${resolveSpecDir(specName)}`,
    `- DocsDir：${DOCS_DIR}`,
    '',
    '## 0) 原始需求（prompt）',
    '',
    run?.prompt ? String(run.prompt) : status?.prompt ? String(status.prompt) : '（空）',
    '',
    '### 项目类型识别（projectCategory）',
    '',
    `- projectCategory：${projectCategory}`,
    projectCategorySource ? `- source：${projectCategorySource}` : null,
    projectCategoryConfidence != null ? `- confidence：${projectCategoryConfidence}` : null,
    projectCategoryReason ? `- reason：${projectCategoryReason}` : null,
    '',
    '## 1) 需求确认（requirementsReview）',
    '',
    '```json',
    JSON.stringify(requirementsReview, null, 2),
    '```',
    '',
    '## 2) 需求澄清（requirementsClarifications）',
    '',
    renderClarificationQuestions(requirementsClarifications?.questions),
    '',
    '## 3) 技术栈澄清（techStackClarifications）',
    '',
    renderClarificationQuestions(techStackClarifications?.questions),
    '',
    '## 4) 阶段指标（耗时 / Token / 模型 / 提示词）',
    '',
    `- 总耗时：${totalDurationMs ? formatDurationMs(totalDurationMs) : 'n/a'}`,
    `- 总 Token：${totalUsage ? JSON.stringify(totalUsage) : 'n/a（网关未返回 usage 或未调用模型）'}`,
    '',
    ...stageKeys.flatMap((key) => [
      `### ${key}`,
      '',
      `- 累计耗时：${durationByStage[key] ? formatDurationMs(durationByStage[key]) : 'n/a'}`,
      `- 累计 Token：${usageByStage[key] ? JSON.stringify(usageByStage[key]) : 'n/a'}`,
      '',
      renderStageAttempts(stages?.[key]),
      '',
    ]),
    '## 5) 产物快照',
    '',
    '### requirements.md',
    '',
    '```markdown',
    requirements,
    '```',
    '',
    '### design.md',
    '',
    '```markdown',
    design,
    '```',
    '',
    '### tasks.md',
    '',
    '```markdown',
    tasks,
    '```',
    '',
    '## 6) 报告评分（任务拆解质量，0-100）',
    '',
    '### 模型评分',
    '',
    scoreTable,
    '',
    '### 用户评分记录',
    '',
    userRatingsText,
    '',
  ].join('\n');
}

function readSpecArtifacts(specName) {
  const artifacts = {};
  for (const key of SPEC_ARTIFACTS) {
    const filePath = resolveSpecFile(specName, key);
    artifacts[key] = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  }
  return artifacts;
}

function normalizeFlowRunArtifactsSnapshot(input) {
  const obj = input && typeof input === 'object' ? input : null;
  if (!obj) return null;
  const snapshot = {};
  let hasAny = false;
  for (const key of SPEC_ARTIFACTS) {
    const value = typeof obj[key] === 'string' ? obj[key] : '';
    snapshot[key] = value;
    if (value.trim()) hasAny = true;
  }
  return hasAny ? snapshot : null;
}

function extractArtifactsFromFlowReportMarkdown(markdown) {
  const text = normalizeLineEndings(markdown || '');
  if (!text.trim()) return null;
  const lines = text.split('\n');

  const headerByKey = {
    requirements: 'requirements.md',
    design: 'design.md',
    tasks: 'tasks.md',
  };
  const keyByHeader = Object.fromEntries(Object.entries(headerByKey).map(([k, v]) => [v, k]));

  const out = {};
  let currentKey = null;
  let inFence = false;
  let buffer = [];

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!inFence) {
      const headerMatch = /^###\s+(.+?)\s*$/.exec(trimmed);
      if (headerMatch && headerMatch[1] && keyByHeader[headerMatch[1]]) {
        currentKey = keyByHeader[headerMatch[1]];
        buffer = [];
        continue;
      }
      if (currentKey && /^```/.test(trimmed)) {
        inFence = true;
        buffer = [];
      }
      continue;
    }

    if (/^```/.test(trimmed)) {
      out[currentKey] = buffer.join('\n').replace(/\s+$/g, '');
      currentKey = null;
      inFence = false;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }

  const snapshot = {};
  let hasAny = false;
  for (const key of SPEC_ARTIFACTS) {
    const value = typeof out[key] === 'string' ? out[key] : '';
    snapshot[key] = value;
    if (value.trim()) hasAny = true;
  }
  return hasAny ? snapshot : null;
}

function ensureFlowRunArtifactsSnapshot(specName, run) {
  const existing = normalizeFlowRunArtifactsSnapshot(run?.artifacts);
  if (existing) return { run, artifacts: existing };

  const reportPath =
    run?.report && typeof run.report === 'object' && typeof run.report.path === 'string'
      ? run.report.path.trim()
      : '';
  if (reportPath && fs.existsSync(reportPath)) {
    try {
      const content = fs.readFileSync(reportPath, 'utf8');
      const extracted = extractArtifactsFromFlowReportMarkdown(content);
      if (extracted) {
        const now = new Date().toISOString();
        const updatedRun = { ...run, updatedAt: now, artifacts: extracted };
        writeFlowRun(specName, updatedRun);
        return { run: updatedRun, artifacts: extracted };
      }
    } catch {
      // ignore snapshot failures
    }
  }

  return { run, artifacts: null };
}

function finalizeFlowReport(specName, options = {}) {
  const status = readSpecStatus(specName);
  const flowReport = normalizeFlowReportMeta(status.flowReport);
  const runId = String(options?.runId || flowReport.activeRunId || '').trim();
  if (!runId) return null;

  const run = readFlowRun(specName, runId);
  if (!run) return null;

  if (run.report && typeof run.report === 'object' && run.report.path) {
    ensureFlowRunArtifactsSnapshot(specName, run);
    return run.report.path;
  }

  const artifacts = readSpecArtifacts(specName);

  const markdown = buildFlowReportMarkdown(specName, status, run, artifacts);

  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const fileName = buildFlowReportFileName(specName, status?.prompt || run?.prompt || '', runId);
  const reportPath = path.join(DOCS_DIR, fileName);
  fs.writeFileSync(reportPath, markdown, 'utf8');

  const now = new Date().toISOString();
  const updatedRun = {
    ...run,
    updatedAt: now,
    artifacts,
    report: {
      path: reportPath,
      createdAt: now,
    },
  };
  writeFlowRun(specName, updatedRun);

  const nextHistory = flowReport.history.slice(0, 49);
  nextHistory.unshift({
    runId,
    reportPath,
    createdAt: now,
  });
  const nextStatus = {
    ...status,
    flowReport: {
      ...flowReport,
      activeRunId: null,
      history: nextHistory,
    },
  };
  writeSpecStatus(specName, nextStatus);
  return reportPath;
}

function refreshFlowReport(specName, runId) {
  const id = String(runId || '').trim();
  if (!id) return null;
  const status = readSpecStatus(specName);
  const run = readFlowRun(specName, id);
  if (!run) return null;

  const ensured = ensureFlowRunArtifactsSnapshot(specName, run);
  const artifacts = ensured.artifacts || readSpecArtifacts(specName);

  const markdown = buildFlowReportMarkdown(specName, status, ensured.run, artifacts);

  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const fileName = buildFlowReportFileName(specName, status?.prompt || run?.prompt || '', id);
  const reportPath =
    run.report && typeof run.report === 'object' && typeof run.report.path === 'string' && run.report.path.trim()
      ? run.report.path
      : path.join(DOCS_DIR, fileName);
  fs.writeFileSync(reportPath, markdown, 'utf8');

  const now = new Date().toISOString();
  const updatedRun = {
    ...ensured.run,
    updatedAt: now,
    artifacts: ensured.artifacts || ensured.run?.artifacts || artifacts,
    report: {
      path: reportPath,
      createdAt: run?.report?.createdAt || now,
      updatedAt: now,
    },
  };
  writeFlowRun(specName, updatedRun);
  return reportPath;
}

function sanitizeRunId(runId) {
  if (!runId || typeof runId !== 'string') return null;
  const trimmed = runId.trim();
  if (!trimmed) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.endsWith('.')) return null;
  if (!/^[A-Za-z0-9_-]{6,96}$/.test(trimmed)) return null;
  return trimmed;
}

function getModelLabel(modelId) {
  const key = String(modelId || '').trim();
  if (!key) return '';
  return LLM_MODEL_OPTIONS.find((m) => String(m?.id || '') === key)?.label || key;
}

function listFlowRuns(specName) {
  const dir = resolveFlowRunDir(specName);
  if (!fs.existsSync(dir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = String(entry.name || '');
    if (!name.endsWith('.json')) continue;
    const runId = sanitizeRunId(name.slice(0, -'.json'.length));
    if (!runId) continue;
    const run = readFlowRun(specName, runId);
    if (run) runs.push(run);
  }
  runs.sort((a, b) => {
    const at = Date.parse(String(a?.createdAt || '')) || 0;
    const bt = Date.parse(String(b?.createdAt || '')) || 0;
    return bt - at;
  });
  return runs;
}

function normalizeReportScorePayload(payload) {
  const obj = payload && typeof payload === 'object' ? payload : null;
  if (!obj) return null;
  const rawScore = Number(obj.score);
  if (!Number.isFinite(rawScore)) return null;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const normalizeList = (value, min, max) => {
    const arr = Array.isArray(value) ? value : [];
    const cleaned = arr
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, max);
    if (cleaned.length < min) return [];
    return cleaned;
  };

  const strengths = normalizeList(obj.strengths, 1, 12);
  const weaknesses = normalizeList(obj.weaknesses, 1, 12);
  const suggestions = normalizeList(obj.suggestions, 1, 20);
  return {
    score,
    summary: summary || '（无）',
    strengths,
    weaknesses,
    suggestions,
  };
}

function truncateTextMiddle(text, maxLen = 16000) {
  if (!text) return '';
  const value = String(text);
  if (value.length <= maxLen) return value;
  const headLen = Math.max(2000, Math.floor(maxLen * 0.6));
  const tailLen = Math.max(2000, maxLen - headLen);
  return `${value.slice(0, headLen)}\n\n…(truncated)…\n\n${value.slice(-tailLen)}`;
}

function reportScoreJobKey(specName, runId) {
  return `${String(specName || '').trim()}::${String(runId || '').trim()}`;
}

function logReportScore(job, message) {
  const entry = { at: new Date().toISOString(), message: String(message || '') };
  job.logs.push(entry);
  if (job.logs.length > 200) job.logs.shift();
  job.updatedAt = entry.at;
}

function getReportScoreStatus(job) {
  return {
    running: job.running,
    total: job.total,
    completed: job.completed,
    logs: job.logs,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
  };
}

async function scoreFlowReportWithModel(specName, runId, modelId, context) {
  const status = context?.status;
  const artifacts = context?.artifacts;
  const cfg = getLlmConfigForModel(modelId);
  if (!cfg?.baseUrl || !cfg?.apiKey) {
    return {
      ok: false,
      skipped: true,
      error: { message: 'Missing baseUrl or apiKey', context: describeLlmConfig(cfg) },
      result: null,
      attemptId: null,
    };
  }

  const timeoutMs = Math.min(
    Math.max(8000, Number(process.env.LLM_REPORT_SCORE_TIMEOUT_MS || 60000)),
    120000,
  );

  const promptConfig = loadPromptConfig();
  const stage = promptConfig.stages.reportScore;

  const variables = {
    specName,
    prompt: String(status?.prompt || ''),
    requirements: truncateTextMiddle(artifacts?.requirements || '', 9000),
    design: truncateTextMiddle(artifacts?.design || '', 9000),
    tasks: truncateTextMiddle(artifacts?.tasks || '', 12000),
    tasksAtomic: truncateTextMiddle(artifacts?.tasks_atomic || '', 60000),
  };
  const promptTemplates = { system: stage.system, user: stage.user };
  const promptRendered = {
    system: applyPromptTemplate(stage.system, variables),
    user: applyPromptTemplate(stage.user, variables),
  };
  const messages = [
    { role: 'system', content: promptRendered.system },
    { role: 'user', content: promptRendered.user },
  ];

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let usage = null;

  try {
    const content = await callLlm(messages, { ...cfg, timeoutMs }, {
      onUsage: (u) => {
        usage = u;
      },
    });

    const payload = tryParseJson(content);
    const result = normalizeReportScorePayload(payload);
    if (!result) {
      throw new Error(`LLM reportScore output invalid: ${String(content).slice(0, 240)}`);
    }

    const endedAt = new Date().toISOString();
    const attempt = appendFlowRunStageAttemptToRun(specName, runId, 'reportScore', {
      label: `model:${modelId}`,
      stream: false,
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      usage,
      llmContext: describeLlmConfig(cfg),
      prompt: { templates: promptTemplates, rendered: promptRendered, variables },
      meta: { modelId, providerId: cfg.providerId },
      error: null,
      result,
    });

    return { ok: true, skipped: false, error: null, result, attemptId: attempt?.id || null };
  } catch (error) {
    const endedAt = new Date().toISOString();
    const attempt = appendFlowRunStageAttemptToRun(specName, runId, 'reportScore', {
      label: `model:${modelId}`,
      stream: false,
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      usage,
      llmContext: describeLlmConfig(cfg),
      prompt: { templates: promptTemplates, rendered: promptRendered, variables },
      meta: { modelId, providerId: cfg.providerId },
      error: { message: error?.message || String(error || ''), context: error?.llmContext || null },
    });
    return {
      ok: false,
      skipped: false,
      error: { message: error?.message || String(error || ''), context: error?.llmContext || null },
      result: null,
      attemptId: attempt?.id || null,
    };
  }
}

async function runReportScoreJob(specName, runId, job, options = {}) {
  try {
    const id = sanitizeRunId(runId);
    if (!id) throw new Error('Invalid runId');
    const status = readSpecStatus(specName);
    const run = readFlowRun(specName, id);
    if (!run) throw new Error('Flow run not found');

    const ensured = ensureFlowRunArtifactsSnapshot(specName, run);
    const artifacts = ensured.artifacts || readSpecArtifacts(specName);
    const statusForScore = {
      ...status,
      prompt: String(run?.prompt || status?.prompt || ''),
    };

    const modelIds = Array.from(
      new Set(LLM_MODEL_OPTIONS.map((m) => String(m?.id || '')).filter(Boolean)),
    );
    job.total = modelIds.length;
    job.completed = 0;
    logReportScore(job, `开始评分：${specName} / ${id}（模型数：${job.total}）`);

    const force = options?.force === true;

    for (const modelId of modelIds) {
      const current = readFlowRun(specName, id);
      const currentRatings =
        current?.ratings && typeof current.ratings === 'object' ? current.ratings : {};
      const currentByModel =
        currentRatings?.byModel && typeof currentRatings.byModel === 'object'
          ? currentRatings.byModel
          : {};
      const existing = currentByModel?.[modelId] && typeof currentByModel[modelId] === 'object'
        ? currentByModel[modelId]
        : null;
      if (!force && existing?.ok && existing?.result?.score != null) {
        logReportScore(job, `跳过已评分模型：${getModelLabel(modelId)}`);
        job.completed += 1;
        continue;
      }

      logReportScore(job, `开始模型评分：${getModelLabel(modelId)}`);
      const verdict = await scoreFlowReportWithModel(specName, id, modelId, {
        status: statusForScore,
        artifacts,
      });

      const now = new Date().toISOString();
      const nextRun = readFlowRun(specName, id) || run;
      const nextRatings =
        nextRun?.ratings && typeof nextRun.ratings === 'object' ? nextRun.ratings : {};
      const nextByModel =
        nextRatings?.byModel && typeof nextRatings.byModel === 'object'
          ? { ...nextRatings.byModel }
          : {};
      nextByModel[modelId] = {
        ok: Boolean(verdict.ok),
        skipped: Boolean(verdict.skipped),
        updatedAt: now,
        attemptId: verdict.attemptId || null,
        result: verdict.result || null,
        error: verdict.error || null,
      };

      writeFlowRun(specName, {
        ...nextRun,
        updatedAt: now,
        ratings: {
          ...nextRatings,
          updatedAt: now,
          byModel: nextByModel,
        },
      });

      if (verdict.ok) {
        logReportScore(job, `完成模型评分：${getModelLabel(modelId)}（${verdict.result.score}/100）`);
      } else if (verdict.skipped) {
        logReportScore(job, `跳过模型：${getModelLabel(modelId)}（未配置）`);
      } else {
        logReportScore(
          job,
          `模型评分失败：${getModelLabel(modelId)}（${truncateText(verdict.error?.message || '', 160)}）`,
        );
      }

      job.completed += 1;
    }

    refreshFlowReport(specName, id);
    logReportScore(job, '评分完成，流程报告已更新');
    job.running = false;
    job.error = null;
  } catch (error) {
    job.running = false;
    job.error = error?.message || String(error);
    logReportScore(job, `评分失败：${job.error}`);
  }
}

function getReportScoreJob(specName, runId) {
  const id = sanitizeRunId(runId);
  if (!id) return null;
  return reportScoreJobs.get(reportScoreJobKey(specName, id)) || null;
}

function startReportScoreJob(specName, runId, options = {}) {
  const id = sanitizeRunId(runId);
  if (!id) return null;
  const key = reportScoreJobKey(specName, id);
  const existing = reportScoreJobs.get(key);
  if (existing && existing.running) return existing;
  const now = new Date().toISOString();
  const job = existing || {
    specName,
    runId: id,
    running: false,
    total: 0,
    completed: 0,
    logs: [],
    error: null,
    startedAt: now,
    updatedAt: now,
  };
  job.running = true;
  job.error = null;
  job.startedAt = now;
  job.updatedAt = now;
  if (options?.resetLogs === true) job.logs = [];
  reportScoreJobs.set(key, job);
  logReportScore(job, '评分任务已启动');
  setImmediate(() => {
    runReportScoreJob(specName, id, job, options);
  });
  return job;
}

function normalizePrompt(prompt) {
  if (typeof prompt !== 'string') return '';
  return prompt.trim();
}

function inferProjectCategoryFromPrompt(prompt) {
  const text = normalizePrompt(prompt);
  if (!text) return 'software';
  const lower = text.toLowerCase();
  let softwareScore = 0;
  let nonSoftwareScore = 0;

  if (/\.(ts|tsx|js|jsx|py|go|java|kt|rs|cs|php|sql|json|ya?ml|toml|md)\b/i.test(text)) {
    softwareScore += 3;
  }
  if (
    /(^|[\\/])(src|frontend|backend|server|client|api|components|pages|routes)([\\/]|$)/i.test(
      text,
    )
  ) {
    softwareScore += 2;
  }
  if (
    /(api|接口|前端|后端|数据库|schema|dto|controller|service|router|路由|组件|页面|登录|注册|权限|rbac|oauth|jwt|部署|docker|k8s|kubernetes|nginx|react|vue|angular|nest|node|spring|django|flask|fastapi|prisma|mysql|postgres|redis)/i.test(
      text,
    )
  ) {
    softwareScore += 2;
  }
  if (/(app|网站|网页|小程序|管理端|后台|客户端|服务端|微服务)/i.test(text)) {
    softwareScore += 1;
  }

  if (
    /(旅行|行程|攻略|婚礼|生日|团建|活动|策划|市场|营销|宣传|文案|海报|ppt|投标|采购|招聘|面试|培训|课程|教学|论文|研究|读书|减肥|健身|饮食|菜谱|装修|家装|施工|合同|法律|财务|审计|报税|sop|制度|流程)/i.test(
      text,
    )
  ) {
    nonSoftwareScore += 2;
  }
  if (/(写一篇|写一份|撰写|总结|复盘|方案|计划书|报告)/i.test(text)) {
    nonSoftwareScore += 1;
  }
  if (lower.includes('ppt')) nonSoftwareScore += 1;

  if (softwareScore >= 2) return 'software';
  if (softwareScore === 0 && nonSoftwareScore >= 2) return 'non_software';
  return 'software';
}

function normalizeProjectCategoryValue(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'software') return 'software';
  if (lower === 'non_software' || lower === 'nonsoftware' || lower === 'non-software') {
    return 'non_software';
  }
  if (/非.*软件/.test(raw)) return 'non_software';
  if (/软件/.test(raw)) return 'software';
  return null;
}

function normalizeProjectCategoryPayload(payload) {
  const obj = payload && typeof payload === 'object' ? payload : null;
  if (!obj) return null;
  const category = normalizeProjectCategoryValue(obj.projectCategory ?? obj.category ?? obj.type);
  if (!category) return null;
  const confidenceRaw = Number(obj.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : null;
  const reason = sanitizeModelText(obj.reason || '', '').trim();
  return { projectCategory: category, confidence, reason };
}

async function inferProjectCategoryFromModel(prompt, options = {}) {
  assertValidLlmConfig(getActiveLlmConfig());
  const promptConfig = loadPromptConfig();
  const stage = promptConfig.stages.projectCategory;
  const timeoutMs = Math.min(Number(process.env.LLM_PROJECT_CATEGORY_TIMEOUT_MS || 15000), 60000);
  const onTelemetry = typeof options?.onTelemetry === 'function' ? options.onTelemetry : null;

  const stageKey = 'projectCategory';
  const variables = { prompt };
  const promptTemplates = { system: stage.system, user: stage.user };
  const promptRendered = {
    system: applyPromptTemplate(stage.system, variables),
    user: applyPromptTemplate(stage.user, variables),
  };
  const messages = [
    { role: 'system', content: promptRendered.system },
    { role: 'user', content: promptRendered.user },
  ];

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let usage = null;
  const recordTelemetry = (error) => {
    const endedAt = new Date().toISOString();
    onTelemetry?.({
      stageKey,
      stream: false,
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      usage,
      llmContext: describeLlmConfig(getActiveLlmConfig()),
      prompt: { templates: promptTemplates, rendered: promptRendered, variables },
      error: error
        ? { message: error?.message || String(error || ''), context: error?.llmContext || null }
        : null,
    });
  };

  try {
    const content = await callLlm(
      messages,
      { timeoutMs },
      {
        onUsage: (u) => {
          usage = u;
        },
      },
    );
    const parsed = tryParseJson(content);
    const normalized = normalizeProjectCategoryPayload(parsed);
    if (!normalized) {
      throw new Error(`LLM projectCategory output invalid: ${String(content).slice(0, 200)}`);
    }
    recordTelemetry(null);
    return normalized;
  } catch (error) {
    recordTelemetry(error);
    throw error;
  }
}

function resolveProjectCategory(status) {
  const raw = status && typeof status === 'object' ? status.projectCategory : null;
  const normalized = typeof raw === 'string' ? raw.trim() : '';
  if (normalized === 'software' || normalized === 'non_software') return normalized;
  return inferProjectCategoryFromPrompt(status?.prompt || '');
}

function isNonSoftwareProject(status) {
  return resolveProjectCategory(status) === 'non_software';
}

function sanitizeReviewText(value, maxLen = 4000) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const cleaned = trimmed.replace(/\u0000/g, '');
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen);
}

function sanitizeOptionLabel(value) {
  return sanitizeReviewText(value, 120);
}

function sanitizeOptionDesc(value) {
  return sanitizeReviewText(value, 240);
}

function sanitizeWikiUrl(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  if (trimmed.length > 400) return '';
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return '';
  return trimmed;
}

function normalizeClarificationOption(input) {
  const label = sanitizeOptionLabel(input?.label);
  if (!label) return null;
  const id =
    typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : nanoid();
  const desc = sanitizeOptionDesc(input?.desc);
  const wiki = sanitizeWikiUrl(input?.wiki);
  const out = { id, label };
  if (desc) out.desc = desc;
  if (wiki) out.wiki = wiki;
  return out;
}

function normalizeClarificationAnswer(input, mode) {
  const selectedOptionIds = Array.isArray(input?.selectedOptionIds)
    ? input.selectedOptionIds.filter((value) => typeof value === 'string' && value.trim()).map((v) => v.trim())
    : [];
  const otherText = sanitizeReviewText(input?.otherText, 2000);
  const unique = Array.from(new Set(selectedOptionIds));
  const normalizedSelected = mode === 'single' ? unique.slice(0, 1) : unique;
  return { selectedOptionIds: normalizedSelected, otherText };
}

function normalizeClarificationQuestion(input) {
  const question = sanitizeReviewText(input?.question, 300);
  if (!question) return null;
  const rawMode = typeof input?.mode === 'string' ? input.mode.trim().toLowerCase() : '';
  const mode =
    rawMode === 'multi' ||
    rawMode === 'multiple' ||
    rawMode === 'multiselect' ||
    rawMode === 'multi-select'
      ? 'multi'
      : rawMode === 'single' || rawMode === 'singleselect' || rawMode === 'single-select'
        ? 'single'
        : 'single';
  const required = typeof input?.required === 'boolean' ? input.required : true;
  const allowOther = typeof input?.allowOther === 'boolean' ? input.allowOther : true;
  const options = Array.isArray(input?.options)
    ? input.options.map(normalizeClarificationOption).filter(Boolean)
    : [];
  const id =
    typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : nanoid();
  const createdAt =
    typeof input?.createdAt === 'string' && input.createdAt.trim()
      ? input.createdAt.trim()
      : new Date().toISOString();
  const answer = normalizeClarificationAnswer(input?.answer, mode);
  return { id, question, mode, required, allowOther, options, answer, createdAt };
}

function normalizeRequirementsClarifications(input) {
  const rawQuestions = Array.isArray(input?.questions) ? input.questions : [];
  const questions = rawQuestions.map(normalizeClarificationQuestion).filter(Boolean);
  const updatedAt =
    typeof input?.updatedAt === 'string' && input.updatedAt.trim()
      ? input.updatedAt.trim()
      : null;
  const confirmedAt =
    typeof input?.confirmedAt === 'string' && input.confirmedAt.trim()
      ? input.confirmedAt.trim()
      : null;
  return { questions, updatedAt, confirmedAt };
}

function normalizeReviewPoint(input) {
  if (!input || typeof input !== 'object') return null;
  const text = sanitizeReviewText(input.text, 1000);
  const note = sanitizeReviewText(input.note, 2000);
  if (!text) return null;

  const start = Number.isFinite(Number(input.start)) ? Number(input.start) : null;
  const end = Number.isFinite(Number(input.end)) ? Number(input.end) : null;
  const normalizedStart = start !== null && start >= 0 ? start : null;
  const normalizedEnd =
    end !== null && end >= 0 && normalizedStart !== null && end >= normalizedStart
      ? end
      : null;

  const checked = typeof input.checked === 'boolean' ? input.checked : false;
  const kind =
    typeof input.kind === 'string' && input.kind.trim() ? input.kind.trim() : null;

  const createdAt =
    typeof input.createdAt === 'string' && input.createdAt.trim()
      ? input.createdAt.trim()
      : new Date().toISOString();

  const id =
    typeof input.id === 'string' && input.id.trim() ? input.id.trim() : nanoid();

  return {
    id,
    start: normalizedStart,
    end: normalizedEnd,
    text,
    note,
    checked,
    kind,
    createdAt,
  };
}

function normalizeRequirementsReview(input) {
  const notes = sanitizeReviewText(input?.notes, 6000);
  const rawPoints = Array.isArray(input?.points) ? input.points : [];
  const points = rawPoints.map(normalizeReviewPoint).filter(Boolean);
  const updatedAt =
    typeof input?.updatedAt === 'string' && input.updatedAt.trim()
      ? input.updatedAt.trim()
      : null;
  const confirmedAt =
    typeof input?.confirmedAt === 'string' && input.confirmedAt.trim()
      ? input.confirmedAt.trim()
      : null;

  return {
    notes,
    points,
    updatedAt,
    confirmedAt,
  };
}

function mergeRequirementsReview(previous, next) {
  const prev = normalizeRequirementsReview(previous || {});
  const incoming = normalizeRequirementsReview(next || {});

  const notes = incoming.notes || prev.notes;
  const points = incoming.points.length ? incoming.points : prev.points;
  const updatedAt = incoming.updatedAt || prev.updatedAt;
  const confirmedAt = incoming.confirmedAt || prev.confirmedAt;

  return { notes, points, updatedAt, confirmedAt };
}

function mergeRequirementsClarifications(previous, next) {
  const prev = normalizeRequirementsClarifications(previous || {});
  const incoming = normalizeRequirementsClarifications(next || {});

  const byId = new Map();
  for (const q of prev.questions) byId.set(q.id, q);
  for (const q of incoming.questions) {
    const existing = byId.get(q.id);
    if (!existing) {
      byId.set(q.id, q);
      continue;
    }
    const answer = normalizeClarificationAnswer(q.answer, q.mode);
    byId.set(q.id, { ...existing, ...q, answer });
  }

  const questions = Array.from(byId.values());
  const updatedAt = incoming.updatedAt || prev.updatedAt;
  const confirmedAt = incoming.confirmedAt || prev.confirmedAt;
  const generatedBy =
    (next && typeof next.generatedBy === 'string' && next.generatedBy) ||
    (previous && typeof previous.generatedBy === 'string' && previous.generatedBy) ||
    null;
  const generationError =
    (next && typeof next.generationError === 'string' && next.generationError) ||
    (previous && typeof previous.generationError === 'string' && previous.generationError) ||
    null;
  return { questions, updatedAt, confirmedAt, generatedBy, generationError };
}

function isQuestionAnswered(question) {
  if (!question) return false;
  if (!question.required) return true;
  const selected = Array.isArray(question.answer?.selectedOptionIds)
    ? question.answer.selectedOptionIds
    : [];
  const other = sanitizeReviewText(question.answer?.otherText, 2000);
  return selected.length > 0 || Boolean(other);
}

function areClarificationsComplete(clarifications) {
  const normalized = normalizeRequirementsClarifications(clarifications || {});
  if (!normalized.questions.length) return false;
  return normalized.questions.every(isQuestionAnswered);
}

function buildClarificationsSummary(clarifications) {
  const normalized = normalizeRequirementsClarifications(clarifications || {});
  if (!normalized.questions.length) return '';
  const lines = normalized.questions.map((q) => {
    const selected = Array.isArray(q.answer?.selectedOptionIds)
      ? q.answer.selectedOptionIds
      : [];
    const selectedLabels = q.options
      .filter((opt) => selected.includes(opt.id))
      .map((opt) => opt.label);
    const other = sanitizeReviewText(q.answer?.otherText, 2000);
    const parts = [];
    if (selectedLabels.length) parts.push(`选择：${selectedLabels.join('、')}`);
    if (other) parts.push(`其他：${other}`);
    return `- ${q.question}${parts.length ? `（${parts.join('；')}）` : ''}`;
  });
  return `需求澄清结论：\n${lines.join('\n')}`.trim();
}

function buildRequirementsClarificationsMarkdown(questions) {
  const normalized = normalizeRequirementsClarifications({ questions });
  if (!normalized.questions.length) return '';
  const lines = [];
  lines.push('## 需求确认', '');
  normalized.questions.forEach((q, idx) => {
    const selectedIds = Array.isArray(q.answer?.selectedOptionIds) ? q.answer.selectedOptionIds : [];
    const selectedLabels = (q.options || [])
      .filter((opt) => selectedIds.includes(opt.id))
      .map((opt) => opt.label)
      .filter(Boolean);
    const otherText = sanitizeReviewText(q.answer?.otherText, 2000);
    lines.push(`### Q${idx + 1}. ${q.question}`);
    lines.push(`- 选择：${selectedLabels.length ? selectedLabels.join('、') : '（未选择）'}`);
    if (q.allowOther) lines.push(`- 补充：${otherText ? otherText : '（无）'}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function upsertRequirementsClarificationsSection(markdown, questions) {
  const section = buildRequirementsClarificationsMarkdown(questions);
  if (!section) return (markdown ?? '').trimEnd();
  const text = markdown ?? '';
  const re = /^## 需求(?:澄清|确认)[\s\S]*?(?=\n## |\n# |$)/m;
  let base = text;
  if (re.test(base)) {
    base = base.replace(re, '').trimEnd();
  }

  const backgroundHeading = /^##\s*背景\s*$/m.exec(base);
  if (backgroundHeading) {
    const insertAt = backgroundHeading.index;
    return `${base.slice(0, insertAt).trimEnd()}\n\n${section}\n\n${base
      .slice(insertAt)
      .trimStart()}`.trimEnd();
  }

  const afterOriginal = /(## 原始需求[\s\S]*?)(\n## |\n# |$)/m.exec(base);
  if (afterOriginal) {
    const insertAt = afterOriginal.index + afterOriginal[1].length;
    return `${base.slice(0, insertAt).trimEnd()}\n\n${section}\n\n${base
      .slice(insertAt)
      .trimStart()}`.trimEnd();
  }
  return `${base.trimEnd()}\n\n${section}\n`.trimEnd();
}

function buildTechStackSummary(clarifications) {
  const normalized = normalizeRequirementsClarifications(clarifications || {});
  if (!normalized.questions.length) return '';
  const lines = normalized.questions.map((q) => {
    const selected = Array.isArray(q.answer?.selectedOptionIds)
      ? q.answer.selectedOptionIds
      : [];
    const selectedLabels = q.options
      .filter((opt) => selected.includes(opt.id))
      .map((opt) => opt.label);
    const other = sanitizeReviewText(q.answer?.otherText, 2000);
    const parts = [];
    if (selectedLabels.length) parts.push(`选择：${selectedLabels.join('、')}`);
    if (other) parts.push(`补充：${other}`);
    return `- ${q.question}${parts.length ? `（${parts.join('；')}）` : ''}`;
  });
  return `技术栈确认结论：\n${lines.join('\n')}`.trim();
}

function buildReviewSummary(review) {
  const normalized = normalizeRequirementsReview(review || {});
  const notes = sanitizeReviewText(normalized.notes, 6000);
  const pointNotes = normalized.points
    .filter((p) => sanitizeReviewText(p.note, 2000))
    .slice(0, 20)
    .map((p) => `- ${p.text}${p.note ? `：${p.note}` : ''}`)
    .join('\n');
  const blocks = [];
  if (notes) blocks.push(`补充说明：\n${notes}`);
  if (pointNotes) blocks.push(`确认点补充：\n${pointNotes}`);
  return blocks.join('\n\n').trim();
}

function normalizeLineEndings(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/\r\n?/g, '\n');
}

function extractBulletsFromSection(markdown, headingRegex) {
  const normalized = normalizeLineEndings(markdown);
  const lines = normalized.split('\n');
  const headerIndex = lines.findIndex((line) => headingRegex.test(line));
  if (headerIndex === -1) return [];
  const items = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    const match = line.match(/^\s*[-*]\s+(.*)$/);
    if (match) {
      const text = sanitizeReviewText(match[1], 1000);
      if (text) items.push(text);
    }
  }
  return items;
}

function extractRequirementsReviewPoints(markdown) {
  const now = new Date().toISOString();
  const storyItems = extractBulletsFromSection(markdown, /^##\s*用户故事\s*$/);
  const acceptanceItems = extractBulletsFromSection(markdown, /^##\s*验收标准/);

  const points = [];
  const seen = new Set();
  for (const text of storyItems) {
    if (seen.has(text)) continue;
    seen.add(text);
    points.push({
      id: nanoid(),
      start: null,
      end: null,
      text,
      note: '',
      checked: false,
      kind: 'story',
      createdAt: now,
    });
  }
  for (const text of acceptanceItems) {
    if (seen.has(text)) continue;
    seen.add(text);
    points.push({
      id: nanoid(),
      start: null,
      end: null,
      text,
      note: '',
      checked: false,
      kind: 'acceptance',
      createdAt: now,
    });
  }
  return points;
}

function ensureRequirementsReviewSeeded(specName, status, requirementsMarkdown) {
  const normalized = { ...DEFAULT_SPEC_STATUS, ...status };
  const currentReview = normalizeRequirementsReview(normalized.requirementsReview || {});
  if (normalized.requirementsConfirmed) return { changed: false, status: normalized };
  if (currentReview.points.length > 0) return { changed: false, status: normalized };

  const points = extractRequirementsReviewPoints(requirementsMarkdown || '');
  if (points.length === 0) return { changed: false, status: normalized };

  const next = {
    ...normalized,
    requirementsReview: {
      ...currentReview,
      points,
      updatedAt: new Date().toISOString(),
    },
  };
  writeSpecStatus(specName, next);
  return { changed: true, status: next };
}

function buildDefaultClarificationQuestions(prompt) {
  const now = new Date().toISOString();
  const normalizedPrompt = normalizePrompt(prompt);

  const isBlog = /博客|blog/i.test(normalizedPrompt);
  const isEcommerce = /电商|商城|购物车|下单|订单|支付|退款|物流/i.test(normalizedPrompt);
  const isWorkflow = /审批|请假|工单|流程|报销|OA|办公/i.test(normalizedPrompt);

  const deliveryQuestion = {
    id: 'delivery',
    question: '你希望交付的最终形态是什么？',
    mode: 'single',
    required: true,
    allowOther: true,
    options: [
      { id: 'web', label: 'Web 网站/后台' },
      { id: 'h5', label: '移动端 H5' },
      { id: 'miniapp', label: '小程序' },
      { id: 'api', label: '仅接口/后端服务' },
      { id: 'prototype', label: '原型/方案优先' },
    ],
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const usersQuestion = {
    id: 'users',
    question: '主要用户角色有哪些？（可多选）',
    mode: 'multi',
    required: true,
    allowOther: true,
    options: [
      { id: 'visitor', label: '访客/未登录用户' },
      { id: 'user', label: '普通用户/员工' },
      { id: 'admin', label: '管理员/运营' },
      { id: 'manager', label: '主管/审批人' },
    ],
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const nonFunctionalQuestion = {
    id: 'nonfunctional',
    question: '更关注哪些非功能要求？（可多选）',
    mode: 'multi',
    required: true,
    allowOther: true,
    options: [
      { id: 'seo', label: 'SEO/可被搜索引擎收录' },
      { id: 'perf', label: '性能/首屏加载速度' },
      { id: 'a11y', label: '可访问性/可读性' },
      { id: 'audit', label: '审计/操作日志' },
      { id: 'mobile', label: '移动端体验' },
    ],
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const questions = [deliveryQuestion];

  if (isBlog) {
    questions.push(
      {
        id: 'theme',
        question: '你期望的页面风格是哪一种？',
        mode: 'single',
        required: true,
        allowOther: true,
        options: [
          { id: 'minimal', label: 'A 极简' },
          { id: 'tech', label: 'B 科技' },
          { id: 'warm', label: 'C 温馨' },
        ],
        answer: { selectedOptionIds: [], otherText: '' },
        createdAt: now,
      },
      {
        id: 'blog-features',
        question: '需要包含哪些内容/阅读功能？（可多选）',
        mode: 'multi',
        required: true,
        allowOther: true,
        options: [
          { id: 'list', label: '文章列表' },
          { id: 'detail', label: '文章详情' },
          { id: 'tags', label: '分类/标签' },
          { id: 'search', label: '搜索' },
          { id: 'toc', label: '目录/阅读进度' },
          { id: 'comment', label: '评论（可选）' },
        ],
        answer: { selectedOptionIds: [], otherText: '' },
        createdAt: now,
      },
      {
        id: 'publish',
        question: '内容来源/发布方式是什么？',
        mode: 'single',
        required: true,
        allowOther: true,
        options: [
          { id: 'md', label: 'Markdown 文件' },
          { id: 'cms', label: '后台管理发布（CMS）' },
          { id: 'static', label: '纯静态页面（先写死内容）' },
        ],
        answer: { selectedOptionIds: [], otherText: '' },
        createdAt: now,
      },
    );
  } else if (isEcommerce) {
    questions.push({
      id: 'ecom-modules',
      question: '需要包含哪些电商模块？（可多选）',
      mode: 'multi',
      required: true,
      allowOther: true,
      options: [
        { id: 'catalog', label: '商品/分类' },
        { id: 'cart', label: '购物车' },
        { id: 'checkout', label: '下单/结算' },
        { id: 'payment', label: '支付/退款' },
        { id: 'shipping', label: '物流/配送' },
        { id: 'promo', label: '优惠券/活动' },
        { id: 'admin', label: '运营后台/订单管理' },
      ],
      answer: { selectedOptionIds: [], otherText: '' },
      createdAt: now,
    });
  } else if (isWorkflow) {
    questions.push(
      {
        id: 'workflow-type',
        question: '这类流程主要是哪一种？',
        mode: 'single',
        required: true,
        allowOther: true,
        options: [
          { id: 'leave', label: '请假' },
          { id: 'expense', label: '报销' },
          { id: 'ticket', label: '工单/问题处理' },
          { id: 'approval', label: '通用审批（可配置）' },
        ],
        answer: { selectedOptionIds: [], otherText: '' },
        createdAt: now,
      },
      {
        id: 'workflow-rules',
        question: '审批规则偏向哪种？',
        mode: 'single',
        required: true,
        allowOther: true,
        options: [
          { id: 'fixed', label: '固定流程（写死节点）' },
          { id: 'byDept', label: '按部门/层级自动路由' },
          { id: 'config', label: '可配置流程（后台配置）' },
        ],
        answer: { selectedOptionIds: [], otherText: '' },
        createdAt: now,
      },
    );
  } else {
    questions.push({
      id: 'core',
      question: '你最想先做成的 3 个核心功能是什么？（可多选）',
      mode: 'multi',
      required: true,
      allowOther: true,
      options: [
        { id: 'auth', label: '登录/注册/权限' },
        { id: 'crud', label: '创建/编辑/删除内容' },
        { id: 'list', label: '列表/详情页' },
        { id: 'search', label: '搜索/筛选' },
        { id: 'notify', label: '通知（站内信/邮件）' },
        { id: 'admin', label: '管理后台' },
      ],
      answer: { selectedOptionIds: [], otherText: '' },
      createdAt: now,
    });
  }

  questions.push(usersQuestion, nonFunctionalQuestion);
  return questions.map(normalizeClarificationQuestion).filter(Boolean);
}

const TECH_STACK_OPTION_META = {
  'frontend:react-vite': {
    desc: '单页应用/管理台常用组合，开发与构建速度快，生态成熟。',
    wiki: 'https://en.wikipedia.org/wiki/React_(software)',
  },
  'frontend:nextjs': {
    desc: 'React 全栈框架，支持 SSR/SSG/路由等，适合官网/内容站/全栈应用。',
    wiki: 'https://en.wikipedia.org/wiki/Next.js',
  },
  'frontend:vue-vite': {
    desc: 'Vue SPA 常用组合，上手快，适合管理台/中小项目。',
    wiki: 'https://en.wikipedia.org/wiki/Vue.js',
  },
  'frontend:vanilla': {
    desc: '无框架，适合简单页面/原型/极简性能场景。',
    wiki: 'https://en.wikipedia.org/wiki/Front-end_web_development',
  },
  'frontend:none': {
    desc: '仅接口/脚本/CLI 等，无 UI。',
    wiki: 'https://en.wikipedia.org/wiki/User_interface',
  },

  'backend:nest': {
    desc: '基于 TypeScript 的企业级 Node 框架（模块/依赖注入），适合中大型后端。',
    wiki: 'https://en.wikipedia.org/wiki/NestJS',
  },
  'backend:express': {
    desc: '轻量 Node Web 框架，灵活、上手快，适合小型 API/原型。',
    wiki: 'https://en.wikipedia.org/wiki/Express.js',
  },
  'backend:fastapi': {
    desc: '高性能 Python API 框架，类型提示友好，适合数据/AI 服务。',
    wiki: 'https://en.wikipedia.org/wiki/FastAPI',
  },
  'backend:spring': {
    desc: 'Java 生态主流后端框架，工程化强，适合企业应用。',
    wiki: 'https://en.wikipedia.org/wiki/Spring_Boot',
  },
  'backend:none': {
    desc: '纯前端/静态站/本地存储等场景，不需要服务端。',
    wiki: 'https://en.wikipedia.org/wiki/Back_end',
  },

  'database:postgres': {
    desc: '关系型数据库，功能完整，适合复杂查询与事务。',
    wiki: 'https://en.wikipedia.org/wiki/PostgreSQL',
  },
  'database:mysql': {
    desc: '关系型数据库，通用、生态广。',
    wiki: 'https://en.wikipedia.org/wiki/MySQL',
  },
  'database:sqlite': {
    desc: '嵌入式数据库，零运维，适合单机/轻量应用。',
    wiki: 'https://en.wikipedia.org/wiki/SQLite',
  },
  'database:mongo': {
    desc: '文档型数据库，schema 灵活，适合 JSON 数据场景。',
    wiki: 'https://en.wikipedia.org/wiki/MongoDB',
  },
  'database:none': {
    desc: '不建库，只用文件/浏览器存储即可。',
    wiki: 'https://en.wikipedia.org/wiki/File_system',
  },

  'auth:jwt': {
    desc: '无状态 Token，适合 API/移动端。',
    wiki: 'https://en.wikipedia.org/wiki/JSON_Web_Token',
  },
  'auth:session': {
    desc: '服务端会话 + Cookie，适合传统 Web。',
    wiki: 'https://en.wikipedia.org/wiki/Session_(computer_science)',
  },
  'auth:oauth': {
    desc: '对接第三方登录/授权（如 Google/GitHub/微信等）。',
    wiki: 'https://en.wikipedia.org/wiki/OAuth',
  },
  'auth:none': {
    desc: '公开访问，无鉴权。',
    wiki: 'https://en.wikipedia.org/wiki/Authentication',
  },

  'deploy:docker': {
    desc: '容器化部署，环境一致性好。',
    wiki: 'https://en.wikipedia.org/wiki/Docker_(software)',
  },
  'deploy:pm2': {
    desc: '进程守护/自动重启，适合单机或简单部署。',
    wiki: 'https://en.wikipedia.org/wiki/PM2_(software)',
  },
  'deploy:serverless': {
    desc: '按需运行、自动伸缩，适合事件驱动/突发流量。',
    wiki: 'https://en.wikipedia.org/wiki/Serverless_computing',
  },
  'deploy:static': {
    desc: '只发布静态资源（HTML/CSS/JS），无需服务器。',
    wiki: 'https://en.wikipedia.org/wiki/Static_web_page',
  },
  'deploy:local': {
    desc: '仅本地运行，无需部署。',
    wiki: 'https://en.wikipedia.org/wiki/Localhost',
  },
};

function applyTechStackOptionMeta(questionId, options) {
  const qid = String(questionId || '').trim();
  const list = Array.isArray(options) ? options : [];
  if (!qid || list.length === 0) return list;
  let changed = false;
  const next = list.map((opt) => {
    if (!opt || typeof opt !== 'object') return opt;
    const id = typeof opt.id === 'string' ? opt.id.trim() : '';
    if (!id) return opt;
    const meta = TECH_STACK_OPTION_META[`${qid}:${id}`];
    if (!meta) return opt;
    const hasDesc = typeof opt.desc === 'string' && opt.desc.trim();
    const hasWiki = typeof opt.wiki === 'string' && opt.wiki.trim();
    if (hasDesc && hasWiki) return opt;
    changed = true;
    return {
      ...opt,
      desc: hasDesc ? opt.desc : meta.desc,
      wiki: hasWiki ? opt.wiki : meta.wiki,
    };
  });
  return changed ? next : list;
}

function enrichTechStackQuestions(questions) {
  const list = Array.isArray(questions) ? questions : [];
  if (list.length === 0) return { changed: false, questions: list };
  let changed = false;
  const next = list.map((q) => {
    if (!q || typeof q !== 'object') return q;
    const qid = typeof q.id === 'string' ? q.id.trim() : '';
    if (!qid) return q;
    const options = Array.isArray(q.options) ? q.options : [];
    const nextOptions = applyTechStackOptionMeta(qid, options);
    if (nextOptions === options) return q;
    changed = true;
    return { ...q, options: nextOptions };
  });
  return { changed, questions: next };
}

function buildDefaultTechStackQuestions(prompt, designMarkdown) {
  const now = new Date().toISOString();
  const normalizedPrompt = normalizePrompt(prompt);
  const normalizedDesign = sanitizeReviewText(designMarkdown, 1200);

  const isFrontendOnly = /不需要后端|无后端|静态站|静态页面/i.test(
    `${normalizedPrompt}\n${normalizedDesign}`,
  );
  const isBackendOnly = /仅接口|只做接口|后端服务|API/i.test(
    `${normalizedPrompt}\n${normalizedDesign}`,
  );

  const frontendQuestion = {
    id: 'frontend',
    question: '前端/客户端技术栈倾向是什么？',
    mode: 'single',
    required: true,
    allowOther: true,
    options: applyTechStackOptionMeta('frontend', [
      { id: 'react-vite', label: 'React + Vite' },
      { id: 'nextjs', label: 'Next.js (React)' },
      { id: 'vue-vite', label: 'Vue + Vite' },
      { id: 'vanilla', label: '纯 HTML/CSS/JS' },
      { id: 'none', label: '不需要前端' },
    ]),
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const backendQuestion = {
    id: 'backend',
    question: '后端技术栈倾向是什么？',
    mode: 'single',
    required: true,
    allowOther: true,
    options: applyTechStackOptionMeta('backend', [
      { id: 'nest', label: 'Node.js + NestJS' },
      { id: 'express', label: 'Node.js + Express' },
      { id: 'fastapi', label: 'Python + FastAPI' },
      { id: 'spring', label: 'Java + Spring Boot' },
      { id: 'none', label: '不需要后端' },
    ]),
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const databaseQuestion = {
    id: 'database',
    question: '数据存储倾向是什么？',
    mode: 'single',
    required: true,
    allowOther: true,
    options: applyTechStackOptionMeta('database', [
      { id: 'postgres', label: 'PostgreSQL' },
      { id: 'mysql', label: 'MySQL' },
      { id: 'sqlite', label: 'SQLite' },
      { id: 'mongo', label: 'MongoDB' },
      { id: 'none', label: '不需要数据库/文件存储即可' },
    ]),
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const authQuestion = {
    id: 'auth',
    question: '登录/鉴权方案倾向是什么？',
    mode: 'single',
    required: true,
    allowOther: true,
    options: applyTechStackOptionMeta('auth', [
      { id: 'jwt', label: 'JWT' },
      { id: 'session', label: 'Session + Cookie' },
      { id: 'oauth', label: 'OAuth2 / 第三方登录' },
      { id: 'none', label: '无登录/公开访问' },
    ]),
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const deployQuestion = {
    id: 'deploy',
    question: '部署方式倾向是什么？',
    mode: 'single',
    required: true,
    allowOther: true,
    options: applyTechStackOptionMeta('deploy', [
      { id: 'docker', label: 'Docker' },
      { id: 'pm2', label: 'PM2/进程守护' },
      { id: 'serverless', label: 'Serverless' },
      { id: 'static', label: '静态托管' },
      { id: 'local', label: '本地运行即可' },
    ]),
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const questions = [];
  if (!isBackendOnly) questions.push(frontendQuestion);
  if (!isFrontendOnly) questions.push(backendQuestion);
  questions.push(databaseQuestion, authQuestion, deployQuestion);
  return questions.map(normalizeClarificationQuestion).filter(Boolean);
}

function stripTechStackKeepOptions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { changed: false, questions: Array.isArray(questions) ? questions : [] };
  }

  const isKeepOption = (opt) => {
    if (!opt || typeof opt !== 'object') return false;
    const id = typeof opt.id === 'string' ? opt.id.trim() : '';
    const label = typeof opt.label === 'string' ? opt.label.trim() : '';
    if (id === 'keep') return true;
    if (!label) return false;
    if (/^(沿用|保持).*(现有|当前|项目)/.test(label)) return true;
    if (/(沿用|保持).*(技术栈)/.test(label)) return true;
    return false;
  };

  let changed = false;
  const next = questions.map((q) => {
    if (!q || typeof q !== 'object') return q;

    const options = Array.isArray(q.options) ? q.options : [];
    const filteredOptions = options.filter((opt) => !isKeepOption(opt));
    const answer =
      q.answer && typeof q.answer === 'object' ? q.answer : { selectedOptionIds: [], otherText: '' };
    const selected = Array.isArray(answer.selectedOptionIds) ? answer.selectedOptionIds : [];
    const allowed = new Set(filteredOptions.map((opt) => opt.id));
    const filteredSelected = selected.filter((id) => allowed.has(id));

    const questionChanged =
      filteredOptions.length !== options.length ||
      filteredSelected.length !== selected.length;
    if (!questionChanged) return q;

    changed = true;
    return {
      ...q,
      options: filteredOptions,
      answer: { ...answer, selectedOptionIds: filteredSelected },
    };
  });

  return { changed, questions: next };
}

function ensureTechStackClarificationsSeeded(specName, status, prompt, designMarkdown) {
  const normalized = { ...DEFAULT_SPEC_STATUS, ...(status || {}) };
  const current = normalizeRequirementsClarifications(
    normalized.techStackClarifications || {},
  );
  if (isNonSoftwareProject(normalized)) {
    if (normalized.techStackConfirmed && current.questions.length === 0) {
      return { changed: false, status: normalized };
    }
    const now = new Date().toISOString();
    const next = {
      ...normalized,
      projectCategory: 'non_software',
      techStackConfirmed: true,
      techStackClarifications: {
        ...current,
        questions: [],
        updatedAt: now,
        confirmedAt: normalized.techStackClarifications?.confirmedAt ?? now,
        generatedBy: normalized.techStackClarifications?.generatedBy ?? 'skip',
        generationError: null,
      },
    };
    writeSpecStatus(specName, next);
    return { changed: true, status: next };
  }
  if (!normalized.requirementsConfirmed) return { changed: false, status: normalized };

  const existingGeneratedBy =
    typeof normalized.techStackClarifications?.generatedBy === 'string'
      ? normalized.techStackClarifications.generatedBy
      : null;
  const existingGenerationError =
    typeof normalized.techStackClarifications?.generationError === 'string'
      ? normalized.techStackClarifications.generationError
      : null;

  if (current.questions.length > 0) {
    const cleaned = stripTechStackKeepOptions(current.questions);
    const enriched = enrichTechStackQuestions(cleaned.questions);
    if (!cleaned.changed && !enriched.changed) return { changed: false, status: normalized };
    const now = new Date().toISOString();
    const next = {
      ...normalized,
      techStackClarifications: {
        ...current,
        questions: enriched.questions,
        updatedAt: now,
        confirmedAt: normalized.techStackClarifications?.confirmedAt ?? null,
        generatedBy: existingGeneratedBy || 'default',
        generationError: existingGenerationError || null,
      },
    };
    writeSpecStatus(specName, next);
    return { changed: true, status: next };
  }

  if (normalized.techStackConfirmed) return { changed: false, status: normalized };

  const questions = buildDefaultTechStackQuestions(prompt, designMarkdown);
  if (questions.length === 0) return { changed: false, status: normalized };
  const cleaned = stripTechStackKeepOptions(questions);
  const enriched = enrichTechStackQuestions(cleaned.questions);

  const now = new Date().toISOString();
  const next = {
    ...normalized,
    techStackClarifications: {
      ...current,
      questions: enriched.questions,
      updatedAt: now,
      confirmedAt: normalized.techStackClarifications?.confirmedAt ?? null,
      generatedBy: 'default',
      generationError: null,
    },
  };
  writeSpecStatus(specName, next);
  return { changed: true, status: next };
}

async function generateClarificationsWithModel(prompt, options = {}) {
  assertValidLlmConfig(getActiveLlmConfig());

  const isBadQuestionText = (text) => {
    if (!text || typeof text !== 'string') return true;
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (/\?{3,}/.test(trimmed) || /？{3,}/.test(trimmed)) return true;
    if (/(请提供|需要补充|原始需求.*完整|无法|不能|不明确|不清楚|缺失)/.test(trimmed)) {
      return true;
    }
    return false;
  };

  const isValidClarifications = (normalized) => {
    if (!normalized || !Array.isArray(normalized.questions)) return false;
    if (normalized.questions.length < 3 || normalized.questions.length > 10) return false;
    return normalized.questions.every((q) => {
      if (isBadQuestionText(q.question)) return false;
      if (!Array.isArray(q.options) || q.options.length < 2) return false;
      return q.options.every((opt) => typeof opt.label === 'string' && opt.label.trim());
    });
  };

  try {
    const promptConfig = loadPromptConfig();
    const stage = promptConfig.stages.requirementsClarifications;
    const onToken = typeof options?.onToken === 'function' ? options.onToken : null;
    const onTelemetry = typeof options?.onTelemetry === 'function' ? options.onTelemetry : null;

    const stageKey = 'requirementsClarifications';
    const variables = { prompt };
    const promptTemplates = { system: stage.system, user: stage.user };
    const promptRendered = {
      system: applyPromptTemplate(stage.system, variables),
      user: applyPromptTemplate(stage.user, variables),
    };
    const messages = [
      { role: 'system', content: promptRendered.system },
      { role: 'user', content: promptRendered.user },
    ];

    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let usage = null;
    const recordTelemetry = (error) => {
      const endedAt = new Date().toISOString();
      onTelemetry?.({
        stageKey,
        stream: Boolean(onToken),
        startedAt,
        endedAt,
        durationMs: Date.now() - startedMs,
        usage,
        llmContext: describeLlmConfig(getActiveLlmConfig()),
        prompt: { templates: promptTemplates, rendered: promptRendered, variables },
        error: error
          ? { message: error?.message || String(error || ''), context: error?.llmContext || null }
          : null,
      });
    };

    try {
      const content = onToken
        ? await callLlmStream(messages, null, {
            onToken,
            onUsage: (u) => {
              usage = u;
            },
          })
        : await callLlm(messages, null, {
            onUsage: (u) => {
              usage = u;
            },
          });

      const payload = tryParseJson(content);
      if (!payload) throw new Error(`LLM output not JSON: ${String(content).slice(0, 200)}`);
      const normalized = normalizeRequirementsClarifications(payload);
      if (!isValidClarifications(normalized)) {
        throw new Error(`LLM questions invalid: ${String(content).slice(0, 200)}`);
      }
      recordTelemetry(null);
      return { questions: normalized.questions, generatedBy: 'llm', generationError: null };
    } catch (error) {
      recordTelemetry(error);
      throw error;
    }
  } catch (error) {
    console.error('Clarifications generation failed:', error?.message || error);
    throw error;
  }
}

function buildDefaultRequirementsClarificationQuestions(prompt) {
  const now = new Date().toISOString();
  const summary = summarizeForTemplate(normalizePrompt(prompt), 24);
  const suffix = summary ? `（围绕：${summary}）` : '';
  return [
    {
      id: 'goal',
      question: `你希望本次交付的目标是什么${suffix}？`,
      mode: 'single',
      required: true,
      allowOther: true,
      options: [
        { id: 'mvp', label: '交付可用 MVP（先跑通核心流程）' },
        { id: 'prod', label: '可上线/可部署版本（稳定性优先）' },
        { id: 'poc', label: '概念验证（PoC）' },
        { id: 'refine', label: '在现有功能上迭代优化' },
      ],
      answer: { selectedOptionIds: [], otherText: '' },
      createdAt: now,
    },
    {
      id: 'users',
      question: '主要用户/角色有哪些？',
      mode: 'multi',
      required: true,
      allowOther: true,
      options: [
        { id: 'admin', label: '管理员/运营' },
        { id: 'employee', label: '员工/内部用户' },
        { id: 'customer', label: '外部用户/客户' },
        { id: 'guest', label: '游客/匿名访问' },
      ],
      answer: { selectedOptionIds: [], otherText: '' },
      createdAt: now,
    },
    {
      id: 'features',
      question: '最关键的 3-5 个功能点是什么？',
      mode: 'multi',
      required: true,
      allowOther: true,
      options: [
        { id: 'auth', label: '登录/鉴权' },
        { id: 'crud', label: '数据管理（增删改查）' },
        { id: 'workflow', label: '流程/审批/状态流转' },
        { id: 'export', label: '导出/报表' },
        { id: 'notify', label: '通知（站内/邮件/短信等）' },
      ],
      answer: { selectedOptionIds: [], otherText: '' },
      createdAt: now,
    },
    {
      id: 'data',
      question: '是否需要持久化数据？',
      mode: 'single',
      required: true,
      allowOther: true,
      options: [
        { id: 'db', label: '需要数据库持久化' },
        { id: 'file', label: '只需文件/本地存储' },
        { id: 'none', label: '不需要持久化（纯展示/计算）' },
        { id: 'unknown', label: '暂不确定' },
      ],
      answer: { selectedOptionIds: [], otherText: '' },
      createdAt: now,
    },
    {
      id: 'integration',
      question: '是否需要对接外部系统/第三方接口？',
      mode: 'single',
      required: true,
      allowOther: true,
      options: [
        { id: 'none', label: '不需要' },
        { id: 'third', label: '需要第三方 API' },
        { id: 'internal', label: '需要对接现有内部系统' },
        { id: 'import', label: '需要导入/同步数据（CSV/Excel/API）' },
      ],
      answer: { selectedOptionIds: [], otherText: '' },
      createdAt: now,
    },
    {
      id: 'boundaries',
      question: '本期明确不做/可延后的内容有哪些？',
      mode: 'multi',
      required: true,
      allowOther: true,
      options: [
        { id: 'payment', label: '支付/计费' },
        { id: 'rbac', label: '复杂权限体系（RBAC/多租户）' },
        { id: 'mobile', label: '移动端/小程序适配' },
        { id: 'bi', label: '复杂报表/大屏可视化' },
      ],
      answer: { selectedOptionIds: [], otherText: '' },
      createdAt: now,
    },
  ];
}

function ensureRequirementsClarificationsSeeded(specName, status, prompt) {
  const normalized = { ...DEFAULT_SPEC_STATUS, ...status };
  const current = normalizeRequirementsClarifications(
    normalized.requirementsClarifications || {},
  );
  if (normalized.requirementsConfirmed) return { changed: false, status: normalized };
  if (current.questions.length > 0) return { changed: false, status: normalized };
  const seed = buildDefaultRequirementsClarificationQuestions(prompt);
  const normalizedSeed = normalizeRequirementsClarifications({ questions: seed });
  if (!normalizedSeed.questions.length) return { changed: false, status: normalized };

  const now = new Date().toISOString();
  const next = {
    ...normalized,
    requirementsClarifications: {
      ...current,
      questions: normalizedSeed.questions,
      updatedAt: now,
      confirmedAt: normalized.requirementsClarifications?.confirmedAt ?? null,
      generatedBy: 'default',
      generationError: null,
    },
  };
  writeSpecStatus(specName, next);
  return { changed: true, status: next };
}

function slugifyPrompt(prompt) {
  const trimmed = normalizePrompt(prompt).toLowerCase();
  const slug = trimmed
    .replace(/[^a-z0-9\s-_]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'spec';
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function generateSpecName(prompt) {
  const slug = slugifyPrompt(prompt).slice(0, 24);
  return `${slug}-${formatTimestamp(new Date())}`;
}

function summarizeForTemplate(text, maxLen = 160) {
  const raw = typeof text === 'string' ? text : '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function generateRequirementsContent(prompt) {
  const summary = normalizePrompt(prompt);
  if (!summary) {
    return SPEC_TEMPLATES.requirements;
  }
  return `# 需求（requirements）\n\n## 背景\n${summary}\n\n## 用户故事\n- 作为用户，我希望能够${summary}，以便获得清晰的内容与体验。\n\n## 验收标准（EARS）\n- WHEN 用户打开页面\n  THE SYSTEM SHALL 展示与“${summary}”一致的内容布局与样式\n- WHEN 用户滚动阅读\n  THE SYSTEM SHALL 保持排版清晰、可读性良好\n`;
}

function generateDesignContent(requirements, prompt) {
  const summary = summarizeForTemplate(
    normalizePrompt(prompt) ||
      extractOriginalRequirement(requirements) ||
      normalizePrompt(requirements),
  );
  if (!summary) {
    return SPEC_TEMPLATES.design;
  }
  return `# 设计（design）\n\n## 架构概览\n- 前端单页（HTML/CSS/JS）实现，重点在内容排版与阅读体验。\n- 页面结构包含：标题区、正文区、作者/日期信息、推荐阅读区。\n\n## 关键流程/时序\n1) 用户访问页面 → 展示文章摘要与正文内容。\n2) 用户滚动阅读 → 目录高亮或返回顶部按钮（可选）。\n3) 用户阅读完成 → 推荐阅读模块展示。\n\n## 实现考虑\n- 针对“${summary}”准备内容模块与配色方案。\n- 响应式布局，兼容移动端阅读。\n- 字体与行高设置以提升阅读舒适度。\n`;
}

function generateTasksContent(design, prompt) {
  const summary = summarizeForTemplate(
    normalizePrompt(prompt) || normalizePrompt(design) || extractOriginalRequirement(design),
    120,
  );
  const tasks = [
    {
      id: 'T1_SCOPE',
      title: '明确范围与验收口径',
      description:
        '基于 requirements/design 明确范围边界、优先级与验收方式，补齐缺失信息，并在 tasks.md 固定可执行的 DAG 输入（TASKS_JSON）。',
      dependencies: [],
      scope: [],
      estimated_complexity: 'Medium',
    },
    {
      id: 'T2_SETUP',
      title: '项目基建与运行链路打通',
      description:
        '完成依赖安装、本地运行/构建链路与基础健康检查，确保后续任务能在可复现环境中推进。',
      dependencies: ['T1_SCOPE'],
      scope: [],
      estimated_complexity: 'Medium',
    },
    {
      id: 'T3_CONTRACT',
      title: '数据模型与接口契约确定',
      description:
        '确定核心数据结构与接口契约（含错误处理/权限边界/边界条件）；必要时先补齐 schema/DTO/类型定义再进入功能实现。',
      dependencies: ['T1_SCOPE'],
      scope: [],
      estimated_complexity: 'Medium',
    },
    {
      id: 'T4_CORE',
      title: summary ? `实现核心功能模块（${summary}）` : '实现核心功能模块',
      description:
        '按 design 的关键流程实现核心功能闭环（包含必要的 API/业务逻辑/页面/交互），并将关键变更与验证方式回写到 tasks.md。',
      dependencies: ['T2_SETUP', 'T3_CONTRACT'],
      scope: [],
      estimated_complexity: 'High',
    },
    {
      id: 'T5_INTEGRATION',
      title: '联调与回归验证',
      description:
        '按验收标准进行联调，补齐异常分支与边界处理，形成可复现验证步骤（命令/接口/页面路径/可观察结果）。',
      dependencies: ['T4_CORE'],
      scope: [],
      estimated_complexity: 'Medium',
    },
    {
      id: 'T6_RELEASE',
      title: '构建与交付物整理',
      description:
        '完成构建/测试/打包并整理运行说明；在回写记录中记录最终验证结果与注意事项。',
      dependencies: ['T5_INTEGRATION'],
      scope: [],
      estimated_complexity: 'Low',
    },
  ];

  const notes = [
    '提示：本次 tasks.md 为兜底任务模板（模型输出不满足质量约束时会降级）。可直接在 TASKS_JSON 内替换/增删为更贴合的任务。',
  ];
  return buildTasksDagMarkdown({ tasks }, { notes });
}

function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  const extractFirstJson = (value) => {
    const src = String(value || '');
    const start = src.search(/[{\[]/);
    if (start < 0) return null;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let i = start; i < src.length; i += 1) {
      const ch = src[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        stack.push('}');
        continue;
      }
      if (ch === '[') {
        stack.push(']');
        continue;
      }
      if (stack.length && ch === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) {
          return src.slice(start, i + 1);
        }
      }
    }
    return null;
  };

  // Handle fenced JSON blocks (common for Gemini/Claude).
  const fenceMatch = trimmed.match(/```[a-zA-Z]*\s*([\s\S]*?)\s*```/);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    try {
      return JSON.parse(inner);
    } catch {
      const extracted = extractFirstJson(inner);
      if (!extracted) {
        // continue with fallback strategies below
      } else {
        try {
          return JSON.parse(extracted);
        } catch {
          // continue with fallback strategies below
        }
      }
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const extracted = extractFirstJson(trimmed);
    if (!extracted) return null;
    try {
      return JSON.parse(extracted);
    } catch {
      return null;
    }
  }
}

function normalizeLines(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(/\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractAcceptanceFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bullets = lines.filter((line) => /^[-*]\s+/.test(line));
  const candidates = bullets.length > 0 ? bullets : lines;
  return candidates
    .map((line) => line.replace(/^[-*]\s+/, ''))
    .filter((line) => /(WHEN\b|当|若|如果)/i.test(line));
}

function sanitizeModelText(value, fallback) {
  if (!value) return fallback;
  let text = String(value);
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/Requesting clarification/i.test(line) &&
        !/请提供完整的需求描述/.test(line),
    )
    .join('\n')
    .trim();
  if (!text) return fallback;
  if (/\?{3,}/.test(text) || /？{3,}/.test(text)) return fallback;
  if (/�/.test(text)) return fallback;
  if (!/[a-zA-Z0-9\u4e00-\u9fa5]/.test(text)) return fallback;
  if (
    /(需求描述缺失|需要补充|请提供|无法|不能|不明确|不清楚|缺失)/.test(text)
  ) {
    return fallback;
  }
  return text;
}

function filterAcceptanceLines(lines) {
  return normalizeLines(lines)
    .map((item) => sanitizeModelText(item, ''))
    .filter(
      (item) =>
        item &&
        /^当/.test(item) &&
        /系统应/.test(item) &&
        !/(WHEN\b|THE SYSTEM SHALL)/i.test(item) &&
        !/(需求描述缺失|需要补充|请提供|无法|不能|不明确|不清楚|缺失)/.test(item),
    );
}

function buildRequirementsMarkdown(prompt, payload) {
  const fallbackSummary = normalizePrompt(prompt);
  const rawPrompt = fallbackSummary || '（未提供原始需求）';
  let background = sanitizeModelText(
    payload?.background || payload?.summary || payload?.goal,
    fallbackSummary,
  );
  if (
    /\?{3,}/.test(background) ||
    /？{3,}/.test(background) ||
    /�/.test(background) ||
    !/[a-zA-Z0-9\u4e00-\u9fa5]/.test(background)
  ) {
    background = fallbackSummary;
  }
  const storyFallback = `作为用户，我希望能够${fallbackSummary}，以便获得清晰的内容与体验。`;
  const userStories = normalizeLines(payload?.user_stories || payload?.stories).map((item) =>
    sanitizeModelText(item, storyFallback),
  );
  const acceptance = filterAcceptanceLines(
    payload?.acceptance || payload?.ears || payload?.criteria,
  );
  const acceptanceLines =
    acceptance.length > 0
      ? acceptance
      : [
          '当用户开始使用该功能时，系统应提供清晰的引导与默认配置（可后续调整）。',
          '当用户执行核心操作时，系统应提供可感知的反馈（加载态/提示）。',
          '当发生异常或输入不合法时，系统应给出可理解的错误提示与恢复路径。',
        ];
  const stories =
    userStories.length > 0
      ? userStories
      : [
          `作为用户，我希望能够${fallbackSummary}，以便获得清晰的内容与体验。`,
        ];
  return `# 需求（requirements）\n\n## 原始需求\n${rawPrompt}\n\n## 背景\n${background || ''}\n\n## 用户故事\n${stories
    .map((item) => `- ${item}`)
    .join('\n')}\n\n## 验收标准（EARS）\n${acceptanceLines
    .map((item) => `- ${item}`)
    .join('\n')}\n`;
}

function buildDesignMarkdown(prompt, payload) {
  const fallbackSummary = normalizePrompt(prompt);
  const overview = sanitizeModelText(
    payload?.overview || payload?.architecture || payload?.summary,
    fallbackSummary,
  );
  const flows = normalizeLines(payload?.flows || payload?.sequence || payload?.steps)
    .map((item) => sanitizeModelText(item, ''))
    .filter(Boolean);
  const considerations = normalizeLines(
    payload?.considerations || payload?.notes || payload?.constraints,
  )
    .map((item) => sanitizeModelText(item, ''))
    .filter(Boolean);
  return `# 设计（design）\n\n## 架构概览\n${overview || ''}\n\n## 关键流程/时序\n${(flows.length
    ? flows
    : [
        '用户访问页面 → 展示文章摘要与正文内容。',
        '用户滚动阅读 → 目录高亮或返回顶部按钮（可选）。',
        '用户阅读完成 → 推荐阅读模块展示。',
      ]
  )
    .map((item, index) => `${index + 1}) ${item}`)
    .join('\n')}\n\n## 实现考虑\n${(considerations.length
    ? considerations
    : [
        `针对“${fallbackSummary}”准备内容模块与配色方案。`,
        '响应式布局，兼容移动端阅读。',
        '字体与行高设置以提升阅读舒适度。',
      ]
  )
    .map((item) => `- ${item}`)
    .join('\n')}\n`;
}

function buildTasksMarkdown(prompt, payload) {
  const fallbackSummary = normalizePrompt(prompt);
  const guide = `## AI IDE 使用说明\n- 本文件是“规范驱动开发”的任务总览与回写入口（范围约束 / 验收记录）。\n- 建议任务粒度为模块级/交付物级（≤ 25），避免原子化拆解。\n- 如发现遗漏或范围变化：先更新 tasks.md，再继续推进实现与回写。\n\n## 任务清单`;

  const rawTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const tasks = rawTasks
    .map((t) => (t && typeof t === 'object' ? t : null))
    .filter(Boolean);

  const fallbackList = [
    {
      title: `创建 docs/ai_ide_guide.md｜验证：阅读并确认理解`,
      core: '补全任务拆解与执行记录的基本说明。',
      details: '说明 tasks.md 的用途与使用方式。',
      ac: 'docs/ai_ide_guide.md 存在，且可阅读理解。',
      depends: [],
    },
    {
      title: `创建 docs/project_skeleton.md｜验证：启动并能访问页面`,
      core: `梳理与“${fallbackSummary}”相关的最小可运行骨架。`,
      details: '包含基本路由/页面/启动脚本。',
      ac: '本地能启动并访问关键页面（以项目实际端口/路由为准）。',
      depends: [],
    },
  ];

  const list = tasks.length ? tasks : fallbackList;

  const blocks = list
    .map((t, idx) => {
      const title = sanitizeModelText(t.title || t.task || t.name || '', '').trim();
      const core = sanitizeModelText(t.core || t.logic || t.coreLogic || '', '').trim();
      const details = sanitizeModelText(t.details || t.tech || t.technical || t.techDetails || '', '').trim();
      const ac = sanitizeModelText(t.ac || t.acceptance || t.criteria || '', '').trim();

      const safeTitle = title || `创建 docs/assumptions.md｜补齐 Task ${idx + 1} 缺失字段`;
      const safeCore = core || '记录本任务的核心目标与范围边界（做什么/不做什么）。';
      const safeDetails = details || '补齐关键技术点/接口/数据结构/页面与路由等实现细节。';
      const safeAc =
        ac || '在 docs/assumptions.md 写清可复现的验收步骤（命令/接口/页面路径/可观察结果）。';

      const depends = Array.isArray(t?.depends) ? t.depends : [];
      const depItems = Array.from(new Set(depends))
        .map((n) => (Number.isFinite(Number(n)) ? Math.floor(Number(n)) : -1))
        .filter((n) => n >= 0 && n < list.length && n !== idx)
        .slice(0, 12)
        .map((depIdx) => {
          const depTask = list[depIdx] || {};
          const depTitle = sanitizeModelText(depTask.title || '', '').trim();
          const label = depTitle || `Task ${depIdx + 1}`;
          return `    - ${label}（来自 Task ${depIdx + 1}）`;
        });
      const depsBlock = depItems.length
        ? ['  - **依赖**:', ...depItems].join('\n')
        : '  - **依赖**: 无';

      return [
        `- [ ] **Task ${idx + 1}**: ${safeTitle}`,
        `  - **核心逻辑**: ${safeCore}`,
        `  - **技术细节**: ${safeDetails}`,
        depsBlock,
        `  - **验收准则 (AC)**: ${safeAc}`,
      ].join('\n');
    })
    .join('\n\n');

  return `# 任务（tasks）\n\n${guide}\n\n${blocks}\n`;
}

function buildTasksDagMarkdown(payload, options = {}) {
  const rawTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const notes = Array.isArray(options?.notes)
    ? options.notes.map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const normalized = ensureUniqueDagTaskIds(
    rawTasks.map((t, idx) => normalizeDagTaskObject(t, idx)).filter(Boolean),
  );
  const json = JSON.stringify({ tasks: normalized }, null, 2);
  const noteLines = notes.length ? `${notes.map((n) => `- ${n}\n`).join('')}` : '';
  return (
    `# 任务（tasks）\n\n` +
    `## 说明\n` +
    `- 任务粒度：模块级/交付物级（建议 ≤ 25），不要原子化。\n` +
    `- 编排系统会解析下方 TASKS_JSON 区块生成 DAG，并据此限制并发（≤ 8）调度 CLI worker 池。\n` +
    `- 参考：docs/任务编排.md\n\n` +
    `${noteLines}` +
    `## TASKS_JSON\n` +
    `${json}\n` +
    `## END_TASKS_JSON\n\n` +
    `## 回写记录\n` +
    `- （可选）记录实现进度、关键变更与验证结果。\n`
  );
}

async function generateRequirementsWithModel(prompt, options = {}) {
  assertValidLlmConfig(getActiveLlmConfig());

  const promptConfig = loadPromptConfig();
  const stage = promptConfig.stages.requirements;
  const onToken = typeof options?.onToken === 'function' ? options.onToken : null;
  const onTelemetry = typeof options?.onTelemetry === 'function' ? options.onTelemetry : null;

  const stageKey = 'requirements';
  const clarificationsSummary =
    typeof options?.clarificationsSummary === 'string' ? options.clarificationsSummary : '';
  const variables = { prompt, clarificationsSummary };
  const promptTemplates = { system: stage.system, user: stage.user };
  const promptRendered = {
    system: applyPromptTemplate(stage.system, variables),
    user: applyPromptTemplate(stage.user, variables),
  };
  const messages = [
    { role: 'system', content: promptRendered.system },
    { role: 'user', content: promptRendered.user },
  ];

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let usage = null;
  let content = '';
  const recordTelemetry = (error) => {
    const endedAt = new Date().toISOString();
    onTelemetry?.({
      stageKey,
      stream: Boolean(onToken),
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      usage,
      llmContext: describeLlmConfig(getActiveLlmConfig()),
      prompt: { templates: promptTemplates, rendered: promptRendered, variables },
      error: error
        ? { message: error?.message || String(error || ''), context: error?.llmContext || null }
        : null,
    });
  };

  try {
    content = onToken
      ? await callLlmStream(messages, null, {
          onToken,
          onUsage: (u) => {
            usage = u;
          },
        })
      : await callLlm(messages, null, {
          onUsage: (u) => {
            usage = u;
          },
        });

    const payload = tryParseJson(content);
    if (!payload) {
      throw new Error(`LLM output not JSON: ${String(content).slice(0, 200)}`);
    }
    if (typeof payload.background !== 'string' || !payload.background.trim()) {
      throw new Error(
        `LLM requirements missing background: ${JSON.stringify(payload).slice(0, 200)}`,
      );
    }
    if (!Array.isArray(payload.user_stories) || payload.user_stories.length === 0) {
      throw new Error(
        `LLM requirements missing user_stories: ${JSON.stringify(payload).slice(0, 200)}`,
      );
    }
    const acceptance = filterAcceptanceLines(payload.acceptance);
    if (!acceptance || acceptance.length === 0) {
      throw new Error(
        `LLM requirements acceptance invalid: ${JSON.stringify(payload).slice(0, 200)}`,
      );
    }
    recordTelemetry(null);
    return buildRequirementsMarkdown(prompt, { ...payload, acceptance });
  } catch (error) {
    recordTelemetry(error);
    throw error;
  }
}

function extractOriginalRequirement(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';
  const match = markdown.match(/## 原始需求\s*([\s\S]*?)(\n## |\n# |$)/);
  if (!match) return '';
  return match[1].trim();
}

function resolveDesignPrompt(prompt, requirements) {
  const cleanedPrompt = sanitizeModelText(prompt, '');
  if (cleanedPrompt) return cleanedPrompt;
  const fromRequirements = sanitizeModelText(extractOriginalRequirement(requirements), '');
  if (fromRequirements) return fromRequirements;
  return normalizePrompt(requirements);
}

async function generateDesignWithModel(requirements, prompt, options = {}) {
  assertValidLlmConfig(getActiveLlmConfig());

  const promptConfig = loadPromptConfig();
  const stage = promptConfig.stages.design;
  const onToken = typeof options?.onToken === 'function' ? options.onToken : null;
  const onTelemetry = typeof options?.onTelemetry === 'function' ? options.onTelemetry : null;

  const stageKey = 'design';
  const variables = { requirements, prompt };
  const promptTemplates = { system: stage.system, user: stage.user };
  const promptRendered = {
    system: applyPromptTemplate(stage.system, variables),
    user: applyPromptTemplate(stage.user, variables),
  };
  const messages = [
    { role: 'system', content: promptRendered.system },
    { role: 'user', content: promptRendered.user },
  ];

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let usage = null;
  const recordTelemetry = (error) => {
    const endedAt = new Date().toISOString();
    onTelemetry?.({
      stageKey,
      stream: Boolean(onToken),
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      usage,
      llmContext: describeLlmConfig(getActiveLlmConfig()),
      prompt: { templates: promptTemplates, rendered: promptRendered, variables },
      error: error
        ? { message: error?.message || String(error || ''), context: error?.llmContext || null }
        : null,
    });
  };

  try {
    const content = onToken
      ? await callLlmStream(messages, null, {
          onToken,
          onUsage: (u) => {
            usage = u;
          },
        })
      : await callLlm(messages, null, {
          onUsage: (u) => {
            usage = u;
          },
        });
    const payload = tryParseJson(content);
    if (!payload) {
      throw new Error(`LLM design output not JSON: ${String(content).slice(0, 200)}`);
    }
    const designPrompt = resolveDesignPrompt(prompt, requirements);
    recordTelemetry(null);
    return buildDesignMarkdown(designPrompt, payload);
  } catch (error) {
    recordTelemetry(error);
    throw error;
  }
}

function looksLikeChinese(text) {
  return /[\u4e00-\u9fa5]/.test(String(text || ''));
}

function normalizeTaskObject(task) {
  const obj = task && typeof task === 'object' ? task : null;
  if (!obj) return null;
  const title = String(obj.title || obj.task || obj.name || '').trim();
  const core = String(obj.core || obj.logic || obj.coreLogic || '').trim();
  const details = String(obj.details || obj.tech || obj.technical || obj.techDetails || '').trim();
  const ac = String(obj.ac || obj.acceptance || obj.criteria || '').trim();
  const dependsRaw = obj.depends ?? obj.dependsOn ?? obj.dependencies ?? null;
  const depends = (() => {
    const out = [];
    const push = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      const idx = Math.floor(n);
      if (idx < 0) return;
      out.push(idx);
    };
    if (Array.isArray(dependsRaw)) {
      dependsRaw.forEach(push);
    } else if (typeof dependsRaw === 'string' && dependsRaw.trim()) {
      dependsRaw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach(push);
    }
    return Array.from(new Set(out)).slice(0, 60);
  })();
  return { title, core, details, ac, depends };
}

function normalizeEstimatedComplexity(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'low') return 'Low';
  if (raw === 'medium' || raw === 'mid') return 'Medium';
  if (raw === 'high') return 'High';
  return 'Medium';
}

function normalizeStringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? '').trim()).filter(Boolean);
  }
  const text = String(value).trim();
  if (!text) return [];
  return text
    .split(/[\r\n,]+/)
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
}

function normalizeDagTaskId(value, index) {
  const raw = String(value ?? '').trim();
  if (raw && /^[A-Za-z0-9_-]+$/.test(raw)) return raw;
  return `T${index + 1}`;
}

function normalizeDagTaskObject(task, index) {
  const obj = task && typeof task === 'object' ? task : null;
  if (!obj) return null;

  const id = normalizeDagTaskId(
    obj.id ?? obj.taskId ?? obj.task_id ?? obj.key ?? obj.name,
    index,
  );
  const title = String(obj.title ?? obj.name ?? '').trim();
  const description = String(obj.description ?? obj.desc ?? obj.contract ?? '').trim();
  const dependencies = normalizeStringList(
    obj.dependencies ?? obj.dependsOn ?? obj.depends_on ?? obj.requires,
  );
  const scope = normalizeStringList(obj.scope ?? obj.paths ?? obj.path);
  const estimated_complexity = normalizeEstimatedComplexity(
    obj.estimated_complexity ?? obj.estimatedComplexity ?? obj.complexity,
  );

  if (!title) return null;

  return {
    id,
    title,
    description,
    dependencies,
    scope,
    estimated_complexity,
  };
}

function ensureUniqueDagTaskIds(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const seen = new Set();
  return list.map((t, idx) => {
    const base = String(t?.id || `T${idx + 1}`).trim() || `T${idx + 1}`;
    let id = base;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${base}_${suffix++}`;
    }
    seen.add(id);
    return id === t.id ? t : { ...t, id };
  });
}

function extractTasksJsonBlockFromMarkdown(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return null;
  const lines = markdown.split(/\r?\n/);
  const findMarker = (marker) =>
    lines.findIndex((line) => String(line || '').trim().toUpperCase() === marker);

  const start = findMarker('## TASKS_JSON');
  if (start < 0) return null;

  let end = lines.length;
  const endIdx = findMarker('## END_TASKS_JSON');
  if (endIdx > start) end = endIdx;

  const blockLines = lines.slice(start + 1, end);
  if (!blockLines.length) return null;

  const trimmedTop = String(blockLines[0] || '').trim();
  const trimmedBottom = String(blockLines[blockLines.length - 1] || '').trim();

  let begin = 0;
  let finish = blockLines.length;
  if (trimmedTop.startsWith('```')) begin += 1;
  if (trimmedBottom.startsWith('```')) finish -= 1;

  const jsonText = blockLines.slice(begin, finish).join('\n').trim();
  return jsonText ? jsonText : null;
}

function parseDagTasksFromTasksContent(tasksContent) {
  const raw = typeof tasksContent === 'string' ? tasksContent.trim() : '';
  if (!raw) return null;

  const direct = tryParseJson(raw);
  if (direct && typeof direct === 'object' && Array.isArray(direct.tasks)) {
    const normalized = ensureUniqueDagTaskIds(
      direct.tasks.map((t, idx) => normalizeDagTaskObject(t, idx)).filter(Boolean),
    );
    return normalized.length ? normalized : null;
  }

  const jsonBlock = extractTasksJsonBlockFromMarkdown(raw);
  if (!jsonBlock) return null;

  const payload = tryParseJson(jsonBlock);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.tasks)) return null;

  const normalized = ensureUniqueDagTaskIds(
    payload.tasks.map((t, idx) => normalizeDagTaskObject(t, idx)).filter(Boolean),
  );
  return normalized.length ? normalized : null;
}

function normalizeScopePathForConflict(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function scopesMayConflict(a, b) {
  const left = normalizeScopePathForConflict(a);
  const right = normalizeScopePathForConflict(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.startsWith(`${right}/`)) return true;
  if (right.startsWith(`${left}/`)) return true;
  return false;
}

function detectDagScopeConflicts(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const warnings = [];
  const edges = [];
  const warnedPairs = new Set();

  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    const aScope = Array.isArray(a?.scope) ? a.scope : [];
    if (!aScope.length) continue;

    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      const bScope = Array.isArray(b?.scope) ? b.scope : [];
      if (!bScope.length) continue;

      let match = null;
      for (const sa of aScope) {
        for (const sb of bScope) {
          if (scopesMayConflict(sa, sb)) {
            match = String(sa || sb || '').trim();
            break;
          }
        }
        if (match) break;
      }

      if (!match) continue;

      const pairKey = `${a.id}::${b.id}`;
      if (!warnedPairs.has(pairKey)) {
        warnedPairs.add(pairKey);
        warnings.push(`scope 可能冲突：${a.id} 与 ${b.id}（例如：${match}）`);
      }
      edges.push({
        from: a.id,
        to: b.id,
        type: 'conflict',
        strength: 'weak',
        description: `scope 可能冲突：${a.id} 与 ${b.id}（例如：${match}）`,
      });
    }
  }

  return { warnings, edges };
}

function truncateText(text, maxLen = 1600) {
  if (!text) return '';
  const value = String(text).trim();
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

const REPO_TREE_CACHE = { updatedAtMs: 0, snapshot: '' };
const REPO_TREE_EXCLUDES = new Set([
  '.codex',
  '.git',
  '.idea',
  '.runlogs',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'logs',
  '.next',
  '.turbo',
  '.cache',
  'specs',
  'task',
]);

function normalizePathForPrompt(value) {
  return String(value || '').replace(/\\/g, '/');
}

function shouldExcludeRepoTreeEntry(name) {
  const entry = String(name || '').trim();
  if (!entry) return true;
  if (entry === '.' || entry === '..') return true;
  if (REPO_TREE_EXCLUDES.has(entry)) return true;
  if (/^tmp_/i.test(entry)) return true;
  if (/^\.env(\..+)?$/i.test(entry)) return true;
  if (/^(llm-config|prompt-config|prompt-presets)\.json$/i.test(entry)) return true;
  if (/^events\.jsonl$/i.test(entry)) return true;
  if (/^(id_rsa|id_ed25519)$/i.test(entry)) return true;
  if (/\.(pem|key|crt)$/i.test(entry)) return true;
  return false;
}

function buildRepoTreeSnapshot(rootDir, options = {}) {
  const root = String(rootDir || '').trim();
  if (!root) return '';

  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 3;
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 140;
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 2200;
  const maxPerDir = Number.isFinite(options.maxPerDir) ? options.maxPerDir : 32;

  const lines = [];
  let entryCount = 0;
  let truncated = false;

  const walk = (dir, depth, indent) => {
    if (truncated) return;
    if (depth > maxDepth) return;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const filtered = entries
      .filter((e) => !shouldExcludeRepoTreeEntry(e?.name))
      .sort((a, b) => {
        const ad = a?.isDirectory?.() ? 0 : 1;
        const bd = b?.isDirectory?.() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return String(a?.name || '').localeCompare(String(b?.name || ''));
      });

    const shown = filtered.slice(0, maxPerDir);
    for (const entry of shown) {
      if (truncated) break;
      const abs = path.join(dir, entry.name);
      const rel = normalizePathForPrompt(path.relative(root, abs));
      const line = `${indent}- ${rel}${entry.isDirectory() ? '/' : ''}`;
      lines.push(line);
      entryCount += 1;
      if (entryCount >= maxEntries || lines.join('\n').length >= maxChars) {
        truncated = true;
        break;
      }
      if (entry.isDirectory() && depth < maxDepth) {
        walk(abs, depth + 1, `${indent}  `);
      }
      if (entryCount >= maxEntries || lines.join('\n').length >= maxChars) {
        truncated = true;
        break;
      }
    }

    const remaining = Math.max(0, filtered.length - shown.length);
    if (remaining > 0 && !truncated) {
      lines.push(`${indent}- …（${remaining} 项省略）`);
      entryCount += 1;
    }
  };

  walk(root, 1, '');

  const snapshot = lines.join('\n');
  return snapshot.length > maxChars ? snapshot.slice(0, maxChars) : snapshot;
}

function getRepoTreeSnapshotForPrompt() {
  const now = Date.now();
  if (REPO_TREE_CACHE.snapshot && now - REPO_TREE_CACHE.updatedAtMs < 60_000) {
    return REPO_TREE_CACHE.snapshot;
  }
  const next = buildRepoTreeSnapshot(REPO_DIR, { maxDepth: 3, maxEntries: 140, maxChars: 2200 });
  REPO_TREE_CACHE.snapshot = next;
  REPO_TREE_CACHE.updatedAtMs = now;
  return next;
}

function parseTaskSummaries(markdown) {
  const lines = normalizeLineEndings(markdown || '').split('\n');

  const stripPrefix = (value) => {
    let text = String(value || '').trim();
    text = text.replace(/^\*\*Task\s*\d+\*\*:\s*/i, '');
    text = text.replace(/^\d+[\.)]\s*/, '');
    return text.trim();
  };

  let inTaskList = false;
  let hasTaskListHeader = false;
  const scoped = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^##\s*任务清单\b/.test(trimmed)) {
      inTaskList = true;
      hasTaskListHeader = true;
      continue;
    }
    if (hasTaskListHeader && inTaskList && /^##\s+/.test(trimmed)) {
      inTaskList = false;
    }
    if (!hasTaskListHeader || inTaskList) {
      scoped.push(trimmed);
    }
  }

  const pool = scoped.length ? scoped : lines.map((l) => String(l || '').trim()).filter(Boolean);
  const summaries = [];
  for (const line of pool) {
    // Preferred format: checklist items.
    let match = line.match(/^- \[[ xX]\]\s*(.+)$/);
    if (match) {
      const text = stripPrefix(match[1]);
      if (text) summaries.push(text);
      continue;
    }

    // Fallback formats within task list section.
    match = line.match(/^\s*\d+[\.)]\s*(.+)$/);
    if (match) {
      const text = stripPrefix(match[1]);
      if (text) summaries.push(text);
      continue;
    }

    if (hasTaskListHeader) {
      match = line.match(/^-+\s*(.+)$/);
      if (match) {
        const text = stripPrefix(match[1]);
        if (text) summaries.push(text);
      }
    }
  }
  return summaries;
}

function parseTasksForAtomize(markdown) {
  const lines = normalizeLineEndings(markdown || '').split('\n');
  let inTaskList = false;
  let hasTaskListHeader = false;
  let current = null;
  let lastField = null;
  const tasks = [];

  const pushCurrent = () => {
    if (!current) return;
    const title = String(current.title || '').trim();
    if (title) {
      const depends = Array.isArray(current.depends)
        ? current.depends.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 30)
        : [];
      tasks.push({ ...current, title, depends });
    }
    current = null;
    lastField = null;
  };

  const appendField = (key, value) => {
    const text = String(value || '').trim();
    if (!text) return;
    if (!current[key]) current[key] = text;
    else current[key] = `${String(current[key]).trim()}\n${text}`.trim();
    lastField = key;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || '').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^##\s*任务清单\b/.test(trimmed)) {
      inTaskList = true;
      hasTaskListHeader = true;
      continue;
    }
    if (hasTaskListHeader && inTaskList && /^##\s+/.test(trimmed)) {
      inTaskList = false;
    }
    if (hasTaskListHeader && !inTaskList) continue;

    const taskHeader =
      trimmed.match(/^- \[[ xX]\]\s*\*\*Task\s*\d+\*\*:\s*(.+)$/) ||
      trimmed.match(/^- \[[ xX]\]\s*(.+)$/);
    if (taskHeader) {
      pushCurrent();
      current = {
        title: String(taskHeader[1] || '').trim(),
        core: '',
        details: '',
        ac: '',
        depends: [],
      };
      lastField = null;
      continue;
    }

    if (!current) continue;
    const coreMatch = trimmed.match(/^-+\s*\*\*核心逻辑\*\*:\s*(.+)$/);
    if (coreMatch) {
      appendField('core', coreMatch[1]);
      continue;
    }
    const detailsMatch = trimmed.match(/^-+\s*\*\*技术细节\*\*:\s*(.+)$/);
    if (detailsMatch) {
      appendField('details', detailsMatch[1]);
      continue;
    }
    const dependsMatch = trimmed.match(/^-+\s*\*\*依赖\*\*:\s*(.*)$/);
    if (dependsMatch) {
      const value = String(dependsMatch[1] || '').trim();
      if (!value || /^(无|无依赖|none|null|n\/a)$/i.test(value)) {
        current.depends = [];
        lastField = value ? null : 'depends';
      } else {
        current.depends.push(value);
        lastField = 'depends';
      }
      continue;
    }
    const acMatch = trimmed.match(/^-+\s*\*\*验收准则\s*\(AC\)\*\*:\s*(.+)$/);
    if (acMatch) {
      appendField('ac', acMatch[1]);
      continue;
    }

    if (lastField === 'depends' && /^\s{2,}/.test(line)) {
      const itemMatch = trimmed.match(/^-+\s*(.+)$/);
      if (itemMatch) {
        current.depends.push(String(itemMatch[1] || '').trim());
      } else if (trimmed && current.depends.length) {
        current.depends[current.depends.length - 1] = `${current.depends[current.depends.length - 1]}\n${trimmed}`.trim();
      }
      continue;
    }

    // Continuation lines for multi-line blocks.
    if (lastField && lastField !== 'depends' && /^\s{2,}/.test(line)) {
      appendField(lastField, trimmed);
    }
  }

  pushCurrent();

  if (tasks.length) return tasks;
  return parseTaskSummaries(markdown).map((summary) => ({
    title: String(summary || '').trim(),
    core: '',
    details: '',
    ac: '',
    depends: [],
  }));
}

function truncateForPrompt(text, maxLen) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

function formatOriginalTaskForAtomize(task) {
  const title = sanitizeModelText(task?.title || '', '').trim();
  const core = sanitizeModelText(task?.core || '', '').trim();
  const details = sanitizeModelText(task?.details || '', '').trim();
  const ac = sanitizeModelText(task?.ac || '', '').trim();
  const depends = Array.isArray(task?.depends) ? task.depends : [];
  const depItems = depends
    .map((item) => sanitizeModelText(item, '').trim())
    .filter(Boolean)
    .slice(0, 8);

  const lines = [];
  if (title) lines.push(`标题：${truncateForPrompt(title, 240)}`);
  if (core) lines.push(`核心逻辑：${truncateForPrompt(core, 320)}`);
  if (details) lines.push(`技术细节：${truncateForPrompt(details, 420)}`);
  if (depItems.length) {
    lines.push('依赖：');
    depItems.forEach((item) => lines.push(`- ${truncateForPrompt(item, 240)}`));
  }
  if (ac) lines.push(`验收准则：${truncateForPrompt(ac, 320)}`);

  return lines.join('\n').trim() || title;
}

function buildTasksAtomicHeader() {
  const template = SPEC_TEMPLATES.tasks_atomic || '# 任务原子化（tasks_atomic）';
  const lines = normalizeLineEndings(template).split('\n');
  return lines
    .filter((line) => !/^- \[ \]/.test(line))
    .join('\n')
    .trimEnd();
}

function parseAtomicDoneIndices(markdown) {
  const done = new Set();
  const text = normalizeLineEndings(markdown || '');
  const regex = /^###\s*原始任务\s*(\d+)\s*:/gm;
  let match;
  while ((match = regex.exec(text))) {
    const value = Number.parseInt(match[1], 10);
    if (!Number.isNaN(value)) done.add(value);
  }
  return done;
}

function sanitizeAtomicTaskId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+(?:\.\d+)+$/.test(trimmed)) return null;
  return trimmed;
}

function parseTasksAtomicMarkdown(markdown) {
  const text = normalizeLineEndings(markdown || '');
  const lines = text.split('\n');

  const results = [];
  let currentOriginalIndex = null;
  let currentOriginalTitle = '';
  let currentTask = null;
  let currentTaskLines = [];
  let lastField = null;

  const flushTask = () => {
    if (!currentTask) return;
    currentTask.block = currentTaskLines.join('\n').trimEnd();
    results.push(currentTask);
    currentTask = null;
    currentTaskLines = [];
    lastField = null;
  };

  for (const line of lines) {
    const originalMatch = /^###\s*原始任务\s*(\d+)\s*:\s*(.*)\s*$/.exec(line);
    if (originalMatch) {
      flushTask();
      currentOriginalIndex = Number.parseInt(originalMatch[1], 10);
      currentOriginalTitle = String(originalMatch[2] || '').trim();
      if (Number.isNaN(currentOriginalIndex)) currentOriginalIndex = null;
      continue;
    }

    const taskMatch = /^- \[( |x|X)\]\s*\*\*Task\s+([^*]+?)\*\*:\s*(.*)\s*$/.exec(line);
    if (taskMatch) {
      flushTask();
      const done = String(taskMatch[1] || '').toLowerCase() === 'x';
      const id = String(taskMatch[2] || '').trim();
      const title = String(taskMatch[3] || '').trim();
      currentTask = {
        id,
        done,
        title,
        core: '',
        details: '',
        depends: [],
        ac: '',
        originalIndex: currentOriginalIndex,
        originalTitle: currentOriginalTitle,
        block: '',
      };
      currentTaskLines = [line];
      lastField = null;
      continue;
    }

    if (currentTask) {
      currentTaskLines.push(line);

      const fieldMatch = /^\s{2,}-\s*\*\*(核心逻辑|技术细节|依赖|验收准则(?:\s*\(AC\))?)\*\*:\s*(.*)\s*$/.exec(
        line,
      );
      if (fieldMatch) {
        const keyLabel = fieldMatch[1];
        const value = String(fieldMatch[2] || '').trim();
        if (keyLabel.includes('核心逻辑')) {
          lastField = 'core';
          currentTask[lastField] = value;
        } else if (keyLabel.includes('技术细节')) {
          lastField = 'details';
          currentTask[lastField] = value;
        } else if (keyLabel === '依赖') {
          if (!value || /^(无|无依赖|none|null|n\/a)$/i.test(value)) {
            currentTask.depends = [];
            lastField = value ? null : 'depends';
          } else {
            currentTask.depends = [value];
            lastField = 'depends';
          }
        } else {
          lastField = 'ac';
          currentTask[lastField] = value;
        }
        continue;
      }

      const trimmed = line.trim();
      if (lastField === 'depends' && trimmed) {
        const itemMatch = trimmed.match(/^-+\s*(.+)$/);
        if (itemMatch) {
          currentTask.depends.push(String(itemMatch[1] || '').trim());
          continue;
        }
        if (currentTask.depends.length) {
          currentTask.depends[currentTask.depends.length - 1] = `${currentTask.depends[currentTask.depends.length - 1]}\n${trimmed}`.trim();
          continue;
        }
      }
      if (
        lastField &&
        trimmed &&
        !/^###\s/.test(trimmed) &&
        !/^- \[( |x|X)\]\s*\*\*Task\s+/i.test(trimmed) &&
        !/^\s{0,}-\s*\*\*/.test(trimmed)
      ) {
        if (lastField !== 'depends') {
          currentTask[lastField] = currentTask[lastField]
            ? `${currentTask[lastField]}\n${trimmed}`
            : trimmed;
        }
      }
    }
  }

  flushTask();
  return results;
}

function formatAtomicTaskBlock(indexLabel, task, context = {}) {
  const normalized = normalizeTaskObject(task) || { title: '', core: '', details: '', ac: '' };
  const groupTasks = Array.isArray(context?.groupTasks) ? context.groupTasks : [];
  const originalPrefix = String(indexLabel || '').split('.')[0] || '';
  const currentIdx = Number.isFinite(Number(context?.currentIdx)) ? Math.floor(Number(context.currentIdx)) : -1;
  let title =
    sanitizeAtomicField(normalized.title, '修改 docs/assumptions.md｜补充原子化缺失信息').trim() ||
    '修改 docs/assumptions.md｜补充原子化缺失信息';
  title = title.replace(/^创建\s+docs\/assumptions\.md\b/, '修改 docs/assumptions.md');
  const core =
    sanitizeAtomicField(
      normalized.core,
      '记录原子化所需的假设与待确认点，补齐缺失信息后继续拆解。',
    ).trim() || '记录原子化所需的假设与待确认点，补齐缺失信息后继续拆解。';
  const details =
    sanitizeAtomicField(
      normalized.details,
      '在 docs/assumptions.md 写入：1) 当前目标/上下文摘要；2) 需要确认的目录结构/技术栈/约束；3) 下一步建议（例如提供入口文件或文件树）。',
    ).trim() ||
    '在 docs/assumptions.md 写入：1) 当前目标/上下文摘要；2) 需要确认的目录结构/技术栈/约束；3) 下一步建议（例如提供入口文件或文件树）。';
  const ac =
    sanitizeAtomicField(
      normalized.ac,
      'docs/assumptions.md 存在，且包含“待确认点”小节与至少 3 条条目。',
    ).trim() || 'docs/assumptions.md 存在，且包含“待确认点”小节与至少 3 条条目。';

  const depItems = Array.from(new Set(normalized.depends || []))
    .map((n) => (Number.isFinite(Number(n)) ? Math.floor(Number(n)) : -1))
    .filter((n) => n >= 0 && n < groupTasks.length && n !== currentIdx)
    .slice(0, 12)
    .map((depIdx) => {
      const depTask = groupTasks[depIdx] || {};
      const depTitle = sanitizeAtomicField(depTask.title || '', `Task ${depIdx + 1}`);
      const label = sanitizeAtomicField(depTitle, `Task ${depIdx + 1}`);
      const ref = originalPrefix ? `${originalPrefix}.${depIdx + 1}` : `${depIdx + 1}`;
      return `    - ${label}（来自 Task ${ref}）`;
    });
  const depsBlock = depItems.length
    ? ['  - **依赖**:', ...depItems].join('\n')
    : '  - **依赖**: 无';

  return [
    `- [ ] **Task ${indexLabel}**: ${title}`,
    `  - **核心逻辑**: ${core}`,
    `  - **技术细节**: ${details}`,
    depsBlock,
    `  - **验收准则 (AC)**: ${ac}`,
  ].join('\n');
}

function buildAtomicSection(originalIndex, summary, tasks) {
  const title = sanitizeAtomicField(summary, '（未命名）');
  const blocks = tasks
    .map((task, idx) =>
      formatAtomicTaskBlock(`${originalIndex}.${idx + 1}`, task, {
        groupTasks: tasks,
        currentIdx: idx,
      }),
    )
    .join('\n\n');
  return `### 原始任务 ${originalIndex}: ${title || '（未命名）'}\n\n${blocks}`;
}

function ensureAtomicFile(specName) {
  const filePath = resolveSpecFile(specName, 'tasks_atomic');
  if (!fs.existsSync(filePath)) {
    const header = buildTasksAtomicHeader();
    writeSpecFile(specName, 'tasks_atomic', `${header}\n`);
    return filePath;
  }
  const existing = fs.readFileSync(filePath, 'utf8');
  if (!existing.trim()) {
    const header = buildTasksAtomicHeader();
    fs.writeFileSync(filePath, `${header}\n`, 'utf8');
  }
  return filePath;
}

function resetAtomicFile(specName) {
  const filePath = resolveSpecFile(specName, 'tasks_atomic');
  const header = buildTasksAtomicHeader();
  fs.mkdirSync(resolveSpecDir(specName), { recursive: true });
  fs.writeFileSync(filePath, `${header}\n`, 'utf8');
  return filePath;
}

const ATOMIC_PLACEHOLDER_RE = /\bTBD\b|待定|\[path\]|占位符/i;

function containsAtomicPlaceholder(text) {
  return ATOMIC_PLACEHOLDER_RE.test(String(text || ''));
}

function sanitizeAtomicField(value, fallback) {
  if (!value) return fallback;
  let text = String(value);
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/Requesting clarification/i.test(line) &&
        !/请提供完整的需求描述/.test(line) &&
        !/^```/i.test(line),
    )
    .join('\n')
    .trim();
  if (!text) return fallback;
  if (/\?{3,}/.test(text) || /？{3,}/.test(text)) return fallback;
  if (/�/.test(text)) return fallback;
  if (!/[a-zA-Z0-9\u4e00-\u9fa5]/.test(text)) return fallback;
  if (containsAtomicPlaceholder(text)) return fallback;
  return text;
}

function validateAtomicTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return { ok: false, error: 'empty' };
  const normalized = tasks.map(normalizeTaskObject).filter(Boolean);
  if (!normalized.length) return { ok: false, error: 'invalid_shape' };
  const missingFields = normalized.some((t) => !t.title || !t.core || !t.details || !t.ac);
  if (missingFields) return { ok: false, error: 'missing_fields' };
  const containsPlaceholder = normalized.some(
    (t) =>
      containsAtomicPlaceholder(t.title) ||
      containsAtomicPlaceholder(t.core) ||
      containsAtomicPlaceholder(t.details) ||
      containsAtomicPlaceholder(t.ac),
  );
  if (containsPlaceholder) return { ok: false, error: 'contains_placeholder' };
  const notChinese = normalized.some((t) => !looksLikeChinese(t.title + t.core + t.details + t.ac));
  if (notChinese) return { ok: false, error: 'not_zh' };
  const invalidAction = normalized.some((t) => !/^(创建|修改|删除)\s+\S+/.test(t.title));
  if (invalidAction) return { ok: false, error: 'invalid_action' };
  const extractPathToken = (title) => {
    const text = String(title || '').trim();
    const match = /^(创建|修改|删除)\s+(.+)$/.exec(text);
    if (!match) return null;
    const rest = String(match[2] || '').trim();
    if (!rest) return null;
    const firstToken = rest.split(/\s+/)[0] || '';
    const beforePipe = firstToken.split(/[｜|]/)[0] || '';
    return beforePipe.replace(/[：:，,。;；]+$/g, '').trim() || null;
  };
  const hasFileExtension = (pathToken) => {
    const token = String(pathToken || '').trim().replace(/[/\\]+$/g, '');
    if (!token) return false;
    const base = token.split(/[/\\]/).pop() || '';
    if (!base) return false;
    if (base.endsWith('.')) return false;
    return /\.[A-Za-z0-9]{1,8}$/.test(base);
  };
  const invalidPath = normalized.some((t) => {
    const token = extractPathToken(t.title);
    if (!token) return true;
    if (/(TBD|待定|\[path\]|占位符)/i.test(token)) return true;
    if (!hasFileExtension(token)) return true;
    return false;
  });
  if (invalidPath) return { ok: false, error: 'invalid_path' };
  const seen = new Set();
  const deduped = [];
  for (const task of normalized) {
    const key = task.title.replace(/\s+/g, ' ').trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(task);
  }
  if (!deduped.length) return { ok: false, error: 'deduped_empty' };

  const assumptionsPath = 'docs/assumptions.md';
  const assumptions = [];
  const rest = [];
  for (const task of deduped) {
    const token = extractPathToken(task.title);
    const normalizedToken = token ? token.replace(/\\/g, '/') : null;
    if (normalizedToken === assumptionsPath) assumptions.push(task);
    else rest.push(task);
  }

  if (assumptions.length > 1) {
    const itemSet = new Set();
    const items = [];
    const addItem = (line) => {
      const text = String(line || '').trim();
      if (!text) return;
      const key = text.replace(/\s+/g, ' ').trim();
      if (!key || itemSet.has(key)) return;
      itemSet.add(key);
      items.push(text);
    };
    assumptions.forEach((t) => {
      const hint = String(t.title || '')
        .replace(/^(创建|修改|删除)\s+docs\/assumptions\.md\s*/i, '')
        .replace(/^[｜|]\s*/g, '')
        .trim();
      if (hint) addItem(hint);
    });
    if (!items.length) addItem('补齐原子化所需的缺失信息与约束');

    const merged = {
      title: '修改 docs/assumptions.md｜汇总待确认点',
      core: '汇总原子化过程中的待确认点，消除重复 assumptions 任务。',
      details: ['在 docs/assumptions.md 的“待确认点”小节追加/合并以下条目：', ...items.map((x) => `- ${x}`)].join('\n'),
      ac: '运行 `rg "待确认点" docs/assumptions.md` 可看到合并后的条目且无重复。',
    };
    return { ok: true, tasks: [merged, ...rest] };
  }

  return { ok: true, tasks: deduped };
}


function coerceAtomicTasks(tasks) {
  const normalized = Array.isArray(tasks) ? tasks.map(normalizeTaskObject).filter(Boolean) : [];
  if (!normalized.length) return [];

  const existsInRepo = (relPath) => {
    const normalizedPath = String(relPath || '').replace(/\\/g, '/').trim();
    if (!normalizedPath) return false;
    const abs = path.join(REPO_DIR, ...normalizedPath.split('/'));
    return fs.existsSync(abs);
  };

  const pickFallbackPath = (hintText) => {
    const text = String(hintText || '');
    if (/(前端|UI|按钮|组件|React|dashboard|App\.tsx|tsx)/i.test(text)) {
      return existsInRepo('dashboard/src/App.tsx') ? 'dashboard/src/App.tsx' : 'docs/assumptions.md';
    }
    if (/(assumptions|待确认点|不确定|缺失|文档|说明|readme)/i.test(text)) {
      return 'docs/assumptions.md';
    }
    return existsInRepo('bridge/src/index.js') ? 'bridge/src/index.js' : 'docs/assumptions.md';
  };

  const pickAction = (rawTitle) => {
    const match = /^(创建|修改|删除)\b/.exec(String(rawTitle || '').trim());
    return match?.[1] || '修改';
  };

  const extractPathToken = (titleText) => {
    const match = /^(创建|修改|删除)\s+(\S+)/.exec(String(titleText || '').trim());
    if (!match) return null;
    const token = String(match[2] || '').trim().replace(/[：:，,。;；]+$/g, '');
    if (!token) return null;
    if (/(TBD|待定|\[path\]|占位符)/i.test(token)) return null;
    const base = token.split(/[/\\]/).pop() || '';
    if (!/\.[A-Za-z0-9]{1,8}$/.test(base)) return null;
    return token.replace(/\\/g, '/');
  };

  return normalized.map((task) => {
    const rawTitle = String(task.title || '').trim();
    const action = pickAction(rawTitle);
    const hintSource = [rawTitle, task.core, task.details].filter(Boolean).join('｜');
    const hint = truncateForPrompt(sanitizeModelText(hintSource, '').trim(), 80);

    const sanitizedTitle = sanitizeAtomicField(rawTitle, '').trim();
    const fromTitle = extractPathToken(sanitizedTitle);
    const targetPath = fromTitle || pickFallbackPath(hintSource);

    const title = `${action} ${targetPath}${hint ? `｜${hint}` : ''}`.trim();

    if (targetPath === 'docs/assumptions.md') {
      const details = [
        '在 docs/assumptions.md 的“待确认点”小节追加：',
        hint ? `- ${hint}` : '- 补齐原子化所需的缺失信息与约束',
      ].join('\n');
      return {
        title: title.replace(/^创建\s+docs\/assumptions\.md\b/, '修改 docs/assumptions.md'),
        core: '记录原子化所需假设与待确认点，补齐缺失信息后继续拆解。',
        details,
        ac: '运行 `rg "待确认点" docs/assumptions.md` 可匹配到新增条目。',
      };
    }

    const core =
      sanitizeAtomicField(task.core || '', '').trim() ||
      `在 ${targetPath} 中落地本任务变更，保证逻辑自洽且可验证。`;
    const details =
      sanitizeAtomicField(task.details || '', '').trim() ||
      `在 ${targetPath} 中实现与“${hint || '本任务目标'}”相关的改动，并补齐必要的导出/常量/参数约束。`;
    const ac =
      sanitizeAtomicField(task.ac || '', '').trim() ||
      `执行 \`node -e \"const fs=require('fs'); console.log(fs.existsSync('${targetPath}'))\"\` 输出 \`true\`。`;

    return { title, core, details, ac };
  });
}

function splitSummaryForAtomize(summary, maxParts = 3) {
  const text = sanitizeModelText(summary || '', '').trim();
  if (!text) return [];
  const primary = text
    .split(/[。；;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const baseParts = primary.length > 1
    ? primary
    : text.split(/[，,、]+/).map((part) => part.trim()).filter(Boolean);
  if (baseParts.length <= 1) return [text];
  const bucketCount = Math.min(maxParts, baseParts.length);
  const buckets = Array.from({ length: bucketCount }, () => []);
  baseParts.forEach((part, idx) => {
    buckets[idx % bucketCount].push(part);
  });
  return buckets.map((parts) => parts.join('，').trim()).filter(Boolean);
}

function buildFallbackAtomicTasks(summary) {
  const hint = sanitizeModelText(summary || '', '').trim();
  const title = hint ? `修改 docs/assumptions.md｜${hint}` : '修改 docs/assumptions.md';
  return [
    {
      title,
      core: '记录原子化所需的假设与待确认点，补齐缺失信息后继续拆解。',
      details:
        '在 docs/assumptions.md 写入：1) 当前目标/上下文摘要；2) 需要确认的目录结构/技术栈/约束；3) 下一步建议（例如提供入口文件或文件树）。',
      ac: 'docs/assumptions.md 存在，且包含“待确认点”小节与至少 3 条条目。',
    },
  ];
}

function shouldSplitFurther(tasks) {
  const pattern = /(并且|以及|同时|随后|然后|步骤|流程)/;
  return tasks.some((t) => pattern.test(`${t.title} ${t.core} ${t.details}`));
}

async function generateTasksWithModel(design, prompt, options = {}) {
  assertValidLlmConfig(getActiveLlmConfig());

  const minTasks = Number(process.env.LLM_TASK_MIN || 8);
  const maxTasks = Math.min(Number(process.env.LLM_TASK_MAX || 16), 25);
  const timeoutMs = Math.min(Number(process.env.LLM_TASK_TIMEOUT_MS || 60000), 120000);

  const promptConfig = loadPromptConfig();
  const stage = promptConfig.stages.tasks;

  const onToken = typeof options?.onToken === 'function' ? options.onToken : null;
  const onTelemetry = typeof options?.onTelemetry === 'function' ? options.onTelemetry : null;

  const stageKey = 'tasks';
  const variables = { design, prompt, minTasks, maxTasks };
  const promptTemplates = { system: stage.system, user: stage.user };
  const promptRendered = {
    system: applyPromptTemplate(stage.system, variables),
    user: applyPromptTemplate(stage.user, variables),
  };
  const messages = [
    { role: 'system', content: promptRendered.system },
    { role: 'user', content: promptRendered.user },
  ];

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let usage = null;
  const recordTelemetry = (error) => {
    const endedAt = new Date().toISOString();
    onTelemetry?.({
      stageKey,
      stream: Boolean(onToken),
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      usage,
      llmContext: describeLlmConfig(getActiveLlmConfig()),
      prompt: { templates: promptTemplates, rendered: promptRendered, variables },
      error: error
        ? { message: error?.message || String(error || ''), context: error?.llmContext || null }
        : null,
    });
  };

  try {
    const content = onToken
      ? await callLlmStream(messages, { timeoutMs }, {
          onToken,
          onUsage: (u) => {
            usage = u;
          },
        })
      : await callLlm(messages, { timeoutMs }, {
          onUsage: (u) => {
            usage = u;
          },
        });

    const payload = tryParseJson(content);
    const rawTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    const normalized = ensureUniqueDagTaskIds(
      rawTasks.map((t, idx) => normalizeDagTaskObject(t, idx)).filter(Boolean),
    );
    if (!normalized.length) {
      recordTelemetry(null);
      return generateTasksContent(design, prompt);
    }

    const trimmed = normalized.slice(0, Math.min(maxTasks, 25));
    const idSet = new Set(trimmed.map((t) => t.id));
    const finalTasks = trimmed.map((t) => {
      const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
      const dependencies = Array.from(
        new Set(
          deps
            .map((d) => String(d ?? '').trim())
            .filter((d) => d && d !== t.id && idSet.has(d)),
        ),
      ).slice(0, 24);
      const scope = Array.from(new Set(Array.isArray(t.scope) ? t.scope : [])).slice(0, 32);
      return { ...t, dependencies, scope };
    });

    const notes = [];
    if (finalTasks.length < Math.min(minTasks, maxTasks)) {
      notes.push(`提示：本次任务数量为 ${finalTasks.length}，低于建议值 ${Math.min(minTasks, maxTasks)}，可酌情补充。`);
    }
    if (!finalTasks.every((t) => looksLikeChinese(`${t.title} ${t.description}`))) {
      notes.push('提示：任务文本包含非中文内容，建议按需调整为简体中文。');
    }
    recordTelemetry(null);
    return buildTasksDagMarkdown({ tasks: finalTasks }, { notes });
  } catch (error) {
    recordTelemetry(error);
    throw error;
  }
}

async function requestAtomicTasks(payload, designSnippet, timeoutMs, reason = '', telemetry = null) {
  const promptConfig = loadPromptConfig();
  const stage = promptConfig.stages.atomize;

  const isList = Array.isArray(payload?.tasks);
  const repoTree = getRepoTreeSnapshotForPrompt();
  const structureContext = repoTree
    ? `项目结构（自动扫描，仅用于文件路径精确化；已过滤 node_modules/dist 等）：\n${repoTree}\n\n`
    : '';
  const context = `${structureContext}${designSnippet ? `设计摘要：${designSnippet}\n\n` : ''}`;
  const main = isList
    ? `当前任务列表（JSON）：\n${JSON.stringify(payload.tasks)}\n\n请进一步拆分为更原子任务；若已足够原子则保持。`
    : `原始任务：${payload.summary}\n\n请拆分为无法再拆的原子任务。`;

  const reasonBlock = reason ? `注意：${reason}\n` : '';

  const stageKey = 'atomize';
  const variables = { context, main, reasonBlock };
  const promptTemplates = { system: stage.system, user: stage.user };

  const recordAttempt =
    typeof telemetry === 'function'
      ? telemetry
      : typeof telemetry?.recordAttempt === 'function'
        ? telemetry.recordAttempt
        : null;
  const meta = telemetry?.meta && typeof telemetry.meta === 'object' ? telemetry.meta : null;

  const callOnce = async ({ userPrefix = '', label = 'primary' }) => {
    const promptRendered = {
      system: applyPromptTemplate(stage.system, variables),
      user: `${userPrefix}${applyPromptTemplate(stage.user, variables)}`,
    };
    const messages = [
      { role: 'system', content: promptRendered.system },
      { role: 'user', content: promptRendered.user },
    ];
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let usage = null;
    try {
      const content = await callLlm(messages, { timeoutMs }, {
        onUsage: (u) => {
          usage = u;
        },
      });
      const endedAt = new Date().toISOString();
      recordAttempt?.({
        ...(meta || {}),
        stageKey,
        label,
        stream: false,
        startedAt,
        endedAt,
        durationMs: Date.now() - startedMs,
        usage,
        llmContext: describeLlmConfig(getActiveLlmConfig()),
        prompt: { templates: promptTemplates, rendered: promptRendered, variables },
        error: null,
      });
      return { content, promptRendered, usage };
    } catch (error) {
      const endedAt = new Date().toISOString();
      recordAttempt?.({
        ...(meta || {}),
        stageKey,
        label,
        stream: false,
        startedAt,
        endedAt,
        durationMs: Date.now() - startedMs,
        usage,
        llmContext: describeLlmConfig(getActiveLlmConfig()),
        prompt: { templates: promptTemplates, rendered: { system: applyPromptTemplate(stage.system, variables), user: `${userPrefix}${applyPromptTemplate(stage.user, variables)}` }, variables },
        error: { message: error?.message || String(error || ''), context: error?.llmContext || null },
      });
      throw error;
    }
  };

  const first = await callOnce({ label: 'primary' });
  const content = first.content;

  const filterStrictAtomicTasks = (rawTasks) => {
    const normalized = Array.isArray(rawTasks) ? rawTasks.map(normalizeTaskObject).filter(Boolean) : [];
    if (!normalized.length) return [];

    const extractPathToken = (title) => {
      const text = String(title || '').trim();
      const match = /^(创建|修改|删除)\s+(.+)$/.exec(text);
      if (!match) return null;
      const rest = String(match[2] || '').trim();
      if (!rest) return null;
      const firstToken = rest.split(/\s+/)[0] || '';
      const beforePipe = firstToken.split(/[｜|]/)[0] || '';
      return beforePipe.replace(/[：:，,。;；]+$/g, '').trim() || null;
    };

    const hasFileExtension = (pathToken) => {
      const token = String(pathToken || '').trim().replace(/[/\\]+$/g, '');
      if (!token) return false;
      const base = token.split(/[/\\]/).pop() || '';
      if (!base) return false;
      if (base.endsWith('.')) return false;
      return /\.[A-Za-z0-9]{1,8}$/.test(base);
    };

    const filtered = normalized.filter((t) => {
      if (!t.title || !t.core || !t.details || !t.ac) return false;
      if (
        containsAtomicPlaceholder(t.title) ||
        containsAtomicPlaceholder(t.core) ||
        containsAtomicPlaceholder(t.details) ||
        containsAtomicPlaceholder(t.ac)
      ) {
        return false;
      }
      if (!looksLikeChinese(t.title + t.core + t.details + t.ac)) return false;
      if (!/^(创建|修改|删除)\s+\S+/.test(t.title)) return false;
      const token = extractPathToken(t.title);
      if (!token) return false;
      if (/(TBD|待定|\[path\]|占位符)/i.test(token)) return false;
      if (!hasFileExtension(token)) return false;
      return true;
    });

    const seen = new Set();
    const deduped = [];
    for (const task of filtered) {
      const key = task.title.replace(/\s+/g, ' ').trim();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(task);
    }
    return deduped;
  };

  const parsed = tryParseJson(content);
  let candidateTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  let verdict = validateAtomicTasks(candidateTasks);
  let lastError = verdict.error || null;

  if (!verdict.ok && lastError === 'contains_placeholder') {
    const filtered = filterStrictAtomicTasks(candidateTasks);
    const filteredVerdict = validateAtomicTasks(filtered);
    if (filteredVerdict.ok) {
      verdict = filteredVerdict;
      lastError = null;
    }
  }

  if (!verdict.ok) {
    const repairPrefix = `上一次输出不符合要求（原因：${verdict.error}）。请直接重做。\n\n`;
    const repairedCall = await callOnce({ label: 'repair', userPrefix: repairPrefix });
    const repair = repairedCall.content;
    const repaired = tryParseJson(repair);
    candidateTasks = Array.isArray(repaired?.tasks) ? repaired.tasks : [];
    verdict = validateAtomicTasks(candidateTasks);
    lastError = verdict.error || lastError;

    if (!verdict.ok && verdict.error === 'contains_placeholder') {
      const filtered = filterStrictAtomicTasks(candidateTasks);
      const filteredVerdict = validateAtomicTasks(filtered);
      if (filteredVerdict.ok) {
        verdict = filteredVerdict;
        lastError = null;
      }
    }
  }
  if (!verdict.ok) {
    const loose = coerceAtomicTasks(candidateTasks);
    if (loose.length) {
      const err = new Error('LLM tasks output invalid');
      err.partialTasks = loose;
      err.partialReason = lastError || verdict.error;
      throw err;
    }
    throw new Error('LLM tasks output invalid');
  }
  return verdict.tasks;
}

async function atomizeTaskSummary(
  summary,
  designSnippet,
  maxRounds,
  timeoutMs,
  telemetry = null,
  extraReason = '',
) {
  let currentTasks = null;
  for (let round = 1; round <= maxRounds; round += 1) {
    const roundTelemetry =
      telemetry && typeof telemetry === 'object'
        ? { ...telemetry, meta: { ...(telemetry.meta || {}), round } }
        : telemetry;
    const roundReason = currentTasks ? `第 ${round} 轮进一步拆分` : '';
    const reason = [String(extraReason || '').trim(), roundReason].filter(Boolean).join('\n');
    const tasks = await requestAtomicTasks(
      currentTasks ? { tasks: currentTasks } : { summary },
      designSnippet,
      timeoutMs,
      reason,
      roundTelemetry,
    );
    currentTasks = tasks;
    if (!shouldSplitFurther(tasks) || round === maxRounds) {
      return tasks;
    }
  }
  return currentTasks || [];
}

function logAtomize(job, message) {
  const entry = { at: new Date().toISOString(), message };
  job.logs.push(entry);
  if (job.logs.length > 200) job.logs.shift();
  job.updatedAt = entry.at;
}


async function atomizeSummaryParts(
  parts,
  designSnippet,
  timeoutMs,
  job,
  telemetry = null,
  extraReason = '',
) {
  const results = [];
  for (let idx = 0; idx < parts.length; idx += 1) {
    const part = parts[idx];
    const partTelemetry =
      telemetry && typeof telemetry === 'object'
        ? { ...telemetry, meta: { ...(telemetry.meta || {}), splitPart: idx + 1, splitParts: parts.length } }
        : telemetry;
    try {
      const subTasks = await atomizeTaskSummary(
        part,
        designSnippet,
        1,
        timeoutMs,
        partTelemetry,
        extraReason,
      );
      results.push(...subTasks);
    } catch (error) {
      if (error?.partialTasks?.length) {
        logAtomize(job, '子任务拆分输出不规范，已自动降级。');
        results.push(...error.partialTasks);
        continue;
      }
      logAtomize(job, '子任务拆分失败，已使用占位任务。');
      results.push(...buildFallbackAtomicTasks(part));
    }
  }
  return results;
}

async function atomizeTaskSummarySafe(
  summary,
  designSnippet,
  maxRounds,
  timeoutMs,
  job,
  telemetry = null,
  extraReason = '',
) {
  const cleaned = sanitizeModelText(summary || '', '').trim();
  if (!cleaned) return buildFallbackAtomicTasks(summary);
  const looksStructured =
    /标题：|核心逻辑：|技术细节：|验收准则：/.test(cleaned) ||
    cleaned.includes('\n');
  const splitThreshold = looksStructured ? 900 : 180;
  const needsSplit = cleaned.length > splitThreshold;
  if (needsSplit) {
    const parts = splitSummaryForAtomize(cleaned, 3);
    if (parts.length > 1) {
      logAtomize(job, `原始任务过长，拆分为 ${parts.length} 段处理。`);
      const results = await atomizeSummaryParts(
        parts,
        designSnippet,
        timeoutMs,
        job,
        telemetry,
        extraReason,
      );
      if (results.length) return results;
    }
  }
  try {
    return await atomizeTaskSummary(
      cleaned,
      designSnippet,
      maxRounds,
      timeoutMs,
      telemetry,
      extraReason,
    );
  } catch (error) {
    if (error?.partialTasks?.length) {
      logAtomize(job, `原始任务输出不规范（${error.partialReason || 'invalid'}），已自动降级。`);
      return error.partialTasks;
    }
    const parts = splitSummaryForAtomize(cleaned, 3);
    if (parts.length > 1) {
      logAtomize(job, `原始任务拆分为 ${parts.length} 段后重试。`);
      const results = await atomizeSummaryParts(
        parts,
        designSnippet,
        timeoutMs,
        job,
        telemetry,
        extraReason,
      );
      if (results.length) return results;
    }
    const reason = truncateText(error?.message || String(error || ''), 180);
    logAtomize(job, `原子化失败${reason ? `（${reason}）` : ''}，已生成占位任务。`);
    return buildFallbackAtomicTasks(cleaned);
  }
}

function getAtomizeStatus(job) {
  return {
    running: job.running,
    total: job.total,
    completed: job.completed,
    logs: job.logs,
    error: job.error,
    batchSize: job.batchSize ?? null,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
  };
}

function normalizeAtomizeBatchSize(input) {
  const value = Number.parseInt(String(input ?? ''), 10);
  if (!Number.isFinite(value) || Number.isNaN(value)) return null;
  if (value < 1) return null;
  return Math.min(20, value);
}

function buildAtomizeIterationReasonFromReport(run, userNote = '') {
  const note = sanitizeReviewText(userNote, 1800);
  const ratings = run?.ratings && typeof run.ratings === 'object' ? run.ratings : {};
  const byModel =
    ratings?.byModel && typeof ratings.byModel === 'object' ? ratings.byModel : {};
  const modelIds = LLM_MODEL_OPTIONS.map((m) => String(m?.id || '')).filter(Boolean);

  const blocks = [];
  const hasAnyModelResult = modelIds.some((id) => Boolean(byModel?.[id]?.result));
  if (hasAnyModelResult) {
    blocks.push('多模型评分意见（针对 tasks_atomic.md，作为本次原子化迭代约束）：');
    modelIds.forEach((modelId) => {
      const item =
        byModel?.[modelId] && typeof byModel[modelId] === 'object' ? byModel[modelId] : null;
      const result = item?.result && typeof item.result === 'object' ? item.result : null;
      if (!result) return;
      const score = Number(result.score);
      const scoreText =
        Number.isFinite(score) && score >= 0 && score <= 100 ? String(Math.round(score)) : 'n/a';
      const summary = sanitizeReviewText(String(result.summary || ''), 180) || '（无）';
      blocks.push(`- ${getModelLabel(modelId)}：${scoreText}/100｜${summary}`);
      const weaknesses = Array.isArray(result.weaknesses)
        ? result.weaknesses.map((x) => sanitizeReviewText(String(x || ''), 140)).filter(Boolean)
        : [];
      if (weaknesses.length) {
        blocks.push(`  - 主要问题：${weaknesses.slice(0, 3).join('； ')}`);
      }
      const suggestions = Array.isArray(result.suggestions)
        ? result.suggestions.map((x) => sanitizeReviewText(String(x || ''), 160)).filter(Boolean)
        : [];
      if (suggestions.length) {
        blocks.push('  - 建议：');
        suggestions.slice(0, 6).forEach((s) => blocks.push(`    - ${s}`));
      }
    });
  }

  if (note) {
    blocks.push('');
    blocks.push('用户补充修改意见：');
    blocks.push(note);
  }

  const joined = blocks.join('\n').trim();
  if (!joined) return '';
  return joined.length > 3600 ? joined.slice(0, 3600) : joined;
}

async function runAtomizeJob(specName, job, options = {}) {
  try {
    const specDir = resolveSpecDir(specName);
    if (!fs.existsSync(specDir)) throw new Error('Spec not found');

    const status = readSpecStatus(specName);
    const flowRunReason =
      typeof options?.flowRunReason === 'string' && options.flowRunReason.trim()
        ? options.flowRunReason.trim()
        : 'atomize';
    ensureActiveFlowRun(specName, status, {
      reason: flowRunReason,
      forceNew: options?.forceNewFlowRun === true,
    });

    let canUseModel = true;
    try {
      assertValidLlmConfig(getActiveLlmConfig());
    } catch (error) {
      canUseModel = false;
      const message = truncateText(error?.message || String(error || ''), 180);
      logAtomize(job, `模型配置不可用${message ? `（${message}）` : ''}，本次将生成占位任务。`);
      appendFlowRunStageAttempt(
        specName,
        'atomize',
        {
          label: 'llm_unavailable',
          startedAt: job.startedAt || new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 0,
          stream: false,
          usage: null,
          llmContext: describeLlmConfig(getActiveLlmConfig()),
          error: { message: message || 'LLM config unavailable', context: error?.llmContext || null },
        },
        { reason: flowRunReason },
      );
    }

    const requirementsPath = resolveSpecFile(specName, 'requirements');
    const requirementsContent = fs.existsSync(requirementsPath)
      ? fs.readFileSync(requirementsPath, 'utf8')
      : '';

    const designPath = resolveSpecFile(specName, 'design');
    let designMarkdown = fs.existsSync(designPath)
      ? fs.readFileSync(designPath, 'utf8')
      : '';
    if (!designMarkdown.trim() && (requirementsContent.trim() || status.prompt)) {
      designMarkdown = generateDesignContent(requirementsContent, status.prompt);
      writeSpecFile(specName, 'design', designMarkdown);
      logAtomize(job, 'design.md 缺失，已自动生成模板。');
    }

    const tasksPath = resolveSpecFile(specName, 'tasks');
    let tasksMarkdown = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : '';
    let originalTasks = parseTasksForAtomize(tasksMarkdown);
    if (!originalTasks.length && (designMarkdown.trim() || status.prompt)) {
      const fallbackTasksMarkdown = generateTasksContent(designMarkdown, status.prompt);
      writeSpecFile(specName, 'tasks', fallbackTasksMarkdown);
      tasksMarkdown = fallbackTasksMarkdown;
      originalTasks = parseTasksForAtomize(tasksMarkdown);
      if (originalTasks.length) {
        logAtomize(job, 'tasks.md 缺失/格式不兼容，已自动生成模板任务清单。');
      }
    }

    if (!originalTasks.length) throw new Error('任务列表为空，无法原子化');

    const designSnippet = truncateText(designMarkdown, 1200);

    const iterationReason =
      typeof options?.iterationReason === 'string' && options.iterationReason.trim()
        ? options.iterationReason.trim()
        : '';

    const atomicPath =
      options?.resetAtomic === true ? resetAtomicFile(specName) : ensureAtomicFile(specName);
    if (options?.resetAtomic === true) {
      logAtomize(job, 'tasks_atomic.md 已重置，将重新生成。');
    }
    const atomicContent = fs.existsSync(atomicPath) ? fs.readFileSync(atomicPath, 'utf8') : '';
    const doneIndices = parseAtomicDoneIndices(atomicContent);

    job.total = originalTasks.length;
    job.completed = doneIndices.size;
    logAtomize(job, `检测到 ${originalTasks.length} 条任务，已完成 ${job.completed} 条。`);
    appendFlowRunStageAttempt(
      specName,
      'atomize',
      {
        label: 'job_start',
        startedAt: job.startedAt || new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        stream: false,
        usage: null,
        llmContext: describeLlmConfig(getActiveLlmConfig()),
        meta: {
          total: originalTasks.length,
          completed: doneIndices.size,
          batchSize: options?.batchSize ?? null,
        },
        error: null,
      },
      { reason: flowRunReason },
    );

    const requestedBatchSize = normalizeAtomizeBatchSize(options.batchSize);
    const defaultBatchSize = normalizeAtomizeBatchSize(
      process.env.LLM_TASK_ATOMIZE_BATCH_SIZE || 0,
    );
    const batchSize = requestedBatchSize || defaultBatchSize || 3;
    job.batchSize = batchSize;

    const maxRounds = Number(process.env.LLM_TASK_ATOMIZE_ROUNDS || 3);
    const timeoutMs = Math.min(
      Math.max(8000, Number(process.env.LLM_TASK_ATOMIZE_TIMEOUT_MS || 120000)),
      240000,
    );

    let processedThisRun = 0;

    for (let i = 0; i < originalTasks.length; i += 1) {
      const index = i + 1;
      if (doneIndices.has(index)) {
        logAtomize(job, `跳过原始任务 ${index}（已完成）`);
        continue;
      }
      if (processedThisRun >= batchSize) break;
      const original = originalTasks[i] || {};
      const originalTitle = sanitizeModelText(original?.title || '', '').trim() || '（未命名）';
      const summaryForModel = formatOriginalTaskForAtomize(original);
      logAtomize(job, `开始原始任务 ${index}/${originalTasks.length}：${originalTitle}`);
      const telemetry = {
        meta: { originalIndex: index, originalTask: originalTitle, originalTaskDetail: summaryForModel },
        recordAttempt: (attempt) =>
          appendFlowRunStageAttempt(specName, 'atomize', attempt, { reason: flowRunReason }),
      };
      const atomized = canUseModel
        ? await atomizeTaskSummarySafe(
            summaryForModel,
            designSnippet,
            maxRounds,
            timeoutMs,
            job,
            telemetry,
            iterationReason,
          )
        : buildFallbackAtomicTasks(originalTitle);
      const section = buildAtomicSection(index, originalTitle, atomized);
      fs.appendFileSync(atomicPath, `\n\n${section}\n`, 'utf8');
      doneIndices.add(index);
      job.completed = doneIndices.size;
      processedThisRun += 1;
      logAtomize(job, `完成原始任务 ${index}/${originalTasks.length}`);
    }

    job.running = false;
    job.error = null;

    if (doneIndices.size >= originalTasks.length) {
      logAtomize(job, '原子化完成');
      appendFlowRunStageAttempt(
        specName,
        'atomize',
        {
          label: 'job_complete',
          startedAt: job.startedAt || new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 0,
          stream: false,
          usage: null,
          llmContext: describeLlmConfig(getActiveLlmConfig()),
          meta: {
            total: originalTasks.length,
            completed: doneIndices.size,
          },
          error: null,
        },
        { reason: flowRunReason },
      );
      try {
        const reportPath = finalizeFlowReport(specName);
        if (reportPath) {
          logAtomize(job, `流程报告已生成：${reportPath}`);
        }
      } catch (error) {
        const message = truncateText(error?.message || String(error || ''), 240);
        logAtomize(job, `流程报告生成失败：${message}`);
      }
      return;
    }

    const remaining = Math.max(0, originalTasks.length - doneIndices.size);
    logAtomize(
      job,
      `本次分段完成（处理 ${processedThisRun} 条），已完成 ${doneIndices.size}/${originalTasks.length}，剩余 ${remaining} 条。`,
    );
  } catch (error) {
    job.running = false;
    job.error = error?.message || String(error);
    logAtomize(job, `原子化失败：${job.error}`);
  }
}

async function generateTasksWithModelAtomicLegacy(design, prompt) {
  assertValidLlmConfig(getActiveLlmConfig());

  const TARGET_MIN_TASKS = 40;
  const TARGET_MAX_TASKS = 160;
  const TASK_TIMEOUT_MS = Number(process.env.LLM_TASK_TIMEOUT_MS || 120000);

  const parseTasksFromAny = (raw) => {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return [];
    const payload = tryParseJson(text);
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    if (tasks.length > 0) return tasks;
    return [];
  };

  const looksLikeChinese = (line) => /[\u4e00-\u9fa5]/.test(String(line || ''));

  const normalizeTaskObject = (t) => {
    const obj = t && typeof t === 'object' ? t : null;
    if (!obj) return null;
    const title = String(obj.title || obj.task || obj.name || '').trim();
    const core = String(obj.core || obj.logic || obj.coreLogic || '').trim();
    const details = String(obj.details || obj.tech || obj.technical || obj.techDetails || '').trim();
    const ac = String(obj.ac || obj.acceptance || obj.criteria || '').trim();
    return { title, core, details, ac };
  };

  const validateTasks = (tasks, minCount = TARGET_MIN_TASKS) => {
    if (!Array.isArray(tasks) || tasks.length < minCount) return { ok: false, error: 'too_few' };
    const normalized = tasks.map(normalizeTaskObject).filter(Boolean);
    if (normalized.length < minCount) return { ok: false, error: 'invalid_shape' };
    const missingFields = normalized.some((t) => !t.title || !t.core || !t.details || !t.ac);
    if (missingFields) return { ok: false, error: 'missing_fields' };
    const notChinese = normalized.some((t) => !looksLikeChinese(t.title + t.core + t.details + t.ac));
    if (notChinese) return { ok: false, error: 'not_zh' };
    const invalidAction = normalized.some((t) => !/^(创建|修改|删除)\s+\S+/.test(t.title));
    if (invalidAction) return { ok: false, error: 'invalid_action' };
    const invalidPath = normalized.some(
      (t) =>
        !(
          /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(t.title) ||
          /\\/.test(t.title)
        ),
    );
    if (invalidPath) return { ok: false, error: 'no_paths' };

    return { ok: true, tasks: normalized };
  };

  const baseSystem =
    'Role: 硬核工程架构师 (Hardcore Engineering Lead)。你擅长把设计文档拆解为 A计划的“原子级执行指令”。只输出 JSON，不要解释，不要包含分析或思考过程。';

  const baseRequirement = (minCount, maxCount) =>
    `要求：\n` +
    `1) 输出不再是“任务摘要”，而是“原子级执行指令”。严格遵守：定义 Types/Interfaces -> 数据库 Schema -> 基础 Utils/Storage -> UI 静态组件 -> 状态管理 -> 交互逻辑 -> 边界自愈。\n` +
    `2) 数量：${minCount}-${maxCount} 条。\n` +
    `3) [文件锁定]：每个任务 title 必须以“创建/修改/删除 <文件路径>”开头，严禁模糊动词。\n` +
    `4) [15分钟原则]：单任务保证 AI Agent 15 分钟内可完成；涉及两条以上逻辑分支必须拆分。\n` +
    `5) [定义先行]：禁止在定义数据结构之前编写业务逻辑。\n` +
    `6) [禁止自由发挥]：核心逻辑中必须写出函数名/变量名/组件 Prop 名称；涉及样式需写明 CSS 类名或布局方案。\n` +
    `7) 每个任务必须是一个对象：\n` +
    `   - title: 字符串，格式："<动作> <文件路径>｜<目的/产出>｜验证：<可执行验证>"\n` +
    `   - core: 字符串，写清函数签名/步骤/变量名\n` +
    `   - details: 字符串，写清依赖、API、命令、CSS 类名等\n` +
    `   - ac: 字符串，写清验收标准（如何证明成功）\n` +
    `8) 任务必须为简体中文。\n` +
    `9) 如果某些文件路径不确定：不要用 TBD；改为创建/修改 docs/assumptions.md 记录“待确认点：...”并先补齐可执行信息。\n`;

  const PHASE_MIN_TASKS = Number(process.env.LLM_TASK_PHASE_MIN || 6);
  const PHASE_MAX_TASKS = Number(process.env.LLM_TASK_PHASE_MAX || 18);
  const phases = [
    { key: 'types', label: '类型/接口定义', hint: 'Types/Interfaces/DTO/Schema 基础定义' },
    { key: 'schema', label: '数据模型/Schema', hint: '数据库/Schema/迁移/实体定义（如有）' },
    { key: 'utils', label: '基础工具与存储', hint: 'utils/storage/config/常量/校验' },
    { key: 'ui', label: 'UI 静态组件', hint: '页面结构/组件拆分/样式/布局' },
    { key: 'state', label: '状态管理', hint: '状态容器/数据流/缓存/派生数据' },
    { key: 'interaction', label: '交互逻辑', hint: '事件处理/表单/交互流程' },
    { key: 'edge', label: '边界与异常', hint: '错误处理/提示/兜底/可观测性' },
    { key: 'test', label: '验证与自测', hint: '最小可执行的验证步骤/测试脚本' },
  ];

  const validateTasksWithMin = (tasks, minCount) => validateTasks(tasks, minCount);

  const generatePhaseTasks = async (phase) => {
    const content = await callLlm(
      [
        { role: 'system', content: baseSystem },
        {
          role: 'user',
          content:
            `设计内容如下：\n${design || ''}\n\n补充描述：${prompt}\n\n` +
            `当前阶段：${phase.label}（${phase.hint}）。只输出该阶段的任务。\n` +
            '请严格输出 JSON：{"tasks":[...]}。\n' +
            baseRequirement(PHASE_MIN_TASKS, PHASE_MAX_TASKS) +
            `示例（仅格式示例，不要照抄）：\n` +
            `{ "title": "创建 src/types/note.ts｜产出：Note 类型定义｜验证：tsc 通过", "core": "export interface Note { id: string; ... }", "details": "字段：id/content/...；命名：Note；不引入外部依赖", "ac": "其他模块可 import { Note } 并通过编译" }\n` +
            '不要输出除 JSON 以外的任何内容。',
        },
      ],
      { timeoutMs: TASK_TIMEOUT_MS },
    );

    let tasks = parseTasksFromAny(content);
    let verdict = validateTasksWithMin(tasks, PHASE_MIN_TASKS);
    if (!verdict.ok) {
      const repair = await callLlm(
        [
          { role: 'system', content: baseSystem },
          {
            role: 'user',
            content:
              `你上一次输出不符合要求（原因：${verdict.error}）。请直接重做并严格输出 JSON：{"tasks":[...]}。\n` +
              `数量：${PHASE_MIN_TASKS}-${PHASE_MAX_TASKS}。\n` +
              `每个 tasks[i] 必须是对象：{title, core, details, ac}。\n` +
              `title 必须以“创建/修改/删除 <文件路径>”开头，并包含“验证：...”。\n` +
              `core/details/ac 必须是简体中文且具体可执行。\n\n` +
              baseRequirement(PHASE_MIN_TASKS, PHASE_MAX_TASKS) +
              `原始输出：\n${content}\n`,
          },
        ],
        { timeoutMs: TASK_TIMEOUT_MS },
      );
      tasks = parseTasksFromAny(repair);
      verdict = validateTasksWithMin(tasks, PHASE_MIN_TASKS);
    }

    if (!verdict.ok) {
      throw new Error('LLM tasks output invalid');
    }

    const firstPass = verdict.tasks;
    const expandContent = await callLlm(
      [
        { role: 'system', content: baseSystem },
        {
          role: 'user',
          content:
            `以下是当前阶段的初版任务（JSON）：\n${JSON.stringify(firstPass)}\n\n` +
            '请执行“二次展开”：将每条任务进一步拆分为 15 分钟内可完成的原子任务；若已足够原子则保留。\n' +
            '要求：保持原有执行顺序，输出格式仍为 JSON：{"tasks":[...]}。\n' +
            baseRequirement(PHASE_MIN_TASKS, PHASE_MAX_TASKS) +
            '不要输出除 JSON 以外的任何内容。',
        },
      ],
      { timeoutMs: TASK_TIMEOUT_MS },
    );

    let expanded = parseTasksFromAny(expandContent);
    let expandVerdict = validateTasksWithMin(expanded, PHASE_MIN_TASKS);
    if (!expandVerdict.ok) {
      const repairExpand = await callLlm(
        [
          { role: 'system', content: baseSystem },
          {
            role: 'user',
            content:
              `你上一次二次展开输出不符合要求（原因：${expandVerdict.error}）。请直接重做并严格输出 JSON：{"tasks":[...]}。\n` +
              `数量：${PHASE_MIN_TASKS}-${PHASE_MAX_TASKS}。\n` +
              `每个 tasks[i] 必须是对象：{title, core, details, ac}。\n` +
              `title 必须以“创建/修改/删除 <文件路径>”开头，并包含“验证：...”。\n` +
              `core/details/ac 必须是简体中文且具体可执行。\n\n` +
              baseRequirement(PHASE_MIN_TASKS, PHASE_MAX_TASKS) +
              `原始输出：\n${expandContent}\n`,
          },
        ],
        { timeoutMs: TASK_TIMEOUT_MS },
      );
      expanded = parseTasksFromAny(repairExpand);
      expandVerdict = validateTasksWithMin(expanded, PHASE_MIN_TASKS);
    }

    if (!expandVerdict.ok) {
      throw new Error('LLM tasks output invalid');
    }

    return expandVerdict.tasks;
  };

  const allTasks = [];
  for (const phase of phases) {
    const phaseTasks = await generatePhaseTasks(phase);
    allTasks.push(...phaseTasks);
  }

  if (allTasks.length < TARGET_MIN_TASKS) {
    const needed = Math.max(6, TARGET_MIN_TASKS - allTasks.length);
    const extra = await callLlm(
      [
        { role: 'system', content: baseSystem },
        {
          role: 'user',
          content:
            `当前任务数量不足（现有 ${allTasks.length}）。请补充 ${needed}-${Math.min(needed + 10, PHASE_MAX_TASKS)} 条遗漏任务。\n` +
            `设计内容如下：\n${design || ''}\n\n补充描述：${prompt}\n\n` +
            '请严格输出 JSON：{"tasks":[...]}。\n' +
            baseRequirement(needed, Math.min(needed + 10, PHASE_MAX_TASKS)) +
            '不要输出除 JSON 以外的任何内容。',
        },
      ],
      { timeoutMs: TASK_TIMEOUT_MS },
    );
    const extraTasks = parseTasksFromAny(extra);
    const extraVerdict = validateTasksWithMin(extraTasks, needed);
    if (extraVerdict.ok) {
      allTasks.push(...extraVerdict.tasks);
    }
  }

  const finalVerdict = validateTasksWithMin(allTasks, TARGET_MIN_TASKS);
  if (!finalVerdict.ok) {
    throw new Error('LLM tasks output invalid');
  }

  return buildTasksMarkdown(prompt || design, { tasks: finalVerdict.tasks });
}

function ensureSpecTemplate(name, artifact) {
  const filePath = resolveSpecFile(name, artifact);
  if (!fs.existsSync(filePath)) {
    writeSpecFile(name, artifact, SPEC_TEMPLATES[artifact]);
  }
}

function listSpecs() {
  const entries = fs.readdirSync(SPEC_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const specName = entry.name;
      const files = {};
      SPEC_ARTIFACTS.forEach((artifact) => {
        files[artifact] = fs.existsSync(resolveSpecFile(specName, artifact));
      });
      let status = readSpecStatus(specName);
      if (files.requirements) {
        try {
          const requirementsMarkdown = fs.readFileSync(resolveSpecFile(specName, 'requirements'), 'utf8');
          status = ensureRequirementsReviewSeeded(specName, status, requirementsMarkdown).status;
        } catch {
          // ignore seeding failures
        }
      }
      if (files.design) {
        try {
          const designMarkdown = fs.readFileSync(resolveSpecFile(specName, 'design'), 'utf8');
          status = ensureTechStackClarificationsSeeded(specName, status, status.prompt, designMarkdown).status;
        } catch {
          // ignore seeding failures
        }
      }
      return { name: specName, files, status };
    });
}

async function createSpecTemplates(name, artifacts = ['requirements'], prompt = '', options = {}) {
  fs.mkdirSync(resolveSpecDir(name), { recursive: true });
  ensureSpecStatus(name, prompt ? { prompt } : null);
  if (prompt) {
    const status = readSpecStatus(name);
    const nextStatus = status.prompt !== prompt ? { ...status, prompt } : status;
    if (nextStatus !== status) writeSpecStatus(name, nextStatus);
    ensureActiveFlowRun(name, nextStatus, { forceNew: true, reason: 'spec:create' });
  }
  const onLlmToken = typeof options?.onLlmToken === 'function' ? options.onLlmToken : null;
  const onStage = typeof options?.onStage === 'function' ? options.onStage : null;
  const onTelemetry = (attempt) => {
    const stageKey = String(attempt?.stageKey || '').trim();
    if (!stageKey) return;
    appendFlowRunStageAttempt(name, stageKey, attempt, { reason: 'spec:create' });
  };

  const categoryPromise = prompt
    ? (async () => {
        try {
          return await inferProjectCategoryFromModel(prompt, { onTelemetry });
        } catch {
          return null;
        }
      })()
    : null;

  for (const artifact of artifacts) {
    if (SPEC_ARTIFACTS.includes(artifact)) {
      if (artifact === 'requirements') {
        onStage?.('requirementsClarifications', 'start');
        let clarifications = null;
        try {
          clarifications = await generateClarificationsWithModel(prompt, {
            onToken: onLlmToken
              ? (delta) => onLlmToken('requirementsClarifications', delta)
              : null,
            onTelemetry,
          });
        } catch (error) {
          const fallbackQuestions = buildDefaultRequirementsClarificationQuestions(prompt);
          clarifications = {
            questions: fallbackQuestions,
            generatedBy: 'default',
            generationError: error?.message || 'Clarifications generation failed',
          };
        }
        onStage?.('requirementsClarifications', 'end');
        const normalizedClarifications = normalizeRequirementsClarifications(clarifications);
        const nextStatus = readSpecStatus(name);
        nextStatus.requirementsClarifications = {
          ...nextStatus.requirementsClarifications,
          questions: normalizedClarifications.questions.length
            ? normalizedClarifications.questions
            : [],
          generatedBy:
            typeof clarifications?.generatedBy === 'string' && clarifications.generatedBy
              ? clarifications.generatedBy
              : 'llm',
          generationError:
            typeof clarifications?.generationError === 'string' && clarifications.generationError
              ? clarifications.generationError
              : null,
          updatedAt: new Date().toISOString(),
          confirmedAt: nextStatus.requirementsClarifications?.confirmedAt ?? null,
        };
        writeSpecStatus(name, nextStatus);
      } else {
        ensureSpecTemplate(name, artifact);
      }
    }
  }

  if (categoryPromise) {
    const result = await categoryPromise;
    const fallbackCategory = inferProjectCategoryFromPrompt(prompt);
    const decided = result?.projectCategory || fallbackCategory;
    const now = new Date().toISOString();
    const status = readSpecStatus(name);
    const nextStatus = {
      ...status,
      projectCategory: decided,
      projectCategoryMeta: result
        ? { ...result, judgedAt: now, source: 'llm' }
        : { projectCategory: decided, confidence: null, reason: '', judgedAt: now, source: 'heuristic' },
      techStackConfirmed: decided === 'non_software' ? true : status.techStackConfirmed,
    };
    writeSpecStatus(name, nextStatus);
  }
}

function appendEvent(event) {
  fs.appendFile(EVENT_LOG, `${JSON.stringify(event)}\n`, (err) => {
    if (err) {
      // Keep server alive even if logging fails.
      console.error('Failed to append event log:', err.message);
    }
  });
}

function applyEventToState(event) {
  switch (event.type) {
    case 'status:update':
      state.status = event.payload.status;
      break;
    case 'task:graph':
      state.tasks = event.payload;
      break;
    case 'diff:preview':
      state.lastDiff = event.payload;
      break;
    case 'approval:request':
      state.approvals[event.payload.id] = event.payload;
      state.status = 'Reviewing';
      pauseProcessIfNeeded();
      break;
    case 'approval:resolve':
      delete state.approvals[event.payload.id];
      if (Object.keys(state.approvals).length === 0) {
        state.status = 'Thinking';
        resumeProcessIfNeeded();
      }
      break;
    case 'test:report':
      state.testReport = event.payload;
      break;
    case 'log:append':
      state.logs.push(event.payload);
      if (state.logs.length > 200) {
        state.logs.shift();
      }
      break;
    default:
      break;
  }
}

function emitEvent(type, payload) {
  const event = {
    id: nanoid(),
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
  applyEventToState(event);
  appendEvent(event);
  io.emit('event', event);
  return event;
}

function isTextFile(buffer) {
  const sample = buffer.subarray(0, 8000);
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
  }
  return true;
}

function emitDiff(filePath, beforeContent, afterContent) {
  const patch = createTwoFilesPatch(
    filePath,
    filePath,
    beforeContent || '',
    afterContent || '',
    'before',
    'after',
    { context: 3 },
  );
  const diff = patch.length > MAX_DIFF_CHARS
    ? `${patch.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated)`
    : patch;
  emitEvent('diff:preview', { filePath, diff });
}

function handleFileChange(eventType, absolutePath) {
  const relativePath = path.relative(ROOT_DIR, absolutePath);
  if (!relativePath || relativePath.startsWith('..')) {
    return;
  }

  let nextContent = '';
  try {
    const buffer = fs.readFileSync(absolutePath);
    if (!isTextFile(buffer)) {
      emitEvent('log:append', {
        source: 'watcher',
        message: `[${eventType}] ${relativePath} (binary skipped)`,
      });
      return;
    }
    nextContent = buffer.toString('utf8');
  } catch (error) {
    emitEvent('log:append', {
      source: 'watcher',
      message: `[${eventType}] ${relativePath} (read failed)`,
    });
    return;
  }

  let prevContent = fileSnapshots.get(absolutePath);
  if (prevContent === undefined && eventType === 'file added') {
    prevContent = '';
  }
  fileSnapshots.set(absolutePath, nextContent);

  emitEvent('log:append', {
    source: 'watcher',
    message: `[${eventType}] ${relativePath}`,
  });

  if (prevContent !== undefined && prevContent !== nextContent) {
    emitDiff(relativePath, prevContent, nextContent);
  }
}

let ptyProcess = null;

const terminalSessions = new Map();
const TERMINAL_BUFFER_LIMIT = 120;

const DEFAULT_WORKSPACE_CONFIG = { defaultCwd: null };

function readWorkspaceConfig() {
  if (!fs.existsSync(WORKSPACE_CONFIG_FILE)) {
    return { ...DEFAULT_WORKSPACE_CONFIG };
  }
  try {
    const raw = fs.readFileSync(WORKSPACE_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_WORKSPACE_CONFIG, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_WORKSPACE_CONFIG };
  }
}

function writeWorkspaceConfig(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const defaultCwd =
    typeof next?.defaultCwd === 'string'
      ? next.defaultCwd
      : next?.defaultCwd == null
        ? null
        : DEFAULT_WORKSPACE_CONFIG.defaultCwd;
  fs.writeFileSync(
    WORKSPACE_CONFIG_FILE,
    JSON.stringify({ ...DEFAULT_WORKSPACE_CONFIG, defaultCwd }, null, 2),
    'utf8',
  );
}

function resolveExistingDirectory(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const resolved = path.resolve(trimmed);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

function getDefaultWorkspaceCwd() {
  const cfg = readWorkspaceConfig();
  const candidates = [
    resolveExistingDirectory(cfg?.defaultCwd),
    resolveExistingDirectory(process.env.WORKFLOW_DEFAULT_CWD || ''),
    resolveExistingDirectory(DEFAULT_TESTCLI_DIR),
    resolveExistingDirectory(REPO_DIR),
  ].filter(Boolean);
  return candidates[0] || REPO_DIR;
}

function normalizeTerminalTitle(value) {
  if (typeof value !== 'string') return 'Terminal';
  const trimmed = value.trim();
  if (!trimmed) return 'Terminal';
  return trimmed.slice(0, 80);
}

function normalizeTerminalCommand(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 400) return null;
  if (trimmed.includes('\0')) return null;
  return trimmed;
}

function normalizeTerminalArgs(value) {
  if (!Array.isArray(value)) return [];
  const args = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw;
    if (!trimmed) continue;
    if (trimmed.length > 2000) continue;
    if (trimmed.includes('\0')) continue;
    args.push(trimmed);
    if (args.length >= 60) break;
  }
  return args;
}

function normalizeTerminalEnv(value) {
  const obj = value && typeof value === 'object' ? value : null;
  if (!obj) return null;
  const env = {};
  for (const [key, val] of Object.entries(obj)) {
    const envKey = sanitizeEnvVarName(key);
    if (!envKey) continue;
    const envVal = typeof val === 'string' ? val : val == null ? '' : String(val);
    env[envKey] = envVal.slice(0, 2000);
  }
  return env;
}

function normalizeTerminalCwd(value) {
  if (typeof value !== 'string') return getDefaultWorkspaceCwd();
  const trimmed = value.trim();
  if (!trimmed) return getDefaultWorkspaceCwd();
  try {
    const resolved = path.resolve(trimmed);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return resolved;
  } catch {
    // ignore
  }
  return getDefaultWorkspaceCwd();
}

function normalizeTerminalSize(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  if (int <= 0) return fallback;
  if (int > 600) return 600;
  return int;
}

function listTerminalSessions() {
  return Array.from(terminalSessions.values()).map((t) => ({
    id: t.id,
    title: t.title,
    pid: t.pid,
    command: t.command,
    args: t.args,
    cwd: t.cwd,
    running: t.running,
    createdAt: t.createdAt,
    exitedAt: t.exitedAt,
    exitCode: t.exitCode,
  }));
}

function getTerminalSession(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  return terminalSessions.get(id) || null;
}

function createTerminalSession(options) {
  const toolId = normalizeCliToolId(options?.toolId);
  const tool = toolId
    ? loadCliToolsConfig().tools.find((t) => String(t.id || '') === toolId) || null
    : null;
  if (toolId && !tool) {
    const error = new Error(`cli tool not found: ${toolId}`);
    error.status = 404;
    throw error;
  }

  const command = normalizeTerminalCommand(tool?.command ?? options?.command);
  if (!command) {
    const error = new Error('command is required');
    error.status = 400;
    throw error;
  }

  const id = nanoid();
  const title = normalizeTerminalTitle(options?.title ?? tool?.label);
  const args = tool ? normalizeTerminalArgs(tool.args) : normalizeTerminalArgs(options?.args);
  const cwd = normalizeTerminalCwd(options?.cwd);
  const cols = normalizeTerminalSize(options?.cols, 120);
  const rows = normalizeTerminalSize(options?.rows, 30);

  const mergedEnv = { ...process.env };
  if (tool?.env && typeof tool.env === 'object') {
    Object.assign(mergedEnv, tool.env);
  }
  if (tool?.baseUrl && tool?.baseUrlEnvKey) {
    mergedEnv[tool.baseUrlEnvKey] = String(tool.baseUrl);
  }
  if (tool?.apiKey && tool?.apiKeyEnvKey) {
    mergedEnv[tool.apiKeyEnvKey] = String(tool.apiKey);
  }
  const extraEnv = normalizeTerminalEnv(options?.env);
  if (extraEnv) {
    Object.assign(mergedEnv, extraEnv);
  }

  const proc = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: mergedEnv,
  });

  const session = {
    id,
    title,
    command,
    args,
    cwd,
    pid: proc.pid,
    running: true,
    createdAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
    seq: 0,
    buffer: [],
    proc,
  };

  terminalSessions.set(id, session);
  io.emit('terminal:created', {
    terminal: {
      id: session.id,
      title: session.title,
      pid: session.pid,
      command: session.command,
      args: session.args,
      cwd: session.cwd,
      running: session.running,
      createdAt: session.createdAt,
      exitedAt: session.exitedAt,
      exitCode: session.exitCode,
    },
  });

  proc.onData((data) => {
    const item = { seq: (session.seq += 1), data };
    session.buffer.push(item);
    if (session.buffer.length > TERMINAL_BUFFER_LIMIT) {
      session.buffer.splice(0, session.buffer.length - TERMINAL_BUFFER_LIMIT);
    }
    io.emit('terminal:data', { terminalId: id, seq: item.seq, data });
  });

  proc.onExit(({ exitCode }) => {
    session.running = false;
    session.exitedAt = new Date().toISOString();
    session.exitCode = typeof exitCode === 'number' ? exitCode : null;
    io.emit('terminal:exit', {
      terminalId: id,
      exitCode: session.exitCode ?? -1,
    });
  });

  return session;
}

function writeTerminalInput(session, input) {
  if (!session?.proc || !session.running) return;
  if (typeof input !== 'string' || !input) return;
  session.proc.write(input);
}

function resizeTerminal(session, cols, rows) {
  if (!session?.proc || !session.running) return;
  const nextCols = normalizeTerminalSize(cols, null);
  const nextRows = normalizeTerminalSize(rows, null);
  if (!nextCols || !nextRows) return;
  try {
    session.proc.resize(nextCols, nextRows);
  } catch {
    // ignore resize errors
  }
}

function killTerminal(session) {
  if (!session?.proc) return;
  try {
    session.proc.kill();
  } catch {
    // ignore
  }
}

function pauseProcessIfNeeded() {
  if (!ptyProcess || isPaused) {
    return;
  }

  if (process.platform === 'win32') {
    isPaused = true;
    emitEvent('log:append', {
      source: 'approval',
      message: '[approval] Pause requested (manual pause on Windows)',
    });
    return;
  }

  try {
    process.kill(ptyProcess.pid, 'SIGTSTP');
    isPaused = true;
    emitEvent('log:append', {
      source: 'approval',
      message: '[approval] Process paused',
    });
  } catch (error) {
    emitEvent('log:append', {
      source: 'approval',
      message: `[approval] Pause failed: ${error.message}`,
    });
  }
}

function resumeProcessIfNeeded() {
  if (!ptyProcess || !isPaused) {
    return;
  }

  if (process.platform === 'win32') {
    isPaused = false;
    emitEvent('log:append', {
      source: 'approval',
      message: '[approval] Resume requested (manual resume on Windows)',
    });
    return;
  }

  try {
    process.kill(ptyProcess.pid, 'SIGCONT');
    isPaused = false;
    emitEvent('log:append', {
      source: 'approval',
      message: '[approval] Process resumed',
    });
  } catch (error) {
    emitEvent('log:append', {
      source: 'approval',
      message: `[approval] Resume failed: ${error.message}`,
    });
  }
}

function startPty(command, args, options = {}) {
  if (ptyProcess) {
    ptyProcess.kill();
    ptyProcess = null;
  }

  const shell = process.env.SHELL || 'powershell.exe';
  const resolvedCommand = command || shell;
  const resolvedArgs = args && args.length ? args : [];
  const requestedCwd = typeof options?.cwd === 'string' ? options.cwd : '';
  const fallbackCwd = getDefaultWorkspaceCwd();
  const spawnCwd = resolveExistingDirectory(requestedCwd) || fallbackCwd;

  ptyProcess = pty.spawn(resolvedCommand, resolvedArgs, {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: spawnCwd,
    env: process.env,
  });

  emitEvent('status:update', { status: 'Executing' });

  ptyProcess.onData((data) => {
    emitEvent('log:append', { source: 'pty', message: data });
  });

  ptyProcess.onExit(({ exitCode }) => {
    emitEvent('log:append', {
      source: 'pty',
      message: `\n[process exited: ${exitCode}]\n`,
    });
    emitEvent('status:update', { status: 'Thinking' });
    ptyProcess = null;
    isPaused = false;
  });

  return ptyProcess.pid;
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/workspace', (req, res) => {
  const cfg = readWorkspaceConfig();
  res.json({
    defaultCwd: typeof cfg?.defaultCwd === 'string' ? cfg.defaultCwd : null,
    effectiveCwd: getDefaultWorkspaceCwd(),
    repoDir: REPO_DIR,
  });
});

app.post('/workspace', (req, res) => {
  const raw = req.body?.defaultCwd;
  if (raw == null || (typeof raw === 'string' && !raw.trim())) {
    writeWorkspaceConfig({ defaultCwd: null });
    return res.json({
      ok: true,
      defaultCwd: null,
      effectiveCwd: getDefaultWorkspaceCwd(),
    });
  }
  if (typeof raw !== 'string') {
    return res.status(400).json({ error: 'defaultCwd must be a string or null' });
  }
  const resolved = resolveExistingDirectory(raw);
  if (!resolved) {
    return res.status(400).json({ error: 'Directory not found' });
  }
  writeWorkspaceConfig({ defaultCwd: resolved });
  return res.json({
    ok: true,
    defaultCwd: resolved,
    effectiveCwd: getDefaultWorkspaceCwd(),
  });
});

function listWindowsDriveRoots() {
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\\\`;
    try {
      if (fs.existsSync(root)) roots.push(root);
    } catch {
      // ignore
    }
  }
  return roots;
}

function listDirectoryDirs(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry?.isDirectory?.()) continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    dirs.push(name);
  }
  dirs.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  return dirs;
}

function sanitizeFsEntryName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.length > 120) return null;
  if (/[<>:"/\\|?*\u0000-\u001F]/.test(trimmed)) return null;
  return trimmed;
}

function isRootPath(value) {
  try {
    const resolved = path.resolve(value);
    const root = path.parse(resolved).root;
    return resolved === root;
  } catch {
    return false;
  }
}

function resolveExistingPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const resolved = path.resolve(trimmed);
    fs.lstatSync(resolved);
    return resolved;
  } catch {
    return null;
  }
}

function listDirectoryEntries(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const list = [];
  for (const entry of entries) {
    const name = String(entry?.name || '').trim();
    if (!name) continue;
    const fullPath = path.join(dirPath, name);
    if (entry.isDirectory()) {
      list.push({ name, path: fullPath, type: 'dir' });
      continue;
    }
    if (entry.isFile()) {
      list.push({ name, path: fullPath, type: 'file' });
      continue;
    }
  }
  list.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
  return list;
}

function normalizePathKey(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function isDescendantPath(parentPath, childPath) {
  try {
    const parent = path.resolve(parentPath);
    const child = path.resolve(childPath);
    const parentKey = normalizePathKey(parent).replace(/\\+$/, '') + '\\';
    const childKey = normalizePathKey(child);
    return childKey.startsWith(parentKey);
  } catch {
    return false;
  }
}

app.get('/fs/dirs', (req, res) => {
  const raw = typeof req.query?.path === 'string' ? req.query.path.trim() : '';
  if (!raw) {
    if (process.platform === 'win32') {
      const roots = listWindowsDriveRoots();
      return res.json({
        path: null,
        parent: null,
        dirs: roots.map((p) => ({ name: p, path: p })),
      });
    }
    const root = resolveExistingDirectory('/');
    if (!root) return res.status(500).json({ error: 'Root directory not found' });
    return res.json({
      path: root,
      parent: null,
      dirs: listDirectoryDirs(root).map((name) => ({ name, path: path.join(root, name) })),
    });
  }

  const current = resolveExistingDirectory(raw);
  if (!current) {
    return res.status(400).json({ error: 'Directory not found' });
  }

  const parentPath = path.dirname(current);
  const hasParent = Boolean(parentPath && parentPath !== current);
  return res.json({
    path: current,
    parent: hasParent ? parentPath : null,
    dirs: listDirectoryDirs(current).map((name) => ({ name, path: path.join(current, name) })),
  });
});

app.get('/fs/list', (req, res) => {
  const raw = typeof req.query?.path === 'string' ? req.query.path.trim() : '';
  if (!raw) {
    if (process.platform === 'win32') {
      const roots = listWindowsDriveRoots();
      return res.json({
        path: null,
        parent: null,
        entries: roots.map((p) => ({ name: p, path: p, type: 'dir' })),
      });
    }
    const root = resolveExistingDirectory('/');
    if (!root) return res.status(500).json({ error: 'Root directory not found' });
    return res.json({
      path: root,
      parent: null,
      entries: listDirectoryEntries(root),
    });
  }

  const current = resolveExistingDirectory(raw);
  if (!current) {
    return res.status(400).json({ error: 'Directory not found' });
  }
  const parentPath = path.dirname(current);
  const hasParent = Boolean(parentPath && parentPath !== current);
  return res.json({
    path: current,
    parent: hasParent ? parentPath : null,
    entries: listDirectoryEntries(current),
  });
});

app.post('/fs/mkdir', (req, res) => {
  const parent = resolveExistingDirectory(req.body?.parent);
  if (!parent) return res.status(400).json({ error: 'parent is required' });
  const name = sanitizeFsEntryName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Invalid folder name' });
  const target = path.join(parent, name);
  try {
    if (fs.existsSync(target)) {
      return res.status(409).json({ error: 'Already exists' });
    }
    fs.mkdirSync(target, { recursive: false });
    return res.json({ ok: true, path: target });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to create directory' });
  }
});

app.post('/fs/touch', (req, res) => {
  const parent = resolveExistingDirectory(req.body?.parent);
  if (!parent) return res.status(400).json({ error: 'parent is required' });
  const name = sanitizeFsEntryName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Invalid file name' });
  const target = path.join(parent, name);
  try {
    if (fs.existsSync(target)) {
      return res.status(409).json({ error: 'Already exists' });
    }
    fs.writeFileSync(target, '', 'utf8');
    return res.json({ ok: true, path: target });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to create file' });
  }
});

app.post('/fs/paste', (req, res) => {
  const src = resolveExistingPath(req.body?.srcPath);
  if (!src) return res.status(400).json({ error: 'srcPath not found' });
  const destDir = resolveExistingDirectory(req.body?.destDir);
  if (!destDir) return res.status(400).json({ error: 'destDir not found' });
  const modeRaw = typeof req.body?.mode === 'string' ? req.body.mode.trim() : '';
  const mode = modeRaw === 'cut' ? 'cut' : 'copy';

  const base = path.basename(src);
  const dest = path.join(destDir, base);
  if (fs.existsSync(dest)) {
    return res.status(409).json({ error: 'Destination already exists' });
  }
  if (isDescendantPath(src, destDir)) {
    return res.status(400).json({ error: 'Refuse to paste into its own subdirectory' });
  }

  try {
    const stat = fs.lstatSync(src);
    if (mode === 'cut') {
      try {
        fs.renameSync(src, dest);
        return res.json({ ok: true, path: dest, mode });
      } catch (error) {
        // cross-device move: fallback to copy+delete
        if (!stat.isDirectory()) {
          fs.copyFileSync(src, dest);
          fs.rmSync(src, { force: true });
          return res.json({ ok: true, path: dest, mode });
        }
        fs.cpSync(src, dest, { recursive: true, errorOnExist: true });
        fs.rmSync(src, { recursive: true, force: true });
        return res.json({ ok: true, path: dest, mode });
      }
    }

    if (!stat.isDirectory()) {
      fs.copyFileSync(src, dest);
      return res.json({ ok: true, path: dest, mode });
    }
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true });
    return res.json({ ok: true, path: dest, mode });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to paste' });
  }
});

app.post('/fs/rename', (req, res) => {
  const existing = resolveExistingPath(req.body?.path);
  if (!existing) return res.status(400).json({ error: 'path not found' });
  const newName = sanitizeFsEntryName(req.body?.newName);
  if (!newName) return res.status(400).json({ error: 'Invalid newName' });
  const parent = path.dirname(existing);
  const target = path.join(parent, newName);
  try {
    if (fs.existsSync(target)) {
      return res.status(409).json({ error: 'Already exists' });
    }
    fs.renameSync(existing, target);
    return res.json({ ok: true, path: target });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to rename' });
  }
});

app.post('/fs/delete', (req, res) => {
  const existing = resolveExistingPath(req.body?.path);
  if (!existing) return res.status(400).json({ error: 'path not found' });
  if (isRootPath(existing)) {
    return res.status(400).json({ error: 'Refuse to delete root path' });
  }
  try {
    fs.rmSync(existing, { recursive: true, force: true });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to delete' });
  }
});

app.get('/terminals', (req, res) => {
  res.json({ terminals: listTerminalSessions() });
});

app.get('/terminals/:id/buffer', (req, res) => {
  const session = getTerminalSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Terminal not found' });
  }
  return res.json({
    terminal: {
      id: session.id,
      title: session.title,
      pid: session.pid,
      running: session.running,
      createdAt: session.createdAt,
      exitedAt: session.exitedAt,
      exitCode: session.exitCode,
    },
    buffer: session.buffer,
  });
});

app.post('/terminals', (req, res) => {
  if (state.status === 'Reviewing') {
    return res.status(409).json({ error: 'Blocked by approval' });
  }
  try {
    const session = createTerminalSession(req.body || {});
    return res.json({
      id: session.id,
      pid: session.pid,
      title: session.title,
    });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'Failed to create terminal' });
  }
});

app.post('/terminals/:id/input', (req, res) => {
  const session = getTerminalSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Terminal not found' });
  }
  writeTerminalInput(session, req.body?.input);
  return res.json({ ok: true });
});

app.post('/terminals/:id/resize', (req, res) => {
  const session = getTerminalSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Terminal not found' });
  }
  resizeTerminal(session, req.body?.cols, req.body?.rows);
  return res.json({ ok: true });
});

app.delete('/terminals/:id', (req, res) => {
  const session = getTerminalSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Terminal not found' });
  }
  killTerminal(session);
  terminalSessions.delete(session.id);
  return res.json({ ok: true });
});

app.get('/cli-tools', (req, res) => {
  const cfg = loadCliToolsConfig();
  return res.json({ tools: cfg.tools.map(toPublicCliTool) });
});

app.post('/cli-tools', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!label) return res.status(400).json({ error: 'label is required' });
    if (!command) return res.status(400).json({ error: 'command is required' });

    const cfg = loadCliToolsConfig();
    const used = new Set(cfg.tools.map((t) => String(t.id || '')));

    const requestedId = normalizeCliToolId(body.id);
    const baseId = requestedId || normalizeCliToolId(label) || normalizeCliToolId(command);
    if (!baseId) return res.status(400).json({ error: 'id is required' });

    let id = baseId;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${baseId}-${n}`)) n += 1;
      id = `${baseId}-${n}`;
    }

    const nextTool = normalizeCliToolInput(body, { id });
    if (!nextTool.label) return res.status(400).json({ error: 'Invalid label' });
    if (!nextTool.command) return res.status(400).json({ error: 'Invalid command' });

    cfg.tools.push(nextTool);
    const persisted = persistCliToolsConfig(cfg);
    const created = persisted.tools.find((t) => t.id === id);
    return res.json({ ok: true, tool: toPublicCliTool(created || nextTool) });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to create cli tool' });
  }
});

app.put('/cli-tools/:id', (req, res) => {
  try {
    const toolId = normalizeCliToolId(req.params.id);
    if (!toolId) return res.status(400).json({ error: 'Invalid tool id' });

    const cfg = loadCliToolsConfig();
    const idx = cfg.tools.findIndex((t) => String(t.id || '') === toolId);
    if (idx < 0) return res.status(404).json({ error: 'Tool not found' });

    const updated = normalizeCliToolInput(req.body, cfg.tools[idx]);
    if (!updated.label) return res.status(400).json({ error: 'Invalid label' });
    if (!updated.command) return res.status(400).json({ error: 'Invalid command' });

    cfg.tools[idx] = updated;
    const persisted = persistCliToolsConfig(cfg);
    const next = persisted.tools.find((t) => t.id === toolId) || updated;
    return res.json({ ok: true, tool: toPublicCliTool(next) });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to update cli tool' });
  }
});

app.post('/cli-tools/reset', (req, res) => {
  try {
    const persisted = persistCliToolsConfig(DEFAULT_CLI_TOOLS_CONFIG);
    return res.json({ ok: true, tools: persisted.tools.map(toPublicCliTool) });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to reset cli tools' });
  }
});

app.delete('/cli-tools/:id', (req, res) => {
  const toolId = normalizeCliToolId(req.params.id);
  if (!toolId) return res.status(400).json({ error: 'Invalid tool id' });
  const cfg = loadCliToolsConfig();
  const nextTools = cfg.tools.filter((t) => String(t.id || '') !== toolId);
  if (nextTools.length === cfg.tools.length) {
    return res.status(404).json({ error: 'Tool not found' });
  }
  persistCliToolsConfig({ ...cfg, tools: nextTools });
  return res.json({ ok: true });
});

app.get('/llm', (req, res) => {
  const { baseUrl, model, providerId, responseFormat } = getActiveLlmConfig();
  res.json({
    hasConfig: hasLlmConfig(),
    model: model || null,
    providerId: providerId || null,
    baseUrl: baseUrl || null,
    responseFormat: responseFormat || null,
    options: LLM_MODEL_OPTIONS,
    providers: LLM_PROVIDERS.map((provider) => {
      const directBaseUrl = getProviderEnv(provider.id, 'base_url');
      const directApiKey = getProviderEnv(provider.id, 'api_key');
      return {
        id: provider.id,
        label: provider.label,
        baseUrl: directBaseUrl || null,
        baseUrlPresent: Boolean(directBaseUrl),
        apiKeyPresent: Boolean(directApiKey),
      };
    }),
  });
});

app.get('/llm/ping', async (req, res) => {
  try {
    let model = typeof req.query?.model === 'string' ? req.query.model.trim() : '';
    if (!model) {
      model = (process.env.LLM_MODEL || '').trim();
    }
    if (LLM_MODEL_ALIASES[model]) model = LLM_MODEL_ALIASES[model];
    if (!isSupportedModel(model)) {
      return res.status(400).json({ ok: false, error: `Unsupported model: ${model}` });
    }

    const cfg = getLlmConfigForModel(model);
    if (!cfg.baseUrl || !cfg.apiKey) {
      return res.json({ ok: false, model, providerId: cfg.providerId, error: 'Missing baseUrl or apiKey' });
    }

    const startedAt = Date.now();
    await callLlm([{ role: 'user', content: 'ping' }], {
      ...cfg,
      timeoutMs: Number(process.env.LLM_PING_TIMEOUT_MS || 8000),
    });

    const latencyMs = Date.now() - startedAt;
    return res.json({ ok: true, model, providerId: cfg.providerId, latencyMs });
  } catch (error) {
    return res.json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/llm/provider', (req, res) => {
  try {
    const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId.trim() : '';
    if (!providerId || !LLM_PROVIDERS.some((p) => p.id === providerId)) {
      return res.status(400).json({ error: 'Invalid providerId' });
    }

    const hasBaseUrl = typeof req.body?.baseUrl === 'string';
    const hasApiKey = typeof req.body?.apiKey === 'string';
    if (!hasBaseUrl && !hasApiKey) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const existing = {};
    if (fs.existsSync(LLM_CONFIG_FILE)) {
      try {
        Object.assign(existing, JSON.parse(fs.readFileSync(LLM_CONFIG_FILE, 'utf8')));
      } catch {
        // ignore
      }
    }

    const providers = (existing.providers && typeof existing.providers === 'object')
      ? { ...existing.providers }
      : {};
    const currentProvider = (providers[providerId] && typeof providers[providerId] === 'object')
      ? { ...providers[providerId] }
      : {};

    if (hasBaseUrl) {
      currentProvider.baseUrl = String(req.body.baseUrl || '').trim();
    }
    if (hasApiKey) {
      currentProvider.apiKey = String(req.body.apiKey || '').trim();
    }

    providers[providerId] = currentProvider;
    persistLlmConfig({ providers });

    const envPrefix = `LLM_PROVIDER_${providerId.toUpperCase()}_`;
    if (hasBaseUrl) process.env[`${envPrefix}BASE_URL`] = currentProvider.baseUrl || '';
    if (hasApiKey) process.env[`${envPrefix}API_KEY`] = currentProvider.apiKey || '';

    emitEvent('log:append', {
      source: 'llm',
      message: `[llm] provider ${providerId} updated`,
    });

    const { baseUrl, model, providerId: activeProviderId, responseFormat } = getActiveLlmConfig();
    return res.json({
      hasConfig: hasLlmConfig(),
      model: model || null,
      providerId: activeProviderId || null,
      baseUrl: baseUrl || null,
      responseFormat: responseFormat || null,
      options: LLM_MODEL_OPTIONS,
      providers: LLM_PROVIDERS.map((provider) => {
        const directBaseUrl = getProviderEnv(provider.id, 'base_url');
        const directApiKey = getProviderEnv(provider.id, 'api_key');
        return {
          id: provider.id,
          label: provider.label,
          baseUrl: directBaseUrl || null,
          baseUrlPresent: Boolean(directBaseUrl),
          apiKeyPresent: Boolean(directApiKey),
        };
      }),
    });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Invalid provider config' });
  }
});

app.post('/llm/model', (req, res) => {
  try {
    const nextModel = setLlmModel(req.body?.model);
    emitEvent('log:append', {
      source: 'llm',
      message: `[llm] model set to ${nextModel}`,
    });
    const { baseUrl, model, providerId, responseFormat } = getActiveLlmConfig();
    return res.json({
      hasConfig: hasLlmConfig(),
      model: model || null,
      providerId: providerId || null,
      baseUrl: baseUrl || null,
      responseFormat: responseFormat || null,
      options: LLM_MODEL_OPTIONS,
      providers: LLM_PROVIDERS.map((provider) => {
        const directBaseUrl = getProviderEnv(provider.id, 'base_url');
        const directApiKey = getProviderEnv(provider.id, 'api_key');
        return {
          id: provider.id,
          label: provider.label,
          baseUrl: directBaseUrl || null,
          baseUrlPresent: Boolean(directBaseUrl),
          apiKeyPresent: Boolean(directApiKey),
        };
      }),
    });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Invalid model' });
  }
});

app.get('/prompts', (req, res) => {
  const current = loadPromptConfig();
  const defaults = loadPromptDefaults();
  const presets = loadPromptPresets().filter((item) => item && typeof item === 'object');
  return res.json({ current, defaults, presets });
});

app.post('/prompts', (req, res) => {
  try {
    const incoming = req.body?.config ?? req.body ?? {};
    const saved = persistPromptConfig(incoming);
    emitEvent('log:append', { source: 'prompt', message: '[prompt] config updated' });
    const defaults = loadPromptDefaults();
    const presets = loadPromptPresets().filter((item) => item && typeof item === 'object');
    return res.json({ current: saved, defaults, presets });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Invalid prompt config' });
  }
});

app.post('/prompts/reset', (req, res) => {
  try {
    const saved = persistPromptConfig(loadPromptDefaultsRaw());
    emitEvent('log:append', { source: 'prompt', message: '[prompt] config reset' });
    const defaults = loadPromptDefaults();
    const presets = loadPromptPresets().filter((item) => item && typeof item === 'object');
    return res.json({ current: saved, defaults, presets });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Reset failed' });
  }
});

app.post('/prompts/presets', (req, res) => {
  try {
    const name = normalizePresetName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Invalid preset name' });
    const config = normalizePromptConfig(req.body?.config ?? loadPromptConfig());
    const existing = loadPromptPresets().filter((item) => item && typeof item === 'object');
    const savedAt = new Date().toISOString();
    const next = existing.filter((p) => String(p?.name || '') !== name);
    next.unshift({ name, savedAt, config });
    if (next.length > 30) next.length = 30;
    persistPromptPresets(next);
    emitEvent('log:append', {
      source: 'prompt',
      message: `[prompt] preset saved: ${name}`,
    });
    const current = loadPromptConfig();
    const defaults = loadPromptDefaults();
    return res.json({ current, defaults, presets: next });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Preset save failed' });
  }
});

app.post('/prompts/presets/apply', (req, res) => {
  try {
    const name = normalizePresetName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Invalid preset name' });
    const presets = loadPromptPresets().filter((item) => item && typeof item === 'object');
    const hit = presets.find((p) => String(p?.name || '') === name);
    if (!hit) return res.status(404).json({ error: 'Preset not found' });
    const saved = persistPromptConfig(hit.config);
    emitEvent('log:append', {
      source: 'prompt',
      message: `[prompt] preset applied: ${name}`,
    });
    const defaults = loadPromptDefaults();
    return res.json({ current: saved, defaults, presets });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Preset apply failed' });
  }
});

app.get('/state', (req, res) => {
  res.json({
    status: state.status,
    tasks: state.tasks,
    lastDiff: state.lastDiff,
    approvals: Object.values(state.approvals),
    testReport: state.testReport,
    logs: state.logs,
  });
});

app.get('/specs', (req, res) => {
  res.json({ specs: listSpecs() });
});

app.post('/specs', async (req, res) => {
  const prompt = normalizePrompt(req.body?.prompt);
  let specName = sanitizeSpecName(req.body?.name);
  const wantsStream = isNdjsonStreamRequest(req);

  if (wantsStream) {
    const stream = createNdjsonStream(res);
    if (!specName) {
      if (!prompt) {
        stream.write({ type: 'error', error: 'Invalid spec name', status: 400 });
        stream.end();
        return;
      }
      specName = generateSpecName(prompt);
    }
    stream.write({ type: 'meta', action: 'spec:create', specName });
    try {
      await createSpecTemplates(specName, ['requirements'], prompt, {
        onStage: (stage, state) => stream.write({ type: 'stage', stage, state }),
        onLlmToken: (stage, delta) => stream.write({ type: 'delta', stage, delta }),
      });
    } catch (error) {
      console.error('Spec generation failed:', error?.message || error);
      stream.write({
        type: 'error',
        error: error?.message || 'Spec generation failed',
        context: error?.llmContext || null,
        status: 502,
      });
      stream.end();
      return;
    }
    emitEvent('log:append', {
      source: 'spec',
      message: `[spec] created ${specName}`,
    });
    stream.write({ type: 'result', data: { name: specName } });
    stream.end();
    return;
  }

  if (!specName) {
    if (!prompt) {
      return res.status(400).json({ error: 'Invalid spec name' });
    }
    specName = generateSpecName(prompt);
  }
  try {
    await createSpecTemplates(specName, ['requirements'], prompt);
  } catch (error) {
    console.error('Spec generation failed:', error?.message || error);
    return res.status(502).json({ error: error?.message || 'Spec generation failed' });
  }
  emitEvent('log:append', {
    source: 'spec',
    message: `[spec] created ${specName}`,
  });
  return res.json({ name: specName });
});

app.get('/specs/:name/reports', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  if (!specName) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  const runs = listFlowRuns(specName);
  const reports = runs.map((run) => {
    const runId = String(run?.runId || '');
    const ratings = run?.ratings && typeof run.ratings === 'object' ? run.ratings : {};
    const userRatings = Array.isArray(run?.userRatings) ? run.userRatings : [];
    const reportPath =
      run?.report && typeof run.report === 'object' ? run.report.path || null : null;
    const job = runId ? getReportScoreJob(specName, runId) : null;
    return {
      runId,
      createdAt: run?.createdAt || null,
      updatedAt: run?.updatedAt || null,
      reportPath,
      ratings: {
        updatedAt: ratings?.updatedAt || null,
        byModel:
          ratings?.byModel && typeof ratings.byModel === 'object' ? ratings.byModel : {},
      },
      userRatings,
      scoreJob: job ? getReportScoreStatus(job) : null,
    };
  });
  return res.json({ reports });
});

app.get('/specs/:name/reports/:runId', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  const runId = sanitizeRunId(req.params.runId);
  if (!specName || !runId) {
    return res.status(400).json({ error: 'Invalid report request' });
  }
  const run = readFlowRun(specName, runId);
  if (!run) {
    return res.status(404).json({ error: 'Report run not found' });
  }
  const ratings = run?.ratings && typeof run.ratings === 'object' ? run.ratings : {};
  const userRatings = Array.isArray(run?.userRatings) ? run.userRatings : [];
  const reportPath =
    run?.report && typeof run.report === 'object' ? run.report.path || null : null;
  const job = getReportScoreJob(specName, runId);
  return res.json({
    runId,
    createdAt: run?.createdAt || null,
    updatedAt: run?.updatedAt || null,
    reportPath,
    ratings: {
      updatedAt: ratings?.updatedAt || null,
      byModel: ratings?.byModel && typeof ratings.byModel === 'object' ? ratings.byModel : {},
    },
    userRatings,
    scoreJob: job ? getReportScoreStatus(job) : null,
  });
});

app.get('/specs/:name/reports/:runId/markdown', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  const runId = sanitizeRunId(req.params.runId);
  if (!specName || !runId) {
    return res.status(400).json({ error: 'Invalid report request' });
  }
  const run = readFlowRun(specName, runId);
  if (!run) {
    return res.status(404).json({ error: 'Report run not found' });
  }
  try {
    const reportPath = refreshFlowReport(specName, runId) || null;
    if (!reportPath || !fs.existsSync(reportPath)) {
      return res.status(404).json({ error: 'Report file not found' });
    }
    const content = fs.readFileSync(reportPath, 'utf8');
    return res.json({ reportPath, content });
  } catch (error) {
    const message = truncateText(error?.message || String(error || ''), 240);
    return res.status(500).json({ error: `Failed to read report: ${message}` });
  }
});

app.get('/specs/:name/reports/:runId/score', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  const runId = sanitizeRunId(req.params.runId);
  if (!specName || !runId) {
    return res.status(400).json({ error: 'Invalid report request' });
  }
  const job = getReportScoreJob(specName, runId);
  if (!job) {
    return res.json({
      running: false,
      total: 0,
      completed: 0,
      logs: [],
      error: null,
      startedAt: null,
      updatedAt: null,
    });
  }
  return res.json(getReportScoreStatus(job));
});

app.post('/specs/:name/reports/:runId/score', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  const runId = sanitizeRunId(req.params.runId);
  if (!specName || !runId) {
    return res.status(400).json({ error: 'Invalid report request' });
  }
  const run = readFlowRun(specName, runId);
  if (!run) {
    return res.status(404).json({ error: 'Report run not found' });
  }
  const force = req.body?.force === true;
  const job = startReportScoreJob(specName, runId, { force, resetLogs: true });
  if (!job) {
    return res.status(500).json({ error: 'Failed to start score job' });
  }
  return res.json(getReportScoreStatus(job));
});

app.post('/specs/:name/reports/:runId/user-score', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  const runId = sanitizeRunId(req.params.runId);
  if (!specName || !runId) {
    return res.status(400).json({ error: 'Invalid report request' });
  }
  const run = readFlowRun(specName, runId);
  if (!run) {
    return res.status(404).json({ error: 'Report run not found' });
  }
  const score = Number(req.body?.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return res.status(400).json({ error: 'score must be between 0 and 100' });
  }
  const comment = sanitizeReviewText(req.body?.comment, 400);
  const record = {
    score: Math.round(score),
    comment,
    createdAt: new Date().toISOString(),
  };
  const nextUserRatings = Array.isArray(run.userRatings) ? [...run.userRatings] : [];
  nextUserRatings.push(record);
  const now = new Date().toISOString();
  writeFlowRun(specName, { ...run, updatedAt: now, userRatings: nextUserRatings });
  refreshFlowReport(specName, runId);
  return res.json({ ok: true, userRatings: nextUserRatings });
});

app.get('/specs/:name/:artifact', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  const artifact = req.params.artifact;
  if (!specName || !SPEC_ARTIFACTS.includes(artifact)) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  const filePath = resolveSpecFile(specName, artifact);
  if (!fs.existsSync(filePath)) {
    const status = readSpecStatus(specName);
    if (artifact === 'design' && status?.requirementsConfirmed) {
      const requirementsPath = resolveSpecFile(specName, 'requirements');
      const requirementsContent = fs.existsSync(requirementsPath)
        ? fs.readFileSync(requirementsPath, 'utf8')
        : '';
      const content = generateDesignContent(requirementsContent, status.prompt);
      writeSpecFile(specName, 'design', content);
    }
    if (artifact === 'tasks' && status?.designConfirmed) {
      const designPath = resolveSpecFile(specName, 'design');
      let designContent = fs.existsSync(designPath)
        ? fs.readFileSync(designPath, 'utf8')
        : '';
      if (!designContent.trim() && status?.requirementsConfirmed) {
        const requirementsPath = resolveSpecFile(specName, 'requirements');
        const requirementsContent = fs.existsSync(requirementsPath)
          ? fs.readFileSync(requirementsPath, 'utf8')
          : '';
        designContent = generateDesignContent(requirementsContent, status.prompt);
        writeSpecFile(specName, 'design', designContent);
      }
      const content = generateTasksContent(designContent, status.prompt);
      writeSpecFile(specName, 'tasks', content);
    }
  }
  if (!fs.existsSync(filePath)) {
    ensureSpecTemplate(specName, artifact);
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Spec file not found' });
  }
  let content = fs.readFileSync(filePath, 'utf8');
  if (artifact === 'requirements' && !content.includes('## 原始需求')) {
    const status = readSpecStatus(specName);
    if (status.prompt) {
      const rawPrompt = normalizePrompt(status.prompt) || '（未提供原始需求）';
      const injected = `# 需求（requirements）\n\n## 原始需求\n${rawPrompt}\n`;
      const tail = content.replace(/^# 需求（requirements）\s*/m, '').trim();
      content = `${injected}\n\n${tail}`.trimEnd();
      writeSpecFile(specName, 'requirements', content);
    }
  }
  if (artifact === 'requirements') {
    const status = readSpecStatus(specName);
    ensureRequirementsReviewSeeded(specName, status, content);
    ensureRequirementsClarificationsSeeded(specName, status, status.prompt);
  }
  if (artifact === 'design') {
    const status = readSpecStatus(specName);
    ensureTechStackClarificationsSeeded(specName, status, status.prompt, content);
  }
  return res.json({ content });
});

app.post('/specs/:name/requirements/review', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  if (!specName) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  const status = readSpecStatus(specName);
  const nextReview = normalizeRequirementsReview(req.body || {});
  status.requirementsReview = {
    ...nextReview,
    updatedAt: new Date().toISOString(),
    confirmedAt: status.requirementsReview?.confirmedAt ?? null,
  };
  writeSpecStatus(specName, status);
  emitEvent('log:append', {
    source: 'spec',
    message: `[spec] saved ${specName}/requirements-review`,
  });
  return res.json({ ok: true, status });
});

app.post('/specs/:name/requirements/clarifications', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  if (!specName) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  let status = readSpecStatus(specName);
  const nextClarifications = normalizeRequirementsClarifications(req.body || {});
  status.requirementsClarifications = {
    ...nextClarifications,
    updatedAt: new Date().toISOString(),
    confirmedAt: status.requirementsClarifications?.confirmedAt ?? null,
  };
  writeSpecStatus(specName, status);
  emitEvent('log:append', {
    source: 'spec',
    message: `[spec] saved ${specName}/requirements-clarifications`,
  });
  return res.json({ ok: true, status });
});

app.post('/specs/:name/tech-stack/clarifications', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  if (!specName) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  const status = readSpecStatus(specName);
  const nextClarifications = normalizeRequirementsClarifications(req.body || {});
  status.techStackClarifications = {
    ...nextClarifications,
    updatedAt: new Date().toISOString(),
    confirmedAt: status.techStackClarifications?.confirmedAt ?? null,
  };
  writeSpecStatus(specName, status);
  emitEvent('log:append', {
    source: 'spec',
    message: `[spec] saved ${specName}/tech-stack-clarifications`,
  });
  return res.json({ ok: true, status });
});

app.post('/specs/:name/confirm', async (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  const artifact = req.body?.artifact;
  const force = req.body?.force === true;
  const wantsStream = isNdjsonStreamRequest(req);
  const stream = wantsStream ? createNdjsonStream(res) : null;
  const respondError = (httpStatus, message, extra = null) => {
    const payload = { error: message };
    if (extra && typeof extra === 'object') Object.assign(payload, extra);
    if (stream) {
      stream.write({ type: 'error', status: httpStatus, ...payload });
      stream.end();
      return;
    }
    return res.status(httpStatus).json(payload);
  };

  if (!specName || !SPEC_ARTIFACTS.includes(artifact)) {
    return respondError(400, 'Invalid spec request');
  }

  stream?.write({ type: 'meta', action: 'spec:confirm', specName, artifact, force });

  let status = readSpecStatus(specName);

  if (artifact === 'requirements') {
    const incomingReview = req.body?.review || req.body?.requirementsReview || null;
    if (incomingReview) {
      status.requirementsReview = mergeRequirementsReview(status.requirementsReview, incomingReview);
    }
    const incomingClarifications =
      req.body?.clarifications || req.body?.requirementsClarifications || null;
    if (incomingClarifications) {
      status.requirementsClarifications = mergeRequirementsClarifications(
        status.requirementsClarifications,
        incomingClarifications,
      );
    }
    if (!areClarificationsComplete(status.requirementsClarifications)) {
      return respondError(409, 'Requirements clarifications incomplete');
    }
    const now = new Date().toISOString();
    status.requirementsReview = {
      ...normalizeRequirementsReview(status.requirementsReview || {}),
      updatedAt: now,
      confirmedAt: now,
    };
    status.requirementsClarifications = {
      ...normalizeRequirementsClarifications(status.requirementsClarifications || {}),
      updatedAt: now,
      confirmedAt: now,
    };
    const requirementsPath = resolveSpecFile(specName, 'requirements');
    let requirementsContent = fs.existsSync(requirementsPath)
      ? fs.readFileSync(requirementsPath, 'utf8')
      : '';

    const shouldGenerateRequirements = force || !status.requirementsConfirmed;
    if (shouldGenerateRequirements) {
      ensureActiveFlowRun(specName, status, { reason: 'confirm:requirements' });
      const clarificationsSummary = buildClarificationsSummary(status.requirementsClarifications);
      stream?.write({ type: 'stage', stage: 'requirements', state: 'start' });
      try {
        const generated = await generateRequirementsWithModel(status.prompt, {
          clarificationsSummary,
          onTelemetry: (attempt) =>
            appendFlowRunStageAttempt(specName, 'requirements', attempt, {
              reason: 'confirm:requirements',
            }),
        });
        requirementsContent = upsertRequirementsClarificationsSection(
          generated,
          status.requirementsClarifications?.questions,
        );
        status.lastError = null;
      } catch (error) {
        recordSpecError(status, 'requirements', error, null);
        const fallback = buildRequirementsMarkdown(status.prompt, {
          summary: status.prompt,
          background: '',
          user_stories: [],
          acceptance: [],
        });
        requirementsContent = upsertRequirementsClarificationsSection(
          fallback,
          status.requirementsClarifications?.questions,
        );
      }
      stream?.write({ type: 'delta', stage: 'requirements', delta: requirementsContent });
      stream?.write({ type: 'stage', stage: 'requirements', state: 'end' });
      writeSpecFile(specName, 'requirements', requirementsContent);
      status = ensureRequirementsReviewSeeded(specName, status, requirementsContent).status;
    } else {
      requirementsContent = upsertRequirementsClarificationsSection(
        requirementsContent,
        status.requirementsClarifications?.questions,
      );
      if (requirementsContent.trim()) {
        writeSpecFile(specName, 'requirements', requirementsContent);
      }
    }

    status.requirementsConfirmed = true;
    const designPath = resolveSpecFile(specName, 'design');
    const shouldGenerate =
      force || !fs.existsSync(designPath) || fs.readFileSync(designPath, 'utf8').trim() === '';
    if (shouldGenerate) {
      try {
        ensureActiveFlowRun(specName, status, { reason: 'confirm:requirements' });
        const supplementalPrompt = [
          status.prompt,
          buildClarificationsSummary(status.requirementsClarifications),
          buildReviewSummary(status.requirementsReview),
        ]
          .filter(Boolean)
          .join('\n\n');
        stream?.write({ type: 'stage', stage: 'design', state: 'start' });
        const content = await generateDesignWithModel(
          requirementsContent,
          supplementalPrompt,
          {
            onTelemetry: (attempt) =>
              appendFlowRunStageAttempt(specName, 'design', attempt, {
                reason: 'confirm:requirements',
              }),
          },
        );
        stream?.write({ type: 'delta', stage: 'design', delta: content });
        stream?.write({ type: 'stage', stage: 'design', state: 'end' });
        writeSpecFile(specName, 'design', content);
        status.lastError = null;

      } catch (error) {
        recordSpecError(status, 'design', error, null);
        writeSpecStatus(specName, status);
        console.error('Design generation failed:', error?.message || error);
        return respondError(502, error?.message || 'Design generation failed', {
          stage: 'design',
          context: error?.llmContext || null,
        });
      }
    }
  }

  if (artifact === 'design') {
    if (!status.requirementsConfirmed) {
      return respondError(409, 'Requirements not confirmed');
    }
    const designPath = resolveSpecFile(specName, 'design');
    const designContent = fs.existsSync(designPath) ? fs.readFileSync(designPath, 'utf8') : '';

    const normalizedCategory = normalizeProjectCategoryValue(status.projectCategory);
    const projectCategoryMeta =
      status.projectCategoryMeta && typeof status.projectCategoryMeta === 'object'
        ? status.projectCategoryMeta
        : null;
    const projectCategoryMetaSource =
      projectCategoryMeta && typeof projectCategoryMeta.source === 'string'
        ? projectCategoryMeta.source
        : '';
    const hasLlmProjectCategoryMeta = projectCategoryMetaSource === 'llm';
    const shouldInferProjectCategory =
      Boolean(status.prompt) && (!normalizedCategory || !hasLlmProjectCategoryMeta);

    if (shouldInferProjectCategory) {
      try {
        ensureActiveFlowRun(specName, status, { reason: 'confirm:design' });
        const result = await inferProjectCategoryFromModel(status.prompt, {
          onTelemetry: (attempt) =>
            appendFlowRunStageAttempt(specName, attempt?.stageKey || 'projectCategory', attempt, {
              reason: 'confirm:design',
            }),
        });
        const decided = result?.projectCategory || inferProjectCategoryFromPrompt(status.prompt);
        const now = new Date().toISOString();
        status.projectCategory = decided;
        status.projectCategoryMeta = { ...result, judgedAt: now, source: 'llm' };
        status.techStackConfirmed = decided === 'non_software' ? true : status.techStackConfirmed;
      } catch {
        const decided = inferProjectCategoryFromPrompt(status.prompt);
        const now = new Date().toISOString();
        status.projectCategory = decided;
        status.projectCategoryMeta = {
          projectCategory: decided,
          confidence: null,
          reason: '',
          judgedAt: now,
          source: 'heuristic',
        };
        status.techStackConfirmed = decided === 'non_software' ? true : status.techStackConfirmed;
      }
      writeSpecStatus(specName, status);
    } else if (normalizedCategory && normalizedCategory !== status.projectCategory) {
      status.projectCategory = normalizedCategory;
      writeSpecStatus(specName, status);
    }

    const skipTechStack = req.body?.skipTechStack === true || status.projectCategory === 'non_software';

    if (!skipTechStack) {
      // Ensure tech stack confirmation questions exist before generating tasks.
      status = ensureTechStackClarificationsSeeded(
        specName,
        status,
        status.prompt,
        designContent,
      ).status;

      const incomingTechStackClarifications =
        req.body?.techStackClarifications || req.body?.techStack || null;
      if (incomingTechStackClarifications) {
        status.techStackClarifications = mergeRequirementsClarifications(
          status.techStackClarifications,
          incomingTechStackClarifications,
        );
      }

      if (!areClarificationsComplete(status.techStackClarifications)) {
        writeSpecStatus(specName, status);
        return respondError(409, 'Tech stack clarifications incomplete');
      }

      const now = new Date().toISOString();
      status.techStackClarifications = {
        ...normalizeRequirementsClarifications(status.techStackClarifications || {}),
        updatedAt: now,
        confirmedAt: now,
      };
      status.techStackConfirmed = true;
      status.designConfirmed = true;
      const tasksPath = resolveSpecFile(specName, 'tasks');
      const shouldGenerate =
        force || !fs.existsSync(tasksPath) || fs.readFileSync(tasksPath, 'utf8').trim() === '';
      if (shouldGenerate) {
        ensureActiveFlowRun(specName, status, { reason: 'confirm:design' });
        const supplementalPrompt = [
          status.prompt,
          buildTechStackSummary(status.techStackClarifications),
        ]
          .filter(Boolean)
          .join('\n\n');
        stream?.write({ type: 'stage', stage: 'tasks', state: 'start' });
        let content = '';
        try {
          content = await generateTasksWithModel(
            designContent,
            supplementalPrompt,
            {
              onTelemetry: (attempt) =>
                appendFlowRunStageAttempt(specName, 'tasks', attempt, {
                  reason: 'confirm:design',
                }),
            },
          );
        } catch (error) {
          console.error('Tasks generation failed:', error?.message || error);
          content = generateTasksContent(designContent, status.prompt);
        }
        stream?.write({ type: 'delta', stage: 'tasks', delta: content });
        stream?.write({ type: 'stage', stage: 'tasks', state: 'end' });
        writeSpecFile(specName, 'tasks', content);
        status.lastError = null;
      }
    } else {
      const now = new Date().toISOString();
      status.projectCategory = normalizeProjectCategoryValue(status.projectCategory) || resolveProjectCategory(status);
      status.techStackConfirmed = true;
      status.designConfirmed = true;
      status.techStackClarifications = {
        ...normalizeRequirementsClarifications(status.techStackClarifications || {}),
        questions: [],
        updatedAt: now,
        confirmedAt: status.techStackClarifications?.confirmedAt ?? now,
        generatedBy: status.techStackClarifications?.generatedBy ?? 'skip',
        generationError: null,
      };

      const tasksPath = resolveSpecFile(specName, 'tasks');
      const shouldGenerate =
        force || !fs.existsSync(tasksPath) || fs.readFileSync(tasksPath, 'utf8').trim() === '';

      if (shouldGenerate) {
        ensureActiveFlowRun(specName, status, { reason: 'confirm:design' });
        const supplementalPrompt = [
          status.prompt,
          '说明：该需求被识别为非软件项目，跳过“技术栈确认”等软件工程专属设定；不要输出前端/后端/数据库/API/代码实现类内容。请以文档/流程/交付物为主进行任务拆解，并给出可验证的验收方式。',
        ]
          .filter(Boolean)
          .join('\n\n');
        stream?.write({ type: 'stage', stage: 'tasks', state: 'start' });
        let content = '';
        try {
          content = await generateTasksWithModel(
            designContent,
            supplementalPrompt,
            {
              onTelemetry: (attempt) =>
                appendFlowRunStageAttempt(specName, 'tasks', attempt, {
                  reason: 'confirm:design',
                }),
            },
          );
        } catch (error) {
          console.error('Tasks generation failed:', error?.message || error);
          content = buildTasksDagMarkdown({
            tasks: [
              {
                id: 'T1_BRIEF',
                title: '明确交付目标与范围边界',
                description:
                  '定义受众、交付物形态（Markdown/PDF/Slides）、范围/不做事项清单；产出 docs/brief.md（或写入 requirements/design）。',
                dependencies: [],
                scope: ['docs/'],
                estimated_complexity: 'Medium',
              },
              {
                id: 'T2_OUTLINE',
                title: '输出目录与提纲结构',
                description:
                  '基于 T1 输出目录结构与每章要点；产出 docs/outline.md（或写入 design）。',
                dependencies: ['T1_BRIEF'],
                scope: ['docs/'],
                estimated_complexity: 'Medium',
              },
              {
                id: 'T3_CONTENT',
                title: '补齐核心内容与素材',
                description:
                  '填充各章节内容，包含时间线/预算/分工/资源清单（按需求选择）；产出 docs/draft.md。',
                dependencies: ['T2_OUTLINE'],
                scope: ['docs/'],
                estimated_complexity: 'High',
              },
              {
                id: 'T4_RISK',
                title: '整理风险清单与预案',
                description:
                  '列出触发条件/影响/应对措施；产出 docs/risk.md。',
                dependencies: ['T2_OUTLINE'],
                scope: ['docs/'],
                estimated_complexity: 'Medium',
              },
              {
                id: 'T5_REVIEW',
                title: '一致性校对与终稿修订',
                description:
                  '统一术语、数字、口径并修订；产出 docs/final.md。',
                dependencies: ['T3_CONTENT', 'T4_RISK'],
                scope: ['docs/'],
                estimated_complexity: 'Medium',
              },
              {
                id: 'T6_EXPORT',
                title: '导出可交付版本与版本说明',
                description:
                  '按交付形态导出 Markdown/PDF/Slides，并给出版本说明与获取方式。',
                dependencies: ['T5_REVIEW'],
                scope: ['docs/'],
                estimated_complexity: 'Low',
              },
            ],
          });
        }
        stream?.write({ type: 'delta', stage: 'tasks', delta: content });
        stream?.write({ type: 'stage', stage: 'tasks', state: 'end' });
        writeSpecFile(specName, 'tasks', content);
        status.lastError = null;
      }
    }
  }

  if (artifact === 'tasks') {
    if (!status.designConfirmed) {
      return respondError(409, 'Design not confirmed');
    }
    status.tasksConfirmed = true;
  }

  writeSpecStatus(specName, status);
  emitEvent('log:append', {
    source: 'spec',
    message: `[spec] confirmed ${specName}/${artifact}`,
  });
  if (stream) {
    stream.write({ type: 'result', data: { ok: true, status } });
    stream.end();
    return;
  }
  return res.json({ ok: true, status });
});

app.get('/specs/:name/tasks/atomize', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  if (!specName) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  const job = atomizeJobs.get(specName);
  if (!job) {
    return res.json({ running: false, total: 0, completed: 0, logs: [] });
  }
  return res.json(getAtomizeStatus(job));
});

app.post('/specs/:name/tasks/atomize', async (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  if (!specName) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }

  const existing = atomizeJobs.get(specName);
  if (existing && existing.running) {
    return res.json(getAtomizeStatus(existing));
  }

  const batchSize = normalizeAtomizeBatchSize(
    req.body?.batchSize ?? req.body?.segmentSize ?? req.query?.batchSize,
  );

  const resetAtomic = req.body?.resetAtomic === true || req.body?.reset === true;
  const iterateFromRunId = sanitizeRunId(
    req.body?.iterateFromRunId ?? req.body?.fromReportRunId ?? req.body?.reportRunId,
  );
  const iterateUserNote = sanitizeReviewText(
    req.body?.iterateUserNote ?? req.body?.userNote ?? req.body?.note,
    1800,
  );

  let iterationReason = '';
  let flowRunReason = 'atomize';
  let forceNewFlowRun = false;
  if (iterateFromRunId) {
    const baseRun = readFlowRun(specName, iterateFromRunId);
    iterationReason = baseRun
      ? buildAtomizeIterationReasonFromReport(baseRun, iterateUserNote)
      : iterateUserNote
        ? `用户补充修改意见：\n${iterateUserNote}`
        : '';
    flowRunReason = `atomize_iterate_from:${iterateFromRunId}`;
    forceNewFlowRun = true;
  } else if (iterateUserNote) {
    iterationReason = `用户补充修改意见：\n${iterateUserNote}`;
    flowRunReason = 'atomize_iterate';
    forceNewFlowRun = true;
  }
  if (resetAtomic && !forceNewFlowRun) {
    flowRunReason = 'atomize_reset';
    forceNewFlowRun = true;
  }

  const now = new Date().toISOString();
  const job = existing || {
    specName,
    running: false,
    total: 0,
    completed: 0,
    logs: [],
    error: null,
    startedAt: now,
    updatedAt: now,
  };
  job.running = true;
  job.error = null;
  job.startedAt = now;
  job.updatedAt = now;
  if (resetAtomic || iterateFromRunId || iterateUserNote) job.logs = [];
  atomizeJobs.set(specName, job);
  logAtomize(
    job,
    [
      `原子化任务已启动${batchSize ? `（分段：${batchSize} 条）` : '（分段：默认）'}`,
      resetAtomic ? '重置 tasks_atomic' : null,
      iterateFromRunId ? `迭代自评分报告 ${iterateFromRunId}` : null,
    ]
      .filter(Boolean)
      .join('｜'),
  );

  setImmediate(() => {
    runAtomizeJob(specName, job, {
      batchSize,
      resetAtomic,
      forceNewFlowRun,
      flowRunReason,
      iterationReason,
    });
  });

  return res.json(getAtomizeStatus(job));
});

function normalizeCodexSandbox(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const allowed = new Set(['read-only', 'workspace-write', 'danger-full-access']);
  if (allowed.has(raw)) return raw;
  return 'workspace-write';
}

function normalizeCodexModel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 100) return null;
  return trimmed;
}

function buildCodexRunDoc(specName, atomicTask, options = {}) {
  const runsDir = path.join(resolveSpecDir(specName), '.runlogs', 'codex-runs');
  fs.mkdirSync(runsDir, { recursive: true });

  const taskId = atomicTask?.id || 'unknown';
  const safeTaskId = String(taskId).replace(/[^\d.]/g, '').replace(/\./g, '_') || 'unknown';
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z');
  const runDocPath = path.join(runsDir, `task-${safeTaskId}-${stamp}.md`);
  const lastMessagePath = path.join(runsDir, `last-message-${safeTaskId}-${stamp}.md`);

  const rel = (absPath) => normalizePathForPrompt(path.relative(REPO_DIR, absPath));
  const artifacts = {
    requirements: resolveSpecFile(specName, 'requirements'),
    design: resolveSpecFile(specName, 'design'),
    tasks: resolveSpecFile(specName, 'tasks'),
    tasks_atomic: resolveSpecFile(specName, 'tasks_atomic'),
  };

  const lines = [];
  lines.push(`# Codex 任务执行文档`);
  lines.push('');
  lines.push(`- Spec: ${specName}`);
  lines.push(`- Task: ${taskId}`);
  lines.push(`- StartedAt: ${new Date().toISOString()}`);
  if (options.model) lines.push(`- Model: ${options.model}`);
  if (options.sandbox) lines.push(`- Sandbox: ${options.sandbox}`);
  lines.push('');
  lines.push('## Spec 入口');
  lines.push(`- requirements: \`${normalizePathForPrompt(artifacts.requirements)}\``);
  lines.push(`- design: \`${normalizePathForPrompt(artifacts.design)}\``);
  lines.push(`- tasks: \`${normalizePathForPrompt(artifacts.tasks)}\``);
  lines.push(`- tasks_atomic: \`${normalizePathForPrompt(artifacts.tasks_atomic)}\``);
  lines.push('');
  lines.push('## 本次原子任务');
  if (atomicTask?.block) {
    lines.push('');
    lines.push('```markdown');
    lines.push(String(atomicTask.block).trimEnd());
    lines.push('```');
  } else {
    lines.push('');
    lines.push(`- title: ${atomicTask?.title || ''}`);
    lines.push(`- 核心逻辑: ${atomicTask?.core || ''}`);
    lines.push(`- 技术细节: ${atomicTask?.details || ''}`);
    const depends = Array.isArray(atomicTask?.depends)
      ? atomicTask.depends.map((v) => String(v || '').trim()).filter(Boolean).join('；')
      : atomicTask?.depends
        ? String(atomicTask.depends)
        : '';
    lines.push(`- 依赖: ${depends}`);
    lines.push(`- 验收准则: ${atomicTask?.ac || ''}`);
  }
  lines.push('');
  lines.push('## 执行要求');
  lines.push('- 严格按“本次原子任务”的 title/core/details/ac 实现。');
  lines.push('- 若需要新增/修改文件，遵循仓库既有风格与约束。');
  lines.push('- 完成后运行 AC 中描述的验证步骤（若 AC 未给出命令，请补充最小可行验证）。');
  lines.push('- 可选：将 tasks_atomic.md 中对应条目标记为 [x]，并在 tasks.md 回写关键变更摘要。');
  lines.push('');

  fs.writeFileSync(runDocPath, lines.join('\n'), 'utf8');
  return {
    runDocPath,
    lastMessagePath,
    runDocPathRel: rel(runDocPath),
    lastMessagePathRel: rel(lastMessagePath),
    artifacts,
  };
}

app.post('/specs/:name/tasks_atomic/prompt', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  if (!specName) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  if (state.status === 'Reviewing') {
    return res.status(409).json({ error: 'Blocked by approval' });
  }

  const taskId = sanitizeAtomicTaskId(req.body?.taskId ?? req.body?.id ?? req.query?.taskId);
  if (!taskId) {
    return res.status(400).json({ error: 'taskId is required (e.g. 1.2)' });
  }

  const atomicPath = resolveSpecFile(specName, 'tasks_atomic');
  if (!fs.existsSync(atomicPath)) {
    return res.status(404).json({ error: 'Spec file not found' });
  }

  const content = fs.readFileSync(atomicPath, 'utf8');
  const atomicTasks = parseTasksAtomicMarkdown(content);
  const hit = atomicTasks.find((t) => String(t?.id || '').trim() === taskId);
  if (!hit) {
    return res.status(404).json({ error: `Atomic task not found: ${taskId}` });
  }

  const sandbox = normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox);
  const model = normalizeCodexModel(req.body?.model ?? req.query?.model);
  const projectDir = normalizeTerminalCwd(
    req.body?.cwd ??
      req.body?.projectDir ??
      (typeof req.query?.cwd === 'string' ? req.query.cwd : '') ??
      (typeof req.query?.projectDir === 'string' ? req.query.projectDir : ''),
  );

  const doc = buildCodexRunDoc(specName, hit, { sandbox, model });
  const runDocPathForPrompt = normalizePathForPrompt(doc.runDocPath);
  const projectDirForPrompt = normalizePathForPrompt(projectDir);
  const prompt = [
    `请按任务文档（绝对路径）${runDocPathForPrompt} 实现该原子任务，完成后自检并用简短要点总结变更与验证结果。`,
    projectDirForPrompt ? `建议工作目录：${projectDirForPrompt}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return res.json({
    ok: true,
    prompt,
    runDocPath: doc.runDocPathRel,
    runDocPathAbs: runDocPathForPrompt,
    task: {
      id: hit.id,
      done: Boolean(hit.done),
      title: hit.title,
      core: hit.core,
      details: hit.details,
      depends: Array.isArray(hit.depends) ? hit.depends : [],
      ac: hit.ac,
      originalIndex: hit.originalIndex,
      originalTitle: hit.originalTitle,
    },
  });
});

app.post('/specs/:name/tasks_atomic/codex', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  if (!specName) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  if (state.status === 'Reviewing') {
    return res.status(409).json({ error: 'Blocked by approval' });
  }

  const taskId = sanitizeAtomicTaskId(req.body?.taskId ?? req.body?.id ?? req.query?.taskId);
  if (!taskId) {
    return res.status(400).json({ error: 'taskId is required (e.g. 1.2)' });
  }

  const atomicPath = resolveSpecFile(specName, 'tasks_atomic');
  if (!fs.existsSync(atomicPath)) {
    return res.status(404).json({ error: 'Spec file not found' });
  }

  const content = fs.readFileSync(atomicPath, 'utf8');
  const atomicTasks = parseTasksAtomicMarkdown(content);
  const hit = atomicTasks.find((t) => String(t?.id || '').trim() === taskId);
  if (!hit) {
    return res.status(404).json({ error: `Atomic task not found: ${taskId}` });
  }

  const sandbox = normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox);
  const model = normalizeCodexModel(req.body?.model ?? req.query?.model);
  const projectDir = normalizeTerminalCwd(
    req.body?.cwd ??
      req.body?.projectDir ??
      (typeof req.query?.cwd === 'string' ? req.query.cwd : '') ??
      (typeof req.query?.projectDir === 'string' ? req.query.projectDir : ''),
  );

  const doc = buildCodexRunDoc(specName, hit, { sandbox, model });
  const runDocPathForPrompt = normalizePathForPrompt(doc.runDocPath);
  const prompt = `请按任务文档（绝对路径）${runDocPathForPrompt} 实现该原子任务，完成后自检并用简短要点总结变更与验证结果。`;

  const codexExecutable = (process.env.CODEX_COMMAND || 'codex').trim() || 'codex';
  const codexArgs = ['-a', 'never', '-s', sandbox];
  if (model) codexArgs.push('-m', model);
  codexArgs.push(
    '-C',
    projectDir,
    'exec',
    '--add-dir',
    SPEC_ROOT,
    '--output-last-message',
    doc.lastMessagePath,
    prompt,
  );

  const spawnCommand = process.platform === 'win32' ? 'cmd.exe' : codexExecutable;
  const spawnArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', codexExecutable, ...codexArgs]
    : codexArgs;

  emitEvent('log:append', {
    source: 'codex',
    message: `[codex] start spec=${specName} task=${taskId} sandbox=${sandbox}${model ? ` model=${model}` : ''}`,
  });

  let pid;
  try {
    pid = startPty(spawnCommand, spawnArgs, { cwd: projectDir });
  } catch (error) {
    emitEvent('log:append', {
      source: 'codex',
      message: `[codex] spawn failed: ${error?.message || String(error)}`,
    });
    return res.status(500).json({ error: error?.message || 'Failed to start Codex' });
  }
  return res.json({
    pid,
    runDocPath: doc.runDocPathRel,
    lastMessagePath: doc.lastMessagePathRel,
    task: {
      id: hit.id,
      done: Boolean(hit.done),
      title: hit.title,
      core: hit.core,
      details: hit.details,
      depends: Array.isArray(hit.depends) ? hit.depends : [],
      ac: hit.ac,
      originalIndex: hit.originalIndex,
      originalTitle: hit.originalTitle,
    },
  });
});

app.post('/specs/:name/tasks_atomic/codex/terminal', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  if (!specName) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  if (state.status === 'Reviewing') {
    return res.status(409).json({ error: 'Blocked by approval' });
  }

  const taskId = sanitizeAtomicTaskId(req.body?.taskId ?? req.body?.id ?? req.query?.taskId);
  if (!taskId) {
    return res.status(400).json({ error: 'taskId is required (e.g. 1.2)' });
  }

  const atomicPath = resolveSpecFile(specName, 'tasks_atomic');
  if (!fs.existsSync(atomicPath)) {
    return res.status(404).json({ error: 'Spec file not found' });
  }

  const content = fs.readFileSync(atomicPath, 'utf8');
  const atomicTasks = parseTasksAtomicMarkdown(content);
  const hit = atomicTasks.find((t) => String(t?.id || '').trim() === taskId);
  if (!hit) {
    return res.status(404).json({ error: `Atomic task not found: ${taskId}` });
  }

  const sandbox = normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox);
  const model = normalizeCodexModel(req.body?.model ?? req.query?.model);
  const projectDir = normalizeTerminalCwd(
    req.body?.cwd ??
      req.body?.projectDir ??
      (typeof req.query?.cwd === 'string' ? req.query.cwd : '') ??
      (typeof req.query?.projectDir === 'string' ? req.query.projectDir : ''),
  );

  const doc = buildCodexRunDoc(specName, hit, { sandbox, model });
  const runDocPathForPrompt = normalizePathForPrompt(doc.runDocPath);
  const prompt = `请按任务文档（绝对路径）${runDocPathForPrompt} 实现该原子任务。需要进一步信息时，请在终端中直接向我提问。`;

  const codexExecutable = (process.env.CODEX_COMMAND || 'codex').trim() || 'codex';
  const codexArgs = ['-a', 'never', '-s', sandbox, '--add-dir', SPEC_ROOT];
  if (model) codexArgs.push('-m', model);
  codexArgs.push('-C', projectDir, prompt);

  const spawnCommand = process.platform === 'win32' ? 'cmd.exe' : codexExecutable;
  const spawnArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', codexExecutable, ...codexArgs]
    : codexArgs;

  let session;
  try {
    session = createTerminalSession({
      title: `Codex · ${specName} · Task ${taskId}`,
      command: spawnCommand,
      args: spawnArgs,
      cwd: projectDir,
      cols: req.body?.cols,
      rows: req.body?.rows,
    });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'Failed to start terminal' });
  }

  return res.json({
    terminalId: session.id,
    pid: session.pid,
    title: session.title,
    runDocPath: doc.runDocPathRel,
    task: {
      id: hit.id,
      done: Boolean(hit.done),
      title: hit.title,
      core: hit.core,
      details: hit.details,
      depends: Array.isArray(hit.depends) ? hit.depends : [],
      ac: hit.ac,
      originalIndex: hit.originalIndex,
      originalTitle: hit.originalTitle,
    },
  });
});

app.post('/specs/:name/:artifact', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  const artifact = req.params.artifact;
  if (!specName || !SPEC_ARTIFACTS.includes(artifact)) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  const status = readSpecStatus(specName);
  if (artifact === 'design' && !status.requirementsConfirmed) {
    return res.status(409).json({ error: 'Requirements not confirmed' });
  }
  if (artifact === 'tasks' && !status.designConfirmed) {
    return res.status(409).json({ error: 'Design not confirmed' });
  }
  ensureSpecStatus(specName);
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const filePath = resolveSpecFile(specName, artifact);
  fs.mkdirSync(resolveSpecDir(specName), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  emitEvent('log:append', {
    source: 'spec',
    message: `[spec] saved ${specName}/${artifact}`,
  });
  return res.json({ ok: true });
});

app.post('/events', (req, res) => {
  const { type, payload } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: 'type is required' });
  }
  const event = emitEvent(type, payload ?? {});
  return res.json(event);
});

app.post('/cli/start', (req, res) => {
  const { command, args } = req.body || {};
  if (state.status === 'Reviewing') {
    return res.status(409).json({ error: 'Blocked by approval' });
  }
  const pid = startPty(command, args, { cwd: req.body?.cwd });
  res.json({ pid });
});

app.post('/cli/input', (req, res) => {
  const { input } = req.body || {};
  if (ptyProcess && typeof input === 'string') {
    ptyProcess.write(input);
  }
  res.json({ ok: true });
});

// ========== MVP5: 智能任务编排 API ==========

function normalizeCliAvailabilityForMvp5(value) {
  const obj = value && typeof value === 'object' ? value : {};
  return {
    codex: obj.codex !== false,
    claude: obj.claude !== false,
  };
}

function normalizeCliChoice(value) {
  return value === 'codex' || value === 'claude' ? value : null;
}

function normalizeMvp5PlanPayload(payload, taskIds, maxCliConcurrencyLimit) {
  const obj = payload && typeof payload === 'object' ? payload : null;
  if (!obj) return null;

  const rawMax =
    obj.maxCliConcurrency ?? obj.maxConcurrency ?? obj.concurrency ?? obj.max_concurrency ?? obj.max_cli_concurrency;
  const parsed = Number(rawMax);
  const maxCliConcurrency = Number.isFinite(parsed)
    ? Math.min(maxCliConcurrencyLimit, Math.max(1, Math.floor(parsed)))
    : maxCliConcurrencyLimit;

  const defaultCli = normalizeCliChoice(obj.defaultCli ?? obj.default_cli) || null;

  const overridesRaw = obj.cliOverrides ?? obj.cli_overrides ?? obj.cliAllocation ?? obj.cli_allocation ?? null;
  const overrides = overridesRaw && typeof overridesRaw === 'object' ? overridesRaw : {};

  const cliAllocation = {};
  for (const taskId of taskIds) {
    const overrideCli = normalizeCliChoice(overrides?.[taskId]);
    const chosen = overrideCli || defaultCli;
    if (chosen) cliAllocation[taskId] = chosen;
  }

  const rationaleRaw = obj.rationale ?? obj.reason ?? '';
  const rationale = typeof rationaleRaw === 'string' ? rationaleRaw.trim().slice(0, 800) : '';

  if (Object.keys(cliAllocation).length === 0) return null;

  return { maxCliConcurrency, cliAllocation, rationale };
}

function formatMvp5CliAvailability(value) {
  const availability = normalizeCliAvailabilityForMvp5(value);
  return `codex:${availability.codex ? 'on' : 'off'}, claude:${availability.claude ? 'on' : 'off'}`;
}

function formatMvp5TasksForPrompt(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return list
    .map((t) => {
      const id = String(t?.id || '').trim();
      if (!id) return null;
      const title = String(t?.title || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      const risk = String(t?.riskLevel || '').trim() || '-';
      const interaction = t?.requiresInteraction ? 'yes' : 'no';
      return `- ${id}｜${title || '（无标题）'}｜${risk}｜${interaction}`;
    })
    .filter(Boolean)
    .join('\n');
}

function formatMvp5DependenciesForPrompt(dag, limit = 240) {
  const edges = Array.isArray(dag?.edges) ? dag.edges : [];
  const lines = [];
  for (const edge of edges) {
    if (lines.length >= limit) break;
    const from = String(edge?.from || '').trim();
    const to = String(edge?.to || '').trim();
    if (!from || !to) continue;
    const type = String(edge?.type || '').trim() || '-';
    const strength = String(edge?.strength || '').trim() || '-';
    lines.push(`- ${from} -> ${to}｜${type}｜${strength}`);
  }
  if (edges.length > lines.length) {
    lines.push(`- ...(共 ${edges.length} 条依赖，已截断显示前 ${lines.length} 条)`);
  }
  return lines.join('\n');
}

async function generateMvp5PlanWithModel({
  specId,
  tasks,
  dag,
  maxCliConcurrencyLimit,
  cliAvailability,
  preferredModelId,
}) {
  const normalizedModel = LLM_MODEL_ALIASES[preferredModelId] || preferredModelId;
  const cfg = getLlmConfigForModel(normalizedModel);
  if (!cfg?.baseUrl || !cfg?.apiKey || !cfg?.model) {
    return { ok: false, skipped: true, error: { message: 'LLM config unavailable', context: describeLlmConfig(cfg) } };
  }

  const promptConfig = loadPromptConfig();
  const stage = promptConfig?.stages?.mvp5Plan;
  if (!stage) {
    return { ok: false, skipped: true, error: { message: 'Prompt stage mvp5Plan missing', context: null } };
  }

  const variables = {
    specId: String(specId || '').trim(),
    maxCliConcurrency: String(maxCliConcurrencyLimit),
    cliAvailability: formatMvp5CliAvailability(cliAvailability),
    tasks: formatMvp5TasksForPrompt(tasks),
    dependencies: formatMvp5DependenciesForPrompt(dag),
    summary: `tasks=${Array.isArray(dag?.tasks) ? dag.tasks.length : 0}, edges=${Array.isArray(dag?.edges) ? dag.edges.length : 0}`,
  };

  const promptRendered = {
    system: applyPromptTemplate(stage.system, variables),
    user: applyPromptTemplate(stage.user, variables),
  };

  const messages = [
    { role: 'system', content: promptRendered.system },
    { role: 'user', content: promptRendered.user },
  ];

  const timeoutMs = Math.min(
    Math.max(8000, Number(process.env.LLM_MVP5_PLAN_TIMEOUT_MS || 60000)),
    120000,
  );

  const content = await callLlm(messages, { ...cfg, timeoutMs }, {});
  const payload = tryParseJson(content);
  const taskIds = Array.isArray(dag?.tasks) ? dag.tasks.map((t) => t.id) : [];
  const normalized = normalizeMvp5PlanPayload(payload, taskIds, maxCliConcurrencyLimit);
  if (!normalized) {
    throw new Error(`LLM mvp5Plan output invalid: ${String(content).slice(0, 240)}`);
  }

  return {
    ok: true,
    skipped: false,
    result: normalized,
    llmContext: describeLlmConfig(cfg),
    prompt: { templates: { system: stage.system, user: stage.user }, rendered: promptRendered, variables },
  };
}

/**
 * POST /api/mvp5/analyze-dependencies
 * 分析任务依赖关系
 */
app.post('/api/mvp5/analyze-dependencies', async (req, res) => {
  try {
    const { specId, tasksContent, tasks: tasksInput, atomicTasks, options = {} } = req.body;

    let dagTasks = null;
    let usedLegacyAtomic = false;

    if (Array.isArray(tasksInput)) {
      dagTasks = ensureUniqueDagTaskIds(
        tasksInput.map((t, idx) => normalizeDagTaskObject(t, idx)).filter(Boolean),
      );
    } else if (typeof tasksContent === 'string') {
      dagTasks = parseDagTasksFromTasksContent(tasksContent);
    } else if (Array.isArray(atomicTasks)) {
      // Legacy fallback: keep compatibility but prefer TASKS_JSON.
      usedLegacyAtomic = true;
      const parsed = typeof atomicTasks[0] === 'string'
        ? dependencyAnalyzer.parseAtomicTasks(atomicTasks.join('\n'))
        : atomicTasks;
      dagTasks = ensureUniqueDagTaskIds(
        parsed
          .map((t, idx) => ({
            id: String(t?.id || `T${idx + 1}`).trim() || `T${idx + 1}`,
            title: String(t?.title || '').trim(),
            description: String(t?.description || t?.details || '').trim(),
            dependencies: [],
            scope: [],
            estimated_complexity: 'Medium',
          }))
          .filter((t) => t.title),
      );
    }

    if (!dagTasks || dagTasks.length === 0) {
      return res.status(400).json({
        error:
          '没有有效的任务：请在 tasks.md 的 ## TASKS_JSON 块中提供 { "tasks": [...] }，或直接传 tasksContent。',
      });
    }

    const warnings = [];
    if (usedLegacyAtomic) {
      warnings.push('提示：当前分析使用 legacy atomicTasks 输入，建议改用 tasks.md 的 TASKS_JSON。');
    }
    if (dagTasks.length > 25) {
      warnings.push(`任务数量为 ${dagTasks.length}，建议 ≤ 25（参照 docs/任务编排.md）。`);
    }

    const taskIds = new Set(dagTasks.map((t) => t.id));
    const dependencyEdges = [];
    const unknownDeps = new Set();

    dagTasks.forEach((task) => {
      const deps = Array.isArray(task?.dependencies) ? task.dependencies : [];
      deps.forEach((depId) => {
        const dep = String(depId ?? '').trim();
        if (!dep || dep === task.id) return;
        if (!taskIds.has(dep)) {
          unknownDeps.add(`${task.id} -> ${dep}`);
          return;
        }
        dependencyEdges.push({
          from: dep,
          to: task.id,
          type: 'explicit',
          strength: 'strong',
          description: `显式依赖: ${task.id} 依赖 ${dep}`,
        });
      });
    });

    if (unknownDeps.size) {
      const items = Array.from(unknownDeps).slice(0, 12);
      warnings.push(
        `检测到无效 dependencies 引用（已忽略）：${items.join('；')}${unknownDeps.size > items.length ? '…' : ''}`,
      );
    }

    const scopeConflicts = detectDagScopeConflicts(dagTasks);
    warnings.push(...scopeConflicts.warnings);

    const tasksForDag = dagTasks.map((t) => {
      const meta = [];
      if (Array.isArray(t.scope) && t.scope.length) meta.push(`scope: ${t.scope.join(', ')}`);
      if (t.estimated_complexity) meta.push(`complexity: ${t.estimated_complexity}`);
      const metaBlock = meta.length ? `\n\n${meta.join('\n')}` : '';
      return {
        id: t.id,
        title: t.title,
        description: `${t.description || ''}${metaBlock}`.trim(),
      };
    });

    // 构建 DAG（只使用 dependencies，scope 冲突只做提示，不影响拓扑）
    const dag = dagBuilder.buildDAG(tasksForDag, dependencyEdges);
    if (scopeConflicts.edges.length) {
      dag.edges = [...dag.edges, ...scopeConflicts.edges];
    }

    // 并发约束：最大 CLI 并发数（上限 8）
    const rawMaxCliConcurrency = options.maxCliConcurrency ?? process.env.MVP5_MAX_CLI_CONCURRENCY;
    const parsedMaxCliConcurrency = Number(rawMaxCliConcurrency);
    const maxCliConcurrency = Number.isFinite(parsedMaxCliConcurrency)
      ? Math.min(8, Math.max(1, Math.floor(parsedMaxCliConcurrency)))
      : 8;

    const cliAvailability = normalizeCliAvailabilityForMvp5(options.cliAvailability);

    // 生成推荐方案（默认：规则引擎 + 可选 LLM 方案）
    const recommendations = recommender.generateRecommendations(dag, {
      cliAvailability,
      maxCliConcurrency,
    });

    const wantLlmPlan = options.useLlmPlan !== false;
    const preferredPlanModelRaw =
      typeof options.planModel === 'string' && options.planModel.trim()
        ? options.planModel.trim()
        : (process.env.MVP5_PLAN_LLM_MODEL || 'claude-opus-4-5-20251101');
    const preferredPlanModel = LLM_MODEL_ALIASES[preferredPlanModelRaw] || preferredPlanModelRaw;

    if (wantLlmPlan) {
      try {
        const modelPlan = await generateMvp5PlanWithModel({
          specId,
          tasks: tasksForDag.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            riskLevel: recommender.assessTaskRisk(t),
            requiresInteraction: recommender.requiresInteraction(t),
          })),
          dag,
          maxCliConcurrencyLimit: maxCliConcurrency,
          cliAvailability,
          preferredModelId: preferredPlanModel,
        });

        if (modelPlan?.ok && modelPlan.result) {
          const effectiveConcurrency = Math.min(maxCliConcurrency, modelPlan.result.maxCliConcurrency || maxCliConcurrency);
          const llmRec = recommender.generateRecommendation(dag, {
            cliAvailability,
            maxCliConcurrency: effectiveConcurrency,
            cliAllocationOverride: modelPlan.result.cliAllocation,
          });
          if (llmRec?.feasible) {
            llmRec.label = `模型方案（${preferredPlanModel}）`;
            llmRec.priority = 'high';
            llmRec.generatedBy = 'llm';
            llmRec.llm = { model: preferredPlanModel, providerId: modelPlan.llmContext?.providerId || null };
            if (modelPlan.result.rationale) {
              llmRec.rationale = modelPlan.result.rationale;
            }
            recommendations.unshift(llmRec);
          }
        }
      } catch (error) {
        // LLM plan is best-effort; fall back to heuristic recommendations.
        console.warn('[MVP5] LLM plan generation skipped:', error?.message || error);
      }
    }

    // 跨平台路径检查
    const allPaths = dagTasks.flatMap((t) => (Array.isArray(t?.scope) ? t.scope : []));
    const compatibility = pathAdapter.checkCompatibility(
      allPaths,
      options.devPlatform || 'windows',
      options.targetPlatform || 'linux'
    );

    // 生成分析结果
    const analysisId = nanoid(10);
    const result = {
      analysisId,
      specId,
      maxCliConcurrency,
      analyzedAt: new Date().toISOString(),
      tasks: tasksForDag.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        riskLevel: recommender.assessTaskRisk(t),
        requiresInteraction: recommender.requiresInteraction(t),
      })),
      graph: dag,
      recommendations,
      warnings,
      platformNotes: compatibility.issues.length > 0 ? compatibility : undefined,
      summary: recommender.generateExecutionSummary({ graph: dag, warnings, maxCliConcurrency }),
    };

    analysisResults.set(analysisId, result);

    res.json(result);
  } catch (error) {
    console.error('[MVP5] 依赖分析错误:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mvp5/analyze-dependencies/:id
 * 获取分析结果
 */
app.get('/api/mvp5/analyze-dependencies/:id', (req, res) => {
  const { id } = req.params;
  const result = analysisResults.get(id);

  if (!result) {
    return res.status(404).json({ error: '分析结果不存在' });
  }

  res.json(result);
});

/**
 * POST /api/mvp5/execution-plans
 * 创建执行计划
 */
app.post('/api/mvp5/execution-plans', (req, res) => {
  try {
    const { specId, analysisId, selectedRecommendation, modifications = {} } = req.body;

    // 获取分析结果
    const analysis = analysisResults.get(analysisId);
    if (!analysis) {
      return res.status(404).json({ error: '分析结果不存在' });
    }

    // 获取选中的推荐方案
    const recommendation = analysis.recommendations[selectedRecommendation] || analysis.recommendations[0];
    if (!recommendation) {
      return res.status(400).json({ error: '无效的推荐方案' });
    }

    // 应用修改
    let phases = [...recommendation.phases];
    if (modifications.excludedTasks && modifications.excludedTasks.length > 0) {
      phases = phases.map(phase => ({
        ...phase,
        taskIds: phase.taskIds.filter(id => !modifications.excludedTasks.includes(id)),
      })).filter(phase => phase.taskIds.length > 0);
    }

    // MVP5 编排阶段不再区分 Codex/Claude：执行阶段统一使用 Codex（CLI 选择留给终端面板）
    const planTaskIds = Array.from(new Set(phases.flatMap((p) => p.taskIds)));
    const cliAllocation = Object.fromEntries(planTaskIds.map((taskId) => [taskId, 'codex']));

    // 创建执行计划
    const planId = nanoid(10);
    const plan = {
      planId,
      specId,
      analysisId,
      createdAt: new Date().toISOString(),
      status: 'pending',
      phases,
      cliAllocation,
      modifications,
      estimatedDuration: phases.reduce((sum, p) => sum + (p.estimatedDuration || 0), 0),
    };

    executionPlans.set(planId, plan);

    res.json(plan);
  } catch (error) {
    console.error('[MVP5] 创建执行计划错误:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mvp5/execution-plans/:id
 * 获取执行计划
 */
app.get('/api/mvp5/execution-plans/:id', (req, res) => {
  const { id } = req.params;
  const plan = executionPlans.get(id);

  if (!plan) {
    return res.status(404).json({ error: '执行计划不存在' });
  }

  res.json(plan);
});

function quoteCmdArgument(value) {
  const raw = String(value ?? '');
  if (!raw) return '""';
  if (/[\s&|<>^"]/.test(raw)) {
    return `"${raw.replace(/"/g, '\\"')}"`;
  }
  return raw;
}

function buildMvp5TaskRunDoc(specName, task, options = {}) {
  const runsDir = path.join(resolveSpecDir(specName), '.runlogs', 'mvp5-runs');
  fs.mkdirSync(runsDir, { recursive: true });

  const taskId = String(task?.id || 'unknown').trim() || 'unknown';
  const safeTaskId = taskId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z');
  const runDocPath = path.join(runsDir, `task-${safeTaskId}-${stamp}.md`);

  const rel = (absPath) => normalizePathForPrompt(path.relative(REPO_DIR, absPath));
  const artifacts = {
    requirements: resolveSpecFile(specName, 'requirements'),
    design: resolveSpecFile(specName, 'design'),
    tasks: resolveSpecFile(specName, 'tasks'),
  };

  const lines = [];
  lines.push('# Codex 任务执行文档（MVP5）');
  lines.push('');
  lines.push(`- Spec: ${specName}`);
  lines.push(`- Task: ${taskId}`);
  if (task?.title) lines.push(`- Title: ${String(task.title).trim()}`);
  if (options.executionId) lines.push(`- Execution: ${options.executionId}`);
  if (options.planId) lines.push(`- Plan: ${options.planId}`);
  if (Number.isFinite(options.phaseIndex)) lines.push(`- PhaseIndex: ${options.phaseIndex}`);
  lines.push(`- StartedAt: ${new Date().toISOString()}`);
  if (options.model) lines.push(`- Model: ${options.model}`);
  if (options.sandbox) lines.push(`- Sandbox: ${options.sandbox}`);
  if (options.projectDir) lines.push(`- ProjectDir: ${normalizePathForPrompt(options.projectDir)}`);
  lines.push('');
  lines.push('## Spec 入口');
  lines.push(`- requirements: \`${normalizePathForPrompt(artifacts.requirements)}\``);
  lines.push(`- design: \`${normalizePathForPrompt(artifacts.design)}\``);
  lines.push(`- tasks: \`${normalizePathForPrompt(artifacts.tasks)}\``);
  lines.push('');
  lines.push('## 本次任务（来自 tasks.md 的 TASKS_JSON）');
  lines.push(`- title: ${String(task?.title || '').trim()}`);
  lines.push(`- description: ${String(task?.description || '').trim()}`);
  const deps = Array.isArray(task?.dependencies) ? task.dependencies.map((v) => String(v || '').trim()).filter(Boolean) : [];
  const scope = Array.isArray(task?.scope) ? task.scope.map((v) => String(v || '').trim()).filter(Boolean) : [];
  if (deps.length) lines.push(`- dependencies: ${deps.join(', ')}`);
  if (scope.length) lines.push(`- scope: ${scope.join(', ')}`);
  if (task?.estimated_complexity) lines.push(`- estimated_complexity: ${String(task.estimated_complexity).trim()}`);
  lines.push('');
  lines.push('## 执行要求');
  lines.push('- 以本任务为“闭环交付物”，不要做微观步骤拆解。');
  lines.push('- 按仓库既有约束实现与自测；必要时补充最小可行验证步骤。');
  lines.push('- 完成后将关键变更、验证方式与结果回写到 tasks.md（建议追加到对应任务条目下）。');
  lines.push('');

  fs.writeFileSync(runDocPath, lines.join('\n'), 'utf8');
  return { runDocPath, runDocPathRel: rel(runDocPath), artifacts };
}

function inferMvp5MaxCliConcurrency(plan, analysis) {
  const raw = Number(analysis?.maxCliConcurrency ?? analysis?.summary?.maxCliConcurrency);
  if (Number.isFinite(raw)) return Math.min(8, Math.max(1, Math.floor(raw)));
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  const fromPhases = phases.reduce((acc, phase) => {
    const candidate = Number(phase?.maxConcurrency ?? (Array.isArray(phase?.taskIds) ? phase.taskIds.length : 1));
    return Number.isFinite(candidate) ? Math.max(acc, candidate) : acc;
  }, 1);
  return Math.min(8, Math.max(1, Math.floor(fromPhases || 1)));
}

function loadDagTasksForSpec(specName) {
  const tasksPath = resolveSpecFile(specName, 'tasks');
  if (!fs.existsSync(tasksPath)) return null;
  const content = fs.readFileSync(tasksPath, 'utf8');
  return parseDagTasksFromTasksContent(content);
}

function scheduleMvp5Execution(runner) {
  if (!runner || runner.stopped) return;
  const state = executionStates.get(runner.executionId);
  const plan = executionPlans.get(runner.planId);
  if (!state || !plan) return;
  if (state.status !== 'running') return;

  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  const phaseIndex = Number(state.currentPhase ?? 0);
  const phase = phases[phaseIndex];

  if (!phase) {
    state.status = 'completed';
    state.updatedAt = new Date().toISOString();
    plan.status = 'completed';
    return;
  }

  const phaseTaskIds = Array.isArray(phase.taskIds) ? phase.taskIds : [];
  const hasFailed = phaseTaskIds.some((id) => state.tasks?.[id]?.status === 'failed');
  if (hasFailed) {
    state.status = 'failed';
    state.updatedAt = new Date().toISOString();
    plan.status = 'failed';
    return;
  }

  const isPhaseDone = phaseTaskIds.length
    ? phaseTaskIds.every((id) => ['completed', 'skipped'].includes(state.tasks?.[id]?.status))
    : true;

  if (isPhaseDone) {
    state.currentPhase = phaseIndex + 1;
    state.updatedAt = new Date().toISOString();
    setTimeout(() => scheduleMvp5Execution(runner), 0);
    return;
  }

  const runningCount = phaseTaskIds.filter((id) => state.tasks?.[id]?.status === 'running').length;
  const maxConcurrency = phase.type === 'serial'
    ? 1
    : Math.min(
        runner.maxCliConcurrency,
        Number.isFinite(phase.maxConcurrency) ? Math.max(1, Math.floor(phase.maxConcurrency)) : runner.maxCliConcurrency,
      );
  const slots = Math.max(0, maxConcurrency - runningCount);
  if (slots <= 0) return;

  const pending = phaseTaskIds.filter((id) => state.tasks?.[id]?.status === 'pending');
  if (!pending.length) return;

  const freeWorkers = runner.workers.filter((w) => !w.busy);
  const canStart = Math.min(slots, pending.length, freeWorkers.length);
  for (let i = 0; i < canStart; i += 1) {
    startMvp5TaskOnWorker(runner, freeWorkers[i], pending[i], phaseIndex);
  }
}

function handleMvp5WorkerData(runner, worker, data) {
  if (!runner || !worker?.current) return;
  worker.tail = `${worker.tail}${data}`;
  if (worker.tail.length > 12000) worker.tail = worker.tail.slice(worker.tail.length - 12000);

  const marker = worker.current.marker;
  const idx = worker.tail.indexOf(marker);
  if (idx < 0) return;

  const after = worker.tail.slice(idx + marker.length);
  const match = /^(-?\d+)/.exec(after);
  if (!match) return;

  const exitCode = Number(match[1]);
  const finishedAt = new Date().toISOString();
  const state = executionStates.get(runner.executionId);
  const plan = executionPlans.get(runner.planId);
  if (!state || !plan) return;

  const { taskId, phaseIndex, runDocPathRel } = worker.current;
  const taskState = state.tasks?.[taskId];
  if (taskState) {
    taskState.completedAt = finishedAt;
    taskState.status = exitCode === 0 ? 'completed' : 'failed';
    if (runDocPathRel) taskState.runDocPath = runDocPathRel;
    taskState.error = exitCode === 0 ? undefined : `CLI 退出码 ${exitCode}`;
  }

  if (exitCode !== 0) {
    state.failures = Array.isArray(state.failures) ? state.failures : [];
    state.failures.push({
      taskId,
      phaseId: plan.phases?.[phaseIndex]?.phaseId || String(phaseIndex),
      error: `CLI 退出码 ${exitCode}`,
      canRetry: true,
      downstreamAffected: [],
    });
    state.status = 'failed';
    plan.status = 'failed';
  }

  state.updatedAt = finishedAt;
  worker.busy = false;
  worker.current = null;
  worker.tail = '';

  setTimeout(() => scheduleMvp5Execution(runner), 0);
}

function startMvp5TaskOnWorker(runner, worker, taskId, phaseIndex) {
  const state = executionStates.get(runner.executionId);
  const plan = executionPlans.get(runner.planId);
  if (!state || !plan) return;

  const task = runner.tasksById.get(taskId) || { id: taskId, title: taskId, description: '' };
  const sandbox = normalizeCodexSandbox(runner.sandbox);
  const model = normalizeCodexModel(runner.model);

  const doc = buildMvp5TaskRunDoc(runner.specName, task, {
    sandbox,
    model,
    planId: runner.planId,
    executionId: runner.executionId,
    phaseIndex,
    projectDir: runner.projectDir,
  });
  const runDocPathAbs = normalizePathForPrompt(doc.runDocPath);
  const prompt = `请按任务文档（绝对路径）${runDocPathAbs} 实现该任务，完成后自检并用简短要点总结变更与验证结果。`;

  const runId = nanoid(8);
  const marker = `__MVP5_TASK_DONE__${runId}__`;

  const codexExecutable = (process.env.CODEX_COMMAND || 'codex').trim() || 'codex';
  const args = [
    '-a',
    'never',
    '-s',
    sandbox,
    '--add-dir',
    SPEC_ROOT,
  ];
  if (model) {
    args.push('-m', model);
  }
  args.push('-C', runner.projectDir, prompt);

  const cmdLine = [codexExecutable, ...args].map(quoteCmdArgument).join(' ');
  const input = [
    `cd /d ${quoteCmdArgument(runner.projectDir)}`,
    cmdLine,
    `echo ${marker}%ERRORLEVEL%`,
    '',
  ].join('\r\n');

  const startedAt = new Date().toISOString();
  const taskState = state.tasks?.[taskId];
  if (taskState) {
    taskState.status = 'running';
    taskState.startedAt = startedAt;
    taskState.terminalId = worker.terminalId;
    taskState.runDocPath = doc.runDocPathRel;
    taskState.error = undefined;
  }
  state.updatedAt = startedAt;

  worker.busy = true;
  worker.current = { taskId, phaseIndex, marker, runDocPathRel: doc.runDocPathRel };

  try {
    writeTerminalInput(worker.session, input);
  } catch (error) {
    const failedAt = new Date().toISOString();
    if (taskState) {
      taskState.status = 'failed';
      taskState.completedAt = failedAt;
      taskState.error = error?.message ? String(error.message) : 'Failed to write terminal input';
    }
    state.failures = Array.isArray(state.failures) ? state.failures : [];
    state.failures.push({
      taskId,
      phaseId: plan.phases?.[phaseIndex]?.phaseId || String(phaseIndex),
      error: taskState?.error || 'Failed to write terminal input',
      canRetry: true,
      downstreamAffected: [],
    });
    state.status = 'failed';
    plan.status = 'failed';
    state.updatedAt = failedAt;
    worker.busy = false;
    worker.current = null;
  }
}

function startMvp5ExecutionRunner({
  executionId,
  planId,
  specName,
  projectDir,
  sandbox = 'workspace-write',
  model = null,
}) {
  const state = executionStates.get(executionId);
  const plan = executionPlans.get(planId);
  const analysis = plan ? analysisResults.get(plan.analysisId) : null;
  if (!state || !plan) return null;

  const tasks = loadDagTasksForSpec(specName) || [];
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  const maxCliConcurrency = inferMvp5MaxCliConcurrency(plan, analysis);
  const workers = [];

  for (let i = 0; i < maxCliConcurrency; i += 1) {
    const session = createTerminalSession({
      title: `MVP5 · ${specName} · Worker ${i + 1}`,
      command: 'cmd.exe',
      args: [],
      cwd: projectDir,
    });

    const worker = {
      terminalId: session.id,
      session,
      busy: false,
      current: null,
      tail: '',
      dispose: null,
    };
    workers.push(worker);
  }

  const runner = {
    executionId,
    planId,
    specName,
    projectDir,
    sandbox,
    model,
    maxCliConcurrency,
    workers,
    tasksById,
    stopped: false,
  };

  workers.forEach((worker) => {
    worker.dispose = worker.session.proc.onData((data) => handleMvp5WorkerData(runner, worker, data));
  });

  mvp5ExecutionRunners.set(executionId, runner);
  setTimeout(() => scheduleMvp5Execution(runner), 0);
  return runner;
}

/**
 * POST /api/mvp5/execution-plans/:id/start
 * 启动执行
 */
app.post('/api/mvp5/execution-plans/:id/start', (req, res) => {
  try {
    const { id } = req.params;
    const plan = executionPlans.get(id);

    if (!plan) {
      return res.status(404).json({ error: '执行计划不存在' });
    }

    if (plan.status === 'running') {
      return res.status(400).json({ error: '执行计划已在运行中' });
    }

    // 创建执行状态
    const executionId = nanoid(10);
    const executionState = {
      executionId,
      planId: id,
      specId: plan.specId,
      status: 'running',
      currentPhase: 0,
      tasks: {},
      failures: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 初始化任务状态
    plan.phases.forEach(phase => {
      phase.taskIds.forEach(taskId => {
        executionState.tasks[taskId] = {
          taskId,
          status: 'pending',
          cli: plan.cliAllocation[taskId] || 'codex',
          retryCount: 0,
        };
      });
    });

    executionStates.set(executionId, executionState);
    plan.status = 'running';
    plan.executionId = executionId;

    const specName = sanitizeSpecName(plan.specId);
    if (!specName) {
      return res.status(400).json({ error: 'specId 无效，无法启动执行' });
    }

    const sandbox = normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox);
    const model = normalizeCodexModel(req.body?.model ?? req.query?.model);
    const projectDir = normalizeTerminalCwd(
      req.body?.cwd ??
        req.body?.projectDir ??
        (typeof req.query?.cwd === 'string' ? req.query.cwd : '') ??
        (typeof req.query?.projectDir === 'string' ? req.query.projectDir : ''),
    );

    // 启动执行（默认：固定 worker 池复用终端，并发≤8；暂时统一使用 Codex）
    const runner = startMvp5ExecutionRunner({
      executionId,
      planId: id,
      specName,
      projectDir,
      sandbox,
      model,
    });

    if (!runner) {
      executionState.status = 'failed';
      executionState.updatedAt = new Date().toISOString();
      plan.status = 'failed';
      return res.status(500).json({ error: '启动执行失败：runner 初始化失败' });
    }

    res.json({
      executionId,
      status: 'started',
      message: '执行已启动',
    });
  } catch (error) {
    console.error('[MVP5] 启动执行错误:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mvp5/execution/:id/status
 * 获取执行状态
 */
app.get('/api/mvp5/execution/:id/status', (req, res) => {
  const { id } = req.params;
  const state = executionStates.get(id);

  if (!state) {
    return res.status(404).json({ error: '执行状态不存在' });
  }

  res.json(state);
});

/**
 * POST /api/mvp5/execution/:id/retry/:taskId
 * 重启失败的任务
 */
app.post('/api/mvp5/execution/:id/retry/:taskId', (req, res) => {
  try {
    const { id, taskId } = req.params;
    const state = executionStates.get(id);

    if (!state) {
      return res.status(404).json({ error: '执行状态不存在' });
    }

    const task = state.tasks[taskId];
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    if (task.status !== 'failed') {
      return res.status(400).json({ error: '只能重启失败的任务' });
    }

    // 重置任务状态
    task.status = 'pending';
    task.retryCount += 1;
    task.error = undefined;
    state.updatedAt = new Date().toISOString();

    // 重新执行任务（复用既有 runner；如 runner 丢失则尝试重建）
    const plan = executionPlans.get(state.planId);
    if (plan) {
      plan.status = 'running';
    }
    state.status = 'running';
    state.failures = Array.isArray(state.failures)
      ? state.failures.filter((f) => f?.taskId !== taskId)
      : [];

    let runner = mvp5ExecutionRunners.get(id) || null;
    if (!runner && plan) {
      const specName = sanitizeSpecName(plan.specId);
      if (specName) {
        runner = startMvp5ExecutionRunner({
          executionId: id,
          planId: state.planId,
          specName,
          projectDir: normalizeTerminalCwd(''),
          sandbox: normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox),
          model: normalizeCodexModel(req.body?.model ?? req.query?.model),
        });
      }
    }

    if (runner && plan) {
      const phaseIndex = Array.isArray(plan.phases)
        ? plan.phases.findIndex((p) => Array.isArray(p?.taskIds) && p.taskIds.includes(taskId))
        : -1;
      if (phaseIndex >= 0 && Number(state.currentPhase) > phaseIndex) {
        state.currentPhase = phaseIndex;
      }
      setTimeout(() => scheduleMvp5Execution(runner), 0);
    }

    res.json({
      taskId,
      status: 'pending',
      retryCount: task.retryCount,
      message: '任务已重新加入队列',
    });
  } catch (error) {
    console.error('[MVP5] 重启任务错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== MVP5: API 结束 ==========

io.on('connection', (socket) => {
  socket.emit('state:init', {
    status: state.status,
    tasks: state.tasks,
    lastDiff: state.lastDiff,
    approvals: Object.values(state.approvals),
    testReport: state.testReport,
    logs: state.logs,
    terminals: listTerminalSessions(),
  });

  socket.on('approval:submit', (payload) => {
    emitEvent('approval:resolve', payload);
  });

  socket.on('approval:request', (payload) => {
    const request = {
      id: payload?.id || nanoid(),
      title: payload?.title || '审批请求',
      description: payload?.description,
      options: payload?.options,
    };
    emitEvent('approval:request', request);
  });

  socket.on('requirement:patch', (payload) => {
    emitEvent('requirement:patch', payload);
  });

  socket.on('task:replace', (payload) => {
    emitEvent('task:graph', payload);
  });

  socket.on('cli:start', (payload) => {
    if (state.status === 'Reviewing') {
      socket.emit('cli:blocked', { reason: 'Blocked by approval' });
      return;
    }
    const pid = startPty(payload?.command, payload?.args);
    socket.emit('cli:started', { pid });
  });

  socket.on('cli:input', (payload) => {
    if (ptyProcess && typeof payload?.input === 'string') {
      ptyProcess.write(payload.input);
    }
  });

  socket.on('terminal:input', (payload) => {
    const session = getTerminalSession(payload?.terminalId);
    if (!session) return;
    if (typeof payload?.input !== 'string') return;
    writeTerminalInput(session, payload.input);
  });

  socket.on('terminal:resize', (payload) => {
    const session = getTerminalSession(payload?.terminalId);
    if (!session) return;
    resizeTerminal(session, payload?.cols, payload?.rows);
  });

  socket.on('terminal:kill', (payload) => {
    const session = getTerminalSession(payload?.terminalId);
    if (!session) return;
    killTerminal(session);
  });
});

server.listen(PORT, () => {
  console.log(`Workflow bridge running on http://localhost:${PORT}`);
});

const watchTargets = WATCH_DIRS.split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => path.join(ROOT_DIR, value));

const watcher = chokidar.watch(watchTargets, {
  ignored: /node_modules|dist|logs|workflow[\\/]+bridge[\\/]+data/,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 100,
  },
});

watcher.on('add', (filePath) => handleFileChange('file added', filePath));
watcher.on('change', (filePath) => handleFileChange('file changed', filePath));
watcher.on('unlink', (filePath) => {
  const relativePath = path.relative(ROOT_DIR, filePath);
  const prevContent = fileSnapshots.get(filePath);
  if (prevContent !== undefined) {
    emitDiff(relativePath, prevContent, '');
  }
  fileSnapshots.delete(filePath);
  emitEvent('log:append', {
    source: 'watcher',
    message: `[file removed] ${relativePath}`,
  });
});

emitEvent('log:append', {
  source: 'watcher',
  message: `[watching] ${watchTargets.join(', ') || 'none'}`,
});
