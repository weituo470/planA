/**
 * 执行控制台组件
 * 显示任务执行进度和控制按钮
 */

import { Play, Pause, RotateCcw, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

import type { ExecutionPlan, ExecutionState } from './types';

interface ExecutionConsoleProps {
  plan: ExecutionPlan | null;
  executionState: ExecutionState | null;
  loading?: boolean;
  onStart?: () => void;
  onPause?: () => void;
  onRetry?: (taskId: string) => void;
  className?: string;
}

export function ExecutionConsole({
  plan,
  executionState,
  loading = false,
  onStart,
  onPause,
  onRetry,
  className = '',
}: ExecutionConsoleProps) {
  if (!plan) {
    return (
      <div className={`bg-gray-50 border border-gray-200 rounded-lg p-4 ${className}`}>
        <p className="text-center text-gray-500 text-sm">请先创建执行计划</p>
      </div>
    );
  }

  const state = executionState;
  const isRunning = state?.status === 'running';
  const isPaused = state?.status === 'paused';
  const isCompleted = state?.status === 'completed';
  const hasFailures = state?.failures && state.failures.length > 0;

  // 统计任务状态
  const taskStats = state
    ? Object.values(state.tasks).reduce(
        (acc, task) => {
          acc[task.status]++;
          return acc;
        },
        { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 }
      )
    : { pending: plan.phases.flatMap((p) => p.taskIds).length, running: 0, completed: 0, failed: 0, skipped: 0 };

  return (
    <div className={`bg-white border border-gray-200 rounded-lg ${className}`}>
      {/* 标题栏 + 控制按钮 */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-800">执行控制台</h3>
          <p className="text-xs text-gray-500">计划 ID: {plan.planId.slice(0, 8)}...</p>
        </div>
        <div className="flex gap-2">
          {isCompleted ? (
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle2 className="w-5 h-5" />
              <span className="text-sm font-medium">已完成</span>
            </div>
          ) : isRunning ? (
            onPause && (
              <button
                onClick={onPause}
                disabled={loading}
                className="flex items-center gap-1 px-3 py-1.5 bg-amber-100 text-amber-700 rounded-lg hover:bg-amber-200 disabled:bg-gray-100 disabled:text-gray-400 transition-colors"
              >
                <Pause className="w-4 h-4" />
                <span className="text-sm">暂停</span>
              </button>
            )
          ) : (
            onStart && (
              <button
                onClick={onStart}
                disabled={loading || isPaused}
                className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                <span className="text-sm">{isPaused ? '继续执行' : '执行计划'}</span>
              </button>
            )
          )}
        </div>
      </div>

      {/* 统计栏 */}
      <div className="px-4 py-3 border-b border-gray-200 grid grid-cols-4 gap-2">
        <StatItem label="待执行" value={taskStats.pending} color="gray" />
        <StatItem label="进行中" value={taskStats.running} color="blue" />
        <StatItem label="已完成" value={taskStats.completed} color="green" />
        <StatItem label="失败" value={taskStats.failed} color="red" />
      </div>

      {/* 执行阶段进度 */}
      <div className="p-4 max-h-64 overflow-y-auto">
        {plan.phases.map((phase, index) => {
          const phaseState = getPhaseState(phase, state);
          const isCurrentPhase = state && state.currentPhase === index;

          return (
            <PhaseCard
              key={phase.phaseId}
              phase={phase}
              index={index}
              state={phaseState}
              isCurrent={isCurrentPhase}
              taskStates={state?.tasks}
              onRetry={onRetry}
            />
          );
        })}
      </div>

      {/* 失败任务列表 */}
      {hasFailures && (
        <div className="px-4 pb-4 border-t border-gray-200">
          <div className="pt-3">
            <h4 className="text-sm font-semibold text-red-700 mb-2 flex items-center gap-1">
              <AlertCircle className="w-4 h-4" />
              失败任务
            </h4>
            <div className="space-y-2">
              {state!.failures.map((failure, i) => (
                <div
                  key={i}
                  className="bg-red-50 border border-red-200 rounded p-2 text-sm"
                >
                  <div className="font-medium text-red-800">{failure.taskId}</div>
                  <div className="text-red-600 text-xs mt-1 truncate">{failure.error}</div>
                  {failure.canRetry && onRetry && (
                    <button
                      onClick={() => onRetry(failure.taskId)}
                      className="mt-2 flex items-center gap-1 text-xs px-2 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                      重启
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatItem({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: 'gray' | 'blue' | 'green' | 'red' | 'amber';
}) {
  const colors = {
    gray: 'bg-gray-100 text-gray-700',
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-700',
  };

  return (
    <div className={`flex items-center justify-between px-2 py-1 rounded ${colors[color]}`}>
      <span className="text-xs">{label}</span>
      <span className="text-sm font-bold">{value}</span>
    </div>
  );
}

type PhaseState = 'pending' | 'running' | 'completed' | 'failed';

function getPhaseState(
  phase: ExecutionPlan['phases'][number],
  state: ExecutionState | null
): PhaseState {
  if (!state) return 'pending';

  const taskStates = phase.taskIds.map((id) => state.tasks[id]?.status);
  const allCompleted = taskStates.every((s) => s === 'completed' || s === 'skipped');
  const anyFailed = taskStates.some((s) => s === 'failed');
  const anyRunning = taskStates.some((s) => s === 'running');

  if (allCompleted) return 'completed';
  if (anyFailed) return 'failed';
  if (anyRunning) return 'running';
  return 'pending';
}

function PhaseCard({
  phase,
  index,
  state,
  isCurrent,
  taskStates,
  onRetry,
}: {
  phase: ExecutionPlan['phases'][number];
  index: number;
  state: PhaseState;
  isCurrent: boolean;
  taskStates?: Record<string, ExecutionState['tasks'][string]>;
  onRetry?: (taskId: string) => void;
}) {
  const stateConfig = {
    pending: { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-600', icon: '○' },
    running: { bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-700', icon: '⟳' },
    completed: { bg: 'bg-green-50', border: 'border-green-300', text: 'text-green-700', icon: '✓' },
    failed: { bg: 'bg-red-50', border: 'border-red-300', text: 'text-red-700', icon: '✗' },
  };

  const config = stateConfig[state];

  return (
    <div
      className={`${config.bg} ${config.border} border rounded-lg p-3 mb-2 ${
        isCurrent ? 'ring-2 ring-blue-400' : ''
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`${config.text} font-medium`}>{config.icon}</span>
          <span className={`font-medium ${config.text}`}>
            Phase {index + 1} ({phase.type === 'parallel' ? '并发' : '串行'})
          </span>
          {isCurrent && (
            <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded">
              当前
            </span>
          )}
        </div>
        <span className={`text-xs ${config.text}`}>
          {phase.taskIds.length} 个任务
          {Number.isFinite(phase.maxConcurrency as number) ? ` · 并发上限 ${phase.maxConcurrency}` : ''}
        </span>
      </div>

      {/* 任务列表 */}
      <div className="space-y-1">
        {phase.taskIds.map((taskId) => {
          const task = taskStates?.[taskId];
          const taskState = task?.status || 'pending';
          const taskColor =
            taskState === 'completed'
              ? 'text-green-600'
              : taskState === 'failed'
              ? 'text-red-600'
              : taskState === 'running'
              ? 'text-blue-600'
              : 'text-gray-500';

          return (
            <div key={taskId} className="flex items-center justify-between text-xs">
              <span className="font-mono text-gray-500 truncate">{taskId}</span>
              <div className="flex items-center gap-2">
                <span className={taskColor}>{taskState}</span>
                {taskState === 'failed' && onRetry && (
                  <button
                    onClick={() => onRetry(taskId)}
                    className="text-red-600 hover:text-red-700"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
