// Documents over HTTP: the list a person may see, a document with its permission, creation and
// whole-document replacement (an edit), a checkpoint built from the log (how a sign-off share
// persists), deletion with everything a document owns, sharing and folders, the audit trail, and
// proposals — agent edits awaiting a person's decision, committed once against an expected revision.
import { canManage, canView, deleteAccess, normalise, permissionFor, readAccess, tenantOf, writeAccess } from '../access.js';
import { brief as companionBrief, deleteCompanion, recordRejection } from '../companion.js';
import { errorMessage, openDocument } from '../headless.js';
import { appendEntry, checkpointSeqs, compactCheckpoints, currentSeq, deleteHistory, historyCsv, opTouchesCell, readAll, recentEntries, replayBundle, writeCheckpoint } from '../history.js';
import { identityEnabled, identityOf } from '../identity.js';
import { deleteIntake } from '../intake.js';
import { accessChanged, broadcastEntries, notifyCompanion, notifyProposal as notifyProposalRoom, notifySaved } from '../multiplayer.js';
import { createProposal, decideProposal, getProposal, listProposals, ProposalConflict, refreshProposal } from '../proposals.js';
import { deleteFile, listFiles, readFile, writeFile } from '../storage.js';
import { theStore } from '../store.js';
import { deleteCellWork } from '../investigate.js';
import { clearConversation, deleteConversationsOf, readConversation, writeConversation } from '../conversations.js';
import { ConversationSchema } from '../contracts.js';
import { ACCOUNTS, getTenant, isMember } from '../tenancy.js';
import { body, docPermission, fail, noAgent, requireRole } from './common.js';
export function registerDocumentRoutes(app, ctx) {
    const DEFAULT_SHARING = ctx.defaultSharing;
    app.get('/api/files', (req, res) => {
        const id = identityOf(req);
        const out = [];
        // access first (the small metadata file): a document the caller may not see is never read
        const seen = new Map();
        const files = listFiles((fid) => {
            const access = readAccess(fid);
            const permission = permissionFor(access, id);
            if (!canView(permission))
                return false;
            seen.set(fid, { access, permission });
            return true;
        });
        for (const f of files) {
            const { access, permission } = seen.get(f.id);
            out.push({ ...f, folder: access.folder, owner: access.owner, ownerName: access.ownerName, public: access.public, shared: Object.keys(access.shares).length, permission });
        }
        res.json(out);
    });
    app.get('/api/files/:id', (req, res) => {
        const p = docPermission(req, res, 'view');
        if (!p)
            return;
        const f = readFile(req.params.id);
        res.json({ ...f, seq: currentSeq(req.params.id), permission: p.permission, folder: p.access.folder });
    });
    app.post('/api/files', requireRole('editor'), (req, res) => {
        try {
            const { name, json, client, folder } = req.body ?? {};
            if (typeof json !== 'string')
                return res.status(400).json({ error: 'json (string) required' });
            const meta = writeFile(null, String(name || 'Untitled').slice(0, 120), json);
            const id = identityOf(req);
            if (ACCOUNTS && !id.tenant)
                return res.status(403).json({ error: 'no client selected' });
            // with identity on, the creator owns the document (open to everyone on the server — with
            // accounts: everyone in the client — until restricted); with accounts it belongs to the client
            writeAccess(meta.id, normalise({ owner: identityEnabled ? id.login : '', ownerName: id.name || undefined, public: DEFAULT_SHARING, shares: {}, folder: typeof folder === 'string' ? folder : '', tenant: ACCOUNTS ? id.tenant : undefined }));
            const seq = appendEntry(meta.id, { author: { id: typeof client === 'string' ? client : 'api', name: id.name || 'Guest', login: id.login || undefined }, origin: 'user', checkpoint: true, note: 'created' });
            writeCheckpoint(meta.id, seq, json);
            res.json({ ...meta, seq, permission: 'own' });
        }
        catch (e) {
            res.status(400).json({ error: errorMessage(e) });
        }
    });
    // whole-document replacement is an edit: a sign-off share persists through /checkpoint instead
    app.put('/api/files/:id', requireRole('editor'), (req, res) => {
        try {
            const p = docPermission(req, res, 'edit');
            if (!p)
                return;
            const { name, json, client, seq } = req.body ?? {};
            if (typeof json !== 'string')
                return res.status(400).json({ error: 'json (string) required' });
            const meta = writeFile(req.params.id, String(name || 'Untitled').slice(0, 120), json);
            // checkpoint the saved state at the log position the client had applied (falls back to the current seq)
            const at = Number.isFinite(Number(seq)) && Number(seq) > 0 ? Number(seq) : currentSeq(req.params.id);
            if (!checkpointSeqs(req.params.id).includes(at)) {
                if (at === 0) {
                    const id = identityOf(req);
                    const s = appendEntry(req.params.id, { author: { id: typeof client === 'string' ? client : 'api', name: id.name || 'Guest', login: id.login || undefined }, origin: 'user', checkpoint: true, note: 'saved' });
                    writeCheckpoint(req.params.id, s, json);
                }
                else {
                    writeCheckpoint(req.params.id, at, json);
                }
            }
            notifySaved(req.params.id, typeof client === 'string' ? client : undefined);
            res.json({ ...meta, seq: currentSeq(req.params.id) });
        }
        catch (e) {
            res.status(400).json({ error: errorMessage(e) });
        }
    });
    // a checkpoint built by the server from the log (latest checkpoint + every operation since): the
    // way a sign-off share — or anyone — persists the current state without sending a document
    app.post('/api/files/:id/checkpoint', requireRole('editor'), (req, res) => {
        const p = docPermission(req, res, 'sign');
        if (!p)
            return;
        try {
            const { book, name, json, seq } = openDocument(req.params.id);
            book.free();
            const id = identityOf(req);
            const client = typeof req.body?.client === 'string' ? req.body.client : 'api';
            writeFile(req.params.id, name, json);
            let at = seq;
            if (!checkpointSeqs(req.params.id).includes(at)) {
                at = appendEntry(req.params.id, { author: { id: client, name: id.name || 'Guest', login: id.login || undefined }, origin: 'user', checkpoint: true, note: 'checkpoint' });
                writeCheckpoint(req.params.id, at, json);
            }
            notifySaved(req.params.id, client);
            res.json({ id: req.params.id, seq: at });
        }
        catch (e) {
            res.status(400).json({ error: errorMessage(e) });
        }
    });
    app.delete('/api/files/:id', requireRole('editor'), (req, res) => {
        const p = docPermission(req, res, 'own');
        if (!p)
            return;
        if (!deleteFile(req.params.id))
            return res.status(404).json({ error: 'not found' });
        deleteHistory(req.params.id);
        deleteAccess(req.params.id);
        deleteCompanion(req.params.id);
        deleteIntake(req.params.id);
        deleteConversationsOf(req.params.id);
        theStore().deleteSourcesOf(req.params.id);
        deleteCellWork(req.params.id);
        res.json({ ok: true });
    });
    // the conversation with the assistant: the caller's own transcript on this document, owned by the server
    app.get('/api/files/:id/conversation', (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        res.json(readConversation(req.params.id, identityOf(req).login || ''));
    });
    app.put('/api/files/:id/conversation', (req, res) => {
        if (!docPermission(req, res, 'view') || !noAgent(req, res))
            return;
        const b = body(ConversationSchema, req, res);
        if (!b)
            return;
        try {
            res.json(writeConversation(req.params.id, identityOf(req).login || '', b.messages));
        }
        catch (e) {
            fail(res, e);
        }
    });
    app.delete('/api/files/:id/conversation', (req, res) => {
        if (!docPermission(req, res, 'view') || !noAgent(req, res))
            return;
        clearConversation(req.params.id, identityOf(req).login || '');
        res.json({ ok: true });
    });
    // sharing & folders: {public, shares, folder}; folder alone may be changed by editors
    app.get('/api/files/:id/access', (req, res) => {
        const p = docPermission(req, res, 'view');
        if (!p)
            return;
        res.json({ ...p.access, permission: p.permission, identity: identityEnabled, ...clientOf(p.access) });
    });
    app.put('/api/files/:id/access', requireRole('editor'), (req, res) => {
        const p = docPermission(req, res, 'edit');
        if (!p)
            return;
        const b = req.body ?? {};
        const next = { ...p.access };
        if (typeof b.folder === 'string')
            next.folder = b.folder;
        const managing = b.public !== undefined || b.shares !== undefined || b.owner !== undefined;
        if (managing) {
            if (!canManage(p.permission))
                return res.status(403).json({ error: 'only the owner can change sharing' });
            if (b.public !== undefined)
                next.public = b.public;
            if (b.shares !== undefined && typeof b.shares === 'object')
                next.shares = b.shares;
            if (typeof b.owner === 'string') {
                next.owner = b.owner;
                next.ownerName = typeof b.ownerName === 'string' ? b.ownerName : undefined;
            }
        }
        const saved = normalise(next);
        if (ACCOUNTS) {
            // a document is shared within its client only: every name must be a member there
            const tenant = tenantOf(p.access);
            const outsiders = Object.keys(saved.shares).filter((login) => !isMember(tenant, login));
            if (saved.owner && !isMember(tenant, saved.owner))
                outsiders.push(saved.owner);
            if (outsiders.length)
                return res.status(400).json({ error: `not a member of this client: ${outsiders.join(', ')} — an administrator adds people to the client first` });
            saved.tenant = p.access.tenant;
        }
        writeAccess(req.params.id, saved);
        accessChanged(req.params.id); // connected sessions are downgraded or closed at once
        res.json({ ...saved, permission: permissionFor(saved, identityOf(req)), identity: identityEnabled, ...clientOf(saved) });
    });
    /** accounts mode: the client a document belongs to, for the Share panel ("everyone in …") */
    const clientOf = (a) => {
        if (!ACCOUNTS)
            return {};
        const t = getTenant(tenantOf(a));
        return { client: t ? { id: t.id, name: t.name, slug: t.slug } : undefined };
    };
    // --- history (audit trail) ---------------------------------------------------------------
    app.get('/api/files/:id/history', (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
        const before = req.query.before ? Number(req.query.before) : undefined;
        res.json({ seq: currentSeq(req.params.id), entries: recentEntries(req.params.id, limit, before) });
    });
    app.get('/api/files/:id/history.csv', (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        const name = (readFile(req.params.id)?.name ?? req.params.id).replace(/[^\w.-]+/g, '_');
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="${name}-audit.csv"`);
        res.send('\ufeff' + historyCsv(req.params.id));
    });
    app.get('/api/files/:id/history/cell', (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        const table = Number(req.query.table);
        const row = Number(req.query.row);
        const col = Number(req.query.col);
        if (![table, row, col].every(Number.isFinite))
            return res.status(400).json({ error: 'table, row, col required' });
        const entries = readAll(req.params.id)
            .filter((e) => e.op && opTouchesCell(e.op, table, row, col))
            .slice(-100)
            .reverse();
        res.json({ entries });
    });
    app.get('/api/files/:id/history/replay', (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        const seq = Number(req.query.seq);
        if (!Number.isFinite(seq))
            return res.status(400).json({ error: 'seq required' });
        const bundle = replayBundle(req.params.id, seq);
        if (!bundle)
            return res.status(404).json({ error: 'no history' });
        res.json(bundle);
    });
    app.post('/api/files/:id/history/compact', requireRole('admin'), (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        res.json({ dropped: compactCheckpoints(req.params.id), kept: checkpointSeqs(req.params.id) });
    });
    // --- proposals (agent edits awaiting a person's decision) ----------------------------------
    app.get('/api/files/:id/proposals', (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        const status = req.query.status === 'pending' || req.query.status === 'applied' || req.query.status === 'rejected' ? req.query.status : undefined;
        res.json(listProposals(req.params.id, status));
    });
    app.get('/api/files/:id/proposals/:pid', (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        const p = getProposal(req.params.id, req.params.pid);
        if (!p)
            return res.status(404).json({ error: 'not found' });
        res.json(p);
    });
    // anyone who may edit can file a proposal too (e.g. the assistant acting on someone's behalf)
    app.post('/api/files/:id/proposals', requireRole('editor'), (req, res) => {
        if (!docPermission(req, res, 'edit'))
            return;
        try {
            const id = identityOf(req);
            const b = req.body ?? {};
            const actions = Array.isArray(b.actions) ? b.actions : [];
            const p = createProposal(req.params.id, { id: typeof b.client === 'string' ? b.client : 'api', name: id.name || 'Guest', login: id.login || undefined }, String(b.agent ?? 'api').slice(0, 60), String(b.title ?? 'Proposal'), String(b.rationale ?? ''), actions, currentSeq(req.params.id));
            notifyProposalRoom(req.params.id, p);
            res.json(p);
        }
        catch (e) {
            res.status(400).json({ error: errorMessage(e) });
        }
    });
    // the decision is a server-side commit: expected revision, exact operations and decision together, once
    app.post('/api/files/:id/proposals/:pid/decide', requireRole('editor'), (req, res) => {
        if (!docPermission(req, res, 'edit') || !noAgent(req, res))
            return;
        try {
            const id = identityOf(req);
            const b = req.body ?? {};
            const decision = b.decision === 'applied' ? 'applied' : b.decision === 'rejected' ? 'rejected' : null;
            if (!decision)
                return res.status(400).json({ error: 'decision must be applied or rejected' });
            const { proposal, committed } = decideProposal(req.params.id, req.params.pid, decision, { id: typeof b.client === 'string' ? b.client : 'api', name: id.name || 'Guest', login: id.login || undefined }, typeof b.note === 'string' ? b.note : undefined, Number.isFinite(Number(b.seq)) ? Number(b.seq) : undefined, typeof b.command === 'string' ? b.command : undefined);
            if (committed.length)
                broadcastEntries(req.params.id, committed);
            if (decision === 'rejected' && recordRejection(req.params.id, { id: typeof b.client === 'string' ? b.client : 'api', name: id.name || 'Guest', login: id.login || undefined }, { id: proposal.id, title: proposal.title, agent: proposal.agent, note: proposal.decisionNote }))
                notifyCompanion(req.params.id, { attention: companionBrief(req.params.id).health.attention });
            notifyProposalRoom(req.params.id, proposal);
            res.json(proposal);
        }
        catch (e) {
            if (e instanceof ProposalConflict) {
                notifyProposalRoom(req.params.id, e.proposal);
                return res.status(409).json({ error: e.message, proposal: e.proposal });
            }
            res.status(400).json({ error: errorMessage(e) });
        }
    });
    // a fresh preview of a pending proposal against the document as it is now
    app.post('/api/files/:id/proposals/:pid/refresh', requireRole('editor'), (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        try {
            const p = refreshProposal(req.params.id, req.params.pid);
            notifyProposalRoom(req.params.id, p);
            res.json(p);
        }
        catch (e) {
            res.status(400).json({ error: errorMessage(e) });
        }
    });
}
