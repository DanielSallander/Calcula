//! FILENAME: core/calp/src/identity_provider.rs
//! PURPOSE: WHO sends a writeback answer -- the submitter identity, the
//! identity-provider seam, and the id format that binds a sender to its key.
//! CONTEXT: Owner decision 2026-10-22 (open-items 2.am, option (c)), PHASE 1.
//!
//! Until this change the identity was a random UUID in
//! `%LOCALAPPDATA%\Calcula\subscriber-identity.json`: anybody who could write
//! the workspace could file answers under anybody's id, and the publisher had
//! no way to tell. Phase 1 replaces it with:
//!
//! * **The Windows account**, read from the operating system (the app's
//!   `identity::windows_account` provider): the user's SID, their
//!   `MACHINE\user` / `DOMAIN\user` name and their display name. No file to
//!   copy.
//! * **A per-user signing key** (Ed25519, kept in the Windows Credential
//!   Manager like the approvals key) that signs every answer
//!   (`crate::submission_seal`).
//! * **An id that COMMITS to that key**: `win-<SID>-<32 hex of sha256(key)>`.
//!   Every reader can check, offline and identically, that an answer filed
//!   under an id was signed by the key that id names. Nobody can send as you
//!   without your key, and a colleague who signs with their own key under
//!   your SID gets a DIFFERENT id -- they cannot shadow your answer.
//!
//! What phase 1 does NOT prove, stated plainly: the NAMES. The principal and
//! display name are what the sender's own Windows reported; they are signed
//! (nobody else can change them in place) but nothing checks them against a
//! directory. Proving the name is the file-share owner check (for
//! domain accounts, now the reader's label: `crate::identity_check`) and Entra ID
//! sign-in (phase 2 in the owner's numbering, LATER); [`EntraProvider`] is the
//! documented, NOT selectable seam for it. Until then, matching a person by
//! name ([`principal_matches`]) is exact, case-insensitive, never by display
//! name, never by substring, and only for SIGNED answers.
//!
//! Core stays platform-neutral (CI runs it on Linux): the Windows calls live in
//! the app crate behind [`IdentityProvider`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Which provider vouches for an identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentityProviderKind {
    /// No provider: an answer sent before sign-in existed (the old random id),
    /// or a draft typed before it. Never counted where a signature is required.
    #[default]
    Legacy,
    /// The Windows account the app runs as (phase 1, the default).
    Windows,
    /// A Microsoft Entra ID sign-in. PHASE 2 (owner, 2026-10-22: later), NOT BUILT: the kind exists so the
    /// id format and the on-disk shape do not change when it lands.
    Entra,
}

impl IdentityProviderKind {
    /// The id prefix this provider's ids carry (`None` for legacy ids).
    pub fn id_prefix(self) -> Option<&'static str> {
        match self {
            IdentityProviderKind::Legacy => None,
            IdentityProviderKind::Windows => Some("win-"),
            IdentityProviderKind::Entra => Some("entra-"),
        }
    }
}

/// Where the account lives. A unit enum (no struct variants -- they would cross
/// the IPC boundary in snake_case, see CLAUDE.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountScope {
    #[default]
    Unknown,
    /// A local account of ONE computer (including a local account linked to a
    /// personal Microsoft account). Its SID differs on every computer, so the
    /// same person on two computers is two senders.
    LocalMachine,
    /// A domain (Active Directory) account: the same SID on every domain-joined
    /// computer of the organisation.
    Domain,
    /// An Entra-joined account (`S-1-12-1-...`).
    EntraJoined,
}

