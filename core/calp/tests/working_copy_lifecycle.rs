//! FILENAME: core/calp/tests/working_copy_lifecycle.rs
//! PURPOSE: The author-side lifecycle — check out a published application, edit it,
//! push the next version — and the properties that make it safe.
//! CONTEXT: `.calp` had no author update flow at all. Republishing meant
//! re-deriving the application from whatever workbook happened to be open, and
//! doing it from a SUBSCRIBED copy silently destroyed the application's sheet
//! identity: `pull()` mints fresh sheet ids, so every subscriber's next refresh
//! saw every sheet as removed-and-re-added and their overrides were orphaned.
//! `identity_survives_checkout_and_push` is the test that closes that hole; the
//! rest hold the push gates that keep two developers from overwriting each
//! other on a shared workspace.

use std::path::Path;
use std::sync::{Arc, Barrier};

use tempfile::TempDir;

use calp::checkout::checkout;
use calp::integrity::PinPolicy;
use calp::manifest::Subscription;
use calp::overrides::OverrideLayer;
use calp::publish::{self, PublishRequest, PushMode};
use calp::pull::{self, PullRequest};
use calp::refresh;
use calp::workspace::LocalWorkspace;
use calp::transport::WorkspaceTransport;
use calp::version::{SemVer, VersionPin};
use calp::CalpError;

use engine::cell::Cell;
use persistence::{SavedCell, Sheet, Workbook};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A one-sheet workbook whose A1 holds `text`.
fn workbook(text: &str) -> Workbook {
    let mut sheet = Sheet::new("Dashboard".to_string());
    sheet
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_text(text.to_string())));
    let mut wb = Workbook::default();
    wb.sheets = vec![sheet];
    wb
}

fn scope_of(dir: &TempDir) -> calp::WorkspaceScope {
    calp::workspace_scope(dir.path().to_str().unwrap()).unwrap()
}

