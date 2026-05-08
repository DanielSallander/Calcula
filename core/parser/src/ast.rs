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

    /// Returns metadata for every built-in function.
    /// This is the **single source of truth** for the function catalog:
    /// name, category, syntax string, and description.
    ///
    /// To add a new function, add ONE entry here (plus the enum variant,
    /// `from_name()` match, and evaluator dispatch as usual).
    /// The template (e.g. `=SUM()`) is auto-generated from the syntax string.
    pub fn all_catalog_entries() -> Vec<FunctionMeta> {
        vec![
            // ================================================================
            // Aggregate functions (Math)
            // ================================================================
            FunctionMeta::new("SUM", "Math", "SUM(number1, [number2], ...)", "Adds all numbers in a range"),
            FunctionMeta::new("AVERAGE", "Math", "AVERAGE(number1, [number2], ...)", "Returns the average of numbers"),
            FunctionMeta::new("MIN", "Math", "MIN(number1, [number2], ...)", "Returns the smallest value"),
            FunctionMeta::new("MAX", "Math", "MAX(number1, [number2], ...)", "Returns the largest value"),
            FunctionMeta::new("COUNT", "Math", "COUNT(value1, [value2], ...)", "Counts cells containing numbers"),
            FunctionMeta::new("COUNTA", "Math", "COUNTA(value1, [value2], ...)", "Counts non-empty cells"),
            FunctionMeta::new("PRODUCT", "Math", "PRODUCT(number1, [number2], ...)", "Multiplies all the numbers given as arguments"),
            FunctionMeta::new("SUBTOTAL", "Math", "SUBTOTAL(function_num, ref1, [ref2], ...)", "Returns a subtotal in a list or database"),

            // Conditional aggregates (Math)
            FunctionMeta::new("SUMIF", "Math", "SUMIF(range, criteria, [sum_range])", "Sums cells that meet a condition"),
            FunctionMeta::new("SUMIFS", "Math", "SUMIFS(sum_range, criteria_range1, criteria1, ...)", "Sums cells that meet multiple conditions"),
            FunctionMeta::new("COUNTIF", "Math", "COUNTIF(range, criteria)", "Counts cells that meet a condition"),
            FunctionMeta::new("COUNTIFS", "Math", "COUNTIFS(criteria_range1, criteria1, ...)", "Counts cells that meet multiple conditions"),
            FunctionMeta::new("AVERAGEIF", "Math", "AVERAGEIF(range, criteria, [average_range])", "Averages cells that meet a condition"),
            FunctionMeta::new("AVERAGEIFS", "Math", "AVERAGEIFS(average_range, criteria_range1, criteria1, ...)", "Averages cells that meet multiple conditions"),
            FunctionMeta::new("COUNTBLANK", "Math", "COUNTBLANK(range)", "Counts empty cells in a range"),
            FunctionMeta::new("MINIFS", "Math", "MINIFS(min_range, criteria_range1, criteria1, ...)", "Returns the minimum value among cells that meet conditions"),
            FunctionMeta::new("MAXIFS", "Math", "MAXIFS(max_range, criteria_range1, criteria1, ...)", "Returns the maximum value among cells that meet conditions"),
            FunctionMeta::new("SUMPRODUCT", "Math", "SUMPRODUCT(array1, [array2], ...)", "Returns the sum of products of corresponding ranges"),
            FunctionMeta::new("SUMX2MY2", "Math", "SUMX2MY2(array_x, array_y)", "Returns the sum of the difference of squares of corresponding values"),
            FunctionMeta::new("SUMX2PY2", "Math", "SUMX2PY2(array_x, array_y)", "Returns the sum of the sum of squares of corresponding values"),
            FunctionMeta::new("SUMXMY2", "Math", "SUMXMY2(array_x, array_y)", "Returns the sum of squares of differences of corresponding values"),

            // ================================================================
            // Math functions
            // ================================================================
            FunctionMeta::new("ABS", "Math", "ABS(number)", "Returns absolute value"),
            FunctionMeta::new("ROUND", "Math", "ROUND(number, num_digits)", "Rounds a number"),
            FunctionMeta::new("ROUNDUP", "Math", "ROUNDUP(number, num_digits)", "Rounds a number up, away from zero"),
            FunctionMeta::new("ROUNDDOWN", "Math", "ROUNDDOWN(number, num_digits)", "Rounds a number down, toward zero"),
            FunctionMeta::new("FLOOR", "Math", "FLOOR(number, significance)", "Rounds a number down to the nearest multiple of significance"),
            FunctionMeta::new("CEILING", "Math", "CEILING(number, significance)", "Rounds a number up to the nearest multiple of significance"),
            FunctionMeta::new("SQRT", "Math", "SQRT(number)", "Square root"),
            FunctionMeta::new("POWER", "Math", "POWER(number, power)", "Raises to power"),
            FunctionMeta::new("MOD", "Math", "MOD(number, divisor)", "Returns remainder"),
            FunctionMeta::new("INT", "Math", "INT(number)", "Rounds down to the nearest integer"),
            FunctionMeta::new("SIGN", "Math", "SIGN(number)", "Returns the sign of a number"),
            FunctionMeta::new("TRUNC", "Math", "TRUNC(number, [num_digits])", "Truncates a number to an integer"),
            FunctionMeta::new("EVEN", "Math", "EVEN(number)", "Rounds up to the nearest even integer"),
            FunctionMeta::new("ODD", "Math", "ODD(number)", "Rounds up to the nearest odd integer"),
            FunctionMeta::new("GCD", "Math", "GCD(number1, number2, ...)", "Returns the greatest common divisor"),
            FunctionMeta::new("LCM", "Math", "LCM(number1, number2, ...)", "Returns the least common multiple"),
            FunctionMeta::new("COMBIN", "Math", "COMBIN(number, number_chosen)", "Returns the number of combinations"),
            FunctionMeta::new("COMBINA", "Math", "COMBINA(number, number_chosen)", "Returns the number of combinations with repetitions"),
            FunctionMeta::new("FACT", "Math", "FACT(number)", "Returns the factorial of a number"),
            FunctionMeta::new("FACTDOUBLE", "Math", "FACTDOUBLE(number)", "Returns the double factorial of a number"),
            FunctionMeta::new("MULTINOMIAL", "Math", "MULTINOMIAL(number1, [number2], ...)", "Returns the multinomial of a set of numbers"),
            FunctionMeta::new("PI", "Math", "PI()", "Returns the value of pi"),
            FunctionMeta::new("RAND", "Math", "RAND()", "Returns a random number between 0 and 1"),
            FunctionMeta::new("RANDBETWEEN", "Math", "RANDBETWEEN(bottom, top)", "Returns a random integer between two values"),
            FunctionMeta::new("LOG", "Math", "LOG(number, [base])", "Returns the logarithm of a number"),
            FunctionMeta::new("LOG10", "Math", "LOG10(number)", "Returns the base-10 logarithm"),
            FunctionMeta::new("LN", "Math", "LN(number)", "Returns the natural logarithm"),
            FunctionMeta::new("EXP", "Math", "EXP(number)", "Returns e raised to a power"),
            FunctionMeta::new("SIN", "Math", "SIN(number)", "Returns the sine of an angle"),
            FunctionMeta::new("COS", "Math", "COS(number)", "Returns the cosine of an angle"),
            FunctionMeta::new("TAN", "Math", "TAN(number)", "Returns the tangent of an angle"),
            FunctionMeta::new("ASIN", "Math", "ASIN(number)", "Returns the arcsine of a number"),
            FunctionMeta::new("ACOS", "Math", "ACOS(number)", "Returns the arccosine of a number"),
            FunctionMeta::new("ATAN", "Math", "ATAN(number)", "Returns the arctangent of a number"),
            FunctionMeta::new("ATAN2", "Math", "ATAN2(x_num, y_num)", "Returns the arctangent from x and y coordinates"),
            FunctionMeta::new("DEGREES", "Math", "DEGREES(angle)", "Converts radians to degrees"),
            FunctionMeta::new("RADIANS", "Math", "RADIANS(angle)", "Converts degrees to radians"),
            FunctionMeta::new("MROUND", "Math", "MROUND(number, multiple)", "Rounds a number to the nearest multiple"),
            FunctionMeta::new("QUOTIENT", "Math", "QUOTIENT(numerator, denominator)", "Returns the integer portion of a division"),
            FunctionMeta::new("SUMSQ", "Math", "SUMSQ(number1, [number2], ...)", "Returns the sum of the squares of the arguments"),
            FunctionMeta::new("ROMAN", "Math", "ROMAN(number, [form])", "Converts an Arabic numeral to Roman numeral text"),
            FunctionMeta::new("ARABIC", "Math", "ARABIC(text)", "Converts a Roman numeral text to an Arabic numeral"),
            FunctionMeta::new("BASE", "Math", "BASE(number, radix, [min_length])", "Converts a number into a text representation with the given radix"),
            FunctionMeta::new("DECIMAL", "Math", "DECIMAL(text, radix)", "Converts a text representation of a number in a given base to decimal"),
            FunctionMeta::new("SQRTPI", "Math", "SQRTPI(number)", "Returns the square root of (number * pi)"),
            FunctionMeta::new("AGGREGATE", "Math", "AGGREGATE(function_num, options, ref1, ...)", "Returns an aggregate in a list or database, with options to ignore errors and hidden rows"),

            // Hyperbolic & reciprocal trig
            FunctionMeta::new("SINH", "Math", "SINH(number)", "Returns the hyperbolic sine of a number"),
            FunctionMeta::new("COSH", "Math", "COSH(number)", "Returns the hyperbolic cosine of a number"),
            FunctionMeta::new("TANH", "Math", "TANH(number)", "Returns the hyperbolic tangent of a number"),
            FunctionMeta::new("COT", "Math", "COT(number)", "Returns the cotangent of an angle"),
            FunctionMeta::new("COTH", "Math", "COTH(number)", "Returns the hyperbolic cotangent of a number"),
            FunctionMeta::new("CSC", "Math", "CSC(number)", "Returns the cosecant of an angle"),
            FunctionMeta::new("CSCH", "Math", "CSCH(number)", "Returns the hyperbolic cosecant of a number"),
            FunctionMeta::new("SEC", "Math", "SEC(number)", "Returns the secant of an angle"),
            FunctionMeta::new("SECH", "Math", "SECH(number)", "Returns the hyperbolic secant of a number"),
            FunctionMeta::new("ACOT", "Math", "ACOT(number)", "Returns the arccotangent of a number"),

            // Rounding variants
            FunctionMeta::new("CEILING.MATH", "Math", "CEILING.MATH(number, [significance], [mode])", "Rounds a number up to the nearest integer or nearest multiple of significance"),
            FunctionMeta::new("CEILING.PRECISE", "Math", "CEILING.PRECISE(number, [significance])", "Rounds a number up to the nearest integer or nearest multiple of significance"),
            FunctionMeta::new("FLOOR.MATH", "Math", "FLOOR.MATH(number, [significance], [mode])", "Rounds a number down to the nearest integer or nearest multiple of significance"),
            FunctionMeta::new("FLOOR.PRECISE", "Math", "FLOOR.PRECISE(number, [significance])", "Rounds a number down to the nearest integer or nearest multiple of significance"),
            FunctionMeta::new("ISO.CEILING", "Math", "ISO.CEILING(number, [significance])", "Rounds a number up to the nearest integer or nearest multiple of significance"),

            // ================================================================
            // Logical functions
            // ================================================================
            FunctionMeta::new("IF", "Logical", "IF(condition, value_if_true, [value_if_false])", "Conditional logic"),
            FunctionMeta::new("AND", "Logical", "AND(logical1, [logical2], ...)", "TRUE if all arguments are TRUE"),
            FunctionMeta::new("OR", "Logical", "OR(logical1, [logical2], ...)", "TRUE if any argument is TRUE"),
            FunctionMeta::new("NOT", "Logical", "NOT(logical)", "Reverses the logic"),
            FunctionMeta::new("TRUE", "Logical", "TRUE()", "Returns the logical value TRUE"),
            FunctionMeta::new("FALSE", "Logical", "FALSE()", "Returns the logical value FALSE"),
            FunctionMeta::new("IFERROR", "Logical", "IFERROR(value, value_if_error)", "Returns value_if_error if expression is an error"),
            FunctionMeta::new("IFNA", "Logical", "IFNA(value, value_if_na)", "Returns value_if_na if expression is #N/A"),
            FunctionMeta::new("IFS", "Logical", "IFS(condition1, value1, [condition2, value2], ...)", "Checks multiple conditions and returns the first TRUE result"),
            FunctionMeta::new("SWITCH", "Logical", "SWITCH(expression, value1, result1, [value2, result2], ..., [default])", "Evaluates expression against a list of values and returns corresponding result"),
            FunctionMeta::new("XOR", "Logical", "XOR(logical1, [logical2], ...)", "Returns TRUE if an odd number of arguments are TRUE"),
            FunctionMeta::new("LET", "Logical", "LET(name1, name_value1, calculation_or_name2, [name_value2, calculation_or_name3], ...)", "Assigns names to calculation results to improve readability and performance"),
            FunctionMeta::new("LAMBDA", "Logical", "LAMBDA([parameter1, parameter2, ...], calculation)", "Creates a custom reusable function with parameters"),
            FunctionMeta::with_template("MAP", "Logical", "MAP(array, lambda)", "Returns an array by applying a LAMBDA to each value in an array", "=MAP(, LAMBDA(, ))"),
            FunctionMeta::with_template("REDUCE", "Logical", "REDUCE(initial_value, array, lambda)", "Reduces an array to a single value by applying a LAMBDA accumulator", "=REDUCE(, , LAMBDA(, , ))"),
            FunctionMeta::with_template("SCAN", "Logical", "SCAN(initial_value, array, lambda)", "Scans an array by applying a LAMBDA and returns an array of intermediate values", "=SCAN(, , LAMBDA(, , ))"),
            FunctionMeta::with_template("MAKEARRAY", "Logical", "MAKEARRAY(rows, cols, lambda)", "Returns an array of specified dimensions by applying a LAMBDA", "=MAKEARRAY(, , LAMBDA(, , ))"),
            FunctionMeta::with_template("BYROW", "Logical", "BYROW(array, lambda)", "Applies a LAMBDA to each row in an array and returns an array of results", "=BYROW(, LAMBDA(, ))"),
            FunctionMeta::with_template("BYCOL", "Logical", "BYCOL(array, lambda)", "Applies a LAMBDA to each column in an array and returns an array of results", "=BYCOL(, LAMBDA(, ))"),

            // ================================================================
            // Text functions
            // ================================================================
            FunctionMeta::new("CONCATENATE", "Text", "CONCATENATE(text1, [text2], ...)", "Joins text strings"),
            FunctionMeta::new("LEFT", "Text", "LEFT(text, [num_chars])", "Returns leftmost characters"),
            FunctionMeta::new("RIGHT", "Text", "RIGHT(text, [num_chars])", "Returns rightmost characters"),
            FunctionMeta::new("MID", "Text", "MID(text, start_num, num_chars)", "Returns characters from middle"),
            FunctionMeta::new("LEN", "Text", "LEN(text)", "Returns length of text"),
            FunctionMeta::new("UPPER", "Text", "UPPER(text)", "Converts to uppercase"),
            FunctionMeta::new("LOWER", "Text", "LOWER(text)", "Converts to lowercase"),
            FunctionMeta::new("TRIM", "Text", "TRIM(text)", "Removes extra spaces"),
            FunctionMeta::new("FIND", "Text", "FIND(find_text, within_text, [start_num])", "Finds text within another string (case-sensitive)"),
            FunctionMeta::new("SEARCH", "Text", "SEARCH(find_text, within_text, [start_num])", "Finds text within another string (case-insensitive, supports wildcards)"),
            FunctionMeta::new("SUBSTITUTE", "Text", "SUBSTITUTE(text, old_text, new_text, [instance_num])", "Substitutes new text for old text"),
            FunctionMeta::new("REPLACE", "Text", "REPLACE(old_text, start_num, num_chars, new_text)", "Replaces characters within text"),
            FunctionMeta::new("VALUE", "Text", "VALUE(text)", "Converts a text string to a number"),
            FunctionMeta::new("EXACT", "Text", "EXACT(text1, text2)", "Checks whether two text strings are exactly the same"),
            FunctionMeta::new("PROPER", "Text", "PROPER(text)", "Capitalizes the first letter of each word"),
            FunctionMeta::new("CHAR", "Text", "CHAR(number)", "Returns the character for a given code number"),
            FunctionMeta::new("CODE", "Text", "CODE(text)", "Returns the code number for the first character"),
            FunctionMeta::new("CLEAN", "Text", "CLEAN(text)", "Removes non-printable characters from text"),
            FunctionMeta::new("NUMBERVALUE", "Text", "NUMBERVALUE(text, [decimal_separator], [group_separator])", "Converts text to number with locale control"),
            FunctionMeta::new("T", "Text", "T(value)", "Returns text if value is text, empty string otherwise"),
            FunctionMeta::new("TEXT", "Text", "TEXT(value, format_text)", "Formats a number as text with a specified format"),
            FunctionMeta::new("REPT", "Text", "REPT(text, number_times)", "Repeats text a given number of times"),
            FunctionMeta::new("TEXTJOIN", "Text", "TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)", "Combines text from multiple ranges with a specified delimiter"),
            FunctionMeta::new("DOLLAR", "Text", "DOLLAR(number, [decimals])", "Converts a number to text using currency format"),
            FunctionMeta::new("EURO", "Text", "EURO(number, [decimals])", "Converts a number to text using euro currency format"),
            FunctionMeta::new("FIXED", "Text", "FIXED(number, [decimals], [no_commas])", "Formats a number as text with a fixed number of decimals"),
            FunctionMeta::new("UNICHAR", "Text", "UNICHAR(number)", "Returns the Unicode character for a given number"),
            FunctionMeta::new("UNICODE", "Text", "UNICODE(text)", "Returns the Unicode code point for the first character of text"),
            FunctionMeta::new("ENCODEURL", "Text", "ENCODEURL(text)", "Returns a URL-encoded string"),
            FunctionMeta::new("TEXTSPLIT", "Text", "TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with])", "Splits text into rows or columns"),
            FunctionMeta::new("TEXTBEFORE", "Text", "TEXTBEFORE(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])", "Returns text before a delimiter"),
            FunctionMeta::new("TEXTAFTER", "Text", "TEXTAFTER(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])", "Returns text after a delimiter"),
            FunctionMeta::new("VALUETOTEXT", "Text", "VALUETOTEXT(value, [format])", "Converts a value to text"),
            FunctionMeta::new("ARRAYTOTEXT", "Text", "ARRAYTOTEXT(array, [format])", "Converts an array to text"),

            // ================================================================
            // Date & Time functions
            // ================================================================
            FunctionMeta::new("TODAY", "Date & Time", "TODAY()", "Returns the current date as a serial number"),
            FunctionMeta::new("NOW", "Date & Time", "NOW()", "Returns the current date and time as a serial number"),
            FunctionMeta::new("DATE", "Date & Time", "DATE(year, month, day)", "Creates a date serial number from year, month, day"),
            FunctionMeta::new("YEAR", "Date & Time", "YEAR(serial_number)", "Returns the year from a date"),
            FunctionMeta::new("MONTH", "Date & Time", "MONTH(serial_number)", "Returns the month from a date"),
            FunctionMeta::new("DAY", "Date & Time", "DAY(serial_number)", "Returns the day from a date"),
            FunctionMeta::new("HOUR", "Date & Time", "HOUR(serial_number)", "Returns the hour from a time value"),
            FunctionMeta::new("MINUTE", "Date & Time", "MINUTE(serial_number)", "Returns the minute from a time value"),
            FunctionMeta::new("SECOND", "Date & Time", "SECOND(serial_number)", "Returns the second from a time value"),
            FunctionMeta::new("DATEVALUE", "Date & Time", "DATEVALUE(date_text)", "Converts a date string to a serial number"),
            FunctionMeta::new("TIMEVALUE", "Date & Time", "TIMEVALUE(time_text)", "Converts a time string to a decimal number"),
            FunctionMeta::new("EDATE", "Date & Time", "EDATE(start_date, months)", "Returns the date that is the indicated number of months before or after a date"),
            FunctionMeta::new("EOMONTH", "Date & Time", "EOMONTH(start_date, months)", "Returns the last day of the month a given number of months before or after a date"),
            FunctionMeta::new("NETWORKDAYS", "Date & Time", "NETWORKDAYS(start_date, end_date, [holidays])", "Returns the number of working days between two dates"),
            FunctionMeta::new("WORKDAY", "Date & Time", "WORKDAY(start_date, days, [holidays])", "Returns the date a given number of working days from a date"),
            FunctionMeta::new("DATEDIF", "Date & Time", "DATEDIF(start_date, end_date, unit)", "Calculates the difference between two dates"),
            FunctionMeta::new("WEEKDAY", "Date & Time", "WEEKDAY(serial_number, [return_type])", "Returns the day of the week"),
            FunctionMeta::new("WEEKNUM", "Date & Time", "WEEKNUM(serial_number, [return_type])", "Returns the week number of a date"),
            FunctionMeta::new("DAYS", "Date & Time", "DAYS(end_date, start_date)", "Returns the number of days between two dates"),
            FunctionMeta::new("TIME", "Date & Time", "TIME(hour, minute, second)", "Returns a time value from hour, minute, and second components"),
            FunctionMeta::new("DAYS360", "Date & Time", "DAYS360(start_date, end_date, [method])", "Returns the number of days between two dates based on a 360-day year"),
            FunctionMeta::new("YEARFRAC", "Date & Time", "YEARFRAC(start_date, end_date, [basis])", "Returns the year fraction representing the number of whole days"),
            FunctionMeta::new("ISOWEEKNUM", "Date & Time", "ISOWEEKNUM(date)", "Returns the ISO week number of the year for a given date"),
            FunctionMeta::new("NETWORKDAYS.INTL", "Date & Time", "NETWORKDAYS.INTL(start_date, end_date, [weekend], [holidays])", "Returns the number of working days with custom weekends"),
            FunctionMeta::new("WORKDAY.INTL", "Date & Time", "WORKDAY.INTL(start_date, days, [weekend], [holidays])", "Returns the date after a given number of working days with custom weekends"),

            // ================================================================
            // Information functions
            // ================================================================
            FunctionMeta::new("ISNUMBER", "Information", "ISNUMBER(value)", "Checks if value is number"),
            FunctionMeta::new("ISTEXT", "Information", "ISTEXT(value)", "Checks if value is text"),
            FunctionMeta::new("ISBLANK", "Information", "ISBLANK(value)", "Checks if cell is empty"),
            FunctionMeta::new("ISERROR", "Information", "ISERROR(value)", "Checks if value is error"),
            FunctionMeta::new("ISNA", "Information", "ISNA(value)", "Checks if value is #N/A"),
            FunctionMeta::new("ISERR", "Information", "ISERR(value)", "Checks if value is an error other than #N/A"),
            FunctionMeta::new("ISLOGICAL", "Information", "ISLOGICAL(value)", "Checks if value is TRUE or FALSE"),
            FunctionMeta::new("ISODD", "Information", "ISODD(number)", "Checks if a number is odd"),
            FunctionMeta::new("ISEVEN", "Information", "ISEVEN(number)", "Checks if a number is even"),
            FunctionMeta::new("ISFORMULA", "Information", "ISFORMULA(reference)", "Checks if a cell contains a formula"),
            FunctionMeta::new("TYPE", "Information", "TYPE(value)", "Returns the type of a value (1=number, 2=text, 4=logical, 16=error)"),
            FunctionMeta::new("N", "Information", "N(value)", "Returns a value converted to a number"),
            FunctionMeta::new("NA", "Information", "NA()", "Returns the #N/A error value"),
            FunctionMeta::new("ERROR.TYPE", "Information", "ERROR.TYPE(error_val)", "Returns a number corresponding to the error type"),
            FunctionMeta::new("ISNONTEXT", "Information", "ISNONTEXT(value)", "Returns TRUE if the value is not text"),
            FunctionMeta::new("ISREF", "Information", "ISREF(value)", "Returns TRUE if the value is a reference"),
            FunctionMeta::new("SHEET", "Information", "SHEET([value])", "Returns the sheet number of the referenced sheet"),
            FunctionMeta::new("SHEETS", "Information", "SHEETS([reference])", "Returns the number of sheets in a reference or workbook"),

            // ================================================================
            // Lookup & Reference functions
            // ================================================================
            FunctionMeta::new("XLOOKUP", "Lookup & Reference", "XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])", "Searches a range or array and returns the corresponding item"),
            FunctionMeta::new("XLOOKUPS", "Lookup & Reference", "XLOOKUPS(lookup_value1, lookup_array1, [lookup_value2, lookup_array2, ...], return_array, [match_mode], [search_mode])", "Multi-criteria lookup: searches multiple arrays simultaneously"),
            FunctionMeta::new("VLOOKUP", "Lookup & Reference", "VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])", "Looks up a value in the first column of a table and returns a value in the same row"),
            FunctionMeta::new("HLOOKUP", "Lookup & Reference", "HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])", "Looks up a value in the first row of a table and returns a value in the same column"),
            FunctionMeta::new("LOOKUP", "Lookup & Reference", "LOOKUP(lookup_value, lookup_vector, [result_vector])", "Looks up a value in a one-row or one-column range"),
            FunctionMeta::new("INDEX", "Lookup & Reference", "INDEX(array, row_num, [column_num])", "Returns a value at a given position in a range"),
            FunctionMeta::new("MATCH", "Lookup & Reference", "MATCH(lookup_value, lookup_array, [match_type])", "Returns the position of a value in a range"),
            FunctionMeta::new("XMATCH", "Lookup & Reference", "XMATCH(lookup_value, lookup_array, [match_mode], [search_mode])", "Searches for a specified item and returns its relative position"),
            FunctionMeta::new("CHOOSE", "Lookup & Reference", "CHOOSE(index_num, value1, [value2], ...)", "Returns a value from a list based on index"),
            FunctionMeta::new("CHOOSECOLS", "Lookup & Reference", "CHOOSECOLS(array, col_num1, [col_num2], ...)", "Returns specified columns from an array"),
            FunctionMeta::new("CHOOSEROWS", "Lookup & Reference", "CHOOSEROWS(array, row_num1, [row_num2], ...)", "Returns specified rows from an array"),
            FunctionMeta::new("INDIRECT", "Lookup & Reference", "INDIRECT(ref_text, [a1])", "Returns the reference specified by a text string"),
            FunctionMeta::new("OFFSET", "Lookup & Reference", "OFFSET(reference, rows, cols, [height], [width])", "Returns a reference offset from a given reference"),
            FunctionMeta::new("ADDRESS", "Lookup & Reference", "ADDRESS(row_num, column_num, [abs_num], [a1], [sheet_text])", "Creates a cell address as text"),
            FunctionMeta::new("ROW", "Lookup & Reference", "ROW([cell_ref])", "Returns the row number of a cell reference"),
            FunctionMeta::new("COLUMN", "Lookup & Reference", "COLUMN([cell_ref])", "Returns the column number of a cell reference"),
            FunctionMeta::new("ROWS", "Lookup & Reference", "ROWS(array)", "Returns the number of rows in a reference"),
            FunctionMeta::new("COLUMNS", "Lookup & Reference", "COLUMNS(array)", "Returns the number of columns in a reference"),
            FunctionMeta::new("TRANSPOSE", "Lookup & Reference", "TRANSPOSE(array)", "Returns the transpose of an array"),
            FunctionMeta::new("GETPIVOTDATA", "Lookup & Reference", "GETPIVOTDATA(data_field, pivot_table, [field1, item1], ...)", "Retrieves data from a pivot table"),
            FunctionMeta::new("AREAS", "Lookup & Reference", "AREAS(reference)", "Returns the number of areas in a reference"),
            FunctionMeta::new("CELL", "Lookup & Reference", "CELL(info_type, [reference])", "Returns information about a cell"),
            FunctionMeta::new("FORMULATEXT", "Lookup & Reference", "FORMULATEXT(reference)", "Returns a formula as text"),

            // ================================================================
            // Statistical functions
            // ================================================================
            FunctionMeta::new("MEDIAN", "Statistical", "MEDIAN(number1, [number2], ...)", "Returns the median of the given numbers"),
            FunctionMeta::new("STDEV", "Statistical", "STDEV(number1, [number2], ...)", "Estimates standard deviation based on a sample"),
            FunctionMeta::new("STDEVP", "Statistical", "STDEVP(number1, [number2], ...)", "Calculates standard deviation based on the entire population"),
            FunctionMeta::new("VAR", "Statistical", "VAR(number1, [number2], ...)", "Estimates variance based on a sample"),
            FunctionMeta::new("VARP", "Statistical", "VARP(number1, [number2], ...)", "Calculates variance based on the entire population"),
            FunctionMeta::new("LARGE", "Statistical", "LARGE(array, k)", "Returns the k-th largest value in a data set"),
            FunctionMeta::new("SMALL", "Statistical", "SMALL(array, k)", "Returns the k-th smallest value in a data set"),
            FunctionMeta::new("RANK", "Statistical", "RANK(number, ref, [order])", "Returns the rank of a number in a list of numbers"),
            FunctionMeta::new("PERCENTILE", "Statistical", "PERCENTILE(array, k)", "Returns the k-th percentile of values in a range"),
            FunctionMeta::new("QUARTILE", "Statistical", "QUARTILE(array, quart)", "Returns the quartile of a data set"),
            FunctionMeta::new("MODE", "Statistical", "MODE(number1, [number2], ...)", "Returns the most frequently occurring value"),
            FunctionMeta::new("FREQUENCY", "Statistical", "FREQUENCY(data_array, bins_array)", "Returns a frequency distribution as a vertical array"),
            // Dot-style aliases
            FunctionMeta::new("STDEV.P", "Statistical", "STDEV.P(number1, [number2], ...)", "Calculates standard deviation based on the entire population"),
            FunctionMeta::new("STDEV.S", "Statistical", "STDEV.S(number1, [number2], ...)", "Estimates standard deviation based on a sample"),
            FunctionMeta::new("VAR.P", "Statistical", "VAR.P(number1, [number2], ...)", "Calculates variance based on the entire population"),
            FunctionMeta::new("VAR.S", "Statistical", "VAR.S(number1, [number2], ...)", "Estimates variance based on a sample"),
            FunctionMeta::new("RANK.EQ", "Statistical", "RANK.EQ(number, ref, [order])", "Returns the rank of a number in a list"),
            FunctionMeta::new("RANK.AVG", "Statistical", "RANK.AVG(number, ref, [order])", "Returns the rank of a number, averaging tied values"),
            FunctionMeta::new("PERCENTILE.INC", "Statistical", "PERCENTILE.INC(array, k)", "Returns the k-th percentile of values (inclusive)"),
            FunctionMeta::new("PERCENTILE.EXC", "Statistical", "PERCENTILE.EXC(array, k)", "Returns the k-th percentile of values (exclusive)"),
            FunctionMeta::new("QUARTILE.INC", "Statistical", "QUARTILE.INC(array, quart)", "Returns the quartile of a data set (inclusive)"),
            FunctionMeta::new("QUARTILE.EXC", "Statistical", "QUARTILE.EXC(array, quart)", "Returns the quartile of a data set (exclusive)"),
            FunctionMeta::new("MODE.SNGL", "Statistical", "MODE.SNGL(number1, [number2], ...)", "Returns the most frequently occurring value"),
            FunctionMeta::new("MODE.MULT", "Statistical", "MODE.MULT(number1, [number2], ...)", "Returns a vertical array of the most frequently occurring values"),
            FunctionMeta::new("PERCENTRANK", "Statistical", "PERCENTRANK(array, x, [significance])", "Returns the percentage rank of a value in a data set"),
            FunctionMeta::new("PERCENTRANK.INC", "Statistical", "PERCENTRANK.INC(array, x, [significance])", "Returns the percentage rank of a value (inclusive)"),
            FunctionMeta::new("PERCENTRANK.EXC", "Statistical", "PERCENTRANK.EXC(array, x, [significance])", "Returns the percentage rank of a value (exclusive)"),
            // Regression & Correlation
            FunctionMeta::new("TREND", "Statistical", "TREND(known_y, [known_x], [new_x], [const])", "Returns values along a linear trend"),
            FunctionMeta::new("GROWTH", "Statistical", "GROWTH(known_y, [known_x], [new_x], [const])", "Returns values along an exponential trend"),
            FunctionMeta::new("LINEST", "Statistical", "LINEST(known_y, [known_x], [const], [stats])", "Returns the parameters of a linear trend"),
            FunctionMeta::new("LOGEST", "Statistical", "LOGEST(known_y, [known_x], [const], [stats])", "Returns the parameters of an exponential trend"),
            FunctionMeta::new("CORREL", "Statistical", "CORREL(array1, array2)", "Returns the correlation coefficient"),
            FunctionMeta::new("PEARSON", "Statistical", "PEARSON(array1, array2)", "Returns the Pearson product moment correlation coefficient"),
            FunctionMeta::new("RSQ", "Statistical", "RSQ(known_y, known_x)", "Returns the square of the Pearson correlation coefficient"),
            FunctionMeta::new("SLOPE", "Statistical", "SLOPE(known_y, known_x)", "Returns the slope of the linear regression line"),
            FunctionMeta::new("INTERCEPT", "Statistical", "INTERCEPT(known_y, known_x)", "Returns the intercept of the linear regression line"),
            FunctionMeta::new("STEYX", "Statistical", "STEYX(known_y, known_x)", "Returns the standard error of the predicted y-value"),
            FunctionMeta::new("COVARIANCE.P", "Statistical", "COVARIANCE.P(array1, array2)", "Returns population covariance"),
            FunctionMeta::new("COVARIANCE.S", "Statistical", "COVARIANCE.S(array1, array2)", "Returns sample covariance"),
            FunctionMeta::new("COVAR", "Statistical", "COVAR(array1, array2)", "Returns covariance"),
            // Descriptive statistics
            FunctionMeta::new("KURT", "Statistical", "KURT(number1, [number2], ...)", "Returns the kurtosis of a data set"),
            FunctionMeta::new("SKEW", "Statistical", "SKEW(number1, [number2], ...)", "Returns the skewness of a distribution"),
            FunctionMeta::new("SKEW.P", "Statistical", "SKEW.P(number1, [number2], ...)", "Returns the population skewness of a distribution"),
            FunctionMeta::new("AVEDEV", "Statistical", "AVEDEV(number1, [number2], ...)", "Returns the average of absolute deviations"),
            FunctionMeta::new("DEVSQ", "Statistical", "DEVSQ(number1, [number2], ...)", "Returns the sum of squares of deviations"),
            FunctionMeta::new("GEOMEAN", "Statistical", "GEOMEAN(number1, [number2], ...)", "Returns the geometric mean"),
            FunctionMeta::new("HARMEAN", "Statistical", "HARMEAN(number1, [number2], ...)", "Returns the harmonic mean"),
            FunctionMeta::new("TRIMMEAN", "Statistical", "TRIMMEAN(array, percent)", "Returns the mean of the interior of a data set"),
            FunctionMeta::new("STANDARDIZE", "Statistical", "STANDARDIZE(x, mean, standard_dev)", "Returns a normalized value"),
            FunctionMeta::new("PROB", "Statistical", "PROB(x_range, prob_range, lower_limit, [upper_limit])", "Returns the probability that values are between two limits"),
            FunctionMeta::new("FISHER", "Statistical", "FISHER(x)", "Returns the Fisher transformation"),
            FunctionMeta::new("FISHERINV", "Statistical", "FISHERINV(y)", "Returns the inverse of the Fisher transformation"),
            FunctionMeta::new("PERMUT", "Statistical", "PERMUT(number, number_chosen)", "Returns the number of permutations"),
            FunctionMeta::new("PERMUTATIONA", "Statistical", "PERMUTATIONA(number, number_chosen)", "Returns the number of permutations with repetition"),
            FunctionMeta::new("PHI", "Statistical", "PHI(x)", "Returns the value of the density function for a standard normal distribution"),
            FunctionMeta::new("GAUSS", "Statistical", "GAUSS(z)", "Returns 0.5 less than the standard normal cumulative distribution"),
            // Probability distributions
            FunctionMeta::new("NORM.DIST", "Statistical", "NORM.DIST(x, mean, standard_dev, cumulative)", "Returns the normal distribution"),
            FunctionMeta::new("NORM.INV", "Statistical", "NORM.INV(probability, mean, standard_dev)", "Returns the inverse of the normal distribution"),
            FunctionMeta::new("NORM.S.DIST", "Statistical", "NORM.S.DIST(z, cumulative)", "Returns the standard normal distribution"),
            FunctionMeta::new("NORM.S.INV", "Statistical", "NORM.S.INV(probability)", "Returns the inverse of the standard normal distribution"),
            FunctionMeta::new("T.DIST", "Statistical", "T.DIST(x, degrees_freedom, cumulative)", "Returns the Student's t-distribution"),
            FunctionMeta::new("T.DIST.2T", "Statistical", "T.DIST.2T(x, degrees_freedom)", "Returns the two-tailed Student's t-distribution"),
            FunctionMeta::new("T.DIST.RT", "Statistical", "T.DIST.RT(x, degrees_freedom)", "Returns the right-tailed Student's t-distribution"),
            FunctionMeta::new("T.INV", "Statistical", "T.INV(probability, degrees_freedom)", "Returns the left-tailed inverse of the Student's t-distribution"),
            FunctionMeta::new("T.INV.2T", "Statistical", "T.INV.2T(probability, degrees_freedom)", "Returns the two-tailed inverse of the Student's t-distribution"),
            FunctionMeta::new("T.TEST", "Statistical", "T.TEST(array1, array2, tails, type)", "Returns the probability associated with a Student's t-test"),
            FunctionMeta::new("CHISQ.DIST", "Statistical", "CHISQ.DIST(x, degrees_freedom, cumulative)", "Returns the chi-squared distribution"),
            FunctionMeta::new("CHISQ.DIST.RT", "Statistical", "CHISQ.DIST.RT(x, degrees_freedom)", "Returns the right-tailed chi-squared distribution"),
            FunctionMeta::new("CHISQ.INV", "Statistical", "CHISQ.INV(probability, degrees_freedom)", "Returns the inverse of the chi-squared distribution"),
            FunctionMeta::new("CHISQ.INV.RT", "Statistical", "CHISQ.INV.RT(probability, degrees_freedom)", "Returns the inverse of the right-tailed chi-squared distribution"),
            FunctionMeta::new("CHISQ.TEST", "Statistical", "CHISQ.TEST(actual_range, expected_range)", "Returns the chi-squared test for independence"),
            FunctionMeta::new("F.DIST", "Statistical", "F.DIST(x, degrees_freedom1, degrees_freedom2, cumulative)", "Returns the F probability distribution"),
            FunctionMeta::new("F.DIST.RT", "Statistical", "F.DIST.RT(x, degrees_freedom1, degrees_freedom2)", "Returns the right-tailed F distribution"),
            FunctionMeta::new("F.INV", "Statistical", "F.INV(probability, degrees_freedom1, degrees_freedom2)", "Returns the inverse of the F distribution"),
            FunctionMeta::new("F.INV.RT", "Statistical", "F.INV.RT(probability, degrees_freedom1, degrees_freedom2)", "Returns the inverse of the right-tailed F distribution"),
            FunctionMeta::new("F.TEST", "Statistical", "F.TEST(array1, array2)", "Returns the result of an F-test"),
            FunctionMeta::new("BINOM.DIST", "Statistical", "BINOM.DIST(number_s, trials, probability_s, cumulative)", "Returns the binomial distribution probability"),
            FunctionMeta::new("BINOM.INV", "Statistical", "BINOM.INV(trials, probability_s, alpha)", "Returns the smallest value for which the binomial distribution is >= alpha"),
            FunctionMeta::new("BINOM.DIST.RANGE", "Statistical", "BINOM.DIST.RANGE(trials, probability_s, number_s, [number_s2])", "Returns the probability of a trial result"),
            FunctionMeta::new("POISSON.DIST", "Statistical", "POISSON.DIST(x, mean, cumulative)", "Returns the Poisson distribution"),
            FunctionMeta::new("BETA.DIST", "Statistical", "BETA.DIST(x, alpha, beta, cumulative, [A], [B])", "Returns the beta distribution"),
            FunctionMeta::new("BETA.INV", "Statistical", "BETA.INV(probability, alpha, beta, [A], [B])", "Returns the inverse of the beta distribution"),
            FunctionMeta::new("GAMMA.DIST", "Statistical", "GAMMA.DIST(x, alpha, beta, cumulative)", "Returns the gamma distribution"),
            FunctionMeta::new("GAMMA.INV", "Statistical", "GAMMA.INV(probability, alpha, beta)", "Returns the inverse of the gamma distribution"),
            FunctionMeta::new("GAMMA", "Statistical", "GAMMA(number)", "Returns the Gamma function value"),
            FunctionMeta::new("GAMMALN", "Statistical", "GAMMALN(x)", "Returns the natural logarithm of the gamma function"),
            FunctionMeta::new("GAMMALN.PRECISE", "Statistical", "GAMMALN.PRECISE(x)", "Returns the natural logarithm of the gamma function"),
            FunctionMeta::new("WEIBULL.DIST", "Statistical", "WEIBULL.DIST(x, alpha, beta, cumulative)", "Returns the Weibull distribution"),
            FunctionMeta::new("EXPON.DIST", "Statistical", "EXPON.DIST(x, lambda, cumulative)", "Returns the exponential distribution"),
            FunctionMeta::new("LOGNORM.DIST", "Statistical", "LOGNORM.DIST(x, mean, standard_dev, cumulative)", "Returns the lognormal distribution"),
            FunctionMeta::new("LOGNORM.INV", "Statistical", "LOGNORM.INV(probability, mean, standard_dev)", "Returns the inverse of the lognormal distribution"),
            FunctionMeta::new("HYPGEOM.DIST", "Statistical", "HYPGEOM.DIST(sample_s, number_sample, population_s, number_pop, cumulative)", "Returns the hypergeometric distribution"),
            FunctionMeta::new("NEGBINOM.DIST", "Statistical", "NEGBINOM.DIST(number_f, number_s, probability_s, cumulative)", "Returns the negative binomial distribution"),
            FunctionMeta::new("CONFIDENCE.NORM", "Statistical", "CONFIDENCE.NORM(alpha, standard_dev, size)", "Returns the confidence interval for a population mean (normal distribution)"),
            FunctionMeta::new("CONFIDENCE.T", "Statistical", "CONFIDENCE.T(alpha, standard_dev, size)", "Returns the confidence interval for a population mean (Student's t-distribution)"),
            // Forecasting
            FunctionMeta::new("FORECAST", "Statistical", "FORECAST(x, known_y, known_x)", "Calculates a future value along a linear trend"),
            FunctionMeta::new("FORECAST.LINEAR", "Statistical", "FORECAST.LINEAR(x, known_y, known_x)", "Calculates a future value along a linear trend"),
            FunctionMeta::new("FORECAST.ETS", "Statistical", "FORECAST.ETS(target_date, values, timeline, [seasonality], [data_completion], [aggregation])", "Returns a forecasted value based on exponential smoothing"),
            FunctionMeta::new("FORECAST.ETS.CONFINT", "Statistical", "FORECAST.ETS.CONFINT(target_date, values, timeline, [confidence_level], [seasonality], [data_completion], [aggregation])", "Returns a confidence interval for a forecast value"),
            FunctionMeta::new("FORECAST.ETS.SEASONALITY", "Statistical", "FORECAST.ETS.SEASONALITY(values, timeline, [data_completion], [aggregation])", "Returns the length of the repetitive pattern detected"),
            FunctionMeta::new("FORECAST.ETS.STAT", "Statistical", "FORECAST.ETS.STAT(values, timeline, statistic_type, [seasonality], [data_completion], [aggregation])", "Returns a statistical value for a time series"),
            // Version variants
            FunctionMeta::new("AVERAGEA", "Statistical", "AVERAGEA(value1, [value2], ...)", "Returns the average, including text and logicals"),
            FunctionMeta::new("MAXA", "Statistical", "MAXA(value1, [value2], ...)", "Returns the maximum value, including text and logicals"),
            FunctionMeta::new("MINA", "Statistical", "MINA(value1, [value2], ...)", "Returns the minimum value, including text and logicals"),
            FunctionMeta::new("STDEVA", "Statistical", "STDEVA(value1, [value2], ...)", "Estimates standard deviation, including text and logicals"),
            FunctionMeta::new("STDEVPA", "Statistical", "STDEVPA(value1, [value2], ...)", "Calculates standard deviation of a population, including text and logicals"),
            FunctionMeta::new("VARA", "Statistical", "VARA(value1, [value2], ...)", "Estimates variance, including text and logicals"),
            FunctionMeta::new("VARPA", "Statistical", "VARPA(value1, [value2], ...)", "Calculates variance of a population, including text and logicals"),
            // Legacy compatibility aliases (no separate catalog entry needed, same syntax)
            FunctionMeta::new("NORMDIST", "Statistical", "NORMDIST(x, mean, standard_dev, cumulative)", "Returns the normal distribution"),
            FunctionMeta::new("NORMINV", "Statistical", "NORMINV(probability, mean, standard_dev)", "Returns the inverse of the normal distribution"),
            FunctionMeta::new("NORMSDIST", "Statistical", "NORMSDIST(z)", "Returns the standard normal cumulative distribution"),
            FunctionMeta::new("NORMSINV", "Statistical", "NORMSINV(probability)", "Returns the inverse of the standard normal distribution"),
            FunctionMeta::new("TDIST", "Statistical", "TDIST(x, degrees_freedom, tails)", "Returns the Student's t-distribution"),
            FunctionMeta::new("TINV", "Statistical", "TINV(probability, degrees_freedom)", "Returns the inverse of the Student's t-distribution"),
            FunctionMeta::new("TTEST", "Statistical", "TTEST(array1, array2, tails, type)", "Returns the probability associated with a Student's t-test"),
            FunctionMeta::new("CHISQDIST", "Statistical", "CHISQDIST(x, degrees_freedom, cumulative)", "Returns the chi-squared distribution"),
            FunctionMeta::new("CHIDIST", "Statistical", "CHIDIST(x, degrees_freedom)", "Returns the right-tailed chi-squared distribution"),
            FunctionMeta::new("CHIINV", "Statistical", "CHIINV(probability, degrees_freedom)", "Returns the inverse of the right-tailed chi-squared distribution"),
            FunctionMeta::new("CHITEST", "Statistical", "CHITEST(actual_range, expected_range)", "Returns the chi-squared test for independence"),
            FunctionMeta::new("FDIST", "Statistical", "FDIST(x, degrees_freedom1, degrees_freedom2)", "Returns the F distribution"),
            FunctionMeta::new("FINV", "Statistical", "FINV(probability, degrees_freedom1, degrees_freedom2)", "Returns the inverse of the F distribution"),
            FunctionMeta::new("FTEST", "Statistical", "FTEST(array1, array2)", "Returns the result of an F-test"),
            FunctionMeta::new("BINOMDIST", "Statistical", "BINOMDIST(number_s, trials, probability_s, cumulative)", "Returns the binomial distribution probability"),
            FunctionMeta::new("CRITBINOM", "Statistical", "CRITBINOM(trials, probability_s, alpha)", "Returns the smallest value for which the binomial distribution is >= alpha"),
            FunctionMeta::new("POISSONDIST", "Statistical", "POISSONDIST(x, mean, cumulative)", "Returns the Poisson distribution"),
            FunctionMeta::new("BETADIST", "Statistical", "BETADIST(x, alpha, beta, [A], [B])", "Returns the beta cumulative distribution"),
            FunctionMeta::new("BETAINV", "Statistical", "BETAINV(probability, alpha, beta, [A], [B])", "Returns the inverse of the beta distribution"),
            FunctionMeta::new("GAMMADIST", "Statistical", "GAMMADIST(x, alpha, beta, cumulative)", "Returns the gamma distribution"),
            FunctionMeta::new("GAMMAINV", "Statistical", "GAMMAINV(probability, alpha, beta)", "Returns the inverse of the gamma distribution"),
            FunctionMeta::new("WEIBULL", "Statistical", "WEIBULL(x, alpha, beta, cumulative)", "Returns the Weibull distribution"),
            FunctionMeta::new("EXPONDIST", "Statistical", "EXPONDIST(x, lambda, cumulative)", "Returns the exponential distribution"),
            FunctionMeta::new("LOGNORMDIST", "Statistical", "LOGNORMDIST(x, mean, standard_dev)", "Returns the lognormal distribution"),
            FunctionMeta::new("LOGINV", "Statistical", "LOGINV(probability, mean, standard_dev)", "Returns the inverse of the lognormal distribution"),
            FunctionMeta::new("HYPGEOMDIST", "Statistical", "HYPGEOMDIST(sample_s, number_sample, population_s, number_pop)", "Returns the hypergeometric distribution"),
            FunctionMeta::new("NEGBINOMDIST", "Statistical", "NEGBINOMDIST(number_f, number_s, probability_s)", "Returns the negative binomial distribution"),

            // ================================================================
            // Financial functions
            // ================================================================
            FunctionMeta::new("PMT", "Financial", "PMT(rate, nper, pv, [fv], [type])", "Calculates the payment for a loan based on constant payments and interest rate"),
            FunctionMeta::new("PV", "Financial", "PV(rate, nper, pmt, [fv], [type])", "Returns the present value of an investment"),
            FunctionMeta::new("FV", "Financial", "FV(rate, nper, pmt, [pv], [type])", "Returns the future value of an investment"),
            FunctionMeta::new("NPV", "Financial", "NPV(rate, value1, [value2], ...)", "Returns the net present value of an investment"),
            FunctionMeta::new("IRR", "Financial", "IRR(values, [guess])", "Returns the internal rate of return for a series of cash flows"),
            FunctionMeta::new("RATE", "Financial", "RATE(nper, pmt, pv, [fv], [type], [guess])", "Returns the interest rate per period of an annuity"),
            FunctionMeta::new("NPER", "Financial", "NPER(rate, pmt, pv, [fv], [type])", "Returns the number of periods for an investment"),
            FunctionMeta::new("SLN", "Financial", "SLN(cost, salvage, life)", "Returns straight-line depreciation for one period"),
            FunctionMeta::new("DB", "Financial", "DB(cost, salvage, life, period, [month])", "Returns fixed-declining balance depreciation"),
            FunctionMeta::new("DDB", "Financial", "DDB(cost, salvage, life, period, [factor])", "Returns double-declining balance depreciation"),
            FunctionMeta::new("SYD", "Financial", "SYD(cost, salvage, life, per)", "Returns the sum-of-years' digits depreciation"),
            FunctionMeta::new("VDB", "Financial", "VDB(cost, salvage, life, start_period, end_period, [factor], [no_switch])", "Returns variable declining balance depreciation"),
            FunctionMeta::new("IPMT", "Financial", "IPMT(rate, per, nper, pv, [fv], [type])", "Returns the interest payment for a given period"),
            FunctionMeta::new("PPMT", "Financial", "PPMT(rate, per, nper, pv, [fv], [type])", "Returns the principal payment for a given period"),
            FunctionMeta::new("FVSCHEDULE", "Financial", "FVSCHEDULE(principal, schedule)", "Returns the future value of a principal after applying a series of compound interest rates"),
            FunctionMeta::new("XNPV", "Financial", "XNPV(rate, values, dates)", "Returns the net present value for a schedule of cash flows"),
            FunctionMeta::new("XIRR", "Financial", "XIRR(values, dates, [guess])", "Returns the internal rate of return for a schedule of cash flows"),
            FunctionMeta::new("MIRR", "Financial", "MIRR(values, finance_rate, reinvest_rate)", "Returns the modified internal rate of return"),
            FunctionMeta::new("CUMIPMT", "Financial", "CUMIPMT(rate, nper, pv, start_period, end_period, type)", "Returns the cumulative interest paid"),
            FunctionMeta::new("CUMPRINC", "Financial", "CUMPRINC(rate, nper, pv, start_period, end_period, type)", "Returns the cumulative principal paid"),
            FunctionMeta::new("EFFECT", "Financial", "EFFECT(nominal_rate, npery)", "Returns the effective annual interest rate"),
            FunctionMeta::new("NOMINAL", "Financial", "NOMINAL(effect_rate, npery)", "Returns the annual nominal interest rate"),
            // Bond & Security
            FunctionMeta::new("ACCRINT", "Financial", "ACCRINT(issue, first_interest, settlement, rate, par, frequency, [basis], [calc_method])", "Returns the accrued interest for a security"),
            FunctionMeta::new("ACCRINTM", "Financial", "ACCRINTM(issue, settlement, rate, par, [basis])", "Returns the accrued interest for a security that pays interest at maturity"),
            FunctionMeta::new("PRICE", "Financial", "PRICE(settlement, maturity, rate, yld, redemption, frequency, [basis])", "Returns the price per $100 face value of a security"),
            FunctionMeta::new("PRICEDISC", "Financial", "PRICEDISC(settlement, maturity, discount, redemption, [basis])", "Returns the price per $100 face value of a discounted security"),
            FunctionMeta::new("PRICEMAT", "Financial", "PRICEMAT(settlement, maturity, issue, rate, yld, [basis])", "Returns the price per $100 face value of a security that pays interest at maturity"),
            FunctionMeta::new("YIELD", "Financial", "YIELD(settlement, maturity, rate, pr, redemption, frequency, [basis])", "Returns the yield on a security"),
            FunctionMeta::new("YIELDDISC", "Financial", "YIELDDISC(settlement, maturity, pr, redemption, [basis])", "Returns the annual yield for a discounted security"),
            FunctionMeta::new("YIELDMAT", "Financial", "YIELDMAT(settlement, maturity, issue, rate, pr, [basis])", "Returns the annual yield of a security that pays interest at maturity"),
            FunctionMeta::new("DURATION", "Financial", "DURATION(settlement, maturity, coupon, yld, frequency, [basis])", "Returns the Macauley duration"),
            FunctionMeta::new("MDURATION", "Financial", "MDURATION(settlement, maturity, coupon, yld, frequency, [basis])", "Returns the modified Macauley duration"),
            FunctionMeta::new("DISC", "Financial", "DISC(settlement, maturity, pr, redemption, [basis])", "Returns the discount rate for a security"),
            FunctionMeta::new("INTRATE", "Financial", "INTRATE(settlement, maturity, investment, redemption, [basis])", "Returns the interest rate for a fully invested security"),
            FunctionMeta::new("RECEIVED", "Financial", "RECEIVED(settlement, maturity, investment, discount, [basis])", "Returns the amount received at maturity for a fully invested security"),
            FunctionMeta::new("COUPDAYBS", "Financial", "COUPDAYBS(settlement, maturity, frequency, [basis])", "Returns the number of days from the beginning of a coupon period to the settlement date"),
            FunctionMeta::new("COUPDAYS", "Financial", "COUPDAYS(settlement, maturity, frequency, [basis])", "Returns the number of days in the coupon period"),
            FunctionMeta::new("COUPDAYSNC", "Financial", "COUPDAYSNC(settlement, maturity, frequency, [basis])", "Returns the number of days from the settlement date to the next coupon date"),
            FunctionMeta::new("COUPNCD", "Financial", "COUPNCD(settlement, maturity, frequency, [basis])", "Returns the next coupon date after the settlement date"),
            FunctionMeta::new("COUPNUM", "Financial", "COUPNUM(settlement, maturity, frequency, [basis])", "Returns the number of coupons payable"),
            FunctionMeta::new("COUPPCD", "Financial", "COUPPCD(settlement, maturity, frequency, [basis])", "Returns the previous coupon date before the settlement date"),
            // Treasury bill
            FunctionMeta::new("TBILLEQ", "Financial", "TBILLEQ(settlement, maturity, discount)", "Returns the bond-equivalent yield for a Treasury bill"),
            FunctionMeta::new("TBILLPRICE", "Financial", "TBILLPRICE(settlement, maturity, discount)", "Returns the price per $100 face value for a Treasury bill"),
            FunctionMeta::new("TBILLYIELD", "Financial", "TBILLYIELD(settlement, maturity, pr)", "Returns the yield for a Treasury bill"),
            // Other financial
            FunctionMeta::new("DOLLARDE", "Financial", "DOLLARDE(fractional_dollar, fraction)", "Converts a dollar price expressed as a fraction into a decimal number"),
            FunctionMeta::new("DOLLARFR", "Financial", "DOLLARFR(decimal_dollar, fraction)", "Converts a dollar price expressed as a decimal into a fraction"),
            FunctionMeta::new("PDURATION", "Financial", "PDURATION(rate, pv, fv)", "Returns the number of periods required for an investment to reach a specified value"),
            FunctionMeta::new("RRI", "Financial", "RRI(nper, pv, fv)", "Returns an equivalent interest rate for the growth of an investment"),
            FunctionMeta::new("ISPMT", "Financial", "ISPMT(rate, per, nper, pv)", "Returns the interest paid during a specific period"),
            FunctionMeta::new("AMORDEGRC", "Financial", "AMORDEGRC(cost, date_purchased, first_period, salvage, period, rate, [basis])", "Returns the depreciation for each accounting period (French accounting system)"),
            FunctionMeta::new("AMORLINC", "Financial", "AMORLINC(cost, date_purchased, first_period, salvage, period, rate, [basis])", "Returns the depreciation for each accounting period (linear)"),
            FunctionMeta::new("ODDFPRICE", "Financial", "ODDFPRICE(settlement, maturity, issue, first_coupon, rate, yld, redemption, frequency, [basis])", "Returns the price of a security with an odd first period"),
            FunctionMeta::new("ODDFYIELD", "Financial", "ODDFYIELD(settlement, maturity, issue, first_coupon, rate, pr, redemption, frequency, [basis])", "Returns the yield of a security with an odd first period"),
            FunctionMeta::new("ODDLPRICE", "Financial", "ODDLPRICE(settlement, maturity, last_interest, rate, yld, redemption, frequency, [basis])", "Returns the price of a security with an odd last period"),
            FunctionMeta::new("ODDLYIELD", "Financial", "ODDLYIELD(settlement, maturity, last_interest, rate, pr, redemption, frequency, [basis])", "Returns the yield of a security with an odd last period"),

            // ================================================================
            // Engineering functions
            // ================================================================
            // Base conversion
            FunctionMeta::new("BIN2DEC", "Engineering", "BIN2DEC(number)", "Converts a binary number to decimal"),
            FunctionMeta::new("BIN2HEX", "Engineering", "BIN2HEX(number, [places])", "Converts a binary number to hexadecimal"),
            FunctionMeta::new("BIN2OCT", "Engineering", "BIN2OCT(number, [places])", "Converts a binary number to octal"),
            FunctionMeta::new("DEC2BIN", "Engineering", "DEC2BIN(number, [places])", "Converts a decimal number to binary"),
            FunctionMeta::new("DEC2HEX", "Engineering", "DEC2HEX(number, [places])", "Converts a decimal number to hexadecimal"),
            FunctionMeta::new("DEC2OCT", "Engineering", "DEC2OCT(number, [places])", "Converts a decimal number to octal"),
            FunctionMeta::new("HEX2BIN", "Engineering", "HEX2BIN(number, [places])", "Converts a hexadecimal number to binary"),
            FunctionMeta::new("HEX2DEC", "Engineering", "HEX2DEC(number)", "Converts a hexadecimal number to decimal"),
            FunctionMeta::new("HEX2OCT", "Engineering", "HEX2OCT(number, [places])", "Converts a hexadecimal number to octal"),
            FunctionMeta::new("OCT2BIN", "Engineering", "OCT2BIN(number, [places])", "Converts an octal number to binary"),
            FunctionMeta::new("OCT2DEC", "Engineering", "OCT2DEC(number)", "Converts an octal number to decimal"),
            FunctionMeta::new("OCT2HEX", "Engineering", "OCT2HEX(number, [places])", "Converts an octal number to hexadecimal"),
            // Bit operations
            FunctionMeta::new("BITAND", "Engineering", "BITAND(number1, number2)", "Returns a bitwise AND of two numbers"),
            FunctionMeta::new("BITOR", "Engineering", "BITOR(number1, number2)", "Returns a bitwise OR of two numbers"),
            FunctionMeta::new("BITXOR", "Engineering", "BITXOR(number1, number2)", "Returns a bitwise XOR of two numbers"),
            FunctionMeta::new("BITLSHIFT", "Engineering", "BITLSHIFT(number, shift_amount)", "Returns a number shifted left by the specified bits"),
            FunctionMeta::new("BITRSHIFT", "Engineering", "BITRSHIFT(number, shift_amount)", "Returns a number shifted right by the specified bits"),
            // Complex numbers
            FunctionMeta::new("COMPLEX", "Engineering", "COMPLEX(real_num, i_num, [suffix])", "Converts real and imaginary coefficients into a complex number"),
            FunctionMeta::new("IMABS", "Engineering", "IMABS(inumber)", "Returns the absolute value of a complex number"),
            FunctionMeta::new("IMAGINARY", "Engineering", "IMAGINARY(inumber)", "Returns the imaginary coefficient of a complex number"),
            FunctionMeta::new("IMREAL", "Engineering", "IMREAL(inumber)", "Returns the real coefficient of a complex number"),
            FunctionMeta::new("IMARGUMENT", "Engineering", "IMARGUMENT(inumber)", "Returns the argument (theta) of a complex number"),
            FunctionMeta::new("IMCONJUGATE", "Engineering", "IMCONJUGATE(inumber)", "Returns the complex conjugate of a complex number"),
            FunctionMeta::new("IMCOS", "Engineering", "IMCOS(inumber)", "Returns the cosine of a complex number"),
            FunctionMeta::new("IMCOSH", "Engineering", "IMCOSH(inumber)", "Returns the hyperbolic cosine of a complex number"),
            FunctionMeta::new("IMCOT", "Engineering", "IMCOT(inumber)", "Returns the cotangent of a complex number"),
            FunctionMeta::new("IMCSC", "Engineering", "IMCSC(inumber)", "Returns the cosecant of a complex number"),
            FunctionMeta::new("IMCSCH", "Engineering", "IMCSCH(inumber)", "Returns the hyperbolic cosecant of a complex number"),
            FunctionMeta::new("IMDIV", "Engineering", "IMDIV(inumber1, inumber2)", "Returns the quotient of two complex numbers"),
            FunctionMeta::new("IMEXP", "Engineering", "IMEXP(inumber)", "Returns the exponential of a complex number"),
            FunctionMeta::new("IMLN", "Engineering", "IMLN(inumber)", "Returns the natural logarithm of a complex number"),
            FunctionMeta::new("IMLOG10", "Engineering", "IMLOG10(inumber)", "Returns the base-10 logarithm of a complex number"),
            FunctionMeta::new("IMLOG2", "Engineering", "IMLOG2(inumber)", "Returns the base-2 logarithm of a complex number"),
            FunctionMeta::new("IMPOWER", "Engineering", "IMPOWER(inumber, number)", "Returns a complex number raised to a power"),
            FunctionMeta::new("IMPRODUCT", "Engineering", "IMPRODUCT(inumber1, [inumber2], ...)", "Returns the product of complex numbers"),
            FunctionMeta::new("IMSEC", "Engineering", "IMSEC(inumber)", "Returns the secant of a complex number"),
            FunctionMeta::new("IMSECH", "Engineering", "IMSECH(inumber)", "Returns the hyperbolic secant of a complex number"),
            FunctionMeta::new("IMSIN", "Engineering", "IMSIN(inumber)", "Returns the sine of a complex number"),
            FunctionMeta::new("IMSINH", "Engineering", "IMSINH(inumber)", "Returns the hyperbolic sine of a complex number"),
            FunctionMeta::new("IMSQRT", "Engineering", "IMSQRT(inumber)", "Returns the square root of a complex number"),
            FunctionMeta::new("IMSUB", "Engineering", "IMSUB(inumber1, inumber2)", "Returns the difference of two complex numbers"),
            FunctionMeta::new("IMSUM", "Engineering", "IMSUM(inumber1, [inumber2], ...)", "Returns the sum of complex numbers"),
            FunctionMeta::new("IMTAN", "Engineering", "IMTAN(inumber)", "Returns the tangent of a complex number"),
            // Bessel
            FunctionMeta::new("BESSELI", "Engineering", "BESSELI(x, n)", "Returns the modified Bessel function In(x)"),
            FunctionMeta::new("BESSELJ", "Engineering", "BESSELJ(x, n)", "Returns the Bessel function Jn(x)"),
            FunctionMeta::new("BESSELK", "Engineering", "BESSELK(x, n)", "Returns the modified Bessel function Kn(x)"),
            FunctionMeta::new("BESSELY", "Engineering", "BESSELY(x, n)", "Returns the Bessel function Yn(x)"),
            // Other
            FunctionMeta::new("CONVERT", "Engineering", "CONVERT(number, from_unit, to_unit)", "Converts a number from one measurement system to another"),
            FunctionMeta::new("DELTA", "Engineering", "DELTA(number1, [number2])", "Tests whether two values are equal (returns 1 or 0)"),
            FunctionMeta::new("ERF", "Engineering", "ERF(lower_limit, [upper_limit])", "Returns the error function"),
            FunctionMeta::new("ERF.PRECISE", "Engineering", "ERF.PRECISE(x)", "Returns the error function"),
            FunctionMeta::new("ERFC", "Engineering", "ERFC(x)", "Returns the complementary error function"),
            FunctionMeta::new("ERFC.PRECISE", "Engineering", "ERFC.PRECISE(x)", "Returns the complementary error function"),
            FunctionMeta::new("GESTEP", "Engineering", "GESTEP(number, [step])", "Tests whether a number is greater than a threshold value"),
            FunctionMeta::new("SERIESSUM", "Engineering", "SERIESSUM(x, n, m, coefficients)", "Returns the sum of a power series"),

            // ================================================================
            // Matrix functions
            // ================================================================
            FunctionMeta::new("MMULT", "Matrix", "MMULT(array1, array2)", "Returns the matrix product of two arrays"),
            FunctionMeta::new("MDETERM", "Matrix", "MDETERM(array)", "Returns the matrix determinant of an array"),
            FunctionMeta::new("MINVERSE", "Matrix", "MINVERSE(array)", "Returns the inverse matrix for a given matrix"),
            FunctionMeta::new("MUNIT", "Matrix", "MUNIT(dimension)", "Returns the unit matrix for the specified dimension"),

            // ================================================================
            // Dynamic Array functions
            // ================================================================
            FunctionMeta::new("FILTER", "Dynamic Array", "FILTER(array, include, [if_empty])", "Filters an array based on a Boolean array"),
            FunctionMeta::new("SORT", "Dynamic Array", "SORT(array, [sort_index], [sort_order], [by_col])", "Sorts the contents of a range or array"),
            FunctionMeta::new("SORTBY", "Dynamic Array", "SORTBY(array, by_array1, [sort_order1], [by_array2], [sort_order2], ...)", "Sorts based on the values in corresponding arrays"),
            FunctionMeta::new("UNIQUE", "Dynamic Array", "UNIQUE(array, [by_col], [exactly_once])", "Returns unique values, removing duplicates"),
            FunctionMeta::new("SEQUENCE", "Dynamic Array", "SEQUENCE(rows, [columns], [start], [step])", "Generates a sequence of numbers in an array"),
            FunctionMeta::new("RANDARRAY", "Dynamic Array", "RANDARRAY([rows], [columns], [min], [max], [whole_number])", "Returns an array of random numbers"),
            FunctionMeta::new("GROUPBY", "Dynamic Array", "GROUPBY(row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array])", "Groups data by row fields and aggregates values"),
            FunctionMeta::new("PIVOTBY", "Dynamic Array", "PIVOTBY(row_fields, col_fields, values, function, [field_headers], [row_total_depth], [row_sort_order], [col_total_depth], [col_sort_order], [filter_array])", "Creates a pivot table by grouping data"),
            // Array reshaping
            FunctionMeta::new("VSTACK", "Dynamic Array", "VSTACK(array1, [array2], ...)", "Stacks arrays vertically (by rows)"),
            FunctionMeta::new("HSTACK", "Dynamic Array", "HSTACK(array1, [array2], ...)", "Stacks arrays horizontally (by columns)"),
            FunctionMeta::new("EXPAND", "Dynamic Array", "EXPAND(array, rows, [columns], [pad_with])", "Expands an array to specified dimensions"),
            FunctionMeta::new("TOCOL", "Dynamic Array", "TOCOL(array, [ignore], [scan_by_column])", "Transforms an array into a single column"),
            FunctionMeta::new("TOROW", "Dynamic Array", "TOROW(array, [ignore], [scan_by_column])", "Transforms an array into a single row"),
            FunctionMeta::new("WRAPCOLS", "Dynamic Array", "WRAPCOLS(vector, wrap_count, [pad_with])", "Wraps a row or column vector into columns"),
            FunctionMeta::new("WRAPROWS", "Dynamic Array", "WRAPROWS(vector, wrap_count, [pad_with])", "Wraps a row or column vector into rows"),
            // Collections
            FunctionMeta::new("COLLECT", "Dynamic Array", "COLLECT(value)", "Wraps an array result into a contained List cell"),
            FunctionMeta::new("DICT", "Dynamic Array", "DICT(key1, value1, [key2, value2], ...)", "Creates a Dict cell from alternating key-value pairs"),
            FunctionMeta::new("KEYS", "Dynamic Array", "KEYS(collection)", "Returns an array of keys from a Dict, or indices from a List"),
            FunctionMeta::new("VALUES", "Dynamic Array", "VALUES(collection)", "Returns an array of values from a Dict or List"),
            FunctionMeta::new("CONTAINS", "Dynamic Array", "CONTAINS(collection, value)", "Returns TRUE if value exists in a List, or if key exists in a Dict"),
            FunctionMeta::new("ISLIST", "Dynamic Array", "ISLIST(value)", "Returns TRUE if the value is a List cell"),
            FunctionMeta::new("ISDICT", "Dynamic Array", "ISDICT(value)", "Returns TRUE if the value is a Dict cell"),
            FunctionMeta::new("FLATTEN", "Dynamic Array", "FLATTEN(list)", "Recursively flattens nested lists into a single-level list"),
            FunctionMeta::new("TAKE", "Dynamic Array", "TAKE(array, rows, [columns])", "Returns a specified number of rows or columns from an array"),
            FunctionMeta::new("DROP", "Dynamic Array", "DROP(array, rows, [columns])", "Removes a specified number of rows or columns from an array"),
            FunctionMeta::new("APPEND", "Dynamic Array", "APPEND(list, value)", "Returns a new list with value appended to the end"),
            FunctionMeta::new("MERGE", "Dynamic Array", "MERGE(dict1, dict2)", "Merges two dicts; second dict wins on key conflicts"),

            // ================================================================
            // Database functions
            // ================================================================
            FunctionMeta::new("DAVERAGE", "Database", "DAVERAGE(database, field, criteria)", "Averages values in a column of a list or database that match conditions"),
            FunctionMeta::new("DCOUNT", "Database", "DCOUNT(database, field, criteria)", "Counts cells containing numbers in a database that match conditions"),
            FunctionMeta::new("DCOUNTA", "Database", "DCOUNTA(database, field, criteria)", "Counts nonblank cells in a database that match conditions"),
            FunctionMeta::new("DGET", "Database", "DGET(database, field, criteria)", "Extracts a single value from a database that matches conditions"),
            FunctionMeta::new("DMAX", "Database", "DMAX(database, field, criteria)", "Returns the maximum value in a database that matches conditions"),
            FunctionMeta::new("DMIN", "Database", "DMIN(database, field, criteria)", "Returns the minimum value in a database that matches conditions"),
            FunctionMeta::new("DPRODUCT", "Database", "DPRODUCT(database, field, criteria)", "Multiplies values in a database that match conditions"),
            FunctionMeta::new("DSTDEV", "Database", "DSTDEV(database, field, criteria)", "Estimates standard deviation based on a sample from matching database entries"),
            FunctionMeta::new("DSTDEVP", "Database", "DSTDEVP(database, field, criteria)", "Calculates standard deviation based on the entire population of matching database entries"),
            FunctionMeta::new("DSUM", "Database", "DSUM(database, field, criteria)", "Sums values in a database that match conditions"),
            FunctionMeta::new("DVAR", "Database", "DVAR(database, field, criteria)", "Estimates variance based on a sample from matching database entries"),
            FunctionMeta::new("DVARP", "Database", "DVARP(database, field, criteria)", "Calculates variance based on the entire population of matching database entries"),

            // ================================================================
            // UI functions
            // ================================================================
            FunctionMeta::new("GET.ROW.HEIGHT", "UI", "GET.ROW.HEIGHT(row)", "Returns the height in pixels of the specified row"),
            FunctionMeta::new("GET.COLUMN.WIDTH", "UI", "GET.COLUMN.WIDTH(col)", "Returns the width in pixels of the specified column"),
            FunctionMeta::new("GET.CELL.FILLCOLOR", "UI", "GET.CELL.FILLCOLOR(cell_ref)", "Returns the background fill color of a cell as a CSS color string"),

            // ================================================================
            // File functions
            // ================================================================
            FunctionMeta::with_template("FILEREAD", "File", "FILEREAD(path)", "Returns the text content of a virtual file", "=FILEREAD(\"\")"),
            FunctionMeta::with_template("FILELINES", "File", "FILELINES(path)", "Returns the number of lines in a virtual file", "=FILELINES(\"\")"),
            FunctionMeta::with_template("FILEEXISTS", "File", "FILEEXISTS(path)", "Returns TRUE if a virtual file exists", "=FILEEXISTS(\"\")"),

            // ================================================================
            // Parser aliases (not shown in catalog with separate entries,
            // but included so from_name() lookup works)
            // ================================================================
            FunctionMeta::alias("AVG", "Math"),
            FunctionMeta::alias("CEIL", "Math"),
            FunctionMeta::alias("POW", "Math"),
            FunctionMeta::alias("FACTORIAL", "Math"),
            FunctionMeta::alias("CONCAT", "Text"),
            FunctionMeta::alias("FILE.READ", "File"),
            FunctionMeta::alias("FILE.LINES", "File"),
            FunctionMeta::alias("FILE.EXISTS", "File"),
            FunctionMeta::alias("GETROWHEIGHT", "UI"),
            FunctionMeta::alias("GETCOLUMNWIDTH", "UI"),
            FunctionMeta::alias("GETCELLFILLCOLOR", "UI"),
        ]
    }
}

