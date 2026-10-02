//! FILENAME: app/src-tauri/src/controls.rs
// PURPOSE: Control metadata storage and Tauri commands.
// CONTEXT: Stores per-cell control properties (script references, formula-driven properties).
//          The button/checkbox bool in CellStyle handles fast rendering checks;
//          this module stores richer metadata like onSelect scripts and formula properties.

use crate::{
    AppState, format_cell_value_simple, parse_formula, convert_expr, create_multi_sheet_context,
    ast_has_named_refs, resolve_names_in_ast, ast_has_table_refs, resolve_table_refs_in_ast,
    TableRefContext,
};
use engine::{CellValue, Evaluator};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;

// ============================================================================
// Types
// ============================================================================

/// A single property value that can be either a static value or a formula.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPropertyValue {
    /// "static" or "formula"
    pub value_type: String,
    /// The static value or formula string (formulas start with "=")
    pub value: String,
}

/// Metadata for a single control instance at a specific cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlMetadata {
    /// Control type identifier: "button", "checkbox", etc.
    pub control_type: String,
    /// Map of property name to property value.
    /// Common properties: text, fill, color, borderColor, fontSize, onSelect, tooltip
    pub properties: HashMap<String, ControlPropertyValue>,
}

/// Well-known property: is this control PINNED TO THE GRID?
///
/// Excel's Format Object -> Properties expresses the same idea ("Move with
/// cells" vs "Don't move or size with cells"). A boolean rather than an enum
/// because Calcula has only the two behaviours today, and boolean is the
/// vocabulary a user reaches for — "pin this to the grid".
///
/// Stored as an ordinary property, so it persists, travels in a .calp package
/// and is script-visible with no schema change.
pub const PIN_TO_GRID_PROPERTY: &str = "pinToGrid";

/// The properties that place, size or orient a control: what the geometry
/// batch writes (`x`, `y`, `width`, `height`, `offsetX`/`offsetY`), whether
/// it moves with its cells, and its rotation and flips. Writing any of them is
/// an OBJECT EDIT, refused on a sheet whose protection does not allow editing
/// objects (`set_control_property_core`), exactly as a drag is.
pub const GEOMETRY_PROPERTIES: &[&str] = &[
    "x",
    "y",
    "width",
    "height",
    "offsetX",
    "offsetY",
    PIN_TO_GRID_PROPERTY,
    "rotation",
    "flipH",
    "flipV",
];

/// Does this control move when the grid shifts under it?
///
/// * Absent -> YES. Every control authored before this existed is IN-CELL, and
///   an in-cell control's position simply IS its anchor cell, so they all keep
///   behaving exactly as before.
/// * `false` -> no. Floating controls are created with this set explicitly,
///   because a floating control holds a pixel position and should stay put.
/// * Anything unparseable -> YES, failing toward the historical behaviour
///   rather than silently freezing controls in place.
pub fn moves_with_cells(meta: &ControlMetadata) -> bool {
    meta.properties
        .get(PIN_TO_GRID_PROPERTY)
        .map(|p| p.value.parse::<bool>().unwrap_or(true))
        .unwrap_or(true)
}

/// Location key for a control: (sheet_index, row, col)
type ControlKey = (usize, u32, u32);

/// Storage for all controls: (sheet_index, row, col) -> ControlMetadata
pub type ControlStorage = HashMap<ControlKey, ControlMetadata>;

/// A control entry with its location, for returning lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlEntry {
    pub sheet_index: usize,
    pub row: u32,
    pub col: u32,
    pub metadata: ControlMetadata,
}

// ============================================================================
// Persistence (opaque per-sheet payload, keyed by SheetId)
// ============================================================================

/// One persisted control inside a sheet's opaque `SavedSheetControls` payload.
/// In-sheet coordinates only; the sheet association rides on the carrier's
/// SheetId (like conditional formats / data validations).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedControlEntry {
    pub row: u32,
    pub col: u32,
    pub control_type: String,
    pub properties: HashMap<String, ControlPropertyValue>,
}

/// Collect the live control store into per-sheet opaque payloads for the
/// persistence carrier. Sheets without controls produce no entry.
pub fn collect_controls_for_save(
    controls: &ControlStorage,
    sheet_ids: &[identity::SheetId],
) -> Vec<persistence::SavedSheetControls> {
    let mut per_sheet: HashMap<usize, Vec<SavedControlEntry>> = HashMap::new();
    for ((sheet_index, row, col), meta) in controls.iter() {
        per_sheet
            .entry(*sheet_index)
            .or_default()
            .push(SavedControlEntry {
                row: *row,
                col: *col,
                control_type: meta.control_type.clone(),
                properties: meta.properties.clone(),
            });
    }
    let mut saved = Vec::new();
    for (sheet_index, mut entries) in per_sheet {
        let Some(&sheet_id) = sheet_ids.get(sheet_index) else {
            continue;
        };
        // Deterministic artifact bytes across saves (HashMap iteration order
        // would otherwise churn checksums/diffs for identical content).
        entries.sort_by_key(|e| (e.row, e.col));
        if let Ok(value) = serde_json::to_value(&entries) {
            saved.push(persistence::SavedSheetControls {
                sheet_id,
                controls: value,
            });
        }
    }
    // Same determinism for the carrier ordering.
    saved.sort_by_key(|s| s.sheet_id);
    saved
}

/// The `onSelect` control property: INLINE SCRIPT SOURCE. The button door
/// (`scripting::control_action::run_control_action`) reads it from this store
/// and hands it to the QuickJS module runtime, so its value IS code. (The page
/// used to read it in `app/extensions/Controls/index.ts` and
/// `app/extensions/Controls/Button/interceptors.ts`; since phase 4 of BUG-0257
/// a click names only the button.)
pub const ON_SELECT_PROPERTY: &str = "onSelect";

/// The `macroRef` control property: the module id of the recorded macro a button
/// LINKS. A button carrying this runs the CURRENT macro of that id (resolved
/// front-end through @api/macroRunService) — no copied body lives on the button.
/// Mirror of MACRO_REF_PROPERTY in app/src/api/buttonControlService.ts.
pub const MACRO_REF_PROPERTY: &str = "macroRef";

/// EVERY control property whose value can cause CODE TO RUN when the control is
/// clicked. The list is the policy; the checks below only consult it.
///
/// WHY A LIST AND NOT A CHECK. `sanitize_distributed_controls` used to name
/// `onSelect` inline and nothing else, and that was not a smaller version of the
/// same rule — it was a HOLE. `runFloatingButtonClick`
/// (`app/extensions/Controls/index.ts`) checks `macroRef` FIRST and returns, so a
/// pulled button whose `onSelect` had been stripped still ran a macro by id on a
/// single click, through a door the sanitizer had never heard of. The sanitizer
/// exists precisely so a control arriving inside an application cannot act on
/// click; one open door defeats it as completely as two.
///
/// So the executable slots live in ONE place, and the day somebody adds a third
/// way for a control to run code, the pull-side strip, the script-write refusal
/// (`SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS`, app/src/api/scriptHost/validators.ts)
/// and this doc comment are all one edit rather than three that drift.
///
/// NOTE what is NOT here: a `formula`-typed property is evaluated, not executed
/// (`resolve_control_properties` runs it through the sheet evaluator, which has
/// no reach outside the grid), and geometry/paint keys cannot run anything at
/// all. This is the EXECUTION list, not the "publisher-authored" list.
pub const EXECUTABLE_CONTROL_PROPERTIES: &[&str] = &[ON_SELECT_PROPERTY, MACRO_REF_PROPERTY];

/// THE HELD COMPARTMENT (BUG-0257): where a WORKING COPY keeps the button code
/// its application shipped, so an untouched push publishes it unchanged.
///
/// Checkout used to run the subscriber's strip, so every button of an
/// application lost its `onSelect`/`macroRef` on the way into its own working
/// copy -- and the next push published the buttons without it. The code cannot
/// simply stay live either: a checkout cannot tell the developer's own code from
/// a colleague's (or from a version somebody planted), and live code runs on a
/// click. So checkout MOVES each non-empty executable slot into its held key,
/// which NO click path reads, and stamps the control with where it came from
/// (`heldFrom`). The push puts it back on the published carrier only -- never in
/// the live store -- and only when those exact bytes are in the SIGNED base
/// version (`crate::held_button_code`).
///
/// Nothing writes these keys but the admission -- a checkout's, and a subscribe's
/// or refresh's for a macro link whose macro that pull landed (phase 3, where the
/// held link is what the click runs, after the application's approval) and for
/// static inline code (phase 4, run only through the button door after the
/// approval of its exact bytes) -- `move_control`, which carries them, and
/// `adopt_held_button_code` ("Make this my own"), which MOVES them into the live
/// slots after the code was shown: the property door refuses them by name, the metadata door
/// strips them (so paste and duplicate make copies WITHOUT the application's
/// code), and a script may not write them (`SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS`).
pub const HELD_ON_SELECT_PROPERTY: &str = "heldOnSelect";
/// The held twin of [`MACRO_REF_PROPERTY`].
pub const HELD_MACRO_REF_PROPERTY: &str = "heldMacroRef";
/// Which application, workspace and version the held code came with: a JSON
/// [`crate::held_button_code::HeldFrom`], written by Rust at checkout.
pub const HELD_FROM_PROPERTY: &str = "heldFrom";
/// The held slots that carry CODE, one per executable slot, in the same order as
/// `EXECUTABLE_CONTROL_PROPERTIES`.
pub const HELD_CODE_PROPERTIES: &[&str] = &[HELD_ON_SELECT_PROPERTY, HELD_MACRO_REF_PROPERTY];
/// Every key of the held compartment: the code slots and their stamp.
pub const HELD_CONTROL_PROPERTIES: &[&str] =
    &[HELD_ON_SELECT_PROPERTY, HELD_MACRO_REF_PROPERTY, HELD_FROM_PROPERTY];

/// The held slot that keeps `executable`'s code, or `None` for a key that is not
/// an executable slot.
pub fn held_slot_of(executable: &str) -> Option<&'static str> {
    EXECUTABLE_CONTROL_PROPERTIES
        .iter()
        .position(|k| *k == executable)
        .map(|i| HELD_CODE_PROPERTIES[i])
}

/// Is `name` a key of the held compartment?
pub fn is_held_property(name: &str) -> bool {
    HELD_CONTROL_PROPERTIES.contains(&name)
}

/// Does this control carry any held code?
pub fn holds_application_code(meta: &ControlMetadata) -> bool {
    HELD_CODE_PROPERTIES.iter().any(|k| meta.properties.contains_key(*k))
}

