//! FILENAME: app/src-tauri/src/slicer/commands.rs
//! PURPOSE: Tauri commands for slicer CRUD and item retrieval.
//! CONTEXT: Manages slicer state and bridges to table/pivot data sources.

use crate::pivot::PivotState;
use crate::pivot::commands::PivotCmdCtx;
use crate::slicer::types::*;
use crate::{format_cell_value, AppState};
use std::collections::HashMap;
use tauri::State;

use crate::log_debug;

// ============================================================================
// CRUD COMMANDS
// ============================================================================

/// Create a new slicer.
///
/// A MODEL slicer (`sourceType: "biConnection"`) is validated like a ribbon
/// filter before anything is written: the connection must exist, and a
/// package connection's stable data-source id is stamped so the slicer
/// re-binds after reload / re-pull. Its Report Connections are always its own
/// connection (page scope) whatever the caller sent.
#[tauri::command]
pub fn create_slicer(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    params: CreateSlicerParams,
) -> Result<Slicer, String> {
    create_slicer_core(&state, &file_state, &slicer_state, &bi_state, params)
}

/// [`create_slicer`] over plain references, for the unit tier.
pub(crate) fn create_slicer_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    slicer_state: &SlicerState,
    bi_state: &crate::bi::types::BiState,
    params: CreateSlicerParams,
) -> Result<Slicer, String> {
    // Every refusal before the effect: a refused create leaves the document
    // clean. The connections lock is released before the slicer store is
    // written (the ribbon-filter recipe).
    let data_source_id = if params.source_type == SlicerSourceType::BiConnection {
        let connections = bi_state.connections.lock().map_err(|e| e.to_string())?;
        match connections.get(&params.cache_source_id) {
            Some(conn) => conn.package_data_source_id.clone(),
            None => {
                return Err(format!(
                    "Calcula model connection {} not found — a model slicer must be sourced from a loaded model connection",
                    params.cache_source_id
                ));
            }
        }
    } else {
        None
    };
    let filter_level = match params.filter_level {
        Some(level) => {
            crate::slicer::types::validate_filter_level(level)?;
            level
        }
        None => crate::slicer::types::default_filter_level(),
    };
    let connected_sources = if params.source_type == SlicerSourceType::BiConnection {
        Slicer::model_slicer_connections(params.cache_source_id)
    } else {
        params.connected_sources
    };

    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    let slicer = Slicer {
        id,
        name: params.name,
        header_text: None,
        sheet_index: params.sheet_index,
        x: params.x,
        y: params.y,
        width: params.width.unwrap_or(180.0),
        height: params.height.unwrap_or(240.0),
        source_type: params.source_type,
        cache_source_id: params.cache_source_id,
        field_name: params.field_name,
        selected_items: None, // All selected by default
        show_header: true,
        columns: params.columns.unwrap_or(1),
        style_preset: params.style_preset.unwrap_or_else(|| "SlicerStyleLight1".to_string()),
        selection_mode: SlicerSelectionMode::default(),
        hide_no_data: false,
        indicate_no_data: true,
        sort_no_data_last: true,
        force_selection: false,
        show_select_all: false,
        arrangement: SlicerArrangement::default(),
        rows: 0,
        item_gap: 4.0,
        autogrid: true,
        item_padding: 0.0,
        button_radius: 2.0,
        connected_sources,
        filter_level,
        data_source_id,
    };

    log_debug!(
        "SLICER",
        "create_slicer id={} name={} source={:?} connected={:?}",
        id,
        slicer.name,
        slicer.source_type,
        slicer.connected_sources
    );

    let result = slicer.clone();
    // Slicers are persisted (`workbook.slicers`); creating one is a document change.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    slicer_state.slicers.write(&effect).unwrap().insert(id, slicer);

    // Record undo for slicer creation (undo = delete the slicer). A MEMBER of
    // an open transaction, so an insert that also places the slicer (or a
    // canvas insert flow) stays one Ctrl+Z; on its own it is its own step.
    {
        #[derive(serde::Serialize)]
        struct SlicerCreateSnapshot { slicer_id: identity::EntityId }
        let data = serde_json::to_vec(&SlicerCreateSnapshot { slicer_id: id }).unwrap_or_default();
        crate::undo_commands::record_restores_joining_open_transaction(
            state,
            "Create slicer",
            vec![("slicer_create", data)],
        );
    }

    Ok(result)
}

/// Delete a slicer.
///
/// §3bn: a slicer is not only a dependent, it is also something depended ON.
/// Ribbon filters name canvas slicers in `crossFilterSlicerTargets`, and a
/// deleted slicer used to stay in those lists forever — every item fetch went
/// on re-evaluating cross-filter candidacy against an id that resolved to
/// nothing. The prune is [`crate::object_deps::cascade_deleted_slicers`], and
/// its restores go into the same transaction as the slicer's own.
///
/// OWNER DECISION 3 (2026-09-27): deleting ANY slicer -- model, pivot or
/// table -- removes its filter from what it filtered (the pivots, or the
/// table's AutoFilter column), and ONE Ctrl+Z brings back the slicer AND the
/// filter. The clear happens here, on the server, where the
/// slicer's sheet is still the sheet it lives on; a frontend reconcile that
/// cleared "the pivots on the slicer's cached sheet index" after the fact
/// would hit the wrong page once a sheet delete had shifted the indices.
#[tauri::command]
pub async fn delete_slicer(
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<'_, SlicerState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_id: identity::EntityId,
) -> Result<(), String> {
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
    delete_slicer_core(&ctx, slicer_id).await
}

/// One pivot whose filter a slicer set, and how to name the field on it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SlicerFilterTarget {
    pub pivot_id: identity::EntityId,
    pub field_index: usize,
    /// The model column key, for a BI pivot (so a pin matches by column).
    pub bi_field_key: Option<String>,
}

/// The pivots a slicer's filter currently sits on, resolved against the live
/// stores: a MODEL slicer's page (every BI pivot of its connection on its
/// sheet), a PIVOT slicer's Report Connections, plus any pivot carrying a pin
/// this slicer set. A slicer with no selection and no pin filtered nothing, so
/// it has no targets -- its delete must not wipe a filter someone else set on
/// the same column. Table slicers filter tables, not pivots: none here (their
/// AutoFilter columns are [`table_slicer_filter_targets`]).
pub(crate) fn slicer_filter_targets(
    state: &AppState,
    pivot_state: &PivotState,
    slicer: &Slicer,
) -> Vec<SlicerFilterTarget> {
    let slicer_key = slicer.id.to_string();
    // Candidate pivots, resolved BEFORE the stores are read below (the helper
    // takes the same locks).
    let mut candidates: Vec<identity::EntityId> = match slicer.source_type {
        SlicerSourceType::BiConnection => {
            crate::pivot::commands::bi_pivots_for_connection(state, pivot_state, slicer.cache_source_id)
                .into_iter()
                .filter(|p| p.sheet_index == slicer.sheet_index)
                .map(|p| p.id)
                .collect()
        }
        SlicerSourceType::Pivot => slicer
            .connected_sources
            .iter()
            .filter(|c| c.source_type == SlicerSourceType::Pivot)
            .map(|c| c.source_id)
            .collect(),
        SlicerSourceType::Table => Vec::new(),
    };

    // CANONICAL LOCK ORDER: pivot_tables before bi_metadata.
    let Ok(pivot_tables) = pivot_state.pivot_tables.read() else { return Vec::new() };
    let Ok(bi_meta) = pivot_state.bi_metadata.read() else { return Vec::new() };
    for (pivot_id, (definition, _)) in pivot_tables.iter() {
        if definition.engine_filters.iter().any(|ef| ef.slicer_id.as_deref() == Some(slicer_key.as_str()))
            && !candidates.contains(pivot_id)
        {
            candidates.push(*pivot_id);
        }
    }
    candidates.sort();
    candidates.dedup();

    let mut out = Vec::new();
    for pivot_id in candidates {
        let Some((definition, cache)) = pivot_tables.get(&pivot_id) else { continue };
        let own_pin = definition
            .engine_filters
            .iter()
            .find(|ef| ef.slicer_id.as_deref() == Some(slicer_key.as_str()));
        if slicer.selected_items.is_none() && own_pin.is_none() {
            continue;
        }
        let meta = bi_meta.get(&pivot_id);
        let resolved: Option<(usize, Option<String>)> = match meta {
            Some(meta) => {
                let by_key = crate::pivot::commands::split_model_column_key(&slicer.field_name, meta)
                    .ok()
                    .or_else(|| own_pin.map(|ef| (ef.table.clone(), ef.column.clone())));
                by_key.and_then(|(table, column)| {
                    crate::pivot::commands::resolve_bi_field_index(definition, cache, meta, &table, &column)
                        .map(|idx| (idx, Some(format!("{table}.{column}"))))
                })
            }
            None => cache
                .fields
                .iter()
                .position(|f| field_name_matches(&f.name, &slicer.field_name))
                .map(|idx| (idx, None)),
        };
        if let Some((field_index, bi_field_key)) = resolved {
            out.push(SlicerFilterTarget { pivot_id, field_index, bi_field_key });
        }
    }
    out
}

/// One AutoFilter column a TABLE slicer's selection set: the table's sheet,
/// the filter that table owns, and the column index relative to that filter.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TableSlicerFilterTarget {
    pub sheet: usize,
    pub filter_id: identity::EntityId,
    pub column_index: u32,
}

