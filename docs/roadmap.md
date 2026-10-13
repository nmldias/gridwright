# Roadmap — the 11 Oct 2026 review

An independent review of `main` at `a1f0a62` (v0.12) on 11 Oct 2026 listed what an audit-grade finance tool cannot
get wrong. It is being worked through in focused, tested PRs: each item is reproduced, gets a test that fails
before and passes after, and is merged through CI (see [`AGENTS.md`](../AGENTS.md)). This file is the work queue.

Status: `todo` · `partial` · `done` (merged; PR noted). Line numbers are from `a1f0a62`: locate the code again
before editing.

**Next item: 7.2** (Phase 7, the 13 Oct assessment, requested by the maintainer on 13 Oct). Then the rest of Phase 7; 2.9, 2.10 and Phase 3 follow in order.

## Done

| Phase | What | PRs |
|---|---|---|
| 1 | Security and log integrity: identity headers only through loopback, safe-by-default installer, history log in SQLite with unique sequence numbers, read-only SQL enforced in the database session, Python cells contained (PID/process limits, minimal sandbox root, bounded output), body limits after authentication, checkpoint sequence validation, server-only attestation of run evidence, secrets in a 0600 env file, constant-time token check, Origin checks, bounded run entries | #6, #7 |
| 2.1 | Formulas cannot crash or hang the engine: parser depth 256, array-size cap, date-serial clamp, arithmetic NETWORKDAYS/COMBIN, work budgets for text/array/lookup functions, INDIRECT safeguards | #8 |
| 2.2 | Volatile functions (TODAY, NOW, RAND, INDIRECT, OFFSET, FX/AGEING without a date) recalculated after load, on `set_now` and on every change | #9 |
| 2.3 | DAYS360, YEARFRAC (bases 0/1), EDATE month-end, DATE and parsed two-digit years as Excel (pivot 1930) | #10 |
| 2.4 | Decimal comma (`1.234,56`) as a document setting: typed/pasted input, display, filters, highlight rules, validation; strict grouping, `(1.234,00)` negative, `08.10.2026` stays a date | #11 |
| 2.5 | Comparison at 15 significant digits: operators, criteria, lookups, CHECK, filters, validation, highlight rules | #13 |
| 2.6 | Rounding and number text on the 15-digit decimal value: ROUND family, MROUND, CEILING/FLOOR, TEXT with sections, FIXED, DOLLAR; General format for number → text; the browser formatter checked against the engine | #14 |
| 2.7 | IRR / XIRR / RATE: residual relative to the discounted terms, `#NUM!` when not converged, bracket nearest the guess, dates before the first `#NUM!`, iterations on the work budget | #15 |
| 2.8 | Recalculation proportional to the change: reverse-dependency index, tracked volatile/blocked-spill/spilled/code cells instead of whole-workbook scans, a position hasher for cell maps | #16 |

Regression suites for these: `e2e/server_gates.py`, `history_log.mjs`, `sql_readonly.mjs`, `python_sandbox.mjs`,
`code_trust.py`, `installer_nohup.sh`, `security.py`, `engine_limits.mjs`, `import_dates.mjs`,
`decimal_comma.mjs`, `decimal_comma_ui.py`, `numeric_equality.mjs`, `numeric_equality_ui.py`, `numerics.mjs`,
`recalc_perf.mjs`.

## Phase 2 — Engine correctness (Rust core)

Baselines below were reproduced on the shipped engine at `main` `8da8d82`, e.g. with
`node -e` + `Book.eval_at` from `server/engine/gridwright_core.js` (see `e2e/decimal_comma.mjs` for the pattern).

### 2.5 Exact equality breaks reconciliation checks — `done` (#13)
* **Baseline:** `=0.1+0.2=0.3` → `FALSE`; `=SUMIF({0.3,0.1},0.1+0.2)` → `0`. So `CHECK(SUM(…)=Total)` fails on
  ordinary decimal amounts. Excel compares at 15 significant digits (`TRUE`, `0.3`).
* **Where:** comparison operators in `core/src/formula/eval.rs` (`=`, `<>`, `<`, `<=`, `>`, `>=`); criteria
  matching (SUMIF/COUNTIF/AVERAGEIF and the *IFS family, MATCH/XLOOKUP exact match); `CHECK`; filter comparisons
  (`model.rs`, `compare_values`); validation bounds (`validation.rs`).
