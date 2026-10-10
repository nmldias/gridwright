// Multiplayer link. The server sequences every op: local ops are applied
// optimistically, sent with a client id, and acknowledged when they come back
// with their seq. Remote ops are applied as they arrive; when a remote op
// crosses a pending local op the client rebases (cell-level ops) or resyncs
// from the server's log (structural ops), so every client converges on the
// server's order.

import { api } from './client';
import * as book from '../engine/book';
import { SHIFT_OPS, STRUCTURAL_OPS, type Op } from '../engine/types';
import { getState, setStatus, useStore, type Presence } from '../state/store';
import { lastRecord, onRecord } from '../workers/runs';

let ws: WebSocket | null = null;
let fileId: string | null = null;
let clientId = '';
let reconnectTimer: number | null = null;
let unsubOp: (() => void) | null = null;
let unsubSel: (() => void) | null = null;
let unsubRun: (() => void) | null = null;
let retry = 0;
let nextCid = 1;
let resyncing = false;

interface Pending {
  cid: number;
  op: Op;
}
const pending: Pending[] = [];

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

export function getClientId(): string {
  return clientId;
}

export function joinFile(id: string | null) {
  leave();
  fileId = id;
  if (!id) return;
  clientId = Math.random().toString(36).slice(2, 10);
  connect();
}

