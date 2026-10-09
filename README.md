# Gridwright

An AI-native spreadsheet with free-floating, resizable tables on an infinite canvas — built on the same stack as Quadratic (Rust → WebAssembly engine, TypeScript/React client rendering on a WebGL canvas, Python in the browser via Pyodide, JavaScript and SQL cells, an AI assistant and live multiplayer), with Apple Numbers-style tables that you drag and resize from their handles, and an audit trail that records every change. MIT-licensed, self-hosted, builds natively on arm64.

![Table with reference tabs and resize handles](docs/table-handles.png)

## Features

| Area | What works |
|---|---|
| **Tables (Numbers-style)** | Several named tables per document on a pannable/zoomable canvas. Drag the title to move; drag the **corner circle** to add/remove rows *and* columns at once, the **right handle** for columns, the **bottom handle** for rows; drag column/row edges to resize; reference tabs appear when a table is selected. Header row; insert/delete rows and columns with formula references rewritten; renaming a table rewrites every formula that mentions it. |
| **Formulas** | A1 references, ranges, whole columns/rows, cross-table references (`Sales::B2`, `'Table 1'::A1:C9`), **structured references** by header name (`Orders[Amount]`, `[@Unit price]`), **named ranges**, ~140 functions, dependency-driven recalculation with cycle detection, relative/absolute references that shift on copy/paste and fill-down, live preview while typing. |
| **Dynamic arrays** | A formula whose result is an array **spills** into the cells below/right (`=A1:A9*2`, `=FILTER(…)`, `=SORT(…)`, `=SORTBY(…)`, `=UNIQUE(…)`, `=SEQUENCE(…)`, `=TRANSPOSE(…)`); scalar functions lift over arrays (`=ROUND(A1:A9/3, 1)`), blocked spills show `#SPILL!` and recover when the blocker goes. |
| **Finance & dates** | NPV, IRR, XNPV, XIRR, PMT, IPMT, PPMT, PV, FV, NPER, RATE, SLN, EFFECT, NOMINAL; DATEDIF, YEARFRAC, NETWORKDAYS, WORKDAY, EDATE, EOMONTH, TIME/HOUR/MINUTE/SECOND. Dates typed as text (`2026-10-08`, `08/10/2026`, `8 Oct 2026 14:30`) become serial numbers with a matching format; `12%`, `€ 1.000,00`, `1,500 Kz` keep their formats. Patterns: `#,##0.00`, `#.##0,00` (decimal comma), `€#,##0.00`, `#,##0.00 "Kz"`, `yyyy-mm-dd hh:mm`, `d mmm yyyy`. |
| **Filters** | Header dropdowns (values or conditions) hide rows; `SUBTOTAL(101…111)` ignores hidden rows; sort A→Z/Z→A from the same menu; Ctrl+Shift+L. |
| **Conditional formatting** | Cell-value, text, colour scale, top/bottom N, duplicates, blanks, formula rules per table (Rules panel). |
| **Data validation** | List (literal or a range such as `Lists::A2:A20`, with a dropdown in the editor), number, whole number, date, text length; strict rules refuse the entry, others mark it with a red corner. |
| **Pivot tables** | A table can be the pivot of another: row fields, an optional column field, sum/count/average/min/max/distinct values, totals — recomputed by the engine whenever the source changes; formulas can reference the pivot. |
| **Python cells** | Pyodide (WebAssembly) in a web worker; `q.cells("A1:B5")`, `q.df("Table 2::A1:D20")` (pandas), `q.table()`; the last expression spills; packages auto-load from imports; matplotlib figures render on the canvas; cells re-run when the cells they read change. The runtime can be served by the server (`--pyodide`) so nothing is fetched from the internet. |
| **JavaScript cells** | Isolated worker, `async` allowed, `return` a value / list / 2-D array / array of objects. |
| **SQL** | PostgreSQL, MySQL/MariaDB and **SQL Server** (Cegid Primavera, Azure SQL) connections, credentials encrypted at rest. **SQL cells** run a query from a cell: `{{A1}}` / `{{Orders::B2}}` bind cell values as parameters (a range becomes a list for `IN (…)`), the result spills, the cell re-runs when its parameters change, and can refresh on a schedule (30 s … 1 h). |
| **AI assistant** | Any OpenAI-compatible chat endpoint (vLLM, Ollama, llama.cpp, OpenRouter, OpenAI, Anthropic compatibility). Every proposal is shown as a **before → after diff**; nothing is written until you apply it, and applied changes are logged with origin *AI*. |
| **Audit trail** | The server sequences every change into a per-document log (who, when, from a person / the AI / a code cell / an import), with checkpoints at each save. The History panel lists changes, filters them per cell, and can restore or download any earlier version. |
| **Multiplayer** | Server-ordered operations: concurrent edits converge on every client (cell-level conflicts rebase, structural conflicts resync from the log), presence cursors with names. |
| **Identity & roles** | Behind `tailscale serve`, the server trusts Tailscale's identity headers: names in presence and history, `GRIDWRIGHT_ADMINS` (connections, AI settings, backups) and `GRIDWRIGHT_READONLY` (viewers). |
| **Files** | Saved on the server as JSON, autosave, import CSV/TSV/Excel/JSON, **export to .xlsx** (one sheet per table, formulas, formats, widths), CSV per table, one-click backup of the whole data directory, nightly backup timer. |
| **Editing** | Excel-like keyboard model, formula bar, number formats, bold/alignment/colours, copy/cut/paste with other apps, fill handle, right-click menu, undo/redo, selection statistics. Touch: drag pans, tap selects, tap again edits, long-press opens the menu, pinch zooms; phone layout. |

