//! FILENAME: app/src-tauri/src/persistence.rs

use identity::SheetId;
use crate::api_types::CellData;
use crate::tables::{
    Table, TableColumn, TableStyleOptions, TotalsRowFunction, TableStorage, TableNameRegistry,
};
use crate::{format_cell_value, AppState};
use persistence::{
    load_xlsx, save_xlsx, DimensionData, SavedTable, SavedTableColumn, SavedTableStyleOptions,
    SavedMergedRegion, SavedNamedRange, SavedNote, SavedHyperlink, SavedPageSetup,
    Workbook,
};
use calcula_format::{save_calcula_opt, load_calcula_opt};
use zeroize::Zeroizing;
use calcula_format::ai::{AiSerializeOptions, serialize_for_ai, SheetInput};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, State};

#[derive(Default)]
pub struct FileState {
    pub current_path: Mutex<Option<PathBuf>>,
    pub is_modified: Mutex<bool>,
    /// Session passphrase for the currently-open encrypted workbook.
    /// `None` = the document is plain (unencrypted). Held only in memory,
    /// zeroized when replaced/cleared; never persisted to disk, logged, or
    /// surfaced over IPC.
    pub session_password: Mutex<Option<Zeroizing<String>>>,
    /// Whether the currently-open document is encrypted. Drives the File-menu
    /// label ("Encrypt with Password…" vs "Remove Password").
    pub is_encrypted: Mutex<bool>,
}

/// Mark the workbook dirty.
///
/// Any command that mutates state which lives in the .cala but is written only
/// by the save path must call this: the close prompt and auto-recover both gate
/// on `is_modified`, so a mutation that never sets it is silently discarded at
/// close on an otherwise-clean document.
pub(crate) fn mark_workbook_modified(file_state: &FileState) {
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }
}

/// Virtual filesystem for user files stored inside the .cala archive.
#[derive(Default)]
pub struct UserFilesState {
    pub files: Mutex<HashMap<String, Vec<u8>>>,
}

// ============================================================================
// Table <-> SavedTable conversion
// ============================================================================

/// Map a sheet index to a SheetId using the provided slice.
/// If the index is out of range, mints a fresh ID as a fallback.
fn sheet_index_to_id(sheet_ids: &[SheetId], index: usize) -> SheetId {
    sheet_ids.get(index).copied().unwrap_or_else(|| {
        SheetId::from_bytes(identity::generate_uuid_v7())
    })
}

/// Find the sheet index for a given SheetId by searching the workbook sheets.
/// Falls back to 0 if not found.
fn sheet_id_to_index(workbook: &persistence::Workbook, sheet_id: SheetId) -> usize {
    workbook.sheets.iter().position(|s| s.id == sheet_id).unwrap_or(0)
}

fn table_to_saved(table: &Table, sheet_ids: &[SheetId]) -> SavedTable {
    SavedTable {
        id: table.id,
        name: table.name.clone(),
        sheet_id: sheet_index_to_id(sheet_ids, table.sheet_index),
        start_row: table.start_row,
        start_col: table.start_col,
        end_row: table.end_row,
        end_col: table.end_col,
        columns: table
            .columns
            .iter()
            .map(|c| SavedTableColumn {
                id: c.id,
                name: c.name.clone(),
                totals_row_function: totals_fn_to_string(&c.totals_row_function),
                totals_row_formula: c.totals_row_formula.clone(),
                calculated_formula: c.calculated_formula.clone(),
            })
            .collect(),
        style_options: SavedTableStyleOptions {
            banded_rows: table.style_options.banded_rows,
            banded_columns: table.style_options.banded_columns,
            header_row: table.style_options.header_row,
            total_row: table.style_options.total_row,
            first_column: table.style_options.first_column,
            last_column: table.style_options.last_column,
            show_filter_button: table.style_options.show_filter_button,
        },
        style_name: table.style_name.clone(),
    }
}

fn saved_to_table(saved: &SavedTable, workbook: &persistence::Workbook) -> Table {
    saved_table_to_table_at(saved, sheet_id_to_index(workbook, saved.sheet_id))
}

/// Convert a SavedTable into a live Table at an explicit sheet index. Used by
/// the .cala load path (index resolved via the workbook) and the .calp pull
/// path (index resolved via the package->local sheet map).
pub fn saved_table_to_table_at(saved: &SavedTable, sheet_index: usize) -> Table {
    Table {
        id: saved.id,
        name: saved.name.clone(),
        sheet_index,
        start_row: saved.start_row,
        start_col: saved.start_col,
        end_row: saved.end_row,
        end_col: saved.end_col,
        columns: saved
            .columns
            .iter()
            .map(|c| TableColumn {
                id: c.id,
                name: c.name.clone(),
                totals_row_function: string_to_totals_fn(&c.totals_row_function),
                totals_row_formula: c.totals_row_formula.clone(),
                calculated_formula: c.calculated_formula.clone(),
            })
            .collect(),
        style_options: TableStyleOptions {
            banded_rows: saved.style_options.banded_rows,
            banded_columns: saved.style_options.banded_columns,
            header_row: saved.style_options.header_row,
            total_row: saved.style_options.total_row,
            first_column: saved.style_options.first_column,
            last_column: saved.style_options.last_column,
            show_filter_button: saved.style_options.show_filter_button,
        },
        style_name: saved.style_name.clone(),
        auto_filter_id: None,
    }
}

fn totals_fn_to_string(func: &TotalsRowFunction) -> String {
    match func {
        TotalsRowFunction::None => "none".to_string(),
        TotalsRowFunction::Average => "average".to_string(),
        TotalsRowFunction::Count => "count".to_string(),
        TotalsRowFunction::CountNumbers => "countNumbers".to_string(),
        TotalsRowFunction::Max => "max".to_string(),
        TotalsRowFunction::Min => "min".to_string(),
        TotalsRowFunction::Sum => "sum".to_string(),
        TotalsRowFunction::StdDev => "stdDev".to_string(),
        TotalsRowFunction::Var => "var".to_string(),
        TotalsRowFunction::Custom => "custom".to_string(),
    }
}

fn string_to_totals_fn(s: &str) -> TotalsRowFunction {
    match s {
        "average" => TotalsRowFunction::Average,
        "count" => TotalsRowFunction::Count,
        "countNumbers" => TotalsRowFunction::CountNumbers,
        "max" => TotalsRowFunction::Max,
        "min" => TotalsRowFunction::Min,
        "sum" => TotalsRowFunction::Sum,
        "stdDev" => TotalsRowFunction::StdDev,
        "var" => TotalsRowFunction::Var,
        "custom" => TotalsRowFunction::Custom,
        _ => TotalsRowFunction::None,
    }
}

/// Collect all tables from the AppState into SavedTable format.
fn collect_tables_for_save(
    tables: &TableStorage,
    sheet_ids: &[SheetId],
) -> Vec<SavedTable> {
    let mut saved = Vec::new();
    for sheet_tables in tables.values() {
        for table in sheet_tables.values() {
            saved.push(table_to_saved(table, sheet_ids));
        }
    }
    saved
}

/// Restore tables from SavedTable format into AppState structures.
fn restore_tables(
    saved_tables: &[SavedTable],
    workbook: &persistence::Workbook,
) -> (TableStorage, TableNameRegistry) {
    let mut tables: TableStorage = HashMap::new();
    let mut table_names: TableNameRegistry = HashMap::new();

    for saved in saved_tables {
        let table = saved_to_table(saved, workbook);
        table_names.insert(table.name.to_uppercase(), (table.sheet_index, table.id));
        tables
            .entry(table.sheet_index)
            .or_insert_with(HashMap::new)
            .insert(table.id, table);
    }

    (tables, table_names)
}

// ============================================================================
// PUBLIC HELPERS
// ============================================================================

/// Build a Workbook from the current AppState (used by save_file and export_as_package).
///
/// Captures ALL sheets, not just the active one (BUG-0011: the old
/// single-sheet `Workbook::from_grid` build silently dropped every other
/// sheet on save). The active sheet is read from the `state.grid` mirror and
/// the active-sheet dimension/merge mirrors, which are the source of truth
/// while a sheet is active (the `all_*` slots for the active sheet are
/// empty — they were std::mem::take'n on switch).
pub fn build_workbook_for_save(
    state: &State<AppState>,
    user_files_state: &State<UserFilesState>,
) -> Result<Workbook, String> {
    let grids = state.grids.lock().map_err(|e| e.to_string())?;
    let active_grid = state.grid.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let col_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
    let row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
    let all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
    let all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
    let tables = state.tables.lock().map_err(|e| e.to_string())?;
    let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;

    let mut workbook = Workbook::new();
    workbook.sheets.clear();
    workbook.active_sheet = active_sheet;

    let empty_grid = engine::grid::Grid::new();
    for i in 0..sheet_names.len() {
        let grid_ref: &engine::Grid = if i == active_sheet {
            &active_grid
        } else {
            grids.get(i).unwrap_or(&empty_grid)
        };
        let dimensions = DimensionData {
            column_widths: if i == active_sheet {
                col_widths.clone()
            } else {
                all_cw.get(i).cloned().unwrap_or_default()
            },
            row_heights: if i == active_sheet {
                row_heights.clone()
            } else {
                all_rh.get(i).cloned().unwrap_or_default()
            },
        };
        let id = sheet_ids.get(i).copied().unwrap_or_else(|| {
            SheetId::from_bytes(identity::generate_uuid_v7())
        });
        let name = sheet_names
            .get(i)
            .cloned()
            .unwrap_or_else(|| format!("Sheet{}", i + 1));
        workbook
            .sheets
            .push(persistence::Sheet::from_grid(id, name, grid_ref, &styles, &dimensions));
    }

    drop(grids);
    drop(active_grid);
    drop(sheet_names);
    drop(styles);
    drop(col_widths);
    drop(row_heights);
    drop(all_cw);
    drop(all_rh);

    workbook.tables = collect_tables_for_save(&tables, &sheet_ids);
    workbook.charts = collect_charts_for_save(state, &sheet_ids);
    workbook.sparklines = collect_sparklines_for_save(state, &sheet_ids);
    workbook.user_files = user_files_state.files.lock().map_err(|e| e.to_string())?.clone();
    workbook.theme = state.theme.lock().unwrap().clone();
    workbook.default_row_height = *state.default_row_height.lock().unwrap();
    workbook.default_column_width = *state.default_column_width.lock().unwrap();

    // Include workbook properties
    {
        let props = state.workbook_properties.lock().unwrap();
        workbook.properties = persistence::WorkbookProperties {
            title: props.title.clone(),
            author: props.author.clone(),
            subject: props.subject.clone(),
            description: props.description.clone(),
            keywords: props.keywords.clone(),
            category: props.category.clone(),
            created: props.created.clone(),
            last_modified: chrono::Utc::now().to_rfc3339(),
        };
    }

    // Enrich with sheet-level metadata (merged regions, freeze panes, etc.)
    enrich_workbook_metadata(&mut workbook, state, &sheet_ids);

    Ok(workbook)
}

/// Build a Workbook from the current AppState including slicer and ribbon filter state.
pub fn build_workbook_for_save_with_slicers(
    state: &State<AppState>,
    user_files_state: &State<UserFilesState>,
    slicer_state: &State<crate::slicer::SlicerState>,
    ribbon_filter_state: &State<crate::ribbon_filter::RibbonFilterState>,
) -> Result<Workbook, String> {
    let mut workbook = build_workbook_for_save(state, user_files_state)?;
    let sheet_ids_bwfs = state.sheet_ids.lock().map_err(|e| e.to_string())?;
    workbook.slicers = collect_slicers_for_save(slicer_state, &sheet_ids_bwfs);
    workbook.ribbon_filters = collect_ribbon_filters_for_save(ribbon_filter_state);
    workbook.pivot_layouts = state.pivot_layouts.lock().unwrap().clone();
    workbook.object_scripts = state.object_scripts.lock().unwrap().clone();
    workbook.extension_data = state.extension_data.lock().unwrap().clone();
    Ok(workbook)
}

/// Collect conditional-formatting + data-validation state into the persisted,
/// SheetId-keyed, opaque-payload carriers. Iterates the FULL per-sheet stores
/// (not the active-sheet getters), maps each sheet_index -> SheetId, and skips
/// empty sheets. CF/DV rule/range types are serialized as opaque JSON so the
/// persistence layer stays decoupled from the app's CF/DV types.
fn collect_cf_dv_for_save(
    state: &AppState,
    sheet_ids: &[SheetId],
) -> (
    Vec<persistence::SavedSheetConditionalFormats>,
    Vec<persistence::SavedSheetDataValidations>,
) {
    let mut conditional_formats = Vec::new();
    if let Ok(store) = state.conditional_formats.lock() {
        for (idx, defs) in store.iter() {
            if defs.is_empty() {
                continue;
            }
            if let Ok(rules) = serde_json::to_value(defs) {
                conditional_formats.push(persistence::SavedSheetConditionalFormats {
                    sheet_id: sheet_index_to_id(sheet_ids, *idx),
                    rules,
                });
            }
        }
    }
    let mut data_validations = Vec::new();
    if let Ok(store) = state.data_validations.lock() {
        for (idx, ranges) in store.iter() {
            if ranges.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::to_value(ranges) {
                data_validations.push(persistence::SavedSheetDataValidations {
                    sheet_id: sheet_index_to_id(sheet_ids, *idx),
                    ranges: value,
                });
            }
        }
    }
    (conditional_formats, data_validations)
}

/// Collect threaded comments + what-if scenarios + outline groups into the
/// persisted, SheetId-keyed, opaque-payload carriers (Wave B — before this,
/// all three lived only in AppState and were lost on every save/reload).
/// Iterates the FULL per-sheet stores like collect_cf_dv_for_save; entries
/// are sorted (outer Vec by sheet index, comments by cell) so the serialized
/// artifact bytes are deterministic across saves/publishes.
fn collect_comments_scenarios_outlines_for_save(
    state: &AppState,
    sheet_ids: &[SheetId],
) -> (
    Vec<persistence::SavedSheetComments>,
    Vec<persistence::SavedSheetScenarios>,
    Vec<persistence::SavedSheetOutline>,
) {
    let mut comments = Vec::new();
    if let Ok(store) = state.comments.lock() {
        let mut indices: Vec<usize> = store.keys().copied().collect();
        indices.sort_unstable();
        for idx in indices {
            let Some(sheet_comments) = store.get(&idx) else { continue };
            if sheet_comments.is_empty() {
                continue;
            }
            // The (row, col) map keys are not JSON-representable; the payload
            // is the thread list (each Comment carries its own row/col), in
            // cell order for deterministic bytes.
            let mut threads: Vec<&crate::comments::Comment> = sheet_comments.values().collect();
            threads.sort_by_key(|c| (c.row, c.col));
            if let Ok(value) = serde_json::to_value(&threads) {
                comments.push(persistence::SavedSheetComments {
                    sheet_id: sheet_index_to_id(sheet_ids, idx),
                    comments: value,
                });
            }
        }
    }
    let mut scenarios = Vec::new();
    if let Ok(store) = state.scenarios.lock() {
        let mut indices: Vec<usize> = store.keys().copied().collect();
        indices.sort_unstable();
        for idx in indices {
            let Some(sheet_scenarios) = store.get(&idx) else { continue };
            if sheet_scenarios.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::to_value(sheet_scenarios) {
                scenarios.push(persistence::SavedSheetScenarios {
                    sheet_id: sheet_index_to_id(sheet_ids, idx),
                    scenarios: value,
                });
            }
        }
    }
    let mut outlines = Vec::new();
    if let Ok(store) = state.outlines.lock() {
        let mut indices: Vec<usize> = store.keys().copied().collect();
        indices.sort_unstable();
        for idx in indices {
            let Some(outline) = store.get(&idx) else { continue };
            if outline.row_groups.is_empty() && outline.column_groups.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::to_value(outline) {
                outlines.push(persistence::SavedSheetOutline {
                    sheet_id: sheet_index_to_id(sheet_ids, idx),
                    outline: value,
                });
            }
        }
    }
    (comments, scenarios, outlines)
}

// (build_workbook_snapshot was deleted: .calp publish now builds its carrier
// via build_workbook_for_save_with_slicers — the SAME collector as the .cala
// save path — so package fidelity automatically tracks file fidelity. The
// snapshot was a drifted parallel copy that read stale active-sheet content
// from grids[active] and never carried notes/hyperlinks/hidden rows/page
// setup/controls.)

