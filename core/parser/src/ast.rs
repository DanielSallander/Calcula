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
    /// The function is resolved to a `BuiltinFunction` enum at parse time
    /// to avoid heap-allocating and string-comparing on every evaluation.
    FunctionCall { func: BuiltinFunction, args: Vec<Expression> },

    /// A named reference like Tax_Rate, SalesData, or Q1.Sales.
    /// Represents a user-defined name that will be resolved during evaluation
    /// to a cell range, constant, or formula via the name resolution system.
    /// The name is stored uppercased for case-insensitive matching.
    NamedRef { name: String },

    /// A 3D (cross-sheet) reference like Sheet1:Sheet5!A1 or 'Jan:Dec'!A1:B10.
    /// Aggregates data across the same spatial coordinates on multiple contiguous
    /// worksheet tabs. The inner reference (CellRef, Range, ColumnRef, or RowRef)
    /// has sheet=None because the sheet range is defined by start_sheet..end_sheet.
    Sheet3DRef {
        start_sheet: String,
        end_sheet: String,
        reference: Box<Expression>,
    },

    /// A structured table reference like Table1[Revenue], [@Price], or Table1[#All].
    /// Resolved during the table-reference resolution pass before evaluation.
    TableRef {
        table_name: String,
        specifier: TableSpecifier,
    },
}

/// Specifier for structured table references.
/// Determines which part of the table a structured reference refers to.
#[derive(Debug, PartialEq, Clone)]
pub enum TableSpecifier {
    /// A single column reference: Table1[Revenue]
    Column(String),
    /// This-row reference: [@Revenue] (resolves to a single cell in the formula's row)
    ThisRow(String),
    /// Column range: Table1[[Col1]:[Col2]]
    ColumnRange(String, String),
    /// This-row column range: [@[Col1]:[Col2]] or [@Col1]:[@Col2]
    ThisRowRange(String, String),
    /// Special specifier: [#All] - entire table including headers and totals
    AllRows,
    /// Special specifier: [#Data] - data body only
    DataRows,
    /// Special specifier: [#Headers] - header row only
    Headers,
    /// Special specifier: [#Totals] - totals row only
    Totals,
    /// Special specifier combined with column: [#Headers],[Revenue]
    SpecialColumn(Box<TableSpecifier>, String),
}

/// Built-in spreadsheet functions resolved at parse time.
/// Using an enum instead of a String avoids heap allocations and enables
/// fast integer-based dispatch in the evaluator.
#[derive(Debug, PartialEq, Clone)]
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

impl BuiltinFunction {
    /// Resolves a function name string (case-insensitive) to a BuiltinFunction variant.
    /// This is called once at parse time, not during evaluation.
    pub fn from_name(name: &str) -> Self {
        match name.to_uppercase().as_str() {
            "SUM" => BuiltinFunction::Sum,
            "AVERAGE" | "AVG" => BuiltinFunction::Average,
            "MIN" => BuiltinFunction::Min,
            "MAX" => BuiltinFunction::Max,
            "COUNT" => BuiltinFunction::Count,
            "COUNTA" => BuiltinFunction::CountA,

            "IF" => BuiltinFunction::If,
            "AND" => BuiltinFunction::And,
            "OR" => BuiltinFunction::Or,
            "NOT" => BuiltinFunction::Not,
            "TRUE" => BuiltinFunction::True,
            "FALSE" => BuiltinFunction::False,

            "ABS" => BuiltinFunction::Abs,
            "ROUND" => BuiltinFunction::Round,
            "FLOOR" => BuiltinFunction::Floor,
            "CEILING" | "CEIL" => BuiltinFunction::Ceiling,
            "SQRT" => BuiltinFunction::Sqrt,
            "POWER" | "POW" => BuiltinFunction::Power,
            "MOD" => BuiltinFunction::Mod,
            "INT" => BuiltinFunction::Int,
            "SIGN" => BuiltinFunction::Sign,

            "LEN" => BuiltinFunction::Len,
            "UPPER" => BuiltinFunction::Upper,
            "LOWER" => BuiltinFunction::Lower,
            "TRIM" => BuiltinFunction::Trim,
            "CONCATENATE" | "CONCAT" => BuiltinFunction::Concatenate,
            "LEFT" => BuiltinFunction::Left,
            "RIGHT" => BuiltinFunction::Right,
            "MID" => BuiltinFunction::Mid,
            "REPT" => BuiltinFunction::Rept,
            "TEXT" => BuiltinFunction::Text,

            "ISNUMBER" => BuiltinFunction::IsNumber,
            "ISTEXT" => BuiltinFunction::IsText,
            "ISBLANK" => BuiltinFunction::IsBlank,
            "ISERROR" => BuiltinFunction::IsError,

            "XLOOKUP" => BuiltinFunction::XLookup,
            "XLOOKUPS" => BuiltinFunction::XLookups,



            "GET.ROW.HEIGHT" | "GETROWHEIGHT" => BuiltinFunction::GetRowHeight,
            "GET.COLUMN.WIDTH" | "GETCOLUMNWIDTH" => BuiltinFunction::GetColumnWidth,
            "GET.CELL.FILLCOLOR" | "GETCELLFILLCOLOR" => BuiltinFunction::GetCellFillColor,

            "ROW" => BuiltinFunction::Row,
            "COLUMN" => BuiltinFunction::Column,

            _ => BuiltinFunction::Custom(name.to_uppercase()),
        }
    }
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