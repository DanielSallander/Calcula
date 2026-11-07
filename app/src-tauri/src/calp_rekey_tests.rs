//! FILENAME: app/src-tauri/src/calp_rekey_tests.rs
//! PURPOSE: An application published from ANOTHER application's working copy
//!          owns its writeback regions, charts and ribbon filters under ids of
//!          its own (BUG-0734, owner decision 2026-11-06), and a subscriber
//!          never guesses between two applications that share one.
//! CONTEXT: A working copy of A published as a NEW application B kept A's ids.
//!          A subscriber to both then held two declarations of one region id:
//!          the first subscription answered, so answers typed into B's region
//!          were signed and written into A's workspace (wave 3 closed that
//!          fail-closed with `the_one_region_owner`), and B's charts and ribbon
//!          filters were silently skipped. The publish now re-keys them the way
//!          `data_source_key_for_application` re-keys a data source
//!          (`object_rekeys_for_target` / `rekey_carried_objects`), the
//!          subscribe refuses a shared region id, a GATHER of a shared id reads
//!          neither, and an object not added is said by name.
//!
//!          Every fixture is a REAL signed publish to a temp workspace with the
//!          test's own profile key, through the real carrier
//!          (`assemble_publish_workbook`) and the real materializer.

use std::collections::HashMap;
use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::version::{SemVer, VersionPin};
use calp::writeback::{SubmissionState, SubmissionValue, WritebackSubmission};
use calp::SubmissionOrigin;
use engine::cell::Cell;
use persistence::{SavedCell, Sheet, Workbook};

use crate::calp_commands::{
    load_region_submissions_core, materialize_pull_result, object_key_for_application,
    owning_subscription_for_region, rebuild_gather_cache, refuse_region_already_declared,
    subscribed_region_claims, MaterializeMode, PublishSheetIds, PublishedCarrier,
};
use crate::profile_dir::with_test_profile;

const APP_A: &str = "report-a";
const APP_B: &str = "report-b";
const REGION_A: &str = "01a15d70-0000-7000-8000-0000000000d1";
const NOW: &str = "2026-11-06T00:00:00Z";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Harness {
    state: crate::AppState,
    pivot: crate::pivot::types::PivotState,
    bi: crate::bi::types::BiState,
    scripts: crate::scripting::types::ScriptState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    pane: crate::pane_control::PaneControlState,
    slicer: crate::slicer::SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
}

fn effect() -> crate::document_effect::DocumentEffect {
    crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())
}

impl Harness {
    fn new() -> Self {
        Self {
            state: crate::create_app_state(),
            pivot: crate::pivot::types::PivotState::new(),
            bi: crate::bi::types::BiState::new(),
            scripts: crate::scripting::types::ScriptState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            slicer: crate::slicer::SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    fn materialize(&self, result: calp::pull::PullResult, mode: MaterializeMode) -> crate::calp_commands::PullResponse {
        materialize_pull_result(
            &self.state,
            &effect(),
            &self.pivot,
            &self.bi,
            &self.scripts,
            &self.ribbon,
            &self.pane,
            &self.slicer,
            &self.timeline,
            result,
            mode,
            None,
        )
        .expect("materialization failed")
    }

    /// A working copy of `package` at `version`, as `calp_checkout` leaves one:
    /// the document emptied, the application checked out, the link recorded.
    fn working_copy(dir: &TempDir, prof: &Path, package: &str, version: &str) -> Self {
        let h = Self::new();
        let e = effect();
        *h.state.grid.write(&e).unwrap() = engine::grid::Grid::new();
        *h.state.active_sheet.write(&e).unwrap() = 0;
        h.state.grids.write(&e).unwrap().clear();
        h.state.sheet_names.write(&e).unwrap().clear();
        h.state.sheet_ids.write(&e).unwrap().clear();
        h.state.all_column_widths.write(&e).unwrap().clear();
        h.state.all_row_heights.write(&e).unwrap().clear();
        h.materialize(checkout(dir, prof, package), MaterializeMode::Checkout);
        *h.state.working_copy_link.write(&e).unwrap() =
            Some(calp::WorkingCopyLink::new(&location(dir), package, "report", version, NOW, Vec::new()));
        h
    }

    /// The carrier a publish of THIS workbook's sheets to `package` ships.
    fn carrier(&self, dir: &TempDir, package: &str) -> PublishedCarrier {
        let sheets = self.state.sheet_ids.read().unwrap().clone();
        crate::calp_commands::assemble_publish_workbook(
            &self.state,
            &self.bi,
            &self.pivot,
            &self.scripts,
            &self.slicer,
            &self.ribbon,
            &self.pane,
            &crate::persistence::UserFilesState::default(),
            &self.timeline,
            &PublishSheetIds { sheets, backing: vec![] },
            &location(dir),
            package,
            &[],
            "published",
        )
        .expect("the carrier assembles")
    }

    fn chart_ids(&self) -> Vec<identity::EntityId> {
        let mut ids: Vec<_> = self.state.charts.read().unwrap().iter().map(|c| c.id).collect();
        ids.sort();
        ids
    }
}

fn location(dir: &TempDir) -> String {
    dir.path().to_str().unwrap().to_string()
}

fn region_on(sheet: identity::SheetId, id: &str) -> calp::WritebackRegionDeclaration {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "selector": {
            "sheetId": sheet.to_string(),
            "rowStart": 2, "rowEnd": 4, "colStart": 1, "colEnd": 1
        },
        "mode": "per_subscriber",
        "schema": { "valueType": "number", "required": false },
        "visibility": "own_plus_aggregate",
        "submissionPolicy": "on_submit"
    }))
    .expect("a valid declaration")
}

fn chart_on(host: identity::SheetId, id: identity::EntityId, name: &str) -> persistence::SavedChart {
    persistence::SavedChart {
        id,
        sheet_id: host,
        spec: serde_json::json!({
            "chartId": 1,
            "name": name,
            "sheetIndex": 0,
            "spec": {
                "mark": "bar",
                "data": {
                    "sheetIndex": 0,
                    "sheetId": host.to_string(),
                    "startRow": 0, "startCol": 0, "endRow": 4, "endCol": 1
                }
            }
        }),
    }
}

/// A ribbon filter as the carrier writes one.
fn ribbon_filter(id: identity::EntityId, connection: &str, data_source_id: Option<&str>, name: &str) -> persistence::SavedRibbonFilter {
    serde_json::from_value(serde_json::json!({
        "id": id.to_string(),
        "name": name,
        "connection_id": connection,
        "data_source_id": data_source_id,
        "field_name": "Sales.Region",
        "selected_items": null,
    }))
    .expect("a minimal ribbon filter deserialises")
}

/// The form: one sheet whose D1 totals the region with GATHER.
fn form_workbook(region: &str, chart: identity::EntityId) -> Workbook {
    let mut form = Sheet::new("Form".to_string());
    let mut total = Cell::new_formula(format!("=SUM(GATHER(\"{region}\"))"));
    total.value = engine::CellValue::Number(0.0);
    form.cells.insert((0, 3), SavedCell::from_cell(&total));
    let mut wb = Workbook::default();
    wb.sheets = vec![form];
    let host = wb.sheets[0].id;
    wb.charts = vec![chart_on(host, chart, "Revenue")];
    wb
}

/// A publish straight through core -- a package exactly as `wb` and
/// `regions` say, the carrier bypassed (a hand-made package, or an earlier
/// build's).
fn publish_raw(
    dir: &TempDir,
    prof: &Path,
    wb: &Workbook,
    package: &str,
    regions: Vec<calp::WritebackRegionDeclaration>,
) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: wb,
        package_name: package.to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: "first".to_string(),
        sheet_indices: (0..wb.sheets.len()).collect(),
        now: NOW.to_string(),
        published_by: "author".to_string(),
        writeback_regions: Some(regions),
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        identity_policy: None,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof).expect("publish failed");
}

/// Publish what `carrier` assembled, as `calp_publish` hands it to core.
fn publish_carrier(dir: &TempDir, prof: &Path, carrier: PublishedCarrier, package: &str, version: (u32, u32, u32), mode: PushMode) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let assembly = carrier.assembly;
    let request = PublishRequest {
        workbook: &assembly.workbook,
        package_name: package.to_string(),
        version: SemVer::new(version.0, version.1, version.2),
        kind: "report".to_string(),
        mode,
        change_summary: "a push".to_string(),
        sheet_indices: carrier.sheet_indices.clone(),
        now: NOW.to_string(),
        published_by: "author".to_string(),
        writeback_regions: assembly.writeback_regions,
        model_writebacks: None,
        object_scripts: assembly.object_scripts,
        module_scripts: None,
        notebooks: None,
        data_sources: assembly.data_sources,
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        identity_policy: None,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof).expect("the carrier publishes");
}

