//! FILENAME: app/src-tauri/src/calp_developer_anchor_tests.rs
//! PURPOSE: The developer anchor on the app side: every developer door checks
//! the application's root against what THIS MACHINE remembers, and the
//! co-publisher list against the highest revision it has seen.
//!
//! CONTEXT: BUG-0262 made every door ask `authorize_signer`, anchored at the
//! application's root -- the first version, proved by its own signature. But the
//! root is FOUND through the unsigned version listing, so a share-writer can
//! plant a first version signed by their own key and every version they sign
//! becomes "authorised". Core (`core/calp/src/developer_anchor.rs`,
//! `checkout.rs`) holds the rules; this module holds the doors:
//!
//! * the authorised reader (`calp_inspector::open_authorized_content`) -- the
//!   push merge's four reads, the hold-back, the signed base a push compares
//!   button code against -- checks under `CheckOnly` and never records;
//! * a push (`calp_publish`) checks an update BEFORE the workbook is assembled
//!   and records a new application's creator AFTER core publish created it;
//! * a change of the co-publisher list never lowers the revision below this
//!   machine's mark, and reports a rolled-back list instead of being blocked by it;
//! * forgetting a remembered creator removes only that application's record and
//!   always leaves an audit row.
//!
//! Every test that reaches a door runs inside `with_test_profile`: the doors read
//! `calcula_profile_dir()`, and the anchor a test recorded must be where the door
//! looks (and never in the developer's real profile).

use std::path::Path;

use tempfile::TempDir;

use calp::publish::PushMode;
use calp::signing::key_fingerprint;
use calp::version::SemVer;
use calp::workspace::LocalWorkspace;
use calp::WorkspaceTransport;

use crate::calp_signer_trust_tests::{
    keypair, location, plant_fake_root, push, resign_as, workbook, workspace_with_planted, PKG,
};
use crate::profile_dir::with_test_profile;

const NOW: &str = "2026-09-30T00:00:00Z";

fn scope_of(dir: &TempDir) -> calp::WorkspaceScope {
    calp::workspace_scope(&location(dir)).unwrap()
}

fn anchors(profile: &Path) -> Vec<calp::AnchorRecord> {
    calp::developer_anchor::list_anchors(profile).unwrap()
}

// ---------------------------------------------------------------------------
// The authorised reader (merge, hold-back, signed base)
// ---------------------------------------------------------------------------

