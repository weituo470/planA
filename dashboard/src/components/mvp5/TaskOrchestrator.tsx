/**
 * TaskOrchestrator - MVP5 智能任务编排入口组件
 * 整合依赖分析、推荐方案和执行控制
 */

import { useMemo, useState, useCallback, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { DependencyPanel } from './DependencyPanel';
import { RecommendationPanel } from './RecommendationPanel';
import { ExecutionConsole } from './ExecutionConsole';
import { TaskDagGraph } from './TaskDagGraph';
import type {
  AnalysisResult,
  ExecutionPlan,
  ExecutionState,
  Recommendation,
} from './types';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:4100';

interface TaskOrchestratorProps {
  specId: string;
  tasksContent: string;
  className?: string;
}

type Section = 'analysis' | 'recommendation' | 'execution';

export function TaskOrchestrator({ specId, tasksContent, className = '' }: TaskOrchestratorProps) {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const [maxCliConcurrency, setMaxCliConcurrency] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem('mvp5MaxCliConcurrency') || '');
      if (Number.isFinite(raw)) return Math.min(8, Math.max(1, Math.floor(raw)));
    } catch {
      // ignore
    }
    return 8;
  });

  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [creatingPlan, setCreatingPlan] = useState(false);

  const [executionState, setExecutionState] = useState<ExecutionState | null>(null);
  const [starting, setStarting] = useState(false);

  const [selectedRecommendation, setSelectedRecommendation] = useState<number>(0);
  const [expandedSections, setExpandedSections] = useState<Set<Section>>(
    new Set(['analysis', 'recommendation'])
  );

  const taskTitleById = useMemo(() => {
    const map = new Map<string, string>();
    (analysis?.tasks ?? []).forEach((t) => map.set(t.id, t.title));
    return map;
  }, [analysis]);

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
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setAnalyzing(false);
    }
  }, [specId, tasksContent, maxCliConcurrency]);

  // 选择推荐方案
  const handleSelectRecommendation = useCallback((index: number, _rec: Recommendation) => {
    setSelectedRecommendation(index);
  }, []);

  // 创建执行计划
  const handleCreatePlan = useCallback(async (
    recommendation: Recommendation,
    modifications: {
      taskCliOverrides?: Record<string, 'codex' | 'claude'>;
      excludedTasks?: string[];
    }
  ) => {
    if (!analysis) return;

    setCreatingPlan(true);

    try {
      const response = await fetch(`${BRIDGE_URL}/api/mvp5/execution-plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          specId,
          analysisId: analysis.analysisId,
          selectedRecommendation: selectedRecommendation,
          modifications,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '创建计划失败');
      }

      const result: ExecutionPlan = await response.json();
      setPlan(result);
    } catch (err) {
      console.error('创建执行计划失败:', err);
    } finally {
      setCreatingPlan(false);
    }
  }, [analysis, specId, selectedRecommendation]);

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

  // 切换区域展开/收起
  const toggleSection = useCallback((section: Section) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  return (
    <div className={`space-y-4 ${className}`}>
      {/* 依赖分析区域 */}
      <CollapsibleSection
        title="依赖分析"
        section="analysis"
        expanded={expandedSections.has('analysis')}
        onToggle={toggleSection}
      >
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-600">最大 CLI 并发（≤ 8）</label>
            <input
              type="number"
              min={1}
              max={8}
              value={maxCliConcurrency}
              onChange={(e) => {
                const next = Math.min(8, Math.max(1, Math.floor(Number(e.target.value || 0))));
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
          <div className="text-xs text-gray-500">
            方案生成：优先使用 Claude 4.5 Opus（可在提示词配置里调整行为）
          </div>
        </div>
        <DependencyPanel
          analysis={analysis}
          loading={analyzing}
          error={analysisError}
          onAnalyze={handleAnalyze}
        />

        {analysis ? (
          <div className="mt-4 space-y-4">
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-gray-800">任务 DAG</div>
                <div className="text-xs text-gray-500">拖拽/缩放查看依赖关系</div>
              </div>
              <TaskDagGraph graph={analysis.graph} />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-gray-800">tasks.md（Markdown）</div>
                <button
                  className="text-xs text-blue-600 hover:text-blue-700"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(tasksContent ?? '');
                    } catch {
                      // ignore
                    }
                  }}
                >
                  复制
                </button>
              </div>
              <pre className="max-h-72 overflow-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800 whitespace-pre-wrap font-mono">
                {tasksContent || ''}
              </pre>
            </div>
          </div>
        ) : null}
      </CollapsibleSection>

      {/* 推荐方案区域 */}
      {analysis && (
        <CollapsibleSection
          title="执行方案推荐"
          section="recommendation"
          expanded={expandedSections.has('recommendation')}
          onToggle={toggleSection}
        >
          <RecommendationPanel
            recommendations={analysis.recommendations}
            loading={creatingPlan}
            onSelectRecommendation={handleSelectRecommendation}
            onCreatePlan={handleCreatePlan}
            createdPlan={plan}
          />
          <div className="mt-4">
            <div className="mb-2 text-sm font-semibold text-gray-800">执行计划预览（Markdown）</div>
            <pre className="max-h-64 overflow-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800 whitespace-pre-wrap font-mono">
              {buildPhasesMarkdown(
                analysis.recommendations[selectedRecommendation]?.phases ?? [],
                taskTitleById
              )}
            </pre>
          </div>
        </CollapsibleSection>
      )}

      {/* 执行控制区域 */}
      {plan && (
        <CollapsibleSection
          title="执行控制台"
          section="execution"
          expanded={expandedSections.has('execution')}
          onToggle={toggleSection}
        >
          <div className="mb-4">
            <div className="mb-2 text-sm font-semibold text-gray-800">执行计划（Markdown）</div>
            <pre className="max-h-64 overflow-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800 whitespace-pre-wrap font-mono">
              {buildPhasesMarkdown(plan.phases ?? [], taskTitleById)}
            </pre>
          </div>
          <ExecutionConsole
            plan={plan}
            executionState={executionState}
            loading={starting}
            onStart={handleStart}
            onRetry={handleRetry}
          />
        </CollapsibleSection>
      )}
    </div>
  );
}

type SectionProps = {
  title: string;
  section: Section;
  expanded: boolean;
  onToggle: (section: Section) => void;
  children: React.ReactNode;
};

function CollapsibleSection({ title, section, expanded, onToggle, children }: SectionProps) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => onToggle(section)}
        className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 flex items-center justify-between transition-colors"
      >
        <span className="font-semibold text-gray-800">{title}</span>
        {expanded ? (
          <ChevronDown className="w-5 h-5 text-gray-500" />
        ) : (
          <ChevronRight className="w-5 h-5 text-gray-500" />
        )}
      </button>
      {expanded && <div className="p-4">{children}</div>}
    </div>
  );
}

function buildPhasesMarkdown(
  phases: Array<ExecutionPlan['phases'][number]>,
  titleById: Map<string, string>,
) {
  if (!phases.length) return '（空）';

  const lines: string[] = [];
  lines.push('## 执行计划');
  lines.push('');

  phases.forEach((phase, idx) => {
    const typeLabel = phase.type === 'parallel' ? '并发' : '串行';
    const limit = Number.isFinite(phase.maxConcurrency as number)
      ? `（并发上限 ${phase.maxConcurrency}）`
      : '';
    lines.push(`### Phase ${idx + 1}：${typeLabel}${limit}`);
    (phase.taskIds ?? []).forEach((taskId) => {
      const title = titleById.get(taskId) || '';
      lines.push(`- ${taskId}${title ? `：${title}` : ''}`);
    });
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}
