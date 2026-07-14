//! FILENAME: core/calp/tests/lifecycle.rs
//! PURPOSE: End-to-end .calp distribution-lifecycle integration test (roadmap
//! item D10). Closes the gap where the soak/oracle machinery had zero reach
//! into calp: publish -> subscribe -> edit (writeback submit) -> refresh
//! (version bump + carry-forward) -> writeback supersedence has had no
//! automated safety net.
//!
//! CONTEXT: This is an INTEGRATION test (lives in tests/, compiled as its own
//! crate). It therefore exercises ONLY the calp crate's PUBLIC API surface —
//! the same surface a third-party consumer of the crate sees — using
//! `persistence`/`engine` (both calp `[dependencies]`, hence visible here) to
//! build the publisher's Workbook input.
//!
//! SCOPE BOUNDARY: The GATHER aggregation itself — visibility gating
//! (own_only / own_plus_aggregate), approval-state filtering, and dedupe of
//! superseded slots into a single rolled-up value — lives in the APP crate
//! (`app/src-tauri/src/calp_commands.rs::build_gather_data`), NOT in calp.
//! That logic is out of scope for this calp-crate test. What we cover here are
//! the registry / publish / pull / writeback PRIMITIVES that the app's gather
//! step is built on top of: that submissions round-trip, that the slot-keyed
//! storage gives supersedence (newest-wins, no double count) for free, that
//! versions are retained independently for carry-forward, and that the
//! integrity + trust (TOFU) gates hold across the lifecycle.

use std::collections::HashMap;
use std::path::Path;

use tempfile::TempDir;

use calp::integrity::TrustStatus;
use calp::publish::{self, PublishRequest};
use calp::pull::{self, PullRequest};
use calp::registry::LocalRegistry;
use calp::version::{SemVer, VersionPin};
use calp::writeback::{
    RegionSelector, SubmissionState, SubmissionValue, ValueSchema, ValueType, VersionBinding,
    VisibilityPolicy, SubmissionPolicy, WritebackRegionDeclaration,
};
use calp::CalpError;

use engine::cell::Cell;
use persistence::{SavedCell, Sheet, Workbook};

// ---------------------------------------------------------------------------
// Shared construction helpers (mirroring publish.rs / pull.rs test harness)
// ---------------------------------------------------------------------------

/// A workbook with a single "Budget" sheet carrying a few cells. Cell (0,0) is
/// a header label; cells in rows 1..=3 of column 0 are the writeback-input
/// area that the region declaration below covers.
fn make_budget_workbook() -> Workbook {
    let mut sheet = Sheet::new("Budget".to_string());
    sheet
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_text("Region Forecast".to_string())));
    sheet
        .cells
        .insert((0, 1), SavedCell::from_cell(&Cell::new_number(2026.0)));

    let mut wb = Workbook::default();
    wb.sheets = vec![sheet];
    wb
}

/// The writeback region declaration the publisher ships: a per-subscriber
/// numeric input column (rows 1..=3, col 0) on the budget sheet, carry-forward
/// on compatible schema (lenient binding), visible as own + aggregate.
fn make_region_declaration(sheet_id: identity::SheetId) -> WritebackRegionDeclaration {
    WritebackRegionDeclaration {
        id: "budget-input".to_string(),
        selector: RegionSelector {
            sheet_id,
            row_start: 1,
            row_end: 3,
            col_start: 0,
            col_end: 0,
        },
        mode: None,
        schema: Some(ValueSchema {
            value_type: ValueType::Number,
            required: false,
            min: Some(0.0),
            max: Some(1_000_000.0),
            enum_values: Vec::new(),
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        }),
        visibility: Some(VisibilityPolicy::OwnPlusAggregate),
        submission_policy: Some(SubmissionPolicy::OnSubmit),
        version_binding: Some(VersionBinding::Lenient),
        lifecycle: None,
        aggregation_hint: Some("SUM of regional forecasts".to_string()),
        expected_respondents: Vec::new(),
        extra: HashMap::new(),
    }
}

