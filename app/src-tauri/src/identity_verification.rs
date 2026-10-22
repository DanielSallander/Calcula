//! FILENAME: app/src-tauri/src/identity_verification.rs
//! PURPOSE: The READ side of identity phase 1 on Windows: what storage a
//! workspace is on, and which account Windows recorded as the WRITER of each
//! answer's file -- the facts `calp::identity_check` turns into a verdict
//! (Verified / signed but unconfirmed / not verified / sent before sign-in).
//! CONTEXT: Owner decisions 2026-10-22 (open-items 2.am). The fold decides,
//! identically everywhere, whether an answer is SIGNED by the key its id
//! names; this module runs AFTER the fold, on the reader's own computer, and
//! never changes what the fold kept -- it labels, and with an application's
//! "count only verified senders" rule decides what is COUNTED.
//!
//! * STORAGE ([`classify_storage`]): a UNC path or mapped drive is a network
//!   share; a Dropbox root (from Dropbox's own `info.json`), a OneDrive root
//!   (`%OneDrive%`, `%OneDriveCommercial%`, `%OneDriveConsumer%`) or any
//!   Windows cloud-files sync root (`CfGetSyncRootInfoByPath`) is a SYNC
//!   FOLDER, where every file is written by the sync program as whoever runs it
//!   here -- the owner record means nothing; a volume without persistent ACLs
//!   (FAT, exFAT) has no owners at all. Cached per workspace root.
//! * OWNER ([`file_facts`]): `GetNamedSecurityInfoW(OWNER | DACL)` and
//!   `LookupAccountSidW` for the name -- AND whether anybody else may change
//!   the file. The owner records who CREATED a file, not who last wrote it: NTFS
//!   and SMB keep it when a file is moved within a volume or overwritten by
//!   another account. So the owner proves the writer only when the file's DACL
//!   gives no account but the owner, SYSTEM and Administrators a right to write,
//!   delete or re-own it, and its sender folder is owned by the same account
//!   ([`others_can_change_from`]). Cached per (file, size, modified).
//! * [`attest`]: every caller that COUNTS answers attaches the verdicts with it
//!   and then applies the application's rule (`calp::identity_check::admit`);
//!   pinned by `every_counting_reader_attests_the_answers_it_reads`.
//!
//! What a Verified answer proves, stated plainly: a process running as that
//! Windows account (or an administrator) created the file, and no other
//! account (besides SYSTEM and Administrators) can change it. On a share where
//! every user has the common inherited Modify right, nothing is Verified -- the
//! answers read "other accounts can change this answer's file";
//! docs/design/calp-writeback.md ("Who sends an answer") recommends the
//! per-sender folder ACL that makes verification possible.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use calp::identity_check::{assess, OwnerFinding, StorageKind, ADMINISTRATORS_SID};
use calp::writeback::WritebackSubmission;

const DRIVE_FIXED: u32 = 3;
const DRIVE_REMOTE: u32 = 4;
const FILE_PERSISTENT_ACLS: u32 = 0x8;

// ============================================================================
// Paths
// ============================================================================

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// A plain Windows spelling of `path`: `\\?\C:\x` -> `C:\x`,
/// `\\?\UNC\server\share` -> `\\server\share`, forward slashes turned round.
pub(crate) fn plain_path(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', "\\");
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    }
}

/// The spelling to hand a Win32 security call (`GetNamedSecurityInfoW`): the
/// VERBATIM form of an absolute path -- `\\?\C:\x`, `\\?\UNC\server\share\x` --
/// which those calls accept at any length. The plain form fails with
/// ERROR_INVALID_NAME (123) beyond MAX_PATH (260 characters) in a process that
/// is not long-path aware, and Calcula is not: an answer's file sits about 170
/// characters below its workspace
/// (`{app}\{version}\submissions\win-<SID>-<32 hex>\<region>_<row>_<col>_<id>.json`),
/// so in a workspace deeper than about 90 characters every answer read
/// "Windows did not say who wrote the file" (BUG-0584). A relative path, a
/// device path, or one with `.` / `..` components (which a verbatim path does
/// not resolve) stays plain.
pub(crate) fn api_path(path: &Path) -> String {
    let plain = plain_path(path);
    if plain.split('\\').any(|c| c == "." || c == "..") {
        return plain;
    }
    if let Some(rest) = plain.strip_prefix(r"\\") {
        if rest.starts_with('.') || rest.starts_with('?') {
            return plain;
        }
        return format!(r"\\?\UNC\{rest}");
    }
    let b = plain.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
        return format!(r"\\?\{plain}");
    }
    plain
}

/// Whether `path` is inside `root` (case-insensitive, on path components).
pub(crate) fn is_under(path: &str, root: &str) -> bool {
    let p = path.trim_end_matches('\\').to_lowercase();
    let r = root.trim().trim_end_matches('\\').to_lowercase();
    !r.is_empty() && (p == r || p.starts_with(&format!("{r}\\")))
}