/// A sender's identity, attached to every writeback answer.
///
/// `display_name` and `principal_name` are what the SENDER's computer reported:
/// signed with the answer (see `crate::submission_seal`), so nobody else can
/// rewrite them, but in phase 1 not proven against any directory. Never use
/// `display_name` to decide anything; match people with [`principal_matches`].
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitterIdentity {
    /// Human-readable display name ("Daniel Sallander", or the account name).
    pub display_name: String,
    /// The sender id -- the folder name under `submissions/`. For a signed
    /// identity it commits to the signing key (see [`submitter_id_for`]); an
    /// old random UUID reads as [`IdentityProviderKind::Legacy`].
    pub id: String,
    /// The account name people type into "expected respondents" and "allowed
    /// editors": `MACHINE\user` for a local account, `DOMAIN\user` for a domain
    /// one. Empty on legacy identities.
    #[serde(default)]
    pub principal_name: String,
    /// The provider that produced this identity.
    #[serde(default)]
    pub provider: IdentityProviderKind,
    /// Where the account lives.
    #[serde(default)]
    pub scope: AccountScope,
    /// Forward-compatibility. NEVER read for any decision: it is not signed.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// What a provider learns about the account the app runs as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountFacts {
    /// The provider-stable subject: the SID for Windows (`S-1-5-21-...`).
    pub subject: String,
    /// `MACHINE\user` / `DOMAIN\user` (Windows), UPN (Entra).
    pub principal_name: String,
    /// The person's display name, or the account name when none is known.
    pub display_name: String,
    pub scope: AccountScope,
}

/// THE PROVIDER SEAM. The app installs the Windows provider; Entra ID plugs in
/// here in phase 2 without changing the identity type, the id format or the
/// on-disk shape.
pub trait IdentityProvider: Send + Sync {
    fn kind(&self) -> IdentityProviderKind;
    /// Whether a user or a publisher may choose this provider today.
    fn selectable(&self) -> bool;
    /// The account the app runs as. `Err` is a plain sentence for the user.
    fn current_account(&self) -> Result<AccountFacts, String>;
}

/// PHASE 2 STUB -- Microsoft Entra ID sign-in. NOT SELECTABLE, and every call
/// refuses: there is no tenant or app registration to prove it against yet
/// (owner decision 2026-10-22). The design is in docs/design/calp-writeback.md
/// ("Who sends an answer"): authorization code + PKCE in the system browser
/// with a `http://127.0.0.1:{port}` loopback redirect and a checked `state`,
/// the signing key bound into the id_token through the OIDC nonce, and the id
/// `entra-<tid>-<oid>-<key>`.
pub struct EntraProvider;

impl IdentityProvider for EntraProvider {
    fn kind(&self) -> IdentityProviderKind {
        IdentityProviderKind::Entra
    }
    fn selectable(&self) -> bool {
        false
    }
    fn current_account(&self) -> Result<AccountFacts, String> {
        Err("Microsoft Entra ID sign-in is not available in this version of Calcula; \
             answers are sent as your Windows account."
            .to_string())
    }
}

/// Length of the key commitment in an id: 32 hex characters = 128 bits of
/// SHA-256 of the public key. Finding a second key with the same commitment is
/// a 2^128 search.
pub const KEY_COMMITMENT_HEX: usize = 32;

/// The key commitment of a hex Ed25519 public key (lowercase).
pub fn key_commitment(public_key_hex: &str) -> String {
    crate::integrity::sha256_hex(public_key_hex.trim().to_lowercase().as_bytes())[..KEY_COMMITMENT_HEX]
        .to_string()
}

/// The sender id for `subject` under `kind`, committed to `public_key_hex`:
/// `win-S-1-5-21-...-1001-<32 hex>`. `None` for [`IdentityProviderKind::Legacy`]
/// or a subject that would not be a safe folder name.
pub fn submitter_id_for(
    kind: IdentityProviderKind,
    subject: &str,
    public_key_hex: &str,
) -> Option<String> {
    let prefix = kind.id_prefix()?;
    let subject = subject.trim();
    if subject.is_empty()
        || !subject
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(format!("{prefix}{subject}-{}", key_commitment(public_key_hex)))
}

/// A signed-identity id taken apart: `(provider, subject, key commitment)`.
/// `None` for anything else (a legacy UUID, a hand-made folder name).
pub fn parse_signed_id(id: &str) -> Option<(IdentityProviderKind, &str, &str)> {
    let (kind, rest) = if let Some(rest) = id.strip_prefix("win-") {
        (IdentityProviderKind::Windows, rest)
    } else if let Some(rest) = id.strip_prefix("entra-") {
        (IdentityProviderKind::Entra, rest)
    } else {
        return None;
    };
    if rest.len() < KEY_COMMITMENT_HEX + 2 {
        return None;
    }
    let split = rest.len() - KEY_COMMITMENT_HEX;
    let (subject_dash, commitment) = rest.split_at(split);
    let subject = subject_dash.strip_suffix('-')?;
    if subject.is_empty()
        || !commitment
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return None;
    }
    Some((kind, subject, commitment))
}

