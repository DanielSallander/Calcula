//! FILENAME: core/calp/src/submission_seal.rs
//! PURPOSE: Signatures on writeback answers and on the publisher's approve /
//! reject decisions, and the pure checks every reader runs on them.
//! CONTEXT: Owner decision 2026-10-22, phase 1 (open-items 2.am).
//!
//! ANSWERS. Every answer is signed by its sender's own key (kept in the Windows
//! Credential Manager on the sender's computer, never crossing IPC) over a
//! FIXED-ORDER, length-prefixed payload -- not re-serialised JSON, whose
//! `extra` map has no stable order. The payload covers the application and
//! version (a copy into another application or version folder no longer
//! verifies: no replay), the environment, the cell or model key, the value, the
//! three timestamps, the WHOLE sender identity (id, display name, principal
//! name, provider, scope), the key itself and the ORIGIN (typed by the user,
//! sent on save by an `immediate` region, or sent by a script). The sender id
//! commits to the key (`crate::identity_provider::submitter_id_for`), so a
//! valid signature under an id means "the holder of THAT id's key sent this".
//!
//! What a signature proves, worded the way the UI words it: this user's
//! Calcula sent the answer, from the origin it names. It does not prove that a
//! person typed it (a script the user approved can send), and in phase 1 it
//! does not prove the NAME (see `identity_provider`).
//!
//! REVIEWS. An approve / reject / re-open decision is signed with the
//! application's publisher key or a co-publisher key from the root-signed list
//! (`crate::publishers::review_keys`, the same set `require_publisher_key`
//! accepts). The payload binds the decision to the DIGEST of the exact answer
//! it decided, so a re-saved answer under the same id is not covered by an
//! approval of the old value. An unsigned review, or one signed by any other
//! key, is IGNORED by the fold -- before this, anybody who could write the
//! workspace could approve their own answers into an `on_approval` total.
//!
//! Everything here is pure and offline: every reader on every machine reaches
//! the same verdict, which is what lets the fold use it (fold.rs).

use std::collections::BTreeSet;

use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

use crate::identity_provider::{is_signed_id, key_commitment, parse_signed_id};
use crate::signing::PublisherKeypair;
use crate::writeback::{ReviewEvent, SubmissionState, SubmissionValue, WritebackSubmission};

const EVENT_DOMAIN: &[u8] = b"calcula-writeback-event-v1\0";
const REVIEW_DOMAIN: &[u8] = b"calcula-writeback-review-v1\0";

/// How an answer left the sender's computer. Signed, so it cannot be changed
/// afterwards; shown beside the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmissionOrigin {
    /// The user pressed Submit (or Submit All).
    #[default]
    Interactive,
    /// The region sends on save (`immediate`): the user typed the value.
    Immediate,
    /// A script with the `distribution.writeback` capability sent it.
    Script,
}

impl SubmissionOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            SubmissionOrigin::Interactive => "interactive",
            SubmissionOrigin::Immediate => "immediate",
            SubmissionOrigin::Script => "script",
        }
    }
}

/// The sender's signature on an answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionSeal {
    /// Hex of the sender's Ed25519 public key. The sender id commits to it.
    pub public_key: String,
    pub origin: SubmissionOrigin,
    /// Hex of the detached Ed25519 signature over [`event_payload`].
    pub signature: String,
}

/// The publisher's (or a co-publisher's) signature on a review decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSeal {
    pub public_key: String,
    pub signature: String,
    /// HOW the decision was made: `Interactive` (the publisher pressed Approve
    /// or Reject) or `Script` (an approved script holding the capability
    /// decided). Inside the signature whenever it is not `Interactive`, so a
    /// script's approval can never be passed off as a person's, nor a
    /// person's relabelled. Absent on disk = `Interactive`.
    #[serde(default, skip_serializing_if = "is_interactive")]
    pub origin: SubmissionOrigin,
}

