// Prepare: the steps from the raw file to clean, structured tables, built with the assistant.
// Every change is previewed at once on a sample; "Run on every row" makes the real run.
import { Md } from './Md';
import { useEffect, useMemo, useRef, useState } from 'react';
import { datasets, fmtNum, type AssistReply, type LayoutDiff, type Step, type StepResult } from '../../api/datasets';
import { DataTable, Progress, STAGES, StageChip, plural } from './common';
import type { Model } from './model';

const STAGE_OF: Record<string, string> = {
  header: 'read', trim: 'clean', drop_rows: 'clean', convert: 'clean', drop_column: 'clean', rename: 'clean', signed: 'clean', derive: 'clean', map_values: 'clean', canonical: 'clean', classify: 'clean', filter: 'clean',
  duplicates: 'check', check: 'check', exceptions: 'check', table: 'structure', pivot: 'analyse', ageing: 'analyse',
};
const TYPE_LABEL: Record<string, string> = {
  header: 'Read the table', trim: 'Tidy text', drop_rows: 'Remove rows', convert: 'Convert values', drop_column: 'Drop a column', rename: 'Rename', signed: 'Sign amounts', derive: 'New column', map_values: 'Map values',
  canonical: 'One name per code', classify: 'Classify', filter: 'Keep rows', duplicates: 'Duplicates', check: 'Check', exceptions: 'Exceptions', table: 'Table', pivot: 'Pivot', ageing: 'Ageing',
};
export const stageOf = (s: Step) => (s.stage as string | undefined) ?? STAGE_OF[s.type] ?? 'clean';

const PROMPTS = [
  'What did you find in this file?',
  'Explain these steps in plain words',
  'Are there duplicate documents?',
  'Keep invoices and credit notes apart',
  'Which customers carry the most?',
  'What should I check before trusting the totals?',
];

