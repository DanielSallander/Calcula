//! FILENAME: app/src-tauri/src/identity_surface_tests.rs
//! PURPOSE: Identity phase 1, READ side (owner decisions 2026-10-22): every
//!          answer carries the reader's verdict -- Verified / signed but not
//!          confirmed / not verified / sent before sign-in -- and an
//!          application's "count only verified senders" rule is enforced in
//!          Rust wherever answers are COUNTED: the respondent roster, GATHER
//!          totals, the BI tables and what scripts read. The inbox and the
//!          exports SHOW the rest, marked not counted.
//! CONTEXT: Real signed publishes to temp workspaces, answers written where a
//!          submit writes them. Who WROTE each file is decided by
//!          `identity_verification::test_override` (a network share with a
//!          chosen owner per file), except in the tests marked REAL OS, which
//!          ask Windows. Nothing here touches the owner's C:\writeback-test.

use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::version::SemVer;
use calp::writeback::{SubmissionState, SubmissionValue, WritebackSubmission};
use calp::{IdentityPolicy, IdentityReason, IdentityStatus, StorageKind, SubmissionOrigin};
use persistence::{Sheet, Workbook};

use crate::calp_commands::{
    export_region_submissions_csv_core, load_region_current_submissions, load_region_submissions_core,
    region_response_status_core,
};
use crate::document_effect::test_seed_effect;
use crate::identity_verification::test_override;
use crate::profile_dir::with_test_profile;
use crate::AppState;

const APP: &str = "identity-surface";
const REGION: &str = "01a15d70-0000-7000-8000-0000000000c3";
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

fn publish_v1(dir: &TempDir, prof: &Path, expected: &[&str], require_verified: bool) -> identity::SheetId {
    publish_v1_with(dir, prof, expected, require_verified, "")
}

