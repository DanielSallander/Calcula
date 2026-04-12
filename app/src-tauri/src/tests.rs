//! FILENAME: app/src-tauri/src/tests.rs
#[cfg(test)]
use super::*;
use crate::pivot::utils::{
    col_index_to_letter, parse_cell_ref, parse_range, strip_sheet_prefix,
};
use engine::{Cell, CellError, CellStyle, CellValue, Grid, NumberFormat};
use std::collections::{HashMap, HashSet};

#[test]
fn test_format_number_integer() {
    assert_eq!(format_number_simple(42.0), "42");
    assert_eq!(format_number_simple(0.0), "0");
    assert_eq!(format_number_simple(-100.0), "-100");
}

#[test]
fn test_format_number_decimal() {
    assert_eq!(format_number_simple(3.14), "3.14");
    assert_eq!(format_number_simple(0.5), "0.5");
    assert_eq!(format_number_simple(1.100), "1.1");
}

#[test]
fn test_format_cell_value() {
    let default_style = CellStyle::new();
    let locale = engine::LocaleSettings::invariant();
    assert_eq!(format_cell_value(&CellValue::Empty, &default_style, &locale), "");
    assert_eq!(
        format_cell_value(&CellValue::Number(42.0), &default_style, &locale),
        "42"
    );
    assert_eq!(
        format_cell_value(&CellValue::Text("Hello".to_string()), &default_style, &locale),
        "Hello"
    );
    assert_eq!(
        format_cell_value(&CellValue::Boolean(true), &default_style, &locale),
        "TRUE"
    );
    assert_eq!(
        format_cell_value(&CellValue::Boolean(false), &default_style, &locale),
        "FALSE"
    );
}

#[test]
fn test_format_cell_value_with_style() {
    let locale = engine::LocaleSettings::invariant();
    // Test currency formatting
    let currency_style = CellStyle::new().with_number_format(NumberFormat::Currency {
        decimal_places: 2,
        symbol: "$".to_string(),
        symbol_position: engine::CurrencyPosition::Before,
    });
    assert_eq!(
        format_cell_value(&CellValue::Number(1234.56), &currency_style, &locale),
        "$1,234.56"
    );

    // Test percentage formatting
    let percentage_style =
        CellStyle::new().with_number_format(NumberFormat::Percentage { decimal_places: 1 });
    assert_eq!(
        format_cell_value(&CellValue::Number(0.5), &percentage_style, &locale),
        "50.0%"
    );
}

#[test]
fn test_parse_number() {
    let locale = engine::LocaleSettings::invariant();
    assert_eq!(parse_number("42", &locale), Some(42.0));
    assert_eq!(parse_number("3.14", &locale), Some(3.14));
    assert_eq!(parse_number("-100", &locale), Some(-100.0));
    assert_eq!(parse_number("50%", &locale), Some(0.5));
    assert_eq!(parse_number("1,000", &locale), Some(1000.0));
    assert_eq!(parse_number("1,234.56", &locale), Some(1234.56));
    assert_eq!(parse_number("hello", &locale), None);
    assert_eq!(parse_number("", &locale), None);
}

#[test]
fn test_parse_cell_input() {
    let locale = engine::LocaleSettings::invariant();
    // Empty
    let cell = parse_cell_input("", &locale);
    assert!(matches!(cell.value, CellValue::Empty));

    // Number
    let cell = parse_cell_input("42", &locale);
    assert!(matches!(cell.value, CellValue::Number(n) if n == 42.0));

    // Text
    let cell = parse_cell_input("Hello", &locale);
    assert!(matches!(cell.value, CellValue::Text(ref s) if s == "Hello"));

    // Boolean
    let cell = parse_cell_input("TRUE", &locale);
    assert!(matches!(cell.value, CellValue::Boolean(true)));

    let cell = parse_cell_input("false", &locale);
    assert!(matches!(cell.value, CellValue::Boolean(false)));

    // Formula (value is Empty until evaluated)
    let cell = parse_cell_input("=A1+B1", &locale);
    assert_eq!(cell.formula, Some("=A1+B1".to_string()));

    // Percentage
    let cell = parse_cell_input("50%", &locale);
    assert!(matches!(cell.value, CellValue::Number(n) if (n - 0.5).abs() < 0.001));
}