/// Strip executable wiring from DISTRIBUTED control payloads before
/// materialization. A control's `onSelect` value is INLINE SCRIPT SOURCE the
/// Controls extension hands to the workbook-script runner, and its `macroRef`
/// re-points the click at any recorded macro by module id — carrying either live
/// from a package would run publisher-chosen code under the subscriber's global
/// script-security gate, bypassing the per-package, hash-keyed consent model
/// that governs every other distributed script. Packaged buttons therefore
/// arrive visually intact but DISARMED; publisher-shipped interactivity flows
/// through consent-gated object scripts instead. (.cala load of the user's own
/// workbook is NOT sanitized — local wiring is the user's own code.)
///
/// The set of slots stripped is `EXECUTABLE_CONTROL_PROPERTIES` and is never
/// re-typed here: see that constant for why.
///
/// AN EMPTY SLOT IS NOT WIRING, and it stays. Every button the Controls recipe
/// writes carries `onSelect: ""`; stripping that changed nothing a click could
/// do and made an untouched working copy differ from the application it was
/// checked out of -- the push preview listed every button as modified (found
/// live 2026-09-29, e2e fixall-calp C1-checkout). Only the EXACTLY empty string
/// is kept: whitespace is non-empty source to the script runner.
///
/// A HELD key a package carries is discarded too (BUG-0257): a package never
/// legitimately ships one -- the held compartment is written by THIS machine's
/// checkout -- and one that arrived would be restored at the next push under
/// the pusher's key. This is the plain strip (no origin to hold anything under);
/// a checkout HOLDS, and a subscribe or refresh holds a link whose macro it
/// landed and the application's static inline code (phase 4: run only through
/// the button door, after the approval of its exact bytes) --
/// `crate::held_button_code::admit_wiring`, the one implementation.
pub fn sanitize_distributed_controls(
    saved: &[persistence::SavedSheetControls],
) -> Vec<persistence::SavedSheetControls> {
    crate::held_button_code::admit_wiring(saved, &crate::held_button_code::DistributedWiring::Strip).0
}

/// Materialize persisted per-sheet control payloads into ControlStorage
/// entries at the sheet indices resolved by `sheet_index_of`. Entries whose
/// sheet cannot be resolved are skipped. Returns the number of controls added.
pub fn materialize_saved_controls(
    saved: &[persistence::SavedSheetControls],
    controls: &mut ControlStorage,
    mut sheet_index_of: impl FnMut(identity::SheetId) -> Option<usize>,
) -> usize {
    let mut added = 0;
    for sheet_controls in saved {
        let Some(idx) = sheet_index_of(sheet_controls.sheet_id) else {
            continue;
        };
        let Ok(entries) =
            serde_json::from_value::<Vec<SavedControlEntry>>(sheet_controls.controls.clone())
        else {
            continue;
        };
        for entry in entries {
            controls.insert(
                (idx, entry.row, entry.col),
                ControlMetadata {
                    control_type: entry.control_type,
                    properties: entry.properties,
                },
            );
            added += 1;
        }
    }
    added
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Get the control metadata for a specific cell.
#[tauri::command]
pub fn get_control_metadata(
    state: State<AppState>,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> Option<ControlMetadata> {
    let controls = state.controls.read().unwrap();
    controls.get(&(sheet_index, row, col)).cloned()
}

/// Hard cap on a single persisted control property value: 64 KiB of characters.
///
/// WHY THIS EXISTS AT ALL. `object.setState` is tier `restricted` with NO
/// capability, and its validator accepts `shape.setProperty` with no key
/// allowlist and no length bound. The chain — contextShims -> host ->
/// the Controls extension -> `set_control_property` -> here — therefore let a
/// restricted, DISTRIBUTED script write an arbitrary multi-megabyte string into
/// persisted document state. A policy sentence somewhere else does not close
/// that; a bound at the door does, and this IS the door for the routes that
/// come through a COMMAND: the UI, the script broker, and MCP all arrive at one
/// of these two.
///
/// IT IS NOT UNIVERSAL, AND SAYING SO HERE IS THE POINT. This comment used to
/// end "…every route (UI, script broker, MCP, `.calp` materialization through
/// `set_control_metadata`) arrives at one of these two commands", and its last
/// term was false: a package pull calls `materialize_saved_controls` DIRECTLY
/// (`calp_commands.rs`, three sites) and never passes through either command,
/// so nothing bounds a distributed property's length. That gap is open-item
/// 1.6, and it is stated here because a doc comment that lies about where a
/// bound applies is exactly how it stayed invisible: the test at
/// `a_control_property_over_the_size_cap_is_refused` already carried the
/// correction while these two doc comments went on asserting the opposite.
///
/// WHY 64 KiB. The largest legitimate value is inline `onSelect` script source;
/// 64 KiB is roughly 1,500 lines, far past anything a button handler needs. A
/// `media:{sha256}` handle is 70 characters. Everything else — text, a colour, a
/// formula — is tens of bytes. The number is chosen to be uninteresting to
/// honest callers and decisive against the megabyte case.
///
/// A refusal here is loud (the command errors, the promise rejects) rather than
/// a silent truncation, because a truncated formula or a truncated script is
/// corrupt data that looks like good data.
pub const MAX_CONTROL_PROPERTY_CHARS: usize = 64 * 1024;

/// `pub(crate)` only so `media.rs`'s distributed clamp can pin its own boundary
/// AGAINST this one rather than restating the number. The two doors must agree on
/// what "too long" means at the exact cap, or a property that is legal when the
/// user authors it locally gets cleared when the same document arrives through a
/// pull. Nothing outside the crate calls this; it is not part of any API surface.
pub(crate) fn check_property_value(name: &str, value: &str) -> Result<(), String> {
    if value.chars().count() > MAX_CONTROL_PROPERTY_CHARS {
        return Err(format!(
            "Control property '{}' is {} characters; the limit is {}. \
             Large binary content belongs in the document's media store \
             (read_media_file), referenced by a media: handle.",
            name,
            value.chars().count(),
            MAX_CONTROL_PROPERTY_CHARS
        ));
    }
    // THE SIZE BOUND IS NOT THE WHOLE DOOR. A decompression bomb is SMALL: a
    // 30,000 x 30,000 single-colour PNG is a few kilobytes, so it clears 64 KiB
    // with room to spare, while every cap that exists to stop it — the byte cap,
    // both dimension caps — lives in `inspect_media`, which a property write
    // never reached. The WebView, which has no caps at all, then decoded it
    // straight off the `data:` URL. Refuse the hazard class here so the
    // migration paths are cleaning up history rather than racing new arrivals.
    //
    // The HAZARD class only. A policy-refused payload (the SVG a legacy document
    // still carries) has to round-trip through a property write unharmed, or
    // editing any other property of that control would destroy its picture.
    if crate::media::is_hazardous_inline_image(value) {
        return Err(format!(
            "Control property '{}' holds an inline image this build refuses to decode \
             (over the byte cap, over a dimension cap, or over the pixel cap). \
             A picture enters a document through Insert > Image, which validates it \
             host-side and yields a media: handle.",
            name
        ));
    }
    Ok(())
}

/// May a property write proceed, given the type the control ALREADY has and the
/// type the caller passed?
///
/// * existing, caller says nothing        -> yes (the ordinary property write)
/// * existing, caller agrees              -> yes
/// * existing, caller DISAGREES           -> NO. This was the corruption.
/// * absent, caller names a type          -> yes (creation)
/// * absent, caller says nothing          -> no, there is nothing to create
fn check_control_type_transition(
    existing: Option<&str>,
    requested: &str,
) -> Result<(), String> {
    match existing {
        Some(current) if !requested.is_empty() && current != requested => Err(format!(
            "this is a '{}'; a property write cannot change it to a '{}'. \
             Delete the control and create the new one.",
            current, requested
        )),
        Some(_) => Ok(()),
        None if requested.is_empty() => Err(
            "no control exists here, and no controlType was supplied to create one."
                .to_string(),
        ),
        None => Ok(()),
    }
}

/// Set a single property on a control. Creates the control metadata if it doesn't exist.
///
/// A control's TYPE is immutable after creation. It used to be overwritten with
/// whatever the caller passed, and that was a live corruption path rather than a
/// theoretical one: the shape property handler hardcodes `"shape"`, so a single
/// script property write against an IMAGE control silently converted it to a
/// shape and it stopped rendering — with the backend reporting success. The type
/// decides which renderer owns the cell, so it is decided once, at creation, by
/// the code that builds the control.
///
/// `replace_held` (optional; absent = `false`) is the Properties pane's
/// "Remove the application's code" step, sent only after `confirmAsync` has
/// shown the held code: with it, an EMPTY write to a code slot of a button that
/// holds its application's code is a real edit -- it discards the held
/// compartment as one undoable "Change button code" step -- instead of the
/// tab-through no-op. Without some such gesture a developer could not remove an
/// application button's action at all: the empty write was ignored and the next
/// push restored the code. It widens nothing a script could not already do (a
/// non-empty code write replaces the held code too); held keys stay unwritable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn set_control_property(
    state: State<AppState>,
    file_state: State<FileState>,
    sheet_index: usize,
    row: u32,
    col: u32,
    control_type: String,
    property_name: String,
    value_type: String,
    value: String,
    replace_held: Option<bool>,
) -> Result<ControlMetadata, String> {
    set_control_property_with(
        &state,
        &file_state,
        sheet_index,
        row,
        col,
        control_type,
        property_name,
        value_type,
        value,
        replace_held.unwrap_or(false),
    )
}

/// [`set_control_property`] over plain references, for the unit tier.
#[allow(clippy::too_many_arguments)]
pub(crate) fn set_control_property_core(
    state: &AppState,
    file_state: &FileState,
    sheet_index: usize,
    row: u32,
    col: u32,
    control_type: String,
    property_name: String,
    value_type: String,
    value: String,
) -> Result<ControlMetadata, String> {
    set_control_property_with(
        state, file_state, sheet_index, row, col, control_type, property_name, value_type, value, false,
    )
}

/// [`set_control_property_core`] with the "Remove the application's code"
/// flag (see [`set_control_property`]).
#[allow(clippy::too_many_arguments)]
pub(crate) fn set_control_property_with(
    state: &AppState,
    file_state: &FileState,
    sheet_index: usize,
    row: u32,
    col: u32,
    control_type: String,
    property_name: String,
    value_type: String,
    value: String,
    replace_held: bool,
) -> Result<ControlMetadata, String> {
    // THE HELD COMPARTMENT IS NOBODY'S TO WRITE (BUG-0257). It holds an
    // application's button code, and whatever sits there is published at the
    // next push -- under the pusher's key, once it has been matched against the
    // signed base. A door that could write it would let the caller stage code
    // for that publish. It changes only by checkout (Rust), by an author's own
    // write to the live slot (below), and by deleting the control.
    if is_held_property(&property_name) {
        return Err(format!(
            "'{}' holds button code that came with an application and is published \
             unchanged at the next push; nothing may write it. To use your own code on \
             this button, replace the application's code in the Properties pane.",
            property_name
        ));
    }
    check_property_value(&property_name, &value)?;

    // MOVING, RESIZING, PINNING, ROTATING OR FLIPPING a control is an object
    // edit whether it arrives as a geometry batch or as one property at a time
    // (wave-B fix-up): `set_control_geometry` refuses a drag on a sheet whose
    // protection does not allow editing objects, and this door used to write
    // the same keys anyway -- the Properties pane's Width/Height and a script's
    // geometry writes resized the button the drag was refused for. Refused
    // before the store is locked (the gate takes its own locks) and before the
    // effect. Every other property of an EXISTING control (a caption, a
    // colour) is not an object edit.
    if GEOMETRY_PROPERTIES.contains(&property_name.as_str()) {
        crate::protection::check_sheet_action(state, sheet_index, "editObjects", "move, resize or rotate a control")?;
    }

    // The `editObjects` answer for a CREATE (wave-B B5), computed before the
    // store is locked -- the gate takes its own locks, as in the geometry
    // batch -- and applied below only when this write creates the control. An
    // existing control's property write is not an object insert.
    let create_gate =
        crate::protection::check_sheet_action(state, sheet_index, "editObjects", "insert a control");

    // Gate, then decide, WITHOUT releasing the lock in between: Tauri dispatches
    // commands on a thread pool, so a read()-drop-write() pair would leave a
    // TOCTOU window in which another command changes the control's type between
    // the check and the write. `lock_pending()` holds the mutex across both, and
    // `authorize(&effect)` is the only route from it to `&mut` -- so the
    // gate-before-dirty ORDER is the only order the types accept.
    let key = (sheet_index, row, col);
    let pending = state.controls.lock_pending().map_err(|e| e.to_string())?;
    check_control_type_transition(
        pending.get(&key).map(|m| m.control_type.as_str()),
        &control_type,
    )
    .map_err(|why| format!("Control at sheet {} r{}c{}: {}", sheet_index, row, col, why))?;
    if !pending.contains_key(&key) {
        create_gate?;
    }

    // AN EXECUTABLE SLOT (onSelect, macroRef) is the button's CODE, and two
    // writes of it change nothing (BUG-0257):
    //
    // * "" into an ABSENT slot of a button that holds its application's code.
    //   The Properties pane commits its code field on blur, and on such a
    //   button that field reads "" -- so tabbing THROUGH it used to be an
    //   author edit that replaced the application's code with nothing, and the
    //   next push published the button empty. That is BUG-0257's own outcome
    //   from an everyday gesture, so the write is a no-op here, whatever sent it.
    // * the value the slot already has.
    //
    // Both return BEFORE the effect: nothing dirtied, no undo step.
    //
    // ...UNLESS the caller is the explicit "Remove the application's code" step
    // (`replace_held`), which has shown the held code and been confirmed: then
    // the empty write discards the held compartment below, undoably.
    let executable = EXECUTABLE_CONTROL_PROPERTIES.contains(&property_name.as_str());
    if executable {
        if let Some(existing) = pending.get(&key) {
            let live = existing.properties.get(&property_name);
            let removes_held = replace_held && holds_application_code(existing);
            let tab_through = value.is_empty() && live.is_none() && holds_application_code(existing);
            let unchanged = live.is_some_and(|p| p.value_type == value_type && p.value == value);
            if !removes_held && (tab_through || unchanged) {
                return Ok(existing.clone());
            }
        }
    }
    // A CODE WRITE IS UNDOABLE. It was the one property write that could destroy
    // work Ctrl+Z could not bring back -- the application's held code among it.
    let previous: Option<Vec<(ControlKey, ControlMetadata)>> =
        executable.then(|| pending.iter().map(|(k, v)| (*k, v.clone())).collect());

    // Control metadata is persisted (`workbook.controls`) -- onSelect wiring and
    // formula-driven properties -- and written only by the save path.
    let effect = DocumentEffect::mutates(&file_state);
    let updated = {
        let mut controls = pending.authorize(&effect);

        let metadata = controls.entry(key).or_insert_with(|| ControlMetadata {
            control_type: control_type.clone(),
            properties: HashMap::new(),
        });

        metadata.properties.insert(
            property_name,
            ControlPropertyValue { value_type, value },
        );
        // THE AUTHOR'S CODE REPLACES THE APPLICATION'S, WHOLE. A button runs one
        // action (a click checks `macroRef` first, then `onSelect`), so keeping
        // the application's other held slot would publish a button whose action
        // is half theirs and half the author's. The Properties pane reaches this
        // only after "Replace the application's code" has shown the held code.
        if executable {
            for held in HELD_CONTROL_PROPERTIES {
                metadata.properties.remove(*held);
            }
        }
        metadata.clone()
    };
    // The store guard is dropped before the undo stack is taken (never both).
    if let Some(previous) = previous {
        crate::undo_commands::record_controls_undo(state, previous, "Change button code");
    }
    Ok(updated)
}

/// Set the full control metadata for a cell (replaces existing).
///
/// This is control CREATION (and wholesale replacement), so it is the one door
/// that legitimately decides a type. The same per-property size bound applies:
/// it is the route the floating-control builders use, so leaving it unbounded
/// would leave the megabyte case open under a different name.
///
/// `.calp` MATERIALIZATION DOES NOT COME THROUGH HERE — this comment used to
/// say it did. A package pull calls `materialize_saved_controls` directly, so
/// the bound below never sees a distributed property. See
/// `MAX_CONTROL_PROPERTY_CHARS` and open-item 1.6.
#[tauri::command]
pub fn set_control_metadata(
    state: State<AppState>,
    file_state: State<FileState>,
    sheet_index: usize,
    row: u32,
    col: u32,
    metadata: ControlMetadata,
) -> Result<ControlMetadata, String> {
    set_control_metadata_core(&state, &file_state, sheet_index, row, col, metadata)
}

/// [`set_control_metadata`] over plain references, for the unit tier.
pub(crate) fn set_control_metadata_core(
    state: &AppState,
    file_state: &FileState,
    sheet_index: usize,
    row: u32,
    col: u32,
    metadata: ControlMetadata,
) -> Result<ControlMetadata, String> {
    // A CONTROL CREATED HERE HOLDS NO APPLICATION CODE (BUG-0257). This is the
    // door paste, duplicate and every insert take, and the renderer sends it
    // whatever map it read -- a copied button's held keys included. Copies are
    // the author's own buttons: carrying the application's code into one would
    // publish it at a cell the signed base never had it at, and letting a caller
    // WRITE held keys here would let it stage code for the next signed push. So
    // they are dropped, not refused (a paste of a held button still pastes the
    // button). Moving a held button keeps its code: that is `move_control`.
    let mut metadata = metadata;
    for held in HELD_CONTROL_PROPERTIES {
        metadata.properties.remove(*held);
    }
    for (name, prop) in &metadata.properties {
        check_property_value(name, &prop.value)?;
    }
    if metadata.control_type.is_empty() {
        return Err("A control must have a controlType.".to_string());
    }
    // `editObjects`, like `delete_chart` and the geometry batch (wave-B B5):
    // creating or replacing a control on a sheet whose protection does not
    // allow editing objects is refused, before the effect.
    crate::protection::check_sheet_action(state, sheet_index, "editObjects", "insert or replace a control")?;

    // Control metadata is persisted (`workbook.controls`) -- onSelect wiring and
    // formula-driven properties -- and written only by the save path.
    //
    // UNDO. This is the creation door, so the PRE-mutation store is the undo
    // snapshot; captured under a read guard before `mutates` constructs, and
    // recorded after the write guard is dropped (the undo stack is taken after
    // the store, never while holding it -- see `record_controls_undo`).
    let previous: Vec<((usize, u32, u32), ControlMetadata)> = state
        .controls
        .read()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|(k, v)| (*k, v.clone()))
        .collect();
    let effect = DocumentEffect::mutates(&file_state);
    {
        let mut controls = state.controls.write(&effect).map_err(|e| e.to_string())?;
        controls.insert((sheet_index, row, col), metadata.clone());
    }
    crate::undo_commands::record_controls_undo(&state, previous, "Add control");
    Ok(metadata)
}

