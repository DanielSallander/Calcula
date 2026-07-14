//! FILENAME: app/src-tauri/src/mcp/tools.rs
//! Tool helper functions that operate on AppState via the Tauri AppHandle.
//! Each function reads/writes the spreadsheet state and returns a text result.

use tauri::{AppHandle, Emitter, Manager};
use crate::AppState;
use crate::api_types::ChartEntry;
use crate::NamedRange;
use crate::tables::Table;
use crate::pivot::types::PivotTableInfo;
use pivot_engine::PivotDefinition;
use crate::format_cell_value;
use calcula_format::ai::{AiSerializeOptions, serialize_for_ai, SheetInput};
use crate::bi::types::{
    BiState, BiQueryRequest, BiColumnRef, BiFilter, BiQueryResult, ConnectionInfo, BiModelInfo,
};
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
        let suffixes = pivot_field_suffixes(handle)?;
        let section = format!("\n\n## Pivots\n{}", format_pivot_inventory(&pivots, &suffixes));
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
    // External MCP/AI clients are write operations too — gate on Script Security,
    // exactly like execute_script / create_chart_from_spec ("prompt" without a
    // session approval refuses; the MCP path is headless).
    let script_state = handle.state::<crate::scripting::types::ScriptState>();
    crate::scripting::commands::check_script_security(&script_state)?;

    let state = handle.state::<AppState>();
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;

    // Make the AI/MCP format UNDOABLE in one transaction, like the in-app path.
    undo_stack.begin_transaction(format!(
        "Apply formatting ({}{}:{}{}) (AI)",
        col_letter(params.start_col),
        params.start_row + 1,
        col_letter(params.end_col),
        params.end_row + 1
    ));

    let mut count = 0u32;
    for row in params.start_row..=params.end_row {
        for col in params.start_col..=params.end_col {
            let previous_cell = grid.get_cell(row, col).cloned();
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
            undo_stack.record_cell_change(row, col, previous_cell);
            count += 1;
        }
    }

    undo_stack.commit_transaction();

    // Mark dirty + live-refresh the open grid (mirrors execute_script:858) so the
    // AI/MCP format participates in save state and repaints out-of-band.
    if let Ok(mut modified) = handle.state::<crate::persistence::FileState>().is_modified.lock() {
        *modified = true;
    }
    let _ = handle.emit("grid:refresh", ());

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
fn format_pivot_inventory(
    pivots: &[PivotTableInfo],
    field_suffixes: &std::collections::HashMap<identity::EntityId, String>,
) -> String {
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
        // C1 field detail: rows=[..] cols=[..] values=[..] from the definition.
        if let Some(suffix) = field_suffixes.get(&p.id) {
            out.push_str(suffix);
        }
        out.push('\n');
    }
    out
}

/// Compact field summary for a pivot definition, e.g.
/// " rows=[Region,Category] cols=[Quarter] values=[Sum of Sales]". Empty areas
/// are omitted; empty string when the pivot has no fields. Pure (no locks).
fn format_pivot_fields(def: &PivotDefinition) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !def.row_fields.is_empty() {
        let names = def.row_fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>().join(",");
        parts.push(format!("rows=[{}]", names));
    }
    if !def.column_fields.is_empty() {
        let names = def.column_fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>().join(",");
        parts.push(format!("cols=[{}]", names));
    }
    if !def.value_fields.is_empty() {
        let names = def.value_fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>().join(",");
        parts.push(format!("values=[{}]", names));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" {}", parts.join(" "))
    }
}