fn subscribe_pull(dir: &TempDir, prof: &Path, package: &str) -> calp::pull::PullResult {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(&location(dir)).unwrap();
    calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: package.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(VersionPin::Latest),
            now: NOW.to_string(),
        },
        &scope,
        prof,
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("pull failed")
}

fn checkout(dir: &TempDir, prof: &Path, package: &str) -> calp::pull::PullResult {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(&location(dir)).unwrap();
    calp::checkout::checkout(&reg, package, None, NOW, &scope, prof).expect("checkout failed").pulled
}

/// What `calp_pull` asks before its effect: the subscribe-time region gate.
fn subscribe_gate(s: &Harness, pulled: &calp::pull::PullResult) -> Result<(), String> {
    let subscriptions = s.state.subscriptions.read().unwrap().subscriptions.clone();
    refuse_region_already_declared(&pulled.writeback_regions, &pulled.package_name, &subscribed_region_claims(&subscriptions))
}

/// A person's 32-byte signing seed (the app keeps the real one in the
/// Credential Manager).
fn seed_of(who: &str) -> [u8; 32] {
    let hex = calp::integrity::sha256_hex(who.as_bytes());
    let mut seed = [0u8; 32];
    for (i, pair) in hex.as_bytes().chunks(2).enumerate() {
        seed[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
    }
    seed
}

fn signed_identity(who: &str) -> calp::SubmitterIdentity {
    calp::identity_provider::identity_for(
        calp::IdentityProviderKind::Windows,
        &calp::identity_provider::AccountFacts {
            subject: format!("S-1-5-21-7-7-7-{}", 1000 + who.len()),
            principal_name: format!("CORP\\{}", who.to_lowercase()),
            display_name: who.to_string(),
            scope: calp::AccountScope::Domain,
        },
        &calp::submission_seal::public_key_of_seed(&seed_of(who)),
    )
    .unwrap()
}

/// `who` types `value` into the region and sends it: routed by the region id
/// exactly as the submit is (`owning_subscription_for_region`), signed with
/// the sender's key for THAT application and version, written into THAT
/// application's workspace. Returns the application it went to.
fn send(s: &Harness, dir: &TempDir, region: &str, who: &str, value: f64) -> String {
    let owner = owning_subscription_for_region(&s.state, region).expect("the region has one owner");
    let mut answer = WritebackSubmission {
        id: format!("s-{}-{region}", who.to_lowercase()),
        region_id: region.to_string(),
        cell_row: 2,
        cell_col: 1,
        cell_id: None,
        submitter: signed_identity(who),
        value: SubmissionValue::Number { value },
        state: SubmissionState::Submitted,
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
        submitted_at: Some(NOW.to_string()),
        review_reason: None,
        reviewed_by: None,
        environment: owner.environment.clone(),
        model_key: None,
        seal: None,
        sender: Default::default(),
        identity: Default::default(),
        extra: HashMap::new(),
    };
    calp::submission_seal::seal_submission(
        &mut answer,
        &owner.package_name,
        &owner.resolved_version,
        &seed_of(who),
        SubmissionOrigin::Interactive,
    )
    .expect("the sender signs");
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    calp::WorkspaceTransport::save_submission(&reg, &owner.package_name, &owner.resolved_version, &answer)
        .expect("save submission");
    owner.package_name
}

/// Every file of `package`'s folder in the workspace, as text.
fn package_texts(dir: &TempDir, package: &str) -> Vec<(std::path::PathBuf, String)> {
    fn walk(at: &Path, out: &mut Vec<(std::path::PathBuf, String)>) {
        for entry in std::fs::read_dir(at).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else {
                out.push((path.clone(), String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned()));
            }
        }
    }
    let mut out = Vec::new();
    walk(&dir.path().join(package), &mut out);
    out
}

fn region_ids(carrier: &PublishedCarrier) -> Vec<String> {
    carrier.assembly.writeback_regions.iter().flatten().map(|r| r.id.clone()).collect()
}

fn carried_chart_ids(carrier: &PublishedCarrier) -> Vec<identity::EntityId> {
    carrier.assembly.workbook.charts.iter().map(|c| c.id).collect()
}

fn gather_formula(carrier: &PublishedCarrier) -> String {
    carrier.assembly.workbook.sheets[carrier.sheet_indices[0]]
        .cells
        .get(&(0, 3))
        .and_then(|c| c.formula.clone())
        .expect("the GATHER total ships")
}

// ---------------------------------------------------------------------------
// The owner's decision, end to end
// ---------------------------------------------------------------------------

