// The guided import studio: a full-screen workspace over the document. The library lists the files
// brought in and the saved recipes; a dataset opens on four tabs — Prepare (steps with the
// assistant), Results (outputs, checks, insights, placing, saving the recipe), Related (other
// files that share keys or layout, and merges) and Audit (every run, step by step, and every issue).
import { useEffect, useRef, useState } from 'react';
import { datasets, fmtBytes, recipes, type DatasetRow, type RecipeRow } from '../../api/datasets';
import { useStore } from '../../state/store';
import { Overlay } from '../overlay';
import { Progress, plural, useJob, when } from './common';
import { useDataset } from './model';
import { Prepare } from './Prepare';
import { Results } from './Results';
import { Related } from './Related';
import { Audit } from './Audit';

import { closeStudio as close, openStudio, type StudioTab as Tab } from './nav';
export { openStudio };
const TABS: { key: Tab; label: string }[] = [
  { key: 'prepare', label: 'Prepare' },
  { key: 'results', label: 'Results' },
  { key: 'related', label: 'Related data' },
  { key: 'audit', label: 'Audit' },
];


export function ImportStudio() {
  const studio = useStore((s) => s.studio);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input, textarea, select')) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!studio) return null;
  return (
    <Overlay>
      <div className="studio" role="dialog" aria-modal="true" aria-label="Guided import">
        {studio.dataset ? <DatasetView id={studio.dataset} tab={studio.tab ?? 'prepare'} run={studio.run} /> : <Library />}
      </div>
    </Overlay>
  );
}

function StudioHeader({ children, title }: { children?: React.ReactNode; title: React.ReactNode }) {
  return (
    <header className="studio-head">
      <div className="studio-title">{title}</div>
      <div className="grow">{children}</div>
      <button className="icon" onClick={close} title="Close (Esc)" aria-label="Close the guided import">
        ✕
      </button>
    </header>
  );
}

