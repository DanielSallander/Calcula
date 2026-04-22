//! FILENAME: app/src-tauri/src/named_styles_cmd.rs
// PURPOSE: Named cell styles — create, apply, delete, and initialize built-in styles.
// CONTEXT: Named styles map a user-facing name ("Heading 1", "Good", etc.) to a
// style_index in the StyleRegistry. Built-in styles are seeded on app start.

use crate::api_types::{CellData, FormattingResult, NamedCellStyle, StyleData, StyleEntry};
use crate::persistence::FileState;
use crate::{format_cell_value_with_color, AppState};
use engine::{
    BorderLineStyle, BorderStyle, Cell, CellStyle, CellValue, Color, Fill,
    NumberFormat, ThemeColor,
};
use tauri::State;

// ============================================================================
// Tauri Commands
// ============================================================================

/// Get all named styles.
#[tauri::command]
pub fn get_named_styles(state: State<AppState>) -> Vec<NamedCellStyle> {
    let named = state.named_styles.lock().unwrap();
    let mut result: Vec<NamedCellStyle> = named.values().cloned().collect();
    // Sort by category then name for consistent ordering
    result.sort_by(|a, b| a.category.cmp(&b.category).then(a.name.cmp(&b.name)));
    result
}

/// Create a new named style.
#[tauri::command]
pub fn create_named_style(
    state: State<AppState>,
    name: String,
    style_index: usize,
    category: String,
) -> Result<NamedCellStyle, String> {
    let mut named = state.named_styles.lock().unwrap();

    if named.contains_key(&name) {
        return Err(format!("Named style '{}' already exists", name));
    }

    let style = NamedCellStyle {
        name: name.clone(),
        built_in: false,
        style_index,
        category,
    };

    named.insert(name, style.clone());
    Ok(style)
}

/// Delete a named style by name.
#[tauri::command]
pub fn delete_named_style(
    state: State<AppState>,
    name: String,
) -> Result<(), String> {
    let mut named = state.named_styles.lock().unwrap();

    if let Some(existing) = named.get(&name) {
        if existing.built_in {
            return Err(format!("Cannot delete built-in style '{}'", name));
        }
    } else {
        return Err(format!("Named style '{}' not found", name));
    }

    named.remove(&name);
    Ok(())
}

/// Apply a named style to a set of cells.
/// Looks up the named style, gets its style_index, and sets it on all specified cells.
#[tauri::command]
pub fn apply_named_style(
    state: State<AppState>,
    file_state: State<FileState>,
    name: String,
    rows: Vec<u32>,
    cols: Vec<u32>,
) -> Result<FormattingResult, String> {
    // Look up the named style
    let style_index = {
        let named = state.named_styles.lock().unwrap();
        match named.get(&name) {
            Some(ns) => ns.style_index,
            None => return Err(format!("Named style '{}' not found", name)),
        }
    };

    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    let mut updated_cells = Vec::new();

    let cell_count = rows.len() * cols.len();
    undo_stack.begin_transaction(format!("Apply style '{}' to {} cells", name, cell_count));

    for &row in &rows {
        for &col in &cols {
            // Record previous state for undo
            let previous_cell = grid.get_cell(row, col).cloned();

            // Get or create cell
            let cell = if let Some(existing) = grid.get_cell(row, col) {
                existing.clone()
            } else {
                Cell {
                    value: CellValue::Empty,
                    formula: None,
                    style_index: 0,
                    rich_text: None,
                    cached_ast: None,
                }
            };

            // Update cell with the named style's style_index
            let mut updated_cell = cell;
            updated_cell.style_index = style_index;
            grid.set_cell(row, col, updated_cell.clone());

            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, col, updated_cell.clone());
            }

            // Record undo
            undo_stack.record_cell_change(row, col, previous_cell);

            let cell_style = styles.get(style_index);
            let fmt_result = format_cell_value_with_color(&updated_cell.value, cell_style, &locale);
            let acct_layout = fmt_result.accounting.map(|a| crate::api_types::AccountingLayout {
                symbol: a.symbol,
                symbol_before: a.symbol_before,
                value: a.value,
            });

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
                style_index,
                row_span,
                col_span,
                sheet_index: None,
                rich_text: None,
                accounting_layout: acct_layout,
            });
        }
    }

    // Commit undo transaction
    undo_stack.commit_transaction();

    // Collect all styles
    let theme = state.theme.lock().unwrap();
    let updated_styles: Vec<StyleEntry> = styles
        .all_styles()
        .iter()
        .enumerate()
        .map(|(index, style)| StyleEntry {
            index,
            style: StyleData::from_cell_style(style, &theme),
        })
        .collect();

    // Mark workbook as dirty
    if !updated_cells.is_empty() {
        if let Ok(mut modified) = file_state.is_modified.lock() {
            *modified = true;
        }
    }

    Ok(FormattingResult {
        cells: updated_cells,
        styles: updated_styles,
    })
}