/// Build the id -> field-suffix map for the workbook's pivots by reading each
/// PivotDefinition. Separate from get_all_pivot_tables (which returns the
/// display-ready PivotTableInfo lines) so the line formatting stays reused and
/// only the field detail is added. Locks ONLY PivotState.pivot_tables.
fn pivot_field_suffixes(
    handle: &AppHandle,
) -> Result<std::collections::HashMap<identity::EntityId, String>, String> {
    let ps = handle.state::<crate::pivot::PivotState>();
    let tables = ps.pivot_tables.lock().map_err(|e| e.to_string())?;
    Ok(tables
        .iter()
        .map(|(id, (def, _cache))| (*id, format_pivot_fields(def)))
        .collect())
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
    let suffixes = pivot_field_suffixes(handle)?;
    let mut out = String::from("Pivot tables in this workbook:\n");
    out.push_str(&format_pivot_inventory(&pivots, &suffixes));
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

/// Create a NEW named range (AI). Creates it via the SAME undoable command the
/// UI uses, then emits "named-ranges:refresh" so the new name appears live (the
/// DefinedNames extension bridges that Tauri event to NAMED_RANGES_CHANGED).
/// Gated on the same script-security setting as other mutations.
pub fn create_named_range(
    handle: &AppHandle,
    name: &str,
    refers_to: &str,
    sheet_index: Option<usize>,
    comment: Option<String>,
) -> Result<String, String> {
    // Mutation -> same gate as run_script (headless 'prompt'/'disabled' refuses).
    let script_state = handle.state::<crate::scripting::types::ScriptState>();
    crate::scripting::commands::check_script_security(&script_state)?;

    // The command validates the name + range, inserts, and records an undo entry.
    let result = crate::named_ranges::create_named_range(
        handle.state::<AppState>(),
        name.to_string(),
        sheet_index,
        refers_to.to_string(),
        comment,
        None, // folder
    );
    if !result.success {
        return Err(result
            .error
            .unwrap_or_else(|| "Failed to create named range".to_string()));
    }

    // Live-refresh the NameBox / Name Manager for this out-of-band create; the
    // DefinedNames extension bridges this Tauri event to NAMED_RANGES_CHANGED.
    let _ = handle.emit("named-ranges:refresh", ());

    Ok(format!("Created named range '{}' -> {}", name, refers_to))
}

/// Create a NEW structured table over a cell range (AI). Reuses the SAME
/// undoable create_table command the UI uses (table + autofilter wrapped in one
/// undo transaction), gates on the script-security setting, then emits
/// "tables:refresh" so it appears live (the Table extension bridges that event).
/// Created on the ACTIVE sheet (header names are read from the grid).
pub fn create_table(
    handle: &AppHandle,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    has_headers: bool,
    name: Option<&str>,
) -> Result<String, String> {
    let script_state = handle.state::<crate::scripting::types::ScriptState>();
    crate::scripting::commands::check_script_security(&script_state)?;

    let params = crate::tables::CreateTableParams {
        name: name.unwrap_or("").to_string(), // empty => auto-generated "Table1"...
        start_row,
        start_col,
        end_row,
        end_col,
        has_headers,
        style_options: None,
        style_name: None,
    };
    let result = crate::tables::create_table(handle.state::<AppState>(), params);
    if !result.success {
        return Err(result
            .error
            .unwrap_or_else(|| "Failed to create table".to_string()));
    }

    let _ = handle.emit("tables:refresh", ());

    let table_name = result.table.map(|t| t.name).unwrap_or_else(|| "table".to_string());
    Ok(format!(
        "Created table \"{}\" over {}{}:{}{}",
        table_name,
        col_letter(start_col),
        start_row + 1,
        col_letter(end_col),
        end_row + 1,
    ))
}

/// Map an aggregation string from the AI to the engine's AggregationType (v1 set).
fn parse_aggregation(s: &str) -> Result<pivot_engine::AggregationType, String> {
    use pivot_engine::AggregationType as A;
    match s.trim().to_lowercase().as_str() {
        "sum" => Ok(A::Sum),
        "count" => Ok(A::Count),
        "average" | "avg" | "mean" => Ok(A::Average),
        "min" => Ok(A::Min),
        "max" => Ok(A::Max),
        other => Err(format!(
            "Unknown aggregation '{}'. Use one of: sum, count, average, min, max.",
            other
        )),
    }
}

/// Create a NEW pivot table configured with row + value fields in ONE undoable
/// step (AI). Reuses create_pivot_inner (the same create path the UI uses) so the
/// single "Create pivot table" undo reverts it; then emits "pivots:refresh" (the
/// Pivot extension bridges that to a live refresh). v1 = row + value fields only.
#[allow(clippy::too_many_arguments)]
pub fn create_pivot(
    handle: &AppHandle,
    source_range: &str,
    destination_cell: &str,
    row_fields: Vec<String>,
    value_fields: Vec<(String, String)>,
    source_sheet: Option<usize>,
    destination_sheet: Option<usize>,
    has_headers: bool,
    name: Option<&str>,
) -> Result<String, String> {
    let script_state = handle.state::<crate::scripting::types::ScriptState>();
    crate::scripting::commands::check_script_security(&script_state)?;

    if value_fields.is_empty() {
        return Err("create_pivot requires at least one value field (e.g. {field:\"Revenue\", aggregation:\"sum\"}).".to_string());
    }
    let row_field_count = row_fields.len();
    let value_field_count = value_fields.len();

    // Map aggregation strings -> AggregationType.
    let mut value_specs: Vec<(String, pivot_engine::AggregationType)> = Vec::new();
    for (field, agg_str) in &value_fields {
        value_specs.push((field.clone(), parse_aggregation(agg_str)?));
    }

    let request = crate::pivot::types::CreatePivotRequest {
        source_range: source_range.to_string(),
        destination_cell: destination_cell.to_string(),
        source_sheet,
        destination_sheet,
        has_headers: Some(has_headers),
        name: name.map(|s| s.to_string()),
        source_table_name: None,
    };

    let response = crate::pivot::commands::create_pivot_inner(
        handle.state::<AppState>(),
        handle.state::<crate::pivot::PivotState>(),
        request,
        row_fields,
        value_specs,
    )?;

    // Live-refresh the pivot view for this out-of-band create; the Pivot
    // extension bridges this Tauri event to its window "pivot:refresh".
    let _ = handle.emit("pivots:refresh", ());

    Ok(format!(
        "Created pivot \"{}\" at {} ({} output rows): {} row field(s), {} value field(s)",
        name.unwrap_or("PivotTable"),
        destination_cell,
        response.row_count,
        row_field_count,
        value_field_count,
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
            let pane_control_state = handle.state::<crate::pane_control::PaneControlState>();
            let ribbon_filter_state = handle.state::<crate::ribbon_filter::RibbonFilterState>();
            crate::scripting::commands::apply_script_modified_grids(
                &state,
                &file_state,
                &user_files_state,
                &pivot_state,
                &pane_control_state,
                &ribbon_filter_state,
                &modified_grids,
                active_sheet,
                *cells_modified,
                "mcp",
                "",
            )?;
            // Notify the (out-of-band) frontend so the open grid refreshes — the
            // same Tauri-event bridge create_chart_from_spec uses for charts.
            let _ = handle.emit("grid:refresh", ());

            let output_text = output
                .iter()
                .map(|i| i.to_text())
                .collect::<Vec<_>>()
                .join("\n");
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
            let output_text = output
                .iter()
                .map(|i| i.to_text())
                .collect::<Vec<_>>()
                .join("\n");
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
// BI / Cube (read-only)
//
// A read-only BI tool tier for AI clients (MCP + in-app chat). These WRAP the
// existing BI command internals (bi/commands.rs + bi/cube.rs) — no BI logic is
// reimplemented. Like a trusted main-window call, the AI carries no script_id,
// so the structured query replicates bi_query MINUS the per-script bi.query
// capability re-check (a sandboxed script still goes through the gated cube_udf_*
// / bi_query paths). Read-only: no grid mutation, no cache writes.
// ============================================================================

/// Render a BI connection inventory as one line per connection, sorted by
/// (name, id) for deterministic output. Pure (no locks) so it is unit-testable
/// without an AppHandle (mirrors format_table_inventory).
fn format_bi_connection_inventory(infos: &[ConnectionInfo]) -> String {
    let mut sorted: Vec<&ConnectionInfo> = infos.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    let mut out = String::new();
    for c in sorted {
        out.push_str(&format!(
            "- id={} name=\"{}\" type={} connected={} tables={} measures={} server={} database={}\n",
            c.id, c.name, c.connection_type, c.is_connected,
            c.table_count, c.measure_count, c.server, c.database,
        ));
    }
    out
}

/// List every BI/cube connection in the workbook (id, name, type, connected
/// state, table/measure counts, server, database) so an AI client can discover
/// BI models before describe_bi_model / run_bi_query. Read-only.
pub fn list_bi_connections(handle: &AppHandle) -> Result<String, String> {
    let bi = handle.state::<BiState>();
    let infos: Vec<ConnectionInfo> = {
        let connections = bi.connections.lock().map_err(|e| e.to_string())?;
        connections.values().map(|c| c.to_info()).collect()
    };
    if infos.is_empty() {
        return Ok("(no BI connections in this workbook)".to_string());
    }
    let mut out = String::from("BI connections in this workbook:\n");
    out.push_str(&format_bi_connection_inventory(&infos));
    out.push_str("\nUse describe_bi_model(connectionId) for tables/columns/measures, then run_bi_query.");
    Ok(out)
}

/// Render a BI model schema compactly for an LLM (tables + columns with data
/// types, measures, KPIs, relationships). Pure (no locks) so it is unit-testable.
fn format_bi_model_info(conn_id: &str, m: &BiModelInfo) -> String {
    let mut out = format!("BI model for connection {}:\n", conn_id);
    out.push_str("## Tables\n");
    if m.tables.is_empty() {
        out.push_str("(none)\n");
    }
    for t in &m.tables {
        let cols = t
            .columns
            .iter()
            .map(|c| {
                if c.is_context_column {
                    format!("{} ({}, context)", c.name, c.data_type)
                } else {
                    format!("{} ({})", c.name, c.data_type)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!("- {} [{}]\n", t.name, cols));
    }
    out.push_str("## Measures\n");
    if m.measures.is_empty() {
        out.push_str("(none)\n");
    }
    for me in &m.measures {
        out.push_str(&format!("- {} (table {})\n", me.name, me.table));
    }
    if !m.kpis.is_empty() {
        out.push_str("## KPIs\n");
        for k in &m.kpis {
            out.push_str(&format!("- {} (base measure {})\n", k.name, k.base_measure));
        }
    }
    if !m.relationships.is_empty() {
        out.push_str("## Relationships\n");
        for r in &m.relationships {
            out.push_str(&format!(
                "- {}.{} -> {}.{}\n",
                r.from_table, r.from_column, r.to_table, r.to_column
            ));
        }
    }
    out.push_str(
        "\nQuery with run_bi_query(connectionId, measures=[measure names], group_by=[{table,column},...]).",
    );
    out
}

/// Describe a BI/cube model's schema for a connection id from list_bi_connections.
/// Mirrors bi_get_model_info (clone the engine Arc under the std lock, then await
/// the engine lock and read the model). Read-only.
pub async fn describe_bi_model(handle: &AppHandle, connection_id: &str) -> Result<String, String> {
    let id = identity::EntityId::parse(connection_id).ok_or_else(|| {
        format!("Invalid connection id '{}'. Use list_bi_connections to see ids.", connection_id)
    })?;
    let bi = handle.state::<BiState>();
    let engine_arc = {
        let connections = bi.connections.lock().map_err(|e| e.to_string())?;
        let conn = connections
            .get(&id)
            .ok_or_else(|| format!("No BI connection with id '{}'.", connection_id))?;
        conn.engine.clone()
    };
    match engine_arc {
        Some(arc) => {
            let engine = arc.lock().await;
            let info = crate::bi::commands::model_to_info(engine.model());
            Ok(format_bi_model_info(connection_id, &info))
        }
        None => Ok(format!("Connection '{}' has no model loaded.", connection_id)),
    }
}

/// Render a BiQueryResult as a compact pipe-table, capping rows for the LLM
/// context window (row_count still reports the true total). Pure.
fn format_bi_query_result(r: &BiQueryResult) -> String {
    if r.columns.is_empty() {
        return "(query returned no columns)".to_string();
    }
    const MAX_ROWS: usize = 200;
    let mut out = String::new();
    out.push_str(&format!("| {} |\n", r.columns.join(" | ")));
    for row in r.rows.iter().take(MAX_ROWS) {
        let cells: Vec<String> = row.iter().map(|c| c.clone().unwrap_or_default()).collect();
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    if r.row_count > MAX_ROWS {
        out.push_str(&format!("... ({} more row(s) not shown)\n", r.row_count - MAX_ROWS));
    }
    out.push_str(&format!("\n{} row(s), {} column(s).", r.row_count, r.columns.len()));
    out
}

/// Run a READ-ONLY structured BI/cube query: aggregate `measures` grouped by
/// `group_by` [(table, column)] dimensions, with optional `filters`
/// [(table, column, operator, value)]. Replicates bi_query's inner logic minus
/// the script_id capability gate (the AI is a trusted in-process caller). Returns
/// a pipe-table, capped for the LLM context window.
pub async fn run_bi_query(
    handle: &AppHandle,
    connection_id: &str,
    measures: Vec<String>,
    group_by: Vec<(String, String)>,
    filters: Vec<(String, String, String, String)>,
) -> Result<String, String> {
    let id = identity::EntityId::parse(connection_id).ok_or_else(|| {
        format!("Invalid connection id '{}'. Use list_bi_connections to see ids.", connection_id)
    })?;
    if measures.is_empty() && group_by.is_empty() {
        return Err("run_bi_query needs at least one measure or one group_by column.".to_string());
    }
    let bi = handle.state::<BiState>();
    let request = BiQueryRequest {
        measures,
        group_by: group_by
            .into_iter()
            .map(|(table, column)| BiColumnRef { table, column })
            .collect(),
        filters: filters
            .into_iter()
            .map(|(table, column, operator, value)| BiFilter { table, column, operator, value })
            .collect(),
    };
    let query_request = crate::bi::commands::build_engine_query(&request);
    let engine_arc = crate::bi::commands::get_engine_arc(&bi, id)?;
    let batches = {
        let mut engine = engine_arc.lock().await;
        // Apply this connection's RLS role (or clear a sibling's) before querying.
        crate::bi::commands::apply_connection_role(&mut engine, &bi, id);
        let (b, _refreshed) = engine
            .query_auto_refresh(query_request)
            .await
            .map_err(|e| crate::bi::commands::friendly_bi_query_error("Query failed", &e))?;
        b
    };
    let result: BiQueryResult = crate::bi::commands::batches_to_result(&batches);
    Ok(format_bi_query_result(&result))
}

/// Resolve a CUBEVALUE for an AI client: a measure expression plus optional
/// member filters. `connection` is a connection name or id; `members` are CUBE
/// member-expressions (e.g. "[Sales Amount]", "Product[Category]=Bikes").
/// Read-only (wraps the bi.query-scoped script_cube_value).
pub async fn cube_value(
    handle: &AppHandle,
    connection: &str,
    members: &[String],
) -> Result<String, String> {
    let bi = handle.state::<BiState>();
    match crate::bi::cube::script_cube_value(&bi, connection, members)
        .await
        .map_err(crate::bi::cube::cube_err_message)?
    {
        Some(v) => Ok(v.to_string()),
        None => Ok("(no value)".to_string()),
    }
}

/// Resolve a KPI value (property 1), goal (2), or status (3) for an AI client.
/// `connection` is a connection name or id. Read-only.
pub async fn cube_kpi(
    handle: &AppHandle,
    connection: &str,
    kpi: &str,
    property: i64,
) -> Result<String, String> {
    let bi = handle.state::<BiState>();
    match crate::bi::cube::script_cube_kpi(&bi, connection, kpi, property)
        .await
        .map_err(crate::bi::cube::cube_err_message)?
    {
        Some(v) => Ok(v.to_string()),
        None => Ok("(no value)".to_string()),
    }
}

/// List the distinct members of a level (a Table[Column] expression) for an AI
/// client to iterate. `connection` is a connection name or id. Read-only.
pub async fn cube_members(
    handle: &AppHandle,
    connection: &str,
    level: &str,
) -> Result<String, String> {
    let bi = handle.state::<BiState>();
    let members = crate::bi::cube::script_cube_members(&bi, connection, level)
        .await
        .map_err(crate::bi::cube::cube_err_message)?;
    if members.is_empty() {
        return Ok("(no members)".to_string());
    }
    let mut out = format!("{} member(s):\n", members.len());
    for m in &members {
        out.push_str(&format!("- {}\n", m));
    }
    Ok(out)
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
        use std::collections::HashMap;
        let by_region = make_pivot("Sales by Region", "A1:D100", "F1", Some("SalesTable"));
        let inventory = make_pivot("Inventory", "Sheet2!A1:C50", "H1", None);
        let out = format_pivot_inventory(&[by_region, inventory], &HashMap::new());
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
        assert_eq!(format_pivot_inventory(&[], &std::collections::HashMap::new()), "");
    }

    fn make_pivot_def(rows: &[&str], cols: &[&str], values: &[&str]) -> pivot_engine::PivotDefinition {
        use pivot_engine::{AggregationType, PivotField, ValueField};
        let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (10, 3));
        for (i, r) in rows.iter().enumerate() {
            def.row_fields.push(PivotField::new(i, r.to_string()));
        }
        for (i, c) in cols.iter().enumerate() {
            def.column_fields.push(PivotField::new(i, c.to_string()));
        }
        for (i, v) in values.iter().enumerate() {
            def.value_fields.push(ValueField::new(i, v.to_string(), AggregationType::Sum));
        }
        def
    }

    #[test]
    fn pivot_fields_renders_rows_cols_values_omitting_empty() {
        let def = make_pivot_def(&["Region", "Category"], &[], &["Sum of Sales", "Count"]);
        let s = format_pivot_fields(&def);
        assert!(s.contains("rows=[Region,Category]"));
        assert!(s.contains("values=[Sum of Sales,Count]"));
        assert!(!s.contains("cols="), "empty column area is omitted");
        // No fields at all -> empty string.
        assert_eq!(format_pivot_fields(&make_pivot_def(&[], &[], &[])), "");
    }

    #[test]
    fn pivot_inventory_appends_field_suffix_by_id() {
        use std::collections::HashMap;
        let p = make_pivot("Sales", "A1:D100", "F1", None);
        let mut suffixes = HashMap::new();
        suffixes.insert(p.id, " rows=[Region] values=[Sum of Sales]".to_string());
        let out = format_pivot_inventory(&[p], &suffixes);
        assert!(out.contains("rows=[Region]"));
        assert!(out.contains("values=[Sum of Sales]"));
    }

    // ---- BI / cube (read-only) ----

    fn conn_info(id_byte: u8, name: &str, connected: bool, tables: usize, measures: usize) -> ConnectionInfo {
        ConnectionInfo {
            id: identity::EntityId::from_bytes([id_byte; 16]),
            name: name.to_string(),
            description: String::new(),
            connection_type: "PostgreSQL".to_string(),
            connection_string: String::new(),
            server: "db.example".to_string(),
            database: "sales".to_string(),
            preferred_auth: "Integrated".to_string(),
            model_path: None,
            last_refreshed: None,
            is_connected: connected,
            table_count: tables,
            measure_count: measures,
        }
    }

    #[test]
    fn bi_connection_inventory_renders_sorted_lines() {
        // Pass reverse-name order to prove the helper sorts deterministically.
        let infos = vec![
            conn_info(2, "Warehouse", false, 3, 1),
            conn_info(1, "Sales", true, 5, 8),
        ];
        let out = format_bi_connection_inventory(&infos);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        // Sorted by name: Sales before Warehouse.
        assert!(lines[0].contains("name=\"Sales\""));
        assert!(lines[0].contains("connected=true"));
        assert!(lines[0].contains("tables=5"));
        assert!(lines[0].contains("measures=8"));
        assert!(lines[0].contains("server=db.example"));
        assert!(lines[1].contains("name=\"Warehouse\""));
        assert!(lines[1].contains("connected=false"));
    }

    #[test]
    fn bi_connection_inventory_is_empty_for_none() {
        assert_eq!(format_bi_connection_inventory(&[]), "");
    }

    #[test]
    fn bi_model_info_renders_tables_measures_kpis_relationships() {
        use crate::bi::types::{BiTableInfo, BiColumnInfo, BiMeasureInfo, BiRelationshipInfo};
        let m = BiModelInfo {
            tables: vec![BiTableInfo {
                name: "Sales".to_string(),
                columns: vec![
                    BiColumnInfo { name: "Region".to_string(), data_type: "Text".to_string(), is_context_column: false, is_writeback_column: false },
                    BiColumnInfo { name: "Segment".to_string(), data_type: "Text".to_string(), is_context_column: true, is_writeback_column: false },
                ],
            }],
            measures: vec![BiMeasureInfo { name: "Revenue".to_string(), table: "Sales".to_string() }],
            relationships: vec![BiRelationshipInfo {
                name: "r1".to_string(),
                from_table: "Sales".to_string(),
                from_column: "ProductId".to_string(),
                to_table: "Product".to_string(),
                to_column: "Id".to_string(),
            }],
            hierarchies: vec![],
            kpis: vec![crate::bi::types::BiKpiInfo {
                name: "Margin KPI".to_string(),
                base_measure: "Margin".to_string(),
                target_kind: "constant".to_string(),
                target_value: Some(0.3),
                target_measure: None,
                status_bands: vec![],
                description: None,
            }],
            security_roles: vec![],
            calculation_groups: vec![],
        };
        let out = format_bi_model_info("conn-1", &m);
        assert!(out.contains("## Tables"));
        assert!(out.contains("Region (Text)"));
        assert!(out.contains("Segment (Text, context)"), "context column flagged");
        assert!(out.contains("## Measures"));
        assert!(out.contains("Revenue (table Sales)"));
        assert!(out.contains("## KPIs"));
        assert!(out.contains("Margin KPI (base measure Margin)"));
        assert!(out.contains("## Relationships"));
        assert!(out.contains("Sales.ProductId -> Product.Id"));
    }

    #[test]
    fn bi_query_result_renders_pipe_table_and_caps_rows() {
        let result = BiQueryResult {
            columns: vec!["Region".to_string(), "Revenue".to_string()],
            rows: vec![
                vec![Some("North".to_string()), Some("100".to_string())],
                vec![Some("South".to_string()), None],
            ],
            row_count: 2,
        };
        let out = format_bi_query_result(&result);
        assert!(out.contains("| Region | Revenue |"));
        assert!(out.contains("| North | 100 |"));
        assert!(out.contains("| South |  |"), "None cell renders empty");
        assert!(out.contains("2 row(s), 2 column(s)."));

        // Cap: >200 rows shows a truncation footer using the true total.
        let many: Vec<Vec<Option<String>>> = (0..250)
            .map(|i| vec![Some(format!("R{}", i)), Some(i.to_string())])
            .collect();
        let big = BiQueryResult { columns: vec!["A".to_string(), "B".to_string()], rows: many, row_count: 250 };
        let out_big = format_bi_query_result(&big);
        assert!(out_big.contains("50 more row(s) not shown"));
        assert!(out_big.contains("250 row(s), 2 column(s)."));
    }

    #[test]
    fn bi_query_result_empty_columns() {
        let result = BiQueryResult { columns: vec![], rows: vec![], row_count: 0 };
        assert_eq!(format_bi_query_result(&result), "(query returned no columns)");
    }
}
