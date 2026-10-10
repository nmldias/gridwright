// Code trust: a code cell runs with the access of whoever has the document open — their SQL
// connections, their server-side Python, their agent channel. When people are told apart (sign-in),
// code that this person did not write in this browser, and has not approved, therefore does not run
// on its own: the document shows which cells wait, and the person reviews them and says "trust and
// run". Approvals are remembered per person (and client) for the exact code — kind, runtime,
// connection and text — under a SHA-256, so a changed cell asks again and a crafted twin cannot pass.

import type { CellRef, CellView } from '../engine/types';
import { getState, useStore } from '../state/store';

type CodeCell = Pick<CellView, 'k' | 'i'> & { runtime?: string | null; conn?: string | null; gpu?: boolean | null };

// --- SHA-256 (synchronous: crypto.subtle is missing on plain-HTTP origins) ----------------------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(text: string): string {
  const msg = new TextEncoder().encode(text);
  const bitLen = msg.length * 8;
  const total = (((msg.length + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

// --- approvals ---------------------------------------------------------------------------------
const MAX_APPROVALS = 5000;
let cache: { key: string; set: Set<string> } | null = null;

const storageKey = () => {
  const me = getState().me;
  return `gridwright.trustedCode.v1.${me.tenant?.id ?? ''}.${me.login}`;
};

function approvals(): Set<string> {
  const key = storageKey();
  if (cache?.key === key) return cache.set;
  let list: unknown = [];
  try {
    list = JSON.parse(localStorage.getItem(key) ?? '[]');
  } catch {
    list = [];
  }
  cache = { key, set: new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []) };
  return cache.set;
}

function persist(set: Set<string>) {
  let list = Array.from(set);
  if (list.length > MAX_APPROVALS) list = list.slice(list.length - MAX_APPROVALS);
  try {
    localStorage.setItem(storageKey(), JSON.stringify(list));
  } catch {
    /* storage full or blocked: approvals last for this tab */
  }
}

/** What an approval is for: the code and everything that decides what it can reach. */
export function codeHash(c: CodeCell): string {
  return sha256([c.k, c.runtime ?? '', c.conn ?? '', c.gpu ? 'gpu' : '', c.i].join('\u0000'));
}

/** People are told apart (sign-in or a trusted identity header): code may act as someone else. */
export const trustGateOn = () => !!getState().me.identity;

export function isTrusted(c: CodeCell): boolean {
  if (!trustGateOn()) return true;
  return approvals().has(codeHash(c));
}

/** Remember these cells' code as this person's (written here, or reviewed and approved). */
export function trust(cells: CodeCell[]) {
  if (!trustGateOn() || !cells.length) return;
  const set = approvals();
  for (const c of cells) {
    const h = codeHash(c);
    set.delete(h); // most recent last: the oldest approvals fall off first
    set.add(h);
  }
  persist(set);
}

// --- cells waiting for a decision --------------------------------------------------------------
const keyOf = (r: CellRef) => `${r.table}:${r.row}:${r.col}`;

export function noteBlocked(ref: CellRef) {
  const cur = getState().blockedCode;
  if (cur.some((r) => keyOf(r) === keyOf(ref))) return;
  useStore.setState({ blockedCode: [...cur, ref] });
}

export function clearBlocked(refs?: CellRef[]) {
  if (!refs) return useStore.setState({ blockedCode: [] });
  const drop = new Set(refs.map(keyOf));
  useStore.setState({ blockedCode: getState().blockedCode.filter((r) => !drop.has(keyOf(r))) });
}
