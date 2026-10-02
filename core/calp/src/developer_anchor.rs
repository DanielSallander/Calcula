//! FILENAME: core/calp/src/developer_anchor.rs
//! PURPOSE: The per-machine DEVELOPER ANCHOR: which key created each application
//! this computer has opened for editing, pushed to or published, and the highest
//! co-publisher list revision it has seen for it.
//!
//! CONTEXT: Every door that brings a published version into a working copy asks
//! `publishers::authorize_signer`, and that answer is anchored at the
//! application's ROOT -- the key that signed its first version. The root is
//! PROVED (its own signature verifies), but it is FOUND through the workspace's
//! version listing, which is unsigned. Anyone who can write to the workspace
//! folder can therefore plant a fake first version signed by their own key, list
//! it below the real ones, and become "the creator" -- after which every version
//! they sign is authorised. And the co-publisher list carries a monotonic
//! `revision` that nothing remembered, so an older list the root really signed,
//! restored with its still-valid signature, re-authorised a co-publisher the root
//! had removed.
//!
//! Both need something the workspace cannot forge: a record on THIS machine. This
//! module is that record (`developer-anchors.json` in the profile directory):
//!
//! * **Contradiction.** Once this machine has seen an application's root, a
//!   later answer naming a DIFFERENT root is refused
//!   ([`CalpError::DeveloperAnchorContradicted`]), naming both keys.
//! * **Rollback.** The highest `publishers.json` revision this machine has seen
//!   is kept, and a lower one is refused
//!   ([`CalpError::PublisherListRolledBack`]).
//!
//! # Why a store of its own, not a TOFU pin
//!
//! A pin (`trusted-publishers.json`) is a SUBSCRIBER's standing decision to keep
//! accepting updates from one key, and it has exactly one writer, held by three
//! census tests. An anchor is not that decision: a developer opening an
//! application for editing never agreed to receive anything from it. Writing a
//! pin here would file a trust decision nobody made, and would give the pin store
//! a second writer. So the anchor has its own file, its own module and its own
//! policy enum -- and the pin censuses stay green unchanged, which is the proof
//! that the anchor is not a pin.
//!
//! # The honest limit
//!
//! It is trust-on-first-use: a machine whose FIRST checkout or publish of an
//! application happens after a fake first version was planted remembers the
//! planted root. Moving a workspace to a new location (a new scope) anchors
//! afresh. Forgetting an anchor is a deliberate hole behind a confirmation, and
//! the host audits every forget. Rollback of the list on the SUBSCRIBER side
//! (the TOFU delegate path) is not covered here.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::error::CalpError;
use crate::publishers::RootAnchoredPublishers;
use crate::workspace_id::WorkspaceScope;

/// The store's file name in the profile directory. Separate from
/// `trusted-publishers.json` on purpose (see the module header).
pub const DEVELOPER_ANCHORS_FILE: &str = "developer-anchors.json";

/// The only on-disk format this build reads.
const ANCHOR_FILE_VERSION: u64 = 1;

/// Where the developer anchors live. Public so a test can corrupt exactly the
/// file the loader reads.
pub fn developer_anchors_file_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(DEVELOPER_ANCHORS_FILE)
}

/// What recorded an anchor. Display only: every kind of record is checked the
/// same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnchoredBy {
    /// Opened for editing (Collaboration > Open Application for Editing).
    Checkout,
    /// Pushed to, or published as a new application, from this computer.
    Publish,
    /// The creator changed who may publish it from this computer.
    PublisherList,
}

impl AnchoredBy {
    /// Stable wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            AnchoredBy::Checkout => "checkout",
            AnchoredBy::Publish => "publish",
            AnchoredBy::PublisherList => "publisherList",
        }
    }
}

/// May this call CREATE an anchor on first contact?
///
/// A REQUIRED part of every [`AnchorGate`], with no `Default` and never an
/// `Option`, for the reason `PinPolicy` has none: a caller that does not decide
/// must not compile. Pick the variant that names what the USER just did.
///
/// Neither variant lets a caller LOWER or REPLACE anything: a contradiction and
/// a rollback refuse under both, and a higher list revision raises the mark
/// under both -- a monotonic raise is not a trust decision, and nobody can
/// forge a higher revision the root signed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorPolicy {
    /// The user opened the application for editing, pushed to it, published it
    /// or changed its co-publisher list: first contact records the root.
    RecordOnFirstContact { via: AnchoredBy },
    /// A read the user experiences as passive -- a preview, the push merge, the
    /// hold-back, the signed base a push compares against. First contact
    /// reports [`AnchorStatus::NotAnchored`] and writes nothing.
    CheckOnly,
}

/// Where to look, for which workspace, and whether first contact may record.
pub struct AnchorGate<'a> {
    pub profile_dir: &'a Path,
    /// The workspace the application was read from. An anchor is scoped to it,
    /// exactly as a pin is: the same name in two workspaces is two applications.
    pub scope: &'a WorkspaceScope,
    pub policy: AnchorPolicy,
}

