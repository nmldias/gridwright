//! Reverse dependencies: which formulas read a given cell.
//!
//! The engine keeps every formula's dependency rectangles in its cell (`Cell::deps`). Finding the
//! formulas that read a changed cell used to mean testing every formula's rectangles, once per
//! step of the recalculation, so a chain of n formulas cost n² rectangle tests. `DepIndex` holds
//! the same rectangles the other way round: small ones cell by cell, tall ones per column, and the
//! rest per table. The engine keeps it equal to the cells' `deps` (`Engine::sync_index`).

use std::collections::HashMap;

use crate::model::{CellRef, Rect, TableId};

/// Rectangles of at most this many cells are indexed cell by cell.
const SMALL_AREA: u64 = 64;
/// Larger rectangles of at most this many columns are indexed per column (`A:A`, `B2:D5000`).
const TALL_COLS: u32 = 16;

#[derive(Default)]
pub struct DepIndex {
    /// Each indexed formula and the rectangles it was indexed with.
    entries: HashMap<CellRef, Vec<Rect>>,
    /// Small rectangles: cell → formulas reading it.
    cells: HashMap<CellRef, Vec<CellRef>>,
    /// Tall rectangles: (table, column) → (first row, last row, formula).
    columns: HashMap<(TableId, u32), Vec<(u32, u32, CellRef)>>,
    /// Wide rectangles, per table.
    wide: HashMap<TableId, Vec<(Rect, CellRef)>>,
}