/// [`publish_v1`] with a minimum app version -- what the app stamps on every
/// application with writeback regions (`stamp_min_app_version`), and so what
/// marks a version whose answers are all signed (`signed_answers`).
fn publish_v1_with(
    dir: &TempDir,
    prof: &Path,
    expected: &[&str],
    require_verified: bool,
    min_app_version: &str,
) -> identity::SheetId {
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
        identity_policy: require_verified.then_some(IdentityPolicy { require_verified: true }),
        min_app_version: min_app_version.to_string(),
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

fn seed_of(who: &str) -> [u8; 32] {
    let hex = calp::integrity::sha256_hex(who.as_bytes());
    let mut seed = [0u8; 32];
    for (i, pair) in hex.as_bytes().chunks(2).enumerate() {
        seed[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
    }
    seed
}

/// The domain SID each fixture person's account has.
fn sid_of(who: &str) -> String {
    format!("S-1-5-21-7-7-7-{}", 1000 + who.len() * 7 + who.as_bytes()[0] as usize)
}

/// A signed Windows identity: `CORP\who` (domain), claiming `claimed_sid`, bound
/// to `key_holder`'s key.
fn identity_claiming(who: &str, claimed_sid: &str, key_holder: &str) -> calp::SubmitterIdentity {
    calp::identity_provider::identity_for(
        calp::IdentityProviderKind::Windows,
        &calp::identity_provider::AccountFacts {
            subject: claimed_sid.to_string(),
            principal_name: format!("CORP\\{}", who.to_lowercase()),
            display_name: who.to_string(),
            scope: calp::AccountScope::Domain,
        },
        &calp::submission_seal::public_key_of_seed(&seed_of(key_holder)),
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

/// `key_holder` signs an answer that names `who` / `claimed_sid` and files it.
fn send(dir: &TempDir, id: &str, who: &str, claimed_sid: &str, key_holder: &str, row: u32, value: f64) {
    let mut s = answer(id, identity_claiming(who, claimed_sid, key_holder), row, value, "2026-10-22T09:00:00Z");
    calp::submission_seal::seal_submission(&mut s, APP, V1, &seed_of(key_holder), SubmissionOrigin::Interactive)
        .unwrap();
    ws(dir).save_submission(APP, V1, &s).unwrap();
}

fn send_before_sign_in(dir: &TempDir, id: &str, who: &str, row: u32, value: f64) {
    let legacy = calp::SubmitterIdentity {
        display_name: who.to_string(),
        id: format!("01a087b6-3308-79f7-8002-{:012x}", who.len()),
        ..Default::default()
    };
    ws(dir).save_submission(APP, V1, &answer(id, legacy, row, value, "2026-10-22T08:00:00Z")).unwrap();
}

/// A network share where Windows recorded `writers` (folder SID -> the account
/// that really wrote the file): the owner of each answer file is looked up by
/// the SID in its sender folder's name.
fn share_where(writers: &[(&str, &str, &str)]) -> Rc<dyn Fn(&Path) -> Result<(String, String), String>> {
    let writers: Vec<(String, String, String)> =
        writers.iter().map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string())).collect();
    Rc::new(move |path: &Path| {
        let text = path.to_string_lossy().to_string();
        for (folder_sid, owner_sid, owner_name) in &writers {
            if text.contains(&format!("win-{folder_sid}-")) {
                return Ok((owner_sid.clone(), owner_name.clone()));
            }
        }
        Err(format!("no owner for {text}"))
    })
}

/// Alice answers from her own account; BOB signs with his own key an answer
/// that CLAIMS Alice's account (a valid signature under a different id) and
/// writes it himself; Carol answered before sign-in.
fn the_three_senders(dir: &TempDir) -> Rc<dyn Fn(&Path) -> Result<(String, String), String>> {
    let alice = sid_of("Alice");
    let bob = sid_of("Bob");
    send(dir, "s-alice", "Alice", &alice, "Alice", 2, 10.0);
    send(dir, "s-bob-as-alice", "Alice", &alice, "Bob", 3, 500.0);
    send_before_sign_in(dir, "s-carol", "Carol", 4, 7.0);
    // Alice's folder and Bob's forged folder BOTH name Alice's SID; the share
    // knows who wrote each file. The forged id's folder ends in Bob's key
    // commitment, so tell them apart by the full folder name.
    let alice_id = identity_claiming("Alice", &alice, "Alice").id;
    let forged_id = identity_claiming("Alice", &alice, "Bob").id;
    Rc::new(move |path: &Path| {
        let text = path.to_string_lossy().to_string();
        if text.contains(&forged_id) {
            Ok((bob.clone(), "CORP\\bob".to_string()))
        } else if text.contains(&alice_id) {
            Ok((alice.clone(), "CORP\\alice".to_string()))
        } else {
            Err(format!("no owner for {text}"))
        }
    })
}

fn by_value(rows: &[crate::calp_commands::RegionSubmissionInfo], value: &str) -> crate::calp_commands::RegionSubmissionInfo {
    rows.iter()
        .find(|r| r.value_display == value)
        .cloned()
        .unwrap_or_else(|| panic!("no row with value {value}"))
}

// ---------------------------------------------------------------------------
// The publisher's surfaces
// ---------------------------------------------------------------------------

/// THE OWNER'S RULE ON, on a share where Windows records each file's writer:
///
/// * the inbox shows all three answers, each labelled -- Alice "Verified",
///   Bob's answer in Alice's name "Not verified: written by CORP\bob", Carol
///   "Sent before sign-in" -- and only Alice's is counted;
/// * the roster counts only Alice, NAMES the senders it does not count, and an
///   expected respondent matched only by an uncounted answer stays missing;
/// * the exports carry the identity and whether it counts;
/// * every counting reader (`load_region_current_submissions`: the scripts'
///   and the author BI tables' rows) holds only Alice's.
///
/// SABOTAGE: make `IdentityPolicy::counts` return `true` -- Bob's 500 is
/// counted and the roster names nobody as not counted.
#[test]
fn under_the_rule_only_verified_answers_count_and_the_rest_are_shown_labelled() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let expected = ["CORP\\alice", "CORP\\carol"];
    let form = publish_v1(&dir, prof.path(), &expected, true);
    let owners = the_three_senders(&dir);
    let state = author_workbook(&dir, form, &expected);

    test_override::with(StorageKind::NetworkShare, Some(owners), || {
        with_test_profile(prof.path(), || {
            let inbox = load_region_submissions_core(&state, REGION).unwrap();
            assert_eq!(inbox.len(), 3, "the inbox SHOWS every answer");
            let alice = by_value(&inbox, "10");
            assert_eq!(alice.identity.status, IdentityStatus::Verified);
            assert!(alice.counted);
            assert!(alice.identity_label.starts_with("Verified"), "{}", alice.identity_label);
            let bob = by_value(&inbox, "500");
            assert_eq!(bob.identity.status, IdentityStatus::NotVerified);
            assert_eq!(bob.identity.reason, IdentityReason::OwnerMismatch);
            assert_eq!(bob.identity_label, "Not verified: written by CORP\\bob");
            assert!(!bob.counted);
            let carol = by_value(&inbox, "7");
            assert_eq!(carol.identity.status, IdentityStatus::BeforeSignIn);
            assert!(!carol.counted, "never counted where verification is required (owner)");
            // The IPC shape.
            let json = serde_json::to_value(&bob).unwrap();
            assert_eq!(json["identity"]["status"], "notVerified");
            assert_eq!(json["identity"]["writtenBy"], "CORP\\bob");
            assert_eq!(json["counted"], false);
            assert!(json.get("identityLabel").is_some());

            let status = region_response_status_core(&state, REGION).unwrap();
            assert!(status.require_verified);
            assert_eq!(status.responded, vec!["Alice".to_string()]);
            assert_eq!(status.missing, vec!["CORP\\carol".to_string()]);
            // Bob's answer in Alice's name is listed as what it is -- never as
            // "Alice", which would have been dropped as "responded anyway".
            assert_eq!(
                status.not_counted,
                vec!["Alice (written by CORP\\bob)".to_string(), "Carol".to_string()]
            );

            let csv = export_region_submissions_csv_core(&state, REGION).unwrap();
            let header = csv.lines().next().unwrap();
            assert!(header.ends_with(",identity,writtenBy,counted"), "{header}");
            let bob_line = csv.lines().find(|l| l.contains(",500,")).unwrap();
            assert!(bob_line.contains("Not verified: written by CORP\\bob") && bob_line.ends_with(",no"), "{bob_line}");
            let alice_line = csv.lines().find(|l| l.contains(",10,")).unwrap();
            assert!(alice_line.ends_with(",yes"), "{alice_line}");

            let (collection, registry) = crate::calp_collection::publisher_collection(&state, REGION).unwrap();
            assert!(collection.identity_policy.require_verified, "the rule comes from the verified manifest");
            let counted = load_region_current_submissions(&collection, registry.as_ref(), REGION, &collection.streams)
                .unwrap();
            let values: Vec<String> = counted.iter().map(|s| format!("{:?}", s.value)).collect();
            assert_eq!(counted.len(), 1, "{values:?}");
            assert_eq!(counted[0].id, "s-alice");

            // The author's BI table counts exactly that.
            let ds = crate::bi::writeback_source::collect_writeback_datasets(&state);
            assert_eq!(ds.len(), 1);
            let ids: Vec<&str> = ds[0].rows.iter().map(|s| s.id.as_str()).collect();
            assert_eq!(ids, vec!["s-alice"]);
        });
    });
}

/// THE DEFAULT (owner: off for Windows applications): every answer counts and
/// every answer is still labelled.
#[test]
fn without_the_rule_every_answer_counts_and_is_labelled() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let expected = ["CORP\\alice"];
    let form = publish_v1(&dir, prof.path(), &expected, false);
    let owners = the_three_senders(&dir);
    let state = author_workbook(&dir, form, &expected);

    test_override::with(StorageKind::NetworkShare, Some(owners), || {
        with_test_profile(prof.path(), || {
            let inbox = load_region_submissions_core(&state, REGION).unwrap();
            assert!(inbox.iter().all(|r| r.counted), "every answer counts");
            assert_eq!(by_value(&inbox, "500").identity.status, IdentityStatus::NotVerified, "still labelled");
            let status = region_response_status_core(&state, REGION).unwrap();
            assert!(!status.require_verified);
            assert!(status.not_counted.is_empty());
            assert_eq!(
                status.responded,
                vec!["Alice".to_string(), "Alice (written by CORP\\bob)".to_string(), "Carol".to_string()]
            );
        });
    });
}

