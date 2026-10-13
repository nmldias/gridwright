// Drill-through (roadmap 7.3): the records behind an analytical chart's selected bars, or behind the
// whole chart, queried with the same selections the chart's numbers came from, so they add up to
// what it shows; and the records the chart leaves out (the excluded population). Rows open in the
// table. Drill-down controls for charts with a dimension hierarchy. Nothing here edits the workbook.
import { useMemo, useState } from 'react';
import { PanelHeader } from './PanelHeader';
import * as book from '../engine/book';
import { valueToString, type Chart, type KeyValue, type MeasureValue } from '../engine/types';
import { analyticData, fmtNum } from '../grid/charts';
import { currentField, drillDown, drillLevel, drillUp, incoming, ownSelection, pathLabels, pathSelections, recordSelections } from '../grid/crossfilter';
import { selectCell } from '../grid/actions';
import { useStore } from '../state/store';
import { tableHeaders } from './review';

const PAGE = 200;

/** Two measure results agree when both are numbers equal at 15 significant digits. */
function agree(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return a === b || Number(a.toPrecision(15)) === Number(b.toPrecision(15));
}

function show(v: KeyValue): string {
  return v === null ? '' : valueToString(v);
}

function measureText(m: MeasureValue): string {
  if (m.status === 'mixed_currency') return (m.by_currency ?? []).map((c) => `${c.currency || '(none)'} ${fmtNum(c.value)}`).join(' · ');
  if (m.value === null) return m.status === 'div0' ? 'denominator is 0' : 'no values';
  const left = m.missing + m.invalid;
  return `${fmtNum(m.value, false)}${m.currency ? ` ${m.currency}` : ''}${left ? ` (${left} blank or not a number, left out)` : ''}`;
}

