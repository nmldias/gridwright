import { useEffect, useRef, useState } from 'react';
import { api, type AiSettings } from '../api/client';
import * as book from '../engine/book';
import { applyActions, buildMessages, extractActions, type Action } from './ai';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  actions?: Action[];
  applied?: { applied: number; errors: string[] };
}

export function AiPanel() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState({ baseUrl: '', model: '', apiKey: '' });
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoApply, setAutoApply] = useState(true);
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
      let applied: Msg['applied'];
      if (actions.length && autoApply) applied = applyActions(actions);
      setMessages((ms) => [...ms.slice(0, -1), { role: 'assistant', content: full, actions, applied }]);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      setMessages((ms) => (ms[ms.length - 1]?.content === '' ? ms.slice(0, -1) : ms));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const stop = (e: React.KeyboardEvent) => e.stopPropagation();

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
            <input value={draft.model} onKeyDown={stop} placeholder="e.g. qwen3 / gpt-4.1 / claude-sonnet-4-5" onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          </label>
          <label className="field">
            <span>API key {settings?.hasKey ? '(set)' : '(none)'}</span>
            <input type="password" value={draft.apiKey} onKeyDown={stop} placeholder="leave empty to keep / for local servers" onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
          </label>
          <div className="row">
            <button
              className="primary"
              onClick={async () => {
                try {
                  const s = await api.ai.saveSettings({ baseUrl: draft.baseUrl, model: draft.model, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) });
                  setSettings(s);
                  setShowSettings(false);
                  setError(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Save
            </button>
            <label className="field check">
              <input type="checkbox" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} />
              <span>Apply suggested changes automatically (Ctrl+Z undoes)</span>
            </label>
          </div>
          <p className="muted small">Works with any OpenAI-compatible chat endpoint: vLLM, Ollama, llama.cpp, OpenRouter, OpenAI, or Anthropic's compatibility endpoint (https://api.anthropic.com/v1). The key is kept on the server.</p>
        </div>
      )}
      <div className="chat">
        {messages.length === 0 && (
          <div className="muted small">
            Ask for formulas, Python/JavaScript analysis, or new tables. The assistant sees your table names, sizes and the first rows, plus the current selection. Try: “Add a column with the running total of Revenue” or “Summarise this table by region in a new table”.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="msg-body">{m.content || (busy && i === messages.length - 1 ? '…' : '')}</div>
            {m.actions && m.actions.length > 0 && (
              <div className="actions">
                {m.applied ? (
                  <span className="small">
                    Applied {m.applied.applied} change{m.applied.applied === 1 ? '' : 's'}
                    {m.applied.errors.length ? ` · ${m.applied.errors.length} failed: ${m.applied.errors.join('; ')}` : ''}
                    {' '}
                    <button className="link" onClick={() => book.undo()}>
                      undo
                    </button>
                  </span>
                ) : (
                  <button
                    className="primary small"
                    onClick={() => {
                      const applied = applyActions(m.actions!);
                      setMessages((ms) => ms.map((x, j) => (j === i ? { ...x, applied } : x)));
                    }}
                  >
                    Apply {m.actions.length} change{m.actions.length === 1 ? '' : 's'}
                  </button>
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
