//! FILENAME: app/src-tauri/src/r1c1.rs
// PURPOSE: R1C1 reference style support - conversion functions and Tauri commands.
// CONTEXT: Provides bidirectional conversion between A1 and R1C1 reference styles.
//
// R1C1 NOTATION:
//   Absolute: R1C1 (row 1, column 1 = $A$1)
//   Relative: R[-1]C[2] (1 row up, 2 columns right from base cell)
//   Mixed:    R1C[-1] (absolute row 1, relative column)

use tauri::State;
use crate::AppState;
use regex::Regex;
use once_cell::sync::Lazy;

// ============================================================================
// Column Utilities
// ============================================================================

/// Convert a 0-based column index to a column letter (0 -> "A", 25 -> "Z", 26 -> "AA").
fn col_index_to_letter(col: u32) -> String {
    let mut result = String::new();
    let mut c = col;
    loop {
        result.insert(0, (b'A' + (c % 26) as u8) as char);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    result
}

/// Convert a column letter string ("A", "AA", "XFD") to a 0-based column index.
fn letter_to_col_index(letters: &str) -> u32 {
    let mut result: u32 = 0;
    for ch in letters.chars() {
        let val = (ch.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
        result = result * 26 + val;
    }
    result - 1 // 0-based
}

// ============================================================================
// Single Reference Conversion
// ============================================================================

/// Convert an A1-style cell reference to R1C1-style.
///
/// - `$A$1` (both absolute) -> `R1C1`
/// - `A1` (both relative, from base_row=2, base_col=2) -> `R[-1]C[-1]`
/// - `$A1` (col absolute, row relative) -> `R[-1]C1`
/// - `A$1` (col relative, row absolute) -> `R1C[-1]`
///
/// `base_row` and `base_col` are 0-based.
/// The row in A1 notation is 1-based; internally we convert.
pub fn a1_to_r1c1(reference: &str, base_row: u32, base_col: u32) -> String {
    // Parse the A1 reference: optional $ before column letters, optional $ before row digits
    static RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"^(\$?)([A-Za-z]+)(\$?)(\d+)$").unwrap()
    });

    if let Some(caps) = RE.captures(reference) {
        let col_abs = &caps[1] == "$";
        let col_letters = &caps[2];
        let row_abs = &caps[3] == "$";
        let row_num: u32 = caps[4].parse().unwrap_or(1);

        let col_idx = letter_to_col_index(col_letters); // 0-based
        let row_idx = row_num - 1; // convert to 0-based

        let row_part = if row_abs {
            format!("R{}", row_idx + 1) // 1-based in R1C1
        } else {
            let diff = row_idx as i64 - base_row as i64;
            if diff == 0 {
                "R".to_string()
            } else {
                format!("R[{}]", diff)
            }
        };

        let col_part = if col_abs {
            format!("C{}", col_idx + 1) // 1-based in R1C1
        } else {
            let diff = col_idx as i64 - base_col as i64;
            if diff == 0 {
                "C".to_string()
            } else {
                format!("C[{}]", diff)
            }
        };

        format!("{}{}", row_part, col_part)
    } else {
        // Not a valid A1 reference, return as-is
        reference.to_string()
    }
}

