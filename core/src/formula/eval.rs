//! Formula evaluator and the built-in function library.
//!
//! Values flow as `Arg`: a scalar or a rectangular array. Scalar functions are
//! lifted over arrays element-wise (so `=ROUND(A1:A5, 1)` yields an array that
//! spills), aggregates consume whole arrays, and a few functions are lazy.

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
    pub fn empty() -> Array {
        Array { rows: 0, cols: 0, data: vec![] }
    }
    pub fn from_rows(rows: Vec<Vec<Value>>) -> Array {
        let nrows = rows.len() as u32;
        let ncols = rows.iter().map(|r| r.len()).max().unwrap_or(0) as u32;
        let mut data = Vec::with_capacity((nrows * ncols) as usize);
        for r in rows {
            for c in 0..ncols as usize {
                data.push(r.get(c).cloned().unwrap_or(Value::Empty));
            }
        }
        Array { rows: nrows, cols: ncols, data }
    }
    pub fn row(&self, r: u32) -> Vec<Value> {
        (0..self.cols).map(|c| self.get(r, c).clone()).collect()
    }
    pub fn column(&self, c: u32) -> Vec<Value> {
        (0..self.rows).map(|r| self.get(r, c).clone()).collect()
    }
    /// Element with broadcasting (1-row / 1-col arrays repeat).
    fn at_broadcast(&self, r: u32, c: u32) -> Value {
        if self.rows == 0 || self.cols == 0 {
            return Value::Error(ErrorKind::NA);
        }
        let rr = if self.rows == 1 { 0 } else { r };
        let cc = if self.cols == 1 { 0 } else { c };
        if rr >= self.rows || cc >= self.cols {
            return Value::Error(ErrorKind::NA);
        }
        self.get(rr, cc).clone()
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
                } else if a.data.is_empty() {
                    Value::Error(ErrorKind::NA)
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
    pub fn as_array(&self) -> Array {
        match self {
            Arg::Scalar(v) => Array {
                rows: 1,
                cols: 1,
                data: vec![v.clone()],
            },
            Arg::Array(a) => a.clone(),
        }
    }
    fn is_multi(&self) -> bool {
        matches!(self, Arg::Array(a) if a.rows * a.cols != 1)
    }
    fn shape(&self) -> (u32, u32) {
        match self {
            Arg::Scalar(_) => (1, 1),
            Arg::Array(a) => (a.rows, a.cols),
        }
    }
    fn at_broadcast(&self, r: u32, c: u32) -> Value {
        match self {
            Arg::Scalar(v) => v.clone(),
            Arg::Array(a) => a.at_broadcast(r, c),
        }
    }
    /// Normalise: 1×1 arrays become scalars, 0-sized arrays become #N/A... keep empties as #CALC-like NA.
    fn normalise(self) -> Arg {
        match self {
            Arg::Array(a) if a.rows == 1 && a.cols == 1 => Arg::Scalar(a.data.into_iter().next().unwrap_or(Value::Empty)),
            Arg::Array(a) if a.data.is_empty() => Arg::err(ErrorKind::NA),
            other => other,
        }
    }
}

#[derive(Clone)]
pub struct Ctx<'a> {
    pub wb: &'a Workbook,
    pub table: TableId,
    pub now: f64,
    /// Position of the cell being evaluated (for ROW()/COLUMN() and `[@Column]`).
    pub at: Option<CellKey>,
    /// Names bound by LET (innermost last).
    pub locals: Vec<(String, Arg)>,
}

/// Resolve a reference to a rectangle inside a table, clipped to the table bounds.
pub fn resolve_ref(r: &RefExpr, wb: &Workbook, current: TableId) -> Result<Rect, ErrorKind> {
    resolve_ref_at(r, wb, current, None)
}

