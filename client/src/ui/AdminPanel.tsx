// Clients & people (accounts mode): the members of the client this tab works in — its
// administrators add people, change roles, remove them —, one's own account (password, API tokens),
// the activity trail, and for platform administrators the console: every client (create, suspend,
// seats, delete when empty), every person, and the model endpoint clients use by default.
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { accounts, type AddedPerson, type ApiToken, type AuditEntry, type Member, type Role, type TenantInfo, type UserInfo } from '../api/accounts';
import { switchTenant } from '../api/tenant';
import { useStore, type Me } from '../state/store';
import { PasswordForm, SignOut } from './AuthGate';
import { PanelHeader } from './PanelHeader';

type View = 'members' | 'activity' | 'account' | 'clients' | 'people';
const ROLES: Role[] = ['admin', 'editor', 'viewer'];
const ROLE_HINT: Record<Role, string> = {
  admin: 'manages the client: people, connections, model settings — and every document in it',
  editor: 'creates and edits documents, runs queries',
  viewer: 'reads what is shared with them',
};
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const stop = (e: React.KeyboardEvent) => e.stopPropagation();

export function AdminPanel() {
  const me = useStore((s) => s.me);
  const view = useStore((s) => s.adminView);
  const setView = (v: View) => useStore.setState({ adminView: v });
  const isAdmin = me.role === 'admin';
  const tabs: [View, string][] = [['members', 'Members'], ...(isAdmin ? ([['activity', 'Activity']] as [View, string][]) : []), ['account', 'My account'], ...(me.platformAdmin ? ([['clients', 'Clients'], ['people', 'People']] as [View, string][]) : [])];
  const current = tabs.some(([v]) => v === view) ? view : 'members';
  return (
    <div className="panel admin-panel">
      <PanelHeader title="Clients & people" subtitle={me.tenant?.name} />
      <div className="row tabs">
        {tabs.map(([v, label]) => (
          <button key={v} className={current === v ? 'active' : ''} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
      </div>
      <div className="admin-body">
        {current === 'members' && <MembersView me={me} />}
        {current === 'activity' && <ActivityView me={me} />}
        {current === 'account' && <AccountView me={me} />}
        {current === 'clients' && <PlatformConsole me={me} />}
        {current === 'people' && <PeopleView me={me} />}
      </div>
    </div>
  );
}

/** A password or token shown once, to copy and hand over. */
function Secret({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret-box">
      <div className="small">{label}</div>
      <div className="row">
        <code className="grow secret-value">{value}</code>
        <button
          className="small"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="small" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="muted small">It is shown only now. Send it privately; it must be changed at first sign-in.</div>
    </div>
  );
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    load()
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => reload(), [reload]);
  return { data, error, reload, setError };
}

// ------------------------------------------------------------------ members of the current client
function AddPersonForm({ onAdd, label = 'Add person' }: { onAdd: (p: { login: string; name?: string; role: Role }) => Promise<AddedPerson>; label?: string }) {
  const [login, setLogin] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<{ login: string; pw: string } | null>(null);
  const [note, setNote] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNote('');
    try {
      const r = await onAdd({ login: login.trim(), name: name.trim() || undefined, role });
      if (r.temporaryPassword) setSecret({ login: r.login, pw: r.temporaryPassword });
      else setNote(`${r.login} already had an account and was added as ${r.role}.`);
      setLogin('');
      setName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form className="admin-form" onSubmit={(e) => void submit(e)} onKeyDown={stop}>
        <div className="row wrap">
          <input className="grow" type="email" placeholder="e-mail" value={login} onChange={(e) => setLogin(e.target.value)} required />
          <input className="grow" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="row">
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} title={ROLE_HINT[role]}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span className="muted small grow">{ROLE_HINT[role]}</span>
          <button className="primary" type="submit" disabled={busy || !login}>
            {busy ? 'Adding…' : label}
          </button>
        </div>
        {error && <div className="err small">{error}</div>}
        {note && <div className="muted small">{note}</div>}
      </form>
      {secret && <Secret label={`Temporary password for ${secret.login}`} value={secret.pw} onClose={() => setSecret(null)} />}
    </>
  );
}

function MemberRow({ m, me, canManage, onRole, onRemove, onReset }: { m: Member; me: Me; canManage: boolean; onRole: (r: Role) => void; onRemove: () => void; onReset?: () => void }) {
  return (
    <li className="member-row">
      <div className="grow member-who">
        <div>
          <b>{m.name || m.login}</b> {m.login === me.login && <span className="pill">you</span>} {m.status === 'disabled' && <span className="pill error">disabled</span>}
        </div>
        <div className="muted small">
          {m.login} · last sign-in {when(m.lastLoginAt)}
        </div>
      </div>
      {canManage ? (
        <div className="member-actions">
          <select value={m.role} onChange={(e) => onRole(e.target.value as Role)} title={ROLE_HINT[m.role]}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {onReset && (
            <button className="small" onClick={onReset} title="Give them a new temporary password">
              Reset password
            </button>
          )}
          <button className="small danger" onClick={onRemove} title="Remove from this client: access ends at once">
            Remove
          </button>
        </div>
      ) : (
        <span className="pill">{m.role}</span>
      )}
    </li>
  );
}

function MembersView({ me }: { me: Me }) {
  const isAdmin = me.role === 'admin';
  const tenant = useLoad(() => accounts.tenant.get(), []);
  const members = useLoad(() => accounts.tenant.members(), []);
  const [secret, setSecret] = useState<{ login: string; pw: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const t = tenant.data;
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      members.reload();
      tenant.reload();
    } catch (e) {
      members.setError((e as Error).message);
    }
  };
  return (
    <>
      {t && (
        <div className="client-card">
          {renaming !== null ? (
            <form
              className="row"
              onKeyDown={stop}
              onSubmit={(e) => {
                e.preventDefault();
                void act(() => accounts.tenant.rename(renaming)).then(() => setRenaming(null));
              }}
            >
              <input className="grow" autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} />
              <button className="primary small" type="submit">
                Save
              </button>
              <button className="small" type="button" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <div className="row">
              <b className="grow client-name">{t.name}</b>
              {isAdmin && (
                <button className="small" onClick={() => setRenaming(t.name)}>
                  Rename
                </button>
              )}
            </div>
          )}
          <div className="muted small">
            {t.slug} · plan {t.plan} · {t.members} member{t.members === 1 ? '' : 's'}
            {t.seats ? ` of ${t.seats} seats` : ''} · your role: <b>{me.role}</b>
          </div>
        </div>
      )}
      {isAdmin && (
        <>
          <div className="panel-subtitle">Add someone to this client</div>
          <AddPersonForm onAdd={async (p) => {
            const r = await accounts.tenant.add(p);
            members.reload();
            tenant.reload();
            return r;
          }} />
        </>
      )}
      <div className="panel-subtitle">Members</div>
      {members.error && <div className="err small">{members.error}</div>}
      {secret && <Secret label={`New temporary password for ${secret.login}`} value={secret.pw} onClose={() => setSecret(null)} />}
      <ul className="member-list">
        {(members.data ?? []).map((m) => (
          <MemberRow
            key={m.login}
            m={m}
            me={me}
            canManage={isAdmin}
            onRole={(r) => void act(() => accounts.tenant.setRole(m.login, r))}
            onRemove={() => {
              if (confirm(`Remove ${m.name || m.login} from ${t?.name ?? 'this client'}? Their access ends at once; their account and what they wrote stay.`)) void act(() => accounts.tenant.remove(m.login));
            }}
            onReset={
              m.login === me.login
                ? undefined
                : () => {
                    if (!confirm(`Give ${m.login} a new temporary password? Their current password stops working and they are signed out.`)) return;
                    accounts.tenant
                      .resetPassword(m.login)
                      .then((r) => setSecret({ login: r.login, pw: r.temporaryPassword }))
                      .catch((e) => members.setError((e as Error).message));
                  }
            }
          />
        ))}
      </ul>
      <p className="muted small">
        Documents of this client are visible only to its members. Sharing a document narrows it further; a document cannot be shared outside the client.
      </p>
    </>
  );
}

