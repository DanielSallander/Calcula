//! FILENAME: app/src-tauri/src/commands/icon_refusal_tests.rs
//! PURPOSE: Sorting or filtering by conditional-formatting ICON must REFUSE,
//!          not quietly do something else and report success.
//! CONTEXT: BUG-0104. Both arms were stubs that returned the wrong answer without
//!          saying so, and both were reachable:
//!
//!            SORT   `SortOn::Icon` fell through to comparing VALUES
//!                   (`commands/data.rs`), while the Sorting extension offers it
//!                   by name — `<option value="icon">Conditional Formatting
//!                   Icon</option>` (`SortLevelRow.tsx:183`). A user picked
//!                   "Conditional Formatting Icon", the rows reordered by value,
//!                   and nothing said the request had not been honoured.
//!
//!            FILTER `FilterOn::Icon`'s arm in `should_row_be_visible` was EMPTY,
//!                   its comment ending "For now, icon-filtered rows are always
//!                   shown" — the predicate fell through to `true`, so the filter
//!                   hid nothing while the UI showed a filter as applied. No Rust
//!                   code constructs that variant and the dropdown does not offer
//!                   it, but `FilterCriteria.filter_on` is `#[serde(default)]`
//!                   with `rename_all = "camelCase"`, so any script, MCP tool or
//!                   frontend call passing `{"filterOn": "icon"}` reaches it.
//!
//! A plausible WRONG answer is harder for a user to catch than an error, because
//! the rows really did move. That is the whole reason these refuse.
//!
//! WHEN ICON SUPPORT LANDS, these tests fail — deliberately. Delete them together
//! with the two guards, and replace them with tests of the real ordering.

use crate::api_types::{SortField, SortOn};
use crate::autofilter::{ApplyAutoFilterParams, FilterCriteria, FilterOn};

/// A sort field asking for the unimplemented icon ordering.
fn icon_field() -> SortField {
    SortField {
        key: 0,
        ascending: true,
        sort_on: SortOn::Icon,
        color: None,
        data_option: Default::default(),
        sub_field: None,
        custom_order: None,
    }
}

fn value_field() -> SortField {
    SortField {
        key: 0,
        ascending: true,
        sort_on: SortOn::Value,
        color: None,
        data_option: Default::default(),
        sub_field: None,
        custom_order: None,
    }
}

#[test]
fn icon_sort_is_refused_rather_than_silently_sorted_by_value() {
    let err = super::reject_unimplemented_sort_on(&[icon_field()])
        .expect_err("an icon sort must be refused, not silently sorted by value");
    // The message must name the thing that is unsupported AND what to do instead;
    // "not implemented" alone leaves the user guessing which of four sort modes
    // they may use.
    assert!(
        err.contains("conditional-formatting icon"),
        "the refusal must name what was refused: {err}"
    );
    assert!(
        err.contains("cell value") || err.contains("colour") || err.contains("color"),
        "the refusal must name a supported alternative: {err}"
    );
}

#[test]
fn a_sort_that_asks_for_icon_ANYWHERE_in_a_multi_level_sort_is_refused() {
    // Excel sorts on up to 64 levels. A guard that only inspected the FIRST field
    // would pass this and then sort levels 1..n honestly while silently
    // mis-sorting level 2 — the same silent-wrong-answer defect, one level down.
    let fields = vec![value_field(), icon_field(), value_field()];
    assert!(
        super::reject_unimplemented_sort_on(&fields).is_err(),
        "an icon level anywhere in a multi-level sort must refuse the whole sort"
    );
}

#[test]
fn ordinary_sorts_are_not_refused() {
    // Non-vacuity: a guard that refused everything would satisfy the two cases
    // above while breaking sorting entirely.
    assert!(
        super::reject_unimplemented_sort_on(&[value_field()]).is_ok(),
        "a plain value sort must still be allowed"
    );
    assert!(
        super::reject_unimplemented_sort_on(&[]).is_ok(),
        "an empty field list must not be refused by THIS guard"
    );
    for on in [SortOn::CellColor, SortOn::FontColor] {
        let f = SortField {
            key: 0,
            ascending: true,
            sort_on: on,
            color: Some("#ff0000".to_string()),
            data_option: Default::default(),
            sub_field: None,
            custom_order: None,
        };
        assert!(
            super::reject_unimplemented_sort_on(&[f]).is_ok(),
            "{on:?} is implemented and must not be refused"
        );
    }
}

#[test]
fn the_icon_variant_still_deserializes_from_ipc_so_the_guard_is_load_bearing() {
    // The reachability claim, asserted rather than assumed. If `filterOn: "icon"`
    // stopped deserializing, the filter guard would be dead code — and if this
    // test is what fails, the guard can go, not the other way round.
    let criteria: FilterCriteria = serde_json::from_str(r#"{"filterOn":"icon"}"#)
        .expect("FilterCriteria must accept filterOn: icon over IPC");
    assert_eq!(
        criteria.filter_on,
        FilterOn::Icon,
        "the wire name for the icon filter changed; the guard now matches nothing"
    );

    // ...and the same for the sort side, which is what the UI actually sends.
    let field: SortField = serde_json::from_str(r#"{"key":0,"sortOn":"icon"}"#)
        .expect("SortField must accept sortOn: icon over IPC");
    assert_eq!(field.sort_on, SortOn::Icon);
}

#[test]
fn the_apply_filter_params_carry_the_icon_criteria_the_guard_inspects() {
    // Pins the SHAPE the guard reads: `params.criteria.filter_on`. If the field
    // moved or was renamed, the guard would compile and silently stop firing.
    let params: ApplyAutoFilterParams = serde_json::from_str(
        r#"{"startRow":0,"startCol":0,"endRow":5,"endCol":2,"columnIndex":0,"criteria":{"filterOn":"icon"}}"#,
    )
    .expect("ApplyAutoFilterParams must round-trip an icon criteria");
    assert_eq!(
        params.criteria.as_ref().map(|c| c.filter_on),
        Some(FilterOn::Icon),
        "the guard reads params.criteria.filter_on; that path no longer holds the value"
    );
}
