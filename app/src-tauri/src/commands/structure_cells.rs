//! FILENAME: app/src-tauri/src/commands/structure_cells.rs
//! PURPOSE: Excel's Insert Cells / Delete Cells -- shift cells right, down,
//!          left or up INSIDE THE BAND of rows or columns the range covers.
//! CONTEXT: A child of `structure` (declared with `#[path]` there), so it
//!          reuses that file's reference rewriters, store shifters and lock
//!          discipline instead of copying them: a copied rewriter is a second
//!          source of truth, and this file's whole subject is what happens to
//!          a reference when cells move.
//!
//! WHAT A "BAND EDIT" IS. Insert Cells on B2:C3 with "Shift cells down" is a
//! row insert of 2 rows at row 2 that happens ONLY in columns B..C: every cell
//! of B..C at or below row 2 moves down two rows, every other cell stays. So
//! the edit is a whole-line `StructuralEdit` (the along-axis move) plus the
//! perpendicular BAND it is confined to. Right/Left are the column twins.
//!
//! THE RULES, measured on live Excel 16 (Microsoft 365, build 20326,
//! 2026-10-04, fresh hidden instances driven over COM; probe scripts and their
//! output are in the rust-structure lane's scratchpad). Each one is pinned by a
//! test in `structure_cells_tests.rs`.
//!
//! 1. REFERENCES move only when the referenced rectangle lies ENTIRELY inside
//!    the band. Insert B2:C3 down: `=B5` -> `=B7`, `=SUM(B5:C5)` -> `B7:C7`,
//!    but `=SUM(A1:B10)`, `=SUM(B1:D10)`, `=SUM(A5:D5)` and `=SUM(A2:Z4)`
//!    (Right) keep their address. A reference that moves follows the whole-row
//!    (whole-column) rule along the shift axis: `=SUM(B1:B2)` -> `B1:B4` (the
//!    insertion falls inside it), `=SUM(B2:B5)` with B2:C3 deleted -> `B2:B3`,
//!    `=SUM(B2:B3)` deleted whole -> `#REF!`. Whole-column (`B:B`) and
//!    whole-row (`5:5`) references never change. This holds on every sheet and
//!    in defined names.
//! 2. THE SHEET EDGE. A single reference pushed past the last row/column is
//!    `#REF!` (`=B1048575` + 2 rows); a RANGE that reaches the last row keeps
//!    reaching it (`=SUM(B10:B1048576)` -> `B12:B1048576` on insert, `B8:B1048576`
//!    on delete). Inserting is REFUSED when a non-empty cell -- a value, a
//!    formula or only formatting -- would be pushed off the sheet.
//! 3. CELL-ANCHORED THINGS move with their cell: formulas, values, formatting,
//!    notes, comments, hyperlinks, cell types, controls.
//! 4. CONDITIONAL FORMATS AND DATA VALIDATION are cut per cell: the part of a
//!    range inside the band moves (as a reference, rule 1), the parts outside
//!    stay. Insert B2:C3 down with a rule on A8:D9 -> A8:A9, D8:D9, B10:C11.
//! 5. INSERTED CELLS TAKE THE FORMAT OF THEIR NEIGHBOUR -- the cell above
//!    (shift down) or to the left (shift right): its style, its data
//!    validation and its conditional formats. Excel's "Format Same As Above".
//! 6. MERGED CELLS inside the band move (and grow/shrink like a reference; one
//!    shrunk to a single cell is dropped). A merge that STRADDLES the band edge
//!    where cells move is unmerged -- after Excel's question "This operation
//!    will cause some merged cells to unmerge. Do you wish to continue?"; Cancel
//!    changes nothing.
//! 7. TABLES inside the band that move whole move; a table cut by the band is
//!    REFUSED ("This won't work because it would move cells in a table on your
//!    worksheet."). Inserting/deleting exactly the table's columns inside its
//!    data rows grows/shrinks it; a table keeps at least one data row; its
//!    header row cannot be deleted.
//! 8. PIVOTTABLES cut by the band are refused with Excel's sentence.
//! 9. A PROTECTED SHEET refuses Insert/Delete Cells whatever its options
//!    (AllowInsertingRows/Columns and unlocked cells do not help -- measured).
//! 10. SPILLS are never refused: a spill that moves whole moves; one the edit
//!    cuts is re-evaluated where its formula now lives (and may show
//!    `#SPILL!`, as Excel's does).
//!
//! CALCULA-ONLY REFUSALS, each named in its message: a protected region (a
//! PivotTable, a report) is refused whenever the edit would MOVE it, even whole
//! (Excel moves a whole pivot; Calcula has no undo record for a pivot's
//! position yet); a table whose COLUMN count would change; a table deleted
//! whole; a filtered AutoFilter range or a writeback region being designed
//! that the edit reaches.

use super::*;
use crate::api_types::CellShiftResult;
use crate::commands::coord_shift::CellRange;
use calp::writeback::{interval_delete, interval_insert, StructuralEdit as SE};

#[cfg(test)]
#[path = "structure_cells_tests.rs"]
mod tests;

// ============================================================================
// The messages (Excel's sentences where Excel has one)
// ============================================================================

/// Excel's question for a merge the band cuts, measured live.
pub(crate) const UNMERGE_QUESTION: &str =
    "This operation will cause some merged cells to unmerge. Do you wish to continue?";
/// Excel's sentence for a table the band cuts, measured live.
pub(crate) const TABLE_REFUSAL: &str =
    "This won't work because it would move cells in a table on your worksheet.";
/// Excel's sentence for a PivotTable the band cuts, measured live.
pub(crate) const PIVOT_REFUSAL: &str = "We can't make this change for the selected cells because it will affect a PivotTable. Use the field list to change the report. If you are trying to insert or delete cells, move the PivotTable and try again.";
/// Excel's sentence for cells pushed off the sheet, measured live.
pub(crate) const PUSH_OFF_REFUSAL: &str = "Calcula can't insert new cells because it would push non-empty cells off the end of the worksheet. These non-empty cells might appear empty but have blank values, some formatting, or a formula. Delete enough rows or columns to make room for what you want to insert and then try again.";
const TABLE_HEADER_REFUSAL: &str =
    "This won't work because it would delete the header row of a table on your worksheet.";
const TABLE_COLUMNS_REFUSAL: &str = "Calcula can't add or remove table columns by shifting cells yet. Insert or delete entire columns, or use Table Design > Resize Table.";
const TABLE_WHOLE_REFUSAL: &str = "Calcula can't delete a whole table by shifting cells. Delete the table first, or delete entire rows or columns.";
const FILTER_REFUSAL: &str =
    "This won't work because it would move cells in a filtered range. Clear the filter first.";
const WRITEBACK_DRAFT_REFUSAL: &str = "This won't work because it would move cells of a writeback region you are designing. Move or remove the region first.";

// ============================================================================
// The shift and the band
// ============================================================================

/// Which way the cells move: Excel's four "Shift cells ..." radio buttons. The
/// dialogs' other two ("Entire row", "Entire column") are row/column commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CellShift {
    Right,
    Down,
    Left,
    Up,
}

impl CellShift {
    /// The `shift` argument of `insert_cells`.
    pub(crate) fn parse_insert(text: &str) -> Result<Self, String> {
        match text {
            "right" => Ok(CellShift::Right),
            "down" => Ok(CellShift::Down),
            other => Err(format!(
                "Unknown insert shift \"{}\": expected \"right\" or \"down\" \
                 (entire rows and columns are inserted with insert_rows / insert_columns).",
                other
            )),
        }
    }

    /// The `shift` argument of `delete_cells`.
    pub(crate) fn parse_delete(text: &str) -> Result<Self, String> {
        match text {
            "left" => Ok(CellShift::Left),
            "up" => Ok(CellShift::Up),
            other => Err(format!(
                "Unknown delete shift \"{}\": expected \"left\" or \"up\" \
                 (entire rows and columns are deleted with delete_rows / delete_columns).",
                other
            )),
        }
    }
}

/// A whole-line structural edit confined to a perpendicular BAND.
///
/// `edit` is the along-axis move (a row edit for Down/Up, a column edit for
/// Right/Left). `band_start..=band_end` are the columns (row edits) or rows
/// (column edits) it happens in. Everything that decides "does this move?"
/// lives here, so cells, references, merges, tables and rule ranges cannot
/// disagree about it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BandEdit {
    pub(crate) edit: SE,
    pub(crate) band_start: u32,
    pub(crate) band_end: u32,
}

impl BandEdit {
    /// The band edit for a range (any corner order) and a shift.
    pub(crate) fn new(start_row: u32, start_col: u32, end_row: u32, end_col: u32, shift: CellShift) -> Self {
        let (r0, r1) = (start_row.min(end_row), start_row.max(end_row));
        let (c0, c1) = (start_col.min(end_col), start_col.max(end_col));
        match shift {
            CellShift::Down => BandEdit { edit: SE::RowInsert { at: r0, count: r1 - r0 + 1 }, band_start: c0, band_end: c1 },
            CellShift::Up => BandEdit { edit: SE::RowDelete { at: r0, count: r1 - r0 + 1 }, band_start: c0, band_end: c1 },
            CellShift::Right => BandEdit { edit: SE::ColInsert { at: c0, count: c1 - c0 + 1 }, band_start: r0, band_end: r1 },
            CellShift::Left => BandEdit { edit: SE::ColDelete { at: c0, count: c1 - c0 + 1 }, band_start: r0, band_end: r1 },
        }
    }

