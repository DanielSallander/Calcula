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

use parser::ast::{BinaryOperator, BuiltinFunction, Expression, TableSpecifier, Value};

// ---------------------------------------------------------------------------
// OPERATOR PRECEDENCE
//
// The AST has no parenthesis node: `parse_primary`'s `Token::LParen` arm
// returns the inner expression and the grouping is gone. That is fine as long
// as the RENDERER puts the parentheses back wherever the tree binds more
// tightly than the flat text would. It did not, so `=(A1+B1)*C1` rendered
// `A1+B1*C1` — the formula bar showed a formula the user never typed, and
// because persistence stores the RENDERED text and re-parses it on load, the
// saved workbook came back computing a different number.
//
// These levels mirror the parser's descent chain exactly, lowest first:
//   parse_comparison -> parse_concatenation -> parse_additive
//     -> parse_multiplicative -> parse_unary -> parse_power -> parse_primary
// If that chain ever changes, these must change with it; the round-trip
// property test in this file is what enforces the pairing.
// ---------------------------------------------------------------------------

const PREC_COMPARE: u8 = 1;
const PREC_CONCAT: u8 = 2;
const PREC_ADD: u8 = 3;
const PREC_MUL: u8 = 4;
const PREC_UNARY: u8 = 5;
const PREC_POWER: u8 = 6;
/// Anything that parses as a primary and can never need guarding.
const PREC_ATOM: u8 = 7;

fn binding_power(op: &BinaryOperator) -> u8 {
    match op {
        BinaryOperator::Equal
        | BinaryOperator::NotEqual
        | BinaryOperator::LessThan
        | BinaryOperator::GreaterThan
        | BinaryOperator::LessEqual
        | BinaryOperator::GreaterEqual => PREC_COMPARE,
        BinaryOperator::Concat => PREC_CONCAT,
        BinaryOperator::Add | BinaryOperator::Subtract => PREC_ADD,
        BinaryOperator::Multiply | BinaryOperator::Divide => PREC_MUL,
        BinaryOperator::Power => PREC_POWER,
    }
}

/// How tightly `expr` binds once rendered — i.e. the precedence level a reader
/// of the produced TEXT would assign to it.
fn precedence(expr: &Expression) -> u8 {
    match expr {
        Expression::BinaryOp { op, .. } => binding_power(op),
        Expression::UnaryOp { .. } => PREC_UNARY,
        // A negative number literal renders with a leading `-`, so in text it
        // behaves exactly like a unary negation: `-5^2` would re-parse as
        // `-(5^2)`. The parser can never produce this node, but a script or a
        // constant-folding pass can.
        Expression::Literal(Value::Number(n)) if *n < 0.0 => PREC_UNARY,
        _ => PREC_ATOM,
    }
}

/// Render `child` as an operand, parenthesising it when the surrounding
/// position demands at least `min_prec` and the child binds looser than that.
fn render_child(child: &Expression, min_prec: u8, collapse: bool) -> String {
    let text = render_expr(child, collapse);
    if precedence(child) < min_prec {
        format!("({})", text)
    } else {
        text
    }
}

/// Render a formula AST to its canonical string representation.
/// Does NOT include a leading '=' — the caller adds it if needed for display.
///
/// The internal `__INVOKE__("Name", lambda, args...)` marker that name
/// resolution injects for user-defined (named `LAMBDA`) function calls is
/// collapsed back to the friendly `Name(args...)` so the formula bar shows the
/// authored call rather than the expanded LAMBDA. Use [`render_formula_raw`]
/// wherever the expanded form must be preserved (persistence / round-tripping).
pub fn render_formula(expr: &Expression) -> String {
    render_expr(expr, true)
}

/// Like [`render_formula`] but preserves the literal `__INVOKE__(...)` marker
/// instead of collapsing it to the friendly function name. Used by persistence
/// so the saved (and re-parsed-on-load) formula keeps the resolved form that
/// dependency extraction and evaluation rely on.
pub fn render_formula_raw(expr: &Expression) -> String {
    render_expr(expr, false)
}

