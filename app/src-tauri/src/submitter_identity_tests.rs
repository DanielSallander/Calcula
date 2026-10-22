//! FILENAME: app/src-tauri/src/submitter_identity_tests.rs
//! PURPOSE: Identity phase 1 (owner decision 2026-10-22) end to end in the host:
//!          signed answers, signed approve/reject decisions, the fold's refusals
//!          as every publisher read sees them, the one "mine" predicate, the one
//!          principal matcher, and the reader-independence of the fold.
//! CONTEXT: Every fixture is a REAL signed publish to a temp workspace (the
//!          test profile holds the publisher key), with answers written where a
//!          submit writes them. A "computer" is a test profile
//!          (`with_test_profile`): its own publisher key, signing key and pins.
//!          Nothing here touches the owner's workspace (C:\writeback-test).

use std::collections::HashMap;
use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::version::SemVer;
use calp::writeback::{ReviewEvent, SubmissionState, SubmissionValue, WritebackSubmission};
use calp::{SenderCheck, SubmissionOrigin};
use persistence::{Sheet, Workbook};

use crate::calp_commands::{
    foreign_draft_refusal, load_region_submissions_core, own_records_by_region_in, region_response_status_core,
    review_authority, set_submission_state_core, stamp_min_app_version,
};
use crate::document_effect::test_seed_effect;
use crate::profile_dir::with_test_profile;
use crate::AppState;

const APP: &str = "identity-test";
const REGION: &str = "01a15d70-0000-7000-8000-0000000000b2";
const V1: &str = "1.0.0";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn region_on(sheet: identity::SheetId, expected: &[&str]) -> calp::WritebackRegionDeclaration {
    serde_json::from_value(serde_json::json!({
        "id": REGION,
        "selector": { "sheetId": sheet.to_string(), "rowStart": 2, "rowEnd": 4, "colStart": 1, "colEnd": 1 },
        "mode": "per_subscriber",
        "schema": { "valueType": "number", "required": false },
        "visibility": "own_plus_aggregate",
        "submissionPolicy": "on_submit",
        "expectedRespondents": expected
    }))
    .expect("a valid declaration")
}

fn publish_v1(dir: &TempDir, prof: &Path, expected: &[&str]) -> identity::SheetId {
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Form".to_string())];
    let form = wb.sheets[0].id;
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: &wb,
        package_name: APP.to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: "test".to_string(),
        sheet_indices: vec![0],
        now: "2026-10-22T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: Some(vec![region_on(form, expected)]),
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
    form
}

fn author_workbook(dir: &TempDir, form: identity::SheetId, expected: &[&str]) -> AppState {
    let state = crate::create_app_state();
    state.sheet_ids.write(&test_seed_effect()).unwrap()[0] = form;
    state.sheet_names.write(&test_seed_effect()).unwrap()[0] = "Form".to_string();
    *state.writeback_draft_regions.write(&test_seed_effect()).unwrap() = vec![region_on(form, expected)];
    *state.working_copy_link.write(&test_seed_effect()).unwrap() = Some(calp::WorkingCopyLink::new(
        dir.path().to_str().unwrap(),
        APP,
        "report",
        V1,
        "2026-10-22T00:00:00Z",
        Vec::new(),
    ));
    state
}

fn ws(dir: &TempDir) -> calp::workspace::LocalWorkspace {
    calp::workspace::LocalWorkspace::open(dir.path()).unwrap()
}

