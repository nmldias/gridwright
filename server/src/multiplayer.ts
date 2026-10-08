// WebSocket rooms: one per document id. Ops and snapshots are relayed to the
// other clients; presence (who is on which cell) is broadcast on change.

import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

interface Peer {
  id: string;
  name: string;
  color: string;
  table?: number;
  r?: number;
  c?: number;
  ws: WebSocket;
}

const rooms = new Map<string, Map<string, Peer>>();

export function attachMultiplayer(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const file = url.searchParams.get('file');
    const client = url.searchParams.get('client');
    if (!file || !client || !/^[a-zA-Z0-9_-]{1,64}$/.test(file)) {
      ws.close(1008, 'file and client required');
      return;
    }
    let room = rooms.get(file);
    if (!room) {
      room = new Map();
      rooms.set(file, room);
    }
    const peer: Peer = { id: client, name: 'Guest', color: '#10b981', ws };
    room.set(client, peer);
    const broadcastPresence = () => {
      const peers = Array.from(room!.values()).map((p) => ({ id: p.id, name: p.name, color: p.color, table: p.table, r: p.r, c: p.c }));
      const msg = JSON.stringify({ type: 'presence', peers });
      for (const p of room!.values()) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
    };
    const relay = (data: string) => {
      for (const p of room!.values()) if (p.id !== client && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    };
    ws.on('message', (data) => {
      const text = data.toString();
      if (text.length > 50_000_000) return;
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello':
          if (typeof msg.name === 'string') peer.name = msg.name.slice(0, 40);
          if (typeof msg.color === 'string') peer.color = msg.color.slice(0, 9);
          broadcastPresence();
          break;
        case 'presence':
          peer.table = typeof msg.table === 'number' ? msg.table : undefined;
          peer.r = typeof msg.r === 'number' ? msg.r : undefined;
          peer.c = typeof msg.c === 'number' ? msg.c : undefined;
          broadcastPresence();
          break;
        case 'op':
        case 'snapshot':
          relay(text);
          break;
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
