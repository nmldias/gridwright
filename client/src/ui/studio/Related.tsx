// Related data: other files of this client that share keys, layout or period with this one —
// with suggested analyses (append the next period, reconcile two sources on a shared key) and
// the results of merges already made.
import { useEffect, useState } from 'react';
import { datasets, fmtNum, type DatasetMeta, type Page, type Relation, type Suggestion } from '../../api/datasets';
import { DataTable, Progress, ROW_META, plural, when } from './common';
import { openStudio } from './nav';
import { PlaceTables } from './Place';
import type { Model } from './model';

const LAYOUT: Record<Relation['layout'], string> = { same: 'same layout', similar: 'similar layout', different: 'different layout' };
const ORDER: Record<Relation['period']['order'], string> = { before: 'an earlier period', after: 'a later period', overlap: 'an overlapping period', unknown: 'an unknown period' };

export function Related({ m }: { m: Model }) {
  const [rel, setRel] = useState<Relation[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [mergeErr, setMergeErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    setRel(null);
    datasets
      .related(m.id)
      .then((r) => !stop && setRel(r.relations))
      .catch((e) => !stop && setErr((e as Error).message));
    return () => {
      stop = true;
    };
  }, [m.id, m.meta?.runs.length]);
  const merge = async (r: Relation, s: Suggestion) => {
    if (s.kind === 'compare' && !s.key) return openStudio(r.other, 'results');
    setMergeErr(null);
    setMerging(`${r.other}:${s.kind}`);
    try {
      const { job } = await datasets.merge(m.id, s.kind, r.other, s.key);
      m.setJob(job.id, 'combine', (j) => {
        setMerging(null);
        if (j.status === 'failed') setMergeErr(j.error ?? 'the merge failed');
      });
    } catch (e) {
      setMerging(null);
      setMergeErr((e as Error).message);
    }
  };
  const merges = m.meta?.merges ?? [];
  return (
    <div className="related">
      <section>
        <h2 className="studio-h2">Files related to this one</h2>
        <div className="muted small">Compared on column names and types, on the values of code columns (customers, documents, products) and on the period each file covers. Only this client's files are compared.</div>
        {err && <div className="err small">{err}</div>}
        {!rel && !err && <div className="pill loading">comparing with the other files…</div>}
        {rel && !rel.length && (
          <div className="muted small">
            No related files yet. Bring in the next export of the same report, a customer list, payments or a ledger extract — anything sharing customer or document codes — and it will show here with a suggested analysis.
          </div>
        )}
        {rel?.map((r) => (
          <article key={r.other} className="relation-card">
            <div className="row">
              <button className="link grow" onClick={() => openStudio(r.other, 'results')}>
                <b>{r.name}</b>
              </button>
              <span className={`badge ${r.layout === 'same' ? '' : 'amber'}`}>{LAYOUT[r.layout]}</span>
            </div>
            <div className="small muted">
              {Math.round(r.labelOverlap * 100)}% of the column names in common · covers {ORDER[r.period.order]}
              {r.period.b[0] ? ` (${r.period.b[0]} to ${r.period.b[1]})` : ''}
            </div>
            {r.keys.length > 0 && (
              <DataTable
                caption="Shared keys"
                columns={['Here', 'There', 'Values in common', 'Of here', 'Of there']}
                rows={r.keys.slice(0, 5).map((k) => [k.aLabel, k.bLabel, k.common, k.aDistinct, k.bDistinct])}
                maxHeight={180}
              />
            )}
            <div className="suggestions">
              {r.suggestions.map((s, i) => (
                <div key={i} className="suggestion">
                  <div className="grow">
                    <b className="small">{s.title}</b>
                    <div className="small">{s.text}</div>
                  </div>
                  {m.canEdit && (
                    <button className={s.kind === 'compare' && !s.key ? 'small' : 'primary small'} disabled={!!merging} onClick={() => void merge(r, s)}>
                      {s.kind === 'append' ? 'Append' : s.kind === 'reconcile' ? 'Reconcile' : s.key ? 'Compare' : 'Open'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </article>
        ))}
        {merging && <Progress job={m.job} label="Merging" />}
        {mergeErr && <div className="err small">{mergeErr}</div>}
      </section>
      {merges.length > 0 && (
        <section>
          <h2 className="studio-h2">Merges</h2>
          {/* newest first, as stored */}
          {merges.map((x, i) => (
            <MergeCard key={x.id} m={m} merge={x} first={i === 0} />
          ))}
        </section>
      )}
    </div>
  );
}

function MergeCard({ m, merge, first }: { m: Model; merge: DatasetMeta['merges'][number]; first: boolean }) {
  const [open, setOpen] = useState<string | null>(merge.result.tables[0]?.key ?? null);
  const [page, setPage] = useState<Page | null>(null);
  // the latest merge is shown in full; earlier ones as a summary, opened on demand
  const [expanded, setExpanded] = useState(first);
  // a newer merge takes the place of this one: it folds away
  useEffect(() => setExpanded(first), [first]);
  useEffect(() => {
    if (!open || !expanded) return;
    let stop = false;
    void datasets.mergeTable(m.id, merge.id, open, 0, 50).then((p) => !stop && setPage(p));
    return () => {
      stop = true;
    };
  }, [m.id, merge.id, open, expanded]);
  const t = merge.result.tables.find((x) => x.key === open);
  return (
    <article className={`merge-card${expanded ? '' : ' collapsed'}`} data-merge={merge.id}>
      <div className="row">
        <b className="grow">
          {merge.kind === 'append' ? 'Appended' : merge.kind === 'compare' ? 'Compared' : 'Reconciled'} with “{merge.otherName}”
        </b>
        <span className="muted small">
          {merge.by}, {when(merge.at)} · {plural(merge.result.rows, 'row')}
        </span>
        <button className="link small" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>
      {merge.key && (
        <div className="small muted">
          matched on {merge.keyLabels ? `${merge.keyLabels.a} here = ${merge.keyLabels.b} there` : `${merge.key.a} = ${merge.key.b}`}
        </div>
      )}
      {(expanded ? merge.result.notes : merge.result.notes.slice(0, 1)).map((n, i) => (
        <div key={i} className="small">
          {n}
        </div>
      ))}
      {expanded && (
        <>
          <div className="output-tabs">
            {merge.result.tables.map((x) => (
              <button key={x.key} className={x.key === open ? 'active' : undefined} onClick={() => setOpen(x.key)}>
                {x.label} <span className="muted small">{fmtNum(x.rows)}</span>
              </button>
            ))}
          </div>
          {page && t && <DataTable caption={t.label} columns={page.columns.map((c) => (c === '_row' ? (t.key === 'only_there' ? `Row in ${merge.otherName}` : 'Row in file') : (t.columns.find((x) => x.key === c)?.label ?? c)))} meta={page.columns.map((c) => (c === '_row' ? ROW_META : t.columns.find((x) => x.key === c)))} rows={page.rows} maxHeight={320} />}
          <PlaceTables
            m={m}
            items={merge.result.tables.map((x) => ({ key: x.key, label: x.label, rows: x.rows, place: x.key !== 'changes' || x.rows <= 10_000 }))}
            resetKey={merge.id}
            title={merge.kind === 'compare' ? 'Place the comparison in a workbook' : merge.kind === 'reconcile' ? 'Place the reconciliation in a workbook' : 'Place the series in a workbook'}
            help={`Each table becomes a sheet table named after “${merge.otherName}”; a right-click on it shows what was matched and the steps behind it.`}
            name={`${m.meta?.name ?? 'Import'} vs ${merge.otherName}`}
            onPlace={(doc, keys, cap) => datasets.place(doc, m.id, undefined, keys, cap, merge.id)}
          />
        </>
      )}
    </article>
  );
}