// ------------------------------------------------------------------ library
function Library() {
  const role = useStore((s) => s.me.role);
  const [list, setList] = useState<DatasetRow[] | null>(null);
  const [recipeList, setRecipes] = useState<RecipeRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const load = async () => {
    try {
      const [d, r] = await Promise.all([datasets.list(), recipes.list()]);
      setList(d.datasets);
      setRecipes(r.recipes);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      // keep reading progress and automatic runs fresh while files are being read
      setList((cur) => {
        if (cur?.some((d) => d.status === 'reading')) void load();
        return cur;
      });
    }, 2500);
    return () => window.clearInterval(t);
  }, []);
  const upload = async (f: File) => {
    setBusy(`Uploading ${f.name} (${fmtBytes(f.size)})…`);
    setErr(null);
    try {
      const r = await datasets.upload(f);
      openStudio(r.dataset.id, 'prepare');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const canEdit = role !== 'viewer';
  return (
    <>
      <StudioHeader title="Guided import" />
      <div className="studio-body library">
        {canEdit && (
          <div
            className={`dropzone${drag ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void upload(f);
            }}
          >
            <div className="dropzone-title">Bring in a file</div>
            <div className="muted">Excel (.xlsx), CSV or text exports — up to hundreds of thousands of rows. It is read on the server, profiled, and a first set of steps is proposed; nothing reaches the workbook until you place it.</div>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="primary" onClick={() => input.current?.click()} disabled={!!busy}>
                Choose a file…
              </button>
              <span className="muted small">or drop it here</span>
            </div>
            <input
              ref={input}
              type="file"
              hidden
              accept=".xlsx,.xlsm,.csv,.tsv,.txt"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void upload(f);
              }}
            />
            {busy && <div className="pill loading">{busy}</div>}
          </div>
        )}
        {err && <div className="err small">{err}</div>}
        <section className="library-section">
          <h2 className="studio-h2">Files brought in</h2>
          {!list && <div className="muted small">Loading…</div>}
          {list && !list.length && <div className="muted small">Nothing yet. Bring in a first file above.</div>}
          {list && list.length > 0 && (
            <div className="dataset-list">
              {list.map((d) => (
                <button key={d.id} className="dataset-row" onClick={() => openStudio(d.id, d.lastRun ? 'results' : 'prepare')}>
                  <div className="grow">
                    <div className="dataset-name">{d.name}</div>
                    <div className="muted small">
                      {d.file} · {fmtBytes(d.size)}
                      {d.status === 'ready' ? ` · ${plural(d.rows, 'row')}` : ''} · {d.createdBy}, {when(d.createdAt)}
                    </div>
                    {d.match && (
                      <div className="small">
                        <span className={`badge ${d.match.blocked ? 'amber' : ''}`}>
                          Recipe “{d.match.name}” · {Math.round(d.match.score * 100)}% match{d.match.ran ? ' · ran automatically' : ''}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="dataset-state small">
                    {d.status === 'reading' && <span className="pill loading">reading…</span>}
                    {d.status === 'failed' && <span className="pill error" title={d.error}>could not be read</span>}
                    {d.status === 'ready' && (d.lastRun ? <span className={`pill ${d.lastRun.ok ? '' : 'error'}`}>{d.lastRun.ok ? `run ${when(d.lastRun.at)}` : 'last run failed'}</span> : <span className="pill">prepared, not run</span>)}
                    {d.placements > 0 && <span className="muted">placed {plural(d.placements, 'time')}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="library-section">
          <h2 className="studio-h2">Recipes</h2>
          <div className="muted small">A recipe is the list of steps saved from a file. When a file with the same layout arrives it is recognised, the differences are shown, and the recipe is offered (or run straight away when it is set to run automatically). Nothing is placed in a workbook without a person.</div>
          {!recipeList.length && <div className="muted small">No recipes yet — run a file, then “Save as recipe” in its results.</div>}
          {recipeList.map((r) => (
            <RecipeCard key={r.id} r={r} canEdit={canEdit} onChange={load} />
          ))}
        </section>
      </div>
    </>
  );
}

function RecipeCard({ r, canEdit, onChange }: { r: RecipeRow; canEdit: boolean; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const v = r.versions[r.versions.length - 1];
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setErr(null);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="recipe-card">
      <div className="row">
        <div className="grow">
          <b>{r.name}</b> <span className="muted small">v{r.current} · {plural(v?.steps ?? 0, 'step')} · sheet “{v?.sheet}” · {plural(r.uses.length, 'use')}</span>
          {r.description && <div className="small">{r.description}</div>}
        </div>
        <label className="field check small" title="Run the recipe as soon as a file with this layout arrives (the results wait for a person to place them)">
          <input type="checkbox" checked={r.auto} disabled={!canEdit} onChange={(e) => void act(() => recipes.update(r.id, { auto: e.target.checked }))} /> run automatically
        </label>
        <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'History'}
        </button>
        {canEdit && (
          <button className="small danger" onClick={() => confirm(`Delete the recipe “${r.name}”? Files already prepared with it keep their steps.`) && void act(() => recipes.remove(r.id))}>
            Delete
          </button>
        )}
      </div>
      {err && <div className="err small">{err}</div>}
      {open && (
        <div className="recipe-history small">
          <div className="brief-h">Versions</div>
          {[...r.versions].reverse().map((x) => (
            <div key={x.version} className="row small">
              <span className="num">v{x.version}</span>
              <span className="grow">
                {x.note || 'saved'} — {plural(x.steps, 'step')}, {plural(x.columns, 'column')}
              </span>
              <span className="muted">
                {x.by}, {when(x.at)}
              </span>
            </div>
          ))}
          <div className="brief-h">Used on</div>
          {!r.uses.length && <div className="muted">not used yet</div>}
          {r.uses.map((u, i) => (
            <button key={i} className="link small row" onClick={() => openStudio(u.dataset, u.run ? 'results' : 'prepare', u.run)}>
              <span className="grow">{u.file}</span>
              <span className="muted">
                v{u.version} · {Math.round(u.score * 100)}% · {when(u.at)}
                {u.rows ? ` · ${plural(u.rows, 'row')}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one dataset
function DatasetView({ id, tab, run }: { id: string; tab: Tab; run?: string }) {
  const m = useDataset(id);
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => {
    if (run && m.meta && m.run?.id !== run && m.meta.runs.some((r) => r.id === run)) m.selectRun(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, m.meta?.id]);
  const setTab = (t: Tab) => useStore.setState({ studio: { dataset: id, tab: t } });
  const meta = m.meta;
  const reading = meta?.status === 'reading' || m.jobKind === 'read';
  return (
    <>
      <StudioHeader
        title={
          <span className="row">
            <button className="link" onClick={() => openStudio()} title="All files and recipes">
              Guided import
            </button>
            <span className="muted">/</span>
            {renaming !== null ? (
              <input
                autoFocus
                className="rename-input"
                value={renaming}
                aria-label="Name of this dataset"
                onChange={(e) => setRenaming(e.target.value)}
                onBlur={() => setRenaming(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renaming.trim()) void datasets.rename(id, renaming.trim()).then(() => m.reload()).finally(() => setRenaming(null));
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <button className="dataset-title" onClick={() => m.canEdit && meta && setRenaming(meta.name)} title={m.canEdit ? 'Rename' : undefined}>
                {meta?.name ?? '…'}
              </button>
            )}
          </span>
        }
      >
        {meta?.status === 'ready' && (
          <nav className="studio-tabs" aria-label="Guided import steps">
            {TABS.map((t, i) => (
              <button key={t.key} className={t.key === tab ? 'active' : undefined} aria-current={t.key === tab ? 'page' : undefined} onClick={() => setTab(t.key)} disabled={t.key !== 'prepare' && t.key !== 'audit' && !m.run}>
                <span className="tab-n">{i + 1}</span> {t.label}
              </button>
            ))}
          </nav>
        )}
      </StudioHeader>
      <div className="studio-body">
        {m.error && <div className="err">{m.error}</div>}
        {!meta && !m.error && <div className="muted">Loading…</div>}
        {meta && reading && <Reading m={m} />}
        {meta?.status === 'failed' && (
          <div className="studio-empty">
            <div className="err">The file could not be read: {meta.error}</div>
          </div>
        )}
        {meta?.status === 'ready' && !reading && (
          <>
            {tab === 'prepare' && <Prepare m={m} onRan={() => setTab('results')} />}
            {tab === 'results' && <Results m={m} onTab={setTab} />}
            {tab === 'related' && <Related m={m} />}
            {tab === 'audit' && <Audit m={m} />}
          </>
        )}
      </div>
    </>
  );
}

function Reading({ m }: { m: ReturnType<typeof useDataset> }) {
  // a read job started elsewhere (the upload) is found again from the dataset's active jobs
  const [jid, setJid] = useState<string | null>(null);
  useEffect(() => {
    if (m.job) return;
    let stop = false;
    void datasets.get(m.id).then((d) => {
      const j = d.jobs.find((x) => x.kind === 'read' && (x.status === 'queued' || x.status === 'running'));
      if (!stop && j) setJid(j.id);
      if (!stop && !j) void m.reload();
    });
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id]);
  const own = useJob(m.job ? null : jid, () => void m.reload());
  const job = m.job ?? own;
  return (
    <div className="studio-empty">
      <div className="reading-card">
        <b>Reading {m.meta?.file}</b>
        <div className="muted small">Every row is streamed into a private database for this client, then each column is profiled: types, blanks, formats, codes and names, the period it covers. A first set of steps is proposed from what is found.</div>
        <Progress job={job} label="Reading" />
        {!job && <div className="pill loading">starting…</div>}
      </div>
    </div>
  );
}