impl DepIndex {
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    /// The rectangles `formula` is indexed with.
    pub fn deps(&self, formula: &CellRef) -> Option<&Vec<Rect>> {
        self.entries.get(formula)
    }
    pub fn formulas(&self) -> impl Iterator<Item = &CellRef> {
        self.entries.keys()
    }
    pub fn clear(&mut self) {
        *self = DepIndex::default();
    }
    /// Index `formula` as reading `deps` (replacing what it was indexed with).
    pub fn set(&mut self, formula: CellRef, deps: Vec<Rect>) {
        self.remove(formula);
        for rect in &deps {
            let area = (rect.rows() as u64) * (rect.cols() as u64);
            if area <= SMALL_AREA {
                for r in rect.r0..=rect.r1 {
                    for c in rect.c0..=rect.c1 {
                        self.cells.entry(CellRef::new(rect.table, r, c)).or_default().push(formula);
                    }
                }
            } else if rect.cols() <= TALL_COLS {
                for c in rect.c0..=rect.c1 {
                    self.columns.entry((rect.table, c)).or_default().push((rect.r0, rect.r1, formula));
                }
            } else {
                self.wide.entry(rect.table).or_default().push((*rect, formula));
            }
        }
        self.entries.insert(formula, deps);
    }
    pub fn remove(&mut self, formula: CellRef) {
        let Some(deps) = self.entries.remove(&formula) else {
            return;
        };
        for rect in &deps {
            let area = (rect.rows() as u64) * (rect.cols() as u64);
            if area <= SMALL_AREA {
                for r in rect.r0..=rect.r1 {
                    for c in rect.c0..=rect.c1 {
                        let at = CellRef::new(rect.table, r, c);
                        if let Some(list) = self.cells.get_mut(&at) {
                            list.retain(|f| *f != formula);
                            if list.is_empty() {
                                self.cells.remove(&at);
                            }
                        }
                    }
                }
            } else if rect.cols() <= TALL_COLS {
                for c in rect.c0..=rect.c1 {
                    if let Some(list) = self.columns.get_mut(&(rect.table, c)) {
                        list.retain(|e| e.2 != formula);
                        if list.is_empty() {
                            self.columns.remove(&(rect.table, c));
                        }
                    }
                }
            } else if let Some(list) = self.wide.get_mut(&rect.table) {
                list.retain(|e| e.1 != formula);
                if list.is_empty() {
                    self.wide.remove(&rect.table);
                }
            }
        }
    }
    /// Formulas with a rectangle containing a cell of `set`, each once.
    pub fn dependents(&self, set: &CellSet) -> Vec<CellRef> {
        let mut out = vec![];
        for (&(table, col), rows) in &set.cols {
            for &row in rows {
                if let Some(list) = self.cells.get(&CellRef::new(table, row, col)) {
                    out.extend(list.iter().copied());
                }
            }
            if let Some(list) = self.columns.get(&(table, col)) {
                for &(r0, r1, f) in list {
                    if any_between(rows, r0, r1) {
                        out.push(f);
                    }
                }
            }
        }
        for table in set.tables.keys() {
            if let Some(list) = self.wide.get(table) {
                for (rect, f) in list {
                    if set.any_in(rect) {
                        out.push(*f);
                    }
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }
}

/// A set of cells grouped by column, for rectangle queries.
#[derive(Default)]
pub struct CellSet {
    /// (table, column) → sorted rows.
    cols: HashMap<(TableId, u32), Vec<u32>>,
    /// table → sorted columns holding a cell of the set.
    tables: HashMap<TableId, Vec<u32>>,
}

impl CellSet {
    pub fn new<'a>(cells: impl IntoIterator<Item = &'a CellRef>) -> CellSet {
        let mut set = CellSet::default();
        for r in cells {
            set.cols.entry((r.table, r.col)).or_default().push(r.row);
        }
        for (&(table, col), rows) in set.cols.iter_mut() {
            rows.sort_unstable();
            rows.dedup();
            set.tables.entry(table).or_default().push(col);
        }
        for cols in set.tables.values_mut() {
            cols.sort_unstable();
        }
        set
    }
    pub fn is_empty(&self) -> bool {
        self.cols.is_empty()
    }
    /// The rows of the set in `table`, column `col`, from `r0` to `r1`.
    fn rows_in(&self, table: TableId, col: u32, r0: u32, r1: u32) -> &[u32] {
        match self.cols.get(&(table, col)) {
            Some(rows) => {
                let a = rows.partition_point(|&r| r < r0);
                let b = rows.partition_point(|&r| r <= r1);
                &rows[a..b]
            }
            None => &[],
        }
    }
    /// The columns of the set in `table` from `c0` to `c1`.
    fn cols_in(&self, table: TableId, c0: u32, c1: u32) -> &[u32] {
        match self.tables.get(&table) {
            Some(cols) => {
                let a = cols.partition_point(|&c| c < c0);
                let b = cols.partition_point(|&c| c <= c1);
                &cols[a..b]
            }
            None => &[],
        }
    }
    /// Does `rect` contain a cell of the set?
    pub fn any_in(&self, rect: &Rect) -> bool {
        self.cols_in(rect.table, rect.c0, rect.c1)
            .iter()
            .any(|&c| !self.rows_in(rect.table, c, rect.r0, rect.r1).is_empty())
    }
    /// The cells of the set inside `rect`.
    pub fn cells_in(&self, rect: &Rect, out: &mut Vec<CellRef>) {
        for &c in self.cols_in(rect.table, rect.c0, rect.c1) {
            for &r in self.rows_in(rect.table, c, rect.r0, rect.r1) {
                out.push(CellRef::new(rect.table, r, c));
            }
        }
    }
}

/// Does the sorted `rows` hold a value from `r0` to `r1`?
fn any_between(rows: &[u32], r0: u32, r1: u32) -> bool {
    let i = rows.partition_point(|&r| r < r0);
    i < rows.len() && rows[i] <= r1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(table: TableId, r0: u32, c0: u32, r1: u32, c1: u32) -> Rect {
        Rect { table, r0, c0, r1, c1 }
    }
    fn at(table: TableId, row: u32, col: u32) -> CellRef {
        CellRef::new(table, row, col)
    }
    fn deps(ix: &DepIndex, cells: &[CellRef]) -> Vec<CellRef> {
        ix.dependents(&CellSet::new(cells))
    }

    #[test]
    fn small_tall_and_wide_rectangles_find_their_formulas() {
        let mut ix = DepIndex::default();
        let (f1, f2, f3) = (at(1, 0, 5), at(1, 1, 5), at(2, 0, 0));
        ix.set(f1, vec![rect(1, 0, 0, 1, 1)]); // A1:B2, small
        ix.set(f2, vec![rect(1, 0, 0, 9999, 0)]); // A:A, tall
        ix.set(f3, vec![rect(1, 10, 0, 20, 99)]); // 100 columns, wide (another table)
        assert_eq!(deps(&ix, &[at(1, 0, 0)]), vec![f1, f2]);
        assert_eq!(deps(&ix, &[at(1, 1, 1)]), vec![f1]);
        assert_eq!(deps(&ix, &[at(1, 15, 0)]), vec![f2, f3]);
        assert_eq!(deps(&ix, &[at(1, 15, 50)]), vec![f3]);
        assert_eq!(deps(&ix, &[at(1, 21, 50), at(1, 9, 99), at(1, 5, 3)]), vec![]);
        assert_eq!(deps(&ix, &[at(2, 0, 0)]), vec![]);
        // re-indexing replaces, removing forgets
        ix.set(f2, vec![rect(1, 100, 0, 200, 0)]);
        assert_eq!(deps(&ix, &[at(1, 0, 0)]), vec![f1]);
        assert_eq!(deps(&ix, &[at(1, 150, 0)]), vec![f2]);
        ix.remove(f1);
        ix.remove(f3);
        assert_eq!(deps(&ix, &[at(1, 0, 0), at(1, 15, 50)]), vec![]);
        assert_eq!(ix.len(), 1);
        ix.remove(f2);
        assert!(ix.cells.is_empty() && ix.columns.is_empty() && ix.wide.is_empty());
    }

    #[test]
    fn a_formula_reading_a_cell_twice_is_listed_once_and_removed_completely() {
        let mut ix = DepIndex::default();
        let f = at(1, 3, 3);
        ix.set(f, vec![rect(1, 0, 0, 0, 0), rect(1, 0, 0, 0, 0), rect(1, 0, 0, 99, 0)]);
        assert_eq!(ix.dependents(&CellSet::new(&[at(1, 0, 0)])), vec![f]);
        ix.remove(f);
        assert!(ix.cells.is_empty() && ix.columns.is_empty());
    }

    #[test]
    fn cell_sets_answer_rectangle_queries() {
        let cells = [at(1, 5, 2), at(1, 7, 2), at(1, 5, 9), at(2, 0, 0)];
        let set = CellSet::new(&cells);
        assert!(set.any_in(&rect(1, 6, 0, 8, 2)));
        assert!(!set.any_in(&rect(1, 6, 3, 8, 8)));
        assert!(!set.any_in(&rect(3, 0, 0, 100, 100)));
        let mut out = vec![];
        set.cells_in(&rect(1, 0, 0, 10, 10), &mut out);
        assert_eq!(out, vec![at(1, 5, 2), at(1, 7, 2), at(1, 5, 9)]);
    }
}
