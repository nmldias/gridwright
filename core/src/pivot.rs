//! Pivot tables: group the data rows of a source table by one or more row
//! fields (and optionally one column field) and aggregate value fields.
//! The output is a plain 2-D grid with a header row and optional totals.

use crate::model::{CellKey, PivotSpec, Table, Value};
use std::collections::HashMap;

#[derive(Clone, Debug)]
struct Acc {
    sum: f64,
    count: f64,
    numeric: f64,
    min: Option<f64>,
    max: Option<f64>,
    distinct: Vec<String>,
}

impl Acc {
    fn new() -> Acc {
        Acc {
            sum: 0.0,
            count: 0.0,
            numeric: 0.0,
            min: None,
            max: None,
            distinct: vec![],
        }
    }
    fn add(&mut self, v: &Value, want_distinct: bool) {
        if v.is_empty() {
            return;
        }
        self.count += 1.0;
        if let Value::Number(x) = v {
            self.sum += x;
            self.numeric += 1.0;
            self.min = Some(self.min.map(|m| m.min(*x)).unwrap_or(*x));
            self.max = Some(self.max.map(|m| m.max(*x)).unwrap_or(*x));
        }
        if want_distinct {
            let d = v.to_display();
            if !self.distinct.contains(&d) {
                self.distinct.push(d);
            }
        }
    }
    fn merge(&mut self, o: &Acc) {
        self.sum += o.sum;
        self.count += o.count;
        self.numeric += o.numeric;
        self.min = match (self.min, o.min) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        self.max = match (self.max, o.max) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
        for d in &o.distinct {
            if !self.distinct.contains(d) {
                self.distinct.push(d.clone());
            }
        }
    }
    fn result(&self, agg: &str) -> Value {
        match agg {
            "count" => Value::Number(self.count),
            "average" | "avg" | "mean" => {
                if self.numeric > 0.0 {
                    Value::Number(self.sum / self.numeric)
                } else {
                    Value::Empty
                }
            }
            "min" => self.min.map(Value::Number).unwrap_or(Value::Empty),
            "max" => self.max.map(Value::Number).unwrap_or(Value::Empty),
            "countdistinct" | "count_distinct" | "distinct" => Value::Number(self.distinct.len() as f64),
            _ => {
                if self.numeric > 0.0 || self.count == 0.0 {
                    Value::Number(self.sum)
                } else {
                    Value::Empty
                }
            }
        }
    }
}

fn agg_label(agg: &str) -> &'static str {
    match agg {
        "count" => "Count",
        "average" | "avg" | "mean" => "Average",
        "min" => "Min",
        "max" => "Max",
        "countdistinct" | "count_distinct" | "distinct" => "Distinct",
        _ => "Sum",
    }
}

fn key_cmp(a: &Value, b: &Value) -> std::cmp::Ordering {
    crate::formula::eval::compare_values(a, b)
}