/// PUBLISH A; PUBLISH A'S WORKING COPY AS A NEW APPLICATION B; SUBSCRIBE TO
/// BOTH; ANSWER EACH REGION. Each answer lands, signed, in its own
/// application's workspace; B's Collected Responses (from B's own working
/// copy) shows B's answers and A's shows A's; a GATHER on each application's
/// sheet totals its own; both applications' charts arrive; and a push of B
/// from its working copy keeps B's ids -- while a push of A from A's working
/// copy keeps A's.
///
/// SABOTAGE (rekey-fork): make `object_rekeys_for_target` treat no publish as
/// a fork (`let forking = false && ...`) -- B's carrier still names A's region,
/// and the first assertion on it fails ("B CARRIES ITS OWN REGION ID").
#[test]
fn a_copy_published_as_a_new_application_collects_into_its_own_workspace() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let chart_a = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let wb = form_workbook(REGION_A, chart_a);
        let form = wb.sheets[0].id;
        publish_raw(&dir, prof.path(), &wb, APP_A, vec![region_on(form, REGION_A)]);

        // A's working copy, with a ribbon filter of its own beside the chart.
        let w = Harness::working_copy(&dir, prof.path(), APP_A, "1.0.0");
        let filter_a = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        {
            let saved = ribbon_filter(filter_a, &identity::EntityId::from_bytes(identity::generate_uuid_v7()).to_string(), None, "Region");
            let filter = crate::persistence::saved_to_ribbon_filter(&saved);
            w.ribbon.filters.write(&effect()).unwrap().insert(filter.id, filter);
        }

        // A push of A from its own working copy keeps every id.
        let own = w.carrier(&dir, APP_A);
        assert_eq!(region_ids(&own), vec![REGION_A.to_string()], "a push to the working copy's own application keeps its region id");
        assert_eq!(carried_chart_ids(&own), vec![chart_a], "...and its chart id");
        let own_filters: Vec<_> = own.assembly.workbook.ribbon_filters.iter().map(|f| f.id).collect();
        assert_eq!(own_filters, vec![filter_a], "...and its ribbon filter id");

        // The same workbook published as the NEW application B.
        let b_region = object_key_for_application("writebackRegion", APP_B, REGION_A);
        let b_chart = identity::EntityId::parse(&object_key_for_application("chart", APP_B, &chart_a.to_string())).unwrap();
        let b_filter =
            identity::EntityId::parse(&object_key_for_application("ribbonFilter", APP_B, &filter_a.to_string())).unwrap();
        assert_ne!(b_region, REGION_A);
        let fork = w.carrier(&dir, APP_B);
        assert_eq!(region_ids(&fork), vec![b_region.clone()], "B CARRIES ITS OWN REGION ID, not A's");
        assert_eq!(carried_chart_ids(&fork), vec![b_chart], "B carries its own chart id");
        let fork_filters: Vec<_> = fork.assembly.workbook.ribbon_filters.iter().map(|f| f.id).collect();
        assert_eq!(fork_filters, vec![b_filter], "B carries its own ribbon-filter id");
        let total = gather_formula(&fork);
        assert!(total.contains(&format!("\"{b_region}\"")) && !total.contains(REGION_A), "B's GATHER names B's region: {total}");
        assert_eq!(
            object_key_for_application("writebackRegion", APP_B, REGION_A),
            b_region,
            "deterministic: B's next version names the same id"
        );
        publish_carrier(&dir, prof.path(), fork, APP_B, (1, 0, 0), PushMode::CreateNew);

        // Re-keyed BEFORE signing: nothing in B's signed package names A's ids.
        let files = package_texts(&dir, APP_B);
        assert!(!files.is_empty(), "fixture: B's package is where the scan looks");
        for (path, text) in &files {
            assert!(!text.contains(REGION_A), "{} still names A's region id", path.display());
            assert!(!text.contains(&chart_a.to_string()), "{} still names A's chart id", path.display());
        }
        assert!(files.iter().any(|(_, t)| t.contains(&b_region)), "B's signed manifest declares B's region");

        // A subscriber to both: the subscribe gate lets B in, and both charts arrive.
        let s = Harness::new();
        s.materialize(subscribe_pull(&dir, prof.path(), APP_A), MaterializeMode::Subscribe);
        let pulled_b = subscribe_pull(&dir, prof.path(), APP_B);
        subscribe_gate(&s, &pulled_b).expect("B declares no region A declares");
        let response = s.materialize(pulled_b, MaterializeMode::Subscribe);
        // No id collision. The one sentence is the fixture's ribbon filter,
        // whose model B does not carry: said, not only logged (BUG-0734).
        assert_eq!(response.objects_not_added.len(), 1, "{:?}", response.objects_not_added);
        assert!(
            response.objects_not_added[0].contains("'Region'")
                && response.objects_not_added[0].contains("model it filters is not part of"),
            "{:?}",
            response.objects_not_added
        );
        let mut both = vec![chart_a, b_chart];
        both.sort();
        assert_eq!(s.chart_ids(), both, "each application's chart is there");

        // Each answer goes to its own application's workspace, signed.
        assert_eq!(send(&s, &dir, REGION_A, "Alice", 10.0), APP_A);
        assert_eq!(send(&s, &dir, &b_region, "Bob", 20.0), APP_B);

        // A GATHER on each sheet totals its own application's answers.
        let gathered = rebuild_gather_cache(&s.state);
        // (Names are anonymised for an own-plus-aggregate region; the values are not.)
        let values = |id: &str| -> Vec<f64> {
            gathered
                .get(id)
                .map(|d| {
                    d.submissions
                        .iter()
                        .map(|g| match &g.value {
                            engine::EvalResult::Number(n) => *n,
                            _ => f64::NAN,
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        assert_eq!(values(REGION_A), vec![10.0], "A's GATHER totals A's answer");
        assert_eq!(values(&b_region), vec![20.0], "B's GATHER totals B's answer");

        // B's Collected Responses, from B's own working copy: B's answer, signed.
        let wb_b = Harness::working_copy(&dir, prof.path(), APP_B, "1.0.0");
        let drafts: Vec<String> = wb_b.state.writeback_draft_regions.read().unwrap().iter().map(|d| d.id.clone()).collect();
        assert_eq!(drafts, vec![b_region.clone()], "B's working copy designates B's region");
        let inbox = load_region_submissions_core(&wb_b.state, &b_region).expect("B's inbox");
        let rows: Vec<(String, String)> = inbox.iter().map(|r| (r.submitter_name.clone(), r.submitter_principal.clone())).collect();
        assert_eq!(rows, vec![("Bob".to_string(), "CORP\\bob".to_string())], "B collects B's answer, signed");
        // ...and A's from A's: A's answer only.
        let inbox_a = load_region_submissions_core(&w.state, REGION_A).expect("A's inbox");
        let rows_a: Vec<String> = inbox_a.iter().map(|r| r.submitter_name.clone()).collect();
        assert_eq!(rows_a, vec!["Alice".to_string()], "A collects A's answer only");

        // A push of B from B's working copy keeps B's ids.
        let again = wb_b.carrier(&dir, APP_B);
        assert_eq!(region_ids(&again), vec![b_region.clone()], "republishing B keeps B's region id");
        assert_eq!(carried_chart_ids(&again), vec![b_chart], "...and B's chart id");
        assert!(gather_formula(&again).contains(&format!("\"{b_region}\"")));
    });
}

/// A HAND-MADE COLLISION IS STILL REFUSED. A package that declares A's region
/// id and carries A's chart id verbatim (the carrier bypassed) is refused at
/// the subscribe by name; a subscription that holds it anyway (an earlier
/// build's) sends nothing to either and a GATHER of the shared id reads
/// neither; and its chart is not added, which the pull SAYS.
///
/// SABOTAGES (separate builds): (rekey-gate) make `refuse_region_already_declared`
/// return `Ok(())` -- "THE SUBSCRIBE REFUSES" fails. (rekey-gather) put back
/// the first-wins `.entry(..).or_insert(..)` in `rebuild_gather_cache` -- the
/// GATHER assertion fails. (rekey-chart) drop the `objects_not_added.push` in
/// `materialize_pull_result`'s chart block -- "THE PULL SAYS SO" fails.
#[test]
fn a_hand_made_region_collision_is_refused_and_a_skipped_chart_is_reported() {
    let dir = TempDir::new().unwrap();
    // The copy lives in a workspace of its own: core publish refuses a second
    // application declaring A's region id in A's workspace (BUG-0734, rk3).
    let dir_c = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let chart_a = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let wb = form_workbook(REGION_A, chart_a);
        let form = wb.sheets[0].id;
        publish_raw(&dir, prof.path(), &wb, APP_A, vec![region_on(form, REGION_A)]);
        publish_raw(&dir_c, prof.path(), &wb, "copycat", vec![region_on(form, REGION_A)]);

        let s = Harness::new();
        s.materialize(subscribe_pull(&dir, prof.path(), APP_A), MaterializeMode::Subscribe);
        send(&s, &dir, REGION_A, "Alice", 10.0);
        assert!(rebuild_gather_cache(&s.state).contains_key(REGION_A), "the premise: A's GATHER reads A's answers");

        let copycat = subscribe_pull(&dir_c, prof.path(), "copycat");
        let refused = subscribe_gate(&s, &copycat).expect_err("THE SUBSCRIBE REFUSES a region id A declares");
        assert!(refused.starts_with("CALP_REGION_SHARED:"), "{refused}");
        assert!(refused.contains("'report-a'") && refused.contains(REGION_A), "names the region and the application: {refused}");

        // Held anyway: nothing is guessed.
        let response = s.materialize(copycat, MaterializeMode::Subscribe);
        assert_eq!(s.chart_ids(), vec![chart_a], "A's chart is kept, never clobbered");
        assert_eq!(response.objects_not_added.len(), 1, "THE PULL SAYS SO: {:?}", response.objects_not_added);
        let said = &response.objects_not_added[0];
        assert!(said.contains("'Revenue'") && said.contains("'copycat'") && said.contains(&chart_a.to_string()), "{said}");
        let shared = owning_subscription_for_region(&s.state, REGION_A).err().unwrap_or_default();
        assert!(shared.starts_with("CALP_REGION_SHARED:"), "the submit-time backstop still refuses: {shared}");
        let gathered = rebuild_gather_cache(&s.state);
        let shared_data = gathered.get(REGION_A).expect("a shared id is answered, as a refusal");
        assert!(
            shared_data.refused && shared_data.submissions.is_empty(),
            "a GATHER of a region id two applications declare reads neither, and is #REF! on the sheet"
        );
    });
}

/// A pulled SAVED PIVOT LAYOUT whose id the workbook already holds is not
/// added, and the pull says so (BUG-0734: it was skipped in silence).
///
/// SABOTAGE (rk2-layout): drop the `objects_not_added.extend` in the
/// pivot-layout block of `materialize_pull_result` -- "THE PULL SAYS SO" fails.
#[test]
fn a_pivot_layout_whose_id_is_taken_is_reported() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let mut wb = form_workbook(REGION_A, identity::EntityId::from_bytes(identity::generate_uuid_v7()));
        let layout: persistence::SavedPivotLayout = serde_json::from_value(serde_json::json!({
            "id": identity::EntityId::from_bytes(identity::generate_uuid_v7()).to_string(),
            "name": "By region",
            "dsl_text": "ROWS: Region",
            "description": null,
            "source_type": "table",
            "source_table_name": "Sales",
            "source_bi_tables": [],
            "source_bi_measures": [],
            "created_at": 0.0,
            "updated_at": 0.0
        }))
        .expect("a pivot layout");
        wb.pivot_layouts = vec![layout];
        publish_raw(&dir, prof.path(), &wb, APP_A, Vec::new());
        publish_raw(&dir, prof.path(), &wb, "copycat", Vec::new());
        let s = Harness::new();
        let first = s.materialize(subscribe_pull(&dir, prof.path(), APP_A), MaterializeMode::Subscribe);
        assert!(
            !first.objects_not_added.iter().any(|l| l.contains("pivot layout")),
            "the first layout lands: {:?}",
            first.objects_not_added
        );
        let second = s.materialize(subscribe_pull(&dir, prof.path(), "copycat"), MaterializeMode::Subscribe);
        assert!(
            second
                .objects_not_added
                .iter()
                .any(|l| l.contains("saved pivot layout 'By region'") && l.contains("'copycat'")),
            "THE PULL SAYS SO: {:?}",
            second.objects_not_added
        );
        assert_eq!(s.state.pivot_layouts.read().unwrap().len(), 1, "never clobbered, never duplicated");
    });
}

