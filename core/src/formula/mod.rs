//! Formula language: `=SUM(A1:B3) + 'Table 1'::C2 * 10%`.

pub mod eval;
pub mod lexer;
pub mod parser;

pub use eval::{collect_deps, eval, resolve_ref, Arg, Array, Ctx};
pub use parser::{parse, to_string, Expr, ParseError, RefExpr, RefKind};

use crate::model::{CellKey, ErrorKind, Rect, TableId, Value, Workbook};

/// Parse (without the leading `=`) and evaluate a formula for the cell `at` in `table`.
pub fn evaluate(wb: &Workbook, table: TableId, at: Option<CellKey>, src: &str) -> Value {
    match parse(src) {
        Ok(expr) => {
            let ctx = Ctx {
                wb,
                table,
                now: wb.now_serial,
                at,
            };
            match eval(&expr, &ctx) {
                Arg::Scalar(v) => v,
                Arg::Array(a) => {
                    // a formula returning an array shows its first element (no dynamic arrays yet)
                    a.data.into_iter().next().unwrap_or(Value::Empty)
                }
            }
        }
        Err(_) => Value::Error(ErrorKind::Name),
    }
}

/// Rectangles a formula depends on (empty when it does not parse).
pub fn dependencies(wb: &Workbook, table: TableId, src: &str) -> Vec<Rect> {
    match parse(src) {
        Ok(expr) => collect_deps(&expr, wb, table),
        Err(_) => vec![],
    }
}

/// Strip the leading `=` from a cell input.
pub fn formula_body(input: &str) -> &str {
    input.trim_start().strip_prefix('=').unwrap_or(input)
}

/// Shift relative references when a formula is copied by (dr, dc) cells.
pub fn shift_relative(src: &str, dr: i64, dc: i64) -> String {
    let mut expr = match parse(src) {
        Ok(e) => e,
        Err(_) => return src.to_string(),
    };
    parser::for_each_ref_mut(&mut expr, &mut |r| match &mut r.kind {
        RefKind::Cell {
            row,
            col,
            abs_row,
            abs_col,
        } => {
            if !*abs_row {
                *row = (*row as i64 + dr).max(0) as u32;
            }
            if !*abs_col {
                *col = (*col as i64 + dc).max(0) as u32;
            }
        }
        RefKind::Range { r0, c0, r1, c1, abs } => {
            if !abs[0] {
                *r0 = (*r0 as i64 + dr).max(0) as u32;
            }
            if !abs[1] {
                *c0 = (*c0 as i64 + dc).max(0) as u32;
            }
            if !abs[2] {
                *r1 = (*r1 as i64 + dr).max(0) as u32;
            }
            if !abs[3] {
                *c1 = (*c1 as i64 + dc).max(0) as u32;
            }
        }
        _ => {}
    });
    to_string(&expr)
}

/// Shift only the references that point at `src_row` (single cells and ranges
/// confined to that row) by `dr`; used when rows are reordered (sorting).
pub fn shift_same_row(src: &str, src_row: u32, dr: i64) -> String {
    let mut expr = match parse(src) {
        Ok(e) => e,
        Err(_) => return src.to_string(),
    };
    parser::for_each_ref_mut(&mut expr, &mut |r| {
        if r.table.is_some() {
            return;
        }
        match &mut r.kind {
            RefKind::Cell { row, abs_row, .. } if !*abs_row && *row == src_row => {
                *row = (*row as i64 + dr).max(0) as u32;
            }
            RefKind::Range { r0, r1, abs, .. } if !abs[0] && !abs[2] && *r0 == src_row && *r1 == src_row => {
                *r0 = (*r0 as i64 + dr).max(0) as u32;
                *r1 = *r0;
            }
            _ => {}
        }
    });
    to_string(&expr)
}

