# Gridwright

An AI-native spreadsheet with free-floating, resizable tables on an infinite canvas — built on the same stack as Quadratic (Rust → WebAssembly engine, TypeScript/React client rendering on a WebGL canvas, Python in the browser via Pyodide, JavaScript and SQL cells, an AI assistant and live multiplayer), with Apple Numbers-style tables that you drag and resize from their handles, and an audit trail that records every change. MIT-licensed, self-hosted, builds natively on arm64.

![Table with reference tabs and resize handles](docs/table-handles.png)

## Features

| Area | What works |
|---|---|
| **Tables (Numbers-style)** | Several named tables per document on a pannable/zoomable canvas. Drag the title to move; drag the **corner circle** to add/remove rows *and* columns at once, the **right handle** for columns, the **bottom handle** for rows; drag column/row edges to resize; reference tabs appear when a table is selected. Header row; insert/delete rows and columns with formula references rewritten; renaming a table rewrites every formula that mentions it. |
| **Formulas** | A1 references, ranges, whole columns/rows, cross-table references (`Sales::B2`, `'Table 1'::A1:C9`), **structured references** by header name (`Orders[Amount]`, `[@Unit price]`), **named ranges**, **270 functions** (`LET`, `OFFSET`, `INDIRECT`, `XMATCH`, `TEXTSPLIT`, `REGEXEXTRACT`, `PERCENTILE`, `CORREL`, `NORM.INV`, `HSTACK`/`VSTACK`/`TAKE`/`DROP`/`WRAPROWS`, …), dependency-driven recalculation with cycle detection, relative/absolute references that shift on copy/paste and fill-down, live preview while typing. |
| **Dynamic arrays** | A formula whose result is an array **spills** into the cells below/right (`=A1:A9*2`, `=FILTER(…)`, `=SORT(…)`, `=SORTBY(…)`, `=UNIQUE(…)`, `=SEQUENCE(…)`, `=TRANSPOSE(…)`); scalar functions lift over arrays (`=ROUND(A1:A9/3, 1)`), blocked spills show `#SPILL!` and recover when the blocker goes. |
| **Finance & dates** | NPV, IRR, MIRR, XNPV, XIRR, PMT, IPMT, PPMT, CUMIPMT, CUMPRINC, ISPMT, PV, FV, FVSCHEDULE, NPER, RATE, RRI, PDURATION, SLN, SYD, DB, DDB, EFFECT, NOMINAL; DATEDIF, YEARFRAC, DAYS360, NETWORKDAYS(.INTL), WORKDAY(.INTL), WEEKNUM, ISOWEEKNUM, EDATE, EOMONTH, TIME/TIMEVALUE/HOUR/MINUTE/SECOND. Dates typed as text (`2026-10-08`, `08/10/2026`, `8 Oct 2026 14:30`) become serial numbers with a matching format; `12%`, `€ 1.000,00`, `1,500 Kz` keep their formats. Patterns: `#,##0.00`, `#.##0,00` (decimal comma), `€#,##0.00`, `#,##0.00 "Kz"`, `yyyy-mm-dd hh:mm`, `d mmm yyyy`. |
| **Filters** | Header dropdowns (values or conditions) hide rows; `SUBTOTAL(101…111)` ignores hidden rows; sort A→Z/Z→A from the same menu; Ctrl+Shift+L. |
| **Conditional formatting** | Cell-value, text, colour scale, top/bottom N, duplicates, blanks, formula rules per table (Rules panel). |
| **Data validation** | List (literal or a range such as `Lists::A2:A20`, with a dropdown in the editor), number, whole number, date, text length; strict rules refuse the entry, others mark it with a red corner. |
| **Pivot tables** | A table can be the pivot of another: row fields, an optional column field, sum/count/average/min/max/distinct values, totals — recomputed by the engine whenever the source changes; formulas can reference the pivot. |
| **Python cells** | `q.cells("A1:B5")`, `q.df("Table 2::A1:D20")` (pandas), `q.table()`; the last expression spills; matplotlib figures render on the canvas; cells re-run when the cells they read change. Two runtimes, chosen per cell: **on the server** (the default when the host has Python) — real CPython with pandas/numpy/matplotlib, roughly 5–10× faster than the browser for pandas work, nothing to download on a phone; or **in the browser** — Pyodide (WebAssembly) in a web worker, packages auto-loaded from imports, optionally served by the server (`--pyodide`) so nothing is fetched from the internet. |
| **Server-side Python: sandbox & GPU** | Each run is a fresh process forked from a warm host (pandas already imported: ~10 ms overhead) inside the strongest sandbox the host offers — **bubblewrap** (own mount/PID/network namespaces; the data directory, home directories and secrets are invisible; `/tmp` is a throwaway), else a **user+network namespace** (`unshare -rn`: no network), else a plain process — with CPU, memory, file-size and wall-clock limits. The sandbox level is shown in the Code panel and written into every run record. **GPU**: tick *GPU* on a cell to run its pandas code through RAPIDS `cudf.pandas` when the host has it (DGX Spark: `pip install cudf-cu13` into the venv); without cuDF the cell runs on the CPU and the record says so. Worth it above a few million rows, not for month-end tables. |
| **JavaScript cells** | Isolated worker, `async` allowed, `return` a value / list / 2-D array / array of objects. |
| **SQL** | PostgreSQL, MySQL/MariaDB and **SQL Server** (Cegid Primavera, Azure SQL) connections, credentials encrypted at rest. **SQL cells** run a query from a cell: `{{A1}}` / `{{Orders::B2}}` bind cell values as parameters (a range becomes a list for `IN (…)`), the result spills, the cell re-runs when its parameters change, and can refresh on a schedule (30 s … 1 h). |
| **SQL policy (server-enforced)** | Every query — from the SQL panel, a SQL cell, the assistant's tools or an MCP agent — goes through one policy point on the server. Connections are **read-only by default**: a single SELECT, no stacked statements, no `pg_sleep`/`LOAD_FILE`/`xp_*`, *and* the session itself is opened read-only (`BEGIN READ ONLY`, `START TRANSACTION READ ONLY`) so a write hidden in a SELECT is refused by the database. Per connection: a **row limit** (streamed and cut on the server, reported as *truncated*), a **statement timeout** (cancelled database-side), and an optional **allow-list of logins** — other people do not even see the connection. Viewers cannot query. |
| **Charts (exhibits)** | Charts are objects on the canvas, drawn by the WebGL renderer and exported as SVG/PNG from the same layout. Column, horizontal bar, line, area, stacked and waterfall; an uppercase *EXHIBIT N — TOPIC* tag, an action title that states the takeaway, a grey subtitle with dataset and units, direct series labels (no legend), one highlighted observation in coral, a dashed benchmark line with an inline label, three stat cards and a source footnote. `+ Chart` builds one from the selection (header row → series names); drag to move, corner handle to resize, double-click to edit. The assistant can add charts too (`add_chart`). |
| **Review: sign-offs** | Select a range → *Sign off*: who, when, a note and a fingerprint of the values are recorded as an operation (so it is in the audit log). The badge turns amber the moment any value inside changes; a locked range refuses manual edits until unlocked. Share a document at *sign off* level to let a reviewer attest without editing. |
| **Review: run records** | Every run of a Python, JavaScript or SQL cell is recorded in the audit log with the hash of its code, the hash of the values it read, the runtime and package versions (CPython version, pandas/numpy/cuDF versions and the sandbox level for server runs; Pyodide and its loaded packages; the JS engine; the database kind) and the hash of its output. The Review panel shows each code cell as **verified** (the output on screen is the recorded result of the current code and inputs), *inputs changed*, *code changed*, *failed* or *not run*; the CSV export carries the records as `code_run` rows. |
| **Review: checks & trace** | `=CHECK(condition, "label")` cells are collected in the Review panel (passing / failing). *Trace* shows precedents (navy) and dependents (coral) of the active cell on the canvas; Ctrl+[ / Ctrl+] walk through them. |
| **Finance primitives** | `FX(amount, "USD", "AOA", [date])` and `FXRATE()` against a table named **FX** (Date \| From \| To \| Rate: latest rate on or before the date, inverse and triangulated rates); `RECONCILE(rangeA, rangeB, [tolerance])` spills Key \| A \| B \| Difference \| Status (Matched / Only in A / Only in B / Difference); `AGEING(dates, amounts, [as_of], [edges])` spills Bucket \| Count \| Amount \| Share; `AGE_BUCKET(date)` labels a row. Templates: accounts payable ageing, bank reconciliation, treasury position (with a Primavera SQL placeholder). |
| **MCP server & proposals** | `POST /mcp` is a Model Context Protocol server (streamable HTTP, stateless) with eleven typed tools: `list_documents`, `read_document`, `read_table`, `read_range`, `evaluate` (a formula against the live document, nothing written), `run_checks`, `read_history`, `list_connections`, `run_sql` (same policy as above), `propose_edit` and `list_proposals`. Agents never write directly: `propose_edit` validates the actions on a copy of the document **as the editors currently see it** (latest checkpoint + every logged operation) and files a **proposal** with a before → after diff. The Review panel lists pending proposals; a person applies or rejects each one, with a note. Applied proposals run as ordinary operations with origin *agent*; the proposal and the decision are both in the audit log. The same tools respect document sharing and identity. |
| **AI assistant** | Any OpenAI-compatible chat endpoint (vLLM, Ollama, llama.cpp, OpenRouter, OpenAI, Anthropic compatibility). Every proposal is shown as a **before → after diff**; nothing is written until you apply it, and applied changes are logged with origin *AI*. With tools on, the model can call read-only server tools — `run_sql` (SELECT only, ≤200 rows), `list_tables`, `describe_table`, `read_history` — and every call and result is shown in the chat. Endpoints without function calling fall back automatically. |
| **Audit trail** | The server sequences every change into a per-document log (who, when, from a person / the AI / a code cell / an import), with checkpoints at each save (compacted: all from the last day, daily for 30 days, weekly after). The History panel lists changes, filters them per cell, restores or downloads any earlier version, **compares two versions** cell by cell, and exports the trail as **CSV**. |
| **Multiplayer** | Server-ordered operations: concurrent edits converge on every client. In-flight cell edits are transformed past remote row/column inserts and deletes (operational transform), undo/redo travels as restore operations instead of document snapshots, remote changes never enter your own undo stack, structural conflicts resync from the log; presence cursors with names. |
| **Identity, roles & sharing** | Behind `tailscale serve`, the server trusts Tailscale's identity headers: names in presence and history, `GRIDWRIGHT_ADMINS` (connections, AI settings, backups) and `GRIDWRIGHT_READONLY` (viewers). Per document: an owner, *everyone can edit / view / nothing*, and shares per login at view / sign-off / edit level, enforced on REST, WebSocket and MCP. **New documents are private by default** when identity is on (`GRIDWRIGHT_DEFAULT_SHARING` changes this). Folders group documents. |
| **Files** | Saved on the server as JSON, autosave, import CSV/TSV/Excel/JSON, **export to .xlsx** (one sheet per table, formulas, formats, widths), CSV per table, **print / save as PDF** (tables as HTML, charts as SVG), one-click backup of the whole data directory, nightly backup timer. |
| **Editing** | Excel-like keyboard model, formula bar, number formats, bold/alignment/colours, **merged cells**, **wrapped text**, header rows that stay visible while scrolling, copy/cut/paste with other apps, fill handle, right-click menu, undo/redo, selection statistics. Touch: drag pans, tap selects, tap again edits, long-press opens the menu, pinch zooms; phone layout. |

