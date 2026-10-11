// "How was this made?" — the right-click view of a table placed by a guided import: the file it came
// from, each step from the raw rows to this table (with its reason and counts), the checks, and for
// one row its original values in the file, its cleaned values and anything flagged on it.
import { useEffect, useState } from 'react';
import { datasets, fmtBytes, fmtNum, type Lineage } from '../../api/datasets';
import { rangeValues } from '../../engine/book';
import { getState, useStore } from '../../state/store';
import { Overlay } from '../overlay';
import { DataTable, StageChip, plural, when } from './common';
import { openStudio } from './nav';

/** Keep the list of this document's imported tables fresh (on open, and after a placement). */
export function useImportedTables() {
  const fileId = useStore((s) => s.fileId);
  const tableCount = useStore((s) => s.tables.size);
  useEffect(() => {
    let stop = false;
    const load = () => {
      if (!fileId) {
        useStore.setState({ importedTables: new Map() });
        return;
      }
      datasets
        .lineageTables(fileId)
        .then((r) => !stop && useStore.setState({ importedTables: new Map(r.tables.map((t) => [t.table, t])) }))
        .catch(() => !stop && useStore.setState({ importedTables: new Map() }));
    };
    load();
    window.addEventListener('gw-imported', load);
    return () => {
      stop = true;
      window.removeEventListener('gw-imported', load);
    };
  }, [fileId, tableCount]);
}

/** Open the lineage of a table, for the row of the sheet that was right-clicked (if a data row). */
export function openLineage(table: number, sheetRow?: number) {
  const meta = getState().tables.get(table);
  const head = meta?.header_rows ?? 1;
  let row: number | undefined;
  let source: number | undefined;
  if (meta && sheetRow !== undefined && sheetRow >= head) {
    row = sheetRow - head;
    // a placed detail table carries "Row in file": use it, so a sorted table still points at the right row
    try {
      const header = rangeValues(table, head - 1, 0, head - 1, meta.cols - 1)[0] ?? [];
      // ("Row in <other file>" on the documents of a comparison found only in the other file)
      const at = header.findIndex((v) => typeof v === 'string' && v.startsWith('Row in '));
      if (at >= 0) {
        const v = rangeValues(table, sheetRow, at, sheetRow, at)[0]?.[0];
        if (typeof v === 'number' && v > 0) source = v;
      }
    } catch {
      /* the position is enough */
    }
  }
  useStore.setState({ lineage: { table, row, source } });
}