/// Enrich a workbook with sheet-level metadata from AppState:
/// merged regions, freeze panes, hidden rows/cols, tab colors,
/// sheet visibility, notes, hyperlinks, page setup, and named ranges.
fn enrich_workbook_metadata(workbook: &mut Workbook, state: &AppState, sheet_ids: &[SheetId]) {
    // Populates EVERY sheet's metadata (BUG-0011/BUG-0018: the old version
    // only wrote sheets[0] from the active sheet's state, losing freeze
    // panes, merges, notes etc. for all other sheets).
    if workbook.sheets.is_empty() {
        return;
    }

    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_count = workbook.sheets.len();

    for i in 0..sheet_count {
    // ---- Merged regions ----
    // The active sheet's merges live in the mirror; others in all_merged_regions.
    {
        let to_saved = |r: &crate::MergedRegion| SavedMergedRegion {
            start_row: r.start_row,
            start_col: r.start_col,
            end_row: r.end_row,
            end_col: r.end_col,
        };
        if i == active_sheet {
            if let Ok(regions) = state.merged_regions.lock() {
                workbook.sheets[i].merged_regions = regions.iter().map(to_saved).collect();
            }
        } else if let Ok(all_merged) = state.all_merged_regions.lock() {
            if let Some(regions) = all_merged.get(i) {
                workbook.sheets[i].merged_regions = regions.iter().map(to_saved).collect();
            }
        }
    }

    // ---- Freeze panes ----
    if let Ok(freeze_configs) = state.freeze_configs.lock() {
        if let Some(fc) = freeze_configs.get(i) {
            workbook.sheets[i].freeze_row = fc.freeze_row;
            workbook.sheets[i].freeze_col = fc.freeze_col;
        }
    }

    // ---- Hidden rows/cols (from autofilter + grouping) ----
    // AutoFilter hidden rows
    if let Ok(auto_filters) = state.auto_filters.lock() {
        if let Some(af) = auto_filters.get(&i) {
            for row in &af.hidden_rows {
                workbook.sheets[i].hidden_rows.insert(*row);
            }
        }
    }
    // Grouping hidden rows/cols
    if let Ok(outlines) = state.outlines.lock() {
        if let Some(outline) = outlines.get(&i) {
            for group in &outline.row_groups {
                if group.collapsed {
                    for r in group.start_row..=group.end_row {
                        workbook.sheets[i].hidden_rows.insert(r);
                    }
                }
            }
            for group in &outline.column_groups {
                if group.collapsed {
                    for c in group.start_col..=group.end_col {
                        workbook.sheets[i].hidden_cols.insert(c);
                    }
                }
            }
        }
    }

    // ---- Tab color ----
    if let Ok(tab_colors) = state.tab_colors.lock() {
        if let Some(color) = tab_colors.get(i) {
            workbook.sheets[i].tab_color = color.clone();
        }
    }

    // ---- Sheet visibility ----
    if let Ok(vis) = state.sheet_visibility.lock() {
        if let Some(v) = vis.get(i) {
            workbook.sheets[i].visibility = v.clone();
        }
    }

    // ---- Notes ----
    if let Ok(notes) = state.notes.lock() {
        if let Some(sheet_notes) = notes.get(&i) {
            workbook.sheets[i].notes = sheet_notes
                .values()
                .map(|n| SavedNote {
                    row: n.row,
                    col: n.col,
                    text: n.content.clone(),
                    author: n.author_name.clone(),
                    rich_content: n.rich_content.clone(),
                    width: n.width,
                    height: n.height,
                    visible: n.visible,
                    created_at: n.created_at.clone(),
                    modified_at: n.modified_at.clone().unwrap_or_default(),
                })
                .collect();
        }
    }

    // ---- Hyperlinks ----
    if let Ok(hyperlinks) = state.hyperlinks.lock() {
        if let Some(sheet_links) = hyperlinks.get(&i) {
            workbook.sheets[i].hyperlinks = sheet_links
                .values()
                .map(|h| SavedHyperlink {
                    row: h.row,
                    col: h.col,
                    target: h.target.clone(),
                    display_text: h.display_text.clone(),
                    tooltip: h.tooltip.clone(),
                })
                .collect();
        }
    }

    // ---- Page setup ----
    if let Ok(page_setups) = state.page_setups.lock() {
        if let Some(ps) = page_setups.get(i) {
            workbook.sheets[i].page_setup = Some(SavedPageSetup {
                paper_size: ps.paper_size.clone(),
                orientation: ps.orientation.clone(),
                margin_top: ps.margin_top,
                margin_bottom: ps.margin_bottom,
                margin_left: ps.margin_left,
                margin_right: ps.margin_right,
                margin_header: ps.margin_header,
                margin_footer: ps.margin_footer,
                header: ps.header.clone(),
                footer: ps.footer.clone(),
                print_area: ps.print_area.clone(),
                print_titles_rows: ps.print_titles_rows.clone(),
                manual_row_breaks: ps.manual_row_breaks.clone(),
                print_gridlines: ps.print_gridlines,
                center_horizontally: ps.center_horizontally,
                center_vertically: ps.center_vertically,
                scale: ps.scale,
                fit_to_width: ps.fit_to_width,
                fit_to_height: ps.fit_to_height,
                page_order: ps.page_order.clone(),
                first_page_number: ps.first_page_number,
            });
        }
    }

    // ---- Gridlines visibility ----
    if let Ok(gridlines) = state.show_gridlines.lock() {
        if let Some(&visible) = gridlines.get(i) {
            workbook.sheets[i].show_gridlines = visible;
        }
    }
    } // end per-sheet loop

    // ---- Named ranges (workbook-level) ----
    if let Ok(named_ranges) = state.named_ranges.lock() {
        workbook.named_ranges = named_ranges
            .values()
            .map(|nr| SavedNamedRange {
                name: nr.name.clone(),
                refers_to: nr.refers_to.clone(),
                sheet_id: nr.sheet_index.map(|idx| sheet_index_to_id(sheet_ids, idx)),
                comment: nr.comment.clone(),
                folder: nr.folder.clone(),
            })
            .collect();
    }

    // ---- Conditional formatting + data validation (per-sheet) ----
    let (cf, dv) = collect_cf_dv_for_save(state, sheet_ids);
    workbook.conditional_formats = cf;
    workbook.data_validations = dv;

    // ---- Comments + scenarios + outlines (per-sheet, Wave B) ----
    // Without this, threaded comments, what-if scenarios, and outline-group
    // structure lived only in AppState and vanished on every save/reload
    // (collapsed outline groups survived only as anonymous hidden rows/cols).
    let (comments, scenarios, outlines) =
        collect_comments_scenarios_outlines_for_save(state, sheet_ids);
    workbook.comments = comments;
    workbook.scenarios = scenarios;
    workbook.outlines = outlines;

    // ---- Controls (cell-anchored button/checkbox metadata, per-sheet) ----
    // Without this, onSelect wiring and formula-driven properties lived only
    // in AppState and vanished on every save/reload (and never published).
    if let Ok(controls) = state.controls.lock() {
        workbook.controls = crate::controls::collect_controls_for_save(&controls, sheet_ids);
    }

    // ---- Cell-type assignments (granular bricks, per-sheet) ----
    if let Ok(cell_types) = state.cell_types.lock() {
        workbook.cell_types =
            crate::cell_types::collect_cell_types_for_save(&cell_types, sheet_ids);
    }

    // ---- Cell-behavior bindings (granular bricks phase 2, per-binding) ----
    if let Ok(behaviors) = state.cell_behaviors.lock() {
        workbook.cell_behaviors =
            crate::cell_behaviors::collect_cell_behaviors_for_save(&behaviors, sheet_ids);
    }

    // ---- Protection (sheet-level + per-cell + workbook structure) ----
    // Without this, protect_sheet/protect_workbook/set_cell_protection state
    // (password hashes included) lived only in AppState and every protected
    // workbook reopened fully unprotected.
    let (sheet_protections, workbook_protection) = collect_protection_for_save(state, sheet_ids);
    workbook.sheet_protections = sheet_protections;
    workbook.workbook_protection = workbook_protection;

    attach_pending_recalc_for_save(state, sheet_ids, workbook);
}

/// Record, in the saved workbook, which cells a cancelled recalculation never
/// reached.
///
/// THE SILENT-STALENESS CLOSURE. Without this the pending set was session state
/// only: cancel a recalculation, save, reopen, and the workbook came back with
/// the status bar saying "Ready" over cells still holding pre-recalculation
/// values. Nothing on screen distinguished them from correct ones, and `.calp`
/// publish — which hard-refuses on a pending set — saw an empty one and shipped
/// them. A wrong number that announces nothing is the worst outcome this feature
/// can produce: strictly worse than the `#LIMIT!` the rest of the design works
/// so hard to make visible, because an error argues for itself and a stale
/// number does not.
///
/// Recorded by `SheetId`, not by index: sheets can be inserted, deleted or
/// reordered between the save and the load, and a marker pointing at the WRONG
/// sheet is worse than no marker at all.
pub fn attach_pending_recalc_for_save(
    state: &AppState,
    sheet_ids: &[SheetId],
    workbook: &mut persistence::Workbook,
) {
    workbook.pending_recalc = state
        .pending_recalc
        .lock()
        .ok()
        .and_then(|p| p.clone())
        .filter(|p| !p.is_empty())
        .and_then(|p| {
            sheet_ids.get(p.sheet_index).map(|sheet_id| {
                persistence::SavedPendingRecalc {
                    sheet_id: *sheet_id,
                    cells: p
                        .cells
                        .iter()
                        .map(|c| persistence::SavedPendingCell { row: c.row, col: c.col })
                        .collect(),
                }
            })
        });
}

/// Restore — or CLEAR — the staleness marker when a workbook is opened.
///
/// Assigned unconditionally, never merged: opening a fully-calculated workbook
/// must also DROP the previous document's pending set, or the status bar would
/// keep warning about staleness belonging to a file the user already closed.
/// The `SheetId` is resolved back to this session's sheet index here, which is
/// the whole reason it was persisted as an id rather than an index.
pub fn restore_pending_recalc_on_load(state: &AppState, workbook: &persistence::Workbook) {
    if let Ok(mut pending) = state.pending_recalc.lock() {
        *pending = workbook.pending_recalc.as_ref().map(|p| {
            crate::eval_budget::PendingRecalc {
                sheet_index: sheet_id_to_index(workbook, p.sheet_id),
                cells: p
                    .cells
                    .iter()
                    .map(|c| crate::eval_budget::PendingCell { row: c.row, col: c.col })
                    .collect(),
            }
        });
        if let Some(p) = pending.as_ref() {
            crate::log_warn!(
                "CALC",
                "opened a workbook saved with {} un-recalculated cell(s) — press F9 to finish",
                p.cells.len()
            );
        }
    }
}

/// Collect sheet/cell/workbook protection into the persisted SheetId-keyed
/// opaque carriers. Cell-protection maps are keyed by (row, col) tuples in
/// AppState, which JSON cannot represent as object keys, so they serialize as
/// a `[{ row, col, locked, formulaHidden }]` entry list.
fn collect_protection_for_save(
    state: &AppState,
    sheet_ids: &[SheetId],
) -> (
    Vec<persistence::SavedSheetProtection>,
    Option<serde_json::Value>,
) {
    use std::collections::BTreeMap;

    // Gather per-sheet payloads keyed by sheet index (BTreeMap for
    // deterministic artifact bytes across saves).
    let mut per_sheet: BTreeMap<usize, (Option<serde_json::Value>, Option<serde_json::Value>)> =
        BTreeMap::new();

    if let Ok(store) = state.sheet_protection.lock() {
        for (idx, prot) in store.iter() {
            // Persist any entry that still carries authored intent. The old
            // predicate tested only `protected`/`password_hash` despite a
            // comment claiming it considered options, so an unprotected sheet
            // lost its allow-edit ranges AND its custom options at the next
            // save. That hit the normal authoring order (define the exceptions,
            // THEN protect), the protect -> add ranges -> unprotect -> save
            // sequence, and the record the `obj_sheet_protection` undo arm
            // rebuilds (unprotected + ranges).
            if !prot.protected
                && prot.password_hash.is_none()
                && prot.allow_edit_ranges.is_empty()
                && prot.options == crate::protection::SheetProtectionOptions::default()
            {
                continue;
            }
            if let Ok(v) = serde_json::to_value(prot) {
                per_sheet.entry(*idx).or_default().0 = Some(v);
            }
        }
    }
    // NOTE: `cell_protection` is deliberately NOT written any more. Cell lock
    // state is a CELL FORMAT attribute on `CellStyle` and already rides in the
    // saved style registry, so writing it here too would create a second copy
    // that could disagree with the first. The load path still READS the legacy
    // field, once, to import pre-migration files (see the LEGACY IMPORT block);
    // a re-save then drops it.

    let sheet_protections = per_sheet
        .into_iter()
        .map(
            |(idx, (protection, cell_protection))| persistence::SavedSheetProtection {
                sheet_id: sheet_index_to_id(sheet_ids, idx),
                protection,
                cell_protection,
            },
        )
        .collect();

    let workbook_protection = state
        .workbook_protection
        .lock()
        .ok()
        .filter(|wp| wp.protected)
        .and_then(|wp| serde_json::to_value(&*wp).ok());

    (sheet_protections, workbook_protection)
}

/// Collect slicers from SlicerState into SavedSlicer format.
fn collect_slicers_for_save(
    slicer_state: &State<crate::slicer::SlicerState>,
    sheet_ids: &[SheetId],
) -> Vec<persistence::SavedSlicer> {
    let slicers = slicer_state.slicers.lock().unwrap();
    let computed_props = slicer_state.computed_properties.lock().unwrap();
    slicers
        .values()
        .map(|s| {
            let mut saved = slicer_to_saved(s, sheet_ids);
            // Attach computed properties for this slicer
            if let Some(props) = computed_props.get(&s.id) {
                saved.computed_properties = props
                    .iter()
                    .map(|p| persistence::SavedSlicerComputedProperty {
                        id: p.id,
                        attribute: p.attribute.clone(),
                        formula: p.formula.clone(),
                    })
                    .collect();
            }
            saved
        })
        .collect()
}

fn slicer_to_saved(slicer: &crate::slicer::Slicer, sheet_ids: &[SheetId]) -> persistence::SavedSlicer {
    persistence::SavedSlicer {
        id: slicer.id,
        name: slicer.name.clone(),
        header_text: slicer.header_text.clone(),
        sheet_id: sheet_index_to_id(sheet_ids, slicer.sheet_index),
        x: slicer.x,
        y: slicer.y,
        width: slicer.width,
        height: slicer.height,
        source_type: match slicer.source_type {
            crate::slicer::SlicerSourceType::Table => persistence::SavedSlicerSourceType::Table,
            crate::slicer::SlicerSourceType::Pivot => persistence::SavedSlicerSourceType::Pivot,
            crate::slicer::SlicerSourceType::BiConnection => persistence::SavedSlicerSourceType::BiConnection,
        },
        cache_source_id: slicer.cache_source_id,
        field_name: slicer.field_name.clone(),
        selected_items: slicer.selected_items.clone(),
        show_header: slicer.show_header,
        columns: slicer.columns,
        style_preset: slicer.style_preset.clone(),
        selection_mode: match slicer.selection_mode {
            crate::slicer::SlicerSelectionMode::Standard => persistence::SavedSlicerSelectionMode::Standard,
            crate::slicer::SlicerSelectionMode::Single => persistence::SavedSlicerSelectionMode::Single,
            crate::slicer::SlicerSelectionMode::Multi => persistence::SavedSlicerSelectionMode::Multi,
        },
        hide_no_data: slicer.hide_no_data,
        indicate_no_data: slicer.indicate_no_data,
        sort_no_data_last: slicer.sort_no_data_last,
        force_selection: slicer.force_selection,
        show_select_all: slicer.show_select_all,
        arrangement: match slicer.arrangement {
            crate::slicer::SlicerArrangement::Grid => persistence::SavedSlicerArrangement::Grid,
            crate::slicer::SlicerArrangement::Horizontal => persistence::SavedSlicerArrangement::Horizontal,
            crate::slicer::SlicerArrangement::Vertical => persistence::SavedSlicerArrangement::Vertical,
        },
        rows: slicer.rows,
        item_gap: slicer.item_gap,
        autogrid: slicer.autogrid,
        item_padding: slicer.item_padding,
        button_radius: slicer.button_radius,
        computed_properties: Vec::new(),
        connected_sources: slicer.connected_sources.iter().map(|c| {
            persistence::SavedSlicerConnection {
                source_type: match c.source_type {
                    crate::slicer::SlicerSourceType::Table => persistence::SavedSlicerSourceType::Table,
                    crate::slicer::SlicerSourceType::Pivot => persistence::SavedSlicerSourceType::Pivot,
                    crate::slicer::SlicerSourceType::BiConnection => persistence::SavedSlicerSourceType::BiConnection,
                },
                source_id: c.source_id,
            }
        }).collect(),
    }
}

fn saved_to_slicer(saved: &persistence::SavedSlicer, workbook: &persistence::Workbook) -> crate::slicer::Slicer {
    saved_slicer_to_slicer_at(saved, sheet_id_to_index(workbook, saved.sheet_id))
}

/// Convert one SavedSlicer to the live entity at an explicit LOCAL sheet
/// index. pub(crate): the .calp pull path (calp_commands) materializes pulled
/// slicers through the same converter — it resolves the PACKAGE sheet id to
/// the local index itself — so wire-format handling can never drift from
/// .cala load.
pub(crate) fn saved_slicer_to_slicer_at(
    saved: &persistence::SavedSlicer,
    sheet_index: usize,
) -> crate::slicer::Slicer {
    crate::slicer::Slicer {
        id: saved.id,
        name: saved.name.clone(),
        header_text: saved.header_text.clone(),
        sheet_index,
        x: saved.x,
        y: saved.y,
        width: saved.width,
        height: saved.height,
        source_type: match saved.source_type {
            persistence::SavedSlicerSourceType::Table => crate::slicer::SlicerSourceType::Table,
            persistence::SavedSlicerSourceType::Pivot => crate::slicer::SlicerSourceType::Pivot,
            persistence::SavedSlicerSourceType::BiConnection => crate::slicer::SlicerSourceType::BiConnection,
        },
        cache_source_id: saved.cache_source_id,
        field_name: saved.field_name.clone(),
        selected_items: saved.selected_items.clone(),
        show_header: saved.show_header,
        columns: saved.columns,
        style_preset: saved.style_preset.clone(),
        selection_mode: match saved.selection_mode {
            persistence::SavedSlicerSelectionMode::Standard => crate::slicer::SlicerSelectionMode::Standard,
            persistence::SavedSlicerSelectionMode::Single => crate::slicer::SlicerSelectionMode::Single,
            persistence::SavedSlicerSelectionMode::Multi => crate::slicer::SlicerSelectionMode::Multi,
        },
        hide_no_data: saved.hide_no_data,
        indicate_no_data: saved.indicate_no_data,
        sort_no_data_last: saved.sort_no_data_last,
        force_selection: saved.force_selection,
        show_select_all: saved.show_select_all,
        arrangement: match saved.arrangement {
            persistence::SavedSlicerArrangement::Grid => crate::slicer::SlicerArrangement::Grid,
            persistence::SavedSlicerArrangement::Horizontal => crate::slicer::SlicerArrangement::Horizontal,
            persistence::SavedSlicerArrangement::Vertical => crate::slicer::SlicerArrangement::Vertical,
        },
        rows: saved.rows,
        item_gap: saved.item_gap,
        autogrid: saved.autogrid,
        item_padding: saved.item_padding,
        button_radius: saved.button_radius,
        connected_sources: saved.connected_sources.iter().map(|c| {
            crate::slicer::SlicerConnection {
                source_type: match c.source_type {
                    persistence::SavedSlicerSourceType::Table => crate::slicer::SlicerSourceType::Table,
                    persistence::SavedSlicerSourceType::Pivot => crate::slicer::SlicerSourceType::Pivot,
                    persistence::SavedSlicerSourceType::BiConnection => crate::slicer::SlicerSourceType::BiConnection,
                },
                source_id: c.source_id,
            }
        }).collect(),
    }
}

/// Rebuild a saved slicer's computed properties (formula-driven attributes)
/// as live entities, re-parsing each formula into a cached AST. pub(crate):
/// shared with the .calp pull materializer (calp_commands) so restored
/// computed properties behave identically to .cala load.
pub(crate) fn slicer_computed_props_from_saved(
    saved: &persistence::SavedSlicer,
) -> Vec<crate::slicer::computed::SlicerComputedProperty> {
    saved
        .computed_properties
        .iter()
        .map(|sp| {
            let cached_ast = parser::parse(&sp.formula)
                .ok()
                .map(|parsed| crate::convert_expr(&parsed));
            crate::slicer::computed::SlicerComputedProperty {
                id: sp.id,
                slicer_id: saved.id,
                attribute: sp.attribute.clone(),
                formula: sp.formula.clone(),
                cached_ast,
                cached_value: None,
            }
        })
        .collect()
}

/// Restore slicers from SavedSlicer format into SlicerState.
fn restore_slicers(
    saved_slicers: &[persistence::SavedSlicer],
    slicer_state: &State<crate::slicer::SlicerState>,
    workbook: &persistence::Workbook,
) {
    let mut slicers = slicer_state.slicers.lock().unwrap();
    let mut computed_props = slicer_state.computed_properties.lock().unwrap();

    slicers.clear();
    computed_props.clear();

    for saved in saved_slicers {
        let slicer = saved_to_slicer(saved, workbook);
        let slicer_id = slicer.id;
        slicers.insert(slicer.id, slicer);

        // Restore computed properties
        if !saved.computed_properties.is_empty() {
            computed_props.insert(slicer_id, slicer_computed_props_from_saved(saved));
        }
    }
}

// ============================================================================
// RibbonFilter <-> SavedRibbonFilter conversion
// ============================================================================

