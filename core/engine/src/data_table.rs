//! FILENAME: core/engine/src/data_table.rs
//! PURPOSE: Excel's LIVE data table -- the `{=TABLE(row_input, col_input)}`
//!          array formula every cell of a What-If Data Table's body holds --
//!          as a stored marker the app's calculation pass refreshes.
//! CONTEXT: Data > What-If Analysis > Data Table. Excel [LIVE, Excel 16 over
//! COM, 2026-11-04] writes the body as ONE array formula: every body cell's
//! formula bar shows `=TABLE(,A1)` (a one-variable table with a COLUMN input
//! cell), `=TABLE(A1,)` (a ROW input cell) or `=TABLE(A1,D1)` (two variables:
//! row input, then column input), `HasArray` is true, and the body
//! RECALCULATES WITH THE WORKBOOK: under automatic calculation a change to the
//! input values in its header line, or to anything the table's formula reads,
//! refreshes it; under manual calculation (and "Automatic except for data
//! tables") the body is left for F9, and a table created under manual
//! calculation shows 0 until then. `.xlsx` stores it as `<f t="dataTable"
//! ref="L2:L3" dt2D="0" dtr="0" r1="A1"/>` on the body's top-left cell.
//!
//! WHAT THIS MODULE IS. The body cells hold the call as an ordinary formula
//! AST -- `TABLE` is not a built-in, so the parser yields
//! `BuiltinFunction::Custom("TABLE")` with an omitted argument where Excel's
//! text has none -- which buys three things for free: the references shift
//! with every structural edit exactly as Excel's do (insert a row above the
//! table and `=TABLE(,A1)` becomes `=TABLE(,A2)`), the formula is saved and
//! loaded like any other, and every reader of a body cell is an ordinary
//! dependent. The VALUE is not the evaluator's to compute: a body cell is the
//! table formula's answer with the input cell substituted, which takes a write
//! of the input and a recalculation of its dependents per line -- the what-if
//! substitution the app layer runs (`data_tables.rs`). So the evaluator answers
//! a `TABLE(..)` call with the cell's own STORED value ([`Evaluator`] looks the
//! name up through [`is_table_call`]), and the app's refresh writes the new
//! values after the pass.
//!
//! The body is not recorded anywhere else: a table is the maximal rectangle of
//! cells holding the same `TABLE(..)` call ([`data_tables_in`]). Two tables
//! with DIFFERENT calls never merge. Two with the SAME call can touch -- Excel
//! [LIVE, dtfollow/probe4.ps1] lets a table use another table's body as its
//! input column (K1:L3 and L1:M3, both `=TABLE(,A1)`, M2 showing 120 from
//! L2 = 10) -- and would then be read back as one rectangle computed from the
//! wrong input column. Such a table's marker carries its IDENTITY: a third
//! argument naming its body's top-left cell (`TABLE(,A1,M2)`,
//! [`TableInputs::anchor`]), written by the Data Table command and the `.xlsx`
//! reader only for a body that touches another with the same call
//! ([`touching_table_with_same_inputs`], [`bodies_touch`]). It is a relative
//! reference, so it moves with the table like the inputs do; every other table
//! keeps Excel's two-argument form, and a workbook without one reads as it
//! always did (the maximal rectangles). The formula bar shows the third
//! argument for such a table -- the one place Calcula's text differs from
//! Excel's `{=TABLE(,A1)}`.
//!
//! [`Evaluator`]: crate::evaluator::Evaluator

use crate::cell::Cell;
use crate::coord::{col_to_index, index_to_col};
use crate::grid::Grid;
use parser::ast::{BuiltinFunction, Expression, Value};

/// The function name of the marker, as Excel spells it.
pub const TABLE_FUNCTION: &str = "TABLE";

/// What Excel says when a gesture would change some but not all of a data
/// table's body (an edit, a paste, a clear, a sort, a row inserted through it)
/// [LIVE: "Can't change part of a data table." over COM; the desktop dialog
/// reads "Cannot change part of a data table."].
pub const PART_OF_DATA_TABLE: &str = "Cannot change part of a data table.";

