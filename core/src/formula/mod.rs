//! Formula language: `=SUM(A1:B3) + 'Table 1'::C2 * 10%`.

pub mod eval;
pub mod lexer;
pub mod parser;

pub use eval::{collect_deps, eval, resolve_ref, Arg, Array, Ctx};
pub use parser::{parse, to_string, Expr, ParseError, RefExpr, RefKind};

use crate::model::{CellKey, ErrorKind, Rect, TableId, Value, Workbook};

/// Parse (without the leading `=`) and evaluate a formula for the cell `at` in `table`.
/// Array results collapse to their first element; use `evaluate_full` for spilling.
pub fn evaluate(wb: &Workbook, table: TableId, at: Option<CellKey>, src: &str) -> Value {
    match evaluate_full(wb, table, at, src) {
        Arg::Scalar(v) => v,
        Arg::Array(a) => a.data.into_iter().next().unwrap_or(Value::Empty),
    }
}

/// Parse and evaluate, keeping array results (dynamic arrays).
pub fn evaluate_full(wb: &Workbook, table: TableId, at: Option<CellKey>, src: &str) -> Arg {
    match parse(src) {
        Ok(expr) => {
            let ctx = Ctx {
                wb,
                table,
                now: wb.now_serial,
                at,
                locals: vec![],
            };
            eval(&expr, &ctx)
        }
        Err(_) => Arg::Scalar(Value::Error(ErrorKind::Name)),
    }
}