#[test]
fn test_evaluate_formula_simple() {
    let grid = Grid::new();

    // Test simple arithmetic: =1+2
    let result = evaluate_formula(&grid, "=1+2");
    assert!(matches!(result, CellValue::Number(n) if (n - 3.0).abs() < 0.001));

    // Test more complex: =10*5+2
    let result = evaluate_formula(&grid, "=10*5+2");
    assert!(matches!(result, CellValue::Number(n) if (n - 52.0).abs() < 0.001));

    // Test with parentheses: =(1+2)*3
    let result = evaluate_formula(&grid, "=(1+2)*3");
    assert!(matches!(result, CellValue::Number(n) if (n - 9.0).abs() < 0.001));
}

#[test]
fn test_evaluate_formula_with_cells() {
    let mut grid = Grid::new();
    grid.set_cell(0, 0, Cell::new_number(10.0)); // A1 = 10
    grid.set_cell(1, 0, Cell::new_number(20.0)); // A2 = 20

    // Test cell reference: =A1+A2
    let result = evaluate_formula(&grid, "=A1+A2");
    assert!(matches!(result, CellValue::Number(n) if (n - 30.0).abs() < 0.001));
}

#[test]
fn test_evaluate_formula_functions() {
    let mut grid = Grid::new();
    grid.set_cell(0, 0, Cell::new_number(10.0)); // A1 = 10
    grid.set_cell(1, 0, Cell::new_number(20.0)); // A2 = 20
    grid.set_cell(2, 0, Cell::new_number(30.0)); // A3 = 30

    // Test SUM function
    let result = evaluate_formula(&grid, "=SUM(A1:A3)");
    assert!(matches!(result, CellValue::Number(n) if (n - 60.0).abs() < 0.001));

    // Test AVERAGE function
    let result = evaluate_formula(&grid, "=AVERAGE(A1:A3)");
    assert!(matches!(result, CellValue::Number(n) if (n - 20.0).abs() < 0.001));
}

#[test]
fn test_evaluate_formula_column_ref() {
    let mut grid = Grid::new();
    grid.set_cell(0, 0, Cell::new_number(10.0)); // A1 = 10
    grid.set_cell(1, 0, Cell::new_number(20.0)); // A2 = 20
    grid.set_cell(2, 0, Cell::new_number(30.0)); // A3 = 30

    // Test SUM with column reference
    let result = evaluate_formula(&grid, "=SUM(A:A)");
    assert!(matches!(result, CellValue::Number(n) if (n - 60.0).abs() < 0.001));
}

#[test]
fn test_evaluate_formula_error() {
    let grid = Grid::new();

    // Test division by zero
    let result = evaluate_formula(&grid, "=1/0");
    assert!(matches!(result, CellValue::Error(CellError::Div0)));
}

#[test]
fn test_col_letter_to_index() {
    assert_eq!(col_letter_to_index("A"), 0);
    assert_eq!(col_letter_to_index("B"), 1);
    assert_eq!(col_letter_to_index("Z"), 25);
    assert_eq!(col_letter_to_index("AA"), 26);
    assert_eq!(col_letter_to_index("AB"), 27);
    assert_eq!(col_letter_to_index("AZ"), 51);
    assert_eq!(col_letter_to_index("BA"), 52);
}

#[test]
fn test_dependency_tracking() {
    let mut dependencies: HashMap<(u32, u32), HashSet<(u32, u32)>> = HashMap::new();
    let mut dependents: HashMap<(u32, u32), HashSet<(u32, u32)>> = HashMap::new();

    // Cell B1 (0, 1) references A1 (0, 0)
    let mut refs = HashSet::new();
    refs.insert((0, 0));
    update_dependencies((0, 1), refs, &mut dependencies, &mut dependents);

    // Check that A1 has B1 as a dependent
    assert!(dependents.get(&(0, 0)).unwrap().contains(&(0, 1)));

    // Check that B1 has A1 as a dependency
    assert!(dependencies.get(&(0, 1)).unwrap().contains(&(0, 0)));

    // Now update B1 to reference A2 instead
    let mut new_refs = HashSet::new();
    new_refs.insert((1, 0));
    update_dependencies((0, 1), new_refs, &mut dependencies, &mut dependents);

    // Check that A1 no longer has B1 as a dependent
    assert!(
        dependents.get(&(0, 0)).is_none()
            || !dependents.get(&(0, 0)).unwrap().contains(&(0, 1))
    );

    // Check that A2 now has B1 as a dependent
    assert!(dependents.get(&(1, 0)).unwrap().contains(&(0, 1)));
}

