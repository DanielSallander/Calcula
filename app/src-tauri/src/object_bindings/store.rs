//! FILENAME: app/src-tauri/src/object_bindings/store.rs
// PURPOSE: The PERSISTED binding store (`AppState.object_bindings`) and its one
//          serialisable form, plus the save / load halves.
// CONTEXT: `BindingStore` is deliberately NOT `Serialize`. A `BTreeMap` with a
//          STRUCT key cannot be written by serde_json ("key must be a string"),
//          and the undo recorder writes snapshots with
//          `serde_json::to_vec(..).unwrap_or_default()` -- which would turn that
//          error into EMPTY bytes and a silently dead undo step. Save and the
//          state digest go through `BindingStoreSnapshot`, a SEQUENCE; undo
//          through `BindingDelta`, a sequence of only the keys a step changed.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
use crate::AppState;

/// The identity of one binding: the object and the property path.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingKey {
    pub object: ObjectBindingRef,
    pub path: String,
}

/// What a binding stores: its formula (INVARIANT spelling) and, for a formula
/// that reads measures, the stable model key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBinding {
    pub formula: String,
    pub model: Option<String>,
}

/// The binding store. See the module header for why it is not `Serialize`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BindingStore {
    pub bindings: BTreeMap<BindingKey, StoredBinding>,
    /// Bumped by EVERY write of `bindings` (command, undo arm, cascade, shift,
    /// repair, load, migration, pull). The runtime rebuilds lazily when its
    /// `built_for_generation` differs -- which is what lets a writer holding
    /// grid/grids/undo_stack (a structural shift) touch only the store.
    pub generation: u64,
}

/// The serialisable form of the whole store: a SEQUENCE, sorted by
/// (object kind, object id, path) in their on-disk spelling.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingStoreSnapshot {
    pub rows: Vec<::persistence::SavedObjectBinding>,
}

/// One binding an undoable step changed: its key and the value it had BEFORE
/// the step (`None`: it was not bound).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingDeltaRow {
    pub key: BindingKey,
    pub previous: Option<StoredBinding>,
}

/// The undo payload of the `obj_bindings` restore: ONLY the bindings the step
/// changed, each with its value before the step -- never the whole store.
///
/// A whole-store snapshot put back EVERY binding as it was when the step was
/// recorded, so an undo also reverted any binding something else changed in
/// between WITHOUT recording undo -- a `.calp` refresh replacing the
/// application's rows on a subscribed sheet: Ctrl+Z of the subscriber's own
/// bind brought back a binding the publisher had removed and dropped the one it
/// had added. A delta touches only its own keys. A SEQUENCE (BindingKey is a
/// struct; serde_json cannot write it as a map key -- see the module header).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingDelta {
    pub rows: Vec<BindingDeltaRow>,
}

impl BindingDelta {
    /// The keys whose binding differs between `previous` (the store before the
    /// step) and `current` (after it), each with its `previous` value. Sorted
    /// by key.
    pub fn between(previous: &BindingStoreSnapshot, current: &BindingStore) -> BindingDelta {
        let before = BindingStore::from_snapshot(previous).bindings;
        let keys: std::collections::BTreeSet<&BindingKey> = before.keys().chain(current.bindings.keys()).collect();
        let rows = keys
            .into_iter()
            .filter(|key| before.get(*key) != current.bindings.get(*key))
            .map(|key| BindingDeltaRow { key: key.clone(), previous: before.get(key).cloned() })
            .collect();
        BindingDelta { rows }
    }

    /// Put every row's `previous` value back into `store` and return the
    /// INVERSE delta (each key's value as it was just before this call). Keys
    /// the delta does not name are never touched. Bumps the generation once
    /// when anything was written.
    pub fn apply(&self, store: &mut BindingStore) -> BindingDelta {
        let mut inverse = Vec::with_capacity(self.rows.len());
        for row in &self.rows {
            let now = match &row.previous {
                Some(binding) => store.bindings.insert(row.key.clone(), binding.clone()),
                None => store.bindings.remove(&row.key),
            };
            inverse.push(BindingDeltaRow { key: row.key.clone(), previous: now });
        }
        if !self.rows.is_empty() {
            store.bump_generation();
        }
        BindingDelta { rows: inverse }
    }
}

/// One store entry in its on-disk spelling.
pub fn saved_row(key: &BindingKey, binding: &StoredBinding) -> ::persistence::SavedObjectBinding {
    ::persistence::SavedObjectBinding {
        object: ::persistence::SavedObjectRef {
            kind: key.object.kind.wire_name().to_string(),
            id: key.object.id.clone(),
        },
        path: key.path.clone(),
        formula: binding.formula.clone(),
        model: binding.model.clone(),
    }
}

/// One on-disk row as a store entry, or `None` for a kind this build does not
/// know (logged by the caller's context, never a panic).
pub fn entry_from_saved(row: &::persistence::SavedObjectBinding) -> Option<(BindingKey, StoredBinding)> {
    let kind = ObjectBindingKind::from_wire(&row.object.kind)?;
    Some((
        BindingKey {
            object: ObjectBindingRef { kind, id: row.object.id.clone() },
            path: row.path.clone(),
        },
        StoredBinding { formula: row.formula.clone(), model: row.model.clone() },
    ))
}