/// A person's 32-byte signing seed (the app keeps the real one in the
/// Credential Manager of the person's own computer).
fn seed_of(who: &str) -> [u8; 32] {
    let hex = calp::integrity::sha256_hex(who.as_bytes());
    let mut seed = [0u8; 32];
    for (i, pair) in hex.as_bytes().chunks(2).enumerate() {
        seed[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
    }
    seed
}

/// A signed Windows identity for `who` (`CORP\who` on a domain).
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

fn answer(id: &str, who: calp::SubmitterIdentity, row: u32, value: f64, at: &str) -> WritebackSubmission {
    WritebackSubmission {
        id: id.to_string(),
        region_id: REGION.to_string(),
        cell_row: row,
        cell_col: 1,
        cell_id: None,
        submitter: who,
        value: SubmissionValue::Number { value },
        state: SubmissionState::Submitted,
        created_at: at.to_string(),
        updated_at: at.to_string(),
        submitted_at: Some(at.to_string()),
        review_reason: None,
        reviewed_by: None,
        environment: String::new(),
        model_key: None,
        seal: None,
        sender: Default::default(),
        identity: Default::default(),
        extra: HashMap::new(),
    }
}

/// `who` sends an answer from their own computer: signed with their key.
fn send_signed(dir: &TempDir, id: &str, who: &str, row: u32, value: f64, at: &str) -> WritebackSubmission {
    let mut s = answer(id, signed_identity(who), row, value, at);
    calp::submission_seal::seal_submission(&mut s, APP, V1, &seed_of(who), SubmissionOrigin::Interactive).unwrap();
    ws(dir).save_submission(APP, V1, &s).unwrap();
    s
}

/// An answer sent BEFORE sign-in: the old random id, unsigned.
fn send_before_sign_in(dir: &TempDir, id: &str, who: &str, row: u32, value: f64, at: &str) {
    let legacy = calp::SubmitterIdentity {
        display_name: who.to_string(),
        id: format!("01a087b6-3308-79f7-8002-{:012x}", who.len()),
        ..Default::default()
    };
    ws(dir).save_submission(APP, V1, &answer(id, legacy, row, value, at)).unwrap();
}

fn row<'a>(
    rows: &'a [crate::calp_commands::RegionSubmissionInfo],
    name: &str,
) -> &'a crate::calp_commands::RegionSubmissionInfo {
    rows.iter().find(|r| r.submitter_name == name).unwrap_or_else(|| panic!("no row for {name}"))
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/// The inbox labels every row with what every reader concludes from the
/// signature alone, names the SIGNED principal and the signed origin, and the
/// roster matches expected respondents by that principal -- exactly, never by
/// display name. An answer sent before sign-in is shown, labelled, and matches
/// nobody by name (owner decision: start fresh; old answers stay visible).
///
/// SABOTAGE: let `principal_matches` accept an unsigned sender's principal
/// (`signed ||` dropped) -- "CORP\carol" then reads as answered by the old
/// unsigned "Carol" row.
#[test]
fn signed_answers_are_labelled_and_matched_by_principal() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let expected = ["CORP\\alice", "CORP\\carol"];
    let form = publish_v1(&dir, prof.path(), &expected);
    send_signed(&dir, "s-alice", "Alice", 2, 1.0, "2026-10-22T09:00:00Z");
    // Carol's old answer claims her name in the display only.
    send_before_sign_in(&dir, "s-carol", "Carol", 3, 2.0, "2026-10-22T09:05:00Z");
    let state = author_workbook(&dir, form, &expected);

    // On storage where the owner cannot be checked (a sync folder), a signed
    // claim is what the roster matches; on this test's real temp disk Windows
    // would (rightly) report THIS account as the writer of "Alice's" file, and a
    // name Windows refutes matches nobody (`identity_check::matching_identity`).
    crate::identity_verification::test_override::with(calp::StorageKind::SyncFolder, None, || {
    with_test_profile(prof.path(), || {
        let inbox = load_region_submissions_core(&state, REGION).unwrap();
        let alice = row(&inbox, "Alice");
        assert_eq!(alice.sender, SenderCheck::Signed);
        assert_eq!(alice.submitter_principal, "CORP\\alice");
        assert_eq!(alice.origin, Some(SubmissionOrigin::Interactive));
        let carol = row(&inbox, "Carol");
        assert_eq!(carol.sender, SenderCheck::BeforeSignIn);
        assert_eq!(carol.submitter_principal, "", "no principal is shown for an unsigned answer");
        assert_eq!(carol.origin, None);
        // The IPC shape: camelCase strings.
        let json = serde_json::to_value(alice).unwrap();
        assert_eq!(json["sender"], "signed");
        assert_eq!(json["origin"], "interactive");
        assert_eq!(json["submitterPrincipal"], "CORP\\alice");

        let status = region_response_status_core(&state, REGION).unwrap();
        assert_eq!(status.missing, vec!["CORP\\carol".to_string()], "Carol's unsigned answer answers for nobody");
        assert_eq!(status.before_sign_in, vec!["Carol".to_string()]);
        assert_eq!(status.responded, vec!["Alice".to_string(), "Carol".to_string()]);
    });
    });
}

