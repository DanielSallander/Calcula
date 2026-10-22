//! FILENAME: app/src-tauri/src/submitter_identity.rs
//! PURPOSE: WHO this computer sends writeback answers as, and the key it signs
//! them with (identity phase 1, owner decision 2026-10-22).
//! CONTEXT: Replaces `calp::identity_provider::load_or_create`, whose random id
//! in `%LOCALAPPDATA%\Calcula\subscriber-identity.json` anybody could copy.
//! That file is no longer read (it is safe to delete; nothing deletes it).
//!
//! * THE PROVIDER: the Windows account the app runs as -- its SID, its
//!   `MACHINE\user` / `DOMAIN\user` name and display name, read from the
//!   operating system ([`WindowsAccountProvider`]). Entra ID is the documented
//!   phase-2 seam (`calp::identity_provider::EntraProvider`) and is NOT
//!   selectable: [`active_provider`] always answers Windows.
//! * THE KEY: a 32-byte Ed25519 seed kept in the Windows Credential Manager
//!   under [`SUBMITTER_KEY_CREDENTIAL_TARGET`] (DPAPI, per Windows user, per
//!   computer), through the same store and mint as the approvals key
//!   (`consent_seal`). It never crosses IPC: no command returns it, and only
//!   [`seal_outgoing`] uses it, at the one point an answer leaves the machine.
//! * THE ID: `win-<SID>-<commitment to the public key>`
//!   (`calp::identity_provider::submitter_id_for`), so every reader can check
//!   that an answer under an id was signed by that id's key.

use calp::identity_provider::{AccountFacts, AccountScope, IdentityProvider, IdentityProviderKind};
use calp::SubmitterIdentity;

use crate::consent_seal::{
    get_or_mint_key_for, CredentialKeyStore, KeyLookup, KeyPurpose, SealKey, SealKeyStore,
};

/// The Credential Manager target the writeback signing key is kept under.
pub(crate) const SUBMITTER_KEY_CREDENTIAL_TARGET: &str = "Calcula:submitter-key|v1";
/// The test-build key file in the (throwaway) profile directory.
pub(crate) const SUBMITTER_KEY_FILE: &str = "submitter-signing.key";
/// The OS lock file held while the key is minted.
pub(crate) const SUBMITTER_KEY_LOCK_FILE: &str = "submitter-key.lock";

const SUBMITTER_CREDENTIAL_USER: &str = "calcula-submitter-key";
const SUBMITTER_CREDENTIAL_COMMENT: &str = "Calcula writeback signing key for this Windows account on this \
     computer. Every answer you send is signed with it. Deleting it makes your next answer arrive as a \
     new respondent.";

/// The writeback signing key's purpose, in the words its messages use.
pub(crate) const SUBMITTER_KEY: KeyPurpose = KeyPurpose {
    noun: "writeback signing key",
    lock_file: SUBMITTER_KEY_LOCK_FILE,
    while_damaged: "so no writeback answer can be sent from this computer",
    after_repair: "your next answer is then sent under a new sender id, and the publisher sees you as a \
                   new respondent",
};

// ============================================================================
// The provider
// ============================================================================

/// The Windows account the app runs as (phase 1, and the only selectable
/// provider).
pub(crate) struct WindowsAccountProvider;

impl IdentityProvider for WindowsAccountProvider {
    fn kind(&self) -> IdentityProviderKind {
        IdentityProviderKind::Windows
    }
    fn selectable(&self) -> bool {
        true
    }
    fn current_account(&self) -> Result<AccountFacts, String> {
        windows_account_facts()
    }
}

