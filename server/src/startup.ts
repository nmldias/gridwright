// How the server protects itself at start-up. Kept apart from index.ts so tests can check the rules
// without starting a server.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const loopbackHost = (h: string) => h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);

export interface StartupEnv {
  host: string;
  token: string;
  accounts: boolean;
  trust: boolean;
  allowOpen: boolean;
}

/** A configuration the server must not start with (null when it may). */
export function startupProblem(env: StartupEnv): string | null {
  if (env.trust && !loopbackHost(env.host))
    return `GRIDWRIGHT_TRUST_TAILSCALE=1 believes identity headers, so the server must listen on 127.0.0.1 behind \`tailscale serve\` (HOST=${env.host}). Anyone reaching ${env.host} directly could claim to be anyone.`;
  return null;
}

/**
 * Reachable from the network with no way to tell people apart: everyone would be an administrator
 * (database connections, AI endpoints, server-side Python, backups). Unless the operator accepts that
 * by name (GRIDWRIGHT_ALLOW_OPEN=1), the server makes up a shared access token instead.
 */
export function needsGeneratedToken(env: StartupEnv): boolean {
  return !env.accounts && !env.token && !env.trust && !env.allowOpen && !loopbackHost(env.host);
}

/** The generated access token: kept in `<data>/access-token` (0600) so it survives restarts. */
export function generatedToken(dataDir: string): { token: string; path: string; created: boolean } {
  const path = join(dataDir, 'access-token');
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length >= 32) return { token, path, created: false };
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString('base64url');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, path, created: true };
}
