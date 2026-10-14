// Who may run code on the server, and who may ask for the GPU. Editing a workbook is one
// permission; executing code on the host and taking GPU time are others. By default every editor
// may run (that is what the host was set up for); GRIDWRIGHT_PYTHON_USERS and GRIDWRIGHT_GPU_USERS
// (comma-separated logins, identity on) narrow that to named people. Viewers never execute.

import { identityEnabled, type Identity } from './identity.js';

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const PYTHON_USERS = list(process.env.GRIDWRIGHT_PYTHON_USERS);
const GPU_USERS = list(process.env.GRIDWRIGHT_GPU_USERS);

function allowed(names: string[], who: Identity): boolean {
  if (who.role === 'viewer') return false;
  if (who.role === 'admin' || !names.length) return true;
  return identityEnabled && names.includes(who.login.toLowerCase());
}

export const canRunPython = (who: Identity) => allowed(PYTHON_USERS, who);
export const canUseGpu = (who: Identity) => canRunPython(who) && allowed(GPU_USERS, who);
export const executionPolicy = () => ({ pythonUsers: PYTHON_USERS.length ? PYTHON_USERS.length : 'all editors', gpuUsers: GPU_USERS.length ? GPU_USERS.length : 'all python users' });
