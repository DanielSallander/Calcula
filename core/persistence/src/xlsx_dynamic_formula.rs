//! FILENAME: core/persistence/src/xlsx_dynamic_formula.rs
//!
//! Which single-cell formulas the .xlsx export writes DYNAMIC
//! (`<c cm="1"><f t="array" ref="..">`), as Excel 16 saves them.
//!
//! WHY IT MATTERS. Excel reads a plain `<f>` as a LEGACY formula and puts its
//! implicit intersection (`@`) wherever a multi-cell value meets a parameter
//! that takes one value -- and recalculates. Calcula's formulas mean what a
//! dynamic-array Excel means, so a formula written plain where Excel itself
//! would save it dynamic opens CHANGED, with a wrong value and no warning
//! ([LIVE, Excel 16, rev-parse probeF]: `SUM(LEN(C1:C3))` opened as
//! `SUM(LEN(@C1:C3))` = #VALUE! for 6, `AND(ISNUMBER(A1:A3))` FALSE for TRUE,
//! `SUM(COUNTIF(A1:A5,A1:A3))` 0 for 3, `SUM(INDEX(A1:A5,{1,2}))` 1 for 3, 24
//! of 46 probed formulas). The other direction is harmless: a formula Excel
//! saves plain, written dynamic, opens as the same formula with the same
//! value ([LIVE] round-B lane tablefix, probe2), so a doubt resolves to
//! dynamic.
//!
//! EXCEL'S RULE, MEASURED [LIVE, Excel 16, 2026-11-05, lane xlsxdyn,
//! SCRATCH/xlsxdyn/probe.ps1: every candidate typed (`Formula2`) into its own
//! cell of a fresh workbook in a fresh Excel per batch of 700, saved, the
//! sheet XML's `cm` read; 10,083 formulas over all 493 Excel functions in
//! Calcula's catalog]: each function was called with single cells, then with
//! a multi-cell range and an array constant in each argument position in
//! turn, at the top, inside `ABS` and inside `SUM`. From that, each parameter
//! has one of three classes (separately for a reference and for an array):
//!
//! - LIFTED (`V`): the parameter takes one value, so a multi-cell value there
//!   is lifted -- the formula is dynamic (`LEN`'s text, `COUNTIF`'s
//!   criteria, `INDEX`'s row, `IF`'s condition, `VLOOKUP`'s lookup value).
//! - WHOLE (`R`): the parameter takes the range or array whole and the call's
//!   result stays one value (`SUM`, `COUNTIF`'s range, `SUMPRODUCT`,
//!   `MATCH`'s lookup array, `AND`, `TEXTJOIN`'s texts; an Analysis ToolPak function takes a
//!   REFERENCE whole but lifts an array constant -- `EDATE(A1:A3,1)` is plain,
//!   `EDATE({1,2,3},1)` dynamic).
//! - SPREADS (`P`): taken whole, but the call's result is then multi-cell
//!   (`IF`'s and `CHOOSE`'s values, `MMULT`, `TRANSPOSE` of an array): the formula is
//!   dynamic when that result meets a lifted parameter or stands at the top.
//!
//! An operator (`+`, `*`, `=`, `&`, `-`, `%`, unary `+`) on a multi-cell value
//! lifts, and a multi-cell value at the TOP of the formula is dynamic
//! (`=MMULT({1,2},{3;4})`, `=INDEX(LINEST(..),1)`). What counts as multi-cell
//! is Excel's static view, never the size at run time: any `A1:B2`-shaped
//! range, `A1:A1` included; a whole column or row; a 3-D reference, even of one
//! cell; a table reference but `Tbl[@P]`; an array constant, `{1}` included;
//! an intersection of which either side is; a defined name, unless it names
//! one cell or a constant (`=Sheet1!$A$2`, `=5`, `=-5`, `="x"`, `=TRUE`) --
//! `=Sheet1!$A$1+1` and `=(5)` are multi-cell to Excel; a LET name bound to a
//! multi-cell value (a LET name shadows a defined one); a call whose result
//! is (the `A` flag below: `TRANSPOSE`, `MMULT`, `INDIRECT`, `FREQUENCY`,
//! `IFS`, ..., and every function Excel does not have, which it holds as a
//! user-defined function); `INDEX` of an array that is no reference, or of a
//! multi-cell reference by an index that could be 0 -- anything but a number
//! literal from 1 or a `MATCH` (`INDEX(A1:A5,D1)` is dynamic,
//! `INDEX(A1:A5,MATCH(..))` plain); `OFFSET` of a multi-cell base or with a
//! height or width other than the literal 1. `CELL` with a reference for its
//! info type is dynamic anywhere, even under `SUM` (flag `D`).
//!
//! The table is Excel's own answer per function, not a guess; the 9,691 calls
//! Excel typed are the test `the_classifier_agrees_with_excel_on_every_probed_call`
//! (`xlsx_dynamic_formula_live.rs`), each marked with whether its legacy
//! reading has another value, and the targeted probes (names, LET, INDEX,
//! OFFSET, tables, operators) are
//! `every_probed_formula_is_dynamic_where_excel_saves_it_so`
//! (`xlsx_formula_text_live_table.rs`), with Excel's value both ways. [LIVE]
//! Both real exports, opened in Excel 16 and recalculated, show Excel's own
//! value for every formula but the volatile `NOW`/`RAND`/`RANDARRAY`/
//! `RANDBETWEEN` (SCRATCH/xlsxdyn/openprobe.ps1 + compare-open.mjs).

use parser::ast::{BinaryOperator, BuiltinFunction, Expression as E, TableSpecifier, Value};
use std::collections::HashMap;

#[cfg(test)]
#[path = "xlsx_dynamic_formula_live.rs"]
pub(crate) mod live;

#[cfg(test)]
#[path = "xlsx_dynamic_formula_legacy_tests.rs"]
mod legacy_tests;

