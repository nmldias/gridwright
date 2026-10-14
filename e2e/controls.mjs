#!/usr/bin/env node
// Control gates (the adverse behaviours an external review reproduced on 0.5.2, as tests):
//   1. reviewer isolation — a sign-off-only person cannot change values through any path
//   2. approval integrity — "applied" means the reviewed changes were committed, once, at the revision reviewed
//   3. revocation        — removing access stops a connected session at once
//   4. server checkpoint — a sign-off-only person persists sign-offs without replacing the document
// Runs against a server with identity on (GRIDWRIGHT_TRUST_TAILSCALE=1 GRIDWRIGHT_ADMINS=boss@example.com).
// Usage: node e2e/controls.mjs [http://127.0.0.1:8795]

import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');

const BASE = process.argv[2] ?? 'http://127.0.0.1:8795';
const WS = BASE.replace(/^http/, 'ws');
const who = (login, name) => ({ 'tailscale-user-login': login, 'tailscale-user-name': name ?? login.split('@')[0] });
const ALICE = who('alice@example.com', 'Alice');
const BOB = who('bob@example.com', 'Bob');
const CAROL = who('carol@example.com', 'Carol');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ` — ${detail}` : ''));
};

async function rest(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, json, text };
}

function connect(fileId, client, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/ws?file=${fileId}&client=${client}`, { headers });
    const inbox = [];
    const waiters = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      const w = waiters.findIndex((x) => x.pred(msg));
      if (w >= 0) waiters.splice(w, 1)[0].res(msg);
      else inbox.push(msg);
    });
    let closed = null;
    ws.on('close', (code, reason) => {
      closed = { code, reason: reason.toString() };
      for (const w of waiters.splice(0)) w.res({ type: 'closed', ...closed });
    });
    ws.on('error', (e) => (closed ? undefined : reject(e)));
    ws.on('open', () =>
      resolve({
        ws,
        send: (m) => ws.send(JSON.stringify(m)),
        next: (pred, ms = 4000) =>
          new Promise((res) => {
            const i = inbox.findIndex(pred);
            if (i >= 0) return res(inbox.splice(i, 1)[0]);
            if (closed) return res({ type: 'closed', ...closed });
            const w = { pred, res };
            waiters.push(w);
            setTimeout(() => {
              const k = waiters.indexOf(w);
              if (k >= 0) {
                waiters.splice(k, 1);
                res(null);
              }
            }, ms);
          }),
        isClosed: () => closed,
        close: () => ws.close(),
      }),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cid = 1;
const op = (sock, o, origin = 'user') => {
  const c = `c${cid++}`;
  sock.send({ type: 'op', cid: c, op: o, origin });
  return sock.next((m) => (m.type === 'op' && m.cid === c) || (m.type === 'rejected' && m.cid === c));
};

async function mcp(name, args, headers) {
  const r = await rest('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers);
  const res = r.json?.result ?? {};
  return { error: !!res.isError, text: (res.content ?? []).map((c) => c.text ?? '').join('') };
}

async function main() {
  const health = await rest('GET', '/api/health');
  if (!health.json?.identity) {
    console.log('this server has identity off — the control gates need GRIDWRIGHT_TRUST_TAILSCALE=1');
    process.exit(1);
  }

  // ---------------------------------------------------------------- a document with real content, owned by Alice
  const created = await rest('POST', '/api/files', { name: 'Controls', json: JSON.stringify({ name: 'Controls', tables: [], next_table_id: 1 }), client: 'alice1' }, ALICE);
  const fid = created.json.id;
  await rest('PUT', `/api/files/${fid}/access`, { public: 'none', shares: { 'bob@example.com': 'sign', 'carol@example.com': 'edit' } }, ALICE);
  const alice = await connect(fid, 'alice1', ALICE);
  await alice.next((m) => m.type === 'welcome');
  const add = await op(alice, { type: 'add_table', name: 'T', x: 0, y: 0, rows: 6, cols: 4, values: [['Item', 'Amount'], ['a', '10'], ['b', '20']] });
  check('setup: the owner adds a table through the operation log', add?.type === 'op' && add.seq > 0, JSON.stringify(add).slice(0, 100));
  const readBack = await mcp('read_range', { id: fid, reference: 'T::B2' }, ALICE);
  check('setup: the server sees the live document (checkpoint + log replay)', !readBack.error && readBack.text.includes('10'), readBack.text.slice(0, 80));

  // ---------------------------------------------------------------- gate 1: reviewer isolation
  const doc = await rest('GET', `/api/files/${fid}`, undefined, BOB);
  check('a sign-off share can read the document', doc.status === 200, String(doc.status));
  const bobSave = await rest('PUT', `/api/files/${fid}`, { name: 'Controls', json: JSON.stringify({ name: 'Controls', tables: [{ id: 1, name: 'T', x: 0, y: 0, rows: 6, cols: 4, cells: [[1, 1, { input: '999', kind: 'value', value: { n: 999 } }]] }], next_table_id: 2 }), client: 'bob1' }, BOB);
  check('gate 1: a sign-off-only person cannot replace the document through the save endpoint', bobSave.status === 403, `PUT → ${bobSave.status}`);
  const after = await mcp('read_range', { id: fid, reference: 'T::B2' }, ALICE);
  check('gate 1: the value is unchanged afterwards', after.text.includes('10') && !after.text.includes('999'), after.text.slice(0, 80));
  const bob = await connect(fid, 'bob1', BOB);
  const welcome = await bob.next((m) => m.type === 'welcome');
  check('gate 1: the socket tells a sign-off share its permission', welcome?.you?.permission === 'sign', JSON.stringify(welcome?.you));
  const bobEdit = await op(bob, { type: 'set_cell', table: 1, row: 1, col: 1, input: '999' });
  check('gate 1: a sign-off share cannot change a value over the socket', bobEdit?.type === 'rejected', JSON.stringify(bobEdit).slice(0, 100));
  const bobRestore = await op(bob, { type: 'restore_cells', table: 1, cells: [[1, 1, { input: '999', kind: 'value', value: { n: 999 } }]] });
  check('gate 1: nor restore a version', bobRestore?.type === 'rejected', JSON.stringify(bobRestore).slice(0, 100));
  bob.send({ type: 'snapshot', cid: 'snap1', json: JSON.stringify({ name: 'Controls', tables: [], next_table_id: 1 }) });
  const snapAck = await bob.next((m) => m.type === 'ack' && m.cid === 'snap1', 1500);
  check('gate 1: nor push a document snapshot', snapAck === null, snapAck ? JSON.stringify(snapAck) : 'ignored');
  const bobSign = await op(bob, { type: 'add_signoff', table: 1, r0: 1, c0: 1, r1: 2, c1: 1, by: 'Bob', login: 'bob@example.com', at: new Date().toISOString(), note: 'Reviewed by Bob', locked: false });
  check('gate 1: a sign-off share can still sign off', bobSign?.type === 'op', JSON.stringify(bobSign).slice(0, 100));
  const stillThere = await mcp('read_range', { id: fid, reference: 'T::B2' }, ALICE);
  check('gate 1: the values are intact after all of that', stillThere.text.includes('10') && !stillThere.text.includes('999'), stillThere.text.slice(0, 80));

  // ---------------------------------------------------------------- gate 4: a sign-off share persists through the server
  const cp = await rest('POST', `/api/files/${fid}/checkpoint`, { client: 'bob1' }, BOB);
  const stored = await rest('GET', `/api/files/${fid}`, undefined, ALICE);
  check('gate 4: a sign-off share can ask the server to checkpoint (built from the log, not from the client)', cp.status === 200 && cp.json?.seq > 0 && stored.json?.json?.includes('Reviewed by Bob'), `POST checkpoint → ${cp.status} ${cp.text.slice(0, 80)}`);

  // ---------------------------------------------------------------- gate 2: approval integrity
  const filed = await mcp('propose_edit', { id: fid, title: 'Total', actions: [{ action: 'set_cell', table: 'T', ref: 'C3', input: '=B2+B3' }] }, ALICE);
  const pid = JSON.parse(filed.text).proposal;
  const p0 = (await rest('GET', `/api/files/${fid}/proposals/${pid}`, undefined, ALICE)).json;
  const stale = await rest('POST', `/api/files/${fid}/proposals/${pid}/decide`, { decision: 'applied', seq: (p0.seq ?? 1) - 1, client: 'alice1' }, ALICE);
  check('gate 2: a decision against the wrong revision is refused', stale.status === 409, `decide(seq-1) → ${stale.status} ${stale.text.slice(0, 80)}`);
  const applied = await rest('POST', `/api/files/${fid}/proposals/${pid}/decide`, { decision: 'applied', seq: p0.seq, client: 'alice1', command: 'cmd-1' }, ALICE);
  const value = await mcp('read_range', { id: fid, reference: 'T::C3' }, ALICE);
  check('gate 2: "applied" means the change is in the document the server holds', applied.status === 200 && applied.json?.status === 'applied' && value.text.includes('30'), `decide → ${applied.status}; C3 = ${value.text.slice(0, 60)}`);
  const hist = (await rest('GET', `/api/files/${fid}/history?limit=20`, undefined, ALICE)).json?.entries ?? [];
  const committed = hist.find((e) => e.origin === 'agent' && e.op?.type === 'set_cell' && e.op?.input === '=B2+B3');
  check('gate 2: the committed operation and the decision are both in the log, attributed', !!committed && committed.author?.login === 'alice@example.com' && hist.some((e) => (e.note ?? '').includes(`proposal ${pid} applied`)), committed ? `seq ${committed.seq}` : 'no agent op logged');
  const relayed = await alice.next((m) => m.type === 'op' && m.op?.type === 'set_cell' && m.op?.input === '=B2+B3', 3000);
  check('gate 2: connected editors receive the committed change as an ordinary operation', relayed?.origin === 'agent', relayed ? `seq ${relayed.seq}` : 'nothing received');
  const again = await rest('POST', `/api/files/${fid}/proposals/${pid}/decide`, { decision: 'applied', seq: p0.seq, client: 'alice1', command: 'cmd-1' }, ALICE);
  const dup = await rest('POST', `/api/files/${fid}/proposals/${pid}/decide`, { decision: 'applied', seq: p0.seq, client: 'alice1' }, ALICE);
  const count = (await rest('GET', `/api/files/${fid}/history?limit=50`, undefined, ALICE)).json.entries.filter((e) => e.op?.input === '=B2+B3').length;
  check('gate 2: repeating the command does not apply twice (same command → same receipt; a new one → refused)', again.status === 200 && again.json?.appliedSeq === applied.json?.appliedSeq && dup.status === 400 && count === 1, `repeat → ${again.status}, duplicate → ${dup.status}, ops logged: ${count}`);
  // drift: the document changes under a pending proposal in a way that alters what was reviewed
  const filed2 = await mcp('propose_edit', { id: fid, title: 'Set B2', actions: [{ action: 'set_cell', table: 'T', ref: 'B2', input: '100' }] }, ALICE);
  const pid2 = JSON.parse(filed2.text).proposal;
  const p2 = (await rest('GET', `/api/files/${fid}/proposals/${pid2}`, undefined, ALICE)).json;
  await op(alice, { type: 'set_cell', table: 1, row: 1, col: 1, input: '15' });
  const drifted = await rest('POST', `/api/files/${fid}/proposals/${pid2}/decide`, { decision: 'applied', seq: p2.seq, client: 'alice1' }, ALICE);
  const fresh = drifted.json?.proposal;
  check('gate 2: a change under a pending proposal yields a fresh preview, not silent acceptance', drifted.status === 409 && fresh?.seq > p2.seq && JSON.stringify(fresh?.preview ?? []).includes('15'), `decide → ${drifted.status} ${drifted.text.slice(0, 100)}`);
  const confirmed = await rest('POST', `/api/files/${fid}/proposals/${pid2}/decide`, { decision: 'applied', seq: fresh?.seq, client: 'alice1' }, ALICE);
  const b2 = await mcp('read_range', { id: fid, reference: 'T::B2' }, ALICE);
  check('gate 2: confirming against the fresh revision applies it', confirmed.status === 200 && b2.text.includes('100'), `decide → ${confirmed.status}; B2 = ${b2.text.slice(0, 40)}`);
  const bobDecide = await rest('POST', `/api/files/${fid}/proposals/${pid2}/decide`, { decision: 'rejected', seq: fresh?.seq, client: 'bob1' }, BOB);
  check('gate 2: a sign-off share cannot decide proposals', bobDecide.status === 403 || bobDecide.status === 400, `→ ${bobDecide.status}`);

  // ---------------------------------------------------------------- gate 3: revocation
  const carol = await connect(fid, 'carol1', CAROL);
  await carol.next((m) => m.type === 'welcome');
  const carolEdit = await op(carol, { type: 'set_cell', table: 1, row: 4, col: 0, input: 'by carol' });
  check('setup: an editor share edits over the socket', carolEdit?.type === 'op', JSON.stringify(carolEdit).slice(0, 80));
  await rest('PUT', `/api/files/${fid}/access`, { shares: { 'bob@example.com': 'sign', 'carol@example.com': 'view' } }, ALICE);
  const downgraded = await carol.next((m) => m.type === 'permission', 3000);
  const carolEdit2 = await op(carol, { type: 'set_cell', table: 1, row: 4, col: 1, input: 'after downgrade' });
  check('gate 3: downgrading a connected editor to view reaches the session and stops its edits', downgraded?.permission === 'view' && carolEdit2?.type === 'rejected', `${JSON.stringify(downgraded)} / ${JSON.stringify(carolEdit2).slice(0, 60)}`);
  await rest('PUT', `/api/files/${fid}/access`, { shares: { 'bob@example.com': 'sign' } }, ALICE);
  const revoked = await carol.next((m) => m.type === 'revoked' || m.type === 'closed', 3000);
  await sleep(300);
  const carolGet = await rest('GET', `/api/files/${fid}`, undefined, CAROL);
  check('gate 3: removing access closes the connected session and the document is gone for that person', (revoked?.type === 'revoked' || revoked?.type === 'closed') && !!carol.isClosed() && carolGet.status === 404, `${JSON.stringify(revoked)} closed=${!!carol.isClosed()} GET → ${carolGet.status}`);
  let reconnect = 'open';
  try {
    const again2 = await connect(fid, 'carol2', CAROL);
    const w = await again2.next((m) => m.type === 'welcome' || m.type === 'closed', 2000);
    reconnect = w?.type ?? 'nothing';
    again2.close();
  } catch (e) {
    reconnect = 'refused';
  }
  check('gate 3: a new connection after revocation is refused', reconnect !== 'welcome', reconnect);
  const notThere = await mcp('read_range', { id: fid, reference: 'T::B5' }, ALICE);
  check('gate 3: the edit attempted after the downgrade never reached the document', !notThere.text.includes('after downgrade'), notThere.text.slice(0, 60));

  // ---------------------------------------------------------------- execution permissions (GRIDWRIGHT_PYTHON_USERS / GRIDWRIGHT_GPU_USERS)
  const py = await rest('GET', '/api/python', undefined, ALICE);
  if (py.json?.available && py.json?.policy?.pythonUsers !== 'all editors') {
    const bobRun = await rest('POST', '/api/python/run', { code: '1', snapshot: { tables: [], current: { table: 0, row: 0, col: 0 } } }, BOB);
    const aliceRun = await rest('POST', '/api/python/run', { code: '1', snapshot: { tables: [], current: { table: 0, row: 0, col: 0 } } }, ALICE);
    const aliceGpu = await rest('POST', '/api/python/run', { code: '1', snapshot: { tables: [], current: { table: 0, row: 0, col: 0 } }, gpu: true }, ALICE);
    check('execution permission: editing a workbook does not grant server-side code execution', bobRun.status === 403 && aliceRun.status === 200 && py.json.can?.run === true, `bob → ${bobRun.status}, alice → ${aliceRun.status}`);
    check('execution permission: GPU time is a separate permission', aliceGpu.status === 403, `alice gpu → ${aliceGpu.status}`);
  } else {
    console.log('SKIP execution permissions (start the server with GRIDWRIGHT_PYTHON_USERS=alice@example.com GRIDWRIGHT_GPU_USERS=boss@example.com)');
  }

  alice.close();
  bob.close();
  await rest('DELETE', `/api/files/${fid}`, undefined, ALICE);
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
