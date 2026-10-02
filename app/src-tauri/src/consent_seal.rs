//! FILENAME: app/src-tauri/src/consent_seal.rs
//! PURPOSE: Approvals of distributed code, SEALED TO THIS COMPUTER (BUG-0257
//! phase 4 prerequisite; the owner's answer "Should approvals stored in a
//! workbook stop working on another machine? -- Yes, before phase 4").
//!
//! CONTEXT: An approval ("consent") is a record in the workbook's user file
//! `.calcula/script-consent.json`: an application name, the exact code the
//! approval screen showed (id + SHA-256 of its bytes), the capabilities granted,
//! and when. Every Rust gate that lets application code run asks that file --
//! `run_script` and the mount door (scripting/commands.rs), the notebook gate
//! (scripting/notebook_commands.rs) and the writeback validator gate
//! (calp_commands.rs). The file travels INSIDE the `.cala`, together with the
//! code it approves, so before this module a workbook handed over by someone
//! else could carry its own pre-approval: any page write, any hand-built ZIP.
//!
//! THE SEAL. Each record now carries `keyId` and `seal` = HMAC-SHA256 over its
//! canonical bytes, under a 32-byte key that exists only on this computer (the
//! Windows Credential Manager, per Windows user; never in a workbook, never
//! readable by the page -- `read_text_file` can read any profile FILE, which is
//! why the key is not one). The verified reader keeps only records this
//! computer sealed and whose every field still matches; everything else is
//! reported as `ignored` with a reason and counts for nothing. A copy opened on
//! another computer therefore asks again, once, and that computer's own record
//! is written BESIDE the first one, so moving a workbook between two computers
//! of your own asks once on each.
//!
//! WHO WRITES. Only `record_script_consent` (the approval screen, main window),
//! which computes every hash from the source itself -- the page never supplies
//! a hash, a timestamp or a seal. `create_virtual_file` / `rename_virtual_file`
//! refuse the consent file's key (`is_consent_file_key`); deleting it stays
//! allowed, because removing approvals is always safe.
//!
//! WHAT IT DOES NOT DO. It protects against a HANDED-OVER FILE, not against a
//! compromised renderer: a hostile page can still call `record_script_consent`,
//! the same trust the page already has for ad-hoc code. And a record is bound to
//! the computer, not to the workbook: someone holding a workbook this computer
//! saved can copy its records into another `.cala`. That re-uses the user's own
//! earlier approval of those exact bytes under that application NAME; it cannot
//! forge a new one.
//!
//! WIRE TYPES live here, not in `api_types.rs`, following the module-local
//! precedent of `PullResponse` (calp_commands.rs) and `ControlMetadata`
//! (controls.rs). Their TypeScript mirrors live in `@api/distributedConsent.ts`,
//! and the field-drift tests in `consent_seal_tests.rs` are the guard.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{Emitter, State};
use zeroize::Zeroizing;

use crate::persistence::{FileState, UserFilesState};

/// The workbook-embedded distributed-script consent store. THE one spelling in
/// Rust: every reader goes through [`verified_view`], and the census in
/// `consent_seal_tests.rs` pins that no other production code indexes it.
pub(crate) const SCRIPT_CONSENT_FILE: &str = ".calcula/script-consent.json";

/// The file's own version. 1 = unsealed (every record ignored as `unsealed`).
/// This is a version INSIDE a user file, not the `.cala` format version: an
/// older build ignores a version-2 file in TypeScript and honours every record
/// in Rust, exactly as it treats any unsealed file an attacker hands it today,
/// so a format-version link would protect nothing.
pub(crate) const CONSENT_FILE_VERSION: u64 = 2;

/// The first field of the canonical bytes. Changing what is sealed changes this.
const SEAL_TAG: &str = "calcula-consent-seal/2";

/// Where the production key lives: a generic credential in the Windows
/// Credential Manager. Every other Calcula target maker puts a `|` after its
/// prefix (`Calcula:{server}|{db}`, `Calcula:aikey|{id}`, `Calcula:wbpw|{path}`)
/// and the page reaches those only through commands that build the target
/// themselves, so none of them can read, overwrite or delete this one. Pinned by
/// `the_consent_seal_target_cannot_be_produced_by_another_credential_maker`.
pub(crate) const CONSENT_SEAL_CREDENTIAL_TARGET: &str = "Calcula:consent-seal";

