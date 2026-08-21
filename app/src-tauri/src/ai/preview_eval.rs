//! FILENAME: app/src-tauri/src/ai/preview_eval.rs
//! PURPOSE: Compute the VALUES of formulas held by a preview grid — the one
//!          thing a renderer-side dry run structurally cannot do for itself.
//! CONTEXT: docs/design/local-model-script-authoring.md §5c.
//!
//!          THE GAP THIS CLOSES. The faithful preview runs a draft in a real
//!          Worker over an in-memory grid. That grid has no evaluator, so a
//!          script that writes `=SUM(B2:B100)` and reads the cell back got an
//!          empty display — and a script that changed an INPUT left every
//!          dependent holding the value the workbook computed before the run.
//!          Both are the same missing piece, and it is not one TypeScript can
//!          supply: the formula language, its 400-odd functions and its
//!          reference semantics live in Rust.
//!
//!          WHY THIS IS NOT `recalculate_sheet_values`. That function reads
//!          ~16 `AppState` fields plus `UserFilesState` and `PivotState`, and a
//!          preview has none of them — it is not previewing the open workbook's
//!          state, it is previewing a HYPOTHETICAL one the script produced.
//!          `evaluate_formula_multi_sheet` is already pure over detached data
//!          (`&[Grid]`, `&[String]`, an index and a formula string), so this
//!          command hands it exactly the cells the preview holds and nothing
//!          else.
//!
//!          THE INVARIANT, same as the rest of this rung: it touches NO state.
//!          It takes no `AppState`, no `FileState` and no `DocumentEffect`,
//!          reads nothing persisted and writes nothing. Every input arrives as
//!          a command argument and every output is returned. That is what makes
//!          it safe to call in the middle of a preview — and it is why it must
//!          never grow a convenience overload that reads the live grid.

use engine::cell::{Cell, CellValue};
use engine::grid::Grid;
use serde::{Deserialize, Serialize};

/// One cell of the preview grid, in the input-string vocabulary the whole
/// preview stores and diffs in.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCellInput {
    pub row: u32,
    pub col: u32,
    /// "=SUM(A1:A9)", "42", "hello", "" — exactly what the formula bar shows.
    pub input: String,
}

/// One formula cell's computed value.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFormulaValue {
    pub row: u32,
    pub col: u32,
    /// The value as the workbook would display it ("5050", "#DIV/0!", "TRUE").
    pub display: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEvalResult {
    pub values: Vec<PreviewFormulaValue>,
    /// The fixed point was NOT reached within the pass budget.
    ///
    /// Reported rather than hidden: a chain deeper than the budget leaves some
    /// values stale, and a caller that presented them as final would be
    /// showing numbers the workbook would never produce.
    pub converged: bool,
    pub passes: u32,
}

/// How many cells one preview may evaluate.
///
/// Matched to the preview snapshot's own cap: evaluating more than was copied
/// is impossible by construction, and a bound here keeps a hostile or runaway
/// draft from turning a preview into an unbounded calculation.
pub const MAX_PREVIEW_EVAL_CELLS: usize = 20_000;

/// How many times the whole formula set is re-evaluated.
///
/// A formula reads the VALUES its references currently hold, so a chain
/// (`C1 = B1*2`, `B1 = A1+1`) needs one pass per link. Eight covers every
/// realistic draft; beyond that the answer is reported as unconverged rather
/// than iterated indefinitely, because a preview is a thing a person waits for
/// and a circular reference would otherwise never terminate.
const MAX_PASSES: u32 = 8;

/// Build the grid a preview's cells describe.
///
/// Formulas are stored with an EMPTY value rather than as text: the value is
/// what the passes below fill in, and storing `"=SUM(A1:A9)"` as Text would
/// make any formula referencing this cell see a string where a number belongs.
fn build_grid(cells: &[PreviewCellInput]) -> (Grid, Vec<(u32, u32, String)>) {
    let mut grid = Grid::new();
    let mut formulas = Vec::new();
    for c in cells {
        let is_formula = c.input.starts_with('=');
        if is_formula {
            formulas.push((c.row, c.col, c.input.clone()));
        }
        grid.set_cell(
            c.row,
            c.col,
            Cell {
                ast: None,
                value: if is_formula {
                    CellValue::Empty
                } else {
                    crate::mcp::tools::seed_cell_value(&c.input)
                },
                style_index: 0,
                rich_text: None,
            },
        );
    }
    (grid, formulas)
}

