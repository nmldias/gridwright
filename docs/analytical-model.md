# Analytical model

Gridwright's charts, drill-through and decomposition read data through one engine query,
`Book.analyze` (`core/src/analytic.rs`); the decomposition tree's `Book.decompose` uses the same plan,
measures and grouping rules. It exists so that an interactive view cannot quietly compute a
different number from the workbook. A query reads a table; it never changes the workbook. It adds no
operation to the log, does not touch the table's filters and causes no recalculation, so `SUBTOTAL` and
signed-off ranges are unaffected.

Background: the 13 Oct 2026 assessment (roadmap Phase 7) and the cited behavioural research in
[`research/interaction-behaviour.md`](research/interaction-behaviour.md).

## Query

```json
{
  "table": "Inventory",
  "dims": ["Branch"],
  "measures": [
    { "field": "Inventory value AOA", "agg": "sum" },
    { "agg": "ratio", "numerator": "Landed cost AOA", "denominator": "Selling price AOA", "name": "Cost ratio" },
    { "field": "Landed cost", "agg": "sum", "currency": "Currency" }
  ],
  "selections": [{ "field": "Reserved", "values": [{ "s": "No" }] }],
  "key": ["VIN"],
  "members": true,
  "sort": "value_desc"
}
```

* Fields are header names of the table (case-insensitive). The table may be given by name or id.
* `selections` are ANDed across fields and ORed within one field. Their values are canonical
  (`{"n":0.3}`, `{"s":"Luanda"}`, `null` for blank). The same shape is used for chart marks.
* Rows hidden by the table's header filters count as **excluded** unless `respect_table_filters` is `false`.
* `members: true` lists the 0-based table rows of each group.
* `sort`: `key` (the default; blanks last), `value_desc` or `value_asc` on the first measure (rows with no
  value last).

## Semantics

| Rule | Behaviour |
|---|---|
| Group identity | Rows are grouped by canonical value: numbers at 15 significant digits (so `=0.1+0.2` and `0.3` are one group), text ignoring case, blank as one "(blank)" group. Never by display text. |
| Row identity | Each group knows its rows (`members`), and the groups partition the included rows. `key` reports duplicate and blank identifiers over every non-blank row, whatever the selection. |
| Blank and text amounts | A blank cell in a measure is `missing`; text, a logical or an error is `invalid`. Neither is added as 0. The result is computed over the values present and is marked `incomplete`. A group with no values at all is `no_data` (value `null`), not 0. |
| Currencies | When a measure names a currency column, a group whose amounts are in more than one currency has no value (`mixed_currency`) and lists the amount per currency. One currency: the code is returned with the value. Conversion is deliberately not automatic. |
| Additivity | `sum` and `count` are additive. `average` is Σ/n of the group's values. `ratio` is Σ numerator / Σ denominator over rows with both (never an average of row ratios). `count_distinct`, `min` and `max` are not additive either. Each measure says `additive`. |
| Reconciliation | For each additive measure, the sum of the groups is compared with the total of the included rows at 15 digits: `ok`, `differs`, or `not_assessable` when a group has no number (mixed currency). |
| Excluded population | Rows left out by a selection or by the table's filters are aggregated with the same measures (`excluded.values`), with counts by reason. A view can always say what it does not show, e.g. how many reserved vehicles a "available stock" view leaves out, their value and their average age. |
| Blank rows | Rows with nothing in any cell (the trailing empty rows of a table) are counted as `population.blank` and otherwise ignored. Whether a row is blank never depends on the fields a query reads, so a chart and its drill-through count the same rows. |
| Drill-through | `Book.analyze_records` takes the same table, measures and selections and returns the rows behind the number (`row`, the requested `fields`) with their `total`, which equals the chart's value. `complement: true` lists the rows the selections leave out instead; its count and totals equal `excluded.by_selection` and `excluded.values`. Rows hidden by the table's filters are listed by neither. |
| Bounds | At most 10,000 groups per query; at most 5,000 listed records per drill-through (the totals still cover all records; `truncated` says so). |
| Decomposition order | `Book.decompose` sorts siblings by value at 15 significant digits, descending, then by key; items with no value come last. When the parent mixes currencies, siblings are sorted by key (`sort: "key"`). The order never depends on row order. |
| Other and (blank) | Top N (default 10) are named; the rest form one "Other (k)" node computed from the merged rows (never parent − shown), only when k ≥ 2. "(blank)" is always last and never folded. A node a split goes through stays named (`pinned`). |
| Decomposition checks | Every split of an additive measure reconciles: Σ children = parent at 15 digits, per currency when currencies mix, and the children's rows partition the parent's. A ratio or an average is recomputed per node from its parts and labelled "children do not sum to parent". |

