// The companion as the panel sees it: one snapshot per document, reloaded when the server says it
// re-checked (socket message), when the document changes hands, and after anything the person does
// here. A reflection — the last thing recorded, with a way to correct it — is kept per document too.

import { create } from 'zustand';
import { api, type Companion, type ContextRecord, type Dismissed, type Investigation, type RecordInput, type RecordKind, type RecordPatch, type Suggestion, type Watch, type WatchDef } from '../api/client';
import { getClientId } from '../api/ws';
import { getState, setStatus, useStore } from '../state/store';
import { familyOf } from './snapshots';

export interface Reflection {
  at: number;
  lines: { text: string; record?: ContextRecord; watch?: Watch }[];
}

interface CompanionState {
  byDoc: Record<string, Companion>;
  reflection: Record<string, Reflection | undefined>;
  loading: Record<string, boolean>;
}

export const useCompanion = create<CompanionState>(() => ({ byDoc: {}, reflection: {}, loading: {} }));

let loadSeq = 0;
export async function loadCompanion(fileId: string | null = getState().fileId): Promise<Companion | null> {
  if (!fileId) return null;
  const n = ++loadSeq;
  useCompanion.setState((s) => ({ loading: { ...s.loading, [fileId]: true } }));
  try {
    const c = await api.files.companion(fileId);
    if (n === loadSeq) useCompanion.setState((s) => ({ byDoc: { ...s.byDoc, [fileId]: c }, loading: { ...s.loading, [fileId]: false } }));
    useStore.setState({ attention: c.brief.health.attention });
    return c;
  } catch {
    useCompanion.setState((s) => ({ loading: { ...s.loading, [fileId]: false } }));
    return null;
  }
}

function reflect(fileId: string, line: Reflection['lines'][number]) {
  useCompanion.setState((s) => {
    const prev = s.reflection[fileId];
    const lines = prev && Date.now() - prev.at < 60_000 ? [...prev.lines, line].slice(-4) : [line];
    return { reflection: { ...s.reflection, [fileId]: { at: Date.now(), lines } } };
  });
}
export function clearReflection(fileId: string) {
  useCompanion.setState((s) => ({ reflection: { ...s.reflection, [fileId]: undefined } }));
}

const KIND_WORD: Record<RecordKind, string> = { fact: 'fact', source: 'source', objective: 'objective', constraint: 'constraint', exclusion: 'exclusion', hypothesis: 'hypothesis', contradiction: 'contradiction', decision: 'decision', question: 'question', expectation: 'expectation' };

/** Record something the person said or added; the reflection shows it back for correction. */
export async function remember(kind: RecordKind, text: string, extra: Omit<RecordInput, 'kind' | 'text'> = {}): Promise<ContextRecord | null> {
  const fileId = getState().fileId;
  if (!fileId) {
    setStatus('Save the document first: the companion keeps context per saved document.', 6000);
    return null;
  }
  try {
    const r = await api.files.addRecord(fileId, { kind, text, ...extra, client: getClientId() });
    const tail = r.kind === 'expectation' ? ` (by ${r.due ?? 'no date'}${r.source ? ` in ${r.source}` : ''})` : r.kind === 'decision' && r.conditions?.length ? ` — reconsider if: ${r.conditions.map((c) => c.text).join('; ')}` : r.bearing ? ` — bears on: ${r.bearing}` : r.period ? ` (period ${r.period})` : '';
    reflect(fileId, { text: `Recorded ${r.private ? 'private ' : ''}${KIND_WORD[kind]}: ${r.text}${tail}`, record: r });
    void loadCompanion(fileId);
    return r;
  } catch (e) {
    setStatus(`Could not record it: ${(e as Error).message}`, 6000);
    return null;
  }
}

