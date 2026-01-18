import { useEffect, useMemo, useState } from 'react';

type SpecSummary = {
  spec_id: string;
  created_at: string;
  updated_at: string;
};

type SpecDetail = {
  spec_id: string;
  prompt_text: string | null;
  status_json: string | null;
  created_at: string;
  updated_at: string;
};

type StageAttempt = {
  id: number;
  stage_key: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
  error_context: string | null;
  created_at: string;
};

type ArtifactSummary = {
  id: number;
  artifact_type: string;
  version: number;
  created_at: string;
};

type PromptFinal = {
  id: number;
  stage_key: string | null;
  model: string | null;
  provider_id: string | null;
  prompt_text: string;
  created_at: string;
};

type LlmSummary = {
  id: number;
  stage_key: string | null;
  model: string | null;
  provider_id: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
};

type LlmDetail = {
  id: number;
  spec_id: string | null;
  stage_key: string | null;
  model: string | null;
  provider_id: string | null;
  request_text: string;
  response_text: string | null;
  response_content: string | null;
  usage_json: string | null;
  status: string;
  error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  created_at: string;
};

type EventItem = {
  id: number;
  event_type: string;
  payload_text: string | null;
  created_at: string;
};

type Mvp5PlanItem = {
  id: number;
  plan_id: string;
  spec_id: string | null;
  payload_text: string | null;
  created_at: string;
};

type Mvp5ExecutionItem = {
  id: number;
  execution_id: string;
  spec_id: string | null;
  status: string | null;
  payload_text: string | null;
  created_at: string;
  updated_at: string;
};

const API_BASE = String(import.meta.env.VITE_ADMIN_API_URL || '').trim();
const TOKEN_KEY = 'plana_admin_token';

