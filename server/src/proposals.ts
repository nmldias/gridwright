// Proposals: the review-and-commit boundary for agents. An agent (MCP, or any caller of the
// proposals API) describes edits as actions; the server validates them against a throw-away copy
// of the document, stores the proposal with a before → after preview, and tells the editors. A
// person applies or rejects it in the Review panel; applied proposals become ordinary operations
// with origin "agent", so the audit log keeps the human decision.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEntry, currentSeq, type Author, type LogEntry } from './history.js';
import { a1, diffBooks, engine, nowSerial, openDocument, parseA1, tableByName, type DiffLine, errorMessage } from './headless.js';
import { DATA_DIR } from './storage.js';
import { pythonStatus } from './pyrun.js';

export interface Action {
  action: string;
  table?: string;
  ref?: string;
  values?: (string | number | boolean | null)[][];
  input?: string;
  language?: string;
  code?: string;
  /** code_cell (python): "server" | "browser" */
  runtime?: string;
  gpu?: boolean;
  name?: string;
  rows?: number;
  cols?: number;
  format?: Record<string, unknown>;
  kind?: string;
  title?: string;
  subtitle?: string;
  categories?: string;
  series?: { name?: string; range?: string }[];
  highlight?: number | null;
  reference?: { value: number; label?: string } | null;
  source?: string;
  exhibit?: string;
}

export interface Proposal {
  id: string;
  document: string;
  by: Author;
  agent: string;
  at: string;
  title: string;
  rationale: string;
  actions: Action[];
  /** engine ops the actions translate to (validated on a copy of the document) */
  ops: Record<string, unknown>[];
  preview: DiffLine[];
  errors: string[];
  /** log position the proposal was validated against */
  seq: number;
  status: 'pending' | 'applied' | 'rejected';
  decidedBy?: Author;
  decidedAt?: string;
  decisionNote?: string;
  /** log position of the last committed operation */
  appliedSeq?: number;
  /** log positions of every committed operation (the receipt) */
  appliedSeqs?: number[];
  /** caller-supplied command id: repeating it returns the same receipt instead of applying again */
  command?: string;
}

const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
const dirOf = (doc: string) => join(DATA_DIR, 'proposals', doc);

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeProposal(p: Proposal) {
  const dir = dirOf(p.document);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${p.id}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, path);
}

export function listProposals(doc: string, status?: Proposal['status']): Proposal[] {
  if (!safeId(doc)) return [];
  const dir = dirOf(doc);
  if (!existsSync(dir)) return [];
  const out: Proposal[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = readJson<Proposal>(join(dir, f));
    if (p && (!status || p.status === status)) out.push(p);
  }
  out.sort((x, y) => (x.at < y.at ? 1 : -1));
  return out;
}

export function getProposal(doc: string, id: string): Proposal | null {
  if (!safeId(doc) || !safeId(id)) return null;
  return readJson<Proposal>(join(dirOf(doc), `${id}.json`));
}

const str = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : JSON.stringify(v));

const CHART_KINDS = ['bar', 'hbar', 'line', 'area', 'stacked', 'waterfall'];

