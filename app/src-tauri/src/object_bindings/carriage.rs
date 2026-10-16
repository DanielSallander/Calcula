//! FILENAME: app/src-tauri/src/object_bindings/carriage.rs
// PURPOSE: Object property BINDINGS arriving through a `.calp` pull (D §3.14):
//          a subscribe, a checkout or a refresh lands the application's
//          `bindings.json` rows on the objects it just materialized.
// CONTEXT: Publish writes the bindings of the objects it carries
//          (`calp::publish::published_object_bindings`) with APPLICATION ids;
//          `calp::pull` reads them back unchanged and `rename_pull` follows a
//          collision rename into their formulas. This module is the host half:
//
//   1. IDS. A chart, slicer, timeline, pivot and floating range keep their
//      EntityId through a package and a control keeps its `uid`
//      (`controls::materialize_saved_controls`), so their rows need nothing. A
//      CANVAS PAGE's id is its SheetId, and a subscriber's sheets are its own:
//      the row is mapped through the same application -> local sheet map the
//      charts use, and a row naming a page this pull did not bring is dropped.
//      Compared as TEXT, never re-parsed: an id is identity, and a parser is a
//      door a crafted package should not be handed (BUG-0469). A Page
//      Navigator's per-button binding names its page in the PATH
//      (`/properties/pageOverrides/<sheetId>/...`): that segment is mapped
//      through the same map (`remap_per_button_page`, D §3.18a).
//   2. WHICH ROWS LAND. Only the rows of objects the application CARRIES in
//      this pull AND that now sit on a sheet the pull materialized. A pulled
//      chart skipped because the subscriber already had its id, or a control
//      whose uid collided and was re-minted, must not hand its bindings to the
//      SUBSCRIBER's object of the same id.
//   3. REPLACE, NOT MERGE. A refresh first removes every binding of the
//      application's objects -- the ones it owned before the refresh and the
//      ones it carries now -- and then lands the new version's rows, so a
//      binding the publisher removed in v2 stops binding. Bindings of the
//      subscriber's own objects are never touched.
//
// The legacy-spelling migration (`migrate::migrate_legacy_formulas`) runs after
// the landing with the pull's own effect: an application published before
// bindings existed still carries `valueType: "formula"` control properties, and
// they become bindings exactly as on a file open. Its CHART half does not run
// here (`ChartTextFields::Literals`): a pull parses only the embedded-object
// chart shape a bindings-era publisher writes, in which `=B2` is a literal.
//
// LOCKS: the family stores are read and released by the object walk first; the
// binding store (a leaf) is taken last, with nothing else held.

use std::collections::{HashMap, HashSet};

use identity::SheetId;

use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
use crate::document_effect::DocumentEffect;

use super::object_json::{self, ObjectStores};
use super::store::entry_from_saved;

/// What one pull brings for the binding store, captured while the pull result
/// is still whole (the materializer consumes its parts as it goes).
#[derive(Debug, Clone, Default)]
pub(crate) struct PulledBindings {
    /// The `bindings.json` rows, canvas-page ids mapped to LOCAL sheet ids;
    /// rows naming a page this pull does not bring are already gone.
    pub rows: Vec<::persistence::SavedObjectBinding>,
    /// Every object the application carries in this pull, in local ids.
    pub carried: HashSet<ObjectBindingRef>,
    /// The LOCAL sheets this pull materializes (fresh on a subscribe, the
    /// application's own on a checkout, the OLD local ids on a refresh).
    pub landed_sheets: HashSet<SheetId>,
}

/// What [`land_pulled_bindings`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct LandedBindings {
    /// Rows installed.
    pub installed: usize,
    /// Rows removed first (the application's previous bindings).
    pub removed: usize,
    /// Rows the pull carried whose object did not land here.
    pub not_landed: usize,
}

impl PulledBindings {
    /// Capture `result`'s bindings. `local_sheet` maps an APPLICATION sheet id
    /// to the local sheet it materializes as (`None`: not here -- detached, or
    /// not part of this pull).
    pub(crate) fn from_pull(
        result: &calp::pull::PullResult,
        local_sheet: impl Fn(SheetId) -> Option<SheetId>,
    ) -> Self {
        let local_of: Vec<(SheetId, SheetId)> = result
            .sheets
            .iter()
            .filter_map(|p| local_sheet(p.package_sheet_id).map(|local| (p.package_sheet_id, local)))
            .collect();
        let page_ids: HashMap<String, String> =
            local_of.iter().map(|(pkg, local)| (pkg.to_string(), local.to_string())).collect();
        let landed_sheets: HashSet<SheetId> = local_of.iter().map(|(_, local)| *local).collect();

        let mut carried: HashSet<ObjectBindingRef> = HashSet::new();
        let mut carry = |kind: ObjectBindingKind, id: String| {
            carried.insert(ObjectBindingRef { kind, id });
        };
        for chart in &result.charts {
            carry(ObjectBindingKind::Chart, chart.id.to_string());
        }
        for entry in &result.controls {
            for control in entry.controls.as_array().into_iter().flatten() {
                if let Some(uid) = control.get("uid").and_then(|u| u.as_str()).filter(|u| !u.is_empty()) {
                    carry(ObjectBindingKind::Control, uid.to_string());
                }
            }
        }
        for slicer in &result.slicers {
            carry(ObjectBindingKind::Slicer, slicer.id.to_string());
        }
        for timeline in &result.timeline_slicers {
            carry(ObjectBindingKind::TimelineSlicer, timeline.id.to_string());
        }
        for pivot in &result.pivot_definitions {
            carry(ObjectBindingKind::Pivot, pivot.id.to_string());
        }
        for fr in &result.floating_ranges {
            carry(ObjectBindingKind::FloatingRange, fr.id.to_string());
        }
        for pulled in result.sheets.iter().filter(|p| p.sheet.kind.is_canvas()) {
            if let Some(local) = page_ids.get(&pulled.package_sheet_id.to_string()) {
                carry(ObjectBindingKind::CanvasPage, local.clone());
            }
        }

        let page_kind = ObjectBindingKind::CanvasPage.wire_name();
        let control_kind = ObjectBindingKind::Control.wire_name();
        let rows: Vec<::persistence::SavedObjectBinding> = result
            .object_bindings
            .iter()
            .filter_map(|row| {
                if row.object.kind == control_kind {
                    let mut row = row.clone();
                    remap_per_button_page(&mut row.path, &page_ids);
                    return Some(row);
                }
                if row.object.kind != page_kind {
                    return Some(row.clone());
                }
                let local = page_ids.get(&row.object.id)?;
                let mut row = row.clone();
                row.object.id = local.clone();
                Some(row)
            })
            .collect();

        PulledBindings { rows, carried, landed_sheets }
    }
}

