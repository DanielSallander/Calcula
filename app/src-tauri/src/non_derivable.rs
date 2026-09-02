//! FILENAME: app/src-tauri/src/non_derivable.rs
//! PURPOSE: Which cells a recalculation CANNOT re-derive, and which of those
//! depend on a given set of cells.
//!
//! CONTEXT: The push hold-back rolls the author's unticked cells back to their
//! base values, recalculates, publishes, and restores. The recalculation is the
//! whole point — a rolled-back input whose dependents still showed the author's
//! numbers is exactly the artifact the design rejects, and it would be invisible
//! to a subscriber because nothing on the receiving side ever recalculates.
//!
//! THREE FUNCTION FAMILIES BREAK THAT, because their value does not come from
//! the workbook and the recalculation has nothing to derive it FROM:
//!
//!   * CUBE (`CUBEVALUE`, `CUBEMEMBER`, …) — answered by a model, over a
//!     prefetch the frontend builds asynchronously;
//!   * a custom function (a JS UDF, or a name nothing registers) — answered by
//!     the script host;
//!   * GATHER (`GATHER`, `GATHER.AT`, …) — answered by the workspace's
//!     writeback submissions.
//!
//! All three take ordinary cell references as ARGUMENTS
//! (`=CUBEVALUE("Sales";"[Revenue]";A1)`, `=MYFUNC(A1)`, `=GATHER.AT(A1;B1;C1)`),
//! and the dependency extractor recurses into every function's args with no
//! exception list — so they are real dependents of the cells being rolled back.
//!
//! WHAT ACTUALLY HAPPENED WITHOUT THIS GUARD, measured from the code across the
//! two recalculation engines the hold-back reaches:
//!
//! | where the cell is | CUBE / custom fn | GATHER |
//! |---|---|---|
//! | a NON-active sheet (`recalculate_sheet_values`) | keeps its OLD value — `preserved_cube_value` / `preserved_udf_value` read the stored value straight back out of the grid and re-write it | re-derives correctly (its resolver IS wired) |
//! | the ACTIVE sheet (batch / cross-sheet cascade) | `#N/A` / `#NAME?` — the same absent prefetch, but no position is set, so there is nothing to preserve | collapses to an empty list / `0` / `#N/A` |
//!
//! The first row, left column, is the dangerous one: `A1` publishes at the base
//! version's value next to a `B1` holding the number derived from the author's
//! held-back `A1` — a pair that was never simultaneously true, on every
//! subscriber's screen, and silent by construction because the push diff hides
//! formula cells whose formula did not change. `=SUM(GATHER(...))` publishing as
//! `0` is arguably worse: it looks like a legitimate number.
//!
//! So the answer is to REFUSE, which is what `docs/design/open-items.md` §2.aa
//! specified for whichever route the feature took ("cells that cannot be
//! re-derived locally must REFUSE rather than ship, when one lies in the
//! dependency closure of an unticked cell"). The feature shipped without it.

use std::collections::{HashMap, HashSet, VecDeque};

use parser::ast::{BuiltinFunction, Expression as ParserExpr};

/// A workbook cell: `(sheet_index, row, col)`.
pub(crate) type Node = (usize, u32, u32);

/// The reserved marker name resolution injects for a call to a user-defined
/// (named `LAMBDA`) function. It is the ONE `Custom` the evaluator resolves
/// natively — the lambda travels inside the marker — so it is derivable and
/// must not be refused.
const NAMED_INVOKE_MARKER: &str = "__INVOKE__";

/// Why one cell cannot be re-derived, or `None` if it can.
///
/// A `&'static str` rather than an enum because its only consumer puts it in a
/// sentence, and a variant that no code branches on is a variant that drifts
/// away from the sentence it was invented for.
pub(crate) fn non_derivable_reason(ast: &ParserExpr) -> Option<&'static str> {
    let mut found: Option<&'static str> = None;
    walk(ast, &mut |func| {
        if found.is_some() {
            return;
        }
        found = classify(func);
    });
    found
}

fn classify(func: &BuiltinFunction) -> Option<&'static str> {
    if engine::cube_function_name(func).is_some() {
        return Some("reads a data model (a CUBE function)");
    }
    match func {
        BuiltinFunction::Gather
        | BuiltinFunction::GatherFrom
        | BuiltinFunction::GatherCount
        | BuiltinFunction::GatherSubmitters
        | BuiltinFunction::GatherAt => {
            Some("reads writeback submissions (a GATHER function)")
        }
        // A UDF, or a name nothing registers. The distinction does not matter
        // here and cannot be made from the backend anyway — the registered UDF
        // names live in the script host — because BOTH are names this
        // recalculation cannot evaluate.
        BuiltinFunction::Custom(name) if name != NAMED_INVOKE_MARKER => {
            Some("calls a custom function")
        }
        _ => None,
    }
}

