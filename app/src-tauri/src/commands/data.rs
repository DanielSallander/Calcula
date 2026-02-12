//! FILENAME: app/src-tauri/src/commands/data.rs
// PURPOSE: Core operations for reading and writing cell data.

use crate::api_types::{
    CellData, ClearApplyTo, ClearRangeParams, ClearRangeResult, MergedRegion, SortDataOption,
    SortField, SortOn, SortOrientation, SortRangeParams, SortRangeResult,
};
use crate::commands::utils::get_cell_internal_with_merge;
use crate::{
    evaluate_formula_multi_sheet, evaluate_formula_multi_sheet_with_ast,
    extract_all_references, format_cell_value, get_column_row_dependents,
    get_recalculation_order, parse_cell_input, parse_formula_to_engine_ast,
    update_column_dependencies, update_cross_sheet_dependencies, update_dependencies,
    update_row_dependencies, AppState, log_perf
};
use engine::{self, Grid, StyleRegistry};
use std::collections::HashSet;
use tauri::State;

// Note: Assuming parser is available in the crate root based on usage context
// If 'parser' is a module, ensure it is imported via `use crate::parser;` if needed.

/// Get cells for a viewport range.
/// Now includes merged cell span information.
#[tauri::command]
pub fn get_viewport_cells(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Vec<CellData> {
    let grid = state.grid.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    let mut cells = Vec::new();

    // Track which cells are "slave" cells (part of a merge but not the master)
    let mut slave_cells: HashSet<(u32, u32)> = HashSet::new();

    // First pass: identify all slave cells within the viewport
    for region in merged_regions.iter() {
        // Check if this region overlaps with the viewport
        if region.end_row < start_row
            || region.start_row > end_row
            || region.end_col < start_col
            || region.start_col > end_col
        {
            continue;
        }

        // Mark all cells except the master as slaves
        for r in region.start_row..=region.end_row {
            for c in region.start_col..=region.end_col {
                if r == region.start_row && c == region.start_col {
                    continue; // Skip master cell
                }
                slave_cells.insert((r, c));
            }
        }
    }

    for row in start_row..=end_row {
        for col in start_col..=end_col {
            // Skip slave cells - they shouldn't be returned
            if slave_cells.contains(&(row, col)) {
                continue;
            }

            if let Some(cell_data) =
                get_cell_internal_with_merge(&grid, &styles, &merged_regions, row, col)
            {
                cells.push(cell_data);
            }
        }
    }

    cells
}

/// Get a single cell's data.
#[tauri::command]
pub fn get_cell(state: State<AppState>, row: u32, col: u32) -> Option<CellData> {
    let grid = state.grid.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    get_cell_internal_with_merge(&grid, &styles, &merged_regions, row, col)
}

/// Internal helper for getting cell data without merge info (for backward compatibility).
fn get_cell_internal(grid: &Grid, styles: &StyleRegistry, row: u32, col: u32) -> Option<CellData> {
    let cell = grid.get_cell(row, col)?;
    let style = styles.get(cell.style_index);
    let display = format_cell_value(&cell.value, style);

    Some(CellData {
        row,
        col,
        display,
        formula: cell.formula.clone(),
        style_index: cell.style_index,
        row_span: 1,
        col_span: 1,
        sheet_index: None,
    })
}

/// Update a cell with new content.
/// Returns all cells that were updated (including dependent cells).
#[tauri::command]
pub fn update_cell(
    state: State<AppState>,
    row: u32,
    col: u32,
    value: String,
) -> Result<Vec<CellData>, String> {
    use std::time::Instant;
    let perf_t0 = Instant::now();

    // Check if cell is in a protected region (e.g., pivot table, chart)
    let active_sheet_for_region_check = *state.active_sheet.lock().unwrap();
    if let Some(region) = state.get_region_at_cell(active_sheet_for_region_check, row, col) {
        return Err(format!(
            "Cannot edit cell ({}, {}): it is part of a protected {} region (id: {}).",
            row + 1,
            col + 1,
            region.region_type,
            region.id
        ));
    }

    let sheet_names = state.sheet_names.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let calc_mode = state.calculation_mode.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    let perf_t1_locks = Instant::now();

    let current_sheet_name = sheet_names.get(active_sheet).cloned().unwrap_or_default();

    let mut updated_cells = Vec::new();

    // Record previous state for undo BEFORE making any changes
    let previous_cell = grid.get_cell(row, col).cloned();

    // Handle empty value - clear the cell
    if value.trim().is_empty() {
        grid.clear_cell(row, col);
        // Also update the grids vector
        if active_sheet < grids.len() {
            grids[active_sheet].clear_cell(row, col);
        }
        // Clear cross-sheet dependencies for this cell
        update_cross_sheet_dependencies(
            (active_sheet, row, col),
            HashSet::new(),
            &mut cross_sheet_dependencies_map,
            &mut cross_sheet_dependents_map,
        );
        update_dependencies(
            (row, col),
            HashSet::new(),
            &mut dependencies_map,
            &mut dependents_map,
        );
        update_column_dependencies(
            (row, col),
            HashSet::new(),
            &mut column_dependencies_map,
            &mut column_dependents_map,
        );
        update_row_dependencies(
            (row, col),
            HashSet::new(),
            &mut row_dependencies_map,
            &mut row_dependents_map,
        );

        // Get merge span info for the cleared cell
        let merge_info = merged_regions
            .iter()
            .find(|r| r.start_row == row && r.start_col == col);
        let (row_span, col_span) = if let Some(region) = merge_info {
            (
                region.end_row - region.start_row + 1,
                region.end_col - region.start_col + 1,
            )
        } else {
            (1, 1)
        };

        updated_cells.push(CellData {
            row,
            col,
            display: String::new(),
            formula: None,
            style_index: 0,
            row_span,
            col_span,
            sheet_index: None,
        });

        // Record undo after successful change
        undo_stack.record_cell_change(row, col, previous_cell);

        return Ok(updated_cells);
    }

    // Parse the input
    let mut cell = parse_cell_input(&value);

    // Preserve existing style
    if let Some(existing) = grid.get_cell(row, col) {
        cell.style_index = existing.style_index;
    }

    // If it's a formula, evaluate it using multi-sheet context
    if let Some(ref formula) = cell.formula {
        // Extract references for dependency tracking AND cache the AST
        match parser::parse(formula) {
            Ok(parsed) => {
                let refs = extract_all_references(&parsed, &grid);

                update_dependencies(
                    (row, col),
                    refs.cells,
                    &mut dependencies_map,
                    &mut dependents_map,
                );
                update_column_dependencies(
                    (row, col),
                    refs.columns,
                    &mut column_dependencies_map,
                    &mut column_dependents_map,
                );
                update_row_dependencies(
                    (row, col),
                    refs.rows,
                    &mut row_dependencies_map,
                    &mut row_dependents_map,
                );

                // Normalize cross-sheet references: match sheet names case-insensitively
                // to the official sheet_names list
                let normalized_cross_sheet_refs: HashSet<(String, u32, u32)> = refs
                    .cross_sheet_cells
                    .iter()
                    .filter_map(|(parsed_sheet_name, r, c)| {
                        // Find the official sheet name (case-insensitive match)
                        let normalized = sheet_names
                            .iter()
                            .find(|name| name.eq_ignore_ascii_case(parsed_sheet_name))
                            .cloned()
                            .unwrap_or_else(|| parsed_sheet_name.clone());
                        Some((normalized, *r, *c))
                    })
                    .collect();

                // Track cross-sheet dependencies
                update_cross_sheet_dependencies(
                    (active_sheet, row, col),
                    normalized_cross_sheet_refs,
                    &mut cross_sheet_dependencies_map,
                    &mut cross_sheet_dependents_map,
                );

                // PERF: Convert the already-parsed AST directly instead of re-parsing.
                let engine_ast = crate::convert_expr(&parsed);
                cell.set_cached_ast(engine_ast.clone());
                let result = evaluate_formula_multi_sheet_with_ast(
                    &grids,
                    &sheet_names,
                    active_sheet,
                    &engine_ast,
                );
                cell.value = result;
            }
            Err(_e) => {
                // Formula parse error - dependencies won't be tracked
                // Still try to evaluate (will return error)
                let result =
                    evaluate_formula_multi_sheet(&grids, &sheet_names, active_sheet, formula);
                cell.value = result;
            }
        }
    } else {
        // Clear dependencies for non-formula cells
        update_dependencies(
            (row, col),
            HashSet::new(),
            &mut dependencies_map,
            &mut dependents_map,
        );
        // Clear cross-sheet dependencies for non-formula cells
        update_cross_sheet_dependencies(
            (active_sheet, row, col),
            HashSet::new(),
            &mut cross_sheet_dependencies_map,
            &mut cross_sheet_dependents_map,
        );
        update_column_dependencies(
            (row, col),
            HashSet::new(),
            &mut column_dependencies_map,
            &mut column_dependents_map,
        );
        update_row_dependencies(
            (row, col),
            HashSet::new(),
            &mut row_dependencies_map,
            &mut row_dependents_map,
        );
    }

    let perf_t2_parsed = Instant::now();

    // Store the cell
    grid.set_cell(row, col, cell.clone());
    // Also update the grids vector to keep them in sync
    if active_sheet < grids.len() {
        grids[active_sheet].set_cell(row, col, cell.clone());
    }

    // Get the display value
    let style = styles.get(cell.style_index);
    let display = format_cell_value(&cell.value, style);
    let perf_t3_stored = Instant::now();

    // Get merge span info
    let merge_info = merged_regions
        .iter()
        .find(|r| r.start_row == row && r.start_col == col);
    let (row_span, col_span) = if let Some(region) = merge_info {
        (
            region.end_row - region.start_row + 1,
            region.end_col - region.start_col + 1,
        )
    } else {
        (1, 1)
    };

    updated_cells.push(CellData {
        row,
        col,
        display,
        formula: cell.formula.clone(),
        style_index: cell.style_index,
        row_span,
        col_span,
        sheet_index: None, // Current active sheet
    });

    // Record undo after successful change
    undo_stack.record_cell_change(row, col, previous_cell);

    // Recalculate dependents if automatic mode
    if *calc_mode == "automatic" {
        // Build a HashMap for O(1) merge region lookup instead of O(n) linear search
        let merge_lookup: std::collections::HashMap<(u32, u32), &MergedRegion> = merged_regions
            .iter()
            .map(|r| ((r.start_row, r.start_col), r))
            .collect();

        // Get direct cell dependents
        let mut recalc_order = get_recalculation_order((row, col), &dependents_map);

        // Also get column/row dependents (formulas with column or row references)
        // Use a HashSet for O(1) lookup instead of O(n) Vec::contains
        let recalc_set: HashSet<(u32, u32)> = recalc_order.iter().copied().collect();
        let col_row_deps =
            get_column_row_dependents((row, col), &column_dependents_map, &row_dependents_map);
        for dep in col_row_deps {
            if !recalc_set.contains(&dep) {
                recalc_order.push(dep);
            }
        }
        let perf_t4_recalc_order = Instant::now();
        let perf_same_sheet_count = recalc_order.len();
        let mut perf_cache_hits: u32 = 0;
        let mut perf_cache_misses: u32 = 0;
        let mut perf_eval_total = std::time::Duration::ZERO;

        for &(dep_row, dep_col) in &recalc_order {
            if let Some(dep_cell) = grid.get_cell(dep_row, dep_col) {
                if let Some(ref formula) = dep_cell.formula {
                    let perf_eval_start = Instant::now();
                    // Use cached AST if available for efficient evaluation
                    let result = if let Some(cached_ast) = dep_cell.get_cached_ast() {
                        perf_cache_hits += 1;
                        // Fast path: use pre-parsed AST
                        evaluate_formula_multi_sheet_with_ast(
                            &grids,
                            &sheet_names,
                            active_sheet,
                            cached_ast,
                        )
                    } else {
                        perf_cache_misses += 1;
                        // Slow path: parse and cache the AST for future use
                        if let Ok(engine_ast) = parse_formula_to_engine_ast(formula) {
                            let result = evaluate_formula_multi_sheet_with_ast(
                                &grids,
                                &sheet_names,
                                active_sheet,
                                &engine_ast,
                            );
                            // Cache the AST for next time
                            let mut updated_with_ast = dep_cell.clone();
                            updated_with_ast.set_cached_ast(engine_ast);
                            updated_with_ast.value = result.clone();
                            grid.set_cell(dep_row, dep_col, updated_with_ast.clone());
                            if active_sheet < grids.len() {
                                grids[active_sheet]
                                    .set_cell(dep_row, dep_col, updated_with_ast.clone());
                            }

                            let dep_style = styles.get(updated_with_ast.style_index);
                            let dep_display = format_cell_value(&updated_with_ast.value, dep_style);

                            let (dep_row_span, dep_col_span) =
                                if let Some(region) = merge_lookup.get(&(dep_row, dep_col)) {
                                    (
                                        region.end_row - region.start_row + 1,
                                        region.end_col - region.start_col + 1,
                                    )
                                } else {
                                    (1, 1)
                                };

                            updated_cells.push(CellData {
                                row: dep_row,
                                col: dep_col,
                                display: dep_display,
                                formula: updated_with_ast.formula.clone(),
                                style_index: updated_with_ast.style_index,
                                row_span: dep_row_span,
                                col_span: dep_col_span,
                                sheet_index: None,
                            });
                            perf_eval_total += perf_eval_start.elapsed();
                            continue; // Skip the rest of this iteration
                        }
                        // Fallback to string-based evaluation
                        evaluate_formula_multi_sheet(&grids, &sheet_names, active_sheet, formula)
                    };

                    let mut updated_dep = dep_cell.clone();
                    updated_dep.value = result;
                    grid.set_cell(dep_row, dep_col, updated_dep.clone());

                    // Also update the grids vector
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(dep_row, dep_col, updated_dep.clone());
                    }

                    let dep_style = styles.get(updated_dep.style_index);
                    let dep_display = format_cell_value(&updated_dep.value, dep_style);

                    // Get merge span info for dependent (O(1) HashMap lookup)
                    let (dep_row_span, dep_col_span) =
                        if let Some(region) = merge_lookup.get(&(dep_row, dep_col)) {
                            (
                                region.end_row - region.start_row + 1,
                                region.end_col - region.start_col + 1,
                            )
                        } else {
                            (1, 1)
                        };

                    updated_cells.push(CellData {
                        row: dep_row,
                        col: dep_col,
                        display: dep_display,
                        formula: updated_dep.formula.clone(),
                        style_index: updated_dep.style_index,
                        row_span: dep_row_span,
                        col_span: dep_col_span,
                        sheet_index: None, // Current active sheet
                    });
                    perf_eval_total += perf_eval_start.elapsed();
                }
            }
        }
        let perf_t5_same_sheet = Instant::now();

        // Also recalculate cross-sheet dependents (formulas on OTHER sheets that reference this cell)
        // Use a work queue to properly cascade recalculations across sheets
        // Work queue contains: (sheet_index, sheet_name, row, col) of cells that changed
        let mut work_queue: Vec<(usize, String, u32, u32)> =
            vec![(active_sheet, current_sheet_name.clone(), row, col)];
        let mut processed: HashSet<(usize, u32, u32)> = HashSet::new();

        // Mark the original cell and same-sheet recalculated cells as processed
        processed.insert((active_sheet, row, col));
        for (dep_row, dep_col) in &recalc_order {
            processed.insert((active_sheet, *dep_row, *dep_col));
        }

        while let Some((source_sheet_idx, source_sheet_name, source_row, source_col)) =
            work_queue.pop()
        {
            // 1. Find cross-sheet dependents (formulas on OTHER sheets that reference this cell)
            let cross_sheet_key = (source_sheet_name.clone(), source_row, source_col);

            if let Some(cross_deps) = cross_sheet_dependents_map.get(&cross_sheet_key).cloned() {
                for (dep_sheet_idx, dep_row, dep_col) in cross_deps.iter() {
                    // Skip if already processed
                    if processed.contains(&(*dep_sheet_idx, *dep_row, *dep_col)) {
                        continue;
                    }
                    processed.insert((*dep_sheet_idx, *dep_row, *dep_col));

                    // Get the dependent cell from its sheet
                    if *dep_sheet_idx < grids.len() {
                        if let Some(dep_cell) = grids[*dep_sheet_idx].get_cell(*dep_row, *dep_col) {
                            if let Some(ref formula) = dep_cell.formula {
                                // Use cached AST if available
                                let result = if let Some(cached_ast) = dep_cell.get_cached_ast() {
                                    evaluate_formula_multi_sheet_with_ast(
                                        &grids,
                                        &sheet_names,
                                        *dep_sheet_idx,
                                        cached_ast,
                                    )
                                } else {
                                    // Fallback: parse and evaluate
                                    evaluate_formula_multi_sheet(
                                        &grids,
                                        &sheet_names,
                                        *dep_sheet_idx,
                                        formula,
                                    )
                                };

                                let mut updated_dep = dep_cell.clone();
                                updated_dep.value = result.clone();
                                grids[*dep_sheet_idx].set_cell(
                                    *dep_row,
                                    *dep_col,
                                    updated_dep.clone(),
                                );

                                // Format the display value and add to updated_cells with sheet_index
                                let dep_style = styles.get(updated_dep.style_index);
                                let dep_display = format_cell_value(&updated_dep.value, dep_style);

                                // For cross-sheet cells, use default span (1,1) since merged_regions
                                // is currently tracked per-active-sheet only
                                updated_cells.push(CellData {
                                    row: *dep_row,
                                    col: *dep_col,
                                    display: dep_display,
                                    formula: updated_dep.formula.clone(),
                                    style_index: updated_dep.style_index,
                                    row_span: 1,
                                    col_span: 1,
                                    sheet_index: Some(*dep_sheet_idx),
                                });

                                // Add this updated cell to the work queue so its dependents also get recalculated
                                if let Some(dep_sheet_name) = sheet_names.get(*dep_sheet_idx) {
                                    work_queue.push((
                                        *dep_sheet_idx,
                                        dep_sheet_name.clone(),
                                        *dep_row,
                                        *dep_col,
                                    ));
                                }
                            }
                        }
                    }
                }
            }

            // 2. For non-active sheets, also cascade same-sheet dependents
            // (The active sheet's same-sheet dependents were already handled above)
            if source_sheet_idx != active_sheet && source_sheet_idx < grids.len() {
                // Look up same-sheet dependents in the global dependents map
                // and filter to cells that exist on this sheet
                if let Some(same_sheet_deps) =
                    dependents_map.get(&(source_row, source_col)).cloned()
                {
                    for (ss_dep_row, ss_dep_col) in same_sheet_deps {
                        // Skip if already processed
                        if processed.contains(&(source_sheet_idx, ss_dep_row, ss_dep_col)) {
                            continue;
                        }

                        // Only process if this cell exists on the source sheet (not another sheet)
                        if let Some(dep_cell) =
                            grids[source_sheet_idx].get_cell(ss_dep_row, ss_dep_col)
                        {
                            if let Some(ref formula) = dep_cell.formula {
                                processed.insert((source_sheet_idx, ss_dep_row, ss_dep_col));

                                // Use cached AST if available
                                let result = if let Some(cached_ast) = dep_cell.get_cached_ast() {
                                    evaluate_formula_multi_sheet_with_ast(
                                        &grids,
                                        &sheet_names,
                                        source_sheet_idx,
                                        cached_ast,
                                    )
                                } else {
                                    // Fallback: parse and evaluate
                                    evaluate_formula_multi_sheet(
                                        &grids,
                                        &sheet_names,
                                        source_sheet_idx,
                                        formula,
                                    )
                                };

                                let mut updated_dep = dep_cell.clone();
                                updated_dep.value = result.clone();
                                grids[source_sheet_idx].set_cell(
                                    ss_dep_row,
                                    ss_dep_col,
                                    updated_dep.clone(),
                                );

                                // Format the display value and add to updated_cells
                                let dep_style = styles.get(updated_dep.style_index);
                                let dep_display = format_cell_value(&updated_dep.value, dep_style);

                                updated_cells.push(CellData {
                                    row: ss_dep_row,
                                    col: ss_dep_col,
                                    display: dep_display,
                                    formula: updated_dep.formula.clone(),
                                    style_index: updated_dep.style_index,
                                    row_span: 1,
                                    col_span: 1,
                                    sheet_index: Some(source_sheet_idx),
                                });

                                // Add this updated cell to the work queue so its dependents also get recalculated
                                work_queue.push((
                                    source_sheet_idx,
                                    source_sheet_name.clone(),
                                    ss_dep_row,
                                    ss_dep_col,
                                ));
                            }
                        }
                    }
                }
            }
        }
        let perf_t6_cross_sheet = Instant::now();
        let perf_cross_sheet_count = updated_cells.len().saturating_sub(1 + perf_same_sheet_count);

        log_perf!("CELL",
            "update_cell({},{}) cells={} | locks={:.2}ms parse+deps={:.2}ms store={:.2}ms recalc_order={:.2}ms same_sheet={:.2}ms({}cells, {}hits/{}miss, eval={:.2}ms) cross_sheet={:.2}ms({}cells) TOTAL={:.2}ms",
            row, col, updated_cells.len(),
            perf_t1_locks.duration_since(perf_t0).as_secs_f64() * 1000.0,
            perf_t2_parsed.duration_since(perf_t1_locks).as_secs_f64() * 1000.0,
            perf_t3_stored.duration_since(perf_t2_parsed).as_secs_f64() * 1000.0,
            perf_t4_recalc_order.duration_since(perf_t3_stored).as_secs_f64() * 1000.0,
            perf_t5_same_sheet.duration_since(perf_t4_recalc_order).as_secs_f64() * 1000.0,
            perf_same_sheet_count, perf_cache_hits, perf_cache_misses,
            perf_eval_total.as_secs_f64() * 1000.0,
            perf_t6_cross_sheet.duration_since(perf_t5_same_sheet).as_secs_f64() * 1000.0,
            perf_cross_sheet_count,
            perf_t6_cross_sheet.duration_since(perf_t0).as_secs_f64() * 1000.0
        );
    } else {
        // Manual calc mode - just log basic timing
        let perf_tend = Instant::now();
        log_perf!("CELL",
            "update_cell({},{}) manual_mode | locks={:.2}ms parse+deps={:.2}ms store={:.2}ms TOTAL={:.2}ms",
            row, col,
            perf_t1_locks.duration_since(perf_t0).as_secs_f64() * 1000.0,
            perf_t2_parsed.duration_since(perf_t1_locks).as_secs_f64() * 1000.0,
            perf_t3_stored.duration_since(perf_t2_parsed).as_secs_f64() * 1000.0,
            perf_tend.duration_since(perf_t0).as_secs_f64() * 1000.0
        );
    }

    Ok(updated_cells)
}