/// THE OUTAGE WINDOW (BUG-0734 verifier, major): a subscriber holds A and a
/// copy that declares A's region id (an earlier build's, held anyway). While
/// the copy's workspace cannot be reached, the copy is STILL a claimant: the
/// submit refuses and the GATHER is #REF!, from the ledger rows the subscribe
/// recorded -- never "A is the only one that answered, so A owns it".
///
/// SABOTAGE (rk2-outage): make `recorded_region_claimants` return an empty map
/// -- the submit resolves to A ("THE OUTAGE MAKES NO ONE OWNER") fails.
#[test]
fn an_unreachable_claimant_still_shares_the_region() {
    let dir_a = TempDir::new().unwrap();
    let dir_c = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let wb = form_workbook(REGION_A, identity::EntityId::from_bytes(identity::generate_uuid_v7()));
        let form = wb.sheets[0].id;
        publish_raw(&dir_a, prof.path(), &wb, APP_A, vec![region_on(form, REGION_A)]);
        publish_raw(&dir_c, prof.path(), &wb, "copycat", vec![region_on(form, REGION_A)]);

        let s = Harness::new();
        s.materialize(subscribe_pull(&dir_a, prof.path(), APP_A), MaterializeMode::Subscribe);
        s.materialize(subscribe_pull(&dir_c, prof.path(), "copycat"), MaterializeMode::Subscribe);
        let recorded: Vec<(String, Vec<String>)> = s
            .state
            .subscriptions
            .read()
            .unwrap()
            .subscriptions
            .iter()
            .map(|sub| {
                (
                    sub.package_name.clone(),
                    sub.objects.iter().filter(|o| o.kind == "writebackRegion").map(|o| o.id.clone()).collect(),
                )
            })
            .collect();
        assert_eq!(
            recorded,
            vec![(APP_A.to_string(), vec![REGION_A.to_string()]), ("copycat".to_string(), vec![REGION_A.to_string()])],
            "each subscribe records the region ids its verified version declares"
        );
        send_direct(&dir_a, prof.path(), REGION_A, "Alice", 10.0);

        // The copy's workspace goes away (a share offline, a host down).
        let gone = dir_c.path().to_path_buf();
        drop(dir_c);
        assert!(!gone.exists(), "fixture: the copy's workspace is unreachable");

        let owner = owning_subscription_for_region(&s.state, REGION_A).map(|o| o.package_name);
        let refused = owner.expect_err("THE OUTAGE MAKES NO ONE OWNER of a region two applications declare");
        assert!(refused.starts_with("CALP_REGION_SHARED:"), "{refused}");
        assert!(refused.contains("'copycat'") && refused.contains("'report-a'"), "names both claimants: {refused}");

        let gathered = rebuild_gather_cache(&s.state);
        let data = gathered.get(REGION_A).expect("the shared id is answered, as a refusal");
        assert!(data.refused && data.submissions.is_empty(), "A's answers do not feed a GATHER of a shared id");

        let claims = subscribed_region_claims(&s.state.subscriptions.read().unwrap().subscriptions);
        assert_eq!(claims[REGION_A].len(), 2, "the subscribe gate counts the unreachable claimant too");
    });
}

/// Write a signed answer for `region` straight into A's workspace (the region
/// is shared, so no submit route resolves an owner).
fn send_direct(dir: &TempDir, _prof: &Path, region: &str, who: &str, value: f64) {
    let mut answer = WritebackSubmission {
        id: format!("s-{}-{region}", who.to_lowercase()),
        region_id: region.to_string(),
        cell_row: 2,
        cell_col: 1,
        cell_id: None,
        submitter: signed_identity(who),
        value: SubmissionValue::Number { value },
        state: SubmissionState::Submitted,
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
        submitted_at: Some(NOW.to_string()),
        review_reason: None,
        reviewed_by: None,
        environment: String::new(),
        model_key: None,
        seal: None,
        sender: Default::default(),
        identity: Default::default(),
        extra: HashMap::new(),
    };
    calp::submission_seal::seal_submission(&mut answer, APP_A, "1.0.0", &seed_of(who), SubmissionOrigin::Interactive)
        .expect("the sender signs");
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    calp::WorkspaceTransport::save_submission(&reg, APP_A, "1.0.0", &answer).expect("save submission");
}

/// A REFRESH may not bring a version that declares a region id another
/// subscription declares (the rekey lane's remains 2): refused by name, as the
/// subscribe is, while a refresh of the application that owns the id is not.
///
/// SABOTAGE (rk2-refresh): make `refuse_refreshed_regions_already_declared`
/// return `Ok(())` at its top -- "THE REFRESH REFUSES" fails.
#[test]
fn a_refresh_that_brings_a_shared_region_id_is_refused() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let wb = form_workbook(REGION_A, identity::EntityId::from_bytes(identity::generate_uuid_v7()));
        let form = wb.sheets[0].id;
        publish_raw(&dir, prof.path(), &wb, APP_A, vec![region_on(form, REGION_A)]);
        publish_raw(&dir, prof.path(), &wb, APP_B, vec![region_on(form, "01a15d70-0000-7000-8000-0000000000b1")]);
        // In a workspace of its own: core publish refuses it in A's (rk3).
        let dir_c = TempDir::new().unwrap();
        publish_raw(&dir_c, prof.path(), &wb, "copycat", vec![region_on(form, REGION_A)]);
        let s = Harness::new();
        s.materialize(subscribe_pull(&dir, prof.path(), APP_A), MaterializeMode::Subscribe);
        s.materialize(subscribe_pull(&dir, prof.path(), APP_B), MaterializeMode::Subscribe);

        // B's "new version" declares A's region id (a hand-made package).
        let mut incoming = subscribe_pull(&dir_c, prof.path(), "copycat");
        incoming.package_name = APP_B.to_string();
        let payload = calp::refresh::RefreshPayload { subscription_index: 1, pull_result: incoming };
        let refused = crate::calp_commands::refuse_refreshed_regions_already_declared(&s.state, &[payload])
            .expect_err("THE REFRESH REFUSES a version declaring a region id A declares");
        assert!(refused.starts_with("CALP_REGION_SHARED:") && refused.contains("'report-a'"), "{refused}");

        // Positive control: A refreshing to a version that declares its own id.
        let own = calp::refresh::RefreshPayload { subscription_index: 0, pull_result: subscribe_pull(&dir, prof.path(), APP_A) };
        crate::calp_commands::refuse_refreshed_regions_already_declared(&s.state, &[own])
            .expect("a refresh of the application that owns the id is not refused");
    });
}

/// A STANDALONE WORKBOOK holding another application's region id cannot
/// publish it as a NEW application (verifier minor 2): refused by name with a
/// remedy, while the application that already declares it may push it.
/// And a region on a sheet the package does not carry never ships (a second
/// checkout's regions stayed beside the first's).
///
/// SABOTAGES: (rk2-taken) make `refuse_regions_another_application_declares`
/// return `Ok(())` at its top -- "THE NEW APPLICATION IS REFUSED" fails.
/// (rk2-sheets) ship every draft region again (`let on_carried = drafts.clone()`)
/// -- "ONLY THE CARRIED SHEETS' REGIONS" fails.
#[test]
fn a_new_application_may_not_declare_a_region_another_application_declares() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let wb = form_workbook(REGION_A, identity::EntityId::from_bytes(identity::generate_uuid_v7()));
        let form = wb.sheets[0].id;
        publish_raw(&dir, prof.path(), &wb, APP_A, vec![region_on(form, REGION_A)]);
        let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
        let regions = vec![region_on(form, REGION_A)];
        let refused = crate::calp_commands::refuse_regions_another_application_declares(&reg, "budget-2026", &regions, &[])
            .expect_err("THE NEW APPLICATION IS REFUSED a region id A declares");
        assert!(refused.starts_with("CALP_REGION_TAKEN:"), "{refused}");
        assert!(refused.contains("'report-a'") && refused.contains(REGION_A), "names the owner and the region: {refused}");
        crate::calp_commands::refuse_regions_another_application_declares(&reg, APP_A, &regions, &[])
            .expect("A's own history keeps A's region");
        crate::calp_commands::refuse_regions_another_application_declares(
            &reg,
            "budget-2026",
            &[region_on(form, "01a15d70-0000-7000-8000-0000000000c1")],
            &[],
        )
        .expect("a region id no application declares is free");

        // THE PREVIEW SAYS WHAT THE PUBLISH WOULD REFUSE (rk3), and nothing
        // for a push it would let through.
        let said = crate::calp_commands::region_taken_preview_warning(&location(&dir), "budget-2026", &regions, &[])
            .expect("THE PREVIEW WARNS of the refusal the publish gives");
        assert!(said.contains("CALP_REGION_TAKEN:") && said.contains("'report-a'"), "{said}");
        assert_eq!(crate::calp_commands::region_taken_preview_warning(&location(&dir), APP_A, &regions, &[]), None);

        // A working copy of A that also holds a region on a sheet it does not
        // carry (another application's, from an earlier checkout).
        let w = Harness::working_copy(&dir, prof.path(), APP_A, "1.0.0");
        let elsewhere = identity::SheetId::from_bytes(identity::generate_uuid_v7());
        w.state
            .writeback_draft_regions
            .write(&effect())
            .unwrap()
            .push(region_on(elsewhere, "01a15d70-0000-7000-8000-0000000000c2"));
        assert_eq!(
            region_ids(&w.carrier(&dir, APP_A)),
            vec![REGION_A.to_string()],
            "ONLY THE CARRIED SHEETS' REGIONS ship"
        );
    });
}

