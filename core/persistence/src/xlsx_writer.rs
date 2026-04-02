//! FILENAME: core/persistence/src/xlsx_writer.rs

use crate::{CalculaMeta, PersistenceError, SavedCellValue, Workbook, META_SHEET_NAME};
use engine::style::{
    CellStyle, NumberFormat, TextAlign, TextRotation, VerticalAlign,
};
use rust_xlsxwriter::{Format, FormatAlign, Workbook as XlsxWorkbook};
use std::path::Path;

pub fn save_xlsx(workbook: &Workbook, path: &Path) -> Result<(), PersistenceError> {
    let mut xlsx = XlsxWorkbook::new();

    for sheet in &workbook.sheets {
        let worksheet = xlsx.add_worksheet();
        worksheet.set_name(&sheet.name)?;

        // Set column widths (Excel uses character width, roughly pixels / 7)
        for (col, width) in &sheet.column_widths {
            let excel_width = *width / 7.0;
            worksheet.set_column_width(*col as u16, excel_width)?;
        }

        // Set row heights (Excel uses points)
        for (row, height) in &sheet.row_heights {
            worksheet.set_row_height(*row, *height)?;
        }

        // Write cells
        for ((row, col), cell) in &sheet.cells {
            let format = if cell.style_index > 0 && cell.style_index < sheet.styles.len() {
                Some(convert_style_to_format(&sheet.styles[cell.style_index]))
            } else {
                None
            };

            match &cell.value {
                SavedCellValue::Empty => {}
                SavedCellValue::Number(n) => {
                    if let Some(ref formula) = cell.formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        if let Some(fmt) = format {
                            worksheet.write_formula_with_format(*row, *col as u16, clean_formula, &fmt)?;
                        } else {
                            worksheet.write_formula(*row, *col as u16, clean_formula)?;
                        }
                    } else if let Some(fmt) = format {
                        worksheet.write_number_with_format(*row, *col as u16, *n, &fmt)?;
                    } else {
                        worksheet.write_number(*row, *col as u16, *n)?;
                    }
                }
                SavedCellValue::Text(s) => {
                    if let Some(ref formula) = cell.formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        if let Some(fmt) = format {
                            worksheet.write_formula_with_format(*row, *col as u16, clean_formula, &fmt)?;
                        } else {
                            worksheet.write_formula(*row, *col as u16, clean_formula)?;
                        }
                    } else if let Some(fmt) = format {
                        worksheet.write_string_with_format(*row, *col as u16, s, &fmt)?;
                    } else {
                        worksheet.write_string(*row, *col as u16, s)?;
                    }
                }
                SavedCellValue::Boolean(b) => {
                    if let Some(fmt) = format {
                        worksheet.write_boolean_with_format(*row, *col as u16, *b, &fmt)?;
                    } else {
                        worksheet.write_boolean(*row, *col as u16, *b)?;
                    }
                }
                SavedCellValue::Error(_) => {
                    if let Some(fmt) = format {
                        worksheet.write_string_with_format(*row, *col as u16, "#ERROR!", &fmt)?;
                    } else {
                        worksheet.write_string(*row, *col as u16, "#ERROR!")?;
                    }
                }
                SavedCellValue::List(items) => {
                    let display = format!("[List({})]", items.len());
                    if let Some(fmt) = format {
                        worksheet.write_string_with_format(*row, *col as u16, &display, &fmt)?;
                    } else {
                        worksheet.write_string(*row, *col as u16, &display)?;
                    }
                }
                SavedCellValue::Dict(entries) => {
                    let display = format!("[Dict({})]", entries.len());
                    if let Some(fmt) = format {
                        worksheet.write_string_with_format(*row, *col as u16, &display, &fmt)?;
                    } else {
                        worksheet.write_string(*row, *col as u16, &display)?;
                    }
                }
            }
        }
    }

    // Write Calcula metadata sheet (tables, etc.) if there is any metadata
    if !workbook.tables.is_empty() {
        let meta = CalculaMeta::new(workbook.tables.clone());
        let json = meta.to_json();

        let meta_ws = xlsx.add_worksheet();
        meta_ws.set_name(META_SHEET_NAME)?;
        meta_ws.write_string(0, 0, &json)?;
        meta_ws.set_hidden(true);
    }

    xlsx.save(path)?;
    Ok(())
}

