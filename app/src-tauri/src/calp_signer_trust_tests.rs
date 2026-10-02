//! FILENAME: app/src-tauri/src/calp_signer_trust_tests.rs
//! PURPOSE: BUG-0262 on the app side. Every door that brings a published
//! version INTO A WORKING COPY checks who signed it against the application's
//! authorised publishers, anchored at the root, and fails closed.
//!
//! CONTEXT: A working copy is where a developer's next SIGNED push comes from.
//! Before this, checkout opened a version signed by ANY key (`VerifyOnly`
//! reports `NotPinned` and carries on, and the Checkout dialog threw even that
//! away), an unsigned lowest version made `root_key_of` answer "no root" which
//! the key check read as "nothing to enforce", and a push merge brought a new
//! head in on the strength of its signature alone — while a planted head is
//! exactly what makes a push stale and steers its author to "merge".
//!
//! The four doors:
//!
//! * checkout — `calp::checkout::checkout` itself refuses (core tests in
//!   `core/calp/src/checkout.rs` hold the behaviour); pinned here: the command
//!   calls it BEFORE its `DocumentEffect` and hands the signer to the dialog.
//! * merge analyze / apply — every published read in `calp_merge.rs` goes
//!   through `calp_inspector::open_authorized_content` (behaviour: the tests in
//!   `calp_merge.rs`, which reach its private diff helper).
//! * hold-back — the push dialog's write of BASE values goes through it too.
//!
//! `open_authorized_content` is exercised directly below against real signed
//! workspaces, because a source census cannot see a check that was neutered in
//! place.

use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::signing::{key_fingerprint, PublisherKeypair};
use calp::version::SemVer;
use calp::workspace::LocalWorkspace;

use engine::cell::Cell;
use persistence::{SavedCell, Sheet, Workbook};

/// The package name every fixture here publishes. Distinct from any real
/// application: `open_verified` reads this machine's pin store (read-only), and
/// a pin for a common name held from another workspace would only add a
/// name-conflict STATUS, never change the outcome — but a unique name keeps
/// the fixture's meaning obvious.
pub(crate) const PKG: &str = "bug0262-signer-trust";

pub(crate) fn keypair(prof: &Path) -> PublisherKeypair {
    PublisherKeypair::load_or_create(prof).unwrap()
}

pub(crate) fn workbook(text: &str) -> Workbook {
    let mut sheet = Sheet::new("Dashboard".to_string());
    sheet
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_text(text.to_string())));
    let mut wb = Workbook::default();
    wb.sheets = vec![sheet];
    wb
}

