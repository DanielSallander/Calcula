//! FILENAME: app/src-tauri/src/mcp/objects.rs
//! PURPOSE: UPDATE + DELETE tools for the workbook's first-class objects
//!          (charts, named ranges, tables, pivot tables) plus sheet management,
//!          for the AI tool surface shared by the MCP server and the in-app chat.
//! CONTEXT: The tool surface used to be CREATE-ONLY: create_chart_from_spec /
//!          create_named_range / create_table / create_pivot each had a list_*
//!          counterpart but no way to EDIT or REMOVE what they made, and no way
//!          to add/rename/delete/reorder a sheet. The only escape hatch was
//!          run_script, which forces the user to raise the AI access ceiling to
//!          "script" (arbitrary JS) just to rename a table. Every tool here is a
//!          "mutate"-tier operation, so the middle ceiling is now genuinely
//!          useful and the top one stays reserved for arbitrary code.
//!
//!          DISCIPLINE (copied from mcp/tools.rs, deliberately, tool for tool):
//!            1. `check_mcp_access(McpAccessTier::Mutate)` FIRST — the AI access
//!               ceiling plus the Script Security consent gate. The tier policy
//!               is the pure `required_tier` map so it is unit-testable.
//!            2. Reuse the SAME undoable command the UI calls wherever one
//!               exists, so an AI edit reverts exactly like a human edit. Where
//!               the underlying command records nothing (the pivot field/
//!               aggregation/relocate/rename paths), this module snapshots the
//!               pivot definition itself and records the same `pivot_definition`
//!               custom-restore entry the in-app field editor records.
//!            3. Mark the document dirty (`FileState.is_modified`) — the create
//!               tools forgot this, so an AI-only session could be closed
//!               without a save prompt. Every tool here marks it.
//!            4. Emit the subsystem's live-refresh Tauri event so the change
//!               shows up without a reopen.
//!            5. Record a `record_mcp_tool_action` audit entry (always-on
//!               `ScriptExecuted` category) naming the tool and its target.
//!
//!          UNDO GRANULARITY: `UndoStack::commit_transaction` closes whatever
//!          transaction is open, and the table/sheet commands each open and
//!          commit their own, so this module NEVER wraps them in an outer
//!          transaction — a nested commit would close the outer one early and
//!          silently split the entry. Where a tool applies two such commands
//!          (update_table with both a rename and a resize) the result string
//!          says how many undo steps it produced instead of pretending it was
//!          atomic. Sheet add/rename/delete/move are not undoable AT ALL in
//!          this app; the tool descriptions say so rather than implying a
//!          Ctrl+Z that does not exist.

use tauri::{AppHandle, Emitter, Manager};

use crate::api_types::ChartEntry;
use crate::scripting::commands::{check_mcp_access, McpAccessTier};
use crate::scripting::types::ScriptState;
use crate::AppState;

use super::tools::{col_letter, validate_chart_spec_core};

// ============================================================================
// Shared gate / bookkeeping helpers
// ============================================================================

/// The AI access tier each tool on this surface requires, as a PURE map so the
/// policy is unit-testable without an AppHandle.
///
/// `None` = a read-only tool that needs no ceiling (MCP transport auth and the
/// window guard already apply, exactly like the existing list_* tools).
///
/// An UNKNOWN tool name falls through to the STRICTEST tier: a tool added
/// without a policy entry must fail closed, never open.
pub(crate) fn required_tier(tool: &str) -> Option<McpAccessTier> {
    match tool {
        // ---- read-only ----
        "list_sheets" | "list_script_drafts" | "get_script_draft" => None,

        // ---- object update / delete ----
        "update_chart"
        | "delete_chart"
        | "update_named_range"
        | "delete_named_range"
        | "update_table"
        | "delete_table"
        | "update_pivot"
        | "delete_pivot" => Some(McpAccessTier::Mutate),

        // ---- sheet management ----
        "add_sheet" | "rename_sheet" | "delete_sheet" | "move_sheet" => Some(McpAccessTier::Mutate),

        // Drafting an object script writes an INERT review artifact: the draft
        // is never mounted and never executed by this process (see mcp/drafts.rs),
        // and turning it into running code is a human action in the Script
        // Editor that the Script Security gate governs. So it is a workbook
        // mutation, not script execution — gating it at "script" would defeat
        // the point (the user would have to hand the agent arbitrary-JS rights
        // to get a macro DRAFT reviewed).
        "draft_object_script" => Some(McpAccessTier::Mutate),

        // ---- object property bindings (WP-D, mcp/bindings.rs) ----
        // Reading an object's JSON, its bindable paths and its bindings' values.
        "list_object_properties" => None,
        // A literal write and a binding edit change what an object shows and
        // are saved: workbook mutations, never script execution (a binding is
        // EVALUATED by the engine, it is not code).
        "set_object_property" | "set_object_binding" => Some(McpAccessTier::Mutate),

        // Arbitrary JS.
        "run_script" => Some(McpAccessTier::Script),

        // Fail closed.
        _ => Some(McpAccessTier::Script),
    }
}

/// Apply the tier policy for `tool` against a ScriptState. Split from
/// `require_tier` so tests can drive it with a constructed ScriptState.
pub(crate) fn gate(script_state: &ScriptState, tool: &str) -> Result<(), String> {
    match required_tier(tool) {
        Some(tier) => check_mcp_access(script_state, tier),
        None => Ok(()),
    }
}

/// Enforce the tier policy for `tool` using the app's live ScriptState.
fn require_tier(handle: &AppHandle, tool: &str) -> Result<(), String> {
    let script_state = handle.state::<ScriptState>();
    gate(&script_state, tool)
}

/// Mark the document modified so an AI-only editing session still prompts to
/// save. (`apply_cell_formatting` does this; the create_* tools did not.)
pub(crate) fn mark_dirty(handle: &AppHandle) {
    let _ = mcp_effect(handle);
}

/// Mint the `DocumentEffect` for an MCP tool that mutates the document.
///
/// MCP tools are the clearest case for putting the mark in the BACKEND: an AI client
/// never runs the frontend code that used to compensate for missing flags, so an
/// AI-only editing session relied entirely on whatever the backend did. Constructing
/// this sets `is_modified`, which is why `mark_dirty` above is now just a call to it.
pub(crate) fn mcp_effect(handle: &AppHandle) -> crate::document_effect::DocumentEffect {
    crate::document_effect::DocumentEffect::mutates(&handle.state::<crate::persistence::FileState>())
}

/// Record the tool's audit entry. Thin wrapper so every tool here records
/// through one call shape (and so the field list is easy to assert in tests).
pub(crate) fn audit(
    handle: &AppHandle,
    tool: &str,
    description: &str,
    fields: Vec<(&str, serde_json::Value)>,
) {
    crate::scripting::commands::record_mcp_tool_action(
        &handle.state::<AppState>(),
        tool,
        description,
        fields,
    );
}

/// Parse an EntityId argument, with a message that points at the list_* tool
/// the id comes from.
fn parse_entity_id(raw: &str, what: &str, list_tool: &str) -> Result<identity::EntityId, String> {
    identity::EntityId::parse(raw)
        .ok_or_else(|| format!("Invalid {} id '{}'. Use {} to see valid ids.", what, raw, list_tool))
}

// ============================================================================
// Charts
// ============================================================================

/// Optional placement overrides for `update_chart`. All-None leaves the stored
/// geometry untouched.
#[derive(Debug, Clone, Default)]
pub struct ChartPlacement {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

impl ChartPlacement {
    fn is_empty(&self) -> bool {
        self.x.is_none() && self.y.is_none() && self.width.is_none() && self.height.is_none()
    }
}

/// Edit a stored chart in place, over `&AppState` so the whole path (protection
/// check, JSON merge, undo snapshot) is unit-testable with `create_app_state()`.
///
/// Returns a human-readable summary of what changed.
///
/// Takes the `FileState`, not a ready-made effect: the `DocumentEffect` is
/// minted only after the LAST gate that can refuse (the Lock Objects decision
/// inside the store's `lock_pending`), so a refused edit leaves the document
/// exactly as clean as it was -- the same order as
/// `chart_commands::update_chart_core`.
pub(crate) fn update_chart_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    chart_id: &str,
    spec: Option<&serde_json::Value>,
    name: Option<&str>,
    sheet_index: Option<u32>,
    placement: &ChartPlacement,
) -> Result<String, String> {
    let id = parse_entity_id(chart_id, "chart", "list_charts")?;

    if spec.is_none() && name.is_none() && sheet_index.is_none() && placement.is_empty() {
        return Err(
            "update_chart needs at least one of: spec, name, sheet_index, x, y, width, height."
                .to_string(),
        );
    }
    if let Some(s) = spec {
        validate_chart_spec_core(s)?;
    }

    // Resolve the current entry (and its sheet) BEFORE taking any other lock,
    // so the protection check never runs while holding the charts mutex.
    let previous: ChartEntry = {
        let charts = state.charts.read().map_err(|e| e.to_string())?;
        charts
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| format!("No chart with id '{}'. Use list_charts to see available ids.", chart_id))?
    };

    // allowEditObjects gate on the CURRENT sheet, and on the TARGET sheet too
    // when the chart is being moved — mirrors chart_commands::update_chart.
    crate::protection::check_sheet_action(state, previous.sheet_index, "editObjects", "edit objects")?;
    let target_sheet = sheet_index.map(|s| s as usize).unwrap_or(previous.sheet_index);
    if target_sheet != previous.sheet_index {
        crate::protection::check_sheet_action(state, target_sheet, "editObjects", "edit objects")?;
        let sheet_count = state.sheet_names.read().map_err(|e| e.to_string())?.len();
        if target_sheet >= sheet_count {
            return Err(format!(
                "Sheet index {} out of range (workbook has {} sheet(s)).",
                target_sheet, sheet_count
            ));
        }
    }

    // Merge into the stored ChartDefinition JSON. The store treats spec_json as
    // opaque, so a malformed stored blob is replaced by a minimal object rather
    // than failing the edit.
    let mut definition: serde_json::Value = serde_json::from_str(&previous.spec_json)
        .unwrap_or_else(|_| serde_json::json!({ "chartId": id.to_string() }));
    if !definition.is_object() {
        definition = serde_json::json!({ "chartId": id.to_string() });
    }
    let mut changed: Vec<String> = Vec::new();
    {
        let obj = definition
            .as_object_mut()
            .expect("definition forced to an object above");
        // The id is authoritative: an AI-supplied spec must never rename the key.
        obj.insert("chartId".to_string(), serde_json::json!(id.to_string()));
        if let Some(s) = spec {
            obj.insert("spec".to_string(), s.clone());
            changed.push("spec".to_string());
        }
        if let Some(n) = name {
            obj.insert("name".to_string(), serde_json::json!(n));
            changed.push(format!("name=\"{}\"", n));
        }
        if sheet_index.is_some() {
            obj.insert("sheetIndex".to_string(), serde_json::json!(target_sheet));
            changed.push(format!("sheet={}", target_sheet));
        }
        for (key, value) in [
            ("x", placement.x),
            ("y", placement.y),
            ("width", placement.width),
            ("height", placement.height),
        ] {
            if let Some(v) = value {
                obj.insert(key.to_string(), serde_json::json!(v));
                changed.push(format!("{}={}", key, v));
            }
        }
    }

    let spec_json = serde_json::to_string(&definition).map_err(|e| e.to_string())?;
    let updated = ChartEntry {
        id,
        sheet_index: target_sheet,
        spec_json,
    };
    {
        let pending = state.charts.lock_pending().map_err(|e| e.to_string())?;
        let slot = pending
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| format!("Chart '{}' disappeared during the edit.", chart_id))?;
        // LOCK OBJECTS: an AI tool is one more door, refused exactly like the
        // chart store's own (`chart_commands::update_chart_core`) when the
        // edit moves or resizes the chart on a locked page -- decided HERE,
        // holding the store the write lands in (BUG-0443), and BEFORE the
        // effect exists, so a refusal does not dirty the document.
        if crate::chart_commands::chart_moves(&pending[slot], &updated) {
            crate::sheets::ensure_canvas_objects_unlocked(state, pending[slot].sheet_index, "move or resize a chart")?;
        }
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut charts = pending.authorize(&effect);
        charts[slot] = updated;
    }

    // Same undo shape as chart_commands::update_chart: the PREVIOUS entry.
    crate::undo_commands::record_chart_undo(state, id, Some(previous), "Edit chart (AI)");

    Ok(format!("Updated chart id={} ({})", id, changed.join(", ")))
}

