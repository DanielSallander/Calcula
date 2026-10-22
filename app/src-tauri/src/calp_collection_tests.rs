//! FILENAME: app/src-tauri/src/calp_collection_tests.rs
//! PURPOSE: Collected Responses works for the AUTHOR of a designated writeback
//!          region -- in the workbook that published it and in a working copy --
//!          through the one publisher-side resolver
//!          (`calp_collection::collection_for_region`), and a SUBSCRIBED region
//!          resolves exactly as it did before.
//! CONTEXT: BUG-0553 (owner, 2026-10-21): "I have a writeback designated range.
//!          Then I click Collected Responses (I have submitted some in another
//!          workbook) and it says: No writeback regions in this workbook." Every
//!          publisher-side command found a region only through the workbook's
//!          SUBSCRIPTIONS, and an author's own regions are never subscriptions.
//!
//!          Every fixture here is a REAL signed publish to a temp workspace with
//!          the test's own profile key, and submissions written into the
//!          version the way a subscriber's submit writes them. The author's
//!          workbook carries the designation and a `WorkingCopyLink` and NO
//!          subscription -- the shape of the owner's workbook.

use std::collections::HashMap;
use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::version::{SemVer, VersionPin};
use calp::writeback::{SubmissionState, SubmissionValue, WritebackSubmission};
use persistence::{Sheet, Workbook};

use calp::writeback::StreamFilter;
use calp::CollectStreams;

use crate::calp_collection::{
    collection_for_region, collection_streams_view, list_collection_regions, set_collection_streams,
    CollectMode, CollectionRole, CollectionStatus, StreamChoiceKind, EMPTY_CHOICE_TEXT, NOT_PUBLISHED_TEXT,
};
use crate::calp_commands::{
    export_region_submissions_csv_core, load_region_submissions_core, region_response_status_core,
    require_region_publisher, set_submission_state_core, writeback_region_entries,
};
use crate::document_effect::test_seed_effect;
use crate::profile_dir::with_test_profile;
use crate::AppState;

const APP: &str = "collect-test";
/// The owner's region shape: B3:B5 on the application's one sheet.
const REGION: &str = "01a15d70-0000-7000-8000-0000000000a1";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
        "submissionPolicy": "on_submit",
        "expectedRespondents": ["Alice", "Carol"]
    }))
    .expect("a valid declaration")
}

fn form_workbook() -> (Workbook, identity::SheetId) {
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Form".to_string())];
    let form = wb.sheets[0].id;
    (wb, form)
}

fn location(dir: &TempDir) -> String {
    dir.path().to_str().unwrap().to_string()
}

/// Publish sheet 0 of `wb` as `version`, signed with `prof`'s key.
fn publish_version(
    dir: &TempDir,
    prof: &Path,
    wb: &Workbook,
    version: SemVer,
    mode: PushMode,
    regions: Vec<calp::WritebackRegionDeclaration>,
) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: wb,
        package_name: APP.to_string(),
        version,
        kind: "report".to_string(),
        mode,
        change_summary: "test".to_string(),
        sheet_indices: vec![0],
        now: "2026-10-21T00:00:00Z".to_string(),
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

/// A subscriber's submission event, written where a submit writes it.
#[allow(clippy::too_many_arguments)]
fn submit(
    dir: &TempDir,
    version: &str,
    id: &str,
    who: &str,
    row: u32,
    value: f64,
    environment: &str,
    at: &str,
) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let s = WritebackSubmission {
        id: id.to_string(),
        region_id: REGION.to_string(),
        cell_row: row,
        cell_col: 1,
        cell_id: None,
        submitter: calp::SubmitterIdentity {
            display_name: who.to_string(),
            id: format!("id-{}", who.to_lowercase()),
            principal_name: String::new(),
            provider: Default::default(),
            scope: Default::default(),
            extra: HashMap::new(),
        },
        value: SubmissionValue::Number { value },
        state: SubmissionState::Submitted,
        created_at: at.to_string(),
        updated_at: at.to_string(),
        submitted_at: Some(at.to_string()),
        review_reason: None,
        reviewed_by: None,
        environment: environment.to_string(),
        model_key: None,
        seal: None,
        sender: Default::default(),
        identity: Default::default(),
        extra: HashMap::new(),
    };
    calp::WorkspaceTransport::save_submission(&reg, APP, version, &s).expect("save submission");
}

/// The AUTHOR's workbook: sheet 0 IS the application's sheet (checkout keeps
/// the application's sheet ids, and the publishing workbook has them by
/// construction), the region is a designation, the link names the
/// application -- and there is NO subscription.
fn author_workbook(
    form: identity::SheetId,
    designations: Vec<calp::WritebackRegionDeclaration>,
    link: Option<calp::WorkingCopyLink>,
) -> AppState {
    let state = crate::create_app_state();
    state.sheet_ids.write(&test_seed_effect()).unwrap()[0] = form;
    state.sheet_names.write(&test_seed_effect()).unwrap()[0] = "Form".to_string();
    *state.writeback_draft_regions.write(&test_seed_effect()).unwrap() = designations;
    *state.working_copy_link.write(&test_seed_effect()).unwrap() = link;
    assert!(state.subscriptions.read().unwrap().subscriptions.is_empty());
    state
}

fn link_to(dir: &TempDir, base_version: &str) -> calp::WorkingCopyLink {
    calp::WorkingCopyLink::new(&location(dir), APP, "report", base_version, "2026-10-21T00:00:00Z", Vec::new())
}

/// One published application with two answers on the development line.
fn published_with_answers() -> (TempDir, TempDir, identity::SheetId) {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let (wb, form) = form_workbook();
    publish_version(&dir, prof.path(), &wb, SemVer::new(1, 0, 0), PushMode::CreateNew, vec![region_on(form, REGION)]);
    submit(&dir, "1.0.0", "s-alice-1", "Alice", 2, 1.0, "", "2026-10-21T09:00:00Z");
    submit(&dir, "1.0.0", "s-bob-1", "Bob", 3, 2.0, "", "2026-10-21T09:05:00Z");
    (dir, prof, form)
}

// ---------------------------------------------------------------------------
// The reported defect
// ---------------------------------------------------------------------------

