// WebSocket rooms: one per document id. The server sequences every op, appends
// it to the document's log and broadcasts it (to the sender too, as the ack).
// Presence (who is on which cell) is broadcast on change.

import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { canEdit, canSign, canView, permissionFor, readAccess, SIGN_OPS, type Permission } from './access.js';
import { appendEntry, currentSeq, entriesSince, sanitiseRun, writeCheckpoint, type Author } from './history.js';
import { identityOf, type Identity } from './identity.js';
import { readFile } from './storage.js';

interface Peer {
  id: string;
  name: string;
  color: string;
  identity: Identity;
  table?: number;
  r?: number;
  c?: number;
  ws: WebSocket;
}

const rooms = new Map<string, Map<string, Peer>>();
const MAX_SNAPSHOT = 50_000_000;

export function attachMultiplayer(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const file = url.searchParams.get('file');
    const client = url.searchParams.get('client');
    if (!file || !client || !/^[a-zA-Z0-9_-]{1,64}$/.test(file) || !/^[a-zA-Z0-9_-]{1,64}$/.test(client)) {
      ws.close(1008, 'file and client required');
      return;
    }
    const identity = identityOf(req);
    // per-document access: the socket of someone who may not even see the document is closed
    const permission: Permission = readFile(file) ? permissionFor(readAccess(file), identity) : identity.role === 'viewer' ? 'view' : 'own';
    if (!canView(permission)) {
      ws.close(1008, 'no access to this document');
      return;
    }
    let room = rooms.get(file);
    if (!room) {
      room = new Map();
      rooms.set(file, room);
    }
    const peer: Peer = { id: client, name: identity.name || 'Guest', color: '#10b981', identity, ws };
    room.set(client, peer);
    const send = (p: Peer, data: string) => {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    };
    const broadcastPresence = () => {
      const peers = Array.from(room!.values()).map((p) => ({ id: p.id, name: p.name, color: p.color, table: p.table, r: p.r, c: p.c, login: p.identity.login || undefined }));
      const msg = JSON.stringify({ type: 'presence', peers });
      for (const p of room!.values()) send(p, msg);
    };
    const broadcastAll = (data: string) => {
      for (const p of room!.values()) send(p, data);
    };
    const author = (): Author => ({ id: client, name: peer.name, login: identity.login || undefined });

    // tell the client where the log stands so it can catch up after a reconnect
    send(peer, JSON.stringify({ type: 'welcome', seq: currentSeq(file), you: { name: peer.name, login: identity.login, role: identity.role, permission } }));

    ws.on('message', (data) => {
      const text = data.toString();
      if (text.length > MAX_SNAPSHOT) return;
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello':
          // the proxy identity wins over whatever the client claims
          if (!identity.name && typeof msg.name === 'string') peer.name = msg.name.slice(0, 40);
          if (typeof msg.color === 'string') peer.color = msg.color.slice(0, 9);
          broadcastPresence();
          break;
        case 'presence':
          peer.table = typeof msg.table === 'number' ? msg.table : undefined;
          peer.r = typeof msg.r === 'number' ? msg.r : undefined;
          peer.c = typeof msg.c === 'number' ? msg.c : undefined;
          broadcastPresence();
          break;
        case 'op': {
          if (!msg.op || typeof msg.op !== 'object') return;
          const allowed = canEdit(permission) || (canSign(permission) && SIGN_OPS.has(String(msg.op.type)));
          if (!allowed) {
            send(peer, JSON.stringify({ type: 'rejected', cid: msg.cid, reason: canSign(permission) ? 'you may only sign off on this document' : 'read-only access' }));
            return;
          }
          const origin = typeof msg.origin === 'string' ? msg.origin.slice(0, 16) : 'user';
          const seq = appendEntry(file, { author: author(), origin, op: msg.op, note: typeof msg.note === 'string' ? msg.note.slice(0, 200) : undefined });
          broadcastAll(JSON.stringify({ type: 'op', seq, client, cid: msg.cid, op: msg.op, origin, author: author() }));
          break;
        }
        case 'snapshot': {
          // undo/redo (or a bulk change) replaced the whole document: checkpoint + broadcast
          if (!canEdit(permission) || typeof msg.json !== 'string') return;
          const seq = appendEntry(file, { author: author(), origin: typeof msg.origin === 'string' ? msg.origin.slice(0, 16) : 'user', checkpoint: true, note: typeof msg.note === 'string' ? msg.note.slice(0, 200) : 'snapshot' });
          writeCheckpoint(file, seq, msg.json);
          const relay = JSON.stringify({ type: 'snapshot', seq, client, json: msg.json });
          for (const p of room!.values()) if (p.id !== client) send(p, relay);
          send(peer, JSON.stringify({ type: 'ack', seq, cid: msg.cid }));
          break;
        }
        case 'run': {
          // a code-cell execution record (hashes + runtime): audit evidence, not an op
          if (!canView(permission)) return;
          const run = sanitiseRun(msg.run);
          if (!run) return;
          const seq = appendEntry(file, { author: author(), origin: 'code', run, note: typeof msg.note === 'string' ? msg.note.slice(0, 200) : undefined });
          send(peer, JSON.stringify({ type: 'run_ack', seq, table: run.table, row: run.row, col: run.col, at: run.at }));
          break;
        }
        case 'catchup': {
          const since = Number(msg.since ?? 0);
          const entries = entriesSince(file, since).filter((e) => e.op || e.checkpoint);
          send(peer, JSON.stringify({ type: 'catchup', since, seq: currentSeq(file), entries }));
          break;
        }
      }
    });
    ws.on('close', () => {
      room!.delete(client);
      if (room!.size === 0) rooms.delete(file);
      else broadcastPresence();
    });
    broadcastPresence();
  });
}

/** Tell everyone in a document's room that a proposal was filed or decided. */
export function notifyProposal(file: string, proposal: unknown) {
  const room = rooms.get(file);
  if (!room) return;
  const msg = JSON.stringify({ type: 'proposal', file, proposal });
  for (const p of room.values()) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
}

export function notifySaved(file: string, byClient?: string) {
  const room = rooms.get(file);
  if (!room) return;
  const msg = JSON.stringify({ type: 'reload', file });
  for (const p of room.values()) if (p.id !== byClient && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
}

export function roomCount(): number {
  return rooms.size;
}
