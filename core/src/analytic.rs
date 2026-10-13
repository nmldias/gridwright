//! Analytical queries over a table: group the data rows by dimensions and aggregate
//! measures, keeping what a chart, a drill-through and a decomposition tree need to be
//! trusted (13 Oct 2026 assessment, phase 7):
//!
//! * **Identity.** Groups are keyed by canonical values (numbers at 15 significant
//!   digits, text ignoring case), never by display text, and every group knows the
//!   table rows it was computed from.
//! * **Nothing is silently zero.** A blank or non-numeric value in a measure is counted
//!   (`missing`, `invalid`) and the result says `incomplete`; a group with no values says
//!   `no_data` instead of 0.
//! * **Currencies are not added together.** A measure with a currency field gives no
//!   number for a group that mixes currencies (`mixed_currency`) and shows the amount per
//!   currency instead.
//! * **Non-additive measures are computed from their parts.** `average` is Σ/n of the
//!   group's values, `ratio` is Σ numerator / Σ denominator — never an average of
//!   averages. Only `sum` and `count` are additive; only they are reconciled.
//! * **Exclusions stay visible.** Rows removed by a selection or by the table's filters
//!   are aggregated too, so a view can say what it does not show.
//! * **Reconciliation is evidence.** For each additive measure the sum of the groups is
//!   compared with the total of the included rows.
//!
//! Queries read the workbook; they never change it (a selection is not a filter
//! operation: no recalculation, no `SUBTOTAL` change, nothing in the log).

use crate::formula::eval::{compare_values, format_text};
use crate::formula::numerics::{number_key, numbers_equal};
use crate::model::{CellKey, Table, Value, Workbook};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

