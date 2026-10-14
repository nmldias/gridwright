// The client (tenant) a browser tab works in, with accounts on (GRIDWRIGHT_AUTH=accounts). Each tab
// keeps its own (sessionStorage), so one person can have two clients open side by side; it is sent
// with every request to this server as `x-gridwright-tenant` and on the WebSocket as `?tenant=`.
// The server decides: a client the person is not a member of is refused, never silently swapped.

const KEY = 'gridwright.tenant';

export function currentTenant(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function setCurrentTenant(id: string) {
  try {
    if (id) sessionStorage.setItem(KEY, id);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* private mode: the session's default client applies */
  }
}

/** What the server's accounts gate said about the last request (signed out, password to change, no client). */
export type AuthSignal = 'signed-out' | 'change-password' | 'no-client';
const AUTH_EVENT = 'gridwright:auth';

export function onAuthSignal(fn: (s: AuthSignal) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<AuthSignal>).detail);
  window.addEventListener(AUTH_EVENT, h);
  return () => window.removeEventListener(AUTH_EVENT, h);
}

const sameOrigin = (url: string) => url.startsWith('/') || url.startsWith(location.origin + '/');

/** `fetch` for this server: the tab's client is named on every request, and auth signals are broadcast. */
export async function tenantFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!sameOrigin(url)) return window.fetch(input, init);
  const t = currentTenant();
  let req = init;
  if (t) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('x-gridwright-tenant', t);
    req = { ...init, headers };
  }
  const res = await window.fetch(input, req);
  const signal = res.headers.get('x-gridwright-auth') as AuthSignal | null;
  if (signal && !url.includes('/api/auth/')) window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: signal }));
  return res;
}

/** Open the app in another client: a fresh page, so nothing of the previous client stays in memory. */
export function switchTenant(t: { id: string; slug: string }) {
  setCurrentTenant(t.id);
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set('tenant', t.slug);
  location.assign(url.toString());
}
