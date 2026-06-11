//! FILENAME: app/src-tauri/src/state_digest.rs
// PURPOSE: Canonical workbook-state digest for e2e testing oracles.
// CONTEXT: The digest captures everything undo/redo and save/reload must
// preserve, assembled directly from AppState (NOT the save path, which is
// lossy). Test oracles compare two digests to detect state corruption:
//   - undo round-trip:    digest -> N actions -> undo N -> digest must match
//   - save/reload:        digest -> save -> open -> digest must match
//   - recalc consistency: digest cells -> calculate_now -> cells must match
//
// Determinism rules:
//   - Collections derived from HashMaps are emitted as BTreeMaps (sorted keys)
//     or sorted Vecs so two digests of identical state serialize identically.
//   - Volatile state is excluded: timestamps, undo stack, dependency maps,
//     file path, locale, selection/scroll, id registry, calp subscriptions.
// Hashing/canonicalization happens on the TypeScript side (app/e2e/oracles/).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::AppState;
use crate::log_info;

// ============================================================================
// TYPES
// ============================================================================

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestOptions {
    /// When true, only sheet cell content is captured (faster; used by the
    /// recalc-consistency oracle which only cares about values).
    #[serde(default)]
    pub cells_only: bool,
}

/// One cell, in canonical form.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellDigest {
    /// Formatted display text (what the user sees).
    pub v: String,
    /// The raw CellValue as JSON (catches changes invisible in display text).
    pub raw: Value,
    /// Canonical (non-localized) formula without leading '=', if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub f: Option<String>,
    /// Style index into usedStyles.
    pub s: usize,
    /// Rich text runs, if any.
    #[serde(skip_serializing_if = "Value::is_null")]
    pub rt: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetDigest {
    pub name: String,
    /// Cells keyed "row:col".
    pub cells: BTreeMap<String, CellDigest>,
    /// Merged regions as [startRow, startCol, endRow, endCol], sorted.
    pub merged_regions: Vec<[u32; 4]>,
    pub freeze_row: Option<u32>,
    pub freeze_col: Option<u32>,
    pub col_widths: BTreeMap<u32, f64>,
    pub row_heights: BTreeMap<u32, f64>,
    pub tab_color: String,
    pub visibility: String,
    pub show_gridlines: bool,
    pub page_setup: Value,
    pub split: Value,
    pub scroll_area: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookStateDigest {
    /// Digest format version. Bump when the shape changes; the TS side checks.
    pub version: u32,
    pub active_sheet: usize,
    pub sheet_names: Vec<String>,
    /// Parallel to sheet_names (order is meaningful).
    pub sheets: Vec<SheetDigest>,
    /// Styles referenced by at least one cell: index -> CellStyle JSON.
    /// Style indices are not stable across save/reload; the saveReload diff
    /// profile resolves indices through this map and compares content.
    pub used_styles: BTreeMap<usize, Value>,
    pub named_ranges: BTreeMap<String, Value>,
    pub named_styles: BTreeMap<String, Value>,
    /// Table id -> Table.
    pub tables: BTreeMap<String, Value>,
    pub slicers: BTreeMap<String, Value>,
    pub ribbon_filters: BTreeMap<String, Value>,
    /// Chart id -> ChartEntry.
    pub charts: BTreeMap<String, Value>,
    /// Sheet index -> sorted sparkline groups_json strings.
    pub sparklines: BTreeMap<String, Vec<String>>,
    /// Pivot id -> PivotDefinition JSON (cache is derived state, excluded).
    pub pivots: BTreeMap<String, Value>,
    /// Sheet index -> conditional format definitions (rule order preserved).
    pub conditional_formats: BTreeMap<String, Value>,
    /// Sheet index -> validation ranges (order preserved).
    pub data_validations: BTreeMap<String, Value>,
    /// "sheet:row:col" -> Comment.
    pub comments: BTreeMap<String, Value>,
    /// "sheet:row:col" -> Note.
    pub notes: BTreeMap<String, Value>,
    /// "sheet:row:col" -> Hyperlink.
    pub hyperlinks: BTreeMap<String, Value>,
    /// Sheet index -> AutoFilter.
    pub auto_filters: BTreeMap<String, Value>,
    /// Sheet index -> SheetOutline (row/column grouping).
    pub outlines: BTreeMap<String, Value>,
    /// Sheet index -> scenarios.
    pub scenarios: BTreeMap<String, Value>,
    /// "sheet:row:col" -> ControlMetadata.
    pub controls: BTreeMap<String, Value>,
    /// Sheet index -> SheetComputedProperties.
    pub computed_properties: BTreeMap<String, Value>,
    /// Sheet index -> SheetProtection.
    pub sheet_protection: BTreeMap<String, Value>,
    /// "sheet:row:col" -> CellProtection.
    pub cell_protection: BTreeMap<String, Value>,
    pub workbook_protection: Value,
    /// Sheet index -> hidden row indices (advanced filter), sorted.
    pub advanced_filter_hidden_rows: BTreeMap<String, Vec<u32>>,
    /// Protected regions sorted by id. Extension-registered (pivot/chart);
    /// TS diff profiles may exclude these (re-registration timing varies).
    pub protected_regions: Vec<Value>,
    pub pivot_layouts: Vec<Value>,
    pub object_scripts: Vec<Value>,
    pub theme: Value,
    pub defaults: Value,
}

// ============================================================================
// HELPERS
// ============================================================================

fn to_value_or_null<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// Stable string key for any serializable id type (EntityId, PivotId, ...).
fn id_key<T: Serialize>(id: &T) -> String {
    match serde_json::to_value(id) {
        Ok(Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::from("<unserializable-id>"),
    }
}

fn cell_key(row: u32, col: u32) -> String {
    format!("{}:{}", row, col)
}

fn sheet_cell_key(sheet: usize, row: u32, col: u32) -> String {
    format!("{}:{}:{}", sheet, row, col)
}

/// Build the cell map for one grid and record used style indices.
fn digest_cells(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    locale: &engine::LocaleSettings,
    used_styles: &mut BTreeMap<usize, Value>,
) -> BTreeMap<String, CellDigest> {
    let mut cells = BTreeMap::new();
    for ((row, col), cell) in grid.cells.iter() {
        let style = styles.get(cell.style_index);
        used_styles
            .entry(cell.style_index)
            .or_insert_with(|| to_value_or_null(style));
        cells.insert(
            cell_key(*row, *col),
            CellDigest {
                v: crate::format_cell_value(&cell.value, style, locale),
                raw: to_value_or_null(&cell.value),
                f: cell.formula_string(),
                s: cell.style_index,
                rt: to_value_or_null(&cell.rich_text),
            },
        );
    }
    cells
}

// ============================================================================
// COMMAND
// ============================================================================

/// Build a canonical digest of the full workbook state for testing oracles.
///
/// Reads the active sheet from the `state.grid` mirror (NOT `grids[active]`,
/// which is stale — see get_watch_cells in commands/data.rs) and all other
/// sheets from `state.grids`.
#[tauri::command]
pub fn get_workbook_state_digest(
    state: State<AppState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    options: Option<DigestOptions>,
) -> Result<WorkbookStateDigest, String> {
    let opts = options.unwrap_or_default();
    log_info!("DIGEST", "get_workbook_state_digest cells_only={}", opts.cells_only);

    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?.clone();
    let sheet_count = sheet_names.len();
    let locale = state.locale.lock().map_err(|e| e.to_string())?.clone();

    let mut used_styles: BTreeMap<usize, Value> = BTreeMap::new();
    let mut sheets: Vec<SheetDigest> = Vec::with_capacity(sheet_count);

    // ---- Per-sheet content ----
    {
        let grids = state.grids.lock().map_err(|e| e.to_string())?;
        let active_grid = state.grid.lock().map_err(|e| e.to_string())?;
        let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
        let active_cw = state.column_widths.lock().map_err(|e| e.to_string())?;
        let active_rh = state.row_heights.lock().map_err(|e| e.to_string())?;
        let all_merged = state.all_merged_regions.lock().map_err(|e| e.to_string())?;
        let active_merged = state.merged_regions.lock().map_err(|e| e.to_string())?;
        let freeze_configs = state.freeze_configs.lock().map_err(|e| e.to_string())?;
        let split_configs = state.split_configs.lock().map_err(|e| e.to_string())?;
        let tab_colors = state.tab_colors.lock().map_err(|e| e.to_string())?;
        let visibility = state.sheet_visibility.lock().map_err(|e| e.to_string())?;
        let gridlines = state.show_gridlines.lock().map_err(|e| e.to_string())?;
        let page_setups = state.page_setups.lock().map_err(|e| e.to_string())?;
        let scroll_areas = state.scroll_areas.lock().map_err(|e| e.to_string())?;

        for i in 0..sheet_count {
            // The active-sheet mirror is authoritative for the active sheet.
            let grid: &engine::Grid = if i == active_sheet {
                &active_grid
            } else {
                match grids.get(i) {
                    Some(g) => g,
                    None => continue,
                }
            };

            let cells = digest_cells(grid, &styles, &locale, &mut used_styles);

            if opts.cells_only {
                sheets.push(SheetDigest {
                    name: sheet_names.get(i).cloned().unwrap_or_default(),
                    cells,
                    merged_regions: Vec::new(),
                    freeze_row: None,
                    freeze_col: None,
                    col_widths: BTreeMap::new(),
                    row_heights: BTreeMap::new(),
                    tab_color: String::new(),
                    visibility: String::new(),
                    show_gridlines: true,
                    page_setup: Value::Null,
                    split: Value::Null,
                    scroll_area: None,
                });
                continue;
            }

            let mut merged: Vec<[u32; 4]> = if i == active_sheet {
                active_merged
                    .iter()
                    .map(|r| [r.start_row, r.start_col, r.end_row, r.end_col])
                    .collect()
            } else {
                all_merged
                    .get(i)
                    .map(|set| {
                        set.iter()
                            .map(|r| [r.start_row, r.start_col, r.end_row, r.end_col])
                            .collect()
                    })
                    .unwrap_or_default()
            };
            merged.sort_unstable();

            let col_widths: BTreeMap<u32, f64> = if i == active_sheet {
                active_cw.iter().map(|(k, v)| (*k, *v)).collect()
            } else {
                all_cw
                    .get(i)
                    .map(|m| m.iter().map(|(k, v)| (*k, *v)).collect())
                    .unwrap_or_default()
            };
            let row_heights: BTreeMap<u32, f64> = if i == active_sheet {
                active_rh.iter().map(|(k, v)| (*k, *v)).collect()
            } else {
                all_rh
                    .get(i)
                    .map(|m| m.iter().map(|(k, v)| (*k, *v)).collect())
                    .unwrap_or_default()
            };

            let fc = freeze_configs.get(i);
            sheets.push(SheetDigest {
                name: sheet_names.get(i).cloned().unwrap_or_default(),
                cells,
                merged_regions: merged,
                freeze_row: fc.and_then(|f| f.freeze_row),
                freeze_col: fc.and_then(|f| f.freeze_col),
                col_widths,
                row_heights,
                tab_color: tab_colors.get(i).cloned().unwrap_or_default(),
                visibility: visibility
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| "visible".to_string()),
                show_gridlines: gridlines.get(i).copied().unwrap_or(true),
                page_setup: page_setups
                    .get(i)
                    .map(to_value_or_null)
                    .unwrap_or(Value::Null),
                split: split_configs
                    .get(i)
                    .map(to_value_or_null)
                    .unwrap_or(Value::Null),
                scroll_area: scroll_areas.get(i).cloned().flatten(),
            });
        }
    }

    let mut digest = WorkbookStateDigest {
        version: 1,
        active_sheet,
        sheet_names,
        sheets,
        used_styles,
        named_ranges: BTreeMap::new(),
        named_styles: BTreeMap::new(),
        tables: BTreeMap::new(),
        slicers: BTreeMap::new(),
        ribbon_filters: BTreeMap::new(),
        charts: BTreeMap::new(),
        sparklines: BTreeMap::new(),
        pivots: BTreeMap::new(),
        conditional_formats: BTreeMap::new(),
        data_validations: BTreeMap::new(),
        comments: BTreeMap::new(),
        notes: BTreeMap::new(),
        hyperlinks: BTreeMap::new(),
        auto_filters: BTreeMap::new(),
        outlines: BTreeMap::new(),
        scenarios: BTreeMap::new(),
        controls: BTreeMap::new(),
        computed_properties: BTreeMap::new(),
        sheet_protection: BTreeMap::new(),
        cell_protection: BTreeMap::new(),
        workbook_protection: Value::Null,
        advanced_filter_hidden_rows: BTreeMap::new(),
        protected_regions: Vec::new(),
        pivot_layouts: Vec::new(),
        object_scripts: Vec::new(),
        theme: Value::Null,
        defaults: Value::Null,
    };

    if opts.cells_only {
        return Ok(digest);
    }

    // ---- Workbook-level stores ----
    if let Ok(named_ranges) = state.named_ranges.lock() {
        for (name, nr) in named_ranges.iter() {
            digest.named_ranges.insert(name.clone(), to_value_or_null(nr));
        }
    }
    if let Ok(named_styles) = state.named_styles.lock() {
        for (name, ns) in named_styles.iter() {
            digest.named_styles.insert(name.clone(), to_value_or_null(ns));
        }
    }
    if let Ok(tables) = state.tables.lock() {
        for sheet_tables in tables.values() {
            for (id, table) in sheet_tables.iter() {
                digest.tables.insert(id_key(id), to_value_or_null(table));
            }
        }
    }
    if let Ok(slicers) = slicer_state.slicers.lock() {
        for (id, slicer) in slicers.iter() {
            digest.slicers.insert(id_key(id), to_value_or_null(slicer));
        }
    }
    if let Ok(filters) = ribbon_filter_state.filters.lock() {
        for (id, filter) in filters.iter() {
            digest
                .ribbon_filters
                .insert(id_key(id), to_value_or_null(filter));
        }
    }
    if let Ok(charts) = state.charts.lock() {
        for chart in charts.iter() {
            digest.charts.insert(id_key(&chart.id), to_value_or_null(chart));
        }
    }
    if let Ok(sparklines) = state.sparklines.lock() {
        for entry in sparklines.iter() {
            digest
                .sparklines
                .entry(entry.sheet_index.to_string())
                .or_default()
                .push(entry.groups_json.clone());
        }
        for groups in digest.sparklines.values_mut() {
            groups.sort_unstable();
        }
    }
    if let Ok(pivot_tables) = pivot_state.pivot_tables.lock() {
        for (id, (definition, _cache)) in pivot_tables.iter() {
            digest.pivots.insert(id_key(id), to_value_or_null(definition));
        }
    }
    if let Ok(cf) = state.conditional_formats.lock() {
        for (sheet, defs) in cf.iter() {
            digest
                .conditional_formats
                .insert(sheet.to_string(), to_value_or_null(defs));
        }
    }
    if let Ok(dv) = state.data_validations.lock() {
        for (sheet, ranges) in dv.iter() {
            digest
                .data_validations
                .insert(sheet.to_string(), to_value_or_null(ranges));
        }
    }
    if let Ok(comments) = state.comments.lock() {
        for (sheet, sheet_comments) in comments.iter() {
            for ((row, col), comment) in sheet_comments.iter() {
                digest.comments.insert(
                    sheet_cell_key(*sheet, *row, *col),
                    to_value_or_null(comment),
                );
            }
        }
    }
    if let Ok(notes) = state.notes.lock() {
        for (sheet, sheet_notes) in notes.iter() {
            for ((row, col), note) in sheet_notes.iter() {
                digest
                    .notes
                    .insert(sheet_cell_key(*sheet, *row, *col), to_value_or_null(note));
            }
        }
    }
    if let Ok(hyperlinks) = state.hyperlinks.lock() {
        for (sheet, sheet_links) in hyperlinks.iter() {
            for ((row, col), link) in sheet_links.iter() {
                digest
                    .hyperlinks
                    .insert(sheet_cell_key(*sheet, *row, *col), to_value_or_null(link));
            }
        }
    }
    if let Ok(auto_filters) = state.auto_filters.lock() {
        for (sheet, af) in auto_filters.iter() {
            digest
                .auto_filters
                .insert(sheet.to_string(), to_value_or_null(af));
        }
    }
    if let Ok(outlines) = state.outlines.lock() {
        for (sheet, outline) in outlines.iter() {
            digest
                .outlines
                .insert(sheet.to_string(), to_value_or_null(outline));
        }
    }
    if let Ok(scenarios) = state.scenarios.lock() {
        for (sheet, list) in scenarios.iter() {
            digest
                .scenarios
                .insert(sheet.to_string(), to_value_or_null(list));
        }
    }
    if let Ok(controls) = state.controls.lock() {
        for ((sheet, row, col), metadata) in controls.iter() {
            digest.controls.insert(
                sheet_cell_key(*sheet, *row, *col),
                to_value_or_null(metadata),
            );
        }
    }
    if let Ok(props) = state.computed_properties.lock() {
        // ComputedProperty carries derived caches (AST, cached value) and tuple
        // map keys, so digest only the semantic fields, with string keys.
        fn prop_list(list: &[crate::computed_properties::ComputedProperty]) -> Value {
            Value::Array(
                list.iter()
                    .map(|p| {
                        serde_json::json!({
                            "id": p.id,
                            "attribute": p.attribute,
                            "formula": p.formula,
                        })
                    })
                    .collect(),
            )
        }
        for (sheet, sheet_props) in props.iter() {
            let mut cols: BTreeMap<String, Value> = BTreeMap::new();
            for (col, list) in sheet_props.column_props.iter() {
                cols.insert(col.to_string(), prop_list(list));
            }
            let mut rows: BTreeMap<String, Value> = BTreeMap::new();
            for (row, list) in sheet_props.row_props.iter() {
                rows.insert(row.to_string(), prop_list(list));
            }
            let mut cells: BTreeMap<String, Value> = BTreeMap::new();
            for ((row, col), list) in sheet_props.cell_props.iter() {
                cells.insert(cell_key(*row, *col), prop_list(list));
            }
            digest.computed_properties.insert(
                sheet.to_string(),
                serde_json::json!({ "columns": cols, "rows": rows, "cells": cells }),
            );
        }
    }
    if let Ok(protection) = state.sheet_protection.lock() {
        for (sheet, p) in protection.iter() {
            digest
                .sheet_protection
                .insert(sheet.to_string(), to_value_or_null(p));
        }
    }
    if let Ok(cell_protection) = state.cell_protection.lock() {
        for (sheet, sheet_cells) in cell_protection.iter() {
            for ((row, col), p) in sheet_cells.iter() {
                digest
                    .cell_protection
                    .insert(sheet_cell_key(*sheet, *row, *col), to_value_or_null(p));
            }
        }
    }
    if let Ok(wp) = state.workbook_protection.lock() {
        digest.workbook_protection = to_value_or_null(&*wp);
    }
    if let Ok(hidden) = state.advanced_filter_hidden_rows.lock() {
        for (sheet, rows) in hidden.iter() {
            let mut sorted = rows.clone();
            sorted.sort_unstable();
            digest
                .advanced_filter_hidden_rows
                .insert(sheet.to_string(), sorted);
        }
    }
    if let Ok(regions) = state.protected_regions.lock() {
        let mut list: Vec<Value> = regions
            .iter()
            .map(|r| {
                serde_json::json!({
                    "id": r.id,
                    "regionType": r.region_type,
                    "ownerId": to_value_or_null(&r.owner_id),
                    "sheetIndex": r.sheet_index,
                    "startRow": r.start_row,
                    "startCol": r.start_col,
                    "endRow": r.end_row,
                    "endCol": r.end_col,
                })
            })
            .collect();
        list.sort_unstable_by_key(|v| v["id"].to_string());
        digest.protected_regions = list;
    }
    if let Ok(layouts) = state.pivot_layouts.lock() {
        digest.pivot_layouts = layouts.iter().map(to_value_or_null).collect();
    }
    if let Ok(scripts) = state.object_scripts.lock() {
        digest.object_scripts = scripts.iter().map(to_value_or_null).collect();
    }
    if let Ok(theme) = state.theme.lock() {
        digest.theme = to_value_or_null(&*theme);
    }

    let default_row_height = *state.default_row_height.lock().map_err(|e| e.to_string())?;
    let default_column_width = *state.default_column_width.lock().map_err(|e| e.to_string())?;
    let reference_style = state.reference_style.lock().map_err(|e| e.to_string())?.clone();
    digest.defaults = serde_json::json!({
        "defaultRowHeight": default_row_height,
        "defaultColumnWidth": default_column_width,
        "referenceStyle": reference_style,
    });

    Ok(digest)
}