/// THE OWNER'S CASE. The workbook that published `B3:B5` (or a working copy of
/// it) lists the region in Collected Responses, and every dashboard command --
/// the inbox, the CSV export, the roster, approve -- reads the answers
/// subscribers sent.
///
/// SABOTAGE (proved 2026-10-21): make the resolver (then `collection_for_region`,
/// now `resolve_collection`) skip its author arm (the `own_designation` match
/// never taken, straight to `owning_subscription_for_region`). Six of the seven tests in this file fail
/// -- this one at `collection_for_region` with "No subscription declares
/// writeback region ...", the owner's symptom -- and only the subscriber-route
/// test passes.
#[test]
fn the_authors_own_region_is_collected_from_the_application_it_published() {
    let (dir, prof, form) = published_with_answers();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        // What the pane used to list from: the SUBSCRIBER index. Empty here,
        // which is exactly the "No writeback regions in this workbook." the
        // owner read.
        assert!(writeback_region_entries(&state).unwrap().is_empty());

        let listed = list_collection_regions(&state).unwrap();
        assert_eq!(listed.len(), 1, "{listed:?}");
        let row = &listed[0];
        assert_eq!(row.region_id, REGION);
        assert_eq!(row.role, CollectionRole::Author);
        assert_eq!(row.status, CollectionStatus::Ready, "{}", row.detail);
        assert_eq!(row.version.as_deref(), Some("1.0.0"));
        assert_eq!(row.sheet_index, Some(0));
        assert_eq!(row.sheet_name.as_deref(), Some("Form"));
        assert_eq!((row.row_start, row.row_end, row.col_start, row.col_end), (2, 4, 1, 1));
        assert_eq!(row.package_name.as_deref(), Some(APP));
        assert_eq!(
            row.collecting, None,
            "an application with no environments: every stream (only the development line) is collected"
        );

        let c = collection_for_region(&state, REGION).unwrap();
        assert_eq!(c.role, CollectionRole::Author);
        assert_eq!(c.read_version, "1.0.0");
        require_region_publisher(&state, REGION).expect("this computer published it");

        let inbox = load_region_submissions_core(&state, REGION).expect("the author's inbox");
        let mut got: Vec<(String, u32, String, String)> = inbox
            .iter()
            .map(|r| (r.submitter_name.clone(), r.cell_row, r.value_display.clone(), r.state.clone()))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("Alice".to_string(), 2, "1".to_string(), "submitted".to_string()),
                ("Bob".to_string(), 3, "2".to_string(), "submitted".to_string()),
            ]
        );

        let csv = export_region_submissions_csv_core(&state, REGION).expect("the CSV export");
        assert!(csv.contains("Alice") && csv.contains("Bob"), "{csv}");
        assert!(csv.contains("(development line)"), "each row names its stream: {csv}");

        let status = region_response_status_core(&state, REGION).expect("the roster");
        assert_eq!(status.expected, vec!["Alice".to_string(), "Carol".to_string()]);
        assert_eq!(status.responded, vec!["Alice".to_string(), "Bob".to_string()]);
        // These fixtures were SENT BEFORE SIGN-IN (unsigned, an old-format id):
        // shown and labelled, but a name match needs a signed answer (identity
        // phase 1), so "Alice" is still expected.
        assert_eq!(status.missing, vec!["Alice".to_string(), "Carol".to_string()]);
        assert_eq!(status.before_sign_in, vec!["Alice".to_string(), "Bob".to_string()]);
        assert!(inbox_says_before_sign_in(&state));

        // APPROVE, with the ROW's own stream (what the pane now passes).
        let alice = inbox.iter().find(|r| r.submitter_name == "Alice").unwrap();
        set_submission_state_core(
            &state,
            REGION.to_string(),
            alice.submitter_id.clone(),
            alice.cell_row,
            alice.cell_col,
            "approved".to_string(),
            None,
            Some(alice.submission_id.clone()),
            Some(alice.environment.clone()),
        )
        .expect("the author approves");
        let after = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(after.iter().find(|r| r.submitter_name == "Alice").unwrap().state, "approved");
        assert_eq!(after.iter().find(|r| r.submitter_name == "Bob").unwrap().state, "submitted");
    });
}

/// Every row of the region's inbox reads "sent before sign-in" (unsigned).
fn inbox_says_before_sign_in(state: &AppState) -> bool {
    load_region_submissions_core(state, REGION)
        .unwrap()
        .iter()
        .all(|r| r.sender == calp::SenderCheck::BeforeSignIn && r.submitter_principal.is_empty() && r.origin.is_none())
}

/// Store a Collect From choice on the author's link (what the setter writes).
fn choose(state: &AppState, choice: Option<CollectStreams>) {
    state.working_copy_link.write(&test_seed_effect()).unwrap().as_mut().unwrap().collect_streams = choice;
}

fn only(streams: &[&str]) -> Option<CollectStreams> {
    Some(CollectStreams::Only(streams.iter().map(|s| s.to_string()).collect()))
}

/// With NO environments the author's default is every stream, one row per
/// (stream, person, cell): the same person answering the same cell in `test`
/// and on the development line is two rows, never one silently hiding the
/// other. A choice of one stream shows just that stream.
#[test]
fn without_environments_every_stream_is_collected_and_one_stream_can_be_chosen() {
    let (dir, prof, form) = published_with_answers();
    submit(&dir, "1.0.0", "s-alice-test", "Alice", 2, 7.0, "test", "2026-10-21T10:00:00Z");
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let every = load_region_submissions_core(&state, REGION).unwrap();
        let mut alice: Vec<(String, String)> = every
            .iter()
            .filter(|r| r.submitter_name == "Alice")
            .map(|r| (r.environment.clone(), r.value_display.clone()))
            .collect();
        alice.sort();
        assert_eq!(alice, vec![("".to_string(), "1".to_string()), ("test".to_string(), "7".to_string())]);
        assert_eq!(every.len(), 3);

        choose(&state, only(&["test"]));
        let test_only = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(test_only.len(), 1);
        assert_eq!(test_only[0].value_display, "7");

        choose(&state, only(&[""]));
        let line = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(line.len(), 2);
        assert!(line.iter().all(|r| r.environment.is_empty()));
    });
}

/// A co-publisher's later push moves subscribers to a newer version; the author
/// reads from the HEAD that declares the region (not the link's base) and
/// carries the older version's answers forward.
#[test]
fn the_newest_version_declaring_the_region_is_read_and_older_answers_carry_forward() {
    let (dir, prof, form) = published_with_answers();
    let (wb, _) = {
        let mut wb = Workbook::default();
        let mut sheet = Sheet::new("Form".to_string());
        sheet.id = form;
        wb.sheets = vec![sheet];
        (wb, form)
    };
    publish_version(
        &dir,
        prof.path(),
        &wb,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        vec![region_on(form, REGION)],
    );
    submit(&dir, "1.1.0", "s-carol-1", "Carol", 4, 3.0, "", "2026-10-21T11:00:00Z");
    // The working copy is still based on 1.0.0.
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        assert_eq!(collection_for_region(&state, REGION).unwrap().read_version, "1.1.0");
        let names: Vec<String> = load_region_submissions_core(&state, REGION)
            .unwrap()
            .into_iter()
            .map(|r| r.submitter_name)
            .collect();
        assert_eq!(names, vec!["Alice".to_string(), "Bob".to_string(), "Carol".to_string()]);
    });
}

// ---------------------------------------------------------------------------
// The states that are not "ready", each with a sentence that says what to do
// ---------------------------------------------------------------------------

/// A region designated AFTER the last push is in no signed version yet: the
/// refusal says to push, and names the version it looked at.
#[test]
fn a_region_designated_after_the_last_push_says_push_first() {
    let (dir, prof, form) = published_with_answers();
    let later = "01a15d70-0000-7000-8000-0000000000b2";
    let mut added = region_on(form, later);
    added.selector.col_start = 3;
    added.selector.col_end = 3;
    let state = author_workbook(form, vec![region_on(form, REGION), added], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let err = load_region_submissions_core(&state, later).expect_err("not pushed yet");
        assert!(err.contains("D3:D5 was designated after the last push"), "{err}");
        assert!(err.contains("v1.0.0"), "{err}");
        let listed = list_collection_regions(&state).unwrap();
        let row = listed.iter().find(|r| r.region_id == later).unwrap();
        assert_eq!(row.status, CollectionStatus::NotInPushedVersion);
        assert_eq!(row.detail, err);
        // ...while the pushed one beside it is ready, in the same single walk.
        assert_eq!(listed.iter().find(|r| r.region_id == REGION).unwrap().status, CollectionStatus::Ready);
    });
}

