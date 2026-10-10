import { useEffect, useState } from 'react';
import { api, RECORD_KINDS, type ContextRecord, type RecordKind, type Suggestion, type Watch, type WatchDef } from '../api/client';
import { readOnly, setStatus, useStore } from '../state/store';
import { acceptSuggestion, addWatch, approveWatch, changeWatch, checkNow, clearReflection, confirmRecord, correctRecord, loadCompanion, markSeen, remember, removeRecord, removeWatch, retireRecord, useCompanion } from './companion';

const KIND_LABEL: Record<RecordKind, string> = { objective: 'What matters', exclusion: 'Left out', decision: 'Decisions', fact: 'Facts', source: 'Snapshots and sources', hypothesis: 'Hypotheses', contradiction: 'Contradictions' };
const HEALTH_LABEL: Record<Watch['health'], string> = { ok: 'fine', baseline: 'waiting for the next snapshot', attention: 'needs attention', stale: 'not checked — source stale', error: 'cannot evaluate', unchecked: 'not checked yet', proposed: 'proposed — needs your approval' };
const ruleWords = (d: WatchDef) => (d.kind === 'threshold' ? `${d.op === '>' ? 'more than' : d.op === '>=' ? 'at least' : d.op === '<' ? 'below' : d.op === '<=' ? 'at most' : d.op === '=' ? 'equal to' : 'not'} ${fmtValue(d.value)}` : d.kind === 'check' ? 'must stay TRUE' : d.kind === 'worsening' ? `${d.bad === 'down' ? 'falling' : 'rising'} snapshot after snapshot` : 'any change');
const ago = (iso?: string) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const fmtValue = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : String(v ?? '—'));