/// THE PLANTED ROOT, at the merge's door. This machine opened the application
/// once (Alice's root is remembered); Mallory then plants a first version of
/// her own and re-signs the head. The authorised reader refuses it with the
/// machine-readable prefix naming BOTH fingerprints, and leaves an always-on
/// `SignerRefused` row with auditing off. A machine that remembers nothing is let
/// through -- the positive control that proves the ANCHOR refused, not
/// BUG-0262's signer check.
///
/// SABOTAGE: in `open_authorized_content_with_signer`, read the anchor from a
/// profile other than `calcula_profile_dir()` (an empty one).
#[test]
fn open_authorized_content_refuses_an_anchor_contradiction_and_leaves_a_signer_refused_row_with_auditing_off() {
    let (dir, alice, mallory) = workspace_with_planted(&[]);
    let prof = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    // The genuine checkout on THIS machine remembers Alice.
    calp::checkout::checkout(&reg, PKG, None, NOW, &scope_of(&dir), prof.path())
        .expect("the genuine checkout");
    plant_fake_root(&reg, "0.0.1", &mallory, "mallory");
    resign_as(&reg, "1.2.0", &mallory, "mallory");

    // POSITIVE CONTROL: nothing remembered, the planted root authorises the
    // planted head.
    let fresh = TempDir::new().unwrap();
    with_test_profile(fresh.path(), || {
        crate::calp_inspector::open_authorized_content(&location(&dir), PKG, "=1.2.0", true, None)
            .expect("first contact with a planted root is trust on first use")
    });

    let state = crate::create_app_state();
    assert!(!state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    let err = with_test_profile(prof.path(), || {
        match crate::calp_inspector::open_authorized_content(
            &location(&dir),
            PKG,
            "=1.2.0",
            true,
            Some((&state, "merge")),
        ) {
            Ok(_) => panic!("a root that contradicts this machine's memory was read"),
            Err(e) => e,
        }
    });
    let alice_fp = key_fingerprint(&keypair(alice.path()).public_key_hex());
    let mallory_fp = key_fingerprint(&mallory.public_key_hex());
    assert!(
        err.starts_with(&format!("CALP_ANCHOR_CONTRADICTED remembered={alice_fp} claimed={mallory_fp}: ")),
        "{err}"
    );
    assert!(err.contains("v0.0.1"), "the planted first version is named: {err}");

    let log = state.audit_log.read().unwrap();
    let rows: Vec<_> = log
        .entries
        .iter()
        .filter(|e| matches!(e.event, calp::audit::AuditEvent::SignerRefused))
        .collect();
    assert_eq!(rows.len(), 1, "{:?}", log.entries);
    assert_eq!(rows[0].extra["door"], "merge");
    assert_eq!(rows[0].extra["reason"], "anchorContradicted");
    assert_eq!(rows[0].extra["rememberedFingerprint"], alice_fp.as_str());
    assert_eq!(rows[0].extra["claimedFingerprint"], mallory_fp.as_str());
}

/// A read the user experiences as passive never CREATES an anchor.
///
/// SABOTAGE: `AnchorPolicy::RecordOnFirstContact` in the authorised reader.
#[test]
fn a_check_only_read_never_creates_an_anchor() {
    let (dir, _alice, _mallory) = workspace_with_planted(&[]);
    let prof = TempDir::new().unwrap();
    let (_reg, _version, _manifest) = with_test_profile(prof.path(), || {
        crate::calp_inspector::open_authorized_content(&location(&dir), PKG, "=1.2.0", true, None)
            .expect("a version the root signed reads")
    });
    assert!(
        !calp::developer_anchor::developer_anchors_file_path(prof.path()).exists(),
        "a passive read wrote the anchor store"
    );
}

// ---------------------------------------------------------------------------
// The push
// ---------------------------------------------------------------------------

/// An update push CHECKS the root BEFORE anything is assembled or written, and
/// records nothing: first contact is remembered only after core publish has
/// accepted the version (`anchor_after_push`). Once Alice's root is remembered,
/// a root Mallory plants refuses the next update naming both keys; the version
/// list is unchanged -- the placement census below pins that the gate precedes
/// the assembly, the effect and core publish.
///
/// SABOTAGE: `anchor_push_target` returns `Ok(None)` for an update too.
#[test]
fn anchor_push_target_refuses_an_update_on_a_planted_root_before_any_write() {
    let (dir, alice, mallory) = workspace_with_planted(&[]);
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let prof = alice.path();
    let update = PushMode::Update { expected_base: SemVer::new(1, 2, 0) };

    let first = crate::calp_commands::anchor_push_target(prof, &reg, &scope_of(&dir), PKG, &update)
        .expect("the genuine developer may push");
    assert_eq!(first, Some(calp::AnchorStatus::NotAnchored), "the gate checks; it never records");
    assert!(anchors(prof).is_empty(), "the pre-assembly gate recorded an anchor");
    // ...the push landed: NOW the creator is remembered.
    assert_eq!(crate::calp_commands::anchor_after_push(prof, &reg, &scope_of(&dir), PKG), None);
    assert_eq!(anchors(prof).len(), 1);
    assert_eq!(anchors(prof)[0].anchored_by, calp::AnchoredBy::Publish);

    plant_fake_root(&reg, "0.0.1", &mallory, "mallory");
    let versions_before = reg.get_application_manifest(PKG).unwrap().versions.len();
    let err = crate::calp_commands::anchor_push_target(prof, &reg, &scope_of(&dir), PKG, &update)
        .expect_err("a planted root must refuse the push");
    match &err {
        calp::CalpError::DeveloperAnchorContradicted { remembered_fingerprint, claimed_fingerprint, .. } => {
            assert_eq!(remembered_fingerprint, &key_fingerprint(&keypair(alice.path()).public_key_hex()));
            assert_eq!(claimed_fingerprint, &key_fingerprint(&mallory.public_key_hex()));
        }
        other => panic!("expected DeveloperAnchorContradicted, got {other:?}"),
    }
    assert_eq!(reg.get_application_manifest(PKG).unwrap().versions.len(), versions_before);
    assert_eq!(anchors(prof).len(), 1, "the refusal moved or added an anchor");

    // A NEW application has nothing to check yet: no record, no refusal.
    assert!(
        crate::calp_commands::anchor_push_target(prof, &reg, &scope_of(&dir), "brand-new", &PushMode::CreateNew)
            .unwrap()
            .is_none()
    );
    assert_eq!(anchors(prof).len(), 1);
}

/// THE FIRST PUSH FROM A MACHINE THAT REMEMBERS NOTHING, onto a planted root.
/// Mallory plants a self-signed `0.0.1` below Alice's line and writes no
/// co-publisher list; Alice's head is untouched, so core's continuity gate --
/// which falls back to the HEAD signer when there is no list -- would let
/// Alice's push land without a word, and the push door used to record the
/// PLANTER as this machine's creator before it had checked anything (and
/// before any later gate could refuse). Now the proved root must authorise
/// the pusher: the push is refused naming the creator the workspace claims,
/// nothing is recorded, and the refusal leaves a `SignerRefused` row.
///
/// SABOTAGE: drop the `authority.allows(..)` check from `anchor_push_target`
/// (or record under `RecordOnFirstContact` there again).
#[test]
fn a_first_push_onto_a_planted_root_is_refused_and_records_nothing() {
    let (dir, alice, mallory) = workspace_with_planted(&[]);
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    plant_fake_root(&reg, "0.0.1", &mallory, "mallory");
    let update = PushMode::Update { expected_base: SemVer::new(1, 2, 0) };

    let err = crate::calp_commands::anchor_push_target(alice.path(), &reg, &scope_of(&dir), PKG, &update)
        .expect_err("a root that does not authorise this computer must refuse the push");
    match &err {
        calp::CalpError::NotAuthorizedPublisher { root_holder, .. } => {
            assert!(root_holder.contains(&key_fingerprint(&mallory.public_key_hex())), "{root_holder}");
        }
        other => panic!("expected NotAuthorizedPublisher, got {other:?}"),
    }
    assert!(anchors(alice.path()).is_empty(), "a refused push recorded the planter as creator");

    let state = crate::create_app_state();
    crate::calp_inspector::record_signer_refusal(&state, "push", PKG, "1.2.0", &err);
    let log = state.audit_log.read().unwrap();
    assert_eq!(log.entries.len(), 1, "{:?}", log.entries);
    assert!(matches!(log.entries[0].event, calp::audit::AuditEvent::SignerRefused));
    assert_eq!(log.entries[0].extra["reason"], "pusherNotAuthorized");
    assert_eq!(log.entries[0].extra["door"], "push");

    // ...and a machine without a publisher key is not "authorised" by default.
    let keyless = TempDir::new().unwrap();
    assert!(matches!(
        crate::calp_commands::anchor_push_target(keyless.path(), &reg, &scope_of(&dir), PKG, &update),
        Err(calp::CalpError::NotAuthorizedPublisher { .. })
    ));
}

/// A push that CREATES an application remembers this profile's key as its
/// creator -- and only a key the workspace's proved root authorises: a
/// workspace naming anyone else as the creator of the application just
/// published is a warning, and nothing is recorded.
///
/// SABOTAGE: drop the `authority.allows(..)` check in `anchor_after_push`.
#[test]
fn a_create_new_push_records_this_profiles_key_as_root() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    push(&reg, alice.path(), &workbook("v1"), SemVer::new(1, 0, 0), PushMode::CreateNew);

    assert_eq!(
        crate::calp_commands::anchor_after_push(alice.path(), &reg, &scope_of(&dir), PKG),
        None,
        "the creator's own publish is remembered without a warning"
    );
    let recorded = anchors(alice.path());
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    assert_eq!(recorded[0].root_key, keypair(alice.path()).public_key_hex());
    assert_eq!(recorded[0].anchored_by, calp::AnchoredBy::Publish);
    assert_eq!(recorded[0].root_version, "1.0.0");

    // Somebody else's profile: the workspace's creator is not its key.
    let bob = TempDir::new().unwrap();
    keypair(bob.path());
    let warning = crate::calp_commands::anchor_after_push(bob.path(), &reg, &scope_of(&dir), PKG)
        .expect("a creator that is not this computer's key is a warning");
    assert!(warning.contains("not this computer's key"), "{warning}");
    assert!(
        warning.contains(&key_fingerprint(&keypair(alice.path()).public_key_hex())),
        "the warning names who the workspace says created it: {warning}"
    );
    assert!(anchors(bob.path()).is_empty(), "a root that is not ours was remembered");
}