/// Batch update multiple cells in a single operation.
/// This is significantly faster than calling update_cell multiple times
/// because it acquires locks once and processes all cells together.
/// Recalculation of dependents happens once at the end, after all cells are updated.
#[tauri::command]
pub fn update_cells_batch(
    state: State<AppState>,
    updates: Vec<crate::api_types::CellUpdateInput>,
) -> Result<Vec<CellData>, String> {
    use std::collections::HashMap;
    use std::time::Instant;
    let perf_t0 = Instant::now();
    let perf_batch_size = updates.len();

    // Early return for empty batch
    if updates.is_empty() {
        return Ok(Vec::new());
    }

    // Acquire all locks once
    let sheet_names = state.sheet_names.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let calc_mode = state.calculation_mode.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    let perf_t1_locks = Instant::now();

    let current_sheet_name = sheet_names.get(active_sheet).cloned().unwrap_or_default();

    let mut updated_cells = Vec::new();
    let mut cells_needing_recalc: Vec<(u32, u32)> = Vec::new();

    // Build merge lookup once for efficiency
    let merge_lookup: HashMap<(u32, u32), &MergedRegion> = merged_regions
        .iter()
        .map(|r| ((r.start_row, r.start_col), r))
        .collect();

    // Process each update
    for update in &updates {
        let row = update.row;
        let col = update.col;
        let value = &update.value;

        // Check if cell is in a protected region
        // Note: We skip the check here since fill operations should not target protected cells
        // and checking 240 cells individually would be slow. The frontend should validate.

        // Record previous state for undo
        let previous_cell = grid.get_cell(row, col).cloned();

        // Handle empty value - clear the cell
        if value.trim().is_empty() {
            grid.clear_cell(row, col);
            if active_sheet < grids.len() {
                grids[active_sheet].clear_cell(row, col);
            }
            // Clear dependencies
            update_cross_sheet_dependencies(
                (active_sheet, row, col),
                HashSet::new(),
                &mut cross_sheet_dependencies_map,
                &mut cross_sheet_dependents_map,
            );
            update_dependencies(
                (row, col),
                HashSet::new(),
                &mut dependencies_map,
                &mut dependents_map,
            );
            update_column_dependencies(
                (row, col),
                HashSet::new(),
                &mut column_dependencies_map,
                &mut column_dependents_map,
            );
            update_row_dependencies(
                (row, col),
                HashSet::new(),
                &mut row_dependencies_map,
                &mut row_dependents_map,
            );

            let (row_span, col_span) = if let Some(region) = merge_lookup.get(&(row, col)) {
                (
                    region.end_row - region.start_row + 1,
                    region.end_col - region.start_col + 1,
                )
            } else {
                (1, 1)
            };

            updated_cells.push(CellData {
                row,
                col,
                display: String::new(),
                formula: None,
                style_index: 0,
                row_span,
                col_span,
                sheet_index: None,
            });

            undo_stack.record_cell_change(row, col, previous_cell);
            cells_needing_recalc.push((row, col));
            continue;
        }

        // Parse the input
        let mut cell = parse_cell_input(value);

        // Preserve existing style
        if let Some(existing) = grid.get_cell(row, col) {
            cell.style_index = existing.style_index;
        }

        // If it's a formula, evaluate it
        if let Some(ref formula) = cell.formula {
            match parser::parse(formula) {
                Ok(parsed) => {
                    let refs = extract_all_references(&parsed, &grid);

                    update_dependencies(
                        (row, col),
                        refs.cells,
                        &mut dependencies_map,
                        &mut dependents_map,
                    );
                    update_column_dependencies(
                        (row, col),
                        refs.columns,
                        &mut column_dependencies_map,
                        &mut column_dependents_map,
                    );
                    update_row_dependencies(
                        (row, col),
                        refs.rows,
                        &mut row_dependencies_map,
                        &mut row_dependents_map,
                    );

                    // Normalize cross-sheet references
                    let normalized_cross_sheet_refs: HashSet<(String, u32, u32)> = refs
                        .cross_sheet_cells
                        .iter()
                        .filter_map(|(parsed_sheet_name, r, c)| {
                            let normalized = sheet_names
                                .iter()
                                .find(|name| name.eq_ignore_ascii_case(parsed_sheet_name))
                                .cloned()
                                .unwrap_or_else(|| parsed_sheet_name.clone());
                            Some((normalized, *r, *c))
                        })
                        .collect();

                    update_cross_sheet_dependencies(
                        (active_sheet, row, col),
                        normalized_cross_sheet_refs,
                        &mut cross_sheet_dependencies_map,
                        &mut cross_sheet_dependents_map,
                    );

                    // PERF: Convert the already-parsed AST directly instead of re-parsing.
                    // This eliminates a redundant parse_formula() call per cell.
                    let engine_ast = crate::convert_expr(&parsed);
                    cell.set_cached_ast(engine_ast.clone());
                    let result = evaluate_formula_multi_sheet_with_ast(
                        &grids,
                        &sheet_names,
                        active_sheet,
                        &engine_ast,
                    );
                    cell.value = result;
                }
                Err(_e) => {
                    let result =
                        evaluate_formula_multi_sheet(&grids, &sheet_names, active_sheet, formula);
                    cell.value = result;
                }
            }
        } else {
            // Clear dependencies for non-formula cells
            update_dependencies(
                (row, col),
                HashSet::new(),
                &mut dependencies_map,
                &mut dependents_map,
            );
            update_cross_sheet_dependencies(
                (active_sheet, row, col),
                HashSet::new(),
                &mut cross_sheet_dependencies_map,
                &mut cross_sheet_dependents_map,
            );
            update_column_dependencies(
                (row, col),
                HashSet::new(),
                &mut column_dependencies_map,
                &mut column_dependents_map,
            );
            update_row_dependencies(
                (row, col),
                HashSet::new(),
                &mut row_dependencies_map,
                &mut row_dependents_map,
            );
        }

        // Store the cell
        grid.set_cell(row, col, cell.clone());
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, cell.clone());
        }

        // Get the display value
        let style = styles.get(cell.style_index);
        let display = format_cell_value(&cell.value, style);

        let (row_span, col_span) = if let Some(region) = merge_lookup.get(&(row, col)) {
            (
                region.end_row - region.start_row + 1,
                region.end_col - region.start_col + 1,
            )
        } else {
            (1, 1)
        };

        updated_cells.push(CellData {
            row,
            col,
            display,
            formula: cell.formula.clone(),
            style_index: cell.style_index,
            row_span,
            col_span,
            sheet_index: None,
        });

        undo_stack.record_cell_change(row, col, previous_cell);
        cells_needing_recalc.push((row, col));
    }

    let perf_t2_processed = Instant::now();

    // Recalculate dependents if automatic mode - do this ONCE after all updates
    if *calc_mode == "automatic" {
        // Collect all dependents from all updated cells
        let mut all_recalc_order: Vec<(u32, u32)> = Vec::new();
        let mut recalc_set: HashSet<(u32, u32)> = HashSet::new();

        // Also track updated cells so we don't re-add them
        let updated_set: HashSet<(u32, u32)> = cells_needing_recalc.iter().copied().collect();

        for (row, col) in &cells_needing_recalc {
            let recalc_order = get_recalculation_order((*row, *col), &dependents_map);
            for dep in recalc_order {
                // Skip cells that were part of the batch update itself
                if !recalc_set.contains(&dep) && !updated_set.contains(&dep) {
                    recalc_set.insert(dep);
                    all_recalc_order.push(dep);
                }
            }

            // Also get column/row dependents
            let col_row_deps =
                get_column_row_dependents((*row, *col), &column_dependents_map, &row_dependents_map);
            for dep in col_row_deps {
                if !recalc_set.contains(&dep) && !updated_set.contains(&dep) {
                    recalc_set.insert(dep);
                    all_recalc_order.push(dep);
                }
            }
        }

        // Recalculate all dependents
        for (dep_row, dep_col) in &all_recalc_order {
            if let Some(dep_cell) = grid.get_cell(*dep_row, *dep_col) {
                if let Some(ref formula) = dep_cell.formula {
                    let result = if let Some(cached_ast) = dep_cell.get_cached_ast() {
                        evaluate_formula_multi_sheet_with_ast(
                            &grids,
                            &sheet_names,
                            active_sheet,
                            cached_ast,
                        )
                    } else {
                        if let Ok(engine_ast) = parse_formula_to_engine_ast(formula) {
                            let result = evaluate_formula_multi_sheet_with_ast(
                                &grids,
                                &sheet_names,
                                active_sheet,
                                &engine_ast,
                            );
                            let mut updated_with_ast = dep_cell.clone();
                            updated_with_ast.set_cached_ast(engine_ast);
                            updated_with_ast.value = result.clone();
                            grid.set_cell(*dep_row, *dep_col, updated_with_ast.clone());
                            if active_sheet < grids.len() {
                                grids[active_sheet].set_cell(*dep_row, *dep_col, updated_with_ast.clone());
                            }

                            let dep_style = styles.get(updated_with_ast.style_index);
                            let dep_display = format_cell_value(&updated_with_ast.value, dep_style);

                            let (dep_row_span, dep_col_span) =
                                if let Some(region) = merge_lookup.get(&(*dep_row, *dep_col)) {
                                    (
                                        region.end_row - region.start_row + 1,
                                        region.end_col - region.start_col + 1,
                                    )
                                } else {
                                    (1, 1)
                                };

                            updated_cells.push(CellData {
                                row: *dep_row,
                                col: *dep_col,
                                display: dep_display,
                                formula: updated_with_ast.formula.clone(),
                                style_index: updated_with_ast.style_index,
                                row_span: dep_row_span,
                                col_span: dep_col_span,
                                sheet_index: None,
                            });
                            continue;
                        }
                        evaluate_formula_multi_sheet(&grids, &sheet_names, active_sheet, formula)
                    };

                    let mut updated_dep = dep_cell.clone();
                    updated_dep.value = result;
                    grid.set_cell(*dep_row, *dep_col, updated_dep.clone());

                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(*dep_row, *dep_col, updated_dep.clone());
                    }

                    let dep_style = styles.get(updated_dep.style_index);
                    let dep_display = format_cell_value(&updated_dep.value, dep_style);

                    let (dep_row_span, dep_col_span) =
                        if let Some(region) = merge_lookup.get(&(*dep_row, *dep_col)) {
                            (
                                region.end_row - region.start_row + 1,
                                region.end_col - region.start_col + 1,
                            )
                        } else {
                            (1, 1)
                        };

                    updated_cells.push(CellData {
                        row: *dep_row,
                        col: *dep_col,
                        display: dep_display,
                        formula: updated_dep.formula.clone(),
                        style_index: updated_dep.style_index,
                        row_span: dep_row_span,
                        col_span: dep_col_span,
                        sheet_index: None,
                    });
                }
            }
        }

        // Handle cross-sheet dependents
        let mut work_queue: Vec<(usize, String, u32, u32)> = cells_needing_recalc
            .iter()
            .map(|(r, c)| (active_sheet, current_sheet_name.clone(), *r, *c))
            .collect();
        let mut processed: HashSet<(usize, u32, u32)> = HashSet::new();

        // Mark updated cells and their dependents as processed
        for (row, col) in &cells_needing_recalc {
            processed.insert((active_sheet, *row, *col));
        }
        for (dep_row, dep_col) in &all_recalc_order {
            processed.insert((active_sheet, *dep_row, *dep_col));
        }

        while let Some((source_sheet_idx, source_sheet_name, source_row, source_col)) =
            work_queue.pop()
        {
            let cross_sheet_key = (source_sheet_name.clone(), source_row, source_col);

            if let Some(cross_deps) = cross_sheet_dependents_map.get(&cross_sheet_key).cloned() {
                for (dep_sheet_idx, dep_row, dep_col) in cross_deps.iter() {
                    if processed.contains(&(*dep_sheet_idx, *dep_row, *dep_col)) {
                        continue;
                    }
                    processed.insert((*dep_sheet_idx, *dep_row, *dep_col));

                    if *dep_sheet_idx < grids.len() {
                        if let Some(dep_cell) = grids[*dep_sheet_idx].get_cell(*dep_row, *dep_col) {
                            if let Some(ref formula) = dep_cell.formula {
                                let result = if let Some(cached_ast) = dep_cell.get_cached_ast() {
                                    evaluate_formula_multi_sheet_with_ast(
                                        &grids,
                                        &sheet_names,
                                        *dep_sheet_idx,
                                        cached_ast,
                                    )
                                } else {
                                    evaluate_formula_multi_sheet(
                                        &grids,
                                        &sheet_names,
                                        *dep_sheet_idx,
                                        formula,
                                    )
                                };

                                let mut updated_dep = dep_cell.clone();
                                updated_dep.value = result.clone();
                                grids[*dep_sheet_idx].set_cell(
                                    *dep_row,
                                    *dep_col,
                                    updated_dep.clone(),
                                );

                                let dep_style = styles.get(updated_dep.style_index);
                                let dep_display = format_cell_value(&updated_dep.value, dep_style);

                                updated_cells.push(CellData {
                                    row: *dep_row,
                                    col: *dep_col,
                                    display: dep_display,
                                    formula: updated_dep.formula.clone(),
                                    style_index: updated_dep.style_index,
                                    row_span: 1,
                                    col_span: 1,
                                    sheet_index: Some(*dep_sheet_idx),
                                });

                                if let Some(dep_sheet_name) = sheet_names.get(*dep_sheet_idx) {
                                    work_queue.push((
                                        *dep_sheet_idx,
                                        dep_sheet_name.clone(),
                                        *dep_row,
                                        *dep_col,
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }

        let perf_tend = Instant::now();
        log_perf!("BATCH",
            "update_cells_batch(N={}) cells={} | locks={:.2}ms process={:.2}ms recalc+cross={:.2}ms TOTAL={:.2}ms",
            perf_batch_size, updated_cells.len(),
            perf_t1_locks.duration_since(perf_t0).as_secs_f64() * 1000.0,
            perf_t2_processed.duration_since(perf_t1_locks).as_secs_f64() * 1000.0,
            perf_tend.duration_since(perf_t2_processed).as_secs_f64() * 1000.0,
            perf_tend.duration_since(perf_t0).as_secs_f64() * 1000.0
        );
    } else {
        let perf_tend = Instant::now();
        log_perf!("BATCH",
            "update_cells_batch(N={}) manual_mode | locks={:.2}ms process={:.2}ms TOTAL={:.2}ms",
            perf_batch_size,
            perf_t1_locks.duration_since(perf_t0).as_secs_f64() * 1000.0,
            perf_t2_processed.duration_since(perf_t1_locks).as_secs_f64() * 1000.0,
            perf_tend.duration_since(perf_t0).as_secs_f64() * 1000.0
        );
    }

    Ok(updated_cells)
}

/// Clear a cell.
#[tauri::command]
pub fn clear_cell(state: State<AppState>, row: u32, col: u32) {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Record previous state for undo
    let previous_cell = grid.get_cell(row, col).cloned();

    grid.clear_cell(row, col);
    // Also update the grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].clear_cell(row, col);
    }

    // Clear cross-sheet dependencies
    update_cross_sheet_dependencies(
        (active_sheet, row, col),
        HashSet::new(),
        &mut cross_sheet_dependencies_map,
        &mut cross_sheet_dependents_map,
    );

    update_dependencies(
        (row, col),
        HashSet::new(),
        &mut dependencies_map,
        &mut dependents_map,
    );
    update_column_dependencies(
        (row, col),
        HashSet::new(),
        &mut column_dependencies_map,
        &mut column_dependents_map,
    );
    update_row_dependencies(
        (row, col),
        HashSet::new(),
        &mut row_dependencies_map,
        &mut row_dependents_map,
    );

    // Record undo if there was actually a cell to clear
    if previous_cell.is_some() {
        undo_stack.record_cell_change(row, col, previous_cell);
    }
}

/// Clear a range of cells efficiently.
/// Only clears cells that actually exist within the range.
#[tauri::command]
pub fn clear_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> u32 {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Clamp to grid bounds to avoid iterating beyond used range
    let effective_end_row = end_row.min(grid.max_row);
    let effective_end_col = end_col.min(grid.max_col);

    // Collect cells to clear (we need to collect first to avoid borrow issues)
    let cells_to_clear: Vec<(u32, u32)> = grid
        .cells
        .keys()
        .filter(|(r, c)| {
            *r >= start_row && *r <= effective_end_row && *c >= start_col && *c <= effective_end_col
        })
        .cloned()
        .collect();

    let count = cells_to_clear.len() as u32;

    // Begin undo transaction for batch operation
    if count > 0 {
        undo_stack.begin_transaction(format!(
            "Clear range ({},{}) to ({},{})",
            start_row, start_col, end_row, end_col
        ));
    }

    // Clear each cell
    for (row, col) in cells_to_clear {
        // Record previous state for undo
        let previous_cell = grid.get_cell(row, col).cloned();
        if previous_cell.is_some() {
            undo_stack.record_cell_change(row, col, previous_cell);
        }

        grid.clear_cell(row, col);

        if active_sheet < grids.len() {
            grids[active_sheet].clear_cell(row, col);
        }

        // Clear dependencies
        update_cross_sheet_dependencies(
            (active_sheet, row, col),
            HashSet::new(),
            &mut cross_sheet_dependencies_map,
            &mut cross_sheet_dependents_map,
        );
        update_dependencies(
            (row, col),
            HashSet::new(),
            &mut dependencies_map,
            &mut dependents_map,
        );
        update_column_dependencies(
            (row, col),
            HashSet::new(),
            &mut column_dependencies_map,
            &mut column_dependents_map,
        );
        update_row_dependencies(
            (row, col),
            HashSet::new(),
            &mut row_dependencies_map,
            &mut row_dependents_map,
        );
    }

    // Commit undo transaction
    if count > 0 {
        undo_stack.commit_transaction();
    }

    count
}

/// Clear a range of cells with options for what to clear.
/// Supports Excel-compatible ClearApplyTo options:
/// - All: Clear both content and formatting (default)
/// - Contents: Clear values only, keep formatting
/// - Formats: Clear formatting only, keep values
/// - Hyperlinks: Clear hyperlinks only (placeholder)
/// - RemoveHyperlinks: Remove hyperlinks and formatting, keep content
/// - ResetContents: Reset to default state
#[tauri::command]
pub fn clear_range_with_options(
    state: State<AppState>,
    params: ClearRangeParams,
) -> ClearRangeResult {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut style_registry = state.style_registry.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    let ClearRangeParams {
        start_row,
        start_col,
        end_row,
        end_col,
        apply_to,
    } = params;

    // Normalize coordinates
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // Clamp to grid bounds
    let effective_end_row = max_row.min(grid.max_row);
    let effective_end_col = max_col.min(grid.max_col);

    // Collect cells in the range (both existing and potential)
    let mut cells_in_range: Vec<(u32, u32)> = grid
        .cells
        .keys()
        .filter(|(r, c)| {
            *r >= min_row && *r <= effective_end_row && *c >= min_col && *c <= effective_end_col
        })
        .cloned()
        .collect();

    // For "Formats" mode, we need to process all cells in the range, not just existing ones
    if matches!(apply_to, ClearApplyTo::Formats) {
        for r in min_row..=effective_end_row {
            for c in min_col..=effective_end_col {
                if !cells_in_range.contains(&(r, c)) {
                    cells_in_range.push((r, c));
                }
            }
        }
    }

    let count = cells_in_range.len() as u32;
    let mut updated_cells = Vec::new();

    if count > 0 {
        let desc = match apply_to {
            ClearApplyTo::All => "Clear all",
            ClearApplyTo::Contents => "Clear contents",
            ClearApplyTo::Formats => "Clear formats",
            ClearApplyTo::Hyperlinks => "Clear hyperlinks",
            ClearApplyTo::RemoveHyperlinks => "Remove hyperlinks",
            ClearApplyTo::ResetContents => "Reset contents",
        };
        undo_stack.begin_transaction(format!(
            "{} ({},{}) to ({},{})",
            desc, min_row, min_col, max_row, max_col
        ));
    }

    for (row, col) in cells_in_range {
        // Record previous state for undo
        let previous_cell = grid.get_cell(row, col).cloned();

        match apply_to {
            ClearApplyTo::All | ClearApplyTo::ResetContents => {
                // Clear everything - same as existing clear_range
                if previous_cell.is_some() {
                    undo_stack.record_cell_change(row, col, previous_cell);
                }
                grid.clear_cell(row, col);
                if active_sheet < grids.len() {
                    grids[active_sheet].clear_cell(row, col);
                }

                // Clear dependencies
                update_cross_sheet_dependencies(
                    (active_sheet, row, col),
                    HashSet::new(),
                    &mut cross_sheet_dependencies_map,
                    &mut cross_sheet_dependents_map,
                );
                update_dependencies(
                    (row, col),
                    HashSet::new(),
                    &mut dependencies_map,
                    &mut dependents_map,
                );
                update_column_dependencies(
                    (row, col),
                    HashSet::new(),
                    &mut column_dependencies_map,
                    &mut column_dependents_map,
                );
                update_row_dependencies(
                    (row, col),
                    HashSet::new(),
                    &mut row_dependencies_map,
                    &mut row_dependents_map,
                );

                // Get merge span info
                let merge_info = merged_regions
                    .iter()
                    .find(|r| r.start_row == row && r.start_col == col);
                let (row_span, col_span) = if let Some(region) = merge_info {
                    (
                        region.end_row - region.start_row + 1,
                        region.end_col - region.start_col + 1,
                    )
                } else {
                    (1, 1)
                };

                updated_cells.push(CellData {
                    row,
                    col,
                    display: String::new(),
                    formula: None,
                    style_index: 0,
                    row_span,
                    col_span,
                    sheet_index: None,
                });
            }
            ClearApplyTo::Contents => {
                // Clear values and formulas, keep formatting
                if let Some(ref cell) = previous_cell {
                    undo_stack.record_cell_change(row, col, previous_cell.clone());

                    let style_index = cell.style_index;
                    let mut new_cell = engine::Cell::new();
                    new_cell.style_index = style_index;

                    grid.set_cell(row, col, new_cell.clone());
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(row, col, new_cell);
                    }

                    // Clear dependencies since formula is gone
                    update_cross_sheet_dependencies(
                        (active_sheet, row, col),
                        HashSet::new(),
                        &mut cross_sheet_dependencies_map,
                        &mut cross_sheet_dependents_map,
                    );
                    update_dependencies(
                        (row, col),
                        HashSet::new(),
                        &mut dependencies_map,
                        &mut dependents_map,
                    );
                    update_column_dependencies(
                        (row, col),
                        HashSet::new(),
                        &mut column_dependencies_map,
                        &mut column_dependents_map,
                    );
                    update_row_dependencies(
                        (row, col),
                        HashSet::new(),
                        &mut row_dependencies_map,
                        &mut row_dependents_map,
                    );

                    // Get merge span info
                    let merge_info = merged_regions
                        .iter()
                        .find(|r| r.start_row == row && r.start_col == col);
                    let (row_span, col_span) = if let Some(region) = merge_info {
                        (
                            region.end_row - region.start_row + 1,
                            region.end_col - region.start_col + 1,
                        )
                    } else {
                        (1, 1)
                    };

                    updated_cells.push(CellData {
                        row,
                        col,
                        display: String::new(),
                        formula: None,
                        style_index,
                        row_span,
                        col_span,
                        sheet_index: None,
                    });
                }
            }
            ClearApplyTo::Formats => {
                // Clear formatting, keep values
                if let Some(ref cell) = previous_cell {
                    undo_stack.record_cell_change(row, col, previous_cell.clone());

                    let mut new_cell = cell.clone();
                    new_cell.style_index = 0; // Reset to default style

                    grid.set_cell(row, col, new_cell.clone());
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(row, col, new_cell);
                    }

                    let default_style = style_registry.get(0);
                    let display = format_cell_value(&cell.value, default_style);

                    // Get merge span info
                    let merge_info = merged_regions
                        .iter()
                        .find(|r| r.start_row == row && r.start_col == col);
                    let (row_span, col_span) = if let Some(region) = merge_info {
                        (
                            region.end_row - region.start_row + 1,
                            region.end_col - region.start_col + 1,
                        )
                    } else {
                        (1, 1)
                    };

                    updated_cells.push(CellData {
                        row,
                        col,
                        display,
                        formula: cell.formula.clone(),
                        style_index: 0,
                        row_span,
                        col_span,
                        sheet_index: None,
                    });
                }
            }
            ClearApplyTo::Hyperlinks | ClearApplyTo::RemoveHyperlinks => {
                // Placeholder - hyperlinks not yet implemented
                // For now, treat RemoveHyperlinks as clear formats
                if let Some(ref cell) = previous_cell {
                    if apply_to == ClearApplyTo::RemoveHyperlinks {
                        undo_stack.record_cell_change(row, col, previous_cell.clone());

                        let mut new_cell = cell.clone();
                        new_cell.style_index = 0; // Reset formatting

                        grid.set_cell(row, col, new_cell.clone());
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_cell(row, col, new_cell);
                        }

                        let default_style = style_registry.get(0);
                        let display = format_cell_value(&cell.value, default_style);

                        // Get merge span info
                        let merge_info = merged_regions
                            .iter()
                            .find(|r| r.start_row == row && r.start_col == col);
                        let (row_span, col_span) = if let Some(region) = merge_info {
                            (
                                region.end_row - region.start_row + 1,
                                region.end_col - region.start_col + 1,
                            )
                        } else {
                            (1, 1)
                        };

                        updated_cells.push(CellData {
                            row,
                            col,
                            display,
                            formula: cell.formula.clone(),
                            style_index: 0,
                            row_span,
                            col_span,
                            sheet_index: None,
                        });
                    }
                }
            }
        }
    }

    if count > 0 {
        undo_stack.commit_transaction();
    }

    ClearRangeResult {
        count,
        updated_cells,
    }
}

/// Sort a range of cells by one or more criteria.
/// Supports Excel-compatible sorting options:
/// - Multiple sort fields (primary, secondary, etc.)
/// - Ascending/descending order
/// - Case sensitivity
/// - Header row handling
/// - Row or column orientation
#[tauri::command]
pub fn sort_range(state: State<AppState>, params: SortRangeParams) -> SortRangeResult {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    let SortRangeParams {
        start_row,
        start_col,
        end_row,
        end_col,
        fields,
        match_case,
        has_headers,
        orientation,
    } = params;

    // Validate sort fields
    if fields.is_empty() {
        return SortRangeResult {
            success: false,
            sorted_count: 0,
            updated_cells: vec![],
            error: Some("At least one sort field is required".to_string()),
        };
    }

    // Normalize coordinates
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // Check for merged cells in the sort range - sorting with merged cells is complex
    for region in merged_regions.iter() {
        if region.start_row <= max_row
            && region.end_row >= min_row
            && region.start_col <= max_col
            && region.end_col >= min_col
        {
            // Check if merge is completely within or completely outside
            let fully_inside = region.start_row >= min_row
                && region.end_row <= max_row
                && region.start_col >= min_col
                && region.end_col <= max_col;
            if !fully_inside {
                return SortRangeResult {
                    success: false,
                    sorted_count: 0,
                    updated_cells: vec![],
                    error: Some(
                        "Cannot sort a range that partially overlaps with merged cells".to_string(),
                    ),
                };
            }
        }
    }

    match orientation {
        SortOrientation::Rows => {
            // Sort by rows (typical case - sort data vertically)
            let data_start_row = if has_headers { min_row + 1 } else { min_row };

            if data_start_row > max_row {
                return SortRangeResult {
                    success: true,
                    sorted_count: 0,
                    updated_cells: vec![],
                    error: None,
                };
            }

            // Collect all rows as vectors of cell data
            let mut rows: Vec<(u32, Vec<Option<engine::Cell>>)> = Vec::new();
            for row in data_start_row..=max_row {
                let mut row_data: Vec<Option<engine::Cell>> = Vec::new();
                for col in min_col..=max_col {
                    row_data.push(grid.get_cell(row, col).cloned());
                }
                rows.push((row, row_data));
            }

            // Sort the rows using the sort fields
            rows.sort_by(|a, b| {
                compare_rows_by_fields(&a.1, &b.1, &fields, min_col, match_case, &styles)
            });

            // Begin undo transaction
            undo_stack.begin_transaction(format!(
                "Sort range ({},{}) to ({},{})",
                min_row, min_col, max_row, max_col
            ));

            // Apply the sorted order back to the grid
            let mut updated_cells = Vec::new();
            let sorted_count = rows.len() as u32;

            for (new_row_idx, (original_row, row_data)) in rows.iter().enumerate() {
                let target_row = data_start_row + new_row_idx as u32;

                for (col_offset, cell_opt) in row_data.iter().enumerate() {
                    let target_col = min_col + col_offset as u32;

                    // Record undo for the target cell
                    let prev_cell = grid.get_cell(target_row, target_col).cloned();
                    undo_stack.record_cell_change(target_row, target_col, prev_cell);

                    if let Some(cell) = cell_opt {
                        grid.set_cell(target_row, target_col, cell.clone());
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_cell(target_row, target_col, cell.clone());
                        }

                        let style = styles.get(cell.style_index);
                        let display = format_cell_value(&cell.value, style);

                        updated_cells.push(CellData {
                            row: target_row,
                            col: target_col,
                            display,
                            formula: cell.formula.clone(),
                            style_index: cell.style_index,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                        });
                    } else {
                        grid.clear_cell(target_row, target_col);
                        if active_sheet < grids.len() {
                            grids[active_sheet].clear_cell(target_row, target_col);
                        }

                        updated_cells.push(CellData {
                            row: target_row,
                            col: target_col,
                            display: String::new(),
                            formula: None,
                            style_index: 0,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                        });
                    }
                }
            }

            undo_stack.commit_transaction();

            SortRangeResult {
                success: true,
                sorted_count,
                updated_cells,
                error: None,
            }
        }
        SortOrientation::Columns => {
            // Sort by columns (sort data horizontally)
            let data_start_col = if has_headers { min_col + 1 } else { min_col };

            if data_start_col > max_col {
                return SortRangeResult {
                    success: true,
                    sorted_count: 0,
                    updated_cells: vec![],
                    error: None,
                };
            }

            // Collect all columns as vectors of cell data
            let mut cols: Vec<(u32, Vec<Option<engine::Cell>>)> = Vec::new();
            for col in data_start_col..=max_col {
                let mut col_data: Vec<Option<engine::Cell>> = Vec::new();
                for row in min_row..=max_row {
                    col_data.push(grid.get_cell(row, col).cloned());
                }
                cols.push((col, col_data));
            }

            // Sort the columns using the sort fields (treating rows as keys)
            cols.sort_by(|a, b| {
                compare_cols_by_fields(&a.1, &b.1, &fields, min_row, match_case, &styles)
            });

            // Begin undo transaction
            undo_stack.begin_transaction(format!(
                "Sort columns ({},{}) to ({},{})",
                min_row, min_col, max_row, max_col
            ));

            // Apply the sorted order back to the grid
            let mut updated_cells = Vec::new();
            let sorted_count = cols.len() as u32;

            for (new_col_idx, (original_col, col_data)) in cols.iter().enumerate() {
                let target_col = data_start_col + new_col_idx as u32;

                for (row_offset, cell_opt) in col_data.iter().enumerate() {
                    let target_row = min_row + row_offset as u32;

                    // Record undo for the target cell
                    let prev_cell = grid.get_cell(target_row, target_col).cloned();
                    undo_stack.record_cell_change(target_row, target_col, prev_cell);

                    if let Some(cell) = cell_opt {
                        grid.set_cell(target_row, target_col, cell.clone());
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_cell(target_row, target_col, cell.clone());
                        }

                        let style = styles.get(cell.style_index);
                        let display = format_cell_value(&cell.value, style);

                        updated_cells.push(CellData {
                            row: target_row,
                            col: target_col,
                            display,
                            formula: cell.formula.clone(),
                            style_index: cell.style_index,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                        });
                    } else {
                        grid.clear_cell(target_row, target_col);
                        if active_sheet < grids.len() {
                            grids[active_sheet].clear_cell(target_row, target_col);
                        }

                        updated_cells.push(CellData {
                            row: target_row,
                            col: target_col,
                            display: String::new(),
                            formula: None,
                            style_index: 0,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                        });
                    }
                }
            }

            undo_stack.commit_transaction();

            SortRangeResult {
                success: true,
                sorted_count,
                updated_cells,
                error: None,
            }
        }
    }
}