/// Remove control metadata for a specific cell.
///
/// `Ok(false)` when no control is there; `Err` when the removal is REFUSED
/// (see [`remove_control_metadata_core`]), so a caller never tears down what
/// hangs off a control the backend kept.
#[tauri::command]
pub fn remove_control_metadata(
    state: State<AppState>,
    file_state: State<FileState>,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> Result<bool, String> {
    remove_control_metadata_core(&state, &file_state, sheet_index, row, col)
}

/// [`remove_control_metadata`] over plain references, for the unit tier.
pub(crate) fn remove_control_metadata_core(
    state: &AppState,
    file_state: &FileState,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> Result<bool, String> {
    // REFUSAL FIRST. Removing a control that is not there changes nothing, so it
    // must neither dirty the document nor push an undo entry -- an undo step
    // that restores the state it was recorded in makes Ctrl+Z a no-op the user
    // has to press twice. Resolved under a READ guard, before
    // `DocumentEffect::mutates` sets the flag in its constructor.
    let previous: Vec<((usize, u32, u32), ControlMetadata)> = {
        let store = state.controls.read().map_err(|e| e.to_string())?;
        if !store.contains_key(&(sheet_index, row, col)) {
            return Ok(false);
        }
        store.iter().map(|(k, v)| (*k, v.clone())).collect()
    };
    // `editObjects` (wave-B B5), taken with the store released -- the gate
    // takes its own locks -- and before the effect.
    crate::protection::check_sheet_action(state, sheet_index, "editObjects", "delete a control")?;

    // Control metadata is persisted (`workbook.controls`) -- onSelect wiring and
    // formula-driven properties -- and written only by the save path.
    let effect = DocumentEffect::mutates(file_state);
    let removed = {
        let mut controls = state.controls.write(&effect).unwrap();
        controls.remove(&(sheet_index, row, col)).is_some()
    };
    if removed {
        crate::undo_commands::record_controls_undo(state, previous, "Delete control");
    }
    Ok(removed)
}

/// Move a control to another anchor cell on the same sheet, WITH every property
/// it has -- the held compartment included -- as ONE undoable step.
///
/// WHY IT EXISTS (BUG-0257). The floating -> in-cell toggle used to re-create
/// the button at its new cell (`set_control_metadata`) and delete the old one.
/// That door strips the held compartment, as it must (it is the paste door), so
/// every toggled button of a working copy lost its application's code and the
/// next push published it empty. A MOVE is not a copy: the button is the same
/// button, and so is its code.
///
/// `properties` are written over the moved control in the same step (the
/// toggle's `embedded`/`pinToGrid`). They may not name an executable or held
/// key: a move never writes code.
///
/// Refused BEFORE the effect, with nothing written: an override naming a code
/// key or over the size bound, a protected sheet whose options do not allow
/// editing objects, no control at `from`, and ANOTHER control at `to` (the
/// re-create this replaces overwrote it silently). `from == to` only applies the
/// overrides.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn move_control(
    state: State<AppState>,
    file_state: State<FileState>,
    sheet_index: usize,
    from_row: u32,
    from_col: u32,
    to_row: u32,
    to_col: u32,
    properties: Option<HashMap<String, ControlPropertyValue>>,
) -> Result<ControlMetadata, String> {
    move_control_core(
        &state,
        &file_state,
        sheet_index,
        (from_row, from_col),
        (to_row, to_col),
        properties.unwrap_or_default(),
    )
}

/// [`move_control`] over plain references, for the unit tier.
pub(crate) fn move_control_core(
    state: &AppState,
    file_state: &FileState,
    sheet_index: usize,
    from: (u32, u32),
    to: (u32, u32),
    overrides: HashMap<String, ControlPropertyValue>,
) -> Result<ControlMetadata, String> {
    for (name, prop) in &overrides {
        if EXECUTABLE_CONTROL_PROPERTIES.contains(&name.as_str()) || is_held_property(name) {
            return Err(format!(
                "Moving a control carries its code as it is; a move may not write '{}'.",
                name
            ));
        }
        check_property_value(name, &prop.value)?;
    }
    crate::protection::check_sheet_action(state, sheet_index, "editObjects", "move a control")?;

    let from_key = (sheet_index, from.0, from.1);
    let to_key = (sheet_index, to.0, to.1);
    let pending = state.controls.lock_pending().map_err(|e| e.to_string())?;
    let Some(existing) = pending.get(&from_key) else {
        return Err(format!(
            "No control at sheet {} r{}c{}; nothing was moved.",
            sheet_index, from.0, from.1
        ));
    };
    if to_key != from_key && pending.contains_key(&to_key) {
        return Err(format!(
            "Another control already sits at sheet {} r{}c{}; move or delete it first. Nothing was moved.",
            sheet_index, to.0, to.1
        ));
    }
    let mut moved = existing.clone();
    for (name, prop) in overrides {
        moved.properties.insert(name, prop);
    }
    let previous: Vec<(ControlKey, ControlMetadata)> =
        pending.iter().map(|(k, v)| (*k, v.clone())).collect();

    // Control metadata is persisted (`workbook.controls`).
    let effect = DocumentEffect::mutates(file_state);
    {
        let mut controls = pending.authorize(&effect);
        controls.remove(&from_key);
        controls.insert(to_key, moved.clone());
    }
    // ITS OBJECT SCRIPTS MOVE WITH IT. A button's scripts find it by the id
    // DERIVED from its anchor (`control-<sheet>-<row>-<col>`), and the rule
    // everywhere else a control changes cells (`shift_controls`,
    // `remap_sheet_keyed_stores`) is that the binding follows in lockstep. The
    // toggle's move did not: a toggled button's script -- an application's
    // DISTRIBUTED script in a working copy included -- stayed bound to the old,
    // now empty anchor, and the next push shipped it unbound (review finding;
    // the same loss BUG-0257 fixed for held code, through the same toggle).
    // Taken after the store guard is released, never nested with it.
    let previous_ids: Vec<(String, Option<String>)> = if from_key != to_key {
        rekey_control_bindings(
            state,
            &effect,
            &crate::controls::control_instance_id(sheet_index, from.0, from.1),
            &crate::controls::control_instance_id(sheet_index, to.0, to.1),
        )
    } else {
        Vec::new()
    };
    // The store guards are dropped before the undo stack is taken (never both).
    // Undo puts the control AND each binding back.
    crate::undo_commands::record_controls_undo_with_scripts(state, previous, previous_ids, "Move control");
    Ok(moved)
}

/// "MAKE THIS MY OWN" (phase 4 of BUG-0257): the ONE way an application's
/// button code becomes code of the user's own. The Properties pane shows the
/// held code, asks (`confirmAsync`), and sends back exactly what it showed;
/// this MOVES it into the live slots, as one undoable step, always audited.
///
/// Why only this: paste, duplicate and the floating/in-cell toggle re-create a
/// button at another cell, so an ownership tag would be dropped there without a
/// word and an application's code would run as the user's own. So the held
/// compartment is never copied anywhere, and the only route out of it is this
/// explicit step that showed the code first (owner decision Q4: button
/// CONTROLS only -- a button CELL's held action keeps its remedy, "give it an
/// action of your own", because dropping its stamp would WIDEN what it runs).
///
/// Main window only. Denylisted for non-trusted callers under `codeExecution`
/// (backendCommands.ts): code adopted here runs with no approval.
///
/// A held macro LINK is adopted only when it names a macro OF THE STAMP'S
/// APPLICATION in this workbook (review of M6b). An adopted link is live, and
/// a live link runs whatever module carries its id, with no `requirePackage`
/// (the click reads it as the author's own); at a checkout EVERY link is held,
/// including ids the application never shipped, so such an id could name a
/// macro of the developer's own -- which would then run with no approval while
/// the confirm promised "the macro it runs stays the application's, and still
/// runs only after you approve the application's code".
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn adopt_held_button_code(
    state: State<AppState>,
    file_state: State<FileState>,
    script_state: State<crate::scripting::types::ScriptState>,
    sheet_index: usize,
    row: u32,
    col: u32,
    shown_on_select: Option<String>,
    shown_macro_ref: Option<String>,
    window: tauri::Window,
) -> Result<ControlMetadata, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // The stored modules as (application, id), read and released BEFORE the
    // control store is taken (the store guard is the critical section).
    let modules: Vec<(Option<String>, String)> = {
        let map = script_state.workbook_scripts.read().map_err(|e| e.to_string())?;
        map.values().map(|s| (s.source_package.clone(), s.id.clone())).collect()
    };
    adopt_held_button_code_core(
        &state,
        &file_state,
        &modules,
        sheet_index,
        (row, col),
        shown_on_select.as_deref(),
        shown_macro_ref.as_deref(),
    )
}