/// At most this many groups per query (a dimension with more distinct values is not a
/// chart axis; the engine's limits hold for new code).
pub const MAX_GROUPS: usize = 10_000;
/// Rows listed per issue and per drill-through answer unless the query asks for fewer.
const ISSUE_ROWS: usize = 10;
const MAX_ISSUES: usize = 50;
pub const MAX_RECORDS: usize = 5_000;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct MeasureSpec {
    /// Label of the measure (defaults to "<agg> of <field>").
    pub name: String,
    /// Header of the column aggregated (not used by `ratio`; optional for `count`).
    pub field: String,
    /// sum | count | count_distinct | average | min | max | ratio
    pub agg: String,
    /// `ratio`: headers of the numerator and denominator columns (both summed).
    pub numerator: String,
    pub denominator: String,
    /// Header of a column holding each row's currency code: amounts in different
    /// currencies are never added together.
    pub currency: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct Selection {
    pub field: String,
    /// Canonical values (`{"n":1}`, `{"s":"Luanda"}`, `null`); any of them matches.
    pub values: Vec<Value>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Query {
    pub table: String,
    pub dims: Vec<String>,
    pub measures: Vec<MeasureSpec>,
    /// AND across fields, OR within one field's values.
    pub selections: Vec<Selection>,
    /// Columns that identify a row (e.g. ["VIN"]): duplicates and blanks are reported.
    pub key: Vec<String>,
    /// List the table rows of each group (0-based row indexes).
    pub members: bool,
    /// Rows hidden by the table's header filters count as excluded (default true).
    pub respect_table_filters: Option<bool>,
    /// "key" (default) or "value_desc" / "value_asc" on the first measure.
    pub sort: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct RecordsQuery {
    #[serde(flatten)]
    pub query: Query,
    /// Headers of the columns to return for each record (default: every column).
    pub fields: Vec<String>,
    pub limit: Option<usize>,
    /// The records the selections leave out instead (the excluded population; rows hidden by
    /// the table's filters are not included either way).
    pub complement: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct MeasureValue {
    pub value: Option<f64>,
    /// ok | incomplete | no_data | mixed_currency | div0
    pub status: &'static str,
    /// Values used.
    pub n: u64,
    /// Rows whose value is blank.
    pub missing: u64,
    /// Rows whose value is text, a logical or an error where a number is expected.
    pub invalid: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    /// Per-currency amounts, when the measure has a currency field and the rows mix them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub by_currency: Vec<CurrencyAmount>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct CurrencyAmount {
    pub currency: String,
    pub value: f64,
    pub n: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Group {
    pub key: Vec<Value>,
    pub label: Vec<String>,
    pub rows: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<u32>>,
    pub values: Vec<MeasureValue>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MeasureInfo {
    pub name: String,
    pub agg: String,
    pub additive: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Excluded {
    pub rows: u64,
    pub by_selection: u64,
    pub by_table_filter: u64,
    pub values: Vec<MeasureValue>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Population {
    /// Data rows with something in at least one cell.
    pub rows: u64,
    pub included: u64,
    pub excluded: u64,
    /// Data rows with nothing in any cell (trailing empty rows). Whether a row is blank never
    /// depends on which fields a query reads, so a chart and its drill-through count the same rows.
    pub blank: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Reconciliation {
    pub measure: String,
    /// ok | differs | not_assessable (the total itself has no number)
    pub status: &'static str,
    pub total: Option<f64>,
    pub sum_of_groups: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Issue {
    /// duplicate_key | blank_key | missing_values | invalid_values | mixed_currency | currency_missing
    pub kind: &'static str,
    pub text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<u32>,
    pub count: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Answer {
    pub table: String,
    pub dims: Vec<String>,
    pub measures: Vec<MeasureInfo>,
    pub groups: Vec<Group>,
    pub total: Vec<MeasureValue>,
    pub excluded: Excluded,
    pub population: Population,
    pub reconciliation: Vec<Reconciliation>,
    pub issues: Vec<Issue>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Record {
    pub row: u32,
    pub values: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Records {
    pub table: String,
    pub fields: Vec<String>,
    pub measures: Vec<MeasureInfo>,
    /// Totals of the measures over every matching record (not only the listed ones).
    pub total: Vec<MeasureValue>,
    pub count: u64,
    pub truncated: bool,
    pub records: Vec<Record>,
}

// ---------------------------------------------------------------------------------------
// canonical keys

/// Hashable canonical form of a value: two values share a key exactly when formulas
/// compare them equal and they have the same type (numbers at 15 significant digits,
/// text ignoring case). NaN never occurs in stored values; it gets its own key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Key {
    Empty,
    Number(String),
    Text(String),
    Bool(bool),
    Error(String),
}

fn key_of(v: &Value) -> Key {
    match v {
        Value::Empty => Key::Empty,
        Value::Number(x) => Key::Number(number_key(*x)),
        Value::Text(s) => {
            if s.trim().is_empty() {
                Key::Empty
            } else {
                Key::Text(s.to_lowercase())
            }
        }
        Value::Bool(b) => Key::Bool(*b),
        Value::Error(e) => Key::Error(e.as_str().to_string()),
    }
}

// ---------------------------------------------------------------------------------------
// accumulation

#[derive(Clone, Copy, Default)]
struct Sum {
    s: f64,
    c: f64,
}
impl Sum {
    /// Neumaier's compensated sum: long columns of amounts do not drift.
    fn add(&mut self, x: f64) {
        let t = self.s + x;
        if self.s.abs() >= x.abs() {
            self.c += (self.s - t) + x;
        } else {
            self.c += (x - t) + self.s;
        }
        self.s = t;
    }
    fn get(&self) -> f64 {
        self.s + self.c
    }
}

#[derive(Clone, Default)]
struct Acc {
    sum: Sum,
    den: Sum,
    n: u64,
    rows: u64,
    missing: u64,
    invalid: u64,
    min: Option<f64>,
    max: Option<f64>,
    distinct: HashSet<Key>,
    by_currency: BTreeMap<String, (Sum, u64)>,
}

#[derive(Clone)]
struct Measure {
    info: MeasureInfo,
    agg: Agg,
    col: Option<u32>,
    den: Option<u32>,
    currency: Option<u32>,
}

#[derive(Clone, Copy, PartialEq)]
enum Agg {
    Sum,
    Count,
    CountDistinct,
    Average,
    Min,
    Max,
    Ratio,
}

fn number_of(v: &Value) -> Result<Option<f64>, ()> {
    match v {
        Value::Number(x) => Ok(Some(*x)),
        Value::Empty => Ok(None),
        Value::Text(s) if s.trim().is_empty() => Ok(None),
        _ => Err(()),
    }
}

impl Measure {
    fn add(&self, acc: &mut Acc, t: &Table, r: u32) {
        acc.rows += 1;
        let at = |c: u32| t.value_at(CellKey::new(r, c));
        match self.agg {
            Agg::Count => match self.col {
                None => acc.n += 1,
                Some(c) => match key_of(&at(c)) {
                    Key::Empty => acc.missing += 1,
                    _ => acc.n += 1,
                },
            },
            Agg::CountDistinct => match key_of(&at(self.col.unwrap_or(0))) {
                Key::Empty => acc.missing += 1,
                k => {
                    acc.n += 1;
                    acc.distinct.insert(k);
                }
            },
            Agg::Ratio => {
                let a = number_of(&at(self.col.unwrap_or(0)));
                let b = number_of(&at(self.den.unwrap_or(0)));
                match (a, b) {
                    (Ok(Some(a)), Ok(Some(b))) => {
                        acc.n += 1;
                        acc.sum.add(a);
                        acc.den.add(b);
                        self.add_currency(acc, t, r, a);
                    }
                    (Err(_), _) | (_, Err(_)) => acc.invalid += 1,
                    _ => acc.missing += 1,
                }
            }
            Agg::Sum | Agg::Average | Agg::Min | Agg::Max => match number_of(&at(self.col.unwrap_or(0))) {
                Ok(Some(x)) => {
                    acc.n += 1;
                    acc.sum.add(x);
                    acc.min = Some(acc.min.map_or(x, |m| m.min(x)));
                    acc.max = Some(acc.max.map_or(x, |m| m.max(x)));
                    self.add_currency(acc, t, r, x);
                }
                Ok(None) => acc.missing += 1,
                Err(_) => acc.invalid += 1,
            },
        }
    }

    fn add_currency(&self, acc: &mut Acc, t: &Table, r: u32, x: f64) {
        if let Some(c) = self.currency {
            let code = t.value_at(CellKey::new(r, c)).to_display().trim().to_uppercase();
            let e = acc.by_currency.entry(code).or_default();
            e.0.add(x);
            e.1 += 1;
        }
    }

    fn result(&self, acc: &Acc) -> MeasureValue {
        let mut out = MeasureValue {
            value: None,
            status: "ok",
            n: acc.n,
            missing: acc.missing,
            invalid: acc.invalid,
            currency: None,
            by_currency: vec![],
        };
        if self.currency.is_some() && !acc.by_currency.is_empty() {
            if acc.by_currency.len() > 1 {
                out.status = "mixed_currency";
                out.by_currency = acc
                    .by_currency
                    .iter()
                    .map(|(k, (s, n))| CurrencyAmount {
                        currency: k.clone(),
                        value: s.get(),
                        n: *n,
                    })
                    .collect();
                return out;
            }
            let code = acc.by_currency.keys().next().cloned().unwrap_or_default();
            if !code.is_empty() {
                out.currency = Some(code);
            }
        }
        let counted = matches!(self.agg, Agg::Count | Agg::CountDistinct);
        out.value = match self.agg {
            Agg::Count => Some(acc.n as f64),
            Agg::CountDistinct => Some(acc.distinct.len() as f64),
            _ if acc.n == 0 => None,
            Agg::Sum => Some(acc.sum.get()),
            Agg::Average => Some(acc.sum.get() / acc.n as f64),
            Agg::Min => acc.min,
            Agg::Max => acc.max,
            Agg::Ratio => {
                let d = acc.den.get();
                if d == 0.0 {
                    out.status = "div0";
                    return out;
                }
                Some(acc.sum.get() / d)
            }
        };
        if out.value.is_none() {
            out.status = "no_data";
        } else if !counted && (acc.missing > 0 || acc.invalid > 0) {
            out.status = "incomplete";
        }
        out
    }
}

fn resolve_measures(t: &Table, specs: &[MeasureSpec]) -> Result<Vec<Measure>, String> {
    let col = |name: &str, what: &str| -> Result<u32, String> {
        t.column_by_header(name)
            .ok_or_else(|| format!("{} \"{}\" is not a header of table \"{}\"", what, name, t.name))
    };
    let mut out = vec![];
    for s in specs {
        let agg = match s.agg.trim().to_lowercase().as_str() {
            "" | "sum" => Agg::Sum,
            "count" => Agg::Count,
            "count_distinct" | "countdistinct" | "distinct" => Agg::CountDistinct,
            "average" | "avg" | "mean" => Agg::Average,
            "min" => Agg::Min,
            "max" => Agg::Max,
            "ratio" => Agg::Ratio,
            other => return Err(format!("unknown aggregation \"{}\" (sum, count, count_distinct, average, min, max, ratio)", other)),
        };
        let (c, den) = match agg {
            Agg::Ratio => {
                if s.numerator.trim().is_empty() || s.denominator.trim().is_empty() {
                    return Err("a ratio needs a numerator and a denominator field".into());
                }
                (Some(col(&s.numerator, "numerator")?), Some(col(&s.denominator, "denominator")?))
            }
            Agg::Count if s.field.trim().is_empty() => (None, None),
            _ => {
                if s.field.trim().is_empty() {
                    return Err("a measure needs a field".into());
                }
                (Some(col(&s.field, "field")?), None)
            }
        };
        let currency = if s.currency.trim().is_empty() { None } else { Some(col(&s.currency, "currency field")?) };
        let agg_name = match agg {
            Agg::Sum => "sum",
            Agg::Count => "count",
            Agg::CountDistinct => "count_distinct",
            Agg::Average => "average",
            Agg::Min => "min",
            Agg::Max => "max",
            Agg::Ratio => "ratio",
        };
        let name = if !s.name.trim().is_empty() {
            s.name.trim().to_string()
        } else if agg == Agg::Ratio {
            format!("{} / {}", s.numerator.trim(), s.denominator.trim())
        } else if c.is_none() {
            "Rows".to_string()
        } else {
            format!("{} of {}", agg_name, s.field.trim())
        };
        out.push(Measure {
            info: MeasureInfo {
                name,
                agg: agg_name.into(),
                additive: matches!(agg, Agg::Sum | Agg::Count),
            },
            agg,
            col: c,
            den,
            currency,
        });
    }
    Ok(out)
}

/// A dimension value as a label: dates and formatted numbers as their cells show them.
fn label_of(t: &Table, r: u32, c: u32, v: &Value) -> String {
    if let Value::Number(_) = v {
        if let Some(fmt) = t.get(CellKey::new(r, c)).and_then(|cell| cell.format.number_format.clone()) {
            if !fmt.starts_with("currency:") {
                return format_text(v, &fmt);
            }
        }
    }
    v.to_display()
}

struct Plan<'a> {
    t: &'a Table,
    dims: Vec<u32>,
    measures: Vec<Measure>,
    sels: Vec<(u32, HashSet<Key>)>,
    respect_filters: bool,
    /// rows with something in at least one cell (by row index); the others are blank
    filled: Vec<bool>,
}

enum RowFate {
    Blank,
    Included,
    BySelection,
    ByFilter,
}

fn plan<'a>(wb: &'a Workbook, q: &Query) -> Result<Plan<'a>, String> {
    let t = wb
        .table_by_name(&q.table)
        .or_else(|| q.table.trim().parse::<u32>().ok().and_then(|id| wb.table(id)))
        .ok_or_else(|| format!("no table named \"{}\"", q.table))?;
    if t.header_rows == 0 {
        return Err(format!("table \"{}\" has no header row to name its fields", t.name));
    }
    let col = |name: &str| -> Result<u32, String> {
        t.column_by_header(name)
            .ok_or_else(|| format!("\"{}\" is not a header of table \"{}\"", name, t.name))
    };
    let dims = q.dims.iter().map(|d| col(d)).collect::<Result<Vec<_>, _>>()?;
    let measures = resolve_measures(t, &q.measures)?;
    let mut sels: Vec<(u32, HashSet<Key>)> = vec![];
    for s in &q.selections {
        let c = col(&s.field)?;
        let keys: HashSet<Key> = s.values.iter().map(key_of).collect();
        match sels.iter_mut().find(|(sc, _)| *sc == c) {
            // two selections on one field: a row must match both
            Some((_, prev)) => prev.retain(|k| keys.contains(k)),
            None => sels.push((c, keys)),
        }
    }
    for k in &q.key {
        col(k)?;
    }
    let mut filled = vec![false; t.rows as usize];
    for (k, cell) in t.cells.iter() {
        let blank = match &cell.value {
            Value::Empty => true,
            Value::Text(x) => x.trim().is_empty(),
            _ => false,
        };
        if k.row < t.rows && !blank {
            filled[k.row as usize] = true;
        }
    }
    Ok(Plan {
        t,
        dims,
        measures,
        sels,
        respect_filters: q.respect_table_filters.unwrap_or(true),
        filled,
    })
}

impl Plan<'_> {
    fn fate(&self, r: u32) -> RowFate {
        let t = self.t;
        if !self.filled.get(r as usize).copied().unwrap_or(false) {
            return RowFate::Blank;
        }
        if self.respect_filters && t.is_row_hidden(r) {
            return RowFate::ByFilter;
        }
        for (c, keys) in &self.sels {
            if !keys.contains(&key_of(&t.value_at(CellKey::new(r, *c)))) {
                return RowFate::BySelection;
            }
        }
        RowFate::Included
    }
    fn fresh(&self) -> Vec<Acc> {
        vec![Acc::default(); self.measures.len()]
    }
    fn add(&self, accs: &mut [Acc], r: u32) {
        for (m, a) in self.measures.iter().zip(accs.iter_mut()) {
            m.add(a, self.t, r);
        }
    }
    fn results(&self, accs: &[Acc]) -> Vec<MeasureValue> {
        self.measures.iter().zip(accs.iter()).map(|(m, a)| m.result(a)).collect()
    }
}

/// Run an analytical query.
pub fn analyze(wb: &Workbook, q: &Query) -> Result<Answer, String> {
    let p = plan(wb, q)?;
    let t = p.t;
    struct G {
        key: Vec<Value>,
        first_row: u32,
        rows: u64,
        members: Vec<u32>,
        accs: Vec<Acc>,
    }
    let mut index: HashMap<Vec<Key>, usize> = HashMap::new();
    let mut groups: Vec<G> = vec![];
    let mut total = p.fresh();
    let mut excl = p.fresh();
    let (mut n_rows, mut blank, mut by_sel, mut by_filter) = (0u64, 0u64, 0u64, 0u64);
    for r in t.header_rows..t.rows {
        match p.fate(r) {
            RowFate::Blank => {
                blank += 1;
                continue;
            }
            RowFate::BySelection => {
                by_sel += 1;
                p.add(&mut excl, r);
            }
            RowFate::ByFilter => {
                by_filter += 1;
                p.add(&mut excl, r);
            }
            RowFate::Included => {
                let vals: Vec<Value> = p.dims.iter().map(|c| t.value_at(CellKey::new(r, *c))).collect();
                let k: Vec<Key> = vals.iter().map(key_of).collect();
                let gi = match index.get(&k) {
                    Some(i) => *i,
                    None => {
                        if groups.len() >= MAX_GROUPS {
                            return Err(format!("more than {} groups: choose a dimension with fewer distinct values", MAX_GROUPS));
                        }
                        groups.push(G {
                            key: vals,
                            first_row: r,
                            rows: 0,
                            members: vec![],
                            accs: p.fresh(),
                        });
                        index.insert(k, groups.len() - 1);
                        groups.len() - 1
                    }
                };
                let g = &mut groups[gi];
                g.rows += 1;
                if q.members {
                    g.members.push(r);
                }
                p.add(&mut g.accs, r);
                p.add(&mut total, r);
            }
        }
        n_rows += 1;
    }

    let mut out_groups: Vec<Group> = groups
        .iter()
        .map(|g| Group {
            label: p.dims.iter().zip(g.key.iter()).map(|(c, v)| label_of(t, g.first_row, *c, v)).collect(),
            key: g.key.clone(),
            rows: g.rows,
            members: if q.members { Some(g.members.clone()) } else { None },
            values: p.results(&g.accs),
        })
        .collect();
    let by_value = |a: &Group, b: &Group| -> Ordering {
        let va = a.values.first().and_then(|m| m.value);
        let vb = b.values.first().and_then(|m| m.value);
        match (va, vb) {
            (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        }
    };
    let by_key = |a: &Group, b: &Group| -> Ordering {
        for (x, y) in a.key.iter().zip(b.key.iter()) {
            // blanks last, as a "(blank)" bucket
            let o = match (x.is_empty(), y.is_empty()) {
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                _ => compare_values(x, y),
            };
            if o != Ordering::Equal {
                return o;
            }
        }
        Ordering::Equal
    };
    match q.sort.as_str() {
        "value_desc" => out_groups.sort_by(|a, b| {
            let o = by_value(a, b);
            // nulls stay last when reversing
            match (a.values.first().and_then(|m| m.value), b.values.first().and_then(|m| m.value)) {
                (Some(_), Some(_)) => o.reverse().then_with(|| by_key(a, b)),
                _ => o.then_with(|| by_key(a, b)),
            }
        }),
        "value_asc" => out_groups.sort_by(|a, b| by_value(a, b).then_with(|| by_key(a, b))),
        _ => out_groups.sort_by(by_key),
    }

    let totals = p.results(&total);
    let mut reconciliation = vec![];
    for (i, m) in p.measures.iter().enumerate() {
        if !m.info.additive {
            continue;
        }
        let tv = totals[i].value;
        let mut s = Sum::default();
        let mut complete = true;
        for g in &out_groups {
            match g.values[i].value {
                Some(v) => s.add(v),
                None if g.values[i].status == "no_data" => {}
                None => complete = false,
            }
        }
        let sum = if complete { Some(s.get()) } else { None };
        let status = match (tv, sum) {
            (Some(a), Some(b)) if numbers_equal(a, b) => "ok",
            (Some(_), Some(_)) => "differs",
            (None, Some(b)) if totals[i].status == "no_data" && b == 0.0 => "ok",
            _ => "not_assessable",
        };
        reconciliation.push(Reconciliation {
            measure: m.info.name.clone(),
            status,
            total: tv,
            sum_of_groups: sum,
        });
    }

    let mut issues = identity_issues(&p, q)?;
    for (i, m) in p.measures.iter().enumerate() {
        let mv = &totals[i];
        if mv.missing > 0 && !matches!(m.agg, Agg::Count | Agg::CountDistinct) {
            issues.push(Issue {
                kind: "missing_values",
                text: format!("{}: {} included row(s) have no value; they are left out, not counted as 0", m.info.name, mv.missing),
                rows: vec![],
                count: mv.missing,
            });
        }
        if mv.invalid > 0 {
            issues.push(Issue {
                kind: "invalid_values",
                text: format!("{}: {} included row(s) hold text or an error instead of a number", m.info.name, mv.invalid),
                rows: vec![],
                count: mv.invalid,
            });
        }
        if mv.status == "mixed_currency" {
            let list: Vec<String> = mv
                .by_currency
                .iter()
                .map(|c| if c.currency.is_empty() { "(no currency)".to_string() } else { c.currency.clone() })
                .collect();
            issues.push(Issue {
                kind: "mixed_currency",
                text: format!("{}: amounts in {} are not added together; convert them to one currency first", m.info.name, list.join(", ")),
                rows: vec![],
                count: mv.by_currency.len() as u64,
            });
        } else if m.currency.is_some() && mv.n > 0 && mv.currency.is_none() {
            issues.push(Issue {
                kind: "currency_missing",
                text: format!("{}: the currency column is blank for these amounts", m.info.name),
                rows: vec![],
                count: mv.n,
            });
        }
    }

    Ok(Answer {
        table: t.name.clone(),
        dims: p.dims.iter().map(|c| t.header_text(*c)).collect(),
        measures: p.measures.iter().map(|m| m.info.clone()).collect(),
        groups: out_groups,
        total: totals,
        excluded: Excluded {
            rows: by_sel + by_filter,
            by_selection: by_sel,
            by_table_filter: by_filter,
            values: p.results(&excl),
        },
        population: Population {
            rows: n_rows,
            included: n_rows - by_sel - by_filter,
            excluded: by_sel + by_filter,
            blank,
        },
        reconciliation,
        issues,
    })
}

/// Duplicate and blank identifiers over every non-blank data row (not only the
/// selected ones: a duplicate VIN is a data problem whatever the view).
fn identity_issues(p: &Plan, q: &Query) -> Result<Vec<Issue>, String> {
    let t = p.t;
    if q.key.is_empty() {
        return Ok(vec![]);
    }
    let cols: Vec<u32> = q
        .key
        .iter()
        .map(|k| t.column_by_header(k).ok_or_else(|| format!("key \"{}\" is not a header of table \"{}\"", k, t.name)))
        .collect::<Result<_, _>>()?;
    let mut seen: HashMap<Vec<Key>, Vec<u32>> = HashMap::new();
    let mut order: Vec<Vec<Key>> = vec![];
    let mut blank_rows: Vec<u32> = vec![];
    let mut blank_count = 0u64;
    for r in t.header_rows..t.rows {
        if matches!(p.fate(r), RowFate::Blank) {
            continue;
        }
        let k: Vec<Key> = cols.iter().map(|c| key_of(&t.value_at(CellKey::new(r, *c)))).collect();
        if k.iter().all(|x| *x == Key::Empty) {
            blank_count += 1;
            if blank_rows.len() < ISSUE_ROWS {
                blank_rows.push(r);
            }
            continue;
        }
        let e = seen.entry(k.clone()).or_default();
        if e.is_empty() {
            order.push(k);
        }
        e.push(r);
    }
    let mut out = vec![];
    if blank_count > 0 {
        out.push(Issue {
            kind: "blank_key",
            text: format!("{} row(s) have no {}", blank_count, q.key.join(" + ")),
            rows: blank_rows,
            count: blank_count,
        });
    }
    let mut dups = 0usize;
    for k in &order {
        let rows = &seen[k];
        if rows.len() < 2 {
            continue;
        }
        dups += 1;
        if out.len() >= MAX_ISSUES {
            continue;
        }
        let label: Vec<String> = cols.iter().map(|c| t.value_at(CellKey::new(rows[0], *c)).to_display()).collect();
        out.push(Issue {
            kind: "duplicate_key",
            text: format!("{} \"{}\" appears on {} rows", q.key.join(" + "), label.join(" · "), rows.len()),
            rows: rows.iter().take(ISSUE_ROWS).copied().collect(),
            count: rows.len() as u64,
        });
    }
    if dups > MAX_ISSUES {
        out.push(Issue {
            kind: "duplicate_key",
            text: format!("{} duplicated identifiers in all (the first {} are listed)", dups, MAX_ISSUES),
            rows: vec![],
            count: dups as u64,
        });
    }
    Ok(out)
}

/// The source records behind a selection: the rows a group (or a whole view) was
/// computed from, with the measures' totals over all of them.
pub fn records(wb: &Workbook, rq: &RecordsQuery) -> Result<Records, String> {
    let p = plan(wb, &rq.query)?;
    let t = p.t;
    let cols: Vec<u32> = if rq.fields.is_empty() {
        (0..t.cols).collect()
    } else {
        rq.fields
            .iter()
            .map(|f| t.column_by_header(f).ok_or_else(|| format!("\"{}\" is not a header of table \"{}\"", f, t.name)))
            .collect::<Result<_, _>>()?
    };
    let limit = rq.limit.unwrap_or(MAX_RECORDS).min(MAX_RECORDS);
    let mut total = p.fresh();
    let mut out = vec![];
    let mut count = 0u64;
    for r in t.header_rows..t.rows {
        let wanted = if rq.complement { RowFate::BySelection } else { RowFate::Included };
        if std::mem::discriminant(&p.fate(r)) != std::mem::discriminant(&wanted) {
            continue;
        }
        count += 1;
        p.add(&mut total, r);
        if out.len() < limit {
            out.push(Record {
                row: r,
                values: cols.iter().map(|c| t.value_at(CellKey::new(r, *c))).collect(),
            });
        }
    }
    Ok(Records {
        table: t.name.clone(),
        fields: cols.iter().map(|c| t.header_text(*c)).collect(),
        measures: p.measures.iter().map(|m| m.info.clone()).collect(),
        total: p.results(&total),
        count,
        truncated: (out.len() as u64) < count,
        records: out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, Op};

    /// A small inventory: VIN-003 is duplicated, VIN-005 has no landed cost, one row is in
    /// EUR, one value is text.
    fn book() -> Engine {
        let mut e = Engine::new(Workbook::new("t"));
        let rows: Vec<Vec<&str>> = vec![
            vec!["VIN", "Branch", "Brand", "Currency", "Landed cost", "Price", "Reserved"],
            vec!["VIN-001", "Luanda", "Toyota", "AOA", "100", "130", "No"],
            vec!["VIN-002", "Luanda", "Ford", "AOA", "200", "220", "Yes"],
            vec!["VIN-003", "Benguela", "Toyota", "AOA", "50", "80", "No"],
            vec!["VIN-003", "Benguela", "Toyota", "AOA", "50", "80", "No"],
            vec!["VIN-005", "Huambo", "Ford", "AOA", "", "90", "No"],
            vec!["VIN-006", "Huambo", "Kia", "EUR", "10", "12", "No"],
            vec!["VIN-007", "luanda", "Kia", "AOA", "n/a", "40", "No"],
            vec!["", "", "", "", "", "", ""],
        ];
        let values: Vec<Vec<String>> = rows.iter().map(|r| r.iter().map(|s| s.to_string()).collect()).collect();
        e.apply(Op::AddTable {
            id: None,
            name: Some("Stock".into()),
            x: 0.0,
            y: 0.0,
            rows: values.len() as u32,
            cols: 7,
            values: Some(values),
        });
        e
    }

    fn q(json: &str) -> Query {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn groups_by_canonical_value_and_reconciles() {
        let e = book();
        let a = analyze(&e.wb, &q(r#"{"table":"Stock","dims":["Branch"],"measures":[{"field":"Price","agg":"sum"},{"agg":"count"}],"members":true}"#)).unwrap();
        // "Luanda" and "luanda" are one branch (text compares ignoring case, as formulas do)
        let labels: Vec<&str> = a.groups.iter().map(|g| g.label[0].as_str()).collect();
        assert_eq!(labels, vec!["Benguela", "Huambo", "Luanda"]);
        let luanda = &a.groups[2];
        assert_eq!(luanda.values[0].value, Some(390.0));
        assert_eq!(luanda.members.as_deref(), Some(&[1u32, 2, 7][..]));
        assert_eq!(a.total[0].value, Some(652.0));
        assert_eq!(a.population.rows, 7);
        assert_eq!(a.population.blank, 1);
        assert!(a.reconciliation.iter().all(|r| r.status == "ok"));
    }

    #[test]
    fn missing_values_are_reported_not_zero() {
        let e = book();
        let a = analyze(&e.wb, &q(r#"{"table":"Stock","dims":["Brand"],"measures":[{"field":"Landed cost","agg":"sum"}]}"#)).unwrap();
        let ford = a.groups.iter().find(|g| g.label[0] == "Ford").unwrap();
        assert_eq!(ford.values[0].value, Some(200.0));
        assert_eq!(ford.values[0].status, "incomplete");
        assert_eq!(ford.values[0].missing, 1);
        let kia = a.groups.iter().find(|g| g.label[0] == "Kia").unwrap();
        assert_eq!(kia.values[0].invalid, 1);
        assert!(a.issues.iter().any(|i| i.kind == "missing_values" && i.count == 1));
        assert!(a.issues.iter().any(|i| i.kind == "invalid_values" && i.count == 1));
    }

    #[test]
    fn mixed_currencies_are_not_added() {
        let e = book();
        let a = analyze(&e.wb, &q(r#"{"table":"Stock","dims":["Branch"],"measures":[{"field":"Price","agg":"sum","currency":"Currency"}]}"#)).unwrap();
        let huambo = a.groups.iter().find(|g| g.label[0] == "Huambo").unwrap();
        assert_eq!(huambo.values[0].value, None);
        assert_eq!(huambo.values[0].status, "mixed_currency");
        assert_eq!(huambo.values[0].by_currency.len(), 2);
        let luanda = a.groups.iter().find(|g| g.label[0] == "Luanda").unwrap();
        assert_eq!(luanda.values[0].currency.as_deref(), Some("AOA"));
        assert_eq!(a.total[0].status, "mixed_currency");
        assert_eq!(a.reconciliation[0].status, "not_assessable");
    }

    #[test]
    fn ratio_is_computed_from_its_parts() {
        let e = book();
        // margin = Σ landed / Σ price over rows with both; an average of per-row ratios would differ
        let a = analyze(&e.wb, &q(r#"{"table":"Stock","dims":[],"measures":[{"agg":"ratio","numerator":"Landed cost","denominator":"Price"},{"agg":"average","field":"Landed cost"}]}"#)).unwrap();
        let g = &a.groups[0];
        let expected = (100.0 + 200.0 + 50.0 + 50.0 + 10.0) / (130.0 + 220.0 + 80.0 + 80.0 + 12.0);
        assert!((g.values[0].value.unwrap() - expected).abs() < 1e-12);
        assert_eq!(g.values[1].value, Some(82.0));
        assert!(!a.measures[0].additive && !a.measures[1].additive);
        assert!(a.reconciliation.is_empty());
    }

    #[test]
    fn selections_exclude_and_keep_the_excluded_visible() {
        let e = book();
        let a = analyze(&e.wb, &q(r#"{"table":"Stock","dims":["Brand"],"measures":[{"field":"Price","agg":"sum"}],"selections":[{"field":"Reserved","values":[{"s":"no"}]}]}"#)).unwrap();
        assert_eq!(a.excluded.by_selection, 1);
        assert_eq!(a.excluded.values[0].value, Some(220.0));
        assert_eq!(a.total[0].value, Some(432.0));
        // two values of one field: either matches
        let b = analyze(&e.wb, &q(r#"{"table":"Stock","dims":[],"measures":[{"agg":"count"}],"selections":[{"field":"Branch","values":[{"s":"Huambo"},{"s":"Benguela"}]}]}"#)).unwrap();
        assert_eq!(b.total[0].value, Some(4.0));
    }

    #[test]
    fn numbers_group_at_fifteen_digits() {
        let mut e = Engine::new(Workbook::new("t"));
        e.apply(Op::AddTable {
            id: None,
            name: Some("N".into()),
            x: 0.0,
            y: 0.0,
            rows: 3,
            cols: 2,
            values: Some(vec![vec!["K".into(), "V".into()], vec!["=0.1+0.2".into(), "1".into()], vec!["0.3".into(), "2".into()]]),
        });
        let a = analyze(&e.wb, &q(r#"{"table":"N","dims":["K"],"measures":[{"field":"V"}]}"#)).unwrap();
        assert_eq!(a.groups.len(), 1);
        assert_eq!(a.groups[0].values[0].value, Some(3.0));
        // a selection by the canonical value finds the computed one
        let b = analyze(&e.wb, &q(r#"{"table":"N","dims":[],"measures":[{"field":"V"}],"selections":[{"field":"K","values":[{"n":0.3}]}]}"#)).unwrap();
        assert_eq!(b.total[0].value, Some(3.0));
    }

    #[test]
    fn duplicate_and_blank_identifiers_are_reported() {
        let e = book();
        let a = analyze(&e.wb, &q(r#"{"table":"Stock","dims":[],"measures":[{"agg":"count"}],"key":["VIN"]}"#)).unwrap();
        let d = a.issues.iter().find(|i| i.kind == "duplicate_key").unwrap();
        assert_eq!(d.rows, vec![3, 4]);
        assert!(d.text.contains("VIN-003"));
    }

    #[test]
    fn table_filters_count_as_exclusions() {
        let mut e = book();
        e.apply(Op::SetFilters {
            table: e.wb.table_by_name("Stock").unwrap().id,
            filters: vec![crate::model::ColumnFilter {
                col: 1,
                values: Some(vec!["Luanda".into(), "luanda".into()]),
                ..Default::default()
            }],
        });
        let a = analyze(&e.wb, &q(r#"{"table":"Stock","dims":[],"measures":[{"field":"Price"}]}"#)).unwrap();
        assert_eq!(a.total[0].value, Some(390.0));
        assert_eq!(a.excluded.by_table_filter, 4);
        assert_eq!(a.excluded.values[0].value, Some(262.0));
        let b = analyze(&e.wb, &q(r#"{"table":"Stock","dims":[],"measures":[{"field":"Price"}],"respect_table_filters":false}"#)).unwrap();
        assert_eq!(b.total[0].value, Some(652.0));
    }

    #[test]
    fn records_behind_a_group_add_up_to_it() {
        let e = book();
        let r = records(&e.wb, &serde_json::from_str(r#"{"table":"Stock","measures":[{"field":"Price"}],"selections":[{"field":"Branch","values":[{"s":"Luanda"}]}],"fields":["VIN","Price"]}"#).unwrap()).unwrap();
        assert_eq!(r.count, 3);
        assert_eq!(r.records.iter().map(|x| x.row).collect::<Vec<_>>(), vec![1, 2, 7]);
        let s: f64 = r.records.iter().map(|x| if let Value::Number(n) = x.values[1] { n } else { 0.0 }).sum();
        assert_eq!(Some(s), r.total[0].value);
        let lim = records(&e.wb, &serde_json::from_str(r#"{"table":"Stock","limit":1}"#).unwrap()).unwrap();
        assert!(lim.truncated && lim.records.len() == 1 && lim.count == 7);
    }

    #[test]
    fn a_row_is_blank_only_when_every_cell_is_empty() {
        // VIN-005 has no landed cost: a query reading only that column must still count the row,
        // or a chart grouped by branch and its drill-through would count different rows
        let e = book();
        let a = analyze(&e.wb, &q(r#"{"table":"Stock","measures":[{"agg":"count"},{"field":"Landed cost"}]}"#)).unwrap();
        assert_eq!(a.population.rows, 7);
        assert_eq!(a.population.blank, 1);
        assert_eq!(a.total[0].value, Some(7.0));
        let r = records(&e.wb, &serde_json::from_str(r#"{"table":"Stock","measures":[{"agg":"count"}]}"#).unwrap()).unwrap();
        assert_eq!(r.count, 7);
    }

    #[test]
    fn the_excluded_records_can_be_listed() {
        let e = book();
        let sel = r#""selections":[{"field":"Branch","values":[{"s":"Luanda"}]}]"#;
        let inc = records(&e.wb, &serde_json::from_str(&format!(r#"{{"table":"Stock","measures":[{{"field":"Price"}}],{}}}"#, sel)).unwrap()).unwrap();
        let exc = records(&e.wb, &serde_json::from_str(&format!(r#"{{"table":"Stock","measures":[{{"field":"Price"}}],{},"complement":true}}"#, sel)).unwrap()).unwrap();
        let a = analyze(&e.wb, &q(&format!(r#"{{"table":"Stock","measures":[{{"field":"Price"}}],{}}}"#, sel))).unwrap();
        assert_eq!(exc.count, a.excluded.by_selection);
        assert_eq!(exc.total[0].value, a.excluded.values[0].value);
        assert_eq!(inc.count + exc.count, a.population.rows);
        assert!(exc.records.iter().all(|r| !inc.records.iter().any(|i| i.row == r.row)));
    }

    #[test]
    fn bad_queries_say_why() {
        let e = book();
        assert!(analyze(&e.wb, &q(r#"{"table":"Nope"}"#)).unwrap_err().contains("no table"));
        assert!(analyze(&e.wb, &q(r#"{"table":"Stock","dims":["Colour"]}"#)).unwrap_err().contains("Colour"));
        assert!(analyze(&e.wb, &q(r#"{"table":"Stock","measures":[{"field":"Price","agg":"median"}]}"#)).unwrap_err().contains("median"));
        assert!(analyze(&e.wb, &q(r#"{"table":"Stock","measures":[{"agg":"ratio","numerator":"Price"}]}"#)).unwrap_err().contains("denominator"));
    }

    #[test]
    fn queries_do_not_change_the_workbook() {
        let e = book();
        let before = serde_json::to_string(&e.wb).unwrap();
        let _ = analyze(&e.wb, &q(r#"{"table":"Stock","dims":["Branch"],"measures":[{"field":"Price"}],"selections":[{"field":"Brand","values":[{"s":"Kia"}]}]}"#)).unwrap();
        assert_eq!(serde_json::to_string(&e.wb).unwrap(), before);
    }
}
