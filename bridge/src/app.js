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
const runtimeConfig = require('./lib/runtime-config');

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

function resolvePathFromEnv(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return path.resolve(trimmed);
  } catch {
    return null;
  }
}

const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const ROOT_DIR = resolvePathFromEnv(process.env.WORKFLOW_ROOT_DIR) || APP_DIR;
const REPO_DIR = ROOT_DIR;

const PORT = runtimeConfig.normalizePort(
  process.env.WORKFLOW_BRIDGE_PORT,
  runtimeConfig.readRuntimeConfig().defaultPort,
);
const DATA_DIR =
  resolvePathFromEnv(process.env.WORKFLOW_DATA_DIR) || path.join(__dirname, '..', 'data');
const EVENT_LOG = path.join(DATA_DIR, 'events.jsonl');
const LLM_CONFIG_FILE = path.join(DATA_DIR, 'llm-config.json');
// Prompts are editable via Dashboard and stored in a single, repo-local file for easy management.
const PROMPT_CONFIG_FILE =
  resolvePathFromEnv(process.env.WORKFLOW_PROMPT_CONFIG_FILE) ||
  path.join(ROOT_DIR, 'workflow', 'prompt-config.json');
// Reset-to-defaults reads from this repo-tracked baseline file.
const PROMPT_CONFIG_DEFAULTS_FILE = path.join(APP_DIR, 'workflow', 'prompt-config.defaults.json');
// Backward-compat: previous versions stored prompts under bridge/data (ignored by git).
const PROMPT_CONFIG_LEGACY_FILE = path.join(DATA_DIR, 'prompt-config.json');
const PROMPT_PRESETS_FILE = path.join(DATA_DIR, 'prompt-presets.json');
const WORKSPACE_CONFIG_FILE = path.join(DATA_DIR, 'workspace-config.json');
const CLI_TOOLS_CONFIG_FILE = path.join(DATA_DIR, 'cli-tools.json');
const DOCS_DIR = path.join(REPO_DIR, 'docs');
const WATCH_DIRS =
  process.env.WORKFLOW_WATCH_DIRS || '.codex,task,workflow';
const MAX_DIFF_CHARS = 8000;
const SPEC_ROOT =
  resolvePathFromEnv(process.env.WORKFLOW_SPEC_ROOT) || path.join(ROOT_DIR, 'workflow', 'specs');
const DEFAULT_TESTCLI_DIR = path.join(os.homedir(), 'testcli');
const LOGS_DIR = resolvePathFromEnv(process.env.WORKFLOW_LOGS_DIR) || path.join(REPO_DIR, 'logs');
const TEST_LOG_DIR = path.join(LOGS_DIR, 'test-sessions');
const DASHBOARD_DIST_DIR =
  resolvePathFromEnv(process.env.WORKFLOW_DASHBOARD_DIST) || path.join(APP_DIR, 'dashboard', 'dist');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SPEC_ROOT, { recursive: true });