/// Like `resolve_ref`, with the evaluating cell's position (needed by `[@Column]`).
pub fn resolve_ref_at(r: &RefExpr, wb: &Workbook, current: TableId, at: Option<CellKey>) -> Result<Rect, ErrorKind> {
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
        RefKind::Column { name, this_row } => {
            let col = table.column_by_header(name).ok_or(ErrorKind::Name)?;
            if *this_row {
                match at {
                    Some(k) if r.table.is_none() || table.id == current => {
                        if k.row < table.header_rows {
                            return Err(ErrorKind::Value);
                        }
                        (k.row, col, k.row, col)
                    }
                    Some(_) => return Err(ErrorKind::Value),
                    // without a position (dependency analysis) the whole data column is read
                    None => (table.header_rows.min(table.rows - 1), col, table.rows - 1, col),
                }
            } else {
                if table.header_rows >= table.rows {
                    return Err(ErrorKind::Ref);
                }
                (table.header_rows, col, table.rows - 1, col)
            }
        }
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

/// Every rectangle an expression reads (conservative: ignores short-circuiting;
/// named ranges are expanded).
pub fn collect_deps(e: &Expr, wb: &Workbook, current: TableId) -> Vec<Rect> {
    let mut out = Vec::new();
    walk_deps(e, wb, current, &mut out, 0);
    out
}

fn walk_deps(e: &Expr, wb: &Workbook, current: TableId, out: &mut Vec<Rect>, depth: u32) {
    match e {
        Expr::Ref(r) => {
            if let Ok(rect) = resolve_ref(r, wb, current) {
                out.push(rect);
            }
        }
        Expr::Name(n) => {
            if depth < 8 {
                if let Some(nr) = wb.named_range(n) {
                    if let Ok(parsed) = super::parser::parse(&nr.reference) {
                        walk_deps(&parsed, wb, current, out, depth + 1);
                    }
                }
            }
        }
        Expr::Call(name, args) => {
            if name.eq_ignore_ascii_case("INDIRECT") {
                if let Some(Expr::Str(text)) = args.first() {
                    if let Ok(Expr::Ref(r)) = super::parser::parse(text) {
                        if let Ok(rect) = resolve_ref(&r, wb, current) {
                            out.push(rect);
                        }
                    }
                }
            }
            if name.eq_ignore_ascii_case("OFFSET") {
                // the window may move: depend on the whole table of the base reference
                if let Some(Expr::Ref(r)) = args.first() {
                    if let Ok(rect) = resolve_ref(r, wb, current) {
                        if let Some(t) = wb.table(rect.table) {
                            if t.rows > 0 && t.cols > 0 {
                                out.push(Rect { table: t.id, r0: 0, c0: 0, r1: t.rows - 1, c1: t.cols - 1 });
                            }
                        }
                    }
                }
            }
            if name.eq_ignore_ascii_case("FX") {
                if let Some(t) = fx_table(wb) {
                    if t.rows > 0 && t.cols > 0 {
                        out.push(Rect {
                            table: t.id,
                            r0: 0,
                            c0: 0,
                            r1: t.rows - 1,
                            c1: t.cols - 1,
                        });
                    }
                }
            }
            args.iter().for_each(|a| walk_deps(a, wb, current, out, depth))
        }
        Expr::Neg(x) | Expr::Percent(x) => walk_deps(x, wb, current, out, depth),
        Expr::Binary(_, l, r) => {
            walk_deps(l, wb, current, out, depth);
            walk_deps(r, wb, current, out, depth);
        }
        Expr::Array(rows) => rows.iter().flatten().for_each(|x| walk_deps(x, wb, current, out, depth)),
        _ => {}
    }
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
        Value::Text(s) => crate::model::parse_number_literal(s)
            .or_else(|| parse_date_time_text(s).map(|(d, _)| d))
            .ok_or(ErrorKind::Value),
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

/// Numbers in order, errors propagate, blanks/text skipped (for cash-flow functions).
fn cash_flows(a: &Arg) -> Result<Vec<f64>, ErrorKind> {
    let mut out = vec![];
    for v in a.values() {
        match v {
            Value::Number(x) => out.push(x),
            Value::Error(e) => return Err(e),
            _ => {}
        }
    }
    Ok(out)
}

pub fn compare_values(a: &Value, b: &Value) -> std::cmp::Ordering {
    compare(a, b)
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

fn same_type(a: &Value, b: &Value) -> bool {
    std::mem::discriminant(a) == std::mem::discriminant(b)
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

/// Monday = 0 … Sunday = 6
fn weekday_mon0(serial: f64) -> i64 {
    (serial.floor() as i64 - UNIX_EPOCH_SERIAL + 3).rem_euclid(7)
}

const MONTHS_EN: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_PT: [&str; 12] = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

fn month_from_name(s: &str) -> Option<i64> {
    let l = s.trim_matches('.').to_lowercase();
    if l.chars().count() < 3 {
        return None;
    }
    let key: String = l.chars().take(3).collect();
    let key = key.as_str();
    // full names must start with the abbreviation and be plausible month names
    let idx = MONTHS_EN.iter().position(|m| *m == key).or_else(|| MONTHS_PT.iter().position(|m| *m == key))?;
    Some(idx as i64 + 1)
}

/// Parse a time-of-day part ("14:30", "14:30:15", "2:05 pm") into a fraction of a day.
fn parse_time_part(s: &str) -> Option<(f64, bool)> {
    let mut s = s.trim().to_lowercase();
    let mut pm: Option<bool> = None;
    if let Some(rest) = s.strip_suffix("pm") {
        pm = Some(true);
        s = rest.trim().to_string();
    } else if let Some(rest) = s.strip_suffix("am") {
        pm = Some(false);
        s = rest.trim().to_string();
    }
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let h: f64 = parts[0].trim().parse().ok()?;
    let m: f64 = parts[1].trim().parse().ok()?;
    let sec: f64 = if parts.len() == 3 { parts[2].trim().parse().ok()? } else { 0.0 };
    if !(0.0..24.0).contains(&h) || !(0.0..60.0).contains(&m) || !(0.0..60.0).contains(&sec) {
        return None;
    }
    let h = match pm {
        Some(true) if h < 12.0 => h + 12.0,
        Some(false) if h == 12.0 => 0.0,
        _ => h,
    };
    Some(((h * 3600.0 + m * 60.0 + sec) / 86400.0, parts.len() == 3))
}

/// Parse dates and date-times typed as text. Returns the serial and the number
/// format that reproduces what was typed. Accepts 2026-10-08, 2026/10/08,
/// 08/10/2026, 08-10-2026, 08.10.2026 (day first), "8 Oct 2026", "Oct 8, 2026",
/// "8 de Outubro de 2026", optionally followed by a time ("14:30", "T14:30:00"), and bare times.
pub fn parse_date_time_text(s: &str) -> Option<(f64, &'static str)> {
    let s = s.trim();
    if s.is_empty() || s.len() > 40 {
        return None;
    }
    // bare time
    if let Some((frac, with_secs)) = parse_time_part(s) {
        return Some((frac, if with_secs { "hh:mm:ss" } else { "hh:mm" }));
    }
    // split off a time part: "2026-10-08 14:30", "2026-10-08T14:30:00", "8 Oct 2026 14:30"
    let (date_part, time_part): (&str, Option<&str>) = if let Some(idx) = s.find('T').filter(|i| *i >= 8 && s[..*i].chars().all(|c| c.is_ascii_digit() || c == '-' || c == '/')) {
        (&s[..idx], Some(&s[idx + 1..]))
    } else {
        // last whitespace-separated token containing ':' (possibly followed by am/pm)
        let tokens: Vec<&str> = s.split_whitespace().collect();
        let mut split_at: Option<usize> = None;
        for (i, tok) in tokens.iter().enumerate() {
            if tok.contains(':') {
                split_at = Some(i);
                break;
            }
        }
        match split_at {
            Some(i) if i > 0 => (&s[..s.find(tokens[i]).unwrap()], Some(s[s.find(tokens[i]).unwrap()..].trim())),
            _ => (s, None),
        }
    };
    let (serial, fmt) = parse_date_only(date_part.trim())?;
    match time_part {
        None => Some((serial, fmt)),
        Some(tp) => {
            let (frac, with_secs) = parse_time_part(tp)?;
            let f: &'static str = match (fmt, with_secs) {
                ("yyyy-mm-dd", false) => "yyyy-mm-dd hh:mm",
                ("yyyy-mm-dd", true) => "yyyy-mm-dd hh:mm:ss",
                ("dd/mm/yyyy", false) => "dd/mm/yyyy hh:mm",
                ("dd/mm/yyyy", true) => "dd/mm/yyyy hh:mm:ss",
                (_, false) => "d mmm yyyy hh:mm",
                (_, true) => "d mmm yyyy hh:mm:ss",
            };
            Some((serial + frac, f))
        }
    }
}

fn parse_date_only(s: &str) -> Option<(f64, &'static str)> {
    if s.is_empty() {
        return None;
    }
    // numeric forms with - / .
    let seps: Vec<char> = s.chars().filter(|c| *c == '-' || *c == '/' || *c == '.').collect();
    if seps.len() == 2 && seps[0] == seps[1] {
        let parts: Vec<&str> = s.split(seps[0]).map(|p| p.trim()).collect();
        if parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
            let nums: Vec<i64> = parts.iter().map(|p| p.parse::<i64>().unwrap()).collect();
            let (y, m, d, fmt): (i64, i64, i64, &'static str) = if parts[0].len() == 4 {
                (nums[0], nums[1], nums[2], if seps[0] == '/' { "yyyy/mm/dd" } else { "yyyy-mm-dd" })
            } else if parts[2].len() == 4 {
                (nums[2], nums[1], nums[0], if seps[0] == '/' { "dd/mm/yyyy" } else if seps[0] == '.' { "dd.mm.yyyy" } else { "dd-mm-yyyy" })
            } else if parts[2].len() == 2 && seps[0] == '/' {
                (2000 + nums[2], nums[1], nums[0], "dd/mm/yy")
            } else {
                return None;
            };
            if !(1..=12).contains(&m) || !(1..=31).contains(&d) || !(1900..=2200).contains(&y) {
                return None;
            }
            if d > days_in_month(y, m) {
                return None;
            }
            return Some((serial_from_ymd(y, m, d), fmt));
        }
        return None;
    }
    // textual month forms: "8 Oct 2026", "Oct 8, 2026", "8 de Outubro de 2026", "October 8 2026"
    let cleaned = s.replace(',', " ");
    let tokens: Vec<&str> = cleaned.split_whitespace().filter(|t| !t.eq_ignore_ascii_case("de")).collect();
    if tokens.len() == 3 {
        let (a, bb, c) = (tokens[0], tokens[1], tokens[2]);
        let year: i64 = c.parse().ok()?;
        if !(1900..=2200).contains(&year) {
            return None;
        }
        let (d, m) = if let Ok(d) = a.parse::<i64>() {
            (d, month_from_name(bb)?)
        } else if let Ok(d) = bb.parse::<i64>() {
            (d, month_from_name(a)?)
        } else {
            return None;
        };
        if !(1..=31).contains(&d) || d > days_in_month(year, m) {
            return None;
        }
        return Some((serial_from_ymd(year, m, d), "d mmm yyyy"));
    }
    None
}

fn days_in_month(y: i64, m: i64) -> i64 {
    (serial_from_ymd(y, m + 1, 1) - serial_from_ymd(y, m, 1)) as i64
}

fn date_arg(v: &Value) -> Result<f64, ErrorKind> {
    match v {
        Value::Text(s) => parse_date_time_text(s).map(|x| x.0).ok_or(ErrorKind::Value),
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
    eval_depth(e, ctx, 0)
}

fn eval_depth(e: &Expr, ctx: &Ctx, depth: u32) -> Arg {
    if depth > 64 {
        return Arg::err(ErrorKind::Cycle);
    }
    match e {
        Expr::Num(x) => n(*x),
        Expr::Str(s) => t(s.clone()),
        Expr::Bool(x) => b(*x),
        Expr::Ref(r) => match resolve_ref_at(r, ctx.wb, ctx.table, ctx.at) {
            Ok(rect) => {
                if rect.r0 == rect.r1 && rect.c0 == rect.c1 {
                    Arg::Scalar(ctx.wb.value(crate::model::CellRef::new(rect.table, rect.r0, rect.c0)))
                } else {
                    range_arg(rect, ctx.wb)
                }
            }
            Err(k) => Arg::err(k),
        },
        Expr::Name(name) => {
            if let Some((_, v)) = ctx.locals.iter().rev().find(|(k, _)| k.eq_ignore_ascii_case(name)) {
                return v.clone();
            }
            match ctx.wb.named_range(name) {
                Some(nr) => match super::parser::parse(&nr.reference) {
                    Ok(parsed) => eval_depth(&parsed, ctx, depth + 1),
                    Err(_) => Arg::err(ErrorKind::Name),
                },
                None => Arg::err(ErrorKind::Name),
            }
        }
        Expr::Neg(x) => lift1(eval_depth(x, ctx, depth), |v| {
            let x = try_num!(v);
            n(-x)
        }),
        Expr::Percent(x) => lift1(eval_depth(x, ctx, depth), |v| {
            let x = try_num!(v);
            n(x / 100.0)
        }),
        Expr::Binary(op, l, r) => {
            let lv = eval_depth(l, ctx, depth);
            let rv = eval_depth(r, ctx, depth);
            if lv.is_multi() || rv.is_multi() {
                broadcast2(&lv, &rv, |a, bb| binary(*op, a, bb))
            } else {
                binary(*op, lv.scalar(), rv.scalar())
            }
        }
        Expr::Array(rows) => {
            let nrows = rows.len() as u32;
            let ncols = rows.iter().map(|r| r.len()).max().unwrap_or(0) as u32;
            let mut data = Vec::new();
            for r in rows {
                for c in 0..ncols as usize {
                    data.push(r.get(c).map(|x| eval_depth(x, ctx, depth).scalar()).unwrap_or(Value::Empty));
                }
            }
            Arg::Array(Array {
                rows: nrows,
                cols: ncols,
                data,
            })
        }
        Expr::Call(name, args) => call(name, args, ctx, depth),
        Expr::ErrorLit(e) => Arg::err(crate::model::error_from_str(e)),
    }
}

fn lift1(a: Arg, f: impl Fn(Value) -> Arg) -> Arg {
    match a {
        Arg::Array(arr) if arr.rows * arr.cols != 1 => {
            let data = arr.data.into_iter().map(|v| f(v).scalar()).collect();
            Arg::Array(Array {
                rows: arr.rows,
                cols: arr.cols,
                data,
            })
        }
        other => f(other.scalar()),
    }
}

fn broadcast2(l: &Arg, r: &Arg, f: impl Fn(Value, Value) -> Arg) -> Arg {
    let (lr, lc) = l.shape();
    let (rr, rc) = r.shape();
    let rows = lr.max(rr);
    let cols = lc.max(rc);
    let mut data = Vec::with_capacity((rows * cols) as usize);
    for i in 0..rows {
        for j in 0..cols {
            data.push(f(l.at_broadcast(i, j), r.at_broadcast(i, j)).scalar());
        }
    }
    Arg::Array(Array { rows, cols, data }).normalise()
}

/// Apply a scalar function element-wise over array arguments (broadcasting).
fn broadcast_n(args: &[Arg], f: impl Fn(&[Value]) -> Arg) -> Arg {
    let mut rows = 1;
    let mut cols = 1;
    for a in args {
        let (r, c) = a.shape();
        rows = rows.max(r);
        cols = cols.max(c);
    }
    let mut data = Vec::with_capacity((rows * cols) as usize);
    let mut scalars = Vec::with_capacity(args.len());
    for i in 0..rows {
        for j in 0..cols {
            scalars.clear();
            for a in args {
                scalars.push(a.at_broadcast(i, j));
            }
            data.push(f(&scalars).scalar());
        }
    }
    Arg::Array(Array { rows, cols, data }).normalise()
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

/// Scalar functions that are applied element-wise when given arrays.
const LIFTED: &[&str] = &[
    "ABS", "SQRT", "EXP", "LN", "LOG", "LOG10", "POWER", "MOD", "INT", "TRUNC", "ROUND", "ROUNDUP", "ROUNDDOWN", "CEILING", "FLOOR", "SIGN", "NOT",
    "ISBLANK", "ISNUMBER", "ISTEXT", "ISLOGICAL", "ISERROR", "ISNA", "ISEVEN", "ISODD", "LEN", "UPPER", "LOWER", "PROPER", "TRIM", "LEFT", "RIGHT", "MID",
    "FIND", "SEARCH", "SUBSTITUTE", "REPT", "VALUE", "TEXT", "EXACT", "N", "T", "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "WEEKDAY", "EDATE",
    "EOMONTH", "DAYS", "DATE", "DATEVALUE", "TIME", "YEARFRAC", "DATEDIF", "EFFECT", "NOMINAL", "PMT", "PV", "FV", "NPER", "RATE", "IPMT", "PPMT",
    "SLN", "SWITCH", "AGE_BUCKET", "QUOTIENT", "GCD", "LCM", "FACT", "COMBIN", "PERMUT", "MROUND", "EVEN", "ODD", "SQRTPI", "RADIANS", "DEGREES", "SIN", "COS", "TAN",
    "ASIN", "ACOS", "ATAN", "ATAN2", "SINH", "COSH", "TANH", "CEILING.MATH", "FLOOR.MATH", "BASE", "DECIMAL", "CHAR", "CODE", "UNICHAR", "UNICODE", "CLEAN", "FIXED",
    "NUMBERVALUE", "REPLACE", "TEXTBEFORE", "TEXTAFTER", "REGEXMATCH", "REGEXEXTRACT", "REGEXREPLACE", "DAYS360", "WEEKNUM", "ISOWEEKNUM", "TIMEVALUE", "ISERR",
    "ISNONTEXT", "TYPE", "ERROR.TYPE", "SYD", "DB", "DDB", "RRI", "PDURATION", "ISPMT", "NORM.DIST", "NORMDIST", "NORM.S.DIST", "NORMSDIST", "NORM.INV", "NORMINV",
    "NORM.S.INV", "NORMSINV", "STANDARDIZE", "ADDRESS",
];

fn call(name: &str, raw_args: &[Expr], ctx: &Ctx, depth: u32) -> Arg {
    let ev = |e: &Expr| eval_depth(e, ctx, depth);
    // lazy functions first
    match name {
        "IF" => {
            if raw_args.is_empty() {
                return Arg::err(ErrorKind::Value);
            }
            let cond = ev(&raw_args[0]);
            if cond.is_multi() {
                let yes = raw_args.get(1).map(ev).unwrap_or(b(true));
                let no = raw_args.get(2).map(ev).unwrap_or(b(false));
                return broadcast_n(&[cond, yes, no], |v| {
                    let c = try_bool!(v[0]);
                    Arg::Scalar(if c { v[1].clone() } else { v[2].clone() })
                });
            }
            let c = try_bool!(cond.scalar());
            return if c {
                raw_args.get(1).map(ev).unwrap_or(b(true))
            } else {
                raw_args.get(2).map(ev).unwrap_or(b(false))
            };
        }
        "IFS" => {
            let mut i = 0;
            while i + 1 < raw_args.len() {
                let cond = ev(&raw_args[i]).scalar();
                if try_bool!(cond) {
                    return ev(&raw_args[i + 1]);
                }
                i += 2;
            }
            return Arg::err(ErrorKind::NA);
        }
        "IFERROR" | "IFNA" => {
            let v = raw_args.first().map(ev).unwrap_or(Arg::Scalar(Value::Empty));
            let is_hit = |x: &Value| match x {
                Value::Error(ErrorKind::NA) => true,
                Value::Error(_) => name == "IFERROR",
                _ => false,
            };
            return match &v {
                Arg::Scalar(x) if is_hit(x) => raw_args.get(1).map(ev).unwrap_or(t(String::new())),
                Arg::Scalar(_) => v,
                Arg::Array(a) => {
                    if !a.data.iter().any(is_hit) {
                        return v;
                    }
                    let alt = raw_args.get(1).map(ev).unwrap_or(t(String::new()));
                    broadcast_n(&[v.clone(), alt], |x| Arg::Scalar(if is_hit(&x[0]) { x[1].clone() } else { x[0].clone() }))
                }
            };
        }
        "CHOOSE" => {
            let idx = ev(raw_args.first().unwrap_or(&Expr::Num(0.0))).scalar();
            let i = try_num!(idx) as usize;
            return match raw_args.get(i) {
                Some(e) if i >= 1 => ev(e),
                _ => Arg::err(ErrorKind::Value),
            };
        }
        "LET" => {
            // LET(name1, value1, [name2, value2, ...], calculation)
            if raw_args.len() < 3 || raw_args.len() % 2 == 0 {
                return Arg::err(ErrorKind::Value);
            }
            let mut inner = ctx.clone();
            let mut i = 0;
            while i + 1 < raw_args.len() - 1 {
                let name = match &raw_args[i] {
                    Expr::Name(nm) => nm.clone(),
                    Expr::Ref(r) => super::parser::ref_to_string(r),
                    _ => return Arg::err(ErrorKind::Value),
                };
                let value = eval_depth(&raw_args[i + 1], &inner, depth + 1);
                inner.locals.push((name, value));
                i += 2;
            }
            return eval_depth(&raw_args[raw_args.len() - 1], &inner, depth + 1);
        }
        "OFFSET" => {
            // OFFSET(reference, rows, cols, [height], [width])
            let base = match raw_args.first() {
                Some(Expr::Ref(r)) => match resolve_ref_at(r, ctx.wb, ctx.table, ctx.at) {
                    Ok(rect) => rect,
                    Err(e) => return Arg::err(e),
                },
                _ => return Arg::err(ErrorKind::Value),
            };
            let dr = try_num!(raw_args.get(1).map(ev).unwrap_or(n(0.0)).scalar()) as i64;
            let dc = try_num!(raw_args.get(2).map(ev).unwrap_or(n(0.0)).scalar()) as i64;
            let h = match raw_args.get(3).map(ev).map(|v| v.scalar()) {
                None | Some(Value::Empty) => base.rows() as i64,
                Some(v) => try_num!(v) as i64,
            };
            let w = match raw_args.get(4).map(ev).map(|v| v.scalar()) {
                None | Some(Value::Empty) => base.cols() as i64,
                Some(v) => try_num!(v) as i64,
            };
            let table = match ctx.wb.table(base.table) {
                Some(t) => t,
                None => return Arg::err(ErrorKind::Ref),
            };
            let r0 = base.r0 as i64 + dr;
            let c0 = base.c0 as i64 + dc;
            if h < 1 || w < 1 || r0 < 0 || c0 < 0 || r0 + h > table.rows as i64 || c0 + w > table.cols as i64 {
                return Arg::err(ErrorKind::Ref);
            }
            let rect = Rect { table: base.table, r0: r0 as u32, c0: c0 as u32, r1: (r0 + h - 1) as u32, c1: (c0 + w - 1) as u32 };
            return if h == 1 && w == 1 { Arg::Scalar(table.value_at(CellKey::new(rect.r0, rect.c0))) } else { range_arg(rect, ctx.wb) };
        }
        "FORMULATEXT" | "ISFORMULA" | "ISREF" => {
            let rect = match raw_args.first() {
                Some(Expr::Ref(r)) => resolve_ref_at(r, ctx.wb, ctx.table, ctx.at).ok(),
                _ => None,
            };
            if name == "ISREF" {
                return b(rect.is_some());
            }
            let rect = match rect {
                Some(r) => r,
                None => return if name == "ISFORMULA" { b(false) } else { Arg::err(ErrorKind::NA) },
            };
            let cell = ctx.wb.table(rect.table).and_then(|t| t.get(CellKey::new(rect.r0, rect.c0)));
            let is_formula = cell.map(|c| c.kind == crate::model::CellKind::Formula).unwrap_or(false);
            return if name == "ISFORMULA" {
                b(is_formula)
            } else if is_formula {
                t(cell.map(|c| c.input.clone()).unwrap_or_default())
            } else {
                Arg::err(ErrorKind::NA)
            };
        }
        "ROW" | "COLUMN" => {
            return match (raw_args.first(), ctx.at) {
                (Some(Expr::Ref(r)), _) => match resolve_ref_at(r, ctx.wb, ctx.table, ctx.at) {
                    Ok(rect) => n((if name == "ROW" { rect.r0 } else { rect.c0 } + 1) as f64),
                    Err(e) => Arg::err(e),
                },
                (Some(_), _) => Arg::err(ErrorKind::Value),
                (None, Some(at)) => n((if name == "ROW" { at.row } else { at.col } + 1) as f64),
                _ => Arg::err(ErrorKind::Value),
            };
        }
        "SUBTOTAL" => {
            // SUBTOTAL(function_num, range...) — 101..111 ignore rows hidden by filters
            if raw_args.len() < 2 {
                return Arg::err(ErrorKind::Value);
            }
            let code = try_num!(ev(&raw_args[0]).scalar()) as i64;
            let skip_hidden = code > 100;
            let base = if skip_hidden { code - 100 } else { code };
            let mut vals: Vec<Value> = vec![];
            for e in &raw_args[1..] {
                match e {
                    Expr::Ref(r) => match resolve_ref_at(r, ctx.wb, ctx.table, ctx.at) {
                        Ok(rect) => {
                            let table = ctx.wb.table(rect.table).unwrap();
                            for rr in rect.r0..=rect.r1 {
                                if skip_hidden && table.is_row_hidden(rr) {
                                    continue;
                                }
                                for cc in rect.c0..=rect.c1 {
                                    vals.push(table.value_at(CellKey::new(rr, cc)));
                                }
                            }
                        }
                        Err(k) => return Arg::err(k),
                    },
                    other => vals.extend(ev(other).values()),
                }
            }
            let arr = Arg::Array(Array {
                rows: vals.len() as u32,
                cols: 1,
                data: vals,
            });
            let fname = match base {
                1 => "AVERAGE",
                2 => "COUNT",
                3 => "COUNTA",
                4 => "MAX",
                5 => "MIN",
                6 => "PRODUCT",
                7 => "STDEV",
                8 => "STDEVP",
                9 => "SUM",
                10 => "VAR",
                11 => "VARP",
                _ => return Arg::err(ErrorKind::Value),
            };
            return call_eager(fname, &[arr], ctx);
        }
        _ => {}
    }

    let args: Vec<Arg> = raw_args.iter().map(ev).collect();
    if LIFTED.contains(&name) && args.iter().any(|a| a.is_multi()) {
        return broadcast_n(&args, |vals| {
            let scalars: Vec<Arg> = vals.iter().map(|v| Arg::Scalar(v.clone())).collect();
            call_eager(name, &scalars, ctx)
        });
    }
    call_eager(name, &args, ctx)
}

fn call_eager(name: &str, args: &[Arg], ctx: &Ctx) -> Arg {
    let a = |i: usize| arg_at(args, i);
    let empty_arr = || Array::empty();

    match name {
        // ---------------- math & aggregates ----------------
        "SUM" => match numbers(args) {
            Ok(v) => n(v.iter().sum()),
            Err(e) => Arg::err(e),
        },
        "PRODUCT" => match numbers(args) {
            Ok(v) => n(v.iter().product()),
            Err(e) => Arg::err(e),
        },
        "AVERAGE" => match numbers(args) {
            Ok(v) if !v.is_empty() => n(v.iter().sum::<f64>() / v.len() as f64),
            Ok(_) => Arg::err(ErrorKind::Div0),
            Err(e) => Arg::err(e),
        },
        "MIN" => match numbers(args) {
            Ok(v) => n(v.iter().cloned().fold(f64::INFINITY, f64::min).min(if v.is_empty() { 0.0 } else { f64::INFINITY })),
            Err(e) => Arg::err(e),
        },
        "MAX" => match numbers(args) {
            Ok(v) => n(v.iter().cloned().fold(f64::NEG_INFINITY, f64::max).max(if v.is_empty() { 0.0 } else { f64::NEG_INFINITY })),
            Err(e) => Arg::err(e),
        },
        "COUNT" => match numbers(args) {
            Ok(v) => n(v.len() as f64),
            Err(_) => n(0.0),
        },
        "COUNTA" => n(args.iter().flat_map(|a| a.values()).filter(|v| !v.is_empty()).count() as f64),
        "COUNTBLANK" => n(args.iter().flat_map(|a| a.values()).filter(|v| v.is_empty()).count() as f64),
        "MEDIAN" => match numbers(args) {
            Ok(mut v) if !v.is_empty() => {
                v.sort_by(|x, y| x.partial_cmp(y).unwrap());
                let m = v.len() / 2;
                n(if v.len() % 2 == 1 { v[m] } else { (v[m - 1] + v[m]) / 2.0 })
            }
            Ok(_) => Arg::err(ErrorKind::Num),
            Err(e) => Arg::err(e),
        },
        "STDEV" | "STDEV.S" | "VAR" | "VAR.S" | "STDEVP" | "STDEV.P" | "VARP" | "VAR.P" => match numbers(args) {
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
        "ISEVEN" => b((try_num!(a(0)).trunc() as i64) % 2 == 0),
        "ISODD" => b((try_num!(a(0)).trunc() as i64) % 2 != 0),
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
            let crit = parse_criteria(&arg_at(args, 1));
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
        "SUMIFS" | "COUNTIFS" | "AVERAGEIFS" | "MAXIFS" | "MINIFS" => {
            let (sum_range, rest) = if name == "COUNTIFS" {
                (None, args)
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
            let mut best: Option<f64> = None;
            for i in 0..len {
                if pairs.iter().all(|(arr, c)| arr.data.get(i).map(|v| matches_criteria(v, c)).unwrap_or(false)) {
                    count += 1;
                    if let Some(sr) = &sum_range {
                        if let Some(Value::Number(x)) = sr.data.get(i) {
                            total += x;
                            best = Some(match (best, name) {
                                (None, _) => *x,
                                (Some(bb), "MAXIFS") => bb.max(*x),
                                (Some(bb), _) => bb.min(*x),
                            });
                        }
                    }
                }
            }
            match name {
                "SUMIFS" => n(total),
                "COUNTIFS" => n(count as f64),
                "MAXIFS" | "MINIFS" => n(best.unwrap_or(0.0)),
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
        "SWITCH" => {
            if args.len() < 3 {
                return Arg::err(ErrorKind::Value);
            }
            let x = a(0);
            let mut i = 1;
            while i + 1 < args.len() {
                let k = a(i);
                if compare(&x, &k) == std::cmp::Ordering::Equal && same_type(&x, &k) {
                    return Arg::Scalar(a(i + 1));
                }
                i += 2;
            }
            if args.len() % 2 == 0 {
                Arg::Scalar(a(args.len() - 1))
            } else {
                Arg::err(ErrorKind::NA)
            }
        }
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
        "VALUE" => match crate::model::parse_number_literal(&try_text!(a(0))).or_else(|| parse_date_time_text(&a(0).to_display()).map(|x| x.0)) {
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
                } else if compare(kv, &key) == std::cmp::Ordering::Equal && same_type(kv, &key) {
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
            let keys = args[1].as_array();
            let vals = args[2].as_array();
            let lookup = |key: &Value| -> Arg {
                for (i, kv) in keys.data.iter().enumerate() {
                    if compare(kv, key) == std::cmp::Ordering::Equal && same_type(kv, key) {
                        // return the matching row (or column) of the return array
                        if vals.rows == keys.rows && vals.cols > 1 && keys.cols == 1 {
                            return Arg::Array(Array {
                                rows: 1,
                                cols: vals.cols,
                                data: vals.row(i as u32),
                            })
                            .normalise();
                        }
                        if vals.cols == keys.cols && vals.rows > 1 && keys.rows == 1 {
                            return Arg::Array(Array {
                                rows: vals.rows,
                                cols: 1,
                                data: vals.column(i as u32),
                            })
                            .normalise();
                        }
                        return Arg::Scalar(vals.data.get(i).cloned().unwrap_or(Value::Empty));
                    }
                }
                if args.len() > 3 {
                    Arg::Scalar(a(3))
                } else {
                    Arg::err(ErrorKind::NA)
                }
            };
            match &args[0] {
                Arg::Array(ks) if ks.rows * ks.cols != 1 => {
                    let data: Vec<Value> = ks.data.iter().map(|k| lookup(k).scalar()).collect();
                    Arg::Array(Array {
                        rows: ks.rows,
                        cols: ks.cols,
                        data,
                    })
                }
                _ => lookup(&a(0)),
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
                    if ord == std::cmp::Ordering::Equal && same_type(v, &key) {
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
            // row or column 0 → whole column / row
            if r == 0 && c >= 1 && c <= arr.cols {
                return Arg::Array(Array {
                    rows: arr.rows,
                    cols: 1,
                    data: arr.column(c - 1),
                })
                .normalise();
            }
            if c == 0 && r >= 1 && r <= arr.rows {
                return Arg::Array(Array {
                    rows: 1,
                    cols: arr.cols,
                    data: arr.row(r - 1),
                })
                .normalise();
            }
            if r == 0 || c == 0 || r > arr.rows || c > arr.cols {
                return Arg::err(ErrorKind::Ref);
            }
            Arg::Scalar(arr.get(r - 1, c - 1).clone())
        }
        "ROWS" => n(args.first().map(|x| x.as_array().rows).unwrap_or(0) as f64),
        "COLUMNS" => n(args.first().map(|x| x.as_array().cols).unwrap_or(0) as f64),
        "TRANSPOSE" => {
            let arr = args.first().map(|x| x.as_array()).unwrap_or_else(empty_arr);
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
            let arr = args.first().map(|x| x.as_array()).unwrap_or_else(empty_arr);
            let by_col = args.len() > 1 && try_bool!(a(1));
            let exactly_once = args.len() > 2 && try_bool!(a(2));
            let items: Vec<Vec<Value>> = if by_col { (0..arr.cols).map(|c| arr.column(c)).collect() } else { (0..arr.rows).map(|r| arr.row(r)).collect() };
            let eq = |x: &Vec<Value>, y: &Vec<Value>| x.len() == y.len() && x.iter().zip(y).all(|(p, q)| compare(p, q) == std::cmp::Ordering::Equal && same_type(p, q));
            let mut out: Vec<Vec<Value>> = vec![];
            for it in &items {
                if !out.iter().any(|o| eq(o, it)) {
                    if exactly_once && items.iter().filter(|x| eq(x, it)).count() != 1 {
                        continue;
                    }
                    out.push(it.clone());
                }
            }
            if by_col {
                let rows = arr.rows;
                let cols = out.len() as u32;
                let mut data = vec![];
                for r in 0..rows as usize {
                    for col in &out {
                        data.push(col[r].clone());
                    }
                }
                Arg::Array(Array { rows, cols, data })
            } else {
                Arg::Array(Array::from_rows(out))
            }
        }
        "FILTER" => {
            if args.len() < 2 {
                return Arg::err(ErrorKind::Value);
            }
            let arr = args[0].as_array();
            let inc = args[1].as_array();
            let mut rows: Vec<Vec<Value>> = vec![];
            if inc.rows == arr.rows && (inc.cols == 1 || inc.cols == arr.cols) {
                for r in 0..arr.rows {
                    let keep = match to_bool(inc.get(r, 0)) {
                        Ok(x) => x,
                        Err(e) => return Arg::err(e),
                    };
                    if keep {
                        rows.push(arr.row(r));
                    }
                }
            } else if inc.cols == arr.cols && inc.rows == 1 {
                // column filter
                let mut keep_cols = vec![];
                for c in 0..arr.cols {
                    if try_bool!(inc.get(0, c).clone()) {
                        keep_cols.push(c);
                    }
                }
                for r in 0..arr.rows {
                    rows.push(keep_cols.iter().map(|c| arr.get(r, *c).clone()).collect());
                }
                if keep_cols.is_empty() {
                    rows.clear();
                }
            } else {
                return Arg::err(ErrorKind::Value);
            }
            if rows.is_empty() {
                return if args.len() > 2 { args[2].clone() } else { Arg::err(ErrorKind::NA) };
            }
            Arg::Array(Array::from_rows(rows))
        }
        "SORT" => {
            let arr = args.first().map(|x| x.as_array()).unwrap_or_else(empty_arr);
            let idx = if args.len() > 1 { try_num!(a(1)) as usize } else { 1 };
            let desc = args.len() > 2 && try_num!(a(2)) < 0.0;
            let by_col = args.len() > 3 && try_bool!(a(3));
            if idx == 0 {
                return Arg::err(ErrorKind::Value);
            }
            if by_col {
                if idx > arr.rows as usize {
                    return Arg::err(ErrorKind::Value);
                }
                let mut cols: Vec<Vec<Value>> = (0..arr.cols).map(|c| arr.column(c)).collect();
                cols.sort_by(|x, y| {
                    let o = compare(&x[idx - 1], &y[idx - 1]);
                    if desc {
                        o.reverse()
                    } else {
                        o
                    }
                });
                let mut data = vec![];
                for r in 0..arr.rows as usize {
                    for col in &cols {
                        data.push(col[r].clone());
                    }
                }
                return Arg::Array(Array {
                    rows: arr.rows,
                    cols: arr.cols,
                    data,
                });
            }
            if idx > arr.cols as usize {
                return Arg::err(ErrorKind::Value);
            }
            let mut rows: Vec<Vec<Value>> = (0..arr.rows).map(|r| arr.row(r)).collect();
            rows.sort_by(|x, y| {
                let o = compare(&x[idx - 1], &y[idx - 1]);
                if desc {
                    o.reverse()
                } else {
                    o
                }
            });
            Arg::Array(Array::from_rows(rows))
        }
        "SORTBY" => {
            if args.len() < 2 {
                return Arg::err(ErrorKind::Value);
            }
            let arr = args[0].as_array();
            let mut keys: Vec<(Array, bool)> = vec![];
            let mut i = 1;
            while i < args.len() {
                let k = args[i].as_array();
                let desc = if i + 1 < args.len() { try_num!(a(i + 1)) < 0.0 } else { false };
                if k.data.len() != arr.rows as usize {
                    return Arg::err(ErrorKind::Value);
                }
                keys.push((k, desc));
                i += 2;
            }
            let mut order: Vec<usize> = (0..arr.rows as usize).collect();
            order.sort_by(|x, y| {
                for (k, desc) in &keys {
                    let o = compare(&k.data[*x], &k.data[*y]);
                    if o != std::cmp::Ordering::Equal {
                        return if *desc { o.reverse() } else { o };
                    }
                }
                std::cmp::Ordering::Equal
            });
            Arg::Array(Array::from_rows(order.iter().map(|r| arr.row(*r as u32)).collect()))
        }
        "SEQUENCE" => {
            let rows = try_num!(a(0)).max(0.0) as u32;
            let cols = if args.len() > 1 { try_num!(a(1)).max(0.0) as u32 } else { 1 };
            let start = if args.len() > 2 { try_num!(a(2)) } else { 1.0 };
            let step = if args.len() > 3 { try_num!(a(3)) } else { 1.0 };
            if rows * cols > 1_000_000 {
                return Arg::err(ErrorKind::Num);
            }
            let data = (0..rows * cols).map(|i| Value::Number(start + step * i as f64)).collect();
            Arg::Array(Array { rows, cols, data }).normalise()
        }
        // ---------------- dates ----------------
        "TODAY" => n(ctx.now.floor()),
        "NOW" => n(ctx.now),
        "DATE" => n(serial_from_ymd(try_num!(a(0)) as i64, try_num!(a(1)) as i64, try_num!(a(2)) as i64)),
        "TIME" => n(((try_num!(a(0)) * 3600.0 + try_num!(a(1)) * 60.0 + try_num!(a(2))) / 86400.0).rem_euclid(1.0)),
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
        "HOUR" | "MINUTE" | "SECOND" => {
            let s = match date_arg(&a(0)) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            let secs = ((s - s.floor()) * 86400.0).round() as i64;
            n(match name {
                "HOUR" => secs / 3600,
                "MINUTE" => (secs / 60) % 60,
                _ => secs % 60,
            } as f64)
        }
        "DATEVALUE" => match parse_date_time_text(&try_text!(a(0))) {
            Some((s, _)) => n(s.floor()),
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
            let kind = if args.len() > 1 { try_num!(a(1)) as i64 } else { 1 };
            let mon0 = weekday_mon0(s);
            n(match kind {
                2 => mon0 + 1,
                3 => mon0,
                _ => (mon0 + 1) % 7 + 1, // 1 = Sunday
            } as f64)
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
        "DATEDIF" => {
            let start = match date_arg(&a(0)) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            let end = match date_arg(&a(1)) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            if end < start {
                return Arg::err(ErrorKind::Num);
            }
            let unit = try_text!(a(2)).to_uppercase();
            let (y0, m0, d0) = ymd_from_serial(start);
            let (y1, m1, d1) = ymd_from_serial(end);
            let mut months = (y1 - y0) * 12 + (m1 - m0);
            if d1 < d0 {
                months -= 1;
            }
            match unit.as_str() {
                "D" => n((end.floor() - start.floor()) as f64),
                "M" => n(months as f64),
                "Y" => n((months / 12) as f64),
                "YM" => n((months % 12) as f64),
                "MD" => {
                    let anchor = serial_from_ymd(y1, if d1 < d0 { m1 - 1 } else { m1 }, d0.min(28));
                    n((end.floor() - anchor).max(0.0))
                }
                "YD" => {
                    let anchor = serial_from_ymd(if (m1, d1) < (m0, d0) { y1 - 1 } else { y1 }, m0, d0);
                    n(end.floor() - anchor)
                }
                _ => Arg::err(ErrorKind::Num),
            }
        }
        "YEARFRAC" => {
            let start = match date_arg(&a(0)) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            let end = match date_arg(&a(1)) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            let basis = if args.len() > 2 { try_num!(a(2)) as i64 } else { 0 };
            let (s, e) = if start <= end { (start, end) } else { (end, start) };
            match basis {
                0 | 4 => {
                    let (y0, m0, mut d0) = ymd_from_serial(s);
                    let (y1, m1, mut d1) = ymd_from_serial(e);
                    if basis == 0 {
                        // US 30/360
                        if d0 == 31 {
                            d0 = 30;
                        }
                        if d1 == 31 && d0 >= 30 {
                            d1 = 30;
                        }
                    } else {
                        d0 = d0.min(30);
                        d1 = d1.min(30);
                    }
                    n(((y1 - y0) * 360 + (m1 - m0) * 30 + (d1 - d0)) as f64 / 360.0)
                }
                1 => {
                    let (y0, _, _) = ymd_from_serial(s);
                    let (y1, _, _) = ymd_from_serial(e);
                    let days = e.floor() - s.floor();
                    let year_len = if y0 == y1 {
                        serial_from_ymd(y0 + 1, 1, 1) - serial_from_ymd(y0, 1, 1)
                    } else {
                        (serial_from_ymd(y1 + 1, 1, 1) - serial_from_ymd(y0, 1, 1)) / (y1 - y0 + 1) as f64
                    };
                    n(days / year_len)
                }
                2 => n((e.floor() - s.floor()) / 360.0),
                3 => n((e.floor() - s.floor()) / 365.0),
                _ => Arg::err(ErrorKind::Num),
            }
        }
        "NETWORKDAYS" => {
            let start = match date_arg(&a(0)) {
                Ok(x) => x.floor(),
                Err(e) => return Arg::err(e),
            };
            let end = match date_arg(&a(1)) {
                Ok(x) => x.floor(),
                Err(e) => return Arg::err(e),
            };
            let holidays: Vec<f64> = args.get(2).map(|h| h.values().iter().filter_map(|v| to_number(v).ok().map(|x| x.floor())).collect()).unwrap_or_default();
            let (s, e, sign) = if start <= end { (start, end, 1.0) } else { (end, start, -1.0) };
            let mut count = 0;
            let mut d = s;
            while d <= e {
                let wd = weekday_mon0(d);
                if wd < 5 && !holidays.contains(&d) {
                    count += 1;
                }
                d += 1.0;
            }
            n(count as f64 * sign)
        }
        "WORKDAY" => {
            let start = match date_arg(&a(0)) {
                Ok(x) => x.floor(),
                Err(e) => return Arg::err(e),
            };
            let days = try_num!(a(1)) as i64;
            let holidays: Vec<f64> = args.get(2).map(|h| h.values().iter().filter_map(|v| to_number(v).ok().map(|x| x.floor())).collect()).unwrap_or_default();
            let step = if days >= 0 { 1.0 } else { -1.0 };
            let mut left = days.abs();
            let mut d = start;
            while left > 0 {
                d += step;
                if weekday_mon0(d) < 5 && !holidays.contains(&d) {
                    left -= 1;
                }
            }
            n(d)
        }
        // ---------------- financial ----------------
        "NPV" => {
            let rate = try_num!(a(0));
            let mut total = 0.0;
            let mut i = 1;
            for arg in &args[1.min(args.len())..] {
                let flows = match cash_flows(arg) {
                    Ok(f) => f,
                    Err(e) => return Arg::err(e),
                };
                for f in flows {
                    total += f / (1.0 + rate).powi(i);
                    i += 1;
                }
            }
            n(total)
        }
        "IRR" => {
            let flows = match args.first().map(cash_flows).unwrap_or(Ok(vec![])) {
                Ok(f) => f,
                Err(e) => return Arg::err(e),
            };
            let guess = if args.len() > 1 { try_num!(a(1)) } else { 0.1 };
            match irr(&flows, guess) {
                Some(r) => n(r),
                None => Arg::err(ErrorKind::Num),
            }
        }
        "XNPV" => {
            let rate = try_num!(a(0));
            let flows = args.get(1).map(|x| x.values()).unwrap_or_default();
            let dates = args.get(2).map(|x| x.values()).unwrap_or_default();
            if flows.len() != dates.len() || flows.is_empty() {
                return Arg::err(ErrorKind::Num);
            }
            let d0 = match date_arg(&dates[0]) {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            };
            let mut total = 0.0;
            for (f, d) in flows.iter().zip(dates.iter()) {
                let fv = try_num!(f);
                let dv = match date_arg(d) {
                    Ok(x) => x,
                    Err(e) => return Arg::err(e),
                };
                total += fv / (1.0 + rate).powf((dv - d0) / 365.0);
            }
            n(total)
        }
        "XIRR" => {
            let flows: Vec<f64> = match args.first().map(|x| x.values().iter().map(to_number).collect::<Result<Vec<_>, _>>()).unwrap_or(Ok(vec![])) {
                Ok(f) => f,
                Err(e) => return Arg::err(e),
            };
            let dates: Vec<f64> = match args.get(1).map(|x| x.values().iter().map(date_arg).collect::<Result<Vec<_>, _>>()).unwrap_or(Ok(vec![])) {
                Ok(f) => f,
                Err(e) => return Arg::err(e),
            };
            if flows.len() != dates.len() || flows.len() < 2 {
                return Arg::err(ErrorKind::Num);
            }
            let guess = if args.len() > 2 { try_num!(a(2)) } else { 0.1 };
            let d0 = dates[0];
            let f = |r: f64| flows.iter().zip(dates.iter()).map(|(cf, d)| cf / (1.0 + r).powf((d - d0) / 365.0)).sum::<f64>();
            match newton(f, guess) {
                Some(r) => n(r),
                None => Arg::err(ErrorKind::Num),
            }
        }
        "PMT" | "IPMT" | "PPMT" | "PV" | "FV" | "NPER" | "RATE" => annuity(name, args),
        "SLN" => {
            let life = try_num!(a(2));
            if life == 0.0 {
                return Arg::err(ErrorKind::Div0);
            }
            n((try_num!(a(0)) - try_num!(a(1))) / life)
        }
        "EFFECT" => {
            let r = try_num!(a(0));
            let m = try_num!(a(1)).floor();
            if m < 1.0 || r <= 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            n((1.0 + r / m).powf(m) - 1.0)
        }
        "NOMINAL" => {
            let r = try_num!(a(0));
            let m = try_num!(a(1)).floor();
            if m < 1.0 || r <= 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            n(m * ((1.0 + r).powf(1.0 / m) - 1.0))
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
        "RANK" | "RANK.EQ" => {
            let x = try_num!(a(0));
            let arr = args.get(1).map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let asc = args.len() > 2 && try_bool!(a(2));
            let nums: Vec<f64> = arr.data.iter().filter_map(|v| if let Value::Number(y) = v { Some(*y) } else { None }).collect();
            if !nums.contains(&x) {
                return Arg::err(ErrorKind::NA);
            }
            let rank = nums.iter().filter(|&&y| if asc { y < x } else { y > x }).count() + 1;
            n(rank as f64)
        }
        "LARGE" | "SMALL" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let k = try_num!(a(1)) as usize;
            let mut nums: Vec<f64> = arr.data.iter().filter_map(|v| if let Value::Number(y) = v { Some(*y) } else { None }).collect();
            if k == 0 || k > nums.len() {
                return Arg::err(ErrorKind::Num);
            }
            nums.sort_by(|x, y| x.partial_cmp(y).unwrap());
            n(if name == "SMALL" { nums[k - 1] } else { nums[nums.len() - k] })
        }
        // ---------------- more maths ----------------
        "QUOTIENT" => {
            let d = try_num!(a(1));
            if d == 0.0 {
                return Arg::err(ErrorKind::Div0);
            }
            n((try_num!(a(0)) / d).trunc())
        }
        "GCD" | "LCM" => match numbers(args) {
            Ok(v) => {
                if v.iter().any(|x| *x < 0.0) {
                    return Arg::err(ErrorKind::Num);
                }
                let ints: Vec<u64> = v.iter().map(|x| x.floor() as u64).collect();
                let gcd = |mut a: u64, mut b: u64| {
                    while b != 0 {
                        let t = a % b;
                        a = b;
                        b = t;
                    }
                    a
                };
                if name == "GCD" {
                    n(ints.iter().fold(0u64, |acc, x| gcd(acc, *x)) as f64)
                } else {
                    n(ints.iter().fold(1u64, |acc, x| if *x == 0 { 0 } else { acc / gcd(acc, *x) * *x }) as f64)
                }
            }
            Err(e) => Arg::err(e),
        },
        "FACT" => {
            let x = try_num!(a(0)).floor();
            if x < 0.0 || x > 170.0 {
                return Arg::err(ErrorKind::Num);
            }
            n((1..=(x as u64)).fold(1.0, |acc, k| acc * k as f64))
        }
        "COMBIN" | "PERMUT" => {
            let nn = try_num!(a(0)).floor();
            let k = try_num!(a(1)).floor();
            if nn < 0.0 || k < 0.0 || k > nn {
                return Arg::err(ErrorKind::Num);
            }
            let mut r = 1.0;
            for i in 0..(k as u64) {
                r *= nn - i as f64;
                if name == "COMBIN" {
                    r /= (i + 1) as f64;
                }
            }
            n(r.round())
        }
        "MROUND" => {
            let x = try_num!(a(0));
            let m = try_num!(a(1));
            if m == 0.0 {
                return n(0.0);
            }
            if (x < 0.0) != (m < 0.0) {
                return Arg::err(ErrorKind::Num);
            }
            n((x / m).round() * m)
        }
        "EVEN" | "ODD" => {
            let x = try_num!(a(0));
            let mut r = x.abs().ceil();
            if name == "EVEN" {
                if r % 2.0 != 0.0 {
                    r += 1.0;
                }
            } else if r % 2.0 == 0.0 {
                r += 1.0;
            }
            n(if x < 0.0 { -r } else { r })
        }
        "SUMSQ" => match numbers(args) {
            Ok(v) => n(v.iter().map(|x| x * x).sum()),
            Err(e) => Arg::err(e),
        },
        "SQRTPI" => {
            let x = try_num!(a(0));
            if x < 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            n((x * std::f64::consts::PI).sqrt())
        }
        "RADIANS" => n(try_num!(a(0)).to_radians()),
        "DEGREES" => n(try_num!(a(0)).to_degrees()),
        "SIN" => n(try_num!(a(0)).sin()),
        "COS" => n(try_num!(a(0)).cos()),
        "TAN" => n(try_num!(a(0)).tan()),
        "ASIN" => n(try_num!(a(0)).asin()),
        "ACOS" => n(try_num!(a(0)).acos()),
        "ATAN" => n(try_num!(a(0)).atan()),
        "ATAN2" => n(try_num!(a(1)).atan2(try_num!(a(0)))),
        "SINH" => n(try_num!(a(0)).sinh()),
        "COSH" => n(try_num!(a(0)).cosh()),
        "TANH" => n(try_num!(a(0)).tanh()),
        "RAND" => n(pseudo_random()),
        "RANDBETWEEN" => {
            let lo = try_num!(a(0)).ceil();
            let hi = try_num!(a(1)).floor();
            if hi < lo {
                return Arg::err(ErrorKind::Num);
            }
            n(lo + (pseudo_random() * (hi - lo + 1.0)).floor())
        }
        "CEILING.MATH" | "FLOOR.MATH" => {
            let x = try_num!(a(0));
            let sig = match args.get(1).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => 1.0,
                Some(v) => try_num!(v).abs(),
            };
            if sig == 0.0 {
                return n(0.0);
            }
            let q = x / sig;
            n(if name == "CEILING.MATH" { q.ceil() } else { q.floor() } * sig)
        }
        "BASE" => {
            let x = try_num!(a(0)).floor();
            let radix = try_num!(a(1)).floor() as u32;
            if !(2..=36).contains(&radix) || x < 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            let min_len = args.get(2).map(|v| v.clone().scalar()).map(|v| to_number(&v).unwrap_or(0.0) as usize).unwrap_or(0);
            let mut v = x as u64;
            let digits = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            let mut out = vec![];
            if v == 0 {
                out.push(b'0');
            }
            while v > 0 {
                out.push(digits[(v % radix as u64) as usize]);
                v /= radix as u64;
            }
            out.reverse();
            let mut s = String::from_utf8(out).unwrap_or_default();
            while s.len() < min_len {
                s.insert(0, '0');
            }
            t(s)
        }
        "DECIMAL" => {
            let text = try_text!(a(0)).trim().to_ascii_uppercase();
            let radix = try_num!(a(1)).floor() as u32;
            if !(2..=36).contains(&radix) {
                return Arg::err(ErrorKind::Num);
            }
            match u64::from_str_radix(&text, radix) {
                Ok(v) => n(v as f64),
                Err(_) => Arg::err(ErrorKind::Num),
            }
        }
        // ---------------- more statistics ----------------
        "AVERAGEA" | "MAXA" | "MINA" => {
            let vals: Vec<f64> = args
                .iter()
                .flat_map(|x| x.values())
                .filter(|v| !v.is_empty())
                .map(|v| match v {
                    Value::Number(x) => x,
                    Value::Bool(bv) => if bv { 1.0 } else { 0.0 },
                    _ => 0.0,
                })
                .collect();
            if vals.is_empty() {
                return if name == "AVERAGEA" { Arg::err(ErrorKind::Div0) } else { n(0.0) };
            }
            n(match name {
                "AVERAGEA" => vals.iter().sum::<f64>() / vals.len() as f64,
                "MAXA" => vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
                _ => vals.iter().cloned().fold(f64::INFINITY, f64::min),
            })
        }
        "MODE" | "MODE.SNGL" => match numbers(args) {
            Ok(v) => {
                let mut best: Option<(f64, usize)> = None;
                for x in &v {
                    let c = v.iter().filter(|y| *y == x).count();
                    if c > 1 && best.map(|(_, bc)| c > bc).unwrap_or(true) {
                        best = Some((*x, c));
                    }
                }
                match best {
                    Some((x, _)) => n(x),
                    None => Arg::err(ErrorKind::NA),
                }
            }
            Err(e) => Arg::err(e),
        },
        "PERCENTILE" | "PERCENTILE.INC" | "PERCENTILE.EXC" | "QUARTILE" | "QUARTILE.INC" | "QUARTILE.EXC" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let mut v: Vec<f64> = arr.data.iter().filter_map(|x| if let Value::Number(y) = x { Some(*y) } else { None }).collect();
            if v.is_empty() {
                return Arg::err(ErrorKind::Num);
            }
            v.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let k = try_num!(a(1));
            let p = if name.starts_with("QUARTILE") { k / 4.0 } else { k };
            let exc = name.ends_with(".EXC");
            let nn = v.len() as f64;
            if exc {
                if p <= 0.0 || p >= 1.0 {
                    return Arg::err(ErrorKind::Num);
                }
                let pos = p * (nn + 1.0);
                if pos < 1.0 || pos > nn {
                    return Arg::err(ErrorKind::Num);
                }
                let i = pos.floor() as usize;
                let f = pos - pos.floor();
                let lo = v[i - 1];
                let hi = v[(i).min(v.len() - 1)];
                n(lo + (hi - lo) * f)
            } else {
                if !(0.0..=1.0).contains(&p) {
                    return Arg::err(ErrorKind::Num);
                }
                let pos = p * (nn - 1.0);
                let i = pos.floor() as usize;
                let f = pos - pos.floor();
                let lo = v[i];
                let hi = v[(i + 1).min(v.len() - 1)];
                n(lo + (hi - lo) * f)
            }
        }
        "PERCENTRANK" | "PERCENTRANK.INC" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let mut v: Vec<f64> = arr.data.iter().filter_map(|x| if let Value::Number(y) = x { Some(*y) } else { None }).collect();
            let x = try_num!(a(1));
            if v.len() < 2 {
                return Arg::err(ErrorKind::NA);
            }
            v.sort_by(|p, q| p.partial_cmp(q).unwrap());
            if x < v[0] || x > v[v.len() - 1] {
                return Arg::err(ErrorKind::NA);
            }
            let nn = (v.len() - 1) as f64;
            let below = v.iter().filter(|y| **y < x).count() as f64;
            let r = if v.contains(&x) {
                below / nn
            } else {
                // interpolate between neighbours
                let lo = v.iter().filter(|y| **y < x).cloned().fold(f64::NEG_INFINITY, f64::max);
                let hi = v.iter().filter(|y| **y > x).cloned().fold(f64::INFINITY, f64::min);
                (below - 1.0 + (x - lo) / (hi - lo)) / nn
            };
            let digits = args.get(2).map(|d| to_number(&d.clone().scalar()).unwrap_or(3.0)).unwrap_or(3.0);
            n(round_to(r, digits, 2))
        }
        "RANK.AVG" => {
            let x = try_num!(a(0));
            let arr = args.get(1).map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let asc = args.len() > 2 && try_bool!(a(2));
            let nums: Vec<f64> = arr.data.iter().filter_map(|v| if let Value::Number(y) = v { Some(*y) } else { None }).collect();
            if !nums.contains(&x) {
                return Arg::err(ErrorKind::NA);
            }
            let better = nums.iter().filter(|&&y| if asc { y < x } else { y > x }).count();
            let ties = nums.iter().filter(|&&y| y == x).count();
            n(better as f64 + (ties as f64 + 1.0) / 2.0)
        }
        "CORREL" | "PEARSON" | "COVARIANCE.P" | "COVARIANCE.S" | "COVAR" | "SLOPE" | "INTERCEPT" | "RSQ" | "FORECAST" | "FORECAST.LINEAR" | "STEYX" => {
            let (xs, ys) = match name {
                "FORECAST" | "FORECAST.LINEAR" => (args.get(2).map(|v| v.as_array()).unwrap_or_else(empty_arr), args.get(1).map(|v| v.as_array()).unwrap_or_else(empty_arr)),
                "SLOPE" | "INTERCEPT" | "RSQ" | "STEYX" => (args.get(1).map(|v| v.as_array()).unwrap_or_else(empty_arr), args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr)),
                _ => (args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr), args.get(1).map(|v| v.as_array()).unwrap_or_else(empty_arr)),
            };
            let pairs: Vec<(f64, f64)> = xs.data.iter().zip(ys.data.iter()).filter_map(|(x, y)| match (x, y) {
                (Value::Number(p), Value::Number(q)) => Some((*p, *q)),
                _ => None,
            }).collect();
            let k = pairs.len() as f64;
            if k < 2.0 {
                return Arg::err(ErrorKind::Div0);
            }
            let mx = pairs.iter().map(|p| p.0).sum::<f64>() / k;
            let my = pairs.iter().map(|p| p.1).sum::<f64>() / k;
            let sxy: f64 = pairs.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
            let sxx: f64 = pairs.iter().map(|p| (p.0 - mx).powi(2)).sum();
            let syy: f64 = pairs.iter().map(|p| (p.1 - my).powi(2)).sum();
            match name {
                "CORREL" | "PEARSON" => n(sxy / (sxx * syy).sqrt()),
                "COVARIANCE.P" | "COVAR" => n(sxy / k),
                "COVARIANCE.S" => n(sxy / (k - 1.0)),
                "SLOPE" => n(sxy / sxx),
                "INTERCEPT" => n(my - (sxy / sxx) * mx),
                "RSQ" => n((sxy * sxy) / (sxx * syy)),
                "STEYX" => n(((syy - sxy * sxy / sxx) / (k - 2.0)).sqrt()),
                _ => {
                    let x = try_num!(a(0));
                    n(my + (sxy / sxx) * (x - mx))
                }
            }
        }
        "GEOMEAN" => match numbers(args) {
            Ok(v) if !v.is_empty() && v.iter().all(|x| *x > 0.0) => n((v.iter().map(|x| x.ln()).sum::<f64>() / v.len() as f64).exp()),
            Ok(_) => Arg::err(ErrorKind::Num),
            Err(e) => Arg::err(e),
        },
        "HARMEAN" => match numbers(args) {
            Ok(v) if !v.is_empty() && v.iter().all(|x| *x > 0.0) => n(v.len() as f64 / v.iter().map(|x| 1.0 / x).sum::<f64>()),
            Ok(_) => Arg::err(ErrorKind::Num),
            Err(e) => Arg::err(e),
        },
        "DEVSQ" | "AVEDEV" => match numbers(args) {
            Ok(v) if !v.is_empty() => {
                let m = v.iter().sum::<f64>() / v.len() as f64;
                if name == "DEVSQ" {
                    n(v.iter().map(|x| (x - m).powi(2)).sum())
                } else {
                    n(v.iter().map(|x| (x - m).abs()).sum::<f64>() / v.len() as f64)
                }
            }
            Ok(_) => Arg::err(ErrorKind::Num),
            Err(e) => Arg::err(e),
        },
        "TRIMMEAN" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let mut v: Vec<f64> = arr.data.iter().filter_map(|x| if let Value::Number(y) = x { Some(*y) } else { None }).collect();
            let pct = try_num!(a(1));
            if v.is_empty() || !(0.0..1.0).contains(&pct) {
                return Arg::err(ErrorKind::Num);
            }
            v.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let drop = ((v.len() as f64 * pct) / 2.0).floor() as usize;
            let kept = &v[drop..v.len() - drop];
            n(kept.iter().sum::<f64>() / kept.len() as f64)
        }
        "COUNTUNIQUE" => {
            let mut seen: Vec<String> = vec![];
            for v in args.iter().flat_map(|x| x.values()) {
                if v.is_empty() {
                    continue;
                }
                let key = v.to_display().to_lowercase();
                if !seen.contains(&key) {
                    seen.push(key);
                }
            }
            n(seen.len() as f64)
        }
        "NORM.DIST" | "NORMDIST" => {
            let x = try_num!(a(0));
            let mean = try_num!(a(1));
            let sd = try_num!(a(2));
            let cumulative = try_bool!(a(3));
            if sd <= 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            n(if cumulative { normal_cdf((x - mean) / sd) } else { (-0.5 * ((x - mean) / sd).powi(2)).exp() / (sd * (2.0 * std::f64::consts::PI).sqrt()) })
        }
        "NORM.S.DIST" | "NORMSDIST" => {
            let z = try_num!(a(0));
            let cumulative = args.len() < 2 || try_bool!(a(1));
            n(if cumulative { normal_cdf(z) } else { (-0.5 * z * z).exp() / (2.0 * std::f64::consts::PI).sqrt() })
        }
        "NORM.INV" | "NORMINV" => {
            let p = try_num!(a(0));
            let mean = try_num!(a(1));
            let sd = try_num!(a(2));
            if p <= 0.0 || p >= 1.0 || sd <= 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            n(mean + sd * normal_inv(p))
        }
        "NORM.S.INV" | "NORMSINV" => {
            let p = try_num!(a(0));
            if p <= 0.0 || p >= 1.0 {
                return Arg::err(ErrorKind::Num);
            }
            n(normal_inv(p))
        }
        "STANDARDIZE" => {
            let sd = try_num!(a(2));
            if sd <= 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            n((try_num!(a(0)) - try_num!(a(1))) / sd)
        }
        // ---------------- more text ----------------
        "CHAR" | "UNICHAR" => {
            let code = try_num!(a(0)) as u32;
            match char::from_u32(code) {
                Some(c) if code > 0 => t(c.to_string()),
                _ => Arg::err(ErrorKind::Value),
            }
        }
        "CODE" | "UNICODE" => {
            let s = try_text!(a(0));
            match s.chars().next() {
                Some(c) => n(c as u32 as f64),
                None => Arg::err(ErrorKind::Value),
            }
        }
        "CLEAN" => t(try_text!(a(0)).chars().filter(|c| !c.is_control()).collect()),
        "FIXED" => {
            let x = try_num!(a(0));
            let d = match args.get(1).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => 2.0,
                Some(v) => try_num!(v),
            };
            let no_commas = args.len() > 2 && try_bool!(a(2));
            let pattern = if no_commas { format!("0{}", if d > 0.0 { format!(".{}", "0".repeat(d as usize)) } else { String::new() }) } else { format!("#,##0{}", if d > 0.0 { format!(".{}", "0".repeat(d as usize)) } else { String::new() }) };
            t(format_text(&Value::Number(round_to(x, d, 0)), &pattern))
        }
        "NUMBERVALUE" => {
            let mut s = try_text!(a(0)).trim().to_string();
            let dec = args.get(1).map(|v| v.clone().scalar().to_display()).unwrap_or_else(|| ".".into());
            let grp = args.get(2).map(|v| v.clone().scalar().to_display()).unwrap_or_else(|| ",".into());
            if !grp.is_empty() {
                s = s.replace(&grp, "");
            }
            if !dec.is_empty() && dec != "." {
                s = s.replace(&dec, ".");
            }
            let pct = s.matches('%').count() as i32;
            s = s.replace('%', "");
            match s.trim().parse::<f64>() {
                Ok(v) => n(v / 100f64.powi(pct)),
                Err(_) => Arg::err(ErrorKind::Value),
            }
        }
        "REPLACE" => {
            let s: Vec<char> = try_text!(a(0)).chars().collect();
            let start = (try_num!(a(1)) as usize).max(1) - 1;
            let count = try_num!(a(2)).max(0.0) as usize;
            let new = try_text!(a(3));
            let mut out: String = s.iter().take(start.min(s.len())).collect();
            out.push_str(&new);
            out.extend(s.iter().skip((start + count).min(s.len())));
            t(out)
        }
        "TEXTSPLIT" | "SPLIT" => {
            let text = try_text!(a(0));
            let col_delims: Vec<String> = args.get(1).map(|v| v.values().iter().map(|x| x.to_display()).filter(|x| !x.is_empty()).collect()).unwrap_or_default();
            let row_delims: Vec<String> = if name == "TEXTSPLIT" { args.get(2).map(|v| v.values().iter().map(|x| x.to_display()).filter(|x| !x.is_empty()).collect()).unwrap_or_default() } else { vec![] };
            let ignore_empty = if name == "TEXTSPLIT" { args.len() > 3 && try_bool!(a(3)) } else { args.len() < 3 || try_bool!(a(2)) };
            let split_by = |s: &str, delims: &[String]| -> Vec<String> {
                if delims.is_empty() {
                    return vec![s.to_string()];
                }
                let mut parts = vec![s.to_string()];
                for d in delims {
                    parts = parts.iter().flat_map(|p| p.split(d.as_str()).map(|x| x.to_string()).collect::<Vec<_>>()).collect();
                }
                parts
            };
            let rows: Vec<Vec<Value>> = split_by(&text, &row_delims)
                .into_iter()
                .map(|r| split_by(&r, &col_delims).into_iter().filter(|x| !(ignore_empty && x.is_empty())).map(|x| Value::parse_literal(&x)).collect())
                .filter(|r: &Vec<Value>| !r.is_empty())
                .collect();
            if rows.is_empty() {
                return t(String::new());
            }
            Arg::Array(Array::from_rows(rows)).normalise()
        }
        "TEXTBEFORE" | "TEXTAFTER" => {
            let text = try_text!(a(0));
            let delim = try_text!(a(1));
            let inst = match args.get(2).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => 1i64,
                Some(v) => try_num!(v) as i64,
            };
            if delim.is_empty() || inst == 0 {
                return Arg::err(ErrorKind::Value);
            }
            let positions: Vec<usize> = text.match_indices(delim.as_str()).map(|(i, _)| i).collect();
            let idx = if inst > 0 { positions.get(inst as usize - 1) } else { positions.len().checked_sub((-inst) as usize).and_then(|i| positions.get(i)) };
            match idx {
                Some(&i) => t(if name == "TEXTBEFORE" { text[..i].to_string() } else { text[i + delim.len()..].to_string() }),
                None => Arg::err(ErrorKind::NA),
            }
        }
        "REGEXMATCH" | "REGEXEXTRACT" | "REGEXREPLACE" => {
            let text = try_text!(a(0));
            let pattern = try_text!(a(1));
            let re = match regex_lite::Regex::new(&pattern) {
                Ok(r) => r,
                Err(_) => return Arg::err(ErrorKind::Value),
            };
            match name {
                "REGEXMATCH" => b(re.is_match(&text)),
                "REGEXEXTRACT" => match re.captures(&text) {
                    Some(c) => t(c.get(1).or_else(|| c.get(0)).map(|m| m.as_str().to_string()).unwrap_or_default()),
                    None => Arg::err(ErrorKind::NA),
                },
                _ => {
                    let rep = try_text!(a(2));
                    t(re.replace_all(&text, rep.as_str()).to_string())
                }
            }
        }
        "ARRAYTOTEXT" | "VALUETOTEXT" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let concise = args.get(1).map(|v| to_number(&v.clone().scalar()).unwrap_or(0.0) == 0.0).unwrap_or(true);
            if name == "VALUETOTEXT" || arr.rows * arr.cols == 1 {
                let v = arr.data.first().cloned().unwrap_or(Value::Empty);
                return t(if concise || !matches!(v, Value::Text(_)) { v.to_display() } else { format!("\"{}\"", v.to_display()) });
            }
            let rows: Vec<String> = (0..arr.rows).map(|r| arr.row(r).iter().map(|v| if concise || !matches!(v, Value::Text(_)) { v.to_display() } else { format!("\"{}\"", v.to_display()) }).collect::<Vec<_>>().join(if concise { ", " } else { "," })).collect();
            t(if concise { rows.join("; ") } else { format!("{{{}}}", rows.join(";")) })
        }
        "JOIN" => {
            let delim = try_text!(a(0));
            let parts: Vec<String> = args.iter().skip(1).flat_map(|x| x.values()).map(|v| v.to_display()).collect();
            t(parts.join(&delim))
        }
        // ---------------- more lookup & array shaping ----------------
        "INDIRECT" => {
            let text = try_text!(a(0));
            match super::parser::parse(text.trim().trim_start_matches('=')) {
                Ok(Expr::Ref(r)) => match resolve_ref_at(&r, ctx.wb, ctx.table, ctx.at) {
                    Ok(rect) => {
                        if rect.r0 == rect.r1 && rect.c0 == rect.c1 {
                            Arg::Scalar(ctx.wb.value(crate::model::CellRef::new(rect.table, rect.r0, rect.c0)))
                        } else {
                            range_arg(rect, ctx.wb)
                        }
                    }
                    Err(e) => Arg::err(e),
                },
                Ok(Expr::Name(nm)) => match ctx.wb.named_range(&nm) {
                    Some(nr) => super::evaluate_full(ctx.wb, ctx.table, ctx.at, &nr.reference),
                    None => Arg::err(ErrorKind::Ref),
                },
                _ => Arg::err(ErrorKind::Ref),
            }
        }
        "ADDRESS" => {
            let row = try_num!(a(0)) as i64;
            let col = try_num!(a(1)) as i64;
            if row < 1 || col < 1 {
                return Arg::err(ErrorKind::Value);
            }
            let abs = match args.get(2).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => 1,
                Some(v) => try_num!(v) as i64,
            };
            let col_text = crate::model::col_to_letters((col - 1) as u32);
            let cell = match abs {
                2 => format!("{}${}", col_text, row),
                3 => format!("${}{}", col_text, row),
                4 => format!("{}{}", col_text, row),
                _ => format!("${}${}", col_text, row),
            };
            match args.get(4).map(|v| v.clone().scalar()) {
                Some(Value::Text(sheet)) if !sheet.is_empty() => t(format!("{}::{}", if sheet.chars().all(|c| c.is_alphanumeric() || c == '_') { sheet } else { format!("'{}'", sheet) }, cell)),
                _ => t(cell),
            }
        }
        "LOOKUP" => {
            let x = a(0);
            let vector = args.get(1).map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let result = args.get(2).map(|v| v.as_array()).unwrap_or_else(|| vector.clone());
            let mut best: Option<usize> = None;
            for (i, v) in vector.data.iter().enumerate() {
                if v.is_empty() {
                    continue;
                }
                if compare(v, &x) != std::cmp::Ordering::Greater {
                    best = Some(i);
                } else {
                    break;
                }
            }
            match best {
                Some(i) => Arg::Scalar(result.data.get(i).cloned().unwrap_or(Value::Error(ErrorKind::NA))),
                None => Arg::err(ErrorKind::NA),
            }
        }
        "XMATCH" => {
            let x = a(0);
            let arr = args.get(1).map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let mode = match args.get(2).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => 0i64,
                Some(v) => try_num!(v) as i64,
            };
            let mut best: Option<(usize, Value)> = None;
            for (i, v) in arr.data.iter().enumerate() {
                let ord = compare(v, &x);
                match mode {
                    0 => {
                        if ord == std::cmp::Ordering::Equal {
                            return n(i as f64 + 1.0);
                        }
                    }
                    -1 => {
                        if ord != std::cmp::Ordering::Greater && best.as_ref().map(|(_, bv)| compare(v, bv) == std::cmp::Ordering::Greater).unwrap_or(true) {
                            best = Some((i, v.clone()));
                        }
                    }
                    1 => {
                        if ord != std::cmp::Ordering::Less && best.as_ref().map(|(_, bv)| compare(v, bv) == std::cmp::Ordering::Less).unwrap_or(true) {
                            best = Some((i, v.clone()));
                        }
                    }
                    _ => return Arg::err(ErrorKind::Value),
                }
            }
            match best {
                Some((i, v)) if mode != 0 && (mode != -1 || compare(&v, &x) != std::cmp::Ordering::Greater) => n(i as f64 + 1.0),
                _ => Arg::err(ErrorKind::NA),
            }
        }
        "HSTACK" | "VSTACK" => {
            let arrays: Vec<Array> = args.iter().map(|v| v.as_array()).collect();
            if arrays.is_empty() {
                return Arg::err(ErrorKind::Value);
            }
            if name == "VSTACK" {
                let cols = arrays.iter().map(|x| x.cols).max().unwrap_or(0);
                let mut rows: Vec<Vec<Value>> = vec![];
                for x in &arrays {
                    for r in 0..x.rows {
                        let mut row = x.row(r);
                        row.resize(cols as usize, Value::Error(ErrorKind::NA));
                        rows.push(row);
                    }
                }
                Arg::Array(Array::from_rows(rows))
            } else {
                let nrows = arrays.iter().map(|x| x.rows).max().unwrap_or(0);
                let mut rows: Vec<Vec<Value>> = (0..nrows).map(|_| vec![]).collect();
                for x in &arrays {
                    for r in 0..nrows {
                        if r < x.rows {
                            rows[r as usize].extend(x.row(r));
                        } else {
                            rows[r as usize].extend((0..x.cols).map(|_| Value::Error(ErrorKind::NA)));
                        }
                    }
                }
                Arg::Array(Array::from_rows(rows))
            }
        }
        "TAKE" | "DROP" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let rows_n = match args.get(1).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => None,
                Some(v) => Some(try_num!(v) as i64),
            };
            let cols_n = match args.get(2).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => None,
                Some(v) => Some(try_num!(v) as i64),
            };
            let pick = |len: u32, k: Option<i64>| -> (u32, u32) {
                let len_i = len as i64;
                match (name, k) {
                    (_, None) => (0, len),
                    ("TAKE", Some(k)) if k >= 0 => (0, k.min(len_i) as u32),
                    ("TAKE", Some(k)) => ((len_i + k).max(0) as u32, len),
                    (_, Some(k)) if k >= 0 => (k.min(len_i) as u32, len),
                    (_, Some(k)) => (0, (len_i + k).max(0) as u32),
                }
            };
            let (r0, r1) = pick(arr.rows, rows_n);
            let (c0, c1) = pick(arr.cols, cols_n);
            if r1 <= r0 || c1 <= c0 {
                return Arg::err(ErrorKind::Value);
            }
            let rows: Vec<Vec<Value>> = (r0..r1).map(|r| (c0..c1).map(|c| arr.get(r, c).clone()).collect()).collect();
            Arg::Array(Array::from_rows(rows)).normalise()
        }
        "CHOOSECOLS" | "CHOOSEROWS" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let mut idx: Vec<i64> = vec![];
            for v in args.iter().skip(1).flat_map(|x| x.values()) {
                idx.push(try_num!(v) as i64);
            }
            let len = if name == "CHOOSECOLS" { arr.cols } else { arr.rows } as i64;
            let mut picks: Vec<u32> = vec![];
            for i in idx {
                let k = if i < 0 { len + i } else { i - 1 };
                if k < 0 || k >= len {
                    return Arg::err(ErrorKind::Value);
                }
                picks.push(k as u32);
            }
            let rows: Vec<Vec<Value>> = if name == "CHOOSECOLS" {
                (0..arr.rows).map(|r| picks.iter().map(|c| arr.get(r, *c).clone()).collect()).collect()
            } else {
                picks.iter().map(|r| arr.row(*r)).collect()
            };
            Arg::Array(Array::from_rows(rows)).normalise()
        }
        "TOCOL" | "TOROW" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let ignore = match args.get(1).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => 0i64,
                Some(v) => try_num!(v) as i64,
            };
            let by_col = args.len() > 2 && try_bool!(a(2));
            let mut vals: Vec<Value> = vec![];
            if by_col {
                for c in 0..arr.cols {
                    for r in 0..arr.rows {
                        vals.push(arr.get(r, c).clone());
                    }
                }
            } else {
                vals = arr.data.clone();
            }
            let vals: Vec<Value> = vals.into_iter().filter(|v| !((ignore == 1 || ignore == 3) && v.is_empty()) && !((ignore == 2 || ignore == 3) && matches!(v, Value::Error(_)))).collect();
            if vals.is_empty() {
                return Arg::err(ErrorKind::Value);
            }
            let len = vals.len() as u32;
            Arg::Array(if name == "TOCOL" { Array { rows: len, cols: 1, data: vals } } else { Array { rows: 1, cols: len, data: vals } }).normalise()
        }
        "WRAPROWS" | "WRAPCOLS" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let width = try_num!(a(1)) as usize;
            if width == 0 {
                return Arg::err(ErrorKind::Num);
            }
            let pad = args.get(2).map(|v| v.clone().scalar()).unwrap_or(Value::Error(ErrorKind::NA));
            let vals = arr.data.clone();
            let chunks: Vec<Vec<Value>> = vals.chunks(width).map(|c| {
                let mut row = c.to_vec();
                row.resize(width, pad.clone());
                row
            }).collect();
            if chunks.is_empty() {
                return Arg::err(ErrorKind::Value);
            }
            let out = Array::from_rows(chunks);
            if name == "WRAPROWS" {
                Arg::Array(out)
            } else {
                let rows: Vec<Vec<Value>> = (0..out.cols).map(|c| out.column(c)).collect();
                Arg::Array(Array::from_rows(rows))
            }
        }
        "EXPAND" => {
            let arr = args.first().map(|v| v.as_array()).unwrap_or_else(empty_arr);
            let rows = match args.get(1).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => arr.rows,
                Some(v) => try_num!(v) as u32,
            };
            let cols = match args.get(2).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => arr.cols,
                Some(v) => try_num!(v) as u32,
            };
            if rows < arr.rows || cols < arr.cols {
                return Arg::err(ErrorKind::Value);
            }
            let pad = args.get(3).map(|v| v.clone().scalar()).unwrap_or(Value::Error(ErrorKind::NA));
            let data: Vec<Value> = (0..rows).flat_map(|r| (0..cols).map(move |c| (r, c))).map(|(r, c)| if r < arr.rows && c < arr.cols { arr.get(r, c).clone() } else { pad.clone() }).collect();
            Arg::Array(Array { rows, cols, data })
        }
        "TYPE" => n(match a(0) {
            Value::Number(_) => 1.0,
            Value::Text(_) => 2.0,
            Value::Bool(_) => 4.0,
            Value::Error(_) => 16.0,
            Value::Empty => 1.0,
        }),
        "ERROR.TYPE" => match a(0) {
            Value::Error(e) => n(match e {
                ErrorKind::Div0 => 2.0,
                ErrorKind::Value => 3.0,
                ErrorKind::Ref => 4.0,
                ErrorKind::Name => 5.0,
                ErrorKind::Num => 6.0,
                ErrorKind::NA => 7.0,
                _ => 8.0,
            }),
            _ => Arg::err(ErrorKind::NA),
        },
        "ISERR" => b(matches!(a(0), Value::Error(e) if e != ErrorKind::NA)),
        "ISNONTEXT" => b(!matches!(a(0), Value::Text(_))),
        // ---------------- more dates ----------------
        "DAYS360" => {
            let start = match date_arg(&a(0)) {
                Ok(x) => x.floor(),
                Err(e) => return Arg::err(e),
            };
            let end = match date_arg(&a(1)) {
                Ok(x) => x.floor(),
                Err(e) => return Arg::err(e),
            };
            let european = args.len() > 2 && try_bool!(a(2));
            let (y1, m1, mut d1) = civil_from_days(start as i64 + serial_to_civil_offset());
            let (y2, m2, mut d2) = civil_from_days(end as i64 + serial_to_civil_offset());
            if european {
                if d1 == 31 {
                    d1 = 30;
                }
                if d2 == 31 {
                    d2 = 30;
                }
            } else {
                if d1 == 31 {
                    d1 = 30;
                }
                if d2 == 31 && d1 == 30 {
                    d2 = 30;
                }
            }
            n(((y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1)) as f64)
        }
        "WEEKNUM" | "ISOWEEKNUM" => {
            let s = match date_arg(&a(0)) {
                Ok(x) => x.floor(),
                Err(e) => return Arg::err(e),
            };
            let (y, _, _) = civil_from_days(s as i64 + serial_to_civil_offset());
            if name == "ISOWEEKNUM" {
                // ISO 8601: week with the year's first Thursday is week 1
                let wd = weekday_mon0(s); // 0 = Monday
                let thursday = s - wd as f64 + 3.0;
                let (ty, _, _) = civil_from_days(thursday as i64 + serial_to_civil_offset());
                let jan1 = serial_from_ymd(ty, 1, 1);
                n(((thursday - jan1) / 7.0).floor() + 1.0)
            } else {
                let kind = if args.len() > 1 { try_num!(a(1)) as i64 } else { 1 };
                let jan1 = serial_from_ymd(y, 1, 1);
                // week starts on Sunday (1) or Monday (2/11/21)
                let start_mon0 = if kind == 1 || kind == 17 { 6 } else { 0 };
                let offset = ((weekday_mon0(jan1) - start_mon0) % 7 + 7) % 7;
                n(((s - jan1 + offset as f64) / 7.0).floor() + 1.0)
            }
        }
        "TIMEVALUE" => {
            let s = try_text!(a(0));
            match parse_date_time_text(&s) {
                Some((v, _)) => n(v - v.floor()),
                None => Arg::err(ErrorKind::Value),
            }
        }
        "NETWORKDAYS.INTL" | "WORKDAY.INTL" => {
            let start = match date_arg(&a(0)) {
                Ok(x) => x.floor(),
                Err(e) => return Arg::err(e),
            };
            let weekend = match args.get(2).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => weekend_mask(1),
                Some(Value::Text(s)) if s.len() == 7 && s.chars().all(|c| c == '0' || c == '1') => s.chars().map(|c| c == '1').collect::<Vec<bool>>(),
                Some(v) => weekend_mask(try_num!(v) as i64),
            };
            let holidays: Vec<f64> = args.get(3).map(|h| h.values().iter().filter_map(|v| to_number(v).ok().map(|x| x.floor())).collect()).unwrap_or_default();
            let is_workday = |d: f64| !weekend[weekday_mon0(d) as usize] && !holidays.contains(&d);
            if name == "NETWORKDAYS.INTL" {
                let end = match date_arg(&a(1)) {
                    Ok(x) => x.floor(),
                    Err(e) => return Arg::err(e),
                };
                let (s, e, sign) = if start <= end { (start, end, 1.0) } else { (end, start, -1.0) };
                let mut count = 0;
                let mut d = s;
                while d <= e {
                    if is_workday(d) {
                        count += 1;
                    }
                    d += 1.0;
                }
                n(count as f64 * sign)
            } else {
                let days = try_num!(a(1)) as i64;
                if weekend.iter().all(|w| *w) {
                    return Arg::err(ErrorKind::Value);
                }
                let step = if days >= 0 { 1.0 } else { -1.0 };
                let mut left = days.abs();
                let mut d = start;
                while left > 0 {
                    d += step;
                    if is_workday(d) {
                        left -= 1;
                    }
                }
                n(d)
            }
        }
        // ---------------- more finance ----------------
        "SYD" => {
            let (cost, salvage, life, per) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)), try_num!(a(3)));
            if life <= 0.0 || per < 1.0 || per > life {
                return Arg::err(ErrorKind::Num);
            }
            n((cost - salvage) * (life - per + 1.0) * 2.0 / (life * (life + 1.0)))
        }
        "DB" => {
            let (cost, salvage, life, period) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)), try_num!(a(3)));
            let month = match args.get(4).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => 12.0,
                Some(v) => try_num!(v),
            };
            if cost <= 0.0 || life <= 0.0 || period < 1.0 || period > life + 1.0 {
                return Arg::err(ErrorKind::Num);
            }
            let rate = ((1.0 - (salvage / cost).powf(1.0 / life)) * 1000.0).round() / 1000.0;
            let mut total = 0.0;
            let mut dep = 0.0;
            for p in 1..=(period as i64) {
                dep = if p == 1 {
                    cost * rate * month / 12.0
                } else if p as f64 == life + 1.0 {
                    (cost - total) * rate * (12.0 - month) / 12.0
                } else {
                    (cost - total) * rate
                };
                total += dep;
            }
            n(dep)
        }
        "DDB" => {
            let (cost, salvage, life, period) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)), try_num!(a(3)));
            let factor = match args.get(4).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => 2.0,
                Some(v) => try_num!(v),
            };
            if cost < 0.0 || life <= 0.0 || period < 1.0 || period > life {
                return Arg::err(ErrorKind::Num);
            }
            let mut book_value = cost;
            let mut dep = 0.0;
            for _ in 1..=(period as i64) {
                dep = (book_value * factor / life).min(book_value - salvage).max(0.0);
                book_value -= dep;
            }
            n(dep)
        }
        "FVSCHEDULE" => {
            let principal = try_num!(a(0));
            let rates = args.get(1).map(|v| v.values()).unwrap_or_default();
            let mut v = principal;
            for r in rates {
                if r.is_empty() {
                    continue;
                }
                v *= 1.0 + try_num!(r);
            }
            n(v)
        }
        "CUMIPMT" | "CUMPRINC" => {
            let (rate, nper, pv, start, end) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)), try_num!(a(3)), try_num!(a(4)));
            let kind = match args.get(5).map(|v| v.clone().scalar()) {
                None | Some(Value::Empty) => 0.0,
                Some(v) => try_num!(v),
            };
            if rate <= 0.0 || nper <= 0.0 || pv <= 0.0 || start < 1.0 || end < start || end > nper {
                return Arg::err(ErrorKind::Num);
            }
            let mut total = 0.0;
            for per in (start as i64)..=(end as i64) {
                let part = annuity(if name == "CUMIPMT" { "IPMT" } else { "PPMT" }, &[n(rate), n(per as f64), n(nper), n(pv), n(0.0), n(kind)]);
                match part.scalar() {
                    Value::Number(x) => total += x,
                    Value::Error(e) => return Arg::err(e),
                    _ => {}
                }
            }
            n(total)
        }
        "ISPMT" => {
            let (rate, per, nper, pv) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)), try_num!(a(3)));
            if nper == 0.0 {
                return Arg::err(ErrorKind::Div0);
            }
            n(-pv * rate * (1.0 - (per - 1.0) / nper))
        }
        "MIRR" => {
            let flows = match args.first().map(cash_flows) {
                Some(Ok(v)) => v,
                Some(Err(e)) => return Arg::err(e),
                None => return Arg::err(ErrorKind::Value),
            };
            let finance = try_num!(a(1));
            let reinvest = try_num!(a(2));
            let nn = flows.len() as f64;
            if nn < 2.0 {
                return Arg::err(ErrorKind::Value);
            }
            let npv_neg: f64 = flows.iter().enumerate().filter(|(_, v)| **v < 0.0).map(|(i, v)| v / (1.0 + finance).powi(i as i32)).sum();
            let fv_pos: f64 = flows.iter().enumerate().filter(|(_, v)| **v > 0.0).map(|(i, v)| v * (1.0 + reinvest).powf(nn - 1.0 - i as f64)).sum();
            if npv_neg == 0.0 || fv_pos == 0.0 {
                return Arg::err(ErrorKind::Div0);
            }
            n((fv_pos / -npv_neg).powf(1.0 / (nn - 1.0)) - 1.0)
        }
        "RRI" => {
            let (nper, pv, fv) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)));
            if nper <= 0.0 || pv == 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            n((fv / pv).powf(1.0 / nper) - 1.0)
        }
        "PDURATION" => {
            let (rate, pv, fv) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)));
            if rate <= 0.0 || pv <= 0.0 || fv <= 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            n((fv.ln() - pv.ln()) / (1.0 + rate).ln())
        }
        // ---------------- review & finance primitives ----------------
        "CHECK" => {
            // CHECK(condition, [label]) — TRUE/FALSE; collected by the Review panel
            let c = try_bool!(a(0));
            b(c)
        }
        "FX" => {
            // FX(amount, from, to, [date]) against a table named "FX" (Date | From | To | Rate)
            let amount = try_num!(a(0));
            let from = try_text!(a(1)).trim().to_ascii_uppercase();
            let to = try_text!(a(2)).trim().to_ascii_uppercase();
            if from.is_empty() || to.is_empty() {
                return Arg::err(ErrorKind::Value);
            }
            if from == to {
                return n(amount);
            }
            let date = match args.get(3).map(|x| x.clone().scalar()) {
                None | Some(Value::Empty) => ctx.now,
                Some(v) => try_num!(v),
            };
            match fx_rate(ctx.wb, &from, &to, date) {
                Some(rate) => n(amount * rate),
                None => Arg::err(ErrorKind::NA),
            }
        }
        "FXRATE" => {
            let from = try_text!(a(0)).trim().to_ascii_uppercase();
            let to = try_text!(a(1)).trim().to_ascii_uppercase();
            if from == to {
                return n(1.0);
            }
            let date = match args.get(2).map(|x| x.clone().scalar()) {
                None | Some(Value::Empty) => ctx.now,
                Some(v) => try_num!(v),
            };
            match fx_rate(ctx.wb, &from, &to, date) {
                Some(rate) => n(rate),
                None => Arg::err(ErrorKind::NA),
            }
        }
        "RECONCILE" => {
            // RECONCILE(rangeA, rangeB, [tolerance]) → Key | A | B | Difference | Status
            let (ra, rb) = match (args.first(), args.get(1)) {
                (Some(x), Some(y)) => (x.as_array(), y.as_array()),
                _ => return Arg::err(ErrorKind::Value),
            };
            let tol = match args.get(2).map(|x| x.clone().scalar()) {
                None | Some(Value::Empty) => 0.005,
                Some(v) => try_num!(v).abs(),
            };
            let side = |arr: &Array| -> Vec<(String, f64)> {
                let mut out = vec![];
                for r in 0..arr.rows {
                    let row = arr.row(r);
                    let (key, amt) = if arr.cols >= 2 {
                        let amount = row.iter().skip(1).rev().find_map(|v| match v {
                            Value::Number(x) => Some(*x),
                            _ => None,
                        });
                        (row[0].to_display(), amount)
                    } else {
                        match &row[0] {
                            Value::Number(x) => (row[0].to_display(), Some(*x)),
                            Value::Empty => (String::new(), None),
                            v => (v.to_display(), Some(1.0)),
                        }
                    };
                    let key = key.trim().to_string();
                    if key.is_empty() && amt.is_none() {
                        continue;
                    }
                    if key.is_empty() {
                        continue;
                    }
                    out.push((key, amt.unwrap_or(0.0)));
                }
                out
            };
            let (la, lb) = (side(&ra), side(&rb));
            let mut keys: Vec<String> = vec![];
            let mut sum_a: std::collections::HashMap<String, (f64, u32)> = std::collections::HashMap::new();
            let mut sum_b: std::collections::HashMap<String, (f64, u32)> = std::collections::HashMap::new();
            for (k, v) in &la {
                let e = sum_a.entry(k.clone()).or_insert((0.0, 0));
                e.0 += v;
                e.1 += 1;
                if !keys.contains(k) {
                    keys.push(k.clone());
                }
            }
            for (k, v) in &lb {
                let e = sum_b.entry(k.clone()).or_insert((0.0, 0));
                e.0 += v;
                e.1 += 1;
                if !keys.contains(k) {
                    keys.push(k.clone());
                }
            }
            keys.sort_by(|x, y| compare(&Value::Text(x.clone()), &Value::Text(y.clone())));
            let mut rows: Vec<Vec<Value>> = vec![vec![
                Value::Text("Key".into()),
                Value::Text("A".into()),
                Value::Text("B".into()),
                Value::Text("Difference".into()),
                Value::Text("Status".into()),
            ]];
            for k in keys {
                let a_v = sum_a.get(&k).copied();
                let b_v = sum_b.get(&k).copied();
                let (va, vb) = (a_v.map(|x| x.0).unwrap_or(0.0), b_v.map(|x| x.0).unwrap_or(0.0));
                let diff = ((va - vb) * 1e9).round() / 1e9;
                let status = match (a_v, b_v) {
                    (Some(_), None) => "Only in A",
                    (None, Some(_)) => "Only in B",
                    _ => {
                        if diff.abs() <= tol {
                            "Matched"
                        } else {
                            "Difference"
                        }
                    }
                };
                let key_val = crate::model::parse_number_literal(&k).map(Value::Number).unwrap_or(Value::Text(k.clone()));
                rows.push(vec![
                    key_val,
                    if a_v.is_some() { Value::Number(va) } else { Value::Empty },
                    if b_v.is_some() { Value::Number(vb) } else { Value::Empty },
                    Value::Number(diff),
                    Value::Text(status.into()),
                ]);
            }
            Arg::Array(Array::from_rows(rows))
        }
        "AGE_BUCKET" => {
            // AGE_BUCKET(date, [as_of], [bucket_edges]) → "0-30" | "31-60" | ... | "90+" ("Not due" for future dates)
            let d = try_num!(a(0));
            let as_of = match args.get(1).map(|x| x.clone().scalar()) {
                None | Some(Value::Empty) => ctx.now.floor(),
                Some(v) => try_num!(v),
            };
            let edges = match ageing_edges(args.get(2)) {
                Ok(e) => e,
                Err(e) => return Arg::err(e),
            };
            let age = (as_of - d).floor() as i64;
            t(bucket_label(age, &edges))
        }
        "AGEING" | "AGING" => {
            // AGEING(dates, amounts, [as_of], [bucket_edges]) → Bucket | Count | Amount | Share
            let dates = match args.first() {
                Some(x) => x.as_array(),
                None => return Arg::err(ErrorKind::Value),
            };
            let amounts = match args.get(1) {
                Some(x) => x.as_array(),
                None => Array { rows: dates.rows, cols: dates.cols, data: vec![Value::Number(1.0); (dates.rows * dates.cols) as usize] },
            };
            let as_of = match args.get(2).map(|x| x.clone().scalar()) {
                None | Some(Value::Empty) => ctx.now.floor(),
                Some(v) => try_num!(v),
            };
            let edges = match ageing_edges(args.get(3)) {
                Ok(e) => e,
                Err(e) => return Arg::err(e),
            };
            let mut labels: Vec<String> = vec!["Not due".into()];
            let mut lo = 0i64;
            for e in &edges {
                labels.push(format!("{}-{}", lo, e));
                lo = e + 1;
            }
            labels.push(format!("{}+", edges.last().copied().unwrap_or(0) + 1));
            let mut count = vec![0u32; labels.len()];
            let mut total = vec![0f64; labels.len()];
            for i in 0..dates.data.len() {
                let d = match &dates.data[i] {
                    Value::Number(x) => *x,
                    Value::Text(s) => match parse_date_time_text(s) {
                        Some((x, _)) => x,
                        None => continue,
                    },
                    _ => continue,
                };
                let amt = match amounts.data.get(i) {
                    Some(Value::Number(x)) => *x,
                    Some(Value::Empty) | None => 0.0,
                    Some(Value::Error(e)) => return Arg::err(e.clone()),
                    Some(_) => 0.0,
                };
                let age = (as_of - d).floor() as i64;
                let idx = bucket_index(age, &edges);
                count[idx] += 1;
                total[idx] += amt;
            }
            let grand: f64 = total.iter().sum();
            let mut rows: Vec<Vec<Value>> = vec![vec![
                Value::Text("Bucket".into()),
                Value::Text("Count".into()),
                Value::Text("Amount".into()),
                Value::Text("Share".into()),
            ]];
            for (i, l) in labels.iter().enumerate() {
                if i == 0 && count[0] == 0 {
                    continue; // hide "Not due" when nothing is in the future
                }
                rows.push(vec![
                    Value::Text(l.clone()),
                    Value::Number(count[i] as f64),
                    Value::Number(total[i]),
                    if grand != 0.0 { Value::Number(total[i] / grand) } else { Value::Empty },
                ]);
            }
            rows.push(vec![
                Value::Text("Total".into()),
                Value::Number(count.iter().sum::<u32>() as f64),
                Value::Number(grand),
                if grand != 0.0 { Value::Number(1.0) } else { Value::Empty },
            ]);
            Arg::Array(Array::from_rows(rows))
        }
        _ => Arg::err(ErrorKind::Name),
    }
}

