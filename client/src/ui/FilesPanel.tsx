import { useEffect, useRef, useState } from 'react';
import { api, type FileAccess, type FileInfo } from '../api/client';
import { addTable } from '../grid/actions';
import { setStatus, useStore } from '../state/store';
import { downloadJson, newFile, openFile, parseCsv, saveCurrentFile } from './files';
import * as book from '../engine/book';
import { joinFile } from '../api/ws';
import { exportWorkbookXlsx } from './xlsx';
import { TEMPLATES, applyTemplate } from './templates';

export function FilesPanel() {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [access, setAccess] = useState<FileAccess | null>(null);
  const [shareLogin, setShareLogin] = useState('');
  const [shareLevel, setShareLevel] = useState<'view' | 'edit' | 'sign'>('edit');
  const fileId = useStore((s) => s.fileId);
  const dirty = useStore((s) => s.dirty);
  const me = useStore((s) => s.me);
  const permission = useStore((s) => s.permission);
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
  useEffect(() => {
    setAccess(null);
    if (!fileId) return;
    api.files
      .access(fileId)
      .then(setAccess)
      .catch(() => setAccess(null));
  }, [fileId, permission]);

  const onImport = async (f: File) => {
    if (/\.(xlsx|xlsm|xls|ods)$/i.test(f.name)) {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: false, cellFormula: true, sheetStubs: true });
      let n = 0;
      for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        const rows: (string | number | boolean | null)[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
        if (!rows.length) continue;
        const values = rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))));
        // formulas are imported as their cached values; SheetJS exposes formulas via cell.f when present
        for (const addr of Object.keys(sheet)) {
          if (addr[0] === '!') continue;
          const cell = sheet[addr] as { f?: string };
          if (cell.f) {
            const p = XLSX.utils.decode_cell(addr);
            if (values[p.r]) values[p.r][p.c] = '=' + cell.f;
          }
        }
        addTable({ name: wb.SheetNames.length > 1 ? `${f.name.replace(/\.[^.]+$/, '')} ${name}` : f.name.replace(/\.[^.]+$/, ''), rows: values.length, cols: Math.max(...values.map((r) => r.length), 1), values, origin: 'import' });
        n++;
      }
      setStatus(`Imported ${n} sheet${n === 1 ? '' : 's'} from ${f.name}`);
      return;
    }
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
    addTable({ name: f.name.replace(/\.(csv|tsv|txt)$/i, ''), rows: rows.length, cols: Math.max(...rows.map((r) => r.length)), values: rows, origin: 'import' });
    setStatus(`Imported ${rows.length} rows into a new table`);
  };

  const setFolder = async (folder: string) => {
    useStore.setState({ fileFolder: folder });
    if (!fileId) return;
    try {
      const a = await api.files.setAccess(fileId, { folder });
      setAccess(a);
      void refresh();
    } catch (e) {
      setStatus(`Could not move the document: ${(e as Error).message}`, 5000);
    }
  };
  const updateAccess = async (patch: Partial<FileAccess>) => {
    if (!fileId) return;
    try {
      const a = await api.files.setAccess(fileId, patch);
      setAccess(a);
      useStore.setState({ permission: a.permission });
      void refresh();
    } catch (e) {
      setStatus(`Sharing not changed: ${(e as Error).message}`, 5000);
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
  const canManage = access?.permission === 'own';

  return (
    <div className="panel">
      <div className="panel-title">Files</div>
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
        {me.role === 'admin' && (
          <a className="button" href="/api/backup" download title="tar.gz of the server's data directory: documents, history, connections (encrypted), settings">
            Backup
          </a>
        )}
        <input
          ref={importRef}
          type="file"
          accept=".csv,.tsv,.txt,.json,.xlsx,.xlsm,.xls,.ods"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImport(f);
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
      {fileId && access && access.identity && (
        <>
          <div className="panel-subtitle">Sharing</div>
          <div className="small">
            Owner: {access.ownerName || access.owner || 'nobody (open document)'}
            {access.owner && access.owner === me.login.toLowerCase() ? ' (you)' : ''}
          </div>
          <label className="row">
            <span className="muted small">Everyone on this server</span>
            <select value={access.public} disabled={!canManage} onChange={(e) => void updateAccess({ public: e.target.value as FileAccess['public'] })}>
              <option value="edit">can edit</option>
              <option value="view">can view</option>
              <option value="none">no access</option>
            </select>
          </label>
          {Object.entries(access.shares).map(([login, level]) => (
            <div key={login} className="row small">
              <span className="grow">{login}</span>
              <select value={level} disabled={!canManage} onChange={(e) => void updateAccess({ shares: { ...access.shares, [login]: e.target.value as 'view' | 'edit' | 'sign' } })}>
                <option value="view">view</option>
                <option value="sign">sign off</option>
                <option value="edit">edit</option>
              </select>
              <button
                className="icon"
                disabled={!canManage}
                onClick={() => {
                  const next = { ...access.shares };
                  delete next[login];
                  void updateAccess({ shares: next });
                }}
              >
                ×
              </button>
            </div>
          ))}
          {canManage && (
            <div className="row">
              <input className="grow" placeholder="login (e.g. ana@example.com)" value={shareLogin} onChange={(e) => setShareLogin(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <select value={shareLevel} onChange={(e) => setShareLevel(e.target.value as 'view' | 'edit' | 'sign')}>
                <option value="view">view</option>
                <option value="sign">sign off</option>
                <option value="edit">edit</option>
              </select>
              <button
                disabled={!shareLogin.trim()}
                onClick={() => {
                  void updateAccess({ shares: { ...access.shares, [shareLogin.trim().toLowerCase()]: shareLevel } });
                  setShareLogin('');
                }}
              >
                Share
              </button>
            </div>
          )}
          {!access.owner && canManage && me.login && (
            <button className="link small" onClick={() => void updateAccess({ owner: me.login, ownerName: me.name })}>
              Take ownership (lets you restrict who sees this document)
            </button>
          )}
          <p className="muted small">“Sign off” lets someone attest ranges in the Review panel without editing values. Logins come from Tailscale.</p>
        </>
      )}
      <p className="muted small">Documents autosave a few seconds after each change once they have been saved once. Anyone opening the same document edits it live with you.</p>
    </div>
  );
}
