//! FILENAME: core/engine/src/ast_render.rs
//! PURPOSE: Renders a formula AST back to a canonical formula string.
//! CONTEXT: This is the single canonical renderer for AST → string conversion.
//! Used by Cell::formula_string(), the formula bar, persistence (debug only),
//! and anywhere a formula needs to be displayed as text.
//!
//! RULES:
//! - Function names are uppercase (SUM, not sum)
//! - Whitespace is normalized (no user-typed whitespace preserved)
//! - Absolute reference markers ($) are preserved
//! - Sheet names with spaces or apostrophes are quoted

use parser::ast::{Expression, TableSpecifier, Value};

/// Render a formula AST to its canonical string representation.
/// Does NOT include a leading '=' — the caller adds it if needed for display.
pub fn render_formula(expr: &Expression) -> String {
    render_expr(expr)
}

fn render_expr(expr: &Expression) -> String {
    match expr {
        Expression::Literal(val) => render_value(val),

        Expression::CellRef { sheet, col, row, col_absolute, row_absolute, .. } => {
            let mut s = render_sheet_prefix(sheet);
            if *col_absolute { s.push('$'); }
            s.push_str(col);
            if *row_absolute { s.push('$'); }
            s.push_str(&row.to_string());
            s
        }

        Expression::Range { sheet, start, end, .. } => {
            let mut s = render_sheet_prefix(sheet);
            s.push_str(&render_expr_no_sheet(start));
            s.push(':');
            s.push_str(&render_expr_no_sheet(end));
            s
        }

        Expression::ColumnRef { sheet, start_col, end_col, start_absolute, end_absolute, .. } => {
            let mut s = render_sheet_prefix(sheet);
            if *start_absolute { s.push('$'); }
            s.push_str(start_col);
            s.push(':');
            if *end_absolute { s.push('$'); }
            s.push_str(end_col);
            s
        }

        Expression::RowRef { sheet, start_row, end_row, start_absolute, end_absolute, .. } => {
            let mut s = render_sheet_prefix(sheet);
            if *start_absolute { s.push('$'); }
            s.push_str(&start_row.to_string());
            s.push(':');
            if *end_absolute { s.push('$'); }
            s.push_str(&end_row.to_string());
            s
        }

        Expression::BinaryOp { left, op, right } => {
            format!("{}{}{}", render_expr(left), op, render_expr(right))
        }

        Expression::UnaryOp { op, operand } => {
            format!("{}{}", op, render_expr(operand))
        }

        Expression::FunctionCall { func, args, .. } => {
            let name = func.to_canonical_name();
            let arg_strs: Vec<String> = args.iter().map(render_expr).collect();
            format!("{}({})", name, arg_strs.join(","))
        }

        Expression::NamedRef { name, .. } => name.clone(),

        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            let combined = format!("{}:{}", start_sheet, end_sheet);
            let prefix = if needs_quoting(start_sheet) || needs_quoting(end_sheet) {
                format!("'{}'!", combined)
            } else {
                format!("{}!", combined)
            };
            format!("{}{}", prefix, render_expr(reference))
        }

        Expression::TableRef { table_name, specifier, .. } => {
            let spec_str = render_table_specifier(specifier);
            if table_name.is_empty() {
                spec_str
            } else {
                format!("{}{}", table_name, spec_str)
            }
        }

        Expression::IndexAccess { target, index } => {
            format!("{}[{}]", render_expr(target), render_expr(index))
        }

        Expression::ListLiteral { elements } => {
            let inner: Vec<String> = elements.iter().map(render_expr).collect();
            format!("{{{}}}", inner.join(", "))
        }

        Expression::DictLiteral { entries } => {
            let inner: Vec<String> = entries.iter()
                .map(|(k, v)| format!("{}: {}", render_expr(k), render_expr(v)))
                .collect();
            format!("{{{}}}", inner.join(", "))
        }

        Expression::SpillRef { cell, .. } => {
            format!("{}#", render_expr(cell))
        }

        Expression::ImplicitIntersection { operand } => {
            format!("@{}", render_expr(operand))
        }
    }
}

/// Render a CellRef without its sheet prefix (for Range start/end endpoints).
fn render_expr_no_sheet(expr: &Expression) -> String {
    match expr {
        Expression::CellRef { col, row, col_absolute, row_absolute, .. } => {
            let mut s = String::new();
            if *col_absolute { s.push('$'); }
            s.push_str(col);
            if *row_absolute { s.push('$'); }
            s.push_str(&row.to_string());
            s
        }
        _ => render_expr(expr),
    }
}