/// Newton–Raphson root finding with numeric derivative; falls back to bisection on [-0.99, 10].
fn newton(f: impl Fn(f64) -> f64, guess: f64) -> Option<f64> {
    let mut r = guess;
    for _ in 0..100 {
        let y = f(r);
        if y.abs() < 1e-9 {
            return Some(r);
        }
        let h = 1e-6;
        let dy = (f(r + h) - f(r - h)) / (2.0 * h);
        if dy == 0.0 || !dy.is_finite() {
            break;
        }
        let next = r - y / dy;
        if !next.is_finite() || next <= -1.0 {
            break;
        }
        if (next - r).abs() < 1e-12 {
            return Some(next);
        }
        r = next;
    }
    // bisection
    let (mut lo, mut hi) = (-0.99, 10.0);
    let (flo, fhi) = (f(lo), f(hi));
    if flo.is_nan() || fhi.is_nan() || flo.signum() == fhi.signum() {
        return None;
    }
    for _ in 0..200 {
        let mid = (lo + hi) / 2.0;
        let fm = f(mid);
        if fm.abs() < 1e-10 {
            return Some(mid);
        }
        if fm.signum() == flo.signum() {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some((lo + hi) / 2.0)
}

fn irr(flows: &[f64], guess: f64) -> Option<f64> {
    if flows.len() < 2 {
        return None;
    }
    let f = |r: f64| flows.iter().enumerate().map(|(i, cf)| cf / (1.0 + r).powi(i as i32)).sum::<f64>();
    newton(f, guess)
}

/// Excel's annuity family: PMT, IPMT, PPMT, PV, FV, NPER, RATE (type 0 = end of period, 1 = beginning).
fn annuity(name: &str, args: &[Arg]) -> Arg {
    let a = |i: usize| arg_at(args, i);
    let num = |i: usize, default: f64| -> Result<f64, ErrorKind> {
        match args.get(i) {
            None => Ok(default),
            Some(x) => {
                let v = x.clone().scalar();
                if v.is_empty() {
                    Ok(default)
                } else {
                    to_number(&v)
                }
            }
        }
    };
    macro_rules! g {
        ($e:expr) => {
            match $e {
                Ok(x) => x,
                Err(e) => return Arg::err(e),
            }
        };
    }
    // payment given rate, nper, pv, fv, type
    let pmt_of = |rate: f64, nper: f64, pv: f64, fv: f64, kind: f64| -> f64 {
        if rate == 0.0 {
            return -(pv + fv) / nper;
        }
        let k = (1.0 + rate).powf(nper);
        -(pv * k + fv) * rate / ((1.0 + rate * kind) * (k - 1.0))
    };
    match name {
        "PMT" => {
            let (rate, nper, pv) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)));
            if nper == 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            n(pmt_of(rate, nper, pv, g!(num(3, 0.0)), g!(num(4, 0.0))))
        }
        "IPMT" | "PPMT" => {
            let (rate, per, nper, pv) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)), try_num!(a(3)));
            let fv = g!(num(4, 0.0));
            let kind = g!(num(5, 0.0));
            if per < 1.0 || per > nper || nper == 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            let pmt = pmt_of(rate, nper, pv, fv, kind);
            // balance before period `per`
            let mut ipmt;
            if rate == 0.0 {
                ipmt = 0.0;
            } else {
                let k = (1.0 + rate).powf(per - 1.0);
                let balance = pv * k + pmt * (1.0 + rate * kind) * (k - 1.0) / rate;
                ipmt = -balance * rate;
                if kind == 1.0 {
                    ipmt = if per == 1.0 { 0.0 } else { ipmt / (1.0 + rate) };
                }
            }
            if name == "IPMT" {
                n(ipmt)
            } else {
                n(pmt - ipmt)
            }
        }
        "PV" => {
            let (rate, nper, pmt) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)));
            let fv = g!(num(3, 0.0));
            let kind = g!(num(4, 0.0));
            if rate == 0.0 {
                return n(-(fv + pmt * nper));
            }
            let k = (1.0 + rate).powf(nper);
            n(-(fv + pmt * (1.0 + rate * kind) * (k - 1.0) / rate) / k)
        }
        "FV" => {
            let (rate, nper, pmt) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)));
            let pv = g!(num(3, 0.0));
            let kind = g!(num(4, 0.0));
            if rate == 0.0 {
                return n(-(pv + pmt * nper));
            }
            let k = (1.0 + rate).powf(nper);
            n(-(pv * k + pmt * (1.0 + rate * kind) * (k - 1.0) / rate))
        }
        "NPER" => {
            let (rate, pmt, pv) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)));
            let fv = g!(num(3, 0.0));
            let kind = g!(num(4, 0.0));
            if rate == 0.0 {
                if pmt == 0.0 {
                    return Arg::err(ErrorKind::Num);
                }
                return n(-(pv + fv) / pmt);
            }
            let x = pmt * (1.0 + rate * kind) / rate;
            let num_ = (x - fv) / (x + pv);
            if num_ <= 0.0 {
                return Arg::err(ErrorKind::Num);
            }
            n(num_.ln() / (1.0 + rate).ln())
        }
        "RATE" => {
            let (nper, pmt, pv) = (try_num!(a(0)), try_num!(a(1)), try_num!(a(2)));
            let fv = g!(num(3, 0.0));
            let kind = g!(num(4, 0.0));
            let guess = g!(num(5, 0.1));
            let f = |r: f64| {
                if r == 0.0 {
                    return pv + pmt * nper + fv;
                }
                let k = (1.0 + r).powf(nper);
                pv * k + pmt * (1.0 + r * kind) * (k - 1.0) / r + fv
            };
            match newton(f, guess) {
                Some(r) => n(r),
                None => Arg::err(ErrorKind::Num),
            }
        }
        _ => Arg::err(ErrorKind::Name),
    }
}

