//! FILENAME: core/calcula-format/src/ai/formula_patterns.rs
//! Formula pattern detection and collapsing.
//!
//! Groups identical formula patterns across rows (e.g., "=A{r}*B{r}" applied to B2:B1000)
//! to produce compact descriptions instead of listing every formula.

use engine::grid::Grid;
use crate::cell_ref;
use std::collections::HashMap;

/// A detected formula pattern applied to a range of rows in a column.
pub struct FormulaPattern {
    pub col: u32,
    pub col_letter: String,
    pub pattern: String,
    pub start_row: u32,
    pub end_row: u32,
    pub count: usize,
}

/// Detect formula patterns in a grid.
/// Groups formulas by column and detects row-relative patterns.
pub fn detect_formula_patterns(grid: &Grid) -> Vec<FormulaPattern> {
    // Collect formulas by column
    let mut col_formulas: HashMap<u32, Vec<(u32, String)>> = HashMap::new();

    for (&(row, col), cell) in &grid.cells {
        if let Some(ref formula) = cell.formula {
            col_formulas
                .entry(col)
                .or_default()
                .push((row, formula.clone()));
        }
    }

    let mut patterns = Vec::new();

    for (col, mut formulas) in col_formulas {
        formulas.sort_by_key(|(row, _)| *row);

        if formulas.is_empty() {
            continue;
        }

        // Group consecutive formulas that share the same row-abstracted pattern
        let mut groups: Vec<(String, u32, u32, usize)> = Vec::new(); // (pattern, start_row, end_row, count)

        for (row, formula) in &formulas {
            let abstracted = abstract_row_references(&formula, *row);

            if let Some(last) = groups.last_mut() {
                if last.0 == abstracted && *row == last.2 + 1 {
                    // Extends the current group
                    last.2 = *row;
                    last.3 += 1;
                    continue;
                }
            }
            // Start a new group
            groups.push((abstracted, *row, *row, 1));
        }

        let col_letter = cell_ref::col_to_letters(col);

        for (pattern, start_row, end_row, count) in groups {
            patterns.push(FormulaPattern {
                col,
                col_letter: col_letter.clone(),
                pattern,
                start_row,
                end_row,
                count,
            });
        }
    }

    // Sort by column then start_row
    patterns.sort_by(|a, b| a.col.cmp(&b.col).then(a.start_row.cmp(&b.start_row)));
    patterns
}

/// Abstract row-specific references in a formula to a generic pattern.
/// e.g., "=A5*B5+C5" with row=5 becomes "=A{r}*B{r}+C{r}"
/// e.g., "=SUM(A$1:A5)" with row=5 becomes "=SUM(A$1:A{r})"
fn abstract_row_references(formula: &str, row: u32) -> String {
    let row_str = format!("{}", row + 1); // 1-based row in formula
    let mut result = String::with_capacity(formula.len() + 10);
    let chars: Vec<char> = formula.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        // Check if we're at a cell reference: letter(s) followed by our row number
        if chars[i].is_ascii_alphabetic() && chars[i] != 'r' {
            // Scan for column letters
            let start = i;
            while i < chars.len() && chars[i].is_ascii_alphabetic() {
                i += 1;
            }
            // Skip optional $ before row number
            let dollar_pos = i;
            if i < chars.len() && chars[i] == '$' {
                i += 1;
            }
            // Check if followed by our row number
            let row_start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            let num_str: String = chars[row_start..i].iter().collect();

            if num_str == row_str {
                // This is a reference to our row — abstract it
                let col_part: String = chars[start..dollar_pos].iter().collect();
                result.push_str(&col_part);
                result.push_str("{r}");
            } else {
                // Not our row — keep as-is
                let original: String = chars[start..i].iter().collect();
                result.push_str(&original);
            }
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }

    result
}

/// Format formula patterns as text for AI context.
pub fn format_formula_patterns(patterns: &[FormulaPattern]) -> String {
    if patterns.is_empty() {
        return String::new();
    }

    let mut out = String::from("Formula patterns:\n");

    for p in patterns {
        if p.count == 1 {
            // Single formula — show exact reference
            let cell = format!("{}{}", p.col_letter, p.start_row + 1);
            out.push_str(&format!("  - {} = \"{}\"\n", cell, p.pattern));
        } else {
            // Range pattern
            let range = format!(
                "{}{}:{}{}",
                p.col_letter,
                p.start_row + 1,
                p.col_letter,
                p.end_row + 1
            );
            out.push_str(&format!(
                "  - {} ({} cells) = \"{}\" where {{r}} is the row\n",
                range, p.count, p.pattern
            ));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::cell::{Cell, CellValue};
    use engine::grid::Grid;

    fn make_formula_cell(value: f64, formula: &str) -> Cell {
        Cell {
            value: CellValue::Number(value),
            formula: Some(formula.to_string()),
            style_index: 0,
            rich_text: None,
            cached_ast: None,
        }
    }

    #[test]
    fn test_abstract_row_references() {
        assert_eq!(abstract_row_references("=A5*B5", 4), "=A{r}*B{r}");
        assert_eq!(abstract_row_references("=SUM(A1:A5)", 4), "=SUM(A1:A{r})");
        assert_eq!(abstract_row_references("=A5+10", 4), "=A{r}+10");
        // Different row — no abstraction
        assert_eq!(abstract_row_references("=A3*B3", 4), "=A3*B3");
    }

    #[test]
    fn test_detect_patterns() {
        let mut grid = Grid::new();

        // Column B has a consistent formula pattern: =A{r}*2
        for row in 1..=10 {
            grid.set_cell(
                row,
                1,
                make_formula_cell(0.0, &format!("=A{}*2", row + 1)),
            );
        }

        // Column C has a single formula
        grid.set_cell(1, 2, make_formula_cell(0.0, "=SUM(B2:B11)"));

        let patterns = detect_formula_patterns(&grid);

        // Should find 2 patterns: the range in B and the single in C
        assert_eq!(patterns.len(), 2);

        let b_pattern = patterns.iter().find(|p| p.col == 1).unwrap();
        assert_eq!(b_pattern.count, 10);
        assert_eq!(b_pattern.pattern, "=A{r}*2");
        assert_eq!(b_pattern.start_row, 1);
        assert_eq!(b_pattern.end_row, 10);

        let c_pattern = patterns.iter().find(|p| p.col == 2).unwrap();
        assert_eq!(c_pattern.count, 1);
    }

    #[test]
    fn test_format_patterns() {
        let patterns = vec![
            FormulaPattern {
                col: 1,
                col_letter: "B".to_string(),
                pattern: "=A{r}*2".to_string(),
                start_row: 1,
                end_row: 100,
                count: 100,
            },
            FormulaPattern {
                col: 2,
                col_letter: "C".to_string(),
                pattern: "=SUM(B2:B101)".to_string(),
                start_row: 1,
                end_row: 1,
                count: 1,
            },
        ];

        let text = format_formula_patterns(&patterns);
        assert!(text.contains("B2:B101 (100 cells)"));
        assert!(text.contains("=A{r}*2"));
        assert!(text.contains("C2 = \"=SUM(B2:B101)\""));
    }
}
