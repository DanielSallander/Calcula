//! FILENAME: core/calcula-format/src/ai/sheet_summary.rs
//! Sheet-level summary: dimensions, column type inference, header detection.

use engine::cell::{Cell, CellValue};
use engine::grid::Grid;
use engine::style::StyleRegistry;
use crate::cell_ref;
use std::collections::HashMap;

/// Summary of a single sheet for AI context.
pub struct SheetSummary {
    pub name: String,
    pub row_count: u32,
    pub col_count: u32,
    pub cell_count: usize,
    pub columns: Vec<ColumnInfo>,
    pub has_header_row: bool,
}

/// Information about a single column.
pub struct ColumnInfo {
    pub col_index: u32,
    pub letter: String,
    pub inferred_type: ColumnType,
    pub header_name: Option<String>,
    pub has_formulas: bool,
}

/// Inferred dominant type of a column's data.
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnType {
    Number,
    Text,
    Boolean,
    Formula,
    Date,
    Mixed,
    Empty,
}

impl std::fmt::Display for ColumnType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ColumnType::Number => write!(f, "number"),
            ColumnType::Text => write!(f, "text"),
            ColumnType::Boolean => write!(f, "boolean"),
            ColumnType::Formula => write!(f, "formula"),
            ColumnType::Date => write!(f, "date"),
            ColumnType::Mixed => write!(f, "mixed"),
            ColumnType::Empty => write!(f, "empty"),
        }
    }
}

/// Analyze a grid and produce a sheet summary.
pub fn summarize_sheet(
    name: &str,
    grid: &Grid,
    _styles: &StyleRegistry,
) -> SheetSummary {
    if grid.cells.is_empty() {
        return SheetSummary {
            name: name.to_string(),
            row_count: 0,
            col_count: 0,
            cell_count: 0,
            columns: Vec::new(),
            has_header_row: false,
        };
    }

    let max_row = grid.max_row;
    let max_col = grid.max_col;

    // Collect cells by column for analysis
    let mut cols_data: HashMap<u32, Vec<(u32, &Cell)>> = HashMap::new();
    for (&(row, col), cell) in &grid.cells {
        cols_data.entry(col).or_default().push((row, cell));
    }

    // Detect header row: row 0 is a header if it's all text and row 1+ has different types
    let has_header_row = detect_header_row(grid, max_col);

    // Analyze each column
    let mut columns = Vec::new();
    for col in 0..=max_col {
        let cells = cols_data.get(&col);
        let letter = cell_ref::col_to_letters(col);

        let (inferred_type, has_formulas) = if let Some(cells) = cells {
            infer_column_type(cells, has_header_row)
        } else {
            (ColumnType::Empty, false)
        };

        let header_name = if has_header_row {
            grid.cells.get(&(0, col)).and_then(|c| {
                if let CellValue::Text(s) = &c.value {
                    Some(s.clone())
                } else {
                    None
                }
            })
        } else {
            None
        };

        columns.push(ColumnInfo {
            col_index: col,
            letter,
            inferred_type,
            header_name,
            has_formulas,
        });
    }

    SheetSummary {
        name: name.to_string(),
        row_count: max_row + 1,
        col_count: max_col + 1,
        cell_count: grid.cells.len(),
        columns,
        has_header_row,
    }
}

/// Detect if row 0 is likely a header row.
/// Heuristic: row 0 is all text, and at least some cells in row 1+ are non-text.
fn detect_header_row(grid: &Grid, max_col: u32) -> bool {
    let mut row0_text_count = 0;
    let mut row0_total = 0;
    let mut row1_non_text = 0;

    for col in 0..=max_col {
        if let Some(cell) = grid.cells.get(&(0, col)) {
            row0_total += 1;
            if matches!(&cell.value, CellValue::Text(_)) {
                row0_text_count += 1;
            }
        }
        if let Some(cell) = grid.cells.get(&(1, col)) {
            if !matches!(&cell.value, CellValue::Text(_) | CellValue::Empty) {
                row1_non_text += 1;
            }
        }
    }

    // Row 0 has cells, all are text, and row 1 has at least one non-text value
    row0_total > 0 && row0_text_count == row0_total && row1_non_text > 0
}

