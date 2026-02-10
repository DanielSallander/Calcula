//! FILENAME: app/src-tauri/tests/test_conditional_formatting.rs
//! PURPOSE: Tests for conditional formatting functionality.

mod common;

use app_lib::{
    CFValueType, ColorScalePoint, ColorScaleRule, DataBarRule, DataBarDirection,
    DataBarAxisPosition, IconSetType, IconSetRule, IconSetThreshold, ThresholdOperator,
    CellValueOperator, CellValueRule, TextRuleType, ContainsTextRule,
    TopBottomType, TopBottomRule, AverageRuleType, AboveAverageRule,
    TimePeriod, TimePeriodRule, ExpressionRule, ConditionalFormat,
    ConditionalFormatRule, ConditionalFormatRange, ConditionalFormatDefinition,
    ConditionalFormatStorage,
};
use std::collections::HashMap;

// ============================================================================
// UNIT TESTS - Value Types
// ============================================================================

#[test]
fn test_cf_value_type_default() {
    assert_eq!(CFValueType::default(), CFValueType::Number);
}

#[test]
fn test_data_bar_direction_default() {
    assert_eq!(DataBarDirection::default(), DataBarDirection::Context);
}

#[test]
fn test_data_bar_axis_position_default() {
    assert_eq!(DataBarAxisPosition::default(), DataBarAxisPosition::Automatic);
}

#[test]
fn test_icon_set_type_default() {
    assert_eq!(IconSetType::default(), IconSetType::ThreeTrafficLights1);
}

#[test]
fn test_threshold_operator_default() {
    assert_eq!(ThresholdOperator::default(), ThresholdOperator::GreaterThanOrEqual);
}

// ============================================================================
// UNIT TESTS - Data Bar Rule
// ============================================================================

#[test]
fn test_data_bar_rule_default() {
    let rule = DataBarRule::default();

    assert_eq!(rule.min_value_type, CFValueType::AutoMin);
    assert_eq!(rule.max_value_type, CFValueType::AutoMax);
    assert_eq!(rule.fill_color, "#638EC6");
    assert!(rule.show_value);
    assert!(rule.gradient_fill);
    assert_eq!(rule.direction, DataBarDirection::Context);
    assert_eq!(rule.axis_position, DataBarAxisPosition::Automatic);
}

// ============================================================================
// UNIT TESTS - Conditional Format Range
// ============================================================================

#[test]
fn test_conditional_format_range_contains() {
    let range = ConditionalFormatRange {
        start_row: 5,
        start_col: 5,
        end_row: 10,
        end_col: 10,
    };

    // Corners
    assert!(range.contains(5, 5));
    assert!(range.contains(5, 10));
    assert!(range.contains(10, 5));
    assert!(range.contains(10, 10));

    // Inside
    assert!(range.contains(7, 7));

    // Outside
    assert!(!range.contains(4, 5));
    assert!(!range.contains(5, 4));
    assert!(!range.contains(11, 10));
    assert!(!range.contains(10, 11));
}

// ============================================================================
// UNIT TESTS - Color Scale
// ============================================================================

#[test]
fn test_color_scale_two_color() {
    let rule = ColorScaleRule {
        min_point: ColorScalePoint {
            value_type: CFValueType::Min,
            value: None,
            formula: None,
            color: "#FF0000".to_string(),
        },
        mid_point: None,
        max_point: ColorScalePoint {
            value_type: CFValueType::Max,
            value: None,
            formula: None,
            color: "#00FF00".to_string(),
        },
    };

    assert!(rule.mid_point.is_none());
    assert_eq!(rule.min_point.color, "#FF0000");
    assert_eq!(rule.max_point.color, "#00FF00");
}

#[test]
fn test_color_scale_three_color() {
    let rule = ColorScaleRule {
        min_point: ColorScalePoint {
            value_type: CFValueType::Min,
            value: None,
            formula: None,
            color: "#FF0000".to_string(),
        },
        mid_point: Some(ColorScalePoint {
            value_type: CFValueType::Percentile,
            value: Some(50.0),
            formula: None,
            color: "#FFFF00".to_string(),
        }),
        max_point: ColorScalePoint {
            value_type: CFValueType::Max,
            value: None,
            formula: None,
            color: "#00FF00".to_string(),
        },
    };

    assert!(rule.mid_point.is_some());
    let mid = rule.mid_point.unwrap();
    assert_eq!(mid.value_type, CFValueType::Percentile);
    assert_eq!(mid.value, Some(50.0));
}

