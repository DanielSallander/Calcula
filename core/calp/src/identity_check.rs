//! FILENAME: core/calp/src/identity_check.rs
//! PURPOSE: The READER'S verdict on WHO sent a writeback answer -- Verified,
//! signed but unconfirmed, not verified, or sent before sign-in -- and the
//! per-application rule "count only verified senders".
//! CONTEXT: Identity phase 1 (owner decisions 2026-10-22, open-items 2.am).
//!
//! The fold (`crate::fold`) decides, identically on every machine, whether an
//! answer is SIGNED by the key its sender id names (`crate::submission_seal`).
//! A signature proves "the holder of that key sent this"; it does not prove
//! that the Windows account the id names is the person who holds the key -- a
//! colleague can mint a key of their own and claim anybody's SID (they get a
//! DIFFERENT id, so they cannot shadow the real person's answers, but they can
//! answer AS that name). This module is the step after the fold that tries to
//! confirm the account:
//!
//! * **Verified** -- signed, AND Windows itself recorded the account the id
//!   names as the OWNER of the answer's file and of its sender folder, on
//!   storage where that record means something (an NTFS/ReFS share or disk,
//!   never a sync folder), AND nobody else may change that file. The owner
//!   records who CREATED a file, not who last wrote it: NTFS and SMB keep the
//!   owner when a file is moved within a volume or overwritten by another
//!   account. So an owner match proves the account wrote the answer only when
//!   the file's permissions let no other account (besides SYSTEM and
//!   Administrators) write, delete or re-own it -- otherwise anyone with the
//!   common inherited Modify right could move a file Alice created into their
//!   own folder and overwrite it with an answer of theirs. Where others can
//!   change the file the verdict is "signed, identity not confirmed (other
//!   accounts can change this answer's file)".
//! * **Signed, identity not confirmed** -- signed, but the owner record cannot
//!   say anything here. A Dropbox/OneDrive folder: the sync client writes every
//!   file as whoever runs it on the READING computer. A local (per-computer)
//!   account on a network share: the client authenticates to the server as a
//!   server-side account, so the file's owner is never the client's local SID.
//!   FAT/exFAT: no owners at all. An administrator as the owner: anyone
//!   elevated writes as BUILTIN\Administrators. These read "cannot be checked
//!   here" -- never a false "not verified".
//! * **Not verified** -- signed, the check was meaningful, and Windows says a
//!   DIFFERENT account wrote the file: "written by CORP\bob".
//! * **Sent before sign-in** -- an unsigned answer under an old random id.
//!
//! THIS IS NOT PART OF THE FOLD, on purpose (critique-identity item 3): it
//! depends on the READER -- which storage it sees, which owner lookups succeed
//! -- so two machines may label the same answer differently, and the fold must
//! not. It runs after the fold, and only decides what is LABELLED and what is
//! COUNTED when an application requires verified senders.
//!
//! Pure and platform-neutral: the app supplies the storage class and the owner
//! lookup (`app/src-tauri/src/identity_verification.rs`).

use serde::{Deserialize, Serialize};

use crate::identity_provider::{parse_signed_id, AccountScope, IdentityProviderKind, SubmitterIdentity};
use crate::submission_seal::SenderCheck;
use crate::writeback::WritebackSubmission;

/// The well-known SID of BUILTIN\Administrators. An elevated process (and an
/// administrator on the file server) writes files owned by this group, so it
/// can neither confirm nor refute a claimed account.
pub const ADMINISTRATORS_SID: &str = "S-1-5-32-544";

/// What kind of storage the READER sees the workspace on. A unit enum so it
/// crosses IPC as a camelCase string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageKind {
    /// Could not tell (an HTTP workspace, an unreadable volume).
    #[default]
    Unknown,
    /// A local NTFS/ReFS volume: Windows records who wrote each file.
    LocalDisk,
    /// A network share (UNC path or mapped drive) with owner records.
    NetworkShare,
    /// A Dropbox / OneDrive (or other cloud-files) sync folder: files are
    /// written by the sync client as the reading computer's user, so the owner
    /// record says nothing about who sent an answer.
    SyncFolder,
    /// A file system without owner records (FAT, exFAT).
    NoOwnerRecords,
}

