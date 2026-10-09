// WebSocket rooms: one per document id. The server sequences every op, appends
// it to the document's log and broadcasts it (to the sender too, as the ack).
// Presence (who is on which cell) is broadcast on change.

import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { appendEntry, currentSeq, entriesSince, writeCheckpoint, type Author } from './history.js';
import { identityOf, type Identity } from './identity.js';

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
    send(peer, JSON.stringify({ type: 'welcome', seq: currentSeq(file), you: { name: peer.name, login: identity.login, role: identity.role } }));

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
          if (identity.role === 'viewer') {
            send(peer, JSON.stringify({ type: 'rejected', cid: msg.cid, reason: 'read-only access' }));
            return;
          }
          if (!msg.op || typeof msg.op !== 'object') return;
          const origin = typeof msg.origin === 'string' ? msg.origin.slice(0, 16) : 'user';
          const seq = appendEntry(file, { author: author(), origin, op: msg.op, note: typeof msg.note === 'string' ? msg.note.slice(0, 200) : undefined });
          broadcastAll(JSON.stringify({ type: 'op', seq, client, cid: msg.cid, op: msg.op, origin, author: author() }));
          break;
        }
        case 'snapshot': {
          // undo/redo (or a bulk change) replaced the whole document: checkpoint + broadcast
          if (identity.role === 'viewer' || typeof msg.json !== 'string') return;
          const seq = appendEntry(file, { author: author(), origin: typeof msg.origin === 'string' ? msg.origin.slice(0, 16) : 'user', checkpoint: true, note: typeof msg.note === 'string' ? msg.note.slice(0, 200) : 'snapshot' });
          writeCheckpoint(file, seq, msg.json);
          const relay = JSON.stringify({ type: 'snapshot', seq, client, json: msg.json });
          for (const p of room!.values()) if (p.id !== client) send(p, relay);
          send(peer, JSON.stringify({ type: 'ack', seq, cid: msg.cid }));
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

export function notifySaved(file: string, byClient?: string) {
  const room = rooms.get(file);
  if (!room) return;
  const msg = JSON.stringify({ type: 'reload', file });
  for (const p of room.values()) if (p.id !== byClient && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
}

export function roomCount(): number {
  return rooms.size;
}