/// The computer this reader runs on (`COMPUTERNAME`).
pub(crate) fn reader_computer() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

// ============================================================================
// Sync folders
// ============================================================================

/// Dropbox's sync roots, from its own `info.json` (personal and business).
pub(crate) fn dropbox_roots_from_info(json: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(obj) = v.as_object() else {
        return Vec::new();
    };
    obj.values()
        .filter_map(|account| account.get("path").and_then(|p| p.as_str()).map(str::to_string))
        .filter(|p| !p.trim().is_empty())
        .collect()
}

/// Every sync root this computer's Dropbox and OneDrive name.
pub(crate) fn known_sync_roots() -> Vec<String> {
    let mut roots = Vec::new();
    for var in ["LOCALAPPDATA", "APPDATA"] {
        if let Ok(base) = std::env::var(var) {
            let info = PathBuf::from(base).join("Dropbox").join("info.json");
            if let Ok(text) = std::fs::read_to_string(&info) {
                roots.extend(dropbox_roots_from_info(&text));
            }
        }
    }
    for var in ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] {
        if let Ok(root) = std::env::var(var) {
            if !root.trim().is_empty() {
                roots.push(root);
            }
        }
    }
    roots
}

/// Whether Windows' cloud-files API says `path` is inside a sync root
/// (OneDrive, and Dropbox / Google Drive where they use it).
fn is_cloud_files_sync_root(path: &str) -> bool {
    use windows::Win32::Storage::CloudFilters::{
        CfGetSyncRootInfoByPath, CF_SYNC_ROOT_BASIC_INFO, CF_SYNC_ROOT_INFO_BASIC,
    };
    let w = wide(path);
    let mut info = CF_SYNC_ROOT_BASIC_INFO::default();
    let mut returned: u32 = 0;
    let result = unsafe {
        CfGetSyncRootInfoByPath(
            windows::core::PCWSTR(w.as_ptr()),
            CF_SYNC_ROOT_INFO_BASIC,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<CF_SYNC_ROOT_BASIC_INFO>() as u32,
            Some(&mut returned),
        )
    };
    match result {
        Ok(()) => true,
        // ERROR_MORE_DATA: it IS a sync root, the buffer was just small.
        Err(e) => e.code().0 as u32 == 0x8007_00EA,
    }
}

// ============================================================================
// Storage
// ============================================================================

/// The storage class of a plain path, from its parts: whether it is a sync
/// folder, the drive type, and the volume's persistent-ACL flag. Pure, so the
/// rule is unit-tested without a share or a Dropbox.
pub(crate) fn storage_from_facts(in_sync_root: bool, drive_type: u32, persistent_acls: Option<bool>) -> StorageKind {
    if in_sync_root {
        return StorageKind::SyncFolder;
    }
    match persistent_acls {
        Some(false) => return StorageKind::NoOwnerRecords,
        None => return StorageKind::Unknown,
        Some(true) => {}
    }
    match drive_type {
        DRIVE_REMOTE => StorageKind::NetworkShare,
        DRIVE_FIXED => StorageKind::LocalDisk,
        // Removable NTFS media behave like a local disk for owner records.
        2 => StorageKind::LocalDisk,
        _ => StorageKind::Unknown,
    }
}

/// The volume root of `path` (`C:\`, `\\server\share\`).
fn volume_root(path: &str) -> Option<String> {
    use windows::Win32::Storage::FileSystem::GetVolumePathNameW;
    let w = wide(path);
    let mut buf = vec![0u16; 1024];
    unsafe { GetVolumePathNameW(windows::core::PCWSTR(w.as_ptr()), &mut buf) }.ok()?;
    let root = from_wide(&buf);
    (!root.is_empty()).then_some(root)
}

fn classify_uncached(path: &Path) -> StorageKind {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumeInformationW};
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let plain = plain_path(&canonical);
    let in_sync = known_sync_roots().iter().any(|root| is_under(&plain, root)) || is_cloud_files_sync_root(&plain);
    let Some(root) = volume_root(&plain) else {
        return storage_from_facts(in_sync, 0, None);
    };
    let wroot = wide(&root);
    let drive_type = if plain.starts_with(r"\\") {
        DRIVE_REMOTE
    } else {
        unsafe { GetDriveTypeW(windows::core::PCWSTR(wroot.as_ptr())) }
    };
    let mut flags: u32 = 0;
    let persistent = unsafe {
        GetVolumeInformationW(windows::core::PCWSTR(wroot.as_ptr()), None, None, None, Some(&mut flags), None)
    }
    .ok()
    .map(|_| flags & FILE_PERSISTENT_ACLS != 0);
    storage_from_facts(in_sync, drive_type, persistent)
}