/// The AutoFilter columns a TABLE slicer filters right now -- the same mapping
/// the slicer's click makes (`table_click_targets`): the table's column
/// named like the slicer's field, translated into the sheet's ONE AutoFilter,
/// which must be the one this table owns. A slicer with no selection filtered
/// nothing, and a column that carries no criteria has nothing to clear, so
/// neither is a target: deleting an idle slicer must not wipe a filter the
/// user set from the table's own dropdown.
///
/// LOCKS: `tables` then `auto_filters` (the order `create_table` uses), both
/// released on return.
pub(crate) fn table_slicer_filter_targets(state: &AppState, slicer: &Slicer) -> Vec<TableSlicerFilterTarget> {
    if slicer.source_type != SlicerSourceType::Table || slicer.selected_items.is_none() {
        return Vec::new();
    }
    let mut table_ids: Vec<identity::EntityId> = slicer
        .connected_sources
        .iter()
        .filter(|c| c.source_type == SlicerSourceType::Table)
        .map(|c| c.source_id)
        .collect();
    if table_ids.is_empty() {
        table_ids.push(slicer.cache_source_id);
    }
    table_ids.sort();
    table_ids.dedup();

    let Ok(tables) = state.tables.read() else { return Vec::new() };
    let Ok(auto_filters) = state.auto_filters.read() else { return Vec::new() };
    let mut out = Vec::new();
    for table_id in table_ids {
        let Some((sheet, table)) = tables
            .iter()
            .find_map(|(sheet, by_id)| by_id.get(&table_id).map(|t| (*sheet, t)))
        else {
            continue;
        };
        let Some(offset) = table.columns.iter().position(|c| c.name == slicer.field_name) else { continue };
        let Some(af) = auto_filters.get(&sheet) else { continue };
        if table.auto_filter_id != Some(af.id) {
            continue; // the sheet's filter belongs to another table
        }
        let abs_col = table.start_col + offset as u32;
        if abs_col < af.start_col || abs_col > af.end_col {
            continue;
        }
        let column_index = abs_col - af.start_col;
        if af.column_filters.contains_key(&column_index) {
            out.push(TableSlicerFilterTarget { sheet, filter_id: af.id, column_index });
        }
    }
    out
}

/// [`delete_slicer`] over borrowed state.
///
/// THE UNDO STEP IS RECORDED ONCE, AT THE END. The pivot clears may re-query
/// the BI engine (a pinned filter lives inside the query), which can take
/// seconds; the undo stack is ONE global slot and Tauri dispatches commands on
/// a thread pool, so a transaction held open across that await swallowed a
/// concurrent cell edit into "Delete slicer", or had a concurrent paste COMMIT
/// it half-built -- after which one Ctrl+Z brought the slicer back over
/// unfiltered pivots. Instead the pre-delete state is snapshotted in memory,
/// the clears run with their own undo recording switched off, and every
/// restore -- pivots, the table's AutoFilter, the ribbon-filter cross-links,
/// the slicer -- goes onto the stack in ONE critical section that joins a
/// caller's open transaction (a multi-delete) or is a step of its own.
pub(crate) async fn delete_slicer_core(
    ctx: &PivotCmdCtx<'_>,
    slicer_id: identity::EntityId,
) -> Result<(), String> {
    log_debug!("SLICER", "delete_slicer id={}", slicer_id);

    // Refusal first: an unknown id leaves the document clean and the undo
    // stack untouched.
    let slicer = ctx
        .slicer_state
        .slicers
        .read()
        .map_err(|e| e.to_string())?
        .get(&slicer_id)
        .cloned()
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;
    // A sheet protected against object edits refuses the delete, as it
    // refuses the move (`update_slicer_position_core`) and a chart's delete: a
    // canvas-wide Delete of a mixed selection relies on each family refusing
    // what the sheet forbids (the review of A4). Before anything is written.
    crate::protection::check_sheet_action(ctx.state, slicer.sheet_index, "editObjects", "delete a slicer")?;
    // In flight until its one step is recorded (the clears can await model
    // re-queries): an undo or redo asked for meanwhile is refused.
    let _in_flight = crate::undo_commands::PendingGesture::begin(ctx.state);
    let targets = slicer_filter_targets(ctx.state, ctx.pivot_state, &slicer);
    // OWNER DECISION 3 covers TABLE slicers too: the AutoFilter column its
    // selection set is cleared in this same step.
    let table_targets = table_slicer_filter_targets(ctx.state, &slicer);

    // 1. Every target pivot's pre-clear definition AND records, in memory.
    //    Replayed LAST on undo, so it supersedes whatever the clears did.
    //    Encoded after the clears (step 3b), because each restore must also
    //    carry the user's cells its clear grew the pivot over.
    let mut pre_clear: Vec<(identity::EntityId, pivot_engine::PivotDefinition, pivot_engine::PivotCache, usize)> =
        Vec::new();
    for target in &targets {
        let snapshot = {
            let pivot_tables = ctx.pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
            pivot_tables.get(&target.pivot_id).map(|(def, cache)| (def.clone(), cache.clone()))
        };
        let Some((definition, cache)) = snapshot else { continue };
        // Resolved with the pivot lock RELEASED: `delete_sheet` takes
        // sheet_names before pivot_tables, so reading names under it is the
        // reverse order.
        let dest_sheet = crate::pivot::operations::resolve_dest_sheet_index(ctx.state, &definition);
        pre_clear.push((target.pivot_id, definition, cache, dest_sheet));
    }

    // 2. The slicer itself -- BEFORE the clears: a pinned clear re-queries,
    //    and the re-query folds in the page's model slicers, which would put
    //    this slicer's pin straight back if it were still in the store.
    let effect = crate::document_effect::DocumentEffect::mutates(ctx.file_state);
    let removed = ctx.slicer_state.slicers.write(&effect).unwrap().remove(&slicer_id);

    // 3. Take the slicer's filter off every pivot it sat on, recording
    //    nothing (the snapshot above is this gesture's undo). A clear that
    //    fails is logged and the delete goes on: the user asked for the
    //    slicer to go.
    let quiet = PivotCmdCtx { record_undo: false, ..*ctx };
    let mut overwritten: std::collections::HashMap<identity::EntityId, Vec<crate::pivot::operations::SavedCell>> =
        std::collections::HashMap::new();
    for target in &targets {
        let request = crate::pivot::types::ClearPivotFilterRequest {
            pivot_id: target.pivot_id,
            field_index: Some(target.field_index),
            bi_field_key: target.bi_field_key.clone(),
            filter_type: None,
            reconcile: false,
        };
        match crate::pivot::commands::clear_pivot_filter_core_keeping(&quiet, request).await {
            Ok((_, kept)) => overwritten.entry(target.pivot_id).or_default().extend(kept.overwritten),
            Err(e) => crate::log_warn!(
                "SLICER",
                "delete_slicer {}: could not clear its filter on pivot {}: {}",
                slicer_id,
                target.pivot_id,
                e
            ),
        }
    }

    // The pivot restores (step 1), each carrying the cells its clear grew
    // over -- a worksheet pivot that grew when its filter came off wrote over
    // the user's cells, and undoing the delete must put them back.
    let mut restores: Vec<(&'static str, Vec<u8>)> = Vec::new();
    for (pivot_id, definition, cache, dest_sheet) in pre_clear {
        restores.push((
            crate::undo_commands::PIVOT_DEFINITION_RESTORE_KIND,
            crate::undo_commands::encode_pivot_definition_snapshot(
                pivot_id,
                definition,
                overwritten.remove(&pivot_id).unwrap_or_default(),
                dest_sheet,
                Some(cache),
            ),
        ));
    }

    // 3b. A table slicer's AutoFilter column (synchronous; no lock is held).
    let mut table_filter_cleared = false;
    for target in &table_targets {
        if let Some(previous) = crate::autofilter::clear_column_criteria_on_sheet(
            ctx.state,
            &effect,
            target.sheet,
            target.filter_id,
            target.column_index,
        ) {
            restores.push(crate::undo_commands::encode_autofilter_restore(target.sheet, Some(previous)));
            table_filter_cleared = true;
        }
    }

    if let Some(removed) = removed {
        // Filters that cross-filtered this slicer, pruned before the undo
        // lock is taken (it takes the filter lock; the undo lock is never
        // held across one).
        let pruned_filters = crate::object_deps::cascade_deleted_slicers(
            ctx.ribbon_filter_state,
            &effect,
            &[slicer_id],
        );
        restores.extend(crate::object_deps::encode_filter_prune_restores(&pruned_filters));

        // LAST in the batch, so the reverse replay restores the SLICER first,
        // then the filters that point at it, then the AutoFilter and pivots.
        #[derive(serde::Serialize)]
        struct SlicerSnapshot {
            slicer_id: identity::EntityId,
            previous: Slicer,
        }
        let data = serde_json::to_vec(&SlicerSnapshot { slicer_id, previous: removed }).unwrap_or_default();
        restores.push(("slicer_delete", data));

        // Computed properties belong to the slicer outright — one helper,
        // shared with the cascade, so "remove a slicer" means the same thing
        // on both paths.
        crate::object_deps::drop_slicer_computed_properties(ctx.slicer_state, &effect, slicer_id);

        // C10: a deleted slicer must not leave its object script mounted/persisted.
        crate::scripting::object_script_commands::prune_scripts_for_instance(
            ctx.state,
            &effect,
            &slicer_id.to_string(),
        );
    }
    // (`removed` is None only when the slicer was deleted concurrently since
    // the refusal check: the pivot and AutoFilter restores are still ONE step.)

    // ONE critical section on the undo stack for the whole gesture.
    crate::undo_commands::record_restores_joining_open_transaction(ctx.state, "Delete slicer", restores);

    // Un-hidden table rows change what SUBTOTAL/AGGREGATE-style formulas see.
    if table_filter_cleared {
        if let Err(e) = crate::calculation::recalc_visibility_dependents_core(
            ctx.state,
            ctx.user_files_state,
            ctx.pivot_state,
            Some((ctx.pane_control_state, ctx.ribbon_filter_state)),
        ) {
            crate::log_warn!("SLICER", "visibility recalc after deleting slicer {} failed: {}", slicer_id, e);
        }
    }

    Ok(())
}

/// The pivot filters a slicer that is about to be removed WITH ITS SHEET holds
/// on pivots that survive the delete.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DoomedSlicerFilters {
    pub slicer_id: identity::EntityId,
    pub targets: Vec<SlicerFilterTarget>,
}

