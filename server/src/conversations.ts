// Conversations with the assistant, owned by the server: one transcript per document and person
// (per document when identity is off), so that closing the application — or opening it on another
// authorised device — brings the conversation back with the situation. The transcript is the
// person's: a private hypothesis typed there never reaches another login's transcript. Kept as a
// JSON file under the data directory, capped, replaced whole (the client sends the transcript it
// holds after each exchange; the last writer wins, which for one person on two devices is the device
// they are using).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './storage.js';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  /** actions proposed by a reply, their preview and whether they were applied — kept so a reopened reply reads the same */
  actions?: unknown[];
  diff?: unknown;
  applied?: unknown;
  dismissed?: boolean;
  tools?: { id: string; name: string; args: Record<string, unknown>; ok?: boolean; summary?: string }[];
  notice?: string;
  at?: string;
}
export interface Conversation {
  doc: string;
  owner: string;
  messages: StoredMessage[];
  updatedAt: string;
}

const MAX_MESSAGES = 200;
const MAX_CONTENT = 40_000;
const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
const DIR = (doc: string) => join(DATA_DIR, 'conversations', doc);
const slug = (login: string) => (login ? login.toLowerCase().replace(/[^a-z0-9@._-]+/g, '_').slice(0, 120) : 'guest');
const pathOf = (doc: string, login: string) => join(DIR(doc), `${slug(login)}.json`);

export function readConversation(doc: string, login: string): Conversation {
  if (!safeId(doc)) throw new Error('bad document id');
  const p = pathOf(doc, login);
  if (!existsSync(p)) return { doc, owner: slug(login), messages: [], updatedAt: '' };
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as Conversation;
    return { doc, owner: slug(login), messages: Array.isArray(c.messages) ? c.messages : [], updatedAt: c.updatedAt ?? '' };
  } catch {
    return { doc, owner: slug(login), messages: [], updatedAt: '' };
  }
}

/** The transcript replaced whole: trimmed to what is kept (the last MAX_MESSAGES, contents capped, tool results dropped). */
export function writeConversation(doc: string, login: string, messages: unknown[]): Conversation {
  if (!safeId(doc)) throw new Error('bad document id');
  const kept: StoredMessage[] = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const x = m as Record<string, unknown>;
    const role = x.role === 'user' ? 'user' : x.role === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const msg: StoredMessage = { role, content: String(x.content ?? '').slice(0, MAX_CONTENT) };
    if (Array.isArray(x.actions)) msg.actions = x.actions.slice(0, 200);
    if (x.diff && typeof x.diff === 'object') msg.diff = x.diff;
    if (x.applied && typeof x.applied === 'object') msg.applied = x.applied;
    if (x.dismissed === true) msg.dismissed = true;
    if (typeof x.notice === 'string') msg.notice = x.notice.slice(0, 2000);
    if (typeof x.at === 'string') msg.at = x.at.slice(0, 40);
    if (Array.isArray(x.tools)) msg.tools = x.tools.slice(0, 50).map((t) => {
      const r = (t ?? {}) as Record<string, unknown>;
      return { id: String(r.id ?? ''), name: String(r.name ?? '').slice(0, 80), args: r.args && typeof r.args === 'object' ? (r.args as Record<string, unknown>) : {}, ok: typeof r.ok === 'boolean' ? r.ok : undefined, summary: typeof r.summary === 'string' ? r.summary.slice(0, 500) : undefined };
    });
    kept.push(msg);
  }
  const c: Conversation = { doc, owner: slug(login), messages: kept.slice(-MAX_MESSAGES), updatedAt: new Date().toISOString() };
  mkdirSync(DIR(doc), { recursive: true });
  const p = pathOf(doc, login);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, p);
  return c;
}

export function clearConversation(doc: string, login: string) {
  if (!safeId(doc)) throw new Error('bad document id');
  rmSync(pathOf(doc, login), { force: true });
}

/** All transcripts of a document go with it when it is deleted. */
export function deleteConversationsOf(doc: string) {
  if (!safeId(doc)) return;
  rmSync(DIR(doc), { recursive: true, force: true });
}