/// Why a held macro link may NOT be adopted, or `None` when it names a macro
/// of the stamp's application (`modules`: the stored modules as
/// `(application, id)`). Completes "The button at <cell> ...".
fn held_link_refusal(
    modules: &[(Option<String>, String)],
    stamp: Option<&crate::held_button_code::HeldFrom>,
    macro_id: &str,
) -> Option<String> {
    let Some(stamp) = stamp else {
        return Some(format!(
            "links the macro '{macro_id}', but its record of which application it came with cannot be read, so \
             there is no way to tell whether that macro is the application's"
        ));
    };
    let owner = modules.iter().find(|(_, id)| id == macro_id).map(|(pkg, _)| pkg.as_deref().filter(|p| !p.trim().is_empty()));
    match owner {
        Some(Some(app)) if app == stamp.application => None,
        Some(Some(other)) => Some(format!(
            "links the macro '{macro_id}', which came with the application '{other}', not with '{}'",
            stamp.application
        )),
        Some(None) => Some(format!(
            "links the macro '{macro_id}', which is a macro of your own, not one of the application '{}'",
            stamp.application
        )),
        None => Some(format!(
            "links the macro '{macro_id}', and no macro of the application '{}' with that id is in this workbook",
            stamp.application
        )),
    }
}

/// [`adopt_held_button_code`] over plain references, for the unit tier.
///
/// Refused BEFORE the effect, with nothing written, when: there is no control;
/// it is not a button; nothing is held; the held code is not what the dialog showed (it changed
/// after it was shown -- the TOCTOU the shown texts close); the button
/// already has live code of the user's own (adopting would silently replace
/// it); or a held macro link does not name a macro of the stamp's application
/// in `modules` (the stored modules as `(application, id)`; review of M6b).
/// The gate and the write are ONE critical section (`lock_pending`).
pub(crate) fn adopt_held_button_code_core(
    state: &AppState,
    file_state: &FileState,
    modules: &[(Option<String>, String)],
    sheet_index: usize,
    at: (u32, u32),
    shown_on_select: Option<&str>,
    shown_macro_ref: Option<&str>,
) -> Result<ControlMetadata, String> {
    let (row, col) = at;
    // The sheet name for the sentences and the row, cloned BEFORE the store is
    // taken (the canonical sheet-then-controls order).
    let sheet_name = state
        .sheet_names
        .read()
        .map_err(|e| e.to_string())?
        .get(sheet_index)
        .cloned()
        .unwrap_or_else(|| format!("Sheet{}", sheet_index + 1));
    let cell = format!("{}!{}", sheet_name, crate::held_button_code::a1(row, col));
    let key = (sheet_index, row, col);

    let pending = state.controls.lock_pending().map_err(|e| e.to_string())?;
    let Some(existing) = pending.get(&key) else {
        return Err(format!("There is no control at {cell}; nothing was changed."));
    };
    // Owner decision Q4: button CONTROLS only. The admission holds ANY
    // control's code for a faithful push, and only a button runs code when it
    // is clicked (the door refuses the rest as `notAButton`) -- so moving a
    // shape's held code into its live slot would arm nothing the user can
    // review on a click, and drop the stamp that keeps it the application's.
    if existing.control_type != "button" {
        return Err(format!(
            "The control at {cell} is a '{}', not a button. Only a button's code can be made your own; nothing \
             was changed.",
            existing.control_type
        ));
    }
    let held = |k: &str| existing.properties.get(k).map(|p| p.value.clone()).filter(|v| !v.is_empty());
    let held_on_select = held(HELD_ON_SELECT_PROPERTY);
    let held_macro_ref = held(HELD_MACRO_REF_PROPERTY);
    if held_on_select.is_none() && held_macro_ref.is_none() {
        return Err(format!(
            "The button at {cell} holds no code that came with an application; nothing was changed."
        ));
    }
    let shown = |s: Option<&str>| s.filter(|v| !v.is_empty()).map(str::to_string);
    if held_on_select != shown(shown_on_select) || held_macro_ref != shown(shown_macro_ref) {
        return Err(format!(
            "The application's code on the button at {cell} changed after it was shown; nothing was changed. \
             Review it again before making it your own."
        ));
    }
    if EXECUTABLE_CONTROL_PROPERTIES
        .iter()
        .any(|k| existing.properties.get(*k).is_some_and(|p| !p.value.is_empty()))
    {
        return Err(format!(
            "The button at {cell} already runs code of your own, so the application's code was not moved \
             over it; nothing was changed."
        ));
    }
    let stamp = existing.properties.get(HELD_FROM_PROPERTY).and_then(|p| crate::held_button_code::HeldFrom::decode(&p.value));
    // A HELD MACRO LINK stays the application's macro once adopted only if it
    // names one (review of M6b): adopted, it is a live link, which runs
    // whatever module carries its id with no application asked for.
    if let Some(macro_id) = &held_macro_ref {
        if let Some(why) = held_link_refusal(modules, stamp.as_ref(), macro_id) {
            return Err(format!(
                "The button at {cell} {why}. Made your own, the link would run that macro with no approval, so the \
                 application's code was not moved; nothing was changed. To run a macro of your own from this \
                 button, replace the application's code instead."
            ));
        }
    }
    let caption = existing.properties.get("text").map(|p| p.value.clone()).unwrap_or_default();
    let previous: Vec<(ControlKey, ControlMetadata)> = pending.iter().map(|(k, v)| (*k, v.clone())).collect();

    // Every gate has passed: control metadata is persisted, so the document is
    // dirty from here.
    let effect = DocumentEffect::mutates(file_state);
    let mut moved: Vec<serde_json::Value> = Vec::new();
    let adopted = {
        let mut controls = pending.authorize(&effect);
        let meta = controls.get_mut(&key).ok_or_else(|| format!("There is no control at {cell}."))?;
        for (live, held_key, value) in [
            (ON_SELECT_PROPERTY, HELD_ON_SELECT_PROPERTY, &held_on_select),
            (MACRO_REF_PROPERTY, HELD_MACRO_REF_PROPERTY, &held_macro_ref),
        ] {
            // A MOVE, not a copy: a held twin left behind would fight the
            // adopted bytes at the next push.
            meta.properties.remove(held_key);
            if let Some(value) = value {
                let value_type = stamp.as_ref().map_or("static", |s| s.value_type_of(live)).to_string();
                moved.push(serde_json::json!({
                    "slot": live,
                    "valueType": value_type,
                    "sha256": calp::integrity::sha256_hex(value.as_bytes()),
                }));
                meta.properties.insert(live.to_string(), ControlPropertyValue { value_type, value: value.clone() });
            }
        }
        meta.properties.remove(HELD_FROM_PROPERTY);
        meta.clone()
    };
    // The store guard is dropped before the undo stack is taken (never both).
    crate::undo_commands::record_controls_undo(state, previous, "Make button code my own");

    let (application, version) = stamp.map(|s| (s.application, s.version)).unwrap_or_default();
    let mut extra: HashMap<String, serde_json::Value> = HashMap::new();
    extra.insert("application".into(), serde_json::Value::from(application.clone()));
    extra.insert("version".into(), serde_json::Value::from(version));
    extra.insert("cell".into(), serde_json::Value::from(cell.clone()));
    extra.insert("caption".into(), serde_json::Value::from(caption));
    extra.insert("moved".into(), serde_json::Value::from(moved));
    if application.is_empty() {
        extra.insert("stampUnreadable".into(), serde_json::Value::from(true));
    }
    crate::calp_commands::record_audit_event_with_extra(
        state,
        calp::audit::AuditEvent::ButtonCodeAdopted,
        format!(
            "Made the code of the button at {cell} your own{}: it now runs as your own code, with no approval",
            if application.is_empty() { String::new() } else { format!(" (it came with '{application}')") }
        ),
        extra,
    );
    Ok(adopted)
}