/// Publish `wb` as `package`@`version` in the given mode.
fn push(
    reg: &LocalWorkspace,
    prof: &Path,
    wb: &Workbook,
    package: &str,
    version: SemVer,
    mode: PushMode,
    summary: &str,
) -> Result<publish::PublishResult, CalpError> {
    let request = PublishRequest {
        workbook: wb,
        package_name: package.to_string(),
        version,
        kind: "report".to_string(),
        mode,
        change_summary: summary.to_string(),
        sheet_indices: vec![0],
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
    publish::publish(reg, &request, prof)
}

fn create(reg: &LocalWorkspace, prof: &Path, wb: &Workbook, package: &str) {
    push(reg, prof, wb, package, SemVer::new(1, 0, 0), PushMode::CreateNew, "first cut")
        .expect("create failed");
}

// ---------------------------------------------------------------------------
// The trap test
// ---------------------------------------------------------------------------

/// THE point of checkout.
///
/// A developer opens a published application, edits it, and pushes it back. A
/// subscriber who is still on the old version then refreshes. They must see
/// their sheets MODIFIED — not removed and re-added — because that is the
/// difference between an override surviving and an override being orphaned.
///
/// Before checkout existed, the only way to "open" an application was to subscribe
/// to it, and a push from that copy renamed every sheet's identity. This test
/// asserts both halves: what checkout does, and what pull deliberately does
/// not.
#[test]
fn identity_survives_checkout_and_push() {
    let dir = TempDir::new().unwrap();
    let author = TempDir::new().unwrap();
    let subscriber = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let scope = scope_of(&dir);

    // v1.0.0, published from the author's own workbook.
    let original = workbook("v1 content");
    let package_sheet_id = original.sheets[0].id;
    create(&reg, author.path(), &original, "sales");

    // A subscriber pulls v1.0.0 and records the subscription the app would.
    let subscribed = pull::pull(
        &reg,
        &PullRequest {
            package_name: "sales".to_string(),
            version_pin: VersionPin::Latest,
            now: "2026-08-29T01:00:00Z".to_string(),
        },
        &scope,
        subscriber.path(),
        PinPolicy::PinOnFirstUse,
    )
    .unwrap();
    let mut subscriptions: Vec<Subscription> = vec![subscribed.subscription.clone()];
    let subscriber_local_sheet_id = subscribed.sheets[0].sheet.id;
    assert_ne!(
        subscriber_local_sheet_id, package_sheet_id,
        "precondition: a subscriber's copy has its OWN sheet identity"
    );

    // A (possibly different) developer checks the application out and edits it.
    let mut working_copy_result =
        checkout(&reg, "sales", None, "2026-08-29T02:00:00Z", &scope, author.path()).unwrap();
    let mut working_copy = Workbook::default();
    working_copy.sheets = working_copy_result
        .sheets
        .drain(..)
        .map(|s| s.sheet)
        .collect();
    assert_eq!(
        working_copy.sheets[0].id, package_sheet_id,
        "a working copy carries the package's sheet identity"
    );
    working_copy.sheets[0]
        .cells
        .insert((0, 1), SavedCell::from_cell(&Cell::new_text("added by the editor".to_string())));

    // Push v1.1.0 based on v1.0.0.
    push(
        &reg,
        author.path(),
        &working_copy,
        "sales",
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "adds a note in B1",
    )
    .expect("push failed");

    // The subscriber refreshes. THIS is the assertion the whole design exists
    // for: the sheet is updated in place, not removed and re-added.
    let preview = refresh::compute_preview(
        &reg,
        &subscriptions,
        &OverrideLayer::new(),
        &std::collections::HashMap::new(),
        &std::collections::HashMap::new(),
    )
    .unwrap();
    let sub_preview = &preview.subscription_previews[0];
    assert_eq!(sub_preview.new_version, "1.1.0");
    assert!(
        sub_preview.sheets_removed.is_empty(),
        "a push from a checked-out copy must not look like a deletion: {:?}",
        sub_preview.sheets_removed
    );
    assert!(
        sub_preview.sheets_added.is_empty(),
        "…nor like a new sheet: {:?}",
        sub_preview.sheets_added
    );
    assert_eq!(
        sub_preview.sheets_updated.len(),
        1,
        "the subscriber sees exactly one MODIFIED sheet"
    );
    assert_eq!(sub_preview.sheets_updated[0].sheet_id, package_sheet_id);

    // And applying it keeps the subscriber's own local sheet id, so anything
    // anchored to it locally (overrides, charts, controls) still points home.
    let payloads = refresh::pull_all_updates(
        &reg,
        &subscriptions,
        &scope,
        subscriber.path(),
        PinPolicy::RequirePinned,
        None,
    )
    .unwrap();
    let mut layer = OverrideLayer::new();
    let result = refresh::apply_refresh(
        payloads,
        &mut subscriptions,
        &mut layer,
        &Default::default(),
        "2026-08-29T03:00:00Z",
    );
    assert_eq!(result.sheets_updated, 1);
    assert_eq!(result.sheets_added, 0);
    assert_eq!(result.sheets_removed, 0);
    assert_eq!(
        subscriptions[0].sheets[0].local_sheet_id, subscriber_local_sheet_id,
        "the subscriber keeps their own local sheet id across the refresh"
    );
    assert_eq!(subscriptions[0].resolved_version, "1.1.0");
}

/// The counter-example, stated as a test so the reason checkout exists cannot
/// quietly stop being true: pushing from a SUBSCRIBED copy would hand the
/// application a different sheet identity, which is why the app-side gate refuses
/// it outright.
#[test]
fn a_subscribed_copy_carries_different_identity_than_the_package() {
    let dir = TempDir::new().unwrap();
    let author = TempDir::new().unwrap();
    let subscriber = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let scope = scope_of(&dir);

    let original = workbook("v1");
    let package_sheet_id = original.sheets[0].id;
    create(&reg, author.path(), &original, "sales");

    let pulled = pull::pull(
        &reg,
        &PullRequest {
            package_name: "sales".to_string(),
            version_pin: VersionPin::Latest,
            now: "2026-08-29T01:00:00Z".to_string(),
        },
        &scope,
        subscriber.path(),
        PinPolicy::PinOnFirstUse,
    )
    .unwrap();

    assert_ne!(
        pulled.sheets[0].sheet.id, package_sheet_id,
        "if this ever becomes equal, the subscriber-conflict push gate is no \
         longer the thing standing between a re-publish and every subscriber's \
         orphaned overrides — re-read the role rule before changing it"
    );
}

// ---------------------------------------------------------------------------
// Push gates
// ---------------------------------------------------------------------------

#[test]
fn a_stale_base_is_refused_and_names_who_moved_it() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let wb = workbook("v1");
    create(&reg, alice.path(), &wb, "sales");

    // Alice pushes 1.1.0 while Bob is still working from 1.0.0.
    push(
        &reg,
        alice.path(),
        &wb,
        "sales",
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "alice's change",
    )
    .unwrap();

    let result = push(
        &reg,
        alice.path(),
        &wb,
        "sales",
        SemVer::new(1, 2, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "bob's change",
    );
    match result {
        Err(CalpError::BaseVersionStale { expected_base, actual_latest, latest_published_by, .. }) => {
            assert_eq!(expected_base, "1.0.0");
            assert_eq!(actual_latest, "1.1.0");
            assert_eq!(latest_published_by, "author");
        }
        other => panic!("expected BaseVersionStale, got {other:?}"),
    }
}

#[test]
fn a_push_with_no_change_summary_is_refused() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let wb = workbook("v1");
    create(&reg, prof.path(), &wb, "sales");

    // Whitespace is not a summary.
    let result = push(
        &reg,
        prof.path(),
        &wb,
        "sales",
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "   \n ",
    );
    assert!(
        matches!(result, Err(CalpError::MissingChangeSummary { .. })),
        "expected MissingChangeSummary, got {result:?}"
    );
}