/// Compare two rows by the given sort fields.
fn compare_rows_by_fields(
    row_a: &[Option<engine::Cell>],
    row_b: &[Option<engine::Cell>],
    fields: &[SortField],
    _min_col: u32,
    match_case: bool,
    styles: &StyleRegistry,
) -> std::cmp::Ordering {
    for field in fields {
        let col_idx = field.key as usize;
        if col_idx >= row_a.len() || col_idx >= row_b.len() {
            continue;
        }

        let cell_a = &row_a[col_idx];
        let cell_b = &row_b[col_idx];

        let ordering = compare_cells(cell_a, cell_b, field, match_case, styles);

        if ordering != std::cmp::Ordering::Equal {
            return if field.ascending {
                ordering
            } else {
                ordering.reverse()
            };
        }
    }
    std::cmp::Ordering::Equal
}

/// Compare two columns by the given sort fields.
fn compare_cols_by_fields(
    col_a: &[Option<engine::Cell>],
    col_b: &[Option<engine::Cell>],
    fields: &[SortField],
    _min_row: u32,
    match_case: bool,
    styles: &StyleRegistry,
) -> std::cmp::Ordering {
    for field in fields {
        let row_idx = field.key as usize;
        if row_idx >= col_a.len() || row_idx >= col_b.len() {
            continue;
        }

        let cell_a = &col_a[row_idx];
        let cell_b = &col_b[row_idx];

        let ordering = compare_cells(cell_a, cell_b, field, match_case, styles);

        if ordering != std::cmp::Ordering::Equal {
            return if field.ascending {
                ordering
            } else {
                ordering.reverse()
            };
        }
    }
    std::cmp::Ordering::Equal
}