export function Prepare({ m, onRan }: { m: Model; onRan: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<string>('clean');
  const [runErr, setRunErr] = useState<string | null>(null);
  const described = useMemo(() => new Map((m.preview?.described ?? []).map((d) => [d.id, d])), [m.preview]);
  const results = useMemo(() => new Map((m.preview?.results ?? []).map((r) => [r.id, r])), [m.preview]);
  // data rows: the sheet's rows below the header row
  const head = m.steps[0] as { sheet?: number; row?: number } | undefined;
  const total = Math.max(0, (m.meta?.sheets.find((s) => head && s.index === head.sheet)?.rows ?? 0) - (head?.row ?? 1));
  const failed = m.preview?.results.find((r) => r.status === 'failed');
  const running = m.jobKind === 'run';
  const runAll = async () => {
    setRunErr(null);
    try {
      await m.runAll((j) => (j.status === 'done' && (j.result as { ok?: boolean } | undefined)?.ok !== false ? onRan() : setRunErr(j.error ?? 'the run stopped at a failing step — see Audit')));
    } catch (e) {
      setRunErr((e as Error).message);
    }
  };
  const sel = selected ? m.steps.find((s) => s.id === selected) : null;
  return (
    <div className="prepare">
      <aside className="prepare-steps" aria-label="Steps">
        <Findings m={m} />
        <div className="row">
          <h2 className="studio-h2 grow">Steps</h2>
          {m.undo && (
            <button className="link small" onClick={m.undo} title="Undo the last change to the steps">
              Undo
            </button>
          )}
        </div>
        {STAGES.map((st) => {
          const list = m.steps.map((s, i) => ({ s, i })).filter(({ s }) => stageOf(s) === st.key);
          if (!list.length) return null;
          return (
            <div key={st.key} className="stage-group">
              <div className="stage-head" title={st.hint}>
                <StageChip stage={st.key} /> <span className="muted small">{st.hint}</span>
              </div>
              {list.map(({ s, i }) => (
                <StepRow
                  key={s.id}
                  step={s}
                  index={i}
                  text={described.get(s.id)?.text}
                  result={results.get(s.id)}
                  selected={selected === s.id}
                  canEdit={m.canEdit}
                  onSelect={() => setSelected(selected === s.id ? null : s.id)}
                  onToggle={() => m.setSteps(m.steps.map((x) => (x.id === s.id ? { ...x, enabled: x.enabled === false } : x)))}
                  onRemove={i > 0 ? () => m.setSteps(m.steps.filter((x) => x.id !== s.id)) : undefined}
                  onMove={(d) => {
                    const j = i + d;
                    if (j < 1 || j >= m.steps.length) return;
                    const next = [...m.steps];
                    [next[i], next[j]] = [next[j], next[i]];
                    m.setSteps(next);
                  }}
                />
              ))}
            </div>
          );
        })}
      </aside>

      <section className="prepare-data" aria-label="Data">
        <div className="row data-bar">
          <div className="segmented" role="tablist" aria-label="What to show">
            <button role="tab" aria-selected={view === 'raw'} className={view === 'raw' ? 'active' : undefined} onClick={() => setView('raw')}>
              File as it arrived
            </button>
            <button role="tab" aria-selected={view === 'clean'} className={view === 'clean' ? 'active' : undefined} onClick={() => setView('clean')}>
              Cleaned
            </button>
            {(m.preview?.outputs ?? []).map((o) => (
              <button key={o.key} role="tab" aria-selected={view === o.key} className={view === o.key ? 'active' : undefined} onClick={() => setView(o.key)} title={`${o.role}: ${plural(o.rows, 'row')} in the sample`}>
                {o.label}
              </button>
            ))}
          </div>
          <span className="grow" />
          {m.previewing && <span className="pill loading">previewing…</span>}
        </div>
        {sel && <StepDetail step={sel} result={results.get(sel.id)} text={described.get(sel.id)?.text} onClose={() => setSelected(null)} />}
        {m.previewError && <div className="err small">Preview: {m.previewError}</div>}
        {failed && (
          <div className="err small">
            Step “{described.get(failed.id)?.text ?? failed.id}” failed: {failed.error}. The steps after it did not run.
          </div>
        )}
        <DataPane m={m} view={view} />
        <div className="run-bar">
          <div className="grow small muted">
            {m.preview?.sample ? `Preview on the first ${plural(m.preview.sample, 'row')} of ${plural(total, 'row')} · ${m.preview.ms} ms` : m.canEdit ? 'Preview runs after every change' : 'You can view this file; preparing it needs an editor'}
          </div>
          {runErr && <span className="err small">{runErr}</span>}
          {m.canEdit && (
            <button className="primary" disabled={running || !!failed || !m.steps.length} onClick={() => void runAll()} title={failed ? 'Fix the failing step first' : 'Run every step on every row, then see the results'}>
              Run on all {plural(total, 'row')}
            </button>
          )}
        </div>
        {running && <Progress job={m.job} label="Running every step on every row" />}
      </section>

      <Assistant m={m} focus={selected ?? undefined} />
    </div>
  );
}

// ------------------------------------------------------------------ findings and the recipe match
function Findings({ m }: { m: Model }) {
  const [open, setOpen] = useState(true);
  const [diff, setDiff] = useState<LayoutDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const match = m.meta?.match;
  const findings = m.proposal?.findings ?? [];
  const usingMatch = match && m.recipe?.id === match.recipe;
  const loadDiff = async () => {
    if (!match) return;
    try {
      const r = await datasets.recipeDiff(m.id, match.recipe, match.version);
      setDiff(r.diff);
      return r;
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="findings">
      {match && (
        <div className={`match-card ${match.blocked ? 'warn' : ''}`}>
          <div className="row">
            <b className="grow">Looks like “{match.name}”</b>
            <span className="badge">{Math.round(match.score * 100)}%</span>
          </div>
          <div className="small">
            {match.ran ? 'The recipe ran automatically on this file — see Results. ' : ''}
            {usingMatch ? `These steps come from the recipe (v${m.recipe!.version}).` : 'A saved recipe fits this layout.'}
          </div>
          <ul className="small tight">
            {match.summary.slice(0, 4).map((l, i) => (
              <li key={i} className={l.level === 'error' ? 'err' : l.level === 'warning' ? 'amber-text' : undefined}>
                {l.text}
              </li>
            ))}
          </ul>
          <div className="row">
            {!usingMatch && m.canEdit && (
              <button
                className="primary small"
                onClick={async () => {
                  const r = await loadDiff();
                  if (r) m.useRecipe(r.diff.steps, r.roles, { id: match.recipe, version: r.diff.version });
                }}
              >
                Use the recipe
              </button>
            )}
            <button className="small" onClick={() => (diff ? setDiff(null) : void loadDiff())}>
              {diff ? 'Hide differences' : 'What changed?'}
            </button>
          </div>
          {err && <div className="err small">{err}</div>}
          {diff && <LayoutDiffView diff={diff} />}
        </div>
      )}
      {findings.length > 0 && (
        <div className="found">
          <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? '▾' : '▸'} What I found in the file ({findings.length})
          </button>
          {open && (
            <ul className="small tight">
              {findings.map((f, i) => (
                <li key={i} className={f.level === 'warning' ? 'amber-text' : undefined}>
                  {f.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function LayoutDiffView({ diff }: { diff: LayoutDiff }) {
  const changed = diff.columns.filter((c) => c.kind !== 'same');
  return (
    <div className="layout-diff small">
      {diff.sheet.was !== diff.sheet.now && (
        <div>
          Sheet: “{diff.sheet.was}” → “{diff.sheet.now}”
        </div>
      )}
      {diff.headerRow.was !== diff.headerRow.now && (
        <div>
          Header row: {diff.headerRow.was} → {diff.headerRow.now}
        </div>
      )}
      {!changed.length && <div className="muted">Same columns, same order.</div>}
      {changed.map((c, i) => (
        <div key={i} className={c.kind === 'missing' ? 'err' : c.kind === 'type' || c.kind === 'renamed' ? 'amber-text' : undefined}>
          {c.kind === 'moved' && `“${c.header}” moved from column ${c.from + 1} to ${c.to + 1}`}
          {c.kind === 'renamed' && `“${c.from}” is now “${c.to}” (${Math.round(c.confidence * 100)}% sure)`}
          {c.kind === 'missing' && `“${c.header}” is missing${c.usedBy.length ? ` — used by ${plural(c.usedBy.length, 'step')}` : ''}`}
          {c.kind === 'new' && (c.type === 'empty' ? `New column “${c.header}” — empty, left out` : `New column “${c.header}” (${c.type})`)}
          {c.kind === 'type' && `“${c.header}” was ${c.was}, now ${c.now}`}
        </div>
      ))}
      {diff.values.map((v) => (
        <div key={v.key} className="amber-text">
          New values in “{v.header}”: {v.values.slice(0, 5).map((x) => `“${x.value}” (${x.count})`).join(', ')}
          {v.usedBy.length ? ` — the recipe maps this column in ${plural(v.usedBy.length, 'step')}` : ''}
        </div>
      ))}
      {diff.blocked.length > 0 && <div className="err">{plural(diff.blocked.length, 'step')} cannot run without: {[...new Set(diff.blocked.flatMap((b) => b.missing))].map((k) => diff.columns.flatMap((c) => (c.kind === 'missing' && c.key === k ? [c.header] : []))[0] ?? k).map((h) => `“${h}”`).join(', ')}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ one step in the timeline
function StepRow({
  step,
  index,
  text,
  result,
  selected,
  canEdit,
  onSelect,
  onToggle,
  onRemove,
  onMove,
}: {
  step: Step;
  index: number;
  text?: string;
  result?: StepResult;
  selected: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onRemove?: () => void;
  onMove: (d: number) => void;
}) {
  const off = step.enabled === false;
  const status = result?.status;
  return (
    <div className={`step-row${selected ? ' selected' : ''}${off ? ' off' : ''}${status === 'failed' ? ' failed' : ''}`}>
      {canEdit && index > 0 ? (
        <input type="checkbox" checked={!off} onChange={onToggle} aria-label={`${off ? 'Turn on' : 'Turn off'}: ${text ?? TYPE_LABEL[step.type]}`} />
      ) : (
        <span className="step-n">{index + 1}</span>
      )}
      <button className="step-main" onClick={onSelect} aria-expanded={selected}>
        <div className="step-text">{text ?? TYPE_LABEL[step.type] ?? step.type}</div>
        <div className="step-meta small">
          {status === 'done' && (
            <>
              {result!.changed > 0 && <span>{fmtNum(result!.changed)} changed</span>}
              {result!.rejected > 0 && <span className="amber-text">{fmtNum(result!.rejected)} removed</span>}
              {result!.issues > 0 && <span className="amber-text">{fmtNum(result!.issues)} flagged</span>}
              {result!.output && <span>{plural(result!.output.rows, 'row')}</span>}
              {!result!.changed && !result!.rejected && !result!.issues && !result!.output && <span className="muted">no change in the sample</span>}
            </>
          )}
          {status === 'skipped' && <span className="muted">off</span>}
          {status === 'failed' && <span className="err">failed</span>}
          {status === 'blocked' && <span className="err">blocked</span>}
          {step.by && <span className={`by by-${step.by}`}>{step.by === 'assistant' ? 'assistant' : step.by === 'person' ? 'you' : 'proposed'}</span>}
        </div>
      </button>
      {canEdit && index > 0 && (
        <div className="step-tools">
          <button className="icon small" onClick={() => onMove(-1)} title="Move up" aria-label="Move up">
            ↑
          </button>
          <button className="icon small" onClick={() => onMove(1)} title="Move down" aria-label="Move down">
            ↓
          </button>
          {onRemove && (
            <button className="icon small" onClick={onRemove} title="Remove this step" aria-label="Remove this step">
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StepDetail({ step, result, text, onClose }: { step: Step; result?: StepResult; text?: string; onClose: () => void }) {
  return (
    <div className="step-detail">
      <div className="row">
        <StageChip stage={stageOf(step)} />
        <b className="grow">{text ?? TYPE_LABEL[step.type]}</b>
        <button className="icon small" onClick={onClose} aria-label="Close the step details">
          ✕
        </button>
      </div>
      {step.why && <div className="small">Why: {step.why}</div>}
      {result && (
        <div className="small muted">
          {plural(result.rowsIn, 'row')} in → {plural(result.rowsOut, 'row')} out
          {result.changed ? ` · ${fmtNum(result.changed)} values changed` : ''}
          {result.rejected ? ` · ${fmtNum(result.rejected)} rows removed` : ''}
          {result.issues ? ` · ${fmtNum(result.issues)} flagged` : ''} · {result.ms} ms
        </div>
      )}
      {result?.notes.map((n, i) => (
        <div key={i} className="small">
          {n}
        </div>
      ))}
      {result?.error && <div className="err small">{result.error}</div>}
      {result && result.examples.length > 0 && (
        <DataTable
          caption="Examples of what this step did"
          columns={['Row in file', 'Column', 'Before', 'After', 'Note']}
          rows={result.examples.slice(0, 12).map((e) => [e.row, e.column ?? '', e.before ?? '', e.after ?? '', e.note ?? ''])}
          maxHeight={220}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the data
function DataPane({ m, view }: { m: Model; view: string }) {
  const [raw, setRaw] = useState<{ rows: unknown[][]; columns: number } | null>(null);
  const header = m.steps[0] as (Step & { sheet?: number; row?: number }) | undefined;
  useEffect(() => {
    if (view !== 'raw' || !header) return;
    let stop = false;
    void datasets.raw(m.id, header.sheet ?? 0, 0, 60).then((r) => !stop && setRaw({ rows: r.rows, columns: r.columns }));
    return () => {
      stop = true;
    };
  }, [view, m.id, header?.sheet]);
  if (view === 'raw') {
    if (!raw) return <div className="muted small">Loading the file…</div>;
    const cols = raw.rows.length ? raw.rows[0].length - 1 : raw.columns;
    const letters = (i: number) => {
      let s = '';
      let n = i;
      for (;;) {
        s = String.fromCharCode(65 + (n % 26)) + s;
        if (n < 26) return s;
        n = Math.floor(n / 26) - 1;
      }
    };
    return (
      <DataTable
        caption="The file as it arrived"
        columns={['Row', ...Array.from({ length: cols }, (_, i) => letters(i))]}
        rows={raw.rows}
        highlight={(ri) => (header && Number(raw.rows[ri]?.[0]) === header.row ? 'header-row' : undefined)}
      />
    );
  }
  const p = m.preview?.preview;
  if (!p) return <div className="muted small">{m.previewing ? 'Previewing…' : 'No preview yet.'}</div>;
  const table = view === 'clean' ? p.work : p.outputs[view];
  if (!table) return <div className="muted small">This output has no preview.</div>;
  return (
    <>
      <div className="small muted">{view === 'clean' ? `The cleaned table: ${plural(table.total, 'row')} in the sample, ${plural(table.columns.length, 'column')}` : `${plural(table.total, 'row')} in the sample`}</div>
      <DataTable caption={view === 'clean' ? 'The cleaned table' : view} columns={table.columns.map((c) => (c.key === '_row' ? 'Row in file' : c.label))} meta={table.columns} rows={table.rows} />
    </>
  );
}

// ------------------------------------------------------------------ the assistant
interface Msg {
  who: 'you' | 'assistant';
  text: string;
  reply?: AssistReply;
  applied?: Record<number, string>;
}
function Assistant({ m, focus }: { m: Model; focus?: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // a block body: scroll methods may return a Promise, which React would take for a cleanup function
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length, busy]);
  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setMsgs((x) => [...x, { who: 'you', text: question }]);
    setQ('');
    setBusy(true);
    try {
      const r = await datasets.assist(m.id, question, m.steps, m.roles, m.preview, focus);
      setMsgs((x) => [...x, { who: 'assistant', text: r.reply, reply: r, applied: {} }]);
    } catch (e) {
      setMsgs((x) => [...x, { who: 'assistant', text: `I could not answer: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };
  const apply = (mi: number, ai: number) => {
    const msg = msgs[mi];
    const a = msg.reply?.actions[ai];
    if (!a) return;
    const err = m.applyAction(a);
    setMsgs((x) => x.map((y, i) => (i === mi ? { ...y, applied: { ...y.applied, [ai]: err ?? 'added' } } : y)));
  };
  return (
    <aside className="prepare-assistant" aria-label="Assistant">
      <h2 className="studio-h2">Assistant</h2>
      <div className="muted small">Ask about the data or for a step. Proposed steps are checked before you see them and only change anything when you add them.</div>
      <div className="assist-log" aria-live="polite">
        {!msgs.length && (
          <div className="assist-prompts">
            {PROMPTS.map((p) => (
              <button key={p} className="chip" onClick={() => void ask(p)} disabled={!m.canEdit}>
                {p}
              </button>
            ))}
          </div>
        )}
        {msgs.map((x, mi) => (
          <div key={mi} className={`assist-msg ${x.who}`}>
            {x.who === 'assistant' ? <Md text={x.text} /> : <div className="assist-text">{x.text}</div>}
            {x.reply?.offline && <div className="muted small">No model is set for this client: answered from the profile and the rules.</div>}
            {x.reply?.actions.map((a, ai) => (
              <div key={ai} className={`assist-action${a.error ? ' invalid' : ''}`}>
                <div className="small">
                  <b>{a.op === 'add' ? 'Add' : a.op === 'update' ? 'Change' : 'Remove'}</b> {a.step ? (TYPE_LABEL[a.step.type] ?? a.step.type) : a.id}
                  {a.step && (a.step as { column?: string }).column ? ` · ${(a.step as { column?: string }).column}` : ''}
                </div>
                <div className="small">{a.why}</div>
                {a.error && <div className="err small">{a.error}</div>}
                {!a.error && m.canEdit && (
                  <div className="row">
                    {x.applied?.[ai] ? (
                      <span className={`small ${x.applied[ai] === 'added' ? 'green-text' : 'err'}`}>{x.applied[ai] === 'added' ? 'Added — see the preview' : x.applied[ai]}</span>
                    ) : (
                      <button className="primary small" onClick={() => apply(mi, ai)}>
                        {a.op === 'remove' ? 'Remove the step' : a.op === 'update' ? 'Change the step' : 'Add the step'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {x.reply?.questions.length ? (
              <div className="assist-prompts">
                {x.reply.questions.map((qq) => (
                  <button key={qq} className="chip" onClick={() => void ask(qq)}>
                    {qq}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {busy && <div className="assist-msg assistant pill loading">thinking…</div>}
        <div ref={end} />
      </div>
      <form
        className="assist-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={focus ? 'Ask about the selected step…' : 'Ask about the data, or for a step…'}
          aria-label="Ask the assistant"
          rows={2}
          disabled={!m.canEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(q);
            }
          }}
        />
        <button className="primary" type="submit" disabled={busy || !q.trim() || !m.canEdit}>
          Ask
        </button>
      </form>
    </aside>
  );
}
