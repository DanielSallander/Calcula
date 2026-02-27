//! FILENAME: core/engine/src/dependency_extractor.rs
//! PURPOSE: Extracts cell references from parsed AST expressions.
//! CONTEXT: After a formula is parsed into an AST, this module walks the tree
//! to find all cell references. These references are then used to build
//! the dependency graph. Ranges (e.g., A1:B10) are expanded to include
//! all cells within the range. Column and row references expand based on
//! the provided grid bounds.

use crate::coord::{col_to_index, CellCoord};
use std::collections::HashSet;

// Re-export from parser crate would be done via a dependency in Cargo.toml
// For now, we define the Expression type here to match the parser's AST

/// Expression type matching the parser's AST.
/// This is a local definition that must match `core/parser/src/ast.rs`.
/// In a real setup, this would be imported from the parser crate.
#[derive(Debug, Clone, PartialEq)]
pub enum Expression {
    Literal(Value),
    CellRef {
        sheet: Option<String>,
        col: String,
        row: u32,
    },
    Range {
        sheet: Option<String>,
        start: Box<Expression>,
        end: Box<Expression>,
    },
    ColumnRef {
        sheet: Option<String>,
        start_col: String,
        end_col: String,
    },
    RowRef {
        sheet: Option<String>,
        start_row: u32,
        end_row: u32,
    },
    BinaryOp {
        left: Box<Expression>,
        op: BinaryOperator,
        right: Box<Expression>,
    },
    UnaryOp {
        op: UnaryOperator,
        operand: Box<Expression>,
    },
    FunctionCall {
        func: BuiltinFunction,
        args: Vec<Expression>,
    },
    /// A 3D cross-sheet reference: Sheet1:Sheet5!A1 or 'Jan:Dec'!A1:B10.
    /// The inner reference has sheet=None; the sheet range is on this node.
    Sheet3DRef {
        start_sheet: String,
        end_sheet: String,
        reference: Box<Expression>,
    },

    /// A structured table reference (should be resolved before evaluation).
    /// If it reaches the engine unresolved, it produces a #NAME? error.
    TableRef {
        table_name: String,
        specifier: TableSpecifier,
    },
}

/// Specifier for structured table references (mirrors parser::ast::TableSpecifier).
#[derive(Debug, Clone, PartialEq)]
pub enum TableSpecifier {
    Column(String),
    ThisRow(String),
    ColumnRange(String, String),
    ThisRowRange(String, String),
    AllRows,
    DataRows,
    Headers,
    Totals,
    SpecialColumn(Box<TableSpecifier>, String),
}

/// Built-in spreadsheet functions resolved at parse time.
/// This is a local mirror of `parser::ast::BuiltinFunction`.
#[derive(Debug, Clone, PartialEq)]
pub enum BuiltinFunction {
    // Aggregate functions
    Sum,
    Average,
    Min,
    Max,
    Count,
    CountA,

    // Logical functions
    If,
    And,
    Or,
    Not,
    True,
    False,

    // Math functions
    Abs,
    Round,
    Floor,
    Ceiling,
    Sqrt,
    Power,
    Mod,
    Int,
    Sign,

    // Text functions
    Len,
    Upper,
    Lower,
    Trim,
    Concatenate,
    Left,
    Right,
    Mid,
    Rept,
    Text,

    // Information functions
    IsNumber,
    IsText,
    IsBlank,
    IsError,

    // Lookup & Reference functions
    XLookup,
    XLookups,

    // UI GET functions (read worksheet state)
    GetRowHeight,
    GetColumnWidth,
    GetCellFillColor,

    // Reference functions
    Row,
    Column,