/// Edit a chart from an AI client.
#[allow(clippy::too_many_arguments)]
pub fn update_chart(
    handle: &AppHandle,
    chart_id: &str,
    spec: Option<&serde_json::Value>,
    name: Option<&str>,
    sheet_index: Option<u32>,
    placement: &ChartPlacement,
) -> Result<String, String> {
    require_tier(handle, "update_chart")?;
    let state = handle.state::<AppState>();
    // update_chart_core mints the effect itself, after every gate that can
    // refuse ("no such chart", protection, Lock Objects), so a refused edit
    // leaves the document clean.
    let summary = {
        let file_state = handle.state::<crate::persistence::FileState>();
        update_chart_core(&state, &file_state, chart_id, spec, name, sheet_index, placement)?
    };
    drop(state);

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::Chart,
    );
    mark_dirty(handle);
    audit(
        handle,
        "update_chart",
        &format!("An AI tool edited chart {}", chart_id),
        vec![
            ("chartId", serde_json::json!(chart_id)),
            ("specReplaced", serde_json::json!(spec.is_some())),
            ("name", serde_json::json!(name)),
            ("sheet", serde_json::json!(sheet_index)),
        ],
    );
    Ok(summary)
}

/// Delete a stored chart, over `&AppState` so undo + script pruning are testable.
/// Returns the deleted chart's sheet index.
pub(crate) fn delete_chart_core(
    state: &AppState,
    pane_control_state: &crate::pane_control::PaneControlState,
    effect: &crate::document_effect::DocumentEffect,
    chart_id: &str,
) -> Result<usize, String> {
    let id = parse_entity_id(chart_id, "chart", "list_charts")?;

    let previous: ChartEntry = {
        let charts = state.charts.read().map_err(|e| e.to_string())?;
        charts
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| format!("No chart with id '{}'. Use list_charts to see available ids.", chart_id))?
    };
    crate::protection::check_sheet_action(state, previous.sheet_index, "editObjects", "delete objects")?;

    {
        let mut charts = state.charts.write(effect).map_err(|e| e.to_string())?;
        charts.retain(|c| c.id != id);
    }
    // SECOND DELETE PATH, SAME CASCADE (section 3bt). This is not the Tauri
    // command -- an AI tool reaches charts here -- and every lifecycle rule the
    // UI path applies has to apply on this one too, or the object graph depends
    // on WHO deleted the chart. Recorded in ONE transaction so the AI's delete
    // is one Ctrl+Z, exactly like the user's.
    let pruned_controls =
        crate::object_deps::cascade_deleted_charts(pane_control_state, &[id]);
    // WP-D: the chart's object property bindings go with it, in the same step
    // (the cascade `chart_commands::delete_chart` runs).
    let dropped_bindings = crate::object_bindings::cascade::drop_bindings_for_objects(
        state,
        effect,
        &[crate::api_types::ObjectBindingRef { kind: crate::api_types::ObjectBindingKind::Chart, id: id.to_string() }],
    );
    let opened_transaction = {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        let opened = !undo_stack.has_open_transaction();
        if opened {
            undo_stack.begin_transaction("Delete chart (AI)".to_string());
        }
        opened
    };
    if let Some(previous_bindings) = dropped_bindings {
        crate::undo_commands::record_bindings_undo(state, previous_bindings, "Delete chart (AI)");
    }
    crate::object_deps::record_pane_control_prune_undo(
        state,
        &pruned_controls,
        "Restore chart binding",
    );
    crate::undo_commands::record_chart_undo(state, id, Some(previous.clone()), "Delete chart (AI)");
    if opened_transaction {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo_stack.commit_transaction();
    }
    // C10 lifecycle hygiene, exactly like chart_commands::delete_chart.
    crate::scripting::object_script_commands::prune_scripts_for_instance(state, effect, &id.to_string());

    Ok(previous.sheet_index)
}

/// Delete a chart from an AI client.
pub fn delete_chart(handle: &AppHandle, chart_id: &str) -> Result<String, String> {
    require_tier(handle, "delete_chart")?;
    let state = handle.state::<AppState>();
    // Built after `require_tier`; `delete_chart_core` still resolves "no such chart"
    // and the protection gate under a read guard before touching anything.
    let effect = mcp_effect(handle);
    let pane_control_state = handle.state::<crate::pane_control::PaneControlState>();
    let sheet = delete_chart_core(&state, &pane_control_state, &effect, chart_id)?;
    drop(pane_control_state);
    drop(state);

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::Chart,
    );
    audit(
        handle,
        "delete_chart",
        &format!("An AI tool deleted chart {} on sheet {}", chart_id, sheet + 1),
        vec![
            ("chartId", serde_json::json!(chart_id)),
            ("sheet", serde_json::json!(sheet)),
        ],
    );
    Ok(format!("Deleted chart id={} (was on sheet {})", chart_id, sheet))
}

// ============================================================================
// Named ranges
// ============================================================================

/// Edit an existing name: its target (`refers_to`), comment, scope, and/or the
/// name itself. Runs the SAME bodies the Name Manager's commands run.
pub fn update_named_range(
    handle: &AppHandle,
    name: &str,
    new_name: Option<&str>,
    refers_to: Option<&str>,
    comment: Option<Option<String>>,
    sheet_index: Option<Option<usize>>,
) -> Result<String, String> {
    require_tier(handle, "update_named_range")?;

    let edit = update_named_range_core(
        &handle.state::<AppState>(),
        &handle.state::<crate::persistence::FileState>(),
        &handle.state::<crate::persistence::UserFilesState>(),
        &handle.state::<crate::pivot::PivotState>(),
        &handle.state::<crate::pane_control::PaneControlState>(),
        &handle.state::<crate::ribbon_filter::RibbonFilterState>(),
        name,
        new_name,
        refers_to,
        comment,
        sheet_index,
    )?;

    if edit.undo_steps > 0 {
        // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
        // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
        // cascade's stores are named without anyone having to remember them.
        crate::object_deps::announce_cascade(
            handle,
            crate::object_deps::ObjectKind::NamedRange,
        );
        mark_dirty(handle);
    }
    audit(
        handle,
        "update_named_range",
        &format!("An AI tool edited named range '{}' -> {}", edit.name, edit.refers_to),
        vec![
            ("name", serde_json::json!(name)),
            ("newName", serde_json::json!(new_name)),
            ("refersTo", serde_json::json!(edit.refers_to)),
            ("sheetIndex", serde_json::json!(edit.scope)),
        ],
    );

    Ok(format!(
        "Updated named range '{}' -> {} ({} undo step(s))",
        edit.name, edit.refers_to, edit.undo_steps
    ))
}

/// What [`update_named_range_core`] did: the name as it is now spelled and
/// defined, and how many undo steps that took (0 when nothing changed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NamedRangeEdit {
    pub name: String,
    pub refers_to: String,
    pub scope: Option<usize>,
    pub undo_steps: usize,
}

