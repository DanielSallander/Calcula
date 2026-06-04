//! FILENAME: app/src-tauri/src/bi/credential_cache.rs
//! PURPOSE: Credential cache for BI connections using Windows Credential Manager.
//!          Stores username+password per server+database pair so that
//!          reconnecting to previously-used data sources doesn't require
//!          re-entering credentials.
//! SECURITY: Uses Windows Credential Manager (DPAPI-encrypted, tied to user login).

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW,
    CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};
use windows::core::PWSTR;

const TARGET_PREFIX: &str = "Calcula:";

/// Build a credential target name from server + database.
fn make_target(server: &str, database: &str) -> String {
    format!("{}{}|{}", TARGET_PREFIX, server.to_lowercase(), database.to_lowercase())
}

/// Convert a Rust string to a null-terminated wide string (UTF-16).
fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Save credentials for a server+database pair to Windows Credential Manager.
pub fn save_credentials(server: &str, database: &str, username: &str, password: &str) {
    let target = make_target(server, database);
    let secret = format!("{}\n{}", username, password);
    let secret_bytes = secret.as_bytes();

    let mut target_wide = to_wide(&target);
    let mut username_wide = to_wide(username);

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
        UserName: PWSTR(username_wide.as_mut_ptr()),
    };

    crate::log_info!("CALP-DIAG", "credential_cache::save target='{}' username='{}'", target, username);

    unsafe {
        match CredWriteW(&cred, 0) {
            Ok(()) => {
                crate::log_info!("CALP-DIAG", "credential_cache: saved to Windows Credential Manager");
            }
            Err(e) => {
                crate::log_warn!("CALP-DIAG", "credential_cache: CredWriteW FAILED: {}", e);
            }
        }
    }
}

/// Look up cached credentials for a server+database pair.
/// Returns (username, password) if found.
pub fn get_credentials(server: &str, database: &str) -> Option<(String, String)> {
    let target = make_target(server, database);
    let target_wide = to_wide(&target);

    crate::log_info!("CALP-DIAG", "credential_cache::get target='{}'", target);

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

                let (username, password) = secret.split_once('\n')?;
                crate::log_info!("CALP-DIAG", "credential_cache: FOUND credentials, username='{}'", username);
                Some((username.to_string(), password.to_string()))
            }
            Err(e) => {
                crate::log_info!("CALP-DIAG", "credential_cache: CredReadW returned: {}", e);
                None
            }
        }
    }
}

/// Check if we have cached credentials for a server+database pair.
pub fn has_credentials(server: &str, database: &str) -> bool {
    get_credentials(server, database).is_some()
}

/// Delete cached credentials for a server+database pair.
#[allow(dead_code)]
pub fn delete_credentials(server: &str, database: &str) {
    let target = make_target(server, database);
    let target_wide = to_wide(&target);
    unsafe {
        let _ = CredDeleteW(
            windows::core::PCWSTR(target_wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
        );
    }
}