![Python cell spilling a DataFrame](docs/python-cell.png)

## Architecture

```
core/     Rust crate → WebAssembly (wasm-bindgen). Model (workbook → tables → sparse cells), formula
          lexer/parser/evaluator with array lifting, dependency graph with cached deps and topological
          recalculation (cycles → #CYCLE!), dynamic-array spills, pivots, filters, validation,
          undo/redo, JSON ops API. 24 unit tests.
client/   Vite + React + TypeScript. PixiJS v8 WebGL renderer (viewport culling, pooled bitmap text,
          on-demand frames, conditional formats), pointer/keyboard/touch controller, CodeMirror 6,
          zustand store (cell maps patched in place), workers for Python (Pyodide) and JavaScript,
          SQL/AI/history/rules panels, SheetJS import/export.
server/   Node 22 + Express + ws. Static client, documents on disk, the per-document operation log
          and checkpoints (data/history), SQL connections (pg, mysql2, mssql), streaming AI proxy,
          identity (Tailscale headers), backups, optional self-hosted Pyodide, WebSocket sequencer.
          No database required.
```

Every change is an *operation* (`set_cell`, `resize_table`, `set_pivot`, `set_filters`, …). The client applies it optimistically, the server assigns it a sequence number, appends it to the document's log and broadcasts it; clients apply remote operations in server order and rebase or resync when an in-flight operation crosses a remote one. Code-cell results are derived state: each client recomputes them and they are not logged.

## Run it

### One line on any Linux box (arm64 or x86_64), no root

```bash
curl -fsSL https://github.com/nmldias/gridwright/archive/refs/heads/release.tar.gz | tar xz \
  && cd gridwright-release && scripts/install.sh
```

The `release` branch carries the prebuilt engine, client and server, so only Node ≥ 20 is needed (the installer fetches Node 22 into `~/.local` if the host has none). It registers a systemd *user* service `gridwright` (restarts on failure, starts at boot once linger is enabled), a nightly backup timer, and prints the URL. Options:

```bash
scripts/install.sh --tailscale   # HTTPS on the tailnet via `tailscale serve`, identity + roles from Tailscale
scripts/install.sh --pyodide     # download the Python runtime (~400 MB) so Python cells work offline
GW_TOKEN=$(openssl rand -hex 16) GW_ADMINS=you@example.com AI_BASE_URL=http://host:8888/v1 scripts/install.sh
```

Re-run the same two lines in a fresh folder to upgrade (the data directory `~/gridwright-data` is kept). `--tailscale` needs `sudo tailscale set --operator=$USER` once and HTTPS certificates enabled in the Tailscale admin console.

### Docker

```bash
docker compose -f docker-compose.ghcr.yml up -d      # published multi-arch image ghcr.io/nmldias/gridwright
docker compose up -d --build                         # or build from source on this host (~10 min first time)
```

Documents, history, connections and settings live in `./data`; put a Pyodide distribution in `./data/pyodide` for offline Python.

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
| `GRIDWRIGHT_PYODIDE_DIR` | directory of a Pyodide distribution served at `/pyodide/` (default `data/pyodide`) |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | defaults for the assistant (also editable in the UI, stored encrypted) |

