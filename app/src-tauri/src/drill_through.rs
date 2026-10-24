//! FILENAME: app/src-tauri/src/drill_through.rs
//! PURPOSE: The design-query DRILL-THROUGH of a model visual (a design-query
//!          chart, a BI pivot): ONE command, two ops, over an EPHEMERAL result
//!          sheet. docs/design/model-drillthrough.md, sections 2.5 and 3.
//!
//! - `pivotContext`: the clicked BI-pivot cell's `group_path` as member KEYS --
//!   never labels (CLAUDE.md: the blank member's key is "", its label
//!   "(Blank)") -- in `filters`, and the pivot's own standing filters as keys
//!   in `standing`, kept apart, so the frontend can bake them into the
//!   definition's DSL as one `FILTERS:` clause and apply its chart rule to the
//!   standing ones only; plus the live connection's application data source
//!   (`packageDataSourceId`) for the chart it creates. Labels ride beside the
//!   keys for captions and titles; keys are shown nowhere. A coordinate that
//!   cannot be resolved FAILS the op (a partial path filters on another datum's
//!   member) -- except a measure-only pivot's synthetic "Total" row, which pins
//!   every record and carries nothing; a standing-filter item that resolves to
//!   nothing goes into `notices`, never silently into the DSL.
//! - `toSheet`: the result sheet. A TABLE is a worksheet of static cells (the
//!   definition's name and the caption rows, then the computed view under the
//!   grid report theme, merges kept); a CHART is an empty canvas the frontend
//!   fills with one design-query chart. Either is appended through the ONE add
//!   path, activated, and flagged EPHEMERAL by that add under its own locks
//!   (`sheets::EphemeralUserSheet`: its STABLE id into
//!   `AppState::ephemeral_sheets`), so the tab strip discards it by id when the
//!   user leaves it (`sheets::discard_ephemeral_sheet`) unless they keep it
//!   (`sheets::keep_ephemeral_sheet`).
//!
//! Precedents mirrored line for line: `pivot::commands::drill_through_to_sheet_core`
//! (the structure gate first, the detached grid, the add through
//! `append_user_sheet`, the undo reset, the dependency rebuild) and
//! `show_report_filter_pages_core` (a styled pivot VIEW written into a detached
//! grid under the style registry alone, the effect minted after every refusal
//! that runs before a write). The pivot read mirrors `bi_pivot_filtered_view`:
//! `pivot_tables` THEN `bi_metadata`, both released before returning.
//!
//! No audit row for a run (2.11): the trail spans script activity and
//! capability calls, not user actions -- the same standing as `run_design_query`.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::api_types::MemberRef;
use crate::bi::types::{BiState, ConnectionId};
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::pivot::headless::DesignQueryRequest;
use crate::pivot::types::{PivotNotice, PivotState};
use crate::AppState;

/// The drill-through's name for itself in a refusal ("Cannot add a
/// drill-through sheet while the workbook structure is protected").
pub(crate) const DRILL_THROUGH_SHEET_ACTION: &str = "add a drill-through sheet";

/// Safety cap on the rows a table drill materializes -- the grid report's cap
/// (`report::MAX_REPORT_ROWS`), so a runaway query cannot fill a sheet.
const MAX_DRILL_ROWS: usize = 100_000;

/// The result sheet's name when the definition has none, or one the sheet
/// name rule refuses. A sheet name is a proper noun, as "DrillThrough" was.
const DEFAULT_SHEET_BASE: &str = "Drillthrough";

/// The first row a table's view may start on: row 0 is the name, row 1 the
/// first caption line, row 2 blank. More caption lines push the view down
/// (see [`view_origin`]).
const MIN_VIEW_ROW: u32 = 3;

/// Where a table's view starts below `caption_lines` caption lines: the name
/// at row 0, the lines verbatim from row 1, one blank spacer row, then the
/// view -- never above row 3, so a drill with no caption has the same shape
/// as one with a single line.
fn view_origin(caption_lines: usize) -> (u32, u32) {
    let lines = u32::try_from(caption_lines).unwrap_or(u32::MAX - 2);
    (MIN_VIEW_ROW.max(lines.saturating_add(2)), 0)
}

/// The refusal when the ACTIVE sheet is itself ephemeral. The frontend
/// discards (or keeps) first (`runDrillThrough`, 2.7 "drill-from-drill"); this
/// is the guard behind it, because a `delete_sheet` racing the new sheet's
/// chart save renumbers the chart into the object tail.
pub(crate) const EPHEMERAL_ACTIVE_REFUSAL: &str =
    "Keep or leave the temporary sheet first: a drill-through cannot start from a sheet that closes when you leave it.";

/// The refusal when the active sheet BECAME ephemeral while this drill ran:
/// the guard above passed, then another drill landed its own temporary sheet
/// (a chart drill needs no query, so it can finish while a table drill waits
/// on the model). Said as what happened -- this drill did not start from a
/// temporary sheet, so the refusal above would be untrue. Answered by the
/// re-check after the query and, authoritatively, inside the add's critical
/// section (`sheets::EphemeralUserSheet`).
pub(crate) const CONCURRENT_DRILL_REFUSAL: &str =
    "Another drill-through opened a temporary sheet while this one was running: keep or leave that sheet, then drill again.";

// ============================================================================
// WIRE TYPES
// ============================================================================

/// The result of a `toSheet` drill: static cells on a worksheet, or an empty
/// canvas for one design-query chart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DrillSheetPresentation {
    Table,
    Chart,
}

/// What `drill_through` is asked. Tagged on `op`
/// (`{"op":"pivotContext",...}` / `{"op":"toSheet",...}`), every field camelCase.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DrillThroughRequest {
    /// The clicked BI-pivot cell as member keys, plus the pivot's standing
    /// filters as keys.
    PivotContext {
        pivot_id: pivot_engine::PivotId,
        /// `(cache field index, value id)` pairs, as `PivotCellData.group_path`
        /// carries them: a blank member is `VALUE_ID_BLANK`.
        group_path: Vec<(usize, u32)>,
    },
    /// The result sheet.
    ToSheet {
        /// The BASE of the new sheet's name, through the sheet name rule (the
        /// frontend sends the definition's name already cut to a legal sheet
        /// name); "Drillthrough" when blank or refused. Also the table's
        /// title when `title` is absent or blank.
        name: String,
        /// The definition's NAME as the author wrote it (up to 80 characters,
        /// any character), written in bold at (0,0) of a table -- the sheet
        /// name is a cleaned-up, cut copy of it and is no title. Absent or
        /// blank: the table is titled with `name`.
        #[serde(default)]
        title: Option<String>,
        presentation: DrillSheetPresentation,
        /// The compiled query, with every filter baked in; a table needs it,
        /// a chart (dry-run by the frontend) sends none.
        #[serde(default)]
        query: Option<DesignQueryRequest>,
        /// The caption: COMPLETE lines the frontend wrote for the app locale
        /// ("Filtered to: ...", "Not carried: ..."), in LABELS, never keys.
        /// Written verbatim, one per row from row 1, under the name.
        #[serde(default)]
        caption: Vec<String>,
    },
}

/// What `drill_through` answers; tagged on `op` like the request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DrillThroughResponse {
    PivotContext {
        /// The pivot's connection -- `ConnectionId::ZERO` after a `.cala` load
        /// until the user reconnects; the frontend TELLS that, never queries it.
        connection_id: ConnectionId,
        /// The LIVE connection's application data source
        /// (`Connection.package_data_source_id`): present on a subscriber's or
        /// a working copy's connection, which is re-minted on every open, so a
        /// chart the drill creates can carry the key the open-path remap
        /// re-binds it by (2.10). Absent for a local connection, and for a
        /// connection that is not live (ZERO).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        package_data_source_id: Option<String>,
        /// The CLICKED PATH only, one spec per resolved coordinate of the
        /// cell's group path, in path order. A measure-only pivot's synthetic
        /// "Total" row coordinate pins every record and contributes NO spec,
        /// so a caller must never slice this by the group path's length.
        filters: Vec<DrillFilterSpec>,
        /// The pivot's OWN standing filters as keys: its pinned engine filters,
        /// then the hidden items of its row / column / filter-area fields and
        /// slicer filters. Kept apart from the path so the frontend can apply
        /// its chart rule (2.4: a workbook-wide filter re-applies live on the
        /// new page and is not baked) to these and never to the datum.
        #[serde(default)]
        standing: Vec<DrillFilterSpec>,
        notices: Vec<PivotNotice>,
    },
    ToSheet {
        sheet_index: usize,
        sheet_name: String,
        /// The new sheet's STABLE id, the key the tab strip discards it by.
        sheet_id: String,
        /// Visible rows of the view a table wrote; 0 for a chart.
        row_count: u32,
        col_count: u32,
    },
}

/// One filter the drill carries, on member KEYS. Mirrored by `DrillFilterSpec`
/// in `app/src/api/drillThrough.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillFilterSpec {
    /// "Table.Column", the model's spelling.
    pub field: String,
    /// Keep these members (`= (...)`); an EMPTY list keeps nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub included_keys: Option<Vec<String>>,
    /// Hide these members (`NOT IN (...)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_keys: Option<Vec<String>>,
    /// The app-locale labels of `included_keys`, PARALLEL to it -- present only
    /// when every key resolved to a label, so the two never misalign.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
}

// ============================================================================
// THE COMMAND
// ============================================================================

/// The model-visual drill-through: `pivotContext` resolves a BI pivot cell to
/// member keys; `toSheet` lands a result on a new EPHEMERAL sheet. Feature-open
/// (no dangerous prefix). Holds `PivotState` for the first op (and `BiState`
/// only to read the live connection's package key, after the pivot guards are
/// released) and `BiState` for the second; it edits one pivot's nothing and
/// replaces no document (`document_store_census_tests::NOT_DOCUMENT_REPLACING`).
#[tauri::command]
pub async fn drill_through(
    state: State<'_, AppState>,
    file_state: State<'_, FileState>,
    pivot_state: State<'_, PivotState>,
    bi_state: State<'_, BiState>,
    request: DrillThroughRequest,
) -> Result<DrillThroughResponse, String> {
    match request {
        DrillThroughRequest::PivotContext { pivot_id, group_path } => {
            pivot_context_core(&state, &pivot_state, &bi_state, pivot_id, &group_path)
        }
        DrillThroughRequest::ToSheet { name, title, presentation, query, caption } => {
            drill_through_to_ephemeral_sheet_core(
                &state,
                &file_state,
                &bi_state,
                &name,
                title.as_deref(),
                presentation,
                query,
                &caption,
            )
            .await
        }
    }
}

