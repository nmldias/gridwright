// Durable jobs and the worker that runs them. A job has an identity, the versions of its input,
// a status, attempts and a retry rule, a cancellation, a time limit and a reference to its result;
// it is claimed atomically from the store and heartbeats while it runs, so a restart finds what
// was running and marks it interrupted rather than leaving it running for ever. The worker is a
// loop inside the server process — one deployment, one unit — with the job types registered by
// the modules that own them (an investigation is a child process acting for a person; a refresh
// re-reads a source through its saved recipe with no model involved). Moving the loop to a process
// of its own changes nothing in this file but who calls startWorker().

import { hostname } from 'node:os';
import type { Author } from './history.js';
import { crashPoint, newId } from './storage.js';
import { theStore, type Job, type JobStatus, type JobType } from './store.js';

export interface JobControl {
  job: Job;
  /** true once a person asked for the job to stop; runners check it between steps */
  cancelled: () => boolean;
  /** called when cancellation is requested while running (kill a child process, abort a request) */
  onCancel: (fn: () => void) => void;
  heartbeat: (note?: string) => void;
}
export interface JobOutcome {
  status: 'done' | 'failed';
  result?: Job['result'];
  error?: string;
  /** a failure that may succeed on a retry (a timeout, a connection refused) — never a bad input */
  retryable?: boolean;
}
type Runner = (ctl: JobControl) => Promise<JobOutcome>;

const runners = new Map<JobType, Runner>();
const live = new Map<string, { cancels: (() => void)[] }>();
const workerId = `${hostname()}:${process.pid}`;
let listener: ((job: Job) => void) | null = null;
export function onJobChange(fn: typeof listener) {
  listener = fn;
}
const changed = (job: Job | null) => {
  if (job) listener?.(job);
};

export function registerRunner(type: JobType, run: Runner) {
  runners.set(type, run);
}

export interface EnqueueInput {
  type: JobType;
  doc: string;
  input: Record<string, unknown>;
  by: Author;
  maxAttempts?: number;
  timeoutMs?: number;
}

/** A job queued: nothing runs until the worker claims it. */
export function enqueue(input: EnqueueInput): Job {
  const job: Job = {
    id: newId(),
    type: input.type,
    doc: input.doc,
    input: input.input,
    status: 'queued',
    by: { id: input.by.id, name: input.by.name, login: input.by.login },
    createdAt: new Date().toISOString(),
    attempts: 0,
    maxAttempts: Math.max(1, Math.min(5, input.maxAttempts ?? 1)),
    limits: { timeoutMs: Math.max(1000, Math.min(3_600_000, input.timeoutMs ?? 600_000)) },
  };
  theStore().insertJob(job);
  changed(job);
  return job;
}

export const getJob = (id: string) => theStore().getJob(id);
export const listJobs = (filter?: { doc?: string; status?: JobStatus[]; type?: JobType; limit?: number }) => theStore().listJobs(filter);

/** A person stops a job: queued ones end at once; running ones are told, then their runner is interrupted. */
export function cancelJob(id: string, by: Author): Job | null {
  const job = theStore().getJob(id);
  if (!job) return null;
  if (job.status === 'queued') {
    const j = theStore().updateJob(id, { status: 'cancelled', finishedAt: new Date().toISOString(), error: `stopped by ${by.name || by.login || 'someone'} before it ran` });
    changed(j);
    return j;
  }
  if (job.status !== 'running') return job;
  const j = theStore().updateJob(id, { cancelRequested: new Date().toISOString() });
  for (const fn of live.get(id)?.cancels ?? []) {
    try {
      fn();
    } catch {
      /* already gone */
    }
  }
  changed(j);
  return j;
}

/** A job overtaken by a change of direction: it may finish, its result is marked superseded. */
export function supersedeJobsOf(doc: string, why: string): Job[] {
  const out: Job[] = [];
  for (const job of theStore().listJobs({ doc, status: ['queued', 'running'] })) {
    if (job.supersededAt) continue;
    const j = theStore().updateJob(job.id, { supersededAt: new Date().toISOString(), error: job.status === 'queued' ? `superseded before it ran: ${why}` : undefined });
    if (job.status === 'queued') {
      const c = theStore().updateJob(job.id, { status: 'superseded', finishedAt: new Date().toISOString() });
      if (c) out.push(c);
    } else if (j) out.push(j);
    changed(j);
  }
  return out;
}

/** After a restart: whatever the previous process left running is interrupted, said on the job. */
export function reconcileAfterRestart(reason: string): Job[] {
  const jobs = theStore().interruptRunning(reason);
  for (const j of jobs) changed(j);
  return jobs;
}

let timer: NodeJS.Timeout | null = null;
let active = 0;
let stopped = false;
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.GRIDWRIGHT_WORKER_CONCURRENCY ?? 2)));

async function runOne(job: Job) {
  const run = runners.get(job.type);
  const store = theStore();
  const ctl: JobControl = {
    job,
    cancelled: () => !!store.getJob(job.id)?.cancelRequested,
    onCancel: (fn) => {
      const l = live.get(job.id);
      if (l) l.cancels.push(fn);
    },
    heartbeat: () => {
      store.updateJob(job.id, { heartbeatAt: new Date().toISOString() });
    },
  };
  live.set(job.id, { cancels: [] });
  const timeout = setTimeout(() => {
    for (const fn of live.get(job.id)?.cancels ?? []) {
      try {
        fn();
      } catch {
        /* gone */
      }
    }
  }, job.limits.timeoutMs);
  timeout.unref();
  let outcome: JobOutcome;
  try {
    if (!run) outcome = { status: 'failed', error: `no runner for job type ${job.type}` };
    else outcome = await run(ctl);
  } catch (e) {
    outcome = { status: 'failed', error: (e as Error).message };
  } finally {
    clearTimeout(timeout);
    live.delete(job.id);
  }
  const now = new Date().toISOString();
  const current = store.getJob(job.id);
  const fenced: JobStatus | null = current?.cancelRequested ? 'cancelled' : current?.supersededAt ? 'superseded' : null;
  if (fenced) {
    changed(store.updateJob(job.id, { status: fenced, finishedAt: now, result: outcome.result, error: outcome.error ?? (fenced === 'cancelled' ? 'stopped by a person' : 'superseded: the direction changed while it ran') }));
    return;
  }
  if (outcome.status === 'failed' && outcome.retryable && job.attempts < job.maxAttempts) {
    changed(store.updateJob(job.id, { status: 'queued', error: `${outcome.error ?? 'failed'} — retrying (${job.attempts} of ${job.maxAttempts})`, worker: undefined }));
    return;
  }
  changed(store.updateJob(job.id, { status: outcome.status, finishedAt: now, result: outcome.result, error: outcome.error }));
}

function tick() {
  if (stopped) return;
  while (active < CONCURRENCY) {
    const job = theStore().claimNext(Array.from(runners.keys()), workerId);
    if (!job) break;
    crashPoint('job:claimed');
    active++;
    changed(job);
    void runOne(job).finally(() => {
      active--;
      setImmediate(tick);
    });
  }
}

/** The worker loop: claims queued jobs of the registered types, up to the concurrency, every pollMs. */
export function startWorker(pollMs = 1000) {
  stopped = false;
  if (timer) return;
  timer = setInterval(tick, pollMs);
  timer.unref();
  setImmediate(tick);
}
export function stopWorker() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}
/** Something was queued: look now rather than at the next poll. */
export const kick = () => setImmediate(tick);
export const workerStatus = () => ({ worker: workerId, concurrency: CONCURRENCY, active, types: Array.from(runners.keys()) });