fn render_expr(expr: &Expression, collapse: bool) -> String {
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
            s.push_str(&render_expr_no_sheet(start, collapse));
            s.push(':');
            s.push_str(&render_expr_no_sheet(end, collapse));
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
            let p = binding_power(op);
            // `^` is the one RIGHT-associative operator, and `parse_power` takes
            // its LEFT operand from `parse_primary` rather than `parse_unary`,
            // so anything carrying its own operator on the left of a `^` must be
            // parenthesised or it re-parses as something else.
            let (left_min, right_min) = if *op == BinaryOperator::Power {
                (PREC_ATOM, p)
            } else {
                (p, p + 1)
            };
            format!(
                "{}{}{}",
                render_child(left, left_min, collapse),
                op,
                render_child(right, right_min, collapse)
            )
        }

        Expression::UnaryOp { op, operand } => {
            // `parse_unary`'s operand is itself `parse_unary`, so a nested unary
            // or a `^` needs no parentheses; anything looser does.
            format!("{}{}", op, render_child(operand, PREC_UNARY, collapse))
        }

        Expression::FunctionCall { func, args, .. } => {
            // Collapse the named-function invocation marker back to `Name(args)`
            // for display. The raw path (collapse == false) falls through and
            // renders the literal `__INVOKE__("Name", lambda, args)` form.
            if collapse {
                if let Some(collapsed) = try_render_named_invoke(func, args) {
                    return collapsed;
                }
            }
            let name = func.to_canonical_name();
            let arg_strs: Vec<String> = args.iter().map(|a| render_expr(a, collapse)).collect();
            format!("{}({})", name, arg_strs.join(","))
        }

        Expression::NamedRef { name, .. } => name.clone(),

        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            let prefix = if needs_quoting(start_sheet) || needs_quoting(end_sheet) {
                // ONE pair of apostrophes wraps the whole `A:B` bookend pair, so
                // each half is escaped but not separately quoted.
                format!(
                    "'{}:{}'!",
                    start_sheet.replace('\'', "''"),
                    end_sheet.replace('\'', "''")
                )
            } else {
                format!("{}:{}!", start_sheet, end_sheet)
            };
            format!("{}{}", prefix, render_expr(reference, collapse))
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
            // The subscript chain is parsed off a primary; the index sits inside
            // brackets and so needs no guarding.
            format!(
                "{}[{}]",
                render_child(target, PREC_ATOM, collapse),
                render_expr(index, collapse)
            )
        }

        Expression::ListLiteral { elements } => {
            let inner: Vec<String> = elements.iter().map(|e| render_expr(e, collapse)).collect();
            format!("{{{}}}", inner.join(", "))
        }

        Expression::DictLiteral { entries } => {
            let inner: Vec<String> = entries.iter()
                .map(|(k, v)| format!("{}: {}", render_expr(k, collapse), render_expr(v, collapse)))
                .collect();
            format!("{{{}}}", inner.join(", "))
        }

        Expression::SpillRef { cell, .. } => {
            format!("{}#", render_child(cell, PREC_ATOM, collapse))
        }

        Expression::ImplicitIntersection { operand } => {
            // `@` takes a `parse_primary`, so its operand must be atom-level.
            format!("@{}", render_child(operand, PREC_ATOM, collapse))
        }
    }
}

/// If `func`/`args` are the named-function invocation marker
/// `__INVOKE__("Name", lambda, arg1, ...)`, render it back to `Name(arg1, ...)`.
/// Returns `None` for the inline-lambda shape `__INVOKE__(lambda, args)` (no
/// leading name literal) and for any non-invoke call, so the caller renders
/// those normally.
fn try_render_named_invoke(func: &BuiltinFunction, args: &[Expression]) -> Option<String> {
    let BuiltinFunction::Custom(name) = func else { return None; };
    if name != "__INVOKE__" || args.len() < 2 {
        return None;
    }
    // Named form only: args[0] is the display-name string literal, args[1] is
    // the resolved LAMBDA, args[2..] are the call arguments.
    let Expression::Literal(Value::String(fn_name)) = &args[0] else { return None; };
    let arg_strs: Vec<String> = args[2..].iter().map(|a| render_expr(a, true)).collect();
    Some(format!("{}({})", fn_name, arg_strs.join(",")))
}

