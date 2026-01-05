/**
 * 依赖分析面板组件
 * 显示分析摘要和警告信息
 */

import { Clock, GitBranch, AlertTriangle, CheckCircle2, XCircle, Layers } from 'lucide-react';

import type { AnalysisResult } from './types';

interface DependencyPanelProps {
  analysis: AnalysisResult | null;
  loading?: boolean;
  error?: string | null;
  onAnalyze?: () => void;
  disabled?: boolean;
  className?: string;
}

export function DependencyPanel({
  analysis,
  loading = false,
  error = null,
  onAnalyze,
  disabled = false,
  className = '',
}: DependencyPanelProps) {
  if (error) {
    return (
      <div className={`bg-red-50 border border-red-200 rounded-lg p-4 ${className}`}>
        <div className="flex items-center gap-2 text-red-700 mb-2">
          <XCircle className="w-5 h-5" />
          <span className="font-semibold">分析失败</span>
        </div>
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className={`bg-gray-50 border border-gray-200 rounded-lg p-6 ${className}`}>
        <div className="text-center">
          <Layers className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-600 mb-4">点击下方按钮分析任务依赖关系</p>
          {onAnalyze && (
            <button
              onClick={onAnalyze}
              disabled={disabled || loading}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? '分析中...' : '分析依赖'}
            </button>
          )}
        </div>
      </div>
    );
  }

  const { summary, warnings, platformNotes } = analysis;

  return (
    <div className={`bg-white border border-gray-200 rounded-lg ${className}`}>
      {/* 标题栏 */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="font-semibold text-gray-800">依赖分析结果</h3>
        {onAnalyze && (
          <button
            onClick={onAnalyze}
            disabled={disabled || loading}
            className="text-sm px-3 py-1 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:bg-gray-50 disabled:text-gray-400 transition-colors"
          >
            {loading ? '刷新中...' : '刷新'}
          </button>
        )}
      </div>

      {/* 统计摘要 */}
      <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<GitBranch className="w-4 h-4" />}
          label="总任务"
          value={summary.totalTasks}
          color="blue"
        />
        <StatCard
          icon={<Layers className="w-4 h-4" />}
          label="并行组"
          value={summary.parallelGroups}
          color="green"
        />
        <StatCard
          icon={<Clock className="w-4 h-4" />}
          label="预计耗时"
          value={formatDuration(summary.estimatedDuration)}
          color="purple"
        />
        <StatCard
          icon={summary.hasCycle || summary.hasConflicts ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          label="状态"
          value={summary.hasCycle ? '有循环' : summary.hasConflicts ? '有冲突' : '正常'}
          color={summary.hasCycle || summary.hasConflicts ? 'red' : 'green'}
        />
      </div>

      {/* 警告列表 */}
      {(warnings.length > 0 || platformNotes?.issues.length > 0) && (
        <div className="px-4 pb-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-center gap-2 text-amber-800 font-medium mb-2">
              <AlertTriangle className="w-4 h-4" />
              <span>注意事项</span>
            </div>
            <ul className="text-sm text-amber-700 space-y-1">
              {warnings.map((warning, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-amber-400">•</span>
                  <span>{warning}</span>
                </li>
              ))}
              {platformNotes?.issues.map((issue, i) => (
                <li key={`plat-${i}`} className="flex items-start gap-2">
                  <span className="text-amber-400">•</span>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* 关键路径信息 */}
      {summary.criticalPathLength > 0 && (
        <div className="px-4 pb-4">
          <div className="text-sm text-gray-600">
            <span className="font-medium">关键路径：</span>
            <span className="text-gray-500">{summary.criticalPathLength} 个任务串联</span>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: 'blue' | 'green' | 'purple' | 'red' | 'amber';
}) {
  const colorClasses = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
  };

  return (
    <div className={`border rounded-lg p-3 ${colorClasses[color]}`}>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs font-medium opacity-70">{label}</span>
      </div>
      <div className="text-lg font-bold">{value}</div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '-';
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `~${mins}分钟`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `~${hours}小时${remainingMins}分钟`;
}
