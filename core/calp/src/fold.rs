//! FILENAME: core/calp/src/fold.rs
//! PURPOSE: Deterministic current-state fold over append-only writeback events.
//! CONTEXT: The workspace stores submissions and publisher review decisions as
//! immutable event files — no path is ever written twice by anyone — so
//! shared/synced storage (SMB, Dropbox) can never lose an update or produce a
//! meaningful "conflicted copy". Current state is DERIVED, database-style,
//! by this fold: every reader (publisher inbox, GATHER, BI feeds, parquet
//! rollup) applies the same total order and converges on the same collapse
//! regardless of directory scan order or which machine runs it.
//!
//! SIGNATURES AND DETERMINISM (identity phase 1, 2026-10-22). The fold now
//! looks at signatures -- the sender's on every answer, the publisher's on
//! every review -- and NOTHING ELSE about who wrote a file. A signature check
//! is pure: the same bytes give the same verdict on every machine, online or
//! offline. Anything that depends on the READER (a network lookup, who owns a
//! file on this share, a pin this computer remembers) must never change which
//! answer wins a slot; it belongs after the fold, as a label. The review
//! authority is the application's verified publisher key and its root-signed
//! co-publishers -- the same anchor every reader's trust already rests on.

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::submission_seal::{
    check_review, check_submission_in, event_digest, ForgeryReason, ReviewAuthority, ReviewRefusal,
    SenderCheck,
};
use crate::writeback::{ReviewEvent, SubmissionState, WritebackSubmission};

/// Compare two event timestamps under a total order. RFC3339 strings are
/// compared as instants when both parse — mixed `Z` / `+00:00` suffixes or
/// differing fractional-second precision must not skew ordering — with a plain
/// string compare as the fallback for non-RFC3339 input. Exact ties are broken
/// by the caller with the event id, which is unique, so the overall order is
/// strict.
pub fn cmp_timestamps(a: &str, b: &str) -> Ordering {
    use chrono::DateTime;
    match (DateTime::parse_from_rfc3339(a), DateTime::parse_from_rfc3339(b)) {
        (Ok(ta), Ok(tb)) => ta.cmp(&tb),
        _ => a.cmp(b),
    }
}

/// Where the events were read from, and whose decisions count. The application
/// and version are part of every signed payload, so a file copied into another
/// application or version folder no longer verifies there.
#[derive(Debug, Clone, Copy)]
pub struct FoldContext<'a> {
    pub package: &'a str,
    pub version: &'a str,
    pub authority: &'a ReviewAuthority,
    /// Every answer in this version must be SIGNED: an unsigned one is FORGED
    /// (`ForgeryReason::Unsigned`), never "sent before sign-in". Decided by
    /// the caller from the version's SIGNED manifest
    /// (`LocalWorkspace::answers_must_be_signed`), the same for every reader,
    /// so the fold stays deterministic. Without it, anyone who can write the
    /// share could add unlimited unsigned "respondents" to a version no
    /// unsigning app can even open.
    pub unsigned_is_forged: bool,
}

/// One answer the fold refused as forged: it never competes and never counts.
#[derive(Debug, Clone)]
pub struct RejectedEvent {
    pub event: WritebackSubmission,
    pub reason: ForgeryReason,
}

/// One review decision the fold ignored.
#[derive(Debug, Clone)]
pub struct IgnoredReview {
    pub review: ReviewEvent,
    pub reason: ReviewRefusal,
}

/// The whole fold: the current records, and what it refused (shown to the
/// publisher, never silently dropped).
#[derive(Debug, Clone, Default)]
pub struct FoldOutcome {
    pub current: Vec<WritebackSubmission>,
    pub forged: Vec<RejectedEvent>,
    pub ignored_reviews: Vec<IgnoredReview>,
}

/// An event with its digest, computed once.
struct Checked {
    event: WritebackSubmission,
    digest: String,
}

/// `(timestamp, id, digest)` total order between two submission events. The
/// digest breaks the tie between two same-id, same-time events that differ in
/// content, so even that resolves identically everywhere.
fn cmp_checked(a: &Checked, b: &Checked) -> Ordering {
    cmp_timestamps(&a.event.updated_at, &b.event.updated_at)
        .then_with(|| a.event.id.cmp(&b.event.id))
        .then_with(|| a.digest.cmp(&b.digest))
}

/// Signed beats unsigned, THEN the newest wins.
fn outranks(a: &Checked, b: &Checked) -> bool {
    let rank = |c: &Checked| u8::from(c.event.sender == SenderCheck::Signed);
    match rank(a).cmp(&rank(b)) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => cmp_checked(a, b) == Ordering::Greater,
    }
}

/// `(timestamp, id)` total order between two review events.
fn cmp_review_events(a: &ReviewEvent, b: &ReviewEvent) -> Ordering {
    cmp_timestamps(&a.reviewed_at, &b.reviewed_at).then_with(|| a.id.cmp(&b.id))
}

