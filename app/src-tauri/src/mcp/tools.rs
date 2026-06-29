//! FILENAME: app/src-tauri/src/mcp/tools.rs
//! Tool helper functions that operate on AppState via the Tauri AppHandle.
//! Each function reads/writes the spreadsheet state and returns a text result.

use tauri::{AppHandle, Emitter, Manager};
use crate::AppState;
use crate::api_types::ChartEntry;
use crate::NamedRange;
use crate::tables::Table;
use crate::pivot::types::PivotTableInfo;
use crate::format_cell_value;
use calcula_format::ai::{AiSerializeOptions, serialize_for_ai, SheetInput};
use super::server::ApplyFormattingParams;

// ============================================================================
// Helpers
// ============================================================================

fn col_letter(col: u32) -> String {
    let mut result = String::new();
    let mut c = col as i64;
    loop {
        result.insert(0, (b'A' + (c % 26) as u8) as char);
        c = c / 26 - 1;
        if c < 0 {
            break;
        }
    }
    result
}

// ============================================================================
// Tool Implementations
// ============================================================================

/// Read cells from a rectangular range and return as a formatted table.
pub fn read_cell_range(
    handle: &AppHandle,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<String, String> {
    let state = handle.state::<AppState>();
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    let mut table = String::new();
    let mut formulas: Vec<String> = Vec::new();

    for row in start_row..=end_row {
        let mut vals: Vec<String> = Vec::new();
        for col in start_col..=end_col {
            if let Some(cell) = grid.get_cell(row, col) {
                let style = styles.get(cell.style_index);
                let display = format_cell_value(&cell.value, style, &locale);
                vals.push(display);
                if let Some(f) = cell.formula_string() {
                    formulas.push(format!("{}{}:{}", col_letter(col), row + 1, f));
                }
            } else {
                vals.push(String::new());
            }
        }
        table.push_str(&format!("| {} |\n", vals.join(" | ")));
    }

    if !formulas.is_empty() {
        table.push_str("\nFormulas:\n");
        for f in &formulas {
            table.push_str(&format!("  {}\n", f));
        }
    }

    if table.is_empty() {
        Ok("(empty range)".to_string())
    } else {
        Ok(table)
    }
}

/// Write a single cell value (or formula).
pub fn write_cell(
    handle: &AppHandle,
    row: u32,
    col: u32,
    value: &str,
) -> Result<String, String> {
    // Delegate to the script engine for simplicity - it handles parsing,
    // formula evaluation, and dependency recalculation correctly.
    //
    // ALWAYS pass the value as a STRING literal built with serde_json so it is
    // valid JS even when it contains newlines / quotes / backslashes / unicode
    // line separators (hand-escaping only \\ and \" would leave a literal newline
    // as an unterminated JS string and fail the write). Calcula.setCellValue
    // expects a string argument (an unquoted number throws "Error converting from
    // js 'int' into type 'string'"), and the cell-input pipeline parses a numeric
    // string like "42" back into a number — so formulas, numbers, and text all
    // flow through the same quoted form.
    let value_literal = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    let script = format!("Calcula.setCellValue({}, {}, {});", row, col, value_literal);

    execute_script(handle, &script)?;
    Ok(format!("Set {}{} = {}", col_letter(col), row + 1, value))
}

/// Write multiple cells at once.
pub fn write_cell_range(
    handle: &AppHandle,
    cells: &[super::server::CellInput],
) -> Result<String, String> {
    // Always build each value as a serde_json string literal (see write_cell:
    // valid JS even with newlines/quotes; an unquoted number throws; the
    // cell-input pipeline parses a numeric string back into a number).
    let mut script = String::new();
    for cell in cells {
        let value_literal = serde_json::to_string(&cell.value).unwrap_or_else(|_| "\"\"".to_string());
        script.push_str(&format!(
            "Calcula.setCellValue({}, {}, {});\n",
            cell.row, cell.col, value_literal
        ));
    }

    execute_script(handle, &script)?;
    Ok(format!("Set {} cell(s)", cells.len()))
}

/// Get an AI-optimized workbook summary.
pub fn get_sheet_summary(
    handle: &AppHandle,
    max_chars: u32,
) -> Result<String, String> {
    let state = handle.state::<AppState>();
    let grids = state.grids.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let active_grid = state.grid.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;

    let options = AiSerializeOptions {
        max_chars: max_chars as usize,
        include_styles: false,
        focus_sheet: None,
        max_sample_rows: 5,
        selection_context: None,
        tables_json: None,
    };

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

    let mut summary = serialize_for_ai(&sheet_inputs, &options);
    // Release the sheet-data locks before touching the (unrelated) charts lock.
    drop(sheet_inputs);
    drop(active_grid);
    drop(grids);
    drop(styles);
    drop(sheet_names);

    // Fold in a chart inventory so the AI knows what charts exist (mirrors how
    // list_charts renders them). Appended at the MCP host layer — the pure
    // calcula-format crate stays chart-blind. Guard the char budget: the crate's
    // budget stops at its boundary, so a host append must not blow past max_chars.
    let charts = state.charts.lock().map_err(|e| e.to_string())?;
    if !charts.is_empty() {
        let section = format!("\n\n## Charts\n{}", format_chart_inventory(&charts));
        let limit = max_chars as usize;
        if limit == 0 || summary.len() + section.len() <= limit {
            summary.push_str(&section);
        }
    }
    drop(charts);

    // Fold in a named-range inventory (C1b) — workbook-global names like
    // "TaxRate = 0.25" the AI would otherwise have to guess. Same host-layer
    // pattern + char-budget guard as charts; the pure calcula-format crate stays
    // subsystem-blind.
    let named = state.named_ranges.lock().map_err(|e| e.to_string())?;
    if !named.is_empty() {
        let list: Vec<NamedRange> = named.values().cloned().collect();
        let section = format!("\n\n## Named Ranges\n{}", format_named_range_inventory(&list));
        let limit = max_chars as usize;
        if limit == 0 || summary.len() + section.len() <= limit {
            summary.push_str(&section);
        }
    }
    drop(named);

    // Tables (C1): another AppState subsystem the AI should see in context.
    let tables_guard = state.tables.lock().map_err(|e| e.to_string())?;
    let all_tables: Vec<&Table> = tables_guard.values().flat_map(|m| m.values()).collect();
    if !all_tables.is_empty() {
        let section = format!("\n\n## Tables\n{}", format_table_inventory(&all_tables));
        let limit = max_chars as usize;
        if limit == 0 || summary.len() + section.len() <= limit {
            summary.push_str(&section);
        }
    }
    drop(tables_guard);

    // Pivots (C1) live on the SEPARATE PivotState — read AFTER dropping the
    // AppState subsystem locks above (get_all_pivot_tables locks only its own
    // pivot_tables mutex, so no cross-lock is held). Same char-budget guard.
    let pivots = crate::pivot::commands::get_all_pivot_tables(
        state.clone(),
        handle.state::<crate::pivot::PivotState>(),
    );
    if !pivots.is_empty() {
        let section = format!("\n\n## Pivots\n{}", format_pivot_inventory(&pivots));
        let limit = max_chars as usize;
        if limit == 0 || summary.len() + section.len() <= limit {
            summary.push_str(&section);
        }
    }

    Ok(summary)
}

/// Apply formatting to a range of cells.
pub fn apply_cell_formatting(
    handle: &AppHandle,
    params: &ApplyFormattingParams,
) -> Result<String, String> {
    let state = handle.state::<AppState>();
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut styles = state.style_registry.lock().map_err(|e| e.to_string())?;

    let mut count = 0u32;
    for row in params.start_row..=params.end_row {
        for col in params.start_col..=params.end_col {
            let old_style_index = grid
                .get_cell(row, col)
                .map(|c| c.style_index)
                .unwrap_or(0);

            let mut new_style = styles.get(old_style_index).clone();

            if let Some(bold) = params.bold {
                new_style.font.bold = bold;
            }
            if let Some(italic) = params.italic {
                new_style.font.italic = italic;
            }
            if let Some(ref color) = params.text_color {
                if let Some(c) = engine::Color::from_hex(color) {
                    new_style.font.color = engine::ThemeColor::Absolute(c);
                }
            }
            if let Some(ref color) = params.background_color {
                if let Some(c) = engine::Color::from_hex(color) {
                    new_style.fill = engine::Fill::Solid { color: engine::ThemeColor::Absolute(c) };
                }
            }
            if let Some(ref fmt) = params.number_format {
                new_style.number_format = engine::NumberFormat::Custom {
                    format: fmt.clone(),
                };
            }
            if let Some(ref align) = params.text_align {
                new_style.text_align = match align.as_str() {
                    "left" => engine::TextAlign::Left,
                    "center" => engine::TextAlign::Center,
                    "right" => engine::TextAlign::Right,
                    _ => engine::TextAlign::General,
                };
            }

            let new_index = styles.get_or_create(new_style);

            if let Some(cell) = grid.get_cell(row, col) {
                let mut updated = cell.clone();
                updated.style_index = new_index;
                grid.set_cell(row, col, updated.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(row, col, updated);
                }
            } else {
                let cell = engine::Cell {
                    value: engine::CellValue::Empty,
                    ast: None,
                    style_index: new_index,
                    rich_text: None,
                };
                grid.set_cell(row, col, cell.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(row, col, cell);
                }
            }
            count += 1;
        }
    }

    Ok(format!(
        "Applied formatting to {} cell(s) ({}{}:{}{})",
        count,
        col_letter(params.start_col),
        params.start_row + 1,
        col_letter(params.end_col),
        params.end_row + 1
    ))
}

// ============================================================================
// Charts (B8 slices B + C)
// ============================================================================

/// Render a chart's `data` field compactly for the listing (a range string like
/// "Sheet1!A1:D13", or compact JSON for a DataRangeRef / pivot source).
fn compact_chart_data(data: &serde_json::Value) -> String {
    match data {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// One inventory line per chart (id, name, sheet, mark, data range), defensively
/// parsed from the opaque spec_json. Shared by list_charts AND the AI workbook
/// summary so the two surfaces can never drift. Returns the lines (no header).
fn format_chart_inventory(charts: &[ChartEntry]) -> String {
    let mut out = String::new();
    for entry in charts.iter() {
        let def: serde_json::Value =
            serde_json::from_str(&entry.spec_json).unwrap_or(serde_json::Value::Null);
        let name = def.get("name").and_then(|v| v.as_str()).unwrap_or("(unnamed)");
        let spec = def.get("spec");
        let mark = spec
            .and_then(|s| s.get("mark"))
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let data = spec
            .and_then(|s| s.get("data"))
            .map(compact_chart_data)
            .unwrap_or_else(|| "?".to_string());
        out.push_str(&format!(
            "- id={} name=\"{}\" sheet={} mark={} data={}\n",
            entry.id, name, entry.sheet_index, mark, data
        ));
    }
    out
}

/// List every chart in the workbook with its id, name, sheet, mark, and data
/// range — so an AI client can discover charts before reading or editing one.
/// Read-only: no script-security gate (MCP transport auth already applies).
pub fn list_charts(handle: &AppHandle) -> Result<String, String> {
    let state = handle.state::<AppState>();
    let charts = state.charts.lock().map_err(|e| e.to_string())?;
    if charts.is_empty() {
        return Ok("(no charts in this workbook)".to_string());
    }
    let mut out = String::from("Charts in this workbook:\n");
    out.push_str(&format_chart_inventory(&charts));
    out.push_str("\nUse get_chart(chartId) for a chart's full spec.");
    Ok(out)
}

/// Render a named-range inventory as one line per range, sorted by name for
/// deterministic output. Empty string for no ranges. Pure (no locks) so it is
/// unit-testable without an AppHandle (mirrors format_chart_inventory).
fn format_named_range_inventory(ranges: &[NamedRange]) -> String {
    let mut sorted: Vec<&NamedRange> = ranges.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    let mut out = String::new();
    for nr in sorted {
        let scope = match nr.sheet_index {
            Some(i) => format!("sheet {}", i),
            None => "workbook".to_string(),
        };
        out.push_str(&format!("- {} = {} [{}]", nr.name, nr.refers_to, scope));
        if let Some(c) = nr.comment.as_ref().filter(|c| !c.is_empty()) {
            out.push_str(&format!(" # {}", c));
        }
        out.push('\n');
    }
    out
}

/// List every named range in the workbook (name, scope, refersTo, comment) — a
/// first-class subsystem the AI could not discover via tools/list before (C1c).
/// Read-only: no script-security gate (MCP transport auth already applies).
pub fn list_named_ranges(handle: &AppHandle) -> Result<String, String> {
    let state = handle.state::<AppState>();
    let ranges = state.named_ranges.lock().map_err(|e| e.to_string())?;
    if ranges.is_empty() {
        return Ok("(no named ranges in this workbook)".to_string());
    }
    let list: Vec<NamedRange> = ranges.values().cloned().collect();
    let mut out = String::from("Named ranges in this workbook:\n");
    out.push_str(&format_named_range_inventory(&list));
    Ok(out)
}

/// Render a table inventory as one line per table, sorted by (sheet, name) for
/// deterministic output (the nested HashMap iteration order is not stable).
/// Empty string for no tables. Pure (no locks) so it is unit-testable.
fn format_table_inventory(tables: &[&Table]) -> String {
    let mut sorted: Vec<&Table> = tables.to_vec();
    sorted.sort_by(|a, b| a.sheet_index.cmp(&b.sheet_index).then_with(|| a.name.cmp(&b.name)));
    let mut out = String::new();
    for t in sorted {
        let range = format!(
            "{}{}:{}{}",
            col_letter(t.start_col),
            t.start_row + 1,
            col_letter(t.end_col),
            t.end_row + 1,
        );
        out.push_str(&format!(
            "- name=\"{}\" sheet={} range={} cols={} rows={} header={} totals={}\n",
            t.name,
            t.sheet_index,
            range,
            t.columns.len(),
            t.row_count(),
            t.style_options.header_row,
            t.style_options.total_row,
        ));
    }
    out
}

/// List every structured table in the workbook (name, sheet, A1 range, column/row
/// counts, header/totals flags) — a first-class subsystem the AI could not
/// discover via tools/list before (C1). Read-only.
pub fn list_tables(handle: &AppHandle) -> Result<String, String> {
    let state = handle.state::<AppState>();
    let tables = state.tables.lock().map_err(|e| e.to_string())?;
    let all: Vec<&Table> = tables.values().flat_map(|m| m.values()).collect();
    if all.is_empty() {
        return Ok("(no tables in this workbook)".to_string());
    }
    let mut out = String::from("Tables in this workbook:\n");
    out.push_str(&format_table_inventory(&all));
    Ok(out)
}

/// Render a pivot inventory as one line per pivot, sorted by name. Empty string
/// for no pivots. Pure (no locks) so it is unit-testable.
fn format_pivot_inventory(pivots: &[PivotTableInfo]) -> String {
    let mut sorted: Vec<&PivotTableInfo> = pivots.iter().collect();
    // Tiebreak on id: pivot names are NOT unique, so name alone is nondeterministic.
    sorted.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    let mut out = String::new();
    for p in sorted {
        out.push_str(&format!(
            "- id={} name=\"{}\" source={} dest={}",
            p.id, p.name, p.source_range, p.destination,
        ));
        if let Some(t) = p.source_table_name.as_ref().filter(|t| !t.is_empty()) {
            out.push_str(&format!(" table={}", t));
        }
        out.push('\n');
    }
    out
}

/// List every pivot table in the workbook (id, name, source range, destination,
/// linked source table) — the Pivot subsystem the AI could not discover before
/// (C1). Read-only. Pivots live on the separately-managed PivotState.
pub fn list_pivots(handle: &AppHandle) -> Result<String, String> {
    // Reuse the existing read command (it locks ONLY PivotState.pivot_tables and
    // returns display-ready PivotTableInfo), so the AI view matches the UI.
    let pivots = crate::pivot::commands::get_all_pivot_tables(
        handle.state::<AppState>(),
        handle.state::<crate::pivot::PivotState>(),
    );
    if pivots.is_empty() {
        return Ok("(no pivot tables in this workbook)".to_string());
    }
    let mut out = String::from("Pivot tables in this workbook:\n");
    out.push_str(&format_pivot_inventory(&pivots));
    Ok(out)
}

/// Return a single chart's full stored definition (chartId, name, placement, and
/// the ChartSpec) as pretty JSON, so an AI client can reason about or diff-edit
/// it. Read-only.
pub fn get_chart(handle: &AppHandle, chart_id: &str) -> Result<String, String> {
    let state = handle.state::<AppState>();
    let charts = state.charts.lock().map_err(|e| e.to_string())?;
    let entry = charts
        .iter()
        .find(|c| c.id.to_string() == chart_id)
        .ok_or_else(|| format!("No chart with id '{}'. Use list_charts to see available ids.", chart_id))?;
    let def: serde_json::Value =
        serde_json::from_str(&entry.spec_json).map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&def).map_err(|e| e.to_string())
}

/// Structural backstop for an AI-authored ChartSpec. The authoritative draft-07
/// schema lives in the TypeScript Charts extension (Rust can't import it); the AI
/// is grounded by the tool description + get_chart examples, and this rejects the
/// obvious garbage (non-object, missing mark/data/series, oversized).
fn validate_chart_spec_core(spec: &serde_json::Value) -> Result<(), String> {
    let obj = spec.as_object().ok_or("spec must be a JSON object")?;
    match obj.get("mark").and_then(|v| v.as_str()) {
        Some(m) if !m.trim().is_empty() => {}
        _ => return Err("spec.mark must be a non-empty string (e.g. \"bar\", \"line\", \"pie\")".to_string()),
    }
    match obj.get("data") {
        Some(v) if !v.is_null() => {}
        _ => return Err("spec.data is required (a range string like \"Sheet1!A1:D13\" or a DataRangeRef object)".to_string()),
    }
    match obj.get("series") {
        Some(v) if v.is_array() => {}
        _ => return Err("spec.series must be an array (one entry per data series)".to_string()),
    }
    if spec.to_string().len() > 2_000_000 {
        return Err("spec too large (max 2 MB)".to_string());
    }
    Ok(())
}

/// Create a NEW chart from an AI-authored ChartSpec. Validates the spec's core
/// shape, gates on the same script-security setting as run_script (a mutation;
/// refuses headless when the setting is 'disabled' or 'prompt'), persists it with
/// an undo snapshot, and asks the frontend to reload charts so it appears live.
pub fn create_chart_from_spec(
    handle: &AppHandle,
    spec: &serde_json::Value,
    sheet_index: Option<u32>,
    name: Option<&str>,
) -> Result<String, String> {
    // Mutation -> same gate as run_script (headless 'prompt'/'disabled' refuses).
    let script_state = handle.state::<crate::scripting::types::ScriptState>();
    crate::scripting::commands::check_script_security(&script_state)?;

    validate_chart_spec_core(spec)?;

    let state = handle.state::<AppState>();
    let sheet = match sheet_index {
        Some(s) => s as usize,
        None => *state.active_sheet.lock().map_err(|e| e.to_string())?,
    };
    let chart_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let display_name = name.unwrap_or("AI Chart");

    // The store persists the full ChartDefinition as spec_json (chartId, name,
    // placement, spec). Default placement matches a freshly-inserted chart.
    let definition = serde_json::json!({
        "chartId": chart_id.to_string(),
        "name": display_name,
        "sheetIndex": sheet,
        "x": 100,
        "y": 100,
        "width": 480,
        "height": 320,
        "spec": spec,
    });
    let spec_json = serde_json::to_string(&definition).map_err(|e| e.to_string())?;
    let entry = ChartEntry { id: chart_id, sheet_index: sheet, spec_json };

    {
        let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
        charts.push(entry);
    }
    // Undo snapshot (previous = None: this is a fresh insert), mirroring save_chart.
    crate::undo_commands::record_chart_undo(&state, chart_id, None, "Insert chart (AI)");

    // Best-effort: prompt the frontend to reload charts so the new one renders
    // without a file reopen (the Charts extension bridges this Tauri event to its
    // window "charts:refresh" handler).
    let _ = handle.emit("charts:refresh", ());

    Ok(format!(
        "Created chart id={} name=\"{}\" on sheet {} ({} mark)",
        chart_id,
        display_name,
        sheet,
        spec.get("mark").and_then(|v| v.as_str()).unwrap_or("?")
    ))
}

/// Execute a JavaScript script via the script engine.
pub fn execute_script(
    handle: &AppHandle,
    code: &str,
) -> Result<String, String> {
    // External MCP clients are script execution too — same security gate.
    // ("prompt" without a session approval refuses: the MCP path is headless
    // and cannot show a confirmation; approve in-app or set level to enabled.)
    let script_state = handle.state::<crate::scripting::types::ScriptState>();
    crate::scripting::commands::check_script_security(&script_state)?;

    let state = handle.state::<AppState>();

    // Clone data for isolated execution (same pattern as scripting/commands.rs)
    let grids = state.grids.lock().map_err(|e| e.to_string())?.clone();
    let style_registry = state.style_registry.lock().map_err(|e| e.to_string())?.clone();
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?.clone();
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;

    let (result, modified_grids) = script_engine::ScriptEngine::run(
        code,
        "mcp-script.js",
        grids,
        style_registry,
        sheet_names,
        active_sheet,
    );

    match &result {
        script_engine::ScriptResult::Success {
            output,
            cells_modified,
            duration_ms,
            ..
        } => {
            // Route the script's writes through the SHARED edit pipeline (C1a)
            // so an AI/MCP write is UNDOABLE + dependency-recalc-tracked, exactly
            // like the in-app run_script — instead of the old wholesale grid swap
            // that bypassed undo, recalc, and frontend events.
            let file_state = handle.state::<crate::persistence::FileState>();
            let user_files_state = handle.state::<crate::persistence::UserFilesState>();
            let pivot_state = handle.state::<crate::pivot::PivotState>();
            crate::scripting::commands::apply_script_modified_grids(
                &state,
                &file_state,
                &user_files_state,
                &pivot_state,
                &modified_grids,
                active_sheet,
                *cells_modified,
            )?;
            // Notify the (out-of-band) frontend so the open grid refreshes — the
            // same Tauri-event bridge create_chart_from_spec uses for charts.
            let _ = handle.emit("grid:refresh", ());

            let output_text = output.join("\n");
            Ok(format!(
                "Script executed ({}ms, {} cells modified){}",
                duration_ms,
                cells_modified,
                if output_text.is_empty() {
                    String::new()
                } else {
                    format!("\nOutput:\n{}", output_text)
                }
            ))
        }
        script_engine::ScriptResult::Error {
            message,
            output,
            ..
        } => {
            let output_text = output.join("\n");
            Err(format!(
                "Script error: {}{}",
                message,
                if output_text.is_empty() {
                    String::new()
                } else {
                    format!("\nOutput:\n{}", output_text)
                }
            ))
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_a_well_formed_spec_core() {
        let spec = json!({
            "mark": "bar",
            "data": "Sheet1!A1:D13",
            "series": [{ "name": "Revenue", "sourceIndex": 1, "color": null }]
        });
        assert!(validate_chart_spec_core(&spec).is_ok());
    }

    #[test]
    fn accepts_a_datarangeref_object_for_data() {
        let spec = json!({
            "mark": "line",
            "data": { "sheetIndex": 0, "startRow": 0, "startCol": 0, "endRow": 9, "endCol": 3 },
            "series": []
        });
        assert!(validate_chart_spec_core(&spec).is_ok());
    }

    #[test]
    fn rejects_non_object() {
        assert!(validate_chart_spec_core(&json!("nope")).is_err());
        assert!(validate_chart_spec_core(&json!(42)).is_err());
        assert!(validate_chart_spec_core(&json!([1, 2])).is_err());
    }

    #[test]
    fn rejects_missing_or_empty_mark() {
        assert!(validate_chart_spec_core(&json!({ "data": "A1:B2", "series": [] })).is_err());
        assert!(validate_chart_spec_core(&json!({ "mark": "", "data": "A1:B2", "series": [] })).is_err());
        assert!(validate_chart_spec_core(&json!({ "mark": 5, "data": "A1:B2", "series": [] })).is_err());
    }

    #[test]
    fn rejects_missing_or_null_data() {
        assert!(validate_chart_spec_core(&json!({ "mark": "bar", "series": [] })).is_err());
        assert!(validate_chart_spec_core(&json!({ "mark": "bar", "data": null, "series": [] })).is_err());
    }

    #[test]
    fn rejects_missing_or_non_array_series() {
        assert!(validate_chart_spec_core(&json!({ "mark": "bar", "data": "A1:B2" })).is_err());
        assert!(validate_chart_spec_core(&json!({ "mark": "bar", "data": "A1:B2", "series": {} })).is_err());
    }

    #[test]
    fn rejects_oversized_spec() {
        let big = "x".repeat(2_100_000);
        let spec = json!({ "mark": "bar", "data": "A1:B2", "series": [], "title": big });
        assert!(validate_chart_spec_core(&spec).is_err());
    }

    #[test]
    fn compact_data_renders_string_verbatim_and_object_as_json() {
        assert_eq!(compact_chart_data(&json!("Sheet1!A1:D13")), "Sheet1!A1:D13");
        let obj = json!({ "sheetIndex": 0, "startRow": 1 });
        let rendered = compact_chart_data(&obj);
        assert!(rendered.contains("sheetIndex"));
        assert!(rendered.starts_with('{'));
    }

    fn entry(spec_json: &str, sheet: usize) -> ChartEntry {
        ChartEntry {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            sheet_index: sheet,
            spec_json: spec_json.to_string(),
        }
    }

    #[test]
    fn chart_inventory_renders_each_entry_and_tolerates_malformed_json() {
        let charts = vec![
            entry(r#"{"name":"Revenue","spec":{"mark":"bar","data":"Sheet1!A1:D13"}}"#, 0),
            entry("{ not valid json", 2),
        ];
        let out = format_chart_inventory(&charts);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("name=\"Revenue\""));
        assert!(lines[0].contains("mark=bar"));
        assert!(lines[0].contains("data=Sheet1!A1:D13"));
        assert!(lines[0].contains("sheet=0"));
        // Malformed spec_json -> defensive fallbacks, no panic.
        assert!(lines[1].contains("name=\"(unnamed)\""));
        assert!(lines[1].contains("mark=?"));
        assert!(lines[1].contains("sheet=2"));
    }

    #[test]
    fn chart_inventory_is_empty_for_no_charts() {
        assert_eq!(format_chart_inventory(&[]), "");
    }

    fn named(name: &str, sheet_index: Option<usize>, refers_to: &str, comment: Option<&str>) -> NamedRange {
        NamedRange {
            name: name.to_string(),
            sheet_index,
            refers_to: refers_to.to_string(),
            comment: comment.map(|c| c.to_string()),
            folder: None,
        }
    }

    #[test]
    fn named_range_inventory_renders_scope_refers_to_and_comment() {
        // Pass in reverse-name order to prove the helper sorts deterministically.
        let ranges = vec![
            named("TaxRate", None, "=0.25", Some("vat")),
            named("SalesData", Some(0), "=Sheet1!$A$1:$B$10", None),
        ];
        let out = format_named_range_inventory(&ranges);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        // Sorted by name: SalesData before TaxRate.
        assert!(lines[0].contains("SalesData"));
        assert!(lines[0].contains("=Sheet1!$A$1:$B$10"));
        assert!(lines[0].contains("[sheet 0]"), "sheet-scoped marker");
        assert!(lines[1].contains("TaxRate"));
        assert!(lines[1].contains("=0.25"));
        assert!(lines[1].contains("[workbook]"), "workbook-scoped marker");
        assert!(lines[1].contains("# vat"), "comment rendered");
    }

    #[test]
    fn named_range_inventory_is_empty_for_none() {
        assert_eq!(format_named_range_inventory(&[]), "");
    }

    // ---- C1: table + pivot inventories ----

    fn make_table(
        name: &str,
        sheet: usize,
        sr: u32,
        sc: u32,
        er: u32,
        ec: u32,
        cols: usize,
        header: bool,
        totals: bool,
    ) -> crate::tables::Table {
        crate::tables::Table {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            sheet_index: sheet,
            start_row: sr,
            start_col: sc,
            end_row: er,
            end_col: ec,
            columns: (0..cols)
                .map(|i| {
                    crate::tables::TableColumn::new(
                        identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                        format!("Col{}", i),
                    )
                })
                .collect(),
            style_options: crate::tables::TableStyleOptions {
                header_row: header,
                total_row: totals,
                ..Default::default()
            },
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        }
    }

    #[test]
    fn table_inventory_renders_range_counts_flags_sorted() {
        let sales = make_table("Sales", 0, 0, 0, 12, 3, 4, true, false); // A1:D13
        let inv = make_table("Inventory", 1, 1, 1, 5, 2, 2, true, true); // B2:C6
        // Pass in reverse order to prove the (sheet, name) sort.
        let out = format_table_inventory(&[&inv, &sales]);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        // sheet 0 sorts before sheet 1.
        assert!(lines[0].contains("Sales"));
        assert!(lines[0].contains("sheet=0"));
        assert!(lines[0].contains("range=A1:D13"));
        assert!(lines[0].contains("cols=4"));
        assert!(lines[0].contains("header=true"));
        assert!(lines[1].contains("Inventory"));
        assert!(lines[1].contains("range=B2:C6"));
        assert!(lines[1].contains("totals=true"));
    }

    #[test]
    fn table_inventory_is_empty_for_none() {
        assert_eq!(format_table_inventory(&[]), "");
    }

    fn make_pivot(
        name: &str,
        source: &str,
        dest: &str,
        table: Option<&str>,
    ) -> crate::pivot::types::PivotTableInfo {
        crate::pivot::types::PivotTableInfo {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            source_range: source.to_string(),
            destination: dest.to_string(),
            allow_multiple_filters_per_field: false,
            enable_data_value_editing: false,
            refresh_on_open: false,
            use_custom_sort_lists: false,
            has_headers: true,
            source_table_name: table.map(|t| t.to_string()),
        }
    }

    #[test]
    fn pivot_inventory_renders_source_dest_table_sorted() {
        let by_region = make_pivot("Sales by Region", "A1:D100", "F1", Some("SalesTable"));
        let inventory = make_pivot("Inventory", "Sheet2!A1:C50", "H1", None);
        let out = format_pivot_inventory(&[by_region, inventory]);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        // sorted by name: Inventory before Sales by Region.
        assert!(lines[0].contains("Inventory"));
        assert!(lines[0].contains("source=Sheet2!A1:C50"));
        assert!(lines[0].contains("dest=H1"));
        assert!(!lines[0].contains("table="), "unlinked pivot omits the table tag");
        assert!(lines[1].contains("Sales by Region"));
        assert!(lines[1].contains("table=SalesTable"));
    }

    #[test]
    fn pivot_inventory_is_empty_for_none() {
        assert_eq!(format_pivot_inventory(&[]), "");
    }
}
