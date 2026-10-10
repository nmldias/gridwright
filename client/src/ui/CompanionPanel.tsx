import { useEffect, useState } from 'react';
import { api, RECORD_KINDS, type Companion, type ContextRecord, type IntakeProfile, type IntakeSet, type Investigation, type RecordKind, type Suggestion, type Understanding, type Watch, type WatchDef } from '../api/client';
import { readOnly, setStatus, useStore } from '../state/store';
import { acceptSuggestion, addWatch, applyExclusion, approveWatch, changeWatch, checkNow, clearReflection, confirmReading, confirmRecord, correctRecord, dismissSuggestion, investigate, loadCompanion, markExpectation, markSeen, remember, removeRecord, removeWatch, resolveRecord, restoreSuggestion, retireRecord, statementOf, stopInvestigation, useCompanion } from './companion';
import { applyIntake, skipIntake, useIntake } from './intake';

const KIND_LABEL: Record<RecordKind, string> = { objective: 'What matters', constraint: 'Within', exclusion: 'Left out', decision: 'Decisions', question: 'Open questions', expectation: 'Expected', scenario: 'Scenarios (explored, not adopted)', contradiction: 'Sources disagree', hypothesis: 'Hypotheses', fact: 'Facts', source: 'Snapshots and sources' };
const KIND_HINT: Partial<Record<RecordKind, string>> = { question: 'what it bears on, after a dash: "Is the freight final? — bears on which vehicles to reprice"', expectation: '"final freight invoice for SH-001 by 2026-10-20 in invoices"', decision: '"hold the Creta — because an order is expected; reconsider if the order lapses"', constraint: 'e.g. replacement-cost margin stays positive on every disposal' };
const HEALTH_LABEL: Record<Watch['health'], string> = { ok: 'fine', baseline: 'waiting for the next snapshot', attention: 'needs attention', stale: 'not checked — source stale', error: 'cannot evaluate', invalid: 'cannot assess — blank or text', unchecked: 'not checked yet', proposed: 'proposed — needs your approval' };
const ruleWords = (d: WatchDef) => (d.kind === 'threshold' ? `${d.op === '>' ? 'more than' : d.op === '>=' ? 'at least' : d.op === '<' ? 'below' : d.op === '<=' ? 'at most' : d.op === '=' ? 'equal to' : 'not'} ${fmtValue(d.value)}` : d.kind === 'check' ? 'must stay TRUE' : d.kind === 'worsening' ? `${d.bad === 'down' ? 'falling' : 'rising'} snapshot after snapshot` : 'any change');
const ago = (iso?: string) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const fmtValue = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : String(v ?? '—'));
const NO_INTAKE: IntakeProfile[] = [];
const live = (r: ContextRecord) => r.status !== 'retired' && r.status !== 'superseded' && r.status !== 'resolved';
const byName = (r: ContextRecord) => (r.origin === 'agent' ? (r.by.name.startsWith('investigation') ? 'an investigation' : 'an agent') : r.origin === 'system' ? 'a check' : r.by.name);

