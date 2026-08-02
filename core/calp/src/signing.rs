//! FILENAME: core/calp/src/signing.rs
//! PURPOSE: Publisher signing (Ed25519) + TOFU publisher-key pinning (S5 phase 2).
//! CONTEXT: Phase 1 (integrity.rs) made every artifact verifiable from the
//! version manifest via SHA-256, but the manifest itself was unsigned: anyone
//! who can write to the registry could rewrite manifest + checksums together.
//! Phase 2 closes that hole and makes a package's ORIGIN verifiable:
//!
//!   - Each publisher has a persistent Ed25519 keypair in the per-user profile
//!     directory (`publisher-key.json`), created on first publish with the OS
//!     CSPRNG (`rand_core::OsRng`). NEVER use identity::generate_uuid_v7 for
//!     key material — it is a non-crypto PRNG.
//!   - On publish, the RAW BYTES of version-manifest.json as written to disk
//!     are signed; the detached signature is written next to it as
//!     `version-manifest.sig` (hex of the 64-byte signature). The manifest
//!     also carries the publisher's PUBLIC key (`publisher_key`), so the
//!     subscriber knows the asserted signer.
//!   - On pull/refresh/inspect, the signature is verified BEFORE artifact
//!     checksums, and the publisher key is pinned trust-on-first-use in
//!     `trusted-publishers.json`, keyed by `(namespace, registry scope, name)`
//!     — see the `PinKey` doc comment for why the key is not the name alone.
//!     First pull pins; later pulls must match the pin, else
//!     PublisherKeyChanged.
//!
//! This module owns the keypair, the sign/verify primitives, and the TOFU
//! store. integrity.rs wires them into the pull/inspect verification step.

//! EXTENSION ADD-INS (G0). The same keypair, the same detached-signature shape
//! and the same TOFU store also cover third-party EXTENSION sidecar manifests —
//! deliberately, so an author has ONE publisher identity and the app has ONE
//! trust root. The extension-specific pieces (file layout, the `codeHash` field
//! that extends signature coverage from the manifest to the bundle, and the
//! `PinNamespace::Ext` TOFU namespace) live at the bottom of this file so the signing
//! tool (`core/calcula-sign`), the installer and the scan-time verifier all
//! share one implementation instead of three that can drift.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};

use crate::error::CalpError;

// ---------------------------------------------------------------------------
// Hex helpers (hand-rolled, matching integrity::sha256_hex — no new dep)
// ---------------------------------------------------------------------------

/// Lowercase hex of a byte slice.
fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Decode a lowercase/uppercase hex string into bytes. Returns None on any
/// non-hex character or an odd length.
fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Publisher keypair (persisted, created on first publish via OS CSPRNG)
// ---------------------------------------------------------------------------

/// On-disk format for the publisher keypair (publisher-key.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublisherKeyFile {
    format_version: u32,
    /// Hex of the 32-byte Ed25519 secret (signing) key seed.
    secret_key: String,
    /// Hex of the 32-byte Ed25519 public (verifying) key.
    public_key: String,
    /// Human-readable display name (OS username) recorded for convenience.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    display_name: String,
}

/// A publisher's signing identity. Loaded/created from the per-user profile
/// directory, persists across sessions.
pub struct PublisherKeypair {
    signing_key: SigningKey,
    display_name: String,
}

fn publisher_key_file_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("publisher-key.json")
}

fn os_display_name() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "Unknown".to_string())
}

impl PublisherKeypair {
    /// Load the publisher keypair from the profile directory, or create one if
    /// none exists. Key material is generated with the OS CSPRNG (OsRng), NOT
    /// the codebase's non-crypto UUID PRNG. The profile directory is created
    /// if needed. Mirrors identity_provider::load_or_create.
    /// Load an EXISTING publisher keypair from the profile directory, or
    /// `Ok(None)` if this profile has never published (no publisher-key.json).
    /// Unlike `load_or_create`, this NEVER creates a keypair — it is a
    /// read-only ownership probe used to authorize publisher-only actions.
    pub fn load_existing(profile_dir: &Path) -> Result<Option<PublisherKeypair>, CalpError> {
        let path = publisher_key_file_path(profile_dir);
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path)?;
        let file: PublisherKeyFile = serde_json::from_str(&content)?;
        let secret = from_hex(&file.secret_key).ok_or_else(|| {
            CalpError::Registry("publisher-key.json: secretKey is not valid hex".to_string())
        })?;
        let seed: [u8; 32] = secret.as_slice().try_into().map_err(|_| {
            CalpError::Registry("publisher-key.json: secretKey must be 32 bytes".to_string())
        })?;
        let signing_key = SigningKey::from_bytes(&seed);
        let display_name = if file.display_name.is_empty() {
            os_display_name()
        } else {
            file.display_name
        };
        Ok(Some(PublisherKeypair {
            signing_key,
            display_name,
        }))
    }

    pub fn load_or_create(profile_dir: &Path) -> Result<PublisherKeypair, CalpError> {
        if let Some(kp) = Self::load_existing(profile_dir)? {
            return Ok(kp);
        }

        // First publish: generate fresh key material with the OS CSPRNG.
        let signing_key = SigningKey::generate(&mut OsRng);
        let display_name = os_display_name();

        std::fs::create_dir_all(profile_dir)?;
        let file = PublisherKeyFile {
            format_version: 1,
            secret_key: to_hex(&signing_key.to_bytes()),
            public_key: to_hex(signing_key.verifying_key().as_bytes()),
            display_name: display_name.clone(),
        };
        let content = serde_json::to_string_pretty(&file)?;
        std::fs::write(publisher_key_file_path(profile_dir), content)?;

        Ok(PublisherKeypair {
            signing_key,
            display_name,
        })
    }

    /// Lowercase hex of the 32-byte public (verifying) key.
    pub fn public_key_hex(&self) -> String {
        to_hex(self.signing_key.verifying_key().as_bytes())
    }

    /// The publisher's display name (OS username).
    pub fn display_name(&self) -> String {
        self.display_name.clone()
    }

    /// Sign arbitrary bytes (the raw on-disk manifest bytes). Returns the
    /// detached 64-byte signature as lowercase hex.
    pub fn sign(&self, bytes: &[u8]) -> String {
        let sig: Signature = self.signing_key.sign(bytes);
        to_hex(&sig.to_bytes())
    }
}