/// Whether `id` claims to be a signed identity (and therefore MUST carry a
/// valid seal). A legacy id never does.
///
/// ANY CASE of the prefix counts as the claim. Windows file systems (NTFS, SMB,
/// Dropbox) treat `WIN-…` and `win-…` as one folder, so an unsigned file under
/// `WIN-<someone's id>` must not pass as "sent before sign-in": it is held to
/// the seal like the real id, and since [`parse_signed_id`] accepts only the
/// exact lowercase prefix it can never carry one -- it is FORGED.
pub fn is_signed_id(id: &str) -> bool {
    let lower = |p: &str| id.len() >= p.len() && id.is_char_boundary(p.len()) && id[..p.len()].eq_ignore_ascii_case(p);
    lower("win-") || lower("entra-")
}

/// Build the identity a provider vouches for, bound to `public_key_hex`.
pub fn identity_for(
    kind: IdentityProviderKind,
    facts: &AccountFacts,
    public_key_hex: &str,
) -> Result<SubmitterIdentity, String> {
    let id = submitter_id_for(kind, &facts.subject, public_key_hex).ok_or_else(|| {
        format!(
            "The account id '{}' cannot name a sender (only letters, digits, '-' and '_').",
            facts.subject
        )
    })?;
    let display_name = if facts.display_name.trim().is_empty() {
        facts.principal_name.clone()
    } else {
        facts.display_name.clone()
    };
    Ok(SubmitterIdentity {
        display_name,
        id,
        principal_name: facts.principal_name.clone(),
        provider: kind,
        scope: facts.scope,
        extra: HashMap::new(),
    })
}

