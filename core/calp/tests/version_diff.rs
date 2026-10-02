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

/// A floating range whose object row moved between versions, plus a timeline
/// added in the second version. Both families have their own artifacts now, so
/// both must be named in the diff by their own domain -- never fall through to
/// the "artifact" catch-all ("Other application files").
#[test]
fn a_moved_floating_range_and_an_added_timeline_are_reported_by_domain() {
    let f = Fixture::new();
    let entity = || identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let fr_id = entity();
    let pivot_id = entity();
    let timeline_id = entity();
    let floating_at = |x: f64, host: identity::SheetId, backing: identity::SheetId| {
        persistence::SavedFloatingRange {
            id: fr_id,
            backing_sheet_id: backing,
            host_sheet_id: host,
            x,
            y: 32.0,
            rotation: 0.0,
            pin_to_grid: false,
            row_count: 5,
            col_count: 2,
            col_widths: [(0u32, 110.0), (1, 70.0), (2, 90.0)].into_iter().collect(),
            row_heights: HashMap::new(),
            show_title: true,
            show_column_headers: true,
            show_row_headers: true,
        }
    };
    let pivot = persistence::SavedPivotDefinition {
        id: pivot_id,
        source_type: "grid".to_string(),
        source_sheet_index: Some(1),
        definition: serde_json::json!({ "name": "ByMonth", "destination_sheet": "Dashboard" }),
    };

    // v1: the "Data" sheet doubles as the floating range's backing sheet
    // (publish_version ships both sheets).
    let mut wb = base_workbook();
    let (host, backing) = (wb.sheets[0].id, wb.sheets[1].id);
    wb.floating_ranges = vec![floating_at(10.0, host, backing)];
    wb.pivot_definitions = vec![pivot.clone()];
    f.publish(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew);

    // v1.1: the SAME range, moved; and a timeline that did not exist before.
    let mut v2 = base_workbook();
    v2.sheets[0].id = host;
    v2.sheets[1].id = backing;
    v2.floating_ranges = vec![floating_at(250.0, host, backing)];
    v2.pivot_definitions = vec![pivot];
    v2.timeline_slicers = vec![persistence::SavedTimelineSlicer {
        id: timeline_id,
        name: "Dates".to_string(),
        header_text: None,
        sheet_id: host,
        x: 0.0,
        y: 300.0,
        width: 400.0,
        height: 110.0,
        source_type: persistence::SavedTimelineSourceType::Pivot,
        source_id: pivot_id,
        field_name: "When".to_string(),
        level: persistence::SavedTimelineLevel::Months,
        selection_start: None,
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: true,
        style_preset: "TimelineStyleLight1".to_string(),
        connected_pivot_ids: Vec::new(),
    }];
    f.publish(
        &v2,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    let diff = f.diff("1.0.0", "1.1.0");
    let moved: Vec<_> = diff.objects.iter().filter(|o| o.domain == "floatingRange").collect();
    assert_eq!(moved.len(), 1, "one range, one row: {:#?}", diff.objects);
    assert_eq!(moved[0].change, "modified");
    assert_eq!(moved[0].id, fr_id.to_string(), "keyed by the range's stable id");
    assert_eq!(moved[0].artifact_path.as_deref(), Some("floating_ranges.json"));

    let added: Vec<_> = diff.objects.iter().filter(|o| o.domain == "timelineSlicer").collect();
    assert_eq!(added.len(), 1, "{:#?}", diff.objects);
    assert_eq!(added[0].change, "added");
    assert_eq!(added[0].name, "Dates");

    assert!(
        !diff.objects.iter().any(|o| o.domain == "artifact"),
        "nothing may fall through to the catch-all: {:#?}",
        diff.objects
    );
}

// ---------------------------------------------------------------------------
// BUG-0151: a collision rename's round trip is not an edit
// ---------------------------------------------------------------------------

/// The TS chart store's envelope, in ITS key order (not alphabetical).
const CHART_SPEC: &str = r#"{"chartId":1,"name":"Sales","sheetIndex":1,"x":10,"y":10,"width":300,"height":200,"spec":{"mark":"bar","data":"Data!A1:B5"}}"#;

/// ["Data" (A1 = 21), "Report" (A1 = Data!A1*2)], a defined name and a chart
/// string source that both name "Data" -- the three places a checkout's
/// collision rename rewrites.
fn data_and_report() -> Workbook {
    let mut data = Sheet::new("Data".to_string());
    data.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(21.0)));
    let mut report = Sheet::new("Report".to_string());
    report
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_formula("Data!A1*2".to_string())));
    let report_id = report.id;
    let mut wb = Workbook::default();
    wb.sheets = vec![data, report];
    wb.named_ranges = vec![persistence::SavedNamedRange {
        name: "Rate".to_string(),
        refers_to: "=DATA!$A$1".to_string(),
        sheet_id: None,
        comment: None,
        folder: None,
    }];
    wb.charts = vec![persistence::SavedChart {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        sheet_id: report_id,
        spec_json: CHART_SPEC.to_string(),
    }];
    wb
}

