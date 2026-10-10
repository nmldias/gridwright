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

`GRIDWRIGHT_TOKEN`, `GRIDWRIGHT_TRUST_TAILSCALE`, `GRIDWRIGHT_ADMINS` and `GRIDWRIGHT_READONLY`
are not used with accounts. Roles come from memberships.

## Using it

- **Signing in.** The app opens on a sign-in screen. Someone added with a new account gets a
  temporary password from whoever added them, and must choose their own before going further.
  Changing a password signs out the account's other sessions.
- **The client switcher.** The top bar names the client the tab works in. Its menu lists the
  person's clients, the members, *My account*, the platform console for platform administrators,
  and *Sign out*. Switching reloads the tab in the other client. The URL carries `?tenant=<slug>`,
  so a link or bookmark opens in the right client, and two tabs can be in two clients at once.
- **Clients & people** (side panel):
  - *Members*: the client's people. Administrators add someone by e-mail (an account is created
    with a temporary password if they have none), change roles, reset passwords of people who
    belong only to their client, and remove members. Removal takes effect at once, including on
    open documents.
  - *Activity*: the audit trail of the client: members, roles, settings, sign-ins.
  - *My account*: name, password, and **API tokens** for MCP clients and scripts.
  - *Clients* and *People* (platform administrators): create a client with its first
    administrator, suspend or reactivate it, set plan and seats, manage any client's members,
    delete a client once it has no documents or connections, disable accounts, grant or revoke
    platform administration, set the default model endpoint.
- **Model settings.** Every client uses the platform's default endpoint, model and key until a
  client administrator saves its own in *Ask → ⚙*. *Use platform default* returns to the default.
  The platform's key is only ever sent to the platform's endpoint: a client that types in its own
  endpoint must supply its own key.

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
| `GET/POST /api/tenant/members` · `PUT/DELETE /api/tenant/members/:login` | member / admin | list, add, change role, remove |
| `POST /api/tenant/members/:login/reset-password` | admin | a new temporary password (only for people in no other client) |
| `GET /api/tenant/audit` | admin | the client's audit trail |
| `/api/platform/tenants[/:id[/members[/:login]]]` · `/api/platform/users[/:login[/reset-password]]` · `/api/platform/audit` · `/api/platform/ai` | platform admin | the console |

**API tokens** (`gwk_…`) act as the person who made them, in the client they were made in, with
the person's current role there. Send `Authorization: Bearer gwk_…` to `/mcp` or `/api/...`. A token
cannot be pointed at another client, and it stops working when revoked, when the person is removed
from the client or disabled, or when the client is suspended.

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
| Accounts | passwords hashed with scrypt; sessions and tokens stored as SHA-256 hashes; sign-in throttled (8 failures per account, 30 per address, per 15 minutes); cookie-authenticated writes from other origins refused; every account change audited |

## Limitations

- Isolation is logical, not physical: all clients share one process, one data directory and one
  encryption key. A client that needs physical separation should get its own server.
- No single sign-on, e-mail invitations or self-service password reset yet: an administrator hands
  over a temporary password.
- Plans and seats are labels and limits only. There is no billing.
- One server process. The accounts database is SQLite (WAL), which is ample for hundreds of
  clients but not a horizontally scaled cluster.

## Tests

```bash
python3 e2e/tenancy.py      # isolation, people, platform, tokens, migration (80 checks; starts its own server)
python3 e2e/tenancy_ui.py   # the interface in a browser: sign-in, switcher, members, console (29 checks)
```
