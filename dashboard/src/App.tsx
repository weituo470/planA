import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';

import { Button } from './components/ui/button';
import type { ClarificationQuestion, LlmInfo, LlmPingResult, SpecArtifact, SpecSummary } from './types';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:4100';

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
  lines.push('## 需求澄清', '');
  questions.forEach((q, i) => {
    const selectedIds = q.answer?.selectedOptionIds ?? [];
    const selectedLabels = q.options
      .filter((opt) => selectedIds.includes(opt.id))
      .map((opt) => opt.label)
      .filter(Boolean);
    const otherText = (q.answer?.otherText ?? '').trim();
    lines.push(`### Q${i + 1}. ${q.question}`);
    lines.push(`- 选择：${selectedLabels.length ? selectedLabels.join('、') : '（未选择）'}`);
    if (q.allowOther) lines.push(`- 其他：${otherText ? otherText : '（无）'}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function upsertClarificationsSection(markdown: string, questions: ClarificationQuestion[]) {
  const section = buildClarificationsMarkdown(questions);
  const text = markdown ?? '';
  const re = /^## 需求澄清[\s\S]*?(?=\n## |\n# |$)/m;
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
  const [error, setError] = useState<string | null>(null);

  const selectedSpec = useMemo(
    () => specs.find((s) => s.name === selectedSpecName) ?? null,
    [specs, selectedSpecName],
  );

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
        setArtifactContent((prev) => ({ ...prev, [artifact]: data.content ?? '' }));
      } catch (e: any) {
        const message = String(e?.message || e);
        if (e?.status === 404 && /Spec file not found/i.test(message)) {
          setArtifactContent((prev) => ({ ...prev, [artifact]: '' }));
          return;
        }
        throw e;
      }
    },
    [],
  );

  useEffect(() => {
    void refreshSpecs().catch((e) => setError(String(e?.message || e)));
    void refreshLlm().catch((e) => setError(String(e?.message || e)));
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
    void loadArtifact(selectedSpecName, activeArtifact).catch((e) => setError(String(e?.message || e)));
  }, [activeArtifact, loadArtifact, selectedSpecName]);

  const createSpec = useCallback(async () => {
    setError(null);
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
      setError(String(e?.message || e));
    } finally {
      setBusyLabel(null);
    }
  }, [loadArtifact, rawPrompt, refreshSpecs]);

  const saveArtifact = useCallback(
    async (artifact: SpecArtifact) => {
      if (!selectedSpecName) return;
      setError(null);
      try {
        await apiJson(`/specs/${encodeURIComponent(selectedSpecName)}/${artifact}`, {
          method: 'POST',
          body: JSON.stringify({ content: artifactContent[artifact] ?? '' }),
        });
        await refreshSpecs();
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    },
    [artifactContent, refreshSpecs, selectedSpecName],
  );

  const saveClarifications = useCallback(async () => {
    if (!selectedSpecName) return;
    setError(null);
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
      setError(String(e?.message || e));
    }
  }, [clarifications, refreshSpecs, selectedSpecName]);

  const applyClarificationsToRequirements = useCallback(async () => {
    const next = upsertClarificationsSection(artifactContent.requirements ?? '', clarifications);
    setArtifactContent((prev) => ({ ...prev, requirements: next }));
    await saveArtifact('requirements');
  }, [artifactContent.requirements, clarifications, saveArtifact]);

  const confirmRequirementsAndGenerateDesign = useCallback(async () => {
    if (!selectedSpecName) return;
    setError(null);
    setBusyLabel('生成中');
    try {
      if (!areClarificationsComplete(clarifications)) {
        throw new Error('请先完成所有必填的需求澄清');
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
      setError(String(e?.message || e));
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
    setError(null);
    setBusyLabel('生成中');
    try {
      await apiJson(`/specs/${encodeURIComponent(selectedSpecName)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ artifact: 'design' }),
      });
      await refreshSpecs();
      await loadArtifact(selectedSpecName, 'tasks');
      setActiveArtifact('tasks');
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusyLabel(null);
    }
  }, [loadArtifact, refreshSpecs, selectedSpecName]);

  const downloadCurrentMd = useCallback(() => {
    if (!selectedSpecName) return;
    const content = artifactContent[activeArtifact] ?? '';
    downloadMarkdown(`${selectedSpecName}-${activeArtifact}.md`, content);
  }, [activeArtifact, artifactContent, selectedSpecName]);

  const downloadCurrentPng = useCallback(async () => {
    if (!selectedSpecName) return;
    setError(null);
    setBusyLabel('生成中');
    try {
      const title = `${selectedSpecName} / ${artifactLabel(activeArtifact)}`;
      const content = artifactContent[activeArtifact] ?? '';
      const blob = await renderTextToPng(content, title);
      downloadBlob(`${selectedSpecName}-${activeArtifact}.png`, blob);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusyLabel(null);
    }
  }, [activeArtifact, artifactContent, selectedSpecName]);

  const downloadAllZip = useCallback(async () => {
    if (!selectedSpecName) return;
    setError(null);
    setBusyLabel('生成中');
    try {
      const zip = new JSZip();
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
        zip.file(`${selectedSpecName}-${a}.md`, content);
        const png = await renderTextToPng(content, title);
        zip.file(`${selectedSpecName}-${a}.png`, png);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(`${selectedSpecName}-artifacts.zip`, blob);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusyLabel(null);
    }
  }, [artifactContent, selectedSpecName]);

  const setModel = useCallback(async (model: string) => {
    setError(null);
    try {
      const data = await apiJson<LlmInfo>('/llm/model', {
        method: 'POST',
        body: JSON.stringify({ model }),
      });
      setLlm(data);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, []);

  const saveProvider = useCallback(
    async (providerId: string) => {
      setError(null);
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
        setError(String(e?.message || e));
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
                    setError('密码错误');
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
                    disabled={!selectedSpecName}
                  >
                    {artifactLabel(a)}
                  </Button>
                ))}
              </div>
            </div>

            {error && (
              <div className="mb-3 rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                {error}
              </div>
            )}

            {selectedSpecName && activeArtifact === 'requirements' && (
              <div className="mb-4 space-y-3 rounded-md border border-slate-800 bg-slate-900/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold text-slate-200">需求澄清</div>
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
                            {idx + 1}. {q.question}{' '}
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
                              <label key={opt.id} className="flex items-start gap-2 text-sm text-slate-200">
                                <input
                                  type={q.mode === 'single' ? 'radio' : 'checkbox'}
                                  name={`q-${q.id}`}
                                  checked={checked}
                                  onChange={(e) => {
                                    const nextSelected =
                                      q.mode === 'single'
                                        ? e.target.checked
                                          ? [opt.id]
                                          : []
                                        : e.target.checked
                                          ? Array.from(new Set([...selected, opt.id]))
                                          : selected.filter((id) => id !== opt.id);
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
                              <div>其他</div>
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
                                placeholder="可选"
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
                    variant="outline"
                    size="sm"
                    onClick={() => void saveClarifications()}
                    disabled={!selectedSpecName || Boolean(busyLabel)}
                  >
                    保存澄清
                  </Button>
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => void saveArtifact(activeArtifact)}
                disabled={!selectedSpecName || Boolean(busyLabel)}
              >
                保存
              </Button>
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

            <textarea
              className="h-[520px] w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-accent"
              value={artifactContent[activeArtifact] ?? ''}
              onChange={(e) =>
                setArtifactContent((prev) => ({
                  ...prev,
                  [activeArtifact]: e.target.value,
                }))
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
    </div>
  );
}