/// Publish `wb` as `package`@`version`, embedding the given writeback regions.
/// Signs with the keypair persisted in `prof` (created on first publish), so a
/// pull against the SAME `prof` verifies trust as FirstUse-then-Verified.
fn publish_version(
    reg: &LocalRegistry,
    prof: &Path,
    wb: &Workbook,
    package: &str,
    version: SemVer,
    regions: Option<Vec<WritebackRegionDeclaration>>,
) {
    let request = PublishRequest {
        model_writebacks: None,
        workbook: wb,
        package_name: package.to_string(),
        version,
        kind: "report".to_string(),
        sheet_indices: vec![0],
        now: "2026-06-15T00:00:00Z".to_string(),
        published_by: "publisher".to_string(),
        writeback_regions: regions,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        min_app_version: String::new(),
    };
    publish::publish(reg, &request, prof).unwrap();
}

fn pull_version(package: &str, version: SemVer) -> PullRequest {
    PullRequest {
        package_name: package.to_string(),
        registry_url: "file:///test".to_string(),
        version_pin: VersionPin::Exact(version),
        now: "2026-06-15T01:00:00Z".to_string(),
    }
}

/// A per-subscriber numeric submission for one (region, cell) slot. Re-used
/// across the supersedence test by varying `id`, `value`, and `updated_at`.
fn make_submission(
    region_id: &str,
    row: u32,
    col: u32,
    submitter_id: &str,
    submitter_name: &str,
    value: f64,
    updated_at: &str,
    sub_id: &str,
) -> calp::writeback::WritebackSubmission {
    calp::writeback::WritebackSubmission {
        model_key: None,
        id: sub_id.to_string(),
        region_id: region_id.to_string(),
        cell_row: row,
        cell_col: col,
        cell_id: None,
        submitter: calp::SubmitterIdentity {
            display_name: submitter_name.to_string(),
            id: submitter_id.to_string(),
            extra: HashMap::new(),
        },
        value: SubmissionValue::Number { value },
        state: SubmissionState::Submitted,
        created_at: "2026-06-15T02:00:00Z".to_string(),
        updated_at: updated_at.to_string(),
        submitted_at: Some(updated_at.to_string()),
        review_reason: None,
        reviewed_by: None,
        extra: HashMap::new(),
    }
}

/// pull() returns a PullResult with no Debug derive (deep persistence types),
/// so unwrap_err() is unavailable; match to extract the error instead.
fn expect_pull_err(reg: &LocalRegistry, req: &PullRequest, prof: &Path) -> CalpError {
    match pull::pull(reg, req, prof) {
        Ok(_) => panic!("pull unexpectedly succeeded"),
        Err(e) => e,
    }
}

// ---------------------------------------------------------------------------
// 1. publish -> pull round-trip (sheet cells + writeback region + trust)
// ---------------------------------------------------------------------------

#[test]
fn lifecycle_publish_pull_roundtrip_carries_cells_region_and_trust() {
    let reg_dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(reg_dir.path()).unwrap();

    let wb = make_budget_workbook();
    let region = make_region_declaration(wb.sheets[0].id);
    publish_version(
        &reg,
        prof.path(),
        &wb,
        "budget",
        SemVer::new(1, 0, 0),
        Some(vec![region.clone()]),
    );

    let result = pull::pull(&reg, &pull_version("budget", SemVer::new(1, 0, 0)), prof.path()).unwrap();

    // The published sheet's cells survive the round-trip.
    assert_eq!(result.resolved_version, SemVer::new(1, 0, 0));
    assert_eq!(result.sheets.len(), 1);
    let pulled = &result.sheets[0].sheet;
    assert_eq!(result.sheets[0].name, "Budget");
    let header = pulled.cells.get(&(0, 0)).unwrap();
    assert!(matches!(&header.value, persistence::SavedCellValue::Text(t) if t == "Region Forecast"));
    let year = pulled.cells.get(&(0, 1)).unwrap();
    assert!(matches!(year.value, persistence::SavedCellValue::Number(n) if n == 2026.0));

    // The writeback region declaration is present in the pulled manifest, with
    // its selector + schema intact (the manifest is the writeback source of
    // truth the subscriber's UI/aggregation reads).
    let manifest = reg.get_version_manifest("budget", "1.0.0").unwrap();
    let regions = manifest.writeback_regions.expect("region must be in manifest");
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].id, "budget-input");
    assert_eq!(regions[0].selector.row_start, 1);
    assert_eq!(regions[0].selector.row_end, 3);
    assert_eq!(regions[0].schema.as_ref().unwrap().value_type, ValueType::Number);
    assert_eq!(regions[0].version_binding, Some(VersionBinding::Lenient));

    // The region's selector points at the PACKAGE sheet id; the pulled sheet
    // gets a fresh local id, but the package sheet id is exposed so the
    // subscriber can remap the region onto the local sheet.
    assert_eq!(regions[0].selector.sheet_id, result.sheets[0].package_sheet_id);

    // First pull pins the publisher key: trust-on-first-use.
    assert_eq!(result.trust_status, TrustStatus::FirstUse);
    assert!(!result.publisher_name.is_empty());
}

