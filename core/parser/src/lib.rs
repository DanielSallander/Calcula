//! FILENAME: core/parser/src/lib.rs
//! PURPOSE: Library root for the Calcula formula parser.
//! CONTEXT: This module exposes the lexer, parser, and AST components
//! needed to convert formula strings into evaluatable expression trees.
//!
//! PIPELINE: Formula String --> Lexer --> Tokens --> Parser --> AST --> Evaluator
//!
//! SUPPORTED FEATURES:
//! - Arithmetic: +, -, *, /, ^ (power)
//! - Comparison: =, <>, <, >, <=, >=
//! - String concatenation: &
//! - Cell references: A1, AA100
//! - Ranges: A1:B10
//! - Function calls: SUM(A1:A10), IF(A1>0, "yes", "no")
//! - Parentheses for grouping
//! - Unary negation: -5

pub mod ast;
pub mod excel_arity;
pub mod lexer;
pub mod parser;
pub mod token;

// Register the separate tests module
#[cfg(test)]
mod tests;

// Re-export commonly used types for convenience
pub use ast::{BinaryOperator, BuiltinFunction, Expression, FunctionMeta, UnaryOperator, Value};
pub use excel_arity::{excel_refuses_arity, is_calcula_only_function, CALCULA_ONLY_FUNCTIONS};
pub use lexer::Lexer;
pub use parser::{
    anchor_name_references, any_unbound_name, bind_range_name_halves, bind_spill_anchor_names, builtin_arity,
    check_entered_formula, parse, replace_unbound_names, resolve_r1c1_names, ParseError, ParseResult, Parser,
};
pub use token::Token;