/// Excel's class of each function's parameters [LIVE, see the module
/// header]: (function, flags, class per position for a REFERENCE argument,
/// class per position for an ARRAY argument). Flags: `A` the call's result
/// is multi-cell with single-cell arguments, `D` the call makes any formula
/// dynamic. A position past the string repeats its last class, or its last
/// two for an alternating pair (`SUMIFS`, `COUNTIFS`, `IFS`, `SORTBY`).
/// `INDEX` and `OFFSET` have their result's shape worked out in code
/// ([`Walk::call_array`]). Sorted by name; a function not here is one Excel
/// does not have.
const PARAMETERS: &[(&str, &str, &str, &str)] = &[
    ("ABS", "", "V", "V"),
    ("ACCRINT", "", "RRRRRRRR", "VVVVVVVV"),
    ("ACCRINTM", "", "RRRRR", "VVVVV"),
    ("ACOS", "", "V", "V"),
    ("ACOSH", "", "V", "V"),
    ("ACOT", "", "V", "V"),
    ("ACOTH", "", "V", "V"),
    ("ADDRESS", "", "VVVVV", "VVVVV"),
    ("AGGREGATE", "", "VVRRRR", "VVRVVV"),
    ("AMORDEGRC", "", "RRRRRRR", "VVVVVVV"),
    ("AMORLINC", "", "RRRRRRR", "VVVVVVV"),
    ("AND", "", "RRRR", "RRRR"),
    ("ARABIC", "", "V", "V"),
    ("AREAS", "", "R", "V"),
    ("ARRAYTOTEXT", "", "RV", "RV"),
    ("ASIN", "", "V", "V"),
    ("ASINH", "", "V", "V"),
    ("ATAN", "", "V", "V"),
    ("ATAN2", "", "VV", "VV"),
    ("ATANH", "", "V", "V"),
    ("AVEDEV", "", "RRRR", "RRRR"),
    ("AVERAGE", "", "RRRR", "RRRR"),
    ("AVERAGEA", "", "RRRR", "RRRR"),
    ("AVERAGEIF", "", "RVR", "VVV"),
    ("AVERAGEIFS", "", "RRVRVRV", "VVVVVVV"),
    ("BASE", "", "VVV", "VVV"),
    ("BESSELI", "", "RR", "VV"),
    ("BESSELJ", "", "RR", "VV"),
    ("BESSELK", "", "RR", "VV"),
    ("BESSELY", "", "RR", "VV"),
    ("BETA.DIST", "", "VVVVVV", "VVVVVV"),
    ("BETA.INV", "", "VVVVV", "VVVVV"),
    ("BETADIST", "", "VVVVV", "VVVVV"),
    ("BETAINV", "", "VVVVV", "VVVVV"),
    ("BIN2DEC", "", "R", "V"),
    ("BIN2HEX", "", "RR", "VV"),
    ("BIN2OCT", "", "RR", "VV"),
    ("BINOM.DIST", "", "VVVV", "VVVV"),
    ("BINOM.DIST.RANGE", "", "VVVV", "VVVV"),
    ("BINOM.INV", "", "VVV", "VVV"),
    ("BINOMDIST", "", "VVVV", "VVVV"),
    ("BITAND", "", "VV", "VV"),
    ("BITLSHIFT", "", "VV", "VV"),
    ("BITOR", "", "VV", "VV"),
    ("BITRSHIFT", "", "VV", "VV"),
    ("BITXOR", "", "VV", "VV"),
    ("BYCOL", "A", "PV", "PV"),
    ("BYROW", "A", "PV", "PV"),
    ("CEILING", "", "VV", "VV"),
    ("CEILING.MATH", "", "VVV", "VVV"),
    ("CEILING.PRECISE", "", "VV", "VV"),
    ("CELL", "AD", "VV", "VV"),
    ("CHAR", "", "V", "V"),
    ("CHIDIST", "", "VV", "VV"),
    ("CHIINV", "", "VV", "VV"),
    ("CHISQ.DIST", "", "VVV", "VVV"),
    ("CHISQ.DIST.RT", "", "VV", "VV"),
    ("CHISQ.INV", "", "VV", "VV"),
    ("CHISQ.INV.RT", "", "VV", "VV"),
    ("CHISQ.TEST", "", "RR", "RR"),
    ("CHISQDIST", "A", "PPPP", "PPPP"),
    ("CHITEST", "", "RR", "RR"),
    ("CHOOSE", "", "VPPPP", "PPPPP"),
    ("CHOOSECOLS", "A", "PVVVV", "PPPPP"),
    ("CHOOSEROWS", "A", "PVVVV", "PPPPP"),
    ("CLEAN", "", "V", "V"),
    ("CODE", "", "V", "V"),
    ("COLUMN", "", "V", "V"),
    ("COLUMNS", "", "R", "R"),
    ("COMBIN", "", "VV", "VV"),
    ("COMBINA", "", "VV", "VV"),
    ("COMPLEX", "", "RRR", "VVV"),
    ("CONCAT", "", "RRRR", "RRRR"),
    ("CONCATENATE", "", "VVVV", "VVVV"),
    ("CONFIDENCE", "", "VVV", "VVV"),
    ("CONFIDENCE.NORM", "", "VVV", "VVV"),
    ("CONFIDENCE.T", "", "VVV", "VVV"),
    ("CONVERT", "", "RRR", "VVV"),
    ("CORREL", "", "RR", "RR"),
    ("COS", "", "V", "V"),
    ("COSH", "", "V", "V"),
    ("COT", "", "V", "V"),
    ("COTH", "", "V", "V"),
    ("COUNT", "", "RRRR", "RRRR"),
    ("COUNTA", "", "RRRR", "RRRR"),
    ("COUNTBLANK", "", "R", "V"),
    ("COUNTIF", "", "RV", "VV"),
    ("COUNTIFS", "", "RVRVRVRV", "VVVVVVVV"),
    ("COUPDAYBS", "", "RRRR", "VVVV"),
    ("COUPDAYS", "", "RRRR", "VVVV"),
    ("COUPDAYSNC", "", "RRRR", "VVVV"),
    ("COUPNCD", "", "RRRR", "VVVV"),
    ("COUPNUM", "", "RRRR", "VVVV"),
    ("COUPPCD", "", "RRRR", "VVVV"),
    ("COVAR", "", "RR", "RR"),
    ("COVARIANCE.P", "", "RR", "RR"),
    ("COVARIANCE.S", "", "RR", "RR"),
    ("CRITBINOM", "", "VVV", "VVV"),
    ("CSC", "", "V", "V"),
    ("CSCH", "", "V", "V"),
    ("CUBEKPIMEMBER", "", "VVVV", "VVVV"),
    ("CUBEMEMBER", "", "VRV", "VRV"),
    ("CUBEMEMBERPROPERTY", "", "VVV", "VVV"),
    ("CUBERANKEDMEMBER", "", "VVVV", "VVVV"),
    ("CUBESET", "", "VRVVV", "VRVVV"),
    ("CUBESETCOUNT", "", "V", "V"),
    ("CUBEVALUE", "", "VRRR", "VRRR"),
    ("CUMIPMT", "", "RRRRRR", "VVVVVV"),
    ("CUMPRINC", "", "RRRRRR", "VVVVVV"),
    ("DATE", "", "VVV", "VVV"),
    ("DATEDIF", "", "VVV", "VVV"),
    ("DATEVALUE", "", "V", "V"),
    ("DAVERAGE", "", "RRR", "VVV"),
    ("DAY", "", "V", "V"),
    ("DAYS", "", "VV", "VV"),
    ("DAYS360", "", "VVV", "VVV"),
    ("DB", "", "VVVVV", "VVVVV"),
    ("DCOUNT", "", "RRR", "VVV"),
    ("DCOUNTA", "", "RRR", "VVV"),
    ("DDB", "", "VVVVV", "VVVVV"),
    ("DEC2BIN", "", "RR", "VV"),
    ("DEC2HEX", "", "RR", "VV"),
    ("DEC2OCT", "", "RR", "VV"),
    ("DECIMAL", "", "VV", "VV"),
    ("DEGREES", "", "V", "V"),
    ("DELTA", "", "RR", "VV"),
    ("DEVSQ", "", "RRRR", "RRRR"),
    ("DGET", "", "RRR", "VVV"),
    ("DISC", "", "RRRRR", "VVVVV"),
    ("DMAX", "", "RRR", "VVV"),
    ("DMIN", "", "RRR", "VVV"),
    ("DOLLAR", "", "VV", "VV"),
    ("DOLLARDE", "", "RR", "VV"),
    ("DOLLARFR", "", "RR", "VV"),
    ("DPRODUCT", "", "RRR", "VVV"),
    ("DROP", "A", "PVV", "PVV"),
    ("DSTDEV", "", "RRR", "VVV"),
    ("DSTDEVP", "", "RRR", "VVV"),
    ("DSUM", "", "RRR", "VVV"),
    ("DURATION", "", "RRRRRR", "VVVVVV"),
    ("DVAR", "", "RRR", "VVV"),
    ("DVARP", "", "RRR", "VVV"),
    ("EDATE", "", "RR", "VV"),
    ("EFFECT", "", "RR", "VV"),
    ("ENCODEURL", "", "V", "V"),
    ("EOMONTH", "", "RR", "VV"),
    ("ERF", "", "RR", "VV"),
    ("ERF.PRECISE", "", "R", "V"),
    ("ERFC", "", "R", "V"),
    ("ERFC.PRECISE", "", "R", "V"),
    ("ERROR.TYPE", "", "V", "V"),
    ("EURO", "A", "PPP", "PPP"),
    ("EVEN", "", "V", "V"),
    ("EXACT", "", "VV", "VV"),
    ("EXP", "", "V", "V"),
    ("EXPAND", "A", "PVVV", "PVVP"),
    ("EXPON.DIST", "", "VVV", "VVV"),
    ("EXPONDIST", "", "VVV", "VVV"),
    ("F.DIST", "", "VVVV", "VVVV"),
    ("F.DIST.RT", "", "VVV", "VVV"),
    ("F.INV", "", "VVV", "VVV"),
    ("F.INV.RT", "", "VVV", "VVV"),
    ("F.TEST", "", "RR", "RR"),
    ("FACT", "", "V", "V"),
    ("FACTDOUBLE", "", "R", "V"),
    ("FALSE", "", "", ""),
    ("FDIST", "", "VVV", "VVV"),
    ("FILTER", "A", "PPV", "PPP"),
    ("FIND", "", "VVV", "VVV"),
    ("FINV", "", "VVV", "VVV"),
    ("FISHER", "", "V", "V"),
    ("FISHERINV", "", "V", "V"),
    ("FIXED", "", "VVV", "VVV"),
    ("FLOOR", "", "VV", "VV"),
    ("FLOOR.MATH", "", "VVV", "VVV"),
    ("FLOOR.PRECISE", "", "VV", "VV"),
    ("FORECAST", "", "VRR", "VRR"),
    ("FORECAST.ETS", "", "VRRVVV", "VRRVVV"),
    ("FORECAST.ETS.CONFINT", "", "VRRVVVV", "VRRVVVV"),
    ("FORECAST.ETS.SEASONALITY", "", "RRVV", "RRVV"),
    ("FORECAST.ETS.STAT", "", "RRVVVV", "RRVVVV"),
    ("FORECAST.LINEAR", "", "VRR", "VRR"),
    ("FORMULATEXT", "", "V", "V"),
    ("FREQUENCY", "A", "PP", "PP"),
    ("FTEST", "", "RR", "RR"),
    ("FV", "", "VVVVV", "VVVVV"),
    ("FVSCHEDULE", "", "RR", "VR"),
    ("GAMMA", "", "V", "V"),
    ("GAMMA.DIST", "", "VVVV", "VVVV"),
    ("GAMMA.INV", "", "VVV", "VVV"),
    ("GAMMADIST", "", "VVVV", "VVVV"),
    ("GAMMAINV", "", "VVV", "VVV"),
    ("GAMMALN", "", "V", "V"),
    ("GAMMALN.PRECISE", "", "V", "V"),
    ("GAUSS", "", "V", "V"),
    ("GCD", "", "RRRRR", "RRRRR"),
    ("GEOMEAN", "", "RRRR", "RRRR"),
    ("GESTEP", "", "RR", "VV"),
    ("GETPIVOTDATA", "", "RRVVVVVV", "VVVVVVVV"),
    ("GROUPBY", "A", "PPPVVPPV", "PPPVVPPV"),
    ("GROWTH", "A", "PPPP", "PPPV"),
    ("HARMEAN", "", "RRRR", "RRRR"),
    ("HEX2BIN", "", "RR", "VV"),
    ("HEX2DEC", "", "R", "V"),
    ("HEX2OCT", "", "RR", "VV"),
    ("HLOOKUP", "", "VRVV", "VRVV"),
    ("HOUR", "", "V", "V"),
    ("HSTACK", "A", "PPPP", "PPPP"),
    ("HYPGEOM.DIST", "", "VVVVV", "VVVVV"),
    ("HYPGEOMDIST", "", "VVVV", "VVVV"),
    ("IF", "", "VPP", "PPP"),
    ("IFERROR", "", "VV", "VV"),
    ("IFNA", "", "VV", "VV"),
    ("IFS", "A", "VPVPVPVP", "PPPPPPPP"),
    ("IMABS", "", "R", "V"),
    ("IMAGINARY", "", "R", "V"),
    ("IMARGUMENT", "", "R", "V"),
    ("IMCONJUGATE", "", "R", "V"),
    ("IMCOS", "", "R", "V"),
    ("IMCOSH", "", "R", "V"),
    ("IMCOT", "", "R", "V"),
    ("IMCSC", "", "R", "V"),
    ("IMCSCH", "", "R", "V"),
    ("IMDIV", "", "RR", "VV"),
    ("IMEXP", "", "R", "V"),
    ("IMLN", "", "R", "V"),
    ("IMLOG10", "", "R", "V"),
    ("IMLOG2", "", "R", "V"),
    ("IMPOWER", "", "RR", "VV"),
    ("IMPRODUCT", "", "RRRR", "RRRR"),
    ("IMREAL", "", "R", "V"),
    ("IMSEC", "", "R", "V"),
    ("IMSECH", "", "R", "V"),
    ("IMSIN", "", "R", "V"),
    ("IMSINH", "", "R", "V"),
    ("IMSQRT", "", "R", "V"),
    ("IMSUB", "", "RR", "VV"),
    ("IMSUM", "", "RRRR", "RRRR"),
    ("IMTAN", "", "R", "V"),
    ("INDEX", "", "PVVV", "PVVV"),
    ("INDIRECT", "A", "VV", "VV"),
    ("INT", "", "V", "V"),
    ("INTERCEPT", "", "RR", "RR"),
    ("INTRATE", "", "RRRRR", "VVVVV"),
    ("IPMT", "", "VVVVVV", "VVVVVV"),
    ("IRR", "", "RV", "RV"),
    ("ISBLANK", "", "V", "V"),
    ("ISERR", "", "V", "V"),
    ("ISERROR", "", "V", "V"),
    ("ISEVEN", "", "R", "V"),
    ("ISFORMULA", "", "V", "V"),
    ("ISLOGICAL", "", "V", "V"),
    ("ISNA", "", "V", "V"),
    ("ISNONTEXT", "", "V", "V"),
    ("ISNUMBER", "", "V", "V"),
    ("ISO.CEILING", "", "VV", "VV"),
    ("ISODD", "", "R", "V"),
    ("ISOWEEKNUM", "", "V", "V"),
    ("ISPMT", "", "VVVV", "VVVV"),
    ("ISREF", "", "R", "R"),
    ("ISTEXT", "", "V", "V"),
    ("KURT", "", "RRRR", "RRRR"),
    ("LARGE", "", "RV", "RV"),
    ("LCM", "", "RRRRR", "RRRRR"),
    ("LEFT", "", "VV", "VV"),
    ("LEN", "", "V", "V"),
    ("LINEST", "A", "PPPP", "PPVV"),
    ("LN", "", "V", "V"),
    ("LOG", "", "VV", "VV"),
    ("LOG10", "", "V", "V"),
    ("LOGEST", "A", "PPPP", "PPVV"),
    ("LOGINV", "", "VVV", "VVV"),
    ("LOGNORM.DIST", "", "VVVV", "VVVV"),
    ("LOGNORM.INV", "", "VVV", "VVV"),
    ("LOGNORMDIST", "", "VVV", "VVV"),
    ("LOOKUP", "", "VRR", "VRR"),
    ("LOWER", "", "V", "V"),
    ("MAKEARRAY", "A", "VVP", "VVP"),
    ("MAP", "A", "PPPPPP", "PPPPPP"),
    ("MATCH", "", "VRR", "VRV"),
    ("MAX", "", "RRRR", "RRRR"),
    ("MAXA", "", "RRRR", "RRRR"),
    ("MAXIFS", "", "RRVRVRV", "VVVVVVV"),
    ("MDETERM", "", "R", "R"),
    ("MDURATION", "", "RRRRRR", "VVVVVV"),
    ("MEDIAN", "", "RRRR", "RRRR"),
    ("MID", "", "VVV", "VVV"),
    ("MIN", "", "RRRR", "RRRR"),
    ("MINA", "", "RRRR", "RRRR"),
    ("MINIFS", "", "RRVRVRV", "VVVVVVV"),
    ("MINUTE", "", "V", "V"),
    ("MINVERSE", "A", "P", "P"),
    ("MIRR", "", "RVV", "RVV"),
    ("MMULT", "A", "PP", "PP"),
    ("MOD", "", "VV", "VV"),
    ("MODE", "", "RRRR", "RRRR"),
    ("MODE.MULT", "A", "PPPP", "PPPP"),
    ("MODE.SNGL", "", "RRRR", "RRRR"),
    ("MONTH", "", "V", "V"),
    ("MROUND", "", "RR", "VV"),
    ("MULTINOMIAL", "", "RRRR", "RRRR"),
    ("MUNIT", "A", "V", "V"),
    ("N", "", "R", "V"),
    ("NA", "", "", ""),
    ("NEGBINOM.DIST", "", "VVVV", "VVVV"),
    ("NEGBINOMDIST", "", "VVV", "VVV"),
    ("NETWORKDAYS", "", "RRR", "VVR"),
    ("NETWORKDAYS.INTL", "", "RRVR", "VVVR"),
    ("NOMINAL", "", "RR", "VV"),
    ("NORM.DIST", "", "VVVV", "VVVV"),
    ("NORM.INV", "", "VVV", "VVV"),
    ("NORM.S.DIST", "", "VV", "VV"),
    ("NORM.S.INV", "", "V", "V"),
    ("NORMDIST", "", "VVVV", "VVVV"),
    ("NORMINV", "", "VVV", "VVV"),
    ("NORMSDIST", "", "V", "V"),
    ("NORMSINV", "", "V", "V"),
    ("NOT", "", "V", "V"),
    ("NOW", "", "", ""),
    ("NPER", "", "VVVVV", "VVVVV"),
    ("NPV", "", "VRRRR", "VRRRR"),
    ("NUMBERVALUE", "", "VVV", "VVV"),
    ("OCT2BIN", "", "RR", "VV"),
    ("OCT2DEC", "", "R", "V"),
    ("OCT2HEX", "", "RR", "VV"),
    ("ODD", "", "V", "V"),
    ("ODDFPRICE", "", "RRRRRRRR", "VVVVVVVV"),
    ("ODDFYIELD", "", "RRRRRRRR", "VVVVVVVV"),
    ("ODDLPRICE", "", "RRRRRRRR", "VVVVVVVV"),
    ("ODDLYIELD", "", "RRRRRRRR", "VVVVVVVV"),
    ("OFFSET", "", "PVVVV", "VVVVV"),
    ("OR", "", "RRRR", "RRRR"),
    ("PDURATION", "", "VVV", "VVV"),
    ("PEARSON", "", "RR", "RR"),
    ("PERCENTILE", "", "RV", "RV"),
    ("PERCENTILE.EXC", "", "RV", "RV"),
    ("PERCENTILE.INC", "", "RV", "RV"),
    ("PERCENTRANK", "", "RVV", "RVV"),
    ("PERCENTRANK.EXC", "", "RVV", "RVV"),
    ("PERCENTRANK.INC", "", "RVV", "RVV"),
    ("PERMUT", "", "VV", "VV"),
    ("PERMUTATIONA", "", "VV", "VV"),
    ("PHI", "", "V", "V"),
    ("PI", "", "", ""),
    ("PIVOTBY", "A", "PPPP", "PPPP"),
    ("PMT", "", "VVVVV", "VVVVV"),
    ("POISSON", "", "VVV", "VVV"),
    ("POISSON.DIST", "", "VVV", "VVV"),
    ("POISSONDIST", "A", "PPPP", "PPPP"),
    ("POWER", "", "VV", "VV"),
    ("PPMT", "", "VVVVVV", "VVVVVV"),
    ("PRICE", "", "RRRRRRR", "VVVVVVV"),
    ("PRICEDISC", "", "RRRRR", "VVVVV"),
    ("PRICEMAT", "", "RRRRRR", "VVVVVV"),
    ("PROB", "", "RRVV", "RRVV"),
    ("PRODUCT", "", "RRRR", "RRRR"),
    ("PROPER", "", "V", "V"),
    ("PV", "", "VVVVV", "VVVVV"),
    ("QUARTILE", "", "RV", "RV"),
    ("QUARTILE.EXC", "", "RV", "RV"),
    ("QUARTILE.INC", "", "RV", "RV"),
    ("QUOTIENT", "", "RR", "VV"),
    ("RADIANS", "", "V", "V"),
    ("RAND", "", "", ""),
    ("RANDARRAY", "A", "VVVVV", "VVVVV"),
    ("RANDBETWEEN", "", "RR", "VV"),
    ("RANK", "", "VRV", "VVV"),
    ("RANK.AVG", "", "VRV", "VVV"),
    ("RANK.EQ", "", "VRV", "VVV"),
    ("RATE", "", "VVVVVV", "VVVVVV"),
    ("RECEIVED", "", "RRRRR", "VVVVV"),
    ("REDUCE", "A", "PPV", "PPV"),
    ("REPLACE", "", "VVVV", "VVVV"),
    ("REPT", "", "VV", "VV"),
    ("RIGHT", "", "VV", "VV"),
    ("ROMAN", "", "VV", "VV"),
    ("ROUND", "", "VV", "VV"),
    ("ROUNDDOWN", "", "VV", "VV"),
    ("ROUNDUP", "", "VV", "VV"),
    ("ROW", "", "V", "V"),
    ("ROWS", "", "R", "R"),
    ("RRI", "", "VVV", "VVV"),
    ("RSQ", "", "RR", "RR"),
    ("SCAN", "A", "PPV", "PPV"),
    ("SEARCH", "", "VVV", "VVV"),
    ("SEC", "", "V", "V"),
    ("SECH", "", "V", "V"),
    ("SECOND", "", "V", "V"),
    ("SEQUENCE", "A", "VVVV", "VVVV"),
    ("SERIESSUM", "", "RRRR", "VVVR"),
    ("SHEET", "", "R", "R"),
    ("SHEETS", "", "R", "R"),
    ("SIGN", "", "V", "V"),
    ("SIN", "", "V", "V"),
    ("SINH", "", "V", "V"),
    ("SKEW", "", "RRRR", "RRRR"),
    ("SKEW.P", "", "RRRR", "RRRR"),
    ("SLN", "", "VVV", "VVV"),
    ("SLOPE", "", "RR", "RR"),
    ("SMALL", "", "RV", "RV"),
    ("SORT", "A", "PPPV", "PPPV"),
    ("SORTBY", "A", "PPVPVPV", "PPVPVPV"),
    ("SQRT", "", "V", "V"),
    ("SQRTPI", "", "R", "V"),
    ("STANDARDIZE", "", "VVV", "VVV"),
    ("STDEV", "", "RRRR", "RRRR"),
    ("STDEV.P", "", "RRRR", "RRRR"),
    ("STDEV.S", "", "RRRR", "RRRR"),
    ("STDEVA", "", "RRRR", "RRRR"),
    ("STDEVP", "", "RRRR", "RRRR"),
    ("STDEVPA", "", "RRRR", "RRRR"),
    ("STEYX", "", "RR", "RR"),
    ("SUBSTITUTE", "", "VVVV", "VVVV"),
    ("SUBTOTAL", "", "VRRRR", "VVVVV"),
    ("SUM", "", "RRRR", "RRRR"),
    ("SUMIF", "", "RVR", "VVV"),
    ("SUMIFS", "", "RRVRVRV", "VVVVVVV"),
    ("SUMPRODUCT", "", "RRRR", "RRRR"),
    ("SUMSQ", "", "RRRR", "RRRR"),
    ("SUMX2MY2", "", "RR", "RR"),
    ("SUMX2PY2", "", "RR", "RR"),
    ("SUMXMY2", "", "RR", "RR"),
    ("SWITCH", "A", "VVPVPVP", "PPPPPPP"),
    ("SYD", "", "VVVV", "VVVV"),
    ("T", "", "R", "V"),
    ("T.DIST", "", "VVV", "VVV"),
    ("T.DIST.2T", "", "VV", "VV"),
    ("T.DIST.RT", "", "VV", "VV"),
    ("T.INV", "", "VV", "VV"),
    ("T.INV.2T", "", "VV", "VV"),
    ("T.TEST", "", "RRVV", "RRVV"),
    ("TAKE", "A", "PVV", "PVV"),
    ("TAN", "", "V", "V"),
    ("TANH", "", "V", "V"),
    ("TBILLEQ", "", "RRR", "VVV"),
    ("TBILLPRICE", "", "RRR", "VVV"),
    ("TBILLYIELD", "", "RRR", "VVV"),
    ("TDIST", "", "VVV", "VVV"),
    ("TEXT", "", "VV", "VV"),
    ("TEXTAFTER", "", "VVVVVV", "VRVVVV"),
    ("TEXTBEFORE", "", "VVVVVV", "VRVVVV"),
    ("TEXTJOIN", "", "RVRRRR", "RVRRRR"),
    ("TEXTSPLIT", "A", "VVVVVV", "VPPVVP"),
    ("TIME", "", "VVV", "VVV"),
    ("TIMEVALUE", "", "V", "V"),
    ("TINV", "", "VV", "VV"),
    ("TOCOL", "A", "PVV", "PVV"),
    ("TODAY", "", "", ""),
    ("TOROW", "A", "PVV", "PVV"),
    ("TRANSPOSE", "A", "V", "P"),
    ("TREND", "A", "PPPP", "PPPV"),
    ("TRIM", "", "V", "V"),
    ("TRIMMEAN", "", "RV", "RV"),
    ("TRIMRANGE", "A", "PVV", "PVV"),
    ("TRUE", "", "", ""),
    ("TRUNC", "", "VV", "VV"),
    ("TTEST", "", "RRVV", "RRVV"),
    ("TYPE", "", "V", "R"),
    ("UNICHAR", "", "V", "V"),
    ("UNICODE", "", "V", "V"),
    ("UNIQUE", "A", "PVV", "PVV"),
    ("UPPER", "", "V", "V"),
    ("VALUE", "", "V", "V"),
    ("VALUETOTEXT", "", "VV", "VV"),
    ("VAR", "", "RRRR", "RRRR"),
    ("VAR.P", "", "RRRR", "RRRR"),
    ("VAR.S", "", "RRRR", "RRRR"),
    ("VARA", "", "RRRR", "RRRR"),
    ("VARP", "", "RRRR", "RRRR"),
    ("VARPA", "", "RRRR", "RRRR"),
    ("VDB", "", "VVVVVVV", "VVVVVVV"),
    ("VLOOKUP", "", "VRVV", "VRVV"),
    ("VSTACK", "A", "PPPP", "PPPP"),
    ("WEEKDAY", "", "VV", "VV"),
    ("WEEKNUM", "", "RR", "VV"),
    ("WEIBULL", "", "VVVV", "VVVV"),
    ("WEIBULL.DIST", "", "VVVV", "VVVV"),
    ("WORKDAY", "", "RRR", "VVR"),
    ("WORKDAY.INTL", "", "RRVR", "VVVR"),
    ("WRAPCOLS", "A", "PVV", "PVV"),
    ("WRAPROWS", "A", "PVV", "PVV"),
    ("XIRR", "", "RRR", "RRV"),
    ("XLOOKUP", "", "VRPPVV", "VRPPVV"),
    ("XMATCH", "", "VRVV", "VRVV"),
    ("XNPV", "", "RRR", "VRR"),
    ("XOR", "", "RRRR", "RRRR"),
    ("YEAR", "", "V", "V"),
    ("YEARFRAC", "", "RRR", "VVV"),
    ("YIELD", "", "RRRRRRR", "VVVVVVV"),
    ("YIELDDISC", "", "RRRRR", "VVVVV"),
    ("YIELDMAT", "", "RRRRRR", "VVVVVV"),
    ("Z.TEST", "", "RVV", "RVV"),
    ("ZTEST", "", "RVV", "RVV"),
];

