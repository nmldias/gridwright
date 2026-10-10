//! Data model: workbook → tables → cells. Tables are free-floating objects on a
//! canvas (Numbers-style): each has a pixel position, a row/column count and
//! per-row/column sizes. Cells are stored sparsely.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub type TableId = u32;

pub const DEFAULT_COL_WIDTH: f64 = 100.0;
pub const DEFAULT_ROW_HEIGHT: f64 = 24.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
pub struct CellKey {
    pub row: u32,
    pub col: u32,
}

impl CellKey {
    pub fn new(row: u32, col: u32) -> Self {
        CellKey { row, col }
    }
}

/// A fully qualified cell address (table + row + column).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
pub struct CellRef {
    pub table: TableId,
    pub row: u32,
    pub col: u32,
}

impl CellRef {
    pub fn new(table: TableId, row: u32, col: u32) -> Self {
        CellRef { table, row, col }
    }
    pub fn key(&self) -> CellKey {
        CellKey::new(self.row, self.col)
    }
}

/// Rectangle of cells inside one table (inclusive bounds).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Rect {
    pub table: TableId,
    pub r0: u32,
    pub c0: u32,
    pub r1: u32,
    pub c1: u32,
}

impl Rect {
    pub fn contains(&self, key: CellKey) -> bool {
        key.row >= self.r0 && key.row <= self.r1 && key.col >= self.c0 && key.col <= self.c1
    }
    pub fn intersects(&self, other: &Rect) -> bool {
        self.table == other.table
            && self.r0 <= other.r1
            && other.r0 <= self.r1
            && self.c0 <= other.c1
            && other.c0 <= self.c1
    }
    pub fn rows(&self) -> u32 {
        self.r1 - self.r0 + 1
    }
    pub fn cols(&self) -> u32 {
        self.c1 - self.c0 + 1
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorKind {
    #[serde(rename = "#DIV/0!")]
    Div0,
    #[serde(rename = "#REF!")]
    Ref,
    #[serde(rename = "#NAME?")]
    Name,
    #[serde(rename = "#VALUE!")]
    Value,
    #[serde(rename = "#N/A")]
    NA,
    #[serde(rename = "#CYCLE!")]
    Cycle,
    #[serde(rename = "#NUM!")]
    Num,
    #[serde(rename = "#SPILL!")]
    Spill,
    #[serde(rename = "#ERROR!")]
    Other,
}

impl ErrorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorKind::Div0 => "#DIV/0!",
            ErrorKind::Ref => "#REF!",
            ErrorKind::Name => "#NAME?",
            ErrorKind::Value => "#VALUE!",
            ErrorKind::NA => "#N/A",
            ErrorKind::Cycle => "#CYCLE!",
            ErrorKind::Num => "#NUM!",
            ErrorKind::Spill => "#SPILL!",
            ErrorKind::Other => "#ERROR!",
        }
    }
}

/// A computed cell value. Serialised compactly as a tagged object:
/// `null`, `{"n":1.5}`, `{"s":"text"}`, `{"b":true}`, `{"e":"#DIV/0!"}`.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum Value {
    #[default]
    Empty,
    Number(f64),
    Text(String),
    Bool(bool),
    Error(ErrorKind),
}

impl Value {
    pub fn is_empty(&self) -> bool {
        matches!(self, Value::Empty)
    }
    pub fn error(kind: ErrorKind) -> Value {
        Value::Error(kind)
    }
    /// Parse what a user typed into a literal value (no formula handling).
    pub fn parse_literal(input: &str) -> Value {
        let t = input.trim();
        if t.is_empty() {
            return Value::Empty;
        }
        // a leading apostrophe keeps the rest as text, as in Excel: identifiers such as "000123" or
        // a 20-digit reference survive import with their leading zeros and every digit
        if let Some(text) = t.strip_prefix('\'') {
            return Value::Text(text.to_string());
        }
        match t.to_ascii_lowercase().as_str() {
            "true" => return Value::Bool(true),
            "false" => return Value::Bool(false),
            _ => {}
        }
        if let Some(n) = parse_number_literal(t) {
            return Value::Number(n);
        }
        if let Some((serial, _)) = crate::formula::eval::parse_date_time_text(t) {
            return Value::Number(serial);
        }
        Value::Text(input.to_string())
    }