/// The test-build key file in the profile directory. Each `with_test_profile`
/// directory is therefore its own "computer".
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const CONSENT_SEAL_KEY_FILE: &str = "consent-seal.key";

/// The OS lock file beside the key, held while a key is minted so two Calcula
/// processes starting their first approval at once end with ONE key.
pub(crate) const CONSENT_SEAL_LOCK_FILE: &str = "consent-seal.lock";

const KEY_LEN: usize = 32;

type HmacSha256 = Hmac<Sha256>;

// ============================================================================
// Wire types
// ============================================================================

/// One piece of code the approval screen showed, as the page sends it: its id
/// and its exact source. Never a hash -- Rust computes that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsentScriptInput {
    pub id: String,
    pub source: String,
}

/// A granted capability. Capability ids are carried as strings and never
/// re-typed here: `ALL_CAPABILITY_IDS` (app/src/api/scriptHost/capabilityIds.ts)
/// stays the one list. Origins apply to `net.fetch` only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityGrantWire {
    pub capability: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origins: Option<Vec<String>>,
}

/// `record_script_consent`'s request. `deny_unknown_fields` is part of the
/// contract: a page that sends a `sourceHash`, a `grantedAt` or a `seal` is
/// refused outright rather than having the field silently ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordScriptConsentRequest {
    pub package_name: String,
    pub scripts: Vec<ConsentScriptInput>,
    #[serde(default)]
    pub granted_capabilities: Vec<CapabilityGrantWire>,
}

/// One approved piece of code in a stored record: its id, the hash Rust
/// computed, and the source retained so a later re-approval can show a diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsentedScriptWire {
    pub id: String,
    pub source_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// A record as it sits in the file: the approval plus the computer that sealed
/// it (`keyId`) and the seal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredConsentRecord {
    pub package_name: String,
    pub scripts: Vec<ConsentedScriptWire>,
    #[serde(default)]
    pub granted_capabilities: Vec<CapabilityGrantWire>,
    pub granted_at: String,
    pub key_id: String,
    pub seal: String,
}

/// A verified record, as every gate and the page see it. The same JSON shape
/// the pure deciders (`consent_granted_in`, `consent_record_exists_in`) have
/// always read, minus the seal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRecordView {
    pub package_name: String,
    pub scripts: Vec<ConsentedScriptWire>,
    pub granted_capabilities: Vec<CapabilityGrantWire>,
    pub granted_at: String,
}

/// Why a record in the file counts for nothing on this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IgnoredReason {
    /// No seal, or a version-1 file (written before approvals were sealed).
    Unsealed,
    /// Sealed with a different computer's key.
    OtherComputer,
    /// Sealed here, but a field no longer matches the seal, or a retained
    /// source no longer hashes to its recorded hash.
    Altered,
    /// This computer's key exists but cannot be read.
    KeyUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredConsent {
    pub package_name: String,
    pub reason: IgnoredReason,
}

/// `list_script_consents`' answer.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptConsentList {
    pub consents: Vec<ConsentRecordView>,
    pub ignored: Vec<IgnoredConsent>,
}

// ============================================================================
// This computer's key
// ============================================================================

/// The approval key. Zeroized when dropped.
#[derive(Clone)]
pub(crate) struct SealKey(Zeroizing<[u8; KEY_LEN]>);

impl SealKey {
    fn from_bytes(bytes: &[u8]) -> Option<SealKey> {
        let array: [u8; KEY_LEN] = bytes.try_into().ok()?;
        Some(SealKey(Zeroizing::new(array)))
    }

    /// The first 16 hex characters of SHA-256 of the key: names the computer in
    /// a record without revealing anything about the key.
    pub(crate) fn id(&self) -> String {
        calp::integrity::sha256_hex(&self.0[..])[..16].to_string()
    }

    fn same_bytes(&self, other: &[u8]) -> bool {
        self.0[..] == *other
    }
}