/// THE FORGED-NAME EVENT and the planted record, as the publisher's inbox sees
/// them: a newer answer under Alice's id that Alice's key did not sign -- an
/// unsigned plant, one re-signed by Mallory's key, one whose principal was
/// edited after signing -- never reaches the inbox; Alice's real answer stays.
///
/// SABOTAGE: return `Ok(SenderCheck::Signed)` at the top of
/// `calp::submission_seal::check_submission` -- the 999 plant wins the slot.
#[test]
fn a_forged_answer_under_a_signed_id_never_reaches_the_inbox() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let form = publish_v1(&dir, prof.path(), &["CORP\\alice"]);
    let real = send_signed(&dir, "s-alice", "Alice", 2, 1.0, "2026-10-22T09:00:00Z");

    let mut plant = real.clone();
    plant.id = "s-plant".into();
    plant.updated_at = "2030-01-01T00:00:00Z".into();
    plant.value = SubmissionValue::Number { value: 999.0 };
    plant.seal = None;
    ws(&dir).save_submission(APP, V1, &plant).unwrap();

    let mut mallory = plant.clone();
    mallory.id = "s-mallory".into();
    let mut as_mallory = mallory.clone();
    as_mallory.submitter = signed_identity("Mallory");
    calp::submission_seal::seal_submission(&mut as_mallory, APP, V1, &seed_of("Mallory"), SubmissionOrigin::Interactive)
        .unwrap();
    mallory.seal = as_mallory.seal;
    ws(&dir).save_submission(APP, V1, &mallory).unwrap();

    let mut renamed = real.clone();
    renamed.id = "s-renamed".into();
    renamed.updated_at = "2030-01-02T00:00:00Z".into();
    renamed.submitter.principal_name = "CORP\\ceo".into();
    ws(&dir).save_submission(APP, V1, &renamed).unwrap();

    let state = author_workbook(&dir, form, &["CORP\\alice"]);
    with_test_profile(prof.path(), || {
        let inbox = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(inbox.len(), 1, "{:?}", inbox.iter().map(|r| &r.submission_id).collect::<Vec<_>>());
        assert_eq!(inbox[0].submission_id, "s-alice");
        assert_eq!(inbox[0].value_display, "1");
        assert_eq!(inbox[0].submitter_principal, "CORP\\alice");
    });
    // The refusals are listed by the fold, not lost.
    let fold = ws(&dir).load_submission_fold(APP, V1, &calp::ReviewAuthority::none()).unwrap();
    let mut forged: Vec<(String, calp::submission_seal::ForgeryReason)> =
        fold.forged.iter().map(|r| (r.event.id.clone(), r.reason)).collect();
    forged.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        forged,
        vec![
            ("s-mallory".to_string(), calp::submission_seal::ForgeryReason::KeyNotTheSenders),
            ("s-plant".to_string(), calp::submission_seal::ForgeryReason::Unsigned),
            ("s-renamed".to_string(), calp::submission_seal::ForgeryReason::BadSignature),
        ]
    );
}

/// THE REPLAYED EVENT: Alice's real answer copied into another version's
/// folder does not count there (each signature names its version).
#[test]
fn a_replayed_answer_does_not_count_in_another_version() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    publish_v1(&dir, prof.path(), &[]);
    let real = send_signed(&dir, "s-alice", "Alice", 2, 1.0, "2026-10-22T09:00:00Z");
    ws(&dir).save_submission(APP, "1.1.0", &real).unwrap();
    let fold = ws(&dir).load_submission_fold(APP, "1.1.0", &calp::ReviewAuthority::none()).unwrap();
    assert!(fold.current.is_empty());
    assert_eq!(fold.forged.len(), 1);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

fn reviews_on_disk(dir: &TempDir) -> Vec<ReviewEvent> {
    ws(dir).load_review_events(APP, V1).unwrap()
}

fn forged_review(target: &WritebackSubmission, id: &str, state: SubmissionState) -> ReviewEvent {
    ReviewEvent {
        id: id.to_string(),
        target_submission_id: target.id.clone(),
        region_id: target.region_id.clone(),
        submitter_id: target.submitter.id.clone(),
        new_state: state,
        review_reason: None,
        reviewed_by: Some("Publisher".to_string()),
        reviewed_at: "2026-10-22T12:00:00Z".to_string(),
        target_digest: calp::submission_seal::event_digest(APP, V1, target),
        seal: None,
        extra: HashMap::new(),
    }
}

/// THE FORGED REVIEW. The author's approve is SIGNED with this computer's
/// publisher key and counts; an unsigned approval written into `reviews/` by
/// anybody with write access, and one signed by a key that is not the
/// publisher's, are ignored by every read (owner decision 2026-10-22).
///
/// SABOTAGE: drop the `sign_review` call from `set_submission_state_core`
/// -- Alice's approval is then ignored too.
#[test]
fn approvals_are_signed_and_a_forged_approval_is_ignored() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let form = publish_v1(&dir, prof.path(), &[]);
    send_signed(&dir, "s-alice", "Alice", 2, 1.0, "2026-10-22T09:00:00Z");
    let bob = send_signed(&dir, "s-bob", "Bob", 3, 2.0, "2026-10-22T09:05:00Z");
    let state = author_workbook(&dir, form, &[]);
    let publisher_key = calp::signing::PublisherKeypair::load_existing(prof.path()).unwrap().unwrap().public_key_hex();

    with_test_profile(prof.path(), || {
        let inbox = load_region_submissions_core(&state, REGION).unwrap();
        let alice = row(&inbox, "Alice");
        set_submission_state_core(
            &state,
            REGION.to_string(),
            alice.submitter_id.clone(),
            alice.cell_row,
            alice.cell_col,
            "approved".to_string(),
            Some("ok".to_string()),
            Some(alice.submission_id.clone()),
            Some(alice.environment.clone()),
        )
        .expect("the author approves");
    });
    let written = reviews_on_disk(&dir);
    assert_eq!(written.len(), 1);
    let seal = written[0].seal.as_ref().expect("the decision is signed");
    assert_eq!(seal.public_key, publisher_key, "signed with the publisher's own key");
    assert!(!written[0].target_digest.is_empty(), "bound to the exact answer decided");

    // Anybody with write access to the share writes an unsigned approval of
    // Bob, and one signed by their own key.
    ws(&dir).save_review(APP, V1, &forged_review(&bob, "rev-unsigned", SubmissionState::Approved)).unwrap();
    let mut foreign = forged_review(&bob, "rev-foreign", SubmissionState::Approved);
    calp::submission_seal::seal_review(
        &mut foreign,
        &bob,
        APP,
        V1,
        &calp::signing::PublisherKeypair::from_seed(&seed_of("Mallory"), "Mallory"),
    );
    ws(&dir).save_review(APP, V1, &foreign).unwrap();

    with_test_profile(prof.path(), || {
        let inbox = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(row(&inbox, "Alice").state, "approved");
        assert_eq!(row(&inbox, "Alice").review_reason.as_deref(), Some("ok"));
        assert_eq!(row(&inbox, "Bob").state, "submitted", "no forged decision applied");
    });
}