/// Collect ribbon filters from RibbonFilterState into SavedRibbonFilter format.
fn collect_ribbon_filters_for_save(
    ribbon_filter_state: &State<crate::ribbon_filter::RibbonFilterState>,
) -> Vec<persistence::SavedRibbonFilter> {
    let filters = ribbon_filter_state.filters.lock().unwrap();
    filters
        .values()
        .map(|f| ribbon_filter_to_saved(f))
        .collect()
}

fn ribbon_filter_to_saved(f: &crate::ribbon_filter::RibbonFilter) -> persistence::SavedRibbonFilter {
    persistence::SavedRibbonFilter {
        id: f.id,
        name: f.name.clone(),
        connection_id: f.connection_id,
        data_source_id: f.data_source_id.clone(),
        field_name: f.field_name.clone(),
        field_data_type: f.field_data_type.clone(),
        connection_mode: match f.connection_mode {
            crate::ribbon_filter::ConnectionMode::Manual => persistence::SavedConnectionMode::Manual,
            crate::ribbon_filter::ConnectionMode::BySheet => persistence::SavedConnectionMode::BySheet,
            crate::ribbon_filter::ConnectionMode::Workbook => persistence::SavedConnectionMode::Workbook,
        },
        connected_pivots: f.connected_pivots.clone(),
        connected_sheets: f.connected_sheets.clone(),
        display_mode: match f.display_mode {
            crate::ribbon_filter::RibbonFilterDisplayMode::Checklist => persistence::SavedRibbonFilterDisplayMode::Checklist,
            crate::ribbon_filter::RibbonFilterDisplayMode::Buttons => persistence::SavedRibbonFilterDisplayMode::Buttons,
            crate::ribbon_filter::RibbonFilterDisplayMode::Dropdown => persistence::SavedRibbonFilterDisplayMode::Dropdown,
        },
        selected_items: f.selected_items.clone(),
        cross_filter_targets: f.cross_filter_targets.clone(),
        cross_filter_slicer_targets: f.cross_filter_slicer_targets.clone(),
        advanced_filter: f.advanced_filter.as_ref().map(|af| {
            persistence::SavedAdvancedFilter {
                condition1: persistence::SavedAdvancedFilterCondition {
                    operator: format!("{:?}", af.condition1.operator).to_lowercase(),
                    value: af.condition1.value.clone(),
                },
                condition2: af.condition2.as_ref().map(|c| persistence::SavedAdvancedFilterCondition {
                    operator: format!("{:?}", c.operator).to_lowercase(),
                    value: c.value.clone(),
                }),
                logic: match af.logic {
                    crate::ribbon_filter::AdvancedFilterLogic::And => "and".to_string(),
                    crate::ribbon_filter::AdvancedFilterLogic::Or => "or".to_string(),
                },
            }
        }),
        hide_no_data: f.hide_no_data,
        indicate_no_data: f.indicate_no_data,
        sort_no_data_last: f.sort_no_data_last,
        show_select_all: f.show_select_all,
        single_select: f.single_select,
        order: f.order,
        button_columns: f.button_columns,
        button_rows: f.button_rows,
    }
}

/// Convert one SavedRibbonFilter back to the live entity. pub(crate): the
/// .calp pull path (calp_commands) materializes pulled ribbon filters through
/// the same converter so wire-format handling can never drift from .cala load.
pub(crate) fn saved_to_ribbon_filter(saved: &persistence::SavedRibbonFilter) -> crate::ribbon_filter::RibbonFilter {
    crate::ribbon_filter::RibbonFilter {
        id: saved.id,
        name: saved.name.clone(),
        connection_id: saved.connection_id,
        data_source_id: saved.data_source_id.clone(),
        field_name: saved.field_name.clone(),
        field_data_type: saved.field_data_type.clone(),
        connection_mode: match saved.connection_mode {
            persistence::SavedConnectionMode::Manual => crate::ribbon_filter::ConnectionMode::Manual,
            persistence::SavedConnectionMode::BySheet => crate::ribbon_filter::ConnectionMode::BySheet,
            persistence::SavedConnectionMode::Workbook => crate::ribbon_filter::ConnectionMode::Workbook,
        },
        connected_pivots: saved.connected_pivots.clone(),
        connected_sheets: saved.connected_sheets.clone(),
        display_mode: match saved.display_mode {
            persistence::SavedRibbonFilterDisplayMode::Checklist => crate::ribbon_filter::RibbonFilterDisplayMode::Checklist,
            persistence::SavedRibbonFilterDisplayMode::Buttons => crate::ribbon_filter::RibbonFilterDisplayMode::Buttons,
            persistence::SavedRibbonFilterDisplayMode::Dropdown => crate::ribbon_filter::RibbonFilterDisplayMode::Dropdown,
        },
        selected_items: saved.selected_items.clone(),
        cross_filter_targets: saved.cross_filter_targets.clone(),
        cross_filter_slicer_targets: saved.cross_filter_slicer_targets.clone(),
        advanced_filter: saved.advanced_filter.as_ref().map(|af| {
            crate::ribbon_filter::AdvancedFilter {
                condition1: crate::ribbon_filter::AdvancedFilterCondition {
                    operator: parse_advanced_operator(&af.condition1.operator),
                    value: af.condition1.value.clone(),
                },
                condition2: af.condition2.as_ref().map(|c| crate::ribbon_filter::AdvancedFilterCondition {
                    operator: parse_advanced_operator(&c.operator),
                    value: c.value.clone(),
                }),
                logic: if af.logic == "or" {
                    crate::ribbon_filter::AdvancedFilterLogic::Or
                } else {
                    crate::ribbon_filter::AdvancedFilterLogic::And
                },
            }
        }),
        hide_no_data: saved.hide_no_data,
        indicate_no_data: saved.indicate_no_data,
        sort_no_data_last: saved.sort_no_data_last,
        show_select_all: saved.show_select_all,
        single_select: saved.single_select,
        order: saved.order,
        button_columns: saved.button_columns,
        button_rows: saved.button_rows,
    }
}

fn parse_advanced_operator(s: &str) -> crate::ribbon_filter::AdvancedFilterOperator {
    use crate::ribbon_filter::AdvancedFilterOperator::*;
    match s {
        "islessthan" => IsLessThan,
        "islessthanorequalto" => IsLessThanOrEqualTo,
        "isgreaterthan" => IsGreaterThan,
        "isgreaterthanorequalto" => IsGreaterThanOrEqualTo,
        "contains" => Contains,
        "doesnotcontain" => DoesNotContain,
        "startswith" => StartsWith,
        "doesnotstartwith" => DoesNotStartWith,
        "isafter" => IsAfter,
        "isonorafter" => IsOnOrAfter,
        "isbefore" => IsBefore,
        "isonorbefore" => IsOnOrBefore,
        "is" => Is,
        "isnot" => IsNot,
        "isblank" => IsBlank,
        "isnotblank" => IsNotBlank,
        "isempty" => IsEmpty,
        "isnotempty" => IsNotEmpty,
        _ => Is,
    }
}

/// Restore ribbon filters from SavedRibbonFilter format into RibbonFilterState.
fn restore_ribbon_filters(
    saved_filters: &[persistence::SavedRibbonFilter],
    ribbon_filter_state: &State<crate::ribbon_filter::RibbonFilterState>,
) {
    let mut filters = ribbon_filter_state.filters.lock().unwrap();

    filters.clear();

    for saved in saved_filters {
        let filter = saved_to_ribbon_filter(saved);
        filters.insert(filter.id, filter);
    }
}

// ============================================================================
// PaneControl <-> SavedPaneControl conversion (Controls pane)
// ============================================================================

/// Collect pane controls from PaneControlState into SavedPaneControl format.
/// Sorted by (order, id) for deterministic artifact bytes across saves.
pub(crate) fn collect_pane_controls_for_save(
    pane_control_state: &State<crate::pane_control::PaneControlState>,
) -> Vec<persistence::SavedPaneControl> {
    let controls = pane_control_state.controls.lock().unwrap();
    let mut saved: Vec<persistence::SavedPaneControl> =
        controls.values().map(pane_control_to_saved).collect();
    saved.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    saved
}

fn pane_control_to_saved(c: &crate::pane_control::PaneControl) -> persistence::SavedPaneControl {
    persistence::SavedPaneControl {
        id: c.id,
        name: c.name.clone(),
        control_type: c.control_type.as_type_str().to_string(),
        // Opaque app-owned JSON payloads (like bi_pivot_metadata): the
        // persistence layer never inspects config/value.
        config: serde_json::to_value(&c.config).unwrap_or(serde_json::Value::Null),
        // Option<ControlValue>: None serializes to null (value-less control).
        value: serde_json::to_value(&c.value).unwrap_or(serde_json::Value::Null),
        order: c.order,
    }
}

/// Convert one SavedPaneControl back to the live entity. None (skip) when the
/// control_type string is unknown or the config payload does not deserialize —
/// a single bad control must not fail the whole load. pub(crate): the .calp
/// pull path (calp_commands) materializes pulled pane controls through the
/// same converter so wire-format handling can never drift from .cala load.
pub(crate) fn saved_to_pane_control(
    saved: &persistence::SavedPaneControl,
) -> Option<crate::pane_control::PaneControl> {
    let Some(control_type) = crate::pane_control::PaneControlType::from_type_str(&saved.control_type)
    else {
        crate::log_warn!(
            "PANE_CONTROL",
            "Skipping saved pane control \"{}\" ({}): unknown control type \"{}\"",
            saved.name,
            saved.id,
            saved.control_type
        );
        return None;
    };
    let config: crate::pane_control::PaneControlConfig =
        match serde_json::from_value(saved.config.clone()) {
            Ok(c) => c,
            Err(e) => {
                crate::log_warn!(
                    "PANE_CONTROL",
                    "Skipping saved pane control \"{}\" ({}): bad config payload: {}",
                    saved.name,
                    saved.id,
                    e
                );
                return None;
            }
        };
    // A malformed value degrades to None (control present, no published value)
    // rather than dropping the whole control.
    let value: Option<engine::ControlValue> =
        serde_json::from_value(saved.value.clone()).unwrap_or(None);
    Some(crate::pane_control::PaneControl {
        id: saved.id,
        name: saved.name.clone(),
        control_type,
        config,
        value,
        order: saved.order,
    })
}

/// Restore pane controls from SavedPaneControl format into PaneControlState.
/// Unknown/bad entries are skipped with a warning (see saved_to_pane_control).
fn restore_pane_controls(
    saved_controls: &[persistence::SavedPaneControl],
    pane_control_state: &State<crate::pane_control::PaneControlState>,
) {
    let mut controls = pane_control_state.controls.lock().unwrap();

    controls.clear();

    for saved in saved_controls {
        if let Some(control) = saved_to_pane_control(saved) {
            controls.insert(control.id, control);
        }
    }
}

// ============================================================================
// Chart <-> SavedChart conversion
// ============================================================================

/// Collect charts from AppState into SavedChart format for persistence.
pub(crate) fn collect_charts_for_save(state: &State<AppState>, sheet_ids: &[SheetId]) -> Vec<persistence::SavedChart> {
    let charts = state.charts.lock().unwrap();
    charts
        .iter()
        .map(|c| persistence::SavedChart {
            id: c.id,
            sheet_id: sheet_index_to_id(sheet_ids, c.sheet_index),
            spec_json: c.spec_json.clone(),
        })
        .collect()
}

/// Restore charts from SavedChart format into AppState.
fn restore_charts(saved: &[persistence::SavedChart], state: &State<AppState>, workbook: &persistence::Workbook) {
    let mut charts = state.charts.lock().unwrap();
    charts.clear();
    for s in saved {
        charts.push(crate::api_types::ChartEntry {
            id: s.id,
            sheet_index: sheet_id_to_index(workbook, s.sheet_id),
            spec_json: s.spec_json.clone(),
        });
    }
}

/// Collect sparkline entries from AppState for saving to .cala.
pub(crate) fn collect_sparklines_for_save(state: &State<AppState>, sheet_ids: &[SheetId]) -> Vec<persistence::SavedSparkline> {
    let sparklines = state.sparklines.lock().unwrap();
    sparklines
        .iter()
        .map(|s| persistence::SavedSparkline {
            sheet_id: sheet_index_to_id(sheet_ids, s.sheet_index),
            groups_json: s.groups_json.clone(),
        })
        .collect()
}

/// Restore sparklines from SavedSparkline format into AppState.
fn restore_sparklines(saved: &[persistence::SavedSparkline], state: &State<AppState>, workbook: &persistence::Workbook) {
    let mut sparklines = state.sparklines.lock().unwrap();
    sparklines.clear();
    for s in saved {
        sparklines.push(crate::api_types::SparklineEntry {
            sheet_index: sheet_id_to_index(workbook, s.sheet_id),
            groups_json: s.groups_json.clone(),
        });
    }
}

// ============================================================================
// PIVOT DEFINITION PERSISTENCE (save + load)
// ============================================================================

/// Collect full pivot definitions and BI metadata from PivotState into the Workbook.
/// Also used by calp_publish so packages ship live pivots.
pub(crate) fn collect_pivot_definitions(
    pivot_state: &crate::pivot::types::PivotState,
    state: &AppState,
    workbook: &mut Workbook,
) {
    use persistence::SavedPivotDefinition;
    use crate::pivot::types::SavedBiPivotMetadata;

    let pivot_tables = match pivot_state.pivot_tables.lock() {
        Ok(pt) => pt,
        Err(_) => return,
    };
    let bi_metadata = match pivot_state.bi_metadata.lock() {
        Ok(bm) => bm,
        Err(_) => return,
    };
    let sheet_names = match state.sheet_names.lock() {
        Ok(sn) => sn,
        Err(_) => return,
    };

    for (pivot_id, (def, _cache)) in pivot_tables.iter() {
        let is_bi = bi_metadata.contains_key(pivot_id);
        let source_sheet_index = if !is_bi {
            // For grid pivots, find the source sheet by the destination_sheet name
            // (source data is typically on the same or a known sheet)
            def.destination_sheet.as_ref().and_then(|name|
                sheet_names.iter().position(|n| n == name)
            )
        } else {
            None
        };

        let definition_json = match serde_json::to_value(def) {
            Ok(json) => json,
            Err(_) => continue,
        };

        workbook.pivot_definitions.push(SavedPivotDefinition {
            id: *pivot_id,
            source_type: if is_bi { "bi".to_string() } else { "grid".to_string() },
            source_sheet_index,
            definition: definition_json,
        });
    }

    // Collect BI metadata
    for (pivot_id, meta) in bi_metadata.iter() {
        let saved = SavedBiPivotMetadata {
            pivot_id: *pivot_id,
            model_tables: meta.model_tables.clone(),
            measures: meta.measures.clone(),
            lookup_columns: meta.lookup_columns.iter().cloned().collect(),
            hierarchies: meta.hierarchies.clone(),
            calculation_groups: meta.calculation_groups.clone(),
            data_as_of: meta.data_as_of.clone(),
            drill_through: meta.drill_through.clone(),
            perspectives: meta.perspectives.clone(),
            selected_perspective: meta.selected_perspective.clone(),
            cultures: meta.cultures.clone(),
            // Prefer the carried package data source id; fall back to the
            // live connection UUID (which IS the package ds id at publish
            // time on the authoring machine). Never write the ZERO placeholder.
            data_source_id: meta.data_source_id.clone().or_else(|| {
                if meta.connection_id.is_zero() {
                    None
                } else {
                    Some(meta.connection_id.to_string())
                }
            }),
        };
        match serde_json::to_value(&saved) {
            Ok(json) => workbook.bi_pivot_metadata.push(json),
            Err(_) => continue,
        }
    }
}

/// Restore full pivot definitions and BI metadata from Workbook into PivotState.
/// For grid-sourced pivots, rebuilds the cache from source data.
/// For BI pivots, creates an empty cache (data arrives when user reconnects).
fn restore_pivot_definitions(
    workbook: &Workbook,
    pivot_state: &crate::pivot::types::PivotState,
    state: &AppState,
) {
    use pivot_engine::{PivotCache, PivotDefinition};
    use crate::pivot::types::{BiPivotMetadata, SavedBiPivotMetadata};
    use crate::pivot::operations::{build_cache_from_grid, safe_calculate_pivot, update_pivot_region};

    let mut pivot_tables = match pivot_state.pivot_tables.lock() {
        Ok(pt) => pt,
        Err(_) => return,
    };

    // Clear any existing pivot state
    pivot_tables.clear();

    let grids = match state.grids.lock() {
        Ok(g) => g,
        Err(_) => return,
    };

    for saved in &workbook.pivot_definitions {
        // Deserialize the PivotDefinition from opaque JSON
        let def: PivotDefinition = match serde_json::from_value(saved.definition.clone()) {
            Ok(d) => d,
            Err(e) => {
                crate::log_warn!("PIVOT", "Failed to deserialize pivot definition {}: {}", saved.id, e);
                continue;
            }
        };

        let pivot_id = def.id;

        // Build cache based on source type
        let (cache, view) = if saved.source_type == "grid" {
            // Rebuild cache from source grid data
            let sheet_idx = saved.source_sheet_index.unwrap_or(0);
            if let Some(grid) = grids.get(sheet_idx) {
                match build_cache_from_grid(
                    grid,
                    def.source_start,
                    def.source_end,
                    def.source_has_headers,
                ) {
                    Ok((mut cache, _field_names)) => {
                        // Calculate the pivot to populate aggregates
                        let view = safe_calculate_pivot(&def, &mut cache);
                        (cache, Some(view))
                    }
                    Err(e) => {
                        crate::log_warn!("PIVOT", "Failed to rebuild cache for pivot {}: {}", pivot_id, e);
                        (PivotCache::new(pivot_id, 0), None)
                    }
                }
            } else {
                crate::log_warn!("PIVOT", "Source sheet {} not found for pivot {}", sheet_idx, pivot_id);
                (PivotCache::new(pivot_id, 0), None)
            }
        } else {
            // BI pivot — empty cache until user reconnects
            let mut empty_cache = PivotCache::new(pivot_id, 0);
            let view = safe_calculate_pivot(&def, &mut empty_cache);
            (empty_cache, Some(view))
        };

        // Register the protected region so the frontend can discover this pivot
        if let Some(ref view) = view {
            let sheet_names = state.sheet_names.lock().unwrap();
            let dest_sheet_name = def.destination_sheet.as_deref().unwrap_or("");
            let dest_sheet_idx = sheet_names.iter()
                .position(|n| n == dest_sheet_name)
                .unwrap_or(0);
            drop(sheet_names);
            update_pivot_region(state, pivot_id, dest_sheet_idx, def.destination, view);
        }

        pivot_tables.insert(pivot_id, (def, cache));
    }

    // Restore BI metadata
    let mut bi_metadata = match pivot_state.bi_metadata.lock() {
        Ok(bm) => bm,
        Err(_) => return,
    };
    bi_metadata.clear();

    for meta_json in &workbook.bi_pivot_metadata {
        let saved: SavedBiPivotMetadata = match serde_json::from_value(meta_json.clone()) {
            Ok(m) => m,
            Err(e) => {
                crate::log_warn!("PIVOT", "Failed to deserialize BI metadata: {}", e);
                continue;
            }
        };

        bi_metadata.insert(saved.pivot_id, BiPivotMetadata {
            connection_id: crate::bi::types::ConnectionId::ZERO, // placeholder — resolved when user connects to BI
            // Preserve the package data source id across load — deriving it
            // from connection_id would write ZERO on the next save.
            data_source_id: saved.data_source_id,
            model_tables: saved.model_tables,
            measures: saved.measures,
            hierarchies: saved.hierarchies,
            calculation_groups: saved.calculation_groups,
            data_as_of: saved.data_as_of,
            last_query: None,
            lookup_columns: saved.lookup_columns.into_iter().collect(),
            drill_through: saved.drill_through,
            perspectives: saved.perspectives,
            selected_perspective: saved.selected_perspective,
            cultures: saved.cultures,
        });
    }
}

