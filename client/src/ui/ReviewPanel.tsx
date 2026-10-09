import { useEffect, useMemo, useState } from 'react';
import * as book from '../engine/book';
import { a1, refText, type CheckView } from '../engine/types';
import { selectCell, selectRange } from '../grid/actions';
import { getState, readOnly, useStore } from '../state/store';
import { clearTrace, removeSignoff, setSignoffLocked, signOffSelection, traceActiveCell, traceStep } from './review';
import { isCodeKind } from '../engine/types';
import { statusOf, type RunStatus } from '../workers/runs';
import { runCell } from '../workers/runner';
import { api, type Proposal } from '../api/client';
import { applyActions, type Action } from './ai';
import { getClientId } from '../api/ws';
import { setStatus } from '../state/store';

const RUN_LABEL: Record<RunStatus, string> = {
  verified: 'verified',
  'inputs-changed': 'inputs changed since run',
  'code-changed': 'code changed since run',
  failed: 'failed',
  'not-run': 'not run in this session',
};

export function ReviewPanel() {
  const tables = useStore((s) => s.tables);
  const selection = useStore((s) => s.selection);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const trace = useStore((s) => s.trace);
  const permission = useStore((s) => s.permission);
  const me = useStore((s) => s.me);
  const runsVersion = useStore((s) => s.runsVersion);
  const proposalsVersion = useStore((s) => s.proposalsVersion);
  const fileId = useStore((s) => s.fileId);
  const seqNow = useStore((s) => s.seq);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [showDecided, setShowDecided] = useState(false);
  const [pnote, setNoteFor] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!fileId) {
      setProposals([]);
      return;
    }
    api.files
      .proposals(fileId)
      .then(setProposals)
      .catch(() => setProposals([]));
  }, [fileId, proposalsVersion]);
  const decide = async (p: Proposal, decision: 'applied' | 'rejected') => {
    if (!fileId) return;
    let applied: { applied: number; errors: string[] } | undefined;
    if (decision === 'applied') {
      applied = applyActions(p.actions as unknown as Action[], 'agent');
      if (applied.errors.length && !applied.applied) {
        setStatus(`Nothing applied: ${applied.errors.join('; ')}`, 8000);
        return;
      }
      if (applied.errors.length) setStatus(`Applied ${applied.applied} change(s); ${applied.errors.length} failed: ${applied.errors.join('; ')}`, 8000);
    }
    try {
      const decided = await api.files.decide(fileId, p.id, decision, pnote[p.id] || (applied?.errors.length ? `partial: ${applied.errors.join('; ')}`.slice(0, 900) : undefined), getState().seq, getClientId());
      setProposals((ps) => ps.map((x) => (x.id === p.id ? decided : x)));
    } catch (e) {
      setStatus(`Could not record the decision: ${(e as Error).message}`, 6000);
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
  const unverified = codeCells.filter((c) => c.status !== 'verified').length;
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

  return (
    <div className="panel review-panel">
      <h3>Review</h3>
      <h4>Sign-offs</h4>
      <p className="muted small">A sign-off records who attested a range, when, and a fingerprint of its values. It turns amber when any value inside changes afterwards. A locked range refuses manual edits until it is unlocked.</p>
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
            <div className="muted small">No sign-offs on “{meta.name}” yet.</div>
          )}
        </>
      ) : (
        <div className="muted small">Select cells to sign them off.</div>
      )}

      <h4>
        Proposals <span className={`badge ${pending.length ? 'amber' : ''}`}>{pending.length ? `${pending.length} pending` : 'none pending'}</span>
      </h4>
      <p className="muted small">Edits filed by agents (MCP) wait here as a before → after diff. Applying runs them as ordinary changes with origin “agent”; both the proposal and your decision are in the audit log.</p>
      {!fileId && <div className="muted small">Save the document to receive proposals.</div>}
      {(showDecided ? proposals : pending).map((p) => (
        <div key={p.id} className={`proposal ${p.status}`}>
          <div className="row">
            <b className="grow">{p.title}</b>
            <span className={`badge ${p.status === 'pending' ? 'amber' : p.status === 'applied' ? 'green' : ''}`}>{p.status}</span>
          </div>
          <div className="muted small">
            {p.by.name} via {p.agent} · {new Date(p.at).toLocaleString()} · {p.ops.length} change{p.ops.length === 1 ? '' : 's'}
            {p.seq && seqNow > p.seq && p.status === 'pending' ? ` · the document changed ${seqNow - p.seq} time${seqNow - p.seq === 1 ? '' : 's'} since it was filed` : ''}
          </div>
          {p.rationale && <div className="small">{p.rationale}</div>}
          {p.errors.length > 0 && <div className="err small">{p.errors.join('; ')}</div>}
          <table className="diff-table">
            <tbody>
              {p.preview.slice(0, 40).map((l, i) => (
                <tr key={i} className={l.before === '' ? 'added' : l.after === '' ? 'removed' : 'changed'}>
                  <td>{l.where}</td>
                  <td className="old">{l.before}</td>
                  <td className="new">{l.after}</td>
                </tr>
              ))}
              {p.preview.length > 40 && (
                <tr>
                  <td colSpan={3} className="muted">
                    … {p.preview.length - 40} more
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
        </div>
      ))}
      {proposals.length > pending.length && (
        <button className="link small" onClick={() => setShowDecided((v) => !v)}>
          {showDecided ? 'hide decided proposals' : `show ${proposals.length - pending.length} decided proposal${proposals.length - pending.length === 1 ? '' : 's'}`}
        </button>
      )}

      <h4>
        Checks{' '}
        <span className={`badge ${failing.length ? 'amber' : checks.length ? 'green' : ''}`}>{checks.length ? (failing.length ? `${failing.length} failing` : 'all passing') : 'none'}</span>
      </h4>
      <p className="muted small">
        Write <code>=CHECK(condition, "label")</code> anywhere; every check is listed here with its outcome.
      </p>
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
        <span className={`badge ${codeCells.length ? (unverified ? 'amber' : 'green') : ''}`}>{codeCells.length ? (unverified ? `${unverified} unverified` : 'all verified') : 'none'}</span>
      </h4>
      <p className="muted small">Every run of a Python, JavaScript or SQL cell is recorded with the hash of its code, the hash of the values it read, the runtime and package versions, and the hash of its output. “Verified” means the output on screen is the recorded result of the current code and inputs.</p>
      {codeCells.map((c) => (
        <div key={`${c.table}:${c.row}:${c.col}`} className={`run-item ${c.status}`}>
          <button className="link" onClick={() => selectCell(c.table, c.row, c.col)}>
            {tables.get(c.table)?.name ?? c.table}!{a1(c.row, c.col)}
          </button>{' '}
          <span className="pill">{c.kind}</span> <span className={`badge ${c.status === 'verified' ? 'green' : c.status === 'not-run' ? '' : 'amber'}`}>{RUN_LABEL[c.status]}</span>
          {c.record && (
            <div className="muted small">
              {new Date(c.record.at).toLocaleString()} · {c.record.ms} ms · {c.record.runtime.name}
              {c.record.runtime.version ? ` ${c.record.runtime.version.slice(0, 20)}` : ''}
              {Object.keys(c.record.runtime.packages).filter((k) => k !== 'connection').length ? ` · ${Object.entries(c.record.runtime.packages).filter(([k]) => k !== 'connection').map(([k, v]) => `${k} ${v}`).join(', ').slice(0, 160)}` : ''}
              {c.record.seq ? ` · logged #${c.record.seq}` : ''}
              <br />
              code {c.record.codeHash.slice(0, 8)} · inputs {c.record.inputsHash.slice(0, 8)} · output {c.record.outputHash.slice(0, 8)}
              {c.record.error ? ` · ${c.record.error.slice(0, 120)}` : ''}
            </div>
          )}
          {c.status !== 'verified' && (
            <button className="link small" disabled={readOnly()} onClick={() => runCell({ table: c.table, row: c.row, col: c.col })}>
              run now
            </button>
          )}
        </div>
      ))}

      <h4>Trace</h4>
      <p className="muted small">Show which cells the active cell reads (navy) and which cells read it (coral). Ctrl+[ walks the precedents, Ctrl+] the dependents.</p>
      <div className="row wrap">
        <button onClick={() => traceActiveCell()} disabled={!selection}>
          Trace active cell
        </button>
        <button onClick={() => traceStep('precedents')} disabled={!selection}>
          ← Precedents
        </button>
        <button onClick={() => traceStep('dependents')} disabled={!selection}>
          Dependents →
        </button>
        <button onClick={() => clearTrace()} disabled={!trace}>
          Clear
        </button>
      </div>
      {trace && (
        <div className="small">
          <div>
            <b>{tables.get(trace.cell.table)?.name}</b>!{a1(trace.cell.row, trace.cell.col)} reads {trace.precedents.length} range{trace.precedents.length === 1 ? '' : 's'} and is read by {trace.dependents.length} cell{trace.dependents.length === 1 ? '' : 's'}.
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
