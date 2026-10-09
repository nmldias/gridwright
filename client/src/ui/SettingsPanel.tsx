import { useState } from 'react';
import { PanelHeader } from './PanelHeader';
import { setMyName } from '../api/ws';
import { engineVersion } from '../engine/book';
import { useStore } from '../state/store';
import { api } from '../api/client';
import { DEFAULT_PYODIDE_INDEX, getPyWorker, localPyodideIndex, pyodideIndexURL, resetPython, setPyodideIndexURL } from '../workers/runner';

const PREWARM_KEY = 'gridwright.python.prewarm';
export function prewarmEnabled(): boolean {
  try {
    const v = localStorage.getItem(PREWARM_KEY);
    if (v !== null) return v === '1';
  } catch {
    /* ignore */
  }
  return !!localPyodideIndex; // default on when the runtime is served locally
}

export function SettingsPanel() {
  const me = useStore((s) => s.me);
  const pythonStatus = useStore((s) => s.pythonStatus);
  const serverPython = useStore((s) => s.serverPython);
  const [probing, setProbing] = useState(false);
  const [probeNote, setProbeNote] = useState('');
  const reprobe = async () => {
    setProbing(true);
    setProbeNote('');
    try {
      const p = await api.python.probe();
      useStore.setState({ serverPython: p.available ? { version: p.version, sandbox: p.sandbox, gpu: p.gpu, timeoutMs: p.limits.timeoutMs, memoryMb: p.limits.memoryMb } : null });
      setProbeNote(p.available ? `CPython ${p.version} · sandbox: ${p.sandbox}${p.fallbacks ? ` (stronger sandboxes unavailable: ${p.fallbacks})` : ''} · ${p.gpu ?? ''}` : `not available: ${p.reason ?? 'unknown'}`);
    } catch (e) {
      setProbeNote((e as Error).message);
    } finally {
      setProbing(false);
    }
  };
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('gridwright.name') ?? '';
    } catch {
      return '';
    }
  });
  const [pyUrl, setPyUrl] = useState(pyodideIndexURL());
  const [prewarm, setPrewarm] = useState(prewarmEnabled());
  const density = useStore((s) => s.density);
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  return (
    <div className="panel">
      <PanelHeader title="Settings" />
      <label className="field">
        <span>Grid text</span>
        <select
          value={density}
          onChange={(e) => {
            const d = e.target.value === 'compact' ? 'compact' : 'comfortable';
            useStore.setState({ density: d });
            try {
              localStorage.setItem('gridwright.density', d);
            } catch {
              /* ignore */
            }
          }}
        >
          <option value="comfortable">comfortable (13 px)</option>
          <option value="compact">compact (12 px) — more rows and columns on screen</option>
        </select>
      </label>
      {me.identity ? (
        <div className="muted small">
          Signed in through Tailscale as <b>{me.name || me.login}</b> ({me.login}) · role: {me.role}
        </div>
      ) : (
        <label className="field">
          <span>Your name (shown to collaborators and in the history)</span>
          <input value={name} onKeyDown={stop} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && setMyName(name.trim())} />
        </label>
      )}
      <div className="panel-subtitle">Python on the server</div>
      <div className="muted small">
        {serverPython
          ? `CPython ${serverPython.version} · sandbox: ${serverPython.sandbox} · ${serverPython.gpu?.startsWith('cudf') ? 'GPU: ' + serverPython.gpu : 'no GPU (cuDF not installed)'} · ${serverPython.memoryMb} MB, ${Math.round(serverPython.timeoutMs / 1000)} s per run`
          : 'not available on this server (no python3, or the sandbox probe failed) — new Python cells run in the browser'}
      </div>
      <div className="row wrap">
        <button disabled={probing || me.role !== 'admin'} onClick={() => void reprobe()} title={me.role === 'admin' ? 'Detect the interpreter, the sandbox and cuDF again (after installing python, bubblewrap or RAPIDS)' : 'administrators only'}>
          {probing ? 'Checking…' : 'Re-check server Python'}
        </button>
        {probeNote && <span className="muted small">{probeNote}</span>}
      </div>
      <div className="panel-subtitle">Python in the browser</div>
      <label className="field">
        <span>Pyodide URL {localPyodideIndex ? '(a local copy is served by this server)' : '(CDN by default)'}</span>
        <input value={pyUrl} onKeyDown={stop} onChange={(e) => setPyUrl(e.target.value)} />
      </label>
      <div className="row wrap">
        <button
          className="primary"
          onClick={() => {
            setPyodideIndexURL(pyUrl.trim() || localPyodideIndex || DEFAULT_PYODIDE_INDEX);
            resetPython();
          }}
        >
          Apply &amp; restart Python
        </button>
        {localPyodideIndex && (
          <button
            onClick={() => {
              setPyUrl(localPyodideIndex!);
              setPyodideIndexURL('');
              resetPython();
            }}
          >
            Use local copy
          </button>
        )}
        <button
          onClick={() => {
            setPyUrl(DEFAULT_PYODIDE_INDEX);
            setPyodideIndexURL(DEFAULT_PYODIDE_INDEX);
            resetPython();
          }}
        >
          Use CDN
        </button>
        <button onClick={() => getPyWorker()} disabled={pythonStatus === 'ready' || pythonStatus === 'loading'}>
          {pythonStatus === 'ready' ? 'Runtime ready' : pythonStatus === 'loading' ? 'Loading…' : 'Load now'}
        </button>
      </div>
      <label className="field check">
        <input
          type="checkbox"
          checked={prewarm}
          onChange={(e) => {
            setPrewarm(e.target.checked);
            try {
              localStorage.setItem(PREWARM_KEY, e.target.checked ? '1' : '0');
            } catch {
              /* ignore */
            }
            if (e.target.checked) getPyWorker();
          }}
        />
        <span>Load the Python runtime when the document opens (first cell runs instantly)</span>
      </label>
      <p className="muted small">
        Python cells run in your browser through Pyodide (WebAssembly). The server can host the runtime itself (installer option <code>--pyodide</code>, directory <code>data/pyodide</code>) so nothing is fetched from the internet.
      </p>
      <div className="panel-subtitle">Keyboard</div>
      <table className="keys">
        <tbody>
          <tr>
            <td>Enter / F2</td>
            <td>edit cell · Enter commits and moves down, Tab moves right</td>
          </tr>
          <tr>
            <td>Typing</td>
            <td>starts editing (replaces the content)</td>
          </tr>
          <tr>
            <td>Arrows / Shift+Arrows</td>
            <td>move / extend the selection · Ctrl+Arrow jumps to the edge</td>
          </tr>
          <tr>
            <td>Ctrl+C / X / V</td>
            <td>copy, cut, paste (formulas shift like in Excel; TSV from other apps pastes too)</td>
          </tr>
          <tr>
            <td>Ctrl+Z / Ctrl+Y</td>
            <td>undo / redo</td>
          </tr>
          <tr>
            <td>Ctrl+B · Ctrl+D · Ctrl+A</td>
            <td>bold · fill down · select the table</td>
          </tr>
          <tr>
            <td>Ctrl+Shift+L</td>
            <td>filter by the active column / clear filters</td>
          </tr>
          <tr>
            <td>Delete</td>
            <td>clear the selection</td>
          </tr>
          <tr>
            <td>Wheel / Ctrl+Wheel / Space+drag</td>
            <td>pan / zoom / pan</td>
          </tr>
          <tr>
            <td>Touch</td>
            <td>drag pans · tap selects · tap again edits · long-press opens the menu · pinch zooms</td>
          </tr>
          <tr>
            <td>Ctrl+Enter in the code editor</td>
            <td>run the cell</td>
          </tr>
        </tbody>
      </table>
      <div className="panel-subtitle">About</div>
      <p className="muted small">Gridwright — engine v{engineVersion()} (Rust → WebAssembly), WebGL canvas (PixiJS), Pyodide for Python, MIT licence.</p>
    </div>
  );
}
