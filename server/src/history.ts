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
}

const HISTORY_DIR = () => join(DATA_DIR, 'history');
const MAX_CHECKPOINTS = 40;
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

function pruneCheckpoints(fileId: string) {
  const seqs = checkpointSeqs(fileId);
  if (seqs.length <= MAX_CHECKPOINTS) return;
  // keep the first one and the most recent ones
  const drop = seqs.slice(1, seqs.length - (MAX_CHECKPOINTS - 1));
  for (const s of drop) {
    try {
      unlinkSync(join(cpDir(fileId), `${s}.json`));
    } catch {
      /* ignore */
    }
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
  if (op.table !== table && op.type !== 'add_table') return false;
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
      return true;
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
