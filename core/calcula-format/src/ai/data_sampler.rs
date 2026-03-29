//! FILENAME: core/calcula-format/src/ai/data_sampler.rs
//! Data sampling: produces representative rows and statistical summaries.
//! Instead of dumping all data, shows first N rows + stats for large datasets.

use engine::cell::CellValue;
use engine::grid::Grid;
use engine::style::StyleRegistry;
use crate::cell_ref;

/// Configuration for data sampling.
pub struct SampleConfig {
    /// Maximum number of sample rows to include.
    pub max_sample_rows: usize,
    /// Whether to include column statistics.
    pub include_stats: bool,
}

impl Default for SampleConfig {
    fn default() -> Self {
        SampleConfig {
            max_sample_rows: 5,
            include_stats: true,
        }
    }
}

/// Statistical summary for a numeric column.
pub struct ColumnStats {
    pub col: u32,
    pub min: f64,
    pub max: f64,
    pub sum: f64,
    pub count: usize,
    pub distinct_count: usize,
}

impl ColumnStats {
    pub fn avg(&self) -> f64 {
        if self.count > 0 {
            self.sum / self.count as f64
        } else {
            0.0
        }
    }
}

/// Sample data from a grid for AI context.
pub fn sample_data(
    grid: &Grid,
    _styles: &StyleRegistry,
    has_header: bool,
    config: &SampleConfig,
) -> String {
    if grid.cells.is_empty() {
        return String::new();
    }

    let max_row = grid.max_row;
    let max_col = grid.max_col;
    let data_start_row = if has_header { 1 } else { 0 };
    let total_data_rows = if max_row >= data_start_row {
        (max_row - data_start_row + 1) as usize
    } else {
        0
    };

    let mut out = String::new();

    // Determine which rows to sample
    let sample_rows = pick_sample_rows(data_start_row, max_row, config.max_sample_rows);

    if !sample_rows.is_empty() {
        let label = if total_data_rows <= config.max_sample_rows {
            format!("Data ({} rows):", total_data_rows)
        } else {
            format!(
                "Sample data ({} of {} rows):",
                sample_rows.len(),
                total_data_rows
            )
        };
        out.push_str(&label);
        out.push('\n');

        // Build header row for the table
        if has_header {
            let header: Vec<String> = (0..=max_col)
                .map(|col| {
                    grid.cells
                        .get(&(0, col))
                        .map(|c| format_value_for_ai(&c.value))
                        .unwrap_or_default()
                })
                .collect();
            out.push_str(&format!("  | {} |\n", header.join(" | ")));
            out.push_str(&format!(
                "  |{}|\n",
                header.iter().map(|h| {
                    let width = h.len().max(3);
                    format!("{}", "-".repeat(width + 2))
                }).collect::<Vec<_>>().join("|")
            ));
        }

        // Sample rows
        let mut prev_row: Option<u32> = None;
        for &row in &sample_rows {
            // Show ellipsis for gaps
            if let Some(prev) = prev_row {
                if row > prev + 1 {
                    out.push_str("  | ... |\n");
                }
            }

            let values: Vec<String> = (0..=max_col)
                .map(|col| {
                    grid.cells
                        .get(&(row, col))
                        .map(|c| format_value_for_ai(&c.value))
                        .unwrap_or_default()
                })
                .collect();
            out.push_str(&format!("  | {} |\n", values.join(" | ")));
            prev_row = Some(row);
        }
    }

    // Column statistics for numeric columns
    if config.include_stats && total_data_rows > config.max_sample_rows {
        let stats = compute_column_stats(grid, data_start_row, max_row, max_col);
        if !stats.is_empty() {
            out.push_str("Statistics:\n");
            for stat in &stats {
                let col_letter = cell_ref::col_to_letters(stat.col);
                out.push_str(&format!(
                    "  - {}: min={}, max={}, avg={:.2}, count={}\n",
                    col_letter,
                    format_num(stat.min),
                    format_num(stat.max),
                    stat.avg(),
                    stat.count
                ));
            }
        }

        // Distinct value counts for text columns
        let text_stats = compute_text_stats(grid, data_start_row, max_row, max_col);
        for (col, distinct) in &text_stats {
            let col_letter = cell_ref::col_to_letters(*col);
            out.push_str(&format!(
                "  - {}: {} distinct values\n",
                col_letter, distinct
            ));
        }
    }

    out
}

/// Pick which rows to sample: first N, plus last row if dataset is large.
fn pick_sample_rows(start_row: u32, max_row: u32, max_samples: usize) -> Vec<u32> {
    if max_row < start_row {
        return Vec::new();
    }

    let total = (max_row - start_row + 1) as usize;
    if total <= max_samples {
        return (start_row..=max_row).collect();
    }

    let mut rows: Vec<u32> = (start_row..start_row + (max_samples as u32 - 1).min(max_row - start_row))
        .collect();

    // Always include the last row
    if !rows.contains(&max_row) {
        rows.push(max_row);
    }

    rows
}