/// Comment-stripped source of one file.
fn source(rel: &str) -> String {
    std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel))
        .unwrap()
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

fn body_of<'a>(src: &'a str, signature: &str) -> &'a str {
    let start = src
        .find(signature)
        .unwrap_or_else(|| panic!("`{signature}` moved or was renamed"));
    let rest = &src[start..];
    &rest[..rest.find("\n}\n").unwrap_or(rest.len())]
}

/// The push asks what this machine remembers BEFORE it assembles the workbook,
/// constructs its `DocumentEffect` or calls core publish -- handed THIS push's
/// mode, workspace, application and profile -- audits the refusal at the
/// "push" door, and returns the coded text; the creator is remembered AFTER
/// core publish accepted the version, unconditionally (a new application's
/// AND the first push onto an existing one), on both publishing commands.
///
/// SABOTAGE: move the `anchor_push_target(` block below `calp::publish::publish(`;
/// or hand it `&calp::PushMode::CreateNew` instead of `&push_mode` (the gate is
/// then off for every update push).
#[test]
fn the_push_asks_the_anchor_before_it_assembles_or_writes() {
    let cmds = source("src/calp_commands.rs");
    let publish = body_of(&cmds, "pub fn calp_publish(");
    let gate = publish.find("anchor_push_target(").expect("calp_publish no longer asks the anchor");
    for later in ["assemble_publish_workbook(", "DocumentEffect::mutates(", "calp::publish::publish("] {
        let at = publish.find(later).unwrap_or_else(|| panic!("`{later}` moved"));
        assert!(gate < at, "the anchor gate runs after `{later}`");
    }
    let call = &publish[gate..];
    let call = &call[..call.find(")\n").expect("the anchor call is not delimited as expected")];
    assert!(
        call.contains("&params.package_name, &push_mode"),
        "the push anchor gate is not told this push's application and mode: {call}"
    );
    assert!(call.contains("(&profile,") && call.contains("&scope,"), "the gate is not told this profile/workspace: {call}");
    let refusal = &publish[gate..publish.find("assemble_publish_workbook(").unwrap()];
    assert!(refusal.contains("record_signer_refusal(&state, \"push\""), "the push refusal leaves no trail");
    assert!(refusal.contains("developer_refusal_text(&refused)"), "the push refusal is not coded");

    let core = publish.find("calp::publish::publish(").unwrap();
    let remembered = publish.find("anchor_after_push(").expect("the creator is not remembered after a push");
    assert!(core < remembered, "the creator is remembered before the push landed");
    let before: Vec<&str> = publish[..remembered].lines().rev().take(4).collect();
    assert!(
        !before.iter().any(|l| l.contains("PushMode::CreateNew =>")),
        "only a NEW application's creator is remembered again; an update's first push must record too"
    );

    let model = body_of(&cmds, "pub fn calp_publish_model(");
    let core = model.find("calp::publish::publish(").unwrap();
    let created = model.find("anchor_after_push(").expect("a published model is not remembered");
    assert!(core < created);

    let checkout = body_of(&cmds, "pub fn calp_checkout(");
    assert!(
        checkout.contains("developer_refusal_text(&refused)"),
        "a checkout refusal loses the code prefix the dialog's remedy branches on"
    );
}

