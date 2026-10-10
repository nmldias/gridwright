// The banner a person sees when the open document has code cells they did not write and have not
// approved: those cells did not run. "Review code" shows each one; "Trust and run" approves the
// exact code (remembered for this person) and runs it. Nothing runs until they decide.

import { useState } from 'react';
import { a1, isCodeKind, type CellRef } from '../engine/types';
import { cellAt, useStore } from '../state/store';
import { runCell } from '../workers/runner';
import { clearBlocked, trust } from '../workers/trust';

const KIND: Record<string, string> = { javascript: 'JavaScript', python: 'Python', sql: 'SQL' };

function describe(ref: CellRef, tableName: string) {
  const c = cellAt(ref.table, ref.row, ref.col);
  if (!c || !isCodeKind(c.k)) return null;
  const where = c.k === 'python' ? (c.runtime === 'agent' ? 'agent cell on the server' : c.runtime === 'server' ? 'on the server' : 'in your browser') : c.k === 'sql' ? `on connection ${c.conn ?? '(none)'}` : 'in your browser';
  return { ref, cell: c, label: `${tableName}!${a1(ref.row, ref.col)}`, kind: KIND[c.k] ?? c.k, where, refresh: c.refresh ?? 0 };
}

export function TrustBanner() {
  const blocked = useStore((s) => s.blockedCode);
  const tables = useStore((s) => s.tables);
  useStore((s) => s.cells); // re-render when a waiting cell changes
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const items = blocked.map((r) => describe(r, tables.get(r.table)?.name ?? String(r.table))).filter((x): x is NonNullable<ReturnType<typeof describe>> => !!x);
  if (!items.length || hidden) return null;
  const runAll = () => {
    trust(items.map((i) => i.cell));
    const refs = items.map((i) => i.ref);
    clearBlocked(refs);
    setOpen(false);
    refs.forEach(runCell);
  };
  const n = items.length;
  return (
    <>
      <div className="trust-banner" role="alert" data-testid="trust-banner">
        <span>
          <strong>
            {n} code cell{n === 1 ? '' : 's'} did not run.
          </strong>{' '}
          {n === 1 ? 'It was' : 'They were'} written by someone else (or before you opened this document here), and code runs with <em>your</em> access to data and
          connections.
        </span>
        <span className="trust-actions">
          <button onClick={() => setOpen(true)} data-testid="trust-review">
            Review code
          </button>
          <button className="primary" onClick={runAll} data-testid="trust-run">
            Trust and run
          </button>
          <button className="link" onClick={() => setHidden(true)} aria-label="Dismiss for now">
            Not now
          </button>
        </span>
      </div>
      {open && (
        <div className="trust-overlay" role="dialog" aria-modal="true" aria-labelledby="trust-title" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="trust-dialog">
            <h2 id="trust-title">Code waiting for your approval</h2>
            <p className="muted small">Read it before you run it: it can query your connections, run on the server as you, and write into this document.</p>
            <div className="trust-list">
              {items.map((i) => (
                <section key={`${i.ref.table}:${i.ref.row}:${i.ref.col}`} className="trust-item">
                  <h3>
                    {i.label} <span className="pill">{i.kind}</span> <span className="muted small">runs {i.where}</span>
                    {i.refresh ? <span className="muted small"> · repeats every {i.refresh} s</span> : null}
                  </h3>
                  <pre className="trust-code">{i.cell.i}</pre>
                </section>
              ))}
            </div>
            <div className="trust-actions end">
              <button onClick={() => setOpen(false)}>Close</button>
              <button className="primary" onClick={runAll} data-testid="trust-run-all">
                Trust and run {n === 1 ? 'it' : `all ${n}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
