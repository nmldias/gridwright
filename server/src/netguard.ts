// Egress guard: where the server may connect on behalf of a client. With accounts, a client
// administrator types in a model endpoint and database hosts; without a guard the server would
// connect wherever they point — its own loopback services, the cloud metadata endpoint, the private
// network it sits in. So for those targets every address a name resolves to must be public, and
// the check happens inside the connection's own DNS lookup (no second lookup to race: a rebinding
// name cannot pass the check and then connect elsewhere). The platform's own model endpoint and
// installs without accounts are not affected (the operator is the administrator there).
//
//   GRIDWRIGHT_EGRESS_GUARD=on|off   default: on with accounts, off without
//   GRIDWRIGHT_EGRESS_ALLOW=db.internal,10.20.0.0/16,192.168.1.5   names or addresses/ranges that
//                                    clients may use even though they are private

import dns, { type LookupAddress, type LookupOptions } from 'node:dns';
import net from 'node:net';
import { once } from 'node:events';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

// (same test as tenancy.ts, read here so this module has no import cycle)
const ACCOUNTS = (process.env.GRIDWRIGHT_AUTH ?? '').trim().toLowerCase() === 'accounts';
const flag = (process.env.GRIDWRIGHT_EGRESS_GUARD ?? '').toLowerCase();
export const EGRESS_GUARD = flag === 'on' || flag === '1' || flag === 'true' ? true : flag === 'off' || flag === '0' || flag === 'false' ? false : ACCOUNTS;

// --- what is not public ----------------------------------------------------------------------
const reserved = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) reserved.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) reserved.addSubnet(a, p, 'ipv6');