/// What an UNTOUCHED working copy ships: the author owns a "Data", so the
/// checkout renamed the application's references to "Data (2)", and the push
/// renamed them back (`restore_published_sheet_references` in the host) --
/// the same two rewrites, nothing else.
fn through_a_checkout_rename_and_back(wb: &Workbook) -> Workbook {
    let mut w = wb.clone();
    let checkout = calp::sheet_renames::SheetRenames::new([("Data", "Data (2)")]);
    let push = calp::sheet_renames::SheetRenames::new([("data (2)", "Data")]);
    for renames in [&checkout, &push] {
        for sheet in w.sheets.iter_mut() {
            renames.rename_sheet_formulas(sheet);
        }
        for nr in w.named_ranges.iter_mut() {
            if let Some(text) = renames.rename_formula(&nr.refers_to) {
                nr.refers_to = text;
            }
        }
        for chart in w.charts.iter_mut() {
            if let Some(spec) =
                calp::chart_refs::rename_chart_spec_sheet_names(&chart.spec_json, renames)
            {
                chart.spec_json = spec;
            }
        }
    }
    w
}

/// The working copy diffed against its base, the way the push preview and the
/// merge analysis take it: published into memory, compared with the base.
fn yours_against(f: &Fixture, base: &str, working: &Workbook) -> calp::diff::VersionDiff {
    let mem = MemoryWorkspace::new();
    publish_version(&mem, f._prof.path(), working, SemVer::new(9, 9, 9), PushMode::CreateNew);
    let base_manifest = f.reg.get_version_manifest(PKG, base).unwrap();
    let manifest = mem.get_version_manifest(PKG, "9.9.9").unwrap();
    let artifacts = mem.artifacts_of(PKG, "9.9.9");
    diff_sides(
        &DiffSide::Published {
            transport: &f.reg,
            package: PKG,
            version: base,
            manifest: &base_manifest,
        },
        &DiffSide::InMemory { manifest: &manifest, artifacts: &artifacts },
        &DiffOptions::default(),
    )
    .unwrap()
}

/// AN UNTOUCHED WORKING COPY HAS NOTHING TO PUSH. The rename round trip is not
/// the identity on bytes: the lexer stored the author's `Data!A1*2` as
/// `DATA!A1*2` and it comes home as `Data!A1*2`; the defined name likewise;
/// and the chart's spec is re-serialized with its keys SORTED. Byte-wise the
/// push preview listed all three as changed, the push shipped them to every
/// subscriber, and the published version's own diff said so too.
///
/// SABOTAGE: compare `f` byte-wise in `cells_equal`, or items with `==` in
/// `push_grouped` -- each turns its row back on.
#[test]
fn an_untouched_working_copy_through_a_collision_rename_reports_nothing() {
    let f = Fixture::new();
    let base = data_and_report();
    f.publish(&base, SemVer::new(1, 0, 0), PushMode::CreateNew);
    let working = through_a_checkout_rename_and_back(&base);
    // Preconditions: the round trip really did re-spell all three.
    assert_ne!(working.sheets[1].cells[&(0, 0)].formula, base.sheets[1].cells[&(0, 0)].formula);
    assert_ne!(working.named_ranges[0].refers_to, base.named_ranges[0].refers_to);
    assert_ne!(working.charts[0].spec_json, base.charts[0].spec_json);

    let preview = yours_against(&f, "1.0.0", &working);
    f.publish(
        &working,
        SemVer::new(1, 0, 1),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );
    let shipped = f.diff("1.0.0", "1.0.1");
    for (what, diff) in [("the push preview", &preview), ("the shipped version", &shipped)] {
        assert_eq!(diff.totals.cells_changed, 0, "{what}: {:?}", diff.sheets);
        assert!(
            diff.objects.is_empty(),
            "{what}: the author changed nothing: {:?}",
            diff.objects.iter().map(|o| (&o.domain, &o.change)).collect::<Vec<_>>()
        );
    }

    // ...while a REAL edit through the same round trip is still a change.
    let mut edited = working.clone();
    edited.sheets[1]
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_formula("Data!A1*3".to_string())));
    let diff = yours_against(&f, "1.0.0", &edited);
    assert_eq!(diff.totals.cells_changed, 1);
    assert_eq!(diff.sheets.iter().map(|s| s.formula_changes).sum::<usize>(), 1);
}