// ============================================================================
// COMMANDS
// ============================================================================

/// Assemble the COMPLETE workbook snapshot for a full-fidelity save: all
/// sheets (via build_workbook_for_save), slicers, ribbon filters, pane
/// controls, pivot layouts + definitions, object scripts, extension data,
/// scripts/notebooks, BI roles/connections/caches, the user_files artifacts
/// (subscriptions/overrides/audit/writeback/model-writeback/autofilters), and
/// workbook properties. SHARED by save_file and auto_recover_save — any new
/// persisted surface added here reaches BOTH paths, so the recovery snapshot
/// can never silently drift behind the real save again.
#[allow(clippy::too_many_arguments)]
fn assemble_workbook_for_save(
    state: &State<AppState>,
    user_files_state: &State<UserFilesState>,
    slicer_state: &State<crate::slicer::SlicerState>,
    ribbon_filter_state: &State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: &State<crate::pane_control::PaneControlState>,
    script_state: &State<crate::scripting::types::ScriptState>,
    pivot_state: &State<crate::pivot::types::PivotState>,
    bi_state: &State<crate::bi::types::BiState>,
) -> Result<Workbook, String> {
    // Multi-sheet workbook build (BUG-0011: the old inline single-sheet
    // Workbook::from_grid build dropped every sheet but the active one).
    // build_workbook_for_save captures all sheets, tables, charts,
    // sparklines, user files, theme and defaults, and runs the per-sheet
    // metadata enrichment.
    let mut workbook = build_workbook_for_save(state, user_files_state)?;
    let sheet_ids_save = state.sheet_ids.lock().map_err(|e| e.to_string())?;
    workbook.slicers = collect_slicers_for_save(slicer_state, &sheet_ids_save);
    workbook.ribbon_filters = collect_ribbon_filters_for_save(ribbon_filter_state);
    workbook.pane_controls = collect_pane_controls_for_save(pane_control_state);
    workbook.pivot_layouts = state.pivot_layouts.lock().unwrap().clone();
    workbook.object_scripts = state.object_scripts.lock().unwrap().clone();
    workbook.extension_data = state.extension_data.lock().unwrap().clone();
    workbook.scripts = collect_scripts_for_save(script_state);
    workbook.notebooks = collect_notebooks_for_save(script_state);

    // Collect full pivot definitions from PivotState
    collect_pivot_definitions(pivot_state, state, &mut workbook);

    // Capture per-BI-connection "view as" RLS role selections so they survive
    // save/reload (re-applied when the connection is re-created on re-pull).
    workbook.bi_connection_roles = crate::bi::commands::collect_bi_connection_roles(bi_state);

    // Embed locally-authored BI connections (model + spec + bindings, no creds)
    // so they reconstruct on open without the original model file.
    workbook.bi_connections = crate::bi::commands::capture_local_bi_connections(bi_state);

    // Embed each local connection's cached table data (size-guarded) so the
    // pivots are interactive offline on another machine.
    workbook.bi_connection_caches = crate::bi::commands::collect_local_bi_caches(bi_state);

    // Serialize subscription metadata into user_files so it persists in the .cala archive
    {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        if !subs.subscriptions.is_empty() {
            let json = serde_json::to_vec_pretty(&*subs).map_err(|e| e.to_string())?;
            workbook.user_files.insert("subscriptions.json".to_string(), json);
        }
    }

    // Serialize override layer into user_files so it persists in the .cala archive
    {
        let overrides = state.override_layer.lock().map_err(|e| e.to_string())?;
        if !overrides.overrides.is_empty() {
            let json = serde_json::to_vec_pretty(&*overrides).map_err(|e| e.to_string())?;
            workbook.user_files.insert("overrides.json".to_string(), json);
        }
    }

    // Serialize audit log into user_files if enabled or has entries
    {
        let audit = state.audit_log.lock().map_err(|e| e.to_string())?;
        if audit.enabled || !audit.entries.is_empty() {
            let json = serde_json::to_vec_pretty(&*audit).map_err(|e| e.to_string())?;
            workbook.user_files.insert("audit_log.json".to_string(), json);
        }
    }

    // Serialize writeback layer (drafts) into user_files
    {
        let wb_layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
        if !wb_layer.drafts.is_empty() {
            let json = serde_json::to_vec_pretty(&*wb_layer).map_err(|e| e.to_string())?;
            workbook.user_files.insert("writeback_drafts.json".to_string(), json);
        }
    }

    // Serialize model writeback entries (writeback COLUMN history) into
    // user_files — the single source of truth the engine stores rebuild from.
    {
        let store = state.model_writeback.lock().map_err(|e| e.to_string())?;
        if !store.entries.is_empty() {
            let json = serde_json::to_vec_pretty(&*store).map_err(|e| e.to_string())?;
            workbook
                .user_files
                .insert("model_writeback_values.json".to_string(), json);
        }
    }

    // Serialize AutoFilter state (per-sheet filters incl. criteria) into
    // user_files (BUG-0013: filters and the table<->autofilter linkage were
    // lost across save/reload).
    {
        let auto_filters = state.auto_filters.lock().map_err(|e| e.to_string())?;
        if !auto_filters.is_empty() {
            let json = serde_json::to_vec_pretty(&*auto_filters).map_err(|e| e.to_string())?;
            workbook.user_files.insert("autofilters.json".to_string(), json);
        }
    }

    // Serialize author-side writeback DRAFT regions (designated but not yet
    // published) — without this an author who saves and reopens before
    // publishing loses every region designation.
    {
        let regions = state.writeback_draft_regions.lock().map_err(|e| e.to_string())?;
        if !regions.is_empty() {
            let json = serde_json::to_vec_pretty(&*regions).map_err(|e| e.to_string())?;
            workbook
                .user_files
                .insert("writeback_draft_regions.json".to_string(), json);
        }
    }

    // Serialize CUSTOM named cell styles (gallery definitions). Persisted
    // self-contained (resolved CellStyle, not a registry index) so restore is
    // immune to the load-time style-registry remap. Built-ins are seeded at
    // startup and never persisted.
    if let Some(json) = crate::named_styles_cmd::collect_named_styles_for_save(state) {
        workbook.user_files.insert("named_styles.json".to_string(), json);
    }

    // Serialize computed properties (formula-driven attribute bindings).
    // Restore rebuilds ASTs + the dependency maps + the id counter.
    if let Some(json) = crate::computed_properties::collect_computed_properties_for_save(state) {
        workbook
            .user_files
            .insert("computed_properties.json".to_string(), json);
    }

    // Copy workbook properties (read-only; last_modified stamping is the
    // caller's decision — save_file stamps, auto-recover does not).
    {
        let props = state.workbook_properties.lock().unwrap();
        workbook.properties = persistence::WorkbookProperties {
            title: props.title.clone(),
            author: props.author.clone(),
            subject: props.subject.clone(),
            description: props.description.clone(),
            keywords: props.keywords.clone(),
            category: props.category.clone(),
            created: props.created.clone(),
            last_modified: props.last_modified.clone(),
        };
    }

    // Serialize the scheduled-job registry (the `schedule` capability's
    // persisted half). This runs LAST among the script-related sections because
    // it reads back the object scripts and module scripts already placed on
    // `workbook` above — the schedule is bound to the code this very save is
    // writing, not to whatever happens to be in memory.
    persist_scheduled_jobs(&mut workbook);

    // Sheet-level metadata was already enriched by build_workbook_for_save.
    drop(sheet_ids_save);
    Ok(workbook)
}

// ============================================================================
// SCHEDULED JOBS (the `schedule` capability's .cala round-trip)
// ============================================================================

/// SHA-256 of every script this workbook CARRIES, keyed by script id.
///
/// One function, used by both the save and the load side on purpose: the set of
/// scripts a job may be bound to is then identical in both directions by
/// construction, so the save path can never write a binding the load path is
/// obliged to reject.
///
/// Only executable script surfaces are included. Notebooks are deliberately
/// absent: they have no `context.expose` surface, cannot be the target of a
/// scheduled call, and including them would let a job name something that can
/// never legitimately answer it.
fn workbook_script_hashes(workbook: &Workbook) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for s in &workbook.object_scripts {
        out.insert(s.id.clone(), calp::integrity::sha256_hex(s.source.as_bytes()));
    }
    for s in &workbook.scripts {
        out.insert(s.id.clone(), calp::integrity::sha256_hex(s.source.as_bytes()));
    }
    out
}

/// Write the scheduled-job registry into the workbook's user-files section.
///
/// The key is REMOVED when there is nothing to persist rather than merely left
/// alone. `user_files` is also the user-visible virtual filesystem, so a file
/// literally named `scheduled_jobs.json` could otherwise be planted through
/// `create_virtual_file` and survive into the archive as a schedule nobody
/// registered. Unconditionally owning the key means the section always reflects
/// the live registry and nothing else. (Even a planted file could only ever name
/// an already-consented script's already-exposed method — the load path proves
/// that — but "the save path owns this key" is a cheaper invariant to hold than
/// "every possible planted value is harmless".)
fn persist_scheduled_jobs(workbook: &mut Workbook) {
    use calcula_format::features::scheduled_jobs::{ScheduledJobsFile, SCHEDULED_JOBS_FILE};

    let hashes = workbook_script_hashes(workbook);
    let jobs = crate::scripting::scheduler::export_jobs_for_workbook(&hashes);
    if jobs.is_empty() {
        workbook.user_files.remove(SCHEDULED_JOBS_FILE);
        return;
    }
    match ScheduledJobsFile::new(jobs).to_json_bytes() {
        Ok(bytes) => {
            workbook
                .user_files
                .insert(SCHEDULED_JOBS_FILE.to_string(), bytes);
        }
        Err(e) => {
            // Never write a half-formed schedule: an unreadable section would be
            // dropped on the next load anyway, and a truncated one is worse.
            crate::log_warn!("SECURITY", "scheduled jobs could not be serialized: {}", e);
            workbook.user_files.remove(SCHEDULED_JOBS_FILE);
        }
    }
}

/// Restore the scheduled-job registry from a freshly loaded workbook.
///
/// Called from `open_file` AFTER the workbook's scripts, object scripts and
/// audit log have been restored, because all three are inputs: the scripts
/// decide which jobs are still valid, and the audit log is where every refusal
/// is recorded (running earlier would have the restored log overwrite them).
///
/// This never grants, mounts or starts anything — see the threat model at the
/// top of scripting/scheduler.rs. An absent section clears the registry, so the
/// previous workbook's schedule cannot leak into this document.
///
/// Takes the audit log directly rather than `State<AppState>` so the whole
/// restore — including every refusal path — is exercisable in a unit test
/// without a Tauri app handle.
fn restore_scheduled_jobs(
    audit_log: &Mutex<calp::audit::AuditLog>,
    workbook: &mut Workbook,
) {
    use calcula_format::features::scheduled_jobs::{ScheduledJobsFile, SCHEDULED_JOBS_FILE};

    let hashes = workbook_script_hashes(workbook);
    let defs = match workbook.user_files.remove(SCHEDULED_JOBS_FILE) {
        Some(bytes) => match ScheduledJobsFile::from_json_bytes(&bytes) {
            Ok(file) => file.jobs,
            Err(e) => {
                // A malformed section disarms the whole schedule rather than
                // being partially decoded — see ScheduledJobsFile::from_json_bytes.
                crate::log_warn!(
                    "SECURITY",
                    "scheduled_jobs.json could not be parsed; no jobs restored: {}",
                    e
                );
                crate::net_commands::record_capability_call(
                    audit_log,
                    crate::scripting::scheduler::SCHEDULE_CAPABILITY,
                    "",
                    false,
                    Some("restore scheduled jobs"),
                    Some("scheduled_jobs.json is unreadable; every job was discarded"),
                );
                Vec::new()
            }
        },
        None => Vec::new(),
    };

    let outcome = crate::scripting::scheduler::import_jobs_for_workbook(defs, &hashes);
    for dropped in &outcome.dropped {
        crate::log_warn!(
            "SECURITY",
            "scheduled job discarded on load: script={} handler={} reason={}",
            dropped.script_id,
            dropped.handler,
            dropped.reason
        );
        crate::net_commands::record_capability_call(
            audit_log,
            crate::scripting::scheduler::SCHEDULE_CAPABILITY,
            &dropped.script_id,
            false,
            Some(&format!("restore scheduled job for {}", dropped.handler)),
            Some(&dropped.reason),
        );
    }
    if outcome.restored > 0 {
        // The restore itself is audited too. A workbook that arrives already
        // knowing what it wants to run on a timer is exactly the thing the
        // transparency trail exists to make visible.
        crate::net_commands::record_capability_call(
            audit_log,
            crate::scripting::scheduler::SCHEDULE_CAPABILITY,
            "",
            true,
            Some(&format!(
                "restored {} scheduled job(s) from the workbook (each still requires its script to be mounted, consented and granted before it can run)",
                outcome.restored
            )),
            None,
        );
    }
}

#[tauri::command]
pub fn save_file(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    script_state: State<crate::scripting::types::ScriptState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    path: String,
    // Optional passphrase. `Some` encrypts (and becomes the session password);
    // `None` falls back to the session password so a plain Ctrl+S keeps an
    // already-encrypted document encrypted. Ignored for non-`.cala` formats.
    password: Option<String>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // If calculate_before_save is enabled, recalculate all formulas first
    {
        let calc_before_save = *state.calculate_before_save.lock().unwrap();
        if calc_before_save {
            // This also RESUMES a cancelled pass: calculate_now starts from the
            // pending set when there is one and clears it on a clean finish, so
            // "recalculate before saving" really does mean the saved file is
            // fully calculated.
            let _ = crate::calculation::calculate_now(
                window.clone(),
                state.clone(),
                user_files_state.clone(),
                pivot_state.clone(),
                pane_control_state.clone(),
                ribbon_filter_state.clone(),
                None,
            );
        } else if state
            .pending_recalc
            .lock()
            .ok()
            .is_some_and(|p| p.as_ref().is_some_and(|pr| !pr.is_empty()))
        {
            // Saving a workbook whose recalculation was cancelled. The pending
            // set is NOT cleared here — it survives in the session so the status
            // bar keeps saying "Calculate" and the stale cells stay locatable.
            // Deliberately not a hard refusal: the user turned automatic
            // recalculation off on purpose, and refusing to save their work
            // because of it would be the wrong trade.
            crate::log_warn!(
                "SAVE",
                "saving with un-recalculated cells (a cancelled recalculation was not resumed)"
            );
        }
    }

    // Stamp last_modified BEFORE assembly so the snapshot carries it (the
    // background auto-recover path deliberately does NOT stamp).
    {
        let mut props = state.workbook_properties.lock().unwrap();
        props.last_modified = chrono::Utc::now().to_rfc3339();
    }

    // Full-fidelity workbook assembly, shared with auto_recover_save (the
    // recovery path previously used its own drifted single-sheet builder and
    // silently dropped every non-active sheet, all pivots, BI models and
    // user_files artifacts).
    let workbook = assemble_workbook_for_save(
        &state,
        &user_files_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &script_state,
        &pivot_state,
        &bi_state,
    )?;

    let path_buf = PathBuf::from(&path);

    // Route by file extension
    let ext = path_buf
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Resolve the effective passphrase: an explicit arg wins; otherwise fall
    // back to the session passphrase so a plain re-save keeps an encrypted
    // document encrypted without re-prompting.
    let effective_pw: Option<Zeroizing<String>> = match password {
        Some(pw) => Some(Zeroizing::new(pw)),
        None => file_state
            .session_password
            .lock()
            .map_err(|e| e.to_string())?
            .clone(),
    };

    match ext.as_str() {
        "cala" => {
            let pw_bytes = effective_pw.as_ref().map(|z| z.as_bytes());
            save_calcula_opt(&workbook, &path_buf, pw_bytes).map_err(|e| e.to_string())?;
        }
        // xlsx (and any other format) is never encrypted; the passphrase is ignored.
        _ => save_xlsx(&workbook, &path_buf).map_err(|e| e.to_string())?,
    }

    // Persist the session encryption state for subsequent saves. A `.cala` save
    // adopts the effective passphrase; saving to any other format drops it.
    {
        let mut sess = file_state.session_password.lock().map_err(|e| e.to_string())?;
        let mut enc = file_state.is_encrypted.lock().map_err(|e| e.to_string())?;
        if ext == "cala" {
            *enc = effective_pw.is_some();
            *sess = effective_pw;
        } else {
            *sess = None;
            *enc = false;
        }
    }

    *file_state.current_path.lock().map_err(|e| e.to_string())? = Some(path_buf);
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = false;

    Ok(())
}