/// Owner decision 3 on the sheet-delete path, part 1: the targets of every
/// slicer on sheet `sheet`, resolved BEFORE the sheet goes -- while the
/// indices still name the sheets they named when the user clicked (a model
/// slicer's page is "its sheet index", which the delete renumbers) and before
/// the slicers are dropped from the store. Pivots whose destination IS the
/// doomed sheet die with it and are left out.
///
/// LOCKS: each store alone, in turn; the caller holds none.
pub(crate) fn filter_targets_of_slicers_on_sheet(
    state: &AppState,
    pivot_state: &PivotState,
    slicer_state: &SlicerState,
    sheet: usize,
) -> Vec<DoomedSlicerFilters> {
    let on_sheet: Vec<Slicer> = match slicer_state.slicers.read() {
        Ok(slicers) => slicers.values().filter(|s| s.sheet_index == sheet).cloned().collect(),
        Err(_) => return Vec::new(),
    };
    if on_sheet.is_empty() {
        return Vec::new();
    }
    let doomed_name: Option<String> = state.sheet_names.read().ok().and_then(|n| n.get(sheet).cloned());
    let dying: std::collections::HashSet<identity::EntityId> = match pivot_state.pivot_tables.read() {
        Ok(pivots) => pivots
            .iter()
            .filter(|(_, (def, _))| doomed_name.is_some() && def.destination_sheet == doomed_name)
            .map(|(id, _)| *id)
            .collect(),
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<DoomedSlicerFilters> = on_sheet
        .iter()
        .map(|slicer| DoomedSlicerFilters {
            slicer_id: slicer.id,
            targets: slicer_filter_targets(state, pivot_state, slicer)
                .into_iter()
                .filter(|t| !dying.contains(&t.pivot_id))
                .collect(),
        })
        .filter(|d| !d.targets.is_empty())
        .collect();
    out.sort_by(|a, b| a.slicer_id.cmp(&b.slicer_id));
    out
}

/// Owner decision 3 on the sheet-delete path, part 2, run after the delete
/// with every lock released: take each removed slicer's filter off the pivots
/// it held. The host-side masks are cleared here, synchronously -- a
/// level-1 slicer filter on a column in no zone has no visible filter row, so
/// left behind it filtered the pivot with nothing on screen to show or clear
/// it, and every later field-list edit KEPT it. A clear that also dropped a pin
/// (or a calculation group's item state) changes the engine query; those
/// pivots are returned for a BI re-query. Records no undo: a sheet delete ends
/// the history.
pub(crate) fn clear_filters_of_deleted_slicers(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    pivot_state: &PivotState,
    recalc: crate::pivot::operations::PivotRecalcStates<'_>,
    doomed: &[DoomedSlicerFilters],
) -> Vec<identity::EntityId> {
    let mut requery: Vec<identity::EntityId> = Vec::new();
    for d in doomed {
        for target in &d.targets {
            let model_key: Option<(String, String)> = target.bi_field_key.as_deref().and_then(|key| {
                let bi_meta = pivot_state.bi_metadata.read().ok()?;
                let meta = bi_meta.get(&target.pivot_id)?;
                crate::pivot::commands::split_model_column_key(key, meta).ok()
            });
            match crate::pivot::commands::clear_pivot_filter_local(
                state,
                file_state,
                pivot_state,
                recalc,
                target.pivot_id,
                target.field_index,
                model_key.as_ref(),
            ) {
                // A sheet delete ends the history: an overwrite step would
                // have nothing to join, so it is dropped with the rest.
                Ok(crate::pivot::commands::FilterStep::Local(..)) => {}
                // No undo: the pre-clear state it carries is not recorded.
                Ok(crate::pivot::commands::FilterStep::Requery { .. }) => requery.push(target.pivot_id),
                Err(e) => crate::log_warn!(
                    "SLICER",
                    "slicer {} removed with its sheet: could not clear its filter on pivot {}: {}",
                    d.slicer_id,
                    target.pivot_id,
                    e
                ),
            }
        }
    }
    requery.sort();
    requery.dedup();
    requery
}

/// Update slicer properties (name, header, columns, style).
///
/// A MODEL slicer's Report Connections are its page, not a list: a request
/// that tries to change them is refused before anything is written.
#[tauri::command]
pub fn update_slicer(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    slicer_id: identity::EntityId,
    params: UpdateSlicerParams,
) -> Result<Slicer, String> {
    update_slicer_core(&state, &file_state, &slicer_state, slicer_id, params)
}

/// [`update_slicer`] over plain references, for the unit tier.
pub(crate) fn update_slicer_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    slicer_state: &SlicerState,
    slicer_id: identity::EntityId,
    params: UpdateSlicerParams,
) -> Result<Slicer, String> {
    log_debug!("SLICER", "update_slicer id={}", slicer_id);

    // Gate before the mutating effect: a misleveled pin silently changes
    // which measures respect the filter, so refuse out-of-range levels.
    if let Some(level) = params.filter_level {
        crate::slicer::types::validate_filter_level(level)?;
    }

    // Resolve and gate under ONE hold of the store, so the pre-edit clone that
    // becomes the undo payload is exactly what the write replaces.
    let pending = slicer_state.slicers.lock_pending().map_err(|e| e.to_string())?;
    let before = pending
        .get(&slicer_id)
        .cloned()
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;
    if before.is_model_slicer() {
        if let Some(requested) = &params.connected_sources {
            let canonical = Slicer::model_slicer_connections(before.cache_source_id);
            let same = requested.len() == canonical.len()
                && requested
                    .iter()
                    .zip(canonical.iter())
                    .all(|(a, b)| a.source_type == b.source_type && a.source_id == b.source_id);
            if !same {
                return Err(
                    "A model slicer filters every pivot of its model on its own sheet; its report connections cannot be edited"
                        .to_string(),
                );
            }
        }
    }

    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let updated = {
        let mut slicers = pending.authorize(&effect);
        let slicer = slicers
            .get_mut(&slicer_id)
            .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

        if let Some(name) = params.name {
            slicer.name = name;
        }
        if let Some(header_text) = params.header_text {
            slicer.header_text = header_text;
        }
        if let Some(show_header) = params.show_header {
            slicer.show_header = show_header;
        }
        if let Some(columns) = params.columns {
            slicer.columns = columns.clamp(1, 20);
        }
        if let Some(style_preset) = params.style_preset {
            slicer.style_preset = style_preset;
        }
        if let Some(selection_mode) = params.selection_mode {
            slicer.selection_mode = selection_mode;
        }
        if let Some(hide_no_data) = params.hide_no_data {
            slicer.hide_no_data = hide_no_data;
        }
        if let Some(indicate_no_data) = params.indicate_no_data {
            slicer.indicate_no_data = indicate_no_data;
        }
        if let Some(sort_no_data_last) = params.sort_no_data_last {
            slicer.sort_no_data_last = sort_no_data_last;
        }
        if let Some(force_selection) = params.force_selection {
            slicer.force_selection = force_selection;
        }
        if let Some(show_select_all) = params.show_select_all {
            slicer.show_select_all = show_select_all;
        }
        if let Some(arrangement) = params.arrangement {
            slicer.arrangement = arrangement;
        }
        if let Some(rows) = params.rows {
            slicer.rows = rows;
        }
        if let Some(item_gap) = params.item_gap {
            slicer.item_gap = item_gap.max(0.0).min(50.0);
        }
        if let Some(autogrid) = params.autogrid {
            slicer.autogrid = autogrid;
        }
        if let Some(item_padding) = params.item_padding {
            slicer.item_padding = item_padding.max(0.0).min(30.0);
        }
        if let Some(button_radius) = params.button_radius {
            slicer.button_radius = button_radius.max(0.0).min(20.0);
        }
        if let Some(connected_sources) = params.connected_sources {
            slicer.connected_sources = connected_sources;
        }
        if let Some(filter_level) = params.filter_level {
            slicer.filter_level = filter_level;
        }
        slicer.clone()
    };

    // The store guard is dropped before the undo stack is taken (never both).
    // A member of an open transaction, like every other slicer recorder.
    crate::undo_commands::record_slicer_undo(state, slicer_id, before, "Update slicer");
    Ok(updated)
}