fn is_interactive(origin: &SubmissionOrigin) -> bool {
    *origin == SubmissionOrigin::Interactive
}

/// What every reader concludes about one answer. A UNIT enum so it crosses IPC
/// as a plain camelCase string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SenderCheck {
    /// Not checked: a draft, or a record that never went through the fold.
    #[default]
    Unchecked,
    /// Signed by the key its sender id names.
    Signed,
    /// Sent before sign-in existed (an old random id, no signature). Shown,
    /// labelled, never counted where a signature is required.
    BeforeSignIn,
}

impl SenderCheck {
    pub fn is_unchecked(&self) -> bool {
        matches!(self, SenderCheck::Unchecked)
    }
    /// The plain sentence the publisher reads.
    pub fn label(self) -> &'static str {
        match self {
            SenderCheck::Unchecked => "Not checked",
            SenderCheck::Signed => "Signed by the sender's key",
            SenderCheck::BeforeSignIn => "Sent before sign-in",
        }
    }
}

/// Why an answer is refused as forged. The fold drops it from the current
/// state (it never competes, never counts) and reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForgeryReason {
    /// A signed-identity id with no signature: someone wrote a file under a
    /// signed sender's folder by hand.
    Unsigned,
    /// The signature's key is not the key the sender id commits to (or a
    /// signature on an old-format id).
    KeyNotTheSenders,
    /// The id's provider and the identity's provider disagree.
    ProviderMismatch,
    /// The signature does not verify: a field was changed after signing, or
    /// the file was copied into another application, version or environment.
    BadSignature,
}

impl ForgeryReason {
    pub fn label(self) -> &'static str {
        match self {
            ForgeryReason::Unsigned => "unsigned, under a signed sender's id",
            ForgeryReason::KeyNotTheSenders => "signed by a key that is not the sender's",
            ForgeryReason::ProviderMismatch => "the identity does not match its id",
            ForgeryReason::BadSignature => {
                "the signature does not match the answer (changed or copied after it was sent)"
            }
        }
    }
}

/// Why a review decision is ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewRefusal {
    Unsigned,
    /// Signed, but not by the publisher or an authorised co-publisher.
    SignerNotAuthorised,
    BadSignature,
}

impl ReviewRefusal {
    pub fn label(self) -> &'static str {
        match self {
            ReviewRefusal::Unsigned => "not signed",
            ReviewRefusal::SignerNotAuthorised => {
                "signed by a key that is not the publisher's or an authorised co-publisher's"
            }
            ReviewRefusal::BadSignature => "the signature does not match the decision",
        }
    }
}

/// The keys whose review decisions count for an application: the verified
/// publisher key and the root-signed co-publishers
/// (`crate::publishers::review_keys`). Empty = no decision counts (fail closed).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReviewAuthority {
    keys: BTreeSet<String>,
}

impl ReviewAuthority {
    /// No authority: every review is ignored. The default of every read that
    /// has no verified publisher key in hand.
    pub fn none() -> ReviewAuthority {
        ReviewAuthority::default()
    }

    pub fn from_keys<I, S>(keys: I) -> ReviewAuthority
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        ReviewAuthority {
            keys: keys
                .into_iter()
                .map(|k| k.as_ref().trim().to_lowercase())
                .filter(|k| !k.is_empty())
                .collect(),
        }
    }

    pub fn admits_key(&self, key: &str) -> bool {
        self.keys.contains(&key.trim().to_lowercase())
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.keys.iter()
    }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

fn put(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(bytes);
}

fn put_opt(out: &mut Vec<u8>, value: Option<&str>) {
    match value {
        None => put(out, b"0"),
        Some(v) => {
            put(out, b"1");
            put(out, v.as_bytes());
        }
    }
}