    /// True when cells move along ROWS (Down/Up), so the band is a set of columns.
    /// A WHOLE-LINE edit (Insert/Delete Sheet Rows or Columns) as the band that
    /// spans every perpendicular line.
    ///
    /// ONE RULE, NOT TWO COPIES. A whole-row insert is exactly a band edit whose
    /// band is every column, so every question this type answers -- where a
    /// reference goes, how a range grows or shrinks, what an inserted line
    /// inherits -- has ONE answer for both paths. Before this existed the
    /// whole-line shifters in `structure` decided each END of a range on its own
    /// and turned a range with one deleted end into `#REF!` (`=SUM(A5:A9)`,
    /// delete row 5), and turned a range reaching the sheet's last row into
    /// `#REF!` on any insert (`=SUM(B10:B1048576)`), while Insert/Delete Cells
    /// already did what Excel does (measured live for whole lines too: the
    /// rust-followup lane's probe 1, 2026-10-04).
    pub(crate) fn whole_lines(edit: SE) -> Self {
        let band_end = match edit {
            SE::RowInsert { .. } | SE::RowDelete { .. } => engine::EXCEL_MAX_COL_INDEX,
            SE::ColInsert { .. } | SE::ColDelete { .. } => engine::EXCEL_MAX_ROW_INDEX,
        };
        BandEdit { edit, band_start: 0, band_end }
    }

    pub(crate) fn moves_rows(&self) -> bool {
        matches!(self.edit, SE::RowInsert { .. } | SE::RowDelete { .. })
    }

    pub(crate) fn inserting(&self) -> bool {
        matches!(self.edit, SE::RowInsert { .. } | SE::ColInsert { .. })
    }

    pub(crate) fn at(&self) -> u32 {
        match self.edit {
            SE::RowInsert { at, .. } | SE::RowDelete { at, .. } | SE::ColInsert { at, .. } | SE::ColDelete { at, .. } => at,
        }
    }

    pub(crate) fn count(&self) -> u32 {
        match self.edit {
            SE::RowInsert { count, .. } | SE::RowDelete { count, .. } | SE::ColInsert { count, .. } | SE::ColDelete { count, .. } => count,
        }
    }

    /// The last index on the along axis (0-based).
    fn max_along(&self) -> u32 {
        if self.moves_rows() { engine::EXCEL_MAX_ROW_INDEX } else { engine::EXCEL_MAX_COL_INDEX }
    }

    /// `(along, perp)` of a cell.
    fn split(&self, row: u32, col: u32) -> (u32, u32) {
        if self.moves_rows() { (row, col) } else { (col, row) }
    }

    /// The cell at `(along, perp)`.
    fn join(&self, along: u32, perp: u32) -> (u32, u32) {
        if self.moves_rows() { (along, perp) } else { (perp, along) }
    }

    fn in_band(&self, perp: u32) -> bool {
        perp >= self.band_start && perp <= self.band_end
    }

    /// Where a CELL goes: `None` when the edit deleted it -- or pushed it past
    /// the sheet's far edge, which only an EMPTY cell can reach (the command
    /// refuses to push a non-empty one off, rule 2). A cell outside the band
    /// never moves.
    pub(crate) fn shift_cell(&self, row: u32, col: u32) -> Option<(u32, u32)> {
        let (along, perp) = self.split(row, col);
        if !self.in_band(perp) {
            return Some((row, col));
        }
        let (at, count) = (self.at(), self.count());
        let moved = if self.inserting() {
            if along < at {
                along
            } else if along as u64 + count as u64 > self.max_along() as u64 {
                return None;
            } else {
                along + count
            }
        } else if along >= at + count {
            along - count
        } else if along >= at {
            return None;
        } else {
            along
        };
        Some(self.join(moved, perp))
    }

    /// One along-axis coordinate of a SINGLE-CELL REFERENCE: `None` = `#REF!`
    /// (deleted, or pushed off the sheet).
    pub(crate) fn shift_reference_point(&self, along: u32) -> Option<u32> {
        let (at, count) = (self.at(), self.count());
        if self.inserting() {
            if along < at {
                return Some(along);
            }
            let moved = along as u64 + count as u64;
            if moved > self.max_along() as u64 { None } else { Some(moved as u32) }
        } else if along >= at + count {
            Some(along - count)
        } else if along >= at {
            None
        } else {
            Some(along)
        }
    }

    /// The along-axis interval of a REFERENCE RANGE (rule 1 and rule 2): grows
    /// over an insertion inside it, shrinks over a deletion, `None` when every
    /// cell of it was deleted or it was pushed off the sheet. A range reaching
    /// the sheet's last line keeps reaching it.
    pub(crate) fn shift_reference_interval(&self, start: u32, end: u32) -> Option<(u32, u32)> {
        let (at, count, max) = (self.at(), self.count(), self.max_along());
        if self.inserting() {
            let (s, e) = interval_insert(start, end, at, count);
            if s > max {
                return None;
            }
            Some((s, e.min(max)))
        } else {
            let pinned = end >= max;
            let (s, e) = interval_delete(start, end, at, count)?;
            Some((s, if pinned { max } else { e }))
        }
    }

    fn perp_of(&self, r: &CellRange) -> (u32, u32) {
        if self.moves_rows() { (r.start_col, r.end_col) } else { (r.start_row, r.end_row) }
    }

    fn along_of(&self, r: &CellRange) -> (u32, u32) {
        if self.moves_rows() { (r.start_row, r.end_row) } else { (r.start_col, r.end_col) }
    }

    fn rect(&self, along: (u32, u32), perp: (u32, u32)) -> CellRange {
        if self.moves_rows() {
            CellRange { start_row: along.0, end_row: along.1, start_col: perp.0, end_col: perp.1 }
        } else {
            CellRange { start_row: perp.0, end_row: perp.1, start_col: along.0, end_col: along.1 }
        }
    }

    /// The rectangle's band-axis extent lies entirely inside the band.
    pub(crate) fn within_band(&self, r: &CellRange) -> bool {
        let (p0, p1) = self.perp_of(r);
        p0 >= self.band_start && p1 <= self.band_end
    }

    fn overlaps_band(&self, r: &CellRange) -> bool {
        let (p0, p1) = self.perp_of(r);
        p1 >= self.band_start && p0 <= self.band_end
    }

    /// Does the rectangle reach the part of the band the edit changes -- the
    /// band from `at` to the sheet's far edge? Anything that does not is
    /// untouched by the edit, whatever its shape.
    pub(crate) fn reaches_moving_cells(&self, r: &CellRange) -> bool {
        self.overlaps_band(r) && self.along_of(r).1 >= self.at()
    }

    /// The cells the edit changes, as a rectangle (for the writeback claim gate).
    fn moving_area(&self) -> CellRange {
        self.rect((self.at(), self.max_along()), (self.band_start, self.band_end))
    }

    /// REFERENCE semantics for a rectangle (rule 1): inside the band it moves,
    /// grows, shrinks or vanishes (`None`) exactly as a whole-line edit would
    /// treat it; across the band edge it keeps its address -- with ONE
    /// exception, Excel's TRIM on a delete, measured: when the deleted block
    /// covers the range's whole extent along the shift axis AND one of its ends
    /// across it, what is left is a rectangle and the reference becomes that
    /// rectangle. Delete B2:C3 up: `=SUM(B2:E2)` -> `D2:E2`, `=SUM(C2:D2)` ->
    /// `D2:D2`; delete it left: `=SUM(B3:B10)` -> `B4:B10`, `=SUM(B1:B3)` ->
    /// `B1:B1`. A block in the MIDDLE (`=SUM(A2:D3)`) leaves two pieces, which no
    /// reference can name, so the address stays.
    pub(crate) fn shift_reference_range(&self, r: CellRange) -> Option<CellRange> {
        if !self.reaches_moving_cells(&r) {
            return Some(r);
        }
        if self.within_band(&r) {
            let (s, e) = self.along_of(&r);
            let (ns, ne) = self.shift_reference_interval(s, e)?;
            return Some(self.rect((ns, ne), self.perp_of(&r)));
        }
        if self.inserting() {
            return Some(r);
        }
        let (a0, a1) = self.along_of(&r);
        let (at, count) = (self.at(), self.count());
        if a0 < at || a1 >= at + count {
            return Some(r);
        }
        let (p0, p1) = self.perp_of(&r);
        if p0 >= self.band_start {
            Some(self.rect((a0, a1), (self.band_end + 1, p1)))
        } else if p1 <= self.band_end {
            Some(self.rect((a0, a1), (p0, self.band_start - 1)))
        } else {
            Some(r)
        }
    }

    /// Does any SURVIVING cell of the rectangle change position?
    fn holds_moving_cells(&self, r: &CellRange) -> bool {
        let first_moving = if self.inserting() { self.at() } else { self.at() + self.count() };
        self.overlaps_band(r) && self.along_of(r).1 >= first_moving
    }

    /// CUT semantics for a rule range (rule 4): the part inside the band moves as
    /// a reference, the parts outside stay. Returns the pieces (none when every
    /// cell was deleted).
    ///
    /// A range whose surviving cells all stay where they are (the edit only
    /// DELETED some of them) is treated as a reference instead -- measured:
    /// delete B2:C3 left with a rule on B1:B10 leaves it on B1:B10, while a rule
    /// on D1:D10 (whose D2:D3 do move) becomes D1, D4:D10, B2:B3.
    pub(crate) fn cut_range(&self, r: CellRange) -> Vec<CellRange> {
        if !self.reaches_moving_cells(&r) {
            return vec![r];
        }
        if self.within_band(&r) || !self.holds_moving_cells(&r) {
            return self.shift_reference_range(r).into_iter().collect();
        }
        let (p0, p1) = self.perp_of(&r);
        let along = self.along_of(&r);
        let mut out = Vec::with_capacity(3);
        if p0 < self.band_start {
            out.push(self.rect(along, (p0, self.band_start - 1)));
        }
        if p1 > self.band_end {
            out.push(self.rect(along, (self.band_end + 1, p1)));
        }
        let inside = self.rect(along, (p0.max(self.band_start), p1.min(self.band_end)));
        if let Some(moved) = self.shift_reference_range(inside) {
            out.push(moved);
        }
        out
    }

