//! FILENAME: tests/test_rich_text.rs
//! Integration tests for rich text functionality (partial formatting, superscript, subscript).

mod common;

use common::TestHarness;
use engine::{Cell, CellValue};
use engine::cell::RichTextRun;
use app_lib::api_types::{RichTextRunData, rich_text_runs_to_data, data_to_rich_text_runs};

// ============================================================================
// RICH TEXT RUN DATA CONVERSION TESTS
// ============================================================================

#[test]
fn test_runs_to_data_plain() {
    let runs = vec![RichTextRun::plain("hello".to_string())];
    let data = rich_text_runs_to_data(&runs);
    assert_eq!(data.len(), 1);
    assert_eq!(data[0].text, "hello");
    assert_eq!(data[0].bold, None);
    assert!(!data[0].superscript);
    assert!(!data[0].subscript);
}

#[test]
fn test_runs_to_data_with_formatting() {
    let runs = vec![
        RichTextRun {
            text: "bold".to_string(),
            bold: Some(true),
            italic: None,
            underline: None,
            strikethrough: None,
            font_size: Some(16),
            font_family: Some("Arial".to_string()),
            color: Some(engine::Color::new(255, 0, 0)),
            superscript: false,
            subscript: false,
        },
        RichTextRun {
            text: "2".to_string(),
            bold: None,
            italic: None,
            underline: None,
            strikethrough: None,
            font_size: None,
            font_family: None,
            color: None,
            superscript: true,
            subscript: false,
        },
    ];
    let data = rich_text_runs_to_data(&runs);
    assert_eq!(data.len(), 2);
    assert_eq!(data[0].bold, Some(true));
    assert_eq!(data[0].font_size, Some(16));
    assert_eq!(data[0].font_family, Some("Arial".to_string()));
    // Color should be converted to CSS hex
    assert!(data[0].color.is_some());
    let color_str = data[0].color.as_ref().unwrap();
    assert!(color_str.starts_with('#'));

    assert!(data[1].superscript);
    assert!(!data[1].subscript);
}

#[test]
fn test_data_to_runs_plain() {
    let data = vec![RichTextRunData {
        text: "world".to_string(),
        bold: None,
        italic: None,
        underline: None,
        strikethrough: None,
        font_size: None,
        font_family: None,
        color: None,
        superscript: false,
        subscript: false,
    }];
    let runs = data_to_rich_text_runs(&data);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].text, "world");
    assert_eq!(runs[0].bold, None);
    assert!(runs[0].color.is_none());
}

#[test]
fn test_data_to_runs_with_color() {
    let data = vec![RichTextRunData {
        text: "red".to_string(),
        bold: None,
        italic: None,
        underline: None,
        strikethrough: None,
        font_size: None,
        font_family: None,
        color: Some("#ff0000".to_string()),
        superscript: false,
        subscript: false,
    }];
    let runs = data_to_rich_text_runs(&data);
    assert_eq!(runs.len(), 1);
    let c = runs[0].color.expect("color should be parsed");
    assert_eq!(c.r, 255);
    assert_eq!(c.g, 0);
    assert_eq!(c.b, 0);
}

#[test]
fn test_roundtrip_runs_to_data_and_back() {
    let original = vec![
        RichTextRun {
            text: "Hello ".to_string(),
            bold: Some(true),
            italic: Some(false),
            underline: None,
            strikethrough: Some(true),
            font_size: Some(12),
            font_family: Some("Calibri".to_string()),
            color: Some(engine::Color::new(0, 128, 255)),
            superscript: false,
            subscript: false,
        },
        RichTextRun {
            text: "World".to_string(),
            bold: None,
            italic: None,
            underline: None,
            strikethrough: None,
            font_size: None,
            font_family: None,
            color: None,
            superscript: false,
            subscript: true,
        },
    ];

    let data = rich_text_runs_to_data(&original);
    let restored = data_to_rich_text_runs(&data);

    assert_eq!(restored.len(), 2);
    assert_eq!(restored[0].text, "Hello ");
    assert_eq!(restored[0].bold, Some(true));
    assert_eq!(restored[0].font_size, Some(12));
    // Color may have slight hex rounding but should match for clean values
    assert!(restored[0].color.is_some());
    assert_eq!(restored[1].text, "World");
    assert!(restored[1].subscript);
    assert_eq!(restored[1].bold, None);
}

// ============================================================================
// CELL RICH TEXT STORAGE TESTS (via TestHarness)
// ============================================================================