#[tauri::command]
pub fn open_file(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    script_state: State<crate::scripting::types::ScriptState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    path: String,
    // Optional passphrase for an encrypted `.cala`. When the file is encrypted
    // and this is `None` (or wrong), the command returns a sentinel error string
    // (ENC_NEEDS_PASSWORD / ENC_WRONG_PASSWORD / ENC_CORRUPT) the frontend
    // branches on to prompt and retry.
    password: Option<String>,
    window: tauri::Window,
) -> Result<Vec<CellData>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let path_buf = PathBuf::from(&path);

    // Route by file extension
    let ext = path_buf
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut workbook = match ext.as_str() {
        "cala" => {
            let pw_bytes = password.as_ref().map(|s| s.as_bytes());
            match load_calcula_opt(&path_buf, pw_bytes) {
                Ok(wb) => wb,
                Err(calcula_format::FormatError::NeedsPassword) => {
                    return Err("ENC_NEEDS_PASSWORD".to_string())
                }
                Err(calcula_format::FormatError::WrongPassword) => {
                    return Err("ENC_WRONG_PASSWORD".to_string())
                }
                Err(calcula_format::FormatError::EncryptedCorrupt(_)) => {
                    return Err("ENC_CORRUPT".to_string())
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        _ => load_xlsx(&path_buf).map_err(|e| e.to_string())?,
    };

    if workbook.sheets.is_empty() {
        return Err("No sheets in workbook".to_string());
    }

    let active_idx = workbook.active_sheet.min(workbook.sheets.len() - 1);

    // Restore tables from the workbook metadata
    let (new_tables, new_table_names) = restore_tables(&workbook.tables, &workbook);

    {
        // Build a single shared StyleRegistry from all sheets.
        // Each sheet's to_grid() returns its own local registry; we merge them
        // into one shared registry and remap cell style_index values.
        let mut shared_styles = engine::style::StyleRegistry::new();
        let mut all_grids: Vec<engine::grid::Grid> = Vec::with_capacity(workbook.sheets.len());
        let mut all_cw_vec: Vec<std::collections::HashMap<u32, f64>> = Vec::with_capacity(workbook.sheets.len());
        let mut all_rh_vec: Vec<std::collections::HashMap<u32, f64>> = Vec::with_capacity(workbook.sheets.len());

        for sheet in &workbook.sheets {
            let (mut grid, local_styles) = sheet.to_grid();

            // Remap local style indices (cells AND the row/column tiers, which
            // this merge used to skip) to the shared registry. merge_remap
            // preserves the explicit-default duplicates get_or_create_explicit
            // creates — plain interning collapsed them to 0 ("inherit"), which
            // shifted every later index and silently re-locked cells.
            let remap = shared_styles.merge_remap(&local_styles);
            grid.remap_style_indices(&remap);

            all_grids.push(grid);
            all_cw_vec.push(sheet.column_widths.clone());
            all_rh_vec.push(sheet.row_heights.clone());
        }

        // Set sheet names
        let mut names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        *names = workbook.sheets.iter().map(|s| s.name.clone()).collect();

        // Restore sheet IDs from the workbook
        let mut sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        *sheet_ids = workbook.sheets.iter().map(|s| s.id).collect();

        // Set active sheet index
        *state.active_sheet.lock().map_err(|e| e.to_string())? = active_idx;

        // Set the active grid (clone from the all_grids vec)
        let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
        *grid = all_grids[active_idx].clone();

        // Set active sheet dimensions
        let mut col_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
        let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
        *col_widths = all_cw_vec[active_idx].clone();
        *row_heights = all_rh_vec[active_idx].clone();

        // Store per-sheet grids and dimensions
        // Note: set_active_sheet swaps between grids[i] and state.grid,
        // so the active sheet slot in grids holds a copy too.
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        *grids = all_grids;

        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        *all_cw = all_cw_vec;

        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
        *all_rh = all_rh_vec;

        // Set shared style registry
        let mut styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        *styles = shared_styles;

        // Clear dependency maps (will be rebuilt on recalculation)
        let mut deps = state.dependents.lock().map_err(|e| e.to_string())?;
        deps.clear();

        // Restore table state
        let mut tables = state.tables.lock().map_err(|e| e.to_string())?;
        let mut table_names = state.table_names.lock().map_err(|e| e.to_string())?;
        *tables = new_tables;
        *table_names = new_table_names;

        // Restore default dimensions
        *state.default_row_height.lock().unwrap() = workbook.default_row_height;
        *state.default_column_width.lock().unwrap() = workbook.default_column_width;

        // ---- Freeze pane configs for all sheets ----
        let mut freeze_configs = state.freeze_configs.lock().map_err(|e| e.to_string())?;
        freeze_configs.clear();
        for sheet in &workbook.sheets {
            freeze_configs.push(crate::sheets::FreezeConfig {
                freeze_row: sheet.freeze_row,
                freeze_col: sheet.freeze_col,
            });
        }

        // ---- Split configs (reset to defaults for each sheet) ----
        let mut split_configs = state.split_configs.lock().map_err(|e| e.to_string())?;
        split_configs.clear();
        for _ in &workbook.sheets {
            split_configs.push(crate::sheets::SplitConfig::default());
        }

        // ---- Scroll areas (reset to None for each sheet) ----
        let mut scroll_areas = state.scroll_areas.lock().map_err(|e| e.to_string())?;
        scroll_areas.clear();
        for _ in &workbook.sheets {
            scroll_areas.push(None);
        }

        // ---- Tab colors for all sheets ----
        let mut tab_colors = state.tab_colors.lock().map_err(|e| e.to_string())?;
        tab_colors.clear();
        for sheet in &workbook.sheets {
            tab_colors.push(sheet.tab_color.clone());
        }

        // ---- Sheet visibility for all sheets ----
        let mut sheet_visibility = state.sheet_visibility.lock().map_err(|e| e.to_string())?;
        sheet_visibility.clear();
        for sheet in &workbook.sheets {
            sheet_visibility.push(sheet.visibility.clone());
        }

        // ---- Merged regions for ALL sheets ----
        let mut merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
        merged_regions.clear();
        let mut all_merged = state.all_merged_regions.lock().map_err(|e| e.to_string())?;
        all_merged.clear();
        for (sheet_idx, sheet) in workbook.sheets.iter().enumerate() {
            let mut sheet_merges = std::collections::HashSet::new();
            for mr in &sheet.merged_regions {
                sheet_merges.insert(crate::api_types::MergedRegion {
                    start_row: mr.start_row,
                    start_col: mr.start_col,
                    end_row: mr.end_row,
                    end_col: mr.end_col,
                });
            }
            if sheet_idx == active_idx {
                *merged_regions = sheet_merges.clone();
            }
            all_merged.push(sheet_merges);
        }

        // ---- Per-sheet gridlines visibility ----
        let mut show_gridlines = state.show_gridlines.lock().map_err(|e| e.to_string())?;
        show_gridlines.clear();
        for sheet in &workbook.sheets {
            show_gridlines.push(sheet.show_gridlines);
        }

        // ---- Page setups for all sheets ----
        let mut page_setups = state.page_setups.lock().map_err(|e| e.to_string())?;
        page_setups.clear();
        for sheet in &workbook.sheets {
            if let Some(ps) = &sheet.page_setup {
                page_setups.push(crate::api_types::PageSetup {
                    paper_size: ps.paper_size.clone(),
                    orientation: ps.orientation.clone(),
                    margin_top: ps.margin_top,
                    margin_bottom: ps.margin_bottom,
                    margin_left: ps.margin_left,
                    margin_right: ps.margin_right,
                    margin_header: ps.margin_header,
                    margin_footer: ps.margin_footer,
                    header: ps.header.clone(),
                    footer: ps.footer.clone(),
                    print_area: ps.print_area.clone(),
                    print_titles_rows: ps.print_titles_rows.clone(),
                    manual_row_breaks: ps.manual_row_breaks.clone(),
                    print_gridlines: ps.print_gridlines,
                    center_horizontally: ps.center_horizontally,
                    center_vertically: ps.center_vertically,
                    scale: ps.scale,
                    fit_to_width: ps.fit_to_width,
                    fit_to_height: ps.fit_to_height,
                    page_order: ps.page_order.clone(),
                    first_page_number: ps.first_page_number,
                    ..Default::default()
                });
            } else {
                page_setups.push(crate::api_types::PageSetup::default());
            }
        }

        // ---- Notes for all sheets ----
        let mut notes_storage = state.notes.lock().map_err(|e| e.to_string())?;
        notes_storage.clear();
        for (sheet_idx, sheet) in workbook.sheets.iter().enumerate() {
            if !sheet.notes.is_empty() {
                let mut sheet_notes = std::collections::HashMap::new();
                for n in &sheet.notes {
                    sheet_notes.insert((n.row, n.col), crate::notes::Note {
                        id: uuid::Uuid::new_v4().to_string(),
                        row: n.row,
                        col: n.col,
                        sheet_index: sheet_idx,
                        author_name: n.author.clone(),
                        content: n.text.clone(),
                        rich_content: n.rich_content.clone(),
                        // 0 = written by a pre-widening file (or xlsx import):
                        // fall back to the app defaults instead of a 0x0 box.
                        width: if n.width > 0.0 { n.width } else { 200.0 },
                        height: if n.height > 0.0 { n.height } else { 100.0 },
                        visible: n.visible,
                        created_at: if n.created_at.is_empty() {
                            chrono::Utc::now().to_rfc3339()
                        } else {
                            n.created_at.clone()
                        },
                        modified_at: if n.modified_at.is_empty() {
                            None
                        } else {
                            Some(n.modified_at.clone())
                        },
                    });
                }
                notes_storage.insert(sheet_idx, sheet_notes);
            }
        }

        // ---- Hyperlinks for all sheets ----
        let mut hyperlinks_storage = state.hyperlinks.lock().map_err(|e| e.to_string())?;
        hyperlinks_storage.clear();
        for (sheet_idx, sheet) in workbook.sheets.iter().enumerate() {
            if !sheet.hyperlinks.is_empty() {
                let mut sheet_links = std::collections::HashMap::new();
                for h in &sheet.hyperlinks {
                    sheet_links.insert((h.row, h.col), crate::hyperlinks::Hyperlink {
                        row: h.row,
                        col: h.col,
                        sheet_index: sheet_idx,
                        link_type: crate::hyperlinks::HyperlinkType::Url,
                        target: h.target.clone(),
                        internal_ref: None,
                        display_text: h.display_text.clone(),
                        tooltip: h.tooltip.clone(),
                    });
                }
                hyperlinks_storage.insert(sheet_idx, sheet_links);
            }
        }
    }

    // Restore slicers from workbook
    restore_slicers(&workbook.slicers, &slicer_state, &workbook);

    // Restore ribbon filters from workbook
    restore_ribbon_filters(&workbook.ribbon_filters, &ribbon_filter_state);

    // Restore pane controls (Controls pane) from workbook
    restore_pane_controls(&workbook.pane_controls, &pane_control_state);

    // Restore pivot layouts from workbook
    *state.pivot_layouts.lock().unwrap() = workbook.pivot_layouts.clone();

    // Restore full pivot definitions into PivotState
    restore_pivot_definitions(&workbook, &pivot_state, &state);

    // Reconstruct locally-authored BI connections (embedded model + spec +
    // bindings) and remap each pivot's connection_id by its stable data_source_id
    // so local BI pivots reconnect on open without a manual reconnect.
    {
        let id_map = crate::bi::commands::restore_local_bi_connections(
            &bi_state,
            &workbook.bi_connections,
            &workbook.bi_connection_caches,
        );
        if !id_map.is_empty() {
            if let Ok(mut bi_meta) = pivot_state.bi_metadata.lock() {
                for meta in bi_meta.values_mut() {
                    if let Some(conn_id) = meta
                        .data_source_id
                        .as_deref()
                        .and_then(|ds| id_map.get(ds))
                    {
                        meta.connection_id = *conn_id;
                    }
                }
            }
        }
    }

    // Stage saved "view as" RLS roles so they re-attach when the BI connection
    // is (re)created (e.g. on the next package re-pull) and apply to any that
    // already exist in this session (incl. the locals just reconstructed).
    crate::bi::commands::load_pending_roles(&bi_state, &workbook.bi_connection_roles);

    // Restore object scripts (scriptable objects) from workbook
    *state.object_scripts.lock().unwrap() = workbook.object_scripts.clone();
    *state.extension_data.lock().unwrap() = workbook.extension_data.clone();

    // Restore grid reports from extension_data (their cells reload as ordinary
    // grid content; re-register each report's protected region from its bounds).
    {
        let reports: Vec<crate::report::SavedReport> = state
            .extension_data
            .lock()
            .unwrap()
            .get(crate::report::REPORTS_EXT_KEY)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        for r in &reports {
            crate::report::reregister_report_region(&state, r);
        }
        *state.report_definitions.lock().unwrap() = reports;
    }

    // Restore named ranges (defined names). The save builders populate
    // workbook.named_ranges and the format now serializes them, but without this
    // the parsed names never reach runtime state — so defined names silently
    // vanished on every reload. Map the persisted SheetId back to this session's
    // sheet index (workbook-scoped names carry no sheet_id).
    if let Ok(mut named_ranges) = state.named_ranges.lock() {
        named_ranges.clear();
        for nr in &workbook.named_ranges {
            // The map is keyed by the UPPERCASED name (case-insensitive lookup
            // invariant shared with create/update/rename/delete + the BI insert);
            // the struct keeps the original-case name for display.
            named_ranges.insert(
                nr.name.to_uppercase(),
                crate::named_ranges::NamedRange {
                    name: nr.name.clone(),
                    sheet_index: nr.sheet_id.map(|id| sheet_id_to_index(&workbook, id)),
                    refers_to: nr.refers_to.clone(),
                    comment: nr.comment.clone(),
                    folder: nr.folder.clone(),
                },
            );
        }
    }

    // Restore conditional formatting + data validation (per-sheet). Map the
    // persisted SheetId back to this session's sheet index, deserialize the
    // app-owned opaque payloads, and advance next_cf_rule_id past any restored
    // CF id so a later add_conditional_format can't collide. Like named ranges,
    // these were silently lost on every reload before this.
    if let Ok(mut store) = state.conditional_formats.lock() {
        store.clear();
        let mut max_id: u64 = 0;
        for entry in &workbook.conditional_formats {
            let idx = sheet_id_to_index(&workbook, entry.sheet_id);
            if let Ok(defs) = serde_json::from_value::<
                Vec<crate::conditional_formatting::ConditionalFormatDefinition>,
            >(entry.rules.clone())
            {
                for d in &defs {
                    max_id = max_id.max(d.id);
                }
                store.entry(idx).or_default().extend(defs);
            }
        }
        if let Ok(mut next_id) = state.next_cf_rule_id.lock() {
            if *next_id <= max_id {
                *next_id = max_id + 1;
            }
        }
    }
    if let Ok(mut store) = state.data_validations.lock() {
        store.clear();
        for entry in &workbook.data_validations {
            let idx = sheet_id_to_index(&workbook, entry.sheet_id);
            if let Ok(ranges) = serde_json::from_value::<
                Vec<crate::data_validation::ValidationRange>,
            >(entry.ranges.clone())
            {
                store.entry(idx).or_default().extend(ranges);
            }
        }
    }

    // Restore (or CLEAR) the staleness left by a cancelled recalculation.
    restore_pending_recalc_on_load(&state, &workbook);

    // Restore protection (sheet-level + per-cell + workbook structure). The
    // stores are cleared FIRST so a file without protection never inherits the
    // previous session's locks. Like CF/DV, all of this was lost on every
    // reload before this — a protected workbook reopened fully unprotected.
    if let Ok(mut sheet_prot) = state.sheet_protection.lock() {
        sheet_prot.clear();
        for entry in &workbook.sheet_protections {
            let idx = sheet_id_to_index(&workbook, entry.sheet_id);
            if let Some(ref v) = entry.protection {
                if let Ok(p) =
                    serde_json::from_value::<crate::protection::SheetProtection>(v.clone())
                {
                    sheet_prot.insert(idx, p);
                }
            }
        }
    }
    // LEGACY IMPORT: cell lock state used to live in a side map
    // (`sheet_protections[].cell_protection`); it is now a CELL FORMAT attribute
    // on `CellStyle`. Files written before the migration still carry the side
    // map, and simply ignoring it would silently RE-LOCK every cell the author
    // had unlocked — no error, no warning, and the sheet would just stop being
    // editable where it used to be. So translate each entry into a style stamp
    // on the cell it names.
    //
    // One-way and idempotent: the save path no longer writes `cell_protection`,
    // so a re-save drops the legacy field and this loop finds nothing next time.
    {
        // `state.grid` is the authoritative mirror for the ACTIVE sheet and was
        // already cloned out of `all_grids` earlier in this function, so writing
        // only `grids[idx]` would leave the active sheet un-imported.
        let active_sheet = *state.active_sheet.lock().unwrap();
        let mut active_grid = state.grid.lock().unwrap();
        let mut grids = state.grids.lock().unwrap();
        let mut styles = state.style_registry.lock().unwrap();
        for entry in &workbook.sheet_protections {
            let idx = sheet_id_to_index(&workbook, entry.sheet_id);
            let Some(ref v) = entry.cell_protection else { continue };
            let Some(entries) = v.as_array() else { continue };
            let Some(grid) = grids.get_mut(idx) else { continue };
            for e in entries {
                let (Some(row), Some(col)) = (
                    e.get("row").and_then(|v| v.as_u64()),
                    e.get("col").and_then(|v| v.as_u64()),
                ) else {
                    continue;
                };
                let (row, col) = (row as u32, col as u32);
                let locked = e.get("locked").and_then(|v| v.as_bool()).unwrap_or(true);
                let formula_hidden = e
                    .get("formulaHidden")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                // Start from whatever style the cell already resolves to, so the
                // import changes ONLY the protection attributes.
                let mut style = styles.get(grid.effective_style_index(row, col)).clone();
                if style.locked == locked && style.formula_hidden == formula_hidden {
                    continue;
                }
                style.locked = locked;
                style.formula_hidden = formula_hidden;
                // Explicit: a per-cell stamp must not land on index 0, which a
                // cell reads as "inherit from the row/column tier".
                let style_index = styles.get_or_create_explicit(style);

                let mut cell = grid.get_cell(row, col).cloned().unwrap_or_else(|| engine::Cell {
                    value: engine::CellValue::Empty,
                    ast: None,
                    style_index: 0,
                    rich_text: None,
                });
                cell.style_index = style_index;
                grid.set_cell(row, col, cell.clone());
                if idx == active_sheet {
                    active_grid.set_cell(row, col, cell);
                }
            }
        }
    }
    if let Ok(mut wb_prot) = state.workbook_protection.lock() {
        *wb_prot = workbook
            .workbook_protection
            .as_ref()
            .and_then(|v| {
                serde_json::from_value::<crate::protection::WorkbookProtection>(v.clone()).ok()
            })
            .unwrap_or_default();
    }

    // Restore controls (cell-anchored button/checkbox metadata). Like CF/DV
    // these were lost on every reload before this — the CellStyle button flag
    // survived but the onSelect wiring and formula properties did not.
    if let Ok(mut controls) = state.controls.lock() {
        controls.clear();
        crate::controls::materialize_saved_controls(
            &workbook.controls,
            &mut controls,
            |sid| Some(sheet_id_to_index(&workbook, sid)),
        );
    }

    // Restore cell-type assignments (granular bricks: typed cells).
    if let Ok(mut cell_types) = state.cell_types.lock() {
        cell_types.clear();
        crate::cell_types::materialize_saved_cell_types(
            &workbook.cell_types,
            &mut cell_types,
            |sid| Some(sheet_id_to_index(&workbook, sid)),
        );
    }

    // Restore cell-behavior bindings (granular bricks phase 2).
    if let Ok(mut behaviors) = state.cell_behaviors.lock() {
        behaviors.clear();
        crate::cell_behaviors::materialize_saved_cell_behaviors(
            &workbook.cell_behaviors,
            &mut behaviors,
            |sid| Some(sheet_id_to_index(&workbook, sid)),
        );
    }

    // Restore threaded comments (Wave B). Like CF/DV these were silently lost
    // on every reload before this. The persisted payload is the thread list;
    // rebuild the (row, col)-keyed store and re-stamp each thread's
    // sheet_index with THIS session's index (the persisted one is stale).
    if let Ok(mut store) = state.comments.lock() {
        store.clear();
        for entry in &workbook.comments {
            let idx = sheet_id_to_index(&workbook, entry.sheet_id);
            if let Ok(threads) =
                serde_json::from_value::<Vec<crate::comments::Comment>>(entry.comments.clone())
            {
                let sheet_map = store.entry(idx).or_default();
                for mut c in threads {
                    c.sheet_index = idx;
                    sheet_map.insert((c.row, c.col), c);
                }
            }
        }
    }

    // Restore what-if scenarios (Wave B), re-stamping sheet_index like comments.
    if let Ok(mut store) = state.scenarios.lock() {
        store.clear();
        for entry in &workbook.scenarios {
            let idx = sheet_id_to_index(&workbook, entry.sheet_id);
            if let Ok(mut scenarios) =
                serde_json::from_value::<Vec<crate::api_types::Scenario>>(entry.scenarios.clone())
            {
                for s in &mut scenarios {
                    s.sheet_index = idx;
                }
                store.entry(idx).or_default().extend(scenarios);
            }
        }
    }

    // Restore outline groups (Wave B). The collapsed groups' hidden rows/cols
    // were already restored with the sheet metadata; this restores the group
    // STRUCTURE so expand/collapse and outline symbols work after reload.
    if let Ok(mut store) = state.outlines.lock() {
        store.clear();
        for entry in &workbook.outlines {
            let idx = sheet_id_to_index(&workbook, entry.sheet_id);
            if let Ok(outline) =
                serde_json::from_value::<crate::grouping::SheetOutline>(entry.outline.clone())
            {
                store.insert(idx, outline);
            }
        }
    }

    // Restore charts from workbook
    restore_charts(&workbook.charts, &state, &workbook);

    // Restore sparklines from workbook
    restore_sparklines(&workbook.sparklines, &state, &workbook);

    // Restore scripts and notebooks
    restore_scripts(&workbook.scripts, &script_state);
    restore_notebooks(&workbook.notebooks, &script_state);

    // Restore subscription metadata from user_files (if present)
    {
        if let Some(json_bytes) = workbook.user_files.remove("subscriptions.json") {
            if let Ok(subs) = serde_json::from_slice::<calp::manifest::SubscriptionManifest>(&json_bytes) {
                *state.subscriptions.lock().map_err(|e| e.to_string())? = subs;
            }
        } else {
            *state.subscriptions.lock().map_err(|e| e.to_string())? =
                calp::manifest::SubscriptionManifest::default();
        }
    }

    // Restore override layer from user_files (if present)
    {
        if let Some(json_bytes) = workbook.user_files.remove("overrides.json") {
            if let Ok(layer) = serde_json::from_slice::<calp::OverrideLayer>(&json_bytes) {
                *state.override_layer.lock().map_err(|e| e.to_string())? = layer;
            }
        } else {
            *state.override_layer.lock().map_err(|e| e.to_string())? =
                calp::OverrideLayer::new();
        }
    }

    // Restore audit log from user_files (if present)
    {
        if let Some(json_bytes) = workbook.user_files.remove("audit_log.json") {
            if let Ok(log) = serde_json::from_slice::<calp::audit::AuditLog>(&json_bytes) {
                *state.audit_log.lock().map_err(|e| e.to_string())? = log;
            }
        } else {
            *state.audit_log.lock().map_err(|e| e.to_string())? =
                calp::audit::AuditLog::new();
        }
    }

    // Restore the scheduled-job registry. Deliberately placed AFTER the audit
    // log restore above: the drops this records must land in the log the user
    // will actually read, not in one that is about to be replaced.
    restore_scheduled_jobs(&state.audit_log, &mut workbook);

    // Restore writeback layer (drafts) from user_files (if present)
    {
        if let Some(json_bytes) = workbook.user_files.remove("writeback_drafts.json") {
            if let Ok(layer) = serde_json::from_slice::<calp::writeback::WritebackLayer>(&json_bytes) {
                *state.writeback_layer.lock().map_err(|e| e.to_string())? = layer;
            }
        } else {
            *state.writeback_layer.lock().map_err(|e| e.to_string())? =
                calp::writeback::WritebackLayer::new();
        }
    }

    // Restore author-side writeback DRAFT regions (absent file = none).
    {
        let restored: Vec<calp::WritebackRegionDeclaration> = workbook
            .user_files
            .remove("writeback_draft_regions.json")
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        *state.writeback_draft_regions.lock().map_err(|e| e.to_string())? = restored;
    }

    // Restore CUSTOM named cell styles (built-ins stay seeded; customs from a
    // previous session are replaced by this file's set — or removed when the
    // file carries none).
    crate::named_styles_cmd::restore_named_styles(
        &state,
        workbook.user_files.remove("named_styles.json").as_deref(),
    );

    // Restore computed properties (rebuilds ASTs, dependency maps, id counter;
    // absent file = clear).
    crate::computed_properties::restore_computed_properties(
        &state,
        workbook.user_files.remove("computed_properties.json").as_deref(),
    );

    // Restore model writeback entries (writeback COLUMN history) and reset
    // the Blank-projection session floor: this open is a new session, so
    // Blank columns start blank while their history stays intact. The engine
    // feeds run right after (the connections were restored above).
    {
        let restored = workbook
            .user_files
            .remove("model_writeback_values.json")
            .and_then(|bytes| {
                serde_json::from_slice::<crate::bi::writeback::ModelWritebackStore>(&bytes).ok()
            })
            .unwrap_or_default();
        *state.model_writeback.lock().map_err(|e| e.to_string())? = restored;
        *state.model_writeback_floor.lock().map_err(|e| e.to_string())? =
            chrono::Utc::now().to_rfc3339();
    }
    crate::bi::writeback::queue_model_writeback_refresh();

    // Rebuild the in-memory writeback index/declarations from the restored
    // subscriptions' registry manifests. Without this, writeback regions
    // (guards, tints, GATHER data) stay inert after reopening a subscribed
    // workbook until the next pull/refresh.
    crate::calp_commands::rebuild_writeback_index(&state);

    // Re-seed the id registry from the restored override layer. The registry
    // is in-memory only; without this, the first edit of an overridden cell
    // after reopen would mint a NEW CellId and create a duplicate override
    // for the same cell.
    {
        let layer = state.override_layer.lock().map_err(|e| e.to_string())?;
        if !layer.overrides.is_empty() {
            let mut id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
            for ovr in &layer.overrides {
                id_reg.register_cell_with_id(ovr.sheet_id, ovr.position, ovr.cell_id);
            }
        }
    }

    // Restore AutoFilter state from user_files, then re-link tables
    // (BUG-0013: saved_to_table cannot persist auto_filter_id, so the link
    // is reconstructed here the same way table creation establishes it).
    {
        let mut auto_filters = state.auto_filters.lock().map_err(|e| e.to_string())?;
        if let Some(json_bytes) = workbook.user_files.remove("autofilters.json") {
            if let Ok(filters) =
                serde_json::from_slice::<crate::autofilter::AutoFilterStorage>(&json_bytes)
            {
                *auto_filters = filters;
            } else {
                auto_filters.clear();
            }
        } else {
            auto_filters.clear();
        }

        // Re-link each sheet's filter to the ONE table that owns it.
        //
        // This used to stamp `auto_filter_id` onto EVERY filter-button table on
        // the sheet, which is what made ownership unanswerable after a reload:
        // three tables all claimed the sheet's single filter, so deleting or
        // resizing any of them would move or remove it. Storage is still
        // one-per-sheet, so pick the best geometric match — the table whose
        // header row and column span the filter actually covers — and link only
        // that one. Ties break on the lowest (row, col) for determinism.
        let mut tables_guard = state.tables.lock().map_err(|e| e.to_string())?;
        for (sheet_index, sheet_tables) in tables_guard.iter_mut() {
            // Seed a filter from the lowest filter-button table when the
            // workbook has none saved (pre-existing behavior, kept).
            if !auto_filters.contains_key(sheet_index) {
                if let Some(seed) = sheet_tables
                    .values()
                    .filter(|t| t.style_options.show_filter_button)
                    .min_by_key(|t| (t.start_row, t.start_col))
                {
                    auto_filters.insert(
                        *sheet_index,
                        crate::autofilter::AutoFilter::new(
                            seed.start_row,
                            seed.start_col,
                            seed.end_row,
                            seed.end_col,
                        ),
                    );
                }
            }

            // `auto_filter_id` is derived state and is never persisted, so it is
            // recomputed here with the same rule every runtime path uses. This
            // replaces stamping the sheet index onto EVERY filter-button table,
            // which left three tables all claiming one filter after a reload.
            crate::tables::relink_autofilter_owner(
                sheet_tables,
                auto_filters.get(sheet_index),
            );
        }
    }

    *user_files_state.files.lock().map_err(|e| e.to_string())? = workbook.user_files;

    // Restore document theme
    *state.theme.lock().map_err(|e| e.to_string())? = workbook.theme;

    // Restore workbook properties
    {
        let mut props = state.workbook_properties.lock().unwrap();
        *props = crate::api_types::WorkbookProperties {
            title: workbook.properties.title,
            author: workbook.properties.author,
            subject: workbook.properties.subject,
            description: workbook.properties.description,
            keywords: workbook.properties.keywords,
            category: workbook.properties.category,
            created: workbook.properties.created,
            last_modified: workbook.properties.last_modified,
        };
    }

    // Adopt the session encryption state from the file we just opened: an
    // encrypted `.cala` keeps its passphrase for in-place saves; anything else
    // clears it so a previously-open encrypted doc doesn't leak state.
    {
        let opened_encrypted = ext == "cala"
            && calcula_format::is_calcula_encrypted(&path_buf).unwrap_or(false);
        let mut sess = file_state.session_password.lock().map_err(|e| e.to_string())?;
        let mut enc = file_state.is_encrypted.lock().map_err(|e| e.to_string())?;
        if opened_encrypted {
            *sess = password.map(Zeroizing::new);
            *enc = true;
        } else {
            *sess = None;
            *enc = false;
        }
    }

    *file_state.current_path.lock().map_err(|e| e.to_string())? = Some(path_buf);
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = false;

    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;
    let merged = state.merged_regions.lock().map_err(|e| e.to_string())?;

    let cells: Vec<CellData> = grid
        .cells
        .iter()
        .map(|((row, col), cell)| {
            // Honour the row/column style tiers for both the formatted display
            // and the index handed to the frontend.
            let effective_style_index = grid.effective_style_index(*row, *col);
            let style = styles.get(effective_style_index);
            // Look up merge span for this cell
            let (row_span, col_span) = merged
                .iter()
                .find(|r| r.start_row == *row && r.start_col == *col)
                .map(|r| (r.end_row - r.start_row + 1, r.end_col - r.start_col + 1))
                .unwrap_or((1, 1));
            CellData {
                row: *row,
                col: *col,
                formula: cell.formula_string().map(|f| format!("={}", f)),
                display: format_cell_value(&cell.value, style, &locale),
                display_color: None,
                style_index: effective_style_index,
                row_span,
                col_span,
                sheet_index: None,
                rich_text: None,
                accounting_layout: None,
            }
        })
        .collect();

    Ok(cells)
}

#[tauri::command]
pub fn new_file(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    slicer_state: State<crate::slicer::SlicerState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    script_state: State<crate::scripting::types::ScriptState>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    {
        let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
        let mut styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut col_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
        let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
        let mut deps = state.dependents.lock().map_err(|e| e.to_string())?;
        let mut tables = state.tables.lock().map_err(|e| e.to_string())?;
        let mut table_names = state.table_names.lock().map_err(|e| e.to_string())?;

        *grid = engine::grid::Grid::new();
        *styles = engine::style::StyleRegistry::new();
        col_widths.clear();
        row_heights.clear();
        deps.clear();

        // Reset per-sheet grids to a single empty sheet
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        grids.clear();
        grids.push(engine::grid::Grid::new());

        // Reset sheet names to a single "Sheet1"
        let mut sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        *sheet_names = vec!["Sheet1".to_string()];

        // Reset active sheet to 0
        *state.active_sheet.lock().map_err(|e| e.to_string())? = 0;

        // Reset per-sheet dimension storage
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
        all_cw.clear();
        all_cw.push(std::collections::HashMap::new());
        all_rh.clear();
        all_rh.push(std::collections::HashMap::new());

        // Clear table state
        tables.clear();
        table_names.clear();

        // Reset default dimensions
        *state.default_row_height.lock().unwrap() = 24.0;
        *state.default_column_width.lock().unwrap() = 100.0;

        // Reset freeze/split/scroll configs to single default sheet
        let mut freeze_configs = state.freeze_configs.lock().map_err(|e| e.to_string())?;
        freeze_configs.clear();
        freeze_configs.push(crate::sheets::FreezeConfig { freeze_row: None, freeze_col: None });

        let mut split_configs = state.split_configs.lock().map_err(|e| e.to_string())?;
        split_configs.clear();
        split_configs.push(crate::sheets::SplitConfig::default());

        let mut scroll_areas = state.scroll_areas.lock().map_err(|e| e.to_string())?;
        scroll_areas.clear();
        scroll_areas.push(None);

        // Reset tab colors and sheet visibility
        let mut tab_colors = state.tab_colors.lock().map_err(|e| e.to_string())?;
        tab_colors.clear();
        tab_colors.push(String::new());

        let mut sheet_visibility = state.sheet_visibility.lock().map_err(|e| e.to_string())?;
        sheet_visibility.clear();
        sheet_visibility.push("visible".to_string());

        // Reset merged regions
        state.merged_regions.lock().map_err(|e| e.to_string())?.clear();
        let mut all_merged = state.all_merged_regions.lock().map_err(|e| e.to_string())?;
        all_merged.clear();
        all_merged.push(std::collections::HashSet::new());

        // Reset gridlines visibility
        let mut show_gridlines = state.show_gridlines.lock().map_err(|e| e.to_string())?;
        show_gridlines.clear();
        show_gridlines.push(true);

        // Reset page setups
        let mut page_setups = state.page_setups.lock().map_err(|e| e.to_string())?;
        page_setups.clear();
        page_setups.push(crate::api_types::PageSetup::default());
    }

    // Clear notes, hyperlinks, comments
    state.notes.lock().map_err(|e| e.to_string())?.clear();
    state.hyperlinks.lock().map_err(|e| e.to_string())?.clear();
    state.comments.lock().map_err(|e| e.to_string())?.clear();

    // Clear named ranges
    state.named_ranges.lock().map_err(|e| e.to_string())?.clear();

    // Clear data validations
    state.data_validations.lock().map_err(|e| e.to_string())?.clear();

    // Clear conditional formats
    state.conditional_formats.lock().map_err(|e| e.to_string())?.clear();

    // Clear cross-sheet dependencies
    state.cross_sheet_dependents.lock().map_err(|e| e.to_string())?.clear();
    state.cross_sheet_dependencies.lock().map_err(|e| e.to_string())?.clear();

    // Reset undo stack
    *state.undo_stack.lock().map_err(|e| e.to_string())? = engine::UndoStack::new();

    // Clear sheet protection and cell protection
    state.sheet_protection.lock().map_err(|e| e.to_string())?.clear();
    // Workbook structure protection must reset too — without this a File>New
    // after opening a structure-protected workbook inherits the old password
    // (and, now that protection persists, would even SAVE the old hash into
    // the fresh document).
    *state.workbook_protection.lock().map_err(|e| e.to_string())? =
        crate::protection::WorkbookProtection::default();

    // Clear auto filters
    state.auto_filters.lock().map_err(|e| e.to_string())?.clear();

    // Clear outlines/grouping
    state.outlines.lock().map_err(|e| e.to_string())?.clear();

    // Clear protected regions
    state.protected_regions.lock().map_err(|e| e.to_string())?.clear();

    // Clear computed properties
    state.computed_properties.lock().map_err(|e| e.to_string())?.clear();
    *state.next_computed_prop_id.lock().map_err(|e| e.to_string())? = 1;
    state.computed_prop_dependencies.lock().map_err(|e| e.to_string())?.clear();
    state.computed_prop_dependents.lock().map_err(|e| e.to_string())?.clear();

    // Clear controls
    state.controls.lock().map_err(|e| e.to_string())?.clear();

    // Clear cell-type assignments
    state.cell_types.lock().map_err(|e| e.to_string())?.clear();

    // Clear cell-behavior bindings
    state.cell_behaviors.lock().map_err(|e| e.to_string())?.clear();

    // Clear spill tracking
    state.spill_ranges.lock().map_err(|e| e.to_string())?.clear();
    state.spill_hosts.lock().map_err(|e| e.to_string())?.clear();

    // Clear advanced filter hidden rows
    state.advanced_filter_hidden_rows.lock().map_err(|e| e.to_string())?.clear();

    // Clear dependency maps
    state.dependencies.lock().map_err(|e| e.to_string())?.clear();
    state.column_dependents.lock().map_err(|e| e.to_string())?.clear();
    state.row_dependents.lock().map_err(|e| e.to_string())?.clear();
    state.column_dependencies.lock().map_err(|e| e.to_string())?.clear();
    state.row_dependencies.lock().map_err(|e| e.to_string())?.clear();

    // Reset conditional format ID counter
    *state.next_cf_rule_id.lock().map_err(|e| e.to_string())? = 1;

    // Clear scenarios
    state.scenarios.lock().map_err(|e| e.to_string())?.clear();

    // Clear named styles
    state.named_styles.lock().map_err(|e| e.to_string())?.clear();
    // Re-seed built-in styles: the clear above wiped them too, which left the
    // Cell Styles gallery empty after File > New.
    crate::named_styles_cmd::init_builtin_named_styles(&state);

    // Reset theme to default
    *state.theme.lock().map_err(|e| e.to_string())? = engine::ThemeDefinition::office();

    // Clear slicer state
    slicer_state.slicers.lock().unwrap().clear();
    slicer_state.computed_properties.lock().unwrap().clear();
    slicer_state.computed_prop_dependencies.lock().unwrap().clear();
    slicer_state.computed_prop_dependents.lock().unwrap().clear();

    // Clear pane control state (Controls pane)
    pane_control_state.controls.lock().unwrap().clear();

    // Clear chart state
    state.charts.lock().unwrap().clear();

    // Clear sparkline state (BUG-0004: sparklines survived File > New)
    state.sparklines.lock().unwrap().clear();

    // Clear script/notebook state
    script_state.workbook_scripts.lock().unwrap().clear();
    script_state.workbook_notebooks.lock().unwrap().clear();

    // Drop the scheduled-job registry with the scripts that own it. Without
    // this the previous workbook's schedule would survive into the blank
    // document and be SAVED into it — the same leak family as the object-script
    // leak fixed just below.
    crate::scripting::scheduler::reset_jobs();

    // Clear object scripts — otherwise the previous workbook's scripts
    // (including distributed ones) leak into the new workbook and get saved
    // with it. Same family as the writeback-index leak fixed in Wave 0.
    state.object_scripts.lock().unwrap().clear();
    state.extension_data.lock().unwrap().clear();
    state.pivot_layouts.lock().unwrap().clear();
    state.report_definitions.lock().unwrap().clear();

    // Clear subscription metadata
    *state.subscriptions.lock().map_err(|e| e.to_string())? =
        calp::manifest::SubscriptionManifest::default();

    // Clear override layer
    *state.override_layer.lock().map_err(|e| e.to_string())? =
        calp::OverrideLayer::new();

    // Reset audit log
    *state.audit_log.lock().map_err(|e| e.to_string())? =
        calp::audit::AuditLog::new();

    // Reset writeback layer
    *state.writeback_layer.lock().map_err(|e| e.to_string())? =
        calp::writeback::WritebackLayer::new();

    // Reset writeback index/declarations (otherwise the previous workbook's
    // regions stay active in the new workbook)
    *state.writeback_index.lock().map_err(|e| e.to_string())? =
        calp::WritebackIndex::default();
    state.writeback_declarations.lock().map_err(|e| e.to_string())?.clear();
    // The MODEL writeback mirror must be cleared with its grid sibling: new_file
    // does not call rebuild_writeback_index, so a stale set would survive into
    // the blank workbook and make the next refresh diff report the PREVIOUS
    // workbook's columns as removed.
    state.model_writeback_declarations.lock().map_err(|e| e.to_string())?.clear();
    state.writeback_draft_regions.lock().map_err(|e| e.to_string())?.clear();

    // Clear user files
    user_files_state.files.lock().map_err(|e| e.to_string())?.clear();

    // Reset workbook properties with defaults
    {
        let mut props = state.workbook_properties.lock().unwrap();
        let author = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_default();
        let now = chrono::Utc::now().to_rfc3339();
        *props = crate::api_types::WorkbookProperties {
            author,
            created: now.clone(),
            last_modified: now,
            ..Default::default()
        };
    }

    *file_state.current_path.lock().map_err(|e| e.to_string())? = None;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = false;
    // A new (blank) document is never encrypted; drop any session passphrase.
    *file_state.session_password.lock().map_err(|e| e.to_string())? = None;
    *file_state.is_encrypted.lock().map_err(|e| e.to_string())? = false;

    Ok(())
}

#[tauri::command]
pub fn get_current_file_path(file_state: State<FileState>) -> Option<String> {
    file_state
        .current_path
        .lock()
        .ok()
        .and_then(|p| p.as_ref().map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn is_file_modified(file_state: State<FileState>) -> bool {
    file_state.is_modified.lock().map(|m| *m).unwrap_or(false)
}

/// Whether the currently-open document is encrypted. Used by the frontend to
/// toggle the File-menu label between "Encrypt with Password…" and "Remove
/// Password". Never exposes the passphrase itself.
#[tauri::command]
pub fn is_document_encrypted(file_state: State<FileState>) -> bool {
    file_state.is_encrypted.lock().map(|e| *e).unwrap_or(false)
}

/// Stage a session passphrase without writing the file. The next `save_file`
/// with no explicit password will encrypt using this. (The encrypt dialog can
/// alternatively pass the password straight to `save_file`.)
#[tauri::command]
pub fn set_session_password(file_state: State<FileState>, password: String) -> Result<(), String> {
    *file_state.session_password.lock().map_err(|e| e.to_string())? = Some(Zeroizing::new(password));
    *file_state.is_encrypted.lock().map_err(|e| e.to_string())? = true;
    Ok(())
}

/// Drop the session passphrase so the next `save_file` writes a plain ZIP.
/// This is the host half of the "Remove Password" action (clear, then save).
#[tauri::command]
pub fn clear_session_password(file_state: State<FileState>) -> Result<(), String> {
    *file_state.session_password.lock().map_err(|e| e.to_string())? = None;
    *file_state.is_encrypted.lock().map_err(|e| e.to_string())? = false;
    Ok(())
}

#[tauri::command]
pub fn mark_file_modified(file_state: State<FileState>) {
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }
}

// ============================================================================
// WORKBOOK PROPERTIES
// ============================================================================

#[tauri::command]
pub fn get_workbook_properties(
    state: State<AppState>,
) -> crate::api_types::WorkbookProperties {
    state.workbook_properties.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_workbook_properties(
    state: State<AppState>,
    props: crate::api_types::WorkbookProperties,
) -> crate::api_types::WorkbookProperties {
    let mut stored = state.workbook_properties.lock().unwrap();
    *stored = props;
    // Update last_modified timestamp
    stored.last_modified = chrono::Utc::now().to_rfc3339();
    stored.clone()
}

// ============================================================================
// VIRTUAL FILES (stored inside the .cala archive)
// ============================================================================

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualFileEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub extension: String,
}

/// List all user files stored inside the .cala archive.
#[tauri::command]
pub fn list_virtual_files(user_files_state: State<UserFilesState>, window: tauri::Window) -> Result<Vec<VirtualFileEntry>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    let mut entries: Vec<VirtualFileEntry> = Vec::new();
    let mut seen_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (path, content) in files.iter() {
        // Collect parent directories
        if let Some(dir_path) = path.rsplit_once('/').map(|(d, _)| d.to_string()) {
            // Add each level of the directory hierarchy
            let parts: Vec<&str> = dir_path.split('/').collect();
            for i in 0..parts.len() {
                let dir = parts[..=i].join("/");
                if seen_dirs.insert(dir.clone()) {
                    entries.push(VirtualFileEntry {
                        path: dir,
                        is_dir: true,
                        size: 0,
                        extension: String::new(),
                    });
                }
            }
        }

        let extension = std::path::Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();

        entries.push(VirtualFileEntry {
            path: path.clone(),
            is_dir: false,
            size: content.len() as u64,
            extension,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });

    Ok(entries)
}

/// Read a user file from the virtual filesystem.
#[tauri::command]
pub fn read_virtual_file(user_files_state: State<UserFilesState>, path: String, window: tauri::Window) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    let content = files.get(&path)
        .ok_or_else(|| format!("File not found: {}", path))?;

    String::from_utf8(content.clone())
        .map_err(|_| "File is not valid UTF-8 text".to_string())
}

/// Create or update a file in the virtual filesystem.
#[tauri::command]
pub fn create_virtual_file(
    app_handle: tauri::AppHandle,
    user_files_state: State<UserFilesState>,
    file_state: State<FileState>,
    path: String,
    content: Option<String>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if path.trim().is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    if path.contains("..") {
        return Err("Invalid path".to_string());
    }

    let mut files = user_files_state.files.lock().map_err(|e| e.to_string())?;
    let bytes = content.unwrap_or_default().into_bytes();
    files.insert(path.clone(), bytes);

    // Mark file as modified
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }

    // Notify frontend so cells using FILEREAD/FILELINES/FILEEXISTS can recalculate
    let _ = app_handle.emit("virtual-file-changed", &path);

    Ok(())
}

/// Create a virtual folder marker (stores as an empty entry with trailing /).
#[tauri::command]
pub fn create_virtual_folder(
    user_files_state: State<UserFilesState>,
    file_state: State<FileState>,
    path: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if path.trim().is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    if path.contains("..") {
        return Err("Invalid path".to_string());
    }

    // Folders are implicitly created when files exist inside them.
    // We store a placeholder empty file to represent empty folders.
    let mut files = user_files_state.files.lock().map_err(|e| e.to_string())?;
    let folder_marker = format!("{}/.folder", path.trim_end_matches('/'));
    files.insert(folder_marker, Vec::new());

    // Mark file as modified
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }

    Ok(())
}

