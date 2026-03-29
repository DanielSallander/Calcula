//! FILENAME: core/calcula-format/src/ai/context_builder.rs
//! Assembles the final AI context string from all components.
//! Supports token budgeting to keep output within LLM context limits.

use engine::grid::Grid;
use engine::style::StyleRegistry;
use serde::{Deserialize, Serialize};

use super::data_sampler::{self, SampleConfig};
use super::formula_patterns;
use super::sheet_summary;

/// Options for AI context serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSerializeOptions {
    /// Approximate maximum character count for the output.
    /// A rough proxy for tokens (~4 chars per token).
    /// 0 = no limit.
    #[serde(default)]
    pub max_chars: usize,

    /// Whether to include style descriptions.
    #[serde(default)]
    pub include_styles: bool,

    /// Focus on a specific sheet (by index). None = all sheets.
    #[serde(default)]
    pub focus_sheet: Option<usize>,

    /// Maximum sample rows per sheet.
    #[serde(default = "default_sample_rows")]
    pub max_sample_rows: usize,

    /// Additional context about the current user selection.
    #[serde(default)]
    pub selection_context: Option<String>,

    /// Table metadata to include (serialized from Tauri side).
    #[serde(default)]
    pub tables_json: Option<String>,
}

fn default_sample_rows() -> usize {
    5
}

impl Default for AiSerializeOptions {
    fn default() -> Self {
        AiSerializeOptions {
            max_chars: 0,
            include_styles: false,
            focus_sheet: None,
            max_sample_rows: 5,
            selection_context: None,
            tables_json: None,
        }
    }
}

/// Input data for a single sheet to be serialized.
pub struct SheetInput<'a> {
    pub name: &'a str,
    pub grid: &'a Grid,
    pub styles: &'a StyleRegistry,
}

/// Serialize one or more sheets into an AI-friendly context string.
pub fn serialize_for_ai(
    sheets: &[SheetInput],
    options: &AiSerializeOptions,
) -> String {
    let mut sections: Vec<String> = Vec::new();
    let mut total_chars = 0;
    let budget = if options.max_chars > 0 {
        options.max_chars
    } else {
        usize::MAX
    };

    // Filter to focus sheet if specified
    let target_sheets: Vec<&SheetInput> = if let Some(idx) = options.focus_sheet {
        sheets.get(idx).into_iter().collect()
    } else {
        sheets.iter().collect()
    };

    // Workbook header
    let header = format!("# Workbook ({} sheets)\n", sheets.len());
    total_chars += header.len();
    sections.push(header);

    // If focusing on one sheet but there are others, list them briefly
    if options.focus_sheet.is_some() && sheets.len() > 1 {
        let mut sheet_list = String::from("Other sheets: ");
        let names: Vec<String> = sheets
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != options.focus_sheet)
            .map(|(_, s)| format!("\"{}\"", s.name))
            .collect();
        sheet_list.push_str(&names.join(", "));
        sheet_list.push('\n');
        total_chars += sheet_list.len();
        sections.push(sheet_list);
    }

    for sheet in target_sheets {
        if total_chars >= budget {
            sections.push("(truncated due to size limit)\n".to_string());
            break;
        }

        let remaining = budget.saturating_sub(total_chars);
        let sheet_context = serialize_sheet(sheet, options, remaining);
        total_chars += sheet_context.len();
        sections.push(sheet_context);
    }

    // Tables
    if let Some(ref tables_json) = options.tables_json {
        if total_chars < budget {
            let table_section = format_tables_section(tables_json);
            if !table_section.is_empty() {
                total_chars += table_section.len();
                sections.push(table_section);
            }
        }
    }

    // Selection context
    if let Some(ref sel) = options.selection_context {
        if total_chars < budget {
            let sel_section = format!("\n## Active Context\n{}\n", sel);
            sections.push(sel_section);
        }
    }

    sections.join("\n")
}

/// Serialize a single sheet.
fn serialize_sheet(
    sheet: &SheetInput,
    options: &AiSerializeOptions,
    char_budget: usize,
) -> String {
    let mut sections: Vec<String> = Vec::new();
    let mut used = 0;

    // Sheet summary (always included — cheap and essential)
    let summary = sheet_summary::summarize_sheet(sheet.name, sheet.grid, sheet.styles);
    let summary_text = sheet_summary::format_sheet_summary(&summary);
    used += summary_text.len();
    sections.push(summary_text);

    // Formula patterns (high value, compact)
    if used < char_budget {
        let patterns = formula_patterns::detect_formula_patterns(sheet.grid);
        let patterns_text = formula_patterns::format_formula_patterns(&patterns);
        if !patterns_text.is_empty() {
            used += patterns_text.len();
            sections.push(patterns_text);
        }
    }

    // Data sample (medium cost, high value)
    if used < char_budget {
        let sample_config = SampleConfig {
            max_sample_rows: options.max_sample_rows,
            include_stats: true,
        };
        let sample_text =
            data_sampler::sample_data(sheet.grid, sheet.styles, summary.has_header_row, &sample_config);
        if !sample_text.is_empty() && used + sample_text.len() <= char_budget {
            sections.push(sample_text);
        }
    }

    sections.join("")
}