/// Format a cell value for AI display (compact, no formatting applied).
fn format_value_for_ai(value: &CellValue) -> String {
    match value {
        CellValue::Empty => String::new(),
        CellValue::Number(n) => format_num(*n),
        CellValue::Text(s) => s.clone(),
        CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Error(e) => format!("#{:?}", e).to_uppercase(),
        CellValue::List(items) => format!("[List({})]", items.len()),
        CellValue::Dict(entries) => format!("[Dict({})]", entries.len()),
    }
}

fn format_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{:.0}", n)
    } else {
        let s = format!("{:.6}", n);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Compute statistics for numeric columns.
fn compute_column_stats(grid: &Grid, start_row: u32, max_row: u32, max_col: u32) -> Vec<ColumnStats> {
    let mut stats = Vec::new();

    for col in 0..=max_col {
        let mut min = f64::MAX;
        let mut max_val = f64::MIN;
        let mut sum = 0.0;
        let mut count = 0;
        let mut values = std::collections::HashSet::new();

        for row in start_row..=max_row {
            if let Some(cell) = grid.cells.get(&(row, col)) {
                if let CellValue::Number(n) = &cell.value {
                    if n < &min {
                        min = *n;
                    }
                    if n > &max_val {
                        max_val = *n;
                    }
                    sum += n;
                    count += 1;
                    values.insert(n.to_bits());
                }
            }
        }

        if count > 0 {
            stats.push(ColumnStats {
                col,
                min,
                max: max_val,
                sum,
                count,
                distinct_count: values.len(),
            });
        }
    }

    stats
}

/// Compute distinct value counts for text columns.
fn compute_text_stats(grid: &Grid, start_row: u32, max_row: u32, max_col: u32) -> Vec<(u32, usize)> {
    let mut results = Vec::new();

    for col in 0..=max_col {
        let mut text_values = std::collections::HashSet::new();
        let mut text_count = 0;
        let mut total = 0;

        for row in start_row..=max_row {
            if let Some(cell) = grid.cells.get(&(row, col)) {
                total += 1;
                if let CellValue::Text(s) = &cell.value {
                    text_values.insert(s.clone());
                    text_count += 1;
                }
            }
        }

        // Only report if column is predominantly text and has multiple distinct values
        if text_count > 0 && text_count as f64 / total.max(1) as f64 > 0.6 && text_values.len() > 1 {
            results.push((col, text_values.len()));
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::cell::Cell;

    fn make_cell(value: CellValue) -> Cell {
        Cell {
            value,
            formula: None,
            style_index: 0,
            rich_text: None,
            cached_ast: None,
        }
    }

    #[test]
    fn test_sample_small_dataset() {
        let mut grid = Grid::new();
        let styles = StyleRegistry::new();

        // Header
        grid.set_cell(0, 0, make_cell(CellValue::Text("Name".into())));
        grid.set_cell(0, 1, make_cell(CellValue::Text("Score".into())));
        // Data
        grid.set_cell(1, 0, make_cell(CellValue::Text("Alice".into())));
        grid.set_cell(1, 1, make_cell(CellValue::Number(95.0)));
        grid.set_cell(2, 0, make_cell(CellValue::Text("Bob".into())));
        grid.set_cell(2, 1, make_cell(CellValue::Number(87.0)));

        let config = SampleConfig::default();
        let result = sample_data(&grid, &styles, true, &config);

        assert!(result.contains("Alice"));
        assert!(result.contains("Bob"));
        assert!(result.contains("95"));
        assert!(result.contains("87"));
    }

    #[test]
    fn test_sample_large_dataset() {
        let mut grid = Grid::new();
        let styles = StyleRegistry::new();

        grid.set_cell(0, 0, make_cell(CellValue::Text("Value".into())));
        for row in 1..=100 {
            grid.set_cell(row, 0, make_cell(CellValue::Number(row as f64)));
        }

        let config = SampleConfig {
            max_sample_rows: 5,
            include_stats: true,
        };
        let result = sample_data(&grid, &styles, true, &config);

        assert!(result.contains("Sample data"));
        assert!(result.contains("100 rows"));
        assert!(result.contains("..."));
        assert!(result.contains("Statistics:"));
        assert!(result.contains("min=1"));
        assert!(result.contains("max=100"));
    }

    #[test]
    fn test_pick_sample_rows() {
        // Small dataset — all rows
        assert_eq!(pick_sample_rows(1, 3, 5), vec![1, 2, 3]);

        // Large dataset — first 4 + last
        let rows = pick_sample_rows(1, 100, 5);
        assert!(rows.contains(&1));
        assert!(rows.contains(&100));
        assert!(rows.len() <= 5);
    }
}
