// The assistant's conversation lives here, per document, independent of the panel that shows it: a
// question typed and not yet sent, a reply still streaming, a proposal not yet applied all survive a
// trip to another panel. The panel is a view of this state, never its owner.

import { create } from 'zustand';
import { api, type ToolEvent } from '../api/client';
import { getState } from '../state/store';
import { applyActions, buildMessages, extractActions, previewActions, type Action, type DiffLine } from './ai';

export interface ToolRun {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok?: boolean;
  summary?: string;
  result?: unknown;
}

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
  actions?: Action[];
  diff?: { lines: DiffLine[]; errors: string[] };
  applied?: { applied: number; errors: string[] };
  dismissed?: boolean;
  tools?: ToolRun[];
  notice?: string;
}

export interface Conversation {
  messages: Msg[];
  /** the question being typed */
  input: string;
  busy: boolean;
  error: string | null;
}

const EMPTY: Conversation = { messages: [], input: '', busy: false, error: null };

interface ChatState {
  byDoc: Record<string, Conversation>;
}

export const useChat = create<ChatState>(() => ({ byDoc: {} }));

/** Conversations are kept per document; an unsaved document has one too, adopted when it is first saved. */
export const docKey = (fileId: string | null) => fileId ?? '(unsaved)';

export const conversationOf = (key: string): Conversation => useChat.getState().byDoc[key] ?? EMPTY;

export function patchConversation(key: string, patch: Partial<Conversation> | ((c: Conversation) => Partial<Conversation>)) {
  useChat.setState((s) => {
    const cur = s.byDoc[key] ?? EMPTY;
    const p = typeof patch === 'function' ? patch(cur) : patch;
    return { byDoc: { ...s.byDoc, [key]: { ...cur, ...p } } };
  });
}

/** When an unsaved document is saved for the first time, its conversation follows it. */
export function adoptUnsaved(fileId: string) {
  const s = useChat.getState();
  const c = s.byDoc['(unsaved)'];
  if (!c || s.byDoc[fileId]) return;
  const next = { ...s.byDoc, [fileId]: c };
  delete next['(unsaved)'];
  useChat.setState({ byDoc: next });
}

const aborts = new Map<string, AbortController>();

export function stopMessage(key: string) {
  aborts.get(key)?.abort();
}

/** Send the typed question; the reply streams into the conversation whether or not the panel is open. */
export async function sendMessage(key: string, opts: { tools: boolean; autoApply: boolean; file: string | null }) {
  const conv = conversationOf(key);
  const text = conv.input.trim();
  if (!text || conv.busy) return;
  const history: Msg[] = [...conv.messages, { role: 'user', content: text }];
  patchConversation(key, { input: '', error: null, busy: true, messages: [...history, { role: 'assistant', content: '' }] });
  const ac = new AbortController();
  aborts.set(key, ac);
  try {
    let acc = '';
    const runs: ToolRun[] = [];
    let notice: string | undefined;
    const patch = () => patchConversation(key, (c) => ({ messages: [...c.messages.slice(0, -1), { role: 'assistant', content: acc, tools: runs.length ? [...runs] : undefined, notice }] }));
    const onTool = (ev: ToolEvent) => {
      if (ev.kind === 'call') runs.push({ id: ev.id, name: ev.name, args: ev.args });
      else if (ev.kind === 'result') {
        const r = runs.find((x) => x.id === ev.id);
        if (r) Object.assign(r, { ok: ev.ok, summary: ev.summary, result: ev.result });
      } else notice = ev.text;
      patch();
    };
    const full = await api.ai.chat(
      buildMessages(history.map((m) => ({ role: m.role, content: m.content }))),
      (chunk) => {
        acc += chunk;
        patch();
      },
      ac.signal,
      { tools: opts.tools && getState().me.role !== 'viewer', file: opts.file, onTool },
    );
    const actions = extractActions(full);
    const diff = actions.length ? previewActions(actions) : undefined;
    let applied: Msg['applied'];
    // auto-apply only when the document the reply was written for is still the one open
    if (actions.length && opts.autoApply && docKey(getState().fileId) === key) applied = applyActions(actions);
    patchConversation(key, (c) => ({ messages: [...c.messages.slice(0, -1), { role: 'assistant', content: full, actions, diff, applied, tools: runs.length ? runs : undefined, notice }] }));
  } catch (e) {
    patchConversation(key, (c) => ({
      error: (e as Error).name !== 'AbortError' ? (e as Error).message : c.error,
      messages: c.messages[c.messages.length - 1]?.content === '' ? c.messages.slice(0, -1) : c.messages,
    }));
  } finally {
    patchConversation(key, { busy: false });
    aborts.delete(key);
  }
}

export function updateMessage(key: string, index: number, patch: Partial<Msg>) {
  patchConversation(key, (c) => ({ messages: c.messages.map((m, i) => (i === index ? { ...m, ...patch } : m)) }));
}