// ============================================================================
// Built-in Style Initialization
// ============================================================================

/// Initialize the built-in named styles in AppState.
/// Called once during `create_app_state()`.
pub fn init_builtin_named_styles(state: &AppState) {
    let mut styles = state.style_registry.lock().unwrap();
    let mut named = state.named_styles.lock().unwrap();

    // Helper to register a named style
    let mut register = |name: &str, category: &str, cell_style: CellStyle| {
        let index = styles.get_or_create(cell_style);
        named.insert(
            name.to_string(),
            NamedCellStyle {
                name: name.to_string(),
                built_in: true,
                style_index: index,
                category: category.to_string(),
            },
        );
    };

    // --- Good, Bad and Neutral ---

    // Normal: default style (index 0)
    register("Normal", "Good, Bad and Neutral", CellStyle::new());

    // Good: dark green text on light green background
    register(
        "Good",
        "Good, Bad and Neutral",
        CellStyle::new()
            .with_text_color(ThemeColor::Absolute(Color::new(0x00, 0x61, 0x00)))
            .with_background(ThemeColor::Absolute(Color::new(0xc6, 0xef, 0xce))),
    );

    // Bad: dark red text on light red background
    register(
        "Bad",
        "Good, Bad and Neutral",
        CellStyle::new()
            .with_text_color(ThemeColor::Absolute(Color::new(0x9c, 0x00, 0x06)))
            .with_background(ThemeColor::Absolute(Color::new(0xff, 0xc7, 0xce))),
    );

    // Neutral: dark amber text on light yellow background
    register(
        "Neutral",
        "Good, Bad and Neutral",
        CellStyle::new()
            .with_text_color(ThemeColor::Absolute(Color::new(0x9c, 0x57, 0x00)))
            .with_background(ThemeColor::Absolute(Color::new(0xff, 0xeb, 0x9c))),
    );

    // --- Data and Model ---

    register(
        "Calculation",
        "Data and Model",
        {
            let mut s = CellStyle::new();
            s.font.bold = true;
            s.font.color = ThemeColor::Absolute(Color::new(0xfa, 0x7d, 0x00));
            s.fill = Fill::Solid { color: ThemeColor::Absolute(Color::new(0xf2, 0xf2, 0xf2)) };
            let border = BorderStyle {
                width: 1,
                color: ThemeColor::Absolute(Color::new(0x7f, 0x7f, 0x7f)),
                style: BorderLineStyle::Solid,
            };
            s.borders.top = border.clone();
            s.borders.right = border.clone();
            s.borders.bottom = border.clone();
            s.borders.left = border;
            s
        },
    );

    register(
        "Check Cell",
        "Data and Model",
        {
            let mut s = CellStyle::new();
            s.font.bold = true;
            s.font.color = ThemeColor::Absolute(Color::white());
            s.fill = Fill::Solid { color: ThemeColor::Absolute(Color::new(0xa5, 0xa5, 0xa5)) };
            let border = BorderStyle {
                width: 1,
                color: ThemeColor::Absolute(Color::new(0x3f, 0x3f, 0x3f)),
                style: BorderLineStyle::Solid,
            };
            s.borders.top = border.clone();
            s.borders.right = border.clone();
            s.borders.bottom = border.clone();
            s.borders.left = border;
            s
        },
    );

    register(
        "Explanatory...",
        "Data and Model",
        {
            let mut s = CellStyle::new();
            s.font.italic = true;
            s.font.color = ThemeColor::Absolute(Color::new(0x7f, 0x7f, 0x7f));
            s
        },
    );

    register(
        "Input",
        "Data and Model",
        {
            let mut s = CellStyle::new();
            s.font.color = ThemeColor::Absolute(Color::new(0x3f, 0x3f, 0x76));
            s.fill = Fill::Solid { color: ThemeColor::Absolute(Color::new(0xff, 0xcc, 0x99)) };
            let border = BorderStyle {
                width: 1,
                color: ThemeColor::Absolute(Color::new(0x7f, 0x7f, 0x7f)),
                style: BorderLineStyle::Solid,
            };
            s.borders.top = border.clone();
            s.borders.right = border.clone();
            s.borders.bottom = border.clone();
            s.borders.left = border;
            s
        },
    );

    register(
        "Linked Cell",
        "Data and Model",
        {
            let mut s = CellStyle::new();
            s.font.color = ThemeColor::Absolute(Color::new(0xfa, 0x7d, 0x00));
            s.borders.bottom = BorderStyle {
                width: 1,
                color: ThemeColor::Absolute(Color::new(0xff, 0x80, 0x01)),
                style: BorderLineStyle::Solid,
            };
            s
        },
    );

    register(
        "Note",
        "Data and Model",
        {
            let mut s = CellStyle::new();
            s.font.color = ThemeColor::Absolute(Color::new(0x3f, 0x3f, 0x3f));
            s.fill = Fill::Solid { color: ThemeColor::Absolute(Color::new(0xff, 0xff, 0xcc)) };
            let border = BorderStyle {
                width: 1,
                color: ThemeColor::Absolute(Color::new(0xb2, 0xb2, 0xb2)),
                style: BorderLineStyle::Solid,
            };
            s.borders.top = border.clone();
            s.borders.right = border.clone();
            s.borders.bottom = border.clone();
            s.borders.left = border;
            s
        },
    );

    register(
        "Output",
        "Data and Model",
        {
            let mut s = CellStyle::new();
            s.font.bold = true;
            s.font.color = ThemeColor::Absolute(Color::new(0x3f, 0x3f, 0x3f));
            s.fill = Fill::Solid { color: ThemeColor::Absolute(Color::new(0xf2, 0xf2, 0xf2)) };
            let border = BorderStyle {
                width: 1,
                color: ThemeColor::Absolute(Color::new(0x3f, 0x3f, 0x3f)),
                style: BorderLineStyle::Solid,
            };
            s.borders.top = border.clone();
            s.borders.right = border.clone();
            s.borders.bottom = border.clone();
            s.borders.left = border;
            s
        },
    );

    register(
        "Warning Text",
        "Data and Model",
        CellStyle::new()
            .with_text_color(ThemeColor::Absolute(Color::new(0xff, 0x00, 0x00))),
    );

    // --- Titles and Headings ---

    register(
        "Title",
        "Titles and Headings",
        {
            let mut s = CellStyle::new();
            s.font.bold = true;
            s.font.size = 18;
            s.font.color = ThemeColor::Absolute(Color::new(0x1f, 0x4e, 0x79));
            s
        },
    );

    register(
        "Heading 1",
        "Titles and Headings",
        {
            let mut s = CellStyle::new();
            s.font.bold = true;
            s.font.size = 15;
            s.font.color = ThemeColor::Absolute(Color::new(0x1f, 0x4e, 0x79));
            s.borders.bottom = BorderStyle {
                width: 3,
                color: ThemeColor::Absolute(Color::new(0x44, 0x72, 0xc4)),
                style: BorderLineStyle::Solid,
            };
            s
        },
    );

    register(
        "Heading 2",
        "Titles and Headings",
        {
            let mut s = CellStyle::new();
            s.font.bold = true;
            s.font.size = 13;
            s.font.color = ThemeColor::Absolute(Color::new(0x1f, 0x4e, 0x79));
            s.borders.bottom = BorderStyle {
                width: 1,
                color: ThemeColor::Absolute(Color::new(0x44, 0x72, 0xc4)),
                style: BorderLineStyle::Solid,
            };
            s
        },
    );

    register(
        "Heading 3",
        "Titles and Headings",
        {
            let mut s = CellStyle::new();
            s.font.bold = true;
            s.font.color = ThemeColor::Absolute(Color::new(0x1f, 0x4e, 0x79));
            s
        },
    );

    register(
        "Heading 4",
        "Titles and Headings",
        {
            let mut s = CellStyle::new();
            s.font.bold = true;
            s.font.italic = true;
            s.font.color = ThemeColor::Absolute(Color::new(0x1f, 0x4e, 0x79));
            s
        },
    );

    register(
        "Total",
        "Titles and Headings",
        {
            let mut s = CellStyle::new();
            s.font.bold = true;
            s.font.color = ThemeColor::Absolute(Color::new(0x1f, 0x4e, 0x79));
            s.borders.top = BorderStyle {
                width: 1,
                color: ThemeColor::Absolute(Color::new(0x44, 0x72, 0xc4)),
                style: BorderLineStyle::Solid,
            };
            s.borders.bottom = BorderStyle {
                width: 3,
                color: ThemeColor::Absolute(Color::new(0x44, 0x72, 0xc4)),
                style: BorderLineStyle::Double,
            };
            s
        },
    );

    // --- Number Format ---

    register(
        "Comma",
        "Number Format",
        CellStyle::new().with_number_format(NumberFormat::Custom { format: "#,##0.00".to_string() }),
    );

    register(
        "Comma [0]",
        "Number Format",
        CellStyle::new().with_number_format(NumberFormat::Custom { format: "#,##0".to_string() }),
    );

    register(
        "Currency",
        "Number Format",
        CellStyle::new().with_number_format(NumberFormat::Custom { format: "$#,##0.00".to_string() }),
    );

    register(
        "Currency [0]",
        "Number Format",
        CellStyle::new().with_number_format(NumberFormat::Custom { format: "$#,##0".to_string() }),
    );

    register(
        "Percent",
        "Number Format",
        CellStyle::new().with_number_format(NumberFormat::Percentage { decimal_places: 0 }),
    );

    // --- Themed Accent Styles ---
    struct AccentDef {
        name: &'static str,
        base: Color,
        p20: Color,
        p40: Color,
        p60: Color,
        text20: Color,
        text40: Color,
        text60: Color,
    }

    let accents = [
        AccentDef {
            name: "Accent1",
            base: Color::new(0x44, 0x72, 0xc4),
            p20: Color::new(0xd6, 0xe4, 0xf0),
            p40: Color::new(0xb4, 0xc6, 0xe7),
            p60: Color::new(0x8f, 0xaa, 0xdc),
            text20: Color::new(0x1f, 0x4e, 0x79),
            text40: Color::new(0x1f, 0x4e, 0x79),
            text60: Color::new(0x1f, 0x4e, 0x79),
        },
        AccentDef {
            name: "Accent2",
            base: Color::new(0xed, 0x7d, 0x31),
            p20: Color::new(0xfb, 0xe5, 0xd6),
            p40: Color::new(0xf8, 0xcb, 0xad),
            p60: Color::new(0xf4, 0xb1, 0x83),
            text20: Color::new(0x84, 0x3c, 0x0c),
            text40: Color::new(0x84, 0x3c, 0x0c),
            text60: Color::new(0x84, 0x3c, 0x0c),
        },
        AccentDef {
            name: "Accent3",
            base: Color::new(0xa5, 0xa5, 0xa5),
            p20: Color::new(0xed, 0xed, 0xed),
            p40: Color::new(0xdb, 0xdb, 0xdb),
            p60: Color::new(0xc0, 0xc0, 0xc0),
            text20: Color::new(0x3f, 0x3f, 0x3f),
            text40: Color::new(0x3f, 0x3f, 0x3f),
            text60: Color::new(0x3f, 0x3f, 0x3f),
        },
        AccentDef {
            name: "Accent4",
            base: Color::new(0xff, 0xc0, 0x00),
            p20: Color::new(0xff, 0xf2, 0xcc),
            p40: Color::new(0xff, 0xe6, 0x99),
            p60: Color::new(0xff, 0xd9, 0x66),
            text20: Color::new(0x80, 0x60, 0x00),
            text40: Color::new(0x80, 0x60, 0x00),
            text60: Color::new(0x80, 0x60, 0x00),
        },
        AccentDef {
            name: "Accent5",
            base: Color::new(0x5b, 0x9b, 0xd5),
            p20: Color::new(0xde, 0xea, 0xf6),
            p40: Color::new(0xbd, 0xd7, 0xee),
            p60: Color::new(0x9b, 0xc2, 0xe6),
            text20: Color::new(0x1f, 0x4e, 0x79),
            text40: Color::new(0x1f, 0x4e, 0x79),
            text60: Color::new(0x1f, 0x4e, 0x79),
        },
        AccentDef {
            name: "Accent6",
            base: Color::new(0x70, 0xad, 0x47),
            p20: Color::new(0xe2, 0xef, 0xda),
            p40: Color::new(0xc5, 0xe0, 0xb4),
            p60: Color::new(0xa9, 0xd1, 0x8e),
            text20: Color::new(0x37, 0x56, 0x23),
            text40: Color::new(0x37, 0x56, 0x23),
            text60: Color::new(0x37, 0x56, 0x23),
        },
    ];

    for accent in &accents {
        // 20% tint
        register(
            &format!("20% - {}", accent.name),
            "Themed Cell Styles",
            CellStyle::new()
                .with_text_color(ThemeColor::Absolute(accent.text20))
                .with_background(ThemeColor::Absolute(accent.p20)),
        );
        // 40% tint
        register(
            &format!("40% - {}", accent.name),
            "Themed Cell Styles",
            CellStyle::new()
                .with_text_color(ThemeColor::Absolute(accent.text40))
                .with_background(ThemeColor::Absolute(accent.p40)),
        );
        // 60% tint
        register(
            &format!("60% - {}", accent.name),
            "Themed Cell Styles",
            CellStyle::new()
                .with_text_color(ThemeColor::Absolute(accent.text60))
                .with_background(ThemeColor::Absolute(accent.p60)),
        );
        // Base accent (white text on solid accent)
        register(
            accent.name,
            "Themed Cell Styles",
            CellStyle::new()
                .with_text_color(ThemeColor::Absolute(Color::white()))
                .with_background(ThemeColor::Absolute(accent.base)),
        );
    }
}
