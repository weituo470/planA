/**
 * TaskOrchestrator - MVP5 智能任务编排入口组件
 * 入口 + 展示区：编排 / 计划 / 执行
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { TaskDagGraph } from './TaskDagGraph';
import type {
  AnalysisResult,
  ExecutionPlan,
  ExecutionState,
} from './types';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:4100';

interface TaskOrchestratorProps {
  specId: string;
  tasksContent: string;
  className?: string;
}

type ViewTab = 'dag' | 'tasks' | 'plan' | 'execution';

function clampCliConcurrency(input: number) {
  if (!Number.isFinite(input)) return 8;
  return Math.min(8, Math.max(1, Math.floor(input)));
}

function buildTaskTitleMap(analysis: AnalysisResult | null) {
  const map = new Map<string, string>();
  if (!analysis) return map;
  for (const task of analysis.graph.tasks) {
    if (!task?.id) continue;
    map.set(task.id, task.title || task.id);
  }
  for (const task of analysis.tasks) {
    if (!task?.id) continue;
    if (!map.has(task.id)) map.set(task.id, task.title || task.id);
  }
  return map;
}

function renderPlanMarkdown(plan: ExecutionPlan, analysis: AnalysisResult | null) {
  const titleById = buildTaskTitleMap(analysis);
  const lines: string[] = [];
  lines.push('# 执行计划（plan）');
  lines.push('');
  lines.push(`- planId: ${plan.planId}`);
  lines.push(`- specId: ${plan.specId}`);
  lines.push(`- createdAt: ${plan.createdAt}`);
  lines.push(`- status: ${plan.status}`);
  if (analysis?.summary?.maxCliConcurrency != null) {
    lines.push(`- maxCliConcurrency: ${analysis.summary.maxCliConcurrency}`);
  }
  lines.push('');
  lines.push('## Phases');
  lines.push('');
  plan.phases.forEach((phase, idx) => {
    lines.push(`### Phase ${idx + 1}（${phase.type === 'parallel' ? '并发' : '串行'}）`);
    lines.push('');
    if (phase.dependsOnPhases?.length) {
      lines.push(`- dependsOnPhases: ${phase.dependsOnPhases.join(', ')}`);
    }
    if (phase.maxConcurrency != null) {
      lines.push(`- maxConcurrency: ${phase.maxConcurrency}`);
    }
    lines.push('');
    for (const taskId of phase.taskIds) {
      const title = titleById.get(taskId) || taskId;
      lines.push(`- ${taskId}：${title}`);
    }
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function renderExecutionMarkdown(
  plan: ExecutionPlan,
  executionState: ExecutionState,
  analysis: AnalysisResult | null,
) {
  const titleById = buildTaskTitleMap(analysis);
  const lines: string[] = [];
  lines.push('# 执行状态（execution）');
  lines.push('');
  lines.push(`- executionId: ${executionState.executionId}`);
  lines.push(`- status: ${executionState.status}`);
  lines.push(`- currentPhase: ${executionState.currentPhase + 1}`);
  lines.push(`- startedAt: ${executionState.startedAt}`);
  lines.push(`- updatedAt: ${executionState.updatedAt}`);
  lines.push('');
  lines.push('## 任务状态');
  lines.push('');
  for (const phase of plan.phases) {
    for (const taskId of phase.taskIds) {
      const task = executionState.tasks[taskId];
      const title = titleById.get(taskId) || taskId;
      if (!task) {
        lines.push(`- ${taskId}：${title}（unknown）`);
        continue;
      }
      const suffix = task.error ? `（${task.status}，${task.error}）` : `（${task.status}）`;
      lines.push(`- ${taskId}：${title}${suffix}`);
    }
  }
  return lines.join('\n').trimEnd();
}

export function TaskOrchestrator({ specId, tasksContent, className = '' }: TaskOrchestratorProps) {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ViewTab>('tasks');

  const [maxCliConcurrency, setMaxCliConcurrency] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem('mvp5MaxCliConcurrency') || '');
      if (Number.isFinite(raw)) return clampCliConcurrency(raw);
    } catch {
      // ignore
    }
    return 8;
  });

  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [creatingPlan, setCreatingPlan] = useState(false);

  const [executionState, setExecutionState] = useState<ExecutionState | null>(null);
  const [starting, setStarting] = useState(false);

  // 分析依赖
  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysis(null);
    setPlan(null);
    setExecutionState(null);

    try {
      const response = await fetch(`${BRIDGE_URL}/api/mvp5/analyze-dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          specId,
          tasksContent,
          options: {
            devPlatform: 'windows',
            targetPlatform: 'linux',
            maxCliConcurrency,
            useLlmPlan: true,
            planModel: 'claude-opus-4-5-20251101',
          },
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '分析失败');
      }

      const result: AnalysisResult = await response.json();
      setAnalysis(result);
      setActiveTab('dag');
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setAnalyzing(false);
    }
  }, [specId, tasksContent, maxCliConcurrency]);

  const handleCreatePlan = useCallback(async () => {
    if (!analysis) return;

    setCreatingPlan(true);

    try {
      const response = await fetch(`${BRIDGE_URL}/api/mvp5/execution-plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          specId,
          analysisId: analysis.analysisId,
          selectedRecommendation: 0,
          modifications: {},
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '创建计划失败');
      }

      const result: ExecutionPlan = await response.json();
      setPlan(result);
      setActiveTab('plan');
    } catch (err) {
      console.error('创建执行计划失败:', err);
    } finally {
      setCreatingPlan(false);
    }
  }, [analysis, specId]);

  // 启动执行
  const handleStart = useCallback(async () => {
    if (!plan) return;

    setStarting(true);

    try {
      const response = await fetch(`${BRIDGE_URL}/api/mvp5/execution-plans/${plan.planId}/start`, {
        method: 'POST',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '启动失败');
      }

      const result = await response.json();
      // 创建执行状态
      if (result.executionId) {
        setExecutionState({
          executionId: result.executionId,
          planId: plan.planId,
          specId: plan.specId,
          status: 'running',
          currentPhase: 0,
          tasks: {},
          failures: [],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        setActiveTab('execution');
      }
    } catch (err) {
      console.error('启动执行失败:', err);
    } finally {
      setStarting(false);
    }
  }, [plan]);

  // 轮询执行状态（后端异步推进）
  useEffect(() => {
    if (!executionState?.executionId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/mvp5/execution/${executionState.executionId}/status`);
        if (!response.ok) return;
        const data: ExecutionState = await response.json();
        if (cancelled) return;
        setExecutionState(data);
      } catch {
        // ignore polling errors
      }
    };

    void poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [executionState?.executionId]);

  const planMarkdown = useMemo(() => {
    if (!plan) return '';
    return renderPlanMarkdown(plan, analysis);
  }, [plan, analysis]);

  const executionMarkdown = useMemo(() => {
    if (!plan || !executionState) return '';
    return renderExecutionMarkdown(plan, executionState, analysis);
  }, [plan, executionState, analysis]);

  // 重启任务
  const handleRetry = useCallback(async (taskId: string) => {
    if (!executionState) return;

    try {
      const response = await fetch(
        `${BRIDGE_URL}/api/mvp5/execution/${executionState.executionId}/retry/${taskId}`,
        { method: 'POST' }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '重启失败');
      }

      // 更新本地状态
      setExecutionState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...prev.tasks[taskId]!,
              status: 'pending',
              retryCount: (prev.tasks[taskId]?.retryCount || 0) + 1,
            },
          },
        };
      });
    } catch (err) {
      console.error('重启任务失败:', err);
    }
  }, [executionState]);

  return (
    <div className={`rounded-lg border border-gray-200 bg-white ${className}`}>
      {/* 入口：编排 / 计划 / 执行 */}
      <div className="border-b border-gray-200 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-600">最大 CLI 并发（≤ 8）</label>
            <input
              type="number"
              min={1}
              max={8}
              value={maxCliConcurrency}
              onChange={(e) => {
                const next = clampCliConcurrency(Number(e.target.value || 0));
                setMaxCliConcurrency(next);
                try {
                  localStorage.setItem('mvp5MaxCliConcurrency', String(next));
                } catch {
                  // ignore
                }
              }}
              className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </div>
          <div className="text-xs text-gray-500">方案生成：优先使用 Claude 4.5 Opus</div>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {analyzing ? '编排中...' : '编排任务'}
            </button>
            <button
              onClick={handleCreatePlan}
              disabled={!analysis || creatingPlan}
              className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {creatingPlan ? '生成中...' : '生成执行计划'}
            </button>
            <button
              onClick={handleStart}
              disabled={!plan || starting || executionState?.status === 'running'}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {starting ? '启动中...' : '开始执行（Phase 1）'}
            </button>
          </div>
        </div>
        {analysisError ? (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {analysisError}
          </div>
        ) : null}
      </div>

      {/* 展示区：DAG / tasks.md / plan / execution */}
      <div className="p-4">
        <div className="flex flex-wrap gap-2">
          <TabButton active={activeTab === 'tasks'} onClick={() => setActiveTab('tasks')}>
            tasks.md
          </TabButton>
          <TabButton active={activeTab === 'dag'} onClick={() => setActiveTab('dag')}>
            DAG
          </TabButton>
          <TabButton active={activeTab === 'plan'} onClick={() => setActiveTab('plan')} disabled={!plan}>
            plan
          </TabButton>
          <TabButton
            active={activeTab === 'execution'}
            onClick={() => setActiveTab('execution')}
            disabled={!executionState}
          >
            execution
          </TabButton>
        </div>

        <div className="mt-3">
          {activeTab === 'dag' ? (
            analysis ? (
              <TaskDagGraph graph={analysis.graph} />
            ) : (
              <EmptyState text="还没有编排结果（先点“编排任务”）" />
            )
          ) : null}

          {activeTab === 'tasks' ? (
            <MarkdownBlock title="tasks.md（Markdown）" content={tasksContent || ''} />
          ) : null}

          {activeTab === 'plan' ? (
            plan ? (
              <MarkdownBlock title="plan（Markdown）" content={planMarkdown} />
            ) : (
              <EmptyState text="还没有执行计划（先点“生成执行计划”）" />
            )
          ) : null}

          {activeTab === 'execution' ? (
            executionState && plan ? (
              <div className="space-y-3">
                <MarkdownBlock title="execution（Markdown）" content={executionMarkdown} />
                {executionState.failures?.length ? (
                  <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    <div className="font-medium">失败任务</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {executionState.failures.map((f) => (
                        <button
                          key={f.taskId}
                          className="rounded bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-100"
                          onClick={() => handleRetry(f.taskId)}
                        >
                          重试 {f.taskId}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <EmptyState text="还没有执行状态（先点“开始执行（Phase 1）”）" />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1 text-sm transition-colors ${
        active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
      } ${disabled ? 'cursor-not-allowed opacity-50 hover:bg-gray-100' : ''}`}
    >
      {children}
    </button>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">{text}</div>;
}

function MarkdownBlock({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-gray-800">{title}</div>
        <button
          className="text-xs text-blue-600 hover:text-blue-700"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(content ?? '');
            } catch {
              // ignore
            }
          }}
        >
          复制
        </button>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800">
        {content || ''}
      </pre>
    </div>
  );
}
