//! FILENAME: app/src-tauri/src/consent_seal_tests.rs
//! PURPOSE: Approvals sealed to this computer (M6 Task A, S1): the primitive,
//! the canonical bytes, the verified reader every gate reads through, the sealed
//! writer, the key's failure modes and concurrency, the guard on the consent
//! file, and the wire shared with @api/distributedConsent.
//! CONTEXT: A "computer" in a test is a profile directory: inside
//! `with_test_profile(dir, ..)` the key is `dir/consent-seal.key`, so two temp
//! directories are two computers. Every reader test goes through
//! `read_script_consent_file_in` / `list_script_consents_core` -- the functions
//! the gates call -- never through a pre-verified value, so a reader that
//! stopped verifying turns them red, not only the census.

use std::collections::HashMap;
use std::sync::{Arc, Barrier, Mutex};

use sha2::Digest;
use tempfile::TempDir;

use super::*;
use crate::calp_commands::{consent_granted_in, read_script_consent_file_in};
use crate::persistence::{
    create_virtual_file_core, delete_virtual_file_core, rename_virtual_file_core, FileState,
    UserFilesState,
};
use crate::profile_dir::with_test_profile;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn user_files() -> UserFilesState {
    UserFilesState { files: Mutex::new(HashMap::new()) }
}