## Answer

`groups[]` (`key`, `label`, `rows`, `members?`, `values[]`), `total[]`, `excluded`
(`rows`, `by_selection`, `by_table_filter`, `values[]`), `population` (`rows`, `included`, `excluded`,
`blank`), `measures[]` (`name`, `agg`, `additive`), `reconciliation[]` and `issues[]`
(`duplicate_key`, `blank_key`, `missing_values`, `invalid_values`, `mixed_currency`, `currency_missing`).
Each measure value is `{ value, status, n, missing, invalid, currency?, by_currency? }`, where `status` is
`ok`, `incomplete`, `no_data`, `mixed_currency` or `div0`.

## Drill-through

`Book.analyze_records` takes the same query plus `fields` (columns to return) and `limit`. It returns the
matching records (`row`, `values`) and the measures' totals over all of them. For a chart mark, the
selections are the chart's own selections plus the mark's key. The records then add up to the number the
mark shows, and `e2e/analytic.mjs` checks this.

## Analytical charts and cross-filtering

A chart with an `analytic` binding (`{ table, dims, measures, sort }`, saved with the chart) draws one
engine query. Each mark carries its group's canonical key. The cross-filtering policies are
stated, not assumed (`client/src/grid/crossfilter.ts`; research §1):

* A selection in chart A filters every other analytical chart on the same table (selections from
  several charts are ANDed). A is not filtered by its own selection. It dims the other marks, so links
  cannot loop and a chart's population never disappears from under its own selection.
* Click selects one mark. Ctrl/⌘/Shift-click adds or removes one.
* Clearing shows all values: click the only selected mark again, click empty plot area, or press Esc.
* The filtered chart says what it leaves out: the selection, the number of rows and the value of its
  first measure.
* A selection is per viewer (`store.markSelections`). It is not an operation and is not saved, and
  other editors do not see it.
* A ratio or an average gets no *Total* stat card: it is not summed across bars.

## Decomposition tree (7.4)

