// Unsaved edits to a cell's code, per document and cell. They outlive the Code panel (switching to
// Review and back keeps what was typed) and are never run on their own: Ctrl+S or Run commits them.

import { docKey } from './chat';

const drafts = new Map<string, string>();

type Ref = { table: number; row: number; col: number };
export const draftKey = (fileId: string | null, c: Ref) => `${docKey(fileId)}:${c.table}:${c.row}:${c.col}`;

export const getDraft = (key: string) => drafts.get(key);
export const hasDraft = (key: string) => drafts.has(key);
export const setDraft = (key: string, text: string) => void drafts.set(key, text);
export const clearDraft = (key: string) => void drafts.delete(key);

export function codeDraft(fileId: string | null, c: Ref): string | undefined {
  return drafts.get(draftKey(fileId, c));
}

/** When an unsaved document is saved for the first time, its drafts follow it. */
export function adoptUnsavedDrafts(fileId: string) {
  for (const [k, v] of Array.from(drafts)) {
    if (k.startsWith('(unsaved):')) {
      drafts.delete(k);
      drafts.set(`${fileId}:${k.slice('(unsaved):'.length)}`, v);
    }
  }
}
