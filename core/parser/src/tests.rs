//! FILENAME: core/parser/src/tests.rs
//! PURPOSE: Consolidated unit tests for the parser crate.

use crate::ast::{BinaryOperator, BuiltinFunction, Expression, UnaryOperator, Value};
use crate::lexer::Lexer;
use crate::parser::parse;
use crate::token::Token;

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
            row_absolute: false
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
            row_absolute: false
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
                row_absolute: false
            }),
            end: Box::new(Expression::CellRef {
                sheet: None,
                col: "B".to_string(),
                row: 10,
                col_absolute: false,
                row_absolute: false
            })
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
                row_absolute: false
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
                row_absolute: false
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
                row_absolute: false
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
                row_absolute: false
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
                row_absolute: false
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
                row_absolute: false
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
fn parser_power_is_right_associative() {
    // 2 ^ 3 ^ 2 should be parsed as 2 ^ (3 ^ 2) = 2 ^ 9 = 512
    let result = parse("=2 ^ 3 ^ 2").unwrap();
    assert_eq!(
        result,
        Expression::BinaryOp {
            left: Box::new(Expression::Literal(Value::Number(2.0))),
            op: BinaryOperator::Power,
            right: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Literal(Value::Number(3.0))),
                op: BinaryOperator::Power,
                right: Box::new(Expression::Literal(Value::Number(2.0)))
            })
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
                    row_absolute: false
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
fn parser_parses_negation_with_power() {
    // -2 ^ 2 should be parsed as -(2 ^ 2) = -4 (unary binds tighter than power)
    let result = parse("=-2 ^ 2").unwrap();
    assert_eq!(
        result,
        Expression::UnaryOp {
            op: UnaryOperator::Negate,
            operand: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Literal(Value::Number(2.0))),
                op: BinaryOperator::Power,
                right: Box::new(Expression::Literal(Value::Number(2.0)))
            })
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
            func: BuiltinFunction::Custom("NOW".to_string()),
            args: vec![]
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
            }]
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
            ]
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
                    row_absolute: false
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 10,
                    col_absolute: false,
                    row_absolute: false
                })
            }]
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
                    }]
                },
                Expression::FunctionCall {
                    func: BuiltinFunction::Abs,
                    args: vec![Expression::UnaryOp {
                        op: UnaryOperator::Negate,
                        operand: Box::new(Expression::Literal(Value::Number(2.0)))
                    }]
                }
            ]
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
            ]
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
                        row_absolute: false
                    }),
                    op: BinaryOperator::GreaterThan,
                    right: Box::new(Expression::Literal(Value::Number(10.0)))
                },
                Expression::Literal(Value::String("big".to_string())),
                Expression::Literal(Value::String("small".to_string()))
            ]
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
                row_absolute: false
            }),
            op: BinaryOperator::Add,
            right: Box::new(Expression::CellRef {
                sheet: None,
                col: "B".to_string(),
                row: 2,
                col_absolute: false,
                row_absolute: false
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
                            row_absolute: false
                        }),
                        end: Box::new(Expression::CellRef {
                            sheet: None,
                            col: "A".to_string(),
                            row: 10,
                            col_absolute: false,
                            row_absolute: false
                        })
                    }]
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
                row_absolute: false
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
                                row_absolute: false
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
fn parser_error_on_invalid_cell_ref() {
    // "ABC" without a row number
    let result = parse("=ABC");
    assert!(result.is_err());
    assert!(result.unwrap_err().message.contains("missing row"));
}

#[test]
fn parser_error_on_trailing_operator() {
    let result = parse("=1 +");
    assert!(result.is_err());
}

#[test]
fn parser_error_on_double_operator() {
    let result = parse("=1 + + 2");
    assert!(result.is_err());
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
            end_absolute: false
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
            end_absolute: false
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
            end_absolute: false
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
            end_absolute: false
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
            row_absolute: false
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
            row_absolute: false
        }
    );
}

#[test]
fn test_parse_sheet_range() {
    let result = parse("=Sheet1!A1:B10").unwrap();
    match result {
        Expression::Range { sheet, start, end } => {
            assert_eq!(sheet, Some("SHEET1".to_string()));
            assert_eq!(
                *start,
                Expression::CellRef {
                    sheet: None,
                    col: "A".to_string(),
                    row: 1,
                    col_absolute: false,
                    row_absolute: false
                }
            );
            assert_eq!(
                *end,
                Expression::CellRef {
                    sheet: None,
                    col: "B".to_string(),
                    row: 10,
                    col_absolute: false,
                    row_absolute: false
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
            end_absolute: false
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
            end_absolute: false
        }
    );
}

#[test]
fn test_parse_sum_with_sheet_ref() {
    let result = parse("=SUM(Sheet1!A1:A10)").unwrap();
    match result {
        Expression::FunctionCall { func, args } => {
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
        Expression::FunctionCall { func, args } => {
            assert_eq!(func, BuiltinFunction::Sum);
            assert_eq!(args.len(), 1);
            assert_eq!(
                args[0],
                Expression::ColumnRef {
                    sheet: None,
                    start_col: "A".to_string(),
                    end_col: "A".to_string(),
                    start_absolute: false,
                    end_absolute: false
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
        Expression::FunctionCall { func, args } => {
            assert_eq!(func, BuiltinFunction::Sum);
            assert_eq!(args.len(), 1);
            assert_eq!(
                args[0],
                Expression::RowRef {
                    sheet: None,
                    start_row: 1,
                    end_row: 3,
                    start_absolute: false,
                    end_absolute: false
                }
            );
        }
        _ => panic!("Expected FunctionCall"),
    }
}