/// Update slicer position and size (called after drag/resize, and by a
/// cross-family arrange).
///
/// UNDOABLE, and a MEMBER of an open transaction: it records the existing
/// full-struct "slicer" restore through the guarded join, so an arrange that
/// moves a slicer, a chart and a timeline inside one `begin_undo_transaction`
/// is one Ctrl+Z. It used to record nothing -- dragging a slicer was invisible
/// to undo, which skipped straight past it to the user's previous action.
///
/// Gated like a chart move (`editObjects`), and the effect is minted only after
/// every refusal (unknown id, protected sheet) and only when a value actually
/// changes, so a refused or no-op call leaves the document clean and the undo
/// stack untouched.
#[tauri::command]
pub fn update_slicer_position(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    slicer_id: identity::EntityId,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    update_slicer_position_core(&state, &file_state, &slicer_state, slicer_id, x, y, width, height)
}

/// [`update_slicer_position`] over plain references, for the unit tier.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_slicer_position_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    slicer_state: &SlicerState,
    slicer_id: identity::EntityId,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // Resolve, gate and decide under ONE hold of the store (`lock_pending`),
    // so the pre-edit clone that becomes the undo payload is exactly what the
    // write replaces. The protection read is a leaf lock taken under it.
    let pending = slicer_state.slicers.lock_pending().map_err(|e| e.to_string())?;
    let before = pending
        .get(&slicer_id)
        .cloned()
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;
    crate::protection::check_sheet_action(state, before.sheet_index, "editObjects", "move or resize a slicer")?;
    if before.x == x && before.y == y && before.width == width && before.height == height {
        // Nothing moved: no dirty flag, no Ctrl+Z step that restores itself.
        return Ok(());
    }

    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    {
        let mut slicers = pending.authorize(&effect);
        if let Some(slicer) = slicers.get_mut(&slicer_id) {
            slicer.x = x;
            slicer.y = y;
            slicer.width = width;
            slicer.height = height;
        }
    }
    // The store guard is dropped before the undo stack is taken (never both).
    crate::undo_commands::record_slicer_undo(state, slicer_id, before, "Move slicer");
    Ok(())
}

/// Update slicer selection (which items are checked).
///
/// Without `gesture`: the selection alone, a MEMBER of an open transaction
/// (the plain begin/commit this used to record closed an outer transaction
/// early and split a gesture into several steps).
///
/// With `gesture` -- a SLICER CLICK, the selection AND the filter it puts on
/// every pivot and every TABLE the slicer reaches (BUG-0187, W2): ONE backend
/// command, which writes the selection, runs every pivot write with its own
/// recording off, filters the tables, and pushes ONE step at the end
/// ([`apply_slicer_selection_core`]). The click used to be a frontend
/// transaction held open across the model re-query, so an unrelated edit made
/// during a slow click joined its Ctrl+Z step, and a script's `beginBatch`
/// joined it too (BUG-0200).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_slicer_selection(
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<'_, SlicerState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_id: identity::EntityId,
    selected_items: Option<Vec<String>>,
    gesture: Option<crate::pivot::types::PivotFilterGesture>,
) -> Result<Option<SlicerSelectionGestureResponse>, String> {
    let Some(gesture) = gesture else {
        update_slicer_selection_core(&state, &file_state, &slicer_state, slicer_id, selected_items, "Slicer filter change")?;
        return Ok(None);
    };
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
    apply_slicer_selection_core(&ctx, slicer_id, selected_items, gesture).await.map(Some)
}

/// The undo mode a gesture's wire `step` asks for.
pub(crate) fn gesture_step_mode(step: crate::pivot::types::FilterGestureStep) -> crate::undo_commands::GestureStepMode {
    use crate::pivot::types::FilterGestureStep;
    use crate::undo_commands::GestureStepMode;
    match step {
        FilterGestureStep::Own => GestureStepMode::Own,
        FilterGestureStep::Join => GestureStepMode::Join,
    }
}

/// A gesture's response: its run, and where its ONE step went.
pub(crate) fn gesture_response(
    run: crate::pivot::commands::PivotFilterGestureRun,
    outcome: crate::undo_commands::GestureStepOutcome,
) -> crate::pivot::types::PivotFilterGestureResponse {
    use crate::pivot::types::FilterGestureStepOutcome;
    use crate::undo_commands::GestureStepOutcome;
    let (step, step_seq) = match outcome {
        GestureStepOutcome::Nothing => (FilterGestureStepOutcome::Nothing, None),
        GestureStepOutcome::Pushed(seq) => (FilterGestureStepOutcome::Pushed, Some(seq)),
        GestureStepOutcome::Joined => (FilterGestureStepOutcome::Joined, None),
    };
    crate::pivot::types::PivotFilterGestureResponse {
        responses: run.responses,
        failures: run.failures,
        step,
        step_seq,
        // A step that was not recorded holds nothing a Cancel could name.
        overwrite_token: if step == FilterGestureStepOutcome::Nothing { None } else { run.overwrite_token },
    }
}

/// A SLICER CLICK as ONE command (BUG-0187): the selection, then every pivot
/// write the frontend resolved for it (its Report Connections pivots, or a
/// model slicer's page), then every TABLE it is connected to (W2), then ONE
/// undo step.
///
/// TABLES (W2). A table connection's AutoFilter column is filtered HERE, on
/// the table's own sheet (`autofilter::set_column_values_on_sheet`), and its
/// restore joins the click's one step. The frontend used to filter tables
/// through the AutoFilter owner AFTER this command, so the step had to be
/// held open for them -- and every edit the user made while those writes ran
/// joined the click (those modes are gone). A table that cannot
/// take the filter is reported in `table_failures` (an APPLY only: a CLEAR
/// there has no filter of this slicer's to take off); the other targets still
/// filter. The frontend then has the AutoFilter owner re-read the filter.
///
/// The selection is written FIRST -- a pinned write re-queries, and the
/// re-query folds in the page's model slicers, so it must read the NEW
/// selection -- and recorded nowhere yet. The pivot writes run with their own
/// recording off ([`crate::pivot::commands::run_pivot_filter_gesture`]), so no
/// undo transaction is held open across a model re-query. The step is pushed
/// once, at the end, the way `gesture.step` says: a user click is a step of
/// its own, even while a script batch that has recorded nothing yet is open
/// (one that already holds writes is joined and marked shared, so undoing
/// replays in time order); a script's own call JOINS the batch it opened. No
/// step is left open for anything after the command: its TABLE targets are
/// filtered above, inside it. See `undo_commands::GestureStepMode`. The
/// pivots are recorded first and the slicer LAST, so the reverse replay
/// restores the slicer first (the `delete_slicer_core` order).
///
/// Refusal first: an unknown slicer writes nothing and records nothing. A
/// pivot write that refuses is reported and the others still run.
///
/// IN FLIGHT from the selection write to the push: an undo or redo asked for
/// meanwhile is refused (`undo_commands::history_move_refusal`). It used to
/// take back the step BEFORE the click -- restoring the slicer over the
/// click's new selection while the click's pivot writes still landed with it,
/// and the click's push then cleared that undo's redo (the review of BUG-0187).
pub(crate) async fn apply_slicer_selection_core(
    ctx: &PivotCmdCtx<'_>,
    slicer_id: identity::EntityId,
    selected_items: Option<Vec<String>>,
    gesture: crate::pivot::types::PivotFilterGesture,
) -> Result<SlicerSelectionGestureResponse, String> {
    let _in_flight = crate::undo_commands::PendingGesture::begin(ctx.state);
    let before = write_slicer_selection_unrecorded(ctx.file_state, ctx.slicer_state, slicer_id, selected_items)?;
    let mut run = crate::pivot::commands::run_pivot_filter_gesture(ctx, gesture.writes).await;
    let mut restores = std::mem::take(&mut run.restores);
    // The tables, with the selection as it stands NOW (the store holds the
    // new one). Synchronous: no lock is held and nothing is awaited.
    let slicer = ctx.slicer_state.slicers.read().map_err(|e| e.to_string())?.get(&slicer_id).cloned();
    let tables = match &slicer {
        Some(slicer) => filter_slicer_tables(ctx.state, ctx.file_state, slicer),
        None => SlicerTableWrites::default(),
    };
    restores.extend(tables.restores);
    // LAST, so the reverse replay restores the slicer first.
    if let Some(before) = before {
        restores.push(crate::undo_commands::slicer_restore(slicer_id, before));
    }
    let outcome =
        crate::undo_commands::record_gesture_step(ctx.state, "Slicer Selection", restores, gesture_step_mode(gesture.step));
    // Rows the tables hid or showed change what SUBTOTAL/AGGREGATE-style
    // formulas see -- the recalculation `set_column_filter_values` runs.
    if !tables.sheets.is_empty() {
        if let Err(e) = crate::calculation::recalc_visibility_dependents_core(
            ctx.state,
            ctx.user_files_state,
            ctx.pivot_state,
            Some((ctx.pane_control_state, ctx.ribbon_filter_state)),
        ) {
            crate::log_warn!("SLICER", "visibility recalc after slicer {} filtered its tables failed: {}", slicer_id, e);
        }
    }
    Ok(SlicerSelectionGestureResponse {
        gesture: gesture_response(run, outcome),
        table_sheets: tables.sheets,
        table_failures: tables.failures,
    })
}

