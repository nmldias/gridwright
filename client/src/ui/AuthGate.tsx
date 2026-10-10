// The way in, with accounts on (GRIDWRIGHT_AUTH=accounts): sign in, change a temporary password,
// pick a client. Without accounts the app opens directly, as before. When a session ends while the
// app is open (expired, signed out elsewhere, removed from the client), the screen is shown over the
// app instead of replacing it, so nothing unsaved is thrown away before the person signs in again.
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { accounts } from '../api/accounts';
import { api } from '../api/client';
import { currentTenant, onAuthSignal, setCurrentTenant, switchTenant } from '../api/tenant';
import { useStore, type Me } from '../state/store';
import { PlatformConsole } from './AdminPanel';

type Screen = { kind: 'login'; note?: string } | { kind: 'password'; me: Me } | { kind: 'no-client'; me: Me } | { kind: 'invite'; code: string } | null;

const dropInvite = () => {
  const url = new URL(location.href);
  url.searchParams.delete('invite');
  history.replaceState(null, '', url.toString());
};

export function AuthGate({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  const [checking, setChecking] = useState(true);
  const [screen, setScreen] = useState<Screen>(null);
  const openedRef = useRef(false);

  const check = useCallback(async (note?: string) => {
    try {
      const h = await api.health();
      if (h.auth !== 'accounts') {
        openedRef.current = true;
        setOpened(true);
        setScreen(null);
        return;
      }
      // ?invite=<code>: an invitation link — accepted (or set aside) before anything else
      const invite = new URLSearchParams(location.search).get('invite');
      if (invite) return setScreen({ kind: 'invite', code: invite });
      // ?tenant=<slug> names the client of this tab (links, bookmarks); it wins over what the tab had
      const fromUrl = new URLSearchParams(location.search).get('tenant');
      if (fromUrl) setCurrentTenant(fromUrl);
      let me = await api.me();
      // a remembered client the person no longer belongs to: forget it and take the default
      if (me.authenticated && me.denied === 'not-a-member' && !fromUrl && currentTenant()) {
        setCurrentTenant('');
        me = await api.me();
      }
      if (!me.authenticated) return setScreen({ kind: 'login', note });
      if (me.mustChangePassword) return setScreen({ kind: 'password', me });
      if (!me.tenant) return setScreen({ kind: 'no-client', me });
      setCurrentTenant(me.tenant.id);
      const url = new URL(location.href);
      if (url.searchParams.get('tenant') !== me.tenant.slug) {
        url.searchParams.set('tenant', me.tenant.slug);
        history.replaceState(null, '', url.toString());
      }
      useStore.setState({ me });
      openedRef.current = true;
      setOpened(true);
      setScreen(null);
    } catch {
      // the server is not reachable: the app says so itself and the spreadsheet still works
      openedRef.current = true;
      setOpened(true);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
    return onAuthSignal((s) => {
      if (s === 'signed-out') setScreen({ kind: 'login', note: openedRef.current ? 'Your session ended — sign in again to continue. Unsaved changes are kept in this tab.' : undefined });
      else void check();
    });
  }, [check]);

  if (checking && !opened) {
    return (
      <div className="boot">
        <div className="logo big">▦</div>
        <div>connecting…</div>
      </div>
    );
  }
  const overlay = screen && (
    <div className={opened ? 'auth-overlay' : 'auth-screen'}>
      {screen.kind === 'login' && <LoginCard note={screen.note} onDone={() => void check()} />}
      {screen.kind === 'password' && <PasswordCard me={screen.me} onDone={() => void check()} />}
      {screen.kind === 'no-client' && <NoClientCard me={screen.me} />}
      {screen.kind === 'invite' && (
        <InviteCard
          code={screen.code}
          onDone={(tenant) => {
            dropInvite();
            if (tenant) {
              setCurrentTenant(tenant);
              const url = new URL(location.href);
              url.searchParams.delete('tenant');
              history.replaceState(null, '', url.toString());
            }
            void check();
          }}
        />
      )}
    </div>
  );
  return (
    <>
      {opened && children}
      {overlay}
    </>
  );
}

function Brand({ sub }: { sub: string }) {
  return (
    <div className="auth-brand">
      <span className="logo big">▦</span>
      <div>
        <div className="auth-title">Gridwright</div>
        <div className="muted small">{sub}</div>
      </div>
    </div>
  );
}

function LoginCard({ note, onDone }: { note?: string; onDone: () => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await accounts.login(login.trim(), password, currentTenant() || undefined);
      if (r.tenant && !currentTenant()) setCurrentTenant(r.tenant.id);
      setPassword('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="auth-card" onSubmit={(e) => void submit(e)} onKeyDown={(e) => e.stopPropagation()}>
      <Brand sub="Sign in to your workspace" />
      {note && <div className="auth-note">{note}</div>}
      <label className="field">
        <span>E-mail</span>
        <input autoFocus type="email" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && <div className="err small">{error}</div>}
      <button className="primary" type="submit" disabled={busy || !login || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="muted small">No account? Your client's administrator invites you with a link.</p>
    </form>
  );
}

/** An invitation link: join the client with the password of one's account, or choose one when new. */
function InviteCard({ code, onDone }: { code: string; onDone: (tenant?: string) => void }) {
  const [inv, setInv] = useState<{ tenant: string; login: string; role: string; expiresAt: string } | null>(null);
  const [gone, setGone] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    accounts
      .invitation(code)
      .then(setInv)
      .catch((e) => setGone((e as Error).message));
  }, [code]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await accounts.acceptInvitation(code, password, name.trim() || undefined);
      setPassword('');
      onDone(r.tenant.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (gone) {
    return (
      <div className="auth-card">
        <Brand sub="Invitation" />
        <div className="auth-note">{gone}</div>
        <button className="primary" onClick={() => onDone()}>
          Continue
        </button>
      </div>
    );
  }
  if (!inv) {
    return (
      <div className="auth-card">
        <Brand sub="Invitation" />
        <div className="muted small">checking the invitation…</div>
      </div>
    );
  }
  return (
    <form className="auth-card" onSubmit={(e) => void submit(e)} onKeyDown={(e) => e.stopPropagation()}>
      <Brand sub={`Join ${inv.tenant}`} />
      <div className="auth-note">
        You are invited to <b>{inv.tenant}</b> as <b>{inv.role}</b>.
      </div>
      <label className="field">
        <span>E-mail</span>
        <input type="email" autoComplete="username" value={inv.login} readOnly />
      </label>
      <label className="field">
        <span>Your name (if you are new here)</span>
        <input value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Password</span>
        <input autoFocus type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <div className="muted small">If you already have a Gridwright account, enter its password. Otherwise choose one now (at least 10 characters).</div>
      {error && <div className="err small">{error}</div>}
      <button className="primary" type="submit" disabled={busy || !password}>
        {busy ? 'Joining…' : `Join ${inv.tenant}`}
      </button>
      <button type="button" className="link" onClick={() => onDone()}>
        Not now
      </button>
    </form>
  );
}

export function PasswordForm({ me, onDone, temporary }: { me: Me; onDone: () => void; temporary?: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return setError('the two new passwords differ');
    setBusy(true);
    setError('');
    try {
      await accounts.changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="auth-form" onSubmit={(e) => void submit(e)} onKeyDown={(e) => e.stopPropagation()}>
      <input type="text" autoComplete="username" value={me.login} readOnly hidden />
      <label className="field">
        <span>{temporary ? 'Temporary password' : 'Current password'}</span>
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="field">
        <span>New password (at least 10 characters)</span>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </label>
      <label className="field">
        <span>New password again</span>
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
      </label>
      {error && <div className="err small">{error}</div>}
      <button className="primary" type="submit" disabled={busy || !current || !next}>
        {busy ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}

function PasswordCard({ me, onDone }: { me: Me; onDone: () => void }) {
  return (
    <div className="auth-card">
      <Brand sub={`Signed in as ${me.login}`} />
      <div className="auth-note">You signed in with a temporary password. Choose your own to continue — every other session of this account is signed out.</div>
      <PasswordForm me={me} onDone={onDone} temporary />
      <SignOut />
    </div>
  );
}

function NoClientCard({ me }: { me: Me }) {
  const others = (me.tenants ?? []).filter((t) => t.status !== 'suspended' || me.platformAdmin);
  const why =
    me.denied === 'suspended'
      ? 'This client account is suspended. Contact the platform administrator.'
      : me.denied === 'not-a-member'
        ? 'You are not a member of the client this link points to.'
        : 'You are not a member of any client yet. Ask an administrator for an invitation link.';
  return (
    <div className={`auth-card ${me.platformAdmin ? 'wide' : ''}`}>
      <Brand sub={`Signed in as ${me.login}`} />
      <div className="auth-note">{why}</div>
      {others.length > 0 && (
        <>
          <div className="panel-subtitle">Your clients</div>
          <div className="auth-clients">
            {others.map((t) => (
              <button key={t.id} onClick={() => switchTenant(t)}>
                <b>{t.name}</b> <span className="muted small">{t.role}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {me.platformAdmin && (
        <>
          <div className="panel-subtitle">Platform</div>
          <PlatformConsole me={me} />
        </>
      )}
      <SignOut />
    </div>
  );
}

export function SignOut({ className = 'link' }: { className?: string }) {
  return (
    <button
      className={className}
      onClick={async () => {
        try {
          await accounts.logout();
        } finally {
          setCurrentTenant('');
          location.assign(location.origin + location.pathname);
        }
      }}
    >
      Sign out
    </button>
  );
}
