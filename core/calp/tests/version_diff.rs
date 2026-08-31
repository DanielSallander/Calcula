//! FILENAME: core/calp/tests/version_diff.rs
//! PURPOSE: What the diff engine reports about two real published versions, and
//! about a working copy against the version it came from.
//! CONTEXT: The engine's job is to answer "what changed" without lying in
//! either direction — no invented changes (the identity-republish case) and no
//! missed ones (every change class below). The refresh preview used to answer
//! this question with a hardcoded zero, so the bar is: whatever this reports,
//! a person should be able to act on.

use std::collections::HashMap;

use tempfile::TempDir;

use calp::diff::{diff_sheet_cells, diff_sides, DiffOptions, DiffSide};
use calp::memory_workspace::MemoryWorkspace;
use calp::publish::{self, PublishRequest, PushMode};
use calp::workspace::LocalWorkspace;
use calp::transport::WorkspaceTransport;
use calp::version::SemVer;

use engine::cell::Cell;
use persistence::{SavedCell, SavedScript, Sheet, Workbook};

const PKG: &str = "diffed";

/// A two-sheet workbook with values, a formula, a named range and a module
/// script — one of each thing the classifier routes differently.
fn base_workbook() -> Workbook {
    let mut wb = Workbook::default();
    wb.sheets = Vec::new();

    let mut dashboard = Sheet::new("Dashboard".to_string());
    dashboard
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_text("Total".to_string())));
    dashboard
        .cells
        .insert((0, 1), SavedCell::from_cell(&Cell::new_number(100.0)));
    dashboard
        .cells
        .insert((1, 1), SavedCell::from_cell(&Cell::new_number(200.0)));

    let mut data = Sheet::new("Data".to_string());
    for r in 0..5u32 {
        data.cells
            .insert((r, 0), SavedCell::from_cell(&Cell::new_number((r * 10) as f64)));
    }

    wb.sheets = vec![dashboard, data];
    wb.scripts = vec![SavedScript {
        id: "mod-1".to_string(),
        name: "helpers".to_string(),
        description: None,
        source: "export function total(a, b) { return a + b; }".to_string(),
        scope: persistence::SavedScriptScope::default(),
        source_package: None,
    }];
    wb
}

