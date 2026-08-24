//! FILENAME: core/engine/src/array_lift.rs
//! PURPOSE: Excel's implicit array semantics — shape, broadcasting and element access.
//! CONTEXT: The rules an operator or scalar function follows when one of its
//!          operands is an ARRAY instead of a single value. exceljet names the
//!          three flavours separately — "array operation", "lifting",
//!          "pairwise lifting" and "broadcasting" — but they are one rule:
//!          give every operand a (rows, cols) shape, take the element-wise
//!          maximum, and evaluate the scalar operation once per output cell.
//!
//! WHY ITS OWN FILE. The rule spans `eval_binary_op`, `eval_unary_op` and the
//! function dispatch, and `evaluator.rs` is already 20,000 lines. It is also the
//! kind of rule that goes wrong QUIETLY: before this existed `=A1:A3&"x"`
//! answered `"1x"` (as_text took the first element) and
//! `=SUMPRODUCT(A1:A3*B1:B3)` answered `0`, neither of which is an error the
//! user could see. Keeping the shape algebra in one testable place is what
//! makes those answers checkable.
//!
//! THE REPRESENTATION, and the one trap in it. `EvalResult::Array` carries no
//! explicit dimensions — shape is implied by nesting, exactly as
//! `EvalResult::spill_dimensions` has always read it:
//!
//! - `Array([a, b, c])`                      is 3 rows x 1 col (a COLUMN)
//! - `Array([Array([a, b, c])])`             is 1 row x 3 cols (a ROW)
//! - `Array([Array([a, b]), Array([c, d])])` is 2 rows x 2 cols
//!
//! So a FLAT array is a column, never a row. Everything here reads and writes
//! that same convention, which is why `pack` is the only place a result array
//! is built: hand-rolling the nesting at each call site is how a lifted row
//! would come back as a column and spill down the sheet instead of across it.

use crate::cell::CellError;
use crate::evaluator::EvalResult;

/// Whether a value takes part in array lifting.
///
/// `List` and `Dict` are Calcula's CONTAINED collections (Python-style). They
/// deliberately do not spill, and they must not lift either: `{"a":1}&"x"` is a
/// single text value, not a one-element array. Only `Array` lifts.
pub fn lifts(v: &EvalResult) -> bool {
    matches!(v, EvalResult::Array(_))
}

/// The (rows, cols) a value occupies. A non-array is 1x1 — that is what makes
/// `array + scalar` fall out of the same code path as `array + array`.
///
/// An empty array is (0, 0) and every caller treats that as #VALUE!, because
/// there is no sensible element to compute and Excel has no empty array either.
pub fn shape(v: &EvalResult) -> (usize, usize) {
    match v {
        EvalResult::Array(rows) if rows.is_empty() => (0, 0),
        EvalResult::Array(rows) => {
            if rows.iter().any(|r| matches!(r, EvalResult::Array(_))) {
                // Nested: rows of columns. Width is the WIDEST row, not the
                // first — VSTACK of unequal widths is legal and Excel pads the
                // short rows with #N/A, which `at` does below.
                let cols = rows
                    .iter()
                    .map(|r| match r {
                        EvalResult::Array(inner) => inner.len(),
                        _ => 1,
                    })
                    .max()
                    .unwrap_or(0);
                (rows.len(), cols)
            } else {
                (rows.len(), 1)
            }
        }
        _ => (1, 1),
    }
}

/// The element at (row, col) under Excel's broadcast rule.
///
/// A length-1 axis REPEATS: a scalar spreads over the whole result, a 1-row
/// array spreads down every row, a 1-column array spreads across every column.
/// That single rule gives all three of exceljet's cases — scalar lifting,
/// pairwise lifting, and the 1xN-against-Mx1 outer product.
///
/// An index past an axis longer than 1 is `#N/A` — Excel FILLS the ragged
/// corner rather than refusing the whole formula, so `{1;2;3}+{1;2}` is
/// `{2;4;#N/A}`. Returning an error value per cell (instead of erroring the
/// call) is what keeps that behaviour reachable.
pub fn at(v: &EvalResult, row: usize, col: usize) -> EvalResult {
    let (rows, cols) = shape(v);
    if rows == 0 || cols == 0 {
        return EvalResult::Error(CellError::NA);
    }
    let r = if rows == 1 {
        0
    } else if row < rows {
        row
    } else {
        return EvalResult::Error(CellError::NA);
    };
    let c = if cols == 1 {
        0
    } else if col < cols {
        col
    } else {
        return EvalResult::Error(CellError::NA);
    };

    match v {
        EvalResult::Array(items) => match &items[r] {
            EvalResult::Array(inner) => inner.get(c).cloned().unwrap_or(EvalResult::Error(CellError::NA)),
            // A flat array is a column, so column 0 is the element itself.
            scalar => {
                if c == 0 {
                    scalar.clone()
                } else {
                    EvalResult::Error(CellError::NA)
                }
            }
        },
        scalar => scalar.clone(),
    }
}

