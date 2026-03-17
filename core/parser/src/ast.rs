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

    /// Subscript access into a List or Dict cell: expr[index]
    /// Supports chaining: A1[0]["name"] parses as nested IndexAccess nodes.
    /// Only allowed after CellRef, FunctionCall, NamedRef, or another IndexAccess.
    IndexAccess {
        target: Box<Expression>,
        index: Box<Expression>,
    },

    /// List literal: ={1, 2, 3}
    /// Creates an EvalResult::List from comma-separated expressions.
    ListLiteral {
        elements: Vec<Expression>,
    },

    /// Dict literal: ={"name": "Alice", "age": 30}
    /// Creates an EvalResult::Dict from colon-separated key:value pairs.
    DictLiteral {
        entries: Vec<(Expression, Expression)>,
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

    // Conditional aggregate functions
    SumIf,
    SumIfs,
    CountIf,
    CountIfs,
    AverageIf,
    AverageIfs,
    CountBlank,
    MinIfs,
    MaxIfs,

    // Logical functions
    If,
    And,
    Or,
    Not,
    True,
    False,
    IfError,
    IfNa,
    Ifs,
    Switch,
    Xor,

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
    SumProduct,
    Rand,
    RandBetween,
    Pi,
    Log,
    Log10,
    Ln,
    Exp,
    Sin,
    Cos,
    Tan,
    Asin,
    Acos,
    Atan,
    Atan2,
    RoundUp,
    RoundDown,
    Trunc,
    Even,
    Odd,
    Gcd,
    Lcm,
    Combin,
    Fact,
    Degrees,
    Radians,

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
    Find,
    Search,
    Substitute,
    Replace,
    ValueFn,
    Exact,
    Proper,
    Char,
    Code,
    Clean,
    NumberValue,
    TFn,

    // Date & Time functions
    Today,
    Now,
    Date,
    Year,
    Month,
    Day,
    Hour,
    Minute,
    Second,
    DateValue,
    TimeValue,
    EDate,
    EOMonth,
    NetworkDays,
    WorkDay,
    DateDif,
    Weekday,
    WeekNum,

    // Information functions
    IsNumber,
    IsText,
    IsBlank,
    IsError,
    IsNa,
    IsErr,
    IsLogical,
    IsOdd,
    IsEven,
    TypeFn,
    NFn,
    Na,
    IsFormula,

    // Lookup & Reference functions
    XLookup,
    XLookups,
    Index,
    Match,
    Choose,
    Indirect,
    Offset,
    Address,
    Rows,
    Columns,
    Transpose,

    // Statistical functions
    Median,
    Stdev,
    StdevP,
    Var,
    VarP,
    Large,
    Small,
    Rank,
    Percentile,
    Quartile,
    Mode,
    Frequency,

    // Financial functions
    Pmt,
    Pv,
    Fv,
    Npv,
    Irr,
    Rate,
    Nper,
    Sln,
    Db,
    Ddb,

    // UI GET functions (read worksheet state)
    GetRowHeight,
    GetColumnWidth,
    GetCellFillColor,

    // Reference functions
    Row,
    Column,

    // Advanced
    Let,
    TextJoin,

    // Dynamic array functions
    Filter,
    Sort,
    Unique,
    Sequence,

    // Collection functions (3D cells)
    Collect,
    DictFn,
    Keys,
    Values,
    Contains,
    IsList,
    IsDict,
    Flatten,
    Take,
    Drop,
    Append,
    Merge,
    HStack,

    /// Fallback for unrecognized function names (future extensions/plugins).
    Custom(String),
}

