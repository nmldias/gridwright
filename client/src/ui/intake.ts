// Bringing material in: a file (or a pasted text, an inbox file, a query result) goes to the
// server to be parsed, profiled, sanitised and related to what the situation already holds; the
// profile comes back as a card in Ask where the person decides how to place it — update the series,
// add a new table, keep it as history, or skip. Nothing reaches the workbook before that decision;
// the original is kept on the server under its content hash. A document that is not saved yet is
// saved first, as a private draft, so that the companion can keep what it learns.

import { create } from 'zustand';
import { api, type IntakeProfile } from '../api/client';
import { getState, setStatus, useStore } from '../state/store';
import { saveCurrentFile } from './files';
import { loadCompanion, reflectLine } from './companion';
import { familyOf } from './snapshots';
import { autoFitColumns } from '../grid/actions';

interface IntakeState {
  /** profiles waiting for a decision, per document */
  pending: Record<string, IntakeProfile[]>;
  busy: Record<string, boolean>;
}
export const useIntake = create<IntakeState>(() => ({ pending: {}, busy: {} }));

function push(fileId: string, p: IntakeProfile) {
  useIntake.setState((s) => ({ pending: { ...s.pending, [fileId]: [...(s.pending[fileId] ?? []).filter((x) => x.key !== p.key), p] } }));
}
export function dropIntake(fileId: string, key: string) {
  useIntake.setState((s) => ({ pending: { ...s.pending, [fileId]: (s.pending[fileId] ?? []).filter((x) => x.key !== key) } }));
}

/** The document the companion keeps context for: saved now, as a private draft, when it is not yet — with its real persistence state shown in the bar. */
export async function ensureDraft(nameHint?: string): Promise<string | null> {
  const st = getState();
  if (st.fileId) return st.fileId;
  if (nameHint && (!st.fileName || st.fileName === 'Untitled')) useStore.setState({ fileName: nameHint.slice(0, 80) });
  await saveCurrentFile();
  const id = getState().fileId;
  if (!id) setStatus('The document could not be saved; it stays local — the material was not added', 8000);
  return id;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/** Profile a file: the card appears in Ask; the person decides how to place it. */
export async function intakeFile(f: File): Promise<IntakeProfile | null> {
  const fileId = await ensureDraft(familyOf(f.name));
  if (!fileId) return null;
  useIntake.setState((s) => ({ busy: { ...s.busy, [fileId]: true } }));
  useStore.setState({ start: false, panel: 'ai' });
  try {
    const p = await api.files.intake(fileId, { name: f.name, base64: toBase64(await f.arrayBuffer()) });
    push(fileId, p);
    setStatus(`${f.name}: ${p.sets.length === 1 ? p.sets[0].relation.reason : `${p.sets.length} sets found`}`, 6000);
    return p;
  } catch (e) {
    setStatus(`Could not read ${f.name}: ${(e as Error).message}`, 10000);
    return null;
  } finally {
    useIntake.setState((s) => ({ busy: { ...s.busy, [fileId]: false } }));
  }
}

/** Pasted text (rows separated by newlines, cells by tabs, commas or semicolons) as a snapshot. */
export async function intakeText(text: string, name = `pasted-${new Date().toISOString().slice(0, 10)}.txt`): Promise<IntakeProfile | null> {
  const fileId = await ensureDraft(familyOf(name));
  if (!fileId) return null;
  try {
    const p = await api.files.intake(fileId, { name, text });
    push(fileId, p);
    return p;
  } catch (e) {
    setStatus(`Could not read the pasted text: ${(e as Error).message}`, 10000);
    return null;
  }
}

export async function intakeFromInbox(name: string): Promise<IntakeProfile | null> {
  const fileId = await ensureDraft(familyOf(name));
  if (!fileId) return null;
  try {
    const p = await api.files.intake(fileId, { inbox: name });
    push(fileId, p);
    useStore.setState({ panel: 'ai' });
    return p;
  } catch (e) {
    setStatus(`Could not take ${name} from the inbox: ${(e as Error).message}`, 10000);
    return null;
  }
}

export async function intakeQuery(connection: string, sql: string): Promise<IntakeProfile | null> {
  const fileId = await ensureDraft('query');
  if (!fileId) return null;
  try {
    const p = await api.files.intake(fileId, { connection, sql });
    push(fileId, p);
    useStore.setState({ panel: 'ai' });
    return p;
  } catch (e) {
    setStatus(`The query could not be taken as a snapshot: ${(e as Error).message}`, 10000);
    return null;
  }
}

/** Place as decided: the server commits through the log, records the source, runs the checks and the first reading. */
export async function applyIntake(p: IntakeProfile, decisions: { set?: string; action: 'update' | 'new' | 'history' | 'skip'; table?: number; name?: string }[], period?: string): Promise<IntakeProfile | null> {
  const fileId = getState().fileId;
  if (!fileId) return null;
  try {
    const done = await api.files.applyIntake(fileId, p.key, { decisions, period });
    dropIntake(fileId, p.key);
    const placed = done.applied?.tables ?? [];
    // the placed table arrives over the log a moment later: fit its columns then, so no amount shows as ####
    for (const t of placed) for (const delay of [400, 1500]) setTimeout(() => getState().tables.has(t.table) && autoFitColumns(t.table), delay);
    for (const t of placed) {
      const reading = done.readings?.find((r) => r.table === t.table);
      reflectLine(fileId, { text: `${t.placed === 'update' ? `${t.name} updated from ${p.name}` : t.placed === 'history' ? `${p.name} kept as history (${t.name})` : `${p.name} added as ${t.name}`}${done.period ? ` — period ${done.period}` : ' — period not set'}${reading ? `. ${reading.text}` : ''}` });
    }
    void loadCompanion(fileId);
    return done;
  } catch (e) {
    setStatus(`Could not place ${p.name}: ${(e as Error).message}`, 10000);
    return null;
  }
}

export function skipIntake(p: IntakeProfile) {
  const fileId = getState().fileId;
  if (!fileId) return;
  dropIntake(fileId, p.key);
  void api.files.declineIntake(fileId, p.key).catch(() => undefined);
  setStatus(`${p.name} was not placed; the original stays on the server under Context → sources`, 5000);
}

/** The decisions still open on the server (a held refresh, a profile left undecided): the cards come back after a reload or on another device. */
export async function loadPendingIntakes(fileId: string) {
  try {
    const list = await api.files.intakes(fileId, true);
    useIntake.setState((s) => {
      const local = s.pending[fileId] ?? [];
      // union: what this browser holds (a card just profiled here) and what the server still has open; the server's copy carries the held reason
      const merged = [...local.map((x) => list.find((p) => p.key === x.key) ?? x), ...list.filter((p) => !local.some((x) => x.key === p.key))];
      return { pending: { ...s.pending, [fileId]: merged } };
    });
  } catch {
    /* not permitted or offline */
  }
}

/** A refresh on request: the job runs on the server; the card appears if the result is held, the table changes if it is placed. */
export async function refreshSource(fileId: string, sourceId: string) {
  try {
    const job = await api.files.refreshSource(fileId, sourceId);
    setStatus(`Refresh queued (job ${job.id.slice(0, 8)})`, 4000);
    return job;
  } catch (e) {
    setStatus(`Refresh refused: ${(e as Error).message}`, 8000);
    return null;
  }
}
