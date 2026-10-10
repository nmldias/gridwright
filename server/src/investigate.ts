// Scoped investigation for the companion: generated code runs against the live document inside
// the same sandbox as Python cells (bubblewrap, no network, no data directory), and a bounded
// investigation runs as a separate process — the LangChain + DeepAgents + LangGraph stack in
// integrations/companion — that calls back over the loopback interface with a short-lived token
// carrying exactly the requesting person's identity. Everything it does is recorded: every run
// with its code hash and sandbox, every record it proposes, every proposal it files. It changes
// nothing by itself.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishInvestigation, recordRun, startInvestigation, type Investigation } from './companion.js';
import { fnv } from './evidence.js';
import { openDocument, snapshotOf } from './headless.js';
import { issueAgentToken, revokeAgentToken, type Identity } from './identity.js';
import { runPython } from './pyrun.js';
import { DATA_DIR, decrypt, readAiConfig } from './storage.js';
import type { Author } from './history.js';

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
  const r = await runPython(code, snapshot, false);
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

/**
 * Start a bounded investigation as a separate process. It gets: the base URL (loopback), a
 * short-lived agent token for the requesting identity, the model endpoint the server is
 * configured with, and a durable thread store under the data directory. It returns at once; the
 * result lands on the investigation record when the process ends.
 */
export function startInvestigationProcess(fileId: string, who: Identity, by: Author, input: { question: string; issue?: string; thread?: string }, base: string, serverToken: string): Investigation {
  const inv = startInvestigation(fileId, by, input);
  const st = stack;
  if (!st.available) {
    finishInvestigation(fileId, inv.id, { status: 'failed', error: `the investigation stack is not available: ${st.reason ?? 'not probed'}` });
    throw new Error(`the investigation stack is not available: ${st.reason ?? 'not probed'}`);
  }
  const cfg = readAiConfig();
  const apiKey = cfg.apiKeyEnc ? decrypt(cfg.apiKeyEnc) : process.env.AI_API_KEY ?? '';
  const token = issueAgentToken(who, `investigation ${inv.id}`, TIMEOUT_MS + 60_000);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: process.env.HOME ?? '/tmp',
    GRIDWRIGHT_BASE: base,
    GRIDWRIGHT_AGENT_TOKEN: token,
    GRIDWRIGHT_TOKEN: serverToken,
    GRIDWRIGHT_THREADS_DB: join(DATA_DIR, 'companion', 'threads.sqlite'),
    OPENAI_BASE_URL: cfg.baseUrl,
    OPENAI_API_KEY: apiKey || 'none',
    GRIDWRIGHT_MODEL: cfg.model,
  };
  const args = ['-E', SCRIPT, fileId, '--investigation', inv.id, '--thread', inv.thread, '--question', inv.question, '--json'];
  if (inv.issue) args.push('--issue', inv.issue);
  const child = spawn(st.python, args, { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: resolve(dirname(SCRIPT)) });
  let out = '';
  let err = '';
  child.stdout.on('data', (b: Buffer) => {
    if (out.length < 2_000_000) out += b.toString('utf8');
  });
  child.stderr.on('data', (b: Buffer) => {
    if (err.length < 200_000) err += b.toString('utf8');
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
  child.on('close', (code) => {
    clearTimeout(timer);
    revokeAgentToken(token);
    try {
      const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      const result = line ? (JSON.parse(line) as { answer?: string; model?: string; steps?: { tool: string; summary: string }[]; records?: string[]; proposals?: string[]; error?: string }) : null;
      if (code === 0 && result && !result.error) finishInvestigation(fileId, inv.id, { status: 'done', answer: result.answer, model: result.model, steps: result.steps, records: result.records, proposals: result.proposals });
      else finishInvestigation(fileId, inv.id, { status: 'failed', error: result?.error ?? (err.trim().split('\n').filter(Boolean).slice(-1)[0] || `the investigation process exited with ${code}`), steps: result?.steps, records: result?.records, proposals: result?.proposals });
    } catch (e) {
      finishInvestigation(fileId, inv.id, { status: 'failed', error: (e as Error).message });
    }
    notifyDone?.(fileId);
  });
  return inv;
}
