// File operations shared by the top bar and the files panel.

import { api } from '../api/client';
import { getClientId, joinFile } from '../api/ws';
import * as book from '../engine/book';
import { getState, setStatus, useStore } from '../state/store';

export async function saveCurrentFile(): Promise<void> {
  const st = getState();
  const json = book.toJson();
  try {
    if (st.fileId && st.permission === 'sign') {
      // a sign-off share never sends a document: the server checkpoints its own replay of the log
      const info = await api.files.checkpoint(st.fileId, getClientId());
      if (info.seq > getState().seq) useStore.setState({ seq: info.seq });
    } else if (st.fileId) {
      const info = await api.files.save(st.fileId, st.fileName, json, getClientId(), st.seq);
      if (info.seq > getState().seq) useStore.setState({ seq: info.seq });
    } else {
      const info = await api.files.create(st.fileName, json, getClientId(), st.fileFolder);
      useStore.setState({ fileId: info.id, seq: info.seq ?? 0, permission: info.permission ?? 'own' });
      joinFile(info.id);
    }
    useStore.setState({ dirty: false });
    setStatus('Saved', 1500);
  } catch (e) {
    setStatus(`Save failed: ${(e as Error).message}`, 6000);
  }
}

export async function openFile(id: string): Promise<void> {
  try {
    const f = await api.files.get(id);
    await book.loadBook(f.json, f.name, f.id);
    useStore.setState({ seq: f.seq ?? 0, permission: f.permission ?? 'own', fileFolder: f.folder ?? '' });
    joinFile(f.id);
    setStatus(`Opened ${f.name}`, 1500);
  } catch (e) {
    setStatus(`Open failed: ${(e as Error).message}`, 6000);
  }
}

export async function newFile(name = 'Untitled', folder = ''): Promise<void> {
  await book.loadBook(null, name, null);
  useStore.setState({ permission: 'own', fileFolder: folder });
  joinFile(null);
}

export function downloadJson() {
  const json = book.toJson();
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${getState().fileName || 'workbook'}.gridwright.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

let autosaveTimer: number | null = null;
export function installAutosave() {
  return useStore.subscribe((s, prev) => {
    if (s.dirty && !prev.dirty && s.fileId) {
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = window.setTimeout(() => {
        autosaveTimer = null;
        if (getState().dirty && getState().fileId) void saveCurrentFile();
      }, 2500);
    }
  });
}

/** Parse CSV text (handles quotes) into rows of strings. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const d = delimiter ?? (text.split('\n')[0]?.includes(';') && !text.split('\n')[0]?.includes(',') ? ';' : ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === d) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}
