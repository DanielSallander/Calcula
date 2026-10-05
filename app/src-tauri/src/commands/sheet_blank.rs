//! FILENAME: app/src-tauri/src/commands/sheet_blank.rs
//! PURPOSE: `sheet_is_blank` -- the one backend answer to "does deleting this
//!          sheet lose anything?", asked by the Delete Sheet rule (a blank
//!          sheet is deleted without a confirmation, as in Excel).
//! CONTEXT: The adversarial review of the Home-tab programme (2026-10-04)
//!          found the frontend rule deciding "blank" from the used range plus
//!          the overlay regions. Both see only CELLS and a few overlays, so a
//!          sheet holding only a note, a whole-number validation rule, a plain
//!          conditional format or a sheet-scoped name read as blank -- and was
//!          deleted with no question and no undo (deleting a sheet ends the
//!          undo history). This asks EVERY sheet-keyed store instead, so a
//!          store added later has one place to be named.
//!
//! "Every doubt answers ask": anything the user put on the sheet counts --
//! content, formatting, sizes, hidden lines, rules, objects, names, filters,
//! a print area, protection. View settings (zoom, gridlines, frozen panes, the
//! tab colour) do not: losing them loses nothing the user built.

use crate::AppState;
use tauri::State;

#[cfg(test)]
#[path = "sheet_blank_tests.rs"]
mod tests;

/// True when the sheet at `sheet_index` holds nothing a delete would lose.
/// A read: it decides nothing and dirties nothing. `Err` for an index past
/// the workbook.
#[tauri::command]
pub fn sheet_is_blank(
    state: State<AppState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    sheet_index: usize,
) -> Result<bool, String> {
    sheet_contents(&state, &pivot_state, &slicer_state, &timeline_state, sheet_index).map(|kinds| kinds.is_empty())
}

