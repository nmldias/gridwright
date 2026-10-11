// Audit: what happened to this file, in order — read, each run (every step with its counts,
// reasons and examples), each placement and merge — and every row a step flagged or removed.
import { useEffect, useMemo, useState } from 'react';
import { datasets, fmtBytes, fmtNum, type IssueRow, type RunMeta } from '../../api/datasets';
import { DataTable, StageChip, plural, when } from './common';
import type { Model } from './model';
import { stageOf } from './Prepare';

export function Audit({ m }: { m: Model }) {
  const meta = m.meta!;
  const run = m.run;
  const events = useMemo(() => {
    const e: { at: string; text: string; by: string; run?: string }[] = [{ at: meta.createdAt, by: meta.createdBy, text: `Brought in ${meta.file} (${fmtBytes(meta.size)}, ${plural(meta.sheets.length, 'sheet')})` }];
    for (const r of meta.runs) e.push({ at: r.at, by: r.by, run: r.id, text: `${r.ok ? 'Ran' : 'Run failed:'} ${plural(r.rows, 'row')}${r.recipe ? ` with recipe v${r.recipe.version}` : ''}` });
    for (const p of meta.placements) e.push({ at: p.at, by: p.by, run: p.run, text: `Placed ${p.tables.map((t) => `“${t.name}” (${fmtNum(t.rows)}${t.truncated ? ', cut' : ''})`).join(', ')} in a workbook` });
    for (const x of meta.merges) e.push({ at: x.at, by: x.by, text: `${x.kind === 'append' ? 'Appended' : x.kind === 'compare' ? 'Compared' : 'Reconciled'} with “${x.otherName}” → ${plural(x.result.rows, 'row')}` });
    if (meta.draft) e.push({ at: meta.draft.at, by: meta.draft.by, text: `Steps last edited (${plural(meta.draft.steps.length, 'step')})` });
    return e.sort((a, b) => b.at.localeCompare(a.at));
  }, [meta]);
  return (
    <div className="audit">
      <aside className="audit-side">
        <section className="side-card">
          <h3 className="studio-h3">Source</h3>
          <div className="small">
            <b>{meta.file}</b>
          </div>
          <div className="small muted">
            {fmtBytes(meta.size)} · {meta.sheets.map((s) => `“${s.name}” ${fmtNum(s.rows)}×${s.cols}`).join(', ')}
          </div>
          <div className="small muted">
            brought in by {meta.createdBy}, {when(meta.createdAt)}
          </div>
          <a className="small" href={datasets.sourceUrl(m.id)} download>
            Download the original file
          </a>
        </section>
        <section className="side-card">
          <h3 className="studio-h3">Activity</h3>
          <ol className="activity">
            {events.map((e, i) => (
              <li key={i}>
                <div className="small">{e.text}</div>
                <div className="small muted">
                  {e.by} · {when(e.at)}
                  {e.run && e.run !== run?.id && (
                    <>
                      {' · '}
                      <button className="link small" onClick={() => m.selectRun(e.run!)}>
                        show this run
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </aside>
      <div className="audit-main">{run ? <RunRecord m={m} run={run} /> : <div className="muted">Not run yet. The steps and their reasons are recorded with every run.</div>}</div>
    </div>
  );
}

function RunRecord({ m, run }: { m: Model; run: RunMeta }) {
  const [step, setStep] = useState<string | undefined>();
  const text = useMemo(() => new Map((run.described ?? []).map((d) => [d.id, d.text])), [run]);
  const results = useMemo(() => new Map(run.results.map((r) => [r.id, r])), [run]);
  const sel = step ? results.get(step) : undefined;
  const selStep = step ? run.steps.find((s) => s.id === step) : undefined;
  return (
    <>
      <div className="row">
        <h2 className="studio-h2 grow">
          Run of {when(run.at)} by {run.by}
        </h2>
        <span className="muted small">
          {plural(run.rows, 'row')} · {(run.ms / 1000).toFixed(1)} s{run.recipe ? ` · recipe v${run.recipe.version}` : ''}
        </span>
      </div>
      <div className="studio-table-wrap">
        <table className="studio-table audit-steps">
          <caption className="sr-only">Every step of this run</caption>
          <thead>
            <tr>
              <th>#</th>
              <th>Stage</th>
              <th>Step</th>
              <th>By</th>
              <th className="num">Rows in</th>
              <th className="num">Rows out</th>
              <th className="num">Changed</th>
              <th className="num">Removed</th>
              <th className="num">Flagged</th>
              <th className="num">ms</th>
            </tr>
          </thead>
          <tbody>
            {run.steps.map((s, i) => {
              const r = results.get(s.id);
              return (
                <tr key={s.id} className={`clickable${step === s.id ? ' selected' : ''}${r?.status === 'failed' ? ' failed' : ''}${s.enabled === false ? ' off' : ''}`} onClick={() => setStep(step === s.id ? undefined : s.id)}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <StageChip stage={stageOf(s)} />
                  </td>
                  <td>
                    <div>{text.get(s.id) ?? s.type}</div>
                    {s.why && <div className="muted small">{s.why}</div>}
                    {r?.status === 'failed' && <div className="err small">{r.error}</div>}
                    {r?.status === 'skipped' && <div className="muted small">turned off</div>}
                  </td>
                  <td className="small">{s.by === 'assistant' ? 'assistant' : s.by === 'person' ? 'person' : 'rule'}</td>
                  <td className="num">{fmtNum(r?.rowsIn ?? '')}</td>
                  <td className="num">{fmtNum(r?.rowsOut ?? '')}</td>
                  <td className="num">{r?.changed ? fmtNum(r.changed) : ''}</td>
                  <td className="num">{r?.rejected ? fmtNum(r.rejected) : ''}</td>
                  <td className="num">{r?.issues ? fmtNum(r.issues) : ''}</td>
                  <td className="num muted">{r?.ms ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sel && selStep && (
        <div className="step-detail">
          <b>{text.get(selStep.id) ?? selStep.type}</b>
          {sel.notes.map((n, i) => (
            <div key={i} className="small">
              {n}
            </div>
          ))}
          {sel.examples.length > 0 && <DataTable caption="Examples" columns={['Row in file', 'Column', 'Before', 'After', 'Note']} rows={sel.examples.slice(0, 12).map((e) => [e.row, e.column ?? '', e.before ?? '', e.after ?? '', e.note ?? ''])} maxHeight={220} />}
        </div>
      )}
      <Issues m={m} run={run} step={step} label={step ? text.get(step) : undefined} />
    </>
  );
}

function Issues({ m, run, step, label }: { m: Model; run: RunMeta; step?: string; label?: string }) {
  const [data, setData] = useState<{ total: number; removed: number; rows: IssueRow[] } | null>(null);
  const [offset, setOffset] = useState(0);
  const LIMIT = 100;
  useEffect(() => setOffset(0), [step, run.id]);
  useEffect(() => {
    let stop = false;
    void datasets.issues(m.id, run.id, step, offset, LIMIT).then((d) => !stop && setData(d));
    return () => {
      stop = true;
    };
  }, [m.id, run.id, step, offset]);
  return (
    <section className="issues">
      <div className="row">
        <h3 className="studio-h3 grow">{step ? `Rows flagged or removed by “${label ?? step}”` : 'Every row flagged or removed'}</h3>
        {data && (
          <span className="muted small">
            {plural(data.total, 'entry', 'entries')}
            {!step ? ` · ${plural(data.removed, 'row')} removed in all` : ''}
          </span>
        )}
      </div>
      {data && (
        <DataTable
          caption="Flagged and removed rows"
          columns={['Row in file', 'Step', 'What', 'Column', 'Value', 'Detail']}
          rows={data.rows.map((r) => [r.row ?? '', r.step, `${r.kind}${r.severity && r.severity !== 'info' ? ` (${r.severity})` : ''}`, r.col ?? '', r.value ?? '', r.detail ?? ''])}
          empty="Nothing flagged or removed"
          maxHeight={360}
        />
      )}
      {data && data.total > LIMIT && (
        <div className="row small pager">
          <span className="grow muted">
            {fmtNum(offset + 1)}–{fmtNum(Math.min(offset + LIMIT, data.total))} of {fmtNum(data.total)}
          </span>
          <button className="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
            Previous
          </button>
          <button className="small" disabled={offset + LIMIT >= data.total} onClick={() => setOffset(offset + LIMIT)}>
            Next
          </button>
        </div>
      )}
    </section>
  );
}
