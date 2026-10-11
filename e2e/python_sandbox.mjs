// Server-side Python: what a cell can see and what it can leave behind (review 11 Oct 2026, 1.6 and 1.7).
//
//   GRIDWRIGHT_PYTHON=/path/to/python-with-numpy-pandas-matplotlib node e2e/python_sandbox.mjs [server/dist] [--sandbox bwrap|unshare]
//
// Runs real cells through runPython (the warm pool) and checks:
//   - ordinary work (numpy, pandas, matplotlib, q) still runs;
//   - files outside the data directory (/opt, /etc) are not visible, and the root holds only what Python needs;
//   - nothing a cell starts outlives it — double fork + setsid, after a normal end and after a timeout;
//   - a finished cell whose leftover process holds its output open still returns at once;
//   - a fork bomb stops at the process limit; a huge print is cut.
//
// GW_PYSBX_DATA=<dir> uses that data directory (kept afterwards) instead of a fresh one — e.g. one holding the
// interpreter's venv in pyenv/, as an install made with --python has it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DIST = resolve(args[0] && !args[0].startsWith('--') ? args[0] : join(import.meta.dirname, '..', 'server', 'dist'));
const SANDBOX = opt('--sandbox') ?? 'bwrap';
const PRESET = process.env.GW_PYSBX_DATA;
const DATA = PRESET ? resolve(PRESET) : mkdtempSync(join(tmpdir(), 'gw-pysbx-'));
process.env.GRIDWRIGHT_DATA = DATA;
process.env.GRIDWRIGHT_PYTHON_SANDBOX = SANDBOX;
process.env.GRIDWRIGHT_PYTHON_TIMEOUT_MS = '10000';
process.env.GRIDWRIGHT_PYTHON_CONCURRENCY = '2';
if (!process.env.GRIDWRIGHT_PYTHON) {
  console.error('set GRIDWRIGHT_PYTHON to an interpreter with numpy, pandas and matplotlib');
  process.exit(2);
}
const py = await import(pathToFileURL(join(DIST, 'pyrun.js')).href);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 600)}` : ''}`);
};
const snap = { tables: [{ id: 1, name: 'Sales', rows: 3, cols: 2, values: [['region', 'amount'], ['North', 10], ['South', 32]] }], current: { table: 1, row: 0, col: 0 } };
const run = async (code) => {
  const t0 = Date.now();
  const r = await py.runPython(code, snap, false, 'acme');
  return { ...r, wall: Date.now() - t0 };
};
const pgrep = (pattern) => {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const st = await py.probePython(true);
check(`0. server-side Python is available in the ${SANDBOX} sandbox`, st.available && st.sandbox === SANDBOX, st.reason ?? `${st.sandbox} ${st.version}`);
if (!st.available) process.exit(1);

// ------------------------------------------------------------------------------------------ ordinary work
{
  const r = await run(`
import numpy as np, pandas as pd, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
df = q.df("A1:B3")
print("total", int(df["amount"].sum()), "mean", float(np.mean(df["amount"])))
fig, ax = plt.subplots(); ax.bar(df["region"], df["amount"])
fig`);
  check('1. numpy, pandas, matplotlib and q work', r.ok && /total 42 mean 21/.test(r.std_out) && JSON.stringify(r.output ?? '').includes('image'), r.error ?? r.std_out);
}
{
  const r = await run(`
import ssl, json, datetime, zoneinfo, locale, decimal, sqlite3
ctx = ssl.create_default_context()
print(len(ctx.get_ca_certs()) >= 0, datetime.datetime.now(zoneinfo.ZoneInfo("Europe/Lisbon")).year > 2000, sqlite3.sqlite_version)`);
  check('1b. the standard library (ssl, zoneinfo, sqlite3) works', r.ok && /^True True \d/.test(r.std_out.trim()), r.error ?? r.std_out);
}

// ------------------------------------------------------------------------------------------ what it can see
if (SANDBOX === 'bwrap') {
  const outside = ['/opt/gw-sandbox-probe/secret.txt', '/etc/gw-sandbox-probe.conf'];
  let planted = [];
  for (const f of outside) {
    try {
      execFileSync('sudo', ['-n', 'install', '-D', '-m', '0644', '/dev/null', f]);
      execFileSync('sudo', ['-n', 'sh', '-c', `echo planted-secret > ${f}`]);
      planted.push(f);
    } catch {
      /* no sudo: the listing check below still runs */
    }
  }
  // what the sandbox exposes on purpose: the runner and the interpreter's prefix (bwrap makes their parent directories, empty)
  const EXPOSED = [resolve(DIST, '..', 'runner'), resolve(process.env.GRIDWRIGHT_PYTHON, '..', '..')];
  const leading = new Set(EXPOSED.map((d) => d.split('/')[1]));
  const r = await run(`
import os
paths = ${JSON.stringify(outside)}
seen = [p for p in paths if os.path.exists(p)]
print("SEEN", seen)
print("ROOT", sorted(os.listdir("/")))
print("ETC", sorted(os.listdir("/etc")))
print("DATA", os.path.exists(${JSON.stringify(DATA)}))
writes = {}
for p in ["/gw-probe", "/var/gw-probe", "/etc/gw-probe", "/usr/gw-probe", "/tmp/gw-probe"]:
    try:
        open(p, "w").write("x"); writes[p] = "written"
    except OSError:
        writes[p] = "refused"
print("WRITES", sorted(writes.items()))
allowed = ${JSON.stringify(EXPOSED)}
found = []
for top in ["/opt", "/home", "/srv", "/var", "/root", "/mnt", "/media", "/boot", "/snap", ${JSON.stringify(DATA)}]:
    for d, _, files in os.walk(top):
        if any(d == a or d.startswith(a + "/") for a in allowed):
            continue
        found += [os.path.join(d, f) for f in files]
print("FILES", found[:20], len(found))`);
  const out = r.std_out ?? '';
  const root = (out.match(/ROOT (\[.*\])/) ?? [])[1] ?? '';
  const etc = (out.match(/ETC (\[.*\])/) ?? [])[1] ?? '';
  if (planted.length) check(`2. files outside the data directory are not visible (${planted.join(', ')})`, r.ok && /SEEN \[\]/.test(out), out.split('\n')[0]);
  else console.log('(2 skipped: sudo -n is not available to plant files under /opt and /etc)');
  // bwrap creates the parent directories of a bind (the runner's, the interpreter's), empty
  const files = (out.match(/FILES (.*)/) ?? [])[1] ?? '';
  check('2b. no host file outside /usr is there but the runner and the interpreter (/opt, /home, /srv, /var, /root, /mnt…)', r.ok && /\] 0$/.test(files) && !['srv', 'var', 'root', 'mnt', 'media', 'boot', 'snap', 'run', 'home'].some((n) => !leading.has(n) && root.includes(`'${n}'`)), `${files} root=${root}`);
  check('2c. /etc holds only the entries the sandbox gives it', r.ok && !/'(shadow|gridwright|sudoers|ssh|gw-sandbox-probe\.conf)'/.test(etc) && etc.length < 400, etc);
  // the data directory is not there — or, when the interpreter's venv lives in it (pyenv/), only that venv is
  const inData = resolve(process.env.GRIDWRIGHT_PYTHON).startsWith(DATA + '/');
  check(`2d. nothing of the data directory is visible${inData ? ' but the venv inside it' : ''}`, r.ok && (inData ? /\] 0$/.test(files) : /DATA False/.test(out)), out.split('\n').filter((l) => /^(DATA|FILES)/.test(l)).join(' | '));
  const writes = (out.match(/WRITES (.*)/) ?? [])[1] ?? '';
  check('2f. the root is read-only: a cell writes to /tmp only', r.ok && /'\/tmp\/gw-probe', 'written'/.test(writes) && !/'\/(gw-probe|var\/gw-probe|etc\/gw-probe|usr\/gw-probe)', 'written'/.test(writes), writes);
  for (const f of planted) {
    try {
      execFileSync('sudo', ['-n', 'rm', '-f', f]);
    } catch {
      /* best effort */
    }
  }
  try {
    execFileSync('sudo', ['-n', 'rmdir', '/opt/gw-sandbox-probe']);
  } catch {
    /* best effort */
  }
  const argv = py.wrap('bwrap', process.env.GRIDWRIGHT_PYTHON, false, true, 'acme').join(' ');
  const agent = py.wrapAgent('bwrap', { python: process.env.GRIDWRIGHT_PYTHON, pythonPath: [], expose: [], workDir: DATA, socket: join(DATA, 's.sock'), env: {}, tenant: 'acme' }).argv.join(' ');
  check('2e. neither the cell nor the agent sandbox starts from the host root', !argv.includes('--ro-bind / /') && !agent.includes('--ro-bind / /'), `${argv.slice(0, 160)} …`);
}