// ------------------------------------------------------------------ the activity trail
const ACTION_LABEL: Record<string, string> = {
  'client.created': 'created the client',
  'client.updated': 'changed the client',
  'client.deleted': 'deleted the client',
  'client.ai-settings': 'changed the model settings',
  'member.added': 'added',
  'member.removed': 'removed',
  'member.role-changed': 'changed the role of',
  'user.created': 'created the account of',
  'user.updated': 'changed the account of',
  'user.password-reset': 'reset the password of',
  'user.password-changed': 'changed their password',
  'token.created': 'made an API token',
  'token.revoked': 'revoked an API token',
  'auth.signed-in': 'signed in',
  'auth.signed-out': 'signed out',
  'auth.failed': 'failed to sign in',
  'platform.ai-settings': 'changed the platform model default',
};

function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <div className="muted small">Nothing yet.</div>;
  return (
    <ul className="audit-list">
      {entries.map((e) => (
        <li key={e.seq}>
          <div>
            <b>{e.actor}</b> {ACTION_LABEL[e.action] ?? e.action} {e.target && e.target !== e.actor ? <b>{e.target}</b> : null}
            {e.detail ? <span className="muted"> — {e.detail}</span> : null}
          </div>
          <div className="muted small">{when(e.at)}</div>
        </li>
      ))}
    </ul>
  );
}