/// A Page Navigator's per-button binding names its page IN THE PATH
/// (`/properties/pageOverrides/<sheetId>/<field>`, D §3.18a), and a
/// subscriber's sheet ids are its own: map that SEGMENT through the same
/// application -> local page map the pull's controls use (WP-B's
/// `PageTargetRemap` holds the identical pairs; `controls::remap_control_page_targets`
/// re-keys the literal's entries the same way), so the binding keeps aiming at
/// the page the literal now names. Compared as TEXT, never parsed. A `name:`
/// key, a page this pull does not bring, and every other path are untouched
/// (an unmapped page is simply dormant). True when the path changed.
pub(crate) fn remap_per_button_page(path: &mut String, page_ids: &HashMap<String, String>) -> bool {
    let Some(target) = super::page_overrides::per_button_path(path) else { return false };
    let Some(local) = page_ids.get(&target.page_key) else { return false };
    if *local == target.page_key {
        return false;
    }
    *path = super::page_overrides::per_button_pointer(local, &target.field);
    true
}

/// The objects a REFRESH is about to replace for one subscription, read
/// BEFORE anything is materialized: every object its provenance ledger names
/// (`ledger_refs`: charts, slicers, timelines, pivots, floating ranges -- the
/// kinds refresh re-materializes by ledger), plus every control and canvas page
/// on `refreshed_sheets` (a refresh resets a subscribed sheet's controls
/// wholesale, and a page IS its sheet).
pub(crate) fn application_objects_before_refresh(
    stores: &ObjectStores<'_>,
    ledger_refs: impl IntoIterator<Item = (String, String)>,
    refreshed_sheets: &HashSet<SheetId>,
) -> HashSet<ObjectBindingRef> {
    let mut owned: HashSet<ObjectBindingRef> = ledger_refs
        .into_iter()
        .filter_map(|(kind, id)| {
            let kind = ObjectBindingKind::from_wire(&kind)?;
            matches!(
                kind,
                ObjectBindingKind::Chart
                    | ObjectBindingKind::Slicer
                    | ObjectBindingKind::TimelineSlicer
                    | ObjectBindingKind::Pivot
                    | ObjectBindingKind::FloatingRange
            )
            .then_some(ObjectBindingRef { kind, id })
        })
        .collect();
    for (object, location) in object_json::object_locations(stores) {
        if matches!(object.kind, ObjectBindingKind::Control | ObjectBindingKind::CanvasPage)
            && refreshed_sheets.contains(&location.sheet_id)
        {
            owned.insert(object);
        }
    }
    owned
}

/// Land one pull's bindings (see the module header): remove every binding of
/// the application's objects (`previously_owned`, plus the carried objects
/// that landed), then install the rows of the carried objects that landed.
/// Call it AFTER every object family of the pull has materialized, with no
/// lock held. Bumps the generation and announces a reload when the store
/// changed.
pub(crate) fn land_pulled_bindings(
    stores: &ObjectStores<'_>,
    effect: &DocumentEffect,
    pulled: &PulledBindings,
    previously_owned: &HashSet<ObjectBindingRef>,
) -> LandedBindings {
    // The application's objects that are HERE now: carried by this pull and
    // sitting on one of the sheets it materialized. Family stores read and
    // released before the (leaf) store is taken.
    let landed: HashSet<ObjectBindingRef> = object_json::object_locations(stores)
        .into_iter()
        .filter(|(object, location)| {
            pulled.carried.contains(object) && pulled.landed_sheets.contains(&location.sheet_id)
        })
        .map(|(object, _)| object)
        .collect();

    let mut outcome = LandedBindings::default();
    {
        let mut store = match stores.state.object_bindings.write(effect) {
            Ok(store) => store,
            Err(e) => {
                crate::log_warn!("BINDINGS", "the binding store is unwritable; the pulled bindings were not installed: {}", e);
                return outcome;
            }
        };
        let before = store.bindings.len();
        store
            .bindings
            .retain(|key, _| !previously_owned.contains(&key.object) && !landed.contains(&key.object));
        outcome.removed = before - store.bindings.len();
        for row in &pulled.rows {
            match entry_from_saved(row) {
                Some((key, binding)) if landed.contains(&key.object) => {
                    store.bindings.insert(key, binding);
                    outcome.installed += 1;
                }
                _ => outcome.not_landed += 1,
            }
        }
        if outcome.removed > 0 || outcome.installed > 0 {
            store.bump_generation();
        }
    }
    if outcome.removed > 0 || outcome.installed > 0 {
        super::announce_reload();
    }
    if outcome.not_landed > 0 {
        crate::log_info!(
            "BINDINGS",
            "{} pulled binding(s) name an object that did not land in this workbook and were not installed",
            outcome.not_landed
        );
    }
    outcome
}
