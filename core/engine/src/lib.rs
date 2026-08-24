//! FILENAME: core/engine/src/lib.rs
//! PURPOSE: Main library entry point for the spreadsheet engine.
//! CONTEXT: Re-exports public types and modules for use by other crates.

pub mod ast_alignment;
pub mod ast_render;
/// Excel's three-way blank rule, asserted end to end (open-items 1.5). Its own
/// file rather than a module inside `evaluator.rs`: the rule is a property of
/// the whole evaluator — materialisers, collectors, comparisons, criteria and
/// the storage boundary — and burying it in a 20,000-line file is how the
/// contradiction between `A1:A3` and `A:A` survived unnoticed.
#[cfg(test)]
mod blank_semantics_tests;

/// Excel's SPACE intersection operator and the `#NULL!` it produces. Its own file
/// for the same reason `blank_semantics_tests` has one: the rule spans the lexer,
/// the parser, the renderer and the evaluator, so a failure needs to say WHICH
/// layer moved.
#[cfg(test)]
mod intersection_tests;

/// Excel's implicit ARRAY semantics — lifting, broadcasting, array constants and
/// the two operators (`%`, unary `+`) that did not exist. Same reasoning again:
/// the rule spans the lexer, the parser, the locale translator, the renderer and
/// the evaluator, and three of the defects it pins were WRONG NUMBERS rather
/// than errors.
#[cfg(test)]
mod array_semantics_tests;

/// Whole-axis references (`A:A`, `1:1`) are row- and column-INDEXED, bounded by
/// the used range. Its own file for the third time for the same reason: the rule
/// spans two evaluators, the pass cache and every criteria function, and the
/// defects it pins were plausible wrong NUMBERS on gapped data.
#[cfg(test)]
mod whole_axis_tests;

/// `TRIMRANGE` and the `.` trim-reference operator. Its own file because the
/// dot is SUGAR for the function — it lowers to the call in the parser — and
/// that equivalence is the design's load-bearing claim, so it is asserted on
/// the AST and then every behavioural case is run in both spellings.
#[cfg(test)]
mod trim_range_tests;

/// Excel's OMITTED ARGUMENT (`=IF(TRUE,,5)`). Its own file because the feature
/// spans three layers that can each be wrong on their own -- the parser must
/// keep the ARITY, the evaluator must read the slot as Excel's empty value
/// (which two hand-rolled coercions did not), and the renderer must put the
/// comma back or a saved workbook reloads as a different formula.
#[cfg(test)]
mod omitted_argument_tests;

/// Excel's three wildcard characters and the five places they were missing or
/// wrong. Its own file because the rule spans the criteria parser, two lookup
/// families, the pass cache and SEARCH — and because four of the five defects
/// were wrong ANSWERS rather than errors.
#[cfg(test)]
mod wildcard_tests;

/// Excel's `@` operator. Its own file because the operator had NO test anywhere
/// in the repo while two design docs listed it as shipped — and three of its
/// four rules were wrong, one of them answering differently depending on which
/// row the formula was typed in.
#[cfg(test)]
mod implicit_intersection_tests;

/// `OFFSET` resolves against the sheet its base names. Its own file because the
/// defect was a silently WRONG SHEET on the exact shape a dynamic named range is
/// built out of, and because it walked through the deleted-sheet guard.
#[cfg(test)]
mod offset_sheet_tests;

/// Excel's implicit array semantics — the shape algebra behind "array
/// operation", "lifting", "pairwise lifting" and "broadcasting". Its own file
/// for the reason `blank_semantics_tests` has one: the rule spans the binary
/// operators, the unary operators and the function dispatch, and a failure
/// needs to say WHICH shape moved.
/// The text functions count CHARACTERS, not bytes. Its own file because the
/// mistake is a Rust one (`str::len()` is a byte count) rather than a
/// spreadsheet one, so it recurs wherever a new text builtin is added — and
/// because Calcula ships Swedish by default, which makes it fire immediately.
#[cfg(test)]
mod text_character_semantics_tests;

/// Excel's TYPE RANKING for the comparison operators — number < text < FALSE <
/// TRUE — and the two equality sites that used a numeric tolerance. Its own file
/// for the reason `blank_semantics_tests` has one: the rule is ONE ladder behind
/// six operators, MATCH's exact match and a pass cache that mirrors it by hand,
/// and every defect it pins was a plausible WRONG BOOLEAN rather than an error.
#[cfg(test)]
mod comparison_ranking_tests;

/// EVERY EXACT-MATCH SURFACE MUST GIVE THE SAME ANSWER — MATCH 0, VLOOKUP /
/// HLOOKUP FALSE, LOOKUP, XLOOKUP (linear AND binary), SWITCH and the pass
/// cache — plus the criteria family's deliberate divergences from them. Its own
/// file because the defect it prevents is DISAGREEMENT between functions rather
/// than any one function being wrong: three hand-written equality predicates
/// gave, in one build on one column, three different rows for the same lookup,
/// and no single-function test can see that.
#[cfg(test)]
mod exact_match_agreement_tests;