/// BUG-0266 at the host door: the checkout is PREPARED (core's checks, nothing
/// remembered), this command's own gates run -- one working-copy link, never
/// both roles, no reserved ids, no collisions -- and only then is it ADMITTED,
/// the one step that records the developer anchor; before the effect, audited
/// and coded like every other refusal of the door. A checkout any gate refuses
/// therefore remembers nothing.
///
/// SABOTAGE: move `pending.admit()` above the role gates (a checkout refused
/// as `CALP_CHECKOUT_ALREADY_LINKED` then remembers the application's root);
/// or call `calp::checkout::checkout(` again (it admits at once).
#[test]
fn the_checkout_door_admits_after_every_gate_and_before_the_effect() {
    let cmds = source("src/calp_commands.rs");
    let checkout = body_of(&cmds, "pub fn calp_checkout(");
    assert!(
        !checkout.contains("calp::checkout::checkout("),
        "calp_checkout calls the one-step checkout, which records first contact before this door's gates"
    );
    let prepared = checkout.find("calp::checkout::prepare_checkout(").expect("calp_checkout no longer prepares");
    let admitted = checkout.find("pending.admit()").expect("calp_checkout never admits the checkout");
    assert_eq!(checkout.matches(".admit()").count(), 1, "one admission per checkout");
    assert!(prepared < admitted);
    for gate in [
        "CALP_CHECKOUT_ALREADY_OPEN",
        "CALP_CHECKOUT_ALREADY_LINKED",
        "CALP_CHECKOUT_IS_SUBSCRIBER",
        "refuse_reserved_distributed_script_ids(",
        "refuse_checkout_collisions(",
    ] {
        let at = checkout.find(gate).unwrap_or_else(|| panic!("`{gate}` moved out of calp_checkout"));
        assert!(at < admitted, "the checkout is admitted -- and its creator remembered -- before `{gate}` can refuse it");
    }
    let effect = checkout.find("DocumentEffect::mutates(").expect("the effect moved");
    assert!(admitted < effect, "a refused admission would leave a dirtied document");
    let admission = &checkout[admitted..effect];
    assert!(
        admission.contains("pending.admit().map_err(&refuse)"),
        "an admission refusal (a root recorded since the checks) is not audited and coded: {admission}"
    );
    let refuse = &checkout[..prepared];
    assert!(
        refuse.contains("record_signer_refusal(") && refuse.contains("developer_refusal_text(&refused)"),
        "the checkout's refusal closure lost its audit row or its code prefix"
    );
}

