//! FILENAME: tests/test_styles.rs
//! Integration tests for style commands (formatting, colors, fonts).

mod common;

use app_lib::{format_cell_value, StyleData};
use common::TestHarness;
use engine::{Cell, CellStyle, CellValue, Color, NumberFormat, TextAlign, VerticalAlign};

// ============================================================================
// STYLE REGISTRY TESTS
// ============================================================================

#[test]
fn test_default_style() {
    let harness = TestHarness::new();
    let styles = harness.state.style_registry.lock().unwrap();

    // Default style at index 0
    let default_style = styles.get(0);
    assert!(matches!(default_style.number_format, NumberFormat::General));
}

#[test]
fn test_get_all_styles() {
    let harness = TestHarness::new();
    let styles = harness.state.style_registry.lock().unwrap();

    let all_styles = styles.all_styles();
    assert!(!all_styles.is_empty()); // At least default style
}

#[test]
fn test_register_new_style() {
    let harness = TestHarness::new();

    let new_index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let bold_style = CellStyle::new().with_bold(true);
        styles.get_or_create(bold_style)
    };

    assert!(new_index > 0); // Should be a new style, not default
}

#[test]
fn test_style_deduplication() {
    let harness = TestHarness::new();

    let (index1, index2) = {
        let mut styles = harness.state.style_registry.lock().unwrap();

        let bold_style1 = CellStyle::new().with_bold(true);
        let bold_style2 = CellStyle::new().with_bold(true);

        let idx1 = styles.get_or_create(bold_style1);
        let idx2 = styles.get_or_create(bold_style2);

        (idx1, idx2)
    };

    // Same style should return same index
    assert_eq!(index1, index2);
}

#[test]
fn test_different_styles_different_indices() {
    let harness = TestHarness::new();

    let (bold_idx, italic_idx) = {
        let mut styles = harness.state.style_registry.lock().unwrap();

        let bold_style = CellStyle::new().with_bold(true);
        let italic_style = CellStyle::new().with_italic(true);

        let idx1 = styles.get_or_create(bold_style);
        let idx2 = styles.get_or_create(italic_style);

        (idx1, idx2)
    };

    assert_ne!(bold_idx, italic_idx);
}

// ============================================================================
// NUMBER FORMAT TESTS
// ============================================================================

#[test]
fn test_format_number_general() {
    let style = CellStyle::new();
    let formatted = format_cell_value(&CellValue::Number(42.0), &style);
    assert_eq!(formatted, "42");
}

#[test]
fn test_format_number_decimal() {
    let style = CellStyle::new();
    let formatted = format_cell_value(&CellValue::Number(3.14159), &style);
    assert!(formatted.starts_with("3.14"));
}

#[test]
fn test_format_number_currency() {
    let style = CellStyle::new().with_number_format(NumberFormat::Currency {
        decimal_places: 2,
        symbol: "$".to_string(),
        symbol_position: engine::CurrencyPosition::Before,
    });

    let formatted = format_cell_value(&CellValue::Number(1234.56), &style);
    assert!(formatted.contains("$"));
    assert!(formatted.contains("1,234.56") || formatted.contains("1234.56"));
}

#[test]
fn test_format_number_percentage() {
    let style = CellStyle::new().with_number_format(NumberFormat::Percentage {
        decimal_places: 1,
    });

    let formatted = format_cell_value(&CellValue::Number(0.5), &style);
    assert!(formatted.contains("50"));
    assert!(formatted.contains("%"));
}

#[test]
fn test_format_number_scientific() {
    let style = CellStyle::new().with_number_format(NumberFormat::Scientific {
        decimal_places: 2,
    });

    let formatted = format_cell_value(&CellValue::Number(1234567.0), &style);
    // Should contain exponent notation
    assert!(formatted.contains("E") || formatted.contains("e"));
}

// ============================================================================
// TEXT ALIGNMENT TESTS
// ============================================================================