/// What a click's TABLE writes did (see [`filter_slicer_tables`]).
#[derive(Default)]
pub(crate) struct SlicerTableWrites {
    /// One `obj_autofilter` restore per table filter written, for the click's
    /// one step.
    pub restores: Vec<(&'static str, Vec<u8>)>,
    /// The sheets whose AutoFilter changed, each once.
    pub sheets: Vec<usize>,
    /// The tables that refused.
    pub failures: Vec<SlicerTableFilterFailure>,
}

/// Put `slicer`'s selection on every TABLE it is connected to (a null
/// selection clears the column), recording nothing: the restores are handed
/// back for the caller's one step. The values are the slicer's items with the
/// blank spellings ("" and "(Blanks)") turned into "keep blanks", as the
/// frontend's AutoFilter call did. Each table's refusal is collected; the
/// others still filter.
pub(crate) fn filter_slicer_tables(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    slicer: &Slicer,
) -> SlicerTableWrites {
    let mut out = SlicerTableWrites::default();
    let clearing = slicer.selected_items.is_none();
    for (table_id, target) in table_click_targets(state, slicer) {
        let target = match target {
            Ok(target) => target,
            // A CLEAR on a table that cannot take this slicer's filter has
            // nothing of this slicer's to take off.
            Err(reason) if clearing => {
                log_debug!("SLICER", "slicer {}: nothing to clear on table {}: {}", slicer.id, table_id, reason);
                continue;
            }
            Err(reason) => {
                out.failures.push(SlicerTableFilterFailure { table_id, clearing, message: reason });
                continue;
            }
        };
        let written = match &slicer.selected_items {
            None => crate::autofilter::clear_column_values_on_sheet(
                state,
                file_state,
                target.sheet,
                target.filter_id,
                target.column_index,
            ),
            Some(selected) => {
                let is_blank = |v: &String| v.is_empty() || v == "(Blanks)";
                crate::autofilter::set_column_values_on_sheet(
                    state,
                    file_state,
                    target.sheet,
                    target.filter_id,
                    target.column_index,
                    selected.iter().filter(|v| !is_blank(v)).cloned().collect(),
                    selected.iter().any(is_blank),
                )
            }
        };
        match written {
            Ok(Some(previous)) => {
                out.restores.push(crate::undo_commands::encode_autofilter_restore(target.sheet, Some(previous)));
                if !out.sheets.contains(&target.sheet) {
                    out.sheets.push(target.sheet);
                }
            }
            Ok(None) => {}
            Err(message) => out.failures.push(SlicerTableFilterFailure { table_id, clearing, message }),
        }
    }
    out
}

/// The AutoFilter column each TABLE connection of `slicer` is filtered
/// through, resolved -- or why it cannot be: its table is gone, has no column
/// named like the slicer's field, its sheet has no AutoFilter or one another
/// table owns, or the column lies outside it. The sheet's ONE AutoFilter is
/// keyed relative to ITS start column, so the table's column is translated
/// through absolute grid coordinates. Any sheet: a table slicer may sit on
/// another sheet than its table.
///
/// LOCKS: `tables` then `auto_filters` (the order `create_table` uses), both
/// released on return.
pub(crate) fn table_click_targets(
    state: &AppState,
    slicer: &Slicer,
) -> Vec<(identity::EntityId, Result<TableSlicerFilterTarget, String>)> {
    let mut table_ids: Vec<identity::EntityId> = Vec::new();
    for c in &slicer.connected_sources {
        if c.source_type == SlicerSourceType::Table && !table_ids.contains(&c.source_id) {
            table_ids.push(c.source_id);
        }
    }
    if table_ids.is_empty() {
        return Vec::new();
    }
    let (Ok(tables), Ok(auto_filters)) = (state.tables.read(), state.auto_filters.read()) else {
        return table_ids.into_iter().map(|id| (id, Err("the tables could not be read".to_string()))).collect();
    };
    let field = &slicer.field_name;
    table_ids
        .into_iter()
        .map(|table_id| {
            let resolved = (|| {
                let (sheet, table) = tables
                    .iter()
                    .find_map(|(sheet, by_id)| by_id.get(&table_id).map(|t| (*sheet, t)))
                    .ok_or_else(|| "its table is no longer in the workbook".to_string())?;
                let offset = table
                    .columns
                    .iter()
                    .position(|c| &c.name == field)
                    .ok_or_else(|| format!("the table has no column \"{field}\""))?;
                let af = auto_filters
                    .get(&sheet)
                    .ok_or_else(|| "the table's sheet has no AutoFilter to filter with".to_string())?;
                if table.auto_filter_id != Some(af.id) {
                    // Refused rather than filtering ANOTHER table's columns.
                    return Err("the sheet's AutoFilter belongs to another table".to_string());
                }
                let abs_col = table.start_col + offset as u32;
                if abs_col < af.start_col || abs_col > af.end_col {
                    return Err(format!("column \"{field}\" is outside the table's AutoFilter range"));
                }
                Ok(TableSlicerFilterTarget { sheet, filter_id: af.id, column_index: abs_col - af.start_col })
            })();
            (table_id, resolved)
        })
        .collect()
}

/// Write a slicer's selection WITHOUT recording it, handing back the slicer as
/// it was (for the caller's one step), or `None` when the selection already
/// was that (nothing written, the document left clean). An unknown slicer is
/// refused before anything is written.
pub(crate) fn write_slicer_selection_unrecorded(
    file_state: &crate::persistence::FileState,
    slicer_state: &SlicerState,
    slicer_id: identity::EntityId,
    selected_items: Option<Vec<String>>,
) -> Result<Option<Slicer>, String> {
    let pending = slicer_state.slicers.lock_pending().map_err(|e| e.to_string())?;
    let before = pending
        .get(&slicer_id)
        .cloned()
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;
    if before.selected_items == selected_items {
        return Ok(None);
    }
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut slicers = pending.authorize(&effect);
    if let Some(slicer) = slicers.get_mut(&slicer_id) {
        slicer.selected_items = selected_items;
    }
    Ok(Some(before))
}

/// [`update_slicer_selection`] (and [`clear_slicer_filter`]) over plain
/// references. Refusal-first, and a no-op (the selection is already that)
/// leaves the document clean and records no step.
pub(crate) fn update_slicer_selection_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    slicer_state: &SlicerState,
    slicer_id: identity::EntityId,
    selected_items: Option<Vec<String>>,
    description: &str,
) -> Result<(), String> {
    log_debug!(
        "SLICER",
        "update_slicer_selection id={} items={:?}",
        slicer_id,
        selected_items.as_ref().map(|v| v.len())
    );

    let pending = slicer_state.slicers.lock_pending().map_err(|e| e.to_string())?;
    let before = pending
        .get(&slicer_id)
        .cloned()
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;
    if before.selected_items == selected_items {
        return Ok(());
    }

    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    {
        let mut slicers = pending.authorize(&effect);
        if let Some(slicer) = slicers.get_mut(&slicer_id) {
            slicer.selected_items = selected_items;
        }
    }
    // The store guard is dropped before the undo stack is taken (never both).
    crate::undo_commands::record_slicer_undo(state, slicer_id, before, description);
    Ok(())
}

// ============================================================================
// QUERY COMMANDS
// ============================================================================

/// Get a single slicer by ID.
#[tauri::command]
pub fn get_slicer(
    slicer_state: State<SlicerState>,
    slicer_id: identity::EntityId,
) -> Result<Slicer, String> {
    slicer_state
        .slicers
        .read()
        .unwrap()
        .get(&slicer_id)
        .cloned()
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))
}

/// Clear all filter selections on a slicer (set all items to selected).
/// Joins an open transaction, like [`update_slicer_selection`].
#[tauri::command]
pub fn clear_slicer_filter(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    slicer_id: identity::EntityId,
) -> Result<(), String> {
    update_slicer_selection_core(&state, &file_state, &slicer_state, slicer_id, None, "Clear slicer filter")
}

/// Toggle a single item's selection state within a slicer.
/// If the slicer currently has all items selected (selectedItems = null),
/// toggling an item OFF creates a selection list with all items except that one.
/// If toggling an item ON completes the full set, clears the filter (null).
///
/// A MODEL slicer's full item list comes from its model (the same path its
/// items do), so unchecking one item while all are selected works for it too
/// -- the old branch worked only on the current list and did nothing there.
#[tauri::command]
pub async fn set_slicer_item_selected(
    state: State<'_, AppState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<'_, SlicerState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_id: identity::EntityId,
    value: String,
    selected: bool,
) -> Result<(), String> {
    // Phase 1: the slicer, cloned (no guard may live across the await).
    let slicer = slicer_state
        .slicers
        .read()
        .map_err(|e| e.to_string())?
        .get(&slicer_id)
        .cloned()
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    // Phase 2: its full item list.
    let all_items: Vec<String> = match slicer.source_type {
        SlicerSourceType::Table => {
            get_table_column_values(&state, slicer.cache_source_id, &slicer.field_name).unwrap_or_default()
        }
        SlicerSourceType::Pivot => {
            get_pivot_field_values(&pivot_state, slicer.cache_source_id, &slicer.field_name).unwrap_or_default()
        }
        SlicerSourceType::BiConnection => model_slicer_values(&bi_state, &slicer).await?,
    };

    // Phase 3: decide, then write through the one selection path.
    let next = toggled_selection(&all_items, slicer.selected_items.as_deref(), &value, selected);
    update_slicer_selection_core(&state, &file_state, &slicer_state, slicer_id, next, "Slicer item toggle")
}

