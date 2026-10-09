import { useEffect, useMemo, useState } from 'react';
import * as book from '../engine/book';
import { a1, refText, type CheckView } from '../engine/types';
import { selectCell, selectRange } from '../grid/actions';
import { getState, readOnly, useStore } from '../state/store';
import { clearTrace, removeSignoff, setSignoffLocked, signOffSelection, traceActiveCell, traceStep } from './review';

export function ReviewPanel() {
  const tables = useStore((s) => s.tables);
  const selection = useStore((s) => s.selection);
  const cellsVersion = useStore((s) => s.cellsVersion);
  const trace = useStore((s) => s.trace);
  const permission = useStore((s) => s.permission);
  const me = useStore((s) => s.me);
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