export function RecordsPanel() {
  const chartId = useStore((s) => s.recordsChart ?? s.selectedChart);
  const charts = useStore((s) => s.charts);
  const tables = useStore((s) => s.tables);
  const sels = useStore((s) => s.markSelections);
  const paths = useStore((s) => s.drillPaths);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const [mode, setMode] = useState<'behind' | 'excluded'>('behind');
  const [limit, setLimit] = useState(PAGE);
  const chart = charts.find((c) => c.id === chartId) ?? null;

  const view = useMemo(() => (chart?.analytic ? compute(chart, mode, limit) : null), [chart, mode, limit, sels, paths, cellsVersion, charts]);

  if (!chart?.analytic || !view) {
    return (
      <div className="panel">
        <PanelHeader title="Records" />
        <p className="muted small">Double-click a bar of an analytical chart to see the records behind it. Range charts are exhibits: they do not know which records their numbers came from.</p>
      </div>
    );
  }
  const an = chart.analytic;
  const tableId = [...tables.values()].find((t) => t.name.toLowerCase() === an.table.toLowerCase())?.id ?? null;
  const lvl = drillLevel(chart);
  const own = ownSelection(chart);
  const next = an.dims[lvl + 1];
  const r = view.records;

  return (
    <div className="panel records-panel">
      <PanelHeader title="Records" />
      <div className="muted small">{chart.title || `Chart ${chart.id}`}</div>
      {(lvl > 0 || an.dims.length > 1) && (
        <div className="row wrap drill">
          <span className="small">
            {[...pathLabels(chart).map((l, i) => `${an.dims[i]}: ${l || '(blank)'}`), `by ${currentField(chart)}`].join(' › ')}
          </span>
          {lvl > 0 && <button onClick={() => drillUp(chart)}>↑ Up</button>}
          {next && own && own.keys.length === 1 && (
            <button onClick={() => drillDown(chart, own.keys[0], own.labels[0])}>
              Drill into {own.labels[0] || '(blank)'} by {next}
            </button>
          )}
        </div>
      )}
      <div className="row wrap">
        <button className={mode === 'behind' ? 'active' : ''} onClick={() => { setMode('behind'); setLimit(PAGE); }}>
          Behind {own && own.keys.length ? 'the selection' : 'the chart'}
        </button>
        <button className={mode === 'excluded' ? 'active' : ''} onClick={() => { setMode('excluded'); setLimit(PAGE); }}>
          Left out of the chart
        </button>
      </div>
      <p className="small">{view.scope}</p>
      {r.error ? (
        <p className="error small">{r.error}</p>
      ) : (
        <>
          <p className="small records-summary">
            <b>{r.count.toLocaleString('en-US')}</b> record{r.count === 1 ? '' : 's'}
            {r.measures.map((m, i) => (
              <span key={i}>
                {' · '}
                {m.name}: {measureText(r.total[i])}
              </span>
            ))}
          </p>
          {view.check && (
            <p className={`small ${view.check.ok ? 'ok' : 'error'}`} data-check={view.check.ok ? 'ok' : 'differs'}>
              {view.check.text}
            </p>
          )}
          <div className="records-table">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  {r.fields.map((f) => (
                    <th key={f}>{f}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.records.map((rec) => (
                  <tr key={rec.row} title="Show this row in the table" onClick={() => tableId !== null && selectCell(tableId, rec.row, 0)}>
                    <td className="muted">{rec.row + 1}</td>
                    {rec.values.map((v, j) => (
                      <td key={j} className={v !== null && typeof v === 'object' && 'n' in v ? 'num' : ''}>
                        {show(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.truncated && (
            <div className="row">
              <span className="muted small">
                Showing {r.records.length.toLocaleString('en-US')} of {r.count.toLocaleString('en-US')} — the totals above cover all of them
              </span>
              <button onClick={() => setLimit(limit + PAGE * 5)}>Show more</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function compute(chart: Chart, mode: 'behind' | 'excluded', limit: number) {
  const an = chart.analytic!;
  const tableId = book.tableIdByName(an.table);
  const heads = tableId ? tableHeaders(tableId).filter(Boolean) : [];
  // the record's identity first (the table's first column), then what the chart reads
  const want = [heads[0], ...an.dims, ...an.measures.flatMap((m) => [m.field, m.numerator, m.denominator, m.currency])];
  const fields = [...new Set(want.filter((f): f is string => !!f && heads.some((h) => h.toLowerCase() === f.toLowerCase())))];
  const inc = incoming(chart);
  const own = ownSelection(chart);
  const describe = (sel: { field: string; labels: string[] }[]) => sel.map((s) => `${s.field} = ${s.labels.map((l) => l || '(blank)').join(' or ')}`).join(' and ');
  const parts: { field: string; labels: string[] }[] = [
    ...pathLabels(chart).map((l, i) => ({ field: an.dims[i], labels: [l] })),
    ...inc.from.map((f) => ({ field: f.field, labels: f.labels })),
  ];
  if (mode === 'excluded') {
    const selections = [...inc.selections, ...pathSelections(chart)];
    const records = book.analyzeRecords({ table: an.table, measures: an.measures, selections, fields, limit, complement: true });
    const scope = selections.length ? `Records the chart does not count: not (${describe(parts)}). Rows hidden by the table's filters are not listed.` : 'Nothing is left out of this chart by a selection.';
    return { records, scope, check: null };
  }
  const selections = recordSelections(chart);
  const records = book.analyzeRecords({ table: an.table, measures: an.measures, selections, fields, limit });
  if (own && own.keys.length) parts.push({ field: own.field, labels: own.labels });
  const scope = parts.length ? `Records where ${describe(parts)}.` : 'Every record the chart counts.';
  // do the records add up to what the chart shows?
  const data = analyticData(chart);
  let check: { ok: boolean; text: string } | null = null;
  if (!records.error && data.keys) {
    const idx = data.selected ? data.selected.flatMap((s, i) => (s ? [i] : [])) : data.categories.map((_, i) => i);
    const results = records.measures.map((m, mi) => {
      const shown = idx.map((i) => data.series[mi]?.values[i] ?? null);
      if (idx.length === 1) return { m, expect: shown[0], got: records.total[mi].value };
      if (!m.additive) return null; // a ratio over several bars is not the sum of the bars
      const sum = shown.every((v) => v !== null) ? shown.reduce((a: number, b) => a + (b as number), 0) : null;
      return { m, expect: sum, got: records.total[mi].value };
    });
    const judged = results.filter((x): x is NonNullable<typeof x> => x !== null && x.expect !== null);
    if (judged.length) {
      const ok = judged.every((x) => agree(x.expect, x.got));
      check = {
        ok,
        text: ok
          ? `✓ These records add up to the chart (${judged.map((x) => `${x.m.name} ${fmtNum(x.got as number, false)}`).join(', ')})`
          : `✗ These records do not add up to the chart: ${judged.filter((x) => !agree(x.expect, x.got)).map((x) => `${x.m.name} ${x.got} ≠ ${x.expect}`).join(', ')}`,
      };
    }
  }
  return { records, scope, check };
}
