// Backups of the data directory, for the download (/api/backup) and the nightly job (scripts/install.sh).
//
// The archive is made from a consistent copy: every SQLite database is snapshotted with VACUUM INTO,
// so a write in progress is never half in it (copying a live database file and its -wal is not safe).
// The server key (secret.key) is never in it: an archive that leaves the machine must not carry the key
// to the passwords and API keys it encrypts. Keep the key apart, or set GRIDWRIGHT_SECRET.
//
//   node dist/backup.js <data dir> <out.tar.gz>     (what the nightly backup.sh runs)
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
/** Top-level entries that are never backed up: the key and credentials, caches, runtimes, logs, sockets. */
export const BACKUP_EXCLUDED = new Set(['secret.key', 'access-token', 'initial-admin.txt', 'agent.sock', 'pyodide', 'pyenv', 'pycache', 'server.log', 'backup.sh']);
const STAGING_PREFIX = '.backup-staging-';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const RESTORE_NOTE = `Gridwright backup

This archive does not contain the server key (secret.key). Saved database passwords, AI keys and
other secrets in it are encrypted with that key, so to restore:

  1. stop the server, unpack this archive into an empty data directory (owned by the service user, 0700);
  2. put the key back: copy the secret.key you keep apart into the data directory (0600),
     or start the server with GRIDWRIGHT_SECRET set to the same value as before;
  3. start the server.

Without the key the documents, history and datasets restore normally; saved connection passwords and
AI keys have to be entered again.
`;
function isSqlite(path) {
    let fd = -1;
    try {
        fd = openSync(path, 'r');
        const head = Buffer.alloc(16);
        return readSync(fd, head, 0, 16, 0) === 16 && head.equals(SQLITE_MAGIC);
    }
    catch {
        return false;
    }
    finally {
        if (fd >= 0)
            closeSync(fd);
    }
}
/** Copy `dataDir` into the empty directory `dest`: databases snapshotted, excluded entries left out. */
export function snapshotDataDir(dataDir, dest) {
    const report = { files: 0, databases: 0, copiedAsIs: [] };
    const walk = (dir, out, top) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (top && (BACKUP_EXCLUDED.has(e.name) || e.name.startsWith(STAGING_PREFIX)))
                continue;
            if (/-(wal|shm|journal)$/.test(e.name))
                continue; // part of a database, which the snapshot already holds
            const src = join(dir, e.name);
            const target = join(out, e.name);
            if (e.isDirectory()) {
                mkdirSync(target, { recursive: true, mode: 0o700 });
                walk(src, target, false);
                continue;
            }
            if (!e.isFile())
                continue; // sockets, fifos and symbolic links are not data
            if (isSqlite(src)) {
                try {
                    const db = new DatabaseSync(src, { readOnly: true });
                    try {
                        db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
                    }
                    finally {
                        db.close();
                    }
                    report.databases++;
                    continue;
                }
                catch (err) {
                    report.copiedAsIs.push(`${src.slice(dataDir.length + 1)}: ${err.message}`);
                    rmSync(target, { force: true });
                }
            }
            copyFileSync(src, target);
            report.files++;
        }
    };
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    walk(resolve(dataDir), dest, true);
    writeFileSync(join(dest, 'RESTORE.txt'), RESTORE_NOTE, { mode: 0o600 });
    return report;
}
/** A staging directory for a snapshot, next to `near` (same filesystem, private). */
export function stagingDir(near) {
    mkdirSync(near, { recursive: true, mode: 0o700 });
    return mkdtempSync(join(near, STAGING_PREFIX));
}
/** tar.gz of a directory's contents, streamed. */
export function tarGz(dir) {
    return spawn('tar', ['-czf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
}
/** The nightly backup: `<out>` written atomically (a partial archive never carries the final name). */
export async function backupTo(dataDir, out) {
    const staging = stagingDir(dirname(resolve(out)));
    try {
        const report = snapshotDataDir(dataDir, join(staging, 'data'));
        const tmp = `${out}.partial`;
        await new Promise((res, rej) => {
            const tar = spawn('tar', ['-czf', tmp, '-C', join(staging, 'data'), '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
            let err = '';
            tar.stderr.on('data', (d) => (err += d));
            tar.on('error', rej);
            tar.on('exit', (code) => (code === 0 ? res() : rej(new Error(`tar exited ${code}: ${err.trim()}`))));
        });
        renameSync(tmp, out);
        return report;
    }
    finally {
        rmSync(staging, { recursive: true, force: true });
    }
}
// CLI: node dist/backup.js <data dir> <out.tar.gz>
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [dataDir, out] = process.argv.slice(2);
    if (!dataDir || !out || !existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
        console.error('usage: node backup.js <data dir> <out.tar.gz>');
        process.exit(2);
    }
    backupTo(dataDir, out)
        .then((r) => {
        console.log(`backup written: ${out} (${r.databases} database${r.databases === 1 ? '' : 's'} snapshotted, ${r.files} file${r.files === 1 ? '' : 's'}; secret.key not included — keep it apart)`);
        for (const c of r.copiedAsIs)
            console.warn(`warning: copied as is (not snapshotted): ${c}`);
        if (basename(out).startsWith(STAGING_PREFIX))
            process.exit(1);
    })
        .catch((e) => {
        console.error(`backup failed: ${e.message}`);
        process.exit(1);
    });
}