impl StorageKind {
    /// The plain sentence a publisher reads about this storage.
    pub fn label(self) -> &'static str {
        match self {
            StorageKind::Unknown => "storage Calcula could not identify",
            StorageKind::LocalDisk => "a local disk",
            StorageKind::NetworkShare => "a network file share",
            StorageKind::SyncFolder => "a Dropbox or OneDrive sync folder",
            StorageKind::NoOwnerRecords => "a drive that does not record who wrote each file",
        }
    }

    /// Whether answers in a Windows-account application can EVER be verified
    /// on this storage (the publish-time warning).
    pub fn can_verify_windows_senders(self) -> bool {
        matches!(self, StorageKind::LocalDisk | StorageKind::NetworkShare)
    }
}

/// The reader's verdict on one answer's sender. A unit enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentityStatus {
    /// Never assessed. Fails closed: never counted where verification is
    /// required.
    #[default]
    NotChecked,
    /// Signed, and Windows recorded the named account as the file's writer.
    Verified,
    /// Signed by the key its id names, but who holds the key could not be
    /// confirmed on this storage.
    SignedUnconfirmed,
    /// Signed, but Windows says another account wrote it.
    NotVerified,
    /// Sent before sign-in existed (an old random id, no signature).
    BeforeSignIn,
}

/// Why the verdict is what it is. A unit enum (plain sentences in
/// [`IdentityReason::sentence`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentityReason {
    #[default]
    NotChecked,
    /// Verified: the file's owner is the account the answer names.
    OwnerMatches,
    /// Unconfirmed: a sync folder (Dropbox / OneDrive).
    SyncFolder,
    /// Unconfirmed: a per-computer account on a network share.
    LocalAccountOnShare,
    /// Unconfirmed: a per-computer account of ANOTHER computer, read on this
    /// computer's own disk (the file got here through a copy).
    AnotherComputersAccount,
    /// Unconfirmed: FAT/exFAT, no owner records.
    NoOwnerRecords,
    /// Unconfirmed: storage that could not be identified.
    UnknownStorage,
    /// Unconfirmed: the answer does not say where its account lives.
    UnknownAccountKind,
    /// Unconfirmed: the file is owned by BUILTIN\Administrators.
    WrittenByAdministrator,
    /// Unconfirmed: Windows would not say who owns the file.
    OwnerUnreadable,
    /// Unconfirmed: the owner matches, but other accounts may change the file
    /// (or its sender folder belongs to someone else), so the owner record
    /// does not prove who wrote what it holds.
    OthersCanChange,
    /// Unconfirmed: no file holding this answer was found to check.
    FileNotFound,
    /// Unconfirmed: a provider this version of Calcula cannot check.
    ProviderNotChecked,
    /// Not verified: another account wrote the file.
    OwnerMismatch,
    /// Sent before sign-in.
    BeforeSignIn,
}

impl IdentityReason {
    /// The plain sentence for this reason.
    pub fn sentence(self) -> &'static str {
        match self {
            IdentityReason::NotChecked => "not checked",
            IdentityReason::OwnerMatches => {
                "Windows recorded this account as the creator of the answer's file, and no other account can change it"
            }
            IdentityReason::SyncFolder => {
                "cannot be checked here: the workspace is a Dropbox or OneDrive folder, where every file \
                 is written by the sync program"
            }
            IdentityReason::LocalAccountOnShare => {
                "cannot be checked here: a computer's own (local) account is never recorded as the writer \
                 on a network share"
            }
            IdentityReason::AnotherComputersAccount => {
                "cannot be checked here: the account belongs to another computer"
            }
            IdentityReason::NoOwnerRecords => {
                "cannot be checked here: this drive does not record who wrote each file"
            }
            IdentityReason::UnknownStorage => "cannot be checked here: Calcula could not identify the storage",
            IdentityReason::UnknownAccountKind => "cannot be checked here: the answer does not say what kind of account sent it",
            IdentityReason::WrittenByAdministrator => {
                "cannot be checked here: the file was written by an administrator account"
            }
            IdentityReason::OwnerUnreadable => "cannot be checked here: Windows did not say who wrote the file",
            IdentityReason::OthersCanChange => {
                "cannot be checked here: other accounts can change this answer's file, so its recorded \
                 creator does not prove who wrote it"
            }
            IdentityReason::FileNotFound => "cannot be checked here: the answer's file was not found",
            IdentityReason::ProviderNotChecked => "cannot be checked by this version of Calcula",
            IdentityReason::OwnerMismatch => "another account wrote the answer",
            IdentityReason::BeforeSignIn => "sent before sign-in (not signed)",
        }
    }
}