![Python cell spilling a DataFrame](docs/python-cell.png)

## Architecture

```
core/     Rust crate → WebAssembly (wasm-bindgen). Model (workbook → tables → sparse cells), formula
          lexer/parser/evaluator with array lifting, dependency graph with cached deps and topological
          recalculation (cycles → #CYCLE!), dynamic-array spills, pivots, filters, validation,
          sign-offs (value fingerprints, locks), merges, charts as workbook objects, precedent/dependent
          tracing, undo/redo that emits restore operations, JSON ops API. Built twice: for the browser
          and for Node (the server evaluates documents headlessly for MCP and proposal validation). 37 unit tests.
client/   Vite + React + TypeScript. PixiJS v8 WebGL renderer (viewport culling, pooled bitmap text,
          on-demand frames, conditional formats), pointer/keyboard/touch controller, CodeMirror 6,
          zustand store (cell maps patched in place), workers for Python (Pyodide) and JavaScript,
          chart layout shared by the Pixi and SVG backends, Review/Chart/SQL/AI/history/rules panels,
          print view, SheetJS import/export.
server/   Node 22 + Express + ws. Static client, documents on disk with per-document access metadata
          (owner, shares, folder), the per-document operation log, checkpoints and audit CSV
          (data/history), SQL connections (pg, mysql2, mssql) behind one policy point (read-only
          sessions, limits, allow-lists), streaming AI proxy with a server-side tool loop, MCP server
          (typed tools, proposals validated on the headless engine), server-side Python cells (warm
          CPython host pool, bubblewrap/userns sandbox, limits, cuDF opt-in; server/runner/), identity
          (Tailscale headers), backups, optional self-hosted Pyodide, WebSocket sequencer. No database required.
```