    /// Rule 5: the cells an insertion adds UNDER a rule range that ends on the
    /// line right before them -- the inserted cells inherit the rule from their
    /// neighbour. `None` for a delete, or when the range does not end there.
    pub(crate) fn inherited_piece(&self, r: &CellRange) -> Option<CellRange> {
        if !self.inserting() || self.at() == 0 || !self.overlaps_band(r) {
            return None;
        }
        let (a0, a1) = self.along_of(r);
        if a1 != self.at() - 1 || a0 > a1 {
            return None;
        }
        let (p0, p1) = self.perp_of(r);
        let last = (self.at() as u64 + self.count() as u64 - 1).min(self.max_along() as u64) as u32;
        Some(self.rect((self.at(), last), (p0.max(self.band_start), p1.min(self.band_end))))
    }

    /// Rules 4 and 5 together, for ONE rule range (a conditional format's or a
    /// data validation's): its pieces after the edit, with the cells an
    /// insertion gave it from its neighbour JOINED onto the piece they continue
    /// rather than listed beside it. Measured (probe 1): a CF on A4:D4 with
    /// three whole rows inserted at row 5 reads back as ONE range, A4:D7. The
    /// cell set is the same either way -- Calcula evaluates a rule per cell --
    /// but a dialog that lists the rule's ranges shows what Excel shows.
    /// Empty when every cell of the range was deleted.
    pub(crate) fn rule_range_pieces(&self, r: CellRange) -> Vec<CellRange> {
        let mut pieces = self.cut_range(r);
        if let Some(inherited) = self.inherited_piece(&r) {
            let (ia0, _) = self.along_of(&inherited);
            let ip = self.perp_of(&inherited);
            match pieces.iter_mut().find(|p| self.perp_of(p) == ip && self.along_of(p).1 + 1 == ia0) {
                Some(p) => {
                    let (a0, _) = self.along_of(p);
                    *p = self.rect((a0, self.along_of(&inherited).1), ip);
                }
                None => pieces.push(inherited),
            }
        }
        pieces
    }
}

/// The most cells one insertion will create to carry its neighbours' format
/// (rule 5 for cells). Excel stores a format for every inserted cell at no
/// cost; Calcula materialises a `Cell` per formatted position, so a row with
/// formatting in all 16,384 columns and 10,000 rows inserted under it would be
/// 160 million cells. Past this the insertion still happens, the inserted lines
/// still take the neighbour's whole-line format (its style tier and its size),
/// and the per-cell part is skipped -- a lost format, never a lost value -- and
/// says so in the log. The same bound `apply_border_preset` puts on tier
/// crossings, for the same reason.
pub(crate) const INHERITED_CELLS_LIMIT: u64 = 2_000_000;

/// Rule 5 for CELLS: every inserted cell takes the style of its neighbour on
/// the line just before the insertion -- the cell above (rows) or to the left
/// (columns), Excel's "Format Same As Above / Left". Only a cell with a style
/// of its own is copied (index 0 inherits its tiers, which the caller carries
/// for whole lines); the copy is an EMPTY cell, never the neighbour's value.
/// An insertion at the first line has no neighbour and inherits nothing
/// (measured: Excel's new row 1 / column A is unformatted).
///
/// Call AFTER the cells have moved, so the inserted lines are empty. Returns
/// the number of cells formatted, or `None` when that would pass
/// [`INHERITED_CELLS_LIMIT`] (and nothing was written).
pub(crate) fn inherit_neighbour_styles(grid: &mut engine::Grid, band: &BandEdit) -> Option<u64> {
    let at = band.at();
    if !band.inserting() || at == 0 {
        return Some(0);
    }
    let neighbours: Vec<(u32, usize)> = grid
        .cells
        .iter()
        .filter_map(|(&(r, c), cell)| {
            let (along, perp) = band.split(r, c);
            (along == at - 1 && band.in_band(perp) && cell.style_index != 0).then_some((perp, cell.style_index))
        })
        .collect();
    let last = (at as u64 + band.count() as u64 - 1).min(band.max_along() as u64) as u32;
    let lines = (last - at) as u64 + 1;
    let total = neighbours.len() as u64 * lines;
    if total > INHERITED_CELLS_LIMIT {
        crate::log_warn!(
            "STRUCT",
            "inserted {} line(s) at {} keep their neighbour's line format but not its {} per-cell format(s): {} cells is over the {} limit",
            lines,
            at,
            neighbours.len(),
            total,
            INHERITED_CELLS_LIMIT
        );
        return None;
    }
    for (perp, style_index) in neighbours {
        for along in at..=last {
            let pos = band.join(along, perp);
            grid.cells.insert(pos, Cell { ast: None, value: engine::CellValue::Empty, style_index, rich_text: None });
        }
    }
    Some(total)
}

// ============================================================================
// Reference rewriting (rule 1 and 2)
// ============================================================================

/// Rewrite every cell reference / cell range in `formula` that targets
/// `edited_sheet` through `band`. `formula_sheet` is the sheet the formula
/// LIVES on (what an unqualified reference means); pass `""` for a text whose
/// unqualified references must never match (a workbook-scoped name).
///
/// Only the A1 cell and cell-range forms can move: a whole-column (`B:B`) or
/// whole-row (`5:5`) reference has no endpoint on the shift axis, and Excel
/// leaves both alone (measured). Strings, structured-reference brackets, quoted
/// sheet names and trim dots are handled by the same `rewrite_outside_strings`
/// choke point every other shifter in `structure` uses.
pub(crate) fn shift_formula_in_band(
    formula: &str,
    formula_sheet: &str,
    edited_sheet: &str,
    band: &BandEdit,
) -> String {
    shift_formula_in_band_noting_reach(formula, formula_sheet, edited_sheet, band).0
}

/// [`shift_formula_in_band`], also answering whether ANY reference to the
/// edited sheet REACHES the cells the edit changes -- rewritten or not.
///
/// The second answer is what a STRADDLING range needs: `=SUM(A1:E12)` across
/// the band B:C keeps its address (rule 1) while the cells inside it move or
/// vanish, so the rewrite reports no change and nothing used to recalculate
/// it (review finding, 2026-10-04). Same walk, same choke point, so "what
/// reaches the edit" cannot disagree with "what the edit rewrites".
pub(crate) fn shift_formula_in_band_noting_reach(
    formula: &str,
    formula_sheet: &str,
    edited_sheet: &str,
    band: &BandEdit,
) -> (String, bool) {
    let reached = std::cell::Cell::new(false);
    let rewritten = rewrite_outside_strings(formula, |segment| {
        replace_all_guarded(&QUALIFIED_REF_RE, segment, |caps| {
            let whole = caps[0].to_string();
            let lead = &caps[1];
            let quoted = caps.get(2).map(|m| m.as_str().to_string());
            let bare = caps.get(3).map(|m| m.as_str().to_string());
            if !qualifier_is_edited_sheet(&quoted, &bare, formula_sheet, edited_sheet) {
                return whole;
            }
            let row1: u32 = caps[7].parse().unwrap_or(0);
            if row1 == 0 {
                return whole;
            }
            let first = (row1 - 1, shift_col_to_index(&caps[5]));
            let second = match (caps.get(9), caps.get(11)) {
                (Some(cl), Some(rn)) => {
                    let row2: u32 = rn.as_str().parse().unwrap_or(0);
                    if row2 == 0 {
                        return whole;
                    }
                    Some((row2 - 1, shift_col_to_index(cl.as_str())))
                }
                _ => None,
            };
            let (r_end, c_end) = second.unwrap_or(first);
            let rect = CellRange {
                start_row: first.0.min(r_end),
                end_row: first.0.max(r_end),
                start_col: first.1.min(c_end),
                end_col: first.1.max(c_end),
            };
            if !band.reaches_moving_cells(&rect) {
                return whole;
            }
            reached.set(true);
            // Where each WRITTEN endpoint goes. A single cell is a point (#REF!
            // when deleted or pushed off); a range is a rectangle (rule 1 and its
            // trim), and an inverted range stays inverted.
            let (new_first, new_second) = match second {
                None => {
                    let (along, perp) = band.split(first.0, first.1);
                    match band.shift_reference_point(along) {
                        Some(a) => (band.join(a, perp), None),
                        None => return format!("{}{}", lead, REF_ERROR),
                    }
                }
                Some(end) => {
                    let Some(n) = band.shift_reference_range(rect) else {
                        return format!("{}{}", lead, REF_ERROR);
                    };
                    if n == rect {
                        return whole;
                    }
                    // Each written endpoint takes the new rectangle's side it was
                    // on. A TIE (a one-row or one-column range) puts the first
                    // endpoint on the low side and the second on the high side:
                    // picking "low" for both collapsed a last-row range that a
                    // delete GROWS (`=SUM(B1048576:C1048576)` with B2:C3 deleted
                    // up is `B1048574:C1048576` in Excel, measured) back to one
                    // row, `B1048574:C1048574`.
                    let pick_first = |mine: u32, other: u32, lo: u32, hi: u32| if mine <= other { lo } else { hi };
                    let pick_second = |mine: u32, other: u32, lo: u32, hi: u32| if mine >= other { hi } else { lo };
                    (
                        (pick_first(first.0, end.0, n.start_row, n.end_row), pick_first(first.1, end.1, n.start_col, n.end_col)),
                        Some((pick_second(end.0, first.0, n.start_row, n.end_row), pick_second(end.1, first.1, n.start_col, n.end_col))),
                    )
                }
            };
            // `$` markers are kept; letters are re-spelled only when the column
            // actually changed, so `b5` keeps its case where it did not move.
            let render = |col_abs: &str, letters: &str, row_abs: &str, old: (u32, u32), new: (u32, u32)| -> String {
                let col_text = if new.1 == old.1 { letters.to_string() } else { shift_index_to_col(new.1) };
                format!("{}{}{}{}", col_abs, col_text, row_abs, new.0 + 1)
            };
            let mut out = format!(
                "{}{}{}",
                lead,
                qualifier_prefix(&quoted, &bare),
                render(&caps[4], &caps[5], &caps[6], first, new_first)
            );
            if let (Some(n2), Some(end), Some(ca2), Some(cl2), Some(ra2)) =
                (new_second, second, caps.get(8), caps.get(9), caps.get(10))
            {
                out.push(':');
                out.push_str(&render(ca2.as_str(), cl2.as_str(), ra2.as_str(), end, n2));
            }
            out
        })
    });
    (rewritten, reached.get())
}