/// Evaluate every formula to a fixed point over the supplied cells.
///
/// Pure — no Tauri state, no I/O — so the iteration and the convergence
/// reporting are unit-testable without a running app.
pub fn evaluate_preview(cells: &[PreviewCellInput], sheet_name: &str) -> PreviewEvalResult {
    let (grid, formulas) = build_grid(cells);
    let names = vec![sheet_name.to_string()];
    let mut grids = vec![grid];

    let mut passes = 0;
    let mut converged = formulas.is_empty();
    while passes < MAX_PASSES && !converged {
        passes += 1;
        // Evaluate the WHOLE set against the grid as it currently stands, then
        // apply. Evaluating and writing in one loop would make a formula's
        // answer depend on the order the cells happen to be in.
        let results: Vec<(u32, u32, CellValue)> = formulas
            .iter()
            .map(|(row, col, f)| {
                (
                    *row,
                    *col,
                    crate::evaluate_formula_multi_sheet(&grids, &names, 0, f),
                )
            })
            .collect();

        let mut changed = false;
        for (row, col, value) in results {
            let current = grids[0].get_cell(row, col).map(|c| c.value.clone());
            if current.as_ref() != Some(&value) {
                changed = true;
                grids[0].set_cell(
                    row,
                    col,
                    Cell { ast: None, value, style_index: 0, rich_text: None },
                );
            }
        }
        if !changed {
            converged = true;
        }
    }

    let values = formulas
        .iter()
        .map(|(row, col, _)| PreviewFormulaValue {
            row: *row,
            col: *col,
            display: grids[0]
                .get_cell(*row, *col)
                .map(|c| c.display_value())
                .unwrap_or_default(),
        })
        .collect();

    PreviewEvalResult { values, converged, passes }
}

/// Compute the values of the formulas a preview grid holds. Touches no state.
#[tauri::command]
pub fn preview_evaluate_formulas(
    cells: Vec<PreviewCellInput>,
    sheet_name: Option<String>,
    window: tauri::Window,
) -> Result<PreviewEvalResult, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if cells.len() > MAX_PREVIEW_EVAL_CELLS {
        return Err(format!(
            "a preview may evaluate at most {} cells (got {})",
            MAX_PREVIEW_EVAL_CELLS,
            cells.len()
        ));
    }
    Ok(evaluate_preview(
        &cells,
        sheet_name.as_deref().unwrap_or("Sheet1"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(row: u32, col: u32, input: &str) -> PreviewCellInput {
        PreviewCellInput { row, col, input: input.to_string() }
    }

    #[test]
    fn a_formula_over_literals_gets_its_real_value() {
        // THE case this exists for: before it, a script that wrote this formula
        // and read the cell back saw an empty display.
        let r = evaluate_preview(
            &[cell(0, 0, "1"), cell(1, 0, "2"), cell(2, 0, "3"), cell(3, 0, "=SUM(A1:A3)")],
            "Sheet1",
        );
        assert!(r.converged);
        assert_eq!(r.values, vec![PreviewFormulaValue { row: 3, col: 0, display: "6".into() }]);
    }

    #[test]
    fn a_chain_settles_by_iterating_rather_than_by_a_dependency_graph() {
        // B1 = A1+1, C1 = B1*2. One pass computes B1 and reads C1 against a
        // still-empty B1; the next pass corrects C1. That is why the passes
        // exist, and why one pass would have been a wrong answer rather than a
        // missing one.
        let r = evaluate_preview(
            &[cell(0, 0, "10"), cell(0, 1, "=A1+1"), cell(0, 2, "=B1*2")],
            "Sheet1",
        );
        assert!(r.converged, "a two-link chain must settle");
        let by_col: Vec<String> = r.values.iter().map(|v| v.display.clone()).collect();
        assert_eq!(by_col, vec!["11".to_string(), "22".to_string()]);
        assert!(r.passes >= 2, "it really did need more than one pass, got {}", r.passes);
    }

    #[test]
    fn a_circular_reference_stops_and_SAYS_it_did_not_settle() {
        // Never terminating is not an option in something a person waits for,
        // and neither is presenting a half-iterated number as final.
        let r = evaluate_preview(&[cell(0, 0, "=B1+1"), cell(0, 1, "=A1+1")], "Sheet1");
        assert!(!r.converged, "a cycle cannot converge; the caller must be told");
        assert_eq!(r.passes, MAX_PASSES);
    }

    #[test]
    fn an_error_is_reported_as_the_workbook_would_show_it() {
        let r = evaluate_preview(&[cell(0, 0, "0"), cell(1, 0, "=1/A1")], "Sheet1");
        assert!(r.values[0].display.starts_with('#'), "got {:?}", r.values[0].display);
    }

    #[test]
    fn a_formula_cell_is_stored_with_an_empty_value_not_its_own_text() {
        // If `=A1+1` were stored as Text, a formula referencing it would see a
        // string where a number belongs and silently produce the wrong answer
        // rather than an error.
        let (grid, formulas) = build_grid(&[cell(0, 0, "=1+1"), cell(0, 1, "hi")]);
        assert_eq!(formulas.len(), 1);
        assert_eq!(grid.get_cell(0, 0).unwrap().value, CellValue::Empty);
        assert_eq!(grid.get_cell(0, 1).unwrap().value, CellValue::Text("hi".into()));
    }

    #[test]
    fn a_grid_with_no_formulas_converges_immediately_and_evaluates_nothing() {
        let r = evaluate_preview(&[cell(0, 0, "1"), cell(0, 1, "two")], "Sheet1");
        assert!(r.converged);
        assert_eq!(r.passes, 0);
        assert!(r.values.is_empty());
    }

    #[test]
    fn the_wire_shape_is_camel_case_for_the_typescript_mirror() {
        let r = evaluate_preview(&[cell(0, 0, "1"), cell(1, 0, "=A1")], "Sheet1");
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["converged"], serde_json::json!(true));
        assert_eq!(v["values"][0]["row"], serde_json::json!(1));
        assert_eq!(v["values"][0]["display"], serde_json::json!("1"));
    }
}
