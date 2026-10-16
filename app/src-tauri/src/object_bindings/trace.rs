//! FILENAME: app/src-tauri/src/object_bindings/trace.rs
// PURPOSE: Trace Dependents' binding half (D §3.20): which object properties are
//          BOUND to a formula that reads a given cell.
// CONTEXT: A binding is a dependent of the cells it reads exactly as a formula
//          cell is, so Trace Dependents names it ("the KPI card's goal follows
//          Inputs!B2"). The answer comes from the runtime's dependency maps
//          (`cell_dependents` for single cells, `range_dependents` for the
//          boxes ranges, columns, rows and defined names expand to), rebuilt
//          lazily from the store first (`eval::ensure_prepared`).
//
// LOCKS: the caller holds NOTHING (Trace Dependents drops its grid guards
// first). The object stores are read and released (`live_object_refs`), then
// the runtime alone, then the store alone -- never nested.

use std::collections::BTreeSet;

use crate::api_types::{ObjectBindingRef, TraceBoundObject};

use super::object_json::{self, ObjectStores};
use super::store::BindingKey;

/// Every live object property whose binding formula reads the cell
/// (`row`, `col`) of sheet `sheet_index`, sorted by (object, path). A binding
/// whose object no longer exists (one an undo could bring back) is not a
/// dependent anybody can see, and is left out. Volatile bindings (INDIRECT,
/// OFFSET over a computed start, ...) have no static address and are not
/// reported, exactly as a volatile cell is not.
pub fn bound_objects_reading_cell(
    cx: &ObjectStores<'_>,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> Vec<TraceBoundObject> {
    let Some(sheet_id) = cx.state.sheet_ids.read().ok().and_then(|ids| ids.get(sheet_index).copied()) else {
        return Vec::new();
    };
    super::eval::ensure_prepared(cx);
    let live: std::collections::HashSet<ObjectBindingRef> = object_json::live_object_refs(cx);

    let keys: BTreeSet<BindingKey> = {
        let Ok(runtime) = cx.state.object_binding_runtime.lock() else { return Vec::new() };
        let mut keys: BTreeSet<BindingKey> = runtime
            .cell_dependents
            .get(&(sheet_id, row, col))
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default();
        for (sheet, r0, c0, r1, c1, key) in &runtime.range_dependents {
            if *sheet == sheet_id && row >= *r0 && row <= *r1 && col >= *c0 && col <= *c1 {
                keys.insert(key.clone());
            }
        }
        keys
    };
    if keys.is_empty() {
        return Vec::new();
    }

    let Ok(store) = cx.state.object_bindings.read() else { return Vec::new() };
    keys.into_iter()
        .filter(|key| live.contains(&key.object))
        .filter_map(|key| {
            let formula = store.bindings.get(&key)?.formula.clone();
            Some(TraceBoundObject { object: key.object, path: key.path, formula })
        })
        .collect()
}
