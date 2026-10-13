# Interaction behaviour: what the reference products do, and what Gridwright requires

Documentation-based behavioural research for Gridwright's chart and table interactions: cross-filtering,
drill-down and drill-through, decomposition trees, excluded populations, governed metrics and linked
widgets. Sources are limited to official vendor documentation and open-source code. No proprietary
application was inspected.

**Conventions**

* Every behavioural claim cites the page or source file it was read from. A claim marked **(inferred)** is a
  reasonable reading that the source does not state outright. A claim marked **(undocumented)** means the
  source was checked and says nothing on the point.
* Sources were read on 2026-10-13. Vendor help pages change. GitHub links are pinned to a commit.
* Each section ends with **Gridwright behavioural requirements**, written as testable acceptance criteria.
  Where a requirement deliberately departs from the reference product, the reason is given.
* Vocabulary: **interaction state** is the transient selection, cross-filter and drill state of one viewer's
  session, never an operation in the document log. The **workbook** is everything the log records. A
  **population** is the set of source rows behind a number.

---

## 1. Tableau filter actions and cross-filtering

**Source and target.** A filter action has a source and one or more targets. The source can be a sheet, a
data source or a dashboard. The target is a sheet, or one or more sheets in a dashboard
([Filter Actions](https://help.tableau.com/current/pro/desktop/en-us/actions_filter.htm)). The other action
types are Highlight, Go to URL, Go to Sheet, Change Parameter and Change Set Values. They run in a fixed
order: Parameter, Set, Filter, Go to Sheet, Highlight, URL. Within one type, actions run in alphabetical
order ([Actions](https://help.tableau.com/current/pro/desktop/en-us/actions.htm)).

**Run on.** *Hover* runs the action when the pointer is over a mark. *Select* runs it on click, and
*Single-select only* suppresses it when several marks are selected. *Menu* runs it from the right-click or
tooltip menu ([Filter Actions](https://help.tableau.com/current/pro/desktop/en-us/actions_filter.htm)).

**Multi-select.** Ctrl-click (Windows) or Cmd-click (macOS) adds marks to the selection. The Rectangular
(default), Radial and Lasso tools select marks by area. "Your selection is saved with the workbook"
([Zoom and Pan Views, and Select Marks](https://help.tableau.com/current/pro/desktop/en-us/inspectdata_pan_zoom.htm)).
That page does not describe how to clear a selection **(undocumented)**.

**Clearing the selection.** There are three options. *Leave the filter* ("Keep filtered values" in web
authoring) keeps the target filtered. *Show all values* resets the target to all values. *Exclude all
values* shows nothing until a mark is selected, for master–detail layouts
([Filter Actions](https://help.tableau.com/current/pro/desktop/en-us/actions_filter.htm)).

**Mapping marks to target fields.** *All Fields* filters on every field the source and target have in
common. *Selected Fields* pairs each source field with a target data source and field. A target field must
have the same data type as its source field. On relational sources the paired fields may have different
names. On multidimensional sources the data sources and field names must match
([Filter Actions](https://help.tableau.com/current/pro/desktop/en-us/actions_filter.htm)). Filter actions
that depend on user functions such as `USERNAME()` do not work because "row-level security restricts
access to the data" (same page).

**Use as Filter.** On a dashboard, a sheet's menu offers *Use as Filter*. The action it creates is named
"generated" ([Filter Actions](https://help.tableau.com/current/pro/desktop/en-us/actions_filter.htm)). When
several views act as filters, each controlling view should be set to *Ignore Actions* so that the views do
not filter one another
([Actions and Dashboards](https://help.tableau.com/current/pro/desktop/en-us/actions_dashboards.htm)).

**Highlight versus filter.** A highlight action colours the matching marks and dims the others. It removes
nothing ([Highlight Data Points](https://help.tableau.com/current/pro/desktop/en-us/actions_highlight.htm)).
Filter and highlight actions can run on the same click (same page).

**Keep Only / Exclude.** These commands, offered on selected marks, are different from a filter action:
"Select Keep Only to keep only the selected marks in the view"
([Filter Data from Your Views](https://help.tableau.com/current/pro/desktop/en-us/filtering.htm)). Unlike an
action, they edit the sheet's own filters, so the change persists in the workbook **(inferred)**.

**Cascading and cyclic actions.** Neither the Filter Actions page nor the Actions and Dashboards page
describes a target of one action acting as the source of another, or what happens when actions form a cycle
**(undocumented)**. The only documented guard is *Ignore Actions*, set on each controlling view.

**Totals in the target.** Filters run in this order: extract, data source, context, dimension, measure,
then table-calculation filters. "Filters based on table calculations do not filter out underlying data",
and a separate *Apply to totals* option exists for them
([Filter Data from Your Views](https://help.tableau.com/current/pro/desktop/en-us/filtering.htm)). A dimension
filter runs before table calculations, and FIXED level-of-detail expressions are "computed before dimension
filters are applied"
([Order of Operations](https://help.tableau.com/current/pro/desktop/en-us/order_of_operations.htm)). Neither
page places action filters in this order. That they behave as dimension filters, so that totals in the
target recompute over the filtered rows, is **(inferred)**.

### Gridwright behavioural requirements

1. Selecting a mark in a chart or a row in a pivot sets interaction state on every linked target.
   Afterwards, the document log has no new operation and the workbook's saved filters are unchanged. A test
   compares the log sequence number before and after the selection.
2. Each link declares its trigger: `select` (the default), `hover` or `menu`. A `hover` link never changes
   the result of a figure that has been exported or copied **(departure)**. Hover is preview only, because
   a figure that changes with the pointer cannot be quoted.
3. Ctrl/Cmd-click toggles one mark in or out of the selection, and a rectangle or lasso adds every mark it
   encloses. The target is filtered to the union of the selected marks, as an OR over mark keys.
4. Each link declares its *on clear* behaviour, one of `show-all`, `keep-last` or `show-none`. The default
   is `show-all`. Esc and a click on empty plot area clear the selection.
5. A link maps fields explicitly as `source field → target field`, and both fields must have the same type.
   An implicit "all common fields" mapping is allowed only when every mapped pair has the same name and
   type, and the link shows which pairs it applied.
6. Highlight links dim the marks outside the selection and keep every value and total unchanged. Filter
   links remove those marks and recompute the target's totals over the remaining population. A target
   states which link mode it is under.
7. Every filtered target shows a visible badge such as "Filtered by: Region = North (from *Sales by
   region*)". The badge has one-click clear.
8. Interaction propagates across a link graph that may contain cycles. Propagation starts at the most
   recently changed source, visits each target at most once per user gesture, and a cycle never causes a
   second pass **(departure)**. Tableau leaves this undocumented, and an unbounded cascade would produce
   numbers that depend on the order of clicks.
9. "Keep only" and "Exclude", which persist, are separate commands that write a filter operation to the
   log. They are never side effects of selection.

---

## 2. Drill-down versus drill-through (Tableau, Power BI)

**Tableau hierarchy drill.** You drill up or down by clicking the **+** or **−** icon on a hierarchy field
([Create Hierarchies](https://help.tableau.com/current/pro/desktop/en-us/qs_hierarchies.htm)). The page
does not say whether filters survive a drill **(undocumented)**.

**Power BI drill mode.** A visual built on a hierarchy has up to four controls: *Drill up* (dimmed until
you have drilled down once); *Drill down*, a mode that drills only the data point selected next; *Go to the
next level*, which replaces the current level for every data point; and *Expand all down one level*, which
keeps the current level and adds the next beneath it
([Drill mode](https://learn.microsoft.com/en-us/power-bi/consumer/end-user-drill)). With drill mode off, clicking a data point cross-filters the other visuals instead of drilling. By default,
drilling one visual does not filter the others, though a designer can change that. "Drill explores levels of
a hierarchy within the same visual. The report page and the other visuals don't change." All of this is
from the same page. Power BI cross-filtering "removes data that doesn't apply", while cross-highlighting
"retains all the original data points but dims the portion that doesn't apply". A visual's visual-level
filters are passed on to the visuals it interacts with
([Cross-filter](https://learn.microsoft.com/en-us/power-bi/consumer/end-user-interactions)).

**Power BI drill-through.** A drill-through page declares *drillthrough filter* fields. Several fields give
compound filtering. A Back button is added automatically. The field must exist in both the source visual
and the filter well, and drill-through is not offered when the field is aggregated in the source visual.
Cross-report drill-through requires matching field names and data types
([Drillthrough](https://learn.microsoft.com/en-us/power-bi/create-reports/desktop-drillthrough)). Microsoft's
guidance distinguishes two uses. *Additional depth* goes from a summary to transaction-level rows. *Broader
perspective* goes to a holistic view of one entity. The guidance advises against visuals that could show
BLANK once drill-through filters apply
([Report drillthrough guidance](https://learn.microsoft.com/en-us/power-bi/guidance/report-drillthrough)).

The current Microsoft Learn page does not document a *Keep all filters* toggle, which controls whether
the source page's other filters are carried to the target. Its existence is attested only by community
sources found by search, so it is treated here as **(undocumented)**.

**Underlying versus summary data.** **Tableau *View Data*:** the window is "scoped to the current selection or the current view". The
*Summary* tab shows "the dimensions that define the view and the aggregated measure". *Full Data*, or one
tab per table, shows "all fields from that table". The display limit is 10,000 rows in Desktop and 200 in
Cloud and Server, and an export is not limited by it
([View Underlying Data](https://help.tableau.com/current/pro/desktop/en-us/inspectdata_viewdata.htm)).
**Power BI:** *Show as a table* shows the data behind the visual; *Show data point as a table* shows "the
underlying data used to calculate a single data point", and is unavailable when the visual has a measure in
the Value field ([Show data](https://learn.microsoft.com/en-us/power-bi/consumer/end-user-show-data)).
**Power BI export:** *Summarized data* is aggregated and filtered, and it covers the whole hierarchy, not
just the current drill level. *Underlying data* removes the aggregate and can require Build permission.
It fails when the tables have no unique key. The limits are 30,000 rows for .csv and 150,000 for .xlsx.
The first row of an export lists the applied filters. Row-level security limits what is exported
([Export data](https://learn.microsoft.com/en-us/power-bi/visuals/power-bi-visualization-export-data)).

### Gridwright behavioural requirements

1. Drill-down changes only the drilled view's level and leaves the workbook unchanged. It offers *drill
   this point*, *next level for all*, *expand one level, keep parent* and *drill up*. Drill up restores
   exactly the previous level and its selection.
2. Drilling keeps the view's filter context: page, view and incoming link filters. A drilled view does not
   filter other views unless its link says so, matching the Power BI default.
3. Drill-through from any figure opens the population behind it. That is the source rows, with every filter
   that produced the figure applied: page filters, view filters, link filters, the mark's own keys and the
   metric's built-in filters (§5). All filters are carried by default **(departure)**. Power BI's
   per-page toggle makes the rows depend on page configuration, and an auditor needs rows that sum
   back to the figure.
4. The drill-through view states its filter list in words ("Region = North; Period = 2026-Q2; metric
   filter: status = posted"). For an additive measure, it shows the reconciliation "rows sum to 1,234,567.89
   = figure ✓". A failed reconciliation shows ✗ with the difference.
5. Two views of a figure are offered: *Summary*, with the dimensions and aggregates of the figure, and
   *Rows*, with the source records. Both have the same filter list.
6. The row view is paged and never truncated without notice. "Showing 200 of 48,311" is always stated, and
   export takes the full population, subject to permissions (§7).
7. Drill-through is available for measures too **(departure)**. Power BI disables per-point
   underlying data when a measure is in Value, but every Gridwright metric has a defined population (§5).
8. Back returns to the originating view with its selection, drill level and scroll restored.

---

## 3. Power BI decomposition tree

**Inputs.** The *Analyze* input "must be a measure or an aggregate". *Explain by* takes one or more
dimensions. Clicking **+** on a node lets the user choose which dimension to split by next, "in any
order"
([Decomposition tree](https://learn.microsoft.com/en-us/power-bi/visuals/power-bi-visualization-decomposition-tree)).

**Interaction.** "Selecting a node from the last level cross-filters the data. Selecting a node from an
earlier level changes the path." Cross-filtering the tree from other visuals can reorder the nodes. When a
node becomes blank under a cross-filter, it "gets filtered out of the view", but the levels already chosen
"remain pinned". All from the same page.

**AI splits.** *High value* and *Low value* each consider every available field and pick the one that gives
the highest or lowest value of the measure. AI splits are marked with a light bulb, and the recommended node
is marked with a dotted line. *Absolute* mode compares raw values. *Relative* mode looks for values that
"stand out", using the node value divided by the absolute average of its siblings. For example,
19.55M ÷ (column total / 10) gives 4.25×. AI levels recalculate when the selected node changes or when a
cross-filter applies, and they can choose a different column. A manual split after an AI level turns that
level into a normal one. AI splits can be turned off. All from the same page.

**Locking.** A creator can lock levels, and a locked level cannot be removed or changed. Unlocked levels
cannot precede locked ones (same page).

**Limits and ordering.** The tree allows at most 50 levels and 5,000 visible data points. "We truncate
levels to show top n. Currently the top n per level is set to 10" (same page). The nodes are ordered by
value, descending **(inferred from "top n")**. The page does not say how the remaining nodes beyond the top
10 are shown, or whether they roll into an "others" node **(undocumented)**.

**What a node shows.** A node shows the dimension value, the aggregated measure and a bar proportional to it
**(inferred from the screenshots on the page)**.

**Blanks.** Apart from blank nodes disappearing under a cross-filter, the page says nothing on how a blank
dimension value is shown **(undocumented)**.

**Non-additive measures.** The page's own first example analyses an average: "the average % of products
on backorder (5.07%)". The children of such a node do not sum to their parent, and the page neither warns
about this nor marks it **(undocumented)**.

### Gridwright behavioural requirements

1. A decomposition tree is a read-only view over one governed metric (§5). Expanding, collapsing, choosing a
   split and selecting a node change interaction state only.
2. The user chooses each split from the declared dimensions. A dimension already used on the path is not
   offered again.
3. Siblings are ordered by value, descending, with a stable tie-break on the dimension value. Each level shows
   the top *N* (configurable, default 10). The rest are always rolled into one **"Other (k items)"** node
   whose value is the remainder **(departure)**. The visible siblings must account for the whole parent.
4. Blank or null dimension values form an explicit **"(blank)"** node, which is never dropped
   **(departure)**. A dropped blank makes the children fail to sum to the parent.
5. For an **additive** metric (sum, count), every expanded level satisfies Σ children = parent exactly, in
   decimal arithmetic. A test asserts this at every level, including "Other" and "(blank)".
6. For a **non-additive** metric (average, ratio, distinct count, percentile), each node shows the metric
   *recomputed over that node's population*, never a sum or average of children. The level header states
   "children do not sum to parent (ratio)". For a ratio, each node also shows its numerator and
   denominator, and those are additive.
7. Each node shows its value, its share of the parent (additive metrics only), its row count and a bar. A
   click on a node offers drill-through to its population (§2).
8. Suggested splits, the equivalent of AI splits, are optional and deterministic. A suggestion names its rule
   (for example "highest absolute value" or "largest ratio to sibling mean") and the figures behind it.
   Accepting a suggestion makes it an ordinary level, so a recalculation never changes a level the user can
   see without saying so.
9. A tree saved to the workbook may lock leading levels. Locked levels are contiguous from the root.

---

## 4. Qlik Sense associative model

**States and colours**
([Associative selection model](https://help.qlik.com/en-US/cloud-services/Subsystems/Hub/Content/Sense_Hub/Selections/associative-selection-model.htm)):

| State | Colour | Meaning |
|---|---|---|
| Selected | green, with a check mark | chosen by the user |
| Possible | white | associated with the current selection |
| Alternative | light grey | "values that would have been possible if a selection had not already been made in that field", still selectable |
| Excluded | dark grey | not associated with the selection |
| Selected excluded | dark grey, with a check mark | "first selected, and then excluded by a selection in another field" |

Custom themes can change these colours (same page).

**Excluded values stay visible.** Filter panes keep showing alternative and excluded values in grey rather
than removing them (same page). The selections bar shows each selection with a bar of the state of its values:
green for selected, light grey for alternative, dark grey for excluded
([Exploring with selections](https://help.qlik.com/en-US/cloud-services/Subsystems/Hub/Content/Sense_Hub/Selections/SelectionsToolbar/work-with-selections.htm)).

**Selections bar commands** (same page). *Select alternative* swaps the alternatives with the current
selection. *Select excluded* selects the alternatives if there are any, and otherwise the excluded values.
A selection can be locked. Selections and locks are not saved with the app.

**Alternate states.** Alternate states give independent selection sets, so that two selections on the same
dimension can be compared side by side or in one chart. A state is applied to a sheet or visualization,
and visualizations inherit it, or it is referenced in a measure's set expression
([Alternate states for comparative analysis](https://help.qlik.com/en-US/sense/Subsystems/Hub/Content/Sense_Hub/Visualizations/alternate-states-comparative-analysis.htm)).
In the selections bar, a field shows how many alternate states it has
([Exploring with selections](https://help.qlik.com/en-US/cloud-services/Subsystems/Hub/Content/Sense_Hub/Selections/SelectionsToolbar/work-with-selections.htm)).

**Excluded totals.** Set identifiers and set operators express the excluded population
([Set identifiers](https://help.qlik.com/en-US/sense/May2026/Subsystems/Hub/Content/Sense_Hub/ChartFunctions/SetAnalysis/set-identifiers.htm),
[Set operators](https://help.qlik.com/en-US/sense/May2026/Subsystems/Hub/Content/Sense_Hub/ChartFunctions/SetAnalysis/set-operators.htm)).
`1` is "the full set of all the records in the application, irrespective of any selections"; `$` is the
current selection and `$1` the previous one; `-` is exclusion. So `sum({1-$} Sales)` "returns sales for
everything excluded by current selection".

### Gridwright behavioural requirements

1. Under a filter link, each dimension value in a filter list or legend has one of these states:
   **selected**, **possible**, **alternative** or **excluded**. They are rendered as distinct styles that
   meet WCAG contrast and are not distinguished by colour alone. Selected and excluded also carry an icon.
2. Excluded values remain listed, greyed and selectable, and are never removed from the list.
3. Every filtered view can show **three figures: selected, excluded and total**, where selected + excluded
   = total for additive metrics. For example: "Selected 1.2M · Excluded 0.3M · Total 1.5M".
   **Excluded** is the `1 − $` population: all rows that pass the view's own fixed filters minus the rows
   that pass the selection.
4. The excluded population supports drill-through (§2), with the filter list stated as its negation
   ("Region ≠ North"). Rows with a null Region are listed under their own heading, never silently placed on
   either side.
5. A selections bar lists every active interaction filter, with per-field state proportions, clear for each
   field and clear-all. Step back and step forward cover interaction state only.
6. Interaction state is not saved with the document, as in Qlik. A named **saved selection**, the
   equivalent of a bookmark, is an explicit command that writes an operation to the log.
7. Comparison sets, the equivalent of alternate states, are allowed: two independent selection sets in one
   view, each labelled. Figures from different sets are never added together without a label.

---

## 5. Lightdash governed metrics (open source)

**Declaration.** Metrics are declared in dbt YAML under `meta.metrics`, or `config.meta.metrics` in
dbt 1.10 and later. A *column-level* metric aggregates that column. A *model-level* metric combines several
columns or metrics ([Metrics reference](https://docs.lightdash.com/references/metrics)). Dimensions are
declared under `meta.dimension`, with `type`, `label`, `sql`, `time_intervals`, `format`, `hidden` and
`groups`. `additional_dimensions` derives extra dimensions from a single column
([Dimensions reference](https://docs.lightdash.com/references/dimensions)).

**Metric categories.** *Aggregate* metrics reference dimensions and may have filters. *Non-aggregate*
metrics reference other metrics only, as `${metric}`, and **cannot** have filters. *Post-calculation*
metrics (experimental) are computed after the others
([Metrics reference](https://docs.lightdash.com/references/metrics)).

**Metric types in source**
([`field.ts` L932–951](https://github.com/lightdash/lightdash/blob/68e75c4824dfb42649b172e4b11e5d1555491069/packages/common/src/types/field.ts#L932-L951),
groupings at
[L1014–1047](https://github.com/lightdash/lightdash/blob/68e75c4824dfb42649b172e4b11e5d1555491069/packages/common/src/types/field.ts#L1014-L1047)).
Aggregate: `sum`, `count`, `count_distinct`, `average`, `min`, `max`, `median`, `percentile`. Distinct
aggregates (beta), deduplicating on `distinct_keys`: `sum_distinct`, `average_distinct` (in the enum but not
in the `AggregateMetricTypes` array). Non-aggregate: `number`, `string`, `date`, `timestamp`, `boolean`
(`timestamp` is in the source but not the docs). Post-calculation: `percent_of_previous`,
`percent_of_total`, `running_total`.

**Properties.** A metric can carry `label`, `type`, `description`, `sql`, `hidden`, `format` (a
spreadsheet-style format string), `round` (legacy), `compact`, `separator`, `groups`, `filters`,
`show_underlying_values`, `required_attributes`/`any_attributes`, `tags`, `urls`, `percentile` and
`distinct_keys` ([Metrics reference](https://docs.lightdash.com/references/metrics)).

**Metric filters.** A metric's filters are compiled into its SQL. They do not appear in the Explore Filters
tab, and users cannot remove them. Several filters combine with AND. A list of values becomes `IN`. Joined
fields use `model.field` (same page).

**Underlying data.** `show_underlying_values` lists the fields shown under *View underlying data*. Without
it, the list is capped at the first 50 dimensions (same page).

**Fan-out.** Joins declare a `relationship`: one-to-many, many-to-one, one-to-one or many-to-many. Given a
`primary_key` and a relationship, Lightdash adds CTEs to "ensure metrics are not inflated", computing SUM, COUNT and AVG at the correct grain. MIN,
MAX and COUNT DISTINCT are safe by definition. The protection may not cover metrics whose SQL or filters
reference joined dimensions, or rolled-up metrics
([Joins reference](https://docs.lightdash.com/references/joins.md)).

**Reuse across charts.** A saved chart's query stores the field IDs of its dimensions and metrics, plus
inline `additionalMetrics` and `metricOverrides` for formatting
([`metricQuery.ts` L174–196](https://github.com/lightdash/lightdash/blob/68e75c4824dfb42649b172e4b11e5d1555491069/packages/common/src/types/metricQuery.ts#L174-L196)).
"A saved chart re-runs its query every time you open it"
([Using explores](https://docs.lightdash.com/get-started/exploring-data/using-explores)). So every chart
that references a metric picks up a changed definition the next time it runs **(inferred)**.

**Dashboard interaction.** Filters a viewer adds are temporary: "nobody else's view changes". Clicking a
value cross-filters "every tile in the dashboard that has the filtered field". *Drill into* works on
metrics only
([Interact with dashboards](https://docs.lightdash.com/explore/dashboards/interact.md)).

### Gridwright behavioural requirements

1. A metric is declared once, by name, with `type`, `sql` or `source column`, `format`, optional `filters`
   and `description`. Charts, pivots, trees and checks reference it by ID and never copy its formula.
2. Supported types, at minimum: `sum`, `count`, `count_distinct`, `average`, `min`, `max`, `median`,
   `percentile`, and `number` for a ratio or arithmetic of other metrics. Every metric carries an
   **additivity class**, derived from its type: `additive` for sum and count, `semi-additive` for balances
   over time, and `non-additive` for the rest. Trees (§3), totals and the selected/excluded split (§4)
   read this class.
3. Metric filters are part of the metric. They apply wherever the metric is used, and a viewer cannot remove
   them. They are shown as "built-in filter" in every filter list and drill-through.
4. A `number` metric cannot have filters of its own. Its population is the union of its inputs'
   populations, and drill-through offers each input separately (numerator rows, denominator rows).
5. Changing a metric definition is a logged operation. Every view that uses the metric shows the new value
   at its next recalculation, and the change is visible in the metric's history.
6. A metric over a join declares the grain it is computed at (primary key). A sum or count that would be
   computed across a one-to-many join without deduplication is refused with an explanation, rather than
   inflated (§7) **(departure)**. Lightdash documents gaps in its protection, and Gridwright must not
   publish a total that is possibly inflated.
7. Formats are declared on the metric. A view may override display format only, never rounding of the stored
   value.

---

## 6. Grist relational references and linked widgets (open source)

**Reference columns.** "Cells in a reference column always identify an entire record". What is stored is
the row ID, and *Show Column* chooses which field is displayed. Dot notation (`$Client.Contact`) follows a
reference. *Reference List* holds several records. A value that does not exist in the referenced table is
"highlighted as invalid" ([Reference columns](https://support.getgrist.com/col-refs/)).

**Select By.** In the widget picker, *Select By* names the source widget. "Selecting a record in one widget
will cause another widget to update and show only the data related to the selected record." Linking
"only works when there is a relationship between records in the underlying data"
([Linking widgets](https://support.getgrist.com/linking-widgets/)).

**Link types in source.** `LinkingState.ts` classifies each link as one of the following
([L88–114](https://github.com/gristlabs/grist-core/blob/de166cd1e1f4a91c1a896ad28e15529768f0a0d2/app/client/components/LinkingState.ts#L88-L114)):
`Filter:Col->Col` and `Filter:Row->Col` filter the target; `Cursor:Reference` and `Cursor:Same-Table` move
the target's cursor without filtering; `Show-Referenced-Records` filters to the IDs held in a Reference
List; `Summary` filters a summary table's detail; `Filter:Summary-Group` links through the `group` column.

**Selection.** A filter link uses the operation `in` for single values and `intersects` for list
columns. Where the source widget has a multi-row custom selection, the target is filtered to all
selected row IDs
([L117–120](https://github.com/gristlabs/grist-core/blob/de166cd1e1f4a91c1a896ad28e15529768f0a0d2/app/client/components/LinkingState.ts#L117-L120),
[L519–534](https://github.com/gristlabs/grist-core/blob/de166cd1e1f4a91c1a896ad28e15529768f0a0d2/app/client/components/LinkingState.ts#L519-L534)).
**Blank selector:** a blank selector "shouldn't mean 'show no records', it should mean 'show records
where tgt column is also blank'"
([L465–494](https://github.com/gristlabs/grist-core/blob/de166cd1e1f4a91c1a896ad28e15529768f0a0d2/app/client/components/LinkingState.ts#L465-L494)).
**No row selected:** with the cursor on the add-row, or no data in the source, the target shows **no
rows**, is greyed out and shows "No row selected"
([L496–503](https://github.com/gristlabs/grist-core/blob/de166cd1e1f4a91c1a896ad28e15529768f0a0d2/app/client/components/LinkingState.ts#L496-L503)).
**Cycles:** cursor links may form cycles. Each link carries the sequence number of the last cursor edit,
so that the most recent edit wins and the configuration settles
([L220–245](https://github.com/gristlabs/grist-core/blob/de166cd1e1f4a91c1a896ad28e15529768f0a0d2/app/client/components/LinkingState.ts#L220-L245)).

**Summary tables.** A summary table is grouped by chosen columns, with one row per distinct combination. It
gets a `count` column (`len($group)`) and, for each numeric source column, a same-named total
(`SUM($group.X)`). It holds a hidden `group` column that "contains for each cell the group of records
represented by this summary row" ([Summary tables](https://support.getgrist.com/summary-tables/)). In
source, `group` is a formula column of type `RefList:<source table>` with the formula
`table.getSummarySourceGroup(rec)`, and the totals are generated as `SUM($group.<col>)`
([`summary.py` L20–23, L107–110](https://github.com/gristlabs/grist-core/blob/de166cd1e1f4a91c1a896ad28e15529768f0a0d2/sandbox/grist/summary.py#L20-L110)).
Group-by values cannot be edited, but the set of group-by columns can be changed. A summary can link to a
more detailed summary whose group-by columns are a superset
([Summary tables](https://support.getgrist.com/summary-tables/)).

**Summary to detail.** Selecting a summary row and linking the source table shows "all employees in that
position" ([Summary tables](https://support.getgrist.com/summary-tables/)). In source, this `Summary` link
is implemented as **one equality filter per group-by column**. A summary grouped by nothing applies no
filter
([L131–176](https://github.com/gristlabs/grist-core/blob/de166cd1e1f4a91c1a896ad28e15529768f0a0d2/app/client/components/LinkingState.ts#L131-L176)).
Linking via the `group` column filters by the actual row IDs in that group (`Filter:Summary-Group`, L96–97).

### Gridwright behavioural requirements

1. Every aggregated row (pivot cell, chart mark, summary row, tree node) carries a **group reference**: the
   list of source row IDs that make it up, or a filter that reproduces exactly that list. Drill-through
   resolves the group reference and lists those rows.
2. For a summary with a SUM column, Σ of that column over the rows in a group reference equals the summary
   cell exactly. A property test holds this for random group-bys.
3. A view can be linked to another with *select by*. Selecting a row filters the target to related records,
   through a reference column, matching group-by keys, or the group reference. Like all selection, this is
   interaction state (§1.1).
4. A link built from group-by keys and a link built from the group reference must return the same rows. A
   test asserts that they agree, including for null keys.
5. A blank key in the source matches target rows whose key is blank. It never matches all rows and never
   matches none.
6. With nothing selected, a `select by` target shows no rows and a "No row selected in *Source*" message.
   This is Grist's behaviour, and it corresponds to `show-none` in §1.4. The link's *on clear* setting may
   change it to `show-all`.
7. Reference columns store the row ID and display a chosen field. A dangling reference is shown as invalid,
   and is counted under its own heading in any group-by, never dropped.
8. Group-by columns of a summary are derived and read-only. Changing the grouping is a logged operation on
   the view definition.
9. Links may form cycles. The most recent user gesture wins, and each gesture is propagated once (§1.8).

---

## 7. Where reverse engineering stops

None of the products above specifies the following. Gridwright must define them itself:

* **Join fan-out:** a metric declares its grain, and a sum or count that would repeat rows across a
  one-to-many join is deduplicated at that grain or refused, never silently inflated.
  Lightdash only partly covers this ([Joins reference](https://docs.lightdash.com/references/joins.md)).
* **Mixed currency:** a population containing more than one currency is never summed into one figure.
  It shows a total for each currency, or a converted total that names its rate source and date.
* **Non-additive aggregation:** ratios, averages, distinct counts and percentiles are recomputed from their
  inputs over each population. They are never summed or averaged across children, and every place that
  shows a total says so.
* **Null treatment:** nulls and blanks form an explicit "(blank)" group in every group-by, filter, tree and
  selected/excluded split. A count states whether it includes them.
* **Permissions through aggregates:** an aggregate is shown only if the viewer may see every row in its
  population, or else it is marked as partial. Drill-through and the excluded-population view never
  reveal rows the viewer could not query directly.
