// Server-side Python cells: the host's CPython (optionally with RAPIDS cuDF on the GPU) runs a
// cell's code against a workbook snapshot the client sends, inside the strongest sandbox the host
// offers — bubblewrap (own mount, PID, network namespaces; data directory and homes hidden),
// then a user+network namespace (`unshare -rn`), then a plain process. Every run is a fresh
// process with CPU, memory, file-size and wall-clock limits; the sandbox level is reported in the
// run record so an auditor can see what protected the host.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { cpus, freemem, homedir, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './storage.js';

export type Sandbox = 'bwrap' | 'unshare' | 'none';

export interface PythonLimits {
  timeoutMs: number;
  memoryMb: number;
  maxCells: number;
  concurrency: number;
  /** BLAS/OpenMP threads per run (keeps numpy's per-core buffers and the pool's CPU use in check) */
  threads: number;
}

export interface PythonStatus {
  available: boolean;
  interpreter: string;
  version: string;
  sandbox: Sandbox | null;
  /** "cudf 25.10" when a GPU-requested probe found RAPIDS, otherwise the reason it did not */
  gpu: string | null;
  reason?: string;
  /** why the stronger sandboxes were not used (e.g. "bwrap: not installed; unshare: Operation not permitted") */
  fallbacks?: string;
  limits: PythonLimits;
}

export interface Snapshot {
  tables: { id: number; name: string; rows: number; cols: number; values: unknown[][] }[];
  current: { table: number; row: number; col: number };
}

export interface RunResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  std_out: string;
  deps: { table: number; r0: number; c0: number; r1: number; c1: number }[];
  runtime: { name: string; version: string; packages: Record<string, string> };
  ms: number;
}

const here = dirname(fileURLToPath(import.meta.url));
/** Caches that survive sandbox instances and restarts: matplotlib fonts, numba/cuPy JIT kernels. */
const CACHE_DIR = join(DATA_DIR, 'pycache');
try {
  mkdirSync(CACHE_DIR, { recursive: true });
} catch {
  /* reported when a run fails */
}
const CACHE_IN_SANDBOX = '/tmp/gw-cache';
const cacheEnv = (base: string): Record<string, string> => ({ MPLCONFIGDIR: join(base, 'mpl'), NUMBA_CACHE_DIR: join(base, 'numba'), CUPY_CACHE_DIR: join(base, 'cupy'), XDG_CACHE_HOME: join(base, 'xdg') });
const RUNNER = [join(here, '../runner/gridwright_runner.py'), join(here, '../../runner/gridwright_runner.py')].find((p) => existsSync(p)) ?? join(here, '../runner/gridwright_runner.py');
const MARKER = '\n__GRIDWRIGHT_RESULT__\n';

const num = (v: string | undefined, dflt: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
};

// per-run memory by default: a quarter of the machine, but no more than half of what is free at
// start (the host may share the box with models), never less than 2 GB — a runaway cell is stopped
// long before the host suffers, and a real workload still has tens of GB on a DGX Spark
const DEFAULT_MEMORY_MB = Math.max(2048, Math.floor(Math.min(totalmem() / 4, freemem() / 2) / 1024 / 1024));
export const LIMITS: PythonLimits = {
  timeoutMs: num(process.env.GRIDWRIGHT_PYTHON_TIMEOUT_MS, 60_000, 600_000),
  memoryMb: num(process.env.GRIDWRIGHT_PYTHON_MEMORY_MB, DEFAULT_MEMORY_MB, 1_048_576),
  maxCells: num(process.env.GRIDWRIGHT_PYTHON_MAX_CELLS, 200_000, 5_000_000),
  concurrency: num(process.env.GRIDWRIGHT_PYTHON_CONCURRENCY, 2, 32),
  threads: num(process.env.GRIDWRIGHT_PYTHON_THREADS, Math.max(1, Math.min(4, cpus().length)), 256),
};

/** Environment every run gets: thread caps for BLAS/OpenMP (per-core buffers!) and a lean allocator. */
function runtimeEnv(): Record<string, string> {
  const t = String(LIMITS.threads);
  return { OPENBLAS_NUM_THREADS: t, OMP_NUM_THREADS: t, MKL_NUM_THREADS: t, NUMEXPR_MAX_THREADS: t, POLARS_MAX_THREADS: t, MALLOC_ARENA_MAX: '2', LANG: 'C.UTF-8', MPLBACKEND: 'Agg', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };
}

