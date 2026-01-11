import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../ui/button';
import { TaskDagGraph } from './TaskDagGraph';
import type { TaskGraph } from './types';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:4100';

type ToastType = 'info' | 'error';

type ParallelPolicy = 'serial' | 'conservative' | 'aggressive';

type CliToolInfo = {
  id: string;
  label?: string;
};

const PARALLEL_POLICY_MAX_RUNNING: Record<ParallelPolicy, number> = {
  serial: 1,
  conservative: 3,
  aggressive: 8,
};

const GLOBAL_LOCK_SCOPE_MARKERS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  '.env',
  '.env.local',
  '.env.production',
  'node_modules',
  'dist',
  'build',
  'prisma/schema.prisma',
  'prisma/migrations',
];

export type DagTask = {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  scope: string[];
  cliToolId?: string;
  estimated_complexity?: string;
  status?: 'pending' | 'running' | 'completed';
  done?: boolean;
  startedAt?: string;
  doneAt?: string;
};

type WorkspaceInfo = {
  defaultCwd: string | null;
  effectiveCwd: string;
  repoDir: string;
};

type PromptResponse = {
  ok?: boolean;
  prompt?: string;
  runDocPathAbs?: string;
  runDocContent?: string;
  runDocPath?: string;
  projectDir?: string;
  error?: string;
};

type SingleAgentPromptResponse = {
  ok?: boolean;
  prompt?: string;
  order?: string[];
  tasksCount?: number;
  projectDir?: string;
  error?: string;
};

function tryParseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeTaskStatus(value: unknown) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return 'pending' as const;
  if (raw === 'running' || raw === 'in_progress' || raw === 'in-progress') return 'running' as const;
  if (raw === 'completed' || raw === 'done') return 'completed' as const;
  return 'pending' as const;
}

function normalizeDagTask(input: any, index: number): DagTask | null {
  const obj = input && typeof input === 'object' ? input : null;
  if (!obj) return null;
  const id = String(obj.id ?? '').trim() || `TASK-${index + 1}`;
  const title = String(obj.title ?? '').trim();
  const description = String(obj.description ?? '').trim();
  const dependencies = Array.isArray(obj.dependencies)
    ? obj.dependencies.map((v: any) => String(v ?? '').trim()).filter(Boolean)
    : [];
  const scope = Array.isArray(obj.scope)
    ? obj.scope.map((v: any) => String(v ?? '').trim()).filter(Boolean)
    : [];
  const cliToolId = typeof obj.cliToolId === 'string' ? obj.cliToolId.trim() : '';
  const estimated_complexity =
    typeof obj.estimated_complexity === 'string' ? obj.estimated_complexity.trim() : undefined;
  const status = normalizeTaskStatus(obj.status);
  const done = obj.done === true || status === 'completed';
  const startedAt = typeof obj.startedAt === 'string' ? obj.startedAt.trim() : undefined;
  const doneAt = typeof obj.doneAt === 'string' ? obj.doneAt.trim() : undefined;
  return {
    id,
    title,
    description,
    dependencies,
    scope,
    ...(cliToolId ? { cliToolId } : {}),
    estimated_complexity,
    status: done ? 'completed' : status,
    done,
    startedAt,
    doneAt,
  };
}

function normalizeScopePathForConflict(value: string) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\/+/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function scopeHitsGlobalLock(scope: string[]) {
  if (!Array.isArray(scope) || scope.length === 0) return true;
  const normalized = scope.map((v) => normalizeScopePathForConflict(v)).filter(Boolean);
  return normalized.some((path) => {
    return GLOBAL_LOCK_SCOPE_MARKERS.some((marker) => {
      const normalizedMarker = normalizeScopePathForConflict(marker);
      if (!normalizedMarker) return false;
      if (path === normalizedMarker) return true;
      if (path.startsWith(`${normalizedMarker}/`)) return true;
      if (path.endsWith(`/${normalizedMarker}`)) return true;
      if (!normalizedMarker.includes('/') && path.includes(`/${normalizedMarker}/`)) return true;
      return false;
    });
  });
}

function scopesMayConflict(a: string, b: string) {
  const left = normalizeScopePathForConflict(a);
  const right = normalizeScopePathForConflict(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.startsWith(`${right}/`)) return true;
  if (right.startsWith(`${left}/`)) return true;
  return false;
}

function scopeListsMayConflict(a: string[], b: string[]) {
  // scope 为空时无法判断，保守处理为“可能冲突”，避免并发改动导致冲突。
  if (!a.length || !b.length) return true;
  for (const sa of a) {
    for (const sb of b) {
      if (scopesMayConflict(sa, sb)) return true;
    }
  }
  return false;
}

function formatTaskIdList(ids: string[], max = 3) {
  const list = ids.map((v) => String(v || '').trim()).filter(Boolean);
  const shown = list.slice(0, Math.max(1, Math.floor(max)));
  const rest = Math.max(0, list.length - shown.length);
  const text = rest > 0 ? `${shown.join(', ')} 等${rest}个` : shown.join(', ');
  return { text, full: list.join(', ') };
}

function extractTasksJsonBlockFromMarkdown(markdown: string) {
  const raw = String(markdown ?? '');
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const findMarker = (marker: string) =>
    lines.findIndex((line) => String(line || '').trim().toUpperCase() === marker);

  const start = findMarker('## TASKS_JSON');
  if (start < 0) return null;
  const endIdx = findMarker('## END_TASKS_JSON');
  const end = endIdx > start ? endIdx : lines.length;

  const blockLines = lines.slice(start + 1, end);
  if (!blockLines.length) return null;

  const first = String(blockLines[0] || '').trim();
  const last = String(blockLines[blockLines.length - 1] || '').trim();
  const hasOpenFence = first.startsWith('```');
  const hasCloseFence = last.startsWith('```');

  const begin = hasOpenFence ? 1 : 0;
  const finish = hasCloseFence ? blockLines.length - 1 : blockLines.length;
  const jsonText = blockLines.slice(begin, finish).join('\n').trim();
  if (!jsonText) return null;

  return {
    jsonText,
    startIndex: start,
    endIndex: endIdx,
    hasOpenFence,
    hasCloseFence,
    openFenceLine: hasOpenFence ? blockLines[0] : null,
    closeFenceLine: hasCloseFence ? blockLines[blockLines.length - 1] : null,
    lines,
  };
}

export function parseDagTasksFromTasksContent(tasksContent: string) {
  const raw = String(tasksContent ?? '').trim();
  if (!raw) return null;

  const direct = tryParseJson(raw);
  if (direct && typeof direct === 'object' && Array.isArray((direct as any).tasks)) {
    const tasks = (direct as any).tasks
      .map((t: any, idx: number) => normalizeDagTask(t, idx))
      .filter(Boolean) as DagTask[];
    return { mode: 'direct-json' as const, payload: direct as any, tasks };
  }

  const block = extractTasksJsonBlockFromMarkdown(raw);
  if (!block) return null;
  const payload = tryParseJson(block.jsonText);
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as any).tasks)) return null;
  const tasks = (payload as any).tasks
    .map((t: any, idx: number) => normalizeDagTask(t, idx))
    .filter(Boolean) as DagTask[];

  return { mode: 'markdown' as const, payload: payload as any, block, tasks };
}

export function replaceTasksJsonInContent(tasksContent: string, nextPayload: any) {
  const parsed = parseDagTasksFromTasksContent(tasksContent);
  if (!parsed) return null;

  if (parsed.mode === 'direct-json') {
    return `${JSON.stringify(nextPayload, null, 2)}\n`;
  }

  const block = parsed.block;
  if (!block) return null;

  const jsonLines = JSON.stringify(nextPayload, null, 2).split('\n');
  const nextLines: string[] = [];

  nextLines.push(...block.lines.slice(0, block.startIndex + 1));
  if (block.hasOpenFence && block.openFenceLine) nextLines.push(block.openFenceLine);
  nextLines.push(...jsonLines);
  if (block.hasCloseFence && block.closeFenceLine) nextLines.push(block.closeFenceLine);
  if (typeof block.endIndex === 'number' && block.endIndex >= 0) {
    nextLines.push(...block.lines.slice(block.endIndex));
  }

  return nextLines.join('\n');
}

