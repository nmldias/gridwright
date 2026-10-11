# Guided import

A raw export (an ERP's invoice extract, a bank statement, a ledger dump) becomes clean, structured tables and a first analysis in steps a person reviews. Each step is recorded, so any placed table can later answer *how was this made?*. The steps can be saved as a **recipe** and reused on the next export, even when its layout has drifted. Two related exports can be **compared** document by document.

Open it from *Add → Guided import…* (also in the document menu, and on the start card). Every dataset belongs to the client it was brought into (see [multi-tenancy](multi-tenancy.md)).

## The journey

| Stage | What happens | Where |
|---|---|---|
| **Bring in** | `.xlsx`/`.xlsm` (every sheet), `.csv`/`.tsv`/`.txt` (delimiter detected). The original file is kept byte for byte, with its SHA-256. It is read **in a worker thread** under a memory ceiling by a streaming reader: a workbook with hundreds of thousands of rows is never fully loaded into the server process. Formulas are read as the values the file last computed; macros are never run. | Library |
| **Profile** | Finds the header row (it does not have to be row 1), each column's type and how sure it is, Portuguese/English number and date formats (`1.234,56`, `31/12/2026`), currencies, empty and constant columns, duplicates, near-identical spellings of the same name (`ALFA-SEGUROS DE TESTE` / `ALFA, SEGUROS DE TESTE`) and columns that are equal on every row. | *Prepare → What I found* |
| **Propose** | A rule-based first recipe from the profile: the header, conversions, dropping empty/constant columns, unifying spelling variants, document roles (id, date, customer, amount, status, type) and the output tables (clean documents, monthly summary, top customers, open items by age, exceptions). Every proposed step says *why*. | *Prepare → Steps* |
| **Review** | Each step can be turned off, moved or removed, with a live preview on the first 3 000 rows that shows what the step changed. The **assistant** explains the data and proposes steps; a proposal is validated against the step catalogue and previewed before it is added. Nothing changes until you add it. | *Prepare*, *Assistant* |
| **Run** | The recipe runs on every row (SQLite, in a worker). Each step records how many rows and cells it changed, examples, and its checks (totals before and after, counts, uniqueness of the id). | *Results* |
| **Analyse** | Insights from the clean table: monthly trend, customer concentration (spelling variants counted together), new customers, open receivables by age, the document mix (invoices, credit notes, statuses), unusual amounts. A CSV export of any table, with formula-like cells defused (`'=…`). | *Results* |
| **Place** | Selected tables go into a new workbook or the current one, side by side, sized to their content. Identifiers and formula-like text are kept as text. Up to 10 000 rows per table by default, 50 000 at most; the full table stays in the dataset. | *Results → Place* |
| **Save the recipe** | Name it and save it. Saving again from another run makes a new **version**; earlier versions are kept, and so is each file the recipe was used on. | *Results* |
| **Audit** | The source file, every run, every step with its counts and examples, the issues found. | *Audit* |
| **How was this made?** | Right-click a placed table or row. The chain is *file → run → (comparison) → this table*: the steps that made it and, for a row, the **line in the original file**, paired column by column with the cleaned values. Dropped and derived columns are shown apart. | Right-click in the workbook |

## The next file: recipes and layout drift

When a file arrives, its header and columns are matched against the client's saved recipes. The best match is shown with a score and, under *What changed?*, the drift in plain words:

- the header row moved (`Header row: 1 → 3`);
- a column moved, matched by header, not position;
- a column was renamed (`“Valor Total” is now “Valor Total (AOA)”`), mapped with a confidence and flagged for confirmation;
- a column is missing. Any step that needs it is **switched off and named**: `1 step cannot run without: “Ref. Cliente”`;
- a new column, kept in the clean table.

The adapted recipe becomes the draft. Review it, run it, and save it as the recipe's next version.

A recipe can be made **automatic**. A later file that matches it runs straight away, and the person still reviews the results and chooses what to place. An automatic run only happens when nothing in the match is an error: a missing column that a step needs, for example, waits for a person.

## Related files: compare, reconcile, append

Once a dataset has run, *Related data* lists the client's other datasets that share columns and identifiers with it, and suggests what to do:

| Kind | When | What it gives |
|---|---|---|
| **Compare** | Two exports of the same documents (a re-extract, a corrected file, the next month's cumulative extract) | Matched on the document id (the recipe's declared id when it covers at least 90 % of rows). The result is: differences by column; **status movements** (`Aberta → Fechada`, with documents and amount); **every difference**, before and after; documents **only in this file**; documents **missing** from it; and the **net** change of each amount column. |
| **Reconcile** | Two sources that should agree (ledger vs. bank, ERP vs. tax portal) | Matched pairs, the amount differences, what is on one side only. |
| **Append** | Consecutive periods with the same layout | One table, with the file each row came from. |

The tables of a comparison can be placed like a run's tables (named `… vs <other file>`). Their lineage shows the comparison and its findings. A row *missing from this file* traces to its line in the **other** file.

## What it keeps, and for how long

Per client, under the data directory, each dataset keeps:

- the original file;
- the read rows (one SQLite file);
- the last **5 runs** and the last **5 comparisons**, plus any run or comparison whose tables are placed in a workbook (so their lineage keeps working).

Deleting a dataset deletes all of these. Tables already placed in workbooks stay, but their lineage is no longer available. Recipes are kept until deleted and hold steps and column names, never data rows.

## Roles

| | Viewer | Editor | Administrator |
|---|---|---|---|
| See datasets, runs, recipes, audit; ask *how was this made?* | yes | yes | yes |
| Bring in files, run steps, ask the assistant for steps, compare, place, save/edit/delete recipes, delete datasets | — | yes | yes |

Nothing of one client is visible to another: datasets, jobs, raw rows, runs, recipes, related-file suggestions, comparisons and lineage are all scoped to the active client. An id from another client answers 404, as if it did not exist. The same layout in two clients matches only that client's recipes.

## Limits (environment)

| Variable | Default | |
|---|---|---|
| `GRIDWRIGHT_DATASET_MAX_MB` | 100 | largest file accepted |
| `GRIDWRIGHT_DATASET_MAX_ROWS` | 2 000 000 | rows read per sheet (at least 1 000); 256 columns |
| `GRIDWRIGHT_DATASET_MAX_INFLATED_MB` | 1 024 | total decompressed size a workbook may expand to (zip-bomb guard) |
| `GRIDWRIGHT_DATASET_HEAP_MB` | 1 536 | heap ceiling of each worker |
| `GRIDWRIGHT_DATASET_WORKERS` | 2 | workers at once; further jobs queue |
| `GRIDWRIGHT_DATASET_TIMEOUT_S` | 900 | wall-clock limit of a job |

For scale: an invoice extract of about 90 000 rows by 12 columns runs its full recipe in 7–12 s on a 2-vCPU host.

## Tests

`e2e/guided_import.py` (63 checks, browser and API) builds its own synthetic exports with `e2e/guided_fixture.py`. These are deterministic invoice extracts: a workbook with a title block, credit notes, spelling variants and formula-like cells, plus a corrected re-extract whose layout drifts (header on row 3, a renamed, a missing and a new column, columns moved). They come with a log of every edit, so each expected figure is computed independently of the server. `e2e/tenancy.py` covers isolation between clients and roles. Both run in CI.
