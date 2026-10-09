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
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langRef = useRef(new Compartment());
  const [draft, setDraft] = useState('');
  const [conns, setConns] = useState<ConnectionInfo[]>([]);
  const cell = codeCell ? cellAt(codeCell.table, codeCell.row, codeCell.col) : undefined;
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
    if (text !== cell?.i) {
      book.apply({ type: 'set_cell', table: codeCell.table, row: codeCell.row, col: codeCell.col, input: text, kind: lang, conn: cell?.conn ?? null, refresh: cell?.refresh ?? 0 });
    } else if (run) {
      runCell(codeCell);
    }
  };

  const setMeta = (patch: { conn?: string | null; refresh?: number }) => {
    if (!codeCell || !cell || !lang) return;
    const text = viewRef.current?.state.doc.toString() ?? cell.i;
    book.apply({ type: 'set_cell', table: codeCell.table, row: codeCell.row, col: codeCell.col, input: text, kind: lang, conn: patch.conn !== undefined ? patch.conn : (cell.conn ?? null), refresh: patch.refresh !== undefined ? patch.refresh : (cell.refresh ?? 0) });
  };

  // (re)create the editor when the target cell changes
  useEffect(() => {
    if (!host.current) return;
    viewRef.current?.destroy();
    viewRef.current = null;
    if (!codeCell || !lang) return;
    const state = EditorState.create({
      doc: cell?.i ?? '',
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
          if (u.docChanged) setDraft(u.state.doc.toString());
        }),
        EditorView.theme({ '&': { fontSize: '13px', height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }),
      ],
    });
    viewRef.current = new EditorView({ state, parent: host.current });
    setDraft(cell?.i ?? '');
    viewRef.current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeCell?.table, codeCell?.row, codeCell?.col, lang]);

  // when the engine's copy changes externally (undo, remote), refresh the editor text
  useEffect(() => {
    const v = viewRef.current;
    if (!v || !cell) return;
    if (cell.i !== v.state.doc.toString() && cell.i !== draft) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: cell.i } });
      setDraft(cell.i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell?.i]);

  if (!codeCell || !cell || !lang) {
    return (
      <div className="panel">
        <div className="panel-title">Code</div>
        <p className="muted">
          Select a cell and press <b>Py</b>, <b>JS</b> or <b>SQL</b> in the toolbar to turn it into a code cell. Results are written to the cell; lists and tables spill into the cells to the right and below.
        </p>
        <p className="muted">
          Inside code, <code>q.cells("A1:B5")</code> reads a range (use <code>"Table 2::A1"</code> for another table), <code>q.table()</code> reads the whole table. Python: the last expression is the output (DataFrames spill with a header row). JavaScript: <code>return</code> the value. SQL: the query result spills; <code>{'{{A1}}'}</code> binds a cell as a parameter.
        </p>
      </div>
    );
  }

  const title = lang === 'python' ? 'Python' : lang === 'javascript' ? 'JavaScript' : 'SQL';
  return (
    <div className="panel code-panel">
      <div className="panel-title">
        <span>
          {title} · {meta?.name}::{a1(codeCell.row, codeCell.col)}
        </span>
        <span className="grow" />
        {lang === 'python' && <span className={`pill ${pythonStatus}`}>{pythonStatus === 'ready' ? 'runtime ready' : pythonStatus === 'loading' ? 'loading Pyodide…' : pythonStatus === 'error' ? 'runtime error' : 'runtime idle'}</span>}
        <button className="primary" disabled={!!running} onClick={() => save(true)} title="Run (Ctrl+Enter)">
          {running ? 'Running…' : '▶ Run'}
        </button>
      </div>
      <div className="row wrap small-row">
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
        {!cell.err && !cell.out && <div className="muted">Output: {cell.v && 's' in cell.v && cell.v.s.startsWith('data:image/') ? `picture (${cell.ss?.[0]} × ${cell.ss?.[1]} cells)` : cell.ss ? `${cell.ss[0]} × ${cell.ss[1]} cells` : cell.v ? 'single value' : 'nothing yet'}</div>}
      </div>
      <div className="muted small">Ctrl+Enter runs · Ctrl+S saves without running · results spill from this cell; the table grows to fit{lang === 'sql' ? ' · {{A1}} and {{Table::B2}} bind cell values as query parameters; a range becomes a list for IN (…)' : ''}.</div>
    </div>
  );
}