// ============================================================================
// PIVOT COMMANDS TESTS
// ============================================================================

#[test]
fn test_pivot_parse_cell_ref() {
    assert_eq!(parse_cell_ref("A1").unwrap(), (0, 0));
    assert_eq!(parse_cell_ref("B2").unwrap(), (1, 1));
    assert_eq!(parse_cell_ref("Z26").unwrap(), (25, 25));
    assert_eq!(parse_cell_ref("AA1").unwrap(), (0, 26));
    assert_eq!(parse_cell_ref("a1").unwrap(), (0, 0)); // case insensitive
}

#[test]
fn test_pivot_parse_cell_ref_with_sheet_prefix() {
    assert_eq!(parse_cell_ref("Sheet1!A1").unwrap(), (0, 0));
    assert_eq!(parse_cell_ref("Sheet1!B2").unwrap(), (1, 1));
    assert_eq!(parse_cell_ref("'My Sheet'!C3").unwrap(), (2, 2));
}

#[test]
fn test_pivot_parse_range() {
    let ((sr, sc), (er, ec)) = parse_range("A1:D10").unwrap();
    assert_eq!((sr, sc), (0, 0));
    assert_eq!((er, ec), (9, 3));

    // Reversed range should normalize
    let ((sr, sc), (er, ec)) = parse_range("D10:A1").unwrap();
    assert_eq!((sr, sc), (0, 0));
    assert_eq!((er, ec), (9, 3));
}

#[test]
fn test_pivot_parse_range_with_sheet_prefix() {
    let ((sr, sc), (er, ec)) = parse_range("Sheet1!B2:C5").unwrap();
    assert_eq!((sr, sc), (1, 1));
    assert_eq!((er, ec), (4, 2));
}

#[test]
fn test_pivot_col_index_to_letter() {
    assert_eq!(col_index_to_letter(0), "A");
    assert_eq!(col_index_to_letter(25), "Z");
    assert_eq!(col_index_to_letter(26), "AA");
    assert_eq!(col_index_to_letter(27), "AB");
}

#[test]
fn test_pivot_strip_sheet_prefix() {
    assert_eq!(strip_sheet_prefix("A1"), "A1");
    assert_eq!(strip_sheet_prefix("Sheet1!A1"), "A1");
    assert_eq!(strip_sheet_prefix("'Sheet Name'!B2"), "B2");
    assert_eq!(strip_sheet_prefix("Sheet1!A1:D10"), "A1:D10");
}

// ============================================================================
// SPLIT WINDOW TESTS
// ============================================================================

#[test]
fn test_split_config_default() {
    let config = sheets::SplitConfig::default();
    assert!(config.split_row.is_none());
    assert!(config.split_col.is_none());
}

#[test]
fn test_split_config_set_and_get() {
    let state = create_app_state();

    // Initially no split
    {
        let configs = state.split_configs.lock().unwrap();
        let config = configs.get(0).unwrap();
        assert!(config.split_row.is_none());
        assert!(config.split_col.is_none());
    }

    // Set a split at row 5, col 3
    {
        let active_sheet = *state.active_sheet.lock().unwrap();
        let mut configs = state.split_configs.lock().unwrap();
        configs[active_sheet] = sheets::SplitConfig {
            split_row: Some(5),
            split_col: Some(3),
        };
    }

    // Verify it was stored
    {
        let configs = state.split_configs.lock().unwrap();
        let config = configs.get(0).unwrap();
        assert_eq!(config.split_row, Some(5));
        assert_eq!(config.split_col, Some(3));
    }
}