/// BUG-0562's ROSTER HALF, WITH THE RULE OFF (the owner's default): an answer
/// Windows proves someone else wrote never makes the person it NAMES
/// "responded". Only Bob's answer in Alice's name exists; Alice is still
/// awaited, and the list says who really wrote it.
///
/// SABOTAGE: build the roster's identity with `s.submitter.clone()` instead of
/// `calp::identity_check::matching_identity(&s)` -- Alice reads as responded.
#[test]
fn the_roster_never_matches_a_refuted_name_even_without_the_rule() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let expected = ["CORP\\alice"];
    let form = publish_v1(&dir, prof.path(), &expected, false);
    let alice = sid_of("Alice");
    let bob = sid_of("Bob");
    send(&dir, "s-bob-as-alice", "Alice", &alice, "Bob", 3, 500.0);
    let forged_id = identity_claiming("Alice", &alice, "Bob").id;
    let owners: Rc<dyn Fn(&Path) -> Result<(String, String), String>> = Rc::new(move |p: &Path| {
        if p.to_string_lossy().contains(&forged_id) {
            Ok((bob.clone(), "CORP\\bob".to_string()))
        } else {
            Err("no owner".to_string())
        }
    });
    let state = author_workbook(&dir, form, &expected);
    test_override::with(StorageKind::NetworkShare, Some(owners), || {
        with_test_profile(prof.path(), || {
            let status = region_response_status_core(&state, REGION).unwrap();
            assert_eq!(status.missing, vec!["CORP\\alice".to_string()], "{:?}", status.responded);
            assert_eq!(status.responded, vec!["Alice (written by CORP\\bob)".to_string()]);
        });
    });
}