fn value_text(value: &SubmissionValue) -> String {
    match value {
        // The exact bits, so 0.1 cannot be re-rendered into a different number.
        SubmissionValue::Number { value } => format!("n:{:016x}", value.to_bits()),
        SubmissionValue::Text { value } => format!("t:{value}"),
        SubmissionValue::Boolean { value } => format!("b:{}", if *value { 1 } else { 0 }),
        SubmissionValue::Empty => "e:".to_string(),
    }
}

fn provider_text(kind: crate::identity_provider::IdentityProviderKind) -> &'static str {
    match kind {
        crate::identity_provider::IdentityProviderKind::Legacy => "legacy",
        crate::identity_provider::IdentityProviderKind::Windows => "windows",
        crate::identity_provider::IdentityProviderKind::Entra => "entra",
    }
}

fn scope_text(scope: crate::identity_provider::AccountScope) -> &'static str {
    match scope {
        crate::identity_provider::AccountScope::Unknown => "unknown",
        crate::identity_provider::AccountScope::LocalMachine => "localMachine",
        crate::identity_provider::AccountScope::Domain => "domain",
        crate::identity_provider::AccountScope::EntraJoined => "entraJoined",
    }
}

fn state_text(state: &SubmissionState) -> &'static str {
    match state {
        SubmissionState::Draft => "draft",
        SubmissionState::Submitted => "submitted",
        SubmissionState::Approved => "approved",
        SubmissionState::Rejected => "rejected",
    }
}

/// The exact bytes an answer's signature covers. `public_key` and `origin` are
/// the seal's own (empty for an unsigned answer, which is what its digest uses).
pub fn event_payload(
    package: &str,
    version: &str,
    sub: &WritebackSubmission,
    public_key: &str,
    origin: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(512);
    out.extend_from_slice(EVENT_DOMAIN);
    put(&mut out, package.as_bytes());
    put(&mut out, version.as_bytes());
    put(&mut out, sub.environment.as_bytes());
    put(&mut out, sub.id.as_bytes());
    put(&mut out, sub.region_id.as_bytes());
    put(&mut out, sub.cell_row.to_string().as_bytes());
    put(&mut out, sub.cell_col.to_string().as_bytes());
    put_opt(&mut out, sub.cell_id.as_deref());
    match &sub.model_key {
        None => put(&mut out, b"-"),
        Some(key) => {
            put(&mut out, key.len().to_string().as_bytes());
            for part in key {
                put(&mut out, part.as_bytes());
            }
        }
    }
    put(&mut out, value_text(&sub.value).as_bytes());
    put(&mut out, sub.created_at.as_bytes());
    put(&mut out, sub.updated_at.as_bytes());
    put_opt(&mut out, sub.submitted_at.as_deref());
    put(&mut out, sub.submitter.id.as_bytes());
    put(&mut out, sub.submitter.display_name.as_bytes());
    put(&mut out, sub.submitter.principal_name.as_bytes());
    put(&mut out, provider_text(sub.submitter.provider).as_bytes());
    put(&mut out, scope_text(sub.submitter.scope).as_bytes());
    put(&mut out, public_key.trim().to_lowercase().as_bytes());
    put(&mut out, origin.as_bytes());
    out
}

/// The digest a review decision binds to: SHA-256 of the answer's payload with
/// its own seal's key and origin. Stable for an unchanged answer, different the
/// moment any covered field changes.
pub fn event_digest(package: &str, version: &str, sub: &WritebackSubmission) -> String {
    let (key, origin) = match &sub.seal {
        Some(seal) => (seal.public_key.as_str(), seal.origin.as_str()),
        None => ("", ""),
    };
    crate::integrity::sha256_hex(&event_payload(package, version, sub, key, origin))
}