/// A workbook that designated a region but never published (no link) says to
/// publish -- it is not "No writeback regions".
#[test]
fn a_workbook_that_never_published_says_publish_first() {
    let (_dir, prof, form) = published_with_answers();
    let state = author_workbook(form, vec![region_on(form, REGION)], None);
    with_test_profile(prof.path(), || {
        let err = load_region_submissions_core(&state, REGION).expect_err("nothing to read");
        assert_eq!(err, NOT_PUBLISHED_TEXT);
        let listed = list_collection_regions(&state).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, CollectionStatus::NotPublished);
        assert_eq!(listed[0].detail, NOT_PUBLISHED_TEXT);
    });
}

/// Another computer holding the workbook (no publisher key for the
/// application) is refused the cross-submitter view, as before: the AUTHOR
/// route is a route to the gate, never around it.
#[test]
fn another_computer_is_refused_the_authors_inbox() {
    let (dir, _prof, form) = published_with_answers();
    let stranger = TempDir::new().unwrap();
    calp::signing::PublisherKeypair::load_or_create(stranger.path()).unwrap();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(stranger.path(), || {
        let err = load_region_submissions_core(&state, REGION).expect_err("not the publisher");
        assert!(err.contains("Only the publisher of"), "{err}");
        let err = export_region_submissions_csv_core(&state, REGION).expect_err("not the publisher");
        assert!(err.contains("Only the publisher of"), "{err}");
        let err = set_submission_state_core(
            &state,
            REGION.to_string(),
            "id-alice".to_string(),
            2,
            1,
            "approved".to_string(),
            None,
            None,
            None,
        )
        .expect_err("not the publisher");
        assert!(err.contains("Only the publisher of"), "{err}");
        let listed = list_collection_regions(&state).unwrap();
        assert_eq!(listed[0].status, CollectionStatus::NotPublisher, "{}", listed[0].detail);
    });
}

// ---------------------------------------------------------------------------
// The subscriber route is unchanged
// ---------------------------------------------------------------------------

/// A publisher reviewing from a SUBSCRIBER workbook resolves through the
/// subscription, exactly as before: it reads the subscription's one stream
/// (here the development line), so an answer tagged for another environment is
/// not shown -- and, since the pane's own stream picker became Collect From
/// (2026-10-22), naming another stream is refused rather than peeked at.
#[test]
fn a_subscribed_region_resolves_through_its_subscription_as_before() {
    let (dir, prof, _form) = published_with_answers();
    submit(&dir, "1.0.0", "s-dave-test", "Dave", 4, 9.0, "test", "2026-10-21T12:00:00Z");
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(&location(&dir)).unwrap();
    let pulled = calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: APP.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(VersionPin::Latest),
            now: "2026-10-21T01:00:00Z".to_string(),
        },
        &scope,
        prof.path(),
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("pull");
    let state = crate::create_app_state();
    state.subscriptions.write(&test_seed_effect()).unwrap().subscriptions.push(pulled.subscription);

    with_test_profile(prof.path(), || {
        let c = collection_for_region(&state, REGION).unwrap();
        assert_eq!(c.role, CollectionRole::Subscriber);
        assert_eq!(c.streams, StreamFilter::one(""));
        assert_eq!(c.read_version, "1.0.0");
        let inbox = load_region_submissions_core(&state, REGION).unwrap();
        let names: Vec<String> = inbox.into_iter().map(|r| r.submitter_name).collect();
        assert_eq!(names, vec!["Alice".to_string(), "Bob".to_string()], "the subscription's own stream only");
        let refused = c.filter(Some("test")).expect_err("not this workbook's stream");
        assert!(refused.contains("not this workbook's stream"), "{refused}");
        // What the listing reports as `collecting` for this row.
        assert_eq!(c.streams.streams(), Some(vec![String::new()]));
    });
}

// ---------------------------------------------------------------------------
// Review-fix round (2026-10-21): one decision for the listing and the
// commands, every stream reviewed by the record's own id, nothing silent
// ---------------------------------------------------------------------------

/// One version, one submitter, a `test` AND a `prod` answer for the same cell
/// -- the fold keeps both slots. A review that names no stream (every script on
/// the author's own region) used to `find` whichever came first:
///
/// - WITH the submission id, the id names the record: the prod one is
///   reviewed, the test one is untouched, and the audit row names prod (never
///   "every stream");
/// - WITHOUT an id the review is REFUSED, naming both streams, instead of
///   deciding on an arbitrary one.
///
/// SABOTAGE: make the `Some(expected)` arm look up `candidates.first()` instead
/// of the record with the expected id -- the prod review fails "superseded".
#[test]
fn an_every_stream_review_decides_on_the_record_its_id_names() {
    let (dir, prof, form) = published_with_answers();
    submit(&dir, "1.0.0", "s-alice-test", "Alice", 2, 7.0, "test", "2026-10-21T10:00:00Z");
    submit(&dir, "1.0.0", "s-alice-prod", "Alice", 2, 9.0, "prod", "2026-10-21T10:05:00Z");
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let refused = set_submission_state_core(
            &state,
            REGION.to_string(),
            "id-alice".to_string(),
            2,
            1,
            "approved".to_string(),
            None,
            None,
            None,
        )
        .expect_err("two streams and no id: nothing to decide on");
        assert!(refused.contains("more than one stream"), "{refused}");
        assert!(refused.contains("prod") && refused.contains("test"), "{refused}");

        set_submission_state_core(
            &state,
            REGION.to_string(),
            "id-alice".to_string(),
            2,
            1,
            "approved".to_string(),
            None,
            Some("s-alice-prod".to_string()),
            None,
        )
        .expect("the id names the prod record");
        let rows = load_region_submissions_core(&state, REGION).unwrap();
        let state_of = |env: &str| {
            rows.iter()
                .find(|r| r.submitter_name == "Alice" && r.environment == env)
                .map(|r| r.state.clone())
                .unwrap()
        };
        assert_eq!(state_of("prod"), "approved");
        assert_eq!(state_of("test"), "submitted", "the other stream's record is untouched");
        assert_eq!(state_of(""), "submitted");

        let audit = state.audit_log.read().unwrap();
        let row = audit
            .entries
            .iter()
            .rev()
            .find(|e| matches!(e.event, calp::audit::AuditEvent::WritebackReviewed))
            .expect("the review is audited");
        assert!(row.description.contains("in prod"), "{}", row.description);
        assert!(!row.description.contains("every stream"), "{}", row.description);
        assert!(row.description.contains("cell B3"), "{}", row.description);
    });
}

