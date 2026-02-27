//! FILENAME: core/engine/src/lib.rs
//! PURPOSE: Main library entry point for the spreadsheet engine.
//! CONTEXT: Re-exports public types and modules for use by other crates.

pub mod cell;
pub mod coord;
pub mod custom_format;
pub mod dependency_extractor;
pub mod dependency_graph;
pub mod evaluator;
pub mod grid;
pub mod number_format;
pub mod style;
pub mod undo;

// Re-export commonly used types at the crate root
pub use cell::{Cell, CellError, CellValue};
pub use coord::{a1_to_coord, col_to_index, coord_to_a1, index_to_col, CellCoord};
pub use custom_format::{FormatColor, FormatResult, format_color_to_css};
pub use dependency_extractor::{extract_dependencies, BinaryOperator, BuiltinFunction, Expression, TableSpecifier, UnaryOperator, Value};
pub use dependency_graph::{CycleError, DependencyGraph};
pub use evaluator::{EvalContext, EvalResult, Evaluator, UiEffect};
pub use grid::Grid;
pub use number_format::{format_number, format_number_with_color, format_text_with_color};
pub use style::{
    BorderLineStyle, BorderStyle, Borders, CellStyle, Color, CurrencyPosition, FontStyle,
    NumberFormat, StyleRegistry, TextAlign, TextRotation, VerticalAlign,
};
pub use evaluator::MultiSheetContext;
pub use undo::{UndoStack, Transaction, CellChange};

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
        let mut deps = std::collections::HashSet::new();
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
        let mut deps = std::collections::HashSet::new();
        deps.insert(b1);
        graph.set_dependencies(a1, deps);

        // Try to make B1 depend on A1 (would create cycle)
        let mut new_deps = std::collections::HashSet::new();
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
            }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::CellRef {
                sheet: None,
                col: "B".to_string(),
                row: 1,
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
            }),
            op: BinaryOperator::GreaterThan,
            right: Box::new(Expression::Literal(Value::Number(50.0))),
        };

        let true_expr = Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
            op: BinaryOperator::Multiply,
            right: Box::new(Expression::Literal(Value::Number(2.0))),
        };

        let false_expr = Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
            op: BinaryOperator::Divide,
            right: Box::new(Expression::Literal(Value::Number(2.0))),
        };

        let if_expr = Expression::FunctionCall {
            func: BuiltinFunction::If,
            args: vec![condition, true_expr, false_expr],
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
        });

        let idx = registry.get_or_create(style);
        let retrieved = registry.get(idx);

        // Format a number with this style
        let formatted = format_number(1234.56, &retrieved.number_format);
        assert!(formatted.contains("$"));
        assert!(formatted.contains("1234.56") || formatted.contains("1,234.56"));
    }
}