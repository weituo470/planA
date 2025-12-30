import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Node,
  type Edge,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { Button } from './components/ui/button';
import { getSocket } from './socket';
import type {
  ApprovalRequest,
  BridgeState,
  DiffPreview,
  SpecArtifact,
  SpecSummary,
  TaskGraph,
  TestReport,
  WorkflowEvent,
  WorkflowStatus,
} from './types';

const initialState: BridgeState = {
  status: 'Thinking',
  tasks: { nodes: [], edges: [] },
  lastDiff: null,
  approvals: [],
  testReport: null,
  logs: [],
};

const defaultNodes: Node[] = [
  { id: 'spec', position: { x: 0, y: 0 }, data: { label: 'Specification' } },
  { id: 'plan', position: { x: 200, y: 0 }, data: { label: 'Planning' } },
  { id: 'exec', position: { x: 400, y: 0 }, data: { label: 'Execution' } },
  { id: 'verify', position: { x: 600, y: 0 }, data: { label: 'Verification' } },
];

const defaultEdges: Edge[] = [
  { id: 'e1', source: 'spec', target: 'plan' },
  { id: 'e2', source: 'plan', target: 'exec' },
  { id: 'e3', source: 'exec', target: 'verify' },
];


function statusColor(status: WorkflowStatus) {
  if (status === 'Executing') return 'bg-amber-400 text-slate-900';
  if (status === 'Reviewing') return 'bg-emerald-400 text-slate-900';
  return 'bg-blue-500 text-white';
}