/// The reader's verdict on one answer. Attached in memory after the fold
/// (`WritebackSubmission::identity`), never written to disk and never read
/// from it -- a file cannot claim to be verified.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityVerdict {
    pub status: IdentityStatus,
    pub reason: IdentityReason,
    /// The account Windows recorded as the file's writer (`CORP\bob`), when the
    /// verdict rests on it; empty otherwise.
    #[serde(default)]
    pub written_by: String,
}

impl IdentityVerdict {
    pub fn new(status: IdentityStatus, reason: IdentityReason) -> IdentityVerdict {
        IdentityVerdict { status, reason, written_by: String::new() }
    }

    pub fn is_not_checked(&self) -> bool {
        self.status == IdentityStatus::NotChecked
    }

    pub fn is_verified(&self) -> bool {
        self.status == IdentityStatus::Verified
    }

    /// The one line the Identity column shows, in plain words.
    pub fn label(&self) -> String {
        match self.status {
            IdentityStatus::NotChecked => "Not checked".to_string(),
            IdentityStatus::Verified => {
                if self.written_by.trim().is_empty() {
                    "Verified: Windows account, checked against the file's writer".to_string()
                } else {
                    format!("Verified: written by {} (Windows account)", self.written_by.trim())
                }
            }
            IdentityStatus::SignedUnconfirmed => {
                format!("Signed, identity not confirmed ({})", self.reason.sentence())
            }
            IdentityStatus::NotVerified => {
                if self.written_by.trim().is_empty() {
                    format!("Not verified: {}", self.reason.sentence())
                } else {
                    format!("Not verified: written by {}", self.written_by.trim())
                }
            }
            IdentityStatus::BeforeSignIn => "Sent before sign-in (not signed)".to_string(),
        }
    }
}

/// The per-application rule, in the SIGNED version manifest
/// (`VersionManifest::identity_policy`): which answers COUNT. Set by the
/// publisher at publish/push ("Count only answers from verified senders").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityPolicy {
    /// Count only VERIFIED answers in totals (GATHER), the respondent roster,
    /// the BI tables and what scripts read. Off by default for Windows-account
    /// applications (owner decision 2026-10-22): every answer is then counted
    /// and labelled.
    #[serde(default)]
    pub require_verified: bool,
}

impl IdentityPolicy {
    /// Whether an answer with this verdict counts under this policy. With the
    /// requirement on, only Verified counts -- a NotChecked answer (a reader
    /// that never assessed it) does not: fail closed.
    pub fn counts(&self, verdict: &IdentityVerdict) -> bool {
        !self.require_verified || verdict.is_verified()
    }

    /// The sentence for an answer this policy does not count.
    pub fn not_counted_sentence(&self) -> &'static str {
        "Not counted: this application counts only answers from verified senders"
    }
}

/// Keep only the answers `policy` counts. THE one filter every counting reader
/// (GATHER, the roster, the BI tables, scripts) applies after the verdicts are
/// attached; the publisher's inbox shows the others, marked not counted.
pub fn admit(rows: Vec<WritebackSubmission>, policy: &IdentityPolicy) -> Vec<WritebackSubmission> {
    if !policy.require_verified {
        return rows;
    }
    rows.into_iter().filter(|r| policy.counts(&r.identity)).collect()
}

/// What the reader's owner lookup found for an answer's file(s). Not an IPC
/// type (never serialized).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerFinding {
    /// Windows recorded this owner: its SID and the name it resolves to here.
    /// `others_can_change`: the file's permissions let another account (not
    /// SYSTEM, not Administrators) write, delete or re-own it, or its sender
    /// folder is owned by another account -- then the owner is not proof.
    Owner { sid: String, name: String, others_can_change: bool },
    /// Windows would not say (access denied, a dropped connection).
    Unreadable(String),
    /// No file holding the answer was found.
    NoFile,
}

/// The `MACHINE` part of a `MACHINE\user` principal.
fn principal_domain(principal: &str) -> &str {
    principal.split('\\').next().unwrap_or("")
}