/// SHA-256 hex computed WITHOUT `calp::integrity`, so a hash the code under
/// test computed wrongly cannot agree with it by construction.
fn independent_sha256(text: &str) -> String {
    sha2::Sha256::digest(text.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}

fn request(package: &str, scripts: &[(&str, &str)], caps: &[(&str, Option<&[&str]>)]) -> RecordScriptConsentRequest {
    RecordScriptConsentRequest {
        package_name: package.to_string(),
        scripts: scripts
            .iter()
            .map(|(id, source)| ConsentScriptInput { id: id.to_string(), source: source.to_string() })
            .collect(),
        granted_capabilities: caps
            .iter()
            .map(|(capability, origins)| CapabilityGrantWire {
                capability: capability.to_string(),
                origins: origins.map(|o| o.iter().map(|s| s.to_string()).collect()),
            })
            .collect(),
    }
}

/// Record on the computer whose profile is `computer`.
fn record_on(computer: &TempDir, files: &UserFilesState, req: RecordScriptConsentRequest) -> Result<(), String> {
    let file_state = FileState::default();
    with_test_profile(computer.path(), || record_script_consent_core(files, &file_state, req))
}

fn list_on(computer: &TempDir, files: &UserFilesState) -> ScriptConsentList {
    with_test_profile(computer.path(), || list_script_consents_core(files))
}

/// The gates' question, asked THROUGH the verified reader on `computer`.
fn granted_on(computer: &TempDir, files: &UserFilesState, package: &str, id: &str, source: &str) -> bool {
    with_test_profile(computer.path(), || {
        read_script_consent_file_in(files)
            .is_some_and(|file| consent_granted_in(&file, package, id, &independent_sha256(source)))
    })
}

fn raw(files: &UserFilesState) -> serde_json::Value {
    let guard = files.files.lock().unwrap();
    serde_json::from_slice(guard.get(SCRIPT_CONSENT_FILE).expect("a consent file")).unwrap()
}

fn raw_bytes(files: &UserFilesState) -> Option<Vec<u8>> {
    files.files.lock().unwrap().get(SCRIPT_CONSENT_FILE).cloned()
}

fn set_raw(files: &UserFilesState, value: &serde_json::Value) {
    files
        .files
        .lock()
        .unwrap()
        .insert(SCRIPT_CONSENT_FILE.to_string(), serde_json::to_vec(value).unwrap());
}

fn reasons(list: &ScriptConsentList) -> Vec<(String, IgnoredReason)> {
    list.ignored.iter().map(|i| (i.package_name.clone(), i.reason)).collect()
}

// ---------------------------------------------------------------------------
// The primitive and the canonical bytes
// ---------------------------------------------------------------------------

/// RFC 4231 test case 2: pins the HMAC-SHA256 primitive itself.
#[test]
fn hmac_matches_rfc_4231_test_case_2() {
    assert_eq!(
        hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
}

/// Two orders of the same approval seal to the same bytes, and a field boundary
/// can never be moved: id `a` with hash `1:b` is not id `a:1` with hash `b`.
///
/// SABOTAGE (c): join the fields with ':' and no length prefix.
#[test]
fn canonical_bytes_are_order_blind_and_length_prefixed() {
    let s = |id: &str, hash: &str| ConsentedScriptWire { id: id.into(), source_hash: hash.into(), source: None };
    let g = |cap: &str, origins: &[&str]| CapabilityGrantWire {
        capability: cap.into(),
        origins: Some(origins.iter().map(|o| o.to_string()).collect()),
    };
    assert_eq!(
        canonical_bytes("P", "t", &[s("x", "1"), s("y", "2")], &[]),
        canonical_bytes("P", "t", &[s("y", "2"), s("x", "1")], &[]),
        "the order the page listed the scripts in changed the seal"
    );
    assert_eq!(
        canonical_bytes("P", "t", &[], &[g("net.fetch", &["https://a", "https://b"]), g("storage", &[])]),
        canonical_bytes("P", "t", &[], &[g("storage", &[]), g("net.fetch", &["https://b", "https://a"])]),
        "the order of the grants or their origins changed the seal"
    );
    assert_ne!(
        canonical_bytes("P", "t", &[s("a", "1:b")], &[]),
        canonical_bytes("P", "t", &[s("a:1", "b")], &[]),
        "a field boundary moved without changing the bytes"
    );
    assert_ne!(canonical_bytes("Pt", "", &[], &[]), canonical_bytes("P", "t", &[], &[]));
    assert_ne!(
        canonical_bytes("P", "t", &[], &[g("a", &["b"])]),
        canonical_bytes("P", "t", &[], &[g("a", &[]), g("b", &[])]),
        "an origin moved into a capability without changing the bytes"
    );
}

// ---------------------------------------------------------------------------
// The verified reader
// ---------------------------------------------------------------------------

/// The positive control: what this computer sealed, this computer honours --
/// through the reader every gate calls.
#[test]
fn a_record_verifies_on_the_computer_that_sealed_it() {
    let a = TempDir::new().unwrap();
    let files = user_files();
    record_on(&a, &files, request("Acme", &[("m1", "Calcula.setCellValue('A1', 1);")], &[])).unwrap();

    assert!(granted_on(&a, &files, "Acme", "m1", "Calcula.setCellValue('A1', 1);"));
    let list = list_on(&a, &files);
    assert_eq!(list.consents.len(), 1);
    assert!(list.ignored.is_empty(), "{:?}", list.ignored);
    assert_eq!(list.consents[0].scripts[0].source.as_deref(), Some("Calcula.setCellValue('A1', 1);"));
}

/// A workbook handed over from another computer arrives with no approvals.
///
/// SABOTAGE (a): make `verify` return the raw record list.
/// SABOTAGE (g): make `read_script_consent_file_in` parse the raw bytes again.
#[test]
fn a_record_sealed_on_another_computer_is_ignored_as_other_computer() {
    let a = TempDir::new().unwrap();
    let b = TempDir::new().unwrap();
    let files = user_files();
    record_on(&a, &files, request("Acme", &[("m1", "run()")], &[])).unwrap();

    assert!(!granted_on(&b, &files, "Acme", "m1", "run()"), "another computer's approval counted here");
    let list = list_on(&b, &files);
    assert!(list.consents.is_empty());
    assert_eq!(reasons(&list), vec![("Acme".to_string(), IgnoredReason::OtherComputer)]);
    // ...and a computer that has never approved anything has no key at all.
    let never = TempDir::new().unwrap();
    assert_eq!(reasons(&list_on(&never, &files)), vec![("Acme".to_string(), IgnoredReason::OtherComputer)]);
    assert!(!never.path().join(CONSENT_SEAL_KEY_FILE).exists(), "reading minted a key");
}

/// The module gate itself, fed by the verified reader: an application's macro
/// approved on another computer is refused here, and runs on the computer that
/// approved it.
#[test]
fn a_module_approved_on_another_computer_is_refused_by_the_module_gate() {
    let a = TempDir::new().unwrap();
    let b = TempDir::new().unwrap();
    let files = user_files();
    let source = "Calcula.setCellValue('A1', 1);";
    record_on(&b, &files, request("Acme", &[("macro-1", source)], &[])).unwrap();
    let scripts = vec![(Some("Acme".to_string()), "macro-1".to_string(), source.to_string())];

    let here = with_test_profile(a.path(), || {
        let file = read_script_consent_file_in(&files);
        crate::scripting::commands::distributed_module_refusal(&scripts, file.as_ref(), source)
    });
    assert!(here.is_some(), "a macro approved on another computer ran here");
    let there = with_test_profile(b.path(), || {
        let file = read_script_consent_file_in(&files);
        crate::scripting::commands::distributed_module_refusal(&scripts, file.as_ref(), source)
    });
    assert_eq!(there, None, "the computer that approved it refused it");
}

/// Pre-M6 files and records without a seal count for nothing.
#[test]
fn a_version_1_file_and_an_unsealed_record_are_ignored_as_unsealed() {
    let a = TempDir::new().unwrap();
    let files = user_files();
    set_raw(
        &files,
        &serde_json::json!({ "version": 1, "consents": [{
            "packageName": "Acme",
            "scripts": [{ "id": "m1", "sourceHash": independent_sha256("run()"), "source": "run()" }],
            "grantedCapabilities": [],
            "grantedAt": "2026-01-01T00:00:00.000Z"
        }]}),
    );
    assert!(!granted_on(&a, &files, "Acme", "m1", "run()"));
    assert_eq!(reasons(&list_on(&a, &files)), vec![("Acme".to_string(), IgnoredReason::Unsealed)]);

    // A record THIS computer sealed, in a file that says version 1.
    let fresh = user_files();
    record_on(&a, &fresh, request("Acme", &[("m1", "run()")], &[])).unwrap();
    let mut v1 = raw(&fresh);
    v1["version"] = serde_json::json!(1);
    set_raw(&fresh, &v1);
    assert!(!granted_on(&a, &fresh, "Acme", "m1", "run()"));
    assert_eq!(reasons(&list_on(&a, &fresh)), vec![("Acme".to_string(), IgnoredReason::Unsealed)]);

    // A version-2 file whose record lost its seal.
    let unsealed = user_files();
    record_on(&a, &unsealed, request("Acme", &[("m1", "run()")], &[])).unwrap();
    let mut no_seal = raw(&unsealed);
    no_seal["consents"][0].as_object_mut().unwrap().remove("seal");
    set_raw(&unsealed, &no_seal);
    assert!(!granted_on(&a, &unsealed, "Acme", "m1", "run()"));
    assert_eq!(reasons(&list_on(&a, &unsealed)), vec![("Acme".to_string(), IgnoredReason::Unsealed)]);
}

/// Every field an approval means something by is under the seal.
///
/// SABOTAGE (b): make the MAC cover packageName and the scripts only -- the
/// grantedAt, capability and origin rows go red.
#[test]
fn every_field_is_under_the_seal() {
    let a = TempDir::new().unwrap();
    let base = user_files();
    record_on(
        &a,
        &base,
        request("Acme", &[("m1", "run()")], &[("net.fetch", Some(&["https://ok.example"])), ("storage", None)]),
    )
    .unwrap();
    let sealed = raw(&base);
    assert!(list_on(&a, &base).ignored.is_empty(), "the untouched record must verify");

    type Tamper = Box<dyn Fn(&mut serde_json::Value)>;
    let rows: Vec<(&str, Tamper)> = vec![
        ("packageName", Box::new(|r: &mut serde_json::Value| r["packageName"] = serde_json::json!("Acme Corp"))),
        (
            "a sourceHash (with a matching retained source)",
            Box::new(|r: &mut serde_json::Value| {
                r["scripts"][0]["sourceHash"] = serde_json::json!(independent_sha256("steal()"));
                r["scripts"][0]["source"] = serde_json::json!("steal()");
            }),
        ),
        (
            "an added script",
            Box::new(|r: &mut serde_json::Value| {
                r["scripts"].as_array_mut().unwrap().push(serde_json::json!({
                    "id": "m2", "sourceHash": independent_sha256("steal()"), "source": "steal()"
                }))
            }),
        ),
        (
            "an added capability",
            Box::new(|r: &mut serde_json::Value| r["grantedCapabilities"].as_array_mut().unwrap().push(serde_json::json!({ "capability": "bi.query" }))),
        ),
        (
            "an added origin",
            Box::new(|r: &mut serde_json::Value| {
                let grants = r["grantedCapabilities"].as_array_mut().unwrap();
                let fetch = grants.iter_mut().find(|g| g["capability"] == "net.fetch").unwrap();
                fetch["origins"].as_array_mut().unwrap().push(serde_json::json!("https://evil.example"));
            }),
        ),
        ("grantedAt", Box::new(|r: &mut serde_json::Value| r["grantedAt"] = serde_json::json!("2099-01-01T00:00:00.000Z"))),
        ("a retained source", Box::new(|r: &mut serde_json::Value| r["scripts"][0]["source"] = serde_json::json!("steal()"))),
    ];
    // Every row is checked before anything is reported, so one sabotage shows
    // EVERY field it left unsealed, not only the first.
    let mut honoured = Vec::new();
    for (what, tamper) in rows {
        let files = user_files();
        let mut file = sealed.clone();
        tamper(&mut file["consents"][0]);
        set_raw(&files, &file);
        let list = list_on(&a, &files);
        let refused = list.consents.is_empty()
            && list.ignored.len() == 1
            && list.ignored[0].reason == IgnoredReason::Altered
            && !granted_on(&a, &files, "Acme", "m1", "run()")
            && !granted_on(&a, &files, "Acme", "m1", "steal()")
            && !granted_on(&a, &files, "Acme Corp", "m1", "run()");
        if !refused {
            honoured.push(what);
        }
    }
    assert!(honoured.is_empty(), "tampering with these left the record honoured: {honoured:?}");

    // The computer it names is not a field an attacker gets to choose either.
    let files = user_files();
    let mut file = sealed.clone();
    file["consents"][0]["keyId"] = serde_json::json!("0000000000000000");
    set_raw(&files, &file);
    assert_eq!(reasons(&list_on(&a, &files)), vec![("Acme".to_string(), IgnoredReason::OtherComputer)]);
}

// ---------------------------------------------------------------------------
// The sealed writer
// ---------------------------------------------------------------------------

/// Rust computes every hash from the source; a record replaces only THIS
/// computer's record for the same application.
#[test]
fn recording_computes_hashes_from_the_source_and_replaces_only_this_computers_record() {
    let a = TempDir::new().unwrap();
    let b = TempDir::new().unwrap();
    let files = user_files();
    record_on(&a, &files, request("Acme", &[("s1", "v1()")], &[])).unwrap();
    record_on(&b, &files, request("Acme", &[("s1", "vB()")], &[])).unwrap();
    record_on(&a, &files, request("Other", &[("o1", "other()")], &[])).unwrap();
    record_on(&a, &files, request("Acme", &[("s1", "v2()")], &[])).unwrap();

    let file = raw(&files);
    assert_eq!(file["version"], serde_json::json!(CONSENT_FILE_VERSION));
    let records = file["consents"].as_array().unwrap();
    assert_eq!(records.len(), 3, "{records:#?}");
    let key_ids: std::collections::BTreeSet<&str> =
        records.iter().map(|r| r["keyId"].as_str().unwrap()).collect();
    assert_eq!(key_ids.len(), 2, "two computers wrote this file");
    for record in records {
        for script in record["scripts"].as_array().unwrap() {
            assert_eq!(
                script["sourceHash"].as_str().unwrap(),
                independent_sha256(script["source"].as_str().unwrap()),
                "a hash that is not SHA-256 of the source it sits beside"
            );
        }
        assert!(record["grantedAt"].as_str().unwrap().ends_with('Z'));
    }

    assert!(granted_on(&a, &files, "Acme", "s1", "v2()"));
    assert!(!granted_on(&a, &files, "Acme", "s1", "v1()"), "the replaced record still counts");
    assert!(!granted_on(&a, &files, "Acme", "s1", "vB()"), "the other computer's record counts here");
    assert!(granted_on(&a, &files, "Other", "o1", "other()"));
    assert!(granted_on(&b, &files, "Acme", "s1", "vB()"), "this computer replaced the other computer's record");
    assert_eq!(reasons(&list_on(&a, &files)), vec![("Acme".to_string(), IgnoredReason::OtherComputer)]);
}

#[test]
fn recording_refuses_an_empty_list_and_duplicate_ids() {
    let a = TempDir::new().unwrap();
    let files = user_files();
    for (what, req) in [
        ("an empty list", request("Acme", &[], &[])),
        ("duplicate ids", request("Acme", &[("m1", "a()"), ("m1", "b()")], &[])),
        ("an empty id", request("Acme", &[("", "a()")], &[])),
        ("no application", request("  ", &[("m1", "a()")], &[])),
    ] {
        let file_state = FileState::default();
        let result = with_test_profile(a.path(), || record_script_consent_core(&files, &file_state, req));
        assert!(result.is_err(), "{what} was recorded");
        assert!(!file_state.is_dirty(), "{what}: a refusal dirtied the document");
        assert!(raw_bytes(&files).is_none(), "{what}: a refusal wrote the file");
    }
    assert!(!a.path().join(CONSENT_SEAL_KEY_FILE).exists(), "a refused request minted a key");
}

/// An approval is saved state and dirties the document; listing approvals is a
/// read. The listing half is a SOURCE check, because it is the only half that
/// can fail: `list_script_consents_core` is handed no `FileState` at all, so a
/// runtime "is it still clean?" assertion could never go red. What could make
/// a listing dirty the document is the command or the core growing a
/// `FileState` and constructing an effect -- and that is what this reads for.
///
/// SABOTAGE: give `list_script_consents` a `FileState` and construct
/// `DocumentEffect::mutates` in it.
#[test]
fn record_script_consent_dirties_the_document_and_list_script_consents_does_not() {
    let a = TempDir::new().unwrap();
    let files = user_files();
    let file_state = FileState::default();
    with_test_profile(a.path(), || {
        record_script_consent_core(&files, &file_state, request("Acme", &[("m1", "run()")], &[])).unwrap();
    });
    assert!(file_state.is_dirty(), "an approval is saved state and must dirty the document");
    assert_eq!(list_on(&a, &files).consents.len(), 1);

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let text = std::fs::read_to_string(root.join("consent_seal.rs")).unwrap();
    for signature in ["pub fn list_script_consents(", "pub(crate) fn list_script_consents_core("] {
        let body = fn_body(&text, signature);
        assert!(!body.contains("DocumentEffect"), "`{signature}` constructs a document effect: a listing would dirty the document");
        assert!(!body.contains("FileState"), "`{signature}` is handed the FileState: a listing could dirty the document");
    }
}

/// A record for this application that NO computer sealed (a version-1 approval,
/// or one stripped of its key id or seal) counts for nothing anywhere, so a new
/// approval drops it instead of carrying it into the sealed file -- where the
/// screen would read the application as approved AND unsealed at once. Another
/// application's records are never touched.
///
/// SABOTAGE: keep every record whose keyId is not this computer's (the old
/// retain).
#[test]
fn recording_drops_this_applications_unsealed_records() {
    let a = TempDir::new().unwrap();
    let files = user_files();
    let unsealed = |package: &str| {
        serde_json::json!({
            "packageName": package,
            "scripts": [{ "id": "m1", "sourceHash": independent_sha256("run()"), "source": "run()" }],
            "grantedCapabilities": [],
            "grantedAt": "2026-01-01T00:00:00.000Z"
        })
    };
    // A version-2 record that lost its seal, beside two version-1 ones.
    let mut stripped = unsealed("Acme");
    stripped["keyId"] = serde_json::json!("0123456789abcdef");
    set_raw(&files, &serde_json::json!({ "version": 1, "consents": [unsealed("Acme"), stripped, unsealed("Beta")] }));
    assert_eq!(
        reasons(&list_on(&a, &files)),
        vec![
            ("Acme".to_string(), IgnoredReason::Unsealed),
            ("Acme".to_string(), IgnoredReason::Unsealed),
            ("Beta".to_string(), IgnoredReason::Unsealed),
        ],
        "precondition"
    );

    record_on(&a, &files, request("Acme", &[("m1", "run()")], &[])).unwrap();

    let list = list_on(&a, &files);
    assert_eq!(list.consents.iter().map(|c| c.package_name.as_str()).collect::<Vec<_>>(), vec!["Acme"]);
    assert_eq!(
        reasons(&list),
        vec![("Beta".to_string(), IgnoredReason::Unsealed)],
        "the application is reported as approved and unsealed at once"
    );
    let file = raw(&files);
    let records = file["consents"].as_array().unwrap();
    assert_eq!(records.iter().filter(|r| r["packageName"] == "Acme").count(), 1, "{records:#?}");
    assert_eq!(
        records.iter().filter(|r| r["packageName"] == "Beta").count(),
        1,
        "another application's record was touched: {records:#?}"
    );
    assert!(granted_on(&a, &files, "Acme", "m1", "run()"));
}

/// An approval of BUTTON code names its bytes: `buttonAction:` + sha256 of the
/// exact source. A request whose id names other bytes than the source beside it
/// is refused -- sealed, it would be listed as an approval of one piece of code
/// showing another. The two requests come from the wire fixture, so the
/// TypeScript double is held to the same case
/// (distributedConsentSealedWire.test.ts).
///
/// SABOTAGE: drop the button-code check from `validate_request`.
#[test]
fn a_button_action_approval_must_name_the_bytes_it_shows() {
    let fixture = wire_fixture();
    let matched: RecordScriptConsentRequest =
        serde_json::from_value(fixture["buttonAction"]["matched"].clone()).expect("the matched request");
    let mismatched: RecordScriptConsentRequest =
        serde_json::from_value(fixture["buttonAction"]["mismatched"].clone()).expect("the mismatched request");
    assert_eq!(
        matched.scripts[0].id,
        crate::scripting::control_action::button_action_consent_id(&matched.scripts[0].source),
        "the fixture's id must be the one Rust forms for its source"
    );
    assert_eq!(matched.scripts[0].id, mismatched.scripts[0].id, "precondition: one id, two sources");

    let a = TempDir::new().unwrap();
    let files = user_files();
    let file_state = FileState::default();
    let err = with_test_profile(a.path(), || record_script_consent_core(&files, &file_state, mismatched.clone()))
        .expect_err("an approval naming one piece of button code while showing another was sealed");
    assert!(err.contains("button code"), "{err}");
    assert!(raw_bytes(&files).is_none(), "a refused approval wrote the file");
    assert!(!file_state.is_dirty(), "a refused approval dirtied the document");

    record_on(&a, &files, matched.clone()).expect("the matched approval is sealed");
    let id = matched.scripts[0].id.as_str();
    assert!(granted_on(&a, &files, &matched.package_name, id, "Report();"));
    assert!(!granted_on(&a, &files, &matched.package_name, id, "Exfiltrate();"));
    // An ordinary id is not held to the rule: only the reserved prefix names bytes.
    record_on(&a, &files, request("Acme", &[("macro-buttonAction:x", "run()")], &[])).expect("an ordinary id");
}

/// One files guard across the whole read-modify-write: two approvals landing
/// at once both survive.
///
/// SABOTAGE: read the file under one guard, drop it, and write under another.
#[test]
fn two_record_calls_on_two_threads_lose_no_record() {
    // Both threads use the test process's own (pre-minted) computer: the
    // thread-local profile override does not cross a spawn.
    let files = Arc::new(user_files());
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|t| {
            let files = Arc::clone(&files);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                for i in 0..40 {
                    let file_state = FileState::default();
                    record_script_consent_core(
                        &files,
                        &file_state,
                        request(&format!("App {t}-{i}"), &[("m", "run()")], &[]),
                    )
                    .unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let recorded = raw(&files)["consents"].as_array().unwrap().len();
    assert_eq!(recorded, 80, "approvals recorded at the same time were lost");
    assert_eq!(list_script_consents_core(&files).consents.len(), 80);
}

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

/// A key that exists but cannot be read voids nothing silently: reads report
/// every record as `keyUnavailable`, and a write is refused naming the repair --
/// never a fresh key that would void every approval on the computer.
///
/// SABOTAGE (d): mint a new key when the stored one is damaged.
#[test]
fn a_damaged_key_fails_closed_both_ways() {
    let a = TempDir::new().unwrap();
    let files = user_files();
    record_on(&a, &files, request("Acme", &[("m1", "run()")], &[])).unwrap();
    let before = raw_bytes(&files).unwrap();
    let key_path = a.path().join(CONSENT_SEAL_KEY_FILE);
    std::fs::write(&key_path, b"short").unwrap();

    let list = list_on(&a, &files);
    assert!(list.consents.is_empty());
    assert_eq!(reasons(&list), vec![("Acme".to_string(), IgnoredReason::KeyUnavailable)]);
    assert!(!granted_on(&a, &files, "Acme", "m1", "run()"));

    let file_state = FileState::default();
    let err = with_test_profile(a.path(), || {
        record_script_consent_core(&files, &file_state, request("Beta", &[("b1", "go()")], &[]))
    })
    .unwrap_err();
    assert!(err.contains("delete"), "the refusal does not name the repair: {err}");
    assert!(err.contains(CONSENT_SEAL_KEY_FILE), "the refusal does not say what to delete: {err}");
    assert_eq!(raw_bytes(&files).unwrap(), before, "a refused approval changed the file");
    assert!(!file_state.is_dirty());
    assert_eq!(std::fs::read(&key_path).unwrap(), b"short", "the damaged key was replaced");
}

/// Two threads approving for the first time on one computer end with ONE key.
///
/// SABOTAGE (e): drop the OS lock and the process mutex from `get_or_mint_key`.
#[test]
fn two_threads_minting_at_once_end_with_one_key() {
    for round in 0..20 {
        let dir = TempDir::new().unwrap();
        let threads = 8;
        let barrier = Arc::new(Barrier::new(threads));
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                let dir = dir.path().to_path_buf();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    get_or_mint_key(&FileKeyStore::new(&dir)).map(|k| k.id())
                })
            })
            .collect();
        let ids: Vec<Result<String, String>> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let first = ids[0].clone().unwrap_or_else(|e| panic!("round {round}: {e}"));
        for id in &ids {
            assert_eq!(id.as_ref().ok(), Some(&first), "round {round}: two keys were minted: {ids:?}");
        }
        match FileKeyStore::new(dir.path()).read() {
            KeyLookup::Present(k) => assert_eq!(k.id(), first, "round {round}"),
            other => panic!("round {round}: {other:?}"),
        }
    }
}

