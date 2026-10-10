// Investigations as records: the sandboxed runs and the bounded investigations an agent makes
// for a person — started, stopped, finished, superseded by a change of direction, interrupted by a
// restart — with what each proposed, which is set aside whenever its result is fenced. The process
// itself lives in ../investigate.ts; the job mechanics in ../jobs.ts.

import { existsSync, readdirSync } from 'node:fs';
import type { Author } from '../history.js';
import { newId } from '../storage.js';
import { DIR, event, loadState, now, safeId, saveState, short, who, type CodeRun, type Investigation } from './state.js';

// ------------------------------------------------------------------ code runs and investigations
/** A run of generated code against the live document, in the sandbox: kept as evidence with what it ran under. */
export function recordRun(doc: string, by: Author, run: Omit<CodeRun, 'id' | 'at' | 'by' | 'assumptionsSeq'>): CodeRun {
  const s = loadState(doc);
  const r: CodeRun = { id: newId(), at: now(), by: who(by), assumptionsSeq: s.assumptionsSeq ?? 0, ...run };
  s.runs!.push(r);
  if (r.investigation) {
    const inv = s.investigations!.find((i) => i.id === r.investigation);
    if (inv) inv.runs.push(r.id);
  }
  event(s, { kind: 'trace', text: `Ran code (${r.sandbox}): ${short(r.purpose || 'no purpose given', 100)} — ${r.ok ? `ok in ${r.ms} ms` : `failed: ${short(r.error ?? 'error', 100)}`}`, by: r.by, level: 'quiet' });
  saveState(s);
  return r;
}

export function startInvestigation(doc: string, by: Author, input: { question: string; issue?: string; thread?: string }): Investigation {
  const s = loadState(doc);
  const running = s.investigations!.find((i) => i.status === 'running' && Date.now() - Date.parse(i.startedAt) < 15 * 60_000);
  if (running) throw new Error('an investigation is already running on this document');
  const question = String(input.question ?? '').trim().slice(0, 2000);
  if (!question) throw new Error('question required');
  const inv: Investigation = { id: newId(), question, issue: input.issue && safeId(input.issue) ? input.issue : undefined, thread: input.thread && /^[a-zA-Z0-9:_-]{1,80}$/.test(input.thread) ? input.thread : `doc:${doc}`, startedAt: now(), status: 'running', steps: [], runs: [], records: [], proposals: [], by, assumptionsSeq: s.assumptionsSeq ?? 0 };
  s.investigations!.push(inv);
  event(s, { kind: 'investigation', text: `Investigating: ${short(question, 120)}`, by: who(by), level: 'quiet' });
  saveState(s);
  return inv;
}

/** A person stops a running investigation: the process is told to stop; the record says so when it has. */
export function requestCancel(doc: string, id: string, by: Author): Investigation {
  const s = loadState(doc);
  const inv = s.investigations!.find((i) => i.id === id);
  if (!inv) throw new Error('investigation not found');
  if (inv.status !== 'running') throw new Error(`the investigation is ${inv.status}`);
  inv.cancelRequested = now();
  event(s, { kind: 'investigation', text: `Stopping the investigation “${short(inv.question, 80)}”`, by: who(by), level: 'quiet' });
  saveState(s);
  return inv;
}