/// Rewrite references in `src` after `count` rows/cols were inserted (count > 0)
/// or deleted (count < 0) at index `at` in the table named `table_name` (or the
/// current table when `is_current`). References into the deleted span become #REF!.
pub fn adjust_for_insert_delete(
    src: &str,
    is_current: bool,
    table_name: &str,
    is_rows: bool,
    at: u32,
    count: i64,
) -> String {
    let mut expr = match parse(src) {
        Ok(e) => e,
        Err(_) => return src.to_string(),
    };
    let target = table_name.trim().to_lowercase();
    let shift = |idx: &mut u32| -> bool {
        let i = *idx as i64;
        if i < at as i64 {
            return true;
        }
        if count < 0 && i < at as i64 + (-count) {
            return false; // deleted
        }
        *idx = (i + count).max(0) as u32;
        true
    };
    parser::map_refs(&mut expr, &mut |r| {
        let applies = match &r.table {
            None => is_current,
            Some(nm) => nm.trim().to_lowercase() == target,
        };
        if !applies {
            return true;
        }
        match &mut r.kind {
            RefKind::Cell { row, col, .. } => {
                if is_rows {
                    shift(row)
                } else {
                    shift(col)
                }
            }
            RefKind::Range { r0, c0, r1, c1, .. } => {
                let (a, b2) = if is_rows { (r0, r1) } else { (c0, c1) };
                let ok0 = shift(a);
                let ok1 = shift(b2);
                if !ok0 && !ok1 {
                    return false;
                }
                if !ok0 {
                    *a = at;
                } else if !ok1 {
                    *b2 = at.saturating_sub(1).max(*a);
                }
                true
            }
            RefKind::Cols { c0, c1 } if !is_rows => {
                let ok0 = shift(c0);
                let ok1 = shift(c1);
                if !ok0 && !ok1 {
                    return false;
                }
                if !ok0 {
                    *c0 = at;
                } else if !ok1 {
                    *c1 = at.saturating_sub(1).max(*c0);
                }
                true
            }
            RefKind::Rows { r0, r1 } if is_rows => {
                let ok0 = shift(r0);
                let ok1 = shift(r1);
                if !ok0 && !ok1 {
                    return false;
                }
                if !ok0 {
                    *r0 = at;
                } else if !ok1 {
                    *r1 = at.saturating_sub(1).max(*r0);
                }
                true
            }
            _ => true,
        }
    });
    to_string(&expr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Table;

    fn book() -> Workbook {
        let mut wb = Workbook::new("t");
        let mut t1 = Table::new(1, "Table 1", 0.0, 0.0, 5, 3);
        let mut t2 = Table::new(2, "Sales", 0.0, 0.0, 4, 2);
        for (r, v) in [10.0, 20.0, 30.0, 40.0].iter().enumerate() {
            t1.cells.insert(
                CellKey::new(r as u32, 0),
                crate::model::Cell {
                    input: v.to_string(),
                    value: Value::Number(*v),
                    ..Default::default()
                },
            );
        }
        t1.cells.insert(
            CellKey::new(0, 1),
            crate::model::Cell {
                input: "apple".into(),
                value: Value::Text("apple".into()),
                ..Default::default()
            },
        );
        t1.cells.insert(
            CellKey::new(1, 1),
            crate::model::Cell {
                input: "Banana".into(),
                value: Value::Text("Banana".into()),
                ..Default::default()
            },
        );
        for (r, v) in [1.5, 2.5, 3.0].iter().enumerate() {
            t2.cells.insert(
                CellKey::new(r as u32, 1),
                crate::model::Cell {
                    input: v.to_string(),
                    value: Value::Number(*v),
                    ..Default::default()
                },
            );
        }
        wb.tables.push(t1);
        wb.tables.push(t2);
        wb.next_table_id = 3;
        wb.now_serial = 46000.5;
        wb
    }

    fn ev(wb: &Workbook, f: &str) -> Value {
        evaluate(wb, 1, Some(CellKey::new(4, 2)), f)
    }

    #[test]
    fn arithmetic_and_refs() {
        let wb = book();
        assert_eq!(ev(&wb, "1+2*3"), Value::Number(7.0));
        assert_eq!(ev(&wb, "(1+2)*3"), Value::Number(9.0));
        assert_eq!(ev(&wb, "2^3^2"), Value::Number(64.0));
        assert_eq!(ev(&wb, "-A1"), Value::Number(-10.0));
        assert_eq!(ev(&wb, "A1+A2"), Value::Number(30.0));
        assert_eq!(ev(&wb, "SUM(A1:A4)"), Value::Number(100.0));
        assert_eq!(ev(&wb, "SUM(A:A)"), Value::Number(100.0));
        assert_eq!(ev(&wb, "SUM(Sales::B1:B3)"), Value::Number(7.0));
        assert_eq!(ev(&wb, "'Sales'::B2 * 2"), Value::Number(5.0));
        assert_eq!(ev(&wb, "AVERAGE(A1:A4)"), Value::Number(25.0));
        assert_eq!(ev(&wb, "MIN(A1:A4)"), Value::Number(10.0));
        assert_eq!(ev(&wb, "MAX(A1:A4, 55)"), Value::Number(55.0));
        assert_eq!(ev(&wb, "COUNT(A1:B4)"), Value::Number(4.0));
        assert_eq!(ev(&wb, "COUNTA(A1:B4)"), Value::Number(6.0));
        assert_eq!(ev(&wb, "10%*A1"), Value::Number(1.0));
        assert_eq!(ev(&wb, "A5"), Value::Empty);
        assert_eq!(ev(&wb, "A5+1"), Value::Number(1.0));
    }

    #[test]
    fn errors() {
        let wb = book();
        assert_eq!(ev(&wb, "1/0"), Value::Error(ErrorKind::Div0));
        assert_eq!(ev(&wb, "FOO(1)"), Value::Error(ErrorKind::Name));
        assert_eq!(ev(&wb, "Nope::A1"), Value::Error(ErrorKind::Ref));
        assert_eq!(ev(&wb, "Z99"), Value::Error(ErrorKind::Ref));
        assert_eq!(ev(&wb, "\"a\"+1"), Value::Error(ErrorKind::Value));
        assert_eq!(ev(&wb, "SQRT(-1)"), Value::Error(ErrorKind::Num));
        assert_eq!(ev(&wb, "1 +"), Value::Error(ErrorKind::Name));
        assert_eq!(ev(&wb, "IFERROR(1/0, \"n/a\")"), Value::Text("n/a".into()));
    }

    #[test]
    fn logic_text_lookup() {
        let wb = book();
        assert_eq!(ev(&wb, "IF(A1>5,\"big\",\"small\")"), Value::Text("big".into()));
        assert_eq!(ev(&wb, "IF(A1>50,1)"), Value::Bool(false));
        assert_eq!(ev(&wb, "AND(TRUE, A1=10)"), Value::Bool(true));
        assert_eq!(ev(&wb, "OR(FALSE, A1<>10)"), Value::Bool(false));
        assert_eq!(ev(&wb, "NOT(1=1)"), Value::Bool(false));
        assert_eq!(ev(&wb, "B1&\"-\"&B2"), Value::Text("apple-Banana".into()));
        assert_eq!(ev(&wb, "UPPER(B1)"), Value::Text("APPLE".into()));
        assert_eq!(ev(&wb, "LEN(B2)"), Value::Number(6.0));
        assert_eq!(ev(&wb, "LEFT(B2,3)"), Value::Text("Ban".into()));
        assert_eq!(ev(&wb, "MID(B2,2,3)"), Value::Text("ana".into()));
        assert_eq!(ev(&wb, "FIND(\"an\",B2)"), Value::Number(2.0));
        assert_eq!(ev(&wb, "PROPER(\"hello world\")"), Value::Text("Hello World".into()));
        assert_eq!(ev(&wb, "TEXT(1234.5,\"#,##0.00\")"), Value::Text("1,234.50".into()));
        assert_eq!(ev(&wb, "TEXT(0.256,\"0.0%\")"), Value::Text("25.6%".into()));
        assert_eq!(ev(&wb, "VLOOKUP(20, A1:B4, 2, FALSE)"), Value::Text("Banana".into()));
        assert_eq!(ev(&wb, "VLOOKUP(99, A1:B4, 2, FALSE)"), Value::Error(ErrorKind::NA));
        assert_eq!(ev(&wb, "VLOOKUP(25, A1:A4, 1)"), Value::Number(20.0));
        assert_eq!(ev(&wb, "MATCH(30, A1:A4, 0)"), Value::Number(3.0));
        assert_eq!(ev(&wb, "INDEX(A1:B4, 2, 2)"), Value::Text("Banana".into()));
        assert_eq!(ev(&wb, "INDEX(A1:A4, 3)"), Value::Number(30.0));
        assert_eq!(ev(&wb, "XLOOKUP(\"apple\", B1:B4, A1:A4)"), Value::Number(10.0));
        assert_eq!(ev(&wb, "COUNTIF(A1:A4, \">15\")"), Value::Number(3.0));
        assert_eq!(ev(&wb, "SUMIF(A1:A4, \">15\")"), Value::Number(90.0));
        assert_eq!(ev(&wb, "SUMIF(B1:B4, \"b*\", A1:A4)"), Value::Number(20.0));
        assert_eq!(ev(&wb, "SUMIFS(A1:A4, A1:A4, \">=20\", A1:A4, \"<40\")"), Value::Number(50.0));
        assert_eq!(ev(&wb, "SUMPRODUCT(A1:A2, A3:A4)"), Value::Number(1100.0));
        assert_eq!(ev(&wb, "ROUND(2.345, 2)"), Value::Number(2.35));
        assert_eq!(ev(&wb, "ROUND(-2.5)"), Value::Number(-3.0));
        assert_eq!(ev(&wb, "ROUNDDOWN(2.999, 1)"), Value::Number(2.9));
        assert_eq!(ev(&wb, "MOD(-7, 3)"), Value::Number(2.0));
        assert_eq!(ev(&wb, "ROW()"), Value::Number(5.0));
        assert_eq!(ev(&wb, "COLUMN(B2)"), Value::Number(2.0));
        assert_eq!(ev(&wb, "MEDIAN(A1:A4)"), Value::Number(25.0));
        assert_eq!(ev(&wb, "LARGE(A1:A4, 2)"), Value::Number(30.0));
    }

    #[test]
    fn dates() {
        let wb = book();
        assert_eq!(ev(&wb, "DATE(1970,1,1)"), Value::Number(25569.0));
        assert_eq!(ev(&wb, "DATE(2026,10,8)"), Value::Number(46303.0));
        assert_eq!(ev(&wb, "YEAR(DATE(2026,10,8))"), Value::Number(2026.0));
        assert_eq!(ev(&wb, "MONTH(46303)"), Value::Number(10.0));
        assert_eq!(ev(&wb, "DAY(\"2026-10-08\")"), Value::Number(8.0));
        assert_eq!(ev(&wb, "TODAY()"), Value::Number(46000.0));
        assert_eq!(ev(&wb, "EOMONTH(DATE(2026,2,10),0)"), Value::Number(46081.0)); // 2026-02-28
        assert_eq!(ev(&wb, "EDATE(DATE(2026,1,31),1)"), Value::Number(46084.0)); // 2026-03-03 (overflow like Excel)
        assert_eq!(ev(&wb, "TEXT(DATE(2026,10,8),\"yyyy-mm-dd\")"), Value::Text("2026-10-08".into()));
        assert_eq!(ev(&wb, "WEEKDAY(DATE(2026,10,8))"), Value::Number(5.0)); // Thursday
    }

    #[test]
    fn deps_and_shifts() {
        let wb = book();
        let d = dependencies(&wb, 1, "SUM(A1:A4) + Sales::B2 + Z99");
        assert_eq!(d.len(), 2);
        assert_eq!(d[0], Rect { table: 1, r0: 0, c0: 0, r1: 3, c1: 0 });
        assert_eq!(d[1], Rect { table: 2, r0: 1, c0: 1, r1: 1, c1: 1 });
        assert_eq!(shift_relative("A1+$B$2+C$3", 1, 1), "B2 + $B$2 + D$3");
        assert_eq!(shift_relative("SUM(A1:A3)", 0, 2), "SUM(C1:C3)");
        assert_eq!(shift_same_row("B3*C3+SUM(B2:B5)+$B$3", 2, 4), "B7 * C7 + SUM(B2:B5) + $B$3");
        assert_eq!(adjust_for_insert_delete("SUM(A1:A5)+A7", true, "Table 1", true, 2, 1), "SUM(A1:A6) + A8");
        assert_eq!(adjust_for_insert_delete("SUM(A1:A5)+A3", true, "Table 1", true, 2, -1), "SUM(A1:A4) + #REF!");
        assert_eq!(adjust_for_insert_delete("A1", true, "Table 1", true, 0, -1), "#REF!");
        assert_eq!(evaluate(&wb, 1, None, "SUM(A1:A4) + #REF!"), Value::Error(ErrorKind::Ref));
        assert_eq!(adjust_for_insert_delete("A1+B1", true, "Table 1", false, 1, 2), "A1 + D1");
        assert_eq!(adjust_for_insert_delete("Sales::B1", true, "Table 1", false, 0, 1), "Sales::B1");
    }
}
