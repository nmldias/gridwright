// The dataset worker: reading a file into its raw tables, profiling each sheet, and running a recipe,
// off the main thread and under a memory ceiling (datasets.ts starts one per task with resourceLimits
// and a deadline, so a hostile workbook or a slow pattern cannot stall the server).
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { decodeText, ingestDelimited, RawWriter, registerFunctions, type SheetMeta } from './dsengine.js';
import { profileSheet, type SheetProfile } from './dsprofile.js';
import { runSteps, type RunOutput } from './dsrun.js';
import type { Step } from './dssteps.js';
import { openWorkbook } from './xlsxstream.js';
import { propose, type Proposal } from './proposer.js';
import { combine, relate, type CombineInput, type CombineOutput, type RelateInput, type RelateOutput } from './dsrelate.js';
import { insightsOf, type Insights } from './dsinsights.js';
import type { Roles } from './dssteps.js';

export type WorkerTask =
  | { task: 'read'; src: string; kind: 'xlsx' | 'delimited'; raw: string; limits: { maxRows: number; maxCols: number; maxInflated: number } }
  | { task: 'run'; raw: string; out: string | null; steps: Step[]; sheets: SheetMeta[]; sample?: number; preview: number }
  | { task: 'relate'; input: RelateInput }
  | { task: 'combine'; input: CombineInput }
  | { task: 'insights'; run: string; roles: Roles; unit?: string };

export interface ReadResult {
  sheets: SheetMeta[];
  profiles: SheetProfile[];
  proposal: Proposal | null;
  encoding?: string;
  delimiter?: string;
}

const progress = (phase: string, done: number, of: number) => parentPort!.postMessage({ progress: { phase, done, of } });

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536');
  registerFunctions(db);
  return db;
}

async function read(t: Extract<WorkerTask, { task: 'read' }>): Promise<ReadResult> {
  rmSync(t.raw, { force: true });
  const tmp = `${t.raw}.part`;
  rmSync(tmp, { force: true });
  const db = open(tmp);
  const sheets: SheetMeta[] = [];
  const out: ReadResult = { sheets, profiles: [], proposal: null };
  try {
    const buf = readFileSync(t.src);
    if (t.kind === 'xlsx') {
      const wb = await openWorkbook(buf, { maxInflated: t.limits.maxInflated, maxCols: t.limits.maxCols });
      for (let i = 0; i < wb.sheets.length; i++) {
        const w = new RawWriter(db, `raw_${i}`, t.limits);
        progress(`reading “${wb.sheets[i].name}”`, 0, 0);
        const r = await wb.rows(i, (n, cells) => {
          w.add(n, cells);
          if (n % 25_000 === 0) progress(`reading “${wb.sheets[i].name}”`, n, 0);
        });
        const f = w.finish();
        sheets.push({ index: i, name: wb.sheets[i].name, rows: f.rows, cols: f.cols, formulas: r.formulas, dimension: wb.sheets[i].dimension });
      }
    } else {
      const { text, encoding } = decodeText(buf);
      const w = new RawWriter(db, 'raw_0', t.limits);
      const { delimiter } = ingestDelimited(text, w);
      const f = w.finish();
      sheets.push({ index: 0, name: 'data', rows: f.rows, cols: f.cols, formulas: 0 });
      out.encoding = encoding;
      out.delimiter = delimiter;
    }
    db.exec('CREATE TABLE sheets (idx INTEGER PRIMARY KEY, name TEXT, rows INTEGER, cols INTEGER, formulas INTEGER, dimension TEXT)');
    const ins = db.prepare('INSERT INTO sheets VALUES (?, ?, ?, ?, ?, ?)');
    for (const s of sheets) ins.run(s.index, s.name, s.rows, s.cols, s.formulas, s.dimension ?? null);
    for (const s of sheets) {
      if (!s.rows || !s.cols) continue;
      out.profiles.push(profileSheet(db, s, 'main', (done, of) => progress(`profiling “${s.name}”`, done, of)));
    }
    db.close();
    renameSync(tmp, t.raw);
  } catch (e) {
    try {
      db.close();
    } catch {
      /* closed */
    }
    rmSync(tmp, { force: true });
    throw e;
  }
  // the largest sheet with a header is the one the first recipe is proposed for
  const main = [...out.profiles].sort((a, b) => b.rows * b.columns.length - a.rows * a.columns.length)[0];
  out.proposal = main ? propose(main) : null;
  return out;
}

function run(t: Extract<WorkerTask, { task: 'run' }>): RunOutput {
  const tmp = t.out ? `${t.out}.part` : null;
  if (tmp) rmSync(tmp, { force: true });
  const db = open(tmp ?? ':memory:');
  try {
    db.prepare('ATTACH DATABASE ? AS src').run(t.raw);
    const r = runSteps(db, t.steps, t.sheets, { sample: t.sample, preview: t.preview, onStep: (i, of, id) => progress(`step ${id}`, i, of) });
    db.exec('DETACH DATABASE src');
    if (tmp && r.ok) db.exec('CREATE INDEX IF NOT EXISTS work_row ON work(_row)');
    db.close();
    if (tmp && t.out) {
      if (r.ok) renameSync(tmp, t.out);
      else rmSync(tmp, { force: true });
    }
    return r;
  } catch (e) {
    try {
      db.close();
    } catch {
      /* closed */
    }
    if (tmp) rmSync(tmp, { force: true });
    throw e;
  }
}

async function main() {
  const t = workerData as WorkerTask;
  let out: ReadResult | RunOutput | RelateOutput | CombineOutput | Insights;
  if (t.task === 'read') out = await read(t);
  else if (t.task === 'run') out = run(t);
  else if (t.task === 'relate') out = relate(t.input, open);
  else if (t.task === 'combine') out = combine(t.input, open);
  else out = insightsOf(t.run, t.roles, t.unit, open);
  parentPort!.postMessage({ ok: true, out });
}

main().catch((e) => parentPort!.postMessage({ ok: false, error: (e as Error)?.message ?? String(e) }));