#[test]
fn pushing_with_a_different_publisher_key_is_refused_at_the_source() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let bob = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let wb = workbook("v1");

    create(&reg, alice.path(), &wb, "sales");

    // Bob's profile holds a different keypair. Without the gate this publish
    // SUCCEEDS and the failure surfaces at every subscriber's next refresh as
    // PublisherKeyChanged — i.e. at the one moment nobody who can fix it is
    // present.
    let result = push(
        &reg,
        bob.path(),
        &wb,
        "sales",
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "bob's change",
    );
    assert!(
        matches!(result, Err(CalpError::NotThePublisher { .. })),
        "expected NotThePublisher, got {result:?}"
    );

    // The refusal happened BEFORE anything was written.
    assert!(
        !reg.version_exists("sales", "1.1.0"),
        "a refused push must leave no version behind"
    );
    let manifest = reg.get_application_manifest("sales").unwrap();
    assert_eq!(manifest.versions.len(), 1, "…and no version-list entry");
}

#[test]
fn create_new_into_an_existing_name_is_refused() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let wb = workbook("v1");
    create(&reg, prof.path(), &wb, "sales");

    let result = push(
        &reg,
        prof.path(),
        &wb,
        "sales",
        SemVer::new(2, 0, 0),
        PushMode::CreateNew,
        "oops, meant to push",
    );
    assert!(
        matches!(result, Err(CalpError::ApplicationAlreadyExists(ref p)) if p == "sales"),
        "expected ApplicationAlreadyExists, got {result:?}"
    );
}

#[test]
fn updating_a_package_that_does_not_exist_is_refused() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let wb = workbook("v1");

    let result = push(
        &reg,
        prof.path(),
        &wb,
        "typo-in-the-name",
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "a change",
    );
    assert!(
        matches!(result, Err(CalpError::ApplicationNotFound(ref p)) if p == "typo-in-the-name"),
        "expected ApplicationNotFound, got {result:?}"
    );
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

