# The companion — operator runbook

Gridwright 0.10.0. This is the operational side of the companion (intake, the situation, monitoring, investigations). The user-facing description is in the [README](../../README.md); this page is for whoever runs the server.

## 1. What runs where

| Component | Where | Owns | Notes |
|---|---|---|---|
| Engine | `core/` → WebAssembly in the browser and in the server | values, formulas, tables, the CHECK() family | one build serves both; the server's copy is what the companion, intake and MCP read |
| Server | `server/src/index.ts` (Node 22, Express + ws) | **the operation log** (the authority on every document), documents, access, proposals, history, MCP | one process, no database; everything is files under the data directory |
| Companion | `server/src/companion.ts` | records (facts, objectives, constraints, exclusions, decisions, scenarios…), watches and their observations, issues, events, applied scope, investigations' records | state per document in `companion/<doc>.json`; deterministic — no model involved |
| Intake | `server/src/intake.ts` | parse → profile → sanitise → relate → retain → place through the log → source record → checks → first reading | originals and profiles in `intake/<doc>/`; the inbox adapter reads one configured directory on request |
| Investigation stack | `integrations/companion/` (Python, separate process per investigation) | LangChain tools over the server's API, the DeepAgents harness, a LangGraph thread per document checkpointed in SQLite | started by the server for one person with a short-lived loopback token; proposes, never states; generated code runs in the same sandbox as Python cells |
| Sandbox | `server/src/pyrun.ts` + bubblewrap | isolation of generated and typed code | level reported by `/api/python` and on every run record; data directory and secrets hidden from code |
| Client | `client/src/` (React) | the canvas, *Ask* (situation, intake cards, investigations), *Review*, *Context* | nothing authoritative lives in the browser; chat history is a per-browser convenience (localStorage) |

Ownership in practice: the person states; the companion computes and proposes; an agent (an investigation, an MCP client with an agent identity) proposes and can never ratify, approve, decide or apply. Every change to a document — a placement from intake included — is an entry in the operation log with its author and origin.

## 2. State and what to back up

```
$GRIDWRIGHT_DATA/
  files/<doc>.json, .meta.json         documents (checkpoints) and names
  history/<doc>.ops.jsonl, <doc>/N.json the operation log and checkpoints — the authority
  companion/<doc>.json                 the companion's state for that document
  companion/threads.sqlite             LangGraph threads (one per document) of investigations
  intake/<doc>/<hash>.<ext>, <hash>.json originals as they arrived, under their content hash, with the profile
  proposals/                           proposals and their decisions
  connections.json, ai.json, secret.key SQL connections and the model endpoint (passwords and keys encrypted with the secret)
  pyenv/                               the venv `install.sh --python` / `--companion` creates (not state)
  pycache/, pyodide/                   caches and the browser runtime (not state, excluded from backups)
```