/// Metadata for a single built-in function.
/// This is the single source of truth for the function catalog.
#[derive(Debug, Clone)]
pub struct FunctionMeta {
    pub name: &'static str,
    pub category: &'static str,
    /// Syntax string, e.g. "SUM(number1, [number2], ...)"
    pub syntax: &'static str,
    /// Human-readable description
    pub description: &'static str,
    /// Optional template override (for special cases like LAMBDA-embedding).
    /// When None, the template is auto-generated from the syntax string.
    pub template_override: Option<&'static str>,
    /// If true, this is an alias (e.g. AVG for AVERAGE) and should be
    /// excluded from the user-facing function catalog/dialog.
    pub is_alias: bool,
}

impl FunctionMeta {
    /// Standard function entry with auto-generated template.
    pub const fn new(
        name: &'static str,
        category: &'static str,
        syntax: &'static str,
        description: &'static str,
    ) -> Self {
        FunctionMeta { name, category, syntax, description, template_override: None, is_alias: false }
    }

    /// Function entry with a custom template override.
    pub const fn with_template(
        name: &'static str,
        category: &'static str,
        syntax: &'static str,
        description: &'static str,
        template: &'static str,
    ) -> Self {
        FunctionMeta { name, category, syntax, description, template_override: Some(template), is_alias: false }
    }

    /// Alias entry: parsed by `from_name()` but hidden from the catalog UI.
    pub const fn alias(name: &'static str, category: &'static str) -> Self {
        FunctionMeta { name, category, syntax: "", description: "", template_override: None, is_alias: true }
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