// ============================================================================
// UNIT TESTS - Icon Set
// ============================================================================

#[test]
fn test_icon_set_rule() {
    let rule = IconSetRule {
        icon_set: IconSetType::ThreeArrows,
        thresholds: vec![
            IconSetThreshold {
                value_type: CFValueType::Percent,
                value: 33.0,
                operator: ThresholdOperator::GreaterThanOrEqual,
            },
            IconSetThreshold {
                value_type: CFValueType::Percent,
                value: 67.0,
                operator: ThresholdOperator::GreaterThanOrEqual,
            },
        ],
        reverse_icons: false,
        show_icon_only: false,
    };

    assert_eq!(rule.icon_set, IconSetType::ThreeArrows);
    assert_eq!(rule.thresholds.len(), 2);
    assert!(!rule.reverse_icons);
}

// ============================================================================
// UNIT TESTS - Cell Value Rules
// ============================================================================

#[test]
fn test_cell_value_rule_between() {
    let rule = CellValueRule {
        operator: CellValueOperator::Between,
        value1: "10".to_string(),
        value2: Some("20".to_string()),
    };

    assert_eq!(rule.operator, CellValueOperator::Between);
    assert!(rule.value2.is_some());
}

#[test]
fn test_cell_value_rule_single_value() {
    let rule = CellValueRule {
        operator: CellValueOperator::GreaterThan,
        value1: "100".to_string(),
        value2: None,
    };

    assert_eq!(rule.operator, CellValueOperator::GreaterThan);
    assert!(rule.value2.is_none());
}

// ============================================================================
// UNIT TESTS - Text Rules
// ============================================================================

#[test]
fn test_contains_text_rule() {
    let rule = ContainsTextRule {
        rule_type: TextRuleType::Contains,
        text: "error".to_string(),
    };

    assert_eq!(rule.rule_type, TextRuleType::Contains);
    assert_eq!(rule.text, "error");
}

#[test]
fn test_text_rule_types() {
    assert_ne!(TextRuleType::Contains, TextRuleType::NotContains);
    assert_ne!(TextRuleType::BeginsWith, TextRuleType::EndsWith);
}

// ============================================================================
// UNIT TESTS - Top/Bottom Rules
// ============================================================================

#[test]
fn test_top_bottom_rule() {
    let rule = TopBottomRule {
        rule_type: TopBottomType::TopItems,
        rank: 10,
    };

    assert_eq!(rule.rule_type, TopBottomType::TopItems);
    assert_eq!(rule.rank, 10);
}

// ============================================================================
// UNIT TESTS - Above/Below Average
// ============================================================================

#[test]
fn test_above_average_rule() {
    let rule = AboveAverageRule {
        rule_type: AverageRuleType::AboveAverage,
    };

    assert_eq!(rule.rule_type, AverageRuleType::AboveAverage);
}

#[test]
fn test_std_dev_rules() {
    let rule = AboveAverageRule {
        rule_type: AverageRuleType::TwoStdDevAbove,
    };

    assert_eq!(rule.rule_type, AverageRuleType::TwoStdDevAbove);
}

// ============================================================================
// UNIT TESTS - Time Period
// ============================================================================

#[test]
fn test_time_period_rule() {
    let rule = TimePeriodRule {
        period: TimePeriod::Today,
    };

    assert_eq!(rule.period, TimePeriod::Today);
}

#[test]
fn test_time_periods() {
    // Just verify all periods are distinct
    assert_ne!(TimePeriod::Today, TimePeriod::Yesterday);
    assert_ne!(TimePeriod::ThisWeek, TimePeriod::LastWeek);
    assert_ne!(TimePeriod::ThisMonth, TimePeriod::NextMonth);
}

// ============================================================================
// UNIT TESTS - Expression Rule
// ============================================================================