/// A parameter's class (see the module header), in order of strictness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Class {
    Whole,
    Spreads,
    Lifted,
}

fn class_of(code: u8) -> Class {
    match code {
        b'R' => Class::Whole,
        b'P' => Class::Spreads,
        _ => Class::Lifted,
    }
}

/// The class at 0-based position `at` of a class string.
fn class_at(classes: &str, at: usize) -> Class {
    let s = classes.as_bytes();
    let n = s.len();
    if n == 0 {
        return Class::Lifted;
    }
    if at < n {
        return class_of(s[at]);
    }
    let pair = n >= 4 && s[n - 1] == s[n - 3] && s[n - 2] == s[n - 4] && s[n - 1] != s[n - 2];
    if pair {
        class_of(s[n - 2 + (at - n) % 2])
    } else {
        class_of(s[n - 1])
    }
}

/// What an argument is to Excel's parameter table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// A reference: a cell, a range, a table, `OFFSET`/`INDIRECT`, an `INDEX`
    /// or `IF`/`CHOOSE` of references.
    Reference,
    /// An array constant.
    Array,
    /// A computed value: the stricter of the two classes applies.
    Computed,
}

/// How each defined name reads to Excel's flag: whether it may be multi-cell
/// and what kind of argument it is. A name defined in several scopes is
/// multi-cell if any definition is; a name the workbook does not define is a
/// doubt, so multi-cell.
#[derive(Debug, Default)]
pub(crate) struct NameShapes {
    names: HashMap<String, (bool, Kind)>,
}