/// The selection after toggling one item: `None` (no filter) once every item
/// is selected, otherwise the selected items in the list's own order. Pure.
pub(crate) fn toggled_selection(
    all_items: &[String],
    current: Option<&[String]>,
    value: &str,
    selected: bool,
) -> Option<Vec<String>> {
    let mut set: std::collections::HashSet<&str> = match current {
        None => all_items.iter().map(|s| s.as_str()).collect(),
        Some(items) => items.iter().map(|s| s.as_str()).collect(),
    };
    if selected {
        set.insert(value);
    } else {
        set.remove(value);
    }
    if !all_items.is_empty() && all_items.iter().all(|v| set.contains(v.as_str())) {
        return None;
    }
    let mut out: Vec<String> = all_items.iter().filter(|v| set.contains(v.as_str())).cloned().collect();
    // A selected value the list does not (yet) contain is kept, not dropped.
    for v in set {
        if !all_items.iter().any(|a| a == v) {
            out.push(v.to_string());
        }
    }
    Some(out)
}

/// Get all slicers.
#[tauri::command]
pub fn get_all_slicers(
    slicer_state: State<SlicerState>,
) -> Vec<Slicer> {
    slicer_state
        .slicers
        .read()
        .unwrap()
        .values()
        .cloned()
        .collect()
}

/// Get slicers for a specific sheet.
#[tauri::command]
pub fn get_slicers_for_sheet(
    slicer_state: State<SlicerState>,
    sheet_index: usize,
) -> Vec<Slicer> {
    slicer_state
        .slicers
        .read()
        .unwrap()
        .values()
        .filter(|s| s.sheet_index == sheet_index)
        .cloned()
        .collect()
}

/// A ribbon filter with a selection, pre-resolved for cross-filter candidacy
/// BEFORE the slicer lock is taken.
#[derive(Debug, Clone)]
pub(crate) struct RibbonCrossCandidate {
    pub field_name: String,
    pub selection: Vec<String>,
    /// `crossFilterSlicerTargets` names the slicer asking.
    pub explicit: bool,
    pub connection_id: identity::EntityId,
    pub mode: crate::ribbon_filter::ConnectionMode,
    pub sheets: Vec<usize>,
    /// The filter's effective target pivots (mode-aware).
    pub targets: std::collections::HashSet<identity::EntityId>,
}

/// The cross filters a MODEL slicer's has-data shading honours -- PAGE
/// scoped, and the REPLACEMENT for the generic sibling path (which would make
/// every model slicer of the same connection on ANY sheet a sibling, because
/// they all carry the same `[{biConnection, C}]` connection):
/// - other model slicers of the same connection on the SAME sheet with a
///   selection;
/// - ribbon filters of the same connection with a selection that reach this
///   page: they name this slicer, or run in Workbook mode, or By-sheet with
///   this sheet, or Manual with a target pivot on this sheet.
/// A filter on the slicer's own column is skipped (it is not a cross filter).
/// Pure.
pub(crate) fn model_slicer_cross_filters<'s, I>(
    slicer: &Slicer,
    slicers: I,
    ribbon: &[RibbonCrossCandidate],
    pivots_on_page: &std::collections::HashSet<identity::EntityId>,
) -> Vec<(String, Vec<String>)>
where
    I: IntoIterator<Item = &'s Slicer>,
{
    use crate::ribbon_filter::ConnectionMode;
    let same_connection = |other: &Slicer| {
        other.cache_source_id == slicer.cache_source_id
            || (slicer.data_source_id.is_some() && other.data_source_id == slicer.data_source_id)
    };
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for other in slicers {
        if other.id == slicer.id
            || !other.is_model_slicer()
            || other.sheet_index != slicer.sheet_index
            || !same_connection(other)
            || other.field_name == slicer.field_name
        {
            continue;
        }
        if let Some(selection) = &other.selected_items {
            out.push((other.field_name.clone(), selection.clone()));
        }
    }
    for r in ribbon {
        if r.connection_id != slicer.cache_source_id || r.field_name == slicer.field_name {
            continue;
        }
        let reaches = r.explicit
            || match r.mode {
                ConnectionMode::Workbook => true,
                ConnectionMode::BySheet => r.sheets.contains(&slicer.sheet_index),
                ConnectionMode::Manual => r.targets.iter().any(|p| pivots_on_page.contains(p)),
            };
        if reaches {
            out.push((r.field_name.clone(), r.selection.clone()));
        }
    }
    out
}

/// The model tables of a connection's engine, for splitting "Table.Column"
/// keys (table names can contain dots).
async fn model_table_names(
    bi_state: &crate::bi::types::BiState,
    connection_id: identity::EntityId,
) -> Result<Vec<String>, String> {
    let engine_arc = crate::bi::commands::get_engine_arc(bi_state, connection_id)?;
    let engine = engine_arc.lock().await;
    Ok(engine.model().tables().iter().map(|t| t.name().to_string()).collect())
}

/// Every value of a MODEL slicer's column, read from the model (never from a
/// pivot cache, so the domain cannot collapse to what a filtered pivot shows).
async fn model_slicer_values(
    bi_state: &crate::bi::types::BiState,
    slicer: &Slicer,
) -> Result<Vec<String>, String> {
    let tables = model_table_names(bi_state, slicer.cache_source_id).await?;
    let (table, column) =
        crate::pivot::commands::split_bi_field_key(&slicer.field_name, tables.iter().map(|t| t.as_str()));
    if table.is_empty() {
        return Err(format!("'{}' is not a model column", slicer.field_name));
    }
    crate::bi::commands::bi_get_column_values_core(bi_state, slicer.cache_source_id, &table, &column).await
}

/// Get the unique items for a slicer (reads from the data source).
/// Returns items with their selection state and data availability.
/// Cross-filtering: checks other slicers AND ribbon filters that share
/// connected sources to determine which items still have matching data.
#[tauri::command]
pub async fn get_slicer_items(
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
    slicer_state: State<'_, SlicerState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_id: identity::EntityId,
) -> Result<Vec<SlicerItem>, String> {
    get_slicer_items_core(&state, &pivot_state, &slicer_state, &ribbon_filter_state, &bi_state, slicer_id).await
}