// ---------------------------------------------------------------------------
// number / date formatting (shared by TEXT() and the host's display logic)
// ---------------------------------------------------------------------------

const MONTH_NAMES: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

fn format_date(serial: f64, pattern: &str) -> String {
    let (y, m, d) = ymd_from_serial(serial);
    let secs_total = ((serial - serial.floor()) * 86400.0).round() as i64;
    let (hh, mi, ss) = (secs_total / 3600, (secs_total / 60) % 60, secs_total % 60);
    let wd = weekday_mon0(serial) as usize;
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i].to_ascii_lowercase();
        if c == '"' {
            // literal
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                out.push(chars[i]);
                i += 1;
            }
            i += 1;
            continue;
        }
        if "ymdhs".contains(c) {
            let mut run = 1;
            while i + run < chars.len() && chars[i + run].to_ascii_lowercase() == c {
                run += 1;
            }
            match (c, run) {
                ('y', r) if r >= 4 => out.push_str(&format!("{:04}", y)),
                ('y', _) => out.push_str(&format!("{:02}", y.rem_euclid(100))),
                ('m', 1) => {
                    // minutes when following an hour token or preceding seconds, else month
                    let prev_h = out.ends_with(':');
                    if prev_h {
                        out.push_str(&mi.to_string());
                    } else {
                        out.push_str(&m.to_string());
                    }
                }
                ('m', 2) => {
                    if out.ends_with(':') {
                        out.push_str(&format!("{:02}", mi));
                    } else {
                        out.push_str(&format!("{:02}", m));
                    }
                }
                ('m', 3) => out.push_str(&MONTH_NAMES[(m - 1) as usize][..3]),
                ('m', _) => out.push_str(MONTH_NAMES[(m - 1) as usize]),
                ('d', 1) => out.push_str(&d.to_string()),
                ('d', 2) => out.push_str(&format!("{:02}", d)),
                ('d', 3) => out.push_str(&DAY_NAMES[wd][..3]),
                ('d', _) => out.push_str(DAY_NAMES[wd]),
                ('h', 1) => out.push_str(&hh.to_string()),
                ('h', _) => out.push_str(&format!("{:02}", hh)),
                ('s', 1) => out.push_str(&ss.to_string()),
                ('s', _) => out.push_str(&format!("{:02}", ss)),
                _ => {}
            }
            i += run;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn is_date_pattern(f: &str) -> bool {
    let lower = f.to_ascii_lowercase();
    let stripped: String = {
        // ignore quoted literals
        let mut s = String::new();
        let mut inq = false;
        for c in lower.chars() {
            if c == '"' {
                inq = !inq;
                continue;
            }
            if !inq {
                s.push(c);
            }
        }
        s
    };
    stripped.contains("yy") || stripped.contains("dd") || stripped.contains("mmm") || stripped.contains("hh") || stripped.contains("h:") || stripped.contains("d ")
}

/// Format a value with an Excel-like pattern: `0`, `0.00`, `#,##0`, `#,##0.00`, `0%`,
/// `€#,##0.00`, `#,##0.00 "Kz"`, `#.##0,00` (decimal comma), `yyyy-mm-dd`, `d mmm yyyy hh:mm`.
pub fn format_text(v: &Value, fmt: &str) -> String {
    let f = fmt.trim();
    if f.is_empty() {
        return v.to_display();
    }
    if is_date_pattern(f) {
        if let Ok(s) = date_arg(v) {
            return format_date(s, f);
        }
        return v.to_display();
    }
    let x = match to_number(v) {
        Ok(x) => x,
        Err(_) => return v.to_display(),
    };
    // split prefix / number pattern / suffix (literals in quotes or currency symbols)
    let is_num_char = |c: char| "0#.,%".contains(c);
    let mut prefix = String::new();
    let mut suffix = String::new();
    let mut core = String::new();
    let mut state = 0; // 0 prefix, 1 number pattern, 2 suffix
    let mut inq = false;
    for c in f.chars() {
        if c == '"' {
            inq = !inq;
            if state == 1 {
                state = 2;
            }
            continue;
        }
        let numeric = !inq && is_num_char(c);
        match state {
            0 if numeric => {
                state = 1;
                core.push(c);
            }
            0 => prefix.push(c),
            1 if numeric => core.push(c),
            1 => {
                state = 2;
                suffix.push(c);
            }
            _ => suffix.push(c),
        }
    }
    let pct = core.ends_with('%');
    let x = if pct { x * 100.0 } else { x };
    // decimal comma style: "#.##0,00" or "0,00" (the last separator is a comma followed by zeros)
    let decimal_comma = match (core.rfind('.'), core.rfind(',')) {
        (Some(d), Some(c)) => c > d,
        (None, Some(c)) => {
            let after = core[c + 1..].trim_end_matches('%');
            !after.is_empty() && after.chars().all(|ch| ch == '0')
        }
        _ => false,
    };
    let (dec_sep, grp_sep, decimals, grouped) = if decimal_comma {
        let decimals = core.rsplit(',').next().map(|d| d.chars().filter(|c| *c == '0').count()).unwrap_or(0);
        (',', '.', decimals, core.contains('.'))
    } else {
        let decimals = core.split('.').nth(1).map(|d| d.chars().filter(|c| *c == '0').count()).unwrap_or(0);
        ('.', ',', decimals, core.contains(','))
    };
    let body = format!("{:.*}", decimals, x.abs());
    let (int_part, frac) = match body.split_once('.') {
        Some((i, fr)) => (i.to_string(), Some(fr.to_string())),
        None => (body.clone(), None),
    };
    let mut g = String::new();
    if grouped {
        let digits: Vec<char> = int_part.chars().collect();
        for (i, ch) in digits.iter().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                g.push(grp_sep);
            }
            g.push(*ch);
        }
    } else {
        g = int_part;
    }
    let num = format!("{}{}", g, frac.map(|fr| format!("{}{}", dec_sep, fr)).unwrap_or_default());
    let neg = x < 0.0 && num.chars().any(|c| c.is_ascii_digit() && c != '0');
    let pct_s = if pct { "%" } else { "" };
    format!("{}{}{}{}{}", if neg { "-" } else { "" }, prefix, num, pct_s, suffix)
}