/** The situation at the top of Ask: the stance, the correctable understanding, the next move, then what changed · why it matters · what next — with Context and Watching on demand. */
export function CompanionBrief() {
  const fileId = useStore((s) => s.fileId);
  const version = useStore((s) => s.companionVersion);
  const data = useCompanion((s) => (fileId ? s.byDoc[fileId] : undefined));
  const reflection = useCompanion((s) => (fileId ? s.reflection[fileId] : undefined));
  const pendingIntake = useIntake((s) => (fileId ? s.pending[fileId] : undefined)) ?? NO_INTAKE;
  const intakeBusy = useIntake((s) => (fileId ? !!s.busy[fileId] : false));
  const [view, setView] = useState<'none' | 'context' | 'watching'>('none');
  const [stack, setStack] = useState<{ available: boolean; reason?: string } | null>(null);
  const ro = readOnly();
  useEffect(() => {
    if (fileId) void loadCompanion(fileId);
  }, [fileId, version]);
  useEffect(() => {
    api
      .investigationStack()
      .then((s) => setStack(s))
      .catch(() => setStack({ available: false, reason: 'unknown' }));
  }, []);
  // the brief was read: the next one starts from here
  useEffect(() => {
    if (fileId && data) {
      const t = window.setTimeout(() => void markSeen(), 4000);
      return () => window.clearTimeout(t);
    }
  }, [fileId, data?.brief.changed.length]);

  if (!fileId) {
    return (
      <div className="companion">
        <div className="muted small">The companion builds an understanding of a saved document as you add to it: imports, what matters, what to leave out, decisions, questions, watches. Save the document to start.</div>
      </div>
    );
  }
  if (!data) return <div className="companion muted small">Loading the brief…</div>;
  const b = data.brief;
  const u = data.understanding;
  const h = b.health;
  const attention = h.attention;
  const checked = h.checked ? `checked ${ago(h.checked)}` : data.watches.some((w) => w.authority === 'approved') ? 'not checked yet' : '';
  const healthText = [h.ok ? `${h.ok} fine` : '', h.baseline ? `${h.baseline} waiting for the next snapshot` : '', h.stale ? `${h.stale} stale` : '', h.error ? `${h.error} cannot evaluate` : '', h.proposed ? `${h.proposed} proposed` : ''].filter(Boolean).join(' · ');
  const running = data.investigations.find((i) => i.status === 'running');
  const canInvestigate = !ro && !!stack?.available && !running;
  const cannot = h.error + h.invalid + h.stale;
  return (
    <div className={`companion ${attention ? 'attention' : ''} stance-${u.stance}`}>
      <div className="companion-head">
        <b className="companion-lead">{u.lead}</b>
        <span className="muted small" title={u.monitoring.text}>
          {checked}
          {healthText ? ` · ${healthText}` : ''}
          {cannot ? ` · ${cannot} cannot be assessed` : ''}
        </span>
      </div>
      {intakeBusy && <div className="muted small">Reading the file…</div>}
      {pendingIntake.map((p) => (
        <IntakeCard key={p.key} p={p} />
      ))}
      <Situation u={u} onCorrect={() => setView('context')} />
      <div className="next-move">
        <span className="brief-h">Next useful move</span>
        <span className="next-text">{u.next}</span>
        {(u.stance === 'decision' || u.stance === 'question') && !ro && (
          <button className="small" disabled={!canInvestigate} title={stack?.available ? 'A bounded investigation by the agent stack: it reads the context, computes independently in the sandbox and proposes; it changes nothing' : `The investigation stack is not available: ${stack?.reason ?? 'not probed yet'}`} onClick={() => void investigate(u.next)}>
            {running ? 'Investigating…' : 'Investigate'}
          </button>
        )}
      </div>
      {reflection && (
        <div className="reflection">
          {reflection.lines.map((l, i) => (
            <div key={i} className="reflection-line">
              <span>{l.text}</span>
              {l.record && (
                <>
                  {l.record.inferred && !ro && (
                    <button className="link small" onClick={() => void confirmReading(l.record!)}>
                      yes, that's it
                    </button>
                  )}
                  {l.scope && (l.scope.state === 'recorded' || l.scope.state === 'partly') && l.scope.watches.some((w) => w.applicable && !w.applied) && !ro && (
                    <button className="link small" onClick={() => void applyExclusion(l.record!)}>
                      apply to the watches
                    </button>
                  )}
                  <button className="link small" onClick={() => setView('context')}>
                    correct
                  </button>
                  <button className="link small" onClick={() => void removeRecord(l.record!)}>
                    remove
                  </button>
                </>
              )}
              {l.watch && (
                <button className="link small" onClick={() => setView('watching')}>
                  adjust
                </button>
              )}
            </div>
          ))}
          <button className="icon" title="Dismiss" onClick={() => clearReflection(fileId)}>
            ✕
          </button>
        </div>
      )}
      {(b.changed.length > 0 || attention > 0 || b.matters.some((t) => !/^(No material issues|Nothing is being watched|\d+ watch(es)? (still building|not checked))/.test(t)) || b.next.some((t) => t !== 'Nothing to decide.' && t !== u.next)) && (
        <div className="brief">
          {b.changed.length > 0 && (
            <div className="brief-col">
              <div className="brief-h">What has changed</div>
              {b.changed.slice(-4).map((t, i) => (
                <div key={i}>{t}</div>
              ))}
            </div>
          )}
          {(attention > 0 || b.matters.some((t) => !/^(No material issues|Nothing is being watched|\d+ watch(es)? (still building|not checked))/.test(t))) && (
            <div className="brief-col">
              <div className="brief-h">Why it matters</div>
              {b.matters.map((t, i) => (
                <div key={i} className={attention && i < attention ? 'matters-attention' : ''}>
                  {t}
                </div>
              ))}
            </div>
          )}
          {b.next.filter((t) => t !== u.next && t !== 'Nothing to decide.').length > 0 && (
            <div className="brief-col">
              <div className="brief-h">Also</div>
              {b.next
                .filter((t) => t !== u.next && t !== 'Nothing to decide.')
                .map((t, i) => (
                  <div key={i}>{t}</div>
                ))}
            </div>
          )}
        </div>
      )}
      <div className="row wrap companion-actions">
        <button className={view === 'context' ? 'active' : ''} onClick={() => setView(view === 'context' ? 'none' : 'context')}>
          Context{data.records.filter(live).length ? ` · ${data.records.filter(live).length}` : ''}
        </button>
        <button className={view === 'watching' ? 'active' : ''} onClick={() => setView(view === 'watching' ? 'none' : 'watching')}>
          Watching{data.watches.length ? ` · ${data.watches.length}` : ''}
        </button>
        <button onClick={() => void checkNow()} title="Re-evaluate every approved watch now (checks also run after each change and on a timer)">
          Check now
        </button>
      </div>
      {view === 'context' && <ContextView data={data} />}
      {view === 'watching' && <WatchingView watches={data.watches} fileId={fileId} investigations={data.investigations} canInvestigate={canInvestigate} stack={stack} />}
    </div>
  );
}