/// THE MOVED FILE, end to end: on a share where other accounts may change each
/// answer's file (the common inherited Modify right), even Alice's own answer
/// -- owned by her account -- is only "signed, identity not confirmed", and the
/// rule counts nothing. An owner match proves the writer only on a file nobody
/// else can change.
///
/// SABOTAGE: report `others_can_change: false` from `cached_owner`'s test
/// branch -- Alice reads Verified.
#[test]
fn on_a_share_where_others_can_change_the_files_nothing_is_verified() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let form = publish_v1(&dir, prof.path(), &["CORP\\alice"], true);
    let owners = the_three_senders(&dir);
    let state = author_workbook(&dir, form, &["CORP\\alice"]);
    test_override::with(StorageKind::NetworkShare, Some(owners), || {
        test_override::with_shared_files(|| {
            with_test_profile(prof.path(), || {
                let inbox = load_region_submissions_core(&state, REGION).unwrap();
                let alice = by_value(&inbox, "10");
                assert_eq!(alice.identity.status, IdentityStatus::SignedUnconfirmed, "{:?}", alice.identity);
                assert_eq!(alice.identity.reason, IdentityReason::OthersCanChange);
                assert!(!alice.counted);
                // A different creator still refutes the claim.
                assert_eq!(by_value(&inbox, "500").identity.status, IdentityStatus::NotVerified);
                let status = region_response_status_core(&state, REGION).unwrap();
                assert!(status.responded.is_empty());
            });
        });
    });
}

/// UNSIGNED ANSWERS IN A VERSION WHOSE ANSWERS ARE ALL SIGNED ARE FORGED. The
/// app stamps its own version as the minimum on every application with
/// writeback regions, which writes `signed_answers` into the signed manifest;
/// no app that could send an unsigned answer can open such a version, so an
/// unsigned file there is a plant: it is in no list, no total, no roster. The
/// same answer in a version from before signing still reads "sent before
/// sign-in".
///
/// SABOTAGE: make `LocalWorkspace::answers_must_be_signed` return `false`.
#[test]
fn an_unsigned_answer_in_a_version_with_signed_answers_is_forged() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let form = publish_v1_with(&dir, prof.path(), &["Carol"], false, "0.1.0");
    assert!(ws(&dir).get_version_manifest(APP, V1).unwrap().signed_answers, "the publish marks it");
    send(&dir, "s-alice", "Alice", &sid_of("Alice"), "Alice", 2, 10.0);
    send_before_sign_in(&dir, "s-carol", "Carol", 4, 7.0);
    let state = author_workbook(&dir, form, &["Carol"]);
    test_override::with(StorageKind::NetworkShare, Some(the_owner_is_the_claim()), || {
        with_test_profile(prof.path(), || {
            let inbox = load_region_submissions_core(&state, REGION).unwrap();
            let values: Vec<&str> = inbox.iter().map(|r| r.value_display.as_str()).collect();
            assert_eq!(values, vec!["10"], "the unsigned plant is not listed");
            let fold = ws(&dir).load_submission_fold(APP, V1, &calp::ReviewAuthority::none()).unwrap();
            assert_eq!(fold.forged.len(), 1);
            assert_eq!(fold.forged[0].reason, calp::submission_seal::ForgeryReason::Unsigned);
            let status = region_response_status_core(&state, REGION).unwrap();
            assert!(!status.responded.iter().any(|n| n == "Carol"), "{:?}", status.responded);
        });
    });

    // The same plant in a version published before answers were signed.
    let old = TempDir::new().unwrap();
    let form = publish_v1(&old, prof.path(), &[], false);
    assert!(!ws(&old).get_version_manifest(APP, V1).unwrap().signed_answers);
    send_before_sign_in(&old, "s-carol", "Carol", 4, 7.0);
    let state = author_workbook(&old, form, &[]);
    with_test_profile(prof.path(), || {
        let inbox = load_region_submissions_core(&state, REGION).unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].sender, calp::SenderCheck::BeforeSignIn);
    });
}

/// Every answer file is owned by the account its sender folder names.
fn the_owner_is_the_claim() -> Rc<dyn Fn(&Path) -> Result<(String, String), String>> {
    Rc::new(|p: &Path| {
        let text = p.to_string_lossy().to_string();
        match text.find("win-") {
            Some(at) => {
                let rest = &text[at + 4..];
                let folder = rest.split(['\\', '/']).next().unwrap_or("");
                let subject = folder.get(..folder.len().saturating_sub(33)).unwrap_or("").to_string();
                Ok((subject.clone(), format!("CORP\\{subject}")))
            }
            None => Err("no owner".to_string()),
        }
    })
}

/// A PUBLISHER WHO ALSO SUBSCRIBES TO THEIR OWN APPLICATION keeps any model
/// table imported from the subscription: the author pass serves the region,
/// and the subscription's view is still built -- as a SHADOW, never offered
/// for import, served to a table imported with its columns
/// (`writeback_source::served_key`).
///
/// SABOTAGE: skip a region the author pass claimed in the subscription loop
/// (`continue` when `shadow`) -- no shadow is built.
#[test]
fn a_designated_and_subscribed_region_keeps_the_subscriptions_view_as_a_shadow() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let form = publish_v1(&dir, prof.path(), &[], false);
    send(&dir, "s-alice", "Alice", &sid_of("Alice"), "Alice", 2, 10.0);
    let state = author_workbook(&dir, form, &[]);
    let subscribed = subscriber_of(&dir, prof.path());
    let subscription = subscribed.subscriptions.read().unwrap().subscriptions[0].clone();
    state.subscriptions.write(&test_seed_effect()).unwrap().subscriptions.push(subscription);
    with_test_profile(prof.path(), || {
        let ds = crate::bi::writeback_source::collect_writeback_datasets(&state);
        let shape: Vec<(bool, crate::bi::writeback_source::DatasetOrigin)> =
            ds.iter().map(|d| (d.shadow, d.origin)).collect();
        assert_eq!(
            shape,
            vec![
                (false, crate::bi::writeback_source::DatasetOrigin::Author),
                (true, crate::bi::writeback_source::DatasetOrigin::Subscription),
            ]
        );
        assert!(ds.iter().all(|d| d.region.id == REGION));
    });
}