#[test]
fn test_split_config_remove() {
    let state = create_app_state();

    // Set a split
    {
        let mut configs = state.split_configs.lock().unwrap();
        configs[0] = sheets::SplitConfig {
            split_row: Some(10),
            split_col: Some(5),
        };
    }

    // Remove the split (set to default)
    {
        let mut configs = state.split_configs.lock().unwrap();
        configs[0] = sheets::SplitConfig::default();
    }

    // Verify it was cleared
    {
        let configs = state.split_configs.lock().unwrap();
        let config = configs.get(0).unwrap();
        assert!(config.split_row.is_none());
        assert!(config.split_col.is_none());
    }
}

#[test]
fn test_split_config_per_sheet() {
    let state = create_app_state();

    // Add a second sheet's split config
    {
        let mut configs = state.split_configs.lock().unwrap();
        configs.push(sheets::SplitConfig {
            split_row: Some(8),
            split_col: Some(4),
        });
    }

    // Sheet 0 should have no split, sheet 1 should have split
    {
        let configs = state.split_configs.lock().unwrap();
        assert!(configs[0].split_row.is_none());
        assert_eq!(configs[1].split_row, Some(8));
        assert_eq!(configs[1].split_col, Some(4));
    }
}

#[test]
fn test_split_config_row_only() {
    let config = sheets::SplitConfig {
        split_row: Some(5),
        split_col: None,
    };
    assert_eq!(config.split_row, Some(5));
    assert!(config.split_col.is_none());
}

#[test]
fn test_split_config_col_only() {
    let config = sheets::SplitConfig {
        split_row: None,
        split_col: Some(3),
    };
    assert!(config.split_row.is_none());
    assert_eq!(config.split_col, Some(3));
}

// ============================================================================
// GO TO SPECIAL TESTS
// ============================================================================

/// Helper: run go_to_special logic against an AppState directly.
/// Replicates the Tauri command logic without needing State<> wrapper.
fn run_go_to_special(
    state: &AppState,
    criteria: &str,
    search_range: Option<(u32, u32, u32, u32)>,
) -> Vec<(u32, u32)> {
    let grid = state.grid.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let (sr, sc, er, ec) = search_range.unwrap_or((0, 0, grid.max_row, grid.max_col));

    let mut cells = Vec::new();

    match criteria {
        "blanks" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let is_blank = grid.get_cell(row, col)
                        .map(|cell| cell.formula.is_none() && matches!(cell.value, CellValue::Empty))
                        .unwrap_or(true);
                    if is_blank {
                        cells.push((row, col));
                    }
                }
            }
        }
        "formulas" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let has_formula = grid.get_cell(row, col)
                        .map(|cell| cell.formula.is_some())
                        .unwrap_or(false);
                    if has_formula {
                        cells.push((row, col));
                    }
                }
            }
        }
        "constants" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let is_constant = grid.get_cell(row, col)
                        .map(|cell| cell.formula.is_none() && !matches!(cell.value, CellValue::Empty))
                        .unwrap_or(false);
                    if is_constant {
                        cells.push((row, col));
                    }
                }
            }
        }
        "errors" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let is_error = grid.get_cell(row, col)
                        .map(|cell| matches!(cell.value, CellValue::Error(_)))
                        .unwrap_or(false);
                    if is_error {
                        cells.push((row, col));
                    }
                }
            }
        }
        "comments" => {
            let comments = state.comments.lock().unwrap();
            if let Some(sheet_comments) = comments.get(&active_sheet) {
                for (&(row, col), _) in sheet_comments {
                    if row >= sr && row <= er && col >= sc && col <= ec {
                        cells.push((row, col));
                    }
                }
            }
        }
        "notes" => {
            let notes = state.notes.lock().unwrap();
            if let Some(sheet_notes) = notes.get(&active_sheet) {
                for (&(row, col), _) in sheet_notes {
                    if row >= sr && row <= er && col >= sc && col <= ec {
                        cells.push((row, col));
                    }
                }
            }
        }
        "dataValidation" => {
            let validations = state.data_validations.lock().unwrap();
            if let Some(sheet_validations) = validations.get(&active_sheet) {
                let mut cell_set = std::collections::HashSet::new();
                for vr in sheet_validations {
                    for row in vr.start_row..=vr.end_row {
                        for col in vr.start_col..=vr.end_col {
                            if row >= sr && row <= er && col >= sc && col <= ec {
                                cell_set.insert((row, col));
                            }
                        }
                    }
                }
                for (row, col) in cell_set {
                    cells.push((row, col));
                }
            }
        }
        _ => {}
    }

    cells.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    cells
}

