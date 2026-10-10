import { useEffect, useRef, useState } from 'react';
import { api, type FileInfo } from '../api/client';
import { setStatus, useStore } from '../state/store';
import { downloadJson, newFile, openFile, saveCurrentFile } from './files';
import { exportWorkbookXlsx } from './xlsx';
import { TEMPLATES, applyTemplate } from './templates';
import { IMPORT_ACCEPT, importFile } from './import';
import { PanelHeader } from './PanelHeader';

export function FilesPanel() {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const filesView = useStore((s) => s.filesView);
  const showTemplates = filesView === 'templates';
  const setShowTemplates = (v: boolean | ((x: boolean) => boolean)) => useStore.setState({ filesView: (typeof v === 'function' ? v(showTemplates) : v) ? 'templates' : 'documents' });
  const fileId = useStore((s) => s.fileId);
  const dirty = useStore((s) => s.dirty);
  const me = useStore((s) => s.me);
  const fileFolder = useStore((s) => s.fileFolder);
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
  const setFolder = async (folder: string) => {
    useStore.setState({ fileFolder: folder });
    if (!fileId) return;
    try {
      await api.files.setAccess(fileId, { folder });
      void refresh();
    } catch (e) {
      setStatus(`Could not move the document: ${(e as Error).message}`, 5000);
    }
  };

  // group by folder
  const folders = new Map<string, FileInfo[]>();
  for (const f of files) {
    const key = f.folder || '';
    if (!folders.has(key)) folders.set(key, []);
    folders.get(key)!.push(f);
  }
  const folderNames = Array.from(folders.keys()).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));

  return (
    <div className="panel">
      <PanelHeader title="Files" />
      <div className="row wrap">
        <button onClick={() => void newFile()}>New</button>
        <button onClick={() => setShowTemplates((v) => !v)} className={showTemplates ? 'active' : ''}>
          Templates
        </button>
        <button className="primary" onClick={() => void saveCurrentFile()}>
          Save
        </button>
        <button onClick={() => importRef.current?.click()}>Import CSV / Excel / JSON</button>
        <button onClick={() => void exportWorkbookXlsx()} title="Every table becomes a sheet; formulas, formats and column widths are kept">
          Download .xlsx
        </button>
        <button onClick={downloadJson}>Download JSON</button>
        {(me.auth === 'accounts' ? me.platformAdmin : me.role === 'admin') && (
          <a className="button" href="/api/backup" download title="tar.gz of the server's data directory: documents, history, connections (encrypted), settings">
            Backup
          </a>
        )}
        <input
          ref={importRef}
          type="file"
          accept={IMPORT_ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = '';
          }}
        />
      </div>
      {showTemplates && (
        <div className="templates">
          {TEMPLATES.map((t) => (
            <button key={t.id} className="list-item template" onClick={() => void applyTemplate(t.id).then(() => setShowTemplates(false))} title={t.description}>
              <b>{t.name}</b>
              <span className="muted small">{t.description}</span>
            </button>
          ))}
        </div>
      )}
      <label className="row">
        <span className="muted small">Folder</span>
        <input
          className="grow"
          list="gw-folders"
          value={fileFolder}
          placeholder="e.g. Finance/2026"
          onChange={(e) => useStore.setState({ fileFolder: e.target.value })}
          onBlur={(e) => void setFolder(e.target.value.trim())}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <datalist id="gw-folders">
          {folderNames.filter(Boolean).map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </label>
      {error && <div className="err small">Server unavailable: {error}</div>}
      <div className="panel-subtitle">Documents on the server</div>
      {folderNames.map((folder) => (
        <div key={folder || '(root)'} className="folder">
          {folder && <div className="folder-name">📁 {folder}</div>}
          <ul className="file-list">
            {folders.get(folder)!.map((f) => (
              <li key={f.id} className={f.id === fileId ? 'current' : ''}>
                <button className="link" onClick={() => void openFile(f.id)}>
                  {f.name}
                </button>
                {f.permission && f.permission !== 'own' && f.permission !== 'edit' && <span className="pill">{f.permission}</span>}
                {(f.public === 'none' || f.public === 'view') && <span className="pill" title={f.public === 'none' ? 'private: owner and shared people only' : 'others can view'}>{f.public === 'none' ? 'private' : 'view-only'}</span>}
                <span className="muted small">{new Date(f.updatedAt).toLocaleString()}</span>
                {(f.permission === 'own' || !f.permission) && (
                  <button
                    className="icon"
                    title="Delete"
                    onClick={async () => {
                      if (!confirm(`Delete "${f.name}"?`)) return;
                      try {
                        await api.files.remove(f.id);
                        if (f.id === fileId) useStore.setState({ fileId: null });
                      } catch (e) {
                        setStatus((e as Error).message, 5000);
                      }
                      void refresh();
                    }}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!files.length && !error && <div className="muted">No documents yet — Save to create one.</div>}
      <p className="muted small">Documents autosave a few seconds after each change once they have been saved once. Who can open one is set under Share.</p>
    </div>
  );
}