/// ANOTHER CALCULA holds the mint lock: a first approval here waits for it.
///
/// SABOTAGE: drop the `file.lock()` call from `lock_for_minting`.
#[test]
fn another_process_holding_the_seal_lock_makes_a_mint_wait() {
    let dir = TempDir::new().unwrap();
    let other = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.path().join(CONSENT_SEAL_LOCK_FILE))
        .unwrap();
    other.lock().unwrap();
    let minting = {
        let dir = dir.path().to_path_buf();
        std::thread::spawn(move || get_or_mint_key(&FileKeyStore::new(&dir)).map(|k| k.id()))
    };
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert!(
        !dir.path().join(CONSENT_SEAL_KEY_FILE).exists(),
        "a key was minted while another process held the lock"
    );
    drop(other);
    minting.join().unwrap().expect("the mint lands once the lock is released");
    assert!(dir.path().join(CONSENT_SEAL_KEY_FILE).exists());
}

/// The production store, against the real Credential Manager under a
/// throwaway target (deleted on the way out, panics included).
#[test]
fn the_credential_manager_store_round_trips_a_key() {
    struct Cleanup(CredentialKeyStore);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.delete();
        }
    }
    let lock_dir = TempDir::new().unwrap();
    let target = format!(
        "Calcula:consent-seal-unit-test|{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    );
    let store = Cleanup(CredentialKeyStore::new(&target, lock_dir.path()));
    assert!(matches!(store.0.read(), KeyLookup::Absent), "a fresh target must read as absent");
    let minted = get_or_mint_key(&store.0).expect("mint into the Credential Manager");
    match store.0.read() {
        KeyLookup::Present(k) => assert_eq!(k.id(), minted.id()),
        other => panic!("the stored key did not read back: {other:?}"),
    }
    assert_eq!(get_or_mint_key(&store.0).unwrap().id(), minted.id(), "a second call minted again");
}