    /// Fallback for unrecognized function names (future extensions/plugins).
    Custom(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Number(f64),
    String(String),
    Boolean(bool),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BinaryOperator {
    Equal,
    NotEqual,
    LessThan,
    GreaterThan,
    LessEqual,
    GreaterEqual,
    Concat,
    Add,
    Subtract,
    Multiply,
    Divide,
    Power,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum UnaryOperator {
    Negate,
}

/// Grid bounds for expanding column/row references.
#[derive(Debug, Clone, Copy)]
pub struct GridBounds {
    pub max_row: u32,
    pub max_col: u32,
}

impl Default for GridBounds {
    fn default() -> Self {
        // Default to a reasonable working area
        GridBounds {
            max_row: 1000,
            max_col: 26, // A-Z
        }
    }
}

/// A cell reference with optional sheet context.
/// Used for cross-sheet dependency tracking.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SheetCellRef {
    pub sheet: Option<String>,
    pub row: u32,
    pub col: u32,
}

/// Gets all sheet names between start and end (inclusive) based on tab order.
/// Returns an empty Vec if either sheet is not found.
pub fn get_sheets_in_range(start: &str, end: &str, sheet_order: &[String]) -> Vec<String> {
    let start_upper = start.to_uppercase();
    let end_upper = end.to_uppercase();

    let start_idx = sheet_order.iter().position(|s| s.to_uppercase() == start_upper);
    let end_idx = sheet_order.iter().position(|s| s.to_uppercase() == end_upper);

    match (start_idx, end_idx) {
        (Some(si), Some(ei)) => {
            let min = si.min(ei);
            let max = si.max(ei);
            sheet_order[min..=max].to_vec()
        }
        _ => Vec::new(),
    }
}

/// Extracts all cell dependencies from an AST expression.
/// This recursively walks the tree and collects all CellRef nodes,
/// expanding Range nodes to include all cells within the range.
/// For column/row references, uses default bounds.
///
/// # Arguments
/// * `expr` - The parsed AST expression.
///
/// # Returns
/// A set of (row, col) coordinates for all cells referenced by the expression.
/// Note: This version ignores sheet references for backward compatibility.
pub fn extract_dependencies(expr: &Expression) -> HashSet<CellCoord> {
    extract_dependencies_with_bounds(expr, GridBounds::default())
}

/// Extracts all cell dependencies from an AST expression with specified bounds.
/// Column and row references are expanded within the given bounds.
///
/// # Arguments
/// * `expr` - The parsed AST expression.
/// * `bounds` - The grid bounds for expanding column/row references.
///
/// # Returns
/// A set of (row, col) coordinates for all cells referenced by the expression.
/// Note: This version ignores sheet references for backward compatibility.
pub fn extract_dependencies_with_bounds(
    expr: &Expression,
    bounds: GridBounds,
) -> HashSet<CellCoord> {
    let mut deps = HashSet::new();
    extract_recursive(expr, &mut deps, bounds);
    deps
}

/// Extracts all cell dependencies including sheet context.
/// Returns SheetCellRef which includes the optional sheet name.
pub fn extract_dependencies_with_sheets(
    expr: &Expression,
    bounds: GridBounds,
) -> HashSet<SheetCellRef> {
    let mut deps = HashSet::new();
    extract_recursive_with_sheets(expr, &mut deps, bounds);
    deps
}

/// Recursive helper for dependency extraction (backward compatible, ignores sheets).
fn extract_recursive(expr: &Expression, deps: &mut HashSet<CellCoord>, bounds: GridBounds) {
    match expr {
        Expression::Literal(_) => {
            // Literals don't reference any cells
        }

        Expression::CellRef { col, row, .. } => {
            // Convert to 0-based coordinate (ignore sheet for backward compat)
            let col_idx = col_to_index(col);
            let row_idx = row - 1; // Parser stores 1-based rows
            deps.insert((row_idx, col_idx));
        }

        Expression::Range { start, end, .. } => {
            // Extract the start and end coordinates
            if let (
                Expression::CellRef {
                    col: start_col,
                    row: start_row,
                    ..
                },
                Expression::CellRef {
                    col: end_col,
                    row: end_row,
                    ..
                },
            ) = (start.as_ref(), end.as_ref())
            {
                let start_col_idx = col_to_index(start_col);
                let end_col_idx = col_to_index(end_col);
                let start_row_idx = start_row - 1;
                let end_row_idx = end_row - 1;

                // Normalize range (handle reversed ranges)
                let min_row = start_row_idx.min(end_row_idx);
                let max_row = start_row_idx.max(end_row_idx);
                let min_col = start_col_idx.min(end_col_idx);
                let max_col = start_col_idx.max(end_col_idx);

                // Add all cells in the range
                for r in min_row..=max_row {
                    for c in min_col..=max_col {
                        deps.insert((r, c));
                    }
                }
            }
        }

        Expression::ColumnRef { start_col, end_col, .. } => {
            // Expand column reference to all cells in those columns within bounds
            let start_col_idx = col_to_index(start_col);
            let end_col_idx = col_to_index(end_col);

            let min_col = start_col_idx.min(end_col_idx);
            let max_col = start_col_idx.max(end_col_idx).min(bounds.max_col);

            for c in min_col..=max_col {
                for r in 0..=bounds.max_row {
                    deps.insert((r, c));
                }
            }
        }

        Expression::RowRef { start_row, end_row, .. } => {
            // Expand row reference to all cells in those rows within bounds
            let start_row_idx = start_row - 1; // Convert to 0-based
            let end_row_idx = end_row - 1;

            let min_row = start_row_idx.min(end_row_idx);
            let max_row = start_row_idx.max(end_row_idx).min(bounds.max_row);

            for r in min_row..=max_row {
                for c in 0..=bounds.max_col {
                    deps.insert((r, c));
                }
            }
        }

        Expression::BinaryOp { left, right, .. } => {
            extract_recursive(left, deps, bounds);
            extract_recursive(right, deps, bounds);
        }

        Expression::UnaryOp { operand, .. } => {
            extract_recursive(operand, deps, bounds);
        }

        Expression::FunctionCall { args, .. } => {
            for arg in args {
                extract_recursive(arg, deps, bounds);
            }
        }

        // 3D references span multiple sheets - for backward compat (same-sheet only),
        // extract the inner reference's cells without sheet context.
        Expression::Sheet3DRef { reference, .. } => {
            extract_recursive(reference, deps, bounds);
        }

        // TableRef should be resolved before dependency extraction.
        // If still present, skip (will produce #NAME? during evaluation).
        Expression::TableRef { .. } => {}
    }
}

/// Recursive helper for dependency extraction with sheet context.
fn extract_recursive_with_sheets(
    expr: &Expression,
    deps: &mut HashSet<SheetCellRef>,
    bounds: GridBounds,
) {
    match expr {
        Expression::Literal(_) => {
            // Literals don't reference any cells
        }

        Expression::CellRef { sheet, col, row } => {
            let col_idx = col_to_index(col);
            let row_idx = row - 1;
            deps.insert(SheetCellRef {
                sheet: sheet.clone(),
                row: row_idx,
                col: col_idx,
            });
        }

        Expression::Range { sheet, start, end } => {
            if let (
                Expression::CellRef {
                    col: start_col,
                    row: start_row,
                    ..
                },
                Expression::CellRef {
                    col: end_col,
                    row: end_row,
                    ..
                },
            ) = (start.as_ref(), end.as_ref())
            {
                let start_col_idx = col_to_index(start_col);
                let end_col_idx = col_to_index(end_col);
                let start_row_idx = start_row - 1;
                let end_row_idx = end_row - 1;

                let min_row = start_row_idx.min(end_row_idx);
                let max_row = start_row_idx.max(end_row_idx);
                let min_col = start_col_idx.min(end_col_idx);
                let max_col = start_col_idx.max(end_col_idx);

                for r in min_row..=max_row {
                    for c in min_col..=max_col {
                        deps.insert(SheetCellRef {
                            sheet: sheet.clone(),
                            row: r,
                            col: c,
                        });
                    }
                }
            }
        }

        Expression::ColumnRef { sheet, start_col, end_col } => {
            let start_col_idx = col_to_index(start_col);
            let end_col_idx = col_to_index(end_col);

            let min_col = start_col_idx.min(end_col_idx);
            let max_col = start_col_idx.max(end_col_idx).min(bounds.max_col);

            for c in min_col..=max_col {
                for r in 0..=bounds.max_row {
                    deps.insert(SheetCellRef {
                        sheet: sheet.clone(),
                        row: r,
                        col: c,
                    });
                }
            }
        }

        Expression::RowRef { sheet, start_row, end_row } => {
            let start_row_idx = start_row - 1;
            let end_row_idx = end_row - 1;

            let min_row = start_row_idx.min(end_row_idx);
            let max_row = start_row_idx.max(end_row_idx).min(bounds.max_row);

            for r in min_row..=max_row {
                for c in 0..=bounds.max_col {
                    deps.insert(SheetCellRef {
                        sheet: sheet.clone(),
                        row: r,
                        col: c,
                    });
                }
            }
        }

        Expression::BinaryOp { left, right, .. } => {
            extract_recursive_with_sheets(left, deps, bounds);
            extract_recursive_with_sheets(right, deps, bounds);
        }

        Expression::UnaryOp { operand, .. } => {
            extract_recursive_with_sheets(operand, deps, bounds);
        }

        Expression::FunctionCall { args, .. } => {
            for arg in args {
                extract_recursive_with_sheets(arg, deps, bounds);
            }
        }

        // 3D references: extract the inner reference's cells tagged with each sheet
        // in the range. Without sheet_order info, we tag with start and end sheets.
        Expression::Sheet3DRef { start_sheet, end_sheet, reference } => {
            // Extract the inner reference's cells (without sheet prefix)
            let mut inner_deps = HashSet::new();
            extract_recursive(reference, &mut inner_deps, bounds);

            // Tag each cell with both bookend sheets as dependencies.
            // Full expansion requires sheet_order which is not available here.
            // The caller can use extract_3d_dependencies() for full expansion.
            for (row, col) in &inner_deps {
                deps.insert(SheetCellRef {
                    sheet: Some(start_sheet.clone()),
                    row: *row,
                    col: *col,
                });
                deps.insert(SheetCellRef {
                    sheet: Some(end_sheet.clone()),
                    row: *row,
                    col: *col,
                });
            }
        }

        // TableRef should be resolved before dependency extraction.
        Expression::TableRef { .. } => {}
    }
}

/// Extracts all dependencies from a 3D reference, expanding across all sheets in range.
/// This provides full expansion when sheet_order is known.
pub fn extract_3d_dependencies(
    start_sheet: &str,
    end_sheet: &str,
    inner_ref: &Expression,
    sheet_order: &[String],
    bounds: GridBounds,
) -> HashSet<SheetCellRef> {
    let mut deps = HashSet::new();
    let sheets = get_sheets_in_range(start_sheet, end_sheet, sheet_order);

    // Extract inner reference cells (without sheet context)
    let mut inner_deps = HashSet::new();
    extract_recursive(inner_ref, &mut inner_deps, bounds);

    // Tag each cell with each sheet in the range
    for sheet_name in sheets {
        for (row, col) in &inner_deps {
            deps.insert(SheetCellRef {
                sheet: Some(sheet_name.clone()),
                row: *row,
                col: *col,
            });
        }
    }

    deps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_of(coords: &[CellCoord]) -> HashSet<CellCoord> {
        coords.iter().cloned().collect()
    }

    #[test]
    fn test_extract_single_cell() {
        // =A1
        let expr = Expression::CellRef {
            sheet: None,
            col: "A".to_string(),
            row: 1,
        };

        let deps = extract_dependencies(&expr);
        assert_eq!(deps, set_of(&[(0, 0)]));
    }

    #[test]
    fn test_extract_multiple_cells() {
        // =A1 + B2
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
                row: 2,
            }),
        };

