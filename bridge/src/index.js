const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const chokidar = require('chokidar');
const { createTwoFilesPatch } = require('diff');
const pty = require('node-pty');

function nanoid(size = 21) {
  return crypto.randomBytes(size).toString('base64url').slice(0, size);
}

const PORT = process.env.WORKFLOW_BRIDGE_PORT || 4100;
const DATA_DIR = path.join(__dirname, '..', 'data');
const EVENT_LOG = path.join(DATA_DIR, 'events.jsonl');
const LLM_CONFIG_FILE = path.join(DATA_DIR, 'llm-config.json');
const PROMPT_CONFIG_FILE = path.join(DATA_DIR, 'prompt-config.json');
const PROMPT_PRESETS_FILE = path.join(DATA_DIR, 'prompt-presets.json');
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');
const REPO_DIR = path.resolve(__dirname, '..', '..');
const DOCS_DIR = path.join(REPO_DIR, 'docs');
const WATCH_DIRS =
  process.env.WORKFLOW_WATCH_DIRS || '.codex,task,workflow';
const MAX_DIFF_CHARS = 8000;
const SPEC_ROOT = path.join(ROOT_DIR, 'workflow', 'specs');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SPEC_ROOT, { recursive: true });

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
const SPEC_ARTIFACTS = ['requirements', 'design', 'tasks', 'tasks_atomic'];
const SPEC_TEMPLATES = {
  requirements: `# 需求（requirements）\n\n## 背景\n\n## 用户故事\n\n## 验收标准（EARS）\n- 当[条件/事件]时，系统应[期望行为]。\n`,
  design: `# 设计（design）\n\n## 架构概览\n\n## 关键流程/时序\n\n## 实现考虑\n`,
  tasks: `# 任务（tasks）\n\n## AI IDE 使用说明\n- 本文件是“规范驱动开发”的任务总览与回写入口（范围约束 / 验收记录）。\n- AI IDE 开发时优先按 tasks_atomic.md 逐条执行；完成情况与关键变更回写到 tasks.md，保持任务与代码同步。\n- 如发现遗漏或范围变化：先更新 tasks.md，再重新生成 tasks_atomic.md 后继续。\n\n## 任务清单\n\n- [ ] 1. \n- [ ] 2. \n- [ ] 3. \n`,
  tasks_atomic: `# 任务原子化（tasks_atomic）\n\n## 使用说明\n- 本文件由 tasks.md 原子化拆解生成，作为 AI IDE 开发的首选执行清单（逐条勾选、逐条验收）。\n- 原子化过程会按条追加写入，若中断可再次“开始原子化”继续。\n\n## 原子任务清单\n\n- [ ] 1. \n- [ ] 2. \n- [ ] 3. \n`,
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
  'requirements',
  'requirementsClarifications',
  'design',
  'tasks',
  'atomize',
  'reportScore',
];

