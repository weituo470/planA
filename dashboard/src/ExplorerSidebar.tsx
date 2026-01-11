import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from './components/ui/button';
import { withTestSessionHeaders } from './lib/test-logger';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:4100';

type WorkspaceInfo = {
  defaultCwd: string | null;
  effectiveCwd: string;
  repoDir?: string | null;
};

type FsEntry = {
  name: string;
  path: string;
  type: 'dir' | 'file';
};

type FsListing = {
  path: string | null;
  parent: string | null;
  entries: FsEntry[];
};

type ClipboardState = {
  mode: 'copy' | 'cut';
  entry: FsEntry;
};

async function apiJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 12000,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, {
      ...init,
      headers: {
        ...withTestSessionHeaders(init?.headers),
        'content-type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

function basenameAnyPath(value: string) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return value;
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function dirnameAnyPath(value: string) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return '';
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) {
    if (/^[a-zA-Z]:$/.test(normalized)) return `${normalized}\\`;
    return '';
  }
  const dir = normalized.slice(0, lastSlash);
  if (/^[a-zA-Z]:$/.test(dir)) return `${dir}\\`;
  return dir.replace(/\//g, '\\');
}

function makeRootEntry(pathValue: string): FsEntry {
  const name = basenameAnyPath(pathValue) || pathValue;
  return { name, path: pathValue, type: 'dir' };
}

export function ExplorerSidebar({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);

  const [dirCache, setDirCache] = useState<Record<string, FsListing>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadingByDir, setLoadingByDir] = useState<Record<string, boolean>>({});
  const [errorByDir, setErrorByDir] = useState<Record<string, string | null>>({});
  const [opError, setOpError] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);

  const dirCacheRef = useRef<Record<string, FsListing>>({});
  const loadingRef = useRef<Set<string>>(new Set());

  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    entry: FsEntry | null;
    scopeDir: string | null;
  }>({ open: false, x: 0, y: 0, entry: null, scopeDir: null });

  const menuRef = useRef<HTMLDivElement | null>(null);

  const refreshWorkspace = useCallback(async () => {
    const data = await apiJson<WorkspaceInfo>('/workspace', undefined, 8000);
    setWorkspace(data);
    const effective = String(data?.effectiveCwd || '').trim();
    if (effective) {
      setRootPath(effective);
      setExpanded((prev) => (prev[effective] ? prev : { ...prev, [effective]: true }));
      setSelectedPath((prev) => prev ?? effective);
    }
    return data;
  }, []);

  const loadDir = useCallback(
    async (dirPath: string, options?: { force?: boolean }) => {
      const key = String(dirPath || '').trim();
      if (!key) return;
      if (!options?.force && dirCacheRef.current[key]) return;
      if (loadingRef.current.has(key)) return;

      loadingRef.current.add(key);
      setLoadingByDir((prev) => ({ ...prev, [key]: true }));
      setErrorByDir((prev) => ({ ...prev, [key]: null }));
      try {
        const qs = `?path=${encodeURIComponent(key)}`;
        const data = await apiJson<FsListing>(`/fs/list${qs}`, undefined, 12000);
        setDirCache((prev) => {
          const next = {
            ...prev,
            [key]: {
              path: data?.path ?? key,
              parent: data?.parent ?? null,
              entries: Array.isArray(data?.entries) ? data.entries : [],
            },
          };
          dirCacheRef.current = next;
          return next;
        });
      } catch (e: any) {
        setErrorByDir((prev) => ({
          ...prev,
          [key]: e?.message ? String(e.message) : 'Failed to load directory',
        }));
      } finally {
        loadingRef.current.delete(key);
        setLoadingByDir((prev) => ({ ...prev, [key]: false }));
      }
    },
    [],
  );

  const refreshTree = useCallback(async () => {
    setOpError(null);
    const ws = await refreshWorkspace().catch(() => null);
    const root = String(ws?.effectiveCwd || '').trim();
    if (!root) return;
    setDirCache(() => {
      dirCacheRef.current = {};
      return {};
    });
    setErrorByDir({});
    setLoadingByDir({});
    loadingRef.current.clear();
    setExpanded({ [root]: true });
    await loadDir(root, { force: true });
  }, [loadDir, refreshWorkspace]);

  useEffect(() => {
    void (async () => {
      const ws = await refreshWorkspace().catch(() => null);
      const root = String(ws?.effectiveCwd || '').trim();
      if (root) {
        await loadDir(root, { force: true });
      }
    })();
  }, [loadDir, refreshWorkspace]);

  useEffect(() => {
    const handler = () => {
      void refreshTree();
    };
    window.addEventListener('workspace:changed', handler);
    return () => window.removeEventListener('workspace:changed', handler);
  }, [refreshTree]);

  useEffect(() => {
    if (!menu.open) return;
    const onDocMouseDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node;
      if (!target) return;
      const menuEl = menuRef.current;
      if (menuEl && menuEl.contains(target)) return;
      setMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [menu.open]);

  const showContextMenu = useCallback(
    (e: ReactMouseEvent, entry: FsEntry | null, scopeDir: string | null) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ open: true, x: e.clientX, y: e.clientY, entry, scopeDir });
    },
    [],
  );

  const copyToClipboard = useCallback(async (text: string) => {
    const value = String(text || '').trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      window.prompt('Copy path:', value);
    }
  }, []);

  const createFolder = useCallback(
    async (parentPath: string) => {
      const parent = String(parentPath || '').trim();
      if (!parent) return;
      const name = window.prompt('New folder name?')?.trim();
      if (!name) return;
      setOpError(null);
      try {
        await apiJson(
          '/fs/mkdir',
          { method: 'POST', body: JSON.stringify({ parent, name }) },
          20000,
        );
        await loadDir(parent, { force: true });
        setExpanded((prev) => ({ ...prev, [parent]: true }));
      } catch (e: any) {
        setOpError(e?.message ? String(e.message) : 'Failed to create folder');
      }
    },
    [loadDir],
  );

  const createFile = useCallback(
    async (parentPath: string) => {
      const parent = String(parentPath || '').trim();
      if (!parent) return;
      const name = window.prompt('New file name?')?.trim();
      if (!name) return;
      setOpError(null);
      try {
        await apiJson(
          '/fs/touch',
          { method: 'POST', body: JSON.stringify({ parent, name }) },
          20000,
        );
        await loadDir(parent, { force: true });
        setExpanded((prev) => ({ ...prev, [parent]: true }));
      } catch (e: any) {
        setOpError(e?.message ? String(e.message) : 'Failed to create file');
      }
    },
    [loadDir],
  );

  const renameEntry = useCallback(
    async (entry: FsEntry) => {
      const newName = window.prompt('Rename to?', entry.name)?.trim();
      if (!newName || newName === entry.name) return;
      setOpError(null);
      try {
        await apiJson(
          '/fs/rename',
          { method: 'POST', body: JSON.stringify({ path: entry.path, newName }) },
          20000,
        );
        const parent = dirnameAnyPath(entry.path);
        if (parent) await loadDir(parent, { force: true });
      } catch (e: any) {
        setOpError(e?.message ? String(e.message) : 'Failed to rename');
      }
    },
    [loadDir],
  );

  const deleteEntry = useCallback(
    async (entry: FsEntry) => {
      const ok = window.confirm(`Delete ${entry.name}?`);
      if (!ok) return;
      setOpError(null);
      try {
        await apiJson('/fs/delete', { method: 'POST', body: JSON.stringify({ path: entry.path }) }, 20000);
        const parent = dirnameAnyPath(entry.path);
        if (parent) await loadDir(parent, { force: true });
      } catch (e: any) {
        setOpError(e?.message ? String(e.message) : 'Failed to delete');
      }
    },
    [loadDir],
  );

  const setAsDefaultCwd = useCallback(async (dirPath: string) => {
    const cwd = String(dirPath || '').trim();
    if (!cwd) return;
    setOpError(null);
    await apiJson(
      '/workspace',
      { method: 'POST', body: JSON.stringify({ defaultCwd: cwd }) },
      12000,
    );
    window.dispatchEvent(new Event('workspace:changed'));
  }, []);

  const pasteInto = useCallback(
    async (destDir: string) => {
      if (!clipboard) return;
      const dest = String(destDir || '').trim();
      if (!dest) return;
      setOpError(null);
      const srcParent = dirnameAnyPath(clipboard.entry.path);
      try {
        await apiJson(
          '/fs/paste',
          {
            method: 'POST',
            body: JSON.stringify({
              srcPath: clipboard.entry.path,
              destDir: dest,
              mode: clipboard.mode,
            }),
          },
          30000,
        );
        await loadDir(dest, { force: true });
        if (clipboard.mode === 'cut') {
          setClipboard(null);
          if (srcParent) await loadDir(srcParent, { force: true });
        }
      } catch (e: any) {
        setOpError(e?.message ? String(e.message) : 'Failed to paste');
      }
    },
    [clipboard, loadDir],
  );

  const toggleExpanded = useCallback(
    (dirPath: string) => {
      const key = String(dirPath || '').trim();
      if (!key) return;
      setExpanded((prev) => {
        const nextOpen = !prev[key];
        if (nextOpen && !dirCache[key]) void loadDir(key);
        return { ...prev, [key]: nextOpen };
      });
    },
    [dirCache, loadDir],
  );

  const renderTreeNode = useCallback(
    (entry: FsEntry, depth: number) => {
      const isDir = entry.type === 'dir';
      const isOpen = isDir ? Boolean(expanded[entry.path]) : false;
      const isSelected = selectedPath === entry.path;
      const listing = isDir ? dirCache[entry.path] : null;
      const isLoading = isDir ? Boolean(loadingByDir[entry.path]) : false;
      const error = isDir ? errorByDir[entry.path] : null;
      const children = listing?.entries ?? [];

      return (
        <div key={entry.path}>
          <div
            className={`group flex cursor-default items-center gap-1 rounded px-2 py-1 text-xs ${
              isSelected ? 'bg-slate-900/70 text-slate-100' : 'text-slate-200 hover:bg-slate-900/50'
            }`}
            style={{ paddingLeft: depth * 14 + 8 }}
            onClick={() => setSelectedPath(entry.path)}
            onDoubleClick={() => {
              if (isDir) toggleExpanded(entry.path);
            }}
            onContextMenu={(e) =>
              showContextMenu(e, entry, entry.type === 'dir' ? entry.path : null)
            }
            title={entry.path}
          >
            {isDir ? (
              <button
                className="flex h-4 w-4 items-center justify-center text-slate-500 hover:text-slate-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleExpanded(entry.path);
                }}
                aria-label={isOpen ? 'Collapse folder' : 'Expand folder'}
              >
                {isOpen ? '▾' : '▸'}
              </button>
            ) : (
              <span className="inline-block h-4 w-4" />
            )}
            <span className="w-6 shrink-0 text-slate-500">{isDir ? 'dir' : 'file'}</span>
            <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
          </div>
          {isDir && isOpen ? (
            <div>
              {isLoading ? (
                <div
                  className="px-2 py-1 text-[11px] text-slate-500"
                  style={{ paddingLeft: (depth + 1) * 14 + 18 }}
                >
                  Loading…
                </div>
              ) : null}
              {error ? (
                <div
                  className="px-2 py-1 text-[11px] text-red-300"
                  style={{ paddingLeft: (depth + 1) * 14 + 18 }}
                >
                  {error}
                </div>
              ) : null}
              {!isLoading && !error && !children.length ? (
                <div
                  className="px-2 py-1 text-[11px] text-slate-500"
                  style={{ paddingLeft: (depth + 1) * 14 + 18 }}
                >
                  (empty)
                </div>
              ) : null}
              {!isLoading && !error ? children.map((c) => renderTreeNode(c, depth + 1)) : null}
            </div>
          ) : null}
        </div>
      );
    },
    [
      dirCache,
      errorByDir,
      expanded,
      loadingByDir,
      selectedPath,
      showContextMenu,
      toggleExpanded,
    ],
  );

  const rootEntry = useMemo(() => {
    const root = String(rootPath || '').trim();
    return root ? makeRootEntry(root) : null;
  }, [rootPath]);

  const headerPath = useMemo(() => {
    if (rootPath) return rootPath;
    return workspace?.effectiveCwd ?? '';
  }, [rootPath, workspace?.effectiveCwd]);

  if (!open) return null;

  return (
    <aside
      className="relative flex min-h-0 w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-950/40"
      onContextMenu={(e) => showContextMenu(e, null, rootPath)}
    >
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-xs">
        <div className="font-semibold text-slate-200">Explorer</div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshTree()}
            disabled={!rootPath}
            title="Refresh"
          >
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={onToggle} title="Collapse">
            Collapse
          </Button>
        </div>
      </div>

      <div className="border-b border-slate-800 px-3 py-2 text-[11px] text-slate-400">
        <div className="truncate" title={headerPath}>
          {headerPath || '(no workspace)'}
        </div>
        {clipboard ? (
          <div className="mt-1 text-slate-500">
            clipboard: {clipboard.mode} {basenameAnyPath(clipboard.entry.path)}
          </div>
        ) : null}
        {opError ? <div className="mt-1 text-red-300">{opError}</div> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {rootEntry ? (
          renderTreeNode(rootEntry, 0)
        ) : (
          <div className="px-2 py-2 text-xs text-slate-500">No workspace directory.</div>
        )}
      </div>

      {menu.open ? (
        <div
          ref={menuRef}
          className="fixed z-50 w-56 overflow-hidden rounded-md border border-slate-700 bg-slate-950 shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="border-b border-slate-800 px-3 py-2 text-[11px] text-slate-400">
            {menu.entry ? menu.entry.name : 'Explorer'}
          </div>
          <div className="py-1">
            {menu.scopeDir ? (
              <>
                <button
                  className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                  onClick={() => {
                    setMenu((prev) => ({ ...prev, open: false }));
                    void createFile(menu.scopeDir!);
                  }}
                >
                  New File
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                  onClick={() => {
                    setMenu((prev) => ({ ...prev, open: false }));
                    void createFolder(menu.scopeDir!);
                  }}
                >
                  New Folder
                </button>
                {clipboard ? (
                  <button
                    className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                    onClick={() => {
                      setMenu((prev) => ({ ...prev, open: false }));
                      void pasteInto(menu.scopeDir!);
                    }}
                  >
                    Paste
                  </button>
                ) : null}
              </>
            ) : null}

            {menu.entry ? (
              <>
                {menu.entry.type === 'dir' ? (
                  <button
                    className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                    onClick={() => {
                      setMenu((prev) => ({ ...prev, open: false }));
                      void setAsDefaultCwd(menu.entry!.path);
                    }}
                  >
                    Set as default terminal cwd
                  </button>
                ) : null}
                <button
                  className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                  onClick={() => {
                    setMenu((prev) => ({ ...prev, open: false }));
                    setClipboard({ mode: 'copy', entry: menu.entry! });
                  }}
                >
                  Copy
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                  onClick={() => {
                    setMenu((prev) => ({ ...prev, open: false }));
                    setClipboard({ mode: 'cut', entry: menu.entry! });
                  }}
                >
                  Cut
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                  onClick={() => {
                    setMenu((prev) => ({ ...prev, open: false }));
                    void copyToClipboard(menu.entry?.path ?? '');
                  }}
                >
                  Copy Path
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                  onClick={() => {
                    setMenu((prev) => ({ ...prev, open: false }));
                    void renameEntry(menu.entry!);
                  }}
                >
                  Rename
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-xs text-red-300 hover:bg-slate-900"
                  onClick={() => {
                    setMenu((prev) => ({ ...prev, open: false }));
                    void deleteEntry(menu.entry!);
                  }}
                >
                  Delete
                </button>
              </>
            ) : (
              <button
                className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-900"
                onClick={() => {
                  setMenu((prev) => ({ ...prev, open: false }));
                  void refreshTree();
                }}
                disabled={!rootPath}
              >
                Refresh
              </button>
            )}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
