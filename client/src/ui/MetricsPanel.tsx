// Governed metrics (roadmap 7.5): the workbook's metric definitions. Each change is an operation
// (set_metric / rename_metric): undoable, relayed to other editors, in the history. Charts,
// decomposition trees, the assistant and companion watches refer to a metric by name, so a change here
// reaches all of them.

import { useEffect, useMemo, useState } from 'react';
import { PanelHeader } from './PanelHeader';
import * as book from '../engine/book';
import type { Metric } from '../engine/types';
import { setStatus, useStore } from '../state/store';
import { NUMBER_FORMATS } from '../grid/format';
import { metricRef, metricText, metricUses } from '../grid/metrics';
import { tableHeaders, updateChart } from './review';
import { AGGS } from './ChartPanel';

const stop = (e: React.KeyboardEvent) => e.stopPropagation();

function blankMetric(table: string): Metric {
  return { name: '', table, measure: { agg: 'sum', field: '' }, currency: '', format: '', description: '' };
}

export function MetricsPanel() {
  const metrics = useStore((s) => s.metrics);
  const charts = useStore((s) => s.charts);
  const tables = useStore((s) => s.tables);
  const draftIn = useStore((s) => s.metricDraft);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const [draft, setDraft] = useState<Metric | null>(draftIn?.metric ?? null);
  const [original, setOriginal] = useState<string | null>(draftIn && !draftIn.isNew ? draftIn.metric.name : null);
  const [error, setError] = useState('');
  const [customFormat, setCustomFormat] = useState(false);

  useEffect(() => {
    setDraft(draftIn ? { ...draftIn.metric, measure: { ...draftIn.metric.measure } } : null);
    setOriginal(draftIn && !draftIn.isNew ? draftIn.metric.name : null);
    setError('');
    setCustomFormat(!!draftIn?.metric.format && !NUMBER_FORMATS.some((f) => f.value === draftIn.metric.format));
  }, [draftIn]);

  // a definition the data no longer supports (a renamed column, a deleted table) says why
  const problems = useMemo(() => {
    const out = new Map<string, string>();
    for (const m of metrics) {
      const a = book.analyze({ table: '', dims: [], measures: [metricRef(m.name)] });
      if (a.error) out.set(m.name, a.error);
    }
    return out;
  }, [metrics, cellsVersion, tables]);

  const tableId = draft ? ([...tables.values()].find((t) => t.name.toLowerCase() === draft.table.trim().toLowerCase())?.id ?? null) : null;
  const heads = tableId === null ? [] : tableHeaders(tableId).filter(Boolean);
  const setMeasure = (patch: Partial<Metric['measure']>) => draft && setDraft({ ...draft, measure: { ...draft.measure, ...patch } });
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

  const startNew = () => {
    const first = [...tables.values()].find((t) => t.header_rows > 0);
    useStore.setState({ metricDraft: { metric: blankMetric(first?.name ?? ''), isNew: true } });
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError('a metric needs a name');
      return;
    }
    // a changed name on an existing metric is a rename first (charts referring to it follow)
    if (original && original !== name) {
      const r = book.apply({ type: 'rename_metric', name: original, to: name }, { note: `metric renamed: ${original} → ${name}` });
      if (r.error) {
        setError(r.error);
        return;
      }
    }
    const metric: Metric = { ...draft, name };
    const ch = book.apply({ type: 'set_metric', name, metric }, { note: `metric: ${name}` });
    if (ch.error) {
      setError(ch.error);
      setStatus(ch.error, 5000);
      if (original && original !== name) setOriginal(name);
      return;
    }
    // "Save as metric" from a chart's measure: the measure now refers to the metric
    const from = useStore.getState().metricDraft;
    if (from?.isNew && from.fromChart !== undefined && from.measureIndex !== undefined) {
      const chart = useStore.getState().charts.find((c) => c.id === from.fromChart);
      if (chart?.analytic) {
        updateChart({ ...chart, analytic: { ...chart.analytic, measures: chart.analytic.measures.map((m, j) => (j === from.measureIndex ? metricRef(name) : m)) } }, `chart measure: metric ${name}`);
      }
    }
    setError('');
    setStatus(`Metric ${name} saved`);
    useStore.setState({ metricDraft: null });
  };

  const remove = (m: Metric) => {
    const uses = metricUses(m.name, charts);
    if (uses.length && !window.confirm(`Used by ${uses.length} chart${uses.length === 1 ? '' : 's'}. Remove anyway? They will show "no metric named ${m.name}" until it is defined again (Undo brings it back).`)) return;
    const ch = book.apply({ type: 'set_metric', name: m.name, metric: null }, { note: `metric removed: ${m.name}` });
    if (ch.error) setStatus(ch.error, 5000);
  };

  const formatValue = draft?.format ?? '';
  return (
    <div className="panel metrics-panel">
      <PanelHeader title="Metrics">
        <button className="primary metric-new" onClick={startNew} disabled={!tables.size}>
          New metric
        </button>
      </PanelHeader>
      <p className="muted small">
        A metric is defined once for the workbook. Charts, the decomposition tree, the assistant and companion watches refer to it by name, so changing it here changes every number that uses it. Each change is an operation: undoable and in the history.
      </p>
      <ul className="rule-list metric-list">
        {metrics.map((m) => {
          const uses = metricUses(m.name, charts).length;
          const problem = problems.get(m.name);
          return (
            <li key={m.name} data-metric={m.name}>
              <div className="grow">
                <b className="small">{m.name}</b>
                <div className="small muted">{metricText(m)}</div>
                {m.description && <div className="small">{m.description}</div>}
                <div className="small muted">{uses ? `used by ${uses} chart${uses === 1 ? '' : 's'}` : 'not used by a chart'}</div>
                {problem && <div className="small error metric-problem">broken: {problem}</div>}
              </div>
              <button title="Edit the definition" onClick={() => useStore.setState({ metricDraft: { metric: m, isNew: false } })}>
                Edit
              </button>
              <button className="icon" title="Remove" aria-label={`Remove metric ${m.name}`} onClick={() => remove(m)}>
                ×
              </button>
            </li>
          );
        })}
        {!metrics.length && <li className="muted small">No metrics yet. Define one here, or use "Save as metric…" on a chart's measure.</li>}
      </ul>
      {draft && (
        <div className="metric-form">
          <div className="panel-subtitle">{original ? `Edit ${original}` : 'New metric'}</div>
          <label>
            Name
            <input aria-label="Metric name" value={draft.name} onKeyDown={stop} placeholder="Net revenue" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            Table
            <select aria-label="Metric table" value={draft.table} onChange={(e) => setDraft({ ...draft, table: e.target.value, measure: { agg: draft.measure.agg || 'sum' } })}>
              {tableId === null && <option value={draft.table}>{draft.table || 'choose…'}</option>}
              {[...tables.values()].map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <div className="row series-row wrap">
            <select aria-label="Metric aggregation" value={draft.measure.agg || 'sum'} onChange={(e) => setMeasure({ agg: e.target.value })}>
              {AGGS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            {draft.measure.agg === 'ratio' ? (
              <>
                {fieldSelect(draft.measure.numerator, (v) => setMeasure({ numerator: v }), 'Numerator')}
                {fieldSelect(draft.measure.denominator, (v) => setMeasure({ denominator: v }), 'Denominator')}
              </>
            ) : (
              fieldSelect(draft.measure.field, (v) => setMeasure({ field: v }), draft.measure.agg === 'count' ? 'Non-blank in' : 'Field', draft.measure.agg === 'count')
            )}
            {draft.measure.agg !== 'count' && draft.measure.agg !== 'count_distinct' && fieldSelect(draft.measure.currency, (v) => setMeasure({ currency: v }), 'Currency column', true)}
          </div>
          {draft.measure.agg !== 'count' && draft.measure.agg !== 'count_distinct' && (
            <label>
              Reporting currency
              <input aria-label="Reporting currency" value={draft.currency ?? ''} maxLength={3} onKeyDown={stop} placeholder="EUR, AOA… (optional)" onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} />
            </label>
          )}
          <label>
            Format
            <select
              aria-label="Metric format"
              value={customFormat ? '__custom' : formatValue}
              onChange={(e) => {
                if (e.target.value === '__custom') setCustomFormat(true);
                else {
                  setCustomFormat(false);
                  setDraft({ ...draft, format: e.target.value });
                }
              }}
            >
              {NUMBER_FORMATS.filter((f) => !/[dmyh]{2}/.test(f.value)).map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
              <option value="__custom">Custom…</option>
            </select>
          </label>
          {customFormat && <input aria-label="Custom format" value={formatValue} onKeyDown={stop} placeholder="#,##0.00 &quot;Kz&quot;" onChange={(e) => setDraft({ ...draft, format: e.target.value })} />}
          <label>
            Description
            <textarea aria-label="Metric description" value={draft.description ?? ''} rows={3} onKeyDown={stop} placeholder="What it means, what it includes and leaves out" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          {error && <p className="error small metric-error">{error}</p>}
          <div className="row">
            <button className="primary" onClick={save}>
              Save metric
            </button>
            <button onClick={() => useStore.setState({ metricDraft: null })}>Cancel</button>
          </div>
          <p className="muted small">The definition is checked against the table when saved. Different currencies are never added or converted: with a reporting currency, amounts in any other currency are shown apart.</p>
        </div>
      )}
    </div>
  );
}