/// [`get_slicer_items`] over borrowed state.
pub(crate) async fn get_slicer_items_core(
    state: &AppState,
    pivot_state: &PivotState,
    slicer_state: &SlicerState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    bi_state: &crate::bi::types::BiState,
    slicer_id: identity::EntityId,
) -> Result<Vec<SlicerItem>, String> {
    // Pre-resolve each active ribbon filter's cross-filter candidacy BEFORE
    // taking the slicer lock: its field + selection, whether it explicitly
    // targets this slicer, and its effective target-pivot set. Targets are
    // mode-aware — manual uses the stored list; bySheet/workbook resolve to
    // the pivots of the filter's model connection (mirrors the frontend
    // bridge's resolveTargetPivots, which is where filters actually apply).
    let ribbon_candidates: Vec<RibbonCrossCandidate> = {
        use crate::ribbon_filter::ConnectionMode;
        let snapshot: Vec<_> = {
            let filters = ribbon_filter_state.filters.read().unwrap();
            filters
                .values()
                .filter(|f| f.selected_items.is_some())
                .map(|f| (
                    f.field_name.clone(),
                    f.selected_items.clone().unwrap(),
                    f.cross_filter_slicer_targets.contains(&slicer_id),
                    f.connection_id,
                    f.connection_mode,
                    f.connected_pivots.clone(),
                    f.connected_sheets.clone(),
                ))
                .collect()
        };
        snapshot
            .into_iter()
            .map(|(field_name, selection, explicit, connection_id, mode, pivots, sheets)| {
                let targets: std::collections::HashSet<identity::EntityId> = match mode {
                    ConnectionMode::Manual => pivots.into_iter().collect(),
                    ConnectionMode::Workbook => {
                        crate::pivot::commands::bi_pivots_for_connection(state, pivot_state, connection_id)
                            .into_iter()
                            .map(|p| p.id)
                            .collect()
                    }
                    ConnectionMode::BySheet => {
                        let sheet_set: std::collections::HashSet<usize> = sheets.iter().copied().collect();
                        crate::pivot::commands::bi_pivots_for_connection(state, pivot_state, connection_id)
                            .into_iter()
                            .filter(|p| sheet_set.contains(&p.sheet_index))
                            .map(|p| p.id)
                            .collect()
                    }
                };
                RibbonCrossCandidate { field_name, selection, explicit, connection_id, mode, sheets, targets }
            })
            .collect()
    };

    // A MODEL slicer's page: the BI pivots of its connection on its sheet,
    // resolved before the slicer lock too (the helper takes the pivot locks).
    let model_page: Option<std::collections::HashSet<identity::EntityId>> = {
        let head = slicer_state
            .slicers
            .read()
            .unwrap()
            .get(&slicer_id)
            .filter(|s| s.is_model_slicer())
            .map(|s| (s.cache_source_id, s.sheet_index));
        head.map(|(conn, sheet)| {
            crate::pivot::commands::bi_pivots_for_connection(state, pivot_state, conn)
                .into_iter()
                .filter(|p| p.sheet_index == sheet)
                .map(|p| p.id)
                .collect()
        })
    };

    // Everything lock-holding happens in this block (the command is async —
    // no guard may live across an await). Clones what phase 2 needs.
    let (slicer, unique_values_sync, has_data_set, pinned_bi, model_cross) = {
    let slicers = slicer_state.slicers.read().unwrap();
    let slicer = slicers
        .get(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    if slicer.is_model_slicer() {
        // Items come from the MODEL (phase 2); cross filters are page scoped
        // and REPLACE the generic sibling path below.
        let page = model_page.clone().unwrap_or_default();
        let cross = model_slicer_cross_filters(slicer, slicers.values(), &ribbon_candidates, &page);
        (slicer.clone(), None, None, None, Some(cross))
    } else {

    // Items always come from the cache source (the data model), regardless of
    // which pivots the slicer filters via Report Connections.
    let reference_source_id = slicer.cache_source_id;

    // Collect filters from OTHER slicers that share any connected source (cross-filtering).
    let slicer_connected: std::collections::HashSet<identity::EntityId> =
        slicer.connected_sources.iter()
            .filter(|c| c.source_type == slicer.source_type)
            .map(|c| c.source_id)
            .collect();
    let mut sibling_filters: Vec<(String, Vec<String>)> = slicers
        .values()
        .filter(|s| {
            s.id != slicer_id
                && s.selected_items.is_some()
                && s.connected_sources.iter().any(|c| slicer_connected.contains(&c.source_id))
        })
        .map(|s| (s.field_name.clone(), s.selected_items.clone().unwrap()))
        .collect();

    // Also collect cross-filters from ribbon filters.
    // Match if: (a) their effective target pivots overlap this slicer's
    //               connected sources (both filter the same pivot), OR
    //           (b) they explicitly target this slicer via crossFilterSlicerTargets.
    {
        let ribbon_siblings: Vec<(String, Vec<String>)> = ribbon_candidates
            .iter()
            .filter(|r| r.explicit || r.targets.iter().any(|p| slicer_connected.contains(p)))
            .map(|r| (r.field_name.clone(), r.selection.clone()))
            .collect();
        sibling_filters.extend(ribbon_siblings);
    }

    // A PINNED (level >= 2) pivot slicer's filter is routed INSIDE the BI
    // query, so the pivot cache only holds the SELECTED values — cache
    // uniques would make the unselected items vanish and the slicer could
    // never re-expand. Fetch the full domain from the BI model instead
    // (phase 2, async, after the locks drop).
    let pinned_bi: Option<(crate::bi::types::ConnectionId, String, String)> = if slicer
        .filter_level
        >= 2
        && slicer.source_type == SlicerSourceType::Pivot
    {
        let bi_meta = pivot_state.bi_metadata.read().unwrap();
        bi_meta.get(&reference_source_id).and_then(|meta| {
            let name = slicer.field_name.clone();
            let table_names: Vec<&str> =
                meta.model_tables.iter().map(|t| t.name.as_str()).collect();
            let (table, column) = if name.contains('.') {
                crate::pivot::commands::split_bi_field_key(&name, table_names.iter().copied())
            } else {
                let table_name = meta
                    .model_tables
                    .iter()
                    .find(|t| t.columns.iter().any(|c| c.name == name))
                    .map(|t| t.name.clone())
                    .unwrap_or_default();
                (table_name, name)
            };
            (!table.is_empty()).then(|| (meta.connection_id, table, column))
        })
    } else {
        None
    };

    let unique_values: Option<Vec<String>> = if pinned_bi.is_some() {
        None // fetched async in phase 2
    } else {
        Some(match slicer.source_type {
            SlicerSourceType::Table => get_table_column_values(state, reference_source_id, &slicer.field_name)?,
            SlicerSourceType::Pivot => get_pivot_field_values(pivot_state, reference_source_id, &slicer.field_name)?,
            SlicerSourceType::BiConnection => unreachable!("model slicers take the branch above"),
        })
    };

    // Compute has_data by checking cross-slicer filters. A pinned slicer
    // skips availability shading: its domain comes from the model, not the
    // (already pin-filtered) cache, so cache-based availability would grey
    // every unselected value as "no data".
    let has_data_set = if sibling_filters.is_empty() || pinned_bi.is_some() {
        None // No cross-filtering needed, all items have data
    } else {
        match slicer.source_type {
            SlicerSourceType::Table => {
                Some(get_table_available_values(state, reference_source_id, &slicer.field_name, &sibling_filters)?)
            }
            SlicerSourceType::Pivot => {
                Some(get_pivot_available_values(pivot_state, reference_source_id, &slicer.field_name, &sibling_filters)?)
            }
            SlicerSourceType::BiConnection => unreachable!("model slicers take the branch above"),
        }
    };

    (slicer.clone(), unique_values, has_data_set, pinned_bi, None)
    }
    }; // locks drop here — phase 2 may await

    // Phase 2 (async): model reads.
    let (unique_values, has_data_set): (Vec<String>, Option<std::collections::HashSet<String>>) =
        match (&model_cross, unique_values_sync, &pinned_bi) {
            (Some(cross), _, _) => {
                let tables = model_table_names(bi_state, slicer.cache_source_id).await?;
                let split = |key: &str| {
                    crate::pivot::commands::split_bi_field_key(key, tables.iter().map(|t| t.as_str()))
                };
                let (table, column) = split(&slicer.field_name);
                if table.is_empty() {
                    return Err(format!("'{}' is not a model column", slicer.field_name));
                }
                let values = crate::bi::commands::bi_get_column_values_core(
                    bi_state,
                    slicer.cache_source_id,
                    &table,
                    &column,
                )
                .await?;
                let cross_filters: Vec<crate::bi::types::BiCrossFilter> = cross
                    .iter()
                    .filter_map(|(key, values)| {
                        let (t, c) = split(key);
                        (!t.is_empty()).then(|| crate::bi::types::BiCrossFilter {
                            table: t,
                            column: c,
                            values: values.clone(),
                        })
                    })
                    .collect();
                let available = if cross_filters.is_empty() {
                    None
                } else {
                    Some(
                        crate::bi::commands::bi_get_column_available_values_core(
                            bi_state,
                            slicer.cache_source_id,
                            &table,
                            &column,
                            &cross_filters,
                        )
                        .await?
                        .into_iter()
                        .collect(),
                    )
                };
                (values, available)
            }
            (None, Some(values), _) => (values, has_data_set),
            (None, None, Some((conn_id, table, column))) => (
                crate::bi::commands::bi_get_column_values_core(bi_state, *conn_id, table, column).await?,
                has_data_set,
            ),
            (None, None, None) => (Vec::new(), has_data_set),
        };

    // Build items with selection state and data availability
    let mut items: Vec<SlicerItem> = unique_values
        .into_iter()
        .map(|value| {
            let selected = match &slicer.selected_items {
                None => true,
                Some(selected) => selection_holds_item(selected, &value),
            };
            let has_data = match &has_data_set {
                None => true,
                Some(available) => available.contains(&value),
            };
            SlicerItem {
                value,
                selected,
                has_data,
            }
        })
        .collect();

    // Apply display settings
    if slicer.hide_no_data {
        items.retain(|item| item.has_data);
    } else if slicer.sort_no_data_last {
        // Stable sort: items with data first, then items without data
        items.sort_by_key(|item| !item.has_data);
    }

    Ok(items)
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/// Match a slicer field name against a cache field name.
/// Handles "table.column" format: if the slicer field name contains a dot,
/// the cache field name is matched against the part after the last dot.
fn field_name_matches(cache_name: &str, slicer_name: &str) -> bool {
    if cache_name == slicer_name {
        return true;
    }
    // For BI pivots, slicer field name may be "table.column" while
    // cache field name is just "column" (from Arrow schema)
    if let Some(col_part) = slicer_name.rsplit('.').next() {
        if cache_name == col_part {
            return true;
        }
    }
    false
}

/// Get unique values from a table column.
fn get_table_column_values(state: &AppState, source_id: identity::EntityId, field_name: &str) -> Result<Vec<String>, String> {
    // CANONICAL LOCK ORDER: `grids` first (see the note in
    // `state_digest_lock_order_tests`). The recalculation pass holds both grid
    // locks and then takes `tables` on a background thread.
    let grids = state.grids.read().unwrap();
    let style_registry = state.style_registry.read().unwrap();
    let tables = state.tables.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // Find the table
    let table = tables
        .values()
        .flat_map(|sheet_tables| sheet_tables.values())
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Table {} not found", source_id))?;

    // Find the column index by name
    let col_offset = table
        .columns
        .iter()
        .position(|c| c.name == field_name)
        .ok_or_else(|| format!("Column '{}' not found in table", field_name))?;

    let abs_col = table.start_col + col_offset as u32;
    let data_start_row = if table.style_options.header_row {
        table.start_row + 1
    } else {
        table.start_row
    };

    if table.sheet_index >= grids.len() {
        return Err("Invalid sheet index".to_string());
    }
    let grid = &grids[table.sheet_index];

    let mut seen = HashMap::new();
    for row in data_start_row..=table.end_row {
        let value = if let Some(cell) = grid.cells.get(&(row, abs_col)) {
            let style = style_registry.get(grid.effective_style_index(row, abs_col));
            format_cell_value(&cell.value, style, &locale)
        } else {
            String::new()
        };
        if !value.is_empty() {
            seen.entry(value).or_insert(());
        }
    }

    let mut values: Vec<String> = seen.into_keys().collect();
    values.sort();
    Ok(values)
}

/// Get values from a table column that still have data given cross-slicer filters.
/// Scans the table rows and checks each row against filters from sibling slicers.
fn get_table_available_values(
    state: &AppState,
    source_id: identity::EntityId,
    field_name: &str,
    sibling_filters: &[(String, Vec<String>)],
) -> Result<std::collections::HashSet<String>, String> {
    // CANONICAL LOCK ORDER: `grids` first (see the note in
    // `state_digest_lock_order_tests`). The recalculation pass holds both grid
    // locks and then takes `tables` on a background thread.
    let grids = state.grids.read().unwrap();
    let style_registry = state.style_registry.read().unwrap();
    let tables = state.tables.read().unwrap();
    let locale = state.locale.lock().unwrap();

    let table = tables
        .values()
        .flat_map(|sheet_tables| sheet_tables.values())
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Table {} not found", source_id))?;

    // Find the target column index
    let target_col_offset = table
        .columns
        .iter()
        .position(|c| c.name == field_name)
        .ok_or_else(|| format!("Column '{}' not found", field_name))?;
    let target_abs_col = table.start_col + target_col_offset as u32;

    // Resolve sibling filter column indices
    let filter_cols: Vec<(u32, &Vec<String>)> = sibling_filters
        .iter()
        .filter_map(|(field_name, allowed)| {
            table
                .columns
                .iter()
                .position(|c| &c.name == field_name)
                .map(|offset| (table.start_col + offset as u32, allowed))
        })
        .collect();

    let data_start_row = if table.style_options.header_row {
        table.start_row + 1
    } else {
        table.start_row
    };

    if table.sheet_index >= grids.len() {
        return Err("Invalid sheet index".to_string());
    }
    let grid = &grids[table.sheet_index];

    let mut available = std::collections::HashSet::new();

    for row in data_start_row..=table.end_row {
        // Check if this row passes all sibling filters
        let passes = filter_cols.iter().all(|(col, allowed)| {
            let value = if let Some(cell) = grid.cells.get(&(row, *col)) {
                let style = style_registry.get(grid.effective_style_index(row, *col));
                format_cell_value(&cell.value, style, &locale)
            } else {
                String::new()
            };
            allowed.contains(&value)
        });

        if passes {
            // This row passes all sibling filters — record the target column value
            let value = if let Some(cell) = grid.cells.get(&(row, target_abs_col)) {
                let style = style_registry.get(grid.effective_style_index(row, target_abs_col));
                format_cell_value(&cell.value, style, &locale)
            } else {
                String::new()
            };
            if !value.is_empty() {
                available.insert(value);
            }
        }
    }

    Ok(available)
}

/// Get unique values from a pivot table field.
fn get_pivot_field_values(
    pivot_state: &PivotState,
    source_id: identity::EntityId,
    field_name: &str,
) -> Result<Vec<String>, String> {
    use pivot_engine::VALUE_ID_EMPTY;

    let pivot_id = source_id;
    let mut pivot_tables = pivot_state.pivot_tables.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::DerivedCache)).unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Find the field index by name in the cache
    // Supports both "column" and "table.column" format
    let field_index = cache
        .fields
        .iter()
        .position(|f| field_name_matches(&f.name, field_name))
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", field_name))?;
    // The BLANK item is listed (last) when the column has blank records: a
    // level-1 selection hides the blank rows unless it names the blank item
    // (`hidden_for_selection`), so the list must offer it -- without it,
    // deselecting one item from "all" dropped the blank rows too, with no
    // item to bring them back (the review of A1). Excel lists "(blank)".
    let has_blank = cache.has_blank_values(field_index);

    let field = cache
        .fields
        .get_mut(field_index)
        .ok_or_else(|| format!("Field index {} out of range in cache", field_index))?;

    let sorted_ids = field.sorted_ids().to_vec();
    let unique_values: Vec<String> = sorted_ids
        .iter()
        .filter_map(|&id| {
            if id == VALUE_ID_EMPTY {
                return None;
            }
            field.get_value(id).map(|value| {
                // Convert pivot cache value to string
                match value {
                    pivot_engine::CacheValue::Number(n) => {
                        if n.0.fract() == 0.0 {
                            format!("{}", n.0 as i64)
                        } else {
                            format!("{}", n.0)
                        }
                    }
                    pivot_engine::CacheValue::Text(s) => s.to_string(),
                    pivot_engine::CacheValue::Boolean(b) => {
                        if *b {
                            "TRUE".to_string()
                        } else {
                            "FALSE".to_string()
                        }
                    }
                    pivot_engine::CacheValue::Error(e) => e.to_string(),
                    pivot_engine::CacheValue::Empty => String::new(),
                }
            })
        })
        .filter(|s| !s.is_empty())
        .collect();
    let mut unique_values = unique_values;
    if has_blank {
        unique_values.push(pivot_engine::BLANK_ITEM_LABEL.to_string());
    }

    Ok(unique_values)
}

