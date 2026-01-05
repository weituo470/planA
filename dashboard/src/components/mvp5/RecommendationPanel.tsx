/**
 * 推荐方案面板组件
 * 显示并选择执行方案
 */

import { CheckCircle2, Circle, Zap, Cpu } from 'lucide-react';
import { useState } from 'react';

import type { Recommendation, ExecutionPlan } from './types';

interface RecommendationPanelProps {
  recommendations: Recommendation[];
  loading?: boolean;
  onSelectRecommendation?: (
    index: number,
    recommendation: Recommendation
  ) => void;
  onCreatePlan?: (
    recommendation: Recommendation,
    modifications: {
      taskCliOverrides?: Record<string, 'codex' | 'claude'>;
      excludedTasks?: string[];
    }
  ) => void;
  createdPlan?: ExecutionPlan | null;
  className?: string;
}

export function RecommendationPanel({
  recommendations,
  loading = false,
  onSelectRecommendation,
  onCreatePlan,
  createdPlan,
  className = '',
}: RecommendationPanelProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showCustomize, setShowCustomize] = useState(false);

  if (!recommendations || recommendations.length === 0) {
    return (
      <div className={`bg-gray-50 border border-gray-200 rounded-lg p-4 ${className}`}>
        <p className="text-center text-gray-500">暂无推荐方案</p>
      </div>
    );
  }

  const selected = recommendations[selectedIndex];

  const handleSelect = (index: number) => {
    setSelectedIndex(index);
    onSelectRecommendation?.(index, recommendations[index]);
  };

  const handleCreatePlan = () => {
    onCreatePlan?.(selected, {});
  };

  const handleCustomize = () => {
    setShowCustomize(true);
  };

  return (
    <div className={`bg-white border border-gray-200 rounded-lg ${className}`}>
      {/* 标题栏 */}
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="font-semibold text-gray-800">执行方案推荐</h3>
      </div>

      {/* 方案列表 */}
      <div className="p-4 space-y-3">
        {recommendations.map((rec, index) => (
          <div
            key={index}
            className={`border rounded-lg p-4 cursor-pointer transition-all ${
              index === selectedIndex
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300'
            }`}
            onClick={() => handleSelect(index)}
          >
            <div className="flex items-start gap-3">
              <div className="mt-1">
                {index === selectedIndex ? (
                  <CheckCircle2 className="w-5 h-5 text-blue-600" />
                ) : (
                  <Circle className="w-5 h-5 text-gray-400" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-gray-800">
                    {rec.label || `方案 ${String.fromCharCode(65 + index)}`}
                  </span>
                  {rec.priority === 'high' && (
                    <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded">
                      推荐
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600 mb-2">{rec.description}</p>

                {/* CLI 分配统计 */}
                {rec.cliAllocation && (
                  <div className="flex items-center gap-4 text-xs text-gray-500">
                    <span className="flex items-center gap-1">
                      <Cpu className="w-3 h-3" />
                      Codex: {Object.values(rec.cliAllocation).filter((x) => x === 'codex').length}
                    </span>
                    <span className="flex items-center gap-1">
                      <Zap className="w-3 h-3" />
                      Claude: {Object.values(rec.cliAllocation).filter((x) => x === 'claude').length}
                    </span>
                    <span>
                      预计: {formatDuration(rec.estimatedTotalTime)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 选中方案详情 */}
      {selected && (
        <div className="px-4 pb-4 border-t border-gray-200">
          <div className="pt-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-2">执行阶段</h4>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {selected.phases.map((phase, i) => (
                <PhaseCard key={phase.phaseId} phase={phase} index={i} />
              ))}
            </div>
          </div>

          {/* 推荐理由 */}
          {selected.rationale && (
            <div className="mt-3 text-sm text-gray-600 bg-gray-50 p-2 rounded">
              <span className="font-medium">理由：</span>
              {selected.rationale}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="mt-4 flex gap-2">
            <button
              onClick={handleCreatePlan}
              disabled={loading || !!createdPlan}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
            >
              {loading ? '创建中...' : createdPlan ? '已创建' : '采用此方案'}
            </button>
            <button
              onClick={handleCustomize}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
              自定义
            </button>
          </div>
        </div>
      )}

      {/* 已创建计划提示 */}
      {createdPlan && (
        <div className="px-4 pb-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            <span className="text-green-800">执行计划已创建，可以启动执行</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PhaseCard({ phase, index }: { phase: Recommendation['phases'][number]; index: number }) {
  const typeBadge = phase.type === 'parallel' ? (
    <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded">并行</span>
  ) : (
    <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 rounded">串行</span>
  );

  const cliBadge = phase.suggestedCli === 'codex' ? (
    <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded">Codex</span>
  ) : phase.suggestedCli === 'claude' ? (
    <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded">Claude</span>
  ) : (
    <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 rounded">混合</span>
  );

  return (
    <div className="bg-white border border-gray-200 rounded p-2 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">Phase {index + 1}</span>
        {typeBadge}
        {cliBadge}
      </div>
      <span className="text-xs text-gray-500">{phase.taskIds.length} 个任务</span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '-';
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `~${mins}分钟`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `~${hours}h${remainingMins}m`;
}