/// Publish `wb` as `PKG@version`, signed by the profile in `prof`.
pub(crate) fn push(reg: &LocalWorkspace, prof: &Path, wb: &Workbook, version: SemVer, mode: PushMode) {
    let request = PublishRequest {
        workbook: wb,
        package_name: PKG.to_string(),
        version,
        kind: "report".to_string(),
        mode,
        change_summary: "a change".to_string(),
        sheet_indices: vec![0],
        now: "2026-09-29T00:00:00Z".to_string(),
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

/// Re-sign an existing version with `kp` under `name` — how someone who can
/// write to the share plants a version. The signature is VALID for `kp`, so a
/// check that only asks "does it verify?" accepts it.
pub(crate) fn resign_as(reg: &LocalWorkspace, version: &str, kp: &PublisherKeypair, name: &str) {
    let mut ver = reg.get_version_manifest(PKG, version).unwrap();
    ver.publisher_key = kp.public_key_hex();
    ver.publisher_name = name.to_string();
    reg.write_version_manifest(PKG, version, &ver).unwrap();
    let dir = reg.version_dir(PKG, version).unwrap();
    let bytes = std::fs::read(dir.join(calp::integrity::VERSION_MANIFEST_FILE)).unwrap();
    std::fs::write(dir.join(calp::integrity::VERSION_MANIFEST_SIG_FILE), kp.sign(&bytes)).unwrap();
}

/// Alice publishes 1.0.0, 1.1.0 and 1.2.0; Mallory then re-signs the versions
/// named in `planted`. Returns (workspace dir, alice's profile, mallory's key).
pub(crate) fn workspace_with_planted(planted: &[&str]) -> (TempDir, TempDir, PublisherKeypair) {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let mallory = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let wb = workbook("v1");
    push(&reg, alice.path(), &wb, SemVer::new(1, 0, 0), PushMode::CreateNew);
    // Clones keep the SAME sheet id, so later versions are versions of one sheet.
    let mut wb2 = wb.clone();
    wb2.sheets[0]
        .cells
        .insert((1, 0), SavedCell::from_cell(&Cell::new_text("v1.1".to_string())));
    push(
        &reg,
        alice.path(),
        &wb2,
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );
    let mut wb3 = wb2.clone();
    wb3.sheets[0]
        .cells
        .insert((2, 0), SavedCell::from_cell(&Cell::new_text("v1.2".to_string())));
    push(
        &reg,
        alice.path(),
        &wb3,
        SemVer::new(1, 2, 0),
        PushMode::Update { expected_base: SemVer::new(1, 1, 0) },
    );
    let mallory_kp = keypair(mallory.path());
    for v in planted {
        resign_as(&reg, v, &mallory_kp, "mallory");
    }
    (dir, alice, mallory_kp)
}

pub(crate) fn location(dir: &TempDir) -> String {
    dir.path().to_string_lossy().to_string()
}

/// Plant a first version `version` BELOW every real one, signed by `kp` under
/// `name`: a copy of v1.0.0's manifest re-keyed and re-signed, listed in the
/// (unsigned) application manifest. Its signature is VALID, so
/// `root_anchored_publishers` proves it as the root -- what anyone who can
/// write to the share can do, and what only this machine's remembered root
/// (the developer anchor) can refuse. Carries no artifacts and needs none: it
/// is only ever consulted as "the first version".
pub(crate) fn plant_fake_root(reg: &LocalWorkspace, version: &str, kp: &PublisherKeypair, name: &str) {
    let mut ver = reg.get_version_manifest(PKG, "1.0.0").unwrap();
    ver.version = version.to_string();
    reg.write_version_manifest(PKG, version, &ver).unwrap();
    resign_as(reg, version, kp, name);
    let mut app = reg.get_application_manifest(PKG).unwrap();
    let mut entry = app.versions[0].clone();
    entry.version = version.to_string();
    entry.publisher_key = kp.public_key_hex();
    app.versions.insert(0, entry);
    reg.write_application_manifest(&app).unwrap();
}

// ---------------------------------------------------------------------------
// The authorised reader, behaviourally
// ---------------------------------------------------------------------------

/// The positive control: versions the root signed read normally.
#[test]
fn the_authorised_reader_opens_a_version_the_root_signed() {
    let (dir, _alice, _mallory) = workspace_with_planted(&[]);
    let (_reg, version, manifest) =
        crate::calp_inspector::open_authorized_content(&location(&dir), PKG, "=1.2.0", true, None)
            .expect("a version the root signed is authorised");
    assert_eq!(version, "1.2.0");
    assert!(!manifest.publisher_key.is_empty());
}

/// THE HOLE: a validly-signed version by a key the application never authorised.
/// `open_verified_content` — the reader the merge and the hold-back used —
/// accepts it; the authorised reader refuses it and names the signer.
///
/// SABOTAGE: have `open_authorized_content` return straight after
/// `open_verified_content` (drop the `authorize_signer` call).
#[test]
fn the_authorised_reader_refuses_a_planted_version_and_names_its_signer() {
    let (dir, _alice, mallory) = workspace_with_planted(&["1.2.0"]);

    // Precondition: the plain verified reader lets it through. That IS the
    // defect this reader exists to close.
    crate::calp_inspector::open_verified_content(&location(&dir), PKG, "=1.2.0", true)
        .expect("precondition: the planted version's signature and checksums verify");

    let err = match crate::calp_inspector::open_authorized_content(&location(&dir), PKG, "=1.2.0", true, None)
    {
        Ok(_) => panic!("a version signed by an unauthorised key must be refused"),
        Err(e) => e,
    };
    assert!(err.contains("not an authorised publisher"), "{err}");
    assert!(err.contains("mallory"), "the refusal names the signer: {err}");
    assert!(
        err.contains(&key_fingerprint(&mallory.public_key_hex())),
        "and their key fingerprint: {err}"
    );

    // The versions the root signed are untouched by the plant.
    crate::calp_inspector::open_authorized_content(&location(&dir), PKG, "=1.1.0", true, None)
        .expect("the root's own versions still read");
}

/// FAIL CLOSED: an UNSIGNED first version planted below the real ones used to
/// switch the whole check off ("no root" = "nothing to enforce"). Now it
/// refuses every read, the genuine versions included — there is no anchor left
/// to tell which ones are genuine.
#[test]
fn the_authorised_reader_fails_closed_on_an_unsigned_first_version() {
    let (dir, _alice, _mallory) = workspace_with_planted(&["1.2.0"]);
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let mut ver = reg.get_version_manifest(PKG, "1.0.0").unwrap();
    ver.version = "0.0.1".to_string();
    ver.publisher_key = String::new();
    reg.write_version_manifest(PKG, "0.0.1", &ver).unwrap();
    let mut app = reg.get_application_manifest(PKG).unwrap();
    let mut entry = app.versions[0].clone();
    entry.version = "0.0.1".to_string();
    entry.publisher_key = String::new();
    app.versions.insert(0, entry);
    reg.write_application_manifest(&app).unwrap();
    assert_eq!(
        calp::publishers::root_key_of(&reg, PKG).unwrap(),
        None,
        "precondition: the old anchor reads this as 'no root'"
    );

    for pin in ["=1.2.0", "=1.1.0"] {
        let err = match crate::calp_inspector::open_authorized_content(&location(&dir), PKG, pin, true, None)
        {
            Ok(_) => panic!("{pin}: an unverifiable root must refuse, not switch the check off"),
            Err(e) => e,
        };
        assert!(err.contains("cannot establish who may publish"), "{pin}: {err}");
        assert!(err.contains("v0.0.1") && err.contains("not signed"), "{pin}: {err}");
    }
}

// ---------------------------------------------------------------------------
// The doors, by placement
// ---------------------------------------------------------------------------

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

/// Every published version a merge reads — the head it brings in AND the base
/// it diffs against, in the analysis and in the apply — goes through the
/// authorised reader. A merge with one plain read left is a merge a planted
/// version can ride.
///
/// SABOTAGE: change any one of the four `open_authorized_content(` in
/// `calp_merge.rs` back to `open_verified_content(`.
#[test]
fn every_published_read_in_the_merge_is_the_authorised_one() {
    let merge = source("src/calp_merge.rs");
    let production = merge.split("#[cfg(test)]").next().unwrap();
    assert_eq!(
        production.matches("open_verified_content(").count(),
        0,
        "the merge reads a published version without the signer check"
    );
    assert_eq!(
        production.matches("calp_inspector::open_authorized_content(").count()
            + production.matches("calp_inspector::open_authorized_content_with_signer(").count(),
        4,
        "the base + head of the analysis diff, the base of the working-copy \
         diff, and the head the overlay writes in — four reads, four checks"
    );
    // ...and every one of them leaves a trail when it refuses the signer.
    assert_eq!(
        production.matches("Some((state, \"merge\"))").count(),
        4,
        "a merge read that refuses a signer without an audit row"
    );
    // Both commands reach the head through the checked diff before anything
    // is written.
    for command in ["pub fn calp_push_merge_analyze(", "pub fn calp_push_merge_apply("] {
        let body = body_of(production, command);
        assert!(
            body.contains("diff_head_against_base(&state, &ctx, &head_str)?"),
            "{command} no longer reads the head through the checked diff"
        );
    }
    let apply = body_of(production, "pub fn calp_push_merge_apply(");
    let checked = apply.find("diff_head_against_base(").unwrap();
    let write = apply.find("apply_script_modified_grids(").expect("the merge's write moved");
    let effect = apply.find("DocumentEffect::mutates(").expect("the merge's effect moved");
    assert!(checked < write && checked < effect, "the head is checked before anything is written");
}

/// The hold-back writes BASE values into the working copy that the push then
/// publishes, so its base read is the authorised one, and precedes the write.
///
/// SABOTAGE: change the hold-back's `open_authorized_content(` back to
/// `open_verified_content(`.
#[test]
fn the_hold_back_reads_its_base_through_the_authorised_reader() {
    let cmds = source("src/calp_commands.rs");
    let body = body_of(&cmds, "pub fn calp_hold_back_cells(");
    let read = body
        .find("calp_inspector::open_authorized_content(")
        .expect("the hold-back reads its base without the signer check");
    assert!(!body.contains("open_verified_content("), "a second, unchecked base read");
    let write = body.find("apply_script_modified_grids(").expect("the hold-back's write moved");
    assert!(read < write, "the base is checked before its values are written");
}

/// Checkout refuses in `calp::checkout` itself (behaviour: core tests). What
/// the COMMAND must do is prepare AND admit it before it constructs its
/// `DocumentEffect` -- a refusal after the effect would dirty a document it
/// did not change -- and hand the signer to the dialog rather than discarding
/// it.
///
/// SABOTAGE: move the `DocumentEffect::mutates` above
/// `calp::checkout::prepare_checkout(` (or above `pending.admit()`), or drop
/// `signer,` from the response.
#[test]
fn checkout_asks_before_its_effect_and_reports_the_signer() {
    let cmds = source("src/calp_commands.rs");
    let body = body_of(&cmds, "pub fn calp_checkout(");
    let checkout = body.find("calp::checkout::prepare_checkout(").expect("the checkout call moved");
    let admitted = body.find("pending.admit()").expect("the checkout is never admitted");
    let effect = body.find("DocumentEffect::mutates(").expect("the checkout's effect moved");
    assert!(checkout < effect, "the signer gate runs before the document is touched");
    assert!(admitted < effect, "the admission, which can still refuse, runs before the document is touched");
    assert!(
        body.contains("CheckoutSignerInfo::from_signer(\n        &checked_out.signer,"),
        "the signer the GATE authorised is what the dialog is shown"
    );
    let response = &body[body.find("Ok(CheckoutResponse {").expect("the response moved")..];
    assert!(response.contains("signer,"), "the response no longer carries the signer");
}

/// The wire shape the dialog reads, including the display-only "your key".
#[test]
fn the_signer_reaches_the_dialog_in_its_wire_shape() {
    let alice = TempDir::new().unwrap();
    let key = keypair(alice.path()).public_key_hex();
    let root = calp::AuthorizedSigner {
        key: key.clone(),
        name: "Alice".to_string(),
        role: calp::SignerRole::Root,
        listed_as: String::new(),
        root_key: key.clone(),
        root_name: "Alice".to_string(),
        anchor: calp::AnchorStatus::NotAnchored,
    };
    let wire = serde_json::to_value(crate::calp_commands::CheckoutSignerInfo::from_signer(&root, true))
        .unwrap();
    assert_eq!(wire["role"], "root");
    assert_eq!(wire["name"], "Alice");
    assert_eq!(wire["key"], key.as_str());
    assert_eq!(wire["fingerprint"], key_fingerprint(&key).as_str());
    assert_eq!(wire["rootFingerprint"], key_fingerprint(&key).as_str());
    assert_eq!(wire["isYourKey"], true);

    let delegate = calp::AuthorizedSigner {
        role: calp::SignerRole::CoPublisher,
        listed_as: "Bob".to_string(),
        name: "bob-laptop".to_string(),
        ..root
    };
    let wire = serde_json::to_value(crate::calp_commands::CheckoutSignerInfo::from_signer(&delegate, false))
        .unwrap();
    assert_eq!(wire["role"], "coPublisher");
    assert_eq!(wire["listedAs"], "Bob");
    assert_eq!(wire["isYourKey"], false);
}

// ---------------------------------------------------------------------------
// Refusals leave a trail (review finding: guardrail 6)
// ---------------------------------------------------------------------------

/// A CHECKOUT REFUSED FOR WHO SIGNED THE VERSION leaves an always-on
/// `SignerRefused` row naming the door, the version, the signer and their key
/// fingerprint -- with auditing OFF, the default. A planted version is exactly
/// what produces this refusal, so the row is evidence. Any other failure (here:
/// a version that does not exist) records nothing.
///
/// SABOTAGE: make `record_signer_refusal` return before recording (or drop its
/// call from `calp_checkout` -- the census below).
#[test]
fn a_checkout_refused_for_its_signer_leaves_a_signer_refused_row() {
    let (dir, _alice, mallory) = workspace_with_planted(&["1.2.0"]);
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(&location(&dir)).unwrap();
    let viewer = TempDir::new().unwrap();
    let refused = match calp::checkout::checkout(&reg, PKG, Some(SemVer::new(1, 2, 0)), "2026-09-30T00:00:00Z", &scope, viewer.path()) {
        Ok(_) => panic!("a planted version checked out"),
        Err(e) => e,
    };
    let state = crate::create_app_state();
    assert!(!state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    crate::calp_inspector::record_signer_refusal(&state, "checkout", PKG, "latest", &refused);
    // Not a statement about a signer: nothing recorded.
    crate::calp_inspector::record_signer_refusal(
        &state,
        "checkout",
        PKG,
        "9.9.9",
        &calp::CalpError::VersionNotFound { package: PKG.to_string(), version: "9.9.9".to_string() },
    );
    let log = state.audit_log.read().unwrap();
    assert_eq!(log.entries.len(), 1, "{:?}", log.entries);
    let row = &log.entries[0];
    assert!(matches!(row.event, calp::audit::AuditEvent::SignerRefused));
    assert_eq!(row.extra["door"], "checkout");
    assert_eq!(row.extra["version"], "1.2.0", "the version the refusal is about, as resolved");
    assert_eq!(row.extra["signer"], "mallory");
    assert_eq!(row.extra["signerFingerprint"], key_fingerprint(&mallory.public_key_hex()).as_str());
    assert!(row.description.contains("not an authorised publisher"), "{}", row.description);
}

/// The checkout command records the refusal before it returns it -- both
/// halves of the checkout (prepare, and the admission after its own gates)
/// refuse through the one closure that records -- and the hold-back hands its
/// door to the authorised reader.
///
/// SABOTAGE: delete the `record_signer_refusal(` call from `calp_checkout`'s
/// `refuse` closure; or map either half's error with anything but `&refuse`.
#[test]
fn checkout_and_the_hold_back_record_their_signer_refusals() {
    let cmds = source("src/calp_commands.rs");
    let checkout = body_of(&cmds, "pub fn calp_checkout(");
    let closure = checkout.find("let refuse = |refused").expect("calp_checkout's refusal closure moved");
    let call = checkout.find("calp::checkout::prepare_checkout(").unwrap();
    let recorded = checkout[closure..call]
        .find("record_signer_refusal(")
        .map(|i| i + closure)
        .expect("calp_checkout no longer records a signer refusal");
    let effect = checkout.find("DocumentEffect::mutates(").unwrap();
    assert!(recorded < effect, "recorded on the refusal path, before anything is written");
    assert!(checkout[recorded..].contains("\"checkout\","), "the door is named");
    let prepared = &checkout[call..];
    let prepared = &prepared[..prepared.find(";").unwrap()];
    assert!(prepared.contains(".map_err(&refuse)"), "a refused PREPARE is not recorded: {prepared}");
    assert!(
        checkout.contains("pending.admit().map_err(&refuse)?;"),
        "a refused ADMISSION is not recorded"
    );
    let hold_back = body_of(&cmds, "pub fn calp_hold_back_cells(");
    assert!(hold_back.contains("Some((&state, \"holdBack\"))"), "the hold-back's signer refusal leaves no trail");
}
