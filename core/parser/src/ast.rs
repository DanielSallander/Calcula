//! FILENAME: core/parser/src/ast.rs
//! PURPOSE: Defines the Abstract Syntax Tree (AST) for formula expressions.
//! CONTEXT: After the Lexer tokenizes a formula string, the Parser converts
//! those tokens into this tree structure. The Evaluator then traverses
//! this tree to compute the final result.
//!
//! SUPPORTED EXPRESSIONS:
//! - Literals: Numbers, Strings, Booleans
//! - Cell references: A1, AA100, Sheet1!A1, 'Sheet Name'!A1
//! - Absolute references: $A$1, A$1, $A1
//! - Ranges: A1:B10, Sheet1!A1:B10, $A$1:$B$10
//! - Column references: A:A, A:B, Sheet1!A:B, $A:$B
//! - Row references: 1:1, 1:5, Sheet1!1:5, $1:$5
//! - Binary operations: +, -, *, /, ^, &, =, <>, <, >, <=, >=
//! - Unary operations: - (negation)
//! - Function calls: SUM(A1:A10), IF(A1>0, "yes", "no")

/// Represents a parsed formula expression.
/// This is the core data structure that the evaluator will traverse.
#[derive(Debug, PartialEq, Clone)]
pub enum Expression {
    /// A literal value: number, string, or boolean.
    Literal(Value),

    /// A single cell reference like A1, B2, AA100, $A$1, or Sheet1!A1.
    /// The column is stored as a string (e.g., "A", "AA") and row as 1-indexed integer.
    /// The sheet is optional and only present for cross-sheet references.
    /// col_absolute and row_absolute indicate if $ prefix was used.
    CellRef {
        sheet: Option<String>,
        col: String,
        row: u32,
        col_absolute: bool,
        row_absolute: bool,
    },

    /// A range reference like A1:B10 or Sheet1!$A$1:$B$10.
    /// Both start and end should be CellRef expressions.
    /// The sheet applies to the entire range.
    Range {
        sheet: Option<String>,
        start: Box<Expression>,
        end: Box<Expression>,
    },

    /// A column reference like A:A, A:B, $A:$B, or Sheet1!A:B (entire columns).
    /// Used for referencing all cells in one or more columns.
    ColumnRef {
        sheet: Option<String>,
        start_col: String,
        end_col: String,
        start_absolute: bool,
        end_absolute: bool,
    },

    /// A row reference like 1:1, 1:5, $1:$5, or Sheet1!1:5 (entire rows).
    /// Used for referencing all cells in one or more rows.
    RowRef {
        sheet: Option<String>,
        start_row: u32,
        end_row: u32,
        start_absolute: bool,
        end_absolute: bool,
    },

    /// A binary operation: left op right (e.g., 5 + 3, A1 > 10).
    BinaryOp {
        left: Box<Expression>,
        op: BinaryOperator,
        right: Box<Expression>,
    },

    /// A unary operation: op operand (e.g., -5).
    UnaryOp {
        op: UnaryOperator,
        operand: Box<Expression>,
    },

    /// A function call like SUM(A1:A10) or IF(A1 > 0, "yes", "no").
    FunctionCall { name: String, args: Vec<Expression> },
}

/// Literal values that can appear in formulas.
#[derive(Debug, PartialEq, Clone)]
pub enum Value {
    Number(f64),
    String(String),
    Boolean(bool),
}

/// Binary operators for expressions.
/// Listed in order of precedence groups (comparison is lowest).
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum BinaryOperator {
    // Comparison operators (lowest precedence)
    Equal,        // =
    NotEqual,     // <>
    LessThan,     // 
    GreaterThan,  // >
    LessEqual,    // <=
    GreaterEqual, // >=

    // String concatenation
    Concat, // &

    // Arithmetic operators
    Add,      // +
    Subtract, // -
    Multiply, // *
    Divide,   // /
    Power,    // ^ (highest precedence among binary ops)
}

/// Unary operators.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum UnaryOperator {
    Negate, // -
}

impl std::fmt::Display for BinaryOperator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BinaryOperator::Add => write!(f, "+"),
            BinaryOperator::Subtract => write!(f, "-"),
            BinaryOperator::Multiply => write!(f, "*"),
            BinaryOperator::Divide => write!(f, "/"),
            BinaryOperator::Power => write!(f, "^"),
            BinaryOperator::Concat => write!(f, "&"),
            BinaryOperator::Equal => write!(f, "="),
            BinaryOperator::NotEqual => write!(f, "<>"),
            BinaryOperator::LessThan => write!(f, "<"),
            BinaryOperator::GreaterThan => write!(f, ">"),
            BinaryOperator::LessEqual => write!(f, "<="),
            BinaryOperator::GreaterEqual => write!(f, ">="),
        }
    }
}

impl std::fmt::Display for UnaryOperator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UnaryOperator::Negate => write!(f, "-"),
        }
    }
}

impl std::fmt::Display for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Value::Number(n) => write!(f, "{}", n),
            Value::String(s) => write!(f, "\"{}\"", s),
            Value::Boolean(b) => write!(f, "{}", if *b { "TRUE" } else { "FALSE" }),
        }
    }
}