export function LineageDialog() {
  const target = useStore((s) => s.lineage);
  const fileId = useStore((s) => s.fileId);
  const [data, setData] = useState<Lineage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setErr(null);
    setOpen(null);
    if (!target || !fileId) return;
    let stop = false;
    datasets
      .lineage(fileId, target.table, target.row, target.source)
      .then((r) => !stop && setData(r.lineage))
      .catch((e) => !stop && setErr((e as Error).message));
    return () => {
      stop = true;
    };
  }, [target?.table, target?.row, target?.source, fileId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useStore.setState({ lineage: null });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!target) return null;
  const close = () => useStore.setState({ lineage: null });
  const row = data?.row;
  // identifier columns are shown exactly as stored: no grouping or rounding of codes and numbers
  const ids = new Set((data?.output.columns ?? []).filter((c) => c.type === 'identifier').map((c) => c.key));
  return (
    <Overlay>
      <div className="modal-backdrop" onPointerDown={close}>
        <div className="modal lineage" role="dialog" aria-modal="true" aria-label="How this table was made" onPointerDown={(e) => e.stopPropagation()}>
          <div className="row">
            <h2 className="studio-h2 grow">How was this made?</h2>
            <button className="icon" onClick={close} aria-label="Close">
              ✕
            </button>
          </div>
          {err && <div className="err small">{err}</div>}
          {!data && !err && <div className="pill loading">tracing…</div>}
          {data && (
            <>
              <div className="lineage-chain">
                <div className="chain-node">
                  <div className="muted small">File</div>
                  <b>{data.dataset.file}</b>
                  <div className="small muted">
                    {fmtBytes(data.dataset.size)}
                    {data.dataset.sheet ? ` · sheet “${data.dataset.sheet}”` : ''} · {data.dataset.createdBy}, {when(data.dataset.createdAt)}
                  </div>
                  {data.dataset.sha256 && (
                    <div className="small muted mono" title="The file's fingerprint: the same file always gives the same value">
                      SHA-256 {data.dataset.sha256.slice(0, 16)}…
                    </div>
                  )}
                </div>
                <div className="chain-arrow" aria-hidden>
                  →
                </div>
                <div className="chain-node">
                  <div className="muted small">Run</div>
                  <b>{plural(data.run.rows, 'row')}</b>
                  <div className="small muted">
                    {data.run.by}, {when(data.run.at)}
                    {data.run.recipe ? ` · recipe v${data.run.recipe.version}` : ''}
                  </div>
                </div>
                <div className="chain-arrow" aria-hidden>
                  →
                </div>
                {data.merge && (
                  <>
                    <div className="chain-node">
                      <div className="muted small">{data.merge.kind === 'compare' ? 'Compared with' : data.merge.kind === 'reconcile' ? 'Reconciled with' : 'Appended to'}</div>
                      <b>{data.merge.otherName}</b>
                      <div className="small muted">
                        {data.merge.keyLabels ? `on ${data.merge.keyLabels.a} = ${data.merge.keyLabels.b} · ` : ''}
                        {data.merge.by}, {when(data.merge.at)}
                      </div>
                    </div>
                    <div className="chain-arrow" aria-hidden>
                      →
                    </div>
                  </>
                )}
                <div className="chain-node">
                  <div className="muted small">This table</div>
                  <b>{data.placement.name}</b>
                  <div className="small muted">
                    {fmtNum(data.placement.rows)} of {fmtNum(data.output.rows)} rows{data.placement.truncated ? ' (cut)' : ''} · placed by {data.placement.by}, {when(data.placement.at)}
                  </div>
                </div>
              </div>

              {data.merge && data.merge.notes.length > 0 && (
                <section className="lineage-merge">
                  <h3 className="studio-h3">What the {data.merge.kind === 'compare' ? 'comparison' : data.merge.kind === 'reconcile' ? 'reconciliation' : 'append'} found</h3>
                  <ul className="small">
                    {data.merge.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </section>
              )}

              {row && (
                <section className="lineage-row">
                  <h3 className="studio-h3">{row.sourceRow ? `This row — row ${fmtNum(row.sourceRow)} of ${row.file ? `“${row.file}”` : 'the file'}` : row.group ? 'This row — a summary of' : 'This row'}</h3>
                  {row.original && row.cleaned && !data.merge && <BeforeAfter original={row.original} cleaned={row.cleaned} ids={ids} />}
                  {row.original && data.merge && (
                    <DataTable caption={`The line in ${row.file ? `“${row.file}”` : 'the file'}`} columns={['Column in the file', 'In the file']} rows={row.original.map((o) => [o.header, verbatim(o.value)])} maxHeight={240} />
                  )}
                  {row.cleaned && (!row.original || data.merge) && (
                    <DataTable caption={data.merge ? 'The row in this table' : 'The row'} columns={['Column', 'Value']} rows={row.cleaned.map((c) => [c.label, ids.has(c.key) ? verbatim(c.value) : c.value])} maxHeight={220} />
                  )}
                  {row.group && (
                    <div className="small">
                      {row.group.map((g) => `${g.label} = ${String(g.value ?? '(blank)')}`).join(' · ')}
                      {row.members && (
                        <>
                          {' '}
                          — made of {plural(row.members.count, 'row')} of the clean table
                          {row.members.sampleRows.length ? ` (rows ${row.members.sampleRows.slice(0, 8).map((n) => fmtNum(n)).join(', ')}${row.members.count > 8 ? ', …' : ''} of the file)` : ''}
                        </>
                      )}
                    </div>
                  )}
                  {row.issues.length > 0 && (
                    <div className="amber-text small">
                      Flagged: {row.issues.map((i) => `${i.kind}${i.col ? ` in ${i.col}` : ''}${i.detail ? ` (${i.detail})` : ''}`).join('; ')}
                    </div>
                  )}
                </section>
              )}

              <section>
                <h3 className="studio-h3">{data.merge ? `Steps that prepared “${data.dataset.file}” for the ${data.merge.kind === 'compare' ? 'comparison' : 'merge'}` : 'Steps, from the file to this table'}</h3>
                <ol className="lineage-steps">
                  {data.steps.map((s, i) => (
                    <li key={s.id} className={s.status === 'failed' ? 'failed' : s.status === 'skipped' ? 'off' : undefined}>
                      <button className="lineage-step" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
                        <span className="step-n">{i + 1}</span>
                        <StageChip stage={s.stage} />
                        <span className="grow">{s.text}</span>
                        <span className="small muted num">
                          {s.changed ? `${fmtNum(s.changed)} changed ` : ''}
                          {s.rejected ? `${fmtNum(s.rejected)} removed ` : ''}
                          {s.issues ? `${fmtNum(s.issues)} flagged` : ''}
                        </span>
                      </button>
                      {open === s.id && (
                        <div className="step-detail">
                          {s.why && <div className="small">Why: {s.why}</div>}
                          <div className="small muted">
                            {s.by === 'assistant' ? 'Proposed by the assistant' : s.by === 'person' ? 'Added by a person' : 'Proposed from the profile'} · {plural(s.rowsIn, 'row')} in → {plural(s.rowsOut, 'row')} out
                          </div>
                          {s.notes.map((n, k) => (
                            <div key={k} className="small">
                              {n}
                            </div>
                          ))}
                          {s.examples.length > 0 && <DataTable caption="Examples" columns={['Row in file', 'Column', 'Before', 'After']} rows={s.examples.slice(0, 6).map((e) => [e.row, e.column ?? '', e.before ?? '', e.after ?? ''])} maxHeight={180} />}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </section>

              {data.checks.length > 0 && (
                <section>
                  <h3 className="studio-h3">Checks on this run</h3>
                  {data.checks.map((c, i) => (
                    <div key={i} className={`check-row ${c.failing ? c.severity : 'ok'}`}>
                      <span className="check-mark" aria-hidden>
                        {c.failing ? '!' : '✓'}
                      </span>
                      <span className="grow small">{c.label}</span>
                      <span className="small num">{c.failing ? `${fmtNum(c.failing)} of ${fmtNum(c.total)}` : 'passed'}</span>
                    </div>
                  ))}
                </section>
              )}

              <div className="row">
                <span className="grow" />
                <a className="button small" href={datasets.sourceUrl(data.dataset.id)} download>
                  Download the original file
                </a>
                <button
                  className="primary small"
                  onClick={() => {
                    close();
                    openStudio(data.dataset.id, 'audit', data.run.id);
                  }}
                >
                  Open the full audit
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/** A value as it is in the file: numbers without grouping or rounding (a document number 718439
 *  is not 718,439) — shown as text so the table does not format it. */
function verbatim(v: unknown): unknown {
  return typeof v === 'number' || typeof v === 'bigint' ? String(v) : v;
}

/** A line as it arrived next to the same line after the steps, column by column. Columns are
 *  paired by their key in the steps (a rename keeps it), never by position: a dropped column
 *  is shown as not kept and a column the steps added is listed after the file's columns. */
function BeforeAfter({ original, cleaned, ids }: { original: { header: string; key: string; value: unknown }[]; cleaned: { label: string; key: string; value: unknown }[]; ids: Set<string> }) {
  const byKey = new Map(cleaned.map((c) => [c.key, c]));
  const fileKeys = new Set(original.map((o) => o.key));
  const rows: { name: string; before: unknown; after: unknown; paired: boolean }[] = [
    ...original.map((o) => {
      const c = byKey.get(o.key);
      // a number the steps left as it was is shown the same way on both sides (738739, not 738,739)
      const same = !!c && typeof c.value === 'number' && Number(o.value) === c.value;
      return { name: c && c.label !== o.header ? `${o.header} → ${c.label}` : o.header, before: verbatim(o.value), after: c ? (ids.has(c.key) || same ? verbatim(c.value) : c.value) : '(not in this table)', paired: !!c };
    }),
    ...cleaned.filter((c) => !fileKeys.has(c.key)).map((c) => ({ name: `${c.label} (added by the steps)`, before: '', after: ids.has(c.key) ? verbatim(c.value) : c.value, paired: false })),
  ];
  return (
    <DataTable
      caption="The row in the file and after the steps"
      columns={['Column in the file', 'In the file', 'After the steps']}
      rows={rows.map((r) => [r.name, r.before, r.after])}
      highlight={(r, c) => (c === 2 && rows[r]?.paired && String(rows[r].before ?? '') !== String(rows[r].after ?? '') ? 'changed' : undefined)}
      maxHeight={280}
    />
  );
}