* **Approach:** one helper (e.g. `numbers_equal(a, b)`) comparing both values rounded to 15 significant digits,
  used by every equality site; ordering consistent with it (`a < b` is false when they are equal). Decide and
  document whether grouping/dedupe (UNIQUE, pivots, COUNTIF keys) uses the same rule. Verify Excel's behaviour
  per function before changing it.
* **Acceptance:** Rust unit tests for the helper and each site; a reconciliation case (`CHECK(SUM(A1:A3)=B1)` with
  decimal amounts) in an e2e engine suite; README *Limitations* updated if anything stays different from Excel.

* **Implemented:** shared 15-digit decimal comparison and numeric hash keys, consistent ordering, criteria and validation bounds; filters and CHECK inherit the comparator. UNIQUE follows the same equality; pivots/COUNTUNIQUE keep display-text grouping (README limitation). Regression coverage: Rust comparison/formula/filter/validation/key tests and `e2e/numeric_equality.mjs` (4 checks). Microsoft precision and function semantics are cited by tests; exact decimal examples have not been independently executed in Excel. Highlight rules evaluated in the browser (`client/src/grid/condfmt.ts`: value comparisons, duplicates, top/bottom N) use the engine's comparison through `Book.compare_numbers` (`e2e/numeric_equality_ui.py`, 14 checks). A numeric pre-check proves most pairs unequal without formatting (sorting 20,000 amounts: 368 ms → 18 ms; `main` 14 ms); UNIQUE/XLOOKUP indexes still build a 15-digit text key per value (≈2× `main`), left for 2.8.