#[test]
fn test_expression_rule() {
    let rule = ExpressionRule {
        formula: "=A1>B1".to_string(),
    };

    assert_eq!(rule.formula, "=A1>B1");
}

// ============================================================================
// UNIT TESTS - Conditional Format (Style)
// ============================================================================

#[test]
fn test_conditional_format_default() {
    let format = ConditionalFormat::default();

    assert!(format.background_color.is_none());
    assert!(format.text_color.is_none());
    assert!(format.bold.is_none());
    assert!(format.italic.is_none());
}

#[test]
fn test_conditional_format_with_styles() {
    let format = ConditionalFormat {
        background_color: Some("#FFFF00".to_string()),
        text_color: Some("#FF0000".to_string()),
        bold: Some(true),
        italic: None,
        underline: None,
        strikethrough: None,
        number_format: None,
    };

    assert_eq!(format.background_color, Some("#FFFF00".to_string()));
    assert_eq!(format.text_color, Some("#FF0000".to_string()));
    assert_eq!(format.bold, Some(true));
}

// ============================================================================
// UNIT TESTS - Conditional Format Definition
// ============================================================================

#[test]
fn test_conditional_format_definition() {
    let def = ConditionalFormatDefinition {
        id: 1,
        priority: 1,
        rule: ConditionalFormatRule::BlankCells,
        format: ConditionalFormat {
            background_color: Some("#CCCCCC".to_string()),
            ..Default::default()
        },
        ranges: vec![ConditionalFormatRange {
            start_row: 0,
            start_col: 0,
            end_row: 10,
            end_col: 5,
        }],
        stop_if_true: false,
        enabled: true,
    };

    assert_eq!(def.id, 1);
    assert!(def.enabled);
    assert!(!def.stop_if_true);
    assert_eq!(def.ranges.len(), 1);
}

// ============================================================================
// UNIT TESTS - Storage
// ============================================================================

#[test]
fn test_conditional_format_storage() {
    let mut storage: ConditionalFormatStorage = HashMap::new();

    // Add rule to sheet 0
    let rule1 = ConditionalFormatDefinition {
        id: 1,
        priority: 1,
        rule: ConditionalFormatRule::BlankCells,
        format: ConditionalFormat::default(),
        ranges: vec![],
        stop_if_true: false,
        enabled: true,
    };
    storage.entry(0).or_insert_with(Vec::new).push(rule1);

    // Add rule to sheet 1
    let rule2 = ConditionalFormatDefinition {
        id: 2,
        priority: 1,
        rule: ConditionalFormatRule::NoBlanks,
        format: ConditionalFormat::default(),
        ranges: vec![],
        stop_if_true: false,
        enabled: true,
    };
    storage.entry(1).or_insert_with(Vec::new).push(rule2);

    assert_eq!(storage.len(), 2);
    assert_eq!(storage.get(&0).unwrap().len(), 1);
    assert_eq!(storage.get(&1).unwrap().len(), 1);
}

#[test]
fn test_storage_multiple_rules_per_sheet() {
    let mut storage: ConditionalFormatStorage = HashMap::new();
    let rules = storage.entry(0).or_insert_with(Vec::new);

    for i in 0..5 {
        rules.push(ConditionalFormatDefinition {
            id: i,
            priority: i as u32,
            rule: ConditionalFormatRule::BlankCells,
            format: ConditionalFormat::default(),
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });
    }

    assert_eq!(storage.get(&0).unwrap().len(), 5);
}

// ============================================================================
// UNIT TESTS - JSON Serialization
// ============================================================================

#[test]
fn test_cf_value_type_serialization() {
    let value_type = CFValueType::Percentile;
    let json = serde_json::to_string(&value_type).unwrap();
    assert_eq!(json, "\"percentile\"");
}

#[test]
fn test_icon_set_type_serialization() {
    let icon_set = IconSetType::ThreeArrows;
    let json = serde_json::to_string(&icon_set).unwrap();
    assert_eq!(json, "\"threeArrows\"");
}

#[test]
fn test_cell_value_operator_serialization() {
    let operator = CellValueOperator::GreaterThanOrEqual;
    let json = serde_json::to_string(&operator).unwrap();
    assert_eq!(json, "\"greaterThanOrEqual\"");
}