## Using it

**Tables.** `+ Table` adds one. Click a title to select the table: reference tabs and three handles appear; drag the corner circle diagonally to grow or shrink in both directions. Code-cell output and spilled arrays grow the table automatically. The Table panel exposes name, size, header row, insert/delete at the selection, and the **pivot** definition.

**Formulas.** `=SUM(Orders[Amount])`, `=[@Units]*[@Unit price]`, `=XLOOKUP(A2, Prices[SKU], Prices[Price])`, `=FILTER(Orders[Amount], Orders[Region]="North")`, `=PMT(Rate/12, 360, Loan)` (names are defined in the Rules panel or from the context menu). Errors: `#DIV/0! #REF! #NAME? #VALUE! #N/A #CYCLE! #NUM! #SPILL!`.

**Code cells.** Select a cell, press **Py**, **JS** or **SQL**, write code, Ctrl+Enter. Output spills from the cell. SQL cells take a connection and an optional refresh interval:

```sql
SELECT region, SUM(amount) AS total FROM orders WHERE invoice_date >= {{B1}} AND region IN ({{Regions::A2:A6}}) GROUP BY region
```

**Rules.** The Rules panel adds conditional formatting, validation and names to the current selection. Right-click → *Cell history* shows every change to one cell.

**AI.** AI panel → ⚙ → base URL + model (the model list is fetched from the endpoint). Proposals appear as a diff with Apply/Dismiss; Ctrl+Z reverts applied ones.

**History.** History panel → list of changes with author and origin; *download as of here* builds the document as it was; *restore* makes it the current version (recorded as a new change, undo also works).

**Keyboard.** Enter/F2 edit · typing replaces · Enter ↓ / Tab → · arrows, Shift+arrows, Ctrl+arrows · Ctrl+C/X/V · Ctrl+Z/Y · Ctrl+B bold · Ctrl+D fill down · Ctrl+A select table · Ctrl+Shift+L filter · Delete clears · wheel pans, Ctrl+wheel zooms, Space+drag pans · Ctrl+Enter runs a code cell · Ctrl+S saves.

![Two clients on one document](docs/multiplayer.png)

## Performance notes

Measured in headless Chromium with software WebGL (SwiftShader): filling a 5 000 × 30 table (150 000 cells, 5 000 formulas) takes ≈0.6 s; a single edit with a dependent formula ≈8 ms median (dependency rectangles are cached in the engine and the client patches its cell maps in place); a frame costs ≈11 ms only when something changed. Formulas that read a whole column re-evaluate in ≈10 ms.

## Tests

```bash
cd core && cargo test                                   # engine: 24 tests
python3 e2e/smoke.py http://localhost:8787 --python     # editing, handles, code cells, save/open (22 checks)
node e2e/mock-llm.mjs &                                 # mock model for the assistant
python3 e2e/features.py http://localhost:8787 --pg host:port:db:user:pass --mock-llm http://127.0.0.1:8899/v1
                                                        # arrays, refs, filters, rules, pivots, SQL cells, history,
                                                        # AI diff, convergence, touch (40 checks)
python3 e2e/perf.py http://localhost:8787               # fill / edit / frame timings
```

CI (`.github/workflows/ci.yml`) runs all of this on every push, publishes the prebuilt tree to the `release` branch and a multi-arch image to GHCR.

## Limitations (honest list)

- No cell merging, text wrapping or freeze panes. Charts come only from Python (matplotlib) cells.
- Conditional-format *formula* rules are evaluated per visible cell on each redraw (fine up to a few thousand cells per rule).
- Multiplayer: structural conflicts (two people inserting rows at once) resolve by resyncing from the server's log — correct but visible as a brief reload. Code-cell outputs are recomputed by every client rather than shared.
- SQL Server support uses the `mssql`/tedious driver with `trustServerCertificate`; it has not been exercised against a Primavera instance here — report the first error you see.
- The AI assistant needs a model that follows the JSON action format; small local models may need a retry.
- Single document store, one role model (admin / editor / viewer); put it behind Tailscale or a reverse proxy for anything beyond a trusted network.

## Licence

MIT. Third-party: PixiJS (MIT), CodeMirror (MIT), Pyodide (MPL-2.0, fetched at runtime or self-hosted), React (MIT), Express/ws/pg/mysql2/mssql (MIT), SheetJS (Apache-2.0), Rust crates serde/serde_json/wasm-bindgen (MIT/Apache-2.0).
