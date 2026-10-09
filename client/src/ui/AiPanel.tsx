import { useEffect, useRef, useState } from 'react';
import { api, type AiSettings } from '../api/client';
import * as book from '../engine/book';
import { useStore } from '../state/store';
import { applyActions } from './ai';
import { docKey, patchConversation, sendMessage, stopMessage, updateMessage, useChat, type ToolRun } from './chat';
import { PanelHeader } from './PanelHeader';

const AUTO_KEY = 'gridwright.ai.autoApply';
const TOOLS_KEY = 'gridwright.ai.tools';

function describeArgs(t: ToolRun): string {
  if (t.name === 'run_sql') return String(t.args.sql ?? '');
  if (t.name === 'describe_table') return String(t.args.table ?? '');
  if (t.name === 'read_history') return `last ${t.args.limit ?? 50}`;
  const entries = Object.entries(t.args);
  return entries.length ? entries.map(([k, v]) => `${k}=${String(v)}`).join(', ') : '';
}

function ToolRunView({ t }: { t: ToolRun }) {
  const [open, setOpen] = useState(false);
  const r = t.result as { columns?: string[]; rows?: unknown[][] } | unknown[] | undefined;
  const table = r && typeof r === 'object' && !Array.isArray(r) && Array.isArray(r.columns) ? r : null;
  return (
    <div className={`tool-run ${t.ok === undefined ? 'running' : t.ok ? 'ok' : 'fail'}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="mark">{t.ok === undefined ? '…' : t.ok ? '✓' : '✗'}</span> <code>{t.name}</code>
        <span className="muted small"> {describeArgs(t).slice(0, 160)}</span>
        {t.summary && <span className="muted small"> — {t.summary}</span>}
      </button>
      {open && table && (
        <table className="tool-table">
          <thead>
            <tr>{table.columns!.map((c, i) => <th key={i}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {(table.rows ?? []).slice(0, 25).map((row, i) => (
              <tr key={i}>{row.map((v, j) => <td key={j}>{v === null ? '' : String(v)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )}
      {open && !table && t.result !== undefined && <pre className="small">{JSON.stringify(t.result, null, 1).slice(0, 4000)}</pre>}
    </div>
  );
}

export function AiPanel() {
  const me = useStore((s) => s.me);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState({ baseUrl: '', model: '', apiKey: '' });
  const [models, setModels] = useState<string[]>([]);
  const fileId = useStore((s) => s.fileId);
  const key = docKey(fileId);
  // the conversation belongs to the document, not to this panel: it survives switching panels
  const conv = useChat((s) => s.byDoc[key]);
  const messages = conv?.messages ?? [];
  const input = conv?.input ?? '';
  const busy = conv?.busy ?? false;
  const error = conv?.error ?? null;
  const setError = (e: string | null) => patchConversation(key, { error: e });
  const [autoApply, setAutoApply] = useState(() => {
    try {
      return localStorage.getItem(AUTO_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [tools, setTools] = useState(() => {
    try {
      return localStorage.getItem(TOOLS_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.ai
      .settings()
      .then((s) => {
        setSettings(s);
        setDraft({ baseUrl: s.baseUrl, model: s.model, apiKey: '' });
        if (!s.configured) setShowSettings(true);
        if (s.baseUrl) api.ai.models().then((m) => setModels(m.models)).catch(() => undefined);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const send = () => void sendMessage(key, { tools, autoApply, file: fileId });

  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  const stripActions = (s: string) => s.replace(/```gridwright-actions[\s\S]*?```/g, '').trim();

  return (
    <div className="panel ai-panel">
      <PanelHeader title="Ask">
        <button className={showSettings ? 'active' : ''} onClick={() => setShowSettings((v) => !v)} title="Model endpoint">
          ⚙
        </button>
      </PanelHeader>
      {showSettings && (
        <div className="ai-settings">
          <label className="field">
            <span>OpenAI-compatible base URL</span>
            <input value={draft.baseUrl} onKeyDown={stop} placeholder="http://100.78.161.2:8888/v1" onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={draft.model} onKeyDown={stop} list="ai-models" placeholder="model id as served by the endpoint" onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
            <datalist id="ai-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          {models.length > 0 && (
            <div className="row wrap small-row">
              {models.slice(0, 6).map((m) => (
                <button key={m} className="chip small" onClick={() => setDraft({ ...draft, model: m })}>
                  {m}
                </button>
              ))}
            </div>
          )}
          <label className="field">
            <span>API key {settings?.hasKey ? '(set)' : '(none)'}</span>
            <input type="password" value={draft.apiKey} onKeyDown={stop} placeholder="leave empty to keep / for local servers" onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
          </label>
          <div className="row">
            <button
              className="primary"
              disabled={me.role !== 'admin'}
              onClick={async () => {
                try {
                  const s = await api.ai.saveSettings({ baseUrl: draft.baseUrl, model: draft.model, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) });
                  setSettings(s);
                  setShowSettings(false);
                  setError(null);
                  api.ai.models().then((m) => setModels(m.models)).catch(() => undefined);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Save
            </button>
            <label className="field check">
              <input
                type="checkbox"
                checked={autoApply}
                onChange={(e) => {
                  setAutoApply(e.target.checked);
                  try {
                    localStorage.setItem(AUTO_KEY, e.target.checked ? '1' : '0');
                  } catch {
                    /* ignore */
                  }
                }}
              />
              <span>Apply suggested changes automatically (otherwise review the diff first)</span>
            </label>
          </div>
          <label className="field check">
            <input
              type="checkbox"
              checked={tools}
              onChange={(e) => {
                setTools(e.target.checked);
                try {
                  localStorage.setItem(TOOLS_KEY, e.target.checked ? '1' : '0');
                } catch {
                  /* ignore */
                }
              }}
            />
            <span>Let the assistant use tools: read-only SQL (≤200 rows), table schemas and the document history. Every call is shown in the chat.</span>
          </label>
          <p className="muted small">Works with any OpenAI-compatible chat endpoint: vLLM, Ollama, llama.cpp, OpenRouter, OpenAI, or Anthropic's compatibility endpoint. The key is kept on the server. {me.role !== 'admin' ? 'Only administrators can change the endpoint.' : ''}</p>
        </div>
      )}
      <div className="chat">
        {messages.length === 0 && (
          <div className="muted small">
            Ask for formulas, Python/JavaScript/SQL analysis, or new tables. The assistant sees your table names, sizes and the first rows, plus the current selection. Every proposed change is shown as a before → after diff; nothing is written until you apply it (Ctrl+Z reverts).
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.tools?.map((t) => <ToolRunView key={t.id} t={t} />)}
            {m.notice && <div className="muted small">{m.notice}</div>}
            <div className="msg-body">{m.role === 'assistant' ? stripActions(m.content) || (busy && i === messages.length - 1 ? '…' : '') : m.content}</div>
            {m.actions && m.actions.length > 0 && (
              <div className="actions">
                {m.diff && (
                  <table className="diff">
                    <tbody>
                      {m.diff.lines.slice(0, 60).map((l, j) => (
                        <tr key={j} className={`diff-${l.kind}`}>
                          <td className="where">{l.where}</td>
                          <td className="before">{l.before}</td>
                          <td className="arrow">→</td>
                          <td className="after">{l.after}</td>
                        </tr>
                      ))}
                      {m.diff.lines.length > 60 && (
                        <tr>
                          <td colSpan={4} className="muted small">
                            … {m.diff.lines.length - 60} more cells
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
                {m.diff?.errors.length ? <div className="err small">{m.diff.errors.join('; ')}</div> : null}
                {m.applied ? (
                  <span className="small">
                    Applied {m.applied.applied} change{m.applied.applied === 1 ? '' : 's'}
                    {m.applied.errors.length ? ` · ${m.applied.errors.length} failed: ${m.applied.errors.join('; ')}` : ''}{' '}
                    <button className="link" onClick={() => book.undo()}>
                      undo
                    </button>
                  </span>
                ) : m.dismissed ? (
                  <span className="muted small">Dismissed.</span>
                ) : (
                  <div className="row">
                    <button
                      className="primary small"
                      disabled={me.role === 'viewer'}
                      onClick={() => updateMessage(key, i, { applied: applyActions(m.actions!) })}
                    >
                      Apply {m.diff?.lines.length ?? m.actions.length} change{(m.diff?.lines.length ?? m.actions.length) === 1 ? '' : 's'}
                    </button>
                    <button className="small" onClick={() => updateMessage(key, i, { dismissed: true })}>
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {error && <div className="err small">{error}</div>}
      <div className="chat-input">
        <textarea
          value={input}
          rows={3}
          placeholder="Ask about your data…  (Enter to send, Shift+Enter for a new line)"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onChange={(e) => patchConversation(key, { input: e.target.value })}
        />
        {busy ? (
          <button onClick={() => stopMessage(key)}>Stop</button>
        ) : (
          <button className="primary" onClick={send} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