impl NameShapes {
    pub(crate) fn of(workbook: &crate::Workbook) -> Self {
        let mut names: HashMap<String, (bool, Kind)> = HashMap::new();
        for nr in &workbook.named_ranges {
            let shape = name_shape(&nr.refers_to);
            names
                .entry(nr.name.to_uppercase())
                .and_modify(|seen| {
                    seen.0 |= shape.0;
                    if seen.1 != shape.1 {
                        seen.1 = Kind::Computed;
                    }
                })
                .or_insert(shape);
        }
        NameShapes { names }
    }

    fn get(&self, name: &str) -> (bool, Kind) {
        self.names.get(&name.to_uppercase()).copied().unwrap_or((true, Kind::Computed))
    }
}

/// One definition's shape [LIVE: `ABS(MyC)` plain for `=Sheet1!$A$2`, as for
/// `=5`, `=-5`, `="x"`, `=TRUE`, `=#N/A`, `=Sheet2!$A$1` and the relative
/// `=Sheet1!A1`; dynamic for `=Sheet1!$A$1:$A$3`, `={1,2,3}`,
/// `=Sheet1!$A$1+1`, `=OFFSET(..)`, `=Tbl[P]` and `=(5)`].
fn name_shape(refers_to: &str) -> (bool, Kind) {
    let text = refers_to.trim();
    let text = text.strip_prefix('=').unwrap_or(text).trim_start();
    if text.starts_with('(') {
        return (true, Kind::Computed);
    }
    match parser::parse(text) {
        Ok(E::Literal(_)) => (false, Kind::Computed),
        Ok(E::UnaryOp { operand, .. }) if matches!(*operand, E::Literal(Value::Number(_))) => (false, Kind::Computed),
        Ok(E::CellRef { .. }) => (false, Kind::Reference),
        Ok(E::TableRef { specifier: TableSpecifier::ThisRow(_), .. }) => (false, Kind::Reference),
        Ok(E::Range { .. } | E::ColumnRef { .. } | E::RowRef { .. } | E::Sheet3DRef { .. } | E::TableRef { .. }) => {
            (true, Kind::Reference)
        }
        Ok(E::ArrayLiteral { .. }) => (true, Kind::Array),
        _ => (true, Kind::Computed),
    }
}