export function finishInvestigation(doc: string, id: string, result: { status: 'done' | 'failed'; answer?: string; model?: string; error?: string; steps?: { tool: string; summary: string }[]; records?: string[]; proposals?: string[] }): Investigation {
  const s = loadState(doc);
  const inv = s.investigations!.find((i) => i.id === id);
  if (!inv) throw new Error('investigation not found');
  // fenced results: stopped by a person, or overtaken by a change of direction — what it proposed is set aside, never current
  const fenced = inv.cancelRequested ? 'cancelled' : inv.superseded ? 'superseded' : null;
  inv.status = fenced ?? result.status;
  inv.finishedAt = now();
  inv.answer = result.answer ? result.answer.slice(0, 8000) : undefined;
  inv.model = result.model;
  inv.error = result.error ? result.error.slice(0, 1000) : undefined;
  if (result.steps) inv.steps = result.steps.slice(0, 60).map((x) => ({ tool: String(x.tool).slice(0, 60), summary: String(x.summary).slice(0, 200) }));
  if (result.records) inv.records = result.records.filter(safeId).slice(0, 50);
  if (result.proposals) inv.proposals = result.proposals.filter(safeId).slice(0, 50);
  if (fenced) {
    let aside = 0;
    for (const rid of inv.records) {
      const r = s.records.find((x) => x.id === rid);
      if (r && r.status === 'proposed') {
        r.status = 'retired';
        r.resolution = fenced === 'cancelled' ? 'set aside: the investigation was stopped before it finished' : 'set aside: the direction changed while the investigation ran';
        aside++;
      }
    }
    event(s, { kind: 'investigation', text: fenced === 'cancelled' ? `Investigation stopped: ${short(inv.question, 80)}${aside ? ` — ${aside} proposed record${aside === 1 ? '' : 's'} set aside` : ''}` : `Investigation superseded: ${short(inv.question, 80)} finished under the earlier direction — kept as history${aside ? `, ${aside} proposed record${aside === 1 ? '' : 's'} set aside` : ''}${inv.proposals.length ? `; ${inv.proposals.length} proposal${inv.proposals.length === 1 ? '' : 's'} in Review still need${inv.proposals.length === 1 ? 's' : ''} a decision` : ''}`, level: 'quiet' });
    saveState(s);
    return inv;
  }
  const made = [inv.runs.length ? `${inv.runs.length} sandboxed run${inv.runs.length === 1 ? '' : 's'}` : '', inv.records.length ? `${inv.records.length} proposed record${inv.records.length === 1 ? '' : 's'}` : '', inv.proposals.length ? `${inv.proposals.length} proposal${inv.proposals.length === 1 ? '' : 's'} to review` : ''].filter(Boolean).join(', ');
  event(s, { kind: 'investigation', text: result.status === 'done' ? `Investigation finished: ${short(inv.question, 80)} — ${made || 'nothing proposed'}; its findings are its own words, beside the evidence` : `Investigation failed: ${short(result.error ?? 'error', 160)}`, level: result.status === 'done' ? 'watch' : 'watch' });
  saveState(s);
  return inv;
}

/**
 * After a restart: an investigation the previous process left running is interrupted — said in the
 * activity, its proposed records set aside — never 'running' for ever and never current.
 */
export function interruptRunningInvestigations(reason: string): number {
  if (!existsSync(DIR())) return 0;
  let n = 0;
  for (const f of readdirSync(DIR())) {
    if (!f.endsWith('.json')) continue;
    const doc = f.slice(0, -5);
    if (!safeId(doc)) continue;
    const s = loadState(doc);
    const open = s.investigations!.filter((i) => i.status === 'running');
    if (!open.length) continue;
    for (const inv of open) {
      inv.status = 'failed';
      inv.finishedAt = now();
      inv.error = `interrupted: ${reason}`;
      let aside = 0;
      for (const rid of inv.records) {
        const r = s.records.find((x) => x.id === rid);
        if (r && r.status === 'proposed') {
          r.status = 'retired';
          r.resolution = 'set aside: the investigation was interrupted before it finished';
          aside++;
        }
      }
      event(s, { kind: 'investigation', text: `Investigation interrupted: ${short(inv.question, 80)} — ${reason}${aside ? `; ${aside} proposed record${aside === 1 ? '' : 's'} set aside` : ''}. Nothing it proposed became current; start it again when ready`, level: 'watch' });
      n++;
    }
    saveState(s);
  }
  return n;
}

export function getInvestigation(doc: string, id: string): Investigation | null {
  const s = loadState(doc);
  const inv = s.investigations!.find((i) => i.id === id);
  return inv ? { ...inv, stale: inv.status === 'done' && inv.assumptionsSeq !== (s.assumptionsSeq ?? 0) ? true : undefined } : null;
}