/// A DROPBOX/ONEDRIVE WORKSPACE: Windows is never asked who wrote a file (the
/// sync program wrote them all), every signed answer reads "Signed, identity
/// not confirmed (cannot be checked here ...)", and under the rule nothing is
/// counted -- loudly, by name.
///
/// SABOTAGE: make `owner_check_applies`' `SyncFolder` arm answer `Ok(())` --
/// the owner probe is called and this test panics in it.
#[test]
fn on_a_sync_folder_signed_answers_cannot_be_checked_and_windows_is_never_asked() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let form = publish_v1(&dir, prof.path(), &["CORP\\alice"], true);
    let _ = the_three_senders(&dir);
    let state = author_workbook(&dir, form, &["CORP\\alice"]);
    let never: Rc<dyn Fn(&Path) -> Result<(String, String), String>> =
        Rc::new(|p: &Path| panic!("asked Windows who wrote {} on a sync folder", p.display()));

    test_override::with(StorageKind::SyncFolder, Some(never), || {
        with_test_profile(prof.path(), || {
            let inbox = load_region_submissions_core(&state, REGION).unwrap();
            for value in ["10", "500"] {
                let r = by_value(&inbox, value);
                assert_eq!(r.identity.status, IdentityStatus::SignedUnconfirmed);
                assert_eq!(r.identity.reason, IdentityReason::SyncFolder);
                assert!(r.identity_label.contains("cannot be checked here"), "{}", r.identity_label);
                assert!(!r.counted);
            }
            let status = region_response_status_core(&state, REGION).unwrap();
            assert!(status.responded.is_empty());
            assert_eq!(status.missing, vec!["CORP\\alice".to_string()]);
            assert_eq!(status.not_counted, vec!["Alice".to_string(), "Carol".to_string()]);
        });
    });
}

/// A LOCAL (per-computer) account on a network share cannot be checked: the
/// client writes as a server-side account, so the owner is never its own SID
/// (critique-identity item 8) -- "cannot be checked here", never a false
/// "not verified".
#[test]
fn a_local_account_on_a_share_is_unconfirmed_never_a_false_mismatch() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let form = publish_v1(&dir, prof.path(), &[], true);
    let mut s = answer(
        "s-local",
        calp::identity_provider::identity_for(
            calp::IdentityProviderKind::Windows,
            &calp::identity_provider::AccountFacts {
                subject: "S-1-5-21-9-9-9-1001".into(),
                principal_name: "LAPTOP7\\salle".into(),
                display_name: "Salle".into(),
                scope: calp::AccountScope::LocalMachine,
            },
            &calp::submission_seal::public_key_of_seed(&seed_of("Salle")),
        )
        .unwrap(),
        2,
        3.0,
        "2026-10-22T09:00:00Z",
    );
    calp::submission_seal::seal_submission(&mut s, APP, V1, &seed_of("Salle"), SubmissionOrigin::Interactive).unwrap();
    ws(&dir).save_submission(APP, V1, &s).unwrap();
    let state = author_workbook(&dir, form, &[]);
    let server_account = share_where(&[("S-1-5-21-9-9-9-1001", "S-1-5-21-55-55-55-1100", "FILESERVER\\guest")]);
    test_override::with(StorageKind::NetworkShare, Some(server_account), || {
        with_test_profile(prof.path(), || {
            let row = by_value(&load_region_submissions_core(&state, REGION).unwrap(), "3");
            assert_eq!(row.identity.status, IdentityStatus::SignedUnconfirmed);
            assert_eq!(row.identity.reason, IdentityReason::LocalAccountOnShare);
        });
    });
}

// ---------------------------------------------------------------------------
// The subscriber's counting surfaces: GATHER and the BI tables
// ---------------------------------------------------------------------------

fn subscriber_of(dir: &TempDir, prof: &Path) -> AppState {
    let reg = ws(dir);
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    let pulled = calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: APP.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(calp::VersionPin::Latest),
            now: "2026-10-22T01:00:00Z".to_string(),
        },
        &scope,
        prof,
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("pull");
    let state = crate::create_app_state();
    state.subscriptions.write(&test_seed_effect()).unwrap().subscriptions.push(pulled.subscription);
    state
}

