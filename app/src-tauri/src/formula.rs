//! FILENAME: app/src-tauri/src/formula.rs
// PURPOSE: Formula library commands - function catalog, templates, and expression evaluation
// FORMAT: seq|level|category|message

use std::collections::HashMap;
use crate::api_types::{FunctionInfo, FunctionListResult};
use crate::logging::{log_enter, log_exit};
use crate::AppState;
use crate::persistence::UserFilesState;
use tauri::State;
use parser::BuiltinFunction;
use parser::parse as parse_formula;
use engine::{Evaluator, EvalResult};

/// Build the complete function catalog from the parser's BuiltinFunction registry.
fn build_full_catalog() -> Vec<FunctionInfo> {
    // Rich descriptions for known functions: name -> (syntax, description)
    let descriptions: HashMap<&str, (&str, &str)> = HashMap::from([
        // Math
        ("SUM", ("SUM(number1, [number2], ...)", "Adds all numbers in a range")),
        ("SUMIF", ("SUMIF(range, criteria, [sum_range])", "Sums cells that meet a condition")),
        ("SUMIFS", ("SUMIFS(sum_range, criteria_range1, criteria1, ...)", "Sums cells that meet multiple conditions")),
        ("SUMPRODUCT", ("SUMPRODUCT(array1, [array2], ...)", "Returns the sum of products of corresponding ranges")),
        ("SUMX2MY2", ("SUMX2MY2(array_x, array_y)", "Returns the sum of the difference of squares of corresponding values")),
        ("SUMX2PY2", ("SUMX2PY2(array_x, array_y)", "Returns the sum of the sum of squares of corresponding values")),
        ("SUMXMY2", ("SUMXMY2(array_x, array_y)", "Returns the sum of squares of differences of corresponding values")),
        ("PRODUCT", ("PRODUCT(number1, [number2], ...)", "Multiplies all the numbers given as arguments")),
        ("AVERAGE", ("AVERAGE(number1, [number2], ...)", "Returns the average of numbers")),
        ("AVERAGEIF", ("AVERAGEIF(range, criteria, [average_range])", "Averages cells that meet a condition")),
        ("AVERAGEIFS", ("AVERAGEIFS(average_range, criteria_range1, criteria1, ...)", "Averages cells that meet multiple conditions")),
        ("COUNT", ("COUNT(value1, [value2], ...)", "Counts cells containing numbers")),
        ("COUNTIF", ("COUNTIF(range, criteria)", "Counts cells that meet a condition")),
        ("COUNTIFS", ("COUNTIFS(criteria_range1, criteria1, ...)", "Counts cells that meet multiple conditions")),
        ("COUNTBLANK", ("COUNTBLANK(range)", "Counts empty cells in a range")),
        ("MAX", ("MAX(number1, [number2], ...)", "Returns the largest value")),
        ("MAXIFS", ("MAXIFS(max_range, criteria_range1, criteria1, ...)", "Returns the maximum value among cells that meet conditions")),
        ("MIN", ("MIN(number1, [number2], ...)", "Returns the smallest value")),
        ("MINIFS", ("MINIFS(min_range, criteria_range1, criteria1, ...)", "Returns the minimum value among cells that meet conditions")),
        ("ABS", ("ABS(number)", "Returns absolute value")),
        ("ROUND", ("ROUND(number, num_digits)", "Rounds a number")),
        ("ROUNDUP", ("ROUNDUP(number, num_digits)", "Rounds a number up, away from zero")),
        ("ROUNDDOWN", ("ROUNDDOWN(number, num_digits)", "Rounds a number down, toward zero")),
        ("SQRT", ("SQRT(number)", "Square root")),
        ("POWER", ("POWER(number, power)", "Raises to power")),
        ("MOD", ("MOD(number, divisor)", "Returns remainder")),
        ("TRUNC", ("TRUNC(number, [num_digits])", "Truncates a number to an integer")),
        ("EVEN", ("EVEN(number)", "Rounds up to the nearest even integer")),
        ("ODD", ("ODD(number)", "Rounds up to the nearest odd integer")),
        ("GCD", ("GCD(number1, number2, ...)", "Returns the greatest common divisor")),
        ("LCM", ("LCM(number1, number2, ...)", "Returns the least common multiple")),
        ("COMBIN", ("COMBIN(number, number_chosen)", "Returns the number of combinations")),
        ("FACT", ("FACT(number)", "Returns the factorial of a number")),
        ("PI", ("PI()", "Returns the value of pi")),
        ("RAND", ("RAND()", "Returns a random number between 0 and 1")),
        ("RANDBETWEEN", ("RANDBETWEEN(bottom, top)", "Returns a random integer between two values")),
        ("LOG", ("LOG(number, [base])", "Returns the logarithm of a number")),
        ("LOG10", ("LOG10(number)", "Returns the base-10 logarithm")),
        ("LN", ("LN(number)", "Returns the natural logarithm")),
        ("EXP", ("EXP(number)", "Returns e raised to a power")),
        ("SIN", ("SIN(number)", "Returns the sine of an angle")),
        ("COS", ("COS(number)", "Returns the cosine of an angle")),
        ("TAN", ("TAN(number)", "Returns the tangent of an angle")),
        ("ASIN", ("ASIN(number)", "Returns the arcsine of a number")),
        ("ACOS", ("ACOS(number)", "Returns the arccosine of a number")),
        ("ATAN", ("ATAN(number)", "Returns the arctangent of a number")),
        ("ATAN2", ("ATAN2(x_num, y_num)", "Returns the arctangent from x and y coordinates")),
        ("DEGREES", ("DEGREES(angle)", "Converts radians to degrees")),
        ("RADIANS", ("RADIANS(angle)", "Converts degrees to radians")),
        ("MROUND", ("MROUND(number, multiple)", "Rounds a number to the nearest multiple")),
        ("QUOTIENT", ("QUOTIENT(numerator, denominator)", "Returns the integer portion of a division")),
        ("SUMSQ", ("SUMSQ(number1, [number2], ...)", "Returns the sum of the squares of the arguments")),
        ("ROMAN", ("ROMAN(number, [form])", "Converts an Arabic numeral to Roman numeral text")),
        ("ARABIC", ("ARABIC(text)", "Converts a Roman numeral text to an Arabic numeral")),
        ("BASE", ("BASE(number, radix, [min_length])", "Converts a number into a text representation with the given radix")),
        ("DECIMAL", ("DECIMAL(text, radix)", "Converts a text representation of a number in a given base to decimal")),
        ("SINH", ("SINH(number)", "Returns the hyperbolic sine of a number")),
        ("COSH", ("COSH(number)", "Returns the hyperbolic cosine of a number")),
        ("TANH", ("TANH(number)", "Returns the hyperbolic tangent of a number")),
        ("COT", ("COT(number)", "Returns the cotangent of an angle")),
        ("COTH", ("COTH(number)", "Returns the hyperbolic cotangent of a number")),
        ("CSC", ("CSC(number)", "Returns the cosecant of an angle")),
        ("CSCH", ("CSCH(number)", "Returns the hyperbolic cosecant of a number")),
        ("SEC", ("SEC(number)", "Returns the secant of an angle")),
        ("SECH", ("SECH(number)", "Returns the hyperbolic secant of a number")),
        ("ACOT", ("ACOT(number)", "Returns the arccotangent of a number")),
        ("CEILING.MATH", ("CEILING.MATH(number, [significance], [mode])", "Rounds a number up to the nearest integer or nearest multiple of significance")),
        ("CEILING.PRECISE", ("CEILING.PRECISE(number, [significance])", "Rounds a number up to the nearest integer or nearest multiple of significance")),
        ("FLOOR.MATH", ("FLOOR.MATH(number, [significance], [mode])", "Rounds a number down to the nearest integer or nearest multiple of significance")),
        ("FLOOR.PRECISE", ("FLOOR.PRECISE(number, [significance])", "Rounds a number down to the nearest integer or nearest multiple of significance")),
        ("ISO.CEILING", ("ISO.CEILING(number, [significance])", "Rounds a number up to the nearest integer or nearest multiple of significance")),
        ("MULTINOMIAL", ("MULTINOMIAL(number1, [number2], ...)", "Returns the multinomial of a set of numbers")),
        ("COMBINA", ("COMBINA(number, number_chosen)", "Returns the number of combinations with repetitions")),
        ("FACTDOUBLE", ("FACTDOUBLE(number)", "Returns the double factorial of a number")),
        ("SQRTPI", ("SQRTPI(number)", "Returns the square root of (number * pi)")),
        ("AGGREGATE", ("AGGREGATE(function_num, options, ref1, ...)", "Returns an aggregate in a list or database, with options to ignore errors and hidden rows")),
        // Logical
        ("IF", ("IF(condition, value_if_true, [value_if_false])", "Conditional logic")),
        ("IFERROR", ("IFERROR(value, value_if_error)", "Returns value_if_error if expression is an error")),
        ("IFNA", ("IFNA(value, value_if_na)", "Returns value_if_na if expression is #N/A")),
        ("IFS", ("IFS(condition1, value1, [condition2, value2], ...)", "Checks multiple conditions and returns the first TRUE result")),
        ("SWITCH", ("SWITCH(expression, value1, result1, [value2, result2], ..., [default])", "Evaluates expression against a list of values and returns corresponding result")),
        ("AND", ("AND(logical1, [logical2], ...)", "TRUE if all arguments are TRUE")),
        ("OR", ("OR(logical1, [logical2], ...)", "TRUE if any argument is TRUE")),
        ("NOT", ("NOT(logical)", "Reverses the logic")),
        ("XOR", ("XOR(logical1, [logical2], ...)", "Returns TRUE if an odd number of arguments are TRUE")),
        ("LET", ("LET(name1, name_value1, calculation_or_name2, [name_value2, calculation_or_name3], ...)", "Assigns names to calculation results to improve readability and performance")),
        ("LAMBDA", ("LAMBDA([parameter1, parameter2, ...], calculation)", "Creates a custom reusable function with parameters")),
        ("MAP", ("MAP(array, lambda)", "Returns an array by applying a LAMBDA to each value in an array")),
        ("REDUCE", ("REDUCE(initial_value, array, lambda)", "Reduces an array to a single value by applying a LAMBDA accumulator")),
        ("SCAN", ("SCAN(initial_value, array, lambda)", "Scans an array by applying a LAMBDA and returns an array of intermediate values")),
        ("MAKEARRAY", ("MAKEARRAY(rows, cols, lambda)", "Returns an array of specified dimensions by applying a LAMBDA")),
        ("BYROW", ("BYROW(array, lambda)", "Applies a LAMBDA to each row in an array and returns an array of results")),
        ("BYCOL", ("BYCOL(array, lambda)", "Applies a LAMBDA to each column in an array and returns an array of results")),
        // Text
        ("CONCATENATE", ("CONCATENATE(text1, [text2], ...)", "Joins text strings")),
        ("LEFT", ("LEFT(text, [num_chars])", "Returns leftmost characters")),
        ("RIGHT", ("RIGHT(text, [num_chars])", "Returns rightmost characters")),
        ("MID", ("MID(text, start_num, num_chars)", "Returns characters from middle")),
        ("LEN", ("LEN(text)", "Returns length of text")),
        ("UPPER", ("UPPER(text)", "Converts to uppercase")),
        ("LOWER", ("LOWER(text)", "Converts to lowercase")),
        ("TRIM", ("TRIM(text)", "Removes extra spaces")),
        ("FIND", ("FIND(find_text, within_text, [start_num])", "Finds text within another string (case-sensitive)")),
        ("SEARCH", ("SEARCH(find_text, within_text, [start_num])", "Finds text within another string (case-insensitive, supports wildcards)")),
        ("SUBSTITUTE", ("SUBSTITUTE(text, old_text, new_text, [instance_num])", "Substitutes new text for old text")),
        ("REPLACE", ("REPLACE(old_text, start_num, num_chars, new_text)", "Replaces characters within text")),
        ("VALUE", ("VALUE(text)", "Converts a text string to a number")),
        ("EXACT", ("EXACT(text1, text2)", "Checks whether two text strings are exactly the same")),
        ("PROPER", ("PROPER(text)", "Capitalizes the first letter of each word")),
        ("CHAR", ("CHAR(number)", "Returns the character for a given code number")),
        ("CODE", ("CODE(text)", "Returns the code number for the first character")),
        ("CLEAN", ("CLEAN(text)", "Removes non-printable characters from text")),
        ("NUMBERVALUE", ("NUMBERVALUE(text, [decimal_separator], [group_separator])", "Converts text to number with locale control")),
        ("T", ("T(value)", "Returns text if value is text, empty string otherwise")),
        ("TEXT", ("TEXT(value, format_text)", "Formats a number as text with a specified format")),
        ("REPT", ("REPT(text, number_times)", "Repeats text a given number of times")),
        ("TEXTJOIN", ("TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)", "Combines text from multiple ranges with a specified delimiter")),
        ("DOLLAR", ("DOLLAR(number, [decimals])", "Converts a number to text using currency format")),
        ("EURO", ("EURO(number, [decimals])", "Converts a number to text using euro currency format")),
        ("FIXED", ("FIXED(number, [decimals], [no_commas])", "Formats a number as text with a fixed number of decimals")),
        ("UNICHAR", ("UNICHAR(number)", "Returns the Unicode character for a given number")),
        ("UNICODE", ("UNICODE(text)", "Returns the Unicode code point for the first character of text")),
        ("ENCODEURL", ("ENCODEURL(text)", "Returns a URL-encoded string")),
        // Lookup & Reference
        ("XLOOKUP", ("XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])", "Searches a range or array and returns the corresponding item")),
        ("XLOOKUPS", ("XLOOKUPS(lookup_value1, lookup_array1, [lookup_value2, lookup_array2, ...], return_array, [match_mode], [search_mode])", "Multi-criteria lookup: searches multiple arrays simultaneously and returns the corresponding item from the return array")),
        ("INDEX", ("INDEX(array, row_num, [column_num])", "Returns a value at a given position in a range")),
        ("MATCH", ("MATCH(lookup_value, lookup_array, [match_type])", "Returns the position of a value in a range")),
        ("CHOOSE", ("CHOOSE(index_num, value1, [value2], ...)", "Returns a value from a list based on index")),
        ("INDIRECT", ("INDIRECT(ref_text, [a1])", "Returns the reference specified by a text string")),
        ("OFFSET", ("OFFSET(reference, rows, cols, [height], [width])", "Returns a reference offset from a given reference")),
        ("ADDRESS", ("ADDRESS(row_num, column_num, [abs_num], [a1], [sheet_text])", "Creates a cell address as text")),
        ("ROW", ("ROW([cell_ref])", "Returns the row number of a cell reference")),
        ("COLUMN", ("COLUMN([cell_ref])", "Returns the column number of a cell reference")),
        ("ROWS", ("ROWS(array)", "Returns the number of rows in a reference")),
        ("COLUMNS", ("COLUMNS(array)", "Returns the number of columns in a reference")),
        ("TRANSPOSE", ("TRANSPOSE(array)", "Returns the transpose of an array")),
        ("VLOOKUP", ("VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])", "Looks up a value in the first column of a table and returns a value in the same row")),
        ("HLOOKUP", ("HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])", "Looks up a value in the first row of a table and returns a value in the same column")),
        ("LOOKUP", ("LOOKUP(lookup_value, lookup_vector, [result_vector])", "Looks up a value in a one-row or one-column range")),
        // Information
        ("ISNUMBER", ("ISNUMBER(value)", "Checks if value is number")),
        ("ISTEXT", ("ISTEXT(value)", "Checks if value is text")),
        ("ISBLANK", ("ISBLANK(value)", "Checks if cell is empty")),
        ("ISERROR", ("ISERROR(value)", "Checks if value is error")),
        ("ISNA", ("ISNA(value)", "Checks if value is #N/A")),
        ("ISERR", ("ISERR(value)", "Checks if value is an error other than #N/A")),
        ("ISLOGICAL", ("ISLOGICAL(value)", "Checks if value is TRUE or FALSE")),
        ("ISODD", ("ISODD(number)", "Checks if a number is odd")),
        ("ISEVEN", ("ISEVEN(number)", "Checks if a number is even")),
        ("ISFORMULA", ("ISFORMULA(reference)", "Checks if a cell contains a formula")),
        ("TYPE", ("TYPE(value)", "Returns the type of a value (1=number, 2=text, 4=logical, 16=error)")),
        ("N", ("N(value)", "Returns a value converted to a number")),
        ("NA", ("NA()", "Returns the #N/A error value")),
        ("COUNTA", ("COUNTA(value1, [value2], ...)", "Counts non-empty cells")),
        ("ERROR.TYPE", ("ERROR.TYPE(error_val)", "Returns a number corresponding to the error type")),
        ("ISNONTEXT", ("ISNONTEXT(value)", "Returns TRUE if the value is not text")),
        ("ISREF", ("ISREF(value)", "Returns TRUE if the value is a reference")),
        ("SHEET", ("SHEET([value])", "Returns the sheet number of the referenced sheet")),
        ("SHEETS", ("SHEETS([reference])", "Returns the number of sheets in a reference or workbook")),
        // Date & Time
        ("TODAY", ("TODAY()", "Returns the current date as a serial number")),
        ("NOW", ("NOW()", "Returns the current date and time as a serial number")),
        ("DATE", ("DATE(year, month, day)", "Creates a date serial number from year, month, day")),
        ("YEAR", ("YEAR(serial_number)", "Returns the year from a date")),
        ("MONTH", ("MONTH(serial_number)", "Returns the month from a date")),
        ("DAY", ("DAY(serial_number)", "Returns the day from a date")),
        ("HOUR", ("HOUR(serial_number)", "Returns the hour from a time value")),
        ("MINUTE", ("MINUTE(serial_number)", "Returns the minute from a time value")),
        ("SECOND", ("SECOND(serial_number)", "Returns the second from a time value")),
        ("DATEVALUE", ("DATEVALUE(date_text)", "Converts a date string to a serial number")),
        ("TIMEVALUE", ("TIMEVALUE(time_text)", "Converts a time string to a decimal number")),
        ("EDATE", ("EDATE(start_date, months)", "Returns the date that is the indicated number of months before or after a date")),
        ("EOMONTH", ("EOMONTH(start_date, months)", "Returns the last day of the month a given number of months before or after a date")),
        ("NETWORKDAYS", ("NETWORKDAYS(start_date, end_date, [holidays])", "Returns the number of working days between two dates")),
        ("WORKDAY", ("WORKDAY(start_date, days, [holidays])", "Returns the date a given number of working days from a date")),
        ("DATEDIF", ("DATEDIF(start_date, end_date, unit)", "Calculates the difference between two dates")),
        ("WEEKDAY", ("WEEKDAY(serial_number, [return_type])", "Returns the day of the week")),
        ("WEEKNUM", ("WEEKNUM(serial_number, [return_type])", "Returns the week number of a date")),
        ("DAYS", ("DAYS(end_date, start_date)", "Returns the number of days between two dates")),
        ("TIME", ("TIME(hour, minute, second)", "Returns a time value from hour, minute, and second components")),
        // Statistical
        ("MEDIAN", ("MEDIAN(number1, [number2], ...)", "Returns the median of the given numbers")),
        ("STDEV", ("STDEV(number1, [number2], ...)", "Estimates standard deviation based on a sample")),
        ("STDEVP", ("STDEVP(number1, [number2], ...)", "Calculates standard deviation based on the entire population")),
        ("VAR", ("VAR(number1, [number2], ...)", "Estimates variance based on a sample")),
        ("VARP", ("VARP(number1, [number2], ...)", "Calculates variance based on the entire population")),
        ("LARGE", ("LARGE(array, k)", "Returns the k-th largest value in a data set")),
        ("SMALL", ("SMALL(array, k)", "Returns the k-th smallest value in a data set")),
        ("RANK", ("RANK(number, ref, [order])", "Returns the rank of a number in a list of numbers")),
        ("PERCENTILE", ("PERCENTILE(array, k)", "Returns the k-th percentile of values in a range")),
        ("QUARTILE", ("QUARTILE(array, quart)", "Returns the quartile of a data set")),
        ("MODE", ("MODE(number1, [number2], ...)", "Returns the most frequently occurring value")),
        ("FREQUENCY", ("FREQUENCY(data_array, bins_array)", "Returns a frequency distribution as a vertical array")),
        // Financial
        ("PMT", ("PMT(rate, nper, pv, [fv], [type])", "Calculates the payment for a loan based on constant payments and interest rate")),
        ("PV", ("PV(rate, nper, pmt, [fv], [type])", "Returns the present value of an investment")),
        ("FV", ("FV(rate, nper, pmt, [pv], [type])", "Returns the future value of an investment")),
        ("NPV", ("NPV(rate, value1, [value2], ...)", "Returns the net present value of an investment")),
        ("IRR", ("IRR(values, [guess])", "Returns the internal rate of return for a series of cash flows")),
        ("RATE", ("RATE(nper, pmt, pv, [fv], [type], [guess])", "Returns the interest rate per period of an annuity")),
        ("NPER", ("NPER(rate, pmt, pv, [fv], [type])", "Returns the number of periods for an investment")),
        ("SLN", ("SLN(cost, salvage, life)", "Returns straight-line depreciation for one period")),
        ("DB", ("DB(cost, salvage, life, period, [month])", "Returns fixed-declining balance depreciation")),
        ("DDB", ("DDB(cost, salvage, life, period, [factor])", "Returns double-declining balance depreciation")),
        // Engineering
        ("BIN2DEC", ("BIN2DEC(number)", "Converts a binary number to decimal")),
        ("BIN2HEX", ("BIN2HEX(number, [places])", "Converts a binary number to hexadecimal")),
        ("BIN2OCT", ("BIN2OCT(number, [places])", "Converts a binary number to octal")),
        ("DEC2BIN", ("DEC2BIN(number, [places])", "Converts a decimal number to binary")),
        ("DEC2HEX", ("DEC2HEX(number, [places])", "Converts a decimal number to hexadecimal")),
        ("DEC2OCT", ("DEC2OCT(number, [places])", "Converts a decimal number to octal")),
        ("HEX2BIN", ("HEX2BIN(number, [places])", "Converts a hexadecimal number to binary")),
        ("HEX2DEC", ("HEX2DEC(number)", "Converts a hexadecimal number to decimal")),
        ("HEX2OCT", ("HEX2OCT(number, [places])", "Converts a hexadecimal number to octal")),
        ("OCT2BIN", ("OCT2BIN(number, [places])", "Converts an octal number to binary")),
        ("OCT2DEC", ("OCT2DEC(number)", "Converts an octal number to decimal")),
        ("OCT2HEX", ("OCT2HEX(number, [places])", "Converts an octal number to hexadecimal")),
        ("BITAND", ("BITAND(number1, number2)", "Returns a bitwise AND of two numbers")),
        ("BITOR", ("BITOR(number1, number2)", "Returns a bitwise OR of two numbers")),
        ("BITXOR", ("BITXOR(number1, number2)", "Returns a bitwise XOR of two numbers")),
        ("BITLSHIFT", ("BITLSHIFT(number, shift_amount)", "Returns a number shifted left by the specified bits")),
        ("BITRSHIFT", ("BITRSHIFT(number, shift_amount)", "Returns a number shifted right by the specified bits")),
        ("COMPLEX", ("COMPLEX(real_num, i_num, [suffix])", "Converts real and imaginary coefficients into a complex number")),
        ("IMABS", ("IMABS(inumber)", "Returns the absolute value of a complex number")),
        ("IMAGINARY", ("IMAGINARY(inumber)", "Returns the imaginary coefficient of a complex number")),
        ("IMREAL", ("IMREAL(inumber)", "Returns the real coefficient of a complex number")),
        ("CONVERT", ("CONVERT(number, from_unit, to_unit)", "Converts a number from one measurement system to another")),
        ("DELTA", ("DELTA(number1, [number2])", "Tests whether two values are equal (returns 1 or 0)")),
        ("ERF", ("ERF(lower_limit, [upper_limit])", "Returns the error function")),
        ("ERFC", ("ERFC(x)", "Returns the complementary error function")),
        ("GESTEP", ("GESTEP(number, [step])", "Tests whether a number is greater than a threshold value")),
        ("BESSELI", ("BESSELI(x, n)", "Returns the modified Bessel function In(x)")),
        ("BESSELJ", ("BESSELJ(x, n)", "Returns the Bessel function Jn(x)")),
        ("BESSELK", ("BESSELK(x, n)", "Returns the modified Bessel function Kn(x)")),
        ("BESSELY", ("BESSELY(x, n)", "Returns the Bessel function Yn(x)")),
        ("SERIESSUM", ("SERIESSUM(x, n, m, coefficients)", "Returns the sum of a power series")),
        // Matrix
        ("MMULT", ("MMULT(array1, array2)", "Returns the matrix product of two arrays")),
        ("MDETERM", ("MDETERM(array)", "Returns the matrix determinant of an array")),
        ("MINVERSE", ("MINVERSE(array)", "Returns the inverse matrix for a given matrix")),
        ("MUNIT", ("MUNIT(dimension)", "Returns the unit matrix for the specified dimension")),
        // Dynamic Array
        ("FILTER", ("FILTER(array, include, [if_empty])", "Filters an array based on a Boolean array, returning only matching rows or columns")),
        ("SORT", ("SORT(array, [sort_index], [sort_order], [by_col])", "Sorts the contents of a range or array by one or more columns")),
        ("UNIQUE", ("UNIQUE(array, [by_col], [exactly_once])", "Returns unique values from a range or array, removing duplicates")),
        ("SEQUENCE", ("SEQUENCE(rows, [columns], [start], [step])", "Generates a sequence of numbers in an array")),
        ("SORTBY", ("SORTBY(array, by_array1, [sort_order1], [by_array2], [sort_order2], ...)", "Sorts a range or array based on the values in one or more corresponding ranges or arrays")),
        ("RANDARRAY", ("RANDARRAY([rows], [columns], [min], [max], [whole_number])", "Returns an array of random numbers between min and max")),
        ("GROUPBY", ("GROUPBY(row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array])", "Groups data by row fields and aggregates values using a specified function")),
        ("PIVOTBY", ("PIVOTBY(row_fields, col_fields, values, function, [field_headers], [row_total_depth], [row_sort_order], [col_total_depth], [col_sort_order], [filter_array])", "Creates a pivot table by grouping data by row and column fields, aggregating values")),
        ("COLLECT", ("COLLECT(value)", "Wraps an array result into a contained List cell instead of spilling. Creates a 3D cell.")),
        ("DICT", ("DICT(key1, value1, [key2, value2], ...)", "Creates a Dict cell from alternating key-value pairs. Keys can be text, numbers, or booleans.")),
        ("KEYS", ("KEYS(collection)", "Returns an array of keys from a Dict, or indices (0-based) from a List.")),
        ("VALUES", ("VALUES(collection)", "Returns an array of values from a Dict or List.")),
        ("CONTAINS", ("CONTAINS(collection, value)", "Returns TRUE if value exists in a List, or if key exists in a Dict.")),
        ("ISLIST", ("ISLIST(value)", "Returns TRUE if the value is a List cell.")),
        ("ISDICT", ("ISDICT(value)", "Returns TRUE if the value is a Dict cell.")),
        ("FLATTEN", ("FLATTEN(list)", "Recursively flattens nested lists into a single-level list.")),
        ("TAKE", ("TAKE(list, n)", "Returns the first n elements of a list as a new list.")),
        ("DROP", ("DROP(list, n)", "Removes the first n elements from a list and returns the rest.")),
        ("APPEND", ("APPEND(list, value)", "Returns a new list with value appended to the end.")),
        ("MERGE", ("MERGE(dict1, dict2)", "Merges two dicts. Second dict wins on key conflicts.")),
        ("HSTACK", ("HSTACK(list1, list2)", "Concatenates two lists into one.")),
        // UI
        ("GET.ROW.HEIGHT", ("GET.ROW.HEIGHT(row)", "Returns the height in pixels of the specified row (1-indexed). Returns the default height (24) if not customized.")),
        ("GET.COLUMN.WIDTH", ("GET.COLUMN.WIDTH(col)", "Returns the width in pixels of the specified column (1-indexed). Returns the default width (100) if not customized.")),
        ("GET.CELL.FILLCOLOR", ("GET.CELL.FILLCOLOR(cell_ref)", "Returns the background fill color of a cell as a CSS color string (hex or rgba).")),
        // File
        ("FILEREAD", ("FILEREAD(path)", "Returns the text content of a virtual file")),
        ("FILELINES", ("FILELINES(path)", "Returns the number of lines in a virtual file")),
        ("FILEEXISTS", ("FILEEXISTS(path)", "Returns TRUE if a virtual file exists")),
        // Database
        ("DAVERAGE", ("DAVERAGE(database, field, criteria)", "Averages values in a column of a list or database that match conditions")),
        ("DCOUNT", ("DCOUNT(database, field, criteria)", "Counts cells containing numbers in a database that match conditions")),
        ("DCOUNTA", ("DCOUNTA(database, field, criteria)", "Counts nonblank cells in a database that match conditions")),
        ("DGET", ("DGET(database, field, criteria)", "Extracts a single value from a database that matches conditions")),
        ("DMAX", ("DMAX(database, field, criteria)", "Returns the maximum value in a database that matches conditions")),
        ("DMIN", ("DMIN(database, field, criteria)", "Returns the minimum value in a database that matches conditions")),
        ("DPRODUCT", ("DPRODUCT(database, field, criteria)", "Multiplies values in a database that match conditions")),
        ("DSTDEV", ("DSTDEV(database, field, criteria)", "Estimates standard deviation based on a sample from matching database entries")),
        ("DSTDEVP", ("DSTDEVP(database, field, criteria)", "Calculates standard deviation based on the entire population of matching database entries")),
        ("DSUM", ("DSUM(database, field, criteria)", "Sums values in a database that match conditions")),
        ("DVAR", ("DVAR(database, field, criteria)", "Estimates variance based on a sample from matching database entries")),
        ("DVARP", ("DVARP(database, field, criteria)", "Calculates variance based on the entire population of matching database entries")),
    ]);

    BuiltinFunction::all_catalog_entries()
        .into_iter()
        .map(|(name, category)| {
            let (syntax, description) = descriptions
                .get(name)
                .copied()
                .unwrap_or((name, ""));
            FunctionInfo {
                name: name.to_string(),
                syntax: syntax.to_string(),
                description: description.to_string(),
                category: category.to_string(),
            }
        })
        .collect()
}