/// Whether Excel saves this single-cell formula (Calcula's stored text, no
/// `=`) as a DYNAMIC one (see the module header). A text the parser cannot
/// read is written as it always was, plain.
pub(crate) fn excel_saves_dynamic(formula: &str, names: &NameShapes) -> bool {
    match parser::parse(formula) {
        Ok(ast) => {
            let mut walk = Walk { names, scope: Vec::new() };
            walk.dynamic(&ast) || walk.array(&ast)
        }
        Err(_) => false,
    }
}

/// Upper-case canonical name of a call's function.
fn function_name(func: &BuiltinFunction) -> String {
    func.to_canonical_name().to_ascii_uppercase()
}

fn parameters(name: &str) -> Option<(&'static str, &'static str, &'static str)> {
    PARAMETERS
        .binary_search_by(|row| row.0.cmp(name))
        .ok()
        .map(|at| (PARAMETERS[at].1, PARAMETERS[at].2, PARAMETERS[at].3))
}

/// The walk: the defined names, and the LET / LAMBDA names in scope with
/// their shape.
struct Walk<'a> {
    names: &'a NameShapes,
    scope: Vec<(String, bool, Kind)>,
}

impl Walk<'_> {
    fn name(&self, name: &str) -> (bool, Kind) {
        match self.scope.iter().rev().find(|(n, _, _)| n.eq_ignore_ascii_case(name)) {
            Some(&(_, multi, kind)) => (multi, kind),
            None => self.names.get(name),
        }
    }

    /// Binds a LET's names in order (each value seen with the names before
    /// it), returning the scope depth to truncate back to and whether a
    /// value itself forced dynamic.
    fn bind_let(&mut self, args: &[E]) -> (usize, bool) {
        let depth = self.scope.len();
        let mut forced = false;
        let pairs = args.len().saturating_sub(1) / 2;
        for pair in args[..pairs * 2].chunks(2) {
            if let [E::NamedRef { name, .. }, value] = pair {
                forced |= self.dynamic(value);
                let multi = self.array(value);
                let kind = self.kind(value);
                self.scope.push((name.clone(), multi, kind));
            }
        }
        (depth, forced)
    }

    /// A LAMBDA's parameters, each one value.
    fn bind_lambda(&mut self, args: &[E]) -> usize {
        let depth = self.scope.len();
        for param in &args[..args.len().saturating_sub(1)] {
            if let E::NamedRef { name, .. } = param {
                self.scope.push((name.clone(), false, Kind::Computed));
            }
        }
        depth
    }

    fn kind(&self, expr: &E) -> Kind {
        // A sheet-qualified NAME (`Sheet1!Dup`, or `[0]!Dup` read as one) is
        // that name, whatever a LET binds (lane form4; [LIVE, Excel 16,
        // SCRATCH/form4/p2.xlsx] Excel files `=Sheet1!Dup` over `=2` as a
        // plain `<f>` and reads it back without an `@`).
        if let Some((_, name)) = parser::parser::qualified_name_parts(expr) {
            return self.names.get(name).1;
        }
        match expr {
            E::CellRef { .. }
            | E::Range { .. }
            | E::ColumnRef { .. }
            | E::RowRef { .. }
            | E::Sheet3DRef { .. }
            | E::TableRef { .. }
            | E::SpillRef { .. } => Kind::Reference,
            E::BinaryOp { op: BinaryOperator::Intersect, .. } => Kind::Reference,
            E::ArrayLiteral { .. } => Kind::Array,
            E::NamedRef { name, .. } => self.name(name).1,
            E::FunctionCall { func, args, .. } => match function_name(func).as_str() {
                "OFFSET" | "INDIRECT" => Kind::Reference,
                "INDEX" => match args.first() {
                    Some(first) if self.kind(first) == Kind::Reference => Kind::Reference,
                    _ => Kind::Computed,
                },
                "IF" | "CHOOSE" if args.len() > 1 && args[1..].iter().all(|a| self.kind(a) == Kind::Reference) => {
                    Kind::Reference
                }
                _ => Kind::Computed,
            },
            _ => Kind::Computed,
        }
    }

    /// The class of argument `at` of a call with this table row.
    fn class(&self, row: (&str, &str, &str), at: usize, arg: &E) -> Class {
        let (_, reference, array) = row;
        match self.kind(arg) {
            Kind::Reference => class_at(reference, at),
            Kind::Array => class_at(array, at),
            Kind::Computed => class_at(reference, at).max(class_at(array, at)),
        }
    }

    /// Whether `expr`'s value may be multi-cell, to Excel's static view.
    fn array(&mut self, expr: &E) -> bool {
        // A sheet-qualified name has the shape of its definitions (`kind`).
        if let Some((_, name)) = parser::parser::qualified_name_parts(expr) {
            return self.names.get(name).0;
        }
        match expr {
            E::Literal(_) | E::CellRef { .. } => false,
            E::Range { .. } | E::ColumnRef { .. } | E::RowRef { .. } | E::Sheet3DRef { .. } | E::SpillRef { .. } => true,
            E::TableRef { specifier, .. } => !matches!(specifier, TableSpecifier::ThisRow(_)),
            E::ArrayLiteral { .. } => true,
            E::NamedRef { name, .. } => self.name(name).0,
            E::BinaryOp { left, right, .. } => self.array(left) || self.array(right),
            E::UnaryOp { operand, .. } => self.array(operand),
            E::FunctionCall { func, args, .. } => self.call_array(func, args),
            _ => false,
        }
    }

    fn call_array(&mut self, func: &BuiltinFunction, args: &[E]) -> bool {
        let name = function_name(func);
        match name.as_str() {
            "LET" => {
                let (depth, _) = self.bind_let(args);
                let multi = args.last().is_some_and(|body| self.array(body));
                self.scope.truncate(depth);
                multi
            }
            "LAMBDA" => true,
            // [LIVE] `ABS(INDEX(A1:A5,2))`, `ABS(INDEX(A1:A5,MATCH(2,A1:A5,0)))`,
            // `ABS(INDEX(A1:A5,2,1))`, `ABS(INDEX(A1,A1,A1,A1))` plain;
            // `ABS(INDEX(A1:A5,D1))`, `(..,0)`, `(..,1+1)`, `(..,"2")`,
            // `(..,2,)`, `(..,2,D1)`, `ABS(INDEX({1,2,3},2))`, `ABS(INDEX(MyA,2))`
            // dynamic. The area number does not count.
            "INDEX" => {
                let Some(first) = args.first() else { return true };
                if self.kind(first) != Kind::Reference {
                    return true;
                }
                if args[1..].iter().take(2).any(|a| self.array(a)) {
                    return true;
                }
                if !self.array(first) {
                    return false;
                }
                let safe = |a: Option<&E>| match a {
                    Some(E::Literal(Value::Number(n))) => *n >= 1.0,
                    Some(E::FunctionCall { func, .. }) => function_name(func) == "MATCH",
                    _ => false,
                };
                !safe(args.get(1)) || (args.len() > 2 && !safe(args.get(2)))
            }
            // [LIVE] `ABS(OFFSET(A1,1,0))`, `(A1,D1,D1)`, `(A1,0,0,1)`,
            // `(A1,0,0,1,1)`, `(MyC,0,0)`, `(INDEX(A1:A5,2),0,0)` plain;
            // `(A1,0,0,3)`, `(A1,0,0,D1)`, `(A1,0,0,,1)`, `(A1,0,0,1+0,1)`,
            // `(A1,0,0,"1",1)`, `(A1:A1,0,0)` dynamic.
            "OFFSET" => {
                let one = |a: &E| matches!(a, E::Literal(Value::Number(n)) if *n == 1.0);
                args.first().is_some_and(|base| self.array(base))
                    || args.iter().skip(1).take(2).any(|a| self.array(a))
                    || args.iter().skip(3).any(|a| !one(a))
            }
            _ => match parameters(&name) {
                // A function Excel does not have: [LIVE] Excel holds a call to
                // an unknown function as a user-defined one, whose result may
                // be multi-cell (`ABS(EURO(A1))` dynamic, `SUM(EURO(A1:A3))`
                // plain).
                None => true,
                Some(row) => {
                    row.0.contains('A')
                        || (0..args.len()).any(|at| {
                            let arg = &args[at];
                            self.class(row, at, arg) != Class::Whole && self.array(arg)
                        })
                }
            },
        }
    }

    /// Whether anything inside `expr` makes the formula dynamic.
    fn dynamic(&mut self, expr: &E) -> bool {
        match expr {
            E::BinaryOp { left, op, right } => {
                (*op != BinaryOperator::Intersect && (self.array(left) || self.array(right)))
                    || self.dynamic(left)
                    || self.dynamic(right)
            }
            E::UnaryOp { operand, .. } => self.array(operand) || self.dynamic(operand),
            E::FunctionCall { func, args, .. } => self.call_dynamic(func, args),
            E::Range { start, end, .. } => self.dynamic(start) || self.dynamic(end),
            E::Sheet3DRef { reference, .. } => self.dynamic(reference),
            E::IndexAccess { target, index } => self.dynamic(target) || self.dynamic(index),
            E::ArrayLiteral { rows } => rows.iter().flatten().any(|e| self.dynamic(e)),
            E::ListLiteral { elements } => elements.iter().any(|e| self.dynamic(e)),
            E::DictLiteral { entries } => entries.iter().any(|(k, v)| self.dynamic(k) || self.dynamic(v)),
            E::SpillRef { cell, .. } => self.dynamic(cell),
            E::ImplicitIntersection { operand } => self.dynamic(operand),
            _ => false,
        }
    }

    fn call_dynamic(&mut self, func: &BuiltinFunction, args: &[E]) -> bool {
        let name = function_name(func);
        match name.as_str() {
            // [LIVE] `LET(a,A1:A3,SUM(a))` plain, `LET(a,A1:A3,SUM(LEN(a)))`
            // dynamic, `LET(MyR,1,ABS(MyR))` plain: a binding takes its value
            // whole and the name carries its shape into the body.
            "LET" => {
                let (depth, forced) = self.bind_let(args);
                let body = forced || args.last().is_some_and(|b| self.dynamic(b));
                self.scope.truncate(depth);
                body
            }
            // Excel saves every LAMBDA dynamic ([LIVE] `LAMBDA(x,SUM(x))(A1:A3)`).
            "LAMBDA" => {
                let depth = self.bind_lambda(args);
                let _ = args.last().map(|b| self.dynamic(b));
                self.scope.truncate(depth);
                true
            }
            _ => match parameters(&name) {
                // A user-defined function takes each argument whole.
                None => args.iter().any(|a| self.dynamic(a)),
                Some(row) => {
                    if row.0.contains('D') {
                        return true;
                    }
                    (0..args.len()).any(|at| {
                        let arg = &args[at];
                        (self.class(row, at, arg) == Class::Lifted && self.array(arg)) || self.dynamic(arg)
                    })
                }
            },
        }
    }
}

