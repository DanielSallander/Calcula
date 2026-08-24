//! FILENAME: core/parser/src/tests.rs
//! PURPOSE: Consolidated unit tests for the parser crate.

use crate::ast::{BinaryOperator, BuiltinFunction, Expression, UnaryOperator, Value};
use crate::lexer::Lexer;
use crate::parser::parse;
use crate::token::Token;
use identity::RefSiteId;

// ========================================
// LEXER TESTS (Originally from lexer.rs)
// ========================================

#[test]
fn test_exclamation_token() {
    let mut lexer = Lexer::new("Sheet1!A1");
    assert_eq!(lexer.next_token(), Token::Identifier("SHEET1".to_string()));
    assert_eq!(lexer.next_token(), Token::Exclamation);
    assert_eq!(lexer.next_token(), Token::Identifier("A1".to_string()));
}

#[test]
fn test_quoted_identifier() {
    let mut lexer = Lexer::new("'My Sheet'!A1");
    assert_eq!(lexer.next_token(), Token::QuotedIdentifier("My Sheet".to_string()));
    assert_eq!(lexer.next_token(), Token::Exclamation);
    assert_eq!(lexer.next_token(), Token::Identifier("A1".to_string()));
}

#[test]
fn test_quoted_identifier_with_escaped_quote() {
    let mut lexer = Lexer::new("'John''s Sheet'!A1");
    assert_eq!(lexer.next_token(), Token::QuotedIdentifier("John's Sheet".to_string()));
    assert_eq!(lexer.next_token(), Token::Exclamation);
}

// ========================================
// LEXER TESTS (Originally from lib.rs)
// ========================================

#[test]
fn lexer_tokenizes_simple_math() {
    let input = "=1 + 2";
    let mut lexer = Lexer::new(input);

    assert_eq!(lexer.next_token(), Token::Equals);
    assert_eq!(lexer.next_token(), Token::Number(1.0));
    assert_eq!(lexer.next_token(), Token::Plus);
    assert_eq!(lexer.next_token(), Token::Number(2.0));
    assert_eq!(lexer.next_token(), Token::EOF);
}

#[test]
fn lexer_tokenizes_functions() {
    let input = "SUM(A1, 10)";
    let mut lexer = Lexer::new(input);

    assert_eq!(lexer.next_token(), Token::Identifier("SUM".to_string()));
    assert_eq!(lexer.next_token(), Token::LParen);
    assert_eq!(lexer.next_token(), Token::Identifier("A1".to_string()));
    assert_eq!(lexer.next_token(), Token::Comma);
    assert_eq!(lexer.next_token(), Token::Number(10.0));
    assert_eq!(lexer.next_token(), Token::RParen);
}

#[test]
fn lexer_handles_strings_and_bools() {
    let input = "\"Hello\" TRUE";
    let mut lexer = Lexer::new(input);

    assert_eq!(lexer.next_token(), Token::String("Hello".to_string()));
    assert_eq!(lexer.next_token(), Token::Boolean(true));
}

#[test]
fn lexer_tokenizes_comparison_operators() {
    let input = "< > <= >= <> =";
    let mut lexer = Lexer::new(input);

    assert_eq!(lexer.next_token(), Token::LessThan);
    assert_eq!(lexer.next_token(), Token::GreaterThan);
    assert_eq!(lexer.next_token(), Token::LessEqual);
    assert_eq!(lexer.next_token(), Token::GreaterEqual);
    assert_eq!(lexer.next_token(), Token::NotEqual);
    assert_eq!(lexer.next_token(), Token::Equals);
    assert_eq!(lexer.next_token(), Token::EOF);
}

#[test]
fn lexer_tokenizes_power_and_concat() {
    let input = "2 ^ 3 & \"test\"";
    let mut lexer = Lexer::new(input);

    assert_eq!(lexer.next_token(), Token::Number(2.0));
    assert_eq!(lexer.next_token(), Token::Caret);
    assert_eq!(lexer.next_token(), Token::Number(3.0));
    assert_eq!(lexer.next_token(), Token::Ampersand);
    assert_eq!(lexer.next_token(), Token::String("test".to_string()));
    assert_eq!(lexer.next_token(), Token::EOF);
}

// ========================================
// PARSER TESTS - LITERALS
// ========================================

#[test]
fn parser_parses_number_literal() {
    let result = parse("=42").unwrap();
    assert_eq!(result, Expression::Literal(Value::Number(42.0)));
}

#[test]
fn parser_parses_decimal_number() {
    let result = parse("=3.14159").unwrap();
    assert_eq!(result, Expression::Literal(Value::Number(3.14159)));
}

#[test]
fn parser_parses_string_literal() {
    let result = parse("=\"Hello World\"").unwrap();
    assert_eq!(
        result,
        Expression::Literal(Value::String("Hello World".to_string()))
    );
}

#[test]
fn parser_parses_boolean_true() {
    let result = parse("=TRUE").unwrap();
    assert_eq!(result, Expression::Literal(Value::Boolean(true)));
}

#[test]
fn parser_parses_boolean_false() {
    let result = parse("=FALSE").unwrap();
    assert_eq!(result, Expression::Literal(Value::Boolean(false)));
}

// ========================================
// PARSER TESTS - CELL REFERENCES
// ========================================

#[test]
fn parser_parses_simple_cell_ref() {
    let result = parse("=A1").unwrap();
    assert_eq!(
        result,
        Expression::CellRef {
            sheet: None,
            col: "A".to_string(),
            row: 1,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_multi_letter_column() {
    let result = parse("=AA100").unwrap();
    assert_eq!(
        result,
        Expression::CellRef {
            sheet: None,
            col: "AA".to_string(),
            row: 100,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_range() {
    let result = parse("=A1:B10").unwrap();
    assert_eq!(
        result,
        Expression::Range {
            sheet: None,
            start: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            }),
            end: Box::new(Expression::CellRef {
                sheet: None,
                col: "B".to_string(),
                row: 10,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            }),
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

// ========================================
// PARSER TESTS - BINARY OPERATIONS
// ========================================

#[test]
fn parser_parses_addition() {
    let result = parse("=1 + 2").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(1.0))),
            op: BinaryOperator::Add,
            right: Box::new(Expression::Literal(Value::Number(2.0)))
        }
    );
}

#[test]
fn parser_parses_subtraction() {
    let result = parse("=10 - 3").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(10.0))),
            op: BinaryOperator::Subtract,
            right: Box::new(Expression::Literal(Value::Number(3.0)))
        }
    );
}

#[test]
fn parser_parses_multiplication() {
    let result = parse("=4 * 5").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(4.0))),
            op: BinaryOperator::Multiply,
            right: Box::new(Expression::Literal(Value::Number(5.0)))
        }
    );
}

#[test]
fn parser_parses_division() {
    let result = parse("=20 / 4").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(20.0))),
            op: BinaryOperator::Divide,
            right: Box::new(Expression::Literal(Value::Number(4.0)))
        }
    );
}

#[test]
fn parser_parses_power() {
    let result = parse("=2 ^ 3").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(2.0))),
            op: BinaryOperator::Power,
            right: Box::new(Expression::Literal(Value::Number(3.0)))
        }
    );
}

#[test]
fn parser_parses_concatenation() {
    let result = parse("=\"Hello\" & \" World\"").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::String("Hello".to_string()))),
            op: BinaryOperator::Concat,
            right: Box::new(Expression::Literal(Value::String(" World".to_string())))
        }
    );
}

