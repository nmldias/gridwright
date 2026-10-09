import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { sql } from '@codemirror/lang-sql';
import { api, type ConnectionInfo, type SqlResult } from '../api/client';
import { addTable } from '../grid/actions';
import * as book from '../engine/book';
import { getState, setStatus, useStore } from '../state/store';

const EMPTY: Partial<ConnectionInfo> & { password?: string } = { name: '', kind: 'postgres', host: 'localhost', port: 5432, database: '', user: '', ssl: false, password: '', readOnly: true, allowed: [], maxRows: 5000, timeoutMs: 30000 };

export function SqlPanel() {
  const [conns, setConns] = useState<ConnectionInfo[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [editing, setEditing] = useState<(Partial<ConnectionInfo> & { password?: string }) | null>(null);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<'new' | 'selection'>('new');
  const me = useStore((s) => s.me);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  const refresh = async () => {
    try {
      const list = await api.connections.list();
      setConns(list);
      if (!current && list[0]) setCurrent(list[0].id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!host.current || view.current) return;
    view.current = new EditorView({
      state: EditorState.create({
        doc: 'SELECT * FROM information_schema.tables LIMIT 50',
        extensions: [basicSetup, sql(), Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (void run(), true) }])), EditorView.theme({ '&': { fontSize: '13px' } })],
      }),
      parent: host.current,
    });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing === null]);

  const run = async () => {
    if (!current || !view.current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.connections.query(current, view.current.state.doc.toString());
      setResult(res);
      const values = [res.columns, ...res.rows.map((r) => r.map((v) => (v === null ? '' : String(v))))];
      const sel = getState().selection;
      if (target === 'selection' && sel) {
        book.apply({ type: 'set_cells', table: sel.table, row: sel.r0, col: sel.c0, values }, { origin: 'sql' });
      } else {
        const conn = conns.find((c) => c.id === current);
        addTable({ name: `${conn?.name ?? 'Query'} result`, rows: values.length, cols: res.columns.length, values, origin: 'sql' });
      }
      setStatus(`${res.rowCount} rows in ${res.ms} ms${res.truncated ? ' (truncated)' : ''}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = (e: React.KeyboardEvent) => e.stopPropagation();

  if (editing) {
    const c = editing;
    const upd = (patch: Partial<typeof c>) => setEditing({ ...c, ...patch });
    return (
      <div className="panel">
        <div className="panel-title">{c.id ? 'Edit connection' : 'New connection'}</div>
        <label className="field">
          <span>Name</span>
          <input value={c.name ?? ''} onKeyDown={stop} onChange={(e) => upd({ name: e.target.value })} />
        </label>
        <label className="field">
          <span>Type</span>
          <select value={c.kind} onChange={(e) => upd({ kind: e.target.value as ConnectionInfo['kind'], port: e.target.value === 'mysql' ? 3306 : e.target.value === 'mssql' ? 1433 : 5432 })}>
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL / MariaDB</option>
            <option value="mssql">SQL Server (Cegid Primavera, Azure SQL)</option>
          </select>
        </label>
        <div className="row">
          <label className="field">
            <span>Host</span>
            <input value={c.host ?? ''} onKeyDown={stop} onChange={(e) => upd({ host: e.target.value })} />
          </label>
          <label className="field">
            <span>Port</span>
            <input type="number" value={c.port ?? 5432} onKeyDown={stop} onChange={(e) => upd({ port: Number(e.target.value) })} />
          </label>
        </div>
        <label className="field">
          <span>Database</span>
          <input value={c.database ?? ''} onKeyDown={stop} onChange={(e) => upd({ database: e.target.value })} />
        </label>
        <div className="row">
          <label className="field">
            <span>User</span>
            <input value={c.user ?? ''} onKeyDown={stop} onChange={(e) => upd({ user: e.target.value })} />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={c.password ?? ''} placeholder={c.hasPassword ? '(unchanged)' : ''} onKeyDown={stop} onChange={(e) => upd({ password: e.target.value })} />
          </label>
        </div>
        <label className="field check">
          <input type="checkbox" checked={!!c.ssl} onChange={(e) => upd({ ssl: e.target.checked })} />
          <span>Use SSL</span>
        </label>
        <label className="field check">
          <input type="checkbox" checked={c.readOnly !== false} onChange={(e) => upd({ readOnly: e.target.checked })} />
          <span>Read-only: only SELECT statements, run inside a read-only transaction where the database supports it (recommended — pair it with a read-only database login)</span>
        </label>
        {c.readOnly === false && <div className="err small">Read-write: anyone allowed to use this connection can change the database. Keep this for admin work only.</div>}
        <label className="field">
          <span>Allowed logins (comma-separated; empty = every editor; administrators always)</span>
          <input value={(c.allowed ?? []).join(', ')} onKeyDown={stop} placeholder="ana@example.com, rui@example.com" onChange={(e) => upd({ allowed: e.target.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) })} />
        </label>
        <div className="row">
          <label className="field">
            <span>Row limit per query</span>
            <input type="number" value={c.maxRows ?? 5000} onKeyDown={stop} onChange={(e) => upd({ maxRows: Number(e.target.value) || 5000 })} />
          </label>
          <label className="field">
            <span>Statement timeout (ms)</span>
            <input type="number" value={c.timeoutMs ?? 30000} onKeyDown={stop} onChange={(e) => upd({ timeoutMs: Number(e.target.value) || 30000 })} />
          </label>
        </div>
        <div className="row">
          <button
            className="primary"
            onClick={async () => {
              try {
                const saved = await api.connections.save(c);
                setEditing(null);
                setCurrent(saved.id);
                await refresh();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Save
          </button>
          <button onClick={() => setEditing(null)}>Cancel</button>
        </div>
        {error && <div className="err small">{error}</div>}
        <p className="muted small">Credentials are stored on the server (encrypted at rest with the server's key), never in the document. SQL Server: tick SSL for Azure SQL or servers with Force Encryption; the certificate is not verified.</p>
      </div>
    );
  }

  return (
    <div className="panel sql-panel">
      <div className="panel-title">SQL</div>
      <div className="row">
        <select value={current} onChange={(e) => setCurrent(e.target.value)}>
          {conns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.kind}{c.readOnly === false ? ', read-write' : ''})
            </option>
          ))}
          {!conns.length && <option value="">No connections</option>}
        </select>
        <button onClick={() => setEditing({ ...EMPTY })} disabled={me.role !== 'admin'} title={me.role !== 'admin' ? 'administrators only' : ''}>
          + New
        </button>
        <button
          disabled={!current || me.role !== 'admin'}
          onClick={() => {
            const c = conns.find((x) => x.id === current);
            if (c) setEditing({ ...c, password: '' });
          }}
        >
          Edit
        </button>
        <button
          disabled={!current}
          onClick={async () => {
            try {
              const r = await api.connections.test(current);
              setStatus(r.ok ? `Connection OK: ${r.message}` : `Connection failed: ${r.message}`, 8000);
            } catch (e) {
              setStatus(`Connection failed: ${(e as Error).message}`, 8000);
            }
          }}
        >
          Test
        </button>
        <button
          className="danger"
          disabled={!current}
          onClick={async () => {
            if (!confirm('Delete this connection?')) return;
            await api.connections.remove(current);
            setCurrent('');
            await refresh();
          }}
        >
          ×
        </button>
      </div>
      {conns.find((x) => x.id === current)?.readOnly === false && <div className="err small">This connection is read-write: statements here change the database.</div>}
      {conns.find((x) => x.id === current)?.readOnly !== false && current && <div className="muted small">Read-only connection: SELECT statements only, up to {conns.find((x) => x.id === current)?.maxRows ?? 5000} rows.</div>}
      <div className="code-editor sql" ref={host} />
      <div className="row">
        <select value={target} onChange={(e) => setTarget(e.target.value as 'new' | 'selection')}>
          <option value="new">Results → new table</option>
          <option value="selection">Results → at selection</option>
        </select>
        <button
          disabled={!current}
          title="Create a SQL cell at the selection that re-runs this query (and can take {{A1}} parameters)"
          onClick={() => {
            const sel = getState().selection;
            if (!sel || !view.current) return;
            book.apply({ type: 'set_cell', table: sel.table, row: sel.ar, col: sel.ac, input: view.current.state.doc.toString(), kind: 'sql', conn: current, refresh: 0 });
            useStore.setState({ panel: 'code', codeCell: { table: sel.table, row: sel.ar, col: sel.ac } });
          }}
        >
          → SQL cell
        </button>
        <button className="primary" disabled={busy || !current} onClick={() => void run()} title="Run (Ctrl+Enter)">
          {busy ? 'Running…' : '▶ Run query'}
        </button>
      </div>
      {error && <div className="err small">{error}</div>}
      {result && (
        <div className="muted small">
          {result.rowCount} rows · {result.columns.length} columns · {result.ms} ms{result.truncated ? ' · truncated to the row limit' : ''}
        </div>
      )}
    </div>
  );
}
