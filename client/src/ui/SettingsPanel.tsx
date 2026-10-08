import { useState } from 'react';
import { setMyName } from '../api/ws';
import { engineVersion } from '../engine/book';
import { DEFAULT_PYODIDE_INDEX, pyodideIndexURL, resetPython, setPyodideIndexURL } from '../workers/runner';

export function SettingsPanel() {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('gridwright.name') ?? '';
    } catch {
      return '';
    }
  });
  const [pyUrl, setPyUrl] = useState(pyodideIndexURL());
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  return (
    <div className="panel">
      <div className="panel-title">Settings</div>
      <label className="field">
        <span>Your name (shown to collaborators)</span>
        <input value={name} onKeyDown={stop} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && setMyName(name.trim())} />
      </label>
      <label className="field">
        <span>Pyodide (Python runtime) URL</span>
        <input value={pyUrl} onKeyDown={stop} onChange={(e) => setPyUrl(e.target.value)} />
      </label>
      <div className="row">
        <button
          className="primary"
          onClick={() => {
            setPyodideIndexURL(pyUrl.trim() || DEFAULT_PYODIDE_INDEX);
            resetPython();
          }}
        >
          Apply &amp; restart Python
        </button>
        <button
          onClick={() => {
            setPyUrl(DEFAULT_PYODIDE_INDEX);
            setPyodideIndexURL(DEFAULT_PYODIDE_INDEX);
            resetPython();
          }}
        >
          Reset to CDN
        </button>
      </div>
      <p className="muted small">
        Python cells run in your browser through Pyodide (WebAssembly). By default the runtime is fetched from jsDelivr; for an offline server, serve the Pyodide distribution yourself (e.g. <code>/pyodide/</code>) and put that URL here.
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
            <td>Delete</td>
            <td>clear the selection</td>
          </tr>
          <tr>
            <td>Wheel / Ctrl+Wheel / Space+drag</td>
            <td>pan / zoom / pan</td>
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
