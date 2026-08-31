//! FILENAME: core/calp/tests/literal_values_round_trip.rs
//! PURPOSE: A published package must carry LITERAL cells, not only formulas.
//! CONTEXT: Reported 2026-08-30 — publish a sheet holding both hard-coded
//! values and formulas, subscribe from a fresh app, and only the formulas
//! arrive. This is the data-loss class the whole distribution story is judged
//! on, so it gets a test that fails loudly at whichever layer drops them.
//!
//! This file covers the CORE half: publish -> pull, with no app state involved.
//! If it passes, the loss is in the Tauri materialization layer; if it fails,
//! the package itself never carried the values.

use tempfile::TempDir;

use calp::integrity::PinPolicy;
use calp::publish::{self, PublishRequest, PushMode};
use calp::pull::{self, PullRequest};
use calp::registry::LocalRegistry;
use calp::transport::RegistryTransport;
use calp::version::{SemVer, VersionPin};

use engine::cell::Cell;
use persistence::{SavedCell, SavedCellValue, Sheet, Workbook};

/// A sheet shaped like the reported case: text literals, number literals, and
/// formulas that read them.
fn mixed_workbook() -> Workbook {
    let mut sheet = Sheet::new("Sheet1".to_string());
    // Literals.
    sheet
        .cells
        .insert((1, 1), SavedCell::from_cell(&Cell::new_text("Hello".to_string())));
    sheet.cells.insert((1, 2), SavedCell::from_cell(&Cell::new_number(10.0)));
    sheet
        .cells
        .insert((2, 1), SavedCell::from_cell(&Cell::new_text("World".to_string())));
    sheet.cells.insert((2, 2), SavedCell::from_cell(&Cell::new_number(20.0)));
    // A formula that reads them.
    sheet
        .cells
        .insert((3, 2), SavedCell::from_cell(&Cell::new_formula("C2+C3".to_string())));

    let mut wb = Workbook::default();
    wb.sheets = vec![sheet];
    wb
}

fn publish_it(reg: &LocalRegistry, prof: &std::path::Path, wb: &Workbook) {
    let request = PublishRequest {
        workbook: wb,
        package_name: "literals".to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: "first".to_string(),
        sheet_indices: vec![0],
        now: "2026-08-30T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        min_app_version: String::new(),
    };
    publish::publish(reg, &request, prof).expect("publish failed");
}

#[test]
fn the_published_artifact_contains_the_literal_cells() {
    // Layer 1: did the PACKAGE ever carry them? Read the artifact bytes rather
    // than any parsed convenience — if the values are not in the file, nothing
    // downstream can invent them.
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(dir.path()).unwrap();
    let wb = mixed_workbook();
    publish_it(&reg, prof.path(), &wb);

    let sheet_id = wb.sheets[0].id.to_string();
    let bytes = reg
        .read_artifact("literals", "1.0.0", &format!("sheets/{sheet_id}/data.json"))
        .unwrap()
        .expect("the sheet's data artifact exists");
    let text = String::from_utf8(bytes).unwrap();

    assert!(text.contains("Hello"), "the text literal must be in the artifact:\n{text}");
    assert!(text.contains("World"), "…and the second one");
    assert!(text.contains("10"), "…and the number literals");
    assert!(text.contains("20"));
    assert!(text.contains("C2+C3"), "…alongside the formula");
}

#[test]
fn a_pull_materializes_literals_as_well_as_formulas() {
    // Layer 2: does `pull()` hand them back? This is the boundary the app's
    // materializer receives.
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(dir.path()).unwrap();
    let scope = calp::registry_scope(dir.path().to_str().unwrap()).unwrap();
    let wb = mixed_workbook();
    publish_it(&reg, prof.path(), &wb);

    let pulled = pull::pull(
        &reg,
        &PullRequest {
            package_name: "literals".to_string(),
            version_pin: VersionPin::Latest,
            now: "2026-08-30T01:00:00Z".to_string(),
        },
        &scope,
        prof.path(),
        PinPolicy::PinOnFirstUse,
    )
    .unwrap();

    let sheet = &pulled.sheets[0].sheet;
    let cell_at = |r: u32, c: u32| sheet.cells.get(&(r, c));

    let b2 = cell_at(1, 1).expect("B2 (a text literal) must survive the pull");
    assert!(
        matches!(&b2.value, SavedCellValue::Text(t) if t == "Hello"),
        "B2 came back as {:?}",
        b2.value
    );
    let c2 = cell_at(1, 2).expect("C2 (a number literal) must survive the pull");
    assert!(
        matches!(&c2.value, SavedCellValue::Number(n) if (*n - 10.0).abs() < f64::EPSILON),
        "C2 came back as {:?}",
        c2.value
    );
    let b3 = cell_at(2, 1).expect("B3 must survive");
    assert!(matches!(&b3.value, SavedCellValue::Text(t) if t == "World"));
    let c3 = cell_at(2, 2).expect("C3 must survive");
    assert!(matches!(&c3.value, SavedCellValue::Number(n) if (*n - 20.0).abs() < f64::EPSILON));

    let d3 = cell_at(3, 2).expect("the formula cell must survive too");
    assert_eq!(
        d3.formula.as_deref(),
        Some("C2+C3"),
        "the formula is the thing that DID arrive in the report; it must keep arriving"
    );

    assert_eq!(
        sheet.cells.len(),
        5,
        "all five cells, not just the formula: {:?}",
        sheet.cells.keys().collect::<Vec<_>>()
    );
}

#[test]
fn a_checkout_materializes_literals_as_well_as_formulas() {
    // Layer 2b: the same question for the author-side path, since it shares the
    // artifact walk but takes a different sheet-id mode.
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(dir.path()).unwrap();
    let scope = calp::registry_scope(dir.path().to_str().unwrap()).unwrap();
    let wb = mixed_workbook();
    publish_it(&reg, prof.path(), &wb);

    let out = calp::checkout::checkout(
        &reg,
        "literals",
        None,
        "2026-08-30T01:00:00Z",
        &scope,
        prof.path(),
    )
    .unwrap();

    assert_eq!(
        out.sheets[0].sheet.cells.len(),
        5,
        "a working copy must carry the literals too: {:?}",
        out.sheets[0].sheet.cells.keys().collect::<Vec<_>>()
    );
}