// ============================================================================
// Plans: what the edit would do to the objects that can refuse it
// ============================================================================

/// What the edit does to one table (rule 7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TablePlan {
    Untouched,
    /// The table's new rectangle (moved, grown or shrunk).
    Reshape(CellRange),
    Refuse(&'static str),
}

/// Rule 7, for one table rectangle.
pub(crate) fn plan_table(band: &BandEdit, t: CellRange, header_row: bool, totals_row: bool) -> TablePlan {
    if !band.reaches_moving_cells(&t) {
        return TablePlan::Untouched;
    }
    if !band.within_band(&t) {
        return TablePlan::Refuse(TABLE_REFUSAL);
    }
    let (at, count) = (band.at(), band.count());
    let (a0, a1) = band.along_of(&t);
    let perp = band.perp_of(&t);
    let exact = perp == (band.band_start, band.band_end);
    if band.inserting() {
        if a0 >= at {
            if a1 as u64 + count as u64 > band.max_along() as u64 {
                return TablePlan::Refuse(TABLE_REFUSAL);
            }
            return TablePlan::Reshape(band.rect((a0 + count, a1 + count), perp));
        }
        // The insertion falls INSIDE the table (below its first line).
        if !exact {
            return TablePlan::Refuse(TABLE_REFUSAL);
        }
        if !band.moves_rows() {
            return TablePlan::Refuse(TABLE_COLUMNS_REFUSAL);
        }
        if a1 as u64 + count as u64 > band.max_along() as u64 {
            return TablePlan::Refuse(TABLE_REFUSAL);
        }
        return TablePlan::Reshape(band.rect((a0, a1 + count), perp));
    }
    let (d0, d1) = (at, at + count - 1);
    if a0 > d1 {
        return TablePlan::Reshape(band.rect((a0 - count, a1 - count), perp));
    }
    // The deleted lines reach the table.
    if !exact {
        return TablePlan::Refuse(TABLE_REFUSAL);
    }
    if d0 <= a0 && d1 >= a1 {
        return TablePlan::Refuse(TABLE_WHOLE_REFUSAL);
    }
    if !band.moves_rows() {
        return TablePlan::Refuse(TABLE_COLUMNS_REFUSAL);
    }
    if d0 <= a0 {
        // The deletion eats the table's first row.
        return TablePlan::Refuse(if header_row { TABLE_HEADER_REFUSAL } else { TABLE_REFUSAL });
    }
    if totals_row && d1 >= a1 {
        return TablePlan::Refuse(TABLE_REFUSAL);
    }
    let data_start = if header_row { a0 + 1 } else { a0 };
    let mut new_end = if d1 >= a1 { d0 - 1 } else { a1 - count };
    if new_end < data_start {
        // Every data row went: Excel keeps ONE (measured -- the table's last
        // row now holds what was below it).
        if totals_row {
            return TablePlan::Refuse(TABLE_REFUSAL);
        }
        new_end = data_start;
    }
    let next = band.rect((a0, new_end), perp);
    // The only data row deleted: the table keeps its rectangle (its last row
    // now holds what was below it), so there is nothing to reshape or undo.
    if next == t { TablePlan::Untouched } else { TablePlan::Reshape(next) }
}

/// What the edit does to one merged region (rule 6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MergePlan {
    Untouched,
    /// Moved/grown/shrunk to this rectangle.
    Reshape(CellRange),
    /// Shrunk to one cell, or deleted with its cells: no longer a merge.
    Drop,
    /// Straddles the band where cells move: must be unmerged (Excel asks first).
    Cut,
}

pub(crate) fn plan_merge(band: &BandEdit, m: CellRange) -> MergePlan {
    if !band.reaches_moving_cells(&m) {
        return MergePlan::Untouched;
    }
    if !band.within_band(&m) {
        return MergePlan::Cut;
    }
    match band.shift_reference_range(m) {
        None => MergePlan::Drop,
        Some(n) if n.start_row == n.end_row && n.start_col == n.end_col => MergePlan::Drop,
        Some(n) => MergePlan::Reshape(n),
    }
}

fn merge_rect(m: &crate::api_types::MergedRegion) -> CellRange {
    CellRange { start_row: m.start_row, end_row: m.end_row, start_col: m.start_col, end_col: m.end_col }
}

fn to_merge(r: CellRange) -> crate::api_types::MergedRegion {
    crate::api_types::MergedRegion { start_row: r.start_row, start_col: r.start_col, end_row: r.end_row, end_col: r.end_col }
}

/// A stored cell counts as NON-EMPTY for the push-off refusal when it holds a
/// value, a formula or its own formatting -- Excel refuses a fill-only cell too.
fn cell_is_non_empty(cell: &Cell) -> bool {
    cell.ast.is_some() || !matches!(cell.value, engine::CellValue::Empty) || cell.style_index != 0
}

/// THE ONE ROOM RULE FOR EVERY INSERT: Insert Cells (a band), Insert Sheet
/// Rows / Columns on the active sheet, and the same on another sheet (the
/// off-sheet path a group or a script takes). `grid` is the sheet the insert
/// lands on; a whole-line insert passes `BandEdit::whole_lines`.
///
/// Refuses, before anything changes:
///  - an insert of NOTHING (count 0) -- the band path cannot build one, a
///    whole-line caller could;
///  - an insertion point past the sheet, or more lines than fit between it and
///    the sheet's far edge (the inserted block itself would leave the sheet);
///  - Excel's push-off (rule 2): a non-empty cell -- a value, a formula, or only
///    formatting -- that the insert would push past the far edge.
///
/// Before this existed only the band path asked the push-off question, so
/// Select All + Insert -- which the band path hands to the whole-row insert --
/// moved every cell of the sheet past row 1,048,576 (review finding,
/// 2026-10-04). Same predicate, same sentence, every path.
pub(crate) fn ensure_insert_fits(grid: &engine::Grid, band: &BandEdit) -> Result<(), String> {
    if !band.inserting() {
        return Ok(());
    }
    let (at, count, max) = (band.at(), band.count(), band.max_along());
    let lines = if band.moves_rows() { "rows" } else { "columns" };
    if count == 0 {
        return Err(format!("Nothing to insert: the number of {} must be at least 1.", lines));
    }
    if at > max || at as u64 + count as u64 > max as u64 + 1 {
        return Err(format!(
            "Cannot insert {} {} there: the sheet has room for only {} more {} from that point.",
            count,
            lines,
            (max as u64 + 1).saturating_sub(at as u64),
            lines
        ));
    }
    let limit = max as u64 + 1 - count as u64;
    let pushed_off = grid.cells.iter().any(|(&(r, c), cell)| {
        let (along, perp) = band.split(r, c);
        band.in_band(perp) && along as u64 >= limit && cell_is_non_empty(cell)
    });
    if pushed_off {
        return Err(PUSH_OFF_REFUSAL.to_string());
    }
    Ok(())
}

// ============================================================================
// The commands
// ============================================================================

/// Excel's Insert Cells: shift the cells of the range right or down, inside the
/// band of rows (columns) the range covers. `shift` is `"right"` or `"down"`.
///
/// `unmerge_cut_merges`: a merge the band cuts makes the command STOP and
/// return `{ applied: false, confirm: <Excel's question> }` without changing
/// anything; the caller asks the user and calls again with `true` to unmerge
/// and go on (rule 6).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn insert_cells(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    shift: String,
    unmerge_cut_merges: Option<bool>,
) -> Result<CellShiftResult, String> {
    let shift = CellShift::parse_insert(&shift)?;
    shift_cells_impl(
        &state, &file_state, &pivot_state, &user_files_state, &pane_control_state,
        &ribbon_filter_state, &slicer_state, &timeline_state,
        start_row, start_col, end_row, end_col, shift, unmerge_cut_merges.unwrap_or(false),
    )
}

/// Excel's Delete Cells: remove the range's cells and shift the rest of the
/// band left or up. `shift` is `"left"` or `"up"`. See `insert_cells` for
/// `unmerge_cut_merges`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn delete_cells(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    shift: String,
    unmerge_cut_merges: Option<bool>,
) -> Result<CellShiftResult, String> {
    let shift = CellShift::parse_delete(&shift)?;
    shift_cells_impl(
        &state, &file_state, &pivot_state, &user_files_state, &pane_control_state,
        &ribbon_filter_state, &slicer_state, &timeline_state,
        start_row, start_col, end_row, end_col, shift, unmerge_cut_merges.unwrap_or(false),
    )
}