// ============================================================================
// READING A LEGACY FORMULA (BUG-0645 item 4)
// ============================================================================

/// A LEGACY formula's text (an `<f>` in a `<c>` with no `cm`, Calcula's
/// stored text, no `=`) as Excel reads it: with every implicit intersection
/// written out as `@`, or `None` when it has none -- a formula Excel saves
/// plain ([`excel_saves_dynamic`]) reads the same either way, so it is never
/// touched, and a Calcula export's own plain formulas come back as written.
///
/// EXCEL'S READING, MEASURED [LIVE, Excel 16, 2026-11-06, lane xlsx
/// probe1/probe2: 172 formulas set with `Range.Formula` -- a legacy formula --
/// in a fresh workbook beside A1:A5, B1:B5, C1:C3 and `MyR` = `$A$1:$A$3`, and
/// read back with `Formula2`; the table is
/// `xlsx_formula_text_names_tests::a_legacy_formula_reads_as_excel_shows_it`]:
///
/// - A multi-cell REFERENCE where one value is taken -- the top, an operand,
///   a lifted parameter (`V` in [`PARAMETERS`]) -- is intersected:
///   `@A1:A5`, `@A1:A3+1`, `SUM(@A1:A3*2)`, `SUM(LEN(@C1:C3))`, `@MyR`,
///   `COUNTIF(A1:A5,@A1:A3)`; one a parameter takes whole is not
///   (`SUM(A1:A3)`, `SUM(MyR)`, `N(A1:A3)`). An intersection is multi-cell
///   only when both sides are (`ABS(A1:A3 A2)` stays).
/// - A call whose result may be multi-cell is intersected where one value is
///   taken at the top level (`@INDEX(A1:A5,D1)`, `ABS(@INDEX(..))`,
///   `@IF(A1>0,A1:A3,B1:B3)`, `@TRANSPOSE(..)`, `@MMULT(..)`,
///   `@SEQUENCE(3)`, `@FILTER(..)`, `LEN(@OFFSET(A1,0,0,3))`); inside a
///   parameter taken whole only a REFERENCE call is (`SUM(ABS(@INDEX(..)))`,
///   `SUM(LEN(@OFFSET(..)))`, but `SUM(ABS(SEQUENCE(3)))`,
///   `SUM(LEN(TRANSPOSE(@A1:A3)))`). An array constant likewise at the top
///   level only (`ABS(@{1,-2})`, `@{1,2,3}`, but `SUM(ABS({1,-2}))`).
/// - `ROW` / `COLUMN` of a multi-cell reference is intersected anywhere but in
///   an array parameter (`@ROW(A1:A3)`, `SUM(@ROW(A1:A3))`,
///   `SUMPRODUCT(ROW(A1:A3))`).
/// - An ARRAY parameter (every parameter of a function whose result is an
///   array, `SUMPRODUCT`'s, `INDEX`'s first, `LOOKUP`'s vectors, the paired
///   statistics') evaluates its argument as an array: nothing in it is
///   intersected (`SUMPRODUCT(LEN(A1:A3))`, `@INDEX(A1:A3*2,1)`,
///   `SUMPRODUCT(SUM(A1:A3*2))`, `@FILTER(A1:A5,A1:A5>1)`) -- but for
///   `IF`'s condition and `TRANSPOSE`'s argument, whose references are always
///   intersected (`SUMPRODUCT(IF(@A1:A3>1,1,0))`, `@TRANSPOSE(@A1:A3*2)`,
///   `@MMULT(TRANSPOSE(@A1:A3),A1:A3)`).
/// - `XLOOKUP`'s result is one value when its lookup value is
///   (`XLOOKUP(1,A1:A5,B1:B5)+1` stays).
///
/// Known differences, each a formula still read as a dynamic one: an array
/// constant in a lifted parameter inside a parameter taken whole
/// (`SUM(VLOOKUP(A1,A1:B5,{1,2},FALSE))` is Excel's
/// `SUM(VLOOKUP(A1,A1:B5,@{1,2},FALSE))`), and the functions this table has
/// no row for.
pub(crate) fn legacy_formula_text(formula: &str, names: &NameShapes) -> Option<String> {
    if !excel_saves_dynamic(formula, names) {
        return None;
    }
    let ast = parser::parse(formula).ok()?;
    let mut walk = Walk { names, scope: Vec::new() };
    let read = walk.legacy(&ast, true, Legacy::Top);
    (read != ast).then(|| engine::ast_render::render_formula_raw(&read))
}

