//! FILENAME: app/src-tauri/src/commands/icon_sort_tests.rs
//! PURPOSE: Sorting by conditional-formatting ICON orders by the icon on screen,
//!          and refuses the three cases it genuinely cannot answer.
//! CONTEXT: BUG-0104. Icon sorting was a silent no-op: `SortOn::Icon` fell through
//!          to comparing VALUES while the Sort dialog offered "Conditional
//!          Formatting Icon" by name, so a user picked it, watched the rows
//!          reorder by value, and was told it worked. A plausible WRONG answer is
//!          harder to catch than an error, because the rows really did move.
//!
//!          It was first made to REFUSE (2026-08-19), then implemented. This file
//!          began as `icon_refusal_tests.rs`; the two tests asserting the blanket
//!          guard's message are gone, and the three that pinned properties the
//!          implementation now DEPENDS on are kept and retargeted.
//!
//! WHAT REMAINS REFUSED, permanently — these are validations, not stubs, and they
//! never get deleted:
//!   1. an icon level naming no icon: "sort by icon" without saying WHICH has no
//!      meaning, and choosing one for the user is a guess dressed as an answer;
//!   2. an icon level combined with a custom order — the dialog lets both be
//!      picked, and silently ignoring one is the very defect class above;
//!   3. an icon level where no enabled icon-set rule applies, because a sort that
//!      legitimately cannot move anything is indistinguishable from the no-op it
//!      replaced.

use crate::api_types::{SortField, SortOn};
use crate::autofilter::{ApplyAutoFilterParams, FilterCriteria, FilterOn};
use crate::conditional_formatting::{
    CFValueType, ConditionalFormat, ConditionalFormatDefinition, ConditionalFormatRange,
    ConditionalFormatRule, IconRef, IconSetRule, IconSetThreshold, IconSetType, ThresholdOperator,
};

fn field(sort_on: SortOn, icon: Option<IconRef>) -> SortField {
    SortField {
        key: 0,
        ascending: true,
        sort_on,
        color: None,
        icon,
        data_option: Default::default(),
        sub_field: None,
        custom_order: None,
    }
}

fn an_icon() -> IconRef {
    IconRef {
        icon_set: IconSetType::ThreeArrows,
        icon_index: 2,
    }
}

/// An enabled icon-set rule, so refusal 3 is satisfied unless a test wants it.
fn icon_rules() -> Vec<ConditionalFormatDefinition> {
    vec![ConditionalFormatDefinition {
        id: 1,
        priority: 0,
        enabled: true,
        stop_if_true: false,
        ranges: vec![ConditionalFormatRange {
            start_row: 0,
            start_col: 0,
            end_row: 100,
            end_col: 10,
        }],
        rule: ConditionalFormatRule::IconSet(IconSetRule {
            icon_set: IconSetType::ThreeArrows,
            thresholds: vec![33.0, 66.0]
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
        }),
        format: ConditionalFormat::default(),
    }]
}

#[test]
fn an_icon_level_naming_no_icon_is_refused() {
    let err = super::validate_sort_fields(&[field(SortOn::Icon, None)], &icon_rules())
        .expect_err("sorting by icon without naming one must be refused");
    assert!(
        err.contains("names no icon"),
        "the refusal must say what is missing: {err}"
    );
    assert!(
        err.contains("level 1"),
        "the refusal must name WHICH level, since a sort can have up to 64: {err}"
    );
}

#[test]
fn an_icon_level_ANYWHERE_in_a_multi_level_sort_is_validated() {
    // Re-pins the property the deleted blanket guard had: a validator reading
    // only `fields[0]` would honour level 1 and silently mis-sort level 2 — the
    // same defect one level down.
    let fields = vec![
        field(SortOn::Value, None),
        field(SortOn::Icon, None), // level 2 is the bad one
        field(SortOn::Value, None),
    ];
    let err = super::validate_sort_fields(&fields, &icon_rules())
        .expect_err("an icon level anywhere must be validated");
    assert!(
        err.contains("level 2"),
        "the refusal must identify the offending level, not just fail: {err}"
    );
}

