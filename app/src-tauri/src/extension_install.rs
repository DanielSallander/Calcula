//! FILENAME: app/src-tauri/src/extension_install.rs
//! PURPOSE: The USER-facing on-ramp for third-party add-ins: inspect a folder
//!          the user picked, disclose exactly who signed it and what it will
//!          install, and — only on an explicit confirmation — copy it into the
//!          extensions directory and pin its publisher key.
//! CONTEXT: `uninstall_extension` (lib.rs) shipped without a counterpart, so
//!          "installing" an add-in meant hand-copying files into %APPDATA%.
//!          That is not merely inconvenient: hand-copying skips every trust
//!          decision, and the only thing that ever pinned a publisher key was a
//!          SILENT trust-on-first-use inside the disk scan. This module makes
//!          first contact with a publisher an explicit, informed decision.
//!
//! THE FOUR RULES THIS MODULE ENFORCES (all Rust-authoritative — the renderer
//! is assumed compromised, so nothing here trusts a value it was handed back):
//!
//!   1. PREVIEW NEVER MUTATES. `confirm: false` reads, verifies and reports.
//!      It copies nothing and — critically — pins nothing. A publisher key
//!      becomes trusted only in the `confirm: true` branch, after the user has
//!      seen the key, the capabilities and the contributions.
//!   2. A BROKEN SIGNATURE IS NEVER INSTALLED. `unsigned` is a legitimate state
//!      (Wave F zeroes its capabilities); `invalid` is not — it means the bytes
//!      do not match the claim, and the honest answer is refusal, not a badge.
//!   3. A PUBLISHER CHANGE IS A SECOND QUESTION. Mirrors the .calp TOFU rule:
//!      a key that differs from the pin refuses the install unless the caller
//!      passes `acceptPublisherChange`, which the UI only sets after asking a
//!      differently-worded question. Nothing ever re-pins silently.
//!   4. THE SIGNATURE COVERS THE CODE. A signed manifest must carry `codeHash`
//!      (calp::signing) and it must match the bundle, or the install is refused.
//!      Without that, a signature would authenticate a DESCRIPTION of an add-in
//!      while its executable bytes stayed swappable — "signed" implying far
//!      more than it delivered.
//!
//! The destination is ALWAYS `app_data/extensions`; it is never caller-supplied.
//! The source path is caller-supplied but only ever READ, and it reaches the
//! backend from a native folder picker the user drove (see the Extensions panel
//! — no path string is ever synthesized by extension or script code).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use calp::signing::{
    check_extension_code_hash, extension_layout_for_source, load_pins, pin_publisher,
    verify_signature, CodeHashStatus, PinKey,
    ExtensionBundleLayout,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;

// ---------------------------------------------------------------------------
// The trust vocabulary — ONE definition, shared by the scan and the installer
// ---------------------------------------------------------------------------
//
// Two code paths decide whether an add-in is trusted: `verify_extension_manifest`
// (lib.rs), which runs on EVERY disk scan and is what actually gates the
// capability ceiling at launch, and `inspect` below, which runs when the user
// installs. They used to compute the answer independently, and they disagreed —
// the scan treated an unreadable pin store as `verified` while the installer
// treated it as `firstUse`. Both were wrong in the same direction (open), which
// is why the decision now lives here and both call it.
//
// THE RULE: a status is trusted only when Calcula can state, from evidence on
// disk, BOTH of "this publisher signed it" and "this is the code they signed".
// Anything it cannot establish — for any reason, including its own records being
// unreadable — is not a weaker kind of trusted. It is untrusted.

/// No signature at all (or no publisher key / no `.sig`). A legitimate state:
/// the add-in loads, its declared capabilities are refused.
pub const TRUST_UNSIGNED: &str = "unsigned";
/// The bytes do not match the key they claim, or a declared `codeHash` does not
/// match the bundle. A broken claim, not a weak one.
pub const TRUST_INVALID: &str = "invalid";
/// The manifest signature verified, but it does NOT cover the program file
/// (no `codeHash` declared, or the bundle could not be read to check it). We
/// know who wrote the description; we cannot say who wrote the code.
pub const TRUST_CODE_UNVERIFIED: &str = "codeUnverified";
/// The signature verified, but Calcula could not read its own record of which
/// publisher key belongs to this add-in, so it cannot say whether the publisher
/// changed. Fails closed: a corrupt pin store must not launder a key swap.
pub const TRUST_UNAVAILABLE: &str = "trustUnavailable";
/// Signed by a key that differs from the pinned one.
pub const TRUST_PUBLISHER_CHANGED: &str = "publisherChanged";
/// Signed, code covered, publisher never seen before (pinned on install).
///
/// INSTALLER-ONLY. It means "you are about to create a pin", which is only true
/// on a path where a human is answering a question. The disk scan reports
/// `TRUST_NOT_INSTALLED` for the same evidence — see below.
pub const TRUST_FIRST_USE: &str = "firstUse";
/// SCAN-ONLY. The bundle is signed and its code is covered, but this machine
/// holds NO pin for its id — so it never went through `install_extension`, the
/// only path that pins. Somebody put it in the extensions folder directly.
///
/// It is a distinct, NON-TRUSTING status rather than a silent pin because
/// pinning here would let a dropped file SQUAT the pin for an id it does not
/// own: the genuine publisher's next release would then read `publisherChanged`
/// and the real author would look like the attacker. Calcula answers the only
/// thing it can prove — "nobody here ever agreed to trust this key" — and
/// refuses the declared capability ceiling until somebody does.
pub const TRUST_NOT_INSTALLED: &str = "notInstalled";
/// Signed, code covered, publisher matches the pin.
pub const TRUST_VERIFIED: &str = "verified";

/// Every status the two paths can emit. The frontend has a presentation row for
/// each (a status with no row renders as an unlabelled box, which for a security
/// state is the worst possible failure — it looks benign), and
/// `installTrustChain.test.ts` reads this list out of this file so a new status
/// cannot be added without one.
pub const EXTENSION_TRUST_STATUSES: &[&str] = &[
    TRUST_UNSIGNED,
    TRUST_INVALID,
    TRUST_CODE_UNVERIFIED,
    TRUST_UNAVAILABLE,
    TRUST_PUBLISHER_CHANGED,
    TRUST_FIRST_USE,
    TRUST_NOT_INSTALLED,
    TRUST_VERIFIED,
];

/// The ONLY two statuses for which an add-in's declared capability ceiling is
/// honored. Mirrored frontend-side by `trustOk` in ExtensionManager.ts; pinned
/// against it by test.
pub fn trust_grants_capabilities(status: &str) -> bool {
    matches!(status, TRUST_FIRST_USE | TRUST_VERIFIED)
}

/// Decide the publisher half of trust, FAILING CLOSED when the pin store cannot
/// be read.
///
/// EXTENSION PINS ARE MACHINE-GLOBAL, BY DECISION. `PinKey::extension(id)` carries
/// no registry scope, unlike a `.calp` pin. There is no registry here — an add-in
/// is installed from a folder — and the only candidate scope would be the source
/// PATH, which is the attacker's own choice: a bundle dropped in
/// `%USERPROFILE%\Downloads` would get a pristine scope and therefore a free
/// first use on an id it does not own, which is precisely the squat Wave H closed.
/// It would also make a reinstall from a USB stick a false first use, and it
/// cannot be recorded honestly anyway because the installer COPIES the files, so
/// the "scope" evaporates the moment the install completes. For an id namespace
/// with no naming authority behind it, machine-global first-contact ownership IS
/// the semantics; the protection is that only a human at the installer can claim
/// it (`decide_extension_trust_for_scan` refuses to pin from a scan).
///
/// `load_pins` returns an empty store when the file does not exist
/// yet — that is a real "never seen anybody", and it pins. `Err` is different:
/// the file exists and could not be read or parsed. Treating that as "no pin"
/// (installer) or as "verified" (scan) both let an attacker who can write to the
/// user's profile turn a publisher-key SUBSTITUTION into a trusted state, which
/// is the one thing TOFU exists to prevent — and an attacker who can drop a
/// bundle into `%APPDATA%/…/extensions` can write the profile directory too.
fn publisher_trust(profile_dir: &Path, id: &str, publisher_key: &str) -> (String, String) {
    match load_pins(profile_dir) {
        Err(_) => (TRUST_UNAVAILABLE.to_string(), String::new()),
        Ok(store) => match store.get(&PinKey::extension(id)) {
            None => (TRUST_FIRST_USE.to_string(), String::new()),
            Some(r) if r.publisher_key == publisher_key => {
                (TRUST_VERIFIED.to_string(), r.publisher_key.clone())
            }
            Some(r) => (
                TRUST_PUBLISHER_CHANGED.to_string(),
                r.publisher_key.clone(),
            ),
        },
    }
}