/// The body of both commands, over plain references (a `#[tauri::command]`
/// cannot be called from a unit test -- same split as `insert_rows_impl`).
///
/// PHASE 0 takes the grid pair FIRST (`lock_pending`) and runs every gate and
/// every plan under it, changing nothing: the merge, table and push-off plans
/// read the same cells the write then moves, with no window between them for
/// another command to change those cells (CLAUDE.md: never decide under one
/// guard and write under a re-acquired one -- review finding, 2026-10-04).
/// PHASE 1 captures the snapshot from the held grid, opens ONE undo transaction, constructs the
/// `DocumentEffect` (after every gate, so a refusal leaves the document clean),
/// moves the cells and every store that remembers a position, and commits.
/// PHASE 2 drops every guard and only then rebuilds the dependency maps and
/// recalculates (the two-phase rule in CLAUDE.md: the recalculation takes the
/// same mutexes and std mutexes are not reentrant).
#[allow(clippy::too_many_arguments)]
pub(crate) fn shift_cells_impl(
    state: &AppState,
    file_state: &FileState,
    pivot_state: &PivotState,
    user_files_state: &crate::persistence::UserFilesState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    shift: CellShift,
    unmerge_cut_merges: bool,
) -> Result<CellShiftResult, String> {
    if start_row.max(end_row) > engine::EXCEL_MAX_ROW_INDEX || start_col.max(end_col) > engine::EXCEL_MAX_COL_INDEX {
        return Err("The range is outside the sheet.".to_string());
    }
    let band = BandEdit::new(start_row, start_col, end_row, end_col, shift);
    let inserting = band.inserting();
    let what = if inserting { "insert cells" } else { "delete cells" };

    // WHOLE ROWS / COLUMNS. Excel inserts (deletes) entire rows for a range that
    // spans every column, whatever shift was asked for, and entire columns for
    // one that spans every row (measured: rows 2:3 with "shift right" inserted
    // rows). Those are the existing commands, with their own gates and undo.
    let (r0, r1) = (start_row.min(end_row), start_row.max(end_row));
    let (c0, c1) = (start_col.min(end_col), start_col.max(end_col));
    let full_width = c0 == 0 && c1 >= engine::EXCEL_MAX_COL_INDEX;
    let full_height = r0 == 0 && r1 >= engine::EXCEL_MAX_ROW_INDEX;
    if full_width || full_height {
        let applied = match (full_width, inserting) {
            (true, true) => insert_rows_impl(state, file_state, pivot_state, user_files_state, pane_control_state, ribbon_filter_state, slicer_state, timeline_state, r0, r1 - r0 + 1, None),
            (true, false) => delete_rows_impl(state, file_state, pivot_state, user_files_state, pane_control_state, ribbon_filter_state, slicer_state, timeline_state, r0, r1 - r0 + 1, None),
            (false, true) => insert_columns_impl(state, file_state, pivot_state, user_files_state, pane_control_state, ribbon_filter_state, slicer_state, timeline_state, c0, c1 - c0 + 1, None),
            (false, false) => delete_columns_impl(state, file_state, pivot_state, user_files_state, pane_control_state, ribbon_filter_state, slicer_state, timeline_state, c0, c1 - c0 + 1, None),
        };
        applied?;
        return Ok(CellShiftResult { applied: true, confirm: None, whole_lines: true });
    }

    // ------------------------------------------------------------------
    // PHASE 0: gates. Nothing below may change anything before PHASE 1.
    // ------------------------------------------------------------------

    // The grid pair FIRST, held from the first gate to the last write (the
    // canonical order: grid, grids, then everything else). No gate below takes
    // either. The active sheet is read under them, so the sheet the gates ask
    // about is the sheet the mirror holds.
    let grid = state.grid.lock_pending().map_err(|e| e.to_string())?;
    let grids = state.grids.lock_pending().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;

    // A canvas has no cells; a protected sheet refuses Insert/Delete Cells
    // whatever its options (rule 9 -- Excel greys the items out).
    crate::sheets::ensure_not_canvas_in_state(state, active_sheet, what)?;
    {
        let protection = state.sheet_protection.read().map_err(|e| e.to_string())?;
        if protection.get(&active_sheet).map(|p| p.protected).unwrap_or(false) {
            return Err(format!(
                "Cannot {} on a protected sheet. Unprotect the sheet first (Review > Unprotect Sheet).",
                what
            ));
        }
    }

    let moving = band.moving_area();
    // Published writeback regions: the signed claim does not move with the cells.
    crate::calp_commands::ensure_range_unclaimed(
        state,
        if inserting { "insert cells here" } else { "delete cells here" },
        moving.start_row,
        moving.start_col,
        moving.end_row,
        moving.end_col,
    )?;
    // Writeback regions being designed: refused rather than half-moved.
    {
        let sheet_id = state.sheet_ids.read().map_err(|e| e.to_string())?.get(active_sheet).copied();
        let drafts = state.writeback_draft_regions.read().map_err(|e| e.to_string())?;
        if let Some(sid) = sheet_id {
            let reached = drafts.iter().any(|d| {
                d.selector.sheet_id == sid
                    && band.reaches_moving_cells(&CellRange {
                        start_row: d.selector.row_start,
                        end_row: d.selector.row_end,
                        start_col: d.selector.col_start,
                        end_col: d.selector.col_end,
                    })
            });
            if reached {
                return Err(WRITEBACK_DRAFT_REFUSAL.to_string());
            }
        }
    }

    // PivotTables and every other protected region (rule 8 + the Calcula-only
    // refusal): reached at all = refused.
    {
        let regions = state.protected_regions.lock().map_err(|e| e.to_string())?;
        for region in regions.iter().filter(|r| r.sheet_index == active_sheet) {
            let rect = CellRange {
                start_row: region.start_row,
                end_row: region.end_row,
                start_col: region.start_col,
                end_col: region.end_col,
            };
            if band.reaches_moving_cells(&rect) {
                return Err(if region.region_type == "pivot" {
                    PIVOT_REFUSAL.to_string()
                } else {
                    format!(
                        "This won't work because it would move part of a {} on your worksheet. Move it first.",
                        region.region_type
                    )
                });
            }
        }
    }

    // Tables (rule 7).
    let table_plans: Vec<(crate::tables::Table, CellRange)> = {
        let tables = state.tables.read().map_err(|e| e.to_string())?;
        let mut plans = Vec::new();
        if let Some(sheet_tables) = tables.get(&active_sheet) {
            for table in sheet_tables.values() {
                let rect = CellRange {
                    start_row: table.start_row,
                    end_row: table.end_row,
                    start_col: table.start_col,
                    end_col: table.end_col,
                };
                match plan_table(&band, rect, table.style_options.header_row, table.style_options.total_row) {
                    TablePlan::Untouched => {}
                    TablePlan::Refuse(message) => return Err(message.to_string()),
                    TablePlan::Reshape(next) => plans.push((table.clone(), next)),
                }
            }
        }
        plans
    };

    // A FILTERED AutoFilter range the edit reaches: its hidden rows are whole
    // rows and cannot follow a band of cells.
    {
        let filters = state.auto_filters.read().map_err(|e| e.to_string())?;
        if let Some(af) = filters.get(&active_sheet) {
            let rect = CellRange { start_row: af.start_row, end_row: af.end_row, start_col: af.start_col, end_col: af.end_col };
            if !af.hidden_rows.is_empty() && band.reaches_moving_cells(&rect) {
                return Err(FILTER_REFUSAL.to_string());
            }
        }
    }

    // Merges (rule 6): plan every one; a cut merge stops here to ASK.
    let merge_plans: Vec<(crate::api_types::MergedRegion, MergePlan)> = {
        let merges = state.merged_regions.read().map_err(|e| e.to_string())?;
        merges
            .iter()
            .map(|m| (m.clone(), plan_merge(&band, merge_rect(m))))
            .filter(|(_, plan)| *plan != MergePlan::Untouched)
            .collect()
    };
    if !unmerge_cut_merges && merge_plans.iter().any(|(_, p)| *p == MergePlan::Cut) {
        return Ok(CellShiftResult { applied: false, confirm: Some(UNMERGE_QUESTION.to_string()), whole_lines: false });
    }

    // Push-off (rule 2): the one room rule every insert path shares.
    ensure_insert_fits(&grid, &band)?;

    // ------------------------------------------------------------------
    // PHASE 1: the edit, one undo transaction.
    // ------------------------------------------------------------------

    let description = match shift {
        CellShift::Right | CellShift::Down => "Insert Cells",
        CellShift::Left | CellShift::Up => "Delete Cells",
    };

    // From the HELD grid: the snapshot is of the very cells the gates read.
    let snapshot = capture_grid_snapshot_of(state, active_sheet, &grid);

    // Cloned, not held: BUG-0045's lock order (see insert_rows).
    let sheet_names_snapshot: Vec<String> = state.sheet_names.read().map(|n| n.clone()).unwrap_or_default();
    let edited_sheet_name = sheet_names_snapshot.get(active_sheet).cloned().unwrap_or_default();
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;

    let owned_txn = undo_stack.begin_owned_transaction(description.to_string());
    undo_stack.record_snapshot(snapshot);
    // The snapshot restores a spill's cells but not the maps that say which
    // origin owns them; without this an undo turned a moved spill into
    // `#SPILL!` (measured). No `?` from here to the commit below: an early
    // return would strand the open transaction.
    record_spill_claims_for_undo(state, &mut undo_stack, active_sheet);
    // Past every gate above and inside the open transaction: committed.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);

    // Table undo entries are recorded HERE (inside the transaction) from the
    // plan's own copies; the writes land after the grid guards drop, in the
    // order `insert_rows` uses for tables.
    for (table, _) in &table_plans {
        undo_stack.record_custom_restore(
            "obj_table".to_string(),
            crate::undo_commands::table_snapshot_bytes(active_sheet, table.id, Some(table.clone())),
            "Shift table",
        );
    }

    shift_cell_types_in_band(state, &effect, &mut undo_stack, active_sheet, &band);
    shift_cell_behaviors_in_band(state, &effect, &mut undo_stack, active_sheet, &band);
    shift_auto_filter_in_band(state, &effect, &mut undo_stack, active_sheet, &band, &table_plans);
    shift_cell_maps_in_band(state, &effect, &mut undo_stack, active_sheet, &band);
    shift_misc_stores_in_band(state, &effect, &mut undo_stack, active_sheet, &band);
    let names_rewritten = shift_named_ranges_in_band(state, &effect, &mut undo_stack, active_sheet, &edited_sheet_name, &band);
    shift_range_strings_in_band(state, &effect, &mut undo_stack, active_sheet, &edited_sheet_name, &band);
    shift_controls_in_band(state, &effect, &mut undo_stack, active_sheet, &band);
    shift_rule_ranges_in_band(state, &effect, &mut undo_stack, active_sheet, &band);
    let cross_sheet_rewritten = shift_cross_sheet_formulas_in_band(
        &mut undo_stack, &mut grids, active_sheet, &edited_sheet_name, &sheet_names_snapshot, &band,
    );
    undo_stack.commit_owned(owned_txn);
    drop(undo_stack);

    // D8 seeds (see `StructuralSeeds`): POST-edit coordinates throughout.
    let mut seeds = {
        let column_dependents = state.column_dependents.lock().map_err(|e| e.to_string())?;
        let row_dependents = state.row_dependents.lock().map_err(|e| e.to_string())?;
        StructuralSeeds::new(&column_dependents, &row_dependents)
    };

    // SPILLS (rule 10). A spill whose origin and every cell move by the same
    // offset is re-keyed; any other the edit reaches loses its derived output
    // cells and is re-evaluated where its formula now lives.
    let respill = shift_spills_in_band(state, &effect, &mut grid, active_sheet, &band);

    // Formulas on this sheet (rule 1). Rewritten on the PRE-move grid: a
    // reference means the same cells wherever its formula sits.
    let all_cells: Vec<((u32, u32), Cell)> = grid.cells.iter().map(|(&p, c)| (p, c.clone())).collect();
    for ((r, c), cell) in &all_cells {
        if let Some(formula) = formula_to_rewrite(cell) {
            let updated = shift_formula_in_band(&formula, &edited_sheet_name, &edited_sheet_name, &band);
            if updated != formula {
                let mut next = cell.clone();
                if store_rewritten_formula(&mut next, &updated, description, *r, *c) {
                    grid.cells.insert((*r, *c), next);
                    if let Some(pos) = band.shift_cell(*r, *c) {
                        seeds.rewritten(pos);
                    }
                }
            }
        }
    }

    // The cells themselves (rule 3): lift every in-band cell from `at` on, then
    // put the survivors down at their new positions -- two passes, so a moved
    // cell can never land on one not yet lifted.
    let at = band.at();
    let lifted: Vec<((u32, u32), Cell)> = grid
        .cells
        .iter()
        .filter(|(&(r, c), _)| {
            let (along, perp) = band.split(r, c);
            band.in_band(perp) && along >= at
        })
        .map(|(&p, cell)| (p, cell.clone()))
        .collect();
    for (pos, _) in &lifted {
        grid.cells.remove(pos);
    }
    for ((r, c), cell) in lifted {
        // Kind 3 (stripe coverage): the old position's content changed.
        seeds.moved((r, c), false);
        if let Some(pos) = band.shift_cell(r, c) {
            seeds.moved(pos, cell.formula_string().is_some());
            grid.cells.insert(pos, cell);
        }
    }

    // Rule 5: inserted cells take their neighbour's format (the one helper the
    // whole-line inserts use too).
    inherit_neighbour_styles(&mut grid, &band);

    grid.recalculate_bounds();
    if active_sheet < grids.len() {
        grids[active_sheet].cells = grid.cells.clone();
        grids[active_sheet].max_row = grid.max_row;
        grids[active_sheet].max_col = grid.max_col;
    }
    drop(grids);
    drop(grid);

    // Merges (rule 6) and tables (rule 7): after the grid guards drop, the
    // order `insert_rows` uses; the snapshot above restores the merges and the
    // `obj_table` entries the tables.
    if let Ok(mut merges) = state.merged_regions.write(&effect) {
        for (old, plan) in &merge_plans {
            merges.remove(old);
            if let MergePlan::Reshape(next) = plan {
                merges.insert(to_merge(*next));
            }
        }
    }
    if !table_plans.is_empty() {
        let mut tables = state.tables.write(&effect).map_err(|e| e.to_string())?;
        if let Some(sheet_tables) = tables.get_mut(&active_sheet) {
            for (table, next) in &table_plans {
                if let Some(t) = sheet_tables.get_mut(&table.id) {
                    t.start_row = next.start_row;
                    t.end_row = next.end_row;
                    t.start_col = next.start_col;
                    t.end_col = next.end_col;
                }
            }
        }
    }

    // IdRegistry: the identities of the cells that moved move with them.
    {
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        if let Some(&sid) = sheet_ids.get(active_sheet) {
            let mut registry = state.id_registry.lock().map_err(|e| e.to_string())?;
            let affected: Vec<((u32, u32), identity::CellId)> = registry
                .cells_in_sheet(sid)
                .map(|m| {
                    m.iter()
                        .filter(|(&(r, c), _)| {
                            let (along, perp) = band.split(r, c);
                            band.in_band(perp) && along >= at
                        })
                        .map(|(&p, &id)| (p, id))
                        .collect()
                })
                .unwrap_or_default();
            for (pos, _) in &affected {
                registry.remove_cell_id(sid, *pos);
            }
            for ((r, c), id) in affected {
                if let Some(pos) = band.shift_cell(r, c) {
                    registry.register_cell_with_id(sid, pos, id);
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // PHASE 2: no guard held. Edges from the re-pointed ASTs, then recalc.
    // ------------------------------------------------------------------
    crate::undo_commands::rebuild_all_dependencies(state);
    // Every formula that READS a cell the edit changed, from the rebuilt edges:
    // a range that STRADDLES the band keeps its address, so the rewrite above
    // never touched it, while the cells inside it moved or vanished.
    let (band_readers, reader_sheets) = readers_of_band(state, active_sheet, &edited_sheet_name, &band);
    let mut off_sheet_recalc = cross_sheet_rewritten;
    for sheet in reader_sheets {
        if !off_sheet_recalc.contains(&sheet) {
            off_sheet_recalc.push(sheet);
        }
    }
    recalc_structural_side_effects(
        state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        &off_sheet_recalc,
        &names_rewritten,
    );
    for pos in respill.into_iter().chain(band_readers) {
        seeds.rewritten(pos);
    }
    let seeds = seeds.finish();
    let mut recalculated: Vec<CellData> = Vec::new();
    crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
        state,
        user_files_state,
        pane_control_state,
        ribbon_filter_state,
        &seeds,
        &mut recalculated,
    );

    Ok(CellShiftResult { applied: true, confirm: None, whole_lines: false })
}

/// The readers of the cells a band edit changed (the band from `at` to the
/// sheet's far edge), from the REBUILT dependency maps: same-sheet cell edges
/// (defined names are expanded into them by the rebuild), whole-column and
/// whole-row edges over the area, and the OTHER sheets whose cross-sheet edges
/// land in it. Returns the reader positions (to seed) and those sheets (to
/// recalculate). The edges are the graph's own answer, so a reader the text
/// scan cannot see -- a name, a whole-column reference -- is found the same way.
///
/// Holds no guard on entry and takes the four maps one after another, never
/// nested, so it adds no ordering edge (PHASE 2 rule).
fn readers_of_band(
    state: &AppState,
    active_sheet: usize,
    edited_sheet_name: &str,
    band: &BandEdit,
) -> (Vec<(u32, u32)>, Vec<usize>) {
    let area = band.moving_area();
    let inside = |r: u32, c: u32| r >= area.start_row && r <= area.end_row && c >= area.start_col && c <= area.end_col;
    let mut readers: Vec<(u32, u32)> = Vec::new();
    if let Ok(dependents) = state.dependents.lock() {
        for (&(r, c), deps) in dependents.iter() {
            if inside(r, c) {
                readers.extend(deps.iter().copied());
            }
        }
    }
    if let Ok(column_dependents) = state.column_dependents.lock() {
        for (&col, deps) in column_dependents.iter() {
            if col >= area.start_col && col <= area.end_col {
                readers.extend(deps.iter().copied());
            }
        }
    }
    if let Ok(row_dependents) = state.row_dependents.lock() {
        for (&row, deps) in row_dependents.iter() {
            if row >= area.start_row && row <= area.end_row {
                readers.extend(deps.iter().copied());
            }
        }
    }
    let mut sheets: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    if let Ok(cross) = state.cross_sheet_dependents.lock() {
        for ((name, r, c), deps) in cross.iter() {
            if name.eq_ignore_ascii_case(edited_sheet_name) && inside(*r, *c) {
                sheets.extend(deps.iter().map(|&(s, _, _)| s).filter(|&s| s != active_sheet));
            }
        }
    }
    readers.sort_unstable();
    readers.dedup();
    (readers, sheets.into_iter().collect())
}

// ============================================================================
// The per-store shifts. Each runs inside the open transaction, records its own
// pre-shift state when (and only when) it changed something, and takes its own
// store lock -- the same contract as the whole-line helpers in `structure`.
// ============================================================================

/// Cell-type assignments are keyed by cell: they move with it (rule 3).
fn shift_cell_types_in_band(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    band: &BandEdit,
) {
    let Ok(mut store) = state.cell_types.write(effect) else { return };
    let previous = crate::cell_types::entries_for_sheet(&store, sheet);
    let keys: Vec<(usize, u32, u32)> = store
        .keys()
        .filter(|(s, r, c)| *s == sheet && band.shift_cell(*r, *c) != Some((*r, *c)))
        .copied()
        .collect();
    if keys.is_empty() {
        return;
    }
    let lifted: Vec<_> = keys.iter().filter_map(|k| store.remove(k).map(|v| (*k, v))).collect();
    for ((s, r, c), value) in lifted {
        if let Some((nr, nc)) = band.shift_cell(r, c) {
            store.insert((s, nr, nc), value);
        }
    }
    undo_stack.record_custom_restore(
        "obj_cell_types".to_string(),
        crate::undo_commands::cell_types_snapshot_bytes(sheet, previous),
        "Shift cell types",
    );
}

/// Cell-behavior bindings target a RANGE: reference semantics (rule 1); a
/// target whose every cell was deleted orphans, as on a row delete.
fn shift_cell_behaviors_in_band(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    band: &BandEdit,
) {
    let Ok(mut store) = state.cell_behaviors.write(effect) else { return };
    let previous = crate::cell_behaviors::all_bindings(&store);
    let mut changed = false;
    for b in store.values_mut().filter(|b| b.sheet_index == sheet && !b.orphaned) {
        let r = CellRange { start_row: b.start_row, end_row: b.end_row, start_col: b.start_col, end_col: b.end_col };
        match band.shift_reference_range(r) {
            Some(n) if n == r => {}
            Some(n) => {
                b.start_row = n.start_row;
                b.end_row = n.end_row;
                b.start_col = n.start_col;
                b.end_col = n.end_col;
                changed = true;
            }
            None => {
                b.orphaned = true;
                changed = true;
            }
        }
    }
    if changed {
        undo_stack.record_custom_restore(
            "obj_cell_behaviors".to_string(),
            crate::undo_commands::cell_behaviors_snapshot_bytes(previous),
            "Shift cell behaviors",
        );
    }
}

/// The sheet's AutoFilter is a range: reference semantics. One inside the band
/// takes the whole-line shift (which also re-keys its column criteria); one
/// that straddles keeps its address. A table-owned filter ends on its table's
/// new rectangle (the table keeps one data row where the reference rule would
/// not).
fn shift_auto_filter_in_band(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    band: &BandEdit,
    table_plans: &[(crate::tables::Table, CellRange)],
) {
    let (rect, id) = {
        let Ok(filters) = state.auto_filters.read() else { return };
        let Some(af) = filters.get(&sheet) else { return };
        (CellRange { start_row: af.start_row, end_row: af.end_row, start_col: af.start_col, end_col: af.end_col }, af.id)
    };
    if !band.within_band(&rect) || !band.reaches_moving_cells(&rect) {
        return;
    }
    let owner = table_plans.iter().find(|(t, _)| t.auto_filter_id == Some(id)).map(|(_, next)| *next);
    match owner {
        Some(next) => {
            let Ok(mut filters) = state.auto_filters.write(effect) else { return };
            let Some(af) = filters.get_mut(&sheet) else { return };
            let before = af.clone();
            af.start_row = next.start_row;
            af.end_row = next.end_row;
            af.start_col = next.start_col;
            af.end_col = next.end_col;
            drop(filters);
            record_auto_filter_shift(undo_stack, sheet, before);
        }
        None => shift_sheet_auto_filter(state, effect, undo_stack, sheet, band.edit),
    }
}

/// Comments, notes and hyperlinks are keyed by cell (rule 3).
fn shift_cell_maps_in_band(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    band: &BandEdit,
) {
    use crate::commands::coord_shift::CellAnchored;

    fn shift_map<T: CellAnchored + Clone>(
        map: &mut HashMap<usize, HashMap<(u32, u32), T>>,
        sheet: usize,
        band: &BandEdit,
    ) -> Option<Vec<((u32, u32), T)>> {
        let entries = map.get_mut(&sheet)?;
        if !entries.keys().any(|&(r, c)| band.shift_cell(r, c) != Some((r, c))) {
            return None;
        }
        let previous: Vec<((u32, u32), T)> = entries.iter().map(|(k, v)| (*k, v.clone())).collect();
        let original: Vec<((u32, u32), T)> = entries.drain().collect();
        for ((r, c), mut value) in original {
            if let Some((nr, nc)) = band.shift_cell(r, c) {
                if (nr, nc) != (r, c) {
                    value.set_cell(nr, nc);
                }
                entries.insert((nr, nc), value);
            }
        }
        Some(previous)
    }

    if let Ok(mut store) = state.comments.write(effect) {
        if let Some(previous) = shift_map(&mut store, sheet, band) {
            undo_stack.record_custom_restore(
                "obj_comments".to_string(),
                crate::undo_commands::sheet_cell_map_snapshot_bytes(sheet, previous),
                "Shift comments",
            );
        }
    }
    if let Ok(mut store) = state.notes.write(effect) {
        if let Some(previous) = shift_map(&mut store, sheet, band) {
            undo_stack.record_custom_restore(
                "obj_notes".to_string(),
                crate::undo_commands::sheet_cell_map_snapshot_bytes(sheet, previous),
                "Shift notes",
            );
        }
    }
    if let Ok(mut store) = state.hyperlinks.write(effect) {
        if let Some(previous) = shift_map(&mut store, sheet, band) {
            undo_stack.record_custom_restore(
                "obj_hyperlinks".to_string(),
                crate::undo_commands::sheet_cell_map_snapshot_bytes(sheet, previous),
                "Shift hyperlinks",
            );
        }
    }
}

/// Scenario changing-cells and computed-property CELL keys move with their
/// cell. Outline groups, row/column computed properties and hidden rows are
/// whole-line state that a band of cells does not move. One `obj_coord_stores`
/// entry, carrying all four stores' current values so the restore puts back
/// exactly what was there.
fn shift_misc_stores_in_band(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    band: &BandEdit,
) {
    let mut changed = false;
    let prev_scenarios = {
        let Ok(mut store) = state.scenarios.write(effect) else { return };
        let before = store.get(&sheet).cloned();
        if let Some(list) = store.get_mut(&sheet) {
            for scenario in list.iter_mut() {
                scenario.changing_cells.retain_mut(|cell| match band.shift_cell(cell.row, cell.col) {
                    Some((r, c)) => {
                        if (r, c) != (cell.row, cell.col) {
                            changed = true;
                        }
                        cell.row = r;
                        cell.col = c;
                        true
                    }
                    None => {
                        changed = true;
                        false
                    }
                });
            }
        }
        before
    };
    let prev_computed = {
        let Ok(mut store) = state.computed_properties.write(effect) else { return };
        let before = store.get(&sheet).cloned();
        if let Some(props) = store.get_mut(&sheet) {
            let old = std::mem::take(&mut props.cell_props);
            for ((r, c), v) in old {
                match band.shift_cell(r, c) {
                    Some(pos) => {
                        if pos != (r, c) {
                            changed = true;
                        }
                        props.cell_props.insert(pos, v);
                    }
                    None => changed = true,
                }
            }
        }
        before
    };
    if !changed {
        return;
    }
    let prev_outline = state.outlines.read().ok().and_then(|m| m.get(&sheet).cloned());
    let prev_hidden = state.advanced_filter_hidden_rows.read().ok().and_then(|m| m.get(&sheet).cloned());
    undo_stack.record_custom_restore(
        "obj_coord_stores".to_string(),
        crate::undo_commands::coord_stores_snapshot_bytes(sheet, prev_outline, prev_scenarios, prev_computed, prev_hidden),
        "Shift positional stores",
    );
}

/// Defined names are formula strings (rule 1). Same scoping rule as
/// `shift_named_ranges`: an unqualified reference means the name's own scope
/// sheet, and a workbook-scoped unqualified reference is left alone.
fn shift_named_ranges_in_band(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    sheet_name: &str,
    band: &BandEdit,
) -> Vec<String> {
    let Ok(mut store) = state.named_ranges.write(effect) else { return Vec::new() };
    if store.is_empty() {
        return Vec::new();
    }
    let previous: Vec<(String, crate::named_ranges::NamedRange)> = store.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut changed = false;
    let mut to_recalc: Vec<String> = Vec::new();
    for nr in store.values_mut() {
        let formula_sheet: &str = if nr.sheet_index == Some(sheet) { sheet_name } else { "" };
        let (shifted, reached) = shift_formula_in_band_noting_reach(&nr.refers_to, formula_sheet, sheet_name, band);
        if shifted != nr.refers_to {
            nr.refers_to = shifted;
            changed = true;
            to_recalc.push(nr.name.clone());
        } else if reached {
            // A name over a STRADDLING range keeps its definition while the
            // cells it names change: its readers must recalculate all the same.
            to_recalc.push(nr.name.clone());
        }
    }
    drop(store);
    if changed {
        undo_stack.record_custom_restore(
            "obj_named_ranges".to_string(),
            crate::undo_commands::named_ranges_snapshot_bytes(previous),
            "Shift named ranges",
        );
    }
    to_recalc
}

/// The print area and the scroll area are A1 range strings on this sheet.
fn shift_range_strings_in_band(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    sheet_name: &str,
    band: &BandEdit,
) {
    let mut changed = false;
    let prev_print = {
        let Ok(mut setups) = state.page_setups.write(effect) else { return };
        let before = setups.get(sheet).map(|s| s.print_area.clone());
        if let Some(ps) = setups.get_mut(sheet) {
            if !ps.print_area.is_empty() {
                let next = shift_formula_in_band(&ps.print_area, sheet_name, sheet_name, band);
                if next != ps.print_area {
                    ps.print_area = next;
                    changed = true;
                }
            }
        }
        before
    };
    let prev_scroll = {
        let Ok(mut areas) = state.scroll_areas.lock() else { return };
        let before = areas.get(sheet).cloned().flatten();
        if let Some(Some(area)) = areas.get_mut(sheet) {
            let next = shift_formula_in_band(area, sheet_name, sheet_name, band);
            if &next != area {
                *area = next;
                changed = true;
            }
        }
        before
    };
    if changed {
        undo_stack.record_custom_restore(
            "obj_range_strings".to_string(),
            crate::undo_commands::range_strings_snapshot_bytes(sheet, prev_print, prev_scroll),
            "Shift print / scroll areas",
        );
    }
}

/// On-grid controls move with their anchor cell, and their object-script
/// binding (`control-<sheet>-<row>-<col>`) moves with them -- the band twin of
/// `shift_controls`, including its "free-placed controls stay" rule.
fn shift_controls_in_band(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    band: &BandEdit,
) {
    let previous_controls: Vec<((usize, u32, u32), crate::controls::ControlMetadata)> = {
        let Ok(store) = state.controls.read() else { return };
        if store.is_empty() {
            return;
        }
        store.iter().map(|(k, v)| (*k, v.clone())).collect()
    };
    let mut id_moves: HashMap<String, Option<String>> = HashMap::new();
    let mut rebuilt: crate::controls::ControlStorage = HashMap::new();
    let mut changed = false;
    for ((s, row, col), meta) in previous_controls.iter().cloned() {
        if s != sheet || !crate::controls::moves_with_cells(&meta) {
            rebuilt.insert((s, row, col), meta);
            continue;
        }
        let old_id = format!("control-{}-{}-{}", s, row, col);
        match band.shift_cell(row, col) {
            Some((r, c)) => {
                if (r, c) != (row, col) {
                    changed = true;
                    id_moves.insert(old_id, Some(format!("control-{}-{}-{}", s, r, c)));
                }
                rebuilt.insert((s, r, c), meta);
            }
            None => {
                changed = true;
                id_moves.insert(old_id, None);
            }
        }
    }
    if !changed {
        return;
    }
    let previous_ids = {
        let Ok(mut scripts) = state.object_scripts.write(effect) else { return };
        let mut prev = Vec::new();
        for script in scripts.iter_mut() {
            let Some(current) = script.instance_id.clone() else { continue };
            if let Some(moved_to) = id_moves.get(&current) {
                prev.push((script.id.clone(), Some(current)));
                script.instance_id = moved_to.clone();
            }
        }
        prev
    };
    if let Ok(mut store) = state.controls.write(effect) {
        *store = rebuilt;
    }
    undo_stack.record_custom_restore(
        "obj_controls".to_string(),
        crate::undo_commands::controls_snapshot_bytes(previous_controls, previous_ids),
        "Shift controls",
    );
}

/// Conditional formats and data validations (rule 4 + rule 5), and the
/// allow-edit ranges of sheet protection (reference semantics: those are an
/// enforced boundary, so they never fragment and never inherit).
fn shift_rule_ranges_in_band(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    band: &BandEdit,
) {
    shift_cf_and_validation_ranges(state, effect, undo_stack, sheet, band);

    if let Ok(mut store) = state.sheet_protection.write(effect) {
        if let Some(protection) = store.get_mut(&sheet) {
            let previous = protection.allow_edit_ranges.clone();
            let mut changed = false;
            protection.allow_edit_ranges.retain_mut(|r| {
                let rect = CellRange { start_row: r.start_row, end_row: r.end_row, start_col: r.start_col, end_col: r.end_col };
                match band.shift_reference_range(rect) {
                    Some(n) => {
                        if n != rect {
                            changed = true;
                            r.start_row = n.start_row;
                            r.end_row = n.end_row;
                            r.start_col = n.start_col;
                            r.end_col = n.end_col;
                        }
                        true
                    }
                    None => {
                        changed = true;
                        false
                    }
                }
            });
            if changed {
                undo_stack.record_custom_restore(
                    "obj_sheet_protection".to_string(),
                    crate::undo_commands::sheet_protection_snapshot_bytes(sheet, previous),
                    "Shift allow-edit ranges",
                );
            }
        }
    }
}

/// Conditional formats and data validations of one sheet through ONE edit --
/// a band edit or a whole-line one (`BandEdit::whole_lines`), the same rules
/// 4 and 5 either way: each range is cut / grown / shrunk as a reference, a
/// range reaching the sheet's last line keeps reaching it, a range every cell
/// of which was deleted goes (and a rule left with no range goes with it), and
/// the lines an insertion adds under a range ending just before them join it.
///
/// Records one restore per store, and only when that store changed.
pub(crate) fn shift_cf_and_validation_ranges(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet: usize,
    band: &BandEdit,
) {
    use crate::conditional_formatting::ConditionalFormatRange;

    if let Ok(mut store) = state.conditional_formats.write(effect) {
        if let Some(rules) = store.get_mut(&sheet) {
            let previous = rules.clone();
            let mut changed = false;
            for rule in rules.iter_mut() {
                let mut next: Vec<ConditionalFormatRange> = Vec::with_capacity(rule.ranges.len());
                for r in &rule.ranges {
                    let rect = CellRange { start_row: r.start_row, end_row: r.end_row, start_col: r.start_col, end_col: r.end_col };
                    let pieces = band.rule_range_pieces(rect);
                    if pieces.len() != 1 || pieces[0] != rect {
                        changed = true;
                    }
                    for p in pieces {
                        next.push(ConditionalFormatRange { start_row: p.start_row, start_col: p.start_col, end_row: p.end_row, end_col: p.end_col });
                    }
                }
                rule.ranges = next;
            }
            let before = rules.len();
            rules.retain(|rule| !rule.ranges.is_empty());
            changed |= rules.len() != before;
            if changed {
                undo_stack.record_custom_restore(
                    "obj_conditional_formats".to_string(),
                    crate::undo_commands::conditional_formats_snapshot_bytes(sheet, previous),
                    "Shift conditional formats",
                );
            }
        }
    }

    if let Ok(mut store) = state.data_validations.write(effect) {
        if let Some(ranges) = store.get_mut(&sheet) {
            let previous = ranges.clone();
            let mut changed = false;
            let mut next: Vec<crate::data_validation::ValidationRange> = Vec::with_capacity(ranges.len());
            for v in ranges.iter() {
                let rect = CellRange { start_row: v.start_row, end_row: v.end_row, start_col: v.start_col, end_col: v.end_col };
                let pieces = band.rule_range_pieces(rect);
                if pieces.len() != 1 || pieces[0] != rect {
                    changed = true;
                }
                for p in pieces {
                    let mut piece = v.clone();
                    piece.start_row = p.start_row;
                    piece.end_row = p.end_row;
                    piece.start_col = p.start_col;
                    piece.end_col = p.end_col;
                    next.push(piece);
                }
            }
            if changed {
                *ranges = next;
                undo_stack.record_custom_restore(
                    "obj_validation".to_string(),
                    crate::undo_commands::validation_snapshot_bytes(sheet, previous),
                    "Shift data validations",
                );
            }
        }
    }
}

/// Formulas on every OTHER sheet that name the edited sheet (rule 1). Only a
/// QUALIFIED reference can reach it from there, so `!`-free formulas are
/// skipped without being scanned. Returns the sheets to recalculate (D8): every
/// sheet it rewrote, and every sheet holding a reference that REACHES the cells
/// the edit changed without being rewritten -- a straddling range, whose
/// address stays while its contents move.
fn shift_cross_sheet_formulas_in_band(
    undo_stack: &mut engine::UndoStack,
    grids: &mut [engine::Grid],
    active_sheet: usize,
    edited_sheet_name: &str,
    sheet_names: &[String],
    band: &BandEdit,
) -> Vec<usize> {
    let mut rewritten: Vec<usize> = Vec::new();
    for (idx, grid) in grids.iter_mut().enumerate() {
        if idx == active_sheet {
            continue;
        }
        let Some(this_sheet) = sheet_names.get(idx) else { continue };
        let candidates: Vec<((u32, u32), Cell)> = grid
            .cells
            .iter()
            .filter(|(_, c)| c.ast.is_some())
            .map(|(&p, c)| (p, c.clone()))
            .collect();
        let mut previous: Vec<((u32, u32), Option<Cell>)> = Vec::new();
        let mut reached_here = false;
        for ((r, c), cell) in candidates {
            let Some(formula) = formula_to_rewrite(&cell) else { continue };
            if !formula.contains('!') {
                continue;
            }
            let (updated, reached) = shift_formula_in_band_noting_reach(&formula, this_sheet, edited_sheet_name, band);
            reached_here |= reached;
            if updated == formula {
                continue;
            }
            if let Ok(ast) = parser::parse(&updated) {
                previous.push(((r, c), Some(cell.clone())));
                let mut next = cell;
                next.ast = Some(Box::new(ast));
                grid.set_cell(r, c, next);
            }
        }
        let changed_here = !previous.is_empty();
        if changed_here {
            undo_stack.record_custom_restore(
                "obj_cross_sheet_formulas".to_string(),
                crate::undo_commands::cross_sheet_formulas_snapshot_bytes(idx, previous),
                "Shift cross-sheet formulas",
            );
        }
        if changed_here || reached_here {
            rewritten.push(idx);
        }
    }
    rewritten
}

/// Rule 10. Returns the (post-edit) origins that must be re-evaluated.
///
/// A spill whose origin and every output cell move by the same offset (all
/// inside the band, or all outside it) is re-keyed in both maps. Any other
/// spill the edit reaches -- origin outside the band and outputs inside, an
/// insertion inside its output area, a deleted origin -- loses its OUTPUT cells
/// here, BEFORE the move: they are derived values, and moving them as if they
/// were typed would leave them standing in the origin's way. The origin (if it
/// survives) is then re-evaluated where it now lives, and spills again or shows
/// `#SPILL!` exactly as Excel's does. The maps record no undo entry, as on every
/// structural path: the snapshot restores the cells and the recalculation the
/// undo runs re-spills.
fn shift_spills_in_band(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    grid: &mut engine::Grid,
    sheet: usize,
    band: &BandEdit,
) -> Vec<(u32, u32)> {
    let mut respill: Vec<(u32, u32)> = Vec::new();
    let (Ok(mut ranges), Ok(mut hosts)) = (state.spill_ranges.write(effect), state.spill_hosts.lock()) else {
        return respill;
    };
    let entries: Vec<((usize, u32, u32), Vec<(u32, u32)>)> = ranges
        .iter()
        .filter(|((s, _, _), _)| *s == sheet)
        .map(|(k, v)| (*k, v.clone()))
        .collect();
    for ((s, or, oc), cells) in entries {
        let offset = |r: u32, c: u32| band.shift_cell(r, c).map(|(nr, nc)| (nr as i64 - r as i64, nc as i64 - c as i64));
        let origin_offset = offset(or, oc);
        let whole = origin_offset.is_some() && cells.iter().all(|&(r, c)| offset(r, c) == origin_offset);
        if whole && origin_offset == Some((0, 0)) {
            continue;
        }
        ranges.remove(&(s, or, oc));
        for &(r, c) in &cells {
            hosts.remove(&(s, r, c));
        }
        if whole {
            let (dr, dc) = origin_offset.unwrap_or((0, 0));
            let moved: Vec<(u32, u32)> = cells.iter().map(|&(r, c)| ((r as i64 + dr) as u32, (c as i64 + dc) as u32)).collect();
            let origin = ((or as i64 + dr) as u32, (oc as i64 + dc) as u32);
            for &(r, c) in &moved {
                hosts.insert((s, r, c), origin);
            }
            ranges.insert((s, origin.0, origin.1), moved);
        } else {
            for &(r, c) in &cells {
                if (r, c) != (or, oc) {
                    grid.cells.remove(&(r, c));
                }
            }
            if let Some(pos) = band.shift_cell(or, oc) {
                respill.push(pos);
            }
        }
    }
    respill
}