/** A file brought in: what it is, what it relates to, what was cleaned — and the decision, which is the person's. */
function IntakeCard({ p }: { p: IntakeProfile }) {
  const [period, setPeriod] = useState(p.period ?? '');
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileId = useStore((s) => s.fileId);
  const ro = readOnly();
  const sets = p.sets;
  const one = sets.length === 1;
  const place = async (set: IntakeSet, action: 'update' | 'new' | 'history' | 'skip') => {
    setBusy(true);
    try {
      await applyIntake(p, [{ set: set.name, action, table: set.relation.table?.id }, ...sets.filter((x) => x !== set).map((x) => ({ set: x.name, action: 'skip' as const }))], period.trim() || undefined);
    } finally {
      setBusy(false);
    }
  };
  const placeAll = async () => {
    setBusy(true);
    try {
      await applyIntake(p, sets.map((x) => ({ set: x.name, action: x.relation.recommended, table: x.relation.table?.id })), period.trim() || undefined);
    } finally {
      setBusy(false);
    }
  };
  const verb = (r: IntakeSet['relation']) => (r.recommended === 'update' ? `Update ${r.table?.name ?? 'the table'}` : r.recommended === 'history' ? 'Keep as history' : r.recommended === 'skip' ? 'Nothing to do' : 'Add as a table');
  return (
    <div className="intake-card" data-key={p.key}>
      <div className="row">
        <b className="grow">{p.name}</b>
        <span className="muted small">
          {p.format.toUpperCase()} · {sets.reduce((n, x) => n + x.dataRows, 0)} row{sets.reduce((n, x) => n + x.dataRows, 0) === 1 ? '' : 's'}
          {one ? ` × ${sets[0].cols} columns` : ` in ${sets.length} sets`} · {Math.round(p.size / 1024) || 1} KB{p.origin === 'inbox' ? ' · from the inbox' : p.origin === 'sql' ? ` · query on ${p.query?.connection}` : ''}
        </span>
      </div>
      {sets.map((set) => (
        <div key={set.name} className={`intake-set rel-${set.relation.kind}`}>
          {!one && <div className="small">
            <b>{set.name}</b> · {set.dataRows} rows × {set.cols} columns
          </div>}
          <div className="small">
            <b>{set.relation.kind === 'first' ? 'New here' : set.relation.kind === 'next' ? 'Next snapshot' : set.relation.kind === 'same-period' ? 'Same period' : set.relation.kind === 'older' ? 'Older snapshot' : set.relation.kind === 'different-entity' ? 'Same columns, different entity' : set.relation.kind === 'duplicate' ? 'Already added' : 'Unrelated'}:</b> {set.relation.reason}
          </div>
          {set.relation.identifiers && set.relation.kind !== 'first' && (
            <div className="muted small">
              {set.relation.identifiers.column}: {set.relation.identifiers.ofFile} in the file, {set.relation.identifiers.ofTable} in the table, {Math.round(set.relation.identifiers.overlap * 100)}% in common{set.relation.identifiers.added ? ` · ${set.relation.identifiers.added} new` : ''}{set.relation.identifiers.removed ? ` · ${set.relation.identifiers.removed} gone` : ''}
            </div>
          )}
          {set.notes.length > 0 && <div className="muted small">Checked: {set.notes.join(' · ')}</div>}
          {set.quarantined.length > 0 && (
            <div className="small amber-text">
              {set.quarantined.length} row{set.quarantined.length === 1 ? '' : 's'} held back: {set.quarantined.map((q) => `row ${q.row} (${q.reason})`).join('; ')}
            </div>
          )}
          {!ro && !busy && (
            <div className="row wrap">
              {set.relation.recommended !== 'skip' && (
                <button className="primary small" onClick={() => void place(set, set.relation.recommended)}>
                  {verb(set.relation)}
                </button>
              )}
              {set.relation.recommended !== 'new' && (
                <button className="small" onClick={() => void place(set, 'new')}>
                  Add as a new table
                </button>
              )}
              {set.relation.recommended === 'new' && set.relation.table && (
                <button className="small" onClick={() => void place(set, 'update')} title={`Replace the rows of ${set.relation.table.name} with this file — only if it is the same series`}>
                  Update {set.relation.table.name} instead
                </button>
              )}
              {set.relation.recommended !== 'history' && set.relation.kind !== 'first' && set.relation.kind !== 'duplicate' && (
                <button className="small" onClick={() => void place(set, 'history')}>
                  Keep as history
                </button>
              )}
              {one && (
                <button className="link small" onClick={() => skipIntake(p)}>
                  not now
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      <div className="row wrap small">
        <label className="small">
          Period{' '}
          <input className="period" value={period} placeholder="e.g. 2026-10-13" onChange={(e) => setPeriod(e.target.value)} onKeyDown={(e) => e.stopPropagation()} title={p.periodFrom === 'name' ? 'read from the file name' : p.periodFrom === 'column' ? 'the latest date in a date column' : 'not recognised — set the period the data describes'} />
          {p.periodFrom === 'none' && <span className="amber-text"> not recognised — set it</span>}
        </label>
        {!one && !ro && !busy && (
          <button className="primary small" onClick={() => void placeAll()}>
            Place all as suggested
          </button>
        )}
        {!one && !ro && (
          <button className="link small" onClick={() => skipIntake(p)}>
            not now
          </button>
        )}
        <button className="link small" onClick={() => setDetails((v) => !v)}>
          {details ? 'hide columns' : 'columns'}
        </button>
        {fileId && (
          <a className="link small" href={api.files.originalUrl(fileId, p.key)} download>
            original
          </a>
        )}
        {busy && <span className="muted small">Placing…</span>}
      </div>
      {details &&
        sets.map((set) => (
          <table key={set.name} className="intake-columns small">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Filled</th>
                <th>Unit</th>
                <th>Sample</th>
              </tr>
            </thead>
            <tbody>
              {set.columns.map((c) => (
                <tr key={c.index}>
                  <td>{c.header}{c.constant ? <span className="muted"> (all “{c.constant}”)</span> : ''}</td>
                  <td>{c.type}{c.leadingZeros ? ` · ${c.leadingZeros} with leading zeros kept` : ''}{c.textInNumber ? ` · ${c.textInNumber} text` : ''}</td>
                  <td>{c.filled}{c.blanks ? ` (${c.blanks} blank)` : ''}</td>
                  <td>{c.unit ?? ''}</td>
                  <td className="muted">{c.sample.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}

/** The understanding, element by element, each correctable: what we are working toward, within what, leaving out what, based on which records. */
function Situation({ u, onCorrect }: { u: Understanding; onCorrect: () => void }) {
  const cov = u.coverage.filter((c) => c.rows > 0);
  return (
    <div className="situation" title={u.statement}>
      <div className="situation-line">
        <span className="situation-k">Working toward</span>
        <span className={u.objective ? '' : 'muted'}>{u.objective ? u.objective.text : 'not stated yet — say what matters (Objective: …)'}</span>
        <button className="link small" onClick={onCorrect}>
          correct
        </button>
      </div>
      {u.constraints.length > 0 && (
        <div className="situation-line">
          <span className="situation-k">Within</span>
          <span>{u.constraints.map((c) => c.text).join(' · ')}</span>
        </div>
      )}
      {u.exclusions.length > 0 && (
        <div className="situation-line">
          <span className="situation-k">Leaving out</span>
          <span>{u.exclusions.map((c) => c.text).join(' · ')}</span>
        </div>
      )}
      <div className="situation-line">
        <span className="situation-k">Based on</span>
        <span className={cov.length ? '' : 'muted'}>
          {cov.length
            ? cov.map((c, i) => (
                <span key={c.name} className="source-chip" title={`${c.supply === 'import' ? 'manually supplied' : c.supply === 'live' ? 'live' : c.supply === 'manual' ? 'edited by hand' : 'unknown supply'} · last change ${ago(c.lastChange)}`}>
                  {i ? ', ' : ''}
                  {c.name} <span className="muted">({c.period ? `snapshot ${c.period}, ` : ''}{c.rows} row{c.rows === 1 ? '' : 's'}{c.derivative ? ', generated — not independent evidence' : ''})</span>
                </span>
              ))
            : 'nothing yet — add a file or a table'}
          {cov.length > 0 && <span className="muted"> — these records, not the complete position</span>}
        </span>
      </div>
      {u.decisions.length > 0 && (
        <div className="situation-line">
          <span className="situation-k">Standing</span>
          <span>
            {u.decisions.length} decision{u.decisions.length === 1 ? '' : 's'}
            {u.decisions.some((d) => d.revisit) ? <span className="badge amber">one to revisit</span> : u.decisions.some((d) => d.conditions.some((c) => c.watch)) ? <span className="muted"> · conditions watched</span> : u.decisions.some((d) => d.conditions.length) ? <span className="muted"> · conditions not watched yet</span> : ''}
          </span>
        </div>
      )}
      {u.uncertain.length > 0 && (
        <div className="situation-line">
          <span className="situation-k">Uncertain</span>
          <span>
            {u.uncertain.length} open{u.uncertain.length === 1 ? '' : ''}
            <span className="muted"> — first: {u.uncertain[0].text}{u.uncertain[0].bearing ? ` (${u.uncertain[0].bearing})` : ''}</span>
          </span>
        </div>
      )}
    </div>
  );
}

function QuickRecord({ kind, placeholder }: { kind: RecordKind; placeholder: string }) {
  const [text, setText] = useState('');
  const keep = () => {
    const st = statementOf(`${kind}: ${text.trim()}`);
    void remember(kind, st?.text ?? text.trim(), st?.extra ?? {});
    setText('');
  };
  return (
    <div className="row">
      <input
        className="grow"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && text.trim()) keep();
        }}
      />
      <button className="small" disabled={!text.trim()} onClick={keep}>
        Keep
      </button>
    </div>
  );
}

function ConditionState({ c }: { c: { text: string; holds?: boolean; purpose?: string; watch?: string } }) {
  const word = c.holds === true ? 'holds' : c.holds === false ? 'no longer holds' : c.watch ? 'not checked yet' : 'not watched — confirm by hand';
  return (
    <span className={`condition ${c.holds === false ? 'fails' : c.holds === true ? 'holds' : ''}`} title={c.purpose ? `watched by “${c.purpose}”` : undefined}>
      {c.holds === true ? '✓' : c.holds === false ? '✗' : '–'} {c.text} <span className="muted">({word})</span>
    </span>
  );
}

function ContextView({ data }: { data: Companion }) {
  const { records, dismissed } = data;
  const sources = data.brief.sources;
  const [kind, setKind] = useState<RecordKind>('fact');
  const [text, setText] = useState('');
  const [period, setPeriod] = useState('');
  const [more, setMore] = useState(false);
  const [settled, setSettled] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [condFor, setCondFor] = useState<string | null>(null);
  const [condText, setCondText] = useState('');
  const [condWatch, setCondWatch] = useState('');
  const ro = readOnly();
  const current = records.filter(live);
  const done = records.filter((r) => r.status === 'resolved');
  const groups = RECORD_KINDS.map((k) => [k, current.filter((r) => r.kind === k)] as const).filter(([, rs]) => rs.length);
  const approved = data.watches.filter((w) => w.authority === 'approved');
  const addCondition = (r: ContextRecord) => {
    const txt = condText.trim() || approved.find((w) => w.id === condWatch)?.def.purpose || '';
    if (!txt) return;
    void correctRecord(r, { conditions: [...(r.conditions ?? []).map((c) => ({ text: c.text, watch: c.watch })), { text: txt, watch: condWatch || undefined }] });
    setCondFor(null);
    setCondText('');
    setCondWatch('');
  };
  return (
    <div className="companion-section">
      {!ro && (
        <>
          <QuickRecord kind="objective" placeholder="What matters here, e.g. preserve replacement-cost margin" />
          <QuickRecord kind="exclusion" placeholder="What to leave out, e.g. customer-reserved vehicles in Inventory" />
        </>
      )}
      {sources.length > 0 && (
        <div className="small">
          <b>Sources:</b>{' '}
          {sources.map((s, i) => (
            <span key={s.name} className="source-chip" title={`${s.rows} rows · last change ${ago(s.lastChange)}`}>
              {i ? ' · ' : ''}
              {s.name} <span className="muted">({s.supply === 'import' ? 'manually supplied' : s.supply === 'live' ? 'live' : s.supply === 'manual' ? 'edited by hand' : 'unknown'}, {ago(s.lastChange)})</span>
            </span>
          ))}
        </div>
      )}
      {groups.map(([k, rs]) => (
        <div key={k}>
          <div className="brief-h">{KIND_LABEL[k]}</div>
          {rs.map((r) => (
            <div key={r.id} className={`ctx-item ${r.status} ${r.kind} ${r.revisit ? 'revisit' : ''}`}>
              {editing === r.id ? (
                <div className="row">
                  <input className="grow" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
                  <button
                    className="primary small"
                    onClick={() => {
                      void correctRecord(r, { text: draft });
                      setEditing(null);
                    }}
                  >
                    Keep
                  </button>
                  <button className="small" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <div>
                    {r.text}
                    {r.status === 'proposed' && <span className="badge amber">proposed by {byName(r)}</span>}
                    {r.status === 'confirmed' && <span className="badge green">confirmed</span>}
                    {r.status === 'observed' && <span className="badge">found by a check</span>}
                    {r.inferred && <span className="badge amber">my reading — confirm or correct</span>}
                    {r.private && <span className="badge">private</span>}
                    {r.derivative && <span className="badge">generated — not independent</span>}
                    {r.kind === 'expectation' && r.expected && <span className={`badge ${r.expected.state === 'missing' ? 'amber' : r.expected.state === 'met' ? 'green' : ''}`}>{r.expected.state === 'met' ? 'arrived' : r.expected.state === 'missing' ? 'not arrived' : r.expected.state === 'unchecked' ? 'not checked' : r.expected.state === 'didnt' ? 'did not happen' : 'open'}</span>}
                  </div>
                  {r.why && (
                    <div className="small">
                      <b>Why:</b> {r.why}
                    </div>
                  )}
                  {r.kind === 'exclusion' && (() => {
                    const sc = data.understanding.scope.find((x) => x.record === r.id);
                    if (!sc) return null;
                    const pending = sc.watches.filter((w) => w.applicable && !w.applied);
                    return (
                      <div className={`small scope-${sc.state}`}>
                        {sc.state === 'no-column' ? 'Recorded — no yes/no column marks this yet; say which (e.g. “Reserved = yes”)' : sc.state === 'applied' ? `Applied: the watches on ${sc.table} leave ${sc.column} = yes out` : `Recorded, ${sc.state === 'partly' ? 'partly applied' : 'not yet applied'}: ${pending.length} watch${pending.length === 1 ? '' : 'es'} still count${pending.length === 1 ? 's' : ''} the whole ${sc.table} population`}
                        {!ro && pending.length > 0 && (
                          <>
                            {' '}
                            <button className="link small" onClick={() => void applyExclusion(r)}>
                              apply to the watches
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })()}
                  {r.bearing && (
                    <div className="small">
                      <b>Bears on:</b> {r.bearing}
                    </div>
                  )}
                  {r.kind === 'expectation' && (
                    <div className="small">
                      {r.expected?.text ?? `Expected${r.due ? ` by ${r.due}` : ''}${r.source ? ` in ${r.source}` : ''}`}
                      {!ro && r.expected?.state !== 'met' && r.expected?.state !== 'didnt' && (
                        <>
                          {' '}
                          <button className="link small" onClick={() => void markExpectation(r, 'met')}>
                            it arrived
                          </button>
                          <button className="link small" onClick={() => void markExpectation(r, 'didnt')}>
                            it did not happen
                          </button>
                        </>
                      )}
                      {!ro && (r.expected?.state === 'met' || r.expected?.state === 'didnt') && (
                        <>
                          {' '}
                          <button className="link small" onClick={() => void markExpectation(r, 'open')}>
                            open again
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {r.kind === 'decision' && (
                    <div className="small conditions">
                      {r.revisit && (
                        <div className="revisit-note">
                          <b>Revisit:</b> the condition “{r.revisit.condition}” no longer appears to hold — {r.revisit.summary}
                        </div>
                      )}
                      {(r.conditions ?? []).length > 0 && (
                        <div>
                          <b>Reconsider if:</b>{' '}
                          {(r.conditions ?? []).map((c, i) => (
                            <span key={i}>
                              {i ? '; ' : ''}
                              <ConditionState c={{ ...c, purpose: c.watch ? data.watches.find((w) => w.id === c.watch)?.def.purpose : undefined }} />
                            </span>
                          ))}
                        </div>
                      )}
                      {!ro && !r.key?.startsWith('rejected:') && (condFor === r.id ? (
                        <div className="row wrap">
                          <select value={condWatch} onChange={(e) => setCondWatch(e.target.value)} onKeyDown={(e) => e.stopPropagation()}>
                            <option value="">tie to a watch (optional)</option>
                            {approved.map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.def.purpose}
                              </option>
                            ))}
                          </select>
                          <input className="grow" placeholder="what would make us reconsider" value={condText} onChange={(e) => setCondText(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') addCondition(r); }} />
                          <button className="small primary" onClick={() => addCondition(r)}>
                            Keep
                          </button>
                          <button className="small" onClick={() => setCondFor(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button className="link small" onClick={() => setCondFor(r.id)}>
                          {(r.conditions ?? []).length ? 'add a condition…' : 'what would make us reconsider?'}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="muted small">
                    {r.source ? `source: ${r.source} · ` : ''}
                    {r.period ? `period: ${r.period} · ` : r.kind === 'source' ? 'period not set · ' : ''}
                    {r.reviewBy ? `review by ${r.reviewBy} · ` : ''}
                    arrived {new Date(r.arrivedAt).toLocaleDateString()} · {byName(r)}
                    {!ro && (
                      <>
                        {' '}
                        {r.status === 'proposed' && (
                          <button className="link small" onClick={() => void confirmRecord(r)}>
                            confirm
                          </button>
                        )}
                        {r.inferred && (
                          <button className="link small" onClick={() => void confirmReading(r)}>
                            yes, that's it
                          </button>
                        )}
                        {(r.kind === 'question' || r.kind === 'contradiction' || r.kind === 'hypothesis') && (
                          <button
                            className="link small"
                            onClick={() => {
                              const a = prompt(r.kind === 'contradiction' ? 'Which source is right, and why? (kept as the resolution)' : r.kind === 'hypothesis' ? 'What did the evidence show? (kept as the resolution)' : 'The answer (kept as a fact, with this question as its source):', '');
                              if (a && a.trim()) void resolveRecord(r, a.trim(), r.kind === 'question');
                            }}
                          >
                            {r.kind === 'contradiction' ? 'settle' : r.kind === 'hypothesis' ? 'conclude' : 'answer'}
                          </button>
                        )}
                        <button
                          className="link small"
                          onClick={() => {
                            setEditing(r.id);
                            setDraft(r.text);
                          }}
                        >
                          correct
                        </button>
                        {r.kind === 'source' && (
                          <button
                            className="link small"
                            onClick={() => {
                              const p = prompt('Period this data describes (e.g. 2026-09, week 40):', r.period ?? '');
                              if (p !== null) void correctRecord(r, { period: p });
                            }}
                          >
                            set period
                          </button>
                        )}
                        {(r.kind === 'objective' || r.kind === 'constraint' || r.kind === 'exclusion' || r.kind === 'decision') && (
                          <button
                            className="link small"
                            onClick={() => {
                              const p = prompt('Reconfirm this by (YYYY-MM-DD) — a consequential assumption should carry a review date:', r.reviewBy ?? '');
                              if (p !== null) void correctRecord(r, { reviewBy: p.trim() });
                            }}
                          >
                            review by
                          </button>
                        )}
                        <button className="link small" onClick={() => void retireRecord(r)}>
                          retire
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      {!current.length && <div className="muted small">Nothing recorded yet — imports, what matters and what to leave out appear here, each with its origin and status.</div>}
      {done.length > 0 && (
        <div className="small">
          <button className="link small" onClick={() => setSettled((v) => !v)}>
            {settled ? 'hide settled' : `settled · ${done.length}`}
          </button>
          {settled &&
            done.map((r) => (
              <div key={r.id} className="ctx-item resolved muted">
                {r.text} — <i>{r.resolution ?? 'resolved'}</i>
              </div>
            ))}
        </div>
      )}
      {dismissed.length > 0 && (
        <div>
          <div className="brief-h">Set aside</div>
          {dismissed.map((d) => (
            <div key={d.id} className="ctx-item muted small">
              {d.purpose} — {d.reason}
              {d.reason === 'not now' ? ' (returns with the next snapshot)' : ''} · {d.by}
              {!ro && (
                <>
                  {' '}
                  <button className="link small" onClick={() => void restoreSuggestion(d.id)}>
                    bring back
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {!ro && !more && (
        <button className="link small" onClick={() => setMore(true)}>
          record something else (a decision, a question, something expected, a fact, a hypothesis, a conflict)…
        </button>
      )}
      {!ro && more && (
        <div className="ctx-add">
          <div className="row wrap">
            <select value={kind} onChange={(e) => setKind(e.target.value as RecordKind)} onKeyDown={(e) => e.stopPropagation()}>
              {RECORD_KINDS.filter((k) => k !== 'source').map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input className="grow" placeholder={KIND_HINT[kind] ?? 'In your words, e.g. preserve replacement-cost margin'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <input className="period" placeholder="period" value={period} onChange={(e) => setPeriod(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <button
              className="primary"
              disabled={!text.trim()}
              onClick={() => {
                const st = statementOf(`${kind}: ${text.trim()}`);
                void remember(kind, st?.text ?? text.trim(), { ...(st?.extra ?? {}), period: period.trim() || undefined });
                setText('');
                setPeriod('');
              }}
            >
              Record
            </button>
          </div>
          {KIND_HINT[kind] && <div className="muted small">{KIND_HINT[kind]}</div>}
        </div>
      )}
    </div>
  );
}

function InvestigationView({ inv, fileId }: { inv: Investigation; fileId: string }) {
  const [open, setOpen] = useState(inv.status === 'running');
  const ro = readOnly();
  void fileId;
  const badge = inv.status === 'running' ? (inv.cancelRequested ? 'stopping…' : inv.superseded ? 'running — overtaken, its result will be set aside' : 'running…') : inv.status === 'failed' ? (inv.error?.startsWith('interrupted') ? 'interrupted — nothing it proposed is current' : 'failed') : inv.status === 'cancelled' ? 'stopped' : inv.status === 'superseded' ? 'superseded — direction changed while it ran' : inv.stale ? 'provisional — assumptions changed since' : 'done';
  return (
    <div className={`investigation ${inv.status} ${inv.stale ? 'stale' : ''}`}>
      <div className="row">
        <b className="grow">{inv.question}</b>
        <span className={`badge ${inv.status === 'running' ? 'amber' : inv.status === 'failed' ? 'red' : inv.status === 'cancelled' || inv.status === 'superseded' || inv.stale ? '' : 'green'}`}>{badge}</span>
        {inv.status === 'running' && !inv.cancelRequested && !ro && (
          <button className="small" onClick={() => void stopInvestigation(inv)} title="Stop it; nothing it proposes afterwards counts">
            Stop
          </button>
        )}
      </div>
      <div className="muted small">
        started {ago(inv.startedAt)} by {inv.by.name}
        {inv.model ? ` · ${inv.model}` : ''} · {inv.runs.length} sandboxed run{inv.runs.length === 1 ? '' : 's'} · {inv.records.length} proposed record{inv.records.length === 1 ? '' : 's'} · {inv.proposals.length} proposal{inv.proposals.length === 1 ? '' : 's'}{' '}
        <button className="link small" onClick={() => setOpen((v) => !v)}>
          {open ? 'hide' : 'details'}
        </button>
      </div>
      {inv.status === 'failed' && <div className="err small">{inv.error}</div>}
      {inv.stale && <div className="small amber-text">Made under earlier assumptions (an objective, constraint or exclusion changed since) — re-run before relying on it.</div>}
      {open && inv.answer && (
        <div className="interpretation small">
          <div className="muted">The agent's findings — its words, beside the evidence:</div>
          <div className="pre">{inv.answer}</div>
        </div>
      )}
      {open && inv.steps.length > 0 && (
        <div className="small steps">
          {inv.steps.map((s, i) => (
            <div key={i}>
              <code>{s.tool}</code> {s.summary}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WatchingView({ watches, fileId, investigations, canInvestigate, stack }: { watches: Watch[]; fileId: string; investigations: Investigation[]; canInvestigate: boolean; stack: { available: boolean; reason?: string } | null }) {
  const ro = readOnly();
  const [adding, setAdding] = useState(false);
  const [def, setDef] = useState<Partial<WatchDef>>({ purpose: '', scope: '', formula: '', kind: 'worsening', bad: 'up', op: '>', value: 0, sustain: 2, response: 'brief' });
  const [explaining, setExplaining] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [details, setDetails] = useState<Record<string, boolean>>({});
  const cellsVersion = useStore((s) => s.cellsVersion);
  const version = useStore((s) => s.companionVersion);
  useEffect(() => {
    let alive = true;
    api.files
      .suggestions(fileId)
      .then((sg) => alive && setSuggestions(sg))
      .catch(() => alive && setSuggestions([]));
    return () => {
      alive = false;
    };
  }, [fileId, watches.length, cellsVersion, version]);
  const explain = async (w: Watch, again = false) => {
    if (!w.issue) return;
    setExplaining(w.id);
    try {
      await api.files.interpret(fileId, w.issue.id, again);
      void loadCompanion(fileId);
    } catch (e) {
      setStatus(`No interpretation: ${(e as Error).message}`, 8000);
    } finally {
      setExplaining(null);
    }
  };
  return (
    <div className="companion-section">
      {suggestions === null && <div className="muted small">Looking at the columns…</div>}
      {suggestions && suggestions.length > 0 && !ro && (
        <div className="suggestions">
          <div className="brief-h">Suggested from the columns — one tap each</div>
          {suggestions.map((sg) => (
            <div key={sg.id} className="suggestion">
              <div className="grow">
                <div>{sg.purpose}</div>
                <div className="muted small">
                  {sg.why}
                  {' · '}
                  <button className="link small" onClick={() => void dismissSuggestion(sg, 'not now').then(() => setSuggestions((s) => (s ?? []).filter((x) => x.id !== sg.id)))} title="Set aside until the next snapshot">
                    not now
                  </button>
                  <button className="link small" onClick={() => void dismissSuggestion(sg, 'not relevant').then(() => setSuggestions((s) => (s ?? []).filter((x) => x.id !== sg.id)))} title="Set aside; reviewable under Context → Set aside">
                    not relevant
                  </button>
                </div>
              </div>
              <button className="small" onClick={() => void acceptSuggestion(sg)} title={`${sg.def.formula} — ${ruleWords(sg.def)}`}>
                Watch this
              </button>
            </div>
          ))}
        </div>
      )}
      {watches.length > 0 && <div className="brief-h">Watching</div>}
      {watches.map((w) => {
        const comparable = w.observations.filter((o) => o.def === w.defHash && !o.error);
        const last = comparable[comparable.length - 1];
        const before = comparable.length > 1 ? comparable[comparable.length - 2] : undefined;
        const open = !!details[w.id];
        const leftOut = /\(excluding ([^)]+)\)/i.exec(w.def.scope)?.[1];
        return (
          <div key={w.id} className={`watch-item ${w.health}`}>
            <div className="row">
              <b className="grow">{w.def.purpose}</b>
              <span className={`badge ${w.health === 'attention' ? 'amber' : w.health === 'ok' ? 'green' : ''}`}>{HEALTH_LABEL[w.health]}</span>
            </div>
            <div className="small">
              {last ? (
                <>
                  <b>{fmtValue(last.value)}</b>
                  {last.period ? ` (${last.period})` : ''}
                  {before ? ` · was ${fmtValue(before.value)}${before.period ? ` on ${before.period}` : ''}` : ' · first snapshot'}
                  {typeof last.complement === 'number' ? <span className="muted"> · leaves out {fmtValue(last.complement)}{leftOut ? ` (${leftOut})` : ''}{before && typeof before.complement === 'number' && before.complement !== last.complement ? `, was ${fmtValue(before.complement)}` : ''}</span> : null}
                </>
              ) : (
                'no observation yet'
              )}
              {w.observations[w.observations.length - 1]?.error ? ` · ${w.observations[w.observations.length - 1].error}` : ''}
            </div>
            <div className="muted small">
              {ruleWords(w.def)}
              {w.def.sustain > 1 && w.def.kind !== 'change' ? ` for ${w.def.sustain} snapshots` : ''}
              {w.def.scope ? ` · ${w.def.scope}` : ''}
              {' · '}
              <button className="link small" onClick={() => setDetails({ ...details, [w.id]: !open })}>
                {open ? 'hide details' : 'details'}
              </button>
            </div>
            {open && (
              <div className="muted small">
                <code>{w.def.formula}</code>
                {w.def.complement ? (
                  <>
                    {' · leaves out: '}
                    <code>{w.def.complement}</code>
                  </>
                ) : null}
                {w.def.sources?.length && w.def.freshnessHours ? ` · needs ${w.def.sources.join(', ')} fresh within ${w.def.freshnessHours} h` : ''}
                {' · '}
                {comparable.length} snapshot{comparable.length === 1 ? '' : 's'} compared · checked {ago(w.lastChecked)} · {w.origin === 'agent' ? 'proposed by an agent' : `by ${w.by.name}`}
                {w.history.length ? ` · needed attention ${w.history.length + (w.issue?.status === 'open' ? 1 : 0)} time${w.history.length + (w.issue?.status === 'open' ? 1 : 0) === 1 ? '' : 's'}` : ''}
              </div>
            )}
            {w.issue?.status === 'open' && (
              <div className="issue">
                <div>
                  <b>Needs attention:</b> {w.issue.summary}
                </div>
                <div className="small">
                  <b>Evidence:</b> {w.issue.evidence.join('; ')}
                </div>
                {w.issue.uncertainty.length > 0 && (
                  <div className="small">
                    <b>Uncertainty:</b> {w.issue.uncertainty.join('; ')}
                  </div>
                )}
                <div className="small">
                  <b>Next:</b> {w.issue.next}
                </div>
                {w.issue.interpretation ? (
                  <div className="interpretation small">
                    <div className="muted">The model's reading ({w.issue.interpretation.model}, revision {w.issue.interpretation.revision}) — its words, beside the evidence above:</div>
                    <div className="pre">{w.issue.interpretation.text}</div>
                    {!ro && (
                      <button className="link small" onClick={() => void explain(w, true)} disabled={explaining === w.id}>
                        ask again
                      </button>
                    )}
                  </div>
                ) : (
                  !ro && (
                    <div className="row wrap">
                      <button className="small" disabled={!canInvestigate} title={stack?.available ? 'A bounded investigation: the agent reads the context, computes independently in the sandbox and proposes; it changes nothing' : `The investigation stack is not available: ${stack?.reason ?? 'not probed yet'}`} onClick={() => void investigate(undefined, w.issue!.id)}>
                        Investigate (agent)
                      </button>
                    </div>
                  )
                )}
              </div>
            )}
            {!ro && (
              <div className="row wrap small">
                {w.authority === 'proposed' && (
                  <button className="primary small" onClick={() => void approveWatch(w)}>
                    Approve
                  </button>
                )}
                {w.def.kind === 'threshold' && w.authority === 'approved' && (
                  <button
                    className="small"
                    onClick={() => {
                      const v = prompt(`New threshold for “${w.def.purpose}” (currently ${w.def.op} ${w.def.value}). This is recorded as your decision.`, String(w.def.value ?? 0));
                      if (v === null || v.trim() === '' || !Number.isFinite(Number(v))) return;
                      const reason = prompt('Why? (kept with the decision)', '') ?? '';
                      void changeWatch(w, { value: Number(v) }, reason);
                    }}
                  >
                    Move threshold…
                  </button>
                )}
                <button className="small" onClick={() => void removeWatch(w)}>
                  Stop watching
                </button>
              </div>
            )}
          </div>
        );
      })}
      {!watches.length && (!suggestions || !suggestions.length) && <div className="muted small">Nothing is being watched yet. Import a sheet with a header row and the companion will suggest what to watch.</div>}
      {!ro &&
        (adding ? (
          <div className="watch-form">
            <input placeholder="Purpose, e.g. Vehicles over 90 days in stock (excluding reserved)" value={def.purpose} onChange={(e) => setDef({ ...def, purpose: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
            <input placeholder='Formula, e.g. =COUNTIFS(Inventory[Days in stock], ">90", Inventory[Reserved], "no")' value={def.formula} onChange={(e) => setDef({ ...def, formula: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="mono" />
            <input placeholder="Scope and exclusions, in words" value={def.scope} onChange={(e) => setDef({ ...def, scope: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
            <div className="row wrap">
              <select value={def.kind} onChange={(e) => setDef({ ...def, kind: e.target.value as WatchDef['kind'] })}>
                <option value="worsening">tell me when it gets worse</option>
                <option value="threshold">tell me when it passes a limit</option>
                <option value="check">must stay TRUE</option>
                <option value="change">tell me when it changes</option>
              </select>
              {def.kind === 'worsening' && (
                <select value={def.bad} onChange={(e) => setDef({ ...def, bad: e.target.value as 'up' | 'down' })}>
                  <option value="up">worse = higher</option>
                  <option value="down">worse = lower</option>
                </select>
              )}
              {def.kind === 'threshold' && (
                <>
                  <select value={def.op} onChange={(e) => setDef({ ...def, op: e.target.value as WatchDef['op'] })}>
                    {['>', '>=', '<', '<=', '=', '!='].map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  <input className="num" type="number" value={def.value} onChange={(e) => setDef({ ...def, value: Number(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />
                </>
              )}
              <label className="small">
                after{' '}
                <input className="num" type="number" min={1} max={50} value={def.sustain} onChange={(e) => setDef({ ...def, sustain: Number(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} title="snapshots in a row before it is raised" />{' '}
                snapshot{(def.sustain ?? 1) === 1 ? '' : 's'} in a row
              </label>
            </div>
            <div className="row">
              <button
                className="primary"
                disabled={!def.formula?.trim()}
                onClick={() => {
                  void addWatch(def).then((w) => w && setAdding(false));
                }}
              >
                Watch
              </button>
              <button onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="link small" onClick={() => setAdding(true)}>
            write your own watch…
          </button>
        ))}
      {investigations.length > 0 && (
        <div className="investigations">
          <div className="brief-h">Investigations</div>
          {[...investigations].reverse().map((inv) => (
            <InvestigationView key={inv.id} inv={inv} fileId={fileId} />
          ))}
        </div>
      )}
    </div>
  );
}
