// Per-document operation log (audit trail) and checkpoints.
//
//   data/history/<fileId>.ops.jsonl     one JSON entry per line, strictly increasing `seq`
//   data/history/<fileId>/<seq>.json    document snapshots ("checkpoints") taken at saves / undo-redo
//
// The server is the single sequencer: every op accepted over the WebSocket gets the next seq,
// is appended here, and only then broadcast — so every client applies the same order.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './storage.js';

export interface Author {
  id: string; // client id (per browser tab)
  name: string;
  login?: string; // identity from the proxy (Tailscale), when known
}

export interface LogEntry {
  seq: number;
  ts: string;
  author: Author;
  /** user | ai | code | sql | remote | import | system */
  origin: string;
  /** engine op (absent for snapshot entries) */
  op?: Record<string, unknown>;
  /** present when a checkpoint was written at this seq (undo/redo or save) */
  checkpoint?: boolean;
  note?: string;
  /** a code-cell execution: hashes of code, inputs and output plus the runtime (not an op) */
  run?: RunRecord;
}

export interface RunRecord {
  table: number;
  row: number;
  col: number;
  kind: string;
  codeHash: string;
  inputsHash: string;
  deps: { table: number; r0: number; c0: number; r1: number; c1: number }[];
  outputHash: string;
  ok: boolean;
  error?: string;
  ms: number;
  runtime: { name: string; version: string; packages: Record<string, string> };
  at: string;
  /** when the run started (an older run can never supersede a newer result) */
  startedAt?: string;
  /** who computed the hashes: the server (a server-side run it executed itself) or the client's runtime */
  attested?: 'server' | 'client';
}

/** Validate a run record sent by a client (shape only; hashes are the client's statement). */
export function sanitiseRun(raw: unknown): RunRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (k: string) => (Number.isFinite(Number(r[k])) ? Number(r[k]) : null);
  const table = num('table');
  const row = num('row');
  const col = num('col');
  if (table === null || row === null || col === null) return null;
  const hex = (k: string) => (typeof r[k] === 'string' && /^[0-9a-f]{8,64}$/.test(r[k] as string) ? (r[k] as string) : '');
  const rt = (r.runtime && typeof r.runtime === 'object' ? (r.runtime as Record<string, unknown>) : {}) as Record<string, unknown>;
  const packages: Record<string, string> = {};
  if (rt.packages && typeof rt.packages === 'object') {
    for (const [k, v] of Object.entries(rt.packages as Record<string, unknown>).slice(0, 200)) packages[String(k).slice(0, 80)] = String(v).slice(0, 80);
  }
  const deps = Array.isArray(r.deps)
    ? (r.deps as Record<string, unknown>[]).slice(0, 500).map((d) => ({ table: Number(d.table), r0: Number(d.r0), c0: Number(d.c0), r1: Number(d.r1), c1: Number(d.c1) })).filter((d) => [d.table, d.r0, d.c0, d.r1, d.c1].every(Number.isFinite))
    : [];
  return {
    table,
    row,
    col,
    kind: String(r.kind ?? '').slice(0, 20),
    codeHash: hex('codeHash'),
    inputsHash: hex('inputsHash'),
    deps,
    outputHash: hex('outputHash'),
    ok: !!r.ok,
    error: typeof r.error === 'string' ? r.error.slice(0, 500) : undefined,
    ms: Math.max(0, num('ms') ?? 0),
    runtime: { name: String(rt.name ?? '').slice(0, 40), version: String(rt.version ?? '').slice(0, 200), packages },
    at: typeof r.at === 'string' ? r.at.slice(0, 40) : new Date().toISOString(),
    startedAt: typeof r.startedAt === 'string' ? r.startedAt.slice(0, 40) : undefined,
  };
}

const HISTORY_DIR = () => join(DATA_DIR, 'history');
const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);

const seqCache = new Map<string, number>();

function logPath(fileId: string) {
  return join(HISTORY_DIR(), `${fileId}.ops.jsonl`);
}
function cpDir(fileId: string) {
  return join(HISTORY_DIR(), fileId);
}

export function ensureHistoryDir() {
  mkdirSync(HISTORY_DIR(), { recursive: true });
}

/** Highest seq in the log (0 when empty). */
export function currentSeq(fileId: string): number {
  if (!safeId(fileId)) return 0;
  const cached = seqCache.get(fileId);
  if (cached !== undefined) return cached;
  let seq = 0;
  const p = logPath(fileId);
  if (existsSync(p)) {
    // read the tail of the file to find the last line
    const st = statSync(p);
    const size = st.size;
    const chunk = Math.min(size, 65536);
    const fd = readFileSync(p); // documents' logs are small enough to read; optimise later if needed
    const tail = fd.subarray(size - chunk).toString('utf8');
    const lines = tail.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (typeof e.seq === 'number') {
          seq = e.seq;
          break;
        }
      } catch {
        /* partial line */
      }
    }
  }
  seqCache.set(fileId, seq);
  return seq;
}

