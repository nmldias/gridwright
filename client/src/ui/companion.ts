// The companion as the panel sees it: one snapshot per document, reloaded when the server says it
// re-checked (socket message), when the document changes hands, and after anything the person does
// here. A reflection — the last thing recorded, with a way to correct it — is kept per document too.

import { create } from 'zustand';
import { api, type Companion, type ContextRecord, type RecordKind, type Suggestion, type Watch, type WatchDef } from '../api/client';
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

const KIND_WORD: Record<RecordKind, string> = { fact: 'fact', source: 'source', objective: 'objective', hypothesis: 'hypothesis', contradiction: 'contradiction', decision: 'decision', exclusion: 'exclusion' };

/** Record something the person said or added; the reflection shows it back for correction. */
export async function remember(kind: RecordKind, text: string, extra: { source?: string; period?: string; links?: { table?: number; ref?: string }[] } = {}): Promise<ContextRecord | null> {
  const fileId = getState().fileId;
  if (!fileId) {
    setStatus('Save the document first: the companion keeps context per saved document.', 6000);
    return null;
  }
  try {
    const r = await api.files.addRecord(fileId, { kind, text, ...extra, client: getClientId() });
    reflect(fileId, { text: `Recorded ${KIND_WORD[kind]}: ${r.text}${r.period ? ` (period ${r.period})` : ''}`, record: r });
    void loadCompanion(fileId);
    return r;
  } catch (e) {
    setStatus(`Could not record it: ${(e as Error).message}`, 6000);
    return null;
  }
}

/** Chat prefixes that are statements to keep, not questions: no model call needed. */
const PREFIXES: [RegExp, RecordKind][] = [
  [/^(objective|goal|constraint)\s*:\s*/i, 'objective'],
  [/^(exclude|exclusion)\s*:\s*/i, 'exclusion'],
  [/^(decision|decided)\s*:\s*/i, 'decision'],
  [/^(remember|fact|note)\s*:\s*/i, 'fact'],
  [/^(hypothesis|maybe)\s*:\s*/i, 'hypothesis'],
  [/^(contradiction|conflict)\s*:\s*/i, 'contradiction'],
];
export function statementOf(text: string): { kind: RecordKind; text: string } | null {
  for (const [re, kind] of PREFIXES) {
    const m = re.exec(text.trim());
    if (m) {
      const body = text.trim().slice(m[0].length).trim();
      return body ? { kind, text: body } : null;
    }
  }
  return null;
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
    reflect(fileId, { text: `${opts.replaced ? `${tableName} updated from ${fileName}` : `${fileName} linked to ${tableName}`}${opts.period ? ` — period ${opts.period}` : ' — period not set'}`, record: r });
    void loadCompanion(fileId);
  } catch {
    /* the import stands; the context is best-effort */
  }
}

/** One tap on a suggestion: an approved watch, nothing to write. */
export async function acceptSuggestion(sg: Suggestion): Promise<Watch | null> {
  return addWatch(sg.def);
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
export async function correctRecord(r: ContextRecord, patch: { text?: string; period?: string; source?: string; kind?: RecordKind }) {
  const fileId = getState().fileId;
  if (!fileId) return;
  await api.files.updateRecord(fileId, r.id, { ...patch, client: getClientId() });
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
