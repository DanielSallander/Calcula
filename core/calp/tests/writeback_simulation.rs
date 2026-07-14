//! FILENAME: core/calp/tests/writeback_simulation.rs
//! PURPOSE: A narrative, multi-user END-TO-END simulation of a writeback
//! "data collection" scenario, exercised against the REAL calp registry /
//! publish / pull / submission primitives plus the real `ValueSchema::validate`.
//!
//! SCENARIO ("Regional Budget Collection"):
//!   1. The AUTHOR (Finance HQ) publishes a `regional-budget` report that
//!      designates a per-subscriber numeric writeback region — four quarterly
//!      forecast input cells — with an `on_approval` submission policy and
//!      `own_plus_aggregate` visibility.
//!   2. Three SUBSCRIBERS (North/Alice, South/Bob, West/Carol) each pull the
//!      package and COMMIT their four quarterly forecasts.
//!   3. Alice CORRECTS one cell (supersedence — newest wins, no double count).
//!   4. Carol CLEARS one cell (an empty submission == "no value", not a zero).
//!   5. The PUBLISHER approves Alice's and Bob's values and REJECTS one of
//!      Carol's, leaving her others merely submitted (not yet approved).
//!   6. We compute the GATHER aggregate the publisher's formulas would see and
//!      assert the governed result (approval gating + empty-drop + visibility
//!      anonymization) is exactly right.
//!   7. The author publishes v2.0.0 with a schema-COMPATIBLE (widened) region;
//!      v1 submissions carry forward (lenient binding) while v1 stays readable.
//!
//! SCOPE NOTE: The GATHER aggregation governance itself
//! (`apply_gather_governance` + `build_gather_data`) lives in the APP crate
//! (`app/src-tauri/src/calp_commands.rs`), NOT in calp — see
//! core/calp/tests/lifecycle.rs for that boundary. So the final aggregate is
//! produced here by a FAITHFUL PORT of `apply_gather_governance` (kept in
//! lock-step with the app source; see `governed_submissions` below). Everything
//! the port consumes — the submissions, their states, supersedence, carry-
//! forward — comes from the real registry primitives, so the data plane under
//! test is the production one.

use std::collections::HashMap;
use std::path::Path;

use tempfile::TempDir;

use calp::integrity::TrustStatus;
use calp::publish::{self, PublishRequest};
use calp::pull::{self, PullRequest};
use calp::registry::LocalRegistry;
use calp::version::{SemVer, VersionPin};
use calp::writeback::{
    check_region_compatibility, LifecyclePolicy, RegionSelector, SubmissionPolicy, SubmissionState,
    SubmissionValue, ValueSchema, ValueType, VersionBinding, VisibilityPolicy,
    WritebackRegionDeclaration, WritebackSubmission,
};
use calp::SubmitterIdentity;

use engine::cell::Cell;
use persistence::{SavedCell, Sheet, Workbook};

// ---------------------------------------------------------------------------
// Fixed scenario constants
// ---------------------------------------------------------------------------

const PKG: &str = "regional-budget";
const REGION: &str = "fc-2026";
const COL: u32 = 1; // forecast input column
const ROW_Q1: u32 = 1;
const ROW_Q4: u32 = 4; // region spans rows 1..=4 (Q1..Q4), col 1

// ---------------------------------------------------------------------------
// Construction helpers (mirroring lifecycle.rs)
// ---------------------------------------------------------------------------

/// A "Budget" sheet with header labels. Rows 1..=4 of the forecast column are
/// the writeback input area the region below covers.
fn make_budget_workbook() -> Workbook {
    let mut sheet = Sheet::new("Budget".to_string());
    sheet
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_text("Quarter".to_string())));
    sheet
        .cells
        .insert((0, COL), SavedCell::from_cell(&Cell::new_text("Forecast".to_string())));
    for (i, q) in ["Q1", "Q2", "Q3", "Q4"].iter().enumerate() {
        sheet.cells.insert(
            (i as u32 + 1, 0),
            SavedCell::from_cell(&Cell::new_text((*q).to_string())),
        );
    }

    let mut wb = Workbook::default();
    wb.sheets = vec![sheet];
    wb
}