const DEFAULT_PROMPT_CONFIG = {
  version: 3,
  stages: {
    projectCategory: {
      label: '项目类型识别',
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
      variables: ['prompt'],
      system:
        '你是产品需求助手。只输出 JSON，不要解释，不要包含分析或思考过程。',
      user:
        `需求描述：{{prompt}}\n\n` +
        '请只输出 JSON，必须包含字段：background（字符串）, user_stories（字符串数组）, acceptance（字符串数组）。\n' +
        '要求：所有内容必须为简体中文；acceptance 每条为“当...时，系统应...”风格的可验证语句。\n' +
        '不要输出除 JSON 以外的任何内容。',
    },
    requirementsClarifications: {
      label: '需求确认问题生成',
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
      variables: ['requirements', 'prompt'],
      system:
        '你是软件设计助手。只输出 JSON，不要解释，不要包含分析或思考过程。',
      user:
        `需求内容如下：\n{{requirements}}\n\n补充描述：{{prompt}}\n\n` +
        '请只输出 JSON，字段：overview（字符串）, flows（字符串数组）, considerations（字符串数组）。不要输出除 JSON 以外的任何内容。',
    },
	    tasks: {
	      label: '任务生成',
	      variables: ['design', 'prompt', 'minTasks', 'maxTasks'],
	      system:
	        '你是项目任务拆解助手。你的输出将作为后续“任务原子化”的输入，并会交付给 AI IDE 执行。只输出 JSON，不要解释。',
	      user:
	        `设计内容如下：\n{{design}}\n\n补充描述：{{prompt}}\n\n` +
	        '请输出 {{minTasks}}-{{maxTasks}} 条任务（不要求原子化）。' +
	        '每条任务必须包含 title/core/details/ac 四个字段，简体中文。\n' +
	        'title 写清任务名称与产出（模块/流程级别即可）。\n' +
	        'core 写清关键目标与范围边界（做什么/不做什么）。\n' +
	        'details 写清关键技术点/接口/数据结构/页面与路由，不要空泛。\n' +
	        'ac 必须可验证：写清验证步骤（命令/接口/页面路径/可观察结果）。\n' +
	        '请严格输出 JSON：{"tasks":[{title,core,details,ac}]}。',
	    },
	    atomize: {
	      label: '任务原子化',
	      variables: ['context', 'main', 'reasonBlock'],
	      system:
	        'Role: 硬核工程架构师 (Hardcore Engineering Lead)。你擅长把任务拆解为“原子级执行指令”。只输出 JSON。',
	      user:
	        `{{context}}{{main}}\n\n{{reasonBlock}}` +
	        '要求：\n' +
	        '1) 输出为原子级任务，不要摘要，拆到无法再拆；单条任务建议 5-10 分钟内可完成。\n' +
	        '2) 任务对象字段：title/core/details/ac。\n' +
	        '3) title 必须以“创建/修改/删除 <相对文件路径>”开头，且 <相对文件路径> 必须是动作后的第一个 token（后续说明用“｜”追加）。\n' +
	        '   - 文件路径必须包含扩展名（.ts/.tsx/.js/.md/.css/.json 等），且必须为最终可用路径。\n' +
	        '   - 绝对禁止使用 TBD/待定/[path]/占位符。\n' +
	        '   - 若 {{context}} 中包含“项目结构/文件树”，路径必须优先从中选择；若需新建文件，也必须落在合理目录并与现有结构一致。\n' +
	        '4) 一条任务只允许涉及 1 个文件；若需要改多个文件，拆成多条。\n' +
	        '5) core/details 必须具体可执行，包含关键导出名/函数名/接口字段/API 路由/组件 Props/CSS 类名；避免空泛措辞。\n' +
	        '6) 遵循定义先行：先 types/interfaces/schema/DTO，再业务逻辑，再 UI/交互。\n' +
	        '7) ac 必须“机器可验证”，至少包含 1 条可执行的验证方式（命令/接口/页面路径/可观察结果）。\n' +
	        '8) 信息不足时：先补 1 条“创建 docs/assumptions.md”记录假设/待确认点（写清缺失信息），再继续拆分。\n' +
	        '9) 简体中文。\n' +
	        '只输出 JSON：{"tasks":[...]}。',
	    },
    reportScore: {
      label: '流程报告评分',
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
    stages,
  };
}

function migratePromptConfig(normalized) {
  const defaults = cloneJson(DEFAULT_PROMPT_CONFIG);
  const current = normalized && typeof normalized === 'object' ? normalized : normalizePromptConfig({});
  const next = cloneJson(current);
  let changed = false;

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

function loadPromptConfig() {
  if (!fs.existsSync(PROMPT_CONFIG_FILE)) return normalizePromptConfig({});
  try {
    const raw = JSON.parse(fs.readFileSync(PROMPT_CONFIG_FILE, 'utf8'));
    const normalized = normalizePromptConfig(raw);
    const migrated = migratePromptConfig(normalized);
    if (migrated.changed) {
      try {
        persistPromptConfig(migrated.config);
      } catch {
        // ignore migration write failures
      }
      return normalizePromptConfig(migrated.config);
    }
    return normalized;
  } catch {
    return normalizePromptConfig({});
  }
}

function persistPromptConfig(nextConfig) {
  const normalized = normalizePromptConfig(nextConfig);
  const persisted = { ...normalized, updatedAt: new Date().toISOString() };
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
  const tasksAtomic = artifacts?.tasks_atomic || '';

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
    status?.prompt ? status.prompt : '（空）',
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
    '### tasks_atomic.md',
    '',
    '```markdown',
    tasksAtomic,
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

function finalizeFlowReport(specName, options = {}) {
  const status = readSpecStatus(specName);
  const flowReport = normalizeFlowReportMeta(status.flowReport);
  const runId = String(options?.runId || flowReport.activeRunId || '').trim();
  if (!runId) return null;

  const run = readFlowRun(specName, runId);
  if (!run) return null;

  if (run.report && typeof run.report === 'object' && run.report.path) {
    return run.report.path;
  }

  const artifacts = {};
  for (const key of SPEC_ARTIFACTS) {
    const filePath = resolveSpecFile(specName, key);
    artifacts[key] = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  }

  const markdown = buildFlowReportMarkdown(specName, status, run, artifacts);

  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const fileName = buildFlowReportFileName(specName, status?.prompt || run?.prompt || '', runId);
  const reportPath = path.join(DOCS_DIR, fileName);
  fs.writeFileSync(reportPath, markdown, 'utf8');

  const now = new Date().toISOString();
  const updatedRun = {
    ...run,
    updatedAt: now,
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

  const artifacts = {};
  for (const key of SPEC_ARTIFACTS) {
    const filePath = resolveSpecFile(specName, key);
    artifacts[key] = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  }

  const markdown = buildFlowReportMarkdown(specName, status, run, artifacts);

  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const fileName = buildFlowReportFileName(specName, status?.prompt || run?.prompt || '', id);
  const reportPath =
    run.report && typeof run.report === 'object' && typeof run.report.path === 'string' && run.report.path.trim()
      ? run.report.path
      : path.join(DOCS_DIR, fileName);
  fs.writeFileSync(reportPath, markdown, 'utf8');

  const now = new Date().toISOString();
  const updatedRun = {
    ...run,
    updatedAt: now,
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
    tasksAtomic: truncateTextMiddle(artifacts?.tasks_atomic || '', 20000),
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

    const artifacts = {};
    for (const key of SPEC_ARTIFACTS) {
      const filePath = resolveSpecFile(specName, key);
      artifacts[key] = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    }

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
        status,
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

function ensureRequirementsClarificationsSeeded(specName, status, prompt) {
  const normalized = { ...DEFAULT_SPEC_STATUS, ...status };
  const current = normalizeRequirementsClarifications(
    normalized.requirementsClarifications || {},
  );
  if (normalized.requirementsConfirmed) return { changed: false, status: normalized };
  if (current.questions.length > 0) return { changed: false, status: normalized };
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
    normalizePrompt(prompt) ||
      extractOriginalRequirement(design) ||
      normalizePrompt(design),
  );
  if (!summary) {
    return SPEC_TEMPLATES.tasks;
  }
  return `# 任务（tasks）\n\n## AI IDE 使用说明\n- 本文件是“规范驱动开发”的任务总览与回写入口（范围约束 / 验收记录）。\n- AI IDE 开发时优先按 tasks_atomic.md（原子化任务表单）逐条执行；完成情况与关键变更回写到 tasks.md，保持任务与代码同步。\n- 如发现遗漏或范围变化：先更新 tasks.md，再重新生成 tasks_atomic.md 后继续。\n\n## 任务清单\n- [ ] 1. 梳理“${summary}”的模块清单与页面/服务边界。\n- [ ] 2. 明确最小可运行结构（入口、路由/页面、核心依赖）。\n- [ ] 3. 拆分关键流程并标注对应代码落点。\n- [ ] 4. 明确数据结构/接口草案（字段、命名、约束）。\n- [ ] 5. 记录需要的环境变量/配置项。\n- [ ] 6. 列出需要补齐的边界与异常场景。\n`;
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
  const guide = `## AI IDE 使用说明\n- 本文件是“规范驱动开发”的任务总览与回写入口（范围约束 / 验收记录）。\n- AI IDE 开发时优先按 tasks_atomic.md（原子化任务表单）逐条执行；完成情况与关键变更回写到 tasks.md，保持任务与代码同步。\n- 如发现遗漏或范围变化：先更新 tasks.md，再重新生成 tasks_atomic.md 后继续。\n\n## 任务清单`;

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
    },
    {
      title: `创建 docs/project_skeleton.md｜验证：启动并能访问页面`,
      core: `梳理与“${fallbackSummary}”相关的最小可运行骨架。`,
      details: '包含基本路由/页面/启动脚本。',
      ac: '本地能启动并访问关键页面（以项目实际端口/路由为准）。',
    },
  ];

  const list = tasks.length ? tasks : fallbackList;

  const blocks = list
    .map((t, idx) => {
      const title = sanitizeModelText(t.title || t.task || t.name || '', '').trim();
      const core = sanitizeModelText(t.core || t.logic || t.coreLogic || '', '').trim();
      const details = sanitizeModelText(t.details || t.tech || t.technical || t.techDetails || '', '').trim();
      const ac = sanitizeModelText(t.ac || t.acceptance || t.criteria || '', '').trim();

      return [
        `- [ ] **Task ${idx + 1}**: ${title || 'TBD'}`,
        `  - **核心逻辑**: ${core || 'TBD'}`,
        `  - **技术细节**: ${details || 'TBD'}`,
        `  - **验收准则 (AC)**: ${ac || 'TBD'}`,
      ].join('\n');
    })
    .join('\n\n');

  return `# 任务（tasks）\n\n${guide}\n\n${blocks}\n`;
}

async function generateRequirementsWithModel(prompt, options = {}) {
  assertValidLlmConfig(getActiveLlmConfig());

  const promptConfig = loadPromptConfig();
  const stage = promptConfig.stages.requirements;
  const onToken = typeof options?.onToken === 'function' ? options.onToken : null;
  const onTelemetry = typeof options?.onTelemetry === 'function' ? options.onTelemetry : null;

  const stageKey = 'requirements';
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
  return { title, core, details, ac };
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

function formatAtomicTaskBlock(indexLabel, task) {
  const title = sanitizeModelText(task.title || task.task || task.name || '', 'TBD').trim();
  const core = sanitizeModelText(task.core || task.logic || '', 'TBD').trim();
  const details = sanitizeModelText(task.details || task.tech || '', 'TBD').trim();
  const ac = sanitizeModelText(task.ac || task.acceptance || task.criteria || '', 'TBD').trim();
  return [
    `- [ ] **Task ${indexLabel}**: ${title || 'TBD'}`,
    `  - **核心逻辑**: ${core || 'TBD'}`,
    `  - **技术细节**: ${details || 'TBD'}`,
    `  - **验收准则 (AC)**: ${ac || 'TBD'}`,
  ].join('\n');
}

function buildAtomicSection(originalIndex, summary, tasks) {
  const title = sanitizeModelText(summary, 'TBD');
  const blocks = tasks
    .map((task, idx) => formatAtomicTaskBlock(`${originalIndex}.${idx + 1}`, task))
    .join('\n\n');
  return `### 原始任务 ${originalIndex}: ${title || 'TBD'}\n\n${blocks}`;
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

function validateAtomicTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return { ok: false, error: 'empty' };
  const normalized = tasks.map(normalizeTaskObject).filter(Boolean);
  if (!normalized.length) return { ok: false, error: 'invalid_shape' };
  const missingFields = normalized.some((t) => !t.title || !t.core || !t.details || !t.ac);
  if (missingFields) return { ok: false, error: 'missing_fields' };
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
    if (/(TBD|待定|\[path\]|占位)/i.test(token)) return true;
    if (!hasFileExtension(token)) return true;
    return false;
  });
  if (invalidPath) return { ok: false, error: 'invalid_path' };
  return { ok: true, tasks: normalized };
}


function coerceAtomicTasks(tasks) {
  const normalized = Array.isArray(tasks) ? tasks.map(normalizeTaskObject).filter(Boolean) : [];
  if (!normalized.length) return [];
  return normalized.map((task) => {
    let title = sanitizeModelText(task.title || '', '').trim();
    if (!/^(创建|修改|删除)\s+\S+/.test(title)) {
      const hint = title ? `｜${title}` : '';
      title = `创建 docs/assumptions.md${hint}`;
    }
    if (/(TBD|待定|\[path\]|占位)/i.test(title) || !/\.[A-Za-z0-9]{1,8}\b/.test(title)) {
      const action = title.split(/\s+/)[0] || '创建';
      const rest = title.replace(/^(创建|修改|删除)\s+\S+/, '').trim();
      title = `${action} docs/assumptions.md${rest ? `｜${rest}` : ''}`.trim();
    }
    const core =
      sanitizeModelText(task.core || '', '记录本段原子化所需假设与待确认点。').trim() ||
      '记录本段原子化所需假设与待确认点。';
    const details =
      sanitizeModelText(
        task.details || '',
        '补充：目录结构/入口文件/关键模块位置/接口约束；并给出下一步继续拆解所需信息。',
      ).trim() ||
      '补充：目录结构/入口文件/关键模块位置/接口约束；并给出下一步继续拆解所需信息。';
    const ac =
      sanitizeModelText(
        task.ac || '',
        'docs/assumptions.md 存在，且包含“待确认点”小节与至少 3 条条目。',
      ).trim() || 'docs/assumptions.md 存在，且包含“待确认点”小节与至少 3 条条目。';
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
  const title = hint ? `创建 docs/assumptions.md｜${hint}` : '创建 docs/assumptions.md';
  return [
    {
      title,
      core: '记录原子化所需的假设与待确认点，避免生成占位符路径。',
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
  const maxTasks = Number(process.env.LLM_TASK_MAX || 16);
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
    const normalized = rawTasks.map(normalizeTaskObject).filter(Boolean);
    const hasEnough = normalized.length >= Math.min(minTasks, maxTasks);
    const isChinese = normalized.every((t) =>
      looksLikeChinese(`${t.title} ${t.core} ${t.details} ${t.ac}`),
    );
    if (!hasEnough || !isChinese) {
      recordTelemetry(null);
      return generateTasksContent(design, prompt);
    }
    const trimmed = normalized.slice(0, maxTasks);
    recordTelemetry(null);
    return buildTasksMarkdown(prompt || design, { tasks: trimmed });
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

  const parsed = tryParseJson(content);
  let candidateTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  let verdict = validateAtomicTasks(candidateTasks);
  let lastError = verdict.error || null;
  if (!verdict.ok) {
    const repairPrefix = `上一次输出不符合要求（原因：${verdict.error}）。请直接重做。\n\n`;
    const repairedCall = await callOnce({ label: 'repair', userPrefix: repairPrefix });
    const repair = repairedCall.content;
    const repaired = tryParseJson(repair);
    candidateTasks = Array.isArray(repaired?.tasks) ? repaired.tasks : [];
    verdict = validateAtomicTasks(candidateTasks);
    lastError = verdict.error || lastError;
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
  const needsSplit = cleaned.length > 180;
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
    let summaries = parseTaskSummaries(tasksMarkdown);
    if (!summaries.length && (designMarkdown.trim() || status.prompt)) {
      const fallbackTasksMarkdown = generateTasksContent(designMarkdown, status.prompt);
      writeSpecFile(specName, 'tasks', fallbackTasksMarkdown);
      tasksMarkdown = fallbackTasksMarkdown;
      summaries = parseTaskSummaries(tasksMarkdown);
      if (summaries.length) {
        logAtomize(job, 'tasks.md 缺失/格式不兼容，已自动生成模板任务清单。');
      }
    }

    if (!summaries.length) throw new Error('任务列表为空，无法原子化');

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

    job.total = summaries.length;
    job.completed = doneIndices.size;
    logAtomize(job, `检测到 ${summaries.length} 条任务，已完成 ${job.completed} 条。`);
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
          total: summaries.length,
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
    const timeoutMs = Number(process.env.LLM_TASK_ATOMIZE_TIMEOUT_MS || 60000);

    let processedThisRun = 0;

    for (let i = 0; i < summaries.length; i += 1) {
      const index = i + 1;
      if (doneIndices.has(index)) {
        logAtomize(job, `跳过原始任务 ${index}（已完成）`);
        continue;
      }
      if (processedThisRun >= batchSize) break;
      const summary = summaries[i];
      logAtomize(job, `开始原始任务 ${index}/${summaries.length}：${summary}`);
      const telemetry = {
        meta: { originalIndex: index, originalTask: summary },
        recordAttempt: (attempt) =>
          appendFlowRunStageAttempt(specName, 'atomize', attempt, { reason: flowRunReason }),
      };
      const atomized = canUseModel
        ? await atomizeTaskSummarySafe(
            summary,
            designSnippet,
            maxRounds,
            timeoutMs,
            job,
            telemetry,
            iterationReason,
          )
        : buildFallbackAtomicTasks(summary);
      const section = buildAtomicSection(index, summary, atomized);
      fs.appendFileSync(atomicPath, `\n\n${section}\n`, 'utf8');
      doneIndices.add(index);
      job.completed = doneIndices.size;
      processedThisRun += 1;
      logAtomize(job, `完成原始任务 ${index}/${summaries.length}`);
    }

    job.running = false;
    job.error = null;

    if (doneIndices.size >= summaries.length) {
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
            total: summaries.length,
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

    const remaining = Math.max(0, summaries.length - doneIndices.size);
    logAtomize(
      job,
      `本次分段完成（处理 ${processedThisRun} 条），已完成 ${doneIndices.size}/${summaries.length}，剩余 ${remaining} 条。`,
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
          /(TBD|待定)/i.test(t.title) ||
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
    `9) 如果某些文件路径不确定，用 TBD 占位，但仍必须以“创建/修改/删除”开头。\n`;

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
        onStage?.('requirements', 'start');
        const content = await generateRequirementsWithModel(prompt, {
          onToken: onLlmToken ? (delta) => onLlmToken('requirements', delta) : null,
          onTelemetry,
        });
        onStage?.('requirements', 'end');
        writeSpecFile(name, artifact, content);
        const status = readSpecStatus(name);
        ensureRequirementsReviewSeeded(name, status, content);
        onStage?.('requirementsClarifications', 'start');
        const clarifications = await generateClarificationsWithModel(prompt, {
          onToken: onLlmToken
            ? (delta) => onLlmToken('requirementsClarifications', delta)
            : null,
          onTelemetry,
        });
        onStage?.('requirementsClarifications', 'end');
        const normalizedClarifications = normalizeRequirementsClarifications(clarifications);
        const nextStatus = readSpecStatus(name);
        nextStatus.requirementsClarifications = {
          ...nextStatus.requirementsClarifications,
          questions: normalizedClarifications.questions.length
            ? normalizedClarifications.questions
            : [],
          generatedBy: 'llm',
          generationError: null,
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

function startPty(command, args) {
  if (ptyProcess) {
    ptyProcess.kill();
    ptyProcess = null;
  }

  const shell = process.env.SHELL || 'powershell.exe';
  const resolvedCommand = command || shell;
  const resolvedArgs = args && args.length ? args : [];

  ptyProcess = pty.spawn(resolvedCommand, resolvedArgs, {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
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
  const defaults = normalizePromptConfig(DEFAULT_PROMPT_CONFIG);
  const presets = loadPromptPresets().filter((item) => item && typeof item === 'object');
  return res.json({ current, defaults, presets });
});

app.post('/prompts', (req, res) => {
  try {
    const incoming = req.body?.config ?? req.body ?? {};
    const saved = persistPromptConfig(incoming);
    emitEvent('log:append', { source: 'prompt', message: '[prompt] config updated' });
    const defaults = normalizePromptConfig(DEFAULT_PROMPT_CONFIG);
    const presets = loadPromptPresets().filter((item) => item && typeof item === 'object');
    return res.json({ current: saved, defaults, presets });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Invalid prompt config' });
  }
});

app.post('/prompts/reset', (req, res) => {
  try {
    const saved = persistPromptConfig(DEFAULT_PROMPT_CONFIG);
    emitEvent('log:append', { source: 'prompt', message: '[prompt] config reset' });
    const defaults = normalizePromptConfig(DEFAULT_PROMPT_CONFIG);
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
    const defaults = normalizePromptConfig(DEFAULT_PROMPT_CONFIG);
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
    const defaults = normalizePromptConfig(DEFAULT_PROMPT_CONFIG);
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
      const injected = buildRequirementsMarkdown(status.prompt, {
        summary: status.prompt,
        background: '',
        user_stories: [],
        acceptance: [],
      });
      const tail = content.replace(/^# 需求（requirements）\s*/m, '').trim();
      content = `${injected}\n${tail ? `\n${tail}` : ''}`.trim();
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
    status.requirementsConfirmed = true;
    const requirementsPath = resolveSpecFile(specName, 'requirements');
    const requirementsContent = fs.existsSync(requirementsPath)
      ? fs.readFileSync(requirementsPath, 'utf8')
      : '';
    const designPath = resolveSpecFile(specName, 'design');
    const shouldGenerate =
      !fs.existsSync(designPath) || fs.readFileSync(designPath, 'utf8').trim() === '';
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
          content = `# 任务（tasks）\n\n## AI IDE 使用说明\n- 本文件是“规范驱动开发”的任务总览与回写入口（范围约束 / 验收记录）。\n- AI IDE 开发时优先按 tasks_atomic.md（原子化任务表单）逐条执行；完成情况与关键变更回写到 tasks.md，保持任务与代码同步。\n- 如发现遗漏或范围变化：先更新 tasks.md，再重新生成 tasks_atomic.md 后继续。\n\n## 任务清单\n- [ ] 1. 明确交付目标、受众与范围边界（写清不做什么）。\n- [ ] 2. 输出提纲/目录结构（章节顺序与每章要点）。\n- [ ] 3. 补齐关键内容：时间线/预算/分工/资源清单（按需求选择）。\n- [ ] 4. 输出风险清单与预案（触发条件/影响/应对措施）。\n- [ ] 5. 进行一致性校对（术语/数字/口径）并给出最终版本说明。\n- [ ] 6. 生成可交付版本（Markdown/PDF/Slides 其一或多份）。\n`;
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
  const pid = startPty(command, args);
  res.json({ pid });
});

app.post('/cli/input', (req, res) => {
  const { input } = req.body || {};
  if (ptyProcess && typeof input === 'string') {
    ptyProcess.write(input);
  }
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('state:init', {
    status: state.status,
    tasks: state.tasks,
    lastDiff: state.lastDiff,
    approvals: Object.values(state.approvals),
    testReport: state.testReport,
    logs: state.logs,
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