/// A SUBSCRIBED object never re-keys onto the fork's own copy of the same
/// source object (verifier minor 3), and a carrier that would still file two
/// objects of one family under one id is refused.
///
/// SABOTAGE (rk2-salt): derive a subscribed object's id without its source
/// application (`&id` instead of `&format!("{source}\0{id}")`) -- the
/// fork-subscribes-to-its-original case collides and "NO TWO FILTERS UNDER ONE
/// ID" fails.
#[test]
fn a_subscribed_object_never_re_keys_onto_the_forks_own_copy() {
    let state = crate::create_app_state();
    let location = r"\\server\reports";
    let source_filter = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let forks_own =
        identity::EntityId::parse(&object_key_for_application("ribbonFilter", APP_B, &source_filter.to_string())).unwrap();
    // B's working copy (B owns `forks_own`), subscribing to A, which brought `source_filter`.
    let e = effect();
    *state.working_copy_link.write(&e).unwrap() =
        Some(calp::WorkingCopyLink::new(location, APP_B, "report", "1.0.0", NOW, Vec::new()));
    let sub: calp::manifest::Subscription = serde_json::from_value(serde_json::json!({
        "packageName": APP_A,
        "registryUrl": r"\\server\other",
        "versionPin": "latest",
        "resolvedVersion": "1.0.0",
        "resolvedAt": NOW,
        "sheets": [],
        "objects": [{ "kind": "ribbonFilter", "id": source_filter.to_string() }]
    }))
    .expect("a subscription");
    state.subscriptions.write(&e).unwrap().subscriptions.push(sub);
    let mut wb = Workbook::default();
    let connection = identity::EntityId::from_bytes(identity::generate_uuid_v7()).to_string();
    wb.ribbon_filters = vec![
        ribbon_filter(forks_own, &connection, None, "Mine"),
        ribbon_filter(source_filter, &connection, None, "Theirs"),
    ];
    let rekeys = crate::calp_commands::object_rekeys_for_target(&state, location, APP_B, &wb, None)
        .expect("NO TWO FILTERS UNDER ONE ID: the subscribed filter has an id of its own");
    let shipped = &rekeys[&source_filter.to_string()];
    assert_ne!(shipped, &forks_own.to_string());
    assert!(!rekeys.contains_key(&forks_own.to_string()), "B's own filter keeps B's id");

    // The backstop: an own chart that already holds the id the subscribed
    // chart would be filed under.
    let source_chart = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    state.subscriptions.write(&e).unwrap().subscriptions[0]
        .objects
        .push(calp::manifest::SubscribedObject {
            kind: "chart".to_string(),
            id: source_chart.to_string(),
            name: String::new(),
            extra: HashMap::new(),
        });
    let squatter = identity::EntityId::parse(&object_key_for_application(
        "chart",
        APP_B,
        &format!("{APP_A}\0{source_chart}"),
    ))
    .unwrap();
    let host = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    wb.charts = vec![chart_on(host, squatter, "Mine"), chart_on(host, source_chart, "Theirs")];
    let refused = crate::calp_commands::object_rekeys_for_target(&state, location, APP_B, &wb, None)
        .expect_err("two charts under one id are refused");
    assert!(refused.starts_with("CALP_OBJECT_ID_TAKEN:"), "{refused}");
}

/// PUBLISH AS A NEW APPLICATION is not a mid-push re-point: the response says
/// the workbook stays a working copy of the original (the rekey lane's new
/// defect), while a link a checkout re-pointed mid-push is still reported so.
///
/// SABOTAGE (rk2-fork): drop the `fork_of` arm in
/// `record_push_in_working_copy_link` -- "A FORK IS NOT A RE-POINT" fails.
#[test]
fn publishing_as_a_new_application_is_a_fork_not_a_re_point() {
    use crate::calp_commands::PushLinkRecord;
    let state = crate::create_app_state();
    let file = crate::persistence::FileState::default();
    let epoch = file.document_epoch();
    let location = r"\\server\reports".to_string();
    let a_link = calp::WorkingCopyLink::new(&location, APP_A, "report", "1.0.0", NOW, Vec::new());
    let load = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    *state.working_copy_link.write(&load).unwrap() = Some(a_link.clone());
    let record = |fork_of: Option<&(String, String)>| {
        crate::calp_commands::record_push_in_working_copy_link(
            &state,
            &file,
            epoch,
            &location,
            APP_B,
            "report",
            "1.0.0",
            NOW,
            Vec::new(),
            calp::WorkingCopyContent::default(),
            fork_of,
        )
        .expect("the link write does not fail")
    };
    let started_on_a = (location.clone(), APP_A.to_string());
    assert_eq!(
        record(Some(&started_on_a)),
        PushLinkRecord::Forked { working_copy_of: APP_A.to_string() },
        "A FORK IS NOT A RE-POINT"
    );
    assert_eq!(state.working_copy_link.read().unwrap().clone(), Some(a_link), "the link stays on A");
    // The push started on A, and the link now names C: a mid-push re-point.
    let mut c_link = calp::WorkingCopyLink::new(&location, "report-c", "report", "1.0.0", NOW, Vec::new());
    c_link.base_version = "2.0.0".to_string();
    *state.working_copy_link.write(&load).unwrap() = Some(c_link);
    assert_eq!(
        record(Some(&started_on_a)),
        PushLinkRecord::LinkRepointed { now_targets: "report-c".to_string() }
    );
    assert!(!file.is_dirty(), "neither records anything");
}

/// THE WIRING: the refresh asks the region gate before its effect, and the
/// publish asks the workspace before core publish writes.
#[test]
fn the_refresh_and_the_publish_ask_the_region_rules() {
    let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"))
        .expect("cannot read calp_commands.rs");
    let body = |signature: &str| -> String {
        let start = src.find(signature).unwrap_or_else(|| panic!("no `{signature}`"));
        let rest = &src[start..];
        let end = rest[signature.len()..].find("\npub fn ").map(|i| i + signature.len()).unwrap_or(rest.len());
        rest[..end].lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
    };
    let refresh = body("pub fn calp_refresh_apply(");
    let gate = refresh.find("refuse_refreshed_regions_already_declared(").expect("the refresh no longer asks the region gate");
    let effect = refresh.find("DocumentEffect::mutates(").expect("the refresh's effect");
    assert!(gate < effect, "the refresh's region gate runs after its effect");
    let publish = body("pub fn calp_publish(");
    let taken = publish.find("refuse_regions_another_application_declares(").expect("the publish no longer asks the workspace");
    let core = publish.find("calp::publish::publish(").expect("core publish");
    assert!(taken < core, "the workspace is asked after core publish wrote");
    assert!(src.contains("entries.extend(region_ledger_entries(&payload.pull_result.writeback_regions));"), "the refresh no longer records the region ids");
    assert!(src.contains("subscription.objects.extend(region_ledger_entries(&result.writeback_regions));"), "the subscribe no longer records the region ids");
}

/// A pulled RIBBON FILTER whose id or name the workbook already holds is not
/// added -- never clobbered -- and the pull says which, and why.
///
/// SABOTAGE (rekey-filter): drop the `not_added.push` in the id-collision arm
/// of `materialize_pulled_ribbon_filters` -- the id sentence fails.
#[test]
fn a_ribbon_filter_whose_id_or_name_is_taken_is_reported_not_skipped_in_silence() {
    let ribbon = crate::ribbon_filter::RibbonFilterState::new();
    let pane = crate::pane_control::PaneControlState::new();
    let connection = identity::EntityId::from_bytes(identity::generate_uuid_v7()).to_string();
    let taken_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    {
        let mine = crate::persistence::saved_to_ribbon_filter(&ribbon_filter(taken_id, &connection, Some(&connection), "Mine"));
        ribbon.filters.write(&effect()).unwrap().insert(mine.id, mine);
    }
    let pulled = vec![
        ribbon_filter(taken_id, &connection, Some(&connection), "Region"),
        ribbon_filter(identity::EntityId::from_bytes(identity::generate_uuid_v7()), &connection, Some(&connection), "Mine"),
        ribbon_filter(identity::EntityId::from_bytes(identity::generate_uuid_v7()), &connection, Some(&connection), "Channel"),
    ];
    let ds: std::collections::HashSet<String> = [connection.clone()].into_iter().collect();
    let mut not_added = Vec::new();
    let applied = crate::calp_commands::materialize_pulled_ribbon_filters(
        &pane,
        &ribbon,
        &effect(),
        &HashMap::new(),
        &pulled,
        &ds,
        "report-b",
        &mut not_added,
    )
    .expect("the filters materialize");
    let names: Vec<&str> = applied.iter().map(|(_, n)| n.as_str()).collect();
    assert_eq!(names, vec!["Channel"], "only the filter whose id and name are free is added");
    assert_eq!(not_added.len(), 2, "{not_added:?}");
    assert!(
        not_added.iter().any(|l| l.contains("'Region'") && l.contains("'report-b'") && l.contains(&taken_id.to_string())),
        "the id collision is named: {not_added:?}"
    );
    assert!(not_added.iter().any(|l| l.contains("'Mine'") && l.contains("name")), "the name collision is named: {not_added:?}");
    assert_eq!(ribbon.filters.read().unwrap()[&taken_id].name, "Mine", "the workbook's own filter is never clobbered");
}