// ------------------------------------------------------------------------------------------ what it can leave behind
const STRAY = (tag) => `
import os, time
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        os.execv("/usr/bin/sleep", ["sleep", "${tag}"])
    os._exit(0)
time.sleep(0.3)
`;
{
  const r = await run(`${STRAY('41.4242')}\n"started"`);
  await sleep(1500);
  const left = pgrep('sleep 41.4242');
  check('3. a process a cell double-forks and detaches is gone when the cell ends', r.ok && !left, left ? `still running: pid ${left}` : r.error ?? '');
}
{
  // a leftover Python process (no exec) keeps every descriptor the cell had, its result pipe included
  const r = await run(`
import os, time
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        time.sleep(20)
    os._exit(0)
time.sleep(0.3)
"finished"`);
  check('3b. a cell returns at once even when a leftover process holds its output open', r.ok && r.wall < 5000, `${r.wall} ms ${r.error ?? ''}`);
}
{
  const r = await run(`${STRAY('43.4343')}\nwhile True:\n    pass`);
  await sleep(1500);
  const left = pgrep('sleep 43.4343');
  check('3c. …and when the cell is stopped at its time limit', !r.ok && /time limit/.test(r.error ?? '') && !left, left ? `still running: pid ${left}` : r.error);
}
{
  const r = await run(`
import os, time
n = 0
err = ""
try:
    for _ in range(2000):
        pid = os.fork()
        if pid == 0:
            time.sleep(30)
            os._exit(0)
        n += 1
except OSError as e:
    err = str(e)
print("forked", n, err)`);
  const n = Number((r.std_out.match(/forked (\d+)/) ?? [])[1] ?? -1);
  await sleep(1000);
  const left = Number(execFileSync('sh', ['-c', `ps -eo comm,args | grep -c "^python" || true`], { encoding: 'utf8' }).trim());
  check('4. a fork bomb stops at the process limit', r.ok && n >= 0 && n < 1000, `${r.std_out.trim()} ${r.error ?? ''}`);
  check('4b. …and its processes are gone afterwards', left < 20, `${left} python processes on the host`);
}
{
  const r = await run(`print("x" * 50_000_000)\n"done"`);
  check('5. a huge print is cut (50 MB printed)', r.ok && r.std_out.length < 2_000_000 && /output cut/.test(r.std_out), `${r.std_out.length} characters, ok=${r.ok} ${r.error ?? ''}`);
}
{
  const r = await run(`"still fine"`);
  check('6. the pool still runs cells afterwards', r.ok && JSON.stringify(r.output).includes('still fine'), r.error ?? '');
}

py.stopPool();
await sleep(500);
if (!PRESET) rmSync(DATA, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