### 2.6 Rounding and display — one Excel-numerics module — `done` (#14)
* **Baseline:** `=ROUND(1.005,2)` → `1` (Excel `1.01`); every ROUND result truncated to 12 decimals; TEXT rounds
  differently from ROUND; text coercion prints binary noise (the review's example `888888888.3000000715`); TEXT
  ignores `;` sections (positive;negative;zero;text), so accounting formats break.
* **Approach:** a numerics module (e.g. `core/src/formula/numerics.rs`): 15-significant-digit normalisation,
  decimal half-away-from-zero rounding for ROUND/ROUNDUP/ROUNDDOWN/MROUND/FIXED/DOLLAR/TEXT, number → text as
  Excel's General format (concatenation, `VALUE`, `to_display`), TEXT with sections. Keep `client/src/grid/format.ts`
  in step, or route client formatting through `Book.format_number`.
* **Acceptance:** table-driven Excel-verified cases (they seed 2.9); the decimal-comma suites still pass.

* **Implemented:** `core/src/formula/numerics.rs` holds the 15-digit decimal value of a number (ties away from
  zero, as Excel and JavaScript), decimal rounding (`round_decimal`, `fixed_abs`) and Excel's General text
  (`general_text`, used by `to_display`, so concatenation, pivot keys and re-written formula literals). ROUND,
  ROUNDUP, ROUNDDOWN, TRUNC, PERCENTRANK, MROUND, CEILING, FLOOR, CEILING.MATH, FLOOR.MATH, TEXT, FIXED and the new
  DOLLAR use it. TEXT/grid formats gained sections, `_x`, `\x`, `?`, `[Red]`, `*` fill and thousands scaling.
  `client/src/engine/types.ts` + `grid/format.ts` port the same code (WASM per cell is ~15× slower);
  `e2e/numerics.mjs` checks the shipped engine against `core/src/formula/excel_cases.tsv` (76 cases, 31 failed on
  `main`) and the browser formatter against the engine (9,840 number × pattern pairs; `main` already differed on
  General for long decimals). Not done: General fitted to column width, TEXT conditions/scientific/fractions.

### 2.7 IRR / XIRR / RATE convergence — `done` (#15)
* **Problem:** absolute tolerance, so small-scale cash flows return the guess; the bisection fallback returns its
  midpoint even when it did not converge; XNPV/XIRR accept dates before the first one.
* **Approach:** relative residual, `#NUM!` when not converged, `#NUM!` for a date before the first; keep Newton with
  a bracketed fallback.
* **Acceptance:** the same cash flows scaled by 1e-6 and 1e9 give the same rate; non-convergent input → `#NUM!`;
  examples from Microsoft's documentation of each function.
* **Implemented:** one solver, `solve_rate` (`eval.rs`): Newton from the guess, then bisection on the sign change
  nearest it; a root is accepted when |Σ| ≤ 1e-10 × Σ|terms| at that rate (a residual relative to Σ|flows|
  accepted rates where every flow is discounted to nothing: `IRR(SEQUENCE(1E6)-2)` was 0.998); `#NUM!` otherwise;
  each evaluation charged to the work budget (4 units per IRR flow, 16 per XIRR flow). IRR/XIRR need a positive and
  a negative flow; XNPV/XIRR truncate dates and refuse one before the first. Cases in `excel_cases.tsv` (Microsoft's
  IRR, XIRR, XNPV, RATE, MIRR examples; scaled flows 1e-12…1e9; on `main` 8 of 19 fail, incl.
  `IRR({-1E-12,2E-12})` = the 0.1 guess) and `e2e/engine_limits.mjs` (4 cases).

### 2.8 Recalculation is quadratic — `done` (#16)
* **Baseline:** setting a 10,000-row running balance (`B(n)=B(n-1)+A(n)`) takes ≈ 16.7 s (3,000 rows ≈ 1.5 s);
  editing the head of a 5,000-cell chain ≈ 0.9 s; 2,000 `SUM(A:A)` cells ≈ 2.9 s. Formulas are re-parsed on every
  evaluation and dependents are found by linear scan.
* **Approach:** a reverse-dependency index maintained with the deps (`engine.rs`, `refresh_deps`); parsed ASTs cached
  per cell and invalidated on input change; borrowed range views instead of copies. Keep 2.1 limits and 2.2 volatile
  handling.
* **Acceptance:** a timing test with budgets measured on CI (release build), and `e2e/perf.py` no worse.
* **Implemented:** `core/src/depindex.rs` indexes each formula's rectangles the other way round (≤ 64 cells per
  cell, tall ones per column, wide ones per table); the closure in `recalc_round` and the edges in `evaluate_dirty`
  query it with cells grouped by column instead of testing every formula. The engine's `Tracked` state (index,
  volatile formulas, `#SPILL!` formulas, spilled cells per origin, code cells with `code_deps`) is updated for the
  cells an edit changed (`SetCell`, `SetCells`, `ClearRange`, `CodeResult`, `RestoreCells`, spills, pivots) and
  rebuilt after any other operation; unit tests compare it with a rebuild after every operation. Five whole-workbook
  scans per edit are gone (the deps refresh, blocked spills, volatile cells, code-cell reruns, and the spill
  snapshot/clear of the edited cell), which made even value-only typing quadratic. Cell maps hash positions with a
  MurmurHash3 finaliser instead of SipHash (≈3× faster `SUM(A:A)` in wasm). `e2e/recalc_perf.mjs` (9 cases, one
  process each, budgets): typing a 10,000-row running balance 80 s → ≈1 s, editing the head of a 5,000 chain
  2.9 s → ≈40 ms, inserting a row into a 10,000-row balance and editing 26 s → ≈0.3 s; `e2e/perf.py` single edit
  ≈25 ms → 0.2 ms, fill unchanged. Not done: borrowed range views (a range read copies its values; the cost is the
  per-cell lookup of a 336-byte `Cell`, which a view would not remove) and an AST cache (parsing is ≈1 µs a formula,
  under 2% of an evaluation in these cases).

### 2.9 Excel-verified tests for `eval.rs` — `todo`
* `eval.rs` has no unit tests. Add ~200 table-driven cases (e.g. a data file of `formula · expected · source` read by
  a Rust test), each citing its source.
* Known differences to fix and cover: invalid weekend codes in NETWORKDAYS.INTL/WORKDAY.INTL fall back to
  Saturday/Sunday (Excel `#NUM!`); serials below 61 (Excel's 1900 leap-year quirk); `=ROWS(#NAME?)` → `1` (Excel
  propagates the error); `RANDARRAY` is not implemented (`#NAME?`).

### 2.10 XLOOKUP match_mode and search_mode — `todo`
* Arguments 5 and 6 are ignored: exact match, first-to-last only (stated in README *Limitations*). Implement
  wildcard (2), next smaller/larger (-1/1), last-to-first (-1) and binary search (±2) with 2.9's Excel-verified
  cases; then remove the limitation line.

## Phase 3 — Multiplayer: silent divergence

One PR: *Multiplayer: baseSeq + cid, server dedupe, catch-up*. 3.5 is the root cause; 3.1–3.4 are its symptoms.

