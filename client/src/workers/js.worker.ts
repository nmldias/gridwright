// JavaScript code cells run here, isolated from the page.

import { makeQ, toGrid, type Snapshot } from './q';

interface RunMsg {
  id: number;
  code: string;
  snapshot: Snapshot;
}

function fmt(x: unknown): string {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x, null, 0) ?? String(x);
  } catch {
    return String(x);
  }
}

/** If the code has no `return`, return the value of its last expression line. */
function withReturn(code: string): string {
  if (/\breturn\b/.test(code)) return code;
  const lines = code.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || l.startsWith('//')) continue;
    if (/^(const|let|var|if|for|while|function|class|\}|\{|import|export|try|switch)\b/.test(l)) break;
    lines[i] = `return (${l.replace(/;\s*$/, '')});`;
    return lines.join('\n');
  }
  return code;
}

self.onmessage = async (e: MessageEvent<RunMsg>) => {
  const { id, code, snapshot } = e.data;
  const logs: string[] = [];
  const q = makeQ(snapshot);
  const con = {
    log: (...a: unknown[]) => logs.push(a.map(fmt).join(' ')),
    info: (...a: unknown[]) => logs.push(a.map(fmt).join(' ')),
    warn: (...a: unknown[]) => logs.push('warning: ' + a.map(fmt).join(' ')),
    error: (...a: unknown[]) => logs.push('error: ' + a.map(fmt).join(' ')),
    table: (x: unknown) => logs.push(fmt(x)),
  };
  try {
    const body = withReturn(code);
    const fn = new Function('q', 'console', `"use strict";\nreturn (async () => {\n${body}\n})();`);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('cell timed out after 60 s')), 60000));
    const result = await Promise.race([fn(q, con), timeout]);
    self.postMessage({ id, code, ok: true, output: toGrid(result), std_out: logs.join('\n'), deps: q.deps, runtime: { name: 'javascript', version: self.navigator?.userAgent ?? '', packages: {} } });
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    self.postMessage({ id, code, ok: false, error: msg, std_out: logs.join('\n'), deps: q.deps, runtime: { name: 'javascript', version: self.navigator?.userAgent ?? '', packages: {} } });
  }
};