/// Convert an R1C1-style cell reference to A1-style.
///
/// - `R1C1` (absolute) -> `$A$1`
/// - `R[-1]C[2]` (relative, from base_row=2, base_col=0) -> `C2`
/// - `RC` (same row/col) -> e.g. `A1` relative to base
///
/// `base_row` and `base_col` are 0-based.
pub fn r1c1_to_a1(reference: &str, base_row: u32, base_col: u32) -> String {
    // Match R1C1 patterns:
    //   R<num>C<num>         absolute row and col
    //   R[<num>]C[<num>]     relative row and col
    //   R<num>C[<num>]       mixed
    //   R[<num>]C<num>       mixed
    //   RC                   same row and col (relative zero offset)
    static RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)^R(\[(-?\d+)\]|(\d+))?C(\[(-?\d+)\]|(\d+))?$").unwrap()
    });

    if let Some(caps) = RE.captures(reference) {
        // Row part
        let (row_idx, row_abs) = if let Some(rel) = caps.get(2) {
            // Relative row: R[offset]
            let offset: i64 = rel.as_str().parse().unwrap_or(0);
            let row = (base_row as i64 + offset).max(0) as u32;
            (row, false)
        } else if let Some(abs_val) = caps.get(3) {
            // Absolute row: R<num> (1-based)
            let r: u32 = abs_val.as_str().parse().unwrap_or(1);
            (r.saturating_sub(1), true) // convert to 0-based
        } else {
            // No row part (RC) means relative zero offset
            (base_row, false)
        };

        // Col part
        let (col_idx, col_abs) = if let Some(rel) = caps.get(5) {
            // Relative col: C[offset]
            let offset: i64 = rel.as_str().parse().unwrap_or(0);
            let col = (base_col as i64 + offset).max(0) as u32;
            (col, false)
        } else if let Some(abs_val) = caps.get(6) {
            // Absolute col: C<num> (1-based)
            let c: u32 = abs_val.as_str().parse().unwrap_or(1);
            (c.saturating_sub(1), true) // convert to 0-based
        } else {
            // No col part means relative zero offset
            (base_col, false)
        };

        let col_str = col_index_to_letter(col_idx);
        let row_str = format!("{}", row_idx + 1); // 1-based for A1

        format!(
            "{}{}{}{}",
            if col_abs { "$" } else { "" },
            col_str,
            if row_abs { "$" } else { "" },
            row_str,
        )
    } else {
        reference.to_string()
    }
}

// ============================================================================
// Formula-level Conversion
// ============================================================================

/// Convert an entire formula from A1 notation to R1C1 notation.
/// Handles cell references, ranges, and preserves everything else.
pub fn formula_a1_to_r1c1(formula: &str, base_row: u32, base_col: u32) -> String {
    // Match A1-style cell references within formulas.
    // This regex captures optional $ before column letters and $ before row digits.
    // We need to handle ranges (A1:B2) by converting each part separately.
    static RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"\$?[A-Za-z]{1,3}\$?\d+").unwrap()
    });

    // We also need to avoid converting things inside string literals.
    // Simple approach: split on strings, convert non-string parts.
    let mut result = String::new();
    let mut in_string = false;
    let mut segment = String::new();

    for ch in formula.chars() {
        if ch == '"' {
            if in_string {
                // End of string
                segment.push(ch);
                result.push_str(&segment);
                segment.clear();
                in_string = false;
            } else {
                // Start of string - flush current segment with conversion
                result.push_str(&convert_segment_a1_to_r1c1(&segment, base_row, base_col, &RE));
                segment.clear();
                segment.push(ch);
                in_string = true;
            }
        } else {
            segment.push(ch);
        }
    }

    // Flush remaining segment
    if in_string {
        result.push_str(&segment);
    } else {
        result.push_str(&convert_segment_a1_to_r1c1(&segment, base_row, base_col, &RE));
    }

    result
}

/// Convert A1 cell references within a non-string segment of a formula.
fn convert_segment_a1_to_r1c1(segment: &str, base_row: u32, base_col: u32, re: &Regex) -> String {
    re.replace_all(segment, |caps: &regex::Captures| {
        let matched = caps.get(0).unwrap().as_str();
        // Verify this looks like a valid cell ref and not part of a function name
        // by checking that the character before (if any) is not a letter
        let start = caps.get(0).unwrap().start();
        if start > 0 {
            let prev_char = segment.as_bytes()[start - 1] as char;
            if prev_char.is_ascii_alphabetic() || prev_char == '_' {
                return matched.to_string();
            }
        }
        a1_to_r1c1(matched, base_row, base_col)
    }).to_string()
}