/// Whether a listed slicer item is in `selection`: by its exact text, and the
/// BLANK item by any spelling of its label (or the empty string a model uses).
fn selection_holds_item(selection: &[String], value: &str) -> bool {
    selection.iter().any(|s| s == value)
        || (pivot_engine::is_blank_item_label(value)
            && selection.iter().any(|s| s.is_empty() || pivot_engine::is_blank_item_label(s)))
}

/// Get values from a pivot field that still have data given cross-slicer filters.
/// Scans the cache records and checks each record against sibling slicer filters.
fn get_pivot_available_values(
    pivot_state: &PivotState,
    source_id: identity::EntityId,
    field_name: &str,
    sibling_filters: &[(String, Vec<String>)],
) -> Result<std::collections::HashSet<String>, String> {
    use pivot_engine::VALUE_ID_EMPTY;

    let pivot_id = source_id;
    let mut pivot_tables = pivot_state.pivot_tables.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::DerivedCache)).unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Find the target field index (supports "table.column" format)
    let target_field_idx = cache
        .fields
        .iter()
        .position(|f| field_name_matches(&f.name, field_name))
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", field_name))?;

    // Resolve sibling filter field indices and their allowed ValueIds
    let filter_specs: Vec<(usize, std::collections::HashSet<String>)> = sibling_filters
        .iter()
        .filter_map(|(field_name, allowed)| {
            cache
                .fields
                .iter()
                .position(|f| field_name_matches(&f.name, field_name))
                .map(|idx| {
                    // Any spelling of the blank item (or a model's empty
                    // NULL spelling) is the one label a blank record reads as.
                    let allowed_set: std::collections::HashSet<String> = allowed
                        .iter()
                        .map(|v| {
                            if v.is_empty() || pivot_engine::is_blank_item_label(v) {
                                pivot_engine::BLANK_ITEM_LABEL.to_string()
                            } else {
                                v.clone()
                            }
                        })
                        .collect();
                    (idx, allowed_set)
                })
        })
        .collect();

    // Helper: convert a cache value to string (same logic as get_pivot_field_values).
    // A BLANK record reads as the blank item's label, the one the slicer lists
    // (`get_pivot_field_values`): a sibling that selects the blank item keeps
    // it, and the blank item has data when a passing record is blank.
    let value_to_string = |field_idx: usize, value_id: pivot_engine::ValueId| -> String {
        if value_id == VALUE_ID_EMPTY {
            return pivot_engine::BLANK_ITEM_LABEL.to_string();
        }
        cache
            .fields
            .get(field_idx)
            .and_then(|f| f.get_value(value_id))
            .map(|value| match value {
                pivot_engine::CacheValue::Number(n) => {
                    if n.0.fract() == 0.0 {
                        format!("{}", n.0 as i64)
                    } else {
                        format!("{}", n.0)
                    }
                }
                pivot_engine::CacheValue::Text(s) => s.to_string(),
                pivot_engine::CacheValue::Boolean(b) => {
                    if *b { "TRUE".to_string() } else { "FALSE".to_string() }
                }
                pivot_engine::CacheValue::Error(e) => e.to_string(),
                pivot_engine::CacheValue::Empty => String::new(),
            })
            .unwrap_or_default()
    };

    let mut available = std::collections::HashSet::new();

    for record in &cache.records {
        // Check if this record passes all sibling filters
        let passes = filter_specs.iter().all(|(field_idx, allowed)| {
            if *field_idx >= record.values.len() {
                return false;
            }
            let value_str = value_to_string(*field_idx, record.values[*field_idx]);
            allowed.contains(&value_str)
        });

        if passes {
            if target_field_idx < record.values.len() {
                let value = value_to_string(target_field_idx, record.values[target_field_idx]);
                if !value.is_empty() {
                    available.insert(value);
                }
            }
        }
    }

    Ok(available)
}