/// A row picked from the every-stream list is reviewable with its id even when
/// the stream the caller names cannot carry it: the id search walks the SAME
/// version set the list was built from.
#[test]
fn a_row_listed_under_every_stream_is_reviewable_by_its_id() {
    let (dir, prof, form) = published_with_answers();
    let (wb, _) = {
        let mut wb = Workbook::default();
        let mut sheet = Sheet::new("Form".to_string());
        sheet.id = form;
        wb.sheets = vec![sheet];
        (wb, form)
    };
    publish_version(
        &dir,
        prof.path(),
        &wb,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        vec![region_on(form, REGION)],
    );
    // An answer tagged `test` in 1.0.0; the application has no environment
    // named test, so the stream's own carry-forward holds nothing.
    submit(&dir, "1.0.0", "s-erin-test", "Erin", 3, 4.0, "test", "2026-10-21T10:00:00Z");
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let listed = load_region_submissions_core(&state, REGION).unwrap();
        let erin = listed.iter().find(|r| r.submitter_name == "Erin").expect("listed under every stream");
        set_submission_state_core(
            &state,
            REGION.to_string(),
            erin.submitter_id.clone(),
            erin.cell_row,
            erin.cell_col,
            "rejected".to_string(),
            Some("check".to_string()),
            Some(erin.submission_id.clone()),
            Some(erin.environment.clone()),
        )
        .expect("the row on screen can be decided");
        let after = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(after.iter().find(|r| r.submitter_name == "Erin").unwrap().state, "rejected");
    });
}

/// WRITEBACK > REMOVE REGION does not hide answers a published version still
/// collects: the region stays listed (designated: false, with a note), and its
/// inbox and review still work.
///
/// SABOTAGE: drop the `walk.declared_regions()` loop from the listing -- the
/// region disappears and the first assertion fails.
#[test]
fn a_region_removed_from_the_working_copy_is_still_collected() {
    let (dir, prof, form) = published_with_answers();
    // The working copy no longer designates anything.
    let state = author_workbook(form, Vec::new(), Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let listed = list_collection_regions(&state).unwrap();
        let row = listed.iter().find(|r| r.region_id == REGION).expect("still listed");
        assert_eq!(row.status, CollectionStatus::Ready, "{}", row.detail);
        assert!(!row.designated);
        assert_eq!(row.role, CollectionRole::Author);
        assert!(row.note.contains("no longer designated"), "{}", row.note);
        assert_eq!(row.sheet_name.as_deref(), Some("Form"));

        let c = collection_for_region(&state, REGION).expect("resolved from the declaration");
        assert_eq!(c.role, CollectionRole::Author);
        let inbox = load_region_submissions_core(&state, REGION).expect("the inbox");
        assert_eq!(inbox.len(), 2);
    });
}

/// A NEWER version that declares the region but fails verification is never
/// skipped in silence: the row is ready from the older verified version AND
/// says that the newer version's answers are not shown -- and the listing and
/// `collection_for_region` say the same thing, because both call the one
/// resolver.
#[test]
fn a_newer_version_that_does_not_verify_is_named_not_skipped() {
    let (dir, prof, form) = published_with_answers();
    let (wb, _) = {
        let mut wb = Workbook::default();
        let mut sheet = Sheet::new("Form".to_string());
        sheet.id = form;
        wb.sheets = vec![sheet];
        (wb, form)
    };
    publish_version(
        &dir,
        prof.path(),
        &wb,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        vec![region_on(form, REGION)],
    );
    // Tamper with 1.1.0's signed manifest: it still DECLARES the region in the
    // unsigned read, but no longer verifies.
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let path = reg.version_dir(APP, "1.1.0").unwrap().join("version-manifest.json");
    let mut json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    json["publisherName"] = serde_json::Value::String("someone else".to_string());
    std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap()).unwrap();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let c = collection_for_region(&state, REGION).expect("the older version verifies");
        assert_eq!(c.read_version, "1.0.0");
        assert!(c.note.contains("v1.1.0"), "the skipped version is named: {}", c.note);
        let listed = list_collection_regions(&state).unwrap();
        let row = listed.iter().find(|r| r.region_id == REGION).unwrap();
        assert_eq!(row.status, CollectionStatus::Ready, "{}", row.detail);
        assert_eq!(row.version.as_deref(), Some("1.0.0"));
        assert_eq!(row.note, c.note, "the listing and the resolver give one answer");
    });
}

/// An inbox whose versions cannot be read is an ERROR, not "No submissions
/// yet for this region." with answers waiting in the workspace; a review says
/// it could not read, not "No submission found".
#[test]
fn an_unreadable_inbox_says_so() {
    let (dir, prof, form) = published_with_answers();
    // `reviews` as a FILE: every fold of 1.0.0 fails to read it.
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let version_dir = reg.version_dir(APP, "1.0.0").unwrap();
    let _ = std::fs::remove_dir_all(version_dir.join("reviews"));
    std::fs::write(version_dir.join("reviews"), b"not a folder").unwrap();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let err = load_region_submissions_core(&state, REGION).expect_err("nothing could be read");
        assert!(err.contains("Could not read the submissions"), "{err}");
        let err = set_submission_state_core(
            &state,
            REGION.to_string(),
            "id-alice".to_string(),
            2,
            1,
            "approved".to_string(),
            None,
            Some("s-alice-1".to_string()),
            None,
        )
        .expect_err("the record may be in the version that could not be read");
        assert!(err.contains("Could not read"), "{err}");
        assert!(err.contains("B3"), "the cell is named in A1: {err}");
    });
}

/// Collected Responses shows a number as the cells show it, in the APP locale
/// ("1,5" under sv-SE); the CSV export stays invariant for other programs.
#[test]
fn the_inbox_shows_numbers_in_the_app_locale() {
    let (dir, prof, form) = published_with_answers();
    submit(&dir, "1.0.0", "s-dana-1", "Dana", 4, 1.5, "", "2026-10-21T09:10:00Z");
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));
    *state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("sv-SE");

    with_test_profile(prof.path(), || {
        let inbox = load_region_submissions_core(&state, REGION).unwrap();
        let dana = inbox.iter().find(|r| r.submitter_name == "Dana").unwrap();
        assert_eq!(dana.value_display, "1,5");
        let csv = export_region_submissions_csv_core(&state, REGION).unwrap();
        assert!(csv.contains(",1.5,"), "the CSV stays invariant: {csv}");
    });
}

// ---------------------------------------------------------------------------
// Writeback > Collect From (owner decision 2026-10-22)
// ---------------------------------------------------------------------------

const AT: &str = "2026-10-22T00:00:00Z";

fn keypair(prof: &Path) -> calp::signing::PublisherKeypair {
    calp::signing::PublisherKeypair::load_or_create(prof).unwrap()
}

/// Define the application's pipeline (`expected` = the log's current sequence).
fn define_pipeline(dir: &TempDir, prof: &Path, names: &[&str], expected: u64) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let names: Vec<String> = names.iter().map(|s| s.to_string()).collect();
    calp::environments::set_pipeline(&reg, APP, &names, expected, &keypair(prof), AT).expect("set the pipeline");
}

fn promote_to(dir: &TempDir, prof: &Path, environment: &str, version: &str) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    calp::environments::promote(
        &reg,
        APP,
        environment,
        Some(SemVer::parse(version).unwrap()),
        None,
        &keypair(prof),
        AT,
    )
    .expect("promote");
}