impl std::fmt::Debug for SealKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SealKey({})", self.id())
    }
}

/// What looking for the key found.
#[derive(Debug)]
pub(crate) enum KeyLookup {
    Present(SealKey),
    /// Never minted on this computer (for this Windows user).
    Absent,
    /// It exists but cannot be read, or has the wrong length. NEVER re-minted
    /// silently: that would void every approval on the computer without a word.
    Damaged(String),
}

/// Where a key is kept. Production: the Credential Manager. Test builds: a file
/// in the (throwaway) profile directory.
pub(crate) trait SealKeyStore: Sync {
    fn read(&self) -> KeyLookup;
    fn write(&self, key: &[u8; KEY_LEN]) -> Result<(), String>;
    /// The directory the cross-process mint lock lives in.
    fn lock_dir(&self) -> PathBuf;
    /// What the user deletes to repair a damaged key.
    fn repair_hint(&self) -> String;
}

/// The test-build store: `consent-seal.key` (32 raw bytes) in a directory.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct FileKeyStore {
    dir: PathBuf,
}

#[cfg_attr(not(test), allow(dead_code))]
impl FileKeyStore {
    pub(crate) fn new(dir: &Path) -> FileKeyStore {
        FileKeyStore { dir: dir.to_path_buf() }
    }

    fn path(&self) -> PathBuf {
        self.dir.join(CONSENT_SEAL_KEY_FILE)
    }
}

impl SealKeyStore for FileKeyStore {
    fn read(&self) -> KeyLookup {
        match std::fs::read(self.path()) {
            Ok(bytes) => match SealKey::from_bytes(&bytes) {
                Some(key) => KeyLookup::Present(key),
                None => KeyLookup::Damaged(format!(
                    "it holds {} bytes, not {}",
                    bytes.len(),
                    KEY_LEN
                )),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => KeyLookup::Absent,
            Err(e) => KeyLookup::Damaged(e.to_string()),
        }
    }

    fn write(&self, key: &[u8; KEY_LEN]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        // Written beside and RENAMED into place, so a reader that does not hold
        // the mint lock sees either no key or the whole key, never half of one
        // (half of one reads as damaged, which fails closed and asks for repair).
        let temp = self.dir.join(format!(
            "{}.{}-{:?}.tmp",
            CONSENT_SEAL_KEY_FILE,
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::write(&temp, &key[..]).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, self.path()).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            e.to_string()
        })
    }

    fn lock_dir(&self) -> PathBuf {
        self.dir.clone()
    }

    fn repair_hint(&self) -> String {
        format!("the file {}", self.path().display())
    }
}

/// The production store: a generic credential in the Windows Credential
/// Manager, DPAPI-protected and tied to this Windows user on this computer,
/// following `file_keychain.rs`.
pub(crate) struct CredentialKeyStore {
    target: String,
    lock_dir: PathBuf,
}

impl CredentialKeyStore {
    pub(crate) fn new(target: &str, lock_dir: &Path) -> CredentialKeyStore {
        CredentialKeyStore { target: target.to_string(), lock_dir: lock_dir.to_path_buf() }
    }

