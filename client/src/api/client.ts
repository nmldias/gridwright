// REST client for the Gridwright server.

export interface FileInfo {
  id: string;
  name: string;
  updatedAt: string;
  size: number;
  folder?: string;
  owner?: string;
  ownerName?: string;
  public?: 'edit' | 'view' | 'none';
  shared?: number;
  permission?: 'none' | 'view' | 'sign' | 'edit' | 'own';
}

export interface FileAccess {
  owner: string;
  ownerName?: string;
  public: 'edit' | 'view' | 'none';
  shares: Record<string, 'view' | 'edit' | 'sign'>;
  folder: string;
  permission: 'none' | 'view' | 'sign' | 'edit' | 'own';
  identity: boolean;
}

export interface ConnectionInfo {
  id: string;
  name: string;
  kind: 'postgres' | 'mysql' | 'mssql';
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  hasPassword: boolean;
  /** SELECT only, enforced by the server (and by a read-only transaction where the database has one) */
  readOnly?: boolean;
  /** logins allowed to use this connection (empty = every editor; admins always) */
  allowed?: string[];
  maxRows?: number;
  timeoutMs?: number;
}

export interface SqlResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
}

export interface AiSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  configured: boolean;
}

export interface HistoryEntry {
  seq: number;
  ts: string;
  author: { id: string; name: string; login?: string };
  origin: string;
  op?: Record<string, unknown>;
  checkpoint?: boolean;
  note?: string;
  run?: { table: number; row: number; col: number; kind: string; codeHash: string; inputsHash: string; outputHash: string; ok: boolean; error?: string; ms: number; runtime: { name: string; version: string; packages: Record<string, string> }; at: string };
}

export type SqlParam = string | number | boolean | null;

export interface Proposal {
  id: string;
  document: string;
  by: { id: string; name: string; login?: string };
  agent: string;
  at: string;
  title: string;
  rationale: string;
  actions: Record<string, unknown>[];
  ops: Record<string, unknown>[];
  /** before → after of each edit, then (`effect`) every cell whose value moves as a consequence */
  preview: { where: string; before: string; after: string; effect?: true }[];
  errors: string[];
  seq: number;
  status: 'pending' | 'applied' | 'rejected';
  decidedBy?: { id: string; name: string; login?: string };
  decidedAt?: string;
  decisionNote?: string;
  appliedSeq?: number;
  appliedSeqs?: number[];
  command?: string;
}

// --- the companion ---------------------------------------------------------------------------
export type RecordKind = 'fact' | 'source' | 'objective' | 'hypothesis' | 'contradiction' | 'decision' | 'exclusion';
export const RECORD_KINDS: RecordKind[] = ['objective', 'exclusion', 'decision', 'fact', 'source', 'hypothesis', 'contradiction'];
export interface ContextRecord {
  id: string;
  kind: RecordKind;
  text: string;
  source?: string;
  period?: string;
  arrivedAt: string;
  by: { id: string; name: string; login?: string };
  origin: 'user' | 'agent' | 'system';
  status: 'stated' | 'proposed' | 'confirmed' | 'retired' | 'superseded';
  supersededBy?: string;
  links?: { table?: number; ref?: string }[];
}
export interface WatchDef {
  purpose: string;
  scope: string;
  formula: string;
  table?: string;
  kind: 'threshold' | 'check' | 'change';
  op?: '>' | '>=' | '<' | '<=' | '=' | '!=';
  value?: number;
  sustain: number;
  response: 'note' | 'brief' | 'case';
  sources?: string[];
  freshnessHours?: number;
}
export interface Observation {
  at: string;
  seq: number;
  value: number | boolean | string | null;
  error?: string;
  breach: boolean;
  fresh: boolean;
  def: string;
}
export interface Issue {
  id: string;
  watch: string;
  openedAt: string;
  updatedAt: string;
  status: 'open' | 'resolved';
  resolvedAt?: string;
  revision: number;
  summary: string;
  evidence: string[];
  uncertainty: string[];
  next: string;
  interpretation?: { text: string; model: string; at: string; revision: number };
}
export type Health = 'ok' | 'baseline' | 'attention' | 'stale' | 'error' | 'unchecked' | 'proposed';
export interface Watch {
  id: string;
  def: WatchDef;
  defHash: string;
  authority: 'proposed' | 'approved';
  by: { id: string; name: string; login?: string };
  origin: 'user' | 'agent';
  createdAt: string;
  updatedAt: string;
  lastChecked?: string;
  health: Health;
  observations: Observation[];
  issue?: Issue;
  history: Issue[];
}
export interface CompanionEvent {
  at: string;
  kind: string;
  text: string;
  by?: string;
  level: 'quiet' | 'watch' | 'attention';
}
export interface SourceStatus {
  name: string;
  kind: 'table';
  lastChange?: string;
  supply: 'import' | 'live' | 'manual' | 'unknown';
  rows: number;
}
export interface Brief {
  changed: string[];
  matters: string[];
  next: string[];
  health: { checked?: string; ok: number; baseline: number; attention: number; stale: number; error: number; unchecked: number; proposed: number };
  sources: SourceStatus[];
}
export interface GraphNode {
  id: string;
  type: string;
  label: string;
  table?: number;
  status?: string;
  health?: Health;
  supply?: SourceStatus['supply'];
  lastChange?: string;
  rows?: number;
  period?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  via: string;
}
export interface Companion {
  records: ContextRecord[];
  watches: Watch[];
  events: CompanionEvent[];
  brief: Brief;
  seenAt?: string;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
}

