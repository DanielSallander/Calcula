//! FILENAME: core/persistence/src/xlsx_dynamic_formula_live.rs
//!
//! Lane xlsxdyn (rev-parse-1, 2026-11-05): live Excel 16's own `cm` flag for
//! every call the parameter table was derived from, against what the REAL
//! export path writes (`engine::Cell::new_formula` -> `SavedCell::from_cell`
//! -> `save_xlsx`).
//!
//! [LIVE, Excel 16, SCRATCH/xlsxdyn/probe.ps1 + gen.mjs] Each of the 493 Excel
//! functions in Calcula's catalog was called at its most typed arguments (at
//! most 8) with a single cell `A1` in every position (`F(A1,..)`), and then
//! with `A1:A3` and with `{1,2,3}` in each position in turn; each call typed
//! (`Formula2`) at the top, inside `ABS(..)` and inside `SUM(..)`, in its own
//! cell of a fresh workbook (A1:A5 = 1..5, B1:B5 = 10..50, C1:C3 texts) in a
//! fresh Excel per 700 formulas, the same text also assigned as a LEGACY
//! formula (`Formula`) beside it, saved, and the sheet XML's `cm` read. The
//! flag string holds one character per call, in [`calls`] order:
//! `D` Excel saved it dynamic and its legacy reading has ANOTHER value (so a
//! plain export would open with a wrong value), `d` dynamic with the same
//! value, `p` plain, `x` Excel refused to type it.

use crate::{SavedCell, SavedCellValue, SavedNamedRange, Sheet, Workbook};
use std::collections::HashMap;
use std::io::Read;