    /// The Credential Manager target the key is kept under.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn target(&self) -> &str {
        &self.target
    }

    /// Remove the credential. Test-only: production never deletes the key --
    /// the repair is the user's own act in Credential Manager.
    #[cfg(test)]
    pub(crate) fn delete(&self) {
        use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
        let target = to_wide(&self.target);
        unsafe {
            let _ = CredDeleteW(windows::core::PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None);
        }
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

impl SealKeyStore for CredentialKeyStore {
    fn read(&self) -> KeyLookup {
        use windows::Win32::Foundation::ERROR_NOT_FOUND;
        use windows::Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC};
        let target = to_wide(&self.target);
        unsafe {
            let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();
            match CredReadW(windows::core::PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut cred_ptr) {
                Ok(()) => {
                    let cred = &*cred_ptr;
                    let size = cred.CredentialBlobSize as usize;
                    let found = if cred.CredentialBlob.is_null() {
                        KeyLookup::Damaged("the credential holds no key".to_string())
                    } else {
                        let blob = std::slice::from_raw_parts(cred.CredentialBlob, size);
                        match SealKey::from_bytes(blob) {
                            Some(key) => KeyLookup::Present(key),
                            None => KeyLookup::Damaged(format!(
                                "the credential holds {} bytes, not {}",
                                size, KEY_LEN
                            )),
                        }
                    };
                    CredFree(cred_ptr as *const std::ffi::c_void);
                    found
                }
                Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => KeyLookup::Absent,
                Err(e) => KeyLookup::Damaged(format!("the Credential Manager refused the read: {}", e)),
            }
        }
    }

    fn write(&self, key: &[u8; KEY_LEN]) -> Result<(), String> {
        use windows::core::PWSTR;
        use windows::Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        };
        let mut target = to_wide(&self.target);
        let mut user = to_wide("calcula-consent-seal");
        let mut comment = to_wide(
            "Calcula approvals key for this computer. Deleting it makes every workbook ask for approval again.",
        );
        let cred = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            Comment: PWSTR(comment.as_mut_ptr()),
            LastWritten: Default::default(),
            CredentialBlobSize: KEY_LEN as u32,
            CredentialBlob: key.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: PWSTR::null(),
            UserName: PWSTR(user.as_mut_ptr()),
        };
        unsafe { CredWriteW(&cred, 0) }
            .map_err(|e| format!("the Credential Manager refused to store the key: {}", e))
    }

    fn lock_dir(&self) -> PathBuf {
        self.lock_dir.clone()
    }

    fn repair_hint(&self) -> String {
        format!(
            "the entry '{}' under Control Panel > Credential Manager > Windows Credentials",
            self.target
        )
    }
}

/// THE APP'S STORE: the generic credential `Calcula:consent-seal` in the
/// Windows Credential Manager, with the mint lock in the profile directory.
/// Compiled in BOTH builds so the unit tier can pin it -- the whole seal rests
/// on it: a key kept in a FILE would be one the page can read and overwrite
/// (`read_text_file` / `write_text_file` reach any profile file), so it could
/// forge seals. Its return type is the Credential Manager's store, and
/// `machine_store`'s app branch returns exactly this (pinned by
/// `the_app_keeps_the_approvals_key_in_the_credential_manager_never_in_a_file`).
pub(crate) fn app_key_store() -> CredentialKeyStore {
    CredentialKeyStore::new(CONSENT_SEAL_CREDENTIAL_TARGET, &crate::profile_dir::resolve())
}

/// This computer's store: the Credential Manager in the app
/// ([`app_key_store`]), the throwaway profile directory's key file in a test
/// build.
fn machine_store() -> Box<dyn SealKeyStore> {
    #[cfg(test)]
    {
        Box::new(FileKeyStore::new(&crate::profile_dir::resolve()))
    }
    #[cfg(not(test))]
    {
        Box::new(app_key_store())
    }
}

/// The key, once read successfully (production only: a test build switches
/// "computers" per thread with `with_test_profile`, so it must always look).
#[cfg(not(test))]
static KEY_CACHE: std::sync::OnceLock<SealKey> = std::sync::OnceLock::new();

/// This computer's key for VERIFYING. Never mints: a computer that has never
/// approved anything has sealed nothing.
pub(crate) fn machine_key_for_reading() -> KeyLookup {
    #[cfg(not(test))]
    if let Some(key) = KEY_CACHE.get() {
        return KeyLookup::Present(key.clone());
    }
    let found = machine_store().read();
    #[cfg(not(test))]
    if let KeyLookup::Present(key) = &found {
        let _ = KEY_CACHE.set(key.clone());
    }
    found
}

/// This computer's key for SEALING: read it, or mint it on the first approval.
pub(crate) fn machine_key_for_writing() -> Result<SealKey, String> {
    #[cfg(not(test))]
    if let Some(key) = KEY_CACHE.get() {
        return Ok(key.clone());
    }
    let store = machine_store();
    let key = get_or_mint_key(&*store)?;
    #[cfg(not(test))]
    {
        let _ = KEY_CACHE.set(key.clone());
    }
    Ok(key)
}