Every change is an *operation* (`set_cell`, `resize_table`, `set_pivot`, `set_filters`, …). The client applies it optimistically, the server assigns it a sequence number, appends it to the document's log and broadcasts it; clients apply remote operations in server order and rebase or resync when an in-flight operation crosses a remote one. Code-cell results are derived state: each client recomputes them; what *is* logged is a run record per execution (hashes of code, inputs and output plus the runtime), which is how the Review panel knows whether the output on screen is current.

## Run it

### One line on any Linux box (arm64 or x86_64), no root

```bash
curl -fsSL https://github.com/nmldias/gridwright/archive/refs/heads/release.tar.gz | tar xz \
  && cd gridwright-release && scripts/install.sh
```

The `release` branch carries the prebuilt engine, client and server, so only Node ≥ 20 is needed (the installer fetches Node 22 into `~/.local` if the host has none). It registers a systemd *user* service `gridwright` (restarts on failure, starts at boot once linger is enabled), a nightly backup timer, and prints the URL. Options:

```bash
scripts/install.sh --tailscale   # HTTPS on the tailnet via `tailscale serve`, identity + roles from Tailscale
scripts/install.sh --python      # venv with pandas/numpy/matplotlib for server-side Python cells (recommended)
scripts/install.sh --sandbox     # bubblewrap + an AppArmor profile so cells run fully isolated on Ubuntu ≥ 23.10 (sudo once)
scripts/install.sh --pyodide     # download the browser Python runtime (~400 MB) for offline Pyodide cells
GW_TOKEN=$(openssl rand -hex 16) GW_ADMINS=you@example.com AI_BASE_URL=http://host:8888/v1 scripts/install.sh
```