function ActivityView({ me }: { me: Me }) {
  const [all, setAll] = useState(false);
  const trail = useLoad(() => (all && me.platformAdmin ? accounts.platform.audit() : accounts.tenant.audit()), [all]);
  return (
    <>
      <div className="row">
        <span className="muted small grow">Every change to people, roles and settings{all ? ' on the whole platform' : ' in this client'}, newest first.</span>
        {me.platformAdmin && (
          <label className="field check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>all clients</span>
          </label>
        )}
      </div>
      {trail.error && <div className="err small">{trail.error}</div>}
      <AuditList entries={trail.data ?? []} />
    </>
  );
}

// ------------------------------------------------------------------ one's own account
function AccountView({ me }: { me: Me }) {
  const [name, setName] = useState(me.name);
  const [saved, setSaved] = useState('');
  const tokens = useLoad(() => accounts.tokens.list(), []);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);
  const clientName = (id: string | null) => me.tenants?.find((t) => t.id === id)?.name ?? id ?? '—';
  return (
    <>
      <form
        className="row"
        onKeyDown={stop}
        onSubmit={(e) => {
          e.preventDefault();
          accounts
            .rename(name.trim())
            .then((u) => {
              useStore.setState({ me: { ...me, name: u.name } });
              setSaved('saved');
            })
            .catch((err) => setSaved((err as Error).message));
        }}
      >
        <label className="field">
          <span>Your name (shown to collaborators and in the history) · {me.login}</span>
          <input value={name} onChange={(e) => (setName(e.target.value), setSaved(''))} />
        </label>
        <button type="submit" disabled={!name.trim() || name === me.name}>
          Save
        </button>
        {saved && <span className="muted small">{saved}</span>}
      </form>
      <div className="panel-subtitle">Your clients</div>
      <div className="auth-clients">
        {(me.tenants ?? []).map((t) => (
          <button key={t.id} className={t.id === me.tenant?.id ? 'active' : ''} disabled={t.id === me.tenant?.id || (t.status === 'suspended' && !me.platformAdmin)} onClick={() => switchTenant(t)} title={t.id === me.tenant?.id ? 'this tab' : 'open in this tab'}>
            <b>{t.name}</b> <span className="muted small">{t.role}{t.status === 'suspended' ? ' · suspended' : ''}</span>
          </button>
        ))}
      </div>
      <div className="panel-subtitle">Password</div>
      {pwDone ? <div className="muted small">Password changed. Your other sessions were signed out.</div> : <PasswordForm me={me} onDone={() => setPwDone(true)} />}
      <div className="panel-subtitle">API tokens (MCP clients, scripts)</div>
      <p className="muted small">
        A token acts as you, in <b>{me.tenant?.name}</b> only, with your role there. Send it as <code>Authorization: Bearer …</code> to <code>/mcp</code> or the API.
      </p>
      <form
        className="row"
        onKeyDown={stop}
        onSubmit={(e) => {
          e.preventDefault();
          accounts.tokens
            .create(label.trim() || 'API token')
            .then((t) => {
              setSecret(t.token);
              setLabel('');
              tokens.reload();
            })
            .catch((err) => tokens.setError((err as Error).message));
        }}
      >
        <input className="grow" placeholder="label, e.g. Claude Desktop" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit">Make a token</button>
      </form>
      {secret && <Secret label="Your new API token" value={secret} onClose={() => setSecret(null)} />}
      {tokens.error && <div className="err small">{tokens.error}</div>}
      <ul className="member-list">
        {(tokens.data ?? []).map((t: ApiToken) => (
          <li key={t.id} className="member-row">
            <div className="grow">
              <b>{t.label}</b>
              <div className="muted small">
                {clientName(t.tenant)} · made {when(t.createdAt)} · last used {when(t.lastSeenAt)}
              </div>
            </div>
            <button
              className="small danger"
              onClick={() => {
                if (confirm(`Revoke “${t.label}”? Whatever uses it stops working at once.`)) void accounts.tokens.revoke(t.id).then(() => tokens.reload());
              }}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <SignOut className="" />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ the platform console
function NewClientForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [plan, setPlan] = useState('standard');
  const [seats, setSeats] = useState('');
  const [admin, setAdmin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<{ login: string; pw: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await accounts.platform.createTenant({ name: name.trim(), plan, seats: seats ? Number(seats) : null, admin: admin.trim() ? { login: admin.trim() } : undefined });
      if (r.admin?.temporaryPassword) setSecret({ login: r.admin.login, pw: r.admin.temporaryPassword });
      setName('');
      setSeats('');
      setAdmin('');
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form className="admin-form" onSubmit={(e) => void submit(e)} onKeyDown={stop}>
        <div className="row wrap">
          <input className="grow" placeholder="client name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input className="grow" type="email" placeholder="first admin's e-mail (optional)" value={admin} onChange={(e) => setAdmin(e.target.value)} />
        </div>
        <div className="row">
          <select value={plan} onChange={(e) => setPlan(e.target.value)} title="plan (a label for your records)">
            <option value="standard">standard</option>
            <option value="pro">pro</option>
            <option value="enterprise">enterprise</option>
            <option value="trial">trial</option>
          </select>
          <input type="number" min={1} placeholder="seats (∞)" value={seats} onChange={(e) => setSeats(e.target.value)} style={{ width: 100 }} title="most members the client may have; empty = unlimited" />
          <span className="grow" />
          <button className="primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create client'}
          </button>
        </div>
        <div className="muted small">You join it as an administrator; the first administrator gets a temporary password when they have no account.</div>
        {error && <div className="err small">{error}</div>}
      </form>
      {secret && <Secret label={`Temporary password for ${secret.login}`} value={secret.pw} onClose={() => setSecret(null)} />}
    </>
  );
}

function ClientRow({ t, me, onChange }: { t: TenantInfo; me: Me; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const mine = me.tenants?.find((x) => x.id === t.id);
  const loadMembers = () => accounts.platform.members(t.id).then(setMembers).catch((e) => setError((e as Error).message));
  const act = async (f: () => Promise<unknown>) => {
    setError('');
    try {
      await f();
      onChange();
      if (open) await loadMembers();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const empty = !t.documents && !t.connections;
  return (
    <li className="client-row">
      <div className="row">
        <div className="grow">
          <div>
            <b>{t.name}</b> <span className={`pill ${t.status === 'suspended' ? 'error' : 'ready'}`}>{t.status}</span> {t.id === me.tenant?.id && <span className="pill">this tab</span>}
          </div>
          <div className="muted small">
            {t.slug} · {t.plan} · {t.members} member{t.members === 1 ? '' : 's'}
            {t.seats ? `/${t.seats}` : ''} · {t.documents ?? 0} document{t.documents === 1 ? '' : 's'} · {t.connections ?? 0} connection{t.connections === 1 ? '' : 's'}
          </div>
        </div>
        <button className="small" onClick={() => (setOpen(!open), !open && void loadMembers())}>
          {open ? 'Close' : 'Manage'}
        </button>
        {mine ? (
          <button className="small" disabled={t.id === me.tenant?.id} onClick={() => switchTenant(t)} title="work in this client in this tab">
            Open
          </button>
        ) : (
          <button className="small" onClick={() => void act(() => accounts.platform.addMember(t.id, { login: me.login, role: 'admin' })).then(() => switchTenant(t))} title="join as administrator (recorded in the audit trail) and open">
            Join &amp; open
          </button>
        )}
      </div>
      {error && <div className="err small">{error}</div>}
      {open && (
        <div className="client-manage">
          <div className="row wrap">
            <button className="small" onClick={() => void act(() => accounts.platform.updateTenant(t.id, { status: t.status === 'active' ? 'suspended' : 'active' }))} title={t.status === 'active' ? 'members are locked out at once; nothing is deleted' : 'members can sign in again'}>
              {t.status === 'active' ? 'Suspend' : 'Reactivate'}
            </button>
            <label className="row small">
              seats
              <input
                type="number"
                min={1}
                defaultValue={t.seats ?? ''}
                placeholder="∞"
                style={{ width: 80 }}
                onKeyDown={stop}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (String(t.seats ?? '') !== v) void act(() => accounts.platform.updateTenant(t.id, { seats: v ? Number(v) : '' }));
                }}
              />
            </label>
            <select value={t.plan} onChange={(e) => void act(() => accounts.platform.updateTenant(t.id, { plan: e.target.value }))}>
              {Array.from(new Set(['standard', 'pro', 'enterprise', 'trial', t.plan])).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <span className="grow" />
            {t.id !== 'default' && (
              <button
                className="small danger"
                disabled={!empty}
                title={empty ? 'delete the client (its people keep their accounts)' : 'delete its documents and connections first — or suspend it'}
                onClick={() => {
                  if (confirm(`Delete the client “${t.name}”? Its members keep their accounts but lose access.`)) void act(() => accounts.platform.deleteTenant(t.id));
                }}
              >
                Delete
              </button>
            )}
          </div>
          <AddPersonForm
            label="Add"
            onAdd={async (p) => {
              const r = await accounts.platform.addMember(t.id, p);
              onChange();
              await loadMembers();
              return r;
            }}
          />
          <ul className="member-list">
            {(members ?? []).map((m) => (
              <MemberRow
                key={m.login}
                m={m}
                me={me}
                canManage
                onRole={(r) => void act(() => accounts.platform.setRole(t.id, m.login, r))}
                onRemove={() => {
                  if (confirm(`Remove ${m.login} from ${t.name}?`)) void act(() => accounts.platform.removeMember(t.id, m.login));
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function PlatformModel() {
  const cfg = useLoad(() => accounts.platform.ai(), []);
  const [draft, setDraft] = useState<{ baseUrl: string; model: string; apiKey: string } | null>(null);
  const [note, setNote] = useState('');
  const d = draft ?? (cfg.data ? { baseUrl: cfg.data.baseUrl, model: cfg.data.model, apiKey: '' } : null);
  if (!d) return cfg.error ? <div className="err small">{cfg.error}</div> : null;
  return (
    <form
      className="admin-form"
      onKeyDown={stop}
      onSubmit={(e) => {
        e.preventDefault();
        accounts.platform
          .saveAi({ baseUrl: d.baseUrl, model: d.model, ...(d.apiKey ? { apiKey: d.apiKey } : {}) })
          .then(() => {
            setDraft(null);
            cfg.reload();
            setNote('saved');
          })
          .catch((err) => setNote((err as Error).message));
      }}
    >
      <div className="row wrap">
        <input className="grow" placeholder="https://openrouter.ai/api/v1" value={d.baseUrl} onChange={(e) => setDraft({ ...d, baseUrl: e.target.value })} />
        <input className="grow" placeholder="model id" value={d.model} onChange={(e) => setDraft({ ...d, model: e.target.value })} />
      </div>
      <div className="row">
        <input className="grow" type="password" placeholder={cfg.data?.hasKey ? 'API key (set — leave empty to keep)' : 'API key'} value={d.apiKey} onChange={(e) => setDraft({ ...d, apiKey: e.target.value })} />
        <button className="primary" type="submit" disabled={!draft}>
          Save
        </button>
      </div>
      <div className="muted small">Clients without their own settings use this. The key is only ever sent to this endpoint — never to an endpoint a client enters itself. {note}</div>
    </form>
  );
}

export function PlatformConsole({ me }: { me: Me }) {
  const tenants = useLoad(() => accounts.platform.tenants(), []);
  const [q, setQ] = useState('');
  const list = (tenants.data ?? []).filter((t) => !q || `${t.name} ${t.slug}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="platform-console">
      <div className="panel-subtitle">New client</div>
      <NewClientForm onCreated={() => tenants.reload()} />
      <div className="row">
        <div className="panel-subtitle grow">Clients ({tenants.data?.length ?? 0})</div>
        <input placeholder="filter" value={q} onKeyDown={stop} onChange={(e) => setQ(e.target.value)} style={{ width: 140 }} />
      </div>
      {tenants.error && <div className="err small">{tenants.error}</div>}
      <ul className="client-list">
        {list.map((t) => (
          <ClientRow key={t.id} t={t} me={me} onChange={() => tenants.reload()} />
        ))}
      </ul>
      <div className="panel-subtitle">Default model endpoint</div>
      <PlatformModel />
    </div>
  );
}

function PeopleView({ me }: { me: Me }) {
  const users = useLoad(() => accounts.platform.users(), []);
  const [q, setQ] = useState('');
  const [secret, setSecret] = useState<{ login: string; pw: string } | null>(null);
  const [login, setLogin] = useState('');
  const [error, setError] = useState('');
  const act = async (f: () => Promise<unknown>) => {
    setError('');
    try {
      await f();
      users.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const list = (users.data ?? []).filter((u) => !q || `${u.login} ${u.name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <form
        className="row"
        onKeyDown={stop}
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            const r = await accounts.platform.createUser({ login: login.trim() });
            if (r.temporaryPassword) setSecret({ login: r.login, pw: r.temporaryPassword });
            setLogin('');
          });
        }}
      >
        <input className="grow" type="email" placeholder="e-mail (add to clients afterwards)" value={login} onChange={(e) => setLogin(e.target.value)} />
        <button type="submit" disabled={!login}>
          Create account
        </button>
      </form>
      {secret && <Secret label={`Temporary password for ${secret.login}`} value={secret.pw} onClose={() => setSecret(null)} />}
      <div className="row">
        <div className="panel-subtitle grow">People ({users.data?.length ?? 0})</div>
        <input placeholder="filter" value={q} onKeyDown={stop} onChange={(e) => setQ(e.target.value)} style={{ width: 140 }} />
      </div>
      {(error || users.error) && <div className="err small">{error || users.error}</div>}
      <ul className="member-list">
        {list.map((u: UserInfo) => (
          <li key={u.login} className="member-row">
            <div className="grow member-who">
              <div>
                <b>{u.name || u.login}</b> {u.platformAdmin && <span className="pill ready">platform admin</span>} {u.status === 'disabled' && <span className="pill error">disabled</span>} {u.mustChangePassword && <span className="pill loading">temporary password</span>}
              </div>
              <div className="muted small">
                {u.login} · {u.memberships.length ? u.memberships.map((m) => `${m.name} (${m.role})`).join(', ') : 'no client'} · last sign-in {when(u.lastLoginAt)}
              </div>
            </div>
            {u.login !== me.login && (
              <div className="member-actions">
                <button className="small" onClick={() => void act(() => accounts.platform.updateUser(u.login, { platformAdmin: !u.platformAdmin }))} title={u.platformAdmin ? 'no longer a platform administrator' : 'manages every client and person'}>
                  {u.platformAdmin ? 'Revoke admin' : 'Make admin'}
                </button>
                <button
                  className="small"
                  onClick={() => {
                    if (confirm(`Give ${u.login} a new temporary password?`)) void act(async () => {
                      const r = await accounts.platform.resetPassword(u.login);
                      setSecret({ login: r.login, pw: r.temporaryPassword });
                    });
                  }}
                >
                  Reset password
                </button>
                <button className="small danger" onClick={() => void act(() => accounts.platform.updateUser(u.login, { status: u.status === 'active' ? 'disabled' : 'active' }))} title={u.status === 'active' ? 'signs them out everywhere and blocks sign-in' : 'allow sign-in again'}>
                  {u.status === 'active' ? 'Disable' : 'Enable'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