    /// Number format implied by what was typed (dates, times, percentages, currency), if any.
    pub fn auto_format(input: &str) -> Option<String> {
        let t = input.trim();
        if t.is_empty() || parse_number_literal(t).is_some() {
            if t.ends_with('%') && parse_number_literal(t).is_some() {
                return Some(if t.contains('.') || t.contains(',') { "0.0%".into() } else { "0%".into() });
            }
            for (sym, fmt) in [("€", "€#,##0.00"), ("$", "$#,##0.00"), ("£", "£#,##0.00"), ("Kz", "#,##0.00 \"Kz\""), ("AOA", "#,##0.00 \"Kz\"")] {
                if (t.starts_with(sym) || t.ends_with(sym)) && parse_number_literal(t).is_some() {
                    return Some(fmt.into());
                }
            }
            return None;
        }
        crate::formula::eval::parse_date_time_text(t).map(|(_, f)| f.to_string())
    }
    pub fn to_display(&self) -> String {
        match self {
            Value::Empty => String::new(),
            Value::Number(n) => format_number(*n),
            Value::Text(s) => s.clone(),
            Value::Bool(b) => {
                if *b {
                    "TRUE".into()
                } else {
                    "FALSE".into()
                }
            }
            Value::Error(e) => e.as_str().to_string(),
        }
    }
}

/// Numbers typed by users: plain, thousands separators, percentages, currency symbols.
pub fn parse_number_literal(t: &str) -> Option<f64> {
    let mut s = t.replace(['\u{a0}', ' '], "");
    let mut pct = false;
    if let Some(stripped) = s.strip_suffix('%') {
        s = stripped.to_string();
        pct = true;
    }
    for sym in ["$", "€", "£", "Kz", "AOA", "USD", "EUR"] {
        if let Some(stripped) = s.strip_prefix(sym) {
            s = stripped.to_string();
        } else if let Some(stripped) = s.strip_suffix(sym) {
            s = stripped.to_string();
        }
    }
    if s.is_empty() {
        return None;
    }
    // Separators: "1,234.5" (en) vs "1.234,5" (pt/eu). Decide by whichever
    // separator appears last; a lone comma followed by exactly three digits is
    // read as a thousands separator ("1,500"), otherwise as a decimal comma ("1,5").
    let has_dot = s.contains('.');
    let has_comma = s.contains(',');
    let candidate = if has_dot && has_comma {
        if s.rfind(',') > s.rfind('.') {
            s.replace('.', "").replace(',', ".")
        } else {
            s.replace(',', "")
        }
    } else if has_comma {
        if s.matches(',').count() == 1 {
            let after = &s[s.find(',').unwrap() + 1..];
            if after.len() == 3 && after.chars().all(|c| c.is_ascii_digit()) {
                s.replace(',', "")
            } else {
                s.replace(',', ".")
            }
        } else {
            s.replace(',', "")
        }
    } else {
        s.clone()
    };
    let n: f64 = candidate.parse().ok()?;
    if !n.is_finite() {
        return None;
    }
    Some(if pct { n / 100.0 } else { n })
}

pub fn format_number(n: f64) -> String {
    if n.is_nan() {
        return "#NUM!".into();
    }
    if n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        // up to 10 significant decimals, trimmed
        let s = format!("{:.10}", n);
        let s = s.trim_end_matches('0').trim_end_matches('.');
        s.to_string()
    }
}

