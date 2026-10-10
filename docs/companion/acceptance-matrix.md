# Requirements → tests

The gates of the brief (§15) and the eight steps of the journey (§4), each with the suite and the check that demonstrates it, and its state after this pass: **passed** (the check ran green on 2026-10-10 against the development container), **partial** (part of the gate is demonstrated; the rest is named), **untested** (no check exists; what would be needed is named). Suites are in `e2e/`; the README's *Tests* section has the commands. Mocked model runs (`e2e/mock-llm.mjs`) are labelled as such: they show the wiring, not a model's reliability.

## Gates

| Gate | Demonstration | Where | State |
|---|---|---|---|
| First value | a file on an unsaved document → a private draft, a card, a placed table and a first reading with no Save, no project, no form; a concern typed in plain words → the companion's reading of the objective | `intake.py` 1 (12 checks); `situation.py` 1, 1b | passed |
| Normal language | objective + exclusion without prefixes; a concern as an inferred objective to confirm; *suppose* as a scenario; *before X, see Y* as a question with bearing | `situation.py` 1b (5 checks) | passed — clarification of an *ambiguous* material instruction is not demonstrated: an unparsed sentence goes to the model as a question, it is not asked back |
| Applied scope | the exclusion names its yes/no column and which watches still count everyone; one tap rewrites their formulas (+ complements) and restarts baselines | `situation.py` 2 (applied scope, 2 checks); `companion.py` (ageing watch excludes reserved) | passed |
| One snapshot | three edits of one snapshot are three revisions of one observation; the first reading says *one snapshot: … a trend needs the next one* | `intake.py` 1 (…what one snapshot cannot), 2 | passed |
| Duplicate / correction | an exact re-delivery by content → nothing to do; the same period re-delivered → that period's observation revised, previous value kept, never appended | `intake.py` 5, 6 | passed |
| Independent observations | the reserved count is 1 on two periods and both count for the sustained rule | `intake.py` 4 | passed |
| Freshness | a format change and a save leave the source's last data change where it was; as-of shown apart | `intake.py` 3; `situation.py` (stale source suspends a conclusion) | passed — comments are not a change in this model; a note typed into the chat does not touch the log |
| Missing data | a formula error → *cannot evaluate*; text where a number should be → *cannot assess*; the head line counts what cannot be assessed; a partial delivery suspends the comparison | `intake.py` 9, 13 | passed — truncated inputs are refused at parse time (size and row caps) rather than compared |
| Supersession | an older period is offered as history, the current stands; an agent's newer snapshot is proposed, not current | `intake.py` 7, 14 | passed |
| Data-series identity | identical columns from another branch → a separate table named after the entity; the series' history survives an update (two periods on each watch, the superseded source records kept) | `intake.py` 4, 5, 8 | passed |
| Coverage change | 6 → 2 rows suspends the trend comparison, baseline restarts, said in the activity | `intake.py` 9 | passed — unit/currency/definition changes are not detected (a Kz column arriving in USD is placed as numbers; the unit is read, not compared) |
| Quiet monitoring | a data-quality watch speaks once; worsening once is *worth a look*, twice an issue; the brief never repeats itself; related deliveries update one issue | `companion.py`; `situation.py` 10, measures | passed |
| Monitoring failure | a broken formula and text in a numeric watch → never *all quiet*; old issues keep their evidence labelled historical | `intake.py` 13; `companion.py` (stale essential source) | passed |
| Durable continuity | the situation survives a reload (objective, constraints, exclusions, decisions, next move); investigation threads are checkpointed in SQLite and continue; a restart interrupts a running investigation cleanly | `situation.py` 12, 7; `recovery.py` C | partial — the chat transcript is per browser (localStorage), so *another authorized device* sees the situation and the context, not the conversation; server-side conversation persistence is deferred (see the surprise log) |
| Real steering | *Stop* ends the process and sets aside what it proposed; a change of direction supersedes a running investigation, its result kept as history; a change of assumptions marks a finished investigation provisional | `situation.py` 7 (Stop, direction), 8 | passed (mocked model) |
| Approval integrity | the preview and the committed change agree; the same command does not apply twice; a change under a pending proposal yields a fresh preview; a decision against the wrong revision is refused | `controls.mjs` gate 2 | passed |
| Authority boundaries | a sign-off share cannot write, restore, push or decide; a downgrade reaches an open session; revocation closes it; agents get 403 on ratify/approve/decide/apply; editing does not grant code execution | `controls.mjs` gates 1, 3, execution permission; `companion.py` (agent's record proposed); `intake.py` 14 | passed |
| Worker isolation | the data directory and secrets are hidden from sandboxed code; the memory limit holds; without bubblewrap the runtime fails closed under `require` | `features3.py` / `features4.py`; CI step *Worker isolation fails closed* | passed — a cross-task cache marker is not planted (the sandbox has no per-task cache to leak) |
| Resource control | a GPU request without cuDF runs on the CPU with the CPU cap; runs beyond the budget are refused with 429 | `features4.py` | passed |
| Injection and lineage | instruction-like cells counted and inert, nothing approved or decided by a file; a re-imported brief is recognised as generated material, never independent evidence | `intake.py` 12; `situation.py` 9 | passed |
| Decision revisit | the condition behind a hold decision breaches → *A decision needs another look*, with the failing condition, no reversal | `situation.py` 6 | passed |
| Private / shared separation | a private hypothesis stays with its author and never reaches an outside agent's context | `situation.py` 9 | passed |
| Usability | import, steer, review without configuration; the card's primary action within the phone viewport, ≥ 44 px; the bar and panels on a phone; menus from the keyboard | `intake.py` 16; `interface.py` | passed — the keyboard path through the intake card itself is not checked |
| Financial results | the engine's totals equal `expected.json` (Decimal, no rounding) for 06 Oct and 13 Oct; the reference workbooks reconcile | `intake.py` 1, 4; `reference.py` | passed |
| Crash recovery | a placement interrupted after its commit completes once from the log; two concurrent placements make one table; an investigation interrupted by a restart is marked and nothing it proposed is current | `recovery.py` A, B, C | partial — the proposal-commit and notification boundaries have no fault point; `controls.mjs` gate 2 covers the retry of a decision, not a kill |

## The journey (§4)

| Step | Where | State |
|---|---|---|
| 1. A snapshot is added; recognised, coverage described, a first reading, no trend from one observation | `intake.py` 1, 2 | passed |
| 2. “Preserve replacement-cost margin. Leave out vehicles reserved for customers.” → scoped objective, interpretation, applied or reported as not applied | `situation.py` 1b, 2 | passed |
| 3. An invoice conflicts with a cost: both kept, what depends on it, the smallest investigation | `intake.py` 11; `situation.py` 4 | passed |
| 4. “Before discounts, see whether another branch could use them.” → direction changed, valid calculations kept, obsolete results never current | `situation.py` 7 | passed (mocked model) |
| 5. A later snapshot: new period / correction / unrelated; material developments without repetition | `intake.py` 4, 5, 6, 8; `companion.py`; `situation.py` 10 | passed |
| 6. Close and reopen, another device: conversation, material, objective, uncertainty, jobs, decisions | `situation.py` 12 | partial — all but the conversation (per browser) |
| 7. A proposed change reviewed with consequences; approval commits exactly once through the controls | `controls.mjs` gate 2; `features2.py` (diff before applying) | passed |
| 8. A later update contradicts an assumption behind a decision → revisit, not a silent change | `situation.py` 6, 8 | passed |

## Not covered by any check

- A real model (not the mock) running an investigation end to end; `situation.py` 7 and `recovery.py` C use the scripted mock.
- A human assessment of decision-ready outcomes, missed issues, false alerts and repeated explanations; the measures in `situation.py` are the planted-issue count and the no-repetition check only.
- Rollback from 0.10.0 to 0.9.0 (restore of a backup was exercised by hand on 2026-10-10; the previous build was not started on 0.10.0 data).
- Upgrade on Spark 1 (arm64, DGX OS) to 0.10.0 — not deployed in this pass.
- PDF extraction (text-native or scanned): no extractor is wired; the invoice fixture is XML and JSON.
- Two people giving conflicting instructions on one document (authority is per person; the conflict is not surfaced as such).
- Unit or currency changes between snapshots of one series.