// ---------------------------------------------------------------------------
// 2. writeback submit -> load (two submitters; per-submitter filtering)
// ---------------------------------------------------------------------------

#[test]
fn lifecycle_writeback_submit_and_load_across_submitters() {
    let reg_dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(reg_dir.path()).unwrap();

    let wb = make_budget_workbook();
    let region = make_region_declaration(wb.sheets[0].id);
    publish_version(
        &reg,
        prof.path(),
        &wb,
        "budget",
        SemVer::new(1, 0, 0),
        Some(vec![region]),
    );

    // Two different subscribers each submit into the region (cell 1,0).
    let alice = make_submission(
        "budget-input", 1, 0, "id-alice", "Alice", 100.0,
        "2026-06-15T02:00:00Z", "sub-alice-1",
    );
    let bob = make_submission(
        "budget-input", 1, 0, "id-bob", "Bob", 250.0,
        "2026-06-15T02:01:00Z", "sub-bob-1",
    );
    reg.save_submission("budget", "1.0.0", &alice).unwrap();
    reg.save_submission("budget", "1.0.0", &bob).unwrap();

    // load_all_submissions returns BOTH submitters' contributions.
    let all = reg.load_all_submissions("budget", "1.0.0").unwrap();
    assert_eq!(all.len(), 2);

    // load_submissions(submitter) is scoped to exactly that submitter.
    let alice_only = reg.load_submissions("budget", "1.0.0", "id-alice").unwrap();
    assert_eq!(alice_only.len(), 1);
    assert_eq!(alice_only[0].submitter.id, "id-alice");
    assert_eq!(alice_only[0].submitter.display_name, "Alice");
    assert_eq!(alice_only[0].state, SubmissionState::Submitted);
    assert!(matches!(alice_only[0].value, SubmissionValue::Number { value } if value == 100.0));

    let bob_only = reg.load_submissions("budget", "1.0.0", "id-bob").unwrap();
    assert_eq!(bob_only.len(), 1);
    assert_eq!(bob_only[0].submitter.id, "id-bob");
    assert!(matches!(bob_only[0].value, SubmissionValue::Number { value } if value == 250.0));

    // load_region_submissions buckets across submitters for a single region.
    let region_subs = reg.load_region_submissions("budget", "1.0.0", "budget-input").unwrap();
    assert_eq!(region_subs.len(), 2);
    let sum: f64 = region_subs
        .iter()
        .map(|s| match s.value {
            SubmissionValue::Number { value } => value,
            _ => 0.0,
        })
        .sum();
    assert_eq!(sum, 350.0, "both submitters' values are present exactly once");
}

// ---------------------------------------------------------------------------
// 3. supersedence (D3): same submitter re-submits the SAME slot -> newest wins,
//    no double count.
// ---------------------------------------------------------------------------

#[test]
fn lifecycle_supersedence_same_slot_newest_wins_no_double_count() {
    let reg_dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(reg_dir.path()).unwrap();

    let wb = make_budget_workbook();
    let region = make_region_declaration(wb.sheets[0].id);
    publish_version(
        &reg,
        prof.path(),
        &wb,
        "budget",
        SemVer::new(1, 0, 0),
        Some(vec![region]),
    );

    // Alice submits the SAME (region, cell 1,0) slot twice: an initial value,
    // then a correction with a NEWER updated_at and a different submission id.
    let first = make_submission(
        "budget-input", 1, 0, "id-alice", "Alice", 100.0,
        "2026-06-15T02:00:00Z", "sub-alice-rev-1",
    );
    let second = make_submission(
        "budget-input", 1, 0, "id-alice", "Alice", 175.0,
        "2026-06-15T03:00:00Z", "sub-alice-rev-2",
    );
    reg.save_submission("budget", "1.0.0", &first).unwrap();
    reg.save_submission("budget", "1.0.0", &second).unwrap();

    // STORAGE BEHAVIOR OBSERVED: save_submission keys the on-disk filename by
    // the logical SLOT — "{region}_{row}_{col}.json" within the submitter's
    // directory — NOT by the per-save submission id. So a re-submit OVERWRITES
    // the prior file in place; the registry stores exactly one file per slot.
    // Loading therefore already yields a single current value — supersedence is
    // structural, not something the caller must dedupe.
    let loaded = reg.load_region_submissions("budget", "1.0.0", "budget-input").unwrap();
    assert_eq!(loaded.len(), 1, "slot-keyed storage keeps exactly one file per slot");
    assert_eq!(loaded[0].id, "sub-alice-rev-2", "the newer submission won");
    assert!(matches!(loaded[0].value, SubmissionValue::Number { value } if value == 175.0));

    // Belt-and-suspenders: applying the app-layer dedupe rule (group by
    // (submitter, cell), keep the max updated_at) over what we loaded is a
    // no-op here and still yields the newest — i.e. no double count regardless
    // of which layer enforces supersedence.
    let current = newest_per_slot(&loaded);
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].id, "sub-alice-rev-2");
}