export type ToolEvent =
  | { kind: 'call'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'result'; id: string; name: string; ok: boolean; summary: string; result?: unknown }
  | { kind: 'notice'; text: string };

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/** What /api/health says about server-side Python (null = off). */
export interface ServerPython {
  version: string;
  sandbox: 'bwrap' | 'unshare' | 'none' | null;
  gpu: string | null;
  timeoutMs: number;
  memoryMb: number;
  /** what the signed-in person may do: run on the server, ask for the GPU */
  can?: { run: boolean; gpu: boolean };
}
export interface ServerPythonResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  std_out: string;
  deps: { table: number; r0: number; c0: number; r1: number; c1: number }[];
  runtime: { name: string; version: string; packages: Record<string, string> };
  ms: number;
  /** the run record the server computed and logged itself (server-side runs of a saved document) */
  record?: Record<string, unknown>;
}

export class ProposalConflictError extends Error {
  constructor(
    message: string,
    public proposal?: Proposal,
  ) {
    super(message);
  }
}

export const api = {
  async health(): Promise<{ ok: boolean; version: string; multiplayer: boolean; pyodide?: boolean; identity?: boolean; python?: ServerPython | null }> {
    return j(await fetch('/api/health'));
  },
  python: {
    async run(code: string, snapshot: unknown, gpu: boolean, cell?: { file: string; table: number; row: number; col: number; kind: string; startedAt: string; client: string }): Promise<ServerPythonResult> {
      return j(await fetch('/api/python/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, snapshot, gpu, cell }) }));
    },
    async status(): Promise<ServerPython & { available: boolean; reason?: string }> {
      return j(await fetch('/api/python'));
    },
    /** administrators: detect interpreter, sandbox and cuDF again */
    async probe(): Promise<{ available: boolean; version: string; sandbox: 'bwrap' | 'unshare' | 'none' | null; gpu: string | null; reason?: string; fallbacks?: string; limits: { timeoutMs: number; memoryMb: number } }> {
      return j(await fetch('/api/python/probe', { method: 'POST' }));
    },
  },
  async me(): Promise<{ login: string; name: string; role: 'admin' | 'editor' | 'viewer'; identity: boolean }> {
    return j(await fetch('/api/me'));
  },
  files: {
    async list(): Promise<FileInfo[]> {
      return j(await fetch('/api/files'));
    },
    async get(id: string): Promise<{ id: string; name: string; json: string; seq: number; permission?: FileInfo['permission']; folder?: string }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}`));
    },
    async create(name: string, json: string, client?: string, folder?: string): Promise<FileInfo & { seq: number }> {
      return j(await fetch('/api/files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, json, client, folder }) }));
    },
    async access(id: string): Promise<FileAccess> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/access`));
    },
    async setAccess(id: string, patch: Partial<Pick<FileAccess, 'public' | 'shares' | 'folder' | 'owner' | 'ownerName'>>): Promise<FileAccess> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/access`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }));
    },
    historyCsvUrl(id: string): string {
      return `/api/files/${encodeURIComponent(id)}/history.csv`;
    },
    async proposals(id: string, status?: Proposal['status']): Promise<Proposal[]> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/proposals${status ? `?status=${status}` : ''}`));
    },
    async propose(id: string, body: { title: string; rationale?: string; actions: Record<string, unknown>[]; agent?: string; client?: string }): Promise<Proposal> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    /** The server commits (or refuses) the decision; a 409 carries the fresh preview to review again. */
    async decide(id: string, pid: string, decision: 'applied' | 'rejected', note?: string, seq?: number, client?: string, command?: string): Promise<Proposal> {
      const res = await fetch(`/api/files/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, note, seq, client, command }) });
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string; proposal?: Proposal };
        throw new ProposalConflictError(body.error ?? 'the document changed since this proposal was reviewed', body.proposal);
      }
      return j(res);
    },
    async refreshProposal(id: string, pid: string): Promise<Proposal> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}/refresh`, { method: 'POST' }));
    },
    /** A checkpoint built by the server from the log — how a sign-off share persists. */
    // the companion: context records, watches, issues, the brief and the graph
    async companion(id: string): Promise<Companion> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion`));
    },
    async companionSeen(id: string): Promise<void> {
      await fetch(`/api/files/${encodeURIComponent(id)}/companion/seen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    },
    async companionCheck(id: string): Promise<Companion & { attention: number; changed: boolean }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    },
    async addRecord(id: string, body: { kind: RecordKind; text: string; source?: string; period?: string; links?: { table?: number; ref?: string }[]; client?: string }): Promise<ContextRecord> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async updateRecord(id: string, rid: string, body: { text?: string; status?: 'confirmed' | 'retired' | 'stated'; period?: string; source?: string; kind?: RecordKind; client?: string }): Promise<ContextRecord> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/records/${encodeURIComponent(rid)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async removeRecord(id: string, rid: string): Promise<void> {
      await j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/records/${encodeURIComponent(rid)}`, { method: 'DELETE' }));
    },
    async addWatch(id: string, body: Partial<WatchDef> & { client?: string }): Promise<Watch> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/watches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async updateWatch(id: string, wid: string, body: { approve?: boolean; def?: Partial<WatchDef>; reason?: string; client?: string }): Promise<Watch> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/watches/${encodeURIComponent(wid)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async removeWatch(id: string, wid: string): Promise<void> {
      await j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/watches/${encodeURIComponent(wid)}`, { method: 'DELETE' }));
    },
    async interpret(id: string, issueId: string, again = false): Promise<Issue> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/interpret/${encodeURIComponent(issueId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ again }) }));
    },
    async checkpoint(id: string, client?: string): Promise<{ id: string; seq: number }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/checkpoint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client }) }));
    },
    async save(id: string, name: string, json: string, client?: string, seq?: number): Promise<FileInfo & { seq: number }> {
      return j(
        await fetch(`/api/files/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, json, client, seq }),
        }),
      );
    },
    async remove(id: string): Promise<void> {
      await j(await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    },
    async history(id: string, limit = 200, before?: number): Promise<{ seq: number; entries: HistoryEntry[] }> {
      const q = new URLSearchParams({ limit: String(limit) });
      if (before) q.set('before', String(before));
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/history?${q}`));
    },
    async cellHistory(id: string, table: number, row: number, col: number): Promise<{ entries: HistoryEntry[] }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/history/cell?table=${table}&row=${row}&col=${col}`));
    },
    async replay(id: string, seq: number): Promise<{ checkpointSeq: number; json: string | null; ops: HistoryEntry[] } | null> {
      const res = await fetch(`/api/files/${encodeURIComponent(id)}/history/replay?seq=${seq}`);
      if (res.status === 404) return null;
      return j(res);
    },
  },
  connections: {
    async list(): Promise<ConnectionInfo[]> {
      return j(await fetch('/api/connections'));
    },
    async save(c: Partial<ConnectionInfo> & { password?: string }): Promise<ConnectionInfo> {
      const method = c.id ? 'PUT' : 'POST';
      const url = c.id ? `/api/connections/${encodeURIComponent(c.id)}` : '/api/connections';
      return j(await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) }));
    },
    async remove(id: string): Promise<void> {
      await j(await fetch(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    },
    async test(id: string): Promise<{ ok: boolean; message: string }> {
      return j(await fetch(`/api/connections/${encodeURIComponent(id)}/test`, { method: 'POST' }));
    },
    async query(id: string, sql: string, limit = 5000, params: SqlParam[] = []): Promise<SqlResult> {
      return j(
        await fetch(`/api/connections/${encodeURIComponent(id)}/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql, limit, params }),
        }),
      );
    },
  },
  ai: {
    async settings(): Promise<AiSettings> {
      return j(await fetch('/api/ai/settings'));
    },
    async saveSettings(s: { baseUrl?: string; model?: string; apiKey?: string }): Promise<AiSettings> {
      return j(await fetch('/api/ai/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }));
    },
    async models(): Promise<{ models: string[]; error?: string }> {
      return j(await fetch('/api/ai/models'));
    },
    /** Streams assistant text chunks; resolves with the full text. */
    async chat(
      messages: { role: string; content: string }[],
      onChunk: (text: string) => void,
      signal?: AbortSignal,
      opts: { tools?: boolean; file?: string | null; onTool?: (ev: ToolEvent) => void } = {},
    ): Promise<string> {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, tools: !!opts.tools, file: opts.file ?? undefined }),
        signal,
      });
      if (!res.ok || !res.body) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let full = '';
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const obj = JSON.parse(data);
            if (obj.error) throw new Error(obj.error);
            if (obj.tool) opts.onTool?.({ kind: 'call', id: obj.tool.id, name: obj.tool.name, args: obj.tool.args });
            if (obj.tool_result) opts.onTool?.({ kind: 'result', id: obj.tool_result.id, name: obj.tool_result.name, ok: obj.tool_result.ok, summary: obj.tool_result.summary, result: obj.tool_result.result });
            if (obj.notice) opts.onTool?.({ kind: 'notice', text: obj.notice });
            const delta: string = obj.text ?? '';
            if (delta) {
              full += delta;
              onChunk(delta);
            }
          } catch (e) {
            if (e instanceof Error && e.message && !e.message.startsWith('Unexpected')) throw e;
          }
        }
      }
      return full;
    },
  },
};
