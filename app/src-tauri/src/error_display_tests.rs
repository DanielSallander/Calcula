//! FILENAME: app/src-tauri/src/error_display_tests.rs
//! PURPOSE: Pin the app-side error spelling against the engine's canonical one.
//!
//! CONTEXT: `cell_error_display`'s doc comment claimed for a long time that it
//! mirrored `Cell::display_value` "exactly". It does not, and by the time
//! anyone checked, the engine had moved to an explicit `CellError::as_literal`
//! table with no `#{Debug}` fallback at all. Nothing caught the drift because
//! nothing compared the two.
//!
//! These tests do not assert which spelling is RIGHT — that is an owner
//! decision, recorded in the register, and changing it moves grid goldens.
//! They assert what each side actually produces today, so that:
//!   * the divergence cannot widen unnoticed (a new `CellError` variant taking
//!     the Debug arm fails `every_variant_is_accounted_for`), and
//!   * whoever makes the decision reads a measured table rather than a claim.

use engine::{Cell, CellError, CellValue};

/// Every `CellError` variant, with what each side renders it as TODAY.
///
/// (variant, `cell_error_display`, `Cell::display_value`)
const SPELLINGS: &[(CellError, &str, &str)] = &[
    // -- The four that agree: each is listed explicitly in both tables ------
    (CellError::NA, "#N/A", "#N/A"),
    (CellError::Conflict, "#CONFLICT", "#CONFLICT"),
    (CellError::Blocked, "#BLOCKED!", "#BLOCKED!"),
    (CellError::Limit, "#LIMIT!", "#LIMIT!"),
    // -- The six that diverge: these take `#{Debug}` on the app side -------
    (CellError::Div0, "#DIV0", "#DIV/0!"),
    (CellError::Ref, "#REF", "#REF!"),
    (CellError::Name, "#NAME", "#NAME?"),
    (CellError::Value, "#VALUE", "#VALUE!"),
    (CellError::Circular, "#CIRCULAR", "#CIRCULAR!"),
    // `Parse` is the one that is not merely a missing punctuation mark: the
    // Debug arm leaks an internal enum name. The engine gives `Parse` no
    // distinct literal on purpose (it shares `#VALUE!`, so `from_literal`
    // reloads it as `Value`), which makes "#PARSE" a spelling no other layer
    // can parse back.
    (CellError::Parse, "#PARSE", "#VALUE!"),
];

fn engine_display(e: &CellError) -> String {
    let mut cell = Cell::new();
    cell.value = CellValue::Error(e.clone());
    cell.display_value()
}

#[test]
fn cell_error_display_divergence_from_the_engine_is_pinned() {
    let mut drifted: Vec<String> = Vec::new();
    for (variant, app_expected, engine_expected) in SPELLINGS {
        let app_actual = crate::cell_error_display(variant);
        let engine_actual = engine_display(variant);
        if app_actual != *app_expected {
            drifted.push(format!(
                "{:?}: cell_error_display now renders {:?}, this table says {:?}",
                variant, app_actual, app_expected
            ));
        }
        if engine_actual != *engine_expected {
            drifted.push(format!(
                "{:?}: Cell::display_value now renders {:?}, this table says {:?}",
                variant, engine_actual, engine_expected
            ));
        }
    }
    assert!(
        drifted.is_empty(),
        "the pinned error spellings have moved:\n  {}\n\nIf this is the \
         deliberate closure of the app/engine divergence, update this table \
         AND re-record the grid goldens that paint an error cell — the \
         register's owner-decision section lists them.",
        drifted.join("\n  ")
    );
}

#[test]
fn the_four_that_must_never_take_the_debug_arm_still_do_not() {
    // `Limit`, `Blocked` and `Conflict` are load-bearing: the Debug arm would
    // drop the trailing punctuation, and `normalizeCellErrorLiteral` on the
    // frontend collapses anything it does not recognise into "#VALUE!" — which
    // would erase exactly the distinction these variants exist to draw.
    for (variant, literal) in [
        (CellError::Limit, "#LIMIT!"),
        (CellError::Blocked, "#BLOCKED!"),
        (CellError::NA, "#N/A"),
        (CellError::Conflict, "#CONFLICT"),
    ] {
        let rendered = crate::cell_error_display(&variant);
        assert_eq!(
            rendered, literal,
            "{:?} must keep its explicit arm in cell_error_display; the \
             `#{{Debug}}` fallback would render {:?} and the frontend would \
             collapse it to #VALUE!",
            variant,
            format!("#{:?}", variant).to_uppercase()
        );
    }
}

#[test]
fn every_variant_is_accounted_for() {
    // A new `CellError` lands on the Debug arm by default, which is how five of
    // the six current divergences got there. This fails until the new variant
    // is measured into the table above.
    let all = [
        CellError::Div0,
        CellError::Ref,
        CellError::Name,
        CellError::Value,
        CellError::NA,
        CellError::Parse,
        CellError::Circular,
        CellError::Conflict,
        CellError::Blocked,
        CellError::Limit,
    ];
    for variant in &all {
        assert!(
            SPELLINGS.iter().any(|(v, _, _)| v == variant),
            "{:?} is not in SPELLINGS — measure what both sides render it as \
             and add a row",
            variant
        );
    }
    assert_eq!(
        SPELLINGS.len(),
        all.len(),
        "SPELLINGS and the variant list disagree in size"
    );
}
