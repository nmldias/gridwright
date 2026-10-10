# Multi-tenancy: clients, people and accounts

With `GRIDWRIGHT_AUTH=accounts` one Gridwright server hosts many **clients** (tenants). Each client
is a separate workspace with its own documents, database connections, model settings and inbox,
and its own **members** with a role in it. People sign in with an e-mail and a password; one
person can belong to several clients and work in a different one in each browser tab.

Without the variable nothing changes: the server is the single shared workspace it always was,
with the optional shared token or Tailscale identity.

## Concepts

| Term | Meaning |
|---|---|
| **Platform administrator** | runs the server: creates, suspends and deletes clients, creates accounts, sets the default model endpoint, downloads backups. Reading a client's documents still takes a membership, which the platform administrator can add for themselves (*Join & open*), and that is audited |
| **Client** | a customer workspace: name, short id (`slug`), status (`active` / `suspended`), plan label, optional seat limit |
| **Member** | a person in a client, with one role there |
| **Role** (per client) | `admin` manages the client (members, connections, model settings) and sees every document in it · `editor` creates and edits documents, runs queries · `viewer` reads what is shared with them |

Within a client, documents are shared exactly as before (owner, *everyone in the client*, named
members with *view / sign off / edit*), but only members of that client can be named, and a new
document is editable by everyone in the client by default (`GRIDWRIGHT_DEFAULT_SHARING` changes
that).

## Turning it on

```bash
GRIDWRIGHT_AUTH=accounts \
GRIDWRIGHT_ADMIN_EMAIL=you@yourcompany.com \
GRIDWRIGHT_ADMIN_PASSWORD='a long first password' \
node server/dist/index.js
```

On the first start the server creates `data/platform.sqlite`, a **Default client**, and the first
platform administrator (a member of the default client). Without `GRIDWRIGHT_ADMIN_PASSWORD` a
temporary password is generated and written to `data/initial-admin.txt` (mode 0600); it must be
changed at first sign-in. Delete the file afterwards.

**On a public address, use HTTPS.** Passwords and the session cookie must not cross the internet in
plain HTTP. `scripts/install.sh --accounts --https` puts Caddy in front with a Let's Encrypt
certificate (for `<public-ip>.sslip.io`, or `--https=your.domain`), binds the server to
127.0.0.1 and sets `GRIDWRIGHT_TRUST_PROXY=1`, so the cookie is `Secure` and HSTS is sent. Behind
another proxy, set `GRIDWRIGHT_TRUST_PROXY` to its address.

**Run it as its own account.** Add `--system-user` and the server runs as a dedicated system
account (`gridwright`: no shell, no sudo, no docker) from a root-owned, read-only copy of the
release in `/opt/gridwright`, with its data in `/var/lib/gridwright/data` and backups in
`/var/lib/gridwright/backups`. The unit is a hardened system service (`ProtectSystem=strict`,
`ProtectHome`, `NoNewPrivileges`, no capabilities, private `/tmp` and `/dev`); a per-user install
is retired and its data copied over once (the old folder stays until you delete it). Manage it with
`sudo systemctl status gridwright` and `sudo journalctl -u gridwright -f`.

**Existing data.** Documents and connections created before accounts were turned on carry no
client, so they belong to the default client and only its members see them. Nothing is moved or
rewritten. Turning accounts off again returns to the previous behaviour.

