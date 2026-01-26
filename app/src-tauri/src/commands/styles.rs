// PURPOSE: Styling operations, formatting, and style definitions.

use crate::api_types::{CellData, FormattingParams, FormattingResult, StyleData, StyleEntry};
use crate::commands::utils::get_cell_internal_with_merge;
use crate::{format_cell_value, AppState};
use engine::{
    Cell, CellValue, Color, CurrencyPosition, NumberFormat, TextAlign, TextRotation, VerticalAlign,
};
use tauri::State;

/// Get a style by index.
#[tauri::command]
pub fn get_style(state: State<AppState>, index: usize) -> StyleData {
    let styles = state.style_registry.lock().unwrap();
    StyleData::from(styles.get(index))
}

/// Get all styles.
#[tauri::command]
pub fn get_all_styles(state: State<AppState>) -> Vec<StyleData> {
    let styles = state.style_registry.lock().unwrap();
    styles.all_styles().iter().map(StyleData::from).collect()
}

/// Set a cell's style index.
#[tauri::command]
pub fn set_cell_style(
    state: State<AppState>,
    row: u32,
    col: u32,
    style_index: usize,
) -> Option<CellData> {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    // Record previous state for undo
    let previous_cell = grid.get_cell(row, col).cloned();

    // Get merge span info
    let merge_info = merged_regions.iter().find(|r| r.start_row == row && r.start_col == col);
    let (row_span, col_span) = if let Some(region) = merge_info {
        (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
    } else {
        (1, 1)
    };

    if let Some(cell) = grid.get_cell(row, col) {
        let mut updated_cell = cell.clone();
        updated_cell.style_index = style_index;
        grid.set_cell(row, col, updated_cell.clone());
        
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, updated_cell.clone());
        }

        // Record undo
        undo_stack.record_cell_change(row, col, previous_cell);

        let style = styles.get(style_index);
        let display = format_cell_value(&updated_cell.value, style);

        Some(CellData {
            row,
            col,
            display,
            formula: updated_cell.formula,
            style_index,
            row_span,
            col_span,
        })
    } else {
        // Create a new empty cell with the style
        let cell = Cell {
            value: CellValue::Empty,
            formula: None,
            style_index,
        };
        grid.set_cell(row, col, cell.clone());
        
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, cell);
        }

        // Record undo (previous was None since cell didn't exist)
        undo_stack.record_cell_change(row, col, previous_cell);

        Some(CellData {
            row,
            col,
            display: String::new(),
            formula: None,
            style_index,
            row_span,
            col_span,
        })
    }
}

/// Apply formatting to a range of cells.
#[tauri::command]
pub fn apply_formatting(
    state: State<AppState>,
    params: FormattingParams,
) -> Result<FormattingResult, String> {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut styles = state.style_registry.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    let mut updated_cells = Vec::new();
    let mut updated_styles = Vec::new();

    // Begin undo transaction for batch formatting
    let cell_count = params.rows.len() * params.cols.len();
    undo_stack.begin_transaction(format!("Format {} cells", cell_count));

    // Iterate over all row/col combinations from the params
    for row in &params.rows {
        for col in &params.cols {
            let row = *row;
            let col = *col;
            
            // Record previous state for undo
            let previous_cell = grid.get_cell(row, col).cloned();

            // Get or create cell
            let (cell, old_style_index) = if let Some(existing) = grid.get_cell(row, col) {
                (existing.clone(), existing.style_index)
            } else {
                (
                    Cell {
                        value: CellValue::Empty,
                        formula: None,
                        style_index: 0,
                    },
                    0,
                )
            };

            // Get base style
            let mut new_style = styles.get(old_style_index).clone();

            // Apply formatting changes
            if let Some(bold) = params.bold {
                new_style.font.bold = bold;
            }
            if let Some(italic) = params.italic {
                new_style.font.italic = italic;
            }
            if let Some(underline) = params.underline {
                new_style.font.underline = underline;
            }
            if let Some(font_size) = params.font_size {
                new_style.font.size = font_size;
            }
            if let Some(ref font_family) = params.font_family {
                new_style.font.family = font_family.clone();
            }
            if let Some(ref text_color) = params.text_color {
                if let Some(color) = Color::from_hex(text_color) {
                    new_style.font.color = color;
                }
            }
            if let Some(ref bg_color) = params.background_color {
                if let Some(color) = Color::from_hex(bg_color) {
                    new_style.background = color;
                }
            }
            if let Some(ref align) = params.text_align {
                new_style.text_align = match align.as_str() {
                    "left" => TextAlign::Left,
                    "center" => TextAlign::Center,
                    "right" => TextAlign::Right,
                    _ => TextAlign::General,
                };
            }
            if let Some(ref valign) = params.vertical_align {
                new_style.vertical_align = match valign.as_str() {
                    "top" => VerticalAlign::Top,
                    "middle" => VerticalAlign::Middle,
                    "bottom" => VerticalAlign::Bottom,
                    _ => VerticalAlign::Middle,
                };
            }
            if let Some(wrap) = params.wrap_text {
                new_style.wrap_text = wrap;
            }
            if let Some(ref rotation) = params.text_rotation {
                new_style.text_rotation = parse_text_rotation(rotation);
            }
            if let Some(ref format) = params.number_format {
                new_style.number_format = parse_number_format(format);
            }

            // Get or create style index
            let new_style_index = styles.get_or_create(new_style.clone());

            // Update cell
            let mut updated_cell = cell;
            updated_cell.style_index = new_style_index;
            grid.set_cell(row, col, updated_cell.clone());
            
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, col, updated_cell.clone());
            }

            // Record undo
            undo_stack.record_cell_change(row, col, previous_cell);

            let display = format_cell_value(&updated_cell.value, &new_style);

            // Get merge span info
            let merge_info = merged_regions.iter().find(|r| r.start_row == row && r.start_col == col);
            let (row_span, col_span) = if let Some(region) = merge_info {
                (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
            } else {
                (1, 1)
            };

            updated_cells.push(CellData {
                row,
                col,
                display,
                formula: updated_cell.formula,
                style_index: new_style_index,
                row_span,
                col_span,
            });
        }
    }

    // Commit undo transaction
    undo_stack.commit_transaction();

    // Collect all styles
    for (index, style) in styles.all_styles().iter().enumerate() {
        updated_styles.push(StyleEntry {
            index,
            style: StyleData::from(style),
        });
    }

    Ok(FormattingResult {
        cells: updated_cells,
        styles: updated_styles,
    })
}