/// WHERE THE APP KEEPS THE KEY, which the whole seal rests on. A test build
/// keeps it in a file (each temp profile is a "computer"), so nothing at run
/// time can see the app's choice; this pins it twice. The store the app uses
/// is, by its TYPE, the Credential Manager's, under the one target, with the
/// mint lock in the profile; and `machine_store`'s app branch returns exactly
/// that store -- never a `FileKeyStore`, whose key file the page could read
/// and overwrite (`read_text_file` / `write_text_file`) to forge seals. The
/// one production construction of a `FileKeyStore` is `machine_store`'s
/// test branch.
///
/// SABOTAGE: return `Box::new(FileKeyStore::new(&crate::profile_dir::resolve()))`
/// from `machine_store`'s `#[cfg(not(test))]` branch (a reviewer did exactly
/// this before the test existed: 135 tests passed and `cargo check` was clean).
#[test]
fn the_app_keeps_the_approvals_key_in_the_credential_manager_never_in_a_file() {
    let store = app_key_store();
    assert_eq!(store.target(), CONSENT_SEAL_CREDENTIAL_TARGET);
    assert_eq!(store.lock_dir(), crate::profile_dir::resolve(), "the mint lock is not in the profile");
    assert!(
        store.repair_hint().contains("Credential Manager"),
        "the repair sentence names the wrong place: {}",
        store.repair_hint()
    );

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let text = std::fs::read_to_string(root.join("consent_seal.rs")).unwrap();
    let code = |s: &str| -> String {
        s.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
    };
    let body = code(fn_body(&text, "fn machine_store("));
    assert_eq!(body.matches("#[cfg(not(test))]").count(), 1, "machine_store must have ONE app branch:\n{body}");
    let at = body.find("#[cfg(not(test))]").unwrap();
    let (test_branch, app_branch) = body.split_at(at);
    assert!(app_branch.contains("Box::new(app_key_store())"), "the app does not use the Credential Manager store:\n{app_branch}");
    assert!(!app_branch.contains("FileKeyStore"), "the app keeps its approvals key in a FILE:\n{app_branch}");
    assert!(test_branch.contains("#[cfg(test)]") && test_branch.contains("FileKeyStore::new("));
    let maker = code(fn_body(&text, "pub(crate) fn app_key_store("));
    assert!(
        maker.contains("CredentialKeyStore::new(CONSENT_SEAL_CREDENTIAL_TARGET,"),
        "app_key_store does not build the one Credential Manager target:\n{maker}"
    );

    // No other production code builds a key FILE store (profile_dir's pre-mint
    // sits in a `#[cfg(test)]` module, which `production_part` removes).
    let mut builders = Vec::new();
    for path in rust_sources(&root) {
        let source = std::fs::read_to_string(&path).unwrap();
        for line in production_part(&source).lines() {
            if !line.trim_start().starts_with("//") && line.contains("FileKeyStore::new(") {
                builders.push((relative(&root, &path), line.trim().to_string()));
            }
        }
    }
    assert_eq!(
        builders,
        vec![("consent_seal.rs".to_string(), "Box::new(FileKeyStore::new(&crate::profile_dir::resolve()))".to_string())],
        "a key FILE store is built outside machine_store's test branch"
    );
}

