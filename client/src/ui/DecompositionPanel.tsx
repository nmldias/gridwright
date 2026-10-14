// Decomposition tree (roadmap 7.4, assessment 13 Oct 2026): one measure broken down level by level,
// a field chosen per node. One read-only engine call (Book.decompose) returns the whole tree.
// Policy, stated rather than assumed (docs/analytical-model.md, "Decomposition tree (7.4)"):
// * read-only and per viewer: the tree lives in store.decomp, never in the workbook or its log;
// * siblings by value, the top N named, the rest folded into "Other (k)" whose value is recomputed
//   from its own rows; "(blank)" is its own node, always last, and neither is ever dropped;
// * every split says whether its children add up to the parent (or, for ratios and averages, that
//   they do not sum and their parts do); a level whose node left the tree is kept and said so;
// * a suggested split is a stated, deterministic rule, shown with its runner-up: a heuristic, not a cause.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { PanelHeader } from './PanelHeader';
import * as book from '../engine/book';
import { valueToString, type DecompNode, type DecompSplit, type DecompSuggestion, type DecompTree, type KeyValue, type MeasureSpec, type MeasureValue } from '../engine/types';
import { formatNumber } from '../grid/format';
import { selectCell } from '../grid/actions';
import { acceptSuggestion, addSplit, chartOf, fieldsOf, findNode, flatten, keyText, query, rememberTree, removeSplit, staleSplits } from '../grid/decomp';
import { cellAt, getState, saveDecompPrefs, useStore, type Decomp } from '../state/store';
import { tableHeaders } from './review';

const PAGE = 50;
const lower = (s: string) => s.trim().toLowerCase();

function update(fn: (d: Decomp) => Decomp) {
  const d = getState().decomp;
  if (d) useStore.setState({ decomp: fn(d) });
}

/** Two results agree when equal at 15 significant digits (the 7.1 standard). */
function agree(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return a === b || Number(a.toPrecision(15)) === Number(b.toPrecision(15));
}

function measureLabel(m: MeasureSpec): string {
  if (m.name) return m.name;
  if (m.agg === 'ratio') return `${m.numerator ?? '?'} ÷ ${m.denominator ?? '?'}`;
  if (m.agg === 'count') return m.field ? `Count of ${m.field}` : 'Count of rows';
  const agg: Record<string, string> = { sum: 'Sum', average: 'Average', min: 'Min', max: 'Max', count_distinct: 'Distinct' };
  return `${agg[m.agg] ?? 'Sum'} of ${m.field ?? '?'}`;
}

/** The number format the measure's column is shown with (for sums, averages, min and max). Not
 * when the measure has a currency column: the column's format (its first row's) may carry one
 * currency's symbol ("currency:AOA", `#,##0.00 "Kz"`), and the nodes' amounts are in their own
 * currencies, each shown with its code. */
function patternOf(table: string, m: MeasureSpec): string | undefined {
  if (!m.field || m.currency || !['sum', 'average', 'min', 'max', ''].includes(m.agg ?? '')) return undefined;
  const id = book.tableIdByName(table);
  const meta = id ? getState().tables.get(id) : undefined;
  if (!id || !meta) return undefined;
  const c = tableHeaders(id).findIndex((h) => lower(h) === lower(m.field!));
  return c < 0 ? undefined : cellAt(id, meta.header_rows, c)?.f?.number_format || undefined;
}

/** A plain number with grouping and at most `digits` decimals, in the workbook's convention (a
 * decimal comma workbook shows 1.234,5 whatever the browser's locale), as the grid and charts do. */
function plain(v: number, digits: number): string {
  const s = v.toLocaleString('en-US', { maximumFractionDigits: digits });
  return getState().decimalComma ? s.replace(/[,.]/g, (c) => (c === ',' ? '.' : ',')) : s;
}

function makeFmt(pattern: string | undefined) {
  return (v: number): string => {
    if (pattern) return formatNumber(v, pattern);
    return plain(v, Math.abs(v) < 10 ? 4 : 2);
  };
}
type Fmt = ReturnType<typeof makeFmt>;
const count = (n: number) => plain(n, 0);
const times = (x: number | null) => (x === null ? '—' : `${plain(x, 2)}×`);

