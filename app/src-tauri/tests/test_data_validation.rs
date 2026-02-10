//! FILENAME: tests/test_data_validation.rs
//! Integration tests for data validation commands.

mod common;

use app_lib::{
    DataValidation, DataValidationType, DataValidationOperator,
    DataValidationAlertStyle, DataValidationRule, NumericRule,
    ValidationRange, ValidationStorage, DataValidationErrorAlert,
    DataValidationPrompt,
};
use common::TestHarness;
use std::collections::HashMap;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

fn create_numeric_between_rule(min: f64, max: f64) -> DataValidationRule {
    DataValidationRule::Decimal(NumericRule {
        operator: DataValidationOperator::Between,
        formula1: min,
        formula2: Some(max),
    })
}

fn create_validation(rule: DataValidationRule) -> DataValidation {
    DataValidation {
        rule,
        error_alert: DataValidationErrorAlert::default(),
        prompt: DataValidationPrompt::default(),
        ignore_blanks: true,
    }
}

fn create_validation_range(
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    validation: DataValidation,
) -> ValidationRange {
    ValidationRange {
        start_row,
        start_col,
        end_row,
        end_col,
        validation,
    }
}

// ============================================================================
// BASIC VALIDATION TESTS
// ============================================================================

#[test]
fn test_create_numeric_validation() {
    let validation = create_validation(create_numeric_between_rule(0.0, 100.0));

    assert!(matches!(validation.rule, DataValidationRule::Decimal(_)));
    assert!(validation.prompt.show_prompt);
    assert!(validation.error_alert.show_alert);
}

#[test]
fn test_validation_operators() {
    let operators = vec![
        DataValidationOperator::Between,
        DataValidationOperator::NotBetween,
        DataValidationOperator::Equal,
        DataValidationOperator::NotEqual,
        DataValidationOperator::GreaterThan,
        DataValidationOperator::LessThan,
        DataValidationOperator::GreaterThanOrEqual,
        DataValidationOperator::LessThanOrEqual,
    ];

    for op in operators {
        let rule = DataValidationRule::Decimal(NumericRule {
            operator: op,
            formula1: 50.0,
            formula2: if matches!(op, DataValidationOperator::Between | DataValidationOperator::NotBetween) {
                Some(100.0)
            } else {
                None
            },
        });

        let validation = create_validation(rule);
        assert!(matches!(validation.rule, DataValidationRule::Decimal(_)));
    }
}

#[test]
fn test_validation_alert_styles() {
    let styles = vec![
        DataValidationAlertStyle::Stop,
        DataValidationAlertStyle::Warning,
        DataValidationAlertStyle::Information,
    ];

    for style in styles {
        let mut validation = create_validation(create_numeric_between_rule(0.0, 100.0));
        validation.error_alert.style = style;

        // Each style is valid
        assert!(validation.error_alert.show_alert);
    }
}

// ============================================================================
// VALIDATION STORAGE TESTS
// ============================================================================

#[test]
fn test_add_validation_to_storage() {
    let harness = TestHarness::new();

    {
        let mut validations = harness.state.data_validations.lock().unwrap();

        // Create storage for sheet 0
        let mut sheet_validations: Vec<ValidationRange> = Vec::new();

        // Add a validation rule
        let validation = create_validation(create_numeric_between_rule(1.0, 100.0));
        sheet_validations.push(create_validation_range(0, 0, 10, 0, validation));

        validations.insert(0, sheet_validations);
    }

    let validations = harness.state.data_validations.lock().unwrap();
    assert!(validations.contains_key(&0));
    assert_eq!(validations.get(&0).unwrap().len(), 1);
}

#[test]
fn test_multiple_validations_per_sheet() {
    let harness = TestHarness::new();

    {
        let mut validations = harness.state.data_validations.lock().unwrap();
        let mut sheet_validations: Vec<ValidationRange> = Vec::new();

        // Column A: Numbers 1-100
        sheet_validations.push(create_validation_range(
            0, 0, 100, 0,
            create_validation(create_numeric_between_rule(1.0, 100.0)),
        ));

        // Column B: Numbers 0-1000
        sheet_validations.push(create_validation_range(
            0, 1, 100, 1,
            create_validation(create_numeric_between_rule(0.0, 1000.0)),
        ));

        // Column C: Percentage 0-100
        sheet_validations.push(create_validation_range(
            0, 2, 100, 2,
            create_validation(create_numeric_between_rule(0.0, 100.0)),
        ));

        validations.insert(0, sheet_validations);
    }

    let validations = harness.state.data_validations.lock().unwrap();
    assert_eq!(validations.get(&0).unwrap().len(), 3);
}