/// An approval survives a real `.cala` save and load ON THE COMPUTER THAT
/// SEALED IT, and counts for nothing on another one: the seal covers only what
/// the file carries, and the key never travels with it.
///
/// SABOTAGE: have `calcula_format`'s writer skip the user files under
/// `.calcula/` (core/calcula-format/src/zip_io.rs) -- the approval is then lost
/// in the round trip.
#[test]
fn a_sealed_approval_survives_a_cala_save_and_load_on_this_computer_only() {
    let a = TempDir::new().unwrap();
    let b = TempDir::new().unwrap();
    let files = user_files();
    record_on(&a, &files, request("Acme", &[("m1", "Calcula.setCellValue('A1', 1);")], &[("storage", None)])).unwrap();

    let mut workbook = ::persistence::Workbook::new();
    workbook.user_files = files.files.lock().unwrap().clone();
    let bytes = calcula_format::write_calcula_bytes(&workbook).expect("save");
    let loaded = calcula_format::read_calcula_bytes(&bytes).expect("load");
    let reopened = UserFilesState { files: Mutex::new(loaded.user_files) };

    assert_eq!(
        raw_bytes(&reopened),
        raw_bytes(&files),
        "the approvals file did not come back byte for byte"
    );
    assert!(
        granted_on(&a, &reopened, "Acme", "m1", "Calcula.setCellValue('A1', 1);"),
        "an approval this computer sealed no longer counts after a save and a load"
    );
    assert!(
        !granted_on(&b, &reopened, "Acme", "m1", "Calcula.setCellValue('A1', 1);"),
        "a saved approval counts on another computer"
    );
    assert_eq!(reasons(&list_on(&b, &reopened)), vec![("Acme".to_string(), IgnoredReason::OtherComputer)]);
}