/// THE PROVIDER IN USE. One place, so phase 2 (Entra ID, chosen by an
/// application's signed policy) changes this function and nothing else; until
/// then it is the Windows account, always -- the Entra stub is not selectable.
pub(crate) fn active_provider() -> Box<dyn IdentityProvider> {
    Box::new(WindowsAccountProvider)
}

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// `GetUserNameExW` for one name format; `None` when the format does not apply
/// (a display name on a local account, for instance).
fn user_name_ex(format: windows::Win32::Security::Authentication::Identity::EXTENDED_NAME_FORMAT) -> Option<String> {
    use windows::Win32::Security::Authentication::Identity::GetUserNameExW;
    let mut size: u32 = 0;
    unsafe {
        let _ = GetUserNameExW(format, None, &mut size);
    }
    if size == 0 || size > 4096 {
        return None;
    }
    let mut buf = vec![0u16; size as usize + 1];
    let ok = unsafe { GetUserNameExW(format, Some(windows::core::PWSTR(buf.as_mut_ptr())), &mut size) };
    if !ok {
        return None;
    }
    let name = wide_to_string(&buf);
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// The string SID of the user the process runs as (`S-1-5-21-...`).
fn current_user_sid() -> Result<String, String> {
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| format!("Windows did not say which account Calcula runs as: {e}"))?;
        struct Close(HANDLE);
        impl Drop for Close {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
        let _close = Close(token);

        let mut len: u32 = 0;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        if len == 0 {
            return Err("Windows did not say which account Calcula runs as.".to_string());
        }
        // u64 words: TOKEN_USER holds a pointer, so the buffer must be aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr() as *mut core::ffi::c_void), len, &mut len)
            .map_err(|e| format!("Windows did not say which account Calcula runs as: {e}"))?;
        let user = &*(buf.as_ptr() as *const TOKEN_USER);

        let mut text = windows::core::PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text)
            .map_err(|e| format!("Windows could not spell this account's id: {e}"))?;
        let sid = text.to_string().map_err(|e| e.to_string());
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut core::ffi::c_void)));
        sid
    }
}

/// Where an account lives, from its SID and its `DOMAIN\user` name.
/// `S-1-12-1-...` is an Entra-joined account; a SAM domain equal to this
/// computer's name is a LOCAL account (its SID exists on this computer only);
/// anything else is a domain account.
pub(crate) fn scope_of(sid: &str, sam_name: &str, computer_name: &str) -> AccountScope {
    if sid.starts_with("S-1-12-1-") {
        return AccountScope::EntraJoined;
    }
    let domain = sam_name.split('\\').next().unwrap_or("");
    if !computer_name.is_empty() && domain.eq_ignore_ascii_case(computer_name) {
        AccountScope::LocalMachine
    } else if domain.is_empty() {
        AccountScope::Unknown
    } else {
        AccountScope::Domain
    }
}

/// What Windows says about the account the app runs as.
pub(crate) fn windows_account_facts() -> Result<AccountFacts, String> {
    use windows::Win32::Security::Authentication::Identity::{NameDisplay, NameSamCompatible};
    let sid = current_user_sid()?;
    let computer = std::env::var("COMPUTERNAME").unwrap_or_default();
    let sam = user_name_ex(NameSamCompatible).unwrap_or_else(|| {
        let user = std::env::var("USERNAME").unwrap_or_default();
        let domain = std::env::var("USERDOMAIN").unwrap_or_default();
        if domain.is_empty() { user } else { format!("{domain}\\{user}") }
    });
    let display = user_name_ex(NameDisplay)
        .unwrap_or_else(|| sam.rsplit('\\').next().unwrap_or(&sam).to_string());
    Ok(AccountFacts {
        scope: scope_of(&sid, &sam, &computer),
        subject: sid,
        principal_name: sam,
        display_name: display,
    })
}

// ============================================================================
// The key
// ============================================================================

/// THE APP'S STORE for the signing key: the Credential Manager, never a file a
/// page could read (`read_text_file` reaches any profile file). Pinned by
/// `the_app_keeps_the_signing_key_in_the_credential_manager_never_in_a_file`.
pub(crate) fn app_submitter_key_store() -> CredentialKeyStore {
    CredentialKeyStore::with_labels(
        SUBMITTER_KEY_CREDENTIAL_TARGET,
        SUBMITTER_CREDENTIAL_USER,
        SUBMITTER_CREDENTIAL_COMMENT,
        &crate::profile_dir::resolve(),
    )
}

/// This computer's store: the Credential Manager in the app, the throwaway
/// profile's key file in a test build (one "computer" per test profile).
fn submitter_store() -> Box<dyn SealKeyStore> {
    #[cfg(test)]
    {
        Box::new(crate::consent_seal::FileKeyStore::with_file(&crate::profile_dir::resolve(), SUBMITTER_KEY_FILE))
    }
    #[cfg(not(test))]
    {
        Box::new(app_submitter_key_store())
    }
}

#[cfg(not(test))]
static SEED_CACHE: std::sync::OnceLock<SealKey> = std::sync::OnceLock::new();