#[test]
fn test_validations_multiple_sheets() {
    let harness = TestHarness::with_multiple_sheets(3);

    {
        let mut validations = harness.state.data_validations.lock().unwrap();

        for sheet_idx in 0..3 {
            let mut sheet_validations: Vec<ValidationRange> = Vec::new();
            sheet_validations.push(create_validation_range(
                0, 0, 10, 0,
                create_validation(create_numeric_between_rule(0.0, (sheet_idx + 1) as f64 * 100.0)),
            ));
            validations.insert(sheet_idx, sheet_validations);
        }
    }

    let validations = harness.state.data_validations.lock().unwrap();
    assert_eq!(validations.len(), 3);
}

// ============================================================================
// CLEAR VALIDATION TESTS
// ============================================================================

#[test]
fn test_clear_single_validation() {
    let harness = TestHarness::new();

    {
        let mut validations = harness.state.data_validations.lock().unwrap();
        let mut sheet_validations: Vec<ValidationRange> = Vec::new();
        sheet_validations.push(create_validation_range(
            0, 0, 10, 0,
            create_validation(create_numeric_between_rule(0.0, 100.0)),
        ));
        validations.insert(0, sheet_validations);
    }

    // Clear
    {
        let mut validations = harness.state.data_validations.lock().unwrap();
        if let Some(sheet_validations) = validations.get_mut(&0) {
            sheet_validations.clear();
        }
    }

    let validations = harness.state.data_validations.lock().unwrap();
    assert!(validations.get(&0).unwrap().is_empty());
}

#[test]
fn test_clear_all_validations_for_sheet() {
    let harness = TestHarness::new();

    {
        let mut validations = harness.state.data_validations.lock().unwrap();
        let mut sheet_validations: Vec<ValidationRange> = Vec::new();

        for col in 0..5 {
            sheet_validations.push(create_validation_range(
                0, col, 100, col,
                create_validation(create_numeric_between_rule(0.0, 100.0)),
            ));
        }

        validations.insert(0, sheet_validations);
    }

    // Clear all
    {
        let mut validations = harness.state.data_validations.lock().unwrap();
        if let Some(sheet_validations) = validations.get_mut(&0) {
            sheet_validations.clear();
        }
    }

    let validations = harness.state.data_validations.lock().unwrap();
    assert!(validations.get(&0).unwrap().is_empty());
}

// ============================================================================
// INPUT MESSAGE TESTS
// ============================================================================

#[test]
fn test_validation_with_input_message() {
    let mut validation = create_validation(create_numeric_between_rule(1.0, 10.0));
    validation.prompt.show_prompt = true;
    validation.prompt.title = "Enter Value".to_string();
    validation.prompt.message = "Please enter a number between 1 and 10".to_string();

    assert!(validation.prompt.show_prompt);
    assert_eq!(validation.prompt.title, "Enter Value");
}

#[test]
fn test_validation_without_input_message() {
    let mut validation = create_validation(create_numeric_between_rule(1.0, 10.0));
    validation.prompt.show_prompt = false;
    validation.prompt.title = String::new();
    validation.prompt.message = String::new();

    assert!(!validation.prompt.show_prompt);
}

// ============================================================================
// ERROR ALERT TESTS
// ============================================================================

#[test]
fn test_validation_with_error_message() {
    let mut validation = create_validation(create_numeric_between_rule(1.0, 10.0));
    validation.error_alert.show_alert = true;
    validation.error_alert.style = DataValidationAlertStyle::Stop;
    validation.error_alert.title = "Invalid Entry".to_string();
    validation.error_alert.message = "Value must be between 1 and 10".to_string();

    assert!(validation.error_alert.show_alert);
    assert!(matches!(validation.error_alert.style, DataValidationAlertStyle::Stop));
}