// ---------------------------------------------------------------------------
// FX and ageing helpers
// ---------------------------------------------------------------------------

/// The workbook's rate table: a table named "FX" (case-insensitive).
pub fn fx_table(wb: &Workbook) -> Option<&crate::model::Table> {
    wb.tables.iter().find(|t| t.name.eq_ignore_ascii_case("FX"))
}

/// Rate `from` → `to` on `date` (latest row on or before the date): direct, inverse, or
/// triangulated through one common currency. Columns are found by header text
/// (Date / From / To / Rate), falling back to the first four columns.
pub fn fx_rate(wb: &Workbook, from: &str, to: &str, date: f64) -> Option<f64> {
    let t = fx_table(wb)?;
    if t.rows <= t.header_rows {
        return None;
    }
    let col = |names: &[&str], fallback: u32| -> Option<u32> {
        for n in names {
            if let Some(c) = t.column_by_header(n) {
                return Some(c);
            }
        }
        if fallback < t.cols {
            Some(fallback)
        } else {
            None
        }
    };
    let has_date = ["date", "data", "as of", "asof"].iter().any(|n| t.column_by_header(n).is_some());
    let (c_date, c_from, c_to, c_rate) = if has_date || t.cols >= 4 {
        (
            col(&["date", "data", "as of", "asof"], 0),
            col(&["from", "de", "base", "ccy", "currency", "moeda"], 1)?,
            col(&["to", "para", "quote", "counter"], 2)?,
            col(&["rate", "taxa", "câmbio", "cambio", "fx"], 3)?,
        )
    } else {
        (None, col(&["from", "de", "base", "ccy", "currency", "moeda"], 0)?, col(&["to", "para", "quote", "counter"], 1)?, col(&["rate", "taxa", "câmbio", "cambio", "fx"], 2)?)
    };
    // (from, to) → (date, rate) picking the latest date ≤ `date`
    let mut quotes: Vec<(String, String, f64, f64)> = vec![];
    for r in t.header_rows..t.rows {
        let f = t.value_at(CellKey::new(r, c_from)).to_display().trim().to_ascii_uppercase();
        let q = t.value_at(CellKey::new(r, c_to)).to_display().trim().to_ascii_uppercase();
        let rate = match t.value_at(CellKey::new(r, c_rate)) {
            Value::Number(x) if x > 0.0 => x,
            Value::Text(s) => match crate::model::parse_number_literal(&s) {
                Some(x) if x > 0.0 => x,
                _ => continue,
            },
            _ => continue,
        };
        let d = match c_date {
            Some(c) => match t.value_at(CellKey::new(r, c)) {
                Value::Number(x) => x,
                Value::Text(s) => match parse_date_time_text(&s) {
                    Some((x, _)) => x,
                    None => 0.0,
                },
                _ => 0.0,
            },
            None => 0.0,
        };
        if f.is_empty() || q.is_empty() || d > date + 1e-9 {
            continue;
        }
        quotes.push((f, q, d, rate));
    }
    let best = |f: &str, q: &str| -> Option<f64> {
        let mut out: Option<(f64, f64)> = None;
        for (qf, qq, d, rate) in &quotes {
            if qf == f && qq == q {
                let better = match out {
                    None => true,
                    Some((bd, _)) => *d >= bd,
                };
                if better {
                    out = Some((*d, *rate));
                }
            }
        }
        out.map(|x| x.1)
    };
    if let Some(r) = best(from, to) {
        return Some(r);
    }
    if let Some(r) = best(to, from) {
        return Some(1.0 / r);
    }
    // one hop through a common currency
    let mut currencies: Vec<String> = quotes.iter().flat_map(|q| [q.0.clone(), q.1.clone()]).collect();
    currencies.sort();
    currencies.dedup();
    for mid in currencies {
        if mid == from || mid == to {
            continue;
        }
        let leg1 = best(from, &mid).or_else(|| best(&mid, from).map(|r| 1.0 / r));
        let leg2 = best(&mid, to).or_else(|| best(to, &mid).map(|r| 1.0 / r));
        if let (Some(a), Some(b)) = (leg1, leg2) {
            return Some(a * b);
        }
    }
    None
}