/// App-layer supersedence rule, reproduced here over the public submission
/// type: collapse to one current value per (submitter, region, cell) slot by
/// keeping the entry with the latest `updated_at`. The registry's slot-keyed
/// storage means this is normally a no-op, but it guards callers that merge
/// submissions from several sources (e.g. local drafts + registry).
fn newest_per_slot(
    subs: &[calp::writeback::WritebackSubmission],
) -> Vec<calp::writeback::WritebackSubmission> {
    let mut by_slot: HashMap<(String, String, u32, u32), calp::writeback::WritebackSubmission> =
        HashMap::new();
    for s in subs {
        let key = (
            s.submitter.id.clone(),
            s.region_id.clone(),
            s.cell_row,
            s.cell_col,
        );
        match by_slot.get(&key) {
            Some(existing) if existing.updated_at >= s.updated_at => {}
            _ => {
                by_slot.insert(key, s.clone());
            }
        }
    }
    by_slot.into_values().collect()
}

// ---------------------------------------------------------------------------
// 4. version bump + carry-forward (D3 / lenient binding): v2 with a compatible
//    region; v1 submissions remain readable independently.
// ---------------------------------------------------------------------------

#[test]
fn lifecycle_version_bump_retains_prior_version_submissions() {
    let reg_dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(reg_dir.path()).unwrap();

    let wb = make_budget_workbook();
    let region_v1 = make_region_declaration(wb.sheets[0].id);

    // Publish v1 and record a submission under it.
    publish_version(
        &reg,
        prof.path(),
        &wb,
        "budget",
        SemVer::new(1, 0, 0),
        Some(vec![region_v1.clone()]),
    );
    let v1_sub = make_submission(
        "budget-input", 1, 0, "id-alice", "Alice", 100.0,
        "2026-06-15T02:00:00Z", "sub-v1",
    );
    reg.save_submission("budget", "1.0.0", &v1_sub).unwrap();

    // Publish v2 with the SAME region id and a schema-COMPATIBLE (wider bounds)
    // declaration — the lenient-binding carry-forward case. Republishing the
    // same workbook keeps the same package sheet id, so the region still lines
    // up positionally.
    let mut region_v2 = make_region_declaration(wb.sheets[0].id);
    region_v2.schema = Some(ValueSchema {
        value_type: ValueType::Number,
        required: false,
        min: Some(-100.0),       // widened lower bound
        max: Some(2_000_000.0),  // widened upper bound
        enum_values: Vec::new(),
        max_length: None,
        pattern: None,
        extra: HashMap::new(),
    });
    publish_version(
        &reg,
        prof.path(),
        &wb,
        "budget",
        SemVer::new(2, 0, 0),
        Some(vec![region_v2.clone()]),
    );

    // Schema compatibility check (the gate the app uses to decide carry-forward)
    // confirms the v1 -> v2 region pair is compatible, so submissions MAY carry.
    let compat = calp::writeback::check_region_compatibility(
        std::slice::from_ref(&region_v1),
        std::slice::from_ref(&region_v2),
    );
    assert_eq!(compat.compatible, vec!["budget-input"]);
    assert!(compat.incompatible.is_empty());
    assert!(compat.added.is_empty());
    assert!(compat.removed.is_empty());

    // Both versions exist and are listed independently.
    let versions = reg.list_versions("budget").unwrap();
    assert_eq!(versions, vec![SemVer::new(1, 0, 0), SemVer::new(2, 0, 0)]);

    // Carry-forward is an app-layer concern (it copies v1 submissions into v2
    // when compatible). At the registry primitive level what must hold is that
    // the v1 submissions remain READABLE after v2 exists, and that v2 starts
    // with its own (here empty) submission set — the app reads both and merges.
    let v1_subs = reg.load_region_submissions("budget", "1.0.0", "budget-input").unwrap();
    assert_eq!(v1_subs.len(), 1, "v1 submissions survive a later version publish");
    assert_eq!(v1_subs[0].id, "sub-v1");

    let v2_subs = reg.load_region_submissions("budget", "2.0.0", "budget-input").unwrap();
    assert!(v2_subs.is_empty(), "v2 starts with its own (empty) submission set");

    // Simulate the app's carry-forward: copy the compatible v1 submission into
    // v2 (the app would re-stamp version provenance; the registry just stores).
    reg.save_submission("budget", "2.0.0", &v1_sub).unwrap();
    let v2_after = reg.load_region_submissions("budget", "2.0.0", "budget-input").unwrap();
    assert_eq!(v2_after.len(), 1);
    assert!(matches!(v2_after[0].value, SubmissionValue::Number { value } if value == 100.0));

    // And v1's own record is untouched by the carry-forward into v2.
    let v1_again = reg.load_region_submissions("budget", "1.0.0", "budget-input").unwrap();
    assert_eq!(v1_again.len(), 1);
}

