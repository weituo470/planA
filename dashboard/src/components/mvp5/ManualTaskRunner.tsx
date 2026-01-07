import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../ui/button';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:4100';

type ToastType = 'info' | 'error';

export type DagTask = {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  scope: string[];
  estimated_complexity?: string;
  status?: 'pending' | 'running' | 'completed';
  done?: boolean;
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
  runDocPath?: string;
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
  const estimated_complexity =
    typeof obj.estimated_complexity === 'string' ? obj.estimated_complexity.trim() : undefined;
  const status = normalizeTaskStatus(obj.status);
  const done = obj.done === true || status === 'completed';
  const doneAt = typeof obj.doneAt === 'string' ? obj.doneAt.trim() : undefined;
  return { id, title, description, dependencies, scope, estimated_complexity, status: done ? 'completed' : status, done, doneAt };
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

function parseDagTasksFromTasksContent(tasksContent: string) {
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

function replaceTasksJsonInContent(tasksContent: string, nextPayload: any) {
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

export function ManualTaskRunner({
  specId,
  tasksContent,
  disabled,
  onSaveTasksContent,
  onToast,
}: {
  specId: string;
  tasksContent: string;
  disabled?: boolean;
  onSaveTasksContent: (next: string) => Promise<void>;
  onToast: (message: string, type?: ToastType) => void;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [promptForTask, setPromptForTask] = useState<{
    taskId: string;
    prompt: string;
    runDocPathAbs?: string;
  } | null>(null);
  const [promptLoadingTaskId, setPromptLoadingTaskId] = useState<string | null>(null);

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

  const parsed = useMemo(() => parseDagTasksFromTasksContent(tasksContent), [tasksContent]);

  const tasks = useMemo(() => parsed?.tasks ?? [], [parsed]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
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

  const handleGeneratePrompt = useCallback(
    async (task: DagTask) => {
      const deps = task.dependencies ?? [];
      const missing = deps.filter((depId) => !doneById.get(depId));
      if (missing.length) {
        onToast(`前置任务未完成：${missing.join(', ')}`, 'error');
        return;
      }

      setPromptLoadingTaskId(task.id);
      try {
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
        setPromptForTask({ taskId: task.id, prompt, runDocPathAbs: data.runDocPathAbs });
        onToast('已生成提示词（可复制发给 CLI）', 'info');
      } catch (e: any) {
        onToast(String(e?.message || e || '生成提示词失败'), 'error');
      } finally {
        setPromptLoadingTaskId(null);
      }
    },
    [doneById, onToast, specId, tasksContent, workspace?.effectiveCwd],
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
      nextTask.status = 'completed';
      nextTask.done = true;
      nextTask.doneAt = new Date().toISOString();
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
      nextTask.status = 'running';
      nextTask.done = false;
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
    [disabled, doneById, onSaveTasksContent, onToast, tasksContent],
  );

  if (!parsed || !tasks.length) {
    return (
      <div className="h-[520px] w-full overflow-auto rounded-md border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-slate-200">
        <div className="text-slate-400">暂无可解析任务：请在 tasks.md 里提供 `## TASKS_JSON` 区块。</div>
      </div>
    );
  }

  return (
    <div className="h-[520px] w-full overflow-auto rounded-md border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-slate-100">
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
      </div>

      <div className="space-y-3">
        {tasks.map((task) => {
          const done = doneById.get(task.id) === true;
          const status = statusById.get(task.id) ?? (done ? 'completed' : 'pending');
          const missingDeps = (task.dependencies || []).filter((depId) => !doneById.get(depId));
          const blocked = missingDeps.length > 0;
          const showPrompt = promptForTask?.taskId === task.id;

          return (
            <div
              key={task.id}
              className="rounded-md border border-slate-800 bg-slate-950/40 p-3"
            >
              <div className="flex flex-wrap items-start gap-2">
                <div className="text-xs font-semibold text-slate-100">{task.id}</div>
                <div className="text-xs text-slate-300">{task.title || ''}</div>
                <div
                  className={`text-xs ${
                    status === 'completed'
                      ? 'text-green-400'
                      : status === 'running'
                        ? 'text-blue-300'
                        : 'text-slate-500'
                  }`}
                >
                  {status === 'completed' ? '已完成' : status === 'running' ? '进行中' : blocked ? '被前置任务阻塞' : '未开始'}
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => void handleGeneratePrompt(task)}
                    disabled={disabled || done || promptLoadingTaskId === task.id}
                  >
                    {promptLoadingTaskId === task.id ? '生成中…' : '开始'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleMarkRunning(task)}
                    disabled={disabled || done || blocked || status === 'running'}
                  >
                    进行中
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleMarkDone(task)}
                    disabled={disabled || done}
                  >
                    已完成提交
                  </Button>
                </div>
              </div>

              {blocked ? (
                <div className="mt-2 rounded border border-amber-900/40 bg-amber-950/20 px-2 py-1 text-xs text-amber-300">
                  前置任务未完成：{missingDeps.join(', ')}
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

              {showPrompt ? (
                <div className="mt-3 rounded border border-slate-800 bg-slate-950 p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-slate-200">任务提示词</div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(promptForTask.prompt);
                            onToast('已复制到剪贴板', 'info');
                          } catch {
                            onToast('复制失败', 'error');
                          }
                        }}
                      >
                        一键复制
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPromptForTask(null)}>
                        收起
                      </Button>
                    </div>
                  </div>
                  {promptForTask.runDocPathAbs ? (
                    <div className="mb-2 text-xs text-slate-500 break-all">
                      任务文档：<span className="font-mono">{promptForTask.runDocPathAbs}</span>
                    </div>
                  ) : null}
                  <pre className="whitespace-pre-wrap break-words rounded border border-slate-800 bg-slate-950 px-2 py-2 text-xs text-slate-100">
                    {promptForTask.prompt}
                  </pre>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