fn ageing_edges(arg: Option<&Arg>) -> Result<Vec<i64>, ErrorKind> {
    let mut edges: Vec<i64> = match arg {
        None => vec![30, 60, 90],
        Some(a) => {
            let mut v = vec![];
            for x in a.values() {
                match x {
                    Value::Empty => {}
                    Value::Error(e) => return Err(e),
                    other => v.push(to_number(&other)? as i64),
                }
            }
            if v.is_empty() {
                vec![30, 60, 90]
            } else {
                v
            }
        }
    };
    edges.sort();
    edges.dedup();
    if edges.iter().any(|e| *e < 0) {
        return Err(ErrorKind::Value);
    }
    Ok(edges)
}

/// 0 = not due (negative age), 1..=edges.len() = bucket, edges.len()+1 = beyond the last edge.
fn bucket_index(age: i64, edges: &[i64]) -> usize {
    if age < 0 {
        return 0;
    }
    for (i, e) in edges.iter().enumerate() {
        if age <= *e {
            return i + 1;
        }
    }
    edges.len() + 1
}

fn bucket_label(age: i64, edges: &[i64]) -> String {
    let idx = bucket_index(age, edges);
    if idx == 0 {
        return "Not due".into();
    }
    if idx == edges.len() + 1 {
        return format!("{}+", edges.last().copied().unwrap_or(0) + 1);
    }
    let lo = if idx == 1 { 0 } else { edges[idx - 2] + 1 };
    format!("{}-{}", lo, edges[idx - 1])
}