/// Collapse a signature-verified status according to what the signature actually
/// COVERS. Called only after `verify_signature` succeeded — outside the signed
/// bytes `codeHash` is attacker-controlled and means nothing.
///
/// `Match` is the only outcome that leaves trust intact. `Mismatch` is a broken
/// claim about the code and collapses to `invalid`. `NotDeclared` and
/// `BundleUnreadable` are not broken claims — they are ABSENT ones, so they get
/// their own status rather than being dressed up as a bad signature: the user is
/// told the truth, which is that the manifest is authentic and the program file
/// is not covered by it.
fn narrow_trust_by_code_hash(status: String, code: CodeHashStatus) -> String {
    match code {
        CodeHashStatus::Match => status,
        CodeHashStatus::Mismatch => TRUST_INVALID.to_string(),
        CodeHashStatus::NotDeclared | CodeHashStatus::BundleUnreadable => {
            TRUST_CODE_UNVERIFIED.to_string()
        }
    }
}

/// The whole sidecar trust decision, from bytes on disk to one status string.
/// `verify_extension_manifest` (the scan) and `inspect` (the installer) both go
/// through here so they cannot disagree again.
///
/// Returns `(status, pinned_key)`; `pinned_key` is empty unless a pin was read.
pub fn decide_extension_trust(
    profile_dir: &Path,
    id: &str,
    version: &str,
    publisher_key: &str,
    manifest_bytes: &[u8],
    manifest: &serde_json::Value,
    signature_hex: &str,
    bundle: Option<&Path>,
) -> (String, String) {
    if id.is_empty() || publisher_key.is_empty() || signature_hex.is_empty() {
        return (TRUST_UNSIGNED.to_string(), String::new());
    }
    if verify_signature(publisher_key, manifest_bytes, signature_hex, id, version).is_err() {
        return (TRUST_INVALID.to_string(), String::new());
    }
    let (status, pinned) = publisher_trust(profile_dir, id, publisher_key);
    // A publisher question we could not answer stays unanswered: do not go on to
    // report code coverage as if the identity half had succeeded.
    if status == TRUST_UNAVAILABLE {
        return (status, pinned);
    }
    let code = match bundle {
        Some(path) => check_extension_code_hash(manifest, path),
        None => CodeHashStatus::BundleUnreadable,
    };
    (narrow_trust_by_code_hash(status, code), pinned)
}

/// The SCAN's view of the same evidence: identical in every respect except that
/// first contact is `TRUST_NOT_INSTALLED` instead of `TRUST_FIRST_USE`.
///
/// WHY THE TWO PATHS MUST DIFFER HERE, when the whole point of
/// `decide_extension_trust` is that they agree everywhere else:
///
///   `firstUse` is not an observation, it is a PROMISE — "install this and the
///   key becomes the pin". Only the installer can keep it, because only the
///   installer has a human answering a question. The scan runs unattended on
///   every launch over whatever happens to be sitting in
///   %APPDATA%/…/extensions, including a bundle somebody dropped there. It has
///   nobody to ask, so the honest answer is a statement of fact: this machine
///   has no record of anyone trusting this publisher for this id.
///
///   The scan used to answer `firstUse` AND silently pin. That grants nothing by
///   itself — the capability ceiling is a separate frontend decision and consent
///   for distributed scripts is separate again — but it hands an attacker a
///   free primitive: drop `acme.tax-tools.js` signed with YOUR key into the
///   extensions folder, and the pin for `acme.tax-tools` is now yours. When Acme
///   later ships the real thing, the user sees "Publisher changed!" pointed at
///   the legitimate author. Silent TOFU without a human is TOFU aimed at the
///   wrong party.
///
/// Fails closed: `TRUST_NOT_INSTALLED` is deliberately absent from
/// `trust_grants_capabilities`, so a hand-copied add-in still LOADS (it is
/// allowed to exist) with an empty ceiling — no worksheet functions, no network,
/// no storage — until the user installs it through the disclosing on-ramp.
pub fn decide_extension_trust_for_scan(
    profile_dir: &Path,
    id: &str,
    version: &str,
    publisher_key: &str,
    manifest_bytes: &[u8],
    manifest: &serde_json::Value,
    signature_hex: &str,
    bundle: Option<&Path>,
) -> (String, String) {
    let (status, pinned) = decide_extension_trust(
        profile_dir,
        id,
        version,
        publisher_key,
        manifest_bytes,
        manifest,
        signature_hex,
        bundle,
    );
    if status == TRUST_FIRST_USE {
        return (TRUST_NOT_INSTALLED.to_string(), pinned);
    }
    (status, pinned)
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// What the trusted Extensions UI asks for. One command serves both the preview
/// and the install so the app stays inside its Tauri-command budget; `confirm`
/// is the only thing that separates "tell me" from "do it".
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallExtensionRequest {
    /// Absolute path the USER picked in a native dialog: the add-in folder, its
    /// `<name>.js` bundle, or its `<name>.manifest.json`. Read-only.
    pub source_path: String,
    /// false = preview (nothing copied, nothing pinned). true = install.
    #[serde(default)]
    pub confirm: bool,
    /// Required to install when the publisher key differs from the pinned one.
    #[serde(default)]
    pub accept_publisher_change: bool,
}

/// One declared contribution group, flattened for display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredContribution {
    /// Manifest key: "formulas", "commands", "menuItems", "ribbonButtons", …
    pub kind: String,
    /// The exact ids declared. No wildcards — a wildcard would make pre-install
    /// disclosure meaningless.
    pub ids: Vec<String>,
}

/// Everything the user must be able to see BEFORE deciding, plus the outcome.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallExtensionReport {
    /// Manifest id (the TOFU + consent identity).
    pub id: String,
    pub name: String,
    pub version: String,
    /// The name `scan_extension_directory` will report: "<base>.js" for a file
    /// bundle, "<dir>/index.js" for a directory bundle. Lets the UI correlate
    /// the install with the listed extension (and with uninstall).
    pub bundle_file_name: String,
    /// Ed25519 public key asserted by the manifest ("" when unsigned).
    pub publisher_key: String,
    /// The key already pinned for this id, if any ("" when first contact).
    pub pinned_publisher_key: String,
    /// "unsigned" | "invalid" | "firstUse" | "verified" | "publisherChanged".
    /// Identical vocabulary to `scan_extension_directory`'s `trustStatus`.
    pub trust_status: String,
    /// "notDeclared" | "match" | "mismatch" | "bundleUnreadable".
    pub code_hash_status: String,
    /// True when the signature transitively authenticates the executed bytes.
    pub code_covered_by_signature: bool,
    /// Capabilities as DECLARED (unfiltered — the frontend owns the vocabulary).
    pub declared_capabilities: Vec<String>,
    /// False when the sidecar's trust means Calcula will zero the ceiling.
    pub capabilities_honored: bool,
    /// Declared contributions, in manifest order of the known keys.
    pub contributions: Vec<DeclaredContribution>,
    /// Must be true — Calcula refuses third-party code on the main thread.
    pub worker_support: bool,
    /// Files that will be (or were) written, as bare names.
    pub files: Vec<String>,
    /// True when a bundle with this destination name is already installed.
    pub already_installed: bool,
    /// Version currently installed under that name ("" when not installed).
    pub installed_version: String,
    /// True only for a completed install.
    pub installed: bool,
    /// True when the install pinned this publisher key (first contact/accepted
    /// change). Lets the UI say "you have now trusted this key".
    pub pinned: bool,
    /// Plain-language notes the UI must show verbatim next to the decision.
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Manifest reading
// ---------------------------------------------------------------------------

/// Sidecar keys that carry contribution declarations, in the order the consent
/// prompt reads best. Unknown keys are ignored (they grant nothing anyway).
const CONTRIBUTION_KEYS: [&str; 7] = [
    "formulas",
    "commands",
    "menuItems",
    "ribbonButtons",
    "keybindings",
    "cellStyles",
    "fileFormats",
];

fn string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn contributions_of(manifest: &serde_json::Value) -> Vec<DeclaredContribution> {
    let contributes = manifest.get("contributes");
    CONTRIBUTION_KEYS
        .iter()
        .filter_map(|key| {
            let ids = string_list(contributes.and_then(|c| c.get(*key)));
            if ids.is_empty() {
                None
            } else {
                Some(DeclaredContribution {
                    kind: (*key).to_string(),
                    ids,
                })
            }
        })
        .collect()
}