/// THE WIRING the tests above cannot see: the Subscribe door asks the region
/// gate BEFORE its one effect (a refused subscribe leaves a clean workbook
/// clean), and every publish door re-keys objects through the one carrier, after
/// the data-source re-key and before anything is handed to core publish.
#[test]
fn the_subscribe_door_and_the_carrier_call_the_region_and_object_rules() {
    let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"))
        .expect("cannot read calp_commands.rs");
    let code_of = |signature: &str| -> String {
        let start = src.find(signature).unwrap_or_else(|| panic!("calp_commands.rs no longer has `{signature}`"));
        let rest = &src[start + signature.len()..];
        let end = ["\npub fn ", "\npub(crate) fn ", "\nfn ", "\n#[tauri::command]"]
            .iter()
            .filter_map(|next| rest.find(next))
            .min()
            .unwrap_or(rest.len());
        rest[..end]
            .lines()
            .map(|l| match l.find("//") {
                Some(i) => &l[..i],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let pull = code_of("pub fn calp_pull(");
    let gate = pull.find("refuse_region_already_declared(").expect("calp_pull no longer asks the region gate");
    let effect = pull.find("DocumentEffect::mutates(").expect("calp_pull's effect");
    assert!(gate < effect, "the region gate runs after the subscribe's effect");
    assert!(pull.contains("subscribed_region_claims("), "the gate is no longer fed the subscriptions' claims");

    let carrier = code_of("fn assemble_publish_snapshot(");
    let data = carrier.find("rekey_carried_data_sources(").expect("the data-source re-key");
    let objects = carrier.find("rekey_carried_objects(").expect("the carrier no longer re-keys objects");
    assert!(carrier.contains("object_rekeys_for_target("), "the carrier no longer asks which objects re-key");
    assert!(data < objects, "objects are re-keyed after the data sources");
}

/// The derived ids: deterministic, distinct per application, per family and
/// per source, never the source's own, and UUID-shaped (each family reads its
/// id back as an `EntityId`).
#[test]
fn an_applications_own_object_ids_are_derived_deterministically() {
    let source = "01a15d70-0000-7000-8000-0000000000d9";
    let b = object_key_for_application("chart", APP_B, source);
    assert_eq!(b, object_key_for_application("chart", APP_B, source));
    assert_ne!(b, source);
    assert_ne!(b, object_key_for_application("chart", "report-c", source));
    assert_ne!(b, object_key_for_application("ribbonFilter", APP_B, source));
    assert_ne!(b, object_key_for_application("chart", APP_B, "01a15d70-0000-7000-8000-0000000000da"));
    assert!(identity::EntityId::parse(&b).is_some(), "UUID-shaped: {b}");
    assert_ne!(
        b,
        crate::calp_commands::data_source_key_for_application(APP_B, source),
        "never a data-source id"
    );
}

// ---------------------------------------------------------------------------
// rk3: model writeback columns, same-named claimants, the model-table feed,
// the publish under the lock, the ledger backfill
// ---------------------------------------------------------------------------

const COLUMN_W: &str = "01a15d70-0000-7000-8000-0000000000f1";

fn model_column(id: &str, data_source: &str) -> calp::writeback::ModelWritebackDeclaration {
    calp::writeback::ModelWritebackDeclaration {
        id: id.to_string(),
        data_source_id: data_source.to_string(),
        table: "Sales".to_string(),
        column: "Forecast".to_string(),
        key_columns: vec!["Id".to_string()],
        kind: "history".to_string(),
        schema: None,
        allowed_editors: Vec::new(),
        submission_policy: None,
        extra: HashMap::new(),
    }
}

/// [`publish_raw`] with model writeback columns declared.
fn publish_raw_with_columns(
    dir: &TempDir,
    prof: &Path,
    wb: &Workbook,
    package: &str,
    columns: Vec<calp::writeback::ModelWritebackDeclaration>,
) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: wb,
        package_name: package.to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: "first".to_string(),
        sheet_indices: (0..wb.sheets.len()).collect(),
        now: NOW.to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: Some(columns),
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        identity_policy: None,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof).expect("publish failed");
}

/// A signed model writeback entry for `column`, written straight into
/// `package`'s workspace.
fn send_model_entry(dir: &TempDir, package: &str, column: &str, who: &str, value: f64) {
    let mut entry = WritebackSubmission {
        id: format!("m-{}-{column}", who.to_lowercase()),
        region_id: column.to_string(),
        cell_row: 0,
        cell_col: 0,
        cell_id: None,
        submitter: signed_identity(who),
        value: SubmissionValue::Number { value },
        state: SubmissionState::Submitted,
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
        submitted_at: Some(NOW.to_string()),
        review_reason: None,
        reviewed_by: None,
        environment: String::new(),
        model_key: Some(vec!["1".to_string()]),
        seal: None,
        sender: Default::default(),
        identity: Default::default(),
        extra: HashMap::new(),
    };
    calp::submission_seal::seal_submission(&mut entry, package, "1.0.0", &seed_of(who), SubmissionOrigin::Interactive)
        .expect("the sender signs");
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    calp::WorkspaceTransport::save_submission(&reg, package, "1.0.0", &entry).expect("save model entry");
}

fn ledger_ids(s: &Harness, kind: &str) -> Vec<(String, Vec<String>)> {
    s.state
        .subscriptions
        .read()
        .unwrap()
        .subscriptions
        .iter()
        .map(|sub| (sub.package_name.clone(), sub.objects.iter().filter(|o| o.kind == kind).map(|o| o.id.clone()).collect()))
        .collect()
}

/// A FORK FILES ITS MODEL WRITEBACK COLUMNS UNDER IDS OF ITS OWN (rekey2
/// verifier, major 1). A re-keyed data source used to keep its columns' ids,
/// and a column's id is the `region_id` its entries are routed and filed by.
/// Now the declaration, the embedded model (the column and its `__wb_` store
/// tables, as a measure names them) and the publisher's baseline all follow,
/// deterministically; a data source that keeps its id keeps its columns'.
///
/// SABOTAGE (rk3-model-rekey): skip the column re-key in
/// `rekey_carried_data_sources` (`if false`) -- "THE FORK'S COLUMN HAS AN ID OF
/// ITS OWN" fails.
#[test]
fn a_fork_files_its_model_writeback_columns_under_ids_of_its_own() {
    let source_ds = "01a15d70-0000-7000-8000-0000000000aa".to_string();
    let compact = COLUMN_W.replace('-', "");
    let data_source = || calp::publish::PublishDataSource {
        id: source_ds.clone(),
        name: "Sales model".to_string(),
        connection_type: "postgres".to_string(),
        server: String::new(),
        database: String::new(),
        model_json: serde_json::json!({
            "writeback_columns": [{ "id": COLUMN_W, "name": "Forecast", "table": "Sales" }],
            "tables": [{ "name": format!("__wb_{compact}_hist") }, { "name": "Sales" }],
            "measures": [{ "name": "Sent", "expression": format!("COUNTROWS('__wb_{compact}_hist')") }]
        }),
        bindings: Vec::new(),
        calculated_table_snapshots: Vec::new(),
        writeback_history_json: Some(serde_json::json!({ COLUMN_W: [{ "key": ["1"] }] })),
    };
    let own_ds = crate::calp_commands::data_source_key_for_application(APP_B, &source_ds);
    let rekeys: HashMap<String, String> = [(source_ds.clone(), own_ds.clone())].into_iter().collect();
    let mut sources = vec![data_source()];
    let mut columns = vec![model_column(COLUMN_W, &source_ds)];
    crate::calp_commands::rekey_carried_data_sources(&mut Workbook::default(), &mut sources, &mut columns, &rekeys);

    let own_column = crate::calp_commands::model_writeback_id_for_data_source(&own_ds, COLUMN_W);
    assert_eq!(columns[0].id, own_column, "THE FORK'S COLUMN HAS AN ID OF ITS OWN");
    assert_ne!(own_column, COLUMN_W);
    assert_eq!(columns[0].data_source_id, own_ds, "...in the fork's own data source");
    assert!(
        own_column.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "the engine's writeback id charset: {own_column}"
    );
    let model = sources[0].model_json.to_string();
    assert!(!model.contains(COLUMN_W) && !model.contains(&compact), "the embedded model names the source's column: {model}");
    assert!(model.contains(&own_column), "the model's column carries the new id: {model}");
    assert!(model.contains(&format!("__wb_{}_hist", own_column.replace('-', ""))), "the store table a measure names follows: {model}");
    let history = sources[0].writeback_history_json.as_ref().unwrap();
    assert!(history.get(&own_column).is_some() && history.get(COLUMN_W).is_none(), "the baseline follows: {history}");
    assert_eq!(
        own_column,
        crate::calp_commands::model_writeback_id_for_data_source(&own_ds, COLUMN_W),
        "deterministic: the fork's next push keeps it"
    );

    // A data source that keeps its id keeps its columns' ids.
    let mut kept = vec![data_source()];
    let mut kept_columns = vec![model_column(COLUMN_W, &source_ds)];
    crate::calp_commands::rekey_carried_data_sources(&mut Workbook::default(), &mut kept, &mut kept_columns, &HashMap::new());
    assert_eq!(kept_columns[0].id, COLUMN_W);
    assert!(kept[0].model_json.to_string().contains(COLUMN_W));
}

/// A MODEL WRITEBACK COLUMN TWO APPLICATIONS DECLARE HAS NO OWNER AND FEEDS
/// NEITHER MODEL (rekey2 verifier, major 1). The subscribe refuses it; held
/// anyway (an earlier build's), the submit route refuses rather than sending
/// the entry to whichever subscription declared it first, and the model feed
/// reads neither -- also while one claimant's workspace is unreachable, from
/// the ledger rows each subscribe records.
///
/// SABOTAGES (separate builds): (rk3-model-owner) make
/// `owning_subscription_for_model_writeback`'s claimant check `> 1 && false`
/// -- "NO OWNER OF A SHARED COLUMN" fails. (rk3-model-feed) make the shared-id
/// drop in `collect_distributed_writeback_entries` `indices.len() > 1 && false`
/// -- "THE MODEL READS NEITHER" fails.
#[test]
fn a_model_writeback_column_two_applications_declare_has_no_owner_and_feeds_neither_model() {
    let dir_a = TempDir::new().unwrap();
    let dir_c = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let wb = form_workbook(REGION_A, identity::EntityId::from_bytes(identity::generate_uuid_v7()));
        publish_raw_with_columns(&dir_a, prof.path(), &wb, APP_A, vec![model_column(COLUMN_W, "ds-a")]);
        publish_raw_with_columns(&dir_c, prof.path(), &wb, "copycat", vec![model_column(COLUMN_W, "ds-c")]);

        let s = Harness::new();
        s.materialize(subscribe_pull(&dir_a, prof.path(), APP_A), MaterializeMode::Subscribe);
        send_model_entry(&dir_a, APP_A, COLUMN_W, "Alice", 10.0);
        let owner = crate::calp_commands::owning_subscription_for_model_writeback(&s.state, COLUMN_W)
            .expect("the premise: A alone owns its column");
        assert_eq!(owner.0, APP_A);
        let fed = crate::bi::writeback::collect_distributed_writeback_entries(&s.state);
        assert_eq!(fed.get(COLUMN_W).map(|e| e.len()), Some(1), "the premise: A's model reads A's entry");

        // The subscribe refuses the copy.
        let copycat = subscribe_pull(&dir_c, prof.path(), "copycat");
        assert_eq!(copycat.model_writebacks.len(), 1, "fixture: the pull carries the declaration");
        let subscriptions = s.state.subscriptions.read().unwrap().subscriptions.clone();
        let refused = crate::calp_commands::refuse_model_writeback_already_declared(
            &copycat.model_writebacks,
            &copycat.package_name,
            &crate::calp_commands::subscribed_writeback_claims(&subscriptions, crate::calp_commands::WritebackIdKind::ModelColumn),
        )
        .expect_err("THE SUBSCRIBE REFUSES a model column A declares");
        assert!(refused.starts_with("CALP_WRITEBACK_COLUMN_SHARED:") && refused.contains("'report-a'"), "{refused}");

        // Held anyway: recorded, and nothing is guessed.
        s.materialize(copycat, MaterializeMode::Subscribe);
        assert_eq!(
            ledger_ids(&s, "modelWriteback"),
            vec![(APP_A.to_string(), vec![COLUMN_W.to_string()]), ("copycat".to_string(), vec![COLUMN_W.to_string()])],
            "each subscribe records the model column ids its verified version declares"
        );
        let shared = crate::calp_commands::owning_subscription_for_model_writeback(&s.state, COLUMN_W)
            .map(|o| o.0)
            .expect_err("NO OWNER OF A SHARED COLUMN");
        assert!(shared.starts_with("CALP_WRITEBACK_COLUMN_SHARED:") && shared.contains("'copycat'"), "{shared}");
        let fed = crate::bi::writeback::collect_distributed_writeback_entries(&s.state);
        assert!(fed.get(COLUMN_W).is_none(), "THE MODEL READS NEITHER application's entries: {:?}", fed.keys());

        // ...also while the copy's workspace cannot be reached.
        drop(dir_c);
        assert!(crate::calp_commands::owning_subscription_for_model_writeback(&s.state, COLUMN_W).is_err(), "the outage makes no owner");
        assert!(crate::bi::writeback::collect_distributed_writeback_entries(&s.state).get(COLUMN_W).is_none());
    });
}

