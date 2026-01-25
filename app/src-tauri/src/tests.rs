#[cfg(test)]
use super::*;
use crate::pivot_commands::{
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
    assert_eq!(format_cell_value(&CellValue::Empty, &default_style), "");
    assert_eq!(
        format_cell_value(&CellValue::Number(42.0), &default_style),
        "42"
    );
    assert_eq!(
        format_cell_value(&CellValue::Text("Hello".to_string()), &default_style),
        "Hello"
    );
    assert_eq!(
        format_cell_value(&CellValue::Boolean(true), &default_style),
        "TRUE"
    );
    assert_eq!(
        format_cell_value(&CellValue::Boolean(false), &default_style),
        "FALSE"
    );
}

#[test]
fn test_format_cell_value_with_style() {
    // Test currency formatting
    let currency_style = CellStyle::new().with_number_format(NumberFormat::Currency {
        decimal_places: 2,
        symbol: "$".to_string(),
        symbol_position: engine::CurrencyPosition::Before,
    });
    assert_eq!(
        format_cell_value(&CellValue::Number(1234.56), &currency_style),
        "$1,234.56"
    );

    // Test percentage formatting
    let percentage_style =
        CellStyle::new().with_number_format(NumberFormat::Percentage { decimal_places: 1 });
    assert_eq!(
        format_cell_value(&CellValue::Number(0.5), &percentage_style),
        "50.0%"
    );
}

#[test]
fn test_parse_number() {
    assert_eq!(parse_number("42"), Some(42.0));
    assert_eq!(parse_number("3.14"), Some(3.14));
    assert_eq!(parse_number("-100"), Some(-100.0));
    assert_eq!(parse_number("50%"), Some(0.5));
    assert_eq!(parse_number("1,000"), Some(1000.0));
    assert_eq!(parse_number("1,234.56"), Some(1234.56));
    assert_eq!(parse_number("hello"), None);
    assert_eq!(parse_number(""), None);
}

#[test]
fn test_parse_cell_input() {
    // Empty
    let cell = parse_cell_input("");
    assert!(matches!(cell.value, CellValue::Empty));

    // Number
    let cell = parse_cell_input("42");
    assert!(matches!(cell.value, CellValue::Number(n) if n == 42.0));

    // Text
    let cell = parse_cell_input("Hello");
    assert!(matches!(cell.value, CellValue::Text(ref s) if s == "Hello"));

    // Boolean
    let cell = parse_cell_input("TRUE");
    assert!(matches!(cell.value, CellValue::Boolean(true)));

    let cell = parse_cell_input("false");
    assert!(matches!(cell.value, CellValue::Boolean(false)));

    // Formula (value is Empty until evaluated)
    let cell = parse_cell_input("=A1+B1");
    assert_eq!(cell.formula, Some("=A1+B1".to_string()));

    // Percentage
    let cell = parse_cell_input("50%");
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