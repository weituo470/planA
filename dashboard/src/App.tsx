import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';

import { Button } from './components/ui/button';
import { ExplorerSidebar } from './ExplorerSidebar';
import { TerminalPanel, type TerminalPanelHandle, type AssignableCliTerminal } from './TerminalPanel';
import { ManualTaskRunner } from './components/mvp5';
import type {
  ClarificationQuestion,
  LlmInfo,
  LlmPingResult,
  PromptConfig,
  PromptConfigResponse,
  SpecArtifact,
  SpecSummary,
} from './types';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:4100';
const API_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS || 90000);
const TASK_TIMEOUT_MS = Number(import.meta.env.VITE_TASK_TIMEOUT_MS || 180000);
const DOWNLOAD_PREFIX = 'planA-v0.1';
const ATOMIZE_ENABLED = false;

type TaskView = 'tasks' | 'atomic';

type CliToolInfo = {
  id: string;
  label: string;
  command: string;
  args: string[];
  baseUrl: string;
  baseUrlPresent: boolean;
  apiKeyPresent: boolean;
  baseUrlEnvKey: string;
  apiKeyEnvKey: string;
  env: Record<string, string>;
};

type CliToolDraft = {
  id: string;
  label: string;
  command: string;
  argsText: string;
  baseUrl: string;
  baseUrlEnvKey: string;
  apiKey: string;
  apiKeyEnvKey: string;
  envText: string;
  clearApiKey: boolean;
};

type OutputScrollEl = HTMLDivElement | HTMLTextAreaElement;

type AtomizeLogEntry = {
  at: string;
  message: string;
};

type AtomizeStatus = {
  running: boolean;
  total: number;
  completed: number;
  logs: AtomizeLogEntry[];
  error?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
};

type ReportScoreResult = {
  score: number;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
};

type ReportModelRating = {
  ok?: boolean;
  skipped?: boolean;
  updatedAt?: string | null;
  attemptId?: string | null;
  result?: ReportScoreResult | null;
  error?: { message?: string } | null;
};

type ReportRatings = {
  updatedAt: string | null;
  byModel: Record<string, ReportModelRating>;
};

type ReportUserRating = {
  score: number;
  comment?: string;
  createdAt: string;
};

type ReportScoreJobStatus = {
  running: boolean;
  total: number;
  completed: number;
  logs: AtomizeLogEntry[];
  error?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
};

type TasksIterateJobStatus = {
  running: boolean;
  total: number;
  completed: number;
  logs: AtomizeLogEntry[];
  error?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  outputRunId?: string | null;
  outputReportPath?: string | null;
};

type SpecReportSummary = {
  runId: string;
  createdAt: string | null;
  updatedAt: string | null;
  reportPath: string | null;
  ratings: ReportRatings;
  userRatings: ReportUserRating[];
  scoreJob: ReportScoreJobStatus | null;
};

const PROMPT_STAGE_ORDER = [
  { key: 'projectCategory', label: '项目类型识别' },
  { key: 'requirementsClarifications', label: '提问确认问题生成' },
  { key: 'requirements', label: '需求生成' },
  { key: 'design', label: '设计生成' },
  { key: 'tasks', label: '任务生成' },
  { key: 'reportScore', label: '流程报告评分' },
  { key: 'mvp5Plan', label: 'MVP5 执行方案生成' },
] as const;

