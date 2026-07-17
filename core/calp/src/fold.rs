//! FILENAME: core/calp/src/fold.rs
//! PURPOSE: Deterministic current-state fold over append-only writeback events.
//! CONTEXT: The registry stores submissions and publisher review decisions as
//! immutable event files — no path is ever written twice by anyone — so
//! shared/synced storage (SMB, Dropbox) can never lose an update or produce a
//! meaningful "conflicted copy". Current state is DERIVED, database-style,
//! by this fold: every reader (publisher inbox, GATHER, BI feeds, parquet
//! rollup) applies the same total order and converges on the same collapse
//! regardless of directory scan order or which machine runs it.

use std::cmp::Ordering;
use std::collections::HashMap;

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

/// `(timestamp, id)` total order between two submission events.
fn cmp_submission_events(a: &WritebackSubmission, b: &WritebackSubmission) -> Ordering {
    cmp_timestamps(&a.updated_at, &b.updated_at).then_with(|| a.id.cmp(&b.id))
}

/// `(timestamp, id)` total order between two review events.
fn cmp_review_events(a: &ReviewEvent, b: &ReviewEvent) -> Ordering {
    cmp_timestamps(&a.reviewed_at, &b.reviewed_at).then_with(|| a.id.cmp(&b.id))
}

/// Fold raw registry events into the CURRENT set of submissions.
///
/// Rules (each deterministic, so shuffled input yields identical output):
/// 1. Events are deduplicated by id — a byte-duplicated immutable event (e.g.
///    re-synced) is idempotent; if duplicates of one id ever disagree, the
///    newest `(updated_at, id)` wins.
/// 2. Review state is DERIVED, never trusted: every event is normalized to
///    `Submitted` with cleared review fields, then the newest review event
///    targeting exactly that submission id is applied. A review of a
///    superseded event is inert — re-submitting resets the slot to
///    `Submitted` ("the publisher approved what they saw, not what came
///    later").
/// 3. Grid events (`model_key == None`) collapse to one record per slot
///    `(submitter, region, row, col)`: the newest `(updated_at, id)` wins.
///    Older events remain on disk as history but are not current.
/// 4. Model-keyed events are NEVER collapsed — every submission is a record
///    (multi-user collection keeps everything; masterData "newest approved
///    wins" is resolved downstream over the approved subset).
/// 5. Output is sorted by `(region, row, col, submitter, updated_at, id)` so
///    downstream feed-order tie-breaks are cross-machine deterministic.
pub fn fold_submissions(
    events: Vec<WritebackSubmission>,
    reviews: &[ReviewEvent],
) -> Vec<WritebackSubmission> {
    // (1) Dedup by event id, newest-wins on (impossible-in-practice) content
    // disagreement between same-id duplicates.
    let mut by_id: HashMap<String, WritebackSubmission> = HashMap::new();
    for event in events {
        match by_id.get(&event.id) {
            Some(existing) if cmp_submission_events(existing, &event) != Ordering::Less => {}
            _ => {
                by_id.insert(event.id.clone(), event);
            }
        }
    }

    // (2) Normalize: stored review state is untrusted (derived below).
    let mut normalized: Vec<WritebackSubmission> = by_id
        .into_values()
        .map(|mut event| {
            event.state = SubmissionState::Submitted;
            event.review_reason = None;
            event.reviewed_by = None;
            event
        })
        .collect();

    // (3) Grid collapse per slot; model events pass through uncollapsed.
    let mut current: Vec<WritebackSubmission> = Vec::new();
    let mut grid_slots: HashMap<(String, String, u32, u32), WritebackSubmission> = HashMap::new();
    for event in normalized.drain(..) {
        if event.model_key.is_some() {
            current.push(event);
            continue;
        }
        let slot = (
            event.submitter.id.clone(),
            event.region_id.clone(),
            event.cell_row,
            event.cell_col,
        );
        match grid_slots.get(&slot) {
            Some(winner) if cmp_submission_events(winner, &event) != Ordering::Less => {}
            _ => {
                grid_slots.insert(slot, event);
            }
        }
    }
    current.extend(grid_slots.into_values());

    // (4) Apply the newest review event per target submission id.
    let mut best_review: HashMap<&str, &ReviewEvent> = HashMap::new();
    for review in reviews {
        match best_review.get(review.target_submission_id.as_str()) {
            Some(existing) if cmp_review_events(existing, review) != Ordering::Less => {}
            _ => {
                best_review.insert(review.target_submission_id.as_str(), review);
            }
        }
    }
    for record in &mut current {
        if let Some(review) = best_review.get(record.id.as_str()) {
            record.state = review.new_state.clone();
            record.review_reason = review.review_reason.clone();
            record.reviewed_by = review.reviewed_by.clone();
        }
    }

    // (5) Deterministic output order.
    current.sort_by(|a, b| {
        a.region_id
            .cmp(&b.region_id)
            .then_with(|| a.cell_row.cmp(&b.cell_row))
            .then_with(|| a.cell_col.cmp(&b.cell_col))
            .then_with(|| a.submitter.id.cmp(&b.submitter.id))
            .then_with(|| cmp_submission_events(a, b))
    });
    current
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_provider::SubmitterIdentity;
    use crate::writeback::SubmissionValue;

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
            id: id.to_string(),
            region_id: region.to_string(),
            cell_row: row,
            cell_col: col,
            cell_id: None,
            submitter: SubmitterIdentity {
                display_name: submitter.to_string(),
                id: format!("id-{submitter}"),
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
            extra: Default::default(),
        }
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

    fn review(id: &str, target: &str, state: SubmissionState, reviewed_at: &str) -> ReviewEvent {
        ReviewEvent {
            id: id.to_string(),
            target_submission_id: target.to_string(),
            region_id: "r1".to_string(),
            submitter_id: "id-alice".to_string(),
            new_state: state,
            review_reason: Some("because".to_string()),
            reviewed_by: Some("Publisher".to_string()),
            reviewed_at: reviewed_at.to_string(),
            extra: Default::default(),
        }
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
        let folded = fold_submissions(events, &[]);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].id, "s2");
        assert_eq!(value_of(&folded[0]), 2.0);
    }

    #[test]
    fn grid_slot_equal_timestamp_higher_id_wins() {
        let events = vec![
            event("s-aaa", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0),
            event("s-bbb", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 2.0),
        ];
        let folded = fold_submissions(events, &[]);
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
        let folded = fold_submissions(events, &[]);
        assert_eq!(folded[0].id, "s2");
    }

    #[test]
    fn distinct_submitters_never_collapse() {
        let events = vec![
            event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0),
            event("s2", "r1", 0, 0, "bob", "2026-01-01T00:00:00Z", 2.0),
        ];
        let folded = fold_submissions(events, &[]);
        assert_eq!(folded.len(), 2, "same cell, two submitters = two records");
    }

    #[test]
    fn model_events_never_collapse() {
        let events = vec![
            model_event("m1", "wb-col", "7", "alice", "2026-01-01T00:00:00Z", 1.0),
            model_event("m2", "wb-col", "7", "alice", "2026-01-02T00:00:00Z", 2.0),
            model_event("m3", "wb-col", "7", "bob", "2026-01-03T00:00:00Z", 3.0),
        ];
        let folded = fold_submissions(events, &[]);
        assert_eq!(folded.len(), 3, "model history keeps every event");
    }

    #[test]
    fn duplicate_event_ids_are_idempotent() {
        let e = event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        let folded = fold_submissions(vec![e.clone(), e.clone(), e], &[]);
        assert_eq!(folded.len(), 1);
    }

    #[test]
    fn forged_stored_state_is_normalized_away() {
        let mut e = event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0);
        e.state = SubmissionState::Approved;
        e.reviewed_by = Some("Forged".to_string());
        e.review_reason = Some("self-approved".to_string());
        let folded = fold_submissions(vec![e], &[]);
        assert_eq!(folded[0].state, SubmissionState::Submitted);
        assert!(folded[0].reviewed_by.is_none());
        assert!(folded[0].review_reason.is_none());
    }

    #[test]
    fn review_applies_to_current_event() {
        let events = vec![event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0)];
        let reviews = vec![review("rev1", "s1", SubmissionState::Approved, "2026-01-02T00:00:00Z")];
        let folded = fold_submissions(events, &reviews);
        assert_eq!(folded[0].state, SubmissionState::Approved);
        assert_eq!(folded[0].review_reason.as_deref(), Some("because"));
        assert_eq!(folded[0].reviewed_by.as_deref(), Some("Publisher"));
    }

    #[test]
    fn review_of_superseded_event_is_inert() {
        // Approve races a re-submit: the review targets s1, but s2 is newer.
        // Nothing is lost (both events exist), and the slot folds to
        // Submitted — the publisher must review the value they haven't seen.
        let events = vec![
            event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0),
            event("s2", "r1", 0, 0, "alice", "2026-01-03T00:00:00Z", 2.0),
        ];
        let reviews = vec![review("rev1", "s1", SubmissionState::Approved, "2026-01-02T00:00:00Z")];
        let folded = fold_submissions(events, &reviews);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].id, "s2");
        assert_eq!(folded[0].state, SubmissionState::Submitted);
        assert!(folded[0].review_reason.is_none());
    }

    #[test]
    fn newest_review_per_target_wins_and_can_reopen() {
        let events = vec![event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0)];
        let reviews = vec![
            review("rev1", "s1", SubmissionState::Approved, "2026-01-02T00:00:00Z"),
            review("rev2", "s1", SubmissionState::Rejected, "2026-01-03T00:00:00Z"),
            review("rev3", "s1", SubmissionState::Submitted, "2026-01-04T00:00:00Z"),
        ];
        let folded = fold_submissions(events, &reviews);
        assert_eq!(folded[0].state, SubmissionState::Submitted, "newest review re-opened");

        // Equal reviewed_at: higher review id wins.
        let events = vec![event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0)];
        let reviews = vec![
            review("rev-a", "s1", SubmissionState::Approved, "2026-01-02T00:00:00Z"),
            review("rev-b", "s1", SubmissionState::Rejected, "2026-01-02T00:00:00Z"),
        ];
        let folded = fold_submissions(events, &reviews);
        assert_eq!(folded[0].state, SubmissionState::Rejected);
    }

    #[test]
    fn reviews_apply_to_model_events_individually() {
        let events = vec![
            model_event("m1", "wb-col", "7", "alice", "2026-01-01T00:00:00Z", 1.0),
            model_event("m2", "wb-col", "7", "alice", "2026-01-02T00:00:00Z", 2.0),
        ];
        let reviews = vec![review("rev1", "m1", SubmissionState::Approved, "2026-01-03T00:00:00Z")];
        let folded = fold_submissions(events, &reviews);
        let m1 = folded.iter().find(|s| s.id == "m1").unwrap();
        let m2 = folded.iter().find(|s| s.id == "m2").unwrap();
        assert_eq!(m1.state, SubmissionState::Approved);
        assert_eq!(m2.state, SubmissionState::Submitted);
    }

    #[test]
    fn shuffled_input_folds_identically() {
        let events = vec![
            event("s1", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0),
            event("s2", "r1", 0, 0, "alice", "2026-01-02T00:00:00Z", 2.0),
            event("s3", "r1", 0, 1, "alice", "2026-01-01T00:00:00Z", 3.0),
            event("s4", "r1", 0, 0, "bob", "2026-01-01T00:00:00Z", 4.0),
            model_event("m1", "wb-col", "7", "alice", "2026-01-01T00:00:00Z", 5.0),
            model_event("m2", "wb-col", "7", "bob", "2026-01-02T00:00:00Z", 6.0),
            event("s5", "r2", 3, 3, "carol", "2026-01-05T00:00:00Z", 7.0),
        ];
        let reviews = vec![
            review("rev1", "s2", SubmissionState::Approved, "2026-01-03T00:00:00Z"),
            review("rev2", "m1", SubmissionState::Rejected, "2026-01-03T00:00:00Z"),
            review("rev3", "s5", SubmissionState::Approved, "2026-01-06T00:00:00Z"),
        ];

        let baseline = fold_submissions(events.clone(), &reviews);
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
            let folded = fold_submissions(evs, &revs);
            assert_eq!(folded.len(), baseline.len());
            for (a, b) in baseline.iter().zip(folded.iter()) {
                assert_eq!(a.id, b.id);
                assert_eq!(a.state, b.state);
            }
        }
    }

    #[test]
    fn output_order_is_deterministic_and_grouped() {
        let events = vec![
            event("s2", "r2", 0, 0, "alice", "2026-01-01T00:00:00Z", 1.0),
            event("s1", "r1", 1, 0, "bob", "2026-01-01T00:00:00Z", 2.0),
            event("s3", "r1", 0, 0, "alice", "2026-01-01T00:00:00Z", 3.0),
        ];
        let folded = fold_submissions(events, &[]);
        let ids: Vec<&str> = folded.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["s3", "s1", "s2"], "(region, row, col) ordering");
    }
}