#[test]
fn lineage_is_recorded_in_the_signed_manifest_and_the_version_list() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let wb = workbook("v1");
    create(&reg, prof.path(), &wb, "sales");
    push(
        &reg,
        prof.path(),
        &wb,
        "sales",
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "  adds the regional split  ",
    )
    .unwrap();

    let v2 = reg.get_version_manifest("sales", "1.1.0").unwrap();
    assert_eq!(v2.base_version, "1.0.0");
    assert_eq!(
        v2.change_summary, "adds the regional split",
        "the summary is trimmed before it is signed"
    );

    let v1 = reg.get_version_manifest("sales", "1.0.0").unwrap();
    assert_eq!(v1.base_version, "", "a created package has no base");

    // The version list carries the same facts so history renders from one read.
    let pkg = reg.get_application_manifest("sales").unwrap();
    let entry = pkg.versions.iter().find(|e| e.version == "1.1.0").unwrap();
    assert_eq!(entry.base_version, "1.0.0");
    assert_eq!(entry.change_summary, "adds the regional split");
    assert_eq!(entry.publisher_key, v2.publisher_key);
    assert!(!entry.publisher_key.is_empty());
}

/// Lineage lives inside the Ed25519 signature, so rewriting history on the
/// share breaks verification rather than passing silently.
#[test]
fn tampering_with_the_change_summary_breaks_the_signature() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let scope = scope_of(&dir);
    let wb = workbook("v1");
    create(&reg, prof.path(), &wb, "sales");

    // Rewrite the summary in the published manifest, leaving the signature.
    let raw = reg
        .read_artifact("sales", "1.0.0", calp::integrity::VERSION_MANIFEST_FILE)
        .unwrap()
        .expect("manifest present");
    let mut json: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    json["changeSummary"] = serde_json::Value::String("a summary nobody wrote".to_string());
    reg.write_artifact(
        "sales",
        "1.0.0",
        calp::integrity::VERSION_MANIFEST_FILE,
        serde_json::to_vec_pretty(&json).unwrap().as_slice(),
    )
    .unwrap();

    let result = pull::pull(
        &reg,
        &PullRequest {
            package_name: "sales".to_string(),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-08-29T01:00:00Z".to_string(),
        },
        &scope,
        prof.path(),
        PinPolicy::PinOnFirstUse,
    );
    assert!(
        matches!(result, Err(CalpError::ManifestSignatureInvalid { .. })),
        "expected ManifestSignatureInvalid, got {:?}",
        result.err()
    );
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/// Two developers push at the same instant from the same base. Exactly one may
/// win, the loser must be told why, and the winner's version must be complete —
/// which is the property that the old code could not offer, because it checked
/// `version_exists` outside the lock and held the lock only over the final
/// version-list append.
#[test]
fn concurrent_pushes_from_one_base_produce_exactly_one_winner() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg_path = dir.path().to_path_buf();
    let prof_path = prof.path().to_path_buf();

    {
        let reg = LocalWorkspace::open(&reg_path).unwrap();
        create(&reg, &prof_path, &workbook("v1"), "sales");
    }

    let barrier = Arc::new(Barrier::new(2));
    let mut handles = Vec::new();
    for (i, minor) in [1u32, 2u32].into_iter().enumerate() {
        let reg_path = reg_path.clone();
        let prof_path = prof_path.clone();
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            let reg = LocalWorkspace::open(&reg_path).unwrap();
            let wb = workbook(&format!("edit from developer {i}"));
            barrier.wait();
            push(
                &reg,
                &prof_path,
                &wb,
                "sales",
                SemVer::new(1, minor, 0),
                PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
                "concurrent change",
            )
            .map(|r| r.version)
        }));
    }

    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let winners: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
    let losers: Vec<_> = results.iter().filter_map(|r| r.as_ref().err()).collect();
    assert_eq!(winners.len(), 1, "exactly one push may win: {results:?}");
    assert_eq!(losers.len(), 1);
    assert!(
        matches!(losers[0], CalpError::BaseVersionStale { .. } | CalpError::WorkspaceBusy { .. }),
        "the loser must be told the base moved (or that the registry was busy), got {:?}",
        losers[0]
    );

    let reg = LocalWorkspace::open(&reg_path).unwrap();
    let pkg = reg.get_application_manifest("sales").unwrap();
    assert_eq!(
        pkg.versions.len(),
        2,
        "the created version plus exactly one winner: {:?}",
        pkg.versions.iter().map(|v| &v.version).collect::<Vec<_>>()
    );

    // The winner is not merely listed — it is COMPLETE. Two publishes that
    // interleaved their artifact writes would produce a version whose bytes do
    // not match its own signed checksum map.
    let winner = winners[0];
    let manifest = reg.get_version_manifest("sales", winner).unwrap();
    calp::integrity::verify_version_artifacts_via(&reg, "sales", winner, &manifest)
        .expect("the winning version must pass its own integrity walk");
}