/// The application's form sheet again, for a second publish.
fn same_form(form: identity::SheetId) -> Workbook {
    let mut wb = Workbook::default();
    let mut sheet = Sheet::new("Form".to_string());
    sheet.id = form;
    wb.sheets = vec![sheet];
    wb
}

/// One version (1.0.0), a pipeline test -> prod both on it, and answers in
/// every stream: the line (Alice, Bob), test (Tess) and prod (Paul, Pia).
fn published_in_three_streams() -> (TempDir, TempDir, identity::SheetId) {
    let (dir, prof, form) = published_with_answers();
    define_pipeline(&dir, prof.path(), &["test", "prod"], 0);
    promote_to(&dir, prof.path(), "test", "1.0.0");
    promote_to(&dir, prof.path(), "prod", "1.0.0");
    submit(&dir, "1.0.0", "s-tess-test", "Tess", 2, 10.0, "test", "2026-10-21T10:00:00Z");
    submit(&dir, "1.0.0", "s-paul-prod", "Paul", 2, 20.0, "prod", "2026-10-21T10:05:00Z");
    submit(&dir, "1.0.0", "s-pia-prod", "Pia", 3, 30.0, "prod", "2026-10-21T10:06:00Z");
    (dir, prof, form)
}

fn streams_of(rows: &[crate::calp_commands::RegionSubmissionInfo]) -> Vec<String> {
    let mut s: Vec<String> = rows.iter().map(|r| r.environment.clone()).collect();
    s.sort();
    s.dedup();
    s
}

/// THE OWNER'S DEFAULT. An application WITH environments collects its LAST
/// environment (prod) until the publisher chooses -- the inbox, the export,
/// the roster and the listing alike; test answers never reach a production
/// read merely because nobody chose. Choosing "All streams" collects all.
///
/// SABOTAGE: make `default_filter` return `StreamFilter::All` -- the default
/// read shows the line and test rows and this fails.
#[test]
fn with_environments_the_default_is_the_last_environment() {
    let (dir, prof, form) = published_in_three_streams();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let rows = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(streams_of(&rows), vec!["prod".to_string()], "{rows:?}");
        assert_eq!(rows.len(), 2);
        let csv = export_region_submissions_csv_core(&state, REGION).unwrap();
        assert!(csv.contains("Paul") && !csv.contains("Tess") && !csv.contains("Alice"), "{csv}");
        let status = region_response_status_core(&state, REGION).unwrap();
        assert_eq!(status.responded, vec!["Paul".to_string(), "Pia".to_string()]);
        let listed = list_collection_regions(&state).unwrap();
        assert_eq!(listed[0].collecting, Some(vec!["prod".to_string()]));

        let view = collection_streams_view(&state).unwrap();
        assert_eq!(view.mode, CollectMode::Default);
        assert_eq!(view.default_stream.as_deref(), Some("prod"));
        assert_eq!(view.summary, "prod (the last environment)");
        assert_eq!(view.collecting, Some(vec!["prod".to_string()]));
        let prod = view.choices.iter().find(|c| c.stream == "prod").unwrap();
        assert!(prod.included && prod.hint.contains("the default"), "{prod:?}");
        assert!(!view.choices.iter().find(|c| c.stream == "test").unwrap().included);

        choose(&state, Some(CollectStreams::All));
        let all = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(streams_of(&all), vec!["".to_string(), "prod".to_string(), "test".to_string()]);
        assert_eq!(all.len(), 5);
    });
}

/// A choice filters EVERY publisher read: inbox, CSV, roster and listing, and
/// a script's read (the gateway calls the same command with no stream).
///
/// SABOTAGE: resolve the author's collection with `streams: StreamFilter::All`
/// (`AuthorWalk::resolve`) -- every read admits prod again.
#[test]
fn the_choice_filters_every_publisher_read() {
    let (dir, prof, form) = published_in_three_streams();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));
    let fs = crate::persistence::FileState::default();

    with_test_profile(prof.path(), || {
        set_collection_streams(&state, &fs, only(&["", "test"])).expect("the publisher chooses");
        let rows = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(streams_of(&rows), vec!["".to_string(), "test".to_string()]);
        assert_eq!(rows.len(), 3);
        let csv = export_region_submissions_csv_core(&state, REGION).unwrap();
        assert!(csv.contains("Tess") && csv.contains("Alice") && !csv.contains("Paul"), "{csv}");
        let status = region_response_status_core(&state, REGION).unwrap();
        assert_eq!(status.responded, vec!["Alice".to_string(), "Bob".to_string(), "Tess".to_string()]);
        let listed = list_collection_regions(&state).unwrap();
        assert_eq!(listed[0].collecting, Some(vec!["".to_string(), "test".to_string()]));
    });
}

/// A review is refused for a stream the workbook does not collect -- by the
/// row's stream or by a submission id in it -- and works inside the choice.
///
/// SABOTAGE (proved 2026-10-22): make `RegionCollection::filter(None)` return
/// `StreamFilter::All` -- the prod record named by its id is reviewed.
#[test]
fn a_review_outside_the_choice_is_refused() {
    let (dir, prof, form) = published_in_three_streams();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        choose(&state, only(&["test"]));
        let review = |id: &str, who: &str, env: Option<&str>| {
            set_submission_state_core(
                &state,
                REGION.to_string(),
                format!("id-{}", who.to_lowercase()),
                2,
                1,
                "approved".to_string(),
                None,
                Some(id.to_string()),
                env.map(|e| e.to_string()),
            )
        };
        let err = review("s-paul-prod", "Paul", Some("prod")).expect_err("prod is not collected");
        assert!(err.contains("Collect From"), "{err}");
        let err = review("s-paul-prod", "Paul", None).expect_err("a prod record by id is not collected either");
        assert!(err.contains("No submission found") || err.contains("Collect From"), "{err}");
        review("s-tess-test", "Tess", Some("test")).expect("a collected stream is reviewed");
    });
}

/// Without a submission id, the "more than one stream" refusal fires only for
/// streams the workbook COLLECTS: under {prod} a person who answered in test
/// and prod is reviewed in prod; under All the review is refused.
#[test]
fn a_review_without_an_id_is_refused_only_across_collected_streams() {
    let (dir, prof, form) = published_in_three_streams();
    submit(&dir, "1.0.0", "s-paul-test", "Paul", 2, 21.0, "test", "2026-10-21T10:07:00Z");
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let review = || {
            set_submission_state_core(
                &state,
                REGION.to_string(),
                "id-paul".to_string(),
                2,
                1,
                "approved".to_string(),
                None,
                None,
                None,
            )
        };
        choose(&state, Some(CollectStreams::All));
        let err = review().expect_err("two collected streams and no id");
        assert!(err.contains("more than one stream"), "{err}");
        choose(&state, only(&["prod"]));
        review().expect("only prod is collected: nothing ambiguous");
        let rows = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(rows.iter().find(|r| r.submitter_name == "Paul").unwrap().state, "approved");
    });
}

