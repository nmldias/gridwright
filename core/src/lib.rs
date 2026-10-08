//! Gridwright core: a spreadsheet engine with free-floating tables, a formula
//! language with cross-table references, dependency-driven recalculation,
//! code-cell spill handling and undo/redo. Exposed to JavaScript through
//! wasm-bindgen as the `Book` class; all payloads cross the boundary as JSON.

pub mod engine;
pub mod formula;
pub mod model;

pub use engine::{Changes, Engine, Op};
pub use model::{Cell, CellKind, CellRef, Table, Value, Workbook};

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Book {
    engine: Engine,
}

fn js<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| format!("{{\"error\":{:?}}}", e.to_string()))
}

#[wasm_bindgen]
impl Book {
    /// Empty workbook with a single table.
    #[wasm_bindgen(constructor)]
    pub fn new(name: &str) -> Book {
        let mut engine = Engine::new(Workbook::new(name));
        engine.apply(Op::AddTable {
            id: None,
            name: Some("Table 1".into()),
            x: 80.0,
            y: 80.0,
            rows: 20,
            cols: 8,
            values: None,
        });
        Book { engine }
    }

    pub fn from_json(json: &str) -> Result<Book, JsValue> {
        let wb: Workbook = serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Book {
            engine: Engine::new(wb),
        })
    }

    pub fn to_json(&self) -> String {
        js(&self.engine.wb)
    }

    pub fn name(&self) -> String {
        self.engine.wb.name.clone()
    }

    pub fn set_name(&mut self, name: &str) {
        self.engine.wb.name = name.to_string();
    }

    /// Serial date-time for NOW()/TODAY() (days since 1899-12-30, UTC).
    pub fn set_now(&mut self, serial: f64) {
        self.engine.wb.now_serial = serial;
    }

    /// Apply an operation (JSON `Op`); returns JSON `Changes`.
    pub fn apply(&mut self, op_json: &str) -> String {
        match serde_json::from_str::<Op>(op_json) {
            Ok(op) => js(&self.engine.apply(op)),
            Err(e) => format!("{{\"error\":{:?},\"cells\":{{}},\"tables\":[],\"reload\":[],\"removed_tables\":[],\"rerun_code\":[],\"created\":[]}}", format!("bad op: {}", e)),
        }
    }

    pub fn undo(&mut self) -> String {
        js(&self.engine.undo())
    }

    pub fn redo(&mut self) -> String {
        js(&self.engine.redo())
    }

    pub fn can_undo(&self) -> bool {
        self.engine.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.engine.can_redo()
    }

    /// JSON array of table metadata.
    pub fn tables(&self) -> String {
        js(&self.engine.table_metas())
    }

    /// JSON array of non-empty cells of a table.
    pub fn cells(&self, table: u32) -> String {
        js(&self.engine.table_cells(table))
    }

    pub fn cell(&self, table: u32, row: u32, col: u32) -> String {
        let r = CellRef::new(table, row, col);
        js(&engine::CellView::from_cell(r.key(), self.engine.wb.cell(r)))
    }

    /// 2-D JSON array of plain values (numbers, strings, booleans, null, {"e":..}).
    pub fn range_values(&self, table: u32, r0: u32, c0: u32, r1: u32, c1: u32) -> String {
        let rows = self.engine.range_values(table, r0, c0, r1, c1);
        let plain: Vec<Vec<serde_json::Value>> = rows
            .into_iter()
            .map(|r| {
                r.into_iter()
                    .map(|v| match v {
                        Value::Empty => serde_json::Value::Null,
                        Value::Number(n) => serde_json::json!(n),
                        Value::Text(s) => serde_json::Value::String(s),
                        Value::Bool(b) => serde_json::Value::Bool(b),
                        Value::Error(e) => serde_json::json!({ "e": e.as_str() }),
                    })
                    .collect()
            })
            .collect();
        js(&plain)
    }

    /// Evaluate a formula body (without `=`) in the context of a table; JSON value.
    pub fn preview(&self, table: u32, formula: &str) -> String {
        js(&formula::evaluate(&self.engine.wb, table, None, formula::formula_body(formula)))
    }

    /// Shift relative references of a formula body copied by (dr, dc).
    pub fn shift_formula(src: &str, dr: i32, dc: i32) -> String {
        let body = formula::formula_body(src);
        let shifted = formula::shift_relative(body, dr as i64, dc as i64);
        if src.trim_start().starts_with('=') {
            format!("={}", shifted)
        } else {
            shifted
        }
    }

    /// Table id by name (0 when not found).
    pub fn table_id(&self, name: &str) -> u32 {
        self.engine.wb.table_by_name(name).map(|t| t.id).unwrap_or(0)
    }

    pub fn version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}