// ---------------------------------------------------------------------------
// Co-publishing (delegation)
// ---------------------------------------------------------------------------

/// The whole point of delegation, end to end.
///
/// Alice creates an application and adds Bob as a co-publisher. Bob pushes. A
/// subscriber who pinned ALICE's key accepts Bob's version — because it traces
/// to a list Alice signed — without being asked to re-decide anything.
#[test]
fn a_delegate_can_push_and_subscribers_accept_it_without_re_pinning() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let bob = TempDir::new().unwrap();
    let subscriber = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let scope = scope_of(&dir);

    let wb = workbook("v1");
    create(&reg, alice.path(), &wb, "sales");

    // The subscriber pins ALICE — the only key they will ever be asked about.
    let pulled = pull::pull(
        &reg,
        &PullRequest {
            package_name: "sales".to_string(),
            version_pin: VersionPin::Latest,
            now: "2026-08-29T01:00:00Z".to_string(),
        },
        &scope,
        subscriber.path(),
        PinPolicy::PinOnFirstUse,
    )
    .unwrap();
    assert_eq!(pulled.trust_status, calp::integrity::TrustStatus::FirstUse);

    // Bob cannot push yet: he is not the publisher.
    let bob_key = calp::signing::PublisherKeypair::load_or_create(bob.path())
        .unwrap()
        .public_key_hex();
    let refused = push(
        &reg,
        bob.path(),
        &wb,
        "sales",
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "bob's first attempt",
    );
    assert!(
        matches!(refused, Err(CalpError::NotThePublisher { .. })),
        "expected NotThePublisher before delegation, got {refused:?}"
    );

    // Alice adds Bob.
    let alice_kp = calp::signing::PublisherKeypair::load_or_create(alice.path()).unwrap();
    let mut list = calp::publishers::PublisherList::new(
        "sales",
        &alice_kp.public_key_hex(),
        "2026-08-29T02:00:00Z",
    );
    list.authorized_keys.push(calp::publishers::AuthorizedKey {
        key: bob_key.clone(),
        name: "Bob".to_string(),
        added_at: "2026-08-29T02:00:00Z".to_string(),
    });
    calp::publishers::write_signed(&reg, &list, &alice_kp).unwrap();

    // Now Bob's push lands.
    push(
        &reg,
        bob.path(),
        &wb,
        "sales",
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "bob's change",
    )
    .expect("a listed co-publisher may push");

    let v2 = reg.get_version_manifest("sales", "1.1.0").unwrap();
    assert_eq!(v2.publisher_key, bob_key, "the version records who really signed it");

    // And the subscriber — still pinned to ALICE — accepts it.
    let refreshed = pull::pull(
        &reg,
        &PullRequest {
            package_name: "sales".to_string(),
            version_pin: VersionPin::Latest,
            now: "2026-08-29T03:00:00Z".to_string(),
        },
        &scope,
        subscriber.path(),
        PinPolicy::RequirePinned,
    )
    .expect("a delegate's version must verify against the pinned root");
    assert_eq!(
        refreshed.trust_status,
        calp::integrity::TrustStatus::TrustedDelegate,
        "and it is reported as a DELEGATE's signature, not silently as the \
         publisher's own — the user trusted one key and is now transitively \
         trusting someone that key vouched for"
    );
}

