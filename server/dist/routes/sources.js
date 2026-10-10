// Sources over HTTP: the definitions a document's SQL snapshots made (connection, query, the table
// they feed, the recipe in force, the bookkeeping of refreshes), their recipe and dataset versions,
// a refresh on request (a job under the requester's own permissions — nothing is scheduled), and
// enabling or disabling one.
import { brief as companionBrief } from '../companion.js';
import { identityOf } from '../identity.js';
import { notifyCompanion } from '../multiplayer.js';
import { getSourceDef, listSourcesOf, recipesOf, requestRefresh, setSourceEnabled, versionsOf } from '../sources.js';
import { authorOf, docPermission, fail, noAgent, requireRole } from './common.js';
export function registerSourceRoutes(app) {
    app.get('/api/files/:id/sources', (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        try {
            res.json(listSourcesOf(req.params.id));
        }
        catch (e) {
            fail(res, e);
        }
    });
    app.get('/api/files/:id/sources/:sid', (req, res) => {
        if (!docPermission(req, res, 'view'))
            return;
        const src = getSourceDef(req.params.sid);
        if (!src || src.doc !== req.params.id)
            return res.status(404).json({ error: 'not found' });
        const recipes = recipesOf(src.id);
        res.json({ ...src, recipeVersion: recipes.find((r) => r.id === src.recipe)?.version, recipes, versions: versionsOf(src.id) });
    });
    // a refresh on request: the query runs again, the recipe is applied, the result reconciled — placed when every check passes, held otherwise
    app.post('/api/files/:id/sources/:sid/refresh', requireRole('editor'), (req, res) => {
        if (!docPermission(req, res, 'edit') || !noAgent(req, res))
            return;
        const who = identityOf(req);
        try {
            const job = requestRefresh(req.params.id, req.params.sid, authorOf(req), { login: who.login, name: who.name });
            res.json(job);
        }
        catch (e) {
            fail(res, e);
        }
    });
    app.put('/api/files/:id/sources/:sid', requireRole('editor'), (req, res) => {
        if (!docPermission(req, res, 'edit') || !noAgent(req, res))
            return;
        try {
            const src = setSourceEnabled(req.params.id, req.params.sid, req.body?.enabled !== false);
            notifyCompanion(req.params.id, { attention: companionBrief(req.params.id).health.attention });
            res.json(src);
        }
        catch (e) {
            fail(res, e);
        }
    });
}