/// The signing seed, minted on first use. Never leaves this module except into
/// `calp::submission_seal`.
fn signing_seed() -> Result<SealKey, String> {
    #[cfg(not(test))]
    if let Some(key) = SEED_CACHE.get() {
        return Ok(key.clone());
    }
    let key = get_or_mint_key_for(&*submitter_store(), &SUBMITTER_KEY)?;
    #[cfg(not(test))]
    {
        let _ = SEED_CACHE.set(key.clone());
    }
    Ok(key)
}

/// Whether this computer already holds a signing key (never mints).
#[allow(dead_code)]
pub(crate) fn has_signing_key() -> bool {
    matches!(submitter_store().read(), KeyLookup::Present(_))
}

/// The identity this computer sends as: the active provider's account, bound to
/// this computer's signing key (minted on first use).
pub(crate) fn current_identity() -> Result<SubmitterIdentity, String> {
    let provider = active_provider();
    let facts = provider.current_account()?;
    let seed = signing_seed()?;
    let public_key = calp::submission_seal::public_key_of_seed(seed.bytes());
    calp::identity_provider::identity_for(provider.kind(), &facts, &public_key)
}

/// Sign an answer at the one point it leaves the machine. Refuses an answer
/// that is not attributed to THIS computer's identity (`seal_submission`
/// checks the id commits to this key) -- and signs only what the OS reports:
/// the answer's whole sender identity (principal, display name, scope,
/// provider) is REPLACED by [`current_identity`] before signing. A draft is
/// read from the workbook (`writeback_drafts.json`), so a crafted .cala could
/// carry this user's public id with "CORP\ceo" as the principal or a scope
/// that switches the owner check off; the id check alone would have signed
/// those claims with this user's key, while the confirmation showed the OS
/// identity instead.
pub(crate) fn seal_outgoing(
    sub: &mut calp::writeback::WritebackSubmission,
    package: &str,
    version: &str,
    origin: calp::SubmissionOrigin,
) -> Result<(), String> {
    let me = current_identity()?;
    if sub.submitter.id != me.id {
        return Err(format!(
            "Refusing to sign: the answer is attributed to '{}', which is not this computer's signed identity.",
            sub.submitter.id
        ));
    }
    sub.submitter = me;
    let seed = signing_seed()?;
    calp::submission_seal::seal_submission(sub, package, version, seed.bytes(), origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Windows provider reads a real account from the OS: a SID, a
    /// `DOMAIN\user` name, and an id that is a safe folder name committing to
    /// this "computer's" key.
    #[test]
    fn the_windows_provider_reads_the_account_from_the_os() {
        let facts = windows_account_facts().expect("the OS names the account");
        assert!(facts.subject.starts_with("S-1-"), "not a SID: {}", facts.subject);
        assert!(!facts.principal_name.is_empty());
        let me = current_identity().unwrap();
        assert!(me.id.starts_with(&format!("win-{}-", facts.subject)), "{}", me.id);
        assert_eq!(me.provider, IdentityProviderKind::Windows);
        assert_eq!(me.principal_name, facts.principal_name);
        assert!(calp::workspace::validate_component(&me.id, "submitter id").is_ok());
        // Stable within one "computer".
        assert_eq!(current_identity().unwrap().id, me.id);
    }

    /// Two "computers" (test profiles) are two keys and so two ids, even for
    /// the same Windows account.
    #[test]
    fn another_computer_is_another_sender_id() {
        let a = tempfile::TempDir::new().unwrap();
        let b = tempfile::TempDir::new().unwrap();
        let id_a = crate::profile_dir::with_test_profile(a.path(), || current_identity().unwrap().id);
        let id_b = crate::profile_dir::with_test_profile(b.path(), || current_identity().unwrap().id);
        assert_ne!(id_a, id_b);
    }

    #[test]
    fn scope_follows_the_sid_and_the_sam_domain() {
        assert_eq!(scope_of("S-1-12-1-1-2-3-4", "AzureAD\\anna", "PC1"), AccountScope::EntraJoined);
        assert_eq!(scope_of("S-1-5-21-1-2-3-1001", "PC1\\salle", "pc1"), AccountScope::LocalMachine);
        assert_eq!(scope_of("S-1-5-21-1-2-3-1001", "CORP\\anna", "PC1"), AccountScope::Domain);
        assert_eq!(scope_of("S-1-5-21-1-2-3-1001", "anna", "PC1"), AccountScope::Domain);
    }

    /// Only the Windows provider is selectable; the Entra stub refuses.
    #[test]
    fn only_windows_is_selectable_today() {
        assert_eq!(active_provider().kind(), IdentityProviderKind::Windows);
        assert!(!calp::identity_provider::EntraProvider.selectable());
    }

    /// The app keeps the signing key in the Credential Manager, never in a
    /// file the page could read and copy: `submitter_store`'s app branch
    /// returns `app_submitter_key_store()`, which names the one target.
    ///
    /// SABOTAGE: return the `FileKeyStore` from the `#[cfg(not(test))]` branch.
    #[test]
    fn the_app_keeps_the_signing_key_in_the_credential_manager_never_in_a_file() {
        let store = app_submitter_key_store();
        assert_eq!(store.target(), SUBMITTER_KEY_CREDENTIAL_TARGET);
        assert!(store.repair_hint().contains("Credential Manager"));
        let text = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("submitter_identity.rs"),
        )
        .unwrap();
        let start = text.find("fn submitter_store(").unwrap();
        let body = &text[start..start + text[start..].find("\n}\n").unwrap()];
        let at = body.find("#[cfg(not(test))]").unwrap();
        let (test_branch, app_branch) = body.split_at(at);
        assert!(app_branch.contains("Box::new(app_submitter_key_store())"), "{app_branch}");
        assert!(!app_branch.contains("FileKeyStore"), "the app keeps its signing key in a FILE");
        assert!(test_branch.contains("#[cfg(test)]"));
        // No IPC command returns the seed: only this module touches it.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut users = Vec::new();
        for entry in walk(&root) {
            let source = std::fs::read_to_string(&entry).unwrap();
            if source.contains("signing_seed(") && !entry.ends_with("submitter_identity.rs") {
                users.push(entry.display().to_string());
            }
        }
        assert!(users.is_empty(), "the signing seed is reached outside submitter_identity.rs: {users:?}");
    }

    fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
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

    /// An answer this computer signs checks as signed; one attributed to any
    /// other id is refused before signing.
    #[test]
    fn seal_outgoing_signs_only_as_this_computer() {
        let me = current_identity().unwrap();
        let mut sub = calp::writeback::WritebackSubmission {
            id: "0190aaaa-0000-7000-8000-00000000000a".into(),
            region_id: "r1".into(),
            cell_row: 1,
            cell_col: 1,
            cell_id: None,
            submitter: me.clone(),
            value: calp::writeback::SubmissionValue::Number { value: 3.0 },
            state: calp::writeback::SubmissionState::Submitted,
            created_at: "2026-10-22T10:00:00Z".into(),
            updated_at: "2026-10-22T10:00:00Z".into(),
            submitted_at: Some("2026-10-22T10:00:00Z".into()),
            review_reason: None,
            reviewed_by: None,
            environment: String::new(),
            model_key: None,
            seal: None,
            sender: Default::default(),
            identity: Default::default(),
            extra: Default::default(),
        };
        seal_outgoing(&mut sub, "app", "1.0.0", calp::SubmissionOrigin::Interactive).unwrap();
        assert_eq!(
            calp::submission_seal::check_submission(&sub, "app", "1.0.0"),
            Ok(calp::SenderCheck::Signed)
        );
        let mut foreign = sub.clone();
        foreign.seal = None;
        foreign.submitter.id = "01a087b6-3308-79f7-8002-aa29c40418ce".into();
        assert!(seal_outgoing(&mut foreign, "app", "1.0.0", calp::SubmissionOrigin::Interactive).is_err());

        // A DRAFT FROM A CRAFTED WORKBOOK: my public id, but someone else's
        // principal, display name and scope. Only the OS's account is signed.
        let mut crafted = sub.clone();
        crafted.seal = None;
        crafted.submitter.principal_name = "CORP\\ceo".into();
        crafted.submitter.display_name = "The CEO".into();
        crafted.submitter.scope = if me.scope == calp::AccountScope::Domain {
            calp::AccountScope::LocalMachine
        } else {
            calp::AccountScope::Domain
        };
        seal_outgoing(&mut crafted, "app", "1.0.0", calp::SubmissionOrigin::Interactive).unwrap();
        assert_eq!(crafted.submitter.principal_name, me.principal_name, "signed the OS's principal");
        assert_eq!(crafted.submitter.display_name, me.display_name);
        assert_eq!(crafted.submitter.scope, me.scope);
        assert_eq!(
            calp::submission_seal::check_submission(&crafted, "app", "1.0.0"),
            Ok(calp::SenderCheck::Signed)
        );
    }
}
