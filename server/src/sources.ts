// One structured source → one saved preparation → one reconciled dataset version → one traceable
// table → one repeatable server-side refresh.
//
// A source definition is made the moment a person places a SQL snapshot: the connection, the query,
// the table it feeds, and the preparation the person accepted — the column contract (header, kind
// declared by the database, kind read, unit, identifier or not), the totals-row and header
// decisions, where the period comes from — as recipe version 1. A refresh is a job: the query runs
// again under the requester's own permissions, the result goes through the same intake pipeline,
// the recipe is applied deterministically (a changed shape is drift: held, never placed over the
// table), the candidate is reconciled against what the table holds (period order, identifiers in
// common, coverage) and becomes a dataset version — accepted and placed through the log when every
// check passes, held for a person when one fails, with the checks on it either way. An unchanged
// result establishes current coverage and invents no change. No model is involved.

import { createHash } from 'node:crypto';
import { canEdit, permissionFor, readAccess } from './access.js';
import { comparePeriods, noteEvent } from './companion.js';
import type { Author } from './history.js';
import { identityForLogin } from './identity.js';
import { applyIntake, intakeQuery, setDeclineHook, setPlacementHook, type IntakeProfile, type IntakeSet } from './intake.js';
import { enqueue, kick, registerRunner, type JobOutcome } from './jobs.js';
import { authorizeQuery, canSeeConnection } from './sqlpolicy.js';
import { listConnections, newId, type StoredConnection } from './storage.js';
import { theStore, type DatasetVersion, type RecipeVersion, type SourceDef } from './store.js';

export interface RecipeColumn {
  header: string;
  type: IntakeSet['columns'][number]['type'];
  declared?: string;
  unit?: string;
}
export interface Recipe {
  /** the column contract: every column, in order, with the kind the database declared and the kind read */
  columns: RecipeColumn[];
  headerDetected: boolean;
  totalsRow: boolean;
  period: { from: 'name' | 'column' | 'arrival'; column?: string };
  identifierColumn?: string;
  /** reconciliation rules, stated: identifiers in common at least this share of the smaller set; row count within this share of the previous */
  rules: { minIdentifierOverlap: number; maxCoverageChange: number };
  placement: { series: string; table?: number };
}

const now = () => new Date().toISOString();

function recipeOf(p: IntakeProfile, set: IntakeSet, table: number | undefined, series: string): Recipe {
  const idCol = set.columns.find((c) => c.type === 'identifier');
  const dateCol = p.periodFrom === 'column' ? set.columns.find((c) => c.type === 'date' && c.maxDate === p.period)?.header : undefined;
  return {
    columns: set.columns.map((c) => ({ header: c.header, type: c.type, declared: c.declared, unit: c.unit })),
    headerDetected: set.headerDetected,
    totalsRow: !!set.totalsRow,
    period: { from: p.periodFrom === 'none' ? 'arrival' : p.periodFrom, column: dateCol },
    identifierColumn: idCol?.header,
    rules: { minIdentifierOverlap: 0.3, maxCoverageChange: 0.5 },
    placement: { series, table },
  };
}

const contractOf = (r: Recipe) => r.columns.map((c) => `${c.header.toLowerCase()}:${c.type}:${c.declared ?? ''}`).join('|');

function environment(): Record<string, string> {
  return { server: process.env.npm_package_version ?? '', node: process.versions.node };
}

/**
 * After a person places a SQL snapshot: the source definition and its recipe. The first placement
 * makes version 1; a later placement the person accepted with a different shape makes the next
 * version — a recipe changes only by a person's decision.
 */
