/**
 * DAG 可视化组件
 * 使用 React Flow 渲染任务依赖图
 */

import { useCallback, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Edge,
  MiniMap,
  Node,
  useNodesState,
  useEdgesState,
  Position,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';

import type { TaskGraph, FlowNodeData } from './types';

// CLI 颜色映射
const CLI_COLORS = {
  codex: '#3b82f6',   // blue-500
  claude: '#8b5cf6',  // violet-500
  mixed: '#6b7280',   // gray-500
};

// 风险等级颜色映射
const RISK_COLORS = {
  low: '#22c55e',     // green-500
  medium: '#f59e0b',  // amber-500
  high: '#ef4444',    // red-500
};

// 使用 dagre 布局算法
function layoutNodes(nodes: Node<FlowNodeData>[], edges: Edge[]): Node<FlowNodeData>[] {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  dagreGraph.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 200, height: 80 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  return nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - 100,
        y: nodeWithPosition.y - 40,
      },
    };
  });
}

// 自定义任务节点
function TaskNode({ data }: { data: FlowNodeData }) {
  const cliColor = data.cli ? CLI_COLORS[data.cli] : CLI_COLORS.mixed;
  const riskColor = data.riskLevel ? RISK_COLORS[data.riskLevel] : undefined;

  return (
    <div
      className="px-4 py-2 rounded-lg border-2 bg-white shadow-md min-w-[180px]"
      style={{
        borderColor: cliColor,
        borderWidth: data.status === 'failed' ? '3px' : '2px',
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <div
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: cliColor }}
        />
        <span className="text-xs font-medium text-gray-500">
          {data.cli === 'codex' ? 'Codex' : data.cli === 'claude' ? 'Claude' : 'Manual'}
        </span>
        {riskColor && (
          <div
            className="w-2 h-2 rounded-full ml-auto"
            style={{ backgroundColor: riskColor }}
            title={`风险等级: ${data.riskLevel}`}
          />
        )}
      </div>
      <div className="text-sm font-semibold text-gray-800 truncate" title={data.label}>
        {data.label}
      </div>
      {data.phaseIndex !== undefined && (
        <div className="text-xs text-gray-400 mt-1">Phase {data.phaseIndex + 1}</div>
      )}
    </div>
  );
}

const nodeTypes = {
  task: TaskNode,
};

interface DAGVisualizationProps {
  graph: TaskGraph;
  cliAllocation?: Record<string, 'codex' | 'claude'>;
  onNodeClick?: (nodeId: string) => void;
  className?: string;
}

export function DAGVisualization({ graph, cliAllocation, onNodeClick, className = '' }: DAGVisualizationProps) {
  // 转换为 React Flow 节点和边
  const { initialNodes, initialEdges } = useMemo(() => {
    const nodes: Node<FlowNodeData>[] = graph.tasks.map((task) => ({
      id: task.id,
      type: 'task',
      data: {
        id: task.id,
        label: task.title,
        type: 'task',
        cli: cliAllocation?.[task.id],
        riskLevel: task.riskLevel,
      },
      position: { x: 0, y: 0 },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    }));

    const edges: Edge[] = graph.edges
      .filter((edge) => edge.type !== 'conflict') // 不显示冲突边
      .map((edge, index) => ({
        id: `${edge.from}-${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: edge.strength === 'weak' ? 'smoothstep' : 'default',
        style: {
          stroke: edge.type === 'explicit' ? '#8b5cf6' : '#94a3b8',
          strokeWidth: edge.strength === 'weak' ? 1 : 2,
          strokeDasharray: edge.strength === 'weak' ? '5,5' : undefined,
        },
        label: edge.type === 'explicit' ? '依赖' : '',
        labelStyle: { fontSize: 10, fill: '#8b5cf6' },
      }));

    return { initialNodes: layoutNodes(nodes, edges), initialEdges: edges };
  }, [graph, cliAllocation]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node<FlowNodeData>) => {
      onNodeClick?.(node.id);
    },
    [onNodeClick]
  );

  if (graph.hasCycle) {
    return (
      <div className={`flex items-center justify-center h-64 bg-red-50 border border-red-200 rounded-lg ${className}`}>
        <div className="text-center">
          <div className="text-red-600 font-semibold mb-2">检测到循环依赖</div>
          <div className="text-sm text-red-500">
            {graph.cycles.map((cycle, i) => (
              <div key={i} className="truncate">{cycle}</div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full w-full ${className}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Background color="#cbd5e1" gap={16} />
        <Controls />
        <MiniMap
          nodeColor={(node) => {
            const data = node.data as FlowNodeData;
            return data.cli ? CLI_COLORS[data.cli] : CLI_COLORS.mixed;
          }}
          maskColor="rgba(0, 0, 0, 0.1)"
        />
      </ReactFlow>
    </div>
  );
}
