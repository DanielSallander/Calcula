//! FILENAME: core/calp/tests/workspace_marker.rs
//! PURPOSE: A workspace can be POINTED AT by its `workspace.calcula` file, and
//! that spelling must behave identically to naming the directory.
//! CONTEXT: A workspace is a directory, but a folder picker is awkward to aim —
//! you navigate INTO the folder and confirm a window that looks empty. So a
//! workspace also carries a pointer file, the `.pbip` idea, and the dialogs
//! select that.
//!
//! WHY THIS IS A TEST AND NOT A CONVENIENCE. A publisher pin is filed under the
//! scope derived from the location STRING. If the file form and the folder form
//! scoped differently, a developer who browsed to the pointer file would pin
//! under a scope nobody else uses, and the next application they subscribed to
//! from the same share under the same publisher would come back
//! `notPinnedNameConflict` — the hijack alarm, fired at a colleague. The unit
//! tests in `workspace_id.rs` pin the string reduction; this file proves the
//! whole publish/pull path actually works through the file spelling, which is
//! the claim the UI makes.

use tempfile::TempDir;

use calp::integrity::PinPolicy;
use calp::publish::{self, PublishRequest, PushMode};
use calp::pull::{self, PullRequest};
use calp::version::{SemVer, VersionPin};
use calp::workspace::LocalWorkspace;
use calp::workspace_id::WORKSPACE_MARKER_FILE;

use engine::cell::Cell;
use persistence::{SavedCell, Sheet, Workbook};

fn one_sheet_workbook() -> Workbook {
    let mut sheet = Sheet::new("Sheet1".to_string());
    sheet
        .cells
        .insert((1, 1), SavedCell::from_cell(&Cell::new_text("Hello".to_string())));
    let mut wb = Workbook::default();
    wb.sheets = vec![sheet];
    wb
}

fn publish_into(reg: &LocalWorkspace, prof: &std::path::Path, wb: &Workbook) {
    let request = PublishRequest {
        workbook: wb,
        package_name: "budget".to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: "first".to_string(),
        sheet_indices: vec![0],
        now: "2026-08-31T00:00:00Z".to_string(),
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

/// THE TEETH. Publishing must write the pointer file BY ITSELF.
///
/// Every other test in this file called `ensure_marker()` by hand first, which
/// proved the function works and never that anything calls it — so deleting the
/// call was a green no-op, and an audit found that two of the four publish
/// routes (the model publish and the skin pack) had never had it. The marker now
/// lives in `LocalWorkspace::write_application_manifest`, the one write every
/// route makes, and this test is what holds it there: it publishes and then
/// asserts, with no manual `ensure_marker()` anywhere.
#[test]
fn publishing_writes_the_pointer_file_without_being_asked() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();

    let marker = dir.path().join(WORKSPACE_MARKER_FILE);
    assert!(!marker.exists(), "precondition: an empty folder is not yet a workspace");

    publish_into(&reg, prof.path(), &one_sheet_workbook());

    assert!(
        marker.exists(),
        "publishing an application into a folder is what makes it a workspace, so \
         the pointer file must be there without anyone asking for it"
    );
}

#[test]
fn opening_a_workspace_by_its_marker_file_finds_the_same_applications() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();

    let by_folder = LocalWorkspace::open(dir.path()).unwrap();
    publish_into(&by_folder, prof.path(), &one_sheet_workbook());

    // Now open the SAME workspace by naming the pointer file.
    let marker = dir.path().join(WORKSPACE_MARKER_FILE);
    assert!(marker.exists(), "ensure_marker must write the pointer file");
    let by_file = LocalWorkspace::open(&marker).unwrap();

    assert_eq!(
        by_file.root(),
        by_folder.root(),
        "the file spelling must resolve to the workspace directory, not to a \
         directory named after the marker"
    );
    assert_eq!(
        by_file.list_applications().unwrap(),
        vec!["budget".to_string()],
        "the applications must be visible through the file spelling"
    );
}

#[test]
fn a_pull_through_the_marker_spelling_pins_the_same_scope() {
    // The whole reason the reduction happens before scoping: pull through one
    // spelling, then verify through the other under RequirePinned — which fails
    // closed if the pin was filed under a different identity.
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    publish_into(&reg, prof.path(), &one_sheet_workbook());

    let folder_spelling = dir.path().to_str().unwrap().to_string();
    let file_spelling = dir.path().join(WORKSPACE_MARKER_FILE).to_str().unwrap().to_string();

    // Subscribe using the FOLDER spelling — this is the commit point that pins.
    let folder_scope = calp::workspace_scope(&folder_spelling).unwrap();
    pull::pull(
        &reg,
        &PullRequest {
            package_name: "budget".to_string(),
            version_pin: VersionPin::Latest,
            now: "2026-08-31T01:00:00Z".to_string(),
        },
        &folder_scope,
        prof.path(),
        PinPolicy::PinOnFirstUse,
    )
    .expect("the first pull pins the publisher");

    // Re-verify using the FILE spelling under RequirePinned. If the two spellings
    // scoped differently this fails closed with PublisherNotPinned, which is
    // exactly the false alarm a colleague would have seen.
    let file_scope = calp::workspace_scope(&file_spelling).unwrap();
    assert_eq!(
        file_scope.id, folder_scope.id,
        "the two spellings must derive one scope id"
    );
    assert_eq!(
        file_scope.label, file_spelling,
        "the label stays exactly what the user picked, marker and all"
    );

    pull::pull(
        &reg,
        &PullRequest {
            package_name: "budget".to_string(),
            version_pin: VersionPin::Latest,
            now: "2026-08-31T02:00:00Z".to_string(),
        },
        &file_scope,
        prof.path(),
        PinPolicy::RequirePinned,
    )
    .expect("the pin written through the folder spelling must satisfy the file spelling");
}

#[test]
fn the_marker_is_not_mistaken_for_an_application() {
    // `list_applications` walks directories that hold a `calp-manifest.json`. The
    // marker is a FILE at the workspace root, so it must never appear as an
    // application — and writing it must not disturb what is already there.
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    publish_into(&reg, prof.path(), &one_sheet_workbook());

    let before = reg.list_applications().unwrap();
    reg.ensure_marker().unwrap();
    let after = reg.list_applications().unwrap();

    assert_eq!(before, after, "placing the pointer file must not change the listing");
    assert!(
        !after.iter().any(|n| n.contains("calcula")),
        "the marker must never be listed as an application: {after:?}"
    );
}

#[test]
fn ensure_marker_is_idempotent_and_does_not_clobber() {
    let dir = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();

    reg.ensure_marker().unwrap();
    let path = dir.path().join(WORKSPACE_MARKER_FILE);
    let first = std::fs::read_to_string(&path).unwrap();

    // A workspace someone annotated by hand must survive the next publish.
    std::fs::write(&path, "{\n  \"note\": \"team budget workspace\"\n}").unwrap();
    reg.ensure_marker().unwrap();
    let second = std::fs::read_to_string(&path).unwrap();

    assert_ne!(first, second, "the sabotage must actually have changed the file");
    assert!(
        second.contains("team budget workspace"),
        "an existing pointer file must be left alone, not overwritten: {second}"
    );
}