/// One remembered application.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorRecord {
    /// `WorkspaceScope::id` -- normalized key material. NEVER displayed.
    pub scope: String,
    /// The workspace EXACTLY as the user configured it. The only form a UI, an
    /// error or an audit row may show.
    pub scope_label: String,
    /// The application name, as it was spelled when the anchor was recorded.
    pub application: String,
    /// The key that signed the application's first version (lowercase hex).
    pub root_key: String,
    /// The name that first version's signed manifest gives. Display only.
    pub root_name: String,
    /// The first version, as the workspace listed it then.
    pub root_version: String,
    /// The highest `publishers.json` revision this machine has seen for it; 0
    /// when it has never seen a list.
    pub publishers_revision: u64,
    /// RFC3339.
    pub anchored_at: String,
    pub anchored_by: AnchoredBy,
}

/// What [`anchor_root`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnchorStatus {
    /// Nothing was remembered, and this call RECORDED the root (only under
    /// [`AnchorPolicy::RecordOnFirstContact`]).
    FirstContact { recorded: AnchorRecord },
    /// The root is the one this machine remembers (the record as it stands
    /// after any raise of the revision mark).
    Matches { anchor: AnchorRecord },
    /// Nothing is remembered and nothing was recorded: a passive read
    /// ([`AnchorPolicy::CheckOnly`]).
    NotAnchored,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnchorFile {
    format_version: u64,
    anchors: Vec<AnchorRecord>,
}

/// Every read-modify-write of the store happens under this, so two Tauri
/// threads (a checkout and a preview raising the mark) cannot interleave and
/// lose one of the two writes.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// The OS lock file beside the store. The process mutex above serialises the
/// threads of ONE Calcula; nothing stops a user running two, and each would
/// read the store, change it and rename over it -- the second rename silently
/// losing the first's first-contact record or raised revision mark, after
/// which protection quietly falls back to trust on first use (or accepts a list
/// revision the lost mark would have refused). An exclusive lock on this file
/// is held across the whole read-modify-write, so two processes queue exactly
/// as two threads do.
pub const DEVELOPER_ANCHORS_LOCK_FILE: &str = "developer-anchors.lock";

/// Held for one read-modify-write of the store: the OS file lock (dropped --
/// and so released -- FIRST), then this process's mutex.
struct StoreGuard {
    _file: std::fs::File,
    _process: MutexGuard<'static, ()>,
}

fn lock_store(profile_dir: &Path) -> Result<StoreGuard, CalpError> {
    // The guarded data is `()`, so a poisoned lock protects nothing that could
    // be half-written: the FILE is replaced atomically below.
    let process = STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::fs::create_dir_all(profile_dir)?;
    let path = profile_dir.join(DEVELOPER_ANCHORS_LOCK_FILE);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| unreadable(&path, format!("its lock file cannot be opened: {e}")))?;
    // Blocks until no other process holds it. Released when `file` is closed.
    file.lock()
        .map_err(|e| unreadable(&path, format!("its lock file cannot be locked: {e}")))?;
    Ok(StoreGuard { _file: file, _process: process })
}

fn unreadable(path: &Path, reason: String) -> CalpError {
    CalpError::DeveloperAnchorStoreUnreadable {
        path: path.display().to_string(),
        reason,
    }
}

/// Read the store. FAILS CLOSED, like `signing::load_pins`: a file that does not
/// exist is an empty store (nothing has been remembered yet), but a file that
/// EXISTS and cannot be read, parsed or understood is an error -- "I cannot tell
/// what this machine remembers" must never read as "nothing is remembered",
/// because that is exactly the state in which a planted root would be accepted.
fn read_store(profile_dir: &Path) -> Result<Vec<AnchorRecord>, CalpError> {
    let path = developer_anchors_file_path(profile_dir);
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(unreadable(&path, e.to_string())),
    };
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| unreadable(&path, e.to_string()))?;
    let version = value.get("formatVersion").and_then(|v| v.as_u64()).unwrap_or(0);
    if version != ANCHOR_FILE_VERSION {
        return Err(unreadable(
            &path,
            format!("it declares formatVersion {version}, which this build does not understand"),
        ));
    }
    let file: AnchorFile =
        serde_json::from_value(value).map_err(|e| unreadable(&path, e.to_string()))?;
    Ok(file.anchors)
}