/// Does the keypair in `profile_dir` prove ownership of `publisher_key`?
///
/// Returns `true` iff this profile has a `publisher-key.json` whose Ed25519
/// public key (DERIVED from the on-disk secret key on load — not merely the
/// stored `publicKey` field) equals `publisher_key`. Because the public key is
/// recomputed from the secret, equality is cryptographically sound PROOF OF
/// POSSESSION of the matching private key: forging it would require breaking
/// Ed25519, not just editing a JSON field.
///
/// This is the authorization primitive for publisher-only actions
/// (approve/reject writeback submissions). An empty `publisher_key` (an
/// unsigned package) can never be owned, so it returns `false`.
pub fn profile_holds_publisher_key(
    profile_dir: &Path,
    publisher_key: &str,
) -> Result<bool, CalpError> {
    if publisher_key.is_empty() {
        return Ok(false);
    }
    match PublisherKeypair::load_existing(profile_dir)? {
        Some(kp) => Ok(kp.public_key_hex() == publisher_key),
        None => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// Verification primitive
// ---------------------------------------------------------------------------

/// Verify a detached Ed25519 signature over `bytes` against a hex-encoded
/// public key. Any failure — bad hex, wrong key length, wrong signature
/// length, or a signature that does not validate — maps to
/// ManifestSignatureInvalid (the caller supplies package/version context).
///
/// Uses `verify_strict`, which rejects signatures made with small-order /
/// non-canonical keys (the stricter, recommended check).
pub fn verify_signature(
    public_key_hex: &str,
    bytes: &[u8],
    signature_hex: &str,
    package: &str,
    version: &str,
) -> Result<(), CalpError> {
    let invalid = || CalpError::ManifestSignatureInvalid {
        package: package.to_string(),
        version: version.to_string(),
    };

    let key_bytes = from_hex(public_key_hex).ok_or_else(invalid)?;
    let key_arr: [u8; 32] = key_bytes.as_slice().try_into().map_err(|_| invalid())?;
    let verifying_key = VerifyingKey::from_bytes(&key_arr).map_err(|_| invalid())?;

    let sig_bytes = from_hex(signature_hex).ok_or_else(invalid)?;
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().map_err(|_| invalid())?;
    let signature = Signature::from_bytes(&sig_arr);

    verifying_key
        .verify_strict(bytes, &signature)
        .map_err(|_| invalid())
}

// ---------------------------------------------------------------------------
// TOFU pin store (trusted-publishers.json)
// ---------------------------------------------------------------------------
//
// WHY THE KEY HAS THREE PARTS. The store used to be a flat `packageName ->
// publisherKeyHex` map, so a package name mapped to one key for the whole
// MACHINE and whoever made first contact with a name owned it: `acme.finance`
// served once from `\\evil\share` wrote the pin that the genuine `acme.finance`
// was later measured against, and the real publisher's first release reported
// `PublisherKeyChanged` — an accusation pointed at the victim. The name was also
// shared across THREE namespaces: a report package, a script library and an org
// skin called `acme.finance` all wrote the same row, so an administrator's
// pre-pin silently overwrote a user's.
//
// A pin is now `(namespace, registry scope, name)`, built ONLY through
// `PinKey::calp` / `PinKey::extension`. Nothing anywhere concatenates a key
// string: the shape that made `"ext:" + id` a convention rather than a type is
// exactly the shape that let the three namespaces collide.

use crate::registry_id::RegistryScope;

/// Which trust namespace a pin belongs to. A `.calp` package (report, script
/// library or registry-published skin — all the same artifact over the same
/// rail) and an installed extension are different kinds of thing with different
/// naming authorities, and a name in one must never satisfy a lookup in the
/// other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PinNamespace {
    /// Anything pulled from a `.calp` registry: reports, script libraries, skins.
    Calp,
    /// An installed third-party extension add-in, keyed by its id.
    Ext,
}

impl PinNamespace {
    /// Stable wire string (also what the on-disk store carries).
    pub fn as_str(self) -> &'static str {
        match self {
            PinNamespace::Calp => "calp",
            PinNamespace::Ext => "ext",
        }
    }
}

/// The identity a pin is filed under. Constructed ONLY by the two functions
/// below — there is no public constructor taking raw strings, so a call site
/// cannot invent a scope or a namespace of its own.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct PinKey {
    namespace: PinNamespace,
    /// The `RegistryScope::id` (normalized key material), or "" where the
    /// namespace has no registry.
    scope: String,
    name: String,
}

impl PinKey {
    /// THE key construction. Every pin key in the codebase is built here.
    fn new(namespace: PinNamespace, scope_id: &str, name: &str) -> PinKey {
        PinKey {
            namespace,
            scope: scope_id.to_string(),
            name: name.to_string(),
        }
    }

    /// A `.calp` package pinned for ONE registry. Two registries serving the
    /// same package name hold independent pins, so a squat in one cannot own the
    /// name in another — and `PinStore::other_scopes_for_name` is what makes the
    /// two visible to each other.
    pub fn calp(scope: &RegistryScope, package: &str) -> PinKey {
        Self::new(PinNamespace::Calp, &scope.id, package)
    }

    /// An extension add-in, pinned MACHINE-GLOBALLY by id.
    ///
    /// This is a decision, not an oversight. There is no registry here — an
    /// extension is installed from a folder, and the only candidate scope is the
    /// attacker's own choice of location, so scoping by source folder would give
    /// a bundle dropped in `%USERPROFILE%\Downloads` a pristine scope and a free
    /// first use on an id it does not own. That is precisely the squat Wave H
    /// closed. For an id namespace with no naming authority behind it,
    /// machine-global first-contact ownership IS the semantics; the protection
    /// is that only a human at the installer can claim it.
    pub fn extension(id: &str) -> PinKey {
        Self::new(PinNamespace::Ext, "", id)
    }

    pub fn namespace(&self) -> PinNamespace {
        self.namespace
    }
    pub fn scope(&self) -> &str {
        &self.scope
    }
    pub fn name(&self) -> &str {
        &self.name
    }
}

/// One row of the pin store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRecord {
    pub namespace: PinNamespace,
    /// `RegistryScope::id` — normalized key material. Never displayed.
    pub scope: String,
    /// The registry location EXACTLY as the user configured it. The only form a
    /// UI, an error or an audit entry may show.
    pub scope_label: String,
    pub name: String,
    /// Pinned Ed25519 public key (lowercase hex).
    pub publisher_key: String,
    /// RFC3339 timestamp of when this pin was written. Empty for a pin carried
    /// over from the v1 store, which recorded no time.
    pub pinned_at: String,
}