/// Build a result array of `rows` x `cols` from `cells` in row-major order.
///
/// THE ONLY PLACE a lifted array is constructed, so the flat-is-a-column
/// convention cannot drift between operators. A single column comes back FLAT
/// (matching `eval_range` for `A1:A3`) and a single row comes back NESTED
/// (`Array([Array([..])])`), which is the only spelling `spill_dimensions` reads
/// as one row.
///
/// A 1x1 result unwraps to the bare scalar: Excel's `=A1:A1+1` is a number, and
/// leaving it wrapped would make a chain of lifts nest deeper at every step.
pub fn pack(rows: usize, cols: usize, mut cells: Vec<EvalResult>) -> EvalResult {
    debug_assert_eq!(cells.len(), rows * cols);
    if rows == 1 && cols == 1 {
        return cells.pop().unwrap_or(EvalResult::Blank);
    }
    if cols == 1 {
        return EvalResult::Array(cells);
    }
    let mut out = Vec::with_capacity(rows);
    let mut iter = cells.into_iter();
    for _ in 0..rows {
        out.push(EvalResult::Array(iter.by_ref().take(cols).collect()));
    }
    EvalResult::Array(out)
}

/// The broadcast shape of several operands, or `None` if none of them is an
/// array (the scalar fast path — nothing to lift, so the caller runs unchanged).
///
/// `Some((0, 0))` means an operand was an EMPTY array; callers answer #VALUE!.
pub fn broadcast_shape(operands: &[&EvalResult]) -> Option<(usize, usize)> {
    if !operands.iter().any(|v| lifts(v)) {
        return None;
    }
    let mut rows = 1usize;
    let mut cols = 1usize;
    for v in operands {
        let (r, c) = shape(v);
        if r == 0 || c == 0 {
            return Some((0, 0));
        }
        rows = rows.max(r);
        cols = cols.max(c);
    }
    Some((rows, cols))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(x: f64) -> EvalResult {
        EvalResult::Number(x)
    }
    fn col(v: &[f64]) -> EvalResult {
        EvalResult::Array(v.iter().copied().map(n).collect())
    }
    fn row(v: &[f64]) -> EvalResult {
        EvalResult::Array(vec![EvalResult::Array(v.iter().copied().map(n).collect())])
    }

    #[test]
    fn a_flat_array_is_a_column_not_a_row() {
        assert_eq!(shape(&col(&[1.0, 2.0, 3.0])), (3, 1));
        assert_eq!(shape(&row(&[1.0, 2.0, 3.0])), (1, 3));
    }

    #[test]
    fn a_scalar_is_one_by_one_so_it_broadcasts_everywhere() {
        assert_eq!(shape(&n(5.0)), (1, 1));
        assert_eq!(broadcast_shape(&[&col(&[1.0, 2.0]), &n(5.0)]), Some((2, 1)));
    }

    #[test]
    fn no_array_operand_means_no_lift() {
        assert_eq!(broadcast_shape(&[&n(1.0), &n(2.0)]), None);
    }

    #[test]
    fn a_row_against_a_column_is_an_outer_product() {
        // 1x3 against 2x1 -> 2x3, which is what makes =A1:C1*A1:A2 a matrix.
        assert_eq!(
            broadcast_shape(&[&row(&[1.0, 2.0, 3.0]), &col(&[10.0, 20.0])]),
            Some((2, 3))
        );
    }

    #[test]
    fn a_length_one_axis_repeats() {
        let r = row(&[1.0, 2.0, 3.0]);
        // One row spreads DOWN every requested row.
        assert_eq!(at(&r, 0, 1), n(2.0));
        assert_eq!(at(&r, 7, 1), n(2.0));
        let c = col(&[10.0, 20.0]);
        // One column spreads ACROSS every requested column.
        assert_eq!(at(&c, 1, 0), n(20.0));
        assert_eq!(at(&c, 1, 9), n(20.0));
    }

    #[test]
    fn past_the_end_of_a_longer_axis_is_na_not_an_error_for_the_whole_call() {
        let c = col(&[1.0, 2.0]);
        assert_eq!(at(&c, 2, 0), EvalResult::Error(CellError::NA));
    }

    #[test]
    fn pack_round_trips_every_shape_it_builds() {
        assert_eq!(pack(1, 1, vec![n(7.0)]), n(7.0));
        assert_eq!(shape(&pack(3, 1, vec![n(1.0), n(2.0), n(3.0)])), (3, 1));
        assert_eq!(shape(&pack(1, 3, vec![n(1.0), n(2.0), n(3.0)])), (1, 3));
        assert_eq!(
            shape(&pack(2, 2, vec![n(1.0), n(2.0), n(3.0), n(4.0)])),
            (2, 2)
        );
    }

    #[test]
    fn a_packed_row_reads_back_as_one_row_so_it_spills_across() {
        let r = pack(1, 3, vec![n(1.0), n(2.0), n(3.0)]);
        assert_eq!(r.spill_dimensions(), (1, 3));
    }

    #[test]
    fn lists_and_dicts_do_not_lift() {
        assert!(!lifts(&EvalResult::List(vec![n(1.0)])));
        assert!(!lifts(&EvalResult::Dict(vec![])));
        assert!(lifts(&col(&[1.0])));
    }

    #[test]
    fn a_ragged_nested_array_pads_with_na_rather_than_truncating() {
        let ragged = EvalResult::Array(vec![
            EvalResult::Array(vec![n(1.0), n(2.0)]),
            EvalResult::Array(vec![n(3.0)]),
        ]);
        assert_eq!(shape(&ragged), (2, 2));
        assert_eq!(at(&ragged, 1, 1), EvalResult::Error(CellError::NA));
    }
}
