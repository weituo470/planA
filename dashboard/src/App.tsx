import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';

import { Button } from './components/ui/button';
import type { ClarificationQuestion, LlmInfo, LlmPingResult, SpecArtifact, SpecSummary } from './types';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:4100';
const DOWNLOAD_PREFIX = 'planA-v0.1';

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

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
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

function humanizeError(e: any) {
  const status = Number(e?.status || 0) || null;
  const msg = String(e?.message || e || '').trim();

  if (!msg) return '发生未知错误';
  if (status === 409 && /Design not confirmed/i.test(msg)) return '设计尚未生成，请先生成设计。';
  if (status === 409 && /Requirements not confirmed/i.test(msg)) return '需求尚未确认，请先完成需求确认并生成设计。';
  if (status === 409 && /clarifications incomplete/i.test(msg)) return '需求确认未完成，请先完成必填项。';
  if (status === 404 && /Spec file not found/i.test(msg)) return '文档尚未生成。';
  if (/Failed to fetch/i.test(msg)) return '无法连接到服务，请检查 bridge 地址/反代配置。';
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
  const [llm, setLlm] = useState<LlmInfo | null>(null);
  const [modelPing, setModelPing] = useState<
    Record<
      string,
      { status: 'pending' | 'ok' | 'error' | 'unsupported'; latencyMs?: number; error?: string }
    >
  >({});
  const [showLlmConfig, setShowLlmConfig] = useState(false);
  const [llmConfigUnlocked, setLlmConfigUnlocked] = useState(false);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, { baseUrl: string; apiKey: string }>>({});
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const busyStartedAtRef = useRef<number | null>(null);
  const [busySeconds, setBusySeconds] = useState(0);
  const [toast, setToast] = useState<{ message: string; tone: 'error' | 'info' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const clarifSaveTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string, tone: 'error' | 'info' = 'error') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4500);
  }, []);

  const selectedSpec = useMemo(
    () => specs.find((s) => s.name === selectedSpecName) ?? null,
    [specs, selectedSpecName],
  );
  const canOpenDesign = Boolean(selectedSpecName && (selectedSpec?.files?.design || selectedSpec?.status?.requirementsConfirmed));
  const canOpenTasks = Boolean(selectedSpecName && (selectedSpec?.files?.tasks || selectedSpec?.status?.designConfirmed));

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
              setModelPing((prev) => ({
                ...prev,
                [opt.id]: { status: 'error', error: result.error || '错误' },
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
              [opt.id]: { status: 'error', error: String(e?.message || e) },
            }));
          }
        }),
      );
    }
  }, []);

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

  useEffect(() => {
    void refreshSpecs().catch((e) => showToast(humanizeError(e)));
    void refreshLlm().catch((e) => showToast(humanizeError(e)));
  }, [refreshLlm, refreshSpecs]);

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
  }, [selectedSpec]);

  useEffect(() => {
    if (!selectedSpecName) return;
    if (activeArtifact === 'tasks' && !canOpenTasks) {
      setActiveArtifact(canOpenDesign ? 'design' : 'requirements');
      return;
    }
    if (activeArtifact === 'design' && !canOpenDesign) {
      setActiveArtifact('requirements');
      return;
    }
    void loadArtifact(selectedSpecName, activeArtifact).catch((e) => showToast(humanizeError(e)));
  }, [activeArtifact, canOpenDesign, canOpenTasks, loadArtifact, selectedSpecName]);

  const createSpec = useCallback(async () => {
    setToast(null);
    setBusyLabel('生成中');
    try {
      const data = await apiJson<{ name: string }>('/specs', {
        method: 'POST',
        body: JSON.stringify({ prompt: rawPrompt }),
      });
      await refreshSpecs();
      setSelectedSpecName(data.name);
      setActiveArtifact('requirements');
      await loadArtifact(data.name, 'requirements');
    } catch (e: any) {
      showToast(humanizeError(e));
    } finally {
      setBusyLabel(null);
    }
  }, [loadArtifact, rawPrompt, refreshSpecs]);

  const saveArtifact = useCallback(
    async (artifact: SpecArtifact) => {
      if (!selectedSpecName) return;
      try {
        await apiJson(`/specs/${encodeURIComponent(selectedSpecName)}/${artifact}`, {
          method: 'POST',
          body: JSON.stringify({ content: artifactContent[artifact] ?? '' }),
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
    await saveArtifact('requirements');
  }, [artifactContent.requirements, clarifications, saveArtifact]);

  const confirmRequirementsAndGenerateDesign = useCallback(async () => {
    if (!selectedSpecName) return;
    setToast(null);
    setBusyLabel('生成中');
    try {
      if (!areClarificationsComplete(clarifications)) {
        throw new Error('请先完成所有必填的需求确认');
      }
      await saveClarifications();
      await applyClarificationsToRequirements();
      await apiJson(`/specs/${encodeURIComponent(selectedSpecName)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ artifact: 'requirements', requirementsClarifications: { questions: clarifications } }),
      });
      await refreshSpecs();
      await loadArtifact(selectedSpecName, 'design');
      setActiveArtifact('design');
    } catch (e: any) {
      showToast(humanizeError(e));
    } finally {
      setBusyLabel(null);
    }
  }, [
    applyClarificationsToRequirements,
    clarifications,
    loadArtifact,
    refreshSpecs,
    saveClarifications,
    selectedSpecName,
  ]);

  const generateTasksFromDesign = useCallback(async () => {
    if (!selectedSpecName) return;
    setToast(null);
    setBusyLabel('生成中');
    try {
      const hasExistingTasks = Boolean(selectedSpec?.files?.tasks);
      if (hasExistingTasks) {
        const ok = window.confirm('将覆盖现有任务文档（tasks），是否继续？');
        if (!ok) return;
      }
      await apiJson(`/specs/${encodeURIComponent(selectedSpecName)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ artifact: 'design', force: true }),
      });
      await refreshSpecs();
      await loadArtifact(selectedSpecName, 'tasks');
      setActiveArtifact('tasks');
    } catch (e: any) {
      showToast(humanizeError(e));
    } finally {
      setBusyLabel(null);
    }
  }, [loadArtifact, refreshSpecs, selectedSpec, selectedSpecName]);

  const downloadCurrentMd = useCallback(() => {
    if (!selectedSpecName) return;
    const content = artifactContent[activeArtifact] ?? '';
    const base = makeDownloadBaseName(selectedSpecName);
    downloadMarkdown(`${base}_${activeArtifact}.md`, content);
  }, [activeArtifact, artifactContent, selectedSpecName]);

  const downloadCurrentPng = useCallback(async () => {
    if (!selectedSpecName) return;
    setToast(null);
    setBusyLabel('生成中');
    try {
      const title = `${selectedSpecName} / ${artifactLabel(activeArtifact)}`;
      const content = artifactContent[activeArtifact] ?? '';
      const blob = await renderTextToPng(content, title);
      const base = makeDownloadBaseName(selectedSpecName);
      downloadBlob(`${base}_${activeArtifact}.png`, blob);
    } catch (e: any) {
      showToast(humanizeError(e));
    } finally {
      setBusyLabel(null);
    }
  }, [activeArtifact, artifactContent, selectedSpecName]);

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
          '本压缩包包含 3 份核心文档（requirements/design/tasks），用于在 AI IDE 中执行类似 Kiro 的“规范驱动开发（Spec-Driven Development）”。',
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
          '- 用途：可执行的任务清单与执行记录入口（强烈建议 AI IDE 以此文件驱动实现）。',
          '- 工作方式：',
          '  a) AI IDE 读取 tasks.md，逐条实现任务；',
          '  b) 每完成一项就勾选（- [x]）并在任务下补充“实现说明/变更文件/验证结果”；',
          '  c) 如发现遗漏，先更新 tasks.md 再写代码，保持任务与代码同步。',
          '',
          '推荐流程（类似 Kiro）：',
          '1. 写原始需求 → 生成 requirements',
          '2. 完成“需求确认” → 生成 design',
          '3. 从 design 生成 tasks',
          '4. 将 requirements/design/tasks 提供给你的 AI 编程工具/IDE，要求它：',
          '   - 以 requirements/design 作为约束与上下文',
          '   - 以 tasks.md 作为执行计划与完成记录',
          '   - 只在 tasks.md 明确的范围内改代码，并持续回写 tasks.md',
          '',
          '提示：当你要加功能或改需求时，先更新 requirements/design/tasks，再让 AI IDE 继续执行。',
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
      return `${base} · 错误`;
    },
    [modelPing, normalizeModelLabel],
  );

  const activeModelId = llm?.model ?? '';
  const activePing = activeModelId ? modelPing[activeModelId] : null;

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
                        : 'text-xs text-slate-400'
                  }
                >
                  {activePing.status === 'pending'
                    ? '检测中…'
                    : activePing.status === 'ok'
                      ? `连接 ${Math.max(0, Math.round(activePing.latencyMs ?? 0))}ms`
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
                    : '错误';
              const color =
                ping.status === 'ok'
                  ? 'text-green-400'
                  : ping.status === 'error'
                    ? 'text-red-400'
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
                      (a === 'design' && !canOpenDesign) ||
                      (a === 'tasks' && !canOpenTasks)
                    }
                  >
                    {artifactLabel(a)}
                  </Button>
                ))}
              </div>
            </div>

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

            <div className="mb-2 flex flex-wrap items-center gap-2">
              {activeArtifact === 'design' && (
                <Button
                  size="sm"
                  onClick={() => void generateTasksFromDesign()}
                  disabled={!selectedSpecName || Boolean(busyLabel)}
                >
                  生成任务
                </Button>
              )}
              {activeArtifact === 'tasks' && (
                <Button
                  size="sm"
                  onClick={() => void downloadAllZip()}
                  disabled={!selectedSpecName || Boolean(busyLabel)}
                >
                  一键下载（ZIP）
                </Button>
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

            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <div>可按需编辑内容</div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={undoEdit}
                  disabled={!selectedSpecName || historyState[activeArtifact].undo === 0}
                >
                  撤销
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={redoEdit}
                  disabled={!selectedSpecName || historyState[activeArtifact].redo === 0}
                >
                  还原
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetToBaseline}
                  disabled={!selectedSpecName}
                >
                  回到初始
                </Button>
              </div>
            </div>

            <textarea
              className="h-[520px] w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent"
              value={artifactContent[activeArtifact] ?? ''}
              onChange={(e) =>
                setArtifactContent((prev) => {
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
            />
          </div>
        </section>
      </main>

      {busyLabel && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40">
          <div className="w-[520px] max-w-[90vw] rounded-lg border border-slate-700 bg-slate-950 px-5 py-4 text-slate-100 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-500 border-t-slate-100" />
              <div className="text-sm font-semibold">{busyLabel}</div>
              <div className="ml-auto text-xs text-slate-400">{busySeconds}s</div>
            </div>
            <div className="mt-3 text-xs leading-5 text-slate-300">
              <div>生成过程可能需要几十秒，请保持页面打开。</div>
              {busySeconds >= 20 && (
                <div className="mt-1 text-slate-400">
                  若长时间无响应：检查模型是否可用、Base URL/Key 是否正确、以及反代是否能访问到 bridge。
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