try {
  fs.mkdirSync(DEFAULT_TESTCLI_DIR, { recursive: true });
} catch {
  // ignore
}
try {
  fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
} catch {
  // ignore
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(testLogRequestMiddleware);

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
const tasksIterateJobs = new Map();

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
  'atomize',
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
      'MVP5 智能任务编排会优先使用 Claude 4.5 Opus（claude-opus-4-5-20251101）生成“并发受限、worker 池复用”的执行方案；若调用失败/输出不可解析，将直接返回错误并在 UI 暴露原因。',
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
	        '在设计确认后调用。用于将设计草案拆成 tasks.md 的任务列表（模块/交付物级别，禁止原子化），并显式声明 dependencies 以便后续 DAG 并发编排与冲突预警。',
	      variables: ['design', 'prompt', 'minTasks', 'maxTasks'],
	      system:
	        '你是项目任务拆解助手。按 docs/任务编排.md 输出模块级任务清单与依赖拓扑。只输出 JSON，不要解释，不要包含分析或思考过程。',
	      user:
	        `设计内容如下：\n{{design}}\n\n补充描述：{{prompt}}\n\n` +
	        '请按 docs/任务编排.md 生成任务清单，严格只输出 JSON：\n' +
	        '{"tasks":[{"id":"task_1","title":"动宾结构","description":"任务目标契约（输入/输出/验收点）","dependencies":[],"scope":["/path"],"estimated_complexity":"Low|Medium|High"}]}\n\n' +
	        '要求：\n' +
	        '- 任务粒度：模块级/交付物级；严禁原子级/指令级拆解；总数 ≤ {{maxTasks}} 且必须 ≤ 25；建议 ≥ {{minTasks}}。\n' +
	        '- id 必须严格为 task_1, task_2, ... task_n（从 1 开始连续编号，禁止跳号/重复/其他格式）。\n' +
	        '- dependencies 必须仅引用本次输出中的 id；无依赖填 []。\n' +
	        '- scope：建议主要修改的文件范围（仓库相对路径或目录前缀），尽量减少重叠以降低冲突。\n' +
	        '- estimated_complexity 只能是 Low/Medium/High。\n' +
	        '- 只输出 JSON。',
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
        '在生成 flow report 后调用。用于从 requirements/design/tasks 快照中评审“任务拆解质量（任务级 DAG，可直接交付 CLI 执行）”并打分，同时输出可直接作为下一轮生成约束的 suggestions。',
      variables: ['specName', 'prompt', 'requirements', 'design', 'tasks', 'tasksAtomic'],
      system:
        '你是项目经理 + 资深工程评审。你将对 planA 的“任务拆解质量（任务级 DAG）”打分。只输出 JSON，不要解释。',
      user:
        `Spec：{{specName}}\n` +
        `原始需求：{{prompt}}\n\n` +
        '以下是该需求的核心文档快照：\n\n' +
        '【requirements.md】\n{{requirements}}\n\n' +
        '【design.md】\n{{design}}\n\n' +
        '【tasks.md】\n{{tasks}}\n\n' +
        '【tasks_atomic.md】\n{{tasksAtomic}}\n\n' +
        '请基于以下事实评审：本流程会在 tasks.md 之后生成 tasks_atomic.md（原子化任务表）供 CLI 逐条执行；因此请同时关注 tasks.md（模块级 DAG）与 tasks_atomic.md（文件级可执行性/冲突控制）的质量与一致性。\n' +
        '请按“任务粒度合理性 + DAG 依赖质量 + scope 冲突可控性 + 原子化可执行性/可验收性”评审并评分（0-100）。\n' +
        '重点检查：\n' +
        '1) 粒度与数量：任务必须是模块级/交付物级，总数 <= 25；禁止原子级/步骤级拆解。\n' +
        '2) 可执行性：description 是否写清输入/输出/验收点，并给出关键接口/数据结构/页面路由/命令等必要细节，避免空泛。\n' +
        '3) 依赖质量：dependencies 是否准确引用任务 id，能形成无环 DAG，尽量最大化可并行性。\n' +
        '4) scope 冲突：scope 是否能有效隔离主要修改范围，减少重叠；必要重叠是否用依赖关系串行化。\n' +
        '5) 原子化：tasks_atomic 是否“单任务单文件、路径明确、AC 可验证、与 tasks 对齐”。\n' +
        '6) 可验收性：是否提供可复现的验证方式（构建/测试/接口/页面路径与可观察结果）。\n\n' +
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
      variables: [
        'specId',
        'maxCliConcurrency',
        'cliAvailability',
        'tasks',
        'dependencies',
        'tasksAtomicHints',
        'summary',
      ],
      system:
        '你是“统筹大师”（任务编排总监）。你要为 tasks.md 的任务级 DAG 生成可落地的 CLI 执行方案；注意：编排对象是 tasks（task_1...），不是 tasks_atomic 的子任务。只输出 JSON，不要解释，不要包含分析或思考过程。',
      user:
        `SpecId：{{specId}}\n` +
        `并发硬上限：{{maxCliConcurrency}}（必须 <= 8）\n` +
        `可用 CLI：{{cliAvailability}}\n\n` +
        '任务清单（id｜title｜risk｜interaction）：\n' +
        '{{tasks}}\n\n' +
        '已识别依赖（from -> to｜type｜strength）：\n' +
        '{{dependencies}}\n\n' +
        '原子化提示（来自 tasks_atomic.md，仅用于判断文件冲突与并发风险；不要把子任务当成编排对象）：\n' +
        '{{tasksAtomicHints}}\n\n' +
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
      const contentType = String(response.headers.get('content-type') || '');
      const rawText = String(await response.text() || '');
      if (!response.ok) {
        const message = rawText ? `${response.status}: ${truncateText(rawText, 2000)}` : `${response.status}`;
        const err = new Error(`LLM request failed: ${message}`);
        err.llmContext = {
          ...llmContext,
          url,
          httpStatus: response.status,
          contentType,
          bodyPreview: rawText ? truncateText(rawText, 400) : '',
        };
        throw err;
      }
      let data;
      try {
        data = JSON.parse(rawText.replace(/^\uFEFF/, ''));
      } catch (parseError) {
        const err = new Error(
          `LLM response is not valid JSON (content-type: ${contentType || 'unknown'}). ` +
            `Body preview: ${rawText ? truncateText(rawText, 400) : '(empty)'}`,
        );
        err.llmContext = {
          ...llmContext,
          url,
          httpStatus: response.status,
          contentType,
          bodyPreview: rawText ? truncateText(rawText, 400) : '',
        };
        throw err;
      }
      onUsage?.(normalizeLlmUsage(data?.usage));
      const content = data?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string') {
        const err = new Error('LLM response empty');
        err.llmContext = { ...llmContext, url, httpStatus: response.status, contentType };
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
        const primary = error2 || error;
        primary.llmContext = {
          ...(primary?.llmContext || llmContext),
          attempts: [
            { baseUrl: trimmed, error: String(error?.message || error) },
            { baseUrl: v1Url, error: String(error2?.message || error2) },
          ],
        };
        throw primary;
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
      const contentType = String(response.headers.get('content-type') || '');
      if (!response.ok) {
        const rawText = String(await response.text() || '');
        const message = rawText ? `${response.status}: ${truncateText(rawText, 2000)}` : `${response.status}`;
        const err = new Error(`LLM request failed: ${message}`);
        err.llmContext = {
          ...llmContext,
          url,
          httpStatus: response.status,
          contentType,
          bodyPreview: rawText ? truncateText(rawText, 400) : '',
        };
        throw err;
      }

      // Some gateways ignore stream=true and still return a JSON payload.
      if (/application\/json/i.test(contentType)) {
        const rawText = String(await response.text() || '');
        let data;
        try {
          data = JSON.parse(rawText.replace(/^\uFEFF/, ''));
        } catch (parseError) {
          const err = new Error(
            `LLM response is not valid JSON (content-type: ${contentType || 'unknown'}). ` +
              `Body preview: ${rawText ? truncateText(rawText, 400) : '(empty)'}`,
          );
          err.llmContext = {
            ...llmContext,
            url,
            httpStatus: response.status,
            contentType,
            bodyPreview: rawText ? truncateText(rawText, 400) : '',
          };
          throw err;
        }
        onUsage?.(normalizeLlmUsage(data?.usage));
        const content = data?.choices?.[0]?.message?.content;
        if (!content || typeof content !== 'string') {
          const err = new Error('LLM response empty');
          err.llmContext = { ...llmContext, url, httpStatus: response.status, contentType };
          throw err;
        }
        onToken?.(content);
        return content.trim();
      }
      if (/text\/html/i.test(contentType)) {
        const rawText = String(await response.text() || '');
        const err = new Error(
          `LLM response is not a stream (content-type: ${contentType || 'unknown'}). ` +
            `Body preview: ${rawText ? truncateText(rawText, 400) : '(empty)'}`,
        );
        err.llmContext = {
          ...llmContext,
          url,
          httpStatus: response.status,
          contentType,
          bodyPreview: rawText ? truncateText(rawText, 400) : '',
        };
        throw err;
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
      } catch (error2) {
        const primary = error2 || error;
        primary.llmContext = {
          ...(primary?.llmContext || llmContext),
          attempts: [
            { baseUrl: trimmed, error: String(error?.message || error) },
            { baseUrl: v1Url, error: String(error2?.message || error2) },
          ],
        };
        throw primary;
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

function tasksIterateJobKey(specName, runId) {
  return `${String(specName || '').trim()}::${String(runId || '').trim()}`;
}

function logTasksIterate(job, message) {
  const entry = { at: new Date().toISOString(), message: String(message || '') };
  job.logs.push(entry);
  if (job.logs.length > 200) job.logs.shift();
  job.updatedAt = entry.at;
}

function getTasksIterateStatus(job) {
  return {
    running: job.running,
    total: job.total,
    completed: job.completed,
    logs: job.logs,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    outputRunId: job.outputRunId ?? null,
    outputReportPath: job.outputReportPath ?? null,
  };
}

function getTasksIterateJob(specName, runId) {
  const id = sanitizeRunId(runId);
  if (!id) return null;
  return tasksIterateJobs.get(tasksIterateJobKey(specName, id)) || null;
}

async function runTasksIterateJob(specName, runId, job, options = {}) {
  const id = sanitizeRunId(runId);
  try {
    if (!id) throw new Error('Invalid runId');
    const baseRun = readFlowRun(specName, id);
    if (!baseRun) throw new Error('Flow run not found');

    const ensured = ensureFlowRunArtifactsSnapshot(specName, baseRun);
    const artifacts = ensured.artifacts || readSpecArtifacts(specName);

    const prompt = String(baseRun?.prompt || readSpecStatus(specName)?.prompt || '');
    const requirements = String(artifacts?.requirements || '');
    const design = String(artifacts?.design || '');
    const tasks = String(artifacts?.tasks || '');

    const userNote = sanitizeReviewText(options?.userNote, 1800);
    const feedback = buildTasksIterationReasonFromReport(baseRun, userNote);
    const feedbackBlock = feedback ? `\n\n【评分与用户反馈（用于迭代约束）】\n${feedback}\n` : '';

    const status = readSpecStatus(specName);
    const { run: nextRun } = ensureActiveFlowRun(specName, status, {
      forceNew: true,
      reason: `tasks_iterate_from:${id}`,
    });
    const nextRunId = nextRun?.runId || null;
    if (!nextRunId) throw new Error('Failed to create flow run');
    job.outputRunId = nextRunId;
    logTasksIterate(job, `已创建新 runId：${nextRunId}`);

    const tasksJsonBlock = extractTasksJsonBlockFromMarkdown(tasks);
    const tasksForPrompt = tasksJsonBlock
      ? `## TASKS_JSON\n${tasksJsonBlock}\n## END_TASKS_JSON`
      : truncateTextMiddle(tasks, 14000);

    const variables = {
      specName,
      prompt: truncateTextMiddle(prompt, 6000),
      requirements: truncateTextMiddle(requirements, 14000),
      design: truncateTextMiddle(design, 14000),
      tasks: truncateTextMiddle(tasksForPrompt, 16000),
    };

    const promptTemplates = {
      system:
        '你是资深项目经理 + 工程架构评审。目标：基于需求/设计/现有 tasks.md 与评分反馈，迭代优化模块级任务清单（<=25），并显式给出 dependencies/scope，以便 DAG 并发编排与冲突预警。只输出 JSON，不要解释，不要包含分析或思考过程。',
      user:
        'Spec：{{specName}}\n原始需求：{{prompt}}\n\n【requirements.md】\n{{requirements}}\n\n【design.md】\n{{design}}\n\n【现有 tasks.md（仅供参考）】\n{{tasks}}' +
        feedbackBlock +
        '\n请按 docs/任务编排.md 迭代优化任务清单，要求：\n' +
        '1) 任务必须是模块级/交付物级，总数 <= 25；禁止原子级/步骤级拆解。\n' +
        '2) id 必须严格为 task_1, task_2, ... task_n（从 1 开始连续编号）；尽量保持现有任务语义与顺序稳定。\n' +
        '3) title：动宾结构；description：写清输入/输出/验收点，避免空泛；严禁 TBD/待定/[path]/占位符。\n' +
        '4) dependencies：仅引用任务 id，形成无环 DAG；文件写入冲突/接口依赖必须串行化。\n' +
        '5) scope：尽量精确到主要目录/文件集合，用于冲突预警；estimated_complexity 只能是 Low/Medium/High。\n\n' +
        '请严格只输出 JSON：{"tasks":[{"id":"task_1","title":"...","description":"...","dependencies":[],"scope":["/path"],"estimated_complexity":"Medium"}]}。',
    };

    const promptRendered = {
      system: applyPromptTemplate(promptTemplates.system, variables),
      user: applyPromptTemplate(promptTemplates.user, variables),
    };
    const messages = [
      { role: 'system', content: promptRendered.system },
      { role: 'user', content: promptRendered.user },
    ];

    const modelId = 'claude-opus-4-5-20251101';
    const cfg = getLlmConfigForModel(modelId);
    let usage = null;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    logTasksIterate(job, `开始调用模型：${getModelLabel(modelId)}（用于任务迭代）`);
    let content;
    try {
      assertValidLlmConfig(cfg);
      const timeoutMs = Math.min(
        Math.max(8000, Number(process.env.LLM_TASK_ITERATE_TIMEOUT_MS || 120000)),
        240000,
      );
      content = await callLlm(messages, { ...cfg, timeoutMs }, {
        onUsage: (u) => {
          usage = u;
        },
      });
    } catch (error) {
      const endedAt = new Date().toISOString();
      appendFlowRunStageAttemptToRun(specName, nextRunId, 'tasks', {
        label: `iterate:${modelId}`,
        stream: false,
        startedAt,
        endedAt,
        durationMs: Date.now() - startedMs,
        usage,
        llmContext: describeLlmConfig(cfg),
        prompt: { templates: promptTemplates, rendered: promptRendered, variables },
        meta: { modelId, providerId: cfg.providerId, baseRunId: id },
        error: { message: error?.message || String(error || ''), context: error?.llmContext || null },
      });
      throw error;
    }

    const payload = tryParseJson(content);
    const rawTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    const normalized = ensureUniqueDagTaskIds(
      rawTasks.map((t, idx) => normalizeDagTaskObject(t, idx)).filter(Boolean),
    );
    if (!normalized.length) {
      throw new Error(`LLM tasks iterate output invalid: ${String(content).slice(0, 240)}`);
    }

    const maxTotalTasks = 25;
    // Reserve slots for task_0 + final summary/debug task.
    const reservedSystemTasks = 2;
    const baseMaxTasks = Math.min(Math.max(1, maxTotalTasks - reservedSystemTasks), 23);
    const trimmed = normalized.slice(0, baseMaxTasks);
    const renumbered = renumberDagTasksToTaskSequence(trimmed, { prefix: 'task_' });
    const idSet = new Set(renumbered.map((t) => t.id));
    const baseTasks = renumbered.map((t) => {
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
    const withTask1Scope = ensureDagTask1InitScope(baseTasks);
    const withTask0 = ensureDagTask0LogsTask(withTask1Scope);
    const finalTasks = ensureDagFinalSummaryTask(withTask0, { maxTasks: maxTotalTasks });

    const notes = [
      `由 Claude 4.5 Opus 基于评分迭代生成（from runId: ${id}）`,
      userNote ? '包含用户补充修改意见' : null,
      '已自动追加 task_0（初始化 task_logs）',
      '已自动追加“最终修复与调试（收尾）”任务',
    ].filter(Boolean);
    const tasksMarkdown = buildTasksDagMarkdown({ tasks: finalTasks }, { notes });
    writeSpecFile(specName, 'tasks', tasksMarkdown);

    const nextStatus = readSpecStatus(specName);
    if (nextStatus.tasksConfirmed) {
      writeSpecStatus(specName, { ...nextStatus, tasksConfirmed: false });
    }

    const endedAt = new Date().toISOString();
    appendFlowRunStageAttemptToRun(specName, nextRunId, 'tasks', {
      label: `iterate:${modelId}`,
      stream: false,
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      usage,
      llmContext: describeLlmConfig(cfg),
      prompt: { templates: promptTemplates, rendered: promptRendered, variables },
      meta: { modelId, providerId: cfg.providerId, baseRunId: id },
      error: null,
    });

    const reportPath = refreshFlowReport(specName, nextRunId);
    if (reportPath) {
      job.outputReportPath = reportPath;
      logTasksIterate(job, `新流程报告已生成：${reportPath}`);
    }

    job.completed = 1;
    job.running = false;
    job.error = null;
    logTasksIterate(job, '任务迭代完成');
  } catch (error) {
    job.running = false;
    job.error = error?.message || String(error);
    logTasksIterate(job, `任务迭代失败：${job.error}`);
  }
}

function startTasksIterateJob(specName, runId, options = {}) {
  const id = sanitizeRunId(runId);
  if (!id) return null;
  const key = tasksIterateJobKey(specName, id);
  const existing = tasksIterateJobs.get(key);
  if (existing && existing.running) return existing;
  const now = new Date().toISOString();
  const job = existing || {
    specName,
    runId: id,
    running: false,
    total: 1,
    completed: 0,
    logs: [],
    error: null,
    startedAt: now,
    updatedAt: now,
    outputRunId: null,
    outputReportPath: null,
  };
  job.running = true;
  job.error = null;
  job.total = 1;
  job.completed = 0;
  job.startedAt = now;
  job.updatedAt = now;
  job.outputRunId = null;
  job.outputReportPath = null;
  if (options?.resetLogs === true) job.logs = [];
  tasksIterateJobs.set(key, job);
  logTasksIterate(job, '任务迭代任务已启动');
  setImmediate(() => {
    runTasksIterateJob(specName, id, job, options);
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
    if (/(前端框架|后端框架|数据库选型|部署方式|技术栈)/i.test(trimmed)) return true;
    const choiceHint = /(选型|选择|选用|用什么|使用什么|采用什么|哪(种|个)|还是|或者|\sor\s)/i;
    const targetHint =
      /(前端|后端|框架|编程语言|数据库|db|mysql|postgres|postgresql|mongo|mongodb|redis|docker|kubernetes|k8s|云|aws|gcp|azure|react|vue|angular|next\.?js|nuxt|nestjs|express|koa|spring|django|flask|fastapi)/i;
    if (choiceHint.test(trimmed) && targetHint.test(trimmed)) return true;
    return false;
  };

  const isValidClarifications = (normalized) => {
    if (!normalized || !Array.isArray(normalized.questions)) return false;
    if (normalized.questions.length < 3 || normalized.questions.length > 10) return false;
    return normalized.questions.every((q) => {
      if (isBadQuestionText(q.question)) return false;
      if (!Array.isArray(q.options) || q.options.length < 2) return false;
      if (
        q.options.some((opt) =>
          /(react|vue|angular|next\.?js|nuxt|nestjs|express|koa|spring|django|flask|fastapi|mysql|postgres|postgresql|mongo|mongodb|redis|docker|kubernetes|k8s|aws|gcp|azure)/i.test(
            String(opt?.label || ''),
          ),
        )
      ) {
        return false;
      }
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
  // No default clarification questions as fallback.
  return { changed: false, status: normalized };
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
      id: 'task_1',
      title: '明确范围与验收口径',
      description:
        '基于 requirements/design 明确范围边界、优先级与验收方式，补齐缺失信息，并在 tasks.md 固定可执行的 DAG 输入（TASKS_JSON）。',
      dependencies: [],
      scope: [],
      estimated_complexity: 'Medium',
    },
    {
      id: 'task_2',
      title: '项目基建与运行链路打通',
      description:
        '完成依赖安装、本地运行/构建链路与基础健康检查，确保后续任务能在可复现环境中推进。',
      dependencies: ['task_1'],
      scope: [],
      estimated_complexity: 'Medium',
    },
    {
      id: 'task_3',
      title: '数据模型与接口契约确定',
      description:
        '确定核心数据结构与接口契约（含错误处理/权限边界/边界条件）；必要时先补齐 schema/DTO/类型定义再进入功能实现。',
      dependencies: ['task_1'],
      scope: [],
      estimated_complexity: 'Medium',
    },
    {
      id: 'task_4',
      title: summary ? `实现核心功能模块（${summary}）` : '实现核心功能模块',
      description:
        '按 design 的关键流程实现核心功能闭环（包含必要的 API/业务逻辑/页面/交互），并将关键变更与验证方式回写到 tasks.md。',
      dependencies: ['task_2', 'task_3'],
      scope: [],
      estimated_complexity: 'High',
    },
    {
      id: 'task_5',
      title: '联调与回归验证',
      description:
        '按验收标准进行联调，补齐异常分支与边界处理，形成可复现验证步骤（命令/接口/页面路径/可观察结果）。',
      dependencies: ['task_4'],
      scope: [],
      estimated_complexity: 'Medium',
    },
    {
      id: 'task_6',
      title: '构建与交付物整理',
      description:
        '完成构建/测试/打包并整理运行说明；在回写记录中记录最终验证结果与注意事项。',
      dependencies: ['task_5'],
      scope: [],
      estimated_complexity: 'Low',
    },
    {
      id: 'task_7',
      title: '最终修复与调试（收尾）',
      description:
        '在所有任务完成后进行最后的修复与调试，补齐必要的回归验证与问题记录，确保交付状态稳定。',
      dependencies: ['task_1', 'task_2', 'task_3', 'task_4', 'task_5', 'task_6'],
      scope: [],
      estimated_complexity: 'Medium',
    },
  ];

  const notes = [
    '提示：本段为 tasks.md 模板（非模型生成结果），用于手工编辑/修复；可直接在 TASKS_JSON 内替换/增删任务。',
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
  return `task_${index + 1}`;
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
    const base = String(t?.id || `task_${idx + 1}`).trim() || `task_${idx + 1}`;
    let id = base;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${base}_${suffix++}`;
    }
    seen.add(id);
    return id === t.id ? t : { ...t, id };
  });
}

function renumberDagTasksToTaskSequence(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const prefix =
    typeof options?.prefix === 'string' && options.prefix.trim() ? options.prefix.trim() : 'task_';
  const idMap = new Map(list.map((t, idx) => [String(t?.id || '').trim(), `${prefix}${idx + 1}`]));
  return list.map((t, idx) => {
    const id = `${prefix}${idx + 1}`;
    const deps = Array.isArray(t?.dependencies) ? t.dependencies : [];
    const dependencies = deps
      .map((d) => String(d ?? '').trim())
      .filter(Boolean)
      .map((d) => idMap.get(d))
      .filter(Boolean);
    return { ...t, id, dependencies };
  });
}

function ensureDagTask0LogsTask(tasks) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  if (!list.length) return list;

  let task0 = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const task = list[i];
    if (String(task?.id || '').trim() === 'task_0') {
      task0 = task;
      list.splice(i, 1);
      break;
    }
  }

  const defaultTitle = '初始化 task_logs（协作日志）';
  const defaultDescription =
    '输入：无；输出：创建 task_logs/ 目录（用于任务协作与冲突规避）；后续任务在其中写入 task_*.md 工作报告；验收：task_logs 存在且可读写。';

  const normalizedTask0 = {
    ...(task0 || {}),
    id: 'task_0',
    title: String(task0?.title || '').trim() || defaultTitle,
    description: String(task0?.description || '').trim() || defaultDescription,
    dependencies: [],
    scope: Array.isArray(task0?.scope) ? task0.scope : [],
    estimated_complexity:
      typeof task0?.estimated_complexity === 'string' && task0.estimated_complexity.trim()
        ? task0.estimated_complexity.trim()
        : 'Low',
  };

  const out = [normalizedTask0, ...list];

  return out.map((t) => {
    if (t.id === 'task_0') return t;
    const deps = Array.isArray(t?.dependencies) ? t.dependencies : [];
    const next = Array.from(
      new Set(
        deps
          .map((d) => String(d ?? '').trim())
          .filter((d) => d && d !== t.id && d !== 'task_0')
          .concat(['task_0']),
      ),
    );
    return { ...t, dependencies: next };
  });
}

const TASK1_INIT_SCOPE_HINTS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'vite.config.js',
  'index.html',
  'src/main.tsx',
  'src/main.ts',
  'src/App.tsx',
  'src/App.ts',
  'src/vite-env.d.ts',
];

function normalizeScopeHintPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unified = raw.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  if (!unified || unified === '/' || unified === '.' || unified === './') return '';
  return unified.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function ensureDagTask1InitScope(tasks) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const idx = list.findIndex((t) => String(t?.id || '').trim() === 'task_1');
  if (idx < 0) return list;

  const task = list[idx] || {};
  const rawScope = Array.isArray(task?.scope) ? task.scope : [];
  const cleanedScope = rawScope.map(normalizeScopeHintPath).filter(Boolean);
  const nextScope = Array.from(new Set([...cleanedScope, ...TASK1_INIT_SCOPE_HINTS])).slice(0, 32);
  list[idx] = { ...task, scope: nextScope };
  return list;
}

function looksLikeDagFinalSummaryTask(task) {
  const title = String(task?.title || '').trim();
  const description = String(task?.description || '').trim();
  const text = `${title} ${description}`.trim();
  if (!text) return false;
  // Avoid false positives like "验收点/验收标准" in normal task descriptions.
  return /(总结|收尾|回归(验证|测试)|最终(修复|调试|回归|验收|检查)|final(\s+(check|qa))?|post[-\s]?check|regression(\s+test)?)/i.test(
    text,
  );
}

function ensureDagFinalSummaryTask(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const maxTasks = Number.isFinite(options?.maxTasks) ? Math.max(1, Math.floor(options.maxTasks)) : 25;
  if (!list.length) return list;

  let summary = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const task = list[i];
    if (looksLikeDagFinalSummaryTask(task)) {
      summary = task;
      list.splice(i, 1);
      break;
    }
  }

  while (list.length >= maxTasks) {
    list.pop();
  }

  const dependencies = list.map((t) => t.id);
  const defaultDescription =
    '输入：已完成的各模块交付物与 requirements 用户故事；输出：最终回归验证（含关键用户故事端到端检查，可使用浏览器/MCP）、修复残留问题、补齐必要日志/说明；验收：关键构建/健康检查通过，用户故事链路可复现通过。';

  if (!summary) {
    const baseId = `task_${dependencies.length + 1}`;
    const seen = new Set(dependencies);
    let id = baseId;
    let suffix = 2;
    while (seen.has(id)) id = `${baseId}_${suffix++}`;

    summary = {
      id,
      title: '最终修复与调试（收尾）',
      description: defaultDescription,
      dependencies,
      scope: [],
      estimated_complexity: 'Medium',
    };
  } else {
    const title = String(summary?.title || '').trim() || '最终修复与调试（收尾）';
    const description = String(summary?.description || '').trim() || defaultDescription;
    summary = {
      ...summary,
      title,
      description,
      dependencies,
      scope: Array.isArray(summary?.scope) ? summary.scope : [],
      estimated_complexity:
        typeof summary?.estimated_complexity === 'string' && summary.estimated_complexity.trim()
          ? summary.estimated_complexity.trim()
          : 'Medium',
    };
  }

  return [...list, summary];
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
  const dagTasks = parseDagTasksFromTasksContent(markdown);
  if (dagTasks && dagTasks.length) {
    const list = dagTasks.slice();
    const parseIdNumber = (id) => {
      const match = /^task_(\d+)$/.exec(String(id || '').trim());
      if (!match) return null;
      const value = Number.parseInt(match[1], 10);
      return Number.isFinite(value) ? value : null;
    };

    list.sort((a, b) => {
      const left = parseIdNumber(a?.id);
      const right = parseIdNumber(b?.id);
      if (left == null && right == null) return 0;
      if (left == null) return 1;
      if (right == null) return -1;
      return left - right;
    });

    const filtered = list.filter((task) => {
      const id = String(task?.id || '').trim();
      if (id === 'task_0') return false;
      if (looksLikeDagFinalSummaryTask(task)) return false;
      return true;
    });

    const titleById = new Map(
      filtered.map((t) => [String(t?.id || '').trim(), sanitizeModelText(t?.title || '', '').trim()]),
    );

    return filtered.map((task, idx) => {
      const id = String(task?.id || '').trim();
      const titleText = sanitizeModelText(task?.title || '', '').trim();
      const title = id && titleText ? `${id}｜${titleText}` : titleText || id || `Task ${idx + 1}`;

      const description = sanitizeModelText(task?.description || '', '').trim();
      const scope = Array.isArray(task?.scope)
        ? task.scope
            .map((v) => String(v ?? '').trim())
            .filter(Boolean)
            .slice(0, 24)
        : [];
      const complexity =
        typeof task?.estimated_complexity === 'string' ? task.estimated_complexity.trim() : '';

      const dependencies = Array.isArray(task?.dependencies) ? task.dependencies : [];
      const depends = dependencies
        .map((depId) => String(depId ?? '').trim())
        .filter(Boolean)
        .filter((depId) => depId !== 'task_0')
        .slice(0, 24)
        .map((depId) => {
          const depTitle = titleById.get(depId);
          return depTitle ? `${depId}｜${depTitle}` : depId;
        });

      const acMatch = description.match(/验收(?:点|标准)?\s*[：:]\s*([\s\S]+)$/);
      const ac = acMatch ? String(acMatch[1] || '').trim() : '';

      const detailLines = [];
      if (scope.length) detailLines.push(`scope：${scope.join(', ')}`);
      if (complexity) detailLines.push(`复杂度：${complexity}`);

      return {
        title,
        core: description,
        details: detailLines.join('\n'),
        ac,
        depends,
      };
    });
  }

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
    if (!payload || typeof payload !== 'object') {
      const err = new Error(`LLM tasks output not JSON: ${String(content).slice(0, 200)}`);
      err.llmContext = describeLlmConfig(getActiveLlmConfig());
      throw err;
    }
    if (!Array.isArray(payload.tasks)) {
      const err = new Error(`LLM tasks JSON missing tasks[]: ${JSON.stringify(payload).slice(0, 200)}`);
      err.llmContext = describeLlmConfig(getActiveLlmConfig());
      throw err;
    }
    const rawTasks = payload.tasks;
    const normalized = ensureUniqueDagTaskIds(
      rawTasks.map((t, idx) => normalizeDagTaskObject(t, idx)).filter(Boolean),
    );
    if (!normalized.length) {
      const err = new Error(
        `LLM tasks JSON contains no valid tasks: ${JSON.stringify(payload).slice(0, 200)}`,
      );
      err.llmContext = describeLlmConfig(getActiveLlmConfig());
      throw err;
    }

    const maxTotalTasks = Math.min(maxTasks, 25);
    // Reserve slots for task_0 + final summary/debug task.
    const reservedSystemTasks = 2;
    const baseMaxTasks = Math.min(Math.max(1, maxTotalTasks - reservedSystemTasks), 23);
    const trimmed = normalized.slice(0, baseMaxTasks);
    const renumbered = renumberDagTasksToTaskSequence(trimmed, { prefix: 'task_' });
    const idSet = new Set(renumbered.map((t) => t.id));
    const baseTasks = renumbered.map((t) => {
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
    const withTask1Scope = ensureDagTask1InitScope(baseTasks);
    const withTask0 = ensureDagTask0LogsTask(withTask1Scope);
    const finalTasks = ensureDagFinalSummaryTask(withTask0, { maxTasks: maxTotalTasks });

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
      const message = truncateText(error?.message || String(error || ''), 180);
      logAtomize(job, `子任务拆分失败：${message}`);
      throw error;
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
  if (!cleaned) throw new Error('Empty task summary (cannot atomize)');
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
    logAtomize(job, `原子化失败${reason ? `（${reason}）` : ''}`);
    throw error;
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

function buildTasksIterationReasonFromReport(run, userNote = '') {
  const note = sanitizeReviewText(userNote, 1800);
  const ratings = run?.ratings && typeof run.ratings === 'object' ? run.ratings : {};
  const byModel =
    ratings?.byModel && typeof ratings.byModel === 'object' ? ratings.byModel : {};
  const modelIds = LLM_MODEL_OPTIONS.map((m) => String(m?.id || '')).filter(Boolean);

  const blocks = [];
  const hasAnyModelResult = modelIds.some((id) => Boolean(byModel?.[id]?.result));
  if (hasAnyModelResult) {
    blocks.push('多模型评分意见（针对 tasks.md，作为本次任务迭代约束）：');
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
        suggestions.slice(0, 8).forEach((s) => blocks.push(`    - ${s}`));
      }
    });
  }

  const userRatings = Array.isArray(run?.userRatings) ? run.userRatings : [];
  if (userRatings.length) {
    blocks.push('');
    blocks.push('用户评分记录（用于迭代约束）：');
    userRatings.slice(-5).forEach((r) => {
      const score = Number(r?.score);
      const scoreText = Number.isFinite(score) ? String(Math.round(score)) : 'n/a';
      const comment = sanitizeReviewText(String(r?.comment || ''), 220);
      const createdAt = sanitizeReviewText(String(r?.createdAt || ''), 40);
      blocks.push(`- ${createdAt || 'unknown'}：${scoreText}/100${comment ? `｜${comment}` : ''}`);
    });
  }

  if (note) {
    blocks.push('');
    blocks.push('用户补充修改意见：');
    blocks.push(note);
  }

  const joined = blocks.join('\n').trim();
  if (!joined) return '';
  return joined.length > 4200 ? joined.slice(0, 4200) : joined;
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

    try {
      assertValidLlmConfig(getActiveLlmConfig());
    } catch (error) {
      const message = truncateText(error?.message || String(error || ''), 180);
      logAtomize(job, `模型配置不可用${message ? `（${message}）` : ''}`);
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
      throw error;
    }

    const requirementsPath = resolveSpecFile(specName, 'requirements');
    const requirementsContent = fs.existsSync(requirementsPath)
      ? fs.readFileSync(requirementsPath, 'utf8')
      : '';

    const designPath = resolveSpecFile(specName, 'design');
    let designMarkdown = fs.existsSync(designPath)
      ? fs.readFileSync(designPath, 'utf8')
      : '';
    if (!designMarkdown.trim()) throw new Error('design.md 缺失/为空，无法原子化');

    const tasksPath = resolveSpecFile(specName, 'tasks');
    let tasksMarkdown = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : '';
    let originalTasks = parseTasksForAtomize(tasksMarkdown);
    if (!originalTasks.length) throw new Error('tasks.md 为空或格式不合法，无法原子化');

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
      const atomized = await atomizeTaskSummarySafe(
        summaryForModel,
        designSnippet,
        maxRounds,
        timeoutMs,
        job,
        telemetry,
        iterationReason,
      );
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
          const now = new Date().toISOString();
          const nextStatus = readSpecStatus(name);
          recordSpecError(nextStatus, 'requirementsClarifications', error, null);
          nextStatus.requirementsClarifications = {
            ...normalizeRequirementsClarifications(nextStatus.requirementsClarifications || {}),
            questions: [],
            updatedAt: now,
            confirmedAt: nextStatus.requirementsClarifications?.confirmedAt ?? null,
            generatedBy: 'llm',
            generationError: error?.message || 'Clarifications generation failed',
          };
          writeSpecStatus(name, nextStatus);
          onStage?.('requirementsClarifications', 'end');
          throw error;
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
    if (result?.projectCategory) {
      const now = new Date().toISOString();
      const status = readSpecStatus(name);
      const nextStatus = {
        ...status,
        projectCategory: result.projectCategory,
        projectCategoryMeta: { ...result, judgedAt: now, source: 'llm' },
        techStackConfirmed:
          result.projectCategory === 'non_software' ? true : status.techStackConfirmed,
      };
      writeSpecStatus(name, nextStatus);
    }
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

// ========= Test logging (for manual QA/debug) =========
const TEST_LOG_BUFFER_LIMIT = 800;

const testLogBuffers = new Map(); // sessionId -> entry[]

function normalizeTestLogLevel(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'warn' || raw === 'warning') return 'warn';
  if (raw === 'error' || raw === 'fatal') return 'error';
  if (raw === 'debug' || raw === 'trace') return 'debug';
  return 'info';
}

function normalizeTestSessionId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return safe ? safe : null;
}

function sha256Short(text) {
  try {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

function summarizeTextForLog(text) {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 160) return trimmed;
  return { len: trimmed.length, sha256: sha256Short(trimmed) };
}

function summarizeLargeTextForLog(text) {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 2000) return trimmed;
  const head = trimmed.slice(0, 800);
  const tail = trimmed.slice(-800);
  return { len: trimmed.length, sha256: sha256Short(trimmed), head, tail };
}

function summarizeRequestBodyForLog(body) {
  if (!body || typeof body !== 'object') return null;
  const out = {};

  const specId = typeof body.specId === 'string' ? body.specId.trim() : '';
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  const toolId = typeof body.toolId === 'string' ? body.toolId.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';

  if (specId) out.specId = specId;
  if (taskId) out.taskId = taskId;
  if (toolId) out.toolId = toolId;
  if (title) out.title = title.length <= 120 ? title : { len: title.length, sha256: sha256Short(title) };

  if (typeof body.command === 'string') out.command = summarizeTextForLog(body.command);
  if (Array.isArray(body.args)) out.argsCount = body.args.length;
  if (typeof body.cwd === 'string') out.cwd = summarizeTextForLog(body.cwd);
  if (typeof body.input === 'string') out.input = summarizeLargeTextForLog(body.input);
  if (typeof body.prompt === 'string') out.prompt = summarizeLargeTextForLog(body.prompt);
  if (typeof body.tasksContent === 'string') {
    out.tasksContent = summarizeLargeTextForLog(body.tasksContent);
  }

  const keys = Object.keys(body);
  out.keys = keys.length <= 30 ? keys : keys.slice(0, 30).concat([`...+${keys.length - 30}`]);
  return out;
}

function getTestLogFilePath(sessionId) {
  const safe = normalizeTestSessionId(sessionId);
  if (!safe) return null;
  return path.join(TEST_LOG_DIR, `${safe}.jsonl`);
}

function pushTestLogToMemory(entry) {
  const sessionId = String(entry?.sessionId || '').trim();
  if (!sessionId) return;
  const buf = testLogBuffers.get(sessionId) || [];
  buf.push(entry);
  if (buf.length > TEST_LOG_BUFFER_LIMIT) {
    buf.splice(0, buf.length - TEST_LOG_BUFFER_LIMIT);
  }
  testLogBuffers.set(sessionId, buf);
}

function appendTestLogEvent(input, meta) {
  const sessionId =
    normalizeTestSessionId(input?.sessionId) ||
    normalizeTestSessionId(meta?.sessionId) ||
    null;
  if (!sessionId) {
    const error = new Error('sessionId is required');
    error.status = 400;
    throw error;
  }

  const entry = {
    ts: new Date().toISOString(),
    level: normalizeTestLogLevel(input?.level),
    sessionId,
    source: typeof input?.source === 'string' && input.source.trim() ? input.source.trim() : 'dashboard',
    action: typeof input?.action === 'string' && input.action.trim() ? input.action.trim() : 'unknown',
    message: typeof input?.message === 'string' ? input.message : '',
    specId: typeof input?.specId === 'string' && input.specId.trim() ? input.specId.trim() : undefined,
    taskId: typeof input?.taskId === 'string' && input.taskId.trim() ? input.taskId.trim() : undefined,
    data: input?.data && typeof input.data === 'object' ? input.data : undefined,
    meta: meta && typeof meta === 'object' ? meta : undefined,
  };

  pushTestLogToMemory(entry);

  const filePath = getTestLogFilePath(sessionId);
  if (filePath) {
    fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, (err) => {
      if (err) {
        console.error('Failed to append test log:', err.message);
      }
    });
  }

  return entry;
}

function readTestLogTail(sessionId, limit = 200) {
  const safe = normalizeTestSessionId(sessionId);
  if (!safe) return [];
  const max = Math.max(1, Math.min(2000, Number(limit) || 200));

  const buf = testLogBuffers.get(safe);
  if (Array.isArray(buf) && buf.length) {
    return buf.slice(-max);
  }

  const filePath = getTestLogFilePath(safe);
  if (!filePath || !fs.existsSync(filePath)) return [];

  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const size = Number(stat.size || 0);
      const maxBytes = Math.min(1024 * 1024, Math.max(64 * 1024, max * 2048));
      const start = Math.max(0, size - maxBytes);
      const length = Math.max(0, size - start);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      let text = buffer.toString('utf8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
      const lines = text.split('\n').filter(Boolean);
      const sliced = lines.slice(-max);
      const items = [];
      for (const line of sliced) {
        try {
          items.push(JSON.parse(line));
        } catch {
          // ignore bad lines
        }
      }
      return items;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function listTestLogSessions(limit = 200) {
  try {
    if (!fs.existsSync(TEST_LOG_DIR)) return [];
    const entries = fs.readdirSync(TEST_LOG_DIR, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && String(e.name || '').toLowerCase().endsWith('.jsonl'))
      .map((e) => e.name);
    const sessions = [];
    for (const name of files) {
      const id = name.replace(/\.jsonl$/i, '');
      const filePath = path.join(TEST_LOG_DIR, name);
      try {
        const st = fs.statSync(filePath);
        sessions.push({
          sessionId: id,
          sizeBytes: Number(st.size || 0),
          updatedAt: st.mtime ? st.mtime.toISOString() : null,
        });
      } catch {
        // ignore
      }
    }
    sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return sessions.slice(0, Math.max(1, Math.min(2000, Number(limit) || 200)));
  } catch {
    return [];
  }
}

function testLogRequestMiddleware(req, res, next) {
  const rawHeader = req.headers['x-test-session-id'];
  const headerSessionId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const sessionId = normalizeTestSessionId(headerSessionId);
  if (!sessionId) return next();
  req.testSessionId = sessionId;
  if (String(req.path || '').startsWith('/test-logs')) return next();

  const startedAt = Date.now();
  const reqId = nanoid(10);
  res.on('finish', () => {
    try {
      const durationMs = Date.now() - startedAt;
      const status = Number(res.statusCode || 0);
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      const bodySummary = summarizeRequestBodyForLog(req.body);
      appendTestLogEvent(
        {
          sessionId,
          level,
          source: 'bridge',
          action: 'http.request',
          message: `${req.method} ${req.path} -> ${status}`,
          data: {
            reqId,
            method: req.method,
            path: req.path,
            status,
            durationMs,
            query: req.query && typeof req.query === 'object' ? req.query : undefined,
            body: bodySummary,
          },
        },
        {
          sessionId,
          ip: req.ip,
          ua: req.headers['user-agent'] || null,
        },
      );
    } catch (e) {
      console.error('Failed to record http test log:', e?.message || e);
    }
  });
  return next();
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

function handleFileUnlink(absolutePath) {
  const relativePath = path.relative(ROOT_DIR, absolutePath);
  const prevContent = fileSnapshots.get(absolutePath);
  if (prevContent !== undefined) {
    emitDiff(relativePath, prevContent, '');
  }
  fileSnapshots.delete(absolutePath);
  emitEvent('log:append', {
    source: 'watcher',
    message: `[file removed] ${relativePath}`,
  });
}

let ptyProcess = null;

const terminalSessions = new Map();
const TERMINAL_BUFFER_LIMIT = 120;

const AUTO_RESPONDER_DEFAULTS = {
  enabled: false,
  mode: 'prompt', // 'prompt' | 'idle'
  idleMs: 1800,
  cooldownMs: 1800,
  maxActions: 12,
  continueKeyword: '继续',
};

function stripAnsi(input) {
  const text = typeof input === 'string' ? input : '';
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\u0007]*\u0007/g, '');
}

function normalizeAutoResponderOptions(value, fallback) {
  const base = fallback && typeof fallback === 'object' ? fallback : AUTO_RESPONDER_DEFAULTS;
  const obj = value && typeof value === 'object' ? value : null;
  const enabled = obj?.enabled === true;
  const modeRaw = typeof obj?.mode === 'string' ? obj.mode.trim().toLowerCase() : '';
  const mode = modeRaw === 'idle' ? 'idle' : 'prompt';
  const idleMs = Number.isFinite(Number(obj?.idleMs)) ? Math.max(300, Math.floor(Number(obj.idleMs))) : base.idleMs;
  const cooldownMs = Number.isFinite(Number(obj?.cooldownMs))
    ? Math.max(100, Math.floor(Number(obj.cooldownMs)))
    : base.cooldownMs;
  const maxActions = Number.isFinite(Number(obj?.maxActions))
    ? Math.max(1, Math.min(200, Math.floor(Number(obj.maxActions))))
    : base.maxActions;
  const continueKeyword =
    typeof obj?.continueKeyword === 'string' && obj.continueKeyword.trim()
      ? obj.continueKeyword.trim().slice(0, 12)
      : base.continueKeyword;
  return { enabled, mode, idleMs, cooldownMs, maxActions, continueKeyword };
}

function isClaudeBypassTerminal(command, args) {
  const cmd = String(command || '').toLowerCase();
  const argv = Array.isArray(args) ? args.map((v) => String(v || '').toLowerCase()) : [];
  if (!cmd.includes('cmd.exe') && !cmd.includes('powershell') && !cmd.includes('pwsh')) return false;
  if (!argv.includes('claude')) return false;
  return argv.includes('--permission-mode') && argv.includes('bypasspermissions');
}

function captureTerminalSnippet(session, { maxChars = 5000, maxItems = 80 } = {}) {
  const buf = Array.isArray(session?.buffer) ? session.buffer : [];
  const slice = buf.slice(Math.max(0, buf.length - maxItems));
  const raw = slice.map((it) => String(it?.data || '')).join('');
  const cleaned = stripAnsi(raw).replace(/\r/g, '');
  const clipped = cleaned.length > maxChars ? cleaned.slice(-maxChars) : cleaned;
  return {
    len: cleaned.length,
    sha256: sha256Short(cleaned) || sha256Short(raw),
    snippet: clipped,
  };
}

function inferAutoResponderActionFromOutput(text) {
  const out = typeof text === 'string' ? text : '';
  const cleaned = stripAnsi(out);
  const tail = cleaned.slice(-9000);
  const lower = tail.toLowerCase();

  const llmErrorSignals = [
    'llm call failed',
    'unexpected token',
    'not valid json',
    'model_not_found',
    'rate limit',
    '429',
    '502',
    '503',
    '504',
  ];

  const promptSignals = [
    'enter to select',
    'press enter',
    '↑/↓',
    '↑/↓ to navigate',
    'esc to cancel',
    'enter to continue',
    'type something',
    '是否允许',
    '越界修改',
    '输入“继续”',
    '输入\"继续\"',
  ];

  if (llmErrorSignals.some((s) => lower.includes(s))) {
    if (tail.includes('继续') || lower.includes('continue')) {
      return { kind: 'continue', reason: 'llm_error_recovery' };
    }
    // LLM error but no explicit continue hint -> still press enter to proceed/flush prompt.
    return { kind: 'enter', reason: 'llm_error_enter' };
  }

  if (promptSignals.some((s) => tail.includes(s) || lower.includes(String(s).toLowerCase()))) {
    // Prefer continue when prompt explicitly mentions it.
    if (tail.includes('继续') || lower.includes("type 'continue'")) {
      return { kind: 'continue', reason: 'prompt_continue' };
    }
    return { kind: 'enter', reason: 'prompt_enter' };
  }

  return null;
}

function logAutoResponderEvent(session, entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const payload = {
    ts: new Date().toISOString(),
    terminalId: session?.id || null,
    pid: session?.pid || null,
    title: session?.title || null,
    cwd: session?.cwd || null,
    action: e.action || null,
    reason: e.reason || null,
    attempt: typeof e.attempt === 'number' ? e.attempt : e.attempt === 0 ? 0 : e.attempt || null,
    snippet: e.snippet || null,
  };

  if (session && Array.isArray(session.autoEvents)) {
    session.autoEvents.push(payload);
    if (session.autoEvents.length > 80) {
      session.autoEvents.splice(0, session.autoEvents.length - 80);
    }
  }

  emitEvent('log:append', {
    source: 'auto-responder',
    message: `[auto] terminal=${payload.terminalId} action=${payload.action} reason=${payload.reason} attempt=${payload.attempt}`,
  });

  const testSessionId = normalizeTestSessionId(session?.testSessionId);
  if (testSessionId) {
    try {
      appendTestLogEvent(
        {
          sessionId: testSessionId,
          level: 'info',
          source: 'bridge',
          action: 'terminal.auto_input',
          message: 'auto terminal input',
          data: payload,
        },
        {
          sessionId: testSessionId,
        },
      );
    } catch (error) {
      emitEvent('log:append', {
        source: 'auto-responder',
        message: `[auto] failed to write test log: ${error?.message || String(error)}`,
      });
    }
  }
}

function disposeAutoResponder(session) {
  if (!session) return;
  if (session.autoResponderTimer) {
    try {
      clearInterval(session.autoResponderTimer);
    } catch {
      // ignore
    }
    session.autoResponderTimer = null;
  }
}

function tickAutoResponder(session) {
  if (!session?.autoResponder?.enabled) return;
  if (!session.running) return;
  if (session.paused) return;

  const now = Date.now();
  const lastOutputAt = Number(session.lastOutputAt || 0);
  if (lastOutputAt && now - lastOutputAt < session.autoResponder.idleMs) return;

  const lastActionAt = Number(session.autoResponder.lastActionAt || 0);
  if (lastActionAt && now - lastActionAt < session.autoResponder.cooldownMs) return;

  const attempts = Number(session.autoResponder.attempts || 0);
  if (attempts >= session.autoResponder.maxActions) {
    session.autoResponder.enabled = false;
    const snippet = captureTerminalSnippet(session, { maxChars: 5000 });
    logAutoResponderEvent(session, {
      action: 'stop',
      reason: 'max_actions_reached',
      attempt: attempts,
      snippet,
    });
    return;
  }

  const lastHandledSeq = Number(session.autoResponder.lastHandledSeq || 0);
  const latestSeq = Number(session.seq || 0);
  if (attempts > 0 && latestSeq <= lastHandledSeq) return;

  const buf = Array.isArray(session.buffer) ? session.buffer : [];
  const sinceText = buf
    .filter((it) => Number(it?.seq || 0) > lastHandledSeq)
    .map((it) => String(it?.data || ''))
    .join('');
  const decision = inferAutoResponderActionFromOutput(sinceText);

  if (!decision && session.autoResponder.mode !== 'idle') return;

  const snippet = captureTerminalSnippet(session, { maxChars: 9000 });
  const action = decision?.kind || 'enter';
  const reason = decision?.reason || 'idle_timeout';
  const input = action === 'continue' ? `${session.autoResponder.continueKeyword}\r` : '\r';

  try {
    writeTerminalInput(session, input);
  } catch (error) {
    logAutoResponderEvent(session, {
      action: 'error',
      reason: `write_failed:${error?.message || String(error)}`,
      attempt: attempts + 1,
      snippet,
    });
    session.autoResponder.enabled = false;
    return;
  }

  session.autoResponder.attempts = attempts + 1;
  session.autoResponder.lastActionAt = now;
  session.autoResponder.lastHandledSeq = latestSeq;
  logAutoResponderEvent(session, {
    action,
    reason,
    attempt: attempts + 1,
    snippet,
  });
}

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
  const planADir =
    process.platform === 'win32'
      ? (() => {
          try {
            const resolved = path.resolve('C:\\planA');
            fs.mkdirSync(resolved, { recursive: true });
            return resolveExistingDirectory(resolved);
          } catch {
            return null;
          }
        })()
      : null;
  const candidates = [
    resolveExistingDirectory(cfg?.defaultCwd),
    resolveExistingDirectory(process.env.WORKFLOW_DEFAULT_CWD || ''),
    planADir,
    resolveExistingDirectory(REPO_DIR),
    resolveExistingDirectory(DEFAULT_TESTCLI_DIR),
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
    paused: t.paused === true,
    pausedAt: t.pausedAt || null,
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
  const testSessionId = normalizeTestSessionId(options?.testSessionId);

  const explicitAutoResponder = options?.autoResponder && typeof options.autoResponder === 'object'
    ? normalizeAutoResponderOptions(options.autoResponder, AUTO_RESPONDER_DEFAULTS)
    : null;
  const inferredAutoResponderEnabled = isClaudeBypassTerminal(command, args) || options?.autoContinue === true;
  const autoResponder = explicitAutoResponder || { ...AUTO_RESPONDER_DEFAULTS, enabled: inferredAutoResponderEnabled };

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
    testSessionId,
    running: true,
    paused: false,
    pausedAt: null,
    pausedPids: null,
    createdAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
    seq: 0,
    buffer: [],
    lastOutputAt: Date.now(),
    autoResponder: {
      ...autoResponder,
      attempts: 0,
      lastActionAt: 0,
      lastHandledSeq: 0,
    },
    autoResponderTimer: null,
    autoEvents: [],
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
      paused: session.paused === true,
      pausedAt: session.pausedAt || null,
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
    session.lastOutputAt = Date.now();
    io.emit('terminal:data', { terminalId: id, seq: item.seq, data });
  });

  proc.onExit(({ exitCode }) => {
    session.running = false;
    session.paused = false;
    session.pausedAt = null;
    session.pausedPids = null;
    session.exitedAt = new Date().toISOString();
    session.exitCode = typeof exitCode === 'number' ? exitCode : null;
    disposeAutoResponder(session);
    io.emit('terminal:exit', {
      terminalId: id,
      exitCode: session.exitCode ?? -1,
    });
  });

  if (session.autoResponder?.enabled) {
    session.autoResponderTimer = setInterval(() => tickAutoResponder(session), 450);
    logAutoResponderEvent(session, {
      action: 'start',
      reason: 'enabled',
      attempt: 0,
      snippet: captureTerminalSnippet(session, { maxChars: 1200 }),
    });
  }

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
  if (session?.autoResponder?.enabled) {
    session.autoResponder.enabled = false;
  }
  disposeAutoResponder(session);
  if (!session?.proc) return;
  try {
    session.proc.kill();
  } catch {
    // ignore
  }
}

function pauseTerminalSession(session) {
  if (!session) {
    const error = new Error('Terminal not found');
    error.status = 404;
    throw error;
  }
  if (!session.proc || !session.running) {
    const error = new Error('Terminal is not running');
    error.status = 409;
    throw error;
  }
  if (session.paused) return session;

  const pid = Number(session.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    const error = new Error('Terminal pid is invalid');
    error.status = 500;
    throw error;
  }

  try {
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      const script = [
        "$ErrorActionPreference='Stop'",
        'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class ProcessSuspendResume { [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr processHandle); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr processHandle); }\' -ErrorAction Stop',
        'function Suspend-Pid([int]$TargetPid) { $p = [System.Diagnostics.Process]::GetProcessById($TargetPid); [ProcessSuspendResume]::NtSuspendProcess($p.Handle) | Out-Null }',
        'function Resume-Pid([int]$TargetPid) { $p = [System.Diagnostics.Process]::GetProcessById($TargetPid); [ProcessSuspendResume]::NtResumeProcess($p.Handle) | Out-Null }',
        'function Get-Descendants([int]$RootPid, $ChildrenByParent) {',
        '  $queue = New-Object System.Collections.Generic.Queue[int]',
        '  $seen = New-Object System.Collections.Generic.HashSet[int]',
        '  $result = New-Object System.Collections.Generic.List[int]',
        '  $queue.Enqueue($RootPid) | Out-Null',
        '  $seen.Add($RootPid) | Out-Null',
        '  while ($queue.Count -gt 0) {',
        '    $cur = $queue.Dequeue()',
        '    $key = [string]$cur',
        '    if ($ChildrenByParent.ContainsKey($key)) {',
        '      foreach ($child in $ChildrenByParent[$key]) {',
        '        $cid = [int]$child',
        '        if ($seen.Add($cid)) {',
        '          $result.Add($cid) | Out-Null',
        '          $queue.Enqueue($cid) | Out-Null',
        '        }',
        '      }',
        '    }',
        '  }',
        '  return $result',
        '}',
        '$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId',
        '$map = @{}',
        'foreach ($p in $procs) {',
        '  $ppid = [string]([int]$p.ParentProcessId)',
        '  if (-not $map.ContainsKey($ppid)) { $map[$ppid] = @() }',
        '  $map[$ppid] += [int]$p.ProcessId',
        '}',
        `$root = ${pid}`,
        '$desc = @(Get-Descendants -RootPid $root -ChildrenByParent $map)',
        '$pids = @($desc + $root) | Sort-Object -Unique',
        '$toSuspend = $pids | Sort-Object -Descending',
        '$paused = @()',
        'try {',
        '  foreach ($p in $toSuspend) {',
        '    Suspend-Pid -TargetPid ([int]$p)',
        '    $paused += $p',
        '  }',
        '} catch {',
        '  foreach ($p in ($paused | Sort-Object)) {',
        "    try { Resume-Pid -TargetPid ([int]$p) } catch { }",
        '  }',
        '  throw',
        '}',
        '$pids | ConvertTo-Json -Compress',
      ].join(';');

      const stdout = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { encoding: 'utf8' },
      );
      const text = String(stdout || '').trim();
      const parsed = text ? JSON.parse(text) : null;
      const pausedPids = Array.isArray(parsed)
        ? Array.from(new Set(parsed.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)))
        : [];
      if (!pausedPids.length) throw new Error('Pause returned empty pid list');
      session.pausedPids = pausedPids;
      emitEvent('log:append', {
        source: 'terminal',
        message: `[terminal] paused ${session.id} pid=${pid} pids=${pausedPids.join(',')}`,
      });
    } else {
      try {
        process.kill(-pid, 'SIGSTOP');
      } catch {
        process.kill(pid, 'SIGSTOP');
      }
    }
  } catch (e) {
    const error = new Error(`Failed to pause terminal: ${e?.message || e}`);    
    error.status = 500;
    throw error;
  }

  session.paused = true;
  session.pausedAt = new Date().toISOString();
  io.emit('terminal:paused', { terminalId: session.id, pid: session.pid });
  return session;
}

function resumeTerminalSession(session) {
  if (!session) {
    const error = new Error('Terminal not found');
    error.status = 404;
    throw error;
  }
  if (!session.proc || !session.running) {
    const error = new Error('Terminal is not running');
    error.status = 409;
    throw error;
  }
  if (!session.paused) return session;

  const pid = Number(session.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    const error = new Error('Terminal pid is invalid');
    error.status = 500;
    throw error;
  }

  try {
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      const pausedPids =
        Array.isArray(session.pausedPids) && session.pausedPids.length
          ? session.pausedPids.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
          : [pid];
      const pidsJson = JSON.stringify(Array.from(new Set(pausedPids)));
      const script = [
        "$ErrorActionPreference='Stop'",
        'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class ProcessSuspendResume { [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr processHandle); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr processHandle); }\' -ErrorAction Stop',
        'function Resume-Pid([int]$TargetPid) { $p = [System.Diagnostics.Process]::GetProcessById($TargetPid); [ProcessSuspendResume]::NtResumeProcess($p.Handle) | Out-Null }',
        `$pids = '${pidsJson}' | ConvertFrom-Json`,
        '$toResume = $pids | Sort-Object -Descending',
        'foreach ($p in $toResume) {',
          '  try {',
        '    Resume-Pid -TargetPid ([int]$p)',
          '  } catch {',
        "    if ($_.Exception.Message -match 'Process.*not found' -or $_.Exception.Message -match 'cannot find' -or $_.Exception.Message -match 'cannot find a process') { continue }",
          '    throw',
          '  }',
        '}',
      ].join(';');
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { stdio: 'ignore' },
      );
    } else {
      try {
        process.kill(-pid, 'SIGCONT');
      } catch {
        process.kill(pid, 'SIGCONT');
      }
    }
  } catch (e) {
    const error = new Error(`Failed to resume terminal: ${e?.message || e}`);   
    error.status = 500;
    throw error;
  }

  session.paused = false;
  session.pausedAt = null;
  session.pausedPids = null;
  io.emit('terminal:resumed', { terminalId: session.id, pid: session.pid });    
  return session;
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


// ========== Routes (split modules) ==========
const { registerCoreRoutes } = require('./routes/core.routes');
const { registerMvp5Routes } = require('./routes/mvp5.routes');

function writeCliInput(input) {
  if (ptyProcess && typeof input === 'string') {
    ptyProcess.write(input);
  }
}

const routesContext = {
  PORT,
  ROOT_DIR,
  REPO_DIR,
  DOCS_DIR,
  LOGS_DIR,
  TEST_LOG_DIR,
  SPEC_ROOT,
  SPEC_ARTIFACTS,
  LLM_PROVIDERS,
  LLM_MODEL_OPTIONS,
  LLM_MODEL_ALIASES,
  LLM_CONFIG_FILE,
  state,
  atomizeJobs,
  reportScoreJobs,
  tasksIterateJobs,
  analysisResults,
  executionPlans,
  executionStates,
  mvp5ExecutionRunners,
  fileSnapshots,
  appendEvent,
  appendTestLogEvent,
  getTestLogFilePath,
  listTestLogSessions,
  normalizeTestSessionId,
  readTestLogTail,
  appendFlowRunStageAttempt,
  appendFlowRunStageAttemptToRun,
  applyEventToState,
  applyPromptTemplate,
  applyTechStackOptionMeta,
  areClarificationsComplete,
  assertValidLlmConfig,
  atomizeSummaryParts,
  atomizeTaskSummary,
  atomizeTaskSummarySafe,
  buildAtomicSection,
  buildAtomizeIterationReasonFromReport,
  buildClarificationsSummary,
  buildDefaultClarificationQuestions,
  buildDefaultRequirementsClarificationQuestions,
  buildDefaultTechStackQuestions,
  buildDesignMarkdown,
  buildFallbackAtomicTasks,
  buildFlowReportFileName,
  buildFlowReportMarkdown,
  buildRepoTreeSnapshot,
  buildRequirementsClarificationsMarkdown,
  buildRequirementsMarkdown,
  buildReviewSummary,
  buildTasksAtomicHeader,
  buildTasksDagMarkdown,
  buildTasksIterationReasonFromReport,
  buildTasksMarkdown,
  buildTechStackSummary,
  callLlm,
  callLlmStream,
  cloneJson,
  coerceAtomicTasks,
  containsAtomicPlaceholder,
  createFlowRun,
  createNdjsonStream,
  createSpecTemplates,
  createTerminalSession,
  terminalSessions,
  describeLlmConfig,
  detectDagScopeConflicts,
  emitDiff,
  emitEvent,
  enrichTechStackQuestions,
  ensureActiveFlowRun,
  ensureAtomicFile,
  ensureFlowRunArtifactsSnapshot,
  ensureRequirementsClarificationsSeeded,
  ensureRequirementsReviewSeeded,
  ensureSpecStatus,
  ensureSpecTemplate,
  ensureTechStackClarificationsSeeded,
  ensureUniqueDagTaskIds,
  extractAcceptanceFromText,
  extractArtifactsFromFlowReportMarkdown,
  extractBulletsFromSection,
  extractOriginalRequirement,
  extractPromptExcerpt,
  extractRequirementsReviewPoints,
  extractTasksJsonBlockFromMarkdown,
  filterAcceptanceLines,
  finalizeFlowReport,
  formatAtomicTaskBlock,
  formatDurationMs,
  formatOriginalTaskForAtomize,
  formatTimestamp,
  generateClarificationsWithModel,
  generateDesignContent,
  generateDesignWithModel,
  generateRequirementsContent,
  generateRequirementsWithModel,
  generateSpecName,
  generateTasksContent,
  generateTasksWithModel,
  generateTasksWithModelAtomicLegacy,
  getActiveLlmConfig,
  getAtomizeStatus,
  getDefaultWorkspaceCwd,
  getLlmConfigForModel,
  getLlmRetryDelayMs,
  getLlmRetryLimit,
  getModelLabel,
  getProviderEnv,
  getProviderForModel,
  getReportScoreJob,
  getReportScoreStatus,
  getRepoTreeSnapshotForPrompt,
  getTasksIterateJob,
  getTasksIterateStatus,
  getTerminalSession,
  handleFileChange,
  handleFileUnlink,
  hasLlmConfig,
  inferProjectCategoryFromModel,
  inferProjectCategoryFromPrompt,
  isNdjsonStreamRequest,
  isNonSoftwareProject,
  isQuestionAnswered,
  isRetryableLlmError,
  isSupportedModel,
  isTextFile,
  killTerminal,
  listFlowRuns,
  listSpecs,
  listTerminalSessions,
  loadCliToolsConfig,
  loadLocalEnv,
  loadPersistedLlmConfig,
  loadPromptConfig,
  loadPromptDefaults,
  loadPromptDefaultsRaw,
  loadPromptPresets,
  logAtomize,
  logReportScore,
  logTasksIterate,
  looksLikeChinese,
  mergeRequirementsClarifications,
  mergeRequirementsReview,
  migratePromptConfig,
  nanoid,
  normalizeAtomizeBatchSize,
  normalizeClarificationAnswer,
  normalizeClarificationOption,
  normalizeClarificationQuestion,
  normalizeCliToolApiKey,
  normalizeCliToolArgs,
  normalizeCliToolBaseUrl,
  normalizeCliToolEnv,
  normalizeCliToolId,
  normalizeCliToolInput,
  normalizeDagTaskId,
  normalizeDagTaskObject,
  normalizeEstimatedComplexity,
  normalizeFlowReportMeta,
  normalizeFlowRunArtifactsSnapshot,
  normalizeLineEndings,
  normalizeLines,
  normalizeLlmUsage,
  normalizePathForPrompt,
  normalizePresetName,
  normalizeProjectCategoryPayload,
  normalizeProjectCategoryValue,
  normalizePrompt,
  normalizePromptConfig,
  normalizeReportScorePayload,
  normalizeRequirementsClarifications,
  normalizeRequirementsReview,
  normalizeReviewPoint,
  normalizeScopePathForConflict,
  normalizeStringList,
  normalizeTaskObject,
  normalizeTerminalArgs,
  normalizeTerminalCommand,
  normalizeTerminalCwd,
  normalizeTerminalEnv,
  normalizeTerminalSize,
  normalizeTerminalTitle,
  parseAtomicDoneIndices,
  parseDagTasksFromTasksContent,
  parseTasksAtomicMarkdown,
  parseTasksForAtomize,
  parseTaskSummaries,
  pauseProcessIfNeeded,
  persistCliToolsConfig,
  persistLlmConfig,
  persistPromptConfig,
  persistPromptPresets,
  readFlowRun,
  readSpecArtifacts,
  readSpecStatus,
  readWorkspaceConfig,
  recordSpecError,
  refreshFlowReport,
  renderClarificationQuestions,
  renderStageAttempts,
  renumberDagTasksToTaskSequence,
  ensureDagTask0LogsTask,
  reportScoreJobKey,
  requestAtomicTasks,
  resetAtomicFile,
  resizeTerminal,
  pauseTerminalSession,
  resumeTerminalSession,
  resolveDesignPrompt,
  resolveExistingDirectory,
  resolveFlowRunDir,
  resolveFlowRunFile,
  resolveProjectCategory,
  resolveSpecDir,
  resolveSpecFile,
  resolveSpecStatusFile,
  resumeProcessIfNeeded,
  runAtomizeJob,
  runReportScoreJob,
  runTasksIterateJob,
  sanitizeAtomicField,
  sanitizeAtomicTaskId,
  sanitizeEnvVarName,
  sanitizeFilenamePart,
  sanitizeModelText,
  sanitizeOptionDesc,
  sanitizeOptionLabel,
  sanitizeReviewText,
  sanitizeRunId,
  sanitizeSpecName,
  sanitizeWikiUrl,
  scopesMayConflict,
  scoreFlowReportWithModel,
  setLlmModel,
  shouldExcludeRepoTreeEntry,
  shouldSplitFurther,
  slugifyPrompt,
  splitSummaryForAtomize,
  startPty,
  startReportScoreJob,
  startTasksIterateJob,
  stripTechStackKeepOptions,
  summarizeForTemplate,
  sumUsage,
  tasksIterateJobKey,
  toPublicCliTool,
  truncateForPrompt,
  truncateText,
  truncateTextMiddle,
  tryParseJson,
  upsertRequirementsClarificationsSection,
  validateAtomicTasks,
  writeFlowRun,
  writeSpecFile,
  writeSpecStatus,
  writeTerminalInput,
  writeWorkspaceConfig,
  writeCliInput,
};

registerCoreRoutes(app, routesContext);
registerMvp5Routes(app, routesContext);

function registerDashboardStatic(appInstance) {
  const indexFile = path.join(DASHBOARD_DIST_DIR, 'index.html');
  if (!fs.existsSync(indexFile)) return;

  appInstance.use(express.static(DASHBOARD_DIST_DIR, { index: false }));
  appInstance.get('*', (req, res, next) => {
    if (req.method !== 'GET') return next();
    const accept = String(req.headers?.accept || '');
    if (!accept.includes('text/html')) return next();
    if (/^\/(api|socket\.io|terminals|llm|prompts|workspace|fs|test-logs)\b/i.test(req.path)) {
      return next();
    }
    return res.sendFile(indexFile);
  });
}

registerDashboardStatic(app);
// ========== Routes end ==========

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

module.exports = {
  PORT,
  ROOT_DIR,
  WATCH_DIRS,
  app,
  server,
  io,
  state,
  emitEvent,
  handleFileChange,
  handleFileUnlink,
  listTerminalSessions,
  getTerminalSession,
  writeTerminalInput,
  resizeTerminal,
  killTerminal,
  startPty,
};