/// The production target cannot be produced by any other Calcula credential
/// maker the page can reach: each of them puts a '|' after its prefix.
#[test]
fn the_consent_seal_target_cannot_be_produced_by_another_credential_maker() {
    assert!(!CONSENT_SEAL_CREDENTIAL_TARGET.contains('|'));
    for made in [
        crate::file_keychain::make_target("consent-seal"),
        crate::file_keychain::make_target(""),
        crate::bi::credential_cache::make_target("consent-seal", ""),
        crate::bi::credential_cache::make_target("", ""),
        crate::ai::providers::credential_target("consent-seal"),
        crate::ai::providers::credential_target(""),
    ] {
        assert!(made.contains('|'), "{made} has no '|'");
        assert!(!made.eq_ignore_ascii_case(CONSENT_SEAL_CREDENTIAL_TARGET), "{made}");
    }
    // A NEW credential writer has to be added above, with its maker.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut writers = Vec::new();
    for path in rust_sources(&root) {
        let text = std::fs::read_to_string(&path).unwrap();
        if production_part(&text).contains("CredWriteW(") {
            writers.push(relative(&root, &path));
        }
    }
    writers.sort();
    assert_eq!(
        writers,
        vec!["ai/mod.rs", "bi/credential_cache.rs", "consent_seal.rs", "file_keychain.rs"],
        "a new Credential Manager writer: add its target maker to this test"
    );
}