#[test]
fn test_set_cell_with_rich_text() {
    let harness = TestHarness::new();

    let mut cell = Cell::new_text("x2".to_string());
    cell.rich_text = Some(vec![
        RichTextRun::plain("x".to_string()),
        RichTextRun {
            text: "2".to_string(),
            superscript: true,
            ..RichTextRun::plain(String::new())
        },
    ]);
    harness.set_cell(0, 0, cell);

    // Verify the cell value is preserved
    let grid = harness.state.grid.lock().unwrap();
    let stored = grid.get_cell(0, 0).expect("cell should exist");
    assert_eq!(stored.value, CellValue::Text("x2".to_string()));
    let rt = stored.rich_text.as_ref().expect("rich_text should be stored");
    assert_eq!(rt.len(), 2);
    assert_eq!(rt[0].text, "x");
    assert!(!rt[0].superscript);
    assert_eq!(rt[1].text, "2");
    assert!(rt[1].superscript);
}

#[test]
fn test_cell_without_rich_text() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_number(42.0));

    let grid = harness.state.grid.lock().unwrap();
    let stored = grid.get_cell(0, 0).unwrap();
    assert!(stored.rich_text.is_none());
}

#[test]
fn test_overwrite_rich_text_with_none() {
    let harness = TestHarness::new();

    // Set cell with rich text
    let mut cell = Cell::new_text("test".to_string());
    cell.rich_text = Some(vec![RichTextRun::plain("test".to_string())]);
    harness.set_cell(0, 0, cell);

    // Overwrite with plain cell (no rich text)
    harness.set_cell(0, 0, Cell::new_text("test".to_string()));

    let grid = harness.state.grid.lock().unwrap();
    let stored = grid.get_cell(0, 0).unwrap();
    assert!(stored.rich_text.is_none());
}

#[test]
fn test_rich_text_multiple_runs_with_mixed_formatting() {
    let harness = TestHarness::new();

    let mut cell = Cell::new_text("H2O is water".to_string());
    cell.rich_text = Some(vec![
        RichTextRun::plain("H".to_string()),
        RichTextRun {
            text: "2".to_string(),
            subscript: true,
            ..RichTextRun::plain(String::new())
        },
        RichTextRun::plain("O is ".to_string()),
        RichTextRun {
            text: "water".to_string(),
            bold: Some(true),
            italic: Some(true),
            ..RichTextRun::plain(String::new())
        },
    ]);
    harness.set_cell(0, 0, cell);

    let grid = harness.state.grid.lock().unwrap();
    let rt = grid.get_cell(0, 0).unwrap().rich_text.as_ref().unwrap();
    assert_eq!(rt.len(), 4);
    assert_eq!(rt[0].text, "H");
    assert!(!rt[0].subscript);
    assert_eq!(rt[1].text, "2");
    assert!(rt[1].subscript);
    assert_eq!(rt[2].text, "O is ");
    assert_eq!(rt[3].text, "water");
    assert_eq!(rt[3].bold, Some(true));
    assert_eq!(rt[3].italic, Some(true));
}

// ============================================================================
// RICH TEXT RUN DATA SERIALIZATION (JSON over Tauri bridge)
// ============================================================================

#[test]
fn test_rich_text_run_data_json_roundtrip() {
    let data = RichTextRunData {
        text: "superscript".to_string(),
        bold: Some(true),
        italic: None,
        underline: None,
        strikethrough: None,
        font_size: Some(10),
        font_family: None,
        color: Some("#00ff00".to_string()),
        superscript: true,
        subscript: false,
    };

    let json = serde_json::to_string(&data).unwrap();
    let restored: RichTextRunData = serde_json::from_str(&json).unwrap();

    assert_eq!(restored.text, "superscript");
    assert_eq!(restored.bold, Some(true));
    assert_eq!(restored.font_size, Some(10));
    assert_eq!(restored.color, Some("#00ff00".to_string()));
    assert!(restored.superscript);
    assert!(!restored.subscript);
}

#[test]
fn test_rich_text_run_data_empty_color() {
    let data = vec![RichTextRunData {
        text: "no color".to_string(),
        bold: None,
        italic: None,
        underline: None,
        strikethrough: None,
        font_size: None,
        font_family: None,
        color: None,
        superscript: false,
        subscript: false,
    }];

    let runs = data_to_rich_text_runs(&data);
    assert!(runs[0].color.is_none());

    let back = rich_text_runs_to_data(&runs);
    assert!(back[0].color.is_none());
}

#[test]
fn test_superscript_and_subscript_mutually_stored() {
    // Both can technically be set, though UI prevents it
    let run = RichTextRun {
        text: "both".to_string(),
        bold: None,
        italic: None,
        underline: None,
        strikethrough: None,
        font_size: None,
        font_family: None,
        color: None,
        superscript: true,
        subscript: true,
    };

    let data = rich_text_runs_to_data(&[run]);
    assert!(data[0].superscript);
    assert!(data[0].subscript);

    let restored = data_to_rich_text_runs(&data);
    assert!(restored[0].superscript);
    assert!(restored[0].subscript);
}
