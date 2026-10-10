import { useEffect, useState } from 'react';
import { PanelHeader } from './PanelHeader';
import { api, type FileAccess } from '../api/client';
import { accounts, type Member } from '../api/accounts';
import { setStatus, useStore } from '../state/store';
import { saveCurrentFile } from './files';
import { openPrintView } from './print';
import { exportWorkbookXlsx } from './xlsx';
import { downloadJson } from './files';

const LEVEL_LABEL: Record<'view' | 'sign' | 'edit', string> = { view: 'can view', sign: 'can sign off', edit: 'can edit' };

/** Who can open the document and what they may do; plus the ways a copy leaves the server. */
export function SharePanel() {
  const fileId = useStore((s) => s.fileId);
  const fileName = useStore((s) => s.fileName);
  const me = useStore((s) => s.me);
  const permission = useStore((s) => s.permission);
  const [access, setAccess] = useState<FileAccess | null>(null);
  const [shareLogin, setShareLogin] = useState('');
  const [shareLevel, setShareLevel] = useState<'view' | 'edit' | 'sign'>('edit');
  const [copied, setCopied] = useState(false);
  // accounts mode: a document is shared within its client, so the people to pick from are its members
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    if (me.auth !== 'accounts') return;
    accounts.tenant
      .members()
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [me.auth, me.tenant?.id]);
  const clientName = access?.client?.name ?? me.tenant?.name;
  useEffect(() => {
    setAccess(null);
    if (!fileId) return;
    api.files
      .access(fileId)
      .then(setAccess)
      .catch(() => setAccess(null));
  }, [fileId, permission]);

  const updateAccess = async (patch: Partial<FileAccess>) => {
    if (!fileId) return;
    try {
      const a = await api.files.setAccess(fileId, patch);
      setAccess(a);
      useStore.setState({ permission: a.permission });
    } catch (e) {
      setStatus(`Sharing not changed: ${(e as Error).message}`, 5000);
    }
  };
  const canManage = access?.permission === 'own';
  const link = fileId ? `${location.origin}${location.pathname}?file=${encodeURIComponent(fileId)}${me.tenant?.slug ? `&tenant=${encodeURIComponent(me.tenant.slug)}` : ''}` : '';

  return (
    <div className="panel share-panel">
      <PanelHeader title="Share" />
      {!fileId ? (
        <>
          <p className="muted small">Save the document to the server to share it; it then opens live for everyone with access.</p>
          <button className="primary" onClick={() => void saveCurrentFile()}>
            Save “{fileName}”
          </button>
        </>
      ) : (
        <>
          <div className="row">
            <input className="grow" readOnly value={link} onFocus={(e) => e.target.select()} onKeyDown={(e) => e.stopPropagation()} />
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          {access && access.identity ? (
            <>
              <div className="small">
                Owner: {access.ownerName || access.owner || 'nobody (open document)'}
                {access.owner && access.owner === me.login.toLowerCase() ? ' (you)' : ''}
              </div>
              <label className="row">
                <span className="muted small grow">{me.auth === 'accounts' ? `Everyone in ${clientName ?? 'this client'}` : 'Everyone on this server'}</span>
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
                    {(['view', 'sign', 'edit'] as const).map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_LABEL[l]}
                      </option>
                    ))}
                  </select>
                  <button
                    className="icon"
                    disabled={!canManage}
                    title="Remove access"
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
                  <input className="grow" list={members.length ? 'share-members' : undefined} placeholder={me.auth === 'accounts' ? 'a member of this client' : 'login (e.g. ana@example.com)'} value={shareLogin} onChange={(e) => setShareLogin(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
                  {members.length > 0 && (
                    <datalist id="share-members">
                      {members
                        .filter((m) => m.login !== access.owner && !(m.login in access.shares))
                        .map((m) => (
                          <option key={m.login} value={m.login}>
                            {m.name} · {m.role}
                          </option>
                        ))}
                    </datalist>
                  )}
                  <select value={shareLevel} onChange={(e) => setShareLevel(e.target.value as 'view' | 'edit' | 'sign')}>
                    {(['view', 'sign', 'edit'] as const).map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_LABEL[l]}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary"
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
              <p className="muted small">
                “Can sign off” lets someone attest ranges in Review without editing values. Access changes reach open sessions at once.
                {me.auth === 'accounts' && ` Only members of ${clientName ?? 'this client'} can be given access; administrators of the client see every document in it.`}
              </p>
            </>
          ) : (
            <p className="muted small">This server does not identify people, so everyone who can reach it can open the link. Put it behind Tailscale to share by login.</p>
          )}
        </>
      )}
      <div className="panel-subtitle">Send a copy</div>
      <div className="row wrap">
        <button onClick={() => openPrintView()} title="Print or save as PDF: tables and charts">
          Print / PDF
        </button>
        <button onClick={() => void exportWorkbookXlsx()} title="Every table becomes a sheet; formulas, formats and column widths are kept">
          Download .xlsx
        </button>
        <button onClick={downloadJson} title="The document as Gridwright JSON">
          Download JSON
        </button>
      </div>
    </div>
  );
}
