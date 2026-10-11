// Results: what a full run produced — checks, the insights found in the data, the output tables
// (to look through, export, or place in the workbook) and saving the steps as a recipe.
import { useEffect, useMemo, useState } from 'react';
import { datasets, fmtNum, recipes, type Insight, type OutputMeta, type Page, type RunMeta } from '../../api/datasets';
import { useStore } from '../../state/store';
import { PlaceTables } from './Place';
import { DataTable, MonthBars, ROW_META, Spark, plural, when } from './common';
import type { Model } from './model';

const ROLE_LABEL: Record<OutputMeta['role'], string> = { fact: 'detail', dimension: 'list', summary: 'summary', exceptions: 'exceptions', analysis: 'analysis' };

export function Results({ m, onTab }: { m: Model; onTab: (t: 'prepare' | 'results' | 'related' | 'audit') => void }) {
  const run = m.run;
  if (!run) return <div className="studio-empty muted">No run yet — prepare the steps and run them on every row.</div>;
  return (
    <div className="results">
      <RunBar m={m} run={run} />
      <div className="results-grid">
        <div className="results-main">
          <Insights m={m} run={run} onTab={onTab} />
          <Outputs m={m} run={run} />
        </div>
        <aside className="results-side">
          <Checks run={run} />
          <Place m={m} run={run} />
          <SaveRecipe m={m} run={run} />
        </aside>
      </div>
    </div>
  );
}