fn storage_cache() -> &'static Mutex<HashMap<PathBuf, StorageKind>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, StorageKind>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What storage a workspace folder is on, as THIS computer sees it. Cached for
/// the session (a folder does not move between a share and Dropbox mid-run).
pub(crate) fn classify_storage(path: &Path) -> StorageKind {
    #[cfg(test)]
    if let Some(kind) = test_override::storage() {
        return kind;
    }
    if let Some(hit) = storage_cache().lock().ok().and_then(|c| c.get(path).copied()) {
        return hit;
    }
    let kind = classify_uncached(path);
    if let Ok(mut c) = storage_cache().lock() {
        c.insert(path.to_path_buf(), kind);
    }
    kind
}

/// The storage of a workspace the user named (a folder, a `workspace.calcula`
/// pointer or a `file://` URL); `Unknown` for an HTTP workspace.
pub(crate) fn workspace_storage(registry_path: &str) -> StorageKind {
    match crate::calp_registry::open_workspace_scoped(registry_path) {
        Ok((registry, _scope)) => registry.local_root().map(|r| classify_storage(&r)).unwrap_or(StorageKind::Unknown),
        Err(_) => StorageKind::Unknown,
    }
}

/// The publish-time warning for a Windows-account application whose workspace
/// cannot ever verify its senders (owner decision 2026-10-22: warn and label,
/// never refuse). `None` when the storage can verify them -- which on a share
/// still needs DOMAIN accounts and a per-sender folder that nobody else may
/// change (said in the share sentence the publish dialog always shows).
pub(crate) fn publish_storage_warning(storage: StorageKind) -> Option<String> {
    match storage {
        StorageKind::SyncFolder => Some(
            "This workspace is a Dropbox or OneDrive folder. Answers are signed, but on a sync folder \
             Windows cannot confirm which account sent them: every answer will be labelled \"Signed, \
             identity not confirmed\", and an application that counts only verified senders will count \
             none of them. To have senders verified, publish to a network file share where senders sign \
             in with domain accounts and each sender's folder can be changed only by that sender."
                .to_string(),
        ),
        StorageKind::NoOwnerRecords => Some(
            "This workspace is on a drive that does not record who wrote each file (FAT/exFAT): senders \
             cannot be verified here, every answer will be labelled \"Signed, identity not confirmed\", \
             and an application that counts only verified senders will count none of them."
                .to_string(),
        ),
        StorageKind::Unknown => Some(
            "Calcula could not tell what kind of storage this workspace is on (it may be a web address or \
             could not be read), so senders may never be verified: answers will be labelled \"Signed, \
             identity not confirmed\", and an application that counts only verified senders may count \
             none of them."
                .to_string(),
        ),
        StorageKind::LocalDisk | StorageKind::NetworkShare => None,
    }
}

// ============================================================================
// Owners
// ============================================================================

/// The account name a SID resolves to on this computer (`CORP\bob`), or empty.
fn account_name(sid: windows::Win32::Security::PSID) -> String {
    use windows::Win32::Security::{LookupAccountSidW, SID_NAME_USE};
    let mut name_len: u32 = 0;
    let mut domain_len: u32 = 0;
    let mut use_ = SID_NAME_USE::default();
    unsafe {
        let _ = LookupAccountSidW(None, sid, None, &mut name_len, None, &mut domain_len, &mut use_);
    }
    if name_len == 0 || name_len > 1024 || domain_len > 1024 {
        return String::new();
    }
    let mut name = vec![0u16; name_len as usize + 1];
    let mut domain = vec![0u16; domain_len as usize + 1];
    let ok = unsafe {
        LookupAccountSidW(
            None,
            sid,
            Some(windows::core::PWSTR(name.as_mut_ptr())),
            &mut name_len,
            Some(windows::core::PWSTR(domain.as_mut_ptr())),
            &mut domain_len,
            &mut use_,
        )
    };
    if ok.is_err() {
        return String::new();
    }
    let (name, domain) = (from_wide(&name), from_wide(&domain));
    if domain.is_empty() { name } else { format!("{domain}\\{name}") }
}

/// The SIDs whose write access never makes an owner record meaningless: the
/// operating system, the local administrators (who can set any owner anyway,
/// and whose own files read "written by an administrator"), and the owner
/// placeholders `OWNER RIGHTS` and `CREATOR OWNER`.
const TRUSTED_WRITER_SIDS: [&str; 4] = ["S-1-5-18", ADMINISTRATORS_SID, "S-1-3-4", "S-1-3-0"];