/// A NEW environment defined after an explicit choice arrives UNTICKED, with a
/// "not collected" note, and its answers are not read; under "All streams" it
/// is collected at once. Under the default the new LAST environment becomes
/// the default.
///
/// SABOTAGE: compute `not_collected` as empty.
#[test]
fn a_new_environment_arrives_unticked_under_an_explicit_choice() {
    let (dir, prof, form) = published_in_three_streams();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        choose(&state, only(&["prod"]));
        // Sequence 3: the pipeline and two promotions.
        define_pipeline(&dir, prof.path(), &["test", "staging", "prod"], 3);
        promote_to(&dir, prof.path(), "staging", "1.0.0");
        submit(&dir, "1.0.0", "s-sam-staging", "Sam", 4, 40.0, "staging", "2026-10-21T11:00:00Z");

        let view = collection_streams_view(&state).unwrap();
        assert_eq!(view.not_collected, vec!["test".to_string(), "staging".to_string()]);
        let staging = view.choices.iter().find(|c| c.stream == "staging").expect("listed");
        assert!(!staging.included, "a new environment arrives unticked");
        assert!(staging.hint.contains("not collected"), "{}", staging.hint);
        let rows = load_region_submissions_core(&state, REGION).unwrap();
        assert!(!rows.iter().any(|r| r.environment == "staging"));

        choose(&state, Some(CollectStreams::All));
        let rows = load_region_submissions_core(&state, REGION).unwrap();
        assert!(rows.iter().any(|r| r.environment == "staging"), "All streams includes it at once");
        assert!(collection_streams_view(&state).unwrap().not_collected.is_empty());
    });
}

/// An environment REMOVED from the pipeline while chosen stays listed (kind
/// `removed`, still ticked) and its answers stay readable until it is
/// unticked. A tag only answers carry is offered too, unticked.
#[test]
fn a_removed_environment_stays_listed_and_readable_until_unticked() {
    let (dir, prof, form) = published_in_three_streams();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        choose(&state, only(&["test"]));
        define_pipeline(&dir, prof.path(), &["prod"], 3);
        let rows = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(streams_of(&rows), vec!["test".to_string()], "still read");
        let view = collection_streams_view(&state).unwrap();
        let test = view.choices.iter().find(|c| c.stream == "test").expect("still listed");
        assert_eq!(test.kind, StreamChoiceKind::Removed);
        assert!(test.included);
        assert!(test.hint.contains("not in the pipeline"), "{}", test.hint);
    });
}

/// The setter refuses an empty choice, an invented name and an unlinked
/// workbook -- and a refusal leaves the workbook clean.
#[test]
fn set_refuses_empty_invented_and_unlinked_and_stays_clean() {
    let (dir, prof, form) = published_in_three_streams();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));
    let fs = crate::persistence::FileState::default();

    with_test_profile(prof.path(), || {
        let err = set_collection_streams(&state, &fs, Some(CollectStreams::Only(Default::default()))).unwrap_err();
        assert_eq!(err, EMPTY_CHOICE_TEXT);
        let err = set_collection_streams(&state, &fs, only(&["nope"])).unwrap_err();
        assert!(err.contains("not an environment"), "{err}");
        let err = set_collection_streams(&state, &fs, only(&["Prod"])).unwrap_err();
        assert!(err.contains("cannot be collected"), "{err}");
        assert!(!fs.is_dirty(), "a refusal must not dirty the workbook");
        assert_eq!(state.working_copy_link.read().unwrap().as_ref().unwrap().collect_streams, None);

        let unlinked = author_workbook(form, vec![region_on(form, REGION)], None);
        assert_eq!(set_collection_streams(&unlinked, &fs, only(&["prod"])).unwrap_err(), NOT_PUBLISHED_TEXT);
        assert!(!collection_streams_view(&unlinked).unwrap().linked);
        assert!(!fs.is_dirty());
    });
}

/// Setting the stored choice again changes nothing (clean, no audit row); a
/// change dirties the workbook and is AUDITED although auditing is off.
///
/// SABOTAGE: construct the `DocumentEffect::mutates` before the no-change
/// return -- the first assertion fails.
#[test]
fn set_dirties_and_audits_only_when_the_choice_changes() {
    let (dir, prof, form) = published_in_three_streams();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));
    assert!(!state.audit_log.read().unwrap().enabled, "auditing is off in this workbook");

    with_test_profile(prof.path(), || {
        let same = crate::persistence::FileState::default();
        set_collection_streams(&state, &same, None).expect("the default again");
        assert!(!same.is_dirty(), "nothing changed");

        let fs = crate::persistence::FileState::default();
        let view = set_collection_streams(&state, &fs, only(&["", "prod"])).expect("a change");
        assert!(fs.is_dirty(), "the choice is saved with the workbook");
        assert_eq!(view.mode, CollectMode::Only);
        assert_eq!(view.selection, Some(vec!["".to_string(), "prod".to_string()]));
        assert_eq!(view.summary, "Development line, prod");
        let audit = state.audit_log.read().unwrap();
        let row = audit
            .entries
            .iter()
            .find(|e| matches!(e.event, calp::audit::AuditEvent::CollectionStreamsChanged))
            .expect("always recorded");
        assert!(row.description.contains("prod (the last environment)"), "{}", row.description);
        assert!(row.description.contains("Development line, prod"), "{}", row.description);
        assert_eq!(row.extra.get("application").and_then(|v| v.as_str()), Some(APP));
    });
}

/// Another computer -- no publisher key for the application -- may neither
/// change the choice nor is told it may.
#[test]
fn set_is_refused_on_another_computer() {
    let (dir, _prof, form) = published_in_three_streams();
    let stranger = TempDir::new().unwrap();
    calp::signing::PublisherKeypair::load_or_create(stranger.path()).unwrap();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));
    let fs = crate::persistence::FileState::default();

    with_test_profile(stranger.path(), || {
        let err = set_collection_streams(&state, &fs, only(&["test"])).unwrap_err();
        assert!(err.contains("Only the publisher of"), "{err}");
        assert!(!fs.is_dirty());
        assert_eq!(state.working_copy_link.read().unwrap().as_ref().unwrap().collect_streams, None);
        let view = collection_streams_view(&state).unwrap();
        assert!(!view.can_change);
        assert!(view.change_refusal.unwrap_or_default().contains("Only the publisher of"));
    });
}

/// AN EXPLICIT STREAM CARRIES FORWARD ONLY OVER VERSIONS IT HELD (critique
/// problem 3). prod went straight to 1.1.0; a record tagged `prod` in 1.0.0
/// -- a version prod never ran -- is not collected under {prod} (nor under
/// the default, which is prod), while "All streams" reads every version.
///
/// SABOTAGE: walk `older_package_versions` for the `Only` arm too.
#[test]
fn an_explicit_stream_carries_forward_only_over_versions_it_held() {
    let (dir, prof, form) = published_with_answers();
    publish_version(
        &dir,
        prof.path(),
        &same_form(form),
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        vec![region_on(form, REGION)],
    );
    define_pipeline(&dir, prof.path(), &["prod"], 0);
    promote_to(&dir, prof.path(), "prod", "1.1.0");
    submit(&dir, "1.0.0", "s-mallory-prod", "Mallory", 4, 99.0, "prod", "2026-10-21T10:00:00Z");
    submit(&dir, "1.1.0", "s-carol-prod", "Carol", 4, 3.0, "prod", "2026-10-21T11:00:00Z");
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.1.0")));

    with_test_profile(prof.path(), || {
        let names = |rows: Vec<crate::calp_commands::RegionSubmissionInfo>| {
            rows.into_iter().map(|r| r.submitter_name).collect::<Vec<_>>()
        };
        assert_eq!(names(load_region_submissions_core(&state, REGION).unwrap()), vec!["Carol".to_string()]);
        choose(&state, only(&["prod"]));
        assert_eq!(names(load_region_submissions_core(&state, REGION).unwrap()), vec!["Carol".to_string()]);
        choose(&state, Some(CollectStreams::All));
        let all = names(load_region_submissions_core(&state, REGION).unwrap());
        assert!(all.contains(&"Mallory".to_string()) && all.contains(&"Alice".to_string()), "{all:?}");
    });
}

