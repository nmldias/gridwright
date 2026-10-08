import { useEffect, useRef, useState } from 'react';
import { api, type FileInfo } from '../api/client';
import { addTable } from '../grid/actions';
import { setStatus, useStore } from '../state/store';
import { downloadJson, newFile, openFile, parseCsv, saveCurrentFile } from './files';
import * as book from '../engine/book';
import { joinFile } from '../api/ws';

export function FilesPanel() {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileId = useStore((s) => s.fileId);
  const dirty = useStore((s) => s.dirty);
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      setFiles(await api.files.list());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
  }, [fileId, dirty]);

  const onImport = async (f: File) => {
    const text = await f.text();
    if (f.name.toLowerCase().endsWith('.json')) {
      try {
        JSON.parse(text);
        await book.loadBook(text, f.name.replace(/\.gridwright\.json$|\.json$/i, ''), null);
        joinFile(null);
        setStatus(`Loaded ${f.name}`);
      } catch (e) {
        setStatus(`Not a Gridwright document: ${(e as Error).message}`);
      }
      return;
    }
    const rows = parseCsv(text);
    if (!rows.length) {
      setStatus('The file is empty.');
      return;
    }
    addTable({ name: f.name.replace(/\.(csv|tsv|txt)$/i, ''), rows: rows.length, cols: Math.max(...rows.map((r) => r.length)), values: rows });
    setStatus(`Imported ${rows.length} rows into a new table`);
  };

  return (
    <div className="panel">
      <div className="panel-title">Files</div>
      <div className="row wrap">
        <button onClick={() => void newFile()}>New</button>
        <button className="primary" onClick={() => void saveCurrentFile()}>
          Save
        </button>
        <button onClick={() => importRef.current?.click()}>Import CSV / JSON</button>
        <button onClick={downloadJson}>Download JSON</button>
        <input
          ref={importRef}
          type="file"
          accept=".csv,.tsv,.txt,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImport(f);
            e.target.value = '';
          }}
        />
      </div>
      {error && <div className="err small">Server unavailable: {error}</div>}
      <div className="panel-subtitle">Documents on the server</div>
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id} className={f.id === fileId ? 'current' : ''}>
            <button className="link" onClick={() => void openFile(f.id)}>
              {f.name}
            </button>
            <span className="muted small">{new Date(f.updatedAt).toLocaleString()}</span>
            <button
              className="icon"
              title="Delete"
              onClick={async () => {
                if (!confirm(`Delete "${f.name}"?`)) return;
                await api.files.remove(f.id);
                if (f.id === fileId) useStore.setState({ fileId: null });
                void refresh();
              }}
            >
              ×
            </button>
          </li>
        ))}
        {!files.length && !error && <li className="muted">No documents yet — Save to create one.</li>}
      </ul>
      <p className="muted small">Documents autosave a few seconds after each change once they have been saved once. Anyone opening the same document edits it live with you.</p>
    </div>
  );
}