/// Compare two cells based on sort field settings.
fn compare_cells(
    cell_a: &Option<engine::Cell>,
    cell_b: &Option<engine::Cell>,
    field: &SortField,
    match_case: bool,
    styles: &StyleRegistry,
) -> std::cmp::Ordering {
    use engine::CellValue;

    match field.sort_on {
        SortOn::Value => {
            // Compare by cell value
            let val_a = cell_a.as_ref().map(|c| &c.value);
            let val_b = cell_b.as_ref().map(|c| &c.value);

            match (val_a, val_b) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater, // Empty cells sort last
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(a), Some(b)) => compare_cell_values(a, b, match_case, field.data_option),
            }
        }
        SortOn::CellColor => {
            // Compare by background color
            let color_a = cell_a.as_ref().map(|c| {
                let style = styles.get(c.style_index);
                style.background.to_css()
            });
            let color_b = cell_b.as_ref().map(|c| {
                let style = styles.get(c.style_index);
                style.background.to_css()
            });

            match (color_a, color_b, &field.color) {
                (Some(a), Some(b), Some(target)) => {
                    // Sort by whether the color matches the target
                    let a_matches = a.eq_ignore_ascii_case(target);
                    let b_matches = b.eq_ignore_ascii_case(target);
                    match (a_matches, b_matches) {
                        (true, false) => std::cmp::Ordering::Less,
                        (false, true) => std::cmp::Ordering::Greater,
                        _ => a.cmp(&b),
                    }
                }
                (Some(a), Some(b), None) => a.cmp(&b),
                (None, Some(_), _) => std::cmp::Ordering::Greater,
                (Some(_), None, _) => std::cmp::Ordering::Less,
                (None, None, _) => std::cmp::Ordering::Equal,
            }
        }
        SortOn::FontColor => {
            // Compare by font color
            let color_a = cell_a.as_ref().map(|c| {
                let style = styles.get(c.style_index);
                style.font.color.to_css()
            });
            let color_b = cell_b.as_ref().map(|c| {
                let style = styles.get(c.style_index);
                style.font.color.to_css()
            });

            match (color_a, color_b, &field.color) {
                (Some(a), Some(b), Some(target)) => {
                    let a_matches = a.eq_ignore_ascii_case(target);
                    let b_matches = b.eq_ignore_ascii_case(target);
                    match (a_matches, b_matches) {
                        (true, false) => std::cmp::Ordering::Less,
                        (false, true) => std::cmp::Ordering::Greater,
                        _ => a.cmp(&b),
                    }
                }
                (Some(a), Some(b), None) => a.cmp(&b),
                (None, Some(_), _) => std::cmp::Ordering::Greater,
                (Some(_), None, _) => std::cmp::Ordering::Less,
                (None, None, _) => std::cmp::Ordering::Equal,
            }
        }
        SortOn::Icon => {
            // Icon sorting not yet implemented - fall back to value comparison
            let val_a = cell_a.as_ref().map(|c| &c.value);
            let val_b = cell_b.as_ref().map(|c| &c.value);

            match (val_a, val_b) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(a), Some(b)) => compare_cell_values(a, b, match_case, field.data_option),
            }
        }
    }
}