let status: PythonStatus = { available: false, interpreter: '', version: '', sandbox: null, gpu: null, reason: 'not probed yet', limits: LIMITS };
let probing: Promise<PythonStatus> | null = null;

function which(cmd: string): Promise<string | null> {
  return new Promise((res) => execFile('sh', ['-c', `command -v ${cmd}`], { timeout: 5000 }, (err, out) => res(err ? null : out.trim() || null)));
}

/** The interpreter: GRIDWRIGHT_PYTHON, else a venv the installer made in the data directory, else python3 on PATH. */
async function interpreter(): Promise<string | null> {
  const cfg = (process.env.GRIDWRIGHT_PYTHON ?? '').trim();
  if (cfg.toLowerCase() === 'off' || cfg === '0') return null;
  if (cfg) return existsSync(cfg) ? cfg : await which(cfg);
  const venv = join(DATA_DIR, 'pyenv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  return (await which('python3')) ?? (await which('python'));
}

/** Directories hidden from sandboxed code (secrets, documents, other people's files). */
function hiddenDirs(): string[] {
  const out = new Set<string>([resolve(DATA_DIR), '/root', '/home']);
  try {
    out.add(homedir());
  } catch {
    /* no home */
  }
  return Array.from(out).filter((d) => existsSync(d));
}

function nvidiaDevices(): string[] {
  try {
    return readdirSync('/dev')
      .filter((n) => n.startsWith('nvidia'))
      .map((n) => join('/dev', n));
  } catch {
    return [];
  }
}

/** argv that runs the runner script under the given sandbox (`serve` = warm host mode). */
export function wrap(sandbox: Sandbox, py: string, gpu: boolean, serve = false): string[] {
  const script = RUNNER;
  const tail = serve ? [py, script, '--serve'] : [py, script];
  if (sandbox === 'bwrap') {
    const args = ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv'];
    for (const dir of hiddenDirs()) args.push('--tmpfs', dir);
    // re-expose what the interpreter and the runner need, read-only, even when they live under a hidden directory
    const expose = new Set<string>([dirname(script), resolve(dirname(dirname(py)))]);
    for (const dir of expose) if (existsSync(dir)) args.push('--ro-bind', dir, dir);
    if (gpu) for (const dev of nvidiaDevices()) args.push('--dev-bind', dev, dev);
    // one writable directory for library caches (fonts, JIT kernels), bound after the hiding mounts
    if (existsSync(CACHE_DIR)) args.push('--bind', CACHE_DIR, CACHE_IN_SANDBOX);
    args.push('--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp');
    for (const [k, v] of Object.entries({ ...runtimeEnv(), ...cacheEnv(CACHE_IN_SANDBOX) })) args.push('--setenv', k, v);
    for (const k of ['LD_LIBRARY_PATH', 'CUDA_HOME', 'CUDA_VISIBLE_DEVICES', 'VIRTUAL_ENV']) if (process.env[k]) args.push('--setenv', k, process.env[k] as string);
    args.push('--chdir', '/tmp');
    return ['bwrap', ...args, ...tail];
  }
  if (sandbox === 'unshare') return ['unshare', '-rn', '--kill-child', '--', ...tail];
  return tail;
}

function childEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: cwd, ...runtimeEnv(), ...cacheEnv(CACHE_DIR) };
  for (const k of ['LD_LIBRARY_PATH', 'CUDA_HOME', 'CUDA_VISIBLE_DEVICES', 'VIRTUAL_ENV']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

interface RawRun {
  result: Record<string, unknown> | null;
  code: number | null;
  signal: string | null;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

function execute(argv: string[], request: unknown, timeoutMs: number): Promise<RawRun> {
  return new Promise((res) => {
    const t0 = Date.now();
    const cwd = mkdtempSync(join(tmpdir(), 'gw-py-'));
    const child = spawn(argv[0], argv.slice(1), { cwd, env: childEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      if (outBytes < 96 * 1024 * 1024) {
        out.push(b);
        outBytes += b.length;
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      if (errBytes < 64 * 1024) {
        err.push(b);
        errBytes += b.length;
      }
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      const text = Buffer.concat(out).toString('utf8');
      const idx = text.lastIndexOf(MARKER);
      let result: Record<string, unknown> | null = null;
      if (idx >= 0) {
        try {
          result = JSON.parse(text.slice(idx + MARKER.length)) as Record<string, unknown>;
        } catch {
          result = null;
        }
      }
      res({ result, code, signal, stderr: Buffer.concat(err).toString('utf8'), timedOut, ms: Date.now() - t0 });
    };
    child.on('error', (e) => {
      err.push(Buffer.from(String(e.message)));
      finish(null, null);
    });
    child.on('close', finish);
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
}

async function probeSandbox(py: string, sb: Sandbox): Promise<{ ok: boolean; version: string; reason?: string }> {
  const r = await execute(wrap(sb, py, false), { code: '1+1', snapshot: { tables: [], current: { table: 0, row: 0, col: 0 } }, gpu: false, limits: { cpuSeconds: 60, memoryMb: LIMITS.memoryMb } }, 120_000);
  const out = r.result?.output as unknown[][] | undefined;
  if (r.result?.ok && Array.isArray(out) && out[0]?.[0] === 2) {
    return { ok: true, version: String((r.result.runtime as { version?: string })?.version ?? '') };
  }
  const detail = (r.stderr || (r.result?.error as string) || '').trim().split('\n').filter(Boolean).slice(-1)[0];
  return { ok: false, version: '', reason: `${detail || 'no output'} (exit ${r.code ?? r.signal ?? '?'})` };
}

/** Find the interpreter and the strongest working sandbox; GPU availability is probed separately. */
export function probePython(force = false): Promise<PythonStatus> {
  if (probing && !force) return probing;
  probing = (async () => {
    const py = await interpreter();
    if (!py) {
      status = { ...status, available: false, interpreter: '', version: '', sandbox: null, gpu: null, reason: process.env.GRIDWRIGHT_PYTHON?.toLowerCase() === 'off' ? 'disabled (GRIDWRIGHT_PYTHON=off)' : 'no python3 on this host (set GRIDWRIGHT_PYTHON or run the installer with --python)' };
      return status;
    }
    const want = (process.env.GRIDWRIGHT_PYTHON_SANDBOX ?? 'auto').toLowerCase();
    const order: Sandbox[] = want === 'bwrap' ? ['bwrap'] : want === 'unshare' ? ['unshare'] : want === 'none' ? ['none'] : want === 'require' ? ['bwrap', 'unshare'] : ['bwrap', 'unshare', 'none'];
    const reasons: string[] = [];
    for (const sb of order) {
      if (sb !== 'none' && !(await which(sb))) {
        reasons.push(`${sb}: not installed`);
        continue;
      }
      const p = await probeSandbox(py, sb);
      if (p.ok) {
        status = { available: true, interpreter: py, version: p.version, sandbox: sb, gpu: status.gpu, fallbacks: reasons.length ? reasons.join('; ') : undefined, limits: LIMITS };
        warmPool();
        void probeGpu();
        return status;
      }
      reasons.push(`${sb}: ${p.reason}`);
    }
    status = { available: false, interpreter: py, version: '', sandbox: null, gpu: null, reason: reasons.join('; ') || 'no sandbox', limits: LIMITS };
    return status;
  })();
  return probing;
}

/** Does a GPU-requested run find RAPIDS cuDF? Slow (imports cudf), so it runs in the background. */
export async function probeGpu(): Promise<string | null> {
  if (!status.available || !status.sandbox) return null;
  const r = await execute(wrap(status.sandbox, status.interpreter, true), { code: '1', snapshot: { tables: [], current: { table: 0, row: 0, col: 0 } }, gpu: true, limits: { cpuSeconds: 60, memoryMb: LIMITS.memoryMb } }, 90_000);
  const gpu = String(((r.result?.runtime as { packages?: Record<string, string> })?.packages ?? {}).gpu ?? (r.timedOut ? 'unavailable: probe timed out' : 'unavailable'));
  status = { ...status, gpu };
  return gpu;
}

export const pythonStatus = () => status;

// --- warm pool -----------------------------------------------------------------------------
// CPU runs go to a pool of sandboxed host processes that imported pandas/numpy/matplotlib once and
// fork a fresh child per run (copy-on-write: ~10 ms per run instead of ~1 s). GPU runs use a fresh
// process each time, because forking after CUDA initialisation is not safe.

interface Host {
  proc: ChildProcess;
  busy: boolean;
  /** resolves when the host has imported its libraries and is reading requests; rejects if it dies first */
  ready: Promise<void>;
  buf: string;
  waiter: ((line: Record<string, unknown>) => void) | null;
  runs: number;
  dead: boolean;
}

const hosts: Host[] = [];
const queue: (() => void)[] = [];
const MAX_RUNS_PER_HOST = 500;
/** a cold host imports pandas, numpy and matplotlib; the very first start may also build font caches */
const HOST_START_MS = 180_000;

function dropHost(host: Host) {
  host.dead = true;
  const i = hosts.indexOf(host);
  if (i >= 0) hosts.splice(i, 1);
}

function drainQueue() {
  const next = queue.shift();
  if (next) next();
}

function startHost(sandbox: Sandbox, py: string): Host {
  const argv = wrap(sandbox, py, false, true);
  const cwd = mkdtempSync(join(tmpdir(), 'gw-pyhost-'));
  const proc = spawn(argv[0], argv.slice(1), { cwd, env: childEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'] });
  let markReady: () => void = () => undefined;
  let markDead: (e: Error) => void = () => undefined;
  const ready = new Promise<void>((res, rej) => {
    markReady = res;
    markDead = rej;
  });
  ready.catch(() => undefined); // observed by hostRun; never an unhandled rejection
  const host: Host = { proc, busy: false, ready, buf: '', waiter: null, runs: 0, dead: false };
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    host.buf += chunk;
    let nl: number;
    while ((nl = host.buf.indexOf('\n')) >= 0) {
      const line = host.buf.slice(0, nl);
      host.buf = host.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (msg.ready) {
        markReady();
        continue;
      }
      host.waiter?.(msg);
    }
  });
  proc.stderr!.on('data', (b: Buffer) => {
    const text = b.toString('utf8').trim();
    if (text) console.error('python host:', text.slice(0, 500));
  });
  proc.stdin!.on('error', () => undefined);
  proc.on('error', (e) => markDead(e));
  proc.on('exit', (code, signal) => {
    rmSync(cwd, { recursive: true, force: true });
    dropHost(host);
    markDead(new Error(`python host exited (${code ?? signal})`));
    const w = host.waiter;
    host.waiter = null;
    w?.({ id: -1, result: { ok: false, error: 'the Python host process exited', std_out: '', deps: [] } });
    drainQueue(); // a run waiting for this host must move to a fresh one
  });
  hosts.push(host);
  return host;
}

function idleHost(sandbox: Sandbox, py: string): Host | null {
  const free = hosts.find((h) => !h.busy && !h.dead);
  if (free) return free;
  if (hosts.length < LIMITS.concurrency) return startHost(sandbox, py);
  return null;
}

/** Start one host ahead of the first cell so it does not pay the cold start. */
export function warmPool() {
  if (!status.available || !status.sandbox || hosts.length) return;
  const host = startHost(status.sandbox, status.interpreter);
  host.ready.catch((e) => console.error('python host failed to start:', (e as Error).message));
}

async function hostRun(host: Host, request: Record<string, unknown>, timeoutMs: number): Promise<{ result: Record<string, unknown> | null; ms: number }> {
  host.busy = true;
  host.runs++;
  const t0 = Date.now();
  // start-up (library imports, caches) is not the run's time: wait for the host first, with its own limit
  const startTimer = setTimeout(() => host.proc.kill('SIGKILL'), HOST_START_MS);
  try {
    await host.ready;
  } catch {
    clearTimeout(startTimer);
    return { result: null, ms: Date.now() - t0 };
  }
  clearTimeout(startTimer);
  return new Promise((res) => {
    let done = false;
    // the host enforces the run's deadline itself; this watchdog only fires if the host is wedged
    const watchdog = setTimeout(() => {
      if (done) return;
      done = true;
      host.waiter = null;
      dropHost(host);
      try {
        host.proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
      res({ result: null, ms: Date.now() - t0 });
    }, timeoutMs + 5000);
    host.waiter = (msg) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      host.waiter = null;
      host.busy = false;
      if (host.runs >= MAX_RUNS_PER_HOST && !host.dead) {
        dropHost(host);
        host.proc.kill(); // periodic recycle keeps the host lean; its exit handler drains the queue
      } else drainQueue();
      res({ result: (msg.result as Record<string, unknown>) ?? null, ms: Date.now() - t0 });
    };
    host.proc.stdin!.write(JSON.stringify(request) + '\n');
  });
}

function pooledRun(sandbox: Sandbox, py: string, request: Record<string, unknown>, timeoutMs: number): Promise<{ result: Record<string, unknown> | null; ms: number }> {
  return new Promise((res) => {
    const attempt = () => {
      const host = idleHost(sandbox, py);
      if (!host) {
        queue.push(attempt);
        return;
      }
      void hostRun(host, request, timeoutMs).then((r) => {
        const retries = (request.retries as number) ?? 0;
        if (!r.result && retries < 1) {
          // the host died or wedged under us: once more on a fresh one
          request.retries = retries + 1;
          attempt();
        } else res(r);
      });
    };
    attempt();
  });
}

/** Stop the pool (tests, shutdown). */
export function stopPool() {
  for (const h of hosts.splice(0)) {
    h.dead = true;
    h.proc.kill();
  }
}

// GPU runs: a fresh process each time, at most `concurrency` at once
let gpuRunning = 0;
const gpuWaiting: (() => void)[] = [];
const acquireGpu = () =>
  new Promise<void>((res) => {
    if (gpuRunning < LIMITS.concurrency) {
      gpuRunning++;
      res();
    } else gpuWaiting.push(res);
  });
const releaseGpu = () => {
  const next = gpuWaiting.shift();
  if (next) next();
  else gpuRunning--;
};

/** Run one cell. Never throws: every failure is an `ok: false` result the client can show. */
export async function runPython(code: string, snapshot: Snapshot, gpu: boolean): Promise<RunResult> {
  const st = status.available ? status : await probePython();
  const base = { std_out: '', deps: [] as RunResult['deps'], runtime: { name: 'python-server', version: st.version, packages: { sandbox: st.sandbox ?? 'none' } }, ms: 0 };
  if (!st.available || !st.sandbox) return { ...base, ok: false, error: `server-side Python is not available: ${st.reason ?? 'unknown'}` };
  const limits = { cpuSeconds: Math.ceil(LIMITS.timeoutMs / 1000), memoryMb: LIMITS.memoryMb, maxCells: LIMITS.maxCells, fileMb: 64 };
  if (!gpu) {
    const r = await pooledRun(st.sandbox, st.interpreter, { id: Date.now(), code, snapshot, gpu: false, limits, timeoutMs: LIMITS.timeoutMs, retries: 0 }, LIMITS.timeoutMs);
    if (r.result) {
      const runtime = (r.result.runtime as RunResult['runtime']) ?? base.runtime;
      runtime.packages = { ...(runtime.packages ?? {}), sandbox: st.sandbox };
      return { ok: !!r.result.ok, output: r.result.output ?? null, error: r.result.error as string | undefined, std_out: String(r.result.std_out ?? ''), deps: (r.result.deps as RunResult['deps']) ?? [], runtime, ms: r.ms };
    }
    return { ...base, ok: false, error: `the Python host did not answer within ${Math.round(LIMITS.timeoutMs / 1000)} s and was restarted`, ms: r.ms };
  }
  await acquireGpu();
  try {
    const r = await execute(wrap(st.sandbox, st.interpreter, true), { code, snapshot, gpu: true, limits }, LIMITS.timeoutMs + 2000);
    if (r.result) {
      const runtime = (r.result.runtime as RunResult['runtime']) ?? base.runtime;
      runtime.packages = { ...(runtime.packages ?? {}), sandbox: st.sandbox };
      return { ok: !!r.result.ok, output: r.result.output ?? null, error: r.result.error as string | undefined, std_out: String(r.result.std_out ?? ''), deps: (r.result.deps as RunResult['deps']) ?? [], runtime, ms: r.ms };
    }
    const tail = r.stderr.trim().split('\n').slice(-3).join('\n');
    const error = r.timedOut ? `time limit of ${Math.round(LIMITS.timeoutMs / 1000)} s exceeded` : r.signal === 'SIGKILL' ? `the process was killed (memory limit ${LIMITS.memoryMb} MB?)${tail ? `: ${tail}` : ''}` : `python exited with ${r.code ?? r.signal}${tail ? `: ${tail}` : ''}`;
    return { ...base, ok: false, error, ms: r.ms };
  } finally {
    releaseGpu();
  }
}