/// The MCP / AI-chat `update_named_range` over plain references (testable
/// without an `AppHandle`).
///
/// A RENAME goes through `named_ranges::rename_named_range_core`, the Name
/// Manager's own rename: every gate (a legal name, no table holding it, the
/// new key free, every rewritten definition readable), the move, the repoint
/// of every formula that reads the name -- across sheets and inside other
/// names' definitions -- and of the object scripts bound to it, its
/// dependency rebuild and recalculation, all as ONE undo step. Excel does the same: `Names("Rate").Name = "Tax"` turns `=Rate*2`
/// into `=Tax*2`. This tool used to rename by DELETE + CREATE instead, on the
/// stated ground that the rename recorded no undo entry and skipped the table
/// collision check; both had been fixed since, and the delete deliberately
/// rewrites no formula while the create repoints none, so every reader of the
/// old name came back `#NAME?`, in two undo steps.
///
/// A case-only change ("total" -> "Total") is a rename too: it re-spells the
/// references (the update alone would store the new spelling and leave every
/// formula saying the old one).
///
/// A scope, definition or comment change is then the Name Manager's own EDIT,
/// addressed to the name as it is now spelled -- a second undo step, reported,
/// exactly the two calls the Name Manager's dialog makes.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_named_range_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    name: &str,
    new_name: Option<&str>,
    refers_to: Option<&str>,
    comment: Option<Option<String>>,
    sheet_index: Option<Option<usize>>,
) -> Result<NamedRangeEdit, String> {
    if new_name.is_none() && refers_to.is_none() && comment.is_none() && sheet_index.is_none() {
        return Err(
            "update_named_range needs at least one of: new_name, refers_to, comment, sheet_index."
                .to_string(),
        );
    }

    let existing = {
        let ranges = state.named_ranges.read().map_err(|e| e.to_string())?;
        ranges.get(&crate::name_resolution::name_key(&name)).cloned().ok_or_else(|| {
            format!("Named range '{}' does not exist. Use list_named_ranges to see the names.", name)
        })?
    };

    // Resolved target state (unspecified fields keep their current value).
    let target_refers_to = refers_to.map(|s| s.to_string()).unwrap_or_else(|| existing.refers_to.clone());
    let target_comment = comment.unwrap_or_else(|| existing.comment.clone());
    let target_scope = sheet_index.unwrap_or(existing.sheet_index);
    let target_name = new_name.unwrap_or(existing.name.as_str()).to_string();

    let renaming = target_name != existing.name;
    let redefining = target_refers_to != existing.refers_to
        || target_comment != existing.comment
        || target_scope != existing.sheet_index;
    let mut undo_steps = 0;

    if renaming {
        // The name's object scripts are bound by its TEXT; the rename itself
        // re-points them, inside its one undo step
        // (`named_ranges::repoint_named_range_scripts`).
        let renamed = crate::named_ranges::rename_named_range_core(
            state,
            file_state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &existing.name,
            &target_name,
        );
        if !renamed.success {
            // Refused before anything moved: nothing to put back.
            return Err(renamed
                .error
                .unwrap_or_else(|| format!("Failed to rename named range '{}'", existing.name)));
        }
        undo_steps += 1;
    }

    if redefining {
        let result = crate::named_ranges::update_named_range_core(
            state,
            file_state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            target_name.clone(),
            target_scope,
            target_refers_to.clone(),
            target_comment.clone(),
            existing.folder.clone(),
        );
        if !result.success {
            let error = result
                .error
                .unwrap_or_else(|| format!("Failed to update named range '{}'", target_name));
            return Err(if renaming {
                format!(
                    "Renamed '{}' to '{}' ({} undo step), but could not change its definition: {}",
                    existing.name, target_name, undo_steps, error
                )
            } else {
                error
            });
        }
        undo_steps += 1;
    }

    Ok(NamedRangeEdit {
        name: target_name,
        refers_to: target_refers_to,
        scope: target_scope,
        undo_steps,
    })
}

/// Delete a name. Reuses the undoable Name Manager command (which also prunes
/// object scripts attached to the name).
pub fn delete_named_range(handle: &AppHandle, name: &str) -> Result<String, String> {
    require_tier(handle, "delete_named_range")?;

    let result = crate::named_ranges::delete_named_range(
        handle.state::<AppState>(),
        handle.state::<crate::persistence::FileState>(),
        handle.state::<crate::persistence::UserFilesState>(),
        handle.state::<crate::pivot::PivotState>(),
        handle.state::<crate::pane_control::PaneControlState>(),
        handle.state::<crate::ribbon_filter::RibbonFilterState>(),
        name.to_string(),
    );
    if !result.success {
        return Err(result.error.unwrap_or_else(|| {
            format!("Named range '{}' does not exist. Use list_named_ranges to see the names.", name)
        }));
    }
    let refers_to = result
        .named_range
        .as_ref()
        .map(|nr| nr.refers_to.clone())
        .unwrap_or_default();

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::NamedRange,
    );
    mark_dirty(handle);
    audit(
        handle,
        "delete_named_range",
        &format!("An AI tool deleted named range '{}'", name),
        vec![
            ("name", serde_json::json!(name)),
            ("refersTo", serde_json::json!(refers_to)),
        ],
    );
    Ok(format!("Deleted named range '{}' (was {})", name, refers_to))
}

// ============================================================================
// Tables
// ============================================================================

/// Rename and/or resize a structured table. Both reuse the UI's undoable
/// commands (each of which owns its own undo transaction), so applying both in
/// one call produces TWO undo steps — the result string says which.
pub fn update_table(
    handle: &AppHandle,
    table_id: &str,
    new_name: Option<&str>,
    range: Option<(u32, u32, u32, u32)>,
) -> Result<String, String> {
    require_tier(handle, "update_table")?;
    let id = parse_entity_id(table_id, "table", "list_tables")?;

    if new_name.is_none() && range.is_none() {
        return Err("update_table needs at least one of: new_name, range (start/end row+col).".to_string());
    }

    let mut applied: Vec<String> = Vec::new();

    if let Some(name) = new_name {
        let result = crate::tables::rename_table(
            handle.state::<crate::persistence::FileState>(),
            handle.state::<AppState>(),
            handle.state::<crate::persistence::UserFilesState>(),
            handle.state::<crate::pivot::PivotState>(),
            handle.state::<crate::pane_control::PaneControlState>(),
            handle.state::<crate::ribbon_filter::RibbonFilterState>(),
            id,
            name.to_string(),
        );
        if !result.success {
            return Err(result
                .error
                .unwrap_or_else(|| format!("Failed to rename table to '{}'", name)));
        }
        applied.push(format!("renamed to \"{}\"", name));
    }

    if let Some((start_row, start_col, end_row, end_col)) = range {
        if end_row < start_row || end_col < start_col {
            return Err("update_table range is inverted: end_row/end_col must be >= start_row/start_col.".to_string());
        }
        let result = crate::tables::resize_table(
            handle.state::<crate::persistence::FileState>(),
            handle.state::<AppState>(),
            handle.state::<crate::persistence::UserFilesState>(),
            handle.state::<crate::pivot::PivotState>(),
            handle.state::<crate::pane_control::PaneControlState>(),
            handle.state::<crate::ribbon_filter::RibbonFilterState>(),
            crate::tables::ResizeTableParams {
                table_id: id,
                start_row,
                start_col,
                end_row,
                end_col,
            },
        );
        if !result.success {
            return Err(result
                .error
                .unwrap_or_else(|| "Failed to resize table".to_string()));
        }
        applied.push(format!(
            "resized to {}{}:{}{}",
            col_letter(start_col),
            start_row + 1,
            col_letter(end_col),
            end_row + 1
        ));
    }

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::Table,
    );
    mark_dirty(handle);
    audit(
        handle,
        "update_table",
        &format!("An AI tool edited table {} ({})", table_id, applied.join("; ")),
        vec![
            ("tableId", serde_json::json!(table_id)),
            ("newName", serde_json::json!(new_name)),
            ("resized", serde_json::json!(range.is_some())),
        ],
    );

    Ok(format!(
        "Updated table {}: {} ({} undo step(s))",
        table_id,
        applied.join("; "),
        applied.len()
    ))
}

/// Delete a structured table (the undoable UI command; the cells stay, the
/// table object and its autofilter go).
pub fn delete_table(handle: &AppHandle, table_id: &str) -> Result<String, String> {
    require_tier(handle, "delete_table")?;
    let id = parse_entity_id(table_id, "table", "list_tables")?;

    let result = crate::tables::delete_table(
        handle.state::<AppState>(),
        handle.state::<crate::persistence::FileState>(),
        handle.state::<crate::persistence::UserFilesState>(),
        handle.state::<crate::pivot::PivotState>(),
        handle.state::<crate::pane_control::PaneControlState>(),
        handle.state::<crate::ribbon_filter::RibbonFilterState>(),
        handle.state::<crate::slicer::SlicerState>(),
        handle.state::<crate::timeline_slicer::TimelineSlicerState>(),
        id,
    );
    if !result.success {
        return Err(result
            .error
            .unwrap_or_else(|| format!("Failed to delete table '{}'", table_id)));
    }
    let name = result
        .table
        .as_ref()
        .map(|t| t.name.clone())
        .unwrap_or_else(|| table_id.to_string());

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::Table,
    );
    mark_dirty(handle);
    audit(
        handle,
        "delete_table",
        &format!("An AI tool deleted table \"{}\"", name),
        vec![
            ("tableId", serde_json::json!(table_id)),
            ("name", serde_json::json!(name)),
        ],
    );
    Ok(format!("Deleted table \"{}\" (id={})", name, table_id))
}

// ============================================================================
// Pivot tables
// ============================================================================

/// Which pivot area a field is being moved to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PivotArea {
    Row,
    Column,
    Value,
    Filter,
    /// Remove the field from every area.
    None,
}

/// Map an area string from the AI to a `PivotArea`. Pure — unit-tested.
pub(crate) fn parse_pivot_area(s: &str) -> Result<PivotArea, String> {
    match s.trim().to_lowercase().as_str() {
        "row" | "rows" => Ok(PivotArea::Row),
        "column" | "columns" | "col" | "cols" => Ok(PivotArea::Column),
        "value" | "values" | "data" => Ok(PivotArea::Value),
        "filter" | "filters" => Ok(PivotArea::Filter),
        "none" | "remove" => Ok(PivotArea::None),
        other => Err(format!(
            "Unknown pivot area '{}'. Use one of: row, column, value, filter, none.",
            other
        )),
    }
}

impl PivotArea {
    fn to_axis(self) -> crate::pivot::types::PivotAxis {
        use crate::pivot::types::PivotAxis;
        match self {
            PivotArea::Row => PivotAxis::Row,
            PivotArea::Column => PivotAxis::Column,
            PivotArea::Value => PivotAxis::Data,
            PivotArea::Filter => PivotAxis::Filter,
            PivotArea::None => PivotAxis::Unknown,
        }
    }
}

/// Map an aggregation string to the pivot command layer's `AggregationFunction`.
/// Pure — unit-tested. Accepts the same vocabulary as create_pivot plus the
/// wider set the pivot engine supports.
pub(crate) fn parse_aggregation_function(
    s: &str,
) -> Result<crate::pivot::types::AggregationFunction, String> {
    use crate::pivot::types::AggregationFunction as F;
    match s.trim().to_lowercase().as_str() {
        "auto" | "automatic" => Ok(F::Automatic),
        "sum" => Ok(F::Sum),
        "count" => Ok(F::Count),
        "average" | "avg" | "mean" => Ok(F::Average),
        "max" => Ok(F::Max),
        "min" => Ok(F::Min),
        "product" => Ok(F::Product),
        "countnumbers" | "count_numbers" => Ok(F::CountNumbers),
        "stddev" | "standarddeviation" => Ok(F::StandardDeviation),
        "stddevp" | "standarddeviationp" => Ok(F::StandardDeviationP),
        "var" | "variance" => Ok(F::Variance),
        "varp" | "variancep" => Ok(F::VarianceP),
        other => Err(format!(
            "Unknown aggregation '{}'. Use one of: sum, count, average, min, max, product, \
             countNumbers, stdDev, stdDevP, var, varP, auto.",
            other
        )),
    }
}

