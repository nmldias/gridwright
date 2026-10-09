import { useEffect, useMemo, useState } from 'react';
import * as book from '../engine/book';
import { a1, isCodeKind, refText, type CheckView } from '../engine/types';
import { selectCell, selectRange } from '../grid/actions';
import { getState, readOnly, setStatus, useStore } from '../state/store';
import { clearTrace, removeSignoff, setSignoffLocked, signOffSelection, traceActiveCell, traceStep } from './review';
import { statusOf, type RunStatus } from '../workers/runs';
import { runCell } from '../workers/runner';
import { api, ProposalConflictError, type Proposal } from '../api/client';
import { getClientId } from '../api/ws';
import { putProposal } from './proposals';

const RUN_LABEL: Record<RunStatus, string> = {
  matches: 'matches recorded run',
  'inputs-changed': 'inputs changed since run',
  'code-changed': 'code changed since run',
  'output-changed': 'output differs from recorded run',
  failed: 'failed',
  'not-run': 'not run in this session',
};

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** A proposal's preview split into the edits themselves and what moves because of them. */
function splitPreview(p: Proposal) {
  const edits = p.preview.filter((l) => !l.effect);
  const effects = p.preview.filter((l) => l.effect);
  return { edits, effects };
}

function DiffRows({ lines, max, effect }: { lines: Proposal['preview']; max: number; effect?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, max);
  return (
    <table className={`diff-table ${effect ? 'effects' : ''}`}>
      <tbody>
        {shown.map((l, i) => (
          <tr key={i} className={effect ? 'effect' : l.before === '' ? 'added' : l.after === '' ? 'removed' : 'changed'}>
            <td>{l.where}</td>
            <td className="old">{l.before}</td>
            <td className="new">{l.after}</td>
          </tr>
        ))}
        {lines.length > shown.length && (
          <tr>
            <td colSpan={3} className="muted">
              <button className="link small" onClick={() => setAll(true)}>
                … {lines.length - shown.length} more
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function ReviewPanel() {
  const tables = useStore((s) => s.tables);
  const selection = useStore((s) => s.selection);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const trace = useStore((s) => s.trace);
  const permission = useStore((s) => s.permission);
  const me = useStore((s) => s.me);
  const runsVersion = useStore((s) => s.runsVersion);
  const fileId = useStore((s) => s.fileId);
  const seqNow = useStore((s) => s.seq);
  const proposals = useStore((s) => s.proposals);
  const [showDecided, setShowDecided] = useState(false);
  const [pnote, setNoteFor] = useState<Record<string, string>>({});
  // the server commits the decision: it re-validates the actions at the revision we reviewed, writes the
  // operations and the decision to the log together, and relays the operations to every session (ours too)
  const decide = async (p: Proposal, decision: 'applied' | 'rejected') => {
    if (!fileId) return;
    const command = `${getClientId()}-${p.id}-${Date.now().toString(36)}`;
    try {
      const decided = await api.files.decide(fileId, p.id, decision, pnote[p.id] || undefined, p.seq, getClientId(), command);
      putProposal(decided);
      if (decision === 'applied') setStatus(`Applied: ${decided.appliedSeqs?.length ?? 0} change(s) committed at log position ${decided.appliedSeq ?? '?'}`, 5000);
    } catch (e) {
      if (e instanceof ProposalConflictError) {
        if (e.proposal) putProposal(e.proposal);
        setStatus(`Not applied — ${e.message}`, 10000);
        return;
      }
      setStatus(`Could not record the decision: ${(e as Error).message}`, 6000);
    }
  };
  const refresh = async (p: Proposal) => {
    if (!fileId) return;
    try {
      putProposal(await api.files.refreshProposal(fileId, p.id));
    } catch (e) {
      setStatus(`Could not refresh the preview: ${(e as Error).message}`, 6000);
    }
  };
  const pending = proposals.filter((p) => p.status === 'pending');
  const cellsMap = useStore((s) => s.cells);
  const codeCells = useMemo(() => {
    const out: { table: number; row: number; col: number; kind: string; status: RunStatus; record?: ReturnType<typeof statusOf>['record'] }[] = [];
    for (const [tid, map] of cellsMap) {
      for (const c of map.values()) {
        if (!isCodeKind(c.k) || c.s) continue;
        const st = statusOf({ table: tid, row: c.r, col: c.c }, c.i);
        out.push({ table: tid, row: c.r, col: c.c, kind: c.k, status: st.status, record: st.record });
      }
    }
    return out.sort((a, b) => a.table - b.table || a.row - b.row || a.col - b.col);
  }, [cellsMap, cellsVersion, runsVersion]);
  const unverified = codeCells.filter((c) => c.status !== 'matches').length;
  const [note, setNote] = useState('');
  const [lock, setLock] = useState(true);
  const [checks, setChecks] = useState<CheckView[]>([]);
  useEffect(() => {
    try {
      setChecks(book.checks());
    } catch {
      setChecks([]);
    }
  }, [cellsVersion]);
  const meta = selection ? tables.get(selection.table) : undefined;
  const stale = useMemo(() => {
    if (!meta || !meta.signoffs?.length) return new Set<number>();
    try {
      return new Set(book.signoffStatus(meta.id).filter((s) => s.stale).map((s) => s.id));
    } catch {
      return new Set<number>();
    }
  }, [meta, cellsVersion]);
  const canSign = permission === 'sign' || !readOnly();
  const failing = checks.filter((c) => !c.ok);
  const selText = selection && meta ? refText(meta.name, selection.r0, selection.c0, selection.r1, selection.c1) : '';
  const effectsPending = pending.reduce((n, p) => n + splitPreview(p).effects.length, 0);

  return (
    <div className="panel review-panel">
      <h3>Review</h3>
      <div className="review-summary">
        <div className={`lead ${pending.length ? 'amber' : ''}`}>{pending.length ? `${plural(pending.length, 'change')} awaiting approval` : 'Nothing awaiting approval'}</div>
        <div className="muted small">
          {pending.length && effectsPending ? `${plural(effectsPending, 'cell')} would move as a result · ` : ''}
          {checks.length ? (failing.length ? `${plural(failing.length, 'check')} failing` : `all ${checks.length} checks pass`) : 'no checks'} ·{' '}
          {codeCells.length ? (unverified ? `${plural(unverified, 'code cell')} not matching ${unverified === 1 ? 'its' : 'their'} recorded run` : `all ${codeCells.length} code cells match their recorded runs`) : 'no code cells'}
        </div>
      </div>

      <h4>
        Awaiting approval <span className={`badge ${pending.length ? 'amber' : ''}`}>{pending.length ? `${pending.length} pending` : 'none pending'}</span>
      </h4>
      {!fileId && <div className="muted small">Save the document to receive proposals from agents.</div>}
      {fileId && !pending.length && <div className="muted small">Edits filed by agents wait here, as the numbers they change and the numbers that move as a result, until someone applies or rejects them.</div>}
      {(showDecided ? proposals : pending).map((p) => {
        const { edits, effects } = splitPreview(p);
        const drifted = p.seq && seqNow > p.seq && p.status === 'pending';
        return (
          <div key={p.id} className={`proposal ${p.status}`}>
            <div className="row">
              <b className="grow">{p.title}</b>
              <span className={`badge ${p.status === 'pending' ? 'amber' : p.status === 'applied' ? 'green' : ''}`}>{p.status}</span>
            </div>
            <div className="muted small">
              {p.by.name} via {p.agent} · {new Date(p.at).toLocaleString()}
            </div>
            {p.rationale && <div className="small">{p.rationale}</div>}
            {p.errors.length > 0 && <div className="err small">{p.errors.join('; ')}</div>}
            <div className="small">
              <b>{plural(edits.length, 'change')}</b>
              {effects.length ? ` · ${plural(effects.length, 'cell')} would move as a result` : ' · nothing else moves'}
            </div>
            <DiffRows lines={edits} max={12} />
            {effects.length > 0 && (
              <>
                <div className="muted small">As a result</div>
                <DiffRows lines={effects} max={8} effect />
              </>
            )}
            {drifted ? (
              <div className="small amber-text">
                The document changed {plural(seqNow - p.seq, 'time')} since this preview was made.{' '}
                <button className="link small" onClick={() => void refresh(p)}>
                  refresh the preview
                </button>
              </div>
            ) : null}
            {p.status === 'pending' ? (
              <div className="row">
                <input className="grow" placeholder="Decision note (optional)" value={pnote[p.id] ?? ''} onChange={(e) => setNoteFor({ ...pnote, [p.id]: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                <button className="primary" disabled={readOnly()} onClick={() => void decide(p, 'applied')}>
                  Apply
                </button>
                <button disabled={readOnly()} onClick={() => void decide(p, 'rejected')}>
                  Reject
                </button>
              </div>
            ) : (
              <div className="muted small">
                {p.status} by {p.decidedBy?.name ?? '—'} · {p.decidedAt ? new Date(p.decidedAt).toLocaleString() : ''}
                {p.decisionNote ? ` · ${p.decisionNote}` : ''}
              </div>
            )}
            <details className="evidence">
              <summary>Evidence</summary>
              <div className="muted small">
                proposal {p.id} · reviewed at revision {p.seq} · {plural(p.ops.length, 'operation')}
                {p.appliedSeqs?.length ? ` · committed as log entries ${p.appliedSeqs[0]}–${p.appliedSeqs[p.appliedSeqs.length - 1]}` : ''}
                {p.command ? ` · command ${p.command}` : ''}
                <br />
                The server re-validates the actions at this revision when a decision is made; a decision made against an outdated preview is refused, and the same decision sent twice is applied once.
              </div>
            </details>
          </div>
        );
      })}
      {proposals.length > pending.length && (
        <button className="link small" onClick={() => setShowDecided((v) => !v)}>
          {showDecided ? 'hide decided proposals' : `show ${plural(proposals.length - pending.length, 'decided proposal')}`}
        </button>
      )}

      <h4>
        Checks{' '}
        <span className={`badge ${failing.length ? 'amber' : checks.length ? 'green' : ''}`}>{checks.length ? (failing.length ? `${failing.length} failing` : 'all passing') : 'none'}</span>
      </h4>
      {!checks.length && (
        <p className="muted small">
          Write <code>=CHECK(condition, "label")</code> anywhere; every check is listed here with its outcome.
        </p>
      )}
      {checks.map((c) => (
        <button key={`${c.table}:${c.row}:${c.col}`} className={`list-item check-item ${c.ok ? 'ok' : 'fail'}`} onClick={() => selectCell(c.table, c.row, c.col)}>
          <span className="mark">{c.error ? '!' : c.ok ? '✓' : '✗'}</span> {c.label}
          <span className="muted small">
            {' '}
            · {tables.get(c.table)?.name ?? c.table}!{a1(c.row, c.col)}
          </span>
        </button>
      ))}

      <h4>
        Code cells{' '}
        <span className={`badge ${codeCells.length ? (unverified ? 'amber' : 'green') : ''}`}>{codeCells.length ? (unverified ? `${unverified} not matching` : 'all match recorded runs') : 'none'}</span>
      </h4>
      {!codeCells.length && <p className="muted small">A code cell matches when the value on screen is the recorded result of the current code and the current inputs.</p>}
      {codeCells.map((c) => (
        <div key={`${c.table}:${c.row}:${c.col}`} className={`run-item ${c.status}`}>
          <button className="link" onClick={() => selectCell(c.table, c.row, c.col)}>
            {tables.get(c.table)?.name ?? c.table}!{a1(c.row, c.col)}
          </button>{' '}
          <span className="pill">{c.kind}</span> <span className={`badge ${c.status === 'matches' ? 'green' : c.status === 'not-run' ? '' : 'amber'}`}>{RUN_LABEL[c.status]}</span>
          {c.status !== 'matches' && (
            <>
              {' '}
              <button className="link small" disabled={readOnly()} onClick={() => runCell({ table: c.table, row: c.row, col: c.col })}>
                run now
              </button>
            </>
          )}
          {c.record && (
            <details className="evidence">
              <summary>Evidence</summary>
              <div className="muted small">
                {new Date(c.record.at).toLocaleString()} · {c.record.ms} ms · {c.record.runtime.name}
                {c.record.runtime.version ? ` ${c.record.runtime.version.slice(0, 20)}` : ''}
                {c.record.attested === 'server' ? ' · attested by the server' : c.record.attested === 'client' ? ' · reported by a browser' : ''}
                {c.record.seq ? ` · logged #${c.record.seq}` : ''}
                {Object.keys(c.record.runtime.packages).filter((k) => k !== 'connection').length ? (
                  <>
                    <br />
                    {Object.entries(c.record.runtime.packages)
                      .filter(([k]) => k !== 'connection')
                      .map(([k, v]) => `${k} ${v}`)
                      .join(', ')
                      .slice(0, 160)}
                  </>
                ) : null}
                <br />
                code {c.record.codeHash.slice(0, 8)} · inputs {c.record.inputsHash.slice(0, 8)} · output {c.record.outputHash.slice(0, 8)}
                {c.record.error ? ` · ${c.record.error.slice(0, 120)}` : ''}
              </div>
            </details>
          )}
        </div>
      ))}

      <h4>Sign-offs</h4>
      {meta ? (
        <>
          <div className="row">
            <input className="grow" value={note} placeholder={`Note for ${selText}`} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Lock the range
            </label>
            <button
              className="primary"
              disabled={!canSign}
              onClick={() => {
                if (signOffSelection(note, lock)) setNote('');
              }}
              title={canSign ? `Sign off ${selText} as ${me.name || 'Guest'}` : 'You cannot sign this document'}
            >
              Sign off selection
            </button>
          </div>
          {meta.signoffs?.length ? (
            <div className="signoff-list">
              {meta.signoffs.map((s) => (
                <div key={s.id} className={`signoff ${stale.has(s.id) ? 'stale' : 'ok'}`}>
                  <button className="link" onClick={() => selectRange(meta.id, s.r0, s.c0, s.r1, s.c1)} title="Select the signed range">
                    {refText(meta.name, s.r0, s.c0, s.r1, s.c1)}
                  </button>
                  <span className={`badge ${stale.has(s.id) ? 'amber' : 'green'}`}>{stale.has(s.id) ? 'changed since' : 'unchanged'}</span>
                  <div className="muted small">
                    {s.by || 'someone'}
                    {s.login ? ` (${s.login})` : ''} · {s.at ? new Date(s.at).toLocaleString() : ''}
                    {s.note ? ` · ${s.note}` : ''}
                  </div>
                  <div className="row">
                    <button disabled={!canSign} onClick={() => setSignoffLocked(meta.id, s.id, !s.locked)}>
                      {s.locked ? 'Unlock' : 'Lock'}
                    </button>
                    <button disabled={!canSign} onClick={() => removeSignoff(meta.id, s.id)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted small">No sign-offs on “{meta.name}” yet. A sign-off records who attested a range and when; it turns amber if any value inside changes afterwards.</div>
          )}
        </>
      ) : (
        <div className="muted small">Select cells to sign them off.</div>
      )}

      <h4>Trace</h4>
      <div className="row wrap">
        <button onClick={() => traceActiveCell()} disabled={!selection} title="Show which cells the active cell reads (navy) and which cells read it (coral)">
          Trace active cell
        </button>
        <button onClick={() => traceStep('precedents')} disabled={!selection} title="Ctrl+[">
          ← Precedents
        </button>
        <button onClick={() => traceStep('dependents')} disabled={!selection} title="Ctrl+]">
          Dependents →
        </button>
        <button onClick={() => clearTrace()} disabled={!trace}>
          Clear
        </button>
      </div>
      {trace && (
        <div className="small">
          <div>
            <b>{tables.get(trace.cell.table)?.name}</b>!{a1(trace.cell.row, trace.cell.col)} reads {plural(trace.precedents.length, 'range')} and is read by {plural(trace.dependents.length, 'cell')}.
          </div>
          {trace.precedents.map((r, i) => (
            <button key={`p${i}`} className="list-item" onClick={() => selectRange(r.table, r.r0, r.c0, r.r1, r.c1)}>
              ← {getState().tables.get(r.table)?.name}::{a1(r.r0, r.c0)}
              {r.r0 !== r.r1 || r.c0 !== r.c1 ? `:${a1(r.r1, r.c1)}` : ''}
            </button>
          ))}
          {trace.dependents.map((d, i) => (
            <button key={`d${i}`} className="list-item" onClick={() => selectCell(d.table, d.row, d.col)}>
              → {getState().tables.get(d.table)?.name}::{a1(d.row, d.col)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
