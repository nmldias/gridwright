import { useEffect, useMemo, useState } from 'react';
import * as book from '../engine/book';
import { colToLetters, type ColumnFilter } from '../engine/types';
import { displayValue } from './format';
import { sortTableByColumn } from './actions';
import { cellKey } from '../engine/types';
import { useStore } from '../state/store';

const OPS: [NonNullable<ColumnFilter['op']>, string][] = [
  ['contains', 'contains'],
  ['not_contains', 'does not contain'],
  ['starts', 'starts with'],
  ['ends', 'ends with'],
  ['eq', '='],
  ['ne', '≠'],
  ['gt', '>'],
  ['ge', '≥'],
  ['lt', '<'],
  ['le', '≤'],
  ['blank', 'is blank'],
  ['not_blank', 'is not blank'],
];

export function FilterPopover() {
  const pop = useStore((s) => s.filterPopover);
  const tables = useStore((s) => s.tables);
  const cells = useStore((s) => s.cells);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const meta = pop ? tables.get(pop.table) : undefined;
  const existing = meta && pop ? meta.filters.find((f) => f.col === pop.col) : undefined;
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const [mode, setMode] = useState<'values' | 'condition'>('values');
  const [op, setOp] = useState<NonNullable<ColumnFilter['op']>>('contains');
  const [val, setVal] = useState('');

  // distinct values of the column (data rows only)
  const distinct = useMemo(() => {
    if (!meta || !pop) return [] as { text: string; count: number }[];
    const map = cells.get(meta.id);
    const counts = new Map<string, number>();
    for (let r = meta.header_rows; r < meta.rows; r++) {
      const c = map?.get(cellKey(r, pop.col));
      const text = c ? displayValue(c.v, c.f) : '';
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([text, count]) => ({ text, count }))
      .sort((a, b) => a.text.localeCompare(b.text, undefined, { numeric: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, pop, cellsVersion]);

  useEffect(() => {
    if (!pop) return;
    setSearch('');
    if (existing?.values) {
      setMode('values');
      setChecked(new Set(existing.values));
    } else if (existing?.op) {
      setMode('condition');
      setOp(existing.op);
      setVal(existing.value ?? '');
      setChecked(null);
    } else {
      setMode('values');
      setChecked(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pop?.table, pop?.col]);

  if (!pop || !meta) return null;
  const header = (() => {
    const c = cells.get(meta.id)?.get(cellKey(0, pop.col));
    return c ? displayValue(c.v, c.f) : colToLetters(pop.col);
  })();
  const close = () => useStore.setState({ filterPopover: null });
  const apply = (filters: ColumnFilter[]) => {
    book.apply({ type: 'set_filters', table: meta.id, filters });
    close();
  };
  const others = meta.filters.filter((f) => f.col !== pop.col);
  const shown = distinct.filter((d) => !search || d.text.toLowerCase().includes(search.toLowerCase()));
  const sel = checked ?? new Set(distinct.map((d) => d.text));
  const left = Math.min(pop.x, window.innerWidth - 290);
  const top = Math.min(pop.y, window.innerHeight - 420);
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();

  return (
    <div className="filter-popover" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="filter-head">
        <b>{header}</b>
        <span className="grow" />
        <button className="icon" onClick={close}>
          ×
        </button>
      </div>
      <div className="row">
        <button className="small" onClick={() => (sortTableByColumn(meta.id, pop.col, true), close())}>
          Sort A→Z
        </button>
        <button className="small" onClick={() => (sortTableByColumn(meta.id, pop.col, false), close())}>
          Sort Z→A
        </button>
      </div>
      <div className="row tabs">
        <button className={mode === 'values' ? 'active' : ''} onClick={() => setMode('values')}>
          Values
        </button>
        <button className={mode === 'condition' ? 'active' : ''} onClick={() => setMode('condition')}>
          Condition
        </button>
      </div>
      {mode === 'values' ? (
        <>
          <input value={search} onKeyDown={stop} placeholder="Search values…" onChange={(e) => setSearch(e.target.value)} />
          <div className="row small-row">
            <button className="link small" onClick={() => setChecked(new Set(distinct.map((d) => d.text)))}>
              all
            </button>
            <button className="link small" onClick={() => setChecked(new Set())}>
              none
            </button>
            <span className="muted small">{distinct.length} values</span>
          </div>
          <div className="filter-values">
            {shown.map((d) => (
              <label key={d.text} className="field check">
                <input
                  type="checkbox"
                  checked={sel.has(d.text)}
                  onChange={(e) => {
                    const next = new Set(sel);
                    if (e.target.checked) next.add(d.text);
                    else next.delete(d.text);
                    setChecked(next);
                  }}
                />
                <span>{d.text === '' ? <i>(blank)</i> : d.text}</span>
                <span className="muted small">{d.count}</span>
              </label>
            ))}
          </div>
          <div className="row">
            <button className="primary" onClick={() => apply(sel.size === distinct.length ? others : [...others, { col: pop.col, values: Array.from(sel) }])}>
              Apply
            </button>
            <button onClick={() => apply(others)}>Clear</button>
          </div>
        </>
      ) : (
        <>
          <select value={op} onChange={(e) => setOp(e.target.value as NonNullable<ColumnFilter['op']>)}>
            {OPS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {op !== 'blank' && op !== 'not_blank' && <input value={val} onKeyDown={stop} placeholder="value" onChange={(e) => setVal(e.target.value)} />}
          <div className="row">
            <button className="primary" onClick={() => apply([...others, { col: pop.col, op, value: val }])}>
              Apply
            </button>
            <button onClick={() => apply(others)}>Clear</button>
          </div>
        </>
      )}
      {meta.hidden_rows.length > 0 && <div className="muted small">{meta.hidden_rows.length} rows hidden by filters</div>}
    </div>
  );
}
