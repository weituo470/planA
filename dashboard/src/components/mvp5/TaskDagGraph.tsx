import { useMemo } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  type Edge,
  type Node,
} from 'reactflow';
import dagre from 'dagre';

import type { TaskGraph } from './types';

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

type TaskActionSpec = {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
};

type TaskActionsById = Record<
  string,
  {
    start?: TaskActionSpec;
    running?: TaskActionSpec;
    done?: TaskActionSpec;
  }
>;

function layoutDag(
  nodes: Node[],
  edges: Edge[],
  layout: { nodeWidth: number; nodeHeight: number; nodesep: number; ranksep: number },
) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: layout.nodesep, ranksep: layout.ranksep });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: layout.nodeWidth, height: layout.nodeHeight });
  });
  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  dagre.layout(g);

  const layouted = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - layout.nodeWidth / 2, y: pos.y - layout.nodeHeight / 2 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });

  return { nodes: layouted, edges };
}

function nodeColorByRisk(risk: string | undefined) {
  if (risk === 'high') return 'rgba(239, 68, 68, 0.14)';
  if (risk === 'medium') return 'rgba(245, 158, 11, 0.14)';
  return 'rgba(15, 23, 42, 0.86)';
}

function nodeBorderByStatus(status: TaskStatus) {
  if (status === 'completed') return '#4ade80';
  if (status === 'running') return '#60a5fa';
  if (status === 'failed') return '#f87171';
  return '#334155';
}

function statusLabel(status: TaskStatus) {
  if (status === 'completed') return '已完成';
  if (status === 'running') return '进行中';
  if (status === 'failed') return '失败';
  return '未开始';
}

function statusBadgeClass(status: TaskStatus) {
  if (status === 'completed') return 'bg-green-500/15 text-green-300 ring-1 ring-green-500/30';
  if (status === 'running') return 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30';
  if (status === 'failed') return 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30';
  return 'bg-slate-800/80 text-slate-300 ring-1 ring-slate-700';
}

export function TaskDagGraph({
  graph,
  taskStatusById,
  taskActionsById,
  className = '',
  height = 460,
}: {
  graph: TaskGraph;
  taskStatusById?: Record<string, TaskStatus | undefined>;
  taskActionsById?: TaskActionsById;
  className?: string;
  height?: number;
}) {
  const { nodes, edges } = useMemo(() => {
    const actionsEnabled = Boolean(taskActionsById);
    const nodeWidth = actionsEnabled ? 300 : 260;
    const nodeHeight = actionsEnabled ? 112 : 90;
    const nodesep = actionsEnabled ? 18 : 16;
    const ranksep = actionsEnabled ? 44 : 40;

    const nodes: Node[] = (graph?.tasks ?? []).map((t) => {
      const status = taskStatusById?.[t.id] ?? 'pending';
      const actions = taskActionsById?.[t.id];
      return {
        id: t.id,
        type: 'default',
        position: { x: 0, y: 0 },
        data: {
          label: (
            <div className="flex h-full w-full flex-col px-2 py-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="text-[11px] font-mono text-slate-400">{t.id}</div>
                <span
                  className={`rounded px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(
                    status,
                  )}`}
                >
                  {statusLabel(status)}
                </span>
              </div>
              <div className="mt-1 flex-1">
                <div
                  className="text-sm font-semibold leading-5 text-slate-100"
                  title={t.title}
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {t.title}
                </div>
                <div
                  className="mt-0.5 text-xs leading-4 text-slate-300"
                  title={t.description}
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 1,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {t.description || '（无描述）'}
                </div>
              </div>
              {actionsEnabled && actions ? (
                <div className="mt-1.5 flex items-center gap-2">
                  {actions.start ? (
                    <button
                      type="button"
                      className="pointer-events-auto inline-flex h-6 items-center justify-center rounded border border-accent/30 bg-accent/15 px-2 text-[11px] font-medium text-slate-100 transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void actions.start?.onClick();
                      }}
                      disabled={actions.start.disabled}
                      title={actions.start.title}
                    >
                      {actions.start.label}
                    </button>
                  ) : null}
                  {actions.running ? (
                    <button
                      type="button"
                      className="pointer-events-auto inline-flex h-6 items-center justify-center gap-1 rounded border border-blue-500/30 bg-blue-500/10 px-2 text-[11px] font-medium text-blue-200 transition-colors hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void actions.running?.onClick();
                      }}
                      disabled={actions.running.disabled}
                      title={actions.running.title}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-blue-400" aria-hidden="true" />
                      {actions.running.label}
                    </button>
                  ) : null}
                  {actions.done ? (
                    <button
                      type="button"
                      className="pointer-events-auto inline-flex h-6 items-center justify-center gap-1 rounded border border-green-500/30 bg-green-500/10 px-2 text-[11px] font-medium text-green-200 transition-colors hover:bg-green-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void actions.done?.onClick();
                      }}
                      disabled={actions.done.disabled}
                      title={actions.done.title}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400" aria-hidden="true" />
                      {actions.done.label}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ),
        },
        style: {
          width: nodeWidth,
          height: nodeHeight,
          border: `2px solid ${nodeBorderByStatus(status)}`,
          borderRadius: 10,
          background: nodeColorByRisk(t.riskLevel),
          padding: 0,
        },
      };
    });

    const edges: Edge[] = (graph?.edges ?? [])
      .map((e, idx) => {
        const from = String(e?.from || '').trim();
        const to = String(e?.to || '').trim();
        if (!from || !to) return null;
        const isConflict = e.type === 'conflict';
        const stroke = isConflict ? '#f59e0b' : '#475569';
        return {
          id: `${from}->${to}:${idx}`,
          source: from,
          target: to,
          type: 'smoothstep',
          animated: false,
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
          style: isConflict
            ? { stroke, strokeDasharray: '6 4', strokeWidth: 1.5 }
            : { stroke, strokeWidth: 1.5 },
        };
      })
      .filter(Boolean) as Edge[];

    return layoutDag(nodes, edges, { nodeWidth, nodeHeight, nodesep, ranksep });
  }, [graph, taskActionsById, taskStatusById]);

  return (
    <div
      className={`w-full overflow-hidden rounded border border-slate-800 bg-slate-950 ${className} [&_.react-flow__attribution]:bg-transparent [&_.react-flow__attribution]:text-slate-500 [&_.react-flow__controls-button]:border-slate-700 [&_.react-flow__controls-button]:bg-slate-950 [&_.react-flow__controls-button]:text-slate-200 [&_.react-flow__controls-button:hover]:bg-slate-900 [&_.react-flow__minimap]:border-slate-700 [&_.react-flow__minimap]:bg-slate-950`}
      style={{ height }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.06 }}
        minZoom={0.25}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="rgba(148, 163, 184, 0.14)"
        />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          style={{ height: 96, width: 140 }}
          nodeColor={(node) => nodeBorderByStatus(taskStatusById?.[node.id] ?? 'pending')}
          maskColor="rgba(2, 6, 23, 0.65)"
        />
        <Controls position="bottom-left" />
      </ReactFlow>
    </div>
  );
}