/// What Excel says when `=TABLE(..)` is typed: only the Data Table command can
/// write one [LIVE: entering `=TABLE(,A1)` is refused, by `Range.Formula` and
/// by `Range.FormulaArray` alike].
pub const TABLE_NOT_VALID: &str = "That function isn't valid.";

/// One argument of a `TABLE(row_input, col_input)` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TableInput {
    /// The omitted argument: no input cell in that direction.
    Omitted,
    /// An input cell on the table's own sheet, 0-indexed (row, col).
    Cell(u32, u32),
    /// Anything else -- `#REF!` after the input cell was deleted, a range, a
    /// reference to another sheet. The table cannot be computed; its body
    /// answers `#REF!`.
    Invalid,
}

/// The two inputs of a `TABLE` call: (row input cell, column input cell),
/// and the table's IDENTITY when its marker names one (see the module header).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TableInputs {
    pub row_input: TableInput,
    pub col_input: TableInput,
    /// The body's own top-left cell, named by a third argument
    /// (`TABLE(,A1,M2)`) -- written only for a table whose body touches
    /// another's with the same inputs, so the two stay two tables. `None` for
    /// every other table, whose marker is Excel's two-argument form.
    pub anchor: Option<(u32, u32)>,
}

/// Whether `expr` is a call of the `TABLE` marker (any arguments).
pub fn is_table_call(expr: &Expression) -> bool {
    matches!(
        expr,
        Expression::FunctionCall { func: BuiltinFunction::Custom(name), .. }
            if name.eq_ignore_ascii_case(TABLE_FUNCTION)
    )
}

/// Whether `cell` is a cell of a data table's body.
pub fn is_data_table_cell(cell: &Cell) -> bool {
    cell.ast.as_deref().is_some_and(is_table_call)
}

/// Whether `expr` calls `TABLE` anywhere in its tree -- what refuses a TYPED
/// formula ([`TABLE_NOT_VALID`]): the marker is only ever a whole formula, and
/// only the Data Table command writes it.
pub fn contains_table_call(expr: &Expression) -> bool {
    let mut found = false;
    visit(expr, &mut |e| {
        if is_table_call(e) {
            found = true;
        }
    });
    found
}

fn visit(expr: &Expression, f: &mut dyn FnMut(&Expression)) {
    f(expr);
    match expr {
        Expression::FunctionCall { args, .. } => {
            for a in args {
                visit(a, f);
            }
        }
        Expression::BinaryOp { left, right, .. } => {
            visit(left, f);
            visit(right, f);
        }
        Expression::UnaryOp { operand, .. } => visit(operand, f),
        Expression::Range { start, end, .. } => {
            visit(start, f);
            visit(end, f);
        }
        _ => {}
    }
}

fn table_input(arg: &Expression) -> TableInput {
    match arg {
        Expression::Literal(Value::Blank) => TableInput::Omitted,
        Expression::CellRef { sheet: None, col, row, .. } if *row >= 1 => {
            TableInput::Cell(*row - 1, col_to_index(col))
        }
        _ => TableInput::Invalid,
    }
}

/// The inputs of a `TABLE(row_input, col_input)` call, or `None` when `expr`
/// is not one. A call with the wrong arity, or with both arguments omitted,
/// answers both inputs [`TableInput::Invalid`].
pub fn table_inputs(expr: &Expression) -> Option<TableInputs> {
    if !is_table_call(expr) {
        return None;
    }
    let Expression::FunctionCall { args, .. } = expr else {
        return None;
    };
    let invalid = TableInputs { row_input: TableInput::Invalid, col_input: TableInput::Invalid, anchor: None };
    if args.len() != 2 && args.len() != 3 {
        return Some(invalid);
    }
    let row_input = table_input(&args[0]);
    let col_input = table_input(&args[1]);
    if row_input == TableInput::Omitted && col_input == TableInput::Omitted {
        return Some(invalid);
    }
    let anchor = match args.get(2) {
        None => None,
        Some(arg) => match table_input(arg) {
            TableInput::Cell(r, c) => Some((r, c)),
            _ => return Some(invalid),
        },
    };
    Some(TableInputs { row_input, col_input, anchor })
}

