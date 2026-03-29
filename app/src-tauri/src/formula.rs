//! FILENAME: app/src-tauri/src/formula.rs
// PURPOSE: Formula library commands - function catalog, templates, and expression evaluation
// FORMAT: seq|level|category|message

use crate::api_types::{FunctionInfo, FunctionListResult};
use crate::logging::{log_enter, log_exit};
use crate::AppState;
use crate::persistence::UserFilesState;
use tauri::State;
use parser::parse as parse_formula;
use engine::{Evaluator, EvalResult};

/// Get list of available functions by category.
#[tauri::command]
pub fn get_functions_by_category(category: String) -> FunctionListResult {
    log_enter!("CMD", "get_functions_by_category", "category={}", category);
    
    let functions = match category.to_lowercase().as_str() {
        "autosum" | "math" => vec![
            FunctionInfo {
                name: "SUM".to_string(),
                syntax: "SUM(number1, [number2], ...)".to_string(),
                description: "Adds all numbers in a range".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "SUMIF".to_string(),
                syntax: "SUMIF(range, criteria, [sum_range])".to_string(),
                description: "Sums cells that meet a condition".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "SUMIFS".to_string(),
                syntax: "SUMIFS(sum_range, criteria_range1, criteria1, ...)".to_string(),
                description: "Sums cells that meet multiple conditions".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "SUMPRODUCT".to_string(),
                syntax: "SUMPRODUCT(array1, [array2], ...)".to_string(),
                description: "Returns the sum of products of corresponding ranges".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "AVERAGE".to_string(),
                syntax: "AVERAGE(number1, [number2], ...)".to_string(),
                description: "Returns the average of numbers".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "AVERAGEIF".to_string(),
                syntax: "AVERAGEIF(range, criteria, [average_range])".to_string(),
                description: "Averages cells that meet a condition".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "AVERAGEIFS".to_string(),
                syntax: "AVERAGEIFS(average_range, criteria_range1, criteria1, ...)".to_string(),
                description: "Averages cells that meet multiple conditions".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "COUNT".to_string(),
                syntax: "COUNT(value1, [value2], ...)".to_string(),
                description: "Counts cells containing numbers".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "COUNTIF".to_string(),
                syntax: "COUNTIF(range, criteria)".to_string(),
                description: "Counts cells that meet a condition".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "COUNTIFS".to_string(),
                syntax: "COUNTIFS(criteria_range1, criteria1, ...)".to_string(),
                description: "Counts cells that meet multiple conditions".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "COUNTBLANK".to_string(),
                syntax: "COUNTBLANK(range)".to_string(),
                description: "Counts empty cells in a range".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "MAX".to_string(),
                syntax: "MAX(number1, [number2], ...)".to_string(),
                description: "Returns the largest value".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "MAXIFS".to_string(),
                syntax: "MAXIFS(max_range, criteria_range1, criteria1, ...)".to_string(),
                description: "Returns the maximum value among cells that meet conditions".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "MIN".to_string(),
                syntax: "MIN(number1, [number2], ...)".to_string(),
                description: "Returns the smallest value".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "MINIFS".to_string(),
                syntax: "MINIFS(min_range, criteria_range1, criteria1, ...)".to_string(),
                description: "Returns the minimum value among cells that meet conditions".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "ABS".to_string(),
                syntax: "ABS(number)".to_string(),
                description: "Returns absolute value".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "ROUND".to_string(),
                syntax: "ROUND(number, num_digits)".to_string(),
                description: "Rounds a number".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "ROUNDUP".to_string(),
                syntax: "ROUNDUP(number, num_digits)".to_string(),
                description: "Rounds a number up, away from zero".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "ROUNDDOWN".to_string(),
                syntax: "ROUNDDOWN(number, num_digits)".to_string(),
                description: "Rounds a number down, toward zero".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "SQRT".to_string(),
                syntax: "SQRT(number)".to_string(),
                description: "Square root".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "POWER".to_string(),
                syntax: "POWER(number, power)".to_string(),
                description: "Raises to power".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "MOD".to_string(),
                syntax: "MOD(number, divisor)".to_string(),
                description: "Returns remainder".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "TRUNC".to_string(),
                syntax: "TRUNC(number, [num_digits])".to_string(),
                description: "Truncates a number to an integer".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "EVEN".to_string(),
                syntax: "EVEN(number)".to_string(),
                description: "Rounds up to the nearest even integer".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "ODD".to_string(),
                syntax: "ODD(number)".to_string(),
                description: "Rounds up to the nearest odd integer".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "GCD".to_string(),
                syntax: "GCD(number1, number2, ...)".to_string(),
                description: "Returns the greatest common divisor".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "LCM".to_string(),
                syntax: "LCM(number1, number2, ...)".to_string(),
                description: "Returns the least common multiple".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "COMBIN".to_string(),
                syntax: "COMBIN(number, number_chosen)".to_string(),
                description: "Returns the number of combinations".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "FACT".to_string(),
                syntax: "FACT(number)".to_string(),
                description: "Returns the factorial of a number".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "PI".to_string(),
                syntax: "PI()".to_string(),
                description: "Returns the value of pi".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "RAND".to_string(),
                syntax: "RAND()".to_string(),
                description: "Returns a random number between 0 and 1".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "RANDBETWEEN".to_string(),
                syntax: "RANDBETWEEN(bottom, top)".to_string(),
                description: "Returns a random integer between two values".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "LOG".to_string(),
                syntax: "LOG(number, [base])".to_string(),
                description: "Returns the logarithm of a number".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "LOG10".to_string(),
                syntax: "LOG10(number)".to_string(),
                description: "Returns the base-10 logarithm".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "LN".to_string(),
                syntax: "LN(number)".to_string(),
                description: "Returns the natural logarithm".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "EXP".to_string(),
                syntax: "EXP(number)".to_string(),
                description: "Returns e raised to a power".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "SIN".to_string(),
                syntax: "SIN(number)".to_string(),
                description: "Returns the sine of an angle".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "COS".to_string(),
                syntax: "COS(number)".to_string(),
                description: "Returns the cosine of an angle".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "TAN".to_string(),
                syntax: "TAN(number)".to_string(),
                description: "Returns the tangent of an angle".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "ASIN".to_string(),
                syntax: "ASIN(number)".to_string(),
                description: "Returns the arcsine of a number".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "ACOS".to_string(),
                syntax: "ACOS(number)".to_string(),
                description: "Returns the arccosine of a number".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "ATAN".to_string(),
                syntax: "ATAN(number)".to_string(),
                description: "Returns the arctangent of a number".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "ATAN2".to_string(),
                syntax: "ATAN2(x_num, y_num)".to_string(),
                description: "Returns the arctangent from x and y coordinates".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "DEGREES".to_string(),
                syntax: "DEGREES(angle)".to_string(),
                description: "Converts radians to degrees".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "RADIANS".to_string(),
                syntax: "RADIANS(angle)".to_string(),
                description: "Converts degrees to radians".to_string(),
                category: "Math".to_string(),
            },
        ],
        "logical" => vec![
            FunctionInfo {
                name: "IF".to_string(),
                syntax: "IF(condition, value_if_true, [value_if_false])".to_string(),
                description: "Conditional logic".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "IFERROR".to_string(),
                syntax: "IFERROR(value, value_if_error)".to_string(),
                description: "Returns value_if_error if expression is an error".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "IFNA".to_string(),
                syntax: "IFNA(value, value_if_na)".to_string(),
                description: "Returns value_if_na if expression is #N/A".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "IFS".to_string(),
                syntax: "IFS(condition1, value1, [condition2, value2], ...)".to_string(),
                description: "Checks multiple conditions and returns the first TRUE result".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "SWITCH".to_string(),
                syntax: "SWITCH(expression, value1, result1, [value2, result2], ..., [default])".to_string(),
                description: "Evaluates expression against a list of values and returns corresponding result".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "AND".to_string(),
                syntax: "AND(logical1, [logical2], ...)".to_string(),
                description: "TRUE if all arguments are TRUE".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "OR".to_string(),
                syntax: "OR(logical1, [logical2], ...)".to_string(),
                description: "TRUE if any argument is TRUE".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "NOT".to_string(),
                syntax: "NOT(logical)".to_string(),
                description: "Reverses the logic".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "XOR".to_string(),
                syntax: "XOR(logical1, [logical2], ...)".to_string(),
                description: "Returns TRUE if an odd number of arguments are TRUE".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "LET".to_string(),
                syntax: "LET(name1, name_value1, calculation_or_name2, [name_value2, calculation_or_name3], ...)".to_string(),
                description: "Assigns names to calculation results to improve readability and performance".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "LAMBDA".to_string(),
                syntax: "LAMBDA([parameter1, parameter2, ...], calculation)".to_string(),
                description: "Creates a custom reusable function with parameters".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "MAP".to_string(),
                syntax: "MAP(array, lambda)".to_string(),
                description: "Returns an array by applying a LAMBDA to each value in an array".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "REDUCE".to_string(),
                syntax: "REDUCE(initial_value, array, lambda)".to_string(),
                description: "Reduces an array to a single value by applying a LAMBDA accumulator".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "SCAN".to_string(),
                syntax: "SCAN(initial_value, array, lambda)".to_string(),
                description: "Scans an array by applying a LAMBDA and returns an array of intermediate values".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "MAKEARRAY".to_string(),
                syntax: "MAKEARRAY(rows, cols, lambda)".to_string(),
                description: "Returns an array of specified dimensions by applying a LAMBDA".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "BYROW".to_string(),
                syntax: "BYROW(array, lambda)".to_string(),
                description: "Applies a LAMBDA to each row in an array and returns an array of results".to_string(),
                category: "Logical".to_string(),
            },
            FunctionInfo {
                name: "BYCOL".to_string(),
                syntax: "BYCOL(array, lambda)".to_string(),
                description: "Applies a LAMBDA to each column in an array and returns an array of results".to_string(),
                category: "Logical".to_string(),
            },
        ],
        "text" => vec![
            FunctionInfo {
                name: "CONCATENATE".to_string(),
                syntax: "CONCATENATE(text1, [text2], ...)".to_string(),
                description: "Joins text strings".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "LEFT".to_string(),
                syntax: "LEFT(text, [num_chars])".to_string(),
                description: "Returns leftmost characters".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "RIGHT".to_string(),
                syntax: "RIGHT(text, [num_chars])".to_string(),
                description: "Returns rightmost characters".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "MID".to_string(),
                syntax: "MID(text, start_num, num_chars)".to_string(),
                description: "Returns characters from middle".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "LEN".to_string(),
                syntax: "LEN(text)".to_string(),
                description: "Returns length of text".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "UPPER".to_string(),
                syntax: "UPPER(text)".to_string(),
                description: "Converts to uppercase".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "LOWER".to_string(),
                syntax: "LOWER(text)".to_string(),
                description: "Converts to lowercase".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "TRIM".to_string(),
                syntax: "TRIM(text)".to_string(),
                description: "Removes extra spaces".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "FIND".to_string(),
                syntax: "FIND(find_text, within_text, [start_num])".to_string(),
                description: "Finds text within another string (case-sensitive)".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "SEARCH".to_string(),
                syntax: "SEARCH(find_text, within_text, [start_num])".to_string(),
                description: "Finds text within another string (case-insensitive, supports wildcards)".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "SUBSTITUTE".to_string(),
                syntax: "SUBSTITUTE(text, old_text, new_text, [instance_num])".to_string(),
                description: "Substitutes new text for old text".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "REPLACE".to_string(),
                syntax: "REPLACE(old_text, start_num, num_chars, new_text)".to_string(),
                description: "Replaces characters within text".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "VALUE".to_string(),
                syntax: "VALUE(text)".to_string(),
                description: "Converts a text string to a number".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "EXACT".to_string(),
                syntax: "EXACT(text1, text2)".to_string(),
                description: "Checks whether two text strings are exactly the same".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "PROPER".to_string(),
                syntax: "PROPER(text)".to_string(),
                description: "Capitalizes the first letter of each word".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "CHAR".to_string(),
                syntax: "CHAR(number)".to_string(),
                description: "Returns the character for a given code number".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "CODE".to_string(),
                syntax: "CODE(text)".to_string(),
                description: "Returns the code number for the first character".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "CLEAN".to_string(),
                syntax: "CLEAN(text)".to_string(),
                description: "Removes non-printable characters from text".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "NUMBERVALUE".to_string(),
                syntax: "NUMBERVALUE(text, [decimal_separator], [group_separator])".to_string(),
                description: "Converts text to number with locale control".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "T".to_string(),
                syntax: "T(value)".to_string(),
                description: "Returns text if value is text, empty string otherwise".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "TEXT".to_string(),
                syntax: "TEXT(value, format_text)".to_string(),
                description: "Formats a number as text with a specified format".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "REPT".to_string(),
                syntax: "REPT(text, number_times)".to_string(),
                description: "Repeats text a given number of times".to_string(),
                category: "Text".to_string(),
            },
            FunctionInfo {
                name: "TEXTJOIN".to_string(),
                syntax: "TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)".to_string(),
                description: "Combines text from multiple ranges with a specified delimiter".to_string(),
                category: "Text".to_string(),
            },
        ],
        "lookup" | "lookup & reference" => vec![
            FunctionInfo {
                name: "XLOOKUP".to_string(),
                syntax: "XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])".to_string(),
                description: "Searches a range or array and returns the corresponding item".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "XLOOKUPS".to_string(),
                syntax: "XLOOKUPS(lookup_value1, lookup_array1, [lookup_value2, lookup_array2, ...], return_array, [match_mode], [search_mode])".to_string(),
                description: "Multi-criteria lookup: searches multiple arrays simultaneously and returns the corresponding item from the return array".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "INDEX".to_string(),
                syntax: "INDEX(array, row_num, [column_num])".to_string(),
                description: "Returns a value at a given position in a range".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "MATCH".to_string(),
                syntax: "MATCH(lookup_value, lookup_array, [match_type])".to_string(),
                description: "Returns the position of a value in a range".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "CHOOSE".to_string(),
                syntax: "CHOOSE(index_num, value1, [value2], ...)".to_string(),
                description: "Returns a value from a list based on index".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "INDIRECT".to_string(),
                syntax: "INDIRECT(ref_text, [a1])".to_string(),
                description: "Returns the reference specified by a text string".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "OFFSET".to_string(),
                syntax: "OFFSET(reference, rows, cols, [height], [width])".to_string(),
                description: "Returns a reference offset from a given reference".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "ADDRESS".to_string(),
                syntax: "ADDRESS(row_num, column_num, [abs_num], [a1], [sheet_text])".to_string(),
                description: "Creates a cell address as text".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "ROW".to_string(),
                syntax: "ROW([cell_ref])".to_string(),
                description: "Returns the row number of a cell reference".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "COLUMN".to_string(),
                syntax: "COLUMN([cell_ref])".to_string(),
                description: "Returns the column number of a cell reference".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "ROWS".to_string(),
                syntax: "ROWS(array)".to_string(),
                description: "Returns the number of rows in a reference".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "COLUMNS".to_string(),
                syntax: "COLUMNS(array)".to_string(),
                description: "Returns the number of columns in a reference".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "TRANSPOSE".to_string(),
                syntax: "TRANSPOSE(array)".to_string(),
                description: "Returns the transpose of an array".to_string(),
                category: "Lookup & Reference".to_string(),
            },
        ],
        "info" | "information" => vec![
            FunctionInfo {
                name: "ISNUMBER".to_string(),
                syntax: "ISNUMBER(value)".to_string(),
                description: "Checks if value is number".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "ISTEXT".to_string(),
                syntax: "ISTEXT(value)".to_string(),
                description: "Checks if value is text".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "ISBLANK".to_string(),
                syntax: "ISBLANK(value)".to_string(),
                description: "Checks if cell is empty".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "ISERROR".to_string(),
                syntax: "ISERROR(value)".to_string(),
                description: "Checks if value is error".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "ISNA".to_string(),
                syntax: "ISNA(value)".to_string(),
                description: "Checks if value is #N/A".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "ISERR".to_string(),
                syntax: "ISERR(value)".to_string(),
                description: "Checks if value is an error other than #N/A".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "ISLOGICAL".to_string(),
                syntax: "ISLOGICAL(value)".to_string(),
                description: "Checks if value is TRUE or FALSE".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "ISODD".to_string(),
                syntax: "ISODD(number)".to_string(),
                description: "Checks if a number is odd".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "ISEVEN".to_string(),
                syntax: "ISEVEN(number)".to_string(),
                description: "Checks if a number is even".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "ISFORMULA".to_string(),
                syntax: "ISFORMULA(reference)".to_string(),
                description: "Checks if a cell contains a formula".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "TYPE".to_string(),
                syntax: "TYPE(value)".to_string(),
                description: "Returns the type of a value (1=number, 2=text, 4=logical, 16=error)".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "N".to_string(),
                syntax: "N(value)".to_string(),
                description: "Returns a value converted to a number".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "NA".to_string(),
                syntax: "NA()".to_string(),
                description: "Returns the #N/A error value".to_string(),
                category: "Information".to_string(),
            },
            FunctionInfo {
                name: "COUNTA".to_string(),
                syntax: "COUNTA(value1, [value2], ...)".to_string(),
                description: "Counts non-empty cells".to_string(),
                category: "Information".to_string(),
            },
        ],
        "date" | "date & time" => vec![
            FunctionInfo {
                name: "TODAY".to_string(),
                syntax: "TODAY()".to_string(),
                description: "Returns the current date as a serial number".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "NOW".to_string(),
                syntax: "NOW()".to_string(),
                description: "Returns the current date and time as a serial number".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "DATE".to_string(),
                syntax: "DATE(year, month, day)".to_string(),
                description: "Creates a date serial number from year, month, day".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "YEAR".to_string(),
                syntax: "YEAR(serial_number)".to_string(),
                description: "Returns the year from a date".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "MONTH".to_string(),
                syntax: "MONTH(serial_number)".to_string(),
                description: "Returns the month from a date".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "DAY".to_string(),
                syntax: "DAY(serial_number)".to_string(),
                description: "Returns the day from a date".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "HOUR".to_string(),
                syntax: "HOUR(serial_number)".to_string(),
                description: "Returns the hour from a time value".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "MINUTE".to_string(),
                syntax: "MINUTE(serial_number)".to_string(),
                description: "Returns the minute from a time value".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "SECOND".to_string(),
                syntax: "SECOND(serial_number)".to_string(),
                description: "Returns the second from a time value".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "DATEVALUE".to_string(),
                syntax: "DATEVALUE(date_text)".to_string(),
                description: "Converts a date string to a serial number".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "TIMEVALUE".to_string(),
                syntax: "TIMEVALUE(time_text)".to_string(),
                description: "Converts a time string to a decimal number".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "EDATE".to_string(),
                syntax: "EDATE(start_date, months)".to_string(),
                description: "Returns the date that is the indicated number of months before or after a date".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "EOMONTH".to_string(),
                syntax: "EOMONTH(start_date, months)".to_string(),
                description: "Returns the last day of the month a given number of months before or after a date".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "NETWORKDAYS".to_string(),
                syntax: "NETWORKDAYS(start_date, end_date, [holidays])".to_string(),
                description: "Returns the number of working days between two dates".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "WORKDAY".to_string(),
                syntax: "WORKDAY(start_date, days, [holidays])".to_string(),
                description: "Returns the date a given number of working days from a date".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "DATEDIF".to_string(),
                syntax: "DATEDIF(start_date, end_date, unit)".to_string(),
                description: "Calculates the difference between two dates".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "WEEKDAY".to_string(),
                syntax: "WEEKDAY(serial_number, [return_type])".to_string(),
                description: "Returns the day of the week".to_string(),
                category: "Date & Time".to_string(),
            },
            FunctionInfo {
                name: "WEEKNUM".to_string(),
                syntax: "WEEKNUM(serial_number, [return_type])".to_string(),
                description: "Returns the week number of a date".to_string(),
                category: "Date & Time".to_string(),
            },
        ],
        "statistical" => vec![
            FunctionInfo {
                name: "MEDIAN".to_string(),
                syntax: "MEDIAN(number1, [number2], ...)".to_string(),
                description: "Returns the median of the given numbers".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "STDEV".to_string(),
                syntax: "STDEV(number1, [number2], ...)".to_string(),
                description: "Estimates standard deviation based on a sample".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "STDEVP".to_string(),
                syntax: "STDEVP(number1, [number2], ...)".to_string(),
                description: "Calculates standard deviation based on the entire population".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "VAR".to_string(),
                syntax: "VAR(number1, [number2], ...)".to_string(),
                description: "Estimates variance based on a sample".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "VARP".to_string(),
                syntax: "VARP(number1, [number2], ...)".to_string(),
                description: "Calculates variance based on the entire population".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "LARGE".to_string(),
                syntax: "LARGE(array, k)".to_string(),
                description: "Returns the k-th largest value in a data set".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "SMALL".to_string(),
                syntax: "SMALL(array, k)".to_string(),
                description: "Returns the k-th smallest value in a data set".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "RANK".to_string(),
                syntax: "RANK(number, ref, [order])".to_string(),
                description: "Returns the rank of a number in a list of numbers".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "PERCENTILE".to_string(),
                syntax: "PERCENTILE(array, k)".to_string(),
                description: "Returns the k-th percentile of values in a range".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "QUARTILE".to_string(),
                syntax: "QUARTILE(array, quart)".to_string(),
                description: "Returns the quartile of a data set".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "MODE".to_string(),
                syntax: "MODE(number1, [number2], ...)".to_string(),
                description: "Returns the most frequently occurring value".to_string(),
                category: "Statistical".to_string(),
            },
            FunctionInfo {
                name: "FREQUENCY".to_string(),
                syntax: "FREQUENCY(data_array, bins_array)".to_string(),
                description: "Returns a frequency distribution as a vertical array".to_string(),
                category: "Statistical".to_string(),
            },
        ],
        "financial" => vec![
            FunctionInfo {
                name: "PMT".to_string(),
                syntax: "PMT(rate, nper, pv, [fv], [type])".to_string(),
                description: "Calculates the payment for a loan based on constant payments and interest rate".to_string(),
                category: "Financial".to_string(),
            },
            FunctionInfo {
                name: "PV".to_string(),
                syntax: "PV(rate, nper, pmt, [fv], [type])".to_string(),
                description: "Returns the present value of an investment".to_string(),
                category: "Financial".to_string(),
            },
            FunctionInfo {
                name: "FV".to_string(),
                syntax: "FV(rate, nper, pmt, [pv], [type])".to_string(),
                description: "Returns the future value of an investment".to_string(),
                category: "Financial".to_string(),
            },
            FunctionInfo {
                name: "NPV".to_string(),
                syntax: "NPV(rate, value1, [value2], ...)".to_string(),
                description: "Returns the net present value of an investment".to_string(),
                category: "Financial".to_string(),
            },
            FunctionInfo {
                name: "IRR".to_string(),
                syntax: "IRR(values, [guess])".to_string(),
                description: "Returns the internal rate of return for a series of cash flows".to_string(),
                category: "Financial".to_string(),
            },
            FunctionInfo {
                name: "RATE".to_string(),
                syntax: "RATE(nper, pmt, pv, [fv], [type], [guess])".to_string(),
                description: "Returns the interest rate per period of an annuity".to_string(),
                category: "Financial".to_string(),
            },
            FunctionInfo {
                name: "NPER".to_string(),
                syntax: "NPER(rate, pmt, pv, [fv], [type])".to_string(),
                description: "Returns the number of periods for an investment".to_string(),
                category: "Financial".to_string(),
            },
            FunctionInfo {
                name: "SLN".to_string(),
                syntax: "SLN(cost, salvage, life)".to_string(),
                description: "Returns straight-line depreciation for one period".to_string(),
                category: "Financial".to_string(),
            },
            FunctionInfo {
                name: "DB".to_string(),
                syntax: "DB(cost, salvage, life, period, [month])".to_string(),
                description: "Returns fixed-declining balance depreciation".to_string(),
                category: "Financial".to_string(),
            },
            FunctionInfo {
                name: "DDB".to_string(),
                syntax: "DDB(cost, salvage, life, period, [factor])".to_string(),
                description: "Returns double-declining balance depreciation".to_string(),
                category: "Financial".to_string(),
            },
        ],
        "ui" => vec![
            FunctionInfo {
                name: "GET.ROW.HEIGHT".to_string(),
                syntax: "GET.ROW.HEIGHT(row)".to_string(),
                description: "Returns the height in pixels of the specified row (1-indexed). Returns the default height (24) if not customized.".to_string(),
                category: "UI".to_string(),
            },
            FunctionInfo {
                name: "GET.COLUMN.WIDTH".to_string(),
                syntax: "GET.COLUMN.WIDTH(col)".to_string(),
                description: "Returns the width in pixels of the specified column (1-indexed). Returns the default width (100) if not customized.".to_string(),
                category: "UI".to_string(),
            },
            FunctionInfo {
                name: "GET.CELL.FILLCOLOR".to_string(),
                syntax: "GET.CELL.FILLCOLOR(cell_ref)".to_string(),
                description: "Returns the background fill color of a cell as a CSS color string (hex or rgba).".to_string(),
                category: "UI".to_string(),
            },
        ],
        "dynamic" | "dynamic array" => vec![
            FunctionInfo {
                name: "FILTER".to_string(),
                syntax: "FILTER(array, include, [if_empty])".to_string(),
                description: "Filters an array based on a Boolean array, returning only matching rows or columns".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "SORT".to_string(),
                syntax: "SORT(array, [sort_index], [sort_order], [by_col])".to_string(),
                description: "Sorts the contents of a range or array by one or more columns".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "UNIQUE".to_string(),
                syntax: "UNIQUE(array, [by_col], [exactly_once])".to_string(),
                description: "Returns unique values from a range or array, removing duplicates".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "SEQUENCE".to_string(),
                syntax: "SEQUENCE(rows, [columns], [start], [step])".to_string(),
                description: "Generates a sequence of numbers in an array".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "SORTBY".to_string(),
                syntax: "SORTBY(array, by_array1, [sort_order1], [by_array2], [sort_order2], ...)".to_string(),
                description: "Sorts a range or array based on the values in one or more corresponding ranges or arrays".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "RANDARRAY".to_string(),
                syntax: "RANDARRAY([rows], [columns], [min], [max], [whole_number])".to_string(),
                description: "Returns an array of random numbers between min and max".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "GROUPBY".to_string(),
                syntax: "GROUPBY(row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array])".to_string(),
                description: "Groups data by row fields and aggregates values using a specified function".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "PIVOTBY".to_string(),
                syntax: "PIVOTBY(row_fields, col_fields, values, function, [field_headers], [row_total_depth], [row_sort_order], [col_total_depth], [col_sort_order], [filter_array])".to_string(),
                description: "Creates a pivot table by grouping data by row and column fields, aggregating values".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "COLLECT".to_string(),
                syntax: "COLLECT(value)".to_string(),
                description: "Wraps an array result into a contained List cell instead of spilling. Creates a 3D cell.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "DICT".to_string(),
                syntax: "DICT(key1, value1, [key2, value2], ...)".to_string(),
                description: "Creates a Dict cell from alternating key-value pairs. Keys can be text, numbers, or booleans.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "KEYS".to_string(),
                syntax: "KEYS(collection)".to_string(),
                description: "Returns an array of keys from a Dict, or indices (0-based) from a List.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "VALUES".to_string(),
                syntax: "VALUES(collection)".to_string(),
                description: "Returns an array of values from a Dict or List.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "CONTAINS".to_string(),
                syntax: "CONTAINS(collection, value)".to_string(),
                description: "Returns TRUE if value exists in a List, or if key exists in a Dict.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "ISLIST".to_string(),
                syntax: "ISLIST(value)".to_string(),
                description: "Returns TRUE if the value is a List cell.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "ISDICT".to_string(),
                syntax: "ISDICT(value)".to_string(),
                description: "Returns TRUE if the value is a Dict cell.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "FLATTEN".to_string(),
                syntax: "FLATTEN(list)".to_string(),
                description: "Recursively flattens nested lists into a single-level list.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "TAKE".to_string(),
                syntax: "TAKE(list, n)".to_string(),
                description: "Returns the first n elements of a list as a new list.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "DROP".to_string(),
                syntax: "DROP(list, n)".to_string(),
                description: "Removes the first n elements from a list and returns the rest.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "APPEND".to_string(),
                syntax: "APPEND(list, value)".to_string(),
                description: "Returns a new list with value appended to the end.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "MERGE".to_string(),
                syntax: "MERGE(dict1, dict2)".to_string(),
                description: "Merges two dicts. Second dict wins on key conflicts.".to_string(),
                category: "Dynamic Array".to_string(),
            },
            FunctionInfo {
                name: "HSTACK".to_string(),
                syntax: "HSTACK(list1, list2)".to_string(),
                description: "Concatenates two lists into one.".to_string(),
                category: "Dynamic Array".to_string(),
            },
        ],
        "file" => vec![
            FunctionInfo {
                name: "FILEREAD".to_string(),
                syntax: "FILEREAD(path)".to_string(),
                description: "Returns the text content of a virtual file".to_string(),
                category: "File".to_string(),
            },
            FunctionInfo {
                name: "FILELINES".to_string(),
                syntax: "FILELINES(path)".to_string(),
                description: "Returns the number of lines in a virtual file".to_string(),
                category: "File".to_string(),
            },
            FunctionInfo {
                name: "FILEEXISTS".to_string(),
                syntax: "FILEEXISTS(path)".to_string(),
                description: "Returns TRUE if a virtual file exists".to_string(),
                category: "File".to_string(),
            },
        ],
        _ => vec![],
    };

    log_exit!("CMD", "get_functions_by_category", "count={}", functions.len());
    FunctionListResult { functions }
}

/// Get all available functions.
#[tauri::command]
pub fn get_all_functions() -> FunctionListResult {
    log_enter!("CMD", "get_all_functions");

    let mut all_functions = Vec::new();

    // Collect from all categories
    for category in &["math", "logical", "text", "lookup", "info", "date", "statistical", "financial", "dynamic", "ui", "file"] {
        let result = get_functions_by_category(category.to_string());
        all_functions.extend(result.functions);
    }
    
    log_exit!("CMD", "get_all_functions", "count={}", all_functions.len());
    FunctionListResult { functions: all_functions }
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

        // Lookup & Reference functions
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