/// The object-script binding id of the control at (sheet, row, col) -- the
/// frontend's `makeFloatingControlId`, and `shift_controls`' derivation.
pub(crate) fn control_instance_id(sheet_index: usize, row: u32, col: u32) -> String {
    format!("control-{}-{}-{}", sheet_index, row, col)
}

/// Re-point every object script bound to `from_id` at `to_id`. Returns
/// (script id, the binding it had) for the undo payload.
fn rekey_control_bindings(
    state: &AppState,
    effect: &DocumentEffect,
    from_id: &str,
    to_id: &str,
) -> Vec<(String, Option<String>)> {
    let Ok(mut scripts) = state.object_scripts.write(effect) else { return Vec::new() };
    let mut previous = Vec::new();
    for script in scripts.iter_mut() {
        if script.instance_id.as_deref() == Some(from_id) {
            previous.push((script.id.clone(), script.instance_id.clone()));
            script.instance_id = Some(to_id.to_string());
        }
    }
    previous
}

// ============================================================================
// Geometry batch (move / resize / arrange)
// ============================================================================

/// Encode a geometry number the way the Controls extension always has:
/// `String(Math.round(v))`. `Math.round` rounds half toward +infinity, which is
/// `floor(v + 0.5)` -- NOT Rust's `f64::round` (half away from zero), which
/// would store `-3` where the extension stores `-2` for `-2.5`. The `i64`
/// conversion also turns JavaScript's `-0` into `"0"`, as `String(-0)` does.
fn geometry_value(v: f64) -> String {
    format!("{}", (v + 0.5).floor() as i64)
}