Back up the whole directory: `~/gridwright-data/backup.sh` (the installer's nightly timer runs it, 14 kept, optional rsync target) or *Settings → Backup* / `GET /api/backup` (administrators). Deleting a document deletes its companion state, intake store and history with it; nothing else removes evidence. `threads.sqlite` can be deleted — investigations then start new threads; their results stay on the companion state.

## 3. Behaviour policies

**Who may do what.** Viewers read. Sign-off shares sign off and checkpoint, nothing else. Editors change documents, place intake, state records, approve watches, apply exclusions, start and stop investigations, decide proposals. Administrators also manage connections, the model endpoint and backups. Agents (investigations, agent MCP clients): read, run sandboxed code, propose records, propose watches, propose edits — never ratify, approve, decide, place or apply (`403` on those routes). The agent token an investigation carries is valid from the loopback interface only, for the requesting person's permissions, for the investigation's lifetime; it is revoked when the process ends and does not survive a restart.

**What the companion does on its own.** Deterministic checks when data changes and on a timer (10 minutes): source freshness, watches on their snapshots, cross-checks between sources, expectations against their sources, decision conditions, review dates. It records what it finds as events, issues and suggestions. It never changes a document, a watch, a threshold or a scope on its own; it never sends anything anywhere; it never refreshes an external source — a SQL snapshot is taken on request, the inbox is listed on request.

**What needs a person.** Placing a file (the card's decision), approving a suggested watch, applying an exclusion to the watches, confirming an inferred objective, ratifying a proposed record, deciding a proposal, stopping an investigation, settling a conflict.

**What never happens in this build.** No external communication, no ERP or bank access, no payments, no scheduled refresh, no watching of directories, no execution of macros, scripts or embedded instructions in files, no automatic reversal of a decision (a failing condition flags it for revisit).

**Telemetry.** None. The server logs to stdout (the service journal or `server.log`). The investigation process receives an explicit environment (`PATH`, `HOME`, `LANG`, the loopback base URL, its token, the model endpoint, the threads database) — no tracing variable from the host environment reaches it, so framework tracing cannot switch itself on. The model endpoint is whatever `AI_BASE_URL` / *Settings* points at; with a local endpoint nothing leaves the host.

**Fault points.** `GRIDWRIGHT_CRASH_AT` is test-only fault injection (`intake:placed`, `investigation:dispatched`) for `e2e/recovery.py`. Leave it unset in operation.

## 4. Configuration (example, no secrets)

The installer writes these into the systemd user unit from `GW_*` variables; set them the same way on the command line for a plain start.

```bash
PORT=8787  HOST=127.0.0.1                  # 127.0.0.1 behind tailscale serve, 0.0.0.0 on a trusted LAN
GRIDWRIGHT_DATA=$HOME/gridwright-data
GRIDWRIGHT_TRUST_TAILSCALE=1               # identity from Tailscale's headers (only behind tailscale serve)
GRIDWRIGHT_ADMINS=you@example.com
GRIDWRIGHT_DEFAULT_SHARING=none            # new documents private
GRIDWRIGHT_PYTHON=$HOME/gridwright-data/pyenv/bin/python
GRIDWRIGHT_PYTHON_SANDBOX=bwrap            # or require: refuse to run code without a namespace sandbox
GRIDWRIGHT_INBOX=$HOME/gridwright-inbox    # the one directory intake may list, on request
GRIDWRIGHT_INTAKE_MAX_MB=25
GRIDWRIGHT_AGENT_PYTHON=                   # unset: the data-directory venv when it has the stack, else python3
GRIDWRIGHT_INVESTIGATION_TIMEOUT_MS=600000
AI_BASE_URL=http://127.0.0.1:8888/v1       # an OpenAI-compatible endpoint; the key, if any, is set in Settings and stored encrypted
AI_MODEL=
```

Secrets (`GRIDWRIGHT_SECRET`, `GRIDWRIGHT_TOKEN`, `AI_API_KEY`, SQL passwords) are never in the repository; the secret is generated into `data/secret.key` when unset.

## 5. Reproducible local start

From source (Rust, Node 22, Python ≥ 3.10):

```bash
scripts/build.sh                                        # engine (both targets), client, server
python3 -m venv data/pyenv && data/pyenv/bin/pip install pandas numpy matplotlib openpyxl \
  -r integrations/companion/requirements.lock.txt       # Python cells + the investigation stack
mkdir -p /tmp/gw-inbox
(cd server && GRIDWRIGHT_DATA=../data GRIDWRIGHT_INBOX=/tmp/gw-inbox node dist/index.js)
```

From the prebuilt release (Node only): the two lines in the README, with `scripts/install.sh --companion --sandbox` for the stack and the strongest sandbox. `curl -s http://127.0.0.1:8787/api/health`, `/api/python` and `/api/investigation` say what is in use.

For the gate tests, the mock model and the databases: see the *Tests* section of the README (`node e2e/mock-llm.mjs`, `--pg`, `--mysql`). The mock is a scripted OpenAI-compatible server; a pass with it shows the wiring, not a model's reliability.

## 6. Upgrade and rollback

1. Back up: `~/gridwright-data/backup.sh` (or `GET /api/backup`).
2. Keep the current tree: `mv ~/gridwright-release ~/gridwright-release.prev`.
3. Install the new one: `cd ~ && curl -fsSL https://github.com/nmldias/gridwright/archive/refs/heads/release.tar.gz | tar xz && cd gridwright-release && scripts/install.sh --companion` (plus the options in use: `--tailscale`, `--sandbox`). The installer updates the unit and restarts the service; the data directory is untouched.
4. Check `/api/health` (version), `/api/investigation` (stack versions — the lock file's), open a document with a situation.

Rollback: stop the service, `mv ~/gridwright-release ~/gridwright-release.bad && mv ~/gridwright-release.prev ~/gridwright-release && cd ~/gridwright-release && scripts/install.sh …` with the same options; the previous build reads the same data directory. State formats are additive — 0.10.0 adds fields (`scope`, `intake`, `coverage`, `historical`, `inferred`, the `scenario` kind, investigation statuses `cancelled`/`superseded`) and the `intake/` directory; an older build ignores what it does not know and never deletes it. If a rollback must also undo data changes, restore the backup taken in step 1. A rollback of 0.10.0 to 0.9.0 was not exercised in this pass; a restore of the backup was (the backup is a tar of the directory).

No schema migration is needed for 0.9.x → 0.10.0: tables placed by intake are ordinary operations in the log; companion records gain optional fields.

## 7. Demo script (synthetic data, ~10 minutes)

Fixtures: `e2e/fixtures/vehicles/` (synthetic; expected figures in `expected.json`, computed independently by `expected.py` with `Decimal`).

1. Open the start page. *Bring a file in* → `inventory-2026-10-06.csv`. The document saves itself as a private draft named *inventory*; the card in *Ask* says *New here*, shows the columns (VIN with leading zeros kept, a 20-digit reference as text, Kz, dd/mm/yyyy, a `Total` row set aside) → **Add as a table**. Read the first reading: *5 vehicles; 606,929,999.5 total landed cost … One snapshot: what it holds, not how it is moving.*
2. Type, in your own words: *Preserve replacement-cost margin on disposals. Leave out vehicles reserved for customers.* — recorded as a constraint and an exclusion, with *recorded, not yet applied* and the yes/no column it maps to. Approve the suggested ageing watch (one tap). From *Context → the exclusion → apply to the watches*.
3. *Bring a file in* → `inventory-2026-10-13.csv`: *the next snapshot of inventory (same series, 2026-10-13 after 2026-10-06) — 1 new, 0 gone* → **Update inventory**. The watches now have two periods.
4. `inventory-2026-10-13-corrected.csv`: *a correction or re-delivery of 2026-10-13 — it replaces that period's evidence* → **Update**. The activity says *revised … same snapshot*; nothing counted twice.
5. `inventory-2026-09-29.csv`: *an older period — kept as history beside it, the current one stands* → **Keep as history**. `inventory-2026-10-13-benguela.csv`: *same columns, but Branch is “Benguela” here and “Luanda” there — a different entity, kept separate* → **Add as a table** (named *inventory Benguela*).
6. `invoices-2026-10-15.xml` → a table; the cross-check finds the freight desk's Creta cost disagreeing with the inventory: a conflict with both figures, in the situation's lead.
7. `inventory-2026-10-20-partial.csv` → the next snapshot, 4 vehicles gone; the trend comparison is suspended (*coverage changed (6 → 2 rows)*).
8. With the stack installed and a model configured: *Investigate* on the next move; *Stop* it; or type *Before discounts, see whether another branch could use them* while one runs and watch it being superseded.
9. `notes-hostile.csv` and `ragged.csv`: instruction-like cells counted and inert; the row wider than the header quarantined and listed.
10. With `GRIDWRIGHT_INBOX` set: copy `inventory-2026-10-27.csv` (make one from the 20 Oct file) into it; *Files → inbox* lists it; take it; it moves to `taken/`.

## 8. Prerequisites and tested platforms

- Node ≥ 22.13 (node:sqlite for the store; 22.22 used here); Python ≥ 3.10 with the lock file (3.13 in the development container, 3.12 in CI); bubblewrap and, on Ubuntu ≥ 23.10, the installer's AppArmor profile for the strongest sandbox; an OpenAI-compatible model endpoint for *Ask* and investigations (optional — everything deterministic works without one).
- Tested in this pass: Linux x86_64 (the development container, all suites; CI on `ubuntu-latest`). Spark 1 (arm64, DGX OS) ran 0.9.0 with the stack confirmed by `/api/investigation`; 0.10.0 has not been deployed there — see the report.
- PostgreSQL / MariaDB / SQL Server are only needed for the SQL suites and for SQL snapshots.