/// Delete a file from the virtual filesystem.
#[tauri::command]
pub fn delete_virtual_file(
    app_handle: tauri::AppHandle,
    user_files_state: State<UserFilesState>,
    file_state: State<FileState>,
    path: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let mut files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    // If it's a directory, remove all files under it
    let prefix = format!("{}/", path.trim_end_matches('/'));
    let keys_to_remove: Vec<String> = files.keys()
        .filter(|k| **k == path || k.starts_with(&prefix))
        .cloned()
        .collect();

    if keys_to_remove.is_empty() {
        return Err(format!("Not found: {}", path));
    }

    for key in keys_to_remove {
        files.remove(&key);
    }

    // Mark file as modified
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }

    // Notify frontend so cells using FILEREAD/FILELINES/FILEEXISTS can recalculate
    let _ = app_handle.emit("virtual-file-changed", &path);

    Ok(())
}

/// Rename a file or folder in the virtual filesystem.
#[tauri::command]
pub fn rename_virtual_file(
    app_handle: tauri::AppHandle,
    user_files_state: State<UserFilesState>,
    file_state: State<FileState>,
    old_path: String,
    new_path: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if new_path.trim().is_empty() {
        return Err("New name cannot be empty".to_string());
    }
    if new_path.contains("..") {
        return Err("Invalid path".to_string());
    }

    let mut files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    // Check if it's a single file rename
    if let Some(content) = files.remove(&old_path) {
        if files.contains_key(&new_path) {
            // Put it back
            files.insert(old_path, content);
            return Err(format!("'{}' already exists", new_path));
        }
        files.insert(new_path, content);
    } else {
        // It's a folder rename — rename all files under old_path/
        let old_prefix = format!("{}/", old_path.trim_end_matches('/'));
        let new_prefix = format!("{}/", new_path.trim_end_matches('/'));
        let keys_to_rename: Vec<(String, Vec<u8>)> = files.iter()
            .filter(|(k, _)| k.starts_with(&old_prefix))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        if keys_to_rename.is_empty() {
            return Err(format!("Not found: {}", old_path));
        }

        for (old_key, content) in keys_to_rename {
            files.remove(&old_key);
            let new_key = format!("{}{}", new_prefix, &old_key[old_prefix.len()..]);
            files.insert(new_key, content);
        }
    }

    // Mark file as modified
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }

    // Notify frontend so cells using FILEREAD/FILELINES/FILEEXISTS can recalculate
    let _ = app_handle.emit("virtual-file-changed", &old_path);

    Ok(())
}