impl BuiltinFunction {
    /// Resolves a function name string (case-insensitive) to a BuiltinFunction variant.
    /// This is called once at parse time, not during evaluation.
    pub fn from_name(name: &str) -> Self {
        match name.to_uppercase().as_str() {
            // Aggregate functions
            "SUM" => BuiltinFunction::Sum,
            "AVERAGE" | "AVG" => BuiltinFunction::Average,
            "MIN" => BuiltinFunction::Min,
            "MAX" => BuiltinFunction::Max,
            "COUNT" => BuiltinFunction::Count,
            "COUNTA" => BuiltinFunction::CountA,

            // Conditional aggregates
            "SUMIF" => BuiltinFunction::SumIf,
            "SUMIFS" => BuiltinFunction::SumIfs,
            "COUNTIF" => BuiltinFunction::CountIf,
            "COUNTIFS" => BuiltinFunction::CountIfs,
            "AVERAGEIF" => BuiltinFunction::AverageIf,
            "AVERAGEIFS" => BuiltinFunction::AverageIfs,
            "COUNTBLANK" => BuiltinFunction::CountBlank,
            "MINIFS" => BuiltinFunction::MinIfs,
            "MAXIFS" => BuiltinFunction::MaxIfs,

            // Logical functions
            "IF" => BuiltinFunction::If,
            "AND" => BuiltinFunction::And,
            "OR" => BuiltinFunction::Or,
            "NOT" => BuiltinFunction::Not,
            "TRUE" => BuiltinFunction::True,
            "FALSE" => BuiltinFunction::False,
            "IFERROR" => BuiltinFunction::IfError,
            "IFNA" => BuiltinFunction::IfNa,
            "IFS" => BuiltinFunction::Ifs,
            "SWITCH" => BuiltinFunction::Switch,
            "XOR" => BuiltinFunction::Xor,

            // Math functions
            "ABS" => BuiltinFunction::Abs,
            "ROUND" => BuiltinFunction::Round,
            "FLOOR" => BuiltinFunction::Floor,
            "CEILING" | "CEIL" => BuiltinFunction::Ceiling,
            "SQRT" => BuiltinFunction::Sqrt,
            "POWER" | "POW" => BuiltinFunction::Power,
            "MOD" => BuiltinFunction::Mod,
            "INT" => BuiltinFunction::Int,
            "SIGN" => BuiltinFunction::Sign,
            "SUMPRODUCT" => BuiltinFunction::SumProduct,
            "RAND" => BuiltinFunction::Rand,
            "RANDBETWEEN" => BuiltinFunction::RandBetween,
            "PI" => BuiltinFunction::Pi,
            "LOG" => BuiltinFunction::Log,
            "LOG10" => BuiltinFunction::Log10,
            "LN" => BuiltinFunction::Ln,
            "EXP" => BuiltinFunction::Exp,
            "SIN" => BuiltinFunction::Sin,
            "COS" => BuiltinFunction::Cos,
            "TAN" => BuiltinFunction::Tan,
            "ASIN" => BuiltinFunction::Asin,
            "ACOS" => BuiltinFunction::Acos,
            "ATAN" => BuiltinFunction::Atan,
            "ATAN2" => BuiltinFunction::Atan2,
            "ROUNDUP" => BuiltinFunction::RoundUp,
            "ROUNDDOWN" => BuiltinFunction::RoundDown,
            "TRUNC" => BuiltinFunction::Trunc,
            "EVEN" => BuiltinFunction::Even,
            "ODD" => BuiltinFunction::Odd,
            "GCD" => BuiltinFunction::Gcd,
            "LCM" => BuiltinFunction::Lcm,
            "COMBIN" => BuiltinFunction::Combin,
            "FACT" | "FACTORIAL" => BuiltinFunction::Fact,
            "DEGREES" => BuiltinFunction::Degrees,
            "RADIANS" => BuiltinFunction::Radians,

            // Text functions
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
            "FIND" => BuiltinFunction::Find,
            "SEARCH" => BuiltinFunction::Search,
            "SUBSTITUTE" => BuiltinFunction::Substitute,
            "REPLACE" => BuiltinFunction::Replace,
            "VALUE" => BuiltinFunction::ValueFn,
            "EXACT" => BuiltinFunction::Exact,
            "PROPER" => BuiltinFunction::Proper,
            "CHAR" => BuiltinFunction::Char,
            "CODE" => BuiltinFunction::Code,
            "CLEAN" => BuiltinFunction::Clean,
            "NUMBERVALUE" => BuiltinFunction::NumberValue,
            "T" => BuiltinFunction::TFn,

            // Date & Time functions
            "TODAY" => BuiltinFunction::Today,
            "NOW" => BuiltinFunction::Now,
            "DATE" => BuiltinFunction::Date,
            "YEAR" => BuiltinFunction::Year,
            "MONTH" => BuiltinFunction::Month,
            "DAY" => BuiltinFunction::Day,
            "HOUR" => BuiltinFunction::Hour,
            "MINUTE" => BuiltinFunction::Minute,
            "SECOND" => BuiltinFunction::Second,
            "DATEVALUE" => BuiltinFunction::DateValue,
            "TIMEVALUE" => BuiltinFunction::TimeValue,
            "EDATE" => BuiltinFunction::EDate,
            "EOMONTH" => BuiltinFunction::EOMonth,
            "NETWORKDAYS" => BuiltinFunction::NetworkDays,
            "WORKDAY" => BuiltinFunction::WorkDay,
            "DATEDIF" => BuiltinFunction::DateDif,
            "WEEKDAY" => BuiltinFunction::Weekday,
            "WEEKNUM" => BuiltinFunction::WeekNum,

            // Information functions
            "ISNUMBER" => BuiltinFunction::IsNumber,
            "ISTEXT" => BuiltinFunction::IsText,
            "ISBLANK" => BuiltinFunction::IsBlank,
            "ISERROR" => BuiltinFunction::IsError,
            "ISNA" => BuiltinFunction::IsNa,
            "ISERR" => BuiltinFunction::IsErr,
            "ISLOGICAL" => BuiltinFunction::IsLogical,
            "ISODD" => BuiltinFunction::IsOdd,
            "ISEVEN" => BuiltinFunction::IsEven,
            "TYPE" => BuiltinFunction::TypeFn,
            "N" => BuiltinFunction::NFn,
            "NA" => BuiltinFunction::Na,
            "ISFORMULA" => BuiltinFunction::IsFormula,

            // Lookup & Reference functions
            "XLOOKUP" => BuiltinFunction::XLookup,
            "XLOOKUPS" => BuiltinFunction::XLookups,
            "INDEX" => BuiltinFunction::Index,
            "MATCH" => BuiltinFunction::Match,
            "CHOOSE" => BuiltinFunction::Choose,
            "INDIRECT" => BuiltinFunction::Indirect,
            "OFFSET" => BuiltinFunction::Offset,
            "ADDRESS" => BuiltinFunction::Address,
            "ROWS" => BuiltinFunction::Rows,
            "COLUMNS" => BuiltinFunction::Columns,
            "TRANSPOSE" => BuiltinFunction::Transpose,

            // Statistical functions
            "MEDIAN" => BuiltinFunction::Median,
            "STDEV" => BuiltinFunction::Stdev,
            "STDEVP" | "STDEV.P" => BuiltinFunction::StdevP,
            "VAR" => BuiltinFunction::Var,
            "VARP" | "VAR.P" => BuiltinFunction::VarP,
            "LARGE" => BuiltinFunction::Large,
            "SMALL" => BuiltinFunction::Small,
            "RANK" | "RANK.EQ" => BuiltinFunction::Rank,
            "PERCENTILE" | "PERCENTILE.INC" => BuiltinFunction::Percentile,
            "QUARTILE" | "QUARTILE.INC" => BuiltinFunction::Quartile,
            "MODE" | "MODE.SNGL" => BuiltinFunction::Mode,
            "FREQUENCY" => BuiltinFunction::Frequency,

            // Financial functions
            "PMT" => BuiltinFunction::Pmt,
            "PV" => BuiltinFunction::Pv,
            "FV" => BuiltinFunction::Fv,
            "NPV" => BuiltinFunction::Npv,
            "IRR" => BuiltinFunction::Irr,
            "RATE" => BuiltinFunction::Rate,
            "NPER" => BuiltinFunction::Nper,
            "SLN" => BuiltinFunction::Sln,
            "DB" => BuiltinFunction::Db,
            "DDB" => BuiltinFunction::Ddb,

            // UI GET functions
            "GET.ROW.HEIGHT" | "GETROWHEIGHT" => BuiltinFunction::GetRowHeight,
            "GET.COLUMN.WIDTH" | "GETCOLUMNWIDTH" => BuiltinFunction::GetColumnWidth,
            "GET.CELL.FILLCOLOR" | "GETCELLFILLCOLOR" => BuiltinFunction::GetCellFillColor,

            // Reference functions
            "ROW" => BuiltinFunction::Row,
            "COLUMN" => BuiltinFunction::Column,

            // Advanced
            "LET" => BuiltinFunction::Let,
            "TEXTJOIN" => BuiltinFunction::TextJoin,

            // Dynamic array functions
            "FILTER" => BuiltinFunction::Filter,
            "SORT" => BuiltinFunction::Sort,
            "UNIQUE" => BuiltinFunction::Unique,
            "SEQUENCE" => BuiltinFunction::Sequence,

            // Collection functions (3D cells)
            "COLLECT" => BuiltinFunction::Collect,
            "DICT" => BuiltinFunction::DictFn,
            "KEYS" => BuiltinFunction::Keys,
            "VALUES" => BuiltinFunction::Values,
            "CONTAINS" => BuiltinFunction::Contains,
            "ISLIST" => BuiltinFunction::IsList,
            "ISDICT" => BuiltinFunction::IsDict,
            "FLATTEN" => BuiltinFunction::Flatten,
            "TAKE" => BuiltinFunction::Take,
            "DROP" => BuiltinFunction::Drop,
            "APPEND" => BuiltinFunction::Append,
            "MERGE" => BuiltinFunction::Merge,
            "HSTACK" => BuiltinFunction::HStack,

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