// ---------------------------------------------------------------------------
// 5. integrity gate: tampering a published artifact makes pull fail.
// ---------------------------------------------------------------------------

#[test]
fn lifecycle_integrity_gate_rejects_tampered_artifact() {
    let reg_dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(reg_dir.path()).unwrap();

    let wb = make_budget_workbook();
    let region = make_region_declaration(wb.sheets[0].id);
    publish_version(
        &reg,
        prof.path(),
        &wb,
        "budget",
        SemVer::new(1, 0, 0),
        Some(vec![region]),
    );

    // An untampered pull succeeds and passes the integrity gate.
    pull::pull(&reg, &pull_version("budget", SemVer::new(1, 0, 0)), prof.path()).unwrap();

    // Overwrite the sheet's data.json on disk with garbage AFTER publish. The
    // manifest's recorded SHA-256 no longer matches, so the integrity gate (run
    // during pull, after the signature gate it cannot affect) rejects it.
    let data_path = reg
        .sheet_dir("budget", "1.0.0", &wb.sheets[0].id)
        .unwrap()
        .join("data.json");
    std::fs::write(&data_path, b"{\"cells\": \"tampered\"}").unwrap();

    let err = expect_pull_err(&reg, &pull_version("budget", SemVer::new(1, 0, 0)), prof.path());
    assert!(
        matches!(err, CalpError::ChecksumMismatch { .. }),
        "expected ChecksumMismatch, got {err:?}"
    );
    let msg = err.to_string();
    assert!(msg.contains("Package integrity check failed"), "msg: {msg}");
    assert!(msg.contains("data.json"), "msg: {msg}");
}

// ---------------------------------------------------------------------------
// 6. signature / trust (TOFU): same package + same profile -> FirstUse, then
//    Verified on the second pull.
// ---------------------------------------------------------------------------

#[test]
fn lifecycle_tofu_first_use_then_verified() {
    let reg_dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(reg_dir.path()).unwrap();

    let wb = make_budget_workbook();
    let region = make_region_declaration(wb.sheets[0].id);
    publish_version(
        &reg,
        prof.path(),
        &wb,
        "budget",
        SemVer::new(1, 0, 0),
        Some(vec![region]),
    );

    // First pull pins the publisher key (trust-on-first-use)...
    let first = pull::pull(&reg, &pull_version("budget", SemVer::new(1, 0, 0)), prof.path()).unwrap();
    assert_eq!(first.trust_status, TrustStatus::FirstUse);

    // ...a second pull of the same package, against the same TOFU pin store,
    // matches the pinned key and reports Verified.
    let second = pull::pull(&reg, &pull_version("budget", SemVer::new(1, 0, 0)), prof.path()).unwrap();
    assert_eq!(second.trust_status, TrustStatus::Verified);
}