/// THE ONE MATCHER for "is this the person the publisher named?" -- expected
/// respondents and masterData allowed editors.
///
/// * Exact and case-insensitive for the principal name: "Al" never matches
///   "Alice" (the old substring fallback let any name containing the entry
///   through).
/// * EXACT for the id, case included: a sender id is a public, stable string,
///   and `WIN-<Alice's id>` is a different (forged) sender, never Alice.
/// * Against the SIGNED principal name or the id -- never the display name.
/// * Only for a SIGNED answer (`signed == true`): an answer sent before sign-in
///   carries no principal anybody vouched for, so it matches by id only.
///
/// Phase 1 cannot prove the principal (see the module doc), so a match means
/// "the sender's own signed claim", not a verified directory identity.
pub fn principal_matches(entry: &str, who: &SubmitterIdentity, signed: bool) -> bool {
    let raw = entry.trim();
    if raw.is_empty() {
        return false;
    }
    if !who.id.is_empty() && who.id == raw {
        return true;
    }
    signed && !who.principal_name.trim().is_empty() && who.principal_name.trim().to_lowercase() == raw.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988";
    const SID: &str = "S-1-5-21-3691473241-3168198088-2350155458-1001";

    fn facts() -> AccountFacts {
        AccountFacts {
            subject: SID.to_string(),
            principal_name: "Danne\\Salle".to_string(),
            display_name: "Salle".to_string(),
            scope: AccountScope::LocalMachine,
        }
    }

    #[test]
    fn a_windows_id_names_the_sid_and_commits_to_the_key() {
        let id = submitter_id_for(IdentityProviderKind::Windows, SID, KEY).unwrap();
        assert!(id.starts_with("win-S-1-5-21-3691473241-3168198088-2350155458-1001-"));
        assert_eq!(id.len(), "win-".len() + SID.len() + 1 + KEY_COMMITMENT_HEX);
        let (kind, subject, commitment) = parse_signed_id(&id).unwrap();
        assert_eq!(kind, IdentityProviderKind::Windows);
        assert_eq!(subject, SID);
        assert_eq!(commitment, key_commitment(KEY));
        // The id is a valid workspace folder name.
        assert!(crate::workspace::validate_component(&id, "submitter id").is_ok());
    }

    #[test]
    fn another_key_under_the_same_sid_is_another_id() {
        let other = "aa".repeat(32);
        assert_ne!(
            submitter_id_for(IdentityProviderKind::Windows, SID, KEY),
            submitter_id_for(IdentityProviderKind::Windows, SID, &other)
        );
    }

    #[test]
    fn legacy_and_hand_made_ids_do_not_parse_as_signed() {
        assert!(parse_signed_id("01a087b6-3308-79f7-8002-aa29c40418ce").is_none());
        assert!(parse_signed_id("win-").is_none());
        assert!(parse_signed_id("win-S-1-5-21-x-NOTHEXNOTHEXNOTHEXNOTHEXNOTHEXNO").is_none());
        assert!(!is_signed_id("01a087b6-3308-79f7-8002-aa29c40418ce"));
        assert!(is_signed_id("win-anything"));
        // A case variant of the prefix still CLAIMS a signed identity (so an
        // unsigned file under it is forged) but never parses as one.
        assert!(is_signed_id("WIN-anything") && is_signed_id("Entra-x"));
        let real = submitter_id_for(IdentityProviderKind::Windows, SID, KEY).unwrap();
        assert!(parse_signed_id(&real.replacen("win-", "WIN-", 1)).is_none());
        assert!(!is_signed_id("wi") && !is_signed_id(""));
        assert!(submitter_id_for(IdentityProviderKind::Legacy, SID, KEY).is_none());
        assert!(submitter_id_for(IdentityProviderKind::Windows, "S-1/../x", KEY).is_none());
    }

    #[test]
    fn identity_for_fills_every_field_from_the_provider() {
        let who = identity_for(IdentityProviderKind::Windows, &facts(), KEY).unwrap();
        assert_eq!(who.principal_name, "Danne\\Salle");
        assert_eq!(who.display_name, "Salle");
        assert_eq!(who.provider, IdentityProviderKind::Windows);
        assert_eq!(who.scope, AccountScope::LocalMachine);
        assert_eq!(who.id, submitter_id_for(IdentityProviderKind::Windows, SID, KEY).unwrap());
    }

    #[test]
    fn the_entra_provider_is_a_stub_that_cannot_be_chosen() {
        let entra = EntraProvider;
        assert!(!entra.selectable());
        assert_eq!(entra.kind(), IdentityProviderKind::Entra);
        assert!(entra.current_account().is_err());
    }

    #[test]
    fn the_matcher_is_exact_never_substring_never_display_name() {
        let who = identity_for(IdentityProviderKind::Windows, &facts(), KEY).unwrap();
        assert!(principal_matches("danne\\salle", &who, true));
        assert!(principal_matches(&who.id, &who, true));
        // The id matches EXACTLY: a differently-cased id is another sender.
        assert!(!principal_matches(&who.id.to_uppercase(), &who, true));
        assert!(!principal_matches(&who.id.replacen("win-", "WIN-", 1), &who, false));
        // Substrings either way: refused.
        assert!(!principal_matches("salle", &who, true));
        assert!(!principal_matches("Danne\\Salle (North)", &who, true));
        // The display name is not a principal.
        let mut renamed = who.clone();
        renamed.display_name = "Alice".to_string();
        assert!(!principal_matches("alice", &renamed, true));
        // An unsigned answer matches by id only.
        assert!(!principal_matches("danne\\salle", &who, false));
        assert!(principal_matches(&who.id, &who, false));
        // A blank entry matches nobody.
        assert!(!principal_matches("  ", &who, true));
    }

    #[test]
    fn an_old_identity_file_reads_as_legacy() {
        let json = serde_json::json!({
            "displayName": "Bob",
            "id": "01a087b6-3308-79f7-8002-aa29c40418ce",
            "ssoProvider": "okta"
        });
        let who: SubmitterIdentity = serde_json::from_value(json).unwrap();
        assert_eq!(who.provider, IdentityProviderKind::Legacy);
        assert_eq!(who.scope, AccountScope::Unknown);
        assert!(who.principal_name.is_empty());
        assert!(who.extra.contains_key("ssoProvider"));
    }

    #[test]
    fn identity_serializes_camel_case() {
        let who = identity_for(IdentityProviderKind::Windows, &facts(), KEY).unwrap();
        let v = serde_json::to_value(&who).unwrap();
        assert_eq!(v["principalName"], "Danne\\Salle");
        assert_eq!(v["provider"], "windows");
        assert_eq!(v["scope"], "localMachine");
        assert_eq!(v["displayName"], "Salle");
    }
}
