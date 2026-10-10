//! Data validation rules: list membership, numeric/date bounds, text length.

use crate::formula;
use crate::model::{CellKey, TableId, Validation, Value, Workbook};

/// Check a typed input against the rules covering the cell. `Ok(())` when valid.
pub fn check(wb: &Workbook, table: TableId, key: CellKey, input: &str) -> Result<(), String> {
    let t = match wb.table(table) {
        Some(t) => t,
        None => return Ok(()),
    };
    for rule in &t.validations {
        if key.row < rule.r0 || key.row > rule.r1 || key.col < rule.c0 || key.col > rule.c1 {
            continue;
        }
        if let Err(msg) = check_rule(wb, table, key, rule, input) {
            return Err(rule.message.clone().unwrap_or(msg));
        }
    }
    Ok(())
}

fn check_rule(wb: &Workbook, table: TableId, _key: CellKey, rule: &Validation, input: &str) -> Result<(), String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return if rule.allow_blank { Ok(()) } else { Err("a value is required".into()) };
    }
    if trimmed.starts_with('=') {
        // formulas are checked on their result by the host after evaluation; accept here
        return Ok(());
    }
    let value = Value::parse_literal(trimmed);
    match rule.kind.as_str() {
        "list" => {
            let entries = list_entries(wb, table, rule);
            let needle = value.to_display().trim().to_lowercase();
            if entries.iter().any(|e| e.trim().to_lowercase() == needle) {
                Ok(())
            } else {
                let shown: Vec<&str> = entries.iter().take(8).map(|s| s.as_str()).collect();
                Err(format!("value must be one of: {}{}", shown.join(", "), if entries.len() > 8 { ", …" } else { "" }))
            }
        }
        "number" | "integer" | "date" => {
            let x = match &value {
                Value::Number(x) => *x,
                Value::Text(s) => match formula::eval::parse_date_time_text(s) {
                    Some((d, _)) => d,
                    None => return Err(format!("a {} is required", if rule.kind == "date" { "date" } else { "number" })),
                },
                _ => return Err(format!("a {} is required", if rule.kind == "date" { "date" } else { "number" })),
            };
            if rule.kind == "integer" && x.fract() != 0.0 {
                return Err("a whole number is required".into());
            }
            compare_bounds(wb, table, x, rule, if rule.kind == "date" { "date" } else { "value" })
        }
        "text_length" => compare_bounds(wb, table, trimmed.chars().count() as f64, rule, "length"),
        _ => Ok(()),
    }
}

fn bound(wb: &Workbook, table: TableId, s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Value::Number(x) = Value::parse_literal(s) {
        return Some(x);
    }
    // a reference or expression such as =Limits::B2
    let body = s.trim_start_matches('=');
    match formula::evaluate(wb, table, None, body) {
        Value::Number(x) => Some(x),
        _ => None,
    }
}

fn compare_bounds(wb: &Workbook, table: TableId, x: f64, rule: &Validation, what: &str) -> Result<(), String> {
    let op = rule.op.as_deref().unwrap_or("between");
    let a = rule.values.first().and_then(|s| bound(wb, table, s)).unwrap_or(f64::NEG_INFINITY);
    let b = rule.values.get(1).and_then(|s| bound(wb, table, s)).unwrap_or(f64::INFINITY);
    let fmt = |v: f64| crate::model::format_number(v);
    let ok = match op {
        "between" => x >= a && x <= b,
        "not_between" => x < a || x > b,
        "gt" => x > a,
        "ge" => x >= a,
        "lt" => x < a,
        "le" => x <= a,
        "eq" => x == a,
        "ne" => x != a,
        _ => true,
    };
    if ok {
        Ok(())
    } else {
        Err(match op {
            "between" => format!("{} must be between {} and {}", what, fmt(a), fmt(b)),
            "not_between" => format!("{} must not be between {} and {}", what, fmt(a), fmt(b)),
            "gt" => format!("{} must be greater than {}", what, fmt(a)),
            "ge" => format!("{} must be at least {}", what, fmt(a)),
            "lt" => format!("{} must be less than {}", what, fmt(a)),
            "le" => format!("{} must be at most {}", what, fmt(a)),
            "eq" => format!("{} must equal {}", what, fmt(a)),
            _ => format!("{} must not equal {}", what, fmt(a)),
        })
    }
}

impl Value {
    pub fn into_number(self) -> Option<f64> {
        match self {
            Value::Number(x) => Some(x),
            Value::Text(s) => formula::eval::parse_date_time_text(&s).map(|d| d.0),
            _ => None,
        }
    }
}

/// Entries of a list rule: literal entries, or the values of a single range reference.
pub fn list_entries(wb: &Workbook, table: TableId, rule: &Validation) -> Vec<String> {
    if rule.values.len() == 1 {
        let s = rule.values[0].trim().trim_start_matches('=');
        if let Ok(expr) = formula::parse(s) {
            if let formula::Expr::Ref(_) | formula::Expr::Name(_) = expr {
                let ctx = formula::Ctx {
                    wb,
                    table,
                    now: wb.now_serial,
                    at: None,
                    locals: vec![],
                };
                let vals = formula::eval(&expr, &ctx).values();
                return vals.into_iter().filter(|v| !v.is_empty()).map(|v| v.to_display()).collect();
            }
        }
        // comma separated in one string
        if s.contains(',') {
            return s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
        }
    }
    rule.values.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}
