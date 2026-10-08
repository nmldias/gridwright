//! Operations, recalculation and undo/redo on top of the model.

use crate::formula;
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
            if !self.tables.iter().any(|m| m.id == id) {
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
}

pub struct Engine {
    pub wb: Workbook,
    undo: Vec<Inverse>,
    redo: Vec<Inverse>,
}

const MAX_UNDO: usize = 200;
const MAX_ROWS: u32 = 1_000_000;
const MAX_COLS: u32 = 10_000;

impl Engine {
    pub fn new(wb: Workbook) -> Engine {
        let mut e = Engine {
            wb,
            undo: vec![],
            redo: vec![],
        };
        e.recalc_all();
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

    fn apply_inner(&mut self, op: Op, ch: &mut Changes) -> Result<Option<Inverse>, String> {
        match op {
            Op::SetCell {
                table,
                row,
                col,
                input,
                kind,
            } => {
                let key = CellKey::new(row, col);
                let t = self.wb.table(table).ok_or("no such table")?;
                if !t.in_bounds(key) {
                    return Err("cell outside table".into());
                }
                if let Some(c) = t.get(key) {
                    if c.spill_from.is_some() {
                        return Err("cell holds spilled output; edit the source cell".into());
                    }
                }
                let kind = kind.unwrap_or_else(|| infer_kind(&input));
                let mut prev = vec![];
                let origin = CellRef::new(table, row, col);
                self.snapshot_spill(origin, &mut prev);
                prev.push((origin, self.wb.cell(origin).cloned()));
                let mut changed = self.clear_spill(origin);
                {
                    let t = self.wb.table_mut(table).unwrap();
                    let entry = t.cells.entry(key).or_default();
                    entry.input = input.clone();
                    entry.kind = kind;
                    entry.spill_size = None;
                    entry.std_err = None;
                    entry.std_out = None;
                    entry.code_deps.clear();
                    match kind {
                        CellKind::Value => entry.value = Value::parse_literal(&input),
                        CellKind::Formula => entry.value = Value::Empty, // computed below
                        CellKind::Python | CellKind::Javascript => entry.value = Value::Empty,
                    }
                    if entry.is_blank() {
                        t.cells.remove(&key);
                    }
                }
                changed.push(origin);
                self.recalc_from(&changed, ch);
                if matches!(kind, CellKind::Python | CellKind::Javascript) && !input.trim().is_empty() {
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
                let need_rows = row + values.len() as u32;
                let need_cols = col + values.iter().map(|r| r.len()).max().unwrap_or(0) as u32;
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
                        prev.push((origin, t.cells.get(&key).cloned()));
                        let kind = infer_kind(s);
                        let entry = t.cells.entry(key).or_default();
                        entry.input = s.clone();
                        entry.kind = kind;
                        entry.spill_size = None;
                        entry.std_err = None;
                        entry.std_out = None;
                        entry.code_deps.clear();
                        entry.value = match kind {
                            CellKind::Value => Value::parse_literal(s),
                            _ => Value::Empty,
                        };
                        if entry.is_blank() {
                            t.cells.remove(&key);
                        }
                        changed.push(origin);
                    }
                }
                self.recalc_from(&changed, ch);
                if grew {
                    Ok(Some(Inverse::Tables(prev_tables)))
                } else {
                    Ok(Some(Inverse::Cells(prev)))
                }
            }
            Op::ClearRange { table, r0, c0, r1, c1 } => {
                self.wb.table(table).ok_or("no such table")?;
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
                let t = self.wb.table_mut(table).ok_or("no such table")?;
                let prev = t.clone();
                t.name = name;
                ch.push_table(&self.wb, table);
                self.recalc_all_into(ch);
                Ok(Some(Inverse::Tables(vec![(table, Some(prev))])))
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
                ch.push_table(&self.wb, table);
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
                t.normalise_geometry();
                self.rewrite_formulas(table, &name, is_rows, at, count as i64);
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
                t.normalise_geometry();
                self.rewrite_formulas(table, &name, is_rows, at, -(count as i64));
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
                            t.cells.insert(
                                CellKey::new(i as u32, j as u32),
                                Cell {
                                    input: s.clone(),
                                    kind,
                                    value: if kind == CellKind::Value { Value::parse_literal(s) } else { Value::Empty },
                                    ..Default::default()
                                },
                            );
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
                let mut grew = false;
                {
                    let (out_rows, out_cols) = match &output {
                        Some(v) => (v.len() as u32, v.iter().map(|r| r.len()).max().unwrap_or(0) as u32),
                        None => (0, 0),
                    };
                    let t = self.wb.table_mut(table).unwrap();
                    if row + out_rows > t.rows || col + out_cols > t.cols {
                        t.rows = t.rows.max(row + out_rows).min(MAX_ROWS);
                        t.cols = t.cols.max(col + out_cols).min(MAX_COLS);
                        t.normalise_geometry();
                        grew = true;
                    }
                    // blocked?
                    let mut blocked = false;
                    if out_rows * out_cols > 1 {
                        for i in 0..out_rows {
                            for j in 0..out_cols {
                                if i == 0 && j == 0 {
                                    continue;
                                }
                                if let Some(c) = t.cells.get(&CellKey::new(row + i, col + j)) {
                                    if !c.is_blank() && c.spill_from != Some(CellKey::new(row, col)) {
                                        blocked = true;
                                    }
                                }
                            }
                        }
                    }
                    let entry = t.cells.get_mut(&CellKey::new(row, col)).unwrap();
                    entry.std_out = std_out.filter(|s| !s.is_empty());
                    entry.std_err = std_err.filter(|s| !s.is_empty());
                    entry.code_deps = deps;
                    entry.spill_size = None;
                    if entry.std_err.is_some() && output.is_none() {
                        entry.value = Value::Error(ErrorKind::Other);
                    } else if blocked {
                        entry.value = Value::Error(ErrorKind::Spill);
                    } else {
                        match &output {
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
                    }
                }
                changed.push(origin);
                if grew {
                    ch.push_table(&self.wb, table);
                }
                self.recalc_from(&changed, ch);
                // results are derived state: not undoable on their own
                Ok(None)
            }
        }
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
        match inv {
            Inverse::Cells(cells) => {
                let mut counter = vec![];
                let mut changed = vec![];
                for (r, cell) in cells {
                    counter.push((r, self.wb.cell(r).cloned()));
                    if let Some(t) = self.wb.table_mut(r.table) {
                        match cell {
                            Some(c) => {
                                t.cells.insert(r.key(), c);
                            }
                            None => {
                                t.cells.remove(&r.key());
                            }
                        }
                    }
                    changed.push(r);
                }
                self.recalc_from(&changed, &mut ch);
                // code cells restored with inputs must be re-run to rebuild outputs
                for r in &changed {
                    if let Some(c) = self.wb.cell(*r) {
                        if c.is_code() && c.spill_from.is_none() {
                            ch.rerun_code.push(*r);
                        }
                    }
                }
                (Inverse::Cells(counter), ch)
            }
            Inverse::Tables(tables) => {
                let mut counter = vec![];
                for (id, table) in tables {
                    counter.push((id, self.wb.table(id).cloned()));
                    let pos = self.wb.tables.iter().position(|t| t.id == id);
                    match (table, pos) {
                        (Some(t), Some(p)) => self.wb.tables[p] = t,
                        (Some(t), None) => self.wb.tables.push(t),
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
                self.recalc_all_into(&mut ch);
                (Inverse::Tables(counter), ch)
            }
        }
    }

    // ------------------------------------------------------------------
    // recalculation
    // ------------------------------------------------------------------

    fn formula_cells(&self) -> Vec<(CellRef, Vec<Rect>)> {
        let mut out = vec![];
        for t in &self.wb.tables {
            for (k, c) in &t.cells {
                if c.kind == CellKind::Formula {
                    let deps = formula::dependencies(&self.wb, t.id, formula::formula_body(&c.input));
                    out.push((CellRef::new(t.id, k.row, k.col), deps));
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
        let all = self.formula_cells();
        let dirty: Vec<CellRef> = all.iter().map(|(r, _)| *r).collect();
        self.evaluate_dirty(&all, &dirty, ch);
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
        let all = self.formula_cells();
        let formula_set: HashSet<CellRef> = all.iter().map(|(r, _)| *r).collect();
        let mut dirty: HashSet<CellRef> = HashSet::new();
        // formulas among the changed cells are dirty themselves
        for r in changed {
            if formula_set.contains(r) {
                dirty.insert(*r);
            }
        }
        // iterative closure: formulas reading any changed cell become dirty, and their
        // own cells count as changed for the next round
        let mut frontier: HashSet<CellRef> = changed.iter().cloned().collect();
        while !frontier.is_empty() {
            let hit = formulas_reading(&all, &frontier, &dirty);
            frontier.clear();
            for f in hit {
                if dirty.insert(f) {
                    frontier.insert(f);
                }
            }
        }
        let dirty_vec: Vec<CellRef> = dirty.into_iter().collect();
        self.evaluate_dirty(&all, &dirty_vec, ch);
        // code cells reading any changed cell
        let mut all_changed: HashSet<CellRef> = changed.iter().cloned().collect();
        all_changed.extend(dirty_vec.iter().cloned());
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

    /// Evaluate `dirty` formula cells in dependency order (cycles → #CYCLE!).
    fn evaluate_dirty(&mut self, all: &[(CellRef, Vec<Rect>)], dirty: &[CellRef], ch: &mut Changes) {
        if dirty.is_empty() {
            return;
        }
        let dirty_set: HashSet<CellRef> = dirty.iter().cloned().collect();
        let rects: HashMap<CellRef, &Vec<Rect>> = all.iter().map(|(r, d)| (*r, d)).collect();
        // edges: f -> g when f reads g (both dirty)
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
        for r in order {
            let value = if in_cycle.contains(&r) {
                Value::Error(ErrorKind::Cycle)
            } else {
                let input = self.wb.cell(r).map(|c| c.input.clone()).unwrap_or_default();
                formula::evaluate(&self.wb, r.table, Some(r.key()), formula::formula_body(&input))
            };
            if let Some(t) = self.wb.table_mut(r.table) {
                if let Some(c) = t.cells.get_mut(&r.key()) {
                    c.value = value;
                }
            }
            ch.push_cell(&self.wb, r);
        }
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
        e.apply(Op::RenameTable {
            table: 2,
            name: "Costs".into(),
        });
        assert_eq!(val(&e, 1, 0, 0), Value::Error(ErrorKind::Ref));
        e.apply(Op::RenameTable {
            table: 2,
            name: "Prices".into(),
        });
        assert_eq!(val(&e, 1, 0, 0), Value::Number(12.0));
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
}
