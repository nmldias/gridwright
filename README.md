# Gridwright

An AI-native spreadsheet with free-floating, resizable tables on an infinite canvas — built on the same stack as Quadratic (Rust → WebAssembly engine, TypeScript/React client rendering on a WebGL canvas, Python in the browser via Pyodide, JavaScript cells, SQL connections, an AI assistant and live multiplayer), with Apple Numbers-style tables that you drag and resize from their handles. MIT-licensed, self-hosted, builds natively on arm64.

![Table with reference tabs and resize handles](docs/table-handles.png)

## Features

| Area | What works today |
|---|---|
| **Tables (Numbers-style)** | Several named tables per document on a pannable/zoomable canvas. Drag the title to move; drag the **corner circle** to add/remove rows *and* columns at once, the **right handle** for columns, the **bottom handle** for rows; drag column/row edges to resize; reference tabs (A, B, C… / 1, 2, 3…) appear when a table is selected; click a tab to select a whole column/row, the corner to select the table. Header row styling; insert/delete rows and columns with formula references rewritten. |
| **Formulas** | `=` formulas with A1 references, ranges, whole columns/rows, cross-table references (`Sales::B2`, `'Table 1'::A1:C9`), ~90 functions (SUM…XLOOKUP, SUMIFS, INDEX/MATCH, TEXT, dates), dependency-driven recalculation, cycle detection, relative/absolute references that shift on copy/paste and fill-down, live preview while typing. |
| **Python cells** | Pyodide (WebAssembly) in a web worker; `q.cells("A1:B5")`, `q.df("Table 2::A1:D20")` (pandas), `q.table()`; the last expression spills into the sheet (DataFrames with a header row); packages auto-load from imports; stdout/errors shown in the code panel; cells re-run when the cells they read change. |
| **Charts** | A Python cell whose result is a matplotlib figure (or axes) renders the picture on the canvas, anchored to the cell and sized to its pixels; it re-renders when the data changes. |
| **JavaScript cells** | Isolated worker, `async` allowed (`await fetch(...)`), `return` a value / list / 2-D array / array of objects; same `q` API. |
| **SQL** | PostgreSQL and MySQL/MariaDB connections (credentials encrypted at rest on the server); results land in a new table or at the selection. |
| **AI assistant** | Any OpenAI-compatible chat endpoint (vLLM, Ollama, llama.cpp, OpenRouter, OpenAI, Anthropic's compatibility endpoint). Sees table names, sizes, first rows and the selection; replies can include a `gridwright-actions` block that writes cells, formulas, code cells or new tables — applied with one click or automatically, always undoable. Streaming. |
| **Multiplayer** | Open the same document in two browsers: edits are relayed live over WebSocket, with presence cursors and names. |
| **Documents** | Saved on the server as JSON (`data/files`), autosave, import CSV/TSV and Excel (.xlsx — one table per sheet, formulas kept) and Gridwright JSON, download JSON, export a table as CSV. |
| **Editing** | Excel-like keyboard model, formula bar, number formats, bold/alignment/colours, copy/cut/paste with other apps (TSV), fill handle (series and formula fill), right-click menu (rows/columns, sort A→Z/Z→A, code cells, export), undo/redo (200 steps), selection statistics. |

![Python cell spilling a DataFrame](docs/python-cell.png)

## Architecture

```
core/     Rust crate → WebAssembly (wasm-bindgen). Model (workbook → tables → sparse cells),
          formula lexer/parser/evaluator, dependency graph & topological recalculation with
          cycle detection, code-cell spill handling, undo/redo, JSON ops API. 20 unit tests.
client/   Vite + React + TypeScript. PixiJS v8 WebGL renderer with viewport culling and pooled
          bitmap text; pointer/keyboard controller; CodeMirror 6 editors; zustand store;
          workers for Python (Pyodide) and JavaScript; AI/SQL/files panels.
server/   Node 22 + Express + ws. Static client, documents on disk, SQL connections (pg, mysql2),
          streaming AI proxy, WebSocket rooms for multiplayer. No database required.
```

Every change to a document is an *operation* (`set_cell`, `resize_table`, `move_table`, `insert_rows`, `code_result`, …) applied by the engine, which returns the changed cells and the code cells that must re-run. The same ops are relayed to other clients, so local and remote edits follow one code path.

## Run it

### Docker (recommended; arm64 and amd64)

```bash
git clone <this repo> gridwright && cd gridwright
GRIDWRIGHT_SECRET="$(openssl rand -hex 32)" docker compose up -d --build
# open http://<host>:8787
```

The build compiles the Rust engine to wasm, bundles the client and the server (≈10 min on a DGX Spark the first time, cached afterwards). Documents, connections and settings live in `./data`. All base images (`rust`, `node`) are multi-arch, so this is a native arm64 image when built on an arm64 host.

### Prebuilt (Node only)

The release tarball ships the compiled engine (`client/src/engine/pkg`), the client bundle (`client/dist`) and the server (`server/dist`), so an arm64 or amd64 box only needs Node 22:

```bash
tar -xzf gridwright.tar.gz && cd gridwright/server
npm ci --omit=dev --no-audit --no-fund
GRIDWRIGHT_DATA=/srv/gridwright PORT=8787 npm start      # http://<host>:8787
```

### Without Docker, from source

Requirements: Rust (rustup), Node 22. Python is **not** needed on the server (it runs in the browser).

```bash
scripts/build.sh          # wasm engine → client bundle → server
cd server && npm start    # http://localhost:8787
```

Development with hot reload: `scripts/dev.sh` (server on 8787, Vite on 5173).

### Configuration (environment)

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | listen address (default `0.0.0.0:8787`) |
| `GRIDWRIGHT_DATA` | data directory (default `./data`; `/data` in Docker) |
| `GRIDWRIGHT_SECRET` | key that encrypts stored DB passwords and AI keys; if unset a random one is generated into `data/secret.key` (keep it with backups) |
| `GRIDWRIGHT_TOKEN` | optional shared access token; open `http://host:8787/?token=…` once per browser |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | defaults for the assistant (also editable in the UI, stored encrypted) |

**Python offline.** By default the Pyodide runtime (~10 MB, plus packages on demand) is fetched from jsDelivr by the *browser*. For an air-gapped setup download the Pyodide 0.27.5 release tarball, serve it somewhere (e.g. nginx at `/pyodide/`) and set that URL in Settings → Pyodide URL.

**Local LLMs.** Point the assistant at your OpenAI-compatible server, e.g. vLLM on `http://100.78.161.2:8888/v1` with the served model name; no key needed. The server, not the browser, talks to the model, so the endpoint only has to be reachable from where Gridwright runs (`host.docker.internal` reaches the host from the container).

## Using it

**Tables.** `+ Table` adds one below the others. Click a title to select the table: reference tabs and three handles appear. Drag the corner circle diagonally to grow or shrink in both directions (the preview shows `rows × cols`); the side handles change one dimension; column/row edges resize. Code-cell output that doesn't fit grows the table automatically. The Table panel exposes name, exact size, header row, and insert/delete rows/columns at the selection.

**Formulas.** Type `=` in a cell; a preview appears below the editor. Reference other tables as `Name::A1` (quote names with spaces: `'Q3 sales'::B2:B20`). Copy/paste and fill-down (Ctrl+D) shift relative references; `$A$1` pins. Errors: `#DIV/0! #REF! #NAME? #VALUE! #N/A #CYCLE! #NUM! #SPILL!`.

**Code cells.** Select a cell, press **Py** or **JS**, write code in the panel, Ctrl+Enter. Output spills from the cell (blue text; an outline marks the area; spilled cells are read-only). Inside code:

```python
q.cells("A1")             # scalar
q.cells("A1:A10")         # list (one column/row) or list of lists
q.df("A1:D50")            # pandas DataFrame, first row as header  (import pandas first)
q.cells("Orders::B2:B99") # another table
q.table("Orders")         # whole table
q.names(); q.pos()
```

```js
const rows = q.records("Orders");       // [{Region: "North", Units: 120}, ...]
const total = rows.reduce((s, r) => s + r.Units, 0);
return [["Total", total]];
```

**Charts.** In a Python cell: `import matplotlib.pyplot as plt`, build a figure, end with `fig` — the chart appears on the canvas below/right of the cell (the table grows to hold it) and updates whenever the referenced cells change.

**SQL.** SQL panel → New connection → Test → write a query → Run. Results become a new table (or paste at the selection). Credentials never enter the document.

**AI.** AI panel → ⚙ → base URL + model (+ key). Ask for formulas, analyses or tables. Suggested changes are listed under the reply; "Apply" (or auto-apply) writes them; Ctrl+Z reverts.

**Multiplayer.** Save the document; share the URL (`?file=…`). Set your display name in Settings.

**Keyboard.** Enter/F2 edit · typing replaces · Enter ↓ / Tab → · arrows, Shift+arrows, Ctrl+arrows · Ctrl+C/X/V · Ctrl+Z/Y · Ctrl+B bold · Ctrl+D fill down · Ctrl+A select table · Delete clears · wheel pans, Ctrl+wheel zooms, Space+drag pans · Ctrl+Enter runs a code cell · Ctrl+S saves.

![Two clients on one document](docs/multiplayer.png)

## Performance notes

Measured in headless Chromium with software WebGL (SwiftShader), i.e. a pessimistic baseline: filling a 5 000 × 30 table (150 000 cells, 5 000 formulas) takes ≈0.6 s; a single edit with dependent formulas ≈35 ms (dominated by JSON across the wasm boundary); idle frames cost nothing because the canvas only re-renders when something changed; the engine's dirty detection is set-based so cost scales with the number of affected formulas, not with table size.

## Tests

```bash
cd core && cargo test                     # engine: formulas, recalculation, undo, spill, JSON
python3 e2e/smoke.py http://localhost:8787 --python    # browser: editing, formulas, handles, JS & Python cells, save/open
node e2e/mock-llm.mjs &                   # then configure http://127.0.0.1:8899/v1 as the AI endpoint and:
python3 e2e/ai_multiplayer.py http://localhost:8787    # assistant actions, two-client sync, presence
```

The browser tests use Playwright (`pip install playwright && playwright install chromium`).

## Limitations (honest list)

- Formulas return a single value; array formulas/dynamic arrays spill only from code cells. No charts yet (a Python cell can compute series; rendering is on the roadmap). No cell merging, conditional formatting, or data validation.
- Dates are stored as serial numbers; text that looks like a date stays text unless a date function parses it or a date number format is applied.
- Multiplayer relays operations last-write-wins per cell (no CRDT); undo/redo by one client re-syncs the others with a snapshot.
- Code cells see a snapshot of the workbook taken when they start; very large documents (hundreds of thousands of cells) will feel the per-run snapshot cost.
- The AI assistant works with any OpenAI-compatible endpoint but needs a model that follows the JSON action format; small local models may need a retry.
- Single-tenant: one shared document store, optional shared token. Put it behind your own auth (Tailscale, reverse proxy) for anything beyond a trusted network.

## Licence

MIT. Third-party: PixiJS (MIT), CodeMirror (MIT), Pyodide (MPL-2.0, fetched at runtime), React (MIT), Express/ws/pg/mysql2 (MIT), Rust crates serde/serde_json/wasm-bindgen (MIT/Apache-2.0).
