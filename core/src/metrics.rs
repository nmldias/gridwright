//! Governed metrics (13 Oct 2026 assessment, 7.5): a workbook keeps named definitions of its
//! measures, changed only by operations (`SetMetric`, `RenameMetric`, undo through
//! `RestoreMetrics`), and every analytical consumer refers to one by name
//! (`MeasureSpec.metric`) instead of restating it, so one definition is used everywhere:
//!
//! * **Definition.** A name, the table it reads, a measure spec (field / aggregation /
//!   numerator / denominator / currency column), an optional reporting currency, a display
//!   format and a description. It is checked when defined: the table must exist and the
//!   measure must resolve against it, so a bad field or aggregation is refused at once.
//! * **Reference.** A spec carrying `metric` and nothing else (a `name` may relabel it) is
//!   replaced by the stored definition inside `analytic::plan`, so `analyze`, `records` and
//!   `decompose` all go through the same code. The query's table may be left empty; a query
//!   naming another table, or metrics on two tables, is an error.
//! * **Change.** References hold only the name, so a redefinition reaches every chart, tree
//!   and watch. Renaming a metric rewrites the charts that refer to it; removing one leaves
//!   references failing with `no metric named "X"`, never a silent number. A later drift in
//!   the data (a renamed column, a deleted table) fails the same way, prefixed `metric "X": `.
//! * **Currency.** The measure's currency column still keeps currencies apart. The metric's
//!   reporting currency labels the value; with a currency column, amounts in any other code
//!   give `currency_mismatch` with the amount per currency. Nothing is converted.

use crate::analytic::{find_table, resolve_measures, MeasureSpec};
use crate::model::{Chart, Metric, Workbook};

/// At most this many metrics per workbook.
pub const MAX_METRICS: usize = 500;
/// Characters in a metric's name.
pub const MAX_METRIC_NAME: usize = 64;
/// Characters in a metric's format pattern.
pub const MAX_METRIC_FORMAT: usize = 64;
/// Characters in a metric's description.
pub const MAX_METRIC_DESCRIPTION: usize = 2_000;

/// A metric name as stored (trimmed), or why it is not one.
pub fn check_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("a metric needs a name".into());
    }
    if n.chars().count() > MAX_METRIC_NAME {
        return Err(format!("a metric name has at most {} characters", MAX_METRIC_NAME));
    }
    let first = n.chars().next().unwrap_or(' ');
    if !first.is_alphabetic() || !n.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '_' | '.' | '-')) {
        return Err("a metric name starts with a letter and contains only letters, digits, spaces, '_', '.' or '-'".into());
    }
    if crate::formula::parse(n).map(|e| matches!(e, crate::formula::Expr::Ref(_))).unwrap_or(false) {
        return Err("that looks like a cell reference".into());
    }
    Ok(n.to_string())
}

/// Check a definition against the workbook and return it in its stored form: names trimmed,
/// the table spelled as the workbook spells it, the currency code upper case, no label on the
/// measure (the metric's name is its label).
pub fn canonical(wb: &Workbook, m: Metric) -> Result<Metric, String> {
    let name = check_name(&m.name)?;
    let table = m.table.trim();
    if table.is_empty() {
        return Err("a metric needs a table".into());
    }
    let t = find_table(wb, table).ok_or_else(|| format!("no table named \"{}\"", table))?;
    if t.header_rows == 0 {
        return Err(format!("table \"{}\" has no header row to name its fields", t.name));
    }
    if !m.measure.metric.trim().is_empty() {
        return Err("a metric cannot refer to another metric".into());
    }
    let measure = MeasureSpec {
        name: String::new(),
        field: m.measure.field.trim().to_string(),
        agg: m.measure.agg.trim().to_lowercase(),
        numerator: m.measure.numerator.trim().to_string(),
        denominator: m.measure.denominator.trim().to_string(),
        currency: m.measure.currency.trim().to_string(),
        metric: String::new(),
    };
    let resolved = resolve_measures(t, std::slice::from_ref(&measure))?;
    let currency = m.currency.trim().to_uppercase();
    if !currency.is_empty() {
        if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_uppercase()) {
            return Err("a reporting currency is a three-letter code such as EUR or AOA".into());
        }
        if matches!(resolved[0].info.agg.as_str(), "count" | "count_distinct") {
            return Err("a count has no currency".into());
        }
    }
    let format = m.format.trim().to_string();
    if format.chars().count() > MAX_METRIC_FORMAT {
        return Err(format!("a metric format has at most {} characters", MAX_METRIC_FORMAT));
    }
    let description = m.description.trim().to_string();
    if description.chars().count() > MAX_METRIC_DESCRIPTION {
        return Err(format!("a metric description has at most {} characters", MAX_METRIC_DESCRIPTION));
    }
    Ok(Metric {
        name,
        table: t.name.clone(),
        measure,
        currency,
        format,
        description,
    })
}

