//! FILENAME: app/src-tauri/src/pivot_undo_cache_tests.rs
//! PURPOSE: A pivot undo puts back the RECORDS the restored definition was
//!          written against, not merely the definition (BUG-0021, BUG-0022).
//! CONTEXT: A child module of `undo_commands` (declared with `#[path]` there),
//!          so it reaches the private restore and the private snapshot shape.
//!
//! THE DEFECT THESE PIN. `pivot_definition` restored the definition and
//! re-rendered it against WHATEVER cache was live at the time. For the commands
//! that only rearrange fields that is exactly right and deliberately cheap — the
//! records did not move, and cloning a cache per field change would be a real
//! cost. But two commands REPLACE the cache: `change_pivot_data_source` rebuilds
//! it from a different range, and `update_bi_pivot_fields` re-queries the model
//! for it. Restoring their old definition against the new records renders a view
//! that was never on screen — field indices that mean different columns, rows
//! the old definition never had — and it did so silently, because the restore
//! reported success either way.
//!
//! Both commands recorded NO undo entry at all when this was filed, so Ctrl+Z
//! undid whatever the user had done BEFORE instead. That is the surface the
//! ledger describes; the cache is the reason the fix could not be a one-line
//! "record the definition" and had to reach the snapshot format.

use super::*;
use crate::pivot::types::PivotState;
use crate::ribbon_filter::RibbonFilterState;
use pivot_engine::{PivotCache, PivotDefinition};

fn seed() -> crate::document_effect::DocumentEffect {
    crate::document_effect::test_seed_effect()
}

fn mutating() -> crate::document_effect::DocumentEffect {
    crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    )
}

struct Fixture {
    state: AppState,
    pivots: PivotState,
    filters: RibbonFilterState,
    panes: crate::pane_control::PaneControlState,
    pivot_id: identity::EntityId,
}

impl Fixture {
    /// One pivot, whose cache is distinguishable by its field count: the
    /// records themselves do not matter here, only WHICH cache survives.
    fn new(field_count: usize) -> Self {
        let state = crate::create_app_state();
        let pivots = PivotState::new();
        let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let mut def = PivotDefinition::new(pivot_id, (0, 0), (10, 3));
        def.name = Some("Original".to_string());
        pivots
            .pivot_tables
            .write(&seed())
            .unwrap()
            .insert(pivot_id, (def, PivotCache::new(pivot_id, field_count)));
        Fixture {
            state,
            pivots,
            filters: RibbonFilterState::new(),
            panes: crate::pane_control::PaneControlState::new(),
            pivot_id,
        }
    }

    /// Replace the live pair, standing in for what the command did.
    fn set_live(&self, name: &str, field_count: usize) {
        let mut tables = self.pivots.pivot_tables.write(&seed()).unwrap();
        let (def, cache) = tables.get_mut(&self.pivot_id).unwrap();
        def.name = Some(name.to_string());
        *cache = PivotCache::new(self.pivot_id, field_count);
    }

    fn live_name(&self) -> Option<String> {
        self.pivots
            .pivot_tables
            .read()
            .unwrap()
            .get(&self.pivot_id)
            .and_then(|(def, _)| def.name.clone())
    }

    fn live_field_count(&self) -> usize {
        self.pivots
            .pivot_tables
            .read()
            .unwrap()
            .get(&self.pivot_id)
            .map(|(_, cache)| cache.fields.len())
            .unwrap()
    }

    fn restore(&self, data: &[u8]) -> Transaction {
        let mut inverse = Transaction::new("inverse");
        apply_pivot_definition_restore(
            &self.state,
            &self.pivots,
            &self.filters,
            &self.panes,
            &mutating(),
            data,
            &mut inverse,
        );
        inverse
    }

    fn snapshot(&self, name: &str, cache: Option<PivotCache>) -> Vec<u8> {
        let mut def = PivotDefinition::new(self.pivot_id, (0, 0), (10, 3));
        def.name = Some(name.to_string());
        encode_pivot_definition_snapshot(self.pivot_id, def, Vec::new(), 0, cache)
    }
}

