// REST client for the Gridwright server.

export interface FileInfo {
  id: string;
  name: string;
  updatedAt: string;
  size: number;
  folder?: string;
  owner?: string;
  ownerName?: string;
  public?: 'edit' | 'view' | 'none';
  shared?: number;
  permission?: 'none' | 'view' | 'sign' | 'edit' | 'own';
}

export interface FileAccess {
  owner: string;
  ownerName?: string;
  public: 'edit' | 'view' | 'none';
  shares: Record<string, 'view' | 'edit' | 'sign'>;
  folder: string;
  permission: 'none' | 'view' | 'sign' | 'edit' | 'own';
  identity: boolean;
}

export interface ConnectionInfo {
  id: string;
  name: string;
  kind: 'postgres' | 'mysql' | 'mssql';
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  hasPassword: boolean;
  /** SELECT only, enforced by the server (and by a read-only transaction where the database has one) */
  readOnly?: boolean;
  /** logins allowed to use this connection (empty = every editor; admins always) */
  allowed?: string[];
  maxRows?: number;
  timeoutMs?: number;
}

export interface SqlResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
}

export interface AiSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  configured: boolean;
}

export interface HistoryEntry {
  seq: number;
  ts: string;
  author: { id: string; name: string; login?: string };
  origin: string;
  op?: Record<string, unknown>;
  checkpoint?: boolean;
  note?: string;
  run?: { table: number; row: number; col: number; kind: string; codeHash: string; inputsHash: string; outputHash: string; ok: boolean; error?: string; ms: number; runtime: { name: string; version: string; packages: Record<string, string> }; at: string };
}

export type SqlParam = string | number | boolean | null;

export interface Proposal {
  id: string;
  document: string;
  by: { id: string; name: string; login?: string };
  agent: string;
  at: string;
  title: string;
  rationale: string;
  actions: Record<string, unknown>[];
  ops: Record<string, unknown>[];
  /** before → after of each edit, then (`effect`) every cell whose value moves as a consequence */
  preview: { where: string; before: string; after: string; effect?: true }[];
  errors: string[];
  seq: number;
  status: 'pending' | 'applied' | 'rejected';
  decidedBy?: { id: string; name: string; login?: string };
  decidedAt?: string;
  decisionNote?: string;
  appliedSeq?: number;
  appliedSeqs?: number[];
  command?: string;
}