/// Rewrite table-qualified references in a formula body after a table was renamed.
pub fn rename_table(src: &str, old: &str, new: &str) -> String {
    let mut expr = match parse(src) {
        Ok(e) => e,
        Err(_) => return src.to_string(),
    };
    if parser::rename_table_refs(&mut expr, old, new) {
        to_string(&expr)
    } else {
        src.to_string()
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
    fn arrays_structured_refs_names_and_finance() {
        let mut wb = book();
        wb.names.push(crate::model::NamedRange {
            name: "Prices".into(),
            reference: "Sales::B1:B3".into(),
        });
        wb.names.push(crate::model::NamedRange {
            name: "TaxRate".into(),
            reference: "0.14".into(),
        });
        // Table 1: A1..A4 = 10,20,30,40 ; B1 = apple, B2 = Banana (header row = row 0)
        let full = |f: &str| evaluate_full(&wb, 1, Some(CellKey::new(2, 2)), f);
        // lifting + spill shapes
        match full("A1:A4 * 2") {
            Arg::Array(a) => {
                assert_eq!((a.rows, a.cols), (4, 1));
                assert_eq!(a.data[3], Value::Number(80.0));
            }
            other => panic!("expected array, got {:?}", other),
        }
        match full("ROUND(A1:A2 / 3, 1)") {
            Arg::Array(a) => assert_eq!(a.data, vec![Value::Number(3.3), Value::Number(6.7)]),
            other => panic!("{:?}", other),
        }
        match full("FILTER(A1:A4, A1:A4 > 15)") {
            Arg::Array(a) => assert_eq!(a.data, vec![Value::Number(20.0), Value::Number(30.0), Value::Number(40.0)]),
            other => panic!("{:?}", other),
        }
        match full("SORT(A1:A4, 1, -1)") {
            Arg::Array(a) => assert_eq!(a.data[0], Value::Number(40.0)),
            other => panic!("{:?}", other),
        }
        match full("SEQUENCE(2, 3, 10, 5)") {
            Arg::Array(a) => assert_eq!((a.rows, a.cols, a.data[5].clone()), (2, 3, Value::Number(35.0))),
            other => panic!("{:?}", other),
        }
        assert_eq!(ev(&wb, "SUM(IF(A1:A4 > 15, A1:A4, 0))"), Value::Number(90.0));
        assert_eq!(ev(&wb, "IFERROR(1/0, \"x\")"), Value::Text("x".into()));
        assert_eq!(ev(&wb, "ROWS(UNIQUE({1;1;2}))"), Value::Number(2.0));
        // structured references: header row is row 0 → "10" is the header of column A, "apple" of column B
        assert_eq!(ev(&wb, "SUM([10])"), Value::Number(90.0)); // data rows A2:A4
        assert_eq!(ev(&wb, "COUNTA('Table 1'[apple])"), Value::Number(1.0));
        assert_eq!(evaluate(&wb, 1, Some(CellKey::new(1, 2)), "[@10] * 2"), Value::Number(40.0));
        assert_eq!(ev(&wb, "[Nope]"), Value::Error(ErrorKind::Name));
        // names
        assert_eq!(ev(&wb, "SUM(Prices)"), Value::Number(7.0));
        assert_eq!(ev(&wb, "ROUND(TaxRate * 100, 6)"), Value::Number(14.0));
        assert_eq!(ev(&wb, "Unknown + 1"), Value::Error(ErrorKind::Name));
        let d = dependencies(&wb, 1, "SUM(Prices) + [@10]");
        assert_eq!(d[0], Rect { table: 2, r0: 0, c0: 1, r1: 2, c1: 1 });
        assert_eq!(d[1], Rect { table: 1, r0: 1, c0: 0, r1: 4, c1: 0 });
        // finance
        let pmt = ev(&wb, "PMT(0.05/12, 360, 200000)");
        if let Value::Number(x) = pmt {
            assert!((x + 1073.64).abs() < 0.01, "{}", x);
        } else {
            panic!("{:?}", pmt);
        }
        if let Value::Number(x) = ev(&wb, "NPV(0.1, 100, 100, 100)") {
            assert!((x - 248.685).abs() < 0.01);
        } else {
            panic!();
        }
        if let Value::Number(x) = ev(&wb, "IRR({-100; 60; 60})") {
            assert!((x - 0.1307).abs() < 0.001, "{}", x);
        } else {
            panic!();
        }
        if let Value::Number(x) = ev(&wb, "FV(0.06/12, 120, -100)") {
            assert!((x - 16387.93).abs() < 0.05, "{}", x);
        } else {
            panic!();
        }
        if let Value::Number(x) = ev(&wb, "NPER(0.01, -100, 1000)") {
            assert!((x - 10.588).abs() < 0.01, "{}", x);
        } else {
            panic!();
        }
        if let Value::Number(x) = ev(&wb, "RATE(360, -1073.64, 200000) * 12") {
            assert!((x - 0.05).abs() < 1e-4, "{}", x);
        } else {
            panic!();
        }
        if let Value::Number(x) = ev(&wb, "XNPV(0.1, {-1000; 600; 600}, {46000; 46365; 46730})") {
            assert!((x - 41.32).abs() < 0.5, "{}", x);
        } else {
            panic!();
        }
        assert_eq!(ev(&wb, "SLN(10000, 1000, 5)"), Value::Number(1800.0));
        assert_eq!(ev(&wb, "YEARFRAC(DATE(2026,1,1), DATE(2026,7,1))"), Value::Number(0.5));
        assert_eq!(ev(&wb, "DATEDIF(DATE(2020,2,29), DATE(2026,10,8), \"Y\")"), Value::Number(6.0));
        assert_eq!(ev(&wb, "NETWORKDAYS(DATE(2026,10,5), DATE(2026,10,11))"), Value::Number(5.0));
        assert_eq!(ev(&wb, "WORKDAY(DATE(2026,10,9), 1)"), Value::Number(46307.0)); // Fri → Mon
        assert_eq!(ev(&wb, "TEXT(1234.5, \"#.##0,00 \"\"Kz\"\"\")"), Value::Text("1.234,50 Kz".into()));
        assert_eq!(ev(&wb, "TEXT(-1234.5, \"€#,##0.00\")"), Value::Text("-€1,234.50".into()));
        assert_eq!(ev(&wb, "TEXT(DATE(2026,10,8) + 0.5, \"d mmm yyyy hh:mm\")"), Value::Text("8 Oct 2026 12:00".into()));
        assert_eq!(ev(&wb, "TEXT(DATE(2026,10,8), \"dddd\")"), Value::Text("Thursday".into()));
        assert_eq!(ev(&wb, "HOUR(\"2026-10-08 14:30\")"), Value::Number(14.0));
        assert_eq!(ev(&wb, "SWITCH(2, 1, \"a\", 2, \"b\", \"z\")"), Value::Text("b".into()));
        assert_eq!(ev(&wb, "MAXIFS(A1:A4, B1:B4, \"*an*\")"), Value::Number(20.0));
        assert_eq!(rename_table("SUM(Sales::B1:B3) + sales[Price]", "Sales", "Revenue"), "SUM(Revenue::B1:B3) + Revenue[Price]");
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

#[cfg(test)]
mod extended_tests {
    use super::*;
    use crate::model::{Cell, Table};

    fn book() -> Workbook {
        let mut wb = Workbook::new("t");
        let mut t1 = Table::new(1, "Table 1", 0.0, 0.0, 5, 3);
        for (r, v) in [10.0, 20.0, 30.0, 40.0].iter().enumerate() {
            t1.cells.insert(CellKey::new(r as u32, 0), Cell { input: v.to_string(), value: Value::Number(*v), ..Default::default() });
        }
        for (r, s) in ["apple", "Banana"].iter().enumerate() {
            t1.cells.insert(CellKey::new(r as u32, 1), Cell { input: s.to_string(), value: Value::Text(s.to_string()), ..Default::default() });
        }
        wb.tables.push(t1);
        wb.next_table_id = 2;
        wb.now_serial = 46000.5;
        wb
    }

    fn ev(wb: &Workbook, f: &str) -> Value {
        evaluate(wb, 1, Some(CellKey::new(4, 2)), f)
    }

    fn close(wb: &Workbook, f: &str, want: f64, tol: f64) {
        match ev(wb, f) {
            Value::Number(got) => assert!((got - want).abs() <= tol, "{f}: got {got}, want {want}"),
            other => panic!("{f} gave {other:?}, want {want}"),
        }
    }

    #[test]
    fn let_and_lazy_references() {
        let wb = book();
        assert_eq!(ev(&wb, "LET(x,5,x*2)"), Value::Number(10.0));
        assert_eq!(ev(&wb, "LET(a,2,b,a+1,a*b)"), Value::Number(6.0));
        assert_eq!(ev(&wb, "LET(x,1,LET(x,x+1,x))"), Value::Number(2.0));
        assert_eq!(ev(&wb, "OFFSET(A1,1,0)"), Value::Number(20.0));
        assert_eq!(ev(&wb, "SUM(OFFSET(A1,1,0,2,1))"), Value::Number(50.0));
        assert_eq!(ev(&wb, "OFFSET(A1,9,0)"), Value::Error(ErrorKind::Ref));
        assert_eq!(ev(&wb, "INDIRECT(\"A2\")"), Value::Number(20.0));
        assert_eq!(ev(&wb, "SUM(INDIRECT(\"A1:A4\"))"), Value::Number(100.0));
        assert_eq!(ev(&wb, "ISFORMULA(A1)"), Value::Bool(false));
        assert_eq!(ev(&wb, "ISREF(A1)"), Value::Bool(true));
        assert_eq!(ev(&wb, "ISREF(5)"), Value::Bool(false));
    }

    #[test]
    fn maths_and_combinatorics() {
        let wb = book();
        assert_eq!(ev(&wb, "QUOTIENT(7,2)"), Value::Number(3.0));
        assert_eq!(ev(&wb, "GCD(12,18)"), Value::Number(6.0));
        assert_eq!(ev(&wb, "LCM(4,6)"), Value::Number(12.0));
        assert_eq!(ev(&wb, "FACT(5)"), Value::Number(120.0));
        assert_eq!(ev(&wb, "COMBIN(5,2)"), Value::Number(10.0));
        assert_eq!(ev(&wb, "PERMUT(5,2)"), Value::Number(20.0));
        assert_eq!(ev(&wb, "MROUND(10,3)"), Value::Number(9.0));
        assert_eq!(ev(&wb, "EVEN(3)"), Value::Number(4.0));
        assert_eq!(ev(&wb, "ODD(2)"), Value::Number(3.0));
        assert_eq!(ev(&wb, "SUMSQ(1,2,3)"), Value::Number(14.0));
        assert_eq!(ev(&wb, "CEILING.MATH(5.2)"), Value::Number(6.0));
        assert_eq!(ev(&wb, "FLOOR.MATH(5.8)"), Value::Number(5.0));
        assert_eq!(ev(&wb, "FLOOR.MATH(-5.5,2)"), Value::Number(-6.0));
        assert_eq!(ev(&wb, "BASE(255,16)"), Value::Text("FF".into()));
        assert_eq!(ev(&wb, "BASE(5,2,8)"), Value::Text("00000101".into()));
        assert_eq!(ev(&wb, "DECIMAL(\"FF\",16)"), Value::Number(255.0));
        close(&wb, "ATAN2(1,1)", std::f64::consts::FRAC_PI_4, 1e-12);
        close(&wb, "RADIANS(180)", std::f64::consts::PI, 1e-12);
    }

    #[test]
    fn statistics() {
        let wb = book();
        assert_eq!(ev(&wb, "MAXA(A1:A4)"), Value::Number(40.0));
        assert_eq!(ev(&wb, "MINA(B1:B2,A1)"), Value::Number(0.0));
        assert_eq!(ev(&wb, "AVERAGEA(A1:A2)"), Value::Number(15.0));
        assert_eq!(ev(&wb, "MODE(1,2,2,3)"), Value::Number(2.0));
        assert_eq!(ev(&wb, "MODE(1,2,3)"), Value::Error(ErrorKind::NA));
        assert_eq!(ev(&wb, "PERCENTILE(A1:A4,0.5)"), Value::Number(25.0));
        close(&wb, "QUARTILE(A1:A4,1)", 17.5, 1e-9);
        close(&wb, "PERCENTILE.EXC(A1:A4,0.5)", 25.0, 1e-9);
        assert_eq!(ev(&wb, "RANK.AVG(20,A1:A4)"), Value::Number(3.0));
        close(&wb, "CORREL(A1:A4,A1:A4)", 1.0, 1e-9);
        close(&wb, "SLOPE(A1:A4,A1:A4)", 1.0, 1e-9);
        close(&wb, "INTERCEPT(A1:A4,A1:A4)", 0.0, 1e-9);
        close(&wb, "FORECAST(5,A1:A4,A1:A4)", 5.0, 1e-9);
        close(&wb, "GEOMEAN(1,4)", 2.0, 1e-9);
        close(&wb, "HARMEAN(1,4)", 1.6, 1e-9);
        close(&wb, "DEVSQ(1,2,3)", 2.0, 1e-9);
        close(&wb, "AVEDEV(1,2,3)", 2.0 / 3.0, 1e-9);
        close(&wb, "TRIMMEAN(A1:A4,0.5)", 25.0, 1e-9);
        assert_eq!(ev(&wb, "COUNTUNIQUE(A1:A4,A1:A4)"), Value::Number(4.0));
        close(&wb, "NORM.S.DIST(0,TRUE)", 0.5, 1e-6);
        close(&wb, "NORM.DIST(0,0,1,FALSE)", 0.398942280, 1e-6);
        close(&wb, "NORM.S.INV(0.975)", 1.959964, 1e-5);
        close(&wb, "STANDARDIZE(15,10,5)", 1.0, 1e-12);
    }

    #[test]
    fn text_and_regex() {
        let wb = book();
        assert_eq!(ev(&wb, "CHAR(65)"), Value::Text("A".into()));
        assert_eq!(ev(&wb, "CODE(\"A\")"), Value::Number(65.0));
        assert_eq!(ev(&wb, "FIXED(1234.567,2)"), Value::Text("1,234.57".into()));
        assert_eq!(ev(&wb, "FIXED(1234.567,1,TRUE)"), Value::Text("1234.6".into()));
        assert_eq!(ev(&wb, "NUMBERVALUE(\"1.234,5\",\",\",\".\")"), Value::Number(1234.5));
        assert_eq!(ev(&wb, "REPLACE(\"abcdef\",2,3,\"X\")"), Value::Text("aXef".into()));
        assert_eq!(ev(&wb, "TEXTBEFORE(\"a-b-c\",\"-\",2)"), Value::Text("a-b".into()));
        assert_eq!(ev(&wb, "TEXTAFTER(\"a-b-c\",\"-\")"), Value::Text("b-c".into()));
        assert_eq!(ev(&wb, "TEXTAFTER(\"a-b-c\",\"-\",-1)"), Value::Text("c".into()));
        assert_eq!(ev(&wb, "JOIN(\"-\",\"a\",\"b\")"), Value::Text("a-b".into()));
        assert_eq!(ev(&wb, "REGEXMATCH(\"abc123\",\"[0-9]+\")"), Value::Bool(true));
        assert_eq!(ev(&wb, "REGEXEXTRACT(\"abc123\",\"([0-9]+)\")"), Value::Text("123".into()));
        assert_eq!(ev(&wb, "REGEXREPLACE(\"a1b22\",\"[0-9]+\",\"#\")"), Value::Text("a#b#".into()));
        assert_eq!(ev(&wb, "COUNTA(TEXTSPLIT(\"a-b-c\",\"-\"))"), Value::Number(3.0));
    }

    #[test]
    fn lookup_and_shaping() {
        let wb = book();
        assert_eq!(ev(&wb, "LOOKUP(25,A1:A4)"), Value::Number(20.0));
        assert_eq!(ev(&wb, "XMATCH(30,A1:A4)"), Value::Number(3.0));
        assert_eq!(ev(&wb, "XMATCH(25,A1:A4,-1)"), Value::Number(2.0));
        assert_eq!(ev(&wb, "XMATCH(25,A1:A4,1)"), Value::Number(3.0));
        assert_eq!(ev(&wb, "COUNTA(VSTACK(A1:A2,A1:A4))"), Value::Number(6.0));
        assert_eq!(ev(&wb, "COUNTA(HSTACK(A1:A2,B1:B2))"), Value::Number(4.0));
        assert_eq!(ev(&wb, "COUNTA(TAKE(A1:A4,2))"), Value::Number(2.0));
        assert_eq!(ev(&wb, "COUNTA(DROP(A1:A4,1))"), Value::Number(3.0));
        assert_eq!(ev(&wb, "COUNTA(TOCOL(A1:A4))"), Value::Number(4.0));
        assert_eq!(ev(&wb, "COUNTA(WRAPROWS(A1:A4,2))"), Value::Number(4.0));
        assert_eq!(ev(&wb, "COUNTA(CHOOSECOLS(A1:B2,2))"), Value::Number(2.0));
        assert_eq!(ev(&wb, "ADDRESS(2,3)"), Value::Text("$C$2".into()));
        assert_eq!(ev(&wb, "ADDRESS(2,3,4)"), Value::Text("C2".into()));
        assert_eq!(ev(&wb, "TYPE(1)"), Value::Number(1.0));
        assert_eq!(ev(&wb, "TYPE(\"a\")"), Value::Number(2.0));
        assert_eq!(ev(&wb, "TYPE(TRUE)"), Value::Number(4.0));
        assert_eq!(ev(&wb, "ERROR.TYPE(1/0)"), Value::Number(2.0));
    }

    #[test]
    fn dates_and_finance() {
        let wb = book();
        // serial 43831 is 2020-01-01, a Wednesday
        assert_eq!(ev(&wb, "WEEKNUM(43831)"), Value::Number(1.0));
        assert_eq!(ev(&wb, "WEEKNUM(43838)"), Value::Number(2.0));
        assert_eq!(ev(&wb, "ISOWEEKNUM(43831)"), Value::Number(1.0));
        assert_eq!(ev(&wb, "ISOWEEKNUM(43830)"), Value::Number(1.0));
        assert_eq!(ev(&wb, "DAYS360(43831,43861)"), Value::Number(30.0));
        assert_eq!(ev(&wb, "NETWORKDAYS.INTL(43831,43837,1)"), Value::Number(5.0));
        assert_eq!(ev(&wb, "WORKDAY.INTL(43831,1)"), Value::Number(43832.0));
        close(&wb, "SYD(30000,7500,10,1)", 22500.0 * 10.0 * 2.0 / 110.0, 1e-9);
        close(&wb, "DDB(2400,300,10,1)", 480.0, 1e-9);
        close(&wb, "DB(1000000,100000,6,1,7)", 186083.33, 0.01);
        close(&wb, "RRI(10,1000,2000)", 2f64.powf(0.1) - 1.0, 1e-9);
        close(&wb, "PDURATION(0.025,2000,2200)", 1.1f64.ln() / 1.025f64.ln(), 1e-9);
        close(&wb, "ISPMT(0.1/12,1,36,8000000)", -66666.67, 0.01);
        close(&wb, "CUMIPMT(0.09/12,360,125000,13,24,0)", -11135.23, 0.01);
        close(&wb, "CUMPRINC(0.09/12,360,125000,13,24,0)", -934.11, 0.01);
        close(&wb, "FVSCHEDULE(1000,{0.09,0.11,0.1})", 1000.0 * 1.09 * 1.11 * 1.1, 1e-6);
        close(&wb, "MIRR({-120000,39000,30000,21000,37000,46000},0.1,0.12)", 0.126, 0.001);
    }
}

#[cfg(test)]
mod name_coverage {
    use super::*;
    use crate::model::Table;

    /// Every uppercase name the evaluator mentions must resolve to a function (anything but #NAME?).
    #[test]
    fn every_listed_name_is_implemented() {
        let mut wb = Workbook::new("t");
        wb.tables.push(Table::new(1, "Table 1", 0.0, 0.0, 5, 3));
        wb.next_table_id = 2;
        wb.now_serial = 46000.5;
        let cases: &[(&str, &str)] = &[
        ("A", "A()"),
        ("ABS", "ABS()"),
        ("ACOS", "ACOS()"),
        ("ADDRESS", "ADDRESS()"),
        ("AGEING", "AGEING()"),
        ("AGE_BUCKET", "AGE_BUCKET()"),
        ("AGING", "AGING()"),
        ("AND", "AND()"),
        ("ARRAYTOTEXT", "ARRAYTOTEXT()"),
        ("ASIN", "ASIN()"),
        ("ATAN", "ATAN()"),
        ("ATAN2", "ATAN2()"),
        ("AVEDEV", "AVEDEV()"),
        ("AVERAGE", "AVERAGE()"),
        ("AVERAGEA", "AVERAGEA()"),
        ("AVERAGEIF", "AVERAGEIF()"),
        ("AVERAGEIFS", "AVERAGEIFS()"),
        ("B", "B()"),
        ("BASE", "BASE()"),
        ("CEILING", "CEILING()"),
        ("CEILING.MATH", "CEILING.MATH()"),
        ("CHAR", "CHAR()"),
        ("CHECK", "CHECK()"),
        ("CHOOSE", "CHOOSE()"),
        ("CHOOSECOLS", "CHOOSECOLS()"),
        ("CHOOSEROWS", "CHOOSEROWS()"),
        ("CLEAN", "CLEAN()"),
        ("CODE", "CODE()"),
        ("COLUMN", "COLUMN()"),
        ("COLUMNS", "COLUMNS()"),
        ("COMBIN", "COMBIN()"),
        ("CONCAT", "CONCAT()"),
        ("CONCATENATE", "CONCATENATE()"),
        ("CORREL", "CORREL()"),
        ("COS", "COS()"),
        ("COSH", "COSH()"),
        ("COUNT", "COUNT()"),
        ("COUNTA", "COUNTA()"),
        ("COUNTBLANK", "COUNTBLANK()"),
        ("COUNTIF", "COUNTIF()"),
        ("COUNTIFS", "COUNTIFS()"),
        ("COUNTUNIQUE", "COUNTUNIQUE()"),
        ("COVAR", "COVAR()"),
        ("COVARIANCE.P", "COVARIANCE.P()"),
        ("COVARIANCE.S", "COVARIANCE.S()"),
        ("CUMIPMT", "CUMIPMT()"),
        ("CUMPRINC", "CUMPRINC()"),
        ("D", "D()"),
        ("DATE", "DATE()"),
        ("DATEDIF", "DATEDIF()"),
        ("DATEVALUE", "DATEVALUE()"),
        ("DAY", "DAY()"),
        ("DAYS", "DAYS()"),
        ("DAYS360", "DAYS360()"),
        ("DB", "DB()"),
        ("DDB", "DDB()"),
        ("DECIMAL", "DECIMAL()"),
        ("DEGREES", "DEGREES()"),
        ("DEVSQ", "DEVSQ()"),
        ("DROP", "DROP()"),
        ("EDATE", "EDATE()"),
        ("EFFECT", "EFFECT()"),
        ("EOMONTH", "EOMONTH()"),
        ("ERROR.TYPE", "ERROR.TYPE()"),
        ("EVEN", "EVEN()"),
        ("EXACT", "EXACT()"),
        ("EXP", "EXP()"),
        ("EXPAND", "EXPAND()"),
        ("FACT", "FACT()"),
        ("FALSE", "FALSE()"),
        ("FILTER", "FILTER()"),
        ("FIND", "FIND()"),
        ("FIXED", "FIXED()"),
        ("FLOOR", "FLOOR()"),
        ("FLOOR.MATH", "FLOOR.MATH()"),
        ("FORECAST", "FORECAST()"),
        ("FORECAST.LINEAR", "FORECAST.LINEAR()"),
        ("FORMULATEXT", "FORMULATEXT()"),
        ("FV", "FV()"),
        ("FVSCHEDULE", "FVSCHEDULE()"),
        ("FX", "FX()"),
        ("FXRATE", "FXRATE()"),
        ("GCD", "GCD()"),
        ("GEOMEAN", "GEOMEAN()"),
        ("HARMEAN", "HARMEAN()"),
        ("HLOOKUP", "HLOOKUP()"),
        ("HOUR", "HOUR()"),
        ("HSTACK", "HSTACK()"),
        ("IF", "IF()"),
        ("IFERROR", "IFERROR()"),
        ("IFNA", "IFNA()"),
        ("IFS", "IFS()"),
        ("INDEX", "INDEX()"),
        ("INDIRECT", "INDIRECT()"),
        ("INT", "INT()"),
        ("INTERCEPT", "INTERCEPT()"),
        ("IPMT", "IPMT()"),
        ("IRR", "IRR()"),
        ("ISBLANK", "ISBLANK()"),
        ("ISERR", "ISERR()"),
        ("ISERROR", "ISERROR()"),
        ("ISEVEN", "ISEVEN()"),
        ("ISFORMULA", "ISFORMULA()"),
        ("ISLOGICAL", "ISLOGICAL()"),
        ("ISNA", "ISNA()"),
        ("ISNONTEXT", "ISNONTEXT()"),
        ("ISNUMBER", "ISNUMBER()"),
        ("ISODD", "ISODD()"),
        ("ISOWEEKNUM", "ISOWEEKNUM()"),
        ("ISPMT", "ISPMT()"),
        ("ISREF", "ISREF()"),
        ("ISTEXT", "ISTEXT()"),
        ("JOIN", "JOIN()"),
        ("LARGE", "LARGE()"),
        ("LCM", "LCM()"),
        ("LEFT", "LEFT()"),
        ("LEN", "LEN()"),
        ("LET", "LET()"),
        ("LN", "LN()"),
        ("LOG", "LOG()"),
        ("LOG10", "LOG10()"),
        ("LOOKUP", "LOOKUP()"),
        ("LOWER", "LOWER()"),
        ("M", "M()"),
        ("MATCH", "MATCH()"),
        ("MAX", "MAX()"),
        ("MAXA", "MAXA()"),
        ("MAXIFS", "MAXIFS()"),
        ("MD", "MD()"),
        ("MEDIAN", "MEDIAN()"),
        ("MID", "MID()"),
        ("MIN", "MIN()"),
        ("MINA", "MINA()"),
        ("MINIFS", "MINIFS()"),
        ("MINUTE", "MINUTE()"),
        ("MIRR", "MIRR()"),
        ("MOD", "MOD()"),
        ("MODE", "MODE()"),
        ("MODE.SNGL", "MODE.SNGL()"),
        ("MONTH", "MONTH()"),
        ("MROUND", "MROUND()"),
        ("N", "N()"),
        ("NA", "NA()"),
        ("NETWORKDAYS", "NETWORKDAYS()"),
        ("NETWORKDAYS.INTL", "NETWORKDAYS.INTL()"),
        ("NOMINAL", "NOMINAL()"),
        ("NORM.DIST", "NORM.DIST()"),
        ("NORM.INV", "NORM.INV()"),
        ("NORM.S.DIST", "NORM.S.DIST()"),
        ("NORM.S.INV", "NORM.S.INV()"),
        ("NORMDIST", "NORMDIST()"),
        ("NORMINV", "NORMINV()"),
        ("NORMSDIST", "NORMSDIST()"),
        ("NORMSINV", "NORMSINV()"),
        ("NOT", "NOT()"),
        ("NOW", "NOW()"),
        ("NPER", "NPER()"),
        ("NPV", "NPV()"),
        ("NUMBERVALUE", "NUMBERVALUE()"),
        ("ODD", "ODD()"),
        ("OFFSET", "OFFSET()"),
        ("OR", "OR()"),
        ("PDURATION", "PDURATION()"),
        ("PEARSON", "PEARSON()"),
        ("PERCENTILE", "PERCENTILE()"),
        ("PERCENTILE.EXC", "PERCENTILE.EXC()"),
        ("PERCENTILE.INC", "PERCENTILE.INC()"),
        ("PERCENTRANK", "PERCENTRANK()"),
        ("PERCENTRANK.INC", "PERCENTRANK.INC()"),
        ("PERMUT", "PERMUT()"),
        ("PI", "PI()"),
        ("PMT", "PMT()"),
        ("POWER", "POWER()"),
        ("PPMT", "PPMT()"),
        ("PRODUCT", "PRODUCT()"),
        ("PROPER", "PROPER()"),
        ("PV", "PV()"),
        ("QUARTILE", "QUARTILE()"),
        ("QUARTILE.EXC", "QUARTILE.EXC()"),
        ("QUARTILE.INC", "QUARTILE.INC()"),
        ("QUOTIENT", "QUOTIENT()"),
        ("RADIANS", "RADIANS()"),
        ("RAND", "RAND()"),
        ("RANDBETWEEN", "RANDBETWEEN()"),
        ("RANK", "RANK()"),
        ("RANK.AVG", "RANK.AVG()"),
        ("RANK.EQ", "RANK.EQ()"),
        ("RATE", "RATE()"),
        ("RECONCILE", "RECONCILE()"),
        ("REGEXEXTRACT", "REGEXEXTRACT()"),
        ("REGEXMATCH", "REGEXMATCH()"),
        ("REGEXREPLACE", "REGEXREPLACE()"),
        ("REPLACE", "REPLACE()"),
        ("REPT", "REPT()"),
        ("RIGHT", "RIGHT()"),
        ("ROUND", "ROUND()"),
        ("ROUNDDOWN", "ROUNDDOWN()"),
        ("ROUNDUP", "ROUNDUP()"),
        ("ROW", "ROW()"),
        ("ROWS", "ROWS()"),
        ("RRI", "RRI()"),
        ("RSQ", "RSQ()"),
        ("SEARCH", "SEARCH()"),
        ("SECOND", "SECOND()"),
        ("SEQUENCE", "SEQUENCE()"),
        ("SIGN", "SIGN()"),
        ("SIN", "SIN()"),
        ("SINH", "SINH()"),
        ("SLN", "SLN()"),
        ("SLOPE", "SLOPE()"),
        ("SMALL", "SMALL()"),
        ("SORT", "SORT()"),
        ("SORTBY", "SORTBY()"),
        ("SPLIT", "SPLIT()"),
        ("SQRT", "SQRT()"),
        ("SQRTPI", "SQRTPI()"),
        ("STANDARDIZE", "STANDARDIZE()"),
        ("STDEV", "STDEV()"),
        ("STDEV.P", "STDEV.P()"),
        ("STDEV.S", "STDEV.S()"),
        ("STDEVP", "STDEVP()"),
        ("STEYX", "STEYX()"),
        ("SUBSTITUTE", "SUBSTITUTE()"),
        ("SUBTOTAL", "SUBTOTAL()"),
        ("SUM", "SUM()"),
        ("SUMIF", "SUMIF()"),
        ("SUMIFS", "SUMIFS()"),
        ("SUMPRODUCT", "SUMPRODUCT()"),
        ("SUMSQ", "SUMSQ()"),
        ("SWITCH", "SWITCH()"),
        ("SYD", "SYD()"),
        ("T", "T()"),
        ("TAKE", "TAKE()"),
        ("TAN", "TAN()"),
        ("TANH", "TANH()"),
        ("TEXT", "TEXT()"),
        ("TEXTAFTER", "TEXTAFTER()"),
        ("TEXTBEFORE", "TEXTBEFORE()"),
        ("TEXTJOIN", "TEXTJOIN()"),
        ("TEXTSPLIT", "TEXTSPLIT()"),
        ("TIME", "TIME()"),
        ("TIMEVALUE", "TIMEVALUE()"),
        ("TOCOL", "TOCOL()"),
        ("TODAY", "TODAY()"),
        ("TOROW", "TOROW()"),
        ("TRANSPOSE", "TRANSPOSE()"),
        ("TRIM", "TRIM()"),
        ("TRIMMEAN", "TRIMMEAN()"),
        ("TRUE", "TRUE()"),
        ("TRUNC", "TRUNC()"),
        ("TYPE", "TYPE()"),
        ("UNICHAR", "UNICHAR()"),
        ("UNICODE", "UNICODE()"),
        ("UNIQUE", "UNIQUE()"),
        ("UPPER", "UPPER()"),
        ("VALUE", "VALUE()"),
        ("VALUETOTEXT", "VALUETOTEXT()"),
        ("VAR", "VAR()"),
        ("VAR.P", "VAR.P()"),
        ("VAR.S", "VAR.S()"),
        ("VARP", "VARP()"),
        ("VLOOKUP", "VLOOKUP()"),
        ("VSTACK", "VSTACK()"),
        ("WEEKDAY", "WEEKDAY()"),
        ("WEEKNUM", "WEEKNUM()"),
        ("WORKDAY", "WORKDAY()"),
        ("WORKDAY.INTL", "WORKDAY.INTL()"),
        ("WRAPCOLS", "WRAPCOLS()"),
        ("WRAPROWS", "WRAPROWS()"),
        ("XIRR", "XIRR()"),
        ("XLOOKUP", "XLOOKUP()"),
        ("XMATCH", "XMATCH()"),
        ("XNPV", "XNPV()"),
        ("XOR", "XOR()"),
        ("Y", "Y()"),
        ("YD", "YD()"),
        ("YEAR", "YEAR()"),
        ("YEARFRAC", "YEARFRAC()"),
        ("YM", "YM()"),
        ];
        let mut missing = vec![];
        for (name, call) in cases {
            if evaluate(&wb, 1, Some(CellKey::new(4, 2)), call) == Value::Error(ErrorKind::Name) {
                missing.push(*name);
            }
        }
        println!("implemented: {} of {}", cases.len() - missing.len(), cases.len());
        println!("not functions or unimplemented: {:?}", missing);
    }
}