// ---------------------------------------------------------------------------
// The consent file is not a file the page writes
// ---------------------------------------------------------------------------

/// SABOTAGE (f): remove the guard from `create_virtual_file_core` /
/// `rename_virtual_file_core`.
#[test]
fn the_consent_file_cannot_be_created_or_renamed_onto() {
    let files = user_files();
    let file_state = FileState::default();
    let planted = r#"{"version":2,"consents":[]}"#;
    for spelling in [
        SCRIPT_CONSENT_FILE,
        ".calcula\\script-consent.json",
        "./.calcula/script-consent.json",
        "/.calcula//script-consent.json",
        ".CALCULA/Script-Consent.JSON",
        " .calcula/script-consent.json ",
    ] {
        let err = create_virtual_file_core(&files, &file_state, spelling, Some(planted.to_string()))
            .expect_err(spelling);
        assert!(err.contains("approval screen"), "{spelling}: {err}");
    }
    assert!(files.files.lock().unwrap().is_empty(), "a spelling of the consent file was written");
    assert!(!file_state.is_dirty());

    // The positive control: an ordinary user file is still written.
    create_virtual_file_core(&files, &file_state, ".calcula/notes.json", Some(planted.to_string())).unwrap();
    assert!(file_state.is_dirty());

    // A single file renamed onto it.
    let renamed = FileState::default();
    let err = rename_virtual_file_core(&files, &renamed, ".calcula/notes.json", SCRIPT_CONSENT_FILE).unwrap_err();
    assert!(err.contains("approval screen"), "{err}");
    assert!(files.files.lock().unwrap().contains_key(".calcula/notes.json"), "the refused rename moved the file");
    assert!(!renamed.is_dirty());

    // A folder renamed so that one of its files lands on it.
    create_virtual_file_core(&files, &file_state, "staging/script-consent.json", Some(planted.to_string())).unwrap();
    create_virtual_file_core(&files, &file_state, "staging/other.json", Some("{}".to_string())).unwrap();
    let folder = FileState::default();
    let err = rename_virtual_file_core(&files, &folder, "staging", ".calcula").unwrap_err();
    assert!(err.contains("approval screen"), "{err}");
    {
        let guard = files.files.lock().unwrap();
        assert!(!guard.contains_key(SCRIPT_CONSENT_FILE));
        assert!(guard.contains_key("staging/script-consent.json"), "the refused folder rename moved a file");
        assert!(guard.contains_key("staging/other.json"), "the refused folder rename moved a file");
    }
    assert!(!folder.is_dirty());
    // ...and an ordinary folder rename still works.
    rename_virtual_file_core(&files, &folder, "staging", "moved").unwrap();
    assert!(files.files.lock().unwrap().contains_key("moved/script-consent.json"));
}

/// Removing approvals is always safe: deleting the file, or renaming it away.
#[test]
fn the_consent_file_can_still_be_deleted() {
    let a = TempDir::new().unwrap();
    let files = user_files();
    record_on(&a, &files, request("Acme", &[("m1", "run()")], &[])).unwrap();
    let file_state = FileState::default();
    delete_virtual_file_core(&files, &file_state, SCRIPT_CONSENT_FILE).unwrap();
    assert!(raw_bytes(&files).is_none());
    assert!(file_state.is_dirty());
    assert!(!granted_on(&a, &files, "Acme", "m1", "run()"));

    record_on(&a, &files, request("Acme", &[("m1", "run()")], &[])).unwrap();
    rename_virtual_file_core(&files, &FileState::default(), SCRIPT_CONSENT_FILE, ".calcula/old-approvals.json").unwrap();
    assert!(raw_bytes(&files).is_none());
}

// ---------------------------------------------------------------------------
// The census: every Rust reader sees only the verified view
// ---------------------------------------------------------------------------

fn rust_sources(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(rust_sources(&path));
        } else if path.extension().is_some_and(|e| e == "rs")
            && !path.file_name().unwrap().to_string_lossy().ends_with("_tests.rs")
        {
            out.push(path);
        }
    }
    out
}

/// A file without its top-level test-only items. A `#[cfg(test)]` at column 0
/// removes the item under it: a one-line item (`mod tests;`), or everything up
/// to the next line that is exactly `}` -- where rustfmt closes a top-level
/// item. NOT "everything before the first `#[cfg(test)]`": `calp_commands.rs`
/// carries a test-only helper at line ~9400, which would hide the other 14,000
/// lines from the census. An indented `#[cfg(test)]` is left in (it can only
/// ADD hits, never hide one).
fn production_part(text: &str) -> String {
    let mut out = String::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim_end() != "#[cfg(test)]" {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        for item in lines.by_ref() {
            if item.trim_start().starts_with("#[") {
                continue; // further attributes on the same item
            }
            let trimmed = item.trim_end();
            let one_line = (trimmed.ends_with(';') && !trimmed.contains('{'))
                || (trimmed.ends_with('}') && trimmed.contains('{'));
            if !one_line {
                for rest in lines.by_ref() {
                    if rest.trim_end() == "}" {
                        break;
                    }
                }
            }
            break;
        }
    }
    out
}

fn relative(root: &std::path::Path, path: &std::path::Path) -> String {
    path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")
}

