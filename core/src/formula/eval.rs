//! Formula evaluator and the built-in function library.

use super::parser::{BinOp, Expr, RefExpr, RefKind};
use crate::model::{CellKey, ErrorKind, Rect, TableId, Value, Workbook};

#[derive(Clone, Debug, PartialEq)]
pub struct Array {
    pub rows: u32,
    pub cols: u32,
    pub data: Vec<Value>,
}

impl Array {
    pub fn get(&self, r: u32, c: u32) -> &Value {
        &self.data[(r * self.cols + c) as usize]
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
    Scalar(Value),
    Array(Array),
}

impl Arg {
    pub fn err(e: ErrorKind) -> Arg {
        Arg::Scalar(Value::Error(e))
    }
    /// Collapse to a single value (1×1 arrays collapse; larger arrays are #VALUE!).
    pub fn scalar(self) -> Value {
        match self {
            Arg::Scalar(v) => v,
            Arg::Array(a) => {
                if a.rows == 1 && a.cols == 1 {
                    a.data.into_iter().next().unwrap_or(Value::Empty)
                } else {
                    Value::Error(ErrorKind::Value)
                }
            }
        }
    }
    pub fn values(&self) -> Vec<Value> {
        match self {
            Arg::Scalar(v) => vec![v.clone()],
            Arg::Array(a) => a.data.clone(),
        }
    }
    fn as_array(&self) -> Array {
        match self {
            Arg::Scalar(v) => Array {
                rows: 1,
                cols: 1,
                data: vec![v.clone()],
            },
            Arg::Array(a) => a.clone(),
        }
    }
}

pub struct Ctx<'a> {
    pub wb: &'a Workbook,
    pub table: TableId,
    pub now: f64,
    /// Position of the cell being evaluated (for ROW()/COLUMN()).
    pub at: Option<CellKey>,
}

/// Resolve a reference to a rectangle inside a table, clipped to the table bounds.
pub fn resolve_ref(r: &RefExpr, wb: &Workbook, current: TableId) -> Result<Rect, ErrorKind> {
    let table = match &r.table {
        None => wb.table(current),
        Some(name) => wb.table_by_name(name),
    }
    .ok_or(ErrorKind::Ref)?;
    if table.rows == 0 || table.cols == 0 {
        return Err(ErrorKind::Ref);
    }
    let (r0, c0, r1, c1) = match &r.kind {
        RefKind::Cell { row, col, .. } => (*row, *col, *row, *col),
        RefKind::Range { r0, c0, r1, c1, .. } => (*r0, *c0, *r1, *c1),
        RefKind::Cols { c0, c1 } => (0, *c0, table.rows - 1, *c1),
        RefKind::Rows { r0, r1 } => (*r0, 0, *r1, table.cols - 1),
    };
    if r0 >= table.rows || c0 >= table.cols {
        return Err(ErrorKind::Ref);
    }
    Ok(Rect {
        table: table.id,
        r0,
        c0,
        r1: r1.min(table.rows - 1),
        c1: c1.min(table.cols - 1),
    })
}

/// Every rectangle an expression reads (conservative: ignores short-circuiting).
pub fn collect_deps(e: &Expr, wb: &Workbook, current: TableId) -> Vec<Rect> {
    let mut out = Vec::new();
    super::parser::for_each_ref(e, &mut |r| {
        if let Ok(rect) = resolve_ref(r, wb, current) {
            out.push(rect);
        }
    });
    out
}

fn range_arg(rect: Rect, wb: &Workbook) -> Arg {
    let table = match wb.table(rect.table) {
        Some(t) => t,
        None => return Arg::err(ErrorKind::Ref),
    };
    let rows = rect.rows();
    let cols = rect.cols();
    let mut data = Vec::with_capacity((rows * cols) as usize);
    for r in rect.r0..=rect.r1 {
        for c in rect.c0..=rect.c1 {
            data.push(table.value_at(CellKey::new(r, c)));
        }
    }
    Arg::Array(Array { rows, cols, data })
}

// ---------------------------------------------------------------------------
// coercions
// ---------------------------------------------------------------------------

pub fn to_number(v: &Value) -> Result<f64, ErrorKind> {
    match v {
        Value::Empty => Ok(0.0),
        Value::Number(n) => Ok(*n),
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Text(s) => crate::model::parse_number_literal(s).ok_or(ErrorKind::Value),
        Value::Error(e) => Err(e.clone()),
    }
}

pub fn to_bool(v: &Value) -> Result<bool, ErrorKind> {
    match v {
        Value::Empty => Ok(false),
        Value::Number(n) => Ok(*n != 0.0),
        Value::Bool(b) => Ok(*b),
        Value::Text(s) => match s.trim().to_ascii_uppercase().as_str() {
            "TRUE" => Ok(true),
            "FALSE" => Ok(false),
            _ => Err(ErrorKind::Value),
        },
        Value::Error(e) => Err(e.clone()),
    }
}

pub fn to_text(v: &Value) -> Result<String, ErrorKind> {
    match v {
        Value::Error(e) => Err(e.clone()),
        other => Ok(other.to_display()),
    }
}

fn n(x: f64) -> Arg {
    if x.is_nan() || x.is_infinite() {
        return Arg::err(ErrorKind::Num);
    }
    Arg::Scalar(Value::Number(x))
}
fn t(s: String) -> Arg {
    Arg::Scalar(Value::Text(s))
}
fn b(x: bool) -> Arg {
    Arg::Scalar(Value::Bool(x))
}