/// Get list of available functions by category.
#[tauri::command]
pub fn get_functions_by_category(category: String) -> FunctionListResult {
    log_enter!("CMD", "get_functions_by_category", "category={}", category);

    let all = build_full_catalog();
    let cat_lower = category.to_lowercase();
    let functions: Vec<FunctionInfo> = all.into_iter().filter(|f| {
        let fc = f.category.to_lowercase();
        match cat_lower.as_str() {
            "autosum" | "math" => fc == "math",
            "lookup" | "lookup & reference" => fc == "lookup & reference",
            "info" | "information" => fc == "information",
            "date" | "date & time" => fc == "date & time",
            "dynamic" | "dynamic array" => fc == "dynamic array",
            other => fc == other,
        }
    }).collect();

    log_exit!("CMD", "get_functions_by_category", "count={}", functions.len());
    FunctionListResult { functions }
}

/// Get all available functions.
#[tauri::command]
pub fn get_all_functions() -> FunctionListResult {
    log_enter!("CMD", "get_all_functions");
    let functions = build_full_catalog();
    log_exit!("CMD", "get_all_functions", "count={}", functions.len());
    FunctionListResult { functions }
}

/// Generate a formula template for insertion.
#[tauri::command]
pub fn get_function_template(function_name: String) -> String {
    log_enter!("CMD", "get_function_template", "name={}", function_name);
    
    let template = match function_name.to_uppercase().as_str() {
        // Aggregate functions
        "SUM" => "=SUM()".to_string(),
        "SUMIF" => "=SUMIF(, )".to_string(),
        "SUMIFS" => "=SUMIFS(, , )".to_string(),
        "SUMPRODUCT" => "=SUMPRODUCT()".to_string(),
        "SUMX2MY2" => "=SUMX2MY2(, )".to_string(),
        "SUMX2PY2" => "=SUMX2PY2(, )".to_string(),
        "SUMXMY2" => "=SUMXMY2(, )".to_string(),
        "PRODUCT" => "=PRODUCT()".to_string(),
        "AVERAGE" => "=AVERAGE()".to_string(),
        "AVERAGEIF" => "=AVERAGEIF(, )".to_string(),
        "AVERAGEIFS" => "=AVERAGEIFS(, , )".to_string(),
        "COUNT" => "=COUNT()".to_string(),
        "COUNTIF" => "=COUNTIF(, )".to_string(),
        "COUNTIFS" => "=COUNTIFS(, )".to_string(),
        "COUNTBLANK" => "=COUNTBLANK()".to_string(),
        "COUNTA" => "=COUNTA()".to_string(),
        "MAX" => "=MAX()".to_string(),
        "MAXIFS" => "=MAXIFS(, , )".to_string(),
        "MIN" => "=MIN()".to_string(),
        "MINIFS" => "=MINIFS(, , )".to_string(),

        // Logical functions
        "IF" => "=IF(, , )".to_string(),
        "IFERROR" => "=IFERROR(, )".to_string(),
        "IFNA" => "=IFNA(, )".to_string(),
        "IFS" => "=IFS(, )".to_string(),
        "SWITCH" => "=SWITCH(, , )".to_string(),
        "AND" => "=AND()".to_string(),
        "OR" => "=OR()".to_string(),
        "NOT" => "=NOT()".to_string(),
        "XOR" => "=XOR()".to_string(),
        "LET" => "=LET(, , )".to_string(),
        "LAMBDA" => "=LAMBDA(, )".to_string(),
        "MAP" => "=MAP(, LAMBDA(, ))".to_string(),
        "REDUCE" => "=REDUCE(, , LAMBDA(, , ))".to_string(),
        "SCAN" => "=SCAN(, , LAMBDA(, , ))".to_string(),
        "MAKEARRAY" => "=MAKEARRAY(, , LAMBDA(, , ))".to_string(),
        "BYROW" => "=BYROW(, LAMBDA(, ))".to_string(),
        "BYCOL" => "=BYCOL(, LAMBDA(, ))".to_string(),

        // Math functions
        "ABS" => "=ABS()".to_string(),
        "ROUND" => "=ROUND(, )".to_string(),
        "ROUNDUP" => "=ROUNDUP(, )".to_string(),
        "ROUNDDOWN" => "=ROUNDDOWN(, )".to_string(),
        "FLOOR" => "=FLOOR(, )".to_string(),
        "CEILING" => "=CEILING(, )".to_string(),
        "SQRT" => "=SQRT()".to_string(),
        "POWER" => "=POWER(, )".to_string(),
        "MOD" => "=MOD(, )".to_string(),
        "INT" => "=INT()".to_string(),
        "SIGN" => "=SIGN()".to_string(),
        "TRUNC" => "=TRUNC()".to_string(),
        "EVEN" => "=EVEN()".to_string(),
        "ODD" => "=ODD()".to_string(),
        "GCD" => "=GCD(, )".to_string(),
        "LCM" => "=LCM(, )".to_string(),
        "COMBIN" => "=COMBIN(, )".to_string(),
        "FACT" => "=FACT()".to_string(),
        "PI" => "=PI()".to_string(),
        "RAND" => "=RAND()".to_string(),
        "RANDBETWEEN" => "=RANDBETWEEN(, )".to_string(),
        "LOG" => "=LOG(, )".to_string(),
        "LOG10" => "=LOG10()".to_string(),
        "LN" => "=LN()".to_string(),
        "EXP" => "=EXP()".to_string(),
        "SIN" => "=SIN()".to_string(),
        "COS" => "=COS()".to_string(),
        "TAN" => "=TAN()".to_string(),
        "ASIN" => "=ASIN()".to_string(),
        "ACOS" => "=ACOS()".to_string(),
        "ATAN" => "=ATAN()".to_string(),
        "ATAN2" => "=ATAN2(, )".to_string(),
        "DEGREES" => "=DEGREES()".to_string(),
        "RADIANS" => "=RADIANS()".to_string(),
        "MROUND" => "=MROUND(, )".to_string(),
        "QUOTIENT" => "=QUOTIENT(, )".to_string(),
        "SUMSQ" => "=SUMSQ()".to_string(),
        "ROMAN" => "=ROMAN()".to_string(),
        "ARABIC" => "=ARABIC()".to_string(),
        "BASE" => "=BASE(, )".to_string(),
        "DECIMAL" => "=DECIMAL(, )".to_string(),
        "SINH" => "=SINH()".to_string(),
        "COSH" => "=COSH()".to_string(),
        "TANH" => "=TANH()".to_string(),
        "COT" => "=COT()".to_string(),
        "COTH" => "=COTH()".to_string(),
        "CSC" => "=CSC()".to_string(),
        "CSCH" => "=CSCH()".to_string(),
        "SEC" => "=SEC()".to_string(),
        "SECH" => "=SECH()".to_string(),
        "ACOT" => "=ACOT()".to_string(),
        "CEILING.MATH" => "=CEILING.MATH(, )".to_string(),
        "CEILING.PRECISE" => "=CEILING.PRECISE(, )".to_string(),
        "FLOOR.MATH" => "=FLOOR.MATH(, )".to_string(),
        "FLOOR.PRECISE" => "=FLOOR.PRECISE(, )".to_string(),
        "ISO.CEILING" => "=ISO.CEILING(, )".to_string(),
        "MULTINOMIAL" => "=MULTINOMIAL(, )".to_string(),
        "COMBINA" => "=COMBINA(, )".to_string(),
        "FACTDOUBLE" => "=FACTDOUBLE()".to_string(),
        "SQRTPI" => "=SQRTPI()".to_string(),
        "AGGREGATE" => "=AGGREGATE(, , )".to_string(),

        // Text functions
        "CONCATENATE" => "=CONCATENATE()".to_string(),
        "LEFT" => "=LEFT(, )".to_string(),
        "RIGHT" => "=RIGHT(, )".to_string(),
        "MID" => "=MID(, , )".to_string(),
        "LEN" => "=LEN()".to_string(),
        "UPPER" => "=UPPER()".to_string(),
        "LOWER" => "=LOWER()".to_string(),
        "TRIM" => "=TRIM()".to_string(),
        "REPT" => "=REPT(, )".to_string(),
        "TEXT" => "=TEXT(, )".to_string(),
        "FIND" => "=FIND(, )".to_string(),
        "SEARCH" => "=SEARCH(, )".to_string(),
        "SUBSTITUTE" => "=SUBSTITUTE(, , )".to_string(),
        "REPLACE" => "=REPLACE(, , , )".to_string(),
        "VALUE" => "=VALUE()".to_string(),
        "EXACT" => "=EXACT(, )".to_string(),
        "PROPER" => "=PROPER()".to_string(),
        "CHAR" => "=CHAR()".to_string(),
        "CODE" => "=CODE()".to_string(),
        "CLEAN" => "=CLEAN()".to_string(),
        "NUMBERVALUE" => "=NUMBERVALUE()".to_string(),
        "T" => "=T()".to_string(),
        "TEXTJOIN" => "=TEXTJOIN(, , )".to_string(),
        "DOLLAR" => "=DOLLAR(, )".to_string(),
        "EURO" => "=EURO(, )".to_string(),
        "FIXED" => "=FIXED(, )".to_string(),
        "UNICHAR" => "=UNICHAR()".to_string(),
        "UNICODE" => "=UNICODE()".to_string(),
        "ENCODEURL" => "=ENCODEURL()".to_string(),

        // Lookup & Reference functions
        "VLOOKUP" => "=VLOOKUP(, , , )".to_string(),
        "HLOOKUP" => "=HLOOKUP(, , , )".to_string(),
        "LOOKUP" => "=LOOKUP(, )".to_string(),
        "XLOOKUP" => "=XLOOKUP(, , )".to_string(),
        "INDEX" => "=INDEX(, )".to_string(),
        "MATCH" => "=MATCH(, )".to_string(),
        "CHOOSE" => "=CHOOSE(, )".to_string(),
        "INDIRECT" => "=INDIRECT()".to_string(),
        "OFFSET" => "=OFFSET(, , )".to_string(),
        "ADDRESS" => "=ADDRESS(, )".to_string(),
        "ROWS" => "=ROWS()".to_string(),
        "COLUMNS" => "=COLUMNS()".to_string(),
        "TRANSPOSE" => "=TRANSPOSE()".to_string(),

        // Date & Time functions
        "TODAY" => "=TODAY()".to_string(),
        "NOW" => "=NOW()".to_string(),
        "DATE" => "=DATE(, , )".to_string(),
        "YEAR" => "=YEAR()".to_string(),
        "MONTH" => "=MONTH()".to_string(),
        "DAY" => "=DAY()".to_string(),
        "HOUR" => "=HOUR()".to_string(),
        "MINUTE" => "=MINUTE()".to_string(),
        "SECOND" => "=SECOND()".to_string(),
        "DATEVALUE" => "=DATEVALUE()".to_string(),
        "TIMEVALUE" => "=TIMEVALUE()".to_string(),
        "EDATE" => "=EDATE(, )".to_string(),
        "EOMONTH" => "=EOMONTH(, )".to_string(),
        "NETWORKDAYS" => "=NETWORKDAYS(, )".to_string(),
        "WORKDAY" => "=WORKDAY(, )".to_string(),
        "DATEDIF" => "=DATEDIF(, , )".to_string(),
        "WEEKDAY" => "=WEEKDAY()".to_string(),
        "WEEKNUM" => "=WEEKNUM()".to_string(),
        "DAYS" => "=DAYS(, )".to_string(),
        "TIME" => "=TIME(, , )".to_string(),

        // Statistical functions
        "MEDIAN" => "=MEDIAN()".to_string(),
        "STDEV" => "=STDEV()".to_string(),
        "STDEVP" => "=STDEVP()".to_string(),
        "VAR" => "=VAR()".to_string(),
        "VARP" => "=VARP()".to_string(),
        "LARGE" => "=LARGE(, )".to_string(),
        "SMALL" => "=SMALL(, )".to_string(),
        "RANK" => "=RANK(, )".to_string(),
        "PERCENTILE" => "=PERCENTILE(, )".to_string(),
        "QUARTILE" => "=QUARTILE(, )".to_string(),
        "MODE" => "=MODE()".to_string(),
        "FREQUENCY" => "=FREQUENCY(, )".to_string(),

        // Financial functions
        "PMT" => "=PMT(, , )".to_string(),
        "PV" => "=PV(, , )".to_string(),
        "FV" => "=FV(, , )".to_string(),
        "NPV" => "=NPV(, )".to_string(),
        "IRR" => "=IRR()".to_string(),
        "RATE" => "=RATE(, , )".to_string(),
        "NPER" => "=NPER(, , )".to_string(),
        "SLN" => "=SLN(, , )".to_string(),
        "DB" => "=DB(, , , )".to_string(),
        "DDB" => "=DDB(, , , )".to_string(),

        // Information functions
        "ISNUMBER" => "=ISNUMBER()".to_string(),
        "ISTEXT" => "=ISTEXT()".to_string(),
        "ISBLANK" => "=ISBLANK()".to_string(),
        "ISERROR" => "=ISERROR()".to_string(),
        "ISNA" => "=ISNA()".to_string(),
        "ISERR" => "=ISERR()".to_string(),
        "ISLOGICAL" => "=ISLOGICAL()".to_string(),
        "ISODD" => "=ISODD()".to_string(),
        "ISEVEN" => "=ISEVEN()".to_string(),
        "ISFORMULA" => "=ISFORMULA()".to_string(),
        "ERROR.TYPE" => "=ERROR.TYPE()".to_string(),
        "ISNONTEXT" => "=ISNONTEXT()".to_string(),
        "ISREF" => "=ISREF()".to_string(),
        "SHEET" => "=SHEET()".to_string(),
        "SHEETS" => "=SHEETS()".to_string(),
        "TYPE" => "=TYPE()".to_string(),
        "N" => "=N()".to_string(),
        "NA" => "=NA()".to_string(),

        // UI functions
        "GET.ROW.HEIGHT" | "GETROWHEIGHT" => "=GET.ROW.HEIGHT()".to_string(),
        "GET.COLUMN.WIDTH" | "GETCOLUMNWIDTH" => "=GET.COLUMN.WIDTH()".to_string(),
        "GET.CELL.FILLCOLOR" | "GETCELLFILLCOLOR" => "=GET.CELL.FILLCOLOR()".to_string(),

        // Reference functions
        "ROW" => "=ROW()".to_string(),
        "COLUMN" => "=COLUMN()".to_string(),

        // Dynamic array functions
        "FILTER" => "=FILTER(, )".to_string(),
        "SORT" => "=SORT()".to_string(),
        "SORTBY" => "=SORTBY(, )".to_string(),
        "UNIQUE" => "=UNIQUE()".to_string(),
        "SEQUENCE" => "=SEQUENCE()".to_string(),
        "RANDARRAY" => "=RANDARRAY()".to_string(),
        "GROUPBY" => "=GROUPBY(, , )".to_string(),
        "PIVOTBY" => "=PIVOTBY(, , , )".to_string(),
        "COLLECT" => "=COLLECT()".to_string(),
        "DICT" => "=DICT(, )".to_string(),
        "KEYS" => "=KEYS()".to_string(),
        "VALUES" => "=VALUES()".to_string(),
        "CONTAINS" => "=CONTAINS(, )".to_string(),
        "ISLIST" => "=ISLIST()".to_string(),
        "ISDICT" => "=ISDICT()".to_string(),
        "FLATTEN" => "=FLATTEN()".to_string(),
        "TAKE" => "=TAKE(, )".to_string(),
        "DROP" => "=DROP(, )".to_string(),
        "APPEND" => "=APPEND(, )".to_string(),
        "MERGE" => "=MERGE(, )".to_string(),
        "HSTACK" => "=HSTACK(, )".to_string(),

        // File functions
        "FILEREAD" => "=FILEREAD(\"\")".to_string(),
        "FILELINES" => "=FILELINES(\"\")".to_string(),
        "FILEEXISTS" => "=FILEEXISTS(\"\")".to_string(),

        // Database functions
        "DAVERAGE" => "=DAVERAGE(, , )".to_string(),
        "DCOUNT" => "=DCOUNT(, , )".to_string(),
        "DCOUNTA" => "=DCOUNTA(, , )".to_string(),
        "DGET" => "=DGET(, , )".to_string(),
        "DMAX" => "=DMAX(, , )".to_string(),
        "DMIN" => "=DMIN(, , )".to_string(),
        "DPRODUCT" => "=DPRODUCT(, , )".to_string(),
        "DSTDEV" => "=DSTDEV(, , )".to_string(),
        "DSTDEVP" => "=DSTDEVP(, , )".to_string(),
        "DSUM" => "=DSUM(, , )".to_string(),
        "DVAR" => "=DVAR(, , )".to_string(),
        "DVARP" => "=DVARP(, , )".to_string(),

        // Default: generic function call
        _ => format!("={}()", function_name.to_uppercase()),
    };
    
    log_exit!("CMD", "get_function_template", "template={}", template);
    template
}