| Variable | Purpose |
|---|---|
| `GRIDWRIGHT_AUTH` | `accounts` turns on sign-in and clients |
| `GRIDWRIGHT_ADMIN_EMAIL`, `GRIDWRIGHT_ADMIN_PASSWORD`, `GRIDWRIGHT_ADMIN_NAME` | the first platform administrator (used only when the accounts database is created) |
| `GRIDWRIGHT_DEFAULT_CLIENT` | the name of the default client (`Default client`) |
| `GRIDWRIGHT_ACCOUNTS_DB` | the accounts database (default `data/platform.sqlite`) |
| `GRIDWRIGHT_SESSION_HOURS` | how long a sign-in lasts (336 = 14 days) |
| `GRIDWRIGHT_MIN_PASSWORD` | the shortest password accepted (10) |
| `GRIDWRIGHT_ALLOWED_ORIGINS` | extra origins allowed to make cookie-authenticated writes (comma-separated). The server's own origin is always allowed |
| `GRIDWRIGHT_ALLOW_WEAK_SANDBOX` | `1` accepts `GRIDWRIGHT_PYTHON_SANDBOX=unshare` or `none` with accounts on. Without it, server-side Python stays off unless bubblewrap is in use, because a weaker sandbox would let one client's code read another's data |
| `GRIDWRIGHT_INBOX` | with accounts on, each client's inbox is its own subfolder, `<inbox>/<client slug>/` |
| `GRIDWRIGHT_INVITE_DAYS` | how long an invitation link stays valid (7) |
| `GRIDWRIGHT_TRUST_PROXY` | `1` when a reverse proxy on this machine (loopback) terminates HTTPS; or a list of proxy addresses/ranges. Only then do `X-Forwarded-For/-Proto/-Host` count — for the sign-in throttle, the cookie's `Secure` flag, HSTS and the origin check. Unset, they are ignored |
| `GRIDWRIGHT_EGRESS_GUARD` | `on`/`off` — refuse client-entered model endpoints and database hosts that resolve to loopback, private, link-local (cloud metadata) or other reserved addresses. Default: on with accounts |
| `GRIDWRIGHT_EGRESS_ALLOW` | names, addresses or CIDR ranges clients may use although they are private, e.g. `db.internal,10.20.0.0/16` |
| `GRIDWRIGHT_AI_RPM_CLIENT`, `GRIDWRIGHT_AI_RPM_PERSON` | model requests per minute for a whole client (60) and for one person (20) |
| `GRIDWRIGHT_AI_MONTHLY_TOKENS` | default monthly token budget per client (unset = unlimited; `0` = AI off). The platform can set each client's own |
| `GRIDWRIGHT_PYTHON_TENANT_CONCURRENCY`, `GRIDWRIGHT_PYTHON_TENANT_QUEUE` | server-side Python runs one client may hold at once (half the server's slots) and queue (a quarter of the queue, at least 4), so one client cannot starve the others |
| `GRIDWRIGHT_INTAKE_WORKERS`, `GRIDWRIGHT_INTAKE_HEAP_MB`, `GRIDWRIGHT_INTAKE_TIMEOUT_S`, `GRIDWRIGHT_INTAKE_MAX_UNZIPPED_MB` | uploaded workbooks are parsed in worker threads: how many (2), each one's memory cap (768 MB) and deadline (60 s), and the largest a workbook may inflate to (160 MB) |

`GRIDWRIGHT_TOKEN`, `GRIDWRIGHT_TRUST_TAILSCALE`, `GRIDWRIGHT_ADMINS` and `GRIDWRIGHT_READONLY`
are not used with accounts. Roles come from memberships.

## Using it

- **Signing in.** The app opens on a sign-in screen. A password that someone else chose — the
  first administrator's, one set by the platform, a reset — must be changed at the next sign-in.
  Changing a password signs out the account's other sessions.
- **Invitations.** A client administrator adds someone by inviting them: the panel shows a link
  (`/?invite=gwi_…`, valid for 7 days, usable once) to send them privately. Opening it shows which
  client and role it is for; they accept with their existing password, or choose one if they are
  new. Nobody is put into a client without accepting, and the answer is the same whether or not
  the e-mail already has an account. Pending invitations are listed and can be revoked.
- **The client switcher.** The top bar names the client the tab works in. Its menu lists the
  person's clients, the members, *My account*, the platform console for platform administrators,
  and *Sign out*. Switching reloads the tab in the other client. The URL carries `?tenant=<slug>`,
  so a link or bookmark opens in the right client, and two tabs can be in two clients at once.
- **Clients & people** (side panel):
  - *Members*: the client's people, pending invitations, and the client's AI use this month
    against its budget. Administrators invite people, change roles, reset passwords of people who
    belong only to their client (the person must change it at sign-in), and remove members.
    Removal takes effect at once, including on open documents.
  - *Activity*: the audit trail of the client: members, roles, settings, sign-ins.
  - *My account*: name, password, and **API tokens** for MCP clients and scripts.
  - *Clients* and *People* (platform administrators): create a client with its first
    administrator, suspend or reactivate it, set plan and seats, manage any client's members,
    delete a client once it has no documents or connections, disable accounts, grant or revoke
    platform administration, set the default model endpoint, see every client's AI use and set
    its monthly token budget.
- **Model settings.** Every client uses the platform's default endpoint, model and key until a
  client administrator saves its own in *Ask → ⚙*. *Use platform default* returns to the default.
  The platform's key is only ever sent to the platform's endpoint: a client that types in its own
  endpoint must supply its own key, and the endpoint must be a public address (see
  `GRIDWRIGHT_EGRESS_GUARD`).
- **AI limits.** Every model call — the assistant, investigations, the companion and the
  `/api/ai/v1` pass-through — counts against the client's rate and monthly budget, using the
  endpoint's own token counts (estimated, and marked so, when the endpoint reports none). Over a
  limit the call is refused with `429` and a `retry-after`.
- **Code in documents.** JavaScript and Python (Pyodide) cells run in the browser inside an
  isolated frame with no access to the app, its session or the network. Code that someone else
  wrote does not run on its own: the document says which cells wait, and the person reviews them
  and chooses *Trust and run*. An approval covers that exact code; a changed cell asks again.

## API

Every request names its client through the `x-gridwright-tenant` header (id or slug) or a
`?tenant=` parameter. Without either, the session's default client applies (the last one signed
into or switched to). A client the person is not a member of is refused with `403`. It is never
silently replaced by another. Responses refused by the sign-in gate carry `x-gridwright-auth:
signed-out | change-password | no-client`.

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/auth/login` `{login, password, tenant?}` | anyone | sign in; sets the `gw_session` cookie (HttpOnly, SameSite=Lax) |
| `POST /api/auth/logout` | signed in | end the session |
| `POST /api/auth/password` `{current, next}` | signed in | change one's password |
| `POST /api/auth/switch` `{tenant}` | member | change the session's default client |
| `GET /api/me` | anyone | who is signed in, the client of this request, every client the person belongs to |
| `PUT /api/account` · `GET/POST /api/account/tokens` · `DELETE /api/account/tokens/:id` | signed in | name; API tokens |
| `GET/PUT /api/tenant` | member / admin | the current client; rename |
| `GET/POST /api/tenant/members` · `PUT/DELETE /api/tenant/members/:login` | member / admin | list; invite `{login, role}` (returns the invitation link once); change role; remove |
| `GET /api/tenant/invitations` · `DELETE /api/tenant/invitations/:id` | admin | pending invitations; revoke |
| `GET /api/auth/invitation?code=` · `POST /api/auth/invitation/accept` `{code, password, name?}` | the invitation's holder | what it is for; accept it and sign in |
| `POST /api/tenant/members/:login/reset-password` | admin | a new temporary password, to be changed at sign-in (only for people in no other client) |
| `GET /api/tenant/ai-usage` | admin | the client's model requests and tokens this month, with its budget and limits |
| `GET /api/tenant/audit` | admin | the client's audit trail |
| `/api/platform/tenants[/:id[/members[/:login]]]` · `/api/platform/users[/:login[/reset-password]]` · `/api/platform/audit` · `/api/platform/ai` | platform admin | the console |
| `GET /api/platform/ai-usage` · `PUT /api/platform/tenants/:id/ai-budget` `{monthlyTokens: n \| null \| "default"}` | platform admin | every client's AI use; a client's budget (`null` unlimited, `0` off) |

**API tokens** (`gwk_…`) act as the person who made them, in the client they were made in, with
the person's current role there. Send `Authorization: Bearer gwk_…` to `/mcp` or `/api/...`. A token
cannot be pointed at another client: naming one is refused with `403` (`denied: token-client`). It
stops working when revoked, when the person is removed from the client or disabled, or when the
client is suspended.

## How isolation is enforced

Isolation is logical, in one process, enforced at the points where every decision was already
made:

| Resource | Rule |
|---|---|
| Documents | each document records its client. Listing, opening, saving, history, proposals, conversations, intake, sources and the WebSocket all go through `permissionFor`, which refuses any document outside the identity's client before looking at sharing, and uses the membership as it is *now* |
| Live sessions | removing a member, changing their role, suspending a client or disabling an account re-checks every open WebSocket at once |
| SQL connections | each connection records its client; it is listed, used, changed and deleted only within it, by the assistant, SQL cells, sources and MCP alike |
| Model settings | per client, falling back to the platform default; the platform key never leaves for a client's endpoint |
| Inbox | a subfolder per client |
| Investigations, agent cells, scheduled refreshes | run with an identity rebuilt for the document's client and the person's live role |
| Backups | the whole-server backup is for platform administrators only |
| Service account | with `install.sh --system-user`: a dedicated account without shell, sudo or docker; code read-only to it; the system unit hides `/home`, makes the OS read-only except the data directory, and drops every capability |
| Server-side Python | bubblewrap with no network; `/run`, `/var/run`, the data directory and every socket-bearing tree hidden (the start-up probe refuses to turn Python on if the host's Docker, systemd or D-Bus sockets are reachable); a cache and warm interpreters per client, so nothing one client's code writes is seen by another's; a finished run's leftover processes are killed; per-client share of the run slots and queue |
| Code cells in the browser | an opaque-origin sandbox frame (its own CSP: no network, no app cookies, no parent page); code written by someone else runs only after the person approves it |
| Outbound connections | client-entered model endpoints and database hosts must resolve to public addresses, checked inside the connection's own DNS lookup (no rebinding window); connection errors shown to clients carry no network detail |
| Imports | workbooks, XML and JSON are parsed in worker threads with a memory cap and deadline, after a check of how far the zip inflates; ordinary requests are limited to 1 MB bodies |
| AI cost | per-client and per-person rate limits and a monthly token budget, recorded per client |
| Accounts | passwords hashed with scrypt; sessions, tokens and invitations stored as SHA-256 hashes; sign-in throttled per address (30 failures per 15 minutes) and per address and account (8), while across addresses an account only slows down (a pause up to 30 s), so nobody can lock a known e-mail out; the counters survive restarts; cookie-authenticated writes from other origins refused; every account change audited |
| Browser | Content-Security-Policy without `unsafe-eval`, `frame-ancestors 'self'`, `nosniff`, opener and referrer policies; HSTS and `Secure` cookies behind a trusted HTTPS proxy |

## Limitations

- Isolation is logical, not physical: all clients share one process, one data directory and one
  encryption key. A client that needs physical separation should get its own server.
- No single sign-on, e-mail delivery of invitations or self-service password reset yet: an
  administrator sends the invitation link themselves.
- Plans and seats are labels and limits only. There is no billing.
- One server process. The accounts database is SQLite (WAL), which is ample for hundreds of
  clients but not a horizontally scaled cluster.

## Tests

```bash
python3 e2e/tenancy.py      # isolation, people, invitations, platform, tokens, migration (87 checks; starts its own server)
python3 e2e/tenancy_ui.py   # the interface in a browser: sign-in, switcher, invitations, console (31 checks)
python3 e2e/security.py     # the 2026-10 audit's findings, each defence checked from the outside (99 checks;
                            # the code-sandbox and code-trust checks need Playwright)
```