/** Chat prefixes that are statements to keep, not questions: no model call needed. */
const PREFIXES: [RegExp, RecordKind][] = [
  [/^(objective|goal)\s*:\s*/i, 'objective'],
  [/^(constraint|within|keep)\s*:\s*/i, 'constraint'],
  [/^(exclude|exclusion|leave out)\s*:\s*/i, 'exclusion'],
  [/^(decision|decided)\s*:\s*/i, 'decision'],
  [/^(remember|fact|note)\s*:\s*/i, 'fact'],
  [/^(hypothesis|maybe|suspect)\s*:\s*/i, 'hypothesis'],
  [/^(contradiction|conflict)\s*:\s*/i, 'contradiction'],
  [/^(question|open|unknown)\s*:\s*/i, 'question'],
  [/^(expect|expected|expectation|due)\s*:\s*/i, 'expectation'],
];
export interface Statement {
  kind: RecordKind;
  text: string;
  extra: Omit<RecordInput, 'kind' | 'text'>;
}
/**
 * "Objective: release cash (review by 2026-12-01)" · "Decision: hold the Creta — because an order is expected; reconsider if the order lapses"
 * · "Question: is the freight final? — bears on which vehicles to reprice" · "Expect: final freight invoice for SH-001 by 2026-10-20 in invoices"
 * · "Private: hypothesis: …" keeps it out of what outside agents read.
 */
export function statementOf(input: string): Statement | null {
  let text = input.trim();
  const extra: Statement['extra'] = {};
  const priv = /^private\s*:\s*/i.exec(text);
  if (priv) {
    text = text.slice(priv[0].length).trim();
    extra.private = true;
  }
  let kind: RecordKind | null = null;
  for (const [re, k] of PREFIXES) {
    const m = re.exec(text);
    if (m) {
      kind = k;
      text = text.slice(m[0].length).trim();
      break;
    }
  }
  if (!kind) {
    if (extra.private) kind = 'hypothesis';
    else return null;
  }
  const review = /\s*\(\s*review by\s+(\d{4}-\d{2}-\d{2})\s*\)\s*$/i.exec(text);
  if (review) {
    extra.reviewBy = review[1];
    text = text.slice(0, review.index).trim();
  }
  if (kind === 'decision') {
    const m = /^(.*?)\s+[—-]+\s*because\s+(.+?)(?:\s*;\s*reconsider if\s+(.+))?$/i.exec(text) ?? /^(.*?)\s*;\s*reconsider if\s+(.+)$/i.exec(text);
    if (m && m.length === 4) {
      text = m[1].trim();
      extra.why = m[2].trim();
      if (m[3]) extra.conditions = m[3].split(/\s*;\s*/).filter(Boolean);
    } else if (m) {
      text = m[1].trim();
      extra.conditions = m[2].split(/\s*;\s*/).filter(Boolean);
    }
  }
  if (kind === 'question' || kind === 'contradiction' || kind === 'hypothesis') {
    const m = /^(.*?)\s+[—-]+\s*(?:bears on|depends|it decides|decides)\s*:?\s*(.+)$/i.exec(text);
    if (m) {
      text = m[1].trim();
      extra.bearing = m[2].trim();
    }
  }
  if (kind === 'expectation') {
    const by = /\s+by\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text);
    if (by) {
      extra.due = by[1];
      text = (text.slice(0, by.index) + text.slice(by.index + by[0].length)).trim();
    }
    const src = /\s+in\s+([A-Za-z_][\w ]*?)\s*$/i.exec(text);
    if (src) {
      extra.source = src[1].trim();
      text = text.slice(0, src.index).trim();
    }
    const match = /\b([A-Z]{1,4}-?\d{2,}[A-Z0-9-]*)\b/.exec(text);
    if (match) extra.match = match[1];
  }
  return text ? { kind, text, extra } : null;
}

/** After an import: the file is a source of the table — a snapshot, with the period read from the file name when it carries one. */
export async function recordImport(fileName: string, table: number, tableName: string, rows: number, fields: string[], opts: { period?: string; replaced?: boolean } = {}) {
  const fileId = getState().fileId;
  if (!fileId) {
    setStatus(`${opts.replaced ? 'Updated' : 'Imported'} ${tableName} from ${fileName} — save the document so the companion keeps the snapshot`, 6000);
    return;
  }
  const text = `${opts.replaced ? 'Updated' : 'Imported'} ${tableName} from ${fileName}: ${rows} row${rows === 1 ? '' : 's'}${fields.length ? ` (${fields.slice(0, 12).join(', ')}${fields.length > 12 ? ', …' : ''})` : ''}`;
  // the source is the file series (the name without its date), so that each new snapshot supersedes the last
  const family = familyOf(fileName);
  try {
    const r = await api.files.addRecord(fileId, { kind: 'source', text, source: family, period: opts.period, links: [{ table }], client: getClientId() });
    reflect(fileId, { text: `${opts.replaced ? `${tableName} updated from ${fileName}` : `${fileName} linked to ${tableName}`}${opts.period ? ` — period ${opts.period}` : ' — period not set'}${r.derivative ? ' — looks like generated material: not counted as independent evidence' : ''}`, record: r });
    void loadCompanion(fileId);
  } catch {
    /* the import stands; the context is best-effort */
  }
}