/// An unlisted key is still refused. The positive control for the test above:
/// delegation must not quietly become "anyone".
#[test]
fn an_unlisted_key_is_still_refused_after_a_list_exists() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let bob = TempDir::new().unwrap();
    let stranger = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();

    let wb = workbook("v1");
    create(&reg, alice.path(), &wb, "sales");

    let alice_kp = calp::signing::PublisherKeypair::load_or_create(alice.path()).unwrap();
    let bob_key = calp::signing::PublisherKeypair::load_or_create(bob.path())
        .unwrap()
        .public_key_hex();
    let mut list = calp::publishers::PublisherList::new(
        "sales",
        &alice_kp.public_key_hex(),
        "2026-08-29T02:00:00Z",
    );
    list.authorized_keys.push(calp::publishers::AuthorizedKey {
        key: bob_key,
        name: "Bob".to_string(),
        added_at: "2026-08-29T02:00:00Z".to_string(),
    });
    calp::publishers::write_signed(&reg, &list, &alice_kp).unwrap();

    // A stranger, not on the list.
    let result = push(
        &reg,
        stranger.path(),
        &wb,
        "sales",
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "a stranger's change",
    );
    assert!(
        matches!(result, Err(CalpError::NotThePublisher { .. })),
        "a list of co-publishers is a list, not an open door: {result:?}"
    );
}

/// A tampered co-publisher list stops the push rather than falling back to
/// root-only.
///
/// The failure this guards: if an unverifiable list were treated as absent,
/// corrupting it would silently remove every delegate — and the people it
/// removed would be told they are not the publisher, which is a true-sounding
/// message about entirely the wrong problem.
#[test]
fn a_tampered_publisher_list_is_reported_rather_than_ignored() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let bob = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();

    let wb = workbook("v1");
    create(&reg, alice.path(), &wb, "sales");

    let alice_kp = calp::signing::PublisherKeypair::load_or_create(alice.path()).unwrap();
    let bob_key = calp::signing::PublisherKeypair::load_or_create(bob.path())
        .unwrap()
        .public_key_hex();
    let mut list = calp::publishers::PublisherList::new(
        "sales",
        &alice_kp.public_key_hex(),
        "2026-08-29T02:00:00Z",
    );
    list.authorized_keys.push(calp::publishers::AuthorizedKey {
        key: bob_key,
        name: "Bob".to_string(),
        added_at: "2026-08-29T02:00:00Z".to_string(),
    });
    calp::publishers::write_signed(&reg, &list, &alice_kp).unwrap();

    // Someone edits the list on the share, leaving the old signature in place.
    let mut tampered = serde_json::to_value(&list).unwrap();
    tampered["authorizedKeys"] = serde_json::json!([]);
    reg.write_application_artifact(
        "sales",
        calp::publishers::PUBLISHERS_FILE,
        serde_json::to_vec_pretty(&tampered).unwrap().as_slice(),
    )
    .unwrap();

    let result = push(
        &reg,
        bob.path(),
        &wb,
        "sales",
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        "bob's change",
    );
    assert!(
        matches!(result, Err(CalpError::PublisherListInvalid { .. })),
        "expected PublisherListInvalid (not a quiet fallback to root-only), got {result:?}"
    );
}