fn convert_style_to_format(style: &CellStyle) -> Format {
    let mut format = Format::new();

    // Font settings
    if style.font.bold {
        format = format.set_bold();
    }
    if style.font.italic {
        format = format.set_italic();
    }
    if style.font.underline {
        format = format.set_underline(rust_xlsxwriter::FormatUnderline::Single);
    }
    if style.font.strikethrough {
        format = format.set_font_strikethrough();
    }

    format = format.set_font_size(style.font.size as f64);
    format = format.set_font_name(&style.font.family);

    // Colors
    if !is_default_color(&style.font.color) {
        format = format.set_font_color(color_to_xlsx(&style.font.color));
    }
    if !style.fill.is_none() {
        let bg = style.fill.background_color();
        if !is_default_background(bg) {
            format = format.set_background_color(color_to_xlsx(bg));
        }
    }

    // Horizontal alignment
    format = format.set_align(match style.text_align {
        TextAlign::Left => FormatAlign::Left,
        TextAlign::Center => FormatAlign::Center,
        TextAlign::Right => FormatAlign::Right,
        TextAlign::General => FormatAlign::General,
    });

    // Vertical alignment
    format = format.set_align(match style.vertical_align {
        VerticalAlign::Top => FormatAlign::Top,
        VerticalAlign::Middle => FormatAlign::VerticalCenter,
        VerticalAlign::Bottom => FormatAlign::Bottom,
    });

    // Text rotation
    match style.text_rotation {
        TextRotation::None => {}
        TextRotation::Rotate90 => {
            format = format.set_rotation(90);
        }
        TextRotation::Rotate270 => {
            format = format.set_rotation(270);
        }
        TextRotation::Custom(angle) => {
            format = format.set_rotation(angle as i16);
        }
    }

    // Word wrap
    if style.wrap_text {
        format = format.set_text_wrap();
    }

    // Number format
    let num_format = convert_number_format(&style.number_format);
    if !num_format.is_empty() {
        format = format.set_num_format(&num_format);
    }

    format
}

fn convert_number_format(format: &NumberFormat) -> String {
    match format {
        NumberFormat::General => String::new(),
        NumberFormat::Number { decimal_places, use_thousands_separator } => {
            let decimal_part = if *decimal_places > 0 {
                format!(".{}", "0".repeat(*decimal_places as usize))
            } else {
                String::new()
            };
            if *use_thousands_separator {
                format!("#,##0{}", decimal_part)
            } else {
                format!("0{}", decimal_part)
            }
        }
        NumberFormat::Currency { decimal_places, symbol, symbol_position: _ } => {
            let decimal_part = if *decimal_places > 0 {
                format!(".{}", "0".repeat(*decimal_places as usize))
            } else {
                String::new()
            };
            format!("{}#,##0{}", symbol, decimal_part)
        }
        NumberFormat::Percentage { decimal_places } => {
            let decimal_part = if *decimal_places > 0 {
                format!(".{}", "0".repeat(*decimal_places as usize))
            } else {
                String::new()
            };
            format!("0{}%", decimal_part)
        }
        NumberFormat::Scientific { decimal_places } => {
            let decimal_part = if *decimal_places > 0 {
                format!(".{}", "0".repeat(*decimal_places as usize))
            } else {
                String::new()
            };
            format!("0{}E+00", decimal_part)
        }
        NumberFormat::Date { format: fmt } => fmt.clone(),
        NumberFormat::Time { format: fmt } => fmt.clone(),
        NumberFormat::Custom { format: fmt } => fmt.clone(),
    }
}

fn color_to_xlsx(color: &engine::theme::ThemeColor) -> rust_xlsxwriter::Color {
    // Resolve theme colors using Office theme for XLSX export
    let theme = engine::theme::ThemeDefinition::office();
    let resolved = theme.resolve_color(color);
    rust_xlsxwriter::Color::RGB(
        ((resolved.r as u32) << 16) | ((resolved.g as u32) << 8) | (resolved.b as u32)
    )
}

fn is_default_color(color: &engine::theme::ThemeColor) -> bool {
    match color {
        engine::theme::ThemeColor::Theme { slot: engine::theme::ThemeColorSlot::Dark1, tint } if tint.0 == 0 => true,
        engine::theme::ThemeColor::Absolute(c) => c.r == 0 && c.g == 0 && c.b == 0 && c.a == 255,
        _ => false,
    }
}

fn is_default_background(color: &engine::theme::ThemeColor) -> bool {
    match color {
        engine::theme::ThemeColor::Theme { slot: engine::theme::ThemeColorSlot::Light1, tint } if tint.0 == 0 => true,
        engine::theme::ThemeColor::Absolute(c) => c.r == 255 && c.g == 255 && c.b == 255 && c.a == 255,
        _ => false,
    }
}