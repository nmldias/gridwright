// Intake over HTTP: material brought in, profiled, sanitised and related before it is placed —
// the inbox listed on request, a file, a pasted text or a read-only query result profiled, a
// profile read back with its original, and placement as the person decided (through the log,
// then the source record, the checks and the first reading).

import type { Express } from 'express';
import { brief as companionBrief } from '../companion.js';
import { IntakeRequestSchema, PlacementSchema } from '../contracts.js';
import { identityOf } from '../identity.js';
import { applyIntake, declineIntake, inboxRoot, inboxTaken, intake, intakeFromInbox, intakeQuery, listInbox, listProfiles, originalPath, readingOf, readProfile, MAX_INTAKE_BYTES } from '../intake.js';
import { ImportBusy } from '../parsepool.js';
import { heldReason } from '../sources.js';
import { broadcastEntries, notifyCompanion } from '../multiplayer.js';
import { SqlRefused, authorizeQuery, canSeeConnection } from '../sqlpolicy.js';
import type { StoredConnection } from '../storage.js';
import { authorOf, body, docPermission, fail, noAgent, requireRole } from './common.js';

export function registerIntakeRoutes(app: Express) {
  app.get('/api/inbox', (req, res) => {
    // accounts mode: the caller's client's own folder inside the inbox
    const tenant = identityOf(req).tenant;
    const root = inboxRoot(tenant);
    res.json({ configured: !!root, mode: root ? 'manual: files in GRIDWRIGHT_INBOX are listed on request, never watched' : 'not configured (set GRIDWRIGHT_INBOX to a directory)', files: root ? listInbox(tenant) : [] });
  });
  app.get('/api/files/:id/intake', (req, res) => {
    if (!docPermission(req, res, 'view')) return;
    // ?pending=1: the decisions still open — profiles neither placed nor declined, with the reason a refresh was held
    const all = listProfiles(req.params.id);
    const pending = req.query.pending === '1';
    const list = (pending ? all.filter((p) => p.status === 'profiled') : all).map((p) => ({ ...p, held: heldReason(req.params.id, p.key) ?? undefined }));
    res.json(pending ? list.map((p) => ({ ...p, sets: p.sets.map((x) => ({ ...x, rows: x.rows.slice(0, 21) })) })) : list);
  });
  // a person's "not now": the profile stays on record (the original kept) and is not offered again
  app.post('/api/files/:id/intake/:key/decline', requireRole('editor'), (req, res) => {
    if (!docPermission(req, res, 'edit') || !noAgent(req, res)) return;
    try {
      res.json(declineIntake(req.params.id, authorOf(req), req.params.key));
    } catch (e) {
      fail(res, e);
    }
  });
  // profile a file (base64 or text), a file from the inbox, or a read-only query result; nothing is placed
  app.post('/api/files/:id/intake', requireRole('editor'), async (req, res) => {
    if (!docPermission(req, res, 'sign')) return;
    const b = body(IntakeRequestSchema, req, res);
    if (!b) return;
    const who = identityOf(req);
    try {
      if ('inbox' in b) return res.json(await intakeFromInbox(req.params.id, authorOf(req), b.inbox));
      if ('connection' in b) {
        const p = await intakeQuery(req.params.id, authorOf(req), b.connection, b.sql, { visible: (c) => canSeeConnection(c as StoredConnection, who), authorize: (c, sql) => authorizeQuery(c as StoredConnection, who, sql) });
        return res.json(p);
      }
      if (typeof b.base64 === 'string' && b.base64.length > (MAX_INTAKE_BYTES * 4) / 3 + 4) return res.status(413).json({ error: `the file is larger than ${Math.round(MAX_INTAKE_BYTES / 1024 / 1024)} MB` });
      res.json(await intake(req.params.id, authorOf(req), { name: b.name ?? 'pasted.txt', base64: b.base64, text: b.text, origin: who.agent ? 'agent' : 'user' }));
    } catch (e) {
      fail(res, e, e instanceof SqlRefused ? e.status : e instanceof ImportBusy ? 429 : 400);
    }
  });
  app.get('/api/files/:id/intake/:key', (req, res) => {
    if (!docPermission(req, res, 'view')) return;
    const p = readProfile(req.params.id, req.params.key);
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json({ ...p, held: heldReason(req.params.id, p.key) ?? undefined, sets: p.sets.map((x) => ({ ...x, rows: x.rows.slice(0, 21) })) });
  });
  app.get('/api/files/:id/intake/:key/original', (req, res) => {
    if (!docPermission(req, res, 'view')) return;
    const path = originalPath(req.params.id, req.params.key);
    const p = readProfile(req.params.id, req.params.key);
    if (!path || !p) return res.status(404).json({ error: 'not found' });
    res.setHeader('content-disposition', `attachment; filename="${p.name.replace(/[^\w.-]+/g, '_')}"`);
    res.sendFile(path);
  });
  // place it as the person decided: through the log, then the source record, the checks and the first reading
  app.post('/api/files/:id/intake/:key/apply', requireRole('editor'), (req, res) => {
    if (!docPermission(req, res, 'edit') || !noAgent(req, res)) return;
    const b = body(PlacementSchema, req, res);
    if (!b) return;
    try {
      const p = applyIntake(req.params.id, authorOf(req), req.params.key, { decisions: b.decisions, period: b.period }, (entries) => broadcastEntries(req.params.id, entries));
      if (p.origin === 'inbox') inboxTaken(p.name, p.key, req.params.id);
      notifyCompanion(req.params.id, { attention: companionBrief(req.params.id).health.attention });
      const readings = (p.applied?.tables ?? []).map((t) => readingOf(req.params.id, t.table)).filter(Boolean);
      res.json({ ...p, sets: p.sets.map((x) => ({ ...x, rows: [] })), readings });
    } catch (e) {
      fail(res, e);
    }
  });
  app.get('/api/files/:id/reading/:table', (req, res) => {
    if (!docPermission(req, res, 'view')) return;
    try {
      const r = readingOf(req.params.id, Number(req.params.table));
      if (!r) return res.status(404).json({ error: 'no reading' });
      res.json(r);
    } catch (e) {
      fail(res, e);
    }
  });
}