/// The body of `fn <name>(` up to the first line that is exactly `}`.
fn fn_body<'a>(text: &'a str, signature: &str) -> &'a str {
    let at = text.find(signature).unwrap_or_else(|| panic!("`{signature}` is gone"));
    let rest = &text[at..];
    let end = rest.find("\n}\n").unwrap_or_else(|| panic!("`{signature}` has no end"));
    &rest[..end]
}

/// No production code outside `consent_seal.rs` indexes the consent file except
/// `read_script_consent_file_in`, which verifies; the old entry point is a
/// wrapper over it; and the three gates read through it.
///
/// SABOTAGE (g): make `read_script_consent_file_in` parse the raw bytes again.
#[test]
fn the_rust_consent_readers_see_only_the_verified_view() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut hits = Vec::new();
    for path in rust_sources(&root) {
        let rel = relative(&root, &path);
        if rel == "consent_seal.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for (n, line) in production_part(&text).lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            if line.contains("SCRIPT_CONSENT_FILE") || line.contains("script-consent.json") {
                hits.push((rel.clone(), n + 1, line.trim().to_string()));
            }
        }
    }
    let calp = std::fs::read_to_string(root.join("calp_commands.rs")).unwrap();
    let reader = fn_body(&calp, "pub(crate) fn read_script_consent_file_in(");
    assert_eq!(hits.len(), 1, "a second reader of the consent file: {hits:#?}");
    assert_eq!(hits[0].0, "calp_commands.rs");
    assert!(reader.contains(&hits[0].2), "the one index of the consent file is not inside the verified reader");
    assert!(
        reader.contains("crate::consent_seal::verified_view("),
        "read_script_consent_file_in no longer verifies"
    );
    assert!(!reader.contains("serde_json::from_slice"), "read_script_consent_file_in parses the raw bytes");
    let wrapper = fn_body(&calp, "pub(crate) fn read_script_consent_file(");
    assert!(wrapper.contains("read_script_consent_file_in("), "the old entry point stopped delegating");

    // The three gates.
    for (file, needle) in [
        ("scripting/commands.rs", "crate::calp_commands::read_script_consent_file("),
        ("scripting/notebook_commands.rs", "crate::calp_commands::read_script_consent_file("),
        ("calp_commands.rs", "read_script_consent_file(app)"),
    ] {
        let text = std::fs::read_to_string(root.join(file)).unwrap();
        assert!(production_part(&text).contains(needle), "{file} no longer reads approvals through the verified reader");
    }
}

// ---------------------------------------------------------------------------
// The wire shared with @api/distributedConsent
// ---------------------------------------------------------------------------

fn wire_fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/api/__tests__/fixtures/consentSealWire.json"
    )))
    .unwrap()
}

/// The request literal the TypeScript wire test asserts `recordConsent` sends
/// is exactly what this side accepts -- and the caller-side extras (a planted
/// `sourceHash` among them) are refused, not ignored.
#[test]
fn the_record_request_is_the_one_typescript_sends() {
    let fixture = wire_fixture();
    let parsed: RecordScriptConsentRequest =
        serde_json::from_value(fixture["request"].clone()).expect("the TS request literal deserializes");
    assert_eq!(serde_json::to_value(&parsed).unwrap(), fixture["request"], "a field was renamed on one side");
    assert_eq!(parsed.scripts.len(), 2);
    let err = serde_json::from_value::<RecordScriptConsentRequest>(fixture["inputs"].clone())
        .expect_err("a request carrying a sourceHash must be refused");
    assert!(err.to_string().contains("unknown field"), "{err}");
    for planted in ["sourceHash", "grantedAt", "seal", "keyId"] {
        let mut req = fixture["request"].clone();
        if planted == "sourceHash" {
            req["scripts"][0][planted] = serde_json::json!("0".repeat(64));
        } else {
            req[planted] = serde_json::json!("planted");
        }
        assert!(
            serde_json::from_value::<RecordScriptConsentRequest>(req).is_err(),
            "the page could supply {planted}"
        );
    }
}

/// The list answer, field for field, is what the TypeScript `ConsentReport`
/// literal spells.
#[test]
fn the_list_answer_is_the_shape_typescript_reads() {
    let list = ScriptConsentList {
        consents: vec![ConsentRecordView {
            package_name: "Quarterly Reports".to_string(),
            scripts: vec![ConsentedScriptWire {
                id: "macro-month-end".to_string(),
                source_hash: "0".repeat(64),
                source: Some("Calcula.setCellValue('A1', 1);".to_string()),
            }],
            granted_capabilities: vec![
                CapabilityGrantWire {
                    capability: "net.fetch".to_string(),
                    origins: Some(vec!["https://example.com".to_string()]),
                },
                CapabilityGrantWire { capability: "storage".to_string(), origins: None },
            ],
            granted_at: "2026-09-30T12:00:00.000Z".to_string(),
        }],
        ignored: vec![
            IgnoredConsent { package_name: "Sealed Elsewhere".to_string(), reason: IgnoredReason::OtherComputer },
            IgnoredConsent { package_name: "Old File".to_string(), reason: IgnoredReason::Unsealed },
            IgnoredConsent { package_name: "Edited".to_string(), reason: IgnoredReason::Altered },
            IgnoredConsent { package_name: "Broken Key".to_string(), reason: IgnoredReason::KeyUnavailable },
        ],
    };
    assert_eq!(serde_json::to_value(&list).unwrap(), wire_fixture()["response"]);
}

/// Every spelling a later path might normalise, and none it would not.
#[test]
fn the_consent_file_key_predicate() {
    for yes in [SCRIPT_CONSENT_FILE, ".calcula\\script-consent.json", "./.calcula/script-consent.json", ".Calcula/SCRIPT-CONSENT.json"] {
        assert!(is_consent_file_key(yes), "{yes}");
    }
    for no in [".calcula/script-consent.json.bak", "x/.calcula/script-consent.json", ".calcula/notes.json", "script-consent.json"] {
        assert!(!is_consent_file_key(no), "{no}");
    }
}
