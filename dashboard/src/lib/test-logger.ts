const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:4100';

const TEST_SESSION_STORAGE_KEY = 'mvp5:testSessionId';

function createTestSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `test_${crypto.randomUUID()}`;
  }
  return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function getTestSessionId(): string {
  if (typeof window === 'undefined') return 'test_unknown';
  const raw = String(window.localStorage.getItem(TEST_SESSION_STORAGE_KEY) ?? '').trim();
  if (raw) return raw;
  const created = createTestSessionId();
  window.localStorage.setItem(TEST_SESSION_STORAGE_KEY, created);
  return created;
}

export function resetTestSessionId(): string {
  if (typeof window === 'undefined') return createTestSessionId();
  const created = createTestSessionId();
  window.localStorage.setItem(TEST_SESSION_STORAGE_KEY, created);
  window.dispatchEvent(new CustomEvent('mvp5:testSession:changed', { detail: { sessionId: created } }));
  return created;
}

function headersToRecord(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  try {
    if (typeof Headers !== 'undefined' && init instanceof Headers) {
      init.forEach((value, key) => {
        out[String(key)] = String(value);
      });
      return out;
    }
  } catch {
    // ignore
  }
  if (Array.isArray(init)) {
    for (const pair of init) {
      if (!pair) continue;
      const key = String(pair[0] ?? '').trim();
      if (!key) continue;
      out[key] = String(pair[1] ?? '');
    }
    return out;
  }
  if (typeof init === 'object') {
    for (const [k, v] of Object.entries(init as Record<string, any>)) {
      out[String(k)] = String(v ?? '');
    }
  }
  return out;
}

export function withTestSessionHeaders(init?: HeadersInit): Record<string, string> {
  const headers = headersToRecord(init);
  headers['x-test-session-id'] = getTestSessionId();
  return headers;
}

export type TestLogEventInput = {
  level?: 'debug' | 'info' | 'warn' | 'error' | string;
  source?: string;
  action: string;
  message?: string;
  specId?: string;
  taskId?: string;
  data?: any;
};

export async function postTestLogEvent(input: TestLogEventInput): Promise<void> {
  const sessionId = getTestSessionId();
  const payload = {
    sessionId,
    level: input.level ?? 'info',
    source: input.source ?? 'dashboard',
    action: String(input.action || '').trim() || 'unknown',
    message: typeof input.message === 'string' ? input.message : '',
    specId: typeof input.specId === 'string' ? input.specId : undefined,
    taskId: typeof input.taskId === 'string' ? input.taskId : undefined,
    data: input.data,
  };

  const res = await fetch(`${BRIDGE_URL}/test-logs/event`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...withTestSessionHeaders(),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `日志上报失败：${res.status}`);
  }
}

export async function fetchTestLogTail(options?: {
  sessionId?: string;
  limit?: number;
}): Promise<any[]> {
  const sessionId = String(options?.sessionId || getTestSessionId()).trim();
  const limit = Math.max(1, Math.min(2000, Number(options?.limit ?? 200) || 200));
  const url = `${BRIDGE_URL}/test-logs/tail?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`;
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: withTestSessionHeaders(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(String(data?.error || `读取日志失败：${res.status}`));
  }
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return entries;
}

export function getTestLogDownloadUrl(sessionId?: string) {
  const sid = String(sessionId || getTestSessionId()).trim();
  return `${BRIDGE_URL}/test-logs/download?sessionId=${encodeURIComponent(sid)}`;
}