/// Infer the dominant type of a column from its data cells.
fn infer_column_type(cells: &[(u32, &Cell)], skip_header: bool) -> (ColumnType, bool) {
    let mut num_count = 0;
    let mut text_count = 0;
    let mut bool_count = 0;
    let mut formula_count = 0;
    let _date_count = 0;
    let mut total = 0;

    for &(row, cell) in cells {
        if skip_header && row == 0 {
            continue;
        }
        if matches!(cell.value, CellValue::Empty) && cell.formula.is_none() {
            continue;
        }
        total += 1;

        if cell.formula.is_some() {
            formula_count += 1;
        }

        match &cell.value {
            CellValue::Number(_) => {
                // Could be a date (check style for date format via style_index)
                num_count += 1;
            }
            CellValue::Text(_) => text_count += 1,
            CellValue::Boolean(_) => bool_count += 1,
            _ => {}
        }
    }

    let has_formulas = formula_count > 0;

    if total == 0 {
        return (ColumnType::Empty, false);
    }

    // If all cells have formulas, it's a formula column
    if formula_count == total {
        return (ColumnType::Formula, true);
    }

    // Find dominant type (>60% threshold)
    let threshold = (total as f64 * 0.6) as usize;
    let col_type = if num_count > threshold {
        ColumnType::Number
    } else if text_count > threshold {
        ColumnType::Text
    } else if bool_count > threshold {
        ColumnType::Boolean
    } else {
        ColumnType::Mixed
    };

    (col_type, has_formulas)
}

/// Format the sheet summary as a markdown section for AI context.
pub fn format_sheet_summary(summary: &SheetSummary) -> String {
    let mut out = String::new();

    out.push_str(&format!(
        "## Sheet \"{}\" ({} rows x {} columns, {} cells)\n",
        summary.name, summary.row_count, summary.col_count, summary.cell_count
    ));

    if summary.columns.is_empty() {
        out.push_str("(empty sheet)\n");
        return out;
    }

    // Column descriptions
    out.push_str("Columns: ");
    let col_descs: Vec<String> = summary
        .columns
        .iter()
        .filter(|c| c.inferred_type != ColumnType::Empty)
        .map(|c| {
            let name = c
                .header_name
                .as_deref()
                .unwrap_or(&c.letter);
            if c.has_formulas {
                format!("{}={}(formula)", c.letter, name)
            } else {
                format!("{}={}({})", c.letter, name, c.inferred_type)
            }
        })
        .collect();
    out.push_str(&col_descs.join(", "));
    out.push('\n');

    if summary.has_header_row {
        out.push_str("Header row: 1\n");
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::grid::Grid;
    use engine::cell::Cell;
    use engine::style::StyleRegistry;

    fn make_cell(value: CellValue, formula: Option<String>) -> Cell {
        Cell {
            value,
            formula,
            style_index: 0,
            cached_ast: None,
        }
    }

    #[test]
    fn test_empty_sheet_summary() {
        let grid = Grid::new();
        let styles = StyleRegistry::new();
        let summary = summarize_sheet("Empty", &grid, &styles);
        assert_eq!(summary.row_count, 0);
        assert_eq!(summary.col_count, 0);
        assert!(summary.columns.is_empty());
    }

    #[test]
    fn test_header_detection() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, make_cell(CellValue::Text("Name".into()), None));
        grid.set_cell(0, 1, make_cell(CellValue::Text("Amount".into()), None));
        grid.set_cell(1, 0, make_cell(CellValue::Text("Alice".into()), None));
        grid.set_cell(1, 1, make_cell(CellValue::Number(100.0), None));
        grid.set_cell(2, 0, make_cell(CellValue::Text("Bob".into()), None));
        grid.set_cell(2, 1, make_cell(CellValue::Number(200.0), None));

        let styles = StyleRegistry::new();
        let summary = summarize_sheet("Data", &grid, &styles);

        assert!(summary.has_header_row);
        assert_eq!(summary.columns[0].header_name, Some("Name".to_string()));
        assert_eq!(summary.columns[1].header_name, Some("Amount".to_string()));
        assert_eq!(summary.columns[0].inferred_type, ColumnType::Text);
        assert_eq!(summary.columns[1].inferred_type, ColumnType::Number);
    }

    #[test]
    fn test_formula_column_detection() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, make_cell(CellValue::Text("Value".into()), None));
        grid.set_cell(0, 1, make_cell(CellValue::Text("Double".into()), None));
        grid.set_cell(1, 0, make_cell(CellValue::Number(10.0), None));
        grid.set_cell(1, 1, make_cell(CellValue::Number(20.0), Some("=A2*2".into())));
        grid.set_cell(2, 0, make_cell(CellValue::Number(20.0), None));
        grid.set_cell(2, 1, make_cell(CellValue::Number(40.0), Some("=A3*2".into())));

        let styles = StyleRegistry::new();
        let summary = summarize_sheet("Calc", &grid, &styles);

        assert!(summary.columns[1].has_formulas);
        assert_eq!(summary.columns[1].inferred_type, ColumnType::Formula);
    }
}