// ========================================
// PARSER TESTS - COMPARISON OPERATORS
// ========================================

#[test]
fn parser_parses_equal() {
    let result = parse("=A1 = 10").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            }),
            op: BinaryOperator::Equal,
            right: Box::new(Expression::Literal(Value::Number(10.0)))
        }
    );
}

#[test]
fn parser_parses_not_equal() {
    let result = parse("=A1 <> 10").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            }),
            op: BinaryOperator::NotEqual,
            right: Box::new(Expression::Literal(Value::Number(10.0)))
        }
    );
}

#[test]
fn parser_parses_less_than() {
    let result = parse("=A1 < 10").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            }),
            op: BinaryOperator::LessThan,
            right: Box::new(Expression::Literal(Value::Number(10.0)))
        }
    );
}

#[test]
fn parser_parses_greater_than() {
    let result = parse("=A1 > 10").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            }),
            op: BinaryOperator::GreaterThan,
            right: Box::new(Expression::Literal(Value::Number(10.0)))
        }
    );
}

#[test]
fn parser_parses_less_equal() {
    let result = parse("=A1 <= 10").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            }),
            op: BinaryOperator::LessEqual,
            right: Box::new(Expression::Literal(Value::Number(10.0)))
        }
    );
}

#[test]
fn parser_parses_greater_equal() {
    let result = parse("=A1 >= 10").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            }),
            op: BinaryOperator::GreaterEqual,
            right: Box::new(Expression::Literal(Value::Number(10.0)))
        }
    );
}

// ========================================
// PARSER TESTS - OPERATOR PRECEDENCE
// ========================================

#[test]
fn parser_respects_precedence_multiply_before_add() {
    // 1 + 2 * 3 should be parsed as 1 + (2 * 3)
    let result = parse("=1 + 2 * 3").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(1.0))),
            op: BinaryOperator::Add,
            right: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Literal(Value::Number(2.0))),
                op: BinaryOperator::Multiply,
                right: Box::new(Expression::Literal(Value::Number(3.0)))
            })
        }
    );
}

#[test]
fn parser_respects_precedence_divide_before_subtract() {
    // 10 - 6 / 2 should be parsed as 10 - (6 / 2)
    let result = parse("=10 - 6 / 2").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(10.0))),
            op: BinaryOperator::Subtract,
            right: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Literal(Value::Number(6.0))),
                op: BinaryOperator::Divide,
                right: Box::new(Expression::Literal(Value::Number(2.0)))
            })
        }
    );
}

#[test]
fn parser_respects_precedence_power_before_multiply() {
    // 2 * 3 ^ 2 should be parsed as 2 * (3 ^ 2)
    let result = parse("=2 * 3 ^ 2").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(2.0))),
            op: BinaryOperator::Multiply,
            right: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Literal(Value::Number(3.0))),
                op: BinaryOperator::Power,
                right: Box::new(Expression::Literal(Value::Number(2.0)))
            })
        }
    );
}

#[test]
fn parser_power_is_left_associative_like_every_other_excel_operator() {
    // ASSERTED THE OPPOSITE UNTIL 2026-08-23, and the opposite was wrong.
    // Right-associativity is the MATHEMATICAL convention, but Excel folds
    // equal-priority operators left to right with no exception for `^`:
    // `=2^3^2` is `(2^3)^2` = 64, not `2^(3^2)` = 512.
    let result = parse("=2 ^ 3 ^ 2").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Literal(Value::Number(2.0))),
                op: BinaryOperator::Power,
                right: Box::new(Expression::Literal(Value::Number(3.0)))
            }),
            op: BinaryOperator::Power,
            right: Box::new(Expression::Literal(Value::Number(2.0)))
        }
    );
}

#[test]
fn parser_respects_precedence_add_before_comparison() {
    // A1 + 1 > 10 should be parsed as (A1 + 1) > 10
    let result = parse("=A1 + 1 > 10").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                    col_absolute: false,
                    row_absolute: false,
                    ref_site_id: RefSiteId::ZERO,
                }),
                op: BinaryOperator::Add,
                right: Box::new(Expression::Literal(Value::Number(1.0)))
            }),
            op: BinaryOperator::GreaterThan,
            right: Box::new(Expression::Literal(Value::Number(10.0)))
        }
    );
}

#[test]
fn parser_respects_precedence_add_before_concat() {
    // 1 + 2 & 3 + 4 should be parsed as (1 + 2) & (3 + 4)
    let result = parse("=1 + 2 & 3 + 4").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Literal(Value::Number(1.0))),
                op: BinaryOperator::Add,
                right: Box::new(Expression::Literal(Value::Number(2.0)))
            }),
            op: BinaryOperator::Concat,
            right: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Literal(Value::Number(3.0))),
                op: BinaryOperator::Add,
                right: Box::new(Expression::Literal(Value::Number(4.0)))
            })
        }
    );
}

#[test]
fn parser_handles_parentheses_override() {
    // (1 + 2) * 3 should group addition first
    let result = parse("=(1 + 2) * 3").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Literal(Value::Number(1.0))),
                op: BinaryOperator::Add,
                right: Box::new(Expression::Literal(Value::Number(2.0)))
            }),
            op: BinaryOperator::Multiply,
            right: Box::new(Expression::Literal(Value::Number(3.0)))
        }
    );
}

#[test]
fn parser_handles_left_associativity() {
    // 1 - 2 - 3 should be parsed as (1 - 2) - 3
    let result = parse("=1 - 2 - 3").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Literal(Value::Number(1.0))),
                op: BinaryOperator::Subtract,
                right: Box::new(Expression::Literal(Value::Number(2.0)))
            }),
            op: BinaryOperator::Subtract,
            right: Box::new(Expression::Literal(Value::Number(3.0)))
        }
    );
}

// ========================================
// PARSER TESTS - UNARY OPERATIONS
// ========================================

#[test]
fn parser_parses_negation() {
    let result = parse("=-5").unwrap();
    assert_eq!(
        result,
        Expression::UnaryOp {
            op: UnaryOperator::Negate,
            operand: Box::new(Expression::Literal(Value::Number(5.0)))
        }
    );
}

#[test]
fn parser_parses_double_negation() {
    let result = parse("=--5").unwrap();
    assert_eq!(
        result,
        Expression::UnaryOp {
            op: UnaryOperator::Negate,
            operand: Box::new(Expression::UnaryOp {
                op: UnaryOperator::Negate,
                operand: Box::new(Expression::Literal(Value::Number(5.0)))
            })
        }
    );
}

#[test]
fn parser_parses_negation_in_expression() {
    // 10 + -5 should work
    let result = parse("=10 + -5").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(10.0))),
            op: BinaryOperator::Add,
            right: Box::new(Expression::UnaryOp {
                op: UnaryOperator::Negate,
                operand: Box::new(Expression::Literal(Value::Number(5.0)))
            })
        }
    );
}