fn input_arg(input: Option<(u32, u32)>) -> Expression {
    match input {
        None => Expression::Literal(Value::Blank),
        Some((row, col)) => Expression::CellRef {
            sheet: None,
            col: index_to_col(col),
            row: row + 1,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: Default::default(),
        },
    }
}

/// The `TABLE(row_input, col_input)` marker a body cell holds. At least one
/// input must be given.
pub fn table_call(row_input: Option<(u32, u32)>, col_input: Option<(u32, u32)>) -> Expression {
    table_call_anchored(row_input, col_input, None)
}

/// [`table_call`] naming the table's identity, its body's top-left cell
/// (`TABLE(,A1,M2)`): for a body touching another with the same inputs.
pub fn table_call_anchored(
    row_input: Option<(u32, u32)>,
    col_input: Option<(u32, u32)>,
    anchor: Option<(u32, u32)>,
) -> Expression {
    let mut args = vec![input_arg(row_input), input_arg(col_input)];
    if anchor.is_some() {
        args.push(input_arg(anchor));
    }
    Expression::FunctionCall {
        func: BuiltinFunction::Custom(TABLE_FUNCTION.to_string()),
        args,
        ref_site_id: Default::default(),
    }
}

/// Whether two body rectangles `(start_row, start_col, end_row, end_col)` share
/// an edge -- side by side over common rows, or stacked over common columns --
/// so that cells holding ONE call over both would read back as one table.
pub fn bodies_touch(a: (u32, u32, u32, u32), b: (u32, u32, u32, u32)) -> bool {
    let rows_meet = a.0 <= b.2 && a.2 >= b.0;
    let cols_meet = a.1 <= b.3 && a.3 >= b.1;
    let side_by_side = rows_meet && (a.3.saturating_add(1) == b.1 || b.3.saturating_add(1) == a.1);
    let stacked = cols_meet && (a.2.saturating_add(1) == b.0 || b.2.saturating_add(1) == a.0);
    side_by_side || stacked
}

/// One live data table: its BODY (inclusive, 0-indexed) and its inputs. The
/// formula row / input column sit one row above and one column left of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DataTableBody {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub inputs: TableInputs,
}

impl DataTableBody {
    /// Whether (row, col) is a cell of the body.
    pub fn contains(&self, row: u32, col: u32) -> bool {
        row >= self.start_row && row <= self.end_row && col >= self.start_col && col <= self.end_col
    }

    /// Whether the rectangle covers EVERY body cell (a gesture that replaces
    /// the whole table, which Excel allows).
    pub fn covered_by(&self, start_row: u32, start_col: u32, end_row: u32, end_col: u32) -> bool {
        start_row <= self.start_row && end_row >= self.end_row && start_col <= self.start_col && end_col >= self.end_col
    }

    /// Whether the rectangle shares at least one cell with the body.
    pub fn overlaps(&self, start_row: u32, start_col: u32, end_row: u32, end_col: u32) -> bool {
        start_row <= self.end_row && end_row >= self.start_row && start_col <= self.end_col && end_col >= self.start_col
    }

    /// Whether this body covers `other`'s body whole.
    pub fn covered_by_body(&self, other: &DataTableBody) -> bool {
        other.covered_by(self.start_row, self.start_col, self.end_row, self.end_col)
    }

    /// The number of body cells.
    pub fn cell_count(&self) -> u64 {
        (self.end_row - self.start_row + 1) as u64 * (self.end_col - self.start_col + 1) as u64
    }
}