/// Sort rows the one deterministic way: (object, path) in on-disk spelling.
pub fn sort_saved_rows(rows: &mut [::persistence::SavedObjectBinding]) {
    rows.sort_by(|a, b| (&a.object, &a.path).cmp(&(&b.object, &b.path)));
}

impl BindingStore {
    /// The whole store as a sorted sequence.
    pub fn snapshot(&self) -> BindingStoreSnapshot {
        let mut rows: Vec<::persistence::SavedObjectBinding> =
            self.bindings.iter().map(|(k, b)| saved_row(k, b)).collect();
        sort_saved_rows(&mut rows);
        BindingStoreSnapshot { rows }
    }

    /// A store holding exactly `snapshot`'s rows. Rows of an unknown kind are
    /// dropped with a log line; a repeated (object, path) keeps the LAST row.
    /// `generation` is left at 0: the WRITER that installs the result decides
    /// it (see [`BindingStore::replace_bindings`]).
    pub fn from_snapshot(snapshot: &BindingStoreSnapshot) -> Self {
        let mut bindings = BTreeMap::new();
        for row in &snapshot.rows {
            match entry_from_saved(row) {
                Some((key, binding)) => {
                    bindings.insert(key, binding);
                }
                None => crate::log_warn!(
                    "BINDINGS",
                    "a binding of unknown object kind {:?} (id {}, path {}) was dropped",
                    row.object.kind,
                    row.object.id,
                    row.path
                ),
            }
        }
        BindingStore { bindings, generation: 0 }
    }

    /// Record that `bindings` changed: the runtime must rebuild.
    pub fn bump_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }

    /// Replace every binding with `other`'s, keeping this store's generation
    /// counter monotonic (bumped once).
    pub fn replace_bindings(&mut self, other: BindingStore) {
        self.bindings = other.bindings;
        self.bump_generation();
    }

    /// Drop every binding (File > New / Open), bumping the generation.
    pub fn clear_bindings(&mut self) {
        self.bindings.clear();
        self.bump_generation();
    }
}

/// The rows a SAVE writes: every binding whose object still exists
/// (`live` = `object_json::live_object_refs`), sorted. A binding whose object
/// is gone (an orphan) is omitted -- writing it would carry a dead row into
/// every later save, where nothing could ever show or remove it.
///
/// The live set is computed by the caller BEFORE this takes the store, so the
/// family stores are never held under it (the store is a leaf).
pub fn collect_bindings_for_save(
    state: &AppState,
    live: &HashSet<ObjectBindingRef>,
) -> Vec<::persistence::SavedObjectBinding> {
    let store = match state.object_bindings.read() {
        Ok(store) => store,
        Err(e) => {
            crate::log_warn!("BINDINGS", "the binding store is unreadable at save ({}); none written", e);
            return Vec::new();
        }
    };
    let mut rows: Vec<::persistence::SavedObjectBinding> = store
        .bindings
        .iter()
        .filter(|(key, _)| live.contains(&key.object))
        .map(|(key, binding)| saved_row(key, binding))
        .collect();
    let orphans = store.bindings.len() - rows.len();
    drop(store);
    if orphans > 0 {
        crate::log_info!(
            "BINDINGS",
            "{} binding(s) whose object no longer exists were not saved",
            orphans
        );
    }
    sort_saved_rows(&mut rows);
    rows
}

/// Does any binding name an object that still EXISTS? The question a lossy
/// export asks: an orphan row is never saved (see
/// [`collect_bindings_for_save`]), so it is nothing to lose. The object stores
/// are read and released (`live_object_refs`) before the leaf store is taken.
pub fn any_live_binding(cx: &super::object_json::ObjectStores<'_>) -> bool {
    let live = super::object_json::live_object_refs(cx);
    match cx.state.object_bindings.read() {
        Ok(store) => store.bindings.keys().any(|key| live.contains(&key.object)),
        Err(_) => false,
    }
}

/// Install the bindings a `.cala` just read (`Workbook.object_bindings`).
/// LOAD PATH: `deliberately_clean(LoadingFromDisk)`. Replaces the whole store
/// (File > Open already reset it), bumps the generation so the runtime
/// rebuilds on its next read, and announces a reload. Returns how many
/// bindings were installed.
pub fn restore_bindings_from_disk(
    state: &AppState,
    rows: &[::persistence::SavedObjectBinding],
) -> Result<usize, String> {
    let restored = BindingStore::from_snapshot(&BindingStoreSnapshot { rows: rows.to_vec() });
    let count = restored.bindings.len();
    let load = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    {
        let mut store = state.object_bindings.write(&load).map_err(|e| e.to_string())?;
        store.replace_bindings(restored);
    }
    super::announce_reload();
    Ok(count)
}