macro_rules! try_num {
    ($v:expr) => {
        match to_number(&$v) {
            Ok(x) => x,
            Err(e) => return Arg::err(e),
        }
    };
}
macro_rules! try_text {
    ($v:expr) => {
        match to_text(&$v) {
            Ok(x) => x,
            Err(e) => return Arg::err(e),
        }
    };
}
macro_rules! try_bool {
    ($v:expr) => {
        match to_bool(&$v) {
            Ok(x) => x,
            Err(e) => return Arg::err(e),
        }
    };
}

/// Numbers from a list of args: numbers (and booleans/text-numbers for direct
/// scalar args) are included; text and empties inside ranges are skipped.
fn numbers(args: &[Arg]) -> Result<Vec<f64>, ErrorKind> {
    let mut out = Vec::new();
    for a in args {
        match a {
            Arg::Scalar(v) => match v {
                Value::Empty => {}
                Value::Error(e) => return Err(e.clone()),
                other => out.push(to_number(other)?),
            },
            Arg::Array(arr) => {
                for v in &arr.data {
                    match v {
                        Value::Number(x) => out.push(*x),
                        Value::Error(e) => return Err(e.clone()),
                        _ => {}
                    }
                }
            }
        }
    }
    Ok(out)
}

fn compare(a: &Value, b: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    fn rank(v: &Value) -> u8 {
        match v {
            Value::Empty | Value::Number(_) => 0,
            Value::Text(_) => 1,
            Value::Bool(_) => 2,
            Value::Error(_) => 3,
        }
    }
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.partial_cmp(y).unwrap_or(Equal),
        (Value::Empty, Value::Number(y)) => 0.0f64.partial_cmp(y).unwrap_or(Equal),
        (Value::Number(x), Value::Empty) => x.partial_cmp(&0.0).unwrap_or(Equal),
        (Value::Empty, Value::Empty) => Equal,
        (Value::Text(x), Value::Text(y)) => x.to_lowercase().cmp(&y.to_lowercase()),
        (Value::Empty, Value::Text(y)) => "".cmp(y.to_lowercase().as_str()),
        (Value::Text(x), Value::Empty) => x.to_lowercase().as_str().cmp(""),
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        _ => rank(a).cmp(&rank(b)),
    }
}

// ---------------------------------------------------------------------------
// dates (serial numbers, days since 1899-12-30)
// ---------------------------------------------------------------------------

pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

const UNIX_EPOCH_SERIAL: i64 = 25569; // 1970-01-01

pub fn serial_from_ymd(y: i64, m: i64, d: i64) -> f64 {
    // normalise month overflow like Excel: DATE(2024, 13, 1) = 2025-01-01
    let y2 = y + (m - 1).div_euclid(12);
    let m2 = (m - 1).rem_euclid(12) + 1;
    (days_from_civil(y2, m2, 1) + d - 1 + UNIX_EPOCH_SERIAL) as f64
}

pub fn ymd_from_serial(serial: f64) -> (i64, i64, i64) {
    civil_from_days(serial.floor() as i64 - UNIX_EPOCH_SERIAL)
}

/// Parse ISO-like dates typed as text: 2026-10-08, 2026/10/08, 08/10/2026 (d/m/y).
pub fn parse_date_text(s: &str) -> Option<f64> {
    let s = s.trim();
    let parts: Vec<&str> = s.split(['-', '/', '.']).collect();
    if parts.len() != 3 {
        return None;
    }
    let nums: Option<Vec<i64>> = parts.iter().map(|p| p.trim().parse::<i64>().ok()).collect();
    let nums = nums?;
    let (y, m, d) = if parts[0].len() == 4 {
        (nums[0], nums[1], nums[2])
    } else if parts[2].len() == 4 {
        (nums[2], nums[1], nums[0])
    } else {
        return None;
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(serial_from_ymd(y, m, d))
}

fn date_arg(v: &Value) -> Result<f64, ErrorKind> {
    match v {
        Value::Text(s) => parse_date_text(s).ok_or(ErrorKind::Value),
        other => to_number(other),
    }
}

// ---------------------------------------------------------------------------
// criteria (COUNTIF / SUMIF / AVERAGEIF)
// ---------------------------------------------------------------------------

struct Criteria {
    op: String,
    value: Value,
}

fn parse_criteria(v: &Value) -> Criteria {
    if let Value::Text(s) = v {
        for op in ["<>", ">=", "<=", "=", ">", "<"] {
            if let Some(rest) = s.strip_prefix(op) {
                return Criteria {
                    op: op.to_string(),
                    value: Value::parse_literal(rest),
                };
            }
        }
        return Criteria {
            op: "=".into(),
            value: Value::Text(s.clone()),
        };
    }
    Criteria {
        op: "=".into(),
        value: v.clone(),
    }
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') => (0..=t.len()).any(|i| go(&p[1..], &t[i..])),
            Some('?') => !t.is_empty() && go(&p[1..], &t[1..]),
            Some(c) => !t.is_empty() && t[0] == *c && go(&p[1..], &t[1..]),
        }
    }
    go(&p, &t)
}