/// Every live data table on `grid`, ordered by its top-left body cell (row,
/// then column) so a refresh is deterministic. A table is the maximal rectangle
/// that grows right, then down, from a `TABLE` cell no earlier rectangle took,
/// over cells holding the SAME call.
pub fn data_tables_in(grid: &Grid) -> Vec<DataTableBody> {
    let mut cells: Vec<((u32, u32), TableInputs)> = grid
        .cells
        .iter()
        .filter_map(|(&pos, cell)| cell.ast.as_deref().and_then(table_inputs).map(|inputs| (pos, inputs)))
        .collect();
    if cells.is_empty() {
        return Vec::new();
    }
    cells.sort_unstable_by_key(|(pos, _)| *pos);
    let by_pos: std::collections::HashMap<(u32, u32), TableInputs> = cells.iter().copied().collect();
    let mut taken: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::with_capacity(cells.len());
    let mut tables = Vec::new();
    for &((r0, c0), inputs) in &cells {
        if taken.contains(&(r0, c0)) {
            continue;
        }
        let same = |r: u32, c: u32| by_pos.get(&(r, c)) == Some(&inputs) && !taken.contains(&(r, c));
        let mut c1 = c0;
        while c1 < u32::MAX && same(r0, c1 + 1) {
            c1 += 1;
        }
        let mut r1 = r0;
        while r1 < u32::MAX && (c0..=c1).all(|c| same(r1 + 1, c)) {
            r1 += 1;
        }
        for r in r0..=r1 {
            for c in c0..=c1 {
                taken.insert((r, c));
            }
        }
        tables.push(DataTableBody { start_row: r0, start_col: c0, end_row: r1, end_col: c1, inputs });
    }
    tables
}

/// Whether `grid` holds any data-table cell -- the cheap question a refresh
/// asks first (one root check per formula cell, no allocation).
pub fn has_data_tables(grid: &Grid) -> bool {
    grid.cells.values().any(is_data_table_cell)
}

