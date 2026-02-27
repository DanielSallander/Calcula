//! FILENAME: app/src-tauri/src/formula.rs
// PURPOSE: Formula library commands - function catalog and templates
// FORMAT: seq|level|category|message

use tauri::State;
use crate::api_types::{FunctionInfo, FunctionListResult};
use crate::logging::{log_enter, log_exit};
use crate::AppState;

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
                name: "AVERAGE".to_string(),
                syntax: "AVERAGE(number1, [number2], ...)".to_string(),
                description: "Returns the average of numbers".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "COUNT".to_string(),
                syntax: "COUNT(value1, [value2], ...)".to_string(),
                description: "Counts cells containing numbers".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "MAX".to_string(),
                syntax: "MAX(number1, [number2], ...)".to_string(),
                description: "Returns the largest value".to_string(),
                category: "Math".to_string(),
            },
            FunctionInfo {
                name: "MIN".to_string(),
                syntax: "MIN(number1, [number2], ...)".to_string(),
                description: "Returns the smallest value".to_string(),
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
        ],
        "logical" => vec![
            FunctionInfo {
                name: "IF".to_string(),
                syntax: "IF(condition, value_if_true, [value_if_false])".to_string(),
                description: "Conditional logic".to_string(),
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
                name: "ROW".to_string(),
                syntax: "ROW([cell_ref])".to_string(),
                description: "Returns the row number of a cell reference, or the current row if no argument is given.".to_string(),
                category: "Lookup & Reference".to_string(),
            },
            FunctionInfo {
                name: "COLUMN".to_string(),
                syntax: "COLUMN([cell_ref])".to_string(),
                description: "Returns the column number of a cell reference, or the current column if no argument is given.".to_string(),
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
                name: "COUNTA".to_string(),
                syntax: "COUNTA(value1, [value2], ...)".to_string(),
                description: "Counts non-empty cells".to_string(),
                category: "Information".to_string(),
            },
        ],
        "ui" => vec![
            FunctionInfo {
                name: "SET.ROW.HEIGHT".to_string(),
                syntax: "SET.ROW.HEIGHT(rows, height)".to_string(),
                description: "Sets the height of specified rows. Rows can be a single number or an array. Returns the height value.".to_string(),
                category: "UI".to_string(),
            },
            FunctionInfo {
                name: "SET.COLUMN.WIDTH".to_string(),
                syntax: "SET.COLUMN.WIDTH(cols, width)".to_string(),
                description: "Sets the width of specified columns. Cols can be a single number or an array. Returns the width value.".to_string(),
                category: "UI".to_string(),
            },
            FunctionInfo {
                name: "SET.CELL.FILLCOLOR".to_string(),
                syntax: "SET.CELL.FILLCOLOR(cell_ref, color)".to_string(),
                description: "Sets the background fill color of a cell. Color can be a hex string (#FF0000) or individual R,G,B[,A] values. Returns the color string.".to_string(),
                category: "UI".to_string(),
            },
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
    for category in &["math", "logical", "text", "lookup", "info", "ui"] {
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
        "AVERAGE" => "=AVERAGE()".to_string(),
        "COUNT" => "=COUNT()".to_string(),
        "COUNTA" => "=COUNTA()".to_string(),
        "MAX" => "=MAX()".to_string(),
        "MIN" => "=MIN()".to_string(),
        
        // Logical functions
        "IF" => "=IF(, , )".to_string(),
        "AND" => "=AND()".to_string(),
        "OR" => "=OR()".to_string(),
        "NOT" => "=NOT()".to_string(),
        
        // Math functions
        "ABS" => "=ABS()".to_string(),
        "ROUND" => "=ROUND(, )".to_string(),
        "FLOOR" => "=FLOOR(, )".to_string(),
        "CEILING" => "=CEILING(, )".to_string(),
        "SQRT" => "=SQRT()".to_string(),
        "POWER" => "=POWER(, )".to_string(),
        "MOD" => "=MOD(, )".to_string(),
        "INT" => "=INT()".to_string(),
        "SIGN" => "=SIGN()".to_string(),
        
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
        
        // Lookup & Reference functions
        "XLOOKUP" => "=XLOOKUP(, , )".to_string(),

        // Information functions
        "ISNUMBER" => "=ISNUMBER()".to_string(),
        "ISTEXT" => "=ISTEXT()".to_string(),
        "ISBLANK" => "=ISBLANK()".to_string(),
        "ISERROR" => "=ISERROR()".to_string(),
        
        // UI functions
        "SET.ROW.HEIGHT" | "SETROWHEIGHT" => "=SET.ROW.HEIGHT(, )".to_string(),
        "SET.COLUMN.WIDTH" | "SETCOLUMNWIDTH" => "=SET.COLUMN.WIDTH(, )".to_string(),
        "SET.CELL.FILLCOLOR" | "SETCELLFILLCOLOR" => "=SET.CELL.FILLCOLOR(, )".to_string(),
        "GET.ROW.HEIGHT" | "GETROWHEIGHT" => "=GET.ROW.HEIGHT()".to_string(),
        "GET.COLUMN.WIDTH" | "GETCOLUMNWIDTH" => "=GET.COLUMN.WIDTH()".to_string(),
        "GET.CELL.FILLCOLOR" | "GETCELLFILLCOLOR" => "=GET.CELL.FILLCOLOR()".to_string(),

        // Reference functions
        "ROW" => "=ROW()".to_string(),
        "COLUMN" => "=COLUMN()".to_string(),

        // Default: generic function call
        _ => format!("={}()", function_name.to_uppercase()),
    };
    
    log_exit!("CMD", "get_function_template", "template={}", template);
    template
}