impl PinRecord {
    fn key(&self) -> PinKey {
        PinKey::new(self.namespace, &self.scope, &self.name)
    }
}

/// On-disk format (v2). An ARRAY rather than a map, so a scope string containing
/// any character at all is safe as data, and so the file stays greppable and
/// auditable by a human looking at what their machine trusts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinFile {
    format_version: u32,
    pins: Vec<PinRecord>,
}

/// The v1 shape, read exactly once per profile (at migration) and never again.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustedPublishersFileV1 {
    format_version: u32,
    publishers: BTreeMap<String, String>,
}

const PIN_FILE_VERSION: u32 = 2;

/// Where the TOFU pin store lives. Public so a test can corrupt exactly the file
/// the loader reads (rather than hard-coding the name and drifting from it) —
/// which is how the "an unreadable pin store must not read as trusted" rule is
/// proved rather than asserted.
pub fn trusted_publishers_file_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("trusted-publishers.json")
}

/// Where v1 pins that could not be migrated are written for the user to audit.
/// NOTHING reads this file; it exists so "what did this machine used to trust?"
/// has an answer after the format change.
pub fn discarded_pins_file_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("trusted-publishers.v1.discarded.json")
}

/// The machine's publisher pins, indexed by `PinKey`.
#[derive(Debug, Clone, Default)]
pub struct PinStore {
    pins: BTreeMap<PinKey, PinRecord>,
}

impl PinStore {
    /// The pin for exactly this (namespace, scope, name), if any.
    pub fn get(&self, key: &PinKey) -> Option<&PinRecord> {
        self.pins.get(key)
    }

    /// Pins for the SAME namespace and name in a DIFFERENT scope.
    ///
    /// This is the cross-check that makes registry scoping safe. Without it,
    /// scoping would trade a loud false alarm (the genuine publisher reported as
    /// a key change) for a quiet true miss (a hostile registry serving a familiar
    /// name becoming an ordinary silent first use). With it, first contact in a
    /// new scope can say which of the two it is: same key elsewhere = a migration
    /// or a mirror; a different key elsewhere = a name conflict the user must be
    /// shown before anything is pinned.
    ///
    /// THE NAME MATCH IS CASE-INSENSITIVE, and the exact-key lookup in `get` is
    /// not. That asymmetry is deliberate and only ever points one way:
    ///
    ///   * `get` stays exact, so loosening the compare can never GRANT trust —
    ///     `Acme.Finance` can never satisfy a pin recorded for `acme.finance`.
    ///   * this scan is loose, so a hostile registry cannot dodge the conflict
    ///     warning by re-casing a name the user already trusts. Local registries
    ///     live on a case-insensitive filesystem, so `Acme.Finance` and
    ///     `acme.finance` are frequently the very same package anyway; without
    ///     this, one flipped letter turned a red `NotPinnedNameConflict` into an
    ///     ordinary amber `NotPinned` — the quiet true miss this cross-check
    ///     exists to prevent.
    ///
    /// The cost is that two genuinely distinct packages whose names differ only
    /// by case (possible on an HTTP registry, where paths are case-sensitive)
    /// report a conflict and need the second confirmation. That is the
    /// conservative direction: loud and answerable, not silent.
    pub fn other_scopes_for_name(
        &self,
        namespace: PinNamespace,
        name: &str,
        exclude_scope: &str,
    ) -> Vec<&PinRecord> {
        self.pins
            .values()
            .filter(|r| {
                r.namespace == namespace
                    && r.name.eq_ignore_ascii_case(name)
                    && r.scope != exclude_scope
            })
            .collect()
    }

    /// Every pin, for the transparency surface that answers "what does this
    /// machine trust, and from where?".
    pub fn records(&self) -> impl Iterator<Item = &PinRecord> {
        self.pins.values()
    }

    pub fn is_empty(&self) -> bool {
        self.pins.is_empty()
    }

    pub fn len(&self) -> usize {
        self.pins.len()
    }

    fn from_records(records: Vec<PinRecord>) -> PinStore {
        let mut pins = BTreeMap::new();
        for record in records {
            pins.insert(record.key(), record);
        }
        PinStore { pins }
    }

    fn to_file(&self) -> PinFile {
        PinFile {
            format_version: PIN_FILE_VERSION,
            pins: self.pins.values().cloned().collect(),
        }
    }
}

/// Load the machine's pins. A store that does not exist yet is an empty store
/// (a real "nobody here has ever trusted anybody"); a store that EXISTS and
/// cannot be read or parsed is an `Err` that propagates — fail-closed, because
/// treating an unreadable pin file as "nothing is pinned" is exactly how a key
/// substitution becomes a trusted state.
///
/// A v1 store is migrated in place on first load: extension pins carry over
/// losslessly, everything else is discarded (see `migrate_v1_store`).
pub fn load_pins(profile_dir: &Path) -> Result<PinStore, CalpError> {
    let path = trusted_publishers_file_path(profile_dir);
    if !path.exists() {
        return Ok(PinStore::default());
    }
    let content = std::fs::read_to_string(&path)?;
    let value: serde_json::Value = serde_json::from_str(&content)?;
    let version = value
        .get("formatVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    match version {
        PIN_FILE_VERSION_U64 => {
            let file: PinFile = serde_json::from_value(value)?;
            Ok(PinStore::from_records(file.pins))
        }
        1 => {
            let file: TrustedPublishersFileV1 = serde_json::from_value(value)?;
            migrate_v1_store(profile_dir, file)
        }
        other => Err(CalpError::Registry(format!(
            "trusted-publishers.json declares formatVersion {other}, which this build does not \
             understand. Refusing to read it: an unreadable pin store must never be treated as \
             'nothing is pinned'."
        ))),
    }
}

const PIN_FILE_VERSION_U64: u64 = PIN_FILE_VERSION as u64;