/// A destination name that cannot escape the extensions directory or collide
/// with the reserved directory-bundle base.
fn validate_dest_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 100 {
        return Err("The add-in's file name is empty or unreasonably long.".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(format!(
            "'{}' is not a usable add-in name: use only letters, digits, '.', '-' and '_'.",
            name
        ));
    }
    if name.starts_with('.') || name.contains("..") {
        return Err(format!("'{}' is not a usable add-in name.", name));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Inspection (shared by preview and install — the install NEVER trusts a
// preview handed back by the renderer; it re-derives everything from disk)
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Inspected {
    layout: ExtensionBundleLayout,
    manifest: serde_json::Value,
    /// Destination base name ("tax-tools") or folder name for a dir bundle.
    dest_name: String,
    is_directory_bundle: bool,
    report: InstallExtensionReport,
}

fn inspect(source: &Path, ext_dir: &Path, profile_dir: &Path) -> Result<Inspected, String> {
    let layout = extension_layout_for_source(source).map_err(|e| e.to_string())?;
    let ExtensionBundleLayout {
        manifest: manifest_path,
        signature: sig_path,
        bundle: bundle_path,
    } = layout.clone();

    if !bundle_path.is_file() {
        return Err(format!(
            "No add-in bundle found at '{}'.",
            bundle_path.display()
        ));
    }
    if !manifest_path.is_file() {
        return Err(format!(
            "'{}' has no sidecar manifest ({}). Calcula will not install an add-in it cannot \
             describe to you before running it.",
            source.display(),
            manifest_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("<name>.manifest.json")
        ));
    }

    let manifest_bytes = std::fs::read(&manifest_path).map_err(|e| e.to_string())?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|e| {
        format!(
            "'{}' is not valid JSON: {}",
            manifest_path.display(),
            e
        )
    })?;

    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return Err("The sidecar manifest has no \"id\".".to_string());
    }
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .trim()
        .to_string();
    let name = manifest
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let name = if name.is_empty() { id.clone() } else { name.to_string() };
    let publisher_key = manifest
        .get("publisherKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let worker_support = manifest
        .get("workerSupport")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // ---- Destination naming -------------------------------------------------
    let is_directory_bundle = bundle_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "index.js")
        .unwrap_or(false);
    let dest_name = if is_directory_bundle {
        bundle_path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string()
    } else {
        bundle_path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string()
    };
    validate_dest_name(&dest_name)?;

    let (bundle_file_name, files): (String, Vec<String>) = if is_directory_bundle {
        (
            format!("{}/index.js", dest_name),
            vec![
                format!("{}/index.js", dest_name),
                format!("{}/extension.manifest.json", dest_name),
                format!("{}/extension.manifest.sig", dest_name),
            ],
        )
    } else {
        (
            format!("{}.js", dest_name),
            vec![
                format!("{}.js", dest_name),
                format!("{}.manifest.json", dest_name),
                format!("{}.manifest.sig", dest_name),
            ],
        )
    };

    // ---- Signature + TOFU (READ ONLY — this function never pins) -----------
    // The decision itself lives in decide_extension_trust so the disk scan and
    // this installer cannot drift on what counts as trusted; they did drift
    // once, both toward "open", which is why it is one function now.
    let sig_hex = std::fs::read_to_string(&sig_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let (trust_status, pinned) = decide_extension_trust(
        profile_dir,
        &id,
        &version,
        &publisher_key,
        &manifest_bytes,
        &manifest,
        &sig_hex,
        Some(&bundle_path),
    );

    // ---- Code-hash coverage (reported; the status above already folded it) ---
    // Only meaningful once the SIGNATURE verified: outside the signed bytes the
    // codeHash field is attacker-controlled and means nothing. Asked as its own
    // plain question rather than inferred from the status, because the status
    // deliberately collapses two different failures into `invalid` (a bad
    // signature, and a good signature over a swapped bundle) and the WARNINGS
    // below have to tell those two apart — "signed but the code is not covered"
    // and "signed, and the code was swapped after signing" are different
    // sentences and the user deserves the right one.
    let signature_verified = !publisher_key.is_empty()
        && !sig_hex.is_empty()
        && verify_signature(&publisher_key, &manifest_bytes, &sig_hex, &id, &version).is_ok();
    let code_status = if signature_verified {
        check_extension_code_hash(&manifest, &bundle_path)
    } else {
        CodeHashStatus::NotDeclared
    };
    let code_covered_by_signature = signature_verified && code_status == CodeHashStatus::Match;

    let capabilities_honored = trust_grants_capabilities(&trust_status);
    let declared_capabilities = string_list(manifest.get("capabilities"));

    // ---- Already installed? -------------------------------------------------
    let installed_manifest = if is_directory_bundle {
        ext_dir.join(&dest_name).join("extension.manifest.json")
    } else {
        ext_dir.join(format!("{}.manifest.json", dest_name))
    };
    let installed_bundle = if is_directory_bundle {
        ext_dir.join(&dest_name).join("index.js")
    } else {
        ext_dir.join(format!("{}.js", dest_name))
    };
    let already_installed = installed_bundle.is_file();
    let installed_version = std::fs::read(&installed_manifest)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| {
            v.get("version")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();

    // ---- Warnings the UI must show verbatim ---------------------------------
    let mut warnings: Vec<String> = Vec::new();
    match trust_status.as_str() {
        "unsigned" => warnings.push(
            "This add-in is not signed. Calcula cannot tell you who wrote it, and will refuse \
             every capability it declares — including worksheet functions."
                .to_string(),
        ),
        "invalid" => warnings.push(
            "This add-in's signature does not match its contents. Either the files were \
             modified after signing, or they were never signed by the key they claim. Calcula \
             will not install it."
                .to_string(),
        ),
        "publisherChanged" => warnings.push(format!(
            "This add-in is signed by a DIFFERENT key than the one you trusted before \
             (trusted {}…, now {}…). That is either a new release key from the same author or \
             someone else publishing under their name. Only accept it if you expected it.",
            pinned.chars().take(16).collect::<String>(),
            publisher_key.chars().take(16).collect::<String>(),
        )),
        "firstUse" => warnings.push(format!(
            "You have not seen this publisher before. Installing pins the key {}… for \
             '{}': a future release signed by anyone else will be flagged.",
            publisher_key.chars().take(16).collect::<String>(),
            id,
        )),
        TRUST_CODE_UNVERIFIED => warnings.push(
            "This add-in's signature covers its description but NOT its program file, so \
             Calcula cannot tell you whether the code you are about to install is the code \
             the publisher signed. It will refuse every capability the add-in declares — \
             including worksheet functions. Ask the author to re-sign it with calcula-sign."
                .to_string(),
        ),
        TRUST_UNAVAILABLE => warnings.push(
            "The signature is valid, but Calcula could not read its own record of which \
             publisher signed this add-in before, so it cannot tell you whether the publisher \
             changed. It will not install it until that record can be read again."
                .to_string(),
        ),
        _ => {}
    }
    if signature_verified && code_status == CodeHashStatus::NotDeclared {
        warnings.push(
            "The signature covers this add-in's manifest but NOT its code: the manifest \
             declares no codeHash, so the program file could have been replaced after signing. \
             Ask the author to re-sign with calcula-sign."
                .to_string(),
        );
    }
    if signature_verified && code_status == CodeHashStatus::Mismatch {
        warnings.push(
            "The program file does not match the signed manifest — it was modified after \
             signing. Do not install this."
                .to_string(),
        );
    }
    if signature_verified && code_status == CodeHashStatus::BundleUnreadable {
        warnings.push("The program file could not be read to check it against the signature."
            .to_string());
    }
    if !worker_support {
        warnings.push(
            "This add-in does not declare workerSupport, so it cannot run: Calcula never gives \
             third-party code main-thread access."
                .to_string(),
        );
    }
    if already_installed {
        warnings.push(format!(
            "'{}' is already installed{}. Installing replaces it.",
            bundle_file_name,
            if installed_version.is_empty() {
                String::new()
            } else {
                format!(" (version {})", installed_version)
            },
        ));
    }

    Ok(Inspected {
        layout,
        manifest: manifest.clone(),
        dest_name,
        is_directory_bundle,
        report: InstallExtensionReport {
            id,
            name,
            version,
            bundle_file_name,
            publisher_key,
            pinned_publisher_key: pinned,
            trust_status,
            code_hash_status: code_status.as_str().to_string(),
            code_covered_by_signature,
            declared_capabilities,
            capabilities_honored,
            contributions: contributions_of(&manifest),
            worker_support,
            files,
            already_installed,
            installed_version,
            installed: false,
            pinned: false,
            warnings,
        },
    })
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/// Preview (`confirm: false`) or install (`confirm: true`) a third-party add-in
/// from a folder the user picked.
///
/// SECURITY: main-window only (a background/child window must not be able to
/// install code), destination fixed to `app_data/extensions`, source read-only,
/// and every gate below re-derived from disk on the install pass. The frontend
/// denylist additionally keeps this command away from non-trusted callers, but
/// that is defence in depth — this function does not rely on it.
#[tauri::command]
pub fn install_extension(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    request: InstallExtensionRequest,
) -> Result<InstallExtensionReport, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let ext_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("extensions");
    std::fs::create_dir_all(&ext_dir)
        .map_err(|e| format!("Failed to create extensions dir: {}", e))?;

    let profile_dir = crate::calp_commands::calcula_profile_dir();
    let source = PathBuf::from(&request.source_path);
    if !source.exists() {
        return Err(format!("'{}' does not exist.", source.display()));
    }

    let inspected = inspect(&source, &ext_dir, &profile_dir)?;
    if !request.confirm {
        return Ok(inspected.report);
    }

    install_inspected(inspected, &ext_dir, &profile_dir, request.accept_publisher_change)
}

/// The install half, split out so it is unit-testable without a Tauri window.
fn install_inspected(
    inspected: Inspected,
    ext_dir: &Path,
    profile_dir: &Path,
    accept_publisher_change: bool,
) -> Result<InstallExtensionReport, String> {
    let Inspected {
        layout,
        manifest,
        dest_name,
        is_directory_bundle,
        mut report,
    } = inspected;

    // -- Refusals (in the order a user would ask about them) -----------------
    if !report.worker_support {
        return Err(format!(
            "'{}' does not declare workerSupport: true, so Calcula could never run it. \
             Third-party code is refused on the main thread by design.",
            report.name
        ));
    }
    if report.trust_status == TRUST_INVALID {
        return Err(format!(
            "'{}' has a broken signature: its files do not match the key they claim to be \
             signed by. Refusing to install.",
            report.name
        ));
    }
    if report.trust_status == TRUST_UNAVAILABLE {
        return Err(format!(
            "'{}' is signed, but Calcula could not read its own record of which publisher \
             signed it before, so it cannot tell whether the publisher changed. Refusing to \
             install until that record can be read.",
            report.name
        ));
    }
    if report.trust_status == TRUST_CODE_UNVERIFIED {
        return Err(format!(
            "'{}' is signed but its signature does not cover its program file, so Calcula \
             cannot tell whether this is the code the publisher signed. Ask the author to \
             re-sign it with calcula-sign (which stamps a codeHash before signing).",
            report.name
        ));
    }
    if report.trust_status == TRUST_PUBLISHER_CHANGED && !accept_publisher_change {
        return Err(format!(
            "'{}' is signed by a different publisher than the one you trusted before. \
             Accept the publisher change explicitly to continue.",
            report.name
        ));
    }
    // A signed add-in must cover its own code. The status above already folded
    // this in (TRUST_CODE_UNVERIFIED / TRUST_INVALID), but the check is REPEATED
    // here against the bytes on disk: `report` came back through the renderer,
    // and this module's first rule is that nothing here trusts a value it was
    // handed back. Re-reading the file is the cheap half of that promise.
    if report.trust_status != TRUST_UNSIGNED
        && check_extension_code_hash(&manifest, &layout.bundle) != CodeHashStatus::Match
    {
        return Err(format!(
            "'{}' is signed but its signature does not cover its program file. Ask the author \
             to re-sign it with calcula-sign (which stamps a codeHash before signing).",
            report.name
        ));
    }

    // -- Refuse installing from inside the extensions directory --------------
    let dest_dir = if is_directory_bundle {
        ext_dir.join(&dest_name)
    } else {
        ext_dir.to_path_buf()
    };
    let source_dir = layout
        .bundle
        .parent()
        .ok_or_else(|| "Could not resolve the source folder.".to_string())?;
    if source_dir.canonicalize().ok() == dest_dir.canonicalize().ok()
        && dest_dir.canonicalize().is_ok()
    {
        return Err("That add-in is already in the extensions folder.".to_string());
    }

    // -- Copy: exactly the three known files, never a directory walk ---------
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create '{}': {}", dest_dir.display(), e))?;

    let (bundle_dest, manifest_dest, sig_dest) = if is_directory_bundle {
        (
            dest_dir.join("index.js"),
            dest_dir.join("extension.manifest.json"),
            dest_dir.join("extension.manifest.sig"),
        )
    } else {
        (
            dest_dir.join(format!("{}.js", dest_name)),
            dest_dir.join(format!("{}.manifest.json", dest_name)),
            dest_dir.join(format!("{}.manifest.sig", dest_name)),
        )
    };

    std::fs::copy(&layout.bundle, &bundle_dest)
        .map_err(|e| format!("Failed to copy the bundle: {}", e))?;
    std::fs::copy(&layout.manifest, &manifest_dest)
        .map_err(|e| format!("Failed to copy the manifest: {}", e))?;
    if layout.signature.is_file() {
        std::fs::copy(&layout.signature, &sig_dest)
            .map_err(|e| format!("Failed to copy the signature: {}", e))?;
    } else if sig_dest.is_file() {
        // Replacing a signed install with an unsigned one must not leave the
        // old signature behind: it would verify against the OLD manifest bytes
        // and, worse, could pair with a new manifest to read as "unsigned"
        // while a stale .sig sits next to it. Remove it.
        std::fs::remove_file(&sig_dest)
            .map_err(|e| format!("Failed to remove the stale signature: {}", e))?;
    }

    // -- Pin the publisher key: ONLY here, ONLY after the user confirmed -----
    // `trust_at_decision` is captured BEFORE the pin collapses the status to
    // `verified`, because the machine-scoped trail has to preserve what Calcula
    // could actually prove when the user said yes — not the comfortable state
    // that existed one line later as a RESULT of them saying yes.
    let trust_at_decision = report.trust_status.clone();
    let previous_key = report.pinned_publisher_key.clone();
    if !report.publisher_key.is_empty()
        && (report.trust_status == TRUST_FIRST_USE || report.trust_status == TRUST_PUBLISHER_CHANGED)
    {
        pin_publisher(
            profile_dir,
            &PinKey::extension(&report.id),
            // No registry: an add-in is installed from a folder, and the folder
            // is the attacker's choice, so it is deliberately NOT recorded as a
            // scope. See `publisher_trust`.
            "",
            &report.publisher_key,
        )
        .map_err(|e| format!("Failed to record the publisher key: {}", e))?;
        report.pinned = true;
        report.trust_status = TRUST_VERIFIED.to_string();
    }

    report.installed = true;
    report.already_installed = true;
    report.installed_version = report.version.clone();

    // -- Record the decision, machine-scoped and append-only -----------------
    // Installing an add-in is a fact about this COMPUTER (the code loads into
    // every workbook from now on), so it cannot live in the workbook-scoped
    // calp::audit. Recorded AFTER the copy so nothing claims an install that did
    // not happen, and it can never fail the install (extension_audit rule 2).
    let source_path = layout
        .bundle
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let base = crate::extension_audit::ExtensionAuditEntry {
        at: crate::extension_audit::now_rfc3339(),
        action: crate::extension_audit::ACTION_INSTALLED.to_string(),
        id: report.id.clone(),
        name: report.name.clone(),
        version: report.version.clone(),
        bundle_file_name: report.bundle_file_name.clone(),
        publisher_key: report.publisher_key.clone(),
        previous_publisher_key: previous_key.clone(),
        trust_status: trust_at_decision.clone(),
        capabilities_honored: report.capabilities_honored,
        declared_capabilities: report.declared_capabilities.clone(),
        contributions: report
            .contributions
            .iter()
            .flat_map(|c| c.ids.iter().map(move |i| format!("{}:{}", c.kind, i)))
            .collect(),
        source_path,
        detail: format!(
            "Installed '{}' {} as {} from a folder you picked. Trust at the time: {}. \
             Declared capabilities were {}.",
            report.name,
            report.version,
            report.bundle_file_name,
            trust_at_decision,
            if report.declared_capabilities.is_empty() {
                "none".to_string()
            } else if report.capabilities_honored {
                format!("honored: {}", report.declared_capabilities.join(", "))
            } else {
                format!("REFUSED: {}", report.declared_capabilities.join(", "))
            },
        ),
    };
    crate::extension_audit::record(profile_dir, base.clone());

    // The pin is its OWN row. A key becoming trusted is a different decision
    // from a file being copied, it outlives the install (uninstall deliberately
    // leaves the pin), and — for a publisher CHANGE — it is the single row a
    // user most needs to find months later, which is why it carries both keys.
    if report.pinned {
        let changed = trust_at_decision == TRUST_PUBLISHER_CHANGED;
        crate::extension_audit::record(
            profile_dir,
            crate::extension_audit::ExtensionAuditEntry {
                action: if changed {
                    crate::extension_audit::ACTION_PUBLISHER_CHANGE_ACCEPTED.to_string()
                } else {
                    crate::extension_audit::ACTION_PUBLISHER_PINNED.to_string()
                },
                detail: if changed {
                    format!(
                        "You accepted a DIFFERENT publisher for '{}'. The trusted key changed \
                         from {}… to {}…; releases signed by the old key will now be flagged.",
                        report.id,
                        previous_key.chars().take(16).collect::<String>(),
                        report.publisher_key.chars().take(16).collect::<String>(),
                    )
                } else {
                    format!(
                        "Publisher key {}… is now trusted for '{}'. A future release signed by \
                         anyone else will be flagged.",
                        report.publisher_key.chars().take(16).collect::<String>(),
                        report.id,
                    )
                },
                ..base
            },
        );
    }

    Ok(report)
}

/// Re-check an installed add-in's `codeHash` against its bundle. Used by the
/// disk scan so tampering with the program file AFTER a trusted install is
/// detected on the next launch, not just at install time.
///
/// Call ONLY after the manifest signature verified. Returns the status; a
/// `Mismatch` must collapse the caller's trust to "invalid".
pub fn installed_code_hash_status(
    manifest_path: &Path,
    manifest: &serde_json::Value,
) -> CodeHashStatus {
    match calp::signing::extension_layout_for_manifest(manifest_path) {
        Some(layout) => check_extension_code_hash(manifest, &layout.bundle),
        // An unrecognizable manifest name cannot be tied to a bundle; the caller
        // already treats such a sidecar as unsigned.
        None => CodeHashStatus::NotDeclared,
    }
}

/// Contribution kinds, exported for the docs/tests that assert the sidecar
/// vocabulary here matches the frontend's.
pub fn contribution_kinds() -> BTreeMap<&'static str, usize> {
    CONTRIBUTION_KEYS
        .iter()
        .enumerate()
        .map(|(i, k)| (*k, i))
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The pinned key for an extension id, or None. Spelled once so no test
    /// hand-rolls a key string — `PinKey::extension` is the only construction.
    fn ext_pin(profile: &std::path::Path, id: &str) -> Option<String> {
        load_pins(profile)
            .unwrap()
            .get(&PinKey::extension(id))
            .map(|r| r.publisher_key.clone())
    }
    use calp::signing::PublisherKeypair;

    const MANIFEST: &str = r#"{
  "id": "acme.demo",
  "name": "Demo Add-in",
  "version": "1.0.0",
  "workerSupport": true,
  "publisherKey": "",
  "capabilities": ["formula.udf"],
  "contributes": { "formulas": ["DEMO"], "commands": ["run"] }
}"#;

    const CODE: &str = "export default { manifest: {}, activate() {} };";

    struct Fixture {
        _src: tempfile::TempDir,
        _ext: tempfile::TempDir,
        _profile: tempfile::TempDir,
        src: PathBuf,
        ext: PathBuf,
        profile: PathBuf,
    }

    fn fixture() -> Fixture {
        let src = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("demo.js"), CODE).unwrap();
        std::fs::write(src.path().join("demo.manifest.json"), MANIFEST).unwrap();
        Fixture {
            src: src.path().to_path_buf(),
            ext: ext.path().to_path_buf(),
            profile: profile.path().to_path_buf(),
            _src: src,
            _ext: ext,
            _profile: profile,
        }
    }

    /// Sign the fixture the way `calcula-sign` does: stamp publisherKey +
    /// codeHash, rewrite the manifest, sign the bytes as written.
    fn sign(f: &Fixture, profile_for_key: &Path) -> String {
        let kp = PublisherKeypair::load_or_create(profile_for_key).unwrap();
        let manifest_path = f.src.join("demo.manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        let code_hash = calp::signing::extension_code_hash(&f.src.join("demo.js")).unwrap();
        let obj = manifest.as_object_mut().unwrap();
        obj.insert("publisherKey".into(), kp.public_key_hex().into());
        obj.insert("codeHash".into(), code_hash.into());
        let bytes = format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap());
        std::fs::write(&manifest_path, bytes.as_bytes()).unwrap();
        let sig = kp.sign(&std::fs::read(&manifest_path).unwrap());
        std::fs::write(f.src.join("demo.manifest.sig"), format!("{}\n", sig)).unwrap();
        kp.public_key_hex()
    }

    fn preview(f: &Fixture) -> InstallExtensionReport {
        inspect(&f.src, &f.ext, &f.profile).unwrap().report
    }

    fn install(f: &Fixture, accept_change: bool) -> Result<InstallExtensionReport, String> {
        let i = inspect(&f.src, &f.ext, &f.profile)?;
        install_inspected(i, &f.ext, &f.profile, accept_change)
    }

    // -- Disclosure ----------------------------------------------------------

    #[test]
    fn preview_discloses_identity_capabilities_and_contributions() {
        let f = fixture();
        let r = preview(&f);
        assert_eq!(r.id, "acme.demo");
        assert_eq!(r.name, "Demo Add-in");
        assert_eq!(r.version, "1.0.0");
        assert_eq!(r.bundle_file_name, "demo.js");
        assert_eq!(r.declared_capabilities, vec!["formula.udf".to_string()]);
        assert_eq!(r.contributions.len(), 2);
        assert_eq!(r.contributions[0].kind, "formulas");
        assert_eq!(r.contributions[0].ids, vec!["DEMO".to_string()]);
        assert_eq!(r.contributions[1].kind, "commands");
        assert!(!r.installed);
    }

    #[test]
    fn preview_never_pins_and_never_copies() {
        let f = fixture();
        sign(&f, &f.profile);
        let r = preview(&f);
        assert_eq!(r.trust_status, "firstUse");
        assert!(!r.pinned);
        // Nothing was written into the extensions dir...
        assert!(!f.ext.join("demo.js").exists());
        // ...and NOTHING was pinned: a second preview is still first contact.
        assert_eq!(preview(&f).trust_status, "firstUse");
        assert!(load_pins(&f.profile).unwrap().is_empty());
    }

    // -- Unsigned ------------------------------------------------------------

    #[test]
    fn unsigned_installs_but_capabilities_are_not_honored() {
        let f = fixture();
        let r = install(&f, false).unwrap();
        assert_eq!(r.trust_status, "unsigned");
        assert!(!r.capabilities_honored, "an unsigned sidecar must not be honored");
        assert!(!r.code_covered_by_signature);
        assert!(!r.pinned);
        assert!(r.warnings.iter().any(|w| w.contains("not signed")));
        assert!(f.ext.join("demo.js").is_file());
        assert!(f.ext.join("demo.manifest.json").is_file());
        assert!(!f.ext.join("demo.manifest.sig").exists());
    }

    // -- Signed / TOFU -------------------------------------------------------

    #[test]
    fn signed_install_pins_only_on_confirm_then_reads_as_verified() {
        let f = fixture();
        let key = sign(&f, &f.profile);

        let r = install(&f, false).unwrap();
        assert!(r.installed);
        assert!(r.pinned, "install must pin on first contact");
        assert_eq!(r.trust_status, "verified");
        assert!(r.capabilities_honored);
        assert!(r.code_covered_by_signature);
        assert_eq!(ext_pin(&f.profile, "acme.demo"), Some(key));
        assert!(f.ext.join("demo.manifest.sig").is_file());

        // A later preview of the same publisher reads as verified, not firstUse.
        assert_eq!(preview(&f).trust_status, "verified");
    }

    #[test]
    fn a_different_signing_key_is_a_publisher_change_and_must_be_accepted() {
        let f = fixture();
        sign(&f, &f.profile);
        install(&f, false).unwrap();
        let first_key = ext_pin(&f.profile, "acme.demo").unwrap();

        // A DIFFERENT publisher re-signs the same id.
        let other = tempfile::tempdir().unwrap();
        let second_key = sign(&f, other.path());
        assert_ne!(first_key, second_key);

        let r = preview(&f);
        assert_eq!(r.trust_status, "publisherChanged");
        assert!(!r.capabilities_honored, "a changed publisher must not keep the ceiling");
        assert!(r.warnings.iter().any(|w| w.contains("DIFFERENT key")));

        // Refused without the explicit second decision — and the pin is intact.
        let err = install(&f, false).unwrap_err();
        assert!(err.contains("different publisher"), "unexpected: {err}");
        assert_eq!(
            ext_pin(&f.profile, "acme.demo").as_deref(),
            Some(first_key.as_str()),
            "a refused install must never re-pin"
        );

        // Accepted explicitly -> re-pinned to the new key.
        let ok = install(&f, true).unwrap();
        assert!(ok.pinned);
        assert_eq!(
            ext_pin(&f.profile, "acme.demo").as_deref(),
            Some(second_key.as_str())
        );
    }

    // -- Tampering -----------------------------------------------------------

    #[test]
    fn manifest_tampering_after_signing_is_refused() {
        let f = fixture();
        sign(&f, &f.profile);
        // Widen the declared capabilities by hand.
        let p = f.src.join("demo.manifest.json");
        let text = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, text.replace("formula.udf", "net.fetch")).unwrap();

        let r = preview(&f);
        assert_eq!(r.trust_status, "invalid");
        assert!(!r.capabilities_honored);
        let err = install(&f, true).unwrap_err();
        assert!(err.contains("broken signature"), "unexpected: {err}");
        assert!(!f.ext.join("demo.js").exists());
    }

    #[test]
    fn code_tampering_after_signing_is_detected_and_refused() {
        let f = fixture();
        sign(&f, &f.profile);
        // Signature + manifest untouched; only the PROGRAM changed.
        std::fs::write(f.src.join("demo.js"), "/* evil */ export default {};").unwrap();

        let r = preview(&f);
        assert_eq!(r.code_hash_status, "mismatch");
        assert_eq!(r.trust_status, "invalid", "a broken code claim is not a weaker kind of signed");
        assert!(!r.capabilities_honored);
        assert!(!r.code_covered_by_signature);

        let err = install(&f, true).unwrap_err();
        assert!(err.contains("broken signature"), "unexpected: {err}");
        assert!(!f.ext.join("demo.js").exists());
    }

    #[test]
    fn signed_without_code_hash_is_refused_at_install() {
        let f = fixture();
        // Sign the manifest WITHOUT a codeHash (the pre-G0 shape).
        let kp = PublisherKeypair::load_or_create(&f.profile).unwrap();
        let p = f.src.join("demo.manifest.json");
        let mut m: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        m.as_object_mut()
            .unwrap()
            .insert("publisherKey".into(), kp.public_key_hex().into());
        std::fs::write(&p, serde_json::to_string_pretty(&m).unwrap()).unwrap();
        let sig = kp.sign(&std::fs::read(&p).unwrap());
        std::fs::write(f.src.join("demo.manifest.sig"), sig).unwrap();

        let r = preview(&f);
        // NOT "firstUse". The adversarial pass tightened this: a signature that
        // makes no claim about the program file is not a weaker kind of trusted,
        // so it gets its own status and lands OUTSIDE trust_grants_capabilities.
        // Reporting it as firstUse meant the preview said "capabilities honored"
        // for an add-in the installer was about to refuse, and — worse — the
        // SCAN honored them for a hand-copied one that never met the installer.
        assert_eq!(r.trust_status, TRUST_CODE_UNVERIFIED);
        assert!(!trust_grants_capabilities(&r.trust_status));
        assert!(!r.capabilities_honored);
        assert_eq!(r.code_hash_status, "notDeclared");
        assert!(!r.code_covered_by_signature);
        assert!(r
            .warnings
            .iter()
            .any(|w| w.contains("NOT its code")));

        let err = install(&f, false).unwrap_err();
        assert!(err.contains("does not cover its program file"), "unexpected: {err}");
        assert!(load_pins(&f.profile).unwrap().is_empty());
    }

    /// The scan half of the same rule. This is the one that matters: `inspect`
    /// only runs when a user installs, while `verify_extension_manifest` runs on
    /// EVERY launch and is what actually gates the capability ceiling. A signed
    /// but hash-less add-in that was hand-copied past the installer used to come
    /// back `firstUse`/`verified` from here — full declared ceiling, including
    /// formula.udf — with its program file authenticated by nothing.
    #[test]
    fn scan_refuses_to_trust_a_signature_that_does_not_cover_the_code() {
        let f = fixture();
        let kp = PublisherKeypair::load_or_create(&f.profile).unwrap();
        let p = f.src.join("demo.manifest.json");
        let mut m: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        m.as_object_mut()
            .unwrap()
            .insert("publisherKey".into(), kp.public_key_hex().into());
        std::fs::write(&p, serde_json::to_string_pretty(&m).unwrap()).unwrap();
        std::fs::write(
            f.src.join("demo.manifest.sig"),
            kp.sign(&std::fs::read(&p).unwrap()),
        )
        .unwrap();

        let (json, status) = crate::verify_extension_manifest(
            &p,
            &f.src.join("demo.manifest.sig"),
            &f.profile,
        );
        assert!(json.is_some());
        assert_eq!(status, TRUST_CODE_UNVERIFIED);
        assert!(!trust_grants_capabilities(&status));
        // ...and it must NOT have pinned the publisher on the way past: a key we
        // are not willing to trust must not become the pin a genuine later
        // release is then measured against.
        assert!(load_pins(&f.profile).unwrap().is_empty());
    }

    /// TOFU must FAIL CLOSED when its own store cannot be read.
    ///
    /// The scan used to answer `verified` in this case and the installer
    /// `firstUse` — both open, and both reachable by an attacker who can write
    /// the user's profile directory (the same attacker the codeHash work already
    /// assumes can write `%APPDATA%/…/extensions`). Corrupt one small JSON file
    /// and a publisher-key SUBSTITUTION stops being reported at all.
    #[test]
    fn an_unreadable_pin_store_is_not_trusted() {
        let f = fixture();
        sign(&f, &f.profile);
        install(&f, false).unwrap();

        let manifest = f.ext.join("demo.manifest.json");
        let sig = f.ext.join("demo.manifest.sig");
        // Sanity: this is the trusted state we are about to break.
        let (_, good) = crate::verify_extension_manifest(&manifest, &sig, &f.profile);
        assert_eq!(good, TRUST_VERIFIED);

        // Corrupt the pin store (unparseable, not absent — absent is a real
        // "never seen anybody" and legitimately pins).
        std::fs::write(
            calp::signing::trusted_publishers_file_path(&f.profile),
            "{ not json",
        )
        .unwrap();

        let (_, status) = crate::verify_extension_manifest(&manifest, &sig, &f.profile);
        assert_eq!(status, TRUST_UNAVAILABLE);
        assert!(!trust_grants_capabilities(&status));

        // The installer must agree, and must refuse rather than re-pin.
        let r = preview(&f);
        assert_eq!(r.trust_status, TRUST_UNAVAILABLE);
        assert!(!r.capabilities_honored);
        let err = install(&f, false).unwrap_err();
        assert!(err.contains("could not read its own record"), "unexpected: {err}");
    }

    // -- Structural refusals -------------------------------------------------

    #[test]
    fn a_bundle_without_a_sidecar_is_refused() {
        let f = fixture();
        std::fs::remove_file(f.src.join("demo.manifest.json")).unwrap();
        let err = inspect(&f.src, &f.ext, &f.profile).unwrap_err();
        assert!(err.contains("no sidecar manifest"), "unexpected: {err}");
    }

    #[test]
    fn a_bundle_that_refuses_the_sandbox_is_refused() {
        let f = fixture();
        let p = f.src.join("demo.manifest.json");
        let text = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, text.replace("\"workerSupport\": true", "\"workerSupport\": false"))
            .unwrap();
        let r = preview(&f);
        assert!(!r.worker_support);
        assert!(r.warnings.iter().any(|w| w.contains("never gives")));
        let err = install(&f, true).unwrap_err();
        assert!(err.contains("workerSupport"), "unexpected: {err}");
    }

    #[test]
    fn dest_names_that_could_escape_the_extensions_folder_are_refused() {
        for bad in ["..", "../evil", "a/b", "a\\b", ".hidden", ""] {
            assert!(validate_dest_name(bad).is_err(), "should reject {bad:?}");
        }
        for good in ["tax-tools", "acme.demo", "my_ext1"] {
            assert!(validate_dest_name(good).is_ok(), "should accept {good:?}");
        }
    }

    // -- Directory bundles + replacement -------------------------------------

    #[test]
    fn directory_bundle_installs_into_its_own_folder() {
        let src = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let inner = src.path().join("my-addin");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("index.js"), CODE).unwrap();
        std::fs::write(inner.join("extension.manifest.json"), MANIFEST).unwrap();

        let i = inspect(&inner, ext.path(), profile.path()).unwrap();
        assert_eq!(i.report.bundle_file_name, "my-addin/index.js");
        let r = install_inspected(i, ext.path(), profile.path(), false).unwrap();
        assert!(r.installed);
        assert!(ext.path().join("my-addin").join("index.js").is_file());
        assert!(ext
            .path()
            .join("my-addin")
            .join("extension.manifest.json")
            .is_file());
    }

    #[test]
    fn reinstalling_unsigned_over_signed_removes_the_stale_signature() {
        let f = fixture();
        sign(&f, &f.profile);
        install(&f, false).unwrap();
        assert!(f.ext.join("demo.manifest.sig").is_file());

        // The author ships an UNSIGNED build next.
        std::fs::remove_file(f.src.join("demo.manifest.sig")).unwrap();
        let r = install(&f, false).unwrap();
        assert_eq!(r.trust_status, "unsigned");
        assert!(
            !f.ext.join("demo.manifest.sig").exists(),
            "a stale signature must never survive a replacement"
        );
    }

    #[test]
    fn already_installed_is_reported_with_its_version() {
        let f = fixture();
        install(&f, false).unwrap();
        let r = preview(&f);
        assert!(r.already_installed);
        assert_eq!(r.installed_version, "1.0.0");
        assert!(r.warnings.iter().any(|w| w.contains("already installed")));
    }

    #[test]
    fn installed_code_hash_status_detects_post_install_tampering() {
        let f = fixture();
        sign(&f, &f.profile);
        install(&f, false).unwrap();

        let installed_manifest = f.ext.join("demo.manifest.json");
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&installed_manifest).unwrap()).unwrap();
        assert_eq!(
            installed_code_hash_status(&installed_manifest, &manifest),
            CodeHashStatus::Match
        );

        // Swap the installed program file in place (the malware case).
        std::fs::write(f.ext.join("demo.js"), "/* evil */").unwrap();
        assert_eq!(
            installed_code_hash_status(&installed_manifest, &manifest),
            CodeHashStatus::Mismatch
        );
    }

    /// END-TO-END through the REAL scan-time verifier (`verify_extension_manifest`
    /// in lib.rs, the function `scan_extension_directory` calls for every bundle
    /// on disk). This is the test that proves code coverage is not merely an
    /// install-time nicety: an add-in the user already trusted, whose PROGRAM
    /// FILE is swapped afterwards, must come back from the scan as `invalid` —
    /// which is the status the frontend zeroes the capability ceiling for,
    /// taking `formula.udf` (and therefore every worksheet function) with it.
    #[test]
    fn scan_reports_invalid_when_installed_code_is_swapped_after_trust() {
        let f = fixture();
        sign(&f, &f.profile);
        install(&f, false).unwrap();

        let manifest = f.ext.join("demo.manifest.json");
        let sig = f.ext.join("demo.manifest.sig");

        // A normal launch: signature verifies, code matches, publisher pinned.
        let (json, status) = crate::verify_extension_manifest(&manifest, &sig, &f.profile);
        assert!(json.is_some());
        assert_eq!(status, "verified");

        // Malware rewrites the installed bundle. Manifest + signature untouched.
        std::fs::write(f.ext.join("demo.js"), "/* evil */ export default {};").unwrap();
        let (_, status) = crate::verify_extension_manifest(&manifest, &sig, &f.profile);
        assert_eq!(
            status, "invalid",
            "a swapped program file must break the add-in's trust at scan time"
        );

        // Restoring the signed bytes restores trust (no permanent poisoning).
        std::fs::write(f.ext.join("demo.js"), CODE).unwrap();
        let (_, status) = crate::verify_extension_manifest(&manifest, &sig, &f.profile);
        assert_eq!(status, "verified");
    }

    /// The directory-bundle half of the same wiring: `extension.manifest.json`
    /// must resolve to `index.js`, not to a same-named sibling.
    #[test]
    fn scan_code_hash_check_follows_the_directory_bundle_convention() {
        let src = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let inner = src.path().join("dir-addin");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("index.js"), CODE).unwrap();
        std::fs::write(inner.join("extension.manifest.json"), MANIFEST).unwrap();

        // Sign it the way calcula-sign does.
        let kp = PublisherKeypair::load_or_create(profile.path()).unwrap();
        let mp = inner.join("extension.manifest.json");
        let mut m: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&mp).unwrap()).unwrap();
        let hash = calp::signing::extension_code_hash(&inner.join("index.js")).unwrap();
        let obj = m.as_object_mut().unwrap();
        obj.insert("publisherKey".into(), kp.public_key_hex().into());
        obj.insert("codeHash".into(), hash.into());
        std::fs::write(&mp, format!("{}\n", serde_json::to_string_pretty(&m).unwrap())).unwrap();
        std::fs::write(
            inner.join("extension.manifest.sig"),
            kp.sign(&std::fs::read(&mp).unwrap()),
        )
        .unwrap();

        let i = inspect(&inner, ext.path(), profile.path()).unwrap();
        assert_eq!(i.report.trust_status, "firstUse");
        assert!(i.report.code_covered_by_signature);
        install_inspected(i, ext.path(), profile.path(), false).unwrap();

        let dest = ext.path().join("dir-addin");
        let (_, status) = crate::verify_extension_manifest(
            &dest.join("extension.manifest.json"),
            &dest.join("extension.manifest.sig"),
            profile.path(),
        );
        assert_eq!(status, "verified");

        std::fs::write(dest.join("index.js"), "/* evil */").unwrap();
        let (_, status) = crate::verify_extension_manifest(
            &dest.join("extension.manifest.json"),
            &dest.join("extension.manifest.sig"),
            profile.path(),
        );
        assert_eq!(status, "invalid");
    }

    /// THE DOCUMENTED END-TO-END PATH, against the REAL example add-in in the
    /// repo (`docs/examples/addin-tax-tools/`): an author signs it, a user
    /// installs it, and the next scan reports it as a verified add-in whose
    /// `formula.udf` ceiling is honored — which is what makes VATRATE/VATAMOUNT
    /// reachable from a cell.
    ///
    /// It exists so the on-ramp described in the docs cannot rot into fiction:
    /// if the example's manifest stops declaring what it declares, or the
    /// signing/install/scan chain drifts, this fails.
    #[test]
    fn documented_example_addin_signs_installs_and_scans_verified() {
        let example = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("docs")
            .join("examples")
            .join("addin-tax-tools");
        assert!(
            example.join("tax-tools.js").is_file(),
            "the documented example moved: {}",
            example.display()
        );

        // The author's machine: a copy of the example + their publisher key.
        let src = tempfile::tempdir().unwrap();
        let ext = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        for f in ["tax-tools.js", "tax-tools.manifest.json"] {
            std::fs::copy(example.join(f), src.path().join(f)).unwrap();
        }

        // 1. AUTHOR SIGNS (exactly what `calcula-sign sign` does).
        let kp = PublisherKeypair::load_or_create(profile.path()).unwrap();
        let mp = src.path().join("tax-tools.manifest.json");
        let mut m: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&mp).unwrap()).unwrap();
        let hash = calp::signing::extension_code_hash(&src.path().join("tax-tools.js")).unwrap();
        {
            let obj = m.as_object_mut().unwrap();
            obj.insert("publisherKey".into(), kp.public_key_hex().into());
            obj.insert("codeHash".into(), hash.into());
        }
        std::fs::write(&mp, format!("{}\n", serde_json::to_string_pretty(&m).unwrap())).unwrap();
        std::fs::write(
            src.path().join("tax-tools.manifest.sig"),
            format!("{}\n", kp.sign(&std::fs::read(&mp).unwrap())),
        )
        .unwrap();

        // 2. USER PREVIEWS. Everything the consent decision needs is disclosed,
        //    and the add-in's code has still never been read as code.
        let user_profile = tempfile::tempdir().unwrap();
        let preview = inspect(src.path(), ext.path(), user_profile.path()).unwrap().report;
        assert_eq!(preview.id, "calcula.example.tax-tools");
        assert_eq!(preview.trust_status, "firstUse");
        assert!(preview.code_covered_by_signature);
        assert!(preview.capabilities_honored);
        assert!(preview.declared_capabilities.contains(&"formula.udf".to_string()));
        let formulas = preview
            .contributions
            .iter()
            .find(|c| c.kind == "formulas")
            .expect("the example declares worksheet functions");
        assert_eq!(formulas.ids, vec!["VATRATE".to_string(), "VATAMOUNT".to_string()]);
        assert!(!preview.installed, "a preview must not install");
        assert!(
            load_pins(user_profile.path()).unwrap().is_empty(),
            "a preview must not pin"
        );

        // 3. USER INSTALLS.
        let i = inspect(src.path(), ext.path(), user_profile.path()).unwrap();
        let done = install_inspected(i, ext.path(), user_profile.path(), false).unwrap();
        assert!(done.installed && done.pinned);
        assert_eq!(done.bundle_file_name, "tax-tools.js");

        // 4. NEXT LAUNCH: the scan the shell actually runs reports it verified,
        //    so the frontend honors the declared ceiling — formula.udf included.
        let (json, status) = crate::verify_extension_manifest(
            &ext.path().join("tax-tools.manifest.json"),
            &ext.path().join("tax-tools.manifest.sig"),
            user_profile.path(),
        );
        assert_eq!(status, "verified");
        let scanned: serde_json::Value = serde_json::from_str(&json.unwrap()).unwrap();
        assert_eq!(
            scanned["capabilities"],
            serde_json::json!(["formula.udf", "ui.dialog"])
        );
    }

    // -- Machine-scoped install audit ----------------------------------------

    /// The trail records the decision, not the comfortable state that followed
    /// it: a first-contact install must be filed under the trust status the user
    /// was actually shown (`firstUse`), even though the install then collapses
    /// the report to `verified` as a RESULT of them saying yes.
    #[test]
    fn installing_records_the_decision_and_the_pin_in_the_machine_trail() {
        let f = fixture();
        let key = sign(&f, &f.profile);
        install(&f, false).unwrap();

        let trail = crate::extension_audit::read_trail(&f.profile);
        assert!(!trail.missing);
        assert_eq!(trail.unreadable_lines, 0);
        assert_eq!(trail.entries.len(), 2, "an install and its pin are two decisions");

        // Newest first: the pin.
        let pin = &trail.entries[0];
        assert_eq!(pin.action, crate::extension_audit::ACTION_PUBLISHER_PINNED);
        assert_eq!(pin.publisher_key, key);
        assert!(pin.previous_publisher_key.is_empty());
        assert!(pin.detail.contains("now trusted"));

        let installed = &trail.entries[1];
        assert_eq!(installed.action, crate::extension_audit::ACTION_INSTALLED);
        assert_eq!(installed.id, "acme.demo");
        assert_eq!(installed.name, "Demo Add-in");
        assert_eq!(installed.version, "1.0.0");
        assert_eq!(installed.bundle_file_name, "demo.js");
        assert_eq!(installed.publisher_key, key);
        assert_eq!(
            installed.trust_status, TRUST_FIRST_USE,
            "the trail must preserve what Calcula could prove when the user decided"
        );
        assert!(installed.capabilities_honored);
        assert_eq!(installed.declared_capabilities, vec!["formula.udf".to_string()]);
        assert_eq!(
            installed.contributions,
            vec!["formulas:DEMO".to_string(), "commands:run".to_string()]
        );
        assert!(!installed.source_path.is_empty(), "the trail names where it came from");
    }

    /// An UNSIGNED install is still a decision, and it must record that the
    /// declared capabilities were refused — otherwise the trail would read as if
    /// the add-in got what it asked for.
    #[test]
    fn an_unsigned_install_is_recorded_with_its_capabilities_refused() {
        let f = fixture();
        install(&f, false).unwrap();
        let trail = crate::extension_audit::read_trail(&f.profile);
        assert_eq!(trail.entries.len(), 1, "nothing was pinned, so there is no pin row");
        let e = &trail.entries[0];
        assert_eq!(e.action, crate::extension_audit::ACTION_INSTALLED);
        assert_eq!(e.trust_status, TRUST_UNSIGNED);
        assert!(!e.capabilities_honored);
        assert!(e.publisher_key.is_empty());
        assert!(e.detail.contains("REFUSED"), "unexpected detail: {}", e.detail);
    }

    /// A refused install writes NOTHING. The trail is a record of what happened,
    /// not of what was attempted — a refusal row would make "installed" and
    /// "tried to install" look alike in the one list a user consults to find out
    /// what is on their machine.
    #[test]
    fn a_refused_install_leaves_no_trail_entry() {
        let f = fixture();
        sign(&f, &f.profile);
        std::fs::write(f.src.join("demo.js"), "/* evil */ export default {};").unwrap();
        install(&f, true).unwrap_err();
        assert!(
            crate::extension_audit::read_trail(&f.profile).missing,
            "a refusal must not be filed as a decision"
        );
    }

    /// The single row a user most needs months later: BOTH keys, named as a
    /// publisher change rather than as an ordinary pin.
    #[test]
    fn accepting_a_publisher_change_is_recorded_with_both_keys() {
        let f = fixture();
        sign(&f, &f.profile);
        install(&f, false).unwrap();
        let first_key = ext_pin(&f.profile, "acme.demo").unwrap();

        let other = tempfile::tempdir().unwrap();
        let second_key = sign(&f, other.path());
        install(&f, true).unwrap();

        let trail = crate::extension_audit::read_trail(&f.profile);
        let change = trail
            .entries
            .iter()
            .find(|e| e.action == crate::extension_audit::ACTION_PUBLISHER_CHANGE_ACCEPTED)
            .expect("the publisher change must be its own row");
        assert_eq!(change.previous_publisher_key, first_key);
        assert_eq!(change.publisher_key, second_key);
        assert_eq!(change.id, "acme.demo");
        assert!(change.detail.contains("DIFFERENT publisher"));

        // ...and the install it belonged to is filed under the status the user
        // was actually shown, not under the post-pin "verified".
        let installs: Vec<_> = trail
            .entries
            .iter()
            .filter(|e| e.action == crate::extension_audit::ACTION_INSTALLED)
            .collect();
        assert_eq!(installs.len(), 2);
        assert_eq!(installs[0].trust_status, TRUST_PUBLISHER_CHANGED);
    }

    // -- Scan-time first contact ---------------------------------------------

    /// The scan and the installer look at the SAME evidence and answer
    /// differently on purpose: `firstUse` is a promise only a human-attended
    /// install can keep.
    #[test]
    fn the_scan_reports_first_contact_as_not_installed_while_the_installer_says_first_use() {
        let f = fixture();
        sign(&f, &f.profile);

        assert_eq!(preview(&f).trust_status, TRUST_FIRST_USE);

        let manifest_bytes = std::fs::read(f.src.join("demo.manifest.json")).unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
        let sig = std::fs::read_to_string(f.src.join("demo.manifest.sig")).unwrap();
        let (scan_status, _) = decide_extension_trust_for_scan(
            &f.profile,
            "acme.demo",
            "1.0.0",
            manifest["publisherKey"].as_str().unwrap(),
            &manifest_bytes,
            &manifest,
            sig.trim(),
            Some(&f.src.join("demo.js")),
        );
        assert_eq!(scan_status, TRUST_NOT_INSTALLED);
        assert!(!trust_grants_capabilities(&scan_status));
        assert!(
            load_pins(&f.profile).unwrap().is_empty(),
            "the scan decision must not pin"
        );
    }

    /// Every OTHER status must be identical between the two paths — the scan
    /// wrapper narrows exactly one row and nothing else.
    #[test]
    fn the_scan_wrapper_changes_only_first_contact() {
        let f = fixture();
        sign(&f, &f.profile);
        install(&f, false).unwrap();

        let manifest_bytes = std::fs::read(f.ext.join("demo.manifest.json")).unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
        let sig = std::fs::read_to_string(f.ext.join("demo.manifest.sig")).unwrap();
        let args = |profile: &Path| {
            (
                profile.to_path_buf(),
                manifest_bytes.clone(),
                manifest.clone(),
                sig.trim().to_string(),
            )
        };
        let (p, mb, m, s) = args(&f.profile);
        let installer = decide_extension_trust(&p, "acme.demo", "1.0.0", m["publisherKey"].as_str().unwrap(), &mb, &m, &s, Some(&f.ext.join("demo.js")));
        let scan = decide_extension_trust_for_scan(&p, "acme.demo", "1.0.0", m["publisherKey"].as_str().unwrap(), &mb, &m, &s, Some(&f.ext.join("demo.js")));
        assert_eq!(installer.0, TRUST_VERIFIED);
        assert_eq!(scan.0, installer.0, "a pinned publisher reads the same on both paths");
    }

    #[test]
    fn every_trust_status_is_listed_exactly_once() {
        let mut seen = std::collections::HashSet::new();
        for s in EXTENSION_TRUST_STATUSES {
            assert!(seen.insert(*s), "duplicate trust status {s}");
        }
        assert!(seen.contains(TRUST_NOT_INSTALLED));
        // The two capability-granting statuses, and nothing else.
        let granting: Vec<_> = EXTENSION_TRUST_STATUSES
            .iter()
            .filter(|s| trust_grants_capabilities(s))
            .collect();
        assert_eq!(granting, vec![&TRUST_FIRST_USE, &TRUST_VERIFIED]);
    }

    #[test]
    fn contribution_kinds_are_the_documented_seven() {
        let kinds = contribution_kinds();
        assert_eq!(kinds.len(), 7);
        for k in [
            "formulas",
            "commands",
            "menuItems",
            "ribbonButtons",
            "keybindings",
            "cellStyles",
            "fileFormats",
        ] {
            assert!(kinds.contains_key(k), "missing contribution kind {k}");
        }
    }
}
