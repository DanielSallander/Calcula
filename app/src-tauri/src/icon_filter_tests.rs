//! FILENAME: app/src-tauri/src/icon_filter_tests.rs
//! PURPOSE: Filtering by conditional-formatting icon keeps the right rows, and
//!          refuses the shapes it cannot honour.
//! CONTEXT: BUG-0104's other half. `FilterOn::Icon`'s arm in
//!          `should_row_be_visible` was EMPTY, its own comment ending "For now,
//!          icon-filtered rows are always shown" — so the predicate fell through
//!          to `true`, the filter hid nothing, and the UI showed a filter as
//!          applied. A filter that filters nothing while claiming to is the same
//!          silent-wrong-answer class as the icon SORT that ordered by value.
//!
//! THE ROUND-TRIP RESIDUE, which is why the predicate validates as well as the
//! door: the whole `auto_filters` map is written into `.cala` and restored
//! verbatim, so a criteria naming no icon can re-enter state on LOAD without ever
//! passing `apply_auto_filter_inner`. The door alone would leave that case
//! showing every row. Hence `None => false` in the arm — a filter that cannot say
//! what it wants hides, and never lies "all visible".

use crate::autofilter::*;
use crate::conditional_formatting::{IconRef, IconSetType};

fn icon(set: IconSetType, index: u32) -> IconRef {
    IconRef {
        icon_set: set,
        icon_index: index,
    }
}