#[test]
fn test_conditional_format_rule_serialization() {
    let rule = ConditionalFormatRule::CellValue(CellValueRule {
        operator: CellValueOperator::GreaterThan,
        value1: "100".to_string(),
        value2: None,
    });

    let json = serde_json::to_string(&rule).unwrap();

    // Should have type tag
    assert!(json.contains("\"type\":\"cellValue\""));
    assert!(json.contains("\"operator\":\"greaterThan\""));
    assert!(json.contains("\"value1\":\"100\""));
}

#[test]
fn test_simple_rule_serialization() {
    let rule = ConditionalFormatRule::BlankCells;
    let json = serde_json::to_string(&rule).unwrap();
    assert_eq!(json, "\"blankCells\"");
}

#[test]
fn test_conditional_format_serialization() {
    let format = ConditionalFormat {
        background_color: Some("#FFFF00".to_string()),
        text_color: None,
        bold: Some(true),
        italic: None,
        underline: None,
        strikethrough: None,
        number_format: None,
    };

    let json = serde_json::to_string(&format).unwrap();

    // Should use camelCase
    assert!(json.contains("\"backgroundColor\""));
    assert!(!json.contains("\"background_color\""));

    // Should skip None values
    assert!(!json.contains("\"textColor\""));
    assert!(!json.contains("\"italic\""));
}

#[test]
fn test_data_bar_direction_serialization() {
    let direction = DataBarDirection::LeftToRight;
    let json = serde_json::to_string(&direction).unwrap();
    assert_eq!(json, "\"leftToRight\"");
}

#[test]
fn test_time_period_serialization() {
    let period = TimePeriod::Last7Days;
    let json = serde_json::to_string(&period).unwrap();
    assert_eq!(json, "\"last7Days\"");
}

// ============================================================================
// INTEGRATION TESTS - Using TestHarness
// ============================================================================

#[test]
fn test_add_and_get_conditional_format() {
    let harness = common::TestHarness::new();

    // Add a rule
    {
        let mut cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.entry(0).or_insert_with(Vec::new);

        rules.push(ConditionalFormatDefinition {
            id: 1,
            priority: 1,
            rule: ConditionalFormatRule::CellValue(CellValueRule {
                operator: CellValueOperator::GreaterThan,
                value1: "100".to_string(),
                value2: None,
            }),
            format: ConditionalFormat {
                background_color: Some("#00FF00".to_string()),
                ..Default::default()
            },
            ranges: vec![ConditionalFormatRange {
                start_row: 0,
                start_col: 0,
                end_row: 10,
                end_col: 5,
            }],
            stop_if_true: false,
            enabled: true,
        });
    }

    // Verify
    {
        let cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.get(&0).unwrap();

        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, 1);
        assert!(rules[0].enabled);
    }
}

#[test]
fn test_multiple_rules_priority() {
    let harness = common::TestHarness::new();

    // Add rules with different priorities
    {
        let mut cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.entry(0).or_insert_with(Vec::new);

        // Add in reverse priority order
        rules.push(ConditionalFormatDefinition {
            id: 3,
            priority: 3,
            rule: ConditionalFormatRule::BlankCells,
            format: ConditionalFormat::default(),
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });

        rules.push(ConditionalFormatDefinition {
            id: 1,
            priority: 1,
            rule: ConditionalFormatRule::NoBlanks,
            format: ConditionalFormat::default(),
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });

        rules.push(ConditionalFormatDefinition {
            id: 2,
            priority: 2,
            rule: ConditionalFormatRule::ErrorCells,
            format: ConditionalFormat::default(),
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });

        // Sort by priority
        rules.sort_by_key(|r| r.priority);
    }

    // Verify order
    {
        let cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.get(&0).unwrap();

        assert_eq!(rules.len(), 3);
        assert_eq!(rules[0].priority, 1);
        assert_eq!(rules[1].priority, 2);
        assert_eq!(rules[2].priority, 3);
    }
}