// ============================================================================
// OP 1: pivotContext
// ============================================================================

/// The body of the `pivotContext` op, over plain references.
///
/// Reads `pivot_tables` THEN `bi_metadata` (the crate's order, as
/// `bi_pivot_filtered_view`), both held only inside the pivot block and
/// released at its end; the app locale (`state.locale`, a leaf) is taken,
/// cloned and dropped FIRST. Only after the block is the live connection read,
/// alone, for its application data source -- never nested under a pivot guard.
///
/// What it carries, as KEYS (2.4 c), the clicked path (`filters`) and the
/// pivot's own standing filters (`standing`) kept apart:
/// - the clicked datum's path -- every coordinate must resolve, or the op
///   fails -- except a measure-only pivot's synthetic "Total" row, which pins
///   every record and is skipped (`pivot::utils::is_synthetic_total_row`, the
///   one test `bi_request_from_definition` uses too);
/// - the pivot's PINNED engine filters (`engine_filters.selected_items`), which
///   are IN-list keys already;
/// - the row / column / filter-area fields' `hidden_items` and the pivot's
///   slicer filters, DISPLAY-or-key strings resolved through the pivot's cache
///   exactly as the engine resolves them (`pivot_engine::hidden_member_ids`)
///   and then spelled as keys (`member_key_of`). An item that resolves to
///   nothing is reported in `notices` and never carried.
pub(crate) fn pivot_context_core(
    state: &AppState,
    pivot_state: &PivotState,
    bi_state: &BiState,
    pivot_id: pivot_engine::PivotId,
    group_path: &[(usize, u32)],
) -> Result<DrillThroughResponse, String> {
    let locale = crate::pivot::utils::display_locale_of(state);

    // THE PIVOT BLOCK: both pivot guards live only inside it.
    let (connection_id, path, standing, notices) = {
        let pivot_tables = pivot_state
            .pivot_tables
            .read()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        let (definition, cache) = pivot_tables
            .get(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
        let bi_meta = pivot_state
            .bi_metadata
            .read()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        let meta = bi_meta.get(&pivot_id).ok_or_else(|| {
            format!(
                "Pivot {} is not a data-model pivot: only a data-model pivot has a design-query drill-through",
                pivot_id
            )
        })?;

        let field_keys = crate::pivot::utils::bi_placed_field_keys(definition, meta);
        let table_names: Vec<&str> = meta.model_tables.iter().map(|t| t.name.as_str()).collect();
        let mut path: Vec<DrillFilterSpec> = Vec::new();
        let mut standing: Vec<DrillFilterSpec> = Vec::new();
        let mut notices: Vec<PivotNotice> = Vec::new();

        // (a) THE CLICKED DATUM. Every coordinate resolves or the op fails: a
        // partial path would filter on another datum's member and present the
        // answer as this one's.
        for &(field_index, value_id) in group_path {
            // A measure-only pivot's synthetic "Total" row (`update_bi_pivot_fields`
            // places it when no dimension is on rows) holds ONE member that every
            // record has: padding, not part of the datum, so it filters nothing and
            // carries no spec. It is still checked against the cache, so a stale
            // path against a rebuilt cache keeps failing. A calculation group named
            // "Total" is not this field (the shared test says so) and is refused
            // below like any other coordinate that is not a model column.
            if crate::pivot::utils::is_synthetic_total_row(definition, meta, field_index) {
                if member_of(cache, field_index, value_id, &locale).is_none() {
                    return Err(
                        "The drilled cell's total row could not be resolved; refresh the PivotTable and try again.".to_string(),
                    );
                }
                continue;
            }
            let field = model_field_of(&field_keys, &table_names, field_index, cache.field_name(field_index).as_deref())
                .ok_or_else(|| {
                    format!(
                        "The drilled cell names a field ({}) that is not a model column of this PivotTable; refresh it and try again.",
                        cache.field_name(field_index).unwrap_or_else(|| format!("#{}", field_index))
                    )
                })?;
            let member = member_of(cache, field_index, value_id, &locale).ok_or_else(|| {
                format!(
                    "The drilled cell's member of {} could not be resolved; refresh the PivotTable and try again.",
                    field
                )
            })?;
            path.push(DrillFilterSpec {
                field,
                included_keys: Some(vec![member.key]),
                hidden_keys: None,
                labels: Some(vec![member.label]),
            });
        }

        // (c) THE STANDING FILTERS. Pinned engine filters first: their
        // `selected_items` are the engine's IN-list keys already
        // (`apply_pivot_filter` and the page slicers write them so).
        for ef in &definition.engine_filters {
            let field = if ef.table.is_empty() {
                ef.field_name.clone()
            } else {
                format!("{}.{}", ef.table, ef.column)
            };
            let labels = labels_for_keys(cache, &field_keys, &field, &ef.selected_items, &locale);
            standing.push(DrillFilterSpec {
                field,
                included_keys: Some(ef.selected_items.clone()),
                hidden_keys: None,
                labels,
            });
        }

        // Then every hidden-items list: the axis fields, the filter area and the
        // slicer filters. `hidden_items` is "the string representation of hidden
        // values" -- the DISPLAY spelling for a filter the user ticked ("5.5"),
        // the KEY for one a slicer wrote ("5.50") -- and an engine IN-list matches
        // keys only, so each item is resolved the way the engine resolves it and
        // re-spelled as its key.
        struct HiddenList<'a> {
            source_index: usize,
            name: Option<&'a str>,
            items: &'a [String],
        }
        let hidden_lists = definition
            .row_fields
            .iter()
            .chain(definition.column_fields.iter())
            .chain(definition.filter_fields.iter().map(|f| &f.field))
            .filter(|f| !f.hidden_items.is_empty())
            .map(|f| HiddenList { source_index: f.source_index, name: Some(f.name.as_str()), items: &f.hidden_items })
            .chain(
                definition
                    .slicer_filters
                    .iter()
                    .filter(|s| !s.hidden_items.is_empty())
                    .map(|s| HiddenList { source_index: s.source_index, name: s.model_key.as_deref(), items: &s.hidden_items }),
            );
        for list in hidden_lists {
            let shown = list
                .name
                .map(|n| n.to_string())
                .or_else(|| cache.field_name(list.source_index))
                .unwrap_or_else(|| format!("field #{}", list.source_index));
            let Some(field) = model_field_of(&field_keys, &table_names, list.source_index, list.name) else {
                notices.push(PivotNotice::degraded(format!(
                    "The filter on {} could not be carried into the drill-through: it is not a model column.",
                    shown
                )));
                continue;
            };
            let Some(field_cache) = cache.get_field(list.source_index) else {
                notices.push(PivotNotice::degraded(format!(
                    "The filter on {} could not be carried into the drill-through: the PivotTable's data has no such field.",
                    field
                )));
                continue;
            };
            let mut hidden_keys: Vec<String> = Vec::new();
            let mut lost = 0usize;
            for item in list.items {
                // One item at a time, so a lost one can be told from a carried one.
                let ids = pivot_engine::hidden_member_ids(field_cache, std::slice::from_ref(item));
                if ids.is_empty() {
                    lost += 1;
                    continue;
                }
                for id in ids {
                    if let Some(key) = crate::pivot::utils::member_key_of(cache, list.source_index, id) {
                        if !hidden_keys.contains(&key) {
                            hidden_keys.push(key);
                        }
                    }
                }
            }
            if lost > 0 {
                notices.push(PivotNotice::degraded(format!(
                    "The filter on {} was carried into the drill-through only in part: {} of its {} items name no member of the PivotTable's data.",
                    field,
                    lost,
                    list.items.len()
                )));
            }
            if !hidden_keys.is_empty() {
                standing.push(DrillFilterSpec { field, included_keys: None, hidden_keys: Some(hidden_keys), labels: None });
            }
        }

        (meta.connection_id, path, standing, notices)
    }; // both pivot guards released here

    // From the LIVE connection, not the pivot's stored `data_source_id`: on the
    // authoring machine that field holds the local connection's uuid, which no
    // reopen can re-bind by, and a local connection must carry no key at all.
    let package_data_source_id = bi_state
        .connections
        .lock()
        .map_err(|e| format!("connections lock poisoned: {}", e))?
        .get(&connection_id)
        .and_then(|c| c.package_data_source_id.clone());
    Ok(DrillThroughResponse::PivotContext { connection_id, package_data_source_id, filters: path, standing, notices })
}

/// The "Table.Column" of cache field `field_index`: the placed field's key
/// (`bi_placed_field_keys`), else `fallback_name` -- in either case split at
/// the model's own table names (`split_bi_field_key`, because a table name can
/// contain a dot) and accepted only when the table is one the pivot's model
/// snapshot lists. `None` is "not a model column".
fn model_field_of(
    field_keys: &[(usize, String)],
    table_names: &[&str],
    field_index: usize,
    fallback_name: Option<&str>,
) -> Option<String> {
    let name = field_keys
        .iter()
        .find(|(fi, _)| *fi == field_index)
        .map(|(_, key)| key.as_str())
        .or(fallback_name)?;
    let (table, column) = crate::pivot::commands::split_bi_field_key(name, table_names.iter().copied());
    if table.is_empty() || column.is_empty() || !table_names.iter().any(|t| *t == table) {
        return None;
    }
    Some(format!("{}.{}", table, column))
}