fn criteria_with(icon_filter: Option<IconFilter>) -> FilterCriteria {
    let mut c: FilterCriteria =
        serde_json::from_str(r#"{"filterOn":"icon"}"#).expect("base criteria");
    c.icon = icon_filter;
    c
}

// ---------------------------------------------------------------------------
// The door validator
// ---------------------------------------------------------------------------

#[test]
fn a_criteria_naming_nothing_is_refused_at_the_door() {
    let err = validate_icon_criteria(&criteria_with(None))
        .expect_err("an icon filter naming no icon must be refused");
    assert!(err.contains("names no icon"), "{err}");
    // The message must offer the alternative, or the user cannot act on it.
    assert!(err.contains("No Cell Icon"), "{err}");
}

#[test]
fn a_criteria_naming_an_empty_icon_filter_is_refused() {
    let err = validate_icon_criteria(&criteria_with(Some(IconFilter {
        icon: None,
        no_icon: false,
    })))
    .expect_err("an IconFilter naming neither an icon nor no_icon must be refused");
    assert!(err.contains("names no icon"), "{err}");
}

#[test]
fn a_criteria_naming_BOTH_an_icon_and_no_icon_is_refused() {
    // "Keep cells showing this icon" and "keep cells showing none" are
    // contradictory; honouring one silently would be a guess.
    let err = validate_icon_criteria(&criteria_with(Some(IconFilter {
        icon: Some(icon(IconSetType::ThreeArrows, 1)),
        no_icon: true,
    })))
    .expect_err("both must be refused");
    assert!(err.contains("Choose one"), "{err}");
}

#[test]
fn an_index_outside_the_named_set_is_refused() {
    // No cell can ever show it, so the filter would hide every row while looking
    // like an ordinary filter.
    let err = validate_icon_criteria(&criteria_with(Some(IconFilter {
        icon: Some(icon(IconSetType::ThreeArrows, 7)),
        no_icon: false,
    })))
    .expect_err("an out-of-range index must be refused");
    assert!(err.contains("does not exist"), "{err}");
    assert!(
        err.contains('3'),
        "the message should say how many icons the set has: {err}"
    );
}

#[test]
fn well_formed_criteria_pass_the_door() {
    // NON-VACUITY. A validator that refused everything would satisfy all four
    // cases above while leaving the feature unusable.
    assert!(
        validate_icon_criteria(&criteria_with(Some(IconFilter {
            icon: Some(icon(IconSetType::ThreeArrows, 2)),
            no_icon: false,
        })))
        .is_ok(),
        "a specific icon in range must be allowed"
    );
    assert!(
        validate_icon_criteria(&criteria_with(Some(IconFilter {
            icon: None,
            no_icon: true,
        })))
        .is_ok(),
        "\"No Cell Icon\" must be allowed"
    );
    // ...and every index the set actually has.
    for i in 0..5 {
        assert!(
            validate_icon_criteria(&criteria_with(Some(IconFilter {
                icon: Some(icon(IconSetType::FiveArrows, i)),
                no_icon: false,
            })))
            .is_ok(),
            "index {i} is inside a five-icon set and must be allowed"
        );
    }
}

// ---------------------------------------------------------------------------
// The wire shape both halves depend on
// ---------------------------------------------------------------------------

#[test]
fn the_icon_filter_wire_shape_round_trips() {
    // The old type was stringly typed and its doc examples ("3Arrows") did not
    // match what the backend serialises ("threeArrows"), so a value copied from
    // the docs could never match a cell. Pin the real spelling.
    let c: FilterCriteria = serde_json::from_str(
        r#"{"filterOn":"icon","icon":{"icon":{"iconSet":"threeArrows","iconIndex":2}}}"#,
    )
    .expect("the icon criteria must deserialize");
    assert_eq!(c.filter_on, FilterOn::Icon);
    let f = c.icon.expect("the icon filter must survive");
    assert_eq!(f.icon, Some(icon(IconSetType::ThreeArrows, 2)));
    assert!(!f.no_icon);

    let n: FilterCriteria =
        serde_json::from_str(r#"{"filterOn":"icon","icon":{"noIcon":true}}"#)
            .expect("No Cell Icon must deserialize");
    let f = n.icon.expect("the icon filter must survive");
    assert!(f.no_icon, "noIcon did not survive the wire");
    assert!(f.icon.is_none());
}

// ---------------------------------------------------------------------------
// The predicate's keep decision
//
// These exist because a sabotage of `None => false` passed every door test above
// in silence: the door validator and the predicate are separate defences, and the
// predicate is the one that covers a criteria restored from `.cala` without
// passing the door.
// ---------------------------------------------------------------------------

#[test]
fn a_specific_icon_keeps_only_cells_showing_it() {
    let want = IconFilter {
        icon: Some(icon(IconSetType::ThreeArrows, 2)),
        no_icon: false,
    };
    assert!(
        icon_criteria_keeps(Some(&want), Some(icon(IconSetType::ThreeArrows, 2))),
        "the exact icon must be kept"
    );
    assert!(
        !icon_criteria_keeps(Some(&want), Some(icon(IconSetType::ThreeArrows, 0))),
        "a different INDEX in the same set must be hidden"
    );
    assert!(
        !icon_criteria_keeps(Some(&want), Some(icon(IconSetType::FiveArrows, 2))),
        "the same index in a different SET must be hidden — an index alone is not \
         an icon, which is the mistake BUG-0107 was"
    );
    assert!(
        !icon_criteria_keeps(Some(&want), None),
        "a cell showing no icon must be hidden by a specific-icon filter"
    );
}

#[test]
fn no_cell_icon_keeps_only_cells_showing_none() {
    let want = IconFilter {
        icon: None,
        no_icon: true,
    };
    assert!(
        icon_criteria_keeps(Some(&want), None),
        "\"No Cell Icon\" must keep a cell with no icon"
    );
    assert!(
        !icon_criteria_keeps(Some(&want), Some(icon(IconSetType::ThreeArrows, 1))),
        "\"No Cell Icon\" must hide a cell that shows one"
    );
}

#[test]
fn a_criteria_naming_NOTHING_hides_rather_than_showing_everything() {
    // THE ROUND-TRIP CASE, and the one a sabotage proved was uncovered. The door
    // refuses this shape, but the whole auto_filters map is restored from `.cala`
    // verbatim — so it re-enters state without passing the door. Showing every row
    // would report a filter as applied while filtering nothing, which is precisely
    // the defect BUG-0104 was.
    assert!(
        !icon_criteria_keeps(None, Some(icon(IconSetType::ThreeArrows, 1))),
        "a keyless icon criteria showed a row: it must HIDE, never claim all visible"
    );
    assert!(
        !icon_criteria_keeps(None, None),
        "a keyless icon criteria must hide regardless of what the cell shows"
    );
    // ...and the same for an IconFilter present but empty.
    let empty = IconFilter {
        icon: None,
        no_icon: false,
    };
    assert!(
        !icon_criteria_keeps(Some(&empty), Some(icon(IconSetType::ThreeArrows, 1))),
        "an empty IconFilter must hide too"
    );
}