/// The publisher's region declaration: a per-subscriber numeric input column
/// (rows 1..=4, col 1), `on_approval` (the publisher must approve before a
/// value joins the aggregate), `own_plus_aggregate` visibility, lenient
/// version binding, with a 0..10,000,000 schema.
fn make_region(sheet_id: identity::SheetId) -> WritebackRegionDeclaration {
    WritebackRegionDeclaration {
        id: REGION.to_string(),
        selector: RegionSelector {
            sheet_id,
            row_start: ROW_Q1,
            row_end: ROW_Q4,
            col_start: COL,
            col_end: COL,
        },
        mode: None,
        schema: Some(ValueSchema {
            value_type: ValueType::Number,
            required: false,
            min: Some(0.0),
            max: Some(10_000_000.0),
            enum_values: Vec::new(),
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        }),
        visibility: Some(VisibilityPolicy::OwnPlusAggregate),
        submission_policy: Some(SubmissionPolicy::OnApproval),
        version_binding: Some(VersionBinding::Lenient),
        lifecycle: None,
        aggregation_hint: Some("SUM of regional quarterly forecasts".to_string()),
        // Completion-tracking roster: East never responds in the scenario.
        expected_respondents: vec![
            "North".to_string(),
            "South".to_string(),
            "West".to_string(),
            "East".to_string(),
        ],
        extra: HashMap::new(),
    }
}

