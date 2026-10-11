// History log integrity: every entry of a document's log gets a sequence number of its own, and the
// numbering survives a restart whatever the size of the entries (review 11 Oct 2026, finding 1.4: a
// last entry larger than 64 KB made a restarted server count from 0 and hand out numbers again).
//
//   node e2e/history_log.mjs [server/dist]
//
// Each step runs in a fresh Node process — a restart — against the built history module, with its
// own data directory. Exit code 0 when every check passes.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'server', 'dist'));
const HISTORY = pathToFileURL(join(DIST, 'history.js')).href;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Run `body` (an async function's source, given `h` = the history module) in a new process; returns its JSON result. */
function inProcess(data, body) {
  const code = `const h = await import(${JSON.stringify(HISTORY)});\nconst out = await (async () => { ${body} })();\nprocess.stdout.write('\\n' + JSON.stringify(out ?? null) + '\\n');\n`;
  const script = join(data, `step-${results.length}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, code);
  const r = spawnSync(process.execPath, ['--no-warnings', script], { env: { ...process.env, GRIDWRIGHT_DATA: data }, encoding: 'utf8', timeout: 120_000 });
  rmSync(script, { force: true });
  if (r.error) throw new Error(`step could not start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`step failed (exit ${r.status}): ${String(r.stderr).slice(-2000)}`);
  // the module may log (an import of an old log says so): the result is the last line
  const lines = String(r.stdout).trim().split('\n');
  if (lines.length > 1) console.log(`     (logged: ${lines.slice(0, -1).join(' | ').slice(0, 300)})`);
  return JSON.parse(lines.at(-1) || 'null');
}
const author = { id: 'test', name: 'Test' };
const fresh = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `gw-history-${tag}-`));
  mkdirSync(join(d, 'files'), { recursive: true });
  return d;
};
const dirs = [];
const seqsOf = (entries) => entries.map((e) => e.seq);
const strictlyIncreasing = (s) => s.every((v, i) => i === 0 || v > s[i - 1]);
const unique = (s) => new Set(s).size === s.length;