/// AND IT DOES NOT COLLIDE WITH A TEAMMATE. A teammate who really edited the
/// cell (or the chart) the round trip merely re-spelled has not conflicted
/// with an author who never touched it. Byte-wise both read as "changed on
/// both sides": a refused merge for the cell, and a false Conflict for the
/// chart where the honest answer is "this build cannot apply a chart".
///
/// SABOTAGE: the same two as above.
#[test]
fn a_re_spelled_piece_does_not_collide_with_a_teammates_real_edit() {
    let f = Fixture::new();
    let base = data_and_report();
    f.publish(&base, SemVer::new(1, 0, 0), PushMode::CreateNew);
    let mut theirs_cell = base.clone();
    theirs_cell.sheets[1]
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_formula("Data!A1*4".to_string())));
    f.publish(
        &theirs_cell,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );
    let mut theirs_chart = base.clone();
    theirs_chart.charts[0].spec_json = CHART_SPEC.replace("\"Sales\"", "\"Sales 2026\"");
    f.publish(
        &theirs_chart,
        SemVer::new(1, 2, 0),
        PushMode::Update { expected_base: SemVer::new(1, 1, 0) },
    );

    // The author: the round trip, plus one real edit elsewhere.
    let mut working = through_a_checkout_rename_and_back(&base);
    working.sheets[0]
        .cells
        .insert((5, 5), SavedCell::from_cell(&Cell::new_number(1.0)));
    let yours = yours_against(&f, "1.0.0", &working);

    let cell_merge = calp::merge::analyze(&f.diff("1.0.0", "1.1.0"), &yours);
    assert_eq!(
        cell_merge.verdict,
        calp::merge::MergeVerdict::CanMerge,
        "the author never touched Report!A1: {:?}",
        cell_merge.collisions
    );
    // v1.2.0 against v1.0.0 is exactly the teammate's chart edit (v1.2.0 was
    // published from the base with only the chart's title changed).
    let chart_merge = calp::merge::analyze(&f.diff("1.0.0", "1.2.0"), &yours);
    assert!(
        chart_merge.collisions.is_empty()
            && chart_merge.verdict != calp::merge::MergeVerdict::Conflict,
        "the author never touched the chart: {:?} {:?}",
        chart_merge.verdict,
        chart_merge.collisions
    );
}

