import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MiniMap, type Edge, type Node } from 'reactflow';
import dagre from 'dagre';

import type { TaskGraph } from './types';

const NODE_WIDTH = 240;
const NODE_HEIGHT = 72;

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

function layoutDag(nodes: Node[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 56 });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });
  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  dagre.layout(g);

  const layouted = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });

  return { nodes: layouted, edges };
}

function nodeColorByRisk(risk: string | undefined) {
  if (risk === 'high') return '#fecaca';
  if (risk === 'medium') return '#fde68a';
  return '#e5e7eb';
}

function nodeBorderByStatus(status: TaskStatus) {
  if (status === 'completed') return '#22c55e';
  if (status === 'running') return '#3b82f6';
  if (status === 'failed') return '#ef4444';
  return '#d1d5db';
}

function statusLabel(status: TaskStatus) {
  if (status === 'completed') return '已完成';
  if (status === 'running') return '进行中';
  if (status === 'failed') return '失败';
  return '未开始';
}

function statusBadgeClass(status: TaskStatus) {
  if (status === 'completed') return 'bg-green-100 text-green-700';
  if (status === 'running') return 'bg-blue-100 text-blue-700';
  if (status === 'failed') return 'bg-red-100 text-red-700';
  return 'bg-gray-100 text-gray-600';
}

export function TaskDagGraph({
  graph,
  taskStatusById,
  className = '',
}: {
  graph: TaskGraph;
  taskStatusById?: Record<string, TaskStatus | undefined>;
  className?: string;
}) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = (graph?.tasks ?? []).map((t) => ({
      id: t.id,
      type: 'default',
      position: { x: 0, y: 0 },
      data: {
        label: (
          <div className="px-2 py-1">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-mono text-gray-600">{t.id}</div>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeClass(
                  taskStatusById?.[t.id] ?? 'pending',
                )}`}
              >
                {statusLabel(taskStatusById?.[t.id] ?? 'pending')}
              </span>
            </div>
            <div className="text-xs font-semibold text-gray-800 truncate" title={t.title}>
              {t.title}
            </div>
          </div>
        ),
      },
      style: {
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        border: `2px solid ${nodeBorderByStatus(taskStatusById?.[t.id] ?? 'pending')}`,
        borderRadius: 8,
        background: nodeColorByRisk(t.riskLevel),
        padding: 0,
      },
    }));

    const edges: Edge[] = (graph?.edges ?? [])
      .map((e, idx) => {
        const from = String(e?.from || '').trim();
        const to = String(e?.to || '').trim();
        if (!from || !to) return null;
        const isConflict = e.type === 'conflict';
        return {
          id: `${from}->${to}:${idx}`,
          source: from,
          target: to,
          type: 'smoothstep',
          animated: false,
          style: isConflict ? { stroke: '#f59e0b', strokeDasharray: '6 4' } : { stroke: '#94a3b8' },
        };
      })
      .filter(Boolean) as Edge[];

    return layoutDag(nodes, edges);
  }, [graph]);

  return (
    <div className={`h-[460px] w-full overflow-hidden rounded border border-gray-200 bg-white ${className}`}>
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background />
        <MiniMap pannable zoomable />
        <Controls />
      </ReactFlow>
    </div>
  );
}