/// What the sheet holds, by kind ("cells", "notes", ...): empty means blank.
/// Each store is read on its own and released before the next, so this adds
/// no ordering edge between any two locks; `grid` and `grids` are read one
/// after the other in the canonical order.
pub(crate) fn sheet_contents(
    state: &AppState,
    pivot_state: &crate::pivot::types::PivotState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    sheet: usize,
) -> Result<Vec<&'static str>, String> {
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let Some(sheet_name) = sheet_names.get(sheet).cloned() else {
        return Err(format!("Sheet index {} out of range: workbook has {} sheet(s)", sheet, sheet_names.len()));
    };
    let sheet_id = state.sheet_ids.read().map_err(|e| e.to_string())?.get(sheet).copied();
    let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let mut kinds: Vec<&'static str> = Vec::new();
    let mut note = |present: bool, kind: &'static str| {
        if present {
            kinds.push(kind);
        }
    };

    // The cells and the whole-line formats. The active sheet's live copy is
    // the mirror (`state.grid`); every other sheet's is `grids[sheet]`.
    {
        let read = |g: &engine::Grid| {
            (
                !g.cells.is_empty(),
                g.row_styles.values().any(|&i| i != 0) || g.column_styles.values().any(|&i| i != 0),
            )
        };
        let (cells, tiers) = if sheet == active {
            read(&*state.grid.read().map_err(|e| e.to_string())?)
        } else {
            state.grids.read().map_err(|e| e.to_string())?.get(sheet).map(|g| read(g)).unwrap_or((false, false))
        };
        note(cells, "cells");
        note(tiers, "row or column formats");
    }

    // Sizes, hidden lines and merges: the active sheet's live copies are the
    // single-sheet fields, every other sheet's the per-sheet vectors.
    if sheet == active {
        note(!state.row_heights.read().map_err(|e| e.to_string())?.is_empty(), "row heights");
        note(!state.column_widths.read().map_err(|e| e.to_string())?.is_empty(), "column widths");
        note(!state.user_hidden_rows.read().map_err(|e| e.to_string())?.is_empty(), "hidden rows");
        note(!state.user_hidden_cols.read().map_err(|e| e.to_string())?.is_empty(), "hidden columns");
        note(!state.merged_regions.read().map_err(|e| e.to_string())?.is_empty(), "merged cells");
    } else {
        let has = |present: Option<bool>| present.unwrap_or(false);
        note(has(state.all_row_heights.read().map_err(|e| e.to_string())?.get(sheet).map(|m| !m.is_empty())), "row heights");
        note(has(state.all_column_widths.read().map_err(|e| e.to_string())?.get(sheet).map(|m| !m.is_empty())), "column widths");
        note(has(state.all_user_hidden_rows.read().map_err(|e| e.to_string())?.get(sheet).map(|s| !s.is_empty())), "hidden rows");
        note(has(state.all_user_hidden_cols.read().map_err(|e| e.to_string())?.get(sheet).map(|s| !s.is_empty())), "hidden columns");
        note(has(state.all_merged_regions.read().map_err(|e| e.to_string())?.get(sheet).map(|s| !s.is_empty())), "merged cells");
    }

    // Cell-keyed and range-keyed stores.
    note(state.notes.read().map_err(|e| e.to_string())?.get(&sheet).is_some_and(|m| !m.is_empty()), "notes");
    note(state.comments.read().map_err(|e| e.to_string())?.get(&sheet).is_some_and(|m| !m.is_empty()), "comments");
    note(state.hyperlinks.read().map_err(|e| e.to_string())?.get(&sheet).is_some_and(|m| !m.is_empty()), "hyperlinks");
    note(state.data_validations.read().map_err(|e| e.to_string())?.get(&sheet).is_some_and(|v| !v.is_empty()), "data validation");
    note(state.conditional_formats.read().map_err(|e| e.to_string())?.get(&sheet).is_some_and(|v| !v.is_empty()), "conditional formats");
    note(state.auto_filters.read().map_err(|e| e.to_string())?.contains_key(&sheet), "a filter");
    note(state.tables.read().map_err(|e| e.to_string())?.get(&sheet).is_some_and(|t| !t.is_empty()), "tables");
    note(state.cell_types.read().map_err(|e| e.to_string())?.keys().any(|k| k.0 == sheet), "cell types");
    note(state.cell_behaviors.read().map_err(|e| e.to_string())?.values().any(|b| b.sheet_index == sheet), "cell behaviors");
    note(state.controls.read().map_err(|e| e.to_string())?.keys().any(|k| k.0 == sheet), "controls or shapes");
    note(
        state
            .outlines
            .read()
            .map_err(|e| e.to_string())?
            .get(&sheet)
            .is_some_and(|o| !o.row_groups.is_empty() || !o.column_groups.is_empty()),
        "grouped rows or columns",
    );
    note(
        state
            .computed_properties
            .read()
            .map_err(|e| e.to_string())?
            .get(&sheet)
            .is_some_and(|p| !p.cell_props.is_empty() || !p.row_props.is_empty() || !p.column_props.is_empty()),
        "computed properties",
    );
    note(state.scenarios.read().map_err(|e| e.to_string())?.get(&sheet).is_some_and(|s| !s.is_empty()), "scenarios");
    note(
        state.advanced_filter_hidden_rows.read().map_err(|e| e.to_string())?.get(&sheet).is_some_and(|r| !r.is_empty()),
        "filtered rows",
    );
    note(state.spill_ranges.read().map_err(|e| e.to_string())?.keys().any(|k| k.0 == sheet), "spilled arrays");

    // Sheet-level settings the user made.
    note(
        state.named_ranges.read().map_err(|e| e.to_string())?.values().any(|n| n.sheet_index == Some(sheet)),
        "sheet-scoped names",
    );
    note(
        state.sheet_protection.read().map_err(|e| e.to_string())?.get(&sheet).is_some_and(|p| p.protected),
        "protection",
    );
    note(
        state.page_setups.read().map_err(|e| e.to_string())?.get(sheet).is_some_and(|p| !p.print_area.trim().is_empty()),
        "a print area",
    );

    // Objects placed on the sheet.
    note(state.charts.read().map_err(|e| e.to_string())?.iter().any(|c| c.sheet_index == sheet), "charts");
    note(
        state
            .sparklines
            .read()
            .map_err(|e| e.to_string())?
            .iter()
            .any(|s| s.sheet_index == sheet && !matches!(s.groups_json.trim(), "" | "[]" | "null")),
        "sparklines",
    );
    note(
        state.protected_regions.lock().map_err(|e| e.to_string())?.iter().any(|r| r.sheet_index == sheet),
        "PivotTables or reports",
    );
    note(
        pivot_state
            .pivot_tables
            .read()
            .map_err(|e| e.to_string())?
            .values()
            .any(|(def, _)| def.destination_sheet.as_deref().is_some_and(|d| d.eq_ignore_ascii_case(&sheet_name))),
        "PivotTables",
    );
    note(slicer_state.slicers.read().map_err(|e| e.to_string())?.values().any(|s| s.sheet_index == sheet), "slicers");
    note(timeline_state.timelines.read().map_err(|e| e.to_string())?.values().any(|t| t.sheet_index == sheet), "timelines");
    if let Some(id) = sheet_id {
        note(state.floating_ranges.read().map_err(|e| e.to_string())?.iter().any(|f| f.host_sheet_id == id), "floating ranges");
        note(
            state.writeback_draft_regions.read().map_err(|e| e.to_string())?.iter().any(|d| d.selector.sheet_id == id),
            "writeback regions",
        );
    }

    kinds.dedup();
    Ok(kinds)
}