/** One tap on a suggestion: an approved watch, nothing to write. */
export async function acceptSuggestion(sg: Suggestion): Promise<Watch | null> {
  return addWatch(sg.def);
}
/** Set a suggestion aside with a reason; "not now" returns with the next snapshot. */
export async function dismissSuggestion(sg: Suggestion, reason: Dismissed['reason']) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.dismissSuggestion(fileId, { id: sg.id, purpose: sg.purpose, reason, client: getClientId() });
  void loadCompanion(fileId);
}
export async function restoreSuggestion(id: string) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.restoreSuggestion(fileId, id);
  void loadCompanion(fileId);
}

export async function confirmRecord(r: ContextRecord) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.updateRecord(fileId, r.id, { status: 'confirmed', client: getClientId() });
  void loadCompanion(fileId);
}
export async function retireRecord(r: ContextRecord) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.updateRecord(fileId, r.id, { status: 'retired', client: getClientId() });
  void loadCompanion(fileId);
}
export async function removeRecord(r: ContextRecord) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.removeRecord(fileId, r.id);
  clearReflection(fileId);
  void loadCompanion(fileId);
}
export async function correctRecord(r: ContextRecord, patch: RecordPatch) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.updateRecord(fileId, r.id, { ...patch, client: getClientId() });
  void loadCompanion(fileId);
}
/** A question or a conflict settled: what was decided, and the record is resolved (its answer may become a fact). */
export async function resolveRecord(r: ContextRecord, resolution: string, keepAsFact = false) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.updateRecord(fileId, r.id, { status: 'resolved', resolution, client: getClientId() });
  if (keepAsFact && resolution.trim()) await api.files.addRecord(fileId, { kind: 'fact', text: resolution.trim(), source: `answer to: ${r.text.slice(0, 80)}`, client: getClientId() });
  void loadCompanion(fileId);
}
/** What the person says about an expectation: it arrived (evidence elsewhere), or it did not happen. */
export async function markExpectation(r: ContextRecord, state: 'met' | 'didnt' | 'open') {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.updateRecord(fileId, r.id, { expected: state, client: getClientId() });
  void loadCompanion(fileId);
}

export async function addWatch(def: Partial<WatchDef>): Promise<Watch | null> {
  const fileId = getState().fileId;
  if (!fileId) {
    setStatus('Save the document first: watches belong to a saved document.', 6000);
    return null;
  }
  try {
    const w = await api.files.addWatch(fileId, { ...def, client: getClientId() });
    reflect(fileId, { text: `Watching: ${w.def.purpose}`, watch: w });
    void loadCompanion(fileId);
    return w;
  } catch (e) {
    setStatus(`Could not add the watch: ${(e as Error).message}`, 6000);
    return null;
  }
}
export async function approveWatch(w: Watch) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.updateWatch(fileId, w.id, { approve: true, client: getClientId() });
  void loadCompanion(fileId);
}
export async function changeWatch(w: Watch, def: Partial<WatchDef>, reason?: string) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.updateWatch(fileId, w.id, { def, reason, client: getClientId() });
  void loadCompanion(fileId);
}
export async function removeWatch(w: Watch) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.removeWatch(fileId, w.id);
  void loadCompanion(fileId);
}
export async function checkNow() {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.companionCheck(fileId);
  void loadCompanion(fileId);
}
export async function markSeen() {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.companionSeen(fileId);
}

/** A bounded investigation by the agent stack; the panel refreshes when the server says it finished. */
export async function investigate(question?: string, issue?: string): Promise<Investigation | null> {
  const fileId = getState().fileId;
  if (!fileId) {
    setStatus('Save the document first.', 6000);
    return null;
  }
  try {
    const inv = await api.files.investigate(fileId, { question, issue, client: getClientId() });
    setStatus(`Investigating: ${inv.question.slice(0, 80)} — the agent proposes, it changes nothing`, 6000);
    void loadCompanion(fileId);
    return inv;
  } catch (e) {
    setStatus(`Could not start the investigation: ${(e as Error).message}`, 10000);
    void loadCompanion(fileId);
    return null;
  }
}