/// TWO APPLICATIONS OF ONE NAME ARE TWO CLAIMANTS (rekey2 verifier, major 2).
/// `calp_pull` allows the same name from another workspace, and the claimants
/// were counted by NAME: a refresh bringing one of them the other's region id
/// passed the refresh gate, and the owner lookup saw one claimant and answered.
///
/// SABOTAGES: (rk3-name-refresh) excuse every claimant of the payload's NAME in
/// `refuse_refreshed_regions_already_declared` (`set.retain(|i|
/// subscriptions[*i].package_name != payload.pull_result.package_name)`) --
/// "THE REFRESH REFUSES THE SAME-NAMED COPY" fails. (rk3-name-owner) count the
/// owner lookup's claimants by name again -- "TWO SAME-NAMED CLAIMANTS" fails.
#[test]
fn two_applications_of_one_name_from_two_workspaces_are_two_claimants() {
    let dir_1 = TempDir::new().unwrap();
    let dir_2 = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let wb = form_workbook(REGION_A, identity::EntityId::from_bytes(identity::generate_uuid_v7()));
        let form = wb.sheets[0].id;
        publish_raw(&dir_1, prof.path(), &wb, APP_A, vec![region_on(form, REGION_A)]);
        publish_raw(&dir_2, prof.path(), &wb, APP_A, vec![region_on(form, "01a15d70-0000-7000-8000-0000000000b2")]);
        let s = Harness::new();
        s.materialize(subscribe_pull(&dir_1, prof.path(), APP_A), MaterializeMode::Subscribe);
        s.materialize(subscribe_pull(&dir_2, prof.path(), APP_A), MaterializeMode::Subscribe);

        // The second workspace's "next version" declares the first's region id.
        let payload = calp::refresh::RefreshPayload { subscription_index: 1, pull_result: subscribe_pull(&dir_1, prof.path(), APP_A) };
        let refused = crate::calp_commands::refuse_refreshed_regions_already_declared(&s.state, &[payload])
            .expect_err("THE REFRESH REFUSES THE SAME-NAMED COPY a region id the other declares");
        assert!(refused.starts_with("CALP_REGION_SHARED:") && refused.contains(REGION_A), "{refused}");
        assert!(refused.contains(&location(&dir_1)), "names the other by its workspace: {refused}");
        // Positive control: the first refreshing onto its own id.
        let own = calp::refresh::RefreshPayload { subscription_index: 0, pull_result: subscribe_pull(&dir_1, prof.path(), APP_A) };
        crate::calp_commands::refuse_refreshed_regions_already_declared(&s.state, &[own])
            .expect("a refresh of the subscription that owns the id is not refused");
        assert_eq!(send(&s, &dir_1, REGION_A, "Alice", 1.0), APP_A, "the premise: one claimant, one owner");

        // Held anyway (an earlier build's refresh recorded it), and the second
        // workspace goes away.
        s.state.subscriptions.write(&effect()).unwrap().subscriptions[1]
            .objects
            .extend(crate::calp_commands::region_ledger_entries(&[region_on(form, REGION_A)]));
        drop(dir_2);
        let refused = owning_subscription_for_region(&s.state, REGION_A)
            .map(|o| o.registry_path)
            .expect_err("TWO SAME-NAMED CLAIMANTS: no owner, outage or not");
        assert!(refused.starts_with("CALP_REGION_SHARED:"), "{refused}");
    });
}

