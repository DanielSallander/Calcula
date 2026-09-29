//! FILENAME: app/src-tauri/src/pivot/commands.rs
//! PURPOSE: Tauri commands for Pivot Table operations.
//! CONTEXT: Excel-compatible Pivot Table API implementation.

use crate::bi::types::BiState;
use crate::bi::commands::{auto_connect_bi_connection, auto_bind_tables_on_connection, bi_tables_cache_warm};
use crate::pivot::operations::*;
use crate::pivot::totals::{
    measure_value_col_idx, query_bi_total_overrides, BiTotalsPlan, GrainField,
};
use crate::pivot::types::*;
use crate::pivot::utils::*;
use crate::{log_debug, log_info, log_perf, AppState};
use crate::pivot::types::PivotState;
use pivot_engine::{
    drill_down, AggregationType, PivotCache, PivotDefinition, PivotField, PivotId,
    PivotView, ValueField, VALUE_ID_EMPTY,
};
use std::time::Instant;
use tauri::{Emitter, State};

// ============================================================================
// HELPERS
// ============================================================================

/// Refusal-first write access to the pivot store.
///
/// WHY THIS EXISTS. `PivotState::pivot_tables` is `Persisted<T>` (it is written into the
/// .cala by `persistence::collect_pivots_for_save`), so mutating it requires a
/// `DocumentEffect`. `DocumentEffect::mutates` sets the dirty flag EAGERLY -- possession
/// of the token is proof the flag is set -- which means it must not be constructed until
/// the command has actually decided to mutate. Every pivot mutation begins with the same
/// refusal ("does this pivot exist?"), so that check happens here under a READ guard and
/// the token is minted only afterwards. A refused pivot command therefore leaves the
/// document clean, which is the contract `document_effect_pilot_tests` pins.
///
/// Returns the token alongside the guard: the caller keeps it alive for the whole
/// mutation and may pass `&effect` to any other `Persisted<T>` the same command touches.
///
/// THE SECOND REFUSAL, for a command that will REWRITE THE GRID: a pivot whose
/// destination is the wrong KIND for it -- a grid pivot on a canvas, a canvas
/// (framed) pivot on a worksheet -- is refused here too, before the token exists
/// (`ensure_pivot_destination_writable`). Without it the command mutated the
/// definition, dirtied the document and only then learned -- at the write --
/// that the output had nowhere to go. `update_pivot_in_grid` still refuses at the
/// write for a destination that changes after this check.
fn pivot_write<'a>(
    state: &AppState,
    pivot_state: &'a PivotState,
    file_state: &crate::persistence::FileState,
    pivot_id: PivotId,
) -> Result<
    (
        crate::document_effect::DocumentEffect,
        crate::document_effect::WriteGuard<'a, std::collections::HashMap<PivotId, (PivotDefinition, PivotCache)>>,
    ),
    String,
> {
    ensure_pivot_exists(pivot_state, pivot_id)?;
    ensure_pivot_destination_writable(state, pivot_state, pivot_id)?;
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let guard = pivot_state
        .pivot_tables
        .write(&effect)
        .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
    Ok((effect, guard))
}

/// [`pivot_write`] for a command that edits the DEFINITION ONLY and never
/// writes the grid (`update_pivot_properties`), so a pivot stranded on a
/// canvas can still be renamed. The census in `canvas_sheet_tests` pins it to
/// that one caller.
fn pivot_write_definition_only<'a>(
    pivot_state: &'a PivotState,
    file_state: &crate::persistence::FileState,
    pivot_id: PivotId,
) -> Result<
    (
        crate::document_effect::DocumentEffect,
        crate::document_effect::WriteGuard<'a, std::collections::HashMap<PivotId, (PivotDefinition, PivotCache)>>,
    ),
    String,
> {
    ensure_pivot_exists(pivot_state, pivot_id)?;
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let guard = pivot_state
        .pivot_tables
        .write(&effect)
        .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
    Ok((effect, guard))
}

/// The "does this pivot exist?" refusal every pivot mutation starts with, under
/// a READ guard that is released before the caller mints its token.
fn ensure_pivot_exists(pivot_state: &PivotState, pivot_id: PivotId) -> Result<(), String> {
    let tables = pivot_state
        .pivot_tables
        .read()
        .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
    if tables.contains_key(&pivot_id) {
        Ok(())
    } else {
        Err(format!("Pivot table {} not found", pivot_id))
    }
}

/// Refusal-first mutation token for a pivot command that takes the store guard SEVERAL
/// times, or takes it inside nested scopes.
///
/// [`pivot_write`] hands back a live guard, which is wrong when the command needs the
/// guard more than once (the token would be scoped to the first block). This runs the
/// same "does this pivot exist?" refusal under a READ guard, releases it, and returns
/// only the token -- which then authorises every later `.write(&effect)` in the command.
///
/// Refuses a destination of the wrong kind before the token exists, like
/// [`pivot_write`]: every caller rewrites the grid. `delete_pivot_table` -- which
/// must be able to remove a pivot stranded on a canvas -- uses
/// [`pivot_exists_token`] instead.
fn pivot_mutation_token(
    state: &AppState,
    pivot_state: &PivotState,
    file_state: &crate::persistence::FileState,
    pivot_id: PivotId,
) -> Result<crate::document_effect::DocumentEffect, String> {
    ensure_pivot_exists(pivot_state, pivot_id)?;
    ensure_pivot_destination_writable(state, pivot_state, pivot_id)?;
    Ok(crate::document_effect::DocumentEffect::mutates(file_state))
}

/// [`pivot_mutation_token`] without the canvas refusal, for DELETING a pivot:
/// removing one whose destination is a canvas is exactly how the user gets rid
/// of it. Pinned to `delete_pivot_table` by the census in `canvas_sheet_tests`.
fn pivot_exists_token(
    pivot_state: &PivotState,
    file_state: &crate::persistence::FileState,
    pivot_id: PivotId,
) -> Result<crate::document_effect::DocumentEffect, String> {
    ensure_pivot_exists(pivot_state, pivot_id)?;
    Ok(crate::document_effect::DocumentEffect::mutates(file_state))
}

/// The protection gate of a pivot DELETE, before anything is written: a
/// worksheet pivot on a sheet protected against PivotTable changes
/// (`pivotTables`, the gate `create_pivot_table` passes) is refused, and a
/// pivot BOX on a canvas -- an object there -- on a canvas protected against
/// object edits (`editObjects`, the gate a chart's delete passes). A canvas-wide
/// Delete of a mixed selection relies on each family refusing what the sheet
/// forbids; the pivot's delete did not (the review of A4). An unknown pivot
/// passes: the existence check that follows refuses it.
///
/// LOCKS: the pivot's destination is read under the `pivot_tables` read guard
/// alone and resolved after it is released (`sheet_names` is taken before
/// `pivot_tables` elsewhere); the gate takes the protection lock alone.
pub(crate) fn refuse_a_protected_pivot_delete(
    state: &AppState,
    pivot_state: &PivotState,
    pivot_id: PivotId,
) -> Result<(), String> {
    let dest = {
        let pivot_tables = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
        pivot_tables.get(&pivot_id).map(|(definition, _)| PivotDestSheet::of(definition))
    };
    let Some(dest) = dest else { return Ok(()) };
    let sheet = dest.resolve(state);
    let on_canvas = crate::sheets::is_canvas_sheet(&state.sheet_kinds.read().map_err(|e| e.to_string())?, sheet);
    if on_canvas {
        crate::protection::check_sheet_action(state, sheet, "editObjects", "delete a PivotTable box")
    } else {
        crate::protection::check_sheet_action(state, sheet, "pivotTables", "delete a PivotTable")
    }
}

/// Rendering a pivot needs `&mut PivotCache` -- the cache memoises interned values as it
/// lays the view out -- but rendering is NOT a document edit. Merely LOOKING at a pivot
/// must never make the workbook prompt to save, or the prompt stops meaning anything.
/// These read paths therefore declare `DerivedCache`: the cache is rebuilt from the
/// definition, which is itself persisted and owns the flag.
fn pivot_render_effect() -> crate::document_effect::DocumentEffect {
    crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::DerivedCache,
    )
}

/// Store a computed PivotView for later windowed cell fetching.
fn store_view(pivot_state: &PivotState, pivot_id: PivotId, view: &PivotView) {
    pivot_state.views.lock().unwrap().insert(pivot_id, view.clone());
}

/// Record a pivot definition undo snapshot.
/// `saved_cells` are cells that were overwritten by the pivot expansion
/// (so that `undo_pivot_overwrite` can restore them when the user cancels).
///
/// `prev_col_widths` are the widths a pivot auto-fit overwrote on this pivot's
/// destination sheet (empty when auto-fit is off). They ride in the SAME
/// transaction as the definition, because Excel undoes a pivot change and the
/// column resize it caused as one step — and because recording them separately
/// would make every field change cost the user two Ctrl+Z presses. Until this
/// existed, `auto_fit_pivot_columns` recorded nothing at all and the widths
/// simply never came back (BUG-0014).
/// `cache` is the records the restored definition must be rendered against, and
/// it is `None` for every command that leaves the cache alone (a field change, a
/// collapse). Pass `Some` only when the command REPLACES the cache — a new
/// source range, or a fresh BI query — because restoring an old definition
/// against new records renders a view that was never on screen (BUG-0021 /
/// BUG-0022). The payload itself is built by `undo_commands`, which owns the
/// shape and is the only thing that reads it back.
///
/// Returns the step's OVERWRITE TOKEN when it carries overwritten cells (and
/// `None` when it carries none): the caller puts it in its response
/// (`PivotViewResponse::overwrite_token`), because it is the only thing a
/// declined "overwrite existing data?" may hand back to
/// `undo_pivot_overwrite` -- the backend takes back the step that carries it
/// and nothing else.
pub(crate) fn record_pivot_definition_undo(
    state: &AppState,
    pivot_id: PivotId,
    definition: PivotDefinition,
    overwritten_cells: Vec<crate::pivot::operations::SavedCell>,
    dest_sheet_idx: usize,
    prev_col_widths: Vec<(u32, Option<f64>)>,
    cache: Option<pivot_engine::PivotCache>,
    description: &str,
) -> Option<u64> {
    let token = (!overwritten_cells.is_empty()).then(crate::undo_commands::mint_pivot_overwrite_token);
    let data = crate::undo_commands::encode_pivot_definition_snapshot_with_token(
        pivot_id,
        definition,
        overwritten_cells,
        dest_sheet_idx,
        cache,
        token,
    );
    // ONE critical section for the whole step. The width record is serialized
    // here rather than through `record_pivot_col_widths_undo` so the stack lock
    // is taken exactly once: releasing it between the two records would let a
    // concurrent command open its own transaction in the gap and split what the
    // user sees as one action.
    //
    // And a MEMBER of an open transaction: the guarded join records into the
    // caller's transaction when one is open instead of an unconditional
    // `begin`/`commit` pair, whose `commit` closed the caller's OUTER
    // transaction early -- a canvas arrange that moved a pivot box mid-way
    // became two Ctrl+Z steps.
    let widths_data =
        crate::undo_commands::encode_pivot_col_widths_snapshot(dest_sheet_idx, prev_col_widths);
    let mut restores = vec![(crate::undo_commands::PIVOT_DEFINITION_RESTORE_KIND, data)];
    if let Some(widths) = widths_data {
        restores.push((crate::undo_commands::PIVOT_COL_WIDTHS_RESTORE_KIND, widths));
    }
    crate::undo_commands::record_restores_joining_open_transaction(state, description, restores);
    token
}

/// The undo step a BI field change WOULD record -- the arguments of one
/// [`record_pivot_definition_undo`] call -- handed back to the caller instead
/// of recorded, so a caller that owns the gesture can decide what the step
/// restores.
///
/// `update_bi_pivot_fields_core` records it as is (when the context records
/// at all: `delete_slicer_core` runs its clears quietly and records ONE step
/// at the end, so no undo transaction is held open across the BI re-query).
/// A FILTER edit that re-queries (a pin added, replaced or dropped; a
/// calculation group's item state) records it with the definition and cache
/// from BEFORE its own in-place edit instead: the re-query's snapshot is taken
/// after that edit, so recording it as is made the undo restore the NEW pin
/// against the OLD records.
pub(crate) struct BiFieldChangeUndo {
    pub pivot_id: PivotId,
    pub definition: PivotDefinition,
    pub overwritten_cells: Vec<crate::pivot::operations::SavedCell>,
    pub dest_sheet_idx: usize,
    pub prev_col_widths: Vec<(u32, Option<f64>)>,
    pub cache: Option<pivot_engine::PivotCache>,
}

impl BiFieldChangeUndo {
    /// Record it (joining an open transaction), as the step `description`.
    /// Returns its overwrite token (see [`record_pivot_definition_undo`]).
    pub(crate) fn record(self, state: &AppState, description: &str) -> Option<u64> {
        record_pivot_definition_undo(
            state,
            self.pivot_id,
            self.definition,
            self.overwritten_cells,
            self.dest_sheet_idx,
            self.prev_col_widths,
            self.cache,
            description,
        )
    }
}

/// The model columns an EXTERNAL filter currently holds on BI pivot
/// `pivot_id`: a PIVOT slicer connected to it with a selection, or an active
/// ribbon filter whose targets include it (manual list, its sheet in bySheet
/// mode, or the whole workbook -- on the pivot's own connection). Model
/// slicers are not listed: the page fold re-applies them on every rebuild.
///
/// Read with no pivot lock held (the slicer and filter stores alone).
fn external_filter_columns(
    ctx: &PivotCmdCtx<'_>,
    pivot_id: PivotId,
    meta: &BiPivotMetadata,
    dest_sheet: usize,
) -> Result<std::collections::HashSet<(String, String)>, String> {
    let column_of = |field_name: &str| -> Option<(String, String)> {
        if let Ok(tc) = split_model_column_key(field_name, meta) {
            return Some(tc);
        }
        resolve_bi_cache_name(field_name, meta)
    };
    let mut out = std::collections::HashSet::new();
    {
        let slicers = ctx.slicer_state.slicers.read().map_err(|e| e.to_string())?;
        for s in slicers.values() {
            let connected = s.source_type == crate::slicer::SlicerSourceType::Pivot
                && (s.cache_source_id == pivot_id
                    || s.connected_sources.iter().any(|c| {
                        c.source_type == crate::slicer::SlicerSourceType::Pivot && c.source_id == pivot_id
                    }));
            if connected && s.selected_items.is_some() {
                if let Some(tc) = column_of(&s.field_name) {
                    out.insert(tc);
                }
            }
        }
    }
    {
        use crate::ribbon_filter::ConnectionMode;
        let filters = ctx.ribbon_filter_state.filters.read().map_err(|e| e.to_string())?;
        for f in filters.values() {
            if f.selected_items.is_none() {
                continue;
            }
            // The pivot's connection, by live id or by the stable package id
            // (the rule `bi_pivots_for_connection` resolves targets with).
            let same_connection = f.connection_id == meta.connection_id
                || meta.data_source_id.as_deref() == Some(f.connection_id.to_string().as_str());
            let targets_pivot = match f.connection_mode {
                ConnectionMode::Manual => f.connected_pivots.contains(&pivot_id),
                ConnectionMode::Workbook => same_connection,
                ConnectionMode::BySheet => same_connection && f.connected_sheets.contains(&dest_sheet),
            };
            if targets_pivot {
                if let Some(tc) = column_of(&f.field_name) {
                    out.insert(tc);
                }
            }
        }
    }
    Ok(out)
}

/// Populate children_indices from parent_index on a PivotView.
/// The engine sets parent_index but leaves children_indices empty.
/// This is needed for toggle_collapse to find child rows.
fn ensure_children_indices(view: &mut PivotView) {
    // Clear existing children
    for row in &mut view.rows {
        row.children_indices.clear();
    }
    // Build from parent_index
    let parents: Vec<Option<usize>> = view.rows.iter().map(|r| r.parent_index).collect();
    for (idx, parent) in parents.iter().enumerate() {
        if let Some(p) = parent {
            if *p < view.rows.len() {
                view.rows[*p].children_indices.push(idx);
            }
        }
    }
}

/// Find the row index in a PivotView that matches a ToggleGroupRequest.
/// Scans expandable cells for matching group_path or value.
fn find_toggle_row(view: &PivotView, request: &ToggleGroupRequest) -> Option<usize> {
    // Build the target path key the same way the definition stores it
    if let Some(ref group_path) = request.group_path {
        let target_path: Vec<(usize, u32)> = group_path.clone();
        // Find row with an expandable cell whose group_path matches
        for (row_idx, row_cells) in view.cells.iter().enumerate() {
            for cell in row_cells {
                if cell.is_expandable && cell.group_path == target_path {
                    return Some(row_idx);
                }
            }
        }
    } else if let Some(ref item_name) = request.value {
        // Match by formatted value on expandable cells at the correct field level
        for (row_idx, row_cells) in view.cells.iter().enumerate() {
            for cell in row_cells {
                if cell.is_expandable && cell.formatted_value == *item_name {
                    return Some(row_idx);
                }
            }
        }
    } else {
        // Toggle all items in the field — not a single-row toggle.
        // Fall back to slow path (full recalculation needed).
        return None;
    }
    None
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Resolve pivot field NAMES to their 0-based source-column indices against the
/// available column names. Errors (listing the available names) if any name is
/// not found. Pure — unit-tested.
pub(crate) fn resolve_field_indices(
    names: &[String],
    available: &[String],
) -> Result<Vec<usize>, String> {
    names
        .iter()
        .map(|name| {
            available
                .iter()
                .position(|n| n == name)
                .ok_or_else(|| {
                    format!(
                        "Pivot field '{}' not found. Available columns: [{}]",
                        name,
                        available.join(", ")
                    )
                })
        })
        .collect()
}

/// Human label for an aggregation, used to build a value-field display name
/// like "Sum of Revenue".
fn agg_label(agg: AggregationType) -> &'static str {
    match agg {
        AggregationType::Sum => "Sum",
        AggregationType::Count => "Count",
        AggregationType::Average => "Average",
        AggregationType::Min => "Min",
        AggregationType::Max => "Max",
        AggregationType::CountNumbers => "CountNumbers",
        AggregationType::StdDev => "StdDev",
        AggregationType::StdDevP => "StdDevP",
        AggregationType::Var => "Var",
        AggregationType::VarP => "VarP",
        AggregationType::Product => "Product",
    }
}

// ============================================================================
// D3 — PIVOT WRITES SEED THE ONE SHARED CASCADE
// ============================================================================

/// Every cell of a pivot output block, as cascade seeds.
///
/// A pivot writes a RECTANGLE, exactly as `bi_insert_result` writes a query
/// result block — and the census already requires that shape of command to
/// recalculate on both the on-sheet and the off-sheet branch. The seeds are the
/// whole rectangle rather than only the cells that ended up non-empty, because
/// a pivot that SHRANK leaves emptied cells behind and a formula reading one of
/// those is precisely the reader that has to drop to 0.
pub(crate) fn pivot_block_seeds(
    destination: (u32, u32),
    row_count: usize,
    col_count: usize,
) -> Vec<(u32, u32)> {
    let (start_row, start_col) = destination;
    let mut seeds = Vec::with_capacity(row_count.saturating_mul(col_count));
    for r in 0..row_count as u32 {
        for c in 0..col_count as u32 {
            seeds.push((start_row + r, start_col + c));
        }
    }
    seeds
}

/// Creates a new pivot table from the specified source range (UI path: starts
/// EMPTY, fields are configured later via update_pivot_fields).
#[tauri::command]
pub fn create_pivot_table(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: CreatePivotRequest,
) -> Result<PivotViewResponse, String> {
    create_pivot_inner(
        state,
        file_state,
        pivot_state,
        user_files_state,
        pane_control_state,
        ribbon_filter_state,
        request,
        Vec::new(),
        Vec::new(),
    )
}

/// [`create_pivot_core`] reached through `State` handles: the body of the
/// `create_pivot_table` command and of the MCP `create_pivot` tool.
#[allow(clippy::too_many_arguments)]
pub fn create_pivot_inner(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: CreatePivotRequest,
    row_field_names: Vec<String>,
    value_specs: Vec<(String, AggregationType)>,
) -> Result<PivotViewResponse, String> {
    create_pivot_core(
        &state,
        &file_state,
        &pivot_state,
        PivotRecalcStates {
            pane: &pane_control_state,
            ribbon: &ribbon_filter_state,
            user_files: &user_files_state,
        },
        request,
        row_field_names,
        value_specs,
    )
}

/// The canvas half of both create doors: a pivot aimed at a canvas must carry
/// a frame, and the frame must be valid. `Err` names the canvas and says what
/// is missing.
fn canvas_create_frame(
    frame: Option<CanvasFrameConfig>,
    dest_sheet_idx: usize,
) -> Result<pivot_engine::CanvasFrame, String> {
    let Some(config) = frame else {
        return Err(format!(
            "Cannot create a pivot table on sheet {}: it is a canvas sheet, and a pivot on a \
             canvas needs a frame (the box it is shown in). Insert it from the canvas, or choose \
             a worksheet destination.",
            dest_sheet_idx
        ));
    };
    let frame: pivot_engine::CanvasFrame = config.into();
    frame.validate()?;
    Ok(frame)
}

/// The worksheet half of both create doors: a frame on a worksheet destination
/// is refused, never silently dropped -- the caller asked for a canvas pivot.
fn frame_on_worksheet_refusal(dest_sheet_idx: usize) -> String {
    format!(
        "Cannot create a pivot table with a canvas frame on sheet {}: it is a worksheet, and a \
         frame is only for a pivot on a canvas sheet.",
        dest_sheet_idx
    )
}

/// Core pivot creation over plain references (so the unit tier can drive the
/// real door -- `State<T>` cannot be built in a test; same split as
/// `add_sheet_inner`), optionally with row/value fields configured UP FRONT so
/// the whole creation is a SINGLE undoable step (used by the MCP create_pivot
/// tool; create_pivot_table passes empty field lists). Field NAMES are resolved
/// to source-column indices against the freshly built cache.
///
/// EVERY REFUSAL COMES BEFORE THE EFFECT. The destination (resolved ONCE), its
/// kind, the frame, the protection option, the ranges, the overlap, the source
/// sheet, the self-overlap, the field names and a canvas pivot's width are all
/// decided before `DocumentEffect::mutates`, so a refused create leaves the
/// document clean. (The overlap and protection checks used to run after it.)
///
/// CANVAS DESTINATION (M6). The request must carry `canvas_frame`, the anchor is
/// allocated by `allocate_canvas_pivot_anchor` (`destination_cell` is ignored),
/// and `source_sheet` must name a NON-canvas sheet explicitly: the default --
/// the active sheet -- is the canvas itself when the user inserts from the
/// Canvas tab, and a pivot over an empty canvas is never what was meant.
///
/// DEPENDENTS RECALCULATE (D3). Creating a pivot writes a block over cells that
/// may already have held data, and it recalculated nothing: `=B12*2` beside the
/// destination kept the value of whatever the pivot had just overwritten. Every
/// other pivot mutation reaches a recalculation through `finalize_pivot_update`;
/// creation, deletion and the overwrite-undo were the three that did not.
pub(crate) fn create_pivot_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    pivot_state: &PivotState,
    recalc: PivotRecalcStates<'_>,
    request: CreatePivotRequest,
    row_field_names: Vec<String>,
    value_specs: Vec<(String, AggregationType)>,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "create_pivot_table source={} dest={} dest_sheet={:?} framed={}",
        request.source_range,
        request.destination_cell,
        request.destination_sheet,
        request.canvas_frame.is_some()
    );

    // The destination -- ONCE. This index is what the kind gate checks, what
    // `destination_sheet` names, where the region is registered and where the
    // cells are written. The active sheet is copied out first, so no
    // `active_sheet` guard is alive while the kind is read.
    let active_sheet_now = *state.active_sheet.read().unwrap();
    let dest_sheet_idx = request.destination_sheet.unwrap_or(active_sheet_now);
    let sheet_count = state.sheet_names.read().unwrap().len();
    if dest_sheet_idx >= sheet_count {
        return Err(format!(
            "Destination sheet index {} does not exist (only {} sheets available)",
            dest_sheet_idx, sheet_count
        ));
    }
    let dest_is_canvas = {
        let kinds = state.sheet_kinds.read().unwrap();
        crate::sheets::is_canvas_sheet(&kinds, dest_sheet_idx)
    };

    let (destination, source_sheet_idx, canvas_frame) = if dest_is_canvas {
        let frame = canvas_create_frame(request.canvas_frame, dest_sheet_idx)?;
        let Some(source_sheet_idx) = request.source_sheet else {
            return Err(format!(
                "Cannot create a pivot table on canvas sheet {} without an explicit source sheet: \
                 the default source is the active sheet, which is the canvas itself. Name the \
                 worksheet that holds the data.",
                dest_sheet_idx
            ));
        };
        let source_is_canvas = {
            let kinds = state.sheet_kinds.read().unwrap();
            crate::sheets::is_canvas_sheet(&kinds, source_sheet_idx)
        };
        if source_is_canvas {
            return Err(format!(
                "Cannot create a pivot table from sheet {}: it is a canvas sheet, which holds no \
                 data. Choose the worksheet that holds the data as the source.",
                source_sheet_idx
            ));
        }
        let anchor = allocate_canvas_pivot_anchor(state, dest_sheet_idx)?;
        (anchor, source_sheet_idx, Some(frame))
    } else {
        // A GRID pivot writes its output as visible cells; on a canvas sheet
        // those cells would be invisible (the framed canvas pivot above is the
        // one path onto a canvas). Kept as the literal gate the census pins.
        crate::sheets::ensure_not_canvas_in_state(state, dest_sheet_idx, "create a grid pivot table")?;
        if request.canvas_frame.is_some() {
            return Err(frame_on_worksheet_refusal(dest_sheet_idx));
        }
        let destination = parse_cell_ref(&request.destination_cell)?;
        (destination, request.source_sheet.unwrap_or(active_sheet_now), None)
    };

    log_info!(
        "PIVOT",
        "source_sheet_idx={} dest_sheet_idx={} destination=({},{})",
        source_sheet_idx,
        dest_sheet_idx,
        destination.0,
        destination.1
    );

    // allowPivotTables option gate, on the ACTIVE sheet (the pivot is created
    // from the current selection context; the destination sheet is resolved
    // above and is gated by the per-cell write gates that follow).
    crate::protection::check_sheet_action(
        state, active_sheet_now, "pivotTables", "create or change pivot tables",
    )?;

    // Parse the source range
    let (source_start, mut source_end) = parse_range(&request.source_range)?;

    // Check that destination doesn't overlap an existing pivot table. For a
    // canvas this is a backstop: the allocator already skipped taken blocks.
    check_pivot_overlap(state, dest_sheet_idx, destination)?;

    let has_headers = request.has_headers.unwrap_or(true);

    // Build the cache from the source grid, then release it.
    let cache = {
        let grids = state.grids.read().unwrap();
        let grid = grids
            .get(source_sheet_idx)
            .ok_or_else(|| format!("Sheet index {} not found", source_sheet_idx))?;

        // Clamp source_end row to the grid's actual data extent.
        // This handles full-column selections (e.g. A:D -> A1:D1048576) by
        // trimming to only the populated rows, matching Excel's behaviour.
        if source_end.0 > grid.max_row {
            log_info!(
                "PIVOT",
                "clamping source end_row from {} to {} (grid.max_row)",
                source_end.0,
                grid.max_row
            );
            source_end.0 = grid.max_row;
        }

        // Reject a pivot that would overwrite its own source. Checked AFTER the
        // clamp above: an unclamped full-column selection (A:D -> A1:D1048576)
        // would otherwise swallow every destination in those columns.
        check_pivot_source_destination_overlap(
            source_sheet_idx,
            source_start,
            source_end,
            dest_sheet_idx,
            destination,
        )?;

        let (cache, _headers) = build_cache_from_grid(grid, source_start, source_end, has_headers)?;
        cache
    };

    // Generate new pivot ID
    let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    // Create definition - START EMPTY (no auto-population)
    let mut definition = PivotDefinition::new(pivot_id, source_start, source_end);
    definition.source_has_headers = has_headers;
    definition.destination = destination;
    definition.canvas_frame = canvas_frame;
    definition.name = request.name.or_else(|| Some(format!("PivotTable{}", pivot_id)));
    // If linked to a table, display the table name; otherwise use the raw range
    definition.source_range_display = Some(
        request.source_table_name.clone().unwrap_or_else(|| request.source_range.clone())
    );
    definition.source_table_name = request.source_table_name.clone();

    // Store source + destination sheet in definition. Recording the SOURCE
    // sheet is what lets refresh and drill-through read the right sheet
    // instead of assuming sheet 0.
    {
        let sheet_names = state.sheet_names.read().unwrap();
        if dest_sheet_idx < sheet_names.len() {
            definition.destination_sheet = Some(sheet_names[dest_sheet_idx].clone());
        }
        if source_sheet_idx < sheet_names.len() {
            definition.source_sheet = Some(sheet_names[source_sheet_idx].clone());
        }
    }

    // C1: resolve requested field NAMES -> source indices and configure the
    // definition BEFORE the first calc, so an MCP-created pivot is a SINGLE
    // undoable step (no empty-then-update). Empty for the UI create path.
    if !row_field_names.is_empty() || !value_specs.is_empty() {
        let available: Vec<String> = (0..cache.field_count())
            .filter_map(|i| cache.field_name(i))
            .collect();
        let row_idx = resolve_field_indices(&row_field_names, &available)?;
        for (name, idx) in row_field_names.iter().zip(row_idx) {
            definition.row_fields.push(PivotField::new(idx, name.clone()));
        }
        for (field, agg) in &value_specs {
            let idx = resolve_field_indices(std::slice::from_ref(field), &available)?[0];
            definition.value_fields.push(ValueField::new(
                idx,
                format!("{} of {}", agg_label(*agg), field),
                *agg,
            ));
        }
    }

    // The undo snapshot stores the CLEAN (pre-calc) cache: a CONFIGURED pivot's
    // post-calc cache contains computed maps serde_json cannot serialize
    // (non-string keys), which would make the undo snapshot empty and break
    // delete-on-undo. The clean source cache serializes, and redo recomputes the
    // view from it (apply_pivot_delete_restore re-runs safe_calculate_pivot).
    let undo_cache = cache.clone();

    // Calculate initial view (empty only if no fields were configured)
    let mut cache_mut = cache;
    let view = safe_calculate_pivot(&definition, &mut cache_mut);

    // A canvas pivot must fit its block -- refused LOUDLY here, before
    // anything is written, rather than clipped or spilled into the next block.
    if definition.canvas_frame.is_some() {
        ensure_canvas_pivot_fits_block(pivot_id, destination, &view)?;
    }

    // The WHOLE block the pivot is about to take -- its first view, or an empty
    // pivot's placeholder -- may not cover its own source (BUG-0226). The anchor
    // gate above passes a source a few rows below the destination, which a
    // configured create then wrote over and an empty create's placeholder
    // claimed as a protected region.
    check_pivot_extent_excludes_source(
        source_sheet_idx,
        source_start,
        source_end,
        dest_sheet_idx,
        destination,
        pivot_extent(&view),
        PivotExtentDoor::Create,
    )?;

    // Creating a pivot: every refusal is behind us -- destination kind, frame,
    // protection, ranges, overlap, source, field names and width -- so the
    // command commits here.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);

    store_view(pivot_state, pivot_id, &view);
    let mut response = view_to_response(&view, &definition, &mut cache_mut);

    // The user's cells a CONFIGURED create writes over (an empty create writes
    // nothing), saved BEFORE the region exists so none is skipped as the
    // pivot's own. They ride in the create's undo step: undo puts them back.
    // Nothing counted or saved them, so undoing a create cleared its region and
    // lost them for good.
    let overwritten_cells = save_overwritten_cells(state, pivot_id, dest_sheet_idx, destination, &view);
    response.overwritten_cell_count = overwritten_cells.len() as u32;

    // Update pivot region tracking (tracks even empty pivots with reserved space)
    update_pivot_region(state, pivot_id, dest_sheet_idx, destination, &view);

    // Write pivot output to destination grid (empty for now, but reserves the space)
    {
        // CANONICAL LOCK ORDER: `grid`, then `grids`, then everything else
        // (the style registry included). The recalculation pass holds both grid
        // locks and then takes `style_registry` on a background thread.
        let mut grid = state.grid.write(&effect).unwrap();
        let mut grids = state.grids.write(&effect).unwrap();
        let mut styles = state.style_registry.write(&effect).unwrap();

        // Verify destination sheet exists (a backstop: checked before the effect)
        if dest_sheet_idx >= grids.len() {
            return Err(format!(
                "Destination sheet index {} does not exist (only {} sheets available)",
                dest_sheet_idx,
                grids.len()
            ));
        }

        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            let pivot_merges = write_pivot_to_grid(dest_grid, None, &view, destination, &mut styles);
            log_info!(
                "PIVOT",
                "wrote pivot output to grids[{}] at ({},{}) size {}x{}",
                dest_sheet_idx,
                destination.0,
                destination.1,
                view.row_count,
                view.col_count
            );

            // Insert pivot merge regions into the DESTINATION sheet's set --
            // `merged_regions` is the active sheet's mirror, and a pivot created
            // onto another sheet (every canvas pivot inserted while a worksheet
            // is active, any cross-sheet pivot) put its merges there.
            if !pivot_merges.is_empty() {
                crate::report::with_sheet_merges_mut(state, &effect, dest_sheet_idx, |merged| {
                    for mr in pivot_merges {
                        merged.insert(mr);
                    }
                });
            }

            // IMPORTANT: If dest_sheet is the currently active sheet, sync state.grid
            let active_sheet = *state.active_sheet.read().unwrap();
            if dest_sheet_idx == active_sheet {
                // Copy the cells we just wrote to state.grid as well
                for ((r, c), cell) in dest_grid.cells.iter() {
                    grid.set_cell(*r, *c, cell.clone());
                }
                grid.recalculate_bounds();
                log_info!("PIVOT", "synced pivot cells to state.grid (active sheet)");
            }
        } else {
            log_info!("PIVOT", "WARNING: destination sheet {} not found", dest_sheet_idx);
        }
    }

    // Store pivot table
    let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
    pivot_tables.insert(pivot_id, (definition, cache_mut));

    // Set as active pivot
    let mut active = pivot_state.active_pivot_id.lock().unwrap();
    *active = Some(pivot_id);

    // Record undo snapshot for pivot creation (undo = delete the pivot), built
    // through the ONE payload the restore arm reads (BUG-0054), with the cells
    // the create wrote over.
    {
        let (def, _post_calc_cache) = pivot_tables.get(&pivot_id).unwrap();
        // The clean pre-calc cache (serializable; redo recomputes).
        let data = crate::undo_commands::pivot_create_snapshot_bytes(pivot_id, def, &undo_cache, overwritten_cells);
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let owned_txn = undo_stack.begin_owned_transaction("Create pivot table");
        undo_stack.record_custom_restore("pivot_create".to_string(), data, "Create pivot table");
        undo_stack.commit_owned(owned_txn);
    }

    log_info!("PIVOT", "created pivot_id={} rows={} (empty - awaiting field configuration)", pivot_id, response.row_count);

    // PHASE B — the block just written seeds the ONE shared cascade, after every
    // guard above is released (std mutexes are not reentrant).
    drop(active);
    drop(pivot_tables);
    let seeds = pivot_block_seeds(destination, view.row_count, view.col_count);
    let active_sheet = *state.active_sheet.read().unwrap();
    if dest_sheet_idx == active_sheet {
        let mut recalculated = Vec::new();
        crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
            state,
            recalc.user_files,
            recalc.pane,
            recalc.ribbon,
            &seeds,
            &mut recalculated,
        );
    } else {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            recalc.user_files,
            pivot_state,
            recalc.pane,
            recalc.ribbon,
            &[dest_sheet_idx],
        );
    }

    Ok(response)
}

/// Helper: emit a pivot progress event (best-effort, ignores errors).
fn emit_pivot_progress(window: &tauri::Window, pivot_id: PivotId, stage: &str, stage_index: u32, total_stages: u32) {
    let _ = window.emit("pivot:progress", PivotProgressEvent {
        pivot_id,
        stage: stage.into(),
        stage_index,
        total_stages,
    });
}

/// Cancels an in-progress pivot operation (if any).
/// The operation will be aborted between pipeline stages and the pivot reverts to its previous state.
#[tauri::command]
pub fn cancel_pivot_operation(
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<(), String> {
    let tokens = pivot_state.cancellation_tokens.lock().unwrap();
    if let Some(token) = tokens.get(&pivot_id) {
        log_info!("PIVOT", "cancel_pivot_operation pivot_id={}", pivot_id);
        token.cancel();
        Ok(())
    } else {
        // No active operation — silently succeed (not an error)
        Ok(())
    }
}

/// Reverts a pivot to its pre-operation state.
/// Called by the frontend when the user cancels AFTER the backend already completed.
/// Restores the previous definition + cache and re-writes the grid.
#[tauri::command]
pub fn revert_pivot_operation(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pivot_id: PivotId,
) -> Result<(), String> {
    // Refusal-first: verify the pivot exists BEFORE minting the eager `mutates`
    // token, so a refused command leaves the document clean.
    let effect = pivot_mutation_token(&state, &pivot_state, &file_state, pivot_id)?;

    let prev = pivot_state.previous_states.lock().unwrap().remove(&pivot_id);
    if let Some((old_def, old_cache)) = prev {
        log_info!("PIVOT", "revert_pivot_operation pivot_id={}", pivot_id);

        let dest_sheet_idx = resolve_dest_sheet_index(&state, &old_def);
        let destination = old_def.destination;

        // Recalculate the old view
        let mut cache = old_cache;
        let view = safe_calculate_pivot(&old_def, &mut cache);
        store_view(&pivot_state, pivot_id, &view);

        // Restore definition + cache
        {
            let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_def;
                *c = cache;
            }
        }

        // Re-write grid with the old view
        finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

        Ok(())
    } else {
        // No previous state available — nothing to revert
        Ok(())
    }
}

/// Why a declined overwrite took nothing back: the step it names is not the
/// last change in the history (something landed on top of it, or it was
/// already undone). Nothing was popped.
pub(crate) const OVERWRITE_STEP_NOT_ON_TOP: &str =
    "The PivotTable change was not taken back: it is no longer the last change in the undo \
     history. Use Undo (Ctrl+Z) to step back to it.";

/// Why a declined overwrite took nothing back: the command that overwrote the
/// cells recorded no step that holds them, so there is nothing of THIS gesture
/// to take back -- and taking back whatever is on top instead would undo
/// something else.
pub(crate) const NO_OVERWRITE_STEP: &str =
    "The PivotTable change recorded no undo step for the cells it overwrote, so nothing was \
     taken back.";

/// Why a declined overwrite took nothing back: the step that holds it also
/// holds ANOTHER caller's writes -- a script's `beginBatch` (or a Core gesture)
/// joined it while it was open (`Transaction::absorbed_begin`, BUG-0200) --
/// and taking it back would take those back too. Nothing was popped.
pub(crate) const OVERWRITE_STEP_SHARED: &str =
    "The PivotTable change was not taken back: its undo step also holds another change made at \
     the same time (a script or another edit). Use Undo (Ctrl+Z) to take both back.";

/// Take back EXACTLY the step(s) a declined "A PivotTable report will
/// overwrite existing data" names, and nothing else.
///
/// THE DEFECT THIS REPLACES. The old command popped the top undo entry
/// unconditionally and, when that entry was not a pivot restore of this pivot,
/// "silently succeeded": a level-1 filter records no step, so its Cancel
/// discarded the user's previous, UNRELATED step, restored nothing, and left
/// the cells overwritten.
///
/// THE RULE. Every step that holds overwritten cells carries an overwrite
/// token (`record_pivot_definition_undo`), and the command that recorded it
/// returns it (`PivotViewResponse::overwrite_token`). A Cancel hands the
/// tokens of its gesture back. Under ONE lock, the top entry is examined: if it
/// carries one of them it is taken and undone -- the WHOLE transaction, so a
/// slicer click's selection comes back with its pivots -- otherwise it is put
/// back exactly where it was (same id, redo untouched) and the Cancel is
/// REFUSED (`OVERWRITE_STEP_NOT_ON_TOP`). It repeats while the next entry also
/// carries one (a gesture whose applies each recorded a step of their own).
/// No tokens at all is refused too (`NO_OVERWRITE_STEP`): the command recorded
/// nothing, and there is nothing of this gesture to take back.
///
/// THE TOKENS ARE THE ONLY AUTHORITY. Nothing is taken back by its history id:
/// every gesture's own step carries its tokens (the slicer and ribbon gestures
/// land ONE step, and the timeline's selection JOINS its pivots' step, W1), so
/// a take-back of "the step beneath, by id" -- which a declined timeline click
/// once needed -- would only ever be a way to take back a stranger's step
/// (wave E, Y1: that parameter is gone).
///
/// A declined gesture never happened: each undone step's inverse is taken
/// OFF the redo stack again (by its id), so Ctrl+Y cannot re-apply what the
/// user refused. The restore itself is the ordinary undo body
/// (`apply_changes`): pivot restores are deferred until its grid guards drop,
/// which is what made the old bespoke restore (and its deadlock note)
/// unnecessary.
#[allow(clippy::too_many_arguments)]
pub(crate) fn undo_pivot_overwrite_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &PivotState,
    slicer_state: &crate::slicer::SlicerState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    pane_control_state: &crate::pane_control::PaneControlState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    overwrite_tokens: &[u64],
) -> Result<(Vec<crate::undo_commands::UndoResult>, bool), String> {
    if overwrite_tokens.is_empty() {
        return Err(NO_OVERWRITE_STEP.to_string());
    }
    let mut pending: std::collections::HashSet<u64> = overwrite_tokens.iter().copied().collect();
    let mut results = Vec::new();
    let undo_one = |transaction: engine::Transaction| {
        let seq = transaction.seq;
        let result = crate::undo_commands::apply_changes(
            state,
            file_state,
            user_files_state,
            pivot_state,
            slicer_state,
            ribbon_filter_state,
            pane_control_state,
            timeline_state,
            transaction,
            true,
        );
        crate::undo_commands::discard_redo_of(state, seq);
        result
    };
    // A step of this gesture that ABSORBED another caller's begin holds that
    // caller's writes too: it is refused like a step that is not on top.
    let mut shared = false;
    while !pending.is_empty() {
        // PEEK, under the one lock: the stack has no borrowing peek, so the
        // top is taken and -- when it is not this gesture's -- put straight
        // back with its id (`push_undo_for_redo` neither restamps nor clears
        // the redo stack). Nothing else can see the stack in between.
        let transaction = {
            let mut undo_stack = state.undo_stack.lock().unwrap();
            let Some(top) = undo_stack.pop_undo() else { break };
            let tokens = crate::undo_commands::pivot_overwrite_tokens_of(&top);
            if tokens.iter().any(|t| pending.contains(t)) && !top.absorbed_begin {
                for t in &tokens {
                    pending.remove(t);
                }
                top
            } else {
                shared = tokens.iter().any(|t| pending.contains(t));
                undo_stack.push_undo_for_redo(top);
                break;
            }
        };
        results.push(undo_one(transaction));
    }
    if results.is_empty() {
        return Err(if shared { OVERWRITE_STEP_SHARED } else { OVERWRITE_STEP_NOT_ON_TOP }.to_string());
    }
    Ok((results, pending.is_empty()))
}

/// Take back the step(s) a declined "overwrite existing data?" names -- see
/// [`undo_pivot_overwrite_core`]. Called by the frontend when the user
/// declines the dialog, with the `overwriteToken`(s) of the gesture's
/// responses. `pivot_id` names the pivot the dialog was about (logged); the
/// tokens are the authority.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn undo_pivot_overwrite(
    app: tauri::AppHandle,
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    pivot_id: PivotId,
    overwrite_tokens: Option<Vec<u64>>,
) -> Result<PivotOverwriteUndoResponse, String> {
    log_info!("PIVOT", "undo_pivot_overwrite pivot_id={} tokens={:?}", pivot_id, overwrite_tokens);
    let (results, complete) = undo_pivot_overwrite_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &timeline_state,
        overwrite_tokens.as_deref().unwrap_or(&[]),
    )?;
    let mut refresh_domains: Vec<String> = Vec::new();
    for result in &results {
        crate::undo_commands::recalc_visibility_after_undo(
            &app,
            &state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            result,
        );
        for domain in &result.refresh_domains {
            if !refresh_domains.contains(domain) {
                refresh_domains.push(domain.clone());
            }
        }
    }
    Ok(PivotOverwriteUndoResponse { steps_undone: results.len() as u32, complete, refresh_domains })
}

/// Updates the field configuration of an existing pivot table
#[tauri::command]
pub async fn update_pivot_fields(
    window: tauri::Window,
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    request: UpdatePivotFieldsRequest,
) -> Result<PivotViewResponse, String> {
    // Refusal-first: verify the pivot exists BEFORE minting the eager `mutates`
    // token, so a refused command leaves the document clean.
    let effect = pivot_mutation_token(&state, &pivot_state, &file_state, request.pivot_id)?;

    log_info!("PIVOT", "update_pivot_fields pivot_id={}", request.pivot_id);

    let t_total = Instant::now();

    let pivot_id = request.pivot_id;

    // A BI pivot's calculation-group filter can't recalc locally (this is the
    // grid filter-dropdown apply path): the number of VISIBLE items decides
    // whether an item is applied at all (PBI/AS semantics), and the cache
    // only holds the current selection's data. Apply the new hidden_items to
    // the matching definition field(s) and delegate to the BI re-query,
    // leaving the other filter fields untouched.
    if let Some(ref filter_configs) = request.filter_fields {
        let calc_group_touched = {
            let bi_meta = pivot_state.bi_metadata.read().unwrap();
            bi_meta.get(&pivot_id).is_some_and(|meta| {
                filter_configs
                    .iter()
                    .any(|fc| meta.calculation_groups.iter().any(|g| g.name == fc.name))
            })
        };
        if calc_group_touched {
            {
                let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
                let (definition, _) = pivot_tables
                    .get_mut(&pivot_id)
                    .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
                for fc in filter_configs {
                    let hidden = fc.hidden_items.clone().unwrap_or_default();
                    for pf in definition.filter_fields.iter_mut() {
                        if pf.field.name == fc.name {
                            pf.field.hidden_items = hidden.clone();
                        }
                    }
                    for f in definition
                        .row_fields
                        .iter_mut()
                        .chain(definition.column_fields.iter_mut())
                    {
                        if f.name == fc.name {
                            f.hidden_items = hidden.clone();
                        }
                    }
                }
                definition.bump_version();
            }
            return refresh_pivot_cache(
                window,
                state,
                file_state,
                pivot_state,
                pane_control_state,
                ribbon_filter_state,
                user_files_state,
                bi_state,
                slicer_state,
                pivot_id,
            )
            .await;
        }
    }

    // Create cancellation token
    let token = CancellationToken::new();
    pivot_state.cancellation_tokens.lock().unwrap().insert(pivot_id, token.clone());

    // 1. Lock briefly: apply field updates, clone old + new state, release lock
    let (old_definition, old_cache, new_definition, new_cache, dest_ref) = {
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
        let (definition, cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

        // Save old state for reversion on cancel (both in-flight and post-completion)
        let old_definition = definition.clone();
        let old_cache = cache.clone();
        pivot_state.previous_states.lock().unwrap()
            .insert(pivot_id, (old_definition.clone(), old_cache.clone()));

        // Row, column and filter fields.
        apply_zone_field_configs(definition, &request);

        // Update value fields
        if let Some(ref value_configs) = request.value_fields {
            definition.value_fields = value_configs
                .iter()
                .map(config_to_value_field)
                .collect();

            // Resolve base_field name -> base_field_index for ShowValuesAs calculations
            resolve_base_field_indices(&mut definition.value_fields, value_configs, &definition.row_fields, &definition.column_fields);
        }

        // Update layout
        if let Some(ref layout_config) = request.layout {
            apply_layout_config(&mut definition.layout, layout_config);
        }

        // Update calculated fields. The Design-view DSL has no number-format
        // syntax, so an incoming def without one keeps the existing format
        // for the same-named field instead of silently wiping it.
        if let Some(ref calc_fields) = request.calculated_fields {
            let existing = std::mem::take(&mut definition.calculated_fields);
            definition.calculated_fields = calc_fields
                .iter()
                .map(|cf| pivot_engine::CalculatedField {
                    name: cf.name.clone(),
                    formula: cf.formula.clone(),
                    number_format: cf.number_format.clone().or_else(|| {
                        existing
                            .iter()
                            .find(|e| e.name == cf.name)
                            .and_then(|e| e.number_format.clone())
                    }),
                })
                .collect();
        }

        // Update value column order
        if let Some(ref order) = request.value_column_order {
            definition.value_column_order = order
                .iter()
                .map(|r| match r {
                    ValueColumnRefDef::Value { index } => pivot_engine::ValueColumnRef::Value(*index),
                    ValueColumnRefDef::Calculated { index } => pivot_engine::ValueColumnRef::Calculated(*index),
                })
                .collect();
        }

        // Bump version for cache invalidation
        definition.bump_version();

        let dest_ref = PivotDestSheet::of(definition);
        let new_def = definition.clone();
        let new_cache = cache.clone();
        (old_definition, old_cache, new_def, new_cache, dest_ref)
    };
    // pivot_tables lock released here — UI is unblocked. The sheet is
    // resolved only now (see `PivotDestSheet`).
    let dest_sheet_idx = dest_ref.resolve(&state);

    // 2. Emit progress: calculating (stage 2 of 4)
    emit_pivot_progress(&window, pivot_id, "Calculating...", 1, 4);

    // 3. Heavy computation on blocking thread pool (does not hold any Mutex)
    let definition = new_definition;
    let mut cache = new_cache;
    let calc_result = tokio::task::spawn_blocking(move || {
        let t0 = Instant::now();
        let view = safe_calculate_pivot(&definition, &mut cache);
        let calc_ms = t0.elapsed().as_secs_f64() * 1000.0;
        (view, definition, cache, calc_ms)
    })
    .await
    .map_err(|e| format!("Pivot computation failed: {}", e))?;

    let (view, definition, mut cache, calc_ms) = calc_result;

    // Check cancellation after computation
    if token.is_cancelled() {
        log_info!("PIVOT", "update_pivot_fields pivot_id={} CANCELLED after calculation", pivot_id);
        {
            let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_definition;
                *c = old_cache;
            }
        }
        pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);
        return Err("Pivot operation cancelled".into());
    }

    // 4. Emit progress: preparing response (stage 3 of 4)
    emit_pivot_progress(&window, pivot_id, "Preparing response...", 2, 4);

    let t1 = Instant::now();
    let mut response = view_to_response(&view, &definition, &mut cache);
    let serialize_ms = t1.elapsed().as_secs_f64() * 1000.0;
    let auto_fit = definition.layout.auto_fit_column_widths;
    let destination = definition.destination;
    let framed = definition.canvas_frame.is_some();

    // 5. Put updated definition + cache back
    {
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
        if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
            *def = definition;
            *c = cache;
        }
    }

    // Store view for windowed cell fetching
    store_view(&pivot_state, pivot_id, &view);

    // 6. Emit progress: writing to grid (stage 4 of 4)
    emit_pivot_progress(&window, pivot_id, "Updating grid...", 3, 4);

    // Check cancellation before grid write
    if token.is_cancelled() {
        log_info!("PIVOT", "update_pivot_fields pivot_id={} CANCELLED before grid write", pivot_id);
        {
            let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_definition;
                *c = old_cache;
            }
        }
        pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);
        return Err("Pivot operation cancelled".into());
    }

    // Save overwritten cells + count BEFORE writing pivot to grid
    let saved_cells = save_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    response.overwritten_cell_count = saved_cells.len() as u32;

    // The block the write is about to clear, for the recalculation seeds.
    let old_region = get_pivot_region(&state, pivot_id);

    // Update pivot in grid (clears old region, writes new view)
    let t2 = Instant::now();
    if let Err(refusal) = update_pivot_in_grid(&state, &effect, pivot_id, dest_sheet_idx, destination, &view, framed) {
        // Nothing was written (a destination of the wrong kind, or a canvas
        // pivot wider than its block): put the definition back exactly as a
        // cancel does, and skip the region, fit and undo record.
        {
            let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_definition;
                *c = old_cache;
            }
        }
        pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);
        return Err(refusal);
    }
    let grid_write_ms = t2.elapsed().as_secs_f64() * 1000.0;

    // Auto-fit column widths if enabled. The widths it overwrites are carried
    // into the undo record below so the resize undoes WITH the field change.
    let prev_col_widths = if auto_fit {
        auto_fit_pivot_columns(&state, &effect, dest_sheet_idx, destination, &view)
    } else {
        Vec::new()
    };

    // Update pivot region tracking
    let t3 = Instant::now();
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    let region_ms = t3.elapsed().as_secs_f64() * 1000.0;

    // Recalculate formulas referencing pivot cells -- on every sheet
    recalc_after_pivot_write(
        &state,
        &pivot_state,
        Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }),
        dest_sheet_idx,
        old_region.as_ref(),
        destination,
        &view,
    );

    // Clean up cancellation token (keep previous_states for potential revert command)
    pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
    let payload_bytes = serde_json::to_string(&response).map(|s| s.len()).unwrap_or(0);
    let payload_kb = payload_bytes as f64 / 1024.0;

    // Record undo snapshot AFTER successful completion (not before, to avoid
    // stale entries when the operation is cancelled).
    // Include saved overwritten cells so undo_pivot_overwrite can restore them.
    response.overwrite_token = record_pivot_definition_undo(&state, pivot_id, old_definition, saved_cells, dest_sheet_idx, prev_col_widths, None, "Pivot table field change");

    log_perf!(
        "PIVOT",
        "update_pivot_fields pivot_id={} rows={}x{} auto_fit={} | calc={:.1}ms serialize={:.1}ms grid_write={:.1}ms region={:.1}ms TOTAL={:.1}ms | payload={:.1}KB",
        pivot_id,
        response.row_count,
        response.col_count,
        auto_fit,
        calc_ms,
        serialize_ms,
        grid_write_ms,
        region_ms,
        total_ms,
        payload_kb
    );

    Ok(response)
}

/// Toggles the expand/collapse state of a pivot group.
/// This is deliberately kept synchronous — toggle is a fast operation that
/// only re-renders already-cached data with a different collapsed state.
/// Making it async added 3× PivotCache clones per toggle, causing noticeable lag.
#[tauri::command]
pub fn toggle_pivot_group(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: ToggleGroupRequest,
) -> Result<PivotViewResponse, String> {
    // Refusal-first: verify the pivot exists BEFORE minting the eager `mutates`
    // token, so a refused command leaves the document clean.
    let effect = pivot_mutation_token(&state, &pivot_state, &file_state, request.pivot_id)?;

    log_info!(
        "PIVOT",
        "toggle_pivot_group pivot_id={} is_row={} field_idx={}",
        request.pivot_id,
        request.is_row,
        request.field_index
    );

    let t_total = Instant::now();
    let pivot_id = request.pivot_id;

    let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Save old definition for undo (before toggle modifies it)
    let old_definition_for_undo = definition.clone();

    // Get the appropriate field list
    let fields = if request.is_row {
        &mut definition.row_fields
    } else {
        &mut definition.column_fields
    };

    // Find and toggle the field
    if request.field_index >= fields.len() {
        return Err(format!(
            "Field index {} out of range (max {})",
            request.field_index,
            fields.len().saturating_sub(1)
        ));
    }

    let field = &mut fields[request.field_index];

    if let Some(ref group_path) = request.group_path {
        let path_key = group_path
            .iter()
            .map(|(fi, vi)| format!("{}:{}", fi, vi))
            .collect::<Vec<_>>()
            .join("/");

        if field.collapsed_items.contains(&path_key) {
            field.collapsed_items.retain(|s| s != &path_key);
        } else {
            field.collapsed_items.push(path_key.clone());
        }

        log_debug!(
            "PIVOT",
            "toggled path '{}' in field {} collapsed={} (collapsed_items count={})",
            path_key,
            field.name,
            field.collapsed,
            field.collapsed_items.len()
        );
    } else if let Some(ref item_name) = request.value {
        if field.collapsed_items.contains(item_name) {
            field.collapsed_items.retain(|s| s != item_name);
        } else {
            field.collapsed_items.push(item_name.clone());
        }

        log_debug!(
            "PIVOT",
            "toggled item '{}' in field {} (collapsed_items count={})",
            item_name,
            field.name,
            field.collapsed_items.len()
        );
    } else {
        field.collapsed = !field.collapsed;
        field.collapsed_items.clear();

        log_debug!(
            "PIVOT",
            "toggled field {} collapsed={}",
            field.name,
            field.collapsed
        );
    }

    // Bump version
    definition.bump_version();

    let destination = definition.destination;
    // Resolved only after `pivot_tables` is released (see `PivotDestSheet`).
    let dest_ref = PivotDestSheet::of(definition);

    // FAST PATH: Toggle visibility on the stored view instead of re-running
    // calculate_pivot (which takes ~2s for 98K rows). The view already contains
    // all rows with parent-child relationships; we just flip visibility flags.
    let mut fast_view = {
        let views = pivot_state.views.lock().unwrap();
        views.get(&pivot_id).cloned()
    };

    if let Some(ref mut view) = fast_view {
        // Ensure children_indices are populated (engine leaves them empty)
        ensure_children_indices(view);
        // Find the row to toggle by matching expandable cells against the request
        let target_row = find_toggle_row(view, &request);
        if let Some(row_idx) = target_row {
            let old_visible_count = view.rows.iter().filter(|r| r.visible).count();
            let t_toggle = Instant::now();
            view.toggle_collapse(row_idx);
            // Re-assign sequential view_row to visible rows (eliminate gaps)
            let mut visible_idx = 0;
            for row in &mut view.rows {
                if row.visible {
                    row.view_row = visible_idx;
                    visible_idx += 1;
                }
            }

            // If the visible row count didn't change, the toggle had no effect.
            // This happens when child rows don't exist in the view (e.g., hierarchy
            // fields with field-level collapsed=true). Fall through to the SLOW path
            // which does a full recalculation with the updated definition.
            if visible_idx == old_visible_count {
                log_info!("PIVOT", "toggle_pivot_group: FAST path had no effect (children not in view), falling through to SLOW path");
                drop(pivot_tables);
                // Re-acquire for the SLOW path below
                let mut pivot_tables = pivot_state.pivot_tables.write(&effect)
                    .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
                let (definition, cache) = pivot_tables
                    .get_mut(&pivot_id)
                    .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

                let t_calc = Instant::now();
                let view = safe_calculate_pivot(definition, cache);
                let calc_ms = t_calc.elapsed().as_secs_f64() * 1000.0;

                let t_resp = Instant::now();
                let mut response = view_to_response(&view, definition, cache);
                let serialize_ms = t_resp.elapsed().as_secs_f64() * 1000.0;

                store_view(&pivot_state, pivot_id, &view);
                let destination = definition.destination;
                let dest_ref = PivotDestSheet::of(definition);
                drop(pivot_tables);
                let dest_sheet_idx = dest_ref.resolve(&state);

                let saved_cells = save_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
                response.overwritten_cell_count = saved_cells.len() as u32;
                finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;
                response.overwrite_token = record_pivot_definition_undo(&state, pivot_id, old_definition_for_undo.clone(), saved_cells, dest_sheet_idx, Vec::new(), None, "Pivot expand/collapse");

                let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
                log_perf!(
                    "PIVOT",
                    "toggle_pivot_group pivot_id={} rows={}x{} | FAST->SLOW calc={:.1}ms serialize={:.1}ms TOTAL={:.1}ms",
                    pivot_id,
                    response.row_count,
                    response.col_count,
                    calc_ms,
                    serialize_ms,
                    total_ms
                );
                return Ok(response);
            }

            // Update version to match bumped definition
            view.version = definition.version;
            // Update row_count to reflect visible rows
            view.row_count = visible_idx;
            let toggle_ms = t_toggle.elapsed().as_secs_f64() * 1000.0;

            let t_resp = Instant::now();
            let mut response = view_to_response(view, definition, cache);
            let serialize_ms = t_resp.elapsed().as_secs_f64() * 1000.0;

            // Store updated view
            store_view(&pivot_state, pivot_id, view);
            drop(pivot_tables);
            let dest_sheet_idx = dest_ref.resolve(&state);

            // Clear old cells and write updated view to grid (prevents orphaned cells
            // when pivot shrinks after collapse)
            let saved_cells = save_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, view);
            response.overwritten_cell_count = saved_cells.len() as u32;
            finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;
            response.overwrite_token = record_pivot_definition_undo(&state, pivot_id, old_definition_for_undo.clone(), saved_cells, dest_sheet_idx, Vec::new(), None, "Pivot expand/collapse");

            let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
            log_perf!(
                "PIVOT",
                "toggle_pivot_group pivot_id={} rows={}x{} | FAST toggle={:.1}ms serialize={:.1}ms TOTAL={:.1}ms",
                pivot_id,
                response.row_count,
                response.col_count,
                toggle_ms,
                serialize_ms,
                total_ms
            );
            return Ok(response);
        }
    }

    // SLOW PATH: No stored view or couldn't find the target row — full recalculation
    let t_calc = Instant::now();
    let view = safe_calculate_pivot(definition, cache);
    let calc_ms = t_calc.elapsed().as_secs_f64() * 1000.0;

    let t_resp = Instant::now();
    let mut response = view_to_response(&view, definition, cache);
    let serialize_ms = t_resp.elapsed().as_secs_f64() * 1000.0;

    // Store view for windowed cell fetching
    store_view(&pivot_state, pivot_id, &view);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    // Clear old cells and write updated view to grid, then update region bounds
    let saved_cells = save_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    response.overwritten_cell_count = saved_cells.len() as u32;
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;
    response.overwrite_token = record_pivot_definition_undo(&state, pivot_id, old_definition_for_undo, saved_cells, dest_sheet_idx, Vec::new(), None, "Pivot expand/collapse");

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;

    log_perf!(
        "PIVOT",
        "toggle_pivot_group pivot_id={} rows={}x{} | SLOW calc={:.1}ms serialize={:.1}ms TOTAL={:.1}ms",
        pivot_id,
        response.row_count,
        response.col_count,
        calc_ms,
        serialize_ms,
        total_ms
    );

    Ok(response)
}

/// Gets the current view of a pivot table
#[tauri::command]
pub fn get_pivot_view(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: Option<PivotId>,
) -> Result<PivotViewResponse, String> {
    // Use provided ID or active pivot
    let id = match pivot_id {
        Some(id) => id,
        None => {
            let active = pivot_state.active_pivot_id.lock().unwrap();
            active.ok_or_else(|| "No active pivot table".to_string())?
        }
    };

    log_debug!("PIVOT", "get_pivot_view pivot_id={}", id);

    let mut pivot_tables = pivot_state.pivot_tables.write(&pivot_render_effect()).unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&id)
        .ok_or_else(|| format!("Pivot table {} not found", id))?;

    let t0 = Instant::now();
    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, id, &view);
    let calc_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let response = view_to_response(&view, definition, cache);
    let serialize_ms = t1.elapsed().as_secs_f64() * 1000.0;

    log_perf!(
        "PIVOT",
        "get_pivot_view pivot_id={} rows={}x{} | calc={:.1}ms serialize={:.1}ms TOTAL={:.1}ms",
        id,
        response.row_count,
        response.col_count,
        calc_ms,
        serialize_ms,
        calc_ms + serialize_ms
    );

    Ok(response)
}

/// Fetches a window of cell data from a stored PivotView (for scroll-triggered loading).
#[tauri::command]
pub fn get_pivot_cell_window(
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    start_row: usize,
    row_count: usize,
) -> Result<PivotCellWindowResponse, String> {
    let views = pivot_state.views.lock().unwrap();
    let view = views
        .get(&pivot_id)
        .ok_or_else(|| format!("No cached view for pivot {}", pivot_id))?;

    if start_row >= view.rows.len() {
        return Ok(PivotCellWindowResponse {
            pivot_id,
            version: view.version,
            start_row,
            rows: Vec::new(),
        });
    }

    let rows = extract_cell_window(view, start_row, row_count);
    let version = view.version;
    drop(views);

    Ok(PivotCellWindowResponse {
        pivot_id,
        version,
        start_row,
        rows,
    })
}

/// Deletes a pivot table
#[tauri::command]
pub fn delete_pivot_table(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    pivot_id: PivotId,
) -> Result<(), String> {
    // Refusal-first: verify the pivot exists BEFORE minting the eager `mutates`
    // token, so a refused command leaves the document clean. No canvas refusal:
    // deleting a pivot stranded on a canvas is how the user gets rid of it --
    // but a sheet protected against it refuses (`refuse_a_protected_pivot_delete`).
    refuse_a_protected_pivot_delete(&state, &pivot_state, pivot_id)?;
    let effect = pivot_exists_token(&pivot_state, &file_state, pivot_id)?;

    log_info!("PIVOT", "delete_pivot_table pivot_id={}", pivot_id);

    // §3bn — THE CASCADE, run here for two reasons. The token above already
    // proved the pivot exists, so nothing below can refuse; and the restores it
    // produces have to land inside the ONE undo transaction opened a few lines
    // down, which means computing them before it opens (the cascade takes the
    // slicer / timeline / filter locks, and the undo lock is never held across
    // a store lock).
    //
    // A pivot is the widest source in the workbook: slicers bind to it, timeline
    // slicers bind ONLY to it, and ribbon filters list it as a target. All three
    // used to survive the delete pointing at an id that resolved to nothing.
    let cascade = crate::object_deps::cascade_deleted_sources(
        &state,
        &slicer_state,
        &timeline_state,
        &ribbon_filter_state,
        &effect,
        &[crate::object_deps::DeletedSource::pivot(pivot_id)],
    );
    if !cascade.is_empty() {
        log_info!(
            "PIVOT",
            "delete_pivot_table {} cascaded: {}",
            pivot_id,
            cascade.describe()
        );
    }

    // Get pivot info before removing
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let (definition, cache) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Record undo snapshot for pivot deletion (undo = recreate the pivot)
    {
        #[derive(serde::Serialize)]
        struct PivotFullSnapshot {
            pivot_id: PivotId,
            definition: PivotDefinition,
            cache: PivotCache,
        }
        let snapshot = PivotFullSnapshot {
            pivot_id,
            definition: definition.clone(),
            cache: cache.clone(),
        };
        let data = serde_json::to_vec(&snapshot).unwrap_or_default();
        // A MEMBER of an open transaction (wave B, A4): a canvas-wide Delete
        // that removes a pivot box with a chart and a slicer is ONE Ctrl+Z.
        // The unconditional begin/commit pair this used to record committed
        // the caller's transaction half-way (`begin` is a no-op while one is
        // open, `commit` is not).
        let opened = {
            let mut undo_stack = state.undo_stack.lock().unwrap();
            let opened = !undo_stack.has_open_transaction();
            if opened {
                undo_stack.begin_transaction("Delete pivot table");
            }
            opened
        };
        // Cascade restores FIRST so the reverse replay puts the pivot back
        // before the slicers that point at it.
        crate::object_deps::record_source_cascade_undo(&state, &cascade);
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_custom_restore("pivot_delete".to_string(), data, "Delete pivot table");
        if opened {
            undo_stack.commit_transaction();
        }
    }

    let dest_ref = PivotDestSheet::of(definition);
    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);
    
    // The block to clear: what the pivot WROTE. An empty pivot's placeholder
    // wrote nothing, and the cells under it are the user's.
    let old_region = pivot_written_region(&state, pivot_id);
    
    // Clear the pivot area from the grid
    if let Some(ref region) = old_region {
        // CANONICAL GRID LOCK ORDER: `grid` before `grids`.
        let mut grid = state.grid.write(&effect).unwrap();
        let mut grids = state.grids.write(&effect).unwrap();
        // Its merges go with its cells (BUG-0148): a deleted pivot left the
        // user's cells under its report-filter row merged.
        clear_pivot_merges(&state, &effect, dest_sheet_idx, region);
        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            clear_pivot_region_from_grid(
                dest_grid,
                region.start_row,
                region.start_col,
                region.end_row,
                region.end_col,
            );

            // Sync to state.grid if this is the active sheet
            let active_sheet = *state.active_sheet.read().unwrap();
            if dest_sheet_idx == active_sheet {
                for row in region.start_row..=region.end_row {
                    for col in region.start_col..=region.end_col {
                        grid.clear_cell(row, col);
                    }
                }
                grid.recalculate_bounds();
            }
        }
    }

    // Remove pivot table
    let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
    pivot_tables.remove(&pivot_id);

    // Remove cached view
    pivot_state.views.lock().unwrap().remove(&pivot_id);

    // Clear active if this was the active pivot
    let mut active = pivot_state.active_pivot_id.lock().unwrap();
    if *active == Some(pivot_id) {
        *active = None;
    }
    
    // Remove pivot region tracking (via generic protected region system)
    let mut regions = state.protected_regions.lock().unwrap();
    regions.retain(|r| !(r.region_type == "pivot" && r.owner_id == pivot_id));
    drop(regions);

    // Deleting a pivot drops it from `workbook.pivot_definitions`, clears its grid
    // region and prunes its object script -- all persisted.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    // C10: a deleted pivot must not leave its object script mounted/persisted.
    crate::scripting::object_script_commands::prune_scripts_for_instance(&state, &effect, &pivot_id.to_string());

    // PHASE B — every cell the delete CLEARED seeds the ONE shared cascade,
    // after each guard above is released. In Excel a formula reading a removed
    // pivot drops to 0 at once; this used to hold the deleted pivot's last
    // numbers until an unrelated later edit swept them up.
    drop(active);
    drop(pivot_tables);
    if let Some(ref region) = old_region {
        let seeds = pivot_block_seeds(
            (region.start_row, region.start_col),
            (region.end_row.saturating_sub(region.start_row) + 1) as usize,
            (region.end_col.saturating_sub(region.start_col) + 1) as usize,
        );
        let active_sheet = *state.active_sheet.read().unwrap();
        if dest_sheet_idx == active_sheet {
            let mut recalculated = Vec::new();
            crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
                &state,
                &user_files_state,
                &pane_control_state,
                &ribbon_filter_state,
                &seeds,
                &mut recalculated,
            );
        } else {
            crate::commands::data::recalc_after_off_sheet_write(
                &state,
                &user_files_state,
                &pivot_state,
                &pane_control_state,
                &ribbon_filter_state,
                &[dest_sheet_idx],
            );
        }
    }

    Ok(())
}

/// Relocate a pivot table to a new destination cell.
/// Updates the definition, recalculates, rewrites grid cells, and updates region tracking.
#[tauri::command]
pub fn relocate_pivot(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pivot_id: PivotId,
    new_row: u32,
    new_col: u32,
) -> Result<(), String> {
    // A CANVAS pivot's anchor belongs to the block allocator, not the user:
    // moving it would walk it out of its block and over a neighbour's. The
    // user moves its BOX instead (`update_pivot_properties` with a frame).
    // Refused before the token, so the document stays clean.
    ensure_pivot_not_framed(&pivot_state, pivot_id, "move the cells of")?;

    // Refusal-first: verify the pivot exists BEFORE minting the eager `mutates`
    // token, so a refused command leaves the document clean.
    let effect = pivot_mutation_token(&state, &pivot_state, &file_state, pivot_id)?;

    log_info!("PIVOT", "relocate_pivot pivot_id={} to ({},{})", pivot_id, new_row, new_col);

    // 1. Update the definition's destination
    let (view, old_definition) = {
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
        let (definition, cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

        let old_dest = definition.destination;
        if old_dest == (new_row, new_col) {
            return Ok(()); // No-op if destination unchanged
        }

        // The definition BEFORE the move, for undo. Excel undoes a PivotTable
        // move; this command recorded nothing at all, so the pivot stayed where
        // it was dragged and Ctrl+Z silently undid whatever came before it.
        let old_definition = definition.clone();

        definition.destination = (new_row, new_col);

        // 2. Recalculate the view at the new destination
        (safe_calculate_pivot(definition, cache), old_definition)
    };

    // 3. Resolve sheet index -- from the pre-move CLONE, holding nothing. A move
    //    changes only the anchor cell, never the sheet name or the pivot's id,
    //    which are all the resolver reads; and `pivot_tables` held across the
    //    resolver is the order `delete_sheet_impl` inverts.
    let dest_sheet_idx = resolve_dest_sheet_index(&state, &old_definition);

    // 4. Clear old region and write new cells at new destination. A refusal (a
    //    canvas destination) wrote nothing: the move is put back and nothing
    //    after this -- region, view, undo record -- happens.
    let old_region = get_pivot_region(&state, pivot_id);
    if let Err(refusal) = update_pivot_in_grid(
        &state,
        &effect,
        pivot_id,
        dest_sheet_idx,
        (new_row, new_col),
        &view,
        old_definition.canvas_frame.is_some(),
    ) {
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
        if let Some((definition, _)) = pivot_tables.get_mut(&pivot_id) {
            *definition = old_definition;
        }
        return Err(refusal);
    }

    // 5. Update protected region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, (new_row, new_col), &view);

    // 5b. Recalculate formulas referencing pivot cells -- the block it left
    //     and the block it landed on, on every sheet that reads them.
    recalc_after_pivot_write(
        &state,
        &pivot_state,
        Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }),
        dest_sheet_idx,
        old_region.as_ref(),
        (new_row, new_col),
        &view,
    );

    // 6. Store the updated view
    store_view(&pivot_state, pivot_id, &view);

    // 7. Record the move as ONE undo step. `apply_pivot_definition_restore`
    //    puts the old definition back and re-renders from the SAME cache, which
    //    is exactly right for a move: nothing about the data changed.
    record_pivot_definition_undo(
        &state,
        pivot_id,
        old_definition,
        Vec::new(),
        dest_sheet_idx,
        Vec::new(),
        // A move does not touch the records, so no cache snapshot.
        None,
        "Move pivot table",
    );

    log_info!("PIVOT", "relocate_pivot pivot_id={} complete", pivot_id);
    Ok(())
}

/// Gets source data for drill-down (detail view)
#[tauri::command]
pub fn get_pivot_source_data(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    group_path: Vec<(usize, u32)>,
    max_records: Option<usize>,
) -> Result<SourceDataResponse, String> {
    log_info!(
        "PIVOT",
        "get_pivot_source_data pivot_id={} path_len={}",
        pivot_id,
        group_path.len()
    );
    pivot_source_data_core(&state, &pivot_state, pivot_id, &group_path, max_records)
}

/// [`get_pivot_source_data`] over borrowed state.
///
/// LOCK ORDER: nothing here waits for a lock while holding the pivot guard.
/// The calculation pass (`calculate_now`, an ASYNC command, so on a pool
/// thread while this sync command runs on the main thread) holds `grid` and
/// `grids` and then takes `pivot_tables` for GETPIVOTDATA; this command used
/// to hold `pivot_tables` while it took `grids`, so a Show Details
/// double-click during an F9 hung the main thread with no panic and no log.
/// Everything the row read needs is copied under the guard, which is dropped
/// before `grids` is taken.
pub(crate) fn pivot_source_data_core(
    state: &AppState,
    pivot_state: &PivotState,
    pivot_id: PivotId,
    group_path: &[(usize, u32)],
    max_records: Option<usize>,
) -> Result<SourceDataResponse, String> {
    // Snapshot the sheet names BEFORE taking pivot_tables. `delete_sheet` locks
    // sheet_names and then pivot_tables; taking them in the opposite order here
    // would be a classic AB/BA deadlock between two concurrent commands.
    let sheet_names_snapshot = sheet_names_snapshot(state);

    let (result, source_sheet_idx, (start_row, start_col), end_col, has_headers) = {
        let pivot_tables = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
        let (definition, cache) = pivot_tables
            .get(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

        let max = max_records.unwrap_or(1000);
        let result = drill_down(definition, cache, group_path, max);

        // The pivot's ACTUAL source sheet. Drilling through a Sheet3 pivot
        // used to show Sheet1's rows.
        let source_sheet_idx = definition
            .source_sheet
            .as_deref()
            .and_then(|name| index_of_sheet(&sheet_names_snapshot, name))
            .unwrap_or(0);
        (
            result,
            source_sheet_idx,
            definition.source_start,
            definition.source_end.1,
            definition.source_has_headers,
        )
    }; // pivot guard released: `grids` is taken with no pivot lock held

    // Convert source rows to formatted strings.
    let grids = state.grids.read().map_err(|e| e.to_string())?;
    let grid = grids
        .get(source_sheet_idx)
        .ok_or_else(|| "Source sheet not found".to_string())?;

    let data_start = if has_headers {
        start_row + 1
    } else {
        start_row
    };

    let rows: Vec<Vec<String>> = result
        .source_rows
        .iter()
        .map(|&src_row| {
            let grid_row = data_start + src_row;
            (start_col..=end_col)
                .map(|c| {
                    grid.get_cell(grid_row, c)
                        .map(|cell| cell.display_value())
                        .unwrap_or_default()
                })
                .collect()
        })
        .collect();

    Ok(SourceDataResponse {
        pivot_id,
        headers: result.headers,
        rows,
        total_count: result.total_count,
        is_truncated: result.is_truncated,
    })
}

/// Split a "Table.Column" field key into (table, column). Table names can
/// contain dots (schema-qualified sources like "BI.dim_customer"), so the
/// longest known table name that prefixes the key wins; a key matching no
/// known table falls back to a first-dot split (correct for dot-free tables).
pub(crate) fn split_bi_field_key<'a, I>(name: &str, table_names: I) -> (String, String)
where
    I: IntoIterator<Item = &'a str>,
{
    let mut best: Option<&str> = None;
    for t in table_names {
        if name.len() > t.len() + 1
            && name.as_bytes()[t.len()] == b'.'
            && name.starts_with(t)
            && best.is_none_or(|b| t.len() > b.len())
        {
            best = Some(t);
        }
    }
    if let Some(t) = best {
        return (t.to_string(), name[t.len() + 1..].to_string());
    }
    name.split_once('.')
        .map(|(t, c)| (t.to_string(), c.to_string()))
        .unwrap_or_else(|| (String::new(), name.to_string()))
}

// ============================================================================
// BI PIVOT CORES -- borrowed-state entry points the commands and tests share
// ============================================================================

/// Every managed store a BI pivot command reads or writes, borrowed. The Tauri
/// commands build one from their `State`s and hand it to the `_core` fns, so
/// the unit tier drives the SAME code over plain states (this crate has no
/// tauri test harness).
#[derive(Clone, Copy)]
pub(crate) struct PivotCmdCtx<'a> {
    pub state: &'a AppState,
    pub file_state: &'a crate::persistence::FileState,
    pub pivot_state: &'a PivotState,
    pub pane_control_state: &'a crate::pane_control::PaneControlState,
    pub ribbon_filter_state: &'a crate::ribbon_filter::RibbonFilterState,
    pub user_files_state: &'a crate::persistence::UserFilesState,
    pub bi_state: &'a BiState,
    pub slicer_state: &'a crate::slicer::SlicerState,
    /// `false` = a caller that records the whole gesture itself, once, at the
    /// end (`delete_slicer_core`): the field changes this context makes then
    /// record no undo step of their own. Every Tauri command passes `true`.
    pub record_undo: bool,
}

/// The ONE model table that has a column called `column`, or `None` when no
/// table -- or more than one -- has it. A BI cache names its columns from the
/// query's Arrow schema, which is the BARE column name, so a bare name can be
/// attributed to a table only when the attribution cannot be wrong: with
/// Customers(name) and Products(name) in one model, "name" is neither.
pub(crate) fn unique_model_table_for_column(column: &str, meta: &BiPivotMetadata) -> Option<String> {
    let mut owners = meta
        .model_tables
        .iter()
        .filter(|t| t.columns.iter().any(|c| c.name == column));
    let first = owners.next()?;
    owners.next().is_none().then(|| first.name.clone())
}

/// True when the cache column `name` of a BI pivot IS model column
/// `table.column`. Cache names are "Table.Column" in older definitions or the
/// bare column name from the Arrow schema; a bare name matches only when
/// `table` is the ONLY model table with that column (see
/// [`unique_model_table_for_column`]) -- "has such a column" is not enough,
/// because the cache column may have come from a different table that also
/// has one, and a filter on Products.name would then be matched, cleared or
/// overwritten as Customers.name.
pub(crate) fn bi_cache_name_matches(
    name: &str,
    table: &str,
    column: &str,
    meta: &BiPivotMetadata,
) -> bool {
    if name.contains('.') {
        let (t, c) = split_bi_field_key(name, meta.model_tables.iter().map(|t| t.name.as_str()));
        return t == table && c == column;
    }
    name == column && unique_model_table_for_column(column, meta).as_deref() == Some(table)
}

/// Attribute a BI pivot's cache column name to (table, column): a dotted name
/// is split against the model table names, a bare one goes to the ONE table
/// that has such a column. `None` when no table can be named -- including when
/// several can, because a guessed table silently filters the wrong column.
pub(crate) fn resolve_bi_cache_name(name: &str, meta: &BiPivotMetadata) -> Option<(String, String)> {
    let (table, column) = if name.contains('.') {
        split_bi_field_key(name, meta.model_tables.iter().map(|t| t.name.as_str()))
    } else {
        (unique_model_table_for_column(name, meta)?, name.to_string())
    };
    (!table.is_empty()).then_some((table, column))
}

/// The model column a BI pivot's slicer filter is on. Its stamped
/// [`pivot_engine::SlicerFilter::model_key`] is the authority; a filter from
/// before the key existed falls back to its cache column name under the
/// uniqueness rule. `None` (logged) when neither names a column of the model:
/// the filter is dropped rather than attributed to a guess.
pub(crate) fn slicer_filter_model_column(
    sf: &pivot_engine::SlicerFilter,
    cache: &PivotCache,
    meta: &BiPivotMetadata,
) -> Option<(String, String)> {
    if let Some(key) = sf.model_key.as_deref() {
        return match split_model_column_key(key, meta) {
            Ok(tc) => Some(tc),
            Err(e) => {
                crate::log_warn!("PIVOT", "slicer filter on {} dropped: {}", key, e);
                None
            }
        };
    }
    let name = cache.field_name(sf.source_index)?;
    let resolved = resolve_bi_cache_name(&name, meta);
    if resolved.is_none() {
        crate::log_warn!(
            "PIVOT",
            "slicer filter on cache column '{}' dropped: no single model table owns it",
            name
        );
    }
    resolved
}

/// Does slicer filter `sf` sit on model column `table.column`?
fn slicer_filter_is_on(
    sf: &pivot_engine::SlicerFilter,
    cache: &PivotCache,
    meta: &BiPivotMetadata,
    table: &str,
    column: &str,
) -> bool {
    match sf.model_key.as_deref() {
        Some(key) => key == format!("{table}.{column}"),
        None => cache
            .field_name(sf.source_index)
            .is_some_and(|n| bi_cache_name_matches(&n, table, column, meta)),
    }
}

/// Split a "Table.Column" key against the pivot's model and REFUSE a key that
/// names no column of it: a mis-attributed filter would silently filter
/// nothing (or the wrong column), so this fails closed.
pub(crate) fn split_model_column_key(
    key: &str,
    meta: &BiPivotMetadata,
) -> Result<(String, String), String> {
    let (table, column) = split_bi_field_key(key, meta.model_tables.iter().map(|t| t.name.as_str()));
    let known = meta
        .model_tables
        .iter()
        .any(|t| t.name == table && t.columns.iter().any(|c| c.name == column));
    if known {
        Ok((table, column))
    } else {
        Err(format!("'{key}' is not a column of this pivot's model"))
    }
}

/// The cache index at which a BI pivot carries model column `table.column`, or
/// `None` when the pivot does not carry it at all. Zone fields are matched by
/// their "Table.Column" name; slicer filters by their stamped model key (or,
/// for a filter saved before the key existed, by a cache name that only ONE
/// model table can own).
pub(crate) fn resolve_bi_field_index(
    definition: &PivotDefinition,
    cache: &PivotCache,
    meta: &BiPivotMetadata,
    table: &str,
    column: &str,
) -> Option<usize> {
    let key_name = format!("{table}.{column}");
    definition
        .row_fields
        .iter()
        .chain(definition.column_fields.iter())
        .find(|f| f.name == key_name)
        .map(|f| f.source_index)
        .or_else(|| {
            definition
                .filter_fields
                .iter()
                .find(|f| f.field.name == key_name)
                .map(|f| f.field.source_index)
        })
        .or_else(|| {
            definition
                .slicer_filters
                .iter()
                .find(|sf| slicer_filter_is_on(sf, cache, meta, table, column))
                .map(|sf| sf.source_index)
        })
}

/// The slicer fields a BI pivot already carries, as request refs WITH their
/// hidden items: the KEEP arm of `slicer_fields: None` and the refresh
/// reconstruction. A filter whose column cannot be attributed to a model table
/// is dropped, because it could not be queried.
pub(crate) fn slicer_fields_from_definition(
    definition: &PivotDefinition,
    cache: &PivotCache,
    meta: &BiPivotMetadata,
) -> Vec<BiFieldRef> {
    let mut out: Vec<BiFieldRef> = Vec::new();
    for sf in &definition.slicer_filters {
        let Some((table, column)) = slicer_filter_model_column(sf, cache, meta) else { continue };
        if out.iter().any(|f| f.table == table && f.column == column) {
            continue;
        }
        out.push(BiFieldRef { table, column, is_lookup: false, hidden_items: Some(sf.hidden_items.clone()) });
    }
    out
}

/// What every field of the OLD definition hides, keyed by (table, column):
/// the name-based carry-over `update_bi_pivot_fields` falls back to when a
/// request field arrives with no hidden items. Source indices shift between
/// queries; names do not.
fn hidden_items_by_model_key(
    definition: &PivotDefinition,
    cache: &PivotCache,
    meta: &BiPivotMetadata,
) -> std::collections::HashMap<(String, String), Vec<String>> {
    let table_names: Vec<&str> = meta.model_tables.iter().map(|t| t.name.as_str()).collect();
    let is_model_key = |t: &str, c: &str| {
        meta.model_tables
            .iter()
            .any(|mt| mt.name == t && mt.columns.iter().any(|mc| mc.name == c))
    };
    let mut out = std::collections::HashMap::new();
    for f in definition
        .row_fields
        .iter()
        .chain(definition.column_fields.iter())
        .chain(definition.filter_fields.iter().map(|f| &f.field))
    {
        if f.hidden_items.is_empty() {
            continue;
        }
        let (t, c) = split_bi_field_key(&f.name, table_names.iter().copied());
        if is_model_key(&t, &c) {
            out.entry((t, c)).or_insert_with(|| f.hidden_items.clone());
        }
    }
    for sf in &definition.slicer_filters {
        if sf.hidden_items.is_empty() {
            continue;
        }
        if let Some(key) = slicer_filter_model_column(sf, cache, meta) {
            out.entry(key).or_insert_with(|| sf.hidden_items.clone());
        }
    }
    out
}

/// A pivot with nothing placed: filtering it would turn it into a query of
/// the slicer column alone, so an ensure leaves it untouched.
fn pivot_has_no_fields(definition: &PivotDefinition) -> bool {
    definition.row_fields.is_empty()
        && definition.column_fields.is_empty()
        && definition.value_fields.is_empty()
        && definition.filter_fields.is_empty()
}

/// Rebuild the `update_bi_pivot_fields` request that reproduces a BI pivot's
/// stored definition -- what a refresh re-runs and what an ensure extends.
///
/// NOTHING THE USER SET MAY FALL OUT OF IT: every dimension's hidden items
/// (a level-1 slicer filter on a column that is a row or column field lives
/// there), hierarchy placements (the level fields `update_bi_pivot_fields`
/// appended are folded back into their hierarchy), value custom names, the
/// calculation-group placement, lookups, calculated fields, and the slicer
/// fields with their hidden items. The previous in-line copy in
/// `refresh_pivot_cache` rebuilt rows and columns with no hidden items and no
/// hierarchies, so every refresh -- and every frontend "ensure" built on the
/// same recipe -- silently dropped them.
pub(crate) fn bi_request_from_definition(
    pivot_id: PivotId,
    definition: &PivotDefinition,
    cache: &PivotCache,
    meta: &BiPivotMetadata,
) -> UpdateBiPivotFieldsRequest {
    let table_names: Vec<&str> = meta.model_tables.iter().map(|t| t.name.as_str()).collect();
    let calc_group_names: std::collections::HashSet<&str> =
        meta.calculation_groups.iter().map(|g| g.name.as_str()).collect();
    // A placed calculation-group field is named after the GROUP (no table
    // part) — reconstruct it as its pseudo ref so update_bi_pivot_fields
    // re-places it.
    let parse_field = |name: &str, is_lookup: bool| -> BiFieldRef {
        if calc_group_names.contains(name) {
            return BiFieldRef {
                table: CALC_GROUP_TABLE.to_string(),
                column: name.to_string(),
                is_lookup: false,
                hidden_items: None,
            };
        }
        let (table, column) = split_bi_field_key(name, table_names.iter().copied());
        BiFieldRef { table, column, is_lookup, hidden_items: None }
    };
    // Every dimension's hidden items are sent EXPLICITLY (`Some`, even when
    // empty): the stored definition is the truth this request reproduces.
    let parse_dim_field = |f: &PivotField| -> BiFieldRef {
        let mut r = parse_field(&f.name, f.is_attribute);
        r.hidden_items = Some(f.hidden_items.clone());
        r
    };
    // Skip the synthetic values-only "Total" row field — it is not a model
    // column (update_bi_pivot_fields re-injects it as needed).
    let is_synthetic_total =
        |f: &PivotField| -> bool { f.name == "Total" && !calc_group_names.contains("Total") };

    // Hierarchy placements: update_bi_pivot_fields appended each hierarchy's
    // level fields after the plain fields and recorded the range in
    // `hierarchy_configs`. A range whose fields are no longer exactly the
    // hierarchy's levels is stale, and is kept as plain fields rather than
    // guessed at.
    let mut row_levels: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut col_levels: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut row_hierarchies: Vec<BiHierarchyFieldRef> = Vec::new();
    let mut column_hierarchies: Vec<BiHierarchyFieldRef> = Vec::new();
    for hc in &definition.hierarchy_configs {
        let fields = if hc.is_row { &definition.row_fields } else { &definition.column_fields };
        let end = hc.field_start + hc.field_count;
        if hc.field_count == 0 || end > fields.len() {
            continue;
        }
        let (table, _) = split_bi_field_key(&fields[hc.field_start].name, table_names.iter().copied());
        let Some(h) = meta.hierarchies.iter().find(|h| h.name == hc.name && h.table == table) else {
            continue;
        };
        let levels_match = h.levels.len() == hc.field_count
            && h.levels
                .iter()
                .zip(&fields[hc.field_start..end])
                .all(|(level, f)| f.name == format!("{}.{}", table, level.column));
        if !levels_match {
            continue;
        }
        let r = BiHierarchyFieldRef { hierarchy: hc.name.clone(), table: table.clone(), expanded: Vec::new() };
        if hc.is_row {
            row_levels.extend(hc.field_start..end);
            row_hierarchies.push(r);
        } else {
            col_levels.extend(hc.field_start..end);
            column_hierarchies.push(r);
        }
    }

    let row_fields: Vec<BiFieldRef> = definition
        .row_fields
        .iter()
        .enumerate()
        .filter(|(i, f)| !row_levels.contains(i) && !is_synthetic_total(f))
        .map(|(_, f)| parse_dim_field(f))
        .collect();
    let column_fields: Vec<BiFieldRef> = definition
        .column_fields
        .iter()
        .enumerate()
        .filter(|(i, _)| !col_levels.contains(i))
        .map(|(_, f)| parse_dim_field(f))
        .collect();
    // Strip the "[...]" display wrapper to recover the clean measure name
    // (value fields are one per base measure).
    let value_fields: Vec<BiValueFieldRef> = {
        let mut seen_calc: std::collections::HashSet<String> = std::collections::HashSet::new();
        definition
            .value_fields
            .iter()
            .filter(|v| v.calc_item.is_none() || seen_calc.insert(v.name.clone()))
            .map(|v| BiValueFieldRef {
                measure_name: v.name.trim_start_matches('[').trim_end_matches(']').to_string(),
                custom_name: if v.calc_item.is_some() { None } else { v.custom_name.clone() },
            })
            .collect()
    };
    let filter_fields: Vec<BiFieldRef> = definition
        .filter_fields
        .iter()
        .map(|f| {
            let mut field = parse_field(&f.field.name, f.field.is_attribute);
            field.hidden_items = Some(f.field.hidden_items.clone());
            field
        })
        .collect();
    let slicer_fields = slicer_fields_from_definition(definition, cache, meta);
    let calculated_fields: Option<Vec<CalculatedFieldDef>> = if definition.calculated_fields.is_empty() {
        None
    } else {
        Some(
            definition
                .calculated_fields
                .iter()
                .map(|cf| CalculatedFieldDef {
                    name: cf.name.clone(),
                    formula: cf.formula.clone(),
                    number_format: cf.number_format.clone(),
                })
                .collect(),
        )
    };
    let value_column_order = if definition.value_column_order.is_empty() {
        None
    } else {
        Some(
            definition
                .value_column_order
                .iter()
                .map(|v| match v {
                    pivot_engine::ValueColumnRef::Value(i) => ValueColumnRefDef::Value { index: *i },
                    pivot_engine::ValueColumnRef::Calculated(i) => ValueColumnRefDef::Calculated { index: *i },
                })
                .collect(),
        )
    };

    UpdateBiPivotFieldsRequest {
        pivot_id,
        row_fields,
        column_fields,
        value_fields,
        filter_fields,
        slicer_fields: Some(slicer_fields),
        row_hierarchies,
        column_hierarchies,
        layout: None, // keep current layout
        lookup_columns: meta.lookup_columns.iter().cloned().collect(),
        calculated_fields,
        value_column_order,
        force_requery: false,
    }
}

/// An active MODEL slicer that reaches a BI pivot (owner decision 2, the page
/// rule): same connection, the pivot's own sheet, a selection, on a column the
/// pivot's model has.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PageModelSlicer {
    pub slicer_id: identity::EntityId,
    pub table: String,
    pub column: String,
    pub selected: Vec<String>,
    pub level: u8,
}

/// Does model slicer `slicer` read the connection a pivot queries? The live id
/// first; the stable package data-source id covers a slicer and a pivot that
/// have not both been re-bound yet after a load.
pub(crate) fn model_slicer_reads_connection(
    slicer: &crate::slicer::Slicer,
    connection_id: identity::EntityId,
    data_source_id: Option<&str>,
) -> bool {
    slicer.is_model_slicer()
        && (slicer.cache_source_id == connection_id
            || data_source_id.is_some_and(|ds| {
                slicer.data_source_id.as_deref() == Some(ds) || slicer.cache_source_id.to_string() == ds
            }))
}

/// The page's active model slicers for one BI pivot, in a deterministic order.
/// Pure over a snapshot of the slicer store.
pub(crate) fn page_model_slicers<'s, I>(
    slicers: I,
    meta: &BiPivotMetadata,
    dest_sheet: usize,
) -> Vec<PageModelSlicer>
where
    I: IntoIterator<Item = &'s crate::slicer::Slicer>,
{
    let mut out: Vec<PageModelSlicer> = slicers
        .into_iter()
        .filter(|s| s.sheet_index == dest_sheet)
        .filter(|s| model_slicer_reads_connection(s, meta.connection_id, meta.data_source_id.as_deref()))
        .filter_map(|s| {
            let selected = s.selected_items.clone()?;
            let (table, column) = split_model_column_key(&s.field_name, meta).ok()?;
            Some(PageModelSlicer { slicer_id: s.id, table, column, selected, level: s.filter_level })
        })
        .collect();
    out.sort_by(|a, b| a.slicer_id.cmp(&b.slicer_id));
    out
}

/// Whether a cache value is one of `selected`, spelled either the cache's way
/// ("TRUE", "12.5") or the model's way (`arrow_value_to_string`: "true",
/// "12.50"). A model slicer's and a ribbon filter's items -- and so their
/// selections -- come from the model, while the mask is computed over the
/// pivot cache: with an exact match, selecting "true" on a boolean column hid
/// BOTH "TRUE" and "FALSE" and emptied every pivot on the page, and a selected
/// 12.50 silently disappeared.
pub(crate) fn cache_value_is_selected(v: &pivot_engine::CacheValue, selected: &[String]) -> bool {
    let display = cache_value_to_string(v);
    selected.iter().any(|s| {
        *s == display
            || match v {
                pivot_engine::CacheValue::Boolean(b) => {
                    s.trim().eq_ignore_ascii_case(if *b { "true" } else { "false" })
                }
                pivot_engine::CacheValue::Number(n) => s.trim().parse::<f64>().is_ok_and(|x| {
                    let n = n.as_f64();
                    x == n || (x - n).abs() <= f64::EPSILON * 4.0 * n.abs().max(1.0)
                }),
                _ => false,
            }
    })
}

/// Hidden items (in the cache's spelling, which is what the engine matches)
/// for "every value of cache column `idx` not in `selected`" -- the ONE
/// level-1 mask rule `apply_pivot_filter` and the page fold share.
///
/// THE BLANK ITEM COUNTS (wave B, A1). Blank cells are not interned values,
/// so this rule used to build its list from the non-empty values alone:
/// selecting "East" kept every BLANK-member row in each pivot it filtered.
/// When the column has blank records and `selected` does not name the blank
/// item -- `(blank)` in any case, or the empty string a model spells a NULL
/// member with -- it is hidden too, by the label the engine resolves
/// (`pivot_engine::BLANK_ITEM_LABEL`).
///
/// ONLY WHEN THE LIST OFFERED IT (the review of A1). A selection can only
/// NAME the blank item if the list it was made from showed one. A selection
/// from a list that does not ([`BlankListing::NotListed`]) cannot say whether
/// the blank rows should show, so they are left showing -- hiding them made
/// "deselect West" drop the blank rows too, with no item to bring them back
/// but clearing the filter.
///
/// `blank_listed` is the MODEL-list form of [`hidden_for_selection_listed`]:
/// `true` = [`BlankListing::FoldsEmpty`], `false` = [`BlankListing::NotListed`].
pub(crate) fn hidden_for_selection(
    cache: &mut PivotCache,
    idx: usize,
    selected: &[String],
    blank_listed: bool,
) -> Vec<String> {
    let listing = if blank_listed { BlankListing::FoldsEmpty } else { BlankListing::NotListed };
    hidden_for_selection_listed(cache, idx, selected, listing)
}

/// What the list a level-1 selection was made from offered for the BLANK --
/// which decides what the selection means for the blank (NULL) records and
/// for the EMPTY-STRING members (`CacheValue::Text("")`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BlankListing {
    /// No blank item: the selection cannot say, so the NULL and the ""
    /// records are both left showing.
    NotListed,
    /// A pivot's OWN list (its header and filter-cell dropdowns,
    /// `get_pivot_field_unique_values`): "(blank)" is the NULL records' item
    /// and "" is an item of its own. Each is kept exactly when the selection
    /// names it -- and read back that way (`pivot_field_info_core`).
    Separate,
    /// A PIVOT slicer's list (`slicer::commands::get_pivot_field_values`):
    /// ONE "(blank)", offered only when the column has NULL records, and
    /// never a "" item -- so the "" rows have no item of their own. With
    /// "(blank)" offered this is [`BlankListing::FoldsEmpty`] (the "" rows
    /// follow it); without it, [`BlankListing::NotListed`]. Resolved against
    /// the records the mask is computed over ([`BlankListing::resolved`]),
    /// which a BI re-query may have replaced since the request was read.
    /// Classed as `Separate` before (the review of wave D), East + (blank)
    /// hid the "" rows with no slicer item that could bring them back.
    PivotSlicer,
    /// A MODEL's value list (a model slicer, a ribbon filter): ONE "(blank)"
    /// for the NULL and the "" rows, as the engine's pinned filter reads it.
    /// A selection naming it -- "(blank)" in any case, or "" -- keeps both;
    /// one that does not hides both (wave D, X2: "East + (blank)" hid the ""
    /// rows the user had just chosen).
    FoldsEmpty,
}

impl BlankListing {
    /// The listing over a column that has blank (NULL) records exactly when
    /// `has_blank`: a [`BlankListing::PivotSlicer`] offered its "(blank)"
    /// only then. Every other listing is what it says.
    pub(crate) fn resolved(self, has_blank: bool) -> BlankListing {
        match self {
            BlankListing::PivotSlicer if has_blank => BlankListing::FoldsEmpty,
            BlankListing::PivotSlicer => BlankListing::NotListed,
            other => other,
        }
    }
}

/// [`hidden_for_selection`] for a list that offered the blank the way
/// `listing` says.
pub(crate) fn hidden_for_selection_listed(
    cache: &mut PivotCache,
    idx: usize,
    selected: &[String],
    listing: BlankListing,
) -> Vec<String> {
    let has_blank = idx < cache.fields.len() && cache.has_blank_values(idx);
    let listing = listing.resolved(has_blank);
    // Whether the selection keeps the blank ITEM (the NULL records).
    let names_blank = match listing {
        BlankListing::FoldsEmpty => selection_names_blank(selected),
        BlankListing::Separate => selected.iter().any(|s| pivot_engine::is_blank_item_label(s)),
        // `PivotSlicer` never survives `resolved`.
        BlankListing::NotListed | BlankListing::PivotSlicer => true,
    };
    // Whether "" belongs to that item rather than being an item of its own.
    let empty_is_blank = matches!(listing, BlankListing::FoldsEmpty | BlankListing::NotListed);
    let Some(field_cache) = cache.fields.get_mut(idx) else { return Vec::new() };
    let sorted_ids = field_cache.sorted_ids().to_vec();
    let mut hidden: Vec<String> = sorted_ids
        .iter()
        .filter(|&&id| id != VALUE_ID_EMPTY)
        .filter_map(|&id| field_cache.get_value(id).cloned())
        .filter(|v| {
            if empty_is_blank && matches!(v, pivot_engine::CacheValue::Text(s) if s.is_empty()) {
                !names_blank
            } else {
                !cache_value_is_selected(v, selected)
            }
        })
        .map(|v| cache_value_to_string(&v))
        .collect();
    if has_blank && !names_blank {
        hidden.push(pivot_engine::BLANK_ITEM_LABEL.to_string());
    }
    hidden
}

/// Whether a selection names the BLANK item of a MODEL list: `(blank)` in any
/// case, or the empty string (a model's NULL member).
pub(crate) fn selection_names_blank(selected: &[String]) -> bool {
    selected.iter().any(|s| s.is_empty() || pivot_engine::is_blank_item_label(s))
}

/// Whether a MODEL's value list -- the one every model slicer, ribbon filter
/// and pinned pivot slicer lists its items from
/// (`bi::commands::bi_get_column_values_core`) -- offers the blank (NULL)
/// member. It does (wave C, W6): NULL and empty values are listed last as
/// `pivot_engine::BLANK_ITEM_LABEL`, so a level-1 selection made from a model
/// list that does not name it hides the blank rows, exactly like a pivot's own
/// lists ([`BlankListing`]); a pinned one travels to
/// the engine, which reads the label as BLANK. The test
/// `model_value_lists_name_the_blank_exactly_when_the_mask_rule_says_so`
/// fails whenever this and the list disagree.
pub(crate) const MODEL_VALUE_LISTS_NAME_THE_BLANK: bool = true;

/// How the list the level-1 selection of `request` was made from offers the
/// blank item (see [`BlankListing`]).
///
/// A write NAMING A SLICER was made from that slicer's list, whichever key it
/// uses (a range pivot is written by field index, a BI pivot by model key):
/// a PIVOT slicer lists its pivot's cache values with one "(blank)" and no ""
/// item ([`BlankListing::PivotSlicer`]); a MODEL slicer lists the model's
/// values ([`MODEL_VALUE_LISTS_NAME_THE_BLANK`]), one "(blank)" for both.
/// Otherwise the key decides: a write by cache field index comes from the
/// pivot's own dropdowns, which list "(blank)" and "" apart
/// ([`BlankListing::Separate`]); a write by MODEL KEY naming no slicer is a
/// ribbon filter, which lists the model's values.
///
/// The slicer is checked FIRST (the review of wave D): the field-index
/// shortcut classed a range pivot's slicer as the pivot's own list, and its
/// East + (blank) hid the "" rows the slicer never offered.
///
/// LOCKS: the slicer store's read guard alone -- call it holding no pivot lock
/// (`get_slicer_items` holds the slicers while it takes `pivot_tables`).
pub(crate) fn selection_list_blank_listing(
    slicer_state: &crate::slicer::SlicerState,
    request: &ApplyPivotFilterRequest,
) -> BlankListing {
    let model_list = if MODEL_VALUE_LISTS_NAME_THE_BLANK { BlankListing::FoldsEmpty } else { BlankListing::NotListed };
    let slicer_is_model = request
        .slicer_id
        .as_deref()
        .and_then(identity::EntityId::parse)
        .and_then(|id| {
            let slicers = slicer_state.slicers.read().ok()?;
            slicers.get(&id).map(|s| s.is_model_slicer())
        });
    match slicer_is_model {
        Some(true) => model_list,
        Some(false) => BlankListing::PivotSlicer,
        None if request.bi_field_key.is_none() => BlankListing::Separate,
        None => model_list,
    }
}

/// Put `hidden` on whichever field carries cache column `idx` -- the zone
/// fields that show it, or else its slicer filter (added when missing). The
/// one host-side mask rule `apply_pivot_filter` and the page fold share.
///
/// `model_key` ("Table.Column", BI pivots) is stamped on the slicer filter so
/// it is identified by its column, never by the bare cache name.
fn set_hidden_items_at(
    definition: &mut PivotDefinition,
    idx: usize,
    hidden: Vec<String>,
    model_key: Option<&str>,
) {
    let mut found = false;
    for field in definition.row_fields.iter_mut().chain(definition.column_fields.iter_mut()) {
        if field.source_index == idx {
            field.hidden_items = hidden.clone();
            found = true;
        }
    }
    for filter in &mut definition.filter_fields {
        if filter.field.source_index == idx {
            filter.field.hidden_items = hidden.clone();
            found = true;
        }
    }
    if !found {
        if let Some(sf) = definition.slicer_filters.iter_mut().find(|sf| sf.source_index == idx) {
            sf.hidden_items = hidden;
            if sf.model_key.is_none() {
                sf.model_key = model_key.map(str::to_string);
            }
        } else {
            definition.slicer_filters.push(pivot_engine::SlicerFilter {
                source_index: idx,
                hidden_items: hidden,
                model_key: model_key.map(str::to_string),
            });
        }
    }
}

/// The current view of a pivot, rendered without touching the document (the
/// no-op answer of an ensure on an empty pivot or a clear of a column the
/// pivot does not carry).
fn current_pivot_view(pivot_state: &PivotState, pivot_id: PivotId) -> Result<PivotViewResponse, String> {
    let mut pivot_tables = pivot_state
        .pivot_tables
        .write(&pivot_render_effect())
        .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
    let view = safe_calculate_pivot(definition, cache);
    store_view(pivot_state, pivot_id, &view);
    Ok(view_to_response(&view, definition, cache))
}

/// Refresh a BI pivot's model snapshot (`model_tables`, `measures`,
/// `hierarchies`) from the LIVE engine.
///
/// The snapshot was written only at create, load and pull, while the Model
/// Editor edits the live model: a column or table added after the pivot
/// existed was listed by the slicer and ribbon-filter dialogs (they read the
/// live model) and then REFUSED by the apply ("not a column of this pivot's
/// model"), leaving a filter that showed a selection and filtered nothing.
/// Every key resolution below reads the snapshot, so it is brought up to date
/// first, under the connection's role so object-level security hides exactly
/// what it hides at create.
///
/// The snapshot mirrors the model, so it is written as a DERIVED cache: a
/// read path that refreshes it does not dirty the document. A connection with
/// no loaded engine (a reopened workbook before it reconnects) keeps the
/// saved snapshot.
pub(crate) async fn refresh_bi_model_snapshot(ctx: &PivotCmdCtx<'_>, pivot_id: PivotId) -> Result<(), String> {
    let connection_id = {
        let bi_meta = ctx.pivot_state.bi_metadata.read().map_err(|e| e.to_string())?;
        match bi_meta.get(&pivot_id) {
            Some(meta) => meta.connection_id,
            None => return Ok(()),
        }
    };
    let engine_arc = {
        let connections = ctx.bi_state.connections.lock().map_err(|e| e.to_string())?;
        match connections.get(&connection_id).and_then(|c| c.engine.clone()) {
            Some(engine) => engine,
            None => return Ok(()),
        }
    };
    let (model_tables, measures, hierarchies, _calc_groups, _perspectives, _cultures) = {
        let mut engine = engine_arc.lock().await;
        crate::bi::commands::apply_connection_role(&mut engine, ctx.bi_state, connection_id);
        extract_bi_model_metadata(&engine)
    };
    let derived = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::DerivedCache,
    );
    let mut bi_meta = ctx.pivot_state.bi_metadata.write(&derived).map_err(|e| e.to_string())?;
    if let Some(meta) = bi_meta.get_mut(&pivot_id) {
        meta.model_tables = model_tables;
        meta.measures = measures;
        meta.hierarchies = hierarchies;
    }
    Ok(())
}

/// Re-query a BI pivot from its stored definition (refresh), through the one
/// reconstruction that keeps everything the user set. Records the step the
/// way [`update_bi_pivot_fields_core`] does.
pub(crate) async fn refresh_bi_pivot_core(
    ctx: &PivotCmdCtx<'_>,
    pivot_id: PivotId,
) -> Result<PivotViewResponse, String> {
    let (mut response, undo) = refresh_bi_pivot_unrecorded(ctx, pivot_id, Vec::new()).await?;
    if ctx.record_undo {
        if let Some(undo) = undo {
            response.overwrite_token = undo.record(ctx.state, "Pivot table field change");
        }
    }
    Ok(response)
}

/// [`refresh_bi_pivot_core`] that hands its undo step back (see
/// [`update_bi_pivot_fields_unrecorded`]), applying `masks` to the fresh
/// records (see [`PostQueryMask`]; empty for a plain refresh).
///
/// A parameter rather than a wrapper: every async layer over the BI update
/// adds a copy of its (large) future to the polling thread's stack in a debug
/// build, and one extra layer overflowed a 2 MB test thread.
pub(crate) async fn refresh_bi_pivot_unrecorded(
    ctx: &PivotCmdCtx<'_>,
    pivot_id: PivotId,
    masks: Vec<PostQueryMask>,
) -> Result<(PivotViewResponse, Option<BiFieldChangeUndo>), String> {
    // The reconstruction resolves every slicer filter's model key against the
    // snapshot: a column added in the Model Editor must not be dropped here.
    refresh_bi_model_snapshot(ctx, pivot_id).await?;
    let bi_request = {
        let pivot_tables = ctx.pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
        let (definition, cache) = pivot_tables
            .get(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
        let bi_meta = ctx.pivot_state.bi_metadata.read().map_err(|e| e.to_string())?;
        let meta = bi_meta
            .get(&pivot_id)
            .ok_or_else(|| format!("No BI metadata for pivot {}", pivot_id))?;
        let mut request = bi_request_from_definition(pivot_id, definition, cache, meta);
        // A refresh exists to fetch fresh data — the identical-fields cosmetic
        // fast path must not swallow it.
        request.force_requery = true;
        request
    };
    log_info!(
        "CALP-DIAG",
        "refresh BI pivot {}: rows={}, cols={}, values={}, filters={}, slicer fields={}, hierarchies={}",
        pivot_id,
        bi_request.row_fields.len(),
        bi_request.column_fields.len(),
        bi_request.value_fields.len(),
        bi_request.filter_fields.len(),
        bi_request.slicer_fields.as_ref().map_or(0, |v| v.len()),
        bi_request.row_hierarchies.len() + bi_request.column_hierarchies.len()
    );
    update_bi_pivot_fields_unrecorded(ctx, bi_request, masks).await
}

/// Re-query BI pivots in the BACKGROUND, recording no undo step, then ask the
/// frontend to repaint. For a synchronous command (a sheet delete runs on the
/// main thread) whose edit changed a BI pivot's engine query -- a removed
/// slicer's pin -- and so left its cached records stale. Nothing to do for an
/// empty list.
pub(crate) fn spawn_quiet_bi_requery(app: tauri::AppHandle, pivots: Vec<PivotId>) {
    if pivots.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let file_state = app.state::<crate::persistence::FileState>();
        let pivot_state = app.state::<PivotState>();
        let pane_control_state = app.state::<crate::pane_control::PaneControlState>();
        let ribbon_filter_state = app.state::<crate::ribbon_filter::RibbonFilterState>();
        let user_files_state = app.state::<crate::persistence::UserFilesState>();
        let bi_state = app.state::<BiState>();
        let slicer_state = app.state::<crate::slicer::SlicerState>();
        let ctx = PivotCmdCtx {
            state: &state,
            file_state: &file_state,
            pivot_state: &pivot_state,
            pane_control_state: &pane_control_state,
            ribbon_filter_state: &ribbon_filter_state,
            user_files_state: &user_files_state,
            bi_state: &bi_state,
            slicer_state: &slicer_state,
            record_undo: false,
        };
        for pivot_id in pivots {
            if let Err(e) = refresh_bi_pivot_core(&ctx, pivot_id).await {
                crate::log_warn!("PIVOT", "background re-query of pivot {} failed: {}", pivot_id, e);
            }
        }
        let _ = app.emit("grid:refresh", ());
    });
}

/// The outcome of resolving a model column on a BI pivot for a filter.
enum EnsuredBiField {
    /// The pivot carries model column `table.column` at this cache index (now,
    /// if it was added).
    Index { idx: usize, table: String, column: String },
    /// The pivot has no fields at all; it was left untouched.
    EmptyPivot,
    /// The pivot does not carry the column and this write may not ADD it (a
    /// reconcile re-apply): it was left untouched.
    NotCarried,
}

/// What a filter write did that its CALLER must record, when the write ran in
/// a context that records nothing (`record_undo: false`): a GESTURE that runs
/// several writes quietly and records ONE step for all of them at the end
/// (`run_pivot_filter_gesture`, `delete_slicer_core`). Empty for a write that
/// recorded its own step -- except `ensure_token`, which names the step an
/// ensure recorded, for a response that names no step of its own.
#[derive(Default)]
pub(crate) struct FilterWriteKeep {
    /// The user's cells the write grew the pivot over (not recorded).
    pub overwritten: Vec<crate::pivot::operations::SavedCell>,
    /// The pivot's records from BEFORE the write REPLACED them (an ensure or a
    /// re-query); `None` when the records were left alone. The first
    /// replacement's wins: it is the records the gesture started from.
    pub pre_cache: Option<pivot_engine::PivotCache>,
    /// Column widths a re-query's auto-fit overwrote (the earliest per column).
    pub prev_col_widths: Vec<(u32, Option<f64>)>,
    /// Recording context only: the overwrite token of the step an ENSURE
    /// recorded (it re-queried and grew the pivot over the user's cells).
    ensure_token: Option<u64>,
}

impl FilterWriteKeep {
    /// Fold a later write's (or step's) unrecorded work into this one: cells
    /// accumulate, the FIRST pre-write records and widths win.
    pub(crate) fn absorb(&mut self, later: FilterWriteKeep) {
        self.overwritten.extend(later.overwritten);
        if self.pre_cache.is_none() {
            self.pre_cache = later.pre_cache;
        }
        for (col, width) in later.prev_col_widths {
            if !self.prev_col_widths.iter().any(|(c, _)| *c == col) {
                self.prev_col_widths.push((col, width));
            }
        }
        if self.ensure_token.is_none() {
            self.ensure_token = later.ensure_token;
        }
    }

    /// Fold in the step a BI field change handed back unrecorded.
    fn absorb_bi_undo(&mut self, undo: BiFieldChangeUndo) {
        self.absorb(FilterWriteKeep {
            overwritten: undo.overwritten_cells,
            pre_cache: undo.cache,
            prev_col_widths: undo.prev_col_widths,
            ensure_token: None,
        });
    }

    /// True when the write changed something its caller must record: it grew
    /// the pivot over the user's cells, or it replaced the pivot's records.
    pub(crate) fn needs_a_step(&self) -> bool {
        !self.overwritten.is_empty() || self.pre_cache.is_some()
    }
}

/// Resolve model column `key` on a BI pivot, ADDING it (as a slicer field)
/// when the pivot does not carry it yet: the server-side "ensure" that
/// replaces the three drifted frontend copies. The addition re-queries in this
/// command through [`bi_request_from_definition`], so nothing the pivot
/// already has is lost, and records ONE undo step (joining an open one) -- or,
/// in a context that records nothing, hands that step's content to `kept`.
///
/// `may_add: false` (a RECONCILE re-apply, BUG-0200): a column the pivot does
/// not carry is NOT added -- the pivot is left untouched (`NotCarried`). The
/// reconcile after an undo or redo re-derives the masks of a state the undo
/// already restored; adding a column there re-queried the model and changed
/// the pivot's shape with nothing recorded, so a step that had just REMOVED
/// the column came back with it (and a value written meanwhile into the area
/// the column vacated was overwritten with no undo).
async fn ensure_bi_field(
    ctx: &PivotCmdCtx<'_>,
    pivot_id: PivotId,
    key: &str,
    may_add: bool,
    kept: &mut FilterWriteKeep,
) -> Result<EnsuredBiField, String> {
    // Validate against the LIVE model, not the creation-time snapshot.
    refresh_bi_model_snapshot(ctx, pivot_id).await?;
    let (table, column, rebuild) = {
        let pivot_tables = ctx.pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
        let (definition, cache) = pivot_tables
            .get(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
        let bi_meta = ctx.pivot_state.bi_metadata.read().map_err(|e| e.to_string())?;
        let meta = bi_meta.get(&pivot_id).ok_or_else(|| {
            format!("biFieldKey '{key}' needs a BI model pivot; pivot {pivot_id} is not one")
        })?;
        let (table, column) = split_model_column_key(key, meta)?;
        if let Some(idx) = resolve_bi_field_index(definition, cache, meta, &table, &column) {
            return Ok(EnsuredBiField::Index { idx, table, column });
        }
        // The CURRENT CACHE may already carry the column although no field of
        // the definition names it: a level-1 Clear drops the column's slicer
        // filter but never re-queries, so the records still have it. Re-adding
        // it through the rebuild below re-queried the model and recorded a
        // "Pivot table field change" step -- which, on the slicer reconcile
        // that runs after an undo, CLEARED THE REDO STACK (the Clear could no
        // longer be redone) and left a step whose undo showed every region
        // while the slicer still showed its selection. The caller's local
        // path re-creates the slicer filter at this index instead.
        //
        // Identity: the column's STAMPED model key ("Table.Column", written
        // when the query built these records) is the authority, so a name
        // two tables share ("name" on Customers and Products) is re-used
        // exactly when the records hold THIS table's column. Only a column
        // with no key (records from before keys existed) falls back to its
        // name, and `bi_cache_name_matches` accepts a bare name only when
        // `table` is the ONE model table with such a column -- never a
        // guess. A value field's column is a measure, never the slicer's.
        let key_name = format!("{table}.{column}");
        let measure_columns: std::collections::HashSet<usize> =
            definition.value_fields.iter().map(|v| v.source_index).collect();
        if let Some(idx) = (0..cache.fields.len()).find(|&i| {
            !measure_columns.contains(&i)
                && match cache.fields[i].model_key.as_deref() {
                    Some(stamped) => stamped == key_name,
                    None => bi_cache_name_matches(&cache.fields[i].name, &table, &column, meta),
                }
        }) {
            return Ok(EnsuredBiField::Index { idx, table, column });
        }
        if pivot_has_no_fields(definition) {
            return Ok(EnsuredBiField::EmptyPivot);
        }
        if !may_add {
            return Ok(EnsuredBiField::NotCarried);
        }
        let mut rebuild = bi_request_from_definition(pivot_id, definition, cache, meta);
        rebuild.slicer_fields.get_or_insert_with(Vec::new).push(BiFieldRef {
            table: table.clone(),
            column: column.clone(),
            is_lookup: false,
            hidden_items: Some(Vec::new()),
        });
        rebuild.force_requery = true;
        (table, column, rebuild)
    };
    log_info!("PIVOT", "ensure BI field {}.{} on pivot {}", table, column, pivot_id);
    // The step the addition WOULD record, handed back: recorded here as ONE
    // "Pivot table field change" (joining an open transaction), or -- in a
    // context that records nothing -- kept for the caller's one step.
    let (_, undo) = Box::pin(update_bi_pivot_fields_unrecorded(ctx, rebuild, Vec::new())).await?;
    if let Some(undo) = undo {
        if ctx.record_undo {
            kept.ensure_token = undo.record(ctx.state, "Pivot table field change");
        } else {
            kept.absorb_bi_undo(undo);
        }
    }

    let pivot_tables = ctx.pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
    let (definition, cache) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
    let bi_meta = ctx.pivot_state.bi_metadata.read().map_err(|e| e.to_string())?;
    let meta = bi_meta
        .get(&pivot_id)
        .ok_or_else(|| format!("No BI metadata for pivot {}", pivot_id))?;
    match resolve_bi_field_index(definition, cache, meta, &table, &column) {
        Some(idx) => Ok(EnsuredBiField::Index { idx, table, column }),
        None => Err(format!("'{key}' could not be added to pivot {pivot_id}")),
    }
}

/// Where a refresh reads a GRID pivot's records from: a linked table's
/// CURRENT cells and sheet when the definition names a table that still
/// exists, else the recorded range on the recorded source sheet (resolved by
/// name against `sheet_names`; sheet 0 only for a definition that never
/// stored one).
///
/// ONE rule, read by [`refresh_pivot_cache`] and by the tests that pin what
/// the next refresh of a pivot reads. The table link is the stronger of the
/// two, which is why every door that sets a pivot's source must also decide
/// its link: Change Data Source once repointed a table-linked pivot at a
/// typed range and kept the link, so the next refresh -- and any table edit,
/// which refreshes every linked pivot -- silently read the table again.
///
/// Takes `table_names` and then `tables`: call it with no pivot guard held.
pub(crate) fn grid_refresh_source(
    state: &AppState,
    sheet_names: &[String],
    definition: &PivotDefinition,
) -> ((u32, u32), (u32, u32), usize) {
    if let Some(table_name) = definition.source_table_name.as_deref() {
        if let Some((start, end, sheet)) = linked_table_source(state, table_name) {
            log_info!(
                "PIVOT",
                "resolved table '{}' -> ({},{})..({},{}) on sheet {}",
                table_name, start.0, start.1, end.0, end.1, sheet
            );
            return (start, end, sheet);
        }
    }
    let sheet = definition
        .source_sheet
        .as_deref()
        .and_then(|name| index_of_sheet(sheet_names, name))
        .unwrap_or(0);
    (definition.source_start, definition.source_end, sheet)
}

/// Refreshes the pivot cache from current grid data
#[tauri::command]
pub async fn refresh_pivot_cache(
    window: tauri::Window,
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    pivot_id: PivotId,
) -> Result<PivotViewResponse, String> {
    // Refusal-first: verify the pivot exists BEFORE minting the eager `mutates`
    // token, so a refused command leaves the document clean.
    let effect = pivot_mutation_token(&state, &pivot_state, &file_state, pivot_id)?;

    log_info!("PIVOT", "refresh_pivot_cache pivot_id={}", pivot_id);

    let t_total = Instant::now();

    // Create cancellation token
    let token = CancellationToken::new();
    pivot_state.cancellation_tokens.lock().unwrap().insert(pivot_id, token.clone());

    // Check if this is a BI-backed pivot. BI pivots re-query the live database
    // via update_bi_pivot_fields rather than rebuilding from grid cells.
    let is_bi_pivot = pivot_state.bi_metadata.read().unwrap().contains_key(&pivot_id);

    if is_bi_pivot {
        log_info!("CALP-DIAG", "refresh_pivot_cache: BI pivot {} — re-querying live database", pivot_id);
        // The reconstruction lives in `bi_request_from_definition`, shared with
        // the server-side ensure; it keeps dimension hidden items and hierarchy
        // placements, which this in-line copy used to drop on every refresh.
        let ctx = PivotCmdCtx {
            state: &state,
            file_state: &file_state,
            pivot_state: &pivot_state,
            pane_control_state: &pane_control_state,
            ribbon_filter_state: &ribbon_filter_state,
            user_files_state: &user_files_state,
            bi_state: &bi_state,
            slicer_state: &slicer_state,
            record_undo: true,
        };
        return refresh_bi_pivot_core(&ctx, pivot_id).await;
    }

    // Snapshot sheet names BEFORE the pivot_tables lock — `delete_sheet` and
    // the calculation pass take sheet_names (and `delete_sheet` the table
    // stores) before pivot_tables, so nothing below reads a sheet or table
    // store while the pivot guard is held: the source sheet resolves against
    // this snapshot, and the destination and a linked table's range are
    // resolved after the guard is dropped.
    let sheet_names_snapshot = sheet_names_snapshot(&state);

    // 1. Lock briefly: read source info, build new cache from grid, release locks
    let (old_definition, old_cache, new_definition, new_cache, dest_sheet_idx, destination) = {
        let pivot_tables = pivot_state.pivot_tables.read().unwrap();
        let (definition, cache) = pivot_tables
            .get(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

        let destination = definition.destination;

        // Save old state for reversion on cancel
        let old_definition = definition.clone();
        let old_cache = cache.clone();
        pivot_state.previous_states.lock().unwrap()
            .insert(pivot_id, (old_definition.clone(), old_cache.clone()));

        {
            // Grid pivot: rebuild cache from source grid data
            let has_headers = definition.source_has_headers;

            drop(pivot_tables);
            // With the pivot guard released (see above): the destination, and
            // the source -- a linked table's current cells, else the recorded
            // range on the recorded sheet ([`grid_refresh_source`]).
            let dest_sheet_idx = resolve_dest_sheet_index(&state, &old_definition);
            let (source_start, mut source_end, source_sheet_idx) =
                grid_refresh_source(&state, &sheet_names_snapshot, &old_definition);

            // Get fresh data from grid (needs grids lock, but briefly)
            let grids = state.grids.read().unwrap();
            let grid = grids
                .get(source_sheet_idx)
                .ok_or_else(|| "Source sheet not found".to_string())?;

            // Clamp source_end row to grid's actual data extent (handles full-column refs)
            if source_end.0 > grid.max_row {
                source_end.0 = grid.max_row;
            }

            let (fresh_cache, _headers) = build_cache_from_grid(grid, source_start, source_end, has_headers)?;
            drop(grids);

            // Update stored cache + bump version
            let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
            let (definition, cache) = pivot_tables
                .get_mut(&pivot_id)
                .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

            *cache = fresh_cache;
            // Update stored source coordinates (may have changed if linked to a table)
            definition.source_start = source_start;
            definition.source_end = source_end;
            definition.bump_version();

            let new_def = definition.clone();
            let new_cache = cache.clone();
            (old_definition, old_cache, new_def, new_cache, dest_sheet_idx, destination)
        }
    };

    // 2. Emit progress: calculating (stage 2 of 4)
    emit_pivot_progress(&window, pivot_id, "Calculating...", 1, 4);

    // 3. Heavy computation on blocking thread pool
    let definition = new_definition;
    let mut cache = new_cache;
    let calc_result = tokio::task::spawn_blocking(move || {
        let t0 = Instant::now();
        let view = safe_calculate_pivot(&definition, &mut cache);
        let calc_ms = t0.elapsed().as_secs_f64() * 1000.0;
        (view, definition, cache, calc_ms)
    })
    .await
    .map_err(|e| format!("Pivot computation failed: {}", e))?;

    let (view, definition, mut cache, calc_ms) = calc_result;

    // Check cancellation after computation
    if token.is_cancelled() {
        log_info!("PIVOT", "refresh_pivot_cache pivot_id={} CANCELLED after calculation", pivot_id);
        {
            let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_definition;
                *c = old_cache;
            }
        }
        pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);
        return Err("Pivot operation cancelled".into());
    }

    // 4. Emit progress: preparing response (stage 3 of 4)
    emit_pivot_progress(&window, pivot_id, "Preparing response...", 2, 4);

    let t1 = Instant::now();
    let mut response = view_to_response(&view, &definition, &mut cache);
    let serialize_ms = t1.elapsed().as_secs_f64() * 1000.0;
    let framed = definition.canvas_frame.is_some();

    // 5. Put updated definition + cache back
    {
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
        if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
            *def = definition;
            *c = cache;
        }
    }

    // Store view for windowed cell fetching
    store_view(&pivot_state, pivot_id, &view);

    // 6. Emit progress: writing to grid (stage 4 of 4)
    emit_pivot_progress(&window, pivot_id, "Updating grid...", 3, 4);

    // Check cancellation before grid write
    if token.is_cancelled() {
        log_info!("PIVOT", "refresh_pivot_cache pivot_id={} CANCELLED before grid write", pivot_id);
        {
            let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_definition;
                *c = old_cache;
            }
        }
        pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);
        return Err("Pivot operation cancelled".into());
    }

    // Count overwritten cells before writing pivot to grid
    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);

    // The block the write is about to clear, for the recalculation seeds.
    let old_region = get_pivot_region(&state, pivot_id);

    // Update pivot in grid. A refusal (a destination of the wrong kind, or a
    // canvas pivot wider than its block) wrote nothing: put the definition back
    // exactly as a cancel does and skip the region.
    if let Err(refusal) = update_pivot_in_grid(&state, &effect, pivot_id, dest_sheet_idx, destination, &view, framed) {
        {
            let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_definition;
                *c = old_cache;
            }
        }
        pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);
        return Err(refusal);
    }

    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    // Recalculate formulas referencing pivot cells -- on every sheet
    recalc_after_pivot_write(
        &state,
        &pivot_state,
        Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }),
        dest_sheet_idx,
        old_region.as_ref(),
        destination,
        &view,
    );

    // Clean up cancellation token
    pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;

    log_perf!(
        "PIVOT",
        "refresh_pivot_cache pivot_id={} version={} rows={} | calc={:.1}ms serialize={:.1}ms TOTAL={:.1}ms",
        pivot_id,
        response.version,
        response.row_count,
        calc_ms,
        serialize_ms,
        total_ms
    );

    Ok(response)
}

/// The editor's Values zone for a pivot: one entry per value field, with what
/// the field already shows -- its number format and its Show Values As WITH the
/// base field and base item. The editor sends its whole Values zone back on
/// its next change and the update REPLACES the value fields, so a setting left
/// out here is cleared by the first edit after the editor reopens (found
/// 2026-09-29 while fixing e2e fixall-pivot X1: the base was never sent, and
/// had it been, a reopen would have dropped it again).
///
/// A calculation group renders M base measures as M*K value fields (one per
/// item), all sharing the base measure's `name`. The Values zone shows the K
/// base measures (the applied group is a separate control), so this emits one
/// entry per base measure and drops the item-specific custom_name.
pub(crate) fn value_zone_fields(
    definition: &pivot_engine::PivotDefinition,
    cache: &pivot_engine::PivotCache,
) -> Vec<ZoneFieldInfo> {
    use crate::pivot::utils::aggregation_to_string;
    // Show Values As names its base field; the candidates are the row and
    // column fields (resolve_base_field_indices searches the same two).
    let base_candidates: Vec<pivot_engine::PivotField> = definition.row_fields.iter()
        .chain(definition.column_fields.iter())
        .cloned()
        .collect();
    let mut seen_calc: std::collections::HashSet<String> = std::collections::HashSet::new();
    definition.value_fields.iter().filter_map(|f| {
        if f.calc_item.is_some() && !seen_calc.insert(f.name.clone()) {
            return None;
        }
        let is_numeric = cache.is_numeric_field(f.source_index);
        Some(ZoneFieldInfo {
            source_index: f.source_index,
            name: f.name.clone(),
            is_numeric,
            aggregation: Some(aggregation_to_string(f.aggregation)),
            is_lookup: false,
            hidden_items: None,
            custom_name: if f.calc_item.is_some() { None } else { f.custom_name.clone() },
            number_format: f.number_format.clone(),
            show_as: show_values_as_to_api(f, &base_candidates),
        })
    }).collect()
}

/// Check if a cell is within a pivot region and return pivot info if so
#[tauri::command]
pub fn get_pivot_at_cell(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    row: u32,
    col: u32,
) -> Result<Option<PivotRegionInfo>, String> {
    use crate::pivot::utils::{aggregation_to_string, report_layout_to_string, values_position_to_string};
    
    let active_sheet = *state.active_sheet.read().unwrap();
    
    // Check if cell is in any pivot region (via the generic protected region system)
    let pivot_id = match state.get_region_at_cell(active_sheet, row, col) {
        Some(region) if region.region_type == "pivot" => region.owner_id,
        _ => return Ok(None),
    };
    
    log_debug!("PIVOT", "get_pivot_at_cell ({},{}) found pivot_id={}", row, col, pivot_id);
    
    // Get pivot info
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let (definition, cache) = match pivot_tables.get(&pivot_id) {
        Some(t) => t,
        None => return Ok(None),
    };
    
    let is_empty = !has_fields_configured(definition);
    
    // Build source field info from cache
    let field_count = cache.field_count();
    let source_fields: Vec<SourceFieldInfo> = (0..field_count)
        .map(|i| {
            let name = cache.field_name(i).unwrap_or_else(|| format!("Field{}", i + 1));
            let is_numeric = cache.is_numeric_field(i);
            SourceFieldInfo {
                index: i,
                name,
                is_numeric,
                table_name: None,
            }
        })
        .collect();
    
    // Build current field configuration from definition. Row/column fields
    // carry their hidden_items too so a placed calculation group's item
    // subset survives an editor reopen.
    let row_fields: Vec<ZoneFieldInfo> = definition.row_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.source_index);
        ZoneFieldInfo {
            source_index: f.source_index,
            name: f.name.clone(),
            is_numeric,
            aggregation: None,
            is_lookup: f.is_attribute,
            hidden_items: if f.hidden_items.is_empty() { None } else { Some(f.hidden_items.clone()) },
            custom_name: None,
            number_format: None,
            show_as: None,
        }
    }).collect();

    let column_fields: Vec<ZoneFieldInfo> = definition.column_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.source_index);
        ZoneFieldInfo {
            source_index: f.source_index,
            name: f.name.clone(),
            is_numeric,
            aggregation: None,
            is_lookup: f.is_attribute,
            hidden_items: if f.hidden_items.is_empty() { None } else { Some(f.hidden_items.clone()) },
            custom_name: None,
            number_format: None,
            show_as: None,
        }
    }).collect();

    let value_fields = value_zone_fields(definition, cache);

    let filter_fields: Vec<ZoneFieldInfo> = definition.filter_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.field.source_index);
        let hidden = if f.field.hidden_items.is_empty() {
            None
        } else {
            Some(f.field.hidden_items.clone())
        };
        ZoneFieldInfo {
            source_index: f.field.source_index,
            name: f.field.name.clone(),
            is_numeric,
            aggregation: None,
            is_lookup: f.field.is_attribute,
            hidden_items: hidden,
            custom_name: None,
            number_format: None,
            show_as: None,
        }
    }).collect();
    
    let layout = LayoutConfig {
        show_row_grand_totals: Some(definition.layout.show_row_grand_totals),
        show_column_grand_totals: Some(definition.layout.show_column_grand_totals),
        report_layout: Some(report_layout_to_string(definition.layout.report_layout)),
        repeat_row_labels: Some(definition.layout.repeat_row_labels),
        show_empty_rows: Some(definition.layout.show_empty_rows),
        show_empty_cols: Some(definition.layout.show_empty_cols),
        values_position: Some(values_position_to_string(definition.layout.values_position)),
        auto_format: None,
        preserve_formatting: None,
        show_field_headers: None,
        enable_field_list: None,
        empty_cell_text: None,
        fill_empty_cells: None,
        subtotal_location: None,
        alt_text_title: None,
        alt_text_description: None,
        auto_fit_column_widths: Some(definition.layout.auto_fit_column_widths),
    };
    
    let calc_fields: Vec<CalculatedFieldDef> = definition.calculated_fields.iter().map(|cf| {
        CalculatedFieldDef {
            name: cf.name.clone(),
            formula: cf.formula.clone(),
            number_format: cf.number_format.clone(),
        }
    }).collect();

    let hierarchy_configs: Vec<HierarchyConfigInfo> = definition.hierarchy_configs
        .iter()
        .map(|hc| HierarchyConfigInfo {
            name: hc.name.clone(),
            field_start: hc.field_start,
            field_count: hc.field_count,
            is_row: hc.is_row,
        })
        .collect();

    let field_configuration = PivotFieldConfiguration {
        row_fields,
        column_fields,
        value_fields,
        filter_fields: filter_fields.clone(),
        layout,
        calculated_fields: calc_fields,
        hierarchy_configs,
    };

    // Calculate filter zones from filter field configuration
    // Filter fields are rendered at the top of the pivot:
    // Each filter field occupies one row with label in col 0 and dropdown in col 1
    let destination = definition.destination;
    let filter_zones: Vec<FilterZoneInfo> = filter_fields
        .iter()
        .enumerate()
        .map(|(idx, field)| FilterZoneInfo {
            row: destination.0 + idx as u32,      // Row relative to pivot start
            col: destination.1 + 1,               // Dropdown is in column 1 (after label)
            field_index: field.source_index,
            field_name: field.name.clone(),
        })
        .collect();

    // Check if this is a BI-backed pivot and populate bi_model
    let bi_model = {
        let bi_meta = pivot_state.bi_metadata.read().unwrap();
        bi_meta.get(&pivot_id).map(|meta| {
            log_info!(
                "CALP-DIAG",
                "get_pivot_at_cell: BI pivot_id={}, connection_id={}, {} tables, {} measures, row_fields={}, col_fields={}, val_fields={}",
                pivot_id,
                meta.connection_id,
                meta.model_tables.len(),
                meta.measures.len(),
                field_configuration.row_fields.len(),
                field_configuration.column_fields.len(),
                field_configuration.value_fields.len()
            );
            BiPivotModelInfo {
                connection_id: meta.connection_id,
                tables: meta.model_tables.clone(),
                measures: meta.measures.clone(),
                lookup_columns: meta.lookup_columns.iter().cloned().collect(),
                hierarchies: meta.hierarchies.clone(),
                calculation_groups: meta.calculation_groups.clone(),
                data_as_of: meta.data_as_of.clone(),
                perspectives: meta.perspectives.clone(),
                selected_perspective: meta.selected_perspective.clone(),
                cultures: meta.cultures.clone(),
                // The cache holds no model to read a strategy from.
                strategy: None,
            }
        })
    };

    // For BI pivots, filter out the synthetic "Total" row field
    // (it's an internal implementation detail, not a user-visible field)
    let field_configuration = if bi_model.is_some() {
        PivotFieldConfiguration {
            row_fields: field_configuration.row_fields.into_iter()
                .filter(|f| f.name != "Total")
                .collect(),
            ..field_configuration
        }
    } else {
        field_configuration
    };

    Ok(Some(PivotRegionInfo {
        pivot_id,
        is_empty,
        source_fields,
        field_configuration,
        filter_zones,
        bi_model,
        source_table_name: definition.source_table_name.clone(),
    }))
}

/// Resolve a grid cell into GETPIVOTDATA formula arguments.
/// Returns the data field name and field/item pairs for the cell.
#[tauri::command]
pub fn get_pivot_data_formula(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    row: u32,
    col: u32,
) -> Result<Option<super::types::GetPivotDataFormulaResult>, String> {
    let active_sheet = *state.active_sheet.read().unwrap();
    Ok(pivot_data_formula_at(&state, &pivot_state, active_sheet, row, col))
}

/// The body of [`get_pivot_data_formula`] for cell (`row`, `col`) of sheet
/// `sheet`, over plain references so a test can drive it.
pub(crate) fn pivot_data_formula_at(
    state: &AppState,
    pivot_state: &PivotState,
    sheet: usize,
    row: u32,
    col: u32,
) -> Option<super::types::GetPivotDataFormulaResult> {
    // The pivot whose region covers the cell ON THIS SHEET -- the one the
    // pick describes (another sheet's pivot can sit at the same address).
    let pivot_id = match state.get_region_at_cell(sheet, row, col) {
        Some(region) if region.region_type == "pivot" => region.owner_id,
        _ => return None,
    };

    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let pivot_views = pivot_state.views.lock().unwrap();

    crate::pivot::operations::resolve_pivot_data_formula(&pivot_tables, &pivot_views, pivot_id, row, col)
}

/// Get all pivot regions for the current sheet (for rendering placeholders)
#[tauri::command]
pub fn get_pivot_regions_for_sheet(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
) -> Vec<PivotRegionData> {
    let active_sheet = *state.active_sheet.read().unwrap();
    // LOCK ORDER: `pivot_tables` BEFORE `protected_regions` (see
    // `resolve_dest_sheet_index`, which reads the region under `pivot_tables`).
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let regions = state.protected_regions.lock().unwrap();

    regions
        .iter()
        .filter(|r| r.region_type == "pivot" && r.sheet_index == active_sheet)
        .map(|r| {
            let pid = r.owner_id;
            let (is_empty, name, canvas_frame) = pivot_tables
                .get(&pid)
                .map(|(def, _)| (
                    !has_fields_configured(def),
                    def.name.clone().unwrap_or_else(|| format!("PivotTable{}", pid)),
                    def.canvas_frame.map(CanvasFrameConfig::from),
                ))
                .unwrap_or_else(|| (true, format!("PivotTable{}", pid), None));

            PivotRegionData {
                pivot_id: pid,
                name,
                start_row: r.start_row,
                start_col: r.start_col,
                end_row: r.end_row,
                end_col: r.end_col,
                is_empty,
                // The frontend region sync reads the canvas pivot's box here.
                canvas_frame,
            }
        })
        .collect()
}

/// Get unique values for a pivot field (for filter dropdowns)
#[tauri::command]
pub fn get_pivot_field_unique_values(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    field_index: usize,
) -> Result<FieldUniqueValuesResponse, String> {
    pivot_field_unique_values_core(&pivot_state, pivot_id, field_index)
}

/// [`get_pivot_field_unique_values`] over a borrowed store.
///
/// A column with BLANK records lists the blank item LAST, as `(blank)` (wave
/// B, A2): Excel lists it in a pivot field's filter, and without it the
/// dropdown could neither show nor hide the blank rows.
pub(crate) fn pivot_field_unique_values_core(
    pivot_state: &PivotState,
    pivot_id: PivotId,
    field_index: usize,
) -> Result<FieldUniqueValuesResponse, String> {
    log_debug!(
        "PIVOT",
        "get_pivot_field_unique_values pivot_id={} field_index={}",
        pivot_id,
        field_index
    );

    let mut pivot_tables = pivot_state.pivot_tables.write(&pivot_render_effect()).unwrap();
    let (_, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
    let has_blank = field_index < cache.fields.len() && cache.has_blank_values(field_index);

    // Get field cache
    let field = cache.fields
        .get_mut(field_index)
        .ok_or_else(|| format!("Field index {} out of range", field_index))?;

    let field_name = field.name.clone();

    // A calculation-group field's dropdown offers the group's DECLARED items
    // (declaration order, from metadata): the cache column may carry only the
    // single applied item or the no-item sentinel, so cache uniques would be
    // wrong (canonical lock order pivot_tables -> bi_metadata).
    {
        let bi_meta = pivot_state.bi_metadata.read().unwrap();
        if let Some(meta) = bi_meta.get(&pivot_id) {
            if let Some(g) = meta.calculation_groups.iter().find(|g| g.name == field_name) {
                return Ok(FieldUniqueValuesResponse {
                    field_index,
                    field_name,
                    unique_values: g.items.iter().map(|i| i.name.clone()).collect(),
                });
            }
        }
    }

    // Collect unique values as strings
    // Clone sorted_ids to end the mutable borrow before calling get_value
    let sorted_ids = field.sorted_ids().to_vec();
    
    let mut unique_values: Vec<String> = sorted_ids
        .iter()
        .filter_map(|&id| {
            if id == VALUE_ID_EMPTY {
                return None;
            }
            field.get_value(id).map(|value| cache_value_to_string(value))
        })
        .collect();
    if has_blank {
        unique_values.push(pivot_engine::BLANK_ITEM_LABEL.to_string());
    }

    log_debug!(
        "PIVOT",
        "get_pivot_field_unique_values returning {} unique values for field '{}'",
        unique_values.len(),
        field_name
    );

    Ok(FieldUniqueValuesResponse {
        field_index,
        field_name,
        unique_values,
    })
}

// ============================================================================
// NEW EXCEL-COMPATIBLE COMMANDS
// ============================================================================

/// Gets pivot table properties and info.
#[tauri::command]
pub fn get_pivot_table_info(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<PivotTableInfo, String> {
    log_debug!("PIVOT", "get_pivot_table_info pivot_id={}", pivot_id);

    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let (definition, _) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let source_range = definition.source_range_display.clone()
        .unwrap_or_else(|| format_range(definition.source_start, definition.source_end));
    let destination = format_cell(definition.destination);

    Ok(PivotTableInfo {
        id: definition.id,
        name: definition.name.clone().unwrap_or_else(|| format!("PivotTable{}", pivot_id)),
        source_range,
        destination,
        allow_multiple_filters_per_field: definition.allow_multiple_filters_per_field,
        enable_data_value_editing: definition.enable_data_value_editing,
        refresh_on_open: definition.refresh_on_open,
        use_custom_sort_lists: definition.use_custom_sort_lists,
        has_headers: definition.source_has_headers,
        source_table_name: definition.source_table_name.clone(),
    })
}

/// Updates pivot table properties.
///
/// Also where a CANVAS pivot's box is moved or resized (`canvas_frame`): the
/// frame is definition-only -- the pivot's cells stay in their block, only the
/// window onto them moves -- so it rides this definition-only command rather
/// than a new one. Refused, before the effect, for a pivot with no frame (a
/// pivot never converts between grid and canvas) and for an invalid frame. A
/// frame change records ONE undo step ("Move pivot"), so Ctrl+Z puts the box
/// back.
#[tauri::command]
pub fn update_pivot_properties(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    request: UpdatePivotPropertiesRequest,
) -> Result<PivotTableInfo, String> {
    update_pivot_properties_core(&state, &file_state, &pivot_state, request)
}

/// [`update_pivot_properties`] over plain references, for the unit tier.
pub(crate) fn update_pivot_properties_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    pivot_state: &PivotState,
    request: UpdatePivotPropertiesRequest,
) -> Result<PivotTableInfo, String> {
    log_info!("PIVOT", "update_pivot_properties pivot_id={}", request.pivot_id);

    // A FRAME EDIT is decided before the effect: the pivot must already be a
    // canvas pivot, and the new frame must be valid. `pivot_tables` is taken
    // alone and released. Carries the definition as it was, for the undo step.
    let frame_edit: Option<(pivot_engine::CanvasFrame, PivotDefinition)> = match request.canvas_frame {
        None => None,
        Some(config) => {
            let before = {
                let tables = pivot_state
                    .pivot_tables
                    .read()
                    .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
                match tables.get(&request.pivot_id) {
                    Some((def, _)) => def.clone(),
                    None => return Err(format!("Pivot table {} not found", request.pivot_id)),
                }
            };
            if before.canvas_frame.is_none() {
                return Err(format!(
                    "Cannot set a canvas frame on pivot table {}: it is a worksheet pivot, and a \
                     pivot never converts between a worksheet and a canvas.",
                    request.pivot_id
                ));
            }
            let frame: pivot_engine::CanvasFrame = config.into();
            frame.validate()?;
            Some((frame, before))
        }
    };

    let (_effect, mut pivot_tables) = pivot_write_definition_only(pivot_state, file_state, request.pivot_id)?;
    let (definition, _) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Update properties
    if let Some(name) = request.name {
        definition.name = Some(name);
    }
    if let Some((frame, _)) = &frame_edit {
        definition.canvas_frame = Some(*frame);
    }
    if let Some(v) = request.allow_multiple_filters_per_field {
        definition.allow_multiple_filters_per_field = v;
    }
    if let Some(v) = request.enable_data_value_editing {
        definition.enable_data_value_editing = v;
    }
    if let Some(v) = request.refresh_on_open {
        definition.refresh_on_open = v;
    }
    if let Some(v) = request.use_custom_sort_lists {
        definition.use_custom_sort_lists = v;
    }

    let source_range = definition.source_range_display.clone()
        .unwrap_or_else(|| format_range(definition.source_start, definition.source_end));
    let destination = format_cell(definition.destination);

    let info = PivotTableInfo {
        id: definition.id,
        name: definition.name.clone().unwrap_or_else(|| format!("PivotTable{}", request.pivot_id)),
        source_range,
        destination,
        allow_multiple_filters_per_field: definition.allow_multiple_filters_per_field,
        enable_data_value_editing: definition.enable_data_value_editing,
        refresh_on_open: definition.refresh_on_open,
        use_custom_sort_lists: definition.use_custom_sort_lists,
        has_headers: definition.source_has_headers,
        source_table_name: definition.source_table_name.clone(),
    };
    drop(pivot_tables);

    // The box moved: ONE undo step that puts the definition -- and so the box --
    // back. The restore (`apply_pivot_definition_restore`) re-renders through
    // `finalize_pivot_update`, which is framed-aware. Recorded after the store
    // guard drops (the resolver must not run under it), and only when the frame
    // actually changed, so a no-op save of the same box adds no Ctrl+Z step.
    if let Some((frame, before)) = frame_edit {
        if before.canvas_frame != Some(frame) {
            let dest_sheet_idx = resolve_dest_sheet_index(state, &before);
            record_pivot_definition_undo(
                state,
                request.pivot_id,
                before,
                Vec::new(),
                dest_sheet_idx,
                Vec::new(),
                None,
                "Move pivot",
            );
        }
    }

    Ok(info)
}

/// Changes the source data range of an existing pivot table.
/// Parses the new range -- or resolves a table's name to the table's cells --
/// rebuilds the cache from the grid, and recalculates.
#[tauri::command]
pub async fn change_pivot_data_source(
    window: tauri::Window,
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: ChangePivotDataSourceRequest,
) -> Result<PivotViewResponse, String> {
    let pivot_id = request.pivot_id;
    let progress = |stage: &str, index: u32, total: u32| emit_pivot_progress(&window, pivot_id, stage, index, total);
    change_pivot_data_source_core(
        &state,
        &file_state,
        &pivot_state,
        PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state },
        &progress,
        request,
    )
}

/// The sheet Change Data Source reads its new range from (wave D fix-up, the
/// Change Data Source twin of BUG-0149). In order: the sheet the typed range
/// NAMES (`Sheet1!A1:C10`, `'Sales Data'!A:D`, matched ignoring case as sheet
/// names are), the request's explicit sheet, the pivot's OWN source sheet,
/// and only then the active sheet.
///
/// The dialog sends no sheet, and the command read the ACTIVE sheet: with the
/// pivot's own sheet active, `Sheet1!A1:C10` summarised that sheet's A1:C10
/// -- and the definition kept naming the old source sheet, so the next
/// refresh read yet another range. A sheet the range names that does not
/// exist is refused, never guessed.
pub(crate) fn change_source_sheet_index(
    sheet_names: &[String],
    typed_range: &str,
    requested: Option<usize>,
    current_source: Option<&str>,
    active: usize,
) -> Result<usize, String> {
    let find = |name: &str| {
        let wanted = name.to_lowercase();
        sheet_names.iter().position(|s| s.to_lowercase() == wanted)
    };
    if let Some(bang) = typed_range.rfind('!') {
        let raw = typed_range[..bang].trim();
        let name = match raw.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')) {
            Some(inner) => inner.replace("''", "'"),
            None => raw.to_string(),
        };
        if !name.is_empty() {
            return find(&name).ok_or_else(|| format!("There is no sheet named '{}' in this workbook.", name));
        }
    }
    if let Some(index) = requested {
        return if index < sheet_names.len() {
            Ok(index)
        } else {
            Err(format!("Sheet index {} not found", index))
        };
    }
    if let Some(index) = current_source.and_then(find) {
        return Ok(index);
    }
    Ok(active)
}

/// A table named as a Change Data Source source: its CURRENT cells, its sheet
/// and its own spelling (see [`change_source_table`]).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ChangeSourceTable {
    pub name: String,
    pub start: (u32, u32),
    pub end: (u32, u32),
    pub sheet_index: usize,
}

/// The table the Change Data Source text names, if it names one (wave E
/// fix-up). A table is named BARE -- `Table1`, any case, surrounding space
/// ignored -- as Excel's box shows a table source; anything else is a range.
/// The two cannot be confused: a range needs a `:` and a sheet prefix a `!`,
/// and no table name holds either (`tables::is_valid_table_name`).
///
/// The dialog pre-fills a table pivot's source as the table's NAME (the create
/// door records `source_range_display` = the table), and the door parsed it as
/// a cell range: OK without typing anything was refused with "Invalid range
/// format: 'Table1'". Takes `table_names` and then `tables`: call it with no
/// pivot guard held.
pub(crate) fn change_source_table(state: &AppState, typed: &str) -> Option<ChangeSourceTable> {
    let wanted = typed.trim();
    if wanted.is_empty() || wanted.contains(':') || wanted.contains('!') {
        return None;
    }
    let (sheet, table_id) = state.table_names.read().ok()?.get(&wanted.to_uppercase()).cloned()?;
    let tables = state.tables.read().ok()?;
    let table = tables.get(&sheet)?.get(&table_id)?;
    Some(ChangeSourceTable {
        name: table.name.clone(),
        start: (table.start_row, table.start_col),
        end: (table.end_row, table.end_col),
        sheet_index: table.sheet_index,
    })
}

/// [`change_pivot_data_source`] over borrowed states; `progress` reports the
/// stages (the command emits them as `pivot:progress`).
///
/// EVERY REFUSAL BEFORE THE EFFECT (wave D fix-up): the range is parsed, the
/// source sheet resolved ([`change_source_sheet_index`]) and a canvas source,
/// a data-model pivot and -- wave F, Z1 -- a range covering the pivot's own
/// output ([`check_change_source_excludes_own_output`], the create door's
/// source/destination gate on this door) refused before
/// `DocumentEffect::mutates`, so a refused change leaves the document clean.
/// (The token used to be minted first, so a mistyped range dirtied the
/// document.)
///
/// THE SOURCE AND ITS TABLE LINK ARE SET TOGETHER (wave E fix-up). A table's
/// name ([`change_source_table`]) reads the table's current cells on the
/// table's sheet and links the pivot to it; a range UNLINKS it. A refresh lets
/// a linked table's range win ([`grid_refresh_source`]), so a range typed over
/// a table pivot that kept its link applied, and the next refresh -- or any
/// table edit, which refreshes every linked pivot -- silently read the table
/// again while the source still showed the typed range.
pub(crate) fn change_pivot_data_source_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    pivot_state: &PivotState,
    recalc: PivotRecalcStates<'_>,
    progress: &dyn Fn(&str, u32, u32),
    request: ChangePivotDataSourceRequest,
) -> Result<PivotViewResponse, String> {
    let pivot_id = request.pivot_id;
    log_info!(
        "PIVOT",
        "change_pivot_data_source pivot_id={} new_range={}",
        pivot_id,
        request.source_range
    );

    // A table's name, else a range -- parsed before anything else is read.
    let table = change_source_table(state, &request.source_range);
    let (source_start, mut source_end) = match &table {
        Some(t) => (t.start, t.end),
        None => parse_range(&request.source_range)?,
    };

    // A data-model pivot's records come from its model, not from cells: a
    // range here would leave a model pivot whose cache was read off a sheet.
    if pivot_state.bi_metadata.read().map_err(|e| e.to_string())?.contains_key(&pivot_id) {
        return Err("This PivotTable is connected to a data model. Change its source in the Connections pane \
                    (Data > Connections), not as a cell range."
            .to_string());
    }
    let (current_source, has_headers, destination, dest_ref) = {
        let pivot_tables = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
        let (definition, _) =
            pivot_tables.get(&pivot_id).ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
        (
            definition.source_sheet.clone(),
            definition.source_has_headers,
            definition.destination,
            PivotDestSheet::of(definition),
        )
    };

    // The source sheet: a table's own; else the one the range names, else the
    // pivot's own.
    let active = *state.active_sheet.read().unwrap();
    let (source_sheet_idx, source_sheet_name) = {
        let sheet_names = state.sheet_names.read().unwrap();
        let index = match &table {
            Some(t) => t.sheet_index,
            None => change_source_sheet_index(
                &sheet_names,
                &request.source_range,
                request.source_sheet,
                current_source.as_deref(),
                active,
            )?,
        };
        let name = sheet_names
            .get(index)
            .cloned()
            .ok_or_else(|| format!("Sheet index {} not found", index))?;
        (index, name)
    };
    let source_is_canvas = {
        let kinds = state.sheet_kinds.read().unwrap();
        crate::sheets::is_canvas_sheet(&kinds, source_sheet_idx)
    };
    if source_is_canvas {
        return Err(format!(
            "Cannot read a pivot table's data from '{}': it is a canvas sheet, which holds no data. \
             Name the worksheet that holds the data.",
            source_sheet_name
        ));
    }

    // Build the new records from the grid -- still before anything is
    // written, so a range that yields no cache refuses with the pivot as it
    // was (the definition used to be repointed first and left pointing at a
    // range its records were never read from).
    let dest_sheet_idx = dest_ref.resolve(state);
    // The output the pivot holds now, read before the grid is (no guard held).
    let own_output = get_pivot_region(state, pivot_id);
    let fresh_cache = {
        let grids = state.grids.read().unwrap();
        let grid = grids
            .get(source_sheet_idx)
            .ok_or_else(|| format!("Sheet index {} not found", source_sheet_idx))?;

        // Clamp source_end to grid's actual data extent (handles full-column refs)
        if source_end.0 > grid.max_row {
            log_info!(
                "PIVOT",
                "clamping source end_row from {} to {} (grid.max_row)",
                source_end.0,
                grid.max_row
            );
            source_end.0 = grid.max_row;
        }

        // Refuse a range that covers the pivot's OWN output (wave F, Z1), as
        // the create door refuses a destination inside its source -- checked
        // after the clamp, like create, so `A:H` is judged by the rows it
        // reads. Before the effect: the document stays clean.
        check_change_source_excludes_own_output(
            source_sheet_idx,
            source_start,
            source_end,
            dest_sheet_idx,
            destination,
            own_output.as_ref(),
        )?;

        let (fresh_cache, _headers) = build_cache_from_grid(grid, source_start, source_end, has_headers)?;
        fresh_cache
    };

    // ...and the output it WILL hold may not cover the new range either
    // (BUG-0226). The gate above judges the output the pivot holds NOW, so a
    // range a few rows below a small pivot passed it, and the re-grown pivot
    // then wrote over its own new source. The new layout is calculated on
    // CLONES (the definition with the new range, the fresh records): nothing
    // stored moves before the refusal, and the post-calc cache stays clean.
    {
        let probe_definition = {
            let pivot_tables = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
            let (definition, _) =
                pivot_tables.get(&pivot_id).ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
            let mut probe = definition.clone();
            probe.source_start = source_start;
            probe.source_end = source_end;
            probe
        };
        let prospective = safe_calculate_pivot(&probe_definition, &mut fresh_cache.clone());
        check_pivot_extent_excludes_source(
            source_sheet_idx,
            source_start,
            source_end,
            dest_sheet_idx,
            destination,
            pivot_extent(&prospective),
            PivotExtentDoor::ChangeDataSource,
        )?;
    }

    // Refusal-first: verify the pivot exists BEFORE minting the eager `mutates`
    // token, so a refused command leaves the document clean.
    let effect = pivot_mutation_token(state, pivot_state, file_state, request.pivot_id)?;

    // Update the definition and store the new records -- ONE critical section.
    let (old_definition, old_cache, definition, cache) = {
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
        let (definition, existing_cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

        // BOTH HALVES ARE SNAPSHOTTED, and it has to be both: this command
        // rebuilds the cache from a different range, so undoing it with the old
        // definition alone would render that definition against the NEW records
        // — a view the user never saw. (BUG-0022.)
        let old_definition = definition.clone();
        let old_cache = existing_cache.clone();

        // Update source range in definition -- and the sheet it was read
        // from, which a refresh reads it from again -- and the table link
        // WITH it: a table's name links (and shows) the table, a range
        // unlinks, or the next refresh reads the old table instead.
        definition.source_start = source_start;
        definition.source_end = source_end;
        definition.source_sheet = Some(source_sheet_name);
        match table {
            Some(t) => {
                definition.source_range_display = Some(t.name.clone());
                definition.source_table_name = Some(t.name);
            }
            None => {
                definition.source_range_display = Some(request.source_range.clone());
                definition.source_table_name = None;
            }
        }
        definition.bump_version();
        *existing_cache = fresh_cache;

        (old_definition, old_cache, definition.clone(), existing_cache.clone())
    };

    // Recalculate pivot
    progress("Calculating...", 1, 4);
    let mut cache_mut = cache;
    let mut view = safe_calculate_pivot(&definition, &mut cache_mut);
    ensure_children_indices(&mut view);
    store_view(pivot_state, pivot_id, &view);

    // Write to grid. The cells the new (possibly larger) pivot is about to
    // overwrite are SAVED, not merely counted — undo has to put them back, and
    // a count cannot.
    progress("Updating grid...", 3, 4);
    let saved_cells = save_overwritten_cells(state, pivot_id, dest_sheet_idx, destination, &view);
    let overwritten = saved_cells.len() as u32;
    finalize_pivot_update(state, &effect, pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(recalc))?;

    // Store updated cache
    {
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
        if let Some((_def, cache)) = pivot_tables.get_mut(&pivot_id) {
            *cache = cache_mut;
        }
    }

    let mut final_cache = {
        let pivot_tables = pivot_state.pivot_tables.read().unwrap();
        let (_def, cache) = pivot_tables.get(&pivot_id).unwrap();
        cache.clone()
    };
    let mut response = view_to_response(&view, &definition, &mut final_cache);
    response.overwritten_cell_count = overwritten;

    // Repointing a pivot at a different range is ONE undoable action, recorded
    // after the work succeeded so a refusal leaves no stale entry (the shape
    // `update_pivot_fields` already uses).
    response.overwrite_token = record_pivot_definition_undo(
        &state,
        pivot_id,
        old_definition,
        saved_cells,
        dest_sheet_idx,
        // This path never auto-fits (`finalize_pivot_update` does not), so
        // there are no column widths riding along.
        Vec::new(),
        Some(old_cache),
        "Change pivot data source",
    );

    log_info!(
        "PIVOT",
        "change_pivot_data_source complete: pivot_id={} new_source={}:{} rows={}",
        pivot_id,
        format_cell(source_start),
        format_cell(source_end),
        response.row_count
    );

    Ok(response)
}

/// Gets pivot layout ranges (data body, row labels, column labels, filter axis).
#[tauri::command]
pub fn get_pivot_layout_ranges(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<PivotLayoutRanges, String> {
    log_debug!("PIVOT", "get_pivot_layout_ranges pivot_id={}", pivot_id);

    let mut pivot_tables = pivot_state.pivot_tables.write(&pivot_render_effect()).unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Calculate view to get accurate ranges
    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, pivot_id, &view);
    let (dest_row, dest_col) = definition.destination;

    // If view is empty, return empty ranges
    if view.row_count == 0 || view.col_count == 0 {
        return Ok(PivotLayoutRanges {
            range: None,
            data_body_range: None,
            column_label_range: None,
            row_label_range: None,
            filter_axis_range: None,
        });
    }

    // Full range (excluding filter area)
    let filter_rows = view.filter_row_count;
    let range_start_row = dest_row + filter_rows as u32;
    let range = Some(RangeInfo {
        start_row: range_start_row,
        start_col: dest_col,
        end_row: dest_row + view.row_count as u32 - 1,
        end_col: dest_col + view.col_count as u32 - 1,
        address: format_range(
            (range_start_row, dest_col),
            (dest_row + view.row_count as u32 - 1, dest_col + view.col_count as u32 - 1),
        ),
    });

    // Data body range (values only, after headers)
    let data_start_row = dest_row + filter_rows as u32 + view.column_header_row_count as u32;
    let data_start_col = dest_col + view.row_label_col_count as u32;
    let data_body_range = if view.row_count > view.column_header_row_count
        && view.col_count > view.row_label_col_count {
        Some(RangeInfo {
            start_row: data_start_row,
            start_col: data_start_col,
            end_row: dest_row + view.row_count as u32 - 1,
            end_col: dest_col + view.col_count as u32 - 1,
            address: format_range(
                (data_start_row, data_start_col),
                (dest_row + view.row_count as u32 - 1, dest_col + view.col_count as u32 - 1),
            ),
        })
    } else {
        None
    };

    // Column label range (header rows, data columns only)
    let column_label_range = if view.column_header_row_count > 0 && view.col_count > view.row_label_col_count {
        Some(RangeInfo {
            start_row: range_start_row,
            start_col: data_start_col,
            end_row: data_start_row - 1,
            end_col: dest_col + view.col_count as u32 - 1,
            address: format_range(
                (range_start_row, data_start_col),
                (data_start_row - 1, dest_col + view.col_count as u32 - 1),
            ),
        })
    } else {
        None
    };

    // Row label range (all data rows, label columns only)
    let row_label_range = if view.row_label_col_count > 0 && view.row_count > view.column_header_row_count {
        Some(RangeInfo {
            start_row: data_start_row,
            start_col: dest_col,
            end_row: dest_row + view.row_count as u32 - 1,
            end_col: data_start_col - 1,
            address: format_range(
                (data_start_row, dest_col),
                (dest_row + view.row_count as u32 - 1, data_start_col - 1),
            ),
        })
    } else {
        None
    };

    // Filter axis range
    let filter_axis_range = if filter_rows > 0 {
        Some(RangeInfo {
            start_row: dest_row,
            start_col: dest_col,
            end_row: dest_row + filter_rows as u32 - 1,
            end_col: dest_col + 1, // Label and dropdown columns
            address: format_range(
                (dest_row, dest_col),
                (dest_row + filter_rows as u32 - 1, dest_col + 1),
            ),
        })
    } else {
        None
    };

    Ok(PivotLayoutRanges {
        range,
        data_body_range,
        column_label_range,
        row_label_range,
        filter_axis_range,
    })
}

/// Updates pivot layout properties.
#[tauri::command]
pub fn update_pivot_layout(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: UpdatePivotLayoutRequest,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "update_pivot_layout pivot_id={}", request.pivot_id);

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Apply layout configuration
    apply_layout_config(&mut definition.layout, &request.layout);

    // Apply new Excel-compatible layout properties
    if let Some(v) = request.layout.auto_format {
        definition.layout.auto_format = v;
    }
    if let Some(v) = request.layout.preserve_formatting {
        definition.layout.preserve_formatting = v;
    }
    if let Some(v) = request.layout.show_field_headers {
        definition.layout.show_field_headers = v;
    }
    if let Some(v) = request.layout.enable_field_list {
        definition.layout.enable_field_list = v;
    }
    if let Some(ref text) = request.layout.empty_cell_text {
        definition.layout.empty_cell_text = Some(text.clone());
    }
    if let Some(v) = request.layout.fill_empty_cells {
        definition.layout.fill_empty_cells = v;
    }
    if let Some(ref title) = request.layout.alt_text_title {
        definition.layout.alt_text_title = Some(title.clone());
    }
    if let Some(ref desc) = request.layout.alt_text_description {
        definition.layout.alt_text_description = Some(desc.clone());
    }
    if let Some(ref loc) = request.layout.subtotal_location {
        definition.layout.subtotal_location = api_subtotal_location_to_engine(loc);
    }

    // Bump version
    definition.bump_version();

    // Recalculate view
    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    // Get destination info
    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    // Update pivot in grid
    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Gets all hierarchies info for a pivot table.
#[tauri::command]
pub fn get_pivot_hierarchies(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<PivotHierarchiesInfo, String> {
    log_debug!("PIVOT", "get_pivot_hierarchies pivot_id={}", pivot_id);

    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let (definition, cache) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Build source field info from cache
    let field_count = cache.field_count();
    let hierarchies: Vec<SourceFieldInfo> = (0..field_count)
        .map(|i| {
            let name = cache.field_name(i).unwrap_or_else(|| format!("Field{}", i + 1));
            let is_numeric = cache.is_numeric_field(i);
            SourceFieldInfo {
                index: i,
                name,
                is_numeric,
                table_name: None,
            }
        })
        .collect();

    // Row hierarchies
    let row_hierarchies: Vec<RowColumnHierarchyInfo> = definition.row_fields
        .iter()
        .enumerate()
        .map(|(pos, f)| RowColumnHierarchyInfo {
            id: f.source_index,
            name: f.name.clone(),
            field_index: f.source_index,
            position: pos,
        })
        .collect();

    // Column hierarchies
    let column_hierarchies: Vec<RowColumnHierarchyInfo> = definition.column_fields
        .iter()
        .enumerate()
        .map(|(pos, f)| RowColumnHierarchyInfo {
            id: f.source_index,
            name: f.name.clone(),
            field_index: f.source_index,
            position: pos,
        })
        .collect();

    // Collect all pivot fields for base_field name resolution
    let all_fields: Vec<pivot_engine::PivotField> = definition.row_fields.iter()
        .chain(definition.column_fields.iter())
        .chain(definition.filter_fields.iter().map(|f| &f.field))
        .cloned()
        .collect();

    // Data hierarchies
    let data_hierarchies: Vec<DataHierarchyInfo> = definition.value_fields
        .iter()
        .enumerate()
        .map(|(pos, f)| DataHierarchyInfo {
            id: f.source_index,
            name: f.name.clone(),
            field_index: f.source_index,
            summarize_by: aggregation_type_to_api(f.aggregation),
            number_format: f.number_format.clone(),
            position: pos,
            show_as: show_values_as_to_api(f, &all_fields),
        })
        .collect();

    // Filter hierarchies
    let filter_hierarchies: Vec<RowColumnHierarchyInfo> = definition.filter_fields
        .iter()
        .enumerate()
        .map(|(pos, f)| RowColumnHierarchyInfo {
            id: f.field.source_index,
            name: f.field.name.clone(),
            field_index: f.field.source_index,
            position: pos,
        })
        .collect();

    // Check if this is a BI-backed pivot and include bi_model
    let bi_model = {
        let bi_meta = pivot_state.bi_metadata.read().unwrap();
        bi_meta.get(&pivot_id).map(|meta| {
            BiPivotModelInfo {
                connection_id: meta.connection_id,
                tables: meta.model_tables.clone(),
                measures: meta.measures.clone(),
                lookup_columns: meta.lookup_columns.iter().cloned().collect(),
                hierarchies: meta.hierarchies.clone(),
                calculation_groups: meta.calculation_groups.clone(),
                data_as_of: meta.data_as_of.clone(),
                perspectives: meta.perspectives.clone(),
                selected_perspective: meta.selected_perspective.clone(),
                cultures: meta.cultures.clone(),
                // The cache holds no model to read a strategy from.
                strategy: None,
            }
        })
    };

    // Slicer filter field names (resolve source_index to name from cache)
    let slicer_filter_fields: Vec<String> = definition.slicer_filters.iter()
        .filter_map(|sf| {
            cache.field_name(sf.source_index).map(|name| {
                // If the cache field name is bare "column", try to resolve
                // to "table.column" using the definition field names as reference.
                if !name.contains('.') {
                    // Search all definition fields for one that ends with this column name
                    let all_def_names: Vec<&str> = definition.row_fields.iter()
                        .chain(definition.column_fields.iter())
                        .chain(definition.filter_fields.iter().map(|f| &f.field))
                        .map(|f| f.name.as_str())
                        .collect();
                    // Check if the column belongs to any known table in BI metadata
                    let bi_meta = pivot_state.bi_metadata.read().unwrap();
                    if let Some(meta) = bi_meta.get(&pivot_id) {
                        for t in &meta.model_tables {
                            if t.columns.iter().any(|c| c.name == name) {
                                return format!("{}.{}", t.name, name);
                            }
                        }
                    }
                    // If we can't find the table, check if any definition field has
                    // this column name as a suffix
                    for def_name in &all_def_names {
                        if def_name.ends_with(&format!(".{}", name)) {
                            return def_name.to_string();
                        }
                    }
                }
                name
            })
        })
        .collect();

    Ok(PivotHierarchiesInfo {
        hierarchies,
        row_hierarchies,
        column_hierarchies,
        data_hierarchies,
        filter_hierarchies,
        slicer_filter_fields,
        bi_model,
    })
}

/// Adds a field to a hierarchy (row, column, data, or filter).
#[tauri::command]
pub fn add_pivot_hierarchy(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: AddHierarchyRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "add_pivot_hierarchy pivot_id={} field={} axis={:?}",
        request.pivot_id,
        request.field_index,
        request.axis
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Get field name from cache
    let field_name = request.name.clone()
        .or_else(|| cache.field_name(request.field_index))
        .unwrap_or_else(|| format!("Field{}", request.field_index + 1));

    match request.axis {
        PivotAxis::Row => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let position = request.position.unwrap_or(definition.row_fields.len());
            if position <= definition.row_fields.len() {
                definition.row_fields.insert(position, field);
            } else {
                definition.row_fields.push(field);
            }
        }
        PivotAxis::Column => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let position = request.position.unwrap_or(definition.column_fields.len());
            if position <= definition.column_fields.len() {
                definition.column_fields.insert(position, field);
            } else {
                definition.column_fields.push(field);
            }
        }
        PivotAxis::Data => {
            let aggregation = request.aggregation
                .map(api_to_aggregation_type)
                .unwrap_or(pivot_engine::AggregationType::Sum);
            let field = pivot_engine::ValueField::new(request.field_index, field_name, aggregation);
            let position = request.position.unwrap_or(definition.value_fields.len());
            if position <= definition.value_fields.len() {
                definition.value_fields.insert(position, field);
            } else {
                definition.value_fields.push(field);
            }
        }
        PivotAxis::Filter => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let filter = pivot_engine::PivotFilter {
                field,
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            };
            let position = request.position.unwrap_or(definition.filter_fields.len());
            if position <= definition.filter_fields.len() {
                definition.filter_fields.insert(position, filter);
            } else {
                definition.filter_fields.push(filter);
            }
        }
        PivotAxis::Unknown => {
            return Err("Cannot add to Unknown axis".to_string());
        }
    }

    definition.bump_version();

    // Recalculate view
    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Removes a field from a hierarchy.
#[tauri::command]
pub fn remove_pivot_hierarchy(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: RemoveHierarchyRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "remove_pivot_hierarchy pivot_id={} axis={:?} pos={}",
        request.pivot_id,
        request.axis,
        request.position
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    match request.axis {
        PivotAxis::Row => {
            if request.position < definition.row_fields.len() {
                definition.row_fields.remove(request.position);
            } else {
                return Err(format!("Position {} out of range for row fields", request.position));
            }
        }
        PivotAxis::Column => {
            if request.position < definition.column_fields.len() {
                definition.column_fields.remove(request.position);
            } else {
                return Err(format!("Position {} out of range for column fields", request.position));
            }
        }
        PivotAxis::Data => {
            if request.position < definition.value_fields.len() {
                definition.value_fields.remove(request.position);
            } else {
                return Err(format!("Position {} out of range for value fields", request.position));
            }
        }
        PivotAxis::Filter => {
            if request.position < definition.filter_fields.len() {
                definition.filter_fields.remove(request.position);
            } else {
                return Err(format!("Position {} out of range for filter fields", request.position));
            }
        }
        PivotAxis::Unknown => {
            return Err("Cannot remove from Unknown axis".to_string());
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Moves a field between hierarchies.
#[tauri::command]
pub fn move_pivot_field(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: MoveFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "move_pivot_field pivot_id={} field={} target={:?}",
        request.pivot_id,
        request.field_index,
        request.target_axis
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Find and remove field from its current location
    let mut field_name = String::new();
    let mut found = false;

    // Check row fields
    if let Some(pos) = definition.row_fields.iter().position(|f| f.source_index == request.field_index) {
        field_name = definition.row_fields[pos].name.clone();
        definition.row_fields.remove(pos);
        found = true;
    }
    // Check column fields
    if !found {
        if let Some(pos) = definition.column_fields.iter().position(|f| f.source_index == request.field_index) {
            field_name = definition.column_fields[pos].name.clone();
            definition.column_fields.remove(pos);
            found = true;
        }
    }
    // Check value fields
    if !found {
        if let Some(pos) = definition.value_fields.iter().position(|f| f.source_index == request.field_index) {
            field_name = definition.value_fields[pos].name.clone();
            definition.value_fields.remove(pos);
            found = true;
        }
    }
    // Check filter fields
    if !found {
        if let Some(pos) = definition.filter_fields.iter().position(|f| f.field.source_index == request.field_index) {
            field_name = definition.filter_fields[pos].field.name.clone();
            definition.filter_fields.remove(pos);
            found = true;
        }
    }

    // If not found, get name from cache
    if !found {
        field_name = cache.field_name(request.field_index)
            .unwrap_or_else(|| format!("Field{}", request.field_index + 1));
    }

    // Add to target axis
    match request.target_axis {
        PivotAxis::Row => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let position = request.position.unwrap_or(definition.row_fields.len());
            if position <= definition.row_fields.len() {
                definition.row_fields.insert(position, field);
            } else {
                definition.row_fields.push(field);
            }
        }
        PivotAxis::Column => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let position = request.position.unwrap_or(definition.column_fields.len());
            if position <= definition.column_fields.len() {
                definition.column_fields.insert(position, field);
            } else {
                definition.column_fields.push(field);
            }
        }
        PivotAxis::Data => {
            let field = pivot_engine::ValueField::new(
                request.field_index,
                field_name,
                pivot_engine::AggregationType::Sum,
            );
            let position = request.position.unwrap_or(definition.value_fields.len());
            if position <= definition.value_fields.len() {
                definition.value_fields.insert(position, field);
            } else {
                definition.value_fields.push(field);
            }
        }
        PivotAxis::Filter => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let filter = pivot_engine::PivotFilter {
                field,
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            };
            let position = request.position.unwrap_or(definition.filter_fields.len());
            if position <= definition.filter_fields.len() {
                definition.filter_fields.insert(position, filter);
            } else {
                definition.filter_fields.push(filter);
            }
        }
        PivotAxis::Unknown => {
            // Just remove from all hierarchies, don't add anywhere
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Sets the aggregation function for a value field.
#[tauri::command]
pub fn set_pivot_aggregation(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: SetAggregationRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "set_pivot_aggregation pivot_id={} field={} func={:?}",
        request.pivot_id,
        request.value_field_index,
        request.summarize_by
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    if request.value_field_index >= definition.value_fields.len() {
        return Err(format!(
            "Value field index {} out of range (max {})",
            request.value_field_index,
            definition.value_fields.len().saturating_sub(1)
        ));
    }

    definition.value_fields[request.value_field_index].aggregation =
        api_to_aggregation_type(request.summarize_by);

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Sets the number format for a value field.
#[tauri::command]
pub fn set_pivot_number_format(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: SetNumberFormatRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "set_pivot_number_format pivot_id={} field={} format={}",
        request.pivot_id,
        request.value_field_index,
        request.number_format
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    if request.value_field_index >= definition.value_fields.len() {
        return Err(format!(
            "Value field index {} out of range",
            request.value_field_index
        ));
    }

    definition.value_fields[request.value_field_index].number_format =
        Some(request.number_format);

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Applies a filter to a pivot field.
///
/// `biFieldKey` (BI pivots): the backend resolves the model column itself and,
/// when the pivot does not carry it yet, adds it in this same command (see
/// [`ApplyPivotFilterRequest::bi_field_key`]). A host-side (level-1) mask
/// records no undo step -- a slicer click's undo is its slicer selection,
/// re-derived by the Slicer's reconcile -- while an ENSURE records exactly
/// one, because it changed the query and the cache. So does a filter that
/// changes the ENGINE QUERY (a pin, a calculation group): its step restores
/// the definition and records from before the edit (`requery_filter_change`).
/// A column the pivot's current records already carry is re-used, never
/// re-added, so the reconcile after an undo records nothing.
///
/// THE EXCEPTION TO "A MASK RECORDS NOTHING" (fix round 5): a level-1 mask
/// that grows a WORKSHEET pivot over the user's cells records ONE step -- the
/// pre-filter definition and the cells it overwrote -- joining the caller's
/// open transaction (a slicer click's) or as a step of its own (the header
/// dropdown). Without it those cells were gone for good: nothing had a copy,
/// and the dropdown's Cancel popped whatever unrelated step was on top. The
/// response carries the step's `overwrite_token`, which is what a Cancel
/// hands back. A `reconcile` request (the Slicer's re-apply after an undo or
/// redo) records NOTHING, overwrite or not: a step recorded there would wipe
/// the redo stack.
#[tauri::command]
pub async fn apply_pivot_filter(
    _window: tauri::Window,
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    request: ApplyPivotFilterRequest,
) -> Result<PivotViewResponse, String> {
    let ctx = PivotCmdCtx {
        state: &state,
        file_state: &file_state,
        pivot_state: &pivot_state,
        pane_control_state: &pane_control_state,
        ribbon_filter_state: &ribbon_filter_state,
        user_files_state: &user_files_state,
        bi_state: &bi_state,
        slicer_state: &slicer_state,
        record_undo: true,
    };
    apply_pivot_filter_core(&ctx, request).await
}

/// [`apply_pivot_filter`] over borrowed state.
pub(crate) async fn apply_pivot_filter_core(
    ctx: &PivotCmdCtx<'_>,
    request: ApplyPivotFilterRequest,
) -> Result<PivotViewResponse, String> {
    // Boxed: the write can await a BI re-query whose future is large, and a
    // debug build copies every layer of it onto the polling thread's stack.
    Box::pin(apply_pivot_filter_core_keeping(ctx, request)).await.map(|(response, _)| response)
}

/// [`apply_pivot_filter_core`] that also hands back what the write would have
/// recorded and did NOT (see [`FilterWriteKeep`]): non-empty only in a context
/// that records nothing, whose caller records ONE step for its whole gesture
/// (`run_pivot_filter_gesture`).
///
/// A `reconcile` apply never ADDS a column the pivot does not carry (see
/// [`ensure_bi_field`]'s `may_add`): it answers with the current view.
pub(crate) async fn apply_pivot_filter_core_keeping(
    ctx: &PivotCmdCtx<'_>,
    request: ApplyPivotFilterRequest,
) -> Result<(PivotViewResponse, FilterWriteKeep), String> {
    // The reconcile's re-apply records nothing anywhere below: the ensure,
    // the re-query and the overwrite step all read `ctx.record_undo`.
    let quiet;
    let ctx: &PivotCmdCtx<'_> = if request.reconcile {
        quiet = PivotCmdCtx { record_undo: false, ..*ctx };
        &quiet
    } else {
        ctx
    };
    // IN FLIGHT until this returns, when it RECORDS (W4): an ensure, a pin
    // or an overwrite pushes its step at the END, after awaits that can take
    // seconds (the model snapshot, the ensure and the pin re-queries). An undo
    // or redo meanwhile would take back the step BEFORE this one, and this
    // step would then land on top of it -- clearing that undo's redo and
    // leaving the slicer or header dropdown that drove the filter disagreeing
    // with the pivot. So it is counted like a slicer click
    // (`undo_commands::history_move_refusal`). A context that records nothing
    // (a gesture's own writes -- the gesture is counted -- and every
    // RECONCILE, which runs right after an undo and must not refuse the next
    // Ctrl+Z) is not.
    let _in_flight = ctx.record_undo.then(|| crate::undo_commands::PendingGesture::begin(ctx.state));
    let state = ctx.state;
    let file_state = ctx.file_state;
    let pivot_state = ctx.pivot_state;
    let mut kept = FilterWriteKeep::default();
    // Whether the level-1 selection may hide the blank item (its list offered
    // one) -- read before any pivot lock is taken.
    let blank_listed = selection_list_blank_listing(ctx.slicer_state, &request);

    // A PINNED apply's refusals that need nothing but the request, before
    // anything at all is written -- the ensure below can ADD a column to the
    // pivot, and a refused pin must not leave that behind either.
    if request.filter_level >= 2 {
        crate::slicer::types::validate_filter_level(request.filter_level)?;
        if request.filters.manual_filter.is_none() {
            return Err(pinned_needs_an_item_selection());
        }
    }

    // Resolve the field. A BI key is resolved -- and, when missing, ADDED --
    // on the server, from the stored definition; every refusal (not a BI
    // pivot, not a model column) happens before anything is written.
    // `model_column`: the (table, column) the filter is on, when the caller
    // named it -- the authority for which slicer filter and which pin this is
    // (a bare cache name can belong to two tables).
    let (field_index, model_column): (usize, Option<(String, String)>) = match request.bi_field_key.as_deref() {
        Some(key) => match ensure_bi_field(ctx, request.pivot_id, key, !request.reconcile, &mut kept).await? {
            EnsuredBiField::Index { idx, table, column } => (idx, Some((table, column))),
            EnsuredBiField::EmptyPivot => {
                log_info!(
                    "PIVOT",
                    "apply_pivot_filter pivot_id={} key={}: the pivot has no fields; left untouched",
                    request.pivot_id,
                    key
                );
                return current_pivot_view(pivot_state, request.pivot_id).map(|r| (r, kept));
            }
            EnsuredBiField::NotCarried => {
                log_info!(
                    "PIVOT",
                    "apply_pivot_filter pivot_id={} key={}: a reconcile never adds a column; left untouched",
                    request.pivot_id,
                    key
                );
                return current_pivot_view(pivot_state, request.pivot_id).map(|r| (r, kept));
            }
        },
        None => (
            request
                .field_index
                .ok_or_else(|| "apply_pivot_filter needs a fieldIndex or a biFieldKey".to_string())?,
            None,
        ),
    };

    log_info!(
        "PIVOT",
        "apply_pivot_filter pivot_id={} field={}",
        request.pivot_id,
        field_index
    );

    // BUG-0108 ROUTING IS BUILT BUT DELIBERATELY NOT WIRED HERE.
    //
    // `crate::pivot::mask_safety` decides correctly which pivots cannot survive
    // host-side masking, and sending an ordinary slicer down the pin path below
    // does fix the filed denominator defect. An adversarial pass on 2026-09-13
    // found it regresses more than it repairs, so the call is ABSENT rather
    // than disabled behind a flag — a flag would be a second, untested
    // configuration of a path we already know is wrong.
    //
    // The decisive blocker: a COMPOUND measure whose `RESET`/`CLEAR` must remove
    // a request filter is a TYPED REFUSAL in the engine, pinned by its own test
    // `reset_with_slicer_on_cleared_table_fails_closed`
    // (model-engine-lib/crates/engine/src/clear_reset_tests.rs). Routing would
    // turn today's CORRECT percent-of-grand-total answers into a hard query
    // error on an ordinary slicer click. Eight further blockers — the slicer's
    // own value domain collapsing, the header dropdown then reporting "not
    // filtered", bare-column-name mis-attribution, YTD truncation, boolean and
    // float value spelling, a refused query leaving the filter persisted, the
    // 24-grain totals cap, and undo not undoing the routed filter — are listed
    // with citations in docs/design/open-items.md under BUG-0108.

    // EVERY REFUSAL OF A PINNED APPLY, BEFORE THE EFFECT (fix round 4, B5).
    // `pivot_write` mints the document-modified token, and these used to run
    // after it, under the write guard -- so a refused pin (not a BI pivot, an
    // unknown field index, a column no single model table owns) marked the
    // document changed when nothing had. Read guards only; the same checks
    // stay under the write guard below, where they can now fire only if the
    // pivot changed in between.
    if request.filter_level >= 2 {
        refuse_an_unroutable_pin(pivot_state, request.pivot_id, field_index, model_column.clone())?;
    }

    // All lock-holding work happens in this block so no guard can live across
    // the await below (the Tauri command future must be Send).
    // `Requery` = the edit changed the ENGINE QUERY (a calculation group's
    // item state, a pin added, replaced or dropped) and needs a BI re-query;
    // `Local(response)` = handled here.
    let step: FilterStep = {
        let (effect, mut pivot_tables) = pivot_write(state, pivot_state, file_state, request.pivot_id)?;
        let (definition, cache) = pivot_tables
            .get_mut(&request.pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;
        // The definition BEFORE this edit: the undo step of a re-query must
        // restore it (see `requery_filter_change`), and the destination sheet
        // is resolved from it once the pivot lock is released.
        let pre_definition = definition.clone();

        // A calculation-group field (BI pivots): its item selection decides
        // whether an item is APPLIED at all (PBI/AS semantics: one visible
        // item applies it; zero/many apply none), so a selection change needs
        // a BI re-query — and its "all values" list comes from the group's
        // declared items, not cache uniques (canonical lock order
        // pivot_tables -> bi_metadata).
        let (field_name, calc_group_items, model_column) = {
            let bi_meta = pivot_state.bi_metadata.read().unwrap();
            filter_field_target(cache, bi_meta.get(&request.pivot_id), field_index, model_column.clone())
        };
        let model_key: Option<String> = model_column.as_ref().map(|(t, c)| format!("{t}.{c}"));

        // PINNED (level >= 2) filters on BI pivots are routed INSIDE the
        // engine query as level-tagged IN-lists (`engine_filters` →
        // `scoped_in_filters`) instead of host-side hidden_items masks, so
        // measure CLEAR/RESET semantics honor them: a pin survives bare
        // clears and is stripped only by `CLEAR(…, LEVEL n)` at or above its
        // level. Origin-preserving: the owning slicer id is carried along.
        //
        // ORDINARY (level-1) filtering does NOT come down here — see the
        // "built but deliberately not wired" note at the top of this command
        // for why routing it would regress more than it repairs.
        let pinned_routed: bool = if request.filter_level >= 2 {
            // Every refusal below already ran BEFORE the effect
            // (`refuse_an_unroutable_pin`, and the request checks at the top);
            // re-checked here against the pivot as the write guard sees it.
            crate::slicer::types::validate_filter_level(request.filter_level)?;
            let Some(ref manual) = request.filters.manual_filter else {
                return Err(pinned_needs_an_item_selection());
            };
            if !pivot_state.bi_metadata.read().unwrap().contains_key(&request.pivot_id) {
                return Err(pinned_needs_a_model_pivot());
            }
            let name = field_name.clone().ok_or_else(|| unknown_pivot_field(field_index))?;
            // The caller's model column when it named one; otherwise the one
            // table that can own the cache name. Never the FIRST table with
            // such a column: two tables sharing a column name made the pin
            // filter the wrong one.
            let Some((table, column)) = model_column.clone() else {
                return Err(pin_cannot_be_attributed(&name));
            };

            // The engine filter replaces any host-side mask for this field —
            // a leftover mask would double-apply (and go stale).
            for field in &mut definition.row_fields {
                if field.source_index == field_index {
                    field.hidden_items.clear();
                }
            }
            for field in &mut definition.column_fields {
                if field.source_index == field_index {
                    field.hidden_items.clear();
                }
            }
            for filter in &mut definition.filter_fields {
                if filter.field.source_index == field_index {
                    filter.field.hidden_items.clear();
                }
            }
            // Keep the field in the query's GROUP BY so the cache shape (and
            // every field index) is unchanged: an out-of-zone field needs a
            // slicer_filters presence — with NO mask.
            let in_zone = definition
                .row_fields
                .iter()
                .any(|f| f.source_index == field_index)
                || definition
                    .column_fields
                    .iter()
                    .any(|f| f.source_index == field_index)
                || definition
                    .filter_fields
                    .iter()
                    .any(|f| f.field.source_index == field_index);
            if let Some(sf) = definition
                .slicer_filters
                .iter_mut()
                .find(|sf| sf.source_index == field_index)
            {
                sf.hidden_items.clear();
                if sf.model_key.is_none() {
                    sf.model_key = model_key.clone();
                }
            } else if !in_zone {
                definition.slicer_filters.push(pivot_engine::SlicerFilter {
                    source_index: field_index,
                    hidden_items: Vec::new(),
                    model_key: model_key.clone(),
                });
            }

            // Upsert the engine filter, keyed by its MODEL COLUMN (the bare
            // field name can be shared by two tables).
            let entry = pivot_engine::EngineFilter {
                field_name: name.clone(),
                table: table.clone(),
                column: column.clone(),
                selected_items: manual.selected_items.clone(),
                level: request.filter_level,
                slicer_id: request.slicer_id.clone(),
            };
            if let Some(existing) = definition
                .engine_filters
                .iter_mut()
                .find(|ef| ef.table == table && ef.column == column)
            {
                *existing = entry;
            } else {
                definition.engine_filters.push(entry);
            }
            true
        } else {
            false
        };
        // An ordinary (level-1) selection on a field that previously held a
        // PIN drops the pin — the mask path below takes over, and the drop
        // changes the engine query, so a BI re-query is still required.
        // `dropped_pins`: the model column of every pin this dropped.
        let mut dropped_pins: Vec<(String, String)> = Vec::new();
        if !pinned_routed {
            let mut drop_if = |ef: &pivot_engine::EngineFilter, hit: bool| {
                if hit {
                    dropped_pins.push((ef.table.clone(), ef.column.clone()));
                }
                !hit
            };
            match (&model_column, field_name.as_deref()) {
                // By its column: a pin on ANOTHER table's same-named column
                // is not this field's pin.
                (Some((table, column)), _) => definition
                    .engine_filters
                    .retain(|ef| drop_if(ef, &ef.table == table && &ef.column == column)),
                (None, Some(name)) => definition.engine_filters.retain(|ef| drop_if(ef, ef.field_name == name)),
                (None, None) => {}
            }
        }
        let pin_dropped = !dropped_pins.is_empty();
        // The level-1 selection that REPLACES a dropped pin cannot be turned
        // into a mask here: the records were queried THROUGH the pin, so they
        // hold only the pinned values, and "every value not selected" over
        // them hides nothing outside the pin -- a pin [East] replaced by a
        // selection [East, West] showed North too. The re-query applies the
        // selection to its NEW records instead (see `PostQueryMask`), on the
        // column the pin was on.
        let post_query_mask: Option<PostQueryMask> = match &request.filters.manual_filter {
            Some(manual) if pin_dropped && calc_group_items.is_none() => {
                let column = model_column.clone().or_else(|| match dropped_pins.as_slice() {
                    [only] => Some(only.clone()),
                    // Two tables' pins shared the dropped cache name: no
                    // single column to mask, and a guessed one would
                    // silently mis-filter. The pre-query mask stands.
                    _ => None,
                });
                column.map(|(table, column)| PostQueryMask {
                    table,
                    column,
                    selected: manual.selected_items.clone(),
                    blank_listed,
                })
            }
            _ => None,
        };

        // Apply manual filter as hidden items
        if pinned_routed {
            // Host-side masking skipped: the pin travels inside the engine query.
        } else if let Some(ref manual) = request.filters.manual_filter {
            // Hidden items = all items - selected items. A calculation group's
            // items are its declared (text) item names; a real column's are
            // the cache's values, matched spelling-tolerantly because the
            // selection may be spelled the MODEL's way ("true", "12.50").
            let hidden_items: Vec<String> = if let Some(items) = &calc_group_items {
                items
                    .iter()
                    .filter(|v| !manual.selected_items.contains(v))
                    .cloned()
                    .collect()
            } else {
                hidden_for_selection_listed(cache, field_index, &manual.selected_items, blank_listed)
            };

            // Row, column and filter fields carry it where they show the
            // field; a field in no zone gets it as a slicer filter (external,
            // no visible filter row), stamped with its model column.
            set_hidden_items_at(definition, field_index, hidden_items, model_key.as_deref());
        }

        definition.bump_version();

        if calc_group_items.is_some() || pinned_routed || pin_dropped {
            // Calc-group selection changed, or an engine-routed (pinned)
            // filter was added/replaced/dropped: the local cache was built
            // for a DIFFERENT engine query, so recalculating from it would
            // be wrong — fall through to the BI re-query (refresh
            // reconstructs the request from the definition, including the
            // engine filters and hidden_items just applied). The cache is
            // still the pre-edit records here: nothing above replaced it.
            FilterStep::Requery { pre_definition, pre_cache: cache.clone(), mask: post_query_mask }
        } else {
            let view = safe_calculate_pivot(definition, cache);
            store_view(pivot_state, request.pivot_id, &view);
            let mut response = view_to_response(&view, definition, cache);

            let destination = definition.destination;
            let pivot_id = definition.id;

            drop(pivot_tables);
            // Resolved with the pivot lock RELEASED: `delete_sheet` and the
            // calculation pass hold `sheet_names` while they take
            // `pivot_tables`, so reading names under it is the reverse order.
            // A filter never moves the pivot, so the pre-edit clone names the
            // same sheet.
            let dest_sheet_idx = resolve_dest_sheet_index(state, &pre_definition);

            // SAVED, not merely counted: the step below must put them back.
            // Always empty on a canvas (its hidden grid holds only output).
            let overwritten = save_overwritten_cells(state, pivot_id, dest_sheet_idx, destination, &view);
            response.overwritten_cell_count = overwritten.len() as u32;
            finalize_pivot_update(state, &effect, pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: ctx.pane_control_state, ribbon: ctx.ribbon_filter_state, user_files: ctx.user_files_state }))?;

            FilterStep::Local(response, local_overwrite_step(pivot_id, pre_definition, overwritten, dest_sheet_idx))
        }
    };

    match step {
        FilterStep::Local(response, overwrite) if ctx.record_undo => {
            let mut response = record_local_overwrite(ctx, response, overwrite);
            if response.overwrite_token.is_none() {
                response.overwrite_token = kept.ensure_token;
            }
            Ok((response, kept))
        }
        FilterStep::Local(response, overwrite) => {
            if let Some(step) = overwrite {
                kept.overwritten.extend(step.overwritten_cells);
            }
            Ok((response, kept))
        }
        // Every re-query fork above is BI-only (calculation groups and engine
        // filters exist only on model pivots).
        FilterStep::Requery { pre_definition, pre_cache, mask } => {
            let (result, unrecorded) =
                requery_filter_change(ctx, request.pivot_id, pre_definition, pre_cache, mask).await;
            kept.absorb(unrecorded);
            result.map(|mut response| {
                if response.overwrite_token.is_none() {
                    response.overwrite_token = kept.ensure_token;
                }
                (response, kept)
            })
        }
    }
}

/// The step a LOCAL (host-side mask) filter apply or clear hands back when it
/// grew the pivot over the user's cells: the definition from BEFORE the
/// filter and the cells it overwrote. `None` when it overwrote nothing -- an
/// ordinary mask records no step (the Slicer's reconcile re-derives it). The
/// cache is left out: a mask renders the SAME records, so the definition
/// alone describes what to put back.
fn local_overwrite_step(
    pivot_id: PivotId,
    pre_definition: PivotDefinition,
    overwritten: Vec<crate::pivot::operations::SavedCell>,
    dest_sheet_idx: usize,
) -> Option<BiFieldChangeUndo> {
    (!overwritten.is_empty()).then(|| BiFieldChangeUndo {
        pivot_id,
        definition: pre_definition,
        overwritten_cells: overwritten,
        dest_sheet_idx,
        prev_col_widths: Vec::new(),
        cache: None,
    })
}

/// Record a local filter's overwrite step (joining an open transaction, or as
/// a step of its own) unless the context records nothing -- a reconcile, or
/// `delete_slicer_core`'s quiet clears -- and stamp its token on the response.
fn record_local_overwrite(
    ctx: &PivotCmdCtx<'_>,
    mut response: PivotViewResponse,
    overwrite: Option<BiFieldChangeUndo>,
) -> PivotViewResponse {
    if ctx.record_undo {
        if let Some(step) = overwrite {
            response.overwrite_token = step.record(ctx.state, "Filter pivot");
        }
    }
    response
}

/// What a filter apply is aimed at, read from the pivot's records and BI
/// metadata: the cache column's name, a calculation group's declared items
/// (when the field IS one), and the model column -- the caller's when it named
/// one, otherwise the one table that can own the cache name (a header-dropdown
/// apply names only a cache index; a column two tables share is attributed to
/// neither). Read-only; shared by the pre-effect refusals and the apply itself
/// so the two cannot disagree about the target.
fn filter_field_target(
    cache: &PivotCache,
    meta: Option<&BiPivotMetadata>,
    field_index: usize,
    model_column: Option<(String, String)>,
) -> (Option<String>, Option<Vec<String>>, Option<(String, String)>) {
    let field_name = cache.fields.get(field_index).map(|f| f.name.clone());
    let items: Option<Vec<String>> = meta.and_then(|meta| {
        field_name.as_deref().and_then(|n| {
            meta.calculation_groups
                .iter()
                .find(|g| g.name == n)
                .map(|g| g.items.iter().map(|i| i.name.clone()).collect())
        })
    });
    let column = model_column.or_else(|| {
        let meta = meta?;
        if items.is_some() {
            return None;
        }
        resolve_bi_cache_name(field_name.as_deref()?, meta)
    });
    (field_name, items, column)
}

/// The refusals of a PINNED (level 2+) apply that depend on the pivot, under
/// READ guards (`pivot_tables`, then `bi_metadata`: the canonical order), so
/// they run before `pivot_write` mints the document-modified token. A pin is
/// routed into the ENGINE QUERY, so it needs a model pivot, a field the
/// records carry, and one model column to route it to.
fn refuse_an_unroutable_pin(
    pivot_state: &PivotState,
    pivot_id: PivotId,
    field_index: usize,
    model_column: Option<(String, String)>,
) -> Result<(), String> {
    let pivot_tables = pivot_state
        .pivot_tables
        .read()
        .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
    let (_, cache) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
    let bi_meta = pivot_state
        .bi_metadata
        .read()
        .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
    let Some(meta) = bi_meta.get(&pivot_id) else {
        return Err(pinned_needs_a_model_pivot());
    };
    let (field_name, _, column) = filter_field_target(cache, Some(meta), field_index, model_column);
    let name = field_name.ok_or_else(|| unknown_pivot_field(field_index))?;
    if column.is_none() {
        return Err(pin_cannot_be_attributed(&name));
    }
    Ok(())
}

fn pinned_needs_an_item_selection() -> String {
    "pinned filter levels (2+) support item-selection filters only".to_string()
}

fn pinned_needs_a_model_pivot() -> String {
    "pinned filter levels (2+) require a BI model pivot — a range/table pivot \
     has no engine query to route the pin into; use level 1 for this slicer"
        .to_string()
}

fn unknown_pivot_field(field_index: usize) -> String {
    format!("unknown pivot field index {}", field_index)
}

fn pin_cannot_be_attributed(name: &str) -> String {
    format!(
        "cannot attribute field '{name}' to a model table; a mis-attributed pin \
         would silently mis-filter, so this fails closed"
    )
}

/// The outcome of the synchronous, lock-holding half of a filter apply or
/// clear.
pub(crate) enum FilterStep {
    /// Handled host-side: the pivot was recalculated and rewritten. Carries
    /// the overwrite step when the rewrite grew over the user's cells (see
    /// [`local_overwrite_step`]); recording it is the caller's decision.
    Local(PivotViewResponse, Option<BiFieldChangeUndo>),
    /// The edit changed the ENGINE QUERY and the pivot must be re-queried.
    /// Carries the definition and records as they were BEFORE the edit (which
    /// is already stored), for the undo step, and the level-1 selection the
    /// re-query must apply to its NEW records (a dropped pin's replacement).
    Requery { pre_definition: PivotDefinition, pre_cache: PivotCache, mask: Option<PostQueryMask> },
}

/// A level-1 selection a BI re-query applies to the records IT fetched,
/// after the query and before the one write -- the page fold's rule
/// ("hide every value not selected") for a selection that is not a model
/// slicer's. Needed when the records on hand cannot answer "every value":
/// a selection replacing a PIN, whose records were queried through the pin.
#[derive(Debug, Clone)]
pub(crate) struct PostQueryMask {
    pub table: String,
    pub column: String,
    pub selected: Vec<String>,
    /// How the list the selection was made from offered the blank item
    /// (see [`BlankListing`]).
    pub blank_listed: BlankListing,
}

/// Re-query a BI pivot after a filter edit that changed its engine query, and
/// record the gesture's undo step from the state BEFORE the edit.
///
/// The edit (a pin added, replaced or dropped; a calculation group's item
/// state) is made IN PLACE, and the re-query snapshots the stored definition
/// on entry -- so the step it would record restores the NEW pin against the
/// OLD records. Ctrl+Z after a level change to pinned then showed every region
/// while the slicer was back at level 1; after a pinned click from East to
/// West it showed East but kept pin [West], which the next refresh re-applied.
///
/// The re-query records nothing itself; this records ONE pivot restore of the
/// pre-edit definition and records, carrying the cells and column widths the
/// re-query's write overwrote -- joining the caller's open transaction (the
/// Slicer Settings dialog's "update level + apply" step) or as a step of its
/// own. No transaction is opened across the BI await (a concurrent edit would
/// be swallowed into it, `delete_slicer_core`'s rule). Redo works because the
/// restore's inverse captures the post-query definition and records.
///
/// A failed re-query still records the step: the edit is already stored and
/// the document dirtied, and Ctrl+Z must take it back. A context that records
/// nothing (`delete_slicer_core`'s quiet clears) records nothing here either.
///
/// `mask`: a level-1 selection the re-query applies to its NEW records before
/// it writes (see [`PostQueryMask`]).
///
/// Also returns, when it recorded NOTHING (a quiet context), what the step
/// would have held -- the user's cells the re-query grew over, the records
/// from before the edit and the widths its auto-fit overwrote -- for a caller
/// that records the gesture itself (see [`FilterWriteKeep`]); empty when it
/// recorded them.
async fn requery_filter_change(
    ctx: &PivotCmdCtx<'_>,
    pivot_id: PivotId,
    pre_definition: PivotDefinition,
    pre_cache: PivotCache,
    mask: Option<PostQueryMask>,
) -> (Result<PivotViewResponse, String>, FilterWriteKeep) {
    let (mut result, pending) = match refresh_bi_pivot_unrecorded(ctx, pivot_id, mask.into_iter().collect()).await {
        Ok((response, pending)) => (Ok(response), pending),
        Err(e) => (Err(e), None),
    };
    if !ctx.record_undo {
        let (overwritten, prev_col_widths) = match pending {
            Some(p) => (p.overwritten_cells, p.prev_col_widths),
            None => (Vec::new(), Vec::new()),
        };
        return (
            result,
            FilterWriteKeep { overwritten, pre_cache: Some(pre_cache), prev_col_widths, ensure_token: None },
        );
    }
    {
        let (overwritten_cells, dest_sheet_idx, prev_col_widths) = match pending {
            Some(p) => (p.overwritten_cells, p.dest_sheet_idx, p.prev_col_widths),
            // No pivot lock is held here.
            None => (Vec::new(), resolve_dest_sheet_index(ctx.state, &pre_definition), Vec::new()),
        };
        let token = BiFieldChangeUndo {
            pivot_id,
            definition: pre_definition,
            overwritten_cells,
            dest_sheet_idx,
            prev_col_widths,
            cache: Some(pre_cache),
        }
        .record(ctx.state, "Filter pivot");
        // The re-query's own overwrite is this step's: a Cancel hands the
        // token back and takes back exactly the pre-edit state it restores.
        if let Ok(response) = result.as_mut() {
            response.overwrite_token = token;
        }
    }
    (result, FilterWriteKeep::default())
}

/// Clears filters from a pivot field.
///
/// `biFieldKey` (BI pivots): a column the pivot does not carry is a no-op that
/// leaves the document clean -- clearing never adds a field.
#[tauri::command]
pub async fn clear_pivot_filter(
    _window: tauri::Window,
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    request: ClearPivotFilterRequest,
) -> Result<PivotViewResponse, String> {
    let ctx = PivotCmdCtx {
        state: &state,
        file_state: &file_state,
        pivot_state: &pivot_state,
        pane_control_state: &pane_control_state,
        ribbon_filter_state: &ribbon_filter_state,
        user_files_state: &user_files_state,
        bi_state: &bi_state,
        slicer_state: &slicer_state,
        record_undo: true,
    };
    clear_pivot_filter_core(&ctx, request).await
}

/// [`clear_pivot_filter`] over borrowed state.
///
/// A host-side clear that grows a worksheet pivot over the user's cells
/// records ONE step carrying them, as the apply does (see
/// [`apply_pivot_filter`]); a `reconcile` clear records nothing.
pub(crate) async fn clear_pivot_filter_core(
    ctx: &PivotCmdCtx<'_>,
    request: ClearPivotFilterRequest,
) -> Result<PivotViewResponse, String> {
    clear_pivot_filter_core_keeping(ctx, request).await.map(|(response, _)| response)
}

/// [`clear_pivot_filter_core`] that also hands back what the clear did and did
/// NOT record (see [`FilterWriteKeep`]): non-empty only in a context that
/// records nothing. `delete_slicer_core` runs its clears that way and records
/// ONE step for the whole delete at the end -- which must carry the cells the
/// clears grew over, or undoing the delete brought the slicer and its filter
/// back over cells that stayed overwritten -- and so does a gesture
/// (`run_pivot_filter_gesture`).
pub(crate) async fn clear_pivot_filter_core_keeping(
    ctx: &PivotCmdCtx<'_>,
    request: ClearPivotFilterRequest,
) -> Result<(PivotViewResponse, FilterWriteKeep), String> {
    let quiet;
    let ctx: &PivotCmdCtx<'_> = if request.reconcile {
        quiet = PivotCmdCtx { record_undo: false, ..*ctx };
        &quiet
    } else {
        ctx
    };
    // IN FLIGHT until this returns, when it RECORDS (W4): see
    // `apply_pivot_filter_core_keeping`. A pinned clear re-queries and pushes
    // its step at the end.
    let _in_flight = ctx.record_undo.then(|| crate::undo_commands::PendingGesture::begin(ctx.state));
    let state = ctx.state;
    let file_state = ctx.file_state;
    let pivot_state = ctx.pivot_state;

    // Resolve the field BEFORE any token exists. A model column the pivot
    // does not carry has no filter to clear: answer with the current view.
    let (field_index, model_key): (usize, Option<(String, String)>) = match request.bi_field_key.as_deref() {
        Some(key) => {
            // A column added in the Model Editor is resolvable too.
            refresh_bi_model_snapshot(ctx, request.pivot_id).await?;
            let resolved = {
                let pivot_tables = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
                let (definition, cache) = pivot_tables
                    .get(&request.pivot_id)
                    .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;
                let bi_meta = pivot_state.bi_metadata.read().map_err(|e| e.to_string())?;
                let meta = bi_meta.get(&request.pivot_id).ok_or_else(|| {
                    format!("biFieldKey '{key}' needs a BI model pivot; pivot {} is not one", request.pivot_id)
                })?;
                let (table, column) = split_model_column_key(key, meta)?;
                resolve_bi_field_index(definition, cache, meta, &table, &column)
                    .map(|idx| (idx, (table, column)))
            };
            match resolved {
                Some((idx, key)) => (idx, Some(key)),
                None => {
                    return current_pivot_view(pivot_state, request.pivot_id).map(|r| (r, FilterWriteKeep::default()))
                }
            }
        }
        None => (
            request
                .field_index
                .ok_or_else(|| "clear_pivot_filter needs a fieldIndex or a biFieldKey".to_string())?,
            None,
        ),
    };

    log_info!(
        "PIVOT",
        "clear_pivot_filter pivot_id={} field={}",
        request.pivot_id,
        field_index
    );

    // All lock-holding work happens in the synchronous helper, so no guard
    // can live across the await below (the Tauri command future must be
    // Send). `Requery` = the cleared field needs a BI re-query, whose undo
    // step restores the pre-clear state (`requery_filter_change`).
    let step = clear_pivot_filter_local(
        state,
        file_state,
        pivot_state,
        PivotRecalcStates {
            pane: ctx.pane_control_state,
            ribbon: ctx.ribbon_filter_state,
            user_files: ctx.user_files_state,
        },
        request.pivot_id,
        field_index,
        model_key.as_ref(),
    )?;

    match step {
        FilterStep::Local(response, overwrite) if ctx.record_undo => {
            Ok((record_local_overwrite(ctx, response, overwrite), FilterWriteKeep::default()))
        }
        FilterStep::Local(response, overwrite) => Ok((
            response,
            FilterWriteKeep {
                overwritten: overwrite.map(|step| step.overwritten_cells).unwrap_or_default(),
                ..FilterWriteKeep::default()
            },
        )),
        FilterStep::Requery { pre_definition, pre_cache, mask } => {
            let (result, unrecorded) =
                requery_filter_change(ctx, request.pivot_id, pre_definition, pre_cache, mask).await;
            result.map(|response| (response, unrecorded))
        }
    }
}

// ============================================================================
// FILTER GESTURES -- several writes, ONE undo step recorded at the end
// ============================================================================

/// What [`run_pivot_filter_gesture`] did: every write's response (in order),
/// the writes that refused, and the pivot restores the gesture's ONE step must
/// carry (in recording order), with the overwrite token they share.
pub(crate) struct PivotFilterGestureRun {
    pub responses: Vec<PivotViewResponse>,
    pub failures: Vec<PivotFilterWriteFailure>,
    pub restores: Vec<(&'static str, Vec<u8>)>,
    pub overwrite_token: Option<u64>,
}

/// Run one GESTURE's pivot filter writes -- a slicer click's, a ribbon filter
/// change's -- in order, each with its own undo recording switched OFF, and
/// hand back what the gesture's ONE step must restore (BUG-0187).
///
/// Nothing here touches the undo stack, so no transaction is held open across
/// the BI re-queries a write may await (an ensure, a pin): a concurrent edit
/// made meanwhile is a step of its own, and the caller pushes the gesture's
/// step once, at the end (`undo_commands::record_gesture_step`).
///
/// A pivot's restore is the definition it had when the GESTURE began (read
/// before its first write), carrying every user cell any of its writes grew
/// over and -- when a write REPLACED its records (an ensure, a re-query) --
/// the records from before the first replacement. A pivot whose writes only
/// moved a level-1 mask records nothing, exactly as a single write does (the
/// Slicer's reconcile re-derives the mask after an undo). A write that refuses
/// is reported in `failures` and the others still run.
pub(crate) async fn run_pivot_filter_gesture(
    ctx: &PivotCmdCtx<'_>,
    writes: Vec<PivotFilterWrite>,
) -> PivotFilterGestureRun {
    struct Touched {
        pivot_id: PivotId,
        definition: PivotDefinition,
        dest_sheet: usize,
        kept: FilterWriteKeep,
    }
    let quiet = PivotCmdCtx { record_undo: false, ..*ctx };
    let mut touched: Vec<Touched> = Vec::new();
    let mut responses: Vec<PivotViewResponse> = Vec::new();
    let mut failures: Vec<PivotFilterWriteFailure> = Vec::new();

    for write in writes {
        let (pivot_id, clearing) = match (&write.apply, &write.clear) {
            (Some(apply), None) => (apply.pivot_id, false),
            (None, Some(clear)) => (clear.pivot_id, true),
            (apply, clear) => {
                let pivot_id = apply.as_ref().map(|a| a.pivot_id).or(clear.as_ref().map(|c| c.pivot_id));
                if let Some(pivot_id) = pivot_id {
                    failures.push(PivotFilterWriteFailure {
                        pivot_id,
                        clearing: clear.is_some(),
                        message: "a filter write names exactly one of apply / clear".to_string(),
                    });
                }
                continue;
            }
        };
        if !touched.iter().any(|t| t.pivot_id == pivot_id) {
            // The gesture-start definition, read alone and released before
            // the destination is resolved (`delete_sheet` and the calculation
            // pass take `sheet_names` before `pivot_tables`).
            let definition = pivot_state_definition(ctx.pivot_state, pivot_id);
            if let Some(definition) = definition {
                let dest_sheet = resolve_dest_sheet_index(ctx.state, &definition);
                touched.push(Touched { pivot_id, definition, dest_sheet, kept: FilterWriteKeep::default() });
            }
        }
        // Boxed: each write can await a BI re-query, whose future is large;
        // on the heap it cannot grow the polling thread's stack.
        let result = match (write.apply, write.clear) {
            (Some(apply), _) => Box::pin(apply_pivot_filter_core_keeping(&quiet, apply)).await,
            (_, Some(clear)) => Box::pin(clear_pivot_filter_core_keeping(&quiet, clear)).await,
            (None, None) => continue,
        };
        match result {
            Ok((response, kept)) => {
                if let Some(t) = touched.iter_mut().find(|t| t.pivot_id == pivot_id) {
                    t.kept.absorb(kept);
                }
                responses.push(response);
            }
            Err(message) => failures.push(PivotFilterWriteFailure { pivot_id, clearing, message }),
        }
    }

    let overwrite_token = touched
        .iter()
        .any(|t| !t.kept.overwritten.is_empty())
        .then(crate::undo_commands::mint_pivot_overwrite_token);
    let mut restores: Vec<(&'static str, Vec<u8>)> = Vec::new();
    for t in touched {
        if !t.kept.needs_a_step() {
            continue;
        }
        let token = if t.kept.overwritten.is_empty() { None } else { overwrite_token };
        restores.push((
            crate::undo_commands::PIVOT_DEFINITION_RESTORE_KIND,
            crate::undo_commands::encode_pivot_definition_snapshot_with_token(
                t.pivot_id,
                t.definition,
                t.kept.overwritten,
                t.dest_sheet,
                t.kept.pre_cache,
                token,
            ),
        ));
        if let Some(widths) = crate::undo_commands::encode_pivot_col_widths_snapshot(t.dest_sheet, t.kept.prev_col_widths)
        {
            restores.push((crate::undo_commands::PIVOT_COL_WIDTHS_RESTORE_KIND, widths));
        }
    }
    // A response whose write grew over the user's cells names the step that
    // holds them -- the gesture's one step -- for the one overwrite question.
    for response in &mut responses {
        response.overwrite_token = if response.overwritten_cell_count > 0 { overwrite_token } else { None };
    }
    PivotFilterGestureRun { responses, failures, restores, overwrite_token }
}

/// A pivot's stored definition, cloned under the read guard alone.
fn pivot_state_definition(pivot_state: &PivotState, pivot_id: PivotId) -> Option<PivotDefinition> {
    let pivot_tables = pivot_state.pivot_tables.read().ok()?;
    pivot_tables.get(&pivot_id).map(|(definition, _)| definition.clone())
}

/// The host-side half of a filter clear, SYNCHRONOUS: the field's hidden items
/// come off every zone field and slicer filter at `field_index`, its pin (by
/// model column when `model_key` names one, else by cache name) is dropped, and
/// -- when nothing needs the engine -- the pivot is recalculated and rewritten
/// in place. Returns [`FilterStep::Requery`] (with the pre-clear definition and
/// records) when the clear changed the engine query (a pin dropped, or a
/// calculation group's item state) and the caller must re-query. Records no
/// undo step itself; the caller owns that -- including the overwrite step a
/// local clear hands back when it grew the pivot over the user's cells.
///
/// Shared by `clear_pivot_filter_core` and the sheet-delete cascade, which
/// runs synchronously and has no engine to await.
#[allow(clippy::too_many_arguments)]
pub(crate) fn clear_pivot_filter_local(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    pivot_state: &PivotState,
    recalc: PivotRecalcStates<'_>,
    pivot_id: PivotId,
    field_index: usize,
    model_key: Option<&(String, String)>,
) -> Result<FilterStep, String> {
    let (effect, mut pivot_tables) = pivot_write(state, pivot_state, file_state, pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
    // Before the clear: the re-query's undo step restores it, and the
    // destination sheet is resolved from it after the lock is released.
    let pre_definition = definition.clone();

    // Calc-group field? Clearing the filter changes the applied-item state
    // (e.g. one visible item -> all visible = NO item applied), so it
    // needs a BI re-query, like apply_pivot_filter.
    let is_calc_group_field = {
        let field_name = cache.fields.get(field_index).map(|f| f.name.clone());
        let bi_meta = pivot_state.bi_metadata.read().unwrap();
        bi_meta.get(&pivot_id).is_some_and(|meta| {
            field_name
                .as_deref()
                .is_some_and(|n| meta.calculation_groups.iter().any(|g| g.name == n))
        })
    };

    // Clear hidden items from all matching fields
    for field in &mut definition.row_fields {
        if field.source_index == field_index {
            field.hidden_items.clear();
        }
    }
    for field in &mut definition.column_fields {
        if field.source_index == field_index {
            field.hidden_items.clear();
        }
    }
    for filter in &mut definition.filter_fields {
        if filter.field.source_index == field_index {
            filter.field.hidden_items.clear();
        }
    }
    // Also remove any slicer filters for this field
    definition.slicer_filters.retain(|sf| sf.source_index != field_index);

    // And any engine-routed (pinned) filter: it lives INSIDE the engine
    // query, so dropping it changes the query — the local cache is stale
    // and a BI re-query is required (same fork as calc groups). Matched by
    // the model column when the caller named it (a pin folded under a
    // different spelling of the name cannot survive its clear), otherwise by
    // the cache column name.
    let engine_filter_dropped = {
        let field_name = cache.fields.get(field_index).map(|f| f.name.clone());
        let before = definition.engine_filters.len();
        definition.engine_filters.retain(|ef| {
            // When the caller named the model column, ONLY that column's
            // pin goes: the bare cache name is shared by every table with
            // a same-named column, and matching by it too cleared a
            // different table's pin.
            let hit = match &model_key {
                Some((t, c)) => &ef.table == t && &ef.column == c,
                None => field_name.as_deref().is_some_and(|n| ef.field_name == n),
            };
            !hit
        });
        definition.engine_filters.len() != before
    };

    definition.bump_version();

    if is_calc_group_field || engine_filter_dropped {
        // The cache is still the pre-clear records: nothing above replaced it.
        // A clear shows every value, so there is nothing to mask afterwards.
        Ok(FilterStep::Requery { pre_definition, pre_cache: cache.clone(), mask: None })
    } else {
        let view = safe_calculate_pivot(definition, cache);
        store_view(pivot_state, pivot_id, &view);
        let mut response = view_to_response(&view, definition, cache);

        let destination = definition.destination;

        drop(pivot_tables);
        // With the pivot lock RELEASED (`delete_sheet` and the calculation
        // pass take `sheet_names` before `pivot_tables`); a clear never moves
        // the pivot, so the pre-clear clone names the same sheet.
        let dest_sheet_idx = resolve_dest_sheet_index(state, &pre_definition);

        let overwritten = save_overwritten_cells(state, pivot_id, dest_sheet_idx, destination, &view);
        response.overwritten_cell_count = overwritten.len() as u32;
        finalize_pivot_update(state, &effect, pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(recalc))?;

        Ok(FilterStep::Local(response, local_overwrite_step(pivot_id, pre_definition, overwritten, dest_sheet_idx)))
    }
}


/// Sorts a pivot field by labels.
#[tauri::command]
pub fn sort_pivot_field(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: SortPivotFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "sort_pivot_field pivot_id={} field={} by={:?}",
        request.pivot_id,
        request.field_index,
        request.sort_by
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    let sort_order = match request.sort_by {
        SortBy::Ascending => pivot_engine::SortOrder::Ascending,
        SortBy::Descending => pivot_engine::SortOrder::Descending,
    };

    // Update sort order for matching fields
    for field in &mut definition.row_fields {
        if field.source_index == request.field_index {
            field.sort_order = sort_order;
        }
    }
    for field in &mut definition.column_fields {
        if field.source_index == request.field_index {
            field.sort_order = sort_order;
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Gets pivot field info including items and filters.
#[tauri::command]
pub fn get_pivot_field_info(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    field_index: usize,
) -> Result<PivotFieldInfo, String> {
    log_debug!("PIVOT", "get_pivot_field_info pivot_id={} field={}", pivot_id, field_index);
    pivot_field_info_core(&pivot_state, pivot_id, field_index)
}

/// [`get_pivot_field_info`] over a borrowed `PivotState`.
///
/// THE BLANK ITEM IS AN ITEM (the review of A2). The header dropdown builds
/// its CHECKED set from this answer and its list from
/// `get_pivot_field_unique_values`, which lists `(blank)` last: without it
/// here, `(blank)` showed UNCHECKED while its rows were visible, and any OK
/// then sent a selection without it -- hiding blank rows the user never
/// touched. Listed last when the column has blank records, visible unless a
/// hidden item names it by its label (any case -- "" is an item of its own),
/// and in the manual filter's selection when visible -- the filter-cell rule
/// of `view_to_response`.
pub(crate) fn pivot_field_info_core(
    pivot_state: &PivotState,
    pivot_id: PivotId,
    field_index: usize,
) -> Result<PivotFieldInfo, String> {
    let mut pivot_tables = pivot_state.pivot_tables.write(&pivot_render_effect()).unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
    let has_blank = field_index < cache.fields.len() && cache.has_blank_values(field_index);

    // Get field name from cache
    let field_name = cache.field_name(field_index)
        .unwrap_or_else(|| format!("Field{}", field_index + 1));

    // Get hidden items from definition (search row, column, AND filter fields)
    let hidden_items: Vec<String> = definition.row_fields.iter()
        .chain(definition.column_fields.iter())
        .chain(definition.filter_fields.iter().map(|f| &f.field))
        .find(|f| f.source_index == field_index)
        .map(|f| f.hidden_items.clone())
        .unwrap_or_default();

    let show_all_items = hidden_items.is_empty();
    let is_filtered = !hidden_items.is_empty();

    // Get unique values and build items
    let mut items: Vec<PivotItemInfo> = if let Some(field_cache) = cache.fields.get_mut(field_index) {
        let sorted_ids = field_cache.sorted_ids().to_vec();
        sorted_ids.iter()
            .filter_map(|&id| {
                if id == VALUE_ID_EMPTY {
                    return None;
                }
                field_cache.get_value(id).map(|value| {
                    let name = cache_value_to_string(value);
                    let visible = !hidden_items.contains(&name);
                    PivotItemInfo {
                        id,
                        name,
                        is_expanded: true, // Default to expanded
                        visible,
                    }
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    if has_blank {
        items.push(PivotItemInfo {
            id: VALUE_ID_EMPTY,
            name: pivot_engine::BLANK_ITEM_LABEL.to_string(),
            is_expanded: true,
            // By its label only: "" is an item of its own here, as in the
            // write ([`BlankListing::Separate`]) and in the engine, which
            // hides only the "" rows by "". Counting "" as a spelling of
            // (blank) read (blank) UNCHECKED after only "" was unchecked, and
            // OK-unchanged then hid the (blank) rows (the review of wave D).
            visible: !hidden_items.iter().any(|h| pivot_engine::is_blank_item_label(h)),
        });
    }

    // Build manual filter from hidden items
    let manual_filter = if !hidden_items.is_empty() {
        let selected: Vec<String> = items.iter()
            .filter(|i| i.visible)
            .map(|i| i.name.clone())
            .collect();
        Some(PivotManualFilter { selected_items: selected })
    } else {
        None
    };

    Ok(PivotFieldInfo {
        id: field_index,
        name: field_name,
        show_all_items,
        filters: PivotFilters {
            date_filter: None,
            label_filter: None,
            manual_filter,
            value_filter: None,
        },
        is_filtered,
        subtotals: Subtotals::default(),
        items,
    })
}

/// Sets a pivot item's visibility.
#[tauri::command]
pub fn set_pivot_item_visibility(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: SetItemVisibilityRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "set_pivot_item_visibility pivot_id={} field={} item={} visible={}",
        request.pivot_id,
        request.field_index,
        request.item_name,
        request.visible
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Update hidden_items for matching fields
    for field in &mut definition.row_fields {
        if field.source_index == request.field_index {
            if request.visible {
                field.hidden_items.retain(|item| item != &request.item_name);
            } else if !field.hidden_items.contains(&request.item_name) {
                field.hidden_items.push(request.item_name.clone());
            }
        }
    }
    for field in &mut definition.column_fields {
        if field.source_index == request.field_index {
            if request.visible {
                field.hidden_items.retain(|item| item != &request.item_name);
            } else if !field.hidden_items.contains(&request.item_name) {
                field.hidden_items.push(request.item_name.clone());
            }
        }
    }
    for filter in &mut definition.filter_fields {
        if filter.field.source_index == request.field_index {
            if request.visible {
                filter.field.hidden_items.retain(|item| item != &request.item_name);
            } else if !filter.field.hidden_items.contains(&request.item_name) {
                filter.field.hidden_items.push(request.item_name.clone());
            }
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Gets all pivot tables in the workbook -- the in-crate reader's shape (the
/// MCP inventory). The IPC command of this name is `crate::pivot::
/// get_all_pivot_tables` (pivot/mod.rs), which adds each pivot's sheet.
pub fn get_all_pivot_tables(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
) -> Vec<PivotTableInfo> {
    log_debug!("PIVOT", "get_all_pivot_tables");
    get_all_pivot_tables_core(&state, &pivot_state).into_iter().map(|listing| listing.info).collect()
}

/// Every pivot with the sheet it is on, over borrowed state.
///
/// The sheet is the destination sheet NAME's, ignoring case (the rule every
/// pivot write resolves by); a pivot whose name no sheet answers to is where
/// its output is registered; with neither, `None` -- never the active sheet by
/// assumption. Resolved after the pivot guard is released: the calculation
/// pass holds `sheet_names` while it takes `pivot_tables`.
pub(crate) fn get_all_pivot_tables_core(state: &AppState, pivot_state: &PivotState) -> Vec<PivotTableListing> {
    let rows: Vec<(PivotTableInfo, Option<String>)> = {
        let pivot_tables = pivot_state.pivot_tables.read().unwrap();
        pivot_tables
            .iter()
            .map(|(id, (definition, _))| {
                let source_range = definition.source_range_display.clone()
                    .unwrap_or_else(|| format_range(definition.source_start, definition.source_end));
                let destination = format_cell(definition.destination);
                let info = PivotTableInfo {
                    id: *id,
                    name: definition.name.clone().unwrap_or_else(|| format!("PivotTable{}", id)),
                    source_range,
                    destination,
                    allow_multiple_filters_per_field: definition.allow_multiple_filters_per_field,
                    enable_data_value_editing: definition.enable_data_value_editing,
                    refresh_on_open: definition.refresh_on_open,
                    use_custom_sort_lists: definition.use_custom_sort_lists,
                    has_headers: definition.source_has_headers,
                    source_table_name: definition.source_table_name.clone(),
                };
                (info, definition.destination_sheet.clone())
            })
            .collect()
    };
    let sheet_names = sheet_names_snapshot(state);
    rows.into_iter()
        .map(|(info, destination_sheet)| {
            let sheet_index = destination_sheet
                .as_deref()
                .and_then(|name| index_of_sheet(&sheet_names, name))
                .or_else(|| get_pivot_region(state, info.id).map(|region| region.sheet_index));
            PivotTableListing { info, sheet_index }
        })
        .collect()
}

/// Get BI metadata for a pivot table (connection ID, sheet index).
/// Returns null if the pivot is not BI-backed.
#[tauri::command]
pub fn get_pivot_bi_metadata(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Option<serde_json::Value> {
    // Lock order: pivot_tables before bi_metadata (canonical — see
    // bi_pivots_for_connection). Both are RELEASED before the sheet is
    // resolved: `resolve_dest_sheet_index` reads `sheet_names` /
    // `active_sheet`, which `delete_sheet` holds while it takes
    // `pivot_tables` -- resolving under the pivot locks is the reverse order.
    let (definition, meta) = {
        let pivot_tables = pivot_state.pivot_tables.read().unwrap();
        let bi_meta = pivot_state.bi_metadata.read().unwrap();
        let meta = bi_meta.get(&pivot_id).cloned();
        (pivot_tables.get(&pivot_id).map(|(def, _)| def.clone()), meta)
    };

    if let Some(meta) = meta {
        // Get the sheet index from the pivot definition
        let sheet_index = definition
            .as_ref()
            .map(|def| resolve_dest_sheet_index(&state, def))
            .unwrap_or(0);

        Some(serde_json::json!({
            "connectionId": meta.connection_id,
            "sheetIndex": sheet_index,
            // Model tables/columns + measures so callers (e.g. the drill-through
            // behavior dialog) can offer a column/attribute picker.
            "tables": meta.model_tables,
            "measures": meta.measures,
            "perspectives": meta.perspectives,
            "selectedPerspective": meta.selected_perspective,
        }))
    } else {
        None
    }
}

/// List the BI-backed pivots that belong to a given model connection.
/// Matches on the live connection id, falling back to the stable package
/// data-source id (which equals the connection UUID for locally created
/// connections) so targets resolve right after load, before the runtime
/// connection_id is re-bound.
pub(crate) fn bi_pivots_for_connection(
    state: &AppState,
    pivot_state: &PivotState,
    connection_id: identity::EntityId,
) -> Vec<super::types::BiConnectionPivot> {
    // Lock order: pivot_tables BEFORE bi_metadata — the order every site that
    // holds both uses (refresh_pivot_cache, collect_pivot_definitions); the
    // reverse order would be an ABBA deadlock.
    //
    // COLLECT under the pivot locks, RESOLVE after releasing them:
    // `resolve_dest_sheet_index` reads `sheet_names` (and `active_sheet` as
    // its fallback), and `delete_sheet` holds both while it takes
    // `pivot_tables`. Resolving under the pivot locks was that order reversed
    // -- an ABBA hang on every model slicer's item fetch and every slicer
    // delete that raced a sheet delete. Every caller is covered here.
    let hits: Vec<(PivotId, String, PivotDefinition)> = {
        let pivot_tables = pivot_state.pivot_tables.read().unwrap();
        let bi_meta = pivot_state.bi_metadata.read().unwrap();
        let connection_key = connection_id.to_string();
        bi_meta
            .iter()
            .filter(|(_, meta)| {
                meta.connection_id == connection_id
                    || meta.data_source_id.as_deref() == Some(connection_key.as_str())
            })
            .filter_map(|(pivot_id, _)| {
                pivot_tables.get(pivot_id).map(|(def, _)| {
                    (
                        *pivot_id,
                        def.name.clone().unwrap_or_else(|| format!("PivotTable{}", pivot_id)),
                        def.clone(),
                    )
                })
            })
            .collect()
    }; // pivot_tables + bi_metadata released here
    hits.into_iter()
        .map(|(id, name, def)| super::types::BiConnectionPivot {
            id,
            name,
            sheet_index: resolve_dest_sheet_index(state, &def),
        })
        .collect()
}

#[tauri::command]
pub fn get_pivots_for_bi_connection(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    connection_id: identity::EntityId,
) -> Vec<super::types::BiConnectionPivot> {
    bi_pivots_for_connection(&state, &pivot_state, connection_id)
}

/// Sets the expand/collapse state of a specific pivot item.
#[tauri::command]
pub fn set_pivot_item_expanded(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: SetItemExpandedRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "set_pivot_item_expanded pivot_id={} field_idx={} item='{}' expanded={}",
        request.pivot_id,
        request.field_index,
        request.item_name,
        request.is_expanded
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Search in both row_fields and column_fields for the matching field_index
    let mut found = false;
    for field in definition.row_fields.iter_mut().chain(definition.column_fields.iter_mut()) {
        if field.source_index == request.field_index {
            if request.is_expanded {
                field.collapsed_items.retain(|s| s != &request.item_name);
            } else if !field.collapsed_items.contains(&request.item_name) {
                field.collapsed_items.push(request.item_name.clone());
            }
            // Clear field-level collapse when setting per-item state
            field.collapsed = false;
            found = true;
            break;
        }
    }

    if !found {
        return Err(format!(
            "Field with source_index {} not found in row or column fields",
            request.field_index
        ));
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Expands or collapses all items at a specific field level.
#[tauri::command]
pub fn expand_collapse_level(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: ExpandCollapseLevelRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "expand_collapse_level pivot_id={} is_row={} field_idx={} expand={}",
        request.pivot_id,
        request.is_row,
        request.field_index,
        request.expand
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    let fields = if request.is_row {
        &mut definition.row_fields
    } else {
        &mut definition.column_fields
    };

    // Match by source_index (the value from groupPath), not positional index
    let field = fields
        .iter_mut()
        .find(|f| f.source_index == request.field_index)
        .ok_or_else(|| {
            format!(
                "Field with source_index {} not found in {} fields",
                request.field_index,
                if request.is_row { "row" } else { "column" }
            )
        })?;
    field.collapsed = !request.expand;
    field.collapsed_items.clear();

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Expands or collapses ALL fields in the entire pivot table.
#[tauri::command]
pub fn expand_collapse_all(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: ExpandCollapseAllRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "expand_collapse_all pivot_id={} expand={}",
        request.pivot_id,
        request.expand
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    for field in definition.row_fields.iter_mut().chain(definition.column_fields.iter_mut()) {
        field.collapsed = !request.expand;
        field.collapsed_items.clear();
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Refreshes all pivot tables in the workbook.
#[tauri::command]
pub async fn refresh_all_pivot_tables(
    window: tauri::Window,
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
) -> Result<Vec<PivotViewResponse>, String> {
    log_info!("PIVOT", "refresh_all_pivot_tables");

    let pivot_ids: Vec<PivotId> = {
        let pivot_tables = pivot_state.pivot_tables.read().unwrap();
        pivot_tables.keys().cloned().collect()
    };

    let mut responses = Vec::new();
    for pivot_id in pivot_ids {
        match refresh_pivot_cache(window.clone(), state.clone(), file_state.clone(), pivot_state.clone(), pane_control_state.clone(), ribbon_filter_state.clone(), user_files_state.clone(), bi_state.clone(), slicer_state.clone(), pivot_id).await {
            Ok(response) => responses.push(response),
            Err(e) => log_debug!("PIVOT", "Failed to refresh pivot {}: {}", pivot_id, e),
        }
    }

    Ok(responses)
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Formats a cell reference from (row, col) to A1 notation.
fn format_cell(pos: (u32, u32)) -> String {
    let (row, col) = pos;
    format!("{}{}", col_index_to_letter(col), row + 1)
}

/// Formats a range from ((start_row, start_col), (end_row, end_col)) to A1:B2 notation.
fn format_range(start: (u32, u32), end: (u32, u32)) -> String {
    format!("{}:{}", format_cell(start), format_cell(end))
}

/// Converts API AggregationFunction to engine AggregationType.
fn api_to_aggregation_type(func: AggregationFunction) -> pivot_engine::AggregationType {
    match func {
        AggregationFunction::Automatic => pivot_engine::AggregationType::Sum,
        AggregationFunction::Sum => pivot_engine::AggregationType::Sum,
        AggregationFunction::Count => pivot_engine::AggregationType::Count,
        AggregationFunction::Average => pivot_engine::AggregationType::Average,
        AggregationFunction::Max => pivot_engine::AggregationType::Max,
        AggregationFunction::Min => pivot_engine::AggregationType::Min,
        AggregationFunction::Product => pivot_engine::AggregationType::Product,
        AggregationFunction::CountNumbers => pivot_engine::AggregationType::CountNumbers,
        AggregationFunction::StandardDeviation => pivot_engine::AggregationType::StdDev,
        AggregationFunction::StandardDeviationP => pivot_engine::AggregationType::StdDevP,
        AggregationFunction::Variance => pivot_engine::AggregationType::Var,
        AggregationFunction::VarianceP => pivot_engine::AggregationType::VarP,
    }
}

/// Resolves base_field names to base_field_index on value fields.
/// Called after value fields are created from config, to fill in the index
/// that the engine needs for Difference/RunningTotal/Rank calculations.
fn resolve_base_field_indices(
    value_fields: &mut [pivot_engine::ValueField],
    configs: &[ValueFieldConfig],
    row_fields: &[pivot_engine::PivotField],
    col_fields: &[pivot_engine::PivotField],
) {
    for (vf, cfg) in value_fields.iter_mut().zip(configs.iter()) {
        let base_field_name = cfg.show_as.as_ref()
            .and_then(|rule| rule.base_field.as_ref());

        if let Some(name) = base_field_name {
            // Search row fields, then column fields
            let found = row_fields.iter().chain(col_fields.iter())
                .find(|f| &f.name == name)
                .map(|f| f.source_index);
            vf.base_field_index = found;
        }
    }
}

/// Converts engine AggregationType to API AggregationFunction.
fn aggregation_type_to_api(agg: pivot_engine::AggregationType) -> AggregationFunction {
    match agg {
        pivot_engine::AggregationType::Sum => AggregationFunction::Sum,
        pivot_engine::AggregationType::Count => AggregationFunction::Count,
        pivot_engine::AggregationType::Average => AggregationFunction::Average,
        pivot_engine::AggregationType::Max => AggregationFunction::Max,
        pivot_engine::AggregationType::Min => AggregationFunction::Min,
        pivot_engine::AggregationType::Product => AggregationFunction::Product,
        pivot_engine::AggregationType::CountNumbers => AggregationFunction::CountNumbers,
        pivot_engine::AggregationType::StdDev => AggregationFunction::StandardDeviation,
        pivot_engine::AggregationType::StdDevP => AggregationFunction::StandardDeviationP,
        pivot_engine::AggregationType::Var => AggregationFunction::Variance,
        pivot_engine::AggregationType::VarP => AggregationFunction::VarianceP,
    }
}

/// Converts engine ShowValuesAs to API ShowAsRule.
fn show_values_as_to_api(vf: &pivot_engine::ValueField, fields: &[pivot_engine::PivotField]) -> Option<ShowAsRule> {
    let calculation = match vf.show_values_as {
        pivot_engine::ShowValuesAs::Normal => return None,
        pivot_engine::ShowValuesAs::PercentOfGrandTotal => ShowAsCalculation::PercentOfGrandTotal,
        pivot_engine::ShowValuesAs::PercentOfRowTotal => ShowAsCalculation::PercentOfRowTotal,
        pivot_engine::ShowValuesAs::PercentOfColumnTotal => ShowAsCalculation::PercentOfColumnTotal,
        pivot_engine::ShowValuesAs::PercentOfParentRow => ShowAsCalculation::PercentOfParentRowTotal,
        pivot_engine::ShowValuesAs::PercentOfParentColumn => ShowAsCalculation::PercentOfParentColumnTotal,
        pivot_engine::ShowValuesAs::Difference => ShowAsCalculation::DifferenceFrom,
        pivot_engine::ShowValuesAs::PercentDifference => ShowAsCalculation::PercentDifferenceFrom,
        pivot_engine::ShowValuesAs::RunningTotal => ShowAsCalculation::RunningTotal,
        pivot_engine::ShowValuesAs::PercentOfRunningTotal => ShowAsCalculation::PercentOfRunningTotal,
        pivot_engine::ShowValuesAs::RankAscending => ShowAsCalculation::RankAscending,
        pivot_engine::ShowValuesAs::RankDescending => ShowAsCalculation::RankDescending,
        pivot_engine::ShowValuesAs::Index => ShowAsCalculation::Index,
    };

    // Resolve base_field name from index
    let base_field = vf.base_field_index.and_then(|fi| {
        fields.iter().find(|f| f.source_index == fi).map(|f| f.name.clone())
    });

    Some(ShowAsRule {
        calculation,
        base_field,
        base_item: vf.base_item.clone(),
    })
}

// ============================================================================
// GROUPING COMMANDS
// ============================================================================

/// Applies grouping (date, number binning, or manual) to a pivot field.
#[tauri::command]
pub fn group_pivot_field(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: GroupFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "group_pivot_field pivot_id={} field_index={} grouping={:?}",
        request.pivot_id,
        request.field_index,
        request.grouping
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Find the field in row_fields or column_fields by source_index
    let field = definition
        .row_fields
        .iter_mut()
        .chain(definition.column_fields.iter_mut())
        .find(|f| f.source_index == request.field_index);

    let field = match field {
        Some(f) => f,
        None => return Err(format!("Field with source_index {} not found", request.field_index)),
    };

    // Apply the grouping configuration
    field.grouping = api_grouping_config_to_engine(&request.grouping);

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Creates a manual group on a pivot field (adds items to a named group).
#[tauri::command]
pub fn create_manual_group(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: CreateManualGroupRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "create_manual_group pivot_id={} field_index={} group_name={} members={:?}",
        request.pivot_id,
        request.field_index,
        request.group_name,
        request.member_items
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Find the field in row_fields or column_fields by source_index
    let field = definition
        .row_fields
        .iter_mut()
        .chain(definition.column_fields.iter_mut())
        .find(|f| f.source_index == request.field_index);

    let field = match field {
        Some(f) => f,
        None => return Err(format!("Field with source_index {} not found", request.field_index)),
    };

    // Initialize or extend manual grouping
    match &mut field.grouping {
        pivot_engine::FieldGrouping::ManualGrouping { groups, .. } => {
            // Add to existing manual grouping
            groups.push(pivot_engine::ManualGroup {
                name: request.group_name,
                members: request.member_items,
            });
        }
        _ => {
            // Create new manual grouping
            field.grouping = pivot_engine::FieldGrouping::ManualGrouping {
                groups: vec![pivot_engine::ManualGroup {
                    name: request.group_name,
                    members: request.member_items,
                }],
                ungrouped_name: "Other".to_string(),
            };
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Removes all grouping from a pivot field.
#[tauri::command]
pub fn ungroup_pivot_field(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: UngroupFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "ungroup_pivot_field pivot_id={} field_index={}",
        request.pivot_id,
        request.field_index
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Find the field in row_fields or column_fields by source_index
    let field = definition
        .row_fields
        .iter_mut()
        .chain(definition.column_fields.iter_mut())
        .find(|f| f.source_index == request.field_index);

    let field = match field {
        Some(f) => f,
        None => return Err(format!("Field with source_index {} not found", request.field_index)),
    };

    // Reset grouping to None
    field.grouping = pivot_engine::FieldGrouping::None;

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Map a drill-override filter operator string to a `bi_engine::FilterOperator`
/// (mirrors the BI query builder; unknown operators default to Equal).
fn drill_filter_op(op: &str) -> bi_engine::FilterOperator {
    match op {
        "!=" | "ne" => bi_engine::FilterOperator::NotEqual,
        ">" | "gt" => bi_engine::FilterOperator::GreaterThan,
        "<" | "lt" => bi_engine::FilterOperator::LessThan,
        ">=" | "gte" => bi_engine::FilterOperator::GreaterThanOrEqual,
        "<=" | "lte" => bi_engine::FilterOperator::LessThanOrEqual,
        _ => bi_engine::FilterOperator::Equal,
    }
}

/// Build an engine drillthrough request (`DetailRequest`) for a BI-backed pivot
/// cell, identified by its `group_path` of (cache field index, value id) pairs.
/// Each pair becomes an equality filter on that dimension column, so the engine
/// returns only the RLS-enforced raw fact rows behind the drilled cell. A
/// grand-total cell (empty `group_path`) yields no filters and drills the whole
/// fact table (capped by `limit`).
///
/// When `include_dimension_attrs` is set, the pivot's related-dimension fields
/// (group-by + lookup columns whose table is *not* the fact table, and which the
/// drilled cell does not already pin to a constant) are appended as
/// `dimension_columns` — readable labels (`Customer.name`, `Product.category`)
/// looked up beside each raw fact row. Returns the request plus the number of
/// attached attributes, so the caller can build a bare fallback: the engine
/// fails the whole request closed if any attribute's relationship is not
/// single-hop active equi, and degrading to raw fact rows beats erroring.
fn build_bi_detail_request(
    meta: &super::types::BiPivotMetadata,
    definition: &PivotDefinition,
    cache: &PivotCache,
    group_path: &[(usize, u32)],
    default_limit: usize,
    override_: Option<&super::types::DrillQueryOverride>,
    include_dimension_attrs: bool,
) -> Result<(bi_engine::DetailRequest, usize), String> {
    // The detail (fact) table is the home table of the pivot's measures. v1
    // drills the first measure's table; a pivot mixing measures from multiple
    // fact tables drills the first (documented limitation).
    let fact_table = meta
        .measures
        .first()
        .map(|m| m.table.clone())
        .ok_or_else(|| {
            "BI pivot has no measures; cannot determine a detail table to drill".to_string()
        })?;

    // Each group_path entry pins one dimension to the drilled cell's value.
    let mut filters: Vec<bi_engine::FilterCondition> = Vec::with_capacity(group_path.len());
    let mut pinned: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for &(field_index, value_id) in group_path {
        // THE BLANK MEMBER (wave D, X1): a cell of the (blank) row names it
        // (`VALUE_ID_BLANK`). A detail filter can only COMPARE, so nothing
        // selects a NULL, and `column = ''` would list only the empty strings:
        // refused, by name, rather than answered with the wrong rows. (Before
        // the blank was named, its cells drilled the level above.)
        if pivot_engine::is_blank_member_id(value_id) {
            return Err(
                "Drill-through cannot list the rows of a (blank) item in a data-model pivot: the model's \
                 detail query cannot select empty values. Drill through a total that includes it instead."
                    .to_string(),
            );
        }
        // Pivot field names are "Table.Column"; the engine resolves a filter by
        // the bare column name against the owning table (then propagates it to
        // the fact over a single hop), so pass the column part.
        let field_name = definition
            .row_fields
            .iter()
            .find(|f| f.source_index == field_index)
            .map(|f| f.name.clone())
            .or_else(|| {
                definition
                    .column_fields
                    .iter()
                    .find(|f| f.source_index == field_index)
                    .map(|f| f.name.clone())
            })
            .or_else(|| cache.field_name(field_index))
            .unwrap_or_default();
        let (dim_table, column) = match field_name.rsplit_once('.') {
            Some((t, c)) => (t.to_string(), c.to_string()),
            None => (String::new(), field_name.clone()),
        };
        pinned.insert((dim_table, column.clone()));
        let value = cache.get_value_label(field_index, value_id).unwrap_or_default();
        filters.push(bi_engine::FilterCondition::new(
            column,
            bi_engine::FilterOperator::Equal,
            value,
        ));
    }

    // Extra filters from a declarative override, ANDed with the cell filters.
    if let Some(ov) = override_ {
        for f in &ov.filters {
            filters.push(bi_engine::FilterCondition::new(
                f.column.clone(),
                drill_filter_op(&f.operator),
                f.value.clone(),
            ));
        }
    }

    // Append readable dimension attributes the pivot already uses, skipping the
    // fact's own columns (returned anyway via SELECT *) and any dimension the
    // drilled cell already pins to a single value (a constant column adds noise).
    let mut dimension_columns: Vec<bi_engine::ColumnRef> = Vec::new();
    if include_dimension_attrs {
        match override_ {
            // Declarative override: attach exactly the publisher-chosen attrs.
            Some(ov) => {
                for c in &ov.dimension_columns {
                    dimension_columns.push(bi_engine::ColumnRef::new(&c.table, &c.column));
                }
            }
            // Builtin: auto-derive from the pivot's own related-dimension fields.
            None => {
                if let Some(last) = &meta.last_query {
                    let mut seen: std::collections::HashSet<(String, String)> =
                        std::collections::HashSet::new();
                    for f in last.group_by.iter().chain(last.lookups.iter()) {
                        if f.table == fact_table {
                            continue;
                        }
                        let key = (f.table.clone(), f.column.clone());
                        if pinned.contains(&key) || !seen.insert(key) {
                            continue;
                        }
                        dimension_columns.push(bi_engine::ColumnRef::new(&f.table, &f.column));
                    }
                }
            }
        }
    }
    let n_dims = dimension_columns.len();

    let limit = override_.and_then(|o| o.limit).unwrap_or(default_limit);
    let mut request = bi_engine::DetailRequest::new(fact_table, limit)
        .with_filters(filters)
        .with_dimension_columns(dimension_columns);
    // Declarative override: detail columns + ordering.
    if let Some(ov) = override_ {
        if !ov.columns.is_empty() {
            request = request.with_columns(ov.columns.clone());
        }
        if !ov.order_by.is_empty() {
            let order: Vec<bi_engine::OrderByClause> = ov
                .order_by
                .iter()
                .map(|o| {
                    if o.descending {
                        bi_engine::OrderByClause::column_desc(&o.table, &o.column)
                    } else {
                        bi_engine::OrderByClause::column(&o.table, &o.column)
                    }
                })
                .collect();
            request = request.with_order_by(order);
        }
    }
    Ok((request, n_dims))
}

/// Convert one drillthrough cell (an `Option<String>` from `batches_to_result`)
/// into a grid `CellValue`: nulls become empty, numeric text becomes a number,
/// everything else stays text.
fn detail_value_to_cell(value: Option<String>) -> engine::CellValue {
    match value {
        None => engine::CellValue::Empty,
        Some(s) => match s.parse::<f64>() {
            Ok(n) => engine::CellValue::Number(n),
            Err(_) => engine::CellValue::Text(s),
        },
    }
}

/// Performs a drill-through: creates a new sheet with the detail rows behind a
/// pivot cell. A BI-backed pivot uses the engine's RLS-enforced `query_rows`
/// (secured server-side fact rows); a grid-backed pivot uses its original
/// source range.
#[tauri::command]
pub async fn drill_through_to_sheet(
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    request: DrillThroughRequest,
) -> Result<DrillThroughResponse, String> {
    log_info!(
        "PIVOT",
        "drill_through_to_sheet pivot_id={} path_len={}",
        request.pivot_id,
        request.group_path.len()
    );

    drill_through_to_sheet_core(&state, &file_state, &pivot_state, &bi_state, request).await
}

/// [`drill_through_to_sheet`] over borrowed state.
///
/// LOCK ORDER: no lock is waited for while a pivot lock is held (a
/// grid-backed pivot's rows are read once the pivot guards are dropped), the
/// pivot guards themselves are taken `pivot_tables` then `bi_metadata` (the
/// order every filter command takes them in; this took them the other way
/// round), and the new sheet is added through `sheets::append_user_sheet`,
/// which takes the crate's canonical order `grid`, `grids`, `sheet_names`.
///
/// THE SHEET GOES IN THROUGH THE ONE ADD PATH (fix round 4, B4). This pushed
/// only `sheet_names` and `grids`: the sheet got no id, kind, visibility,
/// freeze, zoom or row/column-size entries, the width of a column on the sheet
/// it left was lost (the switch never stashed it), it landed behind a floating
/// range's object sheet, and a protected workbook structure did not stop it.
pub(crate) async fn drill_through_to_sheet_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    pivot_state: &PivotState,
    bi_state: &crate::bi::types::BiState,
    request: DrillThroughRequest,
) -> Result<DrillThroughResponse, String> {
    // Refused before the query runs: the sheet could never be added.
    crate::protection::check_workbook_structure(state, DRILL_THROUGH_ACTION)?;
    let max = request.max_records.unwrap_or(10000);

    // Gather the detail rows. A BI-backed pivot builds an engine DetailRequest
    // here (while the pivot locks are held) and runs it after they drop; a
    // grid-backed pivot notes which source rows to copy, and copies them after
    // the locks drop too.
    let mut headers: Vec<String> = Vec::new();
    let mut row_data: Vec<Vec<engine::CellValue>> = Vec::new();
    // What the user has to be told about the sheet they are about to get.
    let mut notices: Vec<crate::pivot::types::PivotNotice> = Vec::new();
    /// A grid-backed pivot's drill: which source rows, and where they live.
    struct GridDrill {
        source_rows: Vec<u32>,
        source_sheet: Option<String>,
        source_start: (u32, u32),
        has_headers: bool,
    }
    let mut grid_drill: Option<GridDrill> = None;
    let bi_drill: Option<(
        crate::bi::types::ConnectionId,
        bi_engine::DetailRequest,
        Option<bi_engine::DetailRequest>,
        // (has_query_override, first measure name) — drives DETAILROWS below.
        bool,
        String,
    )> = {
        // `pivot_tables` FIRST, then `bi_metadata`: the order the filter
        // commands take them in (`apply_pivot_filter_core`). Both are
        // `Persisted` (a Mutex, so a read is exclusive), and this async
        // command took them the other way round.
        let pivot_tables = pivot_state
            .pivot_tables
            .read()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        let bi_meta = pivot_state
            .bi_metadata
            .read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        let (definition, cache) = pivot_tables
            .get(&request.pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

        if let Some(meta) = bi_meta.get(&request.pivot_id) {
            // A `Query`-mode behavior overrides the detail query declaratively;
            // builtin / None uses the default (auto dimension attributes).
            let override_ref = match &meta.drill_through {
                Some(b) if b.kind == super::types::DrillThroughKind::Query => b.query.as_ref(),
                _ => None,
            };
            let (detail, n_dims) = build_bi_detail_request(
                meta,
                definition,
                cache,
                &request.group_path,
                max,
                override_ref,
                true,
            )?;
            // Bare fallback (no dimension attributes) for the case where an
            // attribute's relationship is not single-hop and the engine rejects
            // the enriched request — the drill still returns raw fact rows.
            let fallback = if n_dims > 0 {
                Some(
                    build_bi_detail_request(
                        meta,
                        definition,
                        cache,
                        &request.group_path,
                        max,
                        override_ref,
                        false,
                    )?
                    .0,
                )
            } else {
                None
            };
            Some((
                meta.connection_id,
                detail,
                fallback,
                override_ref.is_some(),
                meta.measures.first().map(|m| m.name.clone()).unwrap_or_default(),
            ))
        } else {
            // Grid-backed pivot — note the matching source rows; they are
            // read from the grid below, with the pivot locks RELEASED.
            let result = drill_down(definition, cache, &request.group_path, max);
            headers = cache.fields.iter().map(|f| f.name.clone()).collect();
            grid_drill = Some(GridDrill {
                source_rows: result.source_rows,
                source_sheet: definition.source_sheet.clone(),
                source_start: definition.source_start,
                has_headers: definition.source_has_headers,
            });
            None
        }
    };

    // Grid-backed pivot: copy its source rows. `grids` is taken only now: the
    // calculation pass holds `grid`/`grids` and then takes `pivot_tables`, so
    // waiting for `grids` under the pivot guard closed a cycle. And from the
    // pivot's OWN source sheet: this read sheet 0 whatever the source was, so
    // drilling through a pivot built on Sheet2 listed Sheet1's rows.
    if let Some(drill) = grid_drill {
        let col_count = headers.len();
        let source_sheet_idx = drill
            .source_sheet
            .as_deref()
            .and_then(|name| index_of_sheet(&sheet_names_snapshot(state), name))
            .unwrap_or(0);
        let grids = state
            .grids
            .read()
            .map_err(|e| format!("grids lock poisoned: {}", e))?;
        let grid = grids
            .get(source_sheet_idx)
            .ok_or_else(|| "Source sheet not found".to_string())?;

        let (start_row, start_col) = drill.source_start;
        let data_start = if drill.has_headers {
            start_row + 1
        } else {
            start_row
        };

        for &src_row in &drill.source_rows {
            let grid_row = data_start + src_row;
            let mut row = Vec::with_capacity(col_count);
            for c in 0..col_count {
                let col = start_col + c as u32;
                let cv = grid
                    .get_cell(grid_row, col)
                    .map(|cell| cell.value.clone())
                    .unwrap_or(engine::CellValue::Empty);
                row.push(cv);
            }
            row_data.push(row);
        }
    }

    // BI-backed pivot: run the secured drillthrough now the pivot locks are free.
    if let Some((connection_id, mut detail, mut fallback, has_query_override, first_measure)) =
        bi_drill
    {
        let engine_arc = {
            let connections = bi_state
                .connections
                .lock()
                .map_err(|e| format!("connections lock poisoned: {}", e))?;
            let conn = connections
                .get(&connection_id)
                .ok_or_else(|| format!("BI connection {} not found", connection_id))?;
            conn.engine.clone().ok_or("No BI model loaded.")?
        };
        let batches = {
            let mut engine = engine_arc.lock().await;
            // DETAILROWS: when the drilled measure defines its own drill
            // projection in the model, it replaces the auto-derived builtin
            // one (fact refs → detail columns, other-table refs → dimension
            // attributes). An explicit Query-mode override still wins.
            if !has_query_override {
                let detail_refs = engine
                    .model()
                    .measure(&first_measure)
                    .ok()
                    .and_then(|m| m.detail_rows().map(|r| r.to_vec()));
                if let Some(refs) = detail_refs {
                    let mut columns: Vec<String> = Vec::new();
                    let mut dims: Vec<bi_engine::ColumnRef> = Vec::new();
                    for r in &refs {
                        // Builder-validated shape: `Table[column]`.
                        let r = r.trim();
                        let Some(open) = r.find('[') else { continue };
                        let Some(body) = r.strip_suffix(']') else { continue };
                        let t = body[..open].trim();
                        let c = body[open + 1..].trim();
                        if t.eq_ignore_ascii_case(&detail.table) {
                            columns.push(c.to_string());
                        } else {
                            dims.push(bi_engine::ColumnRef::new(t, c));
                        }
                    }
                    let has_dims = !dims.is_empty();
                    detail.columns = columns.clone();
                    detail.dimension_columns = dims;
                    match fallback.as_mut() {
                        Some(bare) => bare.columns = columns,
                        // The builtin path had no dimension attributes, but the
                        // measure's projection adds some — give it the same
                        // bare fallback the auto-derived path gets.
                        None if has_dims => {
                            let mut bare = detail.clone();
                            bare.dimension_columns = Vec::new();
                            fallback = Some(bare);
                        }
                        None => {}
                    }
                }
            }
            // Apply this connection's RLS role (or clear a sibling's) so drilled
            // detail rows are restricted to what the active role permits.
            crate::bi::commands::apply_connection_role(&mut engine, bi_state, connection_id);
            match engine.query_rows(detail).await {
                Ok(b) => b,
                // A SECURITY refusal is never retried away. The bare request
                // differs from the enriched one by exactly one thing — the
                // dimension columns are emptied — and the engine's detail gate
                // checks precisely those (`enforce_detail_object_level_security`
                // walks `request.dimension_columns`). So retrying after a
                // denial re-asks a question the gate WILL allow and presents
                // the answer as the one that was asked: a silently narrower
                // sheet, with the denial recorded nowhere but an info log.
                // Drill-through is raw fact rows, the highest-leak surface
                // there is; refuse instead, and let the caller say why.
                Err(e) if crate::bi::cube::is_security_refusal(&e) => {
                    return Err(crate::bi::commands::friendly_bi_query_error(
                        "BI drillthrough failed",
                        &e,
                    ));
                }
                Err(e) => match fallback {
                    // Retry without dimension attributes — the enriched request
                    // hit a non-single-hop relationship the engine rejects.
                    // Legitimate, and now SAID: the sheet is narrower than the
                    // one the user (or the publisher's DrillQueryOverride)
                    // asked for.
                    Some(bare) => {
                        log_info!(
                            "PIVOT",
                            "drillthrough with dimension attributes failed ({}); retrying without",
                            e
                        );
                        notices.push(crate::pivot::types::PivotNotice::degraded(
                            "Some dimension columns were left out: the model cannot join them to \
                             this detail table in one hop.",
                        ));
                        engine
                            .query_rows(bare)
                            .await
                            .map_err(|err| crate::bi::commands::friendly_bi_query_error("BI drillthrough failed", &err))?
                    }
                    None => return Err(crate::bi::commands::friendly_bi_query_error("BI drillthrough failed", &e)),
                },
            }
        };
        let result = crate::bi::commands::batches_to_result(&batches);
        headers = result.columns;
        row_data = result
            .rows
            .into_iter()
            .map(|r| r.into_iter().map(detail_value_to_cell).collect())
            .collect();
    }

    let data_row_count = row_data.len();
    let col_count = headers.len();

    // The detail rows, built into a DETACHED grid: no lock is held here.
    let mut new_grid = engine::grid::Grid::new();

    // Write headers
    for (c, header) in headers.iter().enumerate() {
        new_grid.set_cell(0, c as u32, engine::Cell::new_text(header.clone()));
    }

    // Write data rows
    for (r, row) in row_data.iter().enumerate() {
        for (c, cv) in row.iter().enumerate() {
            new_grid.set_cell((r + 1) as u32, c as u32, engine::Cell { ast: None, value: cv.clone(), style_index: 0, rich_text: None });
        }
    }

    // Drill-through APPENDS A WHOLE NEW SHEET of detail rows (the non-verb name
    // is exactly why a mutating-verb heuristic once missed it), created AND
    // switched to: through the one add path, which owns every per-sheet store,
    // the user/object partition, the stash of the sheet being left and the
    // workbook-structure gate -- refused before anything is written.
    let added = crate::sheets::append_user_sheet(
        state,
        file_state,
        crate::sheets::NewUserSheet {
            name: crate::sheets::NewSheetName::FirstFree("DrillThrough".to_string()),
            kind: ::persistence::SheetKind::Worksheet,
            cells: Some(new_grid),
            activate: true,
        },
        DRILL_THROUGH_ACTION,
    )?;
    // Excel parity (BUG-0005), as `add_sheet`: a new sheet ends the undo
    // history. And the new sheet is ACTIVE, so the single-sheet dependency
    // maps are rebuilt for it (BUG-0016) -- this switched sheets and left them
    // describing the sheet it came from. Both with every lock released.
    crate::sheets::invalidate_undo_history_for_sheet_structure(state, DRILL_THROUGH_ACTION);
    crate::undo_commands::rebuild_all_dependencies(state);

    Ok(DrillThroughResponse {
        sheet_name: added.name,
        sheet_index: added.index,
        row_count: data_row_count,
        col_count,
        notices,
    })
}

/// The drill-through's name for itself in a refusal ("Cannot add a
/// drill-through sheet while the workbook structure is protected").
const DRILL_THROUGH_ACTION: &str = "add a drill-through sheet";

/// Set (or clear, with `None`) a BI pivot's drill-through behavior. Persists in
/// the pivot's BI metadata; saved with the workbook and carried into `.calp`.
#[tauri::command]
pub fn set_pivot_drill_behavior(
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    behavior: Option<super::types::DrillThroughBehavior>,
) -> Result<(), String> {
    // Refusal-first: verify this really is a BI-backed pivot under a READ guard,
    // so a refused call never mints the eager `mutates` token.
    {
        let probe = pivot_state
            .bi_metadata
            .read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        if !probe.contains_key(&pivot_id) {
            return Err(format!("Pivot {} is not a BI-backed pivot", pivot_id));
        }
    }
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut bi_meta = pivot_state
        .bi_metadata
        .write(&effect)
        .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
    let meta = bi_meta
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot {} is not a BI-backed pivot", pivot_id))?;
    meta.drill_through = behavior;
    Ok(())
}

/// Select the perspective filtering a BI pivot's FIELD LIST display
/// (`None` / empty = show all fields). Display-only metadata -- queries and
/// existing zone assignments are unaffected; persists with the workbook and
/// travels in .calp. An unknown name is accepted and simply filters nothing
/// (the model's perspectives may change under the pivot).
#[tauri::command]
pub fn set_pivot_perspective(
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    perspective: Option<String>,
) -> Result<(), String> {
    // Refusal-first: verify this really is a BI-backed pivot under a READ guard,
    // so a refused call never mints the eager `mutates` token.
    {
        let probe = pivot_state
            .bi_metadata
            .read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        if !probe.contains_key(&pivot_id) {
            return Err(format!("Pivot {} is not a BI-backed pivot", pivot_id));
        }
    }
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut bi_meta = pivot_state
        .bi_metadata
        .write(&effect)
        .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
    let meta = bi_meta
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot {} is not a BI-backed pivot", pivot_id))?;
    meta.selected_perspective = perspective
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    Ok(())
}

/// Get a BI pivot's current drill-through behavior (`None` = default builtin).
#[tauri::command]
pub fn get_pivot_drill_behavior(
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<Option<super::types::DrillThroughBehavior>, String> {
    let bi_meta = pivot_state
        .bi_metadata
        .read()
        .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
    Ok(bi_meta.get(&pivot_id).and_then(|m| m.drill_through.clone()))
}

// ============================================================================
// BI PIVOT COMMANDS
// ============================================================================

/// Extracts model metadata (tables + measures) from a BI engine.
/// Expand a BI pivot's value fields by an applied calculation group's items.
///
/// With no items (`item_names` empty), this is one value field per base measure
/// (the ordinary case). With K items, it produces M base measures x K items in
/// **measures-outer / items-inner** order to match the engine's synthetic
/// column order (`M1[I1], M1[I2], M2[I1], ...`). Each field keeps the clean
/// `[Measure]` key as its `name` so it round-trips to the base measure, carries
/// the item in `calc_item` (so the editor/refresh can collapse it back), and
/// shows `Measure [Item]` as its `custom_name`. Indices are contiguous from
/// `measure_start`, matching the cache value block.
pub(crate) fn expand_bi_value_fields(
    value_fields: &[BiValueFieldRef],
    item_names: &[String],
    measure_start: usize,
    value_col_idx: &std::collections::HashMap<(String, Option<String>), usize>,
) -> Vec<pivot_engine::ValueField> {
    // Prefer the engine-reported column index for (measure, item); fall back to
    // the positional index when metadata is absent (e.g. an empty result set).
    let resolve = |measure: &str, item: Option<&str>, positional: usize| -> usize {
        value_col_idx
            .get(&(measure.to_string(), item.map(|s| s.to_string())))
            .copied()
            .unwrap_or(positional)
    };
    if item_names.is_empty() {
        return value_fields
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let mut vf = ValueField::new(
                    resolve(&v.measure_name, None, measure_start + i),
                    format!("[{}]", v.measure_name),
                    AggregationType::Sum, // SUM of pre-aggregated = identity
                );
                vf.custom_name = v.custom_name.clone();
                vf
            })
            .collect();
    }
    let k = item_names.len();
    let mut vfs = Vec::with_capacity(value_fields.len() * k);
    for (m_idx, v) in value_fields.iter().enumerate() {
        for (i_idx, item) in item_names.iter().enumerate() {
            let mut vf = ValueField::new(
                resolve(&v.measure_name, Some(item), measure_start + m_idx * k + i_idx),
                format!("[{}]", v.measure_name),
                AggregationType::Sum,
            );
            vf.calc_item = Some(item.clone());
            vf.custom_name = Some(match &v.custom_name {
                Some(c) => format!("{} [{}]", c, item),
                None => format!("{} [{}]", v.measure_name, item),
            });
            vfs.push(vf);
        }
    }
    vfs
}

#[cfg(test)]
mod split_bi_field_key_tests {
    use super::split_bi_field_key;

    #[test]
    fn dotted_table_names_resolve_by_longest_prefix() {
        let tables = ["BI.dim_customer", "BI.fact_sales", "dim_date"];
        // Schema-qualified table: the longest matching table name wins,
        // not the first-dot split (which would yield table "BI").
        assert_eq!(
            split_bi_field_key("BI.dim_customer.fullname", tables.iter().copied()),
            ("BI.dim_customer".to_string(), "fullname".to_string())
        );
        // Plain table name still resolves.
        assert_eq!(
            split_bi_field_key("dim_date.year", tables.iter().copied()),
            ("dim_date".to_string(), "year".to_string())
        );
        // Unknown dotted key falls back to the first-dot split.
        assert_eq!(
            split_bi_field_key("Orders.Amount", tables.iter().copied()),
            ("Orders".to_string(), "Amount".to_string())
        );
        // Bare column name: no table.
        assert_eq!(
            split_bi_field_key("Amount", tables.iter().copied()),
            (String::new(), "Amount".to_string())
        );
        // A key that IS a table name exactly (no column part) must not match
        // the prefix rule; falls back to the first-dot split.
        assert_eq!(
            split_bi_field_key("BI.fact_sales", tables.iter().copied()),
            ("BI".to_string(), "fact_sales".to_string())
        );
    }
}

#[cfg(test)]
mod calc_group_expand_tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn resolve_field_indices_maps_names_and_errors_on_missing() {
        let available = vec![
            "Region".to_string(),
            "Revenue".to_string(),
            "Quarter".to_string(),
        ];
        // Names resolve to their 0-based positions, preserving order.
        assert_eq!(
            resolve_field_indices(&["Revenue".to_string(), "Region".to_string()], &available).unwrap(),
            vec![1, 0]
        );
        // A missing name errors and lists the available columns.
        let err = resolve_field_indices(&["Nope".to_string()], &available).unwrap_err();
        assert!(err.contains("Nope"));
        assert!(err.contains("Region"), "error lists available columns");
        // Empty input -> empty output.
        assert!(resolve_field_indices(&[], &available).unwrap().is_empty());
    }

    fn vf(name: &str) -> crate::pivot::types::BiValueFieldRef {
        crate::pivot::types::BiValueFieldRef {
            measure_name: name.to_string(),
            custom_name: None,
        }
    }

    /// Empty metadata map => expand falls back to positional indices.
    fn no_meta() -> HashMap<(String, Option<String>), usize> {
        HashMap::new()
    }

    #[test]
    fn no_calc_group_one_field_per_measure() {
        let fields = vec![vf("Revenue"), vf("Cost")];
        let out = expand_bi_value_fields(&fields, &[], 3, &no_meta());
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].source_index, 3);
        assert_eq!(out[0].name, "[Revenue]");
        assert!(out[0].calc_item.is_none());
        assert_eq!(out[1].source_index, 4);
        assert_eq!(out[1].name, "[Cost]");
        assert!(out[1].calc_item.is_none());
    }

    #[test]
    fn calc_group_expands_measures_outer_items_inner() {
        let fields = vec![vf("Revenue"), vf("Cost")];
        let items = vec!["Current".to_string(), "YTD".to_string(), "PY".to_string()];
        let out = expand_bi_value_fields(&fields, &items, 2, &no_meta());
        // 2 measures x 3 items = 6 fields, contiguous from measure_start = 2.
        assert_eq!(out.len(), 6);
        let cols: Vec<usize> = out.iter().map(|f| f.source_index).collect();
        assert_eq!(cols, vec![2, 3, 4, 5, 6, 7]);
        // measures-outer / items-inner ordering.
        assert_eq!(out[0].name, "[Revenue]");
        assert_eq!(out[0].calc_item.as_deref(), Some("Current"));
        assert_eq!(out[0].custom_name.as_deref(), Some("Revenue [Current]"));
        assert_eq!(out[2].calc_item.as_deref(), Some("PY"));
        assert_eq!(out[3].name, "[Cost]");
        assert_eq!(out[3].calc_item.as_deref(), Some("Current"));
        assert_eq!(out[3].custom_name.as_deref(), Some("Cost [Current]"));
    }

    #[test]
    fn custom_base_name_combines_with_item_and_keeps_clean_key() {
        let mut f = vf("Revenue");
        f.custom_name = Some("Sales".to_string());
        let out = expand_bi_value_fields(&[f], &["YTD".to_string()], 0, &no_meta());
        assert_eq!(out[0].custom_name.as_deref(), Some("Sales [YTD]"));
        // name stays the clean base measure key so it round-trips to the measure.
        assert_eq!(out[0].name, "[Revenue]");
        assert_eq!(out[0].calc_item.as_deref(), Some("YTD"));
    }

    #[test]
    fn metadata_index_overrides_positional_order() {
        // Engine reports the (measure, item) columns in a DIFFERENT order than the
        // positional measures-outer/items-inner layout. The value fields must
        // follow the engine metadata, not the positional arithmetic.
        let fields = vec![vf("Revenue"), vf("Cost")];
        let items = vec!["Current".to_string(), "YTD".to_string()];
        // Shuffled column indices (measure_start would be 2 -> positional 2,3,4,5).
        let mut meta: HashMap<(String, Option<String>), usize> = HashMap::new();
        meta.insert(("Revenue".to_string(), Some("Current".to_string())), 7);
        meta.insert(("Revenue".to_string(), Some("YTD".to_string())), 5);
        meta.insert(("Cost".to_string(), Some("Current".to_string())), 4);
        meta.insert(("Cost".to_string(), Some("YTD".to_string())), 6);
        let out = expand_bi_value_fields(&fields, &items, 2, &meta);
        // Order of value FIELDS is unchanged (measures-outer/items-inner), but each
        // field's source_index comes from the metadata, not the positional guess.
        assert_eq!(out[0].calc_item.as_deref(), Some("Current"));
        assert_eq!(out[0].source_index, 7); // Revenue/Current
        assert_eq!(out[1].source_index, 5); // Revenue/YTD
        assert_eq!(out[2].source_index, 4); // Cost/Current
        assert_eq!(out[3].source_index, 6); // Cost/YTD
    }

    #[test]
    fn metadata_index_used_without_calc_group() {
        let fields = vec![vf("Revenue"), vf("Cost")];
        let mut meta: HashMap<(String, Option<String>), usize> = HashMap::new();
        meta.insert(("Revenue".to_string(), None), 9);
        meta.insert(("Cost".to_string(), None), 8);
        let out = expand_bi_value_fields(&fields, &[], 1, &meta);
        assert_eq!(out[0].source_index, 9);
        assert_eq!(out[1].source_index, 8);
    }
}

pub(crate) fn extract_bi_model_metadata(
    engine: &bi_engine::Engine,
) -> (
    Vec<BiModelTableMeta>,
    Vec<MeasureFieldInfo>,
    Vec<BiHierarchyMeta>,
    Vec<BiCalcGroupMeta>,
    Vec<super::types::BiPerspectiveMeta>,
    Vec<super::types::BiCultureMeta>,
) {
    let model = engine.model();

    // Object-level security: when the engine's ACTIVE role denies tables or
    // columns, hide them from the field list. Presentation-side only — the
    // engine's own OLS query gate is the authoritative (fail-closed) control.
    let mut ols_denied_tables: Vec<String> = Vec::new();
    let mut ols_denied_cols: Vec<(String, String)> = Vec::new();
    for role_name in engine.active_roles() {
        let Ok(role) = model.security_role(role_name) else {
            continue;
        };
        ols_denied_tables.extend(role.denied_tables().iter().cloned());
        for r in role.denied_columns() {
            let r = r.trim();
            let Some(open) = r.find('[') else { continue };
            let Some(body) = r.strip_suffix(']') else { continue };
            ols_denied_cols.push((
                body[..open].trim().to_string(),
                body[open + 1..].trim().to_string(),
            ));
        }
    }
    let table_denied = |t: &str| {
        ols_denied_tables.iter().any(|d| d.eq_ignore_ascii_case(t))
    };
    let col_denied = |t: &str, c: &str| {
        table_denied(t)
            || ols_denied_cols
                .iter()
                .any(|(dt, dc)| dt.eq_ignore_ascii_case(t) && dc.eq_ignore_ascii_case(c))
    };

    let tables: Vec<BiModelTableMeta> = model
        .tables()
        .iter()
        .filter(|t| !table_denied(t.name()))
        // Hidden writeback STORE tables are synthesized machinery; only an
        // exposed history table (designer opt-in) appears in the field list.
        .filter(|t| !t.is_writeback_store() || !t.is_hidden())
        .map(|t| {
            let is_numeric_dt = |dt: &bi_engine::DataType| {
                matches!(
                    dt,
                    bi_engine::DataType::Int32
                        | bi_engine::DataType::Int64
                        | bi_engine::DataType::Float64
                        | bi_engine::DataType::Decimal(_, _)
                )
            };
            let mut columns: Vec<BiModelColumnMeta> = t
                .columns()
                .iter()
                .filter(|c| !col_denied(t.name(), c.name()))
                .map(|c| {
                    let dt = c.data_type();
                    BiModelColumnMeta {
                        name: c.name().to_string(),
                        data_type: format!("{:?}", dt),
                        is_numeric: is_numeric_dt(dt),
                        lookup_resolution: c.lookup_resolution().map(|s| s.to_string()),
                        sort_by_column: c.sort_by_column().map(|s| s.to_string()),
                        is_context_column: false,
                        is_writeback_column: false,
                        description: c.description().map(|s| s.to_string()),
                    }
                })
                .collect();
            // Context columns: Studio-authored dynamic-segmentation columns. They
            // are not physical columns but ARE groupable like ordinary dimensions
            // (the engine computes them when they appear in group_by), so surface
            // them in the field list alongside the table's columns.
            for cc in model.context_columns_for_table(t.name()) {
                if col_denied(t.name(), cc.name()) {
                    continue;
                }
                let dt = cc.data_type();
                columns.push(BiModelColumnMeta {
                    name: cc.name().to_string(),
                    data_type: format!("{:?}", dt),
                    is_numeric: is_numeric_dt(dt),
                    lookup_resolution: None,
                    sort_by_column: None,
                    is_context_column: true,
                    is_writeback_column: false,
                    description: cc.description().map(|s| s.to_string()),
                });
            }
            // Writeback columns (engine v21): end-user input columns, served
            // by their generated lookup column — groupable like dimensions.
            for wb in model
                .writeback_columns()
                .iter()
                .filter(|wb| wb.table().eq_ignore_ascii_case(t.name()))
            {
                if col_denied(t.name(), wb.name()) {
                    continue;
                }
                let dt = wb.data_type();
                columns.push(BiModelColumnMeta {
                    name: wb.name().to_string(),
                    data_type: format!("{:?}", dt),
                    is_numeric: is_numeric_dt(dt),
                    lookup_resolution: None,
                    sort_by_column: None,
                    is_context_column: false,
                    is_writeback_column: true,
                    description: wb.description().map(|s| s.to_string()),
                });
            }
            BiModelTableMeta {
                name: t.name().to_string(),
                columns,
            }
        })
        .collect();

    let measures: Vec<MeasureFieldInfo> = model
        .measures()
        .iter()
        .filter(|m| !table_denied(m.table()))
        .map(|m| {
            let source_column = m.simple_column().unwrap_or("").to_string();
            let aggregation = m
                .simple_operation()
                .map(|op| format!("{:?}", op).to_lowercase())
                .unwrap_or_else(|| "expression".to_string());
            MeasureFieldInfo {
                name: m.name().to_string(),
                table: m.table().to_string(),
                source_column,
                aggregation,
            }
        })
        .collect();

    let hierarchies: Vec<BiHierarchyMeta> = model
        .hierarchies()
        .iter()
        .filter(|h| {
            !table_denied(h.table())
                && !h.levels().iter().any(|l| col_denied(h.table(), l.column()))
        })
        .map(|h| {
            let levels = h
                .levels()
                .iter()
                .map(|l| BiHierarchyLevelMeta {
                    column: l.column().to_string(),
                    display_name: l.display_name().map(|s| s.to_string()),
                    optional: l.is_optional(),
                })
                .collect();
            let ragged_behavior = match h.ragged_behavior() {
                bi_engine::RaggedBehavior::ShowBlanks => BiRaggedBehavior::ShowBlanks,
                bi_engine::RaggedBehavior::HideMembers => BiRaggedBehavior::HideMembers,
                bi_engine::RaggedBehavior::RepeatParent => BiRaggedBehavior::RepeatParent,
                bi_engine::RaggedBehavior::ShowAsLeaf => BiRaggedBehavior::ShowAsLeaf,
            };
            BiHierarchyMeta {
                name: h.name().to_string(),
                table: h.table().to_string(),
                levels,
                ragged_behavior,
            }
        })
        .collect();

    // Calculation groups: measure templates applied on the Values axis. They
    // are model-global (no per-table binding in the engine model), so no OLS
    // filtering applies.
    let calculation_groups: Vec<BiCalcGroupMeta> = extract_calc_groups(engine);

    // Perspectives: named presentation subsets for the field list. Display
    // metadata only -- selecting one filters what the field list SHOWS.
    let perspectives: Vec<super::types::BiPerspectiveMeta> = model
        .perspectives()
        .iter()
        .map(|p| super::types::BiPerspectiveMeta {
            name: p.name().to_string(),
            tables: p.tables().to_vec(),
            columns: p.columns().to_vec(),
            measures: p.measures().to_vec(),
            description: p.description().map(|s| s.to_string()),
        })
        .collect();

    // Cultures: per-locale metadata translations. Display metadata only --
    // the frontend swaps field-list labels; keys and queries stay raw.
    let cultures: Vec<super::types::BiCultureMeta> = model
        .cultures()
        .iter()
        .map(|c| {
            let tr = |t: &bi_engine::NameTranslation| super::types::BiNameTranslationMeta {
                object: t.object.clone(),
                display_name: t.display_name.clone(),
                description: t.description.clone(),
            };
            super::types::BiCultureMeta {
                locale: c.locale().to_string(),
                tables: c.tables().iter().map(tr).collect(),
                columns: c.columns().iter().map(tr).collect(),
                measures: c.measures().iter().map(tr).collect(),
            }
        })
        .collect();

    (tables, measures, hierarchies, calculation_groups, perspectives, cultures)
}

/// Extract just the model's calculation groups. Model-global (no per-table
/// binding), so no OLS filtering applies. Also used to re-read the CURRENT
/// groups when a pivot's creation-time metadata snapshot has gone stale
/// (groups added/edited in the Model Editor after the pivot was created).
pub(crate) fn extract_calc_groups(engine: &bi_engine::Engine) -> Vec<BiCalcGroupMeta> {
    engine
        .model()
        .calculation_groups()
        .iter()
        .map(|g| BiCalcGroupMeta {
            name: g.name().to_string(),
            items: g
                .items()
                .iter()
                .map(|i| BiCalcGroupItemMeta {
                    name: i.name().to_string(),
                    source: i.source().map(|s| s.to_string()),
                })
                .collect(),
            multiple_or_empty_selection: g
                .multiple_or_empty_selection()
                .map(|t| t.source().unwrap_or("(expression)").to_string()),
            no_selection: g
                .no_selection()
                .map(|t| t.source().unwrap_or("(expression)").to_string()),
        })
        .collect()
}

/// Creates an empty BI pivot from the full model (all tables + measures).
/// No data query is executed — the field list comes from model metadata.
#[tauri::command]
pub async fn create_pivot_from_bi_model(
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    bi_state: State<'_, BiState>,
    request: CreatePivotFromBiModelRequest,
) -> Result<PivotViewResponse, String> {
    // NOTHING BELOW WRITES PERSISTED STATE UNTIL THE DESTINATION IS DECIDED, and
    // it is decided only AFTER the last `.await`. The canvas gate used to run up
    // here, before the engine lock and the connect/bind awaits (which can take
    // seconds against a database), while the destination was re-read from the
    // active sheet afterwards -- so a user who clicked a canvas tab while the
    // model connected got the grid pivot written into the canvas's hidden grid
    // and named after it. See "Parse destination" below.
    let connection_id = request.connection_id;
    log_info!(
        "PIVOT",
        "create_pivot_from_bi_model dest={} dest_sheet={:?} conn_id={}",
        request.destination_cell,
        request.destination_sheet,
        connection_id
    );

    // Extract model metadata from the connection's engine (reads the in-memory
    // model; no DB connection required, so this works offline).
    let (model_tables, measures, hierarchies, calc_groups, perspectives, cultures) = {
        let engine_arc = {
            let connections = bi_state.connections.lock().unwrap();
            let conn = connections.get(&connection_id)
                .ok_or_else(|| format!("Connection {} not found", connection_id))?;
            conn.engine.clone().ok_or("No BI model loaded.")?
        };
        let mut engine = engine_arc.lock().await;
        // Sync the connection's active RLS role onto the engine so the OLS
        // field-list filtering inside extract_bi_model_metadata sees it.
        crate::bi::commands::apply_connection_role(&mut engine, &bi_state, connection_id);
        let result = extract_bi_model_metadata(&engine);
        log_info!(
            "PIVOT",
            "extract_bi_model_metadata: {} tables, {} measures, {} hierarchies",
            result.0.len(),
            result.1.len(),
            result.2.len()
        );
        for t in &result.0 {
            log_info!("PIVOT", "  table: {} ({} columns)", t.name, t.columns.len());
        }
        for m in &result.1 {
            log_info!("PIVOT", "  measure: {} (table={})", m.name, m.table);
        }
        for h in &result.2 {
            log_info!("PIVOT", "  hierarchy: {} (table={}, {} levels)", h.name, h.table, h.levels.len());
        }
        result
    };

    // Connect + bind only when the model's tables aren't already cache-warm.
    // Offline (a restored connection with embedded cache) this is skipped so a
    // pivot can be created and queried without a live DB.
    let table_names: Vec<&str> = model_tables.iter().map(|t| t.name.as_str()).collect();
    if !bi_tables_cache_warm(&bi_state, connection_id, &table_names).await {
        auto_connect_bi_connection(&bi_state, connection_id).await?;
        auto_bind_tables_on_connection(&bi_state, connection_id, &table_names).await?;
    }

    log_info!(
        "PIVOT",
        "BI model: {} tables, {} measures",
        model_tables.len(),
        measures.len()
    );

    // Parse destination -- ONCE, after the last await, and this one index is
    // what the gate checks, what `destination_sheet` names, where the region is
    // registered and where the cells are written. The active sheet is copied
    // out first so no `active_sheet` guard is alive while the gate takes
    // `sheet_kinds`.
    let active_sheet_now = *state.active_sheet.read().unwrap();
    let dest_sheet_idx = request.destination_sheet.unwrap_or(active_sheet_now);
    let dest_is_canvas = {
        let kinds = state.sheet_kinds.read().unwrap();
        crate::sheets::is_canvas_sheet(&kinds, dest_sheet_idx)
    };

    // A CANVAS destination needs a frame and gets its anchor from the canvas
    // block allocator (`destination_cell` is ignored). A WORKSHEET destination
    // refuses a frame -- and a GRID pivot writes its output as visible cells,
    // which on a canvas would be invisible (the literal gate the census pins).
    let (destination, canvas_frame) = if dest_is_canvas {
        let frame = canvas_create_frame(request.canvas_frame, dest_sheet_idx)?;
        (allocate_canvas_pivot_anchor(&state, dest_sheet_idx)?, Some(frame))
    } else {
        crate::sheets::ensure_not_canvas_in_state(&state, dest_sheet_idx, "create a grid pivot table")?;
        if request.canvas_frame.is_some() {
            return Err(frame_on_worksheet_refusal(dest_sheet_idx));
        }
        (parse_cell_ref(&request.destination_cell)?, None)
    };

    // Check that destination doesn't overlap an existing pivot table
    check_pivot_overlap(&state, dest_sheet_idx, destination)?;

    // Creating a pivot: every refusal is behind us -- the connection, the
    // destination's kind, the frame and the overlap -- so the command commits
    // here. (The placeholder view is EMPTY, so a canvas pivot's block width
    // cannot be exceeded at this point; later writes check it.)
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);

    // Generate pivot ID
    let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    // Create empty definition (no fields yet)
    let mut definition = PivotDefinition::new(pivot_id, (0, 0), (0, 0));
    definition.destination = destination;
    definition.canvas_frame = canvas_frame;
    definition.name = request.name.or_else(|| Some(format!("PivotTable{}", pivot_id)));
    {
        let sheet_names = state.sheet_names.read().unwrap();
        if dest_sheet_idx < sheet_names.len() {
            definition.destination_sheet = Some(sheet_names[dest_sheet_idx].clone());
        }
    }

    // Create empty cache (0 fields)
    let cache = PivotCache::new(pivot_id, 0);

    // The CLEAN pre-calc cache, kept for the undo snapshot — the same rule
    // `create_pivot_inner` documents: a post-calc cache can hold computed maps
    // with non-string keys that serde_json refuses, which would silently write
    // an EMPTY snapshot and make undo unable to delete the pivot.
    let undo_cache = cache.clone();

    // Calculate initial view (will be empty)
    let mut cache_mut = cache;
    let view = safe_calculate_pivot(&definition, &mut cache_mut);
    store_view(&pivot_state, pivot_id, &view);
    let response = view_to_response(&view, &definition, &mut cache_mut);

    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    // Write empty pivot placeholder to grid
    {
        // CANONICAL LOCK ORDER: `grid`, then `grids`, then everything else
        // (the style registry included). The recalculation pass holds both grid
        // locks and then takes `style_registry` on a background thread.
        let mut grid = state.grid.write(&effect).unwrap();
        let mut grids = state.grids.write(&effect).unwrap();
        let mut styles = state.style_registry.write(&effect).unwrap();
        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            let active_sheet = *state.active_sheet.read().unwrap();
            let pivot_merges = if dest_sheet_idx == active_sheet {
                let merges = write_pivot_to_grid(dest_grid, Some(&mut grid), &view, destination, &mut styles);
                grid.recalculate_bounds();
                merges
            } else {
                write_pivot_to_grid(dest_grid, None, &view, destination, &mut styles)
            };

            // Update merge regions -- the DESTINATION sheet's set, not the
            // active sheet's mirror (see `update_pivot_in_grid`).
            if !pivot_merges.is_empty() {
                crate::report::with_sheet_merges_mut(&state, &effect, dest_sheet_idx, |merged| {
                    // Clear merges in pivot region first
                    let (dr, dc) = destination;
                    let er = dr + view.row_count.max(1) as u32 - 1;
                    let ec = dc + view.col_count.max(1) as u32 - 1;
                    merged.retain(|m| {
                        !(m.start_row >= dr && m.end_row <= er && m.start_col >= dc && m.end_col <= ec)
                    });
                    for mr in pivot_merges {
                        merged.insert(mr);
                    }
                });
            }
        }
    }

    // Store pivot
    let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
    let undo_definition = definition.clone();
    pivot_tables.insert(pivot_id, (definition, cache_mut));
    drop(pivot_tables);

    // Record undo for the creation (undo = delete the pivot), exactly as the
    // grid-source `create_pivot_inner` does.
    //
    // THIS COMMAND RECORDED NOTHING UNTIL NOW. Creating a pivot from a BI model
    // wrote a definition into `PivotState.pivot_tables` that Ctrl+Z could not
    // remove — the pivot stayed on the sheet and in the saved workbook for ever.
    // It is the exact symptom BUG-0015 describes, on a path the ledgered bug
    // never named, and the undo oracle could not report it because a blanket
    // `pivots.` suppression was filtering the whole subtree.
    {
        #[derive(serde::Serialize)]
        struct PivotFullSnapshot {
            pivot_id: PivotId,
            definition: PivotDefinition,
            cache: PivotCache,
        }
        let snapshot = PivotFullSnapshot {
            pivot_id,
            definition: undo_definition,
            cache: undo_cache,
        };
        let data = serde_json::to_vec(&snapshot).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let owned_txn = undo_stack.begin_owned_transaction("Create pivot table");
        undo_stack.record_custom_restore("pivot_create".to_string(), data, "Create pivot table");
        undo_stack.commit_owned(owned_txn);
    }

    // Set as active pivot
    *pivot_state.active_pivot_id.lock().unwrap() = Some(pivot_id);

    // Store BI metadata
    let bi_meta = BiPivotMetadata {
        connection_id,
        // On the authoring machine the live connection UUID is the package
        // data source id used at publish time.
        data_source_id: Some(connection_id.to_string()),
        model_tables,
        measures,
        hierarchies,
        calculation_groups: calc_groups,
        data_as_of: None,
        last_query: None,
        lookup_columns: std::collections::HashSet::new(),
        drill_through: None,
        perspectives,
        selected_perspective: None,
        cultures,
    };
    pivot_state
        .bi_metadata
        .write(&effect)
        .unwrap()
        .insert(pivot_id, bi_meta);

    log_info!(
        "PIVOT",
        "created BI pivot_id={} conn_id={} (empty - awaiting field configuration)",
        pivot_id,
        connection_id
    );

    Ok(response)
}

/// Which zone a placed calculation group occupies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CalcGroupAxis {
    Rows,
    Columns,
    Filters,
}

/// A calculation group placed on a pivot as a dimension (Power BI-style):
/// stripped out of the request's field lists before the engine query and
/// spliced back into the definition as a real field over the reshaped cache.
#[derive(Debug, Clone)]
struct CalcGroupPlacement {
    group: String,
    axis: CalcGroupAxis,
    /// Index within its zone's field list (chip order).
    position: usize,
    /// Items hidden from the view (subset selection), like any field filter.
    hidden_items: Vec<String>,
}

/// Updates field assignments on a BI-backed pivot, re-querying the BI engine.
#[tauri::command]
pub async fn update_bi_pivot_fields(
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    bi_state: State<'_, BiState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    request: UpdateBiPivotFieldsRequest,
) -> Result<PivotViewResponse, String> {
    let ctx = PivotCmdCtx {
        state: &state,
        file_state: &file_state,
        pivot_state: &pivot_state,
        pane_control_state: &pane_control_state,
        ribbon_filter_state: &ribbon_filter_state,
        user_files_state: &user_files_state,
        bi_state: &bi_state,
        slicer_state: &slicer_state,
        record_undo: true,
    };
    update_bi_pivot_fields_core(&ctx, request).await
}

/// [`update_bi_pivot_fields`] over borrowed state.
///
/// Three rules on top of the field assignment itself:
/// - `slicer_fields: None` KEEPS the slicer fields the pivot carries (P1: a
///   field-list edit used to drop every slicer and ribbon filter on the pivot);
///   `Some([])` clears them. Kept fields are read from the OLD definition and
///   cache before the query is built, because a slicer filter stores only a
///   cache index and the new cache renumbers every column.
/// - Every zone honours the request's hidden items and otherwise carries the
///   old definition's by Table.Column NAME; a slicer field that is also a zone
///   field is merged into it and its hidden items move with it.
/// - The active MODEL slicers on the pivot's own sheet (owner decision 2, the
///   page rule) are folded in: their column joins the query and their
///   selection is applied to the new cache in this same command and undo
///   step, so a pivot created or rebuilt on the page is filtered at once.
///
/// Records ONE "Pivot table field change" step (joining an open transaction)
/// unless the context records nothing (`record_undo: false`).
pub(crate) async fn update_bi_pivot_fields_core(
    ctx: &PivotCmdCtx<'_>,
    request: UpdateBiPivotFieldsRequest,
) -> Result<PivotViewResponse, String> {
    let (mut response, undo) = update_bi_pivot_fields_unrecorded(ctx, request, Vec::new()).await?;
    if ctx.record_undo {
        if let Some(undo) = undo {
            response.overwrite_token = undo.record(ctx.state, "Pivot table field change");
        }
    }
    Ok(response)
}

/// [`update_bi_pivot_fields_core`] that hands its undo step BACK instead of
/// recording it (every successful path hands one back today; `None` is room
/// for a path that changes nothing). For a caller that records the gesture
/// itself, from state it captured before its own edit.
///
/// `masks` (see [`PostQueryMask`]; empty for every field-list edit) are
/// folded into the fresh records exactly as the page fold folds a model
/// slicer: each is carried in the query (added as a slicer field when nothing
/// else carries its column) and masks "every value it did not select" of the
/// NEW cache, AFTER the page fold, so the gesture's own selection wins.
pub(crate) async fn update_bi_pivot_fields_unrecorded(
    ctx: &PivotCmdCtx<'_>,
    request: UpdateBiPivotFieldsRequest,
    masks: Vec<PostQueryMask>,
) -> Result<(PivotViewResponse, Option<BiFieldChangeUndo>), String> {
    let state = ctx.state;
    let file_state = ctx.file_state;
    let pivot_state = ctx.pivot_state;
    let pane_control_state = ctx.pane_control_state;
    let ribbon_filter_state = ctx.ribbon_filter_state;
    let user_files_state = ctx.user_files_state;
    let bi_state = ctx.bi_state;

    // Refusal-first: verify the pivot exists BEFORE minting the eager `mutates`
    // token, so a refused command leaves the document clean.
    let effect = pivot_mutation_token(state, pivot_state, file_state, request.pivot_id)?;

    let t_total = Instant::now();
    log_info!("PIVOT", "update_bi_pivot_fields pivot_id={}", request.pivot_id);

    let pivot_id = request.pivot_id;

    // Resolve names against the LIVE model: a table or column added in the
    // Model Editor since the pivot was created is part of the query below, so
    // the kept slicer fields, the carried hidden items and the page fold must
    // be able to name it too.
    refresh_bi_model_snapshot(ctx, pivot_id).await?;

    // Verify pivot exists and is BI-backed; keep the metadata this command
    // resolves names against (a snapshot: the lock is not held below).
    let meta_snapshot: BiPivotMetadata = {
        let bi_meta = pivot_state.bi_metadata.read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        bi_meta
            .get(&pivot_id)
            .cloned()
            .ok_or_else(|| format!("Pivot {} is not a BI-backed pivot", pivot_id))?
    };

    // ---- Calculation-group placement (Power BI-style dimension) ----
    // A calculation group arrives as a pseudo field ref (table = CALC_GROUP_TABLE)
    // inside the row/column/filter lists. Strip it out here: the engine query
    // must not GROUP BY it — the engine cross-applies the group's items to the
    // measures instead — and the wide result is reshaped below so the group
    // becomes a REAL cache dimension whose members are the calculation items.
    let mut request = request;
    let mut placement: Option<CalcGroupPlacement> = None;
    {
        let mut take = |fields: &mut Vec<BiFieldRef>, axis: CalcGroupAxis| -> Result<(), String> {
            while let Some(pos) = fields.iter().position(|f| f.is_calc_group()) {
                let f = fields.remove(pos);
                if placement.is_some() {
                    return Err(
                        "Only one calculation group can be placed on a pivot at a time."
                            .to_string(),
                    );
                }
                placement = Some(CalcGroupPlacement {
                    group: f.column,
                    axis,
                    position: pos,
                    hidden_items: f.hidden_items.unwrap_or_default(),
                });
            }
            Ok(())
        };
        take(&mut request.row_fields, CalcGroupAxis::Rows)?;
        take(&mut request.column_fields, CalcGroupAxis::Columns)?;
        take(&mut request.filter_fields, CalcGroupAxis::Filters)?;
    }
    if request
        .slicer_fields
        .as_ref()
        .is_some_and(|list| list.iter().any(|f| f.is_calc_group()))
    {
        return Err("A calculation group can't be used as a slicer field yet.".to_string());
    }

    // Save previous state for revert-on-cancel AND for undo.
    //
    // BOTH HALVES, because every path below either re-queries the model for a
    // new cache or replaces it with an empty one: putting the old definition
    // back on its own would render it against records it was never written for
    // (BUG-0021). This is the same pair `previous_states` already keeps for the
    // cancel path — undo just needs to outlive the command.
    let (old_definition, old_cache) = {
        let pivot_tables = pivot_state.pivot_tables.read()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        let (def, cache) = pivot_tables
            .get(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
        let pair = (def.clone(), cache.clone());
        if let Ok(mut prev) = pivot_state.previous_states.lock() {
            prev.insert(pivot_id, pair.clone());
        }
        pair
    };

    // ---- Slicer fields: explicit, or KEPT (P1) ----
    // A pivot being emptied keeps nothing: a query of the slicer columns alone
    // is not a pivot anyone asked for.
    let otherwise_empty = request.value_fields.is_empty()
        && request.row_fields.is_empty()
        && request.column_fields.is_empty()
        && request.filter_fields.is_empty()
        && request.row_hierarchies.is_empty()
        && request.column_hierarchies.is_empty()
        && placement.is_none();
    // The pivot's sheet, resolved once with no pivot lock held (the old
    // definition is a clone).
    let dest_sheet = resolve_dest_sheet_index(state, &old_definition);

    // (table, column) of every hierarchy level the request places, for the
    // dedupe below (levels are GROUP BY columns too).
    let hierarchy_level_keys: std::collections::HashSet<(String, String)> = request
        .row_hierarchies
        .iter()
        .chain(request.column_hierarchies.iter())
        .filter_map(|href| {
            meta_snapshot
                .hierarchies
                .iter()
                .find(|h| h.name == href.hierarchy && h.table == href.table)
        })
        .flat_map(|h| h.levels.iter().map(move |l| (h.table.clone(), l.column.clone())))
        .collect();
    let zone_carries = |request: &UpdateBiPivotFieldsRequest, table: &str, column: &str| -> bool {
        request
            .row_fields
            .iter()
            .chain(request.column_fields.iter())
            .chain(request.filter_fields.iter())
            .any(|f| !f.is_lookup && f.table == table && f.column == column)
            || hierarchy_level_keys.contains(&(table.to_string(), column.to_string()))
    };

    let mut slicer_fields: Vec<BiFieldRef> = match &request.slicer_fields {
        Some(list) => list.clone(),
        None if otherwise_empty => Vec::new(),
        None => {
            let mut kept = slicer_fields_from_definition(&old_definition, &old_cache, &meta_snapshot);
            // A slicer's or ribbon filter's mask can live on a ZONE field (it
            // was applied while the column was a row/column/filter field, or
            // the dedupe below moved it there). When that field now LEAVES the
            // layout, the filter must stay -- Excel and Power BI keep a
            // slicer's filter when its field is taken off the pivot -- so it
            // goes back to being a slicer field, but ONLY while a live
            // external filter still holds that column. A plain header-dropdown
            // filter on a field that leaves the layout is dropped, as in Excel.
            let external = external_filter_columns(ctx, pivot_id, &meta_snapshot, dest_sheet)?;
            let table_names: Vec<&str> = meta_snapshot.model_tables.iter().map(|t| t.name.as_str()).collect();
            for f in old_definition
                .row_fields
                .iter()
                .chain(old_definition.column_fields.iter())
                .chain(old_definition.filter_fields.iter().map(|f| &f.field))
            {
                if f.hidden_items.is_empty() {
                    continue;
                }
                let (table, column) = split_bi_field_key(&f.name, table_names.iter().copied());
                let key = (table, column);
                if !external.contains(&key)
                    || zone_carries(&request, &key.0, &key.1)
                    || kept.iter().any(|k| k.table == key.0 && k.column == key.1)
                {
                    continue;
                }
                kept.push(BiFieldRef {
                    table: key.0,
                    column: key.1,
                    is_lookup: false,
                    hidden_items: Some(f.hidden_items.clone()),
                });
            }
            kept
        }
    };

    // ---- The page's model slicers (owner decision 2) ----
    // Resolved from the slicer store here, never from the frontend: a pivot
    // added to a filtered canvas, or rebuilt by the field list, must come out
    // filtered in THIS command, with no second write from a view listener.
    let page_slicers: Vec<PageModelSlicer> = if otherwise_empty {
        Vec::new()
    } else {
        let slicers = ctx.slicer_state.slicers.read().map_err(|e| e.to_string())?;
        page_model_slicers(slicers.values(), &meta_snapshot, dest_sheet)
    };

    // The gesture's own post-query masks (see `PostQueryMask`): like the
    // page's slicers, none for a pivot being emptied.
    let masks: Vec<PostQueryMask> = if otherwise_empty { Vec::new() } else { masks };

    for (table, column) in page_slicers
        .iter()
        .map(|ps| (&ps.table, &ps.column))
        .chain(masks.iter().map(|m| (&m.table, &m.column)))
    {
        let carried = zone_carries(&request, table, column)
            || slicer_fields.iter().any(|f| &f.table == table && &f.column == column);
        if !carried {
            slicer_fields.push(BiFieldRef {
                table: table.clone(),
                column: column.clone(),
                is_lookup: false,
                hidden_items: None,
            });
        }
    }

    // ---- Hidden items: honoured, else carried by NAME; dedupe ----
    let mut carried_hidden = hidden_items_by_model_key(&old_definition, &old_cache, &meta_snapshot);
    {
        let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
        let mut kept: Vec<BiFieldRef> = Vec::new();
        for sf in slicer_fields.drain(..) {
            let key = (sf.table.clone(), sf.column.clone());
            if !seen.insert(key.clone()) {
                continue; // a duplicate slicer field
            }
            let mut merged = false;
            for zf in request
                .row_fields
                .iter_mut()
                .chain(request.column_fields.iter_mut())
                .chain(request.filter_fields.iter_mut())
            {
                if !zf.is_lookup && zf.table == sf.table && zf.column == sf.column {
                    // The slicer's column is (now) a zone field: ONE GROUP BY
                    // column, and the filter moves onto the zone field rather
                    // than silently disappearing -- unless the caller SENT the
                    // zone field's hidden items (an explicit set or clear).
                    if zf.hidden_items.is_none() && !sf.hidden().is_empty() {
                        zf.hidden_items = sf.hidden_items.clone();
                    }
                    merged = true;
                }
            }
            if hierarchy_level_keys.contains(&key) {
                if !sf.hidden().is_empty() {
                    carried_hidden.insert(key, sf.hidden().to_vec());
                }
                merged = true;
            }
            if !merged {
                kept.push(sf);
            }
        }
        slicer_fields = kept;
    }
    for f in request
        .row_fields
        .iter_mut()
        .chain(request.column_fields.iter_mut())
        .chain(request.filter_fields.iter_mut())
        .chain(slicer_fields.iter_mut())
    {
        // ABSENT = carry what this Table.Column hides now; a sent list
        // (including `[]`, an explicit clear) is authoritative.
        if f.hidden_items.is_none() {
            if let Some(hidden) = carried_hidden.get(&(f.table.clone(), f.column.clone())) {
                f.hidden_items = Some(hidden.clone());
            }
        }
    }
    let request = request; // placement stripped, hidden items settled; immutable from here
    let slicer_fields = slicer_fields;
    // A page slicer whose column the pivot does not carry yet changes the
    // query: never the cosmetic fast path.
    let fold_adds_columns = page_slicers.iter().any(|ps| {
        resolve_bi_field_index(&old_definition, &old_cache, &meta_snapshot, &ps.table, &ps.column).is_none()
    });

    // Fast path: if only custom_name changed on value fields (no structural
    // changes to dimensions, measures, filters, layout, etc.), skip the
    // expensive BI query and just recalculate the view from the existing cache.
    {
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect)
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        if let Some((definition, stored_cache)) = pivot_tables.get_mut(&pivot_id) {
            // A placed calculation group was STRIPPED from the request's field
            // lists above, so the comparison can't see it — a "group only"
            // request would look identical to an empty pivot and wrongly
            // short-circuit against the stale cache. Never take the fast path
            // while a group is placed.
            // Also never take it when the caller demands fresh data
            // (refresh_pivot_cache) or when the stored cache has NO records —
            // a failed earlier query leaves an empty cache behind, and
            // re-applying the same fields must retry the query, not render
            // "Grand Total 0" from the empty cache forever.
            // A post-query mask exists only to be applied to FRESH records:
            // the fast path renders the old ones and never reaches the fold.
            let cosmetic_only = placement.is_none()
                && !request.force_requery
                && !fold_adds_columns
                && masks.is_empty()
                && !stored_cache.records.is_empty()
                && is_bi_cosmetic_only_change(definition, &request);
            if cosmetic_only {
                log_info!("PIVOT", "update_bi_pivot_fields: cosmetic-only change, skipping BI query");
                // Update custom names on existing value fields
                for (vf, req_vf) in definition.value_fields.iter_mut().zip(request.value_fields.iter()) {
                    vf.custom_name = req_vf.custom_name.clone();
                }
                // Apply layout if provided
                if let Some(ref layout_config) = request.layout {
                    apply_layout_config(&mut definition.layout, layout_config);
                }
                definition.bump_version();

                let view = safe_calculate_pivot(definition, stored_cache);
                store_view(&pivot_state, pivot_id, &view);
                let mut response = view_to_response(&view, definition, stored_cache);
                let destination = definition.destination;
                let auto_fit = definition.layout.auto_fit_column_widths;
                let framed = definition.canvas_frame.is_some();
                let dest_ref = PivotDestSheet::of(definition);
                drop(pivot_tables);
                let dest_sheet_idx = dest_ref.resolve(&state);

                let saved_cells = save_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
                response.overwritten_cell_count = saved_cells.len() as u32;
                let old_region = get_pivot_region(&state, pivot_id);
                update_pivot_in_grid(&state, &effect, pivot_id, dest_sheet_idx, destination, &view, framed)?;
                // The widths this fit overwrites now ride in the SAME undo step
                // as the change that caused them, exactly as the non-BI path
                // does. They used to be discarded because this command recorded
                // no step for them to join.
                let prev_col_widths = if auto_fit {
                    auto_fit_pivot_columns(&state, &effect, dest_sheet_idx, destination, &view)
                } else {
                    Vec::new()
                };
                update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
                recalc_after_pivot_write(
                    &state,
                    &pivot_state,
                    Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }),
                    dest_sheet_idx,
                    old_region.as_ref(),
                    destination,
                    &view,
                );

                // A cosmetic change renders the SAME records, so no cache
                // snapshot is needed (and one would be a large clone per rename).
                let undo = BiFieldChangeUndo {
                    pivot_id,
                    definition: old_definition,
                    overwritten_cells: saved_cells,
                    dest_sheet_idx,
                    prev_col_widths,
                    cache: None,
                };

                let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
                log_perf!("PIVOT", "update_bi_pivot_fields (cosmetic) pivot_id={} | TOTAL={:.1}ms", pivot_id, total_ms);

                return Ok((response, Some(undo)));
            }
        }
        drop(pivot_tables);
    }

    let has_values = !request.value_fields.is_empty();
    // A calculation group placed on rows/columns IS a dimension (its items are
    // the field's members), even though it was stripped from the field lists.
    let group_on_axis = matches!(
        placement.as_ref().map(|p| p.axis),
        Some(CalcGroupAxis::Rows) | Some(CalcGroupAxis::Columns)
    );
    let has_dimensions = !request.row_fields.is_empty() || !request.column_fields.is_empty()
        || !request.row_hierarchies.is_empty() || !request.column_hierarchies.is_empty()
        || group_on_axis;
    let has_filters = !request.filter_fields.is_empty();
    let has_slicer_fields = !slicer_fields.is_empty();

    // If no fields at all, clear to empty pivot
    if !has_values && !has_dimensions && !has_filters && !has_slicer_fields && placement.is_none() {
        log_info!("PIVOT", "No fields assigned, clearing to empty pivot");
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect)
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        let (definition, _cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

        definition.row_fields.clear();
        definition.column_fields.clear();
        definition.value_fields.clear();
        definition.filter_fields.clear();
        definition.calculated_fields.clear();
        definition.value_column_order.clear();
        definition.slicer_filters.clear();
        definition.engine_filters.clear();
        definition.bump_version();

        let empty_cache = PivotCache::new(pivot_id, 0);
        let view = create_empty_view(pivot_id, definition.version);
        let mut response = view_to_response(&view, definition, &mut empty_cache.clone());

        let destination = definition.destination;
        let dest_ref = PivotDestSheet::of(definition);
        drop(pivot_tables);
        let dest_sheet_idx = dest_ref.resolve(&state);

        // Replace cache with empty
        let mut pt = pivot_state.pivot_tables.write(&effect)
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        if let Some((_, cache)) = pt.get_mut(&pivot_id) {
            *cache = empty_cache;
        }
        drop(pt);

        response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
        finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;
        // The cache was REPLACED with an empty one, so the old records travel
        // with the old definition or the undo renders an empty pivot.
        let undo = BiFieldChangeUndo {
            pivot_id,
            definition: old_definition,
            overwritten_cells: Vec::new(),
            dest_sheet_idx,
            prev_col_widths: Vec::new(),
            cache: Some(old_cache),
        };
        return Ok((response, Some(undo)));
    }

    // When there are dimensions/filters but no user-selected measures, inject a
    // synthetic measure so the BI engine query succeeds (it requires >= 1 measure).
    // The synthetic measure column will be present in the cache but NOT mapped to
    // any value_field in the pivot definition, so the engine renders blank data cells
    // — matching Excel's behaviour of showing distinct dimension values without aggregates.
    let synthetic_measure: Option<String> = if !has_values && (has_dimensions || has_filters || has_slicer_fields) {
        let bi_meta = pivot_state.bi_metadata.read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        bi_meta.get(&pivot_id)
            .and_then(|m| m.measures.first())
            .map(|m| m.name.clone())
    } else {
        None
    };

    // If we need a synthetic measure but the model has none, we can't query the
    // BI engine. Save the field assignments to the definition (so they persist
    // across deselect/reselect) and show an empty pivot.
    if !has_values && synthetic_measure.is_none() && (has_dimensions || has_filters || has_slicer_fields) {
        log_info!("PIVOT", "No measures in model for synthetic query, saving fields only");
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect)
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        let (definition, stored_cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

        // Save field assignments (even though we can't compute)
        definition.row_fields = request.row_fields.iter()
            .map(|f| PivotField::new(0, format!("{}.{}", f.table, f.column)))
            .collect();
        definition.column_fields = request.column_fields.iter()
            .map(|f| PivotField::new(0, format!("{}.{}", f.table, f.column)))
            .collect();
        definition.value_fields.clear();
        definition.calculated_fields.clear();
        definition.value_column_order.clear();
        definition.filter_fields = request.filter_fields.iter()
            .map(|f| {
                let field = PivotField::new(0, format!("{}.{}", f.table, f.column));
                pivot_engine::PivotFilter {
                    field,
                    condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
                }
            })
            .collect();
        definition.bump_version();

        let empty_cache = PivotCache::new(pivot_id, 0);
        let view = create_empty_view(pivot_id, definition.version);
        let mut response = view_to_response(&view, definition, &mut empty_cache.clone());
        let destination = definition.destination;
        let dest_ref = PivotDestSheet::of(definition);
        *stored_cache = empty_cache;
        drop(pivot_tables);
        let dest_sheet_idx = dest_ref.resolve(&state);

        response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
        // The field assignments were written and the document dirtied, so this
        // returns Ok — but the user is looking at an EMPTY pivot that looks
        // exactly like a successful field change. Say why.
        response.notices.push(crate::pivot::types::PivotNotice::degraded(
            "No data: this model has no measure to list members with. The field assignments \
             were kept.",
        ));
        finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;
        // Same as the branch above: an empty cache replaced the records.
        let undo = BiFieldChangeUndo {
            pivot_id,
            definition: old_definition,
            overwritten_cells: Vec::new(),
            dest_sheet_idx,
            prev_col_widths: Vec::new(),
            cache: Some(old_cache),
        };
        return Ok((response, Some(undo)));
    }

    // Get the connection_id from BI metadata
    let connection_id = {
        let bi_meta = pivot_state.bi_metadata.read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        let meta = bi_meta.get(&pivot_id);
        log_info!("CALP-DIAG", "update_bi_pivot_fields: pivot_id={}, bi_metadata exists={}, connection_id={:?}",
            pivot_id, meta.is_some(), meta.map(|m| m.connection_id));
        meta.map(|m| m.connection_id)
            .ok_or_else(|| format!("No BI metadata for pivot {}", pivot_id))?
    };

    // Collect table names referenced in fields (for the cache-warmth check below
    // and for auto-binding when online).
    let mut referenced_tables: Vec<String> = Vec::new();
    for f in request.row_fields.iter()
        .chain(request.column_fields.iter())
        .chain(request.filter_fields.iter())
        .chain(slicer_fields.iter())
    {
        if !referenced_tables.contains(&f.table) {
            referenced_tables.push(f.table.clone());
        }
    }
    // Also include tables referenced by measures (e.g., fact_sales for SUM(fact_sales[linetotal]))
    {
        let bi_meta = pivot_state.bi_metadata.read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        if let Some(meta) = bi_meta.get(&pivot_id) {
            for measure_name in request.value_fields.iter().map(|v| &v.measure_name) {
                if let Some(m) = meta.measures.iter().find(|m| m.name == *measure_name) {
                    if !m.table.is_empty() && !referenced_tables.contains(&m.table) {
                        referenced_tables.push(m.table.clone());
                    }
                }
            }
            // Also add ALL model tables — the BI engine may need any table for
            // relationships, calculated columns, or measure expressions
            for t in &meta.model_tables {
                if !referenced_tables.contains(&t.name) {
                    referenced_tables.push(t.name.clone());
                }
            }
        }
    }
    let table_refs: Vec<&str> = referenced_tables.iter().map(|s| s.as_str()).collect();

    // Offline fast path: if every referenced table is already warm in this
    // engine's cache, serve straight from cache and skip the connector — the
    // query path (engine.query_with_meta below) is cache-only. This makes a
    // restored pivot interactive offline (cross-machine, from embedded cache).
    // Only reach for the network when a table is genuinely cold.
    let all_warm = bi_tables_cache_warm(&bi_state, connection_id, &table_refs).await;
    if all_warm {
        log_info!("BI", "update_bi_pivot_fields: {} table(s) cache-warm — serving offline (no connect)", table_refs.len());
    } else {
        log_info!("CALP-DIAG", "update_bi_pivot_fields: calling auto_connect for connection_id={}", connection_id);
        auto_connect_bi_connection(&bi_state, connection_id).await?;
        auto_bind_tables_on_connection(&bi_state, connection_id, &table_refs).await?;
    }

    // Guardrail: a LOOKUP field must follow at least one GROUP field from the same table.
    // Check across all zones (row + column fields combined for GROUP coverage).
    let all_group_tables: std::collections::HashSet<&str> = request
        .row_fields
        .iter()
        .chain(request.column_fields.iter())
        .filter(|f| !f.is_lookup)
        .map(|f| f.table.as_str())
        .collect();

    for f in request.row_fields.iter().chain(request.column_fields.iter()) {
        if f.is_lookup && !all_group_tables.contains(f.table.as_str()) {
            return Err(format!(
                "LOOKUP field '{}.{}' requires at least one GROUP field from table '{}'",
                f.table, f.column, f.table
            ));
        }
    }

    // Separate GROUP fields from LOOKUP fields across all zones
    let row_group_fields: Vec<&BiFieldRef> = request.row_fields.iter().filter(|f| !f.is_lookup).collect();
    let row_lookup_fields: Vec<&BiFieldRef> = request.row_fields.iter().filter(|f| f.is_lookup).collect();
    let col_group_fields: Vec<&BiFieldRef> = request.column_fields.iter().filter(|f| !f.is_lookup).collect();
    let col_lookup_fields: Vec<&BiFieldRef> = request.column_fields.iter().filter(|f| f.is_lookup).collect();
    // Filter fields are always GROUP BY (not lookups) — they need cache columns
    // so the pivot engine can read their unique values and apply hidden_items.
    let filter_group_fields: Vec<&BiFieldRef> = request.filter_fields.iter().collect();
    // Slicer fields: included in GROUP BY so their values appear in the cache,
    // but mapped to slicer_filters instead of filter_fields (no visible filter row).
    let slicer_group_fields: Vec<&BiFieldRef> = slicer_fields.iter().collect();

    // Expand hierarchy fields into GROUP BY columns.
    // ALL levels are included in the query — the pivot engine's collapse mechanism
    // controls which levels are visible. This avoids re-querying on expand/collapse.
    let mut hierarchy_row_fields: Vec<BiFieldRef> = Vec::new();
    let mut hierarchy_col_fields: Vec<BiFieldRef> = Vec::new();

    // Track hierarchy metadata for setting up HierarchyConfig on the definition.
    // (name, table, field_count, ragged_behavior, is_row)
    struct HierarchyMeta {
        name: String,
        field_count: usize,
        ragged_behavior: BiRaggedBehavior,
        is_row: bool,
    }
    let mut hierarchy_metas: Vec<HierarchyMeta> = Vec::new();

    {
        let bi_meta = pivot_state.bi_metadata.read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        let meta = bi_meta.get(&pivot_id);

        for href in &request.row_hierarchies {
            if let Some(meta) = meta {
                if let Some(h) = meta.hierarchies.iter().find(|h| h.name == href.hierarchy && h.table == href.table) {
                    hierarchy_metas.push(HierarchyMeta {
                        name: h.name.clone(),
                        field_count: h.levels.len(),
                        ragged_behavior: h.ragged_behavior.clone(),
                        is_row: true,
                    });
                    for level in &h.levels {
                        hierarchy_row_fields.push(BiFieldRef {
                            table: href.table.clone(),
                            column: level.column.clone(),
                            is_lookup: false,
                            hidden_items: None,
                        });
                    }
                }
            }
        }

        for href in &request.column_hierarchies {
            if let Some(meta) = meta {
                if let Some(h) = meta.hierarchies.iter().find(|h| h.name == href.hierarchy && h.table == href.table) {
                    hierarchy_metas.push(HierarchyMeta {
                        name: h.name.clone(),
                        field_count: h.levels.len(),
                        ragged_behavior: h.ragged_behavior.clone(),
                        is_row: false,
                    });
                    for level in &h.levels {
                        hierarchy_col_fields.push(BiFieldRef {
                            table: href.table.clone(),
                            column: level.column.clone(),
                            is_lookup: false,
                            hidden_items: None,
                        });
                    }
                }
            }
        }
    }
    let hierarchy_row_refs: Vec<&BiFieldRef> = hierarchy_row_fields.iter().collect();
    let hierarchy_col_refs: Vec<&BiFieldRef> = hierarchy_col_fields.iter().collect();

    // Collect hidden sort-by columns: for each GROUP BY field that has a
    // sort_by_column configured in the BI model, we need that sort column
    // in the cache. Add it as an extra GROUP BY column if not already present.
    // Since sort-by has a 1:1 mapping with the display column, this doesn't
    // change the number of groups.
    let mut sort_by_extra_fields: Vec<BiFieldRef> = Vec::new();
    {
        let bi_meta = pivot_state.bi_metadata.read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        if let Some(meta) = bi_meta.get(&pivot_id) {
            // Collect all (table, column) pairs already in group_by
            let mut existing_group_by: std::collections::HashSet<(String, String)> =
                std::collections::HashSet::new();
            for f in row_group_fields.iter()
                .chain(hierarchy_row_refs.iter())
                .chain(col_group_fields.iter())
                .chain(hierarchy_col_refs.iter())
                .chain(filter_group_fields.iter())
                .chain(slicer_group_fields.iter())
            {
                existing_group_by.insert((f.table.clone(), f.column.clone()));
            }

            // For each group-by field, check if it has a sort_by_column
            let all_group_fields: Vec<&BiFieldRef> = row_group_fields.iter()
                .chain(hierarchy_row_refs.iter())
                .chain(col_group_fields.iter())
                .chain(hierarchy_col_refs.iter())
                .chain(filter_group_fields.iter())
                .chain(slicer_group_fields.iter())
                .copied()
                .collect();
            for f in &all_group_fields {
                if let Some(table_meta) = meta.model_tables.iter().find(|t| t.name == f.table) {
                    if let Some(col_meta) = table_meta.columns.iter().find(|c| c.name == f.column) {
                        if let Some(ref sort_col) = col_meta.sort_by_column {
                            let key = (f.table.clone(), sort_col.clone());
                            if !existing_group_by.contains(&key) {
                                existing_group_by.insert(key);
                                sort_by_extra_fields.push(BiFieldRef {
                                    table: f.table.clone(),
                                    column: sort_col.clone(),
                                    is_lookup: false,
                                    hidden_items: None,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Build BI engine QueryRequest
    // If no user measures but we have a synthetic one, include it in the query
    // so the BI engine gets a valid request. The synthetic measure column will
    // be in the cache but ignored (no value_field maps to it).
    let query_measures: Vec<String> = if let Some(ref syn) = synthetic_measure {
        vec![syn.clone()]
    } else {
        request.value_fields.iter().map(|v| v.measure_name.clone()).collect()
    };
    let sort_by_extra_refs: Vec<&BiFieldRef> = sort_by_extra_fields.iter().collect();
    let query_group_by: Vec<bi_engine::ColumnRef> = row_group_fields
        .iter()
        .chain(hierarchy_row_refs.iter())
        .chain(col_group_fields.iter())
        .chain(hierarchy_col_refs.iter())
        .chain(filter_group_fields.iter())
        .chain(slicer_group_fields.iter())
        .chain(sort_by_extra_refs.iter())
        .map(|f| bi_engine::ColumnRef::new(&f.table, &f.column))
        .collect();

    // Build lookups from LOOKUP fields. For each lookup, try to auto-infer
    // the key column (the BI engine handles this when exactly one group_by
    // column is from the same table). If multiple group_by cols from same
    // table, the first one is used as explicit key.
    let query_lookups: Vec<bi_engine::LookupColumn> = row_lookup_fields
        .iter()
        .chain(col_lookup_fields.iter())
        .map(|f| {
            // Check how many group_by columns are from the same table
            let same_table_group_count = query_group_by
                .iter()
                .filter(|g| g.table == f.table)
                .count();
            if same_table_group_count == 1 {
                // Auto-infer key (exactly one group_by from same table)
                bi_engine::LookupColumn::new(&f.table, &f.column)
            } else {
                // Multiple group_by cols from same table — use first as explicit key
                let key = query_group_by
                    .iter()
                    .find(|g| g.table == f.table)
                    .map(|g| g.column.clone())
                    .unwrap_or_default();
                bi_engine::LookupColumn::with_key(&f.table, &f.column, &key)
            }
        })
        .collect();

    // ---- Calculation-group resolution ----
    // Resolve the placed group against the LIVE engine model — the pivot's
    // stored metadata is a creation-time snapshot, so a group added or edited
    // in the Model Editor since then wouldn't be in it (the query runs against
    // the live model anyway). Refresh the snapshot while at it.
    //
    // `reshape_items` is what the reshaped cache's item column carries, per
    // axis (Power BI/AS selection semantics):
    // - Rows/Columns: EVERY item (the axis shows them) — item subsetting is
    //   pivot-side via hidden_items.
    // - Filters: exactly ONE visible item applies it; ZERO or MANY visible
    //   items apply NO item (`None` = an EMPTY item cell) — the measures are
    //   their base values or the group's selection expression (a
    //   multi-selection must never sum transformed item rows).
    let (calc_group_app, calc_item_names, reshape_items): (
        Option<bi_engine::CalculationGroupApplication>,
        Vec<String>,
        Vec<Option<String>>,
    ) = match placement.as_ref() {
        Some(p) => {
            // v1: calculation groups cannot combine with lookup columns (the
            // engine allows it but the combination is unvalidated; fail closed).
            if !query_lookups.is_empty() {
                return Err(
                    "Calculation groups can't be combined with lookup columns yet. \
                     Remove the lookup column(s) or the calculation group."
                        .to_string(),
                );
            }
            let group_meta: BiCalcGroupMeta = {
                let engine_arc = {
                    let connections = bi_state.connections.lock()
                        .map_err(|e| format!("connections lock poisoned: {}", e))?;
                    let conn = connections.get(&connection_id)
                        .ok_or_else(|| format!("Connection {} not found", connection_id))?;
                    conn.engine.clone().ok_or("No BI model loaded.")?
                };
                let live_groups = {
                    let engine = engine_arc.lock().await;
                    extract_calc_groups(&engine)
                };
                let found = live_groups.iter().find(|g| g.name == p.group).cloned();
                {
                    let mut bi_meta = pivot_state.bi_metadata.write(&effect)
                        .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
                    if let Some(meta) = bi_meta.get_mut(&pivot_id) {
                        meta.calculation_groups = live_groups;
                    }
                }
                found.ok_or_else(|| format!(
                    "Calculation group '{}' not found in this model.", p.group
                ))?
            };
            let all_items: Vec<String> =
                group_meta.items.iter().map(|i| i.name.clone()).collect();
            if all_items.is_empty() {
                return Err(format!("Calculation group '{}' has no items.", p.group));
            }
            match p.axis {
                CalcGroupAxis::Filters => {
                    let visible: Vec<String> = all_items
                        .iter()
                        .filter(|i| !p.hidden_items.contains(i))
                        .cloned()
                        .collect();
                    if visible.len() == 1 {
                        (
                            Some(bi_engine::CalculationGroupApplication::new(
                                p.group.clone(),
                                visible.clone(),
                            )),
                            all_items,
                            visible.into_iter().map(Some).collect(),
                        )
                    } else {
                        // AS selection states: no filter at all = "no
                        // selection"; an explicit subset (or everything
                        // hidden) = "multiple or empty". A model-defined
                        // selection expression overrides the default (which
                        // is: no item applied, base measures).
                        let no_filter = p.hidden_items.is_empty();
                        let app = if no_filter && group_meta.no_selection.is_some() {
                            Some(bi_engine::CalculationGroupApplication::no_selection(
                                p.group.clone(),
                            ))
                        } else if !no_filter
                            && group_meta.multiple_or_empty_selection.is_some()
                        {
                            Some(bi_engine::CalculationGroupApplication::multiple_or_empty(
                                p.group.clone(),
                            ))
                        } else {
                            None
                        };
                        (app, all_items, vec![None])
                    }
                }
                _ => (
                    // Empty item list = ALL items in declaration order
                    // (engine contract).
                    Some(bi_engine::CalculationGroupApplication::new(
                        p.group.clone(),
                        Vec::new(),
                    )),
                    all_items.clone(),
                    all_items.into_iter().map(Some).collect(),
                ),
            }
        }
        None => (None, Vec::new(), Vec::new()),
    };

    // Group-only pivot: a calculation group placed with no measures and no
    // other dimensions anywhere. The items ARE the rows — nothing to
    // aggregate, so skip the engine query entirely and render the item
    // column straight from the resolved metadata (works offline too).
    let group_only = placement.is_some()
        && !has_values
        && query_group_by.is_empty()
        && query_lookups.is_empty();

    // Engine-routed (PINNED, level-2+) filters are DEFINITION state written
    // by `apply_pivot_filter` and preserved across field updates. They travel
    // INSIDE the query as level-tagged IN-lists (`scoped_in_filters`) — the
    // one filter class the engine actually sees from a pivot — so measure
    // CLEAR/RESET semantics honor them. Ordinary (level-1) filtering stays
    // host-side (`hidden_items` masks over the cached result).
    //
    // A PINNED page model slicer joins them here (its pin must be INSIDE the
    // query, like any pin); an ORDINARY one drops a pin it set itself earlier
    // (a level change), exactly as apply_pivot_filter's pin_dropped does.
    let mut engine_filters_for_query: Vec<pivot_engine::EngineFilter> = {
        let pt = pivot_state.pivot_tables.read()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        pt.get(&pivot_id)
            .map(|(d, _)| d.engine_filters.clone())
            .unwrap_or_default()
    };
    for ps in &page_slicers {
        let owner = ps.slicer_id.to_string();
        let same_column = |ef: &pivot_engine::EngineFilter| ef.table == ps.table && ef.column == ps.column;
        if ps.level >= 2 {
            let entry = pivot_engine::EngineFilter {
                field_name: ps.column.clone(),
                table: ps.table.clone(),
                column: ps.column.clone(),
                selected_items: ps.selected.clone(),
                level: ps.level,
                slicer_id: Some(owner),
            };
            if let Some(existing) = engine_filters_for_query.iter_mut().find(|ef| same_column(ef)) {
                // Keep the stored name: it is how the clear paths match it.
                let name = std::mem::take(&mut existing.field_name);
                *existing = entry;
                existing.field_name = name;
            } else {
                engine_filters_for_query.push(entry);
            }
        } else {
            engine_filters_for_query
                .retain(|ef| !(same_column(ef) && ef.slicer_id.as_deref() == Some(owner.as_str())));
        }
    }
    let scoped_in_filters: Vec<bi_engine::ScopedInFilter> = engine_filters_for_query
        .iter()
        .map(|ef| bi_engine::ScopedInFilter {
            table: Some(ef.table.clone()),
            filter: bi_engine::InFilter::new(
                ef.column.clone(),
                ef.selected_items.iter().cloned(),
            ),
            level: ef.level,
        })
        .collect();

    let query_request = bi_engine::QueryRequest {
        measures: query_measures.clone(),
        group_by: query_group_by,
        filters: vec![],
        // CLONED, not moved: the engine-evaluated totals block below must send
        // the SAME filters with every grain query. It used to send none, so a
        // pinned slicer produced engine-filtered leaves and engine-unfiltered
        // totals — and, because a pin makes `include_leaf` true, the unfiltered
        // leaf grain then overwrote the filtered leaves.
        scoped_in_filters: scoped_in_filters.clone(),
        lookups: query_lookups,
        calculation_group: calc_group_app,
        ..Default::default()
    };

    log_info!(
        "PIVOT",
        "BI query: measures={:?}, group_by={} dims, lookups={} cols",
        query_measures,
        row_group_fields.len() + col_group_fields.len(),
        row_lookup_fields.len() + col_lookup_fields.len()
    );

    // Get the shared engine Arc for async query
    let t_query = Instant::now();
    let engine_arc = {
        let connections = bi_state.connections.lock()
            .map_err(|e| format!("connections lock poisoned: {}", e))?;
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        conn.engine.clone().ok_or("No BI model loaded.")?
    };

    let (batches, result_columns) = if group_only {
        // Group-only: no query — the reshape builder emits one row per item.
        (Vec::new(), Vec::new())
    } else {
    // Auto-refresh in-memory tables that haven't been cached yet.
    // Multi-table queries go through LocalAggregation which reads from the
    // in-memory cache — tables must be refreshed at least once before querying.
    // `needs_refresh(..., Duration::ZERO)` returns true only if the table has
    // NEVER been refreshed, so this is a one-time cost per table per session.
    {
        // Collect all tables referenced by the query (dimensions + measure tables)
        let tables_to_refresh: Vec<String> = {
            let mut tables = referenced_tables.clone();
            let bi_meta = pivot_state.bi_metadata.read()
                .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
            if let Some(meta) = bi_meta.get(&pivot_id) {
                for measure_name in &query_measures {
                    if let Some(m) = meta.measures.iter().find(|m| m.name == *measure_name) {
                        if !tables.contains(&m.table) {
                            tables.push(m.table.clone());
                        }
                    }
                }
            }
            tables
        }; // bi_meta lock released here

        let mut engine = engine_arc.lock().await;
        for table_name in &tables_to_refresh {
            if engine.needs_refresh(table_name, std::time::Duration::from_secs(0)) {
                log_info!("PIVOT", "Auto-refreshing in-memory table '{}'", table_name);
                if let Err(e) = engine.refresh_table(table_name).await {
                    // Not all tables are in-memory — ignore errors for non-in-memory tables
                    log_info!("PIVOT", "refresh_table('{}') skipped: {}", table_name, e);
                }
            }
        }
    }

    let query_result = {
        let mut engine = engine_arc.lock().await;
        // Apply this connection's RLS role (or clear a sibling's) before querying.
        crate::bi::commands::apply_connection_role(&mut engine, &bi_state, connection_id);
        // query_with_meta returns per-column metadata (measure + calculation item
        // attribution) so the value-field -> cache-column mapping is driven by the
        // engine's own column identity rather than fragile positional arithmetic.
        engine.query_with_meta(query_request).await
    };
    match query_result {
        Ok((b, m)) => (b, m),
        Err(e) => {
            // If the query failed and we were using a synthetic measure,
            // save the field assignments anyway so they persist, then return
            // an empty view.
            if synthetic_measure.is_some() {
                log_info!("PIVOT", "Synthetic measure query failed ({}), saving fields only", e);
                let mut pivot_tables = pivot_state.pivot_tables.write(&effect)
                    .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
                let (definition, stored_cache) = pivot_tables
                    .get_mut(&pivot_id)
                    .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

                definition.row_fields = request.row_fields.iter()
                    .map(|f| PivotField::new(0, format!("{}.{}", f.table, f.column)))
                    .collect();
                definition.column_fields = request.column_fields.iter()
                    .map(|f| PivotField::new(0, format!("{}.{}", f.table, f.column)))
                    .collect();
                definition.value_fields.clear();
                definition.calculated_fields.clear();
                definition.value_column_order.clear();
                definition.filter_fields = request.filter_fields.iter()
                    .map(|f| {
                        let field = PivotField::new(0, format!("{}.{}", f.table, f.column));
                        pivot_engine::PivotFilter {
                            field,
                            condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
                        }
                    })
                    .collect();
                // Keep a placed calculation group in the definition so its
                // chip and refresh reconstruction survive the failed query.
                if let Some(p) = &placement {
                    let mut pf = PivotField::new(0, p.group.clone());
                    pf.sort_order = pivot_engine::SortOrder::DataSourceOrder;
                    pf.hidden_items = p.hidden_items.clone();
                    match p.axis {
                        CalcGroupAxis::Rows => definition
                            .row_fields
                            .insert(p.position.min(definition.row_fields.len()), pf),
                        CalcGroupAxis::Columns => definition
                            .column_fields
                            .insert(p.position.min(definition.column_fields.len()), pf),
                        CalcGroupAxis::Filters => definition.filter_fields.insert(
                            p.position.min(definition.filter_fields.len()),
                            pivot_engine::PivotFilter {
                                field: pf,
                                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
                            },
                        ),
                    }
                }
                if let Some(ref layout_config) = request.layout {
                    apply_layout_config(&mut definition.layout, layout_config);
                }
                definition.bump_version();

                let empty_cache = PivotCache::new(pivot_id, 0);
                let view = create_empty_view(pivot_id, definition.version);
                let mut response = view_to_response(&view, definition, &mut empty_cache.clone());
                let destination = definition.destination;
                let dest_ref = PivotDestSheet::of(definition);
                *stored_cache = empty_cache;
                drop(pivot_tables);
                let dest_sheet_idx = dest_ref.resolve(&state);

                response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
                // Ok with an empty view is indistinguishable from a successful
                // field change that happens to have no rows. Say which it is,
                // and distinguish a REFUSAL (the user can act on it: pick a
                // different "view as" role) from an ordinary failure — typed,
                // never by matching the message text.
                response.notices.push(if crate::bi::cube::is_security_refusal(&e) {
                    crate::pivot::types::PivotNotice::refused(
                        "No data: the role chosen in \"View as\" denies the measure this pivot \
                         needs to list its members. The field assignments were kept.",
                    )
                } else {
                    crate::pivot::types::PivotNotice::degraded(
                        "No data: the query for this pivot's members failed. The field \
                         assignments were kept.",
                    )
                });
                finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;
                // The query failed but the FIELDS were still written, so this is
                // a real document change and gets a real undo step — with the
                // cache, which was replaced by an empty one.
                let undo = BiFieldChangeUndo {
                    pivot_id,
                    definition: old_definition,
                    overwritten_cells: Vec::new(),
                    dest_sheet_idx,
                    prev_col_widths: Vec::new(),
                    cache: Some(old_cache),
                };
                return Ok((response, Some(undo)));
            }
            return Err(crate::bi::commands::friendly_bi_query_error("BI query failed", &e));
        }
    }
    };
    let query_ms = t_query.elapsed().as_secs_f64() * 1000.0;

    log_info!(
        "PIVOT",
        "BI query returned {} batches, query_ms={:.1}",
        batches.len(),
        query_ms
    );

    // Build PivotCache from Arrow results.
    //
    // With a placed calculation group the engine result is WIDE — [group_by
    // dims][M*K measure cols] (measures-outer/items-inner) — and is reshaped
    // LONG so the group becomes a REAL cache dimension: each wide row becomes
    // K rows of [dims][item name][M base measures]. From there the group
    // behaves like any pivot field (rows/columns/filters, item hiding).
    let t_cache = Instant::now();
    // A filters-placed group with nothing else still needs a visible pivot
    // (the filter row + an empty synthetic "Total" row), like a values-only
    // pivot does.
    let filters_only_group = group_only
        && matches!(placement.as_ref().map(|p| p.axis), Some(CalcGroupAxis::Filters));
    let use_synthetic_dim = (has_values || filters_only_group) && !has_dimensions;
    let num_group_by = row_group_fields.len() + hierarchy_row_refs.len()
        + col_group_fields.len() + hierarchy_col_refs.len()
        + filter_group_fields.len() + slicer_group_fields.len()
        + sort_by_extra_fields.len();
    let mut cache = if let Some(p) = &placement {
        // Engine-reported (measure, item) -> wide result column, so the
        // reshape follows the engine's own column identity (positional
        // fallback per the measures-outer/items-inner contract).
        let wide_idx = measure_value_col_idx(&result_columns, 0);
        build_cache_calc_group_long(
            pivot_id,
            &batches,
            num_group_by,
            &p.group,
            &reshape_items,
            &calc_item_names,
            &query_measures,
            &wide_idx,
            use_synthetic_dim,
        )?
    } else if use_synthetic_dim {
        log_info!("PIVOT", "Values-only: injecting synthetic 'Total' dimension");
        build_cache_with_synthetic_dim(pivot_id, &batches)?
    } else {
        build_cache_from_arrow_batches(pivot_id, &batches)?
    };
    let cache_ms = t_cache.elapsed().as_secs_f64() * 1000.0;

    // Build PivotDefinition field mappings
    //
    // Cache layout:
    // [synthetic "Total"?] [group_by columns (row groups, col groups, filter
    // groups, slicer groups, hidden sort-by cols)] [calc-group item column?]
    // [measure columns] [lookup columns]
    let dim_offset: usize = if use_synthetic_dim { 1 } else { 0 };
    // The reshaped cache inserts the calculation-group item column between the
    // dims and the measure block (and collapses M*K wide cols to M).
    let calc_extra: usize = usize::from(placement.is_some());

    // Build a mapping from (table, column) -> cache column index.
    // num_measures reflects actual query columns (includes synthetic if present)
    let num_measures = if synthetic_measure.is_some() { 1 } else { request.value_fields.len() };
    let mut field_to_cache_idx: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();

    // Group-by cols come first: row groups, hierarchy rows, col groups, hierarchy cols,
    // filter groups, slicer groups, then hidden sort-by columns
    let mut cache_idx = dim_offset;
    for f in row_group_fields.iter()
        .chain(hierarchy_row_refs.iter())
        .chain(col_group_fields.iter())
        .chain(hierarchy_col_refs.iter())
        .chain(filter_group_fields.iter())
        .chain(slicer_group_fields.iter())
        .chain(sort_by_extra_refs.iter())
    {
        field_to_cache_idx.insert((f.table.clone(), f.column.clone()), cache_idx);
        cache_idx += 1;
    }
    // Measures come next (after group_by + the item column, before lookups)
    let measure_start = num_group_by + dim_offset + calc_extra;
    // Lookup cols come last (rejected together with a calculation group, so
    // the M-wide measure block is always correct here)
    let lookup_start = measure_start + num_measures;
    cache_idx = lookup_start;
    for f in row_lookup_fields.iter().chain(col_lookup_fields.iter()) {
        field_to_cache_idx.insert((f.table.clone(), f.column.clone()), cache_idx);
        cache_idx += 1;
    }
    // Stamp every model column the records carry with its "Table.Column"
    // identity. The Arrow schema names columns BARE, so Customers.name and
    // Products.name are both "name" in the cache; anything that later has
    // only the records to go on (the ensure's cache scan, after a Clear
    // dropped the column's slicer filter) could otherwise not tell them
    // apart, and re-queried instead -- recording a step that wiped the redo
    // stack. The key travels with the cache into clones and undo snapshots.
    for ((table, column), &idx) in &field_to_cache_idx {
        if let Some(field) = cache.fields.get_mut(idx) {
            field.model_key = Some(format!("{table}.{column}"));
        }
    }

    // ---- Engine-evaluated totals ------------------------------------------
    // The cache rows are pre-aggregated leaf groups, so the pivot engine's
    // additive roll-up is only correct for additive measures: a "% of total"
    // measure rolls up to 0.9999999…, AVERAGE/DISTINCTCOUNT measures roll up
    // plainly wrong. Query each total grain in its own filter context and
    // install the results as overrides the pivot engine splices over the
    // rolled-up subtotal/grand-total slots.
    //
    // Skipped for calculation groups (their totals are force-hidden below)
    // and when local filters are active — overrides describe the UNFILTERED
    // set, and the pivot engine only applies them while the filter mask is
    // all-visible.
    if synthetic_measure.is_none() && !use_synthetic_dim && calc_item_names.is_empty() {
        let request_filters_active = request
            .row_fields
            .iter()
            .chain(request.column_fields.iter())
            .chain(request.filter_fields.iter())
            .chain(slicer_fields.iter())
            .any(|f| !f.hidden().is_empty())
            || page_slicers.iter().any(|ps| ps.level < 2)
            || !masks.is_empty()
            || hierarchy_row_fields
                .iter()
                .chain(hierarchy_col_fields.iter())
                .any(|f| carried_hidden.contains_key(&(f.table.clone(), f.column.clone())));
        // Page-filter/slicer hidden items survive the definition rebuild
        // below (preserved from the old definition), so consult it too.
        let preserved_filters_active = {
            let pivot_tables = pivot_state.pivot_tables.read()
                .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
            pivot_tables.get(&pivot_id).is_some_and(|(def, _)| {
                (!request.filter_fields.is_empty()
                    && def.filter_fields.iter().any(|pf| !pf.field.hidden_items.is_empty()))
                    || (!slicer_fields.is_empty()
                        && def.slicer_filters.iter().any(|sf| !sf.hidden_items.is_empty()))
            })
        };
        if !request_filters_active && !preserved_filters_active {
            let grain_field = |f: &&BiFieldRef| GrainField {
                table: f.table.clone(),
                column: f.column.clone(),
                cache_idx: *field_to_cache_idx
                    .get(&(f.table.clone(), f.column.clone()))
                    .unwrap_or(&0),
            };
            let plan = BiTotalsPlan {
                row_fields: row_group_fields
                    .iter()
                    .chain(hierarchy_row_refs.iter())
                    .map(grain_field)
                    .collect(),
                col_fields: col_group_fields
                    .iter()
                    .chain(hierarchy_col_refs.iter())
                    .map(grain_field)
                    .collect(),
                measures: query_measures.clone(),
                vf_keys: request
                    .value_fields
                    .iter()
                    .map(|v| (v.measure_name.clone(), None))
                    .collect(),
                // The grains must answer the question the main query asked.
                // These are the pivot's pinned (level-2+) filters; the gate
                // above guarantees no host-side mask is active, so this is the
                // complete filter context — nothing else is being applied.
                scoped_in_filters: scoped_in_filters.clone(),
            };
            // Filter/slicer dims are part of the main query's GROUP BY, so
            // even the pivot's leaf cells are roll-ups when they exist —
            // override the leaf grain too in that case.
            let include_leaf =
                !filter_group_fields.is_empty() || !slicer_group_fields.is_empty();
            let t_totals = Instant::now();
            let overrides = {
                let mut engine = engine_arc.lock().await;
                query_bi_total_overrides(&mut engine, &plan, include_leaf, &cache).await
            };
            if !overrides.is_empty() {
                log_info!(
                    "PIVOT",
                    "BI totals: {} engine-evaluated total cells in {:.1}ms",
                    overrides.len(),
                    t_totals.elapsed().as_secs_f64() * 1000.0
                );
                cache.set_total_overrides(overrides);
            }
        }
    }

    // Build sort-by resolution map: (table, column) -> cache_index_of_sort_by_column.
    // Used to set sort_by_field_index on PivotField for BI columns with sort_by_column.
    let sort_by_resolution: std::collections::HashMap<(String, String), usize> = {
        let bi_meta = pivot_state.bi_metadata.read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        let mut map = std::collections::HashMap::new();
        if let Some(meta) = bi_meta.get(&pivot_id) {
            for table_meta in &meta.model_tables {
                for col_meta in &table_meta.columns {
                    if let Some(ref sort_col) = col_meta.sort_by_column {
                        if let Some(&sort_cache_idx) = field_to_cache_idx.get(
                            &(table_meta.name.clone(), sort_col.clone())
                        ) {
                            map.insert(
                                (table_meta.name.clone(), col_meta.name.clone()),
                                sort_cache_idx,
                            );
                        }
                    }
                }
            }
        }
        map
    };

    // Helper: resolve sort_by_field_index for a BiFieldRef
    let resolve_sort_by = |f: &BiFieldRef| -> Option<usize> {
        sort_by_resolution.get(&(f.table.clone(), f.column.clone())).copied()
    };

    let mut pivot_tables = pivot_state.pivot_tables.write(&effect)
        .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
    let (definition, stored_cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

    // Dimension number formats from the model column (query_with_meta populates
    // ResultColumn.format_string for dimension columns). Keyed case-insensitively
    // by (table, column); applied to each row/column field so its header/item
    // values render with the model-defined format.
    let dim_format: std::collections::HashMap<(String, String), String> = result_columns
        .iter()
        .filter(|rc| matches!(rc.kind, bi_engine::ResultColumnKind::Dimension))
        .filter_map(|rc| {
            Some((
                (
                    rc.source_table.clone()?.to_lowercase(),
                    rc.source_column.clone()?.to_lowercase(),
                ),
                rc.format_string.clone()?,
            ))
        })
        .collect();
    let dim_format_for = |table: &str, column: &str| -> Option<String> {
        dim_format
            .get(&(table.to_lowercase(), column.to_lowercase()))
            .cloned()
    };

    // The placed calculation group as a real pivot dimension over the reshaped
    // cache's item column. DataSourceOrder keeps the items in declaration
    // order (the reshape emits them that way — never alphabetically, matching
    // Power BI's ordinal semantics); hidden_items = the item subset selection.
    let calc_group_item_idx = num_group_by + dim_offset;
    let make_calc_group_field = |p: &CalcGroupPlacement| -> PivotField {
        let mut pf = PivotField::new(calc_group_item_idx, p.group.clone());
        pf.sort_order = pivot_engine::SortOrder::DataSourceOrder;
        pf.hidden_items = p.hidden_items.clone();
        pf
    };

    // Every field the pivot held before this rebuild, in any zone: each new
    // field keeps its own sort / subtotals / show-all / grouping from its
    // namesake (`preserve_field_settings`, wave B A3).
    let old_zone_fields: Vec<PivotField> = definition
        .row_fields
        .iter()
        .chain(definition.column_fields.iter())
        .cloned()
        .chain(definition.filter_fields.iter().map(|f| f.field.clone()))
        .collect();

    // Row fields (preserving collapse state for fields that remain)
    // Lookup fields share the same hierarchy depth as the preceding GROUP field
    // from the same table (they are attributes, not new grouping levels).
    let old_row_fields = definition.row_fields.clone();
    let hierarchy_row_start;
    if use_synthetic_dim {
        // Synthetic "Total" dimension as the only row field
        definition.row_fields = vec![PivotField::new(0, "Total".to_string())];
        hierarchy_row_start = 1;
    } else {
        let mut row_fields_vec: Vec<PivotField> = request
            .row_fields
            .iter()
            .map(|f| {
                let idx = *field_to_cache_idx
                    .get(&(f.table.clone(), f.column.clone()))
                    .unwrap_or(&0);
                let name = format!("{}.{}", f.table, f.column);
                let mut pf = if f.is_lookup {
                    PivotField::new_attribute(idx, name)
                } else {
                    PivotField::new(idx, name)
                };
                pf.sort_by_field_index = resolve_sort_by(f);
                pf.number_format = dim_format_for(&f.table, &f.column);
                // A row field's filter (a level-1 slicer on this column lands
                // here) travels in the request, carried by name when unsent.
                pf.hidden_items = f.hidden().to_vec();
                pf
            })
            .collect();
        // Splice a rows-placed calculation group in at its chip position
        // (before hierarchy levels, so hierarchy_configs offsets stay right).
        if let Some(p) = placement.as_ref().filter(|p| p.axis == CalcGroupAxis::Rows) {
            let pos = p.position.min(row_fields_vec.len());
            row_fields_vec.insert(pos, make_calc_group_field(p));
        }
        // Append hierarchy level fields as row dimensions.
        // All levels start collapsed so the user expands via toggle_pivot_group.
        hierarchy_row_start = row_fields_vec.len();
        for f in hierarchy_row_fields.iter() {
            let idx = *field_to_cache_idx
                .get(&(f.table.clone(), f.column.clone()))
                .unwrap_or(&0);
            let name = format!("{}.{}", f.table, f.column);
            let mut pf = PivotField::new(idx, name);
            pf.collapsed = true;
            pf.sort_by_field_index = resolve_sort_by(f);
            if let Some(hidden) = carried_hidden.get(&(f.table.clone(), f.column.clone())) {
                pf.hidden_items = hidden.clone();
            }
            row_fields_vec.push(pf);
        }
        definition.row_fields = row_fields_vec;
    }
    preserve_collapse_state(&mut definition.row_fields, &old_row_fields);
    preserve_field_settings(&mut definition.row_fields, &old_zone_fields);

    // Column fields (preserving collapse state for fields that remain)
    let old_col_fields = definition.column_fields.clone();
    let mut col_fields_vec: Vec<PivotField> = request
        .column_fields
        .iter()
        .map(|f| {
            let idx = *field_to_cache_idx
                .get(&(f.table.clone(), f.column.clone()))
                    .unwrap_or(&0);
            let name = format!("{}.{}", f.table, f.column);
            let mut pf = if f.is_lookup {
                PivotField::new_attribute(idx, name)
            } else {
                PivotField::new(idx, name)
            };
            pf.sort_by_field_index = resolve_sort_by(f);
            pf.number_format = dim_format_for(&f.table, &f.column);
            pf.hidden_items = f.hidden().to_vec();
            pf
        })
        .collect();
    // Splice a columns-placed calculation group in at its chip position.
    if let Some(p) = placement.as_ref().filter(|p| p.axis == CalcGroupAxis::Columns) {
        let pos = p.position.min(col_fields_vec.len());
        col_fields_vec.insert(pos, make_calc_group_field(p));
    }
    // Append hierarchy level fields as column dimensions.
    let hierarchy_col_start = col_fields_vec.len();
    for f in hierarchy_col_fields.iter() {
        let idx = *field_to_cache_idx
            .get(&(f.table.clone(), f.column.clone()))
            .unwrap_or(&0);
        let name = format!("{}.{}", f.table, f.column);
        let mut pf = PivotField::new(idx, name);
        pf.collapsed = true;
        pf.sort_by_field_index = resolve_sort_by(f);
        if let Some(hidden) = carried_hidden.get(&(f.table.clone(), f.column.clone())) {
            pf.hidden_items = hidden.clone();
        }
        col_fields_vec.push(pf);
    }
    definition.column_fields = col_fields_vec;
    preserve_collapse_state(&mut definition.column_fields, &old_col_fields);
    preserve_field_settings(&mut definition.column_fields, &old_zone_fields);

    // Value fields — measures map to cache columns right after group_by columns
    // (before lookup columns). BI engine result order: [group_by] [measures] [lookups].
    // Use "[MeasureName]" format so the frontend can extract the measure name
    // consistently via toBiValueFieldRef. The BI engine handles aggregation,
    // so we use Sum as an identity operation on pre-aggregated data.
    // When using a synthetic measure (dimensions-only), leave value_fields empty
    // so the pivot engine renders blank data cells for each dimension combination.
    if synthetic_measure.is_some() {
        definition.value_fields = Vec::new();
    } else {
        // Map each measure value column to its cache index from the engine's
        // per-column metadata, so the value-field mapping follows the engine's
        // actual column identity rather than positional arithmetic.
        // Empty/absent metadata -> positional fallback. With a placed
        // calculation group the metadata describes the WIDE result while the
        // reshaped cache is positional [dims][item][measures] — use positions.
        let value_col_idx = if placement.is_some() {
            std::collections::HashMap::new()
        } else {
            measure_value_col_idx(&result_columns, dim_offset)
        };
        definition.value_fields = expand_bi_value_fields(
            &request.value_fields,
            &[],
            measure_start,
            &value_col_idx,
        );

        // Adopt each measure's model number format (from query_with_meta) so BI
        // value cells render with the model-defined format (currency, %, etc.)
        // rather than raw numbers. Keyed by (base measure, calculation item).
        let format_by_key: std::collections::HashMap<(String, Option<String>), String> =
            result_columns
                .iter()
                .filter(|rc| matches!(rc.kind, bi_engine::ResultColumnKind::Measure))
                .filter_map(|rc| {
                    let m = rc.measure.clone()?;
                    let f = rc.format_string.clone()?;
                    Some(((m, rc.calculation_item.clone()), f))
                })
                .collect();
        if !format_by_key.is_empty() {
            for vf in definition.value_fields.iter_mut() {
                let measure = vf.name.trim_start_matches('[').trim_end_matches(']').to_string();
                let fmt = format_by_key
                    .get(&(measure.clone(), vf.calc_item.clone()))
                    .or_else(|| {
                        // Placed calc group: the wide metadata carries item
                        // attribution; adopt the measure's format from its
                        // first applied item column.
                        reshape_items.first().and_then(|it| {
                            format_by_key.get(&(measure.clone(), it.clone()))
                        })
                    });
                if let Some(fmt) = fmt {
                    vf.number_format = Some(fmt.clone());
                }
            }
        }
    }

    // Filter fields — same as row/column fields, map BiFieldRef to PivotFilter,
    // with the hidden items the request settled on above.
    definition.filter_fields = request
        .filter_fields
        .iter()
        .map(|f| {
            let idx = *field_to_cache_idx
                .get(&(f.table.clone(), f.column.clone()))
                .unwrap_or(&0);
            let name = format!("{}.{}", f.table, f.column);
            let mut field = if f.is_lookup {
                PivotField::new_attribute(idx, name)
            } else {
                PivotField::new(idx, name)
            };
            field.sort_by_field_index = resolve_sort_by(f);
            let mut filter = pivot_engine::PivotFilter {
                field,
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            };
            // The request's hidden items -- sent (e.g. by the DSL editor) or
            // carried over from the old definition by Table.Column NAME above.
            // (The by-INDEX carry-over this replaced matched the old cache's
            // index against the new one, so a reordered field list could hand
            // one field's filter to another.)
            filter.field.hidden_items = f.hidden().to_vec();
            filter
        })
        .collect();
    for filter in definition.filter_fields.iter_mut() {
        preserve_field_settings(std::slice::from_mut(&mut filter.field), &old_zone_fields);
    }
    // Splice a filters-placed calculation group in at its chip position. Its
    // hidden_items subset the items exactly like a normal page filter — with
    // one item visible, every measure shows that item's transformation
    // (Power BI slicer semantics).
    if let Some(p) = placement.as_ref().filter(|p| p.axis == CalcGroupAxis::Filters) {
        let pos = p.position.min(definition.filter_fields.len());
        definition.filter_fields.insert(
            pos,
            pivot_engine::PivotFilter {
                field: make_calc_group_field(p),
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            },
        );
    }

    // Slicer fields — map to slicer_filters (no visible filter row). The list
    // is settled above (explicit, or KEPT from the old definition, plus the
    // page's model slicers, deduped against the zones) and its hidden items
    // are already carried by name, so this is a straight mapping onto the NEW
    // cache's indices. An empty list clears them.
    definition.slicer_filters = slicer_fields
        .iter()
        .filter_map(|f| {
            field_to_cache_idx
                .get(&(f.table.clone(), f.column.clone()))
                .map(|&idx| pivot_engine::SlicerFilter {
                    source_index: idx,
                    hidden_items: f.hidden().to_vec(),
                    // Identified by its model column from here on, never by
                    // the bare cache name another table may share.
                    model_key: Some(format!("{}.{}", f.table, f.column)),
                })
        })
        .collect();
    definition.engine_filters = engine_filters_for_query;

    // THE PAGE FOLD: every active model slicer on this pivot's sheet applies
    // its selection to the NEW cache now -- a pinned one travelled inside the
    // query (above), so it only needs no host mask; an ordinary one masks
    // "every value it did not select", the same rule apply_pivot_filter uses.
    //
    // Where model column `table.column` sits in the NEW definition/cache.
    let fold_index = |definition: &PivotDefinition, table: &str, column: &str| -> Option<usize> {
        let key_name = format!("{table}.{column}");
        definition
            .row_fields
            .iter()
            .chain(definition.column_fields.iter())
            .find(|f| f.name == key_name)
            .map(|f| f.source_index)
            .or_else(|| {
                definition
                    .filter_fields
                    .iter()
                    .find(|f| f.field.name == key_name)
                    .map(|f| f.field.source_index)
            })
            .or_else(|| field_to_cache_idx.get(&(table.to_string(), column.to_string())).copied())
    };
    for ps in &page_slicers {
        let key_name = format!("{}.{}", ps.table, ps.column);
        let Some(idx) = fold_index(definition, &ps.table, &ps.column) else { continue };
        if ps.level >= 2 {
            set_hidden_items_at(definition, idx, Vec::new(), Some(&key_name));
            // The pin is matched by its cache column name on the clear paths.
            if let Some(cache_name) = cache.field_name(idx) {
                if let Some(ef) = definition
                    .engine_filters
                    .iter_mut()
                    .find(|ef| ef.table == ps.table && ef.column == ps.column)
                {
                    ef.field_name = cache_name;
                }
            }
        } else {
            // Same rule as apply_pivot_filter: the selection is spelled the
            // MODEL's way ("true", "12.50"), the cache its own.
            // A model slicer lists the MODEL's values: its selection hides
            // the blank item only when that list offers it.
            let hidden = hidden_for_selection(&mut cache, idx, &ps.selected, MODEL_VALUE_LISTS_NAME_THE_BLANK);
            set_hidden_items_at(definition, idx, hidden, Some(&key_name));
        }
    }
    // Then the gesture's own selections, same rule, over the same NEW
    // records -- last, so a selection being applied right now wins.
    for m in &masks {
        let key_name = format!("{}.{}", m.table, m.column);
        let Some(idx) = fold_index(definition, &m.table, &m.column) else {
            crate::log_warn!("PIVOT", "post-query mask on {} dropped: the new records do not carry it", key_name);
            continue;
        };
        let hidden = hidden_for_selection_listed(&mut cache, idx, &m.selected, m.blank_listed);
        set_hidden_items_at(definition, idx, hidden, Some(&key_name));
    }

    // Apply layout
    if let Some(ref layout_config) = request.layout {
        apply_layout_config(&mut definition.layout, layout_config);
    }

    // Grand/sub-totals are computed by summing the value columns over the axis,
    // which is not meaningful per calculation item (e.g. a YTD or ratio item
    // summed across rows is wrong). While a calculation group is applied, force
    // totals off so we never render a misleading total. Authoritative here so it
    // holds across the editor, the DSL, refresh, and .calp.
    if !calc_item_names.is_empty() {
        definition.layout.show_row_grand_totals = false;
        definition.layout.show_column_grand_totals = false;
        for f in definition.row_fields.iter_mut().chain(definition.column_fields.iter_mut()) {
            f.show_subtotals = false;
        }
    }

    // Update calculated fields. The Design-view DSL has no number-format
    // syntax, so an incoming def without one keeps the existing format
    // for the same-named field instead of silently wiping it.
    if let Some(ref calc_fields) = request.calculated_fields {
        let existing = std::mem::take(&mut definition.calculated_fields);
        definition.calculated_fields = calc_fields
            .iter()
            .map(|cf| pivot_engine::CalculatedField {
                name: cf.name.clone(),
                formula: cf.formula.clone(),
                number_format: cf.number_format.clone().or_else(|| {
                    existing
                        .iter()
                        .find(|e| e.name == cf.name)
                        .and_then(|e| e.number_format.clone())
                }),
            })
            .collect();
    }

    // Update value column order
    if let Some(ref order) = request.value_column_order {
        definition.value_column_order = order
            .iter()
            .map(|r| match r {
                ValueColumnRefDef::Value { index } => pivot_engine::ValueColumnRef::Value(*index),
                ValueColumnRefDef::Calculated { index } => pivot_engine::ValueColumnRef::Calculated(*index),
            })
            .collect();
    }

    // Set up hierarchy configs for ragged behavior support in the pivot engine.
    {
        definition.hierarchy_configs.clear();
        let mut row_offset = hierarchy_row_start;
        let mut col_offset = hierarchy_col_start;
        for hm in &hierarchy_metas {
            let ragged = match hm.ragged_behavior {
                BiRaggedBehavior::ShowBlanks => pivot_engine::RaggedBehavior::ShowBlanks,
                BiRaggedBehavior::HideMembers => pivot_engine::RaggedBehavior::HideMembers,
                BiRaggedBehavior::RepeatParent => pivot_engine::RaggedBehavior::RepeatParent,
                BiRaggedBehavior::ShowAsLeaf => pivot_engine::RaggedBehavior::ShowAsLeaf,
            };
            if hm.is_row {
                definition.hierarchy_configs.push(pivot_engine::HierarchyConfig {
                    name: hm.name.clone(),
                    field_start: row_offset,
                    field_count: hm.field_count,
                    is_row: true,
                    ragged_behavior: ragged,
                });
                row_offset += hm.field_count;
            } else {
                definition.hierarchy_configs.push(pivot_engine::HierarchyConfig {
                    name: hm.name.clone(),
                    field_start: col_offset,
                    field_count: hm.field_count,
                    is_row: false,
                    ragged_behavior: ragged,
                });
                col_offset += hm.field_count;
            }
        }
    }

    definition.bump_version();

    // Calculate pivot view
    let t_calc = Instant::now();
    *stored_cache = cache;
    let view = safe_calculate_pivot(definition, stored_cache);
    store_view(&pivot_state, pivot_id, &view);
    let calc_ms = t_calc.elapsed().as_secs_f64() * 1000.0;

    let t_resp = Instant::now();
    let mut response = view_to_response(&view, definition, stored_cache);
    let resp_ms = t_resp.elapsed().as_secs_f64() * 1000.0;
    let destination = definition.destination;
    let auto_fit = definition.layout.auto_fit_column_widths;
    let framed = definition.canvas_frame.is_some();
    let dest_ref = PivotDestSheet::of(definition);
    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    // Update grid (clear old region + write new)
    let t_grid = Instant::now();
    let saved_cells = save_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    response.overwritten_cell_count = saved_cells.len() as u32;
    let old_region = get_pivot_region(&state, pivot_id);
    update_pivot_in_grid(&state, &effect, pivot_id, dest_sheet_idx, destination, &view, framed)?;
    // Carried into the undo step below, like the non-BI path: Excel undoes a
    // pivot change and the column resize it caused as ONE press.
    let prev_col_widths = if auto_fit {
        auto_fit_pivot_columns(&state, &effect, dest_sheet_idx, destination, &view)
    } else {
        Vec::new()
    };
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    recalc_after_pivot_write(
        &state,
        &pivot_state,
        Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }),
        dest_sheet_idx,
        old_region.as_ref(),
        destination,
        &view,
    );
    let grid_ms = t_grid.elapsed().as_secs_f64() * 1000.0;

    // Store last query + lookup column set in bi_metadata
    {
        let mut bi_meta = pivot_state.bi_metadata.write(&effect)
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        if let Some(meta) = bi_meta.get_mut(&pivot_id) {
            let group_fields: Vec<BiFieldRef> = request
                .row_fields
                .iter()
                .chain(request.column_fields.iter())
                .filter(|f| !f.is_lookup)
                .cloned()
                .collect();
            let lookup_fields: Vec<BiFieldRef> = request
                .row_fields
                .iter()
                .chain(request.column_fields.iter())
                .filter(|f| f.is_lookup)
                .cloned()
                .collect();
            meta.last_query = Some(BiPivotQuery {
                measures: request.value_fields.iter().map(|v| v.measure_name.clone()).collect(),
                group_by: group_fields,
                lookups: lookup_fields,
            });
            // A placed calculation group needs no extra metadata: it lives in
            // the definition's row/column/filter fields like any dimension,
            // so refresh reconstruction picks it up from the field names.
            // Record the data snapshot time only when we actually went to the
            // database (online). When served purely from cache (all_warm, e.g.
            // offline), keep the existing timestamp so "Data as of …" reflects
            // when the data was truly fetched, not when the layout last changed.
            if !all_warm {
                meta.data_as_of = Some(chrono::Utc::now().to_rfc3339());
            }
            // Persist full lookup column set (including fields not in zones)
            meta.lookup_columns = request.lookup_columns.into_iter().collect();
        }
    }

    // ONE undo step for the whole field change, built after the work
    // succeeded (the caller records it). The cache travels with it: this path
    // re-queried the model, so the old definition means nothing against the
    // new records (BUG-0021).
    let undo = BiFieldChangeUndo {
        pivot_id,
        definition: old_definition,
        overwritten_cells: saved_cells,
        dest_sheet_idx,
        prev_col_widths,
        cache: Some(old_cache),
    };

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
    let payload_bytes = serde_json::to_string(&response).map(|s| s.len()).unwrap_or(0);
    let payload_kb = payload_bytes as f64 / 1024.0;
    log_perf!(
        "PIVOT",
        "update_bi_pivot_fields pivot_id={} rows={}x{} | query={:.1}ms cache={:.1}ms calc={:.1}ms resp={:.1}ms grid={:.1}ms TOTAL={:.1}ms | payload={:.1}KB",
        pivot_id,
        response.row_count,
        response.col_count,
        query_ms,
        cache_ms,
        calc_ms,
        resp_ms,
        grid_ms,
        total_ms,
        payload_kb
    );

    Ok((response, Some(undo)))
}

/// Persists the set of LOOKUP columns for a BI pivot without re-querying.
/// This is a lightweight call that only updates metadata — no BI query,
/// no pivot recalculation, no grid update.
#[tauri::command]
pub fn set_bi_lookup_columns(
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    lookup_columns: Vec<String>,
) -> Result<(), String> {
    // Refusal-first: verify this really is a BI-backed pivot under a READ guard,
    // so a refused call never mints the eager `mutates` token.
    {
        let probe = pivot_state
            .bi_metadata
            .read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        if !probe.contains_key(&pivot_id) {
            return Err(format!("No BI metadata for pivot {}", pivot_id));
        }
    }
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut bi_meta = pivot_state
        .bi_metadata
        .write(&effect)
        .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
    let meta = bi_meta
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("No BI metadata for pivot {}", pivot_id))?;
    meta.lookup_columns = lookup_columns.into_iter().collect();
    Ok(())
}

// ============================================================================
// REPORT FILTER PAGES
// ============================================================================

/// Generates one sheet per unique value of a filter field.
/// Each sheet contains a static copy of the pivot table filtered to that value.
#[tauri::command]
pub fn show_report_filter_pages(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    filter_field_index: usize,
) -> Result<Vec<String>, String> {
    log_info!(
        "PIVOT",
        "show_report_filter_pages pivot_id={} filter_field={}",
        pivot_id,
        filter_field_index
    );
    show_report_filter_pages_core(&state, &file_state, &pivot_state, pivot_id, filter_field_index)
}

/// The refusal wording for Show Report Filter Pages ("Cannot show report
/// filter pages while the workbook structure is protected").
const REPORT_FILTER_PAGES_ACTION: &str = "show report filter pages";

/// [`show_report_filter_pages`] over borrowed state.
///
/// THE PAGES GO IN THROUGH THE ONE ADD PATH (fix round 4, B4):
/// `sheets::append_user_sheet`, without switching to them. This pushed only
/// `sheet_names` and `grids`, so every page lacked its id, kind, visibility,
/// freeze, zoom and row/column-size entries; with a floating range in the
/// workbook the pages landed BEHIND its object sheet; and a protected workbook
/// structure did not stop it. Every refusal -- the pivot, the field, a value
/// whose page cannot be named, the workbook structure -- comes before anything
/// is written, and so does the plan of the pages' names, so a call with
/// nothing to add leaves the document clean. Every planned name is one the add
/// path accepts (fix round 5) and free (a taken one gets a " (2)" suffix,
/// BUG-0198), so every value gets its page.
pub(crate) fn show_report_filter_pages_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    pivot_state: &PivotState,
    pivot_id: PivotId,
    filter_field_index: usize,
) -> Result<Vec<String>, String> {
    // A COPY, with the guard released before any sheet is added: the
    // calculation pass (`calculate_now`, off the main thread) holds grid, grids
    // and sheet_names while it takes `pivot_tables`, so holding the pivot guard
    // across the add was an ABBA hang. Every page renders from its own clone of
    // the cache.
    let (definition, cache) = {
        let pivot_tables = pivot_state.pivot_tables.read().unwrap();
        let (definition, cache) = pivot_tables
            .get(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
        (definition.clone(), cache.clone())
    };
    let definition = &definition;

    if filter_field_index >= definition.filter_fields.len() {
        return Err(format!(
            "Filter field index {} out of range (max {})",
            filter_field_index,
            definition.filter_fields.len().saturating_sub(1)
        ));
    }

    let filter_field = &definition.filter_fields[filter_field_index];
    let field_index = filter_field.field.source_index;

    // Get unique values for this filter field
    let unique_values = cache.get_unique_values_for_filter(field_index);
    if unique_values.is_empty() {
        return Ok(Vec::new());
    }

    // THE PLAN: one page per value, named after the value. A name that is
    // taken -- IGNORING CASE, the comparison the rest of the crate makes when
    // it looks a sheet up by name -- by a sheet of the workbook OR by a page
    // already planned gets the unique " (2)", " (3)" name a sheet copy gets,
    // as Excel does. It used to be SKIPPED: `a/b` and `a_b` both clean to
    // `a_b`, `' 'x` and `x' '` to `x`, and the second value got no page and no
    // error (BUG-0198; owner default 2026-09-28: suffix, never skip).
    let mut taken = sheet_names_snapshot(state);
    let mut planned: Vec<(String, String)> = Vec::new();
    for (_vid, value_label) in &unique_values {
        if value_label.is_empty() {
            continue;
        }
        // The name the add path will be asked for must be one it ACCEPTS. A
        // name it refused was refused AFTER this command's effect and the
        // page's styles, and the value got no page with nothing but a log
        // line to say so (fix round 5: `' 'x` cleaned to `'x`). The cleaning
        // now always yields a legal name; should it ever not, the whole
        // command is refused HERE, before anything is written, and says which
        // value it could not name.
        let cleaned = crate::sheet_names::validate_sheet_name(&sanitize_sheet_name(value_label))
            .map_err(|e| format!("Cannot name a report filter page after '{}': {}", value_label, e))?;
        // Free, or made free: the helper shortens the stem to leave room for
        // the suffix, so the result is still a name the add path accepts.
        let sheet_name = crate::sheet_names::unique_sheet_name(&cleaned, &taken);
        taken.push(sheet_name.clone());
        planned.push((sheet_name, value_label.clone()));
    }
    if planned.is_empty() {
        return Ok(Vec::new());
    }

    // The workbook-structure gate, BEFORE the first write: registering the
    // pages' styles below already changes the document. (The add path checks
    // again, authoritatively, for each page.)
    crate::protection::check_workbook_structure(state, REPORT_FILTER_PAGES_ACTION)?;
    // Past every refusal. This generates one NEW SHEET per filter value -- a
    // large document change behind a name that reads like a view action. This
    // effect covers the style registry; each page's own add mints its own.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let all_labels: Vec<String> = unique_values.iter().map(|(_, l)| l.clone()).collect();
    let mut created_sheets = Vec::new();

    for (sheet_name, value_label) in planned {
        // Clone definition and apply the filter for this value: show only this
        // value (hide all others).
        let mut filtered_def = definition.clone();
        let hidden: Vec<String> = all_labels
            .iter()
            .filter(|l| l.as_str() != value_label.as_str())
            .cloned()
            .collect();
        filtered_def.filter_fields[filter_field_index].field.hidden_items = hidden;

        // Compute the filtered pivot view
        let mut cache_clone = cache.clone();
        let view = safe_calculate_pivot(&filtered_def, &mut cache_clone);

        // The page's cells, written into a DETACHED grid under the style
        // registry alone.
        let mut page = engine::Grid::new();
        {
            let mut styles = state.style_registry.write(&effect).unwrap();
            let _ = crate::pivot::operations::write_pivot_to_grid(
                &mut page,
                None,
                &view,
                (0, 0),
                &mut styles,
            );
        }

        match crate::sheets::append_user_sheet(
            state,
            file_state,
            crate::sheets::NewUserSheet {
                name: crate::sheets::NewSheetName::Exact(sheet_name.clone()),
                kind: ::persistence::SheetKind::Worksheet,
                cells: Some(page),
                activate: false,
            },
            REPORT_FILTER_PAGES_ACTION,
        ) {
            Ok(added) => created_sheets.push(added.name),
            // The plan validated every name, so only a RACE lands here -- a
            // name another command took, or a structure it protected, between
            // the plan and this add: skipped, as a taken name always was.
            Err(e) => log_info!("PIVOT", "show_report_filter_pages skipped '{}': {}", sheet_name, e),
        }
    }

    // Excel parity (BUG-0005), as `add_sheet`: new sheets end the undo
    // history. Nothing was switched to, so the dependency maps -- which describe
    // the active sheet -- still describe the sheet the user is on.
    if !created_sheets.is_empty() {
        crate::sheets::invalidate_undo_history_for_sheet_structure(state, REPORT_FILTER_PAGES_ACTION);
    }

    Ok(created_sheets)
}

/// Coerce a FIELD VALUE into a legal sheet name.
///
/// One rule, one place: this was a second copy of Excel's character set and
/// length limit, and it had already drifted from the rule entry enforces -- it
/// knew nothing about a leading or trailing apostrophe, or about `History`,
/// both of which entry refuses. `crate::sheet_names` is the single
/// representation; this is the coercing face of it, for names built out of data
/// where there is no user to show a message to.
fn sanitize_sheet_name(name: &str) -> String {
    crate::sheet_names::sanitize_sheet_name(name)
}

// ============================================================================
// CALCULATED FIELD COMMANDS
// ============================================================================

/// Adds a calculated field to a pivot table.
#[tauri::command]
pub fn add_calculated_field(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: CalculatedFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "add_calculated_field pivot_id={} name={} formula={}",
        request.pivot_id,
        request.name,
        request.formula
    );

    // Validate the formula parses correctly
    pivot_engine::calculated::parse_calc_formula(&request.formula)
        .map_err(|e| format!("Invalid formula: {}", e))?;

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    definition.calculated_fields.push(pivot_engine::CalculatedField {
        name: request.name,
        formula: request.formula,
        number_format: request.number_format,
    });

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Updates an existing calculated field.
#[tauri::command]
pub fn update_calculated_field(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: UpdateCalculatedFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "update_calculated_field pivot_id={} index={} name={} formula={}",
        request.pivot_id,
        request.field_index,
        request.name,
        request.formula
    );

    pivot_engine::calculated::parse_calc_formula(&request.formula)
        .map_err(|e| format!("Invalid formula: {}", e))?;

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    if request.field_index >= definition.calculated_fields.len() {
        return Err(format!(
            "Calculated field index {} out of range (max {})",
            request.field_index,
            definition.calculated_fields.len().saturating_sub(1)
        ));
    }

    definition.calculated_fields[request.field_index] = pivot_engine::CalculatedField {
        name: request.name,
        formula: request.formula,
        number_format: request.number_format,
    };

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Removes a calculated field from a pivot table.
#[tauri::command]
pub fn remove_calculated_field(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: RemoveCalculatedFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "remove_calculated_field pivot_id={} index={}",
        request.pivot_id,
        request.field_index
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    if request.field_index >= definition.calculated_fields.len() {
        return Err(format!(
            "Calculated field index {} out of range (max {})",
            request.field_index,
            definition.calculated_fields.len().saturating_sub(1)
        ));
    }

    definition.calculated_fields.remove(request.field_index);
    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

// ============================================================================
// CALCULATED ITEM COMMANDS
// ============================================================================

/// Adds a calculated item to a pivot field.
#[tauri::command]
pub fn add_calculated_item(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: CalculatedItemRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "add_calculated_item pivot_id={} field_index={} name={} formula={}",
        request.pivot_id,
        request.field_index,
        request.name,
        request.formula
    );

    pivot_engine::calculated::parse_calc_formula(&request.formula)
        .map_err(|e| format!("Invalid formula: {}", e))?;

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    definition.calculated_items.push(pivot_engine::CalculatedItem {
        field_index: request.field_index,
        name: request.name,
        formula: request.formula,
    });

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

/// Removes a calculated item from a pivot table.
#[tauri::command]
pub fn remove_calculated_item(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    request: RemoveCalculatedItemRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "remove_calculated_item pivot_id={} index={}",
        request.pivot_id,
        request.item_index
    );

    let (effect, mut pivot_tables) = pivot_write(&state, &pivot_state, &file_state, request.pivot_id)?;
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    if request.item_index >= definition.calculated_items.len() {
        return Err(format!(
            "Calculated item index {} out of range (max {})",
            request.item_index,
            definition.calculated_items.len().saturating_sub(1)
        ));
    }

    definition.calculated_items.remove(request.item_index);
    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_ref = PivotDestSheet::of(definition);

    drop(pivot_tables);
    let dest_sheet_idx = dest_ref.resolve(&state);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &effect, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some(PivotRecalcStates { pane: &pane_control_state, ribbon: &ribbon_filter_state, user_files: &user_files_state }))?;

    Ok(response)
}

// ============================================================================
// FIX ROUND 3 (review): the drill paths' lock order. The calculation pass
// (`calculate_now`, an ASYNC command, so on a pool thread) takes `grid`, then
// `grids`, then `sheet_names`, and then `pivot_tables` for GETPIVOTDATA. A
// drill that waits for one of those while holding a later one closes a cycle
// and hangs the app with no panic and no log.
// ============================================================================

#[cfg(test)]
mod drill_lock_order_tests {
    use super::*;
    use crate::document_effect::test_seed_effect;
    use crate::persistence::FileState;
    use std::time::Duration;

    struct Fx {
        state: AppState,
        file: FileState,
        pivots: PivotState,
        bi: BiState,
        pivot: PivotId,
    }

    /// Two worksheets. The pivot's SOURCE is on the second one (A1:B3, with
    /// headers); the first holds decoy values in the same cells, so a read of
    /// the wrong sheet shows. Sheet 1 is active again afterwards.
    fn fx() -> Fx {
        let state = crate::create_app_state();
        let file = FileState::default();
        crate::sheets::add_sheet_inner(&state, &file, None, ::persistence::SheetKind::Worksheet)
            .expect("add the source sheet");
        let seed = test_seed_effect();
        let names = state.sheet_names.read().unwrap().clone();
        assert_eq!(names.len(), 2, "fixture: two sheets");
        let cells = |rows: [[&str; 2]; 3]| {
            let mut grid = engine::grid::Grid::new();
            for (r, row) in rows.iter().enumerate() {
                for (c, v) in row.iter().enumerate() {
                    grid.set_cell(r as u32, c as u32, engine::Cell::new_text(v.to_string()));
                }
            }
            grid
        };
        let source = cells([["Region", "Rep"], ["East", "Ann"], ["West", "Bo"]]);
        let decoy = cells([["Region", "Rep"], ["DECOY", "DECOY"], ["DECOY", "DECOY"]]);
        {
            let mut grids = state.grids.write(&seed).unwrap();
            grids[0] = decoy.clone();
            grids[1] = source.clone();
        }
        *state.active_sheet.write(&seed).unwrap() = 0;
        *state.grid.write(&seed).unwrap() = decoy;

        let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let (mut cache, headers) =
            crate::pivot::operations::build_cache_from_grid(&source, (0, 0), (2, 1), true).expect("the cache");
        for (i, h) in headers.iter().enumerate() {
            cache.set_field_name(i, h.clone());
        }
        let mut def = PivotDefinition::new(id, (0, 0), (2, 1));
        def.source_has_headers = true;
        def.source_sheet = Some(names[1].clone());
        def.destination_sheet = Some(names[0].clone());
        def.destination = (10, 10);
        def.row_fields.push(PivotField::new(0, "Region".to_string()));
        let pivots = PivotState::new();
        pivots.pivot_tables.write(&seed).unwrap().insert(id, (def, cache));
        Fx { state, file, pivots, bi: BiState::new(), pivot: id }
    }

    /// Run `command` on its own thread while THIS thread holds the lock a
    /// concurrent holder takes FIRST (`hold`); once the command is parked on
    /// it, a third thread takes the lock that holder takes NEXT (`next`).
    /// Returns (the command was parked, `next` was reachable, its result).
    /// Unreachable = the command held `next` while it waited: an ABBA.
    fn next_lock_reachable_while_parked<G, R: Send>(
        hold: impl FnOnce() -> G,
        command: impl FnOnce() -> R + Send,
        next: impl FnOnce() + Send,
    ) -> (bool, bool, R) {
        std::thread::scope(|scope| {
            let guard = hold();
            let runner = scope.spawn(command);
            std::thread::sleep(Duration::from_millis(300));
            // The command needs the held lock, so it cannot have finished.
            let parked = !runner.is_finished();
            let (tx, rx) = std::sync::mpsc::channel();
            let taker = scope.spawn(move || {
                next();
                let _ = tx.send(());
            });
            let reached = rx.recv_timeout(Duration::from_secs(3)).is_ok();
            drop(guard); // let everyone finish, whatever happened
            let result = runner.join().unwrap();
            taker.join().unwrap();
            (parked, reached, result)
        })
    }

    fn drill(fx: &Fx) -> Result<DrillThroughResponse, String> {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(drill_through_to_sheet_core(
            &fx.state,
            &fx.file,
            &fx.pivots,
            &fx.bi,
            DrillThroughRequest { pivot_id: fx.pivot, group_path: Vec::new(), max_records: None },
        ))
    }

    /// Show Details (a double-click on a pivot value) during an F9: the pass
    /// holds `grids` and takes `pivot_tables` next. This command used to hold
    /// `pivot_tables` while it waited for `grids`.
    #[test]
    fn showing_a_pivots_details_never_holds_the_pivot_lock_while_it_waits_for_grids() {
        let fx = fx();
        let (parked, reached, result) = next_lock_reachable_while_parked(
            || fx.state.grids.read().unwrap(),
            || pivot_source_data_core(&fx.state, &fx.pivots, fx.pivot, &[], None),
            || {
                let _g = fx.pivots.pivot_tables.read().unwrap();
            },
        );
        let data = result.expect("the details");
        assert!(parked, "fixture: the command did not wait for grids");
        assert_eq!(
            data.rows,
            vec![vec!["East".to_string(), "Ann".to_string()], vec!["West".to_string(), "Bo".to_string()]],
            "fixture: the details are the source sheet's rows"
        );
        assert!(
            reached,
            "get_pivot_source_data held pivot_tables while it waited for grids (ABBA against the calculation pass)"
        );
    }

    /// The same for a grid-backed drill-through's row read.
    #[test]
    fn a_grid_drill_through_never_holds_the_pivot_lock_while_it_waits_for_grids() {
        let fx = fx();
        let (parked, reached, result) = next_lock_reachable_while_parked(
            || fx.state.grids.read().unwrap(),
            || drill(&fx),
            || {
                let _g = fx.pivots.pivot_tables.read().unwrap();
            },
        );
        result.expect("the drill-through");
        assert!(parked, "fixture: the drill-through did not wait for grids");
        assert!(
            reached,
            "drill_through_to_sheet held pivot_tables while it waited for grids (ABBA against the calculation pass)"
        );
    }

    /// The drill-through's new sheet: the calculation pass and `add_sheet`
    /// take `grid` FIRST and `grids` next. This took `sheet_names`, `grids`
    /// and `active_sheet`, and waited for `grid` while holding them.
    #[test]
    fn a_drill_through_sheet_takes_grid_before_grids() {
        let fx = fx();
        let (parked, reached, result) = next_lock_reachable_while_parked(
            || fx.state.grid.write(&test_seed_effect()).unwrap(),
            || drill(&fx),
            || {
                let _g = fx.state.grids.read().unwrap();
            },
        );
        let response = result.expect("the drill-through");
        assert!(parked, "fixture: the drill-through did not wait for grid");
        assert_eq!(response.sheet_index, 2, "fixture: a third sheet");
        assert!(
            reached,
            "drill_through_to_sheet held grids while it waited for grid (ABBA against the calculation pass \
             and add_sheet)"
        );
    }

    /// A grid-backed drill-through lists the rows of the pivot's OWN source
    /// sheet. It read sheet 0 whatever the source was, so drilling a pivot
    /// built on Sheet2 listed Sheet1's cells ("DECOY" here) under the pivot's
    /// headers.
    #[test]
    fn a_grid_drill_through_lists_the_rows_of_the_pivots_own_source_sheet() {
        let fx = fx();
        let response = drill(&fx).expect("the drill-through");
        assert_eq!(response.row_count, 2, "fixture: two source rows");
        let grids = fx.state.grids.read().unwrap();
        let sheet = &grids[response.sheet_index];
        let text = |r: u32, c: u32| sheet.get_cell(r, c).map(|cell| cell.display_value()).unwrap_or_default();
        assert_eq!((text(0, 0), text(0, 1)), ("Region".to_string(), "Rep".to_string()), "fixture: the headers");
        assert_eq!(
            [text(1, 0), text(1, 1), text(2, 0), text(2, 1)],
            ["East", "Ann", "West", "Bo"].map(str::to_string),
            "the drill-through listed another sheet's rows"
        );
    }

    // ========================================================================
    // FIX ROUND 4, B4: the drill-through and Show Report Filter Pages add
    // their sheets through the ONE add path (`sheets::append_user_sheet`).
    // Both pushed only `sheet_names` and `grids`.
    // ========================================================================

    /// Every per-sheet store `append_sheet_stores` maintains, with its length.
    fn per_sheet_store_lengths(state: &AppState) -> Vec<(&'static str, usize)> {
        vec![
            ("grids", state.grids.read().unwrap().len()),
            ("freeze_configs", state.freeze_configs.read().unwrap().len()),
            ("tab_colors", state.tab_colors.read().unwrap().len()),
            ("sheet_visibility", state.sheet_visibility.read().unwrap().len()),
            ("all_column_widths", state.all_column_widths.read().unwrap().len()),
            ("all_row_heights", state.all_row_heights.read().unwrap().len()),
            ("split_configs", state.split_configs.read().unwrap().len()),
            ("scroll_areas", state.scroll_areas.lock().unwrap().len()),
            ("sheet_zooms", state.sheet_zooms.read().unwrap().len()),
            ("page_setups", state.page_setups.read().unwrap().len()),
            ("sheet_ids", state.sheet_ids.read().unwrap().len()),
            ("show_gridlines", state.show_gridlines.read().unwrap().len()),
            ("sheet_display_flags", state.sheet_display_flags.read().unwrap().len()),
            ("sheet_kinds", state.sheet_kinds.read().unwrap().len()),
            ("all_merged_regions", state.all_merged_regions.read().unwrap().len()),
            ("all_user_hidden_rows", state.all_user_hidden_rows.read().unwrap().len()),
            ("all_user_hidden_cols", state.all_user_hidden_cols.read().unwrap().len()),
        ]
    }

    fn assert_every_store_has_one_entry_per_sheet(state: &AppState, sheets: usize, when: &str) {
        let names = state.sheet_names.read().unwrap().len();
        assert_eq!(names, sheets, "{when}: the sheet count");
        let off: Vec<(&str, usize)> =
            per_sheet_store_lengths(state).into_iter().filter(|(_, n)| *n != names).collect();
        assert!(
            off.is_empty(),
            "{when}: these per-sheet stores do not have one entry per sheet ({names} sheets): {off:?}"
        );
        let ids = state.sheet_ids.read().unwrap().clone();
        let mut unique = ids.clone();
        unique.sort_by_key(|id| id.to_string());
        unique.dedup();
        assert_eq!(unique.len(), ids.len(), "{when}: two sheets share an id");
    }

    /// A floating range's OBJECT-backed sheet at the tail, appended exactly as
    /// `create_floating_range` appends one.
    fn append_object_sheet(state: &AppState, name: &str) -> usize {
        let effect = test_seed_effect();
        let mut sheet_names = state.sheet_names.write(&effect).unwrap();
        let mut grids = state.grids.write(&effect).unwrap();
        let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
        let mut tab_colors = state.tab_colors.write(&effect).unwrap();
        let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();
        let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
        let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();
        crate::sheets::append_sheet_stores(
            state,
            &effect,
            name.to_string(),
            crate::sheets::OBJECT_SHEET_VISIBILITY,
            ::persistence::SheetKind::Worksheet,
            &mut sheet_names,
            &mut grids,
            &mut freeze_configs,
            &mut tab_colors,
            &mut sheet_visibility,
            &mut all_column_widths,
            &mut all_row_heights,
        )
        .0
    }

    fn protect_structure(state: &AppState) {
        state.workbook_protection.write(&test_seed_effect()).unwrap().protected = true;
    }

    fn names(state: &AppState) -> Vec<String> {
        state.sheet_names.read().unwrap().clone()
    }

    /// Region moves to the Filter area and Rep to the rows, so the pivot has
    /// one report filter page per region (East, West).
    fn filter_on_region(fx: &Fx) {
        let mut tables = fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap();
        let (def, _) = tables.get_mut(&fx.pivot).unwrap();
        def.row_fields.clear();
        def.row_fields.push(PivotField::new(1, "Rep".to_string()));
        def.filter_fields.push(pivot_engine::PivotFilter {
            field: PivotField::new(0, "Region".to_string()),
            condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
        });
    }

    /// The drill-through sheet gets an entry in EVERY per-sheet store, and the
    /// column width set on the sheet it leaves is stashed with that sheet. It
    /// pushed only `sheet_names` and `grids`, so a probe found 3 sheet names
    /// and 2 ids, kinds and visibilities, and `all_column_widths` stayed
    /// `[{}, {}]`: the width stayed live on the drill-through sheet and was
    /// gone from its own.
    #[test]
    fn a_drill_through_sheet_gets_every_per_sheet_store_and_keeps_the_width_of_the_sheet_it_left() {
        let fx = fx();
        assert_every_store_has_one_entry_per_sheet(&fx.state, 2, "fixture");
        fx.state.column_widths.write(&test_seed_effect()).unwrap().insert(3, 120.0);

        let response = drill(&fx).expect("the drill-through");

        assert_every_store_has_one_entry_per_sheet(&fx.state, 3, "after the drill-through");
        assert_eq!(response.sheet_index, 2, "fixture: a third sheet");
        assert_eq!(response.sheet_name, "DrillThrough");
        assert_eq!(*fx.state.active_sheet.read().unwrap(), 2, "the drill-through sheet is active");
        assert_eq!(
            fx.state.all_column_widths.read().unwrap()[0].get(&3),
            Some(&120.0),
            "the width set on the drilled-from sheet was lost"
        );
        assert!(
            fx.state.column_widths.read().unwrap().is_empty(),
            "the drilled-from sheet's width stayed live on the drill-through sheet"
        );
        assert_eq!(
            fx.state.sheet_visibility.read().unwrap()[2],
            "visible",
            "the drill-through sheet is an ordinary user sheet"
        );
        let grid = fx.state.grid.read().unwrap();
        assert_eq!(
            grid.get_cell(1, 0).map(|c| c.display_value()),
            Some("East".to_string()),
            "fixture: the active mirror carries the detail rows"
        );
    }

    /// With a floating range in the workbook the drill-through sheet lands in
    /// the USER prefix, before the object sheet -- it was appended behind it.
    #[test]
    fn a_drill_through_sheet_lands_before_a_floating_ranges_object_sheet() {
        let fx = fx();
        let object = append_object_sheet(&fx.state, "Float1");
        assert_eq!(object, 2, "fixture: the object sheet is the tail");
        assert_every_store_has_one_entry_per_sheet(&fx.state, 3, "fixture");

        let response = drill(&fx).expect("the drill-through");

        assert_eq!(response.sheet_index, 2, "the drill-through sheet is not in the user prefix");
        assert_eq!(names(&fx.state), vec!["Sheet1", "Sheet2", "DrillThrough", "Float1"]);
        let visibility = fx.state.sheet_visibility.read().unwrap().clone();
        assert_eq!(visibility[2], "visible");
        assert_eq!(visibility[3], crate::sheets::OBJECT_SHEET_VISIBILITY, "the object sheet stays at the tail");
        assert_every_store_has_one_entry_per_sheet(&fx.state, 4, "after the drill-through");
        let grids = fx.state.grids.read().unwrap();
        assert_eq!(
            grids[2].get_cell(1, 0).map(|c| c.display_value()),
            Some("East".to_string()),
            "the detail rows are on the drill-through sheet"
        );
        assert!(grids[3].get_cell(1, 0).is_none(), "the detail rows landed on the object sheet");
    }

    /// A protected workbook structure refuses the drill-through before
    /// anything is written, and the document stays clean.
    #[test]
    fn a_protected_workbook_structure_refuses_a_drill_through_and_stays_clean() {
        let fx = fx();
        protect_structure(&fx.state);
        crate::document_effect::mark_saved(&fx.file);

        let err = drill(&fx).expect_err("a protected structure must refuse the drill-through");

        assert!(err.contains("protected"), "got: {err}");
        assert_eq!(names(&fx.state), vec!["Sheet1", "Sheet2"], "a sheet was added anyway");
        assert!(!fx.file.is_dirty(), "a refused drill-through dirtied the document");
        assert_every_store_has_one_entry_per_sheet(&fx.state, 2, "after the refusal");
    }

    /// Show Report Filter Pages: one page per value, each with an entry in
    /// every per-sheet store, in the USER prefix (before a floating range's
    /// object sheet), and the user stays on the sheet they were on.
    #[test]
    fn report_filter_pages_get_every_per_sheet_store_and_land_before_a_floating_ranges_object_sheet() {
        let fx = fx();
        filter_on_region(&fx);
        append_object_sheet(&fx.state, "Float1");
        fx.state.column_widths.write(&test_seed_effect()).unwrap().insert(3, 120.0);
        crate::document_effect::mark_saved(&fx.file);

        let created = show_report_filter_pages_core(&fx.state, &fx.file, &fx.pivots, fx.pivot, 0)
            .expect("the report filter pages");

        assert_eq!(created, vec!["East".to_string(), "West".to_string()]);
        assert_eq!(names(&fx.state), vec!["Sheet1", "Sheet2", "East", "West", "Float1"]);
        let visibility = fx.state.sheet_visibility.read().unwrap().clone();
        assert_eq!(&visibility[2..4], &["visible".to_string(), "visible".to_string()]);
        assert_eq!(visibility[4], crate::sheets::OBJECT_SHEET_VISIBILITY, "the object sheet stays at the tail");
        assert_every_store_has_one_entry_per_sheet(&fx.state, 5, "after the pages");
        assert_eq!(*fx.state.active_sheet.read().unwrap(), 0, "the pages switched the user away");
        assert_eq!(
            fx.state.column_widths.read().unwrap().get(&3),
            Some(&120.0),
            "the active sheet's width moved"
        );
        let grids = fx.state.grids.read().unwrap();
        for page in [2usize, 3] {
            assert!(!grids[page].cells.is_empty(), "page {page} carries no pivot cells");
        }
        assert!(grids[4].cells.is_empty(), "a page's cells landed on the object sheet");
        assert!(fx.file.is_dirty(), "fixture: the pages are a document change");
    }

    /// A protected workbook structure refuses Show Report Filter Pages before
    /// anything is written (the pages' styles included), and the document
    /// stays clean.
    #[test]
    fn a_protected_workbook_structure_refuses_report_filter_pages_and_stays_clean() {
        let fx = fx();
        filter_on_region(&fx);
        protect_structure(&fx.state);
        crate::document_effect::mark_saved(&fx.file);

        let err = show_report_filter_pages_core(&fx.state, &fx.file, &fx.pivots, fx.pivot, 0)
            .expect_err("a protected structure must refuse the pages");

        assert!(err.contains("protected"), "got: {err}");
        assert_eq!(names(&fx.state), vec!["Sheet1", "Sheet2"], "a page was added anyway");
        assert!(!fx.file.is_dirty(), "a refused Show Report Filter Pages dirtied the document");
    }

    // ========================================================================
    // FIX ROUND 5 (review of round 4, finding 1): what the drill-through and
    // Show Report Filter Pages END. `append_user_sheet` ends nothing itself:
    // each caller ends the undo history (Excel parity, BUG-0005) and, when it
    // switched to its sheet, rebuilds the dependency maps (BUG-0016). None of
    // those three calls had a test, and the undo reset protects DATA: with a
    // floating range in the workbook the new sheet is rotated INTO the object
    // sheet's index, so a queued step recorded on the object sheet replays onto
    // the new sheet. (`undo_sheet_structure_tests` holds the census that every
    // caller of the add path makes the calls.)
    // ========================================================================

    /// The block an undo step recorded on the object sheet claims. Every cell
    /// in it held nothing before the edit, so undoing the step CLEARS the block
    /// on whichever sheet the step's index names when it replays.
    const RECORDED_ROWS: std::ops::Range<u32> = 0..8;
    const RECORDED_COLS: std::ops::Range<u32> = 0..4;

    /// The floating range's cells typed in on sheet `object`, recorded the way
    /// a cell writer records them.
    fn record_an_edit_on(state: &AppState, object: usize) {
        let seed = test_seed_effect();
        let mut tx = crate::Transaction::new("Edit floating range");
        {
            let mut grids = state.grids.write(&seed).unwrap();
            for row in RECORDED_ROWS {
                for col in RECORDED_COLS {
                    grids[object].set_cell(row, col, engine::Cell::new_text(format!("fr{row}.{col}")));
                    tx.add_change(crate::CellChange::SetCell { sheet: object, row, col, previous: None });
                }
            }
        }
        state.undo_stack.lock().unwrap().push_transaction_direct(tx);
    }

    /// Every cell of sheet `index` as (row, col, text), sorted; the active
    /// sheet is read through its mirror.
    fn cells_of(state: &AppState, index: usize) -> Vec<(u32, u32, String)> {
        let active = *state.active_sheet.read().unwrap();
        let read = |grid: &engine::grid::Grid| {
            let mut cells: Vec<(u32, u32, String)> =
                grid.cells.iter().map(|(&(r, c), cell)| (r, c, cell.display_value())).collect();
            cells.sort();
            cells
        };
        if index == active {
            read(&state.grid.read().unwrap())
        } else {
            read(&state.grids.read().unwrap()[index])
        }
    }

    /// Ctrl+Z: the top step, replayed through the restore Undo runs.
    fn undo_once(fx: &Fx) {
        let popped = fx.state.undo_stack.lock().unwrap().pop_undo();
        if let Some(transaction) = popped {
            let files = crate::persistence::UserFilesState::default();
            let slicers = crate::slicer::SlicerState::new();
            let filters = crate::ribbon_filter::RibbonFilterState::new();
            let pane = crate::pane_control::PaneControlState::new();
            let timelines = crate::timeline_slicer::TimelineSlicerState::new();
            crate::undo_commands::apply_changes(
                &fx.state, &fx.file, &files, &fx.pivots, &slicers, &filters, &pane, &timelines, transaction, true,
            );
        }
    }

    /// A step recorded on a floating range's object sheet names index 2. The
    /// drill-through sheet is rotated into index 2, so a drill-through that
    /// leaves the history in place hands that step to the drill-through sheet:
    /// Ctrl+Z erased its header and rows (a reviewer's probe, fix round 4).
    #[test]
    fn a_drill_through_ends_the_undo_history_so_a_floating_range_step_never_replays_onto_it() {
        let fx = fx();
        let object = append_object_sheet(&fx.state, "Float1");
        assert_eq!(object, 2, "fixture: the object sheet is the tail");
        record_an_edit_on(&fx.state, object);
        let floating_range_cells = cells_of(&fx.state, object);

        let response = drill(&fx).expect("the drill-through");
        assert_eq!(response.sheet_index, 2, "fixture: the drill-through sheet took the object sheet's index");
        let drill_sheet = cells_of(&fx.state, 2);
        assert!(!drill_sheet.is_empty(), "fixture: the drill-through sheet has cells");
        let history_left = fx.state.undo_stack.lock().unwrap().can_undo();

        undo_once(&fx);

        assert_eq!(
            cells_of(&fx.state, 2),
            drill_sheet,
            "Ctrl+Z after a drill-through replayed the floating range's step onto the drill-through sheet"
        );
        assert_eq!(cells_of(&fx.state, 3), floating_range_cells, "the floating range's cells did not move with its sheet");
        assert!(!history_left, "the drill-through left the undo history in place (Excel parity, BUG-0005)");
    }

    /// The same for Show Report Filter Pages: its first page is rotated into
    /// the object sheet's index 2.
    #[test]
    fn report_filter_pages_end_the_undo_history_so_a_floating_range_step_never_replays_onto_a_page() {
        let fx = fx();
        filter_on_region(&fx);
        let object = append_object_sheet(&fx.state, "Float1");
        assert_eq!(object, 2, "fixture: the object sheet is the tail");
        record_an_edit_on(&fx.state, object);
        let floating_range_cells = cells_of(&fx.state, object);

        show_report_filter_pages_core(&fx.state, &fx.file, &fx.pivots, fx.pivot, 0).expect("the report filter pages");
        assert_eq!(names(&fx.state), vec!["Sheet1", "Sheet2", "East", "West", "Float1"], "fixture: the pages");
        let first_page = cells_of(&fx.state, 2);
        assert!(
            first_page.iter().any(|(r, c, _)| RECORDED_ROWS.contains(r) && RECORDED_COLS.contains(c)),
            "fixture: the recorded step covers none of the first page's cells: {first_page:?}"
        );
        let history_left = fx.state.undo_stack.lock().unwrap().can_undo();

        undo_once(&fx);

        assert_eq!(
            cells_of(&fx.state, 2),
            first_page,
            "Ctrl+Z after Show Report Filter Pages replayed the floating range's step onto the first page"
        );
        assert_eq!(cells_of(&fx.state, 4), floating_range_cells, "the floating range's cells did not move with its sheet");
        assert!(!history_left, "Show Report Filter Pages left the undo history in place (Excel parity, BUG-0005)");
    }

    /// The drill-through SWITCHES to its sheet, and the single-sheet dependency
    /// maps describe the active sheet only: they must be rebuilt for the new
    /// one (BUG-0016), or an edit there cascades along the edges of the sheet
    /// the user left.
    #[test]
    fn a_drill_through_rebuilds_the_dependency_maps_for_the_sheet_it_switches_to() {
        let fx = fx();
        // Sheet1 (active): C1 = A1*2, so the maps describe Sheet1.
        {
            let seed = test_seed_effect();
            let formula = engine::Cell::new_formula("A1*2".to_string());
            fx.state.grid.write(&seed).unwrap().set_cell(0, 2, formula.clone());
            fx.state.grids.write(&seed).unwrap()[0].set_cell(0, 2, formula);
        }
        crate::undo_commands::rebuild_all_dependencies(&fx.state);
        assert!(
            fx.state.dependencies.lock().unwrap().contains_key(&(0, 2)),
            "fixture: the maps describe Sheet1's C1 = A1*2"
        );

        let response = drill(&fx).expect("the drill-through");
        assert_eq!(*fx.state.active_sheet.read().unwrap(), response.sheet_index, "fixture: the drill-through sheet is active");

        let dependencies = fx.state.dependencies.lock().unwrap().clone();
        let dependents = fx.state.dependents.lock().unwrap().clone();
        assert!(
            dependencies.is_empty() && dependents.is_empty(),
            "the single-sheet dependency maps still describe the sheet the drill-through left (C1 = A1*2 on \
             Sheet1), not the drill-through sheet, which has no formula: dependencies {dependencies:?}, \
             dependents {dependents:?}"
        );
    }

    // ========================================================================
    // FIX ROUND 5 (review of round 4, finding 2): a filter value whose cleaned
    // name was still illegal. `' 'x` cleaned to `'x` (one pass of trimming),
    // the add path refused it AFTER the effect and the page's styles, and the
    // value got no page and no error.
    // ========================================================================

    /// The fixture, with the pivot's Region values replaced by `regions` and
    /// Region moved to the Filter area.
    fn fx_with_regions(regions: [&str; 2]) -> Fx {
        let fx = fx();
        let seed = test_seed_effect();
        let mut source = engine::grid::Grid::new();
        for (r, row) in [["Region", "Rep"], [regions[0], "Ann"], [regions[1], "Bo"]].iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                source.set_cell(r as u32, c as u32, engine::Cell::new_text(v.to_string()));
            }
        }
        fx.state.grids.write(&seed).unwrap()[1] = source.clone();
        let (mut cache, headers) =
            crate::pivot::operations::build_cache_from_grid(&source, (0, 0), (2, 1), true).expect("the cache");
        for (i, h) in headers.iter().enumerate() {
            cache.set_field_name(i, h.clone());
        }
        fx.pivots.pivot_tables.write(&seed).unwrap().get_mut(&fx.pivot).unwrap().1 = cache;
        filter_on_region(&fx);
        fx
    }

    #[test]
    fn every_filter_value_gets_a_page_even_when_its_cleaned_name_hid_an_apostrophe() {
        let fx = fx_with_regions(["' 'x", "West"]);
        crate::document_effect::mark_saved(&fx.file);

        let mut created = show_report_filter_pages_core(&fx.state, &fx.file, &fx.pivots, fx.pivot, 0)
            .expect("the report filter pages");

        created.sort();
        assert_eq!(
            created,
            vec!["West".to_string(), "x".to_string()],
            "a filter value got no page and no error; sheets {:?}",
            names(&fx.state)
        );
        assert_every_store_has_one_entry_per_sheet(&fx.state, 4, "after the pages");
        assert!(fx.file.is_dirty(), "fixture: the pages are a document change");
    }

    // ========================================================================
    // BUG-0198: a value whose page name is already taken -- by another value's
    // page (`a/b` and `a_b` both clean to `a_b`) or by a sheet -- got NO page
    // and no error. Owner default 2026-09-28 (asked, not answered): it gets
    // the unique " (2)" name a sheet copy gets, as in Excel; never a skip.
    // ========================================================================

    #[test]
    fn a_value_whose_cleaned_name_collides_with_another_values_page_gets_a_suffixed_page() {
        let fx = fx_with_regions(["a/b", "a_b"]);

        let mut created = show_report_filter_pages_core(&fx.state, &fx.file, &fx.pivots, fx.pivot, 0)
            .expect("the report filter pages");

        created.sort();
        assert_eq!(
            created,
            vec!["a_b".to_string(), "a_b (2)".to_string()],
            "a filter value got no page; sheets {:?}",
            names(&fx.state)
        );
        assert_every_store_has_one_entry_per_sheet(&fx.state, 4, "after the pages");
    }

    #[test]
    fn a_value_named_like_an_existing_sheet_gets_a_suffixed_page() {
        let fx = fx_with_regions(["Sheet1", "West"]);

        let mut created = show_report_filter_pages_core(&fx.state, &fx.file, &fx.pivots, fx.pivot, 0)
            .expect("the report filter pages");

        created.sort();
        assert_eq!(
            created,
            vec!["Sheet1 (2)".to_string(), "West".to_string()],
            "the value named like an existing sheet got no page; sheets {:?}",
            names(&fx.state)
        );
        let grids = fx.state.grids.read().unwrap();
        let page = names(&fx.state).iter().position(|n| n == "Sheet1 (2)").expect("the page");
        assert!(!grids[page].cells.is_empty(), "the suffixed page carries the pivot's cells");
    }
}

/// Wave D, X1 + X2: the BLANK member.
///
/// X1 -- a blank member now names itself in a cell's group path
/// (`pivot_engine::VALUE_ID_BLANK`), so a data-model drill-through of it
/// reaches `build_bi_detail_request`, whose filters can only COMPARE: no
/// operator matches a NULL, and `column = ''` lists only the empty strings.
/// It is refused, by name, instead of listing the wrong rows.
///
/// X2 -- a level-1 selection naming the blank keeps the EMPTY-STRING members
/// too: a model's value list shows ONE "(blank)" for its NULL and "" rows
/// (and the engine's pinned filter keeps both), so the mask that hid "" rows
/// under a selection of "(blank)" hid rows the user had just chosen.
#[cfg(test)]
mod blank_member_tests {
    use super::*;
    use crate::bi::types::{BiState, Connection, ConnectionId, ConnectionType};
    use crate::document_effect::test_seed_effect;
    use crate::pivot::types::{
        ApplyPivotFilterRequest, BiFieldRef, BiPivotMetadata, BiValueFieldRef, MeasureFieldInfo, PivotFilters,
        PivotManualFilter, UpdateBiPivotFieldsRequest,
    };
    use arrow::array::{Float64Array, StringArray};
    use arrow::datatypes::{DataType as ArrowType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use bi_engine::{
        sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector, QueryRequest, SourceBinding,
        StorageMode, Table,
    };
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use tokio::sync::Mutex as TokioMutex;

    fn new_id() -> identity::EntityId {
        identity::EntityId::from_bytes(identity::generate_uuid_v7())
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn meta(connection_id: ConnectionId) -> BiPivotMetadata {
        BiPivotMetadata {
            connection_id,
            data_source_id: None,
            model_tables: vec![],
            measures: vec![MeasureFieldInfo {
                name: "Revenue".to_string(),
                table: "Sales".to_string(),
                source_column: "amount".to_string(),
                aggregation: "sum".to_string(),
            }],
            hierarchies: vec![],
            calculation_groups: vec![],
            data_as_of: None,
            last_query: None,
            lookup_columns: HashSet::new(),
            drill_through: None,
            perspectives: vec![],
            selected_perspective: None,
            cultures: vec![],
        }
    }

    #[test]
    fn a_model_drill_through_of_the_blank_member_is_refused_not_answered_with_empty_strings() {
        let id = new_id();
        let mut cache = PivotCache::new(id, 2);
        cache.set_field_name(0, "Sales.region".to_string());
        cache.set_field_name(1, "Revenue".to_string());
        cache.add_record(0, &[engine::CellValue::Text("East".to_string()), engine::CellValue::Number(10.0)]);
        cache.add_record(1, &[engine::CellValue::Empty, engine::CellValue::Number(30.0)]);
        let mut def = PivotDefinition::new(id, (0, 0), (0, 0));
        def.row_fields.push(PivotField::new(0, "Sales.region".to_string()));
        let meta = meta(new_id());
        let east = cache
            .find_value_id(0, &pivot_engine::CacheValue::Text("East".to_string()))
            .expect("fixture: East is interned");

        let (east_request, _) =
            build_bi_detail_request(&meta, &def, &cache, &[(0, east)], 100, None, false).expect("East drills");
        assert_eq!(east_request.filters.len(), 1, "fixture: one pinned dimension");
        assert_eq!(east_request.filters[0].column, "region");
        assert_eq!(east_request.filters[0].value, "East");

        let blank = build_bi_detail_request(&meta, &def, &cache, &[(0, pivot_engine::VALUE_ID_BLANK)], 100, None, false);
        let err = blank.expect_err("a (blank) member drill must be refused: `region = ''` is not its rows");
        assert!(err.contains("(blank)"), "the refusal names the blank member: {err}");
    }

    /// East, NULL, "", West in one cache column (a model pivot's cache: the
    /// model lists the NULL and the "" rows as ONE "(blank)").
    fn east_null_empty_west() -> PivotCache {
        let batch = RecordBatch::try_new(
            Arc::new(Schema::new(vec![Field::new("region", ArrowType::Utf8, true)])),
            vec![Arc::new(StringArray::from(vec![Some("East"), None, Some(""), Some("West")]))],
        )
        .unwrap();
        crate::pivot::operations::build_cache_from_arrow_batches(new_id(), &[batch]).unwrap()
    }

    fn hidden(selected: &[&str]) -> Vec<String> {
        let mut cache = east_null_empty_west();
        let mut h = hidden_for_selection(&mut cache, 0, &strings(selected), true);
        h.sort();
        h
    }

    #[test]
    fn a_level1_selection_naming_the_blank_keeps_the_empty_string_rows_too() {
        assert_eq!(hidden(&["East", "(blank)"]), strings(&["West"]), "East + (blank)");
        assert_eq!(hidden(&["East", "(Blank)"]), strings(&["West"]), "the label ignores case");
        assert_eq!(hidden(&["East", ""]), strings(&["West"]), "a model's NULL spelled as the empty string");
        // Not naming the blank still hides BOTH spellings of it.
        assert_eq!(hidden(&["East"]), strings(&["", "(blank)", "West"]), "East alone");
    }

    /// A pivot's OWN list shows "(blank)" (the NULL records) and "" (the
    /// empty strings) as two items: each is kept exactly when it is checked.
    /// Folding "" into "(blank)" there would ignore an unchecked "" item.
    #[test]
    fn a_pivots_own_list_keeps_blank_and_empty_string_apart() {
        let own = |selected: &[&str]| {
            let mut cache = east_null_empty_west();
            let mut h = hidden_for_selection_listed(&mut cache, 0, &strings(selected), BlankListing::Separate);
            h.sort();
            h
        };
        assert_eq!(own(&["East", "(blank)"]), strings(&["", "West"]), "(blank) checked, \"\" unchecked");
        assert_eq!(own(&["East", ""]), strings(&["(blank)", "West"]), "\"\" checked, (blank) unchecked");
        assert_eq!(own(&["East", "", "(blank)"]), strings(&["West"]), "both checked");
        // A list that never offered the blank leaves both spellings showing.
        let mut cache = east_null_empty_west();
        let mut h = hidden_for_selection_listed(&mut cache, 0, &strings(&["East"]), BlankListing::NotListed);
        h.sort();
        assert_eq!(h, strings(&["West"]), "not listed");
    }

    /// Which list a level-1 write came from: a write by field index is the
    /// pivot's own dropdown; a model-key write naming no slicer is a ribbon
    /// filter, which lists the MODEL's values.
    #[test]
    fn a_writes_list_is_the_pivots_own_or_the_models() {
        let slicers = crate::slicer::SlicerState::new();
        let request = |bi_field_key: Option<&str>| ApplyPivotFilterRequest {
            pivot_id: new_id(),
            field_index: Some(0),
            bi_field_key: bi_field_key.map(str::to_string),
            filters: PivotFilters::default(),
            filter_level: 1,
            slicer_id: None,
            reconcile: false,
        };
        assert_eq!(selection_list_blank_listing(&slicers, &request(None)), BlankListing::Separate);
        assert_eq!(selection_list_blank_listing(&slicers, &request(Some("Sales.region"))), BlankListing::FoldsEmpty);
    }

    // ---- end to end through `apply_pivot_filter_core` (a model pivot) ----

    fn sales_model() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("region", DataType::String),
                        Column::new("year", DataType::String),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap()
    }

    /// East 10, West 20, NULL 30, "" 50.
    fn sales_with_null_and_empty() -> RecordBatch {
        RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("region", ArrowType::Utf8, true),
                Field::new("year", ArrowType::Utf8, true),
                Field::new("amount", ArrowType::Float64, true),
            ])),
            vec![
                Arc::new(StringArray::from(vec![Some("East"), Some("West"), None, Some("")])),
                Arc::new(StringArray::from(vec!["Y1", "Y1", "Y2", "Y3"])),
                Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 50.0])),
            ],
        )
        .unwrap()
    }

    struct Fx {
        state: crate::AppState,
        file: crate::persistence::FileState,
        files: crate::persistence::UserFilesState,
        slicer: crate::slicer::SlicerState,
        pivots: PivotState,
        pane: crate::pane_control::PaneControlState,
        filters: crate::ribbon_filter::RibbonFilterState,
        bi: BiState,
        conn: ConnectionId,
    }

    impl Fx {
        async fn new(batch: RecordBatch) -> Fx {
            let mut engine = Engine::new(sales_model());
            let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", batch));
            engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
            let _ = engine
                .query_auto_refresh(QueryRequest {
                    measures: vec!["Revenue".into()],
                    group_by: vec![bi_engine::ColumnRef::new("Sales", "region")],
                    ..Default::default()
                })
                .await;
            let conn = new_id();
            let connection = Connection {
                id: conn,
                name: "Sales".into(),
                description: String::new(),
                connection_type: ConnectionType::PostgreSQL,
                connection_string: String::new(),
                server: String::new(),
                database: String::new(),
                preferred_auth: "Integrated".into(),
                model_path: None,
                engine: Some(Arc::new(TokioMutex::new(engine))),
                model_key: None,
                connector_index: Some(idx),
                bindings: vec![],
                last_refreshed: None,
                created_at: String::new(),
                is_connected: true,
                active_queries: HashMap::new(),
                package_data_source_id: None,
                active_role: None,
                base_model: None,
                calculated_measures: vec![],
            };
            let bi = BiState::new();
            bi.connections.lock().unwrap().insert(conn, connection);
            Fx {
                state: crate::create_app_state(),
                file: crate::persistence::FileState::default(),
                files: crate::persistence::UserFilesState::default(),
                slicer: crate::slicer::SlicerState::new(),
                pivots: PivotState::new(),
                pane: crate::pane_control::PaneControlState::new(),
                filters: crate::ribbon_filter::RibbonFilterState::new(),
                bi,
                conn,
            }
        }

        fn ctx(&self) -> PivotCmdCtx<'_> {
            PivotCmdCtx {
                state: &self.state,
                file_state: &self.file,
                pivot_state: &self.pivots,
                pane_control_state: &self.pane,
                ribbon_filter_state: &self.filters,
                user_files_state: &self.files,
                bi_state: &self.bi,
                slicer_state: &self.slicer,
                record_undo: true,
            }
        }

        async fn add_bi_pivot(&self) -> identity::EntityId {
            let id = new_id();
            let sheet_name = self.state.sheet_names.read().unwrap()[0].clone();
            let mut def = PivotDefinition::new(id, (0, 0), (0, 0));
            def.destination_sheet = Some(sheet_name);
            def.name = Some(format!("Pivot{}", id));
            let meta = {
                let engine_arc = self.bi.connections.lock().unwrap()[&self.conn].engine.clone().unwrap();
                let engine = engine_arc.lock().await;
                let (model_tables, measures, hierarchies, calculation_groups, perspectives, cultures) =
                    extract_bi_model_metadata(&engine);
                BiPivotMetadata {
                    connection_id: self.conn,
                    data_source_id: Some(self.conn.to_string()),
                    model_tables,
                    measures,
                    hierarchies,
                    calculation_groups,
                    data_as_of: None,
                    last_query: None,
                    lookup_columns: HashSet::new(),
                    drill_through: None,
                    perspectives,
                    selected_perspective: None,
                    cultures,
                }
            };
            let seed = test_seed_effect();
            self.pivots.pivot_tables.write(&seed).unwrap().insert(id, (def, PivotCache::new(id, 0)));
            self.pivots.bi_metadata.write(&seed).unwrap().insert(id, meta);
            id
        }

        async fn lay_out_region(&self, pivot: identity::EntityId) {
            let request = UpdateBiPivotFieldsRequest {
                pivot_id: pivot,
                row_fields: vec![BiFieldRef {
                    table: "Sales".into(),
                    column: "region".into(),
                    is_lookup: false,
                    hidden_items: None,
                }],
                column_fields: vec![],
                value_fields: vec![BiValueFieldRef { measure_name: "Revenue".into(), custom_name: None }],
                filter_fields: vec![],
                slicer_fields: None,
                row_hierarchies: vec![],
                column_hierarchies: vec![],
                layout: None,
                lookup_columns: vec![],
                calculated_fields: None,
                value_column_order: None,
                force_requery: false,
            };
            update_bi_pivot_fields_core(&self.ctx(), request).await.expect("lay the pivot out");
        }

        async fn select_level1(&self, pivot: identity::EntityId, selected: &[&str]) {
            let request = ApplyPivotFilterRequest {
                pivot_id: pivot,
                field_index: None,
                bi_field_key: Some("Sales.region".to_string()),
                filters: PivotFilters {
                    manual_filter: Some(PivotManualFilter { selected_items: strings(selected) }),
                    ..Default::default()
                },
                filter_level: 1,
                slicer_id: None,
                reconcile: false,
            };
            apply_pivot_filter_core(&self.ctx(), request).await.expect("apply the filter");
        }

        fn hidden_on_region(&self, pivot: identity::EntityId) -> Option<Vec<String>> {
            let tables = self.pivots.pivot_tables.read().unwrap();
            let (def, _) = &tables[&pivot];
            def.row_fields.iter().find(|f| f.name == "Sales.region").map(|f| {
                let mut h = f.hidden_items.clone();
                h.sort();
                h
            })
        }

        /// The rendered grand total.
        fn grand_total(&self, pivot: identity::EntityId) -> Option<f64> {
            let mut tables = self.pivots.pivot_tables.write(&test_seed_effect()).unwrap();
            let (def, cache) = tables.get_mut(&pivot).unwrap();
            let def = def.clone();
            let view = crate::pivot::operations::safe_calculate_pivot(&def, cache);
            view.cells.iter().flatten().find(|c| c.cell_type == pivot_engine::PivotCellType::GrandTotal).and_then(
                |c| match c.value {
                    pivot_engine::PivotCellValue::Number(n) => Some(n),
                    _ => None,
                },
            )
        }
    }

    #[tokio::test]
    async fn a_level1_selection_of_east_and_blank_on_a_model_pivot_hides_only_west() {
        let fx = Fx::new(sales_with_null_and_empty()).await;
        let values = crate::bi::commands::bi_get_column_values_core(&fx.bi, fx.conn, "Sales", "region").await.unwrap();
        assert_eq!(values, strings(&["East", "West", "(blank)"]), "fixture: the model list offers ONE (blank)");
        let pivot = fx.add_bi_pivot().await;
        fx.lay_out_region(pivot).await;
        assert_eq!(fx.grand_total(pivot), Some(110.0), "fixture: every row");

        fx.select_level1(pivot, &["East", "(blank)"]).await;
        assert_eq!(fx.hidden_on_region(pivot), Some(strings(&["West"])), "only West is hidden");
        assert_eq!(fx.grand_total(pivot), Some(90.0), "East 10 + NULL 30 + empty 50");
    }

    // ---- the header dropdown's round trip (wave D fix-up) ----

    /// A grid pivot whose Region carries `hidden`, stored under a new id.
    fn own_list_pivot(pivots: &PivotState, hidden: Vec<String>) -> identity::EntityId {
        let id = new_id();
        let mut def = PivotDefinition::new(id, (0, 0), (0, 0));
        let mut region = PivotField::new(0, "region".to_string());
        region.hidden_items = hidden;
        def.row_fields.push(region);
        pivots.pivot_tables.write(&test_seed_effect()).unwrap().insert(id, (def, east_null_empty_west()));
        id
    }

    /// What the header dropdown shows checked when it reopens (its CHECKED
    /// set is `get_pivot_field_info`'s manual filter), each item with its
    /// checkbox, and what OK-unchanged then hides.
    fn reopen_and_ok(pivots: &PivotState, id: identity::EntityId) -> (Vec<(String, bool)>, Vec<String>) {
        let info = pivot_field_info_core(pivots, id, 0).unwrap();
        let items = info.items.iter().map(|i| (i.name.clone(), i.visible)).collect();
        let checked = info.filters.manual_filter.map(|m| m.selected_items).unwrap_or_default();
        let mut rehidden =
            hidden_for_selection_listed(&mut east_null_empty_west(), 0, &checked, BlankListing::Separate);
        rehidden.sort();
        (items, rehidden)
    }

    /// The (blank) item follows its OWN checkbox on the read side too: the
    /// write keeps "" and (blank) apart ([`BlankListing::Separate`]) and the
    /// engine hides only the `""` rows by `""`, but the read still counted
    /// `""` as a spelling of (blank) -- so after unchecking only "", the
    /// reopened dropdown showed (blank) UNCHECKED over rows that were
    /// showing, and OK-unchanged hid them.
    #[test]
    fn the_reopened_header_dropdown_keeps_blank_checked_after_unchecking_only_the_empty_string() {
        let hidden = hidden_for_selection_listed(
            &mut east_null_empty_west(),
            0,
            &strings(&["East", "West", "(blank)"]),
            BlankListing::Separate,
        );
        assert_eq!(hidden, strings(&[""]), "fixture: unchecking only \"\" hides only \"\"");
        let pivots = PivotState::new();
        let id = own_list_pivot(&pivots, hidden);

        // The engine shows the (blank) row and hides only the "" row.
        let labels: Vec<String> = {
            let mut tables = pivots.pivot_tables.write(&test_seed_effect()).unwrap();
            let (def, cache) = tables.get_mut(&id).unwrap();
            let def = def.clone();
            let view = crate::pivot::operations::safe_calculate_pivot(&def, cache);
            view.rows
                .iter()
                .zip(view.cells.iter())
                .filter(|(d, _)| d.row_type == pivot_engine::PivotRowType::Data)
                .map(|(_, c)| c[0].formatted_value.clone())
                .collect()
        };
        assert_eq!(labels, strings(&["(blank)", "East", "West"]), "fixture: the engine keeps the (blank) row");

        let (items, rehidden) = reopen_and_ok(&pivots, id);
        assert_eq!(
            items,
            vec![
                (String::new(), false),
                ("East".to_string(), true),
                ("West".to_string(), true),
                ("(blank)".to_string(), true),
            ],
            "the dropdown reads each item as the engine shows it",
        );
        assert_eq!(rehidden, strings(&[""]), "reopen + OK unchanged hides nothing new");
    }

    /// The mirror: unchecking only (blank) reads back with "" checked.
    #[test]
    fn the_reopened_header_dropdown_keeps_the_empty_string_checked_after_unchecking_only_blank() {
        let pivots = PivotState::new();
        let id = own_list_pivot(&pivots, strings(&["(blank)"]));
        let (items, rehidden) = reopen_and_ok(&pivots, id);
        assert_eq!(items[0], (String::new(), true), "\"\" stays checked: {items:?}");
        assert_eq!(items[3], ("(blank)".to_string(), false), "(blank) reads unchecked: {items:?}");
        assert_eq!(rehidden, strings(&["(blank)"]), "reopen + OK unchanged");
        // Any spelling of the label hides it, as the engine reads it.
        let id = own_list_pivot(&pivots, strings(&["(Blank)"]));
        assert_eq!(reopen_and_ok(&pivots, id).0[3], ("(blank)".to_string(), false));
    }

    // ---- a PIVOT slicer's list (wave D fix-up) ----

    /// A PIVOT slicer on Region of a grid pivot over East 10, West 20,
    /// NULL 30, "" 50 (cache fields region, year, amount; Sum of amount).
    async fn pivot_slicer_fixture(fx: &Fx, batch: RecordBatch) -> (identity::EntityId, identity::EntityId, Vec<String>) {
        let id = new_id();
        let cache = crate::pivot::operations::build_cache_from_arrow_batches(id, &[batch]).unwrap();
        let sheet_name = fx.state.sheet_names.read().unwrap()[0].clone();
        let mut def = PivotDefinition::new(id, (0, 0), (0, 0));
        def.destination_sheet = Some(sheet_name);
        def.name = Some(format!("Pivot{}", id));
        def.row_fields.push(PivotField::new(0, "region".to_string()));
        def.value_fields
            .push(pivot_engine::ValueField::new(2, "Sum of amount".to_string(), pivot_engine::AggregationType::Sum));
        fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap().insert(id, (def, cache));
        let slicer = crate::slicer::commands::create_slicer_core(
            &fx.state,
            &fx.file,
            &fx.slicer,
            &fx.bi,
            crate::slicer::types::CreateSlicerParams {
                name: "Region".to_string(),
                sheet_index: 0,
                x: 0.0,
                y: 0.0,
                width: None,
                height: None,
                source_type: crate::slicer::types::SlicerSourceType::Pivot,
                cache_source_id: id,
                field_name: "region".to_string(),
                connected_sources: vec![crate::slicer::types::SlicerConnection {
                    source_type: crate::slicer::types::SlicerSourceType::Pivot,
                    source_id: id,
                }],
                columns: None,
                style_preset: None,
                filter_level: None,
            },
        )
        .expect("create the pivot slicer");
        let items = crate::slicer::commands::get_slicer_items_core(&fx.state, &fx.pivots, &fx.slicer, &fx.filters, &fx.bi, slicer.id)
            .await
            .expect("list the slicer")
            .into_iter()
            .map(|i| i.value)
            .collect();
        (id, slicer.id, items)
    }

    /// What a range pivot's slicer sends (`slicerFilterBridge.pivotSourceWrite`).
    fn slicer_write(pivot: identity::EntityId, slicer: identity::EntityId, selected: &[&str]) -> ApplyPivotFilterRequest {
        ApplyPivotFilterRequest {
            pivot_id: pivot,
            field_index: Some(0),
            bi_field_key: None,
            filters: PivotFilters {
                manual_filter: Some(PivotManualFilter { selected_items: strings(selected) }),
                ..Default::default()
            },
            filter_level: 1,
            slicer_id: Some(slicer.to_string()),
            reconcile: false,
        }
    }

    fn own_hidden(fx: &Fx, pivot: identity::EntityId) -> Vec<String> {
        let tables = fx.pivots.pivot_tables.read().unwrap();
        let mut h = tables[&pivot].0.row_fields[0].hidden_items.clone();
        h.sort();
        h
    }

    /// A pivot slicer lists ONE (blank) and never a "" item, so "" belongs
    /// to its (blank): the write was classed as the pivot's OWN list ("" an
    /// item of its own), and East + (blank) -- every blank the slicer offers
    /// -- hid the "" rows, with no slicer item that could bring them back.
    #[tokio::test]
    async fn a_pivot_slicer_selection_naming_blank_keeps_the_empty_string_rows() {
        let fx = Fx::new(sales_with_null_and_empty()).await;
        let (pivot, slicer, items) = pivot_slicer_fixture(&fx, sales_with_null_and_empty()).await;
        assert_eq!(items, strings(&["East", "West", "(blank)"]), "fixture: ONE (blank), no \"\" item");
        assert_eq!(fx.grand_total(pivot), Some(110.0), "fixture: every row");

        apply_pivot_filter_core(&fx.ctx(), slicer_write(pivot, slicer, &["East", "(blank)"])).await.expect("apply");
        assert_eq!(own_hidden(&fx, pivot), strings(&["West"]), "East + (blank) hides only West");
        assert_eq!(fx.grand_total(pivot), Some(90.0), "East 10 + NULL 30 + empty 50");

        apply_pivot_filter_core(&fx.ctx(), slicer_write(pivot, slicer, &["East"])).await.expect("apply");
        assert_eq!(own_hidden(&fx, pivot), strings(&["", "(blank)", "West"]), "East alone hides both blanks");
        assert_eq!(fx.grand_total(pivot), Some(10.0));
    }

    /// With NO null records the pivot slicer offers no (blank) at all: the
    /// selection cannot say whether the "" rows should show, so they are
    /// left showing -- "select every item" must not drop them.
    #[tokio::test]
    async fn a_pivot_slicer_that_offers_no_blank_leaves_the_empty_string_rows_showing() {
        let fx = Fx::new(sales_with_null_and_empty()).await;
        let batch = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("region", ArrowType::Utf8, true),
                Field::new("year", ArrowType::Utf8, true),
                Field::new("amount", ArrowType::Float64, true),
            ])),
            vec![
                Arc::new(StringArray::from(vec![Some("East"), Some("West"), Some("")])),
                Arc::new(StringArray::from(vec!["Y1", "Y1", "Y3"])),
                Arc::new(Float64Array::from(vec![10.0, 20.0, 50.0])),
            ],
        )
        .unwrap();
        let (pivot, slicer, items) = pivot_slicer_fixture(&fx, batch).await;
        assert_eq!(items, strings(&["East", "West"]), "fixture: no blank item offered");

        apply_pivot_filter_core(&fx.ctx(), slicer_write(pivot, slicer, &["East", "West"])).await.expect("apply");
        assert_eq!(own_hidden(&fx, pivot), Vec::<String>::new(), "every listed item selected hides nothing");
        assert_eq!(fx.grand_total(pivot), Some(80.0));
    }

    /// Which list a write NAMING A SLICER came from is the slicer's, whatever
    /// key the write uses: a pivot slicer's ([`BlankListing::PivotSlicer`])
    /// or a model slicer's (the model's list). A slicer id that names no
    /// slicer falls back to the key.
    #[test]
    fn a_write_naming_a_slicer_takes_that_slicers_list() {
        use crate::slicer::types::{Slicer, SlicerSourceType};
        let slicers = crate::slicer::SlicerState::new();
        let file = crate::persistence::FileState::default();
        let state = crate::create_app_state();
        let bi = BiState::new();
        let pivot = new_id();
        let pivot_slicer = crate::slicer::commands::create_slicer_core(
            &state,
            &file,
            &slicers,
            &bi,
            crate::slicer::types::CreateSlicerParams {
                name: "Region".to_string(),
                sheet_index: 0,
                x: 0.0,
                y: 0.0,
                width: None,
                height: None,
                source_type: SlicerSourceType::Pivot,
                cache_source_id: pivot,
                field_name: "region".to_string(),
                connected_sources: vec![],
                columns: None,
                style_preset: None,
                filter_level: None,
            },
        )
        .expect("a pivot slicer");
        let model_slicer: Slicer = Slicer { id: new_id(), source_type: SlicerSourceType::BiConnection, ..pivot_slicer.clone() };
        slicers.slicers.write(&test_seed_effect()).unwrap().insert(model_slicer.id, model_slicer.clone());

        let request = |slicer: Option<identity::EntityId>, bi_field_key: Option<&str>| ApplyPivotFilterRequest {
            pivot_id: pivot,
            field_index: Some(0),
            bi_field_key: bi_field_key.map(str::to_string),
            filters: PivotFilters::default(),
            filter_level: 1,
            slicer_id: slicer.map(|s| s.to_string()),
            reconcile: false,
        };
        let listing = |slicer, key| selection_list_blank_listing(&slicers, &request(slicer, key));
        assert_eq!(listing(Some(pivot_slicer.id), None), BlankListing::PivotSlicer, "range pivot's slicer");
        assert_eq!(listing(Some(pivot_slicer.id), Some("Sales.region")), BlankListing::PivotSlicer, "BI pivot's slicer");
        assert_eq!(listing(Some(model_slicer.id), None), BlankListing::FoldsEmpty, "model slicer on a range pivot");
        assert_eq!(listing(Some(model_slicer.id), Some("Sales.region")), BlankListing::FoldsEmpty);
        assert_eq!(listing(Some(new_id()), None), BlankListing::Separate, "an unknown slicer: the key decides");
        assert_eq!(listing(Some(new_id()), Some("Sales.region")), BlankListing::FoldsEmpty);
    }
}