/// The exact bytes a review's signature covers. `origin` is appended only when
/// it is not `Interactive` -- the bytes of an interactive decision are the
/// ones every reader already verifies, and a non-interactive one can neither
/// drop nor change its origin without breaking the signature.
pub fn review_payload(
    package: &str,
    version: &str,
    review: &ReviewEvent,
    public_key: &str,
    origin: SubmissionOrigin,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(REVIEW_DOMAIN);
    put(&mut out, package.as_bytes());
    put(&mut out, version.as_bytes());
    put(&mut out, review.id.as_bytes());
    put(&mut out, review.target_submission_id.as_bytes());
    put(&mut out, review.target_digest.as_bytes());
    put(&mut out, review.region_id.as_bytes());
    put(&mut out, review.submitter_id.as_bytes());
    put(&mut out, state_text(&review.new_state).as_bytes());
    put_opt(&mut out, review.review_reason.as_deref());
    put_opt(&mut out, review.reviewed_by.as_deref());
    put(&mut out, review.reviewed_at.as_bytes());
    put(&mut out, public_key.trim().to_lowercase().as_bytes());
    if origin != SubmissionOrigin::Interactive {
        put(&mut out, b"origin");
        put(&mut out, origin.as_str().as_bytes());
    }
    out
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The hex public key of a 32-byte signing seed.
pub fn public_key_of_seed(seed: &[u8; 32]) -> String {
    to_hex(SigningKey::from_bytes(seed).verifying_key().as_bytes())
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/// Sign an answer with the sender's 32-byte key seed, at the one point where it
/// leaves the machine. Refuses an answer whose sender id does not commit to
/// THIS key: the app never signs as anybody but the key holder.
pub fn seal_submission(
    sub: &mut WritebackSubmission,
    package: &str,
    version: &str,
    seed: &[u8; 32],
    origin: SubmissionOrigin,
) -> Result<(), String> {
    let signing = SigningKey::from_bytes(seed);
    let public_key = to_hex(signing.verifying_key().as_bytes());
    match parse_signed_id(&sub.submitter.id) {
        Some((kind, _, commitment))
            if commitment == key_commitment(&public_key) && kind == sub.submitter.provider => {}
        _ => {
            return Err(format!(
                "Refusing to sign: the answer is attributed to '{}', which is not this computer's \
                 signed identity.",
                sub.submitter.id
            ))
        }
    }
    let payload = event_payload(package, version, sub, &public_key, origin.as_str());
    let signature = to_hex(&signing.sign(&payload).to_bytes());
    sub.seal = Some(SubmissionSeal { public_key, origin, signature });
    Ok(())
}

/// Sign a review decision with the publisher's (or co-publisher's) keypair,
/// binding it to the digest of the exact answer decided. An interactive
/// decision; see [`seal_review_with_origin`].
pub fn seal_review(
    review: &mut ReviewEvent,
    target: &WritebackSubmission,
    package: &str,
    version: &str,
    keypair: &PublisherKeypair,
) {
    seal_review_with_origin(review, target, package, version, keypair, SubmissionOrigin::Interactive)
}

/// [`seal_review`] naming HOW the decision was made (`Script` for the script
/// gateway), inside the signature.
pub fn seal_review_with_origin(
    review: &mut ReviewEvent,
    target: &WritebackSubmission,
    package: &str,
    version: &str,
    keypair: &PublisherKeypair,
    origin: SubmissionOrigin,
) {
    review.target_digest = event_digest(package, version, target);
    let public_key = keypair.public_key_hex();
    let payload = review_payload(package, version, review, &public_key, origin);
    let signature = keypair.sign(&payload);
    review.seal = Some(ReviewSeal { public_key, signature, origin });
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

/// What every reader concludes about an answer read from
/// `{package}/{version}/submissions/`: signed, sent before sign-in, or forged.
/// For a version from before answers were signed; see [`check_submission_in`].
pub fn check_submission(
    sub: &WritebackSubmission,
    package: &str,
    version: &str,
) -> Result<SenderCheck, ForgeryReason> {
    check_submission_in(sub, package, version, false)
}

/// [`check_submission`] in a version whose signed manifest says every answer
/// is signed (`signatures_required`): there an unsigned answer is FORGED
/// whatever its id looks like, never "sent before sign-in".
pub fn check_submission_in(
    sub: &WritebackSubmission,
    package: &str,
    version: &str,
    signatures_required: bool,
) -> Result<SenderCheck, ForgeryReason> {
    let Some(seal) = &sub.seal else {
        return if signatures_required || is_signed_id(&sub.submitter.id) {
            Err(ForgeryReason::Unsigned)
        } else {
            Ok(SenderCheck::BeforeSignIn)
        };
    };
    let Some((kind, _subject, commitment)) = parse_signed_id(&sub.submitter.id) else {
        return Err(ForgeryReason::KeyNotTheSenders);
    };
    if commitment != key_commitment(&seal.public_key) {
        return Err(ForgeryReason::KeyNotTheSenders);
    }
    if kind != sub.submitter.provider {
        return Err(ForgeryReason::ProviderMismatch);
    }
    let payload = event_payload(package, version, sub, &seal.public_key, seal.origin.as_str());
    crate::signing::verify_signature(&seal.public_key, &payload, &seal.signature, package, version)
        .map_err(|_| ForgeryReason::BadSignature)?;
    Ok(SenderCheck::Signed)
}

/// Whether a review decision counts: signed, by an authorised key, over its
/// own content.
pub fn check_review(
    review: &ReviewEvent,
    package: &str,
    version: &str,
    authority: &ReviewAuthority,
) -> Result<(), ReviewRefusal> {
    let Some(seal) = &review.seal else {
        return Err(ReviewRefusal::Unsigned);
    };
    if !authority.admits_key(&seal.public_key) {
        return Err(ReviewRefusal::SignerNotAuthorised);
    }
    let payload = review_payload(package, version, review, &seal.public_key, seal.origin);
    crate::signing::verify_signature(&seal.public_key, &payload, &seal.signature, package, version)
        .map_err(|_| ReviewRefusal::BadSignature)
}

/// THE ONE "is this record mine?" predicate -- seeding cells from what I last
/// sent, `own_only` visibility, and the reconcile report all ask exactly this.
/// Mine = my id (never blank) AND signed by the key that id names. A record
/// planted under my id without my key is never mine.
pub fn is_mine(own: Option<&crate::identity_provider::SubmitterIdentity>, record: &WritebackSubmission) -> bool {
    match own {
        Some(o) if !o.id.trim().is_empty() => {
            o.id == record.submitter.id && record.sender == SenderCheck::Signed
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_provider::{identity_for, AccountFacts, AccountScope, IdentityProviderKind};

    pub(crate) const SEED: [u8; 32] = [7u8; 32];
    const OTHER_SEED: [u8; 32] = [9u8; 32];

    pub(crate) fn signed_identity(seed: &[u8; 32], sid: &str, principal: &str) -> crate::SubmitterIdentity {
        identity_for(
            IdentityProviderKind::Windows,
            &AccountFacts {
                subject: sid.to_string(),
                principal_name: principal.to_string(),
                display_name: principal.to_string(),
                scope: AccountScope::Domain,
            },
            &public_key_of_seed(seed),
        )
        .unwrap()
    }

    fn answer(who: crate::SubmitterIdentity) -> WritebackSubmission {
        WritebackSubmission {
            id: "0190aaaa-0000-7000-8000-000000000001".to_string(),
            region_id: "budget".to_string(),
            cell_row: 3,
            cell_col: 1,
            cell_id: Some("c1".to_string()),
            submitter: who,
            value: SubmissionValue::Number { value: 120.5 },
            state: SubmissionState::Submitted,
            created_at: "2026-10-22T10:00:00Z".to_string(),
            updated_at: "2026-10-22T10:00:00Z".to_string(),
            submitted_at: Some("2026-10-22T10:00:00Z".to_string()),
            review_reason: None,
            reviewed_by: None,
            environment: "prod".to_string(),
            model_key: None,
            seal: None,
            sender: SenderCheck::Unchecked,
            identity: Default::default(),
            extra: Default::default(),
        }
    }

    fn sealed() -> WritebackSubmission {
        let mut s = answer(signed_identity(&SEED, "S-1-5-21-1-2-3-1001", "CORP\\alice"));
        seal_submission(&mut s, "app", "1.0.0", &SEED, SubmissionOrigin::Interactive).unwrap();
        s
    }

    #[test]
    fn a_sealed_answer_checks_as_signed() {
        assert_eq!(check_submission(&sealed(), "app", "1.0.0"), Ok(SenderCheck::Signed));
    }

    /// Every covered field breaks the seal when it changes -- including EACH
    /// part of the identity, so a name cannot be rewritten in place.
    #[test]
    fn changing_any_signed_field_breaks_the_seal() {
        type Edit = fn(&mut WritebackSubmission);
        let edits: Vec<(&str, Edit)> = vec![
            ("value", |s| s.value = SubmissionValue::Number { value: 999.0 }),
            ("environment", |s| s.environment = "test".into()),
            ("region", |s| s.region_id = "other".into()),
            ("row", |s| s.cell_row = 4),
            ("col", |s| s.cell_col = 2),
            ("cell id", |s| s.cell_id = None),
            ("model key", |s| s.model_key = Some(vec!["7".into()])),
            ("created", |s| s.created_at = "2020-01-01T00:00:00Z".into()),
            ("updated", |s| s.updated_at = "2030-01-01T00:00:00Z".into()),
            ("submitted", |s| s.submitted_at = Some("2020-01-01T00:00:00Z".into())),
            ("event id", |s| s.id = "0190aaaa-0000-7000-8000-000000000002".into()),
            ("display name", |s| s.submitter.display_name = "Alice Admin".into()),
            ("principal", |s| s.submitter.principal_name = "CORP\\bob".into()),
            ("scope", |s| s.submitter.scope = AccountScope::LocalMachine),
            ("origin", |s| s.seal.as_mut().unwrap().origin = SubmissionOrigin::Script),
        ];
        for (what, edit) in edits {
            let mut s = sealed();
            edit(&mut s);
            assert_eq!(
                check_submission(&s, "app", "1.0.0"),
                Err(ForgeryReason::BadSignature),
                "changing the {what} must break the seal"
            );
        }
    }

    #[test]
    fn a_copy_into_another_application_or_version_does_not_verify() {
        let s = sealed();
        assert_eq!(check_submission(&s, "app", "1.0.1"), Err(ForgeryReason::BadSignature));
        assert_eq!(check_submission(&s, "other-app", "1.0.0"), Err(ForgeryReason::BadSignature));
    }

    #[test]
    fn extra_fields_are_not_covered_and_do_not_break_the_seal() {
        let mut s = sealed();
        s.extra.insert("note".into(), serde_json::json!("ignored"));
        s.submitter.extra.insert("upn".into(), serde_json::json!("ceo@corp"));
        assert_eq!(check_submission(&s, "app", "1.0.0"), Ok(SenderCheck::Signed));
    }

    /// THE FORGED-NAME EVENT. Bob signs with his own key an answer that claims
    /// Alice's id: the id commits to Alice's key, so it is refused.
    #[test]
    fn an_answer_signed_by_another_key_under_my_id_is_forged() {
        let alice = signed_identity(&SEED, "S-1-5-21-1-2-3-1001", "CORP\\alice");
        let mut forged = answer(alice);
        // Bob cannot call seal_submission (it refuses); he signs by hand.
        let bob = SigningKey::from_bytes(&OTHER_SEED);
        let bob_key = to_hex(bob.verifying_key().as_bytes());
        let payload = event_payload("app", "1.0.0", &forged, &bob_key, "interactive");
        forged.seal = Some(SubmissionSeal {
            public_key: bob_key,
            origin: SubmissionOrigin::Interactive,
            signature: to_hex(&bob.sign(&payload).to_bytes()),
        });
        assert_eq!(check_submission(&forged, "app", "1.0.0"), Err(ForgeryReason::KeyNotTheSenders));
        // ...and the app refuses to sign it at all.
        let mut again = answer(signed_identity(&SEED, "S-1-5-21-1-2-3-1001", "CORP\\alice"));
        assert!(seal_submission(&mut again, "app", "1.0.0", &OTHER_SEED, SubmissionOrigin::Interactive).is_err());
    }

    #[test]
    fn an_unsigned_answer_under_a_signed_id_is_forged_and_an_old_one_is_before_sign_in() {
        let mut planted = sealed();
        planted.seal = None;
        assert_eq!(check_submission(&planted, "app", "1.0.0"), Err(ForgeryReason::Unsigned));

        let mut old = answer(crate::SubmitterIdentity {
            display_name: "Salle".into(),
            id: "01a087b6-3308-79f7-8002-aa29c40418ce".into(),
            ..Default::default()
        });
        assert_eq!(check_submission(&old, "app", "1.0.0"), Ok(SenderCheck::BeforeSignIn));
        // A seal glued onto an old-format id proves nothing.
        old.seal = sealed().seal;
        assert_eq!(check_submission(&old, "app", "1.0.0"), Err(ForgeryReason::KeyNotTheSenders));
    }

    #[test]
    fn a_provider_that_disagrees_with_the_id_is_forged() {
        let mut s = answer(signed_identity(&SEED, "S-1-5-21-1-2-3-1001", "CORP\\alice"));
        s.submitter.provider = IdentityProviderKind::Entra;
        assert!(seal_submission(&mut s, "app", "1.0.0", &SEED, SubmissionOrigin::Interactive).is_err());
        let mut good = sealed();
        good.submitter.provider = IdentityProviderKind::Entra;
        assert_eq!(check_submission(&good, "app", "1.0.0"), Err(ForgeryReason::ProviderMismatch));
    }

    fn keypair(dir: &std::path::Path) -> PublisherKeypair {
        PublisherKeypair::load_or_create(dir).unwrap()
    }

    fn review_of(target: &WritebackSubmission) -> ReviewEvent {
        ReviewEvent {
            id: "rev-1".into(),
            target_submission_id: target.id.clone(),
            region_id: target.region_id.clone(),
            submitter_id: target.submitter.id.clone(),
            new_state: SubmissionState::Approved,
            review_reason: Some("ok".into()),
            reviewed_by: Some("Publisher".into()),
            reviewed_at: "2026-10-22T11:00:00Z".into(),
            target_digest: String::new(),
            seal: None,
            extra: Default::default(),
        }
    }

    #[test]
    fn a_signed_review_counts_only_for_an_authorised_key() {
        let dir = tempfile::TempDir::new().unwrap();
        let kp = keypair(dir.path());
        let target = sealed();
        let mut review = review_of(&target);
        seal_review(&mut review, &target, "app", "1.0.0", &kp);
        let authority = ReviewAuthority::from_keys([kp.public_key_hex()]);
        assert_eq!(check_review(&review, "app", "1.0.0", &authority), Ok(()));
        assert_eq!(
            check_review(&review, "app", "1.0.0", &ReviewAuthority::none()),
            Err(ReviewRefusal::SignerNotAuthorised)
        );
        // A forged change to the decision breaks it.
        let mut flipped = review.clone();
        flipped.new_state = SubmissionState::Rejected;
        assert_eq!(check_review(&flipped, "app", "1.0.0", &authority), Err(ReviewRefusal::BadSignature));
        // Unsigned: refused.
        let mut bare = review.clone();
        bare.seal = None;
        assert_eq!(check_review(&bare, "app", "1.0.0", &authority), Err(ReviewRefusal::Unsigned));
        // Another version's review does not verify here.
        assert_eq!(check_review(&review, "app", "2.0.0", &authority), Err(ReviewRefusal::BadSignature));
    }

    /// A SCRIPT'S DECISION SAYS SO, inside the signature: it verifies as a
    /// script's, and relabelling it as a person's (or the reverse) breaks it.
    /// An interactive decision's bytes are unchanged (no origin on disk).
    ///
    /// SABOTAGE: leave `origin` out of `review_payload`.
    #[test]
    fn a_scripts_review_decision_carries_its_origin_in_the_signature() {
        let dir = tempfile::TempDir::new().unwrap();
        let kp = keypair(dir.path());
        let target = sealed();
        let authority = ReviewAuthority::from_keys([kp.public_key_hex()]);
        let mut by_script = review_of(&target);
        seal_review_with_origin(&mut by_script, &target, "app", "1.0.0", &kp, SubmissionOrigin::Script);
        assert_eq!(by_script.seal.as_ref().unwrap().origin, SubmissionOrigin::Script);
        assert_eq!(check_review(&by_script, "app", "1.0.0", &authority), Ok(()));
        let mut passed_off = by_script.clone();
        passed_off.seal.as_mut().unwrap().origin = SubmissionOrigin::Interactive;
        assert_eq!(check_review(&passed_off, "app", "1.0.0", &authority), Err(ReviewRefusal::BadSignature));
        let mut by_person = review_of(&target);
        seal_review(&mut by_person, &target, "app", "1.0.0", &kp);
        let json = serde_json::to_value(&by_person).unwrap();
        assert!(json["seal"].get("origin").is_none(), "{json}");
        let mut relabelled = by_person.clone();
        relabelled.seal.as_mut().unwrap().origin = SubmissionOrigin::Script;
        assert_eq!(check_review(&relabelled, "app", "1.0.0", &authority), Err(ReviewRefusal::BadSignature));
        let json = serde_json::to_value(&by_script).unwrap();
        assert_eq!(json["seal"]["origin"], "script");
    }

    #[test]
    fn the_digest_follows_every_signed_field() {
        let a = sealed();
        let mut b = a.clone();
        b.value = SubmissionValue::Number { value: 1.0 };
        assert_ne!(event_digest("app", "1.0.0", &a), event_digest("app", "1.0.0", &b));
        // State and review fields are not part of it (the fold derives them).
        let mut c = a.clone();
        c.state = SubmissionState::Approved;
        c.reviewed_by = Some("x".into());
        assert_eq!(event_digest("app", "1.0.0", &a), event_digest("app", "1.0.0", &c));
    }

    #[test]
    fn is_mine_needs_my_id_and_a_signature() {
        let mut mine = sealed();
        let me = mine.submitter.clone();
        assert!(!is_mine(Some(&me), &mine), "unchecked is not mine");
        mine.sender = SenderCheck::Signed;
        assert!(is_mine(Some(&me), &mine));
        let mut planted = mine.clone();
        planted.sender = SenderCheck::BeforeSignIn;
        assert!(!is_mine(Some(&me), &planted));
        let mut blank = me.clone();
        blank.id = " ".into();
        assert!(!is_mine(Some(&blank), &mine));
        assert!(!is_mine(None, &mine));
    }

    #[test]
    fn checks_serialize_as_camel_case_strings() {
        assert_eq!(serde_json::to_value(SenderCheck::BeforeSignIn).unwrap(), "beforeSignIn");
        assert_eq!(serde_json::to_value(ForgeryReason::KeyNotTheSenders).unwrap(), "keyNotTheSenders");
        assert_eq!(serde_json::to_value(SubmissionOrigin::Immediate).unwrap(), "immediate");
        let seal = sealed().seal.unwrap();
        let v = serde_json::to_value(&seal).unwrap();
        assert!(v.get("publicKey").is_some() && v.get("signature").is_some());
    }
}
