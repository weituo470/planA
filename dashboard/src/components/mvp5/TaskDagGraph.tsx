import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Cog, Play } from 'lucide-react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  type ReactFlowInstance,
  type Edge,
  type Node,
} from 'reactflow';
import dagre from 'dagre';

import type { TaskGraph } from './types';

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';
type TaskVisualStatus = TaskStatus | 'blocked' | 'ready';

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

function nodeBorderByStatus(status: TaskVisualStatus) {
  if (status === 'completed') return '#4ade80';
  if (status === 'running') return '#60a5fa';
  if (status === 'failed') return '#f87171';
  if (status === 'blocked') return '#fbbf24';
  if (status === 'ready') return '#a855f7';
  return '#334155';
}

function statusLabel(status: TaskVisualStatus) {
  if (status === 'completed') return '已完成';
  if (status === 'running') return '进行中';
  if (status === 'failed') return '失败';
  if (status === 'blocked') return '阻塞';
  if (status === 'ready') return '可开始';
  return '未开始';
}

function statusBadgeClass(status: TaskVisualStatus) {
  if (status === 'completed') return 'bg-green-500/15 text-green-300 ring-1 ring-green-500/30';
  if (status === 'running') return 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30';
  if (status === 'failed') return 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30';
  if (status === 'blocked') return 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30';
  if (status === 'ready') return 'bg-purple-500/15 text-purple-300 ring-1 ring-purple-500/30';
  return 'bg-slate-800/80 text-slate-300 ring-1 ring-slate-700';
}

function dependencyIdsForTask(graph: TaskGraph, taskId: string) {
  const fromAdj = (graph?.adjacency?.[taskId]?.in ?? [])
    .filter((edge) => String((edge as any)?.type ?? '').trim() !== 'conflict')
    .map((edge) => String((edge as any)?.to ?? '').trim())
    .filter(Boolean);
  if (fromAdj.length) return Array.from(new Set(fromAdj));

  const fromEdges = (graph?.edges ?? [])
    .filter((edge) => edge?.to === taskId && edge?.type !== 'conflict')
    .map((edge) => String(edge?.from ?? '').trim())
    .filter(Boolean);
  return Array.from(new Set(fromEdges));
}

function deriveTaskVisualStatus(
  taskId: string,
  status: TaskStatus,
  graph: TaskGraph,
  taskStatusById?: Record<string, TaskStatus | undefined>,
): TaskVisualStatus {
  if (status !== 'pending') return status;
  const deps = dependencyIdsForTask(graph, taskId);
  if (!deps.length) return 'ready';
  const blocked = deps.some((depId) => (taskStatusById?.[depId] ?? 'pending') !== 'completed');
  return blocked ? 'blocked' : 'ready';
}

type TaskDagBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function computeDagBounds(nodes: Node[]): TaskDagBounds | null {
  if (!nodes.length) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const x = Number(node?.position?.x ?? 0);
    const y = Number(node?.position?.y ?? 0);
    const w = Number((node as any)?.style?.width ?? 0);
    const h = Number((node as any)?.style?.height ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const width = Number.isFinite(w) && w > 0 ? w : 0;
    const height = Number.isFinite(h) && h > 0 ? h : 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }

  return { minX, minY, maxX, maxY };
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
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const boundsRef = useRef<TaskDagBounds | null>(null);
  const lastRecoverAtRef = useRef<number | null>(null);
  const [renderIssue, setRenderIssue] = useState<string | null>(null);
  const [flowKey, setFlowKey] = useState(0);
  const lastHardResetAtRef = useRef<number>(0);

  const hardReset = useCallback((reason: string) => {
    const now = Date.now();
    const last = lastHardResetAtRef.current ?? 0;
    if (now - last < 2500) return;
    lastHardResetAtRef.current = now;
    console.warn('[TaskDagGraph] force remount', { reason });
    setFlowKey((prev) => prev + 1);
  }, []);

  const statusKey = useMemo(() => {
    const list = (graph?.tasks ?? []).map((t) => `${t.id}:${taskStatusById?.[t.id] ?? 'pending'}`);
    return list.join('|');
  }, [graph, taskStatusById]);

  const recoverView = useCallback((reason: string) => {
    const now = Date.now();
    const last = lastRecoverAtRef.current ?? 0;
    if (now - last < 900) return;
    lastRecoverAtRef.current = now;

    const inst = flowRef.current;
    if (!inst) return;

    try {
      const root = wrapperRef.current;
      const bounds = boundsRef.current;
      if (root && bounds && typeof inst.setViewport === 'function') {
        const rect = root.getBoundingClientRect();
        const hasSize = rect.width > 12 && rect.height > 12;
        const graphWidth = bounds.maxX - bounds.minX;
        const graphHeight = bounds.maxY - bounds.minY;
        if (hasSize && graphWidth > 1 && graphHeight > 1) {
          const padding = 0.12;
          const zoomX = (rect.width * (1 - padding * 2)) / graphWidth;
          const zoomY = (rect.height * (1 - padding * 2)) / graphHeight;
          let zoom = Math.min(zoomX, zoomY);
          zoom = Math.max(0.25, Math.min(1.6, zoom));

          const centerX = (bounds.minX + bounds.maxX) / 2;
          const centerY = (bounds.minY + bounds.maxY) / 2;
          const x = rect.width / 2 - centerX * zoom;
          const y = rect.height / 2 - centerY * zoom;
          inst.setViewport({ x, y, zoom }, { duration: 0 });
        }
      }

      const viewport = typeof inst.getViewport === 'function' ? inst.getViewport() : null;
      const zoom = viewport && typeof viewport.zoom === 'number' ? viewport.zoom : 1;
      const viewportOk =
        viewport &&
        Number.isFinite(viewport.x) &&
        Number.isFinite(viewport.y) &&
        Number.isFinite(zoom) &&
        zoom > 0.01;
      if (!viewportOk && typeof inst.setViewport === 'function') {
        inst.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
      }
      window.requestAnimationFrame(() => {
        try {
          inst.fitView({ padding: 0.12, duration: 0 });
        } catch (e) {
          console.error('[TaskDagGraph] fitView failed', { reason, error: e });
        }
      });
    } catch (e) {
      console.error('[TaskDagGraph] recover failed', { reason, error: e });
    }
  }, []);

  const { nodes, edges, bounds } = useMemo(() => {
    const actionsEnabled = Boolean(taskActionsById);
    const nodeWidth = actionsEnabled ? 300 : 260;
    const nodeHeight = actionsEnabled ? 120 : 90;
    const nodesep = actionsEnabled ? 18 : 16;
    const ranksep = actionsEnabled ? 44 : 40;

    const nodes: Node[] = (graph?.tasks ?? []).map((t, idx) => {
      const status = taskStatusById?.[t.id] ?? 'pending';
      const visualStatus = deriveTaskVisualStatus(t.id, status, graph, taskStatusById);
      const actions = taskActionsById?.[t.id];
      return {
        id: t.id,
        type: 'default',
        position: { x: 0, y: 0 },
        data: {
          label: (
              <div className="flex h-full w-full flex-col px-2 py-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-start gap-2">
                      <span
                        className="mt-0.5 shrink-0 rounded bg-slate-950/40 px-1.5 py-0.5 text-xs font-normal text-slate-300 ring-1 ring-slate-700/70"
                        title={`序号 #${idx + 1}`}
                      >
                        #{idx + 1}
                      </span>
                      <div
                        className="min-w-0 text-base font-medium leading-6 text-slate-100"
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
                    </div>
                  </div>
                <span
                  className={`rounded px-2 py-0.5 text-[13px] font-light ${statusBadgeClass(
                    visualStatus,
                  )}`}
                >
                  {visualStatus === 'running' ? (
                    <span className="inline-flex items-center gap-1" title="进行中">
                      <Cog
                        className="h-[18px] w-[18px] animate-spin text-blue-300 drop-shadow-[0_0_6px_rgba(59,130,246,0.55)]"
                        style={{ animationDuration: '2s' }}
                        strokeWidth={1.25}
                        aria-hidden="true"
                      />
                      <span>进行中</span>
                    </span>
                  ) : (
                    statusLabel(visualStatus)
                  )}
                </span>
              </div>
              <div className="flex-1" />
              {actionsEnabled && actions ? (
                <div className="mt-1.5 flex items-center gap-2">
                  {actions.start ? (
                    <button
                      type="button"
                      className="pointer-events-auto inline-flex h-7 items-center justify-center gap-1 rounded border border-accent/30 bg-accent/15 px-2.5 text-[13px] font-light text-slate-100 transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void actions.start?.onClick();
                      }}
                      disabled={actions.start.disabled}
                      title={actions.start.title}
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      {actions.start.label}
                    </button>
                  ) : null}
                  {actions.running ? (
                    <button
                      type="button"
                      className={`pointer-events-auto inline-flex h-7 items-center justify-center gap-1 rounded border px-2.5 text-[13px] font-light transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        visualStatus === 'running'
                          ? 'border-blue-500/30 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20'
                          : 'border-slate-700 bg-slate-950/40 text-slate-300 hover:bg-slate-950/60'
                      }`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void actions.running?.onClick();
                      }}
                      disabled={actions.running.disabled}
                      title={actions.running.title}
                    >
                      <Cog
                        className={`h-[18px] w-[18px] ${
                          visualStatus === 'running'
                            ? 'animate-spin text-blue-300 drop-shadow-[0_0_6px_rgba(59,130,246,0.55)]'
                            : actions.running.disabled
                              ? 'text-slate-500'
                              : 'text-slate-400'
                        }`}
                        style={visualStatus === 'running' ? { animationDuration: '2s' } : undefined}
                        strokeWidth={1.25}
                        aria-hidden="true"
                      />
                      {actions.running.label}
                    </button>
                  ) : null}
                  {actions.done ? (
                    <button
                      type="button"
                      className={`pointer-events-auto inline-flex h-7 items-center justify-center gap-1 rounded border px-2.5 text-[13px] font-light transition-colors disabled:cursor-not-allowed ${
                        visualStatus === 'completed'
                          ? 'border-green-500/30 bg-green-500/10 text-green-200 hover:bg-green-500/20 disabled:opacity-100'
                          : 'border-slate-700 bg-slate-950/40 text-slate-400 hover:bg-slate-950/60 disabled:opacity-40'
                      }`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void actions.done?.onClick();
                      }}
                      disabled={actions.done.disabled}
                      title={actions.done.title}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
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
          border: `2px solid ${nodeBorderByStatus(visualStatus)}`,
          borderRadius: 10,
          background: nodeColorByRisk(t.riskLevel),
          padding: 0,
          pointerEvents: 'auto',
          visibility: 'visible',
        },
      };
    });

    const edges: Edge[] = (graph?.edges ?? [])
      .map((e, idx) => {
        const from = String(e?.from || '').trim();
        const to = String(e?.to || '').trim();
        if (!from || !to) return null;
        const isConflict = e.type === 'conflict';
        const sourceStatus = taskStatusById?.[from] ?? 'pending';
        const targetStatus = taskStatusById?.[to] ?? 'pending';
        const isBlocking = !isConflict && targetStatus === 'pending' && sourceStatus !== 'completed';
        const isSatisfied = !isConflict && sourceStatus === 'completed';

        const stroke = isConflict ? '#f59e0b' : isBlocking ? '#fbbf24' : '#ffffff';
        const opacity = isConflict ? 0.95 : isBlocking ? 0.95 : isSatisfied ? 0.35 : 0.6;
        const strokeWidth = isBlocking ? 2.5 : 2;
        return {
          id: `${from}->${to}:${idx}`,
          source: from,
          target: to,
          type: 'smoothstep',
          animated: false,
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 18, height: 18 },
          style: isConflict
            ? { stroke, strokeDasharray: '6 4', strokeWidth, opacity }
            : { stroke, strokeWidth, opacity },
        };
      })
      .filter(Boolean) as Edge[];

    const layouted = layoutDag(nodes, edges, { nodeWidth, nodeHeight, nodesep, ranksep });
    return { ...layouted, bounds: computeDagBounds(layouted.nodes) };
  }, [graph, statusKey, taskActionsById, taskStatusById]);

  boundsRef.current = bounds;

  useEffect(() => {
    if (!nodes.length) {
      setRenderIssue(null);
      return;
    }

    const wrapper = wrapperRef.current;
    const inst = flowRef.current;
    if (!wrapper || !inst) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const root = wrapperRef.current;
      const flow = flowRef.current;
      if (!root || !flow) return;

      const rect = root.getBoundingClientRect();
      const hasSize = rect.width > 12 && rect.height > 12;
      if (!hasSize) return;

      const expectedCount = nodes.length;
      const domCount = root.querySelectorAll('.react-flow__node').length;
      const expectedEdgeCount = edges.length;
      const edgeDomCount = root.querySelectorAll('.react-flow__edge-path').length;

      const viewport = typeof flow.getViewport === 'function' ? flow.getViewport() : null;
      const zoom = viewport && typeof viewport.zoom === 'number' ? viewport.zoom : null;
      const viewportOk =
        viewport &&
        Number.isFinite(viewport.x) &&
        Number.isFinite(viewport.y) &&
        Number.isFinite(zoom) &&
        (zoom as number) > 0.01;

      let offscreen = false;
      if (bounds && viewportOk) {
        const z = zoom as number;
        const viewMinX = (-viewport!.x) / z;
        const viewMinY = (-viewport!.y) / z;
        const viewMaxX = viewMinX + rect.width / z;
        const viewMaxY = viewMinY + rect.height / z;
        const margin = 32;
        offscreen =
          bounds.maxX < viewMinX - margin ||
          bounds.minX > viewMaxX + margin ||
          bounds.maxY < viewMinY - margin ||
          bounds.minY > viewMaxY + margin;
      }

      const issue =
        expectedCount > 0 && domCount === 0
          ? '节点未渲染'
          : expectedEdgeCount > 0 && edgeDomCount === 0
            ? '连线未渲染'
            : !viewportOk
              ? '视图参数异常'
              : offscreen
                ? '节点全部在视口外'
                : null;

      if (issue) {
        console.error('[TaskDagGraph] render anomaly', {
          issue,
          expectedCount,
          domCount,
          expectedEdgeCount,
          edgeDomCount,
          viewport,
          bounds,
          rect: { width: rect.width, height: rect.height },
        });
        setRenderIssue((prev) => prev ?? issue);
        recoverView(issue);
        if (issue === '节点未渲染' || issue === '连线未渲染') hardReset(issue);
        return;
      }

      setRenderIssue(null);
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bounds, edges, hardReset, nodes, recoverView]);

  return (
    <div
      ref={wrapperRef}
      className={`relative w-full overflow-hidden rounded border border-slate-800 bg-slate-950 ${className} [&_.react-flow__attribution]:bg-transparent [&_.react-flow__attribution]:text-slate-500 [&_.react-flow__controls-button]:border-slate-700 [&_.react-flow__controls-button]:bg-slate-950 [&_.react-flow__controls-button]:text-slate-200 [&_.react-flow__controls-button:hover]:bg-slate-900 [&_.react-flow__minimap]:border-slate-700 [&_.react-flow__minimap]:bg-slate-950`}
      style={{ height }}
    >
      {renderIssue ? (
        <div className="pointer-events-auto absolute left-2 top-2 z-10 flex items-center gap-2 rounded border border-red-500/40 bg-red-950/50 px-2 py-1 text-[11px] text-red-200">
          <span>DAG 显示异常：{renderIssue}</span>
          <button
            type="button"
            className="rounded border border-red-400/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-100 hover:bg-red-500/20"
            onClick={() => recoverView('manual')}
          >
            重试
          </button>
        </div>
      ) : null}
      <ReactFlow
        key={flowKey}
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        onlyRenderVisibleElements={false}
        minZoom={0.25}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
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
          nodeColor={(node) => {
            const rawStatus = taskStatusById?.[node.id] ?? 'pending';
            return nodeBorderByStatus(deriveTaskVisualStatus(node.id, rawStatus, graph, taskStatusById));
          }}
          maskColor="rgba(2, 6, 23, 0.65)"
        />
        <Controls position="bottom-left" />
      </ReactFlow>
    </div>
  );
}