#[test]
fn parser_parses_negation_as_binding_tighter_than_power() {
    // ASSERTED `-(2^2)` = -4 UNTIL 2026-08-23. Excel answers 4: negation binds
    // TIGHTER than `^`, so the -2 is raised. (The old comment said "unary binds
    // tighter than power" while the code did the reverse — the comment was
    // right about Excel and the tree was not.)
    let result = parse("=-2 ^ 2").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::UnaryOp {
                op: UnaryOperator::Negate,
                operand: Box::new(Expression::Literal(Value::Number(2.0)))
            }),
            op: BinaryOperator::Power,
            right: Box::new(Expression::Literal(Value::Number(2.0)))
        }
    );
}

// ========================================
// PARSER TESTS - FUNCTION CALLS
// ========================================

#[test]
fn parser_parses_function_no_args() {
    let result = parse("=NOW()").unwrap();
    assert_eq!(
        result,
        Expression::FunctionCall {
            func: BuiltinFunction::Now,
            args: vec![],
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_function_single_arg() {
    let result = parse("=ABS(-5)").unwrap();
    assert_eq!(
        result,
        Expression::FunctionCall {
            func: BuiltinFunction::Abs,
            args: vec![Expression::UnaryOp {
                op: UnaryOperator::Negate,
                operand: Box::new(Expression::Literal(Value::Number(5.0)))
            }],
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_function_multiple_args() {
    let result = parse("=SUM(1, 2, 3)").unwrap();
    assert_eq!(
        result,
        Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![
                Expression::Literal(Value::Number(1.0)),
                Expression::Literal(Value::Number(2.0)),
                Expression::Literal(Value::Number(3.0))
            ],
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_function_with_range_arg() {
    let result = parse("=SUM(A1:A10)").unwrap();
    assert_eq!(
        result,
        Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                    col_absolute: false,
                    row_absolute: false,
                    ref_site_id: RefSiteId::ZERO,
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 10,
                    col_absolute: false,
                    row_absolute: false,
                    ref_site_id: RefSiteId::ZERO,
                }),
                ref_site_id: RefSiteId::ZERO,
            }],
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_nested_function_calls() {
    let result = parse("=SUM(ABS(-1), ABS(-2))").unwrap();
    assert_eq!(
        result,
        Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![
                Expression::FunctionCall {
                    func: BuiltinFunction::Abs,
                    args: vec![Expression::UnaryOp {
                        op: UnaryOperator::Negate,
                        operand: Box::new(Expression::Literal(Value::Number(1.0)))
                    }],
                    ref_site_id: RefSiteId::ZERO,
                },
                Expression::FunctionCall {
                    func: BuiltinFunction::Abs,
                    args: vec![Expression::UnaryOp {
                        op: UnaryOperator::Negate,
                        operand: Box::new(Expression::Literal(Value::Number(2.0)))
                    }],
                    ref_site_id: RefSiteId::ZERO,
                }
            ],
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_function_with_expression_arg() {
    let result = parse("=SUM(1 + 2, 3 * 4)").unwrap();
    assert_eq!(
        result,
        Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![
                Expression::BinaryOp {
                    left: Box::new(Expression::Literal(Value::Number(1.0))),
                    op: BinaryOperator::Add,
                    right: Box::new(Expression::Literal(Value::Number(2.0)))
                },
                Expression::BinaryOp {
                    left: Box::new(Expression::Literal(Value::Number(3.0))),
                    op: BinaryOperator::Multiply,
                    right: Box::new(Expression::Literal(Value::Number(4.0)))
                }
            ],
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_if_function_with_comparison() {
    // IF(A1 > 10, "big", "small")
    let result = parse("=IF(A1 > 10, \"big\", \"small\")").unwrap();
    assert_eq!(
        result,
        Expression::FunctionCall {
            func: BuiltinFunction::If,
            args: vec![
                Expression::BinaryOp {
                    left: Box::new(Expression::CellRef {
                        sheet: None,
                        col: "A".to_string(),
                        row: 1,
                        col_absolute: false,
                        row_absolute: false,
                        ref_site_id: RefSiteId::ZERO,
                    }),
                    op: BinaryOperator::GreaterThan,
                    right: Box::new(Expression::Literal(Value::Number(10.0)))
                },
                Expression::Literal(Value::String("big".to_string())),
                Expression::Literal(Value::String("small".to_string()))
            ],
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

// ========================================
// PARSER TESTS - COMPLEX EXPRESSIONS
// ========================================

#[test]
fn parser_parses_cell_ref_in_expression() {
    let result = parse("=A1 + B2").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::CellRef {
                sheet: None,
                col: "B".to_string(),
                row: 2,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            })
        }
    );
}

#[test]
fn parser_parses_complex_formula() {
    // A realistic formula: =SUM(A1:A10) * 2 + B1
    let result = parse("=SUM(A1:A10) * 2 + B1").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::FunctionCall {
                    func: BuiltinFunction::Sum,
                    args: vec![Expression::Range {
                        sheet: None,
                        start: Box::new(Expression::CellRef {
                            sheet: None,
                            col: "A".to_string(),
                            row: 1,
                            col_absolute: false,
                            row_absolute: false,
                            ref_site_id: RefSiteId::ZERO,
                        }),
                        end: Box::new(Expression::CellRef {
                            sheet: None,
                            col: "A".to_string(),
                            row: 10,
                            col_absolute: false,
                            row_absolute: false,
                            ref_site_id: RefSiteId::ZERO,
                        }),
                        ref_site_id: RefSiteId::ZERO,
                    }],
                    ref_site_id: RefSiteId::ZERO,
                }),
                op: BinaryOperator::Multiply,
                right: Box::new(Expression::Literal(Value::Number(2.0)))
            }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::CellRef {
                sheet: None,
                col: "B".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            })
        }
    );
}

#[test]
fn parser_parses_complex_formula_with_all_operators() {
    // =A1 ^ 2 * 3 + 4 & " items" > "10 items"
    // Should parse as: (((A1 ^ 2) * 3) + 4) & " items") > "10 items"
    let result = parse("=A1 ^ 2 * 3 + 4 & \" items\" = \"10 items\"").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::BinaryOp {
                    left: Box::new(Expression::BinaryOp {
                        left: Box::new(Expression::BinaryOp {
                            left: Box::new(Expression::CellRef {
                                sheet: None,
                                col: "A".to_string(),
                                row: 1,
                                col_absolute: false,
                                row_absolute: false,
                                ref_site_id: RefSiteId::ZERO,
                            }),
                            op: BinaryOperator::Power,
                            right: Box::new(Expression::Literal(Value::Number(2.0)))
                        }),
                        op: BinaryOperator::Multiply,
                        right: Box::new(Expression::Literal(Value::Number(3.0)))
                    }),
                    op: BinaryOperator::Add,
                    right: Box::new(Expression::Literal(Value::Number(4.0)))
                }),
                op: BinaryOperator::Concat,
                right: Box::new(Expression::Literal(Value::String(" items".to_string())))
            }),
            op: BinaryOperator::Equal,
            right: Box::new(Expression::Literal(Value::String("10 items".to_string())))
        }
    );
}

// ========================================
// PARSER TESTS - ERROR CASES
// ========================================

#[test]
fn parser_error_on_empty_expression() {
    let result = parse("=");
    assert!(result.is_err());
    assert!(result.unwrap_err().message.contains("Empty expression"));
}

#[test]
fn parser_error_on_unclosed_paren() {
    let result = parse("=(1 + 2");
    assert!(result.is_err());
}

#[test]
fn parser_error_on_unclosed_function() {
    let result = parse("=SUM(1, 2");
    assert!(result.is_err());
}

