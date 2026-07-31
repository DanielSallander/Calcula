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
    if let Ok(mut modified) = handle
        .state::<crate::persistence::FileState>()
        .is_modified
        .lock()
    {
        *modified = true;
    }
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
pub(crate) fn update_chart_core(
    state: &AppState,
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
        let charts = state.charts.lock().map_err(|e| e.to_string())?;
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
        let sheet_count = state.sheet_names.lock().map_err(|e| e.to_string())?.len();
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
        let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
        let slot = charts
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("Chart '{}' disappeared during the edit.", chart_id))?;
        *slot = updated;
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
    let summary = update_chart_core(&state, chart_id, spec, name, sheet_index, placement)?;
    drop(state);

    let _ = handle.emit("charts:refresh", ());
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
pub(crate) fn delete_chart_core(state: &AppState, chart_id: &str) -> Result<usize, String> {
    let id = parse_entity_id(chart_id, "chart", "list_charts")?;

    let previous: ChartEntry = {
        let charts = state.charts.lock().map_err(|e| e.to_string())?;
        charts
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| format!("No chart with id '{}'. Use list_charts to see available ids.", chart_id))?
    };
    crate::protection::check_sheet_action(state, previous.sheet_index, "editObjects", "delete objects")?;

    {
        let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
        charts.retain(|c| c.id != id);
    }
    crate::undo_commands::record_chart_undo(state, id, Some(previous.clone()), "Delete chart (AI)");
    // C10 lifecycle hygiene, exactly like chart_commands::delete_chart.
    crate::scripting::object_script_commands::prune_scripts_for_instance(state, &id.to_string());

    Ok(previous.sheet_index)
}