#[test]
fn test_text_align_left() {
    let harness = TestHarness::new();

    let index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_text_align(TextAlign::Left);
        styles.get_or_create(style)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    let style = styles.get(index);
    assert!(matches!(style.text_align, TextAlign::Left));
}

#[test]
fn test_text_align_center() {
    let harness = TestHarness::new();

    let index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_text_align(TextAlign::Center);
        styles.get_or_create(style)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    let style = styles.get(index);
    assert!(matches!(style.text_align, TextAlign::Center));
}

#[test]
fn test_text_align_right() {
    let harness = TestHarness::new();

    let index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_text_align(TextAlign::Right);
        styles.get_or_create(style)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    let style = styles.get(index);
    assert!(matches!(style.text_align, TextAlign::Right));
}

#[test]
fn test_vertical_align() {
    let harness = TestHarness::new();

    let (top_idx, middle_idx, bottom_idx) = {
        let mut styles = harness.state.style_registry.lock().unwrap();

        let top = styles.get_or_create(CellStyle::new().with_vertical_align(VerticalAlign::Top));
        let middle = styles.get_or_create(CellStyle::new().with_vertical_align(VerticalAlign::Middle));
        let bottom = styles.get_or_create(CellStyle::new().with_vertical_align(VerticalAlign::Bottom));

        (top, middle, bottom)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    assert!(matches!(styles.get(top_idx).vertical_align, VerticalAlign::Top));
    assert!(matches!(styles.get(middle_idx).vertical_align, VerticalAlign::Middle));
    assert!(matches!(styles.get(bottom_idx).vertical_align, VerticalAlign::Bottom));
}

// ============================================================================
// FONT STYLE TESTS
// ============================================================================

#[test]
fn test_bold_style() {
    let harness = TestHarness::new();

    let index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_bold(true);
        styles.get_or_create(style)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    let style = styles.get(index);
    assert!(style.font.bold);
}

#[test]
fn test_italic_style() {
    let harness = TestHarness::new();

    let index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_italic(true);
        styles.get_or_create(style)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    let style = styles.get(index);
    assert!(style.font.italic);
}

#[test]
fn test_underline_style() {
    let harness = TestHarness::new();

    let index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_underline(true);
        styles.get_or_create(style)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    let style = styles.get(index);
    assert!(style.font.underline);
}

#[test]
fn test_strikethrough_style() {
    let harness = TestHarness::new();

    let index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_strikethrough(true);
        styles.get_or_create(style)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    let style = styles.get(index);
    assert!(style.font.strikethrough);
}

#[test]
fn test_combined_font_styles() {
    let harness = TestHarness::new();

    let index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let style = CellStyle::new()
            .with_bold(true)
            .with_italic(true)
            .with_underline(true);
        styles.get_or_create(style)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    let style = styles.get(index);
    assert!(style.font.bold);
    assert!(style.font.italic);
    assert!(style.font.underline);
}

// ============================================================================
// COLOR TESTS
// ============================================================================

#[test]
fn test_text_color() {
    let harness = TestHarness::new();
    let red = Color { r: 255, g: 0, b: 0, a: 255 };

    let index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_text_color(red);
        styles.get_or_create(style)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    let style = styles.get(index);

    assert_eq!(style.font.color.r, 255);
    assert_eq!(style.font.color.g, 0);
    assert_eq!(style.font.color.b, 0);
}

#[test]
fn test_background_color() {
    let harness = TestHarness::new();
    let yellow = Color { r: 255, g: 255, b: 0, a: 255 };

    let index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_background(yellow);
        styles.get_or_create(style)
    };

    let styles = harness.state.style_registry.lock().unwrap();
    let style = styles.get(index);

    assert_eq!(style.background.r, 255);
    assert_eq!(style.background.g, 255);
    assert_eq!(style.background.b, 0);
}

// ============================================================================
// CELL STYLE APPLICATION TESTS
// ============================================================================