/// The data table a gesture over the rectangle would change only PART of, if
/// any: one the rectangle overlaps without covering it whole.
pub fn partly_covered_table(
    grid: &Grid,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Option<DataTableBody> {
    let (sr, er) = (start_row.min(end_row), start_row.max(end_row));
    let (sc, ec) = (start_col.min(end_col), start_col.max(end_col));
    if !has_data_tables(grid) {
        return None;
    }
    data_tables_in(grid)
        .into_iter()
        .find(|t| t.overlaps(sr, sc, er, ec) && !t.covered_by(sr, sc, er, ec))
}

/// An existing table, not covered by `body`, whose body shares an edge with
/// `body` and holds the same call -- which [`data_tables_in`] would merge with
/// it into one table. A table `body` covers whole is being replaced, and does
/// not count.
pub fn touching_table_with_same_inputs(grid: &Grid, body: &DataTableBody) -> Option<DataTableBody> {
    if !has_data_tables(grid) {
        return None;
    }
    let rect = |t: &DataTableBody| (t.start_row, t.start_col, t.end_row, t.end_col);
    data_tables_in(grid)
        .into_iter()
        .find(|t| t.inputs == body.inputs && !body.covered_by_body(t) && bodies_touch(rect(t), rect(body)))
}

/// The data table a set of written CELLS changes only part of, if any: one some
/// of whose body cells are written while others are not.
pub fn partly_written_table(grid: &Grid, cells: &[(u32, u32)]) -> Option<DataTableBody> {
    if cells.is_empty() || !has_data_tables(grid) {
        return None;
    }
    let written: std::collections::HashSet<(u32, u32)> = cells.iter().copied().collect();
    data_tables_in(grid).into_iter().find(|t| {
        let hit = written.iter().filter(|&&(r, c)| t.contains(r, c)).count() as u64;
        hit > 0 && hit < t.cell_count()
    })
}

/// A structural edit of whole rows (`rows = true`) or columns that would cut
/// THROUGH a data table: lines `[at, at + count)` inserted (`insert = true`)
/// or deleted. The whole-line case of [`band_edit_cuts_table`] (the band is
/// every perpendicular line).
pub fn structural_edit_cuts_table(grid: &Grid, rows: bool, insert: bool, at: u32, count: u32) -> Option<DataTableBody> {
    band_edit_cuts_table(grid, rows, insert, at, count, 0, u32::MAX)
}

/// A BAND EDIT that would cut through a data table -- Insert / Delete Cells
/// shifting cells along rows (`along_rows = true`: shift down / up, the band
/// is the columns `band_start..=band_end`) or along columns (shift right /
/// left, the band is rows), lines `[at, at + count)` of the band inserted
/// (`insert = true`) or deleted; a whole-line edit is the band of every line.
///
/// THE TABLE IS ITS WHOLE RANGE, not only its body: the formula row above the
/// body and the input column left of it belong to it. Excel [LIVE, Excel 16
/// over COM, 2026-11-05, dtfollow/probe1.ps1, table K1:L4 with body L2:L4]
/// refuses with "Can't change part of a data table." every edit that moves
/// SOME but not all of that range or deletes part of it without deleting the
/// whole body:
/// - inserting row 3 or row 2 (between the formula row and the body), column
///   L (between the input column and the body), cells L3 / L1 / L1:L4 shifted
///   down, K3 / K2:K4 shifted right;
/// - deleting row 3, row 1 (the formula row), column K (the input column),
///   cells L3 / L1 shifted up, K3 shifted left;
/// and allows: inserting row 1 or column K (the whole table moves), row 5
/// below it, K1:L4 shifted down (the whole range moves), M3 shifted right;
/// deleting rows 2:4 or column L (the whole BODY goes, and the table with
/// it), L2:L4 shifted up, L6 shifted up.
pub fn band_edit_cuts_table(
    grid: &Grid,
    along_rows: bool,
    insert: bool,
    at: u32,
    count: u32,
    band_start: u32,
    band_end: u32,
) -> Option<DataTableBody> {
    if count == 0 || !has_data_tables(grid) {
        return None;
    }
    let last = at.saturating_add(count - 1);
    data_tables_in(grid).into_iter().find(|t| {
        // (along, across) extents of the body; the range adds one line before
        // each (the formula row / the input column).
        let ((lo, hi), (plo, phi)) = if along_rows {
            ((t.start_row, t.end_row), (t.start_col, t.end_col))
        } else {
            ((t.start_col, t.end_col), (t.start_row, t.end_row))
        };
        let (rlo, rplo) = (lo.saturating_sub(1), plo.saturating_sub(1));
        let range_meets_band = band_start <= phi && band_end >= rplo;
        let range_in_band = band_start <= rplo && phi <= band_end;
        // The cells the edit moves: the band, from `at` on.
        let moves_some = range_meets_band && hi >= at;
        let moves_all = range_in_band && rlo >= at;
        if insert {
            return moves_some && !moves_all;
        }
        let deletes_body = band_start <= plo && phi <= band_end && at <= lo && last >= hi;
        if deletes_body {
            return false;
        }
        let deletes_some = range_meets_band && at <= hi && last >= rlo;
        deletes_some || (moves_some && !moves_all)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_cell(row_input: Option<(u32, u32)>, col_input: Option<(u32, u32)>) -> Cell {
        Cell::new_formula_with_ast(table_call(row_input, col_input))
    }

    #[test]
    fn the_marker_round_trips_through_the_parser_as_excel_spells_it() {
        let ast = table_call(None, Some((0, 0)));
        assert_eq!(crate::ast_render::render_formula(&ast), "TABLE(,A1)");
        let parsed = parser::parse("=TABLE(,A1)").expect("=TABLE(,A1) parses");
        assert_eq!(
            table_inputs(&parsed),
            Some(TableInputs { row_input: TableInput::Omitted, col_input: TableInput::Cell(0, 0), anchor: None })
        );
        let two = parser::parse("=TABLE(A1,D1)").unwrap();
        assert_eq!(
            table_inputs(&two),
            Some(TableInputs { row_input: TableInput::Cell(0, 0), col_input: TableInput::Cell(0, 3), anchor: None })
        );
        assert_eq!(crate::ast_render::render_formula(&table_call(Some((0, 0)), None)), "TABLE(A1,)");
        assert!(table_inputs(&parser::parse("=SUM(A1)").unwrap()).is_none());
    }

    #[test]
    fn tables_are_the_maximal_rectangles_of_one_call() {
        let mut g = Grid::new();
        // Table 1: L2:L3, column input A1. Table 2: U2:V3, two-variable.
        for r in 1..=2 {
            g.set_cell(r, 11, body_cell(None, Some((0, 0))));
            for c in 20..=21 {
                g.set_cell(r, c, body_cell(Some((0, 0)), Some((0, 3))));
            }
        }
        g.set_cell(0, 11, Cell::new_formula("=B1".to_string()));
        let tables = data_tables_in(&g);
        assert_eq!(tables.len(), 2);
        assert_eq!((tables[0].start_row, tables[0].start_col, tables[0].end_row, tables[0].end_col), (1, 11, 2, 11));
        assert_eq!((tables[1].start_row, tables[1].start_col, tables[1].end_row, tables[1].end_col), (1, 20, 2, 21));
        assert!(partly_covered_table(&g, 1, 11, 1, 11).is_some(), "one body cell of two is part of the table");
        assert!(partly_covered_table(&g, 1, 11, 2, 12).is_none(), "a rectangle covering the whole body replaces it");
        assert!(partly_written_table(&g, &[(1, 20), (1, 21), (2, 20)]).is_some());
        assert!(partly_written_table(&g, &[(1, 20), (1, 21), (2, 20), (2, 21)]).is_none());
        assert!(structural_edit_cuts_table(&g, true, true, 2, 1).is_some(), "a row inserted inside the body");
        assert!(structural_edit_cuts_table(&g, true, true, 0, 1).is_none(), "a row inserted above the table");
        assert!(structural_edit_cuts_table(&g, true, false, 1, 1).is_some(), "part of the body deleted");
        assert!(structural_edit_cuts_table(&g, true, false, 1, 2).is_none(), "every body row deleted");
    }

    /// Excel [LIVE, dtfollow/probe1.ps1]: the table is its whole range (formula
    /// row + input column + body), and an edit that moves or deletes part of
    /// it is refused unless it deletes the whole body. The one-variable table
    /// K1:L4 (body L2:L4, 0-indexed rows 1..=3, column 11), every case probed.
    #[test]
    fn a_band_edit_that_cuts_the_tables_range_is_refused_as_excel_refuses_it() {
        let mut g = Grid::new();
        for r in 1..=3 {
            g.set_cell(r, 11, body_cell(None, Some((0, 0))));
        }
        let rows_ins = |at| structural_edit_cuts_table(&g, true, true, at, 1).is_some();
        let rows_del = |at, n| structural_edit_cuts_table(&g, true, false, at, n).is_some();
        let cols_ins = |at| structural_edit_cuts_table(&g, false, true, at, 1).is_some();
        let cols_del = |at| structural_edit_cuts_table(&g, false, false, at, 1).is_some();
        // Whole lines.
        assert!(rows_ins(2), "insert row 3 (inside the body)");
        assert!(rows_ins(1), "insert row 2 (between the formula row and the body)");
        assert!(!rows_ins(4), "insert row 5 (below)");
        assert!(!rows_ins(0), "insert row 1 (above: the table moves whole)");
        assert!(cols_ins(11), "insert column L (between the input column and the body)");
        assert!(!cols_ins(10), "insert column K (left: the table moves whole)");
        assert!(rows_del(2, 1), "delete row 3 (part of the body)");
        assert!(!rows_del(1, 3), "delete rows 2:4 (the whole body)");
        assert!(rows_del(0, 1), "delete row 1 (the formula row)");
        assert!(cols_del(10), "delete column K (the input column)");
        assert!(!cols_del(11), "delete column L (the whole body)");
        // Insert / Delete Cells: (along_rows, insert, at, count, band).
        let band = |along_rows, insert, at, count, b0, b1| band_edit_cuts_table(&g, along_rows, insert, at, count, b0, b1).is_some();
        assert!(band(true, true, 2, 1, 11, 11), "L3 shifted down");
        assert!(!band(true, true, 4, 1, 11, 11), "L5 shifted down (below)");
        assert!(band(true, true, 0, 1, 11, 11), "L1 shifted down (pushes the body)");
        assert!(band(true, true, 0, 4, 11, 11), "L1:L4 shifted down (one column of the range)");
        assert!(!band(true, true, 0, 4, 10, 11), "K1:L4 shifted down (the whole range moves)");
        assert!(band(false, true, 10, 1, 2, 2), "K3 shifted right (pushes L3)");
        assert!(band(false, true, 10, 1, 1, 3), "K2:K4 shifted right (the body, not its formula row)");
        assert!(!band(false, true, 12, 1, 2, 2), "M3 shifted right");
        assert!(band(true, false, 2, 1, 11, 11), "L3 deleted up");
        assert!(!band(true, false, 1, 3, 11, 11), "L2:L4 deleted up (the whole body)");
        assert!(band(false, false, 10, 1, 2, 2), "K3 deleted left (pulls L3)");
        assert!(!band(true, false, 5, 1, 11, 11), "L6 deleted up (below)");
        assert!(band(true, false, 0, 1, 11, 11), "L1 deleted up (pulls the body up)");
    }

    #[test]
    fn the_evaluator_answers_a_table_call_with_the_cells_stored_value() {
        use crate::evaluator::{EvalContext, EvalResult, Evaluator, MultiSheetContext};
        let mut g = Grid::new();
        let mut cell = body_cell(None, Some((0, 0)));
        cell.value = crate::cell::CellValue::Number(42.0);
        g.set_cell(1, 11, cell);
        g.set_cell(0, 0, Cell::new_number(7.0));
        let ctx = EvalContext { current_row: Some(1), current_col: Some(11), ..Default::default() };
        let ms = MultiSheetContext::new("Sheet1".to_string());
        let ev = Evaluator::with_context(&g, ms, ctx);
        assert_eq!(ev.evaluate(&table_call(None, Some((0, 0)))), EvalResult::Number(42.0));
    }

    /// rev-dt-9 / rev-xlsx-5: two touching tables with the same inputs stay TWO
    /// when the second names its identity (`TABLE(,A1,M2)`), and the identity
    /// round-trips through the parser. Excel [LIVE, dtfollow/probe4.ps1] lets
    /// K1:L3 and L1:M3 both use column input A1.
    /// SABOTAGE: ignore the third argument in `table_inputs`.
    #[test]
    fn touching_tables_with_the_same_inputs_stay_apart_by_their_identity() {
        let anchored = table_call_anchored(None, Some((0, 0)), Some((1, 12)));
        assert_eq!(crate::ast_render::render_formula(&anchored), "TABLE(,A1,M2)");
        let parsed = parser::parse("=TABLE(,A1,M2)").unwrap();
        assert_eq!(table_inputs(&parsed).and_then(|i| i.anchor), Some((1, 12)));
        let mut g = Grid::new();
        for r in 1..=2 {
            g.set_cell(r, 11, body_cell(None, Some((0, 0))));
            g.set_cell(r, 12, Cell::new_formula_with_ast(anchored.clone()));
        }
        let tables = data_tables_in(&g);
        assert_eq!(tables.len(), 2, "MERGED: the touching tables read back as one");
        assert_eq!((tables[0].start_col, tables[0].end_col), (11, 11));
        assert_eq!((tables[1].start_col, tables[1].end_col), (12, 12));
        assert!(bodies_touch((1, 11, 2, 11), (1, 12, 2, 12)));
        assert!(!bodies_touch((1, 11, 2, 11), (1, 13, 2, 13)), "a column apart");
        assert!(bodies_touch((1, 11, 2, 11), (3, 11, 4, 11)), "stacked");
    }
}
