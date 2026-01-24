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
pub mod lexer;
pub mod parser;
pub mod token;

// Register the separate tests module
#[cfg(test)]
mod tests;

// Re-export commonly used types for convenience
pub use ast::{BinaryOperator, Expression, UnaryOperator, Value};
pub use lexer::Lexer;
pub use parser::{parse, ParseError, ParseResult, Parser};
pub use token::Token;