/// Access rights that let an account change what a file holds, remove or
/// replace it, or take it over: FILE_WRITE_DATA, FILE_APPEND_DATA, DELETE,
/// WRITE_DAC, WRITE_OWNER, GENERIC_WRITE, GENERIC_ALL.
const CHANGE_RIGHTS: u32 = 0x0000_0002 | 0x0000_0004 | 0x0001_0000 | 0x0004_0000 | 0x0008_0000 | 0x4000_0000 | 0x1000_0000;

/// One access-control entry of a file's DACL, as the decision reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AceFacts {
    /// The raw ACE type (0 = allow, 1 = deny, 9 = allow-callback, ...).
    pub ace_type: u8,
    /// The raw ACE flags (0x08 = INHERIT_ONLY: applies to children, not here).
    pub flags: u8,
    pub mask: u32,
    /// The trustee's SID as a string; empty when the entry's layout is not one
    /// this reader understands.
    pub sid: String,
}

/// WHETHER ANYONE BUT THE OWNER MAY CHANGE THE FILE, from its DACL. `None` is a
/// NULL DACL: everybody may. Deny entries are ignored (they can only make the
/// answer safer, and their order matters), so this errs towards "others can".
/// An allow entry of a layout this reader does not parse counts as others.
pub(crate) fn others_can_change_from(owner_sid: &str, aces: Option<&[AceFacts]>) -> bool {
    let Some(aces) = aces else {
        return true;
    };
    aces.iter().any(|ace| {
        let allow = matches!(ace.ace_type, 0 | 5 | 9 | 11);
        if !allow || ace.flags & 0x08 != 0 || ace.mask & CHANGE_RIGHTS == 0 {
            return false;
        }
        if ace.sid.is_empty() || ace.ace_type == 5 || ace.ace_type == 11 {
            return true;
        }
        !(ace.sid.eq_ignore_ascii_case(owner_sid) || TRUSTED_WRITER_SIDS.iter().any(|s| ace.sid.eq_ignore_ascii_case(s)))
    })
}

/// What the verdict needs to know about one answer file: who created it, and
/// whether that is proof of who wrote what it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileFacts {
    pub sid: String,
    pub name: String,
    /// Another account may change the file (its DACL), or its sender folder
    /// belongs to another account.
    pub others_can_change: bool,
}

/// A SID as its string spelling.
fn sid_text(sid: windows::Win32::Security::PSID) -> Result<String, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    let mut text = windows::core::PWSTR::null();
    unsafe { ConvertSidToStringSidW(sid, &mut text) }.map_err(|e| format!("Windows could not spell a SID: {e}"))?;
    let out = unsafe { text.to_string() }.map_err(|e| e.to_string());
    unsafe {
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut core::ffi::c_void)));
    }
    out
}

/// The owner and every DACL entry of `path` (`None` entries = a NULL DACL).
fn owner_and_dacl(path: &Path) -> Result<(String, String, Option<Vec<AceFacts>>), String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL, WIN32_ERROR};
    use windows::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows::Win32::Security::{
        GetAce, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    };
    let w = wide(&api_path(path));
    let mut owner = PSID::default();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let status = unsafe {
        GetNamedSecurityInfoW(
            windows::core::PCWSTR(w.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            Some(&mut dacl),
            None,
            &mut descriptor,
        )
    };
    if status != WIN32_ERROR(0) {
        return Err(format!("Windows did not say who wrote {} (error {})", path.display(), status.0));
    }
    struct Free(PSECURITY_DESCRIPTOR);
    impl Drop for Free {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0 .0)));
            }
        }
    }
    let _free = Free(descriptor);
    let sid = sid_text(owner).map_err(|e| format!("{e} (the owner of {})", path.display()))?;
    let name = account_name(owner);
    if dacl.is_null() {
        return Ok((sid, name, None));
    }
    let count = unsafe { (*dacl).AceCount } as u32;
    let mut aces = Vec::with_capacity(count as usize);
    for index in 0..count {
        let mut raw: *mut core::ffi::c_void = std::ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut raw) }.is_err() || raw.is_null() {
            // An entry Windows would not hand over: assume the worst.
            aces.push(AceFacts { ace_type: 0, flags: 0, mask: u32::MAX, sid: String::new() });
            continue;
        }
        let header = unsafe { &*(raw as *const ACE_HEADER) };
        let (ace_type, flags) = (header.AceType, header.AceFlags);
        // ACCESS_ALLOWED_ACE / ACCESS_DENIED_ACE (and their callback forms):
        // header, then a 32-bit mask, then the SID.
        let simple = matches!(ace_type, 0 | 1 | 9 | 10);
        let mask = unsafe { *((raw as *const u8).add(std::mem::size_of::<ACE_HEADER>()) as *const u32) };
        let trustee = if simple {
            let sid_ptr = unsafe { (raw as *const u8).add(std::mem::size_of::<ACE_HEADER>() + 4) };
            sid_text(PSID(sid_ptr as *mut core::ffi::c_void)).unwrap_or_default()
        } else {
            String::new()
        };
        aces.push(AceFacts { ace_type, flags, mask, sid: trustee });
    }
    Ok((sid, name, Some(aces)))
}