/// Serialises minting between the threads of ONE process; the OS lock on
/// `consent-seal.lock` serialises processes.
static MINT_LOCK: Mutex<()> = Mutex::new(());

struct MintGuard {
    // Dropped (released) FIRST, then the process mutex.
    _file: std::fs::File,
    _process: MutexGuard<'static, ()>,
}

fn lock_for_minting(dir: &Path) -> Result<MintGuard, String> {
    // The guarded data is `()`: a poisoned lock protects nothing half-written.
    let process = MINT_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("the approvals lock folder cannot be created: {}", e))?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(CONSENT_SEAL_LOCK_FILE))
        .map_err(|e| format!("the approvals lock file cannot be opened: {}", e))?;
    // Blocks until no other process holds it. Released when `file` closes.
    file.lock()
        .map_err(|e| format!("the approvals lock file cannot be locked: {}", e))?;
    Ok(MintGuard { _file: file, _process: process })
}

fn damaged_key_message(why: &str, store: &dyn SealKeyStore) -> String {
    format!(
        "this computer's approvals key cannot be read ({}), so nothing can be approved and no \
         earlier approval counts. To repair it, delete {}; every application will then ask for \
         approval again",
        why,
        store.repair_hint()
    )
}

/// Read the key, or mint it if this computer has none. Minting happens under
/// the process mutex AND the OS lock, and re-reads after taking them, so two
/// threads or two processes end with ONE key. A key that exists but cannot be
/// read is an error, never a reason to mint.
pub(crate) fn get_or_mint_key(store: &dyn SealKeyStore) -> Result<SealKey, String> {
    match store.read() {
        KeyLookup::Present(key) => return Ok(key),
        KeyLookup::Damaged(why) => return Err(damaged_key_message(&why, store)),
        KeyLookup::Absent => {}
    }
    let _guard = lock_for_minting(&store.lock_dir())?;
    match store.read() {
        KeyLookup::Present(key) => return Ok(key),
        KeyLookup::Damaged(why) => return Err(damaged_key_message(&why, store)),
        KeyLookup::Absent => {}
    }
    let mut minted = Zeroizing::new([0u8; KEY_LEN]);
    OsRng
        .try_fill_bytes(&mut minted[..])
        .map_err(|e| format!("no randomness for this computer's approvals key: {}", e))?;
    store.write(&minted)?;
    // Read back what is actually stored: the key every later read will see.
    match store.read() {
        KeyLookup::Present(key) if key.same_bytes(&minted[..]) => Ok(key),
        KeyLookup::Present(_) => Err(
            "this computer's approvals key changed while it was being created; try again".to_string(),
        ),
        KeyLookup::Absent => Err(
            "this computer's approvals key was stored but cannot be read back".to_string(),
        ),
        KeyLookup::Damaged(why) => Err(damaged_key_message(&why, store)),
    }
}

// ============================================================================
// The seal
// ============================================================================

/// HMAC-SHA256 as lowercase hex. The primitive, pinned by RFC 4231.
pub(crate) fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(data);
    to_hex(&mac.finalize().into_bytes())
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

fn put(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(bytes);
}

fn put_count(out: &mut Vec<u8>, n: usize) {
    out.extend_from_slice(&(n as u64).to_le_bytes());
}