export function ensureSourceFromPlacement(p: IntakeProfile, by: Author, placed: { set: string; table: number; name: string; placed: 'new' | 'update' | 'history' }[]): SourceDef | null {
  if (p.origin !== 'sql' || !p.query) return null;
  const connection = listConnections().find((c) => c.name === p.query!.connection);
  if (!connection) return null;
  const first = placed.find((t) => t.placed !== 'history');
  if (!first) return null;
  const set = p.sets.find((s) => s.name === first.set) ?? p.sets[0];
  if (!set) return null;
  const store = theStore();
  const series = set.relation.series ?? p.family;
  const sqlKey = createHash('sha256').update(`${connection.id}\n${p.query.sql}`).digest('hex').slice(0, 16);
  const existing = store.listSources(p.doc).find((s) => s.kind === 'sql' && s.connection === connection.id && createHash('sha256').update(`${connection.id}\n${s.sql ?? ''}`).digest('hex').slice(0, 16) === sqlKey);
  const recipe = recipeOf(p, set, first.table, series);
  const at = now();
  const who = by.name || by.login || 'someone';
  if (existing) {
    const current = existing.recipe ? store.getRecipe(existing.recipe) : null;
    let recipeId = existing.recipe;
    if (!current || contractOf(current.recipe as unknown as Recipe) !== contractOf(recipe)) {
      const versions = store.listRecipes(existing.id);
      const rv: RecipeVersion = { id: newId(), source: existing.id, version: (versions[versions.length - 1]?.version ?? 0) + 1, recipe: recipe as unknown as Record<string, unknown>, createdAt: at, createdBy: who, environment: environment(), note: 'a placement the person accepted with a changed shape' };
      store.insertRecipe(rv);
      recipeId = rv.id;
    }
    const next: SourceDef = { ...existing, table: first.table, series, recipe: recipeId, updatedAt: at, lastAttemptAt: at, lastSuccessAt: at, lastResult: `placed by ${who} (${first.placed})`, asOf: p.period, enabled: true };
    store.upsertSource(next);
    // a version per intake key: a refresh records its own (with its checks) before placing; a person's placement records one here
    if (!store.listDatasets(existing.id, 100).some((v) => v.intake === p.key)) recordVersion(next, p, set, 'accepted', { ok: true, checks: [{ name: 'placed by a person', ok: true, detail: `${first.placed}: ${first.name}` }] }, who, undefined);
    return next;
  }
  const src: SourceDef = { id: newId(), doc: p.doc, name: series === connection.name ? series : `${series} ← ${connection.name}`, series, table: first.table, kind: 'sql', connection: connection.id, sql: p.query.sql, createdAt: at, createdBy: who, updatedAt: at, lastAttemptAt: at, lastSuccessAt: at, lastResult: `placed by ${who} (${first.placed})`, asOf: p.period, enabled: true };
  const rv: RecipeVersion = { id: newId(), source: src.id, version: 1, recipe: recipe as unknown as Record<string, unknown>, createdAt: at, createdBy: who, environment: environment(), note: 'captured from the placement the person accepted' };
  src.recipe = rv.id;
  store.upsertSource(src);
  store.insertRecipe(rv);
  recordVersion(src, p, set, 'accepted', { ok: true, checks: [{ name: 'placed by a person', ok: true, detail: `${first.placed}: ${first.name}` }] }, who, undefined);
  return src;
}