impl Serialize for Value {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Value::Empty => ser.serialize_none(),
            Value::Number(n) => {
                let mut m = ser.serialize_map(Some(1))?;
                m.serialize_entry("n", n)?;
                m.end()
            }
            Value::Text(s) => {
                let mut m = ser.serialize_map(Some(1))?;
                m.serialize_entry("s", s)?;
                m.end()
            }
            Value::Bool(b) => {
                let mut m = ser.serialize_map(Some(1))?;
                m.serialize_entry("b", b)?;
                m.end()
            }
            Value::Error(e) => {
                let mut m = ser.serialize_map(Some(1))?;
                m.serialize_entry("e", e.as_str())?;
                m.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let v: Option<serde_json::Value> = Option::deserialize(de)?;
        Ok(match v {
            None | Some(serde_json::Value::Null) => Value::Empty,
            Some(serde_json::Value::Number(n)) => Value::Number(n.as_f64().unwrap_or(0.0)),
            Some(serde_json::Value::String(s)) => Value::Text(s),
            Some(serde_json::Value::Bool(b)) => Value::Bool(b),
            Some(serde_json::Value::Object(m)) => {
                if let Some(n) = m.get("n").and_then(|x| x.as_f64()) {
                    Value::Number(n)
                } else if let Some(s) = m.get("s").and_then(|x| x.as_str()) {
                    Value::Text(s.to_string())
                } else if let Some(b) = m.get("b").and_then(|x| x.as_bool()) {
                    Value::Bool(b)
                } else if let Some(e) = m.get("e").and_then(|x| x.as_str()) {
                    Value::Error(error_from_str(e))
                } else {
                    Value::Empty
                }
            }
            Some(_) => Value::Empty,
        })
    }
}

