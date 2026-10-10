// Scoped investigation for the companion: generated code runs against the live document inside
// the same sandbox as Python cells (bubblewrap, no network, no data directory), and a bounded
// investigation runs as a separate process — the LangChain + DeepAgents + LangGraph stack in
// integrations/companion — that calls back over the loopback interface with a short-lived token
// carrying exactly the requesting person's identity. Everything it does is recorded: every run
// with its code hash and sandbox, every record it proposes, every proposal it files. It changes
// nothing by itself.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishInvestigation, recordRun, requestCancel, setFenceHook, setInvestigationJob, startInvestigation, type Investigation } from './companion.js';
import { fnv } from './evidence.js';
import { openDocument, snapshotOf } from './headless.js';
import { identityForLogin, issueAgentToken, revokeAgentToken, type Identity } from './identity.js';
import { hiddenDirs, runAsAgentCell, runPython, type RunResult, type Snapshot } from './pyrun.js';
import { aiKeyOf, crashPoint, DATA_DIR, readAiConfig } from './storage.js';
import { tenantOfDoc } from './access.js';
import { ACCOUNTS } from './tenancy.js';
import type { Author } from './history.js';
import { cancelJob, enqueue, kick, listJobs, registerRunner, supersedeJobsOf, type JobOutcome } from './jobs.js';

// a change of direction fences the document's running jobs along with its investigations
setFenceHook((doc, why) => supersedeJobsOf(doc, why));

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = [join(here, '../../integrations/companion/investigate.py'), join(here, '../integrations/companion/investigate.py'), process.env.GRIDWRIGHT_INVESTIGATE_SCRIPT ?? ''].find((p) => p && existsSync(p)) ?? join(here, '../../integrations/companion/investigate.py');
const TIMEOUT_MS = Number(process.env.GRIDWRIGHT_INVESTIGATION_TIMEOUT_MS ?? 600_000);

