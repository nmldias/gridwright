import { useEffect, useMemo, useState } from 'react';
import { PanelHeader } from './PanelHeader';
import * as book from '../engine/book';
import { refText, type Chart, type ChartAnalytic, type ChartKind, type MeasureSpec } from '../engine/types';
import { chartData, chartPng, chartSvg, downloadBlob } from '../grid/charts';
import { getState, useStore } from '../state/store';
import { analyticFromTable, chartFromSelection, insertAnalyticChart, insertChart, tableHeaders, updateChart } from './review';
import { forgetChart } from '../grid/crossfilter';
import { openDecomposition } from '../grid/decomp';
import { draftFromMeasure, metricByName, metricRef, metricsOn, metricText, openMetrics } from '../grid/metrics';

export const AGGS: { value: string; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'count', label: 'Count rows' },
  { value: 'count_distinct', label: 'Count distinct' },
  { value: 'average', label: 'Average (Σ ÷ n)' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'ratio', label: 'Ratio (Σ a ÷ Σ b)' },
];

/** The fields an analytical chart reads: table, dimension, measures (docs/analytical-model.md). */
function AnalyticFields({ an, chartId, commit }: { an: ChartAnalytic; chartId: number; commit: (an: ChartAnalytic, note: string) => void }) {
  const tables = useStore((s) => s.tables);
  const allMetrics = useStore((s) => s.metrics);
  const metrics = metricsOn(an.table, allMetrics);
  useStore((s) => s.cellsVersion);
  const tableId = [...tables.values()].find((t) => t.name.toLowerCase() === an.table.toLowerCase())?.id ?? null;
  const heads = tableId === null ? [] : tableHeaders(tableId).filter(Boolean);
  const setMeasure = (i: number, patch: Partial<MeasureSpec>) => commit({ ...an, measures: an.measures.map((m, j) => (j === i ? { ...m, ...patch } : m)) }, 'chart measure changed');
  const fieldSelect = (value: string | undefined, onChange: (v: string) => void, label: string, optional = false) => (
    <select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {optional ? <option value="">{label}: none</option> : <option value="">{label}…</option>}
      {heads.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </select>
  );
  return (
    <>
      <label>
        Table
        <select value={an.table} onChange={(e) => commit({ ...an, table: e.target.value, dims: [], measures: [{ agg: 'count' }] }, 'chart table changed')}>
          {tableId === null && <option value={an.table}>{an.table || 'choose…'}</option>}
          {[...tables.values()].map((t) => (
            <option key={t.id} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Group by
        {fieldSelect(an.dims[0], (v) => commit({ ...an, dims: v ? [v, ...an.dims.slice(1).filter((d) => d !== v)] : [] }, 'chart dimension changed'), 'Dimension')}
      </label>
      {[1, 2].map((lvl) =>
        an.dims.length >= lvl ? (
          <label key={lvl}>
            {lvl === 1 ? 'Drill down to' : 'Then to'}
            {fieldSelect(an.dims[lvl], (v) => commit({ ...an, dims: v ? [...an.dims.slice(0, lvl), v] : an.dims.slice(0, lvl) }, 'chart hierarchy changed'), 'Level', true)}
          </label>
        ) : null,
      )}
      {an.measures.map((m, i) => (
        <div key={i} className="row series-row wrap">
          {/* governed metrics first (7.5): a reference holds only the name, so one definition is used everywhere */}
          <select
            aria-label="Metric"
            value={m.metric ? (metricByName(m.metric, allMetrics)?.name ?? m.metric) : ''}
            onChange={(e) => {
              const v = e.target.value;
              if (v) commit({ ...an, measures: an.measures.map((x, j) => (j === i ? metricRef(v) : x)) }, `chart measure: metric ${v}`);
              else {
                const def = metricByName(m.metric, allMetrics);
                commit({ ...an, measures: an.measures.map((x, j) => (j === i ? (def ? { ...def.measure } : { agg: 'sum' }) : x)) }, 'chart measure: custom');
              }
            }}
          >
            <option value="">Custom…</option>
            {m.metric && !metricByName(m.metric, allMetrics) && <option value={m.metric}>{m.metric} (not defined)</option>}
            {metrics.map((x) => (
              <option key={x.name} value={x.name}>
                Metric: {x.name}
              </option>
            ))}
          </select>
          {m.metric ? (
            <>
              <span className="grow small muted metric-def">{metricByName(m.metric, allMetrics) ? metricText(metricByName(m.metric, allMetrics)!) : `no metric named "${m.metric}"`}</span>
              {metricByName(m.metric, allMetrics) && (
                <button title="Change the definition: every chart, tree and watch using it follows" onClick={() => openMetrics({ metric: metricByName(m.metric, allMetrics)!, isNew: false })}>
                  Edit metric
                </button>
              )}
            </>
          ) : (
            <>
          <select aria-label="Aggregation" value={m.agg} onChange={(e) => setMeasure(i, { agg: e.target.value })}>
            {AGGS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          {m.agg === 'ratio' ? (
            <>
              {fieldSelect(m.numerator, (v) => setMeasure(i, { numerator: v }), 'Numerator')}
              {fieldSelect(m.denominator, (v) => setMeasure(i, { denominator: v }), 'Denominator')}
            </>
          ) : (
            fieldSelect(m.field, (v) => setMeasure(i, { field: v }), m.agg === 'count' ? 'Non-blank in' : 'Field', m.agg === 'count')
          )}
          {m.agg !== 'count' && m.agg !== 'count_distinct' && fieldSelect(m.currency, (v) => setMeasure(i, { currency: v }), 'Currency column', true)}
          <button title="Define this measure once for the workbook, then refer to it by name" onClick={() => openMetrics({ metric: draftFromMeasure(an.table, m), isNew: true, fromChart: chartId, measureIndex: i })}>
            Save as metric…
          </button>
            </>
          )}
          {an.measures.length > 1 && (
            <button title="Remove measure" onClick={() => commit({ ...an, measures: an.measures.filter((_, j) => j !== i) }, 'chart measure removed')}>
              ×
            </button>
          )}
        </div>
      ))}
      <div className="row wrap">
        <button onClick={() => commit({ ...an, measures: [...an.measures, { agg: 'sum' }] }, 'chart measure added')}>+ Measure</button>
        <label className="grow">
          Order
          <select value={an.sort || 'key'} onChange={(e) => commit({ ...an, sort: e.target.value as ChartAnalytic['sort'] }, 'chart order changed')}>
            <option value="key">by {an.dims[0] || 'dimension'}</option>
            <option value="value_desc">largest first</option>
            <option value="value_asc">smallest first</option>
          </select>
        </label>
      </div>
      <p className="muted small">
        Click a bar to filter the other charts on this table; Ctrl/⌘-click adds bars; click it again, click empty space or press Esc to show all. Double-click a bar for the records behind it; with a drill-down level, ↓ drills into the selected bar and ↑ goes back. Selecting never changes the workbook. Blank or text amounts are left out and said so, different currencies are not added, and averages and ratios are computed from their parts.
      </p>
    </>
  );
}

import { openPrintView } from './print';

const KINDS: { value: ChartKind; label: string }[] = [
  { value: 'bar', label: 'Column' },
  { value: 'hbar', label: 'Bar (horizontal)' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'stacked', label: 'Stacked column' },
  { value: 'waterfall', label: 'Waterfall' },
];

export function ChartPanel() {
  const charts = useStore((s) => s.charts);
  const selectedChart = useStore((s) => s.selectedChart);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const chart = charts.find((c) => c.id === selectedChart) ?? null;
  const [draft, setDraft] = useState<Chart | null>(chart);
  useEffect(() => setDraft(chart), [chart]);
  const data = useMemo(() => (draft ? chartData(draft) : null), [draft, cellsVersion]);

  if (!chart || !draft || !data) {
    return (
      <div className="panel">
        <PanelHeader title="Chart" />
        <p className="muted small">Select a table or a block of cells (a header row with numbers underneath), then insert a chart. Charts are exhibits: an action title, a grey subtitle with the dataset and units, direct labels instead of a legend, one highlighted observation, a benchmark line and a source footnote.</p>
        <div className="row wrap">
          {KINDS.map((k) => (
            <button key={k.value} onClick={() => insertChart(k.value)}>
              + {k.label}
            </button>
          ))}
        </div>
        <p className="muted small">Or an analytical chart, bound to a table's fields: its bars filter the other analytical charts on the same table and lead to the records behind them.</p>
        <div className="row wrap">
          <button onClick={() => insertAnalyticChart('bar')}>+ Analytical chart from table</button>
        </div>
        {charts.length > 0 && (
          <>
            <h4>Charts in this document</h4>
            {charts.map((c) => (
              <button key={c.id} className="list-item" onClick={() => useStore.setState({ selectedChart: c.id })}>
                {c.exhibit ? <span className="muted small">{c.exhibit.toUpperCase()} · </span> : null}
                {c.title || `Chart ${c.id}`}
              </button>
            ))}
          </>
        )}
      </div>
    );
  }

  const commit = (patch: Partial<Chart>, note?: string) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    updateChart(next, note);
  };
  const edit = (patch: Partial<Chart>) => setDraft({ ...draft, ...patch });
  const blur = () => {
    if (JSON.stringify(draft) !== JSON.stringify(chart)) updateChart(draft);
  };
  const setSeries = (i: number, patch: Partial<Chart['series'][number]>) => {
    const series = draft.series.map((s, j) => (j === i ? { ...s, ...patch } : s));
    edit({ series });
  };
  const useSelection = () => {
    const guess = chartFromSelection(draft.kind);
    if (!guess) return;
    commit({ categories: guess.categories, series: guess.series, subtitle: guess.subtitle, source: guess.source }, 'chart ranges changed');
  };
  const addSeriesFromSelection = () => {
    const st = getState();
    const sel = st.selection;
    const meta = sel && st.tables.get(sel.table);
    if (!sel || !meta) return;
    const header = st.cells.get(sel.table)?.get(sel.r0 * 65536 + sel.c0);
    const isHeader = header && header.v && 's' in header.v && sel.r1 > sel.r0;
    const name = isHeader ? (header.v as { s: string }).s : `Series ${draft.series.length + 1}`;
    commit({ series: [...draft.series, { name, range: refText(meta.name, isHeader ? sel.r0 + 1 : sel.r0, sel.c0, sel.r1, sel.c0) }] }, 'series added');
  };
  const download = async (kind: 'svg' | 'png') => {
    const name = (draft.title || `chart-${draft.id}`).replace(/[^\w.-]+/g, '_').slice(0, 60);
    if (kind === 'svg') downloadBlob(new Blob([chartSvg(draft, data)], { type: 'image/svg+xml' }), `${name}.svg`);
    else downloadBlob(await chartPng(draft, data), `${name}.png`);
  };

  return (
    <div className="panel chart-panel">
      <PanelHeader title="Chart" />
      <label>
        Type
        <select value={draft.kind} onChange={(e) => commit({ kind: e.target.value as ChartKind })}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Exhibit tag
        <input value={draft.exhibit} placeholder="Exhibit 1 — Revenue" onChange={(e) => edit({ exhibit: e.target.value })} onBlur={blur} />
      </label>
      <label>
        Title (state the takeaway)
        <input value={draft.title} placeholder="Revenue grew 12% in Q3, driven by Luanda" onChange={(e) => edit({ title: e.target.value })} onBlur={blur} />
      </label>
      <label>
        Subtitle (dataset and units)
        <input value={draft.subtitle} placeholder="Monthly revenue, AOA millions, 2026" onChange={(e) => edit({ subtitle: e.target.value })} onBlur={blur} />
      </label>
      <label>
        Source / definitions
        <input value={draft.source} placeholder="Primavera ERP, extracted 9 Oct 2026" onChange={(e) => edit({ source: e.target.value })} onBlur={blur} />
      </label>
      <h4>Data</h4>
      {draft.analytic ? (
        <>
          <AnalyticFields an={draft.analytic} chartId={draft.id} commit={(an, note) => { forgetChart(draft.id); commit({ analytic: an }, note); }} />
          <div className="row wrap">
            <button onClick={() => useStore.setState({ recordsChart: draft.id, panel: 'records' })}>See records</button>
            <button title="Break the first measure down level by level, a field per node (read-only)" onClick={() => openDecomposition(draft.id)}>
              Break down
            </button>
            <button onClick={() => { forgetChart(draft.id); commit({ analytic: null }, 'chart reads ranges'); }}>Use ranges instead</button>
          </div>
        </>
      ) : (
        <>
      <label>
        Categories
        <input value={draft.categories} placeholder="Sales::A2:A13" onChange={(e) => edit({ categories: e.target.value })} onBlur={blur} />
      </label>
      {draft.series.map((s, i) => (
        <div key={i} className="row series-row">
          <input className="grow" value={s.name} placeholder="Name" onChange={(e) => setSeries(i, { name: e.target.value })} onBlur={blur} />
          <input className="grow" value={s.range} placeholder="Sales::B2:B13" onChange={(e) => setSeries(i, { range: e.target.value })} onBlur={blur} />
          <button title="Remove series" onClick={() => commit({ series: draft.series.filter((_, j) => j !== i) }, 'series removed')}>
            ×
          </button>
        </div>
      ))}
      <div className="row wrap">
        <button onClick={addSeriesFromSelection}>+ Series from selection</button>
        <button onClick={useSelection}>Use selection</button>
        <button
          onClick={() => {
            const st = getState();
            const t = st.selection?.table ?? st.tables.keys().next().value;
            const guess = t === undefined ? null : analyticFromTable(t, draft.kind);
            if (guess) commit({ analytic: guess.analytic }, 'chart bound to table fields');
          }}
        >
          Bind to table fields
        </button>
      </div>
        </>
      )}
      {data.error && <div className="muted small">{data.error}</div>}
      <h4>Emphasis</h4>
      {!draft.analytic && (
      <label>
        Highlight
        <select value={draft.highlight ?? ''} onChange={(e) => commit({ highlight: e.target.value === '' ? null : Number(e.target.value) })}>
          <option value="">none</option>
          {data.categories.map((c, i) => (
            <option key={i} value={i}>
              {c}
            </option>
          ))}
        </select>
      </label>
      )}
      <div className="row">
        <label className="grow">
          Reference line
          <input
            type="number"
            value={draft.reference?.value ?? ''}
            placeholder="value"
            onChange={(e) => edit({ reference: e.target.value === '' ? null : { value: Number(e.target.value), label: draft.reference?.label ?? 'Target' } })}
            onBlur={blur}
          />
        </label>
        <label className="grow">
          Label
          <input value={draft.reference?.label ?? ''} placeholder="Budget" disabled={!draft.reference} onChange={(e) => edit({ reference: draft.reference ? { ...draft.reference, label: e.target.value } : null })} onBlur={blur} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={draft.show_values} onChange={(e) => commit({ show_values: e.target.checked })} /> Value labels
      </label>
      <label className="check">
        <input type="checkbox" checked={draft.stat_cards} onChange={(e) => commit({ stat_cards: e.target.checked })} /> Stat cards
      </label>
      <div className="row">
        <label className="grow">
          Width
          <input type="number" value={draft.w} onChange={(e) => edit({ w: Math.max(240, Number(e.target.value) || 240) })} onBlur={blur} />
        </label>
        <label className="grow">
          Height
          <input type="number" value={draft.h} onChange={(e) => edit({ h: Math.max(180, Number(e.target.value) || 180) })} onBlur={blur} />
        </label>
      </div>
      <h4>Output</h4>
      <div className="row wrap">
        <button onClick={() => void download('svg')}>Download SVG</button>
        <button onClick={() => void download('png')}>Download PNG</button>
        <button onClick={() => openPrintView({ charts: [draft.id] })}>Print</button>
        <button
          className="danger"
          onClick={() => {
            forgetChart(draft.id);
            book.apply({ type: 'delete_chart', id: draft.id }, { note: 'chart deleted' });
            useStore.setState({ selectedChart: null });
          }}
        >
          Delete chart
        </button>
      </div>
      <p className="muted small">Drag the chart by its body; the bottom-right handle resizes it. Double-click a chart to open this panel.</p>
    </div>
  );
}