/// One requested field placement for `update_pivot`.
#[derive(Debug, Clone)]
pub struct PivotFieldMove {
    /// Source column name, as it appears in the pivot's field list.
    pub field: String,
    pub area: PivotArea,
    pub position: Option<usize>,
}

/// One requested aggregation change for `update_pivot`.
#[derive(Debug, Clone)]
pub struct PivotAggregationChange {
    /// Value-field name as shown in the values area.
    pub field: String,
    pub aggregation: crate::pivot::types::AggregationFunction,
}

/// Record the SAME `pivot_definition` custom-restore entry the in-app field
/// editor records, from a definition snapshot taken BEFORE the change.
///
/// This exists because the individual pivot commands this tool composes
/// (`update_pivot_properties`, `relocate_pivot`, `move_pivot_field`,
/// `set_pivot_aggregation`) record NO undo of their own — the undoable in-app
/// path is `update_pivot_fields`, which is async and requires a `tauri::Window`
/// the MCP surface does not have. One entry for the whole tool call means one
/// Ctrl+Z, which is the discipline the rest of this module holds to.
///
/// `overwritten_cells` is empty (the restore struct defaults it): this snapshot
/// restores the DEFINITION and re-renders, it does not resurrect cells a pivot
/// expansion overwrote. Same limitation the in-app expand/collapse undo has
/// when nothing was overwritten.
fn record_pivot_definition_undo(
    state: &AppState,
    pivot_id: pivot_engine::PivotId,
    definition: &pivot_engine::PivotDefinition,
    dest_sheet_idx: usize,
    description: &str,
) {
    // Built by `undo_commands`, which owns the payload shape and is the only
    // thing that reads it back. This used to be a hand-written `json!` literal:
    // a field added to the struct would have been silently absent here and
    // defaulted away on restore, which is precisely how a cache snapshot could
    // have gone missing from this surface alone.
    let data = crate::undo_commands::encode_pivot_definition_snapshot(
        pivot_id,
        definition.clone(),
        Vec::new(),
        dest_sheet_idx,
        // The MCP pivot tools change the DEFINITION only; the records stay put.
        None,
    );
    let Ok(mut undo_stack) = state.undo_stack.lock() else {
        return;
    };
    let opened = !undo_stack.has_open_transaction();
    if opened {
        undo_stack.begin_transaction(description.to_string());
    }
    undo_stack.record_custom_restore(
        crate::undo_commands::PIVOT_DEFINITION_RESTORE_KIND.to_string(),
        data,
        description,
    );
    if opened {
        undo_stack.commit_transaction();
    }
}

/// Resolve a pivot field NAME to its source-column index against the pivot's
/// own cache. Pure — unit-tested through `resolve_pivot_field_index`.
pub(crate) fn resolve_pivot_field_index(
    field: &str,
    available: &[String],
) -> Result<usize, String> {
    available
        .iter()
        .position(|n| n.eq_ignore_ascii_case(field))
        .ok_or_else(|| {
            format!(
                "Pivot field '{}' not found. Available fields: [{}]",
                field,
                available.join(", ")
            )
        })
}

/// Reconfigure an existing pivot: rename it, move it, move fields between
/// areas, and/or change a value field's aggregation — in ONE undo step.
#[allow(clippy::too_many_arguments)]
pub fn update_pivot(
    handle: &AppHandle,
    pivot_id: &str,
    name: Option<&str>,
    destination_cell: Option<&str>,
    field_moves: Vec<PivotFieldMove>,
    aggregations: Vec<PivotAggregationChange>,
) -> Result<String, String> {
    require_tier(handle, "update_pivot")?;
    let id = parse_entity_id(pivot_id, "pivot", "list_pivots")?;

    if name.is_none() && destination_cell.is_none() && field_moves.is_empty() && aggregations.is_empty() {
        return Err(
            "update_pivot needs at least one of: name, destination_cell, field_moves, aggregations."
                .to_string(),
        );
    }

    let pivot_state = handle.state::<crate::pivot::PivotState>();
    let app_state = handle.state::<AppState>();

    // Snapshot the definition + its field names BEFORE anything changes.
    let (before_definition, field_names, value_field_names) = {
        let tables = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
        let (definition, cache) = tables.get(&id).ok_or_else(|| {
            format!("No pivot with id '{}'. Use list_pivots to see available ids.", pivot_id)
        })?;
        let names: Vec<String> = (0..cache.field_count())
            .map(|i| cache.field_name(i).unwrap_or_else(|| format!("Field{}", i + 1)))
            .collect();
        let value_names: Vec<String> = definition.value_fields.iter().map(|f| f.name.clone()).collect();
        (definition.clone(), names, value_names)
    };
    let dest_sheet_idx =
        crate::pivot::operations::resolve_dest_sheet_index(&app_state, &before_definition);

    // Resolve every argument BEFORE mutating, so a bad field name aborts the
    // whole call instead of leaving a half-applied pivot.
    let mut resolved_moves: Vec<(usize, crate::pivot::types::PivotAxis, Option<usize>, String)> =
        Vec::new();
    for m in &field_moves {
        let index = resolve_pivot_field_index(&m.field, &field_names)?;
        resolved_moves.push((index, m.area.to_axis(), m.position, m.field.clone()));
    }
    let mut resolved_aggs: Vec<(usize, crate::pivot::types::AggregationFunction, String)> = Vec::new();
    for a in &aggregations {
        let index = value_field_names
            .iter()
            .position(|n| n.eq_ignore_ascii_case(&a.field))
            .ok_or_else(|| {
                format!(
                    "Value field '{}' not found in this pivot's values area. Present: [{}]",
                    a.field,
                    value_field_names.join(", ")
                )
            })?;
        resolved_aggs.push((index, a.aggregation, a.field.clone()));
    }
    let destination = match destination_cell {
        Some(cell) => Some(crate::pivot::utils::parse_cell_ref(cell)?),
        None => None,
    };

    // ONE undo entry for the whole call, recorded before the mutations.
    record_pivot_definition_undo(
        &app_state,
        id,
        &before_definition,
        dest_sheet_idx,
        "Edit pivot table (AI)",
    );

    let mut applied: Vec<String> = Vec::new();

    if let Some(n) = name {
        crate::pivot::commands::update_pivot_properties(
            handle.state::<AppState>(),
            handle.state::<crate::persistence::FileState>(),
            handle.state::<crate::pivot::PivotState>(),
            crate::pivot::types::UpdatePivotPropertiesRequest {
                pivot_id: id,
                name: Some(n.to_string()),
                allow_multiple_filters_per_field: None,
                enable_data_value_editing: None,
                refresh_on_open: None,
                use_custom_sort_lists: None,
                canvas_frame: None,
                style: None,
            },
        )?;
        applied.push(format!("renamed to \"{}\"", n));
    }

    for (index, axis, position, label) in resolved_moves {
        crate::pivot::commands::move_pivot_field(
            handle.state::<AppState>(),
            handle.state::<crate::persistence::FileState>(),
            handle.state::<crate::pivot::PivotState>(),
            handle.state::<crate::pane_control::PaneControlState>(),
            handle.state::<crate::ribbon_filter::RibbonFilterState>(),
            handle.state::<crate::persistence::UserFilesState>(),
            crate::pivot::types::MoveFieldRequest {
                pivot_id: id,
                field_index: index,
                target_axis: axis,
                position,
            },
        )?;
        applied.push(format!("moved \"{}\"", label));
    }

    for (index, function, label) in resolved_aggs {
        crate::pivot::commands::set_pivot_aggregation(
            handle.state::<AppState>(),
            handle.state::<crate::persistence::FileState>(),
            handle.state::<crate::pivot::PivotState>(),
            handle.state::<crate::pane_control::PaneControlState>(),
            handle.state::<crate::ribbon_filter::RibbonFilterState>(),
            handle.state::<crate::persistence::UserFilesState>(),
            crate::pivot::types::SetAggregationRequest {
                pivot_id: id,
                value_field_index: index,
                summarize_by: function,
            },
        )?;
        applied.push(format!("aggregation of \"{}\"", label));
    }

    if let Some((row, col)) = destination {
        crate::pivot::commands::relocate_pivot(
            handle.state::<AppState>(),
            handle.state::<crate::persistence::FileState>(),
            handle.state::<crate::pivot::PivotState>(),
            handle.state::<crate::pane_control::PaneControlState>(),
            handle.state::<crate::ribbon_filter::RibbonFilterState>(),
            handle.state::<crate::persistence::UserFilesState>(),
            id,
            row,
            col,
        )?;
        applied.push(format!("moved to {}{}", col_letter(col), row + 1));
    }

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::Pivot,
    );
    // The pivot's grid region was rewritten, which is a CELL change and not an
    // object one -- no domain covers it.
    let _ = handle.emit("grid:refresh", ());
    mark_dirty(handle);
    audit(
        handle,
        "update_pivot",
        &format!("An AI tool reconfigured pivot {} ({})", pivot_id, applied.join("; ")),
        vec![
            ("pivotId", serde_json::json!(pivot_id)),
            ("name", serde_json::json!(name)),
            ("destinationCell", serde_json::json!(destination_cell)),
            ("fieldMoveCount", serde_json::json!(field_moves.len())),
            ("aggregationChangeCount", serde_json::json!(aggregations.len())),
        ],
    );

    Ok(format!(
        "Updated pivot {}: {} (1 undo step)",
        pivot_id,
        applied.join("; ")
    ))
}

/// Delete a pivot table (the undoable UI command; also clears its grid region
/// and prunes attached object scripts).
pub fn delete_pivot(handle: &AppHandle, pivot_id: &str) -> Result<String, String> {
    require_tier(handle, "delete_pivot")?;
    let id = parse_entity_id(pivot_id, "pivot", "list_pivots")?;

    crate::pivot::commands::delete_pivot_table(
        &handle.state::<AppState>(),
        &handle.state::<crate::persistence::FileState>(),
        &handle.state::<crate::pivot::PivotState>(),
        &handle.state::<crate::persistence::UserFilesState>(),
        &handle.state::<crate::pane_control::PaneControlState>(),
        &handle.state::<crate::ribbon_filter::RibbonFilterState>(),
        &handle.state::<crate::slicer::SlicerState>(),
        &handle.state::<crate::timeline_slicer::TimelineSlicerState>(),
        id,
    )?;

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::Pivot,
    );
    // The pivot's region was cleared: a CELL change, which no domain covers.
    let _ = handle.emit("grid:refresh", ());
    mark_dirty(handle);
    audit(
        handle,
        "delete_pivot",
        &format!("An AI tool deleted pivot {}", pivot_id),
        vec![("pivotId", serde_json::json!(pivot_id))],
    );
    Ok(format!("Deleted pivot id={}", pivot_id))
}