function recordVersion(src: SourceDef, p: IntakeProfile, set: IntakeSet, status: DatasetVersion['status'], reconciliation: DatasetVersion['reconciliation'], who: string | undefined, job: string | undefined): DatasetVersion {
  const store = theStore();
  const versions = store.listDatasets(src.id, 1);
  const d: DatasetVersion = { id: newId(), source: src.id, doc: src.doc, version: (versions[0]?.version ?? 0) + 1, period: p.period, hash: p.key, rows: set.dataRows, columns: set.cols, recipe: src.recipe, intake: p.key, reconciliation, status, createdAt: now(), acceptedAt: status === 'accepted' ? now() : undefined, acceptedBy: status === 'accepted' ? who : undefined, job };
  store.insertDataset(d);
  if (status === 'accepted') for (const old of store.listDatasets(src.id, 50)) if (old.id !== d.id && old.status === 'accepted') store.updateDataset(old.id, { status: 'superseded' });
  return d;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** The recipe applied to a fresh profile: the same shape, or drift — named column by column. */
export function applyRecipe(recipe: Recipe, set: IntakeSet): Check[] {
  const checks: Check[] = [];
  const have = new Map(set.columns.map((c) => [c.header.toLowerCase(), c]));
  const missing = recipe.columns.filter((c) => !have.has(c.header.toLowerCase())).map((c) => c.header);
  const extra = set.columns.filter((c) => !recipe.columns.some((r) => r.header.toLowerCase() === c.header.toLowerCase())).map((c) => c.header);
  const changed = recipe.columns.filter((c) => {
    const h = have.get(c.header.toLowerCase());
    return h && h.filled > 0 && h.type !== c.type && !(c.type === 'empty' || h.type === 'empty');
  }).map((c) => `${c.header}: ${c.type} → ${have.get(c.header.toLowerCase())!.type}`);
  checks.push({ name: 'columns', ok: !missing.length && !extra.length, detail: missing.length || extra.length ? `${missing.length ? `missing ${missing.join(', ')}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `new ${extra.join(', ')}` : ''}` : `${recipe.columns.length} columns as the recipe expects` });
  checks.push({ name: 'types', ok: !changed.length, detail: changed.length ? changed.join('; ') : 'every column reads as it did' });
  checks.push({ name: 'header', ok: set.headerDetected === recipe.headerDetected, detail: set.headerDetected ? 'header row recognised' : 'no header row recognised' });
  return checks;
}

/** The candidate against what the table holds: period order, identifiers in common, coverage. */
export function reconcile(recipe: Recipe, set: IntakeSet, p: IntakeProfile, previous: DatasetVersion | null): Check[] {
  const checks: Check[] = [];
  const rel = set.relation;
  if (rel.kind === 'duplicate') checks.push({ name: 'content', ok: true, detail: 'the same content as the current snapshot (nothing to place)' });
  const prevPeriod = rel.currentPeriod ?? previous?.period;
  if (p.period && prevPeriod) {
    const cmp = comparePeriods(p.period, prevPeriod);
    checks.push({ name: 'period', ok: cmp === null || cmp >= 0, detail: cmp === null ? `${p.period} and ${prevPeriod} cannot be ordered` : cmp < 0 ? `${p.period} is older than the current snapshot (${prevPeriod})` : cmp === 0 ? `the same period as the current snapshot (${prevPeriod}): a correction or re-delivery` : `${p.period} after ${prevPeriod}` });
  } else checks.push({ name: 'period', ok: true, detail: p.period ? `first period ${p.period}` : 'no period in the data: dated by arrival' });
  if (recipe.identifierColumn && rel.identifiers) {
    // overlap is the share of the smaller set the two have in common
    const share = rel.identifiers.overlap;
    checks.push({ name: 'identifiers', ok: share >= recipe.rules.minIdentifierOverlap, detail: `${Math.round(share * 100)}% of the ${rel.identifiers.column} in common (${rel.identifiers.ofFile} in the result, ${rel.identifiers.ofTable} in the table); ${rel.identifiers.added} new, ${rel.identifiers.removed} gone` });
  } else if (recipe.identifierColumn) checks.push({ name: 'identifiers', ok: rel.kind !== 'different-entity' && rel.kind !== 'unrelated', detail: rel.reason });
  if (rel.kind === 'different-entity') checks.push({ name: 'entity', ok: false, detail: rel.reason });
  if (previous) {
    const change = Math.abs(set.dataRows - previous.rows) / Math.max(1, previous.rows);
    checks.push({ name: 'coverage', ok: change <= recipe.rules.maxCoverageChange, detail: `${set.dataRows} rows against ${previous.rows} in the previous version (${Math.round(change * 100)}% change)` });
  }
  return checks;
}

export interface RefreshRequest {
  source: string;
  by: Author;
  who: { login: string; name: string };
}

/** A refresh requested: the job is queued (the requester must be allowed the connection and the query now). */
export function requestRefresh(doc: string, sourceId: string, by: Author, who: { login: string; name: string }) {
  const src = theStore().getSource(sourceId);
  if (!src || src.doc !== doc) throw new Error('source not found');
  if (!src.enabled) throw new Error('the source is disabled');
  if (src.kind !== 'sql' || !src.connection || !src.sql) throw new Error('only SQL sources refresh on request; files arrive through intake');
  const c = listConnections().find((x) => x.id === src.connection);
  const identity = identityForLogin(who.login, who.name);
  if (!c || !canSeeConnection(c, identity)) throw new Error('the connection is not available to you');
  authorizeQuery(c, identity, src.sql);
  const job = enqueue({ type: 'refresh', doc, by, maxAttempts: 2, timeoutMs: 300_000, input: { source: src.id, recipe: src.recipe, who: { login: who.login, name: who.name }, lastVersion: src.lastVersion } });
  kick();
  return job;
}

export function listSourcesOf(doc: string) {
  const store = theStore();
  return store.listSources(doc).map((s) => {
    const versions = store.listDatasets(s.id, 5);
    const recipe = s.recipe ? store.getRecipe(s.recipe) : null;
    const connection = s.connection ? listConnections().find((c) => c.id === s.connection) : undefined;
    return { ...s, connectionName: connection?.name, recipeVersion: recipe?.version, versions: versions.map((v) => ({ id: v.id, version: v.version, period: v.period, rows: v.rows, status: v.status, createdAt: v.createdAt, reconciliation: v.reconciliation, intake: v.intake })) };
  });
}

export const recipesOf = (sourceId: string) => theStore().listRecipes(sourceId);
export const versionsOf = (sourceId: string, limit = 50) => theStore().listDatasets(sourceId, limit);
export const getSourceDef = (id: string) => theStore().getSource(id);
export function setSourceEnabled(doc: string, id: string, enabled: boolean): SourceDef {
  const src = theStore().getSource(id);
  if (!src || src.doc !== doc) throw new Error('source not found');
  const next = { ...src, enabled, updatedAt: now() };
  theStore().upsertSource(next);
  return next;
}

/** A held version a person decided to place anyway (or declined): the version follows the decision. */
export function settleHeld(doc: string, intakeKey: string, status: 'accepted' | 'rejected', who: string) {
  const store = theStore();
  for (const src of store.listSources(doc)) {
    for (const v of store.listDatasets(src.id, 20)) {
      if (v.intake === intakeKey && v.status === 'held') {
        store.updateDataset(v.id, { status, acceptedAt: status === 'accepted' ? now() : undefined, acceptedBy: status === 'accepted' ? who : undefined });
        if (status === 'accepted') {
          for (const old of store.listDatasets(src.id, 50)) if (old.id !== v.id && old.status === 'accepted') store.updateDataset(old.id, { status: 'superseded' });
          store.upsertSource({ ...src, lastSuccessAt: now(), lastResult: `held version ${v.version} placed by ${who}`, lastVersion: v.id, asOf: v.period, updatedAt: now() });
        }
      }
    }
  }
}

// ------------------------------------------------------------------ the refresh job
registerRunner('refresh', async (ctl): Promise<JobOutcome> => {
  const { job } = ctl;
  const store = theStore();
  const src = store.getSource(String(job.input.source ?? ''));
  if (!src || src.doc !== job.doc) return { status: 'failed', error: 'source not found' };
  const whoIn = (job.input.who ?? {}) as { login?: string; name?: string };
  const identity = identityForLogin(whoIn.login ?? '', whoIn.name ?? '');
  const by: Author = { id: job.by.id, name: job.by.name, login: job.by.login };
  const attemptAt = now();
  const recipeRow = src.recipe ? store.getRecipe(src.recipe) : null;
  if (!recipeRow) {
    store.upsertSource({ ...src, lastAttemptAt: attemptAt, lastResult: 'failed: no recipe', updatedAt: attemptAt });
    return { status: 'failed', error: 'the source has no recipe' };
  }
  const recipe = recipeRow.recipe as unknown as Recipe;
  const c = listConnections().find((x) => x.id === src.connection);
  if (!c) {
    store.upsertSource({ ...src, lastAttemptAt: attemptAt, lastResult: 'failed: connection gone', updatedAt: attemptAt });
    return { status: 'failed', error: 'the connection no longer exists' };
  }
  let profile: IntakeProfile;
  try {
    profile = await intakeQuery(src.doc, by, c.id, src.sql ?? '', { visible: (x) => canSeeConnection(x as StoredConnection, identity), authorize: (x, sql) => authorizeQuery(x as StoredConnection, identity, sql) });
  } catch (e) {
    const msg = (e as Error).message;
    store.upsertSource({ ...src, lastAttemptAt: attemptAt, lastResult: `failed: ${msg.slice(0, 200)}`, updatedAt: attemptAt });
    noteEvent(src.doc, { kind: 'source', text: `Refresh of ${src.name} failed: ${msg.slice(0, 160)} — the table keeps its last snapshot (${src.asOf ?? 'period unknown'}); monitoring cannot assess what depends on it`, by: by.name, level: 'watch' });
    const retryable = /ECONNREFUSED|ETIMEDOUT|timeout|ECONNRESET|EAI_AGAIN/i.test(msg);
    return { status: 'failed', error: msg, retryable };
  }
  ctl.heartbeat();
  if (ctl.cancelled()) return { status: 'failed', error: 'stopped' };
  const set = profile.sets[0];
  if (!set) {
    store.upsertSource({ ...src, lastAttemptAt: attemptAt, lastResult: 'failed: the query returned nothing', updatedAt: attemptAt });
    return { status: 'failed', error: 'the query returned no rows' };
  }
  const previous = store.listDatasets(src.id, 50).find((v) => v.status === 'accepted') ?? null;
  // an unchanged result establishes current coverage: bookkeeping, no new version, no change invented
  if (profile.status === 'applied' || set.relation.kind === 'duplicate' || (previous && previous.hash === profile.key)) {
    store.upsertSource({ ...src, lastAttemptAt: attemptAt, lastSuccessAt: attemptAt, lastResult: 'unchanged: the same content as the current snapshot', updatedAt: attemptAt });
    noteEvent(src.doc, { kind: 'source', text: `Refreshed ${src.name}: unchanged since ${src.asOf ?? 'the last snapshot'} — coverage confirmed, nothing new`, by: by.name, level: 'quiet' });
    return { status: 'done', result: { ref: profile.key, summary: 'unchanged' } };
  }
  const checks = [...applyRecipe(recipe, set), ...reconcile(recipe, set, profile, previous)];
  const ok = checks.every((x) => x.ok);
  const failing = checks.filter((x) => !x.ok);
  if (!ok) {
    const v = recordVersion(src, profile, set, 'held', { ok: false, checks }, undefined, job.id);
    store.upsertSource({ ...src, lastAttemptAt: attemptAt, lastResult: `held: ${failing.map((f) => `${f.name} — ${f.detail}`).join('; ').slice(0, 300)}`, lastVersion: v.id, updatedAt: attemptAt });
    noteEvent(src.doc, { kind: 'source', text: `Refresh of ${src.name} held (version ${v.version}): ${failing.map((f) => `${f.name} — ${f.detail}`).join('; ').slice(0, 220)}. Nothing was placed; the table keeps ${src.asOf ?? 'its last snapshot'}. Decide on the card in Ask`, by: by.name, level: 'watch' });
    return { status: 'done', result: { ref: v.id, summary: `held: ${failing.map((f) => f.name).join(', ')}` } };
  }
  // the requester must still be allowed to edit the document now, not only when they asked
  if (!canEdit(permissionFor(readAccess(src.doc), identity))) {
    const v = recordVersion(src, profile, set, 'held', { ok: false, checks: [...checks, { name: 'permission', ok: false, detail: `${identity.name || identity.login || 'the requester'} may no longer edit this document` }] }, undefined, job.id);
    store.upsertSource({ ...src, lastAttemptAt: attemptAt, lastResult: 'held: the requester may no longer edit the document', lastVersion: v.id, updatedAt: attemptAt });
    return { status: 'done', result: { ref: v.id, summary: 'held: permission' } };
  }
  // every check passed: the version is recorded with its checks, then placed through the log as the person who asked — the
  // source record, the checks and the reading follow as for any placement
  const table = src.table ?? set.relation.table?.id;
  const v = recordVersion(src, profile, set, 'accepted', { ok: true, checks }, by.name, job.id);
  try {
    const placed = applyIntake(src.doc, by, profile.key, { decisions: [{ action: typeof table === 'number' ? 'update' : 'new', table }], period: profile.period });
    store.upsertSource({ ...store.getSource(src.id)!, table: placed.applied?.tables[0]?.table ?? src.table, lastAttemptAt: attemptAt, lastSuccessAt: attemptAt, lastResult: `version ${v.version} placed (${set.dataRows} rows, ${profile.period ?? 'period by arrival'})`, lastVersion: v.id, asOf: profile.period, updatedAt: attemptAt });
    noteEvent(src.doc, { kind: 'source', text: `Refreshed ${src.name}: version ${v.version} — ${set.relation.reason}`, by: by.name, level: 'quiet' });
    return { status: 'done', result: { ref: v.id, summary: `version ${v.version} placed` } };
  } catch (e) {
    const msg = (e as Error).message;
    store.updateDataset(v.id, { status: 'held', reconciliation: { ok: false, checks: [...checks, { name: 'placement', ok: false, detail: msg.slice(0, 200) }] } });
    if (previous) store.updateDataset(previous.id, { status: 'accepted' }); // the table still holds it
    store.upsertSource({ ...store.getSource(src.id)!, lastAttemptAt: attemptAt, lastResult: `held: placement failed — ${msg.slice(0, 200)}`, lastVersion: v.id, updatedAt: attemptAt });
    return { status: 'failed', error: msg };
  }
});

// a placed SQL snapshot defines (or re-affirms) its source; a held version follows the person's decision
setPlacementHook((p, by, placed) => {
  settleHeld(p.doc, p.key, 'accepted', by.name || by.login || 'someone');
  ensureSourceFromPlacement(p, by, placed);
});
setDeclineHook((p, by) => settleHeld(p.doc, p.key, 'rejected', by.name || by.login || 'someone'));

/** The profile of a held version, for the card: which checks failed. */
export function heldReason(doc: string, intakeKey: string): { version: number; checks: Check[] } | null {
  const store = theStore();
  for (const src of store.listSources(doc)) for (const v of store.listDatasets(src.id, 20)) if (v.intake === intakeKey && v.status === 'held') return { version: v.version, checks: v.reconciliation.checks };
  return null;
}

