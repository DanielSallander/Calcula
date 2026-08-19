//! FILENAME: app/src-tauri/src/icon_glyph_resolution_tests.rs
//! PURPOSE: The icon a cell shows is ONE value, resolved by the rule that
//!          actually produced it — never assembled from two rules.
//! CONTEXT: BUG-0107. The drawn glyph used to be a join of two independent
//!          lookups that could disagree:
//!
//!            index  <- the backend, which cascades correctly (skips
//!                      `enabled: false`, honours `stop_if_true`, respects
//!                      priority)
//!            set    <- the FRONTEND's own `findMatchingRuleId(row, col,
//!                      "iconSet")`, which matched on rule TYPE and range
//!                      containment only — no `enabled`, no `stop_if_true`, no
//!                      priority — and returned the first array match
//!
//!          So a DISABLED five-icon rule listed before an enabled three-icon rule
//!          over the same range drew a five-arrow glyph indexed 0..2: a picture
//!          assembled from two different rules, one of which the user had switched
//!          off. With no resolvable rule the renderer silently drew
//!          `threeTrafficLights1`, so a cell could show traffic lights that no
//!          rule asked for.
//!
//!          The fix carries the icon SET on the evaluation result beside the index
//!          it already returned, and deletes the frontend's second search. These
//!          tests pin the backend half: that the set travels with the index, and
//!          that it comes from the CASCADED rule rather than the first matching
//!          one.
//!
//! WHY THIS IS A PREREQUISITE, not a cosmetic sibling: "sort by the icon I can
//! see" (BUG-0104) has no referent while the displayed icon is not a single
//! value. Sorting on a glyph the renderer computed from a disabled rule would
//! produce an order the user cannot explain from what is on screen.

use crate::conditional_formatting::*;
use engine::grid::Grid;

/// A grid with one numeric column, rows 0..n at A.
fn grid_with_column(values: &[f64]) -> Grid {
    let mut grid = Grid::new();
    for (i, v) in values.iter().enumerate() {
        grid.set_cell(i as u32, 0, engine::cell::Cell::new_number(*v));
    }
    grid
}

fn icon_rule(set: IconSetType, thresholds: Vec<f64>) -> ConditionalFormatRule {
    ConditionalFormatRule::IconSet(IconSetRule {
        icon_set: set,
        thresholds: thresholds
            .into_iter()
            .map(|v| IconSetThreshold {
                value_type: CFValueType::Number,
                value: v,
                operator: ThresholdOperator::GreaterThanOrEqual,
                formula: None,
            })
            .collect(),
        reverse_icons: false,
        show_icon_only: false,
    })
}

fn definition(
    id: u64,
    priority: u32,
    enabled: bool,
    rule: ConditionalFormatRule,
    end_row: u32,
) -> ConditionalFormatDefinition {
    ConditionalFormatDefinition {
        id,
        priority,
        enabled,
        stop_if_true: false,
        ranges: vec![ConditionalFormatRange {
            start_row: 0,
            start_col: 0,
            end_row,
            end_col: 0,
        }],
        rule,
        format: ConditionalFormat::default(),
    }
}

/// Evaluate one column and return (icon_set, icon_index) per row that got an icon.
fn icons_for(
    grid: &Grid,
    rules: &[ConditionalFormatDefinition],
    rows: u32,
) -> Vec<(u32, Option<IconSetType>, Option<u32>)> {
    let grids = vec![grid.clone()];
    let names = vec!["Sheet1".to_string()];
    let cells = evaluate_conditional_formats_for(grid, &grids, &names, 0, rules, 0, rows, 0, 0);
    cells
        .into_iter()
        .filter(|c| c.icon_index.is_some())
        .map(|c| (c.row, c.icon_set, c.icon_index))
        .collect()
}

#[test]
fn the_icon_set_travels_with_the_index() {
    // Without this the frontend has to guess the set, which is the whole defect.
    let grid = grid_with_column(&[1.0, 50.0, 99.0]);
    let rules = vec![definition(
        1,
        0,
        true,
        icon_rule(IconSetType::ThreeArrows, vec![33.0, 66.0]),
        2,
    )];
    let got = icons_for(&grid, &rules, 3);
    assert_eq!(got.len(), 3, "every row in range should get an icon");
    for (row, set, index) in &got {
        assert_eq!(
            *set,
            Some(IconSetType::ThreeArrows),
            "row {row}: the set must arrive with the index, not be guessed"
        );
        assert!(index.is_some());
    }
}

#[test]
fn a_DISABLED_rule_cannot_supply_the_glyph_family() {
    // THE DEFECT, in one assertion. A disabled FiveArrows rule sits FIRST in the
    // list — exactly where the frontend's old first-match search would have found
    // it — over an enabled ThreeArrows rule. The set must come from the enabled
    // one, and the index must be in that set's range.
    let grid = grid_with_column(&[1.0, 50.0, 99.0]);
    let rules = vec![
        definition(1, 0, false, icon_rule(IconSetType::FiveArrows, vec![20.0, 40.0, 60.0, 80.0]), 2),
        definition(2, 1, true, icon_rule(IconSetType::ThreeArrows, vec![33.0, 66.0]), 2),
    ];
    let got = icons_for(&grid, &rules, 3);
    assert!(!got.is_empty(), "the enabled rule should still produce icons");
    for (row, set, index) in &got {
        assert_eq!(
            *set,
            Some(IconSetType::ThreeArrows),
            "row {row}: the glyph family came from the DISABLED rule — the exact \
             shape of BUG-0107"
        );
        assert!(
            index.unwrap() <= 2,
            "row {row}: index {:?} is outside a three-icon set",
            index
        );
    }
}

#[test]
fn stop_if_true_decides_which_set_wins() {
    // Two ENABLED rules, the first stopping. The set must be the first one's, and
    // the second must not contribute an icon at all.
    let grid = grid_with_column(&[10.0, 90.0]);
    let mut first = definition(1, 0, true, icon_rule(IconSetType::ThreeTrafficLights1, vec![25.0, 75.0]), 1);
    first.stop_if_true = true;
    let rules = vec![
        first,
        definition(2, 1, true, icon_rule(IconSetType::FiveArrows, vec![20.0, 40.0, 60.0, 80.0]), 1),
    ];
    let got = icons_for(&grid, &rules, 2);
    for (row, set, _) in &got {
        assert_eq!(
            *set,
            Some(IconSetType::ThreeTrafficLights1),
            "row {row}: stop_if_true was ignored when choosing the icon set"
        );
    }
}

#[test]
fn the_rule_id_identifies_the_producing_rule() {
    // So a consumer can attribute a result instead of searching for a rule that
    // "looks like" the right one — which is how the frontend went wrong.
    let grid = grid_with_column(&[42.0]);
    let rules = vec![
        definition(7, 0, false, icon_rule(IconSetType::FiveArrows, vec![10.0, 20.0, 30.0, 40.0]), 0),
        definition(9, 1, true, icon_rule(IconSetType::ThreeArrows, vec![33.0, 66.0]), 0),
    ];
    let grids = vec![grid.clone()];
    let names = vec!["Sheet1".to_string()];
    let cells = evaluate_conditional_formats_for(&grid, &grids, &names, 0, &rules, 0, 0, 0, 0);
    let icon = cells
        .into_iter()
        .find(|c| c.icon_index.is_some())
        .expect("the enabled rule should produce an icon");
    assert_eq!(
        icon.rule_id,
        Some(9),
        "the result is attributed to the wrong rule — 7 is the DISABLED one"
    );
}