// --- the companion ---------------------------------------------------------------------------
export type RecordKind = 'fact' | 'source' | 'objective' | 'constraint' | 'hypothesis' | 'contradiction' | 'decision' | 'exclusion' | 'question' | 'expectation' | 'scenario';
export const RECORD_KINDS: RecordKind[] = ['objective', 'constraint', 'exclusion', 'decision', 'question', 'expectation', 'scenario', 'contradiction', 'hypothesis', 'fact', 'source'];
export type RecordStatus = 'stated' | 'proposed' | 'confirmed' | 'observed' | 'resolved' | 'retired' | 'superseded';
export interface Condition {
  text: string;
  watch?: string;
  holds?: boolean;
  since?: string;
}
export interface ContextRecord {
  id: string;
  kind: RecordKind;
  text: string;
  source?: string;
  period?: string;
  arrivedAt: string;
  by: { id: string; name: string; login?: string };
  origin: 'user' | 'agent' | 'system';
  status: RecordStatus;
  supersededBy?: string;
  links?: { table?: number; ref?: string }[];
  bearing?: string;
  due?: string;
  match?: string;
  expected?: { state: 'open' | 'met' | 'missing' | 'unchecked' | 'didnt'; text: string; at: string };
  reviewBy?: string;
  why?: string;
  conditions?: Condition[];
  revisit?: { at: string; condition: string; summary: string };
  private?: boolean;
  derivative?: boolean;
  resolution?: string;
  key?: string;
  intake?: string;
  coverage?: { rows: number; identifiers?: number; idColumn?: string; entity?: string };
  historical?: boolean;
  inferred?: boolean;
}
export interface RecordInput {
  kind: RecordKind;
  text: string;
  source?: string;
  period?: string;
  links?: { table?: number; ref?: string }[];
  bearing?: string;
  due?: string;
  match?: string;
  reviewBy?: string;
  why?: string;
  conditions?: (Condition | string)[];
  private?: boolean;
  derivative?: boolean;
  inferred?: boolean;
  steer?: boolean;
}
export interface RecordPatch {
  text?: string;
  status?: 'confirmed' | 'retired' | 'stated' | 'resolved';
  period?: string;
  source?: string;
  kind?: RecordKind;
  bearing?: string;
  due?: string;
  match?: string;
  reviewBy?: string;
  why?: string;
  conditions?: (Condition | string)[];
  private?: boolean;
  derivative?: boolean;
  resolution?: string;
  expected?: 'met' | 'didnt' | 'open';
  inferred?: boolean;
}
export interface WatchDef {
  purpose: string;
  scope: string;
  formula: string;
  table?: string;
  kind: 'threshold' | 'check' | 'change' | 'worsening';
  op?: '>' | '>=' | '<' | '<=' | '=' | '!=';
  value?: number;
  bad?: 'up' | 'down';
  sustain: number;
  response: 'note' | 'brief' | 'case';
  sources?: string[];
  freshnessHours?: number;
  complement?: string;
}
export interface Observation {
  at: string;
  seq: number;
  period?: string;
  value: number | boolean | string | null;
  complement?: number | null;
  error?: string;
  breach: boolean;
  fresh: boolean;
  def: string;
  population?: number;
  invalid?: 'blank' | 'text' | 'error' | 'unavailable';
  comparable?: false;
  note?: string;
  revisions?: number;
  previous?: { value: number | boolean | string | null; at: string };
}
export interface Issue {
  id: string;
  watch: string;
  openedAt: string;
  updatedAt: string;
  status: 'open' | 'resolved';
  resolvedAt?: string;
  revision: number;
  summary: string;
  evidence: string[];
  uncertainty: string[];
  next: string;
  interpretation?: { text: string; model: string; at: string; revision: number };
}
export type Health = 'ok' | 'baseline' | 'attention' | 'stale' | 'error' | 'invalid' | 'unchecked' | 'proposed';
export interface Watch {
  id: string;
  def: WatchDef;
  defHash: string;
  authority: 'proposed' | 'approved';
  by: { id: string; name: string; login?: string };
  origin: 'user' | 'agent';
  createdAt: string;
  updatedAt: string;
  lastChecked?: string;
  health: Health;
  observations: Observation[];
  issue?: Issue;
  history: Issue[];
  recurrenceRaised?: number;
}
export interface CompanionEvent {
  at: string;
  kind: string;
  text: string;
  by?: string;
  level: 'quiet' | 'watch' | 'attention';
}
export interface SourceStatus {
  name: string;
  kind: 'table';
  lastChange?: string;
  asOf?: string;
  supply: 'import' | 'live' | 'manual' | 'unknown';
  rows: number;
}
export type Stance = 'quiet' | 'observation' | 'question' | 'decision';
export interface Brief {
  changed: string[];
  matters: string[];
  next: string[];
  health: { checked?: string; ok: number; baseline: number; attention: number; stale: number; error: number; invalid: number; unchecked: number; proposed: number };
  sources: SourceStatus[];
  stance: Stance;
  lead: string;
  statement: string;
}
export interface Uncertainty {
  kind: 'question' | 'contradiction' | 'expectation' | 'review' | 'provisional' | 'stale' | 'hypothesis' | 'proposed';
  text: string;
  bearing?: string;
  record?: string;
  watch?: string;
  rank: number;
}
export interface Investigation {
  id: string;
  question: string;
  issue?: string;
  thread: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'superseded';
  cancelRequested?: string;
  superseded?: string;
  answer?: string;
  model?: string;
  error?: string;
  steps: { tool: string; summary: string }[];
  runs: string[];
  records: string[];
  proposals: string[];
  by: { id: string; name: string; login?: string };
  assumptionsSeq: number;
  stale?: boolean;
}
export interface CodeRun {
  id: string;
  at: string;
  by: string;
  purpose: string;
  codeHash: string;
  ok: boolean;
  ms: number;
  sandbox: string;
  error?: string;
  output?: string;
  assumptionsSeq: number;
  investigation?: string;
}
export interface Dismissed {
  id: string;
  purpose: string;
  reason: 'not now' | 'not relevant' | 'incorrect';
  at: string;
  by: string;
  period?: string;
}
export interface Understanding {
  objective?: ContextRecord;
  constraints: ContextRecord[];
  exclusions: ContextRecord[];
  coverage: { name: string; period?: string; rows: number; supply: SourceStatus['supply']; lastChange?: string; derivative?: boolean }[];
  decisions: { record: ContextRecord; conditions: (Condition & { purpose?: string })[]; revisit?: ContextRecord['revisit'] }[];
  expectations: ContextRecord[];
  uncertain: Uncertainty[];
  stance: Stance;
  lead: string;
  next: string;
  statement: string;
  attention: number;
  assumptionsSeq: number;
  investigations: Investigation[];
  monitoring: { state: string; text: string; cannotAssess: number };
  scope: ScopeState[];
}
export interface ScopeState {
  record: string;
  text: string;
  column?: string;
  table?: string;
  state: 'applied' | 'partly' | 'recorded' | 'no-column';
  watches: { id: string; purpose: string; applicable: boolean; applied: boolean }[];
}
export interface GraphNode {
  id: string;
  type: string;
  label: string;
  table?: number;
  status?: string;
  health?: Health;
  supply?: SourceStatus['supply'];
  lastChange?: string;
  rows?: number;
  period?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  via: string;
}
export interface Suggestion {
  id: string;
  purpose: string;
  why: string;
  def: WatchDef;
}
export interface IntakeColumn {
  index: number;
  header: string;
  type: 'identifier' | 'number' | 'date' | 'boolean' | 'text' | 'empty';
  filled: number;
  blanks: number;
  unique: number;
  unit?: string;
  sample: string[];
  normalised: number;
  textInNumber: number;
  leadingZeros: number;
  min?: number;
  max?: number;
  minDate?: string;
  maxDate?: string;
  constant?: string;
}
export interface IntakeRelation {
  kind: 'first' | 'next' | 'same-period' | 'older' | 'different-entity' | 'duplicate' | 'unrelated';
  table?: { id: number; name: string };
  series?: string;
  currentPeriod?: string;
  sharedColumns: number;
  identifiers?: { column: string; overlap: number; ofFile: number; ofTable: number; added: number; removed: number };
  entity?: { column: string; file: string; table?: string };
  recommended: 'update' | 'new' | 'history' | 'skip';
  reason: string;
}
export interface IntakeSet {
  name: string;
  rows: string[][];
  dataRows: number;
  cols: number;
  columns: IntakeColumn[];
  headerDetected: boolean;
  totalsRow?: { index: number; text: string };
  quarantined: { row: number; reason: string; values: string[] }[];
  emptyRowsDropped: number;
  raggedRows: number;
  formulasReduced: number;
  instructionLikeCells: number;
  notes: string[];
  relation: IntakeRelation;
}
export interface IntakeProfile {
  key: string;
  doc: string;
  name: string;
  format: string;
  size: number;
  arrivedAt: string;
  by: string;
  origin: 'user' | 'inbox' | 'sql' | 'agent';
  family: string;
  period?: string;
  periodFrom: 'name' | 'column' | 'none';
  sets: IntakeSet[];
  sanitised: string[];
  warnings: string[];
  status: 'profiled' | 'applied' | 'declined';
  applied?: { at: string; by: string; decision: string; tables: { set: string; table: number; name: string; placed: 'new' | 'update' | 'history' }[]; records: string[]; seqs: number[] };
  query?: { connection: string; sql: string; rows: number; truncated: boolean };
  readings?: Reading[];
}
export interface Reading {
  table: number;
  name: string;
  period?: string;
  figures: { label: string; formula: string; value: number | string | boolean | null; note?: string }[];
  text: string;
}
export interface InboxFile {
  name: string;
  size: number;
  modified: string;
  family: string;
  period?: string;
}
export interface Companion {
  records: ContextRecord[];
  watches: Watch[];
  events: CompanionEvent[];
  brief: Brief;
  seenAt?: string;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  understanding: Understanding;
  dismissed: Dismissed[];
  runs: CodeRun[];
  investigations: Investigation[];
  assumptionsSeq: number;
}