async function apiFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status}`);
  }
  return res.json() as Promise<T>;
}

function safeJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [username, setUsername] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [specQuery, setSpecQuery] = useState('');
  const [selectedSpecId, setSelectedSpecId] = useState<string | null>(null);

  const [specDetail, setSpecDetail] = useState<SpecDetail | null>(null);
  const [stages, setStages] = useState<StageAttempt[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [prompts, setPrompts] = useState<PromptFinal[]>([]);
  const [llmList, setLlmList] = useState<LlmSummary[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [mvp5Plans, setMvp5Plans] = useState<Mvp5PlanItem[]>([]);
  const [mvp5Executions, setMvp5Executions] = useState<Mvp5ExecutionItem[]>([]);

  const [selectedLlmId, setSelectedLlmId] = useState<number | null>(null);
  const [llmDetail, setLlmDetail] = useState<LlmDetail | null>(null);
  const [globalError, setGlobalError] = useState('');

  const isAuthed = Boolean(token);

  const specStatusParsed = useMemo(() => safeJson(specDetail?.status_json || null), [specDetail?.status_json]);
  const llmUsageParsed = useMemo(() => safeJson(llmDetail?.usage_json || null), [llmDetail?.usage_json]);

  useEffect(() => {
    if (!token) return;
    apiFetch<{ ok: boolean; username: string }>('/api/admin/me', token)
      .then((data) => {
        setUsername(data.username);
      })
      .catch(() => {
        setToken('');
        localStorage.removeItem(TOKEN_KEY);
      });
  }, [token]);

  useEffect(() => {
    if (!isAuthed) return;
    loadSpecs();
  }, [isAuthed]);

  useEffect(() => {
    if (!isAuthed || !selectedSpecId) return;
    loadSpecDetails(selectedSpecId);
  }, [isAuthed, selectedSpecId]);

  useEffect(() => {
    if (!isAuthed || !selectedLlmId) {
      setLlmDetail(null);
      return;
    }
    apiFetch<{ ok: boolean; item: LlmDetail }>(`/api/admin/llm/${selectedLlmId}`, token)
      .then((data) => setLlmDetail(data.item))
      .catch((err) => setGlobalError(err.message));
  }, [isAuthed, selectedLlmId, token]);

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError('');
    setLoginBusy(true);
    const form = new FormData(event.currentTarget);
    const usernameInput = String(form.get('username') || '').trim();
    const passwordInput = String(form.get('password') || '');
    try {
      const data = await apiFetch<{ ok: boolean; token: string; username: string }>(
        '/api/admin/login',
        '',
        {
          method: 'POST',
          body: JSON.stringify({ username: usernameInput, password: passwordInput }),
        },
      );
      setToken(data.token);
      setUsername(data.username);
      localStorage.setItem(TOKEN_KEY, data.token);
    } catch (err) {
      setLoginError((err as Error).message || 'Login failed');
    } finally {
      setLoginBusy(false);
    }
  }

  function handleLogout() {
    setToken('');
    setUsername('');
    setSelectedSpecId(null);
    localStorage.removeItem(TOKEN_KEY);
  }

  async function loadSpecs() {
    setGlobalError('');
    const params = new URLSearchParams();
    if (specQuery.trim()) params.set('q', specQuery.trim());
    try {
      const data = await apiFetch<{ ok: boolean; items: SpecSummary[] }>(
        `/api/admin/specs?${params.toString()}`,
        token,
      );
      setSpecs(data.items || []);
      if (!selectedSpecId && data.items?.length) {
        setSelectedSpecId(data.items[0].spec_id);
      }
    } catch (err) {
      setGlobalError((err as Error).message || 'Failed to load specs');
    }
  }

  async function loadSpecDetails(specId: string) {
    setGlobalError('');
    setSelectedLlmId(null);
    try {
      const [specRes, stagesRes, artifactsRes, promptsRes, llmRes, eventsRes, plansRes, execRes] =
        await Promise.all([
          apiFetch<{ ok: boolean; item: SpecDetail }>(`/api/admin/specs/${specId}`, token),
          apiFetch<{ ok: boolean; items: StageAttempt[] }>(`/api/admin/specs/${specId}/stages`, token),
          apiFetch<{ ok: boolean; items: ArtifactSummary[] }>(`/api/admin/specs/${specId}/artifacts`, token),
          apiFetch<{ ok: boolean; items: PromptFinal[] }>(`/api/admin/specs/${specId}/prompts`, token),
          apiFetch<{ ok: boolean; items: LlmSummary[] }>(`/api/admin/specs/${specId}/llm`, token),
          apiFetch<{ ok: boolean; items: EventItem[] }>(`/api/admin/specs/${specId}/events`, token),
          apiFetch<{ ok: boolean; items: Mvp5PlanItem[] }>(`/api/admin/mvp5/plans?specId=${specId}`, token),
          apiFetch<{ ok: boolean; items: Mvp5ExecutionItem[] }>(
            `/api/admin/mvp5/executions?specId=${specId}`,
            token,
          ),
        ]);
      setSpecDetail(specRes.item);
      setStages(stagesRes.items || []);
      setArtifacts(artifactsRes.items || []);
      setPrompts(promptsRes.items || []);
      setLlmList(llmRes.items || []);
      setEvents(eventsRes.items || []);
      setMvp5Plans(plansRes.items || []);
      setMvp5Executions(execRes.items || []);
    } catch (err) {
      setGlobalError((err as Error).message || 'Failed to load spec data');
    }
  }

  if (!isAuthed) {
    return (
      <div className="panel login">
        <h2>Admin Login</h2>
        <form className="stack" onSubmit={handleLogin}>
          <input className="field" name="username" placeholder="Username" required />
          <input className="field" name="password" placeholder="Password" type="password" required />
          {loginError && <div className="error">{loginError}</div>}
          <button className="button" type="submit" disabled={loginBusy}>
            {loginBusy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
        <div className="muted" style={{ marginTop: 12 }}>
          API base: {API_BASE || 'same origin'}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="header">
        <h1>Plana Admin</h1>
        <div className="row">
          <span className="pill">{username || 'admin'}</span>
          <button className="button secondary" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </div>
      <div className="content">
        <div className="panel">
          <h2>Specs</h2>
          <div className="stack">
            <div className="row">
              <input
                className="field"
                placeholder="Search specId"
                value={specQuery}
                onChange={(e) => setSpecQuery(e.target.value)}
              />
              <button className="button ghost" onClick={loadSpecs}>
                Refresh
              </button>
            </div>
            <div className="spec-list">
              {specs.map((spec) => (
                <button
                  key={spec.spec_id}
                  className={`spec-item ${spec.spec_id === selectedSpecId ? 'active' : ''}`}
                  onClick={() => setSelectedSpecId(spec.spec_id)}
                >
                  <div>{spec.spec_id}</div>
                  <div className="muted">Updated: {spec.updated_at}</div>
                </button>
              ))}
              {specs.length === 0 && <div className="muted">No specs</div>}
            </div>
          </div>
        </div>
        <div className="panel">
          <h2>Spec Detail</h2>
          {globalError && <div className="error">{globalError}</div>}
          {!specDetail && <div className="muted">Select a spec</div>}
          {specDetail && (
            <div className="stack">
              <div className="kv">
                <div>SpecId</div>
                <div>{specDetail.spec_id}</div>
                <div>Created</div>
                <div>{specDetail.created_at}</div>
                <div>Updated</div>
                <div>{specDetail.updated_at}</div>
              </div>
              <div className="section">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>Prompt</strong>
                </div>
                <pre>{specDetail.prompt_text || ''}</pre>
              </div>
              <div className="section">
                <strong>Status JSON</strong>
                <pre>{specStatusParsed ? JSON.stringify(specStatusParsed, null, 2) : specDetail.status_json || ''}</pre>
              </div>
              <div className="section">
                <strong>Stages</strong>
                <div className="list">
                  {stages.map((item) => (
                    <div key={item.id} className="item-card">
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <strong>{item.stage_key}</strong>
                        <span className="pill">{item.status}</span>
                      </div>
                      <div className="muted">Started: {item.started_at || '-'}</div>
                      <div className="muted">Ended: {item.ended_at || '-'}</div>
                      {item.error_message && <div className="error">{item.error_message}</div>}
                    </div>
                  ))}
                  {stages.length === 0 && <div className="muted">No stages</div>}
                </div>
              </div>
              <div className="section">
                <strong>Artifacts</strong>
                <div className="list">
                  {artifacts.map((item) => (
                    <div key={item.id} className="item-card">
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <div>{item.artifact_type}</div>
                        <span className="pill">v{item.version}</span>
                      </div>
                      <div className="muted">Created: {item.created_at}</div>
                    </div>
                  ))}
                  {artifacts.length === 0 && <div className="muted">No artifacts</div>}
                </div>
              </div>
              <div className="section">
                <strong>Final Prompts</strong>
                <div className="list">
                  {prompts.map((item) => (
                    <div key={item.id} className="item-card">
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <div>{item.stage_key || 'unknown'}</div>
                        <span className="pill">{item.model || '-'}</span>
                      </div>
                      <div className="muted">Created: {item.created_at}</div>
                      <pre>{item.prompt_text}</pre>
                    </div>
                  ))}
                  {prompts.length === 0 && <div className="muted">No prompts</div>}
                </div>
              </div>
              <div className="section">
                <strong>LLM Conversations</strong>
                <div className="list">
                  {llmList.map((item) => (
                    <div key={item.id} className="item-card">
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <div>
                          {item.stage_key || 'unknown'} · {item.model || '-'}
                        </div>
                        <span className="pill">{item.status}</span>
                      </div>
                      <div className="muted">Started: {item.started_at || '-'}</div>
                      <div className="row" style={{ marginTop: 6 }}>
                        <button className="button ghost" onClick={() => setSelectedLlmId(item.id)}>
                          View Detail
                        </button>
                      </div>
                    </div>
                  ))}
                  {llmList.length === 0 && <div className="muted">No conversations</div>}
                </div>
                {llmDetail && (
                  <div className="section">
                    <strong>LLM Detail #{llmDetail.id}</strong>
                    <div className="kv" style={{ marginTop: 8 }}>
                      <div>Spec</div>
                      <div>{llmDetail.spec_id || '-'}</div>
                      <div>Stage</div>
                      <div>{llmDetail.stage_key || '-'}</div>
                      <div>Status</div>
                      <div>{llmDetail.status}</div>
                      <div>Duration</div>
                      <div>{llmDetail.duration_ms ?? '-'} ms</div>
                    </div>
                    {llmDetail.error_message && <div className="error">{llmDetail.error_message}</div>}
                    <div className="section">
                      <strong>Request</strong>
                      <pre>{llmDetail.request_text}</pre>
                    </div>
                    <div className="section">
                      <strong>Response Raw</strong>
                      <pre>{llmDetail.response_text || ''}</pre>
                    </div>
                    <div className="section">
                      <strong>Response Content</strong>
                      <pre>{llmDetail.response_content || ''}</pre>
                    </div>
                    <div className="section">
                      <strong>Usage</strong>
                      <pre>{llmUsageParsed ? JSON.stringify(llmUsageParsed, null, 2) : llmDetail.usage_json || ''}</pre>
                    </div>
                  </div>
                )}
              </div>
              <div className="section">
                <strong>Events</strong>
                <div className="list">
                  {events.map((item) => (
                    <div key={item.id} className="item-card">
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <div>{item.event_type}</div>
                        <span className="pill">{item.created_at}</span>
                      </div>
                      {item.payload_text && <pre>{item.payload_text}</pre>}
                    </div>
                  ))}
                  {events.length === 0 && <div className="muted">No events</div>}
                </div>
              </div>
              <div className="section">
                <strong>MVP5 Plans</strong>
                <div className="list">
                  {mvp5Plans.map((item) => (
                    <div key={item.id} className="item-card">
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <div>{item.plan_id}</div>
                        <span className="pill">{item.created_at}</span>
                      </div>
                      {item.payload_text && <pre>{item.payload_text}</pre>}
                    </div>
                  ))}
                  {mvp5Plans.length === 0 && <div className="muted">No plans</div>}
                </div>
              </div>
              <div className="section">
                <strong>MVP5 Executions</strong>
                <div className="list">
                  {mvp5Executions.map((item) => (
                    <div key={item.id} className="item-card">
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <div>{item.execution_id}</div>
                        <span className="pill">{item.status || '-'}</span>
                      </div>
                      <div className="muted">Updated: {item.updated_at}</div>
                      {item.payload_text && <pre>{item.payload_text}</pre>}
                    </div>
                  ))}
                  {mvp5Executions.length === 0 && <div className="muted">No executions</div>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