#[test]
fn test_go_to_special_blanks() {
    let state = create_app_state();

    // Set up a small grid: A1=10, A2=empty, A3="hello", B1=empty, B2=20
    {
        let mut grid = state.grid.lock().unwrap();
        grid.set_cell(0, 0, Cell::new_number(10.0));
        // (1, 0) is empty
        grid.set_cell(2, 0, Cell::new_text("hello".to_string()));
        // (0, 1) is empty
        grid.set_cell(1, 1, Cell::new_number(20.0));
    }

    // Search within A1:B3 (rows 0-2, cols 0-1) for blanks
    let blanks = run_go_to_special(&state, "blanks", Some((0, 0, 2, 1)));
    assert!(blanks.contains(&(0, 1))); // B1 is blank
    assert!(blanks.contains(&(1, 0))); // A2 is blank
    assert!(blanks.contains(&(2, 1))); // B3 is blank
    assert!(!blanks.contains(&(0, 0))); // A1 has value
    assert!(!blanks.contains(&(1, 1))); // B2 has value
    assert_eq!(blanks.len(), 3);
}

#[test]
fn test_go_to_special_formulas() {
    let state = create_app_state();

    {
        let mut grid = state.grid.lock().unwrap();
        grid.set_cell(0, 0, Cell::new_number(10.0)); // constant
        let mut formula_cell = Cell::new_number(30.0);
        formula_cell.formula = Some("=A1+20".to_string());
        grid.set_cell(0, 1, formula_cell); // formula
        grid.set_cell(1, 0, Cell::new_text("text".to_string())); // constant
    }

    let formulas = run_go_to_special(&state, "formulas", Some((0, 0, 1, 1)));
    assert_eq!(formulas, vec![(0, 1)]); // Only B1 has a formula
}

#[test]
fn test_go_to_special_constants() {
    let state = create_app_state();

    {
        let mut grid = state.grid.lock().unwrap();
        grid.set_cell(0, 0, Cell::new_number(10.0)); // constant
        let mut formula_cell = Cell::new_number(30.0);
        formula_cell.formula = Some("=10+20".to_string());
        grid.set_cell(0, 1, formula_cell); // formula (not a constant)
        grid.set_cell(1, 0, Cell::new_text("hello".to_string())); // constant
        // (1, 1) is empty
    }

    let constants = run_go_to_special(&state, "constants", Some((0, 0, 1, 1)));
    assert_eq!(constants, vec![(0, 0), (1, 0)]); // A1 and A2
}

#[test]
fn test_go_to_special_errors() {
    let state = create_app_state();

    {
        let mut grid = state.grid.lock().unwrap();
        grid.set_cell(0, 0, Cell::new_number(10.0));
        grid.set_cell(0, 1, Cell { value: CellValue::Error(CellError::Div0), formula: Some("=1/0".to_string()), ..Cell::default() });
        grid.set_cell(1, 0, Cell { value: CellValue::Error(CellError::Value), formula: None, ..Cell::default() });
        grid.set_cell(1, 1, Cell::new_text("ok".to_string()));
    }

    let errors = run_go_to_special(&state, "errors", Some((0, 0, 1, 1)));
    assert_eq!(errors, vec![(0, 1), (1, 0)]); // B1 (#DIV/0!) and A2 (#VALUE!)
}

