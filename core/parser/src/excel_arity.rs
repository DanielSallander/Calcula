//! FILENAME: core/parser/src/excel_arity.rs
//! PURPOSE: Which argument counts Excel 16 takes for each built-in function --
//! ONE rule for the two places that need it (BUG-0738): formula ENTRY, which
//! refuses a call Excel refuses to type ([`check_entered_formula`]), and the
//! `.xlsx` export, which writes such a cell's value alone because Excel refuses
//! to open a file holding one (`core/persistence/src/xlsx_formula_text.rs`,
//! `Unwritable::BuiltinArity`). The export's live table
//! (`xlsx_formula_text_live_arity.rs`: every Calcula built-in typed into a fresh
//! Excel 16 at its catalog's fewest - 1 .. most + 1 arguments, 1,500+ calls)
//! pins [`excel_refuses_arity`] against what Excel did.
//!
//! [`check_entered_formula`]: crate::parser::check_entered_formula

use crate::ast::{BuiltinFunction, Expression};
use crate::parser::{builtin_arity, sub_expressions, ParseError, ParseResult};

/// Calcula's own functions, which Excel does not have: [LIVE] Excel 16 types
/// a call to each with any number of arguments (and shows `#NAME?`), so no
/// arity of theirs is refused -- at entry or by the export -- and a bare one is
/// no function value to Excel (`LET(f,LPAD,1)` is saved `LPAD`, never
/// `_xleta.`). (`CHISQDIST` and `POISSONDIST` were built-ins until lane
/// legacystats, 2026-11-05: Excel has neither [LIVE: #NAME?], so they are no
/// longer Calcula's either -- a call to one is an unknown name, as in Excel.)
/// `AVG`, `CEIL`, `FACTORIAL` and `POW` were hidden aliases stored as
/// AVERAGE / CEILING / FACT / POWER until lane formc (2026-11-05); they are
/// Calcula's own functions now, kept under the name typed, and Excel has none
/// of them ([LIVE] `=AVG(1,2)` #NAME?), so a file carries them as written.
pub const CALCULA_ONLY_FUNCTIONS: [&str; 30] = [
    "APPEND", "AVG", "CEIL", "COLLECT", "CONTAINS", "DICT", "EURO", "FACTORIAL", "FILEEXISTS", "FILELINES",
    "FILEREAD", "FLATTEN", "GATHER", "GATHER.AT", "GATHER.COUNT", "GATHER.FROM", "GATHER.SUBMITTERS",
    "GET.CELL.FILLCOLOR", "GET.COLUMN.WIDTH", "GET.CONTROLVALUE", "GET.ROW.HEIGHT", "ISDICT", "ISLIST", "KEYS",
    "LPAD", "MERGE", "POW", "RPAD", "VALUES", "XLOOKUPS",
];

/// Whether `name` is one of Calcula's own functions ([`CALCULA_ONLY_FUNCTIONS`]).
pub fn is_calcula_only_function(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    CALCULA_ONLY_FUNCTIONS.contains(&upper.as_str())
}

/// Whether Excel refuses a call to the built-in `name` with `given`
/// arguments. [LIVE] Excel 16 (xlsxfmt probes 1-2: every Calcula built-in
/// typed with A1 arguments at its catalog's fewest - 1, fewest, most and
/// most + 1, a variadic one up to fewest + 3) refuses exactly what the
/// catalog's syntax string allows not, except where the syntax string cannot
/// say Excel's rule: the pair rules (`SUMIFS` takes 3, 5, 7 ..., `COUNTIFS`
/// and `IFS` 2, 4, 6 ..., `SORTBY` 2, 3, 5, 7 ..., `GETPIVOTDATA` 2, 3, 4, 6,
/// 8 ..., `LET` 3, 5, 7 ...) and catalog entries narrower than Excel (`GCD(4)`,
/// `MAP` over three arrays, `BYROW(A1:C2)`, `INDEX`'s area number, `GROUPBY`'s
/// 8th and `PIVOTBY`'s 11th argument) -- [LIVE, lane formula p4.json] `GCD(4)`,
/// `LCM(4)`, `INDEX(A1:A5,1,1,1)`, `MAP(A1:A3,A1:A3,LAMBDA(a,b,a))`,
/// `BYROW(A1:A3)` and `SORTBY(A1:A3,A1:A3,1,A1:A3,1)` typed, `LET(x)` and
/// `LET(x,1)` refused. A function Calcula's catalog has no syntax for, or one
/// Excel does not have, is never refused.
pub fn excel_refuses_arity(name: &str, given: usize) -> bool {
    let upper = name.to_ascii_uppercase();
    if CALCULA_ONLY_FUNCTIONS.contains(&upper.as_str()) {
        return false;
    }
    !accepted_count(&upper, given)
}

/// Whether Excel takes `given` arguments for the (upper-cased) built-in.
fn accepted_count(upper: &str, given: usize) -> bool {
    let odd = given % 2 == 1;
    match upper {
        "SUMIFS" | "AVERAGEIFS" | "MINIFS" | "MAXIFS" => given >= 3 && odd,
        "COUNTIFS" | "IFS" => given >= 2 && !odd,
        "SORTBY" => given == 2 || (given >= 3 && odd),
        "GETPIVOTDATA" => given >= 2 && (given == 3 || !odd),
        "LET" => given >= 3 && odd,
        "GCD" | "LCM" => given >= 1,
        "MAP" => given >= 2,
        "BYROW" | "BYCOL" => (1..=2).contains(&given),
        "INDEX" => (2..=4).contains(&given),
        "GROUPBY" => (3..=8).contains(&given),
        "PIVOTBY" => (4..=11).contains(&given),
        _ => builtin_arity(upper).map_or(true, |(fewest, most)| given >= fewest && most.map_or(true, |most| given <= most)),
    }
}