/// The bytes a seal covers. HAND-BUILT and length-prefixed, never
/// `serde_json`: its map order depends on features other crates enable, and a
/// separator-joined string lets `a` + `1:b` collide with `a:1` + `b`.
///
/// In order: the tag; `packageName` verbatim (never trimmed -- both Rust gates
/// compare it raw); `grantedAt`; the scripts sorted by id as (id, sourceHash);
/// the capability grants sorted by capability, each with its origins sorted.
/// Sorting makes the seal blind to the order the page listed things in.
pub(crate) fn canonical_bytes(
    package_name: &str,
    granted_at: &str,
    scripts: &[ConsentedScriptWire],
    grants: &[CapabilityGrantWire],
) -> Vec<u8> {
    let mut out = Vec::new();
    put(&mut out, SEAL_TAG.as_bytes());
    put(&mut out, package_name.as_bytes());
    put(&mut out, granted_at.as_bytes());

    let mut pairs: Vec<(&str, &str)> =
        scripts.iter().map(|s| (s.id.as_str(), s.source_hash.as_str())).collect();
    pairs.sort_unstable();
    put_count(&mut out, pairs.len());
    for (id, hash) in pairs {
        put(&mut out, id.as_bytes());
        put(&mut out, hash.as_bytes());
    }

    let mut caps: Vec<(&str, Vec<&str>)> = grants
        .iter()
        .map(|g| {
            let mut origins: Vec<&str> = g.origins.iter().flatten().map(String::as_str).collect();
            origins.sort_unstable();
            (g.capability.as_str(), origins)
        })
        .collect();
    caps.sort_unstable();
    put_count(&mut out, caps.len());
    for (capability, origins) in caps {
        put(&mut out, capability.as_bytes());
        put_count(&mut out, origins.len());
        for origin in origins {
            put(&mut out, origin.as_bytes());
        }
    }
    out
}

fn seal_of(key: &SealKey, record: &StoredConsentRecord) -> String {
    hmac_sha256_hex(
        &key.0[..],
        &canonical_bytes(
            &record.package_name,
            &record.granted_at,
            &record.scripts,
            &record.granted_capabilities,
        ),
    )
}

/// Constant-time check of a record's seal (`verify_slice`).
fn seal_matches(key: &SealKey, record: &StoredConsentRecord) -> bool {
    let Some(tag) = from_hex(&record.seal) else { return false };
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&key.0[..]).expect("HMAC accepts a key of any length");
    mac.update(&canonical_bytes(
        &record.package_name,
        &record.granted_at,
        &record.scripts,
        &record.granted_capabilities,
    ));
    mac.verify_slice(&tag).is_ok()
}

/// Build and seal the record for an approval. Every `sourceHash` is computed
/// here from the source; the source is retained so a later re-approval can
/// show a diff.
pub(crate) fn seal_record(
    key: &SealKey,
    request: &RecordScriptConsentRequest,
    granted_at: &str,
) -> StoredConsentRecord {
    let scripts = request
        .scripts
        .iter()
        .map(|s| ConsentedScriptWire {
            id: s.id.clone(),
            source_hash: calp::integrity::sha256_hex(s.source.as_bytes()),
            source: Some(s.source.clone()),
        })
        .collect();
    let mut record = StoredConsentRecord {
        package_name: request.package_name.clone(),
        scripts,
        granted_capabilities: request.granted_capabilities.clone(),
        granted_at: granted_at.to_string(),
        key_id: key.id(),
        seal: String::new(),
    };
    record.seal = seal_of(key, &record);
    record
}

/// Refuse an approval that could not mean what the screen showed.
pub(crate) fn validate_request(request: &RecordScriptConsentRequest) -> Result<(), String> {
    if request.package_name.trim().is_empty() {
        return Err("the approval does not name the application it approves".to_string());
    }
    if request.scripts.is_empty() {
        return Err(
            "the approval lists no code, and an approval covers exactly the code the approval \
             screen showed"
                .to_string(),
        );
    }
    let mut seen = std::collections::HashSet::new();
    for script in &request.scripts {
        if script.id.is_empty() {
            return Err("the approval lists a piece of code with no id".to_string());
        }
        if !seen.insert(script.id.as_str()) {
            return Err(format!(
                "the approval lists the code '{}' twice, so it cannot say which copy was shown",
                script.id
            ));
        }
        // The approval id of BUTTON code names its bytes (`buttonAction:` +
        // sha256 of them). An id that names other bytes than the source beside
        // it would be sealed and listed as an approval of code A showing code
        // B -- inert at every gate (each compares the id AND the hash), but
        // exactly what the approval screen's diff would read back and show.
        if script.id.starts_with(crate::scripting::control_action::BUTTON_ACTION_CONSENT_PREFIX)
            && script.id != crate::scripting::control_action::button_action_consent_id(&script.source)
        {
            return Err(format!(
                "the approval lists the button code '{}' with code that is not the code that id names, so it \
                 cannot say which code was shown",
                script.id
            ));
        }
    }
    Ok(())
}