/** Append an entry; returns the assigned seq. */
export function appendEntry(fileId: string, entry: Omit<LogEntry, 'seq' | 'ts'>): number {
  if (!safeId(fileId)) throw new Error('bad file id');
  ensureHistoryDir();
  const seq = currentSeq(fileId) + 1;
  const full: LogEntry = { seq, ts: new Date().toISOString(), ...entry };
  appendFileSync(logPath(fileId), JSON.stringify(full) + '\n');
  seqCache.set(fileId, seq);
  return seq;
}

/** Entries with seq > since (ascending), capped. */
export function entriesSince(fileId: string, since: number, limit = 5000): LogEntry[] {
  return readAll(fileId).filter((e) => e.seq > since).slice(0, limit);
}

/** Most recent entries (descending), optionally before a seq. */
export function recentEntries(fileId: string, limit = 200, before?: number): LogEntry[] {
  const all = readAll(fileId);
  const filtered = before ? all.filter((e) => e.seq < before) : all;
  return filtered.slice(-limit).reverse();
}

export function readAll(fileId: string): LogEntry[] {
  if (!safeId(fileId)) return [];
  const p = logPath(fileId);
  if (!existsSync(p)) return [];
  const out: LogEntry[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/** Write a checkpoint of the document as of `seq` (idempotent per seq). */
export function writeCheckpoint(fileId: string, seq: number, json: string) {
  if (!safeId(fileId)) return;
  const dir = cpDir(fileId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${seq}.json`);
  if (existsSync(p)) return;
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, json);
  renameSync(tmp, p);
  pruneCheckpoints(fileId);
}

export function checkpointSeqs(fileId: string): number[] {
  const dir = cpDir(fileId);
  if (!safeId(fileId) || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => Number(f.slice(0, -5)))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

const DAY = 86_400_000;

/**
 * Checkpoint retention: everything from the last 24 h, one per day for 30 days, one per week
 * after that, and always the first and the latest. Ages come from the files' mtimes.
 */
export function compactCheckpoints(fileId: string, now = Date.now()): number[] {
  const seqs = checkpointSeqs(fileId);
  if (seqs.length <= 2) return [];
  const dir = cpDir(fileId);
  const aged = seqs.map((seq) => {
    let age = 0;
    try {
      age = now - statSync(join(dir, `${seq}.json`)).mtimeMs;
    } catch {
      /* treat as new */
    }
    return { seq, age };
  });
  const keep = new Set<number>([seqs[0], seqs[seqs.length - 1]]);
  const buckets = new Set<string>();
  // newest first so the most recent checkpoint of each day / week is the one kept
  for (const { seq, age } of [...aged].sort((a, b) => a.age - b.age)) {
    if (age < DAY) {
      keep.add(seq);
      continue;
    }
    const key = age < 30 * DAY ? `d${Math.floor(age / DAY)}` : `w${Math.floor(age / (7 * DAY))}`;
    if (!buckets.has(key)) {
      buckets.add(key);
      keep.add(seq);
    }
  }
  const dropped: number[] = [];
  for (const s of seqs) {
    if (keep.has(s)) continue;
    try {
      unlinkSync(join(dir, `${s}.json`));
      dropped.push(s);
    } catch {
      /* ignore */
    }
  }
  return dropped;
}

function pruneCheckpoints(fileId: string) {
  compactCheckpoints(fileId);
}

/** Audit trail as CSV (one line per log entry). */
export function historyCsv(fileId: string): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ['seq,timestamp,author,login,origin,type,table,range,detail,note'];
  for (const e of readAll(fileId)) {
    if (e.run) {
      const r = e.run;
      const pk = Object.entries(r.runtime?.packages ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
      lines.push([e.seq, e.ts, e.author?.name ?? '', e.author?.login ?? '', e.origin, 'code_run', r.table, a1(r.row, r.col), `${r.kind} ${r.ok ? 'ok' : 'failed'} ${r.ms} ms; code ${r.codeHash}; inputs ${r.inputsHash}; output ${r.outputHash}; ${r.runtime?.name} ${r.runtime?.version}${pk ? '; ' + pk : ''}${r.error ? '; ' + r.error : ''}`, e.note ?? ''].map(esc).join(','));
      continue;
    }
    const op = e.op ?? {};
    const type = e.checkpoint && !e.op ? 'checkpoint' : String(op.type ?? '');
    const d = describeOp(op);
    lines.push([e.seq, e.ts, e.author?.name ?? '', e.author?.login ?? '', e.origin, type, op.table ?? '', d.range, d.detail, e.note ?? ''].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

export function colLetters(col: number): string {
  let s = '';
  let c = col + 1;
  while (c > 0) {
    const r = (c - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}
const a1 = (r: unknown, c: unknown) => `${colLetters(Number(c))}${Number(r) + 1}`;

/** Human-readable range and detail of an op (for the CSV and the history panel). */
export function describeOp(op: Record<string, unknown>): { range: string; detail: string } {
  const n = (k: string) => Number(op[k]);
  const rect = () => `${a1(op.r0, op.c0)}:${a1(op.r1, op.c1)}`;
  switch (op.type) {
    case 'set_cell':
      return { range: a1(op.row, op.col), detail: String(op.input ?? '').slice(0, 500) };
    case 'set_cells': {
      const values = (op.values as unknown[][]) ?? [];
      const cols = Math.max(1, ...values.map((r) => r.length));
      return { range: `${a1(op.row, op.col)}:${a1(n('row') + values.length - 1, n('col') + cols - 1)}`, detail: `${values.length}×${cols} values` };
    }
    case 'clear_range':
      return { range: rect(), detail: 'cleared' };
    case 'set_format':
      return { range: rect(), detail: JSON.stringify(op.format ?? {}).slice(0, 300) };
    case 'insert_rows':
    case 'delete_rows':
      return { range: `row ${n('at') + 1}`, detail: `${op.count} row(s)` };
    case 'insert_cols':
    case 'delete_cols':
      return { range: `column ${colLetters(n('at'))}`, detail: `${op.count} column(s)` };
    case 'add_table':
      return { range: '', detail: `${op.name ?? 'table'} ${op.rows}×${op.cols}` };
    case 'rename_table':
      return { range: '', detail: `→ ${op.name}` };
    case 'add_signoff':
      return { range: rect(), detail: `${op.by ?? ''}${op.locked ? ' (locked)' : ''}${op.note ? ': ' + op.note : ''}` };
    case 'remove_signoff':
      return { range: '', detail: `sign-off #${op.id} removed` };
    case 'set_signoff_locked':
      return { range: '', detail: `sign-off #${op.id} ${op.locked ? 'locked' : 'unlocked'}` };
    case 'merge_cells':
    case 'unmerge_cells':
      return { range: rect(), detail: op.type === 'merge_cells' ? 'merged' : 'unmerged' };
    case 'add_chart':
    case 'update_chart': {
      const c = (op.chart as Record<string, unknown>) ?? {};
      return { range: '', detail: `${c.kind ?? 'chart'}: ${String(c.title ?? '').slice(0, 120)}` };
    }
    case 'delete_chart':
      return { range: '', detail: `chart #${op.id} deleted` };
    case 'set_name':
      return { range: '', detail: `${op.name} = ${op.reference ?? '(removed)'}` };
    case 'restore_cells':
      return { range: '', detail: `${(op.cells as unknown[])?.length ?? 0} cell(s) restored (undo/redo)` };
    case 'restore_tables':
      return { range: '', detail: `${(op.tables as unknown[])?.length ?? 0} table(s) restored (undo/redo)` };
    default:
      return { range: '', detail: '' };
  }
}

/** Latest checkpoint at or before `seq` plus the ops after it, for client-side replay. */
export function replayBundle(fileId: string, seq: number): { checkpointSeq: number; json: string | null; ops: LogEntry[] } | null {
  const seqs = checkpointSeqs(fileId).filter((s) => s <= seq);
  const cp = seqs.length ? seqs[seqs.length - 1] : 0;
  const json = cp ? readFileSync(join(cpDir(fileId), `${cp}.json`), 'utf8') : null;
  const ops = readAll(fileId).filter((e) => e.seq > cp && e.seq <= seq && e.op);
  if (!json && cp === 0 && !checkpointSeqs(fileId).length && ops.length === 0) return null;
  return { checkpointSeq: cp, json, ops };
}

/** Does an op touch a given cell? (used for per-cell history) */
export function opTouchesCell(op: Record<string, unknown>, table: number, row: number, col: number): boolean {
  if (op.table !== table && op.type !== 'add_table' && op.type !== 'restore_cells' && op.type !== 'restore_tables') return false;
  if (op.type === 'restore_tables') return ((op.tables as { id: number }[]) ?? []).some((t) => t.id === table);
  const num = (k: string) => Number(op[k]);
  switch (op.type) {
    case 'set_cell':
    case 'code_result':
      return num('row') === row && num('col') === col;
    case 'set_cells': {
      const values = op.values as unknown[][];
      const r0 = num('row');
      const c0 = num('col');
      const rows = values?.length ?? 0;
      const cols = Math.max(0, ...(values ?? []).map((r) => r.length));
      return row >= r0 && row < r0 + rows && col >= c0 && col < c0 + cols;
    }
    case 'clear_range':
    case 'set_format':
      return row >= num('r0') && row <= num('r1') && col >= num('c0') && col <= num('c1');
    case 'insert_rows':
    case 'delete_rows':
      return row >= num('at');
    case 'insert_cols':
    case 'delete_cols':
      return col >= num('at');
    case 'resize_table':
    case 'delete_table':
    case 'set_pivot':
    case 'restore_tables':
      return true;
    case 'merge_cells':
    case 'unmerge_cells':
    case 'add_signoff':
      return row >= num('r0') && row <= num('r1') && col >= num('c0') && col <= num('c1');
    case 'restore_cells':
      return ((op.cells as { table: number; row: number; col: number }[]) ?? []).some((c) => c.table === table && c.row === row && c.col === col);
    default:
      return false;
  }
}

export function deleteHistory(fileId: string) {
  if (!safeId(fileId)) return;
  try {
    unlinkSync(logPath(fileId));
  } catch {
    /* none */
  }
  seqCache.delete(fileId);
  const dir = cpDir(fileId);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* ignore */
      }
    }
  }
}
