// REST client for the Gridwright server.

export interface FileInfo {
  id: string;
  name: string;
  updatedAt: string;
  size: number;
}

export interface ConnectionInfo {
  id: string;
  name: string;
  kind: 'postgres' | 'mysql';
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  hasPassword: boolean;
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
  async health(): Promise<{ ok: boolean; version: string; multiplayer: boolean }> {
    return j(await fetch('/api/health'));
  },
  files: {
    async list(): Promise<FileInfo[]> {
      return j(await fetch('/api/files'));
    },
    async get(id: string): Promise<{ id: string; name: string; json: string }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}`));
    },
    async create(name: string, json: string): Promise<FileInfo> {
      return j(await fetch('/api/files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, json }) }));
    },
    async save(id: string, name: string, json: string): Promise<FileInfo> {
      return j(
        await fetch(`/api/files/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, json }),
        }),
      );
    },
    async remove(id: string): Promise<void> {
      await j(await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' }));
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
    async query(id: string, sql: string, limit = 5000): Promise<SqlResult> {
      return j(
        await fetch(`/api/connections/${encodeURIComponent(id)}/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql, limit }),
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
    /** Streams assistant text chunks; resolves with the full text. */
    async chat(messages: { role: string; content: string }[], onChunk: (text: string) => void, signal?: AbortSignal): Promise<string> {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
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