try {
  // 1. an entry larger than 64 KB at the end of the log, then a restart
  {
    const d = fresh('big');
    dirs.push(d);
    const a = inProcess(d, `
      const big = Array.from({ length: 400 }, (_, r) => Array.from({ length: 30 }, (_, c) => 'value ' + r + '-' + c + ' xxxxxxxx'));
      const s1 = h.appendEntry('doc1', { author: ${JSON.stringify(author)}, origin: 'user', op: { type: 'set_cell', table: 1, row: 0, col: 0, input: 'a' } });
      const s2 = h.appendEntry('doc1', { author: ${JSON.stringify(author)}, origin: 'import', op: { type: 'set_cells', table: 1, row: 1, col: 0, values: big } });
      return { s1, s2, size: JSON.stringify(big).length };`);
    check('1a. the first two entries are numbered 1 and 2', a.s1 === 1 && a.s2 === 2, `got ${a.s1}, ${a.s2}; the second entry is ${Math.round(a.size / 1024)} KB`);
    const b = inProcess(d, `
      const before = h.currentSeq('doc1');
      const s3 = h.appendEntry('doc1', { author: ${JSON.stringify(author)}, origin: 'user', op: { type: 'set_cell', table: 1, row: 0, col: 1, input: 'b' } });
      return { before, s3, seqs: h.readAll('doc1').map((e) => e.seq) };`);
    check('1b. after a restart the log still knows it is at 2', b.before === 2, `currentSeq after restart = ${b.before}`);
    check('1c. the next entry after the restart is 3, not a number already used', b.s3 === 3, `got ${b.s3}`);
    check('1d. the log has unique, increasing numbers after the restart', unique(b.seqs) && strictlyIncreasing(b.seqs), `seqs ${JSON.stringify(b.seqs)}`);
  }

  // 2. many appends in one process: contiguous numbering, nothing lost
  {
    const d = fresh('many');
    dirs.push(d);
    const r = inProcess(d, `
      const got = [];
      for (let i = 0; i < 1500; i++) got.push(h.appendEntry('doc2', { author: ${JSON.stringify(author)}, origin: 'user', op: { type: 'set_cell', table: 1, row: i, col: 0, input: String(i) } }));
      return { got, all: h.readAll('doc2').length, cur: h.currentSeq('doc2') };`);
    check('2a. 1,500 appends are numbered 1..1500 with no gap or repeat', r.got.every((s, i) => s === i + 1), `last ${r.got.at(-1)}`);
    check('2b. all 1,500 are read back and the head is 1500', r.all === 1500 && r.cur === 1500, `read ${r.all}, head ${r.cur}`);
    const q = inProcess(d, `
      return {
        since: h.entriesSince('doc2', 1490).map((e) => e.seq),
        capped: h.entriesSince('doc2', 0, 10).map((e) => e.seq),
        recent: h.recentEntries('doc2', 3).map((e) => e.seq),
        before: h.recentEntries('doc2', 3, 100).map((e) => e.seq),
        other: h.currentSeq('doc-unknown'),
      };`);
    check('2c. entriesSince returns the entries after a position, in order', JSON.stringify(q.since) === JSON.stringify([1491, 1492, 1493, 1494, 1495, 1496, 1497, 1498, 1499, 1500]), JSON.stringify(q.since));
    check('2d. entriesSince honours its limit', JSON.stringify(q.capped) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), JSON.stringify(q.capped));
    check('2e. recentEntries is newest first, and "before" excludes that position', JSON.stringify(q.recent) === '[1500,1499,1498]' && JSON.stringify(q.before) === '[99,98,97]', `${JSON.stringify(q.recent)} ${JSON.stringify(q.before)}`);
    check('2f. a document without a log is at 0', q.other === 0, String(q.other));
  }

  // 3. checkpoints, replay and deletion
  {
    const d = fresh('replay');
    dirs.push(d);
    const r = inProcess(d, `
      const A = ${JSON.stringify(author)};
      h.appendEntry('doc3', { author: A, origin: 'user', op: { type: 'set_cell', table: 1, row: 0, col: 0, input: '1' } });
      const cp = h.appendEntry('doc3', { author: A, origin: 'user', checkpoint: true, note: 'saved' });
      h.writeCheckpoint('doc3', cp, '{"name":"x","tables":[]}');
      h.appendEntry('doc3', { author: A, origin: 'code', note: 'a run', run: { table: 1, row: 0, col: 0 } });
      h.appendEntry('doc3', { author: A, origin: 'user', op: { type: 'set_cell', table: 1, row: 1, col: 0, input: '2' } });
      const b = h.replayBundle('doc3', h.currentSeq('doc3'));
      const out = { cp, checkpointSeq: b.checkpointSeq, json: b.json, ops: b.ops.map((e) => e.seq), seqs: h.checkpointSeqs('doc3') };
      if (typeof h.contentChangesSince === 'function') out.changes = [h.contentChangesSince('doc3', 0), h.contentChangesSince('doc3', cp), h.contentChangesSince('doc3', 4)];
      h.deleteHistory('doc3');
      out.afterDelete = h.currentSeq('doc3');
      out.afterDeleteAll = h.readAll('doc3').length;
      out.reused = h.appendEntry('doc3', { author: A, origin: 'user', op: { type: 'set_cell', table: 1, row: 0, col: 0, input: 'new' } });
      return out;`);
    check('3a. a replay starts at the newest checkpoint and carries only the ops after it', r.checkpointSeq === r.cp && r.json === '{"name":"x","tables":[]}' && JSON.stringify(r.ops) === '[4]', `checkpoint ${r.checkpointSeq}, ops ${JSON.stringify(r.ops)}`);
    check('3b. the checkpoint is listed at its position', JSON.stringify(r.seqs) === JSON.stringify([r.cp]), JSON.stringify(r.seqs));
    if (r.changes) check('3c. content changes after a position count ops and checkpoints, not runs', JSON.stringify(r.changes) === '[3,1,0]', JSON.stringify(r.changes));
    else check('3c. content changes after a position count ops and checkpoints, not runs', false, 'contentChangesSince is missing');
    check('3d. deleting the history empties the log', r.afterDelete === 0 && r.afterDeleteAll === 0, `head ${r.afterDelete}, ${r.afterDeleteAll} entries`);
    check('3e. a log started again after deletion counts from 1', r.reused === 1, String(r.reused));
  }

  // 4. a log written by an earlier version (one JSON line per entry), including numbers the old bug handed out twice
  {
    const d = fresh('legacy');
    dirs.push(d);
    const hist = join(d, 'history');
    mkdirSync(join(hist, 'doc4'), { recursive: true });
    const line = (seq, extra) => JSON.stringify({ seq, ts: `2026-10-0${Math.min(seq, 9)}T10:00:00.000Z`, author, origin: 'user', ...extra });
    const lines = [
      line(1, { op: { type: 'set_cell', table: 1, row: 0, col: 0, input: 'a' } }),
      line(2, { checkpoint: true, note: 'saved' }),
      line(3, { op: { type: 'set_cell', table: 1, row: 0, col: 1, input: 'b' } }),
      // the restart bug: numbering started again at 1
      line(1, { op: { type: 'set_cell', table: 1, row: 0, col: 2, input: 'c' } }),
      line(2, { op: { type: 'set_cell', table: 1, row: 0, col: 3, input: 'd' }, note: 'typed' }),
      '{"seq": 9, "ts": "partial line', // a torn last line
    ];
    writeFileSync(join(hist, 'doc4.ops.jsonl'), lines.join('\n') + '\n');
    writeFileSync(join(hist, 'doc4', '2.json'), '{"name":"legacy","tables":[]}');
    const r = inProcess(d, `
      const all = h.readAll('doc4');
      const head = h.currentSeq('doc4');
      const next = h.appendEntry('doc4', { author: ${JSON.stringify(author)}, origin: 'user', op: { type: 'set_cell', table: 1, row: 0, col: 4, input: 'e' } });
      return { seqs: all.map((e) => e.seq), inputs: all.map((e) => e.op?.input ?? null), notes: all.map((e) => e.note ?? ''), head, next, cps: h.checkpointSeqs('doc4') };`);
    check('4a. an earlier version\'s log is read with every entry, in order', JSON.stringify(r.inputs) === JSON.stringify(['a', null, 'b', 'c', 'd']), JSON.stringify(r.inputs));
    check('4b. numbers handed out twice are renumbered after the last good one', JSON.stringify(r.seqs) === '[1,2,3,4,5]', JSON.stringify(r.seqs));
    check('4c. a renumbered entry says what it was', /renumbered from 1/.test(r.notes[3]) && /typed/.test(r.notes[4]) && /renumbered from 2/.test(r.notes[4]), JSON.stringify(r.notes.slice(3)));
    check('4d. the head after the import is 5 and the next entry is 6', r.head === 5 && r.next === 6, `head ${r.head}, next ${r.next}`);
    check('4e. checkpoints keep their positions', JSON.stringify(r.cps) === '[2]', JSON.stringify(r.cps));
    const files = readdirSync(hist);
    check('4f. the old log file is kept aside, not deleted', files.includes('doc4.ops.jsonl.migrated') && !files.includes('doc4.ops.jsonl'), files.join(' '));
    const again = inProcess(d, `return { seqs: h.readAll('doc4').map((e) => e.seq), head: h.currentSeq('doc4') };`);
    check('4g. after another restart nothing is imported twice', JSON.stringify(again.seqs) === '[1,2,3,4,5,6]' && again.head === 6, JSON.stringify(again.seqs));
  }
} catch (e) {
  check('the test ran to the end', false, e.message);
} finally {
  for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