// ============================================================================
// AI CONTEXT SERIALIZATION
// ============================================================================

#[tauri::command]
pub fn get_ai_context(
    state: State<AppState>,
    options: AiSerializeOptions,
) -> Result<String, String> {
    let grids = state.grids.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let active_grid = state.grid.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;

    // Build sheet inputs — use stored grids for non-active sheets, active grid for current.
    // Hidden formulas are withheld exactly like every other read path.
    let protection_storage = state.sheet_protection.lock().map_err(|e| e.to_string())?;
    let mut sheet_inputs: Vec<SheetInput> = Vec::new();
    for (i, name) in sheet_names.iter().enumerate() {
        if i == active_sheet {
            sheet_inputs.push(SheetInput {
                name,
                grid: &active_grid,
                styles: &styles,
                hidden_formula_cells: crate::protection::hidden_formula_cells_in(
                    &protection_storage, &active_grid, &styles, i,
                ),
            });
        } else if let Some(grid) = grids.get(i) {
            sheet_inputs.push(SheetInput {
                name,
                grid,
                styles: &styles,
                hidden_formula_cells: crate::protection::hidden_formula_cells_in(
                    &protection_storage, grid, &styles, i,
                ),
            });
        }
    }

    Ok(serialize_for_ai(&sheet_inputs, &options))
}

// ============================================================================
// RAW TEXT FILE I/O (for CSV import/export)
// ============================================================================

/// Read a text file with optional encoding detection.
/// Supports UTF-8 (with or without BOM), and falls back to Windows-1252 (ANSI).
#[tauri::command]
pub fn read_text_file(path: String, encoding: Option<String>, window: tauri::Window) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let path_buf = PathBuf::from(&path);
    let bytes = std::fs::read(&path_buf).map_err(|e| format!("Failed to read file: {}", e))?;

    let enc = encoding.unwrap_or_default().to_lowercase();

    match enc.as_str() {
        "utf-8" | "utf8" | "" => {
            // Try UTF-8 first, strip BOM if present
            let text = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                String::from_utf8(bytes[3..].to_vec())
            } else {
                String::from_utf8(bytes.clone())
            };
            match text {
                Ok(s) => Ok(s),
                Err(_) if enc.is_empty() => {
                    // Auto-detect: fall back to Windows-1252
                    Ok(bytes.iter().map(|&b| b as char).collect())
                }
                Err(e) => Err(format!("UTF-8 decode error: {}", e)),
            }
        }
        "ansi" | "windows-1252" | "latin1" | "iso-8859-1" => {
            Ok(bytes.iter().map(|&b| b as char).collect())
        }
        _ => Err(format!("Unsupported encoding: {}", enc)),
    }
}

/// Write a text string to a file with the specified encoding. Also used by the
/// Model Editor window (Testing Ground dataset/plan export).
#[tauri::command]
pub fn write_text_file(path: String, content: String, encoding: Option<String>, window: tauri::Window) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_MODEL_EDITOR)?;
    let path_buf = PathBuf::from(&path);

    let enc = encoding.unwrap_or_default().to_lowercase();

    let bytes = match enc.as_str() {
        "utf-8-bom" => {
            let mut bom = vec![0xEF, 0xBB, 0xBF];
            bom.extend_from_slice(content.as_bytes());
            bom
        }
        "ansi" | "windows-1252" | "latin1" | "iso-8859-1" => {
            content.chars().map(|c| {
                let cp = c as u32;
                if cp <= 255 { cp as u8 } else { b'?' }
            }).collect()
        }
        _ => content.into_bytes(), // UTF-8 (default)
    };

    std::fs::write(&path_buf, bytes).map_err(|e| format!("Failed to write file: {}", e))
}

// ============================================================================
// SCRIPTS & NOTEBOOKS (save/restore via .cala features)
// ============================================================================

/// Collect scripts from ScriptState into SavedScript format for persistence.
pub(crate) fn collect_scripts_for_save(
    script_state: &State<crate::scripting::types::ScriptState>,
) -> Vec<persistence::SavedScript> {
    use crate::scripting::types::ScriptScope;
    let scripts = script_state.workbook_scripts.lock().unwrap();
    scripts
        .values()
        .map(|s| persistence::SavedScript {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
            source: s.source.clone(),
            scope: match &s.scope {
                ScriptScope::Workbook => persistence::SavedScriptScope::Workbook,
                ScriptScope::Sheet { name } => persistence::SavedScriptScope::Sheet {
                    name: name.clone(),
                },
            },
            source_package: s.source_package.clone(),
        })
        .collect()
}

/// Cap for table rows persisted into .cala. Outputs are a replayable cache
/// (Run All regenerates them); persisting full result tables would bloat the
/// workbook file for no benefit.
const PERSISTED_TABLE_ROW_CAP: usize = 50;

/// Convert a live output item to its persistence mirror, capping table rows.
pub(crate) fn output_item_to_saved(
    item: &script_engine::ScriptOutputItem,
) -> persistence::SavedNotebookOutputItem {
    match item {
        script_engine::ScriptOutputItem::Text { text } => {
            persistence::SavedNotebookOutputItem::Text { text: text.clone() }
        }
        script_engine::ScriptOutputItem::Table {
            columns,
            rows,
            truncated,
            total_rows,
        } => {
            let capped = rows.len() > PERSISTED_TABLE_ROW_CAP;
            persistence::SavedNotebookOutputItem::Table {
                columns: columns.clone(),
                rows: rows.iter().take(PERSISTED_TABLE_ROW_CAP).cloned().collect(),
                truncated: *truncated || capped,
                total_rows: *total_rows,
            }
        }
    }
}

/// Convert a persisted output item back to the live shape.
pub(crate) fn saved_output_to_item(
    item: &persistence::SavedNotebookOutputItem,
) -> script_engine::ScriptOutputItem {
    match item {
        persistence::SavedNotebookOutputItem::Text { text } => {
            script_engine::ScriptOutputItem::Text { text: text.clone() }
        }
        persistence::SavedNotebookOutputItem::Table {
            columns,
            rows,
            truncated,
            total_rows,
        } => script_engine::ScriptOutputItem::Table {
            columns: columns.clone(),
            rows: rows.clone(),
            truncated: *truncated,
            total_rows: *total_rows,
        },
    }
}

/// Collect notebooks from ScriptState into SavedNotebook format for persistence.
pub(crate) fn collect_notebooks_for_save(
    script_state: &State<crate::scripting::types::ScriptState>,
) -> Vec<persistence::SavedNotebook> {
    let notebooks = script_state.workbook_notebooks.lock().unwrap();
    notebooks
        .values()
        .map(|n| persistence::SavedNotebook {
            id: n.id.clone(),
            name: n.name.clone(),
            cells: n
                .cells
                .iter()
                .map(|c| persistence::SavedNotebookCell {
                    id: c.id.clone(),
                    source: c.source.clone(),
                    last_output: c.last_output.iter().map(output_item_to_saved).collect(),
                    last_error: c.last_error.clone(),
                    cells_modified: c.cells_modified,
                    duration_ms: c.duration_ms,
                    execution_index: c.execution_index,
                })
                .collect(),
            source_package: n.source_package.clone(),
        })
        .collect()
}

/// Restore scripts from saved data into ScriptState.
fn restore_scripts(
    saved: &[persistence::SavedScript],
    script_state: &State<crate::scripting::types::ScriptState>,
) {
    use crate::scripting::types::ScriptScope;
    let mut scripts = script_state.workbook_scripts.lock().unwrap();
    scripts.clear();
    for s in saved {
        scripts.insert(
            s.id.clone(),
            crate::scripting::types::WorkbookScript {
                id: s.id.clone(),
                name: s.name.clone(),
                description: s.description.clone(),
                source: s.source.clone(),
                scope: match &s.scope {
                    persistence::SavedScriptScope::Workbook => ScriptScope::Workbook,
                    persistence::SavedScriptScope::Sheet { name } => ScriptScope::Sheet {
                        name: name.clone(),
                    },
                },
                source_package: s.source_package.clone(),
            },
        );
    }
}

/// Restore notebooks from saved data into ScriptState.
// ============================================================================
// AUTO-RECOVER SETTINGS & SAVE
// ============================================================================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRecoverSettings {
    pub enabled: bool,
    pub interval_ms: u64,
}

#[tauri::command]
pub fn get_auto_recover_settings(state: State<AppState>) -> AutoRecoverSettings {
    let enabled = *state.auto_recover_enabled.lock().unwrap();
    let interval_ms = *state.auto_recover_interval_ms.lock().unwrap();
    AutoRecoverSettings { enabled, interval_ms }
}

#[tauri::command]
pub fn set_auto_recover_settings(
    state: State<AppState>,
    enabled: bool,
    interval_ms: u64,
    window: tauri::Window,
) -> Result<AutoRecoverSettings, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    *state.auto_recover_enabled.lock().unwrap() = enabled;
    *state.auto_recover_interval_ms.lock().unwrap() = interval_ms;
    Ok(AutoRecoverSettings { enabled, interval_ms })
}

