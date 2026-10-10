//! Operations, recalculation and undo/redo on top of the model.

use crate::formula::{self, Arg};
use crate::model::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Op {
    SetCell {
        table: TableId,
        row: u32,
        col: u32,
        input: String,
        #[serde(default)]
        kind: Option<CellKind>,
        /// SQL cells: stored connection id.
        #[serde(default)]
        conn: Option<String>,
        /// Code/SQL cells: refresh interval in seconds (0 = none).
        #[serde(default)]
        refresh: Option<u32>,
        /// Python cells: "server" to run on the host's CPython, anything else = browser.
        #[serde(default)]
        runtime: Option<String>,
        /// Python cells on the server: request GPU acceleration.
        #[serde(default)]
        gpu: Option<bool>,
    },
    /// Paste a block of literal/formula strings starting at (row, col).
    SetCells {
        table: TableId,
        row: u32,
        col: u32,
        values: Vec<Vec<String>>,
    },
    ClearRange {
        table: TableId,
        r0: u32,
        c0: u32,
        r1: u32,
        c1: u32,
    },
    SetFormat {
        table: TableId,
        r0: u32,
        c0: u32,
        r1: u32,
        c1: u32,
        format: Format,
    },
    ResizeTable {
        table: TableId,
        rows: u32,
        cols: u32,
    },
    MoveTable {
        table: TableId,
        x: f64,
        y: f64,
    },
    RenameTable {
        table: TableId,
        name: String,
    },
    SetColWidth {
        table: TableId,
        col: u32,
        width: f64,
    },
    SetRowHeight {
        table: TableId,
        row: u32,
        height: f64,
    },
    SetHeaderRows {
        table: TableId,
        header_rows: u32,
    },
    InsertRows {
        table: TableId,
        at: u32,
        count: u32,
    },
    DeleteRows {
        table: TableId,
        at: u32,
        count: u32,
    },
    InsertCols {
        table: TableId,
        at: u32,
        count: u32,
    },
    DeleteCols {
        table: TableId,
        at: u32,
        count: u32,
    },
    AddTable {
        #[serde(default)]
        id: Option<TableId>,
        #[serde(default)]
        name: Option<String>,
        x: f64,
        y: f64,
        rows: u32,
        cols: u32,
        #[serde(default)]
        values: Option<Vec<Vec<String>>>,
    },
    DeleteTable {
        table: TableId,
    },
    /// Result of running a code cell (sent by the host after the worker finishes).
    CodeResult {
        table: TableId,
        row: u32,
        col: u32,
        #[serde(default)]
        output: Option<Vec<Vec<Value>>>,
        #[serde(default)]
        std_out: Option<String>,
        #[serde(default)]
        std_err: Option<String>,
        #[serde(default)]
        deps: Vec<Rect>,
    },
    /// Make `table` the output of a pivot (None removes the pivot and keeps the values).
    SetPivot {
        table: TableId,
        #[serde(default)]
        spec: Option<PivotSpec>,
    },
    SetFilters {
        table: TableId,
        filters: Vec<ColumnFilter>,
    },
    SetCondFormats {
        table: TableId,
        rules: Vec<CondFormat>,
    },
    SetValidations {
        table: TableId,
        rules: Vec<Validation>,
    },
    /// Define or remove (reference = None) a workbook-level name.
    SetName {
        name: String,
        #[serde(default)]
        reference: Option<String>,
    },
    /// Attest a rectangle: who, when, a note and a fingerprint of the values; `locked` refuses edits inside it.
    AddSignoff {
        table: TableId,
        r0: u32,
        c0: u32,
        r1: u32,
        c1: u32,
        #[serde(default)]
        by: String,
        #[serde(default)]
        login: String,
        #[serde(default)]
        at: String,
        #[serde(default)]
        note: String,
        #[serde(default)]
        locked: bool,
    },
    RemoveSignoff {
        table: TableId,
        id: u32,
    },
    SetSignoffLocked {
        table: TableId,
        id: u32,
        locked: bool,
    },
    /// Merge a block of cells (the top-left value is kept).
    MergeCells {
        table: TableId,
        r0: u32,
        c0: u32,
        r1: u32,
        c1: u32,
    },
    /// Split every merged block intersecting the rectangle.
    UnmergeCells {
        table: TableId,
        r0: u32,
        c0: u32,
        r1: u32,
        c1: u32,
    },
    /// Add a chart (id 0 = allocate).
    AddChart {
        chart: Chart,
    },
    UpdateChart {
        chart: Chart,
    },
    DeleteChart {
        id: u32,
    },
    /// Undo/redo relayed from another client: restore cells (None = delete).
    RestoreCells {
        cells: Vec<RestoredCell>,
    },
    /// Undo/redo relayed from another client: restore whole tables (None = remove).
    RestoreTables {
        tables: Vec<RestoredTable>,
    },
    RestoreNames {
        names: Vec<NamedRange>,
    },
    RestoreCharts {
        charts: Vec<Chart>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RestoredCell {
    pub table: TableId,
    pub row: u32,
    pub col: u32,
    #[serde(default)]
    pub cell: Option<Cell>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RestoredTable {
    pub id: TableId,
    #[serde(default)]
    pub table: Option<Table>,
}

/// Precedents and dependents of a cell (for the trace overlay).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Trace {
    pub precedents: Vec<Rect>,
    pub dependents: Vec<CellRef>,
}

/// A `=CHECK(condition, label)` cell and its current outcome.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CheckView {
    pub table: TableId,
    pub row: u32,
    pub col: u32,
    pub label: String,
    pub ok: bool,
    /// true when the condition evaluated to an error
    pub error: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignoffStatus {
    pub id: u32,
    /// values inside the rectangle changed since it was signed
    pub stale: bool,
}

/// Cell as the host sees it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CellView {
    pub r: u32,
    pub c: u32,
    pub i: String,
    pub k: CellKind,
    pub v: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub f: Option<Format>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub s: Option<CellKey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ss: Option<(u32, u32)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<bool>,
    /// true when the cell breaks a validation rule
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inv: bool,
}

impl CellView {
    pub fn from_cell(key: CellKey, cell: Option<&Cell>) -> CellView {
        match cell {
            None => CellView {
                r: key.row,
                c: key.col,
                i: String::new(),
                k: CellKind::Value,
                v: Value::Empty,
                f: None,
                s: None,
                ss: None,
                out: None,
                err: None,
                conn: None,
                refresh: None,
                runtime: None,
                gpu: None,
                inv: false,
            },
            Some(c) => CellView {
                r: key.row,
                c: key.col,
                i: c.input.clone(),
                k: c.kind,
                v: c.value.clone(),
                f: if c.format.is_default() { None } else { Some(c.format.clone()) },
                s: c.spill_from,
                ss: c.spill_size,
                out: c.std_out.clone(),
                err: c.std_err.clone(),
                conn: c.conn.clone(),
                refresh: c.refresh,
                runtime: c.runtime.clone(),
                gpu: c.gpu,
                inv: c.invalid,
            },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TableMeta {
    pub id: TableId,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub rows: u32,
    pub cols: u32,
    pub header_rows: u32,
    pub col_widths: Vec<f64>,
    pub row_heights: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pivot: Option<PivotSpec>,
    pub filters: Vec<ColumnFilter>,
    pub hidden_rows: Vec<u32>,
    pub cond_formats: Vec<CondFormat>,
    pub validations: Vec<Validation>,
    pub signoffs: Vec<Signoff>,
    pub merges: Vec<Merge>,
}

impl TableMeta {
    pub fn of(t: &Table) -> TableMeta {
        TableMeta {
            id: t.id,
            name: t.name.clone(),
            x: t.x,
            y: t.y,
            rows: t.rows,
            cols: t.cols,
            header_rows: t.header_rows,
            col_widths: t.col_widths.clone(),
            row_heights: t.row_heights.clone(),
            pivot: t.pivot.clone(),
            filters: t.filters.clone(),
            hidden_rows: t.hidden_rows.clone(),
            cond_formats: t.cond_formats.clone(),
            validations: t.validations.clone(),
            signoffs: t.signoffs.clone(),
            merges: t.merges.clone(),
        }
    }
}

/// What changed after an operation; the host patches its view from this.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Changes {
    /// Individual cells (table id → views).
    pub cells: HashMap<TableId, Vec<CellView>>,
    /// Tables whose metadata/geometry changed.
    pub tables: Vec<TableMeta>,
    /// Tables whose full cell set should be reloaded (structural changes, undo).
    pub reload: Vec<TableId>,
    pub removed_tables: Vec<TableId>,
    /// Code cells to run again because something they read changed.
    pub rerun_code: Vec<CellRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Which tables were created by this op (AddTable).
    pub created: Vec<TableId>,
    /// Workbook names after the op (sent when they changed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<NamedRange>>,
    /// Charts after the op (sent when they changed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charts: Option<Vec<Chart>>,
    /// Chart created by this op (AddChart).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_chart: Option<u32>,
    /// Undo/redo: the restore ops that reproduce this change on another client.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ops: Vec<Op>,
}

impl Changes {
    fn err(msg: &str) -> Changes {
        Changes {
            error: Some(msg.to_string()),
            ..Default::default()
        }
    }
    fn push_cell(&mut self, wb: &Workbook, r: CellRef) {
        let view = CellView::from_cell(r.key(), wb.cell(r));
        self.cells.entry(r.table).or_default().push(view);
    }
    fn push_table(&mut self, wb: &Workbook, id: TableId) {
        if let Some(t) = wb.table(id) {
            if let Some(pos) = self.tables.iter().position(|m| m.id == id) {
                self.tables[pos] = TableMeta::of(t);
            } else {
                self.tables.push(TableMeta::of(t));
            }
        }
    }
}

#[derive(Clone, Debug)]
enum Inverse {
    /// Restore these cells (None = delete) and recalc.
    Cells(Vec<(CellRef, Option<Cell>)>),
    /// Restore whole tables (None = table did not exist).
    Tables(Vec<(TableId, Option<Table>)>),
    /// Restore the workbook names.
    Names(Vec<NamedRange>),
    /// Restore the chart list.
    Charts(Vec<Chart>),
}

pub struct Engine {
    pub wb: Workbook,
    undo: Vec<Inverse>,
    redo: Vec<Inverse>,
}

const MAX_UNDO: usize = 200;
const MAX_ROWS: u32 = 1_000_000;
const MAX_COLS: u32 = 10_000;
const MAX_SPILL_ROUNDS: usize = 8;

impl Engine {
    pub fn new(wb: Workbook) -> Engine {
        let mut e = Engine {
            wb,
            undo: vec![],
            redo: vec![],
        };
        for t in e.wb.tables.iter_mut() {
            t.normalise_geometry();
        }
        e.recalc_all();
        let ids: Vec<TableId> = e.wb.tables.iter().filter(|t| !t.validations.is_empty()).map(|t| t.id).collect();
        for id in ids {
            e.revalidate(id, None);
        }
        e
    }

    pub fn table_metas(&self) -> Vec<TableMeta> {
        self.wb.tables.iter().map(TableMeta::of).collect()
    }

    pub fn table_cells(&self, id: TableId) -> Vec<CellView> {
        match self.wb.table(id) {
            Some(t) => {
                let mut v: Vec<CellView> = t
                    .cells
                    .iter()
                    .filter(|(_, c)| !c.is_blank())
                    .map(|(k, c)| CellView::from_cell(*k, Some(c)))
                    .collect();
                v.sort_by_key(|c| (c.r, c.c));
                v
            }
            None => vec![],
        }
    }

    /// Plain values of a rectangle (for `q.cells()` in code cells).
    pub fn range_values(&self, id: TableId, r0: u32, c0: u32, r1: u32, c1: u32) -> Vec<Vec<Value>> {
        let mut out = vec![];
        if let Some(t) = self.wb.table(id) {
            let r1 = r1.min(t.rows.saturating_sub(1));
            let c1 = c1.min(t.cols.saturating_sub(1));
            for r in r0..=r1 {
                let mut row = vec![];
                for c in c0..=c1 {
                    row.push(t.value_at(CellKey::new(r, c)));
                }
                out.push(row);
            }
        }
        out
    }

    /// Precedents (ranges read) and dependents (cells reading it) of a cell.
    pub fn trace(&self, r: CellRef) -> Trace {
        let mut out = Trace::default();
        let t = match self.wb.table(r.table) {
            Some(t) => t,
            None => return out,
        };
        // a spilled cell traces its source
        let origin = match t.get(r.key()) {
            Some(c) => c.spill_from.map(|k| CellRef::new(r.table, k.row, k.col)).unwrap_or(r),
            None => r,
        };
        if let Some(c) = self.wb.cell(origin) {
            if c.kind == CellKind::Formula {
                out.precedents = formula::dependencies(&self.wb, origin.table, formula::formula_body(&c.input));
            } else if c.is_code() {
                out.precedents = c.code_deps.clone();
            }
        }
        // dependents: formula cells whose deps contain the cell (or any cell of its spill), code cells reading it
        let mut targets: Vec<CellKey> = vec![r.key()];
        if let Some(c) = self.wb.cell(origin) {
            if let Some((rows, cols)) = c.spill_size {
                for i in 0..rows {
                    for j in 0..cols {
                        targets.push(CellKey::new(origin.row + i, origin.col + j));
                    }
                }
            }
        }
        for t2 in &self.wb.tables {
            for (k, c) in &t2.cells {
                let rects: &[Rect] = if c.kind == CellKind::Formula {
                    &c.deps
                } else if c.is_code() {
                    &c.code_deps
                } else {
                    continue;
                };
                let hit = rects.iter().any(|rect| rect.table == r.table && targets.iter().any(|k2| rect.contains(*k2)));
                if hit {
                    out.dependents.push(CellRef::new(t2.id, k.row, k.col));
                }
            }
        }
        out.dependents.sort_by_key(|d| (d.table, d.row, d.col));
        out
    }

    /// Every `=CHECK(...)` cell with its outcome.
    pub fn checks(&self) -> Vec<CheckView> {
        let mut out = vec![];
        for t in &self.wb.tables {
            for (k, c) in &t.cells {
                if c.kind != CellKind::Formula || !c.input.to_ascii_uppercase().contains("CHECK(") {
                    continue;
                }
                let body = formula::formula_body(&c.input);
                let parsed = match formula::parse(body) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let label = match &parsed {
                    formula::Expr::Call(name, args) if name.eq_ignore_ascii_case("CHECK") => match args.get(1) {
                        Some(e) => {
                            let v = formula::evaluate(&self.wb, t.id, Some(*k), &formula::to_string(e));
                            v.to_display()
                        }
                        None => String::new(),
                    },
                    _ => continue,
                };
                let (ok, error) = match &c.value {
                    Value::Bool(b) => (*b, false),
                    Value::Number(n) => (*n != 0.0, false),
                    Value::Error(_) => (false, true),
                    _ => (false, false),
                };
                out.push(CheckView {
                    table: t.id,
                    row: k.row,
                    col: k.col,
                    label: if label.is_empty() { format!("{}!{}", t.name, format!("{}{}", crate::model::col_to_letters(k.col), k.row + 1)) } else { label },
                    ok,
                    error,
                });
            }
        }
        out.sort_by_key(|c| (c.table, c.row, c.col));
        out
    }

    /// Which sign-offs of a table no longer match the values they attested.
    pub fn signoff_status(&self, table: TableId) -> Vec<SignoffStatus> {
        match self.wb.table(table) {
            Some(t) => t
                .signoffs
                .iter()
                .map(|s| SignoffStatus {
                    id: s.id,
                    stale: t.range_hash(s.r0, s.c0, s.r1, s.c1) != s.hash,
                })
                .collect(),
            None => vec![],
        }
    }

    // ------------------------------------------------------------------
    // ops
    // ------------------------------------------------------------------

    pub fn apply(&mut self, op: Op) -> Changes {
        let mut changes = Changes::default();
        let result = self.apply_inner(op, &mut changes);
        match result {
            Ok(inv) => {
                if let Some(inv) = inv {
                    self.undo.push(inv);
                    if self.undo.len() > MAX_UNDO {
                        self.undo.remove(0);
                    }
                    self.redo.clear();
                }
                changes
            }
            Err(msg) => Changes::err(&msg),
        }
    }

    /// Apply an op that another client authored: no undo entry is recorded here, and the local
    /// undo stack is transformed so earlier entries still point at the right cells.
    pub fn apply_remote(&mut self, op: Op) -> Changes {
        let transform = match &op {
            Op::InsertRows { table, at, count } => Some((*table, true, *at, *count as i64)),
            Op::DeleteRows { table, at, count } => Some((*table, true, *at, -(*count as i64))),
            Op::InsertCols { table, at, count } => Some((*table, false, *at, *count as i64)),
            Op::DeleteCols { table, at, count } => Some((*table, false, *at, -(*count as i64))),
            _ => None,
        };
        let drop_table = match &op {
            Op::DeleteTable { table } => Some(*table),
            Op::ResizeTable { table, .. } | Op::RenameTable { table, .. } | Op::SetPivot { table, .. } => Some(*table),
            Op::RestoreTables { tables } => tables.first().map(|t| t.id),
            _ => None,
        };
        let mut changes = Changes::default();
        let result = self.apply_inner(op, &mut changes);
        match result {
            Ok(_) => {
                if let Some((table, is_rows, at, count)) = transform {
                    self.transform_undo(table, is_rows, at, count);
                }
                if let Some(id) = drop_table {
                    self.forget_table_undo(id);
                }
                changes
            }
            Err(msg) => Changes::err(&msg),
        }
    }

    /// Shift the cell refs held by undo/redo entries after a remote insert/delete in `table`.
    fn transform_undo(&mut self, table: TableId, is_rows: bool, at: u32, count: i64) {
        let shift_ref = |r: &mut CellRef| -> bool {
            if r.table != table {
                return true;
            }
            let idx = if is_rows { r.row } else { r.col } as i64;
            if count > 0 {
                if idx >= at as i64 {
                    let n = (idx + count) as u32;
                    if is_rows {
                        r.row = n;
                    } else {
                        r.col = n;
                    }
                }
                true
            } else {
                let del = -count;
                if idx >= at as i64 && idx < at as i64 + del {
                    return false; // the cell was deleted
                }
                if idx >= at as i64 + del {
                    let n = (idx - del) as u32;
                    if is_rows {
                        r.row = n;
                    } else {
                        r.col = n;
                    }
                }
                true
            }
        };
        for stack in [&mut self.undo, &mut self.redo] {
            stack.retain_mut(|inv| match inv {
                Inverse::Cells(cells) => {
                    cells.retain_mut(|(r, cell)| {
                        if let Some(c) = cell {
                            if let Some(sp) = c.spill_from.as_mut() {
                                let mut sr = CellRef::new(table, sp.row, sp.col);
                                if r.table == table && !shift_ref(&mut sr) {
                                    return false;
                                }
                                *sp = sr.key();
                            }
                        }
                        shift_ref(r)
                    });
                    !cells.is_empty()
                }
                // whole-table snapshots of that table are stale now
                Inverse::Tables(tables) => !tables.iter().any(|(id, _)| *id == table),
                _ => true,
            });
        }
    }

    fn forget_table_undo(&mut self, table: TableId) {
        for stack in [&mut self.undo, &mut self.redo] {
            stack.retain(|inv| match inv {
                Inverse::Cells(cells) => !cells.iter().any(|(r, _)| r.table == table),
                Inverse::Tables(tables) => !tables.iter().any(|(id, _)| *id == table),
                _ => true,
            });
        }
    }

    /// Refuse edits inside a locked sign-off.
    fn check_lock(t: &Table, r0: u32, c0: u32, r1: u32, c1: u32) -> Result<(), String> {
        for s in &t.signoffs {
            if s.locked && s.r0 <= r1 && r0 <= s.r1 && s.c0 <= c1 && c0 <= s.c1 {
                return Err(format!("locked: signed off by {}{}", if s.by.is_empty() { "someone" } else { &s.by }, if s.note.is_empty() { String::new() } else { format!(" ({})", s.note) }));
            }
        }
        Ok(())
    }

    /// Write one cell's input (shared by SetCell / SetCells / AddTable).
    fn write_input(t: &mut Table, key: CellKey, input: &str, kind: CellKind) {
        let entry = t.cells.entry(key).or_default();
        entry.input = input.to_string();
        entry.kind = kind;
        entry.spill_size = None;
        entry.std_err = None;
        entry.std_out = None;
        entry.code_deps.clear();
        entry.deps.clear();
        entry.deps_valid = false;
        entry.value = match kind {
            CellKind::Value => Value::parse_literal(input),
            _ => Value::Empty,
        };
        if kind == CellKind::Value && entry.format.number_format.is_none() {
            if let Some(f) = Value::auto_format(input) {
                entry.format.number_format = Some(f);
            }
        }
        if kind != CellKind::Sql {
            entry.conn = None;
        }
        if !matches!(kind, CellKind::Python | CellKind::Javascript | CellKind::Sql) {
            entry.refresh = None;
        }
        if kind != CellKind::Python {
            entry.runtime = None;
            entry.gpu = None;
        }
        if entry.is_blank() {
            t.cells.remove(&key);
        }
    }

    fn apply_inner(&mut self, op: Op, ch: &mut Changes) -> Result<Option<Inverse>, String> {
        match op {
            Op::SetCell {
                table,
                row,
                col,
                input,
                kind,
                conn,
                refresh,
                runtime,
                gpu,
            } => {
                let key = CellKey::new(row, col);
                let t = self.wb.table(table).ok_or("no such table")?;
                if !t.in_bounds(key) {
                    return Err("cell outside table".into());
                }
                if t.pivot.is_some() {
                    return Err("this table is the output of a pivot — edit the pivot settings instead".into());
                }
                Self::check_lock(t, row, col, row, col)?;
                if let Some(m) = t.merge_at(row, col) {
                    if (m.r0, m.c0) != (row, col) {
                        return Err("cell is part of a merged block; edit its top-left cell".into());
                    }
                }
                if let Some(c) = t.get(key) {
                    if c.spill_from.is_some() {
                        return Err("cell holds spilled output; edit the source cell".into());
                    }
                }
                let kind = kind.unwrap_or_else(|| infer_kind(&input));
                let mut invalid = false;
                if kind == CellKind::Value {
                    if let Err(msg) = crate::validation::check(&self.wb, table, key, &input) {
                        let strict = t.validations.iter().any(|r| r.strict && key.row >= r.r0 && key.row <= r.r1 && key.col >= r.c0 && key.col <= r.c1);
                        if strict {
                            return Err(format!("not allowed: {}", msg));
                        }
                        invalid = true;
                    }
                }
                let mut prev = vec![];
                let origin = CellRef::new(table, row, col);
                self.snapshot_spill(origin, &mut prev);
                prev.push((origin, self.wb.cell(origin).cloned()));
                let mut changed = self.clear_spill(origin);
                {
                    let t = self.wb.table_mut(table).unwrap();
                    Self::write_input(t, key, &input, kind);
                    if let Some(entry) = t.cells.get_mut(&key) {
                        entry.invalid = invalid;
                        if kind == CellKind::Sql {
                            entry.conn = conn;
                        }
                        if entry.is_code() {
                            entry.refresh = refresh.filter(|s| *s > 0);
                        }
                        if kind == CellKind::Python {
                            entry.runtime = runtime.filter(|r| r == "server");
                            entry.gpu = gpu.filter(|g| *g);
                        }
                    }
                }
                changed.push(origin);
                self.recalc_from(&changed, ch);
                if matches!(kind, CellKind::Python | CellKind::Javascript | CellKind::Sql) && !input.trim().is_empty() {
                    ch.rerun_code.push(origin);
                }
                Ok(Some(Inverse::Cells(prev)))
            }
            Op::SetCells {
                table,
                row,
                col,
                values,
            } => {
                let t = self.wb.table(table).ok_or("no such table")?;
                if t.pivot.is_some() {
                    return Err("this table is the output of a pivot — edit the pivot settings instead".into());
                }
                let need_rows = row + values.len() as u32;
                let need_cols = col + values.iter().map(|r| r.len()).max().unwrap_or(0) as u32;
                if need_rows == row || need_cols == col {
                    return Ok(None);
                }
                Self::check_lock(t, row, col, need_rows - 1, need_cols - 1)?;
                let mut prev_tables = vec![];
                let grew = need_rows > t.rows || need_cols > t.cols;
                if grew {
                    prev_tables.push((table, Some(t.clone())));
                    let t = self.wb.table_mut(table).unwrap();
                    t.rows = t.rows.max(need_rows).min(MAX_ROWS);
                    t.cols = t.cols.max(need_cols).min(MAX_COLS);
                    t.normalise_geometry();
                    ch.push_table(&self.wb, table);
                }
                let mut prev = vec![];
                let mut changed = vec![];
                for (i, r) in values.iter().enumerate() {
                    for (j, s) in r.iter().enumerate() {
                        let key = CellKey::new(row + i as u32, col + j as u32);
                        let origin = CellRef::new(table, key.row, key.col);
                        let t = self.wb.table_mut(table).unwrap();
                        if let Some(c) = t.cells.get(&key) {
                            if c.spill_from.is_some() {
                                continue;
                            }
                        }
                        if t.merge_at(key.row, key.col).map(|m| (m.r0, m.c0) != (key.row, key.col)).unwrap_or(false) {
                            continue;
                        }
                        prev.push((origin, t.cells.get(&key).cloned()));
                        let kind = infer_kind(s);
                        Self::write_input(t, key, s, kind);
                        changed.push(origin);
                    }
                }
                self.revalidate(table, Some((row, col, need_rows - 1, need_cols - 1)));
                // sources of spills that were overwritten re-evaluate (they will show #SPILL! or re-spill)
                self.recalc_from(&changed, ch);
                if grew {
                    Ok(Some(Inverse::Tables(prev_tables)))
                } else {
                    Ok(Some(Inverse::Cells(prev)))
                }
            }
            Op::ClearRange { table, r0, c0, r1, c1 } => {
                let t = self.wb.table(table).ok_or("no such table")?;
                if t.pivot.is_some() {
                    return Err("this table is the output of a pivot — edit the pivot settings instead".into());
                }
                Self::check_lock(t, r0, c0, r1, c1)?;
                let mut prev = vec![];
                let mut changed = vec![];
                for r in r0..=r1 {
                    for c in c0..=c1 {
                        let origin = CellRef::new(table, r, c);
                        let existing = self.wb.table(table).and_then(|t| t.cells.get(&CellKey::new(r, c)).cloned());
                        if let Some(cell) = existing {
                            if cell.spill_from.is_some() {
                                continue;
                            }
                            self.snapshot_spill(origin, &mut prev);
                            prev.push((origin, Some(cell)));
                            changed.extend(self.clear_spill(origin));
                            self.wb.table_mut(table).unwrap().cells.remove(&CellKey::new(r, c));
                            changed.push(origin);
                        }
                    }
                }
                self.recalc_from(&changed, ch);
                Ok(Some(Inverse::Cells(prev)))
            }
            Op::SetFormat {
                table,
                r0,
                c0,
                r1,
                c1,
                format,
            } => {
                self.wb.table(table).ok_or("no such table")?;
                let mut prev = vec![];
                for r in r0..=r1 {
                    for c in c0..=c1 {
                        let key = CellKey::new(r, c);
                        let origin = CellRef::new(table, r, c);
                        let t = self.wb.table_mut(table).unwrap();
                        if !t.in_bounds(key) {
                            continue;
                        }
                        prev.push((origin, t.cells.get(&key).cloned()));
                        let entry = t.cells.entry(key).or_default();
                        entry.format.merge(&format);
                        if entry.is_blank() {
                            t.cells.remove(&key);
                        }
                        ch.push_cell(&self.wb, origin);
                    }
                }
                Ok(Some(Inverse::Cells(prev)))
            }
            Op::ResizeTable { table, rows, cols } => {
                let t = self.wb.table(table).ok_or("no such table")?;
                let rows = rows.clamp(1, MAX_ROWS);
                let cols = cols.clamp(1, MAX_COLS);
                if rows == t.rows && cols == t.cols {
                    return Ok(None);
                }
                let snapshot = t.clone();
                let t = self.wb.table_mut(table).unwrap();
                t.rows = rows;
                t.cols = cols;
                t.cells.retain(|k, _| k.row < rows && k.col < cols);
                t.normalise_geometry();
                ch.push_table(&self.wb, table);
                ch.reload.push(table);
                self.recalc_all_into(ch);
                Ok(Some(Inverse::Tables(vec![(table, Some(snapshot))])))
            }
            Op::MoveTable { table, x, y } => {
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                let prev = t.clone();
                t.x = x;
                t.y = y;
                ch.push_table(&self.wb, table);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::RenameTable { table, name } => {
                let name = name.trim().to_string();
                if name.is_empty() {
                    return Err("name cannot be empty".into());
                }
                if let Some(other) = self.wb.table_by_name(&name) {
                    if other.id != table {
                        return Err("a table with that name already exists".into());
                    }
                }
                let old = self.wb.table(table).ok_or("no such table")?.name.clone();
                // every table holding a formula or pivot that mentions the old name is snapshotted
                let mut inv: Vec<(TableId, Option<Table>)> = vec![];
                for t in &self.wb.tables {
                    let mentions = t.id == table || t.cells.values().any(|c| c.kind == CellKind::Formula && c.input.to_lowercase().contains(&old.to_lowercase()));
                    if mentions {
                        inv.push((t.id, Some(t.clone())));
                    }
                }
                let names_before = self.wb.names.clone();
                for t in self.wb.tables.iter_mut() {
                    if t.id == table {
                        t.name = name.clone();
                    }
                    for c in t.cells.values_mut() {
                        if c.kind == CellKind::Formula {
                            let body = formula::formula_body(&c.input).to_string();
                            let new = formula::rename_table(&body, &old, &name);
                            if new != body {
                                c.input = format!("={}", new);
                                c.deps_valid = false;
                            }
                        }
                    }
                }
                for nr in self.wb.names.iter_mut() {
                    nr.reference = formula::rename_table(&nr.reference, &old, &name);
                }
                let charts_before = self.wb.charts.clone();
                for c in self.wb.charts.iter_mut() {
                    c.categories = formula::rename_table(&c.categories, &old, &name);
                    for s in c.series.iter_mut() {
                        s.range = formula::rename_table(&s.range, &old, &name);
                    }
                }
                if charts_before != self.wb.charts {
                    ch.charts = Some(self.wb.charts.clone());
                }
                ch.push_table(&self.wb, table);
                for (id, _) in &inv {
                    ch.reload.push(*id);
                }
                self.recalc_all_into(ch);
                if names_before != self.wb.names {
                    ch.names = Some(self.wb.names.clone());
                }
                Ok(Some(Inverse::Tables(inv)))
            }
            Op::SetColWidth { table, col, width } => {
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                if col >= t.cols {
                    return Err("column outside table".into());
                }
                let prev = t.clone();
                t.col_widths[col as usize] = width.clamp(20.0, 2000.0);
                ch.push_table(&self.wb, table);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::SetRowHeight { table, row, height } => {
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                if row >= t.rows {
                    return Err("row outside table".into());
                }
                let prev = t.clone();
                t.row_heights[row as usize] = height.clamp(12.0, 1000.0);
                ch.push_table(&self.wb, table);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::SetHeaderRows { table, header_rows } => {
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                let prev = t.clone();
                t.header_rows = header_rows.min(t.rows);
                t.apply_filters();
                ch.push_table(&self.wb, table);
                self.recalc_all_into(ch); // structured references depend on the header row
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::InsertRows { table, at, count } | Op::InsertCols { table, at, count } if count > 0 => {
                let is_rows = matches!(op_kind(&op), 'r');
                let t = self.wb.table(table).ok_or("no such table")?;
                let limit = if is_rows { t.rows } else { t.cols };
                if at > limit {
                    return Err("insert position outside table".into());
                }
                let name = t.name.clone();
                let snapshot = t.clone();
                let others = self.snapshot_other_tables(table);
                let t = self.wb.table_mut(table).unwrap();
                let mut moved = HashMap::new();
                for (k, c) in t.cells.drain() {
                    let (mut k2, mut c2) = (k, c);
                    if is_rows && k.row >= at {
                        k2.row += count;
                    }
                    if !is_rows && k.col >= at {
                        k2.col += count;
                    }
                    if let Some(sp) = c2.spill_from {
                        let mut sp2 = sp;
                        if is_rows && sp.row >= at {
                            sp2.row += count;
                        }
                        if !is_rows && sp.col >= at {
                            sp2.col += count;
                        }
                        c2.spill_from = Some(sp2);
                    }
                    moved.insert(k2, c2);
                }
                t.cells = moved;
                if is_rows {
                    t.rows = (t.rows + count).min(MAX_ROWS);
                    for _ in 0..count {
                        t.row_heights.insert(at as usize, DEFAULT_ROW_HEIGHT);
                    }
                } else {
                    t.cols = (t.cols + count).min(MAX_COLS);
                    for _ in 0..count {
                        t.col_widths.insert(at as usize, DEFAULT_COL_WIDTH);
                    }
                }
                shift_rules(t, is_rows, at, count as i64);
                t.normalise_geometry();
                let charts_before = self.wb.charts.clone();
                self.rewrite_formulas(table, &name, is_rows, at, count as i64);
                if charts_before != self.wb.charts {
                    ch.charts = Some(self.wb.charts.clone());
                }
                ch.push_table(&self.wb, table);
                ch.reload.push(table);
                self.recalc_all_into(ch);
                let mut inv = vec![(table, Some(snapshot))];
                inv.extend(others);
                Ok(Some(Inverse::Tables(inv)))
            }
            Op::DeleteRows { table, at, count } | Op::DeleteCols { table, at, count } if count > 0 => {
                let is_rows = matches!(op_kind(&op), 'r');
                let t = self.wb.table(table).ok_or("no such table")?;
                let limit = if is_rows { t.rows } else { t.cols };
                if at >= limit {
                    return Err("delete position outside table".into());
                }
                let count = count.min(limit - at);
                if count >= limit {
                    return Err("a table must keep at least one row and column".into());
                }
                if is_rows {
                    Self::check_lock(t, at, 0, at + count - 1, t.cols.saturating_sub(1))?;
                } else {
                    Self::check_lock(t, 0, at, t.rows.saturating_sub(1), at + count - 1)?;
                }
                let name = t.name.clone();
                let snapshot = t.clone();
                let others = self.snapshot_other_tables(table);
                let t = self.wb.table_mut(table).unwrap();
                let mut moved = HashMap::new();
                for (k, c) in t.cells.drain() {
                    let idx = if is_rows { k.row } else { k.col };
                    if idx >= at && idx < at + count {
                        continue;
                    }
                    let (mut k2, mut c2) = (k, c);
                    if is_rows && k.row >= at + count {
                        k2.row -= count;
                    }
                    if !is_rows && k.col >= at + count {
                        k2.col -= count;
                    }
                    if let Some(sp) = c2.spill_from {
                        let sidx = if is_rows { sp.row } else { sp.col };
                        if sidx >= at && sidx < at + count {
                            continue; // origin deleted → drop spill
                        }
                        let mut sp2 = sp;
                        if is_rows && sp.row >= at + count {
                            sp2.row -= count;
                        }
                        if !is_rows && sp.col >= at + count {
                            sp2.col -= count;
                        }
                        c2.spill_from = Some(sp2);
                    }
                    moved.insert(k2, c2);
                }
                t.cells = moved;
                if is_rows {
                    t.rows -= count;
                    t.row_heights.drain(at as usize..(at + count) as usize);
                } else {
                    t.cols -= count;
                    t.col_widths.drain(at as usize..(at + count) as usize);
                }
                shift_rules(t, is_rows, at, -(count as i64));
                t.normalise_geometry();
                let charts_before = self.wb.charts.clone();
                self.rewrite_formulas(table, &name, is_rows, at, -(count as i64));
                if charts_before != self.wb.charts {
                    ch.charts = Some(self.wb.charts.clone());
                }
                ch.push_table(&self.wb, table);
                ch.reload.push(table);
                self.recalc_all_into(ch);
                let mut inv = vec![(table, Some(snapshot))];
                inv.extend(others);
                Ok(Some(Inverse::Tables(inv)))
            }
            Op::InsertRows { .. } | Op::InsertCols { .. } | Op::DeleteRows { .. } | Op::DeleteCols { .. } => Ok(None),
            Op::AddTable {
                id,
                name,
                x,
                y,
                rows,
                cols,
                values,
            } => {
                let id = match id {
                    Some(i) => {
                        if self.wb.table(i).is_some() {
                            return Err("table id already exists".into());
                        }
                        if i >= self.wb.next_table_id {
                            self.wb.next_table_id = i + 1;
                        }
                        i
                    }
                    None => self.wb.alloc_table_id(),
                };
                let base = name.unwrap_or_else(|| format!("Table {}", id));
                let name = self.wb.unique_table_name(&base);
                let (rows, cols) = match &values {
                    Some(v) => (
                        rows.max(v.len() as u32),
                        cols.max(v.iter().map(|r| r.len()).max().unwrap_or(0) as u32),
                    ),
                    None => (rows, cols),
                };
                let mut t = Table::new(id, &name, x, y, rows.clamp(1, MAX_ROWS), cols.clamp(1, MAX_COLS));
                if let Some(v) = values {
                    for (i, r) in v.iter().enumerate() {
                        for (j, s) in r.iter().enumerate() {
                            if s.is_empty() {
                                continue;
                            }
                            let kind = infer_kind(s);
                            Self::write_input(&mut t, CellKey::new(i as u32, j as u32), s, kind);
                        }
                    }
                }
                self.wb.tables.push(t);
                ch.push_table(&self.wb, id);
                ch.reload.push(id);
                ch.created.push(id);
                self.recalc_all_into(ch);
                Ok(Some(Inverse::Tables(vec![(id, None)])))
            }
            Op::DeleteTable { table } => {
                let idx = self.wb.tables.iter().position(|t| t.id == table).ok_or("no such table")?;
                let t = self.wb.tables.remove(idx);
                ch.removed_tables.push(table);
                self.recalc_all_into(ch);
                Ok(Some(Inverse::Tables(vec![(table, Some(t))])))
            }
            Op::CodeResult {
                table,
                row,
                col,
                output,
                std_out,
                std_err,
                deps,
            } => {
                let origin = CellRef::new(table, row, col);
                let t = self.wb.table(table).ok_or("no such table")?;
                let cell = t.get(CellKey::new(row, col)).ok_or("no code cell")?;
                if !cell.is_code() {
                    return Err("not a code cell".into());
                }
                let mut changed = self.clear_spill(origin);
                let grew = self.write_spill(origin, output.as_ref(), &mut changed, |entry| {
                    entry.std_out = std_out.clone().filter(|s| !s.is_empty());
                    entry.std_err = std_err.clone().filter(|s| !s.is_empty());
                    entry.code_deps = deps.clone();
                    if entry.std_err.is_some() && output.is_none() {
                        entry.value = Value::Error(ErrorKind::Other);
                        true
                    } else {
                        false
                    }
                });
                changed.push(origin);
                if grew {
                    ch.push_table(&self.wb, table);
                }
                self.recalc_from(&changed, ch);
                // results are derived state: not undoable on their own
                Ok(None)
            }
            Op::SetPivot { table, spec } => {
                let t = self.wb.table(table).ok_or("no such table")?;
                if let Some(s) = &spec {
                    if s.source == table {
                        return Err("a pivot cannot use its own table as the source".into());
                    }
                    let src = self.wb.table(s.source).ok_or("pivot source table not found")?;
                    if src.pivot.is_some() {
                        return Err("the source of a pivot cannot itself be a pivot".into());
                    }
                }
                let prev = t.clone();
                let t = self.wb.table_mut(table).unwrap();
                let had = t.pivot.is_some();
                t.pivot = spec;
                if had && t.pivot.is_none() {
                    // keep the values as plain cells
                    for c in t.cells.values_mut() {
                        c.spill_from = None;
                        c.input = c.value.to_display();
                    }
                }
                ch.push_table(&self.wb, table);
                ch.reload.push(table);
                self.recalc_all_into(ch);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::SetFilters { table, filters } => {
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                let prev = t.clone();
                t.filters = filters.into_iter().filter(|f| f.col < t.cols).collect();
                t.apply_filters();
                ch.push_table(&self.wb, table);
                // SUBTOTAL(1xx) results depend on hidden rows
                self.recalc_all_into(ch);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::SetCondFormats { table, rules } => {
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                let prev = t.clone();
                t.cond_formats = rules;
                ch.push_table(&self.wb, table);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::SetValidations { table, rules } => {
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                let prev = t.clone();
                t.validations = rules;
                let marked = self.revalidate(table, None);
                ch.push_table(&self.wb, table);
                for r in marked {
                    ch.push_cell(&self.wb, r);
                }
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::SetName { name, reference } => {
                let name = name.trim().to_string();
                if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.') || name.chars().next().unwrap().is_ascii_digit() {
                    return Err("a name must start with a letter and contain only letters, digits, '_' or '.'".into());
                }
                if crate::formula::parse(&name).map(|e| matches!(e, crate::formula::Expr::Ref(_))).unwrap_or(false) {
                    return Err("that looks like a cell reference".into());
                }
                let prev = self.wb.names.clone();
                let lower = name.to_lowercase();
                self.wb.names.retain(|n| n.name.to_lowercase() != lower);
                if let Some(r) = reference {
                    let r = r.trim().trim_start_matches('=').to_string();
                    if r.is_empty() {
                        return Err("reference cannot be empty".into());
                    }
                    crate::formula::parse(&r).map_err(|e| format!("bad reference: {}", e.0))?;
                    self.wb.names.push(NamedRange { name, reference: r });
                    self.wb.names.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                }
                ch.names = Some(self.wb.names.clone());
                self.recalc_all_into(ch);
                Ok(Some(Inverse::Names(prev)))
            }
            Op::AddSignoff {
                table,
                r0,
                c0,
                r1,
                c1,
                by,
                login,
                at,
                note,
                locked,
            } => {
                let t = self.wb.table(table).ok_or("no such table")?;
                if r0 > r1 || c0 > c1 || r1 >= t.rows || c1 >= t.cols {
                    return Err("sign-off range outside table".into());
                }
                let prev = t.clone();
                let id = t.signoffs.iter().map(|s| s.id).max().unwrap_or(0) + 1;
                let hash = t.range_hash(r0, c0, r1, c1);
                let t = self.wb.table_mut(table).unwrap();
                t.signoffs.push(Signoff {
                    id,
                    r0,
                    c0,
                    r1,
                    c1,
                    by,
                    login,
                    at,
                    note,
                    hash,
                    locked,
                });
                ch.push_table(&self.wb, table);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::RemoveSignoff { table, id } => {
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                let prev = t.clone();
                let before = t.signoffs.len();
                t.signoffs.retain(|s| s.id != id);
                if t.signoffs.len() == before {
                    return Err("no such sign-off".into());
                }
                ch.push_table(&self.wb, table);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::SetSignoffLocked { table, id, locked } => {
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                let prev = t.clone();
                let s = t.signoffs.iter_mut().find(|s| s.id == id).ok_or("no such sign-off")?;
                s.locked = locked;
                ch.push_table(&self.wb, table);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::MergeCells { table, r0, c0, r1, c1 } => {
                let t = self.wb.table(table).ok_or("no such table")?;
                if r0 > r1 || c0 > c1 || r1 >= t.rows || c1 >= t.cols {
                    return Err("merge range outside table".into());
                }
                if r0 == r1 && c0 == c1 {
                    return Err("select at least two cells to merge".into());
                }
                if t.pivot.is_some() {
                    return Err("pivot output cannot be merged".into());
                }
                Self::check_lock(t, r0, c0, r1, c1)?;
                let prev = t.clone();
                let t = self.wb.table_mut(table).unwrap();
                t.merges.retain(|m| !m.intersects(r0, c0, r1, c1));
                t.merges.push(Merge { r0, c0, r1, c1 });
                // only the top-left value survives; formats are kept
                let mut changed = vec![];
                let mut spill_sources = vec![];
                for r in r0..=r1 {
                    for c in c0..=c1 {
                        if (r, c) == (r0, c0) {
                            continue;
                        }
                        let key = CellKey::new(r, c);
                        if let Some(cell) = t.cells.get_mut(&key) {
                            if let Some(sp) = cell.spill_from {
                                spill_sources.push(CellRef::new(table, sp.row, sp.col));
                            }
                            if !cell.input.is_empty() || !cell.value.is_empty() {
                                cell.input.clear();
                                cell.kind = CellKind::Value;
                                cell.value = Value::Empty;
                                cell.spill_from = None;
                                cell.spill_size = None;
                                cell.std_out = None;
                                cell.std_err = None;
                                cell.deps.clear();
                                cell.deps_valid = false;
                                changed.push(CellRef::new(table, r, c));
                            }
                            if cell.is_blank() {
                                t.cells.remove(&key);
                            }
                        }
                    }
                }
                changed.extend(spill_sources);
                ch.push_table(&self.wb, table);
                self.recalc_from(&changed, ch);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::UnmergeCells { table, r0, c0, r1, c1 } => {
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                let prev = t.clone();
                let before = t.merges.len();
                t.merges.retain(|m| !m.intersects(r0, c0, r1, c1));
                if t.merges.len() == before {
                    return Ok(None);
                }
                ch.push_table(&self.wb, table);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
            }
            Op::AddChart { mut chart } => {
                let prev = self.wb.charts.clone();
                if chart.id == 0 || self.wb.charts.iter().any(|c| c.id == chart.id) {
                    chart.id = self.wb.alloc_chart_id();
                } else if chart.id >= self.wb.next_chart_id {
                    self.wb.next_chart_id = chart.id + 1;
                }
                if chart.kind.is_empty() {
                    chart.kind = "bar".into();
                }
                if chart.w <= 0.0 {
                    chart.w = 560.0;
                }
                if chart.h <= 0.0 {
                    chart.h = 380.0;
                }
                let id = chart.id;
                self.wb.charts.push(chart);
                ch.charts = Some(self.wb.charts.clone());
                ch.created_chart = Some(id);
                Ok(Some(Inverse::Charts(prev)))
            }
            Op::UpdateChart { chart } => {
                let pos = self.wb.charts.iter().position(|c| c.id == chart.id).ok_or("no such chart")?;
                let prev = self.wb.charts.clone();
                self.wb.charts[pos] = chart;
                ch.charts = Some(self.wb.charts.clone());
                Ok(Some(Inverse::Charts(prev)))
            }
            Op::DeleteChart { id } => {
                let pos = self.wb.charts.iter().position(|c| c.id == id).ok_or("no such chart")?;
                let prev = self.wb.charts.clone();
                self.wb.charts.remove(pos);
                ch.charts = Some(self.wb.charts.clone());
                Ok(Some(Inverse::Charts(prev)))
            }
            Op::RestoreCells { cells } => {
                let list: Vec<(CellRef, Option<Cell>)> = cells.into_iter().map(|c| (CellRef::new(c.table, c.row, c.col), c.cell)).collect();
                let (inv, _) = self.restore_cells(list, ch);
                Ok(Some(inv))
            }
            Op::RestoreTables { tables } => {
                let list: Vec<(TableId, Option<Table>)> = tables.into_iter().map(|t| (t.id, t.table)).collect();
                let (inv, _) = self.restore_tables(list, ch);
                Ok(Some(inv))
            }
            Op::RestoreNames { names } => {
                let (inv, _) = self.restore_names(names, ch);
                Ok(Some(inv))
            }
            Op::RestoreCharts { charts } => {
                let (inv, _) = self.restore_charts(charts, ch);
                Ok(Some(inv))
            }
        }
    }

    /// Re-check validation marks of a table (optionally only inside a rectangle); returns cells whose mark changed.
    fn revalidate(&mut self, table: TableId, rect: Option<(u32, u32, u32, u32)>) -> Vec<CellRef> {
        let mut out = vec![];
        let t = match self.wb.table(table) {
            Some(t) => t,
            None => return out,
        };
        if t.validations.is_empty() && rect.is_some() {
            return out;
        }
        let mut updates: Vec<(CellKey, bool)> = vec![];
        for (k, c) in &t.cells {
            if let Some((r0, c0, r1, c1)) = rect {
                if k.row < r0 || k.row > r1 || k.col < c0 || k.col > c1 {
                    continue;
                }
            }
            let covered = t.validations.iter().any(|r| k.row >= r.r0 && k.row <= r.r1 && k.col >= r.c0 && k.col <= r.c1);
            let invalid = covered && c.kind == CellKind::Value && c.spill_from.is_none() && crate::validation::check(&self.wb, table, *k, &c.input).is_err();
            if invalid != c.invalid {
                updates.push((*k, invalid));
            }
        }
        let t = self.wb.table_mut(table).unwrap();
        for (k, inv) in updates {
            if let Some(c) = t.cells.get_mut(&k) {
                c.invalid = inv;
                out.push(CellRef::new(table, k.row, k.col));
            }
        }
        out
    }

    /// Write a rectangular output starting at `origin` as spilled cells; returns whether the table grew.
    /// `patch` runs on the origin cell first and returns true when the value was set to an error already.
    fn write_spill(&mut self, origin: CellRef, output: Option<&Vec<Vec<Value>>>, changed: &mut Vec<CellRef>, patch: impl FnOnce(&mut Cell) -> bool) -> bool {
        let (table, row, col) = (origin.table, origin.row, origin.col);
        let (out_rows, out_cols) = match output {
            Some(v) => (v.len() as u32, v.iter().map(|r| r.len()).max().unwrap_or(0) as u32),
            None => (0, 0),
        };
        let t = self.wb.table_mut(table).unwrap();
        let mut grew = false;
        if row + out_rows > t.rows || col + out_cols > t.cols {
            t.rows = t.rows.max(row + out_rows).min(MAX_ROWS);
            t.cols = t.cols.max(col + out_cols).min(MAX_COLS);
            t.normalise_geometry();
            grew = true;
        }
        let mut blocked = false;
        if out_rows * out_cols > 1 {
            for i in 0..out_rows {
                for j in 0..out_cols {
                    if i == 0 && j == 0 {
                        continue;
                    }
                    if let Some(c) = t.cells.get(&CellKey::new(row + i, col + j)) {
                        // a cell blocks a spill when it holds something of its own: an input, a value that is not ours,
                        // or another formula's spill — a format alone (a number format set on an empty range, as a
                        // template or an import does ahead of the values) is not an occupant
                        let ours = c.spill_from == Some(CellKey::new(row, col));
                        let occupied = !c.input.is_empty() || (c.spill_from.is_some() && !ours) || (c.spill_from.is_none() && !c.value.is_empty());
                        if occupied {
                            blocked = true;
                        }
                    }
                }
            }
        }
        let entry = t.cells.get_mut(&CellKey::new(row, col)).unwrap();
        entry.spill_size = None;
        let already_error = patch(entry);
        if already_error {
            return grew;
        }
        if blocked {
            entry.value = Value::Error(ErrorKind::Spill);
            return grew;
        }
        match output {
            None => entry.value = Value::Empty,
            Some(v) => {
                entry.value = v.first().and_then(|r| r.first()).cloned().unwrap_or(Value::Empty);
                if out_rows * out_cols > 1 {
                    entry.spill_size = Some((out_rows, out_cols));
                    for i in 0..out_rows {
                        for j in 0..out_cols {
                            if i == 0 && j == 0 {
                                continue;
                            }
                            let val = v.get(i as usize).and_then(|r| r.get(j as usize)).cloned().unwrap_or(Value::Empty);
                            let key = CellKey::new(row + i, col + j);
                            let fmt = t.cells.get(&key).map(|c| c.format.clone()).unwrap_or_default();
                            t.cells.insert(
                                key,
                                Cell {
                                    input: String::new(),
                                    kind: CellKind::Value,
                                    value: val,
                                    spill_from: Some(CellKey::new(row, col)),
                                    format: fmt,
                                    ..Default::default()
                                },
                            );
                            changed.push(CellRef::new(table, key.row, key.col));
                        }
                    }
                }
            }
        }
        grew
    }

    fn snapshot_other_tables(&self, except: TableId) -> Vec<(TableId, Option<Table>)> {
        // other tables may have formulas rewritten; snapshot those that reference `except`
        let name = self.wb.table(except).map(|t| t.name.to_lowercase()).unwrap_or_default();
        self.wb
            .tables
            .iter()
            .filter(|t| t.id != except)
            .filter(|t| {
                t.cells.values().any(|c| {
                    c.kind == CellKind::Formula && c.input.to_lowercase().contains(&name)
                })
            })
            .map(|t| (t.id, Some(t.clone())))
            .collect()
    }

    /// Rewrite every formula referencing `table` after an insert/delete.
    fn rewrite_formulas(&mut self, table: TableId, name: &str, is_rows: bool, at: u32, count: i64) {
        for t in self.wb.tables.iter_mut() {
            let is_current = t.id == table;
            for c in t.cells.values_mut() {
                if c.kind != CellKind::Formula {
                    continue;
                }
                let body = formula::formula_body(&c.input).to_string();
                let new = formula::adjust_for_insert_delete(&body, is_current, name, is_rows, at, count);
                if new != body {
                    c.input = format!("={}", new);
                }
                c.deps_valid = false;
            }
        }
        for nr in self.wb.names.iter_mut() {
            nr.reference = formula::adjust_for_insert_delete(&nr.reference, false, name, is_rows, at, count);
        }
        // chart ranges are reference texts too: keep them pointing at the same data
        for c in self.wb.charts.iter_mut() {
            c.categories = formula::adjust_for_insert_delete(&c.categories, false, name, is_rows, at, count);
            for s in c.series.iter_mut() {
                s.range = formula::adjust_for_insert_delete(&s.range, false, name, is_rows, at, count);
            }
        }
    }

    fn snapshot_spill(&self, origin: CellRef, prev: &mut Vec<(CellRef, Option<Cell>)>) {
        if let Some(t) = self.wb.table(origin.table) {
            for (k, c) in &t.cells {
                if c.spill_from == Some(origin.key()) {
                    prev.push((CellRef::new(origin.table, k.row, k.col), Some(c.clone())));
                }
            }
        }
    }

    /// Remove cells spilled from `origin`; returns their refs.
    fn clear_spill(&mut self, origin: CellRef) -> Vec<CellRef> {
        let mut out = vec![];
        if let Some(t) = self.wb.table_mut(origin.table) {
            let keys: Vec<CellKey> = t
                .cells
                .iter()
                .filter(|(_, c)| c.spill_from == Some(origin.key()))
                .map(|(k, _)| *k)
                .collect();
            for k in keys {
                let keep_format = t.cells.get(&k).map(|c| c.format.clone()).unwrap_or_default();
                if keep_format.is_default() {
                    t.cells.remove(&k);
                } else {
                    t.cells.insert(
                        k,
                        Cell {
                            format: keep_format,
                            ..Default::default()
                        },
                    );
                }
                out.push(CellRef::new(origin.table, k.row, k.col));
            }
        }
        out
    }

    // ------------------------------------------------------------------
    // undo / redo
    // ------------------------------------------------------------------

    pub fn undo(&mut self) -> Changes {
        match self.undo.pop() {
            None => Changes::default(),
            Some(inv) => {
                let (redo, ch) = self.restore(inv);
                self.redo.push(redo);
                ch
            }
        }
    }

    pub fn redo(&mut self) -> Changes {
        match self.redo.pop() {
            None => Changes::default(),
            Some(inv) => {
                let (undo, ch) = self.restore(inv);
                self.undo.push(undo);
                ch
            }
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    fn restore(&mut self, inv: Inverse) -> (Inverse, Changes) {
        let mut ch = Changes::default();
        let (counter, op) = match inv {
            Inverse::Cells(cells) => self.restore_cells(cells, &mut ch),
            Inverse::Tables(tables) => self.restore_tables(tables, &mut ch),
            Inverse::Names(names) => self.restore_names(names, &mut ch),
            Inverse::Charts(charts) => self.restore_charts(charts, &mut ch),
        };
        ch.ops.push(op);
        (counter, ch)
    }

    fn restore_cells(&mut self, cells: Vec<(CellRef, Option<Cell>)>, ch: &mut Changes) -> (Inverse, Op) {
        let op = Op::RestoreCells {
            cells: cells
                .iter()
                .map(|(r, c)| RestoredCell {
                    table: r.table,
                    row: r.row,
                    col: r.col,
                    cell: c.clone(),
                })
                .collect(),
        };
        let mut counter = vec![];
        let mut changed = vec![];
        for (r, cell) in cells {
            if self.wb.table(r.table).is_none() {
                continue;
            }
            counter.push((r, self.wb.cell(r).cloned()));
            if let Some(t) = self.wb.table_mut(r.table) {
                match cell {
                    Some(mut c) => {
                        c.deps_valid = false;
                        if t.in_bounds(r.key()) {
                            t.cells.insert(r.key(), c);
                        }
                    }
                    None => {
                        t.cells.remove(&r.key());
                    }
                }
            }
            changed.push(r);
        }
        self.recalc_from(&changed, ch);
        // code cells restored with inputs must be re-run to rebuild outputs
        for r in &changed {
            if let Some(c) = self.wb.cell(*r) {
                if c.is_code() && c.spill_from.is_none() {
                    ch.rerun_code.push(*r);
                }
            }
        }
        (Inverse::Cells(counter), op)
    }

    fn restore_tables(&mut self, tables: Vec<(TableId, Option<Table>)>, ch: &mut Changes) -> (Inverse, Op) {
        let op = Op::RestoreTables {
            tables: tables.iter().map(|(id, t)| RestoredTable { id: *id, table: t.clone() }).collect(),
        };
        let mut counter = vec![];
        for (id, table) in tables {
            counter.push((id, self.wb.table(id).cloned()));
            let pos = self.wb.tables.iter().position(|t| t.id == id);
            match (table, pos) {
                (Some(mut t), Some(p)) => {
                    t.normalise_geometry();
                    self.wb.tables[p] = t;
                }
                (Some(mut t), None) => {
                    t.normalise_geometry();
                    if t.id >= self.wb.next_table_id {
                        self.wb.next_table_id = t.id + 1;
                    }
                    self.wb.tables.push(t);
                }
                (None, Some(p)) => {
                    self.wb.tables.remove(p);
                    ch.removed_tables.push(id);
                }
                (None, None) => {}
            }
            if self.wb.table(id).is_some() {
                ch.push_table(&self.wb, id);
                ch.reload.push(id);
            }
        }
        self.recalc_all_into(ch);
        (Inverse::Tables(counter), op)
    }

    fn restore_names(&mut self, names: Vec<NamedRange>, ch: &mut Changes) -> (Inverse, Op) {
        let op = Op::RestoreNames { names: names.clone() };
        let counter = self.wb.names.clone();
        self.wb.names = names;
        ch.names = Some(self.wb.names.clone());
        self.recalc_all_into(ch);
        (Inverse::Names(counter), op)
    }

    fn restore_charts(&mut self, charts: Vec<Chart>, ch: &mut Changes) -> (Inverse, Op) {
        let op = Op::RestoreCharts { charts: charts.clone() };
        let counter = self.wb.charts.clone();
        self.wb.charts = charts;
        for c in &self.wb.charts {
            if c.id >= self.wb.next_chart_id {
                self.wb.next_chart_id = c.id + 1;
            }
        }
        ch.charts = Some(self.wb.charts.clone());
        (Inverse::Charts(counter), op)
    }

    // ------------------------------------------------------------------
    // recalculation
    // ------------------------------------------------------------------

    /// Make sure every formula cell has up-to-date dependency rectangles.
    fn refresh_deps(&mut self, all: bool) {
        let mut todo: Vec<(CellRef, String)> = vec![];
        for t in &self.wb.tables {
            for (k, c) in &t.cells {
                if c.kind == CellKind::Formula && (all || !c.deps_valid) {
                    todo.push((CellRef::new(t.id, k.row, k.col), c.input.clone()));
                }
            }
        }
        if todo.is_empty() {
            return;
        }
        let computed: Vec<(CellRef, Vec<Rect>)> = todo
            .iter()
            .map(|(r, input)| (*r, formula::dependencies(&self.wb, r.table, formula::formula_body(input))))
            .collect();
        for (r, deps) in computed {
            if let Some(t) = self.wb.table_mut(r.table) {
                if let Some(c) = t.cells.get_mut(&r.key()) {
                    c.deps = deps;
                    c.deps_valid = true;
                }
            }
        }
    }

    fn formula_cells(&self) -> Vec<(CellRef, Vec<Rect>)> {
        let mut out = vec![];
        for t in &self.wb.tables {
            for (k, c) in &t.cells {
                if c.kind == CellKind::Formula {
                    out.push((CellRef::new(t.id, k.row, k.col), c.deps.clone()));
                }
            }
        }
        out
    }

    pub fn recalc_all(&mut self) {
        let mut ch = Changes::default();
        self.recalc_all_into(&mut ch);
    }

    fn recalc_all_into(&mut self, ch: &mut Changes) {
        self.refresh_deps(true);
        let all = self.formula_cells();
        let dirty: Vec<CellRef> = all.iter().map(|(r, _)| *r).collect();
        let mut extra = self.evaluate_dirty(&all, &dirty, ch);
        let mut rounds = 0;
        while !extra.is_empty() && rounds < MAX_SPILL_ROUNDS {
            rounds += 1;
            extra = self.recalc_round(&extra, ch);
        }
        self.recompute_pivots(None, ch);
        for t in self.wb.tables.iter_mut() {
            t.apply_filters();
        }
        // after a structural change every code cell may read different data
        for t in &self.wb.tables {
            for (k, c) in &t.cells {
                if c.is_code() && !c.code_deps.is_empty() {
                    ch.rerun_code.push(CellRef::new(t.id, k.row, k.col));
                }
            }
        }
    }

    /// Recalculate everything that (transitively) depends on `changed` cells.
    fn recalc_from(&mut self, changed: &[CellRef], ch: &mut Changes) {
        for r in changed {
            ch.push_cell(&self.wb, *r);
        }
        self.refresh_deps(false);
        let mut frontier: Vec<CellRef> = changed.to_vec();
        // blocked spills (#SPILL!) in a touched table get another chance: a blocking cell may have gone
        let tables_touched: HashSet<TableId> = changed.iter().map(|r| r.table).collect();
        for t in &self.wb.tables {
            if !tables_touched.contains(&t.id) {
                continue;
            }
            for (k, c) in &t.cells {
                if c.kind == CellKind::Formula && c.value == Value::Error(ErrorKind::Spill) {
                    let me = CellRef::new(t.id, k.row, k.col);
                    if !frontier.contains(&me) {
                        frontier.push(me);
                    }
                }
            }
        }
        let mut all_changed: HashSet<CellRef> = changed.iter().cloned().collect();
        let mut rounds = 0;
        while !frontier.is_empty() && rounds < MAX_SPILL_ROUNDS {
            rounds += 1;
            let next = self.recalc_round(&frontier, ch);
            all_changed.extend(frontier.iter().cloned());
            frontier = next;
        }
        all_changed.extend(frontier.iter().cloned());
        // pivots whose source table changed
        let touched: HashSet<TableId> = all_changed.iter().map(|r| r.table).collect();
        self.recompute_pivots(Some(&touched), ch);
        // filters of touched tables
        let mut refiltered = vec![];
        for t in self.wb.tables.iter_mut() {
            if touched.contains(&t.id) && !t.filters.is_empty() {
                let before = t.hidden_rows.clone();
                t.apply_filters();
                if before != t.hidden_rows {
                    refiltered.push(t.id);
                }
            }
        }
        for id in refiltered {
            ch.push_table(&self.wb, id);
        }
        // code cells reading any changed cell
        let mut reruns = HashSet::new();
        for t in &self.wb.tables {
            for (k, c) in &t.cells {
                if c.is_code() && !c.code_deps.is_empty() {
                    let me = CellRef::new(t.id, k.row, k.col);
                    // a code cell never re-runs because of its own cell or its own spilled output
                    let is_own = |x: &CellRef| {
                        *x == me
                            || (x.table == me.table
                                && t.cells.get(&x.key()).map(|cc| cc.spill_from == Some(*k)).unwrap_or(false))
                    };
                    if rects_hit(&c.code_deps, &all_changed, &is_own) {
                        reruns.insert(me);
                    }
                }
            }
        }
        for r in reruns {
            if !ch.rerun_code.contains(&r) {
                ch.rerun_code.push(r);
            }
        }
    }

    /// One recalculation round: formulas reading `frontier` are re-evaluated; returns the
    /// cells written by spills (which may in turn feed other formulas).
    fn recalc_round(&mut self, frontier: &[CellRef], ch: &mut Changes) -> Vec<CellRef> {
        let all = self.formula_cells();
        let formula_set: HashSet<CellRef> = all.iter().map(|(r, _)| *r).collect();
        let mut dirty: HashSet<CellRef> = HashSet::new();
        for r in frontier {
            if formula_set.contains(r) {
                dirty.insert(*r);
            }
        }
        // iterative closure: formulas reading any changed cell become dirty, and their
        // own cells (plus their current spill areas) count as changed for the next round
        let mut front: HashSet<CellRef> = frontier.iter().cloned().collect();
        while !front.is_empty() {
            let hit = formulas_reading(&all, &front, &dirty);
            front.clear();
            for f in hit {
                if dirty.insert(f) {
                    front.insert(f);
                    if let Some(c) = self.wb.cell(f) {
                        if let Some((sr, sc)) = c.spill_size {
                            for i in 0..sr {
                                for j in 0..sc {
                                    front.insert(CellRef::new(f.table, f.row + i, f.col + j));
                                }
                            }
                        }
                    }
                }
            }
        }
        let dirty_vec: Vec<CellRef> = dirty.into_iter().collect();
        self.evaluate_dirty(&all, &dirty_vec, ch)
    }

    /// Evaluate `dirty` formula cells in dependency order (cycles → #CYCLE!).
    /// Returns cells changed by spills other than the formula cells themselves.
    fn evaluate_dirty(&mut self, all: &[(CellRef, Vec<Rect>)], dirty: &[CellRef], ch: &mut Changes) -> Vec<CellRef> {
        if dirty.is_empty() {
            return vec![];
        }
        let dirty_set: HashSet<CellRef> = dirty.iter().cloned().collect();
        let rects: HashMap<CellRef, &Vec<Rect>> = all.iter().map(|(r, d)| (*r, d)).collect();
        // spill areas of dirty formulas (from their previous evaluation)
        let spill_areas: Vec<(CellRef, Rect)> = dirty
            .iter()
            .filter_map(|f| {
                self.wb.cell(*f).and_then(|c| c.spill_size).map(|(sr, sc)| {
                    (
                        *f,
                        Rect {
                            table: f.table,
                            r0: f.row,
                            c0: f.col,
                            r1: f.row + sr - 1,
                            c1: f.col + sc - 1,
                        },
                    )
                })
            })
            .collect();
        // edges: f -> g when f reads g (both dirty) or reads g's spill area
        let mut edges: HashMap<CellRef, Vec<CellRef>> = HashMap::new();
        for f in dirty {
            let mut precedents: Vec<CellRef> = vec![];
            if let Some(rs) = rects.get(f) {
                let mut seen: HashSet<CellRef> = HashSet::new();
                for rect in rs.iter() {
                    let area = (rect.rows() as u64) * (rect.cols() as u64);
                    if area <= dirty_set.len() as u64 {
                        for r in rect.r0..=rect.r1 {
                            for c in rect.c0..=rect.c1 {
                                let g = CellRef::new(rect.table, r, c);
                                if dirty_set.contains(&g) && seen.insert(g) {
                                    precedents.push(g);
                                }
                            }
                        }
                    } else {
                        for g in dirty {
                            if rect.table == g.table && rect.contains(g.key()) && seen.insert(*g) {
                                precedents.push(*g);
                            }
                        }
                    }
                    for (g, area) in &spill_areas {
                        if g != f && rect.intersects(area) && seen.insert(*g) {
                            precedents.push(*g);
                        }
                    }
                }
            }
            edges.insert(*f, precedents);
        }
        // iterative DFS producing post-order; detect cycles
        let mut state: HashMap<CellRef, u8> = HashMap::new(); // 1 = visiting, 2 = done
        let mut order: Vec<CellRef> = vec![];
        let mut in_cycle: HashSet<CellRef> = HashSet::new();
        let mut sorted: Vec<CellRef> = dirty.to_vec();
        sorted.sort();
        for start in sorted {
            if state.get(&start).copied().unwrap_or(0) == 2 {
                continue;
            }
            let mut stack: Vec<(CellRef, usize)> = vec![(start, 0)];
            state.insert(start, 1);
            while let Some((node, idx)) = stack.last_mut() {
                let node = *node;
                let precedents = &edges[&node];
                if *idx < precedents.len() {
                    let next = precedents[*idx];
                    *idx += 1;
                    match state.get(&next).copied().unwrap_or(0) {
                        0 => {
                            state.insert(next, 1);
                            stack.push((next, 0));
                        }
                        1 => {
                            // back edge: everything on the stack from `next` onwards is a cycle
                            let pos = stack.iter().position(|(n, _)| *n == next).unwrap_or(0);
                            for (n, _) in &stack[pos..] {
                                in_cycle.insert(*n);
                            }
                        }
                        _ => {}
                    }
                } else {
                    state.insert(node, 2);
                    order.push(node);
                    stack.pop();
                }
            }
        }
        let mut extra: Vec<CellRef> = vec![];
        for r in order {
            let result = if in_cycle.contains(&r) {
                Arg::Scalar(Value::Error(ErrorKind::Cycle))
            } else {
                let input = self.wb.cell(r).map(|c| c.input.clone()).unwrap_or_default();
                formula::evaluate_full(&self.wb, r.table, Some(r.key()), formula::formula_body(&input))
            };
            let had_spill = self.wb.cell(r).map(|c| c.spill_size.is_some()).unwrap_or(false);
            match result {
                Arg::Array(a) if a.rows * a.cols > 1 && a.rows * a.cols <= 1_000_000 => {
                    let rows: Vec<Vec<Value>> = (0..a.rows).map(|i| a.row(i)).collect();
                    let removed = self.clear_spill(r);
                    extra.extend(removed.iter().cloned());
                    let mut written = vec![];
                    let grew = self.write_spill(r, Some(&rows), &mut written, |_| false);
                    if grew {
                        ch.push_table(&self.wb, r.table);
                    }
                    extra.extend(written.iter().cloned());
                    for w in written {
                        ch.push_cell(&self.wb, w);
                    }
                }
                other => {
                    let value = other.scalar();
                    if had_spill {
                        let removed = self.clear_spill(r);
                        for w in &removed {
                            ch.push_cell(&self.wb, *w);
                        }
                        extra.extend(removed);
                    }
                    if let Some(t) = self.wb.table_mut(r.table) {
                        if let Some(c) = t.cells.get_mut(&r.key()) {
                            c.value = value;
                            c.spill_size = None;
                        }
                    }
                }
            }
            ch.push_cell(&self.wb, r);
        }
        // cells removed and re-written in the same pass only count once
        let mut seen = HashSet::new();
        extra.retain(|x| seen.insert(*x));
        extra
    }

    // ------------------------------------------------------------------
    // pivots
    // ------------------------------------------------------------------

    /// Recompute pivot outputs (all, or those whose source is in `sources`).
    fn recompute_pivots(&mut self, sources: Option<&HashSet<TableId>>, ch: &mut Changes) {
        let targets: Vec<TableId> = self
            .wb
            .tables
            .iter()
            .filter(|t| t.pivot.as_ref().map(|p| sources.map(|s| s.contains(&p.source)).unwrap_or(true)).unwrap_or(false))
            .map(|t| t.id)
            .collect();
        for id in targets {
            let spec = self.wb.table(id).and_then(|t| t.pivot.clone()).unwrap();
            let output = match self.wb.table(spec.source) {
                Some(src) => crate::pivot::compute(src, &spec),
                None => vec![vec![Value::Error(ErrorKind::Ref)]],
            };
            let t = self.wb.table_mut(id).unwrap();
            // keep formats, replace values
            let mut formats: HashMap<CellKey, Format> = HashMap::new();
            for (k, c) in &t.cells {
                if !c.format.is_default() {
                    formats.insert(*k, c.format.clone());
                }
            }
            t.cells.clear();
            let rows = output.len() as u32;
            let cols = output.iter().map(|r| r.len()).max().unwrap_or(1) as u32;
            t.rows = rows.max(1).min(MAX_ROWS);
            t.cols = cols.max(1).min(MAX_COLS);
            t.header_rows = 1;
            t.normalise_geometry();
            for (i, r) in output.iter().enumerate() {
                for (j, v) in r.iter().enumerate() {
                    if v.is_empty() {
                        continue;
                    }
                    let key = CellKey::new(i as u32, j as u32);
                    t.cells.insert(
                        key,
                        Cell {
                            input: String::new(),
                            kind: CellKind::Value,
                            value: v.clone(),
                            spill_from: Some(CellKey::new(0, 0)),
                            format: formats.remove(&key).unwrap_or_default(),
                            ..Default::default()
                        },
                    );
                }
            }
            for (k, f) in formats {
                if k.row < t.rows && k.col < t.cols {
                    t.cells.insert(
                        k,
                        Cell {
                            format: f,
                            ..Default::default()
                        },
                    );
                }
            }
            ch.push_table(&self.wb, id);
            if !ch.reload.contains(&id) {
                ch.reload.push(id);
            }
            // formulas reading the pivot output must follow
            let cells: Vec<CellRef> = self.wb.table(id).unwrap().cells.keys().map(|k| CellRef::new(id, k.row, k.col)).collect();
            let mut frontier = cells;
            let mut rounds = 0;
            while !frontier.is_empty() && rounds < MAX_SPILL_ROUNDS {
                rounds += 1;
                frontier = self.recalc_round(&frontier, ch);
            }
        }
    }
}

/// Shift conditional-format and validation rectangles after rows/columns were inserted or deleted.
fn shift_rules(t: &mut Table, is_rows: bool, at: u32, count: i64) {
    let shift = |a: &mut u32, b: &mut u32| -> bool {
        let (mut lo, mut hi) = (*a as i64, *b as i64);
        if count > 0 {
            if lo >= at as i64 {
                lo += count;
            }
            if hi >= at as i64 {
                hi += count;
            }
        } else {
            let del = -count;
            let (d0, d1) = (at as i64, at as i64 + del - 1);
            if lo >= d0 && hi <= d1 {
                return false; // fully deleted
            }
            if lo > d1 {
                lo -= del;
            } else if lo >= d0 {
                lo = d0;
            }
            if hi > d1 {
                hi -= del;
            } else if hi >= d0 {
                hi = d0 - 1;
            }
        }
        *a = lo.max(0) as u32;
        *b = hi.max(0) as u32;
        true
    };
    t.cond_formats.retain_mut(|r| if is_rows { shift(&mut r.r0, &mut r.r1) } else { shift(&mut r.c0, &mut r.c1) });
    t.validations.retain_mut(|r| if is_rows { shift(&mut r.r0, &mut r.r1) } else { shift(&mut r.c0, &mut r.c1) });
    t.signoffs.retain_mut(|r| if is_rows { shift(&mut r.r0, &mut r.r1) } else { shift(&mut r.c0, &mut r.c1) });
    t.merges.retain_mut(|m| {
        let keep = if is_rows { shift(&mut m.r0, &mut m.r1) } else { shift(&mut m.c0, &mut m.c1) };
        keep && !(m.r0 == m.r1 && m.c0 == m.c1)
    });
    if !is_rows {
        t.filters.retain_mut(|f| {
            let (mut a, mut b) = (f.col, f.col);
            let keep = shift(&mut a, &mut b);
            f.col = a;
            keep
        });
    }
}

/// Does any rectangle contain a cell of `set` (ignoring cells for which `skip` is true)?
fn rects_hit(rects: &[Rect], set: &HashSet<CellRef>, skip: &dyn Fn(&CellRef) -> bool) -> bool {
    for rect in rects {
        let area = (rect.rows() as u64) * (rect.cols() as u64);
        if area <= set.len() as u64 {
            for r in rect.r0..=rect.r1 {
                for c in rect.c0..=rect.c1 {
                    let g = CellRef::new(rect.table, r, c);
                    if set.contains(&g) && !skip(&g) {
                        return true;
                    }
                }
            }
        } else if set.iter().any(|x| x.table == rect.table && rect.contains(x.key()) && !skip(x)) {
            return true;
        }
    }
    false
}

/// Formulas (not already dirty) that read at least one cell of `frontier`.
fn formulas_reading(all: &[(CellRef, Vec<Rect>)], frontier: &HashSet<CellRef>, dirty: &HashSet<CellRef>) -> Vec<CellRef> {
    let mut out = vec![];
    for (f, rects) in all {
        if dirty.contains(f) {
            continue;
        }
        if rects_hit(rects, frontier, &|_| false) {
            out.push(*f);
        }
    }
    out
}

fn op_kind(op: &Op) -> char {
    match op {
        Op::InsertRows { .. } | Op::DeleteRows { .. } => 'r',
        _ => 'c',
    }
}

pub fn infer_kind(input: &str) -> CellKind {
    if input.trim_start().starts_with('=') && input.trim().len() > 1 {
        CellKind::Formula
    } else {
        CellKind::Value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(e: &mut Engine, t: TableId, r: u32, c: u32, s: &str) -> Changes {
        e.apply(Op::SetCell {
            table: t,
            row: r,
            col: c,
            input: s.into(),
            kind: None,
            conn: None,
            refresh: None,
            runtime: None,
            gpu: None,
        })
    }

    fn val(e: &Engine, t: TableId, r: u32, c: u32) -> Value {
        e.wb.value(CellRef::new(t, r, c))
    }

    fn engine() -> Engine {
        let mut e = Engine::new(Workbook::new("test"));
        e.apply(Op::AddTable {
            id: None,
            name: Some("Data".into()),
            x: 0.0,
            y: 0.0,
            rows: 6,
            cols: 4,
            values: None,
        });
        e
    }

    #[test]
    fn python_cell_runtime_and_gpu_flags() {
        let mut e = engine();
        let ch = e.apply(Op::SetCell {
            table: 1,
            row: 0,
            col: 0,
            input: "q.cells('A2')".into(),
            kind: Some(CellKind::Python),
            conn: None,
            refresh: None,
            runtime: Some("server".into()),
            gpu: Some(true),
        });
        assert_eq!(ch.rerun_code, vec![CellRef::new(1, 0, 0)]);
        let c = e.wb.cell(CellRef::new(1, 0, 0)).unwrap();
        assert_eq!(c.runtime.as_deref(), Some("server"));
        assert_eq!(c.gpu, Some(true));
        let view = CellView::from_cell(CellKey::new(0, 0), Some(c));
        assert_eq!(view.runtime.as_deref(), Some("server"));
        assert_eq!(view.gpu, Some(true));
        // the flags survive a JSON round trip of the workbook
        let json = serde_json::to_string(&e.wb).unwrap();
        let e2 = Engine::new(serde_json::from_str(&json).unwrap());
        assert_eq!(e2.wb.cell(CellRef::new(1, 0, 0)).unwrap().runtime.as_deref(), Some("server"));
        // "browser" (or anything but "server") and gpu=false are stored as absent
        e.apply(Op::SetCell { table: 1, row: 0, col: 0, input: "1".into(), kind: Some(CellKind::Python), conn: None, refresh: None, runtime: Some("browser".into()), gpu: Some(false) });
        let c = e.wb.cell(CellRef::new(1, 0, 0)).unwrap();
        assert_eq!(c.runtime, None);
        assert_eq!(c.gpu, None);
        // turning the cell into a formula clears them
        e.apply(Op::SetCell { table: 1, row: 0, col: 0, input: "=1".into(), kind: None, conn: None, refresh: None, runtime: Some("server".into()), gpu: Some(true) });
        let c = e.wb.cell(CellRef::new(1, 0, 0)).unwrap();
        assert_eq!((c.runtime.clone(), c.gpu), (None, None));
    }

    #[test]
    fn set_and_recalc_chain() {
        let mut e = engine();
        set(&mut e, 1, 0, 0, "10");
        set(&mut e, 1, 1, 0, "=A1*2");
        set(&mut e, 1, 2, 0, "=A2+1");
        assert_eq!(val(&e, 1, 2, 0), Value::Number(21.0));
        let ch = set(&mut e, 1, 0, 0, "5");
        assert_eq!(val(&e, 1, 1, 0), Value::Number(10.0));
        assert_eq!(val(&e, 1, 2, 0), Value::Number(11.0));
        let changed: Vec<(u32, u32)> = ch.cells[&1].iter().map(|c| (c.r, c.c)).collect();
        assert!(changed.contains(&(1, 0)) && changed.contains(&(2, 0)));
    }

    #[test]
    fn cycles_are_flagged_and_recover() {
        let mut e = engine();
        set(&mut e, 1, 0, 0, "=A2");
        set(&mut e, 1, 1, 0, "=A1");
        assert_eq!(val(&e, 1, 0, 0), Value::Error(ErrorKind::Cycle));
        assert_eq!(val(&e, 1, 1, 0), Value::Error(ErrorKind::Cycle));
        set(&mut e, 1, 1, 0, "7");
        assert_eq!(val(&e, 1, 0, 0), Value::Number(7.0));
        set(&mut e, 1, 2, 0, "=A3");
        assert_eq!(val(&e, 1, 2, 0), Value::Error(ErrorKind::Cycle));
    }

    #[test]
    fn cross_table_and_rename() {
        let mut e = engine();
        e.apply(Op::AddTable {
            id: None,
            name: Some("Prices".into()),
            x: 500.0,
            y: 0.0,
            rows: 3,
            cols: 2,
            values: Some(vec![vec!["item".into(), "price".into()], vec!["a".into(), "2.5".into()]]),
        });
        set(&mut e, 1, 0, 0, "=Prices::B2*4");
        assert_eq!(val(&e, 1, 0, 0), Value::Number(10.0));
        set(&mut e, 2, 1, 1, "3");
        assert_eq!(val(&e, 1, 0, 0), Value::Number(12.0));
        // renaming rewrites the formulas that reference the table
        e.apply(Op::RenameTable {
            table: 2,
            name: "Costs".into(),
        });
        assert_eq!(e.wb.cell(CellRef::new(1, 0, 0)).unwrap().input, "=Costs::B2 * 4");
        assert_eq!(val(&e, 1, 0, 0), Value::Number(12.0));
        e.undo();
        assert_eq!(e.wb.cell(CellRef::new(1, 0, 0)).unwrap().input, "=Prices::B2*4");
        assert_eq!(e.wb.table(2).unwrap().name, "Prices");
        // structured reference by header name
        set(&mut e, 1, 1, 0, "=SUM(Prices[price])");
        assert_eq!(val(&e, 1, 1, 0), Value::Number(3.0));
    }

    #[test]
    fn undo_redo_cells_and_structure() {
        let mut e = engine();
        set(&mut e, 1, 0, 0, "1");
        set(&mut e, 1, 0, 0, "2");
        assert_eq!(val(&e, 1, 0, 0), Value::Number(2.0));
        e.undo();
        assert_eq!(val(&e, 1, 0, 0), Value::Number(1.0));
        e.undo();
        assert_eq!(val(&e, 1, 0, 0), Value::Empty);
        e.redo();
        assert_eq!(val(&e, 1, 0, 0), Value::Number(1.0));
        e.apply(Op::ResizeTable {
            table: 1,
            rows: 2,
            cols: 2,
        });
        assert_eq!(e.wb.table(1).unwrap().rows, 2);
        e.undo();
        assert_eq!(e.wb.table(1).unwrap().rows, 6);
        assert_eq!(e.wb.table(1).unwrap().row_heights.len(), 6);
        e.apply(Op::DeleteTable { table: 1 });
        assert!(e.wb.table(1).is_none());
        e.undo();
        assert_eq!(val(&e, 1, 0, 0), Value::Number(1.0));
    }

    #[test]
    fn insert_delete_rows_rewrite_formulas() {
        let mut e = engine();
        set(&mut e, 1, 0, 0, "1");
        set(&mut e, 1, 1, 0, "2");
        set(&mut e, 1, 2, 0, "3");
        set(&mut e, 1, 5, 0, "=SUM(A1:A3)");
        set(&mut e, 1, 5, 1, "=A2");
        e.apply(Op::InsertRows {
            table: 1,
            at: 1,
            count: 2,
        });
        let t = e.wb.table(1).unwrap();
        assert_eq!(t.rows, 8);
        assert_eq!(t.get(CellKey::new(7, 0)).unwrap().input, "=SUM(A1:A5)");
        assert_eq!(t.get(CellKey::new(7, 1)).unwrap().input, "=A4");
        assert_eq!(val(&e, 1, 7, 0), Value::Number(6.0));
        assert_eq!(val(&e, 1, 7, 1), Value::Number(2.0));
        e.apply(Op::DeleteRows {
            table: 1,
            at: 3,
            count: 1,
        }); // deletes the "2"
        let t = e.wb.table(1).unwrap();
        assert_eq!(t.get(CellKey::new(6, 0)).unwrap().input, "=SUM(A1:A4)");
        assert_eq!(t.get(CellKey::new(6, 1)).unwrap().input, "=#REF!");
        assert_eq!(val(&e, 1, 6, 0), Value::Number(4.0));
        assert_eq!(val(&e, 1, 6, 1), Value::Error(ErrorKind::Ref));
        e.undo();
        assert_eq!(val(&e, 1, 7, 1), Value::Number(2.0));
    }

    #[test]
    fn code_cell_spill_and_reruns() {
        let mut e = engine();
        set(&mut e, 1, 0, 0, "5");
        let ch = e.apply(Op::SetCell {
            table: 1,
            row: 0,
            col: 1,
            input: "q.cells('A1')".into(),
            kind: Some(CellKind::Python),
            conn: None,
            refresh: None,
            runtime: None,
            gpu: None,
        });
        assert_eq!(ch.rerun_code, vec![CellRef::new(1, 0, 1)]);
        let ch = e.apply(Op::CodeResult {
            table: 1,
            row: 0,
            col: 1,
            output: Some(vec![
                vec![Value::Number(1.0), Value::Number(2.0)],
                vec![Value::Number(3.0), Value::Number(4.0)],
            ]),
            std_out: None,
            std_err: None,
            deps: vec![Rect {
                table: 1,
                r0: 0,
                c0: 0,
                r1: 0,
                c1: 0,
            }],
        });
        assert!(ch.error.is_none());
        assert_eq!(val(&e, 1, 0, 1), Value::Number(1.0));
        assert_eq!(val(&e, 1, 1, 2), Value::Number(4.0));
        assert_eq!(e.wb.cell(CellRef::new(1, 1, 2)).unwrap().spill_from, Some(CellKey::new(0, 1)));
        // formula on spilled output
        set(&mut e, 1, 3, 0, "=SUM(B1:C2)");
        assert_eq!(val(&e, 1, 3, 0), Value::Number(10.0));
        // editing a spilled cell is refused
        let ch = set(&mut e, 1, 1, 2, "x");
        assert!(ch.error.is_some());
        // dependency change triggers a rerun request
        let ch = set(&mut e, 1, 0, 0, "6");
        assert_eq!(ch.rerun_code, vec![CellRef::new(1, 0, 1)]);
        // new smaller output clears the old spill
        e.apply(Op::CodeResult {
            table: 1,
            row: 0,
            col: 1,
            output: Some(vec![vec![Value::Text("ok".into())]]),
            std_out: Some("hi\n".into()),
            std_err: None,
            deps: vec![],
        });
        assert_eq!(val(&e, 1, 1, 2), Value::Empty);
        assert_eq!(val(&e, 1, 3, 0), Value::Number(0.0));
        // output larger than the table grows it
        e.apply(Op::CodeResult {
            table: 1,
            row: 0,
            col: 1,
            output: Some(vec![vec![Value::Number(1.0); 10]; 12]),
            std_out: None,
            std_err: None,
            deps: vec![],
        });
        let t = e.wb.table(1).unwrap();
        assert_eq!((t.rows, t.cols), (12, 11));
        assert_eq!(t.col_widths.len(), 11);
    }

    #[test]
    fn paste_block_grows_table_and_json_round_trip() {
        let mut e = engine();
        e.apply(Op::SetCells {
            table: 1,
            row: 4,
            col: 2,
            values: vec![vec!["1".into(), "2".into(), "3".into()], vec!["=C5+D5".into(), "x".into(), "".into()]],
        });
        let t = e.wb.table(1).unwrap();
        assert_eq!((t.rows, t.cols), (6, 5));
        assert_eq!(val(&e, 1, 5, 2), Value::Number(3.0));
        let json = serde_json::to_string(&e.wb).unwrap();
        let wb2: Workbook = serde_json::from_str(&json).unwrap();
        let e2 = Engine::new(wb2);
        assert_eq!(val(&e2, 1, 5, 2), Value::Number(3.0));
        assert_eq!(e2.wb.table(1).unwrap().name, "Data");
    }

    #[test]
    fn a_format_alone_does_not_block_a_spill_even_after_a_round_trip() {
        let mut e = engine();
        for (i, v) in ["1", "2", "3", "4"].iter().enumerate() {
            set(&mut e, 1, i as u32, 0, v);
        }
        // the range a formula will spill into is formatted first, as the ageing template does
        e.apply(Op::SetFormat {
            table: 1,
            r0: 0,
            c0: 1,
            r1: 3,
            c1: 1,
            format: Format {
                number_format: Some("#,##0".into()),
                ..Default::default()
            },
        });
        set(&mut e, 1, 0, 1, "=A1:A4*10");
        assert_eq!(val(&e, 1, 3, 1), Value::Number(40.0));
        assert_eq!(e.wb.cell(CellRef::new(1, 3, 1)).unwrap().format.number_format.as_deref(), Some("#,##0"));
        // saved and opened again: the spilled cells come back as formatted empties, and the spill is re-established, not blocked
        let json = serde_json::to_string(&e.wb).unwrap();
        let wb: Workbook = serde_json::from_str(&json).unwrap();
        let e2 = Engine::new(wb);
        assert_eq!(val(&e2, 1, 0, 1), Value::Number(10.0));
        assert_eq!(val(&e2, 1, 3, 1), Value::Number(40.0));
        assert_eq!(e2.wb.cell(CellRef::new(1, 0, 1)).unwrap().spill_size, Some((4, 1)));
        // a value of its own in the way still blocks, and clearing it restores the spill
        let mut e3 = e2;
        assert!(set(&mut e3, 1, 2, 1, "x").error.is_some()); // spilled cells are read-only while the spill stands
        set(&mut e3, 1, 0, 1, "=A1*10");
        set(&mut e3, 1, 2, 1, "x");
        set(&mut e3, 1, 0, 1, "=A1:A4*10");
        assert_eq!(val(&e3, 1, 0, 1), Value::Error(ErrorKind::Spill));
        set(&mut e3, 1, 2, 1, "");
        assert_eq!(val(&e3, 1, 3, 1), Value::Number(40.0));
    }

    #[test]
    fn dynamic_arrays_spill_and_chain() {
        let mut e = engine();
        for (i, v) in ["1", "2", "3", "4"].iter().enumerate() {
            set(&mut e, 1, i as u32, 0, v);
        }
        // =A1:A4*10 spills down column B
        let ch = set(&mut e, 1, 0, 1, "=A1:A4*10");
        assert!(ch.error.is_none());
        assert_eq!(val(&e, 1, 0, 1), Value::Number(10.0));
        assert_eq!(val(&e, 1, 3, 1), Value::Number(40.0));
        assert_eq!(e.wb.cell(CellRef::new(1, 0, 1)).unwrap().spill_size, Some((4, 1)));
        assert_eq!(e.wb.cell(CellRef::new(1, 3, 1)).unwrap().spill_from, Some(CellKey::new(0, 1)));
        // a formula reading the spilled area follows changes in the source data
        set(&mut e, 1, 5, 1, "=SUM(B1:B4)");
        assert_eq!(val(&e, 1, 5, 1), Value::Number(100.0));
        set(&mut e, 1, 0, 0, "11");
        assert_eq!(val(&e, 1, 0, 1), Value::Number(110.0));
        assert_eq!(val(&e, 1, 5, 1), Value::Number(200.0));
        // blocked spill → #SPILL!, unblocking restores it
        let ch = set(&mut e, 1, 2, 1, "x");
        assert!(ch.error.is_some()); // spilled cells are read-only
        set(&mut e, 1, 0, 2, "=TRANSPOSE(A1:A4)");
        assert_eq!(val(&e, 1, 0, 5), Value::Number(4.0));
        assert_eq!(e.wb.table(1).unwrap().cols, 6); // grew to fit
        set(&mut e, 1, 4, 0, "=SEQUENCE(1,2)");
        assert_eq!(val(&e, 1, 4, 1), Value::Number(2.0));
        assert!(set(&mut e, 1, 4, 1, "=1").error.is_some()); // spilled cells are read-only
        // a value placed where a spill wants to go blocks it: #SPILL!, then unblocking restores it
        set(&mut e, 1, 4, 0, "1");
        set(&mut e, 1, 4, 1, "wall");
        set(&mut e, 1, 4, 0, "=SEQUENCE(1,2)");
        assert_eq!(val(&e, 1, 4, 0), Value::Error(ErrorKind::Spill));
        set(&mut e, 1, 4, 1, "");
        assert_eq!(val(&e, 1, 4, 1), Value::Number(2.0));
        // make the source scalar again: spill cleared and readers updated
        set(&mut e, 1, 0, 1, "=A1*10");
        assert_eq!(val(&e, 1, 3, 1), Value::Empty);
        assert_eq!(val(&e, 1, 5, 1), Value::Number(110.0));
        // FILTER with structured reference + dynamic growth
        e.apply(Op::AddTable {
            id: None,
            name: Some("Orders".into()),
            x: 0.0,
            y: 0.0,
            rows: 4,
            cols: 2,
            values: Some(vec![
                vec!["Region".into(), "Amount".into()],
                vec!["N".into(), "10".into()],
                vec!["S".into(), "20".into()],
                vec!["N".into(), "30".into()],
            ]),
        });
        set(&mut e, 1, 5, 3, "=FILTER(Orders[Amount], Orders[Region]=\"N\")");
        assert_eq!(val(&e, 1, 5, 3), Value::Number(10.0));
        assert_eq!(val(&e, 1, 6, 3), Value::Number(30.0));
        set(&mut e, 2, 2, 0, "N");
        assert_eq!(val(&e, 1, 7, 3), Value::Number(30.0));
        assert_eq!(val(&e, 1, 6, 3), Value::Number(20.0));
        // dates typed as text become serials with a date format
        set(&mut e, 1, 5, 0, "2026-10-08");
        assert_eq!(val(&e, 1, 5, 0), Value::Number(46303.0));
        assert_eq!(e.wb.cell(CellRef::new(1, 5, 0)).unwrap().format.number_format.as_deref(), Some("yyyy-mm-dd"));
    }

    #[test]
    fn validation_rules_mark_and_block() {
        let mut e = engine();
        e.apply(Op::SetValidations {
            table: 1,
            rules: vec![
                Validation {
                    r0: 0,
                    c0: 0,
                    r1: 5,
                    c1: 0,
                    kind: "list".into(),
                    op: None,
                    values: vec!["North".into(), "South".into()],
                    allow_blank: true,
                    strict: true,
                    message: None,
                },
                Validation {
                    r0: 0,
                    c0: 1,
                    r1: 5,
                    c1: 1,
                    kind: "number".into(),
                    op: Some("between".into()),
                    values: vec!["0".into(), "100".into()],
                    allow_blank: true,
                    strict: false,
                    message: None,
                },
            ],
        });
        assert!(set(&mut e, 1, 0, 0, "East").error.is_some());
        assert!(set(&mut e, 1, 0, 0, "north").error.is_none());
        let ch = set(&mut e, 1, 0, 1, "250");
        assert!(ch.error.is_none());
        assert!(ch.cells[&1].iter().any(|c| c.r == 0 && c.c == 1 && c.inv));
        assert!(e.wb.cell(CellRef::new(1, 0, 1)).unwrap().invalid);
        set(&mut e, 1, 0, 1, "50");
        assert!(!e.wb.cell(CellRef::new(1, 0, 1)).unwrap().invalid);
        // changing the rules re-marks existing cells
        set(&mut e, 1, 1, 1, "7");
        e.apply(Op::SetValidations {
            table: 1,
            rules: vec![Validation {
                r0: 0,
                c0: 1,
                r1: 5,
                c1: 1,
                kind: "integer".into(),
                op: Some("ge".into()),
                values: vec!["10".into()],
                allow_blank: true,
                strict: false,
                message: Some("at least 10, please".into()),
            }],
        });
        assert!(e.wb.cell(CellRef::new(1, 1, 1)).unwrap().invalid);
        assert!(!e.wb.cell(CellRef::new(1, 0, 1)).unwrap().invalid);
    }

    #[test]
    fn names_filters_and_pivot() {
        let mut e = engine();
        e.apply(Op::AddTable {
            id: None,
            name: Some("Sales".into()),
            x: 0.0,
            y: 0.0,
            rows: 6,
            cols: 3,
            values: Some(vec![
                vec!["Region".into(), "Product".into(), "Amount".into()],
                vec!["North".into(), "A".into(), "10".into()],
                vec!["South".into(), "A".into(), "20".into()],
                vec!["North".into(), "B".into(), "30".into()],
                vec!["South".into(), "B".into(), "40".into()],
                vec!["North".into(), "A".into(), "5".into()],
            ]),
        });
        // names
        let ch = e.apply(Op::SetName {
            name: "Total".into(),
            reference: Some("=Sales[Amount]".into()),
        });
        assert!(ch.error.is_none(), "{:?}", ch.error);
        set(&mut e, 1, 0, 0, "=SUM(Total)");
        assert_eq!(val(&e, 1, 0, 0), Value::Number(105.0));
        let ch = e.apply(Op::SetName {
            name: "A1".into(),
            reference: Some("1".into()),
        });
        assert!(ch.error.is_some());
        // filters hide rows; SUBTOTAL(109) ignores them
        set(&mut e, 1, 1, 0, "=SUBTOTAL(109, Sales::C2:C6)");
        assert_eq!(val(&e, 1, 1, 0), Value::Number(105.0));
        e.apply(Op::SetFilters {
            table: 2,
            filters: vec![ColumnFilter {
                col: 0,
                values: Some(vec!["North".into()]),
                op: None,
                value: None,
            }],
        });
        assert_eq!(e.wb.table(2).unwrap().hidden_rows, vec![2, 4]);
        assert_eq!(val(&e, 1, 1, 0), Value::Number(45.0));
        e.apply(Op::SetFilters { table: 2, filters: vec![] });
        assert_eq!(val(&e, 1, 1, 0), Value::Number(105.0));
        // pivot: Region × Product, sum of Amount
        e.apply(Op::AddTable {
            id: None,
            name: Some("Pivot".into()),
            x: 0.0,
            y: 0.0,
            rows: 2,
            cols: 2,
            values: None,
        });
        let ch = e.apply(Op::SetPivot {
            table: 3,
            spec: Some(PivotSpec {
                source: 2,
                rows: vec!["Region".into()],
                cols: vec!["Product".into()],
                values: vec![PivotValue {
                    field: "Amount".into(),
                    agg: "sum".into(),
                }],
                filters: vec![],
                totals: true,
            }),
        });
        assert!(ch.error.is_none(), "{:?}", ch.error);
        let p = e.wb.table(3).unwrap();
        // header: Region | A | B | Total ; rows North, South, Total
        assert_eq!(p.value_at(CellKey::new(0, 0)), Value::Text("Region".into()));
        assert_eq!(p.value_at(CellKey::new(0, 1)), Value::Text("A".into()));
        assert_eq!(p.value_at(CellKey::new(1, 0)), Value::Text("North".into()));
        assert_eq!(p.value_at(CellKey::new(1, 1)), Value::Number(15.0));
        assert_eq!(p.value_at(CellKey::new(1, 2)), Value::Number(30.0));
        assert_eq!(p.value_at(CellKey::new(1, 3)), Value::Number(45.0));
        assert_eq!(p.value_at(CellKey::new(3, 3)), Value::Number(105.0));
        // pivot output is read-only and follows the source
        assert!(set(&mut e, 3, 1, 1, "9").error.is_some());
        set(&mut e, 1, 2, 0, "=Pivot::D4");
        assert_eq!(val(&e, 1, 2, 0), Value::Number(105.0));
        set(&mut e, 2, 1, 2, "110");
        assert_eq!(e.wb.table(3).unwrap().value_at(CellKey::new(1, 1)), Value::Number(115.0));
        assert_eq!(val(&e, 1, 2, 0), Value::Number(205.0));
        // round trip keeps the pivot
        let json = serde_json::to_string(&e.wb).unwrap();
        let e2 = Engine::new(serde_json::from_str(&json).unwrap());
        assert_eq!(e2.wb.table(3).unwrap().value_at(CellKey::new(3, 3)), Value::Number(205.0));
        assert_eq!(e2.wb.names.len(), 1);
    }

    #[test]
    fn signoffs_lock_and_go_stale() {
        let mut e = engine();
        set(&mut e, 1, 0, 0, "100");
        set(&mut e, 1, 1, 0, "=A1*2");
        let ch = e.apply(Op::AddSignoff {
            table: 1,
            r0: 0,
            c0: 0,
            r1: 1,
            c1: 0,
            by: "Nuno".into(),
            login: "nuno@example.com".into(),
            at: "2026-10-09T10:00:00Z".into(),
            note: "Q3 close".into(),
            locked: true,
        });
        assert!(ch.error.is_none(), "{:?}", ch.error);
        let meta = &ch.tables[0];
        assert_eq!(meta.signoffs.len(), 1);
        let id = meta.signoffs[0].id;
        assert!(!e.signoff_status(1)[0].stale);
        // locked: manual edits are refused, formulas elsewhere still work
        let ch = set(&mut e, 1, 0, 0, "5");
        assert!(ch.error.as_deref().unwrap_or("").starts_with("locked"), "{:?}", ch.error);
        assert_eq!(val(&e, 1, 0, 0), Value::Number(100.0));
        let ch = e.apply(Op::ClearRange { table: 1, r0: 0, c0: 0, r1: 3, c1: 3 });
        assert!(ch.error.is_some());
        let ch = e.apply(Op::DeleteRows { table: 1, at: 1, count: 1 });
        assert!(ch.error.is_some());
        // unlocking allows the edit and the sign-off becomes stale
        e.apply(Op::SetSignoffLocked { table: 1, id, locked: false });
        let ch = set(&mut e, 1, 0, 0, "5");
        assert!(ch.error.is_none());
        assert!(e.signoff_status(1)[0].stale);
        // the same value again → not stale (hash is on values)
        set(&mut e, 1, 0, 0, "100");
        assert!(!e.signoff_status(1)[0].stale);
        // inserting rows above shifts the range and keeps the hash valid
        e.apply(Op::InsertRows { table: 1, at: 0, count: 2 });
        let t = e.wb.table(1).unwrap();
        assert_eq!((t.signoffs[0].r0, t.signoffs[0].r1), (2, 3));
        assert!(!e.signoff_status(1)[0].stale);
        // undo returns restore ops for the other clients
        let ch = e.undo();
        assert_eq!(ch.ops.len(), 1);
        assert!(matches!(ch.ops[0], Op::RestoreTables { .. }));
        let t = e.wb.table(1).unwrap();
        assert_eq!((t.signoffs[0].r0, t.signoffs[0].r1), (0, 1));
        e.apply(Op::RemoveSignoff { table: 1, id });
        assert!(e.wb.table(1).unwrap().signoffs.is_empty());
    }

    #[test]
    fn merges_keep_top_left_and_shift() {
        let mut e = engine();
        set(&mut e, 1, 0, 0, "Title");
        set(&mut e, 1, 0, 1, "gone");
        set(&mut e, 1, 2, 0, "=A1&\"!\"");
        let ch = e.apply(Op::MergeCells { table: 1, r0: 0, c0: 0, r1: 1, c1: 2 });
        assert!(ch.error.is_none(), "{:?}", ch.error);
        assert_eq!(e.wb.table(1).unwrap().merges.len(), 1);
        assert_eq!(val(&e, 1, 0, 1), Value::Empty);
        assert_eq!(val(&e, 1, 2, 0), Value::Text("Title!".into()));
        let ch = set(&mut e, 1, 1, 1, "x");
        assert!(ch.error.is_some());
        e.apply(Op::InsertCols { table: 1, at: 0, count: 1 });
        let m = e.wb.table(1).unwrap().merges[0];
        assert_eq!((m.c0, m.c1), (1, 3));
        e.apply(Op::UnmergeCells { table: 1, r0: 1, c0: 2, r1: 1, c1: 2 });
        assert!(e.wb.table(1).unwrap().merges.is_empty());
        e.undo();
        assert_eq!(e.wb.table(1).unwrap().merges.len(), 1);
    }

    #[test]
    fn charts_are_workbook_objects() {
        let mut e = engine();
        let ch = e.apply(Op::AddChart {
            chart: Chart {
                kind: "bar".into(),
                title: "Revenue grew 12% in Q3".into(),
                categories: "Data::A1:A5".into(),
                series: vec![ChartSeries {
                    name: "Revenue".into(),
                    range: "Data::B1:B5".into(),
                    color: None,
                }],
                ..Default::default()
            },
        });
        assert!(ch.error.is_none());
        assert_eq!(ch.created_chart, Some(1));
        assert_eq!(ch.charts.as_ref().unwrap().len(), 1);
        assert_eq!(e.wb.charts[0].w, 560.0);
        let mut c = e.wb.charts[0].clone();
        c.title = "Changed".into();
        e.apply(Op::UpdateChart { chart: c });
        assert_eq!(e.wb.charts[0].title, "Changed");
        let ch = e.undo();
        assert!(matches!(ch.ops[0], Op::RestoreCharts { .. }));
        assert_eq!(e.wb.charts[0].title, "Revenue grew 12% in Q3");
        e.apply(Op::DeleteChart { id: 1 });
        assert!(e.wb.charts.is_empty());
        // a second chart gets a fresh id even after the first was deleted
        let ch = e.apply(Op::AddChart { chart: Chart::default() });
        assert_eq!(ch.created_chart, Some(2));
        let json = serde_json::to_string(&e.wb).unwrap();
        let wb: Workbook = serde_json::from_str(&json).unwrap();
        assert_eq!(wb.charts.len(), 1);
        // chart ranges follow inserts, deletes and renames like formulas do
        e.apply(Op::UpdateChart {
            chart: Chart {
                id: 2,
                categories: "Data::A2:A5".into(),
                series: vec![ChartSeries {
                    name: "v".into(),
                    range: "Data[Units]".into(),
                    color: None,
                }],
                ..e.wb.charts[0].clone()
            },
        });
        let ch = e.apply(Op::InsertRows { table: 1, at: 0, count: 2 });
        assert!(ch.charts.is_some());
        assert_eq!(e.wb.charts[0].categories, "Data::A4:A7");
        e.apply(Op::RenameTable { table: 1, name: "Facts".into() });
        assert_eq!(e.wb.charts[0].categories, "Facts::A4:A7");
        assert_eq!(e.wb.charts[0].series[0].range, "Facts[Units]");
        e.apply(Op::DeleteRows { table: 1, at: 0, count: 1 });
        assert_eq!(e.wb.charts[0].categories, "Facts::A3:A6");
    }

    #[test]
    fn remote_ops_skip_undo_and_transform_the_stack() {
        let mut e = engine();
        set(&mut e, 1, 3, 0, "1");
        set(&mut e, 1, 3, 0, "2"); // undo entry points at row 3
        // another client inserts two rows above: our undo entry must now point at row 5
        let ch = e.apply_remote(Op::InsertRows { table: 1, at: 0, count: 2 });
        assert!(ch.error.is_none());
        assert_eq!(val(&e, 1, 5, 0), Value::Number(2.0));
        assert!(e.can_undo());
        let ch = e.undo();
        assert_eq!(val(&e, 1, 5, 0), Value::Number(1.0));
        match &ch.ops[0] {
            Op::RestoreCells { cells } => assert_eq!((cells[0].row, cells[0].col), (5, 0)),
            other => panic!("unexpected {:?}", other),
        }
        // a remote cell edit is not undoable locally
        let before = e.undo.len();
        e.apply_remote(Op::SetCell {
            table: 1,
            row: 0,
            col: 0,
            input: "9".into(),
            kind: None,
            conn: None,
            refresh: None,
            runtime: None,
            gpu: None,
        });
        assert_eq!(e.undo.len(), before);
        // restore ops from another client's undo apply like any op
        let ch = e.apply_remote(Op::RestoreCells {
            cells: vec![RestoredCell { table: 1, row: 0, col: 0, cell: None }],
        });
        assert!(ch.error.is_none());
        assert_eq!(val(&e, 1, 0, 0), Value::Empty);
    }

    #[test]
    fn checks_fx_reconcile_ageing_and_trace() {
        let mut e = engine();
        e.wb.now_serial = crate::formula::eval::serial_from_ymd(2026, 10, 9);
        e.apply(Op::AddTable {
            id: None,
            name: Some("FX".into()),
            x: 0.0,
            y: 0.0,
            rows: 5,
            cols: 4,
            values: Some(vec![
                vec!["Date".into(), "From".into(), "To".into(), "Rate".into()],
                vec!["2026-01-01".into(), "USD".into(), "AOA".into(), "900".into()],
                vec!["2026-09-01".into(), "USD".into(), "AOA".into(), "920".into()],
                vec!["2026-09-01".into(), "EUR".into(), "USD".into(), "1.1".into()],
                vec!["2026-12-01".into(), "USD".into(), "AOA".into(), "950".into()],
            ]),
        });
        set(&mut e, 1, 0, 0, "=FX(10, \"USD\", \"AOA\")");
        assert_eq!(val(&e, 1, 0, 0), Value::Number(9200.0));
        set(&mut e, 1, 0, 1, "=FX(9200, \"AOA\", \"USD\")");
        assert_eq!(val(&e, 1, 0, 1), Value::Number(10.0));
        set(&mut e, 1, 0, 2, "=ROUND(FX(1, \"EUR\", \"AOA\"), 2)"); // triangulated: 1.1 * 920
        assert_eq!(val(&e, 1, 0, 2), Value::Number(1012.0));
        set(&mut e, 1, 0, 3, "=FX(10, \"USD\", \"AOA\", DATE(2026,3,1))");
        assert_eq!(val(&e, 1, 0, 3), Value::Number(9000.0));
        // rates changing recalculates FX() cells
        set(&mut e, 2, 2, 3, "1000");
        assert_eq!(val(&e, 1, 0, 0), Value::Number(10000.0));
        // CHECK cells are collected with labels and outcomes
        set(&mut e, 1, 1, 0, "=CHECK(A1=10000, \"FX applied\")");
        set(&mut e, 1, 1, 1, "=CHECK(B1>100, \"B1 big\")");
        let checks = e.checks();
        assert_eq!(checks.len(), 2);
        assert!(checks[0].ok && checks[0].label == "FX applied");
        assert!(!checks[1].ok && checks[1].label == "B1 big");
        // trace: precedents of the FX cell include the FX table; dependents of FX!D3 include it
        let tr = e.trace(CellRef::new(1, 0, 0));
        assert!(tr.precedents.iter().any(|r| r.table == 2));
        let tr = e.trace(CellRef::new(2, 2, 3));
        assert!(tr.dependents.contains(&CellRef::new(1, 0, 0)));
        // RECONCILE spills Key | A | B | Difference | Status
        e.apply(Op::AddTable {
            id: None,
            name: Some("Rec".into()),
            x: 0.0,
            y: 0.0,
            rows: 12,
            cols: 10,
            values: Some(vec![
                vec!["INV1".into(), "100".into(), "INV1".into(), "100".into()],
                vec!["INV2".into(), "250".into(), "INV3".into(), "75".into()],
                vec!["INV3".into(), "75.004".into(), "INV4".into(), "10".into()],
            ]),
        });
        set(&mut e, 3, 4, 0, "=RECONCILE(A1:B3, C1:D3)");
        assert_eq!(val(&e, 3, 4, 0), Value::Text("Key".into()));
        assert_eq!(val(&e, 3, 5, 0), Value::Text("INV1".into()));
        assert_eq!(val(&e, 3, 5, 4), Value::Text("Matched".into()));
        assert_eq!(val(&e, 3, 6, 4), Value::Text("Only in A".into()));
        assert_eq!(val(&e, 3, 7, 4), Value::Text("Matched".into())); // within tolerance
        assert_eq!(val(&e, 3, 8, 4), Value::Text("Only in B".into()));
        set(&mut e, 3, 4, 6, "=RECONCILE(A1:B3, C1:D3, 0)");
        assert_eq!(val(&e, 3, 7, 10), Value::Text("Difference".into()));
        // AGEING buckets by days outstanding
        e.apply(Op::AddTable {
            id: None,
            name: Some("AP".into()),
            x: 0.0,
            y: 0.0,
            rows: 12,
            cols: 8,
            values: Some(vec![
                vec!["Due".into(), "Amount".into()],
                vec!["2026-10-01".into(), "100".into()],
                vec!["2026-08-20".into(), "200".into()],
                vec!["2026-05-01".into(), "300".into()],
                vec!["2026-11-01".into(), "50".into()],
            ]),
        });
        set(&mut e, 4, 0, 3, "=AGEING(A2:A5, B2:B5)");
        assert_eq!(val(&e, 4, 0, 3), Value::Text("Bucket".into()));
        assert_eq!(val(&e, 4, 1, 3), Value::Text("Not due".into()));
        assert_eq!(val(&e, 4, 1, 5), Value::Number(50.0));
        assert_eq!(val(&e, 4, 2, 3), Value::Text("0-30".into()));
        assert_eq!(val(&e, 4, 2, 5), Value::Number(100.0));
        assert_eq!(val(&e, 4, 3, 3), Value::Text("31-60".into()));
        assert_eq!(val(&e, 4, 3, 5), Value::Number(200.0));
        assert_eq!(val(&e, 4, 5, 3), Value::Text("91+".into()));
        assert_eq!(val(&e, 4, 5, 5), Value::Number(300.0));
        assert_eq!(val(&e, 4, 6, 3), Value::Text("Total".into()));
        assert_eq!(val(&e, 4, 6, 5), Value::Number(650.0));
        set(&mut e, 4, 0, 2, "=AGE_BUCKET(A2:A5)");
        assert_eq!(val(&e, 4, 2, 2), Value::Text("91+".into()));
        assert_eq!(val(&e, 4, 3, 2), Value::Text("Not due".into()));
    }
}