/// Whether checking the file's owner MEANS anything for this sender on this
/// storage, read on `reader_computer`. `Err` carries the reason it cannot be
/// checked here (the verdict is then "signed, identity not confirmed").
///
/// * Sync folders and FAT/exFAT: never.
/// * A network share: only for domain and Entra-joined accounts. A local
///   account authenticates to the server as a SERVER-side account, so the
///   owner is never the client's own SID (critique-identity item 8).
/// * This computer's own disk: domain and Entra-joined accounts, and local
///   accounts OF THIS COMPUTER (several people on one machine). A local
///   account of another computer can only have arrived through a copy.
///
/// The scope and principal are the sender's own SIGNED claim. Claiming a scope
/// can only change whether the owner is LOOKED AT -- never make an answer
/// Verified without the owner record agreeing.
pub fn owner_check_applies(
    storage: StorageKind,
    who: &SubmitterIdentity,
    reader_computer: &str,
) -> Result<(), IdentityReason> {
    match storage {
        StorageKind::SyncFolder => Err(IdentityReason::SyncFolder),
        StorageKind::NoOwnerRecords => Err(IdentityReason::NoOwnerRecords),
        StorageKind::Unknown => Err(IdentityReason::UnknownStorage),
        StorageKind::NetworkShare => match who.scope {
            AccountScope::Domain | AccountScope::EntraJoined => Ok(()),
            AccountScope::LocalMachine => Err(IdentityReason::LocalAccountOnShare),
            AccountScope::Unknown => Err(IdentityReason::UnknownAccountKind),
        },
        StorageKind::LocalDisk => match who.scope {
            AccountScope::Domain | AccountScope::EntraJoined => Ok(()),
            AccountScope::LocalMachine => {
                let machine = principal_domain(&who.principal_name);
                if !reader_computer.trim().is_empty() && machine.eq_ignore_ascii_case(reader_computer.trim()) {
                    Ok(())
                } else {
                    Err(IdentityReason::AnotherComputersAccount)
                }
            }
            AccountScope::Unknown => Err(IdentityReason::UnknownAccountKind),
        },
    }
}

/// THE VERDICT for one answer that came out of the fold. `probe` is called only
/// when an owner check means something (`owner_check_applies`), so a reader on
/// a sync folder never pays for an owner lookup.
pub fn assess(
    sub: &WritebackSubmission,
    storage: StorageKind,
    reader_computer: &str,
    probe: impl FnOnce() -> OwnerFinding,
) -> IdentityVerdict {
    match sub.sender {
        SenderCheck::Unchecked => return IdentityVerdict::new(IdentityStatus::NotChecked, IdentityReason::NotChecked),
        SenderCheck::BeforeSignIn => {
            return IdentityVerdict::new(IdentityStatus::BeforeSignIn, IdentityReason::BeforeSignIn)
        }
        SenderCheck::Signed => {}
    }
    let unconfirmed = |reason| IdentityVerdict::new(IdentityStatus::SignedUnconfirmed, reason);
    let Some((kind, subject, _)) = parse_signed_id(&sub.submitter.id) else {
        // The fold only marks signed ids Signed; defensive.
        return unconfirmed(IdentityReason::ProviderNotChecked);
    };
    if kind != IdentityProviderKind::Windows {
        return unconfirmed(IdentityReason::ProviderNotChecked);
    }
    if let Err(reason) = owner_check_applies(storage, &sub.submitter, reader_computer) {
        return unconfirmed(reason);
    }
    match probe() {
        OwnerFinding::Owner { sid, name, others_can_change } => {
            if sid.eq_ignore_ascii_case(subject) && others_can_change {
                // Created by the claimed account, but anyone allowed to change
                // the file could have moved it here and overwritten it.
                IdentityVerdict {
                    status: IdentityStatus::SignedUnconfirmed,
                    reason: IdentityReason::OthersCanChange,
                    written_by: String::new(),
                }
            } else if sid.eq_ignore_ascii_case(subject) {
                IdentityVerdict {
                    status: IdentityStatus::Verified,
                    reason: IdentityReason::OwnerMatches,
                    written_by: name,
                }
            } else if sid.eq_ignore_ascii_case(ADMINISTRATORS_SID) {
                IdentityVerdict {
                    status: IdentityStatus::SignedUnconfirmed,
                    reason: IdentityReason::WrittenByAdministrator,
                    written_by: name,
                }
            } else {
                IdentityVerdict {
                    status: IdentityStatus::NotVerified,
                    reason: IdentityReason::OwnerMismatch,
                    written_by: if name.trim().is_empty() { sid } else { name },
                }
            }
        }
        OwnerFinding::Unreadable(_) => unconfirmed(IdentityReason::OwnerUnreadable),
        OwnerFinding::NoFile => unconfirmed(IdentityReason::FileNotFound),
    }
}

