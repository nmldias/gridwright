// Investigations over HTTP: generated code against the live document in the cell sandbox (nothing
// written, the run kept as evidence), the stack's status, and a bounded investigation started,
// stopped or read — a separate process acting for the requester, which may propose, not ratify.

import type { Express } from 'express';
import { brief as companionBrief, findIssue, getInvestigation } from '../companion.js';
import { InvestigateSchema, RunRequestSchema } from '../contracts.js';
import { canRunPython } from '../execpolicy.js';
import { identityOf } from '../identity.js';
import { cancelInvestigation, probeStack, runCodeForDocument, stackStatus, startInvestigationProcess } from '../investigate.js';
import { cancelJob, getJob, listJobs, workerStatus } from '../jobs.js';
import type { JobStatus } from '../store.js';
import { notifyCompanion } from '../multiplayer.js';
import { authorOf, body, docPermission, fail, noAgent, requireRole } from './common.js';

export function registerInvestigationRoutes(app: Express, ctx: { token: string; selfUrl: () => string }) {
  app.post('/api/files/:id/companion/run', requireRole('editor'), async (req, res) => {
    if (!docPermission(req, res, 'view')) return;
    const who = identityOf(req);
    if (!canRunPython(who)) return res.status(403).json({ error: 'running code on the server is not permitted for your login (GRIDWRIGHT_PYTHON_USERS)' });
    const b = body(RunRequestSchema, req, res);
    if (!b) return;
    try {
      const r = await runCodeForDocument(req.params.id, authorOf(req), { code: b.code, purpose: b.purpose, investigation: b.investigation });
      if (r.busy) return res.status(429).json(r);
      res.json(r);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get('/api/investigation', (_req, res) => res.json(stackStatus()));
  app.post('/api/investigation/probe', requireRole('admin'), async (_req, res) => res.json(await probeStack(true)));
  app.post('/api/files/:id/companion/investigate', requireRole('editor'), (req, res) => {
    if (!docPermission(req, res, 'view') || !noAgent(req, res)) return;
    const b = body(InvestigateSchema, req, res);
    if (!b) return;
    const who = identityOf(req);
    try {
      const issue = b.issue ? findIssue(req.params.id, b.issue) : null;
      const question = (b.question ?? (issue ? `Investigate: ${issue.issue.summary}` : '')).trim();
      const inv = startInvestigationProcess(req.params.id, who, authorOf(req), { question, issue: issue?.issue.id, thread: b.thread }, ctx.selfUrl(), ctx.token);
      notifyCompanion(req.params.id, { attention: companionBrief(req.params.id).health.attention });
      res.json(inv);
    } catch (e) {
      fail(res, e);
    }
  });
  app.post('/api/files/:id/companion/investigations/:iid/cancel', requireRole('editor'), (req, res) => {
    if (!docPermission(req, res, 'view') || !noAgent(req, res)) return;
    try {
      const inv = cancelInvestigation(req.params.id, req.params.iid, authorOf(req));
      notifyCompanion(req.params.id, { attention: companionBrief(req.params.id).health.attention });
      res.json(inv);
    } catch (e) {
      fail(res, e);
    }
  });
  app.get('/api/files/:id/companion/investigations/:iid', (req, res) => {
    if (!docPermission(req, res, 'view')) return;
    const inv = getInvestigation(req.params.id, req.params.iid);
    if (!inv) return res.status(404).json({ error: 'not found' });
    res.json(inv);
  });
  // jobs: every piece of background work on a document — identity, input versions, status, attempt, limit, result reference
  app.get('/api/files/:id/jobs', (req, res) => {
    if (!docPermission(req, res, 'view')) return;
    const status = typeof req.query.status === 'string' ? (req.query.status.split(',').filter(Boolean) as JobStatus[]) : undefined;
    res.json({ worker: workerStatus(), jobs: listJobs({ doc: req.params.id, status, limit: Number(req.query.limit ?? 50) }) });
  });
  app.get('/api/files/:id/jobs/:jid', (req, res) => {
    if (!docPermission(req, res, 'view')) return;
    const job = getJob(req.params.jid);
    if (!job || job.doc !== req.params.id) return res.status(404).json({ error: 'not found' });
    res.json(job);
  });
  app.post('/api/files/:id/jobs/:jid/cancel', requireRole('editor'), (req, res) => {
    if (!docPermission(req, res, 'view') || !noAgent(req, res)) return;
    const job = getJob(req.params.jid);
    if (!job || job.doc !== req.params.id) return res.status(404).json({ error: 'not found' });
    // an investigation's record is stopped through its own path so that its proposals are set aside
    if (job.type === 'investigation' && typeof job.input.investigation === 'string') {
      try {
        cancelInvestigation(req.params.id, job.input.investigation, authorOf(req));
      } catch (e) {
        return fail(res, e);
      }
    } else cancelJob(job.id, authorOf(req));
    notifyCompanion(req.params.id, { attention: companionBrief(req.params.id).health.attention });
    res.json(getJob(job.id));
  });
}
