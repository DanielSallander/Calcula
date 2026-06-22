//! FILENAME: app/src-tauri/src/file_keychain.rs
//! PURPOSE: "Remember on this machine" for encrypted-workbook passphrases.
//!          Stores the .cala passphrase in the Windows Credential Manager keyed
//!          by the workbook's canonical absolute path, so reopening an encrypted
//!          workbook on the same machine doesn't re-prompt.
//! SECURITY: Stores ONLY the passphrase (never the derived key). The Credential
//!           Manager blob is DPAPI-encrypted and tied to the Windows login. The
//!           .cala file on disk remains encrypted regardless. Moving/renaming the
//!           file changes its path key -> a clean miss -> the user is re-prompted.
//!           Passphrases are never logged.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use windows::core::PWSTR;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

const TARGET_PREFIX: &str = "Calcula:wbpw|";

/// Build a Credential Manager target name from a workbook path. The path is
/// canonicalized (best effort) and lower-cased so the key is stable across the
/// casing/short-path variations Windows hands us for the same file.
fn make_target(path: &str) -> String {
    let canon = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string());
    format!("{}{}", TARGET_PREFIX, canon.to_lowercase())
}

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Remember a workbook passphrase for this machine, keyed by file path.
pub fn set(path: &str, passphrase: &str) -> Result<(), String> {
    let target = make_target(path);
    let secret_bytes = passphrase.as_bytes();

    let mut target_wide = to_wide(&target);
    // A non-empty UserName is required by some Credential Manager UIs; use a
    // fixed label (never the passphrase).
    let mut user_wide = to_wide("calcula-workbook");

    let cred = CREDENTIALW {
        Flags: CRED_FLAGS(0),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target_wide.as_mut_ptr()),
        Comment: PWSTR::null(),
        LastWritten: Default::default(),
        CredentialBlobSize: secret_bytes.len() as u32,
        CredentialBlob: secret_bytes.as_ptr() as *mut u8,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: PWSTR::null(),
        UserName: PWSTR(user_wide.as_mut_ptr()),
    };

    unsafe { CredWriteW(&cred, 0) }.map_err(|e| format!("CredWriteW failed: {}", e))
}

/// Look up a remembered passphrase for a workbook path. `None` = not remembered.
pub fn get(path: &str) -> Option<String> {
    let target = make_target(path);
    let target_wide = to_wide(&target);

    unsafe {
        let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();
        match CredReadW(
            windows::core::PCWSTR(target_wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut cred_ptr,
        ) {
            Ok(()) => {
                let cred = &*cred_ptr;
                let blob_size = cred.CredentialBlobSize as usize;
                let blob = std::slice::from_raw_parts(cred.CredentialBlob, blob_size);
                let secret = String::from_utf8_lossy(blob).to_string();
                CredFree(cred_ptr as *const std::ffi::c_void);
                Some(secret)
            }
            Err(_) => None,
        }
    }
}

/// Forget a remembered passphrase (used by "Remove Password" and on wrong-pass
/// cleanup). Missing entries are a no-op.
pub fn delete(path: &str) {
    let target = make_target(path);
    let target_wide = to_wide(&target);
    unsafe {
        let _ = CredDeleteW(
            windows::core::PCWSTR(target_wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
        );
    }
}

// --- Tauri commands -------------------------------------------------------

#[tauri::command]
pub fn keychain_set_password(path: String, password: String) -> Result<(), String> {
    set(&path, &password)
}

#[tauri::command]
pub fn keychain_get_password(path: String) -> Option<String> {
    get(&path)
}

#[tauri::command]
pub fn keychain_delete_password(path: String) {
    delete(&path)
}

#[tauri::command]
pub fn keychain_has_password(path: String) -> bool {
    get(&path).is_some()
}