/// Who created `path`, and whether that proves who wrote it
/// ([`others_can_change_from`], plus: its folder -- the sender's folder -- is
/// owned by the same account).
pub(crate) fn file_facts(path: &Path) -> Result<FileFacts, String> {
    let (sid, name, aces) = owner_and_dacl(path)?;
    let mut others_can_change = others_can_change_from(&sid, aces.as_deref());
    if !others_can_change {
        others_can_change = match path.parent().map(file_owner) {
            Some(Ok((folder_sid, _))) => !folder_sid.eq_ignore_ascii_case(&sid),
            _ => true,
        };
    }
    Ok(FileFacts { sid, name, others_can_change })
}

/// Who Windows recorded as the owner of `path`: `(SID, account name)`.
pub(crate) fn file_owner(path: &Path) -> Result<(String, String), String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL, WIN32_ERROR};
    use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows::Win32::Security::{OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID};
    let w = wide(&api_path(path));
    let mut owner = PSID::default();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let status = unsafe {
        GetNamedSecurityInfoW(
            windows::core::PCWSTR(w.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            &mut descriptor,
        )
    };
    if status != WIN32_ERROR(0) {
        return Err(format!("Windows did not say who wrote {} (error {})", path.display(), status.0));
    }
    struct Free(PSECURITY_DESCRIPTOR);
    impl Drop for Free {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0 .0)));
            }
        }
    }
    let _free = Free(descriptor);
    let mut text = windows::core::PWSTR::null();
    unsafe { ConvertSidToStringSidW(owner, &mut text) }
        .map_err(|e| format!("Windows could not spell the owner of {}: {e}", path.display()))?;
    let sid = unsafe { text.to_string() }.map_err(|e| e.to_string());
    unsafe {
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut core::ffi::c_void)));
    }
    let sid = sid?;
    Ok((sid, account_name(owner)))
}

type OwnerKey = (PathBuf, u64, Option<std::time::SystemTime>);

fn owner_cache() -> &'static Mutex<HashMap<OwnerKey, FileFacts>> {
    static CACHE: OnceLock<Mutex<HashMap<OwnerKey, FileFacts>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// [`file_facts`], cached per (file, size, modified): an answer file is never
/// rewritten (append-only), so a changed one is a different key.
fn cached_owner(path: &Path) -> Result<FileFacts, String> {
    #[cfg(test)]
    if let Some(found) = test_override::owner(path) {
        return found.map(|(sid, name)| FileFacts { sid, name, others_can_change: test_override::others_can_change() });
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let key = (path.to_path_buf(), meta.len(), meta.modified().ok());
    if let Some(hit) = owner_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(hit);
    }
    let found = file_facts(path)?;
    if let Ok(mut c) = owner_cache().lock() {
        if c.len() > 50_000 {
            c.clear();
        }
        c.insert(key, found.clone());
    }
    Ok(found)
}

/// Who wrote the file(s) holding `sub`. Several files can hold one answer (a
/// sync client's renamed copy): a file owned by the claimed account wins (with
/// whether others could have changed it); else a non-administrator owner (the
/// mismatch); else an administrator; else the read failed.
pub(crate) fn owner_of_answer(
    registry: &dyn calp::WorkspaceTransport,
    package: &str,
    version: &str,
    sub: &WritebackSubmission,
) -> OwnerFinding {
    let files = match registry.local_submission_files(package, version, sub) {
        Ok(Some(files)) => files,
        Ok(None) => return OwnerFinding::NoFile,
        Err(e) => {
            crate::log_warn!("CALP", "identity check: the files of answer '{}' could not be listed: {}", sub.id, e);
            return OwnerFinding::Unreadable(e.to_string());
        }
    };
    if files.is_empty() {
        return OwnerFinding::NoFile;
    }
    let claimed = calp::identity_provider::parse_signed_id(&sub.submitter.id)
        .map(|(_, subject, _)| subject.to_string())
        .unwrap_or_default();
    let mut other: Option<FileFacts> = None;
    let mut admin: Option<FileFacts> = None;
    let mut error: Option<String> = None;
    for file in &files {
        match cached_owner(file) {
            Ok(f) if f.sid.eq_ignore_ascii_case(&claimed) => {
                return OwnerFinding::Owner { sid: f.sid, name: f.name, others_can_change: f.others_can_change }
            }
            Ok(f) if f.sid.eq_ignore_ascii_case(ADMINISTRATORS_SID) => {
                admin.get_or_insert(f);
            }
            Ok(found) => {
                other.get_or_insert(found);
            }
            Err(e) => {
                error.get_or_insert(e);
            }
        }
    }
    match (other, admin, error) {
        (Some(f), _, _) | (None, Some(f), _) => {
            OwnerFinding::Owner { sid: f.sid, name: f.name, others_can_change: f.others_can_change }
        }
        (None, None, Some(e)) => {
            // The verdict only says "Windows did not say who wrote the file";
            // the reason is here, or nobody can tell why.
            crate::log_warn!("CALP", "identity check: the writer of answer '{}' could not be read: {}", sub.id, e);
            OwnerFinding::Unreadable(e)
        }
        (None, None, None) => OwnerFinding::NoFile,
    }
}

