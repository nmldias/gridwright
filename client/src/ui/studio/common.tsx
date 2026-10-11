// Small building blocks shared by the guided import screens.
import { useEffect, useRef, useState } from 'react';
import { fmtNum, waitJob, type ColumnMeta, type Job, type Series, type Stage } from '../../api/datasets';

export const STAGES: { key: Stage; label: string; hint: string }[] = [
  { key: 'read', label: 'Read', hint: 'where the table starts and what each column is' },
  { key: 'clean', label: 'Clean', hint: 'spaces, numbers and dates written as text, names, signs' },
  { key: 'check', label: 'Check', hint: 'duplicates, totals and rules the data must keep' },
  { key: 'structure', label: 'Structure', hint: 'the tables the data becomes' },
  { key: 'analyse', label: 'Analyse', hint: 'summaries, ageing and pivots' },
];
export const stageLabel = (s: string) => STAGES.find((x) => x.key === s)?.label ?? s;

export function StageChip({ stage }: { stage: string }) {
  return <span className={`stage-chip stage-${stage}`}>{stageLabel(stage)}</span>;
}

export function Progress({ job, label }: { job: Job | null; label?: string }) {
  if (!job) return null;
  const pct = job.of ? Math.round(((job.done ?? 0) / job.of) * 100) : null;
  return (
    <div className="studio-progress" role="status" aria-live="polite">
      <div className="row small">
        <span className="grow">{label ?? 'Working'}{job.phase ? ` — ${job.phase}` : ''}</span>
        {pct !== null && <span className="num">{pct}%</span>}
      </div>
      <div className="bar">
        <div className={pct === null ? 'fill indeterminate' : 'fill'} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Follow a job until it ends; returns the live job (null when none). */
export function useJob(id: string | null | undefined, onEnd?: (j: Job) => void) {
  const [job, setJob] = useState<Job | null>(null);
  const end = useRef(onEnd);
  end.current = onEnd;
  useEffect(() => {
    if (!id) {
      setJob(null);
      return;
    }
    const sig = { cancelled: false };
    waitJob(id, (j) => !sig.cancelled && setJob(j), sig)
      .then((j) => {
        if (sig.cancelled) return;
        setJob(null);
        end.current?.(j);
      })
      .catch(() => {
        if (!sig.cancelled) setJob(null);
      });
    return () => {
      sig.cancelled = true;
    };
  }, [id]);
  return job;
}

/** document numbers, codes and rows in the file are names, not quantities: shown as they are, without
 *  thousands separators (amounts carry a unit, so a “Nº …” label is never an amount here) */
const ID_LABEL = /(^|\s)(n[º°o]\.?|n\.º|número|numero|num\.?)(\s|$)|\bid\b|^code\b|c[óo]digo|\bref\b/i;
/** the column holding the row in the file a record came from */
export const ROW_META: ColumnMeta = { key: '_row', label: 'Row in file', type: 'number' };
export const isIdentColumn = (c?: ColumnMeta) => !!c && (c.type === 'identifier' || c.key === '_row' || (c.type === 'number' && !c.unit && ID_LABEL.test(c.label)));

const cellText = (v: unknown, c?: ColumnMeta) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return isIdentColumn(c) ? String(v) : c?.type === 'number' || c === undefined ? fmtNum(v) : String(v);
  return String(v);
};

/** A plain table of rows; the first column can be the row in the file. */
export function DataTable({
  columns,
  rows,
  meta,
  highlight,
  onRow,
  empty = 'No rows',
  maxHeight,
  caption,
}: {
  columns: string[];
  rows: unknown[][];
  meta?: (ColumnMeta | undefined)[];
  highlight?: (r: number, c: number) => string | undefined;
  onRow?: (r: number) => void;
  empty?: string;
  maxHeight?: number;
  caption?: string;
}) {
  return (
    <div className="studio-table-wrap" style={maxHeight ? { maxHeight } : undefined}>
      <table className="studio-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={meta?.[i]?.type === 'number' ? 'num' : undefined} title={meta?.[i]?.source ? `from “${meta[i]!.source!.header}”` : undefined}>
                {c}
                {meta?.[i]?.unit ? <span className="muted"> ({meta[i]!.unit})</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={Math.max(1, columns.length)} className="muted">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((r, ri) => (
            <tr key={ri} onClick={onRow ? () => onRow(ri) : undefined} className={onRow ? 'clickable' : undefined}>
              {columns.map((_, ci) => (
                <td key={ci} className={[typeof r[ci] === 'number' ? 'num' : '', highlight?.(ri, ci) ?? ''].join(' ').trim() || undefined}>
                  {cellText(r[ci], meta?.[ci])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A small line chart for an insight card: one line per series, first and last label, a value on hover. */
export function Spark({ series, height = 56 }: { series: Series[]; height?: number }) {
  const lines = series.filter((s) => Array.isArray(s?.y) && s.y.length);
  const pts = lines.flatMap((s) => s.y.filter((v) => Number.isFinite(v)));
  if (!pts.length) return null;
  const min = Math.min(0, ...pts);
  const max = Math.max(...pts, 1e-9);
  const n = Math.max(...lines.map((s) => s.y.length));
  const w = 240;
  const plot = height - 14; // room for the axis labels
  const x = (i: number) => (n <= 1 ? w / 2 : (i / (n - 1)) * (w - 8) + 4);
  const y = (v: number) => plot - 3 - ((v - min) / (max - min || 1)) * (plot - 6);
  const colours = ['var(--accent)', 'var(--amber)', 'var(--green)', 'var(--muted)'];
  const xs = lines[0].x ?? [];
  const fmt = (v: number, unit?: string) => (unit === '%' ? `${fmtNum(v)}%` : fmtNum(v, unit));
  return (
    <div className="spark-wrap">
      <svg className="spark" viewBox={`0 0 ${w} ${height}`} width="100%" height={height} role="img" aria-label={lines.map((s) => s.label).join(', ')}>
        {min < 0 && <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="var(--border)" />}
        {lines.map((s, si) => (
          <g key={si}>
            <polyline fill="none" stroke={colours[si % colours.length]} strokeWidth={1.6} points={s.y.map((v, i) => `${x(i)},${y(Number.isFinite(v) ? v : 0)}`).join(' ')} />
            {s.y.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(Number.isFinite(v) ? v : 0)} r={2.4} fill={colours[si % colours.length]}>
                <title>{`${s.label} · ${s.x?.[i] ?? i + 1}: ${fmt(v, s.unit)}`}</title>
              </circle>
            ))}
          </g>
        ))}
        {xs.length > 0 && (
          <>
            <text x={2} y={height - 2} fontSize={9} fill="var(--muted)">{xs[0]}</text>
            <text x={w - 2} y={height - 2} fontSize={9} fill="var(--muted)" textAnchor="end">{xs[xs.length - 1]}</text>
          </>
        )}
      </svg>
      {lines.length > 1 && (
        <div className="spark-legend small muted">
          {lines.map((s, si) => (
            <span key={si}>
              <i style={{ background: colours[si % colours.length] }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
/** Monthly bars: invoiced up, credited down, the net as a line. */
export function MonthBars({ months, unit }: { months: { month: string; invoiced: number; credited: number; net: number }[]; unit?: string }) {
  if (!months.length) return null;
  const w = Math.max(320, months.length * 56);
  const h = 190;
  const top = Math.max(...months.map((m) => Math.max(m.invoiced, m.net)), 1);
  const bottom = Math.max(...months.map((m) => m.credited), 0);
  const scale = (h - 40) / (top + bottom || 1);
  const zero = 12 + top * scale;
  const bw = Math.min(30, (w / months.length) * 0.5);
  const cx = (i: number) => ((i + 0.5) * w) / months.length;
  const short = (v: number) => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(1)}bn` : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(0)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0));
  return (
    <svg className="month-bars" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={`Invoiced, credited and net by month${unit ? ` in ${unit}` : ''}`}>
      <line x1={0} x2={w} y1={zero} y2={zero} stroke="var(--border-strong)" />
      {months.map((m, i) => (
        <g key={m.month}>
          <title>{`${m.month}: invoiced ${fmtNum(m.invoiced)}, credited ${fmtNum(m.credited)}, net ${fmtNum(m.net)}${unit ? ` ${unit}` : ''}`}</title>
          <rect x={cx(i) - bw / 2} y={zero - m.invoiced * scale} width={bw} height={Math.max(0, m.invoiced * scale)} fill="var(--accent)" opacity={0.85} />
          <rect x={cx(i) - bw / 2} y={zero} width={bw} height={Math.max(0, m.credited * scale)} fill="var(--amber)" opacity={0.8} />
          <text x={cx(i)} y={h - 4} textAnchor="middle" fontSize={10} fill="var(--muted)">
            {m.month.slice(2)}
          </text>
          <text x={cx(i)} y={Math.max(10, zero - m.invoiced * scale - 4)} textAnchor="middle" fontSize={9} fill="var(--muted)">
            {short(m.net)}
          </text>
        </g>
      ))}
      <polyline fill="none" stroke="var(--text)" strokeWidth={1.4} strokeDasharray="3 2" points={months.map((m, i) => `${cx(i)},${zero - m.net * scale}`).join(' ')} />
    </svg>
  );
}

export const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
