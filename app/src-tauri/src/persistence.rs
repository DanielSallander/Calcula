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
use calcula_format::{save_calcula, load_calcula};
use calcula_format::ai::{AiSerializeOptions, serialize_for_ai, SheetInput};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, State};

#[derive(Default)]
pub struct FileState {
    pub current_path: Mutex<Option<PathBuf>>,
    pub is_modified: Mutex<bool>,
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
    Table {
        id: saved.id,
        name: saved.name.clone(),
        sheet_index: sheet_id_to_index(workbook, saved.sheet_id),
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
    Ok(workbook)
}

/// Build a multi-sheet Workbook snapshot from the current AppState.
/// Used by the .calp publish command to access all sheets by index.
/// Unlike `build_workbook_for_save`, this captures ALL sheets, not just the active one.
pub fn build_workbook_snapshot(state: &State<AppState>) -> Result<Workbook, String> {
    let grids = state.grids.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
    let all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
    let tables = state.tables.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;

    let mut workbook = Workbook::new();
    workbook.sheets.clear();
    workbook.active_sheet = active_sheet;
    workbook.default_row_height = *state.default_row_height.lock().unwrap();
    workbook.default_column_width = *state.default_column_width.lock().unwrap();
    workbook.theme = state.theme.lock().unwrap().clone();

    // Workbook properties
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

    // Build a Sheet for each grid using the shared style registry
    for (i, grid) in grids.iter().enumerate() {
        let id = sheet_ids.get(i).copied().unwrap_or_else(|| {
            identity::SheetId::from_bytes(identity::generate_uuid_v7())
        });
        let name = sheet_names.get(i).cloned().unwrap_or_else(|| format!("Sheet{}", i + 1));
        let col_widths = all_cw.get(i).cloned().unwrap_or_default();
        let row_heights = all_rh.get(i).cloned().unwrap_or_default();
        let dimensions = DimensionData { column_widths: col_widths, row_heights: row_heights };
        let mut sheet = persistence::Sheet::from_grid(id, name, grid, &styles, &dimensions);

        // Populate sheet-level metadata
        // Merged regions
        if let Ok(all_merged) = state.all_merged_regions.lock() {
            if let Some(sheet_merges) = all_merged.get(i) {
                sheet.merged_regions = sheet_merges.iter().map(|r| SavedMergedRegion {
                    start_row: r.start_row,
                    start_col: r.start_col,
                    end_row: r.end_row,
                    end_col: r.end_col,
                }).collect();
            }
        }
        // Freeze panes
        if let Ok(freeze_configs) = state.freeze_configs.lock() {
            if let Some(fc) = freeze_configs.get(i) {
                sheet.freeze_row = fc.freeze_row;
                sheet.freeze_col = fc.freeze_col;
            }
        }
        // Tab color
        if let Ok(tab_colors) = state.tab_colors.lock() {
            if let Some(color) = tab_colors.get(i) {
                sheet.tab_color = color.clone();
            }
        }
        // Visibility
        if let Ok(vis) = state.sheet_visibility.lock() {
            if let Some(v) = vis.get(i) {
                sheet.visibility = v.clone();
            }
        }
        // Gridlines
        if let Ok(gridlines) = state.show_gridlines.lock() {
            if let Some(&visible) = gridlines.get(i) {
                sheet.show_gridlines = visible;
            }
        }

        workbook.sheets.push(sheet);
    }

    // Named ranges
    if let Ok(named_ranges) = state.named_ranges.lock() {
        workbook.named_ranges = named_ranges.values().map(|nr| persistence::SavedNamedRange {
            name: nr.name.clone(),
            refers_to: nr.refers_to.clone(),
            sheet_id: nr.sheet_index.map(|idx| sheet_index_to_id(&sheet_ids, idx)),
        }).collect();
    }

    // Tables
    workbook.tables = collect_tables_for_save(&tables, &sheet_ids);

    Ok(workbook)
}

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
            })
            .collect();
    }
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
    crate::slicer::Slicer {
        id: saved.id,
        name: saved.name.clone(),
        header_text: saved.header_text.clone(),
        sheet_index: sheet_id_to_index(workbook, saved.sheet_id),
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
            let props: Vec<crate::slicer::computed::SlicerComputedProperty> = saved
                .computed_properties
                .iter()
                .map(|sp| {
                    let cached_ast = parser::parse(&sp.formula)
                        .ok()
                        .map(|parsed| crate::convert_expr(&parsed));
                    crate::slicer::computed::SlicerComputedProperty {
                        id: sp.id,
                        slicer_id,
                        attribute: sp.attribute.clone(),
                        formula: sp.formula.clone(),
                        cached_ast,
                        cached_value: None,
                    }
                })
                .collect();
            computed_props.insert(slicer_id, props);
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
        source_type: match f.source_type {
            crate::slicer::SlicerSourceType::Table => persistence::SavedSlicerSourceType::Table,
            crate::slicer::SlicerSourceType::Pivot => persistence::SavedSlicerSourceType::Pivot,
            crate::slicer::SlicerSourceType::BiConnection => persistence::SavedSlicerSourceType::BiConnection,
        },
        cache_source_id: f.cache_source_id,
        field_name: f.field_name.clone(),
        field_data_type: f.field_data_type.clone(),
        connection_mode: match f.connection_mode {
            crate::ribbon_filter::ConnectionMode::Manual => persistence::SavedConnectionMode::Manual,
            crate::ribbon_filter::ConnectionMode::BySheet => persistence::SavedConnectionMode::BySheet,
            crate::ribbon_filter::ConnectionMode::Workbook => persistence::SavedConnectionMode::Workbook,
        },
        connected_sources: f.connected_sources.iter().map(|c| {
            persistence::SavedSlicerConnection {
                source_type: match c.source_type {
                    crate::slicer::SlicerSourceType::Table => persistence::SavedSlicerSourceType::Table,
                    crate::slicer::SlicerSourceType::Pivot => persistence::SavedSlicerSourceType::Pivot,
                    crate::slicer::SlicerSourceType::BiConnection => persistence::SavedSlicerSourceType::BiConnection,
                },
                source_id: c.source_id,
            }
        }).collect(),
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

fn saved_to_ribbon_filter(saved: &persistence::SavedRibbonFilter) -> crate::ribbon_filter::RibbonFilter {
    crate::ribbon_filter::RibbonFilter {
        id: saved.id,
        name: saved.name.clone(),
        source_type: match saved.source_type {
            persistence::SavedSlicerSourceType::Table => crate::slicer::SlicerSourceType::Table,
            persistence::SavedSlicerSourceType::Pivot => crate::slicer::SlicerSourceType::Pivot,
            persistence::SavedSlicerSourceType::BiConnection => crate::slicer::SlicerSourceType::BiConnection,
        },
        cache_source_id: saved.cache_source_id,
        field_name: saved.field_name.clone(),
        field_data_type: saved.field_data_type.clone(),
        connection_mode: match saved.connection_mode {
            persistence::SavedConnectionMode::Manual => crate::ribbon_filter::ConnectionMode::Manual,
            persistence::SavedConnectionMode::BySheet => crate::ribbon_filter::ConnectionMode::BySheet,
            persistence::SavedConnectionMode::Workbook => crate::ribbon_filter::ConnectionMode::Workbook,
        },
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
// Chart <-> SavedChart conversion
// ============================================================================

/// Collect charts from AppState into SavedChart format for persistence.
fn collect_charts_for_save(state: &State<AppState>, sheet_ids: &[SheetId]) -> Vec<persistence::SavedChart> {
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
fn collect_sparklines_for_save(state: &State<AppState>, sheet_ids: &[SheetId]) -> Vec<persistence::SavedSparkline> {
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
            applied_calc_group: meta.applied_calc_group.clone(),
            drill_through: meta.drill_through.clone(),
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
            applied_calc_group: saved.applied_calc_group,
            last_query: None,
            lookup_columns: saved.lookup_columns.into_iter().collect(),
            drill_through: saved.drill_through,
        });
    }
}

// ============================================================================
// COMMANDS
// ============================================================================

#[tauri::command]
pub fn save_file(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    script_state: State<crate::scripting::types::ScriptState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    path: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // If calculate_before_save is enabled, recalculate all formulas first
    {
        let calc_before_save = *state.calculate_before_save.lock().unwrap();
        if calc_before_save {
            let _ = crate::calculation::calculate_now(
                state.clone(),
                user_files_state.clone(),
                pivot_state.clone(),
            );
        }
    }

    // Multi-sheet workbook build (BUG-0011: the old inline single-sheet
    // Workbook::from_grid build dropped every sheet but the active one).
    // build_workbook_for_save captures all sheets, tables, charts,
    // sparklines, user files, theme and defaults, and runs the per-sheet
    // metadata enrichment.
    let mut workbook = build_workbook_for_save(&state, &user_files_state)?;
    let sheet_ids_save = state.sheet_ids.lock().map_err(|e| e.to_string())?;
    workbook.slicers = collect_slicers_for_save(&slicer_state, &sheet_ids_save);
    workbook.ribbon_filters = collect_ribbon_filters_for_save(&ribbon_filter_state);
    workbook.pivot_layouts = state.pivot_layouts.lock().unwrap().clone();
    workbook.object_scripts = state.object_scripts.lock().unwrap().clone();
    workbook.scripts = collect_scripts_for_save(&script_state);
    workbook.notebooks = collect_notebooks_for_save(&script_state);

    // Collect full pivot definitions from PivotState
    collect_pivot_definitions(&pivot_state, &state, &mut workbook);

    // Capture per-BI-connection "view as" RLS role selections so they survive
    // save/reload (re-applied when the connection is re-created on re-pull).
    workbook.bi_connection_roles = crate::bi::commands::collect_bi_connection_roles(&bi_state);

    // Embed locally-authored BI connections (model + spec + bindings, no creds)
    // so they reconstruct on open without the original model file.
    workbook.bi_connections = crate::bi::commands::capture_local_bi_connections(&bi_state);

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

    // Save workbook properties (update last_modified timestamp)
    {
        let mut props = state.workbook_properties.lock().unwrap();
        props.last_modified = chrono::Utc::now().to_rfc3339();
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

    // Sheet-level metadata was already enriched by build_workbook_for_save.
    drop(sheet_ids_save);

    let path_buf = PathBuf::from(&path);

    // Route by file extension
    let ext = path_buf
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "cala" => save_calcula(&workbook, &path_buf).map_err(|e| e.to_string())?,
        _ => save_xlsx(&workbook, &path_buf).map_err(|e| e.to_string())?,
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
    script_state: State<crate::scripting::types::ScriptState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    path: String,
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
        "cala" => load_calcula(&path_buf).map_err(|e| e.to_string())?,
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

            // Build remap table: local style index -> shared style index
            let local_all = local_styles.all_styles();
            let mut remap: Vec<usize> = Vec::with_capacity(local_all.len());
            for style in local_all {
                remap.push(shared_styles.get_or_create(style.clone()));
            }

            // Remap style_index on every cell in this grid
            for (_key, cell) in grid.cells.iter_mut() {
                if cell.style_index < remap.len() {
                    cell.style_index = remap[cell.style_index];
                }
            }

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
                        rich_content: None,
                        width: 200.0,
                        height: 100.0,
                        visible: false,
                        created_at: chrono::Utc::now().to_rfc3339(),
                        modified_at: None,
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

        let mut tables_guard = state.tables.lock().map_err(|e| e.to_string())?;
        for (sheet_index, sheet_tables) in tables_guard.iter_mut() {
            for table in sheet_tables.values_mut() {
                if table.style_options.show_filter_button {
                    auto_filters.entry(*sheet_index).or_insert_with(|| {
                        crate::autofilter::AutoFilter::new(
                            table.start_row,
                            table.start_col,
                            table.end_row,
                            table.end_col,
                        )
                    });
                    table.auto_filter_id = Some(*sheet_index as u64);
                }
            }
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
            let style = styles.get(cell.style_index);
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
                style_index: cell.style_index,
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
    state.cell_protection.lock().map_err(|e| e.to_string())?.clear();

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

    // Reset theme to default
    *state.theme.lock().map_err(|e| e.to_string())? = engine::ThemeDefinition::office();

    // Clear slicer state
    slicer_state.slicers.lock().unwrap().clear();
    slicer_state.computed_properties.lock().unwrap().clear();
    slicer_state.computed_prop_dependencies.lock().unwrap().clear();
    slicer_state.computed_prop_dependents.lock().unwrap().clear();

    // Clear chart state
    state.charts.lock().unwrap().clear();

    // Clear sparkline state (BUG-0004: sparklines survived File > New)
    state.sparklines.lock().unwrap().clear();

    // Clear script/notebook state
    script_state.workbook_scripts.lock().unwrap().clear();
    script_state.workbook_notebooks.lock().unwrap().clear();

    // Clear object scripts — otherwise the previous workbook's scripts
    // (including distributed ones) leak into the new workbook and get saved
    // with it. Same family as the writeback-index leak fixed in Wave 0.
    state.object_scripts.lock().unwrap().clear();
    state.pivot_layouts.lock().unwrap().clear();

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

    // Build sheet inputs — use stored grids for non-active sheets, active grid for current
    let mut sheet_inputs: Vec<SheetInput> = Vec::new();
    for (i, name) in sheet_names.iter().enumerate() {
        if i == active_sheet {
            sheet_inputs.push(SheetInput {
                name,
                grid: &active_grid,
                styles: &styles,
            });
        } else if let Some(grid) = grids.get(i) {
            sheet_inputs.push(SheetInput {
                name,
                grid,
                styles: &styles,
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

/// Write a text string to a file with the specified encoding.
#[tauri::command]
pub fn write_text_file(path: String, content: String, encoding: Option<String>, window: tauri::Window) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
                    last_output: c.last_output.clone(),
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

#[tauri::command]
pub fn auto_recover_save(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    script_state: State<crate::scripting::types::ScriptState>,
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

    // Build the workbook from current state
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let col_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
    let row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
    let tables = state.tables.lock().map_err(|e| e.to_string())?;
    let sheet_ids_ar = state.sheet_ids.lock().map_err(|e| e.to_string())?;

    let dimensions = DimensionData {
        column_widths: col_widths.clone(),
        row_heights: row_heights.clone(),
    };

    let mut workbook = Workbook::from_grid(&grid, &styles, &dimensions);
    workbook.tables = collect_tables_for_save(&tables, &sheet_ids_ar);
    workbook.slicers = collect_slicers_for_save(&slicer_state, &sheet_ids_ar);
    workbook.ribbon_filters = collect_ribbon_filters_for_save(&ribbon_filter_state);
    workbook.pivot_layouts = state.pivot_layouts.lock().unwrap().clone();
    workbook.object_scripts = state.object_scripts.lock().unwrap().clone();
    workbook.scripts = collect_scripts_for_save(&script_state);
    workbook.notebooks = collect_notebooks_for_save(&script_state);
    workbook.charts = collect_charts_for_save(&state, &sheet_ids_ar);
    workbook.sparklines = collect_sparklines_for_save(&state, &sheet_ids_ar);
    workbook.user_files = user_files_state
        .files
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    workbook.theme = state.theme.lock().unwrap().clone();
    workbook.default_row_height = *state.default_row_height.lock().unwrap();
    workbook.default_column_width = *state.default_column_width.lock().unwrap();

    // Enrich with sheet-level metadata (merged regions, freeze panes, etc.)
    enrich_workbook_metadata(&mut workbook, &state, &sheet_ids_ar);

    // Save as .cala format to the recovery path
    calcula_format::save_calcula(&workbook, &recovery_path).map_err(|e| e.to_string())?;

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
                        last_output: c.last_output.clone(),
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