#[test]
fn test_apply_style_to_cell() {
    let harness = TestHarness::new();

    // Create a bold style
    let bold_index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        styles.get_or_create(CellStyle::new().with_bold(true))
    };

    // Set cell with value
    harness.set_cell(0, 0, Cell::new_number(42.0));

    // Apply style
    {
        let mut grid = harness.state.grid.lock().unwrap();
        if let Some(cell) = grid.get_cell(0, 0) {
            let mut updated = cell.clone();
            updated.style_index = bold_index;
            grid.set_cell(0, 0, updated);
        }
    }

    // Verify
    let grid = harness.state.grid.lock().unwrap();
    if let Some(cell) = grid.get_cell(0, 0) {
        assert_eq!(cell.style_index, bold_index);
    } else {
        panic!("Cell should exist");
    }
}

#[test]
fn test_apply_style_to_range() {
    let harness = TestHarness::with_sample_data();

    // Create a header style (bold + centered)
    let header_index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        styles.get_or_create(
            CellStyle::new()
                .with_bold(true)
                .with_text_align(TextAlign::Center)
        )
    };

    // Apply to header row (row 0, columns 0-4)
    {
        let mut grid = harness.state.grid.lock().unwrap();
        for col in 0..5 {
            if let Some(cell) = grid.get_cell(0, col) {
                let mut updated = cell.clone();
                updated.style_index = header_index;
                grid.set_cell(0, col, updated);
            }
        }
    }

    // Verify all header cells have the style
    let grid = harness.state.grid.lock().unwrap();
    for col in 0..5 {
        if let Some(cell) = grid.get_cell(0, col) {
            assert_eq!(cell.style_index, header_index);
        }
    }
}

// ============================================================================
// STYLE COUNT TESTS
// ============================================================================

#[test]
fn test_style_count() {
    let harness = TestHarness::new();

    // Start with default style
    {
        let styles = harness.state.style_registry.lock().unwrap();
        assert!(styles.all_styles().len() >= 1);
    }

    // Add some styles
    {
        let mut styles = harness.state.style_registry.lock().unwrap();
        styles.get_or_create(CellStyle::new().with_bold(true));
        styles.get_or_create(CellStyle::new().with_italic(true));
        styles.get_or_create(CellStyle::new().with_underline(true));
    }

    let styles = harness.state.style_registry.lock().unwrap();
    assert!(styles.all_styles().len() >= 4); // Default + 3 new ones
}

// ============================================================================
// EDGE CASES
// ============================================================================

#[test]
fn test_style_for_nonexistent_cell() {
    let harness = TestHarness::new();
    let grid = harness.state.grid.lock().unwrap();

    // Getting cell that doesn't exist should return None
    let cell = grid.get_cell(999, 999);
    assert!(cell.is_none());
}

#[test]
fn test_default_style_index() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_number(100.0));

    let grid = harness.state.grid.lock().unwrap();
    if let Some(cell) = grid.get_cell(0, 0) {
        // New cells should have default style (index 0)
        assert_eq!(cell.style_index, 0);
    }
}

#[test]
fn test_preserve_style_on_value_update() {
    let harness = TestHarness::new();

    // Create and apply style
    let bold_index = {
        let mut styles = harness.state.style_registry.lock().unwrap();
        styles.get_or_create(CellStyle::new().with_bold(true))
    };

    {
        let mut grid = harness.state.grid.lock().unwrap();
        let mut cell = Cell::new_number(100.0);
        cell.style_index = bold_index;
        grid.set_cell(0, 0, cell);
    }

    // Update value but preserve style
    {
        let mut grid = harness.state.grid.lock().unwrap();
        if let Some(cell) = grid.get_cell(0, 0) {
            let mut updated = cell.clone();
            updated.value = CellValue::Number(200.0);
            // Keep style_index the same
            grid.set_cell(0, 0, updated);
        }
    }

    // Verify style is preserved
    let grid = harness.state.grid.lock().unwrap();
    if let Some(cell) = grid.get_cell(0, 0) {
        assert_eq!(cell.style_index, bold_index);
        assert!(matches!(cell.value, CellValue::Number(n) if (n - 200.0).abs() < 0.001));
    }
}
