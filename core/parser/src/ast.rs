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

    /// Spill range operator: A1# references the entire spill range anchored at the cell.
    /// Resolved in the Tauri layer before evaluation by replacing with an actual Range.
    SpillRef {
        cell: Box<Expression>,
    },

    /// Implicit intersection operator: @A1:A10 extracts the single value
    /// at the formula's row (or column) from a multi-cell range.
    ImplicitIntersection {
        operand: Box<Expression>,
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
    SumX2MY2,
    SumX2PY2,
    SumXMY2,
    Product,
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

    // Advanced / Lambda
    Let,
    TextJoin,
    Lambda,
    Map,
    Reduce,
    Scan,
    MakeArray,
    ByRow,
    ByCol,

    // Dynamic array functions
    Filter,
    Sort,
    SortBy,
    Unique,
    Sequence,
    RandArray,
    GroupBy,
    PivotBy,
    GetPivotData,

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

    // File functions (virtual file system)
    FileRead,
    FileLines,
    FileExists,

    // Subtotal function
    Subtotal,

    // Text parsing/conversion functions
    TextSplit,
    TextBefore,
    TextAfter,
    ValueToText,
    ArrayToText,

    // Additional date functions
    Days360,
    Days,
    Time,
    YearFrac,
    IsoWeekNum,
    NetworkDaysIntl,
    WorkDayIntl,

    // Additional statistical functions
    ModeMult,
    StdevS,
    VarS,
    RankAvg,
    PercentRank,
    Trend,
    Growth,
    Linest,
    Logest,

    // Probability distributions
    NormDist,
    NormInv,
    NormSDist,
    NormSInv,
    TDist,
    TDist2T,
    TDistRT,
    TInv,
    TInv2T,
    TTest,
    ChisqDist,
    ChisqDistRT,
    ChisqInv,
    ChisqInvRT,
    ChisqTest,
    FDist,
    FDistRT,
    FInv,
    FInvRT,
    FTest,
    BinomDist,
    BinomInv,
    BinomDistRange,
    PoissonDist,
    BetaDist,
    BetaInv,
    GammaDist,
    GammaInv,
    GammaFn,
    GammaLnFn,
    WeibullDist,
    ExponDist,
    LognormDist,
    LognormInv,
    HypgeomDist,
    NegbinomDist,
    ConfidenceNorm,
    ConfidenceT,

    // Descriptive/Analytical statistical functions
    Correl,
    Pearson,
    Rsq,
    Slope,
    Intercept,
    Steyx,
    CovarianceP,
    CovarianceS,
    Kurt,
    Skew,
    SkewP,
    Avedev,
    Devsq,
    Geomean,
    Harmean,
    Trimmean,
    Standardize,
    PercentileExc,
    PercentRankExc,
    QuartileExc,
    Prob,
    Fisher,
    FisherInv,
    Permut,
    PermutationA,
    Phi,
    Gauss,

    // Forecasting
    ForecastLinear,
    ForecastEts,
    ForecastEtsConfint,
    ForecastEtsSeason,
    ForecastEtsStat,

    // Statistical version variants (include text/logical)
    AverageA,
    MaxA,
    MinA,
    StdevA,
    StdevPA,
    VarA,
    VarPA,

    // Additional financial functions
    Ipmt,
    Ppmt,
    FvSchedule,
    Xnpv,
    Xirr,
    Mirr,
    Syd,
    Vdb,
    Cumipmt,
    Cumprinc,
    Effect,
    Nominal,

    // Bond & Security financial functions
    Accrint,
    Accrintm,
    PriceFn,
    PriceDisc,
    PriceMat,
    YieldFn,
    YieldDisc,
    YieldMat,
    DurationFn,
    Mduration,
    Disc,
    Intrate,
    Received,
    Coupdaybs,
    Coupdays,
    Coupdaysnc,
    Coupncd,
    Coupnum,
    Couppcd,

    // Treasury bill functions
    TbillEq,
    TbillPrice,
    TbillYield,

    // Other financial functions
    DollarDe,
    DollarFr,
    Pduration,
    Rri,
    Ispmt,
    Amordegrc,
    Amorlinc,
    OddfPrice,
    OddfYield,
    OddlPrice,
    OddlYield,

    // Modern lookup functions
    XMatch,

    // Selection functions
    ChooseCols,
    ChooseRows,

    // Reference & Info functions
    Areas,
    CellFn,
    FormulaText,

    // Lookup functions (legacy)
    VLookup,
    HLookup,
    Lookup,

    // Hyperbolic & reciprocal trig functions
    Sinh,
    Cosh,
    Tanh,
    Cot,
    Coth,
    Csc,
    Csch,
    Sec,
    Sech,
    Acot,

    // Rounding variants
    CeilingMath,
    CeilingPrecise,
    FloorMath,
    FloorPrecise,
    IsoCeiling,

    // Additional math functions (Group 3)
    Multinomial,
    Combina,
    FactDouble,
    SqrtPi,

    // Aggregate function
    Aggregate,

    // Web functions
    EncodeUrl,

    // Additional math functions
    MRound,
    Quotient,
    SumSq,
    Roman,
    Arabic,
    Base,
    Decimal,

    // Additional text functions
    Dollar,
    Euro,
    Fixed,
    Unichar,
    Unicode,

    // Additional information functions
    ErrorType,
    IsNonText,
    IsRef,
    Sheet,
    Sheets,

    // Array reshaping functions
    Expand,
    VStack,
    ToCol,
    ToRow,
    WrapCols,
    WrapRows,

    // Engineering functions - Base conversion
    Bin2Dec,
    Bin2Hex,
    Bin2Oct,
    Dec2Bin,
    Dec2Hex,
    Dec2Oct,
    Hex2Bin,
    Hex2Dec,
    Hex2Oct,
    Oct2Bin,
    Oct2Dec,
    Oct2Hex,

    // Engineering functions - Bit operations
    BitAnd,
    BitOr,
    BitXor,
    BitLShift,
    BitRShift,

    // Engineering functions - Complex numbers
    ComplexFn,
    ImAbs,
    Imaginary,
    ImReal,
    ImArgument,
    ImConjugate,
    ImCos,
    ImCosh,
    ImCot,
    ImCsc,
    ImCsch,
    ImDiv,
    ImExp,
    ImLn,
    ImLog10,
    ImLog2,
    ImPower,
    ImProduct,
    ImSec,
    ImSech,
    ImSin,
    ImSinh,
    ImSqrt,
    ImSub,
    ImSum,
    ImTan,

    // Engineering functions - Bessel
    BesselI,
    BesselJ,
    BesselK,
    BesselY,

    // Engineering functions - Other
    ConvertFn,
    Delta,
    Erf,
    ErfPrecise,
    Erfc,
    ErfcPrecise,
    Gestep,
    SeriesSum,

    // Matrix functions
    Mmult,
    Mdeterm,
    Minverse,
    Munit,

    // Database functions
    DAverage,
    DCount,
    DCountA,
    DGet,
    DMax,
    DMin,
    DProduct,
    DStdev,
    DStdevP,
    DSum,
    DVar,
    DVarP,

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
            "SUMX2MY2" => BuiltinFunction::SumX2MY2,
            "SUMX2PY2" => BuiltinFunction::SumX2PY2,
            "SUMXMY2" => BuiltinFunction::SumXMY2,
            "PRODUCT" => BuiltinFunction::Product,
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
            "LAMBDA" => BuiltinFunction::Lambda,
            "MAP" => BuiltinFunction::Map,
            "REDUCE" => BuiltinFunction::Reduce,
            "SCAN" => BuiltinFunction::Scan,
            "MAKEARRAY" => BuiltinFunction::MakeArray,
            "BYROW" => BuiltinFunction::ByRow,
            "BYCOL" => BuiltinFunction::ByCol,

            // Dynamic array functions
            "FILTER" => BuiltinFunction::Filter,
            "SORT" => BuiltinFunction::Sort,
            "SORTBY" => BuiltinFunction::SortBy,
            "UNIQUE" => BuiltinFunction::Unique,
            "SEQUENCE" => BuiltinFunction::Sequence,
            "RANDARRAY" => BuiltinFunction::RandArray,
            "GROUPBY" => BuiltinFunction::GroupBy,
            "PIVOTBY" => BuiltinFunction::PivotBy,
            "GETPIVOTDATA" => BuiltinFunction::GetPivotData,

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

            // File functions
            "FILEREAD" | "FILE.READ" => BuiltinFunction::FileRead,
            "FILELINES" | "FILE.LINES" => BuiltinFunction::FileLines,
            "FILEEXISTS" | "FILE.EXISTS" => BuiltinFunction::FileExists,

            // Subtotal function
            "SUBTOTAL" => BuiltinFunction::Subtotal,

            // Text parsing/conversion
            "TEXTSPLIT" => BuiltinFunction::TextSplit,
            "TEXTBEFORE" => BuiltinFunction::TextBefore,
            "TEXTAFTER" => BuiltinFunction::TextAfter,
            "VALUETOTEXT" => BuiltinFunction::ValueToText,
            "ARRAYTOTEXT" => BuiltinFunction::ArrayToText,

            // Additional date functions
            "DAYS" => BuiltinFunction::Days,
            "TIME" => BuiltinFunction::Time,
            "DAYS360" => BuiltinFunction::Days360,
            "YEARFRAC" => BuiltinFunction::YearFrac,
            "ISOWEEKNUM" => BuiltinFunction::IsoWeekNum,
            "NETWORKDAYS.INTL" => BuiltinFunction::NetworkDaysIntl,
            "WORKDAY.INTL" => BuiltinFunction::WorkDayIntl,

            // Additional statistical functions
            "MODE.MULT" => BuiltinFunction::ModeMult,
            "STDEV.S" => BuiltinFunction::StdevS,
            "VAR.S" => BuiltinFunction::VarS,
            "RANK.AVG" => BuiltinFunction::RankAvg,
            "PERCENTRANK" | "PERCENTRANK.INC" => BuiltinFunction::PercentRank,
            "TREND" => BuiltinFunction::Trend,
            "GROWTH" => BuiltinFunction::Growth,
            "LINEST" => BuiltinFunction::Linest,
            "LOGEST" => BuiltinFunction::Logest,

            // Probability distributions
            "NORM.DIST" | "NORMDIST" => BuiltinFunction::NormDist,
            "NORM.INV" | "NORMINV" => BuiltinFunction::NormInv,
            "NORM.S.DIST" | "NORMSDIST" => BuiltinFunction::NormSDist,
            "NORM.S.INV" | "NORMSINV" => BuiltinFunction::NormSInv,
            "T.DIST" | "TDIST" => BuiltinFunction::TDist,
            "T.DIST.2T" => BuiltinFunction::TDist2T,
            "T.DIST.RT" => BuiltinFunction::TDistRT,
            "T.INV" => BuiltinFunction::TInv,
            "T.INV.2T" | "TINV" => BuiltinFunction::TInv2T,
            "T.TEST" | "TTEST" => BuiltinFunction::TTest,
            "CHISQ.DIST" | "CHISQDIST" => BuiltinFunction::ChisqDist,
            "CHISQ.DIST.RT" | "CHIDIST" => BuiltinFunction::ChisqDistRT,
            "CHISQ.INV" => BuiltinFunction::ChisqInv,
            "CHISQ.INV.RT" | "CHIINV" => BuiltinFunction::ChisqInvRT,
            "CHISQ.TEST" | "CHITEST" => BuiltinFunction::ChisqTest,
            "F.DIST" | "FDIST" => BuiltinFunction::FDist,
            "F.DIST.RT" => BuiltinFunction::FDistRT,
            "F.INV" => BuiltinFunction::FInv,
            "F.INV.RT" | "FINV" => BuiltinFunction::FInvRT,
            "F.TEST" | "FTEST" => BuiltinFunction::FTest,
            "BINOM.DIST" | "BINOMDIST" => BuiltinFunction::BinomDist,
            "BINOM.INV" | "CRITBINOM" => BuiltinFunction::BinomInv,
            "BINOM.DIST.RANGE" => BuiltinFunction::BinomDistRange,
            "POISSON.DIST" | "POISSONDIST" => BuiltinFunction::PoissonDist,
            "BETA.DIST" | "BETADIST" => BuiltinFunction::BetaDist,
            "BETA.INV" | "BETAINV" => BuiltinFunction::BetaInv,
            "GAMMA.DIST" | "GAMMADIST" => BuiltinFunction::GammaDist,
            "GAMMA.INV" | "GAMMAINV" => BuiltinFunction::GammaInv,
            "GAMMA" => BuiltinFunction::GammaFn,
            "GAMMALN" | "GAMMALN.PRECISE" => BuiltinFunction::GammaLnFn,
            "WEIBULL.DIST" | "WEIBULL" => BuiltinFunction::WeibullDist,
            "EXPON.DIST" | "EXPONDIST" => BuiltinFunction::ExponDist,
            "LOGNORM.DIST" | "LOGNORMDIST" => BuiltinFunction::LognormDist,
            "LOGNORM.INV" | "LOGINV" => BuiltinFunction::LognormInv,
            "HYPGEOM.DIST" | "HYPGEOMDIST" => BuiltinFunction::HypgeomDist,
            "NEGBINOM.DIST" | "NEGBINOMDIST" => BuiltinFunction::NegbinomDist,
            "CONFIDENCE.NORM" => BuiltinFunction::ConfidenceNorm,
            "CONFIDENCE.T" => BuiltinFunction::ConfidenceT,

            // Descriptive/Analytical statistical functions
            "CORREL" => BuiltinFunction::Correl,
            "PEARSON" => BuiltinFunction::Pearson,
            "RSQ" => BuiltinFunction::Rsq,
            "SLOPE" => BuiltinFunction::Slope,
            "INTERCEPT" => BuiltinFunction::Intercept,
            "STEYX" => BuiltinFunction::Steyx,
            "COVARIANCE.P" | "COVAR" => BuiltinFunction::CovarianceP,
            "COVARIANCE.S" => BuiltinFunction::CovarianceS,
            "KURT" => BuiltinFunction::Kurt,
            "SKEW" => BuiltinFunction::Skew,
            "SKEW.P" => BuiltinFunction::SkewP,
            "AVEDEV" => BuiltinFunction::Avedev,
            "DEVSQ" => BuiltinFunction::Devsq,
            "GEOMEAN" => BuiltinFunction::Geomean,
            "HARMEAN" => BuiltinFunction::Harmean,
            "TRIMMEAN" => BuiltinFunction::Trimmean,
            "STANDARDIZE" => BuiltinFunction::Standardize,
            "PERCENTILE.EXC" => BuiltinFunction::PercentileExc,
            "PERCENTRANK.EXC" => BuiltinFunction::PercentRankExc,
            "QUARTILE.EXC" => BuiltinFunction::QuartileExc,
            "PROB" => BuiltinFunction::Prob,
            "FISHER" => BuiltinFunction::Fisher,
            "FISHERINV" => BuiltinFunction::FisherInv,
            "PERMUT" => BuiltinFunction::Permut,
            "PERMUTATIONA" => BuiltinFunction::PermutationA,
            "PHI" => BuiltinFunction::Phi,
            "GAUSS" => BuiltinFunction::Gauss,

            // Forecasting
            "FORECAST" | "FORECAST.LINEAR" => BuiltinFunction::ForecastLinear,
            "FORECAST.ETS" => BuiltinFunction::ForecastEts,
            "FORECAST.ETS.CONFINT" => BuiltinFunction::ForecastEtsConfint,
            "FORECAST.ETS.SEASONALITY" => BuiltinFunction::ForecastEtsSeason,
            "FORECAST.ETS.STAT" => BuiltinFunction::ForecastEtsStat,

            // Statistical version variants
            "AVERAGEA" => BuiltinFunction::AverageA,
            "MAXA" => BuiltinFunction::MaxA,
            "MINA" => BuiltinFunction::MinA,
            "STDEVA" => BuiltinFunction::StdevA,
            "STDEVPA" => BuiltinFunction::StdevPA,
            "VARA" => BuiltinFunction::VarA,
            "VARPA" => BuiltinFunction::VarPA,

            // Additional financial functions
            "IPMT" => BuiltinFunction::Ipmt,
            "PPMT" => BuiltinFunction::Ppmt,
            "FVSCHEDULE" => BuiltinFunction::FvSchedule,
            "XNPV" => BuiltinFunction::Xnpv,
            "XIRR" => BuiltinFunction::Xirr,
            "MIRR" => BuiltinFunction::Mirr,
            "SYD" => BuiltinFunction::Syd,
            "VDB" => BuiltinFunction::Vdb,
            "CUMIPMT" => BuiltinFunction::Cumipmt,
            "CUMPRINC" => BuiltinFunction::Cumprinc,
            "EFFECT" => BuiltinFunction::Effect,
            "NOMINAL" => BuiltinFunction::Nominal,

            // Bond & Security financial functions
            "ACCRINT" => BuiltinFunction::Accrint,
            "ACCRINTM" => BuiltinFunction::Accrintm,
            "PRICE" => BuiltinFunction::PriceFn,
            "PRICEDISC" => BuiltinFunction::PriceDisc,
            "PRICEMAT" => BuiltinFunction::PriceMat,
            "YIELD" => BuiltinFunction::YieldFn,
            "YIELDDISC" => BuiltinFunction::YieldDisc,
            "YIELDMAT" => BuiltinFunction::YieldMat,
            "DURATION" => BuiltinFunction::DurationFn,
            "MDURATION" => BuiltinFunction::Mduration,
            "DISC" => BuiltinFunction::Disc,
            "INTRATE" => BuiltinFunction::Intrate,
            "RECEIVED" => BuiltinFunction::Received,
            "COUPDAYBS" => BuiltinFunction::Coupdaybs,
            "COUPDAYS" => BuiltinFunction::Coupdays,
            "COUPDAYSNC" => BuiltinFunction::Coupdaysnc,
            "COUPNCD" => BuiltinFunction::Coupncd,
            "COUPNUM" => BuiltinFunction::Coupnum,
            "COUPPCD" => BuiltinFunction::Couppcd,

            // Treasury bill functions
            "TBILLEQ" => BuiltinFunction::TbillEq,
            "TBILLPRICE" => BuiltinFunction::TbillPrice,
            "TBILLYIELD" => BuiltinFunction::TbillYield,

            // Other financial functions
            "DOLLARDE" => BuiltinFunction::DollarDe,
            "DOLLARFR" => BuiltinFunction::DollarFr,
            "PDURATION" => BuiltinFunction::Pduration,
            "RRI" => BuiltinFunction::Rri,
            "ISPMT" => BuiltinFunction::Ispmt,
            "AMORDEGRC" => BuiltinFunction::Amordegrc,
            "AMORLINC" => BuiltinFunction::Amorlinc,
            "ODDFPRICE" => BuiltinFunction::OddfPrice,
            "ODDFYIELD" => BuiltinFunction::OddfYield,
            "ODDLPRICE" => BuiltinFunction::OddlPrice,
            "ODDLYIELD" => BuiltinFunction::OddlYield,

            // Modern lookup
            "XMATCH" => BuiltinFunction::XMatch,

            // Selection
            "CHOOSECOLS" => BuiltinFunction::ChooseCols,
            "CHOOSEROWS" => BuiltinFunction::ChooseRows,

            // Reference & Info
            "AREAS" => BuiltinFunction::Areas,
            "CELL" => BuiltinFunction::CellFn,
            "FORMULATEXT" => BuiltinFunction::FormulaText,

            // Lookup functions (legacy)
            "VLOOKUP" => BuiltinFunction::VLookup,
            "HLOOKUP" => BuiltinFunction::HLookup,
            "LOOKUP" => BuiltinFunction::Lookup,

            // Hyperbolic & reciprocal trig functions
            "SINH" => BuiltinFunction::Sinh,
            "COSH" => BuiltinFunction::Cosh,
            "TANH" => BuiltinFunction::Tanh,
            "COT" => BuiltinFunction::Cot,
            "COTH" => BuiltinFunction::Coth,
            "CSC" => BuiltinFunction::Csc,
            "CSCH" => BuiltinFunction::Csch,
            "SEC" => BuiltinFunction::Sec,
            "SECH" => BuiltinFunction::Sech,
            "ACOT" => BuiltinFunction::Acot,

            // Rounding variants
            "CEILING.MATH" => BuiltinFunction::CeilingMath,
            "CEILING.PRECISE" => BuiltinFunction::CeilingPrecise,
            "FLOOR.MATH" => BuiltinFunction::FloorMath,
            "FLOOR.PRECISE" => BuiltinFunction::FloorPrecise,
            "ISO.CEILING" => BuiltinFunction::IsoCeiling,

            // Additional math functions (Group 3)
            "MULTINOMIAL" => BuiltinFunction::Multinomial,
            "COMBINA" => BuiltinFunction::Combina,
            "FACTDOUBLE" => BuiltinFunction::FactDouble,
            "SQRTPI" => BuiltinFunction::SqrtPi,

            // Aggregate function
            "AGGREGATE" => BuiltinFunction::Aggregate,

            // Web functions
            "ENCODEURL" => BuiltinFunction::EncodeUrl,

            // Additional math functions
            "MROUND" => BuiltinFunction::MRound,
            "QUOTIENT" => BuiltinFunction::Quotient,
            "SUMSQ" => BuiltinFunction::SumSq,
            "ROMAN" => BuiltinFunction::Roman,
            "ARABIC" => BuiltinFunction::Arabic,
            "BASE" => BuiltinFunction::Base,
            "DECIMAL" => BuiltinFunction::Decimal,

            // Additional text functions
            "DOLLAR" => BuiltinFunction::Dollar,
            "EURO" => BuiltinFunction::Euro,
            "FIXED" => BuiltinFunction::Fixed,
            "UNICHAR" => BuiltinFunction::Unichar,
            "UNICODE" => BuiltinFunction::Unicode,

            // Additional information functions
            "ERROR.TYPE" => BuiltinFunction::ErrorType,
            "ISNONTEXT" => BuiltinFunction::IsNonText,
            "ISREF" => BuiltinFunction::IsRef,
            "SHEET" => BuiltinFunction::Sheet,
            "SHEETS" => BuiltinFunction::Sheets,

            // Engineering functions - Base conversion
            "BIN2DEC" => BuiltinFunction::Bin2Dec,
            "BIN2HEX" => BuiltinFunction::Bin2Hex,
            "BIN2OCT" => BuiltinFunction::Bin2Oct,
            "DEC2BIN" => BuiltinFunction::Dec2Bin,
            "DEC2HEX" => BuiltinFunction::Dec2Hex,
            "DEC2OCT" => BuiltinFunction::Dec2Oct,
            "HEX2BIN" => BuiltinFunction::Hex2Bin,
            "HEX2DEC" => BuiltinFunction::Hex2Dec,
            "HEX2OCT" => BuiltinFunction::Hex2Oct,
            "OCT2BIN" => BuiltinFunction::Oct2Bin,
            "OCT2DEC" => BuiltinFunction::Oct2Dec,
            "OCT2HEX" => BuiltinFunction::Oct2Hex,

            // Engineering functions - Bit operations
            "BITAND" => BuiltinFunction::BitAnd,
            "BITOR" => BuiltinFunction::BitOr,
            "BITXOR" => BuiltinFunction::BitXor,
            "BITLSHIFT" => BuiltinFunction::BitLShift,
            "BITRSHIFT" => BuiltinFunction::BitRShift,

            // Engineering functions - Complex numbers
            "COMPLEX" => BuiltinFunction::ComplexFn,
            "IMABS" => BuiltinFunction::ImAbs,
            "IMAGINARY" => BuiltinFunction::Imaginary,
            "IMREAL" => BuiltinFunction::ImReal,
            "IMARGUMENT" => BuiltinFunction::ImArgument,
            "IMCONJUGATE" => BuiltinFunction::ImConjugate,
            "IMCOS" => BuiltinFunction::ImCos,
            "IMCOSH" => BuiltinFunction::ImCosh,
            "IMCOT" => BuiltinFunction::ImCot,
            "IMCSC" => BuiltinFunction::ImCsc,
            "IMCSCH" => BuiltinFunction::ImCsch,
            "IMDIV" => BuiltinFunction::ImDiv,
            "IMEXP" => BuiltinFunction::ImExp,
            "IMLN" => BuiltinFunction::ImLn,
            "IMLOG10" => BuiltinFunction::ImLog10,
            "IMLOG2" => BuiltinFunction::ImLog2,
            "IMPOWER" => BuiltinFunction::ImPower,
            "IMPRODUCT" => BuiltinFunction::ImProduct,
            "IMSEC" => BuiltinFunction::ImSec,
            "IMSECH" => BuiltinFunction::ImSech,
            "IMSIN" => BuiltinFunction::ImSin,
            "IMSINH" => BuiltinFunction::ImSinh,
            "IMSQRT" => BuiltinFunction::ImSqrt,
            "IMSUB" => BuiltinFunction::ImSub,
            "IMSUM" => BuiltinFunction::ImSum,
            "IMTAN" => BuiltinFunction::ImTan,

            // Engineering functions - Bessel
            "BESSELI" => BuiltinFunction::BesselI,
            "BESSELJ" => BuiltinFunction::BesselJ,
            "BESSELK" => BuiltinFunction::BesselK,
            "BESSELY" => BuiltinFunction::BesselY,

            // Engineering functions - Other
            "CONVERT" => BuiltinFunction::ConvertFn,
            "DELTA" => BuiltinFunction::Delta,
            "ERF" => BuiltinFunction::Erf,
            "ERF.PRECISE" => BuiltinFunction::ErfPrecise,
            "ERFC" => BuiltinFunction::Erfc,
            "ERFC.PRECISE" => BuiltinFunction::ErfcPrecise,
            "GESTEP" => BuiltinFunction::Gestep,
            "SERIESSUM" => BuiltinFunction::SeriesSum,

            // Matrix functions
            "MMULT" => BuiltinFunction::Mmult,
            "MDETERM" => BuiltinFunction::Mdeterm,
            "MINVERSE" => BuiltinFunction::Minverse,
            "MUNIT" => BuiltinFunction::Munit,

            // Database functions
            "DAVERAGE" => BuiltinFunction::DAverage,
            "DCOUNT" => BuiltinFunction::DCount,
            "DCOUNTA" => BuiltinFunction::DCountA,
            "DGET" => BuiltinFunction::DGet,
            "DMAX" => BuiltinFunction::DMax,
            "DMIN" => BuiltinFunction::DMin,
            "DPRODUCT" => BuiltinFunction::DProduct,
            "DSTDEV" => BuiltinFunction::DStdev,
            "DSTDEVP" => BuiltinFunction::DStdevP,
            "DSUM" => BuiltinFunction::DSum,
            "DVAR" => BuiltinFunction::DVar,
            "DVARP" => BuiltinFunction::DVarP,

            // Array reshaping
            "EXPAND" => BuiltinFunction::Expand,
            "VSTACK" => BuiltinFunction::VStack,
            "TOCOL" => BuiltinFunction::ToCol,
            "TOROW" => BuiltinFunction::ToRow,
            "WRAPCOLS" => BuiltinFunction::WrapCols,
            "WRAPROWS" => BuiltinFunction::WrapRows,

            _ => BuiltinFunction::Custom(name.to_uppercase()),
        }
    }

    /// Returns (canonical_name, category) for every built-in function.
    /// This is the single source of truth for the autocomplete catalog.
    pub fn all_catalog_entries() -> Vec<(&'static str, &'static str)> {
        vec![
            // Aggregate functions (Math)
            ("SUM", "Math"),
            ("AVERAGE", "Math"),
            ("AVG", "Math"),
            ("MIN", "Math"),
            ("MAX", "Math"),
            ("COUNT", "Math"),
            ("COUNTA", "Math"),

            // Conditional aggregates (Math)
            ("SUMIF", "Math"),
            ("SUMIFS", "Math"),
            ("COUNTIF", "Math"),
            ("COUNTIFS", "Math"),
            ("AVERAGEIF", "Math"),
            ("AVERAGEIFS", "Math"),
            ("COUNTBLANK", "Math"),
            ("MINIFS", "Math"),
            ("MAXIFS", "Math"),

            // Logical functions
            ("IF", "Logical"),
            ("AND", "Logical"),
            ("OR", "Logical"),
            ("NOT", "Logical"),
            ("TRUE", "Logical"),
            ("FALSE", "Logical"),
            ("IFERROR", "Logical"),
            ("IFNA", "Logical"),
            ("IFS", "Logical"),
            ("SWITCH", "Logical"),
            ("XOR", "Logical"),

            // Math functions
            ("ABS", "Math"),
            ("ROUND", "Math"),
            ("FLOOR", "Math"),
            ("CEILING", "Math"),
            ("CEIL", "Math"),
            ("SQRT", "Math"),
            ("POWER", "Math"),
            ("POW", "Math"),
            ("MOD", "Math"),
            ("INT", "Math"),
            ("SIGN", "Math"),
            ("SUMPRODUCT", "Math"),
            ("SUMX2MY2", "Math"),
            ("SUMX2PY2", "Math"),
            ("SUMXMY2", "Math"),
            ("PRODUCT", "Math"),
            ("RAND", "Math"),
            ("RANDBETWEEN", "Math"),
            ("PI", "Math"),
            ("LOG", "Math"),
            ("LOG10", "Math"),
            ("LN", "Math"),
            ("EXP", "Math"),
            ("SIN", "Math"),
            ("COS", "Math"),
            ("TAN", "Math"),
            ("ASIN", "Math"),
            ("ACOS", "Math"),
            ("ATAN", "Math"),
            ("ATAN2", "Math"),
            ("ROUNDUP", "Math"),
            ("ROUNDDOWN", "Math"),
            ("TRUNC", "Math"),
            ("EVEN", "Math"),
            ("ODD", "Math"),
            ("GCD", "Math"),
            ("LCM", "Math"),
            ("COMBIN", "Math"),
            ("FACT", "Math"),
            ("FACTORIAL", "Math"),
            ("DEGREES", "Math"),
            ("RADIANS", "Math"),

            // Text functions
            ("LEN", "Text"),
            ("UPPER", "Text"),
            ("LOWER", "Text"),
            ("TRIM", "Text"),
            ("CONCATENATE", "Text"),
            ("CONCAT", "Text"),
            ("LEFT", "Text"),
            ("RIGHT", "Text"),
            ("MID", "Text"),
            ("REPT", "Text"),
            ("TEXT", "Text"),
            ("FIND", "Text"),
            ("SEARCH", "Text"),
            ("SUBSTITUTE", "Text"),
            ("REPLACE", "Text"),
            ("VALUE", "Text"),
            ("EXACT", "Text"),
            ("PROPER", "Text"),
            ("CHAR", "Text"),
            ("CODE", "Text"),
            ("CLEAN", "Text"),
            ("NUMBERVALUE", "Text"),
            ("T", "Text"),

            // Date & Time functions
            ("TODAY", "Date & Time"),
            ("NOW", "Date & Time"),
            ("DATE", "Date & Time"),
            ("YEAR", "Date & Time"),
            ("MONTH", "Date & Time"),
            ("DAY", "Date & Time"),
            ("HOUR", "Date & Time"),
            ("MINUTE", "Date & Time"),
            ("SECOND", "Date & Time"),
            ("DATEVALUE", "Date & Time"),
            ("TIMEVALUE", "Date & Time"),
            ("EDATE", "Date & Time"),
            ("EOMONTH", "Date & Time"),
            ("NETWORKDAYS", "Date & Time"),
            ("WORKDAY", "Date & Time"),
            ("DATEDIF", "Date & Time"),
            ("WEEKDAY", "Date & Time"),
            ("WEEKNUM", "Date & Time"),

            // Information functions
            ("ISNUMBER", "Information"),
            ("ISTEXT", "Information"),
            ("ISBLANK", "Information"),
            ("ISERROR", "Information"),
            ("ISNA", "Information"),
            ("ISERR", "Information"),
            ("ISLOGICAL", "Information"),
            ("ISODD", "Information"),
            ("ISEVEN", "Information"),
            ("TYPE", "Information"),
            ("N", "Information"),
            ("NA", "Information"),
            ("ISFORMULA", "Information"),

            // Lookup & Reference functions
            ("XLOOKUP", "Lookup & Reference"),
            ("XLOOKUPS", "Lookup & Reference"),
            ("INDEX", "Lookup & Reference"),
            ("MATCH", "Lookup & Reference"),
            ("CHOOSE", "Lookup & Reference"),
            ("INDIRECT", "Lookup & Reference"),
            ("OFFSET", "Lookup & Reference"),
            ("ADDRESS", "Lookup & Reference"),
            ("ROWS", "Lookup & Reference"),
            ("COLUMNS", "Lookup & Reference"),
            ("TRANSPOSE", "Lookup & Reference"),

            // Statistical functions
            ("MEDIAN", "Statistical"),
            ("STDEV", "Statistical"),
            ("STDEVP", "Statistical"),
            ("STDEV.P", "Statistical"),
            ("VAR", "Statistical"),
            ("VARP", "Statistical"),
            ("VAR.P", "Statistical"),
            ("LARGE", "Statistical"),
            ("SMALL", "Statistical"),
            ("RANK", "Statistical"),
            ("RANK.EQ", "Statistical"),
            ("PERCENTILE", "Statistical"),
            ("PERCENTILE.INC", "Statistical"),
            ("QUARTILE", "Statistical"),
            ("QUARTILE.INC", "Statistical"),
            ("MODE", "Statistical"),
            ("MODE.SNGL", "Statistical"),
            ("FREQUENCY", "Statistical"),

            // Financial functions
            ("PMT", "Financial"),
            ("PV", "Financial"),
            ("FV", "Financial"),
            ("NPV", "Financial"),
            ("IRR", "Financial"),
            ("RATE", "Financial"),
            ("NPER", "Financial"),
            ("SLN", "Financial"),
            ("DB", "Financial"),
            ("DDB", "Financial"),

            // UI GET functions
            ("GET.ROW.HEIGHT", "UI"),
            ("GETROWHEIGHT", "UI"),
            ("GET.COLUMN.WIDTH", "UI"),
            ("GETCOLUMNWIDTH", "UI"),
            ("GET.CELL.FILLCOLOR", "UI"),
            ("GETCELLFILLCOLOR", "UI"),

            // Reference functions
            ("ROW", "Lookup & Reference"),
            ("COLUMN", "Lookup & Reference"),

            // Advanced logical / lambda functions
            ("LET", "Logical"),
            ("TEXTJOIN", "Text"),
            ("LAMBDA", "Logical"),
            ("MAP", "Logical"),
            ("REDUCE", "Logical"),
            ("SCAN", "Logical"),
            ("MAKEARRAY", "Logical"),
            ("BYROW", "Logical"),
            ("BYCOL", "Logical"),

            // Dynamic array functions
            ("FILTER", "Dynamic Array"),
            ("SORT", "Dynamic Array"),
            ("SORTBY", "Dynamic Array"),
            ("UNIQUE", "Dynamic Array"),
            ("SEQUENCE", "Dynamic Array"),
            ("RANDARRAY", "Dynamic Array"),
            ("GROUPBY", "Dynamic Array"),
            ("PIVOTBY", "Dynamic Array"),
            ("GETPIVOTDATA", "Lookup & Reference"),

            // Collection functions (Dynamic Array)
            ("COLLECT", "Dynamic Array"),
            ("DICT", "Dynamic Array"),
            ("KEYS", "Dynamic Array"),
            ("VALUES", "Dynamic Array"),
            ("CONTAINS", "Dynamic Array"),
            ("ISLIST", "Dynamic Array"),
            ("ISDICT", "Dynamic Array"),
            ("FLATTEN", "Dynamic Array"),
            ("TAKE", "Dynamic Array"),
            ("DROP", "Dynamic Array"),
            ("APPEND", "Dynamic Array"),
            ("MERGE", "Dynamic Array"),
            ("HSTACK", "Dynamic Array"),

            // File functions
            ("FILEREAD", "File"),
            ("FILE.READ", "File"),
            ("FILELINES", "File"),
            ("FILE.LINES", "File"),
            ("FILEEXISTS", "File"),
            ("FILE.EXISTS", "File"),

            // Subtotal function
            ("SUBTOTAL", "Math"),

            // Text parsing/conversion
            ("TEXTSPLIT", "Text"),
            ("TEXTBEFORE", "Text"),
            ("TEXTAFTER", "Text"),
            ("VALUETOTEXT", "Text"),
            ("ARRAYTOTEXT", "Text"),

            // Additional date functions
            ("DAYS", "Date & Time"),
            ("TIME", "Date & Time"),
            ("DAYS360", "Date & Time"),
            ("YEARFRAC", "Date & Time"),
            ("ISOWEEKNUM", "Date & Time"),
            ("NETWORKDAYS.INTL", "Date & Time"),
            ("WORKDAY.INTL", "Date & Time"),

            // Additional statistical functions
            ("MODE.MULT", "Statistical"),
            ("STDEV.S", "Statistical"),
            ("VAR.S", "Statistical"),
            ("RANK.AVG", "Statistical"),
            ("PERCENTRANK", "Statistical"),
            ("PERCENTRANK.INC", "Statistical"),
            ("TREND", "Statistical"),
            ("GROWTH", "Statistical"),
            ("LINEST", "Statistical"),
            ("LOGEST", "Statistical"),

            // Probability distributions
            ("NORM.DIST", "Statistical"),
            ("NORMDIST", "Statistical"),
            ("NORM.INV", "Statistical"),
            ("NORMINV", "Statistical"),
            ("NORM.S.DIST", "Statistical"),
            ("NORMSDIST", "Statistical"),
            ("NORM.S.INV", "Statistical"),
            ("NORMSINV", "Statistical"),
            ("T.DIST", "Statistical"),
            ("TDIST", "Statistical"),
            ("T.DIST.2T", "Statistical"),
            ("T.DIST.RT", "Statistical"),
            ("T.INV", "Statistical"),
            ("T.INV.2T", "Statistical"),
            ("TINV", "Statistical"),
            ("T.TEST", "Statistical"),
            ("TTEST", "Statistical"),
            ("CHISQ.DIST", "Statistical"),
            ("CHISQDIST", "Statistical"),
            ("CHISQ.DIST.RT", "Statistical"),
            ("CHIDIST", "Statistical"),
            ("CHISQ.INV", "Statistical"),
            ("CHISQ.INV.RT", "Statistical"),
            ("CHIINV", "Statistical"),
            ("CHISQ.TEST", "Statistical"),
            ("CHITEST", "Statistical"),
            ("F.DIST", "Statistical"),
            ("FDIST", "Statistical"),
            ("F.DIST.RT", "Statistical"),
            ("F.INV", "Statistical"),
            ("F.INV.RT", "Statistical"),
            ("FINV", "Statistical"),
            ("F.TEST", "Statistical"),
            ("FTEST", "Statistical"),
            ("BINOM.DIST", "Statistical"),
            ("BINOMDIST", "Statistical"),
            ("BINOM.INV", "Statistical"),
            ("CRITBINOM", "Statistical"),
            ("BINOM.DIST.RANGE", "Statistical"),
            ("POISSON.DIST", "Statistical"),
            ("POISSONDIST", "Statistical"),
            ("BETA.DIST", "Statistical"),
            ("BETADIST", "Statistical"),
            ("BETA.INV", "Statistical"),
            ("BETAINV", "Statistical"),
            ("GAMMA.DIST", "Statistical"),
            ("GAMMADIST", "Statistical"),
            ("GAMMA.INV", "Statistical"),
            ("GAMMAINV", "Statistical"),
            ("GAMMA", "Statistical"),
            ("GAMMALN", "Statistical"),
            ("GAMMALN.PRECISE", "Statistical"),
            ("WEIBULL.DIST", "Statistical"),
            ("WEIBULL", "Statistical"),
            ("EXPON.DIST", "Statistical"),
            ("EXPONDIST", "Statistical"),
            ("LOGNORM.DIST", "Statistical"),
            ("LOGNORMDIST", "Statistical"),
            ("LOGNORM.INV", "Statistical"),
            ("LOGINV", "Statistical"),
            ("HYPGEOM.DIST", "Statistical"),
            ("HYPGEOMDIST", "Statistical"),
            ("NEGBINOM.DIST", "Statistical"),
            ("NEGBINOMDIST", "Statistical"),
            ("CONFIDENCE.NORM", "Statistical"),
            ("CONFIDENCE.T", "Statistical"),

            // Descriptive/Analytical statistical functions
            ("CORREL", "Statistical"),
            ("PEARSON", "Statistical"),
            ("RSQ", "Statistical"),
            ("SLOPE", "Statistical"),
            ("INTERCEPT", "Statistical"),
            ("STEYX", "Statistical"),
            ("COVARIANCE.P", "Statistical"),
            ("COVAR", "Statistical"),
            ("COVARIANCE.S", "Statistical"),
            ("KURT", "Statistical"),
            ("SKEW", "Statistical"),
            ("SKEW.P", "Statistical"),
            ("AVEDEV", "Statistical"),
            ("DEVSQ", "Statistical"),
            ("GEOMEAN", "Statistical"),
            ("HARMEAN", "Statistical"),
            ("TRIMMEAN", "Statistical"),
            ("STANDARDIZE", "Statistical"),
            ("PERCENTILE.EXC", "Statistical"),
            ("PERCENTRANK.EXC", "Statistical"),
            ("QUARTILE.EXC", "Statistical"),
            ("PROB", "Statistical"),
            ("FISHER", "Statistical"),
            ("FISHERINV", "Statistical"),
            ("PERMUT", "Statistical"),
            ("PERMUTATIONA", "Statistical"),
            ("PHI", "Statistical"),
            ("GAUSS", "Statistical"),

            // Forecasting
            ("FORECAST", "Statistical"),
            ("FORECAST.LINEAR", "Statistical"),
            ("FORECAST.ETS", "Statistical"),
            ("FORECAST.ETS.CONFINT", "Statistical"),
            ("FORECAST.ETS.SEASONALITY", "Statistical"),
            ("FORECAST.ETS.STAT", "Statistical"),

            // Statistical version variants
            ("AVERAGEA", "Statistical"),
            ("MAXA", "Statistical"),
            ("MINA", "Statistical"),
            ("STDEVA", "Statistical"),
            ("STDEVPA", "Statistical"),
            ("VARA", "Statistical"),
            ("VARPA", "Statistical"),

            // Additional financial functions
            ("IPMT", "Financial"),
            ("PPMT", "Financial"),
            ("FVSCHEDULE", "Financial"),
            ("XNPV", "Financial"),
            ("XIRR", "Financial"),
            ("MIRR", "Financial"),
            ("SYD", "Financial"),
            ("VDB", "Financial"),
            ("CUMIPMT", "Financial"),
            ("CUMPRINC", "Financial"),
            ("EFFECT", "Financial"),
            ("NOMINAL", "Financial"),

            // Bond & Security financial functions
            ("ACCRINT", "Financial"),
            ("ACCRINTM", "Financial"),
            ("PRICE", "Financial"),
            ("PRICEDISC", "Financial"),
            ("PRICEMAT", "Financial"),
            ("YIELD", "Financial"),
            ("YIELDDISC", "Financial"),
            ("YIELDMAT", "Financial"),
            ("DURATION", "Financial"),
            ("MDURATION", "Financial"),
            ("DISC", "Financial"),
            ("INTRATE", "Financial"),
            ("RECEIVED", "Financial"),
            ("COUPDAYBS", "Financial"),
            ("COUPDAYS", "Financial"),
            ("COUPDAYSNC", "Financial"),
            ("COUPNCD", "Financial"),
            ("COUPNUM", "Financial"),
            ("COUPPCD", "Financial"),

            // Treasury bill functions
            ("TBILLEQ", "Financial"),
            ("TBILLPRICE", "Financial"),
            ("TBILLYIELD", "Financial"),

            // Other financial functions
            ("DOLLARDE", "Financial"),
            ("DOLLARFR", "Financial"),
            ("PDURATION", "Financial"),
            ("RRI", "Financial"),
            ("ISPMT", "Financial"),
            ("AMORDEGRC", "Financial"),
            ("AMORLINC", "Financial"),
            ("ODDFPRICE", "Financial"),
            ("ODDFYIELD", "Financial"),
            ("ODDLPRICE", "Financial"),
            ("ODDLYIELD", "Financial"),

            // Modern lookup
            ("XMATCH", "Lookup & Reference"),

            // Selection
            ("CHOOSECOLS", "Lookup & Reference"),
            ("CHOOSEROWS", "Lookup & Reference"),

            // Reference & Info
            ("AREAS", "Lookup & Reference"),
            ("CELL", "Lookup & Reference"),
            ("FORMULATEXT", "Lookup & Reference"),

            // Lookup functions (legacy)
            ("VLOOKUP", "Lookup & Reference"),
            ("HLOOKUP", "Lookup & Reference"),
            ("LOOKUP", "Lookup & Reference"),

            // Hyperbolic & reciprocal trig functions
            ("SINH", "Math"),
            ("COSH", "Math"),
            ("TANH", "Math"),
            ("COT", "Math"),
            ("COTH", "Math"),
            ("CSC", "Math"),
            ("CSCH", "Math"),
            ("SEC", "Math"),
            ("SECH", "Math"),
            ("ACOT", "Math"),

            // Rounding variants
            ("CEILING.MATH", "Math"),
            ("CEILING.PRECISE", "Math"),
            ("FLOOR.MATH", "Math"),
            ("FLOOR.PRECISE", "Math"),
            ("ISO.CEILING", "Math"),

            // Additional math functions (Group 3)
            ("MULTINOMIAL", "Math"),
            ("COMBINA", "Math"),
            ("FACTDOUBLE", "Math"),
            ("SQRTPI", "Math"),

            // Aggregate function
            ("AGGREGATE", "Math"),

            // Web / Text functions
            ("ENCODEURL", "Text"),

            // Additional math functions
            ("MROUND", "Math"),
            ("QUOTIENT", "Math"),
            ("SUMSQ", "Math"),
            ("ROMAN", "Math"),
            ("ARABIC", "Math"),
            ("BASE", "Math"),
            ("DECIMAL", "Math"),

            // Additional text functions
            ("DOLLAR", "Text"),
            ("EURO", "Text"),
            ("FIXED", "Text"),
            ("UNICHAR", "Text"),
            ("UNICODE", "Text"),

            // Additional information functions
            ("ERROR.TYPE", "Information"),
            ("ISNONTEXT", "Information"),
            ("ISREF", "Information"),
            ("SHEET", "Information"),
            ("SHEETS", "Information"),

            // Engineering functions - Base conversion
            ("BIN2DEC", "Engineering"),
            ("BIN2HEX", "Engineering"),
            ("BIN2OCT", "Engineering"),
            ("DEC2BIN", "Engineering"),
            ("DEC2HEX", "Engineering"),
            ("DEC2OCT", "Engineering"),
            ("HEX2BIN", "Engineering"),
            ("HEX2DEC", "Engineering"),
            ("HEX2OCT", "Engineering"),
            ("OCT2BIN", "Engineering"),
            ("OCT2DEC", "Engineering"),
            ("OCT2HEX", "Engineering"),

            // Engineering functions - Bit operations
            ("BITAND", "Engineering"),
            ("BITOR", "Engineering"),
            ("BITXOR", "Engineering"),
            ("BITLSHIFT", "Engineering"),
            ("BITRSHIFT", "Engineering"),

            // Engineering functions - Complex numbers
            ("COMPLEX", "Engineering"),
            ("IMABS", "Engineering"),
            ("IMAGINARY", "Engineering"),
            ("IMREAL", "Engineering"),
            ("IMARGUMENT", "Engineering"),
            ("IMCONJUGATE", "Engineering"),
            ("IMCOS", "Engineering"),
            ("IMCOSH", "Engineering"),
            ("IMCOT", "Engineering"),
            ("IMCSC", "Engineering"),
            ("IMCSCH", "Engineering"),
            ("IMDIV", "Engineering"),
            ("IMEXP", "Engineering"),
            ("IMLN", "Engineering"),
            ("IMLOG10", "Engineering"),
            ("IMLOG2", "Engineering"),
            ("IMPOWER", "Engineering"),
            ("IMPRODUCT", "Engineering"),
            ("IMSEC", "Engineering"),
            ("IMSECH", "Engineering"),
            ("IMSIN", "Engineering"),
            ("IMSINH", "Engineering"),
            ("IMSQRT", "Engineering"),
            ("IMSUB", "Engineering"),
            ("IMSUM", "Engineering"),
            ("IMTAN", "Engineering"),

            // Engineering functions - Bessel
            ("BESSELI", "Engineering"),
            ("BESSELJ", "Engineering"),
            ("BESSELK", "Engineering"),
            ("BESSELY", "Engineering"),

            // Engineering functions - Other
            ("CONVERT", "Engineering"),
            ("DELTA", "Engineering"),
            ("ERF", "Engineering"),
            ("ERF.PRECISE", "Engineering"),
            ("ERFC", "Engineering"),
            ("ERFC.PRECISE", "Engineering"),
            ("GESTEP", "Engineering"),
            ("SERIESSUM", "Engineering"),

            // Matrix functions
            ("MMULT", "Matrix"),
            ("MDETERM", "Matrix"),
            ("MINVERSE", "Matrix"),
            ("MUNIT", "Matrix"),

            // Database functions
            ("DAVERAGE", "Database"),
            ("DCOUNT", "Database"),
            ("DCOUNTA", "Database"),
            ("DGET", "Database"),
            ("DMAX", "Database"),
            ("DMIN", "Database"),
            ("DPRODUCT", "Database"),
            ("DSTDEV", "Database"),
            ("DSTDEVP", "Database"),
            ("DSUM", "Database"),
            ("DVAR", "Database"),
            ("DVARP", "Database"),

            // Array reshaping (Dynamic Array)
            ("EXPAND", "Dynamic Array"),
            ("VSTACK", "Dynamic Array"),
            ("TOCOL", "Dynamic Array"),
            ("TOROW", "Dynamic Array"),
            ("WRAPCOLS", "Dynamic Array"),
            ("WRAPROWS", "Dynamic Array"),
        ]
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