/// The member `{ key, label }` of `value_id` in cache field `field_index`:
/// the blank member (`VALUE_ID_BLANK` in a group path) is `MemberRef::blank()`
/// -- key "", label "(Blank)" (ruling Q8) -- and an id the field never
/// interned (a stale path against a rebuilt cache) is `None`, never
/// `member_key`'s "(unknown)" spelling.
fn member_of(
    cache: &pivot_engine::PivotCache,
    field_index: usize,
    value_id: u32,
    locale: &engine::LocaleSettings,
) -> Option<MemberRef> {
    let field = cache.get_field(field_index)?;
    if pivot_engine::is_blank_member_id(value_id) {
        return Some(MemberRef::blank());
    }
    if !field.label_map.contains_key(&value_id) && field.get_value(value_id).is_none() {
        return None;
    }
    crate::pivot::utils::member_ref(cache, field_index, value_id, locale)
}

/// The app-locale labels of `keys` on the placed field spelled `field`,
/// PARALLEL to `keys`: `Some` only when EVERY key resolved (a field the pivot
/// does not place has no cache column to resolve against, and a key the cache
/// never interned has no label), so the caption can never pair a label with
/// the wrong key.
fn labels_for_keys(
    cache: &pivot_engine::PivotCache,
    field_keys: &[(usize, String)],
    field: &str,
    keys: &[String],
    locale: &engine::LocaleSettings,
) -> Option<Vec<String>> {
    let (field_index, _) = field_keys.iter().find(|(_, key)| key == field)?;
    let field_cache = cache.get_field(*field_index)?;
    let mut labels = Vec::with_capacity(keys.len());
    for key in keys {
        if pivot_engine::is_blank_member_key(key) {
            labels.push(MemberRef::blank().label);
            continue;
        }
        let id = (0..field_cache.unique_count() as u32).find(|&id| field_cache.member_key(id) == *key)?;
        labels.push(crate::pivot::utils::member_ref(cache, *field_index, id, locale)?.label);
    }
    Some(labels)
}

// ============================================================================
// OP 2: toSheet
// ============================================================================

/// The body of the `toSheet` op, over plain references -- ONE left-margin
/// function on purpose: the add-path census
/// (`undo_sheet_structure_tests::every_caller_of_the_one_add_path_ends_what_the_add_path_leaves_to_it`)
/// charges the `activate: true`, the undo reset and the dependency rebuild to
/// the function that calls `append_user_sheet`, and they are all here.
///
/// Order (2.5): the structure gate -> REFUSE when the active sheet is
/// ephemeral -> a table's query, awaited with NO std lock held -> the row cap
/// -> BOTH gates AGAIN (the query can take long; Protect Workbook Structure
/// turned on, or another drill's temporary sheet landed, in the meantime is
/// refused here, before anything is written, so the document stays clean) ->
/// `DocumentEffect::mutates` -> the title, the caption and the view into a
/// DETACHED grid under the style registry alone (released before the add) ->
/// `append_user_sheet` (activated, EPHEMERAL: the add itself refuses when the
/// active sheet is ephemeral at that moment and puts the new id into
/// `ephemeral_sheets` under its own locks, so no check-then-flag window is
/// left) -> the view's merges -> the undo history ends -> the dependency maps
/// are rebuilt for the sheet it switched to. A chart: the same with an empty
/// canvas and no query.
///
/// `name` is the sheet name's BASE; `title` the definition's own name, which a
/// table writes in bold at (0,0) -- `name` when it is absent or blank.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn drill_through_to_ephemeral_sheet_core(
    state: &AppState,
    file_state: &FileState,
    bi_state: &BiState,
    name: &str,
    title: Option<&str>,
    presentation: DrillSheetPresentation,
    query: Option<DesignQueryRequest>,
    caption: &[String],
) -> Result<DrillThroughResponse, String> {
    // Refused before the query runs: the sheet could never be added.
    crate::protection::check_workbook_structure(state, DRILL_THROUGH_SHEET_ACTION)?;
    if active_sheet_is_ephemeral(state) {
        return Err(EPHEMERAL_ACTIVE_REFUSAL.to_string());
    }

    // A TABLE computes its view first, with no std lock held across the
    // await: a failing query leaves the document clean and adds no sheet.
    let computed = match presentation {
        DrillSheetPresentation::Table => {
            let query = query.ok_or_else(|| "A table drill-through needs its compiled query.".to_string())?;
            let (_def, _cache, view) = crate::pivot::headless::compute_design_query_view(bi_state, &query).await?;
            let visible_rows = view.rows.iter().filter(|r| r.visible).count();
            if visible_rows > MAX_DRILL_ROWS {
                return Err(format!(
                    "This drill-through has {} rows, over the {} row cap. Add filters to narrow it.",
                    visible_rows, MAX_DRILL_ROWS
                ));
            }
            Some((view, visible_rows))
        }
        DrillSheetPresentation::Chart => None,
    };

    // THE GATES AGAIN, after the await and the cap and before the effect: the
    // checks above ran before the query, and the world can change while it
    // runs. Protect Workbook Structure turned on meanwhile would otherwise be
    // refused only by the add -- AFTER this drill's effect had dirtied the
    // document and its styles were registered for a sheet that never came.
    // And a temporary sheet another drill landed meanwhile is refused with
    // what happened; the add re-decides that one under its own locks.
    crate::protection::check_workbook_structure(state, DRILL_THROUGH_SHEET_ACTION)?;
    if active_sheet_is_ephemeral(state) {
        return Err(CONCURRENT_DRILL_REFUSAL.to_string());
    }

    let base = sheet_name_base(name);
    let title = table_title(title, name);

    // Past every refusal that runs before a write. The table's cells go into
    // a DETACHED grid under the style registry alone, which is released before
    // the add (lock order grid -> grids -> style_registry; `append_user_sheet`
    // takes the first two). This effect covers the registry and the merges;
    // the add path mints its own. A chart writes nothing here, so it mints
    // nothing here.
    let (cells, kind, merges, effect, row_count, col_count) = match computed {
        Some((view, visible_rows)) => {
            let effect = DocumentEffect::mutates(file_state);
            let mut grid = engine::Grid::new();
            let merges = {
                let mut styles = state
                    .style_registry
                    .write(&effect)
                    .map_err(|e| format!("style_registry lock poisoned: {}", e))?;
                // Caption rows: the definition's name (its `title`), bold,
                // then the frontend's caption lines VERBATIM, one per row (it
                // writes complete sentences in LABELS for the app locale;
                // prefixing here doubled them).
                let bold = styles.get_or_create(engine::CellStyle::new().with_bold(true));
                grid.set_cell(
                    0,
                    0,
                    engine::Cell { ast: None, value: engine::CellValue::Text(title.to_string()), style_index: bold, rich_text: None },
                );
                for (i, line) in caption.iter().enumerate() {
                    let row = u32::try_from(i + 1).unwrap_or(u32::MAX);
                    grid.set_cell(row, 0, engine::Cell::new_text(line.clone()));
                }
                crate::pivot::operations::write_pivot_to_grid(
                    &mut grid,
                    None,
                    &view,
                    view_origin(caption.len()),
                    &mut styles,
                    &crate::pivot::grid_theme::PivotGridTheme::default_style(),
                )
            };
            (
                Some(grid),
                ::persistence::SheetKind::Worksheet,
                merges,
                Some(effect),
                visible_rows as u32,
                view.col_count as u32,
            )
        }
        None => (None, ::persistence::SheetKind::new_canvas(), Vec::new(), None, 0, 0),
    };

    // The sheet goes in through the ONE add path, created AND switched to: it
    // owns every per-sheet store, the user/object partition, the stash of the
    // sheet being left and the workbook-structure gate -- and, for an
    // EPHEMERAL sheet, the last word on "the active sheet is temporary" and
    // the flag itself, both under the add's own locks. A refusal there comes
    // after this drill's effect (a table's), which is the lesser harm: the
    // re-check above already refused the common case cleanly.
    let added = crate::sheets::append_user_sheet(
        state,
        file_state,
        crate::sheets::EphemeralUserSheet {
            sheet: crate::sheets::NewUserSheet {
                name: crate::sheets::NewSheetName::FirstFree(base),
                kind,
                cells,
                activate: true,
            },
            refusal: CONCURRENT_DRILL_REFUSAL,
        },
        DRILL_THROUGH_SHEET_ACTION,
    )?;
    // The view's merges (a COLUMNS: header spans), which the filter-pages
    // precedent discarded. The add left the new sheet's merge set empty.
    if let Some(effect) = effect.as_ref() {
        if !merges.is_empty() {
            crate::report::with_sheet_merges_mut(state, effect, added.index, |set| {
                for region in merges {
                    set.insert(region);
                }
            });
        }
    }

    // Excel parity (BUG-0005), as `add_sheet`: a new sheet ends the undo
    // history. And the new sheet is ACTIVE, so the single-sheet dependency
    // maps are rebuilt for it (BUG-0016). Both with every lock released.
    crate::sheets::invalidate_undo_history_for_sheet_structure(state, DRILL_THROUGH_SHEET_ACTION);
    crate::undo_commands::rebuild_all_dependencies(state);

    Ok(DrillThroughResponse::ToSheet {
        sheet_index: added.index,
        sheet_name: added.name,
        // The id the add minted and flagged, never re-read by index after its
        // locks were released.
        sheet_id: added.sheet_id.to_string(),
        row_count,
        col_count,
    })
}

/// The bold title a table writes at (0,0): the definition's own name when the
/// frontend sent one that is not blank, else the sheet-name base `name`, else
/// "Drillthrough" -- the same fallback a blank title had before there was a
/// title, never spaces written into A1.
fn table_title<'a>(title: Option<&'a str>, name: &'a str) -> &'a str {
    title.map(str::trim).filter(|t| !t.is_empty()).unwrap_or_else(|| {
        let name = name.trim();
        if name.is_empty() {
            DEFAULT_SHEET_BASE
        } else {
            name
        }
    })
}

/// Is the ACTIVE sheet ephemeral? `active_sheet` and `sheet_ids` are read as
/// temporaries released with their statements; the leaf set is taken alone.
fn active_sheet_is_ephemeral(state: &AppState) -> bool {
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
    let active_id = state.sheet_ids.read().ok().and_then(|ids| ids.get(active).copied());
    match active_id {
        Some(id) => state.ephemeral_sheets.lock().map(|set| set.contains(&id)).unwrap_or(false),
        None => false,
    }
}