export default function App() {
  const [state, setState] = useState<BridgeState>(initialState);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [patchText, setPatchText] = useState('');
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [selectedSpec, setSelectedSpec] = useState<string | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<SpecArtifact>('requirements');
  const [specContent, setSpecContent] = useState('');
  const [newSpecName, setNewSpecName] = useState('');
  const [specStatus, setSpecStatus] = useState<'idle' | 'loading' | 'saving' | 'confirming' | 'error'>('idle');
  const [specMessage, setSpecMessage] = useState('');
  const envBridgeUrl = (import.meta.env.VITE_BRIDGE_URL || '').trim();
  const [bridgeBaseUrl, setBridgeBaseUrl] = useState(
    envBridgeUrl || 'http://localhost:4100',
  );
  const [approvalTitle, setApprovalTitle] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState(defaultNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(defaultEdges);
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressSyncRef = useRef(false);
  const latestNodesRef = useRef<Node[]>(defaultNodes);
  const resultsLocked = state.status === 'Reviewing';
  const socket = useMemo(() => getSocket(bridgeBaseUrl), [bridgeBaseUrl]);

  useEffect(() => {
    socket.on('state:init', (payload: BridgeState) => {
      setState(payload);
    });

    socket.on('event', (event: WorkflowEvent) => {
      setEvents((prev) => [...prev.slice(-199), event]);
      setState((prev) => applyEvent(prev, event));
    });

    return () => {
      socket.off('state:init');
      socket.off('event');
    };
  }, [socket]);

  useEffect(() => {
    const candidates = [
      envBridgeUrl,
      'http://localhost:4100',
      'http://localhost:4101',
    ]
      .filter(Boolean)
      .filter((value, index, array) => array.indexOf(value) === index);

    let cancelled = false;

    const probeBridge = async () => {
      for (const candidate of candidates) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 800);
          const response = await fetch(`${candidate}/health`, {
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (response.ok) {
            if (!cancelled) {
              setBridgeBaseUrl(candidate);
            }
            return;
          }
        } catch (error) {
          // Ignore and try next candidate.
        }
      }
    };

    probeBridge();

    return () => {
      cancelled = true;
    };
  }, [envBridgeUrl]);


  useEffect(() => {
    suppressSyncRef.current = true;
    if (state.tasks.nodes.length) {
      setNodes(state.tasks.nodes as Node[]);
      setEdges(state.tasks.edges as Edge[]);
    } else {
      setNodes(defaultNodes);
      setEdges(defaultEdges);
    }
    const timer = setTimeout(() => {
      suppressSyncRef.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [state.tasks, setNodes, setEdges]);

  useEffect(() => {
    latestNodesRef.current = nodes;
  }, [nodes]);



  const graph = useMemo(() => {
    return {
      nodes,
      edges,
    } as TaskGraph;
  }, [nodes, edges]);

  const fetchSpecs = useCallback(async () => {
    setSpecStatus("loading");
    setSpecMessage("");
    try {
      const response = await fetch(`${bridgeBaseUrl}/specs`);
      const data = await response.json();
      setSpecs(data.specs || []);
      setSpecStatus("idle");
    } catch (error) {
      console.error('Spec list fetch failed:', error);
      setSpecStatus("error");
      setSpecMessage("无法加载 Spec 列表");
    }
  }, [bridgeBaseUrl]);

  const loadSpecContent = useCallback(
    async (specName: string, artifact: SpecArtifact) => {
      setSpecStatus("loading");
      setSpecMessage("");
      try {
        const response = await fetch(`${bridgeBaseUrl}/specs/${specName}/${artifact}`);
        if (!response.ok) {
          throw new Error("not found");
        }
        const data = await response.json();
        setSpecContent(data.content || "");
        setSpecStatus("idle");
      } catch (error) {
        setSpecContent("");
        setSpecStatus("error");
        setSpecMessage("无法加载 Spec 内容");
      }
    },
    [bridgeBaseUrl],
  );

  const createSpec = useCallback(async () => {
    const prompt = newSpecName.trim();
    if (!prompt) {
      setSpecMessage('请输入需求描述（支持中文/空格；不要包含 / \\ : * ? " < > |）');
      return;
    }
    setSpecStatus("saving");
    setSpecMessage("");
    try {
      const response = await fetch(`${bridgeBaseUrl}/specs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!response.ok) {
        let errorMessage = "创建 Spec 失败";
        try {
          const data = await response.json();
          if (data?.error) {
            errorMessage = data.error;
          }
        } catch {
          // ignore parse errors
        }
        throw new Error(errorMessage);
      }
      const created = await response.json();
      const createdName = created?.name || '';
      if (!createdName) {
        throw new Error('创建 Spec 失败');
      }
      await fetchSpecs();
      setSelectedSpec(createdName);
      setActiveArtifact("requirements");
      await loadSpecContent(createdName, "requirements");
      setNewSpecName("");
      setSpecStatus("idle");
      setSpecMessage(`已创建：${createdName}`);
    } catch (error) {
      setSpecStatus("error");
      setSpecMessage(error instanceof Error ? error.message : "创建 Spec 失败");
    }
  }, [bridgeBaseUrl, newSpecName, fetchSpecs, loadSpecContent]);

  const selectedSpecSummary = useMemo(
    () => specs.find((spec) => spec.name === selectedSpec) || null,
    [specs, selectedSpec],
  );

  const selectedSpecStatus = useMemo(
    () =>
      selectedSpecSummary?.status ?? {
        requirementsConfirmed: false,
        designConfirmed: false,
        tasksConfirmed: false,
      },
    [selectedSpecSummary],
  );

  const isArtifactEnabled = useMemo(() => {
    if (!selectedSpec) return false;
    if (activeArtifact === 'requirements') return true;
    if (activeArtifact === 'design') {
      return selectedSpecStatus.requirementsConfirmed;
    }
    return selectedSpecStatus.designConfirmed;
  }, [activeArtifact, selectedSpec, selectedSpecStatus]);

  const canConfirm = useMemo(() => {
    if (!selectedSpec) return false;
    if (activeArtifact === 'requirements') {
      return !selectedSpecStatus.requirementsConfirmed;
    }
    if (activeArtifact === 'design') {
      return (
        selectedSpecStatus.requirementsConfirmed &&
        !selectedSpecStatus.designConfirmed
      );
    }
    return (
      selectedSpecStatus.designConfirmed &&
      !selectedSpecStatus.tasksConfirmed
    );
  }, [activeArtifact, selectedSpec, selectedSpecStatus]);

  const saveSpec = useCallback(async () => {
    if (!selectedSpec) {
      setSpecMessage("请先选择 Spec");
      return;
    }
    if (!isArtifactEnabled) {
      setSpecMessage("请先确认上一步文档");
      return;
    }
    setSpecStatus("saving");
    setSpecMessage("");
      try {
        const response = await fetch(`${bridgeBaseUrl}/specs/${selectedSpec}/${activeArtifact}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: specContent }),
        });
        if (!response.ok) {
          let errorMessage = "保存失败";
          try {
            const data = await response.json();
            if (data?.error) {
              errorMessage = data.error;
            }
          } catch {
            // ignore parse errors
          }
          throw new Error(errorMessage);
        }
        setSpecStatus("idle");
        setSpecMessage("已保存");
      } catch (error) {
        setSpecStatus("error");
        setSpecMessage(error instanceof Error ? error.message : "保存失败");
      }
    }, [bridgeBaseUrl, selectedSpec, activeArtifact, specContent, isArtifactEnabled]);

  const confirmArtifact = useCallback(async () => {
    if (!selectedSpec) {
      setSpecMessage("请先选择 Spec");
      return;
    }
    if (!canConfirm) {
      setSpecMessage("当前阶段不可确认");
      return;
    }
    setSpecStatus("confirming");
    setSpecMessage("");
      try {
        const response = await fetch(`${bridgeBaseUrl}/specs/${selectedSpec}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ artifact: activeArtifact }),
        });
        if (!response.ok) {
          let errorMessage = "确认失败";
          try {
            const data = await response.json();
            if (data?.error) {
              errorMessage = data.error;
            }
          } catch {
            // ignore parse errors
          }
          throw new Error(errorMessage);
        }
        await fetchSpecs();
      if (activeArtifact === 'requirements') {
        setActiveArtifact('design');
      } else if (activeArtifact === 'design') {
        setActiveArtifact('tasks');
      }
      setSpecStatus("idle");
      setSpecMessage("已确认");
    } catch (error) {
      setSpecStatus("error");
      setSpecMessage("确认失败");
    }
  }, [bridgeBaseUrl, selectedSpec, activeArtifact, canConfirm, fetchSpecs]);

  useEffect(() => {
    fetchSpecs();
  }, [fetchSpecs]);

  useEffect(() => {
    if (!selectedSpec) return;
    loadSpecContent(selectedSpec, activeArtifact);
  }, [selectedSpec, activeArtifact, loadSpecContent]);

  const scheduleGraphSync = useCallback(
    (nextNodes: Node[], nextEdges: Edge[]) => {
      if (suppressSyncRef.current) return;
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
      syncTimeoutRef.current = setTimeout(() => {
        socket.emit('task:replace', {
          nodes: nextNodes,
          edges: nextEdges,
        });
      }, 300);
    },
    [socket],
  );

  const flushGraphSync = useCallback(
    (nextNodes: Node[], nextEdges: Edge[]) => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
      if (suppressSyncRef.current) return;
      socket.emit('task:replace', {
        nodes: nextNodes,
        edges: nextEdges,
      });
    },
    [socket],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge(connection, eds));
    },
    [setEdges],
  );

  useEffect(() => {
    scheduleGraphSync(latestNodesRef.current, edges);
  }, [edges, scheduleGraphSync]);

  useEffect(() => {
    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, []);

  const approvals = state.approvals;

  const requestApproval = () => {
    const title = approvalTitle.trim() || '审批请求';
    socket.emit('approval:request', { title });
    setApprovalTitle('');
  };

  const submitApproval = (request: ApprovalRequest, decision: 'approve' | 'reject') => {
    socket.emit('approval:submit', {
      id: request.id,
      decision,
      comment: decision === 'reject' ? 'Rejected in dashboard' : 'Approved in dashboard',
    });
  };

  const sendPatch = () => {
    if (!patchText.trim()) return;
    socket.emit('requirement:patch', {
      text: patchText.trim(),
    });
    setPatchText('');
  };

  const retryWithFeedback = () => {
    socket.emit('requirement:patch', {
      text: 'Retry with feedback: please adjust based on latest test report.',
    });
  };

  const handleDragStop = (_event: unknown, _node: Node, currentNodes: Node[]) => {
    flushGraphSync(currentNodes, edges);
  };

  return (
    <div className="min-h-screen bg-surface text-slate-100">
      <header className="border-b border-slate-800 bg-panel px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Codex Workflow Console</h1>
            <p className="text-sm text-slate-400">
              Spec {'>'} Planning {'>'} Execution {'>'} Verification
            </p>
          </div>
          <div className={`rounded-full px-4 py-1 text-sm ${statusColor(state.status)}`}>
            {state.status}
          </div>
        </div>
      </header>

      <main className="grid grid-cols-12 gap-4 px-6 py-6">
        <section className="col-span-8 space-y-4">
          <div className="rounded-xl bg-panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Spec 模式</h2>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="w-44 rounded-lg border border-slate-700 bg-black/30 px-3 py-2 text-sm text-slate-100"
                  placeholder='需求描述（如：帮我写一个技术博客网页）'
                  value={newSpecName}
                  onChange={(event) => setNewSpecName(event.target.value)}
                />
                <Button size="sm" onClick={createSpec} disabled={specStatus === 'saving'}>
                  新建
                </Button>
                <Button variant="outline" size="sm" onClick={fetchSpecs}>
                  刷新
                </Button>
              </div>
            </div>
            <p className="mt-1 text-xs text-slate-500">桥接地址：{bridgeBaseUrl}</p>
            <div className="mt-4 grid grid-cols-12 gap-4">
              <div className="col-span-4 space-y-2">
                {specs.length === 0 ? (
                  <p className="text-sm text-slate-500">暂无 Spec，请先新建。</p>
                ) : (
                  specs.map((spec) => (
                    <button
                      key={spec.name}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                        selectedSpec === spec.name
                          ? 'border-accent bg-slate-800'
                          : 'border-slate-800 bg-black/20 hover:bg-slate-800'
                      }`}
                      onClick={() => {
                        setSelectedSpec(spec.name);
                        setActiveArtifact('requirements');
                      }}
                    >
                      <div className="font-medium">{spec.name}</div>
                      <div className="mt-1 text-xs text-slate-400">
                        文件 需 {spec.files.requirements ? '✓' : '—'} · 设{' '}
                        {spec.files.design ? '✓' : '—'} · 任{' '}
                        {spec.files.tasks ? '✓' : '—'}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        确认 需 {spec.status?.requirementsConfirmed ? '✓' : '—'} · 设{' '}
                        {spec.status?.designConfirmed ? '✓' : '—'} · 任{' '}
                        {spec.status?.tasksConfirmed ? '✓' : '—'}
                      </div>
                    </button>
                  ))
                )}
              </div>
              <div className="col-span-8 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {(['requirements', 'design', 'tasks'] as SpecArtifact[]).map(
                    (artifact) => {
                      const artifactEnabled =
                        !!selectedSpec &&
                        (artifact === 'requirements' ||
                          (artifact === 'design'
                            ? selectedSpecStatus.requirementsConfirmed
                            : selectedSpecStatus.designConfirmed));

                      return (
                        <Button
                          key={artifact}
                          size="sm"
                          variant={activeArtifact === artifact ? 'default' : 'outline'}
                          disabled={!artifactEnabled}
                          onClick={() => {
                            if (artifactEnabled) {
                              setActiveArtifact(artifact);
                            }
                          }}
                        >
                          {artifact === 'requirements'
                            ? '需求'
                            : artifact === 'design'
                            ? '设计'
                            : '任务'}
                        </Button>
                      );
                    },
                  )}
                  {specStatus === 'loading' && (
                    <span className="text-xs text-slate-400">加载中…</span>
                  )}
                  {specStatus === 'saving' && (
                    <span className="text-xs text-slate-400">保存中…</span>
                  )}
                  {specStatus === 'confirming' && (
                    <span className="text-xs text-slate-400">确认中…</span>
                  )}
                  {specMessage && (
                    <span className="text-xs text-amber-400">{specMessage}</span>
                  )}
                </div>
                <textarea
                  className="h-48 w-full rounded-lg border border-slate-700 bg-black/30 p-2 text-sm text-slate-100"
                  placeholder={
                    isArtifactEnabled
                      ? '选择 Spec 后编辑内容'
                      : '请先确认上一步文档'
                  }
                  disabled={!isArtifactEnabled}
                  value={specContent}
                  onChange={(event) => setSpecContent(event.target.value)}
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">
                    顺序：需求 → 设计 → 任务（逐步确认）
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={confirmArtifact}
                      disabled={!canConfirm}
                    >
                      确认当前文档
                    </Button>
                    <Button
                      size="sm"
                      onClick={saveSpec}
                      disabled={!selectedSpec || !isArtifactEnabled}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-xl bg-panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">任务流地图</h2>
              <span className="text-xs text-slate-400">DAG 视图</span>
            </div>
            <div className="h-[360px] rounded-lg border border-slate-800">
              <ReactFlow
                nodes={graph.nodes}
                edges={graph.edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeDragStop={handleDragStop}
                fitView
              >
                <Background gap={16} color="#2b3242" />
                <Controls />
              </ReactFlow>
            </div>
          </div>

          <div className="rounded-xl bg-panel p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-semibold">实时日志</h2>
              <span className="text-xs text-slate-400">CLI 输出流</span>
            </div>
            <div className="scrollbar h-40 overflow-y-auto rounded-lg border border-slate-800 bg-black/30 p-3 text-xs">
              {resultsLocked ? (
                <p className="text-slate-500">反馈确认中，结果暂不可见。</p>
              ) : state.logs.length === 0 ? (
                <p className="text-slate-500">等待日志输出…</p>
              ) : (
                state.logs.map((log, idx) => (
                  <pre key={`${log.source}-${idx}`} className="whitespace-pre-wrap text-slate-200">
                    {log.message}
                  </pre>
                ))
              )}
            </div>
          </div>
        </section>

        <aside className="col-span-4 space-y-4">
          <div className="rounded-xl bg-panel p-4">
            <h2 className="text-lg font-semibold">使用指引</h2>
            <ul className="mt-2 space-y-2 text-sm text-slate-300">
              <li>0) 按顺序完成 需求 → 设计 → 任务，并逐步确认。</li>
              <li>1) 修改 `workflow/task/需求.md` 触发 Diff 预览。</li>
              <li>2) 在“审批队列”发起审批 → Approve/Reject。</li>
              <li>3) 在“需求补丁”输入指令并提交。</li>
              <li>4) 拖拽节点或连线更新任务图。</li>
              <li>5) 发送测试报告事件，弹出结果窗口。</li>
            </ul>
            <pre className="mt-3 rounded-lg border border-slate-800 bg-black/30 p-2 text-xs text-slate-200">
              {`Invoke-RestMethod -Method Post -Uri http://localhost:4100/events -ContentType \"application/json\" -Body '{\"type\":\"test:report\",\"payload\":{\"status\":\"fail\",\"summary\":\"示例失败\",\"details\":\"用例失败\"}}'`}
            </pre>
          </div>
          <div className="rounded-xl bg-panel p-4">
            <h2 className="text-lg font-semibold">Diff 预览</h2>
            {resultsLocked ? (
              <p className="mt-2 text-sm text-slate-500">反馈确认中，Diff 暂不可见。</p>
            ) : state.lastDiff ? (
              <div className="mt-2">
                <p className="text-xs text-slate-400">{state.lastDiff.filePath}</p>
                <pre className="scrollbar mt-2 h-40 overflow-y-auto rounded-lg border border-slate-800 bg-black/40 p-2 text-xs text-slate-200">
                  {state.lastDiff.diff}
                </pre>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-500">暂无文件变动。</p>
            )}
          </div>

          <div className="rounded-xl bg-panel p-4">
            <h2 className="text-lg font-semibold">审批队列</h2>
            <div className="mt-2 flex gap-2">
              <input
                className="w-full rounded-lg border border-slate-700 bg-black/30 px-3 py-2 text-sm text-slate-100"
                placeholder="输入审批标题"
                value={approvalTitle}
                onChange={(event) => setApprovalTitle(event.target.value)}
              />
              <Button size="sm" onClick={requestApproval}>
                发起
              </Button>
            </div>
            {approvals.length === 0 && (
              <p className="mt-2 text-sm text-slate-500">暂无待审批项。</p>
            )}
            {approvals.map((approval) => (
              <div key={approval.id} className="mt-3 rounded-lg border border-slate-800 p-3">
                <p className="text-sm font-medium">{approval.title}</p>
                {approval.description && (
                  <p className="mt-1 text-xs text-slate-400">{approval.description}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => submitApproval(approval, 'approve')}>
                    Approve
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => submitApproval(approval, 'reject')}>
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl bg-panel p-4">
            <h2 className="text-lg font-semibold">需求补丁</h2>
            <textarea
              className="mt-2 h-24 w-full rounded-lg border border-slate-700 bg-black/30 p-2 text-sm text-slate-100"
              placeholder="这里不要用 Redis，改用本地缓存…"
              value={patchText}
              onChange={(event) => setPatchText(event.target.value)}
            />
            <div className="mt-2 flex justify-end">
              <Button size="sm" onClick={sendPatch}>
                提交补丁
              </Button>
            </div>
          </div>
        </aside>
      </main>

      <section className="px-6 pb-8">
        <div className="rounded-xl bg-panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold">事件流</h2>
            <span className="text-xs text-slate-400">{events.length} events</span>
          </div>
          <div className="scrollbar h-36 overflow-y-auto rounded-lg border border-slate-800 bg-black/30 p-3 text-xs">
            {events.length === 0 && (
              <p className="text-slate-500">等待事件…</p>
            )}
            {events.map((eventItem) => (
              <div key={eventItem.id} className="mb-2">
                <div className="text-slate-400">
                  [{eventItem.timestamp}] {eventItem.type}
                </div>
                <pre className="whitespace-pre-wrap text-slate-200">
                  {JSON.stringify(eventItem.payload, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </section>

      {state.testReport && !resultsLocked && (
        <TestReportModal report={state.testReport} onRetry={retryWithFeedback} />
      )}
    </div>
  );
}

function applyEvent(prev: BridgeState, event: WorkflowEvent): BridgeState {
  switch (event.type) {
    case 'status:update':
      return { ...prev, status: event.payload.status as WorkflowStatus };
    case 'task:graph':
      return { ...prev, tasks: event.payload as TaskGraph };
    case 'diff:preview':
      return { ...prev, lastDiff: event.payload as DiffPreview };
    case 'approval:request':
      return {
        ...prev,
        approvals: [...prev.approvals, event.payload as ApprovalRequest],
      };
    case 'approval:resolve':
      return {
        ...prev,
        approvals: prev.approvals.filter((item) => item.id !== event.payload.id),
      };
    case 'test:report':
      return { ...prev, testReport: event.payload as TestReport };
    case 'log:append':
      return {
        ...prev,
        logs: [...prev.logs, event.payload].slice(-200),
      };
    default:
      return prev;
  }
}

function TestReportModal({
  report,
  onRetry,
}: {
  report: TestReport;
  onRetry: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-panel p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">测试报告</h3>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              report.status === 'pass'
                ? 'bg-emerald-400 text-slate-900'
                : 'bg-rose-400 text-slate-900'
            }`}
          >
            {report.status === 'pass' ? 'PASS' : 'FAIL'}
          </span>
        </div>
        <p className="mt-3 text-sm text-slate-200">{report.summary}</p>
        {report.details && (
          <pre className="scrollbar mt-3 max-h-40 overflow-y-auto rounded-lg border border-slate-800 bg-black/30 p-2 text-xs text-slate-200">
            {report.details}
          </pre>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm">
            Submit
          </Button>
          <Button size="sm" onClick={onRetry}>
            Retry with Feedback
          </Button>
        </div>
      </div>
    </div>
  );
}