`Book.decompose` (`core/src/decompose.rs`) breaks one measure down by fields chosen per level and returns
the whole tree in one call, with a check at every split. Like `analyze` it is read-only: no operation, no
recalculation, the workbook unchanged. The panel (*Break down* on an analytical chart, *Break down a
measure…* on a table, or *More → Decomposition*) is each viewer's own state. Background: research §3
(Power BI's decomposition tree).

### Request

```json
{
  "table": "Inventory",
  "measure": { "field": "Inventory value AOA" },
  "selections": [],
  "key": ["VIN"],
  "top_n": 3,
  "splits": [
    { "path": [], "field": "Branch" },
    { "path": [{ "field": "Branch", "key": { "s": "Luanda" } }], "field": "Manufacturer" },
    { "path": [{ "field": "Branch", "other": true }], "field": "Model" }
  ],
  "suggest": { "at": [{ "field": "Branch", "key": { "s": "Benguela" } }], "rule": "high_value" }
}
```

* `measure` is one measure spec, resolved as in `analyze` (same defaults and errors). `selections`,
  `key` and `respect_table_filters` are as in a query: a tree opened from a chart starts from the chart's
  live selections.
* `top_n`: 1–50, default 10 (Power BI's default; MS Learn, "Decomposition tree").
* A split names the node it breaks down by its `path`: one step per level, `key` a canonical value
  (`null` for "(blank)") or `other: true` for that level's Other node. A field already on the node's path,
  two splits for one node, more than 200 splits or a path longer than 12 steps are errors.
* `suggest` (optional) asks for a suggested split at one node: `rule` `high_value` (default) or
  `relative`, optional `fields` (candidates in this order, at most 32) and `min_rows`.

### Response

`{ table, measure, top_n, root, excluded, population, issues, unresolved, suggestion }`. The root is the
analytical total: its value, `excluded`, `population` and `issues` are what `analyze` with no dimension
returns for the same query. Each node has `id` (stable and unique: built from the path's fields and canonical
keys, with `%`, `/` and `=` inside them escaped as `%25`, `%2F`, `%3D`), `kind`
(`root`, `value`, `other`, `blank`), `label`, `key`, `rank`, `pinned`, `path`, `selections`, `rows`,
`value` (a measure value with its status, as in `analyze`), `parts` for a ratio (Σ numerator,
Σ denominator) or an average (Σ, n), `share` and `split`. Other also carries `k` and `folded` (the keys
it holds, in rank order). A split has `field`, `items` (distinct non-blank values under the node), `sort`,
`mixed_signs`, `children` (named in rank order, then Other, then (blank)) and `check`.

### Rules

* **Population.** One scan of the table, counting included, excluded and blank rows exactly as `analyze`
  does. Children are grouped by canonical key with `analyze`'s rules (15 digits, text ignoring case,
  whitespace as blank; an error value is a named value). A label is the first row's text, so it can change
  with row order; the key, the value and the order cannot.
* **Order** (a total order). Items with a value first, by value rounded to 15 significant digits,
  descending; then by key (`compare_values` on the first row's value), then the key's text as a last
  fallback. Items with no value (`no_data`, `mixed_currency`, `div0`) come after. Rounding to 15 digits
  means a last-unit difference in a compensated sum cannot swap two items when rows are reordered. When
  the parent itself mixes currencies, its children have no common scale and are sorted by key only
  (`sort: "key"`, shown as *Sorted by name: these amounts are in different currencies*).
* **Top N, Other, (blank).** Ranks 1..N are named, plus any lower rank that a split goes through
  (`pinned`): a cross-filter that reorders siblings never folds an open node away. When at least two items
  remain they form "Other (k)", whose value is the measure computed on their merged parts (Σ, n, numerator,
  denominator, per currency), never parent − Σ shown and never an average of averages. A single remaining
  item is shown by name: there is no "Other (1)". "(blank)" is shown whenever it has rows, does not count
  toward N, is never folded into Other and is always last.
* **Selections per node.** The request's selections plus one per step: the step's key, `null` for blank,
  Other's `folded` keys. `analyze_records` with a node's selections lists exactly that node's rows, so its
  records add up to it.
* **Checks** (per split, `check`):
  * `rows_ok`: the children's rows add up to the node's rows, for every measure.
  * Additive (`kind: "sum"`): the compensated Σ of all children (named, Other, blank) against the parent,
    adding each child's compensated parts rather than its rounded total, so large children that nearly
    cancel (debits and credits netting to cents) still reconcile at 15 digits (the same for each currency
    and for a ratio's or average's parts):
    `ok` (*children add up to the parent*), `differs`, or `not_assessable` when a child has no single
    value. When the parent mixes currencies, each currency is summed and compared separately
    (`by_currency`; *children add up to the parent in each currency*).
  * Ratio, average, distinct count, min, max (`kind: "children_do_not_sum"`, `status: "recomputed"`,
    *children do not sum to parent (ratio)*): every node is recomputed from its own rows. For a ratio or an
    average `parts_ok` checks that the children's numerators and denominators add up to the parent's.
* **Shares.** `share` = child ÷ parent only for an additive measure, a positive parent and no negative
  sibling. When a sibling is negative, `mixed_signs` is set and no share is given (a percentage of a net
  amount would mislead).
* **Unresolved paths.** A split whose node is no longer in the tree (filtered out, renamed, no Other at that
  level, its parent gone) is not an error: it is skipped and listed in `unresolved` with the reason
  (*Luanda is no longer under Branch (filtered out or changed)*; for a node that a cross-filter or a lower
  top N moved into Other, *Cabinda is now inside Other (4) under Branch, outside the top 3*), so the client
  can keep or remove the level. A split on a field that is no longer a header (renamed) is an error for
  the whole request; the panel then offers to remove those levels.

### Suggested split

Only when `suggest` is given, and never applied: accepting it adds an ordinary split.

* **Candidates.** The given `fields`, in that order; otherwise every column in table order except the
  node's path fields, the `key` columns, the measure's own fields, and columns whose non-blank values at
  the node are all numbers (amounts or dates; naming one in `fields` uses it), keeping the first 32. A
  column with no header, or with the same header as an earlier column, cannot be named by a split and is
  skipped (`no header (column 2)`, `same header as column 1`). Candidates beyond the work budget are
  skipped (`work budget`), not an error; they still take one of the 32 places, so the columns after the
  32nd are `beyond the first 32 columns` however many rows the table has. Every skipped candidate says
  why.
* **Currencies.** At a node whose amounts are in different currencies there is no suggestion (*the amounts
  under this node are in different currencies (AOA, EUR), so their items cannot be ranked against each
  other; split by Currency first*): an amount in kwanza is never ranked against one in euros. Under a
  single-currency node the text states amounts with their currency.
* **Filters.** A candidate with fewer than 2 or more than 100 non-blank values at the node is skipped. Only
  non-blank items with a value and at least `min_rows` rows (default 1 for an additive measure, 5
  otherwise) are scored; at least 2 are needed.
* **Rules.** `high_value`: score = the largest item's value. `relative`: score = max v ÷ (Σ|v| / count),
  the largest item against its siblings' absolute mean (Power BI's relative mode, MS Learn "Decomposition
  tree"); all-zero values are skipped.
* **Tie-breaks.** Score at 15 digits, descending; then the field with fewer values; then the earlier one.
  The response gives `best`, `runner_up` and every candidate's score or skip reason.
* **Text.** A canonical English sentence that names the rule, the winning item and its value, the runner-up,
  the number of fields compared and the tie-breaks, and ends "A heuristic, not a cause." The rules favour
  fields with few large items and ignore blanks and small items; a suggestion says where the measure is
  concentrated, not why.

### Numbers

Values are compensated f64 sums compared at 15 significant digits, the rule of 7.1 and 7.2 (Microsoft,
"Floating-point arithmetic may give inaccurate results in Excel"). The research (§3) asks for exact decimal
arithmetic; Gridwright has no decimal cell type, so this is a stated departure: reconciliation and order
hold at Excel's precision, not beyond it.

### Limits

| Limit | Value | Past it |
|---|---|---|
| Top N | 1–50 (default 10) | error |
| Steps on a path | 12 | error |
| Splits per request | 200 | error |
| Values under one node | 10,000 non-blank | error |
| Nodes in the tree | 5,000 (Power BI: 5,000 visible points) | error |
| Keys listed in all node selections | 50,000 | error |
| Rows read (each split costs its node's rows; a suggestion its node's rows per candidate) | 5,000,000 | error for splits; remaining candidates skipped for a suggestion |
| Suggestion candidates | 32 | error when given; the rest skipped when automatic |
| Values of a suggestion candidate | 100 | candidate skipped |

`e2e/decomposition.mjs` checks every node of a three-level tree on a synthetic 10,000-vehicle inventory
against an independent reference, `engine_limits.mjs` the bounds, and `e2e/decomposition_ui.py` the panel
in the browser.

## What it does not do yet

One table per query. There are no relationships, so there is no fan-out across a join (7.6). Currencies
are refused when mixed, not converted. Metrics are given inline, not yet as governed workbook definitions
(7.5). Permissions are per document, so a query sees what the document's reader sees.

A decomposition tree has one measure; it cannot be saved or locked with the document (7.5); a tree node
does not cross-filter charts; the tree is not printable.
