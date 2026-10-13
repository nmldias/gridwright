# Analytical model

Gridwright's charts, drill-through and decomposition read data through one engine query,
`Book.analyze` (`core/src/analytic.rs`). It exists so that an interactive view cannot quietly compute a
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
| Blank rows | Rows with nothing in any field the query reads (the trailing empty rows of a table) are counted as `population.blank` and otherwise ignored. |
| Bounds | At most 10,000 groups per query; at most 5,000 listed records per drill-through (the totals still cover all records; `truncated` says so). |

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

## What it does not do yet

One table per query. There are no relationships, so there is no fan-out across a join (7.6). Currencies
are refused when mixed, not converted. Metrics are given inline, not yet as governed workbook definitions
(7.5). Permissions are per document, so a query sees what the document's reader sees.
