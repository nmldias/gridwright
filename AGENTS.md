# AGENTS.md — working on Gridwright

Instructions for any coding agent (Codex, Claude Code, …) and for people. Read this before changing anything.
The remaining work is in [`docs/roadmap.md`](docs/roadmap.md): unless told otherwise, start with its first `todo` item.

## What Gridwright is

A spreadsheet and data workbench for CFOs and finance teams. It **grabs** data (Excel/CSV exports, SQL sources),
**structures** it (guided import → clean tables with lineage and reusable recipes) and **presents** it organised
(workbooks, pivots, charts, reconciliation checks). It is multi-client (tenancy), collaborative (live multiplayer)
and audit-grade: every change is an operation in a per-document log on the server.

## Repository map

| Path | What it is |
|---|---|
| `core/` | Rust engine compiled to WebAssembly. `model.rs` (workbook → tables → sparse cells, literal parsing, decimal-comma helpers, filters), `engine.rs` (operations, undo/inverse, dependency graph, recalculation, volatile cells), `formula/{lexer,parser,eval}.rs` (`eval.rs` ≈ 4k lines, all functions), `validation.rs`, `lib.rs` (the `Book` WASM API). Built twice: for the browser and for Node. |
| `client/` | Vite + React + TypeScript. `engine/book.ts` (wrapper around the WASM `Book`), `api/ws.ts` (multiplayer client, `transformOp`), `grid/` (PixiJS renderer, actions, `format.ts`, `condfmt.ts`, filters, charts), `ui/` (panels, `files.ts` open/save/autosave), `workers/` (Pyodide and JS cells). |
| `server/` | Node ≥ 22.13 + Express + ws. `index.ts` bootstrap, `routes/`, `history.ts` (operation log in SQLite, unique seq), `multiplayer.ts` (WebSocket sequencer), `identity.ts`, `sqlpolicy.ts` + `sql.ts` (read-only SQL), `pyrun.ts` + `runner/` (server-side Python in bubblewrap), `dsengine.ts` (guided import), `companion/`. |
| `e2e/` | End-to-end suites: Node `.mjs` against the shipped WASM/dist, Python + Playwright against a running server. |
| `scripts/` | `install.sh` (production installer), `build.sh`, `dev.sh`. |
| `integrations/` | Companion/LangGraph Python side. |
| `docs/` | Feature docs (`guided-import.md`, `multi-tenancy.md`, companion) and `roadmap.md`. |

The README's *Architecture* and *Tests* sections have more detail; keep them true.

## Build (exactly what CI does)

```bash
rustup target add wasm32-unknown-unknown          # Rust stable; wasm-pack: cargo install wasm-pack (or scripts/build.sh)
cargo test --manifest-path core/Cargo.toml        # Rust unit tests (in #[cfg(test)] modules of core/src, including eval.rs)
cd core
wasm-pack build --release --target web    --out-dir ../client/src/engine/pkg --out-name gridwright_core
wasm-pack build --release --target nodejs --out-dir ../server/engine      --out-name gridwright_core
cd ../client && npm ci && npm run build           # tsc + vite; type-checking needs the wasm pkg built first
cd ../server && npm ci && npm run build
```

Node 22 (≥ 22.13: the server uses `node:sqlite`; its experimental warning is normal). Rebuild **both** WASM
targets after any change in `core/`, otherwise the browser and server suites test the old engine.

## Tests

* **Source of truth:** `.github/workflows/ci.yml`: every suite, its arguments, ports and services. The README
  *Tests* section lists each suite with its check count; update the count when you add checks.
* **Fast loop (no services):**
  ```bash
  cargo test --release --manifest-path core/Cargo.toml
  node e2e/engine_limits.mjs server/engine     # resource limits, volatile functions, day counts
  node e2e/recalc_perf.mjs server/engine       # recalculation timings under budgets
  node e2e/import_dates.mjs server/dist        # guided-import dates
  node e2e/decimal_comma.mjs server/engine     # decimal-comma workbooks
  node e2e/numerics.mjs server/engine          # rounding, number text, browser formatter == engine
  (cd client && npx tsc --noEmit) && (cd server && npx tsc --noEmit)
  ```