fn render_value(val: &Value) -> String {
    match val {
        Value::Number(n) => {
            if *n == (*n as i64) as f64 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        Value::String(s) => format!("\"{}\"", s),
        Value::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
    }
}

fn render_sheet_prefix(sheet: &Option<String>) -> String {
    match sheet {
        Some(name) if needs_quoting(name) => format!("'{}'!", name),
        Some(name) => format!("{}!", name),
        None => String::new(),
    }
}

fn needs_quoting(name: &str) -> bool {
    name.contains(' ') || name.contains('\'')
}

/// Render a TableSpecifier to its bracket notation.
pub fn render_table_specifier(spec: &TableSpecifier) -> String {
    match spec {
        TableSpecifier::Column(name) => format!("[{}]", name),
        TableSpecifier::ThisRow(name) => format!("[@{}]", name),
        TableSpecifier::ColumnRange(start, end) => format!("[{}]:[{}]", start, end),
        TableSpecifier::ThisRowRange(start, end) => format!("[@{}]:[@{}]", start, end),
        TableSpecifier::AllRows => "[#All]".to_string(),
        TableSpecifier::DataRows => "[#Data]".to_string(),
        TableSpecifier::Headers => "[#Headers]".to_string(),
        TableSpecifier::Totals => "[#Totals]".to_string(),
        TableSpecifier::SpecialColumn(special, col) => {
            format!("{},{}", render_table_specifier(special), col)
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use parser::ast::{BinaryOperator, BuiltinFunction};

    #[test]
    fn render_simple_cell_ref() {
        let expr = Expression::CellRef {
            sheet: None,
            col: "A".to_string(),
            row: 1,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "A1");
    }

    #[test]
    fn render_absolute_cell_ref() {
        let expr = Expression::CellRef {
            sheet: None,
            col: "B".to_string(),
            row: 5,
            col_absolute: true,
            row_absolute: true,
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "$B$5");
    }

    #[test]
    fn render_cross_sheet_ref() {
        let expr = Expression::CellRef {
            sheet: Some("Sales Data".to_string()),
            col: "C".to_string(),
            row: 10,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "'Sales Data'!C10");
    }

    #[test]
    fn render_range() {
        let expr = Expression::Range {
            sheet: None,
            start: Box::new(Expression::CellRef {
                sheet: None, col: "A".to_string(), row: 1,
                col_absolute: false, row_absolute: false,
                ref_site_id: Default::default(),
            }),
            end: Box::new(Expression::CellRef {
                sheet: None, col: "A".to_string(), row: 10,
                col_absolute: false, row_absolute: false,
                ref_site_id: Default::default(),
            }),
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "A1:A10");
    }

    #[test]
    fn render_function_call() {
        let expr = Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef {
                    sheet: None, col: "A".to_string(), row: 1,
                    col_absolute: false, row_absolute: false,
                    ref_site_id: Default::default(),
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None, col: "A".to_string(), row: 10,
                    col_absolute: false, row_absolute: false,
                    ref_site_id: Default::default(),
                }),
                ref_site_id: Default::default(),
            }],
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "SUM(A1:A10)");
    }

    #[test]
    fn render_binary_op() {
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None, col: "A".to_string(), row: 1,
                col_absolute: false, row_absolute: false,
                ref_site_id: Default::default(),
            }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::CellRef {
                sheet: None, col: "B".to_string(), row: 1,
                col_absolute: false, row_absolute: false,
                ref_site_id: Default::default(),
            }),
        };
        assert_eq!(render_formula(&expr), "A1+B1");
    }

    #[test]
    fn render_literal() {
        assert_eq!(render_formula(&Expression::Literal(Value::Number(42.0))), "42");
        assert_eq!(render_formula(&Expression::Literal(Value::String("hello".to_string()))), "\"hello\"");
        assert_eq!(render_formula(&Expression::Literal(Value::Boolean(true))), "TRUE");
    }

    #[test]
    fn render_column_ref() {
        let expr = Expression::ColumnRef {
            sheet: None,
            start_col: "A".to_string(),
            end_col: "B".to_string(),
            start_absolute: true,
            end_absolute: false,
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "$A:B");
    }

    #[test]
    fn render_table_ref() {
        let expr = Expression::TableRef {
            table_name: "Sales".to_string(),
            specifier: TableSpecifier::Column("Revenue".to_string()),
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&expr), "Sales[Revenue]");
    }
}