/// Where in a legacy formula a sub-expression sits (see
/// [`legacy_formula_text`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Legacy {
    /// Outside every parameter taken whole: the top level.
    Top,
    /// Inside a parameter that takes its argument whole (`SUM`'s).
    Whole,
    /// Inside an ARRAY parameter: nothing is intersected.
    Array,
    /// `IF`'s condition, `TRANSPOSE`'s argument: references are intersected,
    /// calls and constants are not.
    References,
}

/// The legacy ARRAY parameters of the functions whose result is no array
/// (those, flag `A`, take every parameter as an array): 0-based positions,
/// `None` for all.
fn legacy_array_parameters(name: &str) -> Option<Option<&'static [usize]>> {
    const PAIRS: &[usize] = &[0, 1];
    Some(match name {
        "SUMPRODUCT" | "MDETERM" => None,
        "INDEX" => Some(&[0]),
        "LOOKUP" | "FORECAST" | "FORECAST.LINEAR" => Some(&[1, 2]),
        "CORREL" | "PEARSON" | "RSQ" | "SLOPE" | "INTERCEPT" | "STEYX" | "COVAR" | "COVARIANCE.P" | "COVARIANCE.S"
        | "SUMX2MY2" | "SUMX2PY2" | "SUMXMY2" | "TTEST" | "T.TEST" | "FTEST" | "F.TEST" | "CHITEST" | "CHISQ.TEST"
        | "PROB" => Some(PAIRS),
        _ => return None,
    })
}