fn publish_version(
    reg: &LocalRegistry,
    prof: &Path,
    wb: &Workbook,
    version: SemVer,
    regions: Vec<WritebackRegionDeclaration>,
) {
    let request = PublishRequest {
        model_writebacks: None,
        workbook: wb,
        package_name: PKG.to_string(),
        version,
        kind: "report".to_string(),
        sheet_indices: vec![0],
        now: "2026-06-15T00:00:00Z".to_string(),
        published_by: "Finance HQ".to_string(),
        writeback_regions: Some(regions),
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

/// A subscriber (their own TOFU profile) pulls a version of the package.
fn subscriber_pull(reg: &LocalRegistry, prof: &Path, version: SemVer) -> pull::PullResult {
    let req = PullRequest {
        package_name: PKG.to_string(),
        registry_url: "file:///test".to_string(),
        version_pin: VersionPin::Exact(version),
        now: "2026-06-15T01:00:00Z".to_string(),
    };
    pull::pull(reg, &req, prof).expect("pull failed")
}

fn identity(name: &str, id: &str) -> SubmitterIdentity {
    SubmitterIdentity {
        display_name: name.to_string(),
        id: id.to_string(),
        extra: HashMap::new(),
    }
}

/// Validate a value against the region schema (mirroring the app's draft-save
/// path: `calp_save_writeback_draft` calls `schema.validate` before storing),
/// then COMMIT it to the registry as a Submitted submission — exactly what
/// `submit_region_internal` does on the registry side.
fn commit(
    reg: &LocalRegistry,
    version: &str,
    region: &WritebackRegionDeclaration,
    who: &SubmitterIdentity,
    row: u32,
    value: SubmissionValue,
    updated_at: &str,
    sub_id: &str,
) {
    if let Some(schema) = &region.schema {
        schema
            .validate(&value)
            .unwrap_or_else(|e| panic!("schema rejected {who:?} row {row}: {e}"));
    }
    let sub = WritebackSubmission {
        model_key: None,
        id: sub_id.to_string(),
        region_id: region.id.clone(),
        cell_row: row,
        cell_col: COL,
        cell_id: None,
        submitter: who.clone(),
        value,
        state: SubmissionState::Submitted,
        created_at: "2026-06-15T02:00:00Z".to_string(),
        updated_at: updated_at.to_string(),
        submitted_at: Some(updated_at.to_string()),
        review_reason: None,
        reviewed_by: None,
        extra: HashMap::new(),
    };
    reg.save_submission(PKG, version, &sub).expect("save_submission failed");
}

/// Publisher decision: load the submission for a (submitter, cell) slot, set its
/// state, re-save. Mirrors `calp_set_submission_state` (approve/reject).
fn decide(
    reg: &LocalRegistry,
    version: &str,
    submitter_id: &str,
    row: u32,
    new_state: SubmissionState,
) {
    let subs = reg
        .load_submissions(PKG, version, submitter_id)
        .expect("load_submissions failed");
    let mut s = subs
        .into_iter()
        .find(|s| s.region_id == REGION && s.cell_row == row && s.cell_col == COL)
        .unwrap_or_else(|| panic!("no submission for {submitter_id} row {row}"));
    s.state = new_state;
    s.updated_at = "2026-06-15T05:00:00Z".to_string();
    reg.save_submission(PKG, version, &s).expect("re-save failed");
}

// ---------------------------------------------------------------------------
// FAITHFUL PORT of app/src-tauri/src/calp_commands.rs::apply_gather_governance.
// Keep in lock-step with that function: approval gating -> drop cleared cells
// -> read-side schema integrity -> read-side deadline integrity -> visibility
// (own_only hides others; own_plus_aggregate keeps values but anonymizes other
// submitters). This is the privacy + integrity boundary the publisher's GATHER
// formulas see. (The sim's region has a schema all values satisfy and no
// deadline, so those two gates are inert here but kept for fidelity.)
// ---------------------------------------------------------------------------
fn governed_submissions(
    mut submissions: Vec<WritebackSubmission>,
    region: &WritebackRegionDeclaration,
    own: Option<&SubmitterIdentity>,
) -> Vec<WritebackSubmission> {
    let require_approval = matches!(region.submission_policy, Some(SubmissionPolicy::OnApproval));
    submissions.retain(|s| match s.state {
        SubmissionState::Rejected | SubmissionState::Draft => false,
        SubmissionState::Submitted => !require_approval,
        SubmissionState::Approved => true,
    });
    submissions.retain(|s| !matches!(s.value, SubmissionValue::Empty));
    if let Some(schema) = &region.schema {
        submissions.retain(|s| schema.validate(&s.value).is_ok());
    }
    if let Some(LifecyclePolicy::UntilDeadline { deadline: Some(dl) }) = &region.lifecycle {
        submissions.retain(|s| match &s.submitted_at {
            Some(ts) => ts.as_str() < dl.as_str(),
            None => true,
        });
    }
    submissions.sort_by(|a, b| {
        a.cell_row
            .cmp(&b.cell_row)
            .then(a.cell_col.cmp(&b.cell_col))
            .then(a.submitter.id.cmp(&b.submitter.id))
    });
    match region.visibility {
        Some(VisibilityPolicy::OwnOnly) => {
            submissions.retain(|s| own.map(|o| s.submitter.id == o.id).unwrap_or(false));
        }
        Some(VisibilityPolicy::OwnPlusAggregate) => {
            let mut token_for: HashMap<String, String> = HashMap::new();
            let mut next = 1;
            for s in submissions.iter() {
                let is_own = own.map(|o| s.submitter.id == o.id).unwrap_or(false);
                if !is_own && !token_for.contains_key(&s.submitter.id) {
                    token_for.insert(s.submitter.id.clone(), format!("Submitter {next}"));
                    next += 1;
                }
            }
            for s in submissions.iter_mut() {
                let is_own = own.map(|o| s.submitter.id == o.id).unwrap_or(false);
                if !is_own {
                    s.submitter.display_name = token_for
                        .get(&s.submitter.id)
                        .cloned()
                        .unwrap_or_else(|| "(anonymous)".to_string());
                    s.submitter.id = String::new();
                }
            }
        }
        _ => {}
    }
    submissions
}

fn sum_numbers(subs: &[WritebackSubmission]) -> f64 {
    subs.iter()
        .filter_map(|s| match s.value {
            SubmissionValue::Number { value } => Some(value),
            _ => None,
        })
        .sum()
}

// ---------------------------------------------------------------------------
// The simulation (run with `-- --nocapture` to read the narrative).
// ---------------------------------------------------------------------------

#[test]
fn writeback_multi_user_simulation() {
    let reg_dir = TempDir::new().unwrap();
    let hq_prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(reg_dir.path()).unwrap();

    // --- 1. Author publishes the data-collection report -------------------
    let wb = make_budget_workbook();
    let region = make_region(wb.sheets[0].id);
    publish_version(&reg, hq_prof.path(), &wb, SemVer::new(1, 0, 0), vec![region.clone()]);
    println!("[author] published {PKG} v1.0.0 with writeback region '{REGION}' (rows {ROW_Q1}..={ROW_Q4}, col {COL})");

    // --- 2. Three subscribers pull, each into their own TOFU profile ------
    let alice = identity("North (Alice)", "id-north-alice");
    let bob = identity("South (Bob)", "id-south-bob");
    let carol = identity("West (Carol)", "id-west-carol");

    for who in [&alice, &bob, &carol] {
        let prof = TempDir::new().unwrap();
        let result = subscriber_pull(&reg, prof.path(), SemVer::new(1, 0, 0));
        assert_eq!(result.resolved_version, SemVer::new(1, 0, 0));
        assert_eq!(result.trust_status, TrustStatus::FirstUse, "fresh profile -> trust-on-first-use");
        // The pulled manifest carries the region declaration the subscriber's
        // UI uses to know which cells are writeback-enabled.
        let manifest = reg.get_version_manifest(PKG, "1.0.0").unwrap();
        let regions = manifest.writeback_regions.expect("region in manifest");
        assert_eq!(regions[0].id, REGION);
        assert_eq!(regions[0].selector.sheet_id, result.sheets[0].package_sheet_id);
        println!("[{}] pulled v1.0.0, sees region '{REGION}' (trust: FirstUse)", who.display_name);
    }

    // --- 3. Each subscriber COMMITS four quarterly forecasts --------------
    // Per-subscriber mode: the same (region,row,col) slot is private to each
    // submitter, so all three fill the SAME four cells independently.
    let alice_q = [100.0, 110.0, 120.0, 130.0];
    let bob_q = [200.0, 210.0, 220.0, 230.0];
    let carol_q = [50.0, 60.0, 70.0, 80.0];
    for (i, row) in (ROW_Q1..=ROW_Q4).enumerate() {
        commit(&reg, "1.0.0", &region, &alice, row, SubmissionValue::Number { value: alice_q[i] }, "2026-06-15T03:00:00Z", &format!("a-{row}"));
        commit(&reg, "1.0.0", &region, &bob, row, SubmissionValue::Number { value: bob_q[i] }, "2026-06-15T03:01:00Z", &format!("b-{row}"));
        commit(&reg, "1.0.0", &region, &carol, row, SubmissionValue::Number { value: carol_q[i] }, "2026-06-15T03:02:00Z", &format!("c-{row}"));
    }
    println!("[north/south/west] each committed Q1..Q4 forecasts");

    // 12 slots on disk (3 submitters x 4 cells), one file per slot.
    assert_eq!(reg.load_region_submissions(PKG, "1.0.0", REGION).unwrap().len(), 12);

    // --- 4a. Supersedence: Alice corrects Q1 (100 -> 105) -----------------
    // A NEW submission id + NEWER updated_at for the SAME slot. Slot-keyed
    // storage overwrites in place — exactly one file, the newer value wins.
    commit(&reg, "1.0.0", &region, &alice, ROW_Q1, SubmissionValue::Number { value: 105.0 }, "2026-06-15T04:00:00Z", "a-1-rev2");
    println!("[north] corrected Q1: 100 -> 105 (supersedence)");

    // --- 4b. Clear: Carol withdraws Q4 (empty == "no value") --------------
    commit(&reg, "1.0.0", &region, &carol, ROW_Q4, SubmissionValue::Empty, "2026-06-15T04:10:00Z", "c-4-clear");
    println!("[west] cleared Q4 (empty submission)");

    // Still 12 files (corrections/clears overwrite slots, never append).
    let all_v1 = reg.load_region_submissions(PKG, "1.0.0", REGION).unwrap();
    assert_eq!(all_v1.len(), 12, "supersedence + clear are in-place; no slot duplication");
    // The correction won.
    let alice_q1 = all_v1
        .iter()
        .find(|s| s.submitter.id == alice.id && s.cell_row == ROW_Q1)
        .unwrap();
    assert!(matches!(alice_q1.value, SubmissionValue::Number { value } if value == 105.0));

    // Before any approval, the on_approval region aggregates to NOTHING
    // (submitted != approved). This is the governance gate doing its job.
    assert_eq!(governed_submissions(all_v1.clone(), &region, None).len(), 0);
    println!("[publisher] pre-approval GATHER aggregate is empty (on_approval gate)");

    // --- 5. Publisher approves Alice & Bob, rejects Carol's Q1 ------------
    for row in ROW_Q1..=ROW_Q4 {
        decide(&reg, "1.0.0", &alice.id, row, SubmissionState::Approved);
        decide(&reg, "1.0.0", &bob.id, row, SubmissionState::Approved);
    }
    decide(&reg, "1.0.0", &carol.id, ROW_Q1, SubmissionState::Rejected);
    // Carol Q2/Q3 remain merely Submitted; Q4 is an (empty) submission.
    println!("[publisher] approved North+South; rejected West Q1; West Q2/Q3 still pending");

    // Re-read the authoritative post-decision records (decisions overwrite the
    // slot files in place; `all_v1` above is the pre-approval snapshot).
    let after = reg.load_region_submissions(PKG, "1.0.0", REGION).unwrap();
    assert_eq!(after.len(), 12, "approve/reject overwrite slots in place; no duplication");

    // RETURN LEG (read-back): each subscriber can now learn the fate of what
    // they submitted by reloading their OWN slots — exactly the data the app's
    // calp_reconcile_writeback adopts into the local layer + grid cell styling.
    let carol_own = reg.load_submissions(PKG, "1.0.0", &carol.id).unwrap();
    let carol_q1 = carol_own.iter().find(|s| s.cell_row == ROW_Q1).unwrap();
    assert_eq!(carol_q1.state, SubmissionState::Rejected, "West sees Q1 was rejected");
    let alice_own = reg.load_submissions(PKG, "1.0.0", &alice.id).unwrap();
    assert!(
        alice_own.iter().all(|s| s.state == SubmissionState::Approved),
        "North sees all four approved"
    );
    println!("[west] read-back: Q1=rejected (must revise); [north] read-back: all approved");

    // --- 6. The governed aggregate the publisher's GATHER formulas see ----
    let governed = governed_submissions(after.clone(), &region, None);
    // Kept: Alice 4 (approved) + Bob 4 (approved) = 8. Carol contributes
    // nothing (Q1 rejected, Q2/Q3 only submitted, Q4 empty).
    assert_eq!(governed.len(), 8, "GATHER.COUNT");
    let expected_sum = (105.0 + 110.0 + 120.0 + 130.0) + (200.0 + 210.0 + 220.0 + 230.0);
    assert_eq!(sum_numbers(&governed), expected_sum); // 1325
    assert_eq!(expected_sum, 1325.0);
    println!("[publisher] governed aggregate: count=8, SUM(GATHER)={expected_sum}");

    // Cell-aware (GATHER.AT-equivalent) per-line-item consolidation: for each
    // quarter ROW, sum the governed values across submitters AT that cell. This
    // is exactly the data the publisher's =SUM(GATHER.AT(region, row, col))
    // reads — per-line-item totals that the flat GATHER(region) cannot give.
    let at = |row: u32| -> f64 {
        governed
            .iter()
            .filter(|s| s.cell_row == row && s.cell_col == COL)
            .filter_map(|s| match s.value {
                SubmissionValue::Number { value } => Some(value),
                _ => None,
            })
            .sum()
    };
    assert_eq!(at(ROW_Q1), 105.0 + 200.0, "Q1: Carol rejected, Alice+Bob"); // 305
    assert_eq!(at(2), 110.0 + 210.0, "Q2: Carol not yet approved"); // 320
    assert_eq!(at(3), 120.0 + 220.0); // 340
    assert_eq!(at(ROW_Q4), 130.0 + 230.0, "Q4: Carol cleared (empty)"); // 360
    // Per-line-item totals reconstitute the region grand total.
    assert_eq!(at(ROW_Q1) + at(2) + at(3) + at(ROW_Q4), expected_sum);
    println!(
        "[publisher] per-line-item (GATHER.AT) totals: Q1={} Q2={} Q3={} Q4={}",
        at(ROW_Q1), at(2), at(3), at(ROW_Q4)
    );

    // Visibility: own_plus_aggregate from Bob's seat — his 4 values keep his
    // identity; everyone else's values still count but are anonymized.
    let from_bob = governed_submissions(after.clone(), &region, Some(&bob));
    assert_eq!(from_bob.len(), 8, "values from others still aggregate");
    assert_eq!(sum_numbers(&from_bob), expected_sum, "anonymization does not change the totals");
    let own: Vec<_> = from_bob.iter().filter(|s| s.submitter.id == bob.id).collect();
    let anon: Vec<_> = from_bob.iter().filter(|s| s.submitter.id.is_empty()).collect();
    assert_eq!(own.len(), 4, "Bob sees his own 4 with his identity");
    assert_eq!(anon.len(), 4, "the other 4 are anonymized");
    assert!(
        anon.iter().all(|s| s.submitter.display_name.starts_with("Submitter ")),
        "others anonymized to a stable distinct token"
    );
    println!("[south] sees own 4 values by name; other 4 anonymized but still in the total");

    // Privacy boundary check: an own_only variant hides everyone else, and is
    // fail-closed when the reader has no identity.
    let mut own_only = region.clone();
    own_only.visibility = Some(VisibilityPolicy::OwnOnly);
    let bob_private = governed_submissions(after.clone(), &own_only, Some(&bob));
    assert_eq!(bob_private.len(), 4);
    assert_eq!(sum_numbers(&bob_private), 200.0 + 210.0 + 220.0 + 230.0); // 860
    assert_eq!(
        governed_submissions(after.clone(), &own_only, None).len(),
        0,
        "own_only with no identity is fail-closed"
    );

    // --- 7. Version bump: v2.0.0 with a compatible (widened) schema -------
    let mut region_v2 = make_region(wb.sheets[0].id);
    region_v2.schema = Some(ValueSchema {
        value_type: ValueType::Number,
        required: false,
        min: Some(-100.0),         // widened
        max: Some(20_000_000.0),   // widened
        enum_values: Vec::new(),
        max_length: None,
        pattern: None,
        extra: HashMap::new(),
    });
    publish_version(&reg, hq_prof.path(), &wb, SemVer::new(2, 0, 0), vec![region_v2.clone()]);

    let compat = check_region_compatibility(
        std::slice::from_ref(&region),
        std::slice::from_ref(&region_v2),
    );
    assert_eq!(compat.compatible, vec![REGION]);
    assert!(compat.incompatible.is_empty());
    assert_eq!(reg.list_versions(PKG).unwrap(), vec![SemVer::new(1, 0, 0), SemVer::new(2, 0, 0)]);
    println!("[author] published v2.0.0 (schema widened, compatible)");

    // v1 submissions remain readable; v2 starts empty.
    assert_eq!(reg.load_region_submissions(PKG, "1.0.0", REGION).unwrap().len(), 12);
    assert!(reg.load_region_submissions(PKG, "2.0.0", REGION).unwrap().is_empty());

    // Lenient carry-forward (the app copies compatible prior-version records
    // into v2). Carry the current v1 records forward and confirm the v2
    // governed aggregate matches v1's.
    for s in &after {
        reg.save_submission(PKG, "2.0.0", s).unwrap();
    }
    let v2_governed = governed_submissions(
        reg.load_region_submissions(PKG, "2.0.0", REGION).unwrap(),
        &region_v2,
        None,
    );
    assert_eq!(v2_governed.len(), 8);
    assert_eq!(sum_numbers(&v2_governed), expected_sum);
    // v1's own records are untouched by the carry-forward into v2.
    assert_eq!(reg.load_region_submissions(PKG, "1.0.0", REGION).unwrap().len(), 12);
    println!("[publisher] v2.0.0 carried forward v1 forecasts: count=8, SUM(GATHER)={expected_sum}");
    println!("[OK] regional-budget collection simulation complete");
}

// ---------------------------------------------------------------------------
// Focused companion: the real ValueSchema::validate rejects bad subscriber
// input at commit time (the gate every user's value passes through).
// ---------------------------------------------------------------------------

#[test]
fn writeback_schema_gate_rejects_bad_input() {
    let sheet_id = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let region = make_region(sheet_id);
    let schema = region.schema.as_ref().unwrap();

    // In-range numbers pass.
    assert!(schema.validate(&SubmissionValue::Number { value: 5000.0 }).is_ok());
    // Below the floor (min 0) is rejected.
    assert!(schema.validate(&SubmissionValue::Number { value: -1.0 }).is_err());
    // Above the ceiling (max 10M) is rejected.
    assert!(schema.validate(&SubmissionValue::Number { value: 10_000_001.0 }).is_err());
    // Wrong type (boolean into a number cell) is rejected.
    assert!(schema.validate(&SubmissionValue::Boolean { value: true }).is_err());
    // Not required -> empty (a cleared cell) is allowed.
    assert!(schema.validate(&SubmissionValue::Empty).is_ok());
}

// ---------------------------------------------------------------------------
// Publisher authorization: only the package's publisher may approve/reject.
// This is the calp-level primitive the app's `require_publisher` gate
// (calp_commands.rs::calp_set_submission_state) is built on — proof of
// publisher ownership is possession of the Ed25519 key the signed manifest
// asserts as `publisher_key`.
// ---------------------------------------------------------------------------

#[test]
fn writeback_only_publisher_is_authorized_to_approve() {
    let reg_dir = TempDir::new().unwrap();
    let hq_prof = TempDir::new().unwrap();
    let reg = LocalRegistry::open(reg_dir.path()).unwrap();

    let wb = make_budget_workbook();
    let region = make_region(wb.sheets[0].id);
    publish_version(&reg, hq_prof.path(), &wb, SemVer::new(1, 0, 0), vec![region]);

    // The signed version manifest asserts the publisher's public key.
    let manifest = reg.get_version_manifest(PKG, "1.0.0").unwrap();
    assert_eq!(manifest.publisher_key.len(), 64, "package is signed");

    // The completion-tracking roster survives publish -> manifest.
    let pub_region = manifest
        .writeback_regions
        .as_ref()
        .unwrap()
        .iter()
        .find(|r| r.id == REGION)
        .unwrap();
    assert_eq!(
        pub_region.expected_respondents,
        vec!["North", "South", "West", "East"],
        "expected-respondents roster carried in the published manifest"
    );

    // The AUTHOR's profile (which published, so holds publisher-key.json) proves
    // ownership -> the app would authorize approve/reject.
    assert!(
        calp::signing::profile_holds_publisher_key(hq_prof.path(), &manifest.publisher_key).unwrap(),
        "the publisher's own profile must be authorized"
    );

    // A SUBSCRIBER profile (never published, no keypair) does NOT -> approve/reject refused.
    let subscriber_prof = TempDir::new().unwrap();
    assert!(
        !calp::signing::profile_holds_publisher_key(subscriber_prof.path(), &manifest.publisher_key)
            .unwrap(),
        "a subscriber must not be authorized to approve/reject"
    );

    // Even a DIFFERENT publisher (their own keypair) is not THIS package's publisher.
    let other_pub = TempDir::new().unwrap();
    calp::signing::PublisherKeypair::load_or_create(other_pub.path()).unwrap();
    assert!(
        !calp::signing::profile_holds_publisher_key(other_pub.path(), &manifest.publisher_key)
            .unwrap(),
        "another publisher's key must not authorize actions on this package"
    );
}