// ============================================================================
// Verifying
// ============================================================================

/// Keep the records this computer sealed and that still match; report the
/// rest. Pure over the parsed file and the key lookup.
pub(crate) fn verify(file: &serde_json::Value, key: &KeyLookup) -> ScriptConsentList {
    let mut out = ScriptConsentList::default();
    let Some(records) = file.get("consents").and_then(|c| c.as_array()) else {
        return out;
    };
    let sealed_file = file.get("version").and_then(|v| v.as_u64()) == Some(CONSENT_FILE_VERSION);
    for value in records {
        let package_name = value
            .get("packageName")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let ignore = |reason| IgnoredConsent { package_name: package_name.clone(), reason };
        if !sealed_file || !value.get("seal").is_some_and(|s| s.is_string()) {
            out.ignored.push(ignore(IgnoredReason::Unsealed));
            continue;
        }
        let Ok(record) = serde_json::from_value::<StoredConsentRecord>(value.clone()) else {
            out.ignored.push(ignore(IgnoredReason::Altered));
            continue;
        };
        let key = match key {
            KeyLookup::Present(key) => key,
            KeyLookup::Absent => {
                out.ignored.push(ignore(IgnoredReason::OtherComputer));
                continue;
            }
            KeyLookup::Damaged(_) => {
                out.ignored.push(ignore(IgnoredReason::KeyUnavailable));
                continue;
            }
        };
        if record.key_id != key.id() {
            out.ignored.push(ignore(IgnoredReason::OtherComputer));
            continue;
        }
        let retained_sources_match = record.scripts.iter().all(|s| {
            s.source
                .as_ref()
                .is_none_or(|src| calp::integrity::sha256_hex(src.as_bytes()) == s.source_hash)
        });
        if !seal_matches(key, &record) || !retained_sources_match {
            out.ignored.push(ignore(IgnoredReason::Altered));
            continue;
        }
        out.consents.push(ConsentRecordView {
            package_name: record.package_name,
            scripts: record.scripts,
            granted_capabilities: record.granted_capabilities,
            granted_at: record.granted_at,
        });
    }
    out
}

/// The consent file as every Rust gate reads it: ONLY this computer's intact
/// records, in the shape the pure deciders have always read. `None` when the
/// bytes are not JSON. The key is read here, never under the user-files guard.
pub(crate) fn verified_view(bytes: &[u8]) -> Option<serde_json::Value> {
    let parsed = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    let list = verified_list(&parsed);
    Some(serde_json::json!({
        "version": CONSENT_FILE_VERSION,
        "consents": list.consents,
    }))
}

/// [`verify`] under this computer's key. A file with no records never touches
/// the key store.
fn verified_list(parsed: &serde_json::Value) -> ScriptConsentList {
    let has_records = parsed
        .get("consents")
        .and_then(|c| c.as_array())
        .is_some_and(|a| !a.is_empty());
    if !has_records {
        return ScriptConsentList::default();
    }
    verify(parsed, &machine_key_for_reading())
}

/// Copy the consent file's bytes out of the user files, dropping the guard
/// before anything else happens.
fn consent_file_bytes(user_files: &UserFilesState) -> Option<Vec<u8>> {
    let files = user_files.files.lock().ok()?;
    files.get(SCRIPT_CONSENT_FILE).cloned()
}

// ============================================================================
// The consent file is not a file the page writes
// ============================================================================

/// Whether a user-files key would name the consent file. Compared after the
/// spelling variations a path can take -- surrounding whitespace, backslashes,
/// a leading `./` or `/`, doubled separators, letter case -- so a variant that
/// some later load or save path normalises cannot be used to plant one.
pub(crate) fn is_consent_file_key(path: &str) -> bool {
    let unified = path.trim().replace('\\', "/");
    let mut parts: Vec<&str> = unified.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    parts.iter_mut().for_each(|p| *p = p.trim());
    parts.join("/").eq_ignore_ascii_case(SCRIPT_CONSENT_FILE)
}