/// A CO-PUBLISHER's decision counts for every reader exactly when the root
/// publisher's signed list names their key -- the same set the reviewer's own
/// gate (`require_publisher_key`) accepts, through `calp::publishers::review_keys`.
///
/// SABOTAGE: make `review_keys` return only the verified key (skip the list).
#[test]
fn a_co_publishers_signed_decision_counts_only_while_the_list_names_them() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let form = publish_v1(&dir, prof.path(), &[]);
    let bob = send_signed(&dir, "s-bob", "Bob", 3, 2.0, "2026-10-22T09:05:00Z");
    let co = calp::signing::PublisherKeypair::from_seed(&seed_of("Co-publisher"), "Co");
    let mut decision = forged_review(&bob, "rev-co", SubmissionState::Approved);
    calp::submission_seal::seal_review(&mut decision, &bob, APP, V1, &co);
    ws(&dir).save_review(APP, V1, &decision).unwrap();
    let state = author_workbook(&dir, form, &[]);

    with_test_profile(prof.path(), || {
        let inbox = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(row(&inbox, "Bob").state, "submitted", "not yet a co-publisher");
    });

    let root = calp::signing::PublisherKeypair::load_existing(prof.path()).unwrap().unwrap();
    let mut list = calp::publishers::PublisherList::new(APP, &root.public_key_hex(), "2026-10-22T10:00:00Z");
    list.authorized_keys.push(calp::publishers::AuthorizedKey {
        key: co.public_key_hex(),
        name: "Co".to_string(),
        added_at: "2026-10-22T10:00:00Z".to_string(),
    });
    calp::publishers::write_signed(&ws(&dir), &list, &root).unwrap();

    with_test_profile(prof.path(), || {
        let inbox = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(row(&inbox, "Bob").state, "approved", "the co-publisher's signed decision counts");
    });
}

// ---------------------------------------------------------------------------
// Mine
// ---------------------------------------------------------------------------

/// What seeds a subscriber's cells as "what you last sent": ONLY records under
/// this computer's id that this computer's key signed. A record planted in my
/// folder (unsigned) and one signed by another key under my id are never mine
/// (open-items 2.am).
///
/// SABOTAGE: drop the `is_mine` filter from `own_records_by_region_in` AND make
/// the fold keep forged events -- the plant is adopted. (Either guard alone
/// holds: the fold refuses the plant, and `is_mine` refuses anything unsigned.)
#[test]
fn only_what_my_key_signed_is_mine() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    publish_v1(&dir, prof.path(), &[]);
    with_test_profile(prof.path(), || {
        let me = crate::submitter_identity::current_identity().unwrap();
        let mut real = answer("s-me", me.clone(), 2, 5.0, "2026-10-22T09:00:00Z");
        crate::submitter_identity::seal_outgoing(&mut real, APP, V1, SubmissionOrigin::Interactive).unwrap();
        ws(&dir).save_submission(APP, V1, &real).unwrap();
        let mut plant = real.clone();
        plant.id = "s-plant".into();
        plant.cell_row = 3;
        plant.updated_at = "2030-01-01T00:00:00Z".into();
        plant.seal = None;
        ws(&dir).save_submission(APP, V1, &plant).unwrap();

        let registry = ws(&dir);
        let (by_region, unread) = own_records_by_region_in(
            &registry,
            APP,
            &[V1.to_string()],
            "",
            &me,
            &calp::ReviewAuthority::none(),
        );
        assert!(unread.is_empty());
        let mine = by_region.get(REGION).expect("my region");
        assert_eq!(mine.len(), 1, "{:?}", mine.keys().collect::<Vec<_>>());
        assert_eq!(mine[&(2, 1)].id, "s-me");
        assert_eq!(mine[&(2, 1)].sender, SenderCheck::Signed);
    });
}