// ============================================================================
// Attest
// ============================================================================

/// Attach the reader's verdict to every answer read from
/// `{package}/{version}` (`WritebackSubmission::identity`). THE step every
/// reader that COUNTS answers runs before `calp::identity_check::admit`.
///
/// Never fetches anything over a network beyond the owner lookups on the
/// share the answers are already read from, and only for SIGNED answers on
/// storage where the owner means something (`owner_check_applies`): a reader
/// on a sync folder pays nothing.
pub(crate) fn attest(
    registry: &dyn calp::WorkspaceTransport,
    package: &str,
    version: &str,
    rows: &mut [WritebackSubmission],
) {
    if rows.is_empty() {
        return;
    }
    let storage = registry.local_root().map(|root| classify_storage(&root)).unwrap_or(StorageKind::Unknown);
    let computer = reader_computer();
    for row in rows.iter_mut() {
        let verdict = assess(&*row, storage, &computer, || owner_of_answer(registry, package, version, &*row));
        row.identity = verdict;
    }
}

/// [`attest`] by value, for a chain.
pub(crate) fn attested(
    registry: &dyn calp::WorkspaceTransport,
    package: &str,
    version: &str,
    mut rows: Vec<WritebackSubmission>,
) -> Vec<WritebackSubmission> {
    attest(registry, package, version, &mut rows);
    rows
}

// ============================================================================
// Test override (deterministic storage and owners in unit tests)
// ============================================================================

#[cfg(test)]
pub(crate) mod test_override {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    type OwnerFn = Rc<dyn Fn(&Path) -> Result<(String, String), String>>;

    thread_local! {
        static OVERRIDE: RefCell<Option<(StorageKind, Option<OwnerFn>)>> = const { RefCell::new(None) };
        static SHARED_FILES: RefCell<bool> = const { RefCell::new(false) };
    }

    /// Whether the overridden owner lookups report files OTHER accounts may
    /// change (default: no -- each sender's file is theirs alone).
    pub(crate) fn others_can_change() -> bool {
        SHARED_FILES.with(|s| *s.borrow())
    }

    /// Run `f` with every overridden owner lookup reporting a file other
    /// accounts may change (the common inherited Modify right on a share).
    pub(crate) fn with_shared_files<R>(f: impl FnOnce() -> R) -> R {
        let previous = SHARED_FILES.with(|s| s.replace(true));
        struct Restore(bool);
        impl Drop for Restore {
            fn drop(&mut self) {
                let prev = self.0;
                SHARED_FILES.with(|s| *s.borrow_mut() = prev);
            }
        }
        let _restore = Restore(previous);
        f()
    }

    pub(crate) fn storage() -> Option<StorageKind> {
        OVERRIDE.with(|o| o.borrow().as_ref().map(|(k, _)| *k))
    }

    pub(crate) fn owner(path: &Path) -> Option<Result<(String, String), String>> {
        let f = OVERRIDE.with(|o| o.borrow().as_ref().and_then(|(_, f)| f.clone()))?;
        Some(f(path))
    }