impl Walk<'_> {
    /// `expr` read as a legacy formula: `value` when one value is taken where
    /// it sits (the top, an operand, a lifted parameter).
    fn legacy(&mut self, expr: &E, value: bool, at: Legacy) -> E {
        let intersect = |e: E| E::ImplicitIntersection { operand: Box::new(e) };
        match expr {
            E::BinaryOp { left, op: BinaryOperator::Intersect, right } => {
                let multi = self.array(left) && self.array(right);
                if value && multi && at != Legacy::Array {
                    intersect(expr.clone())
                } else {
                    expr.clone()
                }
            }
            E::BinaryOp { left, op, right } => E::BinaryOp {
                left: Box::new(self.legacy(left, true, at)),
                op: op.clone(),
                right: Box::new(self.legacy(right, true, at)),
            },
            E::UnaryOp { op, operand } => E::UnaryOp { op: op.clone(), operand: Box::new(self.legacy(operand, true, at)) },
            E::Range { .. }
            | E::ColumnRef { .. }
            | E::RowRef { .. }
            | E::Sheet3DRef { .. }
            | E::TableRef { .. }
            | E::NamedRef { .. } => {
                if value && at != Legacy::Array && self.array(expr) {
                    intersect(expr.clone())
                } else {
                    expr.clone()
                }
            }
            E::ArrayLiteral { .. } => {
                if value && at == Legacy::Top {
                    intersect(expr.clone())
                } else {
                    expr.clone()
                }
            }
            E::FunctionCall { func, args, ref_site_id } => self.legacy_call(func, args, *ref_site_id, value, at),
            _ => expr.clone(),
        }
    }

    fn legacy_call(&mut self, func: &BuiltinFunction, args: &[E], ref_site_id: identity::RefSiteId, value: bool, at: Legacy) -> E {
        let name = function_name(func);
        // LET and LAMBDA have no legacy reading: kept as they are.
        if matches!(name.as_str(), "LET" | "LAMBDA") {
            return E::FunctionCall { func: func.clone(), args: args.to_vec(), ref_site_id };
        }
        let row = parameters(&name);
        let array_result = row.is_some_and(|r| r.0.contains('A'));
        let line = matches!(name.as_str(), "ROW" | "COLUMN");
        let mut read: Vec<E> = Vec::with_capacity(args.len());
        for (i, arg) in args.iter().enumerate() {
            // TRANSPOSE's argument and IF's condition: references always
            // intersected.
            if (name == "TRANSPOSE" || name == "IF") && i == 0 {
                let inner = if at == Legacy::Array || name == "TRANSPOSE" { Legacy::References } else { at };
                let lifted = row.map_or(true, |r| self.class(r, i, arg) == Class::Lifted);
                read.push(self.legacy(arg, lifted, inner));
                continue;
            }
            let array_parameter = (array_result && name != "TRANSPOSE")
                || legacy_array_parameters(&name).is_some_and(|positions| positions.map_or(true, |p| p.contains(&i)));
            if array_parameter {
                read.push(self.legacy(arg, false, Legacy::Array));
                continue;
            }
            let lifted = !line && row.is_some_and(|r| self.class(r, i, arg) == Class::Lifted);
            if lifted {
                read.push(self.legacy(arg, true, at));
            } else {
                let inner = match at {
                    Legacy::Top | Legacy::References => Legacy::Whole,
                    other => other,
                };
                read.push(self.legacy(arg, false, inner));
            }
        }
        // What the classifier sees as multi-cell where the legacy reading has
        // one value -- an `XLOOKUP` of one lookup value, an intersection with
        // a single cell -- is one value to the call's own shape too.
        let probe: Vec<E> = read
            .iter()
            .map(|a| if self.legacy_single(a) { E::ImplicitIntersection { operand: Box::new(a.clone()) } } else { a.clone() })
            .collect();
        let call = E::FunctionCall { func: func.clone(), args: read, ref_site_id };
        if at == Legacy::Array {
            return call;
        }
        let multi = match name.as_str() {
            "XLOOKUP" => probe.first().is_some_and(|a| self.array(a)),
            _ => self.array(&E::FunctionCall { func: func.clone(), args: probe, ref_site_id }),
        };
        let wrap = if line {
            at != Legacy::References && args.first().is_some_and(|a| self.array(a))
        } else if !value {
            false
        } else if self.kind(&call) == Kind::Reference {
            at != Legacy::References && multi
        } else {
            at == Legacy::Top && (multi || row.is_some_and(|r| r.0.contains('D')))
        };
        if wrap {
            E::ImplicitIntersection { operand: Box::new(call) }
        } else {
            call
        }
    }
}

impl Walk<'_> {
    /// Whether the legacy reading has ONE value where the classifier's static
    /// view says multi-cell: `XLOOKUP` of one lookup value ([LIVE]
    /// `ABS(XLOOKUP(1,A1:A5,B1:B5))` stays), an intersection with a single
    /// cell (`ABS(A1:A3 A2)` stays).
    fn legacy_single(&mut self, expr: &E) -> bool {
        match expr {
            E::FunctionCall { func, args, .. } if function_name(func) == "XLOOKUP" => {
                !args.first().is_some_and(|a| self.array(a))
            }
            E::BinaryOp { left, op: BinaryOperator::Intersect, right } => !(self.array(left) && self.array(right)),
            _ => false,
        }
    }
}