export type ToolEvent =
  | { kind: 'call'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'result'; id: string; name: string; ok: boolean; summary: string; result?: unknown }
  | { kind: 'notice'; text: string };

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/** What /api/health says about server-side Python (null = off). */
export interface ServerPython {
  version: string;
  sandbox: 'bwrap' | 'unshare' | 'none' | null;
  gpu: string | null;
  timeoutMs: number;
  memoryMb: number;
  /** what the signed-in person may do: run on the server, ask for the GPU */
  can?: { run: boolean; gpu: boolean };
}
export interface ServerPythonResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  std_out: string;
  deps: { table: number; r0: number; c0: number; r1: number; c1: number }[];
  runtime: { name: string; version: string; packages: Record<string, string> };
  ms: number;
  /** the run record the server computed and logged itself (server-side runs of a saved document) */
  record?: Record<string, unknown>;
}

export class ProposalConflictError extends Error {
  constructor(
    message: string,
    public proposal?: Proposal,
  ) {
    super(message);
  }
}

export const api = {
  async health(): Promise<{ ok: boolean; version: string; multiplayer: boolean; pyodide?: boolean; identity?: boolean; python?: ServerPython | null; investigation?: boolean }> {
    return j(await fetch('/api/health'));
  },
  python: {
    async run(code: string, snapshot: unknown, gpu: boolean, cell?: { file: string; table: number; row: number; col: number; kind: string; startedAt: string; client: string }): Promise<ServerPythonResult> {
      return j(await fetch('/api/python/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, snapshot, gpu, cell }) }));
    },
    async status(): Promise<ServerPython & { available: boolean; reason?: string }> {
      return j(await fetch('/api/python'));
    },
    /** administrators: detect interpreter, sandbox and cuDF again */
    async probe(): Promise<{ available: boolean; version: string; sandbox: 'bwrap' | 'unshare' | 'none' | null; gpu: string | null; reason?: string; fallbacks?: string; limits: { timeoutMs: number; memoryMb: number } }> {
      return j(await fetch('/api/python/probe', { method: 'POST' }));
    },
  },
  async me(): Promise<{ login: string; name: string; role: 'admin' | 'editor' | 'viewer'; identity: boolean }> {
    return j(await fetch('/api/me'));
  },
  async investigationStack(): Promise<{ available: boolean; python: string; reason?: string; versions?: Record<string, string> }> {
    return j(await fetch('/api/investigation'));
  },
  async inbox(): Promise<{ configured: boolean; mode: string; files: InboxFile[] }> {
    return j(await fetch('/api/inbox'));
  },
  files: {
    async list(): Promise<FileInfo[]> {
      return j(await fetch('/api/files'));
    },
    async get(id: string): Promise<{ id: string; name: string; json: string; seq: number; permission?: FileInfo['permission']; folder?: string }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}`));
    },
    async create(name: string, json: string, client?: string, folder?: string): Promise<FileInfo & { seq: number }> {
      return j(await fetch('/api/files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, json, client, folder }) }));
    },
    async access(id: string): Promise<FileAccess> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/access`));
    },
    async setAccess(id: string, patch: Partial<Pick<FileAccess, 'public' | 'shares' | 'folder' | 'owner' | 'ownerName'>>): Promise<FileAccess> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/access`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }));
    },
    historyCsvUrl(id: string): string {
      return `/api/files/${encodeURIComponent(id)}/history.csv`;
    },
    async proposals(id: string, status?: Proposal['status']): Promise<Proposal[]> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/proposals${status ? `?status=${status}` : ''}`));
    },
    async propose(id: string, body: { title: string; rationale?: string; actions: Record<string, unknown>[]; agent?: string; client?: string }): Promise<Proposal> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    /** The server commits (or refuses) the decision; a 409 carries the fresh preview to review again. */
    async decide(id: string, pid: string, decision: 'applied' | 'rejected', note?: string, seq?: number, client?: string, command?: string): Promise<Proposal> {
      const res = await fetch(`/api/files/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, note, seq, client, command }) });
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string; proposal?: Proposal };
        throw new ProposalConflictError(body.error ?? 'the document changed since this proposal was reviewed', body.proposal);
      }
      return j(res);
    },
    async refreshProposal(id: string, pid: string): Promise<Proposal> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}/refresh`, { method: 'POST' }));
    },
    /** A checkpoint built by the server from the log — how a sign-off share persists. */
    // the companion: context records, watches, issues, the brief and the graph
    async companion(id: string): Promise<Companion> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion`));
    },
    async suggestions(id: string, all = false): Promise<Suggestion[]> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/suggest${all ? '?all=1' : ''}`));
    },
    async dismissSuggestion(id: string, body: { id: string; purpose: string; reason: Dismissed['reason']; client?: string }): Promise<Dismissed> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/suggest/dismiss`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async restoreSuggestion(id: string, sid: string): Promise<{ ok: boolean }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/suggest/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sid }) }));
    },
    // intake: profile first (nothing placed), then place as decided; the original is kept under its content hash
    async intake(id: string, body: { name: string; base64?: string; text?: string } | { inbox: string } | { connection: string; sql: string }): Promise<IntakeProfile> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async intakes(id: string): Promise<IntakeProfile[]> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/intake`));
    },
    async applyIntake(id: string, key: string, body: { decisions: { set?: string; action: 'update' | 'new' | 'history' | 'skip'; table?: number; name?: string }[]; period?: string }): Promise<IntakeProfile> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/intake/${encodeURIComponent(key)}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    originalUrl(id: string, key: string): string {
      return `/api/files/${encodeURIComponent(id)}/intake/${encodeURIComponent(key)}/original`;
    },
    async reading(id: string, table: number): Promise<Reading> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/reading/${table}`));
    },
    async understanding(id: string): Promise<Understanding> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/understanding`));
    },
    /** a bounded investigation by the LangChain + DeepAgents + LangGraph stack; returns at once, the result lands on the record */
    async investigate(id: string, body: { question?: string; issue?: string; client?: string }): Promise<Investigation> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/investigate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async cancelInvestigation(id: string, iid: string, client?: string): Promise<Investigation> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/investigations/${encodeURIComponent(iid)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client }) }));
    },
    async investigation(id: string, iid: string): Promise<Investigation> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/investigations/${encodeURIComponent(iid)}`));
    },
    async companionSeen(id: string): Promise<void> {
      await fetch(`/api/files/${encodeURIComponent(id)}/companion/seen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    },
    async companionCheck(id: string): Promise<Companion & { attention: number; changed: boolean }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    },
    async addRecord(id: string, body: RecordInput & { client?: string }): Promise<ContextRecord> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async updateRecord(id: string, rid: string, body: RecordPatch & { client?: string }): Promise<ContextRecord> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/records/${encodeURIComponent(rid)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async applyExclusion(id: string, rid: string): Promise<{ applied: string[]; skipped: string[]; column?: string }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/records/${encodeURIComponent(rid)}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    },
    async removeRecord(id: string, rid: string): Promise<void> {
      await j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/records/${encodeURIComponent(rid)}`, { method: 'DELETE' }));
    },
    async addWatch(id: string, body: Partial<WatchDef> & { client?: string }): Promise<Watch> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/watches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async updateWatch(id: string, wid: string, body: { approve?: boolean; def?: Partial<WatchDef>; reason?: string; client?: string }): Promise<Watch> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/watches/${encodeURIComponent(wid)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    },
    async removeWatch(id: string, wid: string): Promise<void> {
      await j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/watches/${encodeURIComponent(wid)}`, { method: 'DELETE' }));
    },
    async interpret(id: string, issueId: string, again = false): Promise<Issue> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/companion/interpret/${encodeURIComponent(issueId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ again }) }));
    },
    async checkpoint(id: string, client?: string): Promise<{ id: string; seq: number }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/checkpoint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client }) }));
    },
    async save(id: string, name: string, json: string, client?: string, seq?: number): Promise<FileInfo & { seq: number }> {
      return j(
        await fetch(`/api/files/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, json, client, seq }),
        }),
      );
    },
    async remove(id: string): Promise<void> {
      await j(await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    },
    async history(id: string, limit = 200, before?: number): Promise<{ seq: number; entries: HistoryEntry[] }> {
      const q = new URLSearchParams({ limit: String(limit) });
      if (before) q.set('before', String(before));
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/history?${q}`));
    },
    async cellHistory(id: string, table: number, row: number, col: number): Promise<{ entries: HistoryEntry[] }> {
      return j(await fetch(`/api/files/${encodeURIComponent(id)}/history/cell?table=${table}&row=${row}&col=${col}`));
    },
    async replay(id: string, seq: number): Promise<{ checkpointSeq: number; json: string | null; ops: HistoryEntry[] } | null> {
      const res = await fetch(`/api/files/${encodeURIComponent(id)}/history/replay?seq=${seq}`);
      if (res.status === 404) return null;
      return j(res);
    },
  },
  connections: {
    async list(): Promise<ConnectionInfo[]> {
      return j(await fetch('/api/connections'));
    },
    async save(c: Partial<ConnectionInfo> & { password?: string }): Promise<ConnectionInfo> {
      const method = c.id ? 'PUT' : 'POST';
      const url = c.id ? `/api/connections/${encodeURIComponent(c.id)}` : '/api/connections';
      return j(await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) }));
    },
    async remove(id: string): Promise<void> {
      await j(await fetch(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    },
    async test(id: string): Promise<{ ok: boolean; message: string }> {
      return j(await fetch(`/api/connections/${encodeURIComponent(id)}/test`, { method: 'POST' }));
    },
    async query(id: string, sql: string, limit = 5000, params: SqlParam[] = []): Promise<SqlResult> {
      return j(
        await fetch(`/api/connections/${encodeURIComponent(id)}/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql, limit, params }),
        }),
      );
    },
  },
  ai: {
    async settings(): Promise<AiSettings> {
      return j(await fetch('/api/ai/settings'));
    },
    async saveSettings(s: { baseUrl?: string; model?: string; apiKey?: string }): Promise<AiSettings> {
      return j(await fetch('/api/ai/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }));
    },
    async models(): Promise<{ models: string[]; error?: string }> {
      return j(await fetch('/api/ai/models'));
    },
    /** Streams assistant text chunks; resolves with the full text. */
    async chat(
      messages: { role: string; content: string }[],
      onChunk: (text: string) => void,
      signal?: AbortSignal,
      opts: { tools?: boolean; file?: string | null; onTool?: (ev: ToolEvent) => void } = {},
    ): Promise<string> {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, tools: !!opts.tools, file: opts.file ?? undefined }),
        signal,
      });
      if (!res.ok || !res.body) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let full = '';
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const obj = JSON.parse(data);
            if (obj.error) throw new Error(obj.error);
            if (obj.tool) opts.onTool?.({ kind: 'call', id: obj.tool.id, name: obj.tool.name, args: obj.tool.args });
            if (obj.tool_result) opts.onTool?.({ kind: 'result', id: obj.tool_result.id, name: obj.tool_result.name, ok: obj.tool_result.ok, summary: obj.tool_result.summary, result: obj.tool_result.result });
            if (obj.notice) opts.onTool?.({ kind: 'notice', text: obj.notice });
            const delta: string = obj.text ?? '';
            if (delta) {
              full += delta;
              onChunk(delta);
            }
          } catch (e) {
            if (e instanceof Error && e.message && !e.message.startsWith('Unexpected')) throw e;
          }
        }
      }
      return full;
    },
  },
};