/// Validate a geometry batch and turn each change into the property writes it
/// stands for, in the extension's spelling (`x`, `y`, `width`, `height`, and
/// `offsetX`/`offsetY` for a pinned control). Pure: every refusal here happens
/// before any lock is taken or any effect is minted.
fn encode_geometry_changes(
    changes: &[crate::api_types::ControlGeometryChange],
) -> Result<Vec<(ControlKey, Vec<(&'static str, String)>)>, String> {
    let mut seen: HashSet<ControlKey> = HashSet::new();
    let mut out = Vec::with_capacity(changes.len());
    for change in changes {
        let key = (change.sheet_index, change.row, change.col);
        let at = format!("sheet {} r{}c{}", change.sheet_index, change.row, change.col);
        if !seen.insert(key) {
            return Err(format!(
                "Control at {} appears twice in one geometry batch; send one change per control.",
                at
            ));
        }
        let mut numbers = vec![
            ("x", change.x),
            ("y", change.y),
            ("width", change.width),
            ("height", change.height),
        ];
        match (change.offset_x, change.offset_y) {
            (None, None) => {}
            (Some(ox), Some(oy)) => {
                numbers.push(("offsetX", ox));
                numbers.push(("offsetY", oy));
            }
            _ => {
                return Err(format!(
                    "Control at {}: offsetX and offsetY travel together; the batch named only one.",
                    at
                ))
            }
        }
        let mut writes = Vec::with_capacity(numbers.len());
        for (name, value) in numbers {
            if !value.is_finite() {
                return Err(format!("Control at {}: {} is not a finite number.", at, name));
            }
            writes.push((name, geometry_value(value)));
        }
        // A size that rounds to zero paints NOTHING while the backend reports
        // success -- the invisible-control failure the Seam Rule was written for.
        for (name, value) in [("width", change.width), ("height", change.height)] {
            if (value + 0.5).floor() < 1.0 {
                return Err(format!(
                    "Control at {}: {} {} is smaller than 1 px.",
                    at, name, value
                ));
            }
        }
        out.push((key, writes));
    }
    Ok(out)
}

/// Move and/or resize SEVERAL floating controls as ONE undoable step.
///
/// The Controls extension persisted a move as four to six `set_control_property`
/// calls per control -- none of them undoable, so dragging a shape or a button
/// was invisible to Ctrl+Z, and a group move of N controls was up to 6N
/// independent backend writes. This is the batch: one snapshot of the store,
/// one write, ONE `record_controls_undo(previous, "Move control")`, which joins
/// a transaction the caller already has open (a cross-family arrange stays one
/// Ctrl+Z).
///
/// Refused, BEFORE the effect and with nothing written: a malformed change
/// (non-finite value, size under 1 px, a lone offset, the same control twice),
/// a protected sheet whose options do not allow editing objects, and any change
/// naming a control that does not exist -- the batch never creates one, and one
/// unknown anchor refuses the whole batch rather than moving the others.
/// Values already stored exactly as requested are skipped; a batch that
/// changes nothing leaves the document clean and records no undo step.
///
/// Returns how many controls actually changed.
#[tauri::command]
pub fn set_control_geometry(
    state: State<AppState>,
    file_state: State<FileState>,
    changes: Vec<crate::api_types::ControlGeometryChange>,
) -> Result<usize, String> {
    set_control_geometry_core(&state, &file_state, &changes)
}

/// [`set_control_geometry`] over plain references, for the unit tier.
pub(crate) fn set_control_geometry_core(
    state: &AppState,
    file_state: &FileState,
    changes: &[crate::api_types::ControlGeometryChange],
) -> Result<usize, String> {
    let encoded = encode_geometry_changes(changes)?;
    if encoded.is_empty() {
        return Ok(0);
    }

    // `editObjects` on every sheet the batch touches, before any lock or effect.
    let mut sheets: Vec<usize> = encoded.iter().map(|((sheet, _, _), _)| *sheet).collect();
    sheets.sort_unstable();
    sheets.dedup();
    for sheet in sheets {
        crate::protection::check_sheet_action(state, sheet, "editObjects", "move or resize a control")?;
    }

    // Resolve, decide and write under ONE hold of the store (`lock_pending`),
    // so the snapshot that becomes the undo payload is exactly what the write
    // replaces and no other command can slip in between.
    let pending = state.controls.lock_pending().map_err(|e| e.to_string())?;
    if let Some(((sheet, row, col), _)) = encoded.iter().find(|(key, _)| !pending.contains_key(key)) {
        return Err(format!(
            "No control at sheet {} r{}c{}; nothing in the batch was moved.",
            sheet, row, col
        ));
    }
    let changed: Vec<&(ControlKey, Vec<(&'static str, String)>)> = encoded
        .iter()
        .filter(|(key, writes)| {
            let meta = &pending[key];
            writes.iter().any(|(name, value)| {
                meta.properties
                    .get(*name)
                    .map_or(true, |p| p.value_type != "static" || p.value != *value)
            })
        })
        .collect();
    if changed.is_empty() {
        return Ok(0);
    }
    let previous: Vec<(ControlKey, ControlMetadata)> =
        pending.iter().map(|(k, v)| (*k, v.clone())).collect();

    // Control metadata is persisted (`workbook.controls`).
    let effect = DocumentEffect::mutates(file_state);
    {
        let mut controls = pending.authorize(&effect);
        for (key, writes) in &changed {
            if let Some(meta) = controls.get_mut(key) {
                for (name, value) in writes {
                    meta.properties.insert(
                        (*name).to_string(),
                        ControlPropertyValue { value_type: "static".to_string(), value: value.clone() },
                    );
                }
            }
        }
    }
    // The store guard is dropped before the undo stack is taken (never both).
    crate::undo_commands::record_controls_undo(state, previous, "Move control");
    Ok(changed.len())
}

/// A button that links a macro, located for a human-readable deletion warning.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroLinkingControl {
    pub sheet_index: usize,
    /// The sheet's display name, resolved here so the frontend need not.
    pub sheet_name: String,
    pub row: u32,
    pub col: u32,
    /// The application whose HELD link this is (BUG-0257): the button came with
    /// that application's code, which a working copy keeps inert and publishes
    /// unchanged at the next push. `None` for a live link of the author's own.
    #[serde(default)]
    pub held_by: Option<String>,
    /// A button CONTROL's `macroRef`, or a button CELL's script action.
    pub kind: crate::held_button_code::MacroLinkKind,
    /// What the button says on screen: a control's `text`, a cell's `label`.
    /// Empty when it says nothing.
    #[serde(default)]
    pub caption: String,
    /// The application the button CAME WITH, read from this machine's own stamp
    /// (a control's `heldFrom`, a button cell's `fromApplication` -- live or
    /// held), for the approval screen's "Buttons that run this macro" (phase 3).
    /// `None` for a button of the author's own, and for a stamp that cannot be
    /// read: an unreadable stamp vouches for nothing.
    #[serde(default)]
    pub application: Option<String>,
}

/// Every control whose `macroRef` -- live OR held -- equals `macro_id`, across
/// all sheets.
///
/// Backs the delete-a-macro warning: deleting a macro that ≥1 button links must
/// name those buttons rather than silently orphaning them. The scan lives here
/// because the backend already holds control metadata for every sheet; the
/// frontend would otherwise reassemble it from per-sheet lists.
///
/// THE HELD LINK COUNTS (BUG-0257). In a working copy the application's buttons
/// keep their macro links in the held compartment, and the next push publishes
/// them. Deleting the macro there and pushing ships buttons that name a macro
/// the application no longer carries -- exactly what the warning exists to say.
#[tauri::command]
pub fn list_controls_referencing_macro(
    state: State<AppState>,
    macro_id: String,
) -> Vec<MacroLinkingControl> {
    controls_referencing_macro(&state, &macro_id)
}

/// [`list_controls_referencing_macro`] over a plain reference, for the unit tier.
///
/// BUTTON CELLS COUNT TOO (Cell Type: Button, BUG-0260): a cell whose live
/// action runs the macro, and -- in a working copy -- one whose action is HELD
/// for its application (`heldAction`), which the next push publishes.
///
/// LOCK ORDER: the sheet names are cloned out FIRST and released, then each
/// store is read under its own short guard. It used to hold `controls` while
/// taking `sheet_names` -- the reverse of the canonical sheet-then-controls
/// order `delete_sheet_impl` follows (it holds `sheet_names.write` into
/// `remap_sheet_keyed_stores`, which takes `controls.write`), so a delete-a-
/// macro warning racing a sheet delete could deadlock.
pub(crate) fn controls_referencing_macro(state: &AppState, macro_id: &str) -> Vec<MacroLinkingControl> {
    let sheet_names: Vec<String> = state.sheet_names.read().unwrap().clone();
    let controls = state.controls.read().unwrap();
    let mut out: Vec<MacroLinkingControl> = controls
        .iter()
        .filter_map(|((si, r, c), meta)| {
            let links = |key: &str| meta.properties.get(key).is_some_and(|p| p.value == macro_id);
            // The stamp's application, or `None` when it cannot be read.
            let stamped = meta
                .properties
                .get(HELD_FROM_PROPERTY)
                .and_then(|p| crate::held_button_code::HeldFrom::decode(&p.value))
                .map(|from| from.application);
            // A LIVE link is the author's own (the click reads it first), so it
            // came with no application even beside a stamp.
            let (held_by, application) = if links(MACRO_REF_PROPERTY) {
                (None, None)
            } else if links(HELD_MACRO_REF_PROPERTY) {
                (Some(stamped.clone().unwrap_or_else(|| "an application".to_string())), stamped)
            } else {
                return None;
            };
            Some(MacroLinkingControl {
                sheet_index: *si,
                sheet_name: sheet_names
                    .get(*si)
                    .cloned()
                    .unwrap_or_else(|| format!("Sheet{}", si + 1)),
                row: *r,
                col: *c,
                held_by,
                kind: crate::held_button_code::MacroLinkKind::Control,
                caption: meta.properties.get("text").map(|p| p.value.clone()).unwrap_or_default(),
                application,
            })
        })
        .collect();
    drop(controls);
    {
        let cell_types = state.cell_types.read().unwrap();
        for ((si, r, c), assignment) in cell_types.iter() {
            if assignment.type_id != crate::button_cells::BUTTON_CELL_TYPE_ID {
                continue;
            }
            let names = |key: &str| {
                assignment.params.get(key).is_some_and(|action| {
                    action.get("kind").and_then(|k| k.as_str()) == Some("script")
                        && action.get("scriptId").and_then(|s| s.as_str()) == Some(macro_id)
                })
            };
            // A button cell's stamp names its application whether its action is
            // live (a macro that application landed) or held.
            let stamped = assignment
                .params
                .get(crate::button_cells::FROM_APPLICATION_PARAM)
                .and_then(|v| v.get("application"))
                .and_then(|a| a.as_str())
                .map(str::to_string);
            let held_by = if names(crate::button_cells::ACTION_PARAM) {
                None
            } else if names(crate::button_cells::HELD_ACTION_PARAM) {
                Some(stamped.clone().unwrap_or_else(|| "an application".to_string()))
            } else {
                continue;
            };
            out.push(MacroLinkingControl {
                sheet_index: *si,
                sheet_name: sheet_names
                    .get(*si)
                    .cloned()
                    .unwrap_or_else(|| format!("Sheet{}", si + 1)),
                row: *r,
                col: *c,
                held_by,
                kind: crate::held_button_code::MacroLinkKind::Cell,
                caption: assignment
                    .params
                    .get("label")
                    .and_then(|l| l.as_str())
                    .unwrap_or_default()
                    .to_string(),
                application: stamped,
            });
        }
    }
    // Deterministic order (sheet, row, col) so the warning reads consistently.
    out.sort_by_key(|c| (c.sheet_index, c.row, c.col));
    out
}

/// Get all controls for a specific sheet.
#[tauri::command]
pub fn get_all_controls(
    state: State<AppState>,
    sheet_index: usize,
) -> Vec<ControlEntry> {
    let controls = state.controls.read().unwrap();
    controls
        .iter()
        .filter(|((si, _, _), _)| *si == sheet_index)
        .map(|((si, r, c), meta)| ControlEntry {
            sheet_index: *si,
            row: *r,
            col: *c,
            metadata: meta.clone(),
        })
        .collect()
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    fn sample_storage() -> ControlStorage {
        let mut controls: ControlStorage = HashMap::new();
        let mut props = HashMap::new();
        props.insert(
            "text".to_string(),
            ControlPropertyValue { value_type: "static".to_string(), value: "Run".to_string() },
        );
        props.insert(
            ON_SELECT_PROPERTY.to_string(),
            ControlPropertyValue {
                value_type: "static".to_string(),
                value: "MyScript();".to_string(),
            },
        );
        props.insert(
            MACRO_REF_PROPERTY.to_string(),
            ControlPropertyValue {
                value_type: "static".to_string(),
                value: "macro-do-thing".to_string(),
            },
        );
        controls.insert(
            (0, 2, 3),
            ControlMetadata { control_type: "button".to_string(), properties: props },
        );
        controls
    }

    #[test]
    fn collect_and_materialize_round_trip() {
        let controls = sample_storage();
        let sheet_ids = vec![identity::SheetId::from_bytes(identity::generate_uuid_v7())];
        let saved = collect_controls_for_save(&controls, &sheet_ids);
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].sheet_id, sheet_ids[0]);

        let mut restored: ControlStorage = HashMap::new();
        let added = materialize_saved_controls(&saved, &mut restored, |sid| {
            if sid == sheet_ids[0] { Some(5) } else { None }
        });
        assert_eq!(added, 1);
        let meta = restored.get(&(5, 2, 3)).expect("control restored at remapped sheet");
        assert_eq!(meta.control_type, "button");
        assert_eq!(meta.properties.get("onSelect").map(|p| p.value.as_str()), Some("MyScript();"));
        // A LOCAL round trip keeps executable wiring: it is the user's own code.
        // Only the DISTRIBUTED path sanitizes (see the tests below).
        assert_eq!(
            meta.properties.get(MACRO_REF_PROPERTY).map(|p| p.value.as_str()),
            Some("macro-do-thing")
        );
    }

    #[test]
    fn a_property_write_cannot_change_an_images_control_type_to_a_shape() {
        // THE DEFECT, restated as a test. The shape property handler hardcodes
        // controlType "shape", so before this a single script property write
        // against an IMAGE silently converted it — and the backend reported
        // success while the picture stopped rendering.
        let err = check_control_type_transition(Some("image"), "shape").unwrap_err();
        assert!(err.contains("'image'") && err.contains("'shape'"), "{}", err);
    }

    #[test]
    fn an_ordinary_property_write_and_a_creation_both_still_work() {
        // The fix must not break the two shapes every caller actually uses:
        // writing a property without restating the type, and creating a control.
        assert!(check_control_type_transition(Some("image"), "").is_ok());
        assert!(check_control_type_transition(Some("button"), "button").is_ok());
        assert!(check_control_type_transition(None, "image").is_ok());
    }

    #[test]
    fn a_property_write_against_nothing_with_no_type_is_refused() {
        // Otherwise it would create a control whose type is the empty string —
        // one no renderer claims, i.e. an invisible control, which is the exact
        // failure mode the buttonControlService precedent exists to prevent.
        assert!(check_control_type_transition(None, "").is_err());
    }

    #[test]
    fn a_control_property_over_the_size_cap_is_refused() {
        // The mechanical half of "a restricted script must not write a
        // multi-megabyte string into persisted document state". The bound lives
        // at the command, not in a policy sentence upstream.
        //
        // IT IS NOT, HOWEVER, UNIVERSAL, and the claim that used to stand here —
        // "every route (UI, script broker, MCP, .calp materialization) arrives
        // here" — was false in its last term and that is precisely where a hole
        // opened. A package pull calls `materialize_saved_controls` DIRECTLY, so
        // it never passes this function at all. Anything that must hold of the
        // distributed corpus has to be enforced on the pull path as well; see
        // `media::judge_inline_image`.
        let over = "x".repeat(MAX_CONTROL_PROPERTY_CHARS + 1);
        let err = check_property_value("src", &over).unwrap_err();
        assert!(err.contains("limit is"), "the refusal must state the limit: {}", err);
        assert!(
            err.contains("media"),
            "and must point at the right home for binary: {}",
            err
        );

        // Exactly at the cap is allowed: this is a boundary, not a blanket ban.
        assert!(check_property_value("src", &"x".repeat(MAX_CONTROL_PROPERTY_CHARS)).is_ok());
        // A media handle — the shape that replaces the megabyte data URL — is 70
        // characters, three orders of magnitude inside the cap.
        let handle = format!("media:{}", "a".repeat(64));
        assert_eq!(handle.len(), 70);
        assert!(check_property_value("src", &handle).is_ok());
    }

    #[test]
    fn a_small_decompression_bomb_is_refused_even_though_it_fits_the_size_cap() {
        // The size cap and the image caps are answering different questions, and
        // for a long time only one of them was asked at this door. A 30,000 x
        // 30,000 single-colour PNG is a few KB — comfortably INSIDE 64 KiB — and
        // 3.6 GB of RGBA once the WebView decodes it off the data: URL.
        let mut png: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&30_000u32.to_be_bytes());
        png.extend_from_slice(&30_000u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);

        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut b64 = String::new();
        for chunk in png.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            for i in 0..4 {
                if i <= chunk.len() {
                    b64.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    b64.push('=');
                }
            }
        }
        let bomb = format!("data:image/png;base64,{}", b64);
        assert!(
            bomb.chars().count() < MAX_CONTROL_PROPERTY_CHARS,
            "precondition: the bomb is SMALL — that is the whole point"
        );

        let err = check_property_value("src", &bomb).unwrap_err();
        assert!(err.contains("refuses to decode"), "{}", err);

        // A policy refusal still round-trips: editing some other property of a
        // legacy control must not destroy the picture it still shows.
        let svg = "data:image/svg+xml;base64,PHN2Zy8+";
        assert!(check_property_value("src", svg).is_ok());
    }

    #[test]
    fn the_cap_counts_characters_not_bytes() {
        // A multi-byte string must not be refused for being non-ASCII: a caption
        // in Swedish or Japanese is not a size problem.
        let text = "å".repeat(MAX_CONTROL_PROPERTY_CHARS);
        assert!(text.len() > MAX_CONTROL_PROPERTY_CHARS, "precondition: 2 bytes per char");
        assert!(check_property_value("text", &text).is_ok());
    }

    /// Materialize `sample_storage()` the way a PULL does and hand back the one
    /// control, so each sanitizer test asserts on the properties that would
    /// actually land in the subscriber's workbook.
    fn pulled_control() -> ControlMetadata {
        let controls = sample_storage();
        let sheet_ids = vec![identity::SheetId::from_bytes(identity::generate_uuid_v7())];
        let saved = collect_controls_for_save(&controls, &sheet_ids);
        let sanitized = sanitize_distributed_controls(&saved);

        let mut restored: ControlStorage = HashMap::new();
        materialize_saved_controls(&sanitized, &mut restored, |_| Some(0));
        restored.get(&(0, 2, 3)).expect("control materialized").clone()
    }

    #[test]
    fn sanitize_strips_every_executable_property_but_keeps_presentation() {
        // Distributed executable wiring must never materialize from a package
        // (consent-model bypass); the button's visual properties survive.
        //
        // Driven off the LIST rather than off two hand-named keys: that is the
        // whole point of having one, and it means a third executable slot added
        // to `EXECUTABLE_CONTROL_PROPERTIES` is covered here on the same commit.
        let meta = pulled_control();
        for key in EXECUTABLE_CONTROL_PROPERTIES {
            assert!(
                meta.properties.get(*key).is_none(),
                "'{}' can cause code to run on a click and must be stripped from a \
                 distributed control; it materialized as {:?}",
                key,
                meta.properties.get(*key).map(|p| p.value.as_str())
            );
        }
        assert_eq!(meta.properties.get("text").map(|p| p.value.as_str()), Some("Run"));
        // Precondition, so the loop above can never pass by being empty.
        assert!(EXECUTABLE_CONTROL_PROPERTIES.len() >= 2);
    }

    #[test]
    fn an_empty_executable_slot_holds_no_code_and_survives_the_strip() {
        // Every button the Controls recipe writes carries `onSelect: ""`.
        // Stripping it made an untouched working copy's push preview list the
        // button as modified (e2e fixall-calp C1-checkout, 2026-09-29).
        let saved = vec![persistence::SavedSheetControls {
            sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
            controls: serde_json::json!([
                { "row": 0, "col": 0, "controlType": "button", "properties": {
                    "onSelect": { "valueType": "static", "value": "" },
                    "macroRef": { "valueType": "static", "value": "" },
                    "text": { "valueType": "static", "value": "Go" }
                } },
                { "row": 1, "col": 0, "controlType": "button", "properties": {
                    "onSelect": { "valueType": "static", "value": " " },
                    "macroRef": { "valueType": "static", "value": "macro-x" }
                } }
            ]),
        }];
        let out = sanitize_distributed_controls(&saved);
        let kept = &out[0].controls[0]["properties"];
        for key in EXECUTABLE_CONTROL_PROPERTIES {
            assert_eq!(kept[*key]["value"], "", "an empty '{}' holds no code and must survive", key);
        }
        assert_eq!(kept["text"]["value"], "Go");
        // Positive control: anything else in the slot is code (whitespace too:
        // the runner is handed the string) and is stripped.
        let armed = out[0].controls[1]["properties"].as_object().expect("properties");
        for key in EXECUTABLE_CONTROL_PROPERTIES {
            assert!(!armed.contains_key(*key), "'{}' with a value must be stripped: {:?}", key, armed.get(*key));
        }
    }

    #[test]
    fn a_pulled_button_cannot_fire_a_macro_on_a_single_click() {
        // THE DEFECT, restated. The sanitizer named `onSelect` and nothing else,
        // so `macroRef` rode through a pull intact — and `runFloatingButtonClick`
        // checks `macroRef` FIRST and RETURNS, so the disarmed button ran a
        // recorded macro by id on one click anyway. Stripping one door while
        // leaving the other open is not a partial defence; it is none.
        let meta = pulled_control();
        assert!(
            meta.properties.get(MACRO_REF_PROPERTY).is_none(),
            "a distributed button must carry no macro link; it carried {:?}",
            meta.properties.get(MACRO_REF_PROPERTY).map(|p| p.value.as_str())
        );
    }

    #[test]
    fn the_executable_property_list_matches_the_script_write_refusal_list() {
        // TWO LISTS, ONE POLICY. The sandbox refuses to WRITE these slots
        // (SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS, app/src/api/scriptHost/validators.ts)
        // for exactly the reason a pull refuses to MATERIALIZE them: both would
        // let code the user never consented to run on a click. A slot added to
        // one side and not the other reopens this defect from the opposite
        // direction, and nothing but this test would notice.
        let ts = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/api/scriptHost/validators.ts");
        let src = std::fs::read_to_string(&ts)
            .unwrap_or_else(|e| panic!("cannot read {}: {}", ts.display(), e));

        const NEEDLE: &str = "export const SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS";
        let at = src
            .find(NEEDLE)
            .unwrap_or_else(|| panic!("{} no longer declares {}", ts.display(), NEEDLE));
        let tail = &src[at..];
        // The ASSIGNMENT's bracket, not the type annotation's: the declaration
        // reads `…KEYS: readonly string[] = ["onSelect", …]`, so the first `[`
        // after the needle belongs to `string[]` and would yield an empty list
        // that silently "agrees" with nothing.
        let eq = tail.find('=').expect("the refusal list is assigned a value");
        let open = tail[eq..].find('[').expect("the refusal list is an array literal") + eq;
        let close = tail[open..].find(']').expect("unterminated array literal") + open;
        let mut ts_keys: Vec<String> = tail[open + 1..close]
            .split(',')
            .map(|k| k.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
            .filter(|k| !k.is_empty())
            .collect();
        ts_keys.sort();

        // EXECUTABLE + HELD (BUG-0257). A script writing a HELD key would stage
        // code the next push publishes under the pusher's key -- the same harm
        // as writing a live slot, one push later.
        let mut rust_keys: Vec<String> = EXECUTABLE_CONTROL_PROPERTIES
            .iter()
            .chain(HELD_CONTROL_PROPERTIES.iter())
            .map(|k| k.to_string())
            .collect();
        rust_keys.sort();

        assert_eq!(
            rust_keys, ts_keys,
            "the pull-side strip, the held compartment and the script-write refusal \
             must name the same control properties"
        );
    }

    /// Each executable slot has exactly one held twin, and the lists line up.
    #[test]
    fn every_executable_slot_has_its_own_held_slot() {
        assert_eq!(EXECUTABLE_CONTROL_PROPERTIES.len(), HELD_CODE_PROPERTIES.len());
        for key in EXECUTABLE_CONTROL_PROPERTIES {
            let held = held_slot_of(key).expect("an executable slot has a held slot");
            assert!(HELD_CONTROL_PROPERTIES.contains(&held));
            assert!(!EXECUTABLE_CONTROL_PROPERTIES.contains(&held), "a held key is never live");
        }
        assert_eq!(held_slot_of("text"), None);
    }
}

