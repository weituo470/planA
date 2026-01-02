import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';

import { Button } from './components/ui/button';
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

type TaskView = 'tasks' | 'atomic';

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

const PROMPT_STAGE_ORDER = [
  { key: 'requirements', label: '需求生成' },
  { key: 'requirementsClarifications', label: '需求确认问题生成' },
  { key: 'design', label: '设计生成' },
  { key: 'tasks', label: '任务生成' },
  { key: 'atomize', label: '任务原子化' },
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

function buildClarificationsMarkdown(questions: ClarificationQuestion[]) {
  const lines: string[] = [];
  lines.push('## 需求确认', '');
  questions.forEach((q, i) => {
    const selectedIds = q.answer?.selectedOptionIds ?? [];
    const selectedLabels = q.options
      .filter((opt) => selectedIds.includes(opt.id))
      .map((opt) => opt.label)
      .filter(Boolean);
    const otherText = (q.answer?.otherText ?? '').trim();
    lines.push(`### Q${i + 1}. ${q.question}`);
    lines.push(`- 选择：${selectedLabels.length ? selectedLabels.join('、') : '（未选择）'}`);
    if (q.allowOther) lines.push(`- 补充：${otherText ? otherText : '（无）'}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function upsertClarificationsSection(markdown: string, questions: ClarificationQuestion[]) {
  const section = buildClarificationsMarkdown(questions);
  const text = markdown ?? '';
  const re = /^## 需求(?:澄清|确认)[\s\S]*?(?=\n## |\n# |$)/m;
  if (re.test(text)) return text.replace(re, section).trimEnd();
  const afterOriginal = /(## 原始需求[\s\S]*?)(\n## |\n# |$)/m.exec(text);
  if (afterOriginal) {
    const insertAt = afterOriginal.index + afterOriginal[1].length;
    return `${text.slice(0, insertAt).trimEnd()}\n\n${section}\n\n${text.slice(insertAt).trimStart()}`.trimEnd();
  }
  return `${text.trimEnd()}\n\n${section}\n`.trimEnd();
}

function buildTechStackMarkdown(questions: ClarificationQuestion[]) {
  const lines: string[] = [];
  lines.push('## 技术栈确认', '');
  questions.forEach((q, i) => {
    const selectedIds = q.answer?.selectedOptionIds ?? [];
    const selectedLabels = q.options
      .filter((opt) => selectedIds.includes(opt.id))
      .map((opt) => opt.label)
      .filter(Boolean);
    const otherText = (q.answer?.otherText ?? '').trim();
    lines.push(`### Q${i + 1}. ${q.question}`);
    lines.push(`- 选择：${selectedLabels.length ? selectedLabels.join('、') : '（未选择）'}`);
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
  if (status === 409 && /Requirements not confirmed/i.test(msg)) return '需求尚未确认，请先完成需求确认并生成设计。';
  if (status === 409 && /Tech stack clarifications incomplete/i.test(msg)) return '技术栈确认未完成，请先完成必填项。';
  if (status === 409 && /clarifications incomplete/i.test(msg)) return '需求确认未完成，请先完成必填项。';
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
  if (stage === 'requirementsClarifications') return '需求确认问题生成';
  if (stage === 'design') return '设计生成';
  if (stage === 'tasks') return '任务生成';
  if (stage === 'atomize') return '任务原子化';
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
  const [atomizeStatus, setAtomizeStatus] = useState<AtomizeStatus | null>(null);
  const [atomizeBatchSizeText, setAtomizeBatchSizeText] = useState('3');
  const [atomizeAutoContinue, setAtomizeAutoContinue] = useState(true);
  const atomizePrevRef = useRef<{
    specName: string | null;
    running: boolean;
  } | null>(null);
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
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const busyStartedAtRef = useRef<number | null>(null);
  const [busySeconds, setBusySeconds] = useState(0);
  const [streamStage, setStreamStage] = useState<string | null>(null);
  const streamStageRef = useRef<string | null>(null);
  const streamArtifactRef = useRef<SpecArtifact | null>(null);
  const streamTextRef = useRef('');
  const streamFlushTimerRef = useRef<number | null>(null);
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
        if (!stage) return;
        streamStageRef.current = stage;
        setStreamStage(stage);
        const artifact = stageToArtifact(stage);
        if (artifact) {
          streamArtifactRef.current = artifact;
          setActiveArtifact(artifact);
          if (artifact === 'tasks') setTaskView('tasks');
        }
        if (evt.state === 'start') {
          streamTextRef.current = '';
          if (artifact) {
            setArtifactContent((prev) => ({ ...prev, [artifact]: '' }));
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

  const refreshSpecs = useCallback(async () => {
    const data = await apiJson<{ specs: SpecSummary[] }>('/specs');
    setSpecs(data.specs ?? []);
  }, []);

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
  }, [refreshLlm, refreshPrompts, refreshSpecs, showToast]);

  useEffect(() => {
    if (!busyLabel) {
      busyStartedAtRef.current = null;
      setBusySeconds(0);
      return;
    }

    if (!busyStartedAtRef.current) {
      busyStartedAtRef.current = Date.now();
      setBusySeconds(0);
    }

    const t = window.setInterval(() => {
      const startedAt = busyStartedAtRef.current ?? Date.now();
      setBusySeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 300);

    return () => window.clearInterval(t);
  }, [busyLabel]);

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
      setArtifactContent((prev) => ({
        ...prev,
        requirements: upsertClarificationsSection(prev.requirements ?? '', clarifications),
      }));
      await refreshSpecs();
    } catch (e: any) {
      showToast(humanizeError(e));
    }
  }, [clarifications, refreshSpecs, selectedSpecName, showToast]);

  const applyClarificationsToRequirements = useCallback(async () => {
    const next = upsertClarificationsSection(artifactContent.requirements ?? '', clarifications);
    setArtifactContent((prev) => ({ ...prev, requirements: next }));
    await saveArtifact('requirements', next);
  }, [artifactContent.requirements, clarifications, saveArtifact]);

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
        throw new Error('请先完成所有必填的需求确认');
      }
      await saveClarifications();
      await applyClarificationsToRequirements();
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
    applyClarificationsToRequirements,
    clarifications,
    handleNdjsonEvent,
    loadArtifact,
    refreshSpecs,
    resetStreamPreview,
    saveClarifications,
    selectedSpecName,
    showToast,
  ]);

  const generateTasksFromDesign = useCallback(async () => {
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
      if (!areClarificationsComplete(techStackClarifications)) {
        throw new Error('请先完成所有必填的技术栈确认');
      }
      await saveTechStackClarifications();
      await applyTechStackToDesign();
      await apiNdjsonStream(
        `/specs/${encodeURIComponent(selectedSpecName)}/confirm?stream=1`,
        {
          method: 'POST',
          body: JSON.stringify({
            artifact: 'design',
            force: true,
            techStackClarifications: { questions: techStackClarifications },
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
    const isAtomicView = activeArtifact === 'tasks' && taskView === 'atomic';
    const displayArtifact = isAtomicView ? 'tasks_atomic' : activeArtifact;
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
    try {
      const isAtomicView = activeArtifact === 'tasks' && taskView === 'atomic';
      const displayArtifact = isAtomicView ? 'tasks_atomic' : activeArtifact;
      const label = isAtomicView ? '任务原子化' : artifactLabel(activeArtifact);
      const title = `${selectedSpecName} / ${label}`;
      const content = isAtomicView
        ? tasksAtomicContent
        : artifactContent[activeArtifact] ?? '';
      const blob = await renderTextToPng(content, title);
      const base = makeDownloadBaseName(selectedSpecName);
      downloadBlob(`${base}_${displayArtifact}.png`, blob);
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
    try {
      const zip = new JSZip();
      const base = makeDownloadBaseName(selectedSpecName);
      const folder = zip.folder(base) ?? zip;
      folder.file(
        '使用说明.txt',
        [
          'planA 规范驱动开发 - 文档使用说明',
          '',
          '本压缩包包含 4 份核心文档（requirements/design/tasks/tasks_atomic），用于在 AI IDE 中执行类似 Kiro 的“规范驱动开发（Spec-Driven Development）”。',
          '',
          '给 AI IDE 的执行指令：优先按 tasks_atomic.md（原子化任务表单）逐条实现与验收；tasks.md 只用于范围/里程碑回写。',
          '如需调整范围/补充任务：先更新 tasks.md，再重新生成 tasks_atomic.md 后继续。',
          '',
          '1) requirements.md（需求）',
          '- 用途：产品/业务需求的唯一事实来源（Source of Truth）。',
          '- 建议：补全背景、用户故事、验收标准，并在“需求确认”中记录关键选择与补充信息。',
          '',
          '2) design.md（设计）',
          '- 用途：面向实现的技术方案与架构说明，指导代码组织、关键流程、边界与风险。',
          '- 建议：让 AI IDE 在编码前先阅读 design.md，确保实现方向一致。',
          '',
          '3) tasks.md（任务）',
          '- 用途：任务总览、范围约束与回写入口（开发执行优先以 tasks_atomic.md 为准）。',
          '- 工作方式：',
          '  a) 保持 tasks.md 覆盖所有待办与范围边界；',
          '  b) AI IDE 实施时优先按 tasks_atomic.md 执行，并将完成情况/关键变更回写到 tasks.md；',
          '  c) 如发现遗漏或范围变化，先更新 tasks.md，再重新生成 tasks_atomic.md 后继续。',
          '',
          '4) tasks_atomic.md（原子化任务表单）',
          '- 用途：AI IDE 开发的首选执行清单（原子任务粒度，便于逐条验收与并行推进）。',
          '- 建议：交付给 AI IDE 时，默认以 tasks_atomic.md 为执行单元逐条实现；完成后勾选（- [x]）并补充“实现说明/变更文件/验证结果”。',
          '',
          '推荐流程（类似 Kiro）：',
          '1. 写原始需求 → 生成 requirements',
          '2. 完成“需求确认” → 生成 design',
          '3. 从 design 生成 tasks',
          '4. 生成 tasks_atomic（推荐，交付 AI IDE 前完成）',
          '5. 将 requirements/design/tasks/tasks_atomic 提供给你的 AI 编程工具/IDE，要求它：',
          '   - 以 requirements/design 作为约束与上下文',
          '   - 优先以 tasks_atomic.md（原子化任务表单）逐条执行并回写完成记录',
          '   - tasks.md 用于同步范围与里程碑；如需变更先改 tasks.md 再继续',
          '',
          '提示：当你要加功能或改需求时，先更新 requirements/design/tasks（必要时重新生成 tasks_atomic），再让 AI IDE 继续执行。',
          '',
        ].join('\n'),
      );
      const artifacts: SpecArtifact[] = ['requirements', 'design', 'tasks'];
      for (const a of artifacts) {
        const title = `${selectedSpecName} / ${artifactLabel(a)}`;
        let content = artifactContent[a] ?? '';
        try {
          const latest = await apiJson<{ content: string }>(
            `/specs/${encodeURIComponent(selectedSpecName)}/${a}`,
          );
          content = latest.content ?? content;
          setArtifactContent((prev) => ({ ...prev, [a]: content }));
        } catch {
          // Ignore refresh failures and use local snapshot.
        }
        folder.file(`${a}.md`, content);
        const png = await renderTextToPng(content, title);
        folder.file(`${a}.png`, png);
      }
      try {
        const latest = await apiJson<{ content: string }>(
          `/specs/${encodeURIComponent(selectedSpecName)}/tasks_atomic`,
        );
        const atomicContent = latest.content ?? '';
        if (atomicContent.trim()) {
          folder.file('tasks_atomic.md', atomicContent);
          const atomicTitle = `${selectedSpecName} / 任务原子化`;
          const png = await renderTextToPng(atomicContent, atomicTitle);
          folder.file('tasks_atomic.png', png);
        }
      } catch {
        // Ignore missing atomic tasks
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(`${base}_all.zip`, blob);
    } catch (e: any) {
      showToast(humanizeError(e));
    } finally {
      setBusyLabel(null);
    }
  }, [artifactContent, selectedSpecName]);

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

  const updatePromptStageField = useCallback((stageKey: string, field: 'system' | 'user', value: string) => {
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

  const activeModelId = llm?.model ?? '';
  const activePing = activeModelId ? modelPing[activeModelId] : null;
  const isAtomicView = activeArtifact === 'tasks' && taskView === 'atomic';
  const displayContent = isAtomicView
    ? tasksAtomicContent
    : artifactContent[activeArtifact] ?? '';

  return (
    <div className="min-h-screen bg-surface text-slate-100">
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
      <main className="mx-auto grid max-w-[1400px] grid-cols-12 gap-4 px-6 py-6">
        <section className="col-span-12 space-y-3 rounded-lg border border-slate-800 bg-panel p-4">
          <div className="text-sm font-semibold text-slate-200">原始需求</div>
          <textarea
            className="h-24 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent"
            value={rawPrompt}
            onChange={(e) => setRawPrompt(e.target.value)}
            placeholder="粘贴/输入需求描述，点击“生成需求”创建一个新的 Spec。"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={createSpec} disabled={!rawPrompt.trim() || Boolean(busyLabel)}>
              生成需求
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
                流程：原始需求 → 需求确认 → 设计 → 技术栈确认 → 任务 → 分段原子化 → 下载交付
              </div>

              <div className="overflow-x-auto rounded-md border border-slate-800 bg-slate-950/40 p-3">
                <svg
                  viewBox="0 0 1060 120"
                  className="h-[110px] min-w-[1060px]"
                  role="img"
                  aria-label="工作流示意图"
                >
                  <defs>
                    <marker
                      id="arrowHead"
                      markerWidth="10"
                      markerHeight="10"
                      refX="8"
                      refY="3"
                      orient="auto"
                    >
                      <path d="M0,0 L0,6 L9,3 z" fill="#64748b" />
                    </marker>
                  </defs>

                  {[
                    { x: 10, text: '原始需求' },
                    { x: 160, text: '需求 + 确认' },
                    { x: 310, text: '设计' },
                    { x: 460, text: '技术栈确认' },
                    { x: 610, text: '任务' },
                    { x: 760, text: '分段原子化' },
                    { x: 910, text: '下载 ZIP' },
                  ].map((node) => (
                    <g key={node.x}>
                      <rect
                        x={node.x}
                        y={30}
                        width={130}
                        height={44}
                        rx={10}
                        fill="#0b1220"
                        stroke="#334155"
                        strokeWidth={1.2}
                      />
                      <text
                        x={node.x + 65}
                        y={56}
                        textAnchor="middle"
                        fontSize={14}
                        fill="#e2e8f0"
                        dominantBaseline="middle"
                      >
                        {node.text}
                      </text>
                    </g>
                  ))}

                  {[10, 160, 310, 460, 610, 760].map((x) => (
                    <line
                      key={x}
                      x1={x + 130}
                      y1={52}
                      x2={x + 150}
                      y2={52}
                      stroke="#64748b"
                      strokeWidth={2}
                      markerEnd="url(#arrowHead)"
                    />
                  ))}
                </svg>
              </div>

              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-200">
                <li>在“原始需求”输入内容，点“生成需求”创建一个新的 Spec。</li>
                <li>切到“需求”，完成“需求确认”，点“确认需求并生成设计”。</li>
                <li>切到“设计”，完成“技术栈确认”，点“确认技术栈并生成任务”。</li>
                <li>
                  切到“任务”，点“开始原子化”。可设置“分段 N 条/次”，默认开启“自动续段”，失败时可点“重试本段”。
                </li>
                <li>
                  需要交付给 AI IDE 时，点“一键下载（ZIP）”，并优先按 tasks_atomic.md（原子化任务表单）逐条开发。
                </li>
              </ol>

              <div className="text-xs text-slate-400">
                默认地址：Bridge {BRIDGE_URL} · Dashboard 一般为 http://localhost:5173/
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
            </div>
          )}
        </section>

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
                  <div className="text-sm font-semibold text-slate-200">需求确认</div>
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
                  >
                    生成设计
                  </Button>
                </div>
              </div>
            )}

            {selectedSpecName && activeArtifact === 'design' && (
              <div className="mb-4 space-y-3 rounded-md border border-slate-800 bg-slate-900/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold text-slate-200">技术栈确认</div>
                  <div className="text-xs text-slate-400">
                    {areClarificationsComplete(techStackClarifications)
                      ? '已完成'
                      : '未完成'}
                  </div>
                </div>

                {techStackClarifications.length ? (
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
                    onClick={() => void generateTasksFromDesign()}
                    disabled={
                      !selectedSpecName ||
                      Boolean(busyLabel) ||
                      !artifactContent.design.trim() ||
                      !techStackClarifications.length ||
                      !areClarificationsComplete(techStackClarifications)
                    }
                  >
                    确认技术栈并生成任务
                  </Button>
                </div>
              </div>
            )}

            <div className="mb-2 flex flex-wrap items-center gap-2">
              {activeArtifact === 'tasks' && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={taskView === 'tasks' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setTaskView('tasks')}
                      disabled={!selectedSpecName}
                    >
                      任务
                    </Button>
                    <Button
                      variant={taskView === 'atomic' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setTaskView('atomic')}
                      disabled={!selectedSpecName}
                    >
                      原子任务
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void startAtomizeTasks()}
                      disabled={
                        !selectedSpecName ||
                        Boolean(busyLabel) ||
                        !artifactContent.tasks.trim() ||
                        atomizeStatus?.running
                      }
                    >
                      {atomizeStatus?.running
                        ? '原子化中'
                        : atomizeStatus?.total &&
                            atomizeStatus.completed > 0 &&
                            atomizeStatus.completed < atomizeStatus.total
                          ? '继续原子化（下一段）'
                          : '开始原子化'}
                    </Button>
                    {atomizeStatus?.error && !atomizeStatus?.running && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void startAtomizeTasks()}
                        disabled={
                          !selectedSpecName ||
                          Boolean(busyLabel) ||
                          !artifactContent.tasks.trim() ||
                          atomizeStatus?.running
                        }
                      >
                        重试本段
                      </Button>
                    )}
                    <label className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-2 py-1 text-xs text-slate-300">
                      <span className="text-slate-400">分段</span>
                      <input
                        className="h-7 w-12 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100 outline-none focus:ring-2 focus:ring-accent"
                        value={atomizeBatchSizeText}
                        onChange={(e) => setAtomizeBatchSizeText(e.target.value.replace(/[^\d]/g, '').slice(0, 2))}
                        placeholder="3"
                        inputMode="numeric"
                      />
                      <span className="text-slate-400">条/次</span>
                    </label>
                    <label className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-2 py-1 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={atomizeAutoContinue}
                        onChange={(e) => setAtomizeAutoContinue(e.target.checked)}
                      />
                      <span className="text-slate-400">自动续段</span>
                    </label>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => void downloadAllZip()}
                    disabled={!selectedSpecName || Boolean(busyLabel)}
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

            {activeArtifact === 'tasks' && (
              <div className="mb-3 rounded-md border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold text-slate-200">原子化日志</div>
                  <div className="text-xs text-slate-400">
                    {atomizeStatus?.running ? '进行中' : '未运行'}
                  </div>
                  <div className="ml-auto text-xs text-slate-400">
                    {atomizeStatus?.total
                      ? `完成 ${atomizeStatus.completed}/${atomizeStatus.total}`
                      : '完成 0/0'}
                  </div>
                </div>
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

            <textarea
              className="h-[520px] w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent"
              value={displayContent}
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
          </div>
        </section>
      </main>

      {busyLabel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="w-[520px] max-w-[92vw] rounded-lg border border-slate-700 bg-slate-950 px-5 py-4 text-slate-100 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-500 border-t-slate-100" />
              <div className="text-sm font-semibold">
                {busyLabel}
                {streamStage ? ` · ${errorStageLabel(streamStage)}` : ''}
              </div>
              <div className="ml-auto text-xs text-slate-400">{busySeconds}s</div>
            </div>
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