/// BUG-0555. Answers from an OLDER version whose region no longer addresses
/// the same cells -- or any older version, for a region bound to one version
/// (`Strict`) -- are not carried forward by any publisher read, exactly as
/// GATHER does not carry them.
///
/// SABOTAGE: make `collected_versions` keep every version `stream_versions`
/// returns -- Alice's and Bob's 1.0.0 answers come back on cells B3/B4, which
/// in 1.1.0 lie OUTSIDE the region, and this fails.
#[test]
fn an_incompatible_or_strict_older_version_contributes_no_rows() {
    let (dir, prof, form) = published_with_answers();
    // 1.1.0 moves the region down two rows: B5:B7.
    let mut moved = region_on(form, REGION);
    moved.selector.row_start = 4;
    moved.selector.row_end = 6;
    publish_version(
        &dir,
        prof.path(),
        &same_form(form),
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        vec![moved.clone()],
    );
    submit(&dir, "1.1.0", "s-carol-1", "Carol", 4, 3.0, "", "2026-10-21T11:00:00Z");
    let state = author_workbook(form, vec![moved], Some(link_to(&dir, "1.1.0")));

    with_test_profile(prof.path(), || {
        let rows = load_region_submissions_core(&state, REGION).unwrap();
        let names: Vec<String> = rows.iter().map(|r| r.submitter_name.clone()).collect();
        assert_eq!(names, vec!["Carol".to_string()], "the moved region's old answers are not carried");
        let status = region_response_status_core(&state, REGION).unwrap();
        assert_eq!(status.responded, vec!["Carol".to_string()]);
        let err = set_submission_state_core(
            &state,
            REGION.to_string(),
            "id-alice".to_string(),
            2,
            1,
            "approved".to_string(),
            None,
            Some("s-alice-1".to_string()),
            None,
        )
        .expect_err("a record the list does not carry is not reviewable");
        assert!(err.contains("No submission found"), "{err}");
    });

    // STRICT: same geometry, but the region is bound to one version.
    let (dir, prof, form) = published_with_answers();
    let mut strict = region_on(form, REGION);
    strict.version_binding = Some(calp::writeback::VersionBinding::Strict);
    publish_version(
        &dir,
        prof.path(),
        &same_form(form),
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        vec![strict.clone()],
    );
    submit(&dir, "1.1.0", "s-carol-1", "Carol", 4, 3.0, "", "2026-10-21T11:00:00Z");
    let state = author_workbook(form, vec![strict], Some(link_to(&dir, "1.1.0")));
    with_test_profile(prof.path(), || {
        let names: Vec<String> =
            load_region_submissions_core(&state, REGION).unwrap().into_iter().map(|r| r.submitter_name).collect();
        assert_eq!(names, vec!["Carol".to_string()], "a Strict region carries nothing forward");
    });
}

/// THE AUTHOR'S REGION IS A MODEL TABLE (open-items 2.am item 7): a PUBLISHER
/// dataset with an `environment` column, built from exactly the rows
/// Collected Responses shows, following the choice -- and kept fresh: a new
/// answer seen by a publisher read triggers a rebuild.
///
/// SABOTAGE: read the author pass with `StreamFilter::All` instead of
/// `collection.streams` -- the default (prod) table holds test rows.
#[test]
fn the_authors_region_becomes_a_publisher_dataset_that_follows_the_choice() {
    use crate::bi::writeback_source::{collect_writeback_datasets, note_author_rows_seen, DatasetOrigin, WritebackAudience};
    let (dir, prof, form) = published_in_three_streams();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let datasets = collect_writeback_datasets(&state);
        assert_eq!(datasets.len(), 1);
        let ds = &datasets[0];
        assert_eq!(ds.origin, DatasetOrigin::Author);
        assert_eq!(ds.audience, WritebackAudience::Publisher);
        assert_eq!(ds.package_version, "1.0.0");
        assert_eq!(ds.streams, "prod");
        let mut ds_ids: Vec<String> = ds.rows.iter().map(|s| s.id.clone()).collect();
        ds_ids.sort();
        let mut pane_ids: Vec<String> =
            load_region_submissions_core(&state, REGION).unwrap().into_iter().map(|r| r.submission_id).collect();
        pane_ids.sort();
        assert_eq!(ds_ids, pane_ids, "the model table and Collected Responses hold the same rows");
        assert_eq!(ds_ids, vec!["s-paul-prod".to_string(), "s-pia-prod".to_string()]);

        choose(&state, only(&["", "test"]));
        let ds = collect_writeback_datasets(&state).remove(0);
        let mut envs: Vec<String> = ds.rows.iter().map(|s| s.environment.clone()).collect();
        envs.sort();
        envs.dedup();
        assert_eq!(envs, vec!["".to_string(), "test".to_string()]);

        // FRESHNESS: the first read records the rows; a re-read of the same
        // rows is no change; a new answer from another computer is.
        let (collection, registry) = crate::calp_collection::publisher_collection(&state, REGION).unwrap();
        let rows = |c: &crate::calp_collection::RegionCollection| {
            crate::calp_commands::load_region_current_submissions(c, registry.as_ref(), REGION, &c.streams).unwrap()
        };
        note_author_rows_seen(&collection, REGION, &rows(&collection));
        assert!(!note_author_rows_seen(&collection, REGION, &rows(&collection)), "no change, no rebuild");
        submit(&dir, "1.0.0", "s-tom-test", "Tom", 4, 5.0, "test", "2026-10-21T12:00:00Z");
        assert!(note_author_rows_seen(&collection, REGION, &rows(&collection)), "a new answer triggers a rebuild");
        let ds = collect_writeback_datasets(&state).remove(0);
        assert!(ds.rows.iter().any(|s| s.id == "s-tom-test"), "the rebuild sees it");
    });
}

/// No author dataset on a computer that is not a publisher of the
/// application: an author region has no governed subscriber view.
#[test]
fn no_author_dataset_for_another_computer() {
    let (dir, _prof, form) = published_in_three_streams();
    let stranger = TempDir::new().unwrap();
    calp::signing::PublisherKeypair::load_or_create(stranger.path()).unwrap();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));
    with_test_profile(stranger.path(), || {
        assert!(crate::bi::writeback_source::collect_writeback_datasets(&state).is_empty());
    });
}