function valueText(m: MeasureValue, fmt: Fmt): string {
  if (m.status === 'mixed_currency') return (m.by_currency ?? []).map((c) => `${c.currency || '(none)'} ${fmt(c.value)}`).join(' · ');
  if (m.value === null) return m.status === 'div0' ? '÷0' : 'no values';
  return `${fmt(m.value)}${m.currency ? ` ${m.currency}` : ''}`;
}

/** `counted`: a count or distinct count, whose blanks are not counted by definition (the engine
 * does not call it incomplete either). */
function badges(m: MeasureValue, fmt: Fmt, counted: boolean): string[] {
  const out: string[] = [];
  if (!counted && (m.status === 'incomplete' || m.missing + m.invalid > 0)) {
    const parts = [m.missing ? `${count(m.missing)} blank` : '', m.invalid ? `${count(m.invalid)} text` : ''].filter(Boolean);
    if (parts.length) out.push(`incomplete: ${parts.join(', ')} left out`);
  }
  if (m.status === 'mixed_currency') out.push(`mixed currencies: ${(m.by_currency ?? []).map((c) => `${c.currency || '(none)'} ${fmt(c.value)}`).join(' · ')}`);
  if (m.status === 'div0') out.push('÷0');
  return out;
}

function nodeLabel(n: DecompNode): string {
  if (n.kind === 'root') return 'Total';
  if (n.kind === 'blank') return '(blank)';
  return n.label;
}

function otherTitle(table: string, n: DecompNode): string | undefined {
  if (n.kind !== 'other' || !n.folded) return undefined;
  const field = n.path[n.path.length - 1]?.field ?? '';
  const ls = n.folded.map((v) => keyText(table, field, v));
  return ls.length > 20 ? `${ls.slice(0, 20).join(', ')} +${ls.length - 20} more` : ls.join(', ');
}

function levelText(s: DecompSplit, topN: number, parentRows: number, fmt: Fmt): { mark: string; text: string } {
  const c = s.check;
  const shown = s.children.some((x) => x.kind === 'other') ? `, top ${topN} shown` : '';
  const head = `by ${s.field} · ${count(s.items)} value${s.items === 1 ? '' : 's'}${shown}`;
  const rows = c.rows_ok ? `rows ${count(parentRows)} ✓` : `rows ✗ (${count(s.children.reduce((a, x) => a + x.rows, 0))} of ${count(parentRows)})`;
  let body: string;
  if (c.kind === 'children_do_not_sum') {
    body = c.text + (c.parts_ok === undefined ? '' : c.parts_ok ? ' · numerators and denominators add up ✓' : ' · numerators and denominators do not add up ✗');
    if (!c.rows_ok) body += ` · ${rows}`;
  } else if (c.status === 'ok' && c.by_currency?.length) {
    body = `✓ ${c.text} (${c.by_currency.map((x) => `${x.currency || '(none)'} ${fmt(x.parent)}`).join('; ')}; ${rows})`;
  } else if (c.status === 'ok') {
    body = `✓ ${c.text} (${c.parent === null ? 'no values' : fmt(c.parent)}; ${rows})`;
  } else if (c.status === 'differs') {
    body = `✗ ${c.text} (parent ${c.parent === null ? '—' : fmt(c.parent)}, children ${c.sum_of_children === null ? '—' : fmt(c.sum_of_children)}; ${rows})`;
  } else {
    body = `– ${c.text} (${rows})`;
  }
  const notes = [s.sort === 'key' ? 'Sorted by name: these amounts are in different currencies' : '', s.mixed_signs ? 'Some items are negative; no shares' : ''].filter(Boolean);
  return { mark: c.status, text: [head, body, ...notes].join(' · ') };
}

/** `cur`: the node's currency (amounts under a single-currency node), shown with each amount. */
function suggestionText(s: DecompSuggestion, fmtBase: Fmt, cur: string | undefined): string {
  const b = s.best;
  if (!s.field || !b) return s.text;
  const r = s.runner_up;
  const ranked = s.candidates.filter((c) => !c.skipped).length;
  const fmt = (x: number) => `${fmtBase(x)}${cur ? ` ${cur}` : ''}`;
  let main: string;
  let ru = '';
  if (s.rule === 'relative') {
    main = `${b.node || '(blank)'} is ${times(b.score)} the mean of the ${b.items} ${b.field} values (${b.value === null ? '—' : fmt(b.value)} against ${b.mean === null ? '—' : fmt(b.mean)})`;
    if (r) ru = `; runner-up ${r.field}: ${r.node || '(blank)'} ${times(r.score)}`;
  } else {
    main = `Its largest item, ${b.node || '(blank)'}, has ${b.value === null ? '—' : fmt(b.value)}`;
    if (r) ru = `; runner-up ${r.field}: ${r.node || '(blank)'}, ${r.value === null ? '—' : fmt(r.value)}`;
  }
  return `Rule: ${s.rule_text}. ${main}${ru}. ${ranked} field${ranked === 1 ? '' : 's'} compared; ties go to the field with fewer values. A heuristic, not a cause.`;
}