// ---------------------------------------------------------------------------
// The co-publisher list
// ---------------------------------------------------------------------------

/// SABOTAGE: `served.map(|s| s + 1).unwrap_or(1)` (the old rule).
#[test]
fn next_list_revision_never_goes_below_this_machines_mark() {
    use crate::calp_publishers::next_list_revision;
    assert_eq!(next_list_revision(None, 0), 1, "a first list is revision 1");
    assert_eq!(next_list_revision(Some(5), 2), 6, "one above what is served");
    assert_eq!(
        next_list_revision(Some(3), 5),
        6,
        "a rolled-back list served at 3 must not make the repair revision 4, which every \
         machine that saw 5 would refuse"
    );
    assert_eq!(next_list_revision(None, 4), 5, "a deleted list does not reset the line");
}

/// Alice writes the list twice (revisions 1 and 2) from this machine, then
/// someone puts revision 1 back WITH its signature. Her next change is refused
/// until it ACKNOWLEDGES the rolled-back revision (below); acknowledged, it is
/// the repair -- it says what happened, and the list it writes is revision 3,
/// above the mark; the mark follows it.
///
/// SABOTAGE: `next_list_revision` back to `served + 1` (the repair is then
/// written as revision 2, which this machine's own mark refuses).
#[test]
fn setting_the_list_raises_the_mark_and_reports_a_served_rollback() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    push(&reg, alice.path(), &workbook("v1"), SemVer::new(1, 0, 0), PushMode::CreateNew);
    let bob_key = keypair(TempDir::new().unwrap().path()).public_key_hex();
    let scope = scope_of(&dir);
    let entry = |key: &str| crate::calp_publishers::CoPublisherEntry { key: key.to_string(), name: "Bob".to_string() };

    let notice =
        crate::calp_publishers::set_co_publishers_core(&reg, &scope, alice.path(), PKG, &[entry(&bob_key)], None)
            .unwrap();
    assert_eq!(notice, "");
    assert_eq!(anchors(alice.path())[0].publishers_revision, 1, "the mark follows the list written");
    assert_eq!(anchors(alice.path())[0].anchored_by, calp::AnchoredBy::PublisherList);
    let rev1 = reg.read_application_artifact(PKG, calp::publishers::PUBLISHERS_FILE).unwrap().unwrap();
    let rev1_sig = reg.read_application_artifact(PKG, calp::publishers::PUBLISHERS_SIG_FILE).unwrap().unwrap();

    crate::calp_publishers::set_co_publishers_core(&reg, &scope, alice.path(), PKG, &[], None).unwrap();
    assert_eq!(anchors(alice.path())[0].publishers_revision, 2);

    // The rollback: revision 1, Bob and all, with its still-valid signature.
    reg.write_application_artifact(PKG, calp::publishers::PUBLISHERS_FILE, &rev1).unwrap();
    reg.write_application_artifact(PKG, calp::publishers::PUBLISHERS_SIG_FILE, &rev1_sig).unwrap();

    let notice = crate::calp_publishers::set_co_publishers_core(&reg, &scope, alice.path(), PKG, &[], Some(1))
        .expect("the creator's acknowledged repair is not blocked by the rollback it repairs");
    assert!(notice.contains("revision 1"), "{notice}");
    assert!(notice.contains("revision 2"), "{notice}");
    assert!(notice.contains("revision 3"), "{notice}");
    let root = keypair(alice.path()).public_key_hex();
    let written = calp::publishers::load_verified(&reg, PKG, &root).unwrap().unwrap();
    assert_eq!(written.revision, 3, "the repair must be above the mark, not served + 1");
    assert!(written.authorized_keys.is_empty(), "Bob came back");
    assert_eq!(anchors(alice.path())[0].publishers_revision, 3);
}