* **Browser suites** need Python 3 with Playwright Chromium (`pip install playwright pandas -r integrations/companion/requirements.lock.txt && python3 -m playwright install --with-deps chromium`),
  a running server (`cd server && GRIDWRIGHT_DATA=/tmp/gw-data PORT=8787 node dist/index.js`), the mock model
  (`node e2e/mock-llm.mjs`, port 8899), PostgreSQL/MariaDB/SQL Server for the SQL suites (see the CI `services`)
  and bubblewrap for the Python-sandbox suites. Suites that start their own server take `--port`
  (`decimal_comma_ui.py`, `server_gates.py`, `code_trust.py`, `tenancy.py`, `security.py`, …).
* If your environment cannot run a suite (no Docker, no bubblewrap, no browser), say so in the PR and let PR CI
  run it. **Never report a suite as passing without having run it.**

## Rules for changes

1. **One review item (or a tight group) per branch and PR.** Branch from an up-to-date `main`:
   `engine/<topic>`, `fix/<topic>`, `client/<topic>`, `ci/<topic>`, `docs/<topic>`.
2. **Reproduce first.** Write the test that fails on current `main`, then fix, then show it passes. Put the
   before/after numbers in the PR body (`| suite | before | after |`).
3. **Tests are evidence.** Never delete, skip, loosen or blanket-ignore a check to get green. If a test is wrong,
   fix it narrowly and explain why. Model: the stale-save case in `e2e/features.py` sets aside only the exact
   expected 409 message *and* adds a positive check that the retried save lands.
4. **Security protections stay on.** Identity/token/origin checks, authentication before body parsing,
   read-only SQL (lexer *and* database session), the bubblewrap sandbox failing closed, code trust/attestation,
   checkpoint sequence validation, secrets in a 0600 env file. Do not disable, bypass or weaken any of them to make
   something work. If one blocks a legitimate change, stop and ask the maintainer.
5. **Every document change is an operation** (the `Op` enum in `core/src/engine.rs`): undoable via its inverse,
   relayed to other editors and replayed by the server. Document settings too (see `SetDecimalComma`).
6. **Data is canonical.** Stored inputs, formulas and operations use English-style numbers (`1,234.56`, `0.5`,
   commas between arguments). Locale conventions apply only at the edges: what a person types or pastes from
   outside (`normalize_typed`) and what is shown (`edit_text`, display formatting). Filters, highlight rules and
   validation thresholds are stored canonically. The assistant's context stays canonical.
7. **Excel is the reference** for formula semantics. Cite the source (Microsoft documentation or a verified Excel
   result) next to the test case for any numeric behaviour.
8. **Engine limits hold for new code.** Parser depth 256, array-size caps, work budgets (see
   `e2e/engine_limits.mjs`). A new function that loops or allocates by argument needs a bounded path and a case
   there.
9. **Never commit** generated outputs (`client/src/engine/pkg`, `server/engine`, `*/dist`, `core/target`), local
   data directories, logs, credentials, or any real customer/company workbook. Test data is synthetic.
10. **Docs and CI move with the code:** README (features, limitations, test counts) and a CI step for every new
    suite, in the same PR.
11. **Commit messages:** `area: what changed, in plain words (review 11 Oct, X.Y)`; the body says why and how it
    was verified.
12. **Merging and releases:** PR CI green → rebase-merge. A push to `main` rebuilds the `release` branch
    (prebuilt, force-pushed by CI; never commit to it) and the container image. **Deploying to any server is the
    maintainer's job, not an agent's.**

## Gotchas

* The client type-check fails on a clean checkout until the WASM package is built.
* Don't use port 8787 for tests on a machine where a real instance runs; self-starting suites choose their own
  ports. When you start a server in the background from bash, `exec` it, so the PID you record is node's and
  killing it stops the server: `(cd server && exec node dist/index.js > log 2>&1 & echo $! > pid)`.
* Two editors saving at once can produce an expected `409` on `PUT /api/files/<id>` (stale save). The client
  catches up and retries; it is not an error.
* `client/src/grid/format.ts` and `formatNumberPlain`/`fixedAbs` in `client/src/engine/types.ts` mirror the
  engine's `format_text` (`eval.rs`) and `numerics.rs`; keep them in step. `e2e/numerics.mjs` compares them on
  thousands of number × pattern pairs (formatting every grid cell through WASM costs ~15× more).
* Numeric behaviour with an Excel source goes in `core/src/formula/excel_cases.tsv` (formula · result · source);
  both `cargo test` and `e2e/numerics.mjs` read it.
* Line numbers in `docs/roadmap.md` come from the review of `main` at `a1f0a62`; find the code again before
  editing.