/** Translate agent actions (tables by name, A1 refs) into engine ops against the document. */
export function actionsToOps(book: ReturnType<typeof openDocument>['book'], actions: Action[]): { ops: Record<string, unknown>[]; errors: string[] } {
  const ops: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const resolveTable = (act: Action): number => {
    if (!act.table) {
      const first = JSON.parse(book.tables())[0];
      if (!first) throw new Error('no table in the document');
      return first.id;
    }
    const t = tableByName(book, act.table);
    if (!t) throw new Error(`table "${act.table}" not found`);
    return t.id;
  };
  const ref = (act: Action) => {
    const p = parseA1(act.ref ?? 'A1');
    if (!p) throw new Error(`bad ref ${act.ref}`);
    return p;
  };
  for (const act of actions) {
    try {
      switch (act.action) {
        case 'set_cells': {
          const table = resolveTable(act);
          const p = ref(act);
          const values = (act.values ?? []).map((row) => row.map(str));
          if (!values.length) throw new Error('no values');
          ops.push({ type: 'set_cells', table, row: p.r0, col: p.c0, values });
          break;
        }
        case 'set_cell': {
          const table = resolveTable(act);
          const p = ref(act);
          ops.push({ type: 'set_cell', table, row: p.r0, col: p.c0, input: str(act.input) });
          break;
        }
        case 'code_cell': {
          const table = resolveTable(act);
          const p = ref(act);
          const l = (act.language ?? 'python').toLowerCase();
          const kind = l.startsWith('j') ? 'javascript' : l.startsWith('s') ? 'sql' : 'python';
          const runtime = kind === 'python' ? (act.runtime === 'browser' ? null : act.runtime === 'server' || pythonStatus().available ? 'server' : null) : undefined;
          ops.push({ type: 'set_cell', table, row: p.r0, col: p.c0, input: str(act.code), kind, runtime, gpu: runtime === 'server' && act.gpu === true ? true : undefined });
          break;
        }
        case 'add_table': {
          const values = (act.values ?? []).map((row) => row.map(str));
          const metas = JSON.parse(book.tables()) as { x: number; y: number; rows: number; row_heights: number[] }[];
          let y = 80;
          for (const t of metas) y = Math.max(y, t.y + t.row_heights.reduce((a, b) => a + b, 0) + 80);
          ops.push({ type: 'add_table', name: act.name, x: 80, y, rows: Math.max(act.rows ?? 0, values.length || 5), cols: Math.max(act.cols ?? 0, values[0]?.length ?? 3), values: values.length ? values : undefined });
          break;
        }
        case 'resize_table': {
          const table = resolveTable(act);
          const meta = (JSON.parse(book.tables()) as { id: number; rows: number; cols: number }[]).find((t) => t.id === table)!;
          ops.push({ type: 'resize_table', table, rows: act.rows ?? meta.rows, cols: act.cols ?? meta.cols });
          break;
        }
        case 'rename_table': {
          const table = resolveTable(act);
          ops.push({ type: 'rename_table', table, name: str(act.name) });
          break;
        }
        case 'clear_range': {
          const table = resolveTable(act);
          const p = ref(act);
          ops.push({ type: 'clear_range', table, r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1 });
          break;
        }
        case 'set_format': {
          const table = resolveTable(act);
          const p = ref(act);
          const f = (act.format ?? {}) as Record<string, unknown>;
          const format: Record<string, unknown> = {};
          for (const k of ['bold', 'italic', 'align', 'number_format', 'fill', 'color', 'wrap']) if (f[k] !== undefined) format[k] = f[k];
          ops.push({ type: 'set_format', table, r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1, format });
          break;
        }
        case 'add_chart': {
          const kind = CHART_KINDS.includes(String(act.kind)) ? String(act.kind) : 'bar';
          const series = (act.series ?? []).filter((x) => x && x.range).map((x, i) => ({ name: str(x.name) || `Series ${i + 1}`, range: str(x.range) }));
          if (!series.length) throw new Error('a chart needs at least one series');
          const charts = JSON.parse(book.charts()) as unknown[];
          ops.push({
            type: 'add_chart',
            chart: {
              id: 0,
              kind,
              title: str(act.title),
              subtitle: str(act.subtitle),
              exhibit: str(act.exhibit) || `Exhibit ${charts.length + 1}`,
              source: str(act.source),
              x: 900,
              y: 80,
              w: 560,
              h: 380,
              categories: str(act.categories),
              series,
              highlight: typeof act.highlight === 'number' ? act.highlight : null,
              reference: act.reference && typeof act.reference.value === 'number' ? { value: act.reference.value, label: str(act.reference.label) } : null,
              show_values: true,
              stat_cards: true,
            },
          });
          break;
        }
        default:
          errors.push(`unknown action ${act.action}`);
      }
    } catch (e) {
      errors.push(`${act.action}: ${errorMessage(e)}`);
    }
  }
  return { ops, errors };
}

/** Validate actions on a copy of the document and return the ops plus a before → after preview. */
export function validateActions(doc: string, actions: Action[]): { ops: Record<string, unknown>[]; preview: DiffLine[]; errors: string[]; seq: number } {
  const { book, json, seq } = openDocument(doc);
  const before = engine().Book.from_json(json);
  before.set_now(nowSerial());
  try {
    const { ops, errors } = actionsToOps(book, actions);
    const touched = new Set<number>();
    const applied: Record<string, unknown>[] = [];
    for (const op of ops) {
      const ch = JSON.parse(book.apply(JSON.stringify(op))) as { error?: string; tables?: { id: number }[]; cells?: Record<string, unknown>; created?: number[]; removed_tables?: number[]; reload?: number[]; charts?: unknown[] };
      if (ch.error) {
        errors.push(`${String(op.type)}: ${ch.error}`);
        continue;
      }
      applied.push(op);
      for (const t of ch.tables ?? []) touched.add(t.id);
      for (const k of Object.keys(ch.cells ?? {})) touched.add(Number(k));
      for (const id of ch.created ?? []) touched.add(id);
      for (const id of ch.removed_tables ?? []) touched.add(id);
      for (const id of ch.reload ?? []) touched.add(id);
      if (ch.charts) {
        const c = (op as { chart?: { title?: string; kind?: string } }).chart;
        applied[applied.length - 1] = op;
        if (c) touched.add(-1);
      }
    }
    const preview = diffBooks(before, book, Array.from(touched).filter((t) => t >= 0));
    for (const op of applied) {
      if (op.type === 'add_chart') {
        const c = op.chart as { kind: string; title: string; series: { range: string }[] };
        preview.push({ where: 'chart', before: '', after: `${c.kind}: ${c.title} (${c.series.map((s) => s.range).join(', ')})` });
      }
    }
    return { ops: applied, preview, errors, seq };
  } finally {
    book.free();
    before.free();
  }
}

