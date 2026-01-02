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
  'requirements',
  'requirementsClarifications',
  'design',
  'tasks',
  'atomize',
];

const DEFAULT_PROMPT_CONFIG = {
  version: 1,
  stages: {
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
        '你是项目任务拆解助手。请输出清晰但不必原子化的任务列表。只输出 JSON，不要解释。',
      user:
        `设计内容如下：\n{{design}}\n\n补充描述：{{prompt}}\n\n` +
        '请输出 {{minTasks}}-{{maxTasks}} 条任务（不要求原子化）。' +
        '每条任务必须包含 title/core/details/ac 四个字段，简体中文。\n' +
        'title 写清任务名称与产出，允许是模块/流程级别，不要求文件路径。\n' +
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
        '1) 输出为原子级任务，不要摘要，拆到无法再拆。\n' +
        '2) 任务对象字段：title/core/details/ac。\n' +
        '3) title 必须以“创建/修改/删除 <文件路径>”开头（路径不确定用 TBD）。\n' +
        '4) core/details/ac 必须具体可执行，包含函数名/变量名/组件 Prop/CSS 类名；每条任务应在 15 分钟内可完成。\n' +
        '5) 遵循定义先行：先 types/interfaces/schema，再业务逻辑。\n' +
        '6) 禁止自由发挥，保持与上下文一致；若涉及样式，写清具体类名或布局方案。\n' +
        '7) 任务顺序建议：Types/Interfaces -> Schema -> Utils/Storage -> UI 静态组件 -> 状态管理 -> 交互逻辑 -> 边界自愈。\n' +
        '8) 简体中文。\n' +
        '只输出 JSON：{"tasks":[...]}。',
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

function loadPromptConfig() {
  if (!fs.existsSync(PROMPT_CONFIG_FILE)) return normalizePromptConfig({});
  try {
    const raw = JSON.parse(fs.readFileSync(PROMPT_CONFIG_FILE, 'utf8'));
    return normalizePromptConfig(raw);
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

async function callLlm(messages, overrideConfig = null) {
  const activeConfig = getActiveLlmConfig();
  const mergedConfig = overrideConfig ? { ...activeConfig, ...overrideConfig } : activeConfig;
  const { baseUrl, apiKey, model, responseFormat, providerId } = mergedConfig;
  assertValidLlmConfig(mergedConfig);
  const llmContext = describeLlmConfig(mergedConfig);
  const timeoutMsOverride = Number(mergedConfig?.timeoutMs || 0) || null;

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
    const hardTimeout = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        const err = new Error(`LLM request timeout after ${timeoutMs}ms`);
        err.llmContext = llmContext;
        reject(err);
      }, timeoutMs);
      timer.unref?.();
    });

    const body = {
      model,
      temperature: 0.3,
      messages,
      stream: true,
      stream_options: { include_usage: false },
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
          const delta = payload?.choices?.[0]?.delta?.content;
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

  try {
    return await withV1Fallback();
  } catch (error) {
    console.error('LLM call failed:', error?.message || error, error?.llmContext || llmContext);
    throw error;
  }
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
    const raw = fs.readFileSync(filePath, 'utf8');
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

function normalizePrompt(prompt) {
  if (typeof prompt !== 'string') return '';
  return prompt.trim();
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

function normalizeClarificationOption(input) {
  const label = sanitizeOptionLabel(input?.label);
  if (!label) return null;
  const id =
    typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : nanoid();
  return { id, label };
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
    options: [
      { id: 'keep', label: '沿用现有项目技术栈（推荐）' },
      { id: 'react-vite', label: 'React + Vite' },
      { id: 'nextjs', label: 'Next.js (React)' },
      { id: 'vue-vite', label: 'Vue + Vite' },
      { id: 'vanilla', label: '纯 HTML/CSS/JS' },
      { id: 'none', label: '不需要前端' },
    ],
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const backendQuestion = {
    id: 'backend',
    question: '后端技术栈倾向是什么？',
    mode: 'single',
    required: true,
    allowOther: true,
    options: [
      { id: 'keep', label: '沿用现有项目技术栈（推荐）' },
      { id: 'nest', label: 'Node.js + NestJS' },
      { id: 'express', label: 'Node.js + Express' },
      { id: 'fastapi', label: 'Python + FastAPI' },
      { id: 'spring', label: 'Java + Spring Boot' },
      { id: 'none', label: '不需要后端' },
    ],
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const databaseQuestion = {
    id: 'database',
    question: '数据存储倾向是什么？',
    mode: 'single',
    required: true,
    allowOther: true,
    options: [
      { id: 'keep', label: '沿用现有项目技术栈（推荐）' },
      { id: 'postgres', label: 'PostgreSQL' },
      { id: 'mysql', label: 'MySQL' },
      { id: 'sqlite', label: 'SQLite' },
      { id: 'mongo', label: 'MongoDB' },
      { id: 'none', label: '不需要数据库/文件存储即可' },
    ],
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const authQuestion = {
    id: 'auth',
    question: '登录/鉴权方案倾向是什么？',
    mode: 'single',
    required: true,
    allowOther: true,
    options: [
      { id: 'keep', label: '沿用现有项目技术栈（推荐）' },
      { id: 'jwt', label: 'JWT' },
      { id: 'session', label: 'Session + Cookie' },
      { id: 'oauth', label: 'OAuth2 / 第三方登录' },
      { id: 'none', label: '无登录/公开访问' },
    ],
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const deployQuestion = {
    id: 'deploy',
    question: '部署方式倾向是什么？',
    mode: 'single',
    required: true,
    allowOther: true,
    options: [
      { id: 'keep', label: '沿用现有项目技术栈（推荐）' },
      { id: 'docker', label: 'Docker' },
      { id: 'pm2', label: 'PM2/进程守护' },
      { id: 'serverless', label: 'Serverless' },
      { id: 'static', label: '静态托管' },
      { id: 'local', label: '本地运行即可' },
    ],
    answer: { selectedOptionIds: [], otherText: '' },
    createdAt: now,
  };

  const questions = [];
  if (!isBackendOnly) questions.push(frontendQuestion);
  if (!isFrontendOnly) questions.push(backendQuestion);
  questions.push(databaseQuestion, authQuestion, deployQuestion);
  return questions.map(normalizeClarificationQuestion).filter(Boolean);
}

function ensureTechStackClarificationsSeeded(specName, status, prompt, designMarkdown) {
  const normalized = { ...DEFAULT_SPEC_STATUS, ...(status || {}) };
  const current = normalizeRequirementsClarifications(
    normalized.techStackClarifications || {},
  );
  if (!normalized.requirementsConfirmed) return { changed: false, status: normalized };
  if (normalized.techStackConfirmed) return { changed: false, status: normalized };
  if (current.questions.length > 0) return { changed: false, status: normalized };

  const questions = buildDefaultTechStackQuestions(prompt, designMarkdown);
  if (questions.length === 0) return { changed: false, status: normalized };

  const now = new Date().toISOString();
  const next = {
    ...normalized,
    techStackClarifications: {
      ...current,
      questions,
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
    const content = onToken
      ? await callLlmStream(
          [
            {
              role: 'system',
              content: applyPromptTemplate(stage.system, { prompt }),
            },
            {
              role: 'user',
              content: applyPromptTemplate(stage.user, { prompt }),
            },
          ],
          null,
          { onToken },
        )
      : await callLlm([
          {
            role: 'system',
            content: applyPromptTemplate(stage.system, { prompt }),
          },
          {
            role: 'user',
            content: applyPromptTemplate(stage.user, { prompt }),
          },
        ]);
    const payload = tryParseJson(content);
    if (!payload) throw new Error(`LLM output not JSON: ${String(content).slice(0, 200)}`);
    const normalized = normalizeRequirementsClarifications(payload);
    if (!isValidClarifications(normalized)) {
      throw new Error(`LLM questions invalid: ${String(content).slice(0, 200)}`);
    }
    return { questions: normalized.questions, generatedBy: 'llm', generationError: null };
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

function generateRequirementsContent(prompt) {
  const summary = normalizePrompt(prompt);
  if (!summary) {
    return SPEC_TEMPLATES.requirements;
  }
  return `# 需求（requirements）\n\n## 背景\n${summary}\n\n## 用户故事\n- 作为用户，我希望能够${summary}，以便获得清晰的内容与体验。\n\n## 验收标准（EARS）\n- WHEN 用户打开页面\n  THE SYSTEM SHALL 展示与“${summary}”一致的内容布局与样式\n- WHEN 用户滚动阅读\n  THE SYSTEM SHALL 保持排版清晰、可读性良好\n`;
}

function generateDesignContent(requirements, prompt) {
  const summary = normalizePrompt(requirements || prompt);
  if (!summary) {
    return SPEC_TEMPLATES.design;
  }
  return `# 设计（design）\n\n## 架构概览\n- 前端单页（HTML/CSS/JS）实现，重点在内容排版与阅读体验。\n- 页面结构包含：标题区、正文区、作者/日期信息、推荐阅读区。\n\n## 关键流程/时序\n1) 用户访问页面 → 展示文章摘要与正文内容。\n2) 用户滚动阅读 → 目录高亮或返回顶部按钮（可选）。\n3) 用户阅读完成 → 推荐阅读模块展示。\n\n## 实现考虑\n- 针对“${summary}”准备内容模块与配色方案。\n- 响应式布局，兼容移动端阅读。\n- 字体与行高设置以提升阅读舒适度。\n`;
}

function generateTasksContent(design, prompt) {
  const summary = normalizePrompt(design || prompt);
  if (!summary) {
    return SPEC_TEMPLATES.tasks;
  }
  return `# 任务（tasks）\n\n## 任务清单\n- [ ] 1. 梳理“${summary}”的模块清单与页面/服务边界。\n- [ ] 2. 明确最小可运行结构（入口、路由/页面、核心依赖）。\n- [ ] 3. 拆分关键流程并标注对应代码落点。\n- [ ] 4. 明确数据结构/接口草案（字段、命名、约束）。\n- [ ] 5. 记录需要的环境变量/配置项。\n- [ ] 6. 列出需要补齐的边界与异常场景。\n`;
}

function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // Handle fenced JSON blocks (common for Gemini/Claude).
  const fenceMatch = trimmed.match(/```[a-zA-Z]*\s*([\s\S]*?)\s*```/);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    try {
      return JSON.parse(inner);
    } catch {
      // continue with fallback strategies below
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
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
      title: `创建 README 任务说明｜文件：TBD｜验证：阅读并确认理解`,
      core: '补全任务拆解与执行记录的基本说明。',
      details: '说明 tasks.md 的用途与使用方式。',
      ac: '在仓库中可找到并阅读该说明。',
    },
    {
      title: `创建基础结构｜文件：TBD｜验证：启动并能访问页面`,
      core: `梳理与“${fallbackSummary}”相关的最小可运行骨架。`,
      details: '包含基本路由/页面/启动脚本。',
      ac: '本地能启动并访问。',
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
  const content = onToken
    ? await callLlmStream(
        [
          {
            role: 'system',
            content: applyPromptTemplate(stage.system, { prompt }),
          },
          {
            role: 'user',
            content: applyPromptTemplate(stage.user, { prompt }),
          },
        ],
        null,
        { onToken },
      )
    : await callLlm([
        {
          role: 'system',
          content: applyPromptTemplate(stage.system, { prompt }),
        },
        {
          role: 'user',
          content: applyPromptTemplate(stage.user, { prompt }),
        },
      ]);

  const payload = tryParseJson(content);
  if (!payload) {
    throw new Error(`LLM output not JSON: ${String(content).slice(0, 200)}`);
  }
  if (typeof payload.background !== 'string' || !payload.background.trim()) {
    throw new Error(`LLM requirements missing background: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  if (!Array.isArray(payload.user_stories) || payload.user_stories.length === 0) {
    throw new Error(`LLM requirements missing user_stories: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  const acceptance = filterAcceptanceLines(payload.acceptance);
  if (!acceptance || acceptance.length === 0) {
    throw new Error(`LLM requirements acceptance invalid: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return buildRequirementsMarkdown(prompt, { ...payload, acceptance });
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
  const content = onToken
    ? await callLlmStream(
        [
          {
            role: 'system',
            content: applyPromptTemplate(stage.system, { requirements, prompt }),
          },
          {
            role: 'user',
            content: applyPromptTemplate(stage.user, { requirements, prompt }),
          },
        ],
        null,
        { onToken },
      )
    : await callLlm([
        {
          role: 'system',
          content: applyPromptTemplate(stage.system, { requirements, prompt }),
        },
        {
          role: 'user',
          content: applyPromptTemplate(stage.user, { requirements, prompt }),
        },
      ]);
  const payload = tryParseJson(content);
  if (!payload) {
    throw new Error(`LLM design output not JSON: ${String(content).slice(0, 200)}`);
  }
  const designPrompt = resolveDesignPrompt(prompt, requirements);
  return buildDesignMarkdown(designPrompt, payload);
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

function parseTaskSummaries(markdown) {
  const lines = normalizeLineEndings(markdown || '').split('\n');
  const summaries = [];
  for (const line of lines) {
    const match = line.match(/^- \[[ xX]\]\s*(.+)$/);
    if (!match) continue;
    let text = match[1].trim();
    text = text.replace(/^\*\*Task\s*\d+\*\*:\s*/i, '');
    text = text.replace(/^\d+\.\s*/, '');
    if (text) summaries.push(text);
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
}


function coerceAtomicTasks(tasks) {
  const normalized = Array.isArray(tasks) ? tasks.map(normalizeTaskObject).filter(Boolean) : [];
  if (!normalized.length) return [];
  return normalized.map((task) => {
    let title = sanitizeModelText(task.title || '', '').trim();
    if (!/^(创建|修改|删除)\s+\S+/.test(title)) {
      const hint = title ? `｜${title}` : '';
      title = `修改 TBD${hint}`;
    }
    if (!/(TBD|待定)/i.test(title) && !/[\/]/.test(title)) {
      const action = title.split(/\s+/)[0] || '修改';
      const rest = title.replace(/^(创建|修改|删除)\s+\S+/, '').trim();
      title = `${action} TBD${rest ? ` ${rest}` : ''}`.trim();
    }
    const core = sanitizeModelText(task.core || '', 'TBD').trim() || 'TBD';
    const details = sanitizeModelText(task.details || '', 'TBD').trim() || 'TBD';
    const ac = sanitizeModelText(task.ac || '', 'TBD').trim() || 'TBD';
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
  const title = hint ? `修改 TBD｜${hint}` : '修改 TBD';
  return [{ title, core: 'TBD', details: 'TBD', ac: 'TBD' }];
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
  const content = onToken
    ? await callLlmStream(
        [
          {
            role: 'system',
            content: applyPromptTemplate(stage.system, { design, prompt, minTasks, maxTasks }),
          },
          {
            role: 'user',
            content: applyPromptTemplate(stage.user, { design, prompt, minTasks, maxTasks }),
          },
        ],
        { timeoutMs },
        { onToken },
      )
    : await callLlm(
        [
          {
            role: 'system',
            content: applyPromptTemplate(stage.system, { design, prompt, minTasks, maxTasks }),
          },
          {
            role: 'user',
            content: applyPromptTemplate(stage.user, { design, prompt, minTasks, maxTasks }),
          },
        ],
        { timeoutMs },
      );

  const payload = tryParseJson(content);
  const rawTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const normalized = rawTasks.map(normalizeTaskObject).filter(Boolean);
  const hasEnough = normalized.length >= Math.min(minTasks, maxTasks);
  const isChinese = normalized.every((t) =>
    looksLikeChinese(`${t.title} ${t.core} ${t.details} ${t.ac}`),
  );
  if (!hasEnough || !isChinese) {
    return generateTasksContent(design, prompt);
  }
  const trimmed = normalized.slice(0, maxTasks);
  return buildTasksMarkdown(prompt || design, { tasks: trimmed });
}

async function requestAtomicTasks(payload, designSnippet, timeoutMs, reason = '') {
  const promptConfig = loadPromptConfig();
  const stage = promptConfig.stages.atomize;

  const isList = Array.isArray(payload?.tasks);
  const context = designSnippet ? `设计摘要：${designSnippet}\n\n` : '';
  const main = isList
    ? `当前任务列表（JSON）：\n${JSON.stringify(payload.tasks)}\n\n请进一步拆分为更原子任务；若已足够原子则保持。`
    : `原始任务：${payload.summary}\n\n请拆分为无法再拆的原子任务。`;

  const reasonBlock = reason ? `注意：${reason}\n` : '';

  const content = await callLlm(
    [
      {
        role: 'system',
        content: applyPromptTemplate(stage.system, { context, main, reasonBlock }),
      },
      {
        role: 'user',
        content: applyPromptTemplate(stage.user, { context, main, reasonBlock }),
      },
    ],
    { timeoutMs },
  );

  const parsed = tryParseJson(content);
  let candidateTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  let verdict = validateAtomicTasks(candidateTasks);
  let lastError = verdict.error || null;
  if (!verdict.ok) {
    const repair = await callLlm(
      [
        {
          role: 'system',
          content: applyPromptTemplate(stage.system, { context, main, reasonBlock }),
        },
        {
          role: 'user',
          content:
            `上一次输出不符合要求（原因：${verdict.error}）。请直接重做。\n\n` +
            applyPromptTemplate(stage.user, { context, main, reasonBlock }),
        },
      ],
      { timeoutMs },
    );
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

async function atomizeTaskSummary(summary, designSnippet, maxRounds, timeoutMs) {
  let currentTasks = null;
  for (let round = 1; round <= maxRounds; round += 1) {
    const tasks = await requestAtomicTasks(
      currentTasks ? { tasks: currentTasks } : { summary },
      designSnippet,
      timeoutMs,
      currentTasks ? `第 ${round} 轮进一步拆分` : '',
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


async function atomizeSummaryParts(parts, designSnippet, timeoutMs, job) {
  const results = [];
  for (const part of parts) {
    try {
      const subTasks = await atomizeTaskSummary(part, designSnippet, 1, timeoutMs);
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

async function atomizeTaskSummarySafe(summary, designSnippet, maxRounds, timeoutMs, job) {
  const cleaned = sanitizeModelText(summary || '', '').trim();
  if (!cleaned) return buildFallbackAtomicTasks(summary);
  const needsSplit = cleaned.length > 180;
  if (needsSplit) {
    const parts = splitSummaryForAtomize(cleaned, 3);
    if (parts.length > 1) {
      logAtomize(job, `原始任务过长，拆分为 ${parts.length} 段处理。`);
      const results = await atomizeSummaryParts(parts, designSnippet, timeoutMs, job);
      if (results.length) return results;
    }
  }
  try {
    return await atomizeTaskSummary(cleaned, designSnippet, maxRounds, timeoutMs);
  } catch (error) {
    if (error?.partialTasks?.length) {
      logAtomize(job, `原始任务输出不规范（${error.partialReason || 'invalid'}），已自动降级。`);
      return error.partialTasks;
    }
    const parts = splitSummaryForAtomize(cleaned, 3);
    if (parts.length > 1) {
      logAtomize(job, `原始任务拆分为 ${parts.length} 段后重试。`);
      const results = await atomizeSummaryParts(parts, designSnippet, timeoutMs, job);
      if (results.length) return results;
    }
    logAtomize(job, '原子化失败，已生成占位任务。');
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

async function runAtomizeJob(specName, job, options = {}) {
  try {
    assertValidLlmConfig(getActiveLlmConfig());

    const tasksPath = resolveSpecFile(specName, 'tasks');
    if (!fs.existsSync(tasksPath)) throw new Error('Spec file not found');
    const tasksMarkdown = fs.readFileSync(tasksPath, 'utf8');
    const summaries = parseTaskSummaries(tasksMarkdown);
    if (!summaries.length) throw new Error('任务列表为空，无法原子化');

    const designPath = resolveSpecFile(specName, 'design');
    const designMarkdown = fs.existsSync(designPath)
      ? fs.readFileSync(designPath, 'utf8')
      : '';
    const designSnippet = truncateText(designMarkdown, 1200);

    const atomicPath = ensureAtomicFile(specName);
    const atomicContent = fs.existsSync(atomicPath) ? fs.readFileSync(atomicPath, 'utf8') : '';
    const doneIndices = parseAtomicDoneIndices(atomicContent);

    job.total = summaries.length;
    job.completed = doneIndices.size;
    logAtomize(job, `检测到 ${summaries.length} 条任务，已完成 ${job.completed} 条。`);

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
      const atomized = await atomizeTaskSummarySafe(summary, designSnippet, maxRounds, timeoutMs, job);
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
  const onLlmToken = typeof options?.onLlmToken === 'function' ? options.onLlmToken : null;
  const onStage = typeof options?.onStage === 'function' ? options.onStage : null;
  for (const artifact of artifacts) {
    if (SPEC_ARTIFACTS.includes(artifact)) {
      if (artifact === 'requirements') {
        onStage?.('requirements', 'start');
        const content = await generateRequirementsWithModel(prompt, {
          onToken: onLlmToken ? (delta) => onLlmToken('requirements', delta) : null,
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

app.get('/specs/:name/:artifact', (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  const artifact = req.params.artifact;
  if (!specName || !SPEC_ARTIFACTS.includes(artifact)) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }
  const filePath = resolveSpecFile(specName, artifact);
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
          stream
            ? {
                onToken: (delta) =>
                  stream.write({ type: 'delta', stage: 'design', delta }),
              }
            : null,
        );
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
      try {
        const supplementalPrompt = [status.prompt, buildTechStackSummary(status.techStackClarifications)]
          .filter(Boolean)
          .join('\n\n');
        stream?.write({ type: 'stage', stage: 'tasks', state: 'start' });
        const content = await generateTasksWithModel(
          designContent,
          supplementalPrompt,
          stream
            ? {
                onToken: (delta) => stream.write({ type: 'delta', stage: 'tasks', delta }),
              }
            : null,
        );
        stream?.write({ type: 'stage', stage: 'tasks', state: 'end' });
        writeSpecFile(specName, 'tasks', content);
        status.lastError = null;

      } catch (error) {
        recordSpecError(status, 'tasks', error, { timeoutMs: Number(process.env.LLM_TASK_TIMEOUT_MS || 0) || null });
        writeSpecStatus(specName, status);
        console.error('Tasks generation failed:', error?.message || error);
        return respondError(502, error?.message || 'Tasks generation failed', {
          stage: 'tasks',
          context: error?.llmContext || null,
          timeoutMs: Number(process.env.LLM_TASK_TIMEOUT_MS || 0) || null,
        });
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
  job.updatedAt = now;
  atomizeJobs.set(specName, job);
  logAtomize(
    job,
    `原子化任务已启动${batchSize ? `（分段：${batchSize} 条）` : '（分段：默认）'}`,
  );

  setImmediate(() => {
    runAtomizeJob(specName, job, { batchSize });
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
