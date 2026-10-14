//! Decomposition tree (roadmap 7.4): one measure broken down by a dimension chosen per node.
//!
//! * **Siblings by value.** A node's children are ordered by the measure's value (15 significant
//!   digits, then the canonical key), so a cross-filter or a reordered table never swaps two
//!   equal items. When the node mixes currencies the amounts cannot be compared and the
//!   children are ordered by key instead (`sort: "key"`).
//! * **Top N, then "Other (k)" and "(blank)".** The first N children are named (10 by default,
//!   as in Power BI's decomposition tree); the rest are folded into one "Other (k)" node whose
//!   value is computed from its own rows (never parent − shown, never an average of averages).
//!   A single leftover is named instead of "Other (1)"; a child that an open split goes through
//!   is kept named ("pinned"); the blank bucket is never folded and is always last.
//! * **Reconciled at every level.** Each split says whether its children add up to the node
//!   (additive measures, per currency when currencies mix), whether the rows partition it, and,
//!   for ratios and averages, whether numerators and denominators add up.
//! * **Suggested split.** Optionally, a deterministic, explained suggestion for the next field
//!   at one node ("high value" or "relative"); never applied by the engine.
//!
//! Reads the workbook only: no operation, no recalculation (`analyze` and `records` are
//! unchanged). Every node carries the selections that list exactly its rows through
//! `analytic::records`.

use crate::analytic::{
    identity_issues, key_of, label_of, measure_issues, plan, Acc, Agg, Excluded, Issue, Key, Measure, MeasureInfo,
    MeasureSpec, MeasureValue, Population, Query, RowFate, Selection, Sum,
};
use crate::formula::eval::compare_values;
use crate::formula::numerics::{number_key, numbers_equal};
use crate::model::{CellKey, Table, Value, Workbook};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// Children named per node unless the request asks otherwise. Power BI's decomposition tree
/// shows the top 10 values of a level by default (Microsoft Learn, "Create and view
/// decomposition tree visuals in Power BI", read 2026-10-13).
pub const DEFAULT_TOP_N: usize = 10;
pub const MAX_TOP_N: usize = 50;
/// Steps on a path.
pub const MAX_DECOMP_DEPTH: usize = 12;
/// Explicit splits per request.
pub const MAX_DECOMP_SPLITS: usize = 200;
/// Nodes emitted (Power BI shows at most 5,000 data points in the visual).
pub const MAX_DECOMP_NODES: usize = 5_000;
/// Canonical keys emitted in all node selections.
pub const MAX_DECOMP_KEYS: usize = 50_000;
pub const MAX_SUGGEST_FIELDS: usize = 32;
/// A suggestion candidate with more distinct values is skipped.
pub const MAX_SUGGEST_ITEMS: usize = 100;
/// Row visits: scan + Σ split node rows + Σ suggestion node rows × candidates.
pub const MAX_DECOMP_WORK: u64 = 5_000_000;