| id | Problem | Where (at `a1f0a62`) | Status |
|---|---|---|---|
| 3.1 | Operations arriving during a resync are lost: seq advances before apply, the replay stops at the seq captured at its start | `client/src/api/ws.ts` ~101, 229, 380 | `partial`: #7 holds remote ops during a resync and applies them after; the own-op part goes with 3.2 |
| 3.2 | Own operations vanish: a resync clears pending after 2 s and a late echo is treated as already applied (mobile latency makes 2 s easy to miss) | `ws.ts` ~376 | `todo` |
| 3.3 | Reconnect can skip or double-apply: catch-up is skipped after offline edits, and re-sent ops are committed twice because the server does not dedupe on `cid` | `ws.ts` ~76-92, `server/src/multiplayer.ts` ~106-116 | `todo` |
| 3.4 | File-open race: an operation committed between the GET and the WebSocket welcome is never applied | `client/src/ui/files.ts` ~44, `ws.ts` ~413 | `partial`: #7 catches a placement up to the server seq |
| 3.5 | The server only appends and broadcasts. Fix: the client sends `baseSeq` + `cid`; the server dedupes on `cid`, transforms (`transformOp` is already isolated in `ws.ts`, so it can be shared with the server) or rejects; `hello(lastSeq)` returns the entries missed since | client + server | `todo` |