fn publish_version(
    reg: &dyn WorkspaceTransport,
    prof: &std::path::Path,
    wb: &Workbook,
    version: SemVer,
    mode: PushMode,
) {
    let request = PublishRequest {
        workbook: wb,
        package_name: PKG.to_string(),
        version,
        kind: "report".to_string(),
        mode,
        change_summary: "a change".to_string(),
        sheet_indices: vec![0, 1],
        now: "2026-08-29T00:00:00Z".to_string(),
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

struct Fixture {
    _dir: TempDir,
    _prof: TempDir,
    reg: LocalWorkspace,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        Self { _dir: dir, _prof: prof, reg }
    }

    fn publish(&self, wb: &Workbook, version: SemVer, mode: PushMode) {
        publish_version(&self.reg, self._prof.path(), wb, version, mode);
    }

    fn diff(&self, from: &str, to: &str) -> calp::diff::VersionDiff {
        let from_manifest = self.reg.get_version_manifest(PKG, from).unwrap();
        let to_manifest = self.reg.get_version_manifest(PKG, to).unwrap();
        diff_sides(
            &DiffSide::Published {
                transport: &self.reg,
                package: PKG,
                version: from,
                manifest: &from_manifest,
            },
            &DiffSide::Published {
                transport: &self.reg,
                package: PKG,
                version: to,
                manifest: &to_manifest,
            },
            &DiffOptions::default(),
        )
        .expect("diff failed")
    }
}

// ---------------------------------------------------------------------------

#[test]
fn republishing_identical_content_reports_nothing_changed() {
    // THE false-positive guard. Two versions of the same workbook must produce
    // an empty diff — otherwise every "what changed" view opens with a wall of
    // changes nobody made, and people stop reading it.
    let f = Fixture::new();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);
    f.publish(
        &wb,
        SemVer::new(1, 0, 1),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let diff = f.diff("1.0.0", "1.0.1");
    assert_eq!(diff.totals.cells_changed, 0, "no cells changed");
    assert_eq!(diff.totals.objects_added, 0);
    assert_eq!(diff.totals.objects_removed, 0);
    assert_eq!(diff.totals.objects_modified, 0);
    assert!(
        diff.artifacts.changed.is_empty(),
        "no artifact should be reported as changed: {:?}",
        diff.artifacts.changed
    );
    assert_eq!(
        diff.artifacts.spurious_hash_changes, 0,
        "and no hash should have differed either — a nonzero count here means \
         serialization has become order-dependent again"
    );
    assert!(diff.sheets.iter().all(|s| s.change == "unchanged" || s.cells_added + s.cells_removed + s.cells_modified == 0));
}

#[test]
fn a_value_change_is_reported_with_its_cell_and_its_before_and_after() {
    let f = Fixture::new();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut v2 = base_workbook();
    v2.sheets[0]
        .cells
        .insert((0, 1), SavedCell::from_cell(&Cell::new_number(250.0)));
    // Same sheet identity as v1 — a push from a checked-out copy.
    v2.sheets[0].id = wb.sheets[0].id;
    v2.sheets[1].id = wb.sheets[1].id;
    f.publish(
        &v2,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let diff = f.diff("1.0.0", "1.1.0");
    assert_eq!(diff.totals.cells_changed, 1, "exactly one cell changed");
    assert!(diff.totals.cells_changed_exact);

    let dashboard = diff
        .sheets
        .iter()
        .find(|s| s.name == "Dashboard")
        .expect("the edited sheet is reported");
    assert_eq!(dashboard.cells_modified, 1);
    assert_eq!(dashboard.formula_changes, 0, "a value change is not a formula change");
    let cell = &dashboard.sample[0];
    assert_eq!(cell.a1, "B1");
    assert_eq!(cell.change, "modified");
    assert_eq!(cell.before.as_ref().unwrap().display, "100.0");
    assert_eq!(cell.after.as_ref().unwrap().display, "250.0");

    let data = diff.sheets.iter().find(|s| s.name == "Data");
    assert!(
        data.is_none() || data.unwrap().cells_modified == 0,
        "the untouched sheet must not be reported as changed"
    );
}

#[test]
fn added_and_removed_cells_and_formula_edits_are_distinguished() {
    let f = Fixture::new();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut v2 = base_workbook();
    v2.sheets[0].id = wb.sheets[0].id;
    v2.sheets[1].id = wb.sheets[1].id;
    // A formula where there was a value.
    v2.sheets[0].cells.insert(
        (1, 1),
        SavedCell::from_cell(&Cell::new_formula("B1*2".to_string())),
    );
    // An added cell and a removed one.
    v2.sheets[0]
        .cells
        .insert((2, 1), SavedCell::from_cell(&Cell::new_number(7.0)));
    v2.sheets[1].cells.remove(&(4, 0));
    f.publish(
        &v2,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let diff = f.diff("1.0.0", "1.1.0");
    let dashboard = diff.sheets.iter().find(|s| s.name == "Dashboard").unwrap();
    assert_eq!(dashboard.cells_added, 1, "C2 is new");
    assert_eq!(dashboard.cells_modified, 1, "B2 became a formula");
    assert_eq!(
        dashboard.formula_changes, 1,
        "…and that IS a formula change, unlike a plain value edit"
    );

    let data = diff.sheets.iter().find(|s| s.name == "Data").unwrap();
    assert_eq!(data.cells_removed, 1, "A5 was deleted");
    assert_eq!(diff.totals.cells_changed, 3);
}

#[test]
fn a_renamed_sheet_is_reported_as_renamed_not_as_a_deletion() {
    let f = Fixture::new();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut v2 = base_workbook();
    v2.sheets[0].id = wb.sheets[0].id;
    v2.sheets[1].id = wb.sheets[1].id;
    v2.sheets[0].name = "Summary".to_string();
    f.publish(
        &v2,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let diff = f.diff("1.0.0", "1.1.0");
    let renamed = diff
        .sheets
        .iter()
        .find(|s| s.sheet_id == wb.sheets[0].id.to_string())
        .expect("the sheet is reported");
    assert_eq!(renamed.change, "renamed");
    assert_eq!(renamed.name, "Summary");
    assert_eq!(renamed.renamed_from.as_deref(), Some("Dashboard"));
    assert!(
        !diff.sheets.iter().any(|s| s.change == "removed"),
        "a rename is not a deletion — identity survived, so the subscriber's \
         overrides on that sheet survive too"
    );
}

#[test]
fn an_added_sheet_is_reported_as_added() {
    let f = Fixture::new();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut v2 = base_workbook();
    v2.sheets[0].id = wb.sheets[0].id;
    v2.sheets[1].id = wb.sheets[1].id;
    let mut extra = Sheet::new("Notes".to_string());
    extra
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_text("hi".to_string())));
    v2.sheets.push(extra);
    let request_indices = vec![0, 1, 2];
    let request = PublishRequest {
        workbook: &v2,
        package_name: PKG.to_string(),
        version: SemVer::new(1, 1, 0),
        kind: "report".to_string(),
        mode: PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        change_summary: "adds Notes".to_string(),
        sheet_indices: request_indices,
        now: "2026-08-29T00:00:00Z".to_string(),
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
    publish::publish(&f.reg, &request, f._prof.path()).unwrap();

    let diff = f.diff("1.0.0", "1.1.0");
    let added = diff
        .sheets
        .iter()
        .find(|s| s.name == "Notes")
        .expect("the new sheet is reported");
    assert_eq!(added.change, "added");
}

#[test]
fn a_changed_module_script_reports_its_source_before_and_after() {
    let f = Fixture::new();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut v2 = base_workbook();
    v2.sheets[0].id = wb.sheets[0].id;
    v2.sheets[1].id = wb.sheets[1].id;
    v2.scripts[0].source = "export function total(a, b) { return a + b + 1; }".to_string();
    f.publish(
        &v2,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let diff = f.diff("1.0.0", "1.1.0");
    let script = diff
        .objects
        .iter()
        .find(|o| o.domain == "moduleScript")
        .expect("the changed script is reported");
    assert_eq!(script.change, "modified");
    assert!(
        script.before.as_deref().unwrap().contains("a + b;"),
        "the reader has to see the code, not just be told it changed"
    );
    assert!(script.after.as_deref().unwrap().contains("a + b + 1;"));
    assert!(!script.before_truncated && !script.after_truncated);
}

#[test]
fn the_drill_down_returns_every_changed_cell_up_to_its_cap() {
    let f = Fixture::new();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut v2 = base_workbook();
    v2.sheets[0].id = wb.sheets[0].id;
    v2.sheets[1].id = wb.sheets[1].id;
    for r in 0..5u32 {
        v2.sheets[1]
            .cells
            .insert((r, 0), SavedCell::from_cell(&Cell::new_number((r * 11) as f64)));
    }
    f.publish(
        &v2,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let from_manifest = f.reg.get_version_manifest(PKG, "1.0.0").unwrap();
    let to_manifest = f.reg.get_version_manifest(PKG, "1.1.0").unwrap();
    let from = DiffSide::Published {
        transport: &f.reg,
        package: PKG,
        version: "1.0.0",
        manifest: &from_manifest,
    };
    let to = DiffSide::Published {
        transport: &f.reg,
        package: PKG,
        version: "1.1.0",
        manifest: &to_manifest,
    };

    let sheet_id = wb.sheets[1].id.to_string();
    let full = diff_sheet_cells(&from, &to, &sheet_id, 1000, &HashMap::new()).unwrap();
    // Row 0 is 0 in both (0*10 == 0*11), so four cells actually differ.
    assert_eq!(full.total_changes, 4);
    assert_eq!(full.changes.len(), 4);
    assert!(!full.truncated);

    let capped = diff_sheet_cells(&from, &to, &sheet_id, 2, &HashMap::new()).unwrap();
    assert_eq!(capped.total_changes, 4, "the TOTAL is still the truth");
    assert_eq!(capped.changes.len(), 2, "only the returned list is capped");
    assert!(capped.truncated, "and it says so");
}

#[test]
fn a_working_copy_diffs_against_the_version_it_came_from() {
    // The push-time preview, end to end: publish v1, edit, run the REAL publish
    // into memory, and diff. No second serializer, so the preview cannot
    // describe an application the push would not write.
    let f = Fixture::new();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut working = base_workbook();
    working.sheets[0].id = wb.sheets[0].id;
    working.sheets[1].id = wb.sheets[1].id;
    working.sheets[0]
        .cells
        .insert((5, 0), SavedCell::from_cell(&Cell::new_text("added by me".to_string())));

    let mem = MemoryWorkspace::new();
    publish_version(
        &mem,
        f._prof.path(),
        &working,
        SemVer::new(1, 1, 0),
        PushMode::CreateNew,
    );

    let base_manifest = f.reg.get_version_manifest(PKG, "1.0.0").unwrap();
    let mem_manifest = mem.get_version_manifest(PKG, "1.1.0").unwrap();
    let artifacts = mem.artifacts_of(PKG, "1.1.0");
    let diff = diff_sides(
        &DiffSide::Published {
            transport: &f.reg,
            package: PKG,
            version: "1.0.0",
            manifest: &base_manifest,
        },
        &DiffSide::InMemory { manifest: &mem_manifest, artifacts: &artifacts },
        &DiffOptions::default(),
    )
    .unwrap();

    assert_eq!(diff.to_version, "working copy");
    assert_eq!(diff.totals.cells_changed, 1);
    let dashboard = diff.sheets.iter().find(|s| s.name == "Dashboard").unwrap();
    assert_eq!(dashboard.cells_added, 1);
    assert_eq!(dashboard.sample[0].a1, "A6");
}

#[test]
fn an_unedited_working_copy_diffs_to_nothing() {
    // The positive control for the case above. If this reported changes, the
    // push dialog would show a diff for every push, and the diff would mean
    // nothing.
    let f = Fixture::new();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mem = MemoryWorkspace::new();
    publish_version(&mem, f._prof.path(), &wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let base_manifest = f.reg.get_version_manifest(PKG, "1.0.0").unwrap();
    let mem_manifest = mem.get_version_manifest(PKG, "1.0.0").unwrap();
    let artifacts = mem.artifacts_of(PKG, "1.0.0");
    let diff = diff_sides(
        &DiffSide::Published {
            transport: &f.reg,
            package: PKG,
            version: "1.0.0",
            manifest: &base_manifest,
        },
        &DiffSide::InMemory { manifest: &mem_manifest, artifacts: &artifacts },
        &DiffOptions::default(),
    )
    .unwrap();

    assert_eq!(diff.totals.cells_changed, 0);
    assert_eq!(diff.totals.objects_modified, 0);
    assert!(diff.artifacts.changed.is_empty(), "{:?}", diff.artifacts.changed);
}

#[test]
fn a_working_copy_with_remapped_sheet_ids_still_diffs_in_place() {
    // A workbook that SUBSCRIBED to the application carries its own local sheet
    // ids. Without the remap every sheet would read as removed-and-added; with
    // it, the diff is about content again.
    let f = Fixture::new();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut local = base_workbook(); // fresh ids, as a pull would mint
    local.sheets[0]
        .cells
        .insert((0, 1), SavedCell::from_cell(&Cell::new_number(999.0)));

    let mem = MemoryWorkspace::new();
    publish_version(&mem, f._prof.path(), &local, SemVer::new(1, 1, 0), PushMode::CreateNew);

    let mut sheet_id_map = HashMap::new();
    sheet_id_map.insert(local.sheets[0].id.to_string(), wb.sheets[0].id.to_string());
    sheet_id_map.insert(local.sheets[1].id.to_string(), wb.sheets[1].id.to_string());

    let base_manifest = f.reg.get_version_manifest(PKG, "1.0.0").unwrap();
    let mem_manifest = mem.get_version_manifest(PKG, "1.1.0").unwrap();
    let artifacts = mem.artifacts_of(PKG, "1.1.0");
    let diff = diff_sides(
        &DiffSide::Published {
            transport: &f.reg,
            package: PKG,
            version: "1.0.0",
            manifest: &base_manifest,
        },
        &DiffSide::InMemory { manifest: &mem_manifest, artifacts: &artifacts },
        &DiffOptions { sheet_id_map, ..DiffOptions::default() },
    )
    .unwrap();

    assert_eq!(diff.totals.cells_changed, 1, "one cell, not two whole sheets");
    assert!(
        !diff.sheets.iter().any(|s| s.change == "removed" || s.change == "added"),
        "with the remap in place nothing is added or removed: {:?}",
        diff.sheets.iter().map(|s| (&s.name, &s.change)).collect::<Vec<_>>()
    );
}

#[test]
fn a_publisher_key_change_is_reported_loudly() {
    // Under one TOFU pin this should be impossible, which is exactly why a diff
    // must surface it rather than treat it as metadata noise: it is what an
    // application hijack looks like from the subscriber's side.
    let f = Fixture::new();
    let other_profile = TempDir::new().unwrap();
    let wb = base_workbook();
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    // Publish v1.1.0 with a DIFFERENT profile, bypassing the push gate by
    // writing straight through core with CreateNew into a second workspace.
    let dir2 = TempDir::new().unwrap();
    let reg2 = LocalWorkspace::open(dir2.path()).unwrap();
    publish_version(
        &reg2,
        other_profile.path(),
        &wb,
        SemVer::new(1, 0, 0),
        PushMode::CreateNew,
    );

    let m1 = f.reg.get_version_manifest(PKG, "1.0.0").unwrap();
    let m2 = reg2.get_version_manifest(PKG, "1.0.0").unwrap();
    let diff = diff_sides(
        &DiffSide::Published {
            transport: &f.reg,
            package: PKG,
            version: "1.0.0",
            manifest: &m1,
        },
        &DiffSide::Published {
            transport: &reg2,
            package: PKG,
            version: "1.0.0",
            manifest: &m2,
        },
        &DiffOptions::default(),
    )
    .unwrap();

    assert!(
        diff.manifest_changes.iter().any(|c| c.field == "publisherKey"),
        "a different signer must be reported: {:?}",
        diff.manifest_changes
    );
}

// ---------------------------------------------------------------------------
// Merge analysis over REAL diffs
// ---------------------------------------------------------------------------

/// Two developers, one application, disjoint cells on the SAME sheet.
///
/// The unit tests in `merge.rs` prove the analysis over hand-built diffs; this
/// proves it over diffs the engine actually produced from published applications,
/// which is where a mismatch between what the diff reports and what the merge
/// reads would show up.
#[test]
fn two_developers_editing_different_cells_of_one_sheet_can_both_land() {
    let f = Fixture::new();
    let base = base_workbook();
    f.publish(&base, SemVer::new(1, 0, 0), PushMode::CreateNew);

    // Alice edits B1 and publishes.
    let mut alice = base_workbook();
    alice.sheets[0].id = base.sheets[0].id;
    alice.sheets[1].id = base.sheets[1].id;
    alice
        .sheets[0]
        .cells
        .insert((0, 1), SavedCell::from_cell(&Cell::new_number(111.0)));
    f.publish(
        &alice,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    // Bob, still on v1.0.0, edited B2 in his working copy.
    let mut bob = base_workbook();
    bob.sheets[0].id = base.sheets[0].id;
    bob.sheets[1].id = base.sheets[1].id;
    bob.sheets[0]
        .cells
        .insert((1, 1), SavedCell::from_cell(&Cell::new_number(222.0)));

    let mem = MemoryWorkspace::new();
    publish_version(&mem, f._prof.path(), &bob, SemVer::new(9, 9, 9), PushMode::CreateNew);

    let theirs = f.diff("1.0.0", "1.1.0");
    let base_manifest = f.reg.get_version_manifest(PKG, "1.0.0").unwrap();
    let bob_manifest = mem.get_version_manifest(PKG, "9.9.9").unwrap();
    let bob_artifacts = mem.artifacts_of(PKG, "9.9.9");
    let yours = diff_sides(
        &DiffSide::Published {
            transport: &f.reg,
            package: PKG,
            version: "1.0.0",
            manifest: &base_manifest,
        },
        &DiffSide::InMemory { manifest: &bob_manifest, artifacts: &bob_artifacts },
        &DiffOptions::default(),
    )
    .unwrap();

    let analysis = calp::merge::analyze(&theirs, &yours);
    assert_eq!(
        analysis.verdict,
        calp::merge::MergeVerdict::CanMerge,
        "B1 and B2 are different pieces: {:?}",
        analysis.collisions
    );
    assert!(analysis.collisions.is_empty());
    assert_eq!(analysis.their_summary, vec!["changed 1 cell on 'Dashboard'"]);
    assert_eq!(analysis.your_summary, vec!["changed 1 cell on 'Dashboard'"]);
}

/// The same two developers, editing the SAME cell.
#[test]
fn two_developers_editing_one_cell_is_a_conflict_that_names_the_cell() {
    let f = Fixture::new();
    let base = base_workbook();
    f.publish(&base, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut alice = base_workbook();
    alice.sheets[0].id = base.sheets[0].id;
    alice.sheets[1].id = base.sheets[1].id;
    alice
        .sheets[0]
        .cells
        .insert((0, 1), SavedCell::from_cell(&Cell::new_number(111.0)));
    f.publish(
        &alice,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let mut bob = base_workbook();
    bob.sheets[0].id = base.sheets[0].id;
    bob.sheets[1].id = base.sheets[1].id;
    bob.sheets[0]
        .cells
        .insert((0, 1), SavedCell::from_cell(&Cell::new_number(222.0)));

    let mem = MemoryWorkspace::new();
    publish_version(&mem, f._prof.path(), &bob, SemVer::new(9, 9, 9), PushMode::CreateNew);

    let theirs = f.diff("1.0.0", "1.1.0");
    let base_manifest = f.reg.get_version_manifest(PKG, "1.0.0").unwrap();
    let bob_manifest = mem.get_version_manifest(PKG, "9.9.9").unwrap();
    let bob_artifacts = mem.artifacts_of(PKG, "9.9.9");
    let yours = diff_sides(
        &DiffSide::Published {
            transport: &f.reg,
            package: PKG,
            version: "1.0.0",
            manifest: &base_manifest,
        },
        &DiffSide::InMemory { manifest: &bob_manifest, artifacts: &bob_artifacts },
        &DiffOptions::default(),
    )
    .unwrap();

    let analysis = calp::merge::analyze(&theirs, &yours);
    assert_eq!(analysis.verdict, calp::merge::MergeVerdict::Conflict);
    assert_eq!(analysis.collisions.len(), 1);
    assert_eq!(
        analysis.collisions[0].description,
        "Dashboard!B1 was changed on both sides",
        "the refusal has to name the cell — 'there is a conflict' is not actionable"
    );
}

/// A module script one side changed while the other edited cells: disjoint
/// work, but bringing a script across is beyond what a working copy can be
/// patched with today, so the verdict distinguishes that from a collision.
#[test]
fn a_script_change_and_a_cell_edit_do_not_collide() {
    let f = Fixture::new();
    let base = base_workbook();
    f.publish(&base, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut alice = base_workbook();
    alice.sheets[0].id = base.sheets[0].id;
    alice.sheets[1].id = base.sheets[1].id;
    alice.scripts[0].source = "export function total(a, b) { return a * b; }".to_string();
    f.publish(
        &alice,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let mut bob = base_workbook();
    bob.sheets[0].id = base.sheets[0].id;
    bob.sheets[1].id = base.sheets[1].id;
    bob.sheets[0]
        .cells
        .insert((0, 1), SavedCell::from_cell(&Cell::new_number(999.0)));

    let mem = MemoryWorkspace::new();
    publish_version(&mem, f._prof.path(), &bob, SemVer::new(9, 9, 9), PushMode::CreateNew);

    let theirs = f.diff("1.0.0", "1.1.0");
    let base_manifest = f.reg.get_version_manifest(PKG, "1.0.0").unwrap();
    let bob_manifest = mem.get_version_manifest(PKG, "9.9.9").unwrap();
    let bob_artifacts = mem.artifacts_of(PKG, "9.9.9");
    let yours = diff_sides(
        &DiffSide::Published {
            transport: &f.reg,
            package: PKG,
            version: "1.0.0",
            manifest: &base_manifest,
        },
        &DiffSide::InMemory { manifest: &bob_manifest, artifacts: &bob_artifacts },
        &DiffOptions::default(),
    )
    .unwrap();

    let analysis = calp::merge::analyze(&theirs, &yours);
    assert!(
        analysis.collisions.is_empty(),
        "a script and a cell are different pieces: {:?}",
        analysis.collisions
    );
    assert_eq!(analysis.verdict, calp::merge::MergeVerdict::CannotApply);

    // Reversed, it merges: their CELL change can be brought into a copy that
    // changed a script.
    let reversed = calp::merge::analyze(&yours, &theirs);
    assert_eq!(reversed.verdict, calp::merge::MergeVerdict::CanMerge);
}