/// A draft typed before sign-in (an old-format id) is refused at Submit with a
/// way out -- never re-stamped to the current identity, which would let a
/// crafted workbook seed answers signed as whoever presses Submit All.
#[test]
fn a_draft_typed_before_sign_in_is_refused_never_restamped() {
    let me = signed_identity("Alice");
    let mut legacy = answer("d-1", calp::SubmitterIdentity {
        display_name: "Salle".into(),
        id: "01a087b6-3308-79f7-8002-aa29c40418ce".into(),
        ..Default::default()
    }, 2, 1.0, "2026-10-22T09:00:00Z");
    legacy.state = SubmissionState::Draft;
    let refusal = foreign_draft_refusal(&me, std::slice::from_ref(&legacy)).expect("refused");
    assert!(refusal.contains("typed before Calcula signed your answers"), "{refusal}");
    assert!(refusal.contains("Discard Drafts"), "{refusal}");

    let other = answer("d-2", signed_identity("Bob"), 2, 1.0, "2026-10-22T09:00:00Z");
    let refusal = foreign_draft_refusal(&me, std::slice::from_ref(&other)).expect("refused");
    // In words, with the way out -- never the two raw `win-S-1-5-21-...` ids.
    assert!(refusal.contains("on another computer"), "{refusal}");
    assert!(refusal.contains(&other.submitter.principal_name), "{refusal}");
    assert!(refusal.contains("Discard Drafts"), "{refusal}");
    assert!(!refusal.contains(&other.submitter.id) && !refusal.contains(&me.id), "{refusal}");

    let mine = answer("d-3", me.clone(), 2, 1.0, "2026-10-22T09:00:00Z");
    assert!(foreign_draft_refusal(&me, std::slice::from_ref(&mine)).is_none());
}

// ---------------------------------------------------------------------------
// Determinism across machines
// ---------------------------------------------------------------------------