/// Measure specs with every metric reference replaced by its definition, and the table the
/// query reads (the metrics' table when the query names none).
pub(crate) struct Resolved<'a> {
    pub table: String,
    pub specs: Vec<MeasureSpec>,
    pub metrics: Vec<Option<&'a Metric>>,
}

pub(crate) fn resolve<'a>(wb: &'a Workbook, table: &str, specs: &[MeasureSpec]) -> Result<Resolved<'a>, String> {
    if specs.iter().all(|s| s.metric.trim().is_empty()) {
        return Ok(Resolved {
            table: table.to_string(),
            specs: specs.to_vec(),
            metrics: vec![None; specs.len()],
        });
    }
    let named = !table.trim().is_empty();
    let query_table = if named { find_table(wb, table) } else { None };
    let mut first: Option<(&Metric, &crate::model::Table)> = None;
    let mut out = Resolved {
        table: table.to_string(),
        specs: Vec::with_capacity(specs.len()),
        metrics: Vec::with_capacity(specs.len()),
    };
    for s in specs {
        let reference = s.metric.trim();
        if reference.is_empty() {
            out.specs.push(s.clone());
            out.metrics.push(None);
            continue;
        }
        let own = [&s.field, &s.agg, &s.numerator, &s.denominator, &s.currency];
        if own.iter().any(|f| !f.trim().is_empty()) {
            return Err(format!("metric \"{}\": a reference to a metric carries no definition of its own", reference));
        }
        let m = wb.metric_by_name(reference).ok_or_else(|| format!("no metric named \"{}\"", reference))?;
        let mt = find_table(wb, &m.table).ok_or_else(|| format!("metric \"{}\": no table named \"{}\"", m.name, m.table))?;
        if named {
            // a table the workbook does not have is reported by the plan as for any query
            if let Some(qt) = query_table {
                if qt.id != mt.id {
                    return Err(format!("metric \"{}\" is defined on table \"{}\", not \"{}\"", m.name, mt.name, qt.name));
                }
            }
        } else {
            match first {
                None => first = Some((m, mt)),
                Some((fm, ft)) if ft.id != mt.id => {
                    return Err(format!(
                        "metrics \"{}\" and \"{}\" are defined on different tables (\"{}\", \"{}\")",
                        fm.name, m.name, ft.name, mt.name
                    ))
                }
                Some(_) => {}
            }
        }
        let mut spec = m.measure.clone();
        spec.metric = String::new();
        spec.name = if s.name.trim().is_empty() { m.name.clone() } else { s.name.trim().to_string() };
        out.specs.push(spec);
        out.metrics.push(Some(m));
    }
    if let (false, Some((_, ft))) = (named, first) {
        out.table = ft.name.clone();
    }
    Ok(out)
}