/// List the Calcula features present in the CURRENT workbook that saving as
/// .xlsx will silently drop (xlsx has no representation for them). The
/// frontend shows this before a lossy save so the user consents to the loss —
/// "Working" xlsx support must never mean silent destruction of everything
/// else. Cheap read-only presence checks; feature VALUES are not serialized.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn xlsx_save_loss_report(
    state: State<AppState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    script_state: State<crate::scripting::types::ScriptState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    window: tauri::Window,
) -> Result<Vec<String>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let mut lost: Vec<String> = Vec::new();
    let mut check = |present: bool, label: &str| {
        if present {
            lost.push(label.to_string());
        }
    };

    check(
        state.conditional_formats.lock().map_err(|e| e.to_string())?.values().any(|v| !v.is_empty()),
        "Conditional formatting",
    );
    check(
        state.data_validations.lock().map_err(|e| e.to_string())?.values().any(|v| !v.is_empty()),
        "Data validation",
    );
    check(
        !pivot_state.pivot_tables.lock().map_err(|e| e.to_string())?.is_empty(),
        "Pivot tables",
    );
    check(
        !slicer_state.slicers.lock().map_err(|e| e.to_string())?.is_empty(),
        "Slicers",
    );
    check(
        !ribbon_filter_state.filters.lock().map_err(|e| e.to_string())?.is_empty(),
        "Ribbon filters",
    );
    check(
        !pane_control_state.controls.lock().map_err(|e| e.to_string())?.is_empty(),
        "Pane controls",
    );
    check(
        state.comments.lock().map_err(|e| e.to_string())?.values().any(|v| !v.is_empty()),
        "Threaded comments",
    );
    check(
        state.scenarios.lock().map_err(|e| e.to_string())?.values().any(|v| !v.is_empty()),
        "What-if scenarios",
    );
    check(
        !state.outlines.lock().map_err(|e| e.to_string())?.is_empty(),
        "Outline groups",
    );
    check(
        !state.object_scripts.lock().map_err(|e| e.to_string())?.is_empty(),
        "Object scripts",
    );
    {
        let scripts = script_state.workbook_scripts.lock().map_err(|e| e.to_string())?;
        check(!scripts.is_empty(), "Workbook scripts (incl. custom functions)");
    }
    check(
        !script_state.workbook_notebooks.lock().map_err(|e| e.to_string())?.is_empty(),
        "Notebooks",
    );
    check(
        !state.cell_types.lock().map_err(|e| e.to_string())?.is_empty(),
        "Cell types (bricks)",
    );
    check(
        !state.cell_behaviors.lock().map_err(|e| e.to_string())?.is_empty(),
        "Cell behaviors (bricks)",
    );
    check(
        state.sheet_protection.lock().map_err(|e| e.to_string())?.values().any(|p| p.protected)
            || state.workbook_protection.lock().map_err(|e| e.to_string())?.protected,
        "Sheet/workbook protection",
    );
    check(
        !bi_state.connections.lock().map_err(|e| e.to_string())?.is_empty(),
        "BI model connections",
    );
    check(
        !state.subscriptions.lock().map_err(|e| e.to_string())?.subscriptions.is_empty(),
        "Package subscriptions",
    );
    check(
        !state.writeback_layer.lock().map_err(|e| e.to_string())?.drafts.is_empty()
            || !state.writeback_draft_regions.lock().map_err(|e| e.to_string())?.is_empty(),
        "Writeback drafts/regions",
    );
    check(
        !state.extension_data.lock().map_err(|e| e.to_string())?.is_empty(),
        "Extension data (animations, grid reports, ...)",
    );
    check(
        state.computed_properties.lock().map_err(|e| e.to_string())?.values().any(|s| {
            !s.column_props.is_empty() || !s.row_props.is_empty() || !s.cell_props.is_empty()
        }),
        "Computed properties",
    );
    check(
        state.named_styles.lock().map_err(|e| e.to_string())?.values().any(|ns| !ns.built_in),
        "Custom named styles",
    );
    // xlsx has nowhere to keep a schedule, so "Save As .xlsx" silently disarms
    // every job. The user consented to automation that "resumes next time you
    // open it"; a format that cannot honour that must say so BEFORE the save,
    // not leave the promise quietly broken.
    check(
        crate::scripting::scheduler::has_scheduled_jobs(),
        "Scheduled jobs (they stop running: xlsx cannot carry a schedule)",
    );

    Ok(lost)
}

#[tauri::command]
pub fn auto_recover_save(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    script_state: State<crate::scripting::types::ScriptState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // Only save if the file is dirty
    let is_modified = *file_state.is_modified.lock().map_err(|e| e.to_string())?;
    if !is_modified {
        return Err("not_dirty".to_string());
    }

    // Determine recovery file path
    let current_path = file_state.current_path.lock().map_err(|e| e.to_string())?;
    let recovery_path = if let Some(ref path) = *current_path {
        // Place recovery file next to original: ~$filename.cala.recovery
        let parent = path.parent().unwrap_or(std::path::Path::new("."));
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("untitled.cala");
        parent.join(format!("~${}.recovery", file_name))
    } else {
        // No file saved yet: use temp directory
        let temp_dir = std::env::temp_dir();
        temp_dir.join("~$calcula_unsaved.cala.recovery")
    };

    // FULL-fidelity snapshot via the SAME assembly as save_file — the old
    // inline single-sheet Workbook::from_grid build dropped every non-active
    // sheet, all pivots, BI models/caches and the user_files artifacts, so a
    // crash recovery was worse than the last manual save.
    let workbook = assemble_workbook_for_save(
        &state,
        &user_files_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &script_state,
        &pivot_state,
        &bi_state,
    )?;

    // Save as .cala to the recovery path. CRITICAL: if the live document is
    // encrypted, the recovery snapshot MUST be encrypted too — otherwise an
    // auto-recover write would drop a plaintext copy next to the protected file.
    let session_pw = file_state
        .session_password
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let pw_bytes = session_pw.as_ref().map(|z| z.as_bytes());
    calcula_format::save_calcula_opt(&workbook, &recovery_path, pw_bytes)
        .map_err(|e| e.to_string())?;

    // Do NOT reset the dirty flag -- this is a background save
    Ok(recovery_path.to_string_lossy().to_string())
}

fn restore_notebooks(
    saved: &[persistence::SavedNotebook],
    script_state: &State<crate::scripting::types::ScriptState>,
) {
    let mut notebooks = script_state.workbook_notebooks.lock().unwrap();
    notebooks.clear();
    for n in saved {
        notebooks.insert(
            n.id.clone(),
            crate::scripting::types::NotebookDocument {
                id: n.id.clone(),
                name: n.name.clone(),
                cells: n
                    .cells
                    .iter()
                    .map(|c| crate::scripting::types::NotebookCell {
                        id: c.id.clone(),
                        source: c.source.clone(),
                        last_output: c.last_output.iter().map(saved_output_to_item).collect(),
                        last_error: c.last_error.clone(),
                        cells_modified: c.cells_modified,
                        duration_ms: c.duration_ms,
                        execution_index: c.execution_index,
                    })
                    .collect(),
                source_package: n.source_package.clone(),
            },
        );
    }
}

// ============================================================================
// GENERIC PER-EXTENSION PERSISTENCE
// ============================================================================
// Any extension (built-in or third-party) can persist arbitrary JSON state in
// the workbook, keyed by its extension id, without a new typed file-format
// field. The value round-trips through the .cala `extension-data` part.

/// Read an extension's persisted state. Returns null if it has none.
#[tauri::command]
pub fn get_extension_data(
    extension_id: String,
    state: State<AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let data = state.extension_data.lock().map_err(|e| e.to_string())?;
    Ok(data.get(&extension_id).cloned())
}

/// Persist an extension's state. A null value clears it.
#[tauri::command]
pub fn set_extension_data(
    extension_id: String,
    value: Option<serde_json::Value>,
    state: State<AppState>,
) -> Result<(), String> {
    let mut data = state.extension_data.lock().map_err(|e| e.to_string())?;
    match value {
        Some(v) => {
            data.insert(extension_id, v);
        }
        None => {
            data.remove(&extension_id);
        }
    }
    Ok(())
}

/// Persist an extension's state AND record it on the undo stack under `description`
/// (a dedicated, opt-in variant of set_extension_data). Use for user-meaningful,
/// low-frequency writes (e.g. saving a named animation). High-frequency or
/// transient writes should stay on the plain (non-undoable) set_extension_data.
#[tauri::command]
pub fn set_extension_data_undoable(
    extension_id: String,
    value: Option<serde_json::Value>,
    description: String,
    state: State<AppState>,
) -> Result<(), String> {
    // Snapshot the prior value (lock released before recording undo / re-locking).
    let previous = {
        let data = state.extension_data.lock().map_err(|e| e.to_string())?;
        data.get(&extension_id).cloned()
    };
    crate::undo_commands::record_extension_data_undo(&state, extension_id.clone(), previous, &description);
    let mut data = state.extension_data.lock().map_err(|e| e.to_string())?;
    match value {
        Some(v) => {
            data.insert(extension_id, v);
        }
        None => {
            data.remove(&extension_id);
        }
    }
    Ok(())
}

// ============================================================================
// TESTS — scheduled jobs through the REAL .cala round trip
// ============================================================================
//
// These drive `persist_scheduled_jobs` -> calcula_format::save_calcula ->
// load_calcula -> `restore_scheduled_jobs`, i.e. the exact functions save_file
// and open_file call, with a real ZIP on disk in between. Asserting on a
// hand-rolled in-memory hand-off would have proved nothing about the feature's
// headline promise ("it is still there next time you open the file").

/// THE canonical serialization point for every test that drives the process-
/// global scheduled-job registry (`crate::scripting::scheduler`'s `SCHEDULER`
/// singleton), wherever that test lives.
///
/// It is crate-visible on purpose. Two modules in this crate exercise that one
/// singleton — this file (through the real .cala save/load path) and the
/// scheduler's own unit tests — and both of them CLEAR it wholesale, because
/// "open a workbook" and "close a workbook" genuinely mean "replace the entire
/// schedule". A per-module lock therefore serializes each module against itself
/// and neither against the other, which is exactly the shape of flake that only
/// reproduces under `cargo test`'s default parallelism and vanishes under
/// `--test-threads=1`.
///
/// Poison is deliberately ignored (`into_inner`): a panicking test must not
/// convert one failure into a cascade of unrelated ones.
#[cfg(test)]
pub(crate) fn scheduler_test_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod scheduled_job_persistence_tests {
    use super::*;
    use crate::scripting::scheduler::{export_jobs_for_workbook, reset_jobs, MIN_INTERVAL_SECS};
    use calcula_format::features::scheduled_jobs::{
        ScheduledJobDef, ScheduledJobsFile, SCHEDULED_JOBS_FEATURE, SCHEDULED_JOBS_FILE,
        SCHEDULED_JOBS_MIN_FORMAT_VERSION,
    };

    const SCRIPT_SOURCE: &str = "export function nightly() { refresh(); }";

    /// Serialize against every OTHER test that drives the same singleton.
    ///
    /// This module used to declare its own `static LOCK` — and so does
    /// `crate::scripting::scheduler`'s test module. Two mutexes, ONE global
    /// registry: each module was internally serialized and the two interleaved
    /// freely, in the same test binary, on the same thread pool. Since
    /// `import_jobs_for_workbook` and `reset_jobs` both CLEAR the whole registry
    /// (they are workbook-open / workbook-close semantics, so they must), a
    /// scheduler test's `reset_jobs()` lands between this module's
    /// `register_live_job()` and its `persist_scheduled_jobs(...)` and the
    /// schedule is simply gone. `--test-threads=1` hid it, which is the worst
    /// property a flake can have on a security-relevant test: people learn to
    /// re-run it instead of reading it.
    ///
    /// The canonical lock now lives at crate scope (`scheduler_test_guard`
    /// below) and BOTH modules take it, so mutual exclusion is real rather than
    /// per-module.
    fn global_guard() -> std::sync::MutexGuard<'static, ()> {
        super::scheduler_test_guard()
    }

    fn audit() -> Mutex<calp::audit::AuditLog> {
        Mutex::new(calp::audit::AuditLog::new())
    }

    /// A minimal workbook carrying ONE object script, which is what a job may
    /// legitimately be bound to.
    fn workbook_with_script(source: &str) -> Workbook {
        let mut wb = Workbook::new();
        wb.object_scripts.push(persistence::SavedObjectScript {
            id: "obj-1".to_string(),
            name: "Nightly".to_string(),
            object_type: persistence::ScriptableObjectType::Shape,
            instance_id: Some("i1".to_string()),
            source: source.to_string(),
            access_level: persistence::ScriptAccessLevel::Restricted,
            description: None,
            provenance: persistence::ScriptProvenance::Local,
            package_name: None,
            package_version: None,
            declared_capabilities: vec!["schedule".to_string()],
        });
        wb
    }

    fn a_job(id: &str, handler: &str) -> ScheduledJobDef {
        ScheduledJobDef {
            id: id.to_string(),
            script_id: "obj-1".to_string(),
            script_hash: calp::integrity::sha256_hex(SCRIPT_SOURCE.as_bytes()),
            surface: "object-script".to_string(),
            object_type: "shape".to_string(),
            instance_id: Some("i1".to_string()),
            handler: handler.to_string(),
            cadence: "dailyAt".to_string(),
            interval_secs: MIN_INTERVAL_SECS,
            minute_of_day: 390,
            next_run_ms: 1_700_000_000_000,
            enabled: true,
            label: Some("Nightly refresh".to_string()),
            last_run_ms: 0,
            last_ok: false,
            last_error: None,
            run_count: 3,
        }
    }

    /// Put one job for `obj-1` into the live registry.
    fn register_live_job() {
        reset_jobs();
        let mut seed: HashMap<String, String> = HashMap::new();
        seed.insert(
            "obj-1".to_string(),
            calp::integrity::sha256_hex(SCRIPT_SOURCE.as_bytes()),
        );
        let outcome = crate::scripting::scheduler::import_jobs_for_workbook(
            vec![a_job("sched-1", "nightly")],
            &seed,
        );
        assert_eq!(outcome.restored, 1);
    }

    /// The manifest as it was actually WRITTEN into the archive, so the stamp
    /// assertions test the bytes on disk rather than the reader's reconstruction.
    fn manifest_of(path: &std::path::Path) -> calcula_format::Manifest {
        let bytes = std::fs::read(path).unwrap();
        calcula_format::read_calcula_manifest(&bytes).unwrap()
    }

    #[test]
    fn a_schedule_survives_save_and_reload_through_the_real_cala_path() {
        let _g = global_guard();
        register_live_job();

        let mut wb = workbook_with_script(SCRIPT_SOURCE);
        persist_scheduled_jobs(&mut wb);
        assert!(wb.user_files.contains_key(SCHEDULED_JOBS_FILE));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scheduled.cala");
        calcula_format::save_calcula(&wb, &path).unwrap();

        // The workbook is closed: nothing is left in memory.
        reset_jobs();
        assert!(export_jobs_for_workbook(&workbook_script_hashes(&wb)).is_empty());

        let mut loaded = calcula_format::load_calcula(&path).unwrap();
        let log = audit();
        restore_scheduled_jobs(&log, &mut loaded);

        let jobs = export_jobs_for_workbook(&workbook_script_hashes(&loaded));
        assert_eq!(jobs.len(), 1, "the schedule must survive the reload");
        assert_eq!(jobs[0].handler, "nightly");
        assert_eq!(jobs[0].cadence, "dailyAt");
        assert_eq!(jobs[0].minute_of_day, 390);
        assert_eq!(jobs[0].label.as_deref(), Some("Nightly refresh"));
        assert_eq!(jobs[0].run_count, 3, "the run history comes back with it");
        assert_eq!(
            jobs[0].script_hash,
            calp::integrity::sha256_hex(SCRIPT_SOURCE.as_bytes())
        );

        // The section is consumed on restore, exactly like the other
        // user_files-backed artifacts, so it never surfaces in the virtual
        // filesystem the user browses.
        assert!(!loaded.user_files.contains_key(SCHEDULED_JOBS_FILE));
        reset_jobs();
    }

    #[test]
    fn saving_a_schedule_stamps_the_format_version_and_declares_the_feature() {
        let _g = global_guard();
        register_live_job();

        let mut wb = workbook_with_script(SCRIPT_SOURCE);
        persist_scheduled_jobs(&mut wb);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stamped.cala");
        calcula_format::save_calcula(&wb, &path).unwrap();

        let manifest = manifest_of(&path);
        assert_eq!(
            manifest.format_version, SCHEDULED_JOBS_MIN_FORMAT_VERSION,
            "a workbook that runs code on a timer must stamp its minimum reader version"
        );
        assert!(manifest.features.iter().any(|f| f == SCHEDULED_JOBS_FEATURE));

        // ...and a workbook WITHOUT a schedule is not dragged up the chain.
        reset_jobs();
        let mut plain = workbook_with_script(SCRIPT_SOURCE);
        persist_scheduled_jobs(&mut plain);
        let plain_path = dir.path().join("plain.cala");
        calcula_format::save_calcula(&plain, &plain_path).unwrap();
        assert_eq!(
            manifest_of(&plain_path).format_version,
            calcula_format::CALA_BASE_FORMAT_VERSION,
            "a workbook without a schedule is not dragged up the chain"
        );
        reset_jobs();
    }

    #[test]
    fn a_restored_job_whose_script_was_deleted_is_dropped_and_audited() {
        let _g = global_guard();
        register_live_job();

        let mut wb = workbook_with_script(SCRIPT_SOURCE);
        persist_scheduled_jobs(&mut wb);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orphan.cala");
        calcula_format::save_calcula(&wb, &path).unwrap();
        reset_jobs();

        let mut loaded = calcula_format::load_calcula(&path).unwrap();
        // The script was deleted between save and load.
        loaded.object_scripts.clear();

        let log = audit();
        restore_scheduled_jobs(&log, &mut loaded);

        assert!(
            export_jobs_for_workbook(&workbook_script_hashes(&loaded)).is_empty(),
            "a job whose owning script is gone must not be restored"
        );
        assert!(
            !log.lock().unwrap().entries.is_empty(),
            "the refusal must be visible in the audit trail"
        );
        reset_jobs();
    }

    #[test]
    fn a_restored_job_whose_script_was_edited_is_dropped() {
        let _g = global_guard();
        register_live_job();

        let mut wb = workbook_with_script(SCRIPT_SOURCE);
        persist_scheduled_jobs(&mut wb);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("edited.cala");
        calcula_format::save_calcula(&wb, &path).unwrap();
        reset_jobs();

        let mut loaded = calcula_format::load_calcula(&path).unwrap();
        // Same script id, different body — consent was for the old one.
        loaded.object_scripts[0].source = "export function nightly() { exfiltrate(); }".to_string();

        let log = audit();
        restore_scheduled_jobs(&log, &mut loaded);
        assert!(
            export_jobs_for_workbook(&workbook_script_hashes(&loaded)).is_empty(),
            "a job must not survive its script being rewritten"
        );
        reset_jobs();
    }

    #[test]
    fn a_workbook_with_no_section_clears_the_previous_workbooks_schedule() {
        let _g = global_guard();
        register_live_job();

        // Opening a document that carries no schedule must empty the registry,
        // or the previous workbook's jobs would be saved into this one.
        let mut plain = workbook_with_script(SCRIPT_SOURCE);
        let log = audit();
        restore_scheduled_jobs(&log, &mut plain);
        assert!(export_jobs_for_workbook(&workbook_script_hashes(&plain)).is_empty());
        reset_jobs();
    }

    #[test]
    fn a_planted_scheduled_jobs_file_cannot_smuggle_a_schedule_into_a_save() {
        let _g = global_guard();
        reset_jobs();

        // A file literally named scheduled_jobs.json placed in the workbook's
        // virtual filesystem must not become a schedule: the save path OWNS
        // that key and rewrites it from the live registry (here: empty).
        let mut wb = workbook_with_script(SCRIPT_SOURCE);
        let planted = ScheduledJobsFile::new(vec![a_job("sched-99", "nightly")]);
        wb.user_files.insert(
            SCHEDULED_JOBS_FILE.to_string(),
            planted.to_json_bytes().unwrap(),
        );

        persist_scheduled_jobs(&mut wb);
        assert!(
            !wb.user_files.contains_key(SCHEDULED_JOBS_FILE),
            "the save path must rewrite (here: remove) the section, never inherit it"
        );
        reset_jobs();
    }
}