// ---------------------------------------------------------------------------------------
// request

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct Step {
    pub field: String,
    /// Canonical value of the child (`{"s":"Luanda"}`); null = (blank). Ignored when `other`.
    pub key: Value,
    pub other: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SplitSpec {
    pub path: Vec<Step>,
    pub field: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SuggestSpec {
    /// The node to suggest a split for.
    pub at: Vec<Step>,
    /// "" | "high_value" (default) | "relative"
    pub rule: String,
    /// Explicit candidates in this order; empty = automatic.
    pub fields: Vec<String>,
    /// Default 1 for an additive measure, 5 otherwise.
    pub min_rows: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct DecompQuery {
    pub table: String,
    pub measure: MeasureSpec,
    /// Starting filter (a chart's record selections).
    pub selections: Vec<Selection>,
    pub respect_table_filters: Option<bool>,
    /// Identifier columns: reported as issues; never a suggestion candidate.
    pub key: Vec<String>,
    /// Default 10; 0 or more than 50 is an error.
    pub top_n: Option<usize>,
    pub splits: Vec<SplitSpec>,
    /// None = no suggestion work.
    pub suggest: Option<SuggestSpec>,
}

// ---------------------------------------------------------------------------------------
// response

#[derive(Clone, Debug, Serialize)]
pub struct Parts {
    /// ratio: Σ numerator, Σ denominator; average: Σ values, n
    pub numerator: f64,
    pub denominator: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Node {
    /// "r" + per step "/" + field_lower + "=" + keyid
    /// (keyid ∈ n:<number_key> | s:<lower text> | b:true|false | e:<error> | blank | other).
    pub id: String,
    /// root | value | other | blank
    pub kind: &'static str,
    pub label: String,
    pub key: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub k: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub folded: Vec<Value>,
    pub rank: Option<u32>,
    /// Shown named only because a split's path goes through it.
    pub pinned: bool,
    pub path: Vec<Step>,
    /// The request's selections plus one per step: exactly this node's rows through `records`.
    pub selections: Vec<Selection>,
    pub rows: u64,
    pub value: MeasureValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts: Option<Parts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split: Option<Split>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Split {
    /// The header as written in the table.
    pub field: String,
    /// Distinct non-blank values under the node.
    pub items: u32,
    /// "value_desc" | "key" (when the node mixes currencies)
    pub sort: &'static str,
    pub mixed_signs: bool,
    /// Named (rank order, pinned ones at their rank) → Other → (blank).
    pub children: Vec<Node>,
    pub check: Check,
}

#[derive(Clone, Debug, Serialize)]
pub struct CurrencyCheck {
    pub currency: String,
    pub parent: f64,
    pub sum_of_children: f64,
    pub status: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct Check {
    /// "sum" | "children_do_not_sum"
    pub kind: &'static str,
    /// sum: ok | differs | not_assessable; children_do_not_sum: recomputed
    pub status: &'static str,
    pub parent: Option<f64>,
    pub sum_of_children: Option<f64>,
    pub rows_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts_ok: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub by_currency: Vec<CurrencyCheck>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub field: String,
    pub score: Option<f64>,
    pub items: u32,
    pub node: Option<String>,
    pub node_key: Option<Value>,
    pub value: Option<f64>,
    /// Relative rule only.
    pub mean: Option<f64>,
    pub skipped: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Suggestion {
    pub at: Vec<Step>,
    pub node_id: String,
    pub rule: &'static str,
    pub rule_text: &'static str,
    pub field: Option<String>,
    pub best: Option<Candidate>,
    pub runner_up: Option<Candidate>,
    /// Ranked eligible candidates first, then the skipped ones in candidate order.
    pub candidates: Vec<Candidate>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Unresolved {
    pub path: Vec<Step>,
    pub field: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Tree {
    pub table: String,
    pub measure: MeasureInfo,
    pub top_n: usize,
    pub root: Node,
    pub excluded: Excluded,
    pub population: Population,
    pub issues: Vec<Issue>,
    pub unresolved: Vec<Unresolved>,
    pub suggestion: Option<Suggestion>,
}

// ---------------------------------------------------------------------------------------
// limits (a struct so tests can exercise the budget paths on small tables)

#[derive(Clone, Copy)]
struct Limits {
    nodes: usize,
    keys: usize,
    work: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            nodes: MAX_DECOMP_NODES,
            keys: MAX_DECOMP_KEYS,
            work: MAX_DECOMP_WORK,
        }
    }
}

fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

// ---------------------------------------------------------------------------------------
// ordering

/// A number at 15 significant digits, the precision Excel keeps (Microsoft, "Floating-point
/// arithmetic may give inaccurate results in Excel"): a last-unit difference in a compensated
/// sum cannot swap two siblings when the rows come in another order.
fn round15(x: f64) -> f64 {
    number_key(x).parse::<f64>().unwrap_or(x)
}

/// Sibling order (a total order): value class (a number first), the value at 15 digits
/// descending, the first row's key ascending, the canonical key's text. `by_value` false
/// (a node that mixes currencies) orders by key only.
fn sibling_order(by_value: bool, a: (Option<f64>, &Value, &Key), b: (Option<f64>, &Value, &Key)) -> Ordering {
    let o = if by_value {
        match (a.0, b.0) {
            (Some(x), Some(y)) => round15(y).total_cmp(&round15(x)),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        }
    } else {
        Ordering::Equal
    };
    o.then_with(|| compare_values(a.1, b.1)).then_with(|| format!("{:?}", a.2).cmp(&format!("{:?}", b.2)))
}

fn keyid(k: &Key) -> String {
    match k {
        Key::Empty => "blank".into(),
        Key::Number(s) => format!("n:{}", s),
        Key::Text(s) => format!("s:{}", s),
        Key::Bool(b) => format!("b:{}", b),
        Key::Error(e) => format!("e:{}", e),
    }
}

/// '%', '/' and '=' escaped, so the text of a header or a key cannot read as another step.
fn esc(s: &str) -> String {
    s.replace('%', "%25").replace('/', "%2F").replace('=', "%3D")
}

fn id_step(field: &str, kid: &str) -> String {
    format!("/{}={}", esc(&field.trim().to_lowercase()), esc(kid))
}

fn id_of(t: &Table, heads: &Heads, path: &[Step]) -> String {
    let mut id = String::from("r");
    for s in path {
        let field = heads.col(&s.field).map(|c| t.header_text(c)).unwrap_or_else(|| s.field.clone());
        let kid = if s.other { "other".to_string() } else { keyid(&key_of(&s.key)) };
        id.push_str(&id_step(&field, &kid));
    }
    id
}

/// Header → first column with that header (trimmed, case-insensitive), built once per request:
/// the same answer as `Table::column_by_header`, without a scan of every column per lookup.
struct Heads {
    first: HashMap<String, u32>,
}

impl Heads {
    fn new(t: &Table) -> Heads {
        let mut first = HashMap::new();
        if t.header_rows > 0 {
            for c in 0..t.cols {
                let h = t.header_text(c).trim().to_lowercase();
                if !h.is_empty() {
                    first.entry(h).or_insert(c);
                }
            }
        }
        Heads { first }
    }
    fn col(&self, name: &str) -> Option<u32> {
        self.first.get(&name.trim().to_lowercase()).copied()
    }
}

/// A step reduced to what identifies it: the column (or the field text when it is not a header),
/// Other, and the canonical key.
#[derive(Clone, PartialEq, Eq, Hash)]
enum FieldId {
    Col(u32),
    Name(String),
}

type StepSig = (FieldId, bool, Option<Key>);

fn sig_of(heads: &Heads, path: &[Step]) -> Vec<StepSig> {
    path.iter()
        .map(|s| {
            let f = match heads.col(&s.field) {
                Some(c) => FieldId::Col(c),
                None => FieldId::Name(s.field.trim().to_lowercase()),
            };
            (f, s.other, if s.other { None } else { Some(key_of(&s.key)) })
        })
        .collect()
}

// ---------------------------------------------------------------------------------------
// grouping

struct Bucket {
    raw: Value,
    first_row: u32,
    rows: Vec<u32>,
    acc: Acc,
}

struct Grouped {
    /// Non-blank buckets in first-row order.
    named: Vec<(Key, Bucket)>,
    blank: Option<Bucket>,
}

/// Group `rows` by the canonical value of column `col`; `Err` once there are more than `cap`
/// non-blank values.
fn group(t: &Table, m: &Measure, rows: &[u32], col: u32, cap: usize) -> Result<Grouped, ()> {
    let mut index: HashMap<Key, usize> = HashMap::new();
    let mut named: Vec<(Key, Bucket)> = vec![];
    let mut blank: Option<Bucket> = None;
    for &r in rows {
        let v = t.value_at(CellKey::new(r, col));
        let k = key_of(&v);
        let b = if k == Key::Empty {
            blank.get_or_insert_with(|| Bucket {
                raw: Value::Empty,
                first_row: r,
                rows: vec![],
                acc: Acc::default(),
            })
        } else {
            let i = match index.get(&k) {
                Some(i) => *i,
                None => {
                    if named.len() >= cap {
                        return Err(());
                    }
                    named.push((
                        k.clone(),
                        Bucket {
                            raw: v,
                            first_row: r,
                            rows: vec![],
                            acc: Acc::default(),
                        },
                    ));
                    index.insert(k, named.len() - 1);
                    named.len() - 1
                }
            };
            &mut named[i].1
        };
        b.rows.push(r);
        m.add(&mut b.acc, t, r);
    }
    Ok(Grouped { named, blank })
}

// ---------------------------------------------------------------------------------------
// the tree under construction

struct WSplit {
    col: u32,
    field: String,
    items: u32,
    sort: &'static str,
    mixed_signs: bool,
    children: Vec<usize>,
    other: Option<usize>,
    check: Check,
}

struct W {
    kind: &'static str,
    label: String,
    key: Option<Value>,
    /// canonical key of a value or blank child
    ckey: Option<Key>,
    k: Option<u32>,
    folded: Vec<Value>,
    rank: Option<u32>,
    pinned: bool,
    path: Vec<Step>,
    /// values in this node's selections
    nkeys: usize,
    rows: Vec<u32>,
    acc: Acc,
    value: MeasureValue,
    share: Option<f64>,
    split: Option<WSplit>,
}

fn parts_of(m: &Measure, w: &W) -> Option<Parts> {
    if w.value.status == "mixed_currency" {
        return None;
    }
    match m.agg {
        Agg::Ratio => Some(Parts {
            numerator: w.acc.sum.get(),
            denominator: w.acc.den.get(),
        }),
        Agg::Average => Some(Parts {
            numerator: w.acc.sum.get(),
            denominator: w.acc.n as f64,
        }),
        _ => None,
    }
}

fn agg_text(a: Agg) -> &'static str {
    match a {
        Agg::Ratio => "ratio",
        Agg::Average => "average",
        Agg::CountDistinct => "distinct count",
        Agg::Min => "min",
        Agg::Max => "max",
        Agg::Sum => "sum",
        Agg::Count => "count",
    }
}

/// Reconciliation of one split: rows partition the node; an additive measure's children add up
/// to it (per currency when currencies mix); a ratio's or average's parts add up.
fn check_of(m: &Measure, parent: &W, children: &[&W]) -> Check {
    let rows_ok = children.iter().map(|c| c.rows.len()).sum::<usize>() == parent.rows.len();
    if !m.info.additive {
        let parts_ok = match m.agg {
            Agg::Ratio | Agg::Average => {
                let mut num = Sum::default();
                let mut den = Sum::default();
                let mut n = 0u64;
                // the children's compensated parts (s and c), as Acc::merge adds them: their
                // rounded totals would differ from the parent's beyond 15 digits whenever large
                // children nearly cancel
                for c in children {
                    num.add(c.acc.sum.s);
                    num.add(c.acc.sum.c);
                    den.add(c.acc.den.s);
                    den.add(c.acc.den.c);
                    n += c.acc.n;
                }
                let den_ok = if m.agg == Agg::Ratio { numbers_equal(den.get(), parent.acc.den.get()) } else { n == parent.acc.n };
                Some(numbers_equal(num.get(), parent.acc.sum.get()) && den_ok)
            }
            _ => None,
        };
        return Check {
            kind: "children_do_not_sum",
            status: "recomputed",
            parent: parent.value.value,
            sum_of_children: None,
            rows_ok,
            parts_ok,
            by_currency: vec![],
            text: format!("children do not sum to parent ({})", agg_text(m.agg)),
        };
    }
    if parent.value.status == "mixed_currency" {
        let mut by_currency = vec![];
        for (code, (ps, _)) in &parent.acc.by_currency {
            let mut s = Sum::default();
            for c in children {
                if let Some((cs, _)) = c.acc.by_currency.get(code) {
                    s.add(cs.s);
                    s.add(cs.c);
                }
            }
            let (a, b) = (ps.get(), s.get());
            by_currency.push(CurrencyCheck {
                currency: code.clone(),
                parent: a,
                sum_of_children: b,
                status: if numbers_equal(a, b) { "ok" } else { "differs" },
            });
        }
        let ok = by_currency.iter().all(|c| c.status == "ok");
        return Check {
            kind: "sum",
            status: if ok { "ok" } else { "not_assessable" },
            parent: None,
            sum_of_children: None,
            rows_ok,
            parts_ok: None,
            by_currency,
            text: if ok {
                "children add up to the parent in each currency".into()
            } else {
                "cannot be checked as one amount: amounts in different currencies".into()
            },
        };
    }
    let mut s = Sum::default();
    let mut complete = true;
    for c in children {
        match c.value.value {
            // a sum's value is its compensated Σ: add its parts, not the rounded total
            Some(_) if m.agg == Agg::Sum => {
                s.add(c.acc.sum.s);
                s.add(c.acc.sum.c);
            }
            Some(v) => s.add(v),
            None if c.value.status == "no_data" => {}
            None => complete = false,
        }
    }
    let sum = if complete { Some(s.get()) } else { None };
    let pv = parent.value.value;
    let status = match (pv, sum) {
        (Some(a), Some(b)) if numbers_equal(a, b) => "ok",
        (Some(_), Some(_)) => "differs",
        (None, Some(b)) if parent.value.status == "no_data" && b == 0.0 => "ok",
        _ => "not_assessable",
    };
    let text = match status {
        "ok" => "children add up to the parent".to_string(),
        "differs" => "children do not add up to the parent".to_string(),
        _ => "cannot be checked: a child has no single value".to_string(),
    };
    Check {
        kind: "sum",
        status,
        parent: pv,
        sum_of_children: sum,
        rows_ok,
        parts_ok: None,
        by_currency: vec![],
        text,
    }
}

/// The arena index of the node a path leads to, or why it no longer exists.
fn resolve(heads: &Heads, arena: &[W], path: &[Step], top_n: usize) -> Result<usize, String> {
    let mut cur = 0usize;
    for (i, step) in path.iter().enumerate() {
        let last = i + 1 == path.len();
        let fail = |reason: String| if last { reason } else { "its parent is no longer in the tree".to_string() };
        let col = heads.col(&step.field);
        let sp = match &arena[cur].split {
            Some(sp) if Some(sp.col) == col => sp,
            _ => return Err(fail(format!("this node is not split by {}", step.field.trim()))),
        };
        if step.other {
            match sp.other {
                Some(o) => cur = o,
                None => return Err(fail(format!("there is no Other node under {}: {} values, top {}", sp.field, sp.items, top_n))),
            }
        } else {
            let k = key_of(&step.key);
            match sp.children.iter().find(|&&c| arena[c].ckey.as_ref() == Some(&k)) {
                Some(&c) => cur = c,
                None => {
                    let label = if k == Key::Empty { "(blank)".to_string() } else { step.key.to_display() };
                    // folded into Other (a cross-filter or a lower top N moved it past rank N)
                    if let Some(o) = sp.other.filter(|&o| arena[o].folded.iter().any(|v| key_of(v) == k)) {
                        return Err(fail(format!(
                            "{} is now inside {} under {}, outside the top {}",
                            label, arena[o].label, sp.field, top_n
                        )));
                    }
                    return Err(fail(format!("{} is no longer under {} (filtered out or changed)", label, sp.field)));
                }
            }
        }
    }
    Ok(cur)
}

// ---------------------------------------------------------------------------------------
// decompose

/// Build a decomposition tree. Reads only.
pub fn decompose(wb: &Workbook, q: &DecompQuery) -> Result<Tree, String> {
    decompose_with(wb, q, Limits::default())
}

fn decompose_with(wb: &Workbook, q: &DecompQuery, lim: Limits) -> Result<Tree, String> {
    let top_n = q.top_n.unwrap_or(DEFAULT_TOP_N);
    if top_n == 0 || top_n > MAX_TOP_N {
        return Err(format!("top_n must be between 1 and {}", MAX_TOP_N));
    }
    if q.splits.len() > MAX_DECOMP_SPLITS {
        return Err(format!("at most {} splits per breakdown", MAX_DECOMP_SPLITS));
    }
    let too_deep = |p: &[Step]| p.len() > MAX_DECOMP_DEPTH;
    if q.splits.iter().any(|s| too_deep(&s.path)) || q.suggest.as_ref().is_some_and(|s| too_deep(&s.at)) {
        return Err(format!("a breakdown path has at most {} steps", MAX_DECOMP_DEPTH));
    }
    let aq = Query {
        table: q.table.clone(),
        measures: vec![q.measure.clone()],
        selections: q.selections.clone(),
        key: q.key.clone(),
        respect_table_filters: q.respect_table_filters,
        ..Default::default()
    };
    let p = plan(wb, &aq)?;
    let t = p.t;
    let m = &p.measures[0];
    // every header lookup and path comparison below goes through this map and these signatures,
    // so their cost does not grow with the number of columns times the number of splits
    let heads = Heads::new(t);
    let col_of = |name: &str| -> Result<u32, String> {
        heads.col(name).ok_or_else(|| format!("\"{}\" is not a header of table \"{}\"", name, t.name))
    };
    let mut split_cols = vec![];
    let mut sigs: Vec<Vec<StepSig>> = vec![];
    let mut seen: HashSet<Vec<StepSig>> = HashSet::new();
    for s in &q.splits {
        let c = col_of(&s.field)?;
        let sig = sig_of(&heads, &s.path);
        if sig.iter().any(|st| st.0 == FieldId::Col(c)) {
            return Err(format!("\"{}\" is already on this node's path", t.header_text(c)));
        }
        split_cols.push(c);
        sigs.push(sig);
    }
    for sig in &sigs {
        if !seen.insert(sig.clone()) {
            return Err("two splits for one node".into());
        }
    }
    // the suggestion's request is validated before any work
    let rule = match &q.suggest {
        None => "",
        Some(s) => match s.rule.trim().to_lowercase().as_str() {
            "" | "high_value" => "high_value",
            "relative" => "relative",
            other => return Err(format!("unknown suggestion rule \"{}\" (high_value, relative)", other)),
        },
    };
    let mut explicit: Vec<u32> = vec![];
    if let Some(s) = &q.suggest {
        if s.fields.len() > MAX_SUGGEST_FIELDS {
            return Err(format!("at most {} candidate fields", MAX_SUGGEST_FIELDS));
        }
        for f in &s.fields {
            let c = col_of(f)?;
            if !explicit.contains(&c) {
                explicit.push(c);
            }
        }
    }

    // population: one scan, counted exactly as `analyze` counts it
    let mut work: u64 = 0;
    let mut root_rows: Vec<u32> = vec![];
    let mut root_acc = Acc::default();
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
                root_rows.push(r);
                m.add(&mut root_acc, t, r);
            }
        }
        n_rows += 1;
    }
    work += (t.rows - t.header_rows.min(t.rows)) as u64;
    let work_error = || {
        format!(
            "this breakdown would read more than {} rows: collapse a level or choose fewer fields",
            thousands(lim.work)
        )
    };
    let root_value = m.result(&root_acc);
    let mut arena: Vec<W> = vec![W {
        kind: "root",
        label: String::new(),
        key: None,
        ckey: None,
        k: None,
        folded: vec![],
        rank: None,
        pinned: false,
        path: vec![],
        nkeys: q.selections.iter().map(|s| s.values.len()).sum(),
        rows: root_rows,
        acc: root_acc,
        value: root_value.clone(),
        share: None,
        split: None,
    }];

    // splits, breadth-first (stable by path length)
    let mut order: Vec<usize> = (0..q.splits.len()).collect();
    order.sort_by_key(|&i| q.splits[i].path.len());
    let mut unresolved = vec![];
    for si in order {
        let s = &q.splits[si];
        let col = split_cols[si];
        let header = t.header_text(col);
        let ni = match resolve(&heads, &arena, &s.path, top_n) {
            Ok(n) => n,
            Err(reason) => {
                unresolved.push(Unresolved {
                    path: s.path.clone(),
                    field: header,
                    reason,
                });
                continue;
            }
        };
        if arena[ni].split.is_some() {
            return Err("two splits for one node".into());
        }
        work += arena[ni].rows.len() as u64;
        if work > lim.work {
            return Err(work_error());
        }
        split_node(t, m, &heads, &sigs, &mut arena, ni, col, header, top_n)?;
        if arena.len() > lim.nodes {
            return Err(format!(
                "the tree would show more than {} items: collapse a level or lower top N",
                thousands(lim.nodes as u64)
            ));
        }
    }
    let keys: usize = arena.iter().map(|w| w.nkeys).sum();
    if keys > lim.keys {
        return Err(format!(
            "the breakdown would list more than {} values: lower top N or split by a field with fewer values",
            thousands(lim.keys as u64)
        ));
    }

    let suggestion = match &q.suggest {
        None => None,
        Some(s) => Some(suggest(t, m, &heads, q, s, rule, &explicit, &arena, top_n, &mut work, lim)),
    };

    let mut issues = identity_issues(&p, &aq)?;
    issues.extend(measure_issues(&p, std::slice::from_ref(&root_value)));
    let root = emit(m, &arena, 0, &q.selections);
    Ok(Tree {
        table: t.name.clone(),
        measure: m.info.clone(),
        top_n,
        root,
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
        issues,
        unresolved,
        suggestion,
    })
}

#[allow(clippy::too_many_arguments)]
fn split_node(
    t: &Table,
    m: &Measure,
    heads: &Heads,
    sigs: &[Vec<StepSig>],
    arena: &mut Vec<W>,
    ni: usize,
    col: u32,
    header: String,
    top_n: usize,
) -> Result<(), String> {
    let rows = arena[ni].rows.clone();
    let g = group(t, m, &rows, col, crate::analytic::MAX_GROUPS).map_err(|_| {
        format!(
            "more than {} values under one node: choose a field with fewer values",
            crate::analytic::MAX_GROUPS
        )
    })?;
    let by_value = arena[ni].value.status != "mixed_currency";
    let mut named: Vec<(Key, Bucket, MeasureValue)> = g
        .named
        .into_iter()
        .map(|(k, b)| {
            let v = m.result(&b.acc);
            (k, b, v)
        })
        .collect();
    named.sort_by(|a, b| sibling_order(by_value, (a.2.value, &a.1.raw, &a.0), (b.2.value, &b.1.raw, &b.0)));
    let items = named.len();

    // children an open split goes through stay named, whatever their rank
    let depth = arena[ni].path.len();
    let mut pinned: HashSet<Key> = HashSet::new();
    let here = sig_of(heads, &arena[ni].path);
    for s in sigs {
        if s.len() > depth && s[..depth] == here[..] {
            if let (FieldId::Col(c), false, Some(k)) = &s[depth] {
                if *c == col {
                    pinned.insert(k.clone());
                }
            }
        }
    }
    let rest: Vec<usize> = (top_n..items).filter(|&i| !pinned.contains(&named[i].0)).collect();
    let fold: HashSet<usize> = if rest.len() >= 2 { rest.iter().copied().collect() } else { HashSet::new() };

    let parent_path = arena[ni].path.clone();
    let parent_keys = arena[ni].nkeys;
    let mut news: Vec<W> = vec![];
    let mut other_acc = Acc::default();
    let mut other_rows: Vec<u32> = vec![];
    let mut folded: Vec<Value> = vec![];
    for (i, (k, b, v)) in named.into_iter().enumerate() {
        if fold.contains(&i) {
            other_acc.merge(&b.acc);
            other_rows.extend_from_slice(&b.rows);
            folded.push(b.raw);
            continue;
        }
        let mut path = parent_path.clone();
        path.push(Step {
            field: header.clone(),
            key: b.raw.clone(),
            other: false,
        });
        news.push(W {
            kind: "value",
            label: label_of(t, b.first_row, col, &b.raw),
            key: Some(b.raw),
            pinned: i >= top_n && pinned.contains(&k),
            ckey: Some(k),
            k: None,
            folded: vec![],
            rank: Some(i as u32 + 1),
            path,
            nkeys: parent_keys + 1,
            rows: b.rows,
            acc: b.acc,
            value: v,
            share: None,
            split: None,
        });
    }
    let mut has_other = false;
    if !folded.is_empty() {
        has_other = true;
        other_rows.sort_unstable();
        let mut path = parent_path.clone();
        path.push(Step {
            field: header.clone(),
            key: Value::Empty,
            other: true,
        });
        let value = m.result(&other_acc);
        news.push(W {
            kind: "other",
            label: format!("Other ({})", folded.len()),
            key: None,
            ckey: None,
            k: Some(folded.len() as u32),
            nkeys: parent_keys + folded.len(),
            folded,
            rank: None,
            pinned: false,
            path,
            rows: other_rows,
            acc: other_acc,
            value,
            share: None,
            split: None,
        });
    }
    if let Some(b) = g.blank {
        let mut path = parent_path.clone();
        path.push(Step {
            field: header.clone(),
            key: Value::Empty,
            other: false,
        });
        let value = m.result(&b.acc);
        news.push(W {
            kind: "blank",
            label: "(blank)".into(),
            key: Some(Value::Empty),
            ckey: Some(Key::Empty),
            k: None,
            folded: vec![],
            rank: None,
            pinned: false,
            path,
            nkeys: parent_keys + 1,
            rows: b.rows,
            acc: b.acc,
            value,
            share: None,
            split: None,
        });
    }

    // shares only for an additive measure over a positive parent with no negative sibling
    let mixed_signs = news.iter().any(|w| w.value.value.is_some_and(|v| v < 0.0));
    let pv = arena[ni].value.value;
    if m.info.additive && !mixed_signs {
        if let Some(pv) = pv.filter(|p| *p > 0.0) {
            for w in news.iter_mut() {
                w.share = w.value.value.map(|v| v / pv);
            }
        }
    }
    let check = {
        let refs: Vec<&W> = news.iter().collect();
        check_of(m, &arena[ni], &refs)
    };
    let first = arena.len();
    let n_children = news.len();
    arena.extend(news);
    let children: Vec<usize> = (first..first + n_children).collect();
    let other = if has_other { children.iter().copied().find(|&c| arena[c].kind == "other") } else { None };
    arena[ni].split = Some(WSplit {
        col,
        field: header,
        items: items as u32,
        sort: if by_value { "value_desc" } else { "key" },
        mixed_signs,
        children,
        other,
        check,
    });
    Ok(())
}

fn emit(m: &Measure, arena: &[W], i: usize, selections: &[Selection]) -> Node {
    let w = &arena[i];
    let split = w.split.as_ref().map(|sp| Split {
        field: sp.field.clone(),
        items: sp.items,
        sort: sp.sort,
        mixed_signs: sp.mixed_signs,
        children: sp
            .children
            .iter()
            .map(|&c| {
                let cw = &arena[c];
                let step = cw.path.last().expect("a child has a step");
                let values = match cw.kind {
                    "other" => cw.folded.clone(),
                    _ => vec![step.key.clone()],
                };
                let mut sels = selections.to_vec();
                sels.push(Selection {
                    field: step.field.clone(),
                    values,
                });
                emit(m, arena, c, &sels)
            })
            .collect(),
        check: sp.check.clone(),
    });
    Node {
        id: id_from_node_path(&w.path),
        kind: w.kind,
        label: w.label.clone(),
        key: w.key.clone(),
        k: w.k,
        folded: w.folded.clone(),
        rank: w.rank,
        pinned: w.pinned,
        path: w.path.clone(),
        selections: selections.to_vec(),
        rows: w.rows.len() as u64,
        value: w.value.clone(),
        parts: parts_of(m, w),
        share: w.share,
        split,
    }
}

/// Node paths carry the header as written, so no table lookup is needed.
fn id_from_node_path(path: &[Step]) -> String {
    let mut id = String::from("r");
    for s in path {
        let kid = if s.other { "other".to_string() } else { keyid(&key_of(&s.key)) };
        id.push_str(&id_step(&s.field, &kid));
    }
    id
}

// ---------------------------------------------------------------------------------------
// suggested split

const HIGH_VALUE_TEXT: &str = "highest value of a single item";
/// Power BI's "relative" AI split: a node's value against the absolute average of its
/// siblings (Microsoft Learn, "Create and view decomposition tree visuals in Power BI",
/// read 2026-10-13).
const RELATIVE_TEXT: &str = "largest ratio of an item to its siblings' mean";

fn num(x: f64) -> String {
    Value::Number(x).to_display()
}

#[allow(clippy::too_many_arguments)]
fn suggest(
    t: &Table,
    m: &Measure,
    heads: &Heads,
    q: &DecompQuery,
    s: &SuggestSpec,
    rule: &'static str,
    explicit: &[u32],
    arena: &[W],
    top_n: usize,
    work: &mut u64,
    lim: Limits,
) -> Suggestion {
    let rule_text = if rule == "relative" { RELATIVE_TEXT } else { HIGH_VALUE_TEXT };
    let mut out = Suggestion {
        at: s.at.clone(),
        node_id: id_of(t, heads, &s.at),
        rule,
        rule_text,
        field: None,
        best: None,
        runner_up: None,
        candidates: vec![],
        text: String::new(),
    };
    let ni = match resolve(heads, arena, &s.at, top_n) {
        Ok(n) => n,
        Err(reason) => {
            out.text = format!("No split suggested: this node is no longer in the tree ({})", reason);
            return out;
        }
    };
    let node = &arena[ni];
    out.node_id = id_from_node_path(&node.path);
    // amounts in different currencies cannot be ranked against each other (1,000,000 AOA is not
    // "more" than 500 EUR): no suggestion here, and the currency column is the way forward
    if node.value.status == "mixed_currency" {
        let codes: Vec<String> = node
            .value
            .by_currency
            .iter()
            .map(|c| if c.currency.is_empty() { "(none)".to_string() } else { c.currency.clone() })
            .collect();
        let cur_field = m.currency.map(|c| t.header_text(c)).unwrap_or_default();
        out.text = format!(
            "No split suggested: the amounts under this node are in different currencies ({}), so their items cannot be ranked against each other; split by {} first.",
            codes.join(", "),
            cur_field
        );
        return out;
    }
    // a single-currency node: its amounts are stated with the currency
    let cur = node.value.currency.as_ref().map(|c| format!(" {}", c)).unwrap_or_default();
    let amount = |x: f64| format!("{}{}", num(x), cur);
    let path_cols: Vec<u32> = node.path.iter().filter_map(|st| heads.col(&st.field)).collect();
    let key_cols: Vec<u32> = q.key.iter().filter_map(|k| heads.col(k)).collect();
    let is_explicit = !explicit.is_empty();
    let candidates: Vec<u32> = if is_explicit {
        explicit.to_vec()
    } else {
        (0..t.cols)
            .filter(|c| !path_cols.contains(c) && !key_cols.contains(c) && Some(*c) != m.col && Some(*c) != m.den)
            .collect()
    };
    let min_rows = s.min_rows.unwrap_or(if m.info.additive { 1 } else { 5 });
    let mut ranked: Vec<(usize, Candidate)> = vec![];
    let mut skipped: Vec<Candidate> = vec![];
    let mut considered = 0usize;
    let skip = |field: String, why: &str| Candidate {
        field,
        score: None,
        items: 0,
        node: None,
        node_key: None,
        value: None,
        mean: None,
        skipped: Some(why.to_string()),
    };
    for (pos, &c) in candidates.iter().enumerate() {
        let field = t.header_text(c);
        if is_explicit && path_cols.contains(&c) {
            skipped.push(skip(field, "already on this node's path"));
            continue;
        }
        if is_explicit && key_cols.contains(&c) {
            skipped.push(skip(field, "an identifier column (key)"));
            continue;
        }
        // a column a split cannot name: no header, or the same header as an earlier column
        // (a split's field is a header, and a header names its first column)
        if !is_explicit && field.trim().is_empty() {
            skipped.push(skip(field, &format!("no header (column {})", c + 1)));
            continue;
        }
        if let Some(first) = heads.col(&field).filter(|&f| !is_explicit && f != c) {
            skipped.push(skip(field, &format!("same header as column {}", first + 1)));
            continue;
        }
        if !is_explicit && considered >= MAX_SUGGEST_FIELDS {
            skipped.push(skip(field, "beyond the first 32 columns"));
            continue;
        }
        let cost = node.rows.len() as u64;
        if *work + cost > lim.work {
            // still one of the first 32: the columns after the 32nd are "beyond", whatever the budget
            if !is_explicit {
                considered += 1;
            }
            skipped.push(skip(field, "work budget"));
            continue;
        }
        *work += cost;
        if !is_explicit {
            let mut any = false;
            let mut all_numbers = true;
            for &r in &node.rows {
                let v = t.value_at(CellKey::new(r, c));
                match key_of(&v) {
                    Key::Empty => {}
                    Key::Number(_) => any = true,
                    _ => {
                        all_numbers = false;
                        break;
                    }
                }
            }
            if any && all_numbers {
                skipped.push(skip(field, "numbers (amount or date): name it in fields to use it"));
                continue;
            }
        }
        considered += 1;
        let g = match group(t, m, &node.rows, c, MAX_SUGGEST_ITEMS) {
            Ok(g) => g,
            Err(_) => {
                skipped.push(skip(field, "more than 100 values"));
                continue;
            }
        };
        let items = g.named.len() as u32;
        if g.named.len() < 2 {
            let why = match g.named.first() {
                Some((_, b)) => format!("one value only here ({})", label_of(t, b.first_row, c, &b.raw)),
                None => "no value here".to_string(),
            };
            let mut cand = skip(field, &why);
            cand.items = items;
            skipped.push(cand);
            continue;
        }
        let mut scored: Vec<(&Key, &Bucket, f64)> = g
            .named
            .iter()
            .filter(|(_, b)| b.rows.len() as u64 >= min_rows)
            .filter_map(|(k, b)| {
                // the node has one currency (or none), so every child's value is comparable
                m.result(&b.acc).value.map(|x| (k, b, x))
            })
            .collect();
        if scored.len() < 2 {
            let mut cand = skip(field, "fewer than 2 items with a value");
            cand.items = items;
            skipped.push(cand);
            continue;
        }
        scored.sort_by(|a, b| sibling_order(true, (Some(a.2), &a.1.raw, a.0), (Some(b.2), &b.1.raw, b.0)));
        let (_, top, top_v) = scored[0];
        let (score, mean) = if rule == "relative" {
            let mut abs = Sum::default();
            for (_, _, v) in &scored {
                abs.add(v.abs());
            }
            let mean = abs.get() / scored.len() as f64;
            if mean == 0.0 {
                let mut cand = skip(field, "all values are zero");
                cand.items = items;
                skipped.push(cand);
                continue;
            }
            (top_v / mean, Some(mean))
        } else {
            (top_v, None)
        };
        ranked.push((
            pos,
            Candidate {
                field,
                score: Some(score),
                items,
                node: Some(label_of(t, top.first_row, c, &top.raw)),
                node_key: Some(top.raw.clone()),
                value: Some(top_v),
                mean,
                skipped: None,
            },
        ));
    }
    ranked.sort_by(|(pa, a), (pb, b)| {
        let (sa, sb) = (round15(a.score.unwrap_or(f64::NEG_INFINITY)), round15(b.score.unwrap_or(f64::NEG_INFINITY)));
        sb.total_cmp(&sa).then(a.items.cmp(&b.items)).then(pa.cmp(pb))
    });
    let ranked: Vec<Candidate> = ranked.into_iter().map(|(_, c)| c).collect();
    out.best = ranked.first().cloned();
    out.runner_up = ranked.get(1).cloned();
    out.field = out.best.as_ref().map(|b| b.field.clone());
    let tail = format!(
        "{} fields compared in {}; ties go to the field with fewer values, then the earlier one; blank values and items under {} rows are not candidates. A heuristic, not a cause.",
        ranked.len(),
        if is_explicit { "the order given" } else { "column order" },
        min_rows
    );
    out.text = match &out.best {
        None => "No split suggested: every remaining field has one value here, too many values, or was skipped (see why).".into(),
        Some(b) => {
            let node_label = b.node.clone().unwrap_or_default();
            let value = amount(b.value.unwrap_or(0.0));
            if rule == "relative" {
                let runner = match &out.runner_up {
                    Some(r) => format!(
                        "; runner-up {}: {} {}×",
                        r.field,
                        r.node.clone().unwrap_or_default(),
                        num(r.score.unwrap_or(0.0))
                    ),
                    None => String::new(),
                };
                format!(
                    "Suggested split: {f}. Rule: {rt}. {node} is {score}× the mean of the {items} {f} values ({value} against {mean}){runner}. {tail}",
                    f = b.field,
                    rt = RELATIVE_TEXT,
                    node = node_label,
                    score = num(b.score.unwrap_or(0.0)),
                    items = b.items,
                    value = value,
                    mean = amount(b.mean.unwrap_or(0.0)),
                    runner = runner,
                    tail = tail
                )
            } else {
                let runner = match &out.runner_up {
                    Some(r) => format!(
                        "; runner-up {}: {}, {}",
                        r.field,
                        r.node.clone().unwrap_or_default(),
                        amount(r.value.unwrap_or(0.0))
                    ),
                    None => String::new(),
                };
                format!(
                    "Suggested split: {f}. Rule: {rt}. Its largest item, {node}, has {measure} {value}{runner}. {tail}",
                    f = b.field,
                    rt = HIGH_VALUE_TEXT,
                    node = node_label,
                    measure = m.info.name,
                    value = value,
                    runner = runner,
                    tail = tail
                )
            }
        }
    };
    out.candidates = ranked;
    out.candidates.extend(skipped);
    out
}

// ---------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytic::{self, records, RecordsQuery};
    use crate::engine::{Engine, Op};
    use serde_json::json;

    const HEADER: [&str; 9] = ["VIN", "Branch", "Make", "Model", "Currency", "Amount", "Cost", "Price", "Code"];

    /// 29 vehicles: Model blank (V08) and whitespace-only (V09); a tie of two models under
    /// Luanda > Kia (Rio = Picanto = 50); a negative amount (V12, a return); two currencies
    /// (V16, V19 in EUR); a branch whose prices are 0 (Namibe: ratio ÷0); "n/a" as an amount
    /// (V14); a missing amount (V24); `#N/A` as a Code (V06); "luanda" and "hilux" in another case;
    /// a blank branch (V27); then one empty row.
    fn tree_rows() -> Vec<[&'static str; 9]> {
        vec![
            ["V01", "Luanda", "Toyota", "Hilux", "AOA", "100", "60", "100", "A"],
            ["V02", "Luanda", "Toyota", "Hilux", "AOA", "100", "60", "120", "A"],
            ["V03", "Luanda", "Toyota", "Corolla", "AOA", "80", "50", "90", "B"],
            ["V04", "Luanda", "Ford", "Ranger", "AOA", "70", "40", "75", "A"],
            ["V05", "Luanda", "Ford", "Ranger", "AOA", "30", "20", "35", "B"],
            ["V06", "Luanda", "Kia", "Rio", "AOA", "50", "30", "55", "=NA()"],
            ["V07", "Luanda", "Kia", "Picanto", "AOA", "50", "35", "60", "C"],
            ["V08", "Luanda", "Kia", "", "AOA", "20", "10", "25", "C"],
            ["V09", "Luanda", "Kia", "   ", "AOA", "15", "5", "20", "C"],
            ["V10", "Benguela", "Toyota", "Hilux", "AOA", "90", "55", "100", "A"],
            ["V11", "Benguela", "Toyota", "Corolla", "AOA", "60", "40", "70", "B"],
            ["V12", "Benguela", "Ford", "Ranger", "AOA", "-40", "-25", "-45", "A"],
            ["V13", "Benguela", "Ford", "Focus", "AOA", "45", "30", "50", "B"],
            ["V14", "Benguela", "Kia", "Rio", "AOA", "n/a", "20", "30", "C"],
            ["V15", "Benguela", "Kia", "Sportage", "AOA", "65", "45", "70", "A"],
            ["V16", "Huambo", "Toyota", "Hilux", "EUR", "10", "6", "12", "A"],
            ["V17", "Huambo", "Toyota", "Hilux", "AOA", "85", "50", "95", "B"],
            ["V18", "Huambo", "Ford", "Ranger", "AOA", "55", "35", "60", "A"],
            ["V19", "Huambo", "Kia", "Rio", "EUR", "8", "5", "9", "C"],
            ["V20", "Huambo", "Kia", "", "AOA", "25", "15", "30", "C"],
            ["V21", "Namibe", "Toyota", "Hilux", "AOA", "40", "25", "0", "A"],
            ["V22", "Namibe", "Ford", "Ranger", "AOA", "35", "20", "0", "B"],
            ["V23", "Cabinda", "Toyota", "Corolla", "AOA", "30", "20", "35", "A"],
            ["V24", "Cabinda", "Kia", "Rio", "AOA", "", "15", "20", "B"],
            ["V25", "Lubango", "Ford", "Focus", "AOA", "25", "15", "30", "A"],
            ["V26", "Lubango", "Toyota", "Hilux", "AOA", "20", "12", "25", "C"],
            ["V27", "", "Kia", "Rio", "AOA", "12", "8", "14", "C"],
            ["V28", "Malanje", "Ford", "Ranger", "AOA", "5", "3", "6", "A"],
            ["V29", "luanda", "Toyota", "hilux", "AOA", "10", "6", "12", "A"],
        ]
    }

    fn table(name: &str, rows: Vec<Vec<String>>) -> Engine {
        let mut e = Engine::new(Workbook::new("t"));
        let cols = rows[0].len() as u32;
        e.apply(Op::AddTable {
            id: None,
            name: Some(name.into()),
            x: 0.0,
            y: 0.0,
            rows: rows.len() as u32,
            cols,
            values: Some(rows),
        });
        e
    }

    fn fleet(reverse: bool) -> Engine {
        let mut data = tree_rows();
        if reverse {
            data.reverse();
        }
        let mut rows: Vec<Vec<String>> = vec![HEADER.iter().map(|s| s.to_string()).collect()];
        rows.extend(data.iter().map(|r| r.iter().map(|s| s.to_string()).collect::<Vec<_>>()));
        rows.push(vec![String::new(); 9]);
        table("Fleet", rows)
    }

    fn tree_book() -> Engine {
        fleet(false)
    }

    fn dq(v: serde_json::Value) -> DecompQuery {
        serde_json::from_value(v).unwrap()
    }

    fn run(e: &Engine, v: serde_json::Value) -> Tree {
        decompose(&e.wb, &dq(v)).unwrap()
    }

    fn err(e: &Engine, v: serde_json::Value) -> String {
        decompose(&e.wb, &dq(v)).unwrap_err()
    }

    fn kids(n: &Node) -> &[Node] {
        &n.split.as_ref().expect("node is split").children
    }

    fn labels(n: &Node) -> Vec<String> {
        kids(n).iter().map(|c| c.label.clone()).collect()
    }

    fn child<'a>(n: &'a Node, label: &str) -> &'a Node {
        kids(n).iter().find(|c| c.label == label).unwrap_or_else(|| panic!("no child {} in {:?}", label, labels(n)))
    }

    fn all_nodes(n: &Node) -> Vec<&Node> {
        let mut out = vec![n];
        if let Some(sp) = &n.split {
            for c in &sp.children {
                out.extend(all_nodes(c));
            }
        }
        out
    }

    fn val(n: &Node) -> f64 {
        n.value.value.unwrap()
    }

    fn step(field: &str, key: &str) -> serde_json::Value {
        json!({"field": field, "key": {"s": key}})
    }

    /// Splits for every shown child of every split node, `levels` deep along `fields`.
    fn deep(e: &Engine, base: serde_json::Value, fields: &[&str]) -> (serde_json::Value, Tree) {
        let mut q = base;
        q["splits"] = json!([{"path": [], "field": fields[0]}]);
        let mut t = run(e, q.clone());
        for (level, f) in fields.iter().enumerate().skip(1) {
            let mut splits = q["splits"].as_array().unwrap().clone();
            for n in all_nodes(&t.root) {
                if n.path.len() == level {
                    splits.push(json!({"path": n.path, "field": f}));
                }
            }
            q["splits"] = json!(splits);
            t = run(e, q.clone());
        }
        (q, t)
    }

    /// Brute force over the table: Σ and n of a numeric column over the rows a predicate keeps.
    fn brute(e: &Engine, col: u32, keep: impl Fn(&Table, u32) -> bool) -> (f64, u64) {
        let t = e.wb.table_by_name("Fleet").unwrap();
        let (mut s, mut n) = (0.0, 0u64);
        for r in t.header_rows..t.rows {
            if keep(t, r) {
                if let Value::Number(x) = t.value_at(CellKey::new(r, col)) {
                    s += x;
                    n += 1;
                }
            }
        }
        (s, n)
    }

    fn text_at(t: &Table, r: u32, c: u32) -> String {
        t.value_at(CellKey::new(r, c)).to_display().trim().to_lowercase()
    }

    #[test]
    fn root_is_the_analytical_total() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"key":["VIN"]}));
        let a = analytic::analyze(&e.wb, &serde_json::from_value(json!({"table":"Fleet","measures":[{"field":"Amount"}],"key":["VIN"]})).unwrap()).unwrap();
        assert_eq!(t.root.value, a.total[0]);
        assert_eq!(t.root.value.value, Some(1095.0));
        assert_eq!(t.root.rows, 29);
        assert_eq!(t.root.id, "r");
        assert_eq!(t.root.kind, "root");
        assert_eq!(t.population.rows, a.population.rows);
        assert_eq!(t.population.blank, 1);
        assert_eq!(t.excluded.rows, a.excluded.rows);
        assert_eq!(t.issues.len(), a.issues.len());
        assert_eq!(t.top_n, DEFAULT_TOP_N);
        // with a starting selection the excluded rows stay visible, as in analyze
        let sel = json!([{"field":"Branch","values":[{"s":"Luanda"}]}]);
        let t2 = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"selections":sel}));
        let a2 = analytic::analyze(&e.wb, &serde_json::from_value(json!({"table":"Fleet","measures":[{"field":"Amount"}],"selections":sel})).unwrap()).unwrap();
        assert_eq!(t2.root.value.value, Some(525.0));
        assert_eq!(t2.excluded.by_selection, a2.excluded.by_selection);
        assert_eq!(t2.excluded.values, a2.excluded.values);
    }

    #[test]
    fn children_reconcile_at_every_level_including_other_and_blank() {
        let e = tree_book();
        for measure in [json!({"field":"Amount"}), json!({"agg":"count"})] {
            let (_, t) = deep(&e, json!({"table":"Fleet","measure":measure,"top_n":2}), &["Branch", "Make", "Model"]);
            let mut splits = 0;
            let mut saw_other = false;
            let mut saw_blank = false;
            for n in all_nodes(&t.root) {
                if let Some(sp) = &n.split {
                    splits += 1;
                    assert_eq!(sp.check.kind, "sum");
                    assert_eq!(sp.check.status, "ok", "{} {:?}", n.id, sp.check);
                    assert!(sp.check.rows_ok);
                    assert_eq!(sp.check.text, "children add up to the parent");
                    // the figures themselves: the node's own value, and the children's values
                    // added independently (exact here: whole amounts and counts)
                    assert_eq!(sp.check.parent, n.value.value, "{}", n.id);
                    let brute: f64 = sp.children.iter().filter_map(|c| c.value.value).sum();
                    assert_eq!(sp.check.sum_of_children, Some(brute), "{}", n.id);
                    for c in &sp.children {
                        saw_other |= c.kind == "other";
                        saw_blank |= c.kind == "blank";
                    }
                }
                assert!(n.path.len() <= 3);
            }
            assert!(splits > 10 && saw_other && saw_blank);
            assert!(all_nodes(&t.root).iter().any(|n| n.path.len() == 3));
        }
    }

    #[test]
    fn rows_partition_the_parent() {
        let e = tree_book();
        let (_, t) = deep(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":2}), &["Branch", "Make", "Model"]);
        for n in all_nodes(&t.root) {
            if let Some(sp) = &n.split {
                assert_eq!(sp.children.iter().map(|c| c.rows).sum::<u64>(), n.rows, "{}", n.id);
                assert!(sp.check.rows_ok);
            }
        }
    }

    #[test]
    fn siblings_sort_by_value_then_canonical_key() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"splits":[
            {"path":[],"field":"Branch"},
            {"path":[step("Branch","Luanda")],"field":"Model"},
            {"path":[step("Branch","Benguela")],"field":"Make"}]}));
        assert_eq!(labels(&t.root), vec!["Luanda", "Benguela", "Huambo", "Namibe", "Lubango", "Cabinda", "Malanje", "(blank)"]);
        let values: Vec<f64> = kids(&t.root).iter().map(val).collect();
        assert_eq!(values, vec![525.0, 220.0, 183.0, 75.0, 45.0, 30.0, 5.0, 12.0]);
        let ranks: Vec<Option<u32>> = kids(&t.root).iter().map(|c| c.rank).collect();
        assert_eq!(ranks, vec![Some(1), Some(2), Some(3), Some(4), Some(5), Some(6), Some(7), None]);
        // Picanto and Rio tie at 50: the key decides
        let luanda = child(&t.root, "Luanda");
        assert_eq!(labels(luanda), vec!["Hilux", "Ranger", "Corolla", "Picanto", "Rio", "(blank)"]);
        assert_eq!(luanda.split.as_ref().unwrap().sort, "value_desc");
        assert_eq!(child(luanda, "Hilux").value.value, Some(210.0));
        assert_eq!(child(luanda, "Hilux").id, "r/branch=s:luanda/model=s:hilux");
    }

    #[test]
    fn order_is_independent_of_row_order() {
        let fwd = tree_book();
        let rev = fleet(true);
        for measure in [json!({"field":"Amount"}), json!({"agg":"ratio","numerator":"Cost","denominator":"Price"})] {
            let (q, a) = deep(&fwd, json!({"table":"Fleet","measure":measure,"top_n":3}), &["Branch", "Make", "Model"]);
            let b = run(&rev, q);
            let (na, nb) = (all_nodes(&a.root), all_nodes(&b.root));
            assert_eq!(na.len(), nb.len());
            for (x, y) in na.iter().zip(nb.iter()) {
                assert_eq!(x.id, y.id);
                assert_eq!(x.kind, y.kind);
                assert_eq!(x.key.as_ref().map(key_of), y.key.as_ref().map(key_of));
                assert_eq!(x.rows, y.rows);
                assert_eq!(x.value.status, y.value.status);
                match (x.value.value, y.value.value) {
                    (Some(p), Some(q)) => assert!(numbers_equal(p, q), "{} {} {}", x.id, p, q),
                    (p, q) => assert_eq!(p, q),
                }
            }
        }
    }

    #[test]
    fn fifteen_digit_ties_break_by_key() {
        // Zed's sum is 0.1 + 0.2 = 0.30000000000000004 in binary; at Excel's 15 digits it equals
        // Alpha's 0.3 (Microsoft, "Floating-point arithmetic may give inaccurate results in Excel"),
        // so the key decides and Alpha comes first.
        let rows = vec![
            vec!["K".to_string(), "V".to_string()],
            vec!["Zed".into(), "0.1".into()],
            vec!["Zed".into(), "0.2".into()],
            vec!["Alpha".into(), "0.3".into()],
        ];
        let e = table("N", rows);
        let t = run(&e, json!({"table":"N","measure":{"field":"V"},"splits":[{"path":[],"field":"K"}]}));
        assert_eq!(labels(&t.root), vec!["Alpha", "Zed"]);
        assert!(val(&kids(&t.root)[1]) > val(&kids(&t.root)[0]));
        assert_eq!(t.root.split.as_ref().unwrap().check.status, "ok");
    }

    #[test]
    fn top_n_folds_the_rest_into_other_k() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":3,"splits":[{"path":[],"field":"Branch"}]}));
        assert_eq!(labels(&t.root), vec!["Luanda", "Benguela", "Huambo", "Other (4)", "(blank)"]);
        let o = child(&t.root, "Other (4)");
        assert_eq!(o.kind, "other");
        assert_eq!(o.k, Some(4));
        assert_eq!(o.rank, None);
        assert_eq!(o.key, None);
        assert_eq!(o.id, "r/branch=other");
        let folded: Vec<String> = o.folded.iter().map(|v| v.to_display()).collect();
        assert_eq!(folded, vec!["Namibe", "Lubango", "Cabinda", "Malanje"]);
        assert_eq!(o.value.value, Some(155.0));
        assert_eq!(o.rows, 7);
        assert_eq!(o.selections, vec![Selection { field: "Branch".into(), values: o.folded.clone() }]);
        assert_eq!(t.root.split.as_ref().unwrap().items, 7);
        assert_eq!(t.root.split.as_ref().unwrap().check.status, "ok");
    }

    #[test]
    fn single_leftover_is_named_not_other() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":6,"splits":[{"path":[],"field":"Branch"}]}));
        assert_eq!(labels(&t.root), vec!["Luanda", "Benguela", "Huambo", "Namibe", "Lubango", "Cabinda", "Malanje", "(blank)"]);
        let m = child(&t.root, "Malanje");
        assert_eq!(m.rank, Some(7));
        assert!(!m.pinned);
        assert!(kids(&t.root).iter().all(|c| c.kind != "other"));
    }

    #[test]
    fn no_other_when_n_or_fewer() {
        let e = tree_book();
        for n in [7, 10, 50] {
            let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":n,"splits":[{"path":[],"field":"Branch"}]}));
            assert!(kids(&t.root).iter().all(|c| c.kind != "other"));
            assert_eq!(kids(&t.root).len(), 8);
        }
    }

    #[test]
    fn blank_and_whitespace_are_one_blank_node_never_folded_last() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":1,"splits":[
            {"path":[],"field":"Branch"},
            {"path":[step("Branch","Luanda")],"field":"Model"},
            {"path":[step("Branch","Huambo")],"field":"Make"},
            {"path":[step("Branch","Huambo"),step("Make","Kia")],"field":"Model"}]}));
        // "" and "   " are one (blank) node, last, never in Other
        let luanda = child(&t.root, "Luanda");
        assert_eq!(labels(luanda), vec!["Hilux", "Other (4)", "(blank)"]);
        let b = child(luanda, "(blank)");
        assert_eq!(b.kind, "blank");
        assert_eq!(b.rows, 2);
        assert_eq!(b.value.value, Some(35.0));
        assert_eq!(b.key, Some(Value::Empty));
        assert_eq!(b.id, "r/branch=s:luanda/model=blank");
        assert_eq!(b.selections.last().unwrap().values, vec![Value::Empty]);
        // a blank that is the largest child is still last and not counted toward N
        let kia = child(child(&t.root, "Huambo"), "Kia");
        assert_eq!(labels(kia), vec!["Rio", "(blank)"]);
        assert!(val(&kids(kia)[1]) > val(&kids(kia)[0]));
        // the blank branch at the root, too
        assert_eq!(kids(&t.root).last().unwrap().label, "(blank)");
        // Huambo is kept open (pinned); the other five are folded, never the blank
        assert!(child(&t.root, "Huambo").pinned);
        assert!(child(&t.root, "Other (5)").folded.iter().all(|v| !v.is_empty()));
    }

    #[test]
    fn error_keys_are_not_blank() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"splits":[{"path":[],"field":"Code"}]}));
        let na = child(&t.root, "#N/A");
        assert_eq!(na.kind, "value");
        // the "/" of #N/A is escaped in the id (node_ids_are_unique_whatever_the_key_text)
        assert_eq!(na.id, "r/code=e:#N%2FA");
        assert_eq!(na.value.value, Some(50.0));
        assert!(kids(&t.root).iter().all(|c| c.kind != "blank"));
        assert_eq!(t.root.split.as_ref().unwrap().check.status, "ok");
    }

    #[test]
    fn other_ratio_and_average_are_recomputed_from_their_rows() {
        let e = tree_book();
        // ratio: Other = Σ cost / Σ price over the folded rows
        let t = run(&e, json!({"table":"Fleet","measure":{"agg":"ratio","numerator":"Cost","denominator":"Price"},"top_n":3,"splits":[{"path":[],"field":"Branch"}]}));
        let o = kids(&t.root).iter().find(|c| c.kind == "other").unwrap();
        let folded: Vec<String> = o.folded.iter().map(|v| v.to_display().to_lowercase()).collect();
        let inside = |t: &Table, r: u32| folded.contains(&text_at(t, r, 1));
        let (num, _) = brute(&e, 6, inside);
        let (den, _) = brute(&e, 7, inside);
        assert!(numbers_equal(val(o), num / den));
        let parts = o.parts.as_ref().unwrap();
        assert!(numbers_equal(parts.numerator, num) && numbers_equal(parts.denominator, den));
        // not the mean of the folded branches' ratios
        let mut ratios = vec![];
        for f in &folded {
            let (a, _) = brute(&e, 6, |t, r| text_at(t, r, 1) == *f);
            let (b, _) = brute(&e, 7, |t, r| text_at(t, r, 1) == *f);
            if b != 0.0 {
                ratios.push(a / b);
            }
        }
        let mean = ratios.iter().sum::<f64>() / ratios.len() as f64;
        assert!((val(o) - mean).abs() > 1e-6);
        // and not parent − shown
        let shown: f64 = kids(&t.root).iter().filter(|c| c.kind == "value").filter_map(|c| c.value.value).sum();
        assert!((val(o) - (val(&t.root) - shown)).abs() > 1e-6);
        // average: Σ/n over the folded rows
        let t = run(&e, json!({"table":"Fleet","measure":{"agg":"average","field":"Amount"},"top_n":3,"splits":[{"path":[],"field":"Branch"}]}));
        let o = kids(&t.root).iter().find(|c| c.kind == "other").unwrap();
        let folded: Vec<String> = o.folded.iter().map(|v| v.to_display().to_lowercase()).collect();
        let (s, n) = brute(&e, 5, |t, r| folded.contains(&text_at(t, r, 1)));
        assert!(numbers_equal(val(o), s / n as f64));
        let parts = o.parts.as_ref().unwrap();
        assert_eq!(parts.denominator, n as f64);
        let child_means: Vec<f64> = folded
            .iter()
            .map(|f| {
                let (a, k) = brute(&e, 5, |t, r| text_at(t, r, 1) == *f);
                a / k as f64
            })
            .collect();
        let mean_of_means = child_means.iter().sum::<f64>() / child_means.len() as f64;
        assert!((val(o) - mean_of_means).abs() > 1e-6);
    }

    #[test]
    fn other_count_distinct_is_the_union() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"agg":"count_distinct","field":"Make"},"top_n":3,"splits":[{"path":[],"field":"Branch"}]}));
        assert_eq!(labels(&t.root), vec!["Benguela", "Huambo", "Luanda", "Other (4)", "(blank)"]);
        let o = child(&t.root, "Other (4)");
        let folded: Vec<String> = o.folded.iter().map(|v| v.to_display()).collect();
        assert_eq!(folded, vec!["Cabinda", "Lubango", "Namibe", "Malanje"]);
        // Toyota, Ford and Kia: the union, not 2 + 2 + 2 + 1
        assert_eq!(o.value.value, Some(3.0));
    }

    #[test]
    fn ratio_nodes_carry_parts_and_parts_reconcile() {
        let e = tree_book();
        let (_, t) = deep(&e, json!({"table":"Fleet","measure":{"agg":"ratio","numerator":"Cost","denominator":"Price"},"top_n":2}), &["Branch", "Make"]);
        for n in all_nodes(&t.root) {
            let p = n.parts.as_ref().unwrap_or_else(|| panic!("{} has no parts", n.id));
            if let Some(v) = n.value.value {
                assert!(numbers_equal(v, p.numerator / p.denominator));
            }
            if let Some(sp) = &n.split {
                assert_eq!(sp.check.parts_ok, Some(true));
                let num: f64 = sp.children.iter().map(|c| c.parts.as_ref().unwrap().numerator).sum();
                assert!(numbers_equal(num, p.numerator));
            }
        }
        let json = serde_json::to_string(&t.root).unwrap();
        assert!(json.contains("\"parts\":{\"numerator\""));
    }

    #[test]
    fn non_additive_split_says_children_do_not_sum_and_has_no_share() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"agg":"ratio","numerator":"Cost","denominator":"Price"},"splits":[{"path":[],"field":"Branch"}]}));
        let c = &t.root.split.as_ref().unwrap().check;
        assert_eq!(c.kind, "children_do_not_sum");
        assert_eq!(c.status, "recomputed");
        assert_eq!(c.text, "children do not sum to parent (ratio)");
        assert_eq!(c.parts_ok, Some(true));
        assert!(c.rows_ok);
        assert!(kids(&t.root).iter().all(|n| n.share.is_none()));
        // an additive measure has shares
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"splits":[{"path":[],"field":"Branch"}]}));
        assert!((child(&t.root, "Luanda").share.unwrap() - 525.0 / 1095.0).abs() < 1e-12);
        let t = run(&e, json!({"table":"Fleet","measure":{"agg":"average","field":"Amount"},"splits":[{"path":[],"field":"Branch"}]}));
        assert_eq!(t.root.split.as_ref().unwrap().check.text, "children do not sum to parent (average)");
        assert_eq!(t.root.split.as_ref().unwrap().check.parts_ok, Some(true));
    }

    #[test]
    fn min_max_count_distinct_do_not_sum() {
        let e = tree_book();
        for (agg, text) in [("min", "min"), ("max", "max"), ("count_distinct", "distinct count")] {
            let t = run(&e, json!({"table":"Fleet","measure":{"agg":agg,"field":"Amount"},"splits":[{"path":[],"field":"Branch"}]}));
            let c = &t.root.split.as_ref().unwrap().check;
            assert_eq!(c.kind, "children_do_not_sum");
            assert_eq!(c.status, "recomputed");
            assert_eq!(c.text, format!("children do not sum to parent ({})", text));
            assert_eq!(c.parts_ok, None);
            assert!(kids(&t.root).iter().all(|n| n.share.is_none() && n.parts.is_none()));
        }
        let t = run(&e, json!({"table":"Fleet","measure":{"agg":"max","field":"Amount"},"top_n":2,"splits":[{"path":[],"field":"Branch"}]}));
        assert_eq!(child(&t.root, "Other (5)").value.value, Some(85.0));
        let t = run(&e, json!({"table":"Fleet","measure":{"agg":"min","field":"Amount"},"top_n":2,"splits":[{"path":[],"field":"Branch"}]}));
        assert!(kids(&t.root).iter().any(|c| c.kind == "other" && c.value.value.is_some()));
    }

    #[test]
    fn div0_node_is_null_not_zero() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"agg":"ratio","numerator":"Cost","denominator":"Price"},"splits":[{"path":[],"field":"Branch"}]}));
        let n = child(&t.root, "Namibe");
        assert_eq!(n.value.value, None);
        assert_eq!(n.value.status, "div0");
        assert_eq!(n.parts.as_ref().unwrap().denominator, 0.0);
        assert!(serde_json::to_string(&n.value).unwrap().contains("\"value\":null"));
        // a ÷0 child has no value: it sorts after the numbers
        assert_eq!(kids(&t.root).iter().filter(|c| c.kind == "value").last().unwrap().label, "Namibe");
    }

    #[test]
    fn mixed_currency_node_sorts_by_key_and_reconciles_per_currency() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount","currency":"Currency"},"splits":[
            {"path":[],"field":"Branch"},{"path":[step("Branch","Huambo")],"field":"Make"}]}));
        assert_eq!(t.root.value.status, "mixed_currency");
        let sp = t.root.split.as_ref().unwrap();
        assert_eq!(sp.sort, "key");
        assert_eq!(labels(&t.root), vec!["Benguela", "Cabinda", "Huambo", "Luanda", "Lubango", "Malanje", "Namibe", "(blank)"]);
        assert_eq!(sp.check.status, "ok");
        assert_eq!(sp.check.text, "children add up to the parent in each currency");
        assert_eq!(sp.check.parent, None);
        let cur: Vec<(String, f64, &str)> = sp.check.by_currency.iter().map(|c| (c.currency.clone(), c.sum_of_children, c.status)).collect();
        assert_eq!(cur, vec![("AOA".to_string(), 1077.0, "ok"), ("EUR".to_string(), 18.0, "ok")]);
        assert!(kids(&t.root).iter().all(|c| c.share.is_none() || c.value.value.is_some()));
        let h = child(&t.root, "Huambo");
        assert_eq!(h.value.status, "mixed_currency");
        assert_eq!(h.value.by_currency.len(), 2);
        let hs = h.split.as_ref().unwrap();
        assert_eq!(hs.sort, "key");
        assert_eq!(labels(h), vec!["Ford", "Kia", "Toyota"]);
        assert_eq!(hs.check.status, "ok");
        // a single-currency node keeps the value order
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount","currency":"Currency"},"splits":[
            {"path":[],"field":"Branch"},{"path":[step("Branch","Luanda")],"field":"Make"}]}));
        let l = child(&t.root, "Luanda");
        assert_eq!(l.value.currency.as_deref(), Some("AOA"));
        assert_eq!(l.split.as_ref().unwrap().sort, "value_desc");
        assert_eq!(l.split.as_ref().unwrap().check.status, "ok");
    }

    #[test]
    fn missing_and_text_amounts_are_incomplete_per_node() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":3,"splits":[{"path":[],"field":"Branch"}]}));
        assert_eq!(t.root.value.status, "incomplete");
        let b = child(&t.root, "Benguela");
        assert_eq!((b.value.status, b.value.invalid, b.value.missing), ("incomplete", 1, 0));
        let o = child(&t.root, "Other (4)");
        assert_eq!((o.value.status, o.value.missing), ("incomplete", 1));
        let l = child(&t.root, "Luanda");
        assert_eq!(l.value.status, "ok");
        let missing: u64 = kids(&t.root).iter().map(|c| c.value.missing).sum();
        let invalid: u64 = kids(&t.root).iter().map(|c| c.value.invalid).sum();
        assert_eq!((missing, invalid), (t.root.value.missing, t.root.value.invalid));
        assert_eq!((missing, invalid), (1, 1));
        assert!(t.issues.iter().any(|i| i.kind == "missing_values"));
        assert!(t.issues.iter().any(|i| i.kind == "invalid_values"));
    }

    #[test]
    fn negative_siblings_set_mixed_signs_and_drop_shares() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"splits":[
            {"path":[],"field":"Branch"},{"path":[step("Branch","Benguela")],"field":"Model"}]}));
        let b = child(&t.root, "Benguela");
        let sp = b.split.as_ref().unwrap();
        assert!(sp.mixed_signs);
        assert!(sp.children.iter().all(|c| c.share.is_none()));
        assert_eq!(labels(b), vec!["Hilux", "Sportage", "Corolla", "Focus", "Ranger", "Rio"]);
        assert_eq!(child(b, "Rio").value.status, "no_data");
        assert_eq!(sp.check.status, "ok");
        assert!(!t.root.split.as_ref().unwrap().mixed_signs);
        assert!(child(&t.root, "Luanda").share.is_some());
    }

    #[test]
    fn pinned_child_outside_top_n_stays_named() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":2,"splits":[
            {"path":[],"field":"Branch"},{"path":[step("Branch","namibe")],"field":"Make"}]}));
        assert_eq!(labels(&t.root), vec!["Luanda", "Benguela", "Namibe", "Other (4)", "(blank)"]);
        let n = child(&t.root, "Namibe");
        assert!(n.pinned);
        assert_eq!(n.rank, Some(4));
        assert!(n.split.is_some());
        assert!(!child(&t.root, "Luanda").pinned);
        assert_eq!(child(&t.root, "Other (4)").value.value, Some(263.0));
        assert_eq!(t.root.split.as_ref().unwrap().check.status, "ok");
        assert!(t.unresolved.is_empty());
    }

    #[test]
    fn missing_path_is_unresolved_not_an_error() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"splits":[
            {"path":[],"field":"Branch"},
            {"path":[step("Branch","Nowhere")],"field":"Make"},
            {"path":[{"field":"Branch","other":true}],"field":"Make"},
            {"path":[step("Make","Toyota")],"field":"Model"},
            {"path":[step("Branch","Nowhere"),step("Make","Toyota")],"field":"Model"},
            {"path":[{"field":"Branch","key":null}],"field":"Make"}]}));
        let reasons: Vec<&str> = t.unresolved.iter().map(|u| u.reason.as_str()).collect();
        assert_eq!(
            reasons,
            vec![
                "Nowhere is no longer under Branch (filtered out or changed)",
                "there is no Other node under Branch: 7 values, top 10",
                "this node is not split by Make",
                "its parent is no longer in the tree",
            ]
        );
        assert_eq!(t.unresolved[0].field, "Make");
        // the (blank) branch resolves
        assert!(child(&t.root, "(blank)").split.is_some());
        // a suggestion at a node that is gone says so
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"splits":[{"path":[],"field":"Branch"}],
            "suggest":{"at":[step("Branch","Nowhere")]}}));
        let s = t.suggestion.unwrap();
        assert_eq!(s.field, None);
        assert!(s.text.starts_with("No split suggested: this node is no longer in the tree (Nowhere is no longer under Branch"));
    }

    #[test]
    fn node_selections_list_exactly_its_rows() {
        let e = tree_book();
        for measure in [json!({"field":"Amount"}), json!({"agg":"ratio","numerator":"Cost","denominator":"Price"})] {
            let base = json!([{"field":"Currency","values":[{"s":"AOA"}]}]);
            let (_, t) = deep(&e, json!({"table":"Fleet","measure":measure,"top_n":2,"selections":base}), &["Branch", "Make", "Model"]);
            let mut kinds = HashSet::new();
            for n in all_nodes(&t.root) {
                kinds.insert(n.kind);
                let rq: RecordsQuery = serde_json::from_value(json!({"table":"Fleet","measures":[measure],"selections":n.selections})).unwrap();
                let r = records(&e.wb, &rq).unwrap();
                assert_eq!(r.count, n.rows, "{}", n.id);
                assert_eq!(r.total[0].status, n.value.status, "{}", n.id);
                match (r.total[0].value, n.value.value) {
                    (Some(a), Some(b)) => assert!(numbers_equal(a, b), "{} {} {}", n.id, a, b),
                    (a, b) => assert_eq!(a, b),
                }
                assert_eq!(n.selections.len(), 1 + n.path.len());
            }
            assert!(kinds.contains("other") && kinds.contains("blank") && kinds.contains("value"));
        }
    }

    #[test]
    fn bad_requests_say_why() {
        let e = tree_book();
        let base = |splits: serde_json::Value| json!({"table":"Fleet","measure":{"field":"Amount"},"splits":splits});
        assert_eq!(
            err(&e, base(json!([{"path":[],"field":"Branch"},{"path":[step("Branch","Luanda")],"field":"branch"}]))),
            "\"Branch\" is already on this node's path"
        );
        assert_eq!(
            err(&e, base(json!([{"path":[],"field":"Branch"},{"path":[],"field":"Make"}]))),
            "two splits for one node"
        );
        assert_eq!(
            err(&e, base(json!([{"path":[step("Branch","Luanda")],"field":"Make"},{"path":[step("branch","LUANDA")],"field":"Model"}]))),
            "two splits for one node"
        );
        assert!(err(&e, base(json!([{"path":[],"field":"Colour"}]))).contains("\"Colour\" is not a header"));
        for n in [0, 51] {
            assert_eq!(err(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":n})), "top_n must be between 1 and 50");
        }
        let long: Vec<serde_json::Value> = (0..13).map(|i| step("Branch", &format!("b{}", i))).collect();
        assert_eq!(err(&e, base(json!([{"path":long,"field":"Make"}]))), "a breakdown path has at most 12 steps");
        let many: Vec<serde_json::Value> = (0..201).map(|i| json!({"path":[step("Branch",&format!("b{}", i))],"field":"Make"})).collect();
        assert_eq!(err(&e, base(json!(many))), "at most 200 splits per breakdown");
        assert!(err(&e, json!({"table":"Nope","measure":{"field":"Amount"}})).contains("no table"));
        assert!(err(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"suggest":{"rule":"luck"}})).contains("unknown suggestion rule"));
        let fields: Vec<String> = (0..33).map(|_| "Make".to_string()).collect();
        assert_eq!(err(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"suggest":{"fields":fields}})), "at most 32 candidate fields");
        // through the WASM binding: a JSON error, never a panic
        let book = crate::Book::from_json(&serde_json::to_string(&e.wb).unwrap()).ok().unwrap();
        assert!(book.decompose("{\"table\":").contains("bad query"));
        assert!(book.decompose(r#"{"table":"Fleet","measure":{"field":"Amount"},"top_n":0}"#).contains("top_n must be"));
    }

    #[test]
    fn budgets_refuse_oversized_trees() {
        // nodes: A (100 values) × B (100) × C, top 50 everywhere gives more than 5,000 nodes
        let mut rows = vec![vec!["A".to_string(), "B".to_string(), "C".to_string()]];
        for i in 0..10_000u32 {
            rows.push(vec![(i / 100).to_string(), (i % 100).to_string(), ((i * 7) % 100).to_string()]);
        }
        let e = table("G", rows);
        let mut splits = vec![json!({"path":[],"field":"A"})];
        let a_steps: Vec<serde_json::Value> = (0..50).map(|a| json!({"field":"A","key":{"n":a}})).chain([json!({"field":"A","other":true})]).collect();
        for s in &a_steps {
            splits.push(json!({"path":[s],"field":"B"}));
        }
        for s in &a_steps {
            splits.push(json!({"path":[s, {"field":"B","other":true}],"field":"C"}));
        }
        let q = json!({"table":"G","measure":{"agg":"count"},"top_n":50,"splits":splits});
        assert_eq!(err(&e, q), "the tree would show more than 5,000 items: collapse a level or lower top N");
        // fewer splits stay under the budget
        let few = &splits[..52];
        let q = json!({"table":"G","measure":{"agg":"count"},"top_n":50,"splits":few});
        assert!(decompose(&e.wb, &dq(q)).is_ok());

        // keys: an Other of 9,950 values repeated in each of its 51 children's selections
        let mut rows = vec![vec!["A".to_string(), "B".to_string()]];
        for i in 0..10_000u32 {
            rows.push(vec![format!("a{}", i), (i % 60).to_string()]);
        }
        let k = table("K", rows);
        let q = json!({"table":"K","measure":{"agg":"count"},"top_n":50,"splits":[{"path":[],"field":"A"},{"path":[{"field":"A","other":true}],"field":"B"}]});
        assert_eq!(err(&k, q), "the breakdown would list more than 50,000 values: lower top N or split by a field with fewer values");
        let q = json!({"table":"K","measure":{"agg":"count"},"top_n":50,"splits":[{"path":[],"field":"A"}]});
        assert!(decompose(&k.wb, &dq(q)).is_ok());

        // work: the same request over a smaller budget (the default is 5,000,000 row visits)
        let lim = Limits { work: 25_000, ..Limits::default() };
        let q = dq(json!({"table":"K","measure":{"agg":"count"},"top_n":50,"splits":[{"path":[],"field":"A"},{"path":[{"field":"A","other":true}],"field":"B"}]}));
        assert_eq!(
            decompose_with(&k.wb, &q, lim).unwrap_err(),
            "this breakdown would read more than 25,000 rows: collapse a level or choose fewer fields"
        );
        assert_eq!(thousands(MAX_DECOMP_WORK), "5,000,000");
        // a suggestion past the budget skips candidates instead of failing
        let q = dq(json!({"table":"K","measure":{"agg":"count"},"splits":[{"path":[],"field":"B"}],"suggest":{"at":[],"fields":["A","B"]}}));
        let s = decompose_with(&k.wb, &q, lim).unwrap().suggestion.unwrap();
        assert!(s.candidates.iter().all(|c| c.skipped.as_deref() == Some("work budget")));
        assert_eq!(s.field, None);
        let s = decompose(&k.wb, &q).unwrap().suggestion.unwrap();
        assert!(s.candidates.iter().all(|c| c.skipped.as_deref() != Some("work budget")));

        // more than 10,000 values under one node
        let mut rows = vec![vec!["A".to_string()]];
        for i in 0..10_001u32 {
            rows.push(vec![format!("v{}", i)]);
        }
        let big = table("Big", rows);
        assert_eq!(
            err(&big, json!({"table":"Big","measure":{"agg":"count"},"splits":[{"path":[],"field":"A"}]})),
            "more than 10000 values under one node: choose a field with fewer values"
        );
    }

    #[test]
    fn suggestion_is_deterministic_and_explained() {
        let q = json!({"table":"Fleet","measure":{"field":"Amount"},"key":["VIN"],"suggest":{"at":[]}});
        let a = run(&tree_book(), q.clone()).suggestion.unwrap();
        let b = run(&fleet(true), q).suggestion.unwrap();
        assert_eq!(a.rule, "high_value");
        assert_eq!(a.rule_text, "highest value of a single item");
        assert_eq!(a.field.as_deref(), Some("Currency"));
        let best = a.best.as_ref().unwrap();
        assert_eq!((best.node.as_deref(), best.value, best.items), (Some("AOA"), Some(1077.0), 2));
        let ru = a.runner_up.as_ref().unwrap();
        assert_eq!((ru.field.as_str(), ru.node.as_deref(), ru.value), ("Make", Some("Toyota"), Some(625.0)));
        assert_eq!(a.node_id, "r");
        assert_eq!(
            a.text,
            "Suggested split: Currency. Rule: highest value of a single item. Its largest item, AOA, has sum of Amount 1077; runner-up Make: Toyota, 625. 5 fields compared in column order; ties go to the field with fewer values, then the earlier one; blank values and items under 1 rows are not candidates. A heuristic, not a cause."
        );
        // the reversed table gives the same answer
        assert_eq!(a.field, b.field);
        assert_eq!(a.text, b.text);
        let fa: Vec<(String, Option<f64>, Option<String>)> = a.candidates.iter().map(|c| (c.field.clone(), c.score, c.skipped.clone())).collect();
        let fb: Vec<(String, Option<f64>, Option<String>)> = b.candidates.iter().map(|c| (c.field.clone(), c.score, c.skipped.clone())).collect();
        assert_eq!(fa, fb);
        assert_eq!(best.node_key.as_ref().map(key_of), b.best.as_ref().unwrap().node_key.as_ref().map(key_of));
        // at a node, with explicit fields in the order given; never applied
        let t = run(&tree_book(), json!({"table":"Fleet","measure":{"field":"Amount"},"splits":[{"path":[],"field":"Branch"}],
            "suggest":{"at":[step("Branch","Luanda")],"fields":["Model","Make"]}}));
        let s = t.suggestion.unwrap();
        assert_eq!(s.node_id, "r/branch=s:luanda");
        assert_eq!(s.field.as_deref(), Some("Make"));
        assert!(s.text.contains("Its largest item, Toyota, has sum of Amount 290; runner-up Model: Hilux, 210. 2 fields compared in the order given"));
        assert!(child(&t.root, "Luanda").split.is_none());
    }

    #[test]
    fn suggestion_excludes_path_key_measure_and_numeric_columns_with_reasons() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"key":["VIN"],"splits":[{"path":[],"field":"Branch"}],
            "suggest":{"at":[step("Branch","Luanda")]}}));
        let s = t.suggestion.unwrap();
        let fields: Vec<&str> = s.candidates.iter().map(|c| c.field.as_str()).collect();
        for gone in ["VIN", "Branch", "Amount"] {
            assert!(!fields.contains(&gone), "{} in {:?}", gone, fields);
        }
        for f in ["Cost", "Price"] {
            let c = s.candidates.iter().find(|c| c.field == f).unwrap();
            assert_eq!(c.skipped.as_deref(), Some("numbers (amount or date): name it in fields to use it"));
        }
        // Luanda has one currency
        let cur = s.candidates.iter().find(|c| c.field == "Currency").unwrap();
        assert_eq!(cur.skipped.as_deref(), Some("one value only here (AOA)"));
        assert!(s.candidates.iter().any(|c| c.field == "Make" && c.skipped.is_none()));
        // skipped ones come after the ranked ones
        let first_skip = s.candidates.iter().position(|c| c.skipped.is_some()).unwrap();
        assert!(s.candidates[first_skip..].iter().all(|c| c.skipped.is_some()));
        // a ratio's numerator and denominator are not candidates; a named numeric field is
        let t = run(&e, json!({"table":"Fleet","measure":{"agg":"ratio","numerator":"Cost","denominator":"Price"},"suggest":{"at":[]}}));
        let fields: Vec<String> = t.suggestion.unwrap().candidates.iter().map(|c| c.field.clone()).collect();
        assert!(!fields.contains(&"Cost".to_string()) && !fields.contains(&"Price".to_string()));
        assert!(fields.contains(&"Amount".to_string()));
        let t = run(&e, json!({"table":"Fleet","measure":{"agg":"count"},"key":["VIN"],"splits":[{"path":[],"field":"Branch"}],
            "suggest":{"at":[step("Branch","Luanda")],"fields":["Price","Branch","VIN"]}}));
        let s = t.suggestion.unwrap();
        let why: Vec<(String, Option<String>)> = s.candidates.iter().map(|c| (c.field.clone(), c.skipped.clone())).collect();
        assert_eq!(why[0], ("Price".to_string(), None));
        assert!(why.contains(&("Branch".to_string(), Some("already on this node's path".to_string()))));
        assert!(why.contains(&("VIN".to_string(), Some("an identifier column (key)".to_string()))));
    }

    #[test]
    fn suggestion_ties_go_to_fewer_values_then_column_order() {
        let rows = vec![
            vec!["X".to_string(), "Y".into(), "Z".into(), "V".into()],
            vec!["a".into(), "p".into(), "p".into(), "10".into()],
            vec!["b".into(), "q".into(), "q".into(), "5".into()],
            vec!["c".into(), "q".into(), "q".into(), "5".into()],
        ];
        let e = table("T", rows);
        let s = run(&e, json!({"table":"T","measure":{"field":"V"},"suggest":{"at":[]}})).suggestion.unwrap();
        let order: Vec<&str> = s.candidates.iter().map(|c| c.field.as_str()).collect();
        assert_eq!(order, vec!["Y", "Z", "X"]);
        assert!(s.candidates.iter().all(|c| c.score == Some(10.0)));
        assert_eq!(s.field.as_deref(), Some("Y"));
        assert_eq!(s.runner_up.unwrap().field, "Z");
    }

    #[test]
    fn relative_rule_uses_sibling_mean() {
        let rows = vec![
            vec!["F1".to_string(), "F2".into(), "V".into()],
            vec!["a".into(), "x".into(), "30".into()],
            vec!["b".into(), "x".into(), "10".into()],
            vec!["c".into(), "y".into(), "-20".into()],
        ];
        let e = table("R", rows);
        // high value: F2's x (40) beats F1's a (30)
        let s = run(&e, json!({"table":"R","measure":{"field":"V"},"suggest":{"at":[],"rule":"high_value"}})).suggestion.unwrap();
        assert_eq!(s.field.as_deref(), Some("F2"));
        // relative: a is 30 / mean(|30|,|10|,|-20|) = 1.5; x is 40 / mean(40, 20) = 1.33…
        let s = run(&e, json!({"table":"R","measure":{"field":"V"},"suggest":{"at":[],"rule":"relative"}})).suggestion.unwrap();
        assert_eq!(s.rule, "relative");
        assert_eq!(s.rule_text, "largest ratio of an item to its siblings' mean");
        let best = s.best.as_ref().unwrap();
        assert_eq!(best.field, "F1");
        assert_eq!(best.mean, Some(20.0));
        assert_eq!(best.score, Some(1.5));
        assert_eq!(best.node.as_deref(), Some("a"));
        assert!(s.text.starts_with("Suggested split: F1. Rule: largest ratio of an item to its siblings' mean. a is 1.5× the mean of the 3 F1 values (30 against 20); runner-up F2: x "));
        // all zero: skipped
        let z = table("Z", vec![vec!["F".to_string(), "V".into()], vec!["a".into(), "0".into()], vec!["b".into(), "0".into()]]);
        let s = run(&z, json!({"table":"Z","measure":{"field":"V"},"suggest":{"at":[],"rule":"relative"}})).suggestion.unwrap();
        assert_eq!(s.candidates[0].skipped.as_deref(), Some("all values are zero"));
        assert!(s.text.starts_with("No split suggested"));
    }

    #[test]
    fn min_rows_stops_a_one_row_ratio_winning() {
        let mut rows = vec![vec!["F1".to_string(), "F2".into(), "N".into(), "D".into()]];
        rows.push(vec!["solo".into(), "g".into(), "100".into(), "1".into()]);
        for _ in 0..5 {
            rows.push(vec!["rest".into(), "g".into(), "2".into(), "1".into()]);
        }
        for _ in 0..6 {
            rows.push(vec!["rest".into(), "h".into(), "1".into(), "1".into()]);
        }
        let e = table("M", rows);
        let m = json!({"agg":"ratio","numerator":"N","denominator":"D"});
        let s = run(&e, json!({"table":"M","measure":m,"suggest":{"at":[]}})).suggestion.unwrap();
        assert_eq!(s.field.as_deref(), Some("F2"));
        let f1 = s.candidates.iter().find(|c| c.field == "F1").unwrap();
        assert_eq!(f1.skipped.as_deref(), Some("fewer than 2 items with a value"));
        assert!(s.text.contains("items under 5 rows are not candidates"));
        let s = run(&e, json!({"table":"M","measure":m,"suggest":{"at":[],"min_rows":1}})).suggestion.unwrap();
        assert_eq!(s.field.as_deref(), Some("F1"));
        assert_eq!(s.best.unwrap().node.as_deref(), Some("solo"));
    }

    /// `decompose` itself takes `&Workbook`, so the borrow checker already keeps it read-only; what
    /// can regress is the WASM binding (`Book::decompose`). This goes through it: the workbook, its
    /// undo stack and the next undo are the same after a deep tree and a suggestion.
    #[test]
    fn decompose_binding_does_not_change_the_workbook() {
        let e = tree_book();
        let mut book = crate::Book::from_json(&serde_json::to_string(&e.wb).unwrap()).ok().unwrap();
        let fleet = book.engine.wb.table_by_name("Fleet").unwrap().id;
        // one edit, so there is an undo stack to keep
        book.engine.apply(Op::SetCells {
            table: fleet,
            row: 1,
            col: 8,
            values: vec![vec!["Z".into()]],
        });
        assert!(book.can_undo());
        let before = book.to_json();
        let (q, t) = deep(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":2,"suggest":{"at":[]}}), &["Branch", "Make", "Model"]);
        let answer: serde_json::Value = serde_json::from_str(&book.decompose(&q.to_string())).unwrap();
        assert!(answer.get("error").is_none(), "{}", answer);
        assert_eq!(answer["root"]["value"]["value"], json!(t.root.value.value));
        assert!(answer["suggestion"]["field"].is_string());
        assert_eq!(book.to_json(), before);
        assert!(book.can_undo());
        // the next undo still takes back the edit, not something the breakdown did
        book.engine.undo();
        assert_eq!(book.engine.wb.table_by_name("Fleet").unwrap().value_at(CellKey::new(1, 8)), Value::Text("A".into()));
        // the shared analytic fixture too
        let s = analytic::tests::book();
        let t = run(&s, json!({"table":"Stock","measure":{"field":"Price"},"key":["VIN"],"splits":[{"path":[],"field":"Branch"}],"suggest":{"at":[]}}));
        assert_eq!(t.root.value.value, Some(652.0));
        assert_eq!(labels(&t.root), vec!["Luanda", "Benguela", "Huambo"]);
        assert!(t.issues.iter().any(|i| i.kind == "duplicate_key"));
    }

    /// Kwanza and euros are never ranked against each other: a node that mixes currencies gets no
    /// suggestion (and says why); a single-currency node states its amounts with the currency.
    #[test]
    fn suggestion_never_compares_amounts_in_different_currencies() {
        let rows = vec![
            vec!["Branch".to_string(), "Make".into(), "Cur".into(), "Amt".into()],
            vec!["Luanda".into(), "A".into(), "AOA".into(), "1000000".into()],
            vec!["Luanda".into(), "B".into(), "AOA".into(), "10".into()],
            vec!["Lisbon".into(), "A".into(), "EUR".into(), "500".into()],
            vec!["Lisbon".into(), "C".into(), "EUR".into(), "400".into()],
            vec!["Porto".into(), "C".into(), "EUR".into(), "5".into()],
            vec!["Porto".into(), "D".into(), "EUR".into(), "-5".into()],
        ];
        let e = table("T", rows);
        for rule in ["high_value", "relative"] {
            let t = run(&e, json!({"table":"T","measure":{"field":"Amt","currency":"Cur"},"suggest":{"at":[],"rule":rule}}));
            assert_eq!(t.root.value.status, "mixed_currency");
            let s = t.suggestion.unwrap();
            assert_eq!(s.field, None, "{}: {}", rule, s.text);
            assert!(s.best.is_none() && s.runner_up.is_none());
            assert!(s.candidates.iter().all(|c| c.score.is_none()), "{:?}", s.candidates);
            assert_eq!(
                s.text,
                "No split suggested: the amounts under this node are in different currencies (AOA, EUR), so their items cannot be ranked against each other; split by Cur first."
            );
        }
        // under a single-currency node the comparison is fair, and the amounts carry their currency
        let t = run(&e, json!({"table":"T","measure":{"field":"Amt","currency":"Cur"},"splits":[{"path":[],"field":"Branch"}],
            "suggest":{"at":[step("Branch","Lisbon")],"fields":["Make"]}}));
        let s = t.suggestion.unwrap();
        assert_eq!(s.field.as_deref(), Some("Make"));
        assert!(s.text.contains("Its largest item, A, has sum of Amt 500 EUR."), "{}", s.text);
        let t = run(&e, json!({"table":"T","measure":{"field":"Amt","currency":"Cur"},"splits":[{"path":[],"field":"Branch"}],
            "suggest":{"at":[step("Branch","Lisbon")],"fields":["Make"],"rule":"relative"}}));
        assert!(t.suggestion.unwrap().text.contains("(500 EUR against 450 EUR)"));
    }

    /// Large debits and credits that net to cents: the children's compensated parts are added, so
    /// a ledger that balances is not reported as "differs" (rounded child totals would be ~1e-10 off
    /// against a parent of 0.03, far beyond 15 digits of it).
    #[test]
    fn sum_check_adds_the_childrens_parts_not_their_rounded_totals() {
        let rows = vec![
            vec!["Account".to_string(), "Side".into(), "Amount".into(), "Cur".into(), "One".into()],
            vec!["Cash".into(), "D".into(), "1234567.89".into(), "AOA".into(), "1".into()],
            vec!["Bank".into(), "D".into(), "3765432.24".into(), "AOA".into(), "1".into()],
            vec!["Receivables".into(), "D".into(), "0.03".into(), "AOA".into(), "1".into()],
            vec!["Payables".into(), "C".into(), "-2500000.08".into(), "AOA".into(), "1".into()],
            vec!["Equity".into(), "C".into(), "-2500000.05".into(), "AOA".into(), "1".into()],
        ];
        let e = table("GL", rows.clone());
        let t = run(&e, json!({"table":"GL","measure":{"field":"Amount"},"splits":[{"path":[],"field":"Side"}]}));
        let c = &t.root.split.as_ref().unwrap().check;
        assert_eq!(c.status, "ok", "{:?}", c);
        assert_eq!(c.parent, t.root.value.value);
        assert!(numbers_equal(c.sum_of_children.unwrap(), c.parent.unwrap()));
        // a ratio's numerators
        let t = run(&e, json!({"table":"GL","measure":{"agg":"ratio","numerator":"Amount","denominator":"One"},"splits":[{"path":[],"field":"Side"}]}));
        assert_eq!(t.root.split.as_ref().unwrap().check.parts_ok, Some(true));
        // and per currency, when a euro row makes the node mixed
        let mut mixed = rows;
        mixed.push(vec!["Petty".into(), "D".into(), "5".into(), "EUR".into(), "1".into()]);
        let e = table("GL", mixed);
        let t = run(&e, json!({"table":"GL","measure":{"field":"Amount","currency":"Cur"},"splits":[{"path":[],"field":"Side"}]}));
        assert_eq!(t.root.value.status, "mixed_currency");
        let c = &t.root.split.as_ref().unwrap().check;
        assert_eq!(c.status, "ok", "{:?}", c);
        assert!(c.by_currency.iter().all(|x| x.status == "ok"));
    }

    fn mk_w(m: &Measure, rows: Vec<u32>, xs: &[f64]) -> W {
        let mut acc = Acc::default();
        for &x in xs {
            acc.sum.add(x);
            acc.n += 1;
        }
        acc.rows = rows.len() as u64;
        let value = m.result(&acc);
        W {
            kind: "value",
            label: String::new(),
            key: None,
            ckey: None,
            k: None,
            folded: vec![],
            rank: None,
            pinned: false,
            path: vec![],
            nkeys: 0,
            rows,
            acc,
            value,
            share: None,
            split: None,
        }
    }

    /// The reconciliation can say no: children that do not add up give "differs" with both
    /// figures, a child with no single value gives "not_assessable", and parts that do not add up
    /// give parts_ok false. (A tree built from real rows always adds up, so these feed check_of
    /// children that do not.)
    #[test]
    fn check_reports_differs_and_not_assessable() {
        let e = tree_book();
        let q = |m: serde_json::Value| Query {
            table: "Fleet".into(),
            measures: vec![serde_json::from_value(m).unwrap()],
            ..Default::default()
        };
        let sum_q = q(json!({"field":"Amount"}));
        let p = plan(&e.wb, &sum_q).unwrap();
        let m = &p.measures[0];
        let parent = mk_w(m, vec![0, 1, 2], &[4.0, 5.0, 1.0]);
        // a dropped child: 4 + 5 against 10, and one row short
        let (a, b) = (mk_w(m, vec![0], &[4.0]), mk_w(m, vec![1], &[5.0]));
        let c = check_of(m, &parent, &[&a, &b]);
        assert_eq!((c.kind, c.status, c.parent, c.sum_of_children, c.rows_ok), ("sum", "differs", Some(10.0), Some(9.0), false));
        assert_eq!(c.text, "children do not add up to the parent");
        // all three: ok, with the independent figures
        let z = mk_w(m, vec![2], &[1.0]);
        let c = check_of(m, &parent, &[&a, &b, &z]);
        assert_eq!((c.status, c.parent, c.sum_of_children, c.rows_ok), ("ok", Some(10.0), Some(10.0), true));
        // a child without a single value
        let mut odd = mk_w(m, vec![2], &[1.0]);
        odd.value.value = None;
        odd.value.status = "mixed_currency";
        let c = check_of(m, &parent, &[&a, &b, &odd]);
        assert_eq!((c.status, c.sum_of_children), ("not_assessable", None));
        assert_eq!(c.text, "cannot be checked: a child has no single value");
        // a no_data child adds nothing; a no_data parent with children worth 0 is ok
        let empty = mk_w(m, vec![2], &[]);
        assert_eq!(empty.value.status, "no_data");
        assert_eq!(check_of(m, &parent, &[&a, &b, &empty]).status, "differs");
        let none = mk_w(m, vec![0], &[]);
        assert_eq!(check_of(m, &none, &[&mk_w(m, vec![0], &[])]).status, "ok");
        // an average whose parts do not add up
        let avg_q = q(json!({"field":"Amount","agg":"average"}));
        let pa = plan(&e.wb, &avg_q).unwrap();
        let ma = &pa.measures[0];
        let c = check_of(ma, &mk_w(ma, vec![0, 1], &[4.0, 6.0]), &[&mk_w(ma, vec![0], &[4.0]), &mk_w(ma, vec![1], &[])]);
        assert_eq!((c.kind, c.status, c.parts_ok), ("children_do_not_sum", "recomputed", Some(false)));
        // per currency: EUR does not add up
        let cur_q = q(json!({"field":"Amount","currency":"Currency"}));
        let pc = plan(&e.wb, &cur_q).unwrap();
        let mc = &pc.measures[0];
        let with = |xs: &[(&str, f64)]| {
            let mut w = mk_w(mc, vec![0], &[]);
            for (code, x) in xs {
                let en = w.acc.by_currency.entry(code.to_string()).or_default();
                en.0.add(*x);
                en.1 += 1;
            }
            w.value = mc.result(&w.acc);
            w
        };
        let parent = with(&[("AOA", 10.0), ("EUR", 3.0)]);
        assert_eq!(parent.value.status, "mixed_currency");
        let c = check_of(mc, &parent, &[&with(&[("AOA", 10.0)]), &with(&[("EUR", 2.0)])]);
        assert_eq!(c.status, "not_assessable");
        let per: Vec<(&str, f64, f64, &str)> = c.by_currency.iter().map(|x| (x.currency.as_str(), x.parent, x.sum_of_children, x.status)).collect();
        assert_eq!(per, vec![("AOA", 10.0, 10.0, "ok"), ("EUR", 3.0, 2.0, "differs")]);
    }

    /// A selected node that a cross-filter or a lower top N folds into Other is said to be there,
    /// not "filtered out".
    #[test]
    fn a_node_folded_into_other_is_said_to_be_in_other() {
        let e = tree_book();
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":3,"splits":[{"path":[],"field":"Branch"}],
            "suggest":{"at":[step("Branch","cabinda")]}}));
        assert!(child(&t.root, "Other (4)").folded.iter().any(|v| v.to_display() == "Cabinda"));
        let s = t.suggestion.unwrap();
        assert_eq!(s.field, None);
        assert_eq!(s.text, "No split suggested: this node is no longer in the tree (cabinda is now inside Other (4) under Branch, outside the top 3)");
        // a key that is really gone keeps the other reason
        let t = run(&e, json!({"table":"Fleet","measure":{"field":"Amount"},"top_n":3,"splits":[{"path":[],"field":"Branch"}],
            "suggest":{"at":[step("Branch","Nowhere")]}}));
        assert!(t.suggestion.unwrap().text.contains("Nowhere is no longer under Branch (filtered out or changed)"));
    }

    /// A column without a header, or with the same header as an earlier one, cannot be split by
    /// (a split names its field by header), so it is never suggested.
    #[test]
    fn suggestion_skips_blank_and_duplicate_headers() {
        let rows = vec![
            vec!["Branch".to_string(), "".into(), "Amt".into(), "Branch ".into()],
            vec!["A".into(), "x".into(), "100".into(), "p".into()],
            vec!["A".into(), "y".into(), "1".into(), "q".into()],
            vec!["B".into(), "x".into(), "5".into(), "p".into()],
            vec!["B".into(), "y".into(), "2".into(), "q".into()],
        ];
        let e = table("T", rows);
        for at in [json!([step("Branch", "A")]), json!([])] {
            let t = run(&e, json!({"table":"T","measure":{"field":"Amt"},"splits":[{"path":[],"field":"Branch"}],"suggest":{"at":at}}));
            let s = t.suggestion.unwrap();
            let why: Vec<(String, Option<String>)> = s.candidates.iter().map(|c| (c.field.clone(), c.skipped.clone())).collect();
            assert!(why.contains(&("".to_string(), Some("no header (column 2)".to_string()))), "{:?}", why);
            assert!(why.contains(&("Branch ".to_string(), Some("same header as column 1".to_string()))), "{:?}", why);
            assert!(s.field.as_deref() != Some("") && s.field.as_deref() != Some("Branch "), "{:?}", s.field);
            // whatever is suggested can be accepted
            if let Some(f) = s.field {
                let path = s.at.clone();
                let mut splits = vec![json!({"path":[],"field":"Branch"})];
                if !path.is_empty() {
                    splits.push(json!({"path":path,"field":f}));
                }
                decompose(&e.wb, &dq(json!({"table":"T","measure":{"field":"Amt"},"splits":splits}))).unwrap();
            }
        }
    }

    /// '/', '=' and '%' inside a header or a key are escaped in node ids, so a key such as
    /// "a/make=s:kia" cannot produce the id of a deeper node.
    #[test]
    fn node_ids_are_unique_whatever_the_key_text() {
        let rows = vec![
            vec!["Branch".to_string(), "Make".into(), "V".into()],
            vec!["a".into(), "kia".into(), "1".into()],
            vec!["a".into(), "ford".into(), "2".into()],
            vec!["a/make=s:kia".into(), "kia".into(), "4".into()],
            vec!["z".into(), "kia".into(), "8".into()],
            vec!["5% off".into(), "kia".into(), "16".into()],
        ];
        let e = table("T", rows);
        let t = run(&e, json!({"table":"T","measure":{"field":"V"},"splits":[{"path":[],"field":"Branch"},{"path":[step("Branch","a")],"field":"Make"}]}));
        let ids: Vec<String> = all_nodes(&t.root).iter().map(|n| n.id.clone()).collect();
        let unique: HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "{:?}", ids);
        assert_eq!(child(&t.root, "a/make=s:kia").id, "r/branch=s:a%2Fmake%3Ds:kia");
        assert_eq!(child(&t.root, "5% off").id, "r/branch=s:5%25 off");
        assert_eq!(child(child(&t.root, "a"), "kia").id, "r/branch=s:a/make=s:kia");
        // the suggestion's node id uses the same escaping
        let t = run(&e, json!({"table":"T","measure":{"field":"V"},"splits":[{"path":[],"field":"Branch"}],"suggest":{"at":[step("Branch","a/make=s:kia")]}}));
        assert_eq!(t.suggestion.unwrap().node_id, "r/branch=s:a%2Fmake%3Ds:kia");
    }
}
