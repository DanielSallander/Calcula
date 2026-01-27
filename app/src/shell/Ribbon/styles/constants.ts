//! FILENAME: app/src/shell/Ribbon/styles/constants.ts
// PURPOSE: Constant values used throughout the Ribbon component module.
// CONTEXT: Contains predefined color palettes, function definitions, and other static
// configuration values that are shared across multiple sub-components within the Ribbon.

/**
 * Predefined colors for the color picker.
 * Organized in rows: basic colors, theme colors, light theme colors, darker theme colors.
 */
export const COLOR_PALETTE: string[] = [
  // Row 1: Basic colors
  "#000000", "#434343", "#666666", "#999999", "#b7b7b7",
  "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff",
  // Row 2: Theme colors
  "#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00",
  "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff",
  // Row 3: Light theme colors
  "#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3",
  "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc",
  // Row 4: Darker theme colors
  "#dd7e6b", "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8",
  "#a2c4c9", "#a4c2f4", "#9fc5e8", "#b4a7d6", "#d5a6bd",
];

/**
 * Function category definition.
 */
export interface FunctionCategory {
  id: string;
  name: string;
  description: string;
  functions: FunctionDefinition[];
}

/**
 * Individual function definition.
 */
export interface FunctionDefinition {
  name: string;
  syntax: string;
  description: string;
  category: string;
}

/**
 * AutoSum functions - quick access to common aggregate functions.
 */
export const AUTOSUM_FUNCTIONS: FunctionDefinition[] = [
  { name: "SUM", syntax: "SUM(number1, [number2], ...)", description: "Adds all numbers in a range", category: "Math" },
  { name: "AVERAGE", syntax: "AVERAGE(number1, [number2], ...)", description: "Returns the average of numbers", category: "Math" },
  { name: "COUNT", syntax: "COUNT(value1, [value2], ...)", description: "Counts cells containing numbers", category: "Math" },
  { name: "MAX", syntax: "MAX(number1, [number2], ...)", description: "Returns the largest value", category: "Math" },
  { name: "MIN", syntax: "MIN(number1, [number2], ...)", description: "Returns the smallest value", category: "Math" },
];

/**
 * Financial functions.
 */
export const FINANCIAL_FUNCTIONS: FunctionDefinition[] = [
  { name: "PMT", syntax: "PMT(rate, nper, pv, [fv], [type])", description: "Calculates loan payment", category: "Financial" },
  { name: "FV", syntax: "FV(rate, nper, pmt, [pv], [type])", description: "Future value of investment", category: "Financial" },
  { name: "PV", syntax: "PV(rate, nper, pmt, [fv], [type])", description: "Present value of investment", category: "Financial" },
  { name: "NPV", syntax: "NPV(rate, value1, [value2], ...)", description: "Net present value", category: "Financial" },
  { name: "IRR", syntax: "IRR(values, [guess])", description: "Internal rate of return", category: "Financial" },
];

/**
 * Logical functions.
 */
export const LOGICAL_FUNCTIONS: FunctionDefinition[] = [
  { name: "IF", syntax: "IF(condition, value_if_true, [value_if_false])", description: "Conditional logic", category: "Logical" },
  { name: "AND", syntax: "AND(logical1, [logical2], ...)", description: "TRUE if all arguments are TRUE", category: "Logical" },
  { name: "OR", syntax: "OR(logical1, [logical2], ...)", description: "TRUE if any argument is TRUE", category: "Logical" },
  { name: "NOT", syntax: "NOT(logical)", description: "Reverses the logic", category: "Logical" },
  { name: "TRUE", syntax: "TRUE()", description: "Returns TRUE", category: "Logical" },
  { name: "FALSE", syntax: "FALSE()", description: "Returns FALSE", category: "Logical" },
];

/**
 * Text functions.
 */
export const TEXT_FUNCTIONS: FunctionDefinition[] = [
  { name: "CONCATENATE", syntax: "CONCATENATE(text1, [text2], ...)", description: "Joins text strings", category: "Text" },
  { name: "LEFT", syntax: "LEFT(text, [num_chars])", description: "Returns leftmost characters", category: "Text" },
  { name: "RIGHT", syntax: "RIGHT(text, [num_chars])", description: "Returns rightmost characters", category: "Text" },
  { name: "MID", syntax: "MID(text, start_num, num_chars)", description: "Returns characters from middle", category: "Text" },
  { name: "LEN", syntax: "LEN(text)", description: "Returns length of text", category: "Text" },
  { name: "UPPER", syntax: "UPPER(text)", description: "Converts to uppercase", category: "Text" },
  { name: "LOWER", syntax: "LOWER(text)", description: "Converts to lowercase", category: "Text" },
  { name: "TRIM", syntax: "TRIM(text)", description: "Removes extra spaces", category: "Text" },
  { name: "TEXT", syntax: "TEXT(value, format_text)", description: "Formats number as text", category: "Text" },
  { name: "REPT", syntax: "REPT(text, number_times)", description: "Repeats text", category: "Text" },
];

