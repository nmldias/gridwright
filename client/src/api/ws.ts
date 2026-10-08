// Multiplayer link: broadcasts local ops to other clients editing the same
// file and applies theirs; also exchanges presence (selected cell).

import * as book from '../engine/book';
import type { Op } from '../engine/types';
import { getState, useStore, type Presence } from '../state/store';

let ws: WebSocket | null = null;
let fileId: string | null = null;
let clientId = '';
let reconnectTimer: number | null = null;
let unsubOp: (() => void) | null = null;
let unsubSel: (() => void) | null = null;
let retry = 0;

const COLORS = ['#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];

function myName(): string {
  try {
    return localStorage.getItem('gridwright.name') || `Guest ${Math.floor(Math.random() * 900 + 100)}`;
  } catch {
    return 'Guest';
  }
}

export function setMyName(name: string) {
  try {
    localStorage.setItem('gridwright.name', name);
  } catch {
    /* ignore */
  }
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hello', name }));
}

export function joinFile(id: string | null) {
  leave();
  fileId = id;
  if (!id) return;
  clientId = Math.random().toString(36).slice(2, 10);
  connect();
}

function connect() {
  if (!fileId) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?file=${encodeURIComponent(fileId)}&client=${clientId}`;
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    sock.send(JSON.stringify({ type: 'hello', name: myName(), color: COLORS[Math.floor(Math.random() * COLORS.length)] }));
    sendPresence();
  };
  sock.onmessage = (e) => {
    let msg: any;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'op':
        if (msg.client !== clientId && msg.op) book.apply(msg.op as Op, { remote: true, silent: true });
        break;
      case 'presence': {
        const presence = new Map(getState().presence);
        for (const p of msg.peers as Presence[]) {
          if (p.id === clientId) continue;
          presence.set(p.id, p);
        }
        for (const id of Array.from(presence.keys())) if (!(msg.peers as Presence[]).some((p) => p.id === id)) presence.delete(id);
        useStore.setState({ presence });
        break;
      }
      case 'snapshot':
        if (msg.client !== clientId && typeof msg.json === 'string') {
          const st = getState();
          void book.loadBook(msg.json, st.fileName, st.fileId);
        }
        break;
      case 'reload':
        // another client saved a newer version; the files panel will offer to reload
        useStore.setState({ status: 'The document was saved by another client.' });
        break;
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    useStore.setState({ presence: new Map() });
    if (fileId) {
      retry++;
      reconnectTimer = window.setTimeout(connect, Math.min(15000, 1000 * retry));
    }
  };
  sock.onerror = () => sock.close();
  if (!unsubOp) {
    unsubOp = book.onOp((op) => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      if (op === null) ws.send(JSON.stringify({ type: 'snapshot', client: clientId, json: book.toJson() }));
      else if (op.type !== 'code_result') ws.send(JSON.stringify({ type: 'op', client: clientId, op }));
    });
  }
  if (!unsubSel) {
    let last = '';
    unsubSel = useStore.subscribe((s) => {
      const sel = s.selection;
      const key = sel ? `${sel.table}:${sel.ar}:${sel.ac}` : '';
      if (key !== last) {
        last = key;
        sendPresence();
      }
    });
  }
}

function sendPresence() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const sel = getState().selection;
  ws.send(JSON.stringify({ type: 'presence', table: sel?.table, r: sel?.ar, c: sel?.ac }));
}

export function leave() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  fileId = null;
  if (ws) {
    const s = ws;
    ws = null;
    s.close();
  }
  useStore.setState({ presence: new Map() });
}

export function connected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}