// ============================================================================
// Sheet management
// ============================================================================

/// Render the workbook's sheets as one line each. Pure — unit-tested.
pub(crate) fn format_sheet_inventory(result: &crate::sheets::SheetsResult) -> String {
    let mut out = String::new();
    for s in &result.sheets {
        out.push_str(&format!(
            "- index={} name=\"{}\" kind={} visibility={}{}{}{}\n",
            s.index,
            s.name,
            s.kind,
            s.visibility,
            if s.index == result.active_index { " (active)" } else { "" },
            if s.tab_color.is_empty() {
                String::new()
            } else {
                format!(" tabColor={}", s.tab_color)
            },
            // An EPHEMERAL sheet is deleted without a prompt when the user
            // leaves it: an agent that cannot see this writes lasting work
            // onto a sheet that is about to disappear.
            if s.ephemeral { TEMPORARY_SHEET_MARKER } else { "" },
        ));
    }
    out
}

/// What the sheet inventory appends to a row whose sheet is EPHEMERAL (a
/// drill-through result the user has not kept; `SheetInfo::ephemeral`).
/// The `list_sheets` tool description names it, so an agent knows it may
/// appear and what it means.
pub(crate) const TEMPORARY_SHEET_MARKER: &str = " (temporary: a drill-through result, deleted without a prompt when the user leaves it unless they keep it by double-clicking its tab)";

/// List the workbook's sheets with their 0-based indices — the indices every
/// other sheet tool takes. Read-only.
pub fn list_sheets(handle: &AppHandle) -> Result<String, String> {
    require_tier(handle, "list_sheets")?;
    let result = crate::sheets::get_sheets(handle.state::<AppState>());
    if result.sheets.is_empty() {
        return Ok("(this workbook has no sheets)".to_string());
    }
    let mut out = String::from("Sheets in this workbook:\n");
    out.push_str(&format_sheet_inventory(&result));
    Ok(out)
}

/// Add a sheet at the end of the workbook.
pub fn add_sheet(handle: &AppHandle, name: Option<&str>, kind: Option<&str>) -> Result<String, String> {
    require_tier(handle, "add_sheet")?;
    let result = crate::sheets::add_sheet(
        handle.state::<AppState>(),
        handle.state::<crate::persistence::FileState>(),
        name.map(|s| s.to_string()),
        kind.map(|s| s.to_string()),
    )?;
    // The new sheet is the ACTIVE one (add_sheet switches to it). Reading it
    // by index rather than as the list's last row stays right however the
    // partition rotation placed it.
    let added = result
        .sheets
        .iter()
        .find(|s| s.index == result.active_index)
        .map(|s| (s.index, s.name.clone(), s.kind.clone()))
        .unwrap_or((0, name.unwrap_or("Sheet").to_string(), "worksheet".to_string()));

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::Sheet,
    );
    mark_dirty(handle);
    audit(
        handle,
        "add_sheet",
        &format!("An AI tool added {} \"{}\" at index {}", added.2, added.1, added.0),
        vec![
            ("name", serde_json::json!(added.1)),
            ("index", serde_json::json!(added.0)),
            ("kind", serde_json::json!(added.2)),
        ],
    );
    Ok(format!(
        "Added {} \"{}\" at index {} ({} sheet(s) now). Sheet structure changes are NOT undoable.{}",
        added.2,
        added.1,
        added.0,
        result.sheets.len(),
        if added.2 == "canvas" {
            " A canvas holds objects only: it has no cells, and cell writes to it are refused."
        } else {
            ""
        }
    ))
}

/// Rename a sheet by 0-based index. Cross-sheet formula references are repaired
/// by the underlying command.
pub fn rename_sheet(handle: &AppHandle, index: usize, new_name: &str) -> Result<String, String> {
    require_tier(handle, "rename_sheet")?;
    let old_name = {
        let state = handle.state::<AppState>();
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        names
            .get(index)
            .cloned()
            .ok_or_else(|| format!("Sheet index {} out of range. Use list_sheets.", index))?
    };
    // Through the COMMAND, so the tool carries the pane-control dropdowns that
    // name the sheet exactly as the rename_sheet command does
    // (`sheets::with_pane_controls_following_rename`, wave C W7).
    crate::sheets::rename_sheet(
        handle.state::<AppState>(),
        handle.state::<crate::persistence::FileState>(),
        handle.state::<crate::pivot::types::PivotState>(),
        handle.state::<crate::pane_control::PaneControlState>(),
        index,
        new_name.to_string(),
    )?;

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::Sheet,
    );
    // Every formula naming the sheet was repaired: a CELL change on top of the
    // object one.
    let _ = handle.emit("grid:refresh", ());
    mark_dirty(handle);
    audit(
        handle,
        "rename_sheet",
        &format!("An AI tool renamed sheet {} from \"{}\" to \"{}\"", index, old_name, new_name),
        vec![
            ("index", serde_json::json!(index)),
            ("oldName", serde_json::json!(old_name)),
            ("newName", serde_json::json!(new_name)),
        ],
    );
    Ok(format!(
        "Renamed sheet {} \"{}\" -> \"{}\" (formula references repaired). NOT undoable.",
        index, old_name, new_name
    ))
}

/// What the agent is told when the sheets changed between this tool reading
/// the sheet at `index` and the delete taking its locks
/// (`sheets::SHEETS_CHANGED_UNDER_THE_DELETE`): nothing was deleted, and the
/// indices it holds are stale.
pub(crate) const DELETE_SHEET_RETRY_AFTER_LIST_SHEETS: &str = "The sheets changed while that sheet was \
     being deleted, so nothing was deleted. Call list_sheets to see the current indices, then retry.";

/// The `delete_sheet` tool's body over a plain reference, with the delete
/// handed in: the tool passes the `delete_sheet` COMMAND, a test passes
/// `delete_sheet_impl` (a `State<T>` has no constructor in a test).
///
/// The NAME and the STABLE ID of the sheet at `index` are read under ONE
/// `sheet_names` guard -- `sheet_ids` taken inside it, the order
/// `delete_sheet_impl` takes them in -- and `delete` gets the id, which the
/// delete re-checks under its own locks (review RA-1). This tool runs on the
/// MCP server's own thread, so the main thread can renumber the sheets after
/// the name is read; a delete by index alone then removed ANOTHER sheet while
/// the audit row and the reply named this one. Now it is refused, and the
/// refusal reaches the agent as an instruction to list the sheets again.
/// Returns the name of the sheet that was deleted, with the delete's answer.
pub(crate) fn delete_sheet_at_with(
    state: &AppState,
    index: usize,
    delete: impl FnOnce(usize, identity::SheetId) -> Result<crate::sheets::SheetsResult, String>,
) -> Result<(String, crate::sheets::SheetsResult), String> {
    let out_of_range = || format!("Sheet index {} out of range. Use list_sheets.", index);
    let (name, sheet_id) = {
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let name = names.get(index).cloned().ok_or_else(out_of_range)?;
        let sheet_id = state
            .sheet_ids
            .read()
            .map_err(|e| e.to_string())?
            .get(index)
            .copied()
            .ok_or_else(out_of_range)?;
        (name, sheet_id)
    };
    let result = delete(index, sheet_id).map_err(|refusal| {
        if refusal == crate::sheets::SHEETS_CHANGED_UNDER_THE_DELETE {
            DELETE_SHEET_RETRY_AFTER_LIST_SHEETS.to_string()
        } else {
            refusal
        }
    })?;
    Ok((name, result))
}

/// Delete a sheet by 0-based index.
pub fn delete_sheet(handle: &AppHandle, index: usize) -> Result<String, String> {
    require_tier(handle, "delete_sheet")?;
    // A refusal returns HERE, before the audit row below: a delete that did
    // not happen is never recorded as one.
    let (name, result) = delete_sheet_at_with(&handle.state::<AppState>(), index, |index, sheet_id| {
        crate::sheets::delete_sheet(
            handle.clone(),
            handle.state::<AppState>(),
            handle.state::<crate::persistence::FileState>(),
            handle.state::<crate::pivot::PivotState>(),
            handle.state::<crate::persistence::UserFilesState>(),
            handle.state::<crate::pane_control::PaneControlState>(),
            handle.state::<crate::ribbon_filter::RibbonFilterState>(),
            handle.state::<crate::slicer::SlicerState>(),
            handle.state::<crate::timeline_slicer::TimelineSlicerState>(),
            index,
            Some(sheet_id.to_string()),
        )
    })?;

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::Sheet,
    );
    // References to the deleted sheet became #REF! and the workbook
    // recalculated: a CELL change on top of the object one.
    let _ = handle.emit("grid:refresh", ());
    mark_dirty(handle);
    audit(
        handle,
        "delete_sheet",
        &format!("An AI tool deleted sheet {} (\"{}\")", index, name),
        vec![
            ("index", serde_json::json!(index)),
            ("name", serde_json::json!(name)),
        ],
    );
    Ok(format!(
        "Deleted sheet {} \"{}\" ({} sheet(s) left). NOT undoable — the sheet's data is gone.",
        index,
        name,
        result.sheets.len()
    ))
}