/// THE NAME AN ANSWER MAY BE MATCHED BY -- an expected respondent, a
/// masterData allowed editor -- after the reader's verdict (identity phase 1):
///
/// * **Verified**: the account Windows resolved for the file's creator. If the
///   sender's own claimed principal is a DIFFERENT account, the answer matches
///   NO name at all: a verified Mallory who signs as "CORP\alice" is neither
///   Alice nor (having lied about it) counted as Mallory.
/// * **Not verified**: no name -- Windows positively reports another writer, so
///   the claim is refuted; the answer still matches by its id.
/// * Otherwise (signed but unconfirmed, sent before sign-in): the sender's own
///   SIGNED claim, through [`crate::identity_provider::principal_matches`]
///   (which ignores the claim of an unsigned answer).
///
/// The one matcher the roster and the masterData editor gate use, so neither
/// can match by a name the reader has disproved.
pub fn answer_matches(entry: &str, sub: &WritebackSubmission) -> bool {
    crate::identity_provider::principal_matches(entry, &matching_identity(sub), sub.sender == SenderCheck::Signed)
}

/// The sender identity [`answer_matches`] matches against: the answer's own
/// identity with its principal name replaced by what the reader's verdict
/// allows (see there). For callers that keep one identity per sender.
pub fn matching_identity(sub: &WritebackSubmission) -> SubmitterIdentity {
    let mut who = sub.submitter.clone();
    match sub.identity.status {
        IdentityStatus::Verified => {
            let written = sub.identity.written_by.trim();
            let claimed = who.principal_name.trim();
            who.principal_name = if written.is_empty() || (!claimed.is_empty() && !claimed.eq_ignore_ascii_case(written)) {
                String::new()
            } else {
                written.to_string()
            };
        }
        IdentityStatus::NotVerified => who.principal_name = String::new(),
        _ => {}
    }
    who
}

/// The name an answer's sender is SHOWN as in a list of people (the roster's
/// "responded"): the display name, with the account Windows recorded when that
/// is not the account the sender claimed -- so a forged name never reads as the
/// real person.
pub fn shown_name(sub: &WritebackSubmission) -> String {
    let display = if sub.submitter.display_name.trim().is_empty() {
        sub.submitter.id.clone()
    } else {
        sub.submitter.display_name.clone()
    };
    let written = sub.identity.written_by.trim();
    let claimed = sub.submitter.principal_name.trim();
    let refuted = match sub.identity.status {
        IdentityStatus::Verified => !written.is_empty() && !claimed.is_empty() && !claimed.eq_ignore_ascii_case(written),
        IdentityStatus::NotVerified => !written.is_empty(),
        _ => false,
    };
    if refuted {
        format!("{display} (written by {written})")
    } else {
        display
    }
}

/// Counts of verdicts, for the Inspector and the pane's summary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityCounts {
    pub verified: usize,
    pub signed_unconfirmed: usize,
    pub not_verified: usize,
    pub before_sign_in: usize,
    pub not_checked: usize,
}

impl IdentityCounts {
    pub fn add(&mut self, verdict: &IdentityVerdict) {
        match verdict.status {
            IdentityStatus::Verified => self.verified += 1,
            IdentityStatus::SignedUnconfirmed => self.signed_unconfirmed += 1,
            IdentityStatus::NotVerified => self.not_verified += 1,
            IdentityStatus::BeforeSignIn => self.before_sign_in += 1,
            IdentityStatus::NotChecked => self.not_checked += 1,
        }
    }

