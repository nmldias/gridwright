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
  preview: { where: string; before: string; after: string }[];
  errors: string[];
  seq: number;
  status: 'pending' | 'applied' | 'rejected';
  decidedBy?: { id: string; name: string; login?: string };
  decidedAt?: string;
  decisionNote?: string;
  appliedSeq?: number;
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

export const api = {
  async health(): Promise<{ ok: boolean; version: string; multiplayer: boolean; pyodide?: boolean; identity?: boolean }> {
    return j(await fetch('/api/health'));
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
    async decide(id: string, pid: string, decision: 'applied' | 'rejected', note?: string, seq?: number, client?: string): Promise<Proposal> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, note, seq, client }) }));
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