/// GATHER and the subscriber's BI table count only verified answers under the
/// rule -- the forged 500 never reaches a total.
///
/// SABOTAGE: pass `&calp::IdentityPolicy::default()` instead of the manifest's
/// rule to `apply_gather_governance` in `rebuild_gather_cache` -- the total
/// includes 500.
#[test]
fn gather_and_the_bi_table_count_only_verified_answers_under_the_rule() {
    let dir = TempDir::new().unwrap();
    let author = TempDir::new().unwrap();
    publish_v1(&dir, author.path(), &[], true);
    let owners = the_three_senders(&dir);
    let reader = TempDir::new().unwrap();
    let state = subscriber_of(&dir, reader.path());

    test_override::with(StorageKind::NetworkShare, Some(owners), || {
        with_test_profile(reader.path(), || {
            let gathered = crate::calp_commands::rebuild_gather_cache(&state);
            let region = gathered.get(REGION).expect("the region is gathered");
            let values: Vec<String> = region.submissions.iter().map(|s| format!("{:?}", s.value)).collect();
            assert_eq!(region.submissions.len(), 1, "only Alice's verified answer: {values:?}");
            assert!(matches!(region.submissions[0].value, engine::EvalResult::Number(v) if v == 10.0));

            let ds = crate::bi::writeback_source::collect_writeback_datasets(&state);
            assert_eq!(ds.len(), 1);
            assert_eq!(ds[0].rows.len(), 1);
            assert_eq!(ds[0].rows[0].id, "s-alice");
        });
    });
}

/// Without the rule GATHER counts all three (each labelled; the totals do not
/// change for an application that never asked).
#[test]
fn without_the_rule_gather_counts_every_answer() {
    let dir = TempDir::new().unwrap();
    let author = TempDir::new().unwrap();
    publish_v1(&dir, author.path(), &[], false);
    let owners = the_three_senders(&dir);
    let reader = TempDir::new().unwrap();
    let state = subscriber_of(&dir, reader.path());
    test_override::with(StorageKind::NetworkShare, Some(owners), || {
        with_test_profile(reader.path(), || {
            let gathered = crate::calp_commands::rebuild_gather_cache(&state);
            assert_eq!(gathered.get(REGION).unwrap().submissions.len(), 3);
        });
    });
}

// ---------------------------------------------------------------------------
// Real OS
// ---------------------------------------------------------------------------

/// REAL OS: in a temp workspace on this computer's own disk, the answer this
/// computer signs is Verified (Windows recorded this account as its writer),
/// and an answer that claims ANOTHER local account of this computer but was
/// written by this one reads "Not verified: written by <this account>". (An
/// elevated test run writes as Administrators, which can neither confirm nor
/// refute: then both read "cannot be checked here".) A logic test of the owner
/// check, not a two-user security proof (critique-identity item 8).
#[test]
fn real_os_my_own_answer_is_verified_and_a_claimed_neighbour_is_not() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    with_test_profile(prof.path(), || {
        let me = crate::submitter_identity::current_identity().unwrap();
        let mut mine = answer("s-me", me.clone(), 2, 1.0, "2026-10-22T09:00:00Z");
        crate::submitter_identity::seal_outgoing(&mut mine, APP, V1, SubmissionOrigin::Interactive).unwrap();
        ws(&dir).save_submission(APP, V1, &mine).unwrap();

        // Mallory signs with her own key an answer claiming a NEIGHBOUR's local
        // account on this computer -- and writes it as this account.
        let computer = crate::identity_verification::reader_computer();
        let my_sid = calp::identity_provider::parse_signed_id(&me.id).unwrap().1.to_string();
        let neighbour_sid = format!("{}-4242", my_sid.rsplit_once('-').unwrap().0);
        let neighbour = calp::identity_provider::identity_for(
            calp::IdentityProviderKind::Windows,
            &calp::identity_provider::AccountFacts {
                subject: neighbour_sid,
                principal_name: format!("{computer}\\neighbour"),
                display_name: "Neighbour".into(),
                scope: calp::AccountScope::LocalMachine,
            },
            &calp::submission_seal::public_key_of_seed(&seed_of("Mallory")),
        )
        .unwrap();
        let mut forged = answer("s-neighbour", neighbour, 3, 2.0, "2026-10-22T09:00:00Z");
        calp::submission_seal::seal_submission(&mut forged, APP, V1, &seed_of("Mallory"), SubmissionOrigin::Interactive)
            .unwrap();
        ws(&dir).save_submission(APP, V1, &forged).unwrap();

        let reg = ws(&dir);
        let rows = reg.load_current_submissions(APP, V1, &calp::ReviewAuthority::none()).unwrap();
        let rows = crate::identity_verification::attested(&reg, APP, V1, rows);
        let get = |id: &str| rows.iter().find(|r| r.id == id).unwrap().identity.clone();
        let (mine_v, forged_v) = (get("s-me"), get("s-neighbour"));
        if mine_v.reason == IdentityReason::WrittenByAdministrator {
            eprintln!("elevated run: files are owned by Administrators; the owner check cannot decide");
            assert_eq!(forged_v.reason, IdentityReason::WrittenByAdministrator);
            return;
        }
        assert_eq!(mine_v.status, IdentityStatus::Verified, "{mine_v:?}");
        assert_eq!(forged_v.status, IdentityStatus::NotVerified, "{forged_v:?}");
        assert_eq!(forged_v.written_by.to_lowercase(), me.principal_name.to_lowercase());
    });
}