/// Excel's DIRECT-vs-INDIRECT coercion rule for the aggregates — the reason
/// `=SUM(1,"2",TRUE)` is 4 and `=SUM({1,"2",TRUE})` is 1. Its own file for the
/// reason `blank_semantics_tests` has one: the rule spans one collector, three
/// families that must DISAGREE about it (SUM vs COUNTA vs AVERAGEA), and
/// SUBTOTAL beside them — and every defect it pins was a plausible WRONG TOTAL,
/// including `=SUM(A1:A3&"")`, the one formula whose entire job is to reveal
/// that a column has silently turned into text.
#[cfg(test)]
mod direct_coercion_tests;

/// THE ONE NUMBER PARSER AND THE ONE NUMBER FORMATTER.
///
/// Six separately-filed defects were two missing pieces: `as_number` reached
/// for Rust's `f64::from_str` (one dialect, no percent, no currency, no date,
/// and `inf`/`NaN` ACCEPTED) and `as_text` reached for Rust's `Display` (17
/// significant digits, never scientific, always an English decimal point).
/// Both now go through `number_text`, and so does the host's typed-entry
/// ladder. See that module's header.
#[cfg(test)]
mod number_text_tests;

/// AN ERROR ARGUMENT PROPAGATES out of the text family instead of being
/// spelled out and consumed as data. Its own file for the reason
/// `blank_semantics_tests` has one: the rule spans thirty-odd builtins, two
/// collectors and two ceilings, and every defect it pins was a PLAUSIBLE VALUE
/// rather than an error -- `=LEN(1/0)` answered 7, the length of "#DIV/0!".
/// It also carries the inventory guard that makes the next omission a build
/// failure, and the dated record of the one Excel divergence deliberately left
/// in place (LEN counts scalar values, Excel counts UTF-16 code units).
#[cfg(test)]
mod error_propagation_tests;

pub mod array_lift;
pub mod budget;
pub mod cell;
pub mod control_values;
pub mod coord;
pub mod cube;
pub mod custom_format;
pub mod date_serial;
pub mod dependency_extractor;
pub mod dependency_graph;
pub mod evaluator;
pub mod formula_locale;
pub mod id_operations;
pub mod identity_graph;
pub mod grid;
pub mod locale;
pub mod navigation;
pub mod lookup_cache;
pub mod number_format;
pub mod number_text;
pub mod row_visibility;
pub mod style;
pub mod text_cmp;
pub mod theme;
pub mod undo;
/// Which built-ins are VOLATILE (recalculate on every worksheet change, not
/// only on F9) and whether a stored AST calls one. Its own file rather than a
/// helper in `dependency_extractor`: volatility is precisely the property the
/// dependency graph CANNOT express, so keeping it next to the extractor that
/// cannot see it would invite the two to be confused for one another.
pub mod volatility;

