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

const fileSnapshots = new Map();
let isPaused = false;
const SPEC_ARTIFACTS = ['requirements', 'design', 'tasks'];
const SPEC_TEMPLATES = {
  requirements: `# 需求（requirements）\n\n## 背景\n\n## 用户故事\n\n## 验收标准（EARS）\n- 当[条件/事件]时，系统应[期望行为]。\n`,
  design: `# 设计（design）\n\n## 架构概览\n\n## 关键流程/时序\n\n## 实现考虑\n`,
  tasks: `# 任务（tasks）\n\n## AI IDE 使用说明\n- 本文件是“规范驱动开发”的任务清单与执行记录入口。\n- AI IDE 应以此文件为唯一事实来源：逐条勾选任务、补充实现要点与验证结果，保持任务与代码同步。\n- 建议工作流：先完成 tasks.md → 再逐步实现代码 → 每完成一项就在此记录（类似 Kiro 的规范驱动开发）。\n\n## 任务清单\n\n- [ ] 1. \n- [ ] 2. \n- [ ] 3. \n`,
};
const DEFAULT_SPEC_STATUS = {
  requirementsConfirmed: false,
  designConfirmed: false,
  tasksConfirmed: false,
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

async function callLlm(messages, overrideConfig = null) {
  const { baseUrl, apiKey, model, responseFormat } = overrideConfig || getActiveLlmConfig();
  const timeoutMsOverride = Number(overrideConfig?.timeoutMs || 0) || null;

  const tryOnce = async (rootUrl) => {
    const url = `${String(rootUrl || '').replace(/\/$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timeoutMs = timeoutMsOverride || Number(process.env.LLM_TIMEOUT_MS || 60000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = {
      model,
      temperature: 0.3,
      messages,
    };
    if (responseFormat && responseFormat !== 'none' && responseFormat !== 'text') {
      body.response_format = { type: responseFormat };
    }

    try {
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
        throw new Error(`LLM request failed: ${message}`);
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string') {
        throw new Error('LLM response empty');
      }
      return content.trim();
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`LLM request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
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
    console.error('LLM call failed:', error?.message || error);
    throw error;
  }
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

async function generateClarificationsWithModel(prompt) {
  if (!hasLlmConfig()) throw new Error('LLM config missing');

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
    const content = await callLlm([
      {
        role: 'system',
        content:
          '你是需求澄清助手。只输出 JSON，不要解释，不要包含分析或思考过程。',
      },
      {
        role: 'user',
        content:
          `原始需求：${prompt}\n\n` +
          '请生成 5-8 个“需求确认问题”，用于对齐开发口径：\n' +
          '- 必须结合原始需求的领域/关键词（至少 2 题需要直接引用关键词）\n' +
          '- 每题都要给出 3-6 个可点击选项，并允许“其他（用户输入）”\n' +
          '- 避免泛泛而谈（例如“还有什么需求？”、“预算多少？”）\n\n' +
          '仅输出 JSON，结构如下（示例字段，不要输出示例说明文字）：\n' +
          '{\"questions\":[{\"id\":\"q1\",\"question\":\"...\",\"mode\":\"single\",\"required\":true,\"allowOther\":true,\"options\":[{\"id\":\"a\",\"label\":\"...\"}]}]}',
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
  return `# 任务（tasks）\n\n- [ ] 1. 搭建页面基础结构（header/正文/推荐阅读）。\n- [ ] 2. 编写与“${summary}”相关的文案内容与排版样式。\n- [ ] 3. 加入响应式布局与阅读优化（字体/行高/间距）。\n`;
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
  const tasks = normalizeLines(payload?.tasks || payload?.items || payload?.todo);
  const list =
    tasks.length > 0
      ? tasks
      : [
          '搭建页面基础结构（header/正文/推荐阅读）。',
          `编写与“${fallbackSummary}”相关的文案内容与排版样式。`,
          '加入响应式布局与阅读优化（字体/行高/间距）。',
        ];
  const guide = `## AI IDE 使用说明\n- 本文件是“规范驱动开发”的任务清单与执行记录入口。\n- AI IDE 应以此文件为唯一事实来源：逐条勾选任务、补充实现要点与验证结果，保持任务与代码同步。\n- 建议工作流：先完成 tasks.md → 再逐步实现代码 → 每完成一项就在此记录（类似 Kiro 的规范驱动开发）。\n\n## 任务清单`;
  return `# 任务（tasks）\n\n${guide}\n\n${list
    .map((item, index) => `- [ ] ${index + 1}. ${item}`)
    .join('\n')}\n`;
}

async function generateRequirementsWithModel(prompt) {
  if (!hasLlmConfig()) throw new Error('LLM config missing');

  const content = await callLlm([
    {
      role: 'system',
      content: '你是产品需求助手。只输出 JSON，不要解释，不要包含分析或思考过程。',
    },
    {
      role: 'user',
      content:
        `需求描述：${prompt}\n\n` +
        '请只输出 JSON，必须包含字段：background（字符串）, user_stories（字符串数组）, acceptance（字符串数组）。\n' +
        '要求：所有内容必须为简体中文；acceptance 每条为“当...时，系统应...”风格的可验证语句。\n' +
        '不要输出除 JSON 以外的任何内容。',
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

async function generateDesignWithModel(requirements, prompt) {
  if (!hasLlmConfig()) throw new Error('LLM config missing');

  const content = await callLlm([
    {
      role: 'system',
      content:
        '你是软件设计助手。只输出 JSON，不要解释，不要包含分析或思考过程。',
    },
    {
      role: 'user',
      content:
        `需求内容如下：\n${requirements || ''}\n\n补充描述：${prompt}\n\n` +
        '请只输出 JSON，字段：overview（字符串）, flows（字符串数组）, considerations（字符串数组）。不要输出除 JSON 以外的任何内容。',
    },
  ]);
  const payload = tryParseJson(content);
  if (!payload) {
    throw new Error(`LLM design output not JSON: ${String(content).slice(0, 200)}`);
  }
  const designPrompt = resolveDesignPrompt(prompt, requirements);
  return buildDesignMarkdown(designPrompt, payload);
}

async function generateTasksWithModel(design, prompt) {
  if (!hasLlmConfig()) {
    throw new Error('LLM config missing');
  }

  const TARGET_MIN_TASKS = 25;
  const TARGET_MAX_TASKS = 80;

  const parseTasksFromAny = (raw) => {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return [];
    const payload = tryParseJson(text);
    const tasks = normalizeLines(payload?.tasks || payload?.items || payload?.todo);
    if (tasks.length > 0) return tasks;

    // fallback: extract bullet-ish lines from plain text
    return extractAcceptanceFromText(text);
  };

  const looksLikeChinese = (line) => /[\u4e00-\u9fa5]/.test(String(line || ''));

  const content = await callLlm([
    {
      role: 'system',
      content:
        '你是资深软件工程师，擅长把设计文档拆解为“commit 级”的可执行任务。只输出 JSON，不要解释，不要包含分析或思考过程。',
    },
    {
      role: 'user',
      content:
        `设计内容如下：\n${design || ''}\n\n补充描述：${prompt}\n\n` +
        '请严格输出 JSON：{"tasks":[...]}。\n' +
        `要求：\n` +
        `1) 任务必须是“commit 级”颗粒度：每条任务对应一次可独立提交的变更，尽量可在 15-60 分钟内完成。\n` +
        `2) 任务必须为简体中文、可执行、以动词开头；数量 ${TARGET_MIN_TASKS}-${TARGET_MAX_TASKS} 条。\n` +
        `3) 每条任务必须是“单行文本”，并包含以下信息（用中文分号或“｜”分隔均可）：\n` +
        `   - 目的/产出：本次提交要交付什么\n` +
        `   - 修改内容：具体改动点\n` +
        `   - 涉及文件：列出关键文件路径（不确定就写 TBD，不要瞎编大量路径）\n` +
        `   - 验证方式：至少 1 条可执行的验证方式（例如 npm 脚本、curl、手工检查点）\n` +
        `4) 任务覆盖面要完整：前后端改动（如有）、异常处理、可观测性（日志/提示）、以及最基本的验证/自测步骤。\n` +
        `5) 避免“泛泛而谈”的任务，例如“完善功能/优化体验”；必须落到具体改动与产出。\n` +
        `示例（仅示例格式，不要照抄内容）：\n` +
        `- 新增登录接口｜修改：新增 /api/login 与校验逻辑｜文件：src/modules/auth/auth.controller.ts、src/modules/auth/auth.service.ts｜验证：curl -X POST ...\n` +
        '不要输出除 JSON 以外的任何内容。',
    },
  ]);

  let tasks = parseTasksFromAny(content);
  if (
    tasks.length === 0 ||
    tasks.length < TARGET_MIN_TASKS ||
    tasks.every((t) => !looksLikeChinese(t))
  ) {
    const repair = await callLlm([
      {
        role: 'system',
        content:
          '你是资深软件工程师，擅长把设计文档拆解为“commit 级”的可执行任务。只输出 JSON，不要解释，不要包含分析或思考过程。',
      },
      {
        role: 'user',
        content:
          `请把下面的任务列表改写/扩展为“简体中文、可执行、commit 级、单行文本”的任务，并严格输出 JSON：{"tasks":[...]}。\n` +
          `数量要求：${TARGET_MIN_TASKS}-${TARGET_MAX_TASKS} 条。\n` +
          `每条任务必须包含：目的/产出、修改内容、涉及文件（不确定写 TBD）、验证方式。\n\n` +
          `原始输出：\n${content}\n`,
      },
    ]);
    tasks = parseTasksFromAny(repair);
  }

  if (tasks.length === 0) {
    throw new Error('LLM tasks output invalid');
  }
  if (tasks.length < TARGET_MIN_TASKS) {
    throw new Error(`LLM tasks too few: ${tasks.length} (expected >= ${TARGET_MIN_TASKS})`);
  }
  if (tasks.every((t) => !looksLikeChinese(t))) {
    throw new Error('LLM tasks not in Simplified Chinese');
  }

  return buildTasksMarkdown(prompt || design, { tasks });
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
      return { name: specName, files, status };
    });
}

async function createSpecTemplates(name, artifacts = ['requirements'], prompt = '') {
  fs.mkdirSync(resolveSpecDir(name), { recursive: true });
  ensureSpecStatus(name, prompt ? { prompt } : null);
  for (const artifact of artifacts) {
    if (SPEC_ARTIFACTS.includes(artifact)) {
      if (artifact === 'requirements') {
        const content = await generateRequirementsWithModel(prompt);
        writeSpecFile(name, artifact, content);
        const status = readSpecStatus(name);
        ensureRequirementsReviewSeeded(name, status, content);
        const clarifications = await generateClarificationsWithModel(prompt);
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
  const status = readSpecStatus(specName);
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

app.post('/specs/:name/confirm', async (req, res) => {
  const specName = sanitizeSpecName(req.params.name);
  const artifact = req.body?.artifact;
  const force = req.body?.force === true;
  if (!specName || !SPEC_ARTIFACTS.includes(artifact)) {
    return res.status(400).json({ error: 'Invalid spec request' });
  }

  const status = readSpecStatus(specName);

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
      return res.status(409).json({ error: 'Requirements clarifications incomplete' });
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
        const content = await generateDesignWithModel(requirementsContent, supplementalPrompt);
        writeSpecFile(specName, 'design', content);
      } catch (error) {
        console.error('Design generation failed:', error?.message || error);
        return res.status(502).json({ error: error?.message || 'Design generation failed' });
      }
    }
  }

  if (artifact === 'design') {
    if (!status.requirementsConfirmed) {
      return res.status(409).json({ error: 'Requirements not confirmed' });
    }
    status.designConfirmed = true;
    const designPath = resolveSpecFile(specName, 'design');
    const designContent = fs.existsSync(designPath) ? fs.readFileSync(designPath, 'utf8') : '';
    const tasksPath = resolveSpecFile(specName, 'tasks');
    const shouldGenerate =
      force || !fs.existsSync(tasksPath) || fs.readFileSync(tasksPath, 'utf8').trim() === '';
    if (shouldGenerate) {
      try {
        const content = await generateTasksWithModel(designContent, status.prompt);
        writeSpecFile(specName, 'tasks', content);
      } catch (error) {
        console.error('Tasks generation failed:', error?.message || error);
        return res.status(502).json({ error: error?.message || 'Tasks generation failed' });
      }
    }
  }

  if (artifact === 'tasks') {
    if (!status.designConfirmed) {
      return res.status(409).json({ error: 'Design not confirmed' });
    }
    status.tasksConfirmed = true;
  }

  writeSpecStatus(specName, status);
  emitEvent('log:append', {
    source: 'spec',
    message: `[spec] confirmed ${specName}/${artifact}`,
  });
  return res.json({ ok: true, status });
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