/// TWO COMPUTERS, ONE FOLD. The author's computer (no pin: the co-publisher
/// list is checked against the first version) and a subscriber's computer
/// (which PINNED the publisher) derive the same review authority from what
/// they each trust, and fold the same files -- forged answers, a forged
/// decision and a co-publisher's decision among them -- to the same records.
/// What differs between the readers (pins, profile keys) changes nothing.
#[test]
fn two_computers_fold_the_same_files_identically() {
    let dir = TempDir::new().unwrap();
    let author = TempDir::new().unwrap();
    let subscriber = TempDir::new().unwrap();
    publish_v1(&dir, author.path(), &[]);
    let alice = send_signed(&dir, "s-alice", "Alice", 2, 1.0, "2026-10-22T09:00:00Z");
    let bob = send_signed(&dir, "s-bob", "Bob", 3, 2.0, "2026-10-22T09:05:00Z");
    let mut plant = alice.clone();
    plant.id = "s-plant".into();
    plant.updated_at = "2030-01-01T00:00:00Z".into();
    plant.seal = None;
    ws(&dir).save_submission(APP, V1, &plant).unwrap();
    let root = calp::signing::PublisherKeypair::load_existing(author.path()).unwrap().unwrap();
    let co = calp::signing::PublisherKeypair::from_seed(&seed_of("Co-publisher"), "Co");
    let mut list = calp::publishers::PublisherList::new(APP, &root.public_key_hex(), "2026-10-22T10:00:00Z");
    list.authorized_keys.push(calp::publishers::AuthorizedKey {
        key: co.public_key_hex(),
        name: "Co".to_string(),
        added_at: "2026-10-22T10:00:00Z".to_string(),
    });
    calp::publishers::write_signed(&ws(&dir), &list, &root).unwrap();
    let mut by_root = forged_review(&alice, "rev-root", SubmissionState::Approved);
    calp::submission_seal::seal_review(&mut by_root, &alice, APP, V1, &root);
    let mut by_co = forged_review(&bob, "rev-co", SubmissionState::Rejected);
    calp::submission_seal::seal_review(&mut by_co, &bob, APP, V1, &co);
    let unsigned = forged_review(&bob, "rev-unsigned", SubmissionState::Approved);
    for r in [&by_root, &by_co, &unsigned] {
        ws(&dir).save_review(APP, V1, r).unwrap();
    }

    // The subscriber computer pins the publisher by subscribing.
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    calp::pull::pull(
        &ws(&dir),
        &calp::pull::PullRequest {
            package_name: APP.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(calp::version::VersionPin::Exact(SemVer::new(1, 0, 0))),
            now: "2026-10-22T11:00:00Z".to_string(),
        },
        &scope,
        subscriber.path(),
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .unwrap();

    let key = root.public_key_hex();
    let on_author = with_test_profile(author.path(), || review_authority(&ws(&dir), APP, &key, None));
    let on_subscriber = with_test_profile(subscriber.path(), || review_authority(&ws(&dir), APP, &key, Some(&scope)));
    assert_eq!(on_author, on_subscriber, "both computers trust the same reviewers");

    let summary = |authority: &calp::ReviewAuthority| {
        ws(&dir)
            .load_current_submissions(APP, V1, authority)
            .unwrap()
            .into_iter()
            .map(|s| (s.id, s.submitter.id, s.state, s.sender))
            .collect::<Vec<_>>()
    };
    let a = summary(&on_author);
    let b = summary(&on_subscriber);
    assert_eq!(a, b);
    assert_eq!(
        a.iter().map(|(id, _, state, _)| (id.as_str(), state.clone())).collect::<Vec<_>>(),
        vec![("s-alice", SubmissionState::Approved), ("s-bob", SubmissionState::Rejected)]
    );
}

/// A PLANTED FIRST VERSION cannot buy a review authority. A share-writer adds a
/// `0.0.1` naming their own key to the unsigned version list and signs their
/// own co-publisher list under it (the attack docs/design/calp-workspace-
/// collaboration.md §2.5 describes). Read through the WORKSPACE's idea of the
/// root, their key would count as a reviewer; read through what THIS computer
/// trusts -- the pin a subscriber holds, the developer anchor an author holds --
/// it does not.
///
/// SABOTAGE: make `review_authority` ignore the pin and the anchor (pass
/// `None` as the trusted root) -- the planter's key is admitted.
#[test]
fn a_planted_first_version_cannot_buy_a_review_authority() {
    let dir = TempDir::new().unwrap();
    let author = TempDir::new().unwrap();
    let subscriber = TempDir::new().unwrap();
    publish_v1(&dir, author.path(), &[]);
    let real = calp::signing::PublisherKeypair::load_existing(author.path()).unwrap().unwrap().public_key_hex();
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    // The subscriber pins the real publisher.
    calp::pull::pull(
        &ws(&dir),
        &calp::pull::PullRequest {
            package_name: APP.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(calp::version::VersionPin::Exact(SemVer::new(1, 0, 0))),
            now: "2026-10-22T11:00:00Z".to_string(),
        },
        &scope,
        subscriber.path(),
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .unwrap();
    // The author's computer remembers the application's creator (the developer anchor).
    calp::developer_anchor::anchor_root(
        &calp::AnchorGate {
            profile_dir: author.path(),
            scope: &scope,
            policy: calp::AnchorPolicy::RecordOnFirstContact { via: calp::AnchoredBy::Publish },
        },
        APP,
        &calp::publishers::root_anchored_publishers(&ws(&dir), APP).unwrap(),
    )
    .unwrap();

    // THE PLANT.
    let mallory = calp::signing::PublisherKeypair::from_seed(&seed_of("Mallory"), "Mallory");
    let reg = ws(&dir);
    let mut listing = reg.get_application_manifest(APP).unwrap();
    let mut entry = listing.versions[0].clone();
    entry.version = "0.0.1".to_string();
    listing.versions.insert(0, entry);
    reg.write_application_manifest(&listing).unwrap();
    let mut planted = reg.get_version_manifest(APP, V1).unwrap();
    planted.version = "0.0.1".to_string();
    planted.publisher_key = mallory.public_key_hex();
    reg.write_version_manifest(APP, "0.0.1", &planted).unwrap();
    // A real planter SIGNS the plant with their own key (`root_key_of` now
    // verifies the first manifest, so an unsigned edit would not even be read).
    let planted_bytes = std::fs::read(dir.path().join(APP).join("0.0.1").join(calp::integrity::VERSION_MANIFEST_FILE)).unwrap();
    reg.write_artifact(APP, "0.0.1", calp::integrity::VERSION_MANIFEST_SIG_FILE, mallory.sign(&planted_bytes).as_bytes())
        .unwrap();
    let list = calp::publishers::PublisherList::new(APP, &mallory.public_key_hex(), "2026-10-22T12:00:00Z");
    calp::publishers::write_signed(&reg, &list, &mallory).unwrap();
    // The plant took: the workspace now names Mallory as the root.
    assert_eq!(calp::publishers::root_key_of(&reg, APP).unwrap().as_deref(), Some(mallory.public_key_hex().as_str()));
    // Read through the workspace's root, Mallory would review.
    assert!(crate::calp_commands::review_authority_rooted(&reg, APP, &real, None).admits_key(&mallory.public_key_hex()));

    let on_subscriber = with_test_profile(subscriber.path(), || review_authority(&reg, APP, &real, Some(&scope)));
    let on_author = with_test_profile(author.path(), || review_authority(&reg, APP, &real, Some(&scope)));
    for (who, authority) in [("subscriber (pin)", &on_subscriber), ("author (anchor)", &on_author)] {
        assert!(!authority.admits_key(&mallory.public_key_hex()), "{who} admits the planter");
        assert!(authority.admits_key(&real), "{who} lost the real publisher");
    }
}

/// THE GATE ROOTS WHERE THE READERS ROOT. A planter who already PINNED the real
/// publisher (they subscribed) plants a `0.0.1` signed with their own key and a
/// co-publisher list they signed under it. Read through the workspace's first
/// version, their profile would pass the publisher gate -- see the inbox, sign
/// reviews nobody counts. Rooted at this computer's pin, as every reader is,
/// it is refused; and an edited (unsigned) first manifest is never a root.
///
/// SABOTAGE: pass `None` as the trusted root in `require_publisher_key`.
#[test]
fn a_planted_first_version_does_not_pass_the_publisher_gate() {
    let dir = TempDir::new().unwrap();
    let author = TempDir::new().unwrap();
    let planter = TempDir::new().unwrap();
    publish_v1(&dir, author.path(), &[]);
    let real = calp::signing::PublisherKeypair::load_existing(author.path()).unwrap().unwrap().public_key_hex();
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    // The planter subscribed first: their computer pinned the real publisher.
    calp::pull::pull(
        &ws(&dir),
        &calp::pull::PullRequest {
            package_name: APP.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(calp::version::VersionPin::Exact(SemVer::new(1, 0, 0))),
            now: "2026-10-22T11:00:00Z".to_string(),
        },
        &scope,
        planter.path(),
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .unwrap();
    let mallory = calp::signing::PublisherKeypair::load_or_create(planter.path()).unwrap();
    let reg = ws(&dir);
    let mut listing = reg.get_application_manifest(APP).unwrap();
    let mut entry = listing.versions[0].clone();
    entry.version = "0.0.1".to_string();
    listing.versions.insert(0, entry);
    reg.write_application_manifest(&listing).unwrap();
    let mut planted = reg.get_version_manifest(APP, V1).unwrap();
    planted.version = "0.0.1".to_string();
    planted.publisher_key = mallory.public_key_hex();
    reg.write_version_manifest(APP, "0.0.1", &planted).unwrap();
    let manifest_path = dir.path().join(APP).join("0.0.1").join(calp::integrity::VERSION_MANIFEST_FILE);
    let planted_bytes = std::fs::read(&manifest_path).unwrap();
    reg.write_artifact(APP, "0.0.1", calp::integrity::VERSION_MANIFEST_SIG_FILE, mallory.sign(&planted_bytes).as_bytes())
        .unwrap();
    let list = calp::publishers::PublisherList::new(APP, &mallory.public_key_hex(), "2026-10-22T12:00:00Z");
    calp::publishers::write_signed(&reg, &list, &mallory).unwrap();

    with_test_profile(planter.path(), || {
        // Through the workspace's first version (no scope), the plant works...
        assert!(crate::calp_commands::require_publisher_key(&reg, APP, &real, None).is_ok());
        // ...rooted at this computer's pin, as every reader is, it does not
        // (the planter's list does not verify against the pinned root).
        assert!(crate::calp_commands::require_publisher_key(&reg, APP, &real, Some(&scope)).is_err());
    });

    // An EDITED first manifest (the key swapped, not re-signed) is no root at all.
    let mut edited = planted.clone();
    edited.publisher_key = "ab".repeat(32);
    reg.write_version_manifest(APP, "0.0.1", &edited).unwrap();
    assert!(calp::publishers::root_key_of(&reg, APP).is_err(), "an unverified first manifest named a root");
}

/// REVIEW AUTHORITY REFUSES A ROLLED-BACK CO-PUBLISHER LIST on the author's
/// computer: once its developer anchor has seen revision 3, a restored
/// revision-2 list -- still validly root-signed, still naming a removed
/// co-publisher -- leaves only the verified key, so the removed co-publisher's
/// signed decisions stop counting again.
///
/// SABOTAGE: pass `None` as `min_revision` from `trusted_review_root`'s anchor arm.
#[test]
fn a_rolled_back_co_publisher_list_buys_no_review_authority() {
    let dir = TempDir::new().unwrap();
    let author = TempDir::new().unwrap();
    publish_v1(&dir, author.path(), &[]);
    let root = calp::signing::PublisherKeypair::load_existing(author.path()).unwrap().unwrap();
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    let removed = calp::signing::PublisherKeypair::from_seed(&seed_of("Removed"), "Removed").public_key_hex();
    let reg = ws(&dir);
    let mut old = calp::publishers::PublisherList::new(APP, &root.public_key_hex(), "2026-10-22T12:00:00Z");
    old.revision = 2;
    old.authorized_keys.push(calp::publishers::AuthorizedKey {
        key: removed.clone(),
        name: "Removed".to_string(),
        added_at: "2026-10-22T12:00:00Z".to_string(),
    });
    let mut current = old.clone();
    current.revision = 3;
    current.authorized_keys.clear();
    calp::publishers::write_signed(&reg, &current, &root).unwrap();
    // The author's computer anchors the root and sees revision 3.
    calp::developer_anchor::anchor_root(
        &calp::AnchorGate {
            profile_dir: author.path(),
            scope: &scope,
            policy: calp::AnchorPolicy::RecordOnFirstContact { via: calp::AnchoredBy::Publish },
        },
        APP,
        &calp::publishers::root_anchored_publishers(&reg, APP).unwrap(),
    )
    .unwrap();
    // A share-writer restores revision 2.
    calp::publishers::write_signed(&reg, &old, &root).unwrap();
    let on_author = with_test_profile(author.path(), || review_authority(&reg, APP, &root.public_key_hex(), Some(&scope)));
    assert!(!on_author.admits_key(&removed), "the rolled-back list re-authorised a removed co-publisher");
    assert!(on_author.admits_key(&root.public_key_hex()));
}

// ---------------------------------------------------------------------------
// The application's minimum app version, and the doors
// ---------------------------------------------------------------------------

/// An application with writeback regions names this app as its minimum: an
/// older app would send unsigned answers and write unsigned decisions that
/// every current reader ignores, while telling its user "sent" / "approved" --
/// a lie, not a loss. One without regions stays pullable by older apps.
///
/// SABOTAGE: drop the writeback clause from `stamp_min_app_version`.
#[test]
fn an_application_that_collects_answers_names_this_app_as_its_minimum() {
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Form".to_string())];
    let form = wb.sheets[0].id;
    let make = |regions: Option<Vec<calp::WritebackRegionDeclaration>>| PublishRequest {
        workbook: &wb,
        package_name: APP.to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: String::new(),
        sheet_indices: vec![0],
        now: String::new(),
        published_by: String::new(),
        writeback_regions: regions,
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
    let mut with = make(Some(vec![region_on(form, &[])]));
    stamp_min_app_version(&mut with);
    assert_eq!(with.min_app_version, env!("CARGO_PKG_VERSION"));
    let mut without = make(None);
    stamp_min_app_version(&mut without);
    assert!(without.min_app_version.is_empty());
    let mut empty = make(Some(Vec::new()));
    stamp_min_app_version(&mut empty);
    assert!(empty.min_app_version.is_empty());
}

fn source(file: &str) -> String {
    std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(file)).unwrap()
}

fn body<'a>(text: &'a str, start: &str) -> &'a str {
    until(text, start, "\n}\n")
}

/// From `start` to the first `end` after it.
fn until<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let at = text.find(start).unwrap_or_else(|| panic!("no {start}"));
    let rest = &text[at..];
    let stop = rest.find(end).unwrap_or(rest.len());
    &rest[..stop]
}