pub fn error_from_str(s: &str) -> ErrorKind {
    match s {
        "#DIV/0!" => ErrorKind::Div0,
        "#REF!" => ErrorKind::Ref,
        "#NAME?" => ErrorKind::Name,
        "#VALUE!" => ErrorKind::Value,
        "#N/A" => ErrorKind::NA,
        "#CYCLE!" => ErrorKind::Cycle,
        "#NUM!" => ErrorKind::Num,
        "#SPILL!" => ErrorKind::Spill,
        _ => ErrorKind::Other,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CellKind {
    #[default]
    Value,
    Formula,
    Python,
    Javascript,
    /// SQL query run by the server against a stored connection; the result spills like code output.
    Sql,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Format {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    /// "left" | "center" | "right"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    /// e.g. "0", "0.00", "#,##0", "#,##0.00", "0%", "0.0%", "yyyy-mm-dd", "currency:EUR"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// wrap long text onto several lines inside the cell
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap: Option<bool>,
}

impl Format {
    pub fn is_default(&self) -> bool {
        *self == Format::default()
    }
    pub fn merge(&mut self, patch: &Format) {
        if patch.bold.is_some() {
            self.bold = patch.bold;
        }
        if patch.italic.is_some() {
            self.italic = patch.italic;
        }
        if patch.align.is_some() {
            self.align = patch.align.clone();
        }
        if patch.number_format.is_some() {
            self.number_format = patch.number_format.clone();
        }
        if patch.fill.is_some() {
            self.fill = patch.fill.clone();
        }
        if patch.color.is_some() {
            self.color = patch.color.clone();
        }
        if patch.wrap.is_some() {
            self.wrap = patch.wrap;
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Cell {
    /// Raw input: literal text, `=formula`, or code for Python/JavaScript cells.
    pub input: String,
    pub kind: CellKind,
    /// Computed/display value.
    pub value: Value,
    /// Set when this cell holds part of another cell's spilled output.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spill_from: Option<CellKey>,
    /// Size of the spilled output when this is a code cell with array output.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spill_size: Option<(u32, u32)>,
    #[serde(skip_serializing_if = "Format::is_default")]
    pub format: Format,
    /// Code cells: captured stdout / error text from the last run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub std_out: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub std_err: Option<String>,
    /// Code cells: ranges read through `q.cells(...)` during the last run.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub code_deps: Vec<Rect>,
    /// SQL cells: id of the stored connection the query runs on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conn: Option<String>,
    /// Code/SQL cells: re-run every N seconds while the document is open (0/None = never).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh: Option<u32>,
    /// Python cells: where the code runs — None/"browser" (Pyodide) or "server" (the host's CPython).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// Python cells on the server: ask for GPU acceleration (cudf.pandas) when the host has it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<bool>,
    /// Formula cells: cached dependency rectangles (rebuilt by the engine, never stored).
    #[serde(skip)]
    pub deps: Vec<Rect>,
    #[serde(skip)]
    pub deps_valid: bool,
    /// Set when the input breaks a (non-strict) validation rule covering the cell.
    #[serde(skip)]
    pub invalid: bool,
}

impl Cell {
    pub fn is_code(&self) -> bool {
        matches!(self.kind, CellKind::Python | CellKind::Javascript | CellKind::Sql)
    }
    pub fn is_blank(&self) -> bool {
        self.input.is_empty()
            && self.value.is_empty()
            && self.spill_from.is_none()
            && self.format.is_default()
    }
}

/// One aggregated value of a pivot table.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PivotValue {
    /// Source column header text.
    pub field: String,
    /// sum | count | average | min | max | countdistinct
    pub agg: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PivotFilter {
    pub field: String,
    /// Keep source rows whose field value (display text) is one of these.
    pub values: Vec<String>,
}

/// Pivot definition stored on the *output* table.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PivotSpec {
    pub source: TableId,
    /// Row grouping fields (header names of the source table), outermost first.
    pub rows: Vec<String>,
    /// Optional column grouping field (only the first entry is used).
    pub cols: Vec<String>,
    pub values: Vec<PivotValue>,
    pub filters: Vec<PivotFilter>,
    pub totals: bool,
}

/// Header filter on one column: either an explicit allow-list of display values or a condition.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ColumnFilter {
    pub col: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    /// eq | ne | gt | ge | lt | le | contains | not_contains | starts | ends | blank | not_blank
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// Conditional formatting rule over a rectangle.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CondFormat {
    pub r0: u32,
    pub c0: u32,
    pub r1: u32,
    pub c1: u32,
    /// cell_is | text | color_scale | top | bottom | duplicate | blank | not_blank | formula
    pub kind: String,
    /// cell_is: gt ge lt le eq ne between not_between · text: contains not_contains starts ends
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    pub values: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    /// colour scale end points
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_color: Option<String>,
}

/// Data-validation rule over a rectangle.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Validation {
    pub r0: u32,
    pub c0: u32,
    pub r1: u32,
    pub c1: u32,
    /// list | number | integer | date | text_length | custom
    pub kind: String,
    /// between | not_between | gt | ge | lt | le | eq | ne
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    /// list entries (or a single range reference such as `Lists::A2:A20`), or numeric bounds
    pub values: Vec<String>,
    pub allow_blank: bool,
    /// reject the entry (true) or only mark it (false)
    pub strict: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A signed-off (attested) rectangle: who, when, and a fingerprint of the values at that moment.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Signoff {
    pub id: u32,
    pub r0: u32,
    pub c0: u32,
    pub r1: u32,
    pub c1: u32,
    pub by: String,
    pub login: String,
    /// ISO timestamp supplied by the host
    pub at: String,
    pub note: String,
    /// fingerprint of the displayed values when signed (see `Table::range_hash`)
    pub hash: String,
    /// when true, cells inside cannot be edited until the sign-off is removed
    pub locked: bool,
}

/// Merged cell block (the top-left cell holds the value).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Merge {
    pub r0: u32,
    pub c0: u32,
    pub r1: u32,
    pub c1: u32,
}

impl Merge {
    pub fn contains(&self, r: u32, c: u32) -> bool {
        r >= self.r0 && r <= self.r1 && c >= self.c0 && c <= self.c1
    }
    pub fn intersects(&self, r0: u32, c0: u32, r1: u32, c1: u32) -> bool {
        self.r0 <= r1 && r0 <= self.r1 && self.c0 <= c1 && c0 <= self.c1
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ChartSeries {
    pub name: String,
    /// range reference text, e.g. `Sales::C2:C13` or `Sales[Revenue]`
    pub range: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ChartReference {
    pub value: f64,
    pub label: String,
}

/// A chart object on the canvas. Data is read from the referenced ranges by the host.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Chart {
    pub id: u32,
    /// bar | hbar | line | area | stacked | waterfall
    pub kind: String,
    /// action title (the takeaway)
    pub title: String,
    /// dataset and units, shown small and grey
    pub subtitle: String,
    /// "EXHIBIT 1 — TOPIC" tag above the title
    pub exhibit: String,
    /// source / definitions footnote
    pub source: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// range reference text for the category labels
    pub categories: String,
    pub series: Vec<ChartSeries>,
    /// category index drawn in the highlight colour
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlight: Option<u32>,
    /// dashed benchmark line with an inline label
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<ChartReference>,
    pub show_values: bool,
    pub stat_cards: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct NamedRange {
    pub name: String,
    /// Reference text such as `Sales::B2:B20` or `Orders[Amount]`.
    pub reference: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Table {
    pub id: TableId,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub rows: u32,
    pub cols: u32,
    pub header_rows: u32,
    pub col_widths: Vec<f64>,
    pub row_heights: Vec<f64>,
    #[serde(with = "cells_serde")]
    pub cells: HashMap<CellKey, Cell>,
    /// Set when this table is the output of a pivot over another table (cells are read-only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pivot: Option<PivotSpec>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<ColumnFilter>,
    /// Rows hidden by the filters (derived; kept for the host, rebuilt on load).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hidden_rows: Vec<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cond_formats: Vec<CondFormat>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub validations: Vec<Validation>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub signoffs: Vec<Signoff>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub merges: Vec<Merge>,
}

/// Cells are stored as a JSON array of `{"r":..,"c":..,"cell":{..}}` entries
/// (JSON object keys must be strings).
mod cells_serde {
    use super::{Cell, CellKey};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::HashMap;

    #[derive(Serialize, Deserialize)]
    struct Entry {
        r: u32,
        c: u32,
        cell: Cell,
    }

    pub fn serialize<S: Serializer>(cells: &HashMap<CellKey, Cell>, ser: S) -> Result<S::Ok, S::Error> {
        let mut entries: Vec<Entry> = cells
            .iter()
            .filter(|(_, c)| !c.is_blank())
            .map(|(k, c)| Entry {
                r: k.row,
                c: k.col,
                cell: c.clone(),
            })
            .collect();
        entries.sort_by_key(|e| (e.r, e.c));
        entries.serialize(ser)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<HashMap<CellKey, Cell>, D::Error> {
        let entries: Vec<Entry> = Vec::deserialize(de)?;
        Ok(entries
            .into_iter()
            .map(|e| (CellKey::new(e.r, e.c), e.cell))
            .collect())
    }
}

impl Default for Table {
    fn default() -> Self {
        Table {
            id: 0,
            name: "Table 1".into(),
            x: 0.0,
            y: 0.0,
            rows: 0,
            cols: 0,
            header_rows: 1,
            col_widths: vec![],
            row_heights: vec![],
            cells: HashMap::new(),
            pivot: None,
            filters: vec![],
            hidden_rows: vec![],
            cond_formats: vec![],
            validations: vec![],
            signoffs: vec![],
            merges: vec![],
        }
    }
}

impl Table {
    pub fn new(id: TableId, name: &str, x: f64, y: f64, rows: u32, cols: u32) -> Table {
        Table {
            id,
            name: name.to_string(),
            x,
            y,
            rows,
            cols,
            header_rows: 1,
            col_widths: vec![DEFAULT_COL_WIDTH; cols as usize],
            row_heights: vec![DEFAULT_ROW_HEIGHT; rows as usize],
            cells: HashMap::new(),
            pivot: None,
            filters: vec![],
            hidden_rows: vec![],
            cond_formats: vec![],
            validations: vec![],
            signoffs: vec![],
            merges: vec![],
        }
    }

    /// FNV-1a fingerprint of the displayed values of a rectangle (empty cells skipped).
    pub fn range_hash(&self, r0: u32, c0: u32, r1: u32, c1: u32) -> String {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut mix = |bytes: &[u8]| {
            for b in bytes {
                h ^= *b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
        };
        for r in r0..=r1.min(self.rows.saturating_sub(1)) {
            for c in c0..=c1.min(self.cols.saturating_sub(1)) {
                let v = self.value_at(CellKey::new(r, c));
                if v.is_empty() {
                    continue;
                }
                mix(&(r - r0).to_le_bytes());
                mix(&(c - c0).to_le_bytes());
                mix(v.to_display().as_bytes());
                mix(b"|");
            }
        }
        format!("{:016x}", h)
    }

    /// The locked sign-off covering a cell, if any.
    pub fn locked_signoff(&self, r: u32, c: u32) -> Option<&Signoff> {
        self.signoffs.iter().find(|s| s.locked && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1)
    }

    /// Merge block containing a cell, if any.
    pub fn merge_at(&self, r: u32, c: u32) -> Option<&Merge> {
        self.merges.iter().find(|m| m.contains(r, c))
    }

    /// Header text of a column (row 0 when the table has a header row), as displayed.
    pub fn header_text(&self, col: u32) -> String {
        if self.header_rows == 0 {
            return String::new();
        }
        self.value_at(CellKey::new(0, col)).to_display()
    }

    /// Column index whose header matches `name` (case-insensitive, trimmed).
    pub fn column_by_header(&self, name: &str) -> Option<u32> {
        if self.header_rows == 0 {
            return None;
        }
        let needle = name.trim().to_lowercase();
        if needle.is_empty() {
            return None;
        }
        (0..self.cols).find(|c| self.header_text(*c).trim().to_lowercase() == needle)
    }

    pub fn is_row_hidden(&self, row: u32) -> bool {
        self.hidden_rows.binary_search(&row).is_ok()
    }

    /// Recompute `hidden_rows` from the column filters (header rows are never hidden).
    pub fn apply_filters(&mut self) {
        let mut hidden = vec![];
        if !self.filters.is_empty() {
            for r in self.header_rows..self.rows {
                let keep = self.filters.iter().all(|f| filter_keeps(self, f, r));
                if !keep {
                    hidden.push(r);
                }
            }
        }
        self.hidden_rows = hidden;
    }

    pub fn in_bounds(&self, key: CellKey) -> bool {
        key.row < self.rows && key.col < self.cols
    }

    pub fn get(&self, key: CellKey) -> Option<&Cell> {
        self.cells.get(&key)
    }

    pub fn value_at(&self, key: CellKey) -> Value {
        self.cells.get(&key).map(|c| c.value.clone()).unwrap_or(Value::Empty)
    }

    pub fn width(&self) -> f64 {
        self.col_widths.iter().sum()
    }
    pub fn height(&self) -> f64 {
        self.row_heights.iter().sum()
    }

    /// Keep size vectors consistent with rows/cols.
    pub fn normalise_geometry(&mut self) {
        self.col_widths.resize(self.cols as usize, DEFAULT_COL_WIDTH);
        self.row_heights.resize(self.rows as usize, DEFAULT_ROW_HEIGHT);
        if self.header_rows > self.rows {
            self.header_rows = self.rows;
        }
    }

    /// Smallest row/col count that contains every non-blank cell (at least 1×1).
    pub fn used_extent(&self) -> (u32, u32) {
        let mut rows = 0;
        let mut cols = 0;
        for (k, c) in &self.cells {
            if !c.is_blank() {
                rows = rows.max(k.row + 1);
                cols = cols.max(k.col + 1);
            }
        }
        (rows.max(1), cols.max(1))
    }
}

/// Does a row pass one column filter?
pub fn filter_keeps(t: &Table, f: &ColumnFilter, row: u32) -> bool {
    let v = t.value_at(CellKey::new(row, f.col));
    if let Some(allowed) = &f.values {
        let text = v.to_display();
        return allowed.iter().any(|a| a == &text);
    }
    let op = f.op.as_deref().unwrap_or("");
    let target = f.value.clone().unwrap_or_default();
    match op {
        "blank" => v.is_empty(),
        "not_blank" => !v.is_empty(),
        "contains" | "not_contains" | "starts" | "ends" => {
            let hay = v.to_display().to_lowercase();
            let needle = target.to_lowercase();
            let hit = match op {
                "contains" => hay.contains(&needle),
                "not_contains" => !hay.contains(&needle),
                "starts" => hay.starts_with(&needle),
                _ => hay.ends_with(&needle),
            };
            hit
        }
        "eq" | "ne" | "gt" | "ge" | "lt" | "le" => {
            let tv = Value::parse_literal(&target);
            let ord = crate::formula::eval::compare_values(&v, &tv);
            use std::cmp::Ordering::*;
            let same_kind = std::mem::discriminant(&v) == std::mem::discriminant(&tv) || (matches!(v, Value::Empty) && matches!(tv, Value::Number(_)));
            match op {
                "eq" => ord == Equal && same_kind,
                "ne" => !(ord == Equal && same_kind),
                "gt" => same_kind && ord == Greater,
                "ge" => same_kind && ord != Less,
                "lt" => same_kind && ord == Less,
                _ => same_kind && ord != Greater,
            }
        }
        _ => true,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Workbook {
    pub version: u32,
    pub name: String,
    pub tables: Vec<Table>,
    pub next_table_id: TableId,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<NamedRange>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub charts: Vec<Chart>,
    pub next_chart_id: u32,
    /// Serial date-time (days since 1899-12-30) injected by the host for NOW()/TODAY().
    #[serde(skip)]
    pub now_serial: f64,
}

impl Workbook {
    pub fn new(name: &str) -> Workbook {
        Workbook {
            version: 1,
            name: name.to_string(),
            tables: vec![],
            next_table_id: 1,
            names: vec![],
            charts: vec![],
            next_chart_id: 1,
            now_serial: 45000.0,
        }
    }

    pub fn alloc_chart_id(&mut self) -> u32 {
        if self.next_chart_id == 0 {
            self.next_chart_id = 1;
        }
        let id = self.next_chart_id;
        self.next_chart_id += 1;
        id
    }

    pub fn named_range(&self, name: &str) -> Option<&NamedRange> {
        let needle = name.trim().to_lowercase();
        self.names.iter().find(|n| n.name.trim().to_lowercase() == needle)
    }

    pub fn table(&self, id: TableId) -> Option<&Table> {
        self.tables.iter().find(|t| t.id == id)
    }

    pub fn table_mut(&mut self, id: TableId) -> Option<&mut Table> {
        self.tables.iter_mut().find(|t| t.id == id)
    }

    pub fn table_by_name(&self, name: &str) -> Option<&Table> {
        let needle = name.trim().to_lowercase();
        self.tables.iter().find(|t| t.name.trim().to_lowercase() == needle)
    }

    pub fn alloc_table_id(&mut self) -> TableId {
        let id = self.next_table_id;
        self.next_table_id += 1;
        id
    }

    pub fn unique_table_name(&self, base: &str) -> String {
        if self.table_by_name(base).is_none() {
            return base.to_string();
        }
        let mut n = 2;
        loop {
            let candidate = format!("{} {}", base, n);
            if self.table_by_name(&candidate).is_none() {
                return candidate;
            }
            n += 1;
        }
    }

    pub fn cell(&self, r: CellRef) -> Option<&Cell> {
        self.table(r.table).and_then(|t| t.get(r.key()))
    }

    pub fn value(&self, r: CellRef) -> Value {
        self.table(r.table).map(|t| t.value_at(r.key())).unwrap_or(Value::Error(ErrorKind::Ref))
    }
}

/// Column index → letters (0 → "A", 25 → "Z", 26 → "AA").
pub fn col_to_letters(mut col: u32) -> String {
    let mut s = Vec::new();
    loop {
        s.push((b'A' + (col % 26) as u8) as char);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    s.iter().rev().collect()
}

/// Letters → column index ("A" → 0). Returns None for invalid input.
pub fn letters_to_col(s: &str) -> Option<u32> {
    if s.is_empty() || s.len() > 4 {
        return None;
    }
    let mut n: u32 = 0;
    for ch in s.chars() {
        let c = ch.to_ascii_uppercase();
        if !c.is_ascii_uppercase() {
            return None;
        }
        n = n * 26 + (c as u32 - 'A' as u32 + 1);
    }
    Some(n - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_round_trip() {
        for c in [0, 1, 25, 26, 27, 51, 52, 701, 702, 703, 18277] {
            assert_eq!(letters_to_col(&col_to_letters(c)), Some(c));
        }
        assert_eq!(col_to_letters(0), "A");
        assert_eq!(col_to_letters(26), "AA");
        assert_eq!(col_to_letters(701), "ZZ");
        assert_eq!(col_to_letters(702), "AAA");
    }

    #[test]
    fn literal_parsing() {
        assert_eq!(Value::parse_literal("'000123"), Value::Text("000123".into()));
        assert_eq!(Value::parse_literal("'12345678901234567890"), Value::Text("12345678901234567890".into()));
        assert_eq!(Value::parse_literal("12"), Value::Number(12.0));
        assert_eq!(Value::parse_literal("1,234.5"), Value::Number(1234.5));
        assert_eq!(Value::parse_literal("1,5"), Value::Number(1.5));
        assert_eq!(Value::parse_literal("12%"), Value::Number(0.12));
        assert_eq!(Value::parse_literal("€ 1.000,00"), Value::Number(1000.0));
        assert_eq!(Value::parse_literal("1,500"), Value::Number(1500.0));
        assert_eq!(Value::parse_literal("1.234.567,89"), Value::Number(1234567.89));
        assert_eq!(Value::parse_literal("2026-10-08"), Value::Number(46303.0));
        assert_eq!(Value::parse_literal("08/10/2026"), Value::Number(46303.0));
        assert_eq!(Value::parse_literal("2026-10-08 06:00"), Value::Number(46303.25));
        assert_eq!(Value::parse_literal("8 Oct 2026"), Value::Number(46303.0));
        assert_eq!(Value::parse_literal("12/10"), Value::Text("12/10".into()));
        assert_eq!(Value::parse_literal("1,500 Kz"), Value::Number(1500.0));
        assert_eq!(Value::auto_format("2026-10-08"), Some("yyyy-mm-dd".into()));
        assert_eq!(Value::auto_format("08/10/2026"), Some("dd/mm/yyyy".into()));
        assert_eq!(Value::auto_format("12%"), Some("0%".into()));
        assert_eq!(Value::auto_format("€ 1.000,00"), Some("€#,##0.00".into()));
        assert_eq!(Value::auto_format("42"), None);
        assert_eq!(Value::parse_literal("TRUE"), Value::Bool(true));
        assert_eq!(Value::parse_literal("hello"), Value::Text("hello".into()));
        assert_eq!(Value::parse_literal(""), Value::Empty);
    }

    #[test]
    fn number_display() {
        assert_eq!(format_number(3.0), "3");
        assert_eq!(format_number(3.5), "3.5");
        assert_eq!(format_number(1.0 / 3.0), "0.3333333333");
        assert_eq!(format_number(-0.1 - 0.2), "-0.3");
    }

    #[test]
    fn value_json_round_trip() {
        for v in [
            Value::Empty,
            Value::Number(1.5),
            Value::Text("x".into()),
            Value::Bool(true),
            Value::Error(ErrorKind::Div0),
        ] {
            let s = serde_json::to_string(&v).unwrap();
            let back: Value = serde_json::from_str(&s).unwrap();
            assert_eq!(v, back, "{}", s);
        }
    }
}