#[test]
fn an_icon_level_combined_with_a_custom_order_is_refused() {
    // The Sort dialog lets a user pick "Conditional Formatting Icon" AND a custom
    // order such as Weekdays. One of them must lose, and silently choosing is the
    // defect this whole entry is about.
    let mut f = field(SortOn::Icon, Some(an_icon()));
    f.custom_order = Some("weekdays".to_string());
    let err = super::validate_sort_fields(&[f], &icon_rules())
        .expect_err("icon + custom order must be refused rather than silently resolved");
    assert!(err.contains("custom order"), "{err}");
}

#[test]
fn an_icon_sort_with_no_enabled_icon_rule_is_refused() {
    // Nothing in range can show an icon, so the sort cannot move anything — which
    // is indistinguishable from the silent no-op this entry replaced.
    let mut rules = icon_rules();
    rules[0].enabled = false;
    let err = super::validate_sort_fields(&[field(SortOn::Icon, Some(an_icon()))], &rules)
        .expect_err("an icon sort with no enabled icon rule must speak");
    assert!(err.contains("no enabled icon-set rule"), "{err}");
}

#[test]
fn ordinary_sorts_are_not_rejected_by_icon_validation() {
    // NON-VACUITY. A validator that refused everything would satisfy all four
    // cases above while breaking sorting entirely.
    let rules = icon_rules();
    assert!(super::validate_sort_fields(&[], &rules).is_ok(), "an empty field list");
    assert!(
        super::validate_sort_fields(&[field(SortOn::Value, None)], &rules).is_ok(),
        "a plain value sort"
    );
    for on in [SortOn::CellColor, SortOn::FontColor] {
        let mut f = field(on, None);
        f.color = Some("#ff0000".to_string());
        assert!(
            super::validate_sort_fields(&[f], &rules).is_ok(),
            "{on:?} is implemented and must not be refused"
        );
    }
    // ...and a WELL-FORMED icon sort must pass, which is the whole point now.
    assert!(
        super::validate_sort_fields(&[field(SortOn::Icon, Some(an_icon()))], &rules).is_ok(),
        "a well-formed icon sort must be allowed now that it is implemented"
    );
}

#[test]
fn icon_sort_and_filter_deserialize_from_ipc() {
    // The implementation now DEPENDS on this wire shape, where it used to merely
    // prove the guard was load-bearing. A rename here silently disables the
    // feature rather than the guard.
    let f: SortField = serde_json::from_str(
        r#"{"key":0,"sortOn":"icon","icon":{"iconSet":"threeArrows","iconIndex":2}}"#,
    )
    .expect("SortField must accept sortOn + icon over IPC");
    assert_eq!(f.sort_on, SortOn::Icon);
    assert_eq!(
        f.icon.expect("the icon must survive deserialization"),
        an_icon(),
        "the icon arrived but with the wrong value — check the camelCase mapping"
    );

    let criteria: FilterCriteria = serde_json::from_str(r#"{"filterOn":"icon"}"#)
        .expect("FilterCriteria must accept filterOn: icon over IPC");
    assert_eq!(criteria.filter_on, FilterOn::Icon);
}

#[test]
fn apply_filter_params_carry_the_icon_criteria() {
    let params: ApplyAutoFilterParams = serde_json::from_str(
        r#"{"startRow":0,"startCol":0,"endRow":5,"endCol":2,"columnIndex":0,"criteria":{"filterOn":"icon"}}"#,
    )
    .expect("ApplyAutoFilterParams must round-trip an icon criteria");
    assert_eq!(
        params.criteria.as_ref().map(|c| c.filter_on),
        Some(FilterOn::Icon),
        "the guard and the future filter both read params.criteria.filter_on"
    );
}