export function DecompositionPanel() {
  const d = useStore((s) => s.decomp);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const sels = useStore((s) => s.markSelections);
  const decimalComma = useStore((s) => s.decimalComma);
  const paths = useStore((s) => s.drillPaths);
  const charts = useStore((s) => s.charts);
  const tables = useStore((s) => s.tables);
  const [limit, setLimit] = useState(PAGE);
  const treeRef = useRef<HTMLUListElement>(null);

  // The engine runs only when its query changes (or the workbook does): collapsing a level,
  // opening records or, with suggestions off, moving the selection only changes the view.
  const q = useMemo(
    () => (d ? query(d) : null),
    [d?.table, d?.measure, d?.topN, d?.splits, d?.suggest, d?.rule, d?.selected, d?.selectedPath, d?.base, d?.fromChart, cellsVersion, sels, paths, charts, tables],
  );
  const qKey = q ? JSON.stringify(q) : '';
  const result = useMemo((): { tree: DecompTree | null; error: string | null } => {
    if (!q) return { tree: null, error: null };
    try {
      return { tree: book.decompose(q), error: null };
    } catch (e) {
      return { tree: null, error: (e as Error).message };
    }
  }, [qKey, cellsVersion, tables]);
  const tree = result.tree;
  useEffect(() => rememberTree(tree), [tree]);
  useEffect(() => setLimit(PAGE), [d?.records]);

  const fmt = useMemo(() => makeFmt(d ? patternOf(d.table, d.measure) : undefined), [d?.table, d?.measure, cellsVersion, decimalComma]);
  const fields = useMemo(() => (d ? fieldsOf(d) : []), [d?.table, d?.fromChart, charts, tables, cellsVersion]);
  const flat = useMemo(() => (tree && d ? flatten(tree, d.collapsed) : []), [tree, d?.collapsed]);
  // DOM ids of the shown tree items, for aria-activedescendant
  const domIds = useMemo(() => new Map(flat.map((f, i) => [f.node.id, `decomp-item-${i}`])), [flat]);
  // keep the selected row in view while arrowing through a long outline
  useEffect(() => {
    if (!d?.selected) return;
    const li = [...(treeRef.current?.querySelectorAll('li.decomp-node') ?? [])].find((x) => (x as HTMLElement).dataset.id === d.selected);
    (li?.querySelector(':scope > .decomp-row') as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [d?.selected, flat]);

  const recordsNode = tree && d ? findNode(tree, d.records) : null;
  const records = useMemo(() => {
    if (!d || !recordsNode) return null;
    const id = book.tableIdByName(d.table);
    const heads = id ? tableHeaders(id).filter(Boolean) : [];
    const want = [heads[0], ...recordsNode.path.map((s) => s.field), d.measure.field, d.measure.numerator, d.measure.denominator, d.measure.currency];
    const fs = [...new Set(want.filter((f): f is string => !!f && heads.some((h) => lower(h) === lower(f))))];
    return book.analyzeRecords({ table: d.table, measures: [d.measure], selections: recordsNode.selections, fields: fs, limit });
  }, [d, recordsNode, limit]);

  if (!d) {
    return (
      <div className="panel decomp-panel">
        <PanelHeader title="Break down" />
        <p className="muted small">Open this from an analytical chart (Break down) or right-click a table and choose Break down a measure…</p>
      </div>
    );
  }

  const chart = chartOf(d);
  const counted = d.measure.agg === 'count' || d.measure.agg === 'count_distinct';
  const stale = result.error ? staleSplits(d) : [];
  const tableId = [...tables.values()].find((t) => lower(t.name) === lower(d.table))?.id ?? null;
  const setPrefs = (patch: Partial<Pick<Decomp, 'topN' | 'suggest' | 'rule'>>) => {
    update((x) => ({ ...x, ...patch }));
    const n = getState().decomp!;
    saveDecompPrefs({ topN: n.topN, suggest: n.suggest, rule: n.rule });
  };
  const measures = d.measures.some((m) => m.agg === 'count' && !m.field) ? d.measures : [...d.measures, { agg: 'count' }];
  const mIndex = measures.findIndex((m) => JSON.stringify(m) === JSON.stringify(d.measure));
  const select = (n: DecompNode) => update((x) => ({ ...x, selected: n.id, selectedPath: n.path }));
  const toggle = (n: DecompNode, open?: boolean) =>
    update((x) => {
      const shut = x.collapsed.includes(n.id);
      const want = open === undefined ? shut : open;
      return { ...x, collapsed: want ? x.collapsed.filter((c) => c !== n.id) : shut ? x.collapsed : [...x.collapsed, n.id] };
    });
  const openRecords = (n: DecompNode) => update((x) => ({ ...x, selected: n.id, selectedPath: n.path, records: n.id }));

  const base = tree ? tree.root.selections : [];
  const scope = [
    d.table,
    tree ? `${count(tree.root.rows)} rows` : '',
    base.length ? `filtered by ${base.map((s) => `${s.field} = ${s.values.map((v) => keyText(d.table, s.field, v)).join(' or ')}`).join(' and ')}` : '',
    tree && tree.excluded.by_table_filter ? `${count(tree.excluded.by_table_filter)} rows hidden by table filters left out` : '',
  ].filter(Boolean).join(' · ');

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if ((e.target as HTMLElement).closest('select, input, button, summary')) return;
    if (!tree || !flat.length) return;
    const i = Math.max(0, flat.findIndex((f) => f.node.id === d.selected));
    const cur = flat[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      select(next.node);
    } else if (e.key === 'ArrowRight') {
      // expand, then go to the first child (the ARIA tree pattern). Focus never moves into the
      // node's "Split by" list: on Windows and Linux an arrow key on a closed select changes its
      // value at once, which would replace the split and drop the levels below it.
      if (cur.node.split && d.collapsed.includes(cur.node.id)) toggle(cur.node, true);
      else if (cur.node.split?.children.length) select(cur.node.split.children[0]);
    } else if (e.key === 'ArrowLeft') {
      if (cur.node.split && !d.collapsed.includes(cur.node.id)) toggle(cur.node, false);
      else if (cur.parent) {
        const p = flat.find((f) => f.node.id === cur.parent);
        if (p) select(p.node);
      }
    } else if (e.key === 'Enter') openRecords(cur.node);
    else return;
    e.preventDefault();
  };

  const renderNode = (n: DecompNode, depth: number, siblingsMax: number) => {
    const sel = n.id === d.selected;
    const shut = d.collapsed.includes(n.id);
    const onPath = new Set(n.path.map((s) => lower(s.field)));
    const options = fields.filter((f) => !onPath.has(lower(f)));
    const own = n.kind === 'root' ? [] : n.path;
    const s = n.split;
    const v = n.value.value;
    const width = v !== null && siblingsMax > 0 ? Math.max(1, Math.round((Math.abs(v) / siblingsMax) * 100)) : 0;
    const sug = tree?.suggestion && sel && !s && tree.suggestion.node_id === n.id ? tree.suggestion : null;
    const childMax = s ? Math.max(0, ...s.children.map((c) => Math.abs(c.value.value ?? 0))) : 0;
    const lvl = s ? levelText(s, d.topN, n.rows, fmt) : null;
    return (
      <li key={n.id} id={domIds.get(n.id)} className="decomp-node" role="treeitem" data-id={n.id} data-kind={n.kind} aria-level={depth + 1} aria-selected={sel} aria-expanded={s ? !shut : undefined}>
        <div className={`decomp-row${sel ? ' selected' : ''}`} style={{ paddingLeft: `calc(${Math.min(depth, 6)} * 14px)` }} onClick={() => select(n)} onDoubleClick={() => openRecords(n)}>
          <button className="decomp-caret icon" tabIndex={-1} aria-label={shut ? 'Expand' : 'Collapse'} disabled={!s} onClick={(e) => { e.stopPropagation(); toggle(n); }}>
            {s ? (shut ? '▸' : '▾') : '·'}
          </button>
          <span className={`decomp-label${n.kind === 'other' || n.kind === 'blank' ? ' em' : ''}`} title={otherTitle(d.table, n)}>
            {nodeLabel(n)}
          </span>
          <span className="decomp-value">{valueText(n.value, fmt)}</span>
          {n.share !== undefined && <span className="decomp-share muted">{plain(n.share * 100, 1)}%</span>}
          <span className="decomp-rows muted small">{count(n.rows)} rows</span>
          <span className="decomp-track" aria-hidden="true">
            <span className={`decomp-bar ${n.kind}`} style={{ width: `${width}%` }} />
          </span>
          {n.parts && (
            <span className="decomp-parts muted small">
              {fmt(n.parts.numerator)} ÷ {counted || d.measure.agg === 'average' ? count(n.parts.denominator) : fmt(n.parts.denominator)}
            </span>
          )}
          {badges(n.value, fmt, counted).map((b) => (
            <span key={b} className="decomp-badge small">
              {b}
            </span>
          ))}
          {n.pinned && <span className="decomp-badge pinned small">kept open (rank {n.rank})</span>}
          <span className="decomp-actions" onClick={(e) => e.stopPropagation()}>
            <select
              className="decomp-split"
              aria-label="Split by"
              value={s?.field ?? ''}
              onChange={(e) => {
                const f = e.target.value;
                const path = n.kind === 'root' ? [] : own;
                if (f === '-') update((x) => ({ ...removeSplit(x, path), collapsed: x.collapsed.filter((c) => c !== n.id) }));
                else if (f) update((x) => ({ ...addSplit(x, path, f), collapsed: x.collapsed.filter((c) => c !== n.id) }));
              }}
            >
              <option value="">Split by…</option>
              {s && <option value="-">—</option>}
              {s && !options.some((o) => lower(o) === lower(s.field)) && <option value={s.field}>{s.field}</option>}
              {options.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            {sel && (
              <button className="decomp-records-btn" onClick={() => openRecords(n)}>
                Records
              </button>
            )}
          </span>
        </div>
        {sug && (
          <div className="decomp-suggest" style={{ marginLeft: `calc(${Math.min(depth, 6)} * 14px + 20px)` }}>
            {sug.field ? (
              <>
                <div className="row wrap">
                  <b>Suggested: {sug.field}</b>
                  <span className="grow" />
                  <button onClick={() => tree && update((x) => acceptSuggestion(x, tree))}>Use this split</button>
                </div>
                <p className="small">{suggestionText(sug, fmt, n.value.currency)}</p>
              </>
            ) : (
              <p className="small">{sug.text}</p>
            )}
            <details>
              <summary className="small">Why not others</summary>
              <ul className="small decomp-why">
                {sug.candidates.map((c) => (
                  <li key={c.field}>
                    {c.field || '(no header)'}: {c.skipped ?? `${c.node || '(blank)'}, score ${sug.rule === 'relative' ? times(c.score) : c.score === null ? '—' : `${fmt(c.score)}${n.value.currency ? ` ${n.value.currency}` : ''}`} (${c.items} values)`}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        {s && !shut && lvl && (
          <>
            <div className="decomp-level small" data-check={lvl.mark} style={{ marginLeft: `calc(${Math.min(depth, 6)} * 14px + 20px)` }}>
              {lvl.text}
            </div>
            <ul role="group" className="decomp-children">
              {s.children.map((c) => renderNode(c, depth + 1, childMax))}
            </ul>
          </>
        )}
      </li>
    );
  };

  // do the records add up to the node?
  let recCheck: { ok: boolean; text: string } | null = null;
  if (records && recordsNode && !records.error) {
    const got = records.total[0];
    const want = recordsNode.value;
    const ok = records.count === recordsNode.rows && got.status === want.status && agree(got.value, want.value);
    recCheck = {
      ok,
      text: ok
        ? `these ${count(records.count)} records add up to the node ✓ (${valueText(got, fmt)})`
        : `✗ these ${count(records.count)} records do not add up to the node: ${valueText(got, fmt)} against ${valueText(want, fmt)}, ${count(records.count)} rows against ${count(recordsNode.rows)}`,
    };
  }

  return (
    <div className="panel decomp-panel">
      <PanelHeader title="Break down" subtitle={chart?.title || d.table} />
      <div className="decomp-controls">
        <label>
          Measure
          <select
            value={mIndex < 0 ? '' : String(mIndex)}
            onChange={(e) => {
              const m = measures[Number(e.target.value)];
              if (m) update((x) => ({ ...x, measure: m, records: null }));
            }}
          >
            {mIndex < 0 && <option value="">{measureLabel(d.measure)}</option>}
            {measures.map((m, i) => (
              <option key={i} value={String(i)}>
                {measureLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Top N
          <input
            type="number"
            min={1}
            max={50}
            value={d.topN}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1 && n <= 50) setPrefs({ topN: n });
            }}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={d.suggest} onChange={(e) => setPrefs({ suggest: e.target.checked })} /> Suggest splits
        </label>
        <label>
          Rule
          <select value={d.rule} disabled={!d.suggest} onChange={(e) => setPrefs({ rule: e.target.value as Decomp['rule'] })}>
            <option value="high_value">highest value</option>
            <option value="relative">relative to siblings</option>
          </select>
        </label>
      </div>
      <p className="small muted decomp-scope">{scope}</p>
      {result.error && <p className="error small">{result.error}</p>}
      {result.error && d.splits.length > 0 && (
        <p className="small decomp-recover">
          {stale.length > 0 && (
            <button onClick={() => update((x) => ({ ...x, splits: x.splits.filter((sp) => !stale.includes(sp)), records: null }))}>
              Remove {stale.length} level{stale.length === 1 ? '' : 's'} on fields that are no longer headers
            </button>
          )}{' '}
          <button onClick={() => update((x) => ({ ...x, splits: [], collapsed: [], records: null, selected: 'r', selectedPath: [] }))}>Remove all levels</button>
        </p>
      )}
      {tree?.unresolved.map((u, i) => (
        <p key={i} className="warning small decomp-unresolved">
          {u.reason}; level kept{' '}
          <button onClick={() => update((x) => removeSplit(x, u.path))}>Remove level</button>
        </p>
      ))}
      {tree && (
        <ul className="decomp-tree" role="tree" aria-label={`${tree.measure.name} broken down`} aria-activedescendant={(d.selected && domIds.get(d.selected)) || undefined} tabIndex={0} ref={treeRef} onKeyDown={onKey}>
          {renderNode(tree.root, 0, Math.abs(tree.root.value.value ?? 0))}
        </ul>
      )}
      {tree && d.records && !recordsNode && (
        <p className="warning small decomp-records-gone">
          The node whose records were listed is no longer shown (filtered out, or folded into Other).{' '}
          <button onClick={() => update((x) => ({ ...x, records: null }))}>Close records</button>
        </p>
      )}
      {records && recordsNode && (
        <div className="decomp-records records-panel">
          <div className="row wrap">
            <b className="small">
              Records of {nodeLabel(recordsNode)}
              {recordsNode.path.length > 1 ? ` (${recordsNode.path.map((p, i) => (i === recordsNode.path.length - 1 ? '' : p.other ? 'Other' : keyText(d.table, p.field, p.key ?? null))).filter(Boolean).join(' › ')})` : ''}
            </b>
            <span className="grow" />
            <button onClick={() => update((x) => ({ ...x, records: null }))}>Close records</button>
          </div>
          {records.error ? (
            <p className="error small">{records.error}</p>
          ) : (
            <>
              {recCheck && (
                <p className={`small ${recCheck.ok ? 'ok' : 'error'}`} data-check={recCheck.ok ? 'ok' : 'differs'}>
                  {recCheck.text}
                </p>
              )}
              <div className="records-table">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      {records.fields.map((f) => (
                        <th key={f}>{f}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {records.records.map((rec) => (
                      <tr key={rec.row} title="Show this row in the table" onClick={() => tableId !== null && selectCell(tableId, rec.row, 0)}>
                        <td className="muted">{rec.row + 1}</td>
                        {rec.values.map((v: KeyValue, j: number) => (
                          <td key={j} className={v !== null && typeof v === 'object' && 'n' in v ? 'num' : ''}>
                            {v === null ? '' : valueToString(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {records.truncated && (
                <div className="row wrap">
                  <span className="muted small">
                    Showing {count(records.records.length)} of {count(records.count)}; the check covers all of them
                  </span>
                  <button onClick={() => setLimit(limit + PAGE)}>Show more</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {tree && <p className="muted small">Read-only: breaking down never changes the workbook. Other and (blank) are always shown; Other is recomputed from its own rows. Double-click a node or press Enter for its records.</p>}
    </div>
  );
}