Re-run the same two lines in a fresh folder to upgrade (the data directory `~/gridwright-data` is kept). Server-side Python cells use the host's `python3` as it is, or the venv `--python` creates. For the strongest sandbox run once with `--sandbox`: it installs bubblewrap and, on Ubuntu 23.10+ (DGX OS included, where the kernel confines unprivileged user namespaces so plain `bwrap`/`unshare` cannot set up a sandbox), a small AppArmor profile granting `userns` to bubblewrap — the installer prints the sandbox level it ends up with, and `/api/python` says why a stronger one was not used. `--tailscale` needs `sudo tailscale set --operator=$USER` once and HTTPS certificates enabled in the Tailscale admin console.

### Docker

```bash
docker compose -f docker-compose.ghcr.yml up -d      # published multi-arch image ghcr.io/nmldias/gridwright
docker compose up -d --build                         # or build from source on this host (~10 min first time)
```

Documents, history, connections and settings live in `./data`; put a Pyodide distribution in `./data/pyodide` for offline browser Python. The image ships python3 + pandas + matplotlib for server-side cells; inside Docker the container is the sandbox (no nested namespaces), so give it no more than it needs.

### From source

Requirements: Rust (rustup), Node 22. `scripts/build.sh` builds the wasm engine, the client and the server; `cd server && npm start`. Development with hot reload: `scripts/dev.sh`.