/// THE ROLLBACK LAUNDERED BY THE CREATOR'S OWN NEXT EDIT. Alice lists Bob
/// (revision 1), removes him (revision 2); Bob puts revision 1 back with its
/// still-valid signature. The editor builds the new list from the LISTING, so
/// the listing must not present revision 1 as the current list -- it reports it
/// apart, naming both revisions and whom it re-adds -- and a change that does
/// not acknowledge the rolled-back revision is REFUSED, writing nothing. When
/// Alice adds Carol from what she was shown, Bob stays out.
///
/// SABOTAGE (listing): drop the `anchor_root` check from
/// `list_co_publishers_core` (Bob is then listed as a current co-publisher).
/// SABOTAGE (set): accept `PublisherListRolledBack` without the acknowledgement
/// guard in `set_co_publishers_core`.
#[test]
fn a_rolled_back_list_is_never_the_base_of_the_creators_next_edit() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    push(&reg, alice.path(), &workbook("v1"), SemVer::new(1, 0, 0), PushMode::CreateNew);
    let bob_key = keypair(TempDir::new().unwrap().path()).public_key_hex();
    let carol_key = keypair(TempDir::new().unwrap().path()).public_key_hex();
    let scope = scope_of(&dir);
    let entry = |key: &str, name: &str| crate::calp_publishers::CoPublisherEntry {
        key: key.to_string(),
        name: name.to_string(),
    };
    crate::calp_publishers::set_co_publishers_core(&reg, &scope, alice.path(), PKG, &[entry(&bob_key, "Bob")], None)
        .unwrap();
    let rev1 = reg.read_application_artifact(PKG, calp::publishers::PUBLISHERS_FILE).unwrap().unwrap();
    let rev1_sig = reg.read_application_artifact(PKG, calp::publishers::PUBLISHERS_SIG_FILE).unwrap().unwrap();
    crate::calp_publishers::set_co_publishers_core(&reg, &scope, alice.path(), PKG, &[], None).unwrap();
    reg.write_application_artifact(PKG, calp::publishers::PUBLISHERS_FILE, &rev1).unwrap();
    reg.write_application_artifact(PKG, calp::publishers::PUBLISHERS_SIG_FILE, &rev1_sig).unwrap();

    // THE LISTING: revision 1 is not the current list.
    let listed = crate::calp_publishers::list_co_publishers_core(&reg, &scope, alice.path(), PKG);
    assert!(listed.co_publishers.is_empty(), "the rolled-back list was presented as current: {listed:?}");
    let rolled = listed.rolled_back.as_ref().expect("the rollback is reported");
    assert_eq!((rolled.served_revision, rolled.seen_revision), (1, 2));
    assert_eq!(rolled.served_co_publishers.len(), 1);
    assert_eq!(rolled.served_co_publishers[0].key, bob_key, "whom the served list re-adds is named");
    assert!(listed.problem.contains("revision 1") && listed.problem.contains("revision 2"), "{}", listed.problem);
    assert!(listed.you_are_the_root);

    // AN UNACKNOWLEDGED CHANGE IS REFUSED -- even one that re-adds nobody, and
    // one acknowledging another revision -- and writes nothing.
    let root = keypair(alice.path()).public_key_hex();
    for ack in [None, Some(2)] {
        let err = crate::calp_publishers::set_co_publishers_core(
            &reg,
            &scope,
            alice.path(),
            PKG,
            &[entry(&carol_key, "Carol")],
            ack,
        )
        .expect_err("a change on top of a rolled-back list the request did not acknowledge");
        assert!(err.starts_with("CALP_PUBLISHER_LIST_ROLLED_BACK"), "{err}");
        let still = calp::publishers::load_verified(&reg, PKG, &root).unwrap().unwrap();
        assert_eq!(still.revision, 1, "a refused change wrote the list");
    }

    // Acknowledged, from what the listing showed (no Bob): Carol only.
    crate::calp_publishers::set_co_publishers_core(
        &reg,
        &scope,
        alice.path(),
        PKG,
        &[entry(&carol_key, "Carol")],
        Some(1),
    )
    .expect("the acknowledged repair");
    let written = calp::publishers::load_verified(&reg, PKG, &root).unwrap().unwrap();
    assert_eq!(written.revision, 3);
    let keys: Vec<&str> = written.authorized_keys.iter().map(|k| k.key.as_str()).collect();
    assert_eq!(keys, vec![carol_key.as_str()], "Bob was signed back in");
    let listed = crate::calp_publishers::list_co_publishers_core(&reg, &scope, alice.path(), PKG);
    assert!(listed.rolled_back.is_none() && listed.problem.is_empty(), "{listed:?}");
    assert_eq!(listed.co_publishers.len(), 1);
}

/// A root the machine remembers differently refuses a list change too, as it
/// refuses a checkout or a push -- only a ROLLBACK is the creator's to repair.
/// Here this computer remembers someone else as the creator, and the workspace
/// now names this computer's own key: a re-created application, or a planted
/// one, and either way a person decides (Forget), not the list editor.
#[test]
fn a_contradicted_root_cannot_rewrite_the_list() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    push(&reg, alice.path(), &workbook("v1"), SemVer::new(1, 0, 0), PushMode::CreateNew);
    record(alice.path(), &dir, PKG, &"b2".repeat(32));

    let err = crate::calp_publishers::set_co_publishers_core(&reg, &scope_of(&dir), alice.path(), PKG, &[], None)
        .unwrap_err();
    assert!(err.starts_with("CALP_ANCHOR_CONTRADICTED "), "{err}");
    assert!(
        reg.read_application_artifact(PKG, calp::publishers::PUBLISHERS_FILE).unwrap().is_none(),
        "the list was written despite the contradiction"
    );
}