/// Compare two cell values with support for different data types and options.
fn compare_cell_values(
    a: &engine::CellValue,
    b: &engine::CellValue,
    match_case: bool,
    data_option: SortDataOption,
) -> std::cmp::Ordering {
    use engine::CellValue;

    // Type ordering: Numbers < Text < Booleans < Errors < Empty
    fn type_order(v: &CellValue) -> u8 {
        match v {
            CellValue::Number(_) => 0,
            CellValue::Text(_) => 1,
            CellValue::Boolean(_) => 2,
            CellValue::Error(_) => 3,
            CellValue::Empty => 4,
        }
    }

    match (a, b) {
        (CellValue::Number(n1), CellValue::Number(n2)) => {
            n1.partial_cmp(n2).unwrap_or(std::cmp::Ordering::Equal)
        }
        (CellValue::Text(s1), CellValue::Text(s2)) => {
            // Check if we should treat text as numbers
            if data_option == SortDataOption::TextAsNumber {
                if let (Ok(n1), Ok(n2)) = (s1.parse::<f64>(), s2.parse::<f64>()) {
                    return n1.partial_cmp(&n2).unwrap_or(std::cmp::Ordering::Equal);
                }
            }

            if match_case {
                s1.cmp(s2)
            } else {
                s1.to_lowercase().cmp(&s2.to_lowercase())
            }
        }
        (CellValue::Text(s), CellValue::Number(n)) => {
            // Text with TextAsNumber option
            if data_option == SortDataOption::TextAsNumber {
                if let Ok(sn) = s.parse::<f64>() {
                    return sn.partial_cmp(n).unwrap_or(std::cmp::Ordering::Equal);
                }
            }
            // Default: number comes before text
            std::cmp::Ordering::Greater
        }
        (CellValue::Number(n), CellValue::Text(s)) => {
            if data_option == SortDataOption::TextAsNumber {
                if let Ok(sn) = s.parse::<f64>() {
                    return n.partial_cmp(&sn).unwrap_or(std::cmp::Ordering::Equal);
                }
            }
            std::cmp::Ordering::Less
        }
        (CellValue::Boolean(b1), CellValue::Boolean(b2)) => {
            // FALSE < TRUE
            b1.cmp(b2)
        }
        (CellValue::Error(e1), CellValue::Error(e2)) => {
            // Errors sort by their debug representation
            format!("{:?}", e1).cmp(&format!("{:?}", e2))
        }
        (CellValue::Empty, CellValue::Empty) => std::cmp::Ordering::Equal,
        _ => {
            // Different types - use type ordering
            type_order(a).cmp(&type_order(b))
        }
    }
}

/// Get the grid bounds (max row and col with data).
#[tauri::command]
pub fn get_grid_bounds(state: State<AppState>) -> (u32, u32) {
    let grid = state.grid.lock().unwrap();
    (grid.max_row, grid.max_col)
}

/// Get the total number of non-empty cells.
#[tauri::command]
pub fn get_cell_count(state: State<AppState>) -> usize {
    let grid = state.grid.lock().unwrap();
    grid.cells.len()
}