### Configuration (environment)

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | listen address (default `0.0.0.0:8787`; `127.0.0.1` behind `tailscale serve`) |
| `GRIDWRIGHT_DATA` | data directory (`./data`; `/data` in Docker) |
| `GRIDWRIGHT_SECRET` | key that encrypts stored DB passwords and AI keys; generated into `data/secret.key` when unset |
| `GRIDWRIGHT_TOKEN` | optional shared access token; open `http://host:8787/?token=…` once per browser |
| `GRIDWRIGHT_TRUST_TAILSCALE` | `1` to trust `Tailscale-User-Login/Name` headers from `tailscale serve` (bind to 127.0.0.1!) |
| `GRIDWRIGHT_ADMINS`, `GRIDWRIGHT_READONLY` | comma-separated logins: administrators (connections, AI settings, backups) and viewers |
| `GRIDWRIGHT_DEFAULT_SHARING` | sharing level of a new document: `none` (private; the default when identity is on), `view` or `edit` (the default without identity) |
| `GRIDWRIGHT_PYODIDE_DIR` | directory of a Pyodide distribution served at `/pyodide/` (default `data/pyodide`) |
| `GRIDWRIGHT_PYTHON` | interpreter for server-side Python cells: a path, `off`, or unset = `data/pyenv/bin/python` (made by `install.sh --python`) else `python3` on PATH |
| `GRIDWRIGHT_PYTHON_SANDBOX` | `auto` (bubblewrap → user namespace → none), `bwrap`, `unshare`, `none`, or `require` (no namespace sandbox = runtime off). `/api/health` and every run record report what is in use |
| `GRIDWRIGHT_PYTHON_TIMEOUT_MS`, `GRIDWRIGHT_PYTHON_MEMORY_MB`, `GRIDWRIGHT_PYTHON_CONCURRENCY` | per-run wall-clock limit (60 000), address-space cap for CPU runs (2 048; GPU runs are uncapped because CUDA reserves address space), parallel runs (2) |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | defaults for the assistant (also editable in the UI, stored encrypted) |

## Using it

**Tables.** `+ Table` adds one. Click a title to select the table: reference tabs and three handles appear; drag the corner circle diagonally to grow or shrink in both directions. Code-cell output and spilled arrays grow the table automatically. The Table panel exposes name, size, header row, insert/delete at the selection, and the **pivot** definition.

**Formulas.** `=SUM(Orders[Amount])`, `=[@Units]*[@Unit price]`, `=XLOOKUP(A2, Prices[SKU], Prices[Price])`, `=FILTER(Orders[Amount], Orders[Region]="North")`, `=PMT(Rate/12, 360, Loan)` (names are defined in the Rules panel or from the context menu). Errors: `#DIV/0! #REF! #NAME? #VALUE! #N/A #CYCLE! #NUM! #SPILL!`.

**Code cells.** Select a cell, press **Py**, **JS** or **SQL**, write code, Ctrl+Enter. Output spills from the cell. A Python cell's runtime is chosen in the Code panel — *run on the server (CPython x.y)* or *run in the browser (Pyodide)* — with a *GPU* tick for server runs; the pill next to *Run* shows the sandbox level. SQL cells take a connection and an optional refresh interval:

```sql
SELECT region, SUM(amount) AS total FROM orders WHERE invoice_date >= {{B1}} AND region IN ({{Regions::A2:A6}}) GROUP BY region
```

**Rules.** The Rules panel adds conditional formatting, validation and names to the current selection. Right-click → *Cell history* shows every change to one cell.

**AI.** AI panel → ⚙ → base URL + model (the model list is fetched from the endpoint). Proposals appear as a diff with Apply/Dismiss; Ctrl+Z reverts applied ones.

**History.** History panel → list of changes with author and origin; *download as of here* builds the document as it was; *restore* makes it the current version (recorded as a new change, undo also works); *compare…* on two entries lists every cell that differs; *CSV* downloads the audit trail.

**Charts.** Select the data (header row included) → `+ Chart`. The Chart panel sets the exhibit tag, title, subtitle, source, categories and series ranges (`Sales::B2:B13` or `Sales[Revenue]`), the highlighted category, a reference line, value labels and stat cards; *Download SVG / PNG* and *Print* use the same layout as the canvas.

**Review.** Review panel → *Sign off selection* (optionally locking it); the list shows each sign-off with *unchanged* / *changed since*. `=CHECK(D20 = SUM(D2:D19), "Total ties")` cells are listed as checks. *Trace active cell* overlays precedents and dependents; Ctrl+[ and Ctrl+] jump through them.

**SQL connections.** DB panel (administrators): host, database, credentials, *read-only* (default on — turning it off allows writes for people on the allow-list only), *allowed logins*, *row limit* (≤ 50 000) and *timeout* (≤ 5 min). Everything that runs SQL goes through these.

**Agents (MCP).** Point an MCP client at `https://host/mcp` (the same identity rules apply, so put it behind Tailscale). Agents read tables and evaluate formulas directly; edits arrive as proposals in the Review panel, where you see the diff and apply or reject it. Try it from a shell:

```bash
curl -s -X POST http://localhost:8787/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_table","arguments":{"id":"<document id>","table":"Orders"}}}'
```

**Sharing.** Files panel (identity on): everyone-on-this-server *can edit / can view / no access*, plus shares per login at *view*, *sign off* or *edit* level; the owner (document creator, or an admin) changes these. Folders are free text (`Finance/2026`).

**Keyboard.** Enter/F2 edit · typing replaces · Enter ↓ / Tab → · arrows, Shift+arrows, Ctrl+arrows · Ctrl+C/X/V · Ctrl+Z/Y · Ctrl+B bold · Ctrl+D fill down · Ctrl+A select table · Ctrl+Shift+L filter · Ctrl+[ / Ctrl+] trace · Delete clears (or deletes the selected chart) · wheel pans, Ctrl+wheel zooms, Space+drag pans · Ctrl+Enter runs a code cell · Ctrl+S saves.

![Two clients on one document](docs/multiplayer.png)

## Performance notes

Measured in headless Chromium with software WebGL (SwiftShader): filling a 5 000 × 30 table (150 000 cells, 5 000 formulas) takes ≈0.6 s; a single edit with a dependent formula ≈8 ms median (dependency rectangles are cached in the engine and the client patches its cell maps in place); a frame costs ≈11 ms only when something changed. Formulas that read a whole column re-evaluate in ≈10 ms.

## Tests

