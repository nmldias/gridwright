import { useEffect, useMemo, useState } from 'react';
import { PanelHeader } from './PanelHeader';
import * as book from '../engine/book';
import { deleteSelectedTable } from '../grid/actions';
import { exportTableCsv } from '../grid/ContextMenu';
import { displayValue } from '../grid/format';
import { cellKey, type PivotSpec, type PivotValue, type TableId } from '../engine/types';
import { setStatus, useStore } from '../state/store';

const AGGS: PivotValue['agg'][] = ['sum', 'count', 'average', 'min', 'max', 'countdistinct'];

export function TablePanel() {
  const selection = useStore((s) => s.selection);
  const selectedTable = useStore((s) => s.selectedTable);
  const tables = useStore((s) => s.tables);
  const cells = useStore((s) => s.cells);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const id = selectedTable ?? selection?.table ?? null;
  const meta = id !== null ? tables.get(id) : undefined;
  const [name, setName] = useState(meta?.name ?? '');
  const [rows, setRows] = useState(meta?.rows ?? 0);
  const [cols, setCols] = useState(meta?.cols ?? 0);
  const [pivotDraft, setPivotDraft] = useState<PivotSpec | null>(null);
  void cellsVersion;

  useEffect(() => {
    setName(meta?.name ?? '');
    setRows(meta?.rows ?? 0);
    setCols(meta?.cols ?? 0);
    setPivotDraft(meta?.pivot ?? null);
  }, [meta?.name, meta?.rows, meta?.cols, meta?.id, meta?.pivot]);

  // header names of a table (for pivot field pickers)
  const headersOf = (tid: TableId): string[] => {
    const t = tables.get(tid);
    if (!t || t.header_rows === 0) return [];
    const map = cells.get(tid);
    const out: string[] = [];
    for (let c = 0; c < t.cols; c++) {
      const cell = map?.get(cellKey(0, c));
      const h = cell ? displayValue(cell.v, cell.f) : '';
      if (h) out.push(h);
    }
    return out;
  };
  const sourceOptions = useMemo(() => Array.from(tables.values()).filter((t) => t.id !== meta?.id && !t.pivot), [tables, meta?.id]);

  if (!meta) {
    return (
      <div className="panel">
        <PanelHeader title="Table" />
        <p className="muted">Select a table.</p>
      </div>
    );
  }
  const sel = selection && selection.table === meta.id ? selection : null;
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  const draft: PivotSpec = pivotDraft ?? { source: sourceOptions[0]?.id ?? 0, rows: [], cols: [], values: [], filters: [], totals: true };
  const srcHeaders = headersOf(draft.source);
  const setDraft = (patch: Partial<PivotSpec>) => setPivotDraft({ ...draft, ...patch });
  const applyPivot = () => {
    if (!draft.source) {
      setStatus('Choose a source table for the pivot.');
      return;
    }
    if (!draft.rows.length && !draft.cols.length) {
      setStatus('Choose at least one row or column field.');
      return;
    }
    const ch = book.apply({ type: 'set_pivot', table: meta.id, spec: draft });
    if (ch.error) setStatus(ch.error, 6000);
  };

  return (
    <div className="panel">
      <PanelHeader title="Table" />
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={stop}
          onBlur={() => name.trim() && name !== meta.name && book.apply({ type: 'rename_table', table: meta.id, name: name.trim() })}
        />
      </label>
      {!meta.pivot && (
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
      )}
      <label className="field check">
        <input type="checkbox" checked={meta.header_rows > 0} disabled={!!meta.pivot} onChange={(e) => book.apply({ type: 'set_header_rows', table: meta.id, header_rows: e.target.checked ? 1 : 0 })} />
        <span>Header row (enables Table[Column] references, filters and pivots)</span>
      </label>
      {meta.filters.length > 0 && (
        <div className="row">
          <span className="muted small">
            {meta.filters.length} filter{meta.filters.length > 1 ? 's' : ''} · {meta.hidden_rows.length} rows hidden
          </span>
          <button className="small" onClick={() => book.apply({ type: 'set_filters', table: meta.id, filters: [] })}>
            Clear filters
          </button>
        </div>
      )}

      {!meta.pivot && (
        <>
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
        </>
      )}

      <div className="panel-subtitle">Pivot</div>
      {meta.pivot && <div className="muted small">This table is computed from “{tables.get(meta.pivot.source)?.name ?? 'a deleted table'}” and updates automatically. Its cells are read-only.</div>}
      {sourceOptions.length === 0 && !meta.pivot ? (
        <div className="muted small">Add another table with a header row to pivot it here.</div>
      ) : (
        <div className="rule-form">
          <label className="field">
            <span>Source table</span>
            <select value={draft.source} onChange={(e) => setDraft({ source: Number(e.target.value), rows: [], cols: [], values: [] })}>
              {sourceOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              {meta.pivot && !sourceOptions.some((t) => t.id === meta.pivot!.source) && <option value={meta.pivot.source}>(deleted table)</option>}
            </select>
          </label>
          <label className="field">
            <span>Rows (group by)</span>
            <div className="chip-row">
              {srcHeaders.map((h) => (
                <button key={h} className={`chip ${draft.rows.includes(h) ? 'on' : ''}`} onClick={() => setDraft({ rows: draft.rows.includes(h) ? draft.rows.filter((x) => x !== h) : [...draft.rows, h] })}>
                  {h}
                </button>
              ))}
              {!srcHeaders.length && <span className="muted small">source table has no header row</span>}
            </div>
          </label>
          <label className="field">
            <span>Columns (optional)</span>
            <select value={draft.cols[0] ?? ''} onChange={(e) => setDraft({ cols: e.target.value ? [e.target.value] : [] })}>
              <option value="">— none —</option>
              {srcHeaders.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Values</span>
            <ul className="rule-list">
              {draft.values.map((v, i) => (
                <li key={i}>
                  <select value={v.agg} onChange={(e) => setDraft({ values: draft.values.map((x, j) => (j === i ? { ...x, agg: e.target.value as PivotValue['agg'] } : x)) })}>
                    {AGGS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                  <span className="small">of {v.field}</span>
                  <span className="grow" />
                  <button className="icon" onClick={() => setDraft({ values: draft.values.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <select value="" onChange={(e) => e.target.value && setDraft({ values: [...draft.values, { field: e.target.value, agg: 'sum' }] })}>
              <option value="">+ add a value field…</option>
              {srcHeaders.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
          <label className="field check">
            <input type="checkbox" checked={draft.totals} onChange={(e) => setDraft({ totals: e.target.checked })} />
            <span>Totals row / column</span>
          </label>
          <div className="row">
            <button className="primary" onClick={applyPivot}>
              {meta.pivot ? 'Update pivot' : 'Turn this table into a pivot'}
            </button>
            {meta.pivot && <button onClick={() => book.apply({ type: 'set_pivot', table: meta.id, spec: null })}>Convert to values</button>}
          </div>
          {!meta.pivot && <div className="muted small">The current contents of this table are replaced by the pivot output.</div>}
        </div>
      )}

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