fn matches_criteria(v: &Value, c: &Criteria) -> bool {
    use std::cmp::Ordering::*;
    match (&c.value, v) {
        (Value::Text(pat), _) if c.op == "=" || c.op == "<>" => {
            let hay = v.to_display();
            let m = if pat.contains('*') || pat.contains('?') {
                wildcard_match(pat, &hay)
            } else {
                pat.eq_ignore_ascii_case(&hay)
            };
            if c.op == "=" {
                m
            } else {
                !m
            }
        }
        (Value::Empty, _) if c.op == "=" => v.is_empty(),
        (Value::Empty, _) if c.op == "<>" => !v.is_empty(),
        _ => {
            // numeric comparison; non-numeric cells never match numeric criteria
            let target = match to_number(&c.value) {
                Ok(x) => x,
                Err(_) => return false,
            };
            let x = match v {
                Value::Number(x) => *x,
                Value::Bool(b) => {
                    if *b {
                        1.0
                    } else {
                        0.0
                    }
                }
                _ => return c.op == "<>",
            };
            let ord = x.partial_cmp(&target).unwrap_or(Equal);
            match c.op.as_str() {
                "=" => ord == Equal,
                "<>" => ord != Equal,
                ">" => ord == Greater,
                "<" => ord == Less,
                ">=" => ord != Less,
                "<=" => ord != Greater,
                _ => false,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

pub fn eval(e: &Expr, ctx: &Ctx) -> Arg {
    match e {
        Expr::Num(x) => n(*x),
        Expr::Str(s) => t(s.clone()),
        Expr::Bool(x) => b(*x),
        Expr::Ref(r) => match resolve_ref(r, ctx.wb, ctx.table) {
            Ok(rect) => {
                if rect.r0 == rect.r1 && rect.c0 == rect.c1 {
                    Arg::Scalar(ctx.wb.value(crate::model::CellRef::new(rect.table, rect.r0, rect.c0)))
                } else {
                    range_arg(rect, ctx.wb)
                }
            }
            Err(k) => Arg::err(k),
        },
        Expr::Neg(x) => {
            let v = eval(x, ctx).scalar();
            let x = try_num!(v);
            n(-x)
        }
        Expr::Percent(x) => {
            let v = eval(x, ctx).scalar();
            let x = try_num!(v);
            n(x / 100.0)
        }
        Expr::Binary(op, l, r) => {
            let lv = eval(l, ctx).scalar();
            let rv = eval(r, ctx).scalar();
            binary(*op, lv, rv)
        }
        Expr::Array(rows) => {
            let nrows = rows.len() as u32;
            let ncols = rows.iter().map(|r| r.len()).max().unwrap_or(0) as u32;
            let mut data = Vec::new();
            for r in rows {
                for c in 0..ncols as usize {
                    data.push(r.get(c).map(|x| eval(x, ctx).scalar()).unwrap_or(Value::Empty));
                }
            }
            Arg::Array(Array {
                rows: nrows,
                cols: ncols,
                data,
            })
        }
        Expr::Call(name, args) => call(name, args, ctx),
        Expr::ErrorLit(e) => Arg::err(crate::model::error_from_str(e)),
    }
}

fn binary(op: BinOp, l: Value, r: Value) -> Arg {
    if let Value::Error(e) = &l {
        return Arg::err(e.clone());
    }
    if let Value::Error(e) = &r {
        return Arg::err(e.clone());
    }
    match op {
        BinOp::Add => n(try_num!(l) + try_num!(r)),
        BinOp::Sub => n(try_num!(l) - try_num!(r)),
        BinOp::Mul => n(try_num!(l) * try_num!(r)),
        BinOp::Div => {
            let d = try_num!(r);
            if d == 0.0 {
                return Arg::err(ErrorKind::Div0);
            }
            n(try_num!(l) / d)
        }
        BinOp::Pow => n(try_num!(l).powf(try_num!(r))),
        BinOp::Concat => t(format!("{}{}", try_text!(l), try_text!(r))),
        BinOp::Eq => b(compare(&l, &r) == std::cmp::Ordering::Equal),
        BinOp::Ne => b(compare(&l, &r) != std::cmp::Ordering::Equal),
        BinOp::Lt => b(compare(&l, &r) == std::cmp::Ordering::Less),
        BinOp::Gt => b(compare(&l, &r) == std::cmp::Ordering::Greater),
        BinOp::Le => b(compare(&l, &r) != std::cmp::Ordering::Greater),
        BinOp::Ge => b(compare(&l, &r) != std::cmp::Ordering::Less),
    }
}

fn arg_at(args: &[Arg], i: usize) -> Value {
    args.get(i).cloned().map(|a| a.scalar()).unwrap_or(Value::Empty)
}

fn round_to(x: f64, digits: f64, mode: i8) -> f64 {
    let f = 10f64.powi(digits as i32);
    let y = x * f;
    let r = match mode {
        0 => {
            // round half away from zero
            if y >= 0.0 {
                (y + 0.5).floor()
            } else {
                (y - 0.5).ceil()
            }
        }
        1 => {
            if y >= 0.0 {
                y.ceil()
            } else {
                y.floor()
            }
        }
        _ => {
            if y >= 0.0 {
                y.floor()
            } else {
                y.ceil()
            }
        }
    };
    // avoid -0 and float noise
    let out = r / f;
    if out == 0.0 {
        0.0
    } else {
        (out * 1e12).round() / 1e12
    }
}

fn call(name: &str, raw_args: &[Expr], ctx: &Ctx) -> Arg {
    // lazy functions first
    match name {
        "IF" => {
            if raw_args.is_empty() {
                return Arg::err(ErrorKind::Value);
            }
            let cond = eval(&raw_args[0], ctx).scalar();
            let c = try_bool!(cond);
            return if c {
                raw_args.get(1).map(|e| eval(e, ctx)).unwrap_or(b(true))
            } else {
                raw_args.get(2).map(|e| eval(e, ctx)).unwrap_or(b(false))
            };
        }
        "IFS" => {
            let mut i = 0;
            while i + 1 < raw_args.len() {
                let cond = eval(&raw_args[i], ctx).scalar();
                if try_bool!(cond) {
                    return eval(&raw_args[i + 1], ctx);
                }
                i += 2;
            }
            return Arg::err(ErrorKind::NA);
        }
        "IFERROR" => {
            let v = raw_args.first().map(|e| eval(e, ctx)).unwrap_or(Arg::Scalar(Value::Empty));
            return match &v {
                Arg::Scalar(Value::Error(_)) => raw_args.get(1).map(|e| eval(e, ctx)).unwrap_or(t(String::new())),
                _ => v,
            };
        }
        "IFNA" => {
            let v = raw_args.first().map(|e| eval(e, ctx)).unwrap_or(Arg::Scalar(Value::Empty));
            return match &v {
                Arg::Scalar(Value::Error(ErrorKind::NA)) => {
                    raw_args.get(1).map(|e| eval(e, ctx)).unwrap_or(t(String::new()))
                }
                _ => v,
            };
        }
        "CHOOSE" => {
            let idx = eval(raw_args.first().unwrap_or(&Expr::Num(0.0)), ctx).scalar();
            let i = try_num!(idx) as usize;
            return match raw_args.get(i) {
                Some(e) if i >= 1 => eval(e, ctx),
                _ => Arg::err(ErrorKind::Value),
            };
        }
        _ => {}
    }

    let args: Vec<Arg> = raw_args.iter().map(|e| eval(e, ctx)).collect();
    let a = |i: usize| arg_at(&args, i);

    match name {
        // ---------------- math & aggregates ----------------
        "SUM" => match numbers(&args) {
            Ok(v) => n(v.iter().sum()),
            Err(e) => Arg::err(e),
        },
        "PRODUCT" => match numbers(&args) {
            Ok(v) => n(v.iter().product()),
            Err(e) => Arg::err(e),
        },
        "AVERAGE" => match numbers(&args) {
            Ok(v) if !v.is_empty() => n(v.iter().sum::<f64>() / v.len() as f64),
            Ok(_) => Arg::err(ErrorKind::Div0),
            Err(e) => Arg::err(e),
        },
        "MIN" => match numbers(&args) {
            Ok(v) => n(v.iter().cloned().fold(f64::INFINITY, f64::min).min(if v.is_empty() { 0.0 } else { f64::INFINITY })),
            Err(e) => Arg::err(e),
        },
        "MAX" => match numbers(&args) {
            Ok(v) => n(v.iter().cloned().fold(f64::NEG_INFINITY, f64::max).max(if v.is_empty() { 0.0 } else { f64::NEG_INFINITY })),
            Err(e) => Arg::err(e),
        },
        "COUNT" => match numbers(&args) {
            Ok(v) => n(v.len() as f64),
            Err(_) => n(0.0),
        },
        "COUNTA" => n(args.iter().flat_map(|a| a.values()).filter(|v| !v.is_empty()).count() as f64),
        "COUNTBLANK" => n(args.iter().flat_map(|a| a.values()).filter(|v| v.is_empty()).count() as f64),
        "MEDIAN" => match numbers(&args) {
            Ok(mut v) if !v.is_empty() => {
                v.sort_by(|x, y| x.partial_cmp(y).unwrap());
                let m = v.len() / 2;
                n(if v.len() % 2 == 1 { v[m] } else { (v[m - 1] + v[m]) / 2.0 })
            }
            Ok(_) => Arg::err(ErrorKind::Num),
            Err(e) => Arg::err(e),
        },
        "STDEV" | "STDEV.S" | "VAR" | "VAR.S" | "STDEVP" | "STDEV.P" | "VARP" | "VAR.P" => match numbers(&args) {
            Ok(v) => {
                let sample = !name.ends_with('P');
                let k = v.len() as f64;
                if k < if sample { 2.0 } else { 1.0 } {
                    return Arg::err(ErrorKind::Div0);
                }
                let mean = v.iter().sum::<f64>() / k;
                let ss: f64 = v.iter().map(|x| (x - mean).powi(2)).sum();
                let var = ss / if sample { k - 1.0 } else { k };
                if name.starts_with("VAR") {
                    n(var)
                } else {
                    n(var.sqrt())
                }
            }
            Err(e) => Arg::err(e),
        },
        "ABS" => n(try_num!(a(0)).abs()),
        "SQRT" => {
            let x = try_num!(a(0));
            if x < 0.0 {
                Arg::err(ErrorKind::Num)
            } else {
                n(x.sqrt())
            }
        }
        "EXP" => n(try_num!(a(0)).exp()),
        "LN" => {
            let x = try_num!(a(0));
            if x <= 0.0 {
                Arg::err(ErrorKind::Num)
            } else {
                n(x.ln())
            }
        }
        "LOG" => {
            let x = try_num!(a(0));
            let base = if args.len() > 1 { try_num!(a(1)) } else { 10.0 };
            if x <= 0.0 || base <= 0.0 || base == 1.0 {
                Arg::err(ErrorKind::Num)
            } else {
                n(x.ln() / base.ln())
            }
        }
        "LOG10" => {
            let x = try_num!(a(0));
            if x <= 0.0 {
                Arg::err(ErrorKind::Num)
            } else {
                n(x.log10())
            }
        }
        "POWER" => n(try_num!(a(0)).powf(try_num!(a(1)))),
        "MOD" => {
            let d = try_num!(a(1));
            if d == 0.0 {
                return Arg::err(ErrorKind::Div0);
            }
            let x = try_num!(a(0));
            n(x - d * (x / d).floor())
        }
        "INT" => n(try_num!(a(0)).floor()),
        "TRUNC" => {
            let digits = if args.len() > 1 { try_num!(a(1)) } else { 0.0 };
            n(round_to(try_num!(a(0)), digits, -1))
        }
        "ROUND" => n(round_to(try_num!(a(0)), if args.len() > 1 { try_num!(a(1)) } else { 0.0 }, 0)),
        "ROUNDUP" => n(round_to(try_num!(a(0)), if args.len() > 1 { try_num!(a(1)) } else { 0.0 }, 1)),
        "ROUNDDOWN" => n(round_to(try_num!(a(0)), if args.len() > 1 { try_num!(a(1)) } else { 0.0 }, -1)),
        "CEILING" => {
            let x = try_num!(a(0));
            let s = if args.len() > 1 { try_num!(a(1)) } else { 1.0 };
            if s == 0.0 {
                n(0.0)
            } else {
                n((x / s).ceil() * s)
            }
        }
        "FLOOR" => {
            let x = try_num!(a(0));
            let s = if args.len() > 1 { try_num!(a(1)) } else { 1.0 };
            if s == 0.0 {
                n(0.0)
            } else {
                n((x / s).floor() * s)
            }
        }
        "PI" => n(std::f64::consts::PI),
        "SIGN" => n(try_num!(a(0)).signum() * if try_num!(a(0)) == 0.0 { 0.0 } else { 1.0 }),
        "SUMPRODUCT" => {
            if args.is_empty() {
                return n(0.0);
            }
            let arrays: Vec<Array> = args.iter().map(|x| x.as_array()).collect();
            let len = arrays[0].data.len();
            if arrays.iter().any(|x| x.data.len() != len) {
                return Arg::err(ErrorKind::Value);
            }
            let mut total = 0.0;
            for i in 0..len {
                let mut p = 1.0;
                for arr in &arrays {
                    p *= match &arr.data[i] {
                        Value::Number(x) => *x,
                        Value::Bool(true) => 1.0,
                        Value::Error(e) => return Arg::err(e.clone()),
                        _ => 0.0,
                    };
                }
                total += p;
            }
            n(total)
        }
        "SUMIF" | "COUNTIF" | "AVERAGEIF" => {
            if args.len() < 2 {
                return Arg::err(ErrorKind::Value);
            }
            let range = args[0].as_array();
            let crit = parse_criteria(&arg_at(&args, 1));
            let sum_range = if name != "COUNTIF" && args.len() > 2 {
                Some(args[2].as_array())
            } else {
                None
            };
            let mut total = 0.0;
            let mut count = 0usize;
            for (i, v) in range.data.iter().enumerate() {
                if matches_criteria(v, &crit) {
                    count += 1;
                    let sv = match &sum_range {
                        Some(sr) => sr.data.get(i).cloned().unwrap_or(Value::Empty),
                        None => v.clone(),
                    };
                    if let Value::Number(x) = sv {
                        total += x;
                    }
                }
            }
            match name {
                "SUMIF" => n(total),
                "COUNTIF" => n(count as f64),
                _ => {
                    if count == 0 {
                        Arg::err(ErrorKind::Div0)
                    } else {
                        n(total / count as f64)
                    }
                }
            }
        }
        "SUMIFS" | "COUNTIFS" | "AVERAGEIFS" => {
            let (sum_range, rest) = if name == "COUNTIFS" {
                (None, &args[..])
            } else {
                if args.is_empty() {
                    return Arg::err(ErrorKind::Value);
                }
                (Some(args[0].as_array()), &args[1..])
            };
            if rest.len() < 2 || rest.len() % 2 != 0 {
                return Arg::err(ErrorKind::Value);
            }
            let pairs: Vec<(Array, Criteria)> = rest
                .chunks(2)
                .map(|p| (p[0].as_array(), parse_criteria(&p[1].clone().scalar())))
                .collect();
            let len = pairs[0].0.data.len();
            let mut total = 0.0;
            let mut count = 0usize;
            for i in 0..len {
                if pairs.iter().all(|(arr, c)| arr.data.get(i).map(|v| matches_criteria(v, c)).unwrap_or(false)) {
                    count += 1;
                    if let Some(sr) = &sum_range {
                        if let Some(Value::Number(x)) = sr.data.get(i) {
                            total += x;
                        }
                    }
                }
            }
            match name {
                "SUMIFS" => n(total),
                "COUNTIFS" => n(count as f64),
                _ => {
                    if count == 0 {
                        Arg::err(ErrorKind::Div0)
                    } else {
                        n(total / count as f64)
                    }
                }
            }
        }
        // ---------------- logical ----------------
        "AND" => {
            let mut all = true;
            for v in args.iter().flat_map(|x| x.values()) {
                if v.is_empty() {
                    continue;
                }
                all &= try_bool!(v);
            }
            b(all)
        }
        "OR" => {
            let mut any = false;
            for v in args.iter().flat_map(|x| x.values()) {
                if v.is_empty() {
                    continue;
                }
                any |= try_bool!(v);
            }
            b(any)
        }
        "XOR" => {
            let mut acc = false;
            for v in args.iter().flat_map(|x| x.values()) {
                if v.is_empty() {
                    continue;
                }
                acc ^= try_bool!(v);
            }
            b(acc)
        }
        "NOT" => b(!try_bool!(a(0))),
        "TRUE" => b(true),
        "FALSE" => b(false),
        "ISBLANK" => b(a(0).is_empty()),
        "ISNUMBER" => b(matches!(a(0), Value::Number(_))),
        "ISTEXT" => b(matches!(a(0), Value::Text(_))),
        "ISLOGICAL" => b(matches!(a(0), Value::Bool(_))),
        "ISERROR" => b(matches!(a(0), Value::Error(_))),
        "ISNA" => b(matches!(a(0), Value::Error(ErrorKind::NA))),
        "NA" => Arg::err(ErrorKind::NA),
        // ---------------- text ----------------
        "LEN" => n(try_text!(a(0)).chars().count() as f64),
        "UPPER" => t(try_text!(a(0)).to_uppercase()),
        "LOWER" => t(try_text!(a(0)).to_lowercase()),
        "PROPER" => {
            let s = try_text!(a(0));
            let mut out = String::new();
            let mut new_word = true;
            for ch in s.chars() {
                if ch.is_alphanumeric() {
                    if new_word {
                        out.extend(ch.to_uppercase());
                    } else {
                        out.extend(ch.to_lowercase());
                    }
                    new_word = false;
                } else {
                    out.push(ch);
                    new_word = true;
                }
            }
            t(out)
        }
        "TRIM" => t(try_text!(a(0)).split_whitespace().collect::<Vec<_>>().join(" ")),
        "CONCAT" | "CONCATENATE" => {
            let mut s = String::new();
            for v in args.iter().flat_map(|x| x.values()) {
                s.push_str(&try_text!(v));
            }
            t(s)
        }
        "TEXTJOIN" => {
            let delim = try_text!(a(0));
            let skip_empty = try_bool!(a(1));
            let parts: Vec<String> = args
                .iter()
                .skip(2)
                .flat_map(|x| x.values())
                .filter(|v| !(skip_empty && v.is_empty()))
                .map(|v| v.to_display())
                .collect();
            t(parts.join(&delim))
        }
        "LEFT" => {
            let s = try_text!(a(0));
            let k = if args.len() > 1 { try_num!(a(1)) as usize } else { 1 };
            t(s.chars().take(k).collect())
        }
        "RIGHT" => {
            let s = try_text!(a(0));
            let k = if args.len() > 1 { try_num!(a(1)) as usize } else { 1 };
            let chars: Vec<char> = s.chars().collect();
            t(chars[chars.len().saturating_sub(k)..].iter().collect())
        }
        "MID" => {
            let s = try_text!(a(0));
            let start = try_num!(a(1)) as usize;
            let k = try_num!(a(2)) as usize;
            if start == 0 {
                return Arg::err(ErrorKind::Value);
            }
            t(s.chars().skip(start - 1).take(k).collect())
        }
        "FIND" | "SEARCH" => {
            let needle = try_text!(a(0));
            let hay = try_text!(a(1));
            let start = if args.len() > 2 { try_num!(a(2)) as usize } else { 1 };
            let (needle, hay) = if name == "SEARCH" {
                (needle.to_lowercase(), hay.to_lowercase())
            } else {
                (needle, hay)
            };
            let hay_chars: Vec<char> = hay.chars().collect();
            let from = start.saturating_sub(1).min(hay_chars.len());
            let sub: String = hay_chars[from..].iter().collect();
            match sub.find(&needle) {
                Some(byte_idx) => n((from + sub[..byte_idx].chars().count() + 1) as f64),
                None => Arg::err(ErrorKind::Value),
            }
        }
        "SUBSTITUTE" => t(try_text!(a(0)).replace(&try_text!(a(1)), &try_text!(a(2)))),
        "REPT" => t(try_text!(a(0)).repeat(try_num!(a(1)).max(0.0) as usize)),
        "VALUE" => match crate::model::parse_number_literal(&try_text!(a(0))) {
            Some(x) => n(x),
            None => Arg::err(ErrorKind::Value),
        },
        "TEXT" => {
            let v = a(0);
            let fmt = try_text!(a(1));
            t(format_text(&v, &fmt))
        }
        "EXACT" => b(try_text!(a(0)) == try_text!(a(1))),
        // ---------------- lookup ----------------
        "VLOOKUP" | "HLOOKUP" => {
            if args.len() < 3 {
                return Arg::err(ErrorKind::Value);
            }
            let key = a(0);
            let table = args[1].as_array();
            let idx = try_num!(a(2)) as u32;
            let approx = if args.len() > 3 { try_bool!(a(3)) } else { true };
            if idx < 1 {
                return Arg::err(ErrorKind::Value);
            }
            let vertical = name == "VLOOKUP";
            let (n_keys, n_fields) = if vertical { (table.rows, table.cols) } else { (table.cols, table.rows) };
            if idx > n_fields {
                return Arg::err(ErrorKind::Ref);
            }
            let key_at = |i: u32| if vertical { table.get(i, 0) } else { table.get(0, i) };
            let field_at = |i: u32| if vertical { table.get(i, idx - 1) } else { table.get(idx - 1, i) };
            let mut found: Option<u32> = None;
            for i in 0..n_keys {
                let kv = key_at(i);
                if approx {
                    if compare(kv, &key) != std::cmp::Ordering::Greater && !kv.is_empty() {
                        found = Some(i);
                    } else if compare(kv, &key) == std::cmp::Ordering::Greater {
                        break;
                    }
                } else if compare(kv, &key) == std::cmp::Ordering::Equal && std::mem::discriminant(kv) == std::mem::discriminant(&key) {
                    found = Some(i);
                    break;
                }
            }
            match found {
                Some(i) => Arg::Scalar(field_at(i).clone()),
                None => Arg::err(ErrorKind::NA),
            }
        }
        "XLOOKUP" => {
            if args.len() < 3 {
                return Arg::err(ErrorKind::Value);
            }
            let key = a(0);
            let keys = args[1].as_array();
            let vals = args[2].as_array();
            for (i, kv) in keys.data.iter().enumerate() {
                if compare(kv, &key) == std::cmp::Ordering::Equal && std::mem::discriminant(kv) == std::mem::discriminant(&key) {
                    return Arg::Scalar(vals.data.get(i).cloned().unwrap_or(Value::Empty));
                }
            }
            if args.len() > 3 {
                Arg::Scalar(a(3))
            } else {
                Arg::err(ErrorKind::NA)
            }
        }
        "MATCH" => {
            if args.len() < 2 {
                return Arg::err(ErrorKind::Value);
            }
            let key = a(0);
            let arr = args[1].as_array();
            let mode = if args.len() > 2 { try_num!(a(2)) } else { 1.0 };
            let mut found: Option<usize> = None;
            for (i, v) in arr.data.iter().enumerate() {
                let ord = compare(v, &key);
                if mode == 0.0 {
                    if ord == std::cmp::Ordering::Equal && std::mem::discriminant(v) == std::mem::discriminant(&key) {
                        found = Some(i);
                        break;
                    }
                } else if mode > 0.0 {
                    if ord != std::cmp::Ordering::Greater && !v.is_empty() {
                        found = Some(i);
                    } else if ord == std::cmp::Ordering::Greater {
                        break;
                    }
                } else if ord != std::cmp::Ordering::Less && !v.is_empty() {
                    found = Some(i);
                } else if ord == std::cmp::Ordering::Less {
                    break;
                }
            }
            match found {
                Some(i) => n((i + 1) as f64),
                None => Arg::err(ErrorKind::NA),
            }
        }
        "INDEX" => {
            if args.is_empty() {
                return Arg::err(ErrorKind::Value);
            }
            let arr = args[0].as_array();
            let r = if args.len() > 1 { try_num!(a(1)) as u32 } else { 1 };
            let c = if args.len() > 2 { try_num!(a(2)) as u32 } else { 1 };
            // INDEX(range, n) on a single column/row picks the nth element
            let (r, c) = if args.len() == 2 && (arr.rows == 1 || arr.cols == 1) {
                if arr.rows == 1 {
                    (1, r)
                } else {
                    (r, 1)
                }
            } else {
                (r, c)
            };
            if r == 0 || c == 0 || r > arr.rows || c > arr.cols {
                return Arg::err(ErrorKind::Ref);
            }
            Arg::Scalar(arr.get(r - 1, c - 1).clone())
        }
        "ROW" => match (&args.first(), ctx.at) {
            (Some(_), _) => match raw_args.first() {
                Some(Expr::Ref(r)) => match resolve_ref(r, ctx.wb, ctx.table) {
                    Ok(rect) => n((rect.r0 + 1) as f64),
                    Err(e) => Arg::err(e),
                },
                _ => Arg::err(ErrorKind::Value),
            },
            (None, Some(at)) => n((at.row + 1) as f64),
            _ => Arg::err(ErrorKind::Value),
        },
        "COLUMN" => match (&args.first(), ctx.at) {
            (Some(_), _) => match raw_args.first() {
                Some(Expr::Ref(r)) => match resolve_ref(r, ctx.wb, ctx.table) {
                    Ok(rect) => n((rect.c0 + 1) as f64),
                    Err(e) => Arg::err(e),
                },
                _ => Arg::err(ErrorKind::Value),
            },
            (None, Some(at)) => n((at.col + 1) as f64),
            _ => Arg::err(ErrorKind::Value),
        },
        "ROWS" => n(args.first().map(|x| x.as_array().rows).unwrap_or(0) as f64),
        "COLUMNS" => n(args.first().map(|x| x.as_array().cols).unwrap_or(0) as f64),
        "TRANSPOSE" => {
            let arr = args.first().map(|x| x.as_array()).unwrap_or(Array { rows: 0, cols: 0, data: vec![] });
            let mut data = Vec::with_capacity(arr.data.len());
            for c in 0..arr.cols {
                for r in 0..arr.rows {
                    data.push(arr.get(r, c).clone());
                }
            }
            Arg::Array(Array {
                rows: arr.cols,
                cols: arr.rows,
                data,
            })
        }
        "UNIQUE" => {
            let arr = args.first().map(|x| x.as_array()).unwrap_or(Array { rows: 0, cols: 0, data: vec![] });
            let mut seen: Vec<Value> = Vec::new();
            for v in &arr.data {
                if !seen.iter().any(|s| compare(s, v) == std::cmp::Ordering::Equal && std::mem::discriminant(s) == std::mem::discriminant(v)) {
                    seen.push(v.clone());
                }
            }
            Arg::Array(Array {
                rows: seen.len() as u32,
                cols: 1,
                data: seen,
            })
        }
        // ---------------- dates ----------------
        "TODAY" => n(ctx.now.floor()),
        "NOW" => n(ctx.now),
        "DATE" => n(serial_from_ymd(try_num!(a(0)) as i64, try_num!(a(1)) as i64, try_num!(a(2)) as i64)),
        "YEAR" | "MONTH" | "DAY" => {
            let v = a(0);
            let s = match date_arg(&v) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            let (y, m, d) = ymd_from_serial(s);
            n(match name {
                "YEAR" => y,
                "MONTH" => m,
                _ => d,
            } as f64)
        }
        "DATEVALUE" => match parse_date_text(&try_text!(a(0))) {
            Some(s) => n(s),
            None => Arg::err(ErrorKind::Value),
        },
        "EDATE" => {
            let s = match date_arg(&a(0)) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            let months = try_num!(a(1)) as i64;
            let (y, m, d) = ymd_from_serial(s);
            n(serial_from_ymd(y, m + months, d))
        }
        "EOMONTH" => {
            let s = match date_arg(&a(0)) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            let months = try_num!(a(1)) as i64;
            let (y, m, _) = ymd_from_serial(s);
            n(serial_from_ymd(y, m + months + 1, 1) - 1.0)
        }
        "WEEKDAY" => {
            let s = match date_arg(&a(0)) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            // 1 = Sunday (Excel default)
            let days = s.floor() as i64 - UNIX_EPOCH_SERIAL; // 1970-01-01 was a Thursday
            n(((days + 4).rem_euclid(7) + 1) as f64)
        }
        "DAYS" => {
            let end = match date_arg(&a(0)) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            let start = match date_arg(&a(1)) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            n((end - start).floor())
        }
        // ---------------- misc ----------------
        "N" => match a(0) {
            Value::Number(x) => n(x),
            Value::Bool(x) => n(if x { 1.0 } else { 0.0 }),
            Value::Error(e) => Arg::err(e),
            _ => n(0.0),
        },
        "T" => match a(0) {
            Value::Text(s) => t(s),
            Value::Error(e) => Arg::err(e),
            _ => t(String::new()),
        },
        "RANK" => {
            let x = try_num!(a(0));
            let arr = args.get(1).map(|v| v.as_array()).unwrap_or(Array { rows: 0, cols: 0, data: vec![] });
            let asc = args.len() > 2 && try_bool!(a(2));
            let nums: Vec<f64> = arr.data.iter().filter_map(|v| if let Value::Number(y) = v { Some(*y) } else { None }).collect();
            if !nums.contains(&x) {
                return Arg::err(ErrorKind::NA);
            }
            let rank = nums.iter().filter(|&&y| if asc { y < x } else { y > x }).count() + 1;
            n(rank as f64)
        }
        "LARGE" | "SMALL" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or(Array { rows: 0, cols: 0, data: vec![] });
            let k = try_num!(a(1)) as usize;
            let mut nums: Vec<f64> = arr.data.iter().filter_map(|v| if let Value::Number(y) = v { Some(*y) } else { None }).collect();
            if k == 0 || k > nums.len() {
                return Arg::err(ErrorKind::Num);
            }
            nums.sort_by(|x, y| x.partial_cmp(y).unwrap());
            n(if name == "SMALL" { nums[k - 1] } else { nums[nums.len() - k] })
        }
        _ => Arg::err(ErrorKind::Name),
    }
}

/// Minimal TEXT() formats: 0, 0.00, #,##0, #,##0.00, 0%, 0.0%, yyyy-mm-dd, dd/mm/yyyy.
pub fn format_text(v: &Value, fmt: &str) -> String {
    let f = fmt.trim();
    let lower = f.to_ascii_lowercase();
    if lower.contains("yyyy") || lower.contains("dd") {
        if let Ok(s) = date_arg(v) {
            let (y, m, d) = ymd_from_serial(s);
            return lower
                .replace("yyyy", &format!("{:04}", y))
                .replace("mm", &format!("{:02}", m))
                .replace("dd", &format!("{:02}", d));
        }
        return v.to_display();
    }
    let x = match to_number(v) {
        Ok(x) => x,
        Err(_) => return v.to_display(),
    };
    let pct = f.ends_with('%');
    let x = if pct { x * 100.0 } else { x };
    let decimals = f.split('.').nth(1).map(|d| d.chars().filter(|c| *c == '0').count()).unwrap_or(0);
    let grouped = f.contains(',');
    let body = format!("{:.*}", decimals, x);
    let out = if grouped {
        let (int_part, frac) = match body.split_once('.') {
            Some((i, fr)) => (i.to_string(), Some(fr.to_string())),
            None => (body.clone(), None),
        };
        let neg = int_part.starts_with('-');
        let digits: Vec<char> = int_part.trim_start_matches('-').chars().collect();
        let mut g = String::new();
        for (i, ch) in digits.iter().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                g.push(',');
            }
            g.push(*ch);
        }
        format!("{}{}{}", if neg { "-" } else { "" }, g, frac.map(|fr| format!(".{}", fr)).unwrap_or_default())
    } else {
        body
    };
    if pct {
        format!("{}%", out)
    } else {
        out
    }
}