/** The interpreter the stack runs under: GRIDWRIGHT_AGENT_PYTHON, else the installer's venv when it has the packages, else python3. */
function agentPython(): string {
  const cfg = (process.env.GRIDWRIGHT_AGENT_PYTHON ?? '').trim();
  if (cfg) return cfg;
  const venv = join(DATA_DIR, 'pyenv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

export interface StackStatus {
  available: boolean;
  python: string;
  script: string;
  reason?: string;
  versions?: Record<string, string>;
}
let stack: StackStatus = { available: false, python: agentPython(), script: SCRIPT, reason: 'not probed yet' };
let probing: Promise<StackStatus> | null = null;

/** Is the investigation stack installed for the agent interpreter? Probed once at start and on request. */
export function probeStack(force = false): Promise<StackStatus> {
  if (probing && !force) return probing;
  probing = new Promise((res) => {
    const py = agentPython();
    if (!existsSync(SCRIPT)) {
      stack = { available: false, python: py, script: SCRIPT, reason: `integrations/companion/investigate.py not found at ${SCRIPT}` };
      return res(stack);
    }
    execFile(py, ['-E', SCRIPT, '--probe'], { timeout: 60_000, env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8' } }, (err, out, errOut) => {
      if (err) {
        const tail = String(errOut || out || err.message).trim().split('\n').filter(Boolean).slice(-1)[0] ?? err.message;
        stack = { available: false, python: py, script: SCRIPT, reason: `${tail} — install the stack into ${py}: pip install -r integrations/companion/requirements.txt (or set GRIDWRIGHT_AGENT_PYTHON)` };
        return res(stack);
      }
      try {
        const v = JSON.parse(String(out).trim().split('\n').pop() ?? '{}') as Record<string, string>;
        stack = { available: true, python: py, script: SCRIPT, versions: v };
      } catch {
        stack = { available: false, python: py, script: SCRIPT, reason: 'probe returned no versions' };
      }
      res(stack);
    });
  });
  return probing;
}
export const stackStatus = () => stack;

export interface RunRequest {
  code: string;
  purpose?: string;
  investigation?: string;
}

/** Run generated code against the live document (what the editors currently see) in the cell sandbox; nothing is written; the run is kept as evidence. */
export async function runCodeForDocument(fileId: string, by: Author, req: RunRequest) {
  const code = String(req.code ?? '');
  if (!code.trim()) throw new Error('code required');
  const { book } = openDocument(fileId);
  let snapshot;
  try {
    snapshot = snapshotOf(book);
  } finally {
    book.free();
  }
  const r = await runPython(code, snapshot, false, tenantOfDoc(fileId));
  const sandbox = String(r.runtime?.packages?.sandbox ?? 'none');
  let output: string | undefined;
  if (r.ok && r.output !== undefined && r.output !== null) {
    try {
      output = JSON.stringify(r.output);
    } catch {
      output = String(r.output);
    }
  }
  const run = recordRun(fileId, by, { purpose: String(req.purpose ?? '').slice(0, 300), codeHash: fnv(code), ok: r.ok, ms: r.ms, sandbox, error: r.error?.slice(0, 500), output: output?.slice(0, 300), investigation: req.investigation && /^[a-zA-Z0-9_-]{1,64}$/.test(req.investigation) ? req.investigation : undefined });
  return { ok: r.ok, busy: r.busy, output: r.output ?? null, error: r.error, std_out: r.std_out?.slice(0, 20_000), ms: r.ms, sandbox, runtime: r.runtime, run: run.id, codeHash: run.codeHash };
}

let notifyDone: ((doc: string) => void) | null = null;
export function setInvestigationNotifier(fn: typeof notifyDone) {
  notifyDone = fn;
}

const CELL_TIMEOUT_MS = Number(process.env.GRIDWRIGHT_AGENT_CELL_TIMEOUT_MS ?? 300_000);
let agentSocket: string | null = null;
/** The agent channel's socket, once the server listens on it (index.ts). */
export function setAgentSocket(path: string) {
  agentSocket = path;
}
export const agentChannel = () => agentSocket;

/** Where the stack lives for its interpreter: the executable and the site directories of the stack's packages. */
let stackPaths: { executable: string; sites: string[] } | null = null;
function probeStackPaths(py: string): Promise<{ executable: string; sites: string[] }> {
  if (stackPaths) return Promise.resolve(stackPaths);
  const code = [
    'import importlib.util, json, os, sys',
    'out = set()',
    'for name in ("langchain", "langchain_core", "langchain_openai", "deepagents", "langgraph", "openai", "httpx", "pandas"):',
    '    spec = importlib.util.find_spec(name)',
    '    if not spec: continue',
    '    locs = list(spec.submodule_search_locations or []) or ([os.path.dirname(spec.origin)] if spec.origin else [])',
    '    for loc in locs: out.add(os.path.dirname(os.path.abspath(loc)))',
    'print(json.dumps({"executable": sys.executable, "sites": sorted(out)}))',
  ].join('\n');
  return new Promise((res, rej) =>
    execFile(py, ['-c', code], { timeout: 60_000, env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8' } }, (err, out) => {
      if (err) return rej(new Error(`could not locate the stack for ${py}: ${err.message}`));
      try {
        stackPaths = JSON.parse(String(out).trim().split('\n').pop() ?? '{}') as { executable: string; sites: string[] };
        res(stackPaths);
      } catch (e) {
        rej(e as Error);
      }
    }),
  );
}
// the very directories the cell sandbox hides: site-packages under any of them must be re-exposed
const HIDDEN_ROOTS = () => hiddenDirs();
const under = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`));

/** The document's own working directory for agent cells (their LangGraph threads); deleted with the document. */
export const cellWorkDir = (doc: string) => join(DATA_DIR, 'companion', 'cells', doc);
export function deleteCellWork(doc: string) {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(doc)) rmSync(cellWorkDir(doc), { recursive: true, force: true });
}

/**
 * An agent cell: a person's own code with the companion's context, tools and model in its
 * namespace (`companion`), run in the cell sandbox with no network. Gridwright — and the model,
 * through its proxy — is reachable only over the agent channel, as that person, by a short-lived
 * agent token: whatever the code records is proposed, never ratified, and no key enters the cell.
 * Kept as evidence like any run.
 */
export async function runAgentCell(fileId: string, who: Identity, by: Author, code: string, snapshot: Snapshot): Promise<RunResult> {
  const st = stack;
  if (!st.available) throw new Error(`the investigation stack is not available: ${st.reason ?? 'not probed'}`);
  if (!agentSocket) throw new Error('the agent channel is not listening (see the server log)');
  const cfg = readAiConfig(ACCOUNTS ? tenantOfDoc(fileId) : undefined);
  if (!cfg.baseUrl) throw new Error('no model endpoint is configured (Settings → model)');
  const paths = await probeStackPaths(st.python);
  const hidden = HIDDEN_ROOTS();
  const sites = paths.sites.filter((d) => under(d, hidden));
  const workDir = cellWorkDir(fileId);
  mkdirSync(workDir, { recursive: true });
  const token = issueAgentToken(who, 'agent cell', CELL_TIMEOUT_MS + 60_000);
  try {
    const r = await runAsAgentCell(code, snapshot, {
      python: paths.executable,
      socket: agentSocket,
      workDir,
      expose: [resolve(dirname(SCRIPT)), ...sites],
      pythonPath: sites,
      env: { GRIDWRIGHT_DOC: fileId, GRIDWRIGHT_AGENT_TOKEN: token, GRIDWRIGHT_MODEL: cfg.model, GRIDWRIGHT_COMPANION_DIR: resolve(dirname(SCRIPT)) },
      tenant: tenantOfDoc(fileId),
    }, CELL_TIMEOUT_MS);
    let output: string | undefined;
    if (r.ok && r.output !== undefined && r.output !== null) {
      try {
        output = JSON.stringify(r.output);
      } catch {
        output = String(r.output);
      }
    }
    if (!r.busy) recordRun(fileId, by, { purpose: 'agent cell', codeHash: fnv(code), ok: r.ok, ms: r.ms, sandbox: String(r.runtime?.packages?.sandbox ?? 'none'), error: r.error?.slice(0, 500), output: output?.slice(0, 300) });
    return r;
  } finally {
    revokeAgentToken(token);
  }
}

/** Stop a running investigation: the record is marked, its job is told to stop (the process is killed), its late result is fenced. */
export function cancelInvestigation(doc: string, id: string, by: Author): Investigation {
  const inv = requestCancel(doc, id, by);
  for (const job of listJobs({ doc, type: 'investigation', status: ['queued', 'running'] })) {
    if (job.input.investigation === id) cancelJob(job.id, by);
  }
  return inv;
}

let serverConfig: { serverToken: string } = { serverToken: '' };

/**
 * Start a bounded investigation: the record is made at once and a job queued for the worker, which
 * runs the stack as a separate process. The process gets: the base URL (loopback), a short-lived
 * agent token for the requesting identity, the model endpoint the server is configured with, and
 * a durable thread store under the data directory. The result lands on the investigation record
 * when the process ends; the job carries the mechanics (attempt, cancellation, time limit, status).
 */
export function startInvestigationProcess(fileId: string, who: Identity, by: Author, input: { question: string; issue?: string; thread?: string }, base: string, serverToken: string): Investigation {
  const st = stack;
  if (!st.available) throw new Error(`the investigation stack is not available: ${st.reason ?? 'not probed'}`);
  const inv = startInvestigation(fileId, by, input);
  serverConfig = { serverToken };
  const job = enqueue({ type: 'investigation', doc: fileId, by, maxAttempts: 1, timeoutMs: TIMEOUT_MS, input: { investigation: inv.id, question: inv.question, thread: inv.thread, issue: inv.issue, base, who: { login: who.login, name: who.name, role: who.role }, assumptionsSeq: inv.assumptionsSeq } });
  setInvestigationJob(fileId, inv.id, job.id);
  kick();
  return { ...inv, job: job.id };
}

/** The job runner: one investigation process, acting for the person who asked, bounded by the job's limit. */
registerRunner('investigation', (ctl) =>
  new Promise<JobOutcome>((done) => {
    const { job } = ctl;
    const fileId = job.doc;
    const invId = String(job.input.investigation ?? '');
    const st = stack;
    if (!st.available) {
      finishInvestigation(fileId, invId, { status: 'failed', error: `the investigation stack is not available: ${st.reason ?? 'not probed'}` });
      notifyDone?.(fileId);
      return done({ status: 'failed', error: `the investigation stack is not available: ${st.reason ?? 'not probed'}` });
    }
    const whoIn = (job.input.who ?? {}) as { login?: string; name?: string; role?: string };
    // accounts mode: the person as a member of the document's client now (removed since = no access)
    const who: Identity = ACCOUNTS ? identityForLogin(whoIn.login ?? '', whoIn.name ?? '', tenantOfDoc(fileId)) : { login: whoIn.login ?? '', name: whoIn.name ?? '', role: (whoIn.role as Identity['role']) ?? 'editor' };
    const cfg = readAiConfig(ACCOUNTS ? tenantOfDoc(fileId) : undefined);
    const apiKey = aiKeyOf(cfg);
    const token = issueAgentToken(who, `investigation ${invId}`, job.limits.timeoutMs + 60_000);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: process.env.HOME ?? '/tmp',
      GRIDWRIGHT_BASE: String(job.input.base ?? ''),
      GRIDWRIGHT_AGENT_TOKEN: token,
      GRIDWRIGHT_TOKEN: serverConfig.serverToken,
      GRIDWRIGHT_THREADS_DB: join(DATA_DIR, 'companion', 'threads.sqlite'),
      OPENAI_BASE_URL: cfg.baseUrl,
      OPENAI_API_KEY: apiKey || 'none',
      GRIDWRIGHT_MODEL: cfg.model,
    };
    const args = ['-E', SCRIPT, fileId, '--investigation', invId, '--thread', String(job.input.thread ?? `doc:${fileId}`), '--question', String(job.input.question ?? ''), '--json'];
    if (job.input.issue) args.push('--issue', String(job.input.issue));
    const child = spawn(st.python, args, { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: resolve(dirname(SCRIPT)) });
    crashPoint('investigation:dispatched');
    ctl.onCancel(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }, 5000).unref();
      } catch {
        /* gone */
      }
    });
    const beat = setInterval(() => ctl.heartbeat(), 15_000);
    beat.unref();
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => {
      if (out.length < 2_000_000) out += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 200_000) err += b.toString('utf8');
    });
    child.on('error', (e) => {
      clearInterval(beat);
      revokeAgentToken(token);
      finishInvestigation(fileId, invId, { status: 'failed', error: e.message });
      notifyDone?.(fileId);
      done({ status: 'failed', error: e.message });
    });
    child.on('close', (code) => {
      clearInterval(beat);
      revokeAgentToken(token);
      let outcome: JobOutcome;
      try {
        const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
        const result = line ? (JSON.parse(line) as { answer?: string; model?: string; steps?: { tool: string; summary: string }[]; records?: string[]; proposals?: string[]; error?: string }) : null;
        if (code === 0 && result && !result.error) {
          const inv = finishInvestigation(fileId, invId, { status: 'done', answer: result.answer, model: result.model, steps: result.steps, records: result.records, proposals: result.proposals });
          outcome = { status: 'done', result: { ref: invId, summary: `${inv.status}: ${(result.answer ?? '').slice(0, 160)}` } };
        } else {
          const error = result?.error ?? (err.trim().split('\n').filter(Boolean).slice(-1)[0] || `the investigation process exited with ${code}`);
          finishInvestigation(fileId, invId, { status: 'failed', error, steps: result?.steps, records: result?.records, proposals: result?.proposals });
          outcome = { status: 'failed', error, result: { ref: invId } };
        }
      } catch (e) {
        finishInvestigation(fileId, invId, { status: 'failed', error: (e as Error).message });
        outcome = { status: 'failed', error: (e as Error).message, result: { ref: invId } };
      }
      notifyDone?.(fileId);
      done(outcome);
    });
  }),
);