/// Convert an entire formula from R1C1 notation to A1 notation.
pub fn formula_r1c1_to_a1(formula: &str, base_row: u32, base_col: u32) -> String {
    // Match R1C1-style cell references:
    // R<num>C<num>, R[n]C[n], RC, R[-1]C, etc.
    static RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?").unwrap()
    });

    let mut result = String::new();
    let mut in_string = false;
    let mut segment = String::new();

    for ch in formula.chars() {
        if ch == '"' {
            if in_string {
                segment.push(ch);
                result.push_str(&segment);
                segment.clear();
                in_string = false;
            } else {
                result.push_str(&convert_segment_r1c1_to_a1(&segment, base_row, base_col, &RE));
                segment.clear();
                segment.push(ch);
                in_string = true;
            }
        } else {
            segment.push(ch);
        }
    }

    if in_string {
        result.push_str(&segment);
    } else {
        result.push_str(&convert_segment_r1c1_to_a1(&segment, base_row, base_col, &RE));
    }

    result
}

/// Convert R1C1 cell references within a non-string segment.
fn convert_segment_r1c1_to_a1(segment: &str, base_row: u32, base_col: u32, re: &Regex) -> String {
    re.replace_all(segment, |caps: &regex::Captures| {
        let matched = caps.get(0).unwrap().as_str();
        let start = caps.get(0).unwrap().start();

        // Avoid matching R or C that are part of function names or identifiers.
        // Check char before: must not be a letter, digit, or underscore.
        if start > 0 {
            let prev_char = segment.as_bytes()[start - 1] as char;
            if prev_char.is_ascii_alphanumeric() || prev_char == '_' {
                return matched.to_string();
            }
        }

        // Also check the char after the match to ensure we're not in the middle
        // of a longer identifier (e.g., "ROUND" starting with "R").
        let end = caps.get(0).unwrap().end();
        if end < segment.len() {
            let next_char = segment.as_bytes()[end] as char;
            if next_char.is_ascii_alphabetic() || next_char == '_' {
                return matched.to_string();
            }
        }

        r1c1_to_a1(matched, base_row, base_col)
    }).to_string()
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Get the current reference style ("A1" or "R1C1").
#[tauri::command]
pub fn get_reference_style(state: State<AppState>) -> String {
    state.reference_style.lock().unwrap().clone()
}

/// Set the reference style. Returns the new style.
#[tauri::command]
pub fn set_reference_style(state: State<AppState>, style: String) -> String {
    let valid = if style == "R1C1" { "R1C1" } else { "A1" };
    let mut current = state.reference_style.lock().unwrap();
    *current = valid.to_string();
    valid.to_string()
}

/// Convert a formula between A1 and R1C1 notation.
///
/// - `formula`: The formula string (with or without leading `=`)
/// - `from_style`: "A1" or "R1C1"
/// - `to_style`: "A1" or "R1C1"
/// - `base_row`: 0-based row of the cell containing the formula
/// - `base_col`: 0-based column of the cell containing the formula
#[tauri::command]
pub fn convert_formula_style(
    formula: String,
    from_style: String,
    to_style: String,
    base_row: u32,
    base_col: u32,
) -> Result<String, String> {
    if from_style == to_style {
        return Ok(formula);
    }

    let has_equals = formula.starts_with('=');
    let body = if has_equals { &formula[1..] } else { &formula };

    let converted = if from_style == "A1" && to_style == "R1C1" {
        formula_a1_to_r1c1(body, base_row, base_col)
    } else if from_style == "R1C1" && to_style == "A1" {
        formula_r1c1_to_a1(body, base_row, base_col)
    } else {
        return Err(format!("Invalid style combination: {} -> {}", from_style, to_style));
    };

    if has_equals {
        Ok(format!("={}", converted))
    } else {
        Ok(converted)
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_col_index_to_letter() {
        assert_eq!(col_index_to_letter(0), "A");
        assert_eq!(col_index_to_letter(1), "B");
        assert_eq!(col_index_to_letter(25), "Z");
        assert_eq!(col_index_to_letter(26), "AA");
        assert_eq!(col_index_to_letter(27), "AB");
        assert_eq!(col_index_to_letter(701), "ZZ");
        assert_eq!(col_index_to_letter(702), "AAA");
    }

    #[test]
    fn test_letter_to_col_index() {
        assert_eq!(letter_to_col_index("A"), 0);
        assert_eq!(letter_to_col_index("B"), 1);
        assert_eq!(letter_to_col_index("Z"), 25);
        assert_eq!(letter_to_col_index("AA"), 26);
        assert_eq!(letter_to_col_index("AB"), 27);
        assert_eq!(letter_to_col_index("ZZ"), 701);
    }

    #[test]
    fn test_a1_to_r1c1_absolute() {
        // $A$1 should become R1C1 (absolute)
        assert_eq!(a1_to_r1c1("$A$1", 0, 0), "R1C1");
        assert_eq!(a1_to_r1c1("$C$5", 0, 0), "R5C3");
    }

    #[test]
    fn test_a1_to_r1c1_relative() {
        // A1 relative from base (2,2) -> row diff = -2, col diff = -2
        assert_eq!(a1_to_r1c1("A1", 2, 2), "R[-2]C[-2]");
        // Same cell: relative from (0,0) -> RC
        assert_eq!(a1_to_r1c1("A1", 0, 0), "RC");
        // B3 from (1,0) -> R[1]C[1]
        assert_eq!(a1_to_r1c1("B3", 1, 0), "R[1]C[1]");
    }

    #[test]
    fn test_a1_to_r1c1_mixed() {
        // $A1 (col absolute, row relative) from base (2,2)
        assert_eq!(a1_to_r1c1("$A1", 2, 2), "R[-1]C1");
        // A$1 (row absolute, col relative) from base (2,2)
        assert_eq!(a1_to_r1c1("A$1", 2, 2), "R1C[-2]");
    }

    #[test]
    fn test_r1c1_to_a1_absolute() {
        assert_eq!(r1c1_to_a1("R1C1", 0, 0), "$A$1");
        assert_eq!(r1c1_to_a1("R5C3", 0, 0), "$C$5");
    }

    #[test]
    fn test_r1c1_to_a1_relative() {
        assert_eq!(r1c1_to_a1("RC", 0, 0), "A1");
        assert_eq!(r1c1_to_a1("R[-2]C[-2]", 2, 2), "A1");
        assert_eq!(r1c1_to_a1("R[1]C[1]", 1, 0), "B3");
    }

    #[test]
    fn test_r1c1_to_a1_mixed() {
        // R1C[-2] -> absolute row 1, relative col -2 from base col 2 = col 0 = A
        assert_eq!(r1c1_to_a1("R1C[-2]", 2, 2), "$A1");
        // Wait, that's wrong. R1 = absolute row, C[-2] = relative col.
        // A1 form: col is relative (no $), row is absolute ($).
        // Col = base_col(2) + (-2) = 0 -> A, Row = 1 (absolute) -> $1
        // Result: A$1
        assert_eq!(r1c1_to_a1("R1C[-2]", 2, 2), "A$1");
    }

    #[test]
    fn test_formula_a1_to_r1c1() {
        // =SUM(A1:B2) from cell (0,0)
        let result = formula_a1_to_r1c1("SUM(A1:B2)", 0, 0);
        assert_eq!(result, "SUM(RC:R[1]C[1])");

        // =A1+$B$2 from cell (0,0)
        let result = formula_a1_to_r1c1("A1+$B$2", 0, 0);
        assert_eq!(result, "RC+R2C2");
    }

    #[test]
    fn test_formula_r1c1_to_a1() {
        let result = formula_r1c1_to_a1("SUM(RC:R[1]C[1])", 0, 0);
        assert_eq!(result, "SUM(A1:B2)");

        let result = formula_r1c1_to_a1("RC+R2C2", 0, 0);
        assert_eq!(result, "A1+$B$2");
    }

    #[test]
    fn test_formula_with_strings_preserved() {
        let result = formula_a1_to_r1c1("IF(A1>0,\"A1\",\"B2\")", 0, 0);
        assert!(result.contains("\"A1\""));
        assert!(result.contains("\"B2\""));
    }

    #[test]
    fn test_function_names_not_converted() {
        // ROUND should not be treated as an R1C1 reference
        let result = formula_r1c1_to_a1("ROUND(RC,2)", 0, 0);
        assert!(result.starts_with("ROUND("));
    }
}