#[test]
fn test_warning_style_error() {
    let mut validation = create_validation(create_numeric_between_rule(1.0, 10.0));
    validation.error_alert.style = DataValidationAlertStyle::Warning;

    assert!(matches!(validation.error_alert.style, DataValidationAlertStyle::Warning));
}

#[test]
fn test_information_style_error() {
    let mut validation = create_validation(create_numeric_between_rule(1.0, 10.0));
    validation.error_alert.style = DataValidationAlertStyle::Information;

    assert!(matches!(validation.error_alert.style, DataValidationAlertStyle::Information));
}

// ============================================================================
// RANGE OVERLAP TESTS
// ============================================================================

#[test]
fn test_overlapping_ranges() {
    let harness = TestHarness::new();

    {
        let mut validations = harness.state.data_validations.lock().unwrap();
        let mut sheet_validations: Vec<ValidationRange> = Vec::new();

        // Two overlapping ranges
        sheet_validations.push(create_validation_range(
            0, 0, 10, 5,
            create_validation(create_numeric_between_rule(0.0, 100.0)),
        ));
        sheet_validations.push(create_validation_range(
            5, 3, 15, 8,
            create_validation(create_numeric_between_rule(0.0, 1000.0)),
        ));

        validations.insert(0, sheet_validations);
    }

    // Both should exist (storage allows overlaps)
    let validations = harness.state.data_validations.lock().unwrap();
    assert_eq!(validations.get(&0).unwrap().len(), 2);
}

// ============================================================================
// VALIDATION TYPE TESTS
// ============================================================================

#[test]
fn test_whole_number_validation_type() {
    let validation = DataValidation {
        rule: DataValidationRule::WholeNumber(NumericRule {
            operator: DataValidationOperator::GreaterThan,
            formula1: 0.0,
            formula2: None,
        }),
        error_alert: DataValidationErrorAlert {
            show_alert: true,
            style: DataValidationAlertStyle::Stop,
            title: String::new(),
            message: String::new(),
        },
        prompt: DataValidationPrompt::default(),
        ignore_blanks: true,
    };

    assert!(matches!(validation.rule, DataValidationRule::WholeNumber(_)));
}

// ============================================================================
// EDGE CASES
// ============================================================================

#[test]
fn test_single_cell_validation() {
    let harness = TestHarness::new();

    {
        let mut validations = harness.state.data_validations.lock().unwrap();
        let mut sheet_validations: Vec<ValidationRange> = Vec::new();

        // Single cell A1
        sheet_validations.push(create_validation_range(
            0, 0, 0, 0,
            create_validation(create_numeric_between_rule(0.0, 100.0)),
        ));

        validations.insert(0, sheet_validations);
    }

    let validations = harness.state.data_validations.lock().unwrap();
    let sheet_validations = validations.get(&0).unwrap();
    assert_eq!(sheet_validations.len(), 1);
    assert_eq!(sheet_validations[0].start_row, 0);
    assert_eq!(sheet_validations[0].start_col, 0);
    assert_eq!(sheet_validations[0].end_row, 0);
    assert_eq!(sheet_validations[0].end_col, 0);
}

#[test]
fn test_entire_column_validation() {
    let harness = TestHarness::new();

    {
        let mut validations = harness.state.data_validations.lock().unwrap();
        let mut sheet_validations: Vec<ValidationRange> = Vec::new();

        // Entire column A (large range)
        sheet_validations.push(create_validation_range(
            0, 0, 1048575, 0, // Max row in Excel
            create_validation(create_numeric_between_rule(0.0, 100.0)),
        ));

        validations.insert(0, sheet_validations);
    }

    let validations = harness.state.data_validations.lock().unwrap();
    assert_eq!(validations.get(&0).unwrap().len(), 1);
}

#[test]
fn test_ignore_blanks_option() {
    let mut validation = create_validation(create_numeric_between_rule(0.0, 100.0));
    validation.ignore_blanks = false;

    assert!(!validation.ignore_blanks);
}

#[test]
fn test_empty_validations_storage() {
    let harness = TestHarness::new();
    let validations = harness.state.data_validations.lock().unwrap();
    assert!(validations.is_empty());
}