/// Resolve formula-type properties for a control.
/// Returns a map of property name -> resolved string value.
/// Static properties are returned as-is; formula properties are evaluated.
#[tauri::command]
pub fn resolve_control_properties(
    state: State<AppState>,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> HashMap<String, String> {
    let controls = state.controls.read().unwrap();
    let meta = match controls.get(&(sheet_index, row, col)) {
        Some(m) => m.clone(),
        None => return HashMap::new(),
    };
    // Release the controls lock before acquiring grids
    drop(controls);

    let grids = state.grids.read().unwrap();
    let sheet_names = state.sheet_names.read().unwrap();

    // Build evaluator once for all formulas
    let evaluator = if sheet_index < grids.len() && sheet_index < sheet_names.len() {
        let current_grid = &grids[sheet_index];
        let current_sheet_name = &sheet_names[sheet_index];
        let context = create_multi_sheet_context(&grids, &sheet_names, current_sheet_name);
        let mut ev = Evaluator::with_multi_sheet(current_grid, context);
        crate::eval_budget::apply(&mut ev);
        Some(ev)
    } else {
        None
    };

    let mut resolved = HashMap::new();
    for (key, prop) in &meta.properties {
        if prop.value_type == "formula" && prop.value.starts_with('=') {
            // Evaluate the formula
            let display = if let Some(ref ev) = evaluator {
                match parse_formula(&prop.value) {
                    Ok(parser_ast) => {
                        // Resolve named references (AST splicing)
                        let resolved = if ast_has_named_refs(&parser_ast) {
                            let named_ranges_map = state.named_ranges.read().unwrap();
                            let mut visited = HashSet::new();
                            let r = resolve_names_in_ast(
                                &parser_ast,
                                &named_ranges_map,
                                sheet_index,
                                &mut visited,
                            );
                            drop(named_ranges_map);
                            r
                        } else {
                            parser_ast
                        };

                        // Resolve structured table references
                        let resolved = if ast_has_table_refs(&resolved) {
                            let tables_map = state.tables.read().unwrap();
                            let table_names_map = state.table_names.read().unwrap();
                            let ctx = TableRefContext {
                                tables: &tables_map,
                                table_names: &table_names_map,
                                current_sheet_index: sheet_index,
                                current_row: row,
                                current_col: col,
                                sheet_names: &sheet_names,
                            };
                            let r = resolve_table_refs_in_ast(&resolved, &ctx);
                            drop(table_names_map);
                            drop(tables_map);
                            r
                        } else {
                            resolved
                        };

                        let engine_ast = convert_expr(&resolved);
                        let cell_value: CellValue = ev.evaluate(&engine_ast).to_cell_value();
                        format_cell_value_simple(&cell_value)
                    }
                    Err(_) => prop.value.clone(),
                }
            } else {
                prop.value.clone()
            };
            resolved.insert(key.clone(), display);
        } else {
            resolved.insert(key.clone(), prop.value.clone());
        }
    }

    resolved
}

#[cfg(test)]
mod placement_tests {
    use super::*;

    fn control_with(pin: Option<&str>) -> ControlMetadata {
        let mut properties = HashMap::new();
        if let Some(p) = pin {
            properties.insert(
                PIN_TO_GRID_PROPERTY.to_string(),
                ControlPropertyValue { value_type: "static".into(), value: p.into() },
            );
        }
        ControlMetadata { control_type: "button".into(), properties }
    }

    #[test]
    fn a_control_without_the_property_moves_with_cells() {
        // Every control authored before pinToGrid existed is in-cell, and an
        // in-cell control's position simply IS its anchor. Defaulting to "move"
        // keeps them all behaving exactly as before.
        assert!(moves_with_cells(&control_with(None)));
    }

    #[test]
    fn an_unpinned_control_holds_its_pixel_position() {
        assert!(!moves_with_cells(&control_with(Some("false"))));
    }

    #[test]
    fn a_pinned_floating_control_moves_with_cells() {
        // "Pin to grid": the floating control follows the rows under it, which
        // is Excel's "Move but don't size with cells".
        assert!(moves_with_cells(&control_with(Some("true"))));
    }

    #[test]
    fn an_unparseable_value_moves_rather_than_freezing() {
        // Fail toward the historical behaviour: a typo or a value from a newer
        // version must not silently pin controls in place.
        assert!(moves_with_cells(&control_with(Some("somethingElse"))));
    }
}

#[cfg(test)]
mod edit_objects_gate_tests {
    //! Wave-B B5: control CREATION and REMOVAL had no `editObjects` protection
    //! gate, unlike `delete_chart` and the controls' own geometry batch. On a
    //! protected sheet that does not allow editing objects, a button could be
    //! added or deleted through the menu, a script or MCP -- the protection the
    //! user set was simply not asked. Each door now refuses BEFORE its effect:
    //! nothing written, the document clean, no undo step.
    use super::*;
    use crate::document_effect::test_seed_effect;

    fn protected_state() -> (AppState, FileState) {
        let state = crate::create_app_state();
        state.sheet_protection.write(&test_seed_effect()).unwrap().insert(
            0,
            crate::protection::SheetProtection { protected: true, ..Default::default() },
        );
        (state, FileState::default())
    }

    fn button() -> ControlMetadata {
        let mut properties = HashMap::new();
        properties.insert("text".to_string(), ControlPropertyValue { value_type: "static".into(), value: "Go".into() });
        ControlMetadata { control_type: "button".into(), properties }
    }

    fn has_undo(state: &AppState) -> bool {
        state.undo_stack.lock().unwrap().can_undo()
    }

    #[test]
    fn creating_a_control_on_a_sheet_that_protects_its_objects_is_refused() {
        let (state, file) = protected_state();
        let refused = set_control_metadata_core(&state, &file, 0, 2, 1, button());
        assert!(refused.is_err_and(|e| e.contains("protected")), "set_control_metadata created a control on a protected sheet");
        let refused = set_control_property_core(
            &state, &file, 0, 3, 1, "button".into(), "text".into(), "static".into(), "Go".into(),
        );
        assert!(refused.is_err_and(|e| e.contains("protected")), "set_control_property created a control on a protected sheet");
        assert!(state.controls.read().unwrap().is_empty(), "a refused create wrote a control");
        assert!(!file.is_dirty(), "a refused create dirtied the document");
        assert!(!has_undo(&state), "a refused create recorded an undo step");
    }

    #[test]
    fn removing_a_control_on_a_sheet_that_protects_its_objects_is_refused() {
        let (state, file) = protected_state();
        state.controls.write(&test_seed_effect()).unwrap().insert((0, 2, 1), button());
        let refused = remove_control_metadata_core(&state, &file, 0, 2, 1);
        assert!(refused.is_err_and(|e| e.contains("protected")), "remove_control_metadata deleted a protected sheet's control");
        assert!(state.controls.read().unwrap().contains_key(&(0, 2, 1)), "the control is gone");
        assert!(!file.is_dirty());
        assert!(!has_undo(&state), "a refused removal recorded an undo step");
    }

    #[test]
    fn an_existing_controls_property_edit_is_not_an_object_edit() {
        // Positive control, and the line the gate deliberately does not cross:
        // a script or the Properties pane changing an EXISTING control's text is
        // allowed (the gate is on creation and removal, as B5 asked).
        let (state, file) = protected_state();
        state.controls.write(&test_seed_effect()).unwrap().insert((0, 2, 1), button());
        set_control_property_core(&state, &file, 0, 2, 1, "".into(), "text".into(), "static".into(), "Stop".into())
            .expect("an existing control's property");
        assert_eq!(state.controls.read().unwrap()[&(0, 2, 1)].properties["text"].value, "Stop");
    }

    /// Wave-B fix-up. `set_control_geometry` refuses to move or resize a
    /// control on such a sheet, and `set_control_property` then wrote the SAME
    /// keys one at a time -- the Properties pane's Width/Height fields and a
    /// script's geometry writes resized a button the drag was refused for.
    /// Moving, resizing, pinning, rotating and flipping are object edits; a
    /// caption is not (above).
    #[test]
    fn moving_resizing_or_rotating_an_existing_control_by_property_is_refused() {
        let (state, file) = protected_state();
        state.controls.write(&test_seed_effect()).unwrap().insert((0, 2, 1), button());
        for (key, value) in [
            ("x", "40"),
            ("y", "40"),
            ("width", "90"),
            ("height", "30"),
            ("offsetX", "4"),
            ("offsetY", "4"),
            ("pinToGrid", "false"),
            ("rotation", "90"),
            ("flipH", "true"),
            ("flipV", "true"),
        ] {
            let refused = set_control_property_core(
                &state, &file, 0, 2, 1, "".into(), key.into(), "static".into(), value.into(),
            );
            assert!(
                refused.as_ref().is_err_and(|e| e.contains("protected")),
                "set_control_property wrote `{}` of a control on a sheet that protects its objects: {:?}",
                key,
                refused
            );
        }
        assert_eq!(
            state.controls.read().unwrap()[&(0, 2, 1)].properties.len(),
            1,
            "a refused geometry write reached the store"
        );
        assert!(!file.is_dirty(), "a refused geometry write dirtied the document");
        assert!(!has_undo(&state), "a refused geometry write recorded an undo step");
    }

    /// X11 (wave D). The wave-C canvas report said pasting shapes onto a
    /// CANVAS protected against object edits succeeded -- that control
    /// creation had no `editObjects` gate. It has one on every creating door
    /// (B5 above); what was never pinned is a CANVAS sheet, where the gate
    /// must hold as an OBJECT-scope action (`check_sheet_action` refuses every
    /// cell-scope action on a canvas outright and lets `editObjects` through
    /// to the protection lookup). The doors are the ones the Controls paste,
    /// duplicate and canvas Insert take (`setControlMetadata`), a script's
    /// property write that creates, and the Delete.
    #[test]
    fn a_canvas_that_protects_its_objects_refuses_every_control_create_and_delete() {
        let state = crate::create_app_state();
        let canvas = crate::sheets::add_sheet_inner(
            &state,
            &FileState::default(),
            None,
            ::persistence::SheetKind::new_canvas(),
        )
        .expect("add a canvas")
        .active_index;
        state.sheet_protection.write(&test_seed_effect()).unwrap().insert(
            canvas,
            crate::protection::SheetProtection { protected: true, ..Default::default() },
        );
        state.controls.write(&test_seed_effect()).unwrap().insert((canvas, 0, 7), button());
        let file = FileState::default();
        let depth = state.undo_stack.lock().unwrap().undo_depth();

        let pasted = set_control_metadata_core(&state, &file, canvas, 0, 9, button());
        assert!(
            pasted.as_ref().is_err_and(|e| e.contains("protected")),
            "a shape was pasted onto a canvas that protects its objects: {:?}",
            pasted
        );
        let created = set_control_property_core(
            &state, &file, canvas, 0, 10, "shape".into(), "text".into(), "static".into(), "Go".into(),
        );
        assert!(
            created.as_ref().is_err_and(|e| e.contains("protected")),
            "set_control_property created a control on a protected canvas: {:?}",
            created
        );
        let removed = remove_control_metadata_core(&state, &file, canvas, 0, 7);
        assert!(removed.is_err_and(|e| e.contains("protected")), "a protected canvas's control was deleted");

        let controls = state.controls.read().unwrap();
        assert_eq!(controls.len(), 1, "a refused door changed the canvas's controls");
        assert!(controls.contains_key(&(canvas, 0, 7)));
        drop(controls);
        assert!(!file.is_dirty(), "a refused door dirtied the document");
        assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), depth, "a refused door recorded an undo step");
    }

    /// The positive control of the canvas case: protection that ALLOWS
    /// editing objects creates as before.
    #[test]
    fn a_protected_canvas_that_allows_object_edits_creates() {
        let state = crate::create_app_state();
        let canvas = crate::sheets::add_sheet_inner(
            &state,
            &FileState::default(),
            None,
            ::persistence::SheetKind::new_canvas(),
        )
        .expect("add a canvas")
        .active_index;
        state.sheet_protection.write(&test_seed_effect()).unwrap().insert(
            canvas,
            crate::protection::SheetProtection {
                protected: true,
                options: crate::protection::SheetProtectionOptions {
                    allow_edit_objects: true,
                    ..Default::default()
                },
                ..Default::default()
            },
        );
        let file = FileState::default();
        set_control_metadata_core(&state, &file, canvas, 0, 9, button()).expect("allowed object edit");
        assert!(state.controls.read().unwrap().contains_key(&(canvas, 0, 9)));
    }

    #[test]
    fn an_unprotected_sheet_creates_and_removes() {
        let state = crate::create_app_state();
        let file = FileState::default();
        set_control_metadata_core(&state, &file, 0, 2, 1, button()).expect("create");
        assert_eq!(remove_control_metadata_core(&state, &file, 0, 2, 1), Ok(true));
        assert_eq!(remove_control_metadata_core(&state, &file, 0, 2, 1), Ok(false), "nothing left to remove");
    }
}