/// Delete a chart from an AI client.
pub fn delete_chart(handle: &AppHandle, chart_id: &str) -> Result<String, String> {
    require_tier(handle, "delete_chart")?;
    let state = handle.state::<AppState>();
    let sheet = delete_chart_core(&state, chart_id)?;
    drop(state);

    let _ = handle.emit("charts:refresh", ());
    mark_dirty(handle);
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

/// Detach and return every object script bound to named range `name`.
///
/// `named_ranges::delete_named_range` PRUNES these (correct when the name is
/// really going away). A rename runs through that same delete, so without this
/// the user's macro would be silently destroyed by what they asked to be a
/// rename. Returns the removed scripts so the caller can re-point them.
pub(crate) fn take_named_range_scripts(
    state: &AppState,
    name: &str,
) -> Vec<persistence::SavedObjectScript> {
    let Ok(scripts) = state.object_scripts.lock() else {
        return Vec::new();
    };
    scripts
        .iter()
        .filter(|s| {
            s.object_type == persistence::ScriptableObjectType::NamedRange
                && s.instance_id
                    .as_deref()
                    .map(|id| id.eq_ignore_ascii_case(name))
                    .unwrap_or(false)
        })
        .cloned()
        .collect()
}

/// Re-attach previously detached scripts under `instance_id`. A no-op for an
/// empty list.
pub(crate) fn restore_named_range_scripts(
    state: &AppState,
    mut scripts: Vec<persistence::SavedObjectScript>,
    instance_id: &str,
) {
    if scripts.is_empty() {
        return;
    }
    let Ok(mut stored) = state.object_scripts.lock() else {
        return;
    };
    for script in scripts.drain(..) {
        // Re-binding only; ids, source, provenance and the declared-capability
        // ceiling are carried over untouched.
        let mut rebound = script;
        rebound.instance_id = Some(instance_id.to_string());
        stored.retain(|s| s.id != rebound.id);
        stored.push(rebound);
    }
}

/// Edit an existing name: its target (`refers_to`), comment, scope, and/or the
/// name itself. Reuses the SAME undoable commands the Name Manager calls.
///
/// A RENAME is done as delete + create rather than through `rename_named_range`
/// on purpose: `rename_named_range` records no undo entry AND skips the
/// name-vs-table namespace collision check, so an AI rename could shadow a
/// table with no way back. delete+create runs both validations and produces two
/// undo entries (reported in the result). The one thing delete+create gets
/// wrong on its own — pruning the name's object scripts — is repaired by
/// `take_named_range_scripts` / `restore_named_range_scripts` around it.
pub fn update_named_range(
    handle: &AppHandle,
    name: &str,
    new_name: Option<&str>,
    refers_to: Option<&str>,
    comment: Option<Option<String>>,
    sheet_index: Option<Option<usize>>,
) -> Result<String, String> {
    require_tier(handle, "update_named_range")?;

    if new_name.is_none() && refers_to.is_none() && comment.is_none() && sheet_index.is_none() {
        return Err(
            "update_named_range needs at least one of: new_name, refers_to, comment, sheet_index."
                .to_string(),
        );
    }

    let key = name.to_uppercase();
    let existing = {
        let state = handle.state::<AppState>();
        let ranges = state.named_ranges.lock().map_err(|e| e.to_string())?;
        ranges.get(&key).cloned().ok_or_else(|| {
            format!("Named range '{}' does not exist. Use list_named_ranges to see the names.", name)
        })?
    };

    // Resolved target state (unspecified fields keep their current value).
    let target_refers_to = refers_to.map(|s| s.to_string()).unwrap_or(existing.refers_to.clone());
    let target_comment = comment.unwrap_or(existing.comment.clone());
    let target_scope = sheet_index.unwrap_or(existing.sheet_index);
    let target_name = new_name.unwrap_or(name);

    let renaming = !target_name.eq_ignore_ascii_case(name);
    let mut undo_steps = 1;

    if renaming {
        // Rescue the name's object scripts BEFORE the delete prunes them.
        let attached = take_named_range_scripts(&handle.state::<AppState>(), name);

        // Remove the old name first (undoable), then create the new one
        // (undoable + fully validated). Two entries; reported honestly.
        let removed = crate::named_ranges::delete_named_range(
            handle.state::<AppState>(),
            name.to_string(),
        );
        if !removed.success {
            restore_named_range_scripts(&handle.state::<AppState>(), attached, &existing.name);
            return Err(removed
                .error
                .unwrap_or_else(|| format!("Failed to remove named range '{}'", name)));
        }
        let created = crate::named_ranges::create_named_range(
            handle.state::<AppState>(),
            target_name.to_string(),
            target_scope,
            target_refers_to.clone(),
            target_comment.clone(),
            existing.folder.clone(),
        );
        if !created.success {
            // Put the original back so a rejected rename is not a silent delete.
            let _ = crate::named_ranges::create_named_range(
                handle.state::<AppState>(),
                existing.name.clone(),
                existing.sheet_index,
                existing.refers_to.clone(),
                existing.comment.clone(),
                existing.folder.clone(),
            );
            restore_named_range_scripts(&handle.state::<AppState>(), attached, &existing.name);
            return Err(created
                .error
                .unwrap_or_else(|| format!("Failed to create named range '{}'", target_name)));
        }
        // Re-point the rescued scripts at the new name.
        restore_named_range_scripts(&handle.state::<AppState>(), attached, target_name);
        undo_steps = 2;
    } else {
        let result = crate::named_ranges::update_named_range(
            handle.state::<AppState>(),
            existing.name.clone(),
            target_scope,
            target_refers_to.clone(),
            target_comment.clone(),
            existing.folder.clone(),
        );
        if !result.success {
            return Err(result
                .error
                .unwrap_or_else(|| format!("Failed to update named range '{}'", name)));
        }
    }

    let _ = handle.emit("named-ranges:refresh", ());
    mark_dirty(handle);
    audit(
        handle,
        "update_named_range",
        &format!("An AI tool edited named range '{}' -> {}", target_name, target_refers_to),
        vec![
            ("name", serde_json::json!(name)),
            ("newName", serde_json::json!(new_name)),
            ("refersTo", serde_json::json!(target_refers_to)),
            ("sheetIndex", serde_json::json!(target_scope)),
        ],
    );

    Ok(format!(
        "Updated named range '{}' -> {} ({} undo step(s))",
        target_name, target_refers_to, undo_steps
    ))
}

/// Delete a name. Reuses the undoable Name Manager command (which also prunes
/// object scripts attached to the name).
pub fn delete_named_range(handle: &AppHandle, name: &str) -> Result<String, String> {
    require_tier(handle, "delete_named_range")?;

    let result = crate::named_ranges::delete_named_range(
        handle.state::<AppState>(),
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

    let _ = handle.emit("named-ranges:refresh", ());
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
            handle.state::<AppState>(),
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
            handle.state::<AppState>(),
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

    let _ = handle.emit("tables:refresh", ());
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

    let result = crate::tables::delete_table(handle.state::<AppState>(), id);
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

    let _ = handle.emit("tables:refresh", ());
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
    let snapshot = serde_json::json!({
        "pivot_id": pivot_id,
        "definition": definition,
        "overwritten_cells": [],
        "dest_sheet_idx": dest_sheet_idx,
    });
    let data = serde_json::to_vec(&snapshot).unwrap_or_default();
    let Ok(mut undo_stack) = state.undo_stack.lock() else {
        return;
    };
    let opened = !undo_stack.has_open_transaction();
    if opened {
        undo_stack.begin_transaction(description.to_string());
    }
    undo_stack.record_custom_restore("pivot_definition".to_string(), data, description);
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
        let tables = pivot_state.pivot_tables.lock().map_err(|e| e.to_string())?;
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
            handle.state::<crate::pivot::PivotState>(),
            crate::pivot::types::UpdatePivotPropertiesRequest {
                pivot_id: id,
                name: Some(n.to_string()),
                allow_multiple_filters_per_field: None,
                enable_data_value_editing: None,
                refresh_on_open: None,
                use_custom_sort_lists: None,
            },
        )?;
        applied.push(format!("renamed to \"{}\"", n));
    }

    for (index, axis, position, label) in resolved_moves {
        crate::pivot::commands::move_pivot_field(
            handle.state::<AppState>(),
            handle.state::<crate::pivot::PivotState>(),
            handle.state::<crate::pane_control::PaneControlState>(),
            handle.state::<crate::ribbon_filter::RibbonFilterState>(),
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
            handle.state::<crate::pivot::PivotState>(),
            handle.state::<crate::pane_control::PaneControlState>(),
            handle.state::<crate::ribbon_filter::RibbonFilterState>(),
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
            handle.state::<crate::pivot::PivotState>(),
            handle.state::<crate::pane_control::PaneControlState>(),
            handle.state::<crate::ribbon_filter::RibbonFilterState>(),
            id,
            row,
            col,
        )?;
        applied.push(format!("moved to {}{}", col_letter(col), row + 1));
    }

    let _ = handle.emit("pivots:refresh", ());
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
        handle.state::<AppState>(),
        handle.state::<crate::pivot::PivotState>(),
        id,
    )?;

    let _ = handle.emit("pivots:refresh", ());
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
            "- index={} name=\"{}\" visibility={}{}{}\n",
            s.index,
            s.name,
            s.visibility,
            if s.index == result.active_index { " (active)" } else { "" },
            if s.tab_color.is_empty() {
                String::new()
            } else {
                format!(" tabColor={}", s.tab_color)
            },
        ));
    }
    out
}

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
pub fn add_sheet(handle: &AppHandle, name: Option<&str>) -> Result<String, String> {
    require_tier(handle, "add_sheet")?;
    let result = crate::sheets::add_sheet(handle.state::<AppState>(), name.map(|s| s.to_string()))?;
    let added = result
        .sheets
        .last()
        .map(|s| (s.index, s.name.clone()))
        .unwrap_or((0, name.unwrap_or("Sheet").to_string()));

    let _ = handle.emit("sheets:refresh", ());
    mark_dirty(handle);
    audit(
        handle,
        "add_sheet",
        &format!("An AI tool added sheet \"{}\" at index {}", added.1, added.0),
        vec![
            ("name", serde_json::json!(added.1)),
            ("index", serde_json::json!(added.0)),
        ],
    );
    Ok(format!(
        "Added sheet \"{}\" at index {} ({} sheet(s) now). Sheet structure changes are NOT undoable.",
        added.1,
        added.0,
        result.sheets.len()
    ))
}