/// THE one writer of the store: the whole file, written to a temporary file
/// beside it and renamed over it, so a crash or a concurrent reader never sees
/// half a store (and a half store would fail closed and block every developer
/// door until repaired).
fn write_store(profile_dir: &Path, anchors: Vec<AnchorRecord>) -> Result<(), CalpError> {
    std::fs::create_dir_all(profile_dir)?;
    let path = developer_anchors_file_path(profile_dir);
    let tmp = profile_dir.join(format!("{DEVELOPER_ANCHORS_FILE}.{}.tmp", std::process::id()));
    let content = serde_json::to_string_pretty(&AnchorFile {
        format_version: ANCHOR_FILE_VERSION,
        anchors,
    })?;
    std::fs::write(&tmp, content)?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// The identity an application NAME has on the filesystems a workspace lives
/// on: every spelling that opens the SAME application folder maps to one value.
///
/// * CASE, for every letter -- NTFS and SMB resolve names without regard to
///   case for all of Unicode, not just ASCII, so `fÖrsäljning` IS the folder
///   `försäljning`. (Upper-cased, then lower-cased, so the folds that differ
///   between the two directions -- `ß`/`SS`, the Kelvin sign -- collapse too.)
/// * TRAILING DOTS AND SPACES, which Win32 strips from a path component, so
///   `sales.` and `sales ` open `sales`.
///
/// It can only ever over-match, and over-matching only REFUSES (see
/// [`same_application`]).
fn application_identity(name: &str) -> String {
    name.trim_end_matches(['.', ' '])
        .chars()
        .flat_map(char::to_uppercase)
        .flat_map(char::to_lowercase)
        .collect()
}

/// Records in `scope` that name `application` -- by [`application_identity`],
/// i.e. ignoring case in all of Unicode and Win32's trailing dots and spaces.
///
/// Loose on purpose, and it only ever points one way: it can REFUSE (a
/// contradiction, a rollback), never GRANT -- a `Matches` needs the exact name.
/// A workspace lists its applications by their on-disk folder names and opens
/// one by joining the name onto the workspace root, so anyone who can write to
/// the share can RENAME the folder to another spelling of the same name
/// (`fÖrsäljning`, `sales.`); without this, that rename would turn a
/// contradiction into an ordinary first contact (the same reasoning as
/// `PinStore::other_scopes_for_name`). ASCII-only folding used to leave exactly
/// that gap for every non-ASCII letter.
fn same_application<'a>(
    anchors: &'a [AnchorRecord],
    scope: &'a WorkspaceScope,
    application: &'a str,
) -> impl Iterator<Item = &'a AnchorRecord> + 'a {
    let identity = application_identity(application);
    anchors
        .iter()
        .filter(move |a| a.scope == scope.id && application_identity(&a.application) == identity)
}

/// Check `authority` -- the application's root and co-publisher list, as the
/// workspace proves them now -- against what this machine remembers, and
/// record it on first contact when the policy allows.
///
/// In order:
///
/// 1. **Contradiction.** Any remembered record for this workspace and this
///    application name (ignoring case) whose root is a different key refuses,
///    naming both keys.
/// 2. **Rollback.** A co-publisher list whose revision is LOWER than the
///    highest this machine has seen refuses. A missing list is not an error
///    (it authorises the root alone, which is narrower, never wider) and never
///    lowers the mark.
/// 3. **Match.** An exact record matches; a higher list revision raises its
///    mark under EITHER policy.
/// 4. **First contact.** Recorded only under `RecordOnFirstContact`;
///    `CheckOnly` returns `NotAnchored` and writes nothing.
pub fn anchor_root(
    gate: &AnchorGate,
    package: &str,
    authority: &RootAnchoredPublishers,
) -> Result<AnchorStatus, CalpError> {
    let _guard = lock_store(gate.profile_dir)?;
    let mut anchors = read_store(gate.profile_dir)?;

    // 1. CONTRADICTION. The first version of an application can never change,
    // so a different root is a planted first version or a re-created
    // application -- and only a person can tell which.
    if let Some(remembered) =
        same_application(&anchors, gate.scope, package).find(|a| a.root_key != authority.root_key)
    {
        return Err(CalpError::DeveloperAnchorContradicted {
            package: package.to_string(),
            scope: gate.scope.label.clone(),
            remembered_application: remembered.application.clone(),
            remembered_name: display_name(&remembered.root_name),
            remembered_fingerprint: crate::signing::key_fingerprint(&remembered.root_key),
            anchored_on: remembered.anchored_at.chars().take(10).collect(),
            claimed_root_version: authority.root_version.clone(),
            claimed_name: display_name(&authority.root_name),
            claimed_fingerprint: crate::signing::key_fingerprint(&authority.root_key),
        });
    }

    // 2. ROLLBACK, against the highest mark any record of this application
    // holds (a re-cased record can refuse too; it can never grant).
    let seen = same_application(&anchors, gate.scope, package)
        .map(|a| a.publishers_revision)
        .max()
        .unwrap_or(0);
    let served = authority.list.as_ref().map(|list| list.revision);
    if let Some(found) = served {
        if found < seen {
            return Err(CalpError::PublisherListRolledBack {
                package: package.to_string(),
                seen,
                found,
            });
        }
    }

    // 3. MATCH -- the exact name only.
    if let Some(index) = anchors
        .iter()
        .position(|a| a.scope == gate.scope.id && a.application == package)
    {
        if let Some(found) = served {
            if found > anchors[index].publishers_revision {
                // Monotonic, and unforgeable (a higher revision verified under
                // the root), so it is raised under EITHER policy: a passive read
                // that saw revision 5 must make revision 4 refuse from now on.
                anchors[index].publishers_revision = found;
                let raised = anchors[index].clone();
                write_store(gate.profile_dir, anchors)?;
                return Ok(AnchorStatus::Matches { anchor: raised });
            }
        }
        return Ok(AnchorStatus::Matches {
            anchor: anchors[index].clone(),
        });
    }

    // 4. FIRST CONTACT. Every arm that must not record RETURNS here, so the one
    // insert below is unreachable for it.
    let via = match gate.policy {
        AnchorPolicy::CheckOnly => {
            // A preview, a merge or the signed base a push compares against
            // never CREATES an anchor: only an act of the user may.
            return Ok(AnchorStatus::NotAnchored);
        }
        AnchorPolicy::RecordOnFirstContact { via } => via,
    };
    let recorded = AnchorRecord {
        scope: gate.scope.id.clone(),
        scope_label: gate.scope.label.clone(),
        application: package.to_string(),
        root_key: authority.root_key.clone(),
        root_name: authority.root_name.clone(),
        root_version: authority.root_version.clone(),
        publishers_revision: served.unwrap_or(0).max(seen),
        anchored_at: chrono::Utc::now().to_rfc3339(),
        anchored_by: via,
    };
    anchors.push(recorded.clone());
    write_store(gate.profile_dir, anchors)?;
    Ok(AnchorStatus::FirstContact { recorded })
}

