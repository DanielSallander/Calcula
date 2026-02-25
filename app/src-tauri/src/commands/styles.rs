//! FILENAME: app/src-tauri/src/commands/styles.rs
// PURPOSE: Styling operations, formatting, and style definitions.

use crate::api_types::{CellData, FormattingParams, FormattingResult, PreviewResult, StyleData, StyleEntry};
use crate::commands::utils::get_cell_internal_with_merge;
use crate::{format_cell_value_with_color, AppState};
use engine::{
    BorderLineStyle, BorderStyle, Cell, CellStyle, CellValue, Color, CurrencyPosition, NumberFormat,
    TextAlign, TextRotation, VerticalAlign,
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
        let result = format_cell_value_with_color(&updated_cell.value, style);

        Some(CellData {
            row,
            col,
            display: result.text,
            display_color: result.color,
            formula: updated_cell.formula,
            style_index,
            row_span,
            col_span,
            sheet_index: None,
        })
    } else {
        // Create a new empty cell with the style
        let cell = Cell {
            value: CellValue::Empty,
            formula: None,
            style_index,
            cached_ast: None,
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
            display_color: None,
            formula: None,
            style_index,
            row_span,
            col_span,
            sheet_index: None,
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
                        cached_ast: None,
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
            if let Some(strikethrough) = params.strikethrough {
                new_style.font.strikethrough = strikethrough;
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

            // Apply border formatting
            if let Some(ref border) = params.border_top {
                new_style.borders.top = parse_border_side(border);
            }
            if let Some(ref border) = params.border_right {
                new_style.borders.right = parse_border_side(border);
            }
            if let Some(ref border) = params.border_bottom {
                new_style.borders.bottom = parse_border_side(border);
            }
            if let Some(ref border) = params.border_left {
                new_style.borders.left = parse_border_side(border);
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

            let fmt_result = format_cell_value_with_color(&updated_cell.value, &new_style);

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
                display: fmt_result.text,
                display_color: fmt_result.color,
                formula: updated_cell.formula,
                style_index: new_style_index,
                row_span,
                col_span,
                sheet_index: None,
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

/// Preview a custom number format string against a sample value.
/// Used by the Format Cells dialog for live preview.
#[tauri::command]
pub fn preview_number_format(format_string: String, sample_value: f64) -> PreviewResult {
    let nf = NumberFormat::Custom { format: format_string };
    let style = CellStyle::new().with_number_format(nf);
    let result = format_cell_value_with_color(&CellValue::Number(sample_value), &style);
    PreviewResult {
        display: result.text,
        color: result.color,
    }
}

/// Parse a number format string into a NumberFormat enum.
/// Recognizes known preset names (e.g., "general", "currency_usd") and treats
/// anything else containing format characters as a custom format string.
pub(crate) fn parse_number_format(format: &str) -> NumberFormat {
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
        _ => {
            // Try to recognize common Excel-style format codes before falling
            // through to the custom format engine (which has known issues with
            // large numbers).
            if let Some(recognized) = try_parse_format_code(format) {
                recognized
            } else if is_custom_format_string(format) {
                NumberFormat::Custom {
                    format: format.to_string(),
                }
            } else {
                NumberFormat::General
            }
        }
    }
}

/// Attempts to parse a format code string (e.g., "0.00", "#,##0", "$#,##0.00")
/// into a typed NumberFormat variant. Returns None if the format is not
/// a recognized pattern, in which case the caller should fall back to Custom.
fn try_parse_format_code(format: &str) -> Option<NumberFormat> {
    let trimmed = format.trim();

    // Percentage formats: "0%", "0.0%", "0.00%", etc.
    if trimmed.ends_with('%') {
        let before_pct = &trimmed[..trimmed.len() - 1];
        if let Some(decimals) = count_decimal_places(before_pct) {
            return Some(NumberFormat::Percentage {
                decimal_places: decimals,
            });
        }
    }

    // Currency formats with $ prefix: "$#,##0", "$#,##0.00", etc.
    if trimmed.starts_with('$') {
        let after_symbol = &trimmed[1..];
        if let Some((decimals, _has_sep)) = parse_number_pattern(after_symbol) {
            return Some(NumberFormat::Currency {
                decimal_places: decimals,
                symbol: "$".to_string(),
                symbol_position: CurrencyPosition::Before,
            });
        }
    }

    // Currency formats with [$SYMBOL] prefix: "[$EUR] #,##0.00", "[$SEK] #,##0.00"
    if trimmed.starts_with("[$") {
        if let Some(bracket_end) = trimmed.find(']') {
            let symbol = trimmed[2..bracket_end].trim().to_string();
            let rest = trimmed[bracket_end + 1..].trim();
            if let Some((decimals, _has_sep)) = parse_number_pattern(rest) {
                return Some(NumberFormat::Currency {
                    decimal_places: decimals,
                    symbol: format!("{} ", symbol),
                    symbol_position: CurrencyPosition::Before,
                });
            }
        }
    }

    // Plain number formats: "0", "0.00", "#,##0", "#,##0.00", etc.
    if let Some((decimals, has_separator)) = parse_number_pattern(trimmed) {
        return Some(NumberFormat::Number {
            decimal_places: decimals,
            use_thousands_separator: has_separator,
        });
    }

    None
}

/// Parses a number pattern like "0", "0.00", "#,##0", "#,##0.00" and returns
/// (decimal_places, has_thousands_separator). Returns None if the pattern
/// doesn't match a pure number format.
fn parse_number_pattern(s: &str) -> Option<(u8, bool)> {
    // Must only contain: 0, #, comma, period
    if s.is_empty() || !s.chars().all(|c| c == '0' || c == '#' || c == ',' || c == '.') {
        return None;
    }

    let has_separator = s.contains(',');
    let decimals = if let Some(dot_pos) = s.find('.') {
        let frac = &s[dot_pos + 1..];
        // All fraction chars should be '0' (fixed-place digits)
        if frac.chars().all(|c| c == '0') {
            frac.len() as u8
        } else {
            return None;
        }
    } else {
        0
    };

    Some((decimals, has_separator))
}

/// Counts the number of decimal places in a simple numeric format like "0",
/// "0.0", "0.00". Returns None if the format is not a simple numeric pattern.
fn count_decimal_places(s: &str) -> Option<u8> {
    // For percentage patterns, just delegate to parse_number_pattern
    parse_number_pattern(s).map(|(decimals, _)| decimals)
}

/// Check if a string looks like a custom number format string.
fn is_custom_format_string(s: &str) -> bool {
    s.contains('0')
        || s.contains('#')
        || s.contains('?')
        || s.contains('@')
        || s.contains(';')
        || s.starts_with('[')
        || s.contains("yy")
        || s.contains("mm")
        || s.contains("dd")
        || s.contains("hh")
        || s.contains("ss")
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

/// Parse a border side parameter into a BorderStyle.
fn parse_border_side(param: &crate::api_types::BorderSideParam) -> BorderStyle {
    let line_style = match param.style.as_str() {
        "none" => BorderLineStyle::None,
        "thin" | "medium" | "thick" => BorderLineStyle::Solid,
        "dashed" => BorderLineStyle::Dashed,
        "dotted" => BorderLineStyle::Dotted,
        "double" => BorderLineStyle::Double,
        _ => BorderLineStyle::None,
    };
    let width: u8 = match param.style.as_str() {
        "none" => 0,
        "thin" => 1,
        "medium" => 2,
        "thick" => 3,
        "dashed" | "dotted" | "double" => 1,
        _ => 0,
    };
    let color = Color::from_hex(&param.color).unwrap_or(Color::new(0, 0, 0));

    BorderStyle {
        width,
        color,
        style: line_style,
    }
}

/// Get the total number of styles.
#[tauri::command]
pub fn get_style_count(state: State<AppState>) -> usize {
    let styles = state.style_registry.lock().unwrap();
    styles.len()
}
