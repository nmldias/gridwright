// Isolated parsing for imports. A workbook is a zip of XML that may inflate a thousandfold, and the
// spreadsheet library parses it synchronously: in the server's own thread, one crafted 13 MB file
// stopped every client for half a minute and took 1.3 GB. So:
//   1. the zip directory is read first and a workbook that would inflate past a limit is refused;
//   2. parsing runs in a worker thread with a heap cap and a deadline (the server keeps serving);
//   3. each client parses one file at a time, a few in all, with a short queue.
//
//   GRIDWRIGHT_INTAKE_MAX_UNZIPPED_MB  inflated size limit of a workbook (default 160)
//   GRIDWRIGHT_INTAKE_HEAP_MB          heap of one parse (default 768)
//   GRIDWRIGHT_INTAKE_TIMEOUT_S        deadline of one parse (default 60)
//   GRIDWRIGHT_INTAKE_WORKERS          parses at once, all clients (default 2)

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { RawSet } from './parsers.js';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const MAX_UNZIPPED = num(process.env.GRIDWRIGHT_INTAKE_MAX_UNZIPPED_MB, 160) * 1024 * 1024;
const HEAP_MB = num(process.env.GRIDWRIGHT_INTAKE_HEAP_MB, 768);
const TIMEOUT_MS = num(process.env.GRIDWRIGHT_INTAKE_TIMEOUT_S, 60) * 1000;
const SLOTS = Math.max(1, Math.floor(num(process.env.GRIDWRIGHT_INTAKE_WORKERS, 2)));
const PER_CLIENT = 1;
const QUEUE_PER_CLIENT = 4;
const MAX_ENTRIES = 20_000;
/** small text files are parsed inline: JSON.parse / XML of a few MB is quick and bounded */
const INLINE_TEXT_BYTES = 2 * 1024 * 1024;

export class ImportBusy extends Error {
  status = 429;
}

/**
 * The inflated size of a zip (xlsx, xlsm, ods) from its central directory, before anything is
 * inflated. null when the buffer is not a zip (xls is an OLE file: its size is its upload size).
 */
export function zipInflatedSize(buf: Buffer): { entries: number; total: number } | null {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('the workbook is damaged (its zip directory is missing)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new Error('ZIP64 workbooks are not accepted; save the workbook again or export it as CSV');
  if (count > MAX_ENTRIES) throw new Error('the workbook has too many parts');
  if (cdOff + cdSize > buf.length) throw new Error('the workbook is damaged (its zip directory points outside the file)');
  let p = cdOff;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('the workbook is damaged (bad zip directory entry)');
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    if (usize === 0xffffffff || csize === 0xffffffff) throw new Error('ZIP64 workbooks are not accepted; save the workbook again or export it as CSV');
    total += usize;
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return { entries: count, total };
}

// --- fair share: one parse per client at a time, SLOTS in all, a short queue per client ---------
const running = new Map<string, number>();
let busy = 0;
const waiting: { tenant: string; go: () => void }[] = [];

function pump() {
  for (let i = 0; i < waiting.length && busy < SLOTS; ) {
    const w = waiting[i];
    if ((running.get(w.tenant) ?? 0) < PER_CLIENT) {
      waiting.splice(i, 1);
      busy++;
      running.set(w.tenant, (running.get(w.tenant) ?? 0) + 1);
      w.go();
    } else i++;
  }
}
function admit(tenant: string): Promise<() => void> {
  const queued = waiting.filter((w) => w.tenant === tenant).length;
  if (queued >= QUEUE_PER_CLIENT) return Promise.reject(new ImportBusy('too many imports are waiting for this client; try again in a moment'));
  return new Promise((resolve) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      busy--;
      const n = (running.get(tenant) ?? 1) - 1;
      if (n > 0) running.set(tenant, n);
      else running.delete(tenant);
      pump();
    };
    waiting.push({ tenant, go: () => resolve(release) });
    pump();
  });
}

const workerFile = () => {
  const js = new URL('./parseworker.js', import.meta.url);
  return existsSync(fileURLToPath(js)) ? js : new URL('./parseworker.ts', import.meta.url); // tsx (dev)
};

function runWorker(data: { kind: 'workbook' | 'xml' | 'json'; buf?: Uint8Array; name: string; text?: string }): Promise<RawSet[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerFile(), {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
      env: {}, // the parser needs nothing from the server's environment
    });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void w.terminate();
    };
    const timer = setTimeout(() => done(() => reject(new Error(`reading the file took longer than ${Math.round(TIMEOUT_MS / 1000)} s; split it or export the sheets you need as CSV`))), TIMEOUT_MS);
    w.once('message', (m: { ok: boolean; out?: RawSet[]; error?: string }) => done(() => (m.ok ? resolve(m.out ?? []) : reject(new Error(m.error ?? 'the file could not be read')))));
    w.once('error', (e: Error & { code?: string }) =>
      done(() => reject(new Error(e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'the file needs more memory than an import may use; split it or export the sheets you need as CSV' : `the file could not be read: ${e.message}`))),
    );
    w.once('exit', (code) => done(() => reject(new Error(`the file could not be read (the parser stopped with code ${code})`))));
  });
}

/** Parse a workbook, XML or JSON file away from the server's thread, under the limits above. */
export async function parseIsolated(kind: 'workbook' | 'xml' | 'json', buf: Buffer, name: string, tenant: string, text?: string): Promise<RawSet[]> {
  if (kind === 'workbook') {
    const z = zipInflatedSize(buf);
    if (z && z.total > MAX_UNZIPPED) throw new Error(`the workbook inflates to ${Math.round(z.total / 1024 / 1024)} MB, more than the ${Math.round(MAX_UNZIPPED / 1024 / 1024)} MB an import may use; split it or export the sheets you need as CSV`);
  } else if (Buffer.byteLength(text ?? '', 'utf8') <= INLINE_TEXT_BYTES) {
    const { parseJson, parseXml } = await import('./parsers.js');
    return kind === 'xml' ? parseXml(text ?? '') : parseJson(text ?? '');
  }
  const release = await admit(tenant);
  try {
    return await runWorker(kind === 'workbook' ? { kind, buf: new Uint8Array(buf), name } : { kind, name, text });
  } finally {
    release();
  }
}