/// What `create_virtual_file` / `rename_virtual_file` answer for the consent file.
pub(crate) fn consent_file_write_refused() -> String {
    format!(
        "'{}' holds this workbook's approvals of application code. Approvals are recorded by the \
         approval screen, not written as a file.",
        SCRIPT_CONSENT_FILE
    )
}

// ============================================================================
// Commands
// ============================================================================

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Record an approval, sealed to this computer. The body of
/// `record_script_consent` without the window guard and the event.
///
/// Order, and why:
/// 1. validate -- refusals first;
/// 2. read or mint the key BEFORE the user-files guard: Credential Manager I/O
///    and the OS lock never run while that mutex is held;
/// 3. under ONE user-files guard: read the file, replace this computer's record
///    for this application (another computer's SEALED record for it stays,
///    counting for nothing here; a record for it that no computer sealed -- a
///    version-1 approval, or one stripped of its key id or seal -- counts for
///    nothing on ANY computer and is dropped, so the screen never reports the
///    application as both approved and unsealed), build the new bytes, and only
///    then mark the document dirty and write. Records of OTHER applications are
///    never touched. Never read, drop the guard, then write: a second approval
///    landing in between would be lost.
pub(crate) fn record_script_consent_core(
    user_files: &UserFilesState,
    file_state: &FileState,
    request: RecordScriptConsentRequest,
) -> Result<(), String> {
    validate_request(&request)?;
    let key = machine_key_for_writing()?;
    let key_id = key.id();
    let record = seal_record(&key, &request, &now_iso());
    let record_value = serde_json::to_value(&record).map_err(|e| e.to_string())?;

    let mut files = user_files.files.lock().map_err(|e| e.to_string())?;
    let mut consents: Vec<serde_json::Value> = files
        .get(SCRIPT_CONSENT_FILE)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
        .and_then(|file| file.get("consents").and_then(|c| c.as_array()).cloned())
        .unwrap_or_default();
    consents.retain(|existing| {
        if existing.get("packageName").and_then(|v| v.as_str()) != Some(record.package_name.as_str()) {
            return true;
        }
        let sealed_by = existing
            .get("keyId")
            .and_then(|v| v.as_str())
            .filter(|_| existing.get("seal").is_some_and(|s| s.is_string()));
        // Kept only when ANOTHER computer sealed it: this computer's earlier
        // record is replaced, and an unsealed one counts nowhere.
        sealed_by.is_some_and(|by| by != key_id.as_str())
    });
    consents.push(record_value);
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "version": CONSENT_FILE_VERSION,
        "consents": consents,
    }))
    .map_err(|e| e.to_string())?;

    let _effect = crate::document_effect::DocumentEffect::mutates(file_state);
    files.insert(SCRIPT_CONSENT_FILE.to_string(), bytes);
    Ok(())
}

/// The verified records and what was ignored. Reads only; constructs no effect.
pub(crate) fn list_script_consents_core(user_files: &UserFilesState) -> ScriptConsentList {
    let Some(bytes) = consent_file_bytes(user_files) else {
        return ScriptConsentList::default();
    };
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(parsed) => verified_list(&parsed),
        Err(_) => ScriptConsentList::default(),
    }
}

/// Record the user's approval of an application's code, sealed to this
/// computer. The approval screen's door; main window only. Denylisted for
/// non-trusted callers under `codeExecution` (backendCommands.ts), because it
/// grants.
#[tauri::command]
pub fn record_script_consent(
    app_handle: tauri::AppHandle,
    user_files_state: State<UserFilesState>,
    file_state: State<FileState>,
    request: RecordScriptConsentRequest,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    record_script_consent_core(&user_files_state, &file_state, request)?;
    // The virtual-files view and FILEREAD see the file change.
    let _ = app_handle.emit("virtual-file-changed", SCRIPT_CONSENT_FILE);
    Ok(())
}

/// The approvals that count on this computer, with the retained source of each
/// approved piece of code, plus every record that was ignored and why.
#[tauri::command]
pub fn list_script_consents(
    user_files_state: State<UserFilesState>,
    window: tauri::Window,
) -> Result<ScriptConsentList, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    Ok(list_script_consents_core(&user_files_state))
}

#[cfg(test)]
#[path = "consent_seal_tests.rs"]
mod tests;