// ---------------------------------------------------------------------------
// Forget
// ---------------------------------------------------------------------------

fn record(profile: &Path, dir: &TempDir, application: &str, root: &str) {
    let scope = scope_of(dir);
    let gate = calp::AnchorGate {
        profile_dir: profile,
        scope: &scope,
        policy: calp::AnchorPolicy::RecordOnFirstContact { via: calp::AnchoredBy::Checkout },
    };
    let authority = calp::publishers::RootAnchoredPublishers {
        root_key: root.to_string(),
        root_name: "Alice".to_string(),
        root_version: "1.0.0".to_string(),
        list: None,
    };
    calp::developer_anchor::anchor_root(&gate, application, &authority).unwrap();
}

/// Forgetting removes ONLY that application's record in that workspace, and
/// ALWAYS leaves a `DeveloperAnchorForgotten` row, auditing off.
///
/// SABOTAGE: drop the `record_audit_event_with_extra(` call from
/// `forget_developer_anchor_core`.
#[test]
fn calp_forget_developer_anchor_core_removes_only_the_named_record_and_audits() {
    let prof = TempDir::new().unwrap();
    let ws = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let root = "a1".repeat(32);
    record(prof.path(), &ws, "sales", &root);
    record(prof.path(), &ws, "finance", &root);
    record(prof.path(), &other, "sales", &root);

    let state = crate::create_app_state();
    assert!(!state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    let forgotten =
        crate::calp_commands::forget_developer_anchor_core(&state, prof.path(), &location(&ws), "sales").unwrap();
    assert_eq!(forgotten, 1);

    let left = anchors(prof.path());
    assert_eq!(left.len(), 2, "{left:?}");
    assert!(left.iter().any(|a| a.application == "finance"));
    assert!(left.iter().any(|a| a.application == "sales" && a.scope_label == location(&other)));

    let log = state.audit_log.read().unwrap();
    assert_eq!(log.entries.len(), 1, "{:?}", log.entries);
    let row = &log.entries[0];
    assert!(matches!(row.event, calp::audit::AuditEvent::DeveloperAnchorForgotten));
    assert_eq!(row.extra["application"], "sales");
    assert_eq!(row.extra["workspace"], location(&ws).as_str());
    assert_eq!(row.extra["rootFingerprint"], key_fingerprint(&root).as_str());
    assert!(row.description.contains("Forgot"), "{}", row.description);
    drop(log);

    // Nothing to forget: no row, no error.
    assert_eq!(
        crate::calp_commands::forget_developer_anchor_core(&state, prof.path(), &location(&ws), "sales").unwrap(),
        0
    );
    assert_eq!(state.audit_log.read().unwrap().entries.len(), 1);
}

/// Forgetting a remembered creator reopens trust on first use for whatever
/// root the workspace names next, so only the MAIN window may ask for it.
/// Tauri app commands are not restricted per window by the capability files
/// (`capabilities/package-inspector.json` lists core permissions only), so
/// `require_label` is the only thing between another window and that hole --
/// and it must be the command's first statement, before anything is read.
///
/// SABOTAGE: replace the guard line with `let _ = &window;`.
#[test]
fn forgetting_a_developer_anchor_is_main_window_only() {
    let cmds = source("src/calp_commands.rs");
    let forget = body_of(&cmds, "pub fn calp_forget_developer_anchor(");
    let first = forget
        .lines()
        .skip_while(|l| !l.contains(") -> Result<"))
        .skip(1)
        .find(|l| !l.trim().is_empty())
        .expect("the command has a body");
    assert!(
        first.contains("require_label(&window, crate::security::window_guard::MAIN)?"),
        "calp_forget_developer_anchor's first statement is not the main-window guard: {first}"
    );
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/// The anchor reaches the dialog as a status string plus when and how it was
/// remembered; the anchor list never exposes the normalized scope id.
#[test]
fn the_anchor_reaches_the_dialog_and_the_list_in_its_wire_shape() {
    let (dir, alice, _mallory) = workspace_with_planted(&[]);
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let prof = TempDir::new().unwrap();
    let co = calp::checkout::checkout(&reg, PKG, None, NOW, &scope_of(&dir), prof.path()).unwrap();
    let wire = serde_json::to_value(crate::calp_commands::CheckoutSignerInfo::from_signer(&co.signer, false)).unwrap();
    assert_eq!(wire["anchor"]["status"], "firstContact");
    assert_eq!(wire["anchor"]["anchoredBy"], "checkout");
    assert!(wire["anchor"]["anchoredAt"].as_str().unwrap().starts_with("20"));
    let again = calp::checkout::checkout(&reg, PKG, None, NOW, &scope_of(&dir), prof.path()).unwrap();
    let wire = serde_json::to_value(crate::calp_commands::CheckoutSignerInfo::from_signer(&again.signer, false)).unwrap();
    assert_eq!(wire["anchor"]["status"], "matches");

    let (listed, error) = crate::calp_commands::developer_anchor_report(prof.path());
    assert_eq!(error, "");
    assert_eq!(listed.len(), 1);
    let listed = serde_json::to_value(&listed[0]).unwrap();
    assert_eq!(listed["application"], PKG);
    assert_eq!(listed["rootFingerprint"], key_fingerprint(&keypair(alice.path()).public_key_hex()).as_str());
    assert!(listed.get("scope").is_none(), "the normalized scope id is key material: {listed}");
    let cmds = source("src/calp_commands.rs");
    let report = body_of(&cmds, "fn developer_anchor_report(");
    assert!(report.contains("scope_label: a.scope_label.clone()"));
    assert!(!report.contains("a.scope.clone()"), "the anchor list exposes the scope id");

    // An unreadable store is REPORTED, never an empty list: it also blocks every
    // developer door until it is repaired, and the panel must say why.
    let broken = TempDir::new().unwrap();
    std::fs::write(calp::developer_anchor::developer_anchors_file_path(broken.path()), b"{ nope").unwrap();
    let (listed, error) = crate::calp_commands::developer_anchor_report(broken.path());
    assert!(listed.is_empty());
    assert!(error.contains("cannot be read"), "{error}");
}

// ---------------------------------------------------------------------------
// Who may RECORD an anchor
// ---------------------------------------------------------------------------

/// A developer anchor is created only where the USER acted: opening for
/// editing (core `checkout`), pushing (an update's gate, and a new
/// application's creator after core publish -- one helper shared by the
/// workbook push and the model publish), and changing the co-publisher list.
/// Every reader is `CheckOnly`. A new recording site must be a commit point
/// with a human behind it, and this list must say so.
///
/// SABOTAGE: switch the authorised reader to `RecordOnFirstContact`.
#[test]
fn only_checkout_push_and_list_edits_may_record_a_developer_anchor() {
    fn production(src: &str) -> String {
        src.split("#[cfg(test)]")
            .next()
            .unwrap()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }
    let files: [(&str, &str, usize); 8] = [
        ("core/calp/src/checkout.rs", include_str!("../../../core/calp/src/checkout.rs"), 1),
        // anchor_after_push only -- after core publish accepted the version
        // (calp_publish and calp_publish_model share it). The pre-assembly
        // gate, anchor_push_target, CHECKS: a refused push records nothing.
        ("calp_commands.rs", include_str!("calp_commands.rs"), 1),
        ("calp_publishers.rs", include_str!("calp_publishers.rs"), 1),
        ("calp_inspector.rs", include_str!("calp_inspector.rs"), 0),
        ("calp_merge.rs", include_str!("calp_merge.rs"), 0),
        ("held_button_code.rs", include_str!("held_button_code.rs"), 0),
        ("button_cells.rs", include_str!("button_cells.rs"), 0),
        // A promotion only CHECKS the anchor: moving a pointer is not the act
        // of opening, pushing or editing who may publish.
        ("calp_environments.rs", include_str!("calp_environments.rs"), 0),
    ];
    for (name, src, expected) in files {
        let count = production(src).matches("AnchorPolicy::RecordOnFirstContact").count();
        assert_eq!(
            count, expected,
            "{name} records a developer anchor in {count} place(s), expected {expected}. Recording \
             is for an act of the user (open for editing, push, change who may publish); a read \
             must stay CheckOnly."
        );
    }
    assert!(
        production(include_str!("calp_inspector.rs")).contains("AnchorPolicy::CheckOnly"),
        "the authorised reader must ask the anchor, under CheckOnly"
    );
    // Forgetting is one command's business.
    for (name, src, expected) in [
        ("calp_commands.rs", include_str!("calp_commands.rs"), 1usize),
        ("calp_inspector.rs", include_str!("calp_inspector.rs"), 0),
        ("calp_publishers.rs", include_str!("calp_publishers.rs"), 0),
    ] {
        assert_eq!(
            production(src).matches("developer_anchor::forget_anchor(").count(),
            expected,
            "{name}: forgetting a remembered creator must go through calp_forget_developer_anchor"
        );
    }
}
