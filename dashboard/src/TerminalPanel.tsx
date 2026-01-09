import {
  forwardRef,
  type ForwardedRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { io as socketIo, type Socket } from 'socket.io-client';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { Button } from './components/ui/button';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:4100';

type TerminalListItem = {
  id: string;
  title: string;
  pid: number;
  command?: string;
  args?: string[];
  cwd?: string;
  running: boolean;
  createdAt?: string;
  exitedAt?: string | null;
  exitCode?: number | null;
};

type TerminalTab = TerminalListItem & {
  kind?: 'shell' | 'codex' | 'claude' | 'codex-task' | 'custom';
  specName?: string;
  taskId?: string;
  runDocPath?: string;
};

type TerminalBufferItem = { seq: number; data: string };

type CliToolInfo = {
  id: string;
  label: string;
  command: string;
  args: string[];
  baseUrl?: string;
  baseUrlPresent?: boolean;
  apiKeyPresent?: boolean;
  baseUrlEnvKey?: string;
  apiKeyEnvKey?: string;
  env?: Record<string, string>;
};

type TerminalController = {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  lastSeq: number;
  lastSize: { cols: number; rows: number } | null;
  dispose: () => void;
};

type WorkspaceInfo = {
  defaultCwd: string | null;
  effectiveCwd: string;
  repoDir?: string | null;
};

type DirListing = {
  path: string | null;
  parent: string | null;
  dirs: { name: string; path: string }[];
};

async function apiJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 30000,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `请求失败：${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

function pickTerminalShellTemplate() {
  return {
    title: 'PowerShell',
    command: 'powershell.exe',
    args: ['-NoLogo'],
  };
}

function pickCmdTemplate() {
  return {
    title: 'CMD',
    command: 'cmd.exe',
    args: [],
  };
}

function pickCodexTemplate() {
  return {
    title: 'Codex',
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'codex'],
  };
}

function pickClaudeAutoTemplate() {
  return {
    title: 'Claude Code · Auto',
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'claude', '--permission-mode', 'bypassPermissions'],
  };
}

export type AssignableCliTerminal = {
  id: string;
  title: string;
  kind: 'codex' | 'claude' | 'custom';
};

export type TerminalPanelHandle = {
  startCodexAtomicTask: (
    specName: string,
    taskId: string,
  ) => Promise<{ terminalId: string; title: string; runDocPath?: string }>;
  listAssignableCliTerminals: () => AssignableCliTerminal[];
  focusTerminal: (terminalId: string) => void;
  sendTerminalInput: (terminalId: string, input: string) => Promise<void>;
  createClaudeAutoTerminal: () => Promise<{ terminalId: string; title: string }>;
};

export function TerminalPanelInner(
  {
    className,
    heightClass = 'h-[520px]',
    onOpenCliConfig,
  }: { className?: string; heightClass?: string; onOpenCliConfig?: () => void },
  ref: ForwardedRef<TerminalPanelHandle>,
) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [cwdDraft, setCwdDraft] = useState('');
  const [cwdSaving, setCwdSaving] = useState(false);
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerListing, setPickerListing] = useState<DirListing | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [mkdirLoading, setMkdirLoading] = useState(false);
  const [mkdirError, setMkdirError] = useState<string | null>(null);
  const [cwdFolderName, setCwdFolderName] = useState('');
  const [cwdMkdirLoading, setCwdMkdirLoading] = useState(false);
  const [cwdMkdirError, setCwdMkdirError] = useState<string | null>(null);
  const [cliTools, setCliTools] = useState<CliToolInfo[]>([]);
  const [cliToolsError, setCliToolsError] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const containersRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const controllersRef = useRef<Map<string, TerminalController>>(new Map());
  const lastPanelSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const disposeController = useCallback((terminalId: string) => {
    const controller = controllersRef.current.get(terminalId);
    if (!controller) return;
    controller.dispose();
    controllersRef.current.delete(terminalId);
  }, []);

  const getPreferredSize = useCallback(() => {
    const active = activeId ? controllersRef.current.get(activeId) : null;
    if (active?.terminal?.cols && active?.terminal?.rows) {
      return { cols: active.terminal.cols, rows: active.terminal.rows };
    }
    if (lastPanelSizeRef.current) return lastPanelSizeRef.current;
    return { cols: 120, rows: 30 };
  }, [activeId]);

  const desiredCwd = useMemo(() => {
    const draft = cwdDraft.trim();
    if (draft) return draft;
    if (workspace?.effectiveCwd) return workspace.effectiveCwd;
    return null;
  }, [cwdDraft, workspace?.effectiveCwd]);

  const sendTerminalResize = useCallback(async (terminalId: string, cols: number, rows: number) => {
    const socket = socketRef.current;
    if (socket?.connected) {
      socket.emit('terminal:resize', { terminalId, cols, rows });
      return;
    }
    await apiJson(`/terminals/${encodeURIComponent(terminalId)}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    }, 8000);
  }, []);

  const sendTerminalInput = useCallback(async (terminalId: string, input: string) => {
    const socket = socketRef.current;
    if (socket?.connected) {
      socket.emit('terminal:input', { terminalId, input });
      return;
    }
    await apiJson(
      `/terminals/${encodeURIComponent(terminalId)}/input`,
      { method: 'POST', body: JSON.stringify({ input }) },
      8000,
    );
  }, []);

  const fitAndReport = useCallback(
    async (terminalId: string) => {
      const controller = controllersRef.current.get(terminalId);
      if (!controller) return;
      try {
        controller.fitAddon.fit();
      } catch {
        return;
      }
      const cols = controller.terminal.cols;
      const rows = controller.terminal.rows;
      if (!cols || !rows) return;
      lastPanelSizeRef.current = { cols, rows };
      const prev = controller.lastSize;
      if (prev && prev.cols === cols && prev.rows === rows) return;
      controller.lastSize = { cols, rows };
      try {
        await sendTerminalResize(terminalId, cols, rows);
      } catch {
        // ignore resize failures
      }
    },
    [sendTerminalResize],
  );

  const hydrateFromBuffer = useCallback(async (terminalId: string) => {
    const controller = controllersRef.current.get(terminalId);
    if (!controller) return;
    try {
      const data = await apiJson<{
        terminal?: { title?: string; running?: boolean; exitCode?: number | null };
        buffer?: TerminalBufferItem[];
      }>(`/terminals/${encodeURIComponent(terminalId)}/buffer`, undefined, 8000);
      const buffer = Array.isArray(data?.buffer) ? data.buffer : [];
      const ordered = buffer
        .map((item) => ({
          seq: Number(item?.seq ?? 0),
          data: String(item?.data ?? ''),
        }))
        .filter((item) => Number.isFinite(item.seq) && item.seq > 0);
      ordered.sort((a, b) => a.seq - b.seq);
      for (const item of ordered) {
        if (item.seq <= controller.lastSeq) continue;
        controller.lastSeq = item.seq;
        controller.terminal.write(item.data);
      }
      const title = String(data?.terminal?.title || '').trim();
      if (title) {
        setTabs((prev) =>
          prev.map((t) => (t.id === terminalId ? { ...t, title } : t)),
        );
      }
    } catch {
      // ignore buffer failures
    }
  }, []);

  const ensureController = useCallback(
    (terminalId: string, container: HTMLDivElement) => {
      if (controllersRef.current.has(terminalId)) return;
      const term = new Terminal({
        scrollback: 8000,
        fontSize: 18,
        lineHeight: 1.15,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        theme: { background: '#020617', foreground: '#e2e8f0' },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);

      const inputDisposable = term.onData((data) => {
        const socket = socketRef.current;
        if (socket?.connected) {
          socket.emit('terminal:input', { terminalId, input: data });
          return;
        }
        void apiJson(
          `/terminals/${encodeURIComponent(terminalId)}/input`,
          { method: 'POST', body: JSON.stringify({ input: data }) },
          8000,
        ).catch(() => null);
      });

      const resizeObserver = new ResizeObserver(() => {
        if (activeId !== terminalId) return;
        void fitAndReport(terminalId);
      });
      resizeObserver.observe(container);

      const controller: TerminalController = {
        id: terminalId,
        terminal: term,
        fitAddon,
        container,
        lastSeq: 0,
        lastSize: null,
        dispose: () => {
          try {
            resizeObserver.disconnect();
          } catch {
            // ignore
          }
          try {
            inputDisposable.dispose();
          } catch {
            // ignore
          }
          try {
            term.dispose();
          } catch {
            // ignore
          }
        },
      };
      controllersRef.current.set(terminalId, controller);

      void hydrateFromBuffer(terminalId);
      window.requestAnimationFrame(() => {
        if (activeId === terminalId) {
          void fitAndReport(terminalId);
          try {
            term.focus();
          } catch {
            // ignore focus failures
          }
        }
      });
    },
    [activeId, fitAndReport, hydrateFromBuffer],
  );

  const registerContainerRef = useCallback(
    (terminalId: string) => (el: HTMLDivElement | null) => {
      if (!el) {
        containersRef.current.delete(terminalId);
        return;
      }
      containersRef.current.set(terminalId, el);
      if (activeId === terminalId) {
        ensureController(terminalId, el);
      }
    },
    [activeId, ensureController],
  );

  const addOrUpdateTab = useCallback((next: TerminalTab) => {
    setTabs((prev) => {
      const existingIdx = prev.findIndex((t) => t.id === next.id);
      if (existingIdx < 0) return [...prev, next];
      const copy = prev.slice();
      copy[existingIdx] = { ...copy[existingIdx], ...next };
      return copy;
    });
  }, []);

  const mergeRemoteTerminals = useCallback((remote: TerminalListItem[]) => {
    setTabs((prev) => {
      const map = new Map(prev.map((t) => [t.id, t]));
      for (const t of remote) {
        const existing = map.get(t.id);
        map.set(
          t.id,
          existing
            ? {
                ...t,
                kind: existing.kind,
                specName: existing.specName,
                taskId: existing.taskId,
                runDocPath: existing.runDocPath,
              }
            : (t as TerminalTab),
        );
      }
      return Array.from(map.values());
    });
  }, []);

  const closeTab = useCallback(
    async (terminalId: string) => {
      setTabs((prev) => prev.filter((t) => t.id !== terminalId));
      disposeController(terminalId);
      try {
        await apiJson(`/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE' }, 8000);
      } catch {
        // ignore kill failures
      }
    },
    [disposeController],
  );

  const refreshCliTools = useCallback(async () => {
    try {
      setCliToolsError(null);
      const data = await apiJson<{ tools?: CliToolInfo[] }>('/cli-tools', undefined, 12000);
      setCliTools(Array.isArray(data.tools) ? data.tools : []);
    } catch (e: any) {
      setCliTools([]);
      setCliToolsError(e?.message ? String(e.message) : '读取 CLI 工具失败');
    }
  }, []);

  useEffect(() => {
    if (!createMenuOpen) return;
    void refreshCliTools();
  }, [createMenuOpen, refreshCliTools]);

  const createTerminal = useCallback(
    async (
      template: { title: string; command: string; args: string[] },
      meta?: Partial<TerminalTab>,
    ) => {
      const size = getPreferredSize();
      const data = await apiJson<{ id: string; pid: number; title: string }>(
        '/terminals',
        {
          method: 'POST',
          body: JSON.stringify({
            title: template.title,
            command: template.command,
            args: template.args,
            ...(desiredCwd ? { cwd: desiredCwd } : {}),
            cols: size.cols,
            rows: size.rows,
          }),
        },
        15000,
      );
      addOrUpdateTab({
        id: data.id,
        pid: data.pid,
        title: data.title || template.title,
        command: template.command,
        args: template.args,
        running: true,
        createdAt: new Date().toISOString(),
        ...(meta ?? {}),
      });
      setActiveId(data.id);
      return data.id;
    },
    [addOrUpdateTab, desiredCwd, getPreferredSize],
  );

  const createCliToolTerminal = useCallback(
    async (tool: CliToolInfo) => {
      const toolId = String(tool?.id || '').trim();
      if (!toolId) return null;
      const size = getPreferredSize();
      const data = await apiJson<{ id: string; pid: number; title: string }>(
        '/terminals',
        {
          method: 'POST',
          body: JSON.stringify({
            toolId,
            ...(desiredCwd ? { cwd: desiredCwd } : {}),
            cols: size.cols,
            rows: size.rows,
          }),
        },
        15000,
      );
      addOrUpdateTab({
        id: data.id,
        pid: data.pid,
        title: data.title || tool.label || tool.id,
        command: tool.command,
        args: Array.isArray(tool.args) ? tool.args : [],
        running: true,
        createdAt: new Date().toISOString(),
        kind: 'custom',
      });
      setActiveId(data.id);
      return data.id;
    },
    [addOrUpdateTab, desiredCwd, getPreferredSize],
  );

  const startCodexAtomicTask = useCallback(
    async (specName: string, taskId: string) => {
      const size = getPreferredSize();
      const data = await apiJson<{
        terminalId: string;
        pid: number;
        title: string;
        runDocPath?: string;
      }>(
        `/specs/${encodeURIComponent(specName)}/tasks_atomic/codex/terminal`,
        {
          method: 'POST',
          body: JSON.stringify({
            taskId,
            ...(desiredCwd ? { cwd: desiredCwd } : {}),
            cols: size.cols,
            rows: size.rows,
          }),
        },
        20000,
      );
      addOrUpdateTab({
        id: data.terminalId,
        pid: data.pid,
        title: data.title || `Codex · ${specName} · Task ${taskId}`,
        running: true,
        createdAt: new Date().toISOString(),
        kind: 'codex-task',
        specName,
        taskId,
        runDocPath: data.runDocPath,
      });
      setActiveId(data.terminalId);
      return { terminalId: data.terminalId, title: data.title, runDocPath: data.runDocPath };
    },
    [addOrUpdateTab, desiredCwd, getPreferredSize],
  );

  const listAssignableCliTerminals = useCallback((): AssignableCliTerminal[] => {
    const normalize = (value: any) => String(value || '').trim().toLowerCase();
    const inferKind = (tab: TerminalTab): AssignableCliTerminal['kind'] | null => {
      if (!tab?.running) return null;
      if (tab.kind === 'codex' || tab.kind === 'claude' || tab.kind === 'custom') return tab.kind;
      if (tab.kind === 'codex-task') return null;

      const title = normalize(tab.title);
      const cmd = normalize(tab.command);
      const args = Array.isArray(tab.args) ? tab.args.map((v) => normalize(v)).join(' ') : '';
      const merged = `${title} ${cmd} ${args}`;
      if (merged.includes('claude')) return 'claude';
      if (merged.includes('codex')) return 'codex';
      return null;
    };

    return tabs
      .map((t) => {
        const kind = inferKind(t);
        if (!kind) return null;
        return { id: t.id, title: t.title, kind };
      })
      .filter(Boolean) as AssignableCliTerminal[];
  }, [tabs]);

  useImperativeHandle(
    ref,
    () => ({
      startCodexAtomicTask,
      listAssignableCliTerminals,
      focusTerminal: (terminalId: string) => {
        const id = String(terminalId || '').trim();
        if (!id) return;
        setActiveId(id);
      },
      sendTerminalInput,
      createClaudeAutoTerminal: async () => {
        const template = pickClaudeAutoTemplate();
        const terminalId = await createTerminal(template, { kind: 'claude' });
        return { terminalId, title: template.title };
      },
    }),
    [createTerminal, listAssignableCliTerminals, sendTerminalInput, startCodexAtomicTask],
  );

  const refreshWorkspace = useCallback(async () => {
    try {
      setCwdError(null);
      const data = await apiJson<WorkspaceInfo>('/workspace', undefined, 8000);
      setWorkspace(data);
      const initial = String(data?.defaultCwd || data?.effectiveCwd || '').trim();
      setCwdDraft((prev) => (prev.trim() ? prev : initial));
    } catch (e: any) {
      setCwdError(e?.message ? String(e.message) : '读取默认目录失败');
    }
  }, []);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  const saveWorkspaceCwd = useCallback(async () => {
    try {
      setCwdSaving(true);
      setCwdError(null);
      const data = await apiJson<{
        ok?: boolean;
        defaultCwd?: string | null;
        effectiveCwd?: string;
        error?: string;
      }>(
        '/workspace',
        {
          method: 'POST',
          body: JSON.stringify({ defaultCwd: cwdDraft }),
        },
        12000,
      );
      if (data?.error) throw new Error(String(data.error));
      await refreshWorkspace();
      window.dispatchEvent(new CustomEvent('workspace:changed'));
    } catch (e: any) {
      setCwdError(e?.message ? String(e.message) : '保存失败');
    } finally {
      setCwdSaving(false);
    }
  }, [cwdDraft, refreshWorkspace]);

  const resetWorkspaceCwd = useCallback(async () => {
    try {
      setCwdSaving(true);
      setCwdError(null);
      await apiJson(
        '/workspace',
        { method: 'POST', body: JSON.stringify({ defaultCwd: null }) },
        12000,
      );
      setCwdDraft('');
      await refreshWorkspace();
      window.dispatchEvent(new CustomEvent('workspace:changed'));
    } catch (e: any) {
      setCwdError(e?.message ? String(e.message) : '重置失败');
    } finally {
      setCwdSaving(false);
    }
  }, [refreshWorkspace]);

  const createFolderUnderCwd = useCallback(async () => {
    const parent = desiredCwd;
    const name = cwdFolderName.trim();
    if (!parent || !name) return;

    try {
      setCwdMkdirLoading(true);
      setCwdMkdirError(null);
      const data = await apiJson<{ ok?: boolean; path?: string; error?: string }>(
        '/fs/mkdir',
        { method: 'POST', body: JSON.stringify({ parent, name }) },
        12000,
      );
      if (data?.error) throw new Error(String(data.error));
      if (data?.path) {
        setCwdDraft(data.path);
      }
      setCwdFolderName('');
    } catch (e: any) {
      setCwdMkdirError(e?.message ? String(e.message) : '新建目录失败');
    } finally {
      setCwdMkdirLoading(false);
    }
  }, [cwdFolderName, desiredCwd]);

  const loadDirListing = useCallback(async (dirPath?: string | null) => {
    try {
      setPickerLoading(true);
      setPickerError(null);
      setMkdirError(null);
      const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
      const data = await apiJson<DirListing>(`/fs/dirs${qs}`, undefined, 12000);
      setPickerListing({
        path: data?.path ?? null,
        parent: data?.parent ?? null,
        dirs: Array.isArray(data?.dirs) ? data.dirs : [],
      });
    } catch (e: any) {
      setPickerError(e?.message ? String(e.message) : '读取目录失败');
    } finally {
      setPickerLoading(false);
    }
  }, []);

  const createFolderInPicker = useCallback(async () => {
    const parent = pickerListing?.path;
    const name = newFolderName.trim();
    if (!parent || !name) return;
    try {
      setMkdirLoading(true);
      setMkdirError(null);
      await apiJson(
        '/fs/mkdir',
        { method: 'POST', body: JSON.stringify({ parent, name }) },
        12000,
      );
      setNewFolderName('');
      await loadDirListing(parent);
    } catch (e: any) {
      setMkdirError(e?.message ? String(e.message) : '新建目录失败');
    } finally {
      setMkdirLoading(false);
    }
  }, [loadDirListing, newFolderName, pickerListing?.path]);

  useEffect(() => {
    if (!pickerOpen) return;
    void loadDirListing(null);
  }, [loadDirListing, pickerOpen]);

  useEffect(() => {
    const handler = () => {
      void refreshWorkspace();
    };
    window.addEventListener('workspace:changed', handler);
    return () => window.removeEventListener('workspace:changed', handler);
  }, [refreshWorkspace]);

  useEffect(() => {
    const socket = socketIo(BRIDGE_URL);
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('state:init', (payload: any) => {
      const remote = Array.isArray(payload?.terminals) ? payload.terminals : [];
      if (!remote.length) return;
      // 任务页默认不恢复历史终端：仅同步“本次会话已打开”的终端状态
      setTabs((prev) => {
        if (!prev.length) return prev;
        const knownIds = new Set(prev.map((t) => t.id));
        const filtered = remote.filter((t: any) => {
          const id = String(t?.id || '').trim();
          return Boolean(id) && knownIds.has(id);
        });
        if (!filtered.length) return prev;

        const map = new Map(prev.map((t) => [t.id, t]));
        for (const t of filtered) {
          const existing = map.get(t.id);
          map.set(
            t.id,
            existing
              ? {
                  ...t,
                  kind: existing.kind,
                  specName: existing.specName,
                  taskId: existing.taskId,
                  runDocPath: existing.runDocPath,
                }
              : (t as TerminalTab),
          );
        }
        return Array.from(map.values());
      });
    });

    socket.on('terminal:created', (payload: any) => {
      const terminal = payload?.terminal;
      if (!terminal) return;
      const id = String(terminal?.id || '').trim();
      if (!id) return;
      mergeRemoteTerminals([terminal]);
    });

    socket.on('terminal:data', (payload: any) => {
      const terminalId = String(payload?.terminalId || '').trim();
      if (!terminalId) return;
      const controller = controllersRef.current.get(terminalId);
      if (!controller) return;
      const seq = Number(payload?.seq ?? 0);
      if (Number.isFinite(seq) && seq > 0) {
        if (seq <= controller.lastSeq) return;
        controller.lastSeq = seq;
      }
      const data = String(payload?.data ?? '');
      controller.terminal.write(data);
    });

    socket.on('terminal:exit', (payload: any) => {
      const terminalId = String(payload?.terminalId || '').trim();
      if (!terminalId) return;
      const exitCode = Number(payload?.exitCode ?? -1);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === terminalId
            ? { ...t, running: false, exitCode: Number.isFinite(exitCode) ? exitCode : -1 }
            : t,
        ),
      );
    });

    socket.on('connect_error', () => setConnected(false));

    return () => {
      try {
        socket.disconnect();
      } catch {
        // ignore
      }
      socketRef.current = null;
      setConnected(false);
    };
  }, [mergeRemoteTerminals]);

  useEffect(() => {
    if (!tabs.length) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!activeId) return;
    if (tabs.some((t) => t.id === activeId)) return;
    setActiveId(tabs[0]?.id ?? null);
  }, [activeId, tabs]);

  useEffect(() => {
    if (!activeId) return;
    const container = containersRef.current.get(activeId);
    if (container && !controllersRef.current.has(activeId)) {
      ensureController(activeId, container);
    }
    const controller = controllersRef.current.get(activeId);
    if (!controller) return;
    window.requestAnimationFrame(() => {
      void fitAndReport(activeId);
      try {
        controller.terminal.focus();
      } catch {
        // ignore
      }
    });
  }, [activeId, fitAndReport]);

  useEffect(() => {
    if (!createMenuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const root = createMenuRef.current;
      if (!root) return;
      if (root.contains(e.target as Node)) return;
      setCreateMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [createMenuOpen]);

  useEffect(() => {
    return () => {
      containersRef.current.clear();
      for (const terminalId of controllersRef.current.keys()) {
        disposeController(terminalId);
      }
      controllersRef.current.clear();
    };
  }, [disposeController]);

  const activeTab = useMemo(
    () => (activeId ? tabs.find((t) => t.id === activeId) ?? null : null),
    [activeId, tabs],
  );
  const hasTabs = tabs.length > 0;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <div className="font-semibold text-slate-200">终端</div>
        <div className="text-slate-400">
          {connected ? '已连接' : '未连接'}：{BRIDGE_URL}
        </div>
        {activeTab ? (
          <div className="text-slate-400">
            当前：{activeTab.title}
            {!activeTab.running && activeTab.exitCode != null ? ` (exit ${activeTab.exitCode})` : ''}
          </div>
        ) : hasTabs ? null : (
          <div className="text-slate-500">暂无终端</div>
        )}
        <div className="ml-auto flex items-center gap-2" ref={createMenuRef}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreateMenuOpen((v) => !v)}
          >
            ＋ 新建终端
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenCliConfig?.()}
            disabled={!onOpenCliConfig}
            title="配置 CLI 工具"
          >
            CLI 配置
          </Button>
          {createMenuOpen ? (
            <div className="relative">
              <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-md border border-slate-700 bg-slate-950 shadow-xl">
                <button
                  className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    void createTerminal(pickTerminalShellTemplate(), { kind: 'shell' });
                  }}
                >
                  PowerShell
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    void createTerminal(pickCmdTemplate(), { kind: 'shell' });
                  }}
                >
                  CMD
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    void createTerminal(pickCodexTemplate(), { kind: 'codex' });
                  }}
                >
                  Codex CLI（手动）
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    void createTerminal(pickClaudeAutoTemplate(), { kind: 'claude' });
                  }}
                >
                  Claude Code（全自动）
                </button>
                {cliTools.length ? (
                  <>
                    <div className="border-t border-slate-800" />
                    <div className="px-3 py-1 text-[11px] text-slate-400">CLI Tools</div>
                    {cliTools.map((tool) => (
                      <button
                        key={tool.id}
                        className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          void createCliToolTerminal(tool);
                        }}
                      >
                        {tool.label || tool.id}
                      </button>
                    ))}
                  </>
                ) : null}
                {cliToolsError ? (
                  <div className="border-t border-slate-800 px-3 py-2 text-[11px] text-red-300">
                    {cliToolsError}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <div className="text-slate-400">默认目录</div>
        <input
          className="h-8 w-[460px] max-w-full rounded-md border border-slate-700 bg-slate-950 px-2 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-cyan-500"
          value={cwdDraft}
          onChange={(e) => setCwdDraft(e.target.value)}
          placeholder="例如：D:\\path\\to\\project"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen(true)}
          disabled={cwdSaving}
        >
          选择目录
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void saveWorkspaceCwd()}
          disabled={cwdSaving}
        >
          保存
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void resetWorkspaceCwd()}
          disabled={cwdSaving}
        >
          重置
        </Button>
        <div className="h-4 w-px bg-slate-800" />
        <div className="text-slate-400">新建文件夹</div>
        <input
          className="h-8 w-[220px] max-w-full rounded-md border border-slate-700 bg-slate-950 px-2 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-cyan-500"
          value={cwdFolderName}
          onChange={(e) => setCwdFolderName(e.target.value)}
          placeholder="子目录名"
          disabled={!desiredCwd || cwdMkdirLoading}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createFolderUnderCwd();
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => void createFolderUnderCwd()}
          disabled={!desiredCwd || !cwdFolderName.trim() || cwdMkdirLoading}
        >
          新建并切换
        </Button>
        {cwdMkdirError ? <div className="text-red-300">{cwdMkdirError}</div> : null}
        {workspace?.effectiveCwd ? (
          <div className="text-slate-500">
            生效：<span className="font-mono">{workspace.effectiveCwd}</span>
          </div>
        ) : null}
        {cwdError ? <div className="text-red-300">{cwdError}</div> : null}
      </div>
      {pickerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-[860px] max-w-[96vw] overflow-hidden rounded-lg border border-slate-700 bg-slate-950 shadow-2xl">
            <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3 text-sm text-slate-100">
              <div className="font-semibold">选择默认目录</div>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPickerOpen(false);
                  }}
                >
                  关闭
                </Button>
              </div>
            </div>
            <div className="px-4 py-3 text-xs text-slate-300">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-slate-400">当前位置：</div>
                <div className="font-mono text-slate-100">
                  {pickerListing?.path ?? '(根目录)'}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadDirListing(pickerListing?.parent ?? null)}
                    disabled={pickerLoading || !pickerListing?.parent}
                  >
                    上一级
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadDirListing(pickerListing?.path ?? null)}
                    disabled={pickerLoading || !pickerListing?.path}
                  >
                    刷新
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (!pickerListing?.path) return;
                      setCwdDraft(pickerListing.path);
                      setPickerOpen(false);
                    }}
                    disabled={pickerLoading || !pickerListing?.path}
                  >
                    选择当前
                  </Button>
                </div>
              </div>

              {pickerError ? (
                <div className="mt-2 text-red-300">{pickerError}</div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
                <div className="text-slate-400">新建文件夹</div>
                <input
                  className="h-8 w-[280px] max-w-full rounded-md border border-slate-700 bg-slate-950 px-2 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-cyan-500"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="输入文件夹名"
                  disabled={!pickerListing?.path || mkdirLoading}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createFolderInPicker();
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void createFolderInPicker()}
                  disabled={!pickerListing?.path || !newFolderName.trim() || mkdirLoading}
                >
                  新建
                </Button>
                {mkdirError ? <div className="text-red-300">{mkdirError}</div> : null}
              </div>

              <div className="mt-3 overflow-hidden rounded-md border border-slate-800 bg-slate-950/40">
                <div className="max-h-[420px] overflow-auto">
                  {pickerLoading ? (
                    <div className="px-3 py-3 text-slate-400">加载中…</div>
                  ) : pickerListing?.dirs?.length ? (
                    pickerListing.dirs.map((d) => (
                      <button
                        key={d.path}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-900"
                        onClick={() => void loadDirListing(d.path)}
                        onDoubleClick={() => {
                          setCwdDraft(d.path);
                          setPickerOpen(false);
                        }}
                      >
                        <span className="text-slate-500">dir</span>
                        <span className="font-mono text-xs text-slate-100">{d.name}</span>
                        <span className="ml-auto font-mono text-[10px] text-slate-500">
                          {d.path}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-3 text-slate-500">没有可进入的子目录</div>
                  )}
                </div>
              </div>
              <div className="mt-2 text-[11px] text-slate-500">
                说明：浏览器安全限制无法直接读取系统文件选择器的绝对路径，这里用 Bridge
                后端列目录实现“选择路径”。
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {activeTab?.kind === 'codex-task' && activeTab.specName && activeTab.taskId ? (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
          <div>
            spec: <span className="font-mono">{activeTab.specName}</span>
          </div>
          <div>
            task: <span className="font-mono">{activeTab.taskId}</span>
          </div>
          {activeTab.runDocPath ? (
            <div>
              runDoc: <span className="font-mono">{activeTab.runDocPath}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {!hasTabs ? (
        <div className="mt-2 text-xs text-slate-500">未创建终端（点击“＋ 新建终端”后显示终端区域）</div>
      ) : null}

      {hasTabs && !activeId ? (
        <div className="mt-2 text-xs text-slate-500">已检测到历史终端：点击下方 Tab 继续，或关闭不需要的终端。</div>
      ) : null}

      {hasTabs ? (
        <>
          <div className="mt-2 flex items-center gap-2 overflow-auto rounded-md border border-slate-800 bg-slate-950/50 px-2 py-1">
            {tabs.map((t) => {
              const isActive = t.id === activeId;
              return (
                <div
                  key={t.id}
                  className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
                    isActive ? 'bg-slate-800 text-slate-100' : 'bg-transparent text-slate-300'
                  }`}
                >
                  <button
                    className="max-w-[220px] truncate"
                    onClick={() => setActiveId(t.id)}
                    title={t.title}
                  >
                    {t.title}
                  </button>
                  <button
                    className="ml-1 text-slate-400 hover:text-slate-200"
                    onClick={() => void closeTab(t.id)}
                    title="关闭终端"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-2 overflow-hidden rounded-md border border-slate-700 bg-slate-950">
            {tabs.map((t) => (
              <div
                key={t.id}
                ref={registerContainerRef(t.id)}
                className={`${t.id === activeId ? heightClass : 'hidden'} w-full`}
                onMouseDown={() => {
                  controllersRef.current.get(t.id)?.terminal.focus();
                }}
              />
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <div>点击窗口后可输入；切换 Tab 类似 VSCode 终端</div>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!activeId) return;
                  controllersRef.current.get(activeId)?.terminal.clear();
                }}
                disabled={!activeId}
              >
                清屏
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!activeId) return;
                  void hydrateFromBuffer(activeId);
                }}
                disabled={!activeId}
              >
                补历史
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!activeId) return;
                  void fitAndReport(activeId);
                }}
                disabled={!activeId}
              >
                适配大小
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export const TerminalPanel = forwardRef<
  TerminalPanelHandle,
  { className?: string; heightClass?: string; onOpenCliConfig?: () => void }
>(TerminalPanelInner);