/// Excel's three messages for a call it refuses to type, [LIVE, Excel 16,
/// lane formula p2.json / p3.json, `Names.Add` refusing each call]:
/// `ABS(1;2)`, `ROUND(1;2;3)`, `IF(1;2;3;4)`, `DATE(1;2;3;4)`, `IFERROR(1;2;3)`,
/// `LEFT("a";1;2)`, `BYROW(1;2;3)` "You've entered too many arguments for this
/// function."; `ROUND(1)`, `MID("a";1)`, `DATE(1;2)`, `MOD(1)`, `IFERROR(1)`,
/// `CHOOSE(1)`, `SWITCH(1)`, `IFS(1;2;3)`, `SUMIFS(1;2)`, `COUNTIFS(1)`,
/// `VLOOKUP(1;2)`, `MAP(1)`, `LET(x;1)` "You've entered too few arguments for
/// this function."; and "There's a problem with this formula." when the call
/// has NO argument (`SUM()`, `IF()`, `LAMBDA()`, `CONCAT()`), when it takes
/// none (`PI(1)`, `NOW(1)`, `NA(1)`), or when some argument holds a REFERENCE
/// (`ROUND(A1)`, `ROUND(1+A1)`, `ABS(A1;A2)`, `MID(A1;1)`, `IF(A1;1;2;3)`,
/// `SUMIFS(A1:A5;B1:B5)`, `VLOOKUP(1;A1:B2)`).
fn refusal_message(name: &str, args: &[Expression]) -> &'static str {
    const TOO_MANY: &str = "You've entered too many arguments for this function.";
    const TOO_FEW: &str = "You've entered too few arguments for this function.";
    const PROBLEM: &str = "There's a problem with this formula.";
    let takes_none = builtin_arity(name).is_some_and(|(_, most)| most == Some(0));
    if args.is_empty() || takes_none || args.iter().any(holds_reference) {
        return PROBLEM;
    }
    let upper = name.to_ascii_uppercase();
    let more_would_do = (args.len() + 1..=args.len() + 2).any(|n| accepted_count(&upper, n));
    if more_would_do { TOO_FEW } else { TOO_MANY }
}

/// Whether `expr` holds a cell or range reference anywhere.
fn holds_reference(expr: &Expression) -> bool {
    match expr {
        Expression::CellRef { .. }
        | Expression::Range { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::Sheet3DRef { .. }
        | Expression::TableRef { .. }
        | Expression::SpillRef { .. } => true,
        other => sub_expressions(other).into_iter().any(holds_reference),
    }
}

/// ENTRY check (BUG-0738): a built-in called with an argument count Excel
/// refuses to type -- [LIVE, Excel 16] `ABS(1,2)`, `ROUND(1)`, `PI(1)`, `IF()`,
/// `IFS(1,2,3)`, `SWITCH(1)`, `CHOOSE(1)`, `SUMIFS(A1:A5,B1:B5)`, `MID("a",1)`,
/// `LET(x,1)`, `IFERROR(1)`, `LAMBDA()` are refused (0x800A03EC, lane formula
/// p4.json), each with one of Excel's three messages ([`refusal_message`]).
/// Calcula stored every one and evaluated it (`#VALUE!`). Not part of
/// [`crate::parse`]: a workbook that already holds such a call still opens with
/// it, and the export writes its value alone.
///
/// A Calcula-only function is never refused ([`CALCULA_ONLY_FUNCTIONS`]), nor
/// is a call of an unknown name -- a LET / LAMBDA name, a defined LAMBDA, a
/// custom function (`BuiltinFunction::Custom`), whose arity only it knows.
pub(crate) fn refuse_builtin_arity(expr: &Expression) -> ParseResult<()> {
    if let Expression::FunctionCall { func, args, .. } = expr {
        // Excel's `CALL` (a DLL call Calcula does not have, so an unknown name
        // here): [LIVE, lane formula p1.json / p2.json, `Names.Add`] `CALL()`
        // is refused with "There's a problem with this formula." and
        // `CALL("a")`, `CALL("a";"b")` are taken -- one argument or more.
        // (`PY` has no arity Excel checks the same way: `Names.Add` refuses
        // every `PY(..)` call, whatever its count, with "That function isn't
        // valid." -- a Python formula is no defined name's.)
        if let BuiltinFunction::Custom(name) = func {
            if name.eq_ignore_ascii_case("CALL") && args.is_empty() {
                return Err(ParseError::new(
                    "There's a problem with this formula. CALL() cannot be called with 0 arguments.",
                ));
            }
        }
        if !matches!(func, BuiltinFunction::Custom(_)) {
            let name = func.to_canonical_name();
            if excel_refuses_arity(name, args.len()) {
                return Err(ParseError::new(format!(
                    "{} {}() cannot be called with {} argument{}.",
                    refusal_message(name, args),
                    name,
                    args.len(),
                    if args.len() == 1 { "" } else { "s" }
                )));
            }
        }
    }
    for sub in sub_expressions(expr) {
        refuse_builtin_arity(sub)?;
    }
    Ok(())
}