/// Render a CellRef without its sheet prefix (for Range start/end endpoints).
fn render_expr_no_sheet(expr: &Expression, collapse: bool) -> String {
    match expr {
        Expression::CellRef { col, row, col_absolute, row_absolute, .. } => {
            let mut s = String::new();
            if *col_absolute { s.push('$'); }
            s.push_str(col);
            if *row_absolute { s.push('$'); }
            s.push_str(&row.to_string());
            s
        }
        _ => render_expr(expr, collapse),
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
        // A `"` inside the text is written `""` -- the escape the lexer reads
        // back. Without it a string carrying a quote rendered to text that does
        // not re-parse, and was lost on save/reload.
        Value::String(s) => format!("\"{}\"", s.replace('"', "\"\"")),
        Value::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
    }
}

fn render_sheet_prefix(sheet: &Option<String>) -> String {
    match sheet {
        Some(name) => format!("{}!", quote_sheet_name(name)),
        None => String::new(),
    }
}

/// A sheet name as it must appear in formula text: bare when it lexes as a
/// plain identifier, otherwise wrapped in apostrophes with every embedded
/// apostrophe DOUBLED -- the escape `read_quoted_identifier` already reads.
///
/// The old rule quoted only names containing a space or an apostrophe, and it
/// never doubled. Both halves lost data. `John's` was emitted as
/// `'John's'!A1`, which does not lex; `Q1-2026` and `2026` were emitted
/// bare, which lexes as arithmetic. `repair_all_formulas` turns a formula that
/// fails to re-parse into a plain value, so renaming a sheet to any such name
/// silently destroyed every formula that referred to it.
pub fn quote_sheet_name(name: &str) -> String {
    if is_bare_sheet_name(name) {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

/// True when `name` can be written without apostrophes: identifier-shaped, and
/// not itself a cell reference (a bare `A1` would lex as one).
fn is_bare_sheet_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    // A reference-SHAPED name (`A1`, `ZZ100`) needs no quoting: the trailing
    // `!` is what tells the lexer this is a sheet, and `=A1!B2` parses with
    // sheet `A1`. Quoting them would have been harmless in isolation but it
    // also captures `Sheet1`, `Sheet2`, `Q1` -- the DEFAULT sheet names -- and
    // would have re-quoted the formula text of essentially every existing
    // workbook for nothing.
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

fn needs_quoting(name: &str) -> bool {
    !is_bare_sheet_name(name)
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

    /// A named user-defined function call is stored resolved as the marker
    /// `__INVOKE__("Name", lambda, args...)`. Display must collapse it back to
    /// `Name(args...)` (the reported bug: the formula bar leaked the expanded
    /// `__INVOKE__(LAMBDA(...))`), while the raw renderer preserves it so
    /// persistence round-trips the resolved form.
    #[test]
    fn render_collapses_named_invoke() {
        let d4 = Expression::CellRef {
            sheet: None, col: "D".to_string(), row: 4,
            col_absolute: false, row_absolute: false,
            ref_site_id: Default::default(),
        };
        // args[1] is the resolved LAMBDA — the display path never inspects it,
        // so a placeholder literal stands in for it here.
        let invoke = Expression::FunctionCall {
            func: BuiltinFunction::Custom("__INVOKE__".to_string()),
            args: vec![
                Expression::Literal(Value::String("Double".to_string())),
                Expression::Literal(Value::Number(0.0)),
                d4,
            ],
            ref_site_id: Default::default(),
        };

        // Display collapses to the friendly call.
        assert_eq!(render_formula(&invoke), "Double(D4)");
        // Raw keeps the resolved marker (re-parseable, correct deps on load).
        let raw = render_formula_raw(&invoke);
        assert!(raw.starts_with("__INVOKE__(\"Double\","), "raw was: {}", raw);
        assert!(raw.ends_with(",D4)"), "raw was: {}", raw);
    }

    /// The inline-lambda shape `__INVOKE__(lambdaExpr, args)` (no leading name
    /// literal, produced by the parser for `LAMBDA(...)(x)`) must NOT collapse.
    #[test]
    fn render_does_not_collapse_inline_invoke() {
        let inline = Expression::FunctionCall {
            func: BuiltinFunction::Custom("__INVOKE__".to_string()),
            args: vec![
                // A non-string first arg marks the inline shape.
                Expression::FunctionCall {
                    func: BuiltinFunction::Sum,
                    args: vec![Expression::Literal(Value::Number(1.0))],
                    ref_site_id: Default::default(),
                },
                Expression::Literal(Value::Number(5.0)),
            ],
            ref_site_id: Default::default(),
        };
        assert_eq!(render_formula(&inline), "__INVOKE__(SUM(1),5)");
    }

    // -----------------------------------------------------------------------
    // ROUND-TRIP PROPERTY
    //
    // The AST has no parenthesis node, so the ONLY thing keeping a formula's
    // meaning intact across render -> re-parse is this renderer putting the
    // parentheses back. Persistence saves rendered text and re-parses it on
    // load, so a renderer that drops a grouping does not merely mis-display a
    // formula: it changes the number the workbook computes, silently, on the
    // next open.
    //
    // Nothing checked that before. Every renderer test above is a FLAT
    // expression, and the whole repo -- app, e2e, engine, parser -- never once
    // typed a grouped arithmetic expression, which is why `=(A1+B1)*C1`
    // rendering as `A1+B1*C1` survived. These two tests are the check that
    // makes the class unshippable: they enumerate the shapes rather than
    // sampling them.
    // -----------------------------------------------------------------------

    /// Every binary operator, at every precedence level the parser has.
    const OPS: [&str; 8] = ["+", "-", "*", "/", "^", "&", "=", "<"];

    fn round_trips(src: &str) -> Result<(), String> {
        let first = parser::parse(src).map_err(|e| format!("source did not parse: {:?}", e))?;
        let rendered = render_formula_raw(&first);
        let second = parser::parse(&format!("={}", rendered))
            .map_err(|e| format!("`{}` rendered `{}`, which does not parse: {:?}", src, rendered, e))?;
        if first != second {
            return Err(format!(
                "`{}` rendered `{}`, which re-parses to a DIFFERENT tree\n  before: {:?}\n  after:  {:?}",
                src, rendered, first, second
            ));
        }
        Ok(())
    }

    #[test]
    fn every_three_leaf_operator_pairing_survives_render_and_re_parse() {
        // Both associativity shapes for every ordered pair of operators. This
        // is the full cross-product of "parent binds tighter / looser / same"
        // against "child on the left / on the right", which is exactly the
        // matrix a precedence bug lives in.
        let mut failures = Vec::new();
        let mut checked = 0;
        for a in OPS {
            for b in OPS {
                for src in [
                    format!("=(A1{}B2){}C3", a, b),
                    format!("=A1{}(B2{}C3)", a, b),
                ] {
                    checked += 1;
                    if let Err(e) = round_trips(&src) {
                        failures.push(e);
                    }
                }
            }
        }
        assert_eq!(checked, 128, "the matrix must stay exhaustive");
        assert!(
            failures.is_empty(),
            "{} of {} groupings did not survive:\n{}",
            failures.len(),
            checked,
            failures.join("\n")
        );
    }

    #[test]
    fn unary_power_strings_and_sheet_names_survive_render_and_re_parse() {
        let cases = [
            // Unary negation against every precedence level.
            "=-(A1+B2)",
            "=-(A1*B2)",
            "=-(A1^B2)",
            "=-A1^B2",
            "=--A1",
            "=(-A1)^B2",
            // `^` is right-associative and takes its LEFT operand from
            // `parse_primary`, so a left-nested power must stay parenthesised.
            "=(A1^B2)^C3",
            "=A1^B2^C3",
            "=(A1*B2)^C3",
            // Same-precedence, right-hand side: the classic subtraction trap.
            "=A1-(B2-C3)",
            "=A1/(B2/C3)",
            "=A1&(B2&C3)",
            // Grouping nested inside a call argument.
            "=SUM((A1+B2)*C3,A1)",
            "=IF((A1+B2)>C3,\"y\",\"n\")",
            // Text literals carrying the delimiter.
            "=\"a\"\"b\"",
            "=\"\"\"quoted\"\"\"",
            "=A1&\"x\"\"y\"",
            // Sheet names that are not bare identifiers.
            "='My Sheet'!A1",
            "='John''s'!A1",
            "='Q1-2026'!A1",
            "='2026'!A1",
            "='A1'!B2",
            "=SUM('My Sheet'!A1:B2)",
        ];
        let failures: Vec<String> = cases
            .iter()
            .filter_map(|c| round_trips(c).err())
            .collect();
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn a_negative_number_literal_is_guarded_where_a_unary_minus_would_be() {
        // The parser can never build this node -- `-5` parses as a negation of
        // `5` -- but a script or a folding pass can, and rendered flat it would
        // re-parse as `-(5^2)`: 25 becomes -25.
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(-5.0))),
            op: BinaryOperator::Power,
            right: Box::new(Expression::Literal(Value::Number(2.0))),
        };
        assert_eq!(render_formula_raw(&expr), "(-5)^2");
    }

    #[test]
    fn a_sheet_name_that_would_lex_as_something_else_is_quoted_and_escaped() {
        // `needs_quoting` used to ask only "does it contain a space or an
        // apostrophe". Each name here was emitted BARE or emitted with an
        // unescaped apostrophe, producing formula text that does not lex --
        // and `repair_all_formulas` turns a formula that fails to re-parse into
        // a plain value, so a rename to any of these silently destroyed every
        // formula that named the sheet.
        for name in ["Q1-2026", "2026", "John's", "a b", "Sales+", "x!y", "'", "a''b"] {
            let rendered = quote_sheet_name(name);
            assert!(
                rendered.starts_with('\'') && rendered.ends_with('\''),
                "`{}` must be quoted, got `{}`",
                name,
                rendered
            );
            let formula = format!("={}!A1", rendered);
            let parsed = parser::parse(&formula).unwrap_or_else(|e| {
                panic!("`{}` produced `{}`, which does not parse: {:?}", name, formula, e)
            });
            match parsed {
                Expression::CellRef { sheet: Some(got), .. } => assert_eq!(
                    got, name,
                    "`{}` rendered `{}` and read back as a different sheet",
                    name, rendered
                ),
                other => panic!("`{}` produced `{}` -> {:?}", name, formula, other),
            }
        }
    }

    #[test]
    fn a_bare_identifier_sheet_name_is_left_unquoted() {
        // The widened rule must not start quoting everything. In particular it
        // must not capture the DEFAULT sheet names, or every saved formula in
        // every existing workbook would be rewritten for no reason.
        for name in ["Sheet1", "Sheet2", "Data", "_hidden", "Q1_2026", "a.b", "A1", "ZZ100"] {
            assert_eq!(quote_sheet_name(name), name);
            // Bare names are upper-cased by the lexer (this predates the
            // change and `normalize_cross_sheet_refs` is what canonicalises
            // them); what matters is that the sheet survives the trip.
            let parsed = parser::parse(&format!("={}!A1", name)).expect("parses");
            match parsed {
                Expression::CellRef { sheet: Some(got), .. } => {
                    assert_eq!(got.to_uppercase(), name.to_uppercase())
                }
                other => panic!("`{}` -> {:?}", name, other),
            }
        }
    }
}