export function createProposal(doc: string, by: Author, agent: string, title: string, rationale: string, actions: Action[], seq?: number): Proposal {
  if (!safeId(doc)) throw new Error('bad document id');
  const v = validateActions(doc, actions);
  seq = seq ?? v.seq;
  if (!v.ops.length) throw new Error(`nothing to propose: ${v.errors.join('; ') || 'no valid actions'}`);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const p: Proposal = {
    id,
    document: doc,
    by,
    agent,
    at: new Date().toISOString(),
    title: title.slice(0, 200),
    rationale: rationale.slice(0, 4000),
    actions,
    ops: v.ops,
    preview: v.preview,
    errors: v.errors,
    seq,
    status: 'pending',
  };
  writeProposal(p);
  appendEntry(doc, { author: by, origin: 'agent', note: `proposal ${id}: ${p.title} (${v.ops.length} change${v.ops.length === 1 ? '' : 's'})` });
  return p;
}

export class ProposalConflict extends Error {
  constructor(
    message: string,
    public proposal: Proposal,
  ) {
    super(message);
  }
}

/**
 * Decide a proposal. "applied" is a server-side commit: the stored actions are validated again
 * against the document as it is now (the reviewer's expected revision must match; if the document
 * moved on and the preview is no longer what was reviewed, the proposal gets a fresh preview and
 * the caller must decide again), then the exact operations and the decision are appended to the
 * log together. A repeated `command` returns the same receipt instead of applying twice.
 */
export function decideProposal(doc: string, id: string, decision: 'applied' | 'rejected', by: Author, note?: string, expectedSeq?: number, command?: string): { proposal: Proposal; committed: LogEntry[] } {
  const p = getProposal(doc, id);
  if (!p) throw new Error('proposal not found');
  if (p.status !== 'pending') {
    if (command && p.command === command) return { proposal: p, committed: [] }; // idempotent repeat
    throw new Error(`proposal already ${p.status}`);
  }
  if (expectedSeq !== undefined && expectedSeq !== p.seq) {
    throw new ProposalConflict(`this proposal was reviewed at revision ${p.seq}, not ${expectedSeq} — review the current preview`, p);
  }
  const committed: LogEntry[] = [];
  if (decision === 'applied') {
    let ops = p.ops;
    if (currentSeq(doc) !== p.seq) {
      // the document changed since the preview was made: only an identical preview may proceed
      const v = validateActions(doc, p.actions);
      const same = JSON.stringify(v.preview) === JSON.stringify(p.preview) && JSON.stringify(v.errors) === JSON.stringify(p.errors);
      p.preview = v.preview;
      p.ops = v.ops;
      p.errors = v.errors;
      p.seq = v.seq;
      writeProposal(p);
      if (!same) throw new ProposalConflict('the document changed since this proposal was reviewed — a fresh preview is attached, decide again', p);
      ops = v.ops;
    }
    if (!ops.length) throw new Error(`nothing to apply: ${p.errors.join('; ') || 'no valid actions'}`);
    for (const op of ops) {
      const seq = appendEntry(doc, { author: by, origin: 'agent', op, note: `proposal ${id}` });
      committed.push({ seq, ts: new Date().toISOString(), author: by, origin: 'agent', op });
    }
    p.appliedSeqs = committed.map((e) => e.seq);
    p.appliedSeq = p.appliedSeqs[p.appliedSeqs.length - 1];
  }
  p.status = decision;
  p.decidedBy = by;
  p.decidedAt = new Date().toISOString();
  p.decisionNote = note?.slice(0, 1000);
  if (command) p.command = command.slice(0, 80);
  writeProposal(p);
  appendEntry(doc, { author: by, origin: 'user', note: `proposal ${id} ${decision}${note ? ': ' + note : ''}${committed.length ? ` (${committed.length} operation${committed.length === 1 ? '' : 's'} committed, seq ${p.appliedSeqs?.join(',')})` : ''}` });
  return { proposal: p, committed };
}

/** Re-validate a pending proposal against the document as it is now (fresh preview and revision). */
export function refreshProposal(doc: string, id: string): Proposal {
  const p = getProposal(doc, id);
  if (!p) throw new Error('proposal not found');
  if (p.status !== 'pending') return p;
  const v = validateActions(doc, p.actions);
  p.preview = v.preview;
  p.ops = v.ops;
  p.errors = v.errors;
  p.seq = v.seq;
  writeProposal(p);
  return p;
}
