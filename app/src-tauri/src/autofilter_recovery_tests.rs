//! FILENAME: app/src-tauri/src/autofilter_recovery_tests.rs
//! PURPOSE: A malformed `autofilters.json` must not delete the autofilters that
//!          ARE readable, and must never be swallowed silently.
//! CONTEXT: BUG-0106. The `.cala` load path used to read the section with
//!          `if let Ok(all) = from_slice(..) { .. } else { auto_filters.clear() }`
//!          — so one unreadable byte anywhere deleted EVERY autofilter in the
//!          workbook, with no error, no log and nothing on screen. The document
//!          opened looking correct with the filters gone, and the next save wrote
//!          that emptiness back over the file that still had them.
//!
//!          The project's own `.cala` rule is the measure: dropping a section an
//!          older reader cannot understand is fine when the loss is VISIBLE, and
//!          a lie when the document "comes back looking calculated". A silent
//!          clear on a PARSE FAILURE is that lie without even a version mismatch
//!          to excuse it.
//!
//! WHAT THESE TESTS PIN is the recovery ARITHMETIC — that a per-sheet decode
//! keeps the good entries — because that is the part a future edit could quietly
//! undo while the load still "works". The reporting half (a `log_warn!` plus a
//! `document:load-warnings` event) needs a live `Window` and is asserted by
//! reading the source, so that a revert to the silent form fails here too.

use std::collections::HashMap;

/// The recovery the loader performs: decode per sheet, keep what parses.
///
/// Mirrors the production block rather than importing it, because that block is
/// inline in `open_file` behind a `State<AppState>` and a `Window`. The source
/// assertion at the bottom of this file is what stops the copy from drifting.
fn recover(json: &[u8]) -> (HashMap<usize, crate::autofilter::AutoFilter>, Vec<String>) {
    let mut lost: Vec<String> = Vec::new();
    let mut recovered: HashMap<usize, crate::autofilter::AutoFilter> = HashMap::new();
    match serde_json::from_slice::<HashMap<usize, serde_json::Value>>(json) {
        Ok(per_sheet) => {
            let mut keys: Vec<usize> = per_sheet.keys().copied().collect();
            keys.sort_unstable();
            for sheet in keys {
                match serde_json::from_value::<crate::autofilter::AutoFilter>(
                    per_sheet[&sheet].clone(),
                ) {
                    Ok(af) => {
                        recovered.insert(sheet, af);
                    }
                    Err(e) => lost.push(format!("sheet {}: {}", sheet, e)),
                }
            }
        }
        Err(e) => lost.push(format!("the whole section could not be read: {}", e)),
    }
    (recovered, lost)
}

/// A minimal filter that really round-trips through serde.
fn good_filter_json(start_row: u32) -> String {
    // `AutoFilter::new` is the real constructor, so the fixture cannot drift from
    // the shape the product builds.
    let af = crate::autofilter::AutoFilter::new(start_row, 0, start_row + 10, 3);
    serde_json::to_string(&af).expect("the fixture filter must serialize")
}

#[test]
fn one_corrupt_sheet_does_not_cost_the_others() {
    // THE DEFECT, in one assertion. Sheet 1 is unreadable; sheets 0 and 2 are
    // perfect. The old code returned NOTHING for all three.
    let json = format!(
        r#"{{"0":{},"1":{{"startRow":"not a number"}},"2":{}}}"#,
        good_filter_json(0),
        good_filter_json(100),
    );
    let (recovered, lost) = recover(json.as_bytes());

    assert_eq!(
        recovered.len(),
        2,
        "a corrupt entry for ONE sheet destroyed the readable filters on the others"
    );
    assert!(recovered.contains_key(&0));
    assert!(recovered.contains_key(&2));
    assert!(!recovered.contains_key(&1), "the corrupt entry must not be invented");
    assert_eq!(lost.len(), 1, "the loss must be reported, not swallowed");
    assert!(
        lost[0].contains("sheet 1"),
        "the report must NAME the sheet that lost its filter: {lost:?}"
    );
}

#[test]
fn a_wholly_unreadable_section_is_reported_rather_than_swallowed() {
    // Nothing is recoverable here, and that is allowed — the sin was silence.
    let (recovered, lost) = recover(b"this is not json at all");
    assert!(recovered.is_empty());
    assert_eq!(lost.len(), 1);
    assert!(
        lost[0].contains("whole section"),
        "a total failure must say so: {lost:?}"
    );
}

#[test]
fn a_fully_valid_section_loses_nothing_and_reports_nothing() {
    // Non-vacuity: a recovery that reported on every load would make the two
    // cases above pass while crying wolf on every healthy document.
    let json = format!(r#"{{"0":{},"1":{}}}"#, good_filter_json(0), good_filter_json(50));
    let (recovered, lost) = recover(json.as_bytes());
    assert_eq!(recovered.len(), 2);
    assert!(lost.is_empty(), "a healthy section must produce no warning: {lost:?}");
    assert_eq!(recovered[&0].start_row, 0);
    assert_eq!(recovered[&1].start_row, 50);
}

#[test]
fn an_empty_object_is_not_a_failure() {
    // `{}` is a document that HAS the section and has no filters in it. Distinct
    // from a parse failure, and must not be reported as one.
    let (recovered, lost) = recover(b"{}");
    assert!(recovered.is_empty());
    assert!(lost.is_empty());
}

#[test]
fn the_loader_still_recovers_per_sheet_and_still_reports() {
    // The copy above can drift from the real block; this reads the real block.
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/persistence.rs"),
    )
    .expect("persistence.rs must be readable");

    // The per-sheet decode.
    assert!(
        src.contains("HashMap<usize, serde_json::Value>"),
        "the loader no longer decodes autofilters per sheet, so one corrupt entry \
         costs the whole workbook again"
    );
    // The report, in both places.
    assert!(
        src.contains("document:load-warnings"),
        "the loader no longer tells the FRONTEND that filters were lost"
    );
    assert!(
        src.contains("autofilters.json: {} entr"),
        "the loader no longer logs which autofilter entries were lost"
    );
    // And the exact shape that caused the bug must not come back.
    assert!(
        !src.contains(
            "serde_json::from_slice::<crate::autofilter::AutoFilterStorage>(&json_bytes)"
        ),
        "the whole-section decode is back: a single unreadable byte will again \
         delete every autofilter in the workbook silently"
    );
}