/// Format table definitions for AI context.
fn format_tables_section(tables_json: &str) -> String {
    // Parse the tables JSON (array of TableDef from the features module)
    let tables: Vec<serde_json::Value> = match serde_json::from_str(tables_json) {
        Ok(t) => t,
        Err(_) => return String::new(),
    };

    if tables.is_empty() {
        return String::new();
    }

    let mut out = String::from("## Tables\n");
    for table in &tables {
        let name = table.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let cols: Vec<String> = table
            .get("columns")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        out.push_str(&format!("- Table \"{}\": columns [{}]\n", name, cols.join(", ")));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::cell::{Cell, CellValue};

    fn make_cell(value: CellValue, formula: Option<String>) -> Cell {
        Cell {
            value,
            formula,
            style_index: 0,
            rich_text: None,
            cached_ast: None,
        }
    }

    fn build_test_sheets() -> (Grid, StyleRegistry) {
        let mut grid = Grid::new();
        let styles = StyleRegistry::new();

        // Header row
        grid.set_cell(0, 0, make_cell(CellValue::Text("Name".into()), None));
        grid.set_cell(0, 1, make_cell(CellValue::Text("Amount".into()), None));
        grid.set_cell(0, 2, make_cell(CellValue::Text("Tax".into()), None));

        // Data rows
        grid.set_cell(1, 0, make_cell(CellValue::Text("Alice".into()), None));
        grid.set_cell(1, 1, make_cell(CellValue::Number(1000.0), None));
        grid.set_cell(
            1,
            2,
            make_cell(CellValue::Number(250.0), Some("=B2*0.25".into())),
        );

        grid.set_cell(2, 0, make_cell(CellValue::Text("Bob".into()), None));
        grid.set_cell(2, 1, make_cell(CellValue::Number(2000.0), None));
        grid.set_cell(
            2,
            2,
            make_cell(CellValue::Number(500.0), Some("=B3*0.25".into())),
        );

        grid.set_cell(3, 0, make_cell(CellValue::Text("Charlie".into()), None));
        grid.set_cell(3, 1, make_cell(CellValue::Number(1500.0), None));
        grid.set_cell(
            3,
            2,
            make_cell(CellValue::Number(375.0), Some("=B4*0.25".into())),
        );

        (grid, styles)
    }

    #[test]
    fn test_full_serialization() {
        let (grid, styles) = build_test_sheets();

        let sheets = vec![SheetInput {
            name: "Sales",
            grid: &grid,
            styles: &styles,
        }];

        let options = AiSerializeOptions::default();
        let result = serialize_for_ai(&sheets, &options);

        // Should contain sheet summary
        assert!(result.contains("Sheet \"Sales\""));
        assert!(result.contains("4 rows x 3 columns"));

        // Should contain header info
        assert!(result.contains("Header row: 1"));

        // Should contain column info
        assert!(result.contains("Name"));
        assert!(result.contains("Amount"));
        assert!(result.contains("Tax"));

        // Should contain formula pattern
        assert!(result.contains("=B{r}*0.25"));

        // Should contain sample data
        assert!(result.contains("Alice"));
        assert!(result.contains("1000"));
    }

    #[test]
    fn test_focus_sheet() {
        let (grid, styles) = build_test_sheets();
        let grid2 = Grid::new();

        let sheets = vec![
            SheetInput {
                name: "Sales",
                grid: &grid,
                styles: &styles,
            },
            SheetInput {
                name: "Summary",
                grid: &grid2,
                styles: &styles,
            },
        ];

        let options = AiSerializeOptions {
            focus_sheet: Some(0),
            ..Default::default()
        };
        let result = serialize_for_ai(&sheets, &options);

        assert!(result.contains("Sheet \"Sales\""));
        assert!(result.contains("Other sheets: \"Summary\""));
        assert!(!result.contains("Sheet \"Summary\""));
    }

    #[test]
    fn test_char_budget() {
        let (grid, styles) = build_test_sheets();

        let sheets = vec![SheetInput {
            name: "Sales",
            grid: &grid,
            styles: &styles,
        }];

        // Very small budget — should still produce header + summary
        let options = AiSerializeOptions {
            max_chars: 200,
            ..Default::default()
        };
        let result = serialize_for_ai(&sheets, &options);

        assert!(result.contains("Sheet \"Sales\""));
        // But might not have sample data due to budget
        assert!(result.len() <= 500); // Some tolerance for the summary
    }

    #[test]
    fn test_empty_workbook() {
        let grid = Grid::new();
        let styles = StyleRegistry::new();

        let sheets = vec![SheetInput {
            name: "Sheet1",
            grid: &grid,
            styles: &styles,
        }];

        let result = serialize_for_ai(&sheets, &AiSerializeOptions::default());
        assert!(result.contains("(empty sheet)"));
    }
}
