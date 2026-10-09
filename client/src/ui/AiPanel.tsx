import { useEffect, useRef, useState } from 'react';
import { api, type AiSettings } from '../api/client';
import * as book from '../engine/book';
import { useStore } from '../state/store';
import { applyActions, buildMessages, extractActions, previewActions, type Action, type DiffLine } from './ai';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  actions?: Action[];
  diff?: { lines: DiffLine[]; errors: string[] };
  applied?: { applied: number; errors: string[] };
  dismissed?: boolean;
}

const AUTO_KEY = 'gridwright.ai.autoApply';

export function AiPanel() {
  const me = useStore((s) => s.me);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState({ baseUrl: '', model: '', apiKey: '' });
  const [models, setModels] = useState<string[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoApply, setAutoApply] = useState(() => {
    try {
      return localStorage.getItem(AUTO_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
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

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setError(null);
    const history: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setBusy(true);
    abort.current = new AbortController();
    try {
      let acc = '';
      const full = await api.ai.chat(
        buildMessages(history.map((m) => ({ role: m.role, content: m.content }))),
        (chunk) => {
          acc += chunk;
          setMessages((ms) => [...ms.slice(0, -1), { role: 'assistant', content: acc }]);
        },
        abort.current.signal,
      );
      const actions = extractActions(full);
      const diff = actions.length ? previewActions(actions) : undefined;
      let applied: Msg['applied'];
      if (actions.length && autoApply) applied = applyActions(actions);
      setMessages((ms) => [...ms.slice(0, -1), { role: 'assistant', content: full, actions, diff, applied }]);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      setMessages((ms) => (ms[ms.length - 1]?.content === '' ? ms.slice(0, -1) : ms));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  const stripActions = (s: string) => s.replace(/```gridwright-actions[\s\S]*?```/g, '').trim();

  return (
    <div className="panel ai-panel">
      <div className="panel-title">
        <span>AI assistant</span>
        <span className="grow" />
        <button className={showSettings ? 'active' : ''} onClick={() => setShowSettings((v) => !v)} title="Model endpoint">
          ⚙
        </button>
      </div>
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
                      onClick={() => {
                        const applied = applyActions(m.actions!);
                        setMessages((ms) => ms.map((x, j) => (j === i ? { ...x, applied } : x)));
                      }}
                    >
                      Apply {m.diff?.lines.length ?? m.actions.length} change{(m.diff?.lines.length ?? m.actions.length) === 1 ? '' : 's'}
                    </button>
                    <button className="small" onClick={() => setMessages((ms) => ms.map((x, j) => (j === i ? { ...x, dismissed: true } : x)))}>
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
              void send();
            }
          }}
          onChange={(e) => setInput(e.target.value)}
        />
        {busy ? (
          <button onClick={() => abort.current?.abort()}>Stop</button>
        ) : (
          <button className="primary" onClick={() => void send()} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