/** an IPv4 address carried inside an IPv6 one (mapped ::ffff:a.b.c.d, or NAT64 64:ff9b::a.b.c.d) */
function embeddedV4(ip: string): string | null {
  const m = /^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (h) {
    const a = parseInt(h[1], 16);
    const b = parseInt(h[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

export function isReserved(ip: string): boolean {
  const v4 = net.isIPv4(ip) ? ip : embeddedV4(ip);
  if (v4) return reserved.check(v4, 'ipv4');
  if (net.isIPv6(ip)) return reserved.check(ip, 'ipv6');
  return true; // not an address at all: refuse
}

// --- the operator's exceptions ---------------------------------------------------------------
const allowNames = new Set<string>();
const allowNets = new net.BlockList();
for (const raw of (process.env.GRIDWRIGHT_EGRESS_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const [addr, bits] = raw.split('/');
  const fam = net.isIP(addr);
  if (fam && bits !== undefined) allowNets.addSubnet(addr, Number(bits), fam === 4 ? 'ipv4' : 'ipv6');
  else if (fam) allowNets.addAddress(addr, fam === 4 ? 'ipv4' : 'ipv6');
  else allowNames.add(raw.toLowerCase().replace(/\.$/, ''));
}
const nameAllowed = (host: string) => allowNames.has(host.toLowerCase().replace(/\.$/, ''));
const addressAllowed = (ip: string) => {
  const v4 = net.isIPv4(ip) ? ip : embeddedV4(ip);
  return v4 ? allowNets.check(v4, 'ipv4') : net.isIPv6(ip) && allowNets.check(ip, 'ipv6');
};

export class EgressBlocked extends Error {
  code = 'EGRESS_BLOCKED';
}
const blockedError = (host: string) =>
  new EgressBlocked(`${host} is on a private or reserved network, which clients may not connect to (the platform operator can allow it with GRIDWRIGHT_EGRESS_ALLOW)`);

const stripBrackets = (h: string) => h.replace(/^\[(.*)\]$/, '$1');

/** May a client's connection go to this address (already resolved)? */
function addressOk(host: string, ip: string) {
  return !isReserved(ip) || nameAllowed(host) || addressAllowed(ip);
}

/** A DNS lookup for net/tls/undici that refuses names resolving to any non-public address. */
export function guardedLookup(hostname: string, options: LookupOptions | number, callback: (...args: any[]) => void) {
  const opts: LookupOptions = typeof options === 'number' ? { family: options } : { ...(options ?? {}) };
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as LookupAddress[];
    if (!list.length) return callback(Object.assign(new Error(`${hostname} does not resolve`), { code: 'ENOTFOUND' }));
    if (list.some((a) => !addressOk(hostname, a.address))) return callback(blockedError(hostname));
    if (opts.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

/** Refuse an address literal the lookup would never see (net skips DNS for literals). */
function checkLiteral(host: string) {
  const h = stripBrackets(host);
  if (net.isIP(h) && !addressOk(h, h)) throw blockedError(h);
}

/** Validate a host when it is saved: every address it resolves to must be allowed. */
export async function checkHost(host: string): Promise<void> {
  const h = stripBrackets(host.trim());
  if (!h) return;
  if (net.isIP(h)) return checkLiteral(h);
  let list: LookupAddress[] = [];
  try {
    list = await dns.promises.lookup(h, { all: true });
  } catch {
    return; // does not resolve now: the connection-time check still applies
  }
  if (list.some((a) => !addressOk(h, a.address))) throw blockedError(h);
}

export async function checkUrl(raw: string): Promise<void> {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('the endpoint is an http(s) URL');
  if (u.username || u.password) throw new Error('put credentials in the API key field, not in the URL');
  await checkHost(u.hostname);
}

// --- guarded connections -----------------------------------------------------------------------
const agent = new Agent({ connect: { lookup: guardedLookup as any, timeout: 10_000 } });

/** fetch for a client-controlled URL: guarded DNS, no redirects (a redirect could point anywhere). */
export async function guardedFetch(url: string, init: UndiciRequestInit = {}) {
  checkLiteral(new URL(url).hostname);
  return undiciFetch(url, { ...init, dispatcher: agent, redirect: 'error' });
}

/** fetch with the guard when `guarded`, the plain global fetch otherwise. */
export function fetchFor(guarded: boolean) {
  return (url: string, init: RequestInit = {}) => (guarded && EGRESS_GUARD ? (guardedFetch(url, init as UndiciRequestInit) as unknown as Promise<Response>) : fetch(url, init));
}

/** A TCP socket to host:port whose name resolution is guarded (already connecting). */
export function guardedSocket(host: string, port: number): net.Socket {
  checkLiteral(host);
  return net.connect({ host: stripBrackets(host), port, lookup: guardedLookup as any });
}

/** For drivers that call socket.connect(port, host) themselves (pg). */
export class GuardedSocket extends net.Socket {
  connect(...args: any[]): this {
    if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) {
      const port = Number(args[0]);
      const host = typeof args[1] === 'string' ? args[1] : 'localhost';
      const cb = args.find((a) => typeof a === 'function');
      try {
        checkLiteral(host);
      } catch (e) {
        process.nextTick(() => this.destroy(e as Error));
        return this;
      }
      return super.connect({ port, host: stripBrackets(host), lookup: guardedLookup as any }, cb);
    }
    return super.connect(...(args as [any]));
  }
}

/** A connector for tedious (SQL Server): resolves once, through the guard. */
export function guardedConnector(host: string, port: number) {
  return async () => {
    const s = guardedSocket(host, port);
    await once(s, 'connect');
    return s;
  };
}

/**
 * What a client is told when a connection fails: no internal addresses, ports or OS error details
 * (they map the network for whoever asks). The full error goes to the server log.
 */
export function clientNetError(e: unknown, what: string): string {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err?.code ?? err?.cause?.code ?? '';
  if (code === 'EGRESS_BLOCKED' || err?.cause instanceof EgressBlocked || e instanceof EgressBlocked) return (err.cause instanceof EgressBlocked ? err.cause : (e as Error)).message;
  if (/^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code) || /fetch failed|connect|socket|timed? ?out|getaddrinfo/i.test(err?.message ?? '')) {
    console.error(`${what}: ${err?.message ?? e}${err?.cause?.message ? ` (${err.cause.message})` : ''}`);
    return `${what} could not be reached`;
  }
  return err?.message ?? String(e);
}