/// Migrate a v1 (name -> key) store.
///
/// **Extension pins migrate exactly.** `ext:<id>` becomes `(Ext, "", id)` — the
/// same key with the same meaning, no guess involved. Discarding them would cost
/// every installed add-in its capability ceiling until reinstalled, for no
/// security gain.
///
/// **Bare-name `.calp` pins are DISCARDED.** The v1 store does not record where a
/// pin came from, and there is no honest way to invent it: the available
/// inference sources (`registries.json`, subscriptions inside `.cala` files) have
/// no package linkage, and a wrong guess would BIND A PIN TO A REGISTRY IT DOES
/// NOT BELONG TO — the silent-trust outcome this whole change exists to
/// eliminate, most likely to be wrong in precisely the multi-registry case that
/// motivated it. So they are written to `trusted-publishers.v1.discarded.json`
/// for the user to audit, and the affected subscriptions re-prompt (they report
/// `notPinned`, and the Subscriptions pane already says how to fix that).
fn migrate_v1_store(
    profile_dir: &Path,
    v1: TrustedPublishersFileV1,
) -> Result<PinStore, CalpError> {
    let mut records: Vec<PinRecord> = Vec::new();
    let mut discarded: BTreeMap<String, String> = BTreeMap::new();

    for (name, key_hex) in v1.publishers {
        match name.strip_prefix("ext:") {
            Some(id) if !id.is_empty() => records.push(PinRecord {
                namespace: PinNamespace::Ext,
                scope: String::new(),
                scope_label: String::new(),
                name: id.to_string(),
                publisher_key: key_hex,
                // v1 recorded no time. Say so rather than invent one.
                pinned_at: String::new(),
            }),
            _ => {
                discarded.insert(name, key_hex);
            }
        }
    }

    std::fs::create_dir_all(profile_dir)?;
    if !discarded.is_empty() {
        let note = serde_json::json!({
            "formatVersion": 1,
            "discardedAt": now_rfc3339(),
            "why": "Publisher pins are now scoped to the registry they came from. \
                    A v1 pin recorded only the package name, so there is no honest way to \
                    say which registry it belonged to. These pins were discarded rather \
                    than guessed; the packages will ask again on the next subscribe. \
                    Nothing reads this file — it is here so you can see what this \
                    machine used to trust.",
            "publishers": discarded,
        });
        std::fs::write(
            discarded_pins_file_path(profile_dir),
            serde_json::to_string_pretty(&note)?,
        )?;
    }

    let store = PinStore::from_records(records);
    write_pins(profile_dir, &store)?;
    Ok(store)
}

fn write_pins(profile_dir: &Path, store: &PinStore) -> Result<(), CalpError> {
    std::fs::create_dir_all(profile_dir)?;
    let content = serde_json::to_string_pretty(&store.to_file())?;
    std::fs::write(trusted_publishers_file_path(profile_dir), content)?;
    Ok(())
}

/// RFC3339 timestamp for a pin write. Taken from the clock HERE rather than
/// threaded through every caller: a call site has no better answer than "now",
/// and a parameter nobody can get right is a parameter that eventually gets
/// passed wrong.
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Pin a publisher key under `key` (trust-on-first-use). Reads the current
/// store, inserts/updates the row, and writes it back. The profile directory is
/// created if needed.
///
/// `scope_label` is the registry location as the USER configured it, carried
/// alongside the normalized scope id so a later "what does this machine trust?"
/// view can name the registry in the user's own spelling. Pass "" for a
/// namespace with no registry.
pub fn pin_publisher(
    profile_dir: &Path,
    key: &PinKey,
    scope_label: &str,
    key_hex: &str,
) -> Result<(), CalpError> {
    let mut store = load_pins(profile_dir)?;
    store.pins.insert(
        key.clone(),
        PinRecord {
            namespace: key.namespace,
            scope: key.scope.clone(),
            scope_label: scope_label.to_string(),
            name: key.name.clone(),
            publisher_key: key_hex.to_string(),
            pinned_at: now_rfc3339(),
        },
    );
    write_pins(profile_dir, &store)
}

// ---------------------------------------------------------------------------
// Third-party EXTENSION add-ins: layout, code-hash coverage, TOFU namespace
// ---------------------------------------------------------------------------

/// The JSON field in an extension sidecar manifest that carries the SHA-256 of
/// the bundle the host will execute. It is inside the signed bytes, which is the
/// only reason a signature over the manifest says anything about the CODE.
pub const EXTENSION_CODE_HASH_FIELD: &str = "codeHash";

/// The suffix every extension sidecar manifest must have.
pub const EXTENSION_MANIFEST_SUFFIX: &str = ".manifest.json";

/// The base name reserved for the DIRECTORY-bundle convention
/// (`<ext-dir>/extension.manifest.json` + `<ext-dir>/index.js`).
pub const EXTENSION_DIR_MANIFEST_BASE: &str = "extension";

/// The three files that make up a third-party add-in on disk. Resolved purely
/// from names (no filesystem probing), so the signing tool, the installer and
/// the scan-time verifier can never disagree about WHICH bytes were signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionBundleLayout {
    /// `<base>.manifest.json` — the bytes that are signed.
    pub manifest: PathBuf,
    /// `<base>.manifest.sig` — hex of the detached Ed25519 signature.
    pub signature: PathBuf,
    /// The single JavaScript file the host imports (`<base>.js`, or `index.js`
    /// for the directory-bundle convention). This is the ONLY executed file.
    pub bundle: PathBuf,
}

/// Resolve the layout from a sidecar manifest path.
///
/// Naming rules (must match `scan_extension_directory`):
///   - `<dir>/extension.manifest.json` -> bundle `<dir>/index.js`  (directory bundle)
///   - `<dir>/<base>.manifest.json`    -> bundle `<dir>/<base>.js` (file bundle)
///
/// Returns `None` when the path does not end in `.manifest.json` or has an
/// empty base. `extension.js` is therefore NOT a usable file-bundle name — the
/// base `extension` is reserved for the directory convention. That is a
/// deliberate refusal rather than a probe-the-disk guess: which file the
/// signature covers must never depend on what else happens to be in the folder.
pub fn extension_layout_for_manifest(manifest_path: &Path) -> Option<ExtensionBundleLayout> {
    let file_name = manifest_path.file_name()?.to_str()?;
    let base = file_name.strip_suffix(EXTENSION_MANIFEST_SUFFIX)?;
    if base.is_empty() {
        return None;
    }
    let dir = manifest_path.parent().unwrap_or_else(|| Path::new(""));
    let bundle_name = if base == EXTENSION_DIR_MANIFEST_BASE {
        "index.js".to_string()
    } else {
        format!("{}.js", base)
    };
    Some(ExtensionBundleLayout {
        manifest: manifest_path.to_path_buf(),
        signature: dir.join(format!("{}.manifest.sig", base)),
        bundle: dir.join(bundle_name),
    })
}