function sanitizeFilePart(input: string) {
  return String(input || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
}

function makeDownloadBaseName(specName: string) {
  const safe = sanitizeFilePart(specName);
  return safe ? `${DOWNLOAD_PREFIX}_${safe}` : DOWNLOAD_PREFIX;
}

function basenameFromAnyPath(input: string) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadMarkdown(filename: string, content: string) {
  downloadBlob(filename, new Blob([content ?? ''], { type: 'text/markdown;charset=utf-8' }));
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function averageNumber(values: number[]) {
  const list = Array.isArray(values) ? values.filter((n) => Number.isFinite(n)) : [];
  if (!list.length) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

function formatDurationSeconds(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const ss = s % 60;
  if (m < 60) return `${m}m${String(ss).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h${String(mm).padStart(2, '0')}m`;
}

function parseIsoMs(value: string | null | undefined) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : null;
}

function computeThroughputEtaSeconds(input: {
  total: number;
  completed: number;
  startedAt: string | null | undefined;
}) {
  const total = Number(input.total);
  const completed = Number(input.completed);
  if (!Number.isFinite(total) || !Number.isFinite(completed) || total <= 0) return null;
  if (completed <= 0 || completed >= total) return 0;
  const startedMs = parseIsoMs(input.startedAt);
  if (!startedMs) return null;
  const elapsedMs = Date.now() - startedMs;
  if (elapsedMs <= 0) return null;
  const rate = completed / elapsedMs; // items per ms
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const remainingMs = (total - completed) / rate;
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;
  return Math.ceil(remainingMs / 1000);
}

const MATRIX_GLYPHS =
  '░▒▓█▇▆▅▄▃▂▁▔▕▖▗▘▙▚▛▜▝▞▟' +
  '┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╔╗╚╝╠╣╦╩╬═║' +
  '◆◇◈◉◎●○◊◌◍◐◑◒◓◔◕' +
  '⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟' +
  '⌁⌂⌃⌄⌅⌆⌇⌈⌉⌊⌋⌌⌍⌎⌏' +
  '⟊⟋⟌⟍⟎⟏⟐⟑⟒⟓⟔⟕⟖⟗⟘⟙⟚⟛⟜⟝⟞⟟⟠⟡';

const SCRAMBLE_HIDE_ORIGINAL_RE = /[\p{L}\p{N}]/u;

function matrixScrambleSegment(segment: string, phase: number) {
  const len = segment.length;
  if (!len) return '';
  const glyphs = MATRIX_GLYPHS;
  const glyphLen = glyphs.length;
  let out = '';
  for (let i = 0; i < len; i += 1) {
    const ch = segment[i];
    if (ch === '\n' || ch === '\r' || ch === '\t' || ch === ' ') {
      out += ch;
      continue;
    }
    const t = len <= 1 ? 0 : i / (len - 1);
    const revealProb = clampNumber(0.92 - t * 0.86, 0.04, 0.98);
    const seed = (phase * 9301 + i * 49297 + ch.charCodeAt(0) * 17) % 233280;
    const r = seed / 233280;
    const canRevealOriginal = !SCRAMBLE_HIDE_ORIGINAL_RE.test(ch);
    if (canRevealOriginal && r < revealProb) {
      out += ch;
      continue;
    }
    const glyphIndex = Math.abs((seed + phase * 37 + i * 11) % glyphLen);
    out += glyphs[glyphIndex] ?? '#';
  }
  return out;
}

async function renderTextToPng(text: string, title: string) {
  const padding = 24;
  const width = 960;
  const maxTextWidth = width - padding * 2;
  const monoFont =
    '14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  const titleFont =
    '600 16px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  const lineHeight = 20;
  const titleLineHeight = 24;

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('Canvas not supported');

  const wrap = (raw: string, font: string) => {
    measure.font = font;
    const out: string[] = [];
    for (const paragraph of String(raw ?? '').split(/\r?\n/)) {
      if (paragraph === '') {
        out.push('');
        continue;
      }
      let current = '';
      for (const ch of paragraph) {
        const next = current + ch;
        if (measure.measureText(next).width > maxTextWidth && current) {
          out.push(current);
          current = ch;
        } else {
          current = next;
        }
      }
      out.push(current);
    }
    return out;
  };

  const titleLines = wrap(title, titleFont);
  const bodyLines = wrap(text, monoFont);
  const height =
    padding * 2 +
    titleLines.length * titleLineHeight +
    12 +
    Math.max(1, bodyLines.length) * lineHeight;

  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * dpr);
  canvas.height = Math.ceil(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  let y = padding;
  ctx.font = titleFont;
  ctx.fillStyle = '#111827';
  for (const line of titleLines) {
    ctx.fillText(line, padding, y + 16);
    y += titleLineHeight;
  }
  y += 12;

  ctx.font = monoFont;
  for (const line of bodyLines.length ? bodyLines : ['']) {
    ctx.fillText(line, padding, y + 14);
    y += lineHeight;
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to render PNG'))), 'image/png');
  });
}

function buildTechStackMarkdown(questions: ClarificationQuestion[]) {
  const lines: string[] = [];
  lines.push('## 技术栈确认', '');
  questions.forEach((q, i) => {
    const selectedIds = q.answer?.selectedOptionIds ?? [];
    const selectedText = q.options
      .filter((opt) => selectedIds.includes(opt.id))
      .map((opt) => {
        const desc = (opt.desc ?? '').trim();
        const wiki = (opt.wiki ?? '').trim();
        const parts: string[] = [opt.label];
        if (desc) parts.push(`— ${desc}`);
        if (wiki) parts.push(`[Wiki](${wiki})`);
        return parts.join(' ');
      })
      .filter(Boolean);
    const otherText = (q.answer?.otherText ?? '').trim();
    lines.push(`### Q${i + 1}. ${q.question}`);
    lines.push(`- 选择：${selectedText.length ? selectedText.join('； ') : '（未选择）'}`);
    if (q.allowOther) lines.push(`- 补充：${otherText ? otherText : '（无）'}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function upsertTechStackSection(markdown: string, questions: ClarificationQuestion[]) {
  const section = buildTechStackMarkdown(questions);
  const text = markdown ?? '';
  const re = /^## 技术栈确认[\s\S]*?(?=\n## |\n# |$)/m;
  if (re.test(text)) return text.replace(re, section).trimEnd();
  return `${text.trimEnd()}\n\n${section}\n`.trimEnd();
}

async function apiJson<T>(path: string, init?: RequestInit, timeoutMsOverride?: number): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = Number(timeoutMsOverride ?? API_TIMEOUT_MS);
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`请求超时（${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = typeof data === 'string' ? data : data?.error || res.statusText;
    const error: any = new Error(message);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data as T;
}

function cliArgsToText(args?: string[]) {
  if (!Array.isArray(args) || !args.length) return '';
  return args.map((v) => String(v ?? '')).filter(Boolean).join('\n');
}

function cliTextToArgs(text: string) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cliEnvToText(env?: Record<string, string>) {
  if (!env || typeof env !== 'object') return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${String(v ?? '')}`)
    .join('\n');
}

function cliTextToEnv(text: string) {
  const env: Record<string, string> = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = trimmed.slice(eq + 1);
  }
  return env;
}

async function apiNdjsonStream<T>(
  path: string,
  init: RequestInit | undefined,
  onEvent: (event: any) => void,
  timeoutMsOverride?: number,
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = Number(timeoutMsOverride ?? API_TIMEOUT_MS);
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (error: any) {
    window.clearTimeout(timer);
    if (error?.name === 'AbortError') {
      throw new Error(`请求超时（${timeoutMs}ms）`);
    }
    throw error;
  }

  if (!res.ok) {
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    const message = typeof data === 'string' ? data : data?.error || res.statusText;
    const error: any = new Error(message);
    error.status = res.status;
    error.data = data;
    window.clearTimeout(timer);
    throw error;
  }

  const contentType = String(res.headers.get('content-type') || '');
  if (/application\/json/i.test(contentType)) {
    try {
      const data = (await res.json()) as T;
      onEvent({ type: 'result', data });
      return data;
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error(`请求超时（${timeoutMs}ms）`);
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  const reader = res.body?.getReader();
  if (!reader) {
    window.clearTimeout(timer);
    throw new Error('响应不支持流式读取');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let result: any = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf('\n');
        if (idx < 0) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt: any = null;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue;
        }
        onEvent(evt);
        if (evt?.type === 'error') {
          const message = String(evt?.error || '发生未知错误');
          const error: any = new Error(message);
          error.status = Number(evt?.status || 0) || null;
          error.data = evt;
          throw error;
        }
        if (evt?.type === 'result') {
          result = evt?.data;
          break;
        }
      }
      if (result !== null) break;
    }

    if (result === null) {
      throw new Error('流式响应提前结束');
    }
    return result as T;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`请求超时（${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function humanizeError(e: any) {
  const status = Number(e?.status || 0) || null;
  const msg = String(e?.message || e || '').trim();

  if (!msg) return '发生未知错误';
  if (status === 409 && /Design not confirmed/i.test(msg)) return '设计尚未生成，请先生成设计。';
  if (status === 409 && /Requirements not confirmed/i.test(msg)) {
    return '需求文档（requirements.md）尚未生成，请先完成提问确认并生成 requirements.md。';
  }
  if (status === 409 && /Tech stack clarifications incomplete/i.test(msg)) return '技术栈确认未完成，请先完成必填项。';
  if (status === 409 && /clarifications incomplete/i.test(msg)) return '提问确认未完成，请先完成必填项。';
  if (status === 404 && /Spec file not found/i.test(msg)) return '文档尚未生成。';
  if (/Failed to fetch/i.test(msg)) return '无法连接到服务，请检查 bridge 地址/反代配置。';
  if (/LLM config missing/i.test(msg)) return `模型配置缺失：${msg.replace(/^LLM config missing:\s*/i, '')}`;
  if (/LLM base_url invalid protocol/i.test(msg)) return `模型地址协议无效：${msg}`;
  if (/LLM base_url invalid/i.test(msg)) return `模型地址无效：${msg.replace(/^LLM base_url invalid:\s*/i, '')}`;
  if (/LLM request timeout/i.test(msg)) return `模型请求超时：${msg.replace(/^LLM request timeout\s*after\s*/i, '')}`;
  if (/LLM request failed/i.test(msg)) return `模型请求失败：${msg.replace(/^LLM request failed:\s*/i, '')}`;
  if (/LLM response empty/i.test(msg)) return '模型返回为空。';
  return msg;
}

function isClarificationComplete(q: ClarificationQuestion) {
  const selected = q.answer?.selectedOptionIds ?? [];
  const other = (q.answer?.otherText ?? '').trim();
  if (!q.required) return true;
  if (selected.length > 0) return true;
  if (q.allowOther && other) return true;
  return false;
}

function areClarificationsComplete(questions: ClarificationQuestion[]) {
  return questions.every(isClarificationComplete);
}


function errorStageLabel(stage?: string | null) {
  if (!stage) return '未知阶段';
  if (stage === 'requirements') return '需求生成';
  if (stage === 'requirementsClarifications') return '提问确认问题生成';
  if (stage === 'design') return '设计生成';
  if (stage === 'tasks') return '任务生成';
  if (stage === 'reportScore') return '流程报告评分';
  return stage;
}

function formatErrorTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function artifactLabel(a: SpecArtifact) {
  if (a === 'requirements') return '需求';
  if (a === 'design') return '设计';
  return '任务';
}

type AtomicTaskFieldKey = 'core' | 'details' | 'depends' | 'ac';

type AtomicTaskItem = {
  id: string;
  done: boolean;
  title: string;
  core: string;
  details: string;
  depends: string[];
  ac: string;
  originalIndex: number | null;
  originalTitle: string;
};

type AtomicTaskGroup = {
  originalIndex: number | null;
  originalTitle: string;
  tasks: AtomicTaskItem[];
};

const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function stripAnsi(text: string) {
  return String(text || '').replace(ANSI_ESCAPE_RE, '');
}

function parseTasksAtomicMarkdown(markdown: string): AtomicTaskGroup[] {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  const groups: AtomicTaskGroup[] = [];
  let currentGroup: AtomicTaskGroup | null = null;
  let currentTask: AtomicTaskItem | null = null;
  let lastField: AtomicTaskFieldKey | null = null;

  const ensureGroup = () => {
    if (currentGroup) return currentGroup;
    currentGroup = { originalIndex: null, originalTitle: '', tasks: [] };
    groups.push(currentGroup);
    return currentGroup;
  };

  const flushTask = () => {
    if (!currentTask) return;
    ensureGroup().tasks.push(currentTask);
    currentTask = null;
    lastField = null;
  };

  for (const line of lines) {
    const originalMatch = /^###\s*原始任务\s*(\d+)\s*:\s*(.*)\s*$/.exec(line);
    if (originalMatch) {
      flushTask();
      const parsedIndex = Number.parseInt(originalMatch[1], 10);
      currentGroup = {
        originalIndex: Number.isNaN(parsedIndex) ? null : parsedIndex,
        originalTitle: String(originalMatch[2] || '').trim(),
        tasks: [],
      };
      groups.push(currentGroup);
      continue;
    }

    const taskMatch = /^- \[( |x|X)\]\s*\*\*Task\s+([^*]+?)\*\*:\s*(.*)\s*$/.exec(line);
    if (taskMatch) {
      flushTask();
      const done = String(taskMatch[1] || '').toLowerCase() === 'x';
      currentTask = {
        id: String(taskMatch[2] || '').trim(),
        done,
        title: String(taskMatch[3] || '').trim(),
        core: '',
        details: '',
        depends: [],
        ac: '',
        originalIndex: currentGroup?.originalIndex ?? null,
        originalTitle: currentGroup?.originalTitle ?? '',
      };
      lastField = null;
      continue;
    }

    if (!currentTask) continue;

    const fieldMatch =
      /^\s{2,}-\s*\*\*(核心逻辑|技术细节|依赖|验收准则(?:\s*\(AC\))?)\*\*:\s*(.*)\s*$/.exec(line);
    if (fieldMatch) {
      const label = fieldMatch[1];
      const value = String(fieldMatch[2] || '').trim();
      if (label.includes('核心逻辑')) {
        lastField = 'core';
        currentTask[lastField] = value;
      } else if (label.includes('技术细节')) {
        lastField = 'details';
        currentTask[lastField] = value;
      } else if (label.includes('依赖')) {
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
      lastField !== 'depends' &&
      trimmed &&
      !/^###\s/.test(trimmed) &&
      !/^- \[( |x|X)\]\s*\*\*Task\s+/i.test(trimmed) &&
      !/^\s{0,}-\s*\*\*/.test(trimmed)
    ) {
      currentTask[lastField] = currentTask[lastField]
        ? `${currentTask[lastField]}\n${trimmed}`
        : trimmed;
    }
  }

  flushTask();
  return groups.filter((g) => g.tasks.length > 0);
}

export default function App() {
  const [rawPrompt, setRawPrompt] = useState('');
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [selectedSpecName, setSelectedSpecName] = useState<string | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<SpecArtifact>('requirements');
  const [artifactContent, setArtifactContent] = useState<Record<SpecArtifact, string>>({
    requirements: '',
    design: '',
    tasks: '',
  });
  const [taskView, setTaskView] = useState<TaskView>('tasks');
  const [tasksAtomicContent, setTasksAtomicContent] = useState('');
  const [atomicDisplayMode, setAtomicDisplayMode] = useState<'list' | 'raw'>('list');
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [tasksDisplayMode, setTasksDisplayMode] = useState<'markdown' | 'raw'>('markdown');
  const [tasksMarkdownTab, setTasksMarkdownTab] = useState<'runner' | 'orchestrator'>('runner');
  const [atomizeStatus, setAtomizeStatus] = useState<AtomizeStatus | null>(null);
  const [atomizeBatchSizeText, setAtomizeBatchSizeText] = useState('3');
  const [atomizeAutoContinue, setAtomizeAutoContinue] = useState(true);
  const [reports, setReports] = useState<SpecReportSummary[]>([]);
  const [activeReportRunId, setActiveReportRunId] = useState('');
  const [reportMarkdown, setReportMarkdown] = useState('');
  const [reportScoreStatus, setReportScoreStatus] = useState<ReportScoreJobStatus | null>(null);
  const [tasksIterateStatus, setTasksIterateStatus] = useState<TasksIterateJobStatus | null>(null);
  const [userReportScoreText, setUserReportScoreText] = useState('');
  const [userReportCommentText, setUserReportCommentText] = useState('');
  const [iterateUserNoteText, setIterateUserNoteText] = useState('');
  const [atomicTaskStartDialog, setAtomicTaskStartDialog] = useState<{
    taskId: string;
    mode: 'new-codex' | 'new-claude' | 'existing';
    selectedTerminalId: string;
    terminals: AssignableCliTerminal[];
    submitting: boolean;
    error: string | null;
  } | null>(null);
  const atomizePrevRef = useRef<{
    specName: string | null;
    running: boolean;
  } | null>(null);
  const reportScoreRunningPrevRef = useRef(false);
  const tasksIterateRunningPrevRef = useRef(false);
  const baselineContentRef = useRef<Record<SpecArtifact, string>>({
    requirements: '',
    design: '',
    tasks: '',
  });
  const historyRef = useRef<
    Record<SpecArtifact, { undo: string[]; redo: string[] }>
  >({
    requirements: { undo: [], redo: [] },
    design: { undo: [], redo: [] },
    tasks: { undo: [], redo: [] },
  });
  const isApplyingHistoryRef = useRef(false);
  const [historyState, setHistoryState] = useState<
    Record<SpecArtifact, { undo: number; redo: number }>
  >({
    requirements: { undo: 0, redo: 0 },
    design: { undo: 0, redo: 0 },
    tasks: { undo: 0, redo: 0 },
  });
  const [clarifications, setClarifications] = useState<ClarificationQuestion[]>([]);
  const [techStackClarifications, setTechStackClarifications] = useState<ClarificationQuestion[]>([]);
  const [promptConfig, setPromptConfig] = useState<PromptConfigResponse | null>(null);
  const [promptDraft, setPromptDraft] = useState<PromptConfig | null>(null);
  const [promptPresetToApply, setPromptPresetToApply] = useState('');
  const [llm, setLlm] = useState<LlmInfo | null>(null);
  const [modelPing, setModelPing] = useState<
    Record<
      string,
      { status: 'pending' | 'ok' | 'error' | 'unstable' | 'unsupported'; latencyMs?: number; error?: string }
    >
  >({});
  const [showLlmConfig, setShowLlmConfig] = useState(false);
  const [llmConfigUnlocked, setLlmConfigUnlocked] = useState(false);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, { baseUrl: string; apiKey: string }>>({});
  const [cliTools, setCliTools] = useState<CliToolInfo[]>([]);
  const [cliToolsLoading, setCliToolsLoading] = useState(false);
  const [cliToolsError, setCliToolsError] = useState<string | null>(null);
  const [cliConfigOpen, setCliConfigOpen] = useState(false);
  const [cliToolEditorOpen, setCliToolEditorOpen] = useState(false);
  const [cliToolEditingId, setCliToolEditingId] = useState<string | null>(null);
  const [cliToolSaving, setCliToolSaving] = useState(false);
  const [cliToolDraft, setCliToolDraft] = useState<CliToolDraft>({
    id: '',
    label: '',
    command: '',
    argsText: '',
    baseUrl: '',
    baseUrlEnvKey: '',
    apiKey: '',
    apiKeyEnvKey: '',
    envText: '',
    clearApiKey: false,
  });
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const busyStartedAtRef = useRef<number | null>(null);
  const [busySeconds, setBusySeconds] = useState(0);
  const [busyProgress, setBusyProgress] = useState<number | null>(null);
  const [busyEtaSeconds, setBusyEtaSeconds] = useState<number | null>(null);
  const [busyDetail, setBusyDetail] = useState<string | null>(null);
  const [streamStage, setStreamStage] = useState<string | null>(null);
  const streamStageRef = useRef<string | null>(null);
  const [streamEtaSeconds, setStreamEtaSeconds] = useState<number | null>(null);
  const [streamProgress, setStreamProgress] = useState<number | null>(null);
  const stageStatsRef = useRef<Record<string, { durationsMs: number[]; outputChars: number[] }>>({});
  const stageRunRef = useRef<{ stage: string | null; startedMs: number | null; outputChars: number }>({
    stage: null,
    startedMs: null,
    outputChars: 0,
  });
  const streamArtifactRef = useRef<SpecArtifact | null>(null);
  const streamTextRef = useRef('');
  const streamFlushTimerRef = useRef<number | null>(null);
  const [animatedDisplayHead, setAnimatedDisplayHead] = useState('');
  const [animatedDisplayTail, setAnimatedDisplayTail] = useState('');
  const typewriterRef = useRef<{
    target: string;
    lastTarget: string;
    resolvedLen: number;
    phase: number;
    startedAtMs: number | null;
  }>({ target: '', lastTarget: '', resolvedLen: 0, phase: 0, startedAtMs: null });
  const typewriterTimerRef = useRef<number | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: 'error' | 'info' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const clarifSaveTimerRef = useRef<number | null>(null);

  const resetStreamPreview = useCallback(() => {
    if (streamFlushTimerRef.current) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    streamStageRef.current = null;
    streamArtifactRef.current = null;
    streamTextRef.current = '';
    setStreamStage(null);
  }, []);

  const stageToArtifact = useCallback((stage: string | null): SpecArtifact | null => {
    if (stage === 'requirements') return 'requirements';
    if (stage === 'design') return 'design';
    if (stage === 'tasks') return 'tasks';
    return null;
  }, []);

  const flushStreamToArtifact = useCallback(() => {
    if (streamFlushTimerRef.current) return;
    streamFlushTimerRef.current = window.setTimeout(() => {
      streamFlushTimerRef.current = null;
      const artifact = streamArtifactRef.current;
      if (!artifact) return;
      setArtifactContent((prev) => ({ ...prev, [artifact]: streamTextRef.current }));
    }, 60);
  }, []);

  const handleNdjsonEvent = useCallback(
    (evt: any) => {
      if (!evt || typeof evt !== 'object') return;
      if (evt.type === 'stage') {
        const stage = typeof evt.stage === 'string' ? evt.stage : null;
        const state = typeof evt.state === 'string' ? evt.state : null;
        if (!stage) return;
        streamStageRef.current = stage;
        setStreamStage(stage);
        const artifact = stageToArtifact(stage);
        if (artifact) {
          streamArtifactRef.current = artifact;
          setActiveArtifact(artifact);
          if (artifact === 'tasks') setTaskView('tasks');
        }
        if (state === 'start') {
          stageRunRef.current = { stage, startedMs: Date.now(), outputChars: 0 };
          streamTextRef.current = '';
          if (artifact) {
            setArtifactContent((prev) => ({ ...prev, [artifact]: '' }));
          }
          setStreamEtaSeconds(null);
          setStreamProgress(null);
        }
        if (state === 'end') {
          const run = stageRunRef.current;
          if (run.stage === stage && run.startedMs) {
            const durationMs = Math.max(0, Date.now() - run.startedMs);
            const stats = stageStatsRef.current[stage] ?? { durationsMs: [], outputChars: [] };
            stats.durationsMs.push(durationMs);
            stats.outputChars.push(Math.max(0, run.outputChars));
            if (stats.durationsMs.length > 12) stats.durationsMs.shift();
            if (stats.outputChars.length > 12) stats.outputChars.shift();
            stageStatsRef.current[stage] = stats;
          }
        }
        return;
      }
      if (evt.type === 'delta') {
        const stage = typeof evt.stage === 'string' ? evt.stage : streamStageRef.current;
        const delta = typeof evt.delta === 'string' ? evt.delta : '';
        if (!delta) return;
        const artifact = stageToArtifact(stage);
        if (!artifact) return;
        if (artifact !== streamArtifactRef.current) {
          streamArtifactRef.current = artifact;
          streamStageRef.current = stage;
          setStreamStage(stage);
          streamTextRef.current = '';
          setActiveArtifact(artifact);
          if (artifact === 'tasks') setTaskView('tasks');
        }
        streamTextRef.current += delta;
        if (stageRunRef.current.stage === stage) {
          stageRunRef.current.outputChars += delta.length;
        }
        flushStreamToArtifact();
      }
    },
    [flushStreamToArtifact, stageToArtifact],
  );

  const showToast = useCallback((message: string, tone: 'error' | 'info' = 'error') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4500);
  }, []);

  const selectedSpec = useMemo(
    () => specs.find((s) => s.name === selectedSpecName) ?? null,
    [specs, selectedSpecName],
  );
  const canOpenDesign = Boolean(
    selectedSpecName && (selectedSpec?.files?.design || selectedSpec?.status?.requirementsConfirmed),
  );
  const canOpenTasks = Boolean(
    selectedSpecName && (selectedSpec?.files?.tasks || selectedSpec?.status?.designConfirmed),
  );
  const canOpenDesignEffective = canOpenDesign || streamStage === 'design';
  const canOpenTasksEffective = canOpenTasks || streamStage === 'tasks';
  const lastError = selectedSpec?.status?.lastError ?? null;
  const activeReport = useMemo(() => {
    if (activeReportRunId) {
      return reports.find((r) => r.runId === activeReportRunId) ?? null;
    }
    return reports.length ? reports[0] : null;
  }, [activeReportRunId, reports]);

  const refreshSpecs = useCallback(async () => {
    const data = await apiJson<{ specs: SpecSummary[] }>('/specs');
    setSpecs(data.specs ?? []);
  }, []);

  const refreshReports = useCallback(async (specName: string) => {
    const data = await apiJson<{ reports: SpecReportSummary[] }>(
      `/specs/${encodeURIComponent(specName)}/reports`,
    );
    const nextReports = data.reports ?? [];
    setReports(nextReports);
    setActiveReportRunId((prev) => {
      if (prev && nextReports.some((r) => r.runId === prev)) return prev;
      return nextReports[0]?.runId ?? '';
    });
    return nextReports;
  }, []);

  const fetchReportScoreStatus = useCallback(async (specName: string, runId: string) => {
    const data = await apiJson<ReportScoreJobStatus>(
      `/specs/${encodeURIComponent(specName)}/reports/${encodeURIComponent(runId)}/score`,
    );
    setReportScoreStatus(data);
    return data;
  }, []);

  const fetchTasksIterateStatus = useCallback(async (specName: string, runId: string) => {
    const data = await apiJson<TasksIterateJobStatus>(
      `/specs/${encodeURIComponent(specName)}/reports/${encodeURIComponent(runId)}/tasks-iterate`,
    );
    setTasksIterateStatus(data);
    return data;
  }, []);

  const loadReportMarkdown = useCallback(async (specName: string, runId: string) => {
    const data = await apiJson<{ reportPath: string | null; content: string }>(
      `/specs/${encodeURIComponent(specName)}/reports/${encodeURIComponent(runId)}/markdown`,
    );
    setReportMarkdown(data.content ?? '');
    return data;
  }, []);

  const startReportScoreJob = useCallback(async (specName: string, runId: string, force = false) => {
    const data = await apiJson<ReportScoreJobStatus>(
      `/specs/${encodeURIComponent(specName)}/reports/${encodeURIComponent(runId)}/score`,
      {
        method: 'POST',
        body: JSON.stringify({ force }),
      },
      TASK_TIMEOUT_MS,
    );
    setReportScoreStatus(data);
    return data;
  }, []);

  const startTasksIterateJob = useCallback(
    async (specName: string, runId: string, userNote: string) => {
      const data = await apiJson<TasksIterateJobStatus>(
        `/specs/${encodeURIComponent(specName)}/reports/${encodeURIComponent(runId)}/tasks-iterate`,
        {
          method: 'POST',
          body: JSON.stringify({ userNote }),
        },
        TASK_TIMEOUT_MS,
      );
      setTasksIterateStatus(data);
      return data;
    },
    [],
  );

  const submitUserReportRating = useCallback(async () => {
    if (!selectedSpecName || !activeReportRunId) return;
    const score = Number.parseInt(userReportScoreText, 10);
    if (!Number.isFinite(score) || Number.isNaN(score) || score < 0 || score > 100) {
      showToast('评分需为 0-100 的整数');
      return;
    }
    try {
      await apiJson<{ ok: boolean; userRatings: ReportUserRating[] }>(
        `/specs/${encodeURIComponent(selectedSpecName)}/reports/${encodeURIComponent(activeReportRunId)}/user-score`,
        {
          method: 'POST',
          body: JSON.stringify({ score, comment: userReportCommentText }),
        },
      );
      showToast('已提交用户评分', 'info');
      setUserReportScoreText('');
      setUserReportCommentText('');
      void refreshReports(selectedSpecName).catch((e) => showToast(humanizeError(e)));
      if (reportMarkdown.trim()) {
        void loadReportMarkdown(selectedSpecName, activeReportRunId).catch((e) =>
          showToast(humanizeError(e)),
        );
      }
    } catch (error: any) {
      showToast(humanizeError(error));
    }
  }, [
    activeReportRunId,
    loadReportMarkdown,
    refreshReports,
    reportMarkdown,
    selectedSpecName,
    showToast,
    userReportCommentText,
    userReportScoreText,
  ]);

  const refreshLlm = useCallback(async () => {
    const data = await apiJson<LlmInfo>('/llm');
    setLlm(data);
    const drafts: Record<string, { baseUrl: string; apiKey: string }> = {};
    for (const p of data.providers ?? []) {
      drafts[p.id] = { baseUrl: p.baseUrl ?? '', apiKey: '' };
    }
    setProviderDrafts(drafts);

    const opts = data.options ?? [];
    if (opts.length) {
      setModelPing((prev) => {
        const next = { ...prev };
        for (const opt of opts) {
          next[opt.id] = { status: 'pending' };
        }
        return next;
      });
      void Promise.all(
        opts.map(async (opt) => {
          try {
            const result = await apiJson<LlmPingResult>(
              `/llm/ping?model=${encodeURIComponent(opt.id)}`,
            );
            if (result.ok) {
              setModelPing((prev) => ({
                ...prev,
                [opt.id]: { status: 'ok', latencyMs: result.latencyMs ?? 0 },
              }));
            } else {
              const errorText = String(result.error || '');
              const isConfigError = /Missing baseUrl|apiKey|LLM config missing|base_url invalid|Unsupported model/i.test(errorText);
              setModelPing((prev) => ({
                ...prev,
                [opt.id]: { status: isConfigError ? 'error' : 'unstable', error: result.error || '错误' },
              }));
            }
          } catch (e: any) {
            if (e?.status === 404) {
              setModelPing((prev) => ({
                ...prev,
                [opt.id]: { status: 'unsupported' },
              }));
              return;
            }
            setModelPing((prev) => ({
              ...prev,
              [opt.id]: { status: 'unstable', error: String(e?.message || e) },
            }));
          }
        }),
      );
    }
  }, []);

  const refreshCliTools = useCallback(async () => {
    setCliToolsLoading(true);
    setCliToolsError(null);
    try {
      const data = await apiJson<{ tools?: CliToolInfo[] }>('/cli-tools');
      setCliTools(Array.isArray(data.tools) ? data.tools : []);
      return data;
    } catch (e: any) {
      const message = humanizeError(e);
      setCliToolsError(message);
      throw e;
    } finally {
      setCliToolsLoading(false);
    }
  }, []);

  const openCliToolEditor = useCallback((tool?: CliToolInfo) => {
    if (tool) {
      setCliToolEditingId(tool.id);
      setCliToolDraft({
        id: tool.id,
        label: tool.label ?? '',
        command: tool.command ?? '',
        argsText: cliArgsToText(tool.args),
        baseUrl: tool.baseUrl ?? '',
        baseUrlEnvKey: tool.baseUrlEnvKey ?? '',
        apiKey: '',
        apiKeyEnvKey: tool.apiKeyEnvKey ?? '',
        envText: cliEnvToText(tool.env),
        clearApiKey: false,
      });
    } else {
      setCliToolEditingId(null);
      setCliToolDraft({
        id: '',
        label: '',
        command: '',
        argsText: '',
        baseUrl: '',
        baseUrlEnvKey: '',
        apiKey: '',
        apiKeyEnvKey: '',
        envText: '',
        clearApiKey: false,
      });
    }
    setCliToolEditorOpen(true);
  }, []);

  const cancelCliToolEditor = useCallback(() => {
    setCliToolEditorOpen(false);
    setCliToolEditingId(null);
    setCliToolSaving(false);
    setCliToolDraft({
      id: '',
      label: '',
      command: '',
      argsText: '',
      baseUrl: '',
      baseUrlEnvKey: '',
      apiKey: '',
      apiKeyEnvKey: '',
      envText: '',
      clearApiKey: false,
    });
  }, []);

  const saveCliTool = useCallback(async () => {
    const draft = cliToolDraft;
    const payload: any = {
      label: draft.label.trim(),
      command: draft.command.trim(),
      args: cliTextToArgs(draft.argsText),
      baseUrl: draft.baseUrl.trim(),
      baseUrlEnvKey: draft.baseUrlEnvKey.trim(),
      apiKeyEnvKey: draft.apiKeyEnvKey.trim(),
      env: cliTextToEnv(draft.envText),
      clearApiKey: Boolean(draft.clearApiKey),
    };
    if (!cliToolEditingId && draft.id.trim()) payload.id = draft.id.trim();
    if (draft.apiKey.trim()) payload.apiKey = draft.apiKey;

    if (!payload.label) {
      showToast('请填写 CLI 工具 label');
      return;
    }
    if (!payload.command) {
      showToast('请填写 CLI 工具 command');
      return;
    }

    setToast(null);
    setCliToolSaving(true);
    try {
      if (cliToolEditingId) {
        await apiJson<{ ok: boolean; tool?: CliToolInfo }>(
          `/cli-tools/${encodeURIComponent(cliToolEditingId)}`,
          { method: 'PUT', body: JSON.stringify(payload) },
        );
      } else {
        await apiJson<{ ok: boolean; tool?: CliToolInfo }>('/cli-tools', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      showToast(cliToolEditingId ? 'CLI 工具已更新' : 'CLI 工具已新增', 'info');
      cancelCliToolEditor();
      void refreshCliTools().catch((e) => showToast(humanizeError(e)));
    } catch (e: any) {
      showToast(humanizeError(e));
    } finally {
      setCliToolSaving(false);
    }
  }, [cancelCliToolEditor, cliToolDraft, cliToolEditingId, refreshCliTools, showToast]);

  const deleteCliTool = useCallback(async (id: string) => {
    const toolId = String(id || '').trim();
    if (!toolId) return;
    if (!window.confirm(`确认删除 CLI 工具：${toolId} ？`)) return;
    setToast(null);
    try {
      await apiJson<{ ok: boolean }>(`/cli-tools/${encodeURIComponent(toolId)}`, { method: 'DELETE' });
      showToast('CLI 工具已删除', 'info');
      void refreshCliTools().catch((e) => showToast(humanizeError(e)));
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [refreshCliTools, showToast]);

  const resetCliToolsToDefault = useCallback(async () => {
    if (!window.confirm('确认将 CLI 工具还原为初始值（清空自定义配置）？')) return;
    setToast(null);
    try {
      await apiJson<{ ok: boolean; tools?: CliToolInfo[] }>('/cli-tools/reset', { method: 'POST' });
      showToast('CLI 工具已还原为初始值', 'info');
      cancelCliToolEditor();
      void refreshCliTools().catch((e) => showToast(humanizeError(e)));
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [cancelCliToolEditor, refreshCliTools, showToast]);

  const openCliConfig = useCallback(() => {
    const open = () => {
      setCliConfigOpen(true);
      void refreshCliTools().catch((e) => showToast(humanizeError(e)));
    };

    if (llmConfigUnlocked) {
      open();
      return;
    }

    const input = window.prompt('请输入密码以打开 CLI 配置');
    if (input === '159753') {
      setLlmConfigUnlocked(true);
      open();
      return;
    }
    if (input !== null) {
      showToast('密码错误');
    }
  }, [llmConfigUnlocked, refreshCliTools, showToast]);

  const closeCliConfig = useCallback(() => {
    setCliConfigOpen(false);
    cancelCliToolEditor();
  }, [cancelCliToolEditor]);

  const refreshPrompts = useCallback(async () => {
    const data = await apiJson<PromptConfigResponse>('/prompts');
    setPromptConfig(data);
    setPromptDraft(data.current ?? null);
    setPromptPresetToApply('');
  }, []);

  const savePromptDraftToServer = useCallback(async () => {
    if (!promptDraft) return;
    setToast(null);
    try {
      const data = await apiJson<PromptConfigResponse>('/prompts', {
        method: 'POST',
        body: JSON.stringify({ config: promptDraft }),
      });
      setPromptConfig(data);
      setPromptDraft(data.current ?? null);
      showToast('提示词已保存', 'info');
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [promptDraft, showToast]);

  const resetPromptDraftToDefault = useCallback(async () => {
    setToast(null);
    try {
      const data = await apiJson<PromptConfigResponse>('/prompts/reset', { method: 'POST' });
      setPromptConfig(data);
      setPromptDraft(data.current ?? null);
      setPromptPresetToApply('');
      showToast('提示词已还原为默认配置', 'info');
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [showToast]);

  const savePromptPreset = useCallback(async () => {
    if (!promptDraft) return;
    const name = window.prompt('存档名称（用于以后快速切换）');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('存档名称不能为空');
      return;
    }
    setToast(null);
    try {
      const data = await apiJson<PromptConfigResponse>('/prompts/presets', {
        method: 'POST',
        body: JSON.stringify({ name: trimmed, config: promptDraft }),
      });
      setPromptConfig(data);
      showToast('存档已保存', 'info');
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [promptDraft, showToast]);

  const applyPromptPreset = useCallback(async () => {
    const name = promptPresetToApply.trim();
    if (!name) return;
    setToast(null);
    try {
      const data = await apiJson<PromptConfigResponse>('/prompts/presets/apply', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setPromptConfig(data);
      setPromptDraft(data.current ?? null);
      showToast('存档已应用', 'info');
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [promptPresetToApply, showToast]);

  const loadArtifact = useCallback(
    async (specName: string, artifact: SpecArtifact) => {
      try {
        const data = await apiJson<{ content: string }>(
          `/specs/${encodeURIComponent(specName)}/${artifact}`,
        );
        const next = data.content ?? '';
        baselineContentRef.current[artifact] = next;
        historyRef.current[artifact] = { undo: [], redo: [] };
        setHistoryState((prev) => ({
          ...prev,
          [artifact]: { undo: 0, redo: 0 },
        }));
        setArtifactContent((prev) => ({ ...prev, [artifact]: next }));
      } catch (e: any) {
        const message = String(e?.message || e);
        if (e?.status === 404 && /Spec file not found/i.test(message)) {
          baselineContentRef.current[artifact] = '';
          historyRef.current[artifact] = { undo: [], redo: [] };
          setHistoryState((prev) => ({
            ...prev,
            [artifact]: { undo: 0, redo: 0 },
          }));
          setArtifactContent((prev) => ({ ...prev, [artifact]: '' }));
          return;
        }
        throw e;
      }
    },
    [],
  );

  const loadTasksAtomic = useCallback(async (specName: string) => {
    try {
      const data = await apiJson<{ content: string }>(
        `/specs/${encodeURIComponent(specName)}/tasks_atomic`,
      );
      setTasksAtomicContent(data.content ?? '');
    } catch (e: any) {
      const message = String(e?.message || e);
      if (e?.status === 404 && /Spec file not found/i.test(message)) {
        setTasksAtomicContent('');
        return;
      }
      throw e;
    }
  }, []);

  const fetchAtomizeStatus = useCallback(async (specName: string) => {
    const data = await apiJson<AtomizeStatus>(
      `/specs/${encodeURIComponent(specName)}/tasks/atomize`,
    );
    setAtomizeStatus(data);
    return data;
  }, []);

  useEffect(() => {
    void refreshSpecs().catch((e) => showToast(humanizeError(e)));
    void refreshLlm().catch((e) => showToast(humanizeError(e)));
    void refreshPrompts().catch((e) => showToast(humanizeError(e)));
    void refreshCliTools().catch((e) => showToast(humanizeError(e)));
  }, [refreshCliTools, refreshLlm, refreshPrompts, refreshSpecs, showToast]);

  useEffect(() => {
    if (!busyLabel) {
      busyStartedAtRef.current = null;
      setBusySeconds(0);
      setBusyProgress(null);
      setBusyEtaSeconds(null);
      setBusyDetail(null);
      setStreamEtaSeconds(null);
      setStreamProgress(null);
      return;
    }

    if (!busyStartedAtRef.current) {
      busyStartedAtRef.current = Date.now();
      setBusySeconds(0);
      setBusyProgress(null);
      setBusyEtaSeconds(null);
      setBusyDetail(null);
    }

    const t = window.setInterval(() => {
      const startedAt = busyStartedAtRef.current ?? Date.now();
      setBusySeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 300);

    return () => window.clearInterval(t);
  }, [busyLabel]);

  useEffect(() => {
    if (!busyLabel) return;
    const timer = window.setInterval(() => {
      const stage = streamStageRef.current;
      if (!stage) {
        setStreamEtaSeconds(null);
        setStreamProgress(null);
        return;
      }
      const run = stageRunRef.current;
      const startedMs =
        run.stage === stage && typeof run.startedMs === 'number' ? run.startedMs : null;
      if (!startedMs) {
        setStreamEtaSeconds(null);
        setStreamProgress(null);
        return;
      }
      const elapsedMs = Math.max(0, Date.now() - startedMs);
      const stats = stageStatsRef.current[stage] ?? null;
      const avgDurationMs =
        averageNumber(stats?.durationsMs ?? []) ??
        (stage === 'requirements'
          ? 25000
          : stage === 'requirementsClarifications'
            ? 15000
            : stage === 'design'
              ? 35000
              : stage === 'tasks'
                ? 45000
                : null);
      const avgChars =
        averageNumber(stats?.outputChars ?? []) ??
        (stage === 'requirements'
          ? 2500
          : stage === 'requirementsClarifications'
            ? 1400
            : stage === 'design'
              ? 4500
              : stage === 'tasks'
                ? 7000
                : null);

      const etaFromTimeMs = avgDurationMs != null ? avgDurationMs - elapsedMs : null;
      const progressFromTime =
        avgDurationMs != null && avgDurationMs > 0 ? elapsedMs / avgDurationMs : null;

      const outputChars = Math.max(0, Number(run.outputChars) || 0);
      const speedCharsPerMs = outputChars > 0 && elapsedMs > 0 ? outputChars / elapsedMs : null;
      const etaFromCharsMs =
        avgChars != null && speedCharsPerMs != null && speedCharsPerMs > 0
          ? (avgChars - outputChars) / speedCharsPerMs
          : null;
      const progressFromChars = avgChars != null && avgChars > 0 ? outputChars / avgChars : null;

      let etaMs: number | null = null;
      if (etaFromTimeMs != null && Number.isFinite(etaFromTimeMs)) etaMs = etaFromTimeMs;
      if (etaFromCharsMs != null && Number.isFinite(etaFromCharsMs)) {
        const w = clampNumber(
          avgChars != null && avgChars > 0 ? outputChars / avgChars : 0,
          0,
          1,
        );
        if (etaMs == null) {
          etaMs = etaFromCharsMs;
        } else {
          etaMs = etaMs * (1 - w) + etaFromCharsMs * w;
        }
      }

      let progress: number | null = null;
      if (progressFromChars != null && Number.isFinite(progressFromChars) && outputChars > 0) {
        progress = progressFromChars;
      } else if (progressFromTime != null && Number.isFinite(progressFromTime)) {
        progress = progressFromTime;
      }

      setStreamEtaSeconds(
        etaMs == null || !Number.isFinite(etaMs) ? null : Math.max(0, Math.ceil(etaMs / 1000)),
      );
      setStreamProgress(
        progress == null || !Number.isFinite(progress)
          ? null
          : clampNumber(progress, 0, 0.99),
      );
    }, 250);
    return () => window.clearInterval(timer);
  }, [busyLabel]);

  useEffect(() => {
    if (!busyLabel) return;
    if (busyProgress == null) return;
    if (busyProgress <= 0 || busyProgress >= 1) {
      setBusyEtaSeconds(null);
      return;
    }
    const startedAt = busyStartedAtRef.current;
    if (!startedAt) return;
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return;
    const etaSeconds = elapsedSeconds * (1 / busyProgress - 1);
    if (!Number.isFinite(etaSeconds) || etaSeconds < 0) {
      setBusyEtaSeconds(null);
      return;
    }
    setBusyEtaSeconds(Math.ceil(etaSeconds));
  }, [busyLabel, busyProgress]);

  useEffect(() => {
    if (!selectedSpec) return;
    setClarifications(selectedSpec.status?.requirementsClarifications?.questions ?? []);
    setTechStackClarifications(selectedSpec.status?.techStackClarifications?.questions ?? []);
  }, [selectedSpec]);

  useEffect(() => {
    if (!selectedSpecName) return;
    if (activeArtifact === 'tasks' && !canOpenTasksEffective) {
      setActiveArtifact(canOpenDesignEffective ? 'design' : 'requirements');
      return;
    }
    if (activeArtifact === 'design' && !canOpenDesignEffective) {
      setActiveArtifact('requirements');
      return;
    }
    void loadArtifact(selectedSpecName, activeArtifact).catch((e) => showToast(humanizeError(e)));
  }, [
    activeArtifact,
    canOpenDesignEffective,
    canOpenTasksEffective,
    loadArtifact,
    selectedSpecName,
    showToast,
  ]);

  useEffect(() => {
    if (!selectedSpecName) {
      setReports([]);
      setActiveReportRunId('');
      setReportMarkdown('');
      setReportScoreStatus(null);
      setTasksIterateStatus(null);
      return;
    }
    void refreshReports(selectedSpecName).catch((e) => showToast(humanizeError(e)));
  }, [refreshReports, selectedSpecName, showToast]);

  useEffect(() => {
    if (!selectedSpecName || !activeReportRunId) {
      setReportScoreStatus(null);
      setTasksIterateStatus(null);
      return;
    }
    void fetchReportScoreStatus(selectedSpecName, activeReportRunId).catch((e) =>
      showToast(humanizeError(e)),
    );
  }, [activeReportRunId, fetchReportScoreStatus, selectedSpecName, showToast]);

  useEffect(() => {
    if (!selectedSpecName || !activeReportRunId) return;
    void fetchTasksIterateStatus(selectedSpecName, activeReportRunId).catch((e) =>
      showToast(humanizeError(e)),
    );
  }, [activeReportRunId, fetchTasksIterateStatus, selectedSpecName, showToast]);

  useEffect(() => {
    if (!selectedSpecName || !activeReportRunId) return;
    if (!reportScoreStatus?.running) return;
    const timer = window.setInterval(() => {
      void fetchReportScoreStatus(selectedSpecName, activeReportRunId).catch((e) =>
        showToast(humanizeError(e)),
      );
      void refreshReports(selectedSpecName).catch(() => null);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [
    activeReportRunId,
    fetchReportScoreStatus,
    refreshReports,
    reportScoreStatus?.running,
    selectedSpecName,
    showToast,
  ]);

  useEffect(() => {
    const prevRunning = reportScoreRunningPrevRef.current;
    const nowRunning = Boolean(reportScoreStatus?.running);
    reportScoreRunningPrevRef.current = nowRunning;
    if (!prevRunning || nowRunning) return;
    if (!selectedSpecName) return;
    void refreshReports(selectedSpecName).catch((e) => showToast(humanizeError(e)));
    if (activeReportRunId && reportMarkdown.trim()) {
      void loadReportMarkdown(selectedSpecName, activeReportRunId).catch((e) =>
        showToast(humanizeError(e)),
      );
    }
  }, [
    activeReportRunId,
    loadReportMarkdown,
    refreshReports,
    reportMarkdown,
    reportScoreStatus?.running,
    selectedSpecName,
    showToast,
  ]);

  useEffect(() => {
    if (!selectedSpecName || !activeReportRunId) return;
    if (!tasksIterateStatus?.running) return;
    const timer = window.setInterval(() => {
      void fetchTasksIterateStatus(selectedSpecName, activeReportRunId).catch((e) =>
        showToast(humanizeError(e)),
      );
      void refreshReports(selectedSpecName).catch(() => null);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [
    activeReportRunId,
    fetchTasksIterateStatus,
    refreshReports,
    selectedSpecName,
    showToast,
    tasksIterateStatus?.running,
  ]);

  useEffect(() => {
    const prevRunning = tasksIterateRunningPrevRef.current;
    const nowRunning = Boolean(tasksIterateStatus?.running);
    tasksIterateRunningPrevRef.current = nowRunning;
    if (!prevRunning || nowRunning) return;
    if (!selectedSpecName) return;

    if (tasksIterateStatus?.error) {
      showToast(tasksIterateStatus.error);
      return;
    }

    showToast('任务迭代完成', 'info');
    const outputRunId = (tasksIterateStatus?.outputRunId ?? '').trim();
    void refreshReports(selectedSpecName)
      .then((nextReports) => {
        if (outputRunId && nextReports.some((r) => r.runId === outputRunId)) {
          setActiveReportRunId(outputRunId);
        } else if (!activeReportRunId && nextReports.length) {
          setActiveReportRunId(nextReports[0]?.runId ?? '');
        }
        setReportMarkdown('');
      })
      .catch((e) => showToast(humanizeError(e)));
    void loadArtifact(selectedSpecName, 'tasks').catch((e) => showToast(humanizeError(e)));
  }, [
    activeReportRunId,
    fetchTasksIterateStatus,
    loadArtifact,
    refreshReports,
    selectedSpecName,
    showToast,
    tasksIterateStatus?.error,
    tasksIterateStatus?.outputRunId,
    tasksIterateStatus?.running,
  ]);

  useEffect(() => {
    if (!selectedSpecName) return;
    if (atomizeStatus?.running) return;
    if (!atomizeStatus?.total || atomizeStatus.completed < atomizeStatus.total) return;
    void refreshReports(selectedSpecName)
      .then((nextReports) => {
        const latestRunId = nextReports?.[0]?.runId ?? '';
        if (!latestRunId) return;
        setActiveReportRunId(latestRunId);
        setReportMarkdown('');
      })
      .catch((e) => showToast(humanizeError(e)));
  }, [
    atomizeStatus?.completed,
    atomizeStatus?.running,
    atomizeStatus?.total,
    refreshReports,
    selectedSpecName,
    showToast,
  ]);

  useEffect(() => {
    if (!selectedSpecName) return;
    void fetchAtomizeStatus(selectedSpecName).catch((e) => showToast(humanizeError(e)));
  }, [fetchAtomizeStatus, selectedSpecName, showToast]);

  useEffect(() => {
    if (!selectedSpecName) return;
    if (activeArtifact !== 'tasks' || taskView !== 'atomic') return;
    void loadTasksAtomic(selectedSpecName).catch((e) => showToast(humanizeError(e)));
  }, [activeArtifact, loadTasksAtomic, selectedSpecName, showToast, taskView]);

  useEffect(() => {
    if (!selectedSpecName) return;
    if (!atomizeStatus?.running) return;
    const timer = window.setInterval(() => {
      void fetchAtomizeStatus(selectedSpecName).catch((e) => showToast(humanizeError(e)));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [atomizeStatus?.running, fetchAtomizeStatus, selectedSpecName, showToast]);

  useEffect(() => {
    if (!selectedSpecName) return;
    if (atomizeStatus?.running) return;
    if (activeArtifact === 'tasks' && taskView === 'atomic') {
      void loadTasksAtomic(selectedSpecName).catch((e) => showToast(humanizeError(e)));
    }
  }, [activeArtifact, atomizeStatus?.running, loadTasksAtomic, selectedSpecName, showToast, taskView]);

  const createSpec = useCallback(async () => {
    setToast(null);
    setBusyLabel('生成中');
    resetStreamPreview();
    try {
      const data = await apiNdjsonStream<{ name: string }>(
        '/specs?stream=1',
        {
          method: 'POST',
          body: JSON.stringify({ prompt: rawPrompt }),
        },
        handleNdjsonEvent,
        TASK_TIMEOUT_MS,
      );
      await refreshSpecs();
      setSelectedSpecName(data.name);
      setActiveArtifact('requirements');
      await loadArtifact(data.name, 'requirements');
    } catch (e: any) {
      showToast(humanizeError(e));
      await refreshSpecs();
      const message = String(e?.message || e || '');
      if (message.includes('请求超时')) {
        window.setTimeout(() => {
          void refreshSpecs().catch(() => null);
        }, 6000);
      }
    } finally {
      resetStreamPreview();
      setBusyLabel(null);
    }
  }, [handleNdjsonEvent, loadArtifact, rawPrompt, refreshSpecs, resetStreamPreview, showToast]);

  const saveArtifact = useCallback(
    async (artifact: SpecArtifact, contentOverride?: string) => {
      if (!selectedSpecName) return;
      try {
        const content =
          typeof contentOverride === 'string'
            ? contentOverride
            : (artifactContent[artifact] ?? '');
        await apiJson(`/specs/${encodeURIComponent(selectedSpecName)}/${artifact}`, {
          method: 'POST',
          body: JSON.stringify({ content }),
        });
        await refreshSpecs();
      } catch (e: any) {
        showToast(humanizeError(e));
      }
    },
    [artifactContent, refreshSpecs, selectedSpecName, showToast],
  );

  const saveClarifications = useCallback(async () => {
    if (!selectedSpecName) return;
    try {
      await apiJson(`/specs/${encodeURIComponent(selectedSpecName)}/requirements/clarifications`, {
        method: 'POST',
        body: JSON.stringify({ questions: clarifications }),
      });
      await refreshSpecs();
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [clarifications, refreshSpecs, selectedSpecName, showToast]);

  const saveTechStackClarifications = useCallback(async () => {
    if (!selectedSpecName) return;
    try {
      await apiJson(`/specs/${encodeURIComponent(selectedSpecName)}/tech-stack/clarifications`, {
        method: 'POST',
        body: JSON.stringify({ questions: techStackClarifications }),
      });
      await refreshSpecs();
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [refreshSpecs, selectedSpecName, showToast, techStackClarifications]);

  const applyTechStackToDesign = useCallback(async () => {
    const next = upsertTechStackSection(artifactContent.design ?? '', techStackClarifications);
    setArtifactContent((prev) => ({ ...prev, design: next }));
    await saveArtifact('design', next);
  }, [artifactContent.design, saveArtifact, techStackClarifications]);

  const confirmRequirementsAndGenerateDesign = useCallback(async () => {
    if (!selectedSpecName) return;
    setToast(null);
    setBusyLabel('生成中');
    resetStreamPreview();
    try {
      if (!areClarificationsComplete(clarifications)) {
        throw new Error('请先完成所有必填的提问确认');
      }
      await saveClarifications();
      await apiNdjsonStream(
        `/specs/${encodeURIComponent(selectedSpecName)}/confirm?stream=1`,
        {
          method: 'POST',
          body: JSON.stringify({
            artifact: 'requirements',
            requirementsClarifications: { questions: clarifications },
          }),
        },
        handleNdjsonEvent,
        TASK_TIMEOUT_MS,
      );
      await refreshSpecs();
      await loadArtifact(selectedSpecName, 'design');
      setActiveArtifact('design');
    } catch (e: any) {
      showToast(humanizeError(e));
      await refreshSpecs();
    } finally {
      resetStreamPreview();
      setBusyLabel(null);
    }
  }, [
    clarifications,
    handleNdjsonEvent,
    loadArtifact,
    refreshSpecs,
    resetStreamPreview,
    saveClarifications,
    selectedSpecName,
    showToast,
  ]);

  const generateTasksFromDesign = useCallback(async (options?: { skipTechStack?: boolean }) => {
    if (!selectedSpecName) return;
    setToast(null);
    setBusyLabel('生成中');
    resetStreamPreview();
    try {
      const hasExistingTasks = Boolean(selectedSpec?.files?.tasks);
      if (hasExistingTasks) {
        const ok = window.confirm('将覆盖现有任务文档（tasks），是否继续？');
        if (!ok) return;
      }
      const skipTechStack =
        options?.skipTechStack === true ||
        selectedSpec?.status?.projectCategory === 'non_software';
      if (!skipTechStack) {
        if (!areClarificationsComplete(techStackClarifications)) {
          throw new Error('请先完成所有必填的技术栈确认');
        }
        await saveTechStackClarifications();
        await applyTechStackToDesign();
      }
      await apiNdjsonStream(
        `/specs/${encodeURIComponent(selectedSpecName)}/confirm?stream=1`,
        {
          method: 'POST',
          body: JSON.stringify({
            artifact: 'design',
            force: true,
            ...(skipTechStack ? { skipTechStack: true } : {}),
            ...(skipTechStack
              ? {}
              : { techStackClarifications: { questions: techStackClarifications } }),
          }),
        },
        handleNdjsonEvent,
        TASK_TIMEOUT_MS,
      );
      await refreshSpecs();
      await loadArtifact(selectedSpecName, 'tasks');
      setActiveArtifact('tasks');
      setTaskView('tasks');
    } catch (e: any) {
      showToast(humanizeError(e));
      await refreshSpecs();
      const message = String(e?.message || e || '');
      if (message.includes('请求超时')) {
        window.setTimeout(() => {
          void refreshSpecs().catch(() => null);
        }, 6000);
      }
    } finally {
      resetStreamPreview();
      setBusyLabel(null);
    }
  }, [
    applyTechStackToDesign,
    handleNdjsonEvent,
    loadArtifact,
    refreshSpecs,
    resetStreamPreview,
    saveTechStackClarifications,
    selectedSpec,
    selectedSpecName,
    techStackClarifications,
    showToast,
  ]);

  const startAtomizeTasks = useCallback(async (options?: { switchToAtomicView?: boolean }) => {
    if (!selectedSpecName) return;
    setToast(null);
    try {
      const switchToAtomicView = options?.switchToAtomicView !== false;
      if (switchToAtomicView) {
        setActiveArtifact('tasks');
        setTaskView('atomic');
      }
      const batchSize = Math.min(
        20,
        Math.max(1, Number.parseInt(atomizeBatchSizeText || '3', 10) || 3),
      );
      const data = await apiJson<AtomizeStatus>(
        `/specs/${encodeURIComponent(selectedSpecName)}/tasks/atomize`,
        { method: 'POST', body: JSON.stringify({ batchSize }) },
      );
      setAtomizeStatus(data);
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [atomizeBatchSizeText, selectedSpecName, showToast]);

  const openAtomicTaskStartDialog = useCallback(
    (taskId: string) => {
      if (!selectedSpecName) return;
      const normalizedTaskId = String(taskId || '').trim();
      if (!normalizedTaskId) return;
      const terminals = terminalPanelRef.current?.listAssignableCliTerminals?.() ?? [];
      setAtomicTaskStartDialog({
        taskId: normalizedTaskId,
        mode: 'new-codex',
        selectedTerminalId: terminals[0]?.id ?? '',
        terminals,
        submitting: false,
        error: null,
      });
    },
    [selectedSpecName],
  );

  const refreshAtomicTaskAssignableTerminals = useCallback(() => {
    const terminals = terminalPanelRef.current?.listAssignableCliTerminals?.() ?? [];
    setAtomicTaskStartDialog((prev) => {
      if (!prev) return prev;
      const stillExists = prev.selectedTerminalId
        ? terminals.some((t) => t.id === prev.selectedTerminalId)
        : false;
      return {
        ...prev,
        terminals,
        selectedTerminalId: stillExists ? prev.selectedTerminalId : terminals[0]?.id ?? '',
      };
    });
  }, []);

  const closeAtomicTaskStartDialog = useCallback(() => {
    setAtomicTaskStartDialog(null);
  }, []);

  const startAtomicTaskFromDialog = useCallback(async () => {
    if (!selectedSpecName || !atomicTaskStartDialog) return;
    const panel = terminalPanelRef.current;
    if (!panel) {
      showToast('终端面板未就绪');
      return;
    }

    const taskId = atomicTaskStartDialog.taskId;
    setAtomicTaskStartDialog((prev) => (prev ? { ...prev, submitting: true, error: null } : prev));
    setToast(null);

    try {
      if (atomicTaskStartDialog.mode === 'new-codex') {
        const result = await panel.startCodexAtomicTask(selectedSpecName, taskId);
        showToast(`Codex 已启动：${result.title}`, 'info');
        setAtomicTaskStartDialog(null);
        return;
      }

      const promptData = await apiJson<{ prompt?: string; error?: string }>(
        `/specs/${encodeURIComponent(selectedSpecName)}/tasks_atomic/prompt`,
        { method: 'POST', body: JSON.stringify({ taskId }) },
        20000,
      );
      if (promptData?.error) throw new Error(String(promptData.error));
      const prompt = String(promptData?.prompt || '').trim();
      if (!prompt) throw new Error('获取任务提示失败');

      let terminalId = atomicTaskStartDialog.selectedTerminalId;
      let title = '';
      if (atomicTaskStartDialog.mode === 'new-claude') {
        const created = await panel.createClaudeAutoTerminal();
        terminalId = created.terminalId;
        title = created.title;
      }

      if (!terminalId) throw new Error('请选择一个已开启的 CLI');

      await panel.sendTerminalInput(terminalId, `${prompt}\r`);
      panel.focusTerminal(terminalId);

      showToast(
        atomicTaskStartDialog.mode === 'existing'
          ? `已分配到终端：${terminalId}`
          : `已启动：${title || 'Claude Code'} · ${terminalId}`,
        'info',
      );
      setAtomicTaskStartDialog(null);
    } catch (e: any) {
      const message = humanizeError(e);
      setAtomicTaskStartDialog((prev) => (prev ? { ...prev, submitting: false, error: message } : prev));
      showToast(message);
    }
  }, [atomicTaskStartDialog, selectedSpecName, showToast]);

  const startIterateTasks = useCallback(async () => {
    if (!selectedSpecName || !activeReportRunId) return;
    setToast(null);
    try {
      setActiveArtifact('tasks');
      setTaskView('tasks');
      const data = await startTasksIterateJob(
        selectedSpecName,
        activeReportRunId,
        iterateUserNoteText,
      );
      showToast('已启动任务迭代（Opus 4.5）', 'info');
      return data;
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [activeReportRunId, iterateUserNoteText, selectedSpecName, showToast, startTasksIterateJob]);

  useEffect(() => {
    if (!selectedSpecName) {
      atomizePrevRef.current = null;
      return;
    }

    const prev = atomizePrevRef.current;
    const currentRunning = Boolean(atomizeStatus?.running);
    const currentCompleted = atomizeStatus?.completed ?? 0;
    const currentTotal = atomizeStatus?.total ?? 0;
    const currentError = atomizeStatus?.error ?? null;

    atomizePrevRef.current = { specName: selectedSpecName, running: currentRunning };

    if (!prev || prev.specName !== selectedSpecName) return;
    if (!atomizeAutoContinue) return;
    if (!prev.running || currentRunning) return;
    if (currentError) return;
    if (currentTotal > 0 && currentCompleted < currentTotal) {
      void startAtomizeTasks({ switchToAtomicView: false });
    }
  }, [atomizeAutoContinue, atomizeStatus, selectedSpecName, startAtomizeTasks]);

  useEffect(() => {
    if (!selectedSpecName) return;
    if (!atomizeStatus?.running) return;
    if (activeArtifact !== 'tasks' || taskView !== 'atomic') return;
    const timer = window.setInterval(() => {
      void loadTasksAtomic(selectedSpecName).catch(() => null);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeArtifact, atomizeStatus?.running, loadTasksAtomic, selectedSpecName, taskView]);

  const downloadCurrentMd = useCallback(() => {
    if (!selectedSpecName) return;
    const isAtomicView = ATOMIZE_ENABLED && activeArtifact === 'tasks' && taskView === 'atomic';
    const displayArtifact = activeArtifact;
    const content = isAtomicView
      ? tasksAtomicContent
      : artifactContent[activeArtifact] ?? '';
    const base = makeDownloadBaseName(selectedSpecName);
    downloadMarkdown(`${base}_${displayArtifact}.md`, content);
  }, [activeArtifact, artifactContent, selectedSpecName, taskView, tasksAtomicContent]);

  const downloadCurrentPng = useCallback(async () => {
    if (!selectedSpecName) return;
    setToast(null);
    setBusyLabel('生成中');
    setBusyProgress(0.05);
    setBusyDetail('渲染 PNG…');
    try {
      const isAtomicView = ATOMIZE_ENABLED && activeArtifact === 'tasks' && taskView === 'atomic';
      const displayArtifact = activeArtifact;
      const label = isAtomicView ? '任务原子化' : artifactLabel(activeArtifact);
      const title = `${selectedSpecName} / ${label}`;
      const content = isAtomicView
        ? tasksAtomicContent
        : artifactContent[activeArtifact] ?? '';
      const blob = await renderTextToPng(content, title);
      setBusyProgress(0.85);
      setBusyDetail('准备下载…');
      const base = makeDownloadBaseName(selectedSpecName);
      downloadBlob(`${base}_${displayArtifact}.png`, blob);
      setBusyProgress(1);
    } catch (e: any) {
      showToast(humanizeError(e));
    } finally {
      setBusyLabel(null);
    }
  }, [activeArtifact, artifactContent, selectedSpecName, taskView, tasksAtomicContent]);

  const downloadAllZip = useCallback(async () => {
    if (!selectedSpecName) return;
    setToast(null);
    setBusyLabel('生成中');
    setBusyProgress(0.02);
    setBusyDetail('准备打包…');
    try {
      const zip = new JSZip();
      const base = makeDownloadBaseName(selectedSpecName);
      const folder = zip.folder(base) ?? zip;

      let step = 0;
      const totalSteps = 12;
      const bump = (detail: string) => {
        step += 1;
        setBusyProgress(Math.min(0.99, step / totalSteps));
        setBusyDetail(detail);
      };
      folder.file(
        '使用说明.txt',
        [
          'planA 规范驱动开发 - 文档使用说明',
          '',
          '本压缩包包含 3 份核心文档（requirements/design/tasks），用于在 AI IDE 中执行“规范驱动开发（Spec-Driven Development）”。',
          '',
          '给 AI IDE 的执行指令：以 requirements/design/tasks 作为约束与上下文，按 tasks.md 的任务（模块级交付物）逐条实现与验收。',
          '如需调整范围/补充任务：先更新 tasks.md（TASKS_JSON），再继续执行。',
          '',
          '1) requirements.md（需求）',
          '- 用途：产品/业务需求的唯一事实来源（Source of Truth）。',
          '- 建议：补全背景、用户故事、验收标准；“需求确认”章节由提问确认的回答汇总生成，可按需继续补充。',
          '',
          '2) design.md（设计）',
          '- 用途：面向实现的技术方案与架构说明，指导代码组织、关键流程、边界与风险。',
          '- 建议：让 AI IDE 在编码前先阅读 design.md，确保实现方向一致。',
          '',
          '3) tasks.md（任务）',
          '- 用途：任务总览、范围约束与并发编排输入（任务粒度：模块级/交付物级，建议 ≤ 25）。',
          '- 工作方式：',
          '  a) tasks.md 的 TASKS_JSON 是编排输入（含 dependencies/scope/complexity）；',
          '  b) AI IDE 实施时按任务逐条交付，并将完成情况/关键变更回写到 tasks.md；',
          '  c) 如发现遗漏或范围变化，先更新 tasks.md（保持 TASKS_JSON 有效 JSON）再继续。',
          '',
          '推荐流程（类似 Kiro）：',
          '1. 写原始需求 → 生成提问确认问题',
          '2. 完成回答 → 生成 requirements.md',
          '3. 生成 design.md',
          '4. 从 design.md 生成 tasks.md（模块级任务 + DAG 依赖）',
          '5. 将 requirements/design/tasks 提供给你的 AI 编程工具/IDE，要求它：',
          '   - 以 requirements/design 作为约束与上下文',
          '   - 按 tasks.md（TASKS_JSON）的任务逐条执行并回写完成记录',
          '   - tasks.md 用于同步范围与里程碑；如需变更先改 tasks.md 再继续',
          '',
          '提示：当你要加功能或改需求时，先更新 requirements/design/tasks，再让 AI IDE 继续执行。',
          '',
        ].join('\n'),
      );
      bump('写入说明…');
      const artifacts: SpecArtifact[] = ['requirements', 'design', 'tasks'];
      for (const a of artifacts) {
        const title = `${selectedSpecName} / ${artifactLabel(a)}`;
        let content = artifactContent[a] ?? '';
        try {
          bump(`加载 ${a}.md…`);
          const latest = await apiJson<{ content: string }>(
            `/specs/${encodeURIComponent(selectedSpecName)}/${a}`,
          );
          content = latest.content ?? content;
          setArtifactContent((prev) => ({ ...prev, [a]: content }));
        } catch {
          // Ignore refresh failures and use local snapshot.
        }
        folder.file(`${a}.md`, content);
        bump(`渲染 ${a}.png…`);
        const png = await renderTextToPng(content, title);
        folder.file(`${a}.png`, png);
      }
      if (ATOMIZE_ENABLED) {
        try {
          bump('加载 tasks_atomic.md…');
          const latest = await apiJson<{ content: string }>(
            `/specs/${encodeURIComponent(selectedSpecName)}/tasks_atomic`,
          );
          const atomicContent = latest.content ?? '';
          if (atomicContent.trim()) {
            folder.file('tasks_atomic.md', atomicContent);
            const atomicTitle = `${selectedSpecName} / 任务原子化`;
            bump('渲染 tasks_atomic.png…');
            const png = await renderTextToPng(atomicContent, atomicTitle);
            folder.file('tasks_atomic.png', png);
          }
        } catch {
          // Ignore missing atomic tasks
        }
      }

      try {
        bump('加载流程报告…');
        let runId = (activeReportRunId ?? '').trim();
        if (!runId) {
          const reportList = await apiJson<{ reports: SpecReportSummary[] }>(
            `/specs/${encodeURIComponent(selectedSpecName)}/reports`,
          );
          runId = (reportList.reports?.[0]?.runId ?? '').trim();
        }
        if (runId) {
          const report = await apiJson<{ reportPath: string | null; content: string }>(
            `/specs/${encodeURIComponent(selectedSpecName)}/reports/${encodeURIComponent(runId)}/markdown`,
          );
          const reportContent = report.content ?? '';
          if (reportContent.trim()) {
            bump(`写入流程报告（${runId}）…`);
            const reportName =
              basenameFromAnyPath(report.reportPath ?? '') || `flow_report_${runId}.md`;
            folder.file(reportName, reportContent);
          }
        }
      } catch {
        // Ignore missing flow report
      }

      bump('打包 ZIP…');
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(`${base}_all.zip`, blob);
      setBusyProgress(1);
      setBusyDetail(null);
    } catch (e: any) {
      showToast(humanizeError(e));
    } finally {
      setBusyLabel(null);
    }
  }, [activeReportRunId, artifactContent, selectedSpecName]);

  const updateHistoryState = useCallback((artifact: SpecArtifact) => {
    const h = historyRef.current[artifact];
    setHistoryState((prev) => ({
      ...prev,
      [artifact]: { undo: h.undo.length, redo: h.redo.length },
    }));
  }, []);

  const undoEdit = useCallback(() => {
    const artifact = activeArtifact;
    const h = historyRef.current[artifact];
    if (!h.undo.length) return;
    const current = artifactContent[artifact] ?? '';
    const prevValue = h.undo.pop() ?? '';
    h.redo.push(current);
    isApplyingHistoryRef.current = true;
    setArtifactContent((prev) => ({ ...prev, [artifact]: prevValue }));
    updateHistoryState(artifact);
    if (selectedSpecName) {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => void saveArtifact(artifact), 250);
    }
    queueMicrotask(() => {
      isApplyingHistoryRef.current = false;
    });
  }, [activeArtifact, artifactContent, saveArtifact, selectedSpecName, updateHistoryState]);

  const redoEdit = useCallback(() => {
    const artifact = activeArtifact;
    const h = historyRef.current[artifact];
    if (!h.redo.length) return;
    const current = artifactContent[artifact] ?? '';
    const nextValue = h.redo.pop() ?? '';
    h.undo.push(current);
    isApplyingHistoryRef.current = true;
    setArtifactContent((prev) => ({ ...prev, [artifact]: nextValue }));
    updateHistoryState(artifact);
    if (selectedSpecName) {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => void saveArtifact(artifact), 250);
    }
    queueMicrotask(() => {
      isApplyingHistoryRef.current = false;
    });
  }, [activeArtifact, artifactContent, saveArtifact, selectedSpecName, updateHistoryState]);

  const resetToBaseline = useCallback(() => {
    const artifact = activeArtifact;
    const baseline = baselineContentRef.current[artifact] ?? '';
    const current = artifactContent[artifact] ?? '';
    if (current === baseline) return;
    const h = historyRef.current[artifact];
    h.undo.push(current);
    if (h.undo.length > 80) h.undo.shift();
    h.redo = [];
    isApplyingHistoryRef.current = true;
    setArtifactContent((prev) => ({ ...prev, [artifact]: baseline }));
    updateHistoryState(artifact);
    if (selectedSpecName) {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => void saveArtifact(artifact), 250);
    }
    queueMicrotask(() => {
      isApplyingHistoryRef.current = false;
    });
  }, [activeArtifact, artifactContent, saveArtifact, selectedSpecName, updateHistoryState]);

  const setModel = useCallback(async (model: string) => {
    setToast(null);
    try {
      const data = await apiJson<LlmInfo>('/llm/model', {
        method: 'POST',
        body: JSON.stringify({ model }),
      });
      setLlm(data);
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, []);

  const saveProvider = useCallback(
    async (providerId: string) => {
      setToast(null);
      try {
        const draft = providerDrafts[providerId] ?? { baseUrl: '', apiKey: '' };
        const payload: any = { providerId, baseUrl: draft.baseUrl };
        if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim();
        const data = await apiJson<LlmInfo>('/llm/provider', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setLlm(data);
        setProviderDrafts((prev) => ({
          ...prev,
          [providerId]: { baseUrl: draft.baseUrl, apiKey: '' },
        }));
        // Re-ping models after provider update.
        void refreshLlm();
      } catch (e: any) {
        showToast(humanizeError(e));
      }
    },
    [providerDrafts, refreshLlm],
  );

  const normalizeModelLabel = useCallback((label: string, id: string) => {
    const base = (label || id).trim();
    return base.replace(/\s*\([^)]*\)\s*$/, '');
  }, []);

  const modelOptionLabel = useCallback(
    (id: string, label: string) => {
      const base = normalizeModelLabel(label, id);
      const ping = modelPing[id];
      if (!ping || ping.status === 'unsupported') return base;
      if (ping.status === 'pending') return `${base} · ...`;
      if (ping.status === 'ok') return `${base} · ${Math.max(0, Math.round(ping.latencyMs ?? 0))}ms`;
      if (ping.status === 'unstable') return `${base} · 不稳定`;
      return `${base} · 错误`;
    },
    [modelPing, normalizeModelLabel],
  );

  const updatePromptStageField = useCallback(
    (stageKey: string, field: 'system' | 'user' | 'scenario', value: string) => {
    setPromptDraft((prev) => {
      if (!prev) return prev;
      const currentStage = prev.stages?.[stageKey];
      if (!currentStage) return prev;
      return {
        ...prev,
        stages: {
          ...prev.stages,
          [stageKey]: {
            ...currentStage,
            [field]: value,
          },
        },
      };
    });
  }, []);

  const updatePromptMetaField = useCallback((field: 'projectOverview', value: string) => {
    setPromptDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        meta: {
          ...(prev.meta ?? { projectOverview: '' }),
          [field]: value,
        },
      };
    });
  }, []);

  const activeModelId = llm?.model ?? '';
  const activePing = activeModelId ? modelPing[activeModelId] : null;
  const isAtomicView = ATOMIZE_ENABLED && activeArtifact === 'tasks' && taskView === 'atomic';
  const isNonSoftwareProject = selectedSpec?.status?.projectCategory === 'non_software';
  const displayContent = isAtomicView
    ? tasksAtomicContent
    : artifactContent[activeArtifact] ?? '';
  const shouldTypewriter =
    Boolean(streamStage) || (isAtomicView && Boolean(atomizeStatus?.running));
  const atomizeEtaSeconds = computeThroughputEtaSeconds({
    total: atomizeStatus?.total ?? 0,
    completed: atomizeStatus?.completed ?? 0,
    startedAt: atomizeStatus?.startedAt ?? null,
  });
  const reportScoreEtaSeconds = computeThroughputEtaSeconds({
    total: reportScoreStatus?.total ?? 0,
    completed: reportScoreStatus?.completed ?? 0,
    startedAt: reportScoreStatus?.startedAt ?? null,
  });
  const outputEtaSeconds =
    streamStage ? streamEtaSeconds : isAtomicView && atomizeStatus?.running ? atomizeEtaSeconds : null;
  const outputEtaText = formatDurationSeconds(outputEtaSeconds);
  const busyProgressEffective = busyProgress != null ? busyProgress : streamProgress;
  const busyEtaSecondsEffective = busyEtaSeconds != null ? busyEtaSeconds : streamEtaSeconds;
  const busyEtaText = formatDurationSeconds(busyEtaSecondsEffective);
  const outputText = shouldTypewriter
    ? `${animatedDisplayHead}${animatedDisplayTail}`
    : displayContent;

  const atomicTaskGroups = useMemo(
    () => parseTasksAtomicMarkdown(tasksAtomicContent),
    [tasksAtomicContent],
  );
  // MVP5: 原子任务行数组（用于依赖分析）
  const atomicTaskLines = useMemo(
    () => tasksAtomicContent.split('\n').filter(line => line.trim()),
    [tasksAtomicContent],
  );
  const terminalPanelRef = useRef<TerminalPanelHandle | null>(null);
  const tasksToolsDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const [tasksToolsOpen, setTasksToolsOpen] = useState(false);

  useEffect(() => {
    if (activeArtifact === 'tasks') setTasksToolsOpen(false);
  }, [activeArtifact]);
  const runPromptInClaudeAutoTerminal = useCallback(async (prompt: string) => {
    setTasksToolsOpen(true);
    window.requestAnimationFrame(() => {
      tasksToolsDetailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    const panel = terminalPanelRef.current;
    if (!panel) throw new Error('终端面板未就绪');
    const created = await panel.createClaudeAutoTerminal();
    await panel.sendTerminalInput(created.terminalId, `${prompt}\r`);
    panel.focusTerminal(created.terminalId);
    return created;
  }, []);

  const outputScrollRef = useRef<OutputScrollEl | null>(null);
  const outputLastScrollTopRef = useRef(0);
  const [outputAutoFollow, setOutputAutoFollow] = useState(true);
  const outputAutoFollowRef = useRef(true);
  useEffect(() => {
    outputAutoFollowRef.current = outputAutoFollow;
  }, [outputAutoFollow]);

  const handleOutputScroll = useCallback(() => {
    if (!shouldTypewriter) return;
    const el = outputScrollRef.current;
    if (!el) return;
    outputLastScrollTopRef.current = el.scrollTop;
    const distanceToBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    const nearBottom = distanceToBottom <= 120;
    if (!nearBottom && outputAutoFollowRef.current) setOutputAutoFollow(false);
    if (nearBottom && !outputAutoFollowRef.current) setOutputAutoFollow(true);
  }, [shouldTypewriter]);

  useEffect(() => {
    if (!shouldTypewriter) return;
    setOutputAutoFollow(true);
  }, [shouldTypewriter]);

  useEffect(() => {
    const el = outputScrollRef.current;
    if (!el) return;
    window.requestAnimationFrame(() => {
      const node = outputScrollRef.current;
      if (!node) return;
      if (outputAutoFollowRef.current) {
        node.scrollTop = node.scrollHeight;
        return;
      }
      node.scrollTop = Math.min(outputLastScrollTopRef.current, node.scrollHeight);
    });
  }, [shouldTypewriter]);

  useEffect(() => {
    if (!shouldTypewriter) return;
    if (!outputAutoFollowRef.current) return;
    const el = outputScrollRef.current;
    if (!el) return;
    window.requestAnimationFrame(() => {
      const node = outputScrollRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    });
  }, [outputText, shouldTypewriter]);

  const nextAction = useMemo(() => {
    if (busyLabel || shouldTypewriter) return null;

    if (!selectedSpecName) {
      return rawPrompt.trim() ? 'createSpec' : null;
    }

    if (activeArtifact === 'requirements') {
      if (
        !artifactContent.design.trim() &&
        clarifications.length &&
        areClarificationsComplete(clarifications)
      ) {
        return 'generateDesign';
      }
    }

    if (activeArtifact === 'design') {
      if (
        artifactContent.design.trim() &&
        !artifactContent.tasks.trim() &&
        (isNonSoftwareProject ||
          (techStackClarifications.length && areClarificationsComplete(techStackClarifications)))
      ) {
        return 'generateTasks';
      }
    }

    if (activeArtifact === 'tasks') {
      const hasTasks = Boolean(artifactContent.tasks.trim());
      const hasAtomic =
        Boolean(selectedSpec?.files?.tasks_atomic) || Boolean(tasksAtomicContent.trim());
      const atomizeIncomplete =
        Boolean(atomizeStatus?.total) && (atomizeStatus?.completed ?? 0) < (atomizeStatus?.total ?? 0);

      if (atomizeStatus?.running) return null;
      if (hasTasks && (!hasAtomic || atomizeIncomplete)) return 'startAtomize';
      if (hasTasks) return 'downloadZip';
    }

    return null;
  }, [
    activeArtifact,
    artifactContent.design,
    artifactContent.tasks,
    atomizeStatus?.running,
    atomizeStatus?.completed,
    atomizeStatus?.total,
    busyLabel,
    clarifications,
    rawPrompt,
    selectedSpec?.files?.tasks_atomic,
    selectedSpec?.status?.projectCategory,
    selectedSpecName,
    shouldTypewriter,
    tasksAtomicContent,
    techStackClarifications,
  ]);

  const guidedButtonClass =
    'ring-2 ring-green-400/80 shadow-lg shadow-green-500/25 animate-pulse';

  useEffect(() => {
    if (!shouldTypewriter) {
      typewriterRef.current.target = displayContent;
      typewriterRef.current.lastTarget = displayContent;
      typewriterRef.current.resolvedLen = displayContent.length;
      typewriterRef.current.phase = 0;
      typewriterRef.current.startedAtMs = null;
      setAnimatedDisplayHead(displayContent);
      setAnimatedDisplayTail('');
      return;
    }

    const prevTarget = typewriterRef.current.lastTarget;
    typewriterRef.current.target = displayContent;
    if (typewriterRef.current.startedAtMs == null) {
      typewriterRef.current.startedAtMs = Date.now();
    }

    if (prevTarget && !displayContent.startsWith(prevTarget)) {
      typewriterRef.current.resolvedLen = 0;
      typewriterRef.current.phase = 0;
      typewriterRef.current.startedAtMs = Date.now();
      setAnimatedDisplayHead('');
      setAnimatedDisplayTail('');
    }

    typewriterRef.current.resolvedLen = Math.min(
      typewriterRef.current.resolvedLen,
      displayContent.length,
    );
    typewriterRef.current.lastTarget = displayContent;
  }, [displayContent, shouldTypewriter]);

  useEffect(() => {
    if (!shouldTypewriter) {
      if (typewriterTimerRef.current) {
        window.clearInterval(typewriterTimerRef.current);
        typewriterTimerRef.current = null;
      }
      return;
    }
    if (typewriterTimerRef.current) return;
    const TICK_MS = 50;
    const SCRAMBLE_WINDOW = 72;
    const MAX_BUFFER_CHARS = 320;
    const START_DELAY_MS = 1200;

    const timer = window.setInterval(() => {
      const ref = typewriterRef.current;
      const target = ref.target || '';
      if (!target) {
        setAnimatedDisplayHead('');
        setAnimatedDisplayTail('');
        return;
      }

      const targetLen = target.length;
      const startedAtMs = ref.startedAtMs;
      const elapsedMs = startedAtMs ? Date.now() - startedAtMs : null;

      const holdBack = Math.min(
        MAX_BUFFER_CHARS,
        Math.max(0, targetLen - SCRAMBLE_WINDOW),
      );
      const maxResolvedLen = Math.max(0, targetLen - holdBack);

      let resolvedLen = Math.min(ref.resolvedLen, targetLen);
      if (elapsedMs != null && elapsedMs < START_DELAY_MS) {
        resolvedLen = Math.min(resolvedLen, 0);
      } else if (resolvedLen < maxResolvedLen) {
        const backlog = maxResolvedLen - resolvedLen;
        const cps = clampNumber(260 + backlog * 0.08, 220, 1300);
        const chunk = Math.max(1, Math.floor((cps * TICK_MS) / 1000));
        resolvedLen = Math.min(maxResolvedLen, resolvedLen + chunk);
      }

      ref.resolvedLen = resolvedLen;
      ref.phase = (ref.phase + 1) % 1000000;

      const scrambleStart = resolvedLen;
      const scrambleEnd = Math.min(targetLen, scrambleStart + SCRAMBLE_WINDOW);
      const head = target.slice(0, resolvedLen);
      const tail = target.slice(scrambleStart, scrambleEnd);
      const tailScrambled = tail ? matrixScrambleSegment(tail, ref.phase) : '';
      setAnimatedDisplayHead(head);
      setAnimatedDisplayTail(tailScrambled);
    }, TICK_MS);
    typewriterTimerRef.current = timer;
    return () => {
      window.clearInterval(timer);
      typewriterTimerRef.current = null;
    };
  }, [shouldTypewriter]);

  return (
    <div className="flex h-screen flex-col bg-surface text-slate-100">
      <div className="border-b border-slate-800 bg-panel px-6 py-3">
        <div className="mx-auto flex max-w-[1400px] flex-col items-center gap-1 text-center">
          <div className="text-lg font-semibold text-slate-100 md:text-xl">planA规范驱动V0.1</div>
          <a
            className="text-xs text-slate-400 underline underline-offset-4 hover:text-slate-200"
            href="https://github.com/weituo470/planA/issues"
            target="_blank"
            rel="noreferrer"
          >
            https://github.com/weituo470/planA/issues（欢迎留言）
          </a>
        </div>
      </div>
      <div className="min-h-0 flex flex-1">
        <div className="w-12 shrink-0 border-r border-slate-800 bg-slate-950/60">
          <div className="flex flex-col items-center gap-1 py-2">
            <button
              className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                explorerOpen
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-900/60 hover:text-slate-100'
              }`}
              onClick={() => setExplorerOpen((v) => !v)}
              title="Explorer"
              aria-label="Explorer"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 5.5h6l2 2H20a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" />
                <path d="M3 10h18" />
              </svg>
            </button>
          </div>
        </div>

        {explorerOpen ? (
          <ExplorerSidebar open onToggle={() => setExplorerOpen(false)} />
        ) : null}

        <main className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto grid max-w-[1400px] grid-cols-12 gap-4 px-6 py-6">
            {activeArtifact === 'requirements' ? (
              <section className="col-span-12 space-y-3 rounded-lg border border-slate-800 bg-panel p-4">
          <div className="text-sm font-semibold text-slate-200">原始需求</div>
          <textarea
            className="h-24 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent"
            value={rawPrompt}
            onChange={(e) => setRawPrompt(e.target.value)}
            placeholder="粘贴/输入需求描述，点击“生成提问确认”创建 Spec 并生成澄清问题。"
          />
            <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={createSpec}
              disabled={!rawPrompt.trim() || Boolean(busyLabel)}
              className={nextAction === 'createSpec' ? guidedButtonClass : ''}
            >
              生成提问确认
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-2 text-sm text-slate-300">
              <span>模型：</span>
              <select
                className="h-9 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                value={llm?.model ?? ''}
                onChange={(e) => void setModel(e.target.value)}
                disabled={Boolean(busyLabel) || !llm?.options?.length}
              >
                <option value="" disabled>
                  请选择
                </option>
                {(llm?.options ?? []).map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {modelOptionLabel(opt.id, opt.label)}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (showLlmConfig) {
                    setShowLlmConfig(false);
                    return;
                  }
                  if (llmConfigUnlocked) {
                    setShowLlmConfig(true);
                    return;
                  }
                  const input = window.prompt('请输入密码以展开模型配置');
                  if (input === '159753') {
                    setLlmConfigUnlocked(true);
                    setShowLlmConfig(true);
                    return;
                  }
                  if (input !== null) {
                    showToast('密码错误');
                  }
                }}
              >
                {showLlmConfig ? '收起模型配置' : '展开模型配置'}
              </Button>
              {activePing && activePing.status !== 'unsupported' && (
                <span
                  className={
                    activePing.status === 'ok'
                      ? 'text-xs text-green-400'
                      : activePing.status === 'error'
                        ? 'text-xs text-red-400'
                        : activePing.status === 'unstable'
                          ? 'text-xs text-amber-400'
                          : 'text-xs text-slate-400'
                  }
                >
                  {activePing.status === 'pending'
                    ? '检测中…'
                    : activePing.status === 'ok'
                      ? `连接 ${Math.max(0, Math.round(activePing.latencyMs ?? 0))}ms`
                      : activePing.status === 'unstable'
                        ? '连接不稳定'
                        : '连接错误'}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {(llm?.options ?? []).map((opt) => {
              const ping = modelPing[opt.id];
              if (!ping || ping.status === 'unsupported') return null;
              const label = normalizeModelLabel(opt.label, opt.id);
              const text =
                ping.status === 'pending'
                  ? '…'
                  : ping.status === 'ok'
                    ? `${Math.max(0, Math.round(ping.latencyMs ?? 0))}ms`
                    : ping.status === 'unstable'
                      ? '不稳定'
                      : '错误';
              const color =
                ping.status === 'ok'
                  ? 'text-green-400'
                  : ping.status === 'error'
                    ? 'text-red-400'
                    : ping.status === 'unstable'
                      ? 'text-amber-400'
                      : 'text-slate-400';
              return (
                <span key={opt.id} className="text-slate-400">
                  {label}{' '}
                  <span className={color}>
                    {text}
                  </span>
                </span>
              );
            })}
          </div>

          <details className="rounded-md border border-slate-800 bg-slate-900/30 p-3">
            <summary className="cursor-pointer select-none text-sm font-semibold text-slate-200">
              使用说明（点击展开）
            </summary>
              <div className="mt-2 space-y-3">
              <div className="text-xs text-slate-400">
                流程：原始需求 → 提问确认 → 用户回答 → 生成 requirements.md → 设计 → 技术栈确认 → 任务（TASKS_JSON）→ 任务编排（MVP5）→ 下载交付
              </div>

              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-200">
                <li>在“原始需求”输入内容，点“生成提问确认”创建 Spec。</li>
                <li>切到“需求”，完成“提问确认”，点“生成 requirements.md（并生成设计）”。</li>
                <li>切到“设计”，完成“技术栈确认”，点“确认技术栈并生成任务”。</li>
                <li>
                  切到“任务”，维护 tasks.md 的 TASKS_JSON（模块级任务 + dependencies），并按任务列表逐条执行（支持生成提示词并复制到剪贴板）。
                </li>
                <li>
                  需要交付给 AI IDE 时，点“一键下载（ZIP）”，按 tasks.md 的任务逐条开发，并在 tasks.md 回写关键变更与验证结果。
                </li>
              </ol>

              <div className="text-xs text-slate-400">
                默认地址：Bridge {BRIDGE_URL} · Dashboard 一般为 http://localhost:5174/
              </div>
            </div>
          </details>

          <details className="rounded-md border border-slate-800 bg-slate-900/30 p-3">
            <summary className="cursor-pointer select-none text-sm font-semibold text-slate-200">
              提示词配置（可手动修改/还原/存档）
            </summary>
            <div className="mt-2 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <div>
                  当前更新时间：
                  {promptConfig?.current?.updatedAt ? ` ${new Date(promptConfig.current.updatedAt).toLocaleString()}` : '（未知）'}
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void refreshPrompts().catch((e) => showToast(humanizeError(e)))}
                    disabled={Boolean(busyLabel)}
                  >
                    重新加载
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={resetPromptDraftToDefault}
                    disabled={Boolean(busyLabel)}
                  >
                    还原默认
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={savePromptPreset}
                    disabled={!promptDraft || Boolean(busyLabel)}
                  >
                    存档
                  </Button>
                  <Button
                    size="sm"
                    onClick={savePromptDraftToServer}
                    disabled={!promptDraft || Boolean(busyLabel)}
                  >
                    保存提示词
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="h-9 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                  value={promptPresetToApply}
                  onChange={(e) => setPromptPresetToApply(e.target.value)}
                  disabled={Boolean(busyLabel) || !(promptConfig?.presets?.length)}
                >
                  <option value="">选择存档以应用</option>
                  {(promptConfig?.presets ?? []).map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={applyPromptPreset}
                  disabled={Boolean(busyLabel) || !promptPresetToApply.trim()}
                >
                  应用存档
                </Button>
                {promptPresetToApply.trim() && (
                  <div className="text-xs text-slate-400">
                    {(() => {
                      const hit = (promptConfig?.presets ?? []).find((p) => p.name === promptPresetToApply.trim());
                      return hit?.savedAt ? `存档时间：${new Date(hit.savedAt).toLocaleString()}` : '';
                    })()}
                  </div>
                )}
              </div>

              {!promptDraft ? (
                <div className="text-xs text-slate-400">提示词配置加载中…</div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  <div className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
                    <div className="text-sm font-semibold text-slate-200">项目整体说明（与提示词相关）</div>
                    <div className="mt-2 text-xs text-slate-400">
                      该说明会随提示词一起保存到配置文件，用于让维护者快速理解每个 stage 的用途与约束。
                    </div>
                    <textarea
                      className="mt-2 h-28 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent"
                      value={promptDraft.meta?.projectOverview ?? ''}
                      onChange={(e) => updatePromptMetaField('projectOverview', e.target.value)}
                      placeholder="请输入与提示词相关的项目整体说明…"
                    />
                  </div>
                  {PROMPT_STAGE_ORDER.map(({ key, label }) => {
                    const stage = promptDraft.stages?.[key];
                    if (!stage) return null;
                    const vars = Array.isArray(stage.variables) ? stage.variables : [];
                    return (
                      <div key={key} className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-semibold text-slate-200">{stage.label || label}</div>
                          <div className="text-xs text-slate-400">key: {key}</div>
                          <div className="ml-auto text-xs text-slate-400">
                            变量：{vars.length ? vars.map((v) => `{{${v}}}`).join(' ') : '（无）'}
                          </div>
                        </div>
                        <label className="mt-2 block space-y-1 text-xs text-slate-300">
                          <div>使用场景</div>
                          <textarea
                            className="h-20 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent"
                            value={stage.scenario ?? ''}
                            onChange={(e) => updatePromptStageField(key, 'scenario', e.target.value)}
                            placeholder="说明该 stage 在什么时机被调用、输入输出约束、典型用途…"
                          />
                        </label>
                        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                          <label className="space-y-1 text-xs text-slate-300">
                            <div>System</div>
                            <textarea
                              className="h-36 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent"
                              value={stage.system ?? ''}
                              onChange={(e) => updatePromptStageField(key, 'system', e.target.value)}
                            />
                          </label>
                          <label className="space-y-1 text-xs text-slate-300">
                            <div>User</div>
                            <textarea
                              className="h-36 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent"
                              value={stage.user ?? ''}
                              onChange={(e) => updatePromptStageField(key, 'user', e.target.value)}
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </details>

          {showLlmConfig && llm && (
            <div className="grid grid-cols-1 gap-3 pt-2">
              {(llm.providers ?? []).map((p) => {
                const draft = providerDrafts[p.id] ?? { baseUrl: p.baseUrl ?? '', apiKey: '' };
                return (
                  <div key={p.id} className="rounded-md border border-slate-800 bg-slate-900/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-semibold text-slate-200">{p.label}</div>
                      <div className="text-xs text-slate-400">
                        baseUrl: {p.baseUrlPresent ? '已设置' : '未设置'} / key:{' '}
                        {p.apiKeyPresent ? '已设置' : '未设置'}
                      </div>
                      <div className="ml-auto">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void saveProvider(p.id)}
                          disabled={Boolean(busyLabel)}
                        >
                          保存
                        </Button>
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                      <label className="space-y-1 text-xs text-slate-300">
                        <div>Base URL</div>
                        <input
                          className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                          value={draft.baseUrl}
                          onChange={(e) =>
                            setProviderDrafts((prev) => ({
                              ...prev,
                              [p.id]: { ...draft, baseUrl: e.target.value },
                            }))
                          }
                          placeholder="https://..."
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-300">
                        <div>API Key（留空不修改）</div>
                        <input
                          className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                          value={draft.apiKey}
                          onChange={(e) =>
                            setProviderDrafts((prev) => ({
                              ...prev,
                              [p.id]: { ...draft, apiKey: e.target.value },
                            }))
                          }
                          placeholder={p.apiKeyPresent ? '已设置（不展示）' : ''}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
              <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-400">
                CLI 工具配置已移动到「终端」面板的「＋ 新建终端」旁边。
              </div>
            </div>
          )}
              </section>
            ) : null}

        <section className="col-span-12">
          <div className="rounded-lg border border-slate-800 bg-panel p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {(['requirements', 'design', 'tasks'] as const).map((a) => (
                  <Button
                    key={a}
                    variant={activeArtifact === a ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setActiveArtifact(a)}
                    disabled={
                      !selectedSpecName ||
                      (a === 'design' && !canOpenDesignEffective) ||
                      (a === 'tasks' && !canOpenTasksEffective)
                    }
                  >
                    {artifactLabel(a)}
                  </Button>
                ))}
              </div>
            </div>


            {lastError && (
              <div className="mb-3 rounded-md border border-red-800/40 bg-red-950/40 p-3 text-xs text-red-200">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="font-semibold">最近错误</div>
                  <div className="text-red-300">{errorStageLabel(lastError.stage)}</div>
                  <div className="ml-auto text-red-300">{formatErrorTime(lastError.at)}</div>
                </div>
                <div className="mt-1">原因：{lastError.message}</div>
                {(lastError.context?.baseUrl || lastError.context?.model) && (
                  <div className="mt-1 text-red-300">
                    {lastError.context?.model ? `模型：${lastError.context.model}` : '模型：未设置'}
                    {lastError.context?.baseUrl ? ` · 地址：${lastError.context.baseUrl}` : ''}
                  </div>
                )}
                {lastError.timeoutMs ? (
                  <div className="mt-1 text-red-300">超时阈值：{lastError.timeoutMs}ms</div>
                ) : null}
              </div>
            )}

            {selectedSpecName && activeArtifact === 'requirements' && (
              <div className="mb-4 space-y-3 rounded-md border border-slate-800 bg-slate-900/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold text-slate-200">提问确认</div>
                  <div className="text-xs text-slate-400">
                    {areClarificationsComplete(clarifications) ? '已完成' : '未完成'}
                  </div>
                </div>

                {clarifications.length ? (
                  <div className="space-y-3">
                    {clarifications.map((q, idx) => (
                      <div key={q.id} className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="text-sm text-slate-100">
                            {idx + 1}. {q.question}
                            {q.mode === 'multi' && <span className="text-slate-400">（可多选）</span>}{' '}
                            {q.required && <span className="text-red-300">*</span>}
                          </div>
                          <div className="text-xs text-slate-400">
                            {isClarificationComplete(q) ? '✔' : '—'}
                          </div>
                        </div>

                        <div className="mt-2 space-y-2">
                          {(q.options ?? []).map((opt) => {
                            const selected = q.answer?.selectedOptionIds ?? [];
                            const checked = selected.includes(opt.id);
                            return (
                              <label
                                key={opt.id}
                                className="flex items-start gap-2 text-sm leading-5 text-slate-200"
                              >
                                <input
                                  type="checkbox"
                                  name={`q-${q.id}`}
                                  checked={checked}
                                  className="mt-0.5 h-4 w-4 shrink-0"
                                  onChange={(e) => {
                                    const nextSelected =
                                      q.mode === 'single'
                                        ? checked
                                          ? []
                                          : [opt.id]
                                        : checked
                                          ? selected.filter((id) => id !== opt.id)
                                          : Array.from(new Set([...selected, opt.id]));
                                    setClarifications((prev) =>
                                      prev.map((qq) =>
                                        qq.id === q.id
                                          ? {
                                              ...qq,
                                              answer: {
                                                ...(qq.answer ?? { selectedOptionIds: [], otherText: '' }),
                                                selectedOptionIds: nextSelected,
                                              },
                                            }
                                          : qq,
                                      ),
                                    );
                                  }}
                                />
                                <span>{opt.label}</span>
                              </label>
                            );
                          })}

                          {q.allowOther && (
                            <label className="block space-y-1 text-xs text-slate-300">
                              <div>补充</div>
                              <input
                                className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                                value={q.answer?.otherText ?? ''}
                                onChange={(e) =>
                                  setClarifications((prev) =>
                                    prev.map((qq) =>
                                      qq.id === q.id
                                        ? {
                                            ...qq,
                                            answer: {
                                              ...(qq.answer ?? { selectedOptionIds: [], otherText: '' }),
                                              otherText: e.target.value,
                                            },
                                          }
                                        : qq,
                                    ),
                                  )
                                }
                                placeholder="选填"
                              />
                            </label>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-slate-400">暂无澄清问题</div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => void confirmRequirementsAndGenerateDesign()}
                    disabled={!selectedSpecName || Boolean(busyLabel) || !clarifications.length}
                    className={nextAction === 'generateDesign' ? guidedButtonClass : ''}
                  >
                    生成 requirements.md（并生成设计）
                  </Button>
                </div>
              </div>
            )}

            {selectedSpecName && activeArtifact === 'design' && (
              <div className="mb-4 space-y-3 rounded-md border border-slate-800 bg-slate-900/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold text-slate-200">
                    {isNonSoftwareProject ? '项目类型：非软件项目' : '技术栈确认'}
                  </div>
                  <div className="text-xs text-slate-400">
                    {isNonSoftwareProject
                      ? '已自动跳过软件工程专属步骤'
                      : areClarificationsComplete(techStackClarifications)
                        ? '已完成'
                        : '未完成'}
                  </div>
                </div>

                {isNonSoftwareProject ? (
                  <div className="text-sm text-slate-400">
                    当前原始需求被识别为“非软件项目”，系统将直接生成任务（以文档/交付物/流程为主），不进入技术栈选择。
                  </div>
                ) : techStackClarifications.length ? (
                  <div className="space-y-3">
                    {techStackClarifications.map((q, idx) => (
                      <div
                        key={q.id}
                        className="rounded-md border border-slate-800 bg-slate-950/40 p-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="text-sm text-slate-100">
                            {idx + 1}. {q.question}
                            {q.mode === 'multi' && (
                              <span className="text-slate-400">（可多选）</span>
                            )}{' '}
                            {q.required && <span className="text-red-300">*</span>}
                          </div>
                          <div className="text-xs text-slate-400">
                            {isClarificationComplete(q) ? '✔' : '—'}
                          </div>
                        </div>

                        <div className="mt-2 space-y-2">
                          {(q.options ?? []).map((opt) => {
                            const selected = q.answer?.selectedOptionIds ?? [];
                            const checked = selected.includes(opt.id);
                            const inputId = `ts-${q.id}-${opt.id}`;
                            const wiki = (opt.wiki ?? '').trim();
                            const desc = (opt.desc ?? '').trim();
                            return (
                              <div key={opt.id} className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  id={inputId}
                                  name={`q-${q.id}`}
                                  checked={checked}
                                  className="mt-0.5 h-4 w-4 shrink-0"
                                  onChange={() => {
                                    const nextSelected =
                                      q.mode === 'single'
                                        ? checked
                                          ? []
                                          : [opt.id]
                                        : checked
                                          ? selected.filter((id) => id !== opt.id)
                                          : Array.from(new Set([...selected, opt.id]));
                                    setTechStackClarifications((prev) =>
                                      prev.map((qq) =>
                                        qq.id === q.id
                                          ? {
                                              ...qq,
                                              answer: {
                                                ...(qq.answer ?? {
                                                  selectedOptionIds: [],
                                                  otherText: '',
                                                }),
                                                selectedOptionIds: nextSelected,
                                              },
                                            }
                                          : qq,
                                      ),
                                    );
                                  }}
                                />
                                <div className="min-w-0 flex-1">
                                  <label
                                    htmlFor={inputId}
                                    className="cursor-pointer text-sm leading-5 text-slate-200"
                                  >
                                    {opt.label}
                                  </label>
                                  {desc && (
                                    <div className="mt-0.5 text-xs text-slate-400">{desc}</div>
                                  )}
                                  {wiki && (
                                    <a
                                      className="mt-0.5 inline-block text-xs text-slate-400 underline underline-offset-4 hover:text-slate-200"
                                      href={wiki}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Wiki
                                    </a>
                                  )}
                                </div>
                              </div>
                            );
                          })}

                          {q.allowOther && (
                            <label className="block space-y-1 text-xs text-slate-300">
                              <div>补充</div>
                              <input
                                className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                                value={q.answer?.otherText ?? ''}
                                onChange={(e) =>
                                  setTechStackClarifications((prev) =>
                                    prev.map((qq) =>
                                      qq.id === q.id
                                        ? {
                                            ...qq,
                                            answer: {
                                              ...(qq.answer ?? {
                                                selectedOptionIds: [],
                                                otherText: '',
                                              }),
                                              otherText: e.target.value,
                                            },
                                          }
                                        : qq,
                                    ),
                                  )
                                }
                                placeholder="选填"
                              />
                            </label>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-slate-400">暂无技术栈确认问题</div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() =>
                      void generateTasksFromDesign(
                        isNonSoftwareProject ? { skipTechStack: true } : undefined,
                      )
                    }
                    disabled={
                      !selectedSpecName ||
                      Boolean(busyLabel) ||
                      !artifactContent.design.trim() ||
                      (!isNonSoftwareProject &&
                        (!techStackClarifications.length ||
                          !areClarificationsComplete(techStackClarifications)))
                    }
                    className={nextAction === 'generateTasks' ? guidedButtonClass : ''}
                  >
                    {isNonSoftwareProject ? '生成任务' : '确认技术栈并生成任务'}
                  </Button>
                </div>
              </div>
            )}

            <div className="mb-2 flex flex-wrap items-center gap-2">
              {activeArtifact === 'tasks' && (
                <>
                  <Button
                    size="sm"
                    onClick={() => void downloadAllZip()}
                    disabled={!selectedSpecName || Boolean(busyLabel)}
                    className={nextAction === 'downloadZip' ? guidedButtonClass : ''}
                  >
                    一键下载（ZIP）
                  </Button>
                </>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={downloadCurrentMd} disabled={!selectedSpecName}>
                  下载 MD
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void downloadCurrentPng()}
                  disabled={!selectedSpecName || Boolean(busyLabel)}
                >
                  下载 PNG
                </Button>
              </div>
            </div>

            {activeArtifact === 'tasks' && ATOMIZE_ENABLED && (
              <div className="mb-3 rounded-md border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold text-slate-200">原子化日志</div>
                  <div className="text-xs text-slate-400">
                    {atomizeStatus?.running
                      ? `进行中${
                          atomizeEtaSeconds != null
                            ? `｜剩余约 ${formatDurationSeconds(atomizeEtaSeconds)}`
                            : '｜剩余时间估算中…'
                        }`
                      : atomizeStatus?.total && atomizeStatus.completed >= atomizeStatus.total
                        ? '已完成'
                        : '未运行'}
                  </div>
                  <div className="ml-auto text-xs text-slate-400">
                    {atomizeStatus?.total
                      ? `完成 ${atomizeStatus.completed}/${atomizeStatus.total}`
                      : '完成 0/0'}
                  </div>
                </div>
                {atomizeStatus?.total ? (
                  <div className="mt-2">
                    <div className="h-2 w-full overflow-hidden rounded bg-slate-800">
                      <div
                        className="h-full bg-cyan-400 transition-[width] duration-200"
                        style={{
                          width: `${Math.max(
                            2,
                            Math.min(
                              100,
                              Math.round((atomizeStatus.completed / atomizeStatus.total) * 100),
                            ),
                          )}%`,
                        }}
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                      <div>
                        {Math.round((atomizeStatus.completed / atomizeStatus.total) * 100)}%
                      </div>
                      <div>
                        {!atomizeStatus.running &&
                        atomizeStatus.completed >= atomizeStatus.total
                            ? '已完成'
                            : ''}
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="mt-2 h-32 overflow-auto rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300">
                  {atomizeStatus?.logs?.length ? (
                    atomizeStatus.logs.map((entry, idx) => (
                      <div key={`${entry.at}-${idx}`}>{entry.message}</div>
                    ))
                  ) : (
                    <div className="text-slate-400">暂无日志</div>
                  )}
                </div>
                {atomizeStatus?.error && (
                  <div className="mt-2 text-xs text-red-300">
                    失败：{atomizeStatus.error}
                  </div>
                )}
              </div>
            )}

            {activeArtifact === 'tasks' && selectedSpecName && (
              <details className="mb-3 rounded-md border border-slate-800 bg-slate-950/40 p-3">
                <summary className="cursor-pointer select-none">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold text-slate-200">流程报告</div>
                    <div className="text-xs font-normal text-slate-400">
                      {reports.length ? `共 ${reports.length} 份` : '暂无'}
                    </div>
                    <div className="ml-auto text-xs font-normal text-slate-500">
                      {activeReportRunId ? `当前 runId：${activeReportRunId}` : '未选择 runId'}
                    </div>
                  </div>
                </summary>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void refreshReports(selectedSpecName).catch((e) =>
                          showToast(humanizeError(e)),
                        )
                      }
                      disabled={Boolean(busyLabel)}
                    >
                      刷新
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        activeReportRunId
                          ? void loadReportMarkdown(selectedSpecName, activeReportRunId).catch((e) =>
                              showToast(humanizeError(e)),
                            )
                          : undefined
                      }
                      disabled={!activeReportRunId}
                    >
                      打开
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        activeReportRunId
                          ? void startReportScoreJob(
                              selectedSpecName,
                              activeReportRunId,
                              true,
                            ).then(() => {
                              showToast('已启动评分任务', 'info');
                            }).catch((e) => showToast(humanizeError(e)))
                          : undefined
                      }
                      disabled={!activeReportRunId || reportScoreStatus?.running}
                    >
                      {reportScoreStatus?.running ? '评分中' : '用模型评分'}
                    </Button>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-300">
                  <label className="flex items-center gap-2">
                    <span className="text-slate-400">runId</span>
                    <select
                      className="h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
                      value={activeReportRunId}
                      onChange={(e) => {
                        setActiveReportRunId(e.target.value);
                        setReportMarkdown('');
                      }}
                    >
                      <option value="">（选择）</option>
                      {reports.map((r) => (
                        <option key={r.runId} value={r.runId}>
                          {r.runId}
                        </option>
                      ))}
                    </select>
                  </label>
                  {activeReport?.reportPath && (
                    <div className="text-slate-400 break-all">
                      已保存：{activeReport.reportPath}
                    </div>
                  )}
                </div>

                <div className="mt-3 overflow-auto rounded-md border border-slate-800">
                  <table className="w-full text-xs text-slate-200">
                    <thead className="bg-slate-900/50 text-slate-400">
                      <tr>
                        <th className="px-2 py-1 text-left">模型</th>
                        <th className="px-2 py-1 text-right">分数</th>
                        <th className="px-2 py-1 text-left">总评</th>
                        <th className="px-2 py-1 text-left">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(llm?.options ?? []).map((opt) => {
                        const item = activeReport?.ratings?.byModel?.[opt.id] ?? null;
                        const score = item?.result?.score ?? null;
                        const summary = String(item?.result?.summary ?? '');
                        const statusText = item?.ok
                          ? 'ok'
                          : item?.skipped
                            ? 'skipped'
                            : item?.error
                              ? 'error'
                              : '未评分';
                        const scoreText =
                          typeof score === 'number' && Number.isFinite(score) ? String(score) : '-';
                        return (
                          <tr key={opt.id} className="border-t border-slate-800">
                            <td className="px-2 py-1">{opt.label}</td>
                            <td className="px-2 py-1 text-right">{scoreText}</td>
                            <td className="px-2 py-1 text-slate-300">
                              {summary ? summary.slice(0, 80) : '-'}
                            </td>
                            <td className="px-2 py-1 text-slate-400">{statusText}</td>
                          </tr>
                        );
                      })}
                      {!llm?.options?.length && (
                        <tr>
                          <td className="px-2 py-2 text-slate-400" colSpan={4}>
                            模型列表未加载
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {reportScoreStatus &&
                  (reportScoreStatus.running ||
                    reportScoreStatus.logs?.length ||
                    reportScoreStatus.error) && (
                    <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/40 p-2">
                      <div className="flex items-center gap-2">
                        <div className="text-xs font-semibold text-slate-200">评分日志</div>
                        <div className="ml-auto text-xs text-slate-400">
                          {reportScoreStatus.total
                            ? `完成 ${reportScoreStatus.completed}/${reportScoreStatus.total}`
                            : '完成 0/0'}
                        </div>
                      </div>
                      {reportScoreStatus.total ? (
                        <div className="mt-2">
                          <div className="h-2 w-full overflow-hidden rounded bg-slate-800">
                            <div
                              className="h-full bg-cyan-400 transition-[width] duration-200"
                              style={{
                                width: `${Math.max(
                                  2,
                                  Math.min(
                                    100,
                                    Math.round(
                                      (reportScoreStatus.completed / reportScoreStatus.total) *
                                        100,
                                    ),
                                  ),
                                )}%`,
                              }}
                            />
                          </div>
                          <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                            <div>
                              {Math.round(
                                (reportScoreStatus.completed / reportScoreStatus.total) * 100,
                              )}
                              %
                            </div>
                            <div>
                              {reportScoreStatus.running
                                ? reportScoreEtaSeconds != null
                                  ? `剩余约 ${formatDurationSeconds(reportScoreEtaSeconds)}`
                                  : '剩余时间估算中…'
                                : reportScoreStatus.completed >= reportScoreStatus.total
                                  ? '已完成'
                                  : ''}
                            </div>
                          </div>
                        </div>
                      ) : null}
                      <div className="mt-2 h-24 overflow-auto rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300">
                        {reportScoreStatus.logs?.length ? (
                          reportScoreStatus.logs.map((entry, idx) => (
                            <div key={`${entry.at}-${idx}`}>{entry.message}</div>
                          ))
                        ) : (
                          <div className="text-slate-400">暂无日志</div>
                        )}
                      </div>
                      {reportScoreStatus.error && (
                        <div className="mt-2 text-xs text-red-300">
                          失败：{reportScoreStatus.error}
                        </div>
                      )}
                    </div>
                  )}

                <details className="mt-3 rounded-md border border-slate-800 bg-slate-950/30 p-2">
                  <summary className="cursor-pointer select-none text-xs font-semibold text-slate-200">
                    各模型详细评价（用于迭代）
                  </summary>
                  <div className="mt-2 space-y-3">
                    {(llm?.options ?? []).map((opt) => {
                      const item = activeReport?.ratings?.byModel?.[opt.id] ?? null;
                      const result = item?.result ?? null;
                      const statusText = item?.ok
                        ? 'ok'
                        : item?.skipped
                          ? 'skipped'
                          : item?.error
                            ? 'error'
                            : '未评分';

                      if (!result) {
                        return (
                          <div
                            key={opt.id}
                            className="rounded-md border border-slate-800 bg-slate-950/40 p-2 text-xs text-slate-400"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="font-semibold text-slate-200">{opt.label}</div>
                              <div className="text-slate-500">{statusText}</div>
                            </div>
                            <div className="mt-1">暂无详细评价</div>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={opt.id}
                          className="rounded-md border border-slate-800 bg-slate-950/40 p-2 text-xs text-slate-200"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-semibold">{opt.label}</div>
                            <div className="text-slate-400">{result.score}/100</div>
                            <div className="text-slate-500">{statusText}</div>
                          </div>
                          <div className="mt-1 text-slate-300">
                            <span className="text-slate-400">总评：</span>
                            {result.summary || '（无）'}
                          </div>
                          <div className="mt-2 grid gap-2 md:grid-cols-3">
                            <div>
                              <div className="text-slate-400">优点</div>
                              {result.strengths?.length ? (
                                <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-300">
                                  {result.strengths.slice(0, 8).map((s, idx) => (
                                    <li key={idx}>{s}</li>
                                  ))}
                                </ul>
                              ) : (
                                <div className="mt-1 text-slate-500">（无）</div>
                              )}
                            </div>
                            <div>
                              <div className="text-slate-400">问题</div>
                              {result.weaknesses?.length ? (
                                <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-300">
                                  {result.weaknesses.slice(0, 8).map((s, idx) => (
                                    <li key={idx}>{s}</li>
                                  ))}
                                </ul>
                              ) : (
                                <div className="mt-1 text-slate-500">（无）</div>
                              )}
                            </div>
                            <div>
                              <div className="text-slate-400">建议</div>
                              {result.suggestions?.length ? (
                                <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-300">
                                  {result.suggestions.slice(0, 10).map((s, idx) => (
                                    <li key={idx}>{s}</li>
                                  ))}
                                </ul>
                              ) : (
                                <div className="mt-1 text-slate-500">（无）</div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {!llm?.options?.length && (
                      <div className="text-xs text-slate-400">模型列表未加载</div>
                    )}
                  </div>
                </details>

                <details className="mt-3 rounded-md border border-slate-800 bg-slate-950/40 p-2">
                  <summary className="cursor-pointer select-none text-xs font-semibold text-slate-200">
                    <div className="flex flex-wrap items-center gap-2">
                      <div>任务迭代优化</div>
                      <div className="ml-auto text-xs font-normal text-slate-400">
                        模型：Claude 4.5 Opus
                        {tasksIterateStatus?.running ? ' · 迭代中…' : ''}
                      </div>
                    </div>
                  </summary>
                  <div className="mt-2">
                    <div className="text-xs text-slate-400">
                      点击后会收集上方多模型评价、用户评分记录，以及本次 runId 的 requirements/design/tasks，提交给 Opus 4.5 生成新的 tasks.md，并创建新的流程报告。
                    </div>
                    <textarea
                      className="mt-2 h-24 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                      value={iterateUserNoteText}
                      onChange={(e) => setIterateUserNoteText(e.target.value)}
                      placeholder="可选：补充修改意见（例如：必须补齐缺失边界、禁止占位符路径、description 必须写清输入/输出/验收点等）"
                    />
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                      <Button
                        size="sm"
                        onClick={() => void startIterateTasks()}
                        disabled={!activeReportRunId || Boolean(tasksIterateStatus?.running)}
                      >
                        {tasksIterateStatus?.running ? '迭代中…' : '提交迭代'}
                      </Button>
                    </div>

                    {tasksIterateStatus &&
                      (tasksIterateStatus.running ||
                        tasksIterateStatus.logs?.length ||
                        tasksIterateStatus.error) && (
                        <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/30 p-2">
                          <div className="text-xs text-slate-400">
                            进度：{tasksIterateStatus.completed}/{tasksIterateStatus.total || 1}
                          </div>
                          <div className="mt-2 h-24 overflow-auto rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300">
                            {tasksIterateStatus.logs?.length ? (
                              tasksIterateStatus.logs.map((entry, idx) => (
                                <div key={`${entry.at}-${idx}`}>{entry.message}</div>
                              ))
                            ) : (
                              <div className="text-slate-400">暂无日志</div>
                            )}
                          </div>
                          {tasksIterateStatus.error && (
                            <div className="mt-2 text-xs text-red-300">
                              失败：{tasksIterateStatus.error}
                            </div>
                          )}
                          {tasksIterateStatus.outputRunId && (
                            <div className="mt-2 text-xs text-slate-400 break-all">
                              新 runId：{tasksIterateStatus.outputRunId}
                            </div>
                          )}
                          {tasksIterateStatus.outputReportPath && (
                            <div className="mt-1 text-xs text-slate-500 break-all">
                              新报告：{tasksIterateStatus.outputReportPath}
                            </div>
                          )}
                        </div>
                      )}
                  </div>
                </details>

                {ATOMIZE_ENABLED ? (
                  <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/40 p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-xs font-semibold text-slate-200">迭代生成</div>
                    <div className="ml-auto text-xs text-slate-400">
                      当前模型：
                      {llm?.options?.find((o) => o.id === (llm?.model ?? ''))?.label ??
                        llm?.model ??
                        '（未选择）'}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    点击后会收集上面各模型的评价，并重置 tasks_atomic.md 后用当前模型重新原子化。
                  </div>
                  <textarea
                    className="mt-2 h-24 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                    value={iterateUserNoteText}
                    onChange={(e) => setIterateUserNoteText(e.target.value)}
                    placeholder="可选：补充修改意见（例如：必须补齐缺失边界、禁止出现占位路径、AC 必须包含可执行验证命令等）"
                  />
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      onClick={() => void startIterateTasks()}
                      disabled={!activeReportRunId || Boolean(atomizeStatus?.running)}
                    >
                      迭代原子化
                    </Button>
                  </div>
                </div>
                ) : null}

                <details className="mt-3 rounded-md border border-slate-800 bg-slate-950/40 p-2">
                  <summary className="cursor-pointer select-none text-xs font-semibold text-slate-200">
                    <div className="flex flex-wrap items-center gap-2">
                      <div>用户评分</div>
                      <div className="ml-auto text-xs font-normal text-slate-400">
                        {activeReport?.userRatings?.length
                          ? `已有 ${activeReport.userRatings.length} 条`
                          : '暂无历史评分'}
                      </div>
                    </div>
                  </summary>
                  <div className="mt-2">
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="flex items-center gap-2 text-xs text-slate-300">
                        <span className="text-slate-400">评分</span>
                        <input
                          className="h-8 w-20 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
                          value={userReportScoreText}
                          onChange={(e) =>
                            setUserReportScoreText(
                              e.target.value.replace(/[^\d]/g, '').slice(0, 3),
                            )
                          }
                          placeholder="0-100"
                          inputMode="numeric"
                        />
                      </label>
                      <input
                        className="h-8 min-w-[220px] flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
                        value={userReportCommentText}
                        onChange={(e) => setUserReportCommentText(e.target.value)}
                        placeholder="可选：备注"
                      />
                      <Button
                        size="sm"
                        onClick={() => void submitUserReportRating()}
                        disabled={!activeReportRunId || !userReportScoreText.trim()}
                      >
                        提交
                      </Button>
                    </div>

                    {activeReport?.userRatings?.length ? (
                      <div className="mt-2 text-xs text-slate-300">
                        <div className="text-slate-400">
                          历史用户评分（最近 5 条）：
                        </div>
                        <div className="mt-1 space-y-1">
                          {activeReport.userRatings.slice(-5).map((r, idx) => (
                            <div key={`${r.createdAt}-${idx}`}>
                              {new Date(r.createdAt).toLocaleString()}：{r.score}/100
                              {r.comment ? `｜${r.comment}` : ''}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-slate-400">
                        历史用户评分：暂无
                      </div>
                    )}
                  </div>
                </details>

                <details className="mt-3 rounded-md border border-slate-800 bg-slate-950/30 p-2">
                  <summary className="cursor-pointer select-none text-xs font-semibold text-slate-200">
                    报告内容（Markdown）
                  </summary>
                  <div className="mt-2 space-y-2">
                    <textarea
                      className="h-64 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                      value={reportMarkdown}
                      readOnly
                      placeholder="点击“打开”加载报告…"
                    />
                    <div className="flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (!selectedSpecName || !activeReportRunId) return;
                          const safe = makeDownloadBaseName(selectedSpecName);
                          const fallback = `${safe}_flow_${activeReportRunId}.md`;
                          const filename =
                            basenameFromAnyPath(activeReport?.reportPath ?? '') || fallback;
                          downloadMarkdown(filename, reportMarkdown);
                        }}
                        disabled={!reportMarkdown.trim() || !activeReportRunId}
                      >
                        下载报告 MD
                      </Button>
                    </div>
                  </div>
                </details>
              </details>
            )}

            {activeArtifact === 'tasks' ? (
              <details
                ref={tasksToolsDetailsRef}
                open={tasksToolsOpen}
                onToggle={(e) => setTasksToolsOpen(e.currentTarget.open)}
                className="mb-2 rounded-md border border-slate-800 bg-slate-950/20 p-2"
              >
                <summary className="cursor-pointer select-none text-xs font-semibold text-slate-200">
                  其它功能（终端 / 编辑）
                </summary>
                <div className="mt-2 space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setTasksDisplayMode((prev) => (prev === 'raw' ? 'markdown' : 'raw'))
                      }
                      disabled={Boolean(streamStage) || Boolean(busyLabel)}
                    >
                      {tasksDisplayMode === 'raw' ? '返回 DAG+任务清单' : '编辑 tasks.md'}
                    </Button>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={undoEdit}
                        disabled={
                          !selectedSpecName ||
                          isAtomicView ||
                          historyState[activeArtifact].undo === 0
                        }
                      >
                        撤销
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={redoEdit}
                        disabled={
                          !selectedSpecName ||
                          isAtomicView ||
                          historyState[activeArtifact].redo === 0
                        }
                      >
                        还原
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={resetToBaseline}
                        disabled={!selectedSpecName || isAtomicView}
                      >
                        回到初始
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-md border border-slate-800 bg-slate-950/30 p-2 text-xs text-slate-300">
                    <TerminalPanel ref={terminalPanelRef} onOpenCliConfig={openCliConfig} />
                  </div>
                </div>
              </details>
            ) : (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <div>可按需编辑内容</div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={undoEdit}
                    disabled={
                      !selectedSpecName ||
                      isAtomicView ||
                      historyState[activeArtifact].undo === 0
                    }
                  >
                    撤销
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={redoEdit}
                    disabled={
                      !selectedSpecName ||
                      isAtomicView ||
                      historyState[activeArtifact].redo === 0
                    }
                  >
                    还原
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={resetToBaseline}
                    disabled={!selectedSpecName || isAtomicView}
                  >
                    回到初始
                  </Button>
                </div>
              </div>
            )}

            <div className="relative">
              {shouldTypewriter ? (
                <div
                  ref={(el) => {
                    outputScrollRef.current = el;
                  }}
                  onScroll={handleOutputScroll}
                  className={`h-[520px] w-full overflow-auto rounded-md border bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ${
                    shouldTypewriter ? 'border-slate-600' : 'border-slate-700'
                  }`}
                >
                  <pre className="whitespace-pre-wrap break-words font-sans">
                    <span>{animatedDisplayHead}</span>
                    {animatedDisplayTail ? (
                      <span className="font-mono text-green-400 drop-shadow-[0_0_8px_rgba(34,197,94,0.65)]">
                        {animatedDisplayTail}
                      </span>
                    ) : null}
                  </pre>
                </div>
              ) : (
                isAtomicView && atomicDisplayMode === 'list' ? (
                  <div
                    ref={(el) => {
                      outputScrollRef.current = el;
                    }}
                    className={`h-[520px] w-full overflow-auto rounded-md border bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ${
                      shouldTypewriter ? 'border-slate-600' : 'border-slate-700'
                    }`}
                  >
                    {atomicTaskGroups.length ? (
                      <>
                        <div className="space-y-5">
                        {atomicTaskGroups.map((group, groupIdx) => (
                          <div key={`${group.originalIndex ?? 'na'}-${groupIdx}`}>
                            <div className="flex flex-wrap items-baseline gap-2">
                              <div className="text-xs font-semibold text-slate-200">
                                {group.originalIndex != null ? `原始任务 ${group.originalIndex}` : '原子任务'}
                              </div>
                              {group.originalTitle ? (
                                <div className="text-xs text-slate-400">{group.originalTitle}</div>
                              ) : null}
                            </div>
                            <div className="mt-2 space-y-2">
                              {group.tasks.map((task) => (
                                <div
                                  key={`${task.id}-${task.title}`}
                                  className="rounded-md border border-slate-800 bg-slate-950/40 p-3"
                                >
                                  <div className="flex flex-wrap items-start gap-2">
                                    <div className="text-xs font-semibold text-slate-100">{`Task ${task.id}`}</div>
                                    <div
                                      className={`text-xs ${task.done ? 'text-green-400' : 'text-slate-500'}`}
                                    >
                                      {task.done ? '已完成' : '待办'}
                                    </div>
                                    <div className="ml-auto flex items-center gap-2">
                                      <Button
                                        size="sm"
                                        variant={task.done ? 'outline' : 'default'}
                                        onClick={() => openAtomicTaskStartDialog(task.id)}
                                        disabled={!selectedSpecName || Boolean(busyLabel)}
                                      >
                                        开始
                                      </Button>
                                    </div>
                                  </div>
                                  <div className="mt-2 whitespace-pre-wrap text-sm text-slate-100">
                                    {task.title || '（无标题）'}
                                  </div>
                                  <div className="mt-2 space-y-1 text-xs text-slate-300">
                                    <div className="whitespace-pre-wrap">
                                      <span className="text-slate-400">核心逻辑：</span>
                                      {task.core || '—'}
                                    </div>
                                    <div className="whitespace-pre-wrap">
                                      <span className="text-slate-400">技术细节：</span>
                                      {task.details || '—'}
                                    </div>
                                    <div className="whitespace-pre-wrap">
                                      <span className="text-slate-400">依赖：</span>
                                      {task.depends.length ? task.depends.join('\n') : '无'}
                                    </div>
                                    <div className="whitespace-pre-wrap">
                                      <span className="text-slate-400">验收准则：</span>
                                      {task.ac || '—'}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                        </div>
                      </>
                    ) : (
                      <div className="text-sm text-slate-400">
                        暂无可解析的原子任务（请先点击"开始原子化"生成 tasks_atomic.md）
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {activeArtifact === 'tasks' && selectedSpecName ? (
                      <>
                        {tasksDisplayMode === 'markdown' ? (
                          <ManualTaskRunner
                            specId={selectedSpecName}
                            tasksContent={artifactContent.tasks ?? ''}
                            disabled={Boolean(streamStage) || Boolean(busyLabel)}
                            onSaveTasksContent={async (next) => {
                              setArtifactContent((prev) => ({ ...prev, tasks: next }));
                              await saveArtifact('tasks', next);
                            }}
                            onToast={(message, tone = 'error') => showToast(message, tone)}
                            onRunPromptInClaudeAutoTerminal={runPromptInClaudeAutoTerminal}
                          />
                        ) : (
                          <textarea
                            ref={(el) => {
                              outputScrollRef.current = el;
                            }}
                            className={`min-h-[520px] w-full rounded-md border bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent ${
                              shouldTypewriter ? 'border-slate-600' : 'border-slate-700'
                            }`}
                            value={outputText}
                            onChange={(e) =>
                              setArtifactContent((prev) => {
                                if (isAtomicView) return prev;
                                const nextValue = e.target.value;
                                const currentValue = prev[activeArtifact] ?? '';
                                const next = { ...prev, [activeArtifact]: nextValue };

                                if (
                                  selectedSpecName &&
                                  !isApplyingHistoryRef.current &&
                                  nextValue !== currentValue
                                ) {
                                  const h = historyRef.current[activeArtifact];
                                  h.undo.push(currentValue);
                                  if (h.undo.length > 80) h.undo.shift();
                                  h.redo = [];
                                  setHistoryState((prevState) => ({
                                    ...prevState,
                                    [activeArtifact]: { undo: h.undo.length, redo: 0 },
                                  }));
                                }

                                if (selectedSpecName) {
                                  if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
                                  saveTimerRef.current = window.setTimeout(() => {
                                    void saveArtifact(activeArtifact);
                                  }, 900);
                                }
                                return next;
                              })
                            }
                            disabled={!selectedSpecName}
                            readOnly={isAtomicView || Boolean(streamStage)}
                          />
                        )}
                      </>
                    ) : (
                      <textarea
                        ref={(el) => {
                          outputScrollRef.current = el;
                        }}
                        className={`h-[520px] w-full rounded-md border bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent ${
                          shouldTypewriter ? 'border-slate-600' : 'border-slate-700'
                        }`}
                        value={outputText}
                        onChange={(e) =>
                          setArtifactContent((prev) => {
                            if (isAtomicView) return prev;
                            const nextValue = e.target.value;
                            const currentValue = prev[activeArtifact] ?? '';
                            const next = { ...prev, [activeArtifact]: nextValue };

                            if (
                              selectedSpecName &&
                              !isApplyingHistoryRef.current &&
                              nextValue !== currentValue
                            ) {
                              const h = historyRef.current[activeArtifact];
                              h.undo.push(currentValue);
                              if (h.undo.length > 80) h.undo.shift();
                              h.redo = [];
                              setHistoryState((prevState) => ({
                                ...prevState,
                                [activeArtifact]: { undo: h.undo.length, redo: 0 },
                              }));
                            }

                            if (selectedSpecName) {
                              if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
                              saveTimerRef.current = window.setTimeout(() => {
                                void saveArtifact(activeArtifact);
                              }, 900);
                            }
                            return next;
                          })
                        }
                        disabled={!selectedSpecName}
                        readOnly={isAtomicView || Boolean(streamStage)}
                      />
                    )}
                  </>
                )
              )}
              {shouldTypewriter && (
                <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/80 px-2 py-1 text-xs text-slate-200">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300" />
                  <span>{streamStage ? errorStageLabel(streamStage) : '输出中'}</span>
                  {!outputAutoFollow && <span className="text-slate-500">跟随暂停</span>}
                  <span className="text-slate-400">
                    {outputEtaText ? `剩余约 ${outputEtaText}` : '剩余时间估算中…'}
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>
          </div>
        </main>
      </div>

      {atomicTaskStartDialog ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (atomicTaskStartDialog.submitting) return;
            closeAtomicTaskStartDialog();
          }}
        >
          <div className="w-[760px] max-w-[96vw] overflow-hidden rounded-lg border border-slate-700 bg-slate-950 shadow-2xl">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950 px-4 py-3">
              <div className="text-sm font-semibold text-slate-200">
                执行 Task {atomicTaskStartDialog.taskId}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={refreshAtomicTaskAssignableTerminals}
                  disabled={atomicTaskStartDialog.submitting}
                >
                  刷新已开 CLI
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={closeAtomicTaskStartDialog}
                  disabled={atomicTaskStartDialog.submitting}
                >
                  关闭
                </Button>
              </div>
            </div>
            <div className="space-y-3 p-4 text-sm text-slate-200">
              <div className="space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={atomicTaskStartDialog.mode === 'new-codex'}
                    onChange={() =>
                      setAtomicTaskStartDialog((prev) =>
                        prev ? { ...prev, mode: 'new-codex', error: null } : prev,
                      )
                    }
                    disabled={atomicTaskStartDialog.submitting}
                  />
                  <span>新开 Codex（任务模式）</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={atomicTaskStartDialog.mode === 'new-claude'}
                    onChange={() =>
                      setAtomicTaskStartDialog((prev) =>
                        prev ? { ...prev, mode: 'new-claude', error: null } : prev,
                      )
                    }
                    disabled={atomicTaskStartDialog.submitting}
                  />
                  <span>新开 Claude Code（全自动）</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={atomicTaskStartDialog.mode === 'existing'}
                    onChange={() =>
                      setAtomicTaskStartDialog((prev) =>
                        prev
                          ? {
                              ...prev,
                              mode: 'existing',
                              selectedTerminalId: prev.selectedTerminalId || prev.terminals[0]?.id || '',
                              error: null,
                            }
                          : prev,
                      )
                    }
                    disabled={atomicTaskStartDialog.submitting}
                  />
                  <span>分配到已开启 CLI</span>
                </label>
              </div>

              {atomicTaskStartDialog.mode === 'existing' ? (
                <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3">
                  {atomicTaskStartDialog.terminals.length ? (
                    <label className="space-y-1 text-xs text-slate-300">
                      <div>选择终端</div>
                      <select
                        className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                        value={atomicTaskStartDialog.selectedTerminalId}
                        onChange={(e) =>
                          setAtomicTaskStartDialog((prev) =>
                            prev ? { ...prev, selectedTerminalId: e.target.value } : prev,
                          )
                        }
                        disabled={atomicTaskStartDialog.submitting}
                      >
                        <option value="" disabled>
                          请选择
                        </option>
                        {atomicTaskStartDialog.terminals.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.title} · {t.kind} · {t.id.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <div className="text-xs text-slate-400">暂无已开启的 CLI 终端</div>
                  )}
                </div>
              ) : null}

              {atomicTaskStartDialog.error ? (
                <div className="rounded-md border border-red-800/40 bg-red-950/30 p-2 text-xs text-red-200">
                  {atomicTaskStartDialog.error}
                </div>
              ) : null}

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={closeAtomicTaskStartDialog}
                  disabled={atomicTaskStartDialog.submitting}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  onClick={() => void startAtomicTaskFromDialog()}
                  disabled={
                    atomicTaskStartDialog.submitting ||
                    (atomicTaskStartDialog.mode === 'existing' &&
                      (!atomicTaskStartDialog.selectedTerminalId ||
                        atomicTaskStartDialog.terminals.length === 0))
                  }
                >
                  {atomicTaskStartDialog.submitting ? '启动中…' : '开始'}
                </Button>
              </div>

              <div className="text-[11px] text-slate-500">
                工作目录使用终端面板的“默认目录”；需要新建目录时，可用“默认目录”旁的“新建文件夹”，或在“选择目录”里新建。
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {cliConfigOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeCliConfig();
          }}
        >
          <div className="w-[980px] max-w-[96vw] overflow-hidden rounded-lg border border-slate-700 bg-slate-950 shadow-2xl">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950 px-4 py-3">
              <div className="text-sm font-semibold text-slate-200">CLI 配置</div>
              <div className="text-xs text-slate-400">
                配置入口已移动到「终端」面板的「新建终端」旁边
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={closeCliConfig}>
                  关闭
                </Button>
              </div>
            </div>
            <div className="max-h-[82vh] overflow-auto p-4">
              <div className="mb-3 rounded-md border border-slate-800 bg-slate-900/40 p-3">
                <div className="text-sm font-semibold text-slate-200">内置参考（只读）</div>
                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div className="rounded-md border border-slate-800 bg-slate-950/40 p-2">
                    <div className="text-xs font-semibold text-slate-200">Codex CLI（手动）</div>
                    <div className="mt-1 font-mono text-[11px] text-slate-300">
                      cmd.exe /d /s /c codex
                    </div>
                  </div>
                  <div className="rounded-md border border-slate-800 bg-slate-950/40 p-2">
                    <div className="text-xs font-semibold text-slate-200">Claude Code（全自动）</div>
                    <div className="mt-1 font-mono text-[11px] text-slate-300">
                      cmd.exe /d /s /c claude --dangerously-skip-permissions
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-slate-500">
                  需要参照时，打开“新增 CLI 工具”，点击“填入模板”自动带出 command/args。
                </div>
              </div>

              <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold text-slate-200">CLI 工具</div>
                  <div className="text-xs text-slate-400">
                    {cliToolsLoading ? '加载中…' : `${cliTools.length} 个`}
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void refreshCliTools().catch((e) => showToast(humanizeError(e)))
                      }
                      disabled={cliToolsLoading || Boolean(busyLabel)}
                    >
                      刷新
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void resetCliToolsToDefault()}
                      disabled={cliToolsLoading || Boolean(busyLabel)}
                    >
                      还原初始值
                    </Button>
                    <Button size="sm" onClick={() => openCliToolEditor()} disabled={Boolean(busyLabel)}>
                      新增
                    </Button>
                  </div>
                </div>

                {cliToolsError ? (
                  <div className="mt-2 rounded-md border border-red-800/40 bg-red-950/30 p-2 text-xs text-red-200">
                    {cliToolsError}
                  </div>
                ) : null}

                <div className="mt-2 space-y-2">
                  {cliTools.length ? (
                    cliTools.map((tool) => (
                      <div
                        key={tool.id}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 p-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-slate-100">
                            {tool.label}{' '}
                            <span className="text-xs text-slate-400">({tool.id})</span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-slate-400">
                            {tool.command}
                            {tool.args?.length ? ` ${tool.args.join(' ')}` : ''}
                            {tool.baseUrlPresent ? ` · baseUrl: ${tool.baseUrl}` : ''}
                            {` · key: ${tool.apiKeyPresent ? '已配置' : '未配置'}`}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openCliToolEditor(tool)}
                          disabled={Boolean(busyLabel)}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void deleteCliTool(tool.id)}
                          disabled={Boolean(busyLabel)}
                        >
                          删除
                        </Button>
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-slate-400">暂无 CLI 工具配置</div>
                  )}
                </div>

                {cliToolEditorOpen ? (
                  <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-semibold text-slate-200">
                        {cliToolEditingId ? `编辑：${cliToolEditingId}` : '新增 CLI 工具'}
                      </div>
                      <div className="ml-auto flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => void saveCliTool()}
                          disabled={cliToolSaving || Boolean(busyLabel)}
                        >
                          保存
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => cancelCliToolEditor()}
                          disabled={cliToolSaving}
                        >
                          取消
                        </Button>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-300">
                      <div className="text-slate-400">填入模板：</div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setCliToolDraft((prev) => ({
                            ...prev,
                            ...(cliToolEditingId ? {} : { id: '' }),
                            label: 'Codex CLI（手动）',
                            command: 'cmd.exe',
                            argsText: '/d\n/s\n/c\ncodex',
                            baseUrl: '',
                            baseUrlEnvKey: '',
                            apiKey: '',
                            apiKeyEnvKey: '',
                            envText: '',
                            clearApiKey: false,
                          }))
                        }
                        disabled={cliToolSaving || Boolean(busyLabel)}
                      >
                        Codex CLI
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setCliToolDraft((prev) => ({
                            ...prev,
                            ...(cliToolEditingId ? {} : { id: '' }),
                            label: 'Claude Code（全自动）',
                            command: 'cmd.exe',
                            argsText: '/d\n/s\n/c\nclaude\n--dangerously-skip-permissions',
                            baseUrl: '',
                            baseUrlEnvKey: '',
                            apiKey: '',
                            apiKeyEnvKey: '',
                            envText: '',
                            clearApiKey: false,
                          }))
                        }
                        disabled={cliToolSaving || Boolean(busyLabel)}
                      >
                        Claude Code
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setCliToolDraft((prev) => ({
                            ...prev,
                            ...(cliToolEditingId ? {} : { id: '' }),
                            label: '',
                            command: '',
                            argsText: '',
                            baseUrl: '',
                            baseUrlEnvKey: '',
                            apiKey: '',
                            apiKeyEnvKey: '',
                            envText: '',
                            clearApiKey: false,
                          }))
                        }
                        disabled={cliToolSaving || Boolean(busyLabel)}
                      >
                        清空
                      </Button>
                    </div>

                    <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                      <label className="space-y-1 text-xs text-slate-300">
                        <div>ID（可选，编辑时不可改）</div>
                        <input
                          className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                          value={cliToolDraft.id}
                          onChange={(e) => setCliToolDraft((prev) => ({ ...prev, id: e.target.value }))}
                          placeholder="gemini / opencode"
                          disabled={Boolean(cliToolEditingId)}
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-300">
                        <div>Label</div>
                        <input
                          className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                          value={cliToolDraft.label}
                          onChange={(e) => setCliToolDraft((prev) => ({ ...prev, label: e.target.value }))}
                          placeholder="Gemini CLI"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-300">
                        <div>Command</div>
                        <input
                          className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                          value={cliToolDraft.command}
                          onChange={(e) =>
                            setCliToolDraft((prev) => ({ ...prev, command: e.target.value }))
                          }
                          placeholder="gemini"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-300">
                        <div>Args（每行一个）</div>
                        <textarea
                          className="h-20 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100"
                          value={cliToolDraft.argsText}
                          onChange={(e) =>
                            setCliToolDraft((prev) => ({ ...prev, argsText: e.target.value }))
                          }
                          placeholder="--help"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-300">
                        <div>Base URL</div>
                        <input
                          className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                          value={cliToolDraft.baseUrl}
                          onChange={(e) =>
                            setCliToolDraft((prev) => ({ ...prev, baseUrl: e.target.value }))
                          }
                          placeholder="https://..."
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-300">
                        <div>Base URL Env Key（可选）</div>
                        <input
                          className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                          value={cliToolDraft.baseUrlEnvKey}
                          onChange={(e) =>
                            setCliToolDraft((prev) => ({ ...prev, baseUrlEnvKey: e.target.value }))
                          }
                          placeholder="GEMINI_BASE_URL"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-300">
                        <div>API Key（留空不修改/不展示）</div>
                        <input
                          type="password"
                          className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                          value={cliToolDraft.apiKey}
                          onChange={(e) =>
                            setCliToolDraft((prev) => ({ ...prev, apiKey: e.target.value }))
                          }
                          placeholder={
                            cliToolEditingId &&
                            cliTools.find((t) => t.id === cliToolEditingId)?.apiKeyPresent
                              ? '已配置（留空不修改）'
                              : ''
                          }
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-300">
                        <div>API Key Env Key（可选）</div>
                        <input
                          className="h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
                          value={cliToolDraft.apiKeyEnvKey}
                          onChange={(e) =>
                            setCliToolDraft((prev) => ({ ...prev, apiKeyEnvKey: e.target.value }))
                          }
                          placeholder="GEMINI_API_KEY"
                        />
                      </label>
                      {cliToolEditingId &&
                      cliTools.find((t) => t.id === cliToolEditingId)?.apiKeyPresent ? (
                        <label className="flex items-center gap-2 text-xs text-slate-300">
                          <input
                            type="checkbox"
                            checked={cliToolDraft.clearApiKey}
                            onChange={(e) =>
                              setCliToolDraft((prev) => ({ ...prev, clearApiKey: e.target.checked }))
                            }
                          />
                          清除已保存的 API Key
                        </label>
                      ) : (
                        <div />
                      )}
                      <label className="space-y-1 text-xs text-slate-300 md:col-span-2">
                        <div>Env（每行 KEY=VALUE，可选）</div>
                        <textarea
                          className="h-28 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100"
                          value={cliToolDraft.envText}
                          onChange={(e) =>
                            setCliToolDraft((prev) => ({ ...prev, envText: e.target.value }))
                          }
                          placeholder={'FOO=bar\nDEBUG=1'}
                        />
                      </label>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {busyLabel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="w-[520px] max-w-[92vw] rounded-lg border border-slate-700 bg-slate-950 px-5 py-4 text-slate-100 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-500 border-t-slate-100" />
              <div className="text-sm font-semibold">
                {busyLabel}
                {streamStage ? ` · ${errorStageLabel(streamStage)}` : ''}
              </div>
              <div className="ml-auto text-xs text-slate-400">
                {formatDurationSeconds(busySeconds)}
                {busyEtaText ? ` · 剩余约 ${busyEtaText}` : ' · 剩余时间估算中…'}
              </div>
            </div>
            {busyProgressEffective != null && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded bg-slate-800">
                <div
                  className="h-full bg-cyan-400 transition-[width] duration-200"
                  style={{
                    width: `${Math.max(2, Math.min(100, Math.round(busyProgressEffective * 100)))}%`,
                  }}
                />
              </div>
            )}
            {busyDetail && (
              <div className="mt-2 text-xs text-slate-400">{busyDetail}</div>
            )}
            <div className="mt-2 text-xs leading-5 text-slate-300">
              <div>生成中…内容会在对应窗口实时出现。</div>
              {busySeconds >= 20 && (
                <div className="mt-1 text-slate-400">
                  若长时间无响应：检查模型可用性与 Base URL/Key 配置，或确认反代可访问 bridge。
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 w-[680px] max-w-[92vw] -translate-x-1/2">
          <div
            className={`rounded-md border border-slate-700 bg-slate-950 px-4 py-2 text-sm ${
              toast.tone === 'error' ? 'text-red-300' : 'text-slate-200'
            }`}
          >
            {toast.message}
          </div>
        </div>
      )}
    </div>
  );
}
