// WebSocket rooms: one per document id. The server sequences every op, appends
// it to the document's log and broadcasts it (to the sender too, as the ack).
// Presence (who is on which cell) is broadcast on change.
import { WebSocket } from 'ws';
import { canEdit, canSign, canView, permissionFor, readAccess, SIGN_OPS } from './access.js';
import { appendEntry, currentSeq, entriesSince, sanitiseRun, writeCheckpoint } from './history.js';
import { identityOf } from './identity.js';
import { readFile } from './storage.js';
import { ACCOUNTS } from './tenancy.js';
const rooms = new Map();
const MAX_SNAPSHOT = 50_000_000;
export function attachMultiplayer(wss) {
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const file = url.searchParams.get('file');
        const client = url.searchParams.get('client');
        if (!file || !client || !/^[a-zA-Z0-9_-]{1,64}$/.test(file) || !/^[a-zA-Z0-9_-]{1,64}$/.test(client)) {
            ws.close(1008, 'file and client required');
            return;
        }
        const identity = identityOf(req);
        // per-document access, computed now and again before every change (never only at connect time)
        // (accounts mode: a room exists only for a saved document of the caller's client — an unsaved id
        // is nobody's, so it could otherwise be shared across clients by guessing it)
        const permissionNow = () => (readFile(file) ? permissionFor(readAccess(file), identity) : ACCOUNTS ? 'none' : identity.role === 'viewer' ? 'view' : 'own');
        const permission = permissionNow();
        if (!canView(permission)) {
            ws.close(1008, 'no access to this document');
            return;
        }
        let room = rooms.get(file);
        if (!room) {
            room = new Map();
            rooms.set(file, room);
        }
        const peer = { id: client, name: identity.name || 'Guest', color: '#10b981', identity, permission, ws };
        /** the permission for this message; a session whose access was removed is closed on the spot */
        const perm = () => {
            const now = permissionNow();
            if (now !== peer.permission) {
                peer.permission = now;
                if (canView(now))
                    send(peer, JSON.stringify({ type: 'permission', permission: now }));
            }
            if (!canView(now)) {
                send(peer, JSON.stringify({ type: 'revoked' }));
                ws.close(1008, 'access removed');
            }
            return now;
        };
        room.set(client, peer);
        const send = (p, data) => {
            if (p.ws.readyState === WebSocket.OPEN)
                p.ws.send(data);
        };
        const broadcastPresence = () => {
            const peers = Array.from(room.values()).map((p) => ({ id: p.id, name: p.name, color: p.color, table: p.table, r: p.r, c: p.c, login: p.identity.login || undefined }));
            const msg = JSON.stringify({ type: 'presence', peers });
            for (const p of room.values())
                send(p, msg);
        };
        const broadcastAll = (data) => {
            for (const p of room.values())
                send(p, data);
        };
        const author = () => ({ id: client, name: peer.name, login: identity.login || undefined });
        // tell the client where the log stands so it can catch up after a reconnect
        send(peer, JSON.stringify({ type: 'welcome', seq: currentSeq(file), you: { name: peer.name, login: identity.login, role: identity.role, permission } }));
        ws.on('message', (data) => {
            const text = data.toString();
            if (text.length > MAX_SNAPSHOT)
                return;
            let msg;
            try {
                msg = JSON.parse(text);
            }
            catch {
                return;
            }
            switch (msg.type) {
                case 'hello':
                    // the proxy identity wins over whatever the client claims
                    if (!identity.name && typeof msg.name === 'string')
                        peer.name = msg.name.slice(0, 40);
                    if (typeof msg.color === 'string')
                        peer.color = msg.color.slice(0, 9);
                    broadcastPresence();
                    break;
                case 'presence':
                    peer.table = typeof msg.table === 'number' ? msg.table : undefined;
                    peer.r = typeof msg.r === 'number' ? msg.r : undefined;
                    peer.c = typeof msg.c === 'number' ? msg.c : undefined;
                    broadcastPresence();
                    break;
                case 'op': {
                    if (!msg.op || typeof msg.op !== 'object')
                        return;
                    const now = perm();
                    const allowed = canEdit(now) || (canSign(now) && SIGN_OPS.has(String(msg.op.type)));
                    if (!allowed) {
                        send(peer, JSON.stringify({ type: 'rejected', cid: msg.cid, reason: canSign(now) ? 'you may only sign off on this document' : 'read-only access' }));
                        return;
                    }
                    const origin = typeof msg.origin === 'string' ? msg.origin.slice(0, 16) : 'user';
                    const seq = appendEntry(file, { author: author(), origin, op: msg.op, note: typeof msg.note === 'string' ? msg.note.slice(0, 200) : undefined });
                    broadcastAll(JSON.stringify({ type: 'op', seq, client, cid: msg.cid, op: msg.op, origin, author: author() }));
                    break;
                }
                case 'snapshot': {
                    // undo/redo (or a bulk change) replaced the whole document: checkpoint + broadcast
                    if (!canEdit(perm()) || typeof msg.json !== 'string')
                        return;
                    const seq = appendEntry(file, { author: author(), origin: typeof msg.origin === 'string' ? msg.origin.slice(0, 16) : 'user', checkpoint: true, note: typeof msg.note === 'string' ? msg.note.slice(0, 200) : 'snapshot' });
                    writeCheckpoint(file, seq, msg.json);
                    const relay = JSON.stringify({ type: 'snapshot', seq, client, json: msg.json });
                    for (const p of room.values())
                        if (p.id !== client)
                            send(p, relay);
                    send(peer, JSON.stringify({ type: 'ack', seq, cid: msg.cid }));
                    break;
                }
                case 'run': {
                    // a code-cell execution record (hashes + runtime) reported by a browser runtime: audit evidence, not an op
                    if (!canView(perm()))
                        return;
                    const run = sanitiseRun(msg.run);
                    if (!run)
                        return;
                    run.attested = 'client';
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
            room.delete(client);
            if (room.size === 0)
                rooms.delete(file);
            else
                broadcastPresence();
        });
        broadcastPresence();
    });
}
/** Access to a document changed: downgrade or disconnect the sessions it affects, at once. */
export function accessChanged(file) {
    const room = rooms.get(file);
    if (!room)
        return;
    for (const p of Array.from(room.values())) {
        const now = readFile(file) ? permissionFor(readAccess(file), p.identity) : ACCOUNTS ? 'none' : p.identity.role === 'viewer' ? 'view' : 'own';
        if (now === p.permission)
            continue;
        p.permission = now;
        if (p.ws.readyState !== WebSocket.OPEN)
            continue;
        if (!canView(now)) {
            p.ws.send(JSON.stringify({ type: 'revoked' }));
            p.ws.close(1008, 'access removed');
        }
        else
            p.ws.send(JSON.stringify({ type: 'permission', permission: now }));
    }
}
/** A membership, a role or a client's status changed: every open session is checked again. */
export function accessChangedEverywhere() {
    for (const file of Array.from(rooms.keys()))
        accessChanged(file);
}
/** Operations the server committed itself (an applied proposal): every session applies them in log order. */
export function broadcastEntries(file, entries) {
    const room = rooms.get(file);
    if (!room)
        return;
    for (const e of entries) {
        if (!e.op)
            continue;
        const msg = JSON.stringify({ type: 'op', seq: e.seq, client: 'server', op: e.op, origin: e.origin, author: e.author });
        for (const p of room.values())
            if (p.ws.readyState === WebSocket.OPEN)
                p.ws.send(msg);
    }
}
/** Tell everyone in a document's room that a proposal was filed or decided. */
export function notifyProposal(file, proposal) {
    const room = rooms.get(file);
    if (!room)
        return;
    const msg = JSON.stringify({ type: 'proposal', file, proposal });
    for (const p of room.values())
        if (p.ws.readyState === WebSocket.OPEN)
            p.ws.send(msg);
}
/** The companion re-checked a document: open sessions refresh their brief. */
export function notifyCompanion(file, payload) {
    const room = rooms.get(file);
    if (!room)
        return;
    const msg = JSON.stringify({ type: 'companion', file, ...payload });
    for (const p of room.values())
        if (p.ws.readyState === WebSocket.OPEN)
            p.ws.send(msg);
}
/** A job of the document changed state (queued, running, done, failed, stopped, superseded, interrupted). */
export function notifyJob(file, payload) {
    const room = rooms.get(file);
    if (!room)
        return;
    const msg = JSON.stringify({ type: 'job', file, job: payload });
    for (const p of room.values())
        if (p.ws.readyState === WebSocket.OPEN)
            p.ws.send(msg);
}
export function notifySaved(file, byClient) {
    const room = rooms.get(file);
    if (!room)
        return;
    const msg = JSON.stringify({ type: 'reload', file });
    for (const p of room.values())
        if (p.id !== byClient && p.ws.readyState === WebSocket.OPEN)
            p.ws.send(msg);
}
export function roomCount() {
    return rooms.size;
}