/// Resolve the layout from whatever an author or a user pointed at: a bundle
/// `.js`, a `<base>.manifest.json`, or the folder that contains them.
///
/// Folder rules:
///   - contains `index.js` -> directory bundle (`extension.manifest.json`)
///   - otherwise exactly ONE top-level `*.js` -> file bundle for that file
///   - zero or several -> an error naming the ambiguity
pub fn extension_layout_for_source(source: &Path) -> Result<ExtensionBundleLayout, CalpError> {
    let bad = |msg: String| CalpError::Registry(msg);

    if source.is_dir() {
        if source.join("index.js").is_file() {
            let manifest = source.join(format!(
                "{}{}",
                EXTENSION_DIR_MANIFEST_BASE, EXTENSION_MANIFEST_SUFFIX
            ));
            return extension_layout_for_manifest(&manifest)
                .ok_or_else(|| bad("could not resolve the directory-bundle layout".to_string()));
        }
        let mut js: Vec<PathBuf> = Vec::new();
        for entry in std::fs::read_dir(source)? {
            let path = entry?.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("js") {
                js.push(path);
            }
        }
        js.sort();
        return match js.len() {
            0 => Err(bad(format!(
                "'{}' contains no add-in bundle: expected index.js or a single <name>.js",
                source.display()
            ))),
            1 => extension_layout_for_source(&js[0]),
            n => Err(bad(format!(
                "'{}' contains {} .js files; point at the bundle file itself so it is unambiguous which one is signed",
                source.display(),
                n
            ))),
        };
    }

    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| bad(format!("'{}' is not a usable file name", source.display())))?;

    if file_name.ends_with(EXTENSION_MANIFEST_SUFFIX) {
        return extension_layout_for_manifest(source)
            .ok_or_else(|| bad(format!("'{}' is not a valid sidecar manifest name", file_name)));
    }

    let stem = file_name
        .strip_suffix(".js")
        .ok_or_else(|| bad(format!(
            "'{}' is neither a .js bundle, a <name>.manifest.json, nor a folder",
            file_name
        )))?;
    let dir = source.parent().unwrap_or_else(|| Path::new(""));
    let base = if stem == "index" {
        EXTENSION_DIR_MANIFEST_BASE
    } else {
        stem
    };
    if base == EXTENSION_DIR_MANIFEST_BASE && stem == EXTENSION_DIR_MANIFEST_BASE {
        return Err(bad(
            "'extension.js' is a reserved name: the base 'extension' belongs to the \
             directory-bundle convention (extension.manifest.json + index.js). Rename the bundle."
                .to_string(),
        ));
    }
    extension_layout_for_manifest(&dir.join(format!("{}{}", base, EXTENSION_MANIFEST_SUFFIX)))
        .ok_or_else(|| bad(format!("could not resolve a layout for '{}'", file_name)))
}

/// SHA-256 (lowercase hex) of the bundle file the host will execute.
pub fn extension_code_hash(bundle: &Path) -> Result<String, CalpError> {
    let bytes = std::fs::read(bundle)?;
    Ok(crate::integrity::sha256_hex(&bytes))
}

/// Outcome of comparing a manifest's declared `codeHash` to the bundle on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeHashStatus {
    /// The manifest does not declare `codeHash`: the signature covers the
    /// manifest ONLY, so the executable bytes are NOT authenticated.
    NotDeclared,
    /// Declared and matching: the signature transitively covers the bundle.
    Match,
    /// Declared and DIFFERENT: the bundle was modified after signing.
    Mismatch,
    /// Declared, but the bundle could not be read.
    BundleUnreadable,
}

impl CodeHashStatus {
    /// Stable wire string for the frontend / reports.
    pub fn as_str(self) -> &'static str {
        match self {
            CodeHashStatus::NotDeclared => "notDeclared",
            CodeHashStatus::Match => "match",
            CodeHashStatus::Mismatch => "mismatch",
            CodeHashStatus::BundleUnreadable => "bundleUnreadable",
        }
    }
}