/** The brief at the top of Ask: what changed, why it matters, what next — with Context and Watching on demand. */
export function CompanionBrief() {
  const fileId = useStore((s) => s.fileId);
  const version = useStore((s) => s.companionVersion);
  const data = useCompanion((s) => (fileId ? s.byDoc[fileId] : undefined));
  const reflection = useCompanion((s) => (fileId ? s.reflection[fileId] : undefined));
  const [view, setView] = useState<'none' | 'context' | 'watching'>('none');
  useEffect(() => {
    if (fileId) void loadCompanion(fileId);
  }, [fileId, version]);
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
        <div className="muted small">The companion builds an understanding of a saved document as you add to it: imports, objectives, exclusions, decisions, watches. Save the document to start.</div>
      </div>
    );
  }
  if (!data) return <div className="companion muted small">Loading the brief…</div>;
  const b = data.brief;
  const h = b.health;
  const attention = h.attention;
  const checked = h.checked ? `checked ${ago(h.checked)}` : data.watches.some((w) => w.authority === 'approved') ? 'not checked yet' : '';
  const healthText = [h.ok ? `${h.ok} fine` : '', h.baseline ? `${h.baseline} waiting for the next snapshot` : '', h.stale ? `${h.stale} stale` : '', h.error ? `${h.error} cannot evaluate` : '', h.proposed ? `${h.proposed} proposed` : ''].filter(Boolean).join(' · ');
  const worthALook = !attention && data.events.some((e) => e.level === 'watch' && (!data.seenAt || e.at > data.seenAt));
  return (
    <div className={`companion ${attention ? 'attention' : ''}`}>
      <div className="companion-head">
        <b className="companion-lead">{attention ? `${attention} need${attention === 1 ? 's' : ''} attention` : b.matters[0]?.startsWith('Not checked') ? 'Not checked' : worthALook ? 'Worth a look' : 'All quiet'}</b>
        <span className="muted small">
          {checked}
          {healthText ? ` · ${healthText}` : ''}
        </span>
      </div>
      {reflection && (
        <div className="reflection">
          {reflection.lines.map((l, i) => (
            <div key={i} className="reflection-line">
              <span>{l.text}</span>
              {l.record && (
                <>
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
      <div className="brief">
        <div className="brief-col">
          <div className="brief-h">What has changed</div>
          {b.changed.length ? b.changed.slice(-4).map((t, i) => <div key={i}>{t}</div>) : <div className="muted">Nothing since you last looked.</div>}
        </div>
        <div className="brief-col">
          <div className="brief-h">Why it matters</div>
          {b.matters.map((t, i) => (
            <div key={i} className={attention && i < attention ? 'matters-attention' : ''}>
              {t}
            </div>
          ))}
        </div>
        <div className="brief-col">
          <div className="brief-h">What to do next</div>
          {b.next.map((t, i) => (
            <div key={i}>{t}</div>
          ))}
        </div>
      </div>
      <div className="row wrap companion-actions">
        <button className={view === 'context' ? 'active' : ''} onClick={() => setView(view === 'context' ? 'none' : 'context')}>
          Context{data.records.filter((r) => r.status !== 'retired' && r.status !== 'superseded').length ? ` · ${data.records.filter((r) => r.status !== 'retired' && r.status !== 'superseded').length}` : ''}
        </button>
        <button className={view === 'watching' ? 'active' : ''} onClick={() => setView(view === 'watching' ? 'none' : 'watching')}>
          Watching{data.watches.length ? ` · ${data.watches.length}` : ''}
        </button>
        <button onClick={() => void checkNow()} title="Re-evaluate every approved watch now (checks also run after each change and on a timer)">
          Check now
        </button>
      </div>
      {view === 'context' && <ContextView records={data.records} sources={b.sources} />}
      {view === 'watching' && <WatchingView watches={data.watches} fileId={fileId} />}
    </div>
  );
}

function QuickRecord({ kind, placeholder }: { kind: RecordKind; placeholder: string }) {
  const [text, setText] = useState('');
  return (
    <div className="row">
      <input
        className="grow"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && text.trim()) {
            void remember(kind, text.trim());
            setText('');
          }
        }}
      />
      <button
        className="small"
        disabled={!text.trim()}
        onClick={() => {
          void remember(kind, text.trim());
          setText('');
        }}
      >
        Keep
      </button>
    </div>
  );
}

function ContextView({ records, sources }: { records: ContextRecord[]; sources: Companion['brief']['sources'] }) {
  const [kind, setKind] = useState<RecordKind>('fact');
  const [text, setText] = useState('');
  const [period, setPeriod] = useState('');
  const [more, setMore] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const ro = readOnly();
  const live = records.filter((r) => r.status !== 'retired' && r.status !== 'superseded');
  const groups = RECORD_KINDS.map((k) => [k, live.filter((r) => r.kind === k)] as const).filter(([, rs]) => rs.length);
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
            <div key={r.id} className={`ctx-item ${r.status}`}>
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
                    {r.status === 'proposed' && <span className="badge amber">proposed by {r.by.name}</span>}
                    {r.status === 'confirmed' && <span className="badge green">confirmed</span>}
                  </div>
                  <div className="muted small">
                    {r.source ? `source: ${r.source} · ` : ''}
                    {r.period ? `period: ${r.period} · ` : r.kind === 'source' ? 'period not set · ' : ''}
                    arrived {new Date(r.arrivedAt).toLocaleDateString()} · {r.origin === 'agent' ? 'an agent' : r.by.name}
                    {!ro && (
                      <>
                        {' '}
                        {r.status === 'proposed' && (
                          <button className="link small" onClick={() => void confirmRecord(r)}>
                            confirm
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
      {!live.length && <div className="muted small">Nothing recorded yet — imports, what matters and what to leave out appear here, each with its origin and status.</div>}
      {!ro && !more && (
        <button className="link small" onClick={() => setMore(true)}>
          record something else (a fact, a decision, a hypothesis, a contradiction)…
        </button>
      )}
      {!ro && more && (
        <div className="row wrap ctx-add">
          <select value={kind} onChange={(e) => setKind(e.target.value as RecordKind)}>
            {RECORD_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input className="grow" placeholder="In your words, e.g. preserve replacement-cost margin" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <input className="period" placeholder="period" value={period} onChange={(e) => setPeriod(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button
            className="primary"
            disabled={!text.trim()}
            onClick={() => {
              void remember(kind, text.trim(), { period: period.trim() || undefined });
              setText('');
              setPeriod('');
            }}
          >
            Record
          </button>
        </div>
      )}
    </div>
  );
}

type Companion = import('../api/client').Companion;

function WatchingView({ watches, fileId }: { watches: Watch[]; fileId: string }) {
  const ro = readOnly();
  const [adding, setAdding] = useState(false);
  const [def, setDef] = useState<Partial<WatchDef>>({ purpose: '', scope: '', formula: '', kind: 'worsening', bad: 'up', op: '>', value: 0, sustain: 2, response: 'brief' });
  const [explaining, setExplaining] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [details, setDetails] = useState<Record<string, boolean>>({});
  const cellsVersion = useStore((s) => s.cellsVersion);
  useEffect(() => {
    let live = true;
    api.files
      .suggestions(fileId)
      .then((sg) => live && setSuggestions(sg))
      .catch(() => live && setSuggestions([]));
    return () => {
      live = false;
    };
  }, [fileId, watches.length, cellsVersion]);
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
                <div className="muted small">{sg.why}</div>
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
                {w.def.sources?.length && w.def.freshnessHours ? ` · needs ${w.def.sources.join(', ')} fresh within ${w.def.freshnessHours} h` : ''}
                {' · '}
                {comparable.length} snapshot{comparable.length === 1 ? '' : 's'} compared · checked {ago(w.lastChecked)} · {w.origin === 'agent' ? 'proposed by an agent' : `by ${w.by.name}`}
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
                    <button className="small" onClick={() => void explain(w)} disabled={explaining === w.id}>
                      {explaining === w.id ? 'Asking the model…' : 'Explain (asks the model)'}
                    </button>
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
    </div>
  );
}