/// Visit every `FunctionCall`'s function in an expression tree.
///
/// EXHAUSTIVE BY CONSTRUCTION: it matches only the two variants it needs and
/// recurses through `child_expressions`, so a new `Expression` variant cannot
/// silently hide a cube call from it — the way a hand-written arm list would.
fn walk(expr: &ParserExpr, visit: &mut impl FnMut(&BuiltinFunction)) {
    if let ParserExpr::FunctionCall { func, .. } = expr {
        visit(func);
    }
    for child in child_expressions(expr) {
        walk(child, visit);
    }
}

/// Every sub-expression of `expr`, whatever variant it is.
fn child_expressions(expr: &ParserExpr) -> Vec<&ParserExpr> {
    match expr {
        ParserExpr::FunctionCall { args, .. } => args.iter().collect(),
        ParserExpr::BinaryOp { left, right, .. } => vec![left.as_ref(), right.as_ref()],
        ParserExpr::UnaryOp { operand, .. } => vec![operand.as_ref()],
        ParserExpr::ArrayLiteral { rows } => rows.iter().flatten().collect(),
        _ => Vec::new(),
    }
}

/// Every cell that transitively depends on `seeds`, seeds excluded.
///
/// EDGES COME FROM `cell.ast` THROUGH [`crate::stored_ast_references`], the
/// same primitive `build_workbook_plan` and `SheetDependencyIndex` are both
/// built from — so this is not a second opinion about what depends on what. It
/// is a second WALK, for the same reason `SheetDependencyIndex` is one: the
/// `AppState` dependency maps have no sheet dimension and describe the active
/// sheet only, and this question spans the workbook.
///
/// Whole-column and whole-row references are followed too: a `=SUM(A:A)` that a
/// held-back cell sits inside is a dependent, and missing it would be a
/// false NEGATIVE — the direction that costs the user a corrupt artifact.
pub(crate) fn dependents_closure(
    grids: &[engine::Grid],
    name_tables: crate::name_resolution::NameTables<'_>,
    seeds: &[Node],
) -> HashSet<Node> {
    // CASE-INSENSITIVE, because the lexer UPPERCASES bare identifiers: `=Sheet1!A2`
    // is stored as `SHEET1!A2` while quoted `='Sheet1'!A2` keeps its case. The
    // same rule `build_workbook_plan`'s own `sheet_index_of` applies, and the
    // one that a raw registration got wrong once already (BUG-0019).
    let sheet_names = name_tables.sheet_names;
    let sheet_index_of = |name: &str| -> Option<usize> {
        sheet_names.iter().position(|n| n.eq_ignore_ascii_case(name))
    };

    // precedent -> the formula cells that read it.
    let mut forward: HashMap<Node, Vec<Node>> = HashMap::new();
    // (sheet, col) / (sheet, row) -> formula cells with a whole-stripe read.
    let mut by_column: HashMap<(usize, u32), Vec<Node>> = HashMap::new();
    let mut by_row: HashMap<(usize, u32), Vec<Node>> = HashMap::new();

    for (sheet_index, grid) in grids.iter().enumerate() {
        for (&(row, col), cell) in &grid.cells {
            let Some(ast) = &cell.ast else { continue };
            let node: Node = (sheet_index, row, col);
            let refs =
                crate::stored_ast_references(ast, grid, name_tables, sheet_index, row, col);
            for &(r, c) in &refs.cells {
                forward.entry((sheet_index, r, c)).or_default().push(node);
            }
            for &c in &refs.columns {
                by_column.entry((sheet_index, c)).or_default().push(node);
            }
            for &r in &refs.rows {
                by_row.entry((sheet_index, r)).or_default().push(node);
            }
            for (sheet_name, r, c) in &refs.cross_sheet_cells {
                let Some(target) = sheet_index_of(sheet_name) else { continue };
                forward.entry((target, *r, *c)).or_default().push(node);
            }
        }
    }

    let mut seen: HashSet<Node> = seeds.iter().copied().collect();
    let mut queue: VecDeque<Node> = seeds.iter().copied().collect();
    let mut out: HashSet<Node> = HashSet::new();
    while let Some(node) = queue.pop_front() {
        let (sheet, row, col) = node;
        let direct = forward.get(&node).into_iter().flatten();
        let stripes = by_column
            .get(&(sheet, col))
            .into_iter()
            .flatten()
            .chain(by_row.get(&(sheet, row)).into_iter().flatten());
        for &dep in direct.chain(stripes) {
            if seen.insert(dep) {
                out.insert(dep);
                queue.push_back(dep);
            }
        }
    }
    out
}

