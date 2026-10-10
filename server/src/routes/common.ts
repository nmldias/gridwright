// What every route handler shares: who is calling and what they may do, the permission a document
// grants them, the shape of a body (checked before any service is called), and one way to answer
// an error. A handler is: authenticate → validate → call the service → return the result; the
// rules live in the services, where REST, MCP and the worker use the same implementation.

import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { canEdit, canManage, canSign, canView, permissionFor, readAccess, type FileAccess } from '../access.js';
import { errorMessage } from '../headless.js';
import { identityOf } from '../identity.js';
import { readFile } from '../storage.js';

export type Permission = ReturnType<typeof permissionFor>;

/** Roles: viewers cannot write; only admins manage connections, AI settings and backups. */
export const requireRole = (min: 'editor' | 'admin') => (req: Request, res: Response, next: NextFunction) => {
  const id = identityOf(req);
  const ok = min === 'editor' ? id.role !== 'viewer' : id.role === 'admin';
  if (!ok) {
    res.status(403).json({ error: min === 'editor' ? 'read-only access' : 'administrator access required' });
    return;
  }
  next();
};

/** Permission of the caller on a document, or a 403/404 already sent. */
export function docPermission(req: Request, res: Response, need: 'view' | 'sign' | 'edit' | 'own'): { access: FileAccess; permission: Permission } | null {
  const id = req.params.id;
  if (!readFile(id)) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  const access = readAccess(id);
  const permission = permissionFor(access, identityOf(req));
  const ok = need === 'view' ? canView(permission) : need === 'sign' ? canSign(permission) : need === 'edit' ? canEdit(permission) : canManage(permission);
  if (!ok) {
    res.status(permission === 'none' ? 404 : 403).json({ error: permission === 'none' ? 'not found' : need === 'own' ? 'only the owner can do that' : 'read-only access to this document' });
    return null;
  }
  return { access, permission };
}

/** The author a change is attributed to: the person, or an agent acting for them (named as such). */
export const authorOf = (req: Request): { id: string; name: string; login?: string } => {
  const id = identityOf(req);
  const client = typeof req.body?.client === 'string' ? req.body.client : 'api';
  return { id: id.agent ? id.agent : client, name: id.agent ? `${id.agent} for ${id.name || 'Guest'}` : id.name || 'Guest', login: id.login || undefined };
};

/** What an agent process may not do for the person it acts for: ratify, approve, decide, delete, place. */
export const noAgent = (req: Request, res: Response): boolean => {
  if (identityOf(req).agent) {
    res.status(403).json({ error: 'an agent may propose, not ratify: a person confirms, approves, decides and removes' });
    return false;
  }
  return true;
};

export const originOf = (req: Request): 'user' | 'agent' => (identityOf(req).agent ? 'agent' : 'user');

/** One way to answer an error: 400 with the message (a service's error names what was wrong). */
export const fail = (res: Response, e: unknown, status = 400) => res.status(status).json({ error: errorMessage(e) });

/**
 * The body under its schema, or a 400 already sent that names the field and the problem. The
 * schemas are the contracts of the companion's interfaces; the same ones serve MCP and the worker.
 */
export function body<S extends ZodTypeAny>(schema: S, req: Request, res: Response): z.infer<S> | null {
  const r = schema.safeParse(req.body ?? {});
  if (r.success) return r.data;
  const first = r.error.issues[0];
  res.status(400).json({ error: `invalid request: ${first ? `${first.path.join('.') || 'body'} — ${first.message}` : 'malformed body'}`, issues: r.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return null;
}