#[test]
fn parser_column_only_identifier_is_named_ref() {
    // "ABC" without a row number is now parsed as a named reference
    let result = parse("=ABC").unwrap();
    assert_eq!(result, Expression::NamedRef { name: "ABC".to_string(), ref_site_id: RefSiteId::ZERO });
}

#[test]
fn parser_error_on_trailing_operator() {
    let result = parse("=1 +");
    assert!(result.is_err());
}

#[test]
fn a_second_plus_is_a_unary_plus_not_an_error() {
    // This asserted `is_err()` while `+` had no prefix form. Excel accepts
    // `=1 + + 2` and answers 3: the second `+` is the Lotus-compatibility unary
    // plus applied to 2. Refusing it was the defect, not the tolerance.
    assert_eq!(
        parse("=1 + + 2").unwrap(),
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(1.0))),
            op: BinaryOperator::Add,
            right: Box::new(Expression::UnaryOp {
                op: UnaryOperator::Plus,
                operand: Box::new(Expression::Literal(Value::Number(2.0)))
            })
        }
    );

    // A doubled operator with no operand after it is still an error.
    assert!(parse("=1 * * 2").is_err());
    assert!(parse("=1 +").is_err());
}

#[test]
fn a_leading_plus_starts_a_formula_the_way_excel_allows() {
    // `=+A1` is everywhere in real workbooks — typing `+` to begin a formula is
    // a habit Excel inherited from Lotus 1-2-3 — and it used to be a hard parse
    // error, so an imported .xlsx using it opened as #VALUE!.
    assert_eq!(
        parse("=+A1").unwrap(),
        Expression::UnaryOp {
            op: UnaryOperator::Plus,
            operand: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: Default::default(),
            })
        }
    );
    assert!(parse("=+SUM(A1:A3)").is_ok());
    assert!(parse("=-+-5").is_ok());
}

#[test]
fn an_error_literal_parses_wherever_a_value_is_accepted() {
    // `=#REF!` was a hard parse error, and that mattered well beyond typing one:
    // the copy/fill/structural shifters need to WRITE `#REF!` in place of a
    // reference that left the sheet. They clamped instead — silently re-pointing
    // the formula at surviving data — and text no parser accepts would have been
    // WORSE than the clamp, because an unparseable formula is stored anyway and
    // shows #VALUE! on a cell carrying no dependency edges at all.
    assert_eq!(
        parse("=#REF!").unwrap(),
        Expression::Literal(Value::Error("#REF!".to_string()))
    );
    // Every one of Excel's, plus Calcula's own four, since a cell can hold one.
    for lit in [
        "#DIV/0!", "#REF!", "#NAME?", "#VALUE!", "#N/A", "#NULL!", "#NUM!", "#SPILL!",
        "#CIRCULAR!", "#CONFLICT!", "#BLOCKED!", "#LIMIT!",
    ] {
        assert_eq!(
            parse(&format!("={}", lit)).unwrap(),
            Expression::Literal(Value::Error(lit.to_string())),
            "`{}` must parse as itself",
            lit
        );
    }
    // In an operand position, in an argument, and inside an array constant.
    assert!(parse("=#REF!+1").is_ok());
    assert!(parse("=IF(A1,#N/A,0)").is_ok());
    assert!(parse("=ISNA(#N/A)").is_ok());
    assert_eq!(
        parse("={1,#N/A}").unwrap(),
        Expression::ArrayLiteral {
            rows: vec![vec![
                Expression::Literal(Value::Number(1.0)),
                Expression::Literal(Value::Error("#N/A".to_string())),
            ]]
        }
    );
    // Case-insensitive on the way in, CANONICAL on the way out, so nothing
    // downstream has to normalise a user's spelling.
    assert_eq!(
        parse("=#n/a").unwrap(),
        Expression::Literal(Value::Error("#N/A".to_string()))
    );
}

#[test]
fn the_spill_operator_still_reads_as_itself() {
    // `#` is BOTH the postfix spill operator and the first character of every
    // error literal, and the lookahead that tells them apart must not eat `A1#`.
    assert!(matches!(
        parse("=A1#").unwrap(),
        Expression::SpillRef { .. }
    ));
    assert!(parse("=SUM(A1#)").is_ok());
    // A `#` followed by something that is NOT an error name stays the operator,
    // so a half-typed literal fails as a parse error rather than lexing wrong.
    assert!(parse("=#NOTANERROR").is_err());
}

#[test]
fn percent_is_a_postfix_operator_on_any_expression() {
    // Not number-literal syntax: Excel applies `%` to whatever precedes it, so
    // `=A1%` and `=(1+1)%` are both legal.
    assert_eq!(
        parse("=50%").unwrap(),
        Expression::UnaryOp {
            op: UnaryOperator::Percent,
            operand: Box::new(Expression::Literal(Value::Number(50.0)))
        }
    );
    assert!(parse("=A1%").is_ok());
    assert!(parse("=(1+1)%").is_ok());
    assert!(parse("=SUM(A1:A9)%").is_ok());

    // Binds tighter than `*`, so `=A1*20%` multiplies by 0.2 rather than
    // taking a percent of the product.
    assert_eq!(
        parse("=A1*20%").unwrap(),
        Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: Default::default(),
            }),
            op: BinaryOperator::Multiply,
            right: Box::new(Expression::UnaryOp {
                op: UnaryOperator::Percent,
                operand: Box::new(Expression::Literal(Value::Number(20.0)))
            })
        }
    );
}

#[test]
fn an_array_constant_separates_columns_with_a_comma_and_rows_with_a_semicolon() {
    // `,` is the COLUMN break and `;` the ROW break, in the invariant spelling
    // the parser always sees. `={1,2,3}` is one row of three; `={1;2;3}` is
    // three rows of one. Getting these the wrong way round transposes every
    // array constant in the workbook.
    assert_eq!(
        parse("={1,2,3}").unwrap(),
        Expression::ArrayLiteral {
            rows: vec![vec![
                Expression::Literal(Value::Number(1.0)),
                Expression::Literal(Value::Number(2.0)),
                Expression::Literal(Value::Number(3.0)),
            ]]
        }
    );
    assert_eq!(
        parse("={1;2;3}").unwrap(),
        Expression::ArrayLiteral {
            rows: vec![
                vec![Expression::Literal(Value::Number(1.0))],
                vec![Expression::Literal(Value::Number(2.0))],
                vec![Expression::Literal(Value::Number(3.0))],
            ]
        }
    );
    assert_eq!(
        parse("={1,2;3,4}").unwrap(),
        Expression::ArrayLiteral {
            rows: vec![
                vec![
                    Expression::Literal(Value::Number(1.0)),
                    Expression::Literal(Value::Number(2.0)),
                ],
                vec![
                    Expression::Literal(Value::Number(3.0)),
                    Expression::Literal(Value::Number(4.0)),
                ],
            ]
        }
    );

    // Text, booleans and mixed types are all legal members.
    assert!(parse("={\"a\",\"b\";TRUE,FALSE}").is_ok());

    // A RAGGED constant is refused at entry, as Excel refuses it — a ragged
    // array has no honest shape for anything downstream to spill.
    assert!(parse("={1,2;3}").is_err());

    // A colon after the first element still means DICT, so Calcula's own
    // key-value literal is untouched by the brace reclamation.
    assert!(matches!(
        parse("={\"a\": 1, \"b\": 2}").unwrap(),
        Expression::DictLiteral { .. }
    ));

    // A semicolon OUTSIDE braces is still an error — it is a locale-separator
    // mistake, and accepting it would silently change what a formula means.
    assert!(parse("=SUM(A1;A2)").is_err());
}

