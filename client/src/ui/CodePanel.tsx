import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import * as book from '../engine/book';
import { a1 } from '../engine/types';
import { cellAt, useStore } from '../state/store';
import { runCell } from '../workers/runner';

export function CodePanel() {
  const codeCell = useStore((s) => s.codeCell);
  const tables = useStore((s) => s.tables);
  const cells = useStore((s) => s.cells);
  const runs = useStore((s) => s.runs);
  const pythonStatus = useStore((s) => s.pythonStatus);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langRef = useRef(new Compartment());
  const [draft, setDraft] = useState('');
  const cell = codeCell ? cellAt(codeCell.table, codeCell.row, codeCell.col) : undefined;
  const meta = codeCell ? tables.get(codeCell.table) : undefined;
  const lang = cell?.k === 'python' ? 'python' : cell?.k === 'javascript' ? 'javascript' : null;
  const running = codeCell ? runs.get(`${codeCell.table}:${codeCell.row}:${codeCell.col}`)?.running : false;
  void cells;

  const save = (run: boolean) => {
    if (!codeCell || !viewRef.current || !lang) return;
    const text = viewRef.current.state.doc.toString();
    if (text !== cell?.i) {
      book.apply({ type: 'set_cell', table: codeCell.table, row: codeCell.row, col: codeCell.col, input: text, kind: lang });
    } else if (run) {
      runCell(codeCell);
    }
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
        langRef.current.of(lang === 'python' ? python() : javascript()),
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
        <p className="muted">Select a cell and press <b>Py</b> or <b>JS</b> in the toolbar to turn it into a code cell. Results are written to the cell; lists and tables spill into the cells to the right and below.</p>
        <p className="muted">
          Inside code, <code>q.cells("A1:B5")</code> reads a range (use <code>"Table 2::A1"</code> for another table), <code>q.table()</code> reads the whole table. Python: the last expression is the output (DataFrames spill with a header row). JavaScript: <code>return</code> the value.
        </p>
      </div>
    );
  }

  return (
    <div className="panel code-panel">
      <div className="panel-title">
        <span>
          {lang === 'python' ? 'Python' : 'JavaScript'} · {meta?.name}::{a1(codeCell.row, codeCell.col)}
        </span>
        <span className="grow" />
        {lang === 'python' && <span className={`pill ${pythonStatus}`}>{pythonStatus === 'ready' ? 'runtime ready' : pythonStatus === 'loading' ? 'loading Pyodide…' : pythonStatus === 'error' ? 'runtime error' : 'runtime idle'}</span>}
        <button className="primary" disabled={!!running} onClick={() => save(true)} title="Run (Ctrl+Enter)">
          {running ? 'Running…' : '▶ Run'}
        </button>
      </div>
      <div className="code-editor" ref={host} />
      <div className="code-output">
        {cell.err && <pre className="err">{cell.err}</pre>}
        {cell.out && <pre className="out">{cell.out}</pre>}
        {!cell.err && !cell.out && <div className="muted">Output: {cell.ss ? `${cell.ss[0]} × ${cell.ss[1]} cells` : cell.v ? 'single value' : 'nothing yet'}</div>}
      </div>
      <div className="muted small">Ctrl+Enter runs · Ctrl+S saves without running · results spill from this cell; the table grows to fit.</div>
    </div>
  );
}