/// Compute the pivot grid for `spec` over the source table.
pub fn compute(src: &Table, spec: &PivotSpec) -> Vec<Vec<Value>> {
    let col_of = |name: &str| src.column_by_header(name);
    let row_cols: Vec<Option<u32>> = spec.rows.iter().map(|f| col_of(f)).collect();
    let col_field: Option<u32> = spec.cols.first().and_then(|f| col_of(f));
    let value_cols: Vec<(Option<u32>, String)> = spec.values.iter().map(|v| (col_of(&v.field), v.agg.to_lowercase())).collect();
    let filters: Vec<(Option<u32>, &Vec<String>)> = spec.filters.iter().map(|f| (col_of(&f.field), &f.values)).collect();

    if spec.rows.is_empty() && col_field.is_none() {
        return vec![vec![Value::Text("Pivot: choose at least one row or column field".into())]];
    }
    if row_cols.iter().any(|c| c.is_none()) || (spec.cols.first().is_some() && col_field.is_none()) || value_cols.iter().any(|(c, _)| c.is_none()) {
        return vec![vec![Value::Text("Pivot: a field name does not match a header of the source table".into())]];
    }
    let want_distinct = value_cols.iter().any(|(_, a)| a.starts_with("countdistinct") || a == "distinct" || a == "count_distinct");

    // group
    type Key = Vec<Value>;
    let mut row_keys: Vec<Key> = vec![];
    let mut col_keys: Vec<Value> = vec![];
    let mut groups: HashMap<(usize, usize), Vec<Acc>> = HashMap::new(); // (row key idx, col key idx) → one Acc per value field
    let find_or_push = |keys: &mut Vec<Key>, k: Key| -> usize {
        match keys.iter().position(|x| x == &k) {
            Some(i) => i,
            None => {
                keys.push(k);
                keys.len() - 1
            }
        }
    };
    for r in src.header_rows..src.rows {
        if src.is_row_hidden(r) {
            continue;
        }
        let mut skip = false;
        for (c, allowed) in &filters {
            if let Some(c) = c {
                let v = src.value_at(CellKey::new(r, *c)).to_display();
                if !allowed.is_empty() && !allowed.contains(&v) {
                    skip = true;
                    break;
                }
            }
        }
        if skip {
            continue;
        }
        let rk: Key = row_cols.iter().map(|c| src.value_at(CellKey::new(r, c.unwrap()))).collect();
        // an entirely blank key row is skipped (trailing empty rows of the source)
        if !rk.is_empty() && rk.iter().all(|v| v.is_empty()) && value_cols.iter().all(|(c, _)| src.value_at(CellKey::new(r, c.unwrap())).is_empty()) {
            continue;
        }
        let ri = find_or_push(&mut row_keys, rk);
        let ci = match col_field {
            Some(c) => {
                let v = src.value_at(CellKey::new(r, c));
                match col_keys.iter().position(|x| x == &v) {
                    Some(i) => i,
                    None => {
                        col_keys.push(v);
                        col_keys.len() - 1
                    }
                }
            }
            None => 0,
        };
        let accs = groups.entry((ri, ci)).or_insert_with(|| vec![Acc::new(); value_cols.len().max(1)]);
        for (i, (c, _)) in value_cols.iter().enumerate() {
            accs[i].add(&src.value_at(CellKey::new(r, c.unwrap())), want_distinct);
        }
        if value_cols.is_empty() {
            accs[0].count += 1.0;
        }
    }
    // sort keys
    let mut row_order: Vec<usize> = (0..row_keys.len()).collect();
    row_order.sort_by(|a, b| {
        for (x, y) in row_keys[*a].iter().zip(row_keys[*b].iter()) {
            let o = key_cmp(x, y);
            if o != std::cmp::Ordering::Equal {
                return o;
            }
        }
        std::cmp::Ordering::Equal
    });
    let mut col_order: Vec<usize> = (0..col_keys.len()).collect();
    col_order.sort_by(|a, b| key_cmp(&col_keys[*a], &col_keys[*b]));

    // value column descriptors: (col key idx or None for "no column field", value field idx)
    let n_vals = value_cols.len().max(1);
    let mut value_slots: Vec<(Option<usize>, usize)> = vec![];
    if col_field.is_some() {
        for ci in &col_order {
            for vi in 0..n_vals {
                value_slots.push((Some(*ci), vi));
            }
        }
    } else {
        for vi in 0..n_vals {
            value_slots.push((None, vi));
        }
    }
    let agg_name = |vi: usize| -> String {
        match value_cols.get(vi) {
            Some((_, agg)) => format!("{} of {}", agg_label(agg), spec.values[vi].field),
            None => "Count".to_string(),
        }
    };
    let agg_of = |vi: usize| -> String { value_cols.get(vi).map(|(_, a)| a.clone()).unwrap_or_else(|| "count".into()) };

    // header
    let mut out: Vec<Vec<Value>> = vec![];
    let mut header: Vec<Value> = spec.rows.iter().map(|f| Value::Text(f.clone())).collect();
    if header.is_empty() {
        header.push(Value::Text(spec.cols.first().cloned().unwrap_or_default()));
    }
    for (ci, vi) in &value_slots {
        let label = match ci {
            Some(ci) => {
                let k = col_keys[*ci].to_display();
                if n_vals > 1 {
                    format!("{} · {}", k, agg_name(*vi))
                } else {
                    k
                }
            }
            None => agg_name(*vi),
        };
        header.push(Value::Text(label));
    }
    if spec.totals && col_field.is_some() {
        for vi in 0..n_vals {
            header.push(Value::Text(if n_vals > 1 { format!("Total · {}", agg_name(vi)) } else { "Total".into() }));
        }
    }
    out.push(header);

    // body
    let mut grand: Vec<Acc> = vec![Acc::new(); value_slots.len() + if spec.totals && col_field.is_some() { n_vals } else { 0 }];
    for ri in &row_order {
        let mut line: Vec<Value> = if spec.rows.is_empty() { vec![Value::Text("All".into())] } else { row_keys[*ri].clone() };
        let mut row_totals: Vec<Acc> = vec![Acc::new(); n_vals];
        for (slot, (ci, vi)) in value_slots.iter().enumerate() {
            let acc = groups.get(&(*ri, ci.unwrap_or(0))).map(|v| v[*vi].clone());
            match acc {
                Some(a) => {
                    line.push(a.result(&agg_of(*vi)));
                    grand[slot].merge(&a);
                    row_totals[*vi].merge(&a);
                }
                None => line.push(Value::Empty),
            }
        }
        if spec.totals && col_field.is_some() {
            for vi in 0..n_vals {
                line.push(row_totals[vi].result(&agg_of(vi)));
                grand[value_slots.len() + vi].merge(&row_totals[vi]);
            }
        }
        out.push(line);
    }
    if spec.totals && !row_order.is_empty() {
        let mut line: Vec<Value> = vec![Value::Text("Total".into())];
        for _ in 1..spec.rows.len().max(1) {
            line.push(Value::Empty);
        }
        for (slot, (_, vi)) in value_slots.iter().enumerate() {
            line.push(grand[slot].result(&agg_of(*vi)));
        }
        if col_field.is_some() {
            for vi in 0..n_vals {
                line.push(grand[value_slots.len() + vi].result(&agg_of(vi)));
            }
        }
        out.push(line);
    }
    out
}