/// Pull the single `pivot_definition` payload out of an inverse transaction.
fn inverse_payload(txn: &Transaction) -> Vec<u8> {
    txn.changes
        .iter()
        .find_map(|c| match c {
            CellChange::CustomRestore { kind, data } if kind == PIVOT_DEFINITION_RESTORE_KIND => {
                Some(data.clone())
            }
            _ => None,
        })
        .expect("the restore records its inverse")
}

/// THE DETECTOR. Remove the `if let Some(old_cache) = snapshot.cache` arm from
/// `apply_pivot_definition_restore` and this fails: the pivot comes back
/// carrying the records of the change that was supposed to be undone.
#[test]
fn undoing_a_cache_replacing_change_puts_the_old_records_back() {
    let f = Fixture::new(4);
    let before = PivotCache::new(f.pivot_id, 4);

    // The command ran: a different source range, a different cache.
    f.set_live("After the source change", 9);
    assert_eq!(f.live_field_count(), 9, "precondition: the cache really moved");

    f.restore(&f.snapshot("Original", Some(before)));

    assert_eq!(f.live_name().as_deref(), Some("Original"));
    assert_eq!(
        f.live_field_count(),
        4,
        "the old definition is being rendered against the NEW records — a view \
         the user never saw (BUG-0021 / BUG-0022)"
    );
}

/// The cheap path is preserved: a field change records no cache, and the
/// restore must then leave the live one strictly alone rather than clearing it.
#[test]
fn a_definition_only_snapshot_leaves_the_live_cache_untouched() {
    let f = Fixture::new(6);
    f.set_live("After the field change", 6);

    f.restore(&f.snapshot("Original", None));

    assert_eq!(f.live_name().as_deref(), Some("Original"));
    assert_eq!(f.live_field_count(), 6, "a field change must not disturb the records");
}

/// Redo has to be as complete as undo: if the entry carried a cache, its
/// inverse carries the cache it replaced, or redoing renders the redone
/// definition against the pre-undo records.
#[test]
fn the_inverse_of_a_cache_carrying_restore_carries_a_cache_too() {
    let f = Fixture::new(4);
    f.set_live("After", 9);

    let inverse = f.restore(&f.snapshot("Original", Some(PivotCache::new(f.pivot_id, 4))));
    let decoded = decode_pivot_definition_snapshot(&inverse_payload(&inverse))
        .expect("the inverse payload is the same shape");

    assert_eq!(decoded.definition.name.as_deref(), Some("After"));
    assert_eq!(
        decoded.cache.map(|c| c.fields.len()),
        Some(9),
        "redo would put the old definition back with the pre-undo records"
    );
}

/// ...and a definition-only entry stays definition-only through the round trip,
/// so an ordinary field change never starts cloning caches into the undo stack.
#[test]
fn the_inverse_of_a_definition_only_restore_stays_definition_only() {
    let f = Fixture::new(6);
    f.set_live("After", 6);

    let inverse = f.restore(&f.snapshot("Original", None));
    let decoded = decode_pivot_definition_snapshot(&inverse_payload(&inverse)).unwrap();

    assert!(
        decoded.cache.is_none(),
        "a field change's undo must not grow a cache clone on the way back"
    );
}

/// The payload has ONE writer and ONE reader. This is the round trip they agree
/// on — the guard against a third author appearing with a `json!` literal that
/// silently omits a field, which is how this format was written for months.
#[test]
fn the_snapshot_round_trips_through_its_own_encoder_and_decoder() {
    let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let mut def = PivotDefinition::new(pivot_id, (1, 2), (30, 8));
    def.name = Some("Round trip".to_string());
    let data = encode_pivot_definition_snapshot(
        pivot_id,
        def,
        Vec::new(),
        3,
        Some(PivotCache::new(pivot_id, 5)),
    );

    let decoded = decode_pivot_definition_snapshot(&data).expect("decodes");
    assert_eq!(decoded.pivot_id, pivot_id);
    assert_eq!(decoded.dest_sheet_idx, 3);
    assert_eq!(decoded.definition.name.as_deref(), Some("Round trip"));
    assert_eq!(decoded.cache.map(|c| c.fields.len()), Some(5));
}