**Acceptance:** Playwright suites with two or three pages, offline/online switching (`context.set_offline`),
throttled latency and a server restart mid-session. They must assert **convergence** (every client's document
JSON equals the server's replay) and **exactly-once** application (each `cid` once in the log). The guided-import
placement into a new workbook and `features2.py`'s concurrent insert+edit have exhibited these races.

## Phase 4 — Phone and client robustness

| id | Problem → fix | Where | Status |
|---|---|---|---|
| 4.1 | Dead sockets after the app is backgrounded (no heartbeat, no `visibilitychange`): 15 s ping, reconnect when visible | `client/src/api/ws.ts` | `todo` |
| 4.2 | Image-cell textures evicted from the cache without `destroy()`/`Assets.unload`, so repeated matplotlib runs exhaust memory | `client/src/grid/renderer.ts` ~238-251 | `todo` |
| 4.3 | Canvas at devicePixelRatio 3 (cap at 2); no redraw after a WebGL context restore; bitmap text blurs above 1× zoom | renderer | `todo` |
| 4.4 | 1.54 MB main chunk (warning limit raised to hide it): lazy-load panels and CodeMirror, restore the default limit | `client/vite.config.ts`, panels | `todo` |
| 4.5 | Inputs below 16 px make iOS Safari zoom on focus (chat box included); use `dvh` for menus | client CSS | `todo` |
| 4.6 | JS-cell timeout uses `Promise.race`, which cannot stop `while(true){}`; later JS cells queue forever: terminate and recreate the worker | `client/src/workers/` | `todo` |

## Phase 5 — Engineering hygiene

| id | Item | Status |
|---|---|---|
| 5.1 | Releases: semver tags → immutable GitHub Release with `SHA256SUMS`; `install.sh --version vX.Y.Z` verifying with `sha256sum -c`; check the Node download against its `SHASUMS256.txt`; backup before switching; rollback to the previous release; CHANGELOG | `todo` |
| 5.2 | Migrations: `Workbook.version` is never read and the SQLite stores have no `user_version`: ordered, tested migrations | `todo` |
| 5.3 | Unit-test runners: vitest for server `sqlpolicy`, `identity`, `history`, tenancy, and the client runner | `todo` |
| 5.4 | Lint in CI: clippy, rustfmt, eslint, ruff (fix or allow-list existing findings in a separate commit) | `todo` |
| 5.5 | CI: `permissions: contents: read` at workflow level with write only on the release-branch/image jobs; actions pinned by SHA; wasm-pack from a pinned release instead of `curl \| sh`; a job matrix instead of one serial job; Playwright waits instead of fixed sleeps; Dependabot for npm/cargo/pip/actions/docker | `todo` |
| 5.6 | `scripts/test.sh` runs 2 of the ~38 suites and ignores failures: one script that runs the CI suites locally (databases via Docker), stops at the first failure and cleans up its servers | `todo` |
| 5.7 | The source `Dockerfile` is never built in CI; compose files reference a `security_opt` that does not exist | `todo` |

## Phase 6 — Simplify (maintainer's decision: behind-the-scenes only)

Behaviour on existing installs must not change.

* **Do:** README → about 100 lines with the rest in `docs/` (6.3, docs part); move the remaining JSON/JSONL
  persistence (connections, access metadata) into SQLite (6.4); explicit server folder boundaries (sheet, sql,
  import, tenancy, exec, companion) without behaviour change.
* **Don't:** repackage features. The companion and investigations, guided import and tenancy stay as they are
  (6.1, 6.2 and the "optional" part of 6.3 were declined).

## Phase 7 — Financial analytical model (13 Oct 2026 assessment)

The assessment of 13 Oct 2026 proposed reverse-engineering visual analytics (Tableau cross-filtering, Power BI
decomposition and drill-through, Qlik excluded values, Lightdash metrics, Grist linked views) and then warned that
visual interaction must be built **on financial meaning, not the other way round**: a chart that renders perfectly
can still use the wrong grain, currency or aggregation. So this phase builds a narrow analytical contract first and
the interactions on top of it.

*Method.* Reference behaviour comes from official documentation and open-source code only
([`docs/research/interaction-behaviour.md`](research/interaction-behaviour.md), every claim cited); no proprietary
application is inspected. Where the references are silent or wrong for finance (join fan-out, mixed currency,
non-additive totals, nulls, permissions through aggregates) Gridwright specifies the behaviour itself and tests it
against an independent reference. The common benchmark is the synthetic 10,000-vehicle inventory in
`e2e/fixtures/automotive.mjs` (duplicate VINs, blank/text costs, three currencies, reserved stock older than
average, margins whose plain average misleads).

Phase 3 (multiplayer convergence) stays a parallel prerequisite: interaction state in this phase is per viewer and
never enters the log, so it does not depend on it, but shared analytical views will.

| id | Item | Status |
|---|---|---|
| 7.1 | **Analytical queries in the engine** (`core/src/analytic.rs`, `Book.analyze`, `Book.analyze_records`): canonical group keys with row membership; missing/text amounts counted, never 0; mixed currencies refused with the amount per currency; average and ratio from their parts, marked non-additive; excluded population (selection, table filters) aggregated; Σ groups = total reconciled for additive measures; duplicate/blank identifiers; read-only. `e2e/analytic.mjs` (25 checks, budgets). See [`docs/analytical-model.md`](analytical-model.md) | `done` (#17) |
| 7.2 | **Analytical charts and cross-filtering.** A chart can be bound to a table (dimension + measures) instead of ranges; its marks carry canonical keys; mark-level hit testing; click / Ctrl-click selects marks; other analytical charts on the same table filter to the selection while the source chart highlights (a chart never filters itself, so links cannot loop); clearing shows all (explicit policy); a "Filtered by … · excluded N rows, value" strip; selection is per viewer, not an operation. Existing range charts keep working as exhibits | `todo` |
| 7.3 | **Drill-through and drill-down.** *See records* on a selected mark lists the source rows (row numbers, chosen fields, "rows add up to the figure ✓"), jumps to a row in the table; a chart with a dimension hierarchy drills down/up keeping the parent selection as context | `todo` |
| 7.4 | **Decomposition tree.** Break a measure down by dimensions chosen per level; siblings sorted by value with a fixed tie-break, top N plus "Other (k)" and "(blank)" nodes; additive children reconcile to the parent at every level; ratios/averages recomputed per node and labelled "children do not sum"; deterministic suggested splits that say how they were chosen | `todo` |
| 7.5 | **Governed metrics.** Workbook metric definitions (name, measure spec, currency, format, description) as document operations; charts, decomposition, the assistant and companion watches refer to a metric by name so one definition is used everywhere | `todo` |
| 7.6 | **Relationships with cardinality.** Declared links between tables (1:1, 1:many) with a fan-out guard: a measure is aggregated at its own grain before joining, and a breakdown that would repeat a row's amount is refused or de-duplicated, with a test that reconciles before and after the join | `todo` |
| 7.7 | **Reproducible analytical state for review.** Signing off an analysis records its query, metric definitions and a fingerprint of the source rows; reopening shows whether the data or definitions changed since | `todo` |
| 7.8 | **Evidence for agents.** An MCP tool exposing analytical queries and records, so every number an agent states cites a query and rows; text from imported cells is passed as data, never as instructions (prompt-injection test) | `todo` |

## Small follow-ups found along the way

* Filters saved before #11 on formatted columns (`#,##0.00`, dates) stored display text. They keep their old
  (wrong) behaviour until re-applied, and reopening the popover shows those values unticked. Optional: migrate on
  load when the display → canonical mapping is unambiguous.
* The companion's watch-threshold prompt (`client/src/ui/CompanionPanel.tsx`) reads decimal-comma input but has no
  browser test.
