# Adversarial fixture pack and surprise log

## The pack — `e2e/fixtures/vehicles/` (synthetic)

Every file is invented; `README.md` in the folder says so. `expected.py` computes the reference figures with `Decimal` and writes `expected.json`; the gate tests compare the engine's results with those figures, never with each other.

| File | What it tries | Expected response | Checked by |
|---|---|---|---|
| `inventory-2026-10-06.csv` | `;` delimiter, Portuguese numbers (`24.150.009,00`), `dd/mm/yyyy`, a `Total` row, a VIN with leading zeros (`00012345ABC`), a 20-digit reference, a constant `Branch` column, one blank landed cost | identifiers kept as text, one canonical number, ISO dates, the total set aside, the blank reported, the entity read | `intake.py` 1 |
| `inventory-2026-10-13.csv` | the next period, one vehicle new, equal reserved count | next snapshot of the series; independent observations count when equal | `intake.py` 4 |
| `inventory-2026-10-13-corrected.csv` | the same period again with one cost changed, a different file name ("corrected") | the period's observation revised, not appended; the table keeps its series | `intake.py` 5 |
| re-delivery under another name | the identical content twice | recognised by content hash: nothing to do | `intake.py` 6 |
| `inventory-2026-09-29.csv` | an older period arriving later | history beside the current snapshot; the current one stands | `intake.py` 7 |
| `inventory-2026-10-13-benguela.csv` | identical columns, another `Branch` | a different entity: kept apart, named after it | `intake.py` 8 |
| `inventory-2026-10-20-partial.csv` | the next period with two thirds of the vehicles missing | still the next snapshot, but the comparison is suspended (coverage changed) | `intake.py` 9 |
| `inventory-2026-10-20.xlsx` | a workbook with formulas and cached values | formulas reduced to the values the file carried; macros never run | `intake.py` 10 |
| `invoices-2026-10-15.xml`, `costs-2026-10-15.json` | two other formats, English-locale amounts, one cost that disagrees with the inventory | tables; the conflict kept with both figures | `intake.py` 11 |
| `notes-hostile.csv` | cells that read like instructions ("ignore previous…", "approve…", "disable the watch…") | counted and inert: nothing approved, decided or disabled | `intake.py` 12 |
| `ragged.csv` | a short row and a row wider than the header | the short one padded, the wide one quarantined and listed with its file line | `intake.py` 12 |
| an agent's "newer" snapshot (MCP, agent identity) | an agent proposing a source record for a later period | proposed, never current; the person's snapshot stands | `intake.py` 14 |
| a re-imported brief | the companion's own text coming back as a file | recognised as generated material, never independent evidence | `situation.py` 9 |

## Discovery scenarios (brief §14)

| Scenario | State | Where / what is missing |
|---|---|---|
| Demonstrators, consignment or loan vehicles not in the schema | **untested** | no fixture; the companion would count them as stock. A category/ownership column would be profiled like any column, but nothing flags its absence |
| A status definition changes while the headline improves | partial | `situation.py` 6: the headline is flat while what the exclusion leaves out doubled — the companion says the definition, not the improvement. A changed recording practice without a visible column change is not detected |
| An AI summary returns as an independent document | passed | `situation.py` 9 |
| A once-suppressed signal later becomes material | partial | *not now* keeps the reason and the suggestion can be brought back (`situation.py` 5); it is not re-raised automatically on new evidence |
| A temporary liquidity preference treated as permanent | passed | objectives carry a review date; past it the companion asks for reconfirmation once (`situation.py` 11) |
| Conflicting instructions from two people; a private hypothesis in a shared case | partial | private records never reach an outside agent (`situation.py` 9); two people's conflicting statements are both kept as theirs but not surfaced as a conflict |
| A later upload with older or partial data | passed | `intake.py` 7, 9; event period and arrival time are separate fields on the source record |
| A child agent meets a prompt injection or an unsupported model/tool combination | partial | hostile cells are inert (`intake.py` 12) and the investigation's tools carry the person's permissions, never more; an unsupported model or tool ends the investigation as *failed* with the error on the record — the bounded failure is exercised only through the mock's error path, not with a real model |

## Surprises — defects reproduced in this pass (all fixed, each with a check)

1. **A corrected export became a new series.** `inventory-2026-10-13-corrected.csv` has the family *inventory corrected*; the source record took the file's family, so the correction started a second series. Fixed: an update belongs to the table's series whatever the file was called. (`intake.py` 5)
2. **The companion cross-checked a series against its own history** and reported "conflicts" between the 13 Oct snapshot and the 29 Sep history table. Fixed: same-series pairs are skipped. (`intake.py` 7)
3. **An agent's source record counted as current.** A later person's snapshot did not supersede the agent's "newer" one. Fixed: current = the latest live record a person stated; overtaken proposed records are superseded. (`intake.py` 14)
4. **Header detection failed on a ragged file**: width came from the widest row, so the header looked incomplete. Fixed: width from the header row, wider rows quarantined. (`intake.py` 12)
5. **A table created and formatted in one batch failed** ("table not found"): the format referred to a table that did not exist when the batch was validated. Fixed: two passes, values then formats.
6. **The entity name doubled** ("inventory benguela Benguela"). Fixed: the family already containing the entity keeps the entity's case.
7. **A workbook fixture written by openpyxl carried no cached values**, so formulas reduced to nothing. Fixed in the fixture (SheetJS writes values and formulas); the behaviour "formulas reduced to the values the file carried" now says what happens when there are none: blanks, reported.
8. **The mock on a durable thread skipped a step** because it saw the earlier turn's tool calls. Fixed in the mock: per-turn tracking. (Test infrastructure, not product.)
9. **A running investigation survived a restart as "running" for ever** and blocked new ones for 15 minutes. Fixed: at start-up every running investigation is marked *interrupted*, its proposed records set aside, said in the activity. (`recovery.py` C)
10. **A placement interrupted after its commit could be placed twice** (a second table on retry). Fixed: the log is the authority — a second request completes the record from the log. (`recovery.py` A, B)
11. **Deleting a document left its originals behind** under `intake/<doc>/`, reachable through nothing. Fixed: they go with the document. (`intake.py` 17)
12. **React render loop** in the intake card (a selector returning a new array each render). Fixed with a constant empty list.

## Assumptions that still need checking (not reproduced as defects)

- The header-row heuristic (first row, mostly distinct text) on exports whose first rows are a title block; such files would need the title rows quarantined — untested.
- A lone `1.500` read as a decimal: an Angolan export writing thousands without a decimal part would be misread by a factor of 1000 — the profile states the locale it chose, but nothing cross-checks magnitudes against the column.
- A file whose period cannot be read from the name or a date column is asked for on the card; a wrong period typed there is not detected.
- The 30 % identifier overlap threshold for *same series* and the 50 % population ratio for *comparable*: chosen, not derived; both are stated on the card and in the activity so a person can disagree.
- Investigations with a real model were run on Spark 1 at 0.9.0 (the probe), not at 0.10.0 and not through the gate tests.