/// Parse a number format string.
fn parse_number_format(format: &str) -> NumberFormat {
    match format.to_lowercase().as_str() {
        "general" => NumberFormat::General,
        "number" => NumberFormat::Number {
            decimal_places: 2,
            use_thousands_separator: false,
        },
        "number_sep" => NumberFormat::Number {
            decimal_places: 2,
            use_thousands_separator: true,
        },
        "currency_usd" => NumberFormat::Currency {
            decimal_places: 2,
            symbol: "$".to_string(),
            symbol_position: CurrencyPosition::Before,
        },
        "currency_eur" => NumberFormat::Currency {
            decimal_places: 2,
            symbol: "EUR".to_string(),
            symbol_position: CurrencyPosition::Before,
        },
        "currency_sek" => NumberFormat::Currency {
            decimal_places: 2,
            symbol: "kr".to_string(),
            symbol_position: CurrencyPosition::After,
        },
        "percentage" => NumberFormat::Percentage { decimal_places: 2 },
        "scientific" => NumberFormat::Scientific { decimal_places: 2 },
        "date_iso" => NumberFormat::Date {
            format: "yyyy-mm-dd".to_string(),
        },
        "date_us" => NumberFormat::Date {
            format: "mm/dd/yyyy".to_string(),
        },
        "date_eu" => NumberFormat::Date {
            format: "dd/mm/yyyy".to_string(),
        },
        "time_24h" => NumberFormat::Time {
            format: "hh:mm:ss".to_string(),
        },
        "time_12h" => NumberFormat::Time {
            format: "hh:mm:ss AM/PM".to_string(),
        },
        _ => NumberFormat::General,
    }
}

/// Parse a text rotation string.
fn parse_text_rotation(rotation: &str) -> TextRotation {
    match rotation.to_lowercase().as_str() {
        "none" | "0" => TextRotation::None,
        "90" | "up" => TextRotation::Rotate90,
        "270" | "-90" | "down" => TextRotation::Rotate270,
        _ => {
            // Try to parse as a number
            if let Ok(angle) = rotation.parse::<i16>() {
                let clamped = angle.clamp(-90, 90);
                if clamped == 0 {
                    TextRotation::None
                } else if clamped == 90 {
                    TextRotation::Rotate90
                } else if clamped == -90 {
                    TextRotation::Rotate270
                } else {
                    TextRotation::Custom(clamped)
                }
            } else {
                TextRotation::None
            }
        }
    }
}

/// Get the total number of styles.
#[tauri::command]
pub fn get_style_count(state: State<AppState>) -> usize {
    let styles = state.style_registry.lock().unwrap();
    styles.len()
}