// ============================================================================
// Expression Evaluation (for file template resolution)
// ============================================================================

/// Evaluate a batch of formula expressions against the current grid state.
/// Used by the file template system to resolve {{ expression }} blocks.
/// Each expression is parsed and evaluated independently; errors are returned
/// as error strings (e.g., "#REF!", "#NAME?") rather than Rust errors.
#[tauri::command]
pub fn evaluate_expressions(
    expressions: Vec<String>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
) -> Result<Vec<String>, String> {
    log_enter!("CMD", "evaluate_expressions", "count={}", expressions.len());

    let grids = state.grids.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let user_files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    if active_sheet >= grids.len() || active_sheet >= sheet_names.len() {
        return Err("Invalid active sheet index".to_string());
    }

    let current_grid = &grids[active_sheet];
    let current_sheet_name = &sheet_names[active_sheet];

    // Build multi-sheet context once for all expressions
    let context = crate::create_multi_sheet_context(&grids, &sheet_names, current_sheet_name);
    let reader = |path: &str| -> Option<String> {
        user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
    };
    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    evaluator.set_file_reader(&reader);

    let results: Vec<String> = expressions
        .iter()
        .map(|expr_str| {
            // Strip leading = if present (user might write {{ =SUM() }} or {{ SUM() }})
            let formula = expr_str.trim();
            let formula = if formula.starts_with('=') { &formula[1..] } else { formula };

            match parse_formula(formula) {
                Ok(parser_ast) => {
                    let engine_ast = crate::convert_expr(&parser_ast);
                    let result = evaluator.evaluate(&engine_ast);
                    eval_result_to_display(&result)
                }
                Err(_) => "#SYNTAX!".to_string(),
            }
        })
        .collect();

    log_exit!("CMD", "evaluate_expressions", "count={}", results.len());
    Ok(results)
}

/// Convert an EvalResult to a display string for template resolution.
fn eval_result_to_display(result: &EvalResult) -> String {
    match result {
        EvalResult::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        EvalResult::Text(s) => s.clone(),
        EvalResult::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        EvalResult::Error(e) => format!("#{}", format!("{:?}", e).to_uppercase()),
        EvalResult::Array(arr) => {
            if let Some(first) = arr.first() {
                eval_result_to_display(first)
            } else {
                String::new()
            }
        }
        EvalResult::List(items) => format!("[List({})]", items.len()),
        EvalResult::Dict(entries) => format!("[Dict({})]", entries.len()),
        EvalResult::Lambda { .. } => "#LAMBDA".to_string(),
    }
}