function getTaskDone(task: DagTask) {
  return task.done === true || task.status === 'completed';
}

function extractFocusedRunDocForUi(content: string) {
  const text = String(content ?? '').trim();
  if (!text) return '';
  const marker = '## 本次任务';
  const idx = text.indexOf(marker);
  if (idx < 0) return text;
  return text.slice(idx).trim();
}

async function copyTextToClipboard(text: string) {
  const payload = String(text ?? '');
  if (!payload) return false;
  try {
    await navigator.clipboard.writeText(payload);
    return true;
  } catch {
    // ignore
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = payload;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function parseIsoMs(value: string | null | undefined) {
  const t = Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : null;
}

function formatDurationMs(ms: number | null) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${hours}h${String(mm).padStart(2, '0')}m`;
}

function buildTaskGraphFromDagTasks(tasks: DagTask[]): TaskGraph {
  const taskIds = new Set(tasks.map((t) => t.id));

  const nodes: TaskGraph['tasks'] = tasks.map((t) => ({
    id: t.id,
    title: t.title || t.id,
    description: t.description || '',
    level: 0,
    inDegree: 0,
    outDegree: 0,
    riskLevel: undefined,
    requiresInteraction: false,
    status: t.status,
    done: t.done,
    startedAt: t.startedAt,
    doneAt: t.doneAt,
  }));

  const edges: TaskGraph['edges'] = [];
  for (const task of tasks) {
    for (const dep of task.dependencies ?? []) {
      const depId = String(dep || '').trim();
      if (!depId || depId === task.id) continue;
      if (!taskIds.has(depId)) continue;
      edges.push({
        from: depId,
        to: task.id,
        type: 'explicit',
        strength: 'strong',
        description: 'depends-on',
      });
    }
  }

  const adjacency: TaskGraph['adjacency'] = {};
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  for (const node of nodes) {
    adjacency[node.id] = { in: [], out: [] };
    inDegree.set(node.id, 0);
    outDegree.set(node.id, 0);
  }

  for (const edge of edges) {
    if (!adjacency[edge.from] || !adjacency[edge.to]) continue;
    adjacency[edge.from].out.push({ from: edge.to, type: edge.type });
    adjacency[edge.to].in.push({ to: edge.from, type: edge.type });
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }
  queue.sort();

  const inDegreeWork = new Map(inDegree);
  const topologicalOrder: string[] = [];

  while (queue.length) {
    const id = queue.shift()!;
    topologicalOrder.push(id);
    for (const outEdge of adjacency[id]?.out ?? []) {
      const to = outEdge.from;
      const next = (inDegreeWork.get(to) ?? 0) - 1;
      inDegreeWork.set(to, next);
      if (next === 0) {
        queue.push(to);
        queue.sort();
      }
    }
  }

  const hasCycle = topologicalOrder.length !== nodes.length;
  const cycles = hasCycle
    ? nodes
        .map((n) => n.id)
        .filter((id) => (inDegreeWork.get(id) ?? 0) > 0)
        .sort()
    : [];

  const levelById = new Map<string, number>();
  for (const id of topologicalOrder) {
    const incoming = adjacency[id]?.in ?? [];
    let level = 0;
    for (const inc of incoming) {
      const from = inc.to;
      const prev = levelById.get(from) ?? 0;
      level = Math.max(level, prev + 1);
    }
    levelById.set(id, level);
  }

  let criticalPath: string[] = [];
  let totalDuration = 0;
  if (!hasCycle && topologicalOrder.length) {
    const dist = new Map<string, number>();
    const prev = new Map<string, string | null>();
    for (const id of topologicalOrder) {
      dist.set(id, 0);
      prev.set(id, null);
    }

    for (const id of topologicalOrder) {
      const base = dist.get(id) ?? 0;
      for (const outEdge of adjacency[id]?.out ?? []) {
        const to = outEdge.from;
        const next = base + 1;
        if (next > (dist.get(to) ?? 0)) {
          dist.set(to, next);
          prev.set(to, id);
        }
      }
    }

    let bestId = topologicalOrder[0];
    for (const id of topologicalOrder) {
      if ((dist.get(id) ?? 0) > (dist.get(bestId) ?? 0)) bestId = id;
    }

    totalDuration = (dist.get(bestId) ?? 0) + 1;
    const path: string[] = [];
    let cur: string | null | undefined = bestId;
    while (cur) {
      path.push(cur);
      cur = prev.get(cur) ?? null;
    }
    criticalPath = path.reverse();
  }

  for (const node of nodes) {
    node.inDegree = inDegree.get(node.id) ?? 0;
    node.outDegree = outDegree.get(node.id) ?? 0;
    node.level = levelById.get(node.id) ?? 0;
  }

  const groupMap = new Map<number, string[]>();
  for (const node of nodes) {
    const list = groupMap.get(node.level) ?? [];
    list.push(node.id);
    groupMap.set(node.level, list);
  }
  const parallelGroups = Array.from(groupMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([level, taskIds]) => ({
      level,
      taskIds: taskIds.sort(),
      canRunSimultaneously: true,
    }));

  return {
    tasks: nodes,
    edges,
    adjacency,
    topologicalOrder,
    hasCycle,
    cycles,
    parallelGroups,
    criticalPath: { path: criticalPath, totalDuration },
  };
}

export function ManualTaskRunner({
  specId,
  tasksContent,
  disabled,
  onSaveTasksContent,
  onToast,
  onRunPromptInClaudeAutoTerminal,
  onPauseClaudeAutoTerminals,
  onResumeClaudeAutoTerminals,
}: {
  specId: string;
  tasksContent: string;
  disabled?: boolean;
  onSaveTasksContent: (next: string) => Promise<void>;
  onToast: (message: string, type?: ToastType) => void;
  onRunPromptInClaudeAutoTerminal?: (
    prompt: string,
    context: {
      specId: string;
      taskId: string;
      doneMarker: string;
      failedMarker: string;
      cliToolId?: string;
    },
  ) => Promise<{ terminalId: string; title: string }>;
  onPauseClaudeAutoTerminals?: (specId: string) => Promise<{ paused: number; total: number }>;
  onResumeClaudeAutoTerminals?: (specId: string) => Promise<{ resumed: number; total: number }>;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [promptForTask, setPromptForTask] = useState<{
    taskId: string;
    prompt: string;
    runDocPathAbs?: string;
  } | null>(null);
  const [promptLoadingTaskId, setPromptLoadingTaskId] = useState<string | null>(null);
  const [singleAgentPrompt, setSingleAgentPrompt] = useState<{
    loading: boolean;
    error: string | null;
    prompt: string;
  }>({ loading: false, error: null, prompt: '' });
  const singleAgentPromptDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const [dagExpanded, setDagExpanded] = useState(true);
  const [dagResetKey, setDagResetKey] = useState(0);
  const [dagHeight, setDagHeight] = useState(() => {
    if (typeof window === 'undefined') return 560;
    return Math.max(560, Math.floor(window.innerHeight * 0.9));
  });

  useEffect(() => {
    const update = () => {
      setDagHeight(Math.max(560, Math.floor(window.innerHeight * 0.9)));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const [chainState, setChainState] = useState<'idle' | 'running' | 'paused'>('idle');
  const chainStateRef = useRef<'idle' | 'running' | 'paused'>(chainState);
  const chainBusyRef = useRef(false);
  const [chainBusy, setChainBusy] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => {
    chainStateRef.current = chainState;
    pausedRef.current = chainState === 'paused';
  }, [chainState]);
  useEffect(() => {
    chainBusyRef.current = chainBusy;
  }, [chainBusy]);

  const [parallelPolicy, setParallelPolicy] = useState<ParallelPolicy>('conservative');
  const [cliTools, setCliTools] = useState<CliToolInfo[]>([]);
  const [cliToolsLoading, setCliToolsLoading] = useState(false);
  const [cliToolsError, setCliToolsError] = useState<string | null>(null);

  const [taskDetailsOpenById, setTaskDetailsOpenById] = useState<Record<string, boolean>>({});
  const [taskDocById, setTaskDocById] = useState<
    Record<string, { loading: boolean; error: string | null; runDocPathAbs?: string; content?: string }>
  >({});

  const handleResetTaskListView = useCallback(() => {
    setPromptForTask(null);
    setSingleAgentPrompt({ loading: false, error: null, prompt: '' });
    if (singleAgentPromptDetailsRef.current) {
      singleAgentPromptDetailsRef.current.open = false;
    }
    setTaskDetailsOpenById({});
    setTaskDocById({});
  }, []);

  const autoContinueInitializedRef = useRef(false);
  const prevCompletedRef = useRef<Set<string>>(new Set());
  const autoContinueInFlightRef = useRef(false);
  const autoContinueQueuedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/workspace`);
        if (!res.ok) return;
        const data = (await res.json()) as WorkspaceInfo;
        if (cancelled) return;
        setWorkspace(data);
      } catch {
        // ignore
      }
    };
    void load();
    const handler = () => void load();
    window.addEventListener('workspace:changed', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('workspace:changed', handler);
    };
  }, []);

  const refreshCliTools = useCallback(async () => {
    setCliToolsLoading(true);
    setCliToolsError(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/cli-tools`);
      const data = res.ok ? await res.json() : null;
      if (!res.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));
      const list = Array.isArray(data?.tools) ? data.tools : [];
      const cleaned = list
        .map((t: any) => ({
          id: String(t?.id || '').trim(),
          label: typeof t?.label === 'string' ? t.label.trim() : '',
        }))
        .filter((t: any) => t.id);
      setCliTools(cleaned);
    } catch (e: any) {
      setCliTools([]);
      setCliToolsError(String(e?.message || e || '读取 CLI 工具失败'));
    } finally {
      setCliToolsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCliTools();
  }, [refreshCliTools]);

  const parsed = useMemo(() => parseDagTasksFromTasksContent(tasksContent), [tasksContent]);

  const tasks = useMemo(() => parsed?.tasks ?? [], [parsed]);
  const doneById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const task of tasks) map.set(task.id, getTaskDone(task));
    return map;
  }, [tasks]);
  const statusById = useMemo(() => {
    const map = new Map<string, DagTask['status']>();
    for (const task of tasks) {
      map.set(task.id, task.status ?? (getTaskDone(task) ? 'completed' : 'pending'));
    }
    return map;
  }, [tasks]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasStarted = useMemo(() => tasks.some((t) => parseIsoMs(t.startedAt) != null), [tasks]);
  const hasRunningTask = useMemo(
    () => tasks.some((t) => (statusById.get(t.id) ?? 'pending') === 'running'),
    [statusById, tasks],
  );
  const allDone = useMemo(
    () => tasks.length > 0 && tasks.every((t) => doneById.get(t.id) === true),
    [doneById, tasks],
  );

  useEffect(() => {
    if (!hasStarted) return;
    if (chainState === 'idle' && !hasRunningTask) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [chainState, hasRunningTask, hasStarted]);

  const totalElapsedText = useMemo(() => {
    if (!hasStarted) return '';
    const startedList = tasks.map((t) => parseIsoMs(t.startedAt)).filter((v) => v != null) as number[];
    if (!startedList.length) return '';
    const start = Math.min(...startedList);

    const doneList = tasks.map((t) => parseIsoMs(t.doneAt)).filter((v) => v != null) as number[];
    const maxDone = doneList.length ? Math.max(...doneList) : null;

    const end =
      allDone && maxDone != null
        ? maxDone
        : hasRunningTask || chainState !== 'idle'
          ? nowMs
          : maxDone ?? nowMs;
    return formatDurationMs(end - start);
  }, [allDone, chainState, hasRunningTask, hasStarted, nowMs, tasks]);

  const resourceBlockedById = useMemo(() => {
    const runningTasks = tasks.filter((t) => (statusById.get(t.id) ?? 'pending') === 'running');
    const map: Record<string, string[]> = {};
    for (const task of tasks) {
      const status = statusById.get(task.id) ?? (getTaskDone(task) ? 'completed' : 'pending');
      if (status !== 'pending') continue;
      const missingDeps = (task.dependencies || []).filter((depId) => !doneById.get(depId));
      if (missingDeps.length) continue;
      const blockers = runningTasks
        .filter((other) => other.id !== task.id)
        .filter((other) => {
          const scope = task.scope ?? [];
          const otherScope = other.scope ?? [];
          if (scopeHitsGlobalLock(scope)) return true;
          if (scopeHitsGlobalLock(otherScope)) return true;
          return scopeListsMayConflict(scope, otherScope);
        })
        .map((other) => other.id);
      if (blockers.length) map[task.id] = blockers;
    }
    return map;
  }, [doneById, statusById, tasks]);

  const taskGraph = useMemo(() => buildTaskGraphFromDagTasks(tasks), [tasks]);
  const taskStatusByIdForDag = useMemo(() => {
    const map: Record<string, 'pending' | 'running' | 'completed' | 'failed'> = {};
    for (const task of tasks) {
      const status = task.status ?? (getTaskDone(task) ? 'completed' : 'pending');
      map[task.id] = status === 'running' ? 'running' : status === 'completed' ? 'completed' : 'pending';
    }
    return map;
  }, [tasks]);
  const cliOptions = useMemo(() => {
    const list = [
      { id: 'builtin:claude', label: 'Claude Code（全自动）' },
      { id: 'builtin:codex', label: 'Codex' },
      ...cliTools.map((t) => ({
        id: String(t?.id || '').trim(),
        label: String(t?.label || '').trim() || String(t?.id || '').trim(),
      })),
    ].filter((t) => t.id);
    const seen = new Set<string>();
    return list.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [cliTools]);
  const defaultCliToolIdInFile = useMemo(() => {
    const raw = (parsed as any)?.payload?.defaultCliToolId;
    return typeof raw === 'string' ? raw.trim() : '';
  }, [parsed]);
  const effectiveDefaultCliToolId = defaultCliToolIdInFile || 'builtin:claude';
  const cliLabelById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const opt of cliOptions) {
      const id = String(opt?.id || '').trim();
      if (!id) continue;
      const label = String(opt?.label || '').trim();
      map[id] = label || id;
    }
    return map;
  }, [cliOptions]);
  const taskCliToolIdById = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    for (const task of tasks) {
      const raw = typeof task?.cliToolId === 'string' ? task.cliToolId.trim() : '';
      if (raw) map[task.id] = raw;
    }
    return map;
  }, [tasks]);
  const handleSetDefaultCliToolId = useCallback(
    async (nextToolIdRaw: string) => {
      if (disabled) return;
      const nextToolId = String(nextToolIdRaw || '').trim();
      if (!nextToolId) return;
      if (nextToolId === effectiveDefaultCliToolId) return;

      const parsedDoc = parseDagTasksFromTasksContent(tasksContent);
      if (!parsedDoc) {
        onToast('tasks.md 解析失败：找不到 TASKS_JSON', 'error');
        return;
      }

      const payload = parsedDoc.payload;
      const nextPayload = { ...payload, defaultCliToolId: nextToolId };
      const nextContent = replaceTasksJsonInContent(tasksContent, nextPayload);
      if (!nextContent) {
        onToast('写回 tasks.md 失败', 'error');
        return;
      }
      await onSaveTasksContent(nextContent);
      onToast(`已设置默认CLI：${cliLabelById[nextToolId] || nextToolId}`, 'info');
    },
    [cliLabelById, disabled, effectiveDefaultCliToolId, onSaveTasksContent, onToast, tasksContent],
  );
  const defaultCliOptionsForSelect = useMemo(() => {
    const exists = cliOptions.some((opt) => String(opt?.id || '').trim() === effectiveDefaultCliToolId);
    if (exists) return cliOptions;
    if (!effectiveDefaultCliToolId) return cliOptions;
    return [
      { id: effectiveDefaultCliToolId, label: `未知（${effectiveDefaultCliToolId}）` },
      ...cliOptions,
    ];
  }, [cliOptions, effectiveDefaultCliToolId]);

  const handleSetTaskCliToolId = useCallback(
    async (taskIdRaw: string, nextToolIdRaw: string) => {
      if (disabled) return;
      const taskId = String(taskIdRaw || '').trim();
      if (!taskId) return;

      const nextToolId = String(nextToolIdRaw || '').trim();
      const current = String(taskCliToolIdById?.[taskId] || '').trim();
      if (nextToolId === current) return;

      const parsedDoc = parseDagTasksFromTasksContent(tasksContent);
      if (!parsedDoc) {
        onToast('tasks.md 解析失败：找不到 TASKS_JSON', 'error');
        return;
      }

      const payload = parsedDoc.payload;
      const list = Array.isArray(payload?.tasks) ? payload.tasks : [];
      const idx = list.findIndex((t: any) => String(t?.id || '').trim() === taskId);
      if (idx < 0) {
        onToast(`找不到任务：${taskId}`, 'error');
        return;
      }

      const nextTask = { ...(list[idx] || {}) };
      if (nextToolId) {
        nextTask.cliToolId = nextToolId;
      } else {
        delete nextTask.cliToolId;
      }
      list[idx] = nextTask;

      const nextPayload = { ...payload, tasks: list };
      const nextContent = replaceTasksJsonInContent(tasksContent, nextPayload);
      if (!nextContent) {
        onToast('写回 tasks.md 失败', 'error');
        return;
      }
      await onSaveTasksContent(nextContent);
      const defaultLabel = cliLabelById[effectiveDefaultCliToolId] || effectiveDefaultCliToolId;
      onToast(
        nextToolId
          ? `已设置 ${taskId} CLI：${cliLabelById[nextToolId] || nextToolId}`
          : `已清除 ${taskId} CLI（默认：${defaultLabel}）`,
        'info',
      );
    },
    [
      cliLabelById,
      disabled,
      effectiveDefaultCliToolId,
      onSaveTasksContent,
      onToast,
      taskCliToolIdById,
      tasksContent,
    ],
  );

  const fetchPromptForTask = useCallback(
    async (task: DagTask) => {
      const deps = task.dependencies ?? [];
      const missing = deps.filter((depId) => !doneById.get(depId));
      if (missing.length) {
        throw new Error(`前置任务未完成：${missing.join(', ')}`);
      }

      const body = {
        specId,
        taskId: task.id,
        tasksContent,
        projectDir: workspace?.effectiveCwd ?? undefined,
      };
      const res = await fetch(`${BRIDGE_URL}/api/mvp5/task-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as PromptResponse;
      if (!res.ok) throw new Error(data?.error || '生成提示词失败');
      const prompt = String(data?.prompt || '').trim();
      if (!prompt) throw new Error('生成提示词失败：prompt 为空');
      return { prompt, runDocPathAbs: data.runDocPathAbs };
    },
    [doneById, specId, tasksContent, workspace?.effectiveCwd],
  );

  const fetchRunDocForTask = useCallback(
    async (task: DagTask) => {
      const body = {
        specId,
        taskId: task.id,
        tasksContent,
        projectDir: workspace?.effectiveCwd ?? undefined,
        includeDoc: true,
      };
      const res = await fetch(`${BRIDGE_URL}/api/mvp5/task-prompt?includeDoc=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as PromptResponse;
      if (!res.ok) throw new Error(data?.error || '读取任务文档失败');
      return {
        runDocPathAbs: typeof data?.runDocPathAbs === 'string' ? data.runDocPathAbs : undefined,
        runDocContent: typeof data?.runDocContent === 'string' ? data.runDocContent : '',
      };
    },
    [specId, tasksContent, workspace?.effectiveCwd],
  );

  const handleFetchSingleAgentPrompt = useCallback(async () => {
    setSingleAgentPrompt((prev) => ({ ...prev, loading: true, error: null }));
    if (singleAgentPromptDetailsRef.current) {
      singleAgentPromptDetailsRef.current.open = true;
      window.requestAnimationFrame(() => {
        singleAgentPromptDetailsRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      });
    }
    try {
      const body = {
        specId,
        tasksContent,
        projectDir: workspace?.effectiveCwd ?? undefined,
      };
      const res = await fetch(`${BRIDGE_URL}/api/mvp5/single-agent-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as SingleAgentPromptResponse;
      if (!res.ok) throw new Error(data?.error || '生成单AGENT提示词失败');
      const prompt = String(data?.prompt || '').trim();
      if (!prompt) throw new Error('生成单AGENT提示词失败：prompt 为空');
      setSingleAgentPrompt({ loading: false, error: null, prompt });
      onToast('已生成单AGENT提示词', 'info');
    } catch (e: any) {
      const message = String(e?.message || e || '生成单AGENT提示词失败');
      setSingleAgentPrompt((prev) => ({ ...prev, loading: false, error: message }));
      onToast(message, 'error');
    } finally {
      setSingleAgentPrompt((prev) => ({ ...prev, loading: false }));
    }
  }, [onToast, specId, tasksContent, workspace?.effectiveCwd]);

  const handleCopySingleAgentPrompt = useCallback(async () => {
    const prompt = String(singleAgentPrompt.prompt || '').trim();
    if (!prompt) return;
    const ok = await copyTextToClipboard(prompt);
    onToast(ok ? '已复制单AGENT提示词' : '复制失败', ok ? 'info' : 'error');
  }, [onToast, singleAgentPrompt.prompt]);

  const buildClaudePromptWithMarkers = useCallback((prompt: string, taskId: string) => {
    const doneMarker = `[[TASK_DONE ${taskId}]]`;
    const failedMarker = `[[TASK_FAILED ${taskId}]]`;
    const promptWithMarkers = [
      prompt,
      '',
      `TASK_ID=${taskId}`,
      '当你确认任务完成后，请在回复最后单独输出一行：[[TASK_DONE <TASK_ID>]]（将 <TASK_ID> 替换为上面的 TASK_ID 值，不要输出尖括号）',
      '如果无法完成，请在回复最后单独输出一行：[[TASK_FAILED <TASK_ID>]]（将 <TASK_ID> 替换为上面的 TASK_ID 值，不要输出尖括号）',
    ].join('\n');
    return { promptWithMarkers, doneMarker, failedMarker };
  }, []);

  const startTaskInClaudeAuto = useCallback(
    async (task: DagTask, reason: string) => {
      if (!onRunPromptInClaudeAutoTerminal) throw new Error('终端面板未就绪');
      const taskScope = task.scope ?? [];
      const taskGlobalLock = scopeHitsGlobalLock(taskScope);
      const maxRunning = PARALLEL_POLICY_MAX_RUNNING[parallelPolicy];
      const runningTasks = tasks.filter(
        (t) => t.id !== task.id && (statusById.get(t.id) ?? 'pending') === 'running',
      );
      if (runningTasks.length >= maxRunning) {
        const info = formatTaskIdList(
          runningTasks.map((t) => t.id),
          6,
        );
        throw new Error(
          `并行策略限制(${parallelPolicy})：运行中任务已达上限(${runningTasks.length}/${maxRunning})（${info.text}）`,
        );
      }
      const runningGlobalLockIds = runningTasks
        .filter((t) => scopeHitsGlobalLock(t.scope ?? []))
        .map((t) => t.id);
      if (runningGlobalLockIds.length) {
        const info = formatTaskIdList(runningGlobalLockIds, 6);
        throw new Error(`全局资源占用冲突：运行中任务占用全局资源（${info.text}）`);
      }
      if (taskGlobalLock && runningTasks.length) {
        const info = formatTaskIdList(
          runningTasks.map((t) => t.id),
          6,
        );
        throw new Error(`全局资源占用冲突：${task.id} 需要独占运行（${info.text}）`);
      }
      const runningConflicts = runningTasks
        .filter((t) => scopeListsMayConflict(taskScope, t.scope ?? []))
        .map((t) => t.id);
      if (runningConflicts.length) {
        const info = formatTaskIdList(runningConflicts, 6);
        throw new Error(`文件占用冲突：${task.id} 与运行中任务冲突（${info.text}）`);
      }
      const { prompt } = await fetchPromptForTask(task);
      const { promptWithMarkers, doneMarker, failedMarker } = buildClaudePromptWithMarkers(
        prompt,
        task.id,
      );
      const cliToolId =
        String(taskCliToolIdById?.[task.id] || '').trim() || String(effectiveDefaultCliToolId || '').trim();
      const created = await onRunPromptInClaudeAutoTerminal(promptWithMarkers, {
        specId,
        taskId: task.id,
        doneMarker,
        failedMarker,
        ...(cliToolId ? { cliToolId } : {}),
      });
      onToast(`已启动：${task.id} · ${created.title || 'Claude Code'} · ${reason}`, 'info');
      return created;
    },
    [
      buildClaudePromptWithMarkers,
      effectiveDefaultCliToolId,
      fetchPromptForTask,
      onRunPromptInClaudeAutoTerminal,
      onToast,
      parallelPolicy,
      specId,
      statusById,
      taskCliToolIdById,
      tasks,
    ],
  );

  const autoStartAllReadyTasks = useCallback(
    async (reason: string, options?: { force?: boolean }) => {
      const force = options?.force === true;
      if (!force && chainStateRef.current !== 'running') return;
      if (pausedRef.current) return;
      if (!onRunPromptInClaudeAutoTerminal) return;
      if (disabled) return;

      if (autoContinueInFlightRef.current) {
        autoContinueQueuedRef.current = true;
        return;
      }
      autoContinueInFlightRef.current = true;
      autoContinueQueuedRef.current = false;

      try {
        const readyTasks = tasks.filter((task) => {
          const done = doneById.get(task.id) === true;
          if (done) return false;
          const status = statusById.get(task.id) ?? 'pending';
          if (status !== 'pending') return false;
          const missingDeps = (task.dependencies || []).filter((depId) => !doneById.get(depId));
          return missingDeps.length === 0;
        });
        if (!readyTasks.length) return;

        const runningTasks = tasks.filter((t) => (statusById.get(t.id) ?? 'pending') === 'running');
        const runningCount = runningTasks.length;
        const maxRunning = PARALLEL_POLICY_MAX_RUNNING[parallelPolicy];
        if (runningCount >= maxRunning) return;
        if (runningTasks.some((t) => scopeHitsGlobalLock(t.scope ?? []))) return;

        const slots = Math.max(0, maxRunning - runningCount);
        const sortedReady = readyTasks.slice().sort((a, b) => a.id.localeCompare(b.id));
        const globalLockReady = sortedReady.filter((t) => scopeHitsGlobalLock(t.scope ?? []));
        const selected: DagTask[] = [];
        const skipped: DagTask[] = [];

        if (globalLockReady.length) {
          if (runningCount > 0) return;
          selected.push(globalLockReady[0]);
        } else {
          const runningScopes = runningTasks.map((t) => t.scope ?? []);
          const selectedScopes: string[][] = [];
          for (const task of sortedReady) {
            if (selected.length >= slots) break;
            const scope = task.scope ?? [];
            const conflictsRunning = runningScopes.some((s) => scopeListsMayConflict(scope, s));
            const conflictsSelected = selectedScopes.some((s) => scopeListsMayConflict(scope, s));
            if (conflictsRunning || conflictsSelected) {
              skipped.push(task);
              continue;
            }
            selected.push(task);
            selectedScopes.push(scope);
          }
        }
        if (!selected.length) return;

        const skippedText = skipped.length
          ? `（跳过 scope 冲突：${skipped.map((t) => t.id).join(', ')}）`
          : '';
        onToast(`任务链：启动 ${selected.map((t) => t.id).join(', ')}${skippedText}`, 'info');
        for (const task of selected) {
          if (pausedRef.current) break;
          try {
            await startTaskInClaudeAuto(task, `任务链(${reason})`);
          } catch (e: any) {
            onToast(
              `任务链启动失败：${task.id} · ${String(e?.message || e || '未知错误')}`,
              'error',
            );
          }
        }
      } finally {
        autoContinueInFlightRef.current = false;
        if (autoContinueQueuedRef.current) {
          autoContinueQueuedRef.current = false;
          window.setTimeout(() => {
            void autoStartAllReadyTasks('queued');
          }, 50);
        }
      }
    },
    [
      disabled,
      doneById,
      onRunPromptInClaudeAutoTerminal,
      onToast,
      parallelPolicy,
      startTaskInClaudeAuto,
      statusById,
      tasks,
    ],
  );

  useEffect(() => {
    const completed = new Set<string>();
    for (const task of tasks) {
      if (doneById.get(task.id) === true) completed.add(task.id);
    }

    if (!autoContinueInitializedRef.current) {
      autoContinueInitializedRef.current = true;
      prevCompletedRef.current = completed;
      return;
    }

    const prev = prevCompletedRef.current;
    const newlyCompleted = Array.from(completed).filter((id) => !prev.has(id));
    prevCompletedRef.current = completed;
    if (!newlyCompleted.length) return;
    void autoStartAllReadyTasks(`completed:${newlyCompleted.join(',')}`);
  }, [autoStartAllReadyTasks, doneById, tasks]);

  const handleGeneratePrompt = useCallback(
    async (
      task: DagTask,
      options?: { autoCopy?: boolean; showPanel?: boolean },
    ) => {
      const autoCopy = options?.autoCopy === true;
      const showPanel = options?.showPanel !== false;

      setPromptLoadingTaskId(task.id);
      try {
        const { prompt, runDocPathAbs } = await fetchPromptForTask(task);

        if (autoCopy) {
          const ok = await copyTextToClipboard(prompt);
          if (ok) {
            onToast('已自动复制任务提示词', 'info');
          } else {
            setPromptForTask({ taskId: task.id, prompt, runDocPathAbs });
            onToast('自动复制失败：已生成提示词，可手动复制', 'error');
          }
          return;
        }

        if (showPanel) {
          setPromptForTask({ taskId: task.id, prompt, runDocPathAbs });
        }
        onToast('已生成提示词（可复制发给 CLI）', 'info');
      } catch (e: any) {
        onToast(String(e?.message || e || '生成提示词失败'), 'error');
      } finally {
        setPromptLoadingTaskId(null);
      }
    },
    [fetchPromptForTask, onToast],
  );

  const loadTaskDoc = useCallback(
    async (task: DagTask, options?: { force?: boolean }) => {
      const taskId = String(task?.id || '').trim();
      if (!taskId) return;

      const existing = taskDocById[taskId];
      const hasContent = Boolean(existing?.content && !existing?.error);
      if (!options?.force && (existing?.loading || hasContent)) return;

      setTaskDocById((prev) => ({
        ...prev,
        [taskId]: { loading: true, error: null, runDocPathAbs: existing?.runDocPathAbs, content: existing?.content },
      }));

      try {
        const { runDocPathAbs, runDocContent } = await fetchRunDocForTask(task);
        setTaskDocById((prev) => ({
          ...prev,
          [taskId]: { loading: false, error: null, runDocPathAbs, content: runDocContent },
        }));
      } catch (e: any) {
        const message = String(e?.message || e || '读取任务文档失败');
        setTaskDocById((prev) => ({
          ...prev,
          [taskId]: {
            loading: false,
            error: message,
            runDocPathAbs: existing?.runDocPathAbs,
            content: existing?.content,
          },
        }));
      }
    },
    [fetchRunDocForTask, taskDocById],
  );

  const handleToggleTaskDetails = useCallback(
    (task: DagTask) => {
      const taskId = String(task?.id || '').trim();
      if (!taskId) return;
      const nextOpen = !(taskDetailsOpenById[taskId] === true);
      setTaskDetailsOpenById((prev) => ({ ...prev, [taskId]: nextOpen }));
      if (nextOpen) {
        void loadTaskDoc(task);
      }
    },
    [loadTaskDoc, taskDetailsOpenById],
  );

  const handleStartClaudeAuto = useCallback(
    async (task: DagTask) => {
      setPromptLoadingTaskId(task.id);
      try {
        await startTaskInClaudeAuto(task, '手动开始');
      } catch (e: any) {
        onToast(String(e?.message || e || '启动失败'), 'error');
      } finally {
        setPromptLoadingTaskId(null);
      }
    },
    [onToast, startTaskInClaudeAuto],
  );

  const handleMarkDone = useCallback(
    async (task: DagTask) => {
      if (disabled) return;
      const parsedDoc = parseDagTasksFromTasksContent(tasksContent);
      if (!parsedDoc) {
        onToast('tasks.md 解析失败：找不到 TASKS_JSON', 'error');
        return;
      }
      const payload = parsedDoc.payload;
      const list = Array.isArray(payload?.tasks) ? payload.tasks : [];
      const idx = list.findIndex((t: any) => String(t?.id || '').trim() === task.id);
      if (idx < 0) {
        onToast(`找不到任务：${task.id}`, 'error');
        return;
      }
      const nextTask = { ...(list[idx] || {}) };
      const nowIso = new Date().toISOString();
      nextTask.status = 'completed';
      nextTask.done = true;
      nextTask.doneAt = nowIso;
      const startedAt = typeof nextTask.startedAt === 'string' ? nextTask.startedAt.trim() : '';
      if (startedAt) nextTask.startedAt = startedAt;
      list[idx] = nextTask;

      const nextPayload = { ...payload, tasks: list };
      const nextContent = replaceTasksJsonInContent(tasksContent, nextPayload);
      if (!nextContent) {
        onToast('写回 tasks.md 失败', 'error');
        return;
      }
      await onSaveTasksContent(nextContent);
      onToast(`已提交完成：${task.id}`, 'info');
    },
    [disabled, onSaveTasksContent, onToast, tasksContent],
  );

  const handleMarkRunning = useCallback(
    async (task: DagTask) => {
      if (disabled) return;
      const deps = task.dependencies ?? [];
      const missing = deps.filter((depId) => !doneById.get(depId));
      if (missing.length) {
        onToast(`前置任务未完成：${missing.join(', ')}`, 'error');
        return;
      }
      const taskScope = task.scope ?? [];
      const taskGlobalLock = scopeHitsGlobalLock(taskScope);
      const runningTasks = tasks.filter(
        (t) => t.id !== task.id && (statusById.get(t.id) ?? 'pending') === 'running',
      );
      const runningGlobalLockIds = runningTasks
        .filter((t) => scopeHitsGlobalLock(t.scope ?? []))
        .map((t) => t.id);
      if (runningGlobalLockIds.length) {
        const info = formatTaskIdList(runningGlobalLockIds, 6);
        onToast(`全局资源占用冲突：运行中任务占用全局资源（${info.text}）`, 'error');
        return;
      }
      if (taskGlobalLock && runningTasks.length) {
        const info = formatTaskIdList(
          runningTasks.map((t) => t.id),
          6,
        );
        onToast(`全局资源占用冲突：${task.id} 需要独占运行（${info.text}）`, 'error');
        return;
      }
      const runningConflicts = runningTasks
        .filter((t) => scopeListsMayConflict(taskScope, t.scope ?? []))
        .map((t) => t.id);
      if (runningConflicts.length) {
        const info = formatTaskIdList(runningConflicts, 6);
        onToast(`文件占用冲突（运行中）：${info.text}`, 'error');
        return;
      }

      const parsedDoc = parseDagTasksFromTasksContent(tasksContent);
      if (!parsedDoc) {
        onToast('tasks.md 解析失败：找不到 TASKS_JSON', 'error');
        return;
      }
      const payload = parsedDoc.payload;
      const list = Array.isArray(payload?.tasks) ? payload.tasks : [];
      const idx = list.findIndex((t: any) => String(t?.id || '').trim() === task.id);
      if (idx < 0) {
        onToast(`找不到任务：${task.id}`, 'error');
        return;
      }
      const nextTask = { ...(list[idx] || {}) };
      const nowIso = new Date().toISOString();
      const hadDoneAt = typeof nextTask.doneAt === 'string' && nextTask.doneAt.trim();
      nextTask.status = 'running';
      nextTask.done = false;
      const startedAt = typeof nextTask.startedAt === 'string' ? nextTask.startedAt.trim() : '';
      nextTask.startedAt = hadDoneAt ? nowIso : startedAt || nowIso;
      delete nextTask.doneAt;
      list[idx] = nextTask;

      const nextPayload = { ...payload, tasks: list };
      const nextContent = replaceTasksJsonInContent(tasksContent, nextPayload);
      if (!nextContent) {
        onToast('写回 tasks.md 失败', 'error');
        return;
      }
      await onSaveTasksContent(nextContent);
      onToast(`已标记进行中：${task.id}`, 'info');
    },
    [disabled, doneById, onSaveTasksContent, onToast, statusById, tasks, tasksContent],
  );

  const taskActionsByIdForDag = useMemo(() => {
    const map: Record<
      string,
      {
        start: { label: string; title: string; disabled: boolean; onClick: () => void };
        running: { label: string; title: string; disabled: boolean; onClick: () => void };
        done: { label: string; title: string; disabled: boolean; onClick: () => void };
        cli?: {
          value: string;
          title: string;
          disabled: boolean;
          options: { value: string; label: string }[];
          onChange: (nextValue: string) => void;
        };
      }
    > = {};

    for (const task of tasks) {
      const done = doneById.get(task.id) === true;
      const status = statusById.get(task.id) ?? (done ? 'completed' : 'pending');
      const missingDeps = (task.dependencies || []).filter((depId) => !doneById.get(depId));
      const blocked = missingDeps.length > 0;
      const resourceBlockers = resourceBlockedById?.[task.id] ?? [];
      const resourceBlocked = resourceBlockers.length > 0;
      const resourceBlockedText = resourceBlocked ? formatTaskIdList(resourceBlockers, 3) : null;
      const promptLoading = promptLoadingTaskId === task.id;
      const defaultCliLabel = cliLabelById[effectiveDefaultCliToolId] || effectiveDefaultCliToolId;
      const selectedCliToolId = String(taskCliToolIdById?.[task.id] || '').trim();
      const effectiveCliToolId = selectedCliToolId || effectiveDefaultCliToolId;
      const effectiveCliLabel = cliLabelById[effectiveCliToolId] || effectiveCliToolId;
      const cliSelectDisabled =
        Boolean(disabled) || chainBusy || chainState === 'paused' || status === 'running' || done;
      const cliOptionsForTask: { value: string; label: string }[] = [
        { value: '', label: `默认（${defaultCliLabel}）` },
      ];
      const seenCliValues = new Set<string>(['']);
      for (const opt of cliOptions) {
        const id = String(opt?.id || '').trim();
        if (!id || seenCliValues.has(id)) continue;
        seenCliValues.add(id);
        cliOptionsForTask.push({ value: id, label: String(opt?.label || '').trim() || id });
      }
      if (selectedCliToolId && !seenCliValues.has(selectedCliToolId)) {
        cliOptionsForTask.splice(1, 0, {
          value: selectedCliToolId,
          label: `未知（${selectedCliToolId}）`,
        });
      }

      const startTitle = blocked
        ? `前置任务未完成：${missingDeps.join(', ')}`
        : resourceBlocked
          ? `文件占用冲突（运行中）：${resourceBlockedText?.text ?? resourceBlockers.join(', ')}`
          : `启动 ${effectiveCliLabel} 并执行任务`;

      map[task.id] = {
        cli: {
          value: selectedCliToolId,
          title: selectedCliToolId ? `当前：${effectiveCliLabel}` : `默认：${defaultCliLabel}`,
          disabled: cliSelectDisabled,
          options: cliOptionsForTask,
          onChange: (nextValue) => void handleSetTaskCliToolId(task.id, nextValue),
        },
        start: {
          label: promptLoading ? '生成中…' : '开始',
          title: startTitle,
          disabled:
            Boolean(disabled) ||
            done ||
            promptLoading ||
            chainState === 'paused' ||
            chainBusy ||
            blocked ||
            resourceBlocked ||
            status === 'running',
          onClick: () => void handleStartClaudeAuto(task),
        },
        running: {
          label: '进行中',
          title: blocked
            ? `被阻塞：${missingDeps.join(', ')}`
            : resourceBlocked
              ? `文件占用冲突（运行中）：${resourceBlockedText?.text ?? resourceBlockers.join(', ')}`
              : '标记进行中',
          disabled: Boolean(disabled) || done || blocked || resourceBlocked || status === 'running',
          onClick: () => void handleMarkRunning(task),
        },
        done: {
          label: '已完成',
          title: '标记已完成',
          disabled: Boolean(disabled) || done,
          onClick: () => void handleMarkDone(task),
        },
      };
    }

    return map;
  }, [
    cliLabelById,
    cliOptions,
    disabled,
    doneById,
    handleGeneratePrompt,
    handleMarkDone,
    handleMarkRunning,
    handleStartClaudeAuto,
    handleSetTaskCliToolId,
    chainBusy,
    chainState,
    effectiveDefaultCliToolId,
    promptLoadingTaskId,
    resourceBlockedById,
    statusById,
    taskCliToolIdById,
    tasks,
  ]);

  if (!parsed || !tasks.length) {
    return (
      <div className="h-[520px] w-full overflow-auto rounded-md border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-slate-200">
        <div className="text-slate-400">暂无可解析任务：请在 tasks.md 里提供 `## TASKS_JSON` 区块。</div>
      </div>
    );
  }

  return (
    <div className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-slate-100">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-slate-200">任务列表（Markdown）</div>
        <div className="text-xs text-slate-500">
          {workspace?.effectiveCwd ? (
            <>
              CLI 根目录（生效）：<span className="font-mono">{workspace.effectiveCwd}</span>
            </>
          ) : (
            'CLI 根目录：未加载'
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={singleAgentPrompt.loading}
            onClick={() => void handleFetchSingleAgentPrompt()}
          >
            {singleAgentPrompt.loading ? '生成中…' : '获取单AGENT提示词'}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleResetTaskListView}>
            回到初始
          </Button>
        </div>
      </div>

      <details className="mb-3 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
        <summary className="cursor-pointer select-none text-xs font-semibold text-slate-200">
          完整任务文档（tasks.md）
        </summary>
        <div className="mt-2">
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded border border-slate-800 bg-slate-950 px-2 py-2 text-xs text-slate-100">
            {tasksContent || ''}
          </pre>
        </div>
      </details>

      <details
        ref={singleAgentPromptDetailsRef}
        className="mb-3 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2"
        onToggle={(e) => {
          const el = e.currentTarget;
          if (!el.open) return;
          if (singleAgentPrompt.loading) return;
          if (String(singleAgentPrompt.prompt || '').trim()) return;
          void handleFetchSingleAgentPrompt();
        }}
      >
        <summary className="cursor-pointer select-none text-xs font-semibold text-slate-200">
          单AGENT提示词（供单CLI工具顺序执行）
        </summary>
        <div className="mt-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs text-slate-500">只包含必要信息，可直接复制给单个 CLI agent。</div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={singleAgentPrompt.loading}
                onClick={() => void handleFetchSingleAgentPrompt()}
              >
                {singleAgentPrompt.loading ? '生成中…' : '刷新'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!singleAgentPrompt.prompt}
                onClick={() => void handleCopySingleAgentPrompt()}
              >
                复制
              </Button>
            </div>
          </div>

          {singleAgentPrompt.error ? (
            <div className="mb-2 rounded border border-red-900/40 bg-red-950/20 px-2 py-1 text-xs text-red-200">
              生成失败：{singleAgentPrompt.error}
            </div>
          ) : null}

          {singleAgentPrompt.loading ? (
            <div className="text-xs text-slate-500">生成中…</div>
          ) : singleAgentPrompt.prompt ? (
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded border border-slate-800 bg-slate-950 px-2 py-2 text-xs text-slate-100">
              {singleAgentPrompt.prompt}
            </pre>
          ) : (
            <div className="text-xs text-slate-500">暂无内容，点击上方按钮生成。</div>
          )}
        </div>
      </details>

      <div className="mb-3 rounded-md border border-slate-800 bg-slate-950/40 px-2 py-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="text-xs font-semibold text-slate-200">DAG 图（依赖关系）</div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant={chainState === 'running' ? 'outline' : 'default'}
              disabled={Boolean(disabled) || chainBusy || (!onRunPromptInClaudeAutoTerminal && chainState === 'idle')}
              onClick={async () => {
                if (chainBusyRef.current) return;
                chainBusyRef.current = true;
                setChainBusy(true);
                try {
                  const current = chainStateRef.current;
                  if (current === 'idle') {
                    const cwd = String(workspace?.effectiveCwd || '').trim();
                    if (!cwd) throw new Error('CLI 根目录未加载');
                    const listRes = await fetch(`${BRIDGE_URL}/fs/list?path=${encodeURIComponent(cwd)}`);
                    const listData = await listRes.json().catch(() => null);
                    if (!listRes.ok) {
                      throw new Error(String(listData?.error || '目录检查失败'));
                    }
                    const entries = Array.isArray(listData?.entries) ? listData.entries : [];
                    if (entries.length > 0) {
                      const names = entries
                        .map((e: any) => String(e?.name || e?.path || '').trim())
                        .filter(Boolean);
                      const shown = names.slice(0, 6).join(', ');
                      const rest = Math.max(0, names.length - 6);
                      const ok = window.confirm(
                        `警告：CLI 根目录非空\\n路径：${cwd}\\n已有 ${names.length} 项：${shown}${rest > 0 ? ` 等${rest}项` : ''}\\n\\n仍要开始整个任务链吗？`,
                      );
                      if (!ok) return;
                    }
                    chainStateRef.current = 'running';
                    pausedRef.current = false;
                    setChainState('running');
                    void autoStartAllReadyTasks('global-start', { force: true });
                    return;
                  }
                  if (current === 'running') {
                    chainStateRef.current = 'paused';
                    pausedRef.current = true;
                    setChainState('paused');
                    autoContinueQueuedRef.current = false;
                    if (!onPauseClaudeAutoTerminals) throw new Error('终端不支持暂停');
                    await onPauseClaudeAutoTerminals(specId);
                    return;
                  }
                  chainStateRef.current = 'running';
                  pausedRef.current = false;
                  setChainState('running');
                  if (!onResumeClaudeAutoTerminals) throw new Error('终端不支持继续');
                  await onResumeClaudeAutoTerminals(specId);
                  void autoStartAllReadyTasks('global-resume', { force: true });
                } catch (e: any) {
                  onToast(String(e?.message || e || '操作失败'), 'error');
                } finally {
                  chainBusyRef.current = false;
                  setChainBusy(false);
                }
              }}
            >
              {chainBusy
                ? chainState === 'running'
                  ? '暂停中…'
                  : chainState === 'paused'
                    ? '继续中…'
                    : '启动中…'
                : chainState === 'running'
                  ? '暂停'
                  : chainState === 'paused'
                    ? '继续'
                    : '开始'}
            </Button>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>默认CLI</span>
              <select
                className="h-8 max-w-[220px] rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
                value={effectiveDefaultCliToolId}
                onChange={(e) => void handleSetDefaultCliToolId(e.target.value)}
                disabled={Boolean(disabled) || chainBusy || chainState !== 'idle'}
                title="任务未指定 CLI 时，使用此默认值"
              >
                {defaultCliOptionsForSelect.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label || opt.id}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>并行策略</span>
              <select
                className="h-8 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
                value={parallelPolicy}
                onChange={(e) => setParallelPolicy(e.target.value as ParallelPolicy)}
                disabled={Boolean(disabled) || chainBusy}
                title="更严格策略可降低同文件并发修改导致的冲突"
              >
                <option value="serial">串行(1)</option>
                <option value="conservative">保守(≤3)</option>
                <option value="aggressive">激进(≤8)</option>
              </select>
            </div>
            {totalElapsedText ? (
              <div className="text-xs text-slate-400">
                总耗时：<span className="font-mono text-slate-200">{totalElapsedText}</span>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setDagExpanded(true);
                setDagResetKey((prev) => prev + 1);
              }}
              className="text-xs text-slate-400 transition-colors hover:text-slate-200"
            >
              回到初始
            </button>
            <button
              type="button"
              onClick={() => setDagExpanded((prev) => !prev)}
              className="text-xs text-slate-400 transition-colors hover:text-slate-200"
            >
              {dagExpanded ? '收起' : '展开'}
            </button>
          </div>
        </div>
        {dagExpanded ? (
          <div className="mt-2">
            <TaskDagGraph
              graph={taskGraph}
              taskStatusById={taskStatusByIdForDag}
              resourceBlockedById={resourceBlockedById}
              taskActionsById={taskActionsByIdForDag}
              resetKey={dagResetKey}
              height={dagHeight}
            />
          </div>
        ) : (
          <div className="mt-2 px-1 text-xs text-slate-500">已收起</div>
        )}
      </div>

      <div className="mb-3 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full bg-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.45)]"
              aria-hidden="true"
            />
            <span>点击右侧“进行中”状态灯，写回 tasks.md</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full bg-green-400 shadow-[0_0_10px_rgba(34,197,94,0.45)]"
              aria-hidden="true"
            />
            <span>点击右侧“已完成”状态灯，写回 tasks.md</span>
          </div>
          <div className="text-slate-500">（被阻塞任务需先完成前置）</div>
        </div>
      </div>

      <div className="space-y-3">
         {tasks.map((task) => {
           const done = doneById.get(task.id) === true;
           const status = statusById.get(task.id) ?? (done ? 'completed' : 'pending');
            const missingDeps = (task.dependencies || []).filter((depId) => !doneById.get(depId));
            const blocked = missingDeps.length > 0;
            const blockedInfo = blocked ? formatTaskIdList(missingDeps, 3) : null;
            const resourceBlockers = resourceBlockedById?.[task.id] ?? [];
            const resourceBlocked = resourceBlockers.length > 0;
            const resourceBlockedInfo = resourceBlocked
              ? formatTaskIdList(resourceBlockers, 3)
              : null;
            const ready = !blocked && !resourceBlocked && status === 'pending';
            const showPrompt = promptForTask?.taskId === task.id;
            const detailsOpen = taskDetailsOpenById[task.id] === true;
            const docState = taskDocById[task.id];

           return (
             <div
               key={task.id}
               className="rounded-md border border-slate-800 bg-slate-950/40 p-3"
             >
              <div className="flex flex-wrap items-start gap-2">
                <div className="text-xs font-semibold text-slate-100">{task.id}</div>
                <div className="text-xs text-slate-300">{task.title || ''}</div>
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      status === 'completed'
                        ? 'bg-green-400'
                        : status === 'running'
                          ? 'bg-blue-300'
                          : blocked || resourceBlocked
                            ? 'bg-amber-300'
                            : ready
                              ? 'bg-purple-400'
                              : 'bg-slate-600'
                    }`}
                    aria-hidden="true"
                  />
                  <span
                    className={`${
                      status === 'completed'
                        ? 'text-green-400'
                        : status === 'running'
                          ? 'text-blue-300'
                          : blocked || resourceBlocked
                            ? 'text-amber-300'
                            : ready
                              ? 'text-purple-300'
                              : 'text-slate-500'
                    }`}
                    title={
                      blockedInfo
                        ? `被阻塞：${blockedInfo.full}`
                        : resourceBlockedInfo
                          ? `文件占用：${resourceBlockedInfo.full}`
                          : undefined
                    }
                  >
                    {status === 'completed'
                      ? '已完成'
                      : status === 'running'
                        ? '进行中'
                         : blocked
                           ? `被阻塞：${blockedInfo?.text ?? missingDeps.join(', ')}`
                           : resourceBlocked
                             ? `文件占用：${resourceBlockedInfo?.text ?? resourceBlockers.join(', ')}`
                           : ready
                             ? '可开始'
                             : '未开始'}
                   </span>
                 </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => handleToggleTaskDetails(task)}>
                    {detailsOpen ? '收起详情' : '查看详情'}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      void handleGeneratePrompt(task, { autoCopy: true, showPanel: false })
                    }
                    disabled={disabled || done || promptLoadingTaskId === task.id}
                  >
                    {promptLoadingTaskId === task.id ? '生成中…' : '复制任务提示词'}
                  </Button>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void handleMarkRunning(task)}
                      disabled={disabled || done || blocked || resourceBlocked || status === 'running'}
                      className={`group inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs transition-colors hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-40 ${
                        status === 'running' ? 'text-blue-300' : 'text-slate-400'
                      }`}
                      title="点亮=进行中"
                      aria-label="标记进行中"
                    >
                      <span
                        className={`h-3 w-3 rounded-full bg-slate-700 transition-colors ${
                          status === 'running'
                            ? 'bg-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.55)]'
                            : 'group-hover:bg-blue-400/70'
                        }`}
                        aria-hidden="true"
                      />
                      <span>进行中</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleMarkDone(task)}
                      disabled={disabled || done}
                      className={`group inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs transition-colors hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-green-500/30 disabled:cursor-not-allowed disabled:opacity-40 ${
                        status === 'completed' || done ? 'text-green-400' : 'text-slate-400'
                      }`}
                      title="点亮=已完成"
                      aria-label="标记已完成"
                    >
                      <span
                        className={`h-3 w-3 rounded-full bg-slate-700 transition-colors ${
                          status === 'completed' || done
                            ? 'bg-green-400 shadow-[0_0_10px_rgba(34,197,94,0.55)]'
                            : 'group-hover:bg-green-400/70'
                        }`}
                        aria-hidden="true"
                      />
                      <span>已完成</span>
                    </button>
                  </div>
                </div>
              </div>

              {detailsOpen ? (
                <>
                  {blocked ? (
                    <div className="mt-2 rounded border border-amber-900/40 bg-amber-950/20 px-2 py-1 text-xs text-amber-300">
                      前置任务未完成：{missingDeps.join(', ')}
                    </div>
                  ) : null}
                  {resourceBlocked ? (
                    <div className="mt-2 rounded border border-amber-900/40 bg-amber-950/20 px-2 py-1 text-xs text-amber-300">
                      文件占用冲突（运行中）：{resourceBlockers.join(', ')}
                    </div>
                  ) : null}

                  <div className="mt-2 whitespace-pre-wrap text-xs text-slate-300">
                    {task.description || '（无描述）'}
                  </div>

                  {task.dependencies?.length ? (
                    <div className="mt-2 text-xs text-slate-400">
                      前置：{task.dependencies.join(', ')}
                    </div>
                  ) : null}

                  {task.scope?.length ? (
                    <div className="mt-1 text-xs text-slate-500">scope：{task.scope.join(', ')}</div>
                  ) : null}

                  <div className="mt-3 rounded border border-slate-800 bg-slate-950 p-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-200">任务文档</div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void loadTaskDoc(task, { force: true })}
                          disabled={docState?.loading === true}
                        >
                          {docState?.loading ? '加载中…' : '刷新'}
                        </Button>
                      </div>
                    </div>

                    {docState?.error ? (
                      <div className="mb-2 rounded border border-red-900/40 bg-red-950/20 px-2 py-1 text-xs text-red-200">
                        读取失败：{docState.error}
                      </div>
                    ) : null}

                    {docState?.loading ? (
                      <div className="text-xs text-slate-500">加载中…</div>
                    ) : docState?.content ? (
                      <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded border border-slate-800 bg-slate-950 px-2 py-2 text-xs text-slate-100">
                        {extractFocusedRunDocForUi(docState.content)}
                      </pre>
                    ) : (
                      <div className="text-xs text-slate-500">暂无文档内容</div>
                    )}
                  </div>

                  {showPrompt ? (
                    <div className="mt-3 rounded border border-slate-800 bg-slate-950 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-slate-200">任务提示词</div>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setPromptForTask(null)}>
                            收起
                          </Button>
                        </div>
                      </div>
                      <pre className="whitespace-pre-wrap break-words rounded border border-slate-800 bg-slate-950 px-2 py-2 text-xs text-slate-100">
                        {promptForTask.prompt}
                      </pre>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