/// Every answer is SIGNED before anything is written, at the one point it
/// leaves the machine -- grid and model alike -- and each door names its own
/// origin: the user's Submit is Interactive, an `immediate` region's save is
/// Immediate, and the script gateway's submit and save are Script.
///
/// SABOTAGE: pass `Interactive` from the gateway's SubmitRegion arm.
#[test]
fn every_answer_is_signed_and_every_door_names_its_origin() {
    let cmds = source("calp_commands.rs");
    let submit = body(&cmds, "fn submit_region_internal(");
    let seal_at = submit.find("seal_outgoing(").expect("the grid submit signs");
    let save_at = submit.find("save_submission(").expect("the grid submit writes");
    assert!(seal_at < save_at, "every answer is signed before any is written");
    let model = body(&cmds, "pub(crate) fn submit_model_writeback(");
    assert!(
        model.find("seal_outgoing(").unwrap() < model.find("save_submission(").unwrap(),
        "the model submit signs before writing"
    );
    let interactive = body(&cmds, "pub fn calp_submit_region(");
    assert!(interactive.contains("calp::SubmissionOrigin::Interactive"));
    let typed = body(&cmds, "pub fn calp_save_writeback_draft(");
    assert!(typed.contains("calp::SubmissionOrigin::Immediate"));

    let gateway = source("scripting/writeback_gateway.rs");
    let submit_arm = until(&gateway, "Action::SubmitRegion => {", "\n        }\n");
    assert!(submit_arm.contains("calp::SubmissionOrigin::Script"), "{submit_arm}");
    let save_arm = until(&gateway, "Action::SaveDraft => {", "\n        }\n");
    assert!(save_arm.contains("calp::SubmissionOrigin::Script"), "{save_arm}");
    // A script's setCellValue into a claimed cell (the cellGuard door) is a
    // script's write too: an `immediate` region sends it signed as Script,
    // never through the typed-by-the-user command.
    let guard_arm = until(&gateway, "Action::CellGuard => {", "\n        }\n");
    assert!(guard_arm.contains("calp::SubmissionOrigin::Script"), "{guard_arm}");
    assert!(!guard_arm.contains("calp_save_writeback_draft("), "{guard_arm}");
    // A script's review decision says so, inside its signature.
    let review_arm = until(&gateway, "Action::SetSubmissionState => {", "\n        }\n");
    assert_eq!(review_arm.matches("calp::SubmissionOrigin::Script").count(), 2, "{review_arm}");
    assert!(!review_arm.contains("calp_set_submission_state(") && !review_arm.contains("calp_set_model_submission_state("));
    // Every review is signed before it is written, with the origin it was given.
    for start in ["pub(crate) fn set_model_submission_state_with_origin(", "pub(crate) fn set_submission_state_with_origin("] {
        let b = body(&cmds, start);
        assert!(b.find("sign_review(").unwrap() < b.find("save_review(").unwrap(), "{start}");
        assert!(b.contains(", origin)?;"), "{start} signs with its origin");
    }
}