/// Point the charts' references to metric `from` at `to` (ignoring case); whether any changed.
pub(crate) fn rename_references(charts: &mut [Chart], from: &str, to: &str) -> bool {
    let from = from.trim().to_lowercase();
    let mut changed = false;
    for c in charts.iter_mut() {
        if let Some(an) = c.analytic.as_mut() {
            for m in an.measures.iter_mut() {
                if !m.metric.is_empty() && m.metric.trim().to_lowercase() == from && m.metric != to {
                    m.metric = to.to_string();
                    changed = true;
                }
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytic::{analyze, records, Query};
    use crate::decompose::{decompose, DecompQuery};
    use crate::engine::{Engine, Op};
    use crate::model::ChartAnalytic;

    fn book() -> Engine {
        crate::analytic::tests::book()
    }

    fn metric(name: &str, json: serde_json::Value) -> Metric {
        let mut m: Metric = serde_json::from_value(json).unwrap();
        m.name = name.into();
        m
    }

    fn set(e: &mut Engine, m: Metric) -> crate::engine::Changes {
        e.apply(Op::SetMetric {
            name: m.name.clone(),
            metric: Some(m),
        })
    }

    fn revenue() -> Metric {
        metric(
            "Revenue",
            serde_json::json!({"table":"Stock","measure":{"field":"Price","agg":"sum"},"format":"#,##0.00","description":"Asking price of the stock"}),
        )
    }

    fn q(json: serde_json::Value) -> Query {
        serde_json::from_value(json).unwrap()
    }

    fn bound_chart(metric: &str) -> Chart {
        Chart {
            analytic: Some(ChartAnalytic {
                table: "Stock".into(),
                dims: vec!["Branch".into()],
                measures: vec![MeasureSpec {
                    metric: metric.into(),
                    ..Default::default()
                }],
                sort: String::new(),
            }),
            ..Chart::default()
        }
    }

    fn chart_query(e: &Engine, i: usize) -> Query {
        let an = e.wb.charts[i].analytic.as_ref().unwrap();
        Query {
            table: an.table.clone(),
            dims: an.dims.clone(),
            measures: an.measures.clone(),
            ..Default::default()
        }
    }

    #[test]
    fn a_metric_is_an_undoable_operation_saved_with_the_workbook() {
        let mut e = book();
        let plain = serde_json::to_string(&e.wb).unwrap();
        assert!(!plain.contains("metrics"), "a workbook without metrics serialises as before");
        let ch = set(&mut e, revenue());
        assert!(ch.error.is_none(), "{:?}", ch.error);
        assert_eq!(ch.metrics.as_ref().map(|m| m.len()), Some(1));
        let json = serde_json::to_string(&e.wb).unwrap();
        assert!(json.contains(r#""metrics":[{"name":"Revenue","table":"Stock","measure":{"name":"","field":"Price","agg":"sum""#), "{}", json);
        let back: Workbook = serde_json::from_str(&json).unwrap();
        assert_eq!(back.metrics, e.wb.metrics);
        let ch = e.undo();
        assert!(e.wb.metrics.is_empty());
        assert_eq!(ch.metrics.as_ref().map(|m| m.len()), Some(0));
        assert!(matches!(ch.ops.last(), Some(Op::RestoreMetrics { metrics }) if metrics.is_empty()));
        let ch = e.redo();
        assert_eq!(e.wb.metrics.len(), 1);
        assert!(matches!(ch.ops.last(), Some(Op::RestoreMetrics { metrics }) if metrics.len() == 1));
        // the relay form applies like any op and is itself undoable
        let mut other = book();
        other.apply_remote(ch.ops[0].clone());
        assert_eq!(other.wb.metrics, e.wb.metrics);
        assert_eq!(serde_json::to_string(&other.wb).unwrap(), serde_json::to_string(&e.wb).unwrap());
        // removing it is an op too, and the workbook serialises as before again
        let ch = e.apply(Op::SetMetric {
            name: "revenue".into(),
            metric: None,
        });
        assert!(ch.error.is_none());
        assert_eq!(serde_json::to_string(&e.wb).unwrap(), plain);
        let ch = e.apply(Op::SetMetric {
            name: "Revenue".into(),
            metric: None,
        });
        assert_eq!(ch.error.as_deref(), Some("no metric named \"Revenue\""));
    }

    #[test]
    fn metric_names_follow_rules_and_are_unique_ignoring_case() {
        let mut e = book();
        for (bad, msg) in [
            ("", "a metric needs a name"),
            ("1st margin", "starts with a letter"),
            ("Margin%", "starts with a letter"),
            ("A1", "cell reference"),
            ("Net revenue (EUR)", "starts with a letter"),
        ] {
            let ch = set(&mut e, metric(bad, serde_json::json!({"table":"Stock","measure":{"field":"Price"}})));
            assert!(ch.error.as_deref().unwrap_or("").contains(msg), "{:?} → {:?}", bad, ch.error);
        }
        let long = "M".repeat(MAX_METRIC_NAME + 1);
        let ch = set(&mut e, metric(&long, serde_json::json!({"table":"Stock","measure":{"field":"Price"}})));
        assert_eq!(ch.error.as_deref(), Some("a metric name has at most 64 characters"));
        assert!(e.wb.metrics.is_empty());
        assert!(set(&mut e, metric("Net revenue-2.a_b", serde_json::json!({"table":"Stock","measure":{"field":"Price"}}))).error.is_none());
        // the same name in other case replaces it (upsert), it does not add a second
        set(&mut e, revenue());
        let ch = set(&mut e, metric("REVENUE", serde_json::json!({"table":"Stock","measure":{"field":"Price","agg":"average"}})));
        assert!(ch.error.is_none());
        assert_eq!(e.wb.metrics.len(), 2);
        assert_eq!(e.wb.metric_by_name("revenue").unwrap().measure.agg, "average");
        // the op's name and the definition's name must agree: a rename is its own op
        let ch = e.apply(Op::SetMetric {
            name: "Revenue".into(),
            metric: Some(metric("Turnover", serde_json::json!({"table":"Stock","measure":{"field":"Price"}}))),
        });
        assert_eq!(ch.error.as_deref(), Some("use rename_metric to change a metric's name"));
        // a definition without a name takes the op's
        let ch = e.apply(Op::SetMetric {
            name: "Units".into(),
            metric: Some(metric("", serde_json::json!({"table":"Stock","measure":{"agg":"count"}}))),
        });
        assert!(ch.error.is_none());
        assert!(e.wb.metric_by_name("units").is_some());
        // sorted by name ignoring case
        let names: Vec<&str> = e.wb.metrics.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Net revenue-2.a_b", "REVENUE", "Units"]);
    }

    #[test]
    fn a_bad_definition_is_refused_when_defined() {
        let mut e = book();
        let cases = [
            (serde_json::json!({"table":"Nope","measure":{"field":"Price"}}), "no table named \"Nope\""),
            (serde_json::json!({"measure":{"field":"Price"}}), "a metric needs a table"),
            (serde_json::json!({"table":"Stock","measure":{"field":"Colour"}}), "field \"Colour\" is not a header of table \"Stock\""),
            (serde_json::json!({"table":"Stock","measure":{"field":"Price","agg":"median"}}), "unknown aggregation \"median\""),
            (serde_json::json!({"table":"Stock","measure":{"agg":"ratio","numerator":"Price"}}), "a ratio needs a numerator and a denominator field"),
            (serde_json::json!({"table":"Stock","measure":{"metric":"Revenue"}}), "a metric cannot refer to another metric"),
            (serde_json::json!({"table":"Stock","measure":{"field":"Price"},"currency":"eur1"}), "a reporting currency is a three-letter code such as EUR or AOA"),
            (serde_json::json!({"table":"Stock","measure":{"agg":"count"},"currency":"EUR"}), "a count has no currency"),
            (serde_json::json!({"table":"Stock","measure":{"field":"Price"},"format":"0".repeat(65)}), "a metric format has at most 64 characters"),
            (serde_json::json!({"table":"Stock","measure":{"field":"Price"},"description":"x".repeat(2001)}), "a metric description has at most 2000 characters"),
        ];
        for (json, msg) in cases {
            let ch = set(&mut e, metric("Bad", json.clone()));
            assert!(ch.error.as_deref().unwrap_or("").contains(msg), "{} → {:?}", json, ch.error);
        }
        assert!(e.wb.metrics.is_empty());
        // stored canonically: code upper case, no label on the measure, the table as spelled
        let ch = set(
            &mut e,
            metric("Price EUR", serde_json::json!({"table":" stock ","measure":{"name":"label","field":" Price ","agg":"SUM"},"currency":"eur","format":" #,##0 "})),
        );
        assert!(ch.error.is_none(), "{:?}", ch.error);
        let m = e.wb.metric_by_name("price eur").unwrap();
        assert_eq!((m.table.as_str(), m.currency.as_str(), m.format.as_str()), ("Stock", "EUR", "#,##0"));
        assert_eq!((m.measure.name.as_str(), m.measure.field.as_str(), m.measure.agg.as_str()), ("", "Price", "sum"));
    }

    #[test]
    fn at_most_500_metrics() {
        let mut e = book();
        for i in 0..MAX_METRICS {
            let ch = set(&mut e, metric(&format!("M{}x", i), serde_json::json!({"table":"Stock","measure":{"agg":"count"}})));
            assert!(ch.error.is_none());
        }
        let ch = set(&mut e, metric("One more", serde_json::json!({"table":"Stock","measure":{"agg":"count"}})));
        assert_eq!(ch.error.as_deref(), Some("at most 500 metrics per workbook"));
        // replacing one is still allowed
        assert!(set(&mut e, metric("M1x", serde_json::json!({"table":"Stock","measure":{"field":"Price"}}))).error.is_none());
    }

    #[test]
    fn a_reference_gives_the_same_answer_as_the_definition_inline() {
        let mut e = book();
        set(&mut e, revenue());
        let by_ref = analyze(&e.wb, &q(serde_json::json!({"table":"Stock","dims":["Branch"],"measures":[{"metric":"revenue"}]}))).unwrap();
        let inline = analyze(&e.wb, &q(serde_json::json!({"table":"Stock","dims":["Branch"],"measures":[{"field":"Price","agg":"sum","name":"Revenue"}]}))).unwrap();
        assert_eq!(serde_json::to_value(&by_ref.groups).unwrap(), serde_json::to_value(&inline.groups).unwrap());
        assert_eq!(by_ref.total, inline.total);
        assert_eq!(by_ref.total[0].value, Some(652.0));
        let info = &by_ref.measures[0];
        assert_eq!((info.name.as_str(), info.metric.as_str(), info.format.as_str()), ("Revenue", "Revenue", "#,##0.00"));
        assert_eq!(info.description, "Asking price of the stock");
        assert!(info.additive);
        // inline measures carry no metric fields
        assert!(!serde_json::to_string(&inline.measures).unwrap().contains("metric"));
        // a local label overrides the name, not the definition
        let relabelled = analyze(&e.wb, &q(serde_json::json!({"table":"Stock","measures":[{"metric":"Revenue","name":"Asking"}]}))).unwrap();
        assert_eq!(relabelled.measures[0].name, "Asking");
        assert_eq!(relabelled.total[0].value, Some(652.0));
        // a ratio metric stays non-additive
        set(&mut e, metric("Cost ratio", serde_json::json!({"table":"Stock","measure":{"agg":"ratio","numerator":"Landed cost","denominator":"Price"}})));
        let r = analyze(&e.wb, &q(serde_json::json!({"table":"Stock","measures":[{"metric":"Cost ratio"}]}))).unwrap();
        assert!(!r.measures[0].additive && r.reconciliation.is_empty());
    }

    #[test]
    fn the_table_comes_from_the_metric_and_must_agree() {
        let mut e = book();
        set(&mut e, revenue());
        e.apply(Op::AddTable {
            id: None,
            name: Some("Fleet".into()),
            x: 900.0,
            y: 0.0,
            rows: 2,
            cols: 1,
            values: Some(vec![vec!["Km".into()], vec!["5".into()]]),
        });
        set(&mut e, metric("Distance", serde_json::json!({"table":"Fleet","measure":{"field":"Km"}})));
        let a = analyze(&e.wb, &q(serde_json::json!({"measures":[{"metric":"Revenue"}]}))).unwrap();
        assert_eq!((a.table.as_str(), a.total[0].value), ("Stock", Some(652.0)));
        let err = analyze(&e.wb, &q(serde_json::json!({"table":"Fleet","measures":[{"metric":"Revenue"}]}))).unwrap_err();
        assert_eq!(err, "metric \"Revenue\" is defined on table \"Stock\", not \"Fleet\"");
        let err = analyze(&e.wb, &q(serde_json::json!({"measures":[{"metric":"Revenue"},{"metric":"Distance"}]}))).unwrap_err();
        assert_eq!(err, "metrics \"Revenue\" and \"Distance\" are defined on different tables (\"Stock\", \"Fleet\")");
        // a reference cannot also restate a definition
        let err = analyze(&e.wb, &q(serde_json::json!({"measures":[{"metric":"Revenue","field":"Landed cost"}]}))).unwrap_err();
        assert_eq!(err, "metric \"Revenue\": a reference to a metric carries no definition of its own");
        // without metrics an empty table is still an error
        assert!(analyze(&e.wb, &q(serde_json::json!({"measures":[{"field":"Price"}]}))).unwrap_err().contains("no table named"));
    }

    #[test]
    fn a_redefinition_reaches_every_chart_bound_to_the_metric() {
        let mut e = book();
        set(&mut e, revenue());
        e.apply(Op::AddChart { chart: bound_chart("Revenue") });
        let before = analyze(&e.wb, &chart_query(&e, 0)).unwrap();
        assert_eq!(before.total[0].value, Some(652.0));
        let charts = e.wb.charts.clone();
        set(&mut e, metric("Revenue", serde_json::json!({"table":"Stock","measure":{"field":"Price","agg":"max"}})));
        assert_eq!(e.wb.charts, charts, "no chart op: the chart holds only the name");
        let after = analyze(&e.wb, &chart_query(&e, 0)).unwrap();
        assert_eq!(after.total[0].value, Some(220.0));
        assert_eq!(after.measures[0].agg, "max");
    }

    #[test]
    fn removing_a_metric_in_use_fails_loudly_and_undo_brings_it_back() {
        let mut e = book();
        set(&mut e, revenue());
        e.apply(Op::AddChart { chart: bound_chart("Revenue") });
        let ch = e.apply(Op::SetMetric {
            name: "Revenue".into(),
            metric: None,
        });
        assert!(ch.error.is_none());
        assert_eq!(analyze(&e.wb, &chart_query(&e, 0)).unwrap_err(), "no metric named \"Revenue\"");
        e.undo();
        assert_eq!(analyze(&e.wb, &chart_query(&e, 0)).unwrap().total[0].value, Some(652.0));
    }

    #[test]
    fn renaming_a_metric_rewrites_chart_references_and_undoes_both() {
        let mut e = book();
        set(&mut e, revenue());
        e.apply(Op::AddChart { chart: bound_chart("revenue") });
        e.apply(Op::AddChart { chart: bound_chart("Other") });
        let ch = e.apply(Op::RenameMetric {
            name: "REVENUE".into(),
            to: "Asking price".into(),
        });
        assert!(ch.error.is_none(), "{:?}", ch.error);
        assert!(ch.metrics.is_some() && ch.charts.is_some());
        assert_eq!(e.wb.metrics[0].name, "Asking price");
        assert_eq!(e.wb.charts[0].analytic.as_ref().unwrap().measures[0].metric, "Asking price");
        assert_eq!(e.wb.charts[1].analytic.as_ref().unwrap().measures[0].metric, "Other");
        assert_eq!(analyze(&e.wb, &chart_query(&e, 0)).unwrap().measures[0].name, "Asking price");
        let ch = e.undo();
        assert_eq!(e.wb.metrics[0].name, "Revenue");
        assert_eq!(e.wb.charts[0].analytic.as_ref().unwrap().measures[0].metric, "revenue");
        let kinds: Vec<&str> = ch
            .ops
            .iter()
            .map(|o| match o {
                Op::RestoreMetrics { .. } => "metrics",
                Op::RestoreCharts { .. } => "charts",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["metrics", "charts"]);
        e.redo();
        assert_eq!(e.wb.metrics[0].name, "Asking price");
        assert_eq!(e.wb.charts[0].analytic.as_ref().unwrap().measures[0].metric, "Asking price");
        // refusals
        set(&mut e, metric("Units", serde_json::json!({"table":"Stock","measure":{"agg":"count"}})));
        let ch = e.apply(Op::RenameMetric {
            name: "Units".into(),
            to: "asking PRICE".into(),
        });
        assert_eq!(ch.error.as_deref(), Some("a metric named \"Asking price\" already exists"));
        let ch = e.apply(Op::RenameMetric {
            name: "Nope".into(),
            to: "X".into(),
        });
        assert_eq!(ch.error.as_deref(), Some("no metric named \"Nope\""));
        // a change of case only is a rename of the same metric
        assert!(e.apply(Op::RenameMetric { name: "units".into(), to: "UNITS".into() }).error.is_none());
        assert_eq!(e.wb.metric_by_name("units").unwrap().name, "UNITS");
    }

    #[test]
    fn a_table_rename_follows_into_metrics_and_undo_restores_everything() {
        let mut e = book();
        set(&mut e, revenue());
        e.apply(Op::AddChart { chart: bound_chart("Revenue") });
        e.apply(Op::SetName {
            name: "Prices".into(),
            reference: Some("Stock[Price]".into()),
        });
        let id = e.wb.table_by_name("Stock").unwrap().id;
        let ch = e.apply(Op::RenameTable { table: id, name: "Inventory".into() });
        assert!(ch.metrics.is_some());
        assert_eq!(e.wb.metrics[0].table, "Inventory");
        assert_eq!(e.wb.charts[0].analytic.as_ref().unwrap().table, "Inventory");
        assert_eq!(e.wb.names[0].reference, "Inventory[Price]");
        assert_eq!(analyze(&e.wb, &chart_query(&e, 0)).unwrap().total[0].value, Some(652.0));
        let ch = e.undo();
        assert_eq!(e.wb.table(id).unwrap().name, "Stock");
        assert_eq!(e.wb.metrics[0].table, "Stock");
        assert_eq!(e.wb.charts[0].analytic.as_ref().unwrap().table, "Stock", "the chart binding comes back too");
        assert_eq!(e.wb.names[0].reference, "Stock[Price]", "and the named range");
        assert!(ch.ops.iter().any(|o| matches!(o, Op::RestoreMetrics { .. })));
        assert!(ch.ops.iter().any(|o| matches!(o, Op::RestoreCharts { .. })));
        assert!(ch.ops.iter().any(|o| matches!(o, Op::RestoreNames { .. })));
        assert!(ch.ops.iter().any(|o| matches!(o, Op::RestoreTables { .. })));
        assert_eq!(analyze(&e.wb, &chart_query(&e, 0)).unwrap().total[0].value, Some(652.0));
        e.redo();
        assert_eq!(e.wb.metrics[0].table, "Inventory");
        assert_eq!(e.wb.charts[0].analytic.as_ref().unwrap().table, "Inventory");
    }

    #[test]
    fn drift_in_the_data_breaks_a_metric_visibly() {
        let mut e = book();
        set(&mut e, revenue());
        let id = e.wb.table_by_name("Stock").unwrap().id;
        // the Price header is renamed in the sheet
        e.apply(Op::SetCell {
            table: id,
            row: 0,
            col: 5,
            input: "List price".into(),
            kind: None,
            conn: None,
            refresh: None,
            runtime: None,
            gpu: None,
        });
        let err = analyze(&e.wb, &q(serde_json::json!({"measures":[{"metric":"Revenue"}]}))).unwrap_err();
        assert_eq!(err, "metric \"Revenue\": field \"Price\" is not a header of table \"Stock\"");
        e.apply(Op::DeleteTable { table: id });
        let err = analyze(&e.wb, &q(serde_json::json!({"measures":[{"metric":"Revenue"}]}))).unwrap_err();
        assert_eq!(err, "metric \"Revenue\": no table named \"Stock\"");
    }

    #[test]
    fn a_reporting_currency_labels_and_guards_the_value() {
        let mut e = book();
        // no currency column: the code labels the value
        set(&mut e, metric("Price AOA", serde_json::json!({"table":"Stock","measure":{"field":"Price"},"currency":"aoa"})));
        let a = analyze(&e.wb, &q(serde_json::json!({"dims":["Branch"],"measures":[{"metric":"Price AOA"}]}))).unwrap();
        assert_eq!(a.total[0].currency.as_deref(), Some("AOA"));
        assert_eq!(a.measures[0].currency, "AOA");
        // with a currency column: rows in the metric's currency are fine, others are not converted
        set(&mut e, metric("Checked AOA", serde_json::json!({"table":"Stock","measure":{"field":"Price","currency":"Currency"},"currency":"AOA"})));
        let a = analyze(&e.wb, &q(serde_json::json!({"dims":["Brand"],"measures":[{"metric":"Checked AOA"}]}))).unwrap();
        let toyota = a.groups.iter().find(|g| g.label[0] == "Toyota").unwrap();
        assert_eq!((toyota.values[0].status, toyota.values[0].value), ("ok", Some(290.0)));
        assert_eq!(toyota.values[0].currency.as_deref(), Some("AOA"));
        let kia = a.groups.iter().find(|g| g.label[0] == "Kia").unwrap();
        // Kia: one EUR row and one AOA row → mixed; Huambo-only EUR selection → mismatch
        assert_eq!(kia.values[0].status, "mixed_currency");
        let eur = analyze(
            &e.wb,
            &q(serde_json::json!({"measures":[{"metric":"Checked AOA"}],"selections":[{"field":"Currency","values":[{"s":"EUR"}]}]})),
        )
        .unwrap();
        assert_eq!(eur.total[0].status, "currency_mismatch");
        assert_eq!(eur.total[0].value, None);
        assert_eq!(eur.total[0].by_currency.len(), 1);
        assert_eq!((eur.total[0].by_currency[0].currency.as_str(), eur.total[0].by_currency[0].value), ("EUR", 12.0));
        assert!(eur.issues.iter().any(|i| i.kind == "currency_mismatch" && i.text.contains("reports in AOA")));
        assert_eq!(eur.reconciliation[0].status, "not_assessable");
    }

    #[test]
    fn records_and_decomposition_use_the_same_definition() {
        let mut e = book();
        set(&mut e, revenue());
        let sel = serde_json::json!([{"field":"Branch","values":[{"s":"Luanda"}]}]);
        let by_ref = records(&e.wb, &serde_json::from_value(serde_json::json!({"measures":[{"metric":"Revenue"}],"selections":sel,"fields":["VIN","Price"]})).unwrap()).unwrap();
        let inline = records(&e.wb, &serde_json::from_value(serde_json::json!({"table":"Stock","measures":[{"field":"Price"}],"selections":sel,"fields":["VIN","Price"]})).unwrap()).unwrap();
        assert_eq!(by_ref.count, inline.count);
        assert_eq!(by_ref.total, inline.total);
        assert_eq!(by_ref.measures[0].metric, "Revenue");
        let dq = |m: serde_json::Value| -> DecompQuery { serde_json::from_value(serde_json::json!({"table":"Stock","measure":m,"splits":[{"path":[],"field":"Branch"}]})).unwrap() };
        let t1 = decompose(&e.wb, &dq(serde_json::json!({"metric":"Revenue"}))).unwrap();
        let t2 = decompose(&e.wb, &dq(serde_json::json!({"field":"Price","name":"Revenue"}))).unwrap();
        assert_eq!(serde_json::to_value(&t1.root).unwrap(), serde_json::to_value(&t2.root).unwrap());
        assert_eq!(t1.root.split.as_ref().unwrap().check.status, "ok");
        assert_eq!((t1.measure.metric.as_str(), t1.measure.format.as_str()), ("Revenue", "#,##0.00"));
        // the table may be left to the metric
        let t3 = decompose(&e.wb, &serde_json::from_value(serde_json::json!({"measure":{"metric":"Revenue"}})).unwrap()).unwrap();
        assert_eq!((t3.table.as_str(), t3.root.value.value), ("Stock", Some(652.0)));
    }

    #[test]
    fn remote_metric_ops_record_no_undo_and_keep_the_stack() {
        let mut e = book();
        e.apply(Op::SetName {
            name: "P".into(),
            reference: Some("Stock[Price]".into()),
        });
        assert!(e.can_undo());
        let ch = e.apply_remote(Op::SetMetric {
            name: "Revenue".into(),
            metric: Some(revenue()),
        });
        assert!(ch.error.is_none());
        let ch = e.apply_remote(Op::RenameMetric {
            name: "Revenue".into(),
            to: "Sales".into(),
        });
        assert!(ch.error.is_none());
        assert_eq!(e.wb.metrics[0].name, "Sales");
        e.undo();
        assert!(e.wb.names.is_empty(), "our own undo entry is still the top one");
        assert_eq!(e.wb.metrics.len(), 1, "the remote definition stays");
    }
}