/**
 * Date & Time functions.
 */
export const DATETIME_FUNCTIONS: FunctionDefinition[] = [
  { name: "TODAY", syntax: "TODAY()", description: "Returns current date", category: "Date & Time" },
  { name: "NOW", syntax: "NOW()", description: "Returns current date and time", category: "Date & Time" },
  { name: "DATE", syntax: "DATE(year, month, day)", description: "Creates a date value", category: "Date & Time" },
  { name: "YEAR", syntax: "YEAR(date)", description: "Returns the year", category: "Date & Time" },
  { name: "MONTH", syntax: "MONTH(date)", description: "Returns the month", category: "Date & Time" },
  { name: "DAY", syntax: "DAY(date)", description: "Returns the day", category: "Date & Time" },
];

/**
 * Lookup & Reference functions.
 */
export const LOOKUP_FUNCTIONS: FunctionDefinition[] = [
  { name: "VLOOKUP", syntax: "VLOOKUP(lookup_value, table, col_index, [range_lookup])", description: "Vertical lookup", category: "Lookup" },
  { name: "HLOOKUP", syntax: "HLOOKUP(lookup_value, table, row_index, [range_lookup])", description: "Horizontal lookup", category: "Lookup" },
  { name: "INDEX", syntax: "INDEX(array, row_num, [col_num])", description: "Returns value at position", category: "Lookup" },
  { name: "MATCH", syntax: "MATCH(lookup_value, lookup_array, [match_type])", description: "Returns position of value", category: "Lookup" },
];

/**
 * Math & Trig functions.
 */
export const MATH_FUNCTIONS: FunctionDefinition[] = [
  { name: "SUM", syntax: "SUM(number1, [number2], ...)", description: "Adds all numbers", category: "Math" },
  { name: "AVERAGE", syntax: "AVERAGE(number1, [number2], ...)", description: "Returns the average", category: "Math" },
  { name: "ABS", syntax: "ABS(number)", description: "Returns absolute value", category: "Math" },
  { name: "ROUND", syntax: "ROUND(number, num_digits)", description: "Rounds a number", category: "Math" },
  { name: "FLOOR", syntax: "FLOOR(number, significance)", description: "Rounds down", category: "Math" },
  { name: "CEILING", syntax: "CEILING(number, significance)", description: "Rounds up", category: "Math" },
  { name: "SQRT", syntax: "SQRT(number)", description: "Square root", category: "Math" },
  { name: "POWER", syntax: "POWER(number, power)", description: "Raises to power", category: "Math" },
  { name: "MOD", syntax: "MOD(number, divisor)", description: "Returns remainder", category: "Math" },
  { name: "INT", syntax: "INT(number)", description: "Rounds down to integer", category: "Math" },
  { name: "SIGN", syntax: "SIGN(number)", description: "Returns sign of number", category: "Math" },
];

/**
 * Information functions (under More Functions).
 */
export const INFO_FUNCTIONS: FunctionDefinition[] = [
  { name: "ISNUMBER", syntax: "ISNUMBER(value)", description: "Checks if value is number", category: "Information" },
  { name: "ISTEXT", syntax: "ISTEXT(value)", description: "Checks if value is text", category: "Information" },
  { name: "ISBLANK", syntax: "ISBLANK(value)", description: "Checks if cell is empty", category: "Information" },
  { name: "ISERROR", syntax: "ISERROR(value)", description: "Checks if value is error", category: "Information" },
  { name: "COUNTA", syntax: "COUNTA(value1, [value2], ...)", description: "Counts non-empty cells", category: "Information" },
];

/**
 * All function categories for the Formulas tab.
 */
export const FUNCTION_CATEGORIES: FunctionCategory[] = [
  { id: "autosum", name: "AutoSum", description: "Quick aggregate functions", functions: AUTOSUM_FUNCTIONS },
  { id: "financial", name: "Financial", description: "Financial calculations", functions: FINANCIAL_FUNCTIONS },
  { id: "logical", name: "Logical", description: "Logical operations", functions: LOGICAL_FUNCTIONS },
  { id: "text", name: "Text", description: "Text manipulation", functions: TEXT_FUNCTIONS },
  { id: "datetime", name: "Date & Time", description: "Date and time functions", functions: DATETIME_FUNCTIONS },
  { id: "lookup", name: "Lookup & Reference", description: "Lookup operations", functions: LOOKUP_FUNCTIONS },
  { id: "math", name: "Math & Trig", description: "Mathematical functions", functions: MATH_FUNCTIONS },
  { id: "info", name: "More Functions", description: "Additional functions", functions: INFO_FUNCTIONS },
];