function RunBar({ m, run }: { m: Model; run: RunMeta }) {
  const runs = m.meta?.runs ?? [];
  return (
    <div className="run-summary row">
      <div className="grow">
        <b>{run.ok ? 'Run complete' : 'Run stopped'}</b>{' '}
        <span className="muted small">
          {plural(run.rows, 'row')} · {(run.ms / 1000).toFixed(1)} s · {run.by}, {when(run.at)}
          {run.recipe ? ` · recipe v${run.recipe.version}` : ''}
        </span>
        {!run.ok && <div className="err small">Stopped at a failing step ({run.failedAt}). See Audit for the details.</div>}
      </div>
      {runs.length > 1 && (
        <label className="field small">
          <span>Run</span>
          <select value={run.id} onChange={(e) => m.selectRun(e.target.value)} aria-label="Choose a run">
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {when(r.at)} · {r.by} · {plural(r.rows, 'row')}
                {r.ok ? '' : ' · failed'}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function Checks({ run }: { run: RunMeta }) {
  if (!run.checks.length) return null;
  return (
    <section className="side-card">
      <h3 className="studio-h3">Checks</h3>
      {run.checks.map((c, i) => {
        const ok = c.failing === 0;
        return (
          <div key={i} className={`check-row ${ok ? 'ok' : c.severity}`}>
            <span className="check-mark" aria-hidden>
              {ok ? '✓' : c.severity === 'error' ? '✕' : '!'}
            </span>
            <span className="grow small">{c.label}</span>
            <span className="small num">{ok ? 'passed' : `${fmtNum(c.failing)} of ${fmtNum(c.total)}`}</span>
          </div>
        );
      })}
    </section>
  );
}

function Insights({ m, run, onTab }: { m: Model; run: RunMeta; onTab: (t: 'prepare') => void }) {
  const ins = run.insights;
  const [added, setAdded] = useState<Record<string, string>>({});
  if (!ins) return run.insightsError ? <div className="err small">Insights could not be computed: {run.insightsError}</div> : null;
  const addStep = (it: Insight) => {
    if (!it.step) return;
    const err = m.applyAction({ op: 'add', step: { ...it.step, by: 'rule' }, why: it.title });
    setAdded((a) => ({ ...a, [it.id]: err ?? 'added' }));
  };
  return (
    <section className="insights">
      <div className="row">
        <h2 className="studio-h2 grow">What the data says</h2>
        <span className="muted small">
          {ins.from && ins.asOf ? `${ins.from} to ${ins.asOf}` : ''}
          {run.unit ? ` · amounts in ${run.unit}` : ''}
        </span>
      </div>
      {ins.months.length > 0 && (
        <div className="chart-card">
          <div className="row small">
            <span className="grow">By month — invoiced (up), credited (down), net (dashed)</span>
            <span className="legend">
              <i style={{ background: 'var(--accent)' }} /> invoiced <i style={{ background: 'var(--amber)' }} /> credited
            </span>
          </div>
          <MonthBars months={ins.months} unit={run.unit} />
        </div>
      )}
      <div className="insight-grid">
        {ins.items.map((it) => (
          <article key={it.id} className={`insight-card ${it.level}`}>
            <h3 className="studio-h3">{it.title}</h3>
            <p className="small">{it.text}</p>
            {it.figures.length > 0 && (
              <dl className="figures">
                {it.figures.slice(0, 4).map((f, i) => (
                  <div key={i}>
                    <dt className="muted small">{f.label}</dt>
                    <dd className="num">{fmtNum(f.value, f.unit)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {it.series && it.series.length > 0 && <Spark series={it.series} />}
            {it.step && m.canEdit && (
              <div className="row">
                {added[it.id] ? (
                  <span className={`small ${added[it.id] === 'added' ? 'green-text' : 'err'}`}>
                    {added[it.id] === 'added' ? (
                      <>
                        Added to the steps —{' '}
                        <button className="link small" onClick={() => onTab('prepare')}>
                          review and run again
                        </button>
                      </>
                    ) : (
                      added[it.id]
                    )}
                  </span>
                ) : (
                  <button className="small" onClick={() => addStep(it)}>
                    Add the suggested step
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function Outputs({ m, run }: { m: Model; run: RunMeta }) {
  const [open, setOpen] = useState<string | null>(run.outputs.find((o) => o.role === 'summary')?.key ?? run.outputs[0]?.key ?? null);
  useEffect(() => setOpen(run.outputs.find((o) => o.role === 'summary')?.key ?? run.outputs[0]?.key ?? null), [run.id]);
  const o = run.outputs.find((x) => x.key === open);
  return (
    <section className="outputs">
      <h2 className="studio-h2">Tables</h2>
      <div className="output-tabs" role="tablist" aria-label="Output tables">
        {run.outputs.map((x) => (
          <button key={x.key} role="tab" aria-selected={x.key === open} className={x.key === open ? 'active' : undefined} onClick={() => setOpen(x.key)}>
            {x.label} <span className="muted small">{fmtNum(x.rows)}</span> <span className={`role role-${x.role}`}>{ROLE_LABEL[x.role]}</span>
          </button>
        ))}
      </div>
      {o && <OutputTable key={`${run.id}:${o.key}`} m={m} run={run} out={o} />}
    </section>
  );
}

function OutputTable({ m, run, out }: { m: Model; run: RunMeta; out: OutputMeta }) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<{ column: string; value: string }>({ column: '', value: '' });
  const [applied, setApplied] = useState<{ column: string; value: string } | undefined>();
  const [err, setErr] = useState<string | null>(null);
  const LIMIT = 100;
  useEffect(() => {
    let stop = false;
    datasets
      .table(m.id, run.id, `out_${out.key}`, offset, LIMIT, applied)
      .then((p) => !stop && (setPage(p), setErr(null)))
      .catch((e) => !stop && setErr((e as Error).message));
    return () => {
      stop = true;
    };
  }, [m.id, run.id, out.key, offset, applied]);
  const metaFor = useMemo(() => (page?.columns ?? []).map((c) => (c === '_row' ? ROW_META : out.columns.find((x) => x.key === c))), [page, out]);
  const labels = (page?.columns ?? []).map((c, i) => (c === '_row' ? 'Row in file' : (metaFor[i]?.label ?? c)));
  return (
    <div className="output-table">
      <div className="row small">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setApplied(filter.column && filter.value ? filter : undefined);
          }}
        >
          <select value={filter.column} onChange={(e) => setFilter({ ...filter, column: e.target.value })} aria-label="Filter column">
            <option value="">Filter by…</option>
            {out.columns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <input value={filter.value} onChange={(e) => setFilter({ ...filter, value: e.target.value })} placeholder="value" aria-label="Filter value" />
          <button type="submit" className="small">
            Filter
          </button>
          {applied && (
            <button
              type="button"
              className="link small"
              onClick={() => {
                setFilter({ column: '', value: '' });
                setApplied(undefined);
                setOffset(0);
              }}
            >
              clear
            </button>
          )}
        </form>
        <span className="grow" />
        <a className="small" href={datasets.exportUrl(m.id, run.id, `out_${out.key}`)} download>
          Download CSV
        </a>
      </div>
      {err && <div className="err small">{err}</div>}
      {page && <DataTable caption={out.label} columns={labels} meta={metaFor} rows={page.rows} />}
      {page && (
        <div className="row small pager">
          <span className="grow muted">
            {page.total ? `${fmtNum(offset + 1)}–${fmtNum(Math.min(offset + LIMIT, page.total))} of ${fmtNum(page.total)}` : 'no rows'}
          </span>
          <button className="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
            Previous
          </button>
          <button className="small" disabled={offset + LIMIT >= page.total} onClick={() => setOffset(offset + LIMIT)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function Place({ m, run }: { m: Model; run: RunMeta }) {
  return <PlaceTables m={m} items={run.outputs} resetKey={run.id} ready={run.ok} onPlace={(doc, keys, cap) => datasets.place(doc, m.id, run.id, keys, cap)} />;
}

function SaveRecipe({ m, run }: { m: Model; run: RunMeta }) {
  const current = run.recipe ?? m.recipe;
  const [name, setName] = useState(() => m.meta?.name ?? '');
  const [note, setNote] = useState('');
  const [auto, setAuto] = useState(false);
  const [asNew, setAsNew] = useState(!current);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!m.canEdit) return null;
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await recipes.save({ id: asNew ? undefined : current?.id, dataset: m.id, run: run.id, name: name.trim() || 'Recipe', auto, note: note.trim() || undefined });
      setMsg({ ok: true, text: `Saved “${r.recipe.name}” v${r.recipe.current}. The next file with this layout will be recognised${auto ? ' and run automatically' : ''}.` });
      void m.reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="side-card">
      <h3 className="studio-h3">Save as a recipe</h3>
      <div className="muted small">Keeps these {plural(run.steps.length, 'step')} and the file's layout, to reuse on the next export of the same kind.</div>
      {current && (
        <div className="segmented small">
          <button className={!asNew ? 'active' : undefined} onClick={() => setAsNew(false)}>
            New version
          </button>
          <button className={asNew ? 'active' : undefined} onClick={() => setAsNew(true)}>
            New recipe
          </button>
        </div>
      )}
      <label className="field small">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <label className="field small">
        <span>Note (what changed)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. credit notes kept apart" />
      </label>
      <label className="field check small" title="Run the steps as soon as a matching file arrives; placing still waits for a person">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Run automatically on matching files
      </label>
      <button disabled={busy || !run.ok} onClick={() => void save()}>
        {busy ? 'Saving…' : asNew ? 'Save recipe' : 'Save new version'}
      </button>
      {msg && <div className={`small ${msg.ok ? 'green-text' : 'err'}`}>{msg.text}</div>}
    </section>
  );
}