    pub fn of<'a>(rows: impl IntoIterator<Item = &'a WritebackSubmission>) -> IdentityCounts {
        let mut counts = IdentityCounts::default();
        for r in rows {
            counts.add(&r.identity);
        }
        counts
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_provider::{identity_for, AccountFacts};
    use crate::writeback::{SubmissionState, SubmissionValue};

    const KEY: &str = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988";
    const ALICE: &str = "S-1-5-21-100-200-300-1001";
    const BOB: &str = "S-1-5-21-100-200-300-1002";

    fn who(scope: AccountScope, principal: &str) -> SubmitterIdentity {
        identity_for(
            IdentityProviderKind::Windows,
            &AccountFacts {
                subject: ALICE.to_string(),
                principal_name: principal.to_string(),
                display_name: "Alice".to_string(),
                scope,
            },
            KEY,
        )
        .unwrap()
    }

    fn answer(submitter: SubmitterIdentity, sender: SenderCheck) -> WritebackSubmission {
        WritebackSubmission {
            id: "e1".into(),
            region_id: "r".into(),
            cell_row: 0,
            cell_col: 0,
            cell_id: None,
            submitter,
            value: SubmissionValue::Number { value: 1.0 },
            state: SubmissionState::Submitted,
            created_at: "2026-10-22T10:00:00Z".into(),
            updated_at: "2026-10-22T10:00:00Z".into(),
            submitted_at: None,
            review_reason: None,
            reviewed_by: None,
            environment: String::new(),
            model_key: None,
            seal: None,
            sender,
            identity: IdentityVerdict::default(),
            extra: Default::default(),
        }
    }

    fn owner(sid: &str, name: &str) -> impl FnOnce() -> OwnerFinding {
        let (sid, name) = (sid.to_string(), name.to_string());
        move || OwnerFinding::Owner { sid, name, others_can_change: false }
    }

    /// An owner on a file OTHER accounts may change (the common inherited
    /// Modify right on a share).
    fn owner_on_a_shared_file(sid: &str, name: &str) -> impl FnOnce() -> OwnerFinding {
        let (sid, name) = (sid.to_string(), name.to_string());
        move || OwnerFinding::Owner { sid, name, others_can_change: true }
    }

    /// THE MOVED FILE. NTFS/SMB keep a file's owner when it is moved within a
    /// volume or overwritten by another account, so on a share where others
    /// may change the file, "owned by Alice" does not prove Alice wrote what it
    /// holds: Mallory could move a file Alice created into his own folder and
    /// overwrite it. Such an owner match is UNCONFIRMED, never Verified; a
    /// mismatch still refutes the claim.
    ///
    /// SABOTAGE: drop the `others_can_change` branch in `assess`.
    #[test]
    fn an_owner_match_on_a_file_others_can_change_is_not_verified() {
        let a = answer(who(AccountScope::Domain, "CORP\\alice"), SenderCheck::Signed);
        let v = assess(&a, StorageKind::NetworkShare, "PC1", owner_on_a_shared_file(ALICE, "CORP\\alice"));
        assert_eq!(v.status, IdentityStatus::SignedUnconfirmed);
        assert_eq!(v.reason, IdentityReason::OthersCanChange);
        assert!(v.label().contains("other accounts can change"), "{}", v.label());
        assert!(!policy_on().counts(&v), "the rule never counts it");
        let v = assess(&a, StorageKind::NetworkShare, "PC1", owner_on_a_shared_file(BOB, "CORP\\bob"));
        assert_eq!(v.status, IdentityStatus::NotVerified, "a different creator still refutes the claim");
    }

    fn policy_on() -> IdentityPolicy {
        IdentityPolicy { require_verified: true }
    }

    fn with_verdict(mut a: WritebackSubmission, status: IdentityStatus, written_by: &str) -> WritebackSubmission {
        a.identity = IdentityVerdict { status, reason: IdentityReason::NotChecked, written_by: written_by.to_string() };
        a
    }

    /// THE CLAIMED NAME NEVER WINS OVER WHAT THE READER PROVED. A Verified
    /// answer matches by the account Windows recorded -- and by no name at
    /// all when the sender claimed a different one; a Not-verified answer
    /// matches by no name (its id only); an unconfirmed one by its signed claim.
    ///
    /// SABOTAGE: return `principal_matches(entry, &sub.submitter, signed)`
    /// from `answer_matches` unchanged.
    #[test]
    fn answers_match_by_the_proven_account_never_a_refuted_claim() {
        let alice_claim = answer(who(AccountScope::Domain, "CORP\\alice"), SenderCheck::Signed);
        // Verified as Alice, claiming Alice: matches.
        let real = with_verdict(alice_claim.clone(), IdentityStatus::Verified, "CORP\\alice");
        assert!(answer_matches("corp\\alice", &real));
        // Verified as MALLORY, claiming Alice: matches neither.
        let mallory = with_verdict(alice_claim.clone(), IdentityStatus::Verified, "CORP\\mallory");
        assert!(!answer_matches("CORP\\alice", &mallory));
        assert!(!answer_matches("CORP\\mallory", &mallory));
        assert_eq!(shown_name(&mallory), "Alice (written by CORP\\mallory)");
        // Not verified (Windows names Bob): the claim is refuted.
        let refuted = with_verdict(alice_claim.clone(), IdentityStatus::NotVerified, "CORP\\bob");
        assert!(!answer_matches("CORP\\alice", &refuted));
        assert!(answer_matches(&refuted.submitter.id, &refuted), "the id still matches");
        assert_eq!(shown_name(&refuted), "Alice (written by CORP\\bob)");
        // Unconfirmed: the signed claim (nothing disproves it).
        let unconfirmed = with_verdict(alice_claim, IdentityStatus::SignedUnconfirmed, "");
        assert!(answer_matches("CORP\\alice", &unconfirmed));
        assert_eq!(shown_name(&unconfirmed), "Alice");
    }

    fn never() -> impl FnOnce() -> OwnerFinding {
        || panic!("the owner must not be probed here")
    }

    #[test]
    fn a_domain_answer_on_a_share_written_by_its_account_is_verified() {
        let a = answer(who(AccountScope::Domain, "CORP\\alice"), SenderCheck::Signed);
        let v = assess(&a, StorageKind::NetworkShare, "PC1", owner(ALICE, "CORP\\alice"));
        assert_eq!(v.status, IdentityStatus::Verified);
        assert_eq!(v.reason, IdentityReason::OwnerMatches);
        assert_eq!(v.written_by, "CORP\\alice");
        assert!(v.label().starts_with("Verified"));
    }

    /// THE FORGED NAME: Bob signs with his own key under Alice's SID (a valid
    /// signature, a different id), but Windows recorded Bob as the writer.
    #[test]
    fn a_file_written_by_another_account_is_not_verified_and_says_by_whom() {
        let a = answer(who(AccountScope::Domain, "CORP\\alice"), SenderCheck::Signed);
        let v = assess(&a, StorageKind::NetworkShare, "PC1", owner(BOB, "CORP\\bob"));
        assert_eq!(v.status, IdentityStatus::NotVerified);
        assert_eq!(v.reason, IdentityReason::OwnerMismatch);
        assert_eq!(v.label(), "Not verified: written by CORP\\bob");
        // An owner that does not resolve to a name is reported by SID.
        let v = assess(&a, StorageKind::NetworkShare, "PC1", owner(BOB, ""));
        assert_eq!(v.written_by, BOB);
    }

    /// Never a false "not verified": an administrator owner cannot refute.
    #[test]
    fn an_administrator_owner_is_unconfirmed_not_a_mismatch() {
        let a = answer(who(AccountScope::Domain, "CORP\\alice"), SenderCheck::Signed);
        let v = assess(&a, StorageKind::LocalDisk, "PC1", owner(ADMINISTRATORS_SID, "BUILTIN\\Administrators"));
        assert_eq!(v.status, IdentityStatus::SignedUnconfirmed);
        assert_eq!(v.reason, IdentityReason::WrittenByAdministrator);
    }

    /// A sync folder and a local account on a share CANNOT be checked: the
    /// owner is never even looked at, and the label says why.
    #[test]
    fn sync_folders_and_local_accounts_on_shares_cannot_be_checked_here() {
        let domain = answer(who(AccountScope::Domain, "CORP\\alice"), SenderCheck::Signed);
        let v = assess(&domain, StorageKind::SyncFolder, "PC1", never());
        assert_eq!((v.status, v.reason), (IdentityStatus::SignedUnconfirmed, IdentityReason::SyncFolder));
        assert!(v.label().contains("Dropbox or OneDrive"), "{}", v.label());

        let local = answer(who(AccountScope::LocalMachine, "PC2\\alice"), SenderCheck::Signed);
        let v = assess(&local, StorageKind::NetworkShare, "PC1", never());
        assert_eq!(v.reason, IdentityReason::LocalAccountOnShare);
        assert_eq!(v.status, IdentityStatus::SignedUnconfirmed);

        let v = assess(&domain, StorageKind::NoOwnerRecords, "PC1", never());
        assert_eq!(v.reason, IdentityReason::NoOwnerRecords);
        let v = assess(&domain, StorageKind::Unknown, "PC1", never());
        assert_eq!(v.reason, IdentityReason::UnknownStorage);
    }

    /// On this computer's own disk a LOCAL account of this computer is
    /// checkable (several people, one machine); another computer's is not.
    #[test]
    fn a_local_account_is_checkable_only_on_its_own_computers_disk() {
        let local = answer(who(AccountScope::LocalMachine, "Danne\\Salle"), SenderCheck::Signed);
        let v = assess(&local, StorageKind::LocalDisk, "DANNE", owner(ALICE, "Danne\\Salle"));
        assert_eq!(v.status, IdentityStatus::Verified);
        let v = assess(&local, StorageKind::LocalDisk, "OTHERPC", never());
        assert_eq!(v.reason, IdentityReason::AnotherComputersAccount);
        let v = assess(&local, StorageKind::LocalDisk, "", never());
        assert_eq!(v.reason, IdentityReason::AnotherComputersAccount);
    }

    #[test]
    fn unsigned_and_unchecked_answers_are_never_probed() {
        let old = answer(SubmitterIdentity { id: "01a087b6".into(), ..Default::default() }, SenderCheck::BeforeSignIn);
        let v = assess(&old, StorageKind::NetworkShare, "PC1", never());
        assert_eq!(v.status, IdentityStatus::BeforeSignIn);
        assert_eq!(v.label(), "Sent before sign-in (not signed)");
        let raw = answer(who(AccountScope::Domain, "CORP\\alice"), SenderCheck::Unchecked);
        assert_eq!(assess(&raw, StorageKind::NetworkShare, "PC1", never()).status, IdentityStatus::NotChecked);
    }

    #[test]
    fn an_unreadable_owner_or_a_missing_file_is_unconfirmed() {
        let a = answer(who(AccountScope::Domain, "CORP\\alice"), SenderCheck::Signed);
        let v = assess(&a, StorageKind::NetworkShare, "PC1", || OwnerFinding::Unreadable("denied".into()));
        assert_eq!(v.reason, IdentityReason::OwnerUnreadable);
        let v = assess(&a, StorageKind::NetworkShare, "PC1", || OwnerFinding::NoFile);
        assert_eq!(v.reason, IdentityReason::FileNotFound);
    }

    /// The policy: off counts everything; on counts ONLY Verified -- and an
    /// answer nobody assessed is not counted (fail closed).
    #[test]
    fn the_requirement_counts_only_verified_answers() {
        let off = IdentityPolicy::default();
        let on = IdentityPolicy { require_verified: true };
        let mut rows = Vec::new();
        for status in [
            IdentityStatus::Verified,
            IdentityStatus::SignedUnconfirmed,
            IdentityStatus::NotVerified,
            IdentityStatus::BeforeSignIn,
            IdentityStatus::NotChecked,
        ] {
            let mut r = answer(who(AccountScope::Domain, "CORP\\alice"), SenderCheck::Signed);
            r.identity = IdentityVerdict::new(status, IdentityReason::NotChecked);
            rows.push(r);
        }
        assert_eq!(admit(rows.clone(), &off).len(), 5);
        let kept = admit(rows.clone(), &on);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].identity.status, IdentityStatus::Verified);
        let counts = IdentityCounts::of(&rows);
        assert_eq!(
            counts,
            IdentityCounts { verified: 1, signed_unconfirmed: 1, not_verified: 1, before_sign_in: 1, not_checked: 1 }
        );
    }

    #[test]
    fn verdicts_and_policy_serialize_camel_case_and_never_reach_disk() {
        let v = IdentityVerdict {
            status: IdentityStatus::SignedUnconfirmed,
            reason: IdentityReason::LocalAccountOnShare,
            written_by: "x".into(),
        };
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j["status"], "signedUnconfirmed");
        assert_eq!(j["reason"], "localAccountOnShare");
        assert_eq!(j["writtenBy"], "x");
        assert_eq!(serde_json::to_value(StorageKind::SyncFolder).unwrap(), "syncFolder");
        let p = serde_json::to_value(IdentityPolicy { require_verified: true }).unwrap();
        assert_eq!(p["requireVerified"], true);
        let c = serde_json::to_value(IdentityCounts::default()).unwrap();
        assert!(c.get("signedUnconfirmed").is_some() && c.get("beforeSignIn").is_some());

        // A file that claims a verdict is read WITHOUT it.
        let mut a = answer(who(AccountScope::Domain, "CORP\\alice"), SenderCheck::Signed);
        a.identity = IdentityVerdict::new(IdentityStatus::Verified, IdentityReason::OwnerMatches);
        let mut json = serde_json::to_value(&a).unwrap();
        json["identity"] = serde_json::json!({"status": "verified", "reason": "ownerMatches"});
        let back: WritebackSubmission = serde_json::from_value(json).unwrap();
        assert_eq!(back.identity.status, IdentityStatus::NotChecked);
    }
}