function send(obj: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
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
    // re-send ops that were in flight when the connection dropped
    for (const p of pending) sock.send(JSON.stringify({ type: 'op', client: clientId, cid: p.cid, op: p.op, origin: 'user' }));
  };
  sock.onmessage = (e) => {
    let msg: any;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'welcome': {
        const mine = getState().seq;
        if (msg.you) useStore.setState({ me: { ...getState().me, name: msg.you.name || getState().me.name, login: msg.you.login || '', role: msg.you.role || 'editor' }, ...(msg.you.permission ? { permission: msg.you.permission } : {}) });
        if (mine > 0 && typeof msg.seq === 'number' && msg.seq > mine && pending.length === 0) {
          // we missed ops while disconnected
          void resync('reconnect');
        } else if (mine === 0 && typeof msg.seq === 'number') {
          useStore.setState({ seq: msg.seq });
        }
        break;
      }
      case 'op': {
        if (typeof msg.seq === 'number') useStore.setState({ seq: Math.max(getState().seq, msg.seq) });
        if (msg.client === clientId) {
          const idx = pending.findIndex((p) => p.cid === msg.cid);
          if (idx >= 0) pending.splice(idx, 1);
          break;
        }
        if (!msg.op) break;
        applyRemote(msg.op as Op);
        break;
      }
      case 'rejected': {
        const idx = pending.findIndex((p) => p.cid === msg.cid);
        if (idx >= 0) pending.splice(idx, 1);
        setStatus(`Change rejected by the server: ${msg.reason ?? 'not allowed'}`, 6000);
        void resync('rejected');
        break;
      }
      case 'ack':
        if (typeof msg.seq === 'number') useStore.setState({ seq: Math.max(getState().seq, msg.seq) });
        break;
      case 'presence': {
        const presence = new Map<string, Presence>();
        for (const p of msg.peers as Presence[]) {
          if (p.id === clientId) continue;
          presence.set(p.id, p);
        }
        useStore.setState({ presence });
        break;
      }
      case 'snapshot':
        if (msg.client !== clientId && typeof msg.json === 'string') {
          const st = getState();
          if (typeof msg.seq === 'number') useStore.setState({ seq: Math.max(st.seq, msg.seq) });
          pending.length = 0;
          void book.loadBook(msg.json, st.fileName, st.fileId, { keepView: true });
        }
        break;
      case 'run_ack': {
        // the server logged a run record: remember its log position
        const r = lastRecord({ table: msg.table, row: msg.row, col: msg.col });
        if (r && r.at === msg.at) r.seq = msg.seq;
        if (typeof msg.seq === 'number') useStore.setState({ seq: Math.max(getState().seq, msg.seq), runsVersion: getState().runsVersion + 1 });
        break;
      }
      case 'proposal': {
        const p = msg.proposal as { status?: string; title?: string; by?: { name?: string } } | undefined;
        useStore.setState({ proposalsVersion: getState().proposalsVersion + 1 });
        if (p?.status === 'pending') setStatus(`Proposal from ${p.by?.name ?? 'an agent'}: “${p.title ?? ''}” — review it in the Review panel`, 8000);
        break;
      }
      case 'reload':
        // another client saved; edits are already relayed live, nothing to do
        break;
      case 'companion':
        // the companion re-checked this document (a change, a timer): the brief refreshes itself
        useStore.setState({ companionVersion: getState().companionVersion + 1, attention: typeof msg.attention === 'number' ? msg.attention : getState().attention });
        break;
      case 'job': {
        // a job of this document changed state: when it finished, what it left (a held refresh, a placed version, an investigation) is reloaded
        const job = msg.job as { id: string; type: string; status: string; error?: string } | undefined;
        if (job && job.status !== 'queued' && job.status !== 'running') {
          useStore.setState({ companionVersion: getState().companionVersion + 1 });
          if (job.type === 'refresh') setStatus(job.status === 'done' ? 'Refresh finished' : `Refresh ${job.status}${job.error ? `: ${job.error}` : ''}`, 6000);
        }
        break;
      }
      case 'permission':
        // the owner changed this document's sharing while we are connected
        if (typeof msg.permission === 'string') {
          useStore.setState({ permission: msg.permission });
          setStatus(msg.permission === 'edit' || msg.permission === 'own' ? 'You can edit this document again' : `Your access to this document is now ${msg.permission === 'sign' ? 'sign-off only' : 'read-only'}`, 8000);
        }
        break;
      case 'revoked':
        // access removed: stop reconnecting, show why
        fileId = null;
        pending.length = 0;
        useStore.setState({ permission: 'none', presence: new Map() });
        setStatus('Your access to this document was removed — the changes you make here will not be saved', 0);
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
    unsubOp = book.onOp((op, _changes, meta) => {
      if (!fileId) return;
      if (op === null) {
        // a bulk replacement (restore from history, import): the whole document is the new truth
        pending.length = 0;
        send({ type: 'snapshot', client: clientId, json: book.toJson(), origin: meta.origin, note: meta.note });
        return;
      }
      if (op.type === 'code_result') return; // derived; every client recomputes its own
      const cid = nextCid++;
      pending.push({ cid, op });
      send({ type: 'op', client: clientId, cid, op, origin: meta.origin, note: meta.note });
    });
  }
  if (!unsubRun) {
    unsubRun = onRecord((r) => {
      if (!fileId) return;
      if (r.attested === 'server') return; // the server wrote this record itself
      send({ type: 'run', client: clientId, run: r });
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

/** Apply an op that the server sequenced before our pending ops. */
function applyRemote(op: Op) {
  if (resyncing) return;
  if (pending.length === 0) {
    book.applyRemote(op);
    return;
  }
  const pendingStructural = pending.some((p) => STRUCTURAL_OPS.has(p.op.type));
  if (SHIFT_OPS.has(op.type) && !pendingStructural) {
    // rows/columns shifted under our in-flight cell ops: move them along (operational transform)
    book.applyRemote(op);
    for (let i = pending.length - 1; i >= 0; i--) {
      const t = transformOp(pending[i].op, op);
      if (t === null) pending.splice(i, 1);
      else pending[i].op = t;
    }
    // our transformed ops are re-applied on top so the local view matches what the server will hold
    for (const p of pending) book.applyRemote(p.op);
    return;
  }
  const structural = STRUCTURAL_OPS.has(op.type) || pendingStructural;
  if (structural) {
    // shapes diverged beyond an index shift: take the server's truth once our ops are acked
    book.applyRemote(op);
    void resync('conflict');
    return;
  }
  // cell-level ops: the remote op comes first, our pending ops win where they overlap
  book.applyRemote(op);
  const r = opRect(op);
  for (const p of pending) {
    const q = opRect(p.op);
    const overlap = !r || !q || (r.table === q.table && r.r0 <= q.r1 && q.r0 <= r.r1 && r.c0 <= q.c1 && q.c0 <= r.c1);
    if (overlap) book.applyRemote(p.op);
  }
}

/** Shift one index past an insert/delete; null when it was deleted. */
function shiftIndex(i: number, at: number, count: number, insert: boolean): number | null {
  if (insert) return i >= at ? i + count : i;
  if (i >= at && i < at + count) return null;
  return i >= at + count ? i - count : i;
}

/** Shift a [a, b] span; null when it was deleted entirely. */
function shiftSpan(a: number, b: number, at: number, count: number, insert: boolean): [number, number] | null {
  if (insert) return [a >= at ? a + count : a, b >= at ? b + count : b];
  const d1 = at + count - 1;
  if (a >= at && b <= d1) return null;
  const na = a > d1 ? a - count : a >= at ? at : a;
  const nb = b > d1 ? b - count : b >= at ? at - 1 : b;
  return nb < na ? null : [na, nb];
}

/** Rewrite a pending op so it applies after a remote insert/delete of rows or columns (null = dropped). */
export function transformOp(op: Op, remote: Op): Op | null {
  if (!SHIFT_OPS.has(remote.type)) return op;
  const rem = remote as Extract<Op, { type: 'insert_rows' | 'delete_rows' | 'insert_cols' | 'delete_cols' }>;
  if (!('table' in op) || op.table !== rem.table) return op;
  const rows = rem.type === 'insert_rows' || rem.type === 'delete_rows';
  const insert = rem.type === 'insert_rows' || rem.type === 'insert_cols';
  const { at, count } = rem;
  switch (op.type) {
    case 'set_cell': {
      const i = shiftIndex(rows ? op.row : op.col, at, count, insert);
      if (i === null) return null;
      return rows ? { ...op, row: i } : { ...op, col: i };
    }
    case 'set_cells': {
      // a block that straddles the change is kept as one op only when nothing inside was deleted
      const n = rows ? op.values.length : Math.max(1, ...op.values.map((r) => r.length));
      const start = rows ? op.row : op.col;
      const span = shiftSpan(start, start + n - 1, at, count, insert);
      if (!span) return null;
      if (insert && at > start && at < start + n) {
        // rows/cols inserted inside the block: split is not worth it, let the server's state win
        return null;
      }
      if (!insert && span[1] - span[0] + 1 !== n) return null;
      return rows ? { ...op, row: span[0] } : { ...op, col: span[0] };
    }
    case 'clear_range':
    case 'set_format':
    case 'merge_cells':
    case 'unmerge_cells':
    case 'add_signoff': {
      const span = rows ? shiftSpan(op.r0, op.r1, at, count, insert) : shiftSpan(op.c0, op.c1, at, count, insert);
      if (!span) return null;
      return rows ? { ...op, r0: span[0], r1: span[1] } : { ...op, c0: span[0], c1: span[1] };
    }
    case 'set_col_width': {
      if (rows) return op;
      const i = shiftIndex(op.col, at, count, insert);
      return i === null ? null : { ...op, col: i };
    }
    case 'set_row_height': {
      if (!rows) return op;
      const i = shiftIndex(op.row, at, count, insert);
      return i === null ? null : { ...op, row: i };
    }
    case 'code_result':
      return null;
    default:
      return op;
  }
}

/** Cells an op writes (null = unknown / whole table). */
function opRect(op: Op): { table: number; r0: number; c0: number; r1: number; c1: number } | null {
  switch (op.type) {
    case 'set_cell':
      return { table: op.table, r0: op.row, c0: op.col, r1: op.row, c1: op.col };
    case 'set_cells': {
      const rows = op.values.length;
      const cols = Math.max(1, ...op.values.map((r) => r.length));
      return { table: op.table, r0: op.row, c0: op.col, r1: op.row + rows - 1, c1: op.col + cols - 1 };
    }
    case 'clear_range':
    case 'set_format':
    case 'merge_cells':
    case 'unmerge_cells':
    case 'add_signoff':
      return { table: op.table, r0: op.r0, c0: op.c0, r1: op.r1, c1: op.c1 };
    case 'move_table':
    case 'set_col_width':
    case 'set_row_height':
    case 'set_filters':
    case 'set_cond_formats':
    case 'set_validations':
    case 'remove_signoff':
    case 'set_signoff_locked':
      return { table: op.table, r0: -1, c0: -1, r1: -1, c1: -1 }; // metadata only: never overlaps cells
    case 'add_chart':
    case 'update_chart':
    case 'delete_chart':
    case 'set_name':
    case 'restore_names':
    case 'restore_charts':
      return { table: -1, r0: -1, c0: -1, r1: -1, c1: -1 }; // workbook-level: never overlaps cells
    default:
      return null;
  }
}

/** Rebuild the document from the server's log (checkpoint + ops) once nothing is in flight. */
async function resync(reason: string) {
  if (!fileId || resyncing) return;
  resyncing = true;
  try {
    // wait for acks of in-flight ops (bounded)
    for (let i = 0; i < 40 && pending.length > 0; i++) await new Promise((r) => setTimeout(r, 50));
    pending.length = 0;
    const fid = fileId;
    const seq = getState().seq;
    const bundle = await api.files.replay(fid, seq);
    if (!bundle || fileId !== fid) return;
    const st = getState();
    const json = await book.replayDocument(bundle.json, bundle.ops.map((e) => e.op as Op), st.fileName);
    await book.loadBook(json, st.fileName, st.fileId, { keepView: true });
    useStore.setState({ seq: Math.max(getState().seq, seq), dirty: true });
    if (reason !== 'reconnect') setStatus('Synchronised with the other editors', 2000);
  } catch (e) {
    setStatus(`Could not resynchronise: ${(e as Error).message}`, 6000);
  } finally {
    resyncing = false;
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
  pending.length = 0;
  if (ws) {
    const s = ws;
    ws = null;
    s.close();
  }
  useStore.setState({ presence: new Map(), seq: 0 });
}

export function connected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}