/// Reorder a sheet: move the sheet at `from_index` to `to_index`.
pub fn move_sheet(handle: &AppHandle, from_index: usize, to_index: usize) -> Result<String, String> {
    require_tier(handle, "move_sheet")?;
    let name = {
        let state = handle.state::<AppState>();
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        names
            .get(from_index)
            .cloned()
            .ok_or_else(|| format!("Sheet index {} out of range. Use list_sheets.", from_index))?
    };
    crate::sheets::move_sheet(
        handle.state::<AppState>(),
        handle.state::<crate::persistence::FileState>(),
        handle.state::<crate::slicer::SlicerState>(),
        handle.state::<crate::timeline_slicer::TimelineSlicerState>(),
        handle.state::<crate::ribbon_filter::RibbonFilterState>(),
        handle.state::<crate::persistence::UserFilesState>(),
        handle.state::<crate::pivot::types::PivotState>(),
        handle.state::<crate::pane_control::PaneControlState>(),
        from_index,
        to_index,
    )?;

    // BACKEND-INITIATED, SO NOTHING ON THE FRONTEND RETURNS TO ANNOUNCE IT
    // (§3cd). The domain list is derived from DEPENDENCY_MATRIX, so the
    // cascade's stores are named without anyone having to remember them.
    crate::object_deps::announce_cascade(
        handle,
        crate::object_deps::ObjectKind::Sheet,
    );
    mark_dirty(handle);
    audit(
        handle,
        "move_sheet",
        &format!("An AI tool moved sheet \"{}\" from {} to {}", name, from_index, to_index),
        vec![
            ("name", serde_json::json!(name)),
            ("fromIndex", serde_json::json!(from_index)),
            ("toIndex", serde_json::json!(to_index)),
        ],
    );
    Ok(format!(
        "Moved sheet \"{}\" from index {} to {}. NOT undoable.",
        name, from_index, to_index
    ))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripting::commands::MCP_ACCESS_RESTRICTED;
    use serde_json::json;

    /// Every mutating tool this module exposes.
    const MUTATING_TOOLS: &[&str] = &[
        "update_chart",
        "delete_chart",
        "update_named_range",
        "delete_named_range",
        "update_table",
        "delete_table",
        "update_pivot",
        "delete_pivot",
        "add_sheet",
        "rename_sheet",
        "delete_sheet",
        "move_sheet",
        "draft_object_script",
        "set_object_property",
        "set_object_binding",
    ];

    const READ_TOOLS: &[&str] = &["list_sheets", "list_script_drafts", "get_script_draft", "list_object_properties"];

    /// ScriptState with Script Security "enabled" (so only the AI ceiling
    /// gates) and the given ceiling.
    fn state_with(ceiling: &str) -> ScriptState {
        let state = ScriptState::new();
        *state.security_level.lock().unwrap() = "enabled".to_string();
        *state.mcp_access_level.lock().unwrap() = ceiling.to_string();
        state
    }

    // ---- tier gating ----

    #[test]
    fn every_mutating_tool_needs_at_least_the_mutate_ceiling() {
        let read_only = state_with("read");
        for tool in MUTATING_TOOLS {
            let err = match gate(&read_only, tool) {
                Ok(()) => panic!("{} must be refused at the 'read' ceiling", tool),
                Err(e) => e,
            };
            assert!(
                err.starts_with(MCP_ACCESS_RESTRICTED),
                "{}: expected an access-ceiling refusal, got: {}",
                tool,
                err
            );
        }
    }

    #[test]
    fn the_mutate_ceiling_allows_every_object_tool_but_not_arbitrary_script() {
        let mutate = state_with("mutate");
        for tool in MUTATING_TOOLS {
            assert!(
                gate(&mutate, tool).is_ok(),
                "{} must be allowed at the 'mutate' ceiling — that is the whole point of \
                 adding update/delete tools",
                tool
            );
        }
        // The escape hatch these tools exist to avoid is still gated.
        let err = gate(&mutate, "run_script").unwrap_err();
        assert!(err.starts_with(MCP_ACCESS_RESTRICTED), "got: {}", err);
    }

    #[test]
    fn read_only_tools_need_no_ceiling() {
        let read_only = state_with("read");
        for tool in READ_TOOLS {
            assert!(gate(&read_only, tool).is_ok(), "{} must work at 'read'", tool);
            assert!(required_tier(tool).is_none());
        }
    }

    #[test]
    fn an_unregistered_tool_fails_closed_at_the_script_tier() {
        assert!(matches!(
            required_tier("some_future_tool"),
            Some(McpAccessTier::Script)
        ));
        let mutate = state_with("mutate");
        assert!(gate(&mutate, "some_future_tool").is_err());
    }

    #[test]
    fn the_ceiling_still_defers_to_script_security() {
        let state = state_with("script");
        *state.security_level.lock().unwrap() = "disabled".to_string();
        for tool in MUTATING_TOOLS {
            assert!(
                gate(&state, tool).is_err(),
                "{} must refuse when Script Security is disabled",
                tool
            );
        }
    }

    // ---- chart update / delete: mutation, undo, protection ----

    fn chart_entry(name: &str, sheet: usize) -> ChartEntry {
        let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        ChartEntry {
            id,
            sheet_index: sheet,
            spec_json: serde_json::to_string(&json!({
                "chartId": id.to_string(),
                "name": name,
                "sheetIndex": sheet,
                "x": 100, "y": 100, "width": 480, "height": 320,
                "spec": { "mark": "bar", "data": "Sheet1!A1:B2", "series": [] }
            }))
            .unwrap(),
        }
    }

    fn valid_spec() -> serde_json::Value {
        json!({ "mark": "line", "data": "Sheet1!A1:D13", "series": [{ "name": "Revenue" }] })
    }

    #[test]
    fn update_chart_merges_fields_and_records_one_undo_entry() {
        let state = crate::create_app_state();
        let fs = crate::persistence::FileState::default();
        let effect = crate::document_effect::DocumentEffect::mutates(&fs);
        let entry = chart_entry("Old", 0);
        let id = entry.id.to_string();
        state.charts.write(&effect).unwrap().push(entry);
        assert!(!state.undo_stack.lock().unwrap().can_undo());

        let summary = update_chart_core(
            &state,
            &fs,
            &id,
            Some(&valid_spec()),
            Some("Revenue by Region"),
            None,
            &ChartPlacement { width: Some(640.0), ..Default::default() },
        )
        .expect("update should succeed");
        assert!(summary.contains("Updated chart"));

        let charts = state.charts.read().unwrap();
        let stored: serde_json::Value = serde_json::from_str(&charts[0].spec_json).unwrap();
        assert_eq!(stored["name"], "Revenue by Region");
        assert_eq!(stored["spec"]["mark"], "line");
        assert_eq!(stored["width"], 640.0);
        // Untouched fields survive the merge.
        assert_eq!(stored["x"], 100);
        assert_eq!(stored["height"], 320);
        // The id is never taken from the caller's payload.
        assert_eq!(stored["chartId"], id);
        drop(charts);

        let undo = state.undo_stack.lock().unwrap();
        assert!(undo.can_undo(), "the edit must be undoable");
        assert_eq!(undo.undo_description(), Some("Edit chart (AI)"));
    }

    #[test]
    fn update_chart_rejects_an_unknown_id_a_bad_spec_and_an_empty_edit() {
        let state = crate::create_app_state();
        let fs = crate::persistence::FileState::default();
        let effect = crate::document_effect::DocumentEffect::mutates(&fs);
        let entry = chart_entry("Only", 0);
        let id = entry.id.to_string();
        state.charts.write(&effect).unwrap().push(entry);

        // Unknown id.
        let missing = identity::EntityId::from_bytes([9u8; 16]).to_string();
        assert!(update_chart_core(&state, &fs, &missing, None, Some("x"), None, &ChartPlacement::default()).is_err());
        // Not an EntityId at all.
        assert!(update_chart_core(&state, &fs, "not-a-uuid", None, Some("x"), None, &ChartPlacement::default()).is_err());
        // A spec that fails the structural backstop.
        assert!(update_chart_core(&state, &fs, &id, Some(&json!({ "mark": "bar" })), None, None, &ChartPlacement::default()).is_err());
        // Nothing to change.
        assert!(update_chart_core(&state, &fs, &id, None, None, None, &ChartPlacement::default()).is_err());
        // None of the failures recorded an undo entry or touched the chart.
        assert!(!state.undo_stack.lock().unwrap().can_undo());
        let charts = state.charts.read().unwrap();
        let stored: serde_json::Value = serde_json::from_str(&charts[0].spec_json).unwrap();
        assert_eq!(stored["name"], "Only");
    }

    #[test]
    fn delete_chart_removes_it_and_records_undo() {
        let state = crate::create_app_state();
        let keep = chart_entry("Keep", 0);
        let drop_me = chart_entry("Drop", 1);
        let keep_id = keep.id;
        let drop_id = drop_me.id.to_string();
        {
            // Fixture seeding, not a document edit.
            let seed = crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::LoadingFromDisk,
            );
            let mut charts = state.charts.write(&seed).unwrap();
            charts.push(keep);
            charts.push(drop_me);
        }

        let fs = crate::persistence::FileState::default();
        let pane_state = crate::pane_control::PaneControlState::new();
        let effect = crate::document_effect::DocumentEffect::mutates(&fs);
        let sheet =
            delete_chart_core(&state, &pane_state, &effect, &drop_id).expect("delete should succeed");
        assert!(
            fs.is_dirty(),
            "an AI-driven chart delete must dirty the document: the MCP path never runs              the frontend, so nothing else would"
        );
        assert_eq!(sheet, 1);

        let charts = state.charts.read().unwrap();
        assert_eq!(charts.len(), 1);
        assert_eq!(charts[0].id, keep_id);
        drop(charts);

        let undo = state.undo_stack.lock().unwrap();
        assert!(undo.can_undo());
        assert_eq!(undo.undo_description(), Some("Delete chart (AI)"));

        // Deleting it twice is an error, not a silent success.
        drop(undo);
        assert!(delete_chart_core(&state, &pane_state, &effect, &drop_id).is_err());
    }

    #[test]
    fn chart_edits_respect_sheet_protection() {
        let state = crate::create_app_state();
        let seed_fs = crate::persistence::FileState::default();
        let seed = crate::document_effect::DocumentEffect::mutates(&seed_fs);
        let entry = chart_entry("Protected", 0);
        let id = entry.id.to_string();
        state.charts.write(&seed).unwrap().push(entry);
        {
            let mut protection = state
                .sheet_protection
                .write(&crate::document_effect::test_seed_effect())
                .unwrap();
            let mut p = crate::protection::SheetProtection::default();
            p.protected = true;
            p.options.allow_edit_objects = false;
            protection.insert(0, p);
        }

        let fs = crate::persistence::FileState::default();
        let pane_state = crate::pane_control::PaneControlState::new();
        let effect = crate::document_effect::DocumentEffect::mutates(&fs);
        assert!(update_chart_core(&state, &fs, &id, None, Some("nope"), None, &ChartPlacement::default()).is_err());
        assert!(delete_chart_core(&state, &pane_state, &effect, &id).is_err());
        // Nothing changed, nothing recorded.
        assert_eq!(state.charts.read().unwrap().len(), 1);
        assert!(!state.undo_stack.lock().unwrap().can_undo());
    }

    // ---- a rename must not destroy the name's macro ----

    fn named_range_script(id: &str, instance: &str) -> persistence::SavedObjectScript {
        persistence::SavedObjectScript {
            id: id.to_string(),
            name: format!("Script for {}", instance),
            object_type: persistence::ScriptableObjectType::NamedRange,
            instance_id: Some(instance.to_string()),
            source: "// @capability bi.query\nexport function onChange() {}\n".to_string(),
            access_level: persistence::ScriptAccessLevel::Restricted,
            description: None,
            provenance: persistence::ScriptProvenance::Local,
            package_name: None,
            package_version: None,
            declared_capabilities: vec!["bi.query".to_string()],
        }
    }

    // The tool's own collect / re-point helpers are gone: the rename every route
    // runs re-points the scripts itself, in its one undo step -- the which-
    // scripts rules (case-insensitive, NamedRange only, other names untouched)
    // and the undo are pinned in `named_ranges::rename_tests`
    // (`a_rename_carries_the_names_scripts_and_one_undo_puts_both_back`).

    // ---- update_named_range: an AI rename is the Name Manager's rename ----

    /// `Rate` (`=Sheet1!$A$1`, A1 = 2, A2 = 5) read by `=Rate*2` in B1, which
    /// shows 4, with the name edges built the way a load builds them.
    struct NameFixture {
        state: AppState,
        file: crate::persistence::FileState,
        files: crate::persistence::UserFilesState,
        pivots: crate::pivot::PivotState,
        pane: crate::pane_control::PaneControlState,
        filters: crate::ribbon_filter::RibbonFilterState,
    }

    impl NameFixture {
        fn new() -> Self {
            let state = crate::create_app_state();
            let seed = crate::document_effect::test_seed_effect();
            state.named_ranges.write(&seed).unwrap().insert(
                "RATE".to_string(),
                crate::named_ranges::NamedRange {
                    name: "Rate".to_string(),
                    sheet_index: None,
                    refers_to: "=Sheet1!$A$1".to_string(),
                    comment: None,
                    folder: None,
                },
            );
            let mut reader = engine::Cell::new_formula_with_ast(parser::parse("=Rate*2").expect("=Rate*2 parses"));
            reader.value = engine::CellValue::Number(4.0);
            {
                let mut grid = state.grid.write(&seed).unwrap();
                let mut grids = state.grids.write(&seed).unwrap();
                if grids.is_empty() {
                    grids.push(engine::Grid::new());
                }
                for (row, col, cell) in [
                    (0, 0, engine::Cell::new_number(2.0)),
                    (1, 0, engine::Cell::new_number(5.0)),
                    (0, 1, reader),
                ] {
                    grid.set_cell(row, col, cell.clone());
                    grids[0].set_cell(row, col, cell);
                }
            }
            crate::undo_commands::rebuild_all_dependencies(&state);
            NameFixture {
                state,
                file: crate::persistence::FileState::default(),
                files: crate::persistence::UserFilesState::default(),
                pivots: crate::pivot::PivotState::new(),
                pane: crate::pane_control::PaneControlState::new(),
                filters: crate::ribbon_filter::RibbonFilterState::new(),
            }
        }

        fn edit(
            &self,
            name: &str,
            new_name: Option<&str>,
            refers_to: Option<&str>,
        ) -> Result<NamedRangeEdit, String> {
            update_named_range_core(
                &self.state,
                &self.file,
                &self.files,
                &self.pivots,
                &self.pane,
                &self.filters,
                name,
                new_name,
                refers_to,
                None,
                None,
            )
        }

        fn b1_formula(&self) -> String {
            self.state.grid.read().unwrap().get_cell(0, 1).and_then(|c| c.formula_string()).unwrap_or_default()
        }

        fn b1_value(&self) -> engine::CellValue {
            self.state.grid.read().unwrap().get_cell(0, 1).map(|c| c.value.clone()).unwrap_or(engine::CellValue::Empty)
        }

        fn names(&self) -> Vec<(String, String)> {
            let mut out: Vec<(String, String)> = self
                .state
                .named_ranges
                .read()
                .unwrap()
                .iter()
                .map(|(key, n)| (key.clone(), n.name.clone()))
                .collect();
            out.sort();
            out
        }
    }

    /// revB#1. The tool renamed by DELETE + CREATE: the delete rewrites no
    /// formula (Excel's rule for a delete) and the create repoints none, so
    /// `=Rate*2` kept saying `Rate`, showed `#NAME?`, and it took two undo
    /// steps. It now runs the Name Manager's rename: [LIVE] Excel 16,
    /// `Names("Rate").Name = "Tax"` turns B1 into `=Tax*2`, still 4. The name's
    /// object script is carried to the new name -- by the rename itself now
    /// (`named_ranges::repoint_named_range_scripts`), not by this tool.
    ///
    /// SABOTAGE: put the delete + create back in `update_named_range_core` --
    /// B1 keeps reading `Rate` and the first assertion fails.
    #[test]
    fn an_ai_rename_repoints_every_reader_in_one_undo_step() {
        let f = NameFixture::new();
        {
            let seed = crate::document_effect::test_seed_effect();
            f.state.object_scripts.write(&seed).unwrap().push(named_range_script("s-rate", "Rate"));
        }

        let edit = f.edit("Rate", Some("Tax"), None).expect("the rename succeeds");

        assert_eq!(
            f.b1_formula(),
            "Tax*2",
            "the reader follows the rename -- a delete + create leaves it reading a name that is gone"
        );
        assert_eq!(f.b1_value(), engine::CellValue::Number(4.0), "...and still evaluates, not #NAME?");
        assert_eq!(f.names(), vec![("TAX".to_string(), "Tax".to_string())]);
        assert_eq!(edit.undo_steps, 1, "{edit:?}");
        {
            let undo = f.state.undo_stack.lock().unwrap();
            assert_eq!(undo.undo_depth(), 1, "one undo step, not delete + create");
            assert_eq!(undo.undo_description(), Some("Rename name"));
        }
        let scripts = f.state.object_scripts.read().unwrap();
        assert_eq!(scripts.len(), 1, "the name's script is neither lost nor duplicated");
        assert_eq!(scripts[0].instance_id.as_deref(), Some("Tax"), "and it follows the name");
    }

    /// A rename that ALSO redefines the name: the Name Manager's rename, then
    /// its edit addressed to the new spelling -- two steps, reported -- and the
    /// reader follows both (`=Tax*2` over A2 = 5).
    #[test]
    fn an_ai_rename_that_also_redefines_moves_the_reader_to_the_new_definition() {
        let f = NameFixture::new();
        let edit = f.edit("Rate", Some("Tax"), Some("=Sheet1!$A$2")).expect("rename + redefine");
        assert_eq!(f.b1_formula(), "Tax*2");
        assert_eq!(f.b1_value(), engine::CellValue::Number(10.0), "B1 reads the new definition");
        assert_eq!(edit.undo_steps, 2, "{edit:?}");
        assert_eq!(f.state.undo_stack.lock().unwrap().undo_depth(), 2);
        assert_eq!(
            f.state.named_ranges.read().unwrap().get("TAX").map(|n| n.refers_to.clone()).as_deref(),
            Some("=Sheet1!$A$2")
        );
    }

    /// A case-only change is a rename too: the old tool compared the names
    /// case-insensitively, took the "no rename" branch and stored the old
    /// spelling again, so `Rate` -> `rate` changed nothing at all. The rename
    /// re-spells the entry and the references (which the fixture's parse
    /// stored as `RATE`: the lexer uppercases a bare identifier).
    ///
    /// SABOTAGE: decide `renaming` case-insensitively again -- the spelling
    /// assertion fails.
    #[test]
    fn an_ai_case_only_rename_respells_the_name_and_its_readers() {
        let f = NameFixture::new();
        assert_eq!(f.b1_formula(), "RATE*2", "precondition: the stored spelling differs from the new one");
        let edit = f.edit("Rate", Some("rate"), None).expect("re-spell");
        assert_eq!(f.names(), vec![("RATE".to_string(), "rate".to_string())], "the entry is re-spelled");
        assert_eq!(f.b1_formula(), "rate*2", "and so are its readers");
        assert_eq!(edit.undo_steps, 1, "{edit:?}");
    }

    /// An edit that changes nothing records nothing and leaves the document
    /// clean; a refused rename (a table holds the name) moves nothing.
    #[test]
    fn an_ai_name_edit_that_changes_nothing_or_is_refused_leaves_the_workbook_alone() {
        let f = NameFixture::new();
        let edit = f.edit("Rate", None, Some("=Sheet1!$A$1")).expect("a no-op edit is not an error");
        assert_eq!(edit.undo_steps, 0, "{edit:?}");
        assert!(!f.file.is_dirty(), "a no-op edit must not mark the workbook modified");
        assert_eq!(f.state.undo_stack.lock().unwrap().undo_depth(), 0);

        f.state.table_names.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
            "TAX".to_string(),
            (0, identity::EntityId::from_bytes(identity::generate_uuid_v7())),
        );
        let before = f.b1_formula();
        let refused = f.edit("Rate", Some("Tax"), None);
        assert!(refused.is_err(), "a name may not take a table's name: {refused:?}");
        assert_eq!(f.names(), vec![("RATE".to_string(), "Rate".to_string())], "nothing moved");
        assert_eq!(f.b1_formula(), before, "no reader was repointed");
        assert!(!f.file.is_dirty(), "a refused rename leaves the workbook clean");
    }

    // ---- audit ----

    #[test]
    fn record_mcp_tool_action_writes_an_always_on_entry_with_the_tool_fields() {
        let state = crate::create_app_state();
        // Collaboration auditing is OFF by default; script activity is recorded
        // regardless, which is exactly what these tools rely on.
        assert!(!state.audit_log.read().unwrap().enabled);

        crate::scripting::commands::record_mcp_tool_action(
            &state,
            "delete_chart",
            "An AI tool deleted chart abc on sheet 2",
            vec![("chartId", json!("abc")), ("sheet", json!(1))],
        );

        let log = state.audit_log.read().unwrap();
        assert_eq!(log.entries.len(), 1);
        let entry = &log.entries[0];
        assert!(entry.description.contains("deleted chart abc"));
        assert_eq!(entry.extra.get("surface"), Some(&json!("mcp")));
        assert_eq!(entry.extra.get("tool"), Some(&json!("delete_chart")));
        assert_eq!(entry.extra.get("chartId"), Some(&json!("abc")));
        assert_eq!(entry.extra.get("sheet"), Some(&json!(1)));
    }

    // ---- delete_sheet: the id read with the name (review RA-1) ----

    /// The `delete_sheet` COMMAND's body over plain states, minus the slicer
    /// work and the BI re-query (which need an AppHandle).
    fn delete_through_the_impl(
        state: &AppState,
        file: &crate::persistence::FileState,
        index: usize,
        expected: Option<identity::SheetId>,
    ) -> Result<crate::sheets::SheetsResult, String> {
        crate::sheets::delete_sheet_impl(
            state,
            file,
            &crate::pivot::types::PivotState::new(),
            &crate::persistence::UserFilesState::default(),
            &crate::pane_control::PaneControlState::new(),
            &crate::ribbon_filter::RibbonFilterState::new(),
            &crate::slicer::SlicerState::new(),
            &crate::timeline_slicer::TimelineSlicerState::new(),
            index,
            false,
            expected,
        )
    }

    fn sheet_names(state: &AppState) -> Vec<String> {
        state.sheet_names.read().unwrap().clone()
    }

    /// The agent asks to delete index 2, "Q3". On the main thread the user
    /// leaves the drill sheet below it and the strip deletes that sheet, so Q3
    /// moves to 1 and Q4 to 2 -- after this tool read the name. A delete by
    /// index alone then removed Q4 while the audit row and the reply said Q3.
    ///
    /// SABOTAGE: make `delete_sheet_at_with` pass the delete's refusal through
    /// unchanged -- the retry-instruction assertion fails (nothing is deleted
    /// either way: that half is the delete's own id check).
    #[test]
    fn delete_sheet_turns_a_renumbering_after_its_name_read_into_a_retry_and_deletes_nothing() {
        let state = crate::create_app_state();
        let setup = crate::persistence::FileState::default();
        for name in ["Drill", "Q3", "Q4"] {
            crate::sheets::add_sheet_inner(&state, &setup, Some(name.to_string()), ::persistence::SheetKind::Worksheet)
                .expect("add");
        }
        assert_eq!(sheet_names(&state), vec!["Sheet1", "Drill", "Q3", "Q4"]);
        let clean = crate::persistence::FileState::default();

        let err = delete_sheet_at_with(&state, 2, |index, id| {
            delete_through_the_impl(&state, &setup, 1, None).expect("the main thread's delete of the drill sheet");
            assert_eq!(sheet_names(&state)[index], "Q4", "fixture: the index the tool read now names Q4");
            delete_through_the_impl(&state, &clean, index, Some(id))
        })
        .unwrap_err();
        assert_eq!(sheet_names(&state), vec!["Sheet1", "Q3", "Q4"], "Q4 survives: nothing was deleted");
        assert_eq!(err, DELETE_SHEET_RETRY_AFTER_LIST_SHEETS, "the agent is told to list the sheets again");
        assert!(err.contains("list_sheets") && err.contains("nothing was deleted"), "{err}");
        assert!(!clean.is_dirty(), "the refusal leaves the document clean");

        // POSITIVE CONTROL: with nothing in the window, the sheet the tool
        // named is the sheet deleted, and the name it answers is that sheet's.
        let (name, result) = delete_sheet_at_with(&state, 1, |index, id| delete_through_the_impl(&state, &clean, index, Some(id)))
            .expect("delete Q3");
        assert_eq!(name, "Q3");
        assert_eq!(sheet_names(&state), vec!["Sheet1", "Q4"]);
        assert_eq!(result.sheets.len(), 2);

        // Any other refusal reaches the agent as it is, and an index that names
        // no sheet never reaches the delete.
        let other = delete_sheet_at_with(&state, 1, |_, _| Err("Cannot delete the last visible sheet".to_string())).unwrap_err();
        assert_eq!(other, "Cannot delete the last visible sheet");
        let err = delete_sheet_at_with(&state, 9, |_, _| panic!("the delete ran for an index that names no sheet")).unwrap_err();
        assert!(err.contains("out of range") && err.contains("list_sheets"), "{err}");
    }

    /// The comment-stripped code of the top-level `fn` in this file that starts
    /// at `signature`, to its closing brace at column 0.
    fn objects_fn_code(signature: &str) -> String {
        let src = include_str!("objects.rs");
        let at = src.find(signature).unwrap_or_else(|| panic!("{signature} not found in mcp/objects.rs"));
        let rest = &src[at..];
        let end = rest.find("\n}\n").map_or(rest.len(), |e| e + 3);
        crate::object_deps_census_tests::strip_comments(&rest[..end])
    }

    /// The tool itself needs an AppHandle, so its WIRING is pinned from the
    /// source: its name, id and answer come from `delete_sheet_at_with` (which
    /// the test above drives), the COMMAND gets the id, the one audit row comes
    /// after the helper's `?` -- a refused delete is never recorded as one --
    /// and the helper reads the id inside the `sheet_names` guard, after it
    /// (the order `delete_sheet_impl` takes the two in).
    ///
    /// SABOTAGE: (a) pass `None` to the command instead of the id -- the
    /// id assertion fails; (b) read `sheet_ids` before `sheet_names` in the
    /// helper -- the lock-order assertion fails.
    #[test]
    fn the_delete_sheet_tool_hands_the_command_the_id_and_audits_only_a_delete_that_happened() {
        let tool = objects_fn_code("pub fn delete_sheet(handle: &AppHandle");
        let helper = tool
            .find("let (name, result) = delete_sheet_at_with(")
            .expect("the tool no longer takes the name and the delete's answer from delete_sheet_at_with");
        let command = tool.find("crate::sheets::delete_sheet(").expect("the tool no longer runs the delete_sheet COMMAND");
        let unwrapped = tool[helper..].find("})?;").map(|at| helper + at).expect("the helper's answer is no longer unwrapped with `?`");
        assert!(helper < command && command < unwrapped, "the command must run inside the helper's delete");
        assert!(
            tool[command..unwrapped].contains("Some(sheet_id.to_string())"),
            "the tool no longer hands the delete_sheet command the sheet's id"
        );
        assert_eq!(tool.matches("audit(").count(), 1, "one audit row, for the delete that happened");
        assert!(tool.find("audit(").unwrap() > unwrapped, "the audit row must come after the helper's `?`");

        let read = objects_fn_code("pub(crate) fn delete_sheet_at_with(");
        let names = read.find(".sheet_names").expect("the helper no longer reads the name");
        let ids = read.find(".sheet_ids").expect("the helper no longer reads the id");
        let guard_ends = read.find("(name, sheet_id)\n").expect("the helper's read block no longer ends in its (name, sheet_id) pair");
        assert!(
            names < ids && ids < guard_ends,
            "the id must be read inside the sheet_names guard, after it (the order delete_sheet_impl takes them)"
        );
    }

    // ---- pure argument parsing ----

    #[test]
    fn pivot_area_parsing_accepts_the_documented_vocabulary() {
        for (input, expected) in [
            ("row", PivotArea::Row),
            ("Rows", PivotArea::Row),
            ("column", PivotArea::Column),
            ("cols", PivotArea::Column),
            ("values", PivotArea::Value),
            ("data", PivotArea::Value),
            ("filter", PivotArea::Filter),
            ("none", PivotArea::None),
            ("remove", PivotArea::None),
        ] {
            assert_eq!(parse_pivot_area(input).unwrap(), expected, "input {}", input);
        }
        assert!(parse_pivot_area("diagonal").is_err());
    }

    #[test]
    fn aggregation_parsing_covers_the_engine_set_and_rejects_junk() {
        use crate::pivot::types::AggregationFunction as F;
        assert_eq!(parse_aggregation_function("SUM").unwrap(), F::Sum);
        assert_eq!(parse_aggregation_function("avg").unwrap(), F::Average);
        assert_eq!(parse_aggregation_function("stdDevP").unwrap(), F::StandardDeviationP);
        assert_eq!(parse_aggregation_function("countNumbers").unwrap(), F::CountNumbers);
        let err = parse_aggregation_function("median").unwrap_err();
        assert!(err.contains("median"), "the message names the bad input: {}", err);
    }

    #[test]
    fn pivot_field_lookup_is_case_insensitive_and_lists_the_alternatives() {
        let available = vec!["Region".to_string(), "Revenue".to_string()];
        assert_eq!(resolve_pivot_field_index("revenue", &available).unwrap(), 1);
        let err = resolve_pivot_field_index("Margin", &available).unwrap_err();
        assert!(err.contains("Region, Revenue"), "got: {}", err);
    }

    #[test]
    fn sheet_inventory_renders_index_name_visibility_and_the_active_marker() {
        let result = crate::sheets::SheetsResult {
            sheets: vec![
                crate::sheets::SheetInfo {
                    index: 0,
                    name: "Data".to_string(),
                    freeze_row: None,
                    freeze_col: None,
                    tab_color: String::new(),
                    visibility: "visible".to_string(),
                    sheet_id: String::new(),
                    kind: "worksheet".to_string(),
                    canvas_layout: None,
                    ephemeral: false,
                },
                crate::sheets::SheetInfo {
                    index: 1,
                    name: "Report".to_string(),
                    freeze_row: None,
                    freeze_col: None,
                    tab_color: "#ff0000".to_string(),
                    visibility: "hidden".to_string(),
                    sheet_id: String::new(),
                    kind: "canvas".to_string(),
                    canvas_layout: Some(::persistence::CanvasLayout::default()),
                    ephemeral: true,
                },
            ],
            active_index: 1,
        };
        let out = format_sheet_inventory(&result);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("index=0"));
        assert!(lines[0].contains("name=\"Data\""));
        assert!(lines[0].contains("kind=worksheet"));
        assert!(lines[1].contains("kind=canvas"), "a canvas must say so: {}", lines[1]);
        assert!(!lines[0].contains("(active)"));
        assert!(lines[1].contains("visibility=hidden"));
        assert!(lines[1].contains("(active)"));
        assert!(lines[1].contains("tabColor=#ff0000"));
        // A temporary (drill-through) sheet says so, and only that row does:
        // an agent must not put lasting work on a sheet that disappears.
        assert!(lines[1].contains("(temporary:"), "a temporary sheet must say so: {}", lines[1]);
        assert!(lines[1].ends_with(TEMPORARY_SHEET_MARKER), "the marker closes the row: {}", lines[1]);
        assert!(!lines[0].contains("temporary"), "an ordinary sheet carries no marker: {}", lines[0]);
    }

    #[test]
    fn the_list_sheets_tool_description_names_the_temporary_marker() {
        // The description lists every field a row carries; a marker an agent
        // was never told about is one it cannot act on.
        let server = include_str!("server.rs");
        let at = server.find("async fn list_sheets(").expect("the list_sheets tool");
        let attribute = &server[server[..at].rfind("#[tool(").expect("its #[tool] attribute")..at];
        assert!(attribute.contains("(temporary: ...)"), "list_sheets does not name the marker: {attribute}");
        assert!(attribute.contains("keep"), "nor how the user keeps such a sheet: {attribute}");
    }
}