/// TWO NAMES SCOPED TO ONE SHEET are two objects. The diff keyed a defined
/// name by its SHEET id when it had one, so every name scoped to a sheet shared
/// one key and only the last survived: editing any other of them was not
/// reported, and the merge analysis could not see it collide. Whichever of the
/// two is edited, the diff names it.
///
/// SABOTAGE: key `namedRange` items like any other domain (sheetId first).
#[test]
fn every_name_scoped_to_one_sheet_is_its_own_object() {
    let f = Fixture::new();
    let mut base = base_workbook();
    let data_id = base.sheets[1].id;
    let scoped = |name: &str, refers_to: &str| persistence::SavedNamedRange {
        name: name.to_string(),
        refers_to: refers_to.to_string(),
        sheet_id: Some(data_id),
        comment: None,
        folder: None,
    };
    base.named_ranges = vec![scoped("First", "=Data!$A$1"), scoped("Second", "=Data!$A$2")];
    f.publish(&base, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let mut first = base.clone();
    first.named_ranges[0].refers_to = "=Data!$A$3".to_string();
    f.publish(&first, SemVer::new(1, 1, 0), PushMode::Update { expected_base: SemVer::new(1, 0, 0) });
    let mut second = base.clone();
    second.named_ranges[1].refers_to = "=Data!$A$4".to_string();
    f.publish(&second, SemVer::new(1, 2, 0), PushMode::Update { expected_base: SemVer::new(1, 1, 0) });

    for (to, edited) in [("1.1.0", "First"), ("1.2.0", "Second")] {
        let diff = f.diff("1.0.0", to);
        let rows: Vec<_> = diff.objects.iter().filter(|o| o.domain == "namedRange").collect();
        assert_eq!(
            rows.len(),
            1,
            "v{to} edited the name '{edited}': {:?}",
            diff.objects.iter().map(|o| (&o.domain, &o.id, &o.change)).collect::<Vec<_>>()
        );
        assert_eq!(rows[0].change, "modified");
        assert!(rows[0].id.ends_with(edited), "the row names the edited name: {}", rows[0].id);
    }
}

// ---------------------------------------------------------------------------
// An object script's capability ceiling (BUG-0274)
// ---------------------------------------------------------------------------

const FETCHER_SOURCE: &str = "export function onOpen(ctx) { return ctx.sheet; }";
const FETCHER_WITH_FETCH: &str =
    "// @capability net.fetch\nexport function onOpen(ctx) { return fetch(ctx.url); }";

/// An object script the way the host saves one: its own ceiling derived from
/// the source's `// @capability` pragmas.
fn fetcher(source: &str) -> persistence::SavedObjectScript {
    persistence::SavedObjectScript {
        id: "obj-fetcher".to_string(),
        name: "Fetcher".to_string(),
        object_type: persistence::ScriptableObjectType::Workbook,
        instance_id: None,
        source: source.to_string(),
        access_level: persistence::ScriptAccessLevel::default(),
        description: None,
        provenance: persistence::ScriptProvenance::default(),
        package_name: None,
        package_version: None,
        declared_capabilities: persistence::parse_declared_capabilities(source),
    }
}

/// `base` (same sheet identities) carrying exactly one object script.
fn with_script(base: &Workbook, script: persistence::SavedObjectScript) -> Workbook {
    let mut wb = base.clone();
    wb.object_scripts = vec![script];
    wb
}

/// The one object-script row of a diff.
fn fetcher_row(diff: &calp::diff::VersionDiff) -> &calp::diff::ObjectChange {
    let rows: Vec<_> = diff.objects.iter().filter(|o| o.domain == "objectScript").collect();
    assert_eq!(
        rows.len(),
        1,
        "exactly one object-script row: {:?}",
        diff.objects.iter().map(|o| (&o.domain, &o.id, &o.change, &o.detail)).collect::<Vec<_>>()
    );
    assert_eq!(rows[0].id, "obj-fetcher");
    rows[0]
}

/// THE VERSION DIFF SAYS WHEN A SCRIPT GAINS OR LOSES A CAPABILITY (BUG-0274).
/// The diff read an object script's capabilities from an artifact key no
/// artifact has (`capabilities`; an `ObjectScriptDef` writes
/// `declaredCapabilities`, and only when non-empty), so the push preview, the
/// Inspector's Compare and the refresh preview never said "gains net.fetch"
/// for a real script. The ceiling a subscriber's pull applies is the SIGNED
/// manifest's, and that is what the diff reads now -- on both arms a real
/// caller uses: two published versions, and a working copy published into
/// memory against its base.
///
/// Published through the real publish path, so the manifests carry exactly
/// what `publish` derives from the pragmas.
///
/// SABOTAGE: read the ceilings back out of the artifacts (the old
/// `capability_set`, `v.get("capabilities")`) -- every capability assertion
/// below goes red.
#[test]
fn a_script_that_gains_or_loses_a_capability_says_so_in_every_diff() {
    let f = Fixture::new();
    let base = base_workbook();
    f.publish(&with_script(&base, fetcher(FETCHER_SOURCE)), SemVer::new(1, 0, 0), PushMode::CreateNew);
    f.publish(
        &with_script(&base, fetcher(FETCHER_WITH_FETCH)),
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );
    f.publish(
        &with_script(&base, fetcher(FETCHER_SOURCE)),
        SemVer::new(1, 2, 0),
        PushMode::Update { expected_base: SemVer::new(1, 1, 0) },
    );

    // Precondition: the SIGNED manifests carry the ceilings publish derived.
    let ceiling = |version: &str| {
        f.reg
            .get_version_manifest(PKG, version)
            .unwrap()
            .object_scripts
            .iter()
            .find(|s| s.id == "obj-fetcher")
            .expect("the script is listed")
            .capabilities
            .clone()
    };
    assert!(ceiling("1.0.0").is_empty());
    assert_eq!(ceiling("1.1.0"), vec!["net.fetch".to_string()]);
    assert!(ceiling("1.2.0").is_empty());

    // GAINS: two published versions (the Inspector's Compare, the refresh preview).
    let gained = f.diff("1.0.0", "1.1.0");
    let row = fetcher_row(&gained);
    assert_eq!(row.change, "modified");
    assert_eq!(row.added_capabilities, vec!["net.fetch".to_string()]);
    assert!(row.removed_capabilities.is_empty(), "{:?}", row.removed_capabilities);
    assert!(row.detail.contains("gains net.fetch"), "the detail says so too: {}", row.detail);
    // On the wire, the way VersionDiffView reads it (`addedCapabilities?`).
    let wire = serde_json::to_value(row).unwrap();
    assert_eq!(wire["addedCapabilities"], serde_json::json!(["net.fetch"]));
    assert!(
        wire.get("removedCapabilities").is_none(),
        "an empty list is omitted, which the TS type allows (`removedCapabilities?`): {wire}"
    );

    // LOSES: the next version drops the pragma.
    let lost = f.diff("1.1.0", "1.2.0");
    let row = fetcher_row(&lost);
    assert_eq!(row.change, "modified");
    assert_eq!(row.removed_capabilities, vec!["net.fetch".to_string()]);
    assert!(row.added_capabilities.is_empty(), "{:?}", row.added_capabilities);
    assert!(row.detail.contains("loses net.fetch"), "the detail says so too: {}", row.detail);
    let wire = serde_json::to_value(row).unwrap();
    assert_eq!(wire["removedCapabilities"], serde_json::json!(["net.fetch"]));
    assert!(wire.get("addedCapabilities").is_none(), "{wire}");

    // THE PUSH PREVIEW: the working copy published into memory against its base.
    let preview = yours_against(&f, "1.0.0", &with_script(&base, fetcher(FETCHER_WITH_FETCH)));
    let row = fetcher_row(&preview);
    assert_eq!(row.added_capabilities, vec!["net.fetch".to_string()]);
    assert!(row.detail.contains("gains net.fetch"), "{}", row.detail);

    // A script ADDED with a capability gains it; one REMOVED loses it.
    f.publish(&base, SemVer::new(1, 3, 0), PushMode::Update { expected_base: SemVer::new(1, 2, 0) });
    f.publish(
        &with_script(&base, fetcher(FETCHER_WITH_FETCH)),
        SemVer::new(1, 4, 0),
        PushMode::Update { expected_base: SemVer::new(1, 3, 0) },
    );
    let added = f.diff("1.3.0", "1.4.0");
    let row = fetcher_row(&added);
    assert_eq!(row.change, "added");
    assert_eq!(row.added_capabilities, vec!["net.fetch".to_string()]);
    let removed = f.diff("1.4.0", "1.3.0");
    let row = fetcher_row(&removed);
    assert_eq!(row.change, "removed");
    assert_eq!(row.removed_capabilities, vec!["net.fetch".to_string()]);
}

/// THE SIGNED CEILING DECIDES, NOT THE ARTIFACT'S OWN CLAIM. A subscriber's
/// pull sets a distributed script's ceiling from the manifest entry (`pull.rs`,
/// R19) and never from the `declaredCapabilities` its artifact carries, so the
/// diff answers from the manifest too. Here the two disagree on purpose -- a
/// saved script whose stored ceiling no longer matches its pragmas, which
/// nothing at publish reconciles: v1's artifact claims net.fetch while its
/// manifest grants nothing, and v2's artifact claims nothing while its manifest
/// grants net.fetch. A subscriber moving from v1 to v2 GAINS net.fetch.
///
/// SABOTAGE: read `declaredCapabilities` from the artifacts -- the row says
/// the script LOSES net.fetch, the opposite of what a subscriber receives.
#[test]
fn the_signed_ceiling_decides_what_a_script_gains_not_its_artifacts_claim() {
    let f = Fixture::new();
    let base = base_workbook();
    let mut v1 = fetcher(FETCHER_SOURCE);
    v1.declared_capabilities = vec!["net.fetch".to_string()];
    let mut v2 = fetcher(FETCHER_WITH_FETCH);
    v2.declared_capabilities = Vec::new();
    f.publish(&with_script(&base, v1), SemVer::new(1, 0, 0), PushMode::CreateNew);
    f.publish(
        &with_script(&base, v2),
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );

    // Precondition: the artifacts really do claim the opposite.
    let claim = |version: &str| -> serde_json::Value {
        let bytes = f
            .reg
            .read_artifact(PKG, version, "object_scripts/obj-fetcher.json")
            .unwrap()
            .expect("the artifact is there");
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        v.get("declaredCapabilities").cloned().unwrap_or(serde_json::Value::Null)
    };
    assert_eq!(claim("1.0.0"), serde_json::json!(["net.fetch"]));
    assert_eq!(claim("1.1.0"), serde_json::Value::Null);

    let diff = f.diff("1.0.0", "1.1.0");
    let row = fetcher_row(&diff);
    assert_eq!(row.added_capabilities, vec!["net.fetch".to_string()]);
    assert!(row.removed_capabilities.is_empty(), "{:?}", row.removed_capabilities);
}

/// A CEILING THAT MOVES WITH NO ARTIFACT CHANGE IS STILL A ROW. Nothing at L1
/// differs -- the script's file is byte-identical -- but the signed ceiling a
/// subscriber's pull applies is wider, which is the one script change a
/// consumer must be shown. Reachable by a hand-signed version, or by a pragma
/// id this build has started to recognise (`KNOWN_CAPABILITY_IDS` grew before:
/// `schedule` was once silently stripped).
///
/// SABOTAGE: drop the manifest pass (`diff_object_script_ceilings`) from
/// `diff_sides` -- the diff reports nothing at all.
#[test]
fn a_ceiling_that_widens_with_no_artifact_change_is_still_reported() {
    let f = Fixture::new();
    let wb = with_script(&base_workbook(), fetcher(FETCHER_SOURCE));
    let mem = MemoryWorkspace::new();
    publish_version(&mem, f._prof.path(), &wb, SemVer::new(1, 0, 0), PushMode::CreateNew);
    let manifest = mem.get_version_manifest(PKG, "1.0.0").unwrap();
    let artifacts = mem.artifacts_of(PKG, "1.0.0");
    let mut widened = manifest.clone();
    widened
        .object_scripts
        .iter_mut()
        .find(|s| s.id == "obj-fetcher")
        .expect("the script is listed")
        .capabilities = vec!["net.fetch".to_string()];

    let diff = diff_sides(
        &DiffSide::InMemory { manifest: &manifest, artifacts: &artifacts },
        &DiffSide::InMemory { manifest: &widened, artifacts: &artifacts },
        &DiffOptions::default(),
    )
    .unwrap();
    assert!(diff.artifacts.changed.is_empty(), "no artifact differs: {:?}", diff.artifacts.changed);
    let row = fetcher_row(&diff);
    assert_eq!(row.change, "modified");
    assert_eq!(row.added_capabilities, vec!["net.fetch".to_string()]);
    assert!(row.detail.contains("gains net.fetch"), "{}", row.detail);
    assert_eq!(diff.totals.objects_modified, 1, "and the totals count it");

    // The positive control: the same manifest on both sides reports nothing.
    let same = diff_sides(
        &DiffSide::InMemory { manifest: &manifest, artifacts: &artifacts },
        &DiffSide::InMemory { manifest: &manifest, artifacts: &artifacts },
        &DiffOptions::default(),
    )
    .unwrap();
    assert!(same.objects.is_empty(), "{:?}", same.objects);
}