/// Compare the `codeHash` inside an already-signature-verified manifest against
/// the bundle on disk.
///
/// SECURITY: call this ONLY after `verify_signature` succeeded over the raw
/// manifest bytes. On its own the field is attacker-controlled; its value comes
/// entirely from being inside the signed bytes.
pub fn check_extension_code_hash(
    manifest: &serde_json::Value,
    bundle: &Path,
) -> CodeHashStatus {
    let declared = manifest
        .get(EXTENSION_CODE_HASH_FIELD)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if declared.is_empty() {
        return CodeHashStatus::NotDeclared;
    }
    match extension_code_hash(bundle) {
        Ok(actual) if actual == declared => CodeHashStatus::Match,
        Ok(_) => CodeHashStatus::Mismatch,
        Err(_) => CodeHashStatus::BundleUnreadable,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn hex_roundtrip() {
        let bytes = [0x00u8, 0x01, 0x7f, 0x80, 0xff, 0xab];
        let hex = to_hex(&bytes);
        assert_eq!(hex, "00017f80ffab");
        assert_eq!(from_hex(&hex).unwrap(), bytes);
        // Odd length / non-hex are rejected.
        assert!(from_hex("abc").is_none());
        assert!(from_hex("zz").is_none());
    }

    #[test]
    fn keypair_load_or_create_roundtrip_same_key() {
        let dir = TempDir::new().unwrap();
        let first = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let first_pub = first.public_key_hex();

        // File was created.
        assert!(publisher_key_file_path(dir.path()).exists());

        // Second call returns the SAME key (loaded, not regenerated).
        let second = PublisherKeypair::load_or_create(dir.path()).unwrap();
        assert_eq!(first_pub, second.public_key_hex());

        // Public key is 32 bytes -> 64 hex chars.
        assert_eq!(first_pub.len(), 64);
        assert!(first_pub.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn sign_then_verify_roundtrip_ok() {
        let dir = TempDir::new().unwrap();
        let kp = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let msg = b"the raw manifest bytes";
        let sig = kp.sign(msg);
        // 64-byte signature -> 128 hex chars.
        assert_eq!(sig.len(), 128);
        verify_signature(&kp.public_key_hex(), msg, &sig, "pkg", "1.0.0").unwrap();
    }

    #[test]
    fn tampered_message_fails_verification() {
        let dir = TempDir::new().unwrap();
        let kp = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let mut msg = b"the raw manifest bytes".to_vec();
        let sig = kp.sign(&msg);

        // Flip one byte of the signed message.
        msg[0] ^= 0x01;
        let err = verify_signature(&kp.public_key_hex(), &msg, &sig, "pkg", "1.0.0")
            .unwrap_err();
        assert!(matches!(err, CalpError::ManifestSignatureInvalid { .. }));
    }

    #[test]
    fn wrong_key_fails_verification() {
        let dir_a = TempDir::new().unwrap();
        let dir_b = TempDir::new().unwrap();
        let kp_a = PublisherKeypair::load_or_create(dir_a.path()).unwrap();
        let kp_b = PublisherKeypair::load_or_create(dir_b.path()).unwrap();
        assert_ne!(kp_a.public_key_hex(), kp_b.public_key_hex());

        let msg = b"signed by A";
        let sig = kp_a.sign(msg);
        // Verify A's signature against B's public key -> invalid.
        let err = verify_signature(&kp_b.public_key_hex(), msg, &sig, "pkg", "1.0.0")
            .unwrap_err();
        assert!(matches!(err, CalpError::ManifestSignatureInvalid { .. }));
    }

    #[test]
    fn malformed_signature_or_key_fails() {
        let dir = TempDir::new().unwrap();
        let kp = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let msg = b"hello";
        // Not hex at all.
        assert!(matches!(
            verify_signature(&kp.public_key_hex(), msg, "nothex", "p", "1.0.0"),
            Err(CalpError::ManifestSignatureInvalid { .. })
        ));
        // Right hex form but wrong length signature.
        assert!(matches!(
            verify_signature(&kp.public_key_hex(), msg, "abcd", "p", "1.0.0"),
            Err(CalpError::ManifestSignatureInvalid { .. })
        ));
        // Bad public key.
        let sig = kp.sign(msg);
        assert!(matches!(
            verify_signature("00", msg, &sig, "p", "1.0.0"),
            Err(CalpError::ManifestSignatureInvalid { .. })
        ));
    }

    #[test]
    fn load_existing_returns_none_when_no_keypair() {
        let dir = TempDir::new().unwrap();
        // A profile that never published has no publisher-key.json.
        assert!(PublisherKeypair::load_existing(dir.path()).unwrap().is_none());
        // ...and the probe does NOT create one (read-only).
        assert!(!publisher_key_file_path(dir.path()).exists());
    }

    #[test]
    fn profile_holds_publisher_key_authorizes_only_the_owner() {
        // The publisher's profile: publishing created publisher-key.json here.
        let pub_dir = TempDir::new().unwrap();
        let publisher = PublisherKeypair::load_or_create(pub_dir.path()).unwrap();
        let pub_key = publisher.public_key_hex();

        // A different participant's profile (their own, different keypair).
        let sub_dir = TempDir::new().unwrap();
        let _subscriber = PublisherKeypair::load_or_create(sub_dir.path()).unwrap();

        // A profile that has never published at all.
        let empty_dir = TempDir::new().unwrap();

        // Only the publisher's own profile proves ownership of pub_key.
        assert!(profile_holds_publisher_key(pub_dir.path(), &pub_key).unwrap());
        // A different keypair does NOT match.
        assert!(!profile_holds_publisher_key(sub_dir.path(), &pub_key).unwrap());
        // No keypair at all does NOT match (and creates nothing).
        assert!(!profile_holds_publisher_key(empty_dir.path(), &pub_key).unwrap());
        assert!(!publisher_key_file_path(empty_dir.path()).exists());

        // An unsigned package (empty publisher_key) can never be owned.
        assert!(!profile_holds_publisher_key(pub_dir.path(), "").unwrap());
    }

    #[test]
    fn profile_holds_publisher_key_rejects_forged_public_key_field() {
        // Craft a publisher-key.json whose stored publicKey CLAIMS the victim's
        // key but whose secretKey is a different (attacker) seed. The probe must
        // derive the public key from the SECRET and reject the forgery.
        let victim_dir = TempDir::new().unwrap();
        let victim = PublisherKeypair::load_or_create(victim_dir.path()).unwrap();
        let victim_key = victim.public_key_hex();

        let attacker_dir = TempDir::new().unwrap();
        let attacker = PublisherKeypair::load_or_create(attacker_dir.path()).unwrap();
        let attacker_secret = to_hex(&attacker.signing_key.to_bytes());

        // Overwrite the attacker's file: secret = attacker's, but publicKey lies.
        let forged = PublisherKeyFile {
            format_version: 1,
            secret_key: attacker_secret,
            public_key: victim_key.clone(), // the lie
            display_name: "attacker".to_string(),
        };
        std::fs::write(
            publisher_key_file_path(attacker_dir.path()),
            serde_json::to_string_pretty(&forged).unwrap(),
        )
        .unwrap();

        // The probe derives from the secret, so the forgery is rejected.
        assert!(!profile_holds_publisher_key(attacker_dir.path(), &victim_key).unwrap());
    }

    fn scope(location: &str) -> RegistryScope {
        crate::registry_id::registry_scope(location).unwrap()
    }

    #[test]
    fn tofu_store_starts_empty_then_pins() {
        let dir = TempDir::new().unwrap();
        assert!(load_pins(dir.path()).unwrap().is_empty());

        let reg = scope(r"C:\reg-one");
        pin_publisher(dir.path(), &PinKey::calp(&reg, "pkg-a"), &reg.label, "aabb").unwrap();
        pin_publisher(dir.path(), &PinKey::calp(&reg, "pkg-b"), &reg.label, "ccdd").unwrap();

        let store = load_pins(dir.path()).unwrap();
        assert_eq!(
            store.get(&PinKey::calp(&reg, "pkg-a")).unwrap().publisher_key,
            "aabb"
        );
        assert_eq!(
            store.get(&PinKey::calp(&reg, "pkg-b")).unwrap().publisher_key,
            "ccdd"
        );
        // The user's own spelling travels with the pin; the id does not.
        assert_eq!(
            store.get(&PinKey::calp(&reg, "pkg-a")).unwrap().scope_label,
            r"C:\reg-one"
        );
        assert!(!store.get(&PinKey::calp(&reg, "pkg-a")).unwrap().pinned_at.is_empty());
        assert!(trusted_publishers_file_path(dir.path()).exists());
    }

    #[test]
    fn tofu_pin_updates_existing_entry() {
        let dir = TempDir::new().unwrap();
        let reg = scope(r"C:\reg-one");
        pin_publisher(dir.path(), &PinKey::calp(&reg, "pkg"), &reg.label, "1111").unwrap();
        pin_publisher(dir.path(), &PinKey::calp(&reg, "pkg"), &reg.label, "2222").unwrap();
        let store = load_pins(dir.path()).unwrap();
        assert_eq!(store.len(), 1, "the same key must update, not accumulate");
        assert_eq!(
            store.get(&PinKey::calp(&reg, "pkg")).unwrap().publisher_key,
            "2222"
        );
    }

    /// The headline property of the key shape: two registries serving the same
    /// package name hold INDEPENDENT pins.
    #[test]
    fn two_registries_serving_one_name_do_not_overwrite_each_other() {
        let dir = TempDir::new().unwrap();
        let good = scope(r"C:\good-reg");
        let evil = scope(r"\\evil\share");

        pin_publisher(dir.path(), &PinKey::calp(&evil, "acme.finance"), &evil.label, "evil").unwrap();
        pin_publisher(dir.path(), &PinKey::calp(&good, "acme.finance"), &good.label, "good").unwrap();

        let store = load_pins(dir.path()).unwrap();
        assert_eq!(
            store.get(&PinKey::calp(&good, "acme.finance")).unwrap().publisher_key,
            "good"
        );
        assert_eq!(
            store.get(&PinKey::calp(&evil, "acme.finance")).unwrap().publisher_key,
            "evil"
        );

        // ...and each can SEE the other, which is what the name-conflict warning
        // is built from.
        let others =
            store.other_scopes_for_name(PinNamespace::Calp, "acme.finance", &good.id);
        assert_eq!(others.len(), 1);
        assert_eq!(others[0].publisher_key, "evil");
        assert_eq!(others[0].scope_label, r"\\evil\share");
    }

    #[test]
    fn namespaces_do_not_collide() {
        let dir = TempDir::new().unwrap();
        let reg = scope(r"C:\reg");
        pin_publisher(dir.path(), &PinKey::calp(&reg, "acme.demo"), &reg.label, "calpkey").unwrap();
        pin_publisher(dir.path(), &PinKey::extension("acme.demo"), "", "extkey").unwrap();

        let store = load_pins(dir.path()).unwrap();
        assert_eq!(
            store.get(&PinKey::calp(&reg, "acme.demo")).unwrap().publisher_key,
            "calpkey"
        );
        assert_eq!(
            store.get(&PinKey::extension("acme.demo")).unwrap().publisher_key,
            "extkey"
        );
        // An extension pin is invisible to a .calp cross-scope check.
        assert!(store
            .other_scopes_for_name(PinNamespace::Calp, "acme.demo", "")
            .iter()
            .all(|r| r.namespace == PinNamespace::Calp));
    }

    /// Two spellings of ONE registry share a pin — the property that stops a
    /// user who typed `c:/reg` in one dialog and `C:\reg\` in another from
    /// holding two independent trust decisions for the same folder.
    #[test]
    fn a_second_spelling_of_one_registry_is_the_same_pin() {
        let profile = TempDir::new().unwrap();
        let reg_dir = TempDir::new().unwrap();
        let typed_a = reg_dir.path().to_string_lossy().to_string();
        let typed_b = format!("{}\\", typed_a.replace('\\', "/").to_uppercase());

        let a = scope(&typed_a);
        let b = scope(&typed_b);
        pin_publisher(profile.path(), &PinKey::calp(&a, "pkg"), &a.label, "kkkk").unwrap();

        let store = load_pins(profile.path()).unwrap();
        assert_eq!(store.get(&PinKey::calp(&b, "pkg")).unwrap().publisher_key, "kkkk");
        assert!(
            store
                .other_scopes_for_name(PinNamespace::Calp, "pkg", &b.id)
                .is_empty(),
            "one registry spelled twice must not look like two registries"
        );
    }

    /// A store that EXISTS and cannot be read is an error, never "nothing is
    /// pinned" — the difference between fail-closed and fail-open.
    #[test]
    fn an_unreadable_store_is_an_error_not_an_empty_one() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(trusted_publishers_file_path(dir.path()), "{ not json").unwrap();
        assert!(load_pins(dir.path()).is_err());

        // A future format version is equally not "nothing is pinned".
        std::fs::write(
            trusted_publishers_file_path(dir.path()),
            r#"{"formatVersion": 99, "pins": []}"#,
        )
        .unwrap();
        assert!(load_pins(dir.path()).is_err());
    }

    /// THE EXISTING STORE. Extension pins carry over exactly; `.calp` pins
    /// cannot be honestly placed in a registry scope, so they are DISCARDED (to
    /// an auditable file) and the packages re-prompt.
    #[test]
    fn an_existing_v1_store_keeps_ext_pins_and_discards_the_rest() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        let v1 = serde_json::json!({
            "formatVersion": 1,
            "publishers": {
                "pkg-a": "aaaa",
                "acme.finance": "bbbb",
                "ext:acme.demo": "cccc",
            }
        });
        std::fs::write(
            trusted_publishers_file_path(dir.path()),
            serde_json::to_string_pretty(&v1).unwrap(),
        )
        .unwrap();

        let store = load_pins(dir.path()).unwrap();

        // The extension pin survives, with the same meaning and the same key.
        assert_eq!(
            store.get(&PinKey::extension("acme.demo")).unwrap().publisher_key,
            "cccc"
        );
        // The bare-name .calp pins resolve in NO scope — the user is re-prompted
        // rather than silently bound to a registry nobody recorded.
        for reg in [r"C:\reg", r"\\corp\reg", "https://reg.acme.com/pub"] {
            let s = scope(reg);
            assert!(store.get(&PinKey::calp(&s, "pkg-a")).is_none());
            assert!(store.get(&PinKey::calp(&s, "acme.finance")).is_none());
        }
        // ...and they are not silently visible to the cross-scope check either.
        assert!(store
            .other_scopes_for_name(PinNamespace::Calp, "acme.finance", "")
            .is_empty());

        // What was dropped is auditable.
        let discarded: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(discarded_pins_file_path(dir.path())).unwrap(),
        )
        .unwrap();
        let names = discarded.get("publishers").unwrap().as_object().unwrap();
        assert!(names.contains_key("pkg-a"));
        assert!(names.contains_key("acme.finance"));
        assert!(!names.contains_key("ext:acme.demo"));

        // The store has been rewritten as v2 and the v1 shape is never read
        // again — a second load is a plain v2 load and changes nothing.
        let raw = std::fs::read_to_string(trusted_publishers_file_path(dir.path())).unwrap();
        assert!(raw.contains("\"formatVersion\": 2"));
        assert!(!raw.contains("publishers"));
        let again = load_pins(dir.path()).unwrap();
        assert_eq!(again.len(), 1);
    }

    #[test]
    fn a_v1_store_with_only_ext_pins_writes_no_discard_file() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            trusted_publishers_file_path(dir.path()),
            r#"{"formatVersion":1,"publishers":{"ext:acme.demo":"cccc"}}"#,
        )
        .unwrap();
        let store = load_pins(dir.path()).unwrap();
        assert_eq!(store.len(), 1);
        assert!(!discarded_pins_file_path(dir.path()).exists());
    }

    // -- Extension add-in layout / code-hash coverage (G0) -------------------

    #[test]
    fn layout_file_bundle_from_manifest() {
        let l = extension_layout_for_manifest(Path::new("/ext/tax-tools.manifest.json")).unwrap();
        assert!(l.signature.ends_with("tax-tools.manifest.sig"));
        assert!(l.bundle.ends_with("tax-tools.js"));
    }

    #[test]
    fn layout_directory_bundle_from_manifest() {
        let l = extension_layout_for_manifest(Path::new("/ext/my-ext/extension.manifest.json"))
            .unwrap();
        assert!(l.signature.ends_with("extension.manifest.sig"));
        assert!(l.bundle.ends_with("index.js"));
    }

    #[test]
    fn layout_rejects_non_manifest_names() {
        assert!(extension_layout_for_manifest(Path::new("/ext/tax-tools.json")).is_none());
        assert!(extension_layout_for_manifest(Path::new("/ext/.manifest.json")).is_none());
    }

    #[test]
    fn layout_from_source_file_dir_and_index() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("tax-tools.js"), "//x").unwrap();

        // Pointing at the bundle file.
        let l = extension_layout_for_source(&dir.path().join("tax-tools.js")).unwrap();
        assert!(l.manifest.ends_with("tax-tools.manifest.json"));

        // Pointing at the folder that holds exactly one .js.
        let l2 = extension_layout_for_source(dir.path()).unwrap();
        assert_eq!(l, l2);

        // index.js in a folder is the DIRECTORY convention.
        let d2 = TempDir::new().unwrap();
        std::fs::write(d2.path().join("index.js"), "//x").unwrap();
        let l3 = extension_layout_for_source(d2.path()).unwrap();
        assert!(l3.manifest.ends_with("extension.manifest.json"));
        assert!(l3.bundle.ends_with("index.js"));
    }

    #[test]
    fn layout_from_source_rejects_ambiguity_and_reserved_names() {
        let dir = TempDir::new().unwrap();
        // Zero bundles.
        assert!(extension_layout_for_source(dir.path()).is_err());
        // Two bundles, no index.js -> ambiguous.
        std::fs::write(dir.path().join("a.js"), "//a").unwrap();
        std::fs::write(dir.path().join("b.js"), "//b").unwrap();
        assert!(extension_layout_for_source(dir.path()).is_err());
        // The reserved base name.
        assert!(extension_layout_for_source(Path::new("/ext/extension.js")).is_err());
        // Not a bundle at all.
        assert!(extension_layout_for_source(Path::new("/ext/readme.txt")).is_err());
    }

    #[test]
    fn code_hash_status_covers_the_bundle() {
        let dir = TempDir::new().unwrap();
        let bundle = dir.path().join("a.js");
        std::fs::write(&bundle, b"console.log(1)").unwrap();
        let hash = extension_code_hash(&bundle).unwrap();

        // Declared + matching.
        let m = serde_json::json!({ "codeHash": hash });
        assert_eq!(check_extension_code_hash(&m, &bundle), CodeHashStatus::Match);
        // Uppercase hex is accepted (normalized).
        let m_up = serde_json::json!({ "codeHash": hash.to_uppercase() });
        assert_eq!(check_extension_code_hash(&m_up, &bundle), CodeHashStatus::Match);

        // Tampering the bundle after signing is DETECTED.
        std::fs::write(&bundle, b"console.log(2)").unwrap();
        assert_eq!(check_extension_code_hash(&m, &bundle), CodeHashStatus::Mismatch);

        // Missing bundle.
        std::fs::remove_file(&bundle).unwrap();
        assert_eq!(
            check_extension_code_hash(&m, &bundle),
            CodeHashStatus::BundleUnreadable
        );

        // No declaration at all -> the signature covers the manifest only.
        assert_eq!(
            check_extension_code_hash(&serde_json::json!({}), &bundle),
            CodeHashStatus::NotDeclared
        );
    }

    /// An extension pin is MACHINE-GLOBAL by decision (see `PinKey::extension`):
    /// it carries no scope, so reinstalling the same id from a different folder
    /// is `verified` rather than a false first use.
    #[test]
    fn an_extension_pin_is_machine_global_and_carries_no_scope() {
        let key = PinKey::extension("calcula.example.tax-tools");
        assert_eq!(key.namespace(), PinNamespace::Ext);
        assert_eq!(key.scope(), "");
        assert_eq!(key.name(), "calcula.example.tax-tools");
        // ...and it is a different key from a .calp package of the same name.
        let reg = scope(r"C:\reg");
        assert_ne!(key, PinKey::calp(&reg, "calcula.example.tax-tools"));
    }

    /// A pin key can only be built by the two sanctioned constructors, which is
    /// what stops a call site from inventing a scope (or re-inventing the old
    /// `"ext:" + id` string convention) of its own.
    #[test]
    fn pin_keys_are_built_in_exactly_one_place() {
        let src = include_str!("signing.rs");
        let production = src.split("#[cfg(test)]").next().unwrap();
        assert_eq!(
            production.matches("PinKey {\n            namespace,").count(),
            1,
            "a PinKey must be BUILT in exactly one place (PinKey::new) — every other \
             site goes through PinKey::calp / PinKey::extension, so a call site cannot \
             invent a scope or a namespace of its own"
        );
        assert!(
            !production.contains("pub fn new(namespace"),
            "PinKey::new must stay private, or callers can bypass the two sanctioned \
             constructors and hand-roll a scope"
        );
        assert!(
            !production.contains("format!(\"ext:"),
            "the ext: string convention is gone; PinKey::extension is the namespace"
        );
        assert!(
            production.contains("    fn new(namespace: PinNamespace, scope_id: &str, name: &str) -> PinKey {"),
            "the single key construction must stay private and take all three parts"
        );
    }
}