// Re-export commonly used types at the crate root
pub use budget::{
    BudgetPolicy, CancelToken, EvalBudget, TripReason, BATCH_FUEL, DEFAULT_CELL_FUEL,
    LAMBDA_CALL_FUEL, MAX_ARRAY_ELEMENTS, MAX_TEXT_LEN, POLL_INTERVAL,
};
pub use cell::{Cell, CellError, CellValue, DictKey, RichTextRun};
pub use control_values::ControlValue;
pub use coord::{a1_to_coord, col_to_index, coord_to_a1, index_to_col, CellCoord};
pub use cube::{
    cell_key as cube_cell_key, cube_call_key, cube_function_name, resolve_cube_arg, CubeBinding,
    CubeBindingKind, CubeCallResult, CubeError, CubePrefetch, CubeResolver,
};
pub use custom_format::{FormatColor, FormatResult, format_color_to_css};
pub use dependency_extractor::{extract_dependencies, BinaryOperator, BuiltinFunction, Expression, TableSpecifier, UnaryOperator, Value};
pub use dependency_graph::{CoordSet, CycleError, DependencyGraph};
pub use grid::CellMap;
pub use evaluator::{EvalContext, EvalResult, Evaluator, GatherRegionData, GatherSubmission};
pub use grid::Grid;
pub use lookup_cache::{begin_pass as begin_lookup_pass, PassGuard as LookupPassGuard};
pub use navigation::{
    current_region, range_edge, used_range, EdgeDirection, EXCEL_MAX_COL_INDEX,
    EXCEL_MAX_ROW_INDEX,
};
pub use formula_locale::{delocalize_formula, localize_formula};
pub use locale::{CalendarNames, LocaleCurrencyPosition, LocaleSettings};
pub use number_format::{format_number, format_number_with_color, format_text_with_color};
pub use row_visibility::{
    active as active_row_visibility, begin_pass as begin_visibility_pass, HiddenScope,
    RowVisibility, SheetRowVisibility, VisibilityPassGuard,
};
pub use style::{
    BorderLineStyle, BorderStyle, Borders, CellStyle, Color, CurrencyPosition, Fill,
    FontStyle, GradientDirection, NegativeStyle, NumberFormat, PatternType, StyleRegistry,
    TextAlign, TextRotation, UnderlineStyle, VerticalAlign,
};
pub use theme::{
    ThemeColor, ThemeColorSlot, ThemeColors, ThemeDefinition, ThemeFonts, Tint,
};
pub use evaluator::MultiSheetContext;
pub use undo::{UndoStack, Transaction, CellChange, UndoMergeRegion, GridSnapshot};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_creates_cells() {
        let cell = Cell::new_number(42.0);
        assert_eq!(cell.value, CellValue::Number(42.0));
    }

    #[test]
    fn it_manages_grid() {
        let mut grid = Grid::new();
        let cell = Cell::new_text("Hello".to_string());
        grid.set_cell(0, 0, cell);

        let retrieved = grid.get_cell(0, 0);
        assert!(retrieved.is_some());
        if let Some(c) = retrieved {
            assert_eq!(c.value, CellValue::Text("Hello".to_string()));
        }
    }

    #[test]
    fn integration_test_dependency_workflow() {
        let mut graph = DependencyGraph::new();
        let mut grid = Grid::new();

        // A1 = 10
        let a1 = a1_to_coord("A", 1);
        grid.set_cell(a1.0, a1.1, Cell::new_number(10.0));

        // B1 = 20
        let b1 = a1_to_coord("B", 1);
        grid.set_cell(b1.0, b1.1, Cell::new_number(20.0));

        // C1 = A1 + B1
        let c1 = a1_to_coord("C", 1);
        grid.set_cell(c1.0, c1.1, Cell::new_formula("=A1+B1".to_string()));

        // Set up dependencies
        let mut deps = CoordSet::default();
        deps.insert(a1);
        deps.insert(b1);
        graph.set_dependencies(c1, deps);

        // Get recalculation order after A1 changes
        let order = graph.get_recalc_order(a1).unwrap();
        assert_eq!(order.len(), 1);
        assert_eq!(order[0], c1);
    }

    #[test]
    fn integration_test_cycle_prevention() {
        let mut graph = DependencyGraph::new();

        // A1 depends on B1
        let a1 = a1_to_coord("A", 1);
        let b1 = a1_to_coord("B", 1);
        let mut deps = CoordSet::default();
        deps.insert(b1);
        graph.set_dependencies(a1, deps);

        // Try to make B1 depend on A1 (would create cycle)
        let mut new_deps = CoordSet::default();
        new_deps.insert(a1);
        assert!(graph.would_create_cycle(b1, &new_deps));
    }

    #[test]
    fn integration_test_full_evaluation_workflow() {
        let mut grid = Grid::new();

        // Set up: A1=10, B1=20, C1=A1+B1
        grid.set_cell(0, 0, Cell::new_number(10.0));
        grid.set_cell(0, 1, Cell::new_number(20.0));

        // Parse and evaluate C1
        use dependency_extractor::*;
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: Default::default(),
            }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::CellRef {
                sheet: None,
                col: "B".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: Default::default(),
            }),
        };

        let evaluator = Evaluator::new(&grid);
        let result = evaluator.evaluate(&expr);

        match result {
            EvalResult::Number(n) => assert_eq!(n, 30.0),
            _ => panic!("Expected numeric result"),
        }

        // Convert to cell value
        let cell_value = result.to_cell_value();
        assert_eq!(cell_value, CellValue::Number(30.0));
    }

    #[test]
    fn integration_test_conditional_evaluation() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, Cell::new_number(100.0)); // A1 = 100

        // IF(A1 > 50, A1 * 2, A1 / 2)
        use dependency_extractor::*;
        let condition = Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: Default::default(),
            }),
            op: BinaryOperator::GreaterThan,
            right: Box::new(Expression::Literal(Value::Number(50.0))),
        };

        let true_expr = Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: Default::default(),
            }),
            op: BinaryOperator::Multiply,
            right: Box::new(Expression::Literal(Value::Number(2.0))),
        };

        let false_expr = Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: Default::default(),
            }),
            op: BinaryOperator::Divide,
            right: Box::new(Expression::Literal(Value::Number(2.0))),
        };

        let if_expr = Expression::FunctionCall {
            func: BuiltinFunction::If,
            args: vec![condition, true_expr, false_expr],
            ref_site_id: Default::default(),
        };

        let evaluator = Evaluator::new(&grid);
        let result = evaluator.evaluate(&if_expr);

        match result {
            EvalResult::Number(n) => assert_eq!(n, 200.0), // 100 > 50, so 100 * 2
            _ => panic!("Expected numeric result"),
        }
    }

    #[test]
    fn test_style_with_number_format() {
        use number_format::*;
        use style::*;

        let mut registry = StyleRegistry::new();
        let style = CellStyle::new().with_number_format(NumberFormat::Currency {
            decimal_places: 2,
            symbol: "$".to_string(),
            symbol_position: CurrencyPosition::Before,
            negative_style: NegativeStyle::default(),
        });

        let idx = registry.get_or_create(style);
        let retrieved = registry.get(idx);

        // Format a number with this style
        let locale = locale::LocaleSettings::invariant();
        let formatted = format_number(1234.56, &retrieved.number_format, &locale);
        assert!(formatted.contains("$"));
        assert!(formatted.contains("1234.56") || formatted.contains("1,234.56"));
    }
}