/// Rename a sheet by 0-based index. Cross-sheet formula references are repaired
/// by the underlying command.
pub fn rename_sheet(handle: &AppHandle, index: usize, new_name: &str) -> Result<String, String> {
    require_tier(handle, "rename_sheet")?;
    let old_name = {
        let state = handle.state::<AppState>();
        let names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        names
            .get(index)
            .cloned()
            .ok_or_else(|| format!("Sheet index {} out of range. Use list_sheets.", index))?
    };
    crate::sheets::rename_sheet(handle.state::<AppState>(), index, new_name.to_string())?;

    let _ = handle.emit("sheets:refresh", ());
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

/// Delete a sheet by 0-based index.
pub fn delete_sheet(handle: &AppHandle, index: usize) -> Result<String, String> {
    require_tier(handle, "delete_sheet")?;
    let name = {
        let state = handle.state::<AppState>();
        let names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        names
            .get(index)
            .cloned()
            .ok_or_else(|| format!("Sheet index {} out of range. Use list_sheets.", index))?
    };
    let result = crate::sheets::delete_sheet(
        handle.state::<AppState>(),
        handle.state::<crate::pivot::PivotState>(),
        index,
    )?;

    let _ = handle.emit("sheets:refresh", ());
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
        let names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        names
            .get(from_index)
            .cloned()
            .ok_or_else(|| format!("Sheet index {} out of range. Use list_sheets.", from_index))?
    };
    crate::sheets::move_sheet(handle.state::<AppState>(), from_index, to_index)?;

    let _ = handle.emit("sheets:refresh", ());
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
    ];

    const READ_TOOLS: &[&str] = &["list_sheets", "list_script_drafts", "get_script_draft"];

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
        let entry = chart_entry("Old", 0);
        let id = entry.id.to_string();
        state.charts.lock().unwrap().push(entry);
        assert!(!state.undo_stack.lock().unwrap().can_undo());

        let summary = update_chart_core(
            &state,
            &id,
            Some(&valid_spec()),
            Some("Revenue by Region"),
            None,
            &ChartPlacement { width: Some(640.0), ..Default::default() },
        )
        .expect("update should succeed");
        assert!(summary.contains("Updated chart"));

        let charts = state.charts.lock().unwrap();
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
        let entry = chart_entry("Only", 0);
        let id = entry.id.to_string();
        state.charts.lock().unwrap().push(entry);

        // Unknown id.
        let missing = identity::EntityId::from_bytes([9u8; 16]).to_string();
        assert!(update_chart_core(&state, &missing, None, Some("x"), None, &ChartPlacement::default()).is_err());
        // Not an EntityId at all.
        assert!(update_chart_core(&state, "not-a-uuid", None, Some("x"), None, &ChartPlacement::default()).is_err());
        // A spec that fails the structural backstop.
        assert!(update_chart_core(&state, &id, Some(&json!({ "mark": "bar" })), None, None, &ChartPlacement::default()).is_err());
        // Nothing to change.
        assert!(update_chart_core(&state, &id, None, None, None, &ChartPlacement::default()).is_err());
        // None of the failures recorded an undo entry or touched the chart.
        assert!(!state.undo_stack.lock().unwrap().can_undo());
        let charts = state.charts.lock().unwrap();
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
            let mut charts = state.charts.lock().unwrap();
            charts.push(keep);
            charts.push(drop_me);
        }

        let sheet = delete_chart_core(&state, &drop_id).expect("delete should succeed");
        assert_eq!(sheet, 1);

        let charts = state.charts.lock().unwrap();
        assert_eq!(charts.len(), 1);
        assert_eq!(charts[0].id, keep_id);
        drop(charts);

        let undo = state.undo_stack.lock().unwrap();
        assert!(undo.can_undo());
        assert_eq!(undo.undo_description(), Some("Delete chart (AI)"));

        // Deleting it twice is an error, not a silent success.
        drop(undo);
        assert!(delete_chart_core(&state, &drop_id).is_err());
    }

    #[test]
    fn chart_edits_respect_sheet_protection() {
        let state = crate::create_app_state();
        let entry = chart_entry("Protected", 0);
        let id = entry.id.to_string();
        state.charts.lock().unwrap().push(entry);
        {
            let mut protection = state.sheet_protection.lock().unwrap();
            let mut p = crate::protection::SheetProtection::default();
            p.protected = true;
            p.options.allow_edit_objects = false;
            protection.insert(0, p);
        }

        assert!(update_chart_core(&state, &id, None, Some("nope"), None, &ChartPlacement::default()).is_err());
        assert!(delete_chart_core(&state, &id).is_err());
        // Nothing changed, nothing recorded.
        assert_eq!(state.charts.lock().unwrap().len(), 1);
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

    #[test]
    fn renaming_a_name_carries_its_object_scripts_over_instead_of_pruning_them() {
        let state = crate::create_app_state();
        {
            let mut scripts = state.object_scripts.lock().unwrap();
            scripts.push(named_range_script("s-tax", "TaxRate"));
            // A script on an unrelated name must not be touched.
            scripts.push(named_range_script("s-other", "OtherName"));
            // Nor one of a different object type that happens to share the id.
            let mut chart_script = named_range_script("s-chart", "TaxRate");
            chart_script.object_type = persistence::ScriptableObjectType::Chart;
            scripts.push(chart_script);
        }

        // Case-insensitive match, exactly like the prune this repairs.
        let taken = take_named_range_scripts(&state, "taxrate");
        assert_eq!(taken.len(), 1, "only the NamedRange script for TaxRate");
        assert_eq!(taken[0].id, "s-tax");

        // Simulate what delete_named_range does to them.
        {
            let mut scripts = state.object_scripts.lock().unwrap();
            scripts.retain(|s| {
                !(s.object_type == persistence::ScriptableObjectType::NamedRange
                    && s.instance_id.as_deref() == Some("TaxRate"))
            });
            assert_eq!(scripts.len(), 2);
        }

        restore_named_range_scripts(&state, taken, "VatRate");

        let scripts = state.object_scripts.lock().unwrap();
        assert_eq!(scripts.len(), 3, "nothing was lost and nothing duplicated");
        let carried = scripts.iter().find(|s| s.id == "s-tax").expect("the macro survived");
        assert_eq!(carried.instance_id.as_deref(), Some("VatRate"), "re-pointed at the new name");
        // Everything else about it is carried over untouched.
        assert_eq!(carried.declared_capabilities, vec!["bi.query".to_string()]);
        assert_eq!(carried.provenance, persistence::ScriptProvenance::Local);
        // The unrelated ones kept their bindings.
        assert_eq!(
            scripts.iter().find(|s| s.id == "s-other").unwrap().instance_id.as_deref(),
            Some("OtherName")
        );
        assert_eq!(
            scripts.iter().find(|s| s.id == "s-chart").unwrap().instance_id.as_deref(),
            Some("TaxRate")
        );
    }

    #[test]
    fn restoring_no_scripts_is_a_no_op() {
        let state = crate::create_app_state();
        restore_named_range_scripts(&state, Vec::new(), "Whatever");
        assert!(state.object_scripts.lock().unwrap().is_empty());
        assert!(take_named_range_scripts(&state, "Nothing").is_empty());
    }

    // ---- audit ----

    #[test]
    fn record_mcp_tool_action_writes_an_always_on_entry_with_the_tool_fields() {
        let state = crate::create_app_state();
        // Distribution auditing is OFF by default; script activity is recorded
        // regardless, which is exactly what these tools rely on.
        assert!(!state.audit_log.lock().unwrap().enabled);

        crate::scripting::commands::record_mcp_tool_action(
            &state,
            "delete_chart",
            "An AI tool deleted chart abc on sheet 2",
            vec![("chartId", json!("abc")), ("sheet", json!(1))],
        );

        let log = state.audit_log.lock().unwrap();
        assert_eq!(log.entries.len(), 1);
        let entry = &log.entries[0];
        assert!(entry.description.contains("deleted chart abc"));
        assert_eq!(entry.extra.get("surface"), Some(&json!("mcp")));
        assert_eq!(entry.extra.get("tool"), Some(&json!("delete_chart")));
        assert_eq!(entry.extra.get("chartId"), Some(&json!("abc")));
        assert_eq!(entry.extra.get("sheet"), Some(&json!(1)));
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
                },
                crate::sheets::SheetInfo {
                    index: 1,
                    name: "Report".to_string(),
                    freeze_row: None,
                    freeze_col: None,
                    tab_color: "#ff0000".to_string(),
                    visibility: "hidden".to_string(),
                },
            ],
            active_index: 1,
        };
        let out = format_sheet_inventory(&result);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("index=0"));
        assert!(lines[0].contains("name=\"Data\""));
        assert!(!lines[0].contains("(active)"));
        assert!(lines[1].contains("visibility=hidden"));
        assert!(lines[1].contains("(active)"));
        assert!(lines[1].contains("tabColor=#ff0000"));
    }
}