fn display_name(name: &str) -> String {
    if name.trim().is_empty() {
        "an unnamed publisher".to_string()
    } else {
        name.to_string()
    }
}

/// Every anchor this machine holds, for the transparency surface that answers
/// "which applications do I develop, and who does this computer say created
/// them?". Fails closed like every other read.
pub fn list_anchors(profile_dir: &Path) -> Result<Vec<AnchorRecord>, CalpError> {
    let _guard = lock_store(profile_dir)?;
    read_store(profile_dir)
}

/// Forget what this machine remembers about `application` in `scope`, and
/// return the records removed (empty when there was nothing to forget, in
/// which case nothing is written).
///
/// A deliberate hole: after it, the next checkout or push records whatever root
/// the workspace then names. The host asks the user first, naming both keys, and
/// audits every forget.
///
/// It removes every record the contradiction check would match -- the name by
/// [`application_identity`] -- or the remedy would leave the re-cased record standing and
/// the next attempt would be refused again. A record whose workspace is matched
/// by the user's own spelling (`scope.label`) is included, so a workspace that
/// canonicalizes differently today (an offline share) can still be forgotten
/// from the location the user sees listed.
pub fn forget_anchor(
    profile_dir: &Path,
    scope: &WorkspaceScope,
    application: &str,
) -> Result<Vec<AnchorRecord>, CalpError> {
    let _guard = lock_store(profile_dir)?;
    let identity = application_identity(application);
    let anchors = read_store(profile_dir)?;
    let (removed, kept): (Vec<AnchorRecord>, Vec<AnchorRecord>) =
        anchors.into_iter().partition(|a| {
            (a.scope == scope.id || a.scope_label == scope.label)
                && application_identity(&a.application) == identity
        });
    if !removed.is_empty() {
        write_store(profile_dir, kept)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publishers::PublisherList;
    use tempfile::TempDir;

    const ALICE: &str = "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8";
    const MALLORY: &str = "9f8e7d6c5b4a39289f8e7d6c5b4a39289f8e7d6c5b4a39289f8e7d6c5b4a3928";

    fn scope(dir: &TempDir) -> WorkspaceScope {
        crate::workspace_id::workspace_scope(dir.path().to_str().unwrap()).unwrap()
    }

    fn authority(root: &str, name: &str, revision: Option<u64>) -> RootAnchoredPublishers {
        RootAnchoredPublishers {
            root_key: root.to_string(),
            root_name: name.to_string(),
            root_version: "1.0.0".to_string(),
            list: revision.map(|r| {
                let mut list = PublisherList::new("sales", root, "2026-09-30T00:00:00Z");
                list.revision = r;
                list
            }),
        }
    }

    fn record(prof: &Path, scope: &WorkspaceScope, root: &str, revision: Option<u64>) -> AnchorStatus {
        let gate = AnchorGate {
            profile_dir: prof,
            scope,
            policy: AnchorPolicy::RecordOnFirstContact { via: AnchoredBy::Checkout },
        };
        anchor_root(&gate, "sales", &authority(root, "Alice", revision)).unwrap()
    }

    fn check(
        prof: &Path,
        scope: &WorkspaceScope,
        package: &str,
        root: &str,
        revision: Option<u64>,
    ) -> Result<AnchorStatus, CalpError> {
        let gate = AnchorGate { profile_dir: prof, scope, policy: AnchorPolicy::CheckOnly };
        anchor_root(&gate, package, &authority(root, "Mallory", revision))
    }

    /// SABOTAGE: `return Ok(AnchorStatus::NotAnchored)` before the insert in the
    /// `RecordOnFirstContact` path.
    #[test]
    fn first_contact_under_record_writes_one_anchor() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        match record(prof.path(), &sc, ALICE, Some(3)) {
            AnchorStatus::FirstContact { recorded } => {
                assert_eq!(recorded.root_key, ALICE);
                assert_eq!(recorded.publishers_revision, 3);
                assert_eq!(recorded.anchored_by, AnchoredBy::Checkout);
                assert_eq!(recorded.scope_label, sc.label);
            }
            other => panic!("expected FirstContact, got {other:?}"),
        }
        let anchors = list_anchors(prof.path()).unwrap();
        assert_eq!(anchors.len(), 1, "{anchors:?}");
        // The second contact matches rather than recording again.
        match record(prof.path(), &sc, ALICE, Some(3)) {
            AnchorStatus::Matches { anchor } => assert_eq!(anchor.root_key, ALICE),
            other => panic!("expected Matches, got {other:?}"),
        }
        assert_eq!(list_anchors(prof.path()).unwrap().len(), 1);
    }

    /// SABOTAGE: let `CheckOnly` fall through to the insert.
    #[test]
    fn check_only_never_creates_an_anchor() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let status = check(prof.path(), &scope(&ws), "sales", ALICE, Some(2)).unwrap();
        assert_eq!(status, AnchorStatus::NotAnchored);
        assert!(
            !developer_anchors_file_path(prof.path()).exists(),
            "a passive read wrote the anchor store"
        );
    }

    /// THE PLANTED ROOT. SABOTAGE: skip the root compare in step 1.
    #[test]
    fn a_contradicting_root_is_refused_naming_both_fingerprints() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        record(prof.path(), &sc, ALICE, None);
        let err = check(prof.path(), &sc, "sales", MALLORY, None).unwrap_err();
        match &err {
            CalpError::DeveloperAnchorContradicted {
                remembered_fingerprint,
                claimed_fingerprint,
                remembered_name,
                claimed_name,
                ..
            } => {
                assert_eq!(remembered_fingerprint, &crate::signing::key_fingerprint(ALICE));
                assert_eq!(claimed_fingerprint, &crate::signing::key_fingerprint(MALLORY));
                assert_eq!(remembered_name, "Alice");
                assert_eq!(claimed_name, "Mallory");
            }
            other => panic!("expected DeveloperAnchorContradicted, got {other:?}"),
        }
        let msg = err.to_string();
        assert!(msg.contains(&crate::signing::key_fingerprint(ALICE)), "{msg}");
        assert!(msg.contains(&crate::signing::key_fingerprint(MALLORY)), "{msg}");
        // Under RecordOnFirstContact too: recording never replaces an anchor.
        let gate = AnchorGate {
            profile_dir: prof.path(),
            scope: &sc,
            policy: AnchorPolicy::RecordOnFirstContact { via: AnchoredBy::Publish },
        };
        assert!(matches!(
            anchor_root(&gate, "sales", &authority(MALLORY, "Mallory", None)),
            Err(CalpError::DeveloperAnchorContradicted { .. })
        ));
        assert_eq!(list_anchors(prof.path()).unwrap()[0].root_key, ALICE, "the anchor moved");
    }

    /// SABOTAGE: exact-case lookup in `same_application`.
    #[test]
    fn a_recased_application_name_cannot_dodge_its_anchor() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        record(prof.path(), &sc, ALICE, None);
        let err = check(prof.path(), &sc, "SALES", MALLORY, None).unwrap_err();
        assert!(matches!(err, CalpError::DeveloperAnchorContradicted { .. }), "got {err:?}");
        // ...but a re-cased name never GRANTS a match: the same root under the
        // other spelling is first contact for that spelling.
        assert_eq!(check(prof.path(), &sc, "SALES", ALICE, None).unwrap(), AnchorStatus::NotAnchored);
    }

    /// Another workspace serving the same name is another application.
    #[test]
    fn an_anchor_is_scoped_to_its_workspace() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        record(prof.path(), &scope(&ws), ALICE, None);
        assert_eq!(
            check(prof.path(), &scope(&other), "sales", MALLORY, None).unwrap(),
            AnchorStatus::NotAnchored
        );
    }

    /// SABOTAGE: drop the revision compare in step 2.
    #[test]
    fn a_lower_list_revision_is_refused_as_a_rollback() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        record(prof.path(), &sc, ALICE, Some(5));
        let err = check(prof.path(), &sc, "sales", ALICE, Some(4)).unwrap_err();
        match err {
            CalpError::PublisherListRolledBack { seen, found, .. } => {
                assert_eq!((seen, found), (5, 4));
            }
            other => panic!("expected PublisherListRolledBack, got {other:?}"),
        }
    }

    #[test]
    fn an_equal_revision_passes() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        record(prof.path(), &sc, ALICE, Some(5));
        assert!(matches!(
            check(prof.path(), &sc, "sales", ALICE, Some(5)).unwrap(),
            AnchorStatus::Matches { .. }
        ));
    }

    /// SABOTAGE: raise only under `RecordOnFirstContact`.
    #[test]
    fn a_higher_revision_raises_the_mark_under_check_only_too() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        record(prof.path(), &sc, ALICE, Some(2));
        match check(prof.path(), &sc, "sales", ALICE, Some(7)).unwrap() {
            AnchorStatus::Matches { anchor } => assert_eq!(anchor.publishers_revision, 7),
            other => panic!("expected Matches, got {other:?}"),
        }
        assert_eq!(list_anchors(prof.path()).unwrap()[0].publishers_revision, 7);
        // ...and the raised mark now refuses what it used to accept.
        assert!(matches!(
            check(prof.path(), &sc, "sales", ALICE, Some(6)),
            Err(CalpError::PublisherListRolledBack { seen: 7, found: 6, .. })
        ));
    }

    #[test]
    fn a_missing_list_neither_refuses_nor_lowers_the_mark() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        record(prof.path(), &sc, ALICE, Some(4));
        assert!(matches!(
            check(prof.path(), &sc, "sales", ALICE, None).unwrap(),
            AnchorStatus::Matches { .. }
        ));
        assert_eq!(list_anchors(prof.path()).unwrap()[0].publishers_revision, 4);
    }

    /// SABOTAGE: `unwrap_or_default()` on the read.
    #[test]
    fn an_unreadable_store_fails_closed() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        std::fs::write(developer_anchors_file_path(prof.path()), b"{ not json").unwrap();
        for policy in [
            AnchorPolicy::CheckOnly,
            AnchorPolicy::RecordOnFirstContact { via: AnchoredBy::Checkout },
        ] {
            let sc = scope(&ws);
            let gate = AnchorGate { profile_dir: prof.path(), scope: &sc, policy };
            let err = anchor_root(&gate, "sales", &authority(ALICE, "Alice", None)).unwrap_err();
            assert!(
                matches!(err, CalpError::DeveloperAnchorStoreUnreadable { .. }),
                "{policy:?} read an unreadable store as empty: {err:?}"
            );
        }
        assert!(list_anchors(prof.path()).is_err());
        assert_eq!(
            std::fs::read(developer_anchors_file_path(prof.path())).unwrap(),
            b"{ not json",
            "a refused read must not overwrite the store it could not read"
        );
    }

    #[test]
    fn an_unknown_format_version_fails_closed() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        std::fs::write(
            developer_anchors_file_path(prof.path()),
            br#"{"formatVersion": 2, "anchors": []}"#,
        )
        .unwrap();
        let err = check(prof.path(), &scope(&ws), "sales", ALICE, None).unwrap_err();
        match err {
            CalpError::DeveloperAnchorStoreUnreadable { reason, .. } => {
                assert!(reason.contains("formatVersion 2"), "{reason}");
            }
            other => panic!("expected DeveloperAnchorStoreUnreadable, got {other:?}"),
        }
    }

    #[test]
    fn the_store_is_replaced_atomically() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        record(prof.path(), &sc, ALICE, Some(1));
        check(prof.path(), &sc, "sales", ALICE, Some(2)).unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(prof.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files left behind: {leftovers:?}");
        let raw = std::fs::read_to_string(developer_anchors_file_path(prof.path())).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["formatVersion"], 1);
        assert_eq!(parsed["anchors"][0]["publishersRevision"], 2);
        assert_eq!(parsed["anchors"][0]["anchoredBy"], "checkout");
    }

    #[test]
    fn forgetting_removes_only_that_applications_records() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        let sc = scope(&ws);
        record(prof.path(), &sc, ALICE, None);
        record(prof.path(), &scope(&other), ALICE, None);
        let gate = AnchorGate {
            profile_dir: prof.path(),
            scope: &sc,
            policy: AnchorPolicy::RecordOnFirstContact { via: AnchoredBy::Publish },
        };
        anchor_root(&gate, "finance", &authority(ALICE, "Alice", None)).unwrap();

        let removed = forget_anchor(prof.path(), &sc, "SALES").unwrap();
        assert_eq!(removed.len(), 1, "{removed:?}");
        assert_eq!(removed[0].application, "sales");
        let left = list_anchors(prof.path()).unwrap();
        assert_eq!(left.len(), 2, "{left:?}");
        assert!(left.iter().any(|a| a.application == "finance"));
        assert!(left.iter().any(|a| a.application == "sales" && a.scope != sc.id));
        // After forgetting, the other root is first contact again.
        assert_eq!(check(prof.path(), &sc, "sales", MALLORY, None).unwrap(), AnchorStatus::NotAnchored);
        // Nothing to forget writes nothing and is not an error.
        assert!(forget_anchor(prof.path(), &sc, "nothing-here").unwrap().is_empty());
    }

    fn record_named(prof: &Path, scope: &WorkspaceScope, application: &str, root: &str) -> AnchorStatus {
        let gate = AnchorGate {
            profile_dir: prof,
            scope,
            policy: AnchorPolicy::RecordOnFirstContact { via: AnchoredBy::Checkout },
        };
        anchor_root(&gate, application, &authority(root, "Alice", None)).unwrap()
    }

    /// THE RENAMED FOLDER. A workspace lists its applications by their on-disk
    /// folder names, and NTFS / SMB open `fÖrsäljning` and `försäljning` -- and
    /// Win32 `sales.` and `sales` -- as the SAME folder. A share-writer who
    /// renames the folder to another spelling and plants a root must meet the
    /// anchor, not first contact. Still refuse-only: the same root under the
    /// other spelling is first contact for that spelling, never a match.
    ///
    /// SABOTAGE: `a.application.eq_ignore_ascii_case(application)` in
    /// `same_application` (the ASCII-only fold this replaced).
    #[test]
    fn a_unicode_recased_or_win32_aliased_name_cannot_dodge_its_anchor() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        record_named(prof.path(), &sc, "försäljning", ALICE);
        for alias in ["fÖrsäljning", "FÖRSÄLJNING", "försäljning.", "försäljning ", "FÖRSÄLJNING. ."] {
            let err = check(prof.path(), &sc, alias, MALLORY, None).unwrap_err();
            assert!(
                matches!(err, CalpError::DeveloperAnchorContradicted { .. }),
                "'{alias}' opens the same folder and dodged the anchor: {err:?}"
            );
        }
        // A different application is still a different application.
        assert_eq!(check(prof.path(), &sc, "försäljningar", MALLORY, None).unwrap(), AnchorStatus::NotAnchored);
        // Refuse-only: the same root under another spelling never MATCHES.
        assert_eq!(check(prof.path(), &sc, "fÖrsäljning", ALICE, None).unwrap(), AnchorStatus::NotAnchored);
        // ...and Forget finds the record by any spelling of the folder.
        assert_eq!(forget_anchor(prof.path(), &sc, "FÖRSÄLJNING.").unwrap().len(), 1);
        assert!(list_anchors(prof.path()).unwrap().is_empty());
    }

    /// Forget matches a record by the workspace AS THE USER SPELLED IT, so a
    /// workspace that canonicalizes differently today (an offline share) can
    /// still be forgotten from the location Code in This File lists.
    ///
    /// SABOTAGE: drop `|| a.scope_label == scope.label` from `forget_anchor`.
    #[test]
    fn forget_matches_a_record_by_the_workspace_as_the_user_spelled_it() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        write_store(
            prof.path(),
            vec![AnchorRecord {
                scope: "stale-canonical-id".to_string(),
                scope_label: sc.label.clone(),
                application: "sales".to_string(),
                root_key: ALICE.to_string(),
                root_name: "Alice".to_string(),
                root_version: "1.0.0".to_string(),
                publishers_revision: 0,
                anchored_at: "2026-09-30T00:00:00Z".to_string(),
                anchored_by: AnchoredBy::Checkout,
            }],
        )
        .unwrap();
        let removed = forget_anchor(prof.path(), &sc, "sales").unwrap();
        assert_eq!(removed.len(), 1, "a record under the user's own spelling was not forgotten");
        assert!(list_anchors(prof.path()).unwrap().is_empty());
    }

    /// Many first contacts at once lose no record: every read-modify-write is
    /// serialised, and each writes the whole file through one temporary name.
    ///
    /// SABOTAGE: make `lock_store` hand out a fresh mutex per call AND skip the
    /// file lock (the two serialisers together; either alone still queues).
    #[test]
    fn concurrent_first_contacts_lose_no_record() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        let mut expected = 0;
        for round in 0..4 {
            let handles: Vec<_> = (0..16)
                .map(|i| {
                    let prof = prof.path().to_path_buf();
                    let sc = sc.clone();
                    std::thread::spawn(move || {
                        let gate = AnchorGate {
                            profile_dir: &prof,
                            scope: &sc,
                            policy: AnchorPolicy::RecordOnFirstContact { via: AnchoredBy::Publish },
                        };
                        anchor_root(&gate, &format!("app-{round}-{i}"), &authority(ALICE, "Alice", None))
                            .map(|_| ())
                    })
                })
                .collect();
            for handle in handles {
                handle.join().expect("a thread panicked").expect("a first contact failed");
            }
            expected += 16;
        }
        assert_eq!(list_anchors(prof.path()).unwrap().len(), expected, "records were lost");
        let leftovers: Vec<String> = std::fs::read_dir(prof.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files left behind: {leftovers:?}");
    }

    /// ANOTHER CALCULA holds the store: a second process's lock is exactly an
    /// exclusive lock on the lock file through a handle of its own. While it is
    /// held, a first contact here must WAIT -- and land once it is released.
    ///
    /// SABOTAGE: drop the `file.lock()` call from `lock_store`.
    #[test]
    fn another_process_holding_the_store_lock_makes_a_write_wait() {
        let prof = TempDir::new().unwrap();
        let ws = TempDir::new().unwrap();
        let sc = scope(&ws);
        let other = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(prof.path().join(DEVELOPER_ANCHORS_LOCK_FILE))
            .unwrap();
        other.lock().unwrap();

        let writer = {
            let prof = prof.path().to_path_buf();
            let sc = sc.clone();
            std::thread::spawn(move || {
                let gate = AnchorGate {
                    profile_dir: &prof,
                    scope: &sc,
                    policy: AnchorPolicy::RecordOnFirstContact { via: AnchoredBy::Checkout },
                };
                anchor_root(&gate, "sales", &authority(ALICE, "Alice", None)).map(|_| ())
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert!(
            !developer_anchors_file_path(prof.path()).exists(),
            "the store was written while another process held its lock"
        );
        drop(other);
        writer.join().unwrap().expect("the write lands once the lock is released");
        assert_eq!(list_anchors(prof.path()).unwrap().len(), 1);
    }

    // -----------------------------------------------------------------------
    // Structural guard: one writer, and the insert follows the policy decision
    // -----------------------------------------------------------------------

    /// 1-based line numbers of the lines of `src` that CONTAIN `needle` as code
    /// rather than as commentary (line comments only -- the same scanner, and
    /// the same stated limit, as `integrity.rs`'s pin census).
    fn code_line_hits(src: &str, needle: &str) -> Vec<usize> {
        src.lines()
            .enumerate()
            .filter(|(_, line)| !line.trim_start().starts_with("//") && line.contains(needle))
            .map(|(i, _)| i + 1)
            .collect()
    }

    /// The store has ONE writer (`write_store`: one write of a temporary file,
    /// one rename), ONE insert, and the insert sits after the policy decision
    /// whose non-recording arm returns. `AnchorPolicy` has no `Default` and is
    /// never optional, and `authorize_signer` takes the gate as a required
    /// parameter -- so a new caller must decide, and cannot record by accident.
    ///
    /// SABOTAGE: remove the `return` from the `CheckOnly` arm (and let it fall
    /// through), or add a second `std::fs::write(`.
    #[test]
    fn developer_anchor_file_has_one_writer_and_the_insert_follows_the_policy_decision() {
        let src = include_str!("developer_anchor.rs");
        let production = src.split("#[cfg(test)]").next().unwrap();

        for needle in ["std::fs::write(", "std::fs::rename("] {
            let hits = code_line_hits(production, needle);
            assert_eq!(hits.len(), 1, "`{needle}` must appear exactly once, found at {hits:?}");
        }
        let writer = production.find("fn write_store(").expect("write_store moved or was renamed");
        let write_hit = production.find("std::fs::write(").unwrap();
        assert!(write_hit > writer, "the one file write must be inside write_store");

        let inserts = code_line_hits(production, "anchors.push(");
        assert_eq!(inserts.len(), 1, "exactly one insert, found at {inserts:?}");

        let decision_start = production
            .find("let via = match gate.policy {")
            .expect("the policy decision block moved or was renamed");
        let decision = production[decision_start..]
            .split("\n    };")
            .next()
            .expect("the policy decision block is not delimited as expected");
        assert!(code_line_hits(decision, "anchors.push(").is_empty(), "insert inside a policy arm");
        assert!(
            production.find("anchors.push(").unwrap() > decision_start,
            "the insert must come AFTER the policy decision"
        );
        let arm = decision
            .split("AnchorPolicy::CheckOnly => {")
            .nth(1)
            .expect("the CheckOnly arm must be spelled out, never swept into `_`");
        let body = arm.split("\n        }").next().unwrap_or(arm);
        assert!(body.contains("return "), "the CheckOnly arm must RETURN before the insert");
        assert!(!decision.contains("_ =>"), "no catch-all arm in the policy decision");

        assert!(!production.contains("impl Default for AnchorPolicy"));
        let derive = production
            .split("pub enum AnchorPolicy")
            .next()
            .unwrap()
            .lines()
            .rev()
            .find(|l| l.trim_start().starts_with("#[derive("))
            .expect("AnchorPolicy has a derive line");
        assert!(!derive.contains("Default"), "AnchorPolicy must never derive Default: {derive}");
        assert!(!production.contains("Option<AnchorPolicy>"), "AnchorPolicy must never be optional");

        let publishers = include_str!("publishers.rs");
        let publishers = publishers.split("#[cfg(test)]").next().unwrap();
        assert!(
            publishers.contains("    anchor: &AnchorGate,"),
            "authorize_signer must take the anchor gate as a REQUIRED parameter"
        );
        assert!(!publishers.contains("Option<&AnchorGate"), "the anchor gate must never be optional");
    }
}