    /// Run `f` as if the workspace were on `storage`, with `owner` answering
    /// every owner lookup (`None` = the real OS lookup).
    pub(crate) fn with<R>(
        storage: StorageKind,
        owner: Option<OwnerFn>,
        f: impl FnOnce() -> R,
    ) -> R {
        let previous = OVERRIDE.with(|o| o.replace(Some((storage, owner))));
        struct Restore(Option<(StorageKind, Option<OwnerFn>)>);
        impl Drop for Restore {
            fn drop(&mut self) {
                let prev = self.0.take();
                OVERRIDE.with(|o| *o.borrow_mut() = prev);
            }
        }
        let _restore = Restore(previous);
        f()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_spelled_plainly_and_compared_on_components() {
        assert_eq!(plain_path(Path::new(r"\\?\C:\Dropbox\x")), r"C:\Dropbox\x");
        assert_eq!(plain_path(Path::new(r"\\?\UNC\server\share\ws")), r"\\server\share\ws");
        // What the security calls get (BUG-0584): verbatim, at any length.
        assert_eq!(api_path(Path::new(r"C:\ws\a.json")), r"\\?\C:\ws\a.json");
        assert_eq!(api_path(Path::new("C:/ws/a.json")), r"\\?\C:\ws\a.json");
        assert_eq!(api_path(Path::new(r"\\?\C:\ws\a.json")), r"\\?\C:\ws\a.json");
        assert_eq!(api_path(Path::new(r"\\server\share\ws\a.json")), r"\\?\UNC\server\share\ws\a.json");
        assert_eq!(api_path(Path::new(r"\\?\UNC\server\share\a")), r"\\?\UNC\server\share\a");
        // A verbatim path would not resolve these, so they stay plain.
        assert_eq!(api_path(Path::new(r"C:\ws\..\a.json")), r"C:\ws\..\a.json");
        assert_eq!(api_path(Path::new(r"ws\a.json")), r"ws\a.json");
        assert_eq!(api_path(Path::new(r"\\.\pipe\x")), r"\\.\pipe\x");
        assert!(is_under(r"C:\Dropbox\Projekt", r"c:\dropbox"));
        assert!(is_under(r"C:\Dropbox", r"C:\Dropbox\"));
        assert!(!is_under(r"C:\DropboxOther\x", r"C:\Dropbox"));
        assert!(!is_under(r"C:\x", ""));
    }

    #[test]
    fn dropbox_info_names_every_account_root() {
        let json = r#"{"personal":{"path":"C:\\Dropbox","host":1},"business":{"path":"D:\\Dropbox (Corp)"}}"#;
        let mut roots = dropbox_roots_from_info(json);
        roots.sort();
        assert_eq!(roots, vec![r"C:\Dropbox".to_string(), r"D:\Dropbox (Corp)".to_string()]);
        assert!(dropbox_roots_from_info("not json").is_empty());
    }

    /// The storage rule: a sync folder wins over everything; no persistent ACLs
    /// means no owners; then the drive type.
    #[test]
    fn the_storage_rule() {
        assert_eq!(storage_from_facts(true, DRIVE_REMOTE, Some(true)), StorageKind::SyncFolder);
        assert_eq!(storage_from_facts(true, DRIVE_FIXED, None), StorageKind::SyncFolder);
        assert_eq!(storage_from_facts(false, DRIVE_FIXED, Some(false)), StorageKind::NoOwnerRecords);
        assert_eq!(storage_from_facts(false, DRIVE_REMOTE, Some(true)), StorageKind::NetworkShare);
        assert_eq!(storage_from_facts(false, DRIVE_FIXED, Some(true)), StorageKind::LocalDisk);
        assert_eq!(storage_from_facts(false, DRIVE_FIXED, None), StorageKind::Unknown);
        assert_eq!(storage_from_facts(false, 5, Some(true)), StorageKind::Unknown);
        // Storage that cannot be identified is warned about at publish too.
        assert!(publish_storage_warning(StorageKind::Unknown).unwrap().contains("could not tell"));
        assert!(publish_storage_warning(StorageKind::NoOwnerRecords).unwrap().contains("count none"));
    }

    /// REAL OS: a temp folder is a local NTFS disk, and a file this process
    /// writes is owned by the account it runs as (or, elevated, by
    /// Administrators -- which the verdict treats as "cannot be checked").
    #[test]
    fn a_file_this_process_writes_is_owned_by_its_account() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("a.json");
        std::fs::write(&file, "{}").unwrap();
        let (sid, name) = file_owner(&file).expect("Windows names the owner");
        let me = crate::submitter_identity::windows_account_facts().unwrap();
        assert!(
            sid.eq_ignore_ascii_case(&me.subject) || sid.eq_ignore_ascii_case(ADMINISTRATORS_SID),
            "owner {sid} ({name}) is neither {} nor Administrators",
            me.subject
        );
        assert!(!name.is_empty());
        assert_eq!(classify_uncached(dir.path()), StorageKind::LocalDisk);
    }

    /// REAL OS (BUG-0584): a file deeper than MAX_PATH (260 characters) -- an
    /// answer's file in any workspace deeper than about 90 characters -- is
    /// read like a short one. The plain spelling failed with
    /// ERROR_INVALID_NAME (123), and every answer there read "Windows did not
    /// say who wrote the file".
    ///
    /// SABOTAGE: make `api_path` return `plain_path(path)`.
    #[test]
    fn real_os_a_file_deeper_than_max_path_is_read_like_a_short_one() {
        let dir = tempfile::TempDir::new().unwrap();
        let deep = dir.path().join("a".repeat(120)).join("b".repeat(120));
        std::fs::create_dir_all(&deep).unwrap();
        let file = deep.join("answer.json");
        std::fs::write(&file, "{}").unwrap();
        assert!(plain_path(&file).len() > 260, "the fixture must be deeper than MAX_PATH: {}", plain_path(&file).len());
        let facts = file_facts(&file).expect("Windows names the owner of a deep file");
        let (sid, name) = file_owner(&file).expect("and file_owner too");
        assert_eq!(sid, facts.sid);
        assert!(!name.is_empty());
        let me = crate::submitter_identity::windows_account_facts().unwrap();
        assert!(
            sid.eq_ignore_ascii_case(&me.subject) || sid.eq_ignore_ascii_case(ADMINISTRATORS_SID),
            "owner {sid} ({name}) is neither {} nor Administrators",
            me.subject
        );
    }

    /// The DACL rule: only the owner, SYSTEM and Administrators (and the owner
    /// placeholders) may hold a right to change the file; an inherit-only entry
    /// does not apply to it; a deny entry or a read-only grant is harmless; a
    /// NULL DACL or an entry this reader cannot parse counts as "others can".
    ///
    /// SABOTAGE: make `others_can_change_from` return `false`.
    #[test]
    fn the_dacl_rule_for_who_else_may_change_a_file() {
        const ME: &str = "S-1-5-21-1-2-3-1001";
        let ace = |ace_type: u8, flags: u8, mask: u32, sid: &str| AceFacts { ace_type, flags, mask, sid: sid.to_string() };
        let full = 0x001F_01FF;
        let exclusive = vec![
            ace(0, 0, full, "S-1-5-18"),
            ace(0, 0, full, ADMINISTRATORS_SID),
            ace(0, 0, full, ME),
            ace(0, 0, 0x0012_00A9, "S-1-5-32-545"), // Users: read & execute
            ace(0, 0x08, full, "S-1-3-0"),          // CREATOR OWNER, inherit-only
            ace(1, 0, full, "S-1-1-0"),             // a deny entry
        ];
        assert!(!others_can_change_from(ME, Some(&exclusive)));
        // Authenticated Users: Modify -- the common share default.
        let mut modify = exclusive.clone();
        modify.push(ace(0, 0, 0x0013_01BF, "S-1-5-11"));
        assert!(others_can_change_from(ME, Some(&modify)));
        // Just DELETE, or just taking ownership, is enough.
        assert!(others_can_change_from(ME, Some(&[ace(0, 0, 0x0001_0000, "S-1-5-21-9-9-9-1")])));
        assert!(others_can_change_from(ME, Some(&[ace(0, 0, 0x0008_0000, "S-1-5-21-9-9-9-1")])));
        // An inherit-only grant to others does not apply to this file.
        assert!(!others_can_change_from(ME, Some(&[ace(0, 0x08, full, "S-1-5-11")])));
        // NULL DACL; an unparsed allow entry.
        assert!(others_can_change_from(ME, None));
        assert!(others_can_change_from(ME, Some(&[ace(5, 0, full, "")])));
    }

    /// REAL OS: a file this process writes in its own temp folder is changeable
    /// only by its account (and SYSTEM/Administrators) -- until another account
    /// is granted Modify on it, which this reader sees.
    #[test]
    fn real_os_the_dacl_reader_sees_who_else_may_change_a_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let folder = dir.path().join("sender");
        std::fs::create_dir(&folder).unwrap();
        let file = folder.join("a.json");
        std::fs::write(&file, "{}").unwrap();
        let facts = file_facts(&file).expect("Windows reads the owner and the DACL");
        if facts.sid.eq_ignore_ascii_case(ADMINISTRATORS_SID) {
            eprintln!("elevated run: files are owned by Administrators; skipped");
            return;
        }
        assert!(!facts.others_can_change, "a fresh file in this user's temp folder: {facts:?}");
        let status = std::process::Command::new("icacls")
            .arg(&file)
            .arg("/grant")
            .arg("*S-1-1-0:(M)")
            .output()
            .expect("icacls runs");
        assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stdout));
        let facts = file_facts(&file).unwrap();
        assert!(facts.others_can_change, "Everyone may now modify it: {facts:?}");
    }

    /// REAL OS, READ-ONLY: this repository lives in the owner's Dropbox, which
    /// must classify as a sync folder. Skipped where Dropbox does not list the
    /// repository's folder (any other machine).
    #[test]
    fn a_dropbox_folder_is_classified_as_a_sync_folder() {
        let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let plain = plain_path(&std::fs::canonicalize(&here).unwrap_or(here.clone()));
        if !known_sync_roots().iter().any(|r| is_under(&plain, r)) {
            eprintln!("skipped: {plain} is not under a known sync root on this computer");
            return;
        }
        assert_eq!(classify_uncached(&here), StorageKind::SyncFolder);
        assert!(publish_storage_warning(StorageKind::SyncFolder).unwrap().contains("Dropbox or OneDrive"));
        assert!(publish_storage_warning(StorageKind::NetworkShare).is_none());
        assert!(publish_storage_warning(StorageKind::LocalDisk).is_none());
    }
}