/// REAL OS (BUG-0584, found live 2026-10-22): in a workspace DEEPER than about
/// 90 characters the answer's file is beyond MAX_PATH, and the owner lookup
/// failed with ERROR_INVALID_NAME -- so this computer's own answer, in a temp
/// folder of its own disk, read "Signed, identity not confirmed (cannot be
/// checked here: Windows did not say who wrote the file)". It is Verified like
/// one in a shallow workspace.
///
/// SABOTAGE: make `identity_verification::api_path` return `plain_path(path)`.
#[test]
fn real_os_my_own_answer_in_a_deep_workspace_is_verified() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let root = dir.path().join("workspaces-of-the-finance-team-for-the-yearly-budget").join("x".repeat(60));
    std::fs::create_dir_all(&root).unwrap();
    with_test_profile(prof.path(), || {
        let me = crate::submitter_identity::current_identity().unwrap();
        let mut mine = answer("s-me-deep", me.clone(), 2, 1.0, "2026-10-22T09:00:00Z");
        crate::submitter_identity::seal_outgoing(&mut mine, APP, V1, SubmissionOrigin::Interactive).unwrap();
        let reg = calp::workspace::LocalWorkspace::open(&root).unwrap();
        reg.save_submission(APP, V1, &mine).unwrap();
        let files = reg.submission_files(APP, V1, &mine).unwrap();
        assert_eq!(files.len(), 1);
        let spelled = crate::identity_verification::plain_path(&files[0]);
        assert!(spelled.len() > 260, "the fixture must put the answer beyond MAX_PATH: {} {spelled}", spelled.len());

        let rows = reg.load_current_submissions(APP, V1, &calp::ReviewAuthority::none()).unwrap();
        let rows = crate::identity_verification::attested(&reg, APP, V1, rows);
        let verdict = rows.iter().find(|r| r.id == "s-me-deep").unwrap().identity.clone();
        if verdict.reason == IdentityReason::WrittenByAdministrator {
            eprintln!("elevated run: files are owned by Administrators; the owner check cannot decide");
            return;
        }
        assert_eq!(verdict.status, IdentityStatus::Verified, "{verdict:?}");
        assert_eq!(verdict.written_by.to_lowercase(), me.principal_name.to_lowercase());
    });
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/// Publishing writeback regions into a Dropbox/OneDrive workspace WARNS (it is
/// never refused); a share does not; an application without regions does not.
#[test]
fn a_sync_folder_workspace_is_warned_about_at_publish_never_refused() {
    let dir = TempDir::new().unwrap();
    let regions = vec![region_on(identity::SheetId::from_bytes(identity::generate_uuid_v7()), &[])];
    let path = dir.path().to_str().unwrap();
    test_override::with(StorageKind::SyncFolder, None, || {
        let w = crate::calp_commands::writeback_storage_warning(Some(&regions), path).expect("warned");
        assert!(w.contains("Dropbox or OneDrive"), "{w}");
        assert!(crate::calp_commands::writeback_storage_warning(None, path).is_none());
        assert!(crate::calp_commands::writeback_storage_warning(Some(&Vec::new()), path).is_none());
    });
    test_override::with(StorageKind::NetworkShare, None, || {
        assert!(crate::calp_commands::writeback_storage_warning(Some(&regions), path).is_none());
    });
}

/// THE WARNING REACHES THE DIALOG. `calp_publish` and `calp_publish_preview`
/// need a Tauri window, so their wiring is pinned structurally: the publish
/// computes the storage warning and CHAINS it into the warnings it returns,
/// and the preview extends its warnings with it. (The helper's own behaviour
/// is `a_sync_folder_workspace_is_warned_about_at_publish_never_refused`.)
///
/// SABOTAGE: delete `.chain(storage_warning)` from `calp_publish`.
#[test]
fn the_storage_warning_is_wired_into_publish_and_its_preview() {
    let cmds = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("calp_commands.rs")).unwrap();
    let body = |start: &str| -> String {
        let at = cmds.find(start).unwrap_or_else(|| panic!("no {start}"));
        let rest = &cmds[at..];
        rest[..rest.find("\n}\n").unwrap_or(rest.len())].to_string()
    };
    let publish = body("pub fn calp_publish(");
    assert!(
        publish.contains("let storage_warning = writeback_storage_warning("),
        "calp_publish no longer computes the storage warning"
    );
    assert!(publish.contains(".chain(storage_warning)"), "calp_publish drops the storage warning");
    let preview = body("pub fn calp_publish_preview(");
    assert!(preview.contains("warnings.extend(writeback_storage_warning("), "the preview drops the storage warning");
    // And a base rule the preview cannot read is SAID, never a silent "off".
    assert!(preview.contains("Could not read whether version"), "the preview hides an unreadable base rule");
}