```bash
cd core && cargo test                                   # engine: 37 tests (incl. a check that every listed function resolves)
python3 e2e/smoke.py http://localhost:8787 --python     # editing, handles, code cells, save/open (22 checks)
node e2e/mock-llm.mjs &                                 # mock model for the assistant (also plays a tool round)
python3 e2e/features.py http://localhost:8787 --pg host:port:db:user:pass --mock-llm http://127.0.0.1:8899/v1
                                                        # arrays, refs, filters, rules, pivots, SQL cells, history,
                                                        # AI diff, convergence, touch (40 checks)
python3 e2e/features2.py http://localhost:8787 --pg … --mock-llm … --acl http://127.0.0.1:8795
                                                        # charts, sign-offs, CHECK/FX/RECONCILE/AGEING, trace, merges,
                                                        # undo as ops, OT, audit CSV, AI tools, templates, sharing (44 checks)
python3 e2e/features3.py http://localhost:8787 --pg … --acl http://127.0.0.1:8795
                                                        # SQL policy (refusals, read-only session, limits, timeout, allow-list),
                                                        # run records, MCP tools, proposals end to end, private by default (32 checks)
python3 e2e/features4.py http://localhost:8787 --data ./server/data
                                                        # server-side Python: sandbox isolation, limits, warm-host latency, figures,
                                                        # Code panel runtime/GPU controls, run records, agent proposals (25 checks)
python3 e2e/sqlserver.py http://localhost:8787 --mssql host:port:db:user:pass   # SQL Server driver (8 checks)
python3 e2e/perf.py http://localhost:8787               # fill / edit / frame timings
```

CI (`.github/workflows/ci.yml`) runs all of this on every push against PostgreSQL and SQL Server containers plus a second server with identity on, with bubblewrap installed so the strongest sandbox is the one exercised (and a command-line check of the MCP endpoint and the SQL policy), publishes the prebuilt tree to the `release` branch and a multi-arch image to GHCR.

## Limitations (honest list)

- No freeze panes beyond the sticky header row of the selected table; merged cells cannot span a header/body boundary meaningfully; row heights do not auto-grow for wrapped text.
- Charts cover the exhibit styles above (no pie, scatter or secondary axes); a chart reads its ranges on every change, so keep series under a few thousand points.
- Multiplayer: two people changing the *structure* of the same table at once (inserting rows while another resizes) still resolve by resyncing from the server's log — correct but visible as a brief reload. Code-cell outputs are recomputed by every client rather than shared.
- SQL Server is exercised in CI against the official container, not yet against a Primavera instance — report the first error you see.
- The AI assistant needs a model that follows the JSON action format and, for tools, OpenAI-style function calling; small local models may need a retry.
- The SQL policy's text filter is a first line only; the database-side read-only session is what actually prevents writes, and it exists for PostgreSQL and MySQL. SQL Server has no equivalent, so a read-write login there relies on the filter and the row/time limits — give Gridwright a read-only login. MySQL streaming is compiled and unit-exercised but not yet run in CI.
- Server-side Python runs arbitrary code on the host as the service user. With bubblewrap it cannot see the data directory, home directories or the network; with only a user namespace it cannot use the network but can read what the service user can read; with neither it is an ordinary process — `GRIDWRIGHT_PYTHON_SANDBOX=require` refuses that. On Ubuntu 23.10+ the sandbox needs the AppArmor profile `install.sh --sandbox` adds (CI proves the recipe on 24.04); inside Docker the container is the boundary. The GPU path (cuDF, `/dev/nvidia*` bound into the sandbox) is implemented but has not yet been exercised on a DGX Spark; the CPU path has.
- Run records attest that an output came from a given code and inputs on a given runtime; they do not re-execute anything. A record is written by the client that ran the cell, so a tampered client could lie — the audit trail says who.
- MCP is stateless HTTP only (no SSE sessions, no resources or prompts); agents see documents with the permission of the identity the request carries.
- Sharing is enforced by the server only when identity is on (Tailscale headers); without identity every document — and the MCP endpoint — is open to whoever reaches the server. Put it behind Tailscale or a reverse proxy for anything beyond a trusted network.

## Licence

MIT. Third-party: PixiJS (MIT), CodeMirror (MIT), Pyodide (MPL-2.0, fetched at runtime or self-hosted), React (MIT), Express/ws/pg/mysql2/mssql (MIT), SheetJS (Apache-2.0), Rust crates serde/serde_json/wasm-bindgen/regex-lite (MIT/Apache-2.0), @modelcontextprotocol/sdk and zod (MIT).
