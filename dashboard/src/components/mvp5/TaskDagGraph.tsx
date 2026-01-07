import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MiniMap, type Edge, type Node } from 'reactflow';
import dagre from 'dagre';

import type { TaskGraph } from './types';

const NODE_WIDTH = 240;
const NODE_HEIGHT = 72;

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

export function TaskDagGraph({ graph, className = '' }: { graph: TaskGraph; className?: string }) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = (graph?.tasks ?? []).map((t) => ({
      id: t.id,
      type: 'default',
      position: { x: 0, y: 0 },
      data: {
        label: (
          <div className="px-2 py-1">
            <div className="text-xs font-mono text-gray-600">{t.id}</div>
            <div className="text-xs font-semibold text-gray-800 truncate" title={t.title}>
              {t.title}
            </div>
          </div>
        ),
      },
      style: {
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        border: '1px solid #d1d5db',
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
