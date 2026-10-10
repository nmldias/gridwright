import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { sql } from '@codemirror/lang-sql';
import { api, type ConnectionInfo } from '../api/client';
import * as book from '../engine/book';
import { a1, isCodeKind, type CellKind } from '../engine/types';
import { cellAt, useStore } from '../state/store';
import { runCell } from '../workers/runner';
import { clearDraft, draftKey, getDraft, hasDraft, setDraft as keepDraft } from './drafts';
import { PanelHeader } from './PanelHeader';

const REFRESH_OPTIONS: { label: string; value: number }[] = [
  { label: 'no auto-refresh', value: 0 },
  { label: 'every 30 s', value: 30 },
  { label: 'every minute', value: 60 },
  { label: 'every 5 min', value: 300 },
  { label: 'every 15 min', value: 900 },
  { label: 'every hour', value: 3600 },
];

export function CodePanel() {
  const codeCell = useStore((s) => s.codeCell);
  const tables = useStore((s) => s.tables);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const runs = useStore((s) => s.runs);
  const pythonStatus = useStore((s) => s.pythonStatus);
  const serverPython = useStore((s) => s.serverPython);
  const fileId = useStore((s) => s.fileId);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langRef = useRef(new Compartment());
  const [draft, setDraft] = useState('');
  const [conns, setConns] = useState<ConnectionInfo[]>([]);
  const cell = codeCell ? cellAt(codeCell.table, codeCell.row, codeCell.col) : undefined;
  const dkey = codeCell ? draftKey(fileId, codeCell) : '';
  const rememberDraft = (text: string) => {
    setDraft(text);
    if (!codeCell) return;
    if (text === (cellAt(codeCell.table, codeCell.row, codeCell.col)?.i ?? '')) clearDraft(dkey);
    else keepDraft(dkey, text);
  };
  const meta = codeCell ? tables.get(codeCell.table) : undefined;
  const lang: CellKind | null = cell && isCodeKind(cell.k) ? cell.k : null;
  const running = codeCell ? runs.get(`${codeCell.table}:${codeCell.row}:${codeCell.col}`)?.running : false;
  void cellsVersion;

  useEffect(() => {
    if (lang === 'sql') api.connections.list().then(setConns).catch(() => setConns([]));
  }, [lang]);

  const save = (run: boolean) => {
    if (!codeCell || !viewRef.current || !lang) return;
    const text = viewRef.current.state.doc.toString();
    clearDraft(dkey);
    if (text !== cell?.i) {
      book.apply({ type: 'set_cell', table: codeCell.table, row: codeCell.row, col: codeCell.col, input: text, kind: lang, conn: cell?.conn ?? null, refresh: cell?.refresh ?? 0, runtime: cell?.runtime ?? null, gpu: cell?.gpu ?? null });
    } else if (run) {
      runCell(codeCell);
    }
  };

  const setMeta = (patch: { conn?: string | null; refresh?: number; runtime?: string | null; gpu?: boolean }) => {
    if (!codeCell || !cell || !lang) return;
    const text = viewRef.current?.state.doc.toString() ?? cell.i;
    book.apply({
      type: 'set_cell',
      table: codeCell.table,
      row: codeCell.row,
      col: codeCell.col,
      input: text,
      kind: lang,
      conn: patch.conn !== undefined ? patch.conn : (cell.conn ?? null),
      refresh: patch.refresh !== undefined ? patch.refresh : (cell.refresh ?? 0),
      runtime: patch.runtime !== undefined ? patch.runtime : (cell.runtime ?? null),
      gpu: patch.gpu !== undefined ? patch.gpu : (cell.gpu ?? null),
    });
  };
  const onServer = lang === 'python' && cell?.runtime === 'server';
  const onAgent = lang === 'python' && cell?.runtime === 'agent';

  // (re)create the editor when the target cell changes
  useEffect(() => {
    if (!host.current) return;
    viewRef.current?.destroy();
    viewRef.current = null;
    if (!codeCell || !lang) return;
    // an unsaved edit left here earlier comes back; the committed code otherwise
    const initial = getDraft(dkey) ?? cell?.i ?? '';
    const state = EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        Prec.highest(
          keymap.of([
            { key: 'Mod-Enter', run: () => (save(true), true) },
            { key: 'Mod-s', run: () => (save(false), true) },
            indentWithTab,
          ]),
        ),
        langRef.current.of(lang === 'python' ? python() : lang === 'sql' ? sql() : javascript()),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) rememberDraft(u.state.doc.toString());
        }),
        EditorView.theme({ '&': { fontSize: '13px', height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }),
      ],
    });
    viewRef.current = new EditorView({ state, parent: host.current });
    setDraft(initial);
    viewRef.current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeCell?.table, codeCell?.row, codeCell?.col, lang]);

  // when the engine's copy changes externally (undo, remote), refresh the editor text
  useEffect(() => {
    const v = viewRef.current;
    if (!v || !cell) return;
    // only when nothing is being edited here: an unsaved draft is never overwritten silently
    if (cell.i !== v.state.doc.toString() && !hasDraft(dkey)) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: cell.i } });
      setDraft(cell.i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell?.i]);

  if (!codeCell || !cell || !lang) {
    return (
      <div className="panel">
        <PanelHeader title="Code" />
        <p className="muted">
          Select a cell and press <b>Python</b> in the toolbar (JavaScript and SQL cells are under its caret) to turn it into a code cell. Results are written to the cell; lists and tables spill into the cells to the right and below.
        </p>
        <p className="muted">
          Inside code, <code>q.cells("A1:B5")</code> reads a range (use <code>"Table 2::A1"</code> for another table), <code>q.table()</code> reads the whole table. Python: the last expression is the output (DataFrames spill with a header row). JavaScript: <code>return</code> the value. SQL: the query result spills; <code>{'{{A1}}'}</code> binds a cell as a parameter.
        </p>
      </div>
    );
  }

  const title = lang === 'python' ? 'Python' : lang === 'javascript' ? 'JavaScript' : 'SQL';
  const unsaved = draft !== cell.i;
  return (
    <div className="panel code-panel">
      <PanelHeader title={title} subtitle={`${meta?.name}::${a1(codeCell.row, codeCell.col)}`}>
        {onAgent && <span className={`pill ${serverPython?.agent ? 'ready' : 'error'}`} title="An agent cell: your code runs in the cell sandbox with no network; Gridwright and the model are reached only through the agent channel, as you, by a short-lived agent token — the companion's context, tools and model are in `companion`. Whatever it records is proposed, never ratified; no key is ever inside the cell.">{serverPython?.agent ? `agent · ${serverPython.sandbox === 'bwrap' ? 'sandboxed' : serverPython.sandbox === 'unshare' ? 'no network' : 'unsandboxed'} · proposes` : 'agent stack not installed'}</span>}
        {lang === 'python' && !onServer && !onAgent && <span className={`pill ${pythonStatus}`}>{pythonStatus === 'ready' ? 'runtime ready' : pythonStatus === 'loading' ? 'loading Pyodide…' : pythonStatus === 'error' ? 'runtime error' : 'runtime idle'}</span>}
        {onServer && <span className={`pill ${serverPython ? 'ready' : 'error'}`} title={serverPython ? `CPython ${serverPython.version} on the server · sandbox: ${serverPython.sandbox} · ${serverPython.gpu?.startsWith('cudf') ? 'GPU: ' + serverPython.gpu : 'no GPU'}` : 'the server has no Python runtime'}>{serverPython ? `server · ${serverPython.sandbox === 'bwrap' ? 'sandboxed' : serverPython.sandbox === 'unshare' ? 'no network' : 'unsandboxed'}` : 'server runtime off'}</span>}
        <button className="primary" disabled={!!running} onClick={() => save(true)} title="Run (Ctrl+Enter)">
          {running ? 'Running…' : '▶ Run'}
        </button>
      </PanelHeader>
      {unsaved && (
        <div className="small draft-note">
          Unsaved edit — Ctrl+S keeps it without running, Run commits and runs it.{' '}
          <button
            className="link small"
            onClick={() => {
              clearDraft(dkey);
              viewRef.current?.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: cell.i } });
              setDraft(cell.i);
            }}
          >
            discard
          </button>
        </div>
      )}
      <div className="row wrap small-row">
        {lang === 'python' && (
          <select
            className="runtime-select"
            value={onAgent ? 'agent' : onServer ? 'server' : 'browser'}
            onChange={(e) => setMeta({ runtime: e.target.value === 'server' ? 'server' : e.target.value === 'agent' ? 'agent' : null, gpu: e.target.value === 'server' ? (cell.gpu ?? false) : false })}
            title={serverPython ? `Where this cell runs. Server: CPython ${serverPython.version} (${serverPython.memoryMb} MB, ${Math.round(serverPython.timeoutMs / 1000)} s per run). Agent: the same sandbox, the companion in its namespace, Gridwright and the model through the agent channel` : 'This server has no Python runtime; the browser runs the cell'}
          >
            <option value="browser">run in the browser (Pyodide)</option>
            <option value="server" disabled={!serverPython || serverPython.can?.run === false}>
              {serverPython ? (serverPython.can?.run === false ? 'run on the server (not permitted for your login)' : `run on the server (CPython ${serverPython.version})`) : 'run on the server (not available)'}
            </option>
            <option value="agent" disabled={!serverPython?.agent || serverPython.can?.run === false}>
              {serverPython?.agent ? (serverPython.can?.run === false ? 'agent cell (not permitted for your login)' : 'agent cell — LangChain · DeepAgents · LangGraph, the companion in `companion`, sandboxed') : 'agent cell (stack not installed: scripts/install.sh --companion)'}
            </option>
          </select>
        )}
        {onServer && (
          <label className="check" title={serverPython?.gpu?.startsWith('cudf') ? `cudf.pandas on ${serverPython.gpu} — pandas code runs on the GPU when the data is large` : `GPU not available on the server: ${serverPython?.gpu ?? 'unknown'}. The cell runs on the CPU.`}>
            <input type="checkbox" checked={!!cell.gpu} disabled={serverPython?.can?.gpu === false} onChange={(e) => setMeta({ gpu: e.target.checked })} /> GPU{serverPython?.can?.gpu === false ? ' (not permitted)' : serverPython?.gpu?.startsWith('cudf') ? '' : ' (unavailable)'}
          </label>
        )}
        {lang === 'sql' && (
          <select value={cell.conn ?? ''} onChange={(e) => setMeta({ conn: e.target.value || null })} title="Connection">
            <option value="">— choose a connection —</option>
            {conns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind})
              </option>
            ))}
          </select>
        )}
        <select value={cell.refresh ?? 0} onChange={(e) => setMeta({ refresh: Number(e.target.value) })} title="Re-run periodically while the document is open">
          {REFRESH_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="code-editor" ref={host} />
      <div className="code-output">
        {cell.err && <pre className="err">{cell.err}</pre>}
        {cell.out && <pre className="out">{cell.out}</pre>}
        {!cell.err && !cell.out && (
          <div className="muted">
            Output:{' '}
            {cell.v && 's' in cell.v && cell.v.s.startsWith('data:image/')
              ? `picture (${cell.ss?.[0]} × ${cell.ss?.[1]} cells)`
              : cell.ss
                ? `${cell.ss[0]} × ${cell.ss[1]} cells`
                : cell.v
                  ? `single value — ${'n' in cell.v ? String(cell.v.n) : 's' in cell.v ? cell.v.s.slice(0, 200) : 'b' in cell.v ? (cell.v.b ? 'TRUE' : 'FALSE') : 'e' in cell.v ? cell.v.e : ''}`
                  : 'nothing yet'}
          </div>
        )}
      </div>
      <div className="muted small">
        Ctrl+Enter runs · Ctrl+S saves without running · results spill from this cell; the table grows to fit{lang === 'sql' ? ' · {{A1}} and {{Table::B2}} bind cell values as query parameters; a range becomes a list for IN (…)' : ''}
        {onServer ? ' · on the server the code runs as a fresh process with no network and no access to the data directory; every run is logged with the sandbox level' : ''}
        {onAgent ? ' · an agent cell runs in the cell sandbox with no network: Gridwright and the model (through the server\'s proxy, so no key is inside) are reached only through the agent channel, as you, by a short-lived token — whatever it records is proposed, never ratified' : ''}.
      </div>
      {onAgent && (
        <div className="muted small agent-help">
          <b>companion</b> — <code>companion.context()</code> · <code>companion.understanding()</code> · <code>companion.table("inventory")</code> → DataFrame · <code>companion.evaluate("=SUM(inventory[Landed cost (Kz)])")</code> · <code>companion.run_python(code)</code> (sandboxed, kept as evidence) · <code>companion.remember("hypothesis", "…")</code> / <code>propose_watch(…)</code> / <code>propose_edit(…)</code> (proposed) · <code>companion.tools</code> (LangChain) · <code>companion.model()</code> (ChatOpenAI) · <code>companion.agent(system_prompt=…)</code> (DeepAgents) · <code>companion.ask("…")</code> (on the document's LangGraph thread). <code>q</code> and pandas as in any cell; the last expression is the output.
        </div>
      )}
    </div>
  );
}