/// THE MODEL-TABLE FEED COUNTS THE SAME CLAIMANTS (rekey2 verifier, major 3):
/// a writeback model table bound to a region id two applications declare
/// carries no rows and says why -- also while one claimant's workspace is
/// unreachable -- where it used to total the first subscription's answers
/// while GATHER of the same id was #REF!.
///
/// SABOTAGE (rk3-feed): make the shared-region pass in
/// `collect_writeback_datasets` skip every dataset (`.skip(usize::MAX)`) --
/// "THE MODEL TABLE READS NEITHER" fails.
#[test]
fn a_writeback_model_table_of_a_shared_region_reads_neither_application() {
    let dir_a = TempDir::new().unwrap();
    let dir_c = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let wb = form_workbook(REGION_A, identity::EntityId::from_bytes(identity::generate_uuid_v7()));
        let form = wb.sheets[0].id;
        publish_raw(&dir_a, prof.path(), &wb, APP_A, vec![region_on(form, REGION_A)]);
        publish_raw(&dir_c, prof.path(), &wb, "copycat", vec![region_on(form, REGION_A)]);
        let s = Harness::new();
        s.materialize(subscribe_pull(&dir_a, prof.path(), APP_A), MaterializeMode::Subscribe);
        send_direct(&dir_a, prof.path(), REGION_A, "Alice", 10.0);
        let rows_of = |s: &Harness| -> Vec<(usize, String)> {
            crate::bi::writeback_source::collect_writeback_datasets(&s.state)
                .into_iter()
                .filter(|d| d.region.id == REGION_A)
                .map(|d| (d.rows.len(), d.note))
                .collect()
        };
        assert_eq!(rows_of(&s), vec![(1, String::new())], "the premise: A's model table reads A's answer");

        s.materialize(subscribe_pull(&dir_c, prof.path(), "copycat"), MaterializeMode::Subscribe);
        drop(dir_c);
        let shared = rows_of(&s);
        assert_eq!(shared.len(), 1, "one dataset keeps the bound table resolving: {shared:?}");
        assert_eq!(shared[0].0, 0, "THE MODEL TABLE READS NEITHER application's answers: {shared:?}");
        assert!(shared[0].1.starts_with("CALP_REGION_SHARED:") && shared[0].1.contains("'copycat'"), "and says why: {shared:?}");
    });
}

/// A SUBSCRIPTION MADE BY AN EARLIER BUILD GETS ITS LEDGER ROWS AT OPEN
/// (rekey2 remains): its writeback region and model column ids, from its
/// pinned manifest, without dirtying the document -- so an outage after the
/// open still counts it.
///
/// SABOTAGE (rk3-backfill): make `backfill_writeback_id_ledgers` return at its
/// top -- "THE OPEN RECORDS THE IDS" fails.
#[test]
fn an_earlier_builds_subscription_gets_its_writeback_ledger_rows_at_open() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let wb = form_workbook(REGION_A, identity::EntityId::from_bytes(identity::generate_uuid_v7()));
        let form = wb.sheets[0].id;
        publish_raw(&dir, prof.path(), &wb, APP_A, vec![region_on(form, REGION_A)]);
        let s = Harness::new();
        s.materialize(subscribe_pull(&dir, prof.path(), APP_A), MaterializeMode::Subscribe);
        // An earlier build recorded none.
        s.state.subscriptions.write(&effect()).unwrap().subscriptions[0]
            .objects
            .retain(|o| o.kind != "writebackRegion" && o.kind != "modelWriteback");
        assert_eq!(ledger_ids(&s, "writebackRegion"), vec![(APP_A.to_string(), Vec::new())], "fixture: no rows");
        crate::calp_commands::backfill_writeback_id_ledgers(&s.state, prof.path());
        assert_eq!(
            ledger_ids(&s, "writebackRegion"),
            vec![(APP_A.to_string(), vec![REGION_A.to_string()])],
            "THE OPEN RECORDS THE IDS its pinned manifest declares"
        );
        crate::calp_commands::backfill_writeback_id_ledgers(&s.state, prof.path());
        assert_eq!(ledger_ids(&s, "writebackRegion")[0].1.len(), 1, "never twice");
    });
}

/// THE WIRING: the subscribe and the refresh record model column ids and ask
/// the model gate; the open backfills; the preview asks the workspace.
#[test]
fn the_model_column_rules_are_wired_into_every_door() {
    let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"))
        .expect("cannot read calp_commands.rs");
    let code: String = src.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n");
    assert!(code.contains("subscription.objects.extend(model_writeback_ledger_entries(&result.model_writebacks));"), "the subscribe records model column ids");
    assert!(code.contains("entries.extend(model_writeback_ledger_entries(&payload.pull_result.model_writebacks));"), "the refresh records model column ids");
    let pull_start = code.find("pub fn calp_pull(").expect("calp_pull");
    let pull = &code[pull_start..];
    let gate = pull.find("refuse_model_writeback_already_declared(").expect("calp_pull asks the model gate");
    assert!(gate < pull.find("DocumentEffect::mutates(").expect("calp_pull's effect"), "before the effect");
    let preview_start = code.find("pub fn calp_publish_preview(").expect("the preview");
    let preview = &code[preview_start..preview_start + code[preview_start..].find("\nfn ").unwrap_or(code.len() - preview_start)];
    assert!(preview.contains("region_taken_preview_warning("), "the preview asks what the publish asks");
    let restore_start = code.find("pub(crate) fn restore_application_bi_connections_in(").expect("the restore");
    let restore = &code[restore_start..];
    let backfill = restore.find("backfill_writeback_id_ledgers(state, profile_dir);").expect("the open backfills");
    let walk = restore.find("let subscriptions = match state.subscriptions.read()").expect("the restore's walk");
    assert!(backfill < walk, "the backfill runs before the restore reads the ledger");
}

/// WHAT YOU SENT IS NEVER READ BACK FROM ANOTHER APPLICATION (rk3 sweep): the
/// reconcile's "what did I send to each region" read let the FIRST
/// subscription declaring a region answer, so a shared region's cells were
/// filled with what was sent to the other application. A region two
/// subscriptions claim is now answered with the refusal -- also while one
/// claimant's workspace is unreachable.
///
/// SABOTAGE (rk3-sent): make the shared-region pass in
/// `own_sent_records_by_region` `indices.len() > 1 && false` -- "WHAT WAS SENT
/// TO A SHARED REGION IS READ FROM NEITHER" fails.
#[test]
fn what_was_sent_to_a_shared_region_is_read_from_neither_application() {
    let dir_a = TempDir::new().unwrap();
    let dir_c = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let wb = form_workbook(REGION_A, identity::EntityId::from_bytes(identity::generate_uuid_v7()));
        let form = wb.sheets[0].id;
        publish_raw(&dir_a, prof.path(), &wb, APP_A, vec![region_on(form, REGION_A)]);
        publish_raw(&dir_c, prof.path(), &wb, "copycat", vec![region_on(form, REGION_A)]);
        let s = Harness::new();
        *s.state.subscriber_identity.lock().unwrap() = Some(signed_identity("Alice"));
        s.materialize(subscribe_pull(&dir_a, prof.path(), APP_A), MaterializeMode::Subscribe);
        send_direct(&dir_a, prof.path(), REGION_A, "Alice", 10.0);
        let sent = crate::calp_commands::own_sent_records_by_region(&s.state).expect("the read runs");
        let cells = sent.get(REGION_A).and_then(|r| r.as_ref().ok()).map(|r| r.by_cell.len());
        assert_eq!(cells, Some(1), "the premise: what Alice sent to A is read back");

        s.materialize(subscribe_pull(&dir_c, prof.path(), "copycat"), MaterializeMode::Subscribe);
        drop(dir_c);
        let sent = crate::calp_commands::own_sent_records_by_region(&s.state).expect("the read runs");
        let refused = match sent.get(REGION_A) {
            Some(Err(e)) => e.clone(),
            Some(Ok(r)) => panic!("WHAT WAS SENT TO A SHARED REGION IS READ FROM NEITHER: {} cell(s)", r.by_cell.len()),
            None => panic!("the shared region is answered, as a refusal"),
        };
        assert!(refused.starts_with("CALP_REGION_SHARED:") && refused.contains("'copycat'"), "{refused}");
    });
}