/// The rule alone stamps this app as the minimum: an older app would ignore it
/// and count every answer in its totals -- a lie.
#[test]
fn the_identity_rule_stamps_the_minimum_app_version() {
    let wb = Workbook::default();
    let mut request = PublishRequest {
        workbook: &wb,
        package_name: APP.to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: String::new(),
        sheet_indices: Vec::new(),
        now: String::new(),
        published_by: String::new(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        identity_policy: Some(IdentityPolicy { require_verified: true }),
        min_app_version: String::new(),
    };
    crate::calp_commands::stamp_min_app_version(&mut request);
    assert_eq!(request.min_app_version, env!("CARGO_PKG_VERSION"));
}

// ---------------------------------------------------------------------------
// Census: every counting reader attests
// ---------------------------------------------------------------------------

/// Every app-side reader of folded answers (`load_current_*`,
/// `load_submission_fold`) either attaches the reader's verdicts
/// (`identity_verification::attest` / `attested`) in the same function, or is
/// listed here with the reason it never COUNTS answers. A new counting reader
/// that skips the step would count nothing under the rule -- the verdict
/// defaults to "not checked", which fails closed -- but this names it at once.
///
/// SABOTAGE: remove the `attest(` call from `calp_list_model_submissions` (its
/// only one) -- this names it. (Removing ONE of `rebuild_gather_cache`'s two calls
/// is caught by `gather_and_the_bi_table_count_only_verified_answers_under_the_rule`.)
#[test]
fn every_counting_reader_attests_the_answers_it_reads() {
    let allowed: &[(&str, &str)] = &[
        ("registry_has_own_submission", "the subscriber's own answers: is_mine, never counted"),
        ("own_records_by_region_in", "seeding the subscriber's cells: is_mine (my key) only"),
        ("set_submission_state_with_origin", "a review targets one record by id; nothing is counted"),
        ("set_model_submission_state_with_origin", "a review targets one record by id; nothing is counted"),
        ("stream_tags_in_records", "lists the stream tags seen; nothing is counted"),
        ("load_current_submissions_by", "the HTTP transport's forwarding impl"),
        ("load_current_region_submissions", "the HTTP transport's forwarding impl"),
        ("load_current_submissions", "the HTTP transport's forwarding impl"),
    ];
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();
    for file in walk(&root) {
        let name = file.file_name().unwrap().to_string_lossy().to_string();
        if name.contains("tests") || name == "identity_verification.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&file).unwrap();
        let text = match text.find("#[cfg(test)]\nmod tests") {
            Some(at) => text[..at].to_string(),
            None => text,
        };
        for pat in [".load_current_submissions(", ".load_current_region_submissions(", ".load_current_submissions_by(", ".load_submission_fold("] {
            let mut from = 0;
            while let Some(at) = text[from..].find(pat) {
                let pos = from + at;
                from = pos + pat.len();
                let line_start = text[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
                if text[line_start..pos].trim_start().starts_with("//") {
                    continue;
                }
                let fn_at = text[..pos].rfind("fn ").expect("inside a function");
                // A #[test] function in a source file's own test module reads
                // fixtures, not answers anyone counts.
                let head_from = fn_at.saturating_sub(300);
                let head = &text[head_from..fn_at];
                if head.rfind("#[test]").is_some_and(|t| !head[t..].contains("\n}\n")) {
                    continue;
                }
                let fn_name: String =
                    text[fn_at + 3..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                let body_end = text[fn_at..].find("\n}\n").map(|i| fn_at + i).unwrap_or(text.len());
                let body = &text[fn_at..body_end];
                let attests = body.contains("identity_verification::attest");
                if !attests && !allowed.iter().any(|(f, _)| *f == fn_name) {
                    offenders.push(format!("{name}: {fn_name}"));
                }
            }
        }
    }
    offenders.sort();
    offenders.dedup();
    assert!(offenders.is_empty(), "readers of folded answers that never attest them: {offenders:?}");
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out
}

/// The scripts' door counts too: a region list keeps only `counted` rows, and
/// a model column's list goes through the same rule.
#[test]
fn the_script_gateway_reads_only_counted_answers() {
    let text = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("scripting").join("writeback_gateway.rs"),
    )
    .unwrap();
    let list = &text[text.find("Action::ListSubmissions => match target").unwrap()..];
    let list = &list[..list.find("Action::SetSubmissionState =>").unwrap()];
    assert!(list.contains(".filter(|r| r.counted)"), "region rows are not filtered by the rule");
    assert!(list.contains("calp::identity_check::admit(rows, &policy)"), "model rows are not filtered by the rule");
    assert!(list.contains("model_writeback_identity_policy("), "the model rule is not read");
}
