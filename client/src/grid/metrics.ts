// Governed metrics (roadmap 7.5): helpers over the workbook's metric definitions (store.metrics,
// from the engine). A chart, a decomposition tree or a watch holds only a metric's name; the engine
// replaces it with the definition (core/src/metrics.rs). These helpers are for the client code that
// needs the concrete fields (which columns a record list shows, which columns are not split
// candidates) and for showing one definition the same way everywhere.

import type { Chart, MeasureInfo, MeasureSpec, Metric } from '../engine/types';
import { getState, useStore } from '../state/store';
import { formatNumber } from './format';

const lower = (s: string | undefined) => (s ?? '').trim().toLowerCase();

export function metricByName(name: string | undefined, metrics: Metric[] = getState().metrics): Metric | undefined {
  const n = lower(name);
  return n ? metrics.find((m) => lower(m.name) === n) : undefined;
}

/** The metrics defined on a table. */
export function metricsOn(table: string, metrics: Metric[] = getState().metrics): Metric[] {
  return metrics.filter((m) => lower(m.table) === lower(table));
}

/** A spec with a metric reference replaced by the definition (the engine does the same). */
export function resolveSpec(spec: MeasureSpec, metrics: Metric[] = getState().metrics): { spec: MeasureSpec; metric?: Metric; error?: string } {
  if (!spec.metric) return { spec };
  const m = metricByName(spec.metric, metrics);
  if (!m) return { spec, error: `no metric named "${spec.metric}"` };
  return { spec: { ...m.measure, name: spec.name || m.name }, metric: m };
}

/** The columns a measure reads (resolved through its metric). */
export function measureColumns(spec: MeasureSpec, metrics?: Metric[]): string[] {
  const s = resolveSpec(spec, metrics).spec;
  return [s.field, s.numerator, s.denominator, s.currency].filter((f): f is string => !!f);
}

const AGG_TEXT: Record<string, string> = { sum: 'sum', count: 'count', count_distinct: 'distinct count', average: 'average', min: 'min', max: 'max', ratio: 'ratio' };

/** A definition in words, canonical (what the assistant reads and the panel shows):
 * "sum of Sales[Amount]; currency column Currency; reporting EUR; format #,##0.00". */
export function metricText(m: Metric): string {
  const s = m.measure;
  const agg = (s.agg || 'sum').toLowerCase();
  let what: string;
  if (agg === 'ratio') what = `ratio of ${m.table}[${s.numerator}] to ${m.table}[${s.denominator}] (each summed)`;
  else if (agg === 'count' && !s.field) what = `count of rows of ${m.table}`;
  else what = `${AGG_TEXT[agg] ?? agg} of ${m.table}[${s.field}]`;
  const parts = [what];
  if (s.currency) parts.push(`currency column ${s.currency}`);
  if (m.currency) parts.push(`reporting ${m.currency}`);
  if (m.format) parts.push(`format ${m.format}`);
  return parts.join('; ');
}

/** The charts that refer to a metric. */
export function metricUses(name: string, charts: Chart[] = getState().charts): Chart[] {
  const n = lower(name);
  return charts.filter((c) => c.analytic?.measures.some((m) => lower(m.metric) === n));
}

/** The display pattern of a measure the engine resolved: the metric's format, else its currency. */
export function patternOfInfo(info: Pick<MeasureInfo, 'format' | 'currency'> | undefined): string | undefined {
  if (!info) return undefined;
  if (info.format) return info.format;
  if (info.currency) return `currency:${info.currency}`;
  return undefined;
}

/** A value of a governed metric as people see it (its format; the workbook's decimal comma). */
export function formatMetricValue(v: number, info: Pick<MeasureInfo, 'format' | 'currency'> | undefined): string | null {
  const p = patternOfInfo(info);
  return p ? formatNumber(v, p) : null;
}

/** A reference to a metric, as charts and trees store it. */
export function metricRef(name: string): MeasureSpec {
  return { agg: '', metric: name };
}

/** Open the Metrics panel, optionally on a metric to edit or a new one prefilled. */
export function openMetrics(draft: { metric: Metric; isNew: boolean; fromChart?: number; measureIndex?: number } | null = null) {
  useStore.setState({ panel: 'metrics', metricDraft: draft });
}

/** A new metric prefilled from an inline measure of a chart (the "Save as metric" path). */
export function draftFromMeasure(table: string, spec: MeasureSpec): Metric {
  const { name, field, agg, numerator, denominator, currency } = spec;
  return { name: name || '', table, measure: { field, agg: agg || 'sum', numerator, denominator, currency } };
}