#[test]
fn test_conditional_format_across_sheets() {
    let harness = common::TestHarness::with_multiple_sheets(3);

    // Add rules to different sheets
    {
        let mut cf_storage = harness.state.conditional_formats.lock().unwrap();

        cf_storage.entry(0).or_insert_with(Vec::new).push(ConditionalFormatDefinition {
            id: 1,
            priority: 1,
            rule: ConditionalFormatRule::BlankCells,
            format: ConditionalFormat::default(),
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });

        cf_storage.entry(1).or_insert_with(Vec::new).push(ConditionalFormatDefinition {
            id: 2,
            priority: 1,
            rule: ConditionalFormatRule::NoBlanks,
            format: ConditionalFormat::default(),
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });

        cf_storage.entry(2).or_insert_with(Vec::new).push(ConditionalFormatDefinition {
            id: 3,
            priority: 1,
            rule: ConditionalFormatRule::ErrorCells,
            format: ConditionalFormat::default(),
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });
    }

    // Verify each sheet
    {
        let cf_storage = harness.state.conditional_formats.lock().unwrap();

        assert_eq!(cf_storage.get(&0).unwrap().len(), 1);
        assert_eq!(cf_storage.get(&1).unwrap().len(), 1);
        assert_eq!(cf_storage.get(&2).unwrap().len(), 1);

        // Verify different rule types
        assert!(matches!(cf_storage.get(&0).unwrap()[0].rule, ConditionalFormatRule::BlankCells));
        assert!(matches!(cf_storage.get(&1).unwrap()[0].rule, ConditionalFormatRule::NoBlanks));
        assert!(matches!(cf_storage.get(&2).unwrap()[0].rule, ConditionalFormatRule::ErrorCells));
    }
}

#[test]
fn test_disable_conditional_format() {
    let harness = common::TestHarness::new();

    // Add a rule
    {
        let mut cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.entry(0).or_insert_with(Vec::new);

        rules.push(ConditionalFormatDefinition {
            id: 1,
            priority: 1,
            rule: ConditionalFormatRule::BlankCells,
            format: ConditionalFormat::default(),
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });
    }

    // Disable it
    {
        let mut cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.get_mut(&0).unwrap();
        rules[0].enabled = false;
    }

    // Verify
    {
        let cf_storage = harness.state.conditional_formats.lock().unwrap();
        assert!(!cf_storage.get(&0).unwrap()[0].enabled);
    }
}

#[test]
fn test_delete_conditional_format() {
    let harness = common::TestHarness::new();

    // Add rules
    {
        let mut cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.entry(0).or_insert_with(Vec::new);

        rules.push(ConditionalFormatDefinition {
            id: 1,
            priority: 1,
            rule: ConditionalFormatRule::BlankCells,
            format: ConditionalFormat::default(),
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });

        rules.push(ConditionalFormatDefinition {
            id: 2,
            priority: 2,
            rule: ConditionalFormatRule::NoBlanks,
            format: ConditionalFormat::default(),
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });
    }

    // Delete rule with id 1
    {
        let mut cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.get_mut(&0).unwrap();
        rules.retain(|r| r.id != 1);
    }

    // Verify
    {
        let cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.get(&0).unwrap();

        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, 2);
    }
}

#[test]
fn test_stop_if_true() {
    let harness = common::TestHarness::new();

    // Add rules with stop_if_true
    {
        let mut cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.entry(0).or_insert_with(Vec::new);

        rules.push(ConditionalFormatDefinition {
            id: 1,
            priority: 1,
            rule: ConditionalFormatRule::BlankCells,
            format: ConditionalFormat {
                background_color: Some("#FF0000".to_string()),
                ..Default::default()
            },
            ranges: vec![],
            stop_if_true: true, // Stop if this matches
            enabled: true,
        });

        rules.push(ConditionalFormatDefinition {
            id: 2,
            priority: 2,
            rule: ConditionalFormatRule::NoBlanks,
            format: ConditionalFormat {
                background_color: Some("#00FF00".to_string()),
                ..Default::default()
            },
            ranges: vec![],
            stop_if_true: false,
            enabled: true,
        });
    }

    // Verify stop_if_true is set
    {
        let cf_storage = harness.state.conditional_formats.lock().unwrap();
        let rules = cf_storage.get(&0).unwrap();

        assert!(rules[0].stop_if_true);
        assert!(!rules[1].stop_if_true);
    }
}