        let deps = extract_dependencies(&expr);
        assert_eq!(deps, set_of(&[(0, 0), (1, 1)]));
    }

    #[test]
    fn test_extract_range() {
        // =SUM(A1:A3)
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 3,
                }),
            }],
        };

        let deps = extract_dependencies(&expr);
        assert_eq!(deps, set_of(&[(0, 0), (1, 0), (2, 0)]));
    }

    #[test]
    fn test_extract_column_ref() {
        // =SUM(A:A) with small bounds
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::ColumnRef {
                sheet: None,
                start_col: "A".to_string(),
                end_col: "A".to_string(),
            }],
        };

        let bounds = GridBounds {
            max_row: 2,
            max_col: 2,
        };
        let deps = extract_dependencies_with_bounds(&expr, bounds);

        // Should include A1, A2, A3 (rows 0, 1, 2)
        assert!(deps.contains(&(0, 0)));
        assert!(deps.contains(&(1, 0)));
        assert!(deps.contains(&(2, 0)));
        assert_eq!(deps.len(), 3);
    }

    #[test]
    fn test_extract_row_ref() {
        // =SUM(1:1) with small bounds
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::RowRef {
                sheet: None,
                start_row: 1,
                end_row: 1,
            }],
        };

        let bounds = GridBounds {
            max_row: 2,
            max_col: 2,
        };
        let deps = extract_dependencies_with_bounds(&expr, bounds);

        // Should include A1, B1, C1 (cols 0, 1, 2)
        assert!(deps.contains(&(0, 0)));
        assert!(deps.contains(&(0, 1)));
        assert!(deps.contains(&(0, 2)));
        assert_eq!(deps.len(), 3);
    }

    #[test]
    fn test_extract_2d_range() {
        // =SUM(A1:B2)
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "B".to_string(),
                    row: 2,
                }),
            }],
        };

        let deps = extract_dependencies(&expr);
        // Should include A1, A2, B1, B2
        assert_eq!(deps, set_of(&[(0, 0), (0, 1), (1, 0), (1, 1)]));
    }

    #[test]
    fn test_extract_reversed_range() {
        // =SUM(B2:A1) - reversed range should still work
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "B".to_string(),
                    row: 2,
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                }),
            }],
        };

        let deps = extract_dependencies(&expr);
        assert_eq!(deps, set_of(&[(0, 0), (0, 1), (1, 0), (1, 1)]));
    }

    #[test]
    fn test_extract_nested_function() {
        // =SUM(A1:A3) + MAX(B1, B2)
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::FunctionCall {
                func: BuiltinFunction::Sum,
                args: vec![Expression::Range {
                    sheet: None,
                    start: Box::new(Expression::CellRef {
                        sheet: None,
                        col: "A".to_string(),
                        row: 1,
                    }),
                    end: Box::new(Expression::CellRef {
                        sheet: None,
                        col: "A".to_string(),
                        row: 3,
                    }),
                }],
            }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::FunctionCall {
                func: BuiltinFunction::Max,
                args: vec![
                    Expression::CellRef {
                        sheet: None,
                        col: "B".to_string(),
                        row: 1,
                    },
                    Expression::CellRef {
                        sheet: None,
                        col: "B".to_string(),
                        row: 2,
                    },
                ],
            }),
        };

        let deps = extract_dependencies(&expr);
        // A1, A2, A3, B1, B2
        assert_eq!(deps, set_of(&[(0, 0), (1, 0), (2, 0), (0, 1), (1, 1)]));
    }

    #[test]
    fn test_extract_literal_only() {
        // =5 + 3
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(5.0))),
            op: BinaryOperator::Add,
            right: Box::new(Expression::Literal(Value::Number(3.0))),
        };

        let deps = extract_dependencies(&expr);
        assert!(deps.is_empty());
    }

    #[test]
    fn test_extract_unary() {
        // =-A1
        let expr = Expression::UnaryOp {
            op: UnaryOperator::Negate,
            operand: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
        };

        let deps = extract_dependencies(&expr);
        assert_eq!(deps, set_of(&[(0, 0)]));
    }

    #[test]
    fn test_extract_large_column() {
        // =AA100
        let expr = Expression::CellRef {
            sheet: None,
            col: "AA".to_string(),
            row: 100,
        };

        let deps = extract_dependencies(&expr);
        assert_eq!(deps, set_of(&[(99, 26)])); // row 99, col 26 (AA)
    }

    #[test]
    fn test_duplicate_references() {
        // =A1 + A1 (same cell referenced twice)
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
        };

        let deps = extract_dependencies(&expr);
        // Should only contain one entry for A1
        assert_eq!(deps.len(), 1);
        assert_eq!(deps, set_of(&[(0, 0)]));
    }

    #[test]
    fn test_extract_cross_sheet_ref() {
        // =Sheet1!A1
        let expr = Expression::CellRef {
            sheet: Some("Sheet1".to_string()),
            col: "A".to_string(),
            row: 1,
        };

        let deps = extract_dependencies_with_sheets(&expr, GridBounds::default());
        assert_eq!(deps.len(), 1);
        let dep = deps.iter().next().unwrap();
        assert_eq!(dep.sheet, Some("Sheet1".to_string()));
        assert_eq!(dep.row, 0);
        assert_eq!(dep.col, 0);
    }

    #[test]
    fn test_extract_cross_sheet_range() {
        // =Sheet2!A1:B2
        let expr = Expression::Range {
            sheet: Some("Sheet2".to_string()),
            start: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
            end: Box::new(Expression::CellRef {
                sheet: None,
                col: "B".to_string(),
                row: 2,
            }),
        };

        let deps = extract_dependencies_with_sheets(&expr, GridBounds::default());
        assert_eq!(deps.len(), 4);
        for dep in &deps {
            assert_eq!(dep.sheet, Some("Sheet2".to_string()));
        }
    }

    // ==================== 3D Reference Dependency Tests ====================

    #[test]
    fn test_get_sheets_in_range() {
        let order = vec![
            "Sheet1".to_string(),
            "Sheet2".to_string(),
            "Sheet3".to_string(),
            "Sheet4".to_string(),
        ];

        // Normal range
        let result = get_sheets_in_range("Sheet1", "Sheet3", &order);
        assert_eq!(result, vec!["Sheet1", "Sheet2", "Sheet3"]);

        // Reversed range
        let result = get_sheets_in_range("Sheet3", "Sheet1", &order);
        assert_eq!(result, vec!["Sheet1", "Sheet2", "Sheet3"]);

        // Single sheet
        let result = get_sheets_in_range("Sheet2", "Sheet2", &order);
        assert_eq!(result, vec!["Sheet2"]);

        // Non-existent sheet
        let result = get_sheets_in_range("Sheet1", "NoSheet", &order);
        assert!(result.is_empty());
    }

    #[test]
    fn test_get_sheets_in_range_case_insensitive() {
        let order = vec![
            "Sheet1".to_string(),
            "Sheet2".to_string(),
            "Sheet3".to_string(),
        ];

        let result = get_sheets_in_range("sheet1", "SHEET3", &order);
        assert_eq!(result, vec!["Sheet1", "Sheet2", "Sheet3"]);
    }

    #[test]
    fn test_extract_3d_ref_backward_compat() {
        // 3D ref in backward-compat mode (no sheet info, just cell coords)
        let expr = Expression::Sheet3DRef {
            start_sheet: "Sheet1".to_string(),
            end_sheet: "Sheet3".to_string(),
            reference: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
        };

        let deps = extract_dependencies(&expr);
        // Should extract just A1 (0,0) without sheet info
        assert_eq!(deps, set_of(&[(0, 0)]));
    }

    #[test]
    fn test_extract_3d_ref_with_sheets() {
        // 3D ref with sheet context - should tag with both bookend sheets
        let expr = Expression::Sheet3DRef {
            start_sheet: "Sheet1".to_string(),
            end_sheet: "Sheet3".to_string(),
            reference: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
        };

        let deps = extract_dependencies_with_sheets(&expr, GridBounds::default());
        // Should have 2 entries: A1 tagged with Sheet1, A1 tagged with Sheet3
        assert_eq!(deps.len(), 2);
        assert!(deps.contains(&SheetCellRef {
            sheet: Some("Sheet1".to_string()),
            row: 0,
            col: 0,
        }));
        assert!(deps.contains(&SheetCellRef {
            sheet: Some("Sheet3".to_string()),
            row: 0,
            col: 0,
        }));
    }

    #[test]
    fn test_extract_3d_dependencies_full() {
        // Full expansion with sheet_order
        let sheet_order = vec![
            "Sheet1".to_string(),
            "Sheet2".to_string(),
            "Sheet3".to_string(),
        ];

        let inner_ref = Expression::CellRef {
            sheet: None,
            col: "B".to_string(),
            row: 2,
        };

        let deps = extract_3d_dependencies(
            "Sheet1",
            "Sheet3",
            &inner_ref,
            &sheet_order,
            GridBounds::default(),
        );

        // Should have 3 entries: B2 on Sheet1, Sheet2, Sheet3
        assert_eq!(deps.len(), 3);
        for sheet in &["Sheet1", "Sheet2", "Sheet3"] {
            assert!(deps.contains(&SheetCellRef {
                sheet: Some(sheet.to_string()),
                row: 1,  // B2 -> row 1 (0-based)
                col: 1,  // B -> col 1
            }));
        }
    }

    #[test]
    fn test_extract_3d_dependencies_range() {
        // 3D ref with range: Sheet1:Sheet2!A1:B2
        let sheet_order = vec![
            "Sheet1".to_string(),
            "Sheet2".to_string(),
            "Sheet3".to_string(),
        ];

        let inner_ref = Expression::Range {
            sheet: None,
            start: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
            }),
            end: Box::new(Expression::CellRef {
                sheet: None,
                col: "B".to_string(),
                row: 2,
            }),
        };

        let deps = extract_3d_dependencies(
            "Sheet1",
            "Sheet2",
            &inner_ref,
            &sheet_order,
            GridBounds::default(),
        );

        // 4 cells (A1, A2, B1, B2) x 2 sheets = 8 entries
        assert_eq!(deps.len(), 8);
        for sheet in &["Sheet1", "Sheet2"] {
            for (r, c) in &[(0u32, 0u32), (0, 1), (1, 0), (1, 1)] {
                assert!(deps.contains(&SheetCellRef {
                    sheet: Some(sheet.to_string()),
                    row: *r,
                    col: *c,
                }));
            }
        }
    }
}