/// Fold raw workspace events into the CURRENT set of submissions. See
/// [`fold_detailed`] for the rules; this returns only the current records.
pub fn fold_submissions(
    events: Vec<WritebackSubmission>,
    reviews: &[ReviewEvent],
    ctx: &FoldContext<'_>,
) -> Vec<WritebackSubmission> {
    fold_detailed(events, reviews, ctx).current
}

/// Fold raw workspace events into the current set, reporting what was refused.
///
/// Rules (each deterministic, so shuffled input yields identical output):
/// 0. **Every answer is checked** (`crate::submission_seal::check_submission`):
///    signed by the key its sender id names, sent before sign-in (an old
///    random id, unsigned), or FORGED. A forged answer -- unsigned under a
///    signed id, signed by another key, edited after signing, or copied from
///    another application / version / environment -- is removed here, for grid
///    AND model-keyed answers alike, and listed in [`FoldOutcome::forged`]. A
///    `sender` key smuggled into a file's `extra` is stripped.
/// 1. Events are deduplicated by **(sender, event id)** -- never by event id
///    alone, so a file planted in another sender's folder that reuses a real
///    answer's id cannot displace it. Within one sender, a signed event
///    outranks an unsigned one with the same id; otherwise the newest
///    `(updated_at, id, digest)` wins (a re-synced byte-identical copy is
///    idempotent).
/// 2. Review state is DERIVED, never trusted: every event is normalized to
///    `Submitted` with cleared review fields.
/// 3. Grid events (`model_key == None`) collapse to one record per slot
///    `(environment, submitter, region, row, col)`. If any event in a slot is
///    signed, only signed events compete; then the newest wins. Older events
///    remain on disk as history but are not current. The ENVIRONMENT is part
///    of the slot because submissions are stored per version and an
///    environment is a pointer to a version, so two environments naming the
///    same version land in one tree — without it, one installation answering
///    the same cell in test and in prod loses the older answer here, before
///    any reader's filter can see it.
/// 4. Model-keyed events are NEVER collapsed — every surviving submission is a
///    record (multi-user collection keeps everything; masterData "newest
///    approved wins" is resolved downstream over the approved subset, and only
///    a signed review can approve).
/// 5. **Only a review signed by the publisher or an authorised co-publisher
///    counts** (`ctx.authority`); the rest are listed in
///    [`FoldOutcome::ignored_reviews`]. A review applies to a record only when
///    it names that record's id AND sender AND the digest of exactly that
///    record ("the publisher approved what they saw, not what came later");
///    the newest matching review wins.
/// 6. Output is sorted by `(region, row, col, submitter, updated_at, id)` so
///    downstream feed-order tie-breaks are cross-machine deterministic.
pub fn fold_detailed(
    events: Vec<WritebackSubmission>,
    reviews: &[ReviewEvent],
    ctx: &FoldContext<'_>,
) -> FoldOutcome {
    let mut outcome = FoldOutcome::default();

    // (0) Check every answer. Pure: same bytes, same verdict, everywhere.
    let mut checked: Vec<Checked> = Vec::with_capacity(events.len());
    for mut event in events {
        event.extra.remove("sender");
        // Nor may a file claim the READER's identity verdict.
        event.extra.remove("identity");
        event.identity = Default::default();
        match check_submission_in(&event, ctx.package, ctx.version, ctx.unsigned_is_forged) {
            Ok(sender) => {
                event.sender = sender;
                let digest = event_digest(ctx.package, ctx.version, &event);
                checked.push(Checked { event, digest });
            }
            Err(reason) => {
                event.sender = SenderCheck::Unchecked;
                outcome.forged.push(RejectedEvent { event, reason });
            }
        }
    }

    // (1) Dedup by (sender, event id).
    let mut by_id: HashMap<(String, String), Checked> = HashMap::new();
    for c in checked {
        let key = (c.event.submitter.id.clone(), c.event.id.clone());
        match by_id.get(&key) {
            Some(existing) if !outranks(&c, existing) => {}
            _ => {
                by_id.insert(key, c);
            }
        }
    }

    // (2) Normalize: stored review state is untrusted (derived below).
    let normalized = by_id.into_values().map(|mut c| {
        c.event.state = SubmissionState::Submitted;
        c.event.review_reason = None;
        c.event.reviewed_by = None;
        c
    });

    // (3) Grid collapse per slot; model events pass through uncollapsed.
    let mut current: Vec<Checked> = Vec::new();
    // THE ENVIRONMENT IS PART OF THE SLOT.
    //
    // Submissions are stored per VERSION, and an environment is a pointer to a
    // version — so right after a linear promotion both environments name the
    // same version and land in the same tree. Without the environment in this
    // key, one installation answering the same cell in test and in prod loses
    // the older answer HERE, before any reader's `visible_in` filter can see it:
    // the event is still on disk and invisible to everyone. Which of the two
    // survived depended only on which was newer, so a stale test value could
    // shadow a real production one.
    let mut grid_slots: HashMap<(String, String, String, u32, u32), Checked> = HashMap::new();
    for c in normalized {
        if c.event.model_key.is_some() {
            current.push(c);
            continue;
        }
        let slot = (
            c.event.environment.clone(),
            c.event.submitter.id.clone(),
            c.event.region_id.clone(),
            c.event.cell_row,
            c.event.cell_col,
        );
        match grid_slots.get(&slot) {
            Some(winner) if !outranks(&c, winner) => {}
            _ => {
                grid_slots.insert(slot, c);
            }
        }
    }
    current.extend(grid_slots.into_values());

    // (5) Signed reviews only; the newest MATCHING review per record applies.
    let mut valid: Vec<&ReviewEvent> = Vec::new();
    for review in reviews {
        match check_review(review, ctx.package, ctx.version, ctx.authority) {
            Ok(()) => valid.push(review),
            Err(reason) => outcome.ignored_reviews.push(IgnoredReview { review: review.clone(), reason }),
        }
    }
    let mut by_target: HashMap<(&str, &str, &str), &ReviewEvent> = HashMap::new();
    for review in valid {
        let key = (
            review.target_submission_id.as_str(),
            review.submitter_id.as_str(),
            review.target_digest.as_str(),
        );
        match by_target.get(&key) {
            Some(existing) if cmp_review_events(existing, review) != Ordering::Less => {}
            _ => {
                by_target.insert(key, review);
            }
        }
    }
    for c in &mut current {
        let key = (c.event.id.as_str(), c.event.submitter.id.as_str(), c.digest.as_str());
        if let Some(review) = by_target.get(&key) {
            c.event.state = review.new_state.clone();
            c.event.review_reason = review.review_reason.clone();
            // A SCRIPT'S DECISION IS NEVER SHOWN AS A PERSON'S: the origin is
            // inside the review's signature, and every surface that names the
            // reviewer (the inbox, the exports, the BI column) names it too.
            let by_script = review
                .seal
                .as_ref()
                .is_some_and(|seal| seal.origin == crate::submission_seal::SubmissionOrigin::Script);
            c.event.reviewed_by = if by_script {
                Some(match review.reviewed_by.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                    Some(name) => format!("{name} (by a script)"),
                    None => "a script".to_string(),
                })
            } else {
                review.reviewed_by.clone()
            };
        }
    }

    // (6) Deterministic output order.
    let mut records: Vec<WritebackSubmission> = current.into_iter().map(|c| c.event).collect();
    records.sort_by(|a, b| {
        a.region_id
            .cmp(&b.region_id)
            .then_with(|| a.cell_row.cmp(&b.cell_row))
            .then_with(|| a.cell_col.cmp(&b.cell_col))
            .then_with(|| a.submitter.id.cmp(&b.submitter.id))
            .then_with(|| cmp_timestamps(&a.updated_at, &b.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    outcome.current = records;
    outcome
        .forged
        .sort_by(|a, b| a.event.submitter.id.cmp(&b.event.submitter.id).then_with(|| a.event.id.cmp(&b.event.id)));
    outcome.ignored_reviews.sort_by(|a, b| a.review.id.cmp(&b.review.id));
    outcome
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_provider::{identity_for, AccountFacts, AccountScope, IdentityProviderKind, SubmitterIdentity};
    use crate::signing::PublisherKeypair;
    use crate::submission_seal::{public_key_of_seed, seal_review, seal_submission, SubmissionOrigin};
    use crate::writeback::SubmissionValue;

    const PKG: &str = "app";
    const VER: &str = "1.0.0";
    const PUBLISHER_SEED: [u8; 32] = [42u8; 32];

    fn publisher() -> PublisherKeypair {
        PublisherKeypair::from_seed(&PUBLISHER_SEED, "Publisher")
    }

    fn authority() -> ReviewAuthority {
        ReviewAuthority::from_keys([publisher().public_key_hex()])
    }

    fn fold(events: Vec<WritebackSubmission>, reviews: &[ReviewEvent]) -> Vec<WritebackSubmission> {
        let authority = authority();
        fold_submissions(events, reviews, &FoldContext { package: PKG, version: VER, authority: &authority, unsigned_is_forged: false })
    }

    fn fold_full(events: Vec<WritebackSubmission>, reviews: &[ReviewEvent]) -> FoldOutcome {
        let authority = authority();
        fold_detailed(events, reviews, &FoldContext { package: PKG, version: VER, authority: &authority, unsigned_is_forged: false })
    }

    /// An answer sent before sign-in (legacy id, unsigned) -- the shape every
    /// fixture used before identity phase 1.
    fn event(
        id: &str,
        region: &str,
        row: u32,
        col: u32,
        submitter: &str,
        updated_at: &str,
        value: f64,
    ) -> WritebackSubmission {
        WritebackSubmission {
            environment: String::new(),
            id: id.to_string(),
            region_id: region.to_string(),
            cell_row: row,
            cell_col: col,
            cell_id: None,
            submitter: SubmitterIdentity {
                display_name: submitter.to_string(),
                id: format!("id-{submitter}"),
                principal_name: String::new(),
                provider: Default::default(),
                scope: Default::default(),
                extra: Default::default(),
            },
            value: SubmissionValue::Number { value },
            state: SubmissionState::Submitted,
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
            submitted_at: Some(updated_at.to_string()),
            review_reason: None,
            reviewed_by: None,
            model_key: None,
            seal: None,
            sender: Default::default(),
            identity: Default::default(),
            extra: Default::default(),
        }
    }

    fn seed_of(name: &str) -> [u8; 32] {
        let mut seed = [0u8; 32];
        for (i, b) in name.bytes().enumerate() {
            seed[i % 32] ^= b;
        }
        seed[31] ^= 0x5a;
        seed
    }

    fn signed_who(name: &str) -> SubmitterIdentity {
        identity_for(
            IdentityProviderKind::Windows,
            &AccountFacts {
                subject: format!("S-1-5-21-9-9-9-{}", name.len() + 1000),
                principal_name: format!("CORP\\{name}"),
                display_name: name.to_string(),
                scope: AccountScope::Domain,
            },
            &public_key_of_seed(&seed_of(name)),
        )
        .unwrap()
    }

    /// An answer SIGNED by `submitter`'s own key.
    fn signed(
        id: &str,
        region: &str,
        row: u32,
        col: u32,
        submitter: &str,
        updated_at: &str,
        value: f64,
    ) -> WritebackSubmission {
        let mut e = event(id, region, row, col, submitter, updated_at, value);
        e.submitter = signed_who(submitter);
        seal_submission(&mut e, PKG, VER, &seed_of(submitter), SubmissionOrigin::Interactive).unwrap();
        e
    }

    fn model_event(
        id: &str,
        region: &str,
        key: &str,
        submitter: &str,
        updated_at: &str,
        value: f64,
    ) -> WritebackSubmission {
        let mut e = event(id, region, 0, 0, submitter, updated_at, value);
        e.model_key = Some(vec![key.to_string()]);
        e
    }

    /// A review SIGNED by the publisher, over `target` exactly as given.
    fn review(id: &str, target: &WritebackSubmission, state: SubmissionState, reviewed_at: &str) -> ReviewEvent {
        let mut r = ReviewEvent {
            id: id.to_string(),
            target_submission_id: target.id.clone(),
            region_id: target.region_id.clone(),
            submitter_id: target.submitter.id.clone(),
            new_state: state,
            review_reason: Some("because".to_string()),
            reviewed_by: Some("Publisher".to_string()),
            reviewed_at: reviewed_at.to_string(),
            target_digest: String::new(),
            seal: None,
            extra: Default::default(),
        };
        seal_review(&mut r, target, PKG, VER, &publisher());
        r
    }

    fn value_of(s: &WritebackSubmission) -> f64 {
        match s.value {
            SubmissionValue::Number { value } => value,
            _ => panic!("expected number"),
        }
    }

    #[test]
    fn grid_slot_newest_updated_at_wins() {
        let events = vec![
            event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0),
            event("s2", "r1", 0, 0, "alice", "2026-01-02T00:00:00Z", 2.0),
        ];
        let folded = fold(events, &[]);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].id, "s2");
        assert_eq!(value_of(&folded[0]), 2.0);
        assert_eq!(folded[0].sender, SenderCheck::BeforeSignIn);
    }

    /// A decision a SCRIPT signed is shown as one: the reviewer's name says
    /// "(by a script)" on every surface that reads the fold.
    ///
    /// SABOTAGE: copy `review.reviewed_by` unchanged in step (5).
    #[test]
    fn a_scripts_decision_names_the_script() {
        let s1 = event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let mut r = review("rv", &s1, SubmissionState::Approved, "2026-01-02T00:00:00Z");
        crate::submission_seal::seal_review_with_origin(
            &mut r,
            &s1,
            PKG,
            VER,
            &publisher(),
            SubmissionOrigin::Script,
        );
        let folded = fold(vec![s1.clone()], &[r]);
        assert_eq!(folded[0].state, SubmissionState::Approved);
        assert_eq!(folded[0].reviewed_by.as_deref(), Some("Publisher (by a script)"));
        let person = review("rp", &s1, SubmissionState::Approved, "2026-01-02T00:00:00Z");
        assert_eq!(fold(vec![s1], &[person])[0].reviewed_by.as_deref(), Some("Publisher"));
    }

    /// IN A VERSION WHOSE SIGNED MANIFEST SAYS ANSWERS ARE SIGNED, AN UNSIGNED
    /// ONE IS FORGED -- whatever its id looks like. "Sent before sign-in" is
    /// only for versions published before answers were signed; otherwise a
    /// share-writer could add unlimited unsigned "respondents" to a version no
    /// unsigning app can even open.
    ///
    /// SABOTAGE: ignore `ctx.unsigned_is_forged` in `check_submission_in`.
    #[test]
    fn an_unsigned_answer_in_a_version_that_requires_signatures_is_forged() {
        let authority = authority();
        let events = vec![event("s-old", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0)];
        let strict = fold_detailed(
            events.clone(),
            &[],
            &FoldContext { package: PKG, version: VER, authority: &authority, unsigned_is_forged: true },
        );
        assert!(strict.current.is_empty(), "{:?}", strict.current);
        assert_eq!(strict.forged.len(), 1);
        assert_eq!(strict.forged[0].reason, ForgeryReason::Unsigned);
        // The same bytes in a version from before signing: sent before sign-in.
        let legacy = fold_full(events, &[]);
        assert_eq!(legacy.current.len(), 1);
        assert_eq!(legacy.current[0].sender, SenderCheck::BeforeSignIn);
    }

    #[test]
    fn grid_slot_equal_timestamp_higher_id_wins() {
        let events = vec![
            event("s-aaa", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0),
            event("s-bbb", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 2.0),
        ];
        let folded = fold(events, &[]);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].id, "s-bbb");
    }

    #[test]
    fn mixed_timestamp_formats_compare_as_instants() {
        // "+00:00" vs "Z" and fractional seconds: 00:00:00.5+00:00 is LATER
        // than 00:00:00Z even though a plain string compare says otherwise
        // ('Z' > '.').
        let events = vec![
            event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0),
            event("s2", "r1", 0, 0, "alice", "2026-01-01T00:00:00.500+00:00", 2.0),
        ];
        let folded = fold(events, &[]);
        assert_eq!(folded[0].id, "s2");
    }

    #[test]
    fn distinct_submitters_never_collapse() {
        let events = vec![
            event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0),
            event("s2", "r1", 0, 0, "bob", "2026-01-01T00:00:00Z", 2.0),
        ];
        let folded = fold(events, &[]);
        assert_eq!(folded.len(), 2, "same cell, two submitters = two records");
    }

    #[test]
    fn model_events_never_collapse() {
        let events = vec![
            model_event("m1", "wb-col", "7", "alice", "2026-01-01T00:00:00Z", 1.0),
            model_event("m2", "wb-col", "7", "alice", "2026-01-02T00:00:00Z", 2.0),
            model_event("m3", "wb-col", "7", "bob", "2026-01-03T00:00:00Z", 3.0),
        ];
        let folded = fold(events, &[]);
        assert_eq!(folded.len(), 3, "model history keeps every event");
    }

    #[test]
    fn duplicate_event_ids_are_idempotent() {
        let e = event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let folded = fold(vec![e.clone(), e.clone(), e], &[]);
        assert_eq!(folded.len(), 1);
        let s = signed("s2", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let folded = fold(vec![s.clone(), s.clone()], &[]);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].sender, SenderCheck::Signed);
    }

    #[test]
    fn forged_stored_state_is_normalized_away() {
        let mut e = event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        e.state = SubmissionState::Approved;
        e.reviewed_by = Some("Forged".to_string());
        e.review_reason = Some("self-approved".to_string());
        let folded = fold(vec![e], &[]);
        assert_eq!(folded[0].state, SubmissionState::Submitted);
        assert!(folded[0].reviewed_by.is_none());
        assert!(folded[0].review_reason.is_none());
    }

    #[test]
    fn a_smuggled_sender_claim_in_extra_is_stripped() {
        let mut e = event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        e.extra.insert("sender".into(), serde_json::json!("signed"));
        let folded = fold(vec![e], &[]);
        assert!(!folded[0].extra.contains_key("sender"));
        let json = serde_json::to_value(&folded[0]).unwrap();
        assert_eq!(json["sender"], "beforeSignIn");
    }

    #[test]
    fn review_applies_to_current_event() {
        let s1 = signed("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let reviews = vec![review("rev1", &s1, SubmissionState::Approved, "2026-01-02T00:00:00Z")];
        let folded = fold(vec![s1], &reviews);
        assert_eq!(folded[0].state, SubmissionState::Approved);
        assert_eq!(folded[0].review_reason.as_deref(), Some("because"));
        assert_eq!(folded[0].reviewed_by.as_deref(), Some("Publisher"));
    }

    #[test]
    fn review_of_superseded_event_is_inert() {
        // Approve races a re-submit: the review targets s1, but s2 is newer.
        // Nothing is lost (both events exist), and the slot folds to
        // Submitted — the publisher must review the value they haven't seen.
        let s1 = signed("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let s2 = signed("s2", "r1", 0, 0, "alice", "2026-01-03T00:00:00Z", 2.0);
        let reviews = vec![review("rev1", &s1, SubmissionState::Approved, "2026-01-02T00:00:00Z")];
        let folded = fold(vec![s1, s2], &reviews);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].id, "s2");
        assert_eq!(folded[0].state, SubmissionState::Submitted);
        assert!(folded[0].review_reason.is_none());
    }

    #[test]
    fn newest_review_per_target_wins_and_can_reopen() {
        let s1 = signed("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let reviews = vec![
            review("rev1", &s1, SubmissionState::Approved, "2026-01-02T00:00:00Z"),
            review("rev2", &s1, SubmissionState::Rejected, "2026-01-03T00:00:00Z"),
            review("rev3", &s1, SubmissionState::Submitted, "2026-01-04T00:00:00Z"),
        ];
        let folded = fold(vec![s1.clone()], &reviews);
        assert_eq!(folded[0].state, SubmissionState::Submitted, "newest review re-opened");

        // Equal reviewed_at: higher review id wins.
        let reviews = vec![
            review("rev-a", &s1, SubmissionState::Approved, "2026-01-02T00:00:00Z"),
            review("rev-b", &s1, SubmissionState::Rejected, "2026-01-02T00:00:00Z"),
        ];
        let folded = fold(vec![s1], &reviews);
        assert_eq!(folded[0].state, SubmissionState::Rejected);
    }

    #[test]
    fn reviews_apply_to_model_events_individually() {
        let m1 = model_event("m1", "wb-col", "7", "alice", "2026-01-01T00:00:00Z", 1.0);
        let m2 = model_event("m2", "wb-col", "7", "alice", "2026-01-02T00:00:00Z", 2.0);
        let reviews = vec![review("rev1", &m1, SubmissionState::Approved, "2026-01-03T00:00:00Z")];
        let folded = fold(vec![m1, m2], &reviews);
        let m1 = folded.iter().find(|s| s.id == "m1").unwrap();
        let m2 = folded.iter().find(|s| s.id == "m2").unwrap();
        assert_eq!(m1.state, SubmissionState::Approved);
        assert_eq!(m2.state, SubmissionState::Submitted);
    }

    /// THE FORGED REVIEW. Owner decision 2026-10-22: approve/reject must be
    /// signed by the publisher or an authorised co-publisher; an unsigned
    /// decision, one signed by anybody else, and one edited after signing are
    /// all IGNORED -- and listed.
    ///
    /// SABOTAGE: make `check_review` return Ok(()) for an unsigned review.
    #[test]
    fn unsigned_or_foreign_or_edited_reviews_are_ignored() {
        let s1 = signed("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let mut unsigned = review("rev-u", &s1, SubmissionState::Approved, "2026-01-02T00:00:00Z");
        unsigned.seal = None;
        let mut foreign = review("rev-f", &s1, SubmissionState::Approved, "2026-01-03T00:00:00Z");
        seal_review(&mut foreign, &s1, PKG, VER, &PublisherKeypair::from_seed(&[1u8; 32], "Mallory"));
        let mut edited = review("rev-e", &s1, SubmissionState::Rejected, "2026-01-04T00:00:00Z");
        edited.new_state = SubmissionState::Approved;

        let out = fold_full(vec![s1], &[unsigned, foreign, edited]);
        assert_eq!(out.current[0].state, SubmissionState::Submitted, "no forged decision applied");
        let reasons: Vec<(String, ReviewRefusal)> =
            out.ignored_reviews.iter().map(|i| (i.review.id.clone(), i.reason)).collect();
        assert_eq!(
            reasons,
            vec![
                ("rev-e".to_string(), ReviewRefusal::BadSignature),
                ("rev-f".to_string(), ReviewRefusal::SignerNotAuthorised),
                ("rev-u".to_string(), ReviewRefusal::Unsigned),
            ]
        );
    }

    /// A co-publisher's key in the authority counts exactly like the publisher's.
    #[test]
    fn a_co_publisher_review_counts_when_authorised() {
        let co = PublisherKeypair::from_seed(&[3u8; 32], "Co");
        let s1 = signed("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let mut r = review("rev-c", &s1, SubmissionState::Approved, "2026-01-02T00:00:00Z");
        seal_review(&mut r, &s1, PKG, VER, &co);
        let authority = ReviewAuthority::from_keys([publisher().public_key_hex(), co.public_key_hex()]);
        let folded = fold_submissions(vec![s1], &[r], &FoldContext { package: PKG, version: VER, authority: &authority, unsigned_is_forged: false });
        assert_eq!(folded[0].state, SubmissionState::Approved);
    }

    /// An approval covers the value the publisher SAW. The key holder re-saving
    /// a different value under the same event id later is not approved by it.
    #[test]
    fn an_approval_does_not_cover_a_value_resaved_under_the_same_id() {
        let seen = signed("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let approval = review("rev1", &seen, SubmissionState::Approved, "2026-01-02T00:00:00Z");
        let resaved = signed("s1", "r1", 0, 0, "alice", "2026-01-03T00:00:00Z", 999.0);
        let folded = fold(vec![seen, resaved], &[approval]);
        assert_eq!(folded.len(), 1);
        assert_eq!(value_of(&folded[0]), 999.0);
        assert_eq!(folded[0].state, SubmissionState::Submitted);
    }

    /// THE FORGED-NAME EVENT in the fold: a newer answer under Alice's id that
    /// Alice's key did not sign never shadows her real one, whatever its
    /// timestamp -- for grid AND model-keyed answers.
    ///
    /// SABOTAGE: push forged events into `checked` instead of `outcome.forged`.
    #[test]
    fn a_forged_newer_answer_under_my_id_never_shadows_mine() {
        let real = signed("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        // Unsigned plant under Alice's signed id, newer.
        let mut plant = real.clone();
        plant.id = "s9".into();
        plant.updated_at = "2030-01-01T00:00:00Z".into();
        plant.value = SubmissionValue::Number { value: 1_000_000.0 };
        plant.seal = None;
        // Re-signed by Mallory's key under Alice's id.
        let mut resigned = plant.clone();
        resigned.id = "s8".into();
        let mallory = seed_of("mallory");
        let mut as_mallory = resigned.clone();
        as_mallory.submitter = signed_who("mallory");
        seal_submission(&mut as_mallory, PKG, VER, &mallory, SubmissionOrigin::Interactive).unwrap();
        resigned.seal = as_mallory.seal.clone();
        // A forged MODEL record under Alice's id.
        let mut model_plant = plant.clone();
        model_plant.id = "m9".into();
        model_plant.model_key = Some(vec!["7".into()]);

        let out = fold_full(vec![real, plant, resigned, model_plant], &[]);
        assert_eq!(out.current.len(), 1, "only Alice's real answer is current");
        assert_eq!(out.current[0].id, "s1");
        assert_eq!(value_of(&out.current[0]), 1.0);
        let mut reasons: Vec<(String, ForgeryReason)> =
            out.forged.iter().map(|r| (r.event.id.clone(), r.reason)).collect();
        reasons.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            reasons,
            vec![
                ("m9".to_string(), ForgeryReason::Unsigned),
                ("s8".to_string(), ForgeryReason::KeyNotTheSenders),
                ("s9".to_string(), ForgeryReason::Unsigned),
            ]
        );
    }

    /// THE DEDUP-BY-ID BYPASS (critique): a file in ANOTHER sender's folder that
    /// reuses Alice's event id and a newer timestamp used to replace her event
    /// at the dedup step, before any slot existed.
    ///
    /// SABOTAGE: key `by_id` on the event id alone.
    #[test]
    fn a_reused_event_id_in_another_folder_cannot_displace_a_real_answer() {
        let real = signed("shared-id", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let mut clone = event("shared-id", "r1", 0, 0, "bob", "2030-01-01T00:00:00Z", 666.0);
        clone.submitter.id = "id-bob".into();
        let approval = review("rev1", &real, SubmissionState::Approved, "2026-01-02T00:00:00Z");
        let folded = fold(vec![clone, real], &[approval]);
        let alice = folded.iter().find(|s| s.submitter.id == signed_who("alice").id).expect("alice kept");
        assert_eq!(value_of(alice), 1.0);
        assert_eq!(alice.state, SubmissionState::Approved);
        let bob = folded.iter().find(|s| s.submitter.id == "id-bob").expect("bob kept, separately");
        assert_eq!(bob.state, SubmissionState::Submitted, "Alice's approval does not leak onto the clone");
    }

    /// THE REPLAYED EVENT: Alice's real answer copied into another version's
    /// folder (or another application's) is refused there.
    #[test]
    fn a_replayed_answer_from_another_version_is_forged_here() {
        let real = signed("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let authority = authority();
        let out = fold_detailed(
            vec![real],
            &[],
            &FoldContext { package: PKG, version: "2.0.0", authority: &authority, unsigned_is_forged: false },
        );
        assert!(out.current.is_empty());
        assert_eq!(out.forged[0].reason, ForgeryReason::BadSignature);
    }

    /// DETERMINISM ACROSS MACHINES: two "machines" receive the same files in
    /// different orders (and one also sees a byte-duplicate re-sync) and must
    /// produce identical current state, forged list and ignored-review list.
    ///
    /// SABOTAGE: break a tie in the slot collapse by input order (`Some(winner)
    /// if false`): the two machines disagree.
    #[test]
    fn two_machines_fold_the_same_files_identically() {
        let s1 = signed("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let s2 = signed("s2", "r1", 0, 0, "alice", "2026-01-02T00:00:00Z", 2.0);
        let s3 = signed("s3", "r1", 0, 1, "alice", "2026-01-01T00:00:00Z", 3.0);
        let tie_a = signed("t-1", "r2", 0, 0, "bob", "2026-01-05T00:00:00Z", 10.0);
        let tie_b = signed("t-1", "r2", 0, 0, "bob", "2026-01-05T00:00:00Z", 11.0);
        let legacy = event("l1", "r1", 0, 0, "carol", "2026-01-01T00:00:00Z", 4.0);
        let m1 = model_event("m1", "wb-col", "7", "carol", "2026-01-01T00:00:00Z", 5.0);
        let mut forged = s2.clone();
        forged.id = "f1".into();
        forged.seal = None;
        let mut bad_review = review("rev-x", &s3, SubmissionState::Rejected, "2026-01-06T00:00:00Z");
        bad_review.seal = None;
        let reviews = vec![
            review("rev1", &s2, SubmissionState::Approved, "2026-01-03T00:00:00Z"),
            review("rev2", &m1, SubmissionState::Rejected, "2026-01-03T00:00:00Z"),
            bad_review,
        ];
        let events = vec![s1, s2, s3, tie_a, tie_b, legacy, m1, forged];

        let machine_a = fold_full(events.clone(), &reviews);
        let mut shuffled = events.clone();
        shuffled.reverse();
        shuffled.rotate_left(3);
        shuffled.push(events[0].clone()); // a re-synced duplicate
        let mut rev_reviews = reviews.clone();
        rev_reviews.reverse();
        let machine_b = fold_full(shuffled, &rev_reviews);

        let summary = |o: &FoldOutcome| {
            (
                o.current
                    .iter()
                    .map(|s| (s.id.clone(), s.submitter.id.clone(), format!("{:?}", s.value), s.state.clone(), s.sender))
                    .collect::<Vec<_>>(),
                o.forged.iter().map(|r| (r.event.id.clone(), r.reason)).collect::<Vec<_>>(),
                o.ignored_reviews.iter().map(|r| (r.review.id.clone(), r.reason)).collect::<Vec<_>>(),
            )
        };
        assert_eq!(summary(&machine_a), summary(&machine_b));
        // And the same-id, same-time tie resolved by digest, not by order.
        assert_eq!(machine_a.current.iter().filter(|s| s.id == "t-1").count(), 1);
    }

    #[test]
    fn shuffled_input_folds_identically() {
        let s1 = event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let s2 = event("s2", "r1", 0, 0, "alice", "2026-01-02T00:00:00Z", 2.0);
        let m1 = model_event("m1", "wb-col", "7", "alice", "2026-01-01T00:00:00Z", 5.0);
        let s5 = event("s5", "r2", 3, 3, "carol", "2026-01-05T00:00:00Z", 7.0);
        let reviews = vec![
            review("rev1", &s2, SubmissionState::Approved, "2026-01-03T00:00:00Z"),
            review("rev2", &m1, SubmissionState::Rejected, "2026-01-03T00:00:00Z"),
            review("rev3", &s5, SubmissionState::Approved, "2026-01-06T00:00:00Z"),
        ];
        let events = vec![
            s1,
            s2,
            event("s3", "r1", 0, 1, "alice", "2026-01-01T00:00:00Z", 3.0),
            event("s4", "r1", 0, 0, "bob", "2026-01-01T00:00:00Z", 4.0),
            m1,
            model_event("m2", "wb-col", "7", "bob", "2026-01-02T00:00:00Z", 6.0),
            s5,
        ];

        let baseline = fold(events.clone(), &reviews);
        // A few fixed permutations (reversed, rotated, interleaved) — the fold
        // must be order-independent for both events and reviews.
        let mut reversed = events.clone();
        reversed.reverse();
        let mut rotated = events.clone();
        rotated.rotate_left(3);
        let mut rev_reviews = reviews.clone();
        rev_reviews.reverse();

        for (evs, revs) in [
            (reversed, reviews.clone()),
            (rotated, rev_reviews.clone()),
            (events.clone(), rev_reviews),
        ] {
            let folded = fold(evs, &revs);
            assert_eq!(folded.len(), baseline.len());
            for (a, b) in baseline.iter().zip(folded.iter()) {
                assert_eq!(a.id, b.id);
                assert_eq!(a.state, b.state);
            }
        }
        assert!(baseline.iter().any(|s| s.id == "s2" && s.state == SubmissionState::Approved));
    }

    #[test]
    fn output_order_is_deterministic_and_grouped() {
        let events = vec![
            event("s2", "r2", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0),
            event("s1", "r1", 1, 0, "bob", "2026-01-01T00:00:00Z", 2.0),
            event("s3", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 3.0),
        ];
        let folded = fold(events, &[]);
        let ids: Vec<&str> = folded.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["s3", "s1", "s2"], "(region, row, col) ordering");
    }

    /// TWO ENVIRONMENTS, ONE SLOT, BOTH KEPT.
    ///
    /// Submissions are stored per VERSION and an environment is a pointer to
    /// a version, so right after a linear promotion both environments name the
    /// same version and land in one tree. Without the environment in the slot
    /// key one installation answering the same cell in test and in prod lost
    /// the older answer HERE, before any reader's filter could see it: the
    /// event stayed on disk and was invisible to everyone.
    ///
    /// SABOTAGE: drop `event.environment` from the slot tuple.
    #[test]
    fn one_submitter_answering_in_two_environments_keeps_both() {
        let mut test_env = event("s-a", "r1", 0, 0, "u1", "2026-01-01T10:00:00Z", 1.0);
        test_env.environment = "test".to_string();
        let mut prod_env = event("s-b", "r1", 0, 0, "u1", "2026-01-01T09:00:00Z", 2.0);
        prod_env.environment = "prod".to_string();

        let folded = fold(vec![test_env, prod_env], &[]);
        assert_eq!(folded.len(), 2, "one slot per environment, not one overall");
        let mut envs: Vec<&str> = folded.iter().map(|s| s.environment.as_str()).collect();
        envs.sort();
        assert_eq!(envs, vec!["prod", "test"]);
    }

    /// With no verified publisher key in hand, no decision counts -- fail closed.
    #[test]
    fn no_authority_means_no_review_counts() {
        let s1 = signed("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let r = review("rev1", &s1, SubmissionState::Approved, "2026-01-02T00:00:00Z");
        let none = ReviewAuthority::none();
        let folded = fold_submissions(vec![s1], &[r], &FoldContext { package: PKG, version: VER, authority: &none, unsigned_is_forged: false });
        assert_eq!(folded[0].state, SubmissionState::Submitted);
    }
}