/// Cells in the dependency closure of `seeds` that a recalculation cannot
/// re-derive, as `(node, reason)`, sorted so the refusal reads the same way
/// twice.
pub(crate) fn non_derivable_dependents(
    grids: &[engine::Grid],
    name_tables: crate::name_resolution::NameTables<'_>,
    seeds: &[Node],
) -> Vec<(Node, &'static str)> {
    let mut out: Vec<(Node, &'static str)> = dependents_closure(grids, name_tables, seeds)
        .into_iter()
        .filter_map(|(sheet, row, col)| {
            let ast = grids.get(sheet)?.get_cell(row, col)?.ast.as_ref()?;
            non_derivable_reason(ast).map(|why| ((sheet, row, col), why))
        })
        .collect();
    out.sort_unstable_by_key(|((s, r, c), _)| (*s, *r, *c));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ast(formula: &str) -> ParserExpr {
        parser::parse(formula).unwrap_or_else(|e| panic!("parse `{formula}`: {e:?}"))
    }

    /// The three families, each named for the sentence a refusal will print.
    ///
    /// SABOTAGE: drop any arm from `classify`. The matching push then publishes
    /// a cell whose value was derived from an input that did not ship.
    #[test]
    fn the_three_non_derivable_families_are_recognised() {
        assert!(non_derivable_reason(&ast("CUBEVALUE(\"S\",\"[R]\",A1)"))
            .unwrap()
            .contains("CUBE"));
        assert!(non_derivable_reason(&ast("GATHER.AT(A1,B1,C1)")).unwrap().contains("GATHER"));
        assert!(non_derivable_reason(&ast("MYFUNC(A1)")).unwrap().contains("custom"));
    }

    /// An ordinary formula is derivable, and so is a named LAMBDA: the marker
    /// carries the lambda, and the evaluator resolves it natively.
    ///
    /// SABOTAGE: drop the `name != NAMED_INVOKE_MARKER` clause. Every workbook
    /// with a named LAMBDA anywhere downstream then refuses to hold anything
    /// back — a guard that fires on correct workbooks teaches people to
    /// distrust it.
    #[test]
    fn ordinary_formulas_and_named_lambdas_are_derivable() {
        assert_eq!(non_derivable_reason(&ast("SUM(A1:A9)*2")), None);
        assert_eq!(non_derivable_reason(&ast("IF(A1>0,SUM(B:B),AVERAGE(C1:C9))")), None);
        assert_eq!(
            non_derivable_reason(&ast("__INVOKE__(\"Double\",LAMBDA(x,x*2),A1)")),
            None
        );
    }

    /// NESTED, and inside every container. A cube call buried in an argument, an
    /// operand or an array literal is exactly as unshippable as a top-level one.
    ///
    /// SABOTAGE: return early from `walk` instead of recursing, or drop an arm
    /// from `child_expressions`.
    #[test]
    fn a_non_derivable_call_is_found_however_deeply_it_is_nested() {
        assert!(non_derivable_reason(&ast("SUM(1,IF(TRUE,CUBEVALUE(\"S\",\"[R]\"),0))")).is_some());
        assert!(non_derivable_reason(&ast("1+MYFUNC(A1)")).is_some());
        assert!(non_derivable_reason(&ast("-GATHER.COUNT(\"r\")")).is_some());
        assert!(non_derivable_reason(&ast("SUM({1,CUBEVALUE(\"S\",\"[R]\")})")).is_some());
    }

    // -----------------------------------------------------------------------
    // The CLOSURE — which of those cells depend on the ones being held back
    // -----------------------------------------------------------------------

    fn cell(formula: &str) -> engine::cell::Cell {
        engine::cell::Cell::new_formula(formula.to_string())
    }

    /// Run the walk against a real `AppState`'s name stores, which is what the
    /// command hands it.
    fn offenders_of(
        grids: &[engine::Grid],
        names: &[&str],
        seeds: &[Node],
    ) -> Vec<(Node, &'static str)> {
        let state = crate::create_app_state();
        let sheet_names: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        let tables = state.tables.read().unwrap();
        let table_names = state.table_names.read().unwrap();
        let named_ranges = state.named_ranges.read().unwrap();
        non_derivable_dependents(
            grids,
            crate::name_resolution::NameTables {
                named_ranges: &named_ranges,
                tables: &tables,
                table_names: &table_names,
                sheet_names: &sheet_names,
                spill_ranges: &state.spill_ranges,
            },
            seeds,
        )
    }

    /// THE CASE THE REFUSAL EXISTS FOR. A1 is held back; B1 reads it through a
    /// CUBE call. Publishing would ship A1 at the base version's value beside a
    /// B1 holding the number derived from the author's A1.
    ///
    /// SABOTAGE: return an empty set from `dependents_closure`.
    #[test]
    fn a_cube_cell_reading_a_held_back_cell_is_refused() {
        let mut g = engine::Grid::new();
        g.set_cell(0, 0, engine::cell::Cell::new_number(1.0));
        g.set_cell(0, 1, cell("CUBEVALUE(\"S\",\"[R]\",A1)"));
        g.set_cell(0, 2, cell("A1*2")); // derivable — must NOT be reported
        let found = offenders_of(&[g], &["Sheet1"], &[(0, 0, 0)]);
        assert_eq!(found.len(), 1, "exactly the cube cell: {found:?}");
        assert_eq!(found[0].0, (0, 0, 1));
    }

    /// TRANSITIVE. The cube cell need not read the held-back cell directly —
    /// A1 -> B1 (ordinary) -> C1 (cube) ships the same lie one hop further out.
    ///
    /// SABOTAGE: stop the BFS after one hop.
    #[test]
    fn a_non_derivable_cell_two_hops_downstream_is_refused() {
        let mut g = engine::Grid::new();
        g.set_cell(0, 0, engine::cell::Cell::new_number(1.0));
        g.set_cell(0, 1, cell("A1+1"));
        g.set_cell(0, 2, cell("MYFUNC(B1)"));
        let found = offenders_of(&[g], &["Sheet1"], &[(0, 0, 0)]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, (0, 0, 2));
    }

    /// ACROSS SHEETS, and matched case-insensitively: the lexer UPPERCASES bare
    /// identifiers, so `=Sheet1!A1` is stored as `SHEET1!A1`. Registering that
    /// edge from the AST's spelling is the mistake that froze cross-sheet
    /// recalculation for a whole session once (BUG-0019).
    ///
    /// SABOTAGE: compare sheet names with `==`.
    #[test]
    fn a_non_derivable_cell_on_another_sheet_is_refused() {
        let mut g0 = engine::Grid::new();
        g0.set_cell(0, 0, engine::cell::Cell::new_number(1.0));
        let mut g1 = engine::Grid::new();
        g1.set_cell(0, 0, cell("GATHER.AT(Sheet1!A1,1,1)"));
        let found = offenders_of(&[g0, g1], &["Sheet1", "Sheet2"], &[(0, 0, 0)]);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].0, (1, 0, 0));
    }

    /// THROUGH A WHOLE-COLUMN READ. `=CUBEVALUE(...,SUM(A:A))` never names A1,
    /// and A1 is still one of the cells it sums. Missing this is a false
    /// NEGATIVE — the direction that costs the user a corrupt artifact.
    ///
    /// SABOTAGE: drop the `by_column` / `by_row` half of the walk.
    #[test]
    fn a_whole_column_read_carries_the_dependency() {
        let mut g = engine::Grid::new();
        g.set_cell(4, 0, engine::cell::Cell::new_number(1.0));
        g.set_cell(0, 3, cell("CUBEVALUE(\"S\",\"[R]\",SUM(A:A))"));
        let found = offenders_of(&[g], &["Sheet1"], &[(0, 4, 0)]);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].0, (0, 0, 3));
    }

    /// A WORKBOOK THAT IS FINE IS NOT REFUSED. A cube cell that has nothing to
    /// do with the held-back cell must not block the push — a guard that fires
    /// on correct workbooks teaches people to distrust it, and this one refuses
    /// a whole publish.
    ///
    /// SABOTAGE: report every non-derivable cell in the workbook instead of the
    /// closure's members.
    #[test]
    fn an_unrelated_cube_cell_does_not_block_the_push() {
        let mut g = engine::Grid::new();
        g.set_cell(0, 0, engine::cell::Cell::new_number(1.0)); // held back
        g.set_cell(0, 1, cell("A1*2")); // derivable dependent
        g.set_cell(9, 9, cell("CUBEVALUE(\"S\",\"[R]\",Z1)")); // unrelated
        let found = offenders_of(&[g], &["Sheet1"], &[(0, 0, 0)]);
        assert!(found.is_empty(), "nothing downstream is non-derivable: {found:?}");
    }
}