/// (function, arguments probed, Excel's flag for each call).
const EVIDENCE: &[(&str, usize, &str)] = &[
    ("ABS", 1, "pppDdDdDd"),
    ("ACCRINT", 8, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("ACCRINTM", 5, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("ACOS", 1, "pppDdDdDd"),
    ("ACOSH", 1, "pppDdDdDd"),
    ("ACOT", 1, "pppDdDdDd"),
    ("ACOTH", 1, "pppDdDdDd"),
    ("ADDRESS", 5, "pppDdddDdDdddDdDdddDdDdddDdDdddDd"),
    ("AGGREGATE", 6, "pppDdDdDdDdDdDdpppppppdpdpdpxpxpxpxpxpx"),
    ("AMORDEGRC", 7, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("AMORLINC", 7, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("AND", 4, "ppppppppppppppppppppppppppp"),
    ("ARABIC", 1, "pppdddddd"),
    ("AREAS", 1, "ppppxpxpx"),
    ("ARRAYTOTEXT", 2, "pppppppppDddddd"),
    ("ASIN", 1, "pppDdDdDd"),
    ("ASINH", 1, "pppDdDdDd"),
    ("ATAN", 1, "pppDdDdDd"),
    ("ATAN2", 2, "pppDdDdDdDdDdDd"),
    ("ATANH", 1, "pppDdDdDd"),
    ("AVEDEV", 4, "ppppppppppppppppppppppppppp"),
    ("AVERAGE", 4, "ppppppppppppppppppppppppppp"),
    ("AVERAGEA", 4, "ppppppppppppppppppppppppppp"),
    ("AVERAGEIF", 3, "ppppxpxpxDdDdddpxpxpx"),
    ("AVERAGEIFS", 7, "ppppxpxpxpxpxpxDdDdddpxpxpxDdDdddpxpxpxDdDddd"),
    ("BASE", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("BESSELI", 2, "ppppdpdpdpdpdpd"),
    ("BESSELJ", 2, "ppppdpdpdpdpdpd"),
    ("BESSELK", 2, "ppppdpdpdpdpdpd"),
    ("BESSELY", 2, "ppppdpdpdpdpdpd"),
    ("BETA.DIST", 6, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("BETA.INV", 5, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("BETADIST", 5, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("BETAINV", 5, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("BIN2DEC", 1, "ppppdpdpd"),
    ("BIN2HEX", 2, "ppppdpdpdpdpdpd"),
    ("BIN2OCT", 2, "ppppdpdpdpdpdpd"),
    ("BINOM.DIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("BINOM.DIST.RANGE", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("BINOM.INV", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("BINOMDIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("BITAND", 2, "pppDdDdDdDdDdDd"),
    ("BITLSHIFT", 2, "pppDdDdDdDdDdDd"),
    ("BITOR", 2, "pppDdDdDdDdDdDd"),
    ("BITRSHIFT", 2, "pppDdDdDdDdDdDd"),
    ("BITXOR", 2, "pppDdDdDdDdDdDd"),
    ("BYCOL", 2, "ddpddddppdddddd"),
    ("BYROW", 2, "ddpddddppdddddd"),
    ("CEILING", 2, "pppDdDdDdDdDdDd"),
    ("CEILING.MATH", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("CEILING.PRECISE", 2, "pppDdDdDdDdDdDd"),
    ("CELL", 2, "ddddddddddxdxdx"),
    ("CHAR", 1, "pppDdddDd"),
    ("CHIDIST", 2, "pppDdDdDdDdDdDd"),
    ("CHIINV", 2, "pppDdDdDdDdDdDd"),
    ("CHISQ.DIST", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("CHISQ.DIST.RT", 2, "pppDdDdDdDdDdDd"),
    ("CHISQ.INV", 2, "pppDdDdDdDdDdDd"),
    ("CHISQ.INV.RT", 2, "pppDdDdDdDdDdDd"),
    ("CHISQ.TEST", 2, "ppppppppppppppp"),
    ("CHISQDIST", 4, "ddpddddppddddppddddppddddpp"),
    ("CHITEST", 2, "ppppppppppppppp"),
    ("CHOOSE", 5, "pppDdDdDpDdDdppddddppddddppddddpp"),
    ("CHOOSECOLS", 5, "ddpddddppdddddpdddddpdddddpdddddp"),
    ("CHOOSEROWS", 5, "ddpddddppdddddpdddddpdddddpdddddp"),
    ("CLEAN", 1, "pppDdDdDd"),
    ("CODE", 1, "pppDdDdDd"),
    ("COLUMN", 1, "pppdxdxdx"),
    ("COLUMNS", 1, "ppppppppp"),
    ("COMBIN", 2, "pppDdDdDdDdDdDd"),
    ("COMBINA", 2, "pppDdDdDdDdDdDd"),
    ("COMPLEX", 3, "ppppdpdpdpdpdpdpdpdpd"),
    ("CONCAT", 4, "ppppppppppppppppppppppppppp"),
    ("CONCATENATE", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("CONFIDENCE", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("CONFIDENCE.NORM", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("CONFIDENCE.T", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("CONVERT", 3, "ppppdpdpdpdpdpdpdpdpd"),
    ("CORREL", 2, "ppppppppppppppp"),
    ("COS", 1, "pppDdDdDd"),
    ("COSH", 1, "pppDdDdDd"),
    ("COT", 1, "pppDdDdDd"),
    ("COTH", 1, "pppDdDdDd"),
    ("COUNT", 4, "ppppppppppppppppppppppppppp"),
    ("COUNTA", 4, "ppppppppppppppppppppppppppp"),
    ("COUNTBLANK", 1, "ppppxpxpx"),
    ("COUNTIF", 2, "ppppxpxpxDdDdDd"),
    ("COUNTIFS", 8, "ppppxpxpxDdDdDdpxpxpxDdDdDdpxpxpxDdDdDdpxpxpxDdDdDd"),
    ("COUPDAYBS", 4, "ppppdpdpdpdpdpdpdpdpdpdpdpd"),
    ("COUPDAYS", 4, "ppppdpdpdpdpdpdpdpdpdpdpdpd"),
    ("COUPDAYSNC", 4, "ppppdpdpdpdpdpdpdpdpdpdpdpd"),
    ("COUPNCD", 4, "ppppdpdpdpdpdpdpdpdpdpdpdpd"),
    ("COUPNUM", 4, "ppppdpdpdpdpdpdpdpdpdpdpdpd"),
    ("COUPPCD", 4, "ppppdpdpdpdpdpdpdpdpdpdpdpd"),
    ("COVAR", 2, "ppppppppppppppp"),
    ("COVARIANCE.P", 2, "ppppppppppppppp"),
    ("COVARIANCE.S", 2, "ppppppppppppppp"),
    ("CRITBINOM", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("CSC", 1, "pppDdDdDd"),
    ("CSCH", 1, "pppDdDdDd"),
    ("CUBEKPIMEMBER", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("CUBEMEMBER", 3, "pppDdDdDdppppppDdDdDd"),
    ("CUBEMEMBERPROPERTY", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("CUBERANKEDMEMBER", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("CUBESET", 5, "pppDdDdDdppppppDdDdDdDdDdDdDdDdDd"),
    ("CUBESETCOUNT", 1, "pppDdDdDd"),
    ("CUBEVALUE", 4, "pppDdDdDdpppppppppppppppppp"),
    ("CUMIPMT", 6, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("CUMPRINC", 6, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("DATE", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("DATEDIF", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("DATEVALUE", 1, "pppdddddd"),
    ("DAVERAGE", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DAY", 1, "pppDdDdDd"),
    ("DAYS", 2, "pppDdDdDdDdDdDd"),
    ("DAYS360", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("DB", 5, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("DCOUNT", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DCOUNTA", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DDB", 5, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("DEC2BIN", 2, "ppppdpdpdpdpdpd"),
    ("DEC2HEX", 2, "ppppdpdpdpdpdpd"),
    ("DEC2OCT", 2, "ppppdpdpdpdpdpd"),
    ("DECIMAL", 2, "pppDdDdDdDdDdDd"),
    ("DEGREES", 1, "pppDdDdDd"),
    ("DELTA", 2, "ppppdpdpdpdpdpd"),
    ("DEVSQ", 4, "ppppppppppppppppppppppppppp"),
    ("DGET", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DISC", 5, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("DMAX", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DMIN", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DOLLAR", 2, "pppDdDdDdDdDdDd"),
    ("DOLLARDE", 2, "ppppdpdpdpdpdpd"),
    ("DOLLARFR", 2, "ppppdpdpdpdpdpd"),
    ("DPRODUCT", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DROP", 3, "ddpddddppDdDdDdDdDdDd"),
    ("DSTDEV", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DSTDEVP", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DSUM", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DURATION", 6, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("DVAR", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("DVARP", 3, "ppppxpxpxpdpdpdpdpdpd"),
    ("EDATE", 2, "ppppdpdpdpdpdpd"),
    ("EFFECT", 2, "ppppdpdpdpdpdpd"),
    ("ENCODEURL", 1, "pppDdDdDd"),
    ("EOMONTH", 2, "ppppdpdpdpdpdpd"),
    ("ERF", 2, "ppppdpdpdpdpdpd"),
    ("ERF.PRECISE", 1, "ppppdpdpd"),
    ("ERFC", 1, "ppppdpdpd"),
    ("ERFC.PRECISE", 1, "ppppdpdpd"),
    ("ERROR.TYPE", 1, "pppDdDdDd"),
    ("EURO", 3, "ddpddddppddddppddddpp"),
    ("EVEN", 1, "pppDdDdDd"),
    ("EXACT", 2, "pppDdDdDdDdDdDd"),
    ("EXP", 1, "pppDdDdDd"),
    ("EXPAND", 4, "ddpddddppDdDdDDDdDdDDDdDdDp"),
    ("EXPON.DIST", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("EXPONDIST", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("F.DIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("F.DIST.RT", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("F.INV", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("F.INV.RT", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("F.TEST", 2, "ppppppppppppppp"),
    ("FACT", 1, "pppDdDdDd"),
    ("FACTDOUBLE", 1, "ppppdpdpd"),
    ("FALSE", 0, "p"),
    ("FDIST", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("FILTER", 3, "ddpddddppddddppdddddp"),
    ("FIND", 3, "pppDdDdddDdDdddDdDddd"),
    ("FINV", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("FISHER", 1, "pppDdDdDd"),
    ("FISHERINV", 1, "pppDdDdDd"),
    ("FIXED", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("FLOOR", 2, "pppDdDdDdDdDdDd"),
    ("FLOOR.MATH", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("FLOOR.PRECISE", 2, "pppDdDdDdDdDdDd"),
    ("FORECAST", 3, "pppDdDdDdpppppppppppp"),
    ("FORECAST.ETS", 6, "pppDdDdDdppppppppppppDdDdDdDdDdDdDdDdDd"),
    ("FORECAST.ETS.CONFINT", 7, "pppDdDdDdppppppppppppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("FORECAST.ETS.SEASONALITY", 4, "pppppppppppppppDdDdDdDdDdDd"),
    ("FORECAST.ETS.STAT", 6, "pppppppppppppppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("FORECAST.LINEAR", 3, "pppDdDdDdpppppppppppp"),
    ("FORMULATEXT", 1, "pppdxdxdx"),
    ("FREQUENCY", 2, "ddpddddppddddpp"),
    ("FTEST", 2, "ppppppppppppppp"),
    ("FV", 5, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("FVSCHEDULE", 2, "ppppdpdpdpppppp"),
    ("GAMMA", 1, "pppDdDdDd"),
    ("GAMMA.DIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("GAMMA.INV", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("GAMMADIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("GAMMAINV", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("GAMMALN", 1, "pppDdDdDd"),
    ("GAMMALN.PRECISE", 1, "pppDdDdDd"),
    ("GAUSS", 1, "pppDdDdDd"),
    ("GCD", 5, "ppppppppppppppppppppppppppppppppp"),
    ("GEOMEAN", 4, "ppppppppppppppppppppppppppp"),
    ("GESTEP", 2, "ppppdpdpdpdpdpd"),
    ("GETPIVOTDATA", 8, "ppppdpdpdpdpdpdDdDdDdddddddDdDdDdddddddDdDdDddddddd"),
    ("GROUPBY", 8, "ddpddddppddddppddddppddddddddddddddddppddddppdddddd"),
    ("GROWTH", 4, "ddpddddppddddppddddppDdDdpD"),
    ("HARMEAN", 4, "ppppppppppppppppppppppppppp"),
    ("HEX2BIN", 2, "ppppdpdpdpdpdpd"),
    ("HEX2DEC", 1, "ppppdpdpd"),
    ("HEX2OCT", 2, "ppppdpdpdpdpdpd"),
    ("HLOOKUP", 4, "pppDdDdDDppppppDDDDDDDdDdDD"),
    ("HOUR", 1, "pppDdDdDd"),
    ("HSTACK", 4, "ddpddddppddddppddddppddddpp"),
    ("HYPGEOM.DIST", 5, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("HYPGEOMDIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("IF", 3, "pppDdDdDpDdDdppddddpp"),
    ("IFERROR", 2, "pppddddDDdddddd"),
    ("IFNA", 2, "pppDdDdDDdddddd"),
    ("IFS", 8, "ddpDdDdDpDdDdppdddddpddddppdddddpddddppdddddpddddpp"),
    ("IMABS", 1, "ppppdpdpd"),
    ("IMAGINARY", 1, "ppppdpdpd"),
    ("IMARGUMENT", 1, "ppppdpdpd"),
    ("IMCONJUGATE", 1, "ppppdpdpd"),
    ("IMCOS", 1, "ppppdpdpd"),
    ("IMCOSH", 1, "ppppdpdpd"),
    ("IMCOT", 1, "ppppdpdpd"),
    ("IMCSC", 1, "ppppdpdpd"),
    ("IMCSCH", 1, "ppppdpdpd"),
    ("IMDIV", 2, "ppppdpdpdpdpdpd"),
    ("IMEXP", 1, "ppppdpdpd"),
    ("IMLN", 1, "ppppdpdpd"),
    ("IMLOG10", 1, "ppppdpdpd"),
    ("IMLOG2", 1, "ppppdpdpd"),
    ("IMPOWER", 2, "ppppdpdpdpdpdpd"),
    ("IMPRODUCT", 4, "ppppppppppppppppppppppppppp"),
    ("IMREAL", 1, "ppppdpdpd"),
    ("IMSEC", 1, "ppppdpdpd"),
    ("IMSECH", 1, "ppppdpdpd"),
    ("IMSIN", 1, "ppppdpdpd"),
    ("IMSINH", 1, "ppppdpdpd"),
    ("IMSQRT", 1, "ppppdpdpd"),
    ("IMSUB", 2, "ppppdpdpdpdpdpd"),
    ("IMSUM", 4, "ppppppppppppppppppppppppppp"),
    ("IMTAN", 1, "ppppdpdpd"),
    ("INDEX", 4, "pppddddppDdDdDDDdDdDDDdDdDD"),
    ("INDIRECT", 2, "ddpDdDdDdDdDdDd"),
    ("INT", 1, "pppDdDdDd"),
    ("INTERCEPT", 2, "ppppppppppppppp"),
    ("INTRATE", 5, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("IPMT", 6, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("IRR", 2, "pppppppppDdDdDd"),
    ("ISBLANK", 1, "pppdddddd"),
    ("ISERR", 1, "pppDdDdDd"),
    ("ISERROR", 1, "pppDdDdDd"),
    ("ISEVEN", 1, "ppppdpdpd"),
    ("ISFORMULA", 1, "pppdxdxdx"),
    ("ISLOGICAL", 1, "pppdddddd"),
    ("ISNA", 1, "pppdddddd"),
    ("ISNONTEXT", 1, "pppddddDd"),
    ("ISNUMBER", 1, "pppDdDddd"),
    ("ISO.CEILING", 2, "pppDdDdDdDdDdDd"),
    ("ISODD", 1, "ppppdpdpd"),
    ("ISOWEEKNUM", 1, "pppDdDdDd"),
    ("ISPMT", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("ISREF", 1, "ppppppppp"),
    ("ISTEXT", 1, "pppdddddd"),
    ("KURT", 4, "ppppppppppppppppppppppppppp"),
    ("LARGE", 2, "pppppppppDdDdDd"),
    ("LCM", 5, "ppppppppppppppppppppppppppppppppp"),
    ("LEFT", 2, "pppDdDdDdDdDdDd"),
    ("LEN", 1, "pppDdDdDd"),
    ("LINEST", 4, "DDpddddppDDDDppDdDdpDDdDdpD"),
    ("LN", 1, "pppDdDdDd"),
    ("LOG", 2, "pppDdDdDdDdDdDd"),
    ("LOG10", 1, "pppDdDdDd"),
    ("LOGEST", 4, "DDpddddppDDDDppDdDdpDDdDdpD"),
    ("LOGINV", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("LOGNORM.DIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("LOGNORM.INV", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("LOGNORMDIST", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("LOOKUP", 3, "pppDdDdDdpppppppppppp"),
    ("LOWER", 1, "pppDdDdDd"),
    ("MAKEARRAY", 3, "ddpddddddddddddddddpp"),
    ("MAP", 6, "ddpddddppddddppddddppddddppddddppddddpp"),
    ("MATCH", 3, "pppDdDdDdpppppppdpdpd"),
    ("MAX", 4, "ppppppppppppppppppppppppppp"),
    ("MAXA", 4, "ppppppppppppppppppppppppppp"),
    ("MAXIFS", 7, "ppppxpxpxpxpxpxDdDdDdpxpxpxDdDdDdpxpxpxDdDdDd"),
    ("MDETERM", 1, "ppppppppp"),
    ("MDURATION", 6, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("MEDIAN", 4, "ppppppppppppppppppppppppppp"),
    ("MID", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("MIN", 4, "ppppppppppppppppppppppppppp"),
    ("MINA", 4, "ppppppppppppppppppppppppppp"),
    ("MINIFS", 7, "ppppxpxpxpxpxpxDdDdDdpxpxpxDdDdDdpxpxpxDdDdDd"),
    ("MINUTE", 1, "pppDdDdDd"),
    ("MINVERSE", 1, "ddpddddpp"),
    ("MIRR", 3, "pppppppppDdDdDdDdDdDd"),
    ("MMULT", 2, "ddpddddppddddpp"),
    ("MOD", 2, "pppDdDdDdDdDdDd"),
    ("MODE", 4, "ppppppppppppppppppppppppppp"),
    ("MODE.MULT", 4, "ddpddddppddddppddddppddddpp"),
    ("MODE.SNGL", 4, "ppppppppppppppppppppppppppp"),
    ("MONTH", 1, "pppDdDdDd"),
    ("MROUND", 2, "ppppdpdpdpdpdpd"),
    ("MULTINOMIAL", 4, "ppppppppppppppppppppppppppp"),
    ("MUNIT", 1, "ddpDdDdDD"),
    ("N", 1, "ppppdpdpd"),
    ("NA", 0, "p"),
    ("NEGBINOM.DIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("NEGBINOMDIST", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("NETWORKDAYS", 3, "ppppdpdpdpdpdpdpppppp"),
    ("NETWORKDAYS.INTL", 4, "ppppdpdpdpdpdpdDdDdDdpppppp"),
    ("NOMINAL", 2, "ppppdpdpdpdpdpd"),
    ("NORM.DIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("NORM.INV", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("NORM.S.DIST", 2, "pppDdDdDdDdDdDd"),
    ("NORM.S.INV", 1, "pppDdDdDd"),
    ("NORMDIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("NORMINV", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("NORMSDIST", 1, "pppDdDdDd"),
    ("NORMSINV", 1, "pppDdDdDd"),
    ("NOT", 1, "pppDdDdDd"),
    ("NOW", 0, "p"),
    ("NPER", 5, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("NPV", 5, "pppDdDdDdpppppppppppppppppppppppp"),
    ("NUMBERVALUE", 3, "pppdddddddddddddddddd"),
    ("OCT2BIN", 2, "ppppdpdpdpdpdpd"),
    ("OCT2DEC", 1, "ppppdpdpd"),
    ("OCT2HEX", 2, "ppppdpdpdpdpdpd"),
    ("ODD", 1, "pppDdDdDd"),
    ("ODDFPRICE", 8, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("ODDFYIELD", 8, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("ODDLPRICE", 8, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("ODDLYIELD", 8, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("OFFSET", 5, "ddpdxdxpxdDdDDDdDdDDddDdDDDdDdDDD"),
    ("OR", 4, "ppppppppppppppppppppppppppp"),
    ("PDURATION", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("PEARSON", 2, "ppppppppppppppp"),
    ("PERCENTILE", 2, "pppppppppDdDdDd"),
    ("PERCENTILE.EXC", 2, "pppppppppDdDdDd"),
    ("PERCENTILE.INC", 2, "pppppppppDdDdDd"),
    ("PERCENTRANK", 3, "pppppppppDdDdDdDdDdDd"),
    ("PERCENTRANK.EXC", 3, "pppppppppDdDdDdDdDdDd"),
    ("PERCENTRANK.INC", 3, "pppppppppDdDdDdDdDdDd"),
    ("PERMUT", 2, "pppDdDdDdDdDdDd"),
    ("PERMUTATIONA", 2, "pppDdDdDdDdDdDd"),
    ("PHI", 1, "pppDdDdDd"),
    ("PI", 0, "p"),
    ("PIVOTBY", 4, "ddpddddppddddppddddppddddpp"),
    ("PMT", 5, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("POISSON", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("POISSON.DIST", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("POISSONDIST", 4, "ddpddddppddddppddddppddddpp"),
    ("POWER", 2, "pppDdDdDdDdDdDd"),
    ("PPMT", 6, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("PRICE", 7, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("PRICEDISC", 5, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("PRICEMAT", 6, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("PROB", 4, "pppppppppppppppDdDdDdDdDdDd"),
    ("PRODUCT", 4, "ppppppppppppppppppppppppppp"),
    ("PROPER", 1, "pppDdDdDd"),
    ("PV", 5, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("QUARTILE", 2, "pppppppppDdDdDd"),
    ("QUARTILE.EXC", 2, "pppppppppDdDdDd"),
    ("QUARTILE.INC", 2, "pppppppppDdDdDd"),
    ("QUOTIENT", 2, "ppppdpdpdpdpdpd"),
    ("RADIANS", 1, "pppDdDdDd"),
    ("RAND", 0, "p"),
    ("RANDARRAY", 5, "ddpDdDdDDDdDdDDDdDddDDdDdDDDdDdDD"),
    ("RANDBETWEEN", 2, "ppppdpdpdpdpdpD"),
    ("RANK", 3, "pppDdDdDdpxpxpxDdDdDd"),
    ("RANK.AVG", 3, "pppDdDdDdpxpxpxDdDdDd"),
    ("RANK.EQ", 3, "pppDdDdDdpxpxpxDdDdDd"),
    ("RATE", 6, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("RECEIVED", 5, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("REDUCE", 3, "ddpddddppddddppdddddd"),
    ("REPLACE", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("REPT", 2, "pppDdDdDdDdDdDd"),
    ("RIGHT", 2, "pppDdDdDdDdDdDd"),
    ("ROMAN", 2, "pppDdddDdDdddDd"),
    ("ROUND", 2, "pppDdDdDdDdDdDd"),
    ("ROUNDDOWN", 2, "pppDdDdDdDdDdDd"),
    ("ROUNDUP", 2, "pppDdDdDdDdDdDd"),
    ("ROW", 1, "pppdxdxDx"),
    ("ROWS", 1, "ppppppppp"),
    ("RRI", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("RSQ", 2, "ppppppppppppppp"),
    ("SCAN", 3, "ddpddddppddddppdddddd"),
    ("SEARCH", 3, "pppDdDdddDdDdddDdDddd"),
    ("SEC", 1, "pppDdDdDd"),
    ("SECH", 1, "pppDdDdDd"),
    ("SECOND", 1, "pppDdDdDd"),
    ("SEQUENCE", 4, "ddpDdDdDDDdDdDDDdDdDDDdDdDD"),
    ("SERIESSUM", 4, "ppppdpdpdpdpdpdpdpdpdpppppp"),
    ("SHEET", 1, "ppppppppp"),
    ("SHEETS", 1, "ppppppppp"),
    ("SIGN", 1, "pppDdDdDd"),
    ("SIN", 1, "pppDdDdDd"),
    ("SINH", 1, "pppDdDdDd"),
    ("SKEW", 4, "ppppppppppppppppppppppppppp"),
    ("SKEW.P", 4, "ppppppppppppppppppppppppppp"),
    ("SLN", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("SLOPE", 2, "ppppppppppppppp"),
    ("SMALL", 2, "pppppppppDdDdDd"),
    ("SORT", 4, "ddpddddppddddppddddppDdDddD"),
    ("SORTBY", 7, "ddpddddppddddppDdDddDddddppDdDddDddddppDdDddD"),
    ("SQRT", 1, "pppDdDdDd"),
    ("SQRTPI", 1, "ppppdpdpd"),
    ("STANDARDIZE", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("STDEV", 4, "ppppppppppppppppppppppppppp"),
    ("STDEV.P", 4, "ppppppppppppppppppppppppppp"),
    ("STDEV.S", 4, "ppppppppppppppppppppppppppp"),
    ("STDEVA", 4, "ppppppppppppppppppppppppppp"),
    ("STDEVP", 4, "ppppppppppppppppppppppppppp"),
    ("STDEVPA", 4, "ppppppppppppppppppppppppppp"),
    ("STEYX", 2, "ppppppppppppppp"),
    ("SUBSTITUTE", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("SUBTOTAL", 5, "pppDdDdDdpxpxpxpxpxpxpxpxpxpxpxpx"),
    ("SUM", 4, "ppppppppppppppppppppppppppp"),
    ("SUMIF", 3, "ppppxpxpxDdDdDdpxpxpx"),
    ("SUMIFS", 7, "ppppxpxpxpxpxpxDdDdDdpxpxpxDdDdDdpxpxpxDdDdDd"),
    ("SUMPRODUCT", 4, "ppppppppppppppppppppppppppp"),
    ("SUMSQ", 4, "ppppppppppppppppppppppppppp"),
    ("SUMX2MY2", 2, "ppppppppppppppp"),
    ("SUMX2PY2", 2, "ppppppppppppppp"),
    ("SUMXMY2", 2, "ppppppppppppppp"),
    ("SWITCH", 7, "ddpDdDdDpDdDdDpDdDdppdddddpddddppdddddpddddpp"),
    ("SYD", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("T", 1, "ppppdpdpd"),
    ("T.DIST", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("T.DIST.2T", 2, "pppDdDdDdDdDdDd"),
    ("T.DIST.RT", 2, "pppDdDdDdDdDdDd"),
    ("T.INV", 2, "pppDdDdDdDdDdDd"),
    ("T.INV.2T", 2, "pppDdDdDdDdDdDd"),
    ("T.TEST", 4, "pppppppppppppppDdDdDdDdDdDd"),
    ("TAKE", 3, "ddpddddppdDdDDDdDdDDD"),
    ("TAN", 1, "pppDdDdDd"),
    ("TANH", 1, "pppDdDdDd"),
    ("TBILLEQ", 3, "ppppdpdpdpdpdpdpdpdpd"),
    ("TBILLPRICE", 3, "ppppdpdpdpdpdpdpdpdpd"),
    ("TBILLYIELD", 3, "ppppdpdpdpdpdpdpdpdpd"),
    ("TDIST", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("TEXT", 2, "pppDdDdDdDdDdDd"),
    ("TEXTAFTER", 6, "pppDdddDdDpdpdpDdddddDdddddDdddddddddDd"),
    ("TEXTBEFORE", 6, "pppDdddDdDpdpdpDdddddDdddddDdddddddddDd"),
    ("TEXTJOIN", 6, "pppppppppDdDdDdpppppppppppppppppppppppp"),
    ("TEXTSPLIT", 6, "ddpDdDdDdDdDdDpDdDdDpDdDdDdDdDdDdDdDdDp"),
    ("TIME", 3, "pppDdDdDdDdDdDdDdDdDd"),
    ("TIMEVALUE", 1, "pppdddddd"),
    ("TINV", 2, "pppDdDdDdDdDdDd"),
    ("TOCOL", 3, "ddpddddppDdDdDDDdDdDD"),
    ("TODAY", 0, "p"),
    ("TOROW", 3, "ddpddddppDdDdDDDdDdDD"),
    ("TRANSPOSE", 1, "ddpDdDdDp"),
    ("TREND", 4, "ddpddddppddddppddddppDdDdpD"),
    ("TRIM", 1, "pppDdDdDd"),
    ("TRIMMEAN", 2, "pppppppppDdDdDd"),
    ("TRIMRANGE", 3, "ddpDdDdppdDdDDDdDdDDD"),
    ("TRUE", 0, "p"),
    ("TRUNC", 2, "pppDdDdDdDdDdDd"),
    ("TTEST", 4, "pppppppppppppppDdDdDdDdDdDd"),
    ("TYPE", 1, "pppDpDpDp"),
    ("UNICHAR", 1, "pppDdddDd"),
    ("UNICODE", 1, "pppDdDdDd"),
    ("UNIQUE", 3, "ddpddddppDdDdDdDdDdDd"),
    ("UPPER", 1, "pppDdDdDd"),
    ("VALUE", 1, "pppDdDdDd"),
    ("VALUETOTEXT", 2, "pppDdDdDdDdDddd"),
    ("VAR", 4, "ppppppppppppppppppppppppppp"),
    ("VAR.P", 4, "ppppppppppppppppppppppppppp"),
    ("VAR.S", 4, "ppppppppppppppppppppppppppp"),
    ("VARA", 4, "ppppppppppppppppppppppppppp"),
    ("VARP", 4, "ppppppppppppppppppppppppppp"),
    ("VARPA", 4, "ppppppppppppppppppppppppppp"),
    ("VDB", 7, "pppDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("VLOOKUP", 4, "pppDdDdDDppppppDDDDDDDdDdDD"),
    ("VSTACK", 4, "ddpDdDdppDdDdppDdDdppDdDdpp"),
    ("WEEKDAY", 2, "pppDdDdDdDdDdDd"),
    ("WEEKNUM", 2, "ppppdpdpdpdpdpd"),
    ("WEIBULL", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("WEIBULL.DIST", 4, "pppDdDdDdDdDdDdDdDdDdDdDdDd"),
    ("WORKDAY", 3, "ppppdpdpdpdpdpdpppppp"),
    ("WORKDAY.INTL", 4, "ppppdpdpdpdpdpdDdDdDdpppppp"),
    ("WRAPCOLS", 3, "ddpddddppDdDdDDddddDD"),
    ("WRAPROWS", 3, "ddpddddppDdDdDDddddDD"),
    ("XIRR", 3, "ppppppppppppppppdpdpd"),
    ("XLOOKUP", 6, "pppDdDdDDppppppDdDdppddddppDdDdDDDdDddD"),
    ("XMATCH", 4, "pppDdDdDdppppppDdDdDdDdDddd"),
    ("XNPV", 3, "ppppdpdpdpppppppppppp"),
    ("XOR", 4, "ppppppppppppppppppppppppppp"),
    ("YEAR", 1, "pppDdDdDd"),
    ("YEARFRAC", 3, "ppppdpdpdpdpdpdpdpdpd"),
    ("YIELD", 7, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("YIELDDISC", 5, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("YIELDMAT", 6, "ppppdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpdpd"),
    ("Z.TEST", 3, "pppppppppDdDdDdDdDdDd"),
    ("ZTEST", 3, "pppppppppDdDdDdDdDdDd"),
];

/// The functions rust_xlsxwriter itself writes dynamic whatever Calcula asks
/// (its own future-function list): a formula calling one is dynamic in the
/// file even where Excel would save it plain -- harmless ([LIVE] tablefix
/// probe2), and not Calcula's to change.
const LIBRARY_DYNAMIC: &[&str] = &[
    "ANCHORARRAY", "BYCOL", "BYROW", "CHOOSECOLS", "CHOOSEROWS", "DROP", "EXPAND", "FILTER", "HSTACK", "LAMBDA",
    "MAKEARRAY", "MAP", "RANDARRAY", "REDUCE", "SCAN", "SEQUENCE", "SINGLE", "SORT", "SORTBY", "SWITCH", "TAKE",
    "TEXTSPLIT", "TOCOL", "TOROW", "UNIQUE", "VSTACK", "WRAPCOLS", "WRAPROWS", "XLOOKUP",
];

/// Every call of one function, in the probe's order (gen.mjs `forms`).
fn calls(name: &str, n: usize) -> Vec<String> {
    let call = |args: &[String]| format!("{}({})", name, args.join(","));
    let base: Vec<String> = vec!["A1".to_string(); n];
    let mut out = vec![call(&base)];
    if n > 0 {
        out.push(format!("ABS({})", call(&base)));
        out.push(format!("SUM({})", call(&base)));
    }
    for i in 0..n {
        let mut r = base.clone();
        r[i] = "A1:A3".to_string();
        let mut c = base.clone();
        c[i] = "{1,2,3}".to_string();
        let (r, c) = (call(&r), call(&c));
        out.push(r.clone());
        out.push(c.clone());
        out.push(format!("ABS({})", r));
        out.push(format!("ABS({})", c));
        out.push(format!("SUM({})", r));
        out.push(format!("SUM({})", c));
    }
    out
}

fn number(v: f64) -> SavedCell {
    SavedCell { value: SavedCellValue::Number(v), formula: None, style_index: 0, rich_text: None, spill: None }
}

fn text(s: &str) -> SavedCell {
    SavedCell { value: SavedCellValue::Text(s.to_string()), formula: None, style_index: 0, rich_text: None, spill: None }
}

/// The probe's workbook: Sheet1 A1:A5 = 1..5, B1:B5 = 10..50, C1:C3 texts,
/// D1 = 2, the table `Tbl` on F1:G4 (`P` 1..3, `Q` 10..30), Sheet2 A1:A5 =
/// 100..500, and its defined names (`MyR` a range, `MyC` one cell, `MyK` a
/// constant, `MyA` an array constant, `MyF` a formula, `MyO` an `OFFSET`,
/// `MyL` a LAMBDA, `MyN` `-5`, `MyS` a text, `MyB` TRUE, `MyE` #N/A, `MyQ`
/// another sheet's cell, `MyV` a relative cell, `MyT` a table column, `MyX`
/// `(5)`); `formulas` in column J of `rows`.
pub(crate) fn probe_workbook(formulas: &[(u32, String)]) -> (Workbook, Vec<u32>) {
    let mut wb = Workbook::new();
    wb.sheets.clear();
    let mut sheet1 = Sheet::new("Sheet1".to_string());
    for i in 0..5u32 {
        sheet1.cells.insert((i, 0), number(f64::from(i + 1)));
        sheet1.cells.insert((i, 1), number(10.0 * f64::from(i + 1)));
    }
    for (i, s) in ["ab", "cde", "f"].iter().enumerate() {
        sheet1.cells.insert((i as u32, 2), text(s));
    }
    sheet1.cells.insert((0, 3), number(2.0));
    sheet1.cells.insert((0, 5), text("P"));
    sheet1.cells.insert((0, 6), text("Q"));
    for r in 1..=3u32 {
        sheet1.cells.insert((r, 5), number(f64::from(r)));
        sheet1.cells.insert((r, 6), number(10.0 * f64::from(r)));
    }
    let mut held_none = Vec::new();
    for (row, formula) in formulas {
        let cell = SavedCell::from_cell(&engine::Cell::new_formula(format!("={}", formula)));
        if cell.formula.is_none() {
            held_none.push(*row);
            continue;
        }
        sheet1.cells.insert((row - 1, 9), cell);
    }
    let sheet_id = sheet1.id;
    wb.sheets.push(sheet1);
    let mut sheet2 = Sheet::new("Sheet2".to_string());
    for i in 0..5u32 {
        sheet2.cells.insert((i, 0), number(100.0 * f64::from(i + 1)));
    }
    wb.sheets.push(sheet2);
    let column = |name: &str| crate::SavedTableColumn {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: name.to_string(),
        totals_row_function: "none".to_string(),
        totals_row_formula: None,
        calculated_formula: None,
        totals_row_label: None,
    };
    wb.tables.push(crate::SavedTable {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Tbl".to_string(),
        sheet_id,
        start_row: 0,
        start_col: 5,
        end_row: 3,
        end_col: 6,
        columns: vec![column("P"), column("Q")],
        style_options: crate::SavedTableStyleOptions {
            banded_rows: true,
            banded_columns: false,
            header_row: true,
            total_row: false,
            first_column: false,
            last_column: false,
            show_filter_button: true,
        },
        style_name: "TableStyleMedium9".to_string(),
    });
    for (name, refers_to) in [
        ("MyR", "=Sheet1!$A$1:$A$3"),
        ("MyC", "=Sheet1!$A$2"),
        ("MyK", "=5"),
        ("MyA", "={1,2,3}"),
        ("MyF", "=Sheet1!$A$1+1"),
        ("MyO", "=OFFSET(Sheet1!$A$1,0,0,3,1)"),
        ("MyL", "=LAMBDA(x,x*2)"),
        ("MyN", "=-5"),
        ("MyS", "=\"x\""),
        ("MyB", "=TRUE"),
        ("MyE", "=#N/A"),
        ("MyQ", "=Sheet2!$A$1"),
        ("MyV", "=Sheet1!A1"),
        ("MyT", "=Tbl[P]"),
        ("MyX", "=(5)"),
    ] {
        wb.named_ranges.push(SavedNamedRange { name: name.to_string(), refers_to: refers_to.to_string(), sheet_id: None, comment: None, folder: None });
    }
    (wb, held_none)
}

/// The real export of a probe workbook: each column-J cell's `<c ..>..</c>`
/// text by row. With `CALCULA_XLSX_PROBE_DIR` set the file is left there as
/// `name` for Excel to open (SCRATCH/xlsxdyn/openprobe.ps1).
pub(crate) fn exported_cells(wb: &Workbook, name: &str) -> HashMap<u32, String> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cm.xlsx");
    crate::save_xlsx(wb, &path).unwrap();
    if let Ok(probe) = std::env::var("CALCULA_XLSX_PROBE_DIR") {
        let _ = std::fs::copy(&path, std::path::Path::new(&probe).join(name));
    }
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut xml = String::new();
    archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut xml).unwrap();
    let mut cells = HashMap::new();
    let mut at = 0;
    while let Some(start) = xml[at..].find("<c r=\"J") {
        let start = at + start;
        let digits_from = start + "<c r=\"J".len();
        let digits_to = digits_from + xml[digits_from..].find('"').unwrap();
        let end = start + xml[start..].find("</c>").map(|e| e + 4).unwrap_or_else(|| xml[start..].find("/>").unwrap() + 2);
        if let Ok(row) = xml[digits_from..digits_to].parse::<u32>() {
            cells.insert(row, xml[start..end].to_string());
        }
        at = end;
    }
    cells
}

/// Whether an exported cell is written dynamic (`None`: no formula in it).
pub(crate) fn written_dynamic(cell: Option<&String>) -> Option<bool> {
    let c = cell?;
    if !c.contains("<f") {
        return None;
    }
    Some(c.contains("cm=\"1\"") && c.contains("t=\"array\""))
}

/// Whether a formula calls one of [`LIBRARY_DYNAMIC`].
pub(crate) fn calls_library_dynamic(formula: &str) -> bool {
    let upper = formula.to_ascii_uppercase();
    LIBRARY_DYNAMIC.iter().any(|f| {
        upper.match_indices(&format!("{}(", f)).any(|(at, _)| {
            at == 0 || !upper.as_bytes()[at - 1].is_ascii_alphanumeric() && upper.as_bytes()[at - 1] != b'.'
        })
    })
}

/// Every probed call is written dynamic wherever Excel saved it dynamic (none
/// is left plain to open with Excel's `@` -- 1,889 of them would open with a
/// wrong value), and plain wherever Excel saved it plain, but for a call of a
/// function the library always writes dynamic (141 rows, harmless).
/// SABOTAGE (xlsxdyn-table): `class_of` reads `V` as `R` -- 4,596 calls
/// written plain, 1,707 of them with a wrong value. SABOTAGE (xlsxdyn-top):
/// `excel_saves_dynamic` ignores a multi-cell value at the top -- 136
/// (`MMULT(A1,A1)`, `TRANSPOSE(A1)`, ...).
#[test]
fn the_classifier_agrees_with_excel_on_every_probed_call() {
    let mut formulas = Vec::new();
    let mut flags = Vec::new();
    for &(name, n, flag) in EVIDENCE {
        let all = calls(name, n);
        assert_eq!(all.len(), flag.len(), "{}: {} calls, {} flags", name, all.len(), flag.len());
        for (formula, f) in all.into_iter().zip(flag.chars()) {
            if f == 'x' {
                continue;
            }
            let row = 10 + 4 * formulas.len() as u32;
            formulas.push((row, formula));
            flags.push(f);
        }
    }
    let (wb, held_none) = probe_workbook(&formulas);
    let cells = exported_cells(&wb, "calcula-cm-calls.xlsx");
    let mut under = Vec::new();
    let mut over = Vec::new();
    let mut harmful = 0;
    let mut not_written = Vec::new();
    let mut counted = (0usize, 0usize);
    for ((row, formula), f) in formulas.iter().zip(&flags) {
        if held_none.contains(row) {
            continue;
        }
        let Some(dynamic) = written_dynamic(cells.get(row)) else {
            not_written.push(formula.clone());
            continue;
        };
        let excel = *f != 'p';
        if excel {
            counted.0 += 1;
        }
        if excel && !dynamic {
            if *f == 'D' {
                harmful += 1;
            }
            under.push(format!("  {} (Excel {})", formula, f));
        } else if !excel && dynamic {
            if calls_library_dynamic(formula) {
                counted.1 += 1;
            } else {
                over.push(format!("  {}", formula));
            }
        }
    }
    assert!(under.is_empty(), "WRITTEN PLAIN WHERE EXCEL SAVES DYNAMIC ({}, {} with a wrong value):\n{}", under.len(), harmful, under.join("\n"));
    assert!(over.is_empty(), "WRITTEN DYNAMIC WHERE EXCEL SAVES PLAIN ({}):\n{}", over.len(), over.join("\n"));
    assert!(not_written.is_empty(), "lost their formula ({}): {:?}", not_written.len(), not_written);
    // Calcula holds `TRUE()` / `FALSE()` as the logical, no formula.
    let held: Vec<&String> = held_none.iter().map(|r| &formulas[((r - 10) / 4) as usize].1).collect();
    assert_eq!(held, ["FALSE()", "TRUE()"], "Calcula holds no formula for these probed calls");
    // The harness saw what the probe saw: 9,691 calls Excel typed, 5,343 of
    // them dynamic (1,889 with another value read as legacy), and the 141
    // plain ones the library writes dynamic.
    assert_eq!((formulas.len(), counted.0, counted.1), (9691, 5343, 141), "the probe's counts");
}

/// The table is sorted (it is binary-searched), names only functions
/// Calcula's parser knows by that canonical name, covers every probed
/// function, and its class strings are as long as the probe went.
#[test]
fn the_parameter_table_is_the_probes_and_is_searchable() {
    let table = super::PARAMETERS;
    for pair in table.windows(2) {
        assert!(pair[0].0 < pair[1].0, "not sorted: {} before {}", pair[0].0, pair[1].0);
    }
    for &(name, n, _) in EVIDENCE {
        let row = table.iter().find(|r| r.0 == name).unwrap_or_else(|| panic!("{} is not in the table", name));
        assert_eq!(row.2.len(), n, "{}: reference classes", name);
        assert_eq!(row.3.len(), n, "{}: array classes", name);
        let canonical = parser::ast::BuiltinFunction::from_name(name).to_canonical_name().to_ascii_uppercase();
        assert_eq!(canonical, name, "Calcula's parser reads {} as {}", name, canonical);
    }
    assert_eq!(table.len(), EVIDENCE.len());
}

/// A position past a class string repeats its last class, or its last two
/// for an alternating pair.
#[test]
fn a_variadic_tail_repeats_the_last_class_or_pair() {
    use super::{class_at, Class};
    assert_eq!(class_at("RRRR", 9), Class::Whole);
    assert_eq!(class_at("RRVRVRV", 7), Class::Whole);
    assert_eq!(class_at("RRVRVRV", 8), Class::Lifted);
    assert_eq!(class_at("RVRVRVRV", 8), Class::Whole);
    assert_eq!(class_at("RVRVRVRV", 9), Class::Lifted);
    assert_eq!(class_at("VPPPP", 6), Class::Spreads);
    assert_eq!(class_at("", 0), Class::Lifted);
}
