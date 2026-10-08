import { useEffect, useState } from 'react';
import * as book from '../engine/book';
import { deleteSelectedTable } from '../grid/actions';
import { exportTableCsv } from '../grid/ContextMenu';
import { useStore } from '../state/store';

export function TablePanel() {
  const selection = useStore((s) => s.selection);
  const selectedTable = useStore((s) => s.selectedTable);
  const tables = useStore((s) => s.tables);
  const id = selectedTable ?? selection?.table ?? null;
  const meta = id !== null ? tables.get(id) : undefined;
  const [name, setName] = useState(meta?.name ?? '');
  const [rows, setRows] = useState(meta?.rows ?? 0);
  const [cols, setCols] = useState(meta?.cols ?? 0);

  useEffect(() => {
    setName(meta?.name ?? '');
    setRows(meta?.rows ?? 0);
    setCols(meta?.cols ?? 0);
  }, [meta?.name, meta?.rows, meta?.cols, meta?.id]);

  if (!meta) {
    return (
      <div className="panel">
        <div className="panel-title">Table</div>
        <p className="muted">Select a table.</p>
      </div>
    );
  }
  const sel = selection && selection.table === meta.id ? selection : null;
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();

  return (
    <div className="panel">
      <div className="panel-title">Table</div>
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={stop}
          onBlur={() => name.trim() && name !== meta.name && book.apply({ type: 'rename_table', table: meta.id, name: name.trim() })}
        />
      </label>
      <div className="row">
        <label className="field">
          <span>Rows</span>
          <input type="number" min={1} value={rows} onKeyDown={stop} onChange={(e) => setRows(Number(e.target.value))} onBlur={() => rows !== meta.rows && rows >= 1 && book.apply({ type: 'resize_table', table: meta.id, rows, cols: meta.cols })} />
        </label>
        <label className="field">
          <span>Columns</span>
          <input type="number" min={1} value={cols} onKeyDown={stop} onChange={(e) => setCols(Number(e.target.value))} onBlur={() => cols !== meta.cols && cols >= 1 && book.apply({ type: 'resize_table', table: meta.id, rows: meta.rows, cols })} />
        </label>
      </div>
      <label className="field check">
        <input type="checkbox" checked={meta.header_rows > 0} onChange={(e) => book.apply({ type: 'set_header_rows', table: meta.id, header_rows: e.target.checked ? 1 : 0 })} />
        <span>Header row</span>
      </label>
      <div className="panel-subtitle">Rows &amp; columns at the selection</div>
      <div className="row wrap">
        <button disabled={!sel} onClick={() => sel && book.apply({ type: 'insert_rows', table: meta.id, at: sel.r0, count: sel.r1 - sel.r0 + 1 })}>
          Insert rows above
        </button>
        <button disabled={!sel} onClick={() => sel && book.apply({ type: 'insert_rows', table: meta.id, at: sel.r1 + 1, count: sel.r1 - sel.r0 + 1 })}>
          Insert rows below
        </button>
        <button disabled={!sel} onClick={() => sel && book.apply({ type: 'delete_rows', table: meta.id, at: sel.r0, count: sel.r1 - sel.r0 + 1 })}>
          Delete rows
        </button>
        <button disabled={!sel} onClick={() => sel && book.apply({ type: 'insert_cols', table: meta.id, at: sel.c0, count: sel.c1 - sel.c0 + 1 })}>
          Insert columns left
        </button>
        <button disabled={!sel} onClick={() => sel && book.apply({ type: 'insert_cols', table: meta.id, at: sel.c1 + 1, count: sel.c1 - sel.c0 + 1 })}>
          Insert columns right
        </button>
        <button disabled={!sel} onClick={() => sel && book.apply({ type: 'delete_cols', table: meta.id, at: sel.c0, count: sel.c1 - sel.c0 + 1 })}>
          Delete columns
        </button>
      </div>
      <div className="panel-subtitle">Position</div>
      <div className="muted small">
        x {Math.round(meta.x)} · y {Math.round(meta.y)} · drag the title bar to move; drag the handles at the right, bottom and corner to add or remove columns and rows; drag column and row edges to resize them.
      </div>
      <div className="panel-subtitle">Export</div>
      <button onClick={() => exportTableCsv(meta.id)}>Download table as CSV</button>
      <div className="panel-subtitle">Danger zone</div>
      <button className="danger" onClick={() => deleteSelectedTable()}>
        Delete table
      </button>
    </div>
  );
}