/// The base of the result sheet's name: the definition's name through the
/// sheet name rule (`validate_sheet_name`, Excel's), else "Drillthrough".
/// `NewSheetName::FirstFree` then takes `base`, `base2`, `base3`, ...
fn sheet_name_base(name: &str) -> String {
    crate::sheet_names::validate_sheet_name(name.trim()).unwrap_or_else(|_| DEFAULT_SHEET_BASE.to_string())
}

/// The ids currently flagged ephemeral, for tests and diagnostics.
#[cfg(test)]
pub(crate) fn ephemeral_ids(state: &AppState) -> std::collections::HashSet<identity::SheetId> {
    crate::sheets::ephemeral_sheet_ids(state)
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_effect::test_seed_effect;
    use crate::pivot::types::{BiModelColumnMeta, BiModelTableMeta, BiPivotMetadata};
    use engine::CellValue;
    use pivot_engine::{
        EngineFilter, FilterCondition, PivotCache, PivotDefinition, PivotField, PivotFilter, SlicerFilter,
        VALUE_ID_BLANK,
    };
    use std::collections::{HashMap, HashSet};

    fn new_id() -> identity::EntityId {
        identity::EntityId::from_bytes(identity::generate_uuid_v7())
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // ------------------------------------------------------------------
    // The wire shapes (the contract the TypeScript side builds against)
    // ------------------------------------------------------------------

    #[test]
    fn request_ops_parse_camel_case_and_default_the_optional_fields() {
        let id = new_id();
        let json = format!(r#"{{"op":"pivotContext","pivotId":"{}","groupPath":[[0,7],[2,4294967294]]}}"#, id);
        let request: DrillThroughRequest = serde_json::from_str(&json).expect("pivotContext parses");
        match request {
            DrillThroughRequest::PivotContext { pivot_id, group_path } => {
                assert_eq!(pivot_id, id);
                assert_eq!(group_path, vec![(0, 7), (2, VALUE_ID_BLANK)]);
            }
            other => panic!("expected pivotContext, got {other:?}"),
        }

        let json = r#"{"op":"toSheet","name":"Region detail","presentation":"chart"}"#;
        let request: DrillThroughRequest = serde_json::from_str(json).expect("toSheet parses without query/caption");
        match request {
            DrillThroughRequest::ToSheet { name, title, presentation, query, caption } => {
                assert_eq!(name, "Region detail");
                assert!(title.is_none(), "an absent title defaults to None");
                assert_eq!(presentation, DrillSheetPresentation::Chart);
                assert!(query.is_none());
                assert!(caption.is_empty());
            }
            other => panic!("expected toSheet, got {other:?}"),
        }

        let conn = new_id();
        let json = format!(
            r#"{{"op":"toSheet","name":"x","title":"Revenue by region / channel","presentation":"table","caption":["Region: East"],
                 "query":{{"connectionId":"{}","valueFields":[{{"measureName":"Revenue"}}],
                 "pageFilterFields":[{{"table":"Sales","column":"region","includedItems":["East"]}}]}}}}"#,
            conn
        );
        let request: DrillThroughRequest = serde_json::from_str(&json).expect("toSheet with a query parses");
        match request {
            DrillThroughRequest::ToSheet { title, presentation, query, caption, .. } => {
                assert_eq!(title.as_deref(), Some("Revenue by region / channel"), "the title rides as camelCase `title`");
                assert_eq!(presentation, DrillSheetPresentation::Table);
                let query = query.expect("query present");
                assert_eq!(query.connection_id, conn);
                assert_eq!(query.page_filter_fields[0].included_items, Some(strings(&["East"])));
                assert_eq!(caption, strings(&["Region: East"]));
            }
            other => panic!("expected toSheet, got {other:?}"),
        }

        // snake_case is NOT the wire: a snake-spelled key is an unknown field,
        // and the required one is then missing.
        let snake = r#"{"op":"toSheet","name":"x","presentation":"chart","sheet_index":1}"#;
        assert!(serde_json::from_str::<DrillThroughRequest>(snake).is_ok(), "unknown keys are ignored");
        let bad_op = r#"{"op":"pivot_context","pivotId":"00000000-0000-0000-0000-000000000000","groupPath":[]}"#;
        assert!(serde_json::from_str::<DrillThroughRequest>(bad_op).is_err(), "the op tag is camelCase");
    }

    #[test]
    fn responses_serialize_camel_case_with_the_op_tag() {
        let conn = new_id();
        let response = DrillThroughResponse::PivotContext {
            connection_id: conn,
            package_data_source_id: None,
            filters: vec![DrillFilterSpec {
                field: "Sales.region".into(),
                included_keys: Some(strings(&["East"])),
                hidden_keys: None,
                labels: Some(strings(&["East"])),
            }],
            standing: vec![DrillFilterSpec {
                field: "Sales.year".into(),
                included_keys: None,
                hidden_keys: Some(strings(&["Y1"])),
                labels: None,
            }],
            notices: vec![PivotNotice::degraded("x")],
        };
        let json = serde_json::to_value(&response).expect("serialize");
        assert_eq!(json["op"], "pivotContext");
        assert_eq!(json["connectionId"], conn.to_string());
        assert!(json.get("packageDataSourceId").is_none(), "a local connection's absent key is skipped: {json}");
        // The clicked path and the standing filters ride in two arrays.
        assert_eq!(json["filters"].as_array().map(Vec::len), Some(1), "{json}");
        assert_eq!(json["filters"][0]["field"], "Sales.region");
        assert_eq!(json["filters"][0]["includedKeys"][0], "East");
        assert_eq!(json["filters"][0]["labels"][0], "East");
        assert!(json["filters"][0].get("hiddenKeys").is_none(), "None is skipped: {json}");
        assert_eq!(json["standing"].as_array().map(Vec::len), Some(1), "{json}");
        assert_eq!(json["standing"][0]["field"], "Sales.year");
        assert_eq!(json["standing"][0]["hiddenKeys"][0], "Y1");
        assert!(json["standing"][0].get("includedKeys").is_none(), "None is skipped: {json}");
        assert!(json["standing"][0].get("labels").is_none(), "None is skipped: {json}");
        assert_eq!(json["notices"][0]["kind"], "degraded");
        assert_eq!(json["notices"][0]["message"], "x");
        let text = json.to_string();
        for snake in ["connection_id", "included_keys", "hidden_keys", "sheet_index", "package_data_source_id"] {
            assert!(!text.contains(snake), "snake_case {snake} leaked: {text}");
        }
        // An application connection's key rides as camelCase and round-trips.
        let response = DrillThroughResponse::PivotContext {
            connection_id: conn,
            package_data_source_id: Some("ds-sales".into()),
            filters: vec![],
            standing: vec![],
            notices: vec![],
        };
        let json = serde_json::to_value(&response).expect("serialize");
        assert_eq!(json["packageDataSourceId"], "ds-sales", "{json}");
        let back: DrillThroughResponse = serde_json::from_value(json).expect("deserialize");
        assert!(
            matches!(back, DrillThroughResponse::PivotContext { package_data_source_id: Some(ref k), .. } if k == "ds-sales"),
            "{back:?}"
        );

        let response = DrillThroughResponse::ToSheet {
            sheet_index: 3,
            sheet_name: "Region detail".into(),
            sheet_id: "abc".into(),
            row_count: 12,
            col_count: 4,
        };
        let json = serde_json::to_value(&response).expect("serialize");
        assert_eq!(json["op"], "toSheet");
        assert_eq!(json["sheetIndex"], 3);
        assert_eq!(json["sheetName"], "Region detail");
        assert_eq!(json["sheetId"], "abc");
        assert_eq!(json["rowCount"], 12);
        assert_eq!(json["colCount"], 4);
        // Round trip, so a test double on either side can read what the other wrote.
        let back: DrillThroughResponse = serde_json::from_value(json).expect("deserialize");
        assert!(matches!(back, DrillThroughResponse::ToSheet { sheet_index: 3, .. }));
    }

    // ------------------------------------------------------------------
    // pivotContext over a hand-built BI pivot (no engine needed)
    // ------------------------------------------------------------------

    fn column(name: &str) -> BiModelColumnMeta {
        BiModelColumnMeta {
            name: name.to_string(),
            data_type: "string".to_string(),
            is_numeric: false,
            lookup_resolution: None,
            sort_by_column: None,
            is_context_column: false,
            is_writeback_column: false,
            description: None,
        }
    }

    fn bi_meta(connection_id: ConnectionId) -> BiPivotMetadata {
        BiPivotMetadata {
            connection_id,
            data_source_id: None,
            model_tables: vec![BiModelTableMeta {
                name: "Sales".to_string(),
                columns: vec![column("region"), column("year"), column("channel"), column("price")],
            }],
            measures: vec![],
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

    /// region year channel price   (field 3 is a Decimal(…,2) column: key
    /// "5.50", display "5.5")
    /// East   Y1   Web     5.5
    /// West   Y1   Store   10
    /// East   Y2   Web     5.5
    fn sales_cache(id: pivot_engine::PivotId) -> PivotCache {
        let mut cache = PivotCache::new(id, 4);
        cache.set_field_name(0, "Sales.region".to_string());
        cache.set_field_name(1, "Sales.year".to_string());
        cache.set_field_name(2, "Sales.channel".to_string());
        cache.set_field_name(3, "Sales.price".to_string());
        let text = |s: &str| CellValue::Text(s.to_string());
        cache.add_record(0, &[text("East"), text("Y1"), text("Web"), CellValue::Number(5.5)]);
        cache.add_record(1, &[text("West"), text("Y1"), text("Store"), CellValue::Number(10.0)]);
        cache.add_record(2, &[text("East"), text("Y2"), text("Web"), CellValue::Number(5.5)]);
        cache.fields[3].member_kind = pivot_engine::MemberKind::Decimal { scale: 2 };
        cache
    }

    /// A BI pivot: region on rows, year on columns hiding "Y1", price in the
    /// filter area hiding "5.5" (DISPLAY spelling) and "Nope" (nothing), a
    /// PINNED engine filter on year keeping "Y2", and a slicer filter on the
    /// unplaced channel column hiding "Store".
    fn fixture() -> (AppState, PivotState, pivot_engine::PivotId, ConnectionId) {
        let state = crate::create_app_state();
        let pivots = PivotState::new();
        let id = new_id();
        let conn = new_id();
        let cache = sales_cache(id);
        let mut def = PivotDefinition::new(id, (0, 0), (0, 0));
        def.row_fields.push(PivotField::new(0, "Sales.region".to_string()));
        let mut year = PivotField::new(1, "Sales.year".to_string());
        year.hidden_items = strings(&["Y1"]);
        def.column_fields.push(year);
        let mut price = PivotField::new(3, "Sales.price".to_string());
        price.hidden_items = strings(&["5.5", "Nope"]);
        def.filter_fields.push(PivotFilter { field: price, condition: FilterCondition::ValueList(vec![]) });
        def.engine_filters.push(EngineFilter {
            field_name: "Sales.year".to_string(),
            table: "Sales".to_string(),
            column: "year".to_string(),
            selected_items: strings(&["Y2"]),
            level: 2,
            slicer_id: None,
        });
        def.slicer_filters.push(SlicerFilter {
            source_index: 2,
            hidden_items: strings(&["Store"]),
            model_key: Some("Sales.channel".to_string()),
        });
        let seed = test_seed_effect();
        pivots.pivot_tables.write(&seed).unwrap().insert(id, (def, cache));
        pivots.bi_metadata.write(&seed).unwrap().insert(id, bi_meta(conn));
        (state, pivots, id, conn)
    }

    fn value_id(pivots: &PivotState, id: pivot_engine::PivotId, field: usize, text: &str) -> u32 {
        let tables = pivots.pivot_tables.read().unwrap();
        let (_, cache) = &tables[&id];
        cache.find_value_id(field, &pivot_engine::CacheValue::Text(text.to_string())).expect("interned")
    }

    /// A `BiState` holding ONE live connection with no engine (`pivotContext`
    /// reads nothing of it but its application data source): an application
    /// connection when `package` is `Some`, a local one otherwise.
    fn bi_with_connection(conn: ConnectionId, package: Option<&str>) -> BiState {
        let bi = BiState::new();
        bi.connections.lock().unwrap().insert(
            conn,
            crate::bi::types::Connection {
                id: conn,
                name: "Sales".into(),
                description: String::new(),
                connection_type: crate::bi::types::ConnectionType::PostgreSQL,
                connection_string: String::new(),
                server: String::new(),
                database: String::new(),
                preferred_auth: "Integrated".into(),
                model_path: None,
                engine: None,
                model_key: None,
                connector_index: None,
                bindings: vec![],
                last_refreshed: None,
                created_at: String::new(),
                is_connected: true,
                active_queries: HashMap::new(),
                package_data_source_id: package.map(str::to_string),
                active_role: None,
                base_model: None,
                calculated_measures: vec![],
            },
        );
        bi
    }

    #[test]
    fn pivot_context_resolves_the_path_to_keys_with_labels_and_carries_the_standing_filters_as_keys() {
        let (state, pivots, id, conn) = fixture();
        let bi = bi_with_connection(conn, None);
        let east = value_id(&pivots, id, 0, "East");

        let response =
            pivot_context_core(&state, &pivots, &bi, id, &[(0, east), (1, VALUE_ID_BLANK)]).expect("resolves");
        let DrillThroughResponse::PivotContext { connection_id, package_data_source_id, filters, standing, notices } =
            response
        else {
            panic!("expected pivotContext");
        };
        assert_eq!(connection_id, conn);
        assert_eq!(package_data_source_id, None, "a LOCAL connection carries no package key");
        assert_eq!(
            filters,
            vec![
                // (a) the clicked datum, one spec per coordinate, the blank by
                // its key "" and its label "(Blank)" (ruling Q8) -- and
                // NOTHING else: the standing filters ride apart.
                DrillFilterSpec {
                    field: "Sales.region".into(),
                    included_keys: Some(strings(&["East"])),
                    hidden_keys: None,
                    labels: Some(strings(&["East"])),
                },
                DrillFilterSpec {
                    field: "Sales.year".into(),
                    included_keys: Some(strings(&[""])),
                    hidden_keys: None,
                    labels: Some(vec![engine::BLANK_MEMBER_LABEL.to_string()]),
                },
            ],
            "`filters` is the clicked path only"
        );
        assert_eq!(
            standing,
            vec![
                // (c) the pinned engine filter: keys as written, labels
                // resolved because year is a placed field.
                DrillFilterSpec {
                    field: "Sales.year".into(),
                    included_keys: Some(strings(&["Y2"])),
                    hidden_keys: None,
                    labels: Some(strings(&["Y2"])),
                },
                // the column field's hidden item
                DrillFilterSpec { field: "Sales.year".into(), included_keys: None, hidden_keys: Some(strings(&["Y1"])), labels: None },
                // the filter area's hidden "5.5" (DISPLAY) carried as the KEY
                // "5.50"; "Nope" dropped into a notice
                DrillFilterSpec { field: "Sales.price".into(), included_keys: None, hidden_keys: Some(strings(&["5.50"])), labels: None },
                // the slicer filter on the UNPLACED channel column, spelled
                // through its model key
                DrillFilterSpec { field: "Sales.channel".into(), included_keys: None, hidden_keys: Some(strings(&["Store"])), labels: None },
            ],
            "`standing` is the pivot's own filters, in their order"
        );
        assert_eq!(notices.len(), 1, "one notice, for the one lost item: {notices:?}");
        assert!(notices[0].message.contains("Sales.price"), "{}", notices[0].message);
        assert!(notices[0].message.contains("1 of its 2 items"), "{}", notices[0].message);
        // Keys are never spelled in a notice (the lost item could be one).
        assert!(!notices[0].message.contains("Nope"), "{}", notices[0].message);
        // Both pivot guards were released: a write succeeds right after.
        pivots.pivot_tables.write(&test_seed_effect()).unwrap();
        pivots.bi_metadata.write(&test_seed_effect()).unwrap();
    }

    #[test]
    fn pivot_context_answers_the_live_application_connections_package_key_and_none_for_a_dead_connection() {
        // A subscriber's connection is re-minted on every open; the chart a
        // drill creates can be re-bound only by the application's data-source
        // id, so the op answers the LIVE connection's key.
        let (state, pivots, id, conn) = fixture();
        let east = value_id(&pivots, id, 0, "East");
        let bi = bi_with_connection(conn, Some("ds-sales"));
        let response = pivot_context_core(&state, &pivots, &bi, id, &[(0, east)]).expect("resolves");
        let DrillThroughResponse::PivotContext { package_data_source_id, filters, .. } = response else {
            panic!("expected pivotContext");
        };
        assert_eq!(package_data_source_id.as_deref(), Some("ds-sales"));
        assert_eq!(filters.len(), 1, "the path is unchanged by the key: {filters:?}");

        // The pivot's connection is not live (a .cala load before the user
        // reconnects, or another connection only): no key, and no error.
        let other = bi_with_connection(new_id(), Some("ds-other"));
        let response = pivot_context_core(&state, &pivots, &other, id, &[(0, east)]).expect("resolves");
        let DrillThroughResponse::PivotContext { package_data_source_id, .. } = response else {
            panic!("expected pivotContext");
        };
        assert_eq!(package_data_source_id, None, "a key is never borrowed from another connection");
        let response = pivot_context_core(&state, &pivots, &BiState::new(), id, &[(0, east)]).expect("resolves");
        assert!(matches!(response, DrillThroughResponse::PivotContext { package_data_source_id: None, .. }));
    }

    /// A MEASURE-ONLY BI pivot (VALUES only): `update_bi_pivot_fields` places
    /// the synthetic "Total" row field at cache field 0, one member "Total"
    /// on every record. Region sits in the filter area hiding "West" and a
    /// pinned engine filter keeps year "Y2", so the standing filters are real.
    /// With `calc_group_total`, a CALCULATION GROUP named "Total" sits on rows
    /// instead -- the same cache shape, which must NOT be skipped.
    fn values_only_fixture(calc_group_total: bool) -> (AppState, PivotState, pivot_engine::PivotId, ConnectionId) {
        let state = crate::create_app_state();
        let pivots = PivotState::new();
        let id = new_id();
        let conn = new_id();
        let mut cache = PivotCache::new(id, 3);
        cache.set_field_name(0, "Total".to_string());
        cache.set_field_name(1, "Sales.region".to_string());
        cache.set_field_name(2, "Sales.year".to_string());
        let text = |s: &str| CellValue::Text(s.to_string());
        cache.add_record(0, &[text("Total"), text("East"), text("Y1")]);
        cache.add_record(1, &[text("Total"), text("West"), text("Y2")]);
        let mut def = PivotDefinition::new(id, (0, 0), (0, 0));
        def.row_fields.push(PivotField::new(0, "Total".to_string()));
        let mut region = PivotField::new(1, "Sales.region".to_string());
        region.hidden_items = strings(&["West"]);
        def.filter_fields.push(PivotFilter { field: region, condition: FilterCondition::ValueList(vec![]) });
        def.engine_filters.push(EngineFilter {
            field_name: "Sales.year".to_string(),
            table: "Sales".to_string(),
            column: "year".to_string(),
            selected_items: strings(&["Y2"]),
            level: 2,
            slicer_id: None,
        });
        let mut meta = bi_meta(conn);
        if calc_group_total {
            meta.calculation_groups.push(crate::pivot::types::BiCalcGroupMeta {
                name: "Total".to_string(),
                items: vec![],
                multiple_or_empty_selection: None,
                no_selection: None,
            });
        }
        let seed = test_seed_effect();
        pivots.pivot_tables.write(&seed).unwrap().insert(id, (def, cache));
        pivots.bi_metadata.write(&seed).unwrap().insert(id, meta);
        (state, pivots, id, conn)
    }

    #[test]
    fn pivot_context_skips_a_measure_only_pivots_synthetic_total_row_and_still_carries_the_standing_filters() {
        // Every value cell of a VALUES-only pivot has the group path
        // [(0, id("Total"))]. That coordinate pins every record -- padding, not
        // a datum -- and refusing it made such a pivot impossible to drill.
        let (state, pivots, id, conn) = values_only_fixture(false);
        let bi = bi_with_connection(conn, None);
        let total = value_id(&pivots, id, 0, "Total");

        let response = pivot_context_core(&state, &pivots, &bi, id, &[(0, total)]).expect("a measure-only pivot drills");
        let DrillThroughResponse::PivotContext { connection_id, filters, standing, notices, .. } = response else {
            panic!("expected pivotContext");
        };
        assert_eq!(connection_id, conn);
        assert!(filters.is_empty(), "the synthetic Total row contributes NO path spec: {filters:?}");
        assert_eq!(
            standing,
            vec![
                // year is not PLACED in this pivot, so its pinned keys have no
                // cache column to take labels from: keys alone.
                DrillFilterSpec {
                    field: "Sales.year".into(),
                    included_keys: Some(strings(&["Y2"])),
                    hidden_keys: None,
                    labels: None,
                },
                DrillFilterSpec { field: "Sales.region".into(), included_keys: None, hidden_keys: Some(strings(&["West"])), labels: None },
            ],
            "the standing filters are still carried"
        );
        assert!(notices.is_empty(), "{notices:?}");

        // A stale Total coordinate (a value id the rebuilt cache never
        // interned) still fails rather than drilling unfiltered.
        let err = pivot_context_core(&state, &pivots, &bi, id, &[(0, 4_000)]).unwrap_err();
        assert!(err.contains("could not be resolved"), "got: {err}");
    }

    #[test]
    fn pivot_context_still_refuses_a_calculation_group_named_total() {
        // The same cache shape, but "Total" IS a calculation group: a real
        // coordinate with no model-column spelling, refused as before.
        let (state, pivots, id, conn) = values_only_fixture(true);
        let bi = bi_with_connection(conn, None);
        let total = value_id(&pivots, id, 0, "Total");
        let err = pivot_context_core(&state, &pivots, &bi, id, &[(0, total)]).unwrap_err();
        assert!(err.contains("not a model column"), "got: {err}");
    }

    #[test]
    fn pivot_context_fails_on_a_coordinate_it_cannot_resolve_instead_of_filtering_on_a_partial_path() {
        let (state, pivots, id, conn) = fixture();
        let bi = bi_with_connection(conn, None);
        let east = value_id(&pivots, id, 0, "East");

        // A field index the pivot does not place and the model does not know.
        let err = pivot_context_core(&state, &pivots, &bi, id, &[(0, east), (9, 0)]).unwrap_err();
        assert!(err.contains("not a model column"), "got: {err}");
        // A value id the field never interned (a stale path against a rebuilt cache).
        let err = pivot_context_core(&state, &pivots, &bi, id, &[(0, 4_000)]).unwrap_err();
        assert!(err.contains("could not be resolved"), "got: {err}");
        // A pivot that is not BI-backed has no design-query drill.
        let grid_pivot = new_id();
        let seed = test_seed_effect();
        pivots
            .pivot_tables
            .write(&seed)
            .unwrap()
            .insert(grid_pivot, (PivotDefinition::new(grid_pivot, (0, 0), (0, 0)), PivotCache::new(grid_pivot, 0)));
        let err = pivot_context_core(&state, &pivots, &bi, grid_pivot, &[]).unwrap_err();
        assert!(err.contains("data-model"), "got: {err}");
        // An unknown pivot.
        let err = pivot_context_core(&state, &pivots, &bi, new_id(), &[]).unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    // ------------------------------------------------------------------
    // toSheet: the chart presentation (no query, no engine) and the sheet
    // lifecycle around it
    // ------------------------------------------------------------------

    fn listed(state: &AppState) -> Vec<(usize, String, bool, String)> {
        let sheet_names = state.sheet_names.read().unwrap();
        let freeze_configs = state.freeze_configs.read().unwrap();
        let tab_colors = state.tab_colors.read().unwrap();
        let sheet_visibility = state.sheet_visibility.read().unwrap();
        let sheet_ids = state.sheet_ids.read().unwrap();
        let sheet_kinds = state.sheet_kinds.read().unwrap();
        let ephemeral = ephemeral_ids(state);
        crate::sheets::build_sheet_list(
            &sheet_names,
            &freeze_configs,
            &tab_colors,
            &sheet_visibility,
            &sheet_ids,
            &sheet_kinds,
            &ephemeral,
        )
        .into_iter()
        .map(|s| (s.index, s.name, s.ephemeral, s.kind))
        .collect()
    }

    #[tokio::test]
    async fn to_sheet_chart_appends_an_activated_ephemeral_canvas_and_refuses_a_drill_from_it_until_kept() {
        let state = crate::create_app_state();
        let file = FileState::default();
        let bi = BiState::new();
        assert!(!file.is_dirty());

        let response = drill_through_to_ephemeral_sheet_core(
            &state,
            &file,
            &bi,
            "Region detail",
            None,
            DrillSheetPresentation::Chart,
            None,
            &[],
        )
        .await
        .expect("a chart drill adds its canvas");
        let DrillThroughResponse::ToSheet { sheet_index, sheet_name, sheet_id, row_count, col_count } = response else {
            panic!("expected toSheet");
        };
        assert_eq!((sheet_index, sheet_name.as_str(), row_count, col_count), (1, "Region detail", 0, 0));
        assert_eq!(*state.active_sheet.read().unwrap(), 1, "created AND switched to");
        assert!(state.sheet_kinds.read().unwrap()[1].is_canvas(), "a chart presentation is a canvas");
        let id = state.sheet_ids.read().unwrap()[1];
        assert_eq!(id.to_string(), sheet_id, "the answered id is the sheet's stable id");
        assert!(ephemeral_ids(&state).contains(&id), "flagged ephemeral");
        assert_eq!(
            listed(&state),
            vec![
                (0, "Sheet1".to_string(), false, "worksheet".to_string()),
                (1, "Region detail".to_string(), true, "canvas".to_string()),
            ]
        );
        assert!(file.is_dirty(), "adding a sheet dirties the document, as every added sheet does");

        // Drill-from-drill: the ACTIVE sheet is ephemeral, so a second drill is
        // refused until the user keeps or leaves it (the frontend discards
        // first; this is the guard behind it).
        let err =
            drill_through_to_ephemeral_sheet_core(&state, &file, &bi, "Again", None, DrillSheetPresentation::Chart, None, &[])
                .await
                .unwrap_err();
        assert_eq!(err, EPHEMERAL_ACTIVE_REFUSAL);
        assert_eq!(state.sheet_names.read().unwrap().len(), 2, "the refusal added nothing");

        // Kept (by its stable id): the flag clears and the drill proceeds; the
        // second sheet of the same name gets the first free suffix.
        crate::sheets::keep_ephemeral_sheet_impl(&state, &sheet_id).expect("keep");
        assert!(ephemeral_ids(&state).is_empty());
        let response = drill_through_to_ephemeral_sheet_core(
            &state,
            &file,
            &bi,
            "Region detail",
            None,
            DrillSheetPresentation::Chart,
            None,
            &[],
        )
        .await
        .expect("after the keep the drill proceeds");
        let DrillThroughResponse::ToSheet { sheet_index, sheet_name, .. } = response else { panic!("expected toSheet") };
        assert_eq!((sheet_index, sheet_name.as_str()), (2, "Region detail2"));
        assert_eq!(ephemeral_ids(&state).len(), 1, "only the new sheet is flagged");
    }

    /// The `sheetId` of a `toSheet` answer.
    fn answered_id(response: &DrillThroughResponse) -> String {
        match response {
            DrillThroughResponse::ToSheet { sheet_id, .. } => sheet_id.clone(),
            other => panic!("expected toSheet, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn to_sheet_names_the_sheet_through_the_sheet_name_rule_and_obeys_the_structure_gate() {
        let state = crate::create_app_state();
        let file = FileState::default();
        let bi = BiState::new();

        // An empty name, and one Excel's rule refuses, fall back to the default base.
        let response =
            drill_through_to_ephemeral_sheet_core(&state, &file, &bi, "   ", None, DrillSheetPresentation::Chart, None, &[])
                .await
                .expect("adds");
        let DrillThroughResponse::ToSheet { ref sheet_name, .. } = response else { panic!("expected toSheet") };
        assert_eq!(sheet_name, DEFAULT_SHEET_BASE);
        crate::sheets::keep_ephemeral_sheet_impl(&state, &answered_id(&response)).expect("keep");
        let response =
            drill_through_to_ephemeral_sheet_core(&state, &file, &bi, "a/b:c", None, DrillSheetPresentation::Chart, None, &[])
                .await
                .expect("adds");
        let DrillThroughResponse::ToSheet { ref sheet_name, .. } = response else { panic!("expected toSheet") };
        assert_eq!(sheet_name, &format!("{}2", DEFAULT_SHEET_BASE));
        crate::sheets::keep_ephemeral_sheet_impl(&state, &answered_id(&response)).expect("keep");

        // A table drill without its query is refused before anything is written.
        let before = state.sheet_names.read().unwrap().len();
        let err = drill_through_to_ephemeral_sheet_core(&state, &file, &bi, "x", None, DrillSheetPresentation::Table, None, &[])
            .await
            .unwrap_err();
        assert!(err.contains("compiled query"), "got: {err}");
        assert_eq!(state.sheet_names.read().unwrap().len(), before);

        // Protect Workbook Structure refuses the drill (it adds a sheet).
        state.workbook_protection.write(&test_seed_effect()).unwrap().protected = true;
        let err = drill_through_to_ephemeral_sheet_core(&state, &file, &bi, "x", None, DrillSheetPresentation::Chart, None, &[])
            .await
            .unwrap_err();
        assert!(err.contains("protected"), "got: {err}");
        assert_eq!(state.sheet_names.read().unwrap().len(), before);
    }

    #[tokio::test]
    async fn a_second_drill_from_a_31_character_name_gets_a_legal_sheet_name() {
        // FirstFree appended its counter to the whole base: a kept drill named
        // with 31 characters made the next drill's sheet 32 characters long, a
        // name `validate_sheet_name` refuses and an .xlsx save then refuses too.
        let state = crate::create_app_state();
        let file = FileState::default();
        let bi = BiState::new();
        let base = "Revenue by product category 202";
        assert_eq!(base.chars().count(), crate::sheet_names::MAX_SHEET_NAME_CHARS, "fixture: a full-length base");

        let first = drill_through_to_ephemeral_sheet_core(&state, &file, &bi, base, None, DrillSheetPresentation::Chart, None, &[])
            .await
            .expect("the first drill lands under the base itself");
        let DrillThroughResponse::ToSheet { ref sheet_name, .. } = first else { panic!("expected toSheet") };
        assert_eq!(sheet_name, base);
        crate::sheets::keep_ephemeral_sheet_impl(&state, &answered_id(&first)).expect("keep");

        let second = drill_through_to_ephemeral_sheet_core(&state, &file, &bi, base, None, DrillSheetPresentation::Chart, None, &[])
            .await
            .expect("the second drill lands");
        let DrillThroughResponse::ToSheet { ref sheet_name, .. } = second else { panic!("expected toSheet") };
        assert!(
            sheet_name.chars().count() <= crate::sheet_names::MAX_SHEET_NAME_CHARS,
            "{sheet_name:?} is {} characters",
            sheet_name.chars().count()
        );
        assert_eq!(
            crate::sheet_names::validate_sheet_name(sheet_name).as_deref(),
            Ok(sheet_name.as_str()),
            "the generated name is one the sheet name rule accepts unchanged"
        );
        assert_ne!(sheet_name, base, "and it is not the kept sheet's name");

        // Multi-byte characters are cut by CHARACTER, never mid-character (a
        // byte slice would panic inside the last 'å').
        crate::sheets::keep_ephemeral_sheet_impl(&state, &answered_id(&second)).expect("keep");
        let wide = "Område försäljning per kvartålå";
        assert_eq!(wide.chars().count(), crate::sheet_names::MAX_SHEET_NAME_CHARS, "fixture: a full-length base");
        assert!(wide.len() > crate::sheet_names::MAX_SHEET_NAME_CHARS, "fixture: more bytes than characters");
        for expected in [wide.to_string(), "Område försäljning per kvartål2".to_string()] {
            let response =
                drill_through_to_ephemeral_sheet_core(&state, &file, &bi, wide, None, DrillSheetPresentation::Chart, None, &[])
                    .await
                    .expect("lands");
            let DrillThroughResponse::ToSheet { ref sheet_name, .. } = response else { panic!("expected toSheet") };
            assert_eq!(sheet_name, &expected);
            assert!(crate::sheet_names::validate_sheet_name(sheet_name).is_ok(), "{sheet_name:?}");
            crate::sheets::keep_ephemeral_sheet_impl(&state, &answered_id(&response)).expect("keep");
        }
    }

    #[test]
    fn keeping_the_active_ephemeral_sheet_clears_the_guard_the_drill_checks() {
        // `active_sheet_is_ephemeral` is the guard `toSheet` refuses on; a keep
        // of the ACTIVE sheet clears it. (The delete hygiene -- a flagged id
        // leaving the set with its sheet -- is pinned through the real
        // `delete_sheet_impl` in
        // `object_sheet_tests::deleting_an_ephemeral_sheet_removes_its_id_from_the_set`.)
        let state = crate::create_app_state();
        let id = state.sheet_ids.read().unwrap()[0];
        state.ephemeral_sheets.lock().unwrap().insert(id);
        assert!(active_sheet_is_ephemeral(&state));
        crate::sheets::keep_ephemeral_sheet_impl(&state, &id.to_string()).expect("keep");
        assert!(!active_sheet_is_ephemeral(&state));
    }

    // ------------------------------------------------------------------
    // toSheet: the TABLE presentation over an in-memory model
    // ------------------------------------------------------------------

    mod table {
        use super::*;
        use crate::bi::types::{Connection, ConnectionType};
        use crate::pivot::headless::DesignQueryFieldRef;
        use crate::pivot::types::BiValueFieldRef;
        use arrow::array::{Float64Array, StringArray};
        use arrow::datatypes::{DataType as ArrowType, Field, Schema};
        use arrow::record_batch::RecordBatch;
        use bi_engine::{
            sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector, QueryRequest, SourceBinding,
            StorageMode, Table,
        };
        use std::sync::Arc;
        use tokio::sync::Mutex as TokioMutex;

        /// region  year amount
        /// East    Y1   10
        /// West    Y1   20
        /// East    Y2   30
        /// North   Y2   40
        fn sales_batch() -> RecordBatch {
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("region", ArrowType::Utf8, true),
                    Field::new("year", ArrowType::Utf8, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(StringArray::from(vec!["East", "West", "East", "North"])),
                    Arc::new(StringArray::from(vec!["Y1", "Y1", "Y2", "Y2"])),
                    Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0])),
                ],
            )
            .unwrap()
        }

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

        /// A `BiState` holding one cache-warm in-memory connection (the
        /// `filtered_view_tests` fixture, trimmed).
        async fn bi_state() -> (BiState, ConnectionId) {
            let mut engine = Engine::new(sales_model());
            let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", sales_batch()));
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
            (bi, conn)
        }

        fn region_query(conn: ConnectionId, kept: &[&str]) -> DesignQueryRequest {
            DesignQueryRequest {
                connection_id: conn,
                row_fields: vec![DesignQueryFieldRef {
                    table: "Sales".into(),
                    column: "region".into(),
                    is_lookup: false,
                    hidden_items: None,
                    included_items: None,
                    level: None,
                }],
                column_fields: vec![DesignQueryFieldRef {
                    table: "Sales".into(),
                    column: "year".into(),
                    is_lookup: false,
                    hidden_items: None,
                    included_items: None,
                    level: None,
                }],
                value_fields: vec![BiValueFieldRef { measure_name: "Revenue".into(), custom_name: None, number_format: None }],
                filter_fields: vec![],
                // The baked drill filter rides as an engine-run inclusion.
                page_filter_fields: vec![DesignQueryFieldRef {
                    table: "Sales".into(),
                    column: "region".into(),
                    is_lookup: false,
                    hidden_items: None,
                    included_items: Some(strings(kept)),
                    level: None,
                }],
                tuple_filters: vec![],
                calculated_fields: None,
                value_column_order: None,
                layout: None,
            }
        }

        fn text_at(state: &AppState, sheet: usize, row: u32, col: u32) -> Option<String> {
            state.grids.read().unwrap()[sheet].get_cell(row, col).map(|c| c.display_value())
        }

        #[tokio::test]
        async fn to_sheet_table_writes_the_caption_then_the_filtered_view_on_an_activated_ephemeral_worksheet() {
            let state = crate::create_app_state();
            let file = FileState::default();
            let (bi, conn) = bi_state().await;
            // An undoable step BEFORE the drill, so "the history ended" is an
            // observable change (a fresh state's stack is already empty).
            state.undo_stack.lock().unwrap().record_cell_change(0, 10, 0, None);
            assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), 1, "fixture: one undoable step");
            let clears_before = state.undo_stack.lock().unwrap().clears_total();

            let response = drill_through_to_ephemeral_sheet_core(
                &state,
                &file,
                &bi,
                "Region detail",
                None,
                DrillSheetPresentation::Table,
                Some(region_query(conn, &["East", "West"])),
                &["Filtered to: East, West".to_string()],
            )
            .await
            .expect("the table drill lands");
            let DrillThroughResponse::ToSheet { sheet_index, sheet_name, sheet_id, row_count, col_count } = response else {
                panic!("expected toSheet");
            };
            assert_eq!((sheet_index, sheet_name.as_str()), (1, "Region detail"));
            assert!(row_count > 0 && col_count >= 2, "a view was written: {row_count} x {col_count}");
            assert_eq!(*state.active_sheet.read().unwrap(), 1);
            assert!(!state.sheet_kinds.read().unwrap()[1].is_canvas(), "a table is a WORKSHEET");
            let id = state.sheet_ids.read().unwrap()[1];
            assert_eq!(id.to_string(), sheet_id);
            assert!(ephemeral_ids(&state).contains(&id));
            assert!(file.is_dirty());

            // The caption: the name in bold at (0,0), the frontend's line
            // VERBATIM at (1,0) (never prefixed a second time), nothing at
            // row 2, the view from row 3.
            assert_eq!(text_at(&state, 1, 0, 0).as_deref(), Some("Region detail"));
            let title_style = state.grids.read().unwrap()[1].get_cell(0, 0).unwrap().style_index;
            assert!(title_style != 0 && state.style_registry.read().unwrap().get(title_style).font.bold, "the name is bold");
            assert_eq!(text_at(&state, 1, 1, 0).as_deref(), Some("Filtered to: East, West"));
            assert!(text_at(&state, 1, 2, 0).is_none(), "row 2 is the blank spacer");
            let origin = view_origin(1);
            assert_eq!(origin, (3, 0));
            assert!(text_at(&state, 1, origin.0, origin.1).is_some(), "the view starts at the origin");

            // The baked inclusion held: East and West are rows, North is not.
            let column_a: Vec<String> = (origin.0..origin.0 + 20)
                .filter_map(|r| text_at(&state, 1, r, 0))
                .collect();
            assert!(column_a.iter().any(|t| t == "East"), "{column_a:?}");
            assert!(column_a.iter().any(|t| t == "West"), "{column_a:?}");
            assert!(!column_a.iter().any(|t| t == "North"), "{column_a:?}");
            // The mirror of the active sheet shows the same cells.
            assert_eq!(state.grid.read().unwrap().get_cell(0, 0).map(|c| c.display_value()).as_deref(), Some("Region detail"));
            // The undo history ENDED (Excel parity, BUG-0005): the step recorded
            // before the drill is gone and the clear itself was counted (the
            // dependency rebuild is pinned textually by the add-path census).
            // SABOTAGE: drop `invalidate_undo_history_for_sheet_structure` from
            // the drill -- both assertions below fail.
            let undo = state.undo_stack.lock().unwrap();
            assert_eq!(undo.clears_total(), clears_before + 1, "the drill ended the undo history");
            assert_eq!(undo.undo_depth(), 0, "the step recorded before the drill is gone");
        }

        #[test]
        fn the_view_starts_below_every_caption_line_and_never_above_row_three() {
            assert_eq!(view_origin(0), (3, 0));
            assert_eq!(view_origin(1), (3, 0));
            assert_eq!(view_origin(2), (4, 0));
            assert_eq!(view_origin(3), (5, 0));
            assert_eq!(view_origin(usize::MAX).0, u32::MAX, "saturates instead of wrapping");
        }

        #[tokio::test]
        async fn to_sheet_table_writes_every_caption_line_verbatim_and_pushes_the_view_down() {
            let state = crate::create_app_state();
            let file = FileState::default();
            let (bi, conn) = bi_state().await;
            let lines = [
                "Filtered to: East, West".to_string(),
                "Not carried: the filter on Region".to_string(),
                "FILTERS fields with no values are not applied by a drill-through: Product.Name".to_string(),
            ];
            drill_through_to_ephemeral_sheet_core(
                &state,
                &file,
                &bi,
                "Region detail",
                None,
                DrillSheetPresentation::Table,
                Some(region_query(conn, &["East", "West"])),
                &lines,
            )
            .await
            .expect("the table drill lands");
            for (i, line) in lines.iter().enumerate() {
                assert_eq!(text_at(&state, 1, (i + 1) as u32, 0).as_deref(), Some(line.as_str()), "caption line {i} verbatim");
            }
            assert!(text_at(&state, 1, 4, 0).is_none(), "one blank spacer row under the caption");
            let origin = view_origin(lines.len());
            assert_eq!(origin, (5, 0));
            assert!(text_at(&state, 1, origin.0, origin.1).is_some(), "the view starts below the caption");
            let column_a: Vec<String> = (origin.0..origin.0 + 20).filter_map(|r| text_at(&state, 1, r, 0)).collect();
            assert!(column_a.iter().any(|t| t == "East"), "{column_a:?}");
            assert!(!column_a.iter().any(|t| t == "North"), "{column_a:?}");
        }

        #[tokio::test]
        async fn to_sheet_table_refuses_an_unknown_connection_before_writing_anything() {
            let state = crate::create_app_state();
            let file = FileState::default();
            let (bi, _) = bi_state().await;
            let err = drill_through_to_ephemeral_sheet_core(
                &state,
                &file,
                &bi,
                "x",
                None,
                DrillSheetPresentation::Table,
                Some(region_query(new_id(), &["East"])),
                &[],
            )
            .await
            .unwrap_err();
            assert!(!err.is_empty());
            assert_eq!(state.sheet_names.read().unwrap().len(), 1, "a failing query adds no sheet");
            assert!(!file.is_dirty(), "and leaves the document clean");
            assert!(ephemeral_ids(&state).is_empty());
        }

        // --------------------------------------------------------------
        // The title: the definition's own name, not the sheet name
        // --------------------------------------------------------------

        #[tokio::test]
        async fn to_sheet_table_titles_the_sheet_with_the_definitions_name_and_names_it_from_the_base() {
            // The sheet name is a cleaned-up, cut copy of the definition's name
            // (`/` is illegal in a sheet name, and 31 characters is the limit);
            // the title row shows what the author wrote.
            let state = crate::create_app_state();
            let file = FileState::default();
            let (bi, conn) = bi_state().await;
            let base = "Revenue by region  channel, 202";
            let title = "Revenue by region / channel, 2025 plan";
            let response = drill_through_to_ephemeral_sheet_core(
                &state,
                &file,
                &bi,
                base,
                Some(title),
                DrillSheetPresentation::Table,
                Some(region_query(conn, &["East"])),
                &[],
            )
            .await
            .expect("the table drill lands");
            let DrillThroughResponse::ToSheet { sheet_index, ref sheet_name, .. } = response else {
                panic!("expected toSheet");
            };
            assert_eq!(sheet_name, base, "the SHEET is named from `name`");
            assert_eq!(text_at(&state, sheet_index, 0, 0).as_deref(), Some(title), "the title row is the definition's name");
            let style = state.grids.read().unwrap()[sheet_index].get_cell(0, 0).unwrap().style_index;
            assert!(style != 0 && state.style_registry.read().unwrap().get(style).font.bold, "in bold");
        }

        #[tokio::test]
        async fn to_sheet_table_without_a_title_or_with_a_blank_one_is_titled_with_its_name() {
            let state = crate::create_app_state();
            let file = FileState::default();
            let (bi, conn) = bi_state().await;
            for (title, name) in [(None, "Region detail"), (Some("   "), "Region again")] {
                let response = drill_through_to_ephemeral_sheet_core(
                    &state,
                    &file,
                    &bi,
                    name,
                    title,
                    DrillSheetPresentation::Table,
                    Some(region_query(conn, &["East"])),
                    &[],
                )
                .await
                .expect("the table drill lands");
                let DrillThroughResponse::ToSheet { sheet_index, ref sheet_id, .. } = response else {
                    panic!("expected toSheet");
                };
                assert_eq!(
                    text_at(&state, sheet_index, 0, 0).as_deref(),
                    Some(name),
                    "title {title:?} falls back to the name, never spaces in A1"
                );
                crate::sheets::keep_ephemeral_sheet_impl(&state, sheet_id).expect("keep, so the next drill may start");
            }
            assert_eq!(table_title(None, "   "), DEFAULT_SHEET_BASE, "and a blank name to the default base");
            assert_eq!(table_title(Some("  Plan  "), "x"), "Plan", "a title is trimmed");
        }

        // --------------------------------------------------------------
        // The gates re-checked after the query (the await can take long)
        // --------------------------------------------------------------

        /// The connection's engine: a test that holds it parks a table drill
        /// on its query's await, the window the re-checks close.
        fn engine_of(bi: &BiState, conn: ConnectionId) -> Arc<TokioMutex<Engine>> {
            bi.connections.lock().unwrap()[&conn].engine.clone().expect("an engine")
        }

        /// Poll `drill` ONCE and require it to be waiting: it has then passed
        /// its pre-query gates and is parked on the engine the test holds.
        async fn park<F: std::future::Future>(drill: std::pin::Pin<&mut F>) {
            let mut drill = drill;
            let first =
                std::future::poll_fn(|cx| std::task::Poll::Ready(std::future::Future::poll(drill.as_mut(), cx))).await;
            assert!(first.is_pending(), "fixture: the drill must be waiting on the model the test holds");
        }

        #[tokio::test]
        async fn protect_workbook_structure_turned_on_during_the_query_refuses_and_leaves_the_document_clean() {
            let state = crate::create_app_state();
            let file = FileState::default();
            let (bi, conn) = bi_state().await;
            let styles_before = state.style_registry.read().unwrap().len();
            let engine = engine_of(&bi, conn);
            let held = engine.lock().await;
            let query = Some(region_query(conn, &["East"]));
            let mut drill = std::pin::pin!(drill_through_to_ephemeral_sheet_core(
                &state,
                &file,
                &bi,
                "Region detail",
                None,
                DrillSheetPresentation::Table,
                query,
                &[],
            ));
            park(drill.as_mut()).await;

            // While the query waits, the user protects the workbook structure.
            state.workbook_protection.write(&test_seed_effect()).unwrap().protected = true;
            drop(held);

            let err = drill.await.unwrap_err();
            assert!(err.contains("protected"), "got: {err}");
            assert!(!file.is_dirty(), "the refusal came before this drill's effect: the document stays clean");
            assert_eq!(state.style_registry.read().unwrap().len(), styles_before, "no styles registered for a sheet that never came");
            assert_eq!(state.sheet_names.read().unwrap().len(), 1, "nothing added");
            assert!(ephemeral_ids(&state).is_empty());
        }

        #[tokio::test]
        async fn a_drill_that_landed_during_the_query_makes_the_waiting_table_drill_refuse_with_what_happened() {
            let state = crate::create_app_state();
            let file = FileState::default();
            let (bi, conn) = bi_state().await;
            let styles_before = state.style_registry.read().unwrap().len();
            let engine = engine_of(&bi, conn);
            let held = engine.lock().await;
            let query = Some(region_query(conn, &["East"]));
            let mut drill = std::pin::pin!(drill_through_to_ephemeral_sheet_core(
                &state,
                &file,
                &bi,
                "Region detail",
                None,
                DrillSheetPresentation::Table,
                query,
                &[],
            ));
            park(drill.as_mut()).await;

            // While the table drill waits on the model, a CHART drill (no
            // query) lands its temporary canvas and switches to it.
            let chart = drill_through_to_ephemeral_sheet_core(
                &state,
                &file,
                &bi,
                "Chart detail",
                None,
                DrillSheetPresentation::Chart,
                None,
                &[],
            )
            .await
            .expect("the chart drill lands");
            let DrillThroughResponse::ToSheet { sheet_index: chart_index, sheet_id: ref chart_id, .. } = chart else {
                panic!("expected toSheet");
            };
            drop(held);

            let err = drill.await.unwrap_err();
            assert_eq!(err, CONCURRENT_DRILL_REFUSAL, "said as what happened, not as a drill from a temporary sheet");
            assert_eq!(state.sheet_names.read().unwrap().len(), 2, "no second temporary sheet on top of the first");
            assert_eq!(*state.active_sheet.read().unwrap(), chart_index, "the user stays on the chart drill's sheet");
            let flagged: Vec<String> = ephemeral_ids(&state).iter().map(|id| id.to_string()).collect();
            assert_eq!(flagged, vec![chart_id.clone()], "only the chart drill's sheet is temporary");
            assert_eq!(
                state.style_registry.read().unwrap().len(),
                styles_before,
                "refused before the table's styles were registered"
            );
        }
    }
}
