# Roadmap — the 11 Oct 2026 review

An independent review of `main` at `a1f0a62` (v0.12) on 11 Oct 2026 listed what an audit-grade finance tool cannot
get wrong. It is being worked through in focused, tested PRs: each item is reproduced, gets a test that fails
before and passes after, and is merged through CI (see [`AGENTS.md`](../AGENTS.md)). This file is the work queue.

Status: `todo` · `partial` · `done` (merged; PR noted). Line numbers are from `a1f0a62`: locate the code again
before editing.

**Next item: 2.6.** Then the rest of Phase 2 in order, then Phase 3.

## Done

| Phase | What | PRs |
|---|---|---|
| 1 | Security and log integrity: identity headers only through loopback, safe-by-default installer, history log in SQLite with unique sequence numbers, read-only SQL enforced in the database session, Python cells contained (PID/process limits, minimal sandbox root, bounded output), body limits after authentication, checkpoint sequence validation, server-only attestation of run evidence, secrets in a 0600 env file, constant-time token check, Origin checks, bounded run entries | #6, #7 |
| 2.1 | Formulas cannot crash or hang the engine: parser depth 256, array-size cap, date-serial clamp, arithmetic NETWORKDAYS/COMBIN, work budgets for text/array/lookup functions, INDIRECT safeguards | #8 |
| 2.2 | Volatile functions (TODAY, NOW, RAND, INDIRECT, OFFSET, FX/AGEING without a date) recalculated after load, on `set_now` and on every change | #9 |
| 2.3 | DAYS360, YEARFRAC (bases 0/1), EDATE month-end, DATE and parsed two-digit years as Excel (pivot 1930) | #10 |
| 2.4 | Decimal comma (`1.234,56`) as a document setting: typed/pasted input, display, filters, highlight rules, validation; strict grouping, `(1.234,00)` negative, `08.10.2026` stays a date | #11 |

Regression suites for these: `e2e/server_gates.py`, `history_log.mjs`, `sql_readonly.mjs`, `python_sandbox.mjs`,
`code_trust.py`, `installer_nohup.sh`, `security.py`, `engine_limits.mjs`, `import_dates.mjs`,
`decimal_comma.mjs`, `decimal_comma_ui.py`.

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

### 2.6 Rounding and display — one Excel-numerics module — `todo`
* **Baseline:** `=ROUND(1.005,2)` → `1` (Excel `1.01`); every ROUND result truncated to 12 decimals; TEXT rounds
  differently from ROUND; text coercion prints binary noise (the review's example `888888888.3000000715`); TEXT
  ignores `;` sections (positive;negative;zero;text), so accounting formats break.
* **Approach:** a numerics module (e.g. `core/src/formula/numerics.rs`): 15-significant-digit normalisation,
  decimal half-away-from-zero rounding for ROUND/ROUNDUP/ROUNDDOWN/MROUND/FIXED/DOLLAR/TEXT, number → text as
  Excel's General format (concatenation, `VALUE`, `to_display`), TEXT with sections. Keep `client/src/grid/format.ts`
  in step, or route client formatting through `Book.format_number`.
* **Acceptance:** table-driven Excel-verified cases (they seed 2.9); the decimal-comma suites still pass.

### 2.7 IRR / XIRR / RATE convergence — `todo`
* **Problem:** absolute tolerance, so small-scale cash flows return the guess; the bisection fallback returns its
  midpoint even when it did not converge; XNPV/XIRR accept dates before the first one.
* **Approach:** relative residual, `#NUM!` when not converged, `#NUM!` for a date before the first; keep Newton with
  a bracketed fallback.
* **Acceptance:** the same cash flows scaled by 1e-6 and 1e9 give the same rate; non-convergent input → `#NUM!`;
  examples from Microsoft's documentation of each function.

### 2.8 Recalculation is quadratic — `todo`
* **Baseline:** setting a 10,000-row running balance (`B(n)=B(n-1)+A(n)`) takes ≈ 16.7 s (3,000 rows ≈ 1.5 s);
  editing the head of a 5,000-cell chain ≈ 0.9 s; 2,000 `SUM(A:A)` cells ≈ 2.9 s. Formulas are re-parsed on every
  evaluation and dependents are found by linear scan.
* **Approach:** a reverse-dependency index maintained with the deps (`engine.rs`, `refresh_deps`); parsed ASTs cached
  per cell and invalidated on input change; borrowed range views instead of copies. Keep 2.1 limits and 2.2 volatile
  handling.
* **Acceptance:** a timing test with budgets measured on CI (release build), and `e2e/perf.py` no worse.

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

## Small follow-ups found along the way

* Filters saved before #11 on formatted columns (`#,##0.00`, dates) stored display text. They keep their old
  (wrong) behaviour until re-applied, and reopening the popover shows those values unticked. Optional: migrate on
  load when the display → canonical mapping is unambiguous.
* The companion's watch-threshold prompt (`client/src/ui/CompanionPanel.tsx`) reads decimal-comma input but has no
  browser test.