#[test]
fn test_go_to_special_comments() {
    let state = create_app_state();

    // Insert comments for sheet 0
    {
        let mut comments = state.comments.lock().unwrap();
        let mut sheet_comments = HashMap::new();
        sheet_comments.insert((0, 0), comments::Comment {
            id: "c1".to_string(),
            row: 0,
            col: 0,
            sheet_index: 0,
            author_email: "test@test.com".to_string(),
            author_name: "Test".to_string(),
            content: "comment 1".to_string(),
            rich_content: None,
            content_type: comments::CommentContentType::Plain,
            mentions: Vec::new(),
            resolved: false,
            replies: Vec::new(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            modified_at: None,
        });
        sheet_comments.insert((2, 3), comments::Comment {
            id: "c2".to_string(),
            row: 2,
            col: 3,
            sheet_index: 0,
            author_email: "test@test.com".to_string(),
            author_name: "Test".to_string(),
            content: "comment 2".to_string(),
            rich_content: None,
            content_type: comments::CommentContentType::Plain,
            mentions: Vec::new(),
            resolved: false,
            replies: Vec::new(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            modified_at: None,
        });
        comments.insert(0, sheet_comments);
    }

    // Search entire used area
    let result = run_go_to_special(&state, "comments", Some((0, 0, 5, 5)));
    assert_eq!(result.len(), 2);
    assert!(result.contains(&(0, 0)));
    assert!(result.contains(&(2, 3)));
}

#[test]
fn test_go_to_special_notes() {
    let state = create_app_state();

    {
        let mut notes = state.notes.lock().unwrap();
        let mut sheet_notes = HashMap::new();
        sheet_notes.insert((1, 1), notes::Note {
            id: "n1".to_string(),
            row: 1,
            col: 1,
            sheet_index: 0,
            author_name: "Test".to_string(),
            content: "A note".to_string(),
            rich_content: None,
            width: 200.0,
            height: 100.0,
            visible: false,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            modified_at: None,
        });
        notes.insert(0, sheet_notes);
    }

    let result = run_go_to_special(&state, "notes", Some((0, 0, 5, 5)));
    assert_eq!(result, vec![(1, 1)]);
}

#[test]
fn test_go_to_special_data_validation() {
    let state = create_app_state();

    {
        let mut validations = state.data_validations.lock().unwrap();
        validations.insert(0, vec![
            data_validation::ValidationRange {
                start_row: 1,
                start_col: 0,
                end_row: 3,
                end_col: 0,
                validation: data_validation::DataValidation::default(),
            },
        ]);
    }

    let result = run_go_to_special(&state, "dataValidation", Some((0, 0, 5, 5)));
    assert_eq!(result, vec![(1, 0), (2, 0), (3, 0)]);
}

#[test]
fn test_go_to_special_with_search_range_filter() {
    let state = create_app_state();

    {
        let mut grid = state.grid.lock().unwrap();
        grid.set_cell(0, 0, Cell::new_number(1.0));
        grid.set_cell(5, 5, Cell::new_number(2.0));
        grid.set_cell(10, 10, Cell::new_number(3.0));
    }

    // Search only within a small range - should only find constants in that range
    let constants = run_go_to_special(&state, "constants", Some((0, 0, 3, 3)));
    assert_eq!(constants, vec![(0, 0)]); // Only A1 is within range

    let constants = run_go_to_special(&state, "constants", Some((4, 4, 6, 6)));
    assert_eq!(constants, vec![(5, 5)]); // Only F6 is within range
}

#[test]
fn test_go_to_special_unknown_criteria() {
    let state = create_app_state();

    // Unknown criteria returns empty
    let result = run_go_to_special(&state, "unknown_criteria", Some((0, 0, 5, 5)));
    assert!(result.is_empty());
}

#[test]
fn test_go_to_special_empty_grid() {
    let state = create_app_state();

    // All cells in range are blank on empty grid
    let blanks = run_go_to_special(&state, "blanks", Some((0, 0, 2, 2)));
    assert_eq!(blanks.len(), 9); // 3x3 grid, all blank

    // No formulas, constants, or errors on empty grid
    let formulas = run_go_to_special(&state, "formulas", Some((0, 0, 2, 2)));
    assert!(formulas.is_empty());

    let constants = run_go_to_special(&state, "constants", Some((0, 0, 2, 2)));
    assert!(constants.is_empty());

    let errors = run_go_to_special(&state, "errors", Some((0, 0, 2, 2)));
    assert!(errors.is_empty());
}