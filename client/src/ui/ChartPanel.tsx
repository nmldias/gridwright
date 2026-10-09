import { useEffect, useMemo, useState } from 'react';
import * as book from '../engine/book';
import { refText, type Chart, type ChartKind } from '../engine/types';
import { chartData, chartPng, chartSvg, downloadBlob } from '../grid/charts';
import { getState, useStore } from '../state/store';
import { chartFromSelection, insertChart, updateChart } from './review';
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
        <h3>Chart</h3>
        <p className="muted small">Select a table or a block of cells (a header row with numbers underneath), then insert a chart. Charts are exhibits: an action title, a grey subtitle with the dataset and units, direct labels instead of a legend, one highlighted observation, a benchmark line and a source footnote.</p>
        <div className="row wrap">
          {KINDS.map((k) => (
            <button key={k.value} onClick={() => insertChart(k.value)}>
              + {k.label}
            </button>
          ))}
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
      <h3>Chart</h3>
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
      </div>
      {data.error && <div className="muted small">{data.error}</div>}
      <h4>Emphasis</h4>
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