/// `merge_lenient_submissions` keeps ONE SLOT PER STREAM: the same person and
/// cell in test and prod are two rows, not one hiding the other.
///
/// SABOTAGE: drop `environment` from the merge's slot key.
#[test]
fn merge_lenient_keeps_one_slot_per_stream() {
    let (_dir, _prof, form) = published_with_answers();
    let region = region_on(form, REGION);
    let answer = |id: &str, env: &str, at: &str| {
        let mut s: WritebackSubmission = serde_json::from_value(serde_json::json!({
            "id": id, "regionId": REGION, "cellRow": 2, "cellCol": 1,
            "submitter": { "id": "id-alice", "displayName": "Alice" },
            "value": { "type": "number", "value": 1.0 },
            "state": "submitted", "createdAt": at, "updatedAt": at
        }))
        .unwrap();
        s.environment = env.to_string();
        s
    };
    let current = vec![answer("a-prod", "prod", "2026-10-22T10:00:00Z")];
    let mut older_subs = HashMap::new();
    older_subs.insert(REGION.to_string(), vec![answer("a-test", "test", "2026-10-21T10:00:00Z")]);
    let merged = crate::calp_commands::merge_lenient_submissions(current, &[(vec![region.clone()], older_subs)], &region);
    let mut ids: Vec<String> = merged.into_iter().map(|s| s.id).collect();
    ids.sort();
    assert_eq!(ids, vec!["a-prod".to_string(), "a-test".to_string()]);
}

/// BUG-0563. THE DEVELOPMENT LINE AHEAD OF PROD drops no prod answer from the
/// default (prod) view. prod runs 1.0.0, where the region is B3:B5; the
/// unpromoted head 1.1.0 moved it (or bound it to one version). prod's answers
/// are stored under 1.0.0 and must be judged against 1.0.0's declaration --
/// exactly as a prod subscriber's GATHER judges them -- not the head's. The
/// inbox, the roster, the CSV, a review by id and the author's BI table all
/// keep them; the development line's own older answers are still judged
/// against the head (and stay out).
///
/// SABOTAGE: return an empty map from `AuthorWalk::stream_bases` -- every
/// prod answer is dropped as "the region's cells changed since".
#[test]
fn the_default_prod_view_keeps_prods_answers_when_the_line_is_ahead() {
    for strict in [false, true] {
        let (dir, prof, form) = published_with_answers();
        define_pipeline(&dir, prof.path(), &["prod"], 0);
        promote_to(&dir, prof.path(), "prod", "1.0.0");
        submit(&dir, "1.0.0", "s-paul-prod", "Paul", 2, 20.0, "prod", "2026-10-21T10:05:00Z");
        let mut head = region_on(form, REGION);
        if strict {
            head.version_binding = Some(calp::writeback::VersionBinding::Strict);
        } else {
            head.selector.row_start = 4;
            head.selector.row_end = 6;
        }
        publish_version(
            &dir,
            prof.path(),
            &same_form(form),
            SemVer::new(1, 1, 0),
            PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
            vec![head.clone()],
        );
        let state = author_workbook(form, vec![head], Some(link_to(&dir, "1.1.0")));

        with_test_profile(prof.path(), || {
            let label = if strict { "strict head" } else { "moved head" };
            let rows = load_region_submissions_core(&state, REGION).unwrap();
            let names: Vec<String> = rows.iter().map(|r| r.submitter_name.clone()).collect();
            assert_eq!(names, vec!["Paul".to_string()], "{label}: the default (prod) inbox");
            let status = region_response_status_core(&state, REGION).unwrap();
            assert_eq!(status.responded, vec!["Paul".to_string()], "{label}: the roster");
            let csv = export_region_submissions_csv_core(&state, REGION).unwrap();
            assert!(csv.contains("Paul"), "{label}: the export\n{csv}");
            set_submission_state_core(
                &state,
                REGION.to_string(),
                "id-paul".to_string(),
                2,
                1,
                "approved".to_string(),
                None,
                Some("s-paul-prod".to_string()),
                None,
            )
            .unwrap_or_else(|e| panic!("{label}: review: {e}"));
            let ds = crate::bi::writeback_source::collect_writeback_datasets(&state);
            assert_eq!(ds.len(), 1);
            assert_eq!(
                ds[0].rows.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
                vec!["s-paul-prod"],
                "{label}: the author's model table"
            );
            // The development line is still judged against the head: Alice's
            // and Bob's 1.0.0 answers do not carry into 1.1.0's region.
            choose(&state, Some(CollectStreams::Only(["".to_string(), "prod".to_string()].into_iter().collect())));
            let names: Vec<String> =
                load_region_submissions_core(&state, REGION).unwrap().into_iter().map(|r| r.submitter_name).collect();
            assert_eq!(names, vec!["Paul".to_string()], "{label}: line + prod");
        });
    }
}

/// THE DEFAULT FAILS CLOSED ON AN UNAUTHORISED PIPELINE. The latest Pipeline
/// record was signed by a key the application no longer authorises (a removed
/// co-publisher -- or a share-writer's self-signed record), so every
/// environment is marked and there is no last environment to follow: every
/// publisher read is refused with a sentence, exactly as a subscriber's
/// `resolve_environment` refuses. Before, the default followed the
/// unauthorised pipeline's last entry.
///
/// SABOTAGE: make `default_environment` return `environments.last()` again.
#[test]
fn the_default_refuses_a_pipeline_set_by_an_unauthorised_key() {
    let (dir, prof, form) = published_in_three_streams();
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let root = keypair(prof.path());
    let delegate_prof = TempDir::new().unwrap();
    let delegate = keypair(delegate_prof.path());
    let mut list = calp::publishers::PublisherList::new(APP, &root.public_key_hex(), AT);
    list.authorized_keys.push(calp::publishers::AuthorizedKey {
        key: delegate.public_key_hex(),
        name: "Dee".to_string(),
        added_at: AT.to_string(),
    });
    calp::publishers::write_signed(&reg, &list, &root).unwrap();
    // The delegate re-defines the pipeline (prod last, then a new "uat").
    // The log holds three records: the pipeline, test -> 1.0.0, prod -> 1.0.0.
    let sequence = 3;
    calp::environments::set_pipeline(
        &reg,
        APP,
        &["test".to_string(), "prod".to_string(), "uat".to_string()],
        sequence,
        &delegate,
        AT,
    )
    .unwrap();
    // ...and is removed.
    let mut removed = list.clone();
    removed.revision += 1;
    removed.authorized_keys.clear();
    calp::publishers::write_signed(&reg, &removed, &root).unwrap();
    let state = author_workbook(form, vec![region_on(form, REGION)], Some(link_to(&dir, "1.0.0")));

    with_test_profile(prof.path(), || {
        let err = load_region_submissions_core(&state, REGION).expect_err("no default to follow");
        assert!(err.contains("does not authorise"), "{err}");
        let view = collection_streams_view(&state).unwrap();
        assert_eq!(view.default_stream, None, "{view:?}");
        assert!(view.environments_error.as_deref().is_some_and(|e| e.contains("does not authorise")), "{view:?}");
        // An explicit choice still reads.
        choose(&state, only(&["prod"]));
        let names: Vec<String> =
            load_region_submissions_core(&state, REGION).unwrap().into_iter().map(|r| r.submitter_name).collect();
        assert_eq!(names, vec!["Paul".to_string(), "Pia".to_string()]);
    });
}
