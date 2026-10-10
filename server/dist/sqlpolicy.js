// The one place that decides whether a caller may run a statement on a connection, used by the
// SQL panel, SQL cells and the assistant's tools alike. Policy per connection: read-only (SELECT
// only, enforced again by the driver's read-only transaction where the database has one), an
// allow-list of logins (admins always pass), and row / time limits applied by the driver.
import { identityEnabled } from './identity.js';
import { connectionTenant } from './storage.js';
import { ACCOUNTS } from './tenancy.js';
export class SqlRefused extends Error {
    status;
    constructor(message, status = 403) {
        super(message);
        this.status = status;
    }
}
/** True when the statement is a single read-only SELECT (comments and string literals ignored). */
export function isReadOnlySql(sql) {
    let bare = '';
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (c === "'" || c === '"' || c === '`' || c === '[') {
            const close = c === '[' ? ']' : c;
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === close) {
                    if (sql[j + 1] === close) {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j++;
            }
            bare += ' ';
            i = j + 1;
            continue;
        }
        if (c === '-' && sql[i + 1] === '-') {
            const j = sql.indexOf('\n', i);
            i = j < 0 ? sql.length : j;
            continue;
        }
        if (c === '/' && sql[i + 1] === '*') {
            const j = sql.indexOf('*/', i + 2);
            i = j < 0 ? sql.length : j + 2;
            continue;
        }
        bare += c;
        i++;
    }
    const text = bare.trim().replace(/;\s*$/, '');
    if (!text)
        return { ok: false, reason: 'empty statement' };
    if (text.includes(';'))
        return { ok: false, reason: 'one statement at a time' };
    const first = (text.match(/^[a-zA-Z]+/) ?? [''])[0].toUpperCase();
    if (first !== 'SELECT' && first !== 'WITH')
        return { ok: false, reason: 'only SELECT statements are allowed on a read-only connection' };
    const banned = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|MERGE|CALL|INTO|COPY|VACUUM|LOCK|SET|USE|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|WAITFOR|SHUTDOWN|RECONFIGURE|pg_sleep|LOAD_FILE|OUTFILE|DUMPFILE)\b|\b((?:xp|sp|dm)_\w+)/i;
    const m = text.match(banned);
    if (m)
        return { ok: false, reason: `${(m[1] ?? m[2]).toUpperCase()} is not allowed on a read-only connection` };
    return { ok: true };
}
/** Throws `SqlRefused` unless `who` may run `sql` on `conn`. */
export function authorizeQuery(conn, who, sql) {
    // another client's connection does not exist for this caller
    if (!sameClient(conn, who))
        throw new SqlRefused('no such connection', 404);
    if (who.role === 'viewer')
        throw new SqlRefused('read-only access: viewers cannot run queries');
    const allowed = (conn.allowed ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && who.role !== 'admin') {
        if (!identityEnabled)
            throw new SqlRefused(`connection "${conn.name}" is restricted to named logins, and this server cannot identify you (identity is off)`);
        if (!allowed.includes(who.login.toLowerCase()))
            throw new SqlRefused(`connection "${conn.name}" is not shared with ${who.login || 'you'}`);
    }
    if (conn.readOnly !== false) {
        const check = isReadOnlySql(sql);
        if (!check.ok)
            throw new SqlRefused(check.reason ?? 'not allowed', 400);
    }
}
/** Can `who` see this connection in lists at all? */
export function canSeeConnection(conn, who) {
    if (!sameClient(conn, who))
        return false;
    const allowed = (conn.allowed ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!allowed.length || who.role === 'admin')
        return true;
    return identityEnabled && allowed.includes(who.login.toLowerCase());
}
/** Accounts mode: a connection belongs to one client, and only that client's members reach it. */
export function sameClient(conn, who) {
    if (!ACCOUNTS)
        return true;
    return !!who.tenant && connectionTenant(conn) === who.tenant;
}