// ========================================
// PARSER TESTS - WITHOUT EQUALS SIGN
// ========================================

#[test]
fn parser_works_without_leading_equals() {
    let result = parse("1 + 2").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(1.0))),
            op: BinaryOperator::Add,
            right: Box::new(Expression::Literal(Value::Number(2.0)))
        }
    );
}

// ========================================
// PARSER TESTS (Originally from parser.rs)
// ========================================

#[test]
fn test_parse_column_reference() {
    let result = parse("=A:A").unwrap();
    assert_eq!(
        result,
        Expression::ColumnRef {
            sheet: None,
            start_col: "A".to_string(),
            end_col: "A".to_string(),
            start_absolute: false,
            end_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn test_parse_column_range() {
    let result = parse("=A:C").unwrap();
    assert_eq!(
        result,
        Expression::ColumnRef {
            sheet: None,
            start_col: "A".to_string(),
            end_col: "C".to_string(),
            start_absolute: false,
            end_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn test_parse_row_reference() {
    let result = parse("=1:1").unwrap();
    assert_eq!(
        result,
        Expression::RowRef {
            sheet: None,
            start_row: 1,
            end_row: 1,
            start_absolute: false,
            end_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn test_parse_row_range() {
    let result = parse("=1:5").unwrap();
    assert_eq!(
        result,
        Expression::RowRef {
            sheet: None,
            start_row: 1,
            end_row: 5,
            start_absolute: false,
            end_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn test_parse_sheet_cell_ref() {
    let result = parse("=Sheet1!A1").unwrap();
    assert_eq!(
        result,
        Expression::CellRef {
            sheet: Some("SHEET1".to_string()),
            col: "A".to_string(),
            row: 1,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn test_parse_quoted_sheet_cell_ref() {
    let result = parse("='My Sheet'!A1").unwrap();
    assert_eq!(
        result,
        Expression::CellRef {
            sheet: Some("My Sheet".to_string()),
            col: "A".to_string(),
            row: 1,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn test_parse_sheet_range() {
    let result = parse("=Sheet1!A1:B10").unwrap();
    match result {
        Expression::Range { sheet, start, end, .. } => {
            assert_eq!(sheet, Some("SHEET1".to_string()));
            assert_eq!(
                *start,
                Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                    col_absolute: false,
                    row_absolute: false,
                    ref_site_id: RefSiteId::ZERO,
                }
            );
            assert_eq!(
                *end,
                Expression::CellRef {
                    sheet: None,
                    col: "B".to_string(),
                    row: 10,
                    col_absolute: false,
                    row_absolute: false,
                    ref_site_id: RefSiteId::ZERO,
                }
            );
        }
        _ => panic!("Expected Range"),
    }
}

#[test]
fn test_parse_sheet_column_ref() {
    let result = parse("=Sheet1!A:B").unwrap();
    assert_eq!(
        result,
        Expression::ColumnRef {
            sheet: Some("SHEET1".to_string()),
            start_col: "A".to_string(),
            end_col: "B".to_string(),
            start_absolute: false,
            end_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn test_parse_sheet_row_ref() {
    let result = parse("=Sheet1!1:5").unwrap();
    assert_eq!(
        result,
        Expression::RowRef {
            sheet: Some("SHEET1".to_string()),
            start_row: 1,
            end_row: 5,
            start_absolute: false,
            end_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn test_parse_sum_with_sheet_ref() {
    let result = parse("=SUM(Sheet1!A1:A10)").unwrap();
    match result {
        Expression::FunctionCall { func, args, .. } => {
            assert_eq!(func, BuiltinFunction::Sum);
            assert_eq!(args.len(), 1);
            match &args[0] {
                Expression::Range { sheet, .. } => {
                    assert_eq!(*sheet, Some("SHEET1".to_string()));
                }
                _ => panic!("Expected Range"),
            }
        }
        _ => panic!("Expected FunctionCall"),
    }
}

#[test]
fn test_parse_sum_with_column_ref() {
    let result = parse("=SUM(A:A)").unwrap();
    match result {
        Expression::FunctionCall { func, args, .. } => {
            assert_eq!(func, BuiltinFunction::Sum);
            assert_eq!(args.len(), 1);
            assert_eq!(
                args[0],
                Expression::ColumnRef {
                    sheet: None,
                    start_col: "A".to_string(),
                    end_col: "A".to_string(),
                    start_absolute: false,
                    end_absolute: false,
                    ref_site_id: RefSiteId::ZERO,
                }
            );
        }
        _ => panic!("Expected FunctionCall"),
    }
}

#[test]
fn test_parse_sum_with_row_ref() {
    let result = parse("=SUM(1:3)").unwrap();
    match result {
        Expression::FunctionCall { func, args, .. } => {
            assert_eq!(func, BuiltinFunction::Sum);
            assert_eq!(args.len(), 1);
            assert_eq!(
                args[0],
                Expression::RowRef {
                    sheet: None,
                    start_row: 1,
                    end_row: 3,
                    start_absolute: false,
                    end_absolute: false,
                    ref_site_id: RefSiteId::ZERO,
                }
            );
        }
        _ => panic!("Expected FunctionCall"),
    }
}

// ========================================
// PARSER TESTS - NAMED REFERENCES
// ========================================

#[test]
fn parser_parses_underscore_name_as_named_ref() {
    // Names with underscores are always named references
    let result = parse("=Tax_Rate").unwrap();
    assert_eq!(
        result,
        Expression::NamedRef { name: "TAX_RATE".to_string(), ref_site_id: RefSiteId::ZERO }
    );
}

#[test]
fn parser_parses_named_ref_in_expression() {
    // Revenue - Costs should parse as BinaryOp with two NamedRefs
    let result = parse("=Revenue - Costs").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::NamedRef { name: "REVENUE".to_string(), ref_site_id: RefSiteId::ZERO }),
            op: BinaryOperator::Subtract,
            right: Box::new(Expression::NamedRef { name: "COSTS".to_string(), ref_site_id: RefSiteId::ZERO }),
        }
    );
}

#[test]
fn parser_parses_named_ref_in_function() {
    // SUM(SalesData) should parse with NamedRef as function argument
    let result = parse("=SUM(SalesData)").unwrap();
    assert_eq!(
        result,
        Expression::FunctionCall {
            func: BuiltinFunction::Sum,
            args: vec![Expression::NamedRef { name: "SALESDATA".to_string(), ref_site_id: RefSiteId::ZERO }],
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_dotted_name_as_named_ref() {
    // Names with dots like Q1.Sales are named references
    let result = parse("=Q1.Sales").unwrap();
    assert_eq!(
        result,
        Expression::NamedRef { name: "Q1.SALES".to_string(), ref_site_id: RefSiteId::ZERO }
    );
}

#[test]
fn parser_parses_backslash_name_as_named_ref() {
    // Names starting with \ are named references
    let result = parse("=\\TaxRate").unwrap();
    assert_eq!(
        result,
        Expression::NamedRef { name: "\\TAXRATE".to_string(), ref_site_id: RefSiteId::ZERO }
    );
}

#[test]
fn parser_parses_a1_as_cell_ref_not_named_ref() {
    // A1 is a valid cell reference, not a named reference
    let result = parse("=A1").unwrap();
    assert_eq!(
        result,
        Expression::CellRef {
            sheet: None,
            col: "A".to_string(),
            row: 1,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_xfd1_as_cell_ref() {
    // XFD is column 16384 (max), so XFD1 is a valid cell reference
    let result = parse("=XFD1").unwrap();
    assert_eq!(
        result,
        Expression::CellRef {
            sheet: None,
            col: "XFD".to_string(),
            row: 1,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_parses_xfe1_as_named_ref() {
    // XFE is column 16385 (beyond max), so XFE1 is a named reference
    let result = parse("=XFE1").unwrap();
    assert_eq!(
        result,
        Expression::NamedRef { name: "XFE1".to_string(), ref_site_id: RefSiteId::ZERO }
    );
}

#[test]
fn parser_parses_pure_letters_as_named_ref() {
    // Pure letters without row digits (and not followed by : or $) are named refs
    let result = parse("=REVENUE").unwrap();
    assert_eq!(
        result,
        Expression::NamedRef { name: "REVENUE".to_string(), ref_site_id: RefSiteId::ZERO }
    );
}

#[test]
fn parser_parses_single_letter_not_followed_by_colon_as_named_ref() {
    // Single letter "A" without : or $ is a named ref (no row to form a cell ref)
    let result = parse("=A + 1").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::NamedRef { name: "A".to_string(), ref_site_id: RefSiteId::ZERO }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::Literal(Value::Number(1.0))),
        }
    );
}

#[test]
fn parser_parses_column_ref_still_works() {
    // A:B should still parse as a column reference, not named refs
    let result = parse("=A:B").unwrap();
    assert_eq!(
        result,
        Expression::ColumnRef {
            sheet: None,
            start_col: "A".to_string(),
            end_col: "B".to_string(),
            start_absolute: false,
            end_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

#[test]
fn parser_named_ref_with_cell_and_named_ref_mixed() {
    // A1 * TaxRate mixes a cell ref with a named ref
    let result = parse("=A1 * TaxRate").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            }),
            op: BinaryOperator::Multiply,
            right: Box::new(Expression::NamedRef { name: "TAXRATE".to_string(), ref_site_id: RefSiteId::ZERO }),
        }
    );
}

#[test]
fn parser_parses_row_beyond_limit_as_named_ref() {
    // Row 1048577 is beyond Excel's max row, but column "A" is valid.
    // The identifier "A1048577" has col="A" (col 1, valid) and row=1048577 (> 1048576).
    // is_valid_cell_ref_identifier returns false -> NamedRef.
    let result = parse("=A1048577").unwrap();
    assert_eq!(
        result,
        Expression::NamedRef { name: "A1048577".to_string(), ref_site_id: RefSiteId::ZERO }
    );
}

#[test]
fn parser_parses_max_row_as_cell_ref() {
    // Row 1048576 is Excel's max row, should still be a valid cell ref
    let result = parse("=A1048576").unwrap();
    assert_eq!(
        result,
        Expression::CellRef {
            sheet: None,
            col: "A".to_string(),
            row: 1048576,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        }
    );
}

// ========================================
// PARSER TESTS - 3D REFERENCES
// ========================================

#[test]
fn test_parse_3d_ref_cell() {
    // =Sheet1:Sheet3!A1
    let result = parse("=Sheet1:Sheet3!A1").unwrap();
    match result {
        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            assert_eq!(start_sheet, "SHEET1");
            assert_eq!(end_sheet, "SHEET3");
            assert_eq!(*reference, Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            });
        }
        _ => panic!("Expected Sheet3DRef, got {:?}", result),
    }
}

#[test]
fn test_parse_3d_ref_range() {
    // =Sheet1:Sheet3!A1:B10
    let result = parse("=Sheet1:Sheet3!A1:B10").unwrap();
    match result {
        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            assert_eq!(start_sheet, "SHEET1");
            assert_eq!(end_sheet, "SHEET3");
            match *reference {
                Expression::Range { sheet, .. } => {
                    assert_eq!(sheet, None);
                }
                _ => panic!("Expected Range inner reference"),
            }
        }
        _ => panic!("Expected Sheet3DRef, got {:?}", result),
    }
}

#[test]
fn test_parse_3d_ref_quoted() {
    // ='Jan 2023:Dec 2023'!A1
    let result = parse("='Jan 2023:Dec 2023'!A1").unwrap();
    match result {
        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            assert_eq!(start_sheet, "Jan 2023");
            assert_eq!(end_sheet, "Dec 2023");
            assert_eq!(*reference, Expression::CellRef {
                sheet: None,
                col: "A".to_string(),
                row: 1,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            });
        }
        _ => panic!("Expected Sheet3DRef, got {:?}", result),
    }
}

#[test]
fn test_parse_3d_ref_quoted_simple() {
    // ='Jan:Dec'!B4
    let result = parse("='Jan:Dec'!B4").unwrap();
    match result {
        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            assert_eq!(start_sheet, "Jan");
            assert_eq!(end_sheet, "Dec");
            assert_eq!(*reference, Expression::CellRef {
                sheet: None,
                col: "B".to_string(),
                row: 4,
                col_absolute: false,
                row_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            });
        }
        _ => panic!("Expected Sheet3DRef, got {:?}", result),
    }
}

#[test]
fn test_parse_3d_ref_in_function() {
    // =SUM(Sheet1:Sheet3!A1:A10)
    let result = parse("=SUM(Sheet1:Sheet3!A1:A10)").unwrap();
    match result {
        Expression::FunctionCall { func, args, .. } => {
            assert_eq!(func, BuiltinFunction::Sum);
            assert_eq!(args.len(), 1);
            match &args[0] {
                Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
                    assert_eq!(start_sheet, "SHEET1");
                    assert_eq!(end_sheet, "SHEET3");
                    assert!(matches!(**reference, Expression::Range { .. }));
                }
                _ => panic!("Expected Sheet3DRef as function argument"),
            }
        }
        _ => panic!("Expected FunctionCall, got {:?}", result),
    }
}

#[test]
fn test_parse_3d_ref_column_ref() {
    // =Sheet1:Sheet3!A:B should parse as 3D with ColumnRef inner
    let result = parse("=Sheet1:Sheet3!A:B").unwrap();
    match result {
        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            assert_eq!(start_sheet, "SHEET1");
            assert_eq!(end_sheet, "SHEET3");
            assert_eq!(*reference, Expression::ColumnRef {
                sheet: None,
                start_col: "A".to_string(),
                end_col: "B".to_string(),
                start_absolute: false,
                end_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            });
        }
        _ => panic!("Expected Sheet3DRef, got {:?}", result),
    }
}

#[test]
fn test_parse_3d_ref_row_ref() {
    // =Sheet1:Sheet3!1:5 should parse as 3D with RowRef inner
    let result = parse("=Sheet1:Sheet3!1:5").unwrap();
    match result {
        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            assert_eq!(start_sheet, "SHEET1");
            assert_eq!(end_sheet, "SHEET3");
            assert_eq!(*reference, Expression::RowRef {
                sheet: None,
                start_row: 1,
                end_row: 5,
                start_absolute: false,
                end_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            });
        }
        _ => panic!("Expected Sheet3DRef, got {:?}", result),
    }
}

#[test]
fn test_parse_3d_ref_absolute() {
    // =Sheet1:Sheet3!$A$1:$B$10
    let result = parse("=Sheet1:Sheet3!$A$1:$B$10").unwrap();
    match result {
        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            assert_eq!(start_sheet, "SHEET1");
            assert_eq!(end_sheet, "SHEET3");
            match *reference {
                Expression::Range { sheet, ref start, ref end, .. } => {
                    assert_eq!(sheet, None);
                    match start.as_ref() {
                        Expression::CellRef { col_absolute, row_absolute, .. } => {
                            assert!(*col_absolute);
                            assert!(*row_absolute);
                        }
                        _ => panic!("Expected CellRef start"),
                    }
                    match end.as_ref() {
                        Expression::CellRef { col_absolute, row_absolute, .. } => {
                            assert!(*col_absolute);
                            assert!(*row_absolute);
                        }
                        _ => panic!("Expected CellRef end"),
                    }
                }
                _ => panic!("Expected Range inner reference"),
            }
        }
        _ => panic!("Expected Sheet3DRef, got {:?}", result),
    }
}

#[test]
fn test_parse_column_ref_not_confused_with_3d_ref() {
    // =A:B should still parse as ColumnRef, not Sheet3DRef
    let result = parse("=A:B").unwrap();
    assert!(matches!(result, Expression::ColumnRef { .. }));
}

#[test]
fn test_parse_3d_ref_sum_quoted_range() {
    // =SUM('Jan:Dec'!B4) - quoted 3D in function
    let result = parse("=SUM('Jan:Dec'!B4)").unwrap();
    match result {
        Expression::FunctionCall { func, args, .. } => {
            assert_eq!(func, BuiltinFunction::Sum);
            assert_eq!(args.len(), 1);
            match &args[0] {
                Expression::Sheet3DRef { start_sheet, end_sheet, .. } => {
                    assert_eq!(start_sheet, "Jan");
                    assert_eq!(end_sheet, "Dec");
                }
                _ => panic!("Expected Sheet3DRef"),
            }
        }
        _ => panic!("Expected FunctionCall"),
    }
}

#[test]
fn test_parse_3d_ref_with_range_and_spaces() {
    // ='Q1 Sales:Q4 Sales'!A1:A10
    let result = parse("='Q1 Sales:Q4 Sales'!A1:A10").unwrap();
    match result {
        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            assert_eq!(start_sheet, "Q1 Sales");
            assert_eq!(end_sheet, "Q4 Sales");
            assert!(matches!(*reference, Expression::Range { .. }));
        }
        _ => panic!("Expected Sheet3DRef, got {:?}", result),
    }
}
// ========================================
// GET.CONTROLVALUE NAME MAPPING TESTS
// ========================================

#[test]
fn test_get_controlvalue_from_name_all_spellings() {
    // All three accepted spellings must resolve to the same variant.
    assert_eq!(
        BuiltinFunction::from_name("GET.CONTROLVALUE"),
        BuiltinFunction::GetControlValue
    );
    assert_eq!(
        BuiltinFunction::from_name("GET.CONTROL.VALUE"),
        BuiltinFunction::GetControlValue
    );
    assert_eq!(
        BuiltinFunction::from_name("GETCONTROLVALUE"),
        BuiltinFunction::GetControlValue
    );
    // Case-insensitive (from_name uppercases).
    assert_eq!(
        BuiltinFunction::from_name("get.controlvalue"),
        BuiltinFunction::GetControlValue
    );
}

#[test]
fn test_get_controlvalue_to_canonical_name_round_trip() {
    // to_canonical_name is the inverse of from_name for the primary spelling.
    assert_eq!(
        BuiltinFunction::GetControlValue.to_canonical_name(),
        "GET.CONTROLVALUE"
    );
    assert_eq!(
        BuiltinFunction::from_name(BuiltinFunction::GetControlValue.to_canonical_name()),
        BuiltinFunction::GetControlValue
    );
}

#[test]
fn test_get_controlvalue_parses_as_function_call() {
    let result = parse("=GET.CONTROLVALUE(\"MySlider\")").unwrap();
    match result {
        Expression::FunctionCall { func, args, .. } => {
            assert_eq!(func, BuiltinFunction::GetControlValue);
            assert_eq!(args.len(), 1);
        }
        _ => panic!("Expected FunctionCall, got {:?}", result),
    }
    // Alternate spellings parse to the same variant.
    for formula in ["=GET.CONTROL.VALUE(\"X\", 0)", "=GETCONTROLVALUE(\"X\", 0)"] {
        let result = parse(formula).unwrap();
        match result {
            Expression::FunctionCall { func, args, .. } => {
                assert_eq!(func, BuiltinFunction::GetControlValue);
                assert_eq!(args.len(), 2);
            }
            _ => panic!("Expected FunctionCall, got {:?}", result),
        }
    }
}

#[test]
fn test_get_controlvalue_catalog_entry_and_aliases() {
    use crate::ast::BuiltinFunction as BF;
    let entries = BF::all_catalog_entries();
    let primary = entries
        .iter()
        .find(|m| m.name == "GET.CONTROLVALUE")
        .expect("GET.CONTROLVALUE missing from function catalog");
    assert!(!primary.is_alias);
    assert_eq!(primary.category, "UI");
    assert_eq!(primary.syntax, "GET.CONTROLVALUE(name, [default])");
    for alias in ["GET.CONTROL.VALUE", "GETCONTROLVALUE"] {
        let meta = entries
            .iter()
            .find(|m| m.name == alias)
            .unwrap_or_else(|| panic!("{} alias missing from catalog", alias));
        assert!(meta.is_alias, "{} must be a hidden alias entry", alias);
    }
}

// ========================================
// THE CATALOG CENSUS (BUG-0095)
// ========================================

/// **EVERY NAME `from_name` ACCEPTS MUST HAVE A CATALOG ENTRY.**
///
/// WHY THIS EXISTS. `GATHER.AT` parsed, evaluated and returned correct values for
/// its whole life while appearing in NO catalog, so autocomplete never offered it,
/// the Insert Function dialog never listed it and `get_function_template` had
/// nothing to expand — a function that works and cannot be discovered. Nothing
/// could have noticed: the two sides are a `match` in one function and a `vec!` in
/// another, with no compiler relationship between them.
///
/// DIRECTION IS `from_name` -> catalog, deliberately. `from_name` is what makes a
/// name WORK; the catalog is what makes it findable. A name that works and is not
/// findable is the defect. (The reverse direction is the second test below, and it
/// catches a different mistake: a catalog entry nothing can parse.)
///
/// WHY IT READS SOURCE TEXT. `BuiltinFunction` has no variant iterator and
/// `from_name` is a string match, so the accepted names exist only as source. The
/// scan is bounded by BOTH ends of that function and `.expect()`s each marker, so a
/// rename fails loudly rather than silently scanning nothing — and it asserts a
/// FLOOR on how many names it found, because "the extraction broke" and "the
/// catalog is complete" would otherwise look identical.
#[test]
fn every_name_from_name_accepts_has_a_catalog_entry() {
    use crate::ast::BuiltinFunction as BF;
    use std::collections::BTreeSet;

    const SRC: &str = include_str!("ast.rs");
    let start = SRC
        .find("pub fn from_name(")
        .expect("from_name was renamed or removed - fix this census, do not delete it");
    let body = &SRC[start..];
    let end = body
        .find("_ => BuiltinFunction::Custom(")
        .expect("from_name's catch-all arm was renamed - fix this census");
    let body = &body[..end];

    let mut accepted: BTreeSet<String> = BTreeSet::new();
    for line in body.lines() {
        // `.lines()` leaves the \r on this CRLF file; trim() removes it.
        let t = line.trim();
        if !t.starts_with('"') || !t.contains("=>") {
            continue;
        }
        let left = t.split("=>").next().unwrap_or("");
        // `"A" | "B" => ...` yields both names: odd split indices are the literals.
        for (i, part) in left.split('"').enumerate() {
            if i % 2 == 1 {
                accepted.insert(part.to_ascii_uppercase());
            }
        }
    }
    assert!(
        accepted.len() > 450,
        "the arm scan found only {} names, so the EXTRACTION is broken rather than \
         the catalog being complete. A census that scans nothing passes vacuously.",
        accepted.len()
    );

    let catalog: BTreeSet<String> = BF::all_catalog_entries()
        .iter()
        .map(|m| m.name.to_ascii_uppercase())
        .collect();

    let missing: Vec<&String> = accepted.difference(&catalog).collect();
    assert!(
        missing.is_empty(),
        "{} function name(s) parse and evaluate but appear in NO catalog entry, so \
         they are invisible to autocomplete, to the Insert Function dialog and to \
         get_function_template: {:?}\n\nAdd a FunctionMeta::new(..) in \
         all_catalog_entries(). Do NOT use FunctionMeta::alias(..) to silence this \
         - alias entries are FILTERED OUT of the user-facing catalog, so that would \
         leave the defect in place while making the test green.",
        missing.len(),
        missing
    );
}

/// **AN ALIAS ENTRY MUST BE A REAL ALIAS** — the loophole in the census above.
///
/// `all_catalog_entries()` contains alias entries too, so the census is satisfied
/// by a `FunctionMeta::alias(..)`. But `build_full_catalog` FILTERS aliases out of
/// the user-facing list, so silencing the census that way would leave the function
/// exactly as invisible as it was — a green test over a live defect. The census
/// warns about that in prose; this makes it impossible.
///
/// The distinction is checkable rather than a matter of judgement: a genuine alias
/// resolves to the SAME `BuiltinFunction` variant as some non-alias entry (AVG and
/// AVERAGE are both `Average`). A primary function marked as an alias has no such
/// sibling — precisely the shape `GATHER.AT` would have had.
#[test]
fn every_alias_entry_shadows_a_real_entry_for_the_same_function() {
    use crate::ast::BuiltinFunction as BF;
    use std::collections::BTreeSet;

    let entries = BF::all_catalog_entries();
    let primary: BTreeSet<String> = entries
        .iter()
        .filter(|m| !m.is_alias)
        .map(|m| format!("{:?}", BF::from_name(m.name)))
        .collect();

    let orphaned: Vec<&'static str> = entries
        .iter()
        .filter(|m| m.is_alias)
        .filter(|m| !primary.contains(&format!("{:?}", BF::from_name(m.name))))
        .map(|m| m.name)
        .collect();

    assert!(
        orphaned.is_empty(),
        "these are marked as ALIASES but no non-alias entry resolves to the same \
         function, so they are filtered out of the user-facing catalog and nothing \
         offers them at all: {:?}\n\nIf one of these is a primary function, give it \
         a real FunctionMeta::new entry. Marking a primary function as an alias \
         satisfies the name census while leaving it invisible - which is exactly \
         what BUG-0095 was.",
        orphaned
    );
}

/// The reverse direction: a catalog entry nothing can parse.
///
/// Cheap (no source scan needed - `from_name` falls back to `Custom` for anything
/// it does not know) and it catches the opposite mistake: a name offered in the
/// Insert Function dialog that produces `#NAME?` when the user picks it.
#[test]
fn every_catalog_entry_names_a_function_the_parser_knows() {
    use crate::ast::BuiltinFunction as BF;

    let unparsed: Vec<&'static str> = BF::all_catalog_entries()
        .iter()
        .map(|m| m.name)
        .filter(|name| matches!(BF::from_name(name), BF::Custom(_)))
        .collect();

    assert!(
        unparsed.is_empty(),
        "these names are offered by the catalog but `from_name` does not recognise \
         them, so choosing one from the Insert Function dialog yields #NAME?: {:?}",
        unparsed
    );
}

// ========================================
// SCIENTIFIC NOTATION (register 3bj)
// ========================================
//
// `=1E3` is 1000 in Excel. The lexer had no exponent rule, so it produced
// Number(1) followed by Identifier("E3") -- two tokens with no operator, the
// parse failed, and the app stored the user's text AS TEXT: a cell reading
// "=1E3" with no error anywhere. `E` also begins a column name, so the rule
// commits only when an optional sign is followed by at least one digit; the
// three refusal cases below are the counterweight that keeps it from eating one.

#[test]
fn a_scientific_literal_lexes_as_one_number() {
    for (src, expected) in [
        ("1E3", 1000.0),
        ("1e3", 1000.0),
        ("2.5E2", 250.0),
        ("1E+3", 1000.0),
        ("1E-3", 0.001),
        (".5e1", 5.0),
    ] {
        let mut lexer = Lexer::new(src);
        assert_eq!(lexer.next_token(), Token::Number(expected), "lexing {src}");
        assert_eq!(lexer.next_token(), Token::EOF, "{src} must be ONE token");
    }
}

#[test]
fn an_e_that_is_not_an_exponent_is_left_alone() {
    // Each of these must lex exactly as it did before the exponent rule: the
    // number, then whatever the `E` starts. Consuming the `E` here would turn a
    // column name into part of a literal.
    for src in ["1E", "1E+", "1EUR"] {
        let mut lexer = Lexer::new(src);
        assert_eq!(lexer.next_token(), Token::Number(1.0), "lexing {src}");
        match lexer.next_token() {
            Token::Identifier(_) | Token::Plus => {}
            other => panic!("{src}: expected the E to survive as its own token, got {other:?}"),
        }
    }
}

#[test]
fn a_scientific_literal_parses_and_keeps_its_precedence() {
    // The whole point: these used to be parse errors, which the app turned into
    // a text cell.
    match parse("2.5E2+1") {
        Ok(Expression::BinaryOp { left, op, right }) => {
            assert_eq!(op, BinaryOperator::Add);
            assert!(matches!(*left, Expression::Literal(Value::Number(n)) if n == 250.0));
            assert!(matches!(*right, Expression::Literal(Value::Number(n)) if n == 1.0));
        }
        other => panic!("2.5E2+1 did not parse as 250 + 1: {other:?}"),
    }
    assert!(parse("SUM(1E2,2)").is_ok(), "a scientific literal must be usable as an argument");
    assert!(parse("1E3").is_ok());
}

#[test]
fn a_column_named_e_still_parses_as_a_reference() {
    // The counterweight to the exponent rule at the PARSER level: E3 and E10 are
    // ordinary cell references and must not have been absorbed into a literal.
    assert!(parse("E3").is_ok(), "E3 is a cell reference");
    assert!(parse("SUM(E3:E10)").is_ok(), "a range over column E must still parse");
}