// ---------------------------------------------------------------------------
// helpers for the extended library
// ---------------------------------------------------------------------------

/// Offset between serial dates (days since 1899-12-30) and `civil_from_days` (days since 1970-01-01).
fn serial_to_civil_offset() -> i64 {
    -25569
}

/// Weekend mask for NETWORKDAYS.INTL / WORKDAY.INTL codes (index 0 = Monday).
fn weekend_mask(code: i64) -> Vec<bool> {
    let mut m = vec![false; 7];
    match code {
        1 => {
            m[5] = true;
            m[6] = true;
        }
        2 => {
            m[6] = true;
            m[0] = true;
        }
        3 => {
            m[0] = true;
            m[1] = true;
        }
        4 => {
            m[1] = true;
            m[2] = true;
        }
        5 => {
            m[2] = true;
            m[3] = true;
        }
        6 => {
            m[3] = true;
            m[4] = true;
        }
        7 => {
            m[4] = true;
            m[5] = true;
        }
        11 => m[6] = true,
        12 => m[0] = true,
        13 => m[1] = true,
        14 => m[2] = true,
        15 => m[3] = true,
        16 => m[4] = true,
        17 => m[5] = true,
        _ => {
            m[5] = true;
            m[6] = true;
        }
    }
    m
}

/// Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7).
fn normal_cdf(z: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.2316419 * z.abs());
    let d = 0.3989422804014327 * (-z * z / 2.0).exp();
    let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    if z >= 0.0 {
        1.0 - p
    } else {
        p
    }
}

/// Inverse standard normal CDF (Acklam's rational approximation refined by one Newton step).
fn normal_inv(p: f64) -> f64 {
    let a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    let b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    let c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    let d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    let plow = 0.02425;
    let x = if p < plow {
        let q = (-2.0 * p.ln()).sqrt();
        (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    } else if p <= 1.0 - plow {
        let q = p - 0.5;
        let r = q * q;
        (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    };
    // one Newton refinement
    let e = normal_cdf(x) - p;
    let u = e * (2.0 * std::f64::consts::PI).sqrt() * (x * x / 2.0).exp();
    x - u / (1.0 + x * u / 2.0)
}

/// Deterministic-per-call pseudo random number in [0, 1) (xorshift seeded from the clock).
fn pseudo_random() -> f64 {
    use std::cell::Cell;
    thread_local! {
        static STATE: Cell<u64> = Cell::new(0x9E3779B97F4A7C15);
    }
    STATE.with(|s| {
        let mut x = s.get() ^ (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1) | 1);
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        (x >> 11) as f64 / (1u64 << 53) as f64
    })
}
