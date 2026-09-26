//! FILENAME: app/src-tauri/src/pivot/operations.rs
use std::collections::HashMap;
use crate::api_types::MergedRegion;
use crate::commands::styles::parse_number_format;
use crate::pivot::utils::col_index_to_letter;
use crate::{log_debug, log_warn, AppState, ProtectedRegion};
use crate::pivot::types::PivotState;
use pivot_engine::{calculate_pivot, PivotCache, PivotDefinition, PivotId, PivotView};
use engine::{
    Cell, CellStyle, CellValue, StyleRegistry,
    Borders, BorderStyle, BorderLineStyle, Color, Fill, TextAlign, ThemeColor,
};
use arrow::array::{
    Array, BooleanArray, Date32Array, Decimal128Array,
    Float32Array, Float64Array, Int16Array, Int32Array, Int64Array,
    StringArray, TimestampMicrosecondArray,
};
use arrow::datatypes::DataType as ArrowDataType;
use arrow::record_batch::RecordBatch;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Minimum reserved rows for an empty pivot table placeholder
const EMPTY_PIVOT_ROWS: u32 = 18;
/// Minimum reserved columns for an empty pivot table placeholder
const EMPTY_PIVOT_COLS: u32 = 3;

// ============================================================================
// GRID & LOGIC OPERATIONS
// ============================================================================

/// Creates an empty pivot view for when no fields are configured
pub(crate) fn create_empty_view(pivot_id: PivotId, version: u64) -> PivotView {
    PivotView {
        pivot_id,
        version,
        row_count: 0,
        col_count: 0,
        row_label_col_count: 0,
        column_header_row_count: 0,
        cells: Vec::new(),
        rows: Vec::new(),
        columns: Vec::new(),
        is_windowed: false,
        total_row_count: None,
        window_start_row: None,
        filter_row_count: 0,     // Added missing field
        filter_rows: Vec::new(), // Added missing field
        row_field_summaries: Vec::new(),
        column_field_summaries: Vec::new(),
    }
}

/// Check if the pivot definition has any fields configured
pub(crate) fn has_fields_configured(definition: &PivotDefinition) -> bool {
    !definition.row_fields.is_empty() 
        || !definition.column_fields.is_empty() 
        || !definition.value_fields.is_empty()
}

/// Safely calculate pivot - returns empty view if no fields configured.
/// Also catches panics from the calculation: callers hold PivotState mutexes,
/// and an unwinding panic would poison them and break every later pivot call.
pub(crate) fn safe_calculate_pivot(definition: &PivotDefinition, cache: &mut PivotCache) -> PivotView {
    if !has_fields_configured(definition) {
        log_debug!("PIVOT", "No fields configured, returning empty view");
        return create_empty_view(definition.id, definition.version);
    }
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| calculate_pivot(definition, cache))) {
        Ok(view) => view,
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            log_debug!("PIVOT", "calculate_pivot panicked: {}", msg);
            create_empty_view(definition.id, definition.version)
        }
    }
}

/// Builds a PivotCache from grid data.
///
/// When the source range extends well beyond the grid's actual data (e.g. the
/// user selected entire columns A:D which resolves to A1:D1048576), the end row
/// is automatically clamped to the last populated row in the grid.  This matches
/// Excel's behaviour where full-column references only include populated cells.
pub(crate) fn build_cache_from_grid(
    grid: &engine::Grid,
    start: (u32, u32),
    end: (u32, u32),
    has_headers: bool,
) -> Result<(PivotCache, Vec<String>), String> {
    let (start_row, start_col) = start;
    let (mut end_row, end_col) = end;

    // Clamp end_row to the grid's last populated row so that full-column
    // selections (e.g. A:D -> A1:D1048576) don't iterate over a million
    // empty rows.
    if end_row > grid.max_row {
        end_row = grid.max_row;
    }

    let col_count = (end_col - start_col + 1) as usize;

    // If the (clamped) end row is before the start row there is no data.
    if end_row < start_row {
        let headers: Vec<String> = (0..col_count)
            .map(|i| col_index_to_letter(i as u32))
            .collect();
        let cache = PivotCache::new(identity::EntityId::ZERO, col_count);
        return Ok((cache, headers));
    }

    let data_start_row = if has_headers { start_row + 1 } else { start_row };

    // Extract headers
    let headers: Vec<String> = if has_headers {
        (start_col..=end_col)
            .map(|c| {
                grid.get_cell(start_row, c)
                    .map(|cell| cell.display_value())
                    .unwrap_or_else(|| col_index_to_letter(c - start_col))
            })
            .collect()
    } else {
        (0..col_count)
            .map(|i| col_index_to_letter(i as u32))
            .collect()
    };

    // Find the actual last row with data within this column range.
    // grid.max_row is a global bound — data in other columns may push it
    // beyond what these specific columns contain.
    let mut effective_end_row = data_start_row.saturating_sub(1);
    for row in (data_start_row..=end_row).rev() {
        let has_data = (start_col..=end_col)
            .any(|col| grid.get_cell(row, col).is_some());
        if has_data {
            effective_end_row = row;
            break;
        }
    }

    // Create cache
    let mut cache = PivotCache::new(identity::EntityId::ZERO, col_count);

    // Set field names
    for (i, name) in headers.iter().enumerate() {
        cache.set_field_name(i, name.clone());
    }

    // Add records up to the last row with data
    for row in data_start_row..=effective_end_row {
        let mut values: Vec<CellValue> = Vec::with_capacity(col_count);

        for col in start_col..=end_col {
            let value = grid
                .get_cell(row, col)
                .map(|cell| cell.value.clone())
                .unwrap_or(CellValue::Empty);
            values.push(value);
        }

        // source_row is u32
        cache.add_record(row - data_start_row, &values);
    }

    Ok((cache, headers))
}

/// Builds a PivotCache from Arrow RecordBatches (BI query results).
/// Each column in the batch becomes a cache field.
pub(crate) fn build_cache_from_arrow_batches(
    pivot_id: PivotId,
    batches: &[RecordBatch],
) -> Result<PivotCache, String> {
    if batches.is_empty() {
        return Ok(PivotCache::new(pivot_id, 0));
    }

    let schema = batches[0].schema();
    let field_count = schema.fields().len();
    let mut cache = PivotCache::new(pivot_id, field_count);

    // Set field names from schema
    for (i, field) in schema.fields().iter().enumerate() {
        cache.set_field_name(i, field.name().clone());
    }

    // Add records from all batches
    let mut source_row: u32 = 0;
    for batch in batches {
        for row_idx in 0..batch.num_rows() {
            let mut values: Vec<CellValue> = Vec::with_capacity(field_count);
            for col_idx in 0..batch.num_columns() {
                let col = batch.column(col_idx);
                values.push(arrow_cell_to_value(col.as_ref(), row_idx));
            }
            cache.add_record(source_row, &values);
            source_row += 1;
        }
    }

    Ok(cache)
}

/// Convert an Arrow array cell to a CellValue for the PivotCache.
pub(crate) fn arrow_cell_to_value(array: &dyn Array, idx: usize) -> CellValue {
    if array.is_null(idx) {
        return CellValue::Empty;
    }
    match array.data_type() {
        ArrowDataType::Int16 => {
            let a = array.as_any().downcast_ref::<Int16Array>().unwrap();
            CellValue::Number(a.value(idx) as f64)
        }
        ArrowDataType::Int32 => {
            let a = array.as_any().downcast_ref::<Int32Array>().unwrap();
            CellValue::Number(a.value(idx) as f64)
        }
        ArrowDataType::Int64 => {
            let a = array.as_any().downcast_ref::<Int64Array>().unwrap();
            CellValue::Number(a.value(idx) as f64)
        }
        ArrowDataType::Float32 => {
            let a = array.as_any().downcast_ref::<Float32Array>().unwrap();
            CellValue::Number(a.value(idx) as f64)
        }
        ArrowDataType::Float64 => {
            let a = array.as_any().downcast_ref::<Float64Array>().unwrap();
            CellValue::Number(a.value(idx))
        }
        ArrowDataType::Utf8 => {
            let a = array.as_any().downcast_ref::<StringArray>().unwrap();
            CellValue::Text(a.value(idx).to_string())
        }
        ArrowDataType::Boolean => {
            let a = array.as_any().downcast_ref::<BooleanArray>().unwrap();
            CellValue::Boolean(a.value(idx))
        }
        ArrowDataType::Date32 => {
            let a = array.as_any().downcast_ref::<Date32Array>().unwrap();
            let days = a.value(idx);
            let date = chrono::NaiveDate::from_num_days_from_ce_opt(days + 719_163);
            match date {
                Some(d) => CellValue::Text(d.format("%Y-%m-%d").to_string()),
                None => CellValue::Number(days as f64),
            }
        }
        ArrowDataType::Timestamp(arrow::datatypes::TimeUnit::Microsecond, _) => {
            let a = array.as_any().downcast_ref::<TimestampMicrosecondArray>().unwrap();
            let us = a.value(idx);
            let secs = us / 1_000_000;
            let nsecs = ((us % 1_000_000) * 1000) as u32;
            let dt = chrono::DateTime::from_timestamp(secs, nsecs);
            match dt {
                Some(d) => CellValue::Text(d.format("%Y-%m-%d %H:%M:%S").to_string()),
                None => CellValue::Number(us as f64),
            }
        }
        ArrowDataType::Decimal128(_, scale) => {
            let a = array.as_any().downcast_ref::<Decimal128Array>().unwrap();
            let raw = a.value(idx);
            let scale = *scale as u32;
            let divisor = 10f64.powi(scale as i32);
            CellValue::Number(raw as f64 / divisor)
        }
        ArrowDataType::Dictionary(key_type, _) => {
            // Dictionary-encoded columns (e.g. Dictionary(Int32, Utf8))
            use arrow::datatypes::DataType;
            match key_type.as_ref() {
                DataType::Int8 => {
                    let dict = array.as_any().downcast_ref::<arrow::array::DictionaryArray<arrow::datatypes::Int8Type>>().unwrap();
                    let values = arrow::array::cast::as_string_array(dict.values());
                    let key = dict.keys().value(idx) as usize;
                    CellValue::Text(values.value(key).to_string())
                }
                DataType::Int16 => {
                    let dict = array.as_any().downcast_ref::<arrow::array::DictionaryArray<arrow::datatypes::Int16Type>>().unwrap();
                    let values = arrow::array::cast::as_string_array(dict.values());
                    let key = dict.keys().value(idx) as usize;
                    CellValue::Text(values.value(key).to_string())
                }
                DataType::Int32 => {
                    let dict = array.as_any().downcast_ref::<arrow::array::DictionaryArray<arrow::datatypes::Int32Type>>().unwrap();
                    let values = arrow::array::cast::as_string_array(dict.values());
                    let key = dict.keys().value(idx) as usize;
                    CellValue::Text(values.value(key).to_string())
                }
                DataType::Int64 => {
                    let dict = array.as_any().downcast_ref::<arrow::array::DictionaryArray<arrow::datatypes::Int64Type>>().unwrap();
                    let values = arrow::array::cast::as_string_array(dict.values());
                    let key = dict.keys().value(idx) as usize;
                    CellValue::Text(values.value(key).to_string())
                }
                _ => CellValue::Text(format!("<unsupported dict key: {:?}>", key_type)),
            }
        }
        _ => CellValue::Text(format!("<unsupported: {:?}>", array.data_type())),
    }
}

/// Builds a PivotCache from Arrow RecordBatches with a synthetic "Total"
/// dimension column prepended. Used when a BI pivot has measures but no
/// group-by dimensions.
/// Build a LONG-format cache for a pivot with a PLACED calculation group
/// (Power BI-style dimension).
///
/// The engine result is `[dims][measure cols]` — cross-applied WIDE
/// (measures-outer/items-inner) for an item application, or plain/selection
/// columns otherwise. Each source row becomes one row per `row_items` entry:
/// `[("Total")?][dims][item][M measures]`, in declaration order so
/// `SortOrder::DataSourceOrder` on the group field renders items in that
/// order (Power BI ordinal semantics, never alphabetical). A `None` entry
/// emits an EMPTY item cell — the "no item applied" state of a
/// filters-placed group (never listed in dropdowns, never hidden by
/// hidden_items).
///
/// `all_items` (the group's declared items) are pre-interned into the item
/// column's dictionary so filter dropdowns and filter-row summaries always
/// offer every item, regardless of which rows exist.
///
/// `wide_measure_idx` maps (base measure, item-or-None) -> wide result column
/// from the engine's own per-column metadata; positions fall back to the
/// measures-outer/items-inner contract when metadata is absent (e.g. empty
/// result sets).
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_cache_calc_group_long(
    pivot_id: PivotId,
    batches: &[RecordBatch],
    num_dims: usize,
    group_name: &str,
    row_items: &[Option<String>],
    all_items: &[String],
    measure_names: &[String],
    wide_measure_idx: &std::collections::HashMap<(String, Option<String>), usize>,
    synthetic_dim: bool,
) -> Result<PivotCache, String> {
    let m = measure_names.len();
    let k = row_items.len();
    let syn = usize::from(synthetic_dim);
    let item_field = syn + num_dims;
    let total_fields = syn + num_dims + 1 + m;

    let mut cache = PivotCache::new(pivot_id, total_fields);
    if synthetic_dim {
        cache.set_field_name(0, "Total".to_string());
    }
    if let Some(first) = batches.first() {
        let schema = first.schema();
        for i in 0..num_dims.min(schema.fields().len()) {
            cache.set_field_name(syn + i, schema.field(i).name().clone());
        }
    }
    // The item column is named after the GROUP: it IS the group's field.
    cache.set_field_name(item_field, group_name.to_string());
    for (mi, name) in measure_names.iter().enumerate() {
        cache.set_field_name(item_field + 1 + mi, name.clone());
    }

    // Register every declared item as a known value of the group field (in
    // declaration order), so dropdowns list them all even when the current
    // rows carry only one item — or none.
    if let Some(field_cache) = cache.fields.get_mut(item_field) {
        for item in all_items {
            field_cache.intern(pivot_engine::CacheValue::from(&CellValue::Text(item.clone())));
        }
    }

    let wide_col = |mi: usize, ki: usize| -> usize {
        wide_measure_idx
            .get(&(measure_names[mi].clone(), row_items[ki].clone()))
            .copied()
            .unwrap_or(num_dims + mi * k + ki)
    };

    let mut source_row: u32 = 0;
    for batch in batches {
        for row_idx in 0..batch.num_rows() {
            for (ki, item) in row_items.iter().enumerate() {
                let mut values: Vec<CellValue> = Vec::with_capacity(total_fields);
                if synthetic_dim {
                    values.push(CellValue::Text("Total".to_string()));
                }
                for d in 0..num_dims {
                    values.push(arrow_cell_to_value(batch.column(d).as_ref(), row_idx));
                }
                values.push(match item {
                    Some(name) => CellValue::Text(name.clone()),
                    None => CellValue::Empty,
                });
                for mi in 0..m {
                    let col = wide_col(mi, ki);
                    if col < batch.num_columns() {
                        values.push(arrow_cell_to_value(batch.column(col).as_ref(), row_idx));
                    } else {
                        values.push(CellValue::Empty);
                    }
                }
                cache.add_record(source_row, &values);
                source_row += 1;
            }
        }
    }

    // Group-only pivot (no measures, no other dimensions): there is no engine
    // result at all, but the group's rows still render — one per `row_items`
    // entry (blank measure cells), like a dimensions-only pivot shows its
    // distinct values.
    if source_row == 0 && num_dims == 0 && batches.is_empty() {
        for item in row_items {
            let mut values: Vec<CellValue> = Vec::with_capacity(total_fields);
            if synthetic_dim {
                values.push(CellValue::Text("Total".to_string()));
            }
            values.push(match item {
                Some(name) => CellValue::Text(name.clone()),
                None => CellValue::Empty,
            });
            for _ in 0..m {
                values.push(CellValue::Empty);
            }
            cache.add_record(source_row, &values);
            source_row += 1;
        }
    }

    Ok(cache)
}

pub(crate) fn build_cache_with_synthetic_dim(
    pivot_id: PivotId,
    batches: &[RecordBatch],
) -> Result<PivotCache, String> {
    if batches.is_empty() {
        let mut cache = PivotCache::new(pivot_id, 1);
        cache.set_field_name(0, "Total".to_string());
        return Ok(cache);
    }

    let schema = batches[0].schema();
    let orig_field_count = schema.fields().len();
    let total_fields = orig_field_count + 1; // +1 for synthetic "Total"

    let mut cache = PivotCache::new(pivot_id, total_fields);
    cache.set_field_name(0, "Total".to_string());
    for (i, field) in schema.fields().iter().enumerate() {
        cache.set_field_name(i + 1, field.name().clone());
    }

    let mut source_row: u32 = 0;
    for batch in batches {
        for row_idx in 0..batch.num_rows() {
            let mut values: Vec<CellValue> = Vec::with_capacity(total_fields);
            values.push(CellValue::Text("Total".to_string()));
            for col_idx in 0..batch.num_columns() {
                let col = batch.column(col_idx);
                values.push(arrow_cell_to_value(col.as_ref(), row_idx));
            }
            cache.add_record(source_row, &values);
            source_row += 1;
        }
    }

    Ok(cache)
}

/// Resolves the destination sheet index from a pivot definition, in three
/// steps, most authoritative first:
///
/// 1. **The destination NAME.** Exact spelling first, then ignoring ASCII case
///    -- sheet names are unique ignoring case (`ensure_sheet_name_is_free`), so
///    the second match is unambiguous, and a case-only drift between a stored
///    name and its tab must not lose the pivot. A name that resolves is
///    honoured whatever the sheet's kind: a canvas pivot names its canvas, and a
///    GRID pivot aimed at a canvas is refused where it writes
///    (`update_pivot_in_grid`), not re-aimed here.
/// 2. **The pivot's own registered region.** On a name miss the protected
///    region is where the pivot's cells ACTUALLY are, which is the only sheet
///    its output may be rewritten on.
/// 3. **The active sheet**, as before canvases existed, for a pivot that has
///    neither (never rendered). If that is a canvas the write refuses.
///
/// THERE IS NO REDIRECT to "some other worksheet". It used to send a stale-
/// named pivot to the first user worksheet whenever a canvas was active, and
/// that wrote the pivot's output straight over whatever that sheet held --
/// typically the pivot's own source data. A name misses because a rename did
/// not carry the definition with it; `rename_sheet_inner` now rewrites
/// `destination_sheet` / `source_sheet`, which removes the cause.
///
/// LOCKS -- what callers actually hold: most call this WITH `pivot_tables`
/// held (it is `Persisted`, so even a read guard is an exclusive mutex): e.g.
/// `toggle_pivot_group`, `refresh_pivot_cache`, `apply_pivot_definition_restore`.
/// So every store read here is taken UNDER `pivot_tables`, each ALONE and
/// released before the next: `sheet_names`, then `protected_regions` (a std
/// mutex), then `active_sheet`. `pivot_tables` -> `protected_regions` is the
/// crate's order (`delete_pivot_table`, the undo delete, and the structural
/// row/column shifts in `commands/structure.rs`, which take `pivot_tables`
/// FIRST for exactly this reason). `sheet_kinds` and `sheet_visibility` are
/// deliberately NOT read here: `delete_sheet_impl` holds `sheet_visibility`
/// while it takes `pivot_tables`, so reading it under `pivot_tables` closed a
/// cycle. KNOWN OPEN (predates canvases): `delete_sheet_impl` also holds
/// `sheet_names` / `active_sheet` while it takes `pivot_tables`, so the two
/// reads this resolver has always made under `pivot_tables` are the same
/// shape; closing that needs `delete_sheet_impl` to stop taking
/// `pivot_tables` under its sheet guards.
pub(crate) fn resolve_dest_sheet_index(state: &AppState, definition: &PivotDefinition) -> usize {
    if let Some(ref sheet_name) = definition.destination_sheet {
        let sheet_names = state.sheet_names.read().unwrap();
        if let Some(idx) = sheet_names.iter().position(|n| n == sheet_name) {
            return idx;
        }
        if let Some(idx) = sheet_names.iter().position(|n| n.eq_ignore_ascii_case(sheet_name)) {
            return idx;
        }
    }
    // The name missed (or was never set): the sheet the pivot's cells are on.
    if let Some(region) = get_pivot_region(state, definition.id) {
        if definition.destination_sheet.is_some() {
            log_warn!(
                "PIVOT",
                "pivot {} names destination sheet {:?}, which this workbook does not have; \
                 using the sheet its output is registered on ({})",
                definition.id,
                definition.destination_sheet,
                region.sheet_index
            );
        }
        return region.sheet_index;
    }
    // Neither a name nor a region: the active sheet, exactly as before
    // canvases. A canvas here is refused by `update_pivot_in_grid`.
    *state.active_sheet.read().unwrap()
}

/// Carry every pivot's sheet NAMES through a sheet rename: each
/// `destination_sheet` and `source_sheet` equal to `old_name` (ignoring ASCII
/// case -- sheet names are unique that way, and a stored name whose case has
/// drifted from its tab still means that tab) becomes `new_name`. Returns how
/// many definitions changed.
///
/// The cancel-revert snapshots in `previous_states` carry definitions too; a
/// revert after the rename must not put the old spelling back.
///
/// LOCKS: `pivot_tables`, then `previous_states`, each alone. The caller must
/// hold no sheet guard (`rename_sheet_inner` calls this after dropping them).
pub(crate) fn rename_pivot_sheet_references(
    pivot_state: &PivotState,
    effect: &crate::document_effect::DocumentEffect,
    old_name: &str,
    new_name: &str,
) -> usize {
    let rewrite = |def: &mut PivotDefinition| -> bool {
        let mut changed = false;
        for slot in [&mut def.destination_sheet, &mut def.source_sheet] {
            if slot.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(old_name)) {
                *slot = Some(new_name.to_string());
                changed = true;
            }
        }
        changed
    };
    let mut changed = 0;
    if let Ok(mut tables) = pivot_state.pivot_tables.write(effect) {
        for (def, _) in tables.values_mut() {
            if rewrite(def) {
                changed += 1;
            }
        }
    }
    if let Ok(mut previous) = pivot_state.previous_states.lock() {
        for (def, _) in previous.values_mut() {
            rewrite(def);
        }
    }
    if changed > 0 {
        log_debug!(
            "PIVOT",
            "sheet rename '{}' -> '{}' re-aimed {} pivot definition(s)",
            old_name,
            new_name,
            changed
        );
    }
    changed
}

/// Clears cells in a pivot region from the grid.
pub(crate) fn clear_pivot_region_from_grid(
    grid: &mut engine::Grid,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) {
    log_debug!(
        "PIVOT",
        "clear_pivot_region_from_grid: ({},{}) to ({},{})",
        start_row,
        start_col,
        end_row,
        end_col
    );

    grid.clear_region(start_row, start_col, end_row, end_col);
}

/// Gets the current protected region for a pivot ID, if it exists.
pub(crate) fn get_pivot_region(state: &AppState, pivot_id: PivotId) -> Option<ProtectedRegion> {
    let regions = state.protected_regions.lock().unwrap();
    regions.iter().find(|r| r.region_type == "pivot" && r.owner_id == pivot_id).cloned()
}

// ============================================================================
// PIVOT THEME COLORS (matches frontend DEFAULT_PIVOT_THEME)
// ============================================================================

const PIVOT_HEADER_BG: Color = Color::new(192, 230, 245);       // #C0E6F5
const PIVOT_TOTAL_BG: Color = Color::new(232, 232, 232);        // #e8e8e8
const PIVOT_GRAND_TOTAL_BG: Color = Color::new(192, 230, 245);  // #C0E6F5
const PIVOT_FILTER_BG: Color = Color::new(192, 230, 245);       // #C0E6F5 (matches header)
const PIVOT_BORDER_COLOR: Color = Color::new(232, 232, 232);    // #e8e8e8
const PIVOT_HEADER_BORDER: Color = Color::new(160, 208, 232);   // #a0d0e8

/// Cache key for deduplicating pivot cell styles.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PivotStyleKey {
    background_style: u8,
    is_bold: bool,
    indent_level: u8,
    text_align: u8,
    number_format_key: String,
    border_key: u8,
}

/// Build a full CellStyle for a pivot cell based on its metadata.
fn build_pivot_cell_style(
    pivot_cell: &pivot_engine::PivotViewCell,
    styles: &mut StyleRegistry,
    style_cache: &mut HashMap<PivotStyleKey, usize>,
) -> usize {
    use pivot_engine::{BackgroundStyle, PivotCellType};

    // Determine bold
    let is_bold = pivot_cell.is_bold
        || pivot_cell.is_expandable
        || matches!(
            pivot_cell.cell_type,
            PivotCellType::FilterLabel | PivotCellType::RowLabelHeader | PivotCellType::ColumnLabelHeader
        )
        || matches!(
            pivot_cell.background_style,
            BackgroundStyle::Header | BackgroundStyle::Subtotal | BackgroundStyle::Total | BackgroundStyle::GrandTotal
        );

    // Determine text alignment
    let text_align = match pivot_cell.cell_type {
        PivotCellType::Data
        | PivotCellType::RowSubtotal
        | PivotCellType::ColumnSubtotal
        | PivotCellType::GrandTotal
        | PivotCellType::GrandTotalRow
        | PivotCellType::GrandTotalColumn
        | PivotCellType::FilterLabel => TextAlign::Right,
        _ => TextAlign::Left,
    };

    // Border key: encode the border configuration as a single byte
    let border_key: u8 = match pivot_cell.background_style {
        BackgroundStyle::Header => 1,       // bottom 2px
        BackgroundStyle::Subtotal | BackgroundStyle::Total => 2, // top+bottom 1px
        BackgroundStyle::GrandTotal => 3,   // top+bottom 2px
        BackgroundStyle::FilterRow => 4,    // bottom 1px
        _ => 0,                             // no borders
    };

    // Background style as u8
    let bg_key: u8 = match pivot_cell.background_style {
        BackgroundStyle::Normal => 0,
        BackgroundStyle::Header => 1,
        BackgroundStyle::Subtotal => 2,
        BackgroundStyle::Total => 3,
        BackgroundStyle::GrandTotal => 4,
        BackgroundStyle::Alternate => 5,
        BackgroundStyle::FilterRow => 6,
    };

    // Text align as u8
    let align_key: u8 = match text_align {
        TextAlign::Right => 1,
        _ => 0,
    };

    let nf_key = pivot_cell.number_format.clone().unwrap_or_default();

    let cache_key = PivotStyleKey {
        background_style: bg_key,
        is_bold,
        indent_level: pivot_cell.indent_level,
        text_align: align_key,
        number_format_key: nf_key.clone(),
        border_key,
    };

    if let Some(&cached_idx) = style_cache.get(&cache_key) {
        return cached_idx;
    }

    // Build the fill
    let fill = match pivot_cell.background_style {
        BackgroundStyle::Header => Fill::Solid { color: ThemeColor::Absolute(PIVOT_HEADER_BG) },
        BackgroundStyle::Subtotal | BackgroundStyle::Total => Fill::Solid { color: ThemeColor::Absolute(PIVOT_TOTAL_BG) },
        BackgroundStyle::GrandTotal => Fill::Solid { color: ThemeColor::Absolute(PIVOT_GRAND_TOTAL_BG) },
        BackgroundStyle::FilterRow => Fill::Solid { color: ThemeColor::Absolute(PIVOT_FILTER_BG) },
        _ => Fill::Solid { color: ThemeColor::Absolute(Color::white()) },
    };

    // Build borders
    let borders = match pivot_cell.background_style {
        BackgroundStyle::Header => Borders {
            bottom: BorderStyle { width: 2, color: ThemeColor::Absolute(PIVOT_HEADER_BORDER), style: BorderLineStyle::Solid },
            ..Borders::default()
        },
        BackgroundStyle::Subtotal | BackgroundStyle::Total => Borders {
            top: BorderStyle { width: 1, color: ThemeColor::Absolute(PIVOT_BORDER_COLOR), style: BorderLineStyle::Solid },
            bottom: BorderStyle { width: 1, color: ThemeColor::Absolute(PIVOT_BORDER_COLOR), style: BorderLineStyle::Solid },
            ..Borders::default()
        },
        BackgroundStyle::GrandTotal => Borders {
            top: BorderStyle { width: 2, color: ThemeColor::Absolute(PIVOT_HEADER_BORDER), style: BorderLineStyle::Solid },
            bottom: BorderStyle { width: 2, color: ThemeColor::Absolute(PIVOT_HEADER_BORDER), style: BorderLineStyle::Solid },
            ..Borders::default()
        },
        BackgroundStyle::FilterRow => Borders {
            bottom: BorderStyle { width: 1, color: ThemeColor::Absolute(PIVOT_BORDER_COLOR), style: BorderLineStyle::Solid },
            ..Borders::default()
        },
        _ => Borders::default(),
    };

    // Build number format
    let nf = if !nf_key.is_empty() {
        parse_number_format(&nf_key)
    } else {
        engine::NumberFormat::General
    };

    // Assemble the full style
    let mut style = CellStyle::new()
        .with_bold(is_bold)
        .with_fill(fill)
        .with_text_align(text_align)
        .with_number_format(nf);
    style.borders = borders;
    style.indent = pivot_cell.indent_level;

    let idx = styles.get_or_create(style);
    style_cache.insert(cache_key, idx);
    idx
}

/// Writes pivot view cells to the destination grid.
/// Creates full cell styles (fill, bold, borders, alignment, indent, number format)
/// so that pivot cells render correctly via the grid renderer without an overlay.
/// Returns a list of merge regions for cells with col_span/row_span > 1.
pub(crate) fn write_pivot_to_grid(
    grid: &mut engine::Grid,
    mut active_grid: Option<&mut engine::Grid>,
    view: &PivotView,
    destination: (u32, u32),
    styles: &mut StyleRegistry,
) -> Vec<MergedRegion> {
    let (dest_row, dest_col) = destination;

    log_debug!(
        "PIVOT",
        "write_pivot_to_grid: dest=({},{}) view_size={}x{} dual_write={}",
        dest_row,
        dest_col,
        view.row_count,
        view.col_count,
        active_grid.is_some()
    );

    // If view is empty, nothing to write
    if view.row_count == 0 || view.col_count == 0 {
        log_debug!("PIVOT", "Empty view, nothing to write to grid");
        return Vec::new();
    }

    // Collect merge regions for cells with col_span/row_span > 1
    let mut merge_regions: Vec<MergedRegion> = Vec::new();

    // Cache: composite style key → style_index. Avoids redundant style lookups.
    let mut style_cache: HashMap<PivotStyleKey, usize> = HashMap::new();

    // Pre-allocate grid capacity to avoid HashMap resizing during bulk insert.
    let cell_count = view.row_count * view.col_count;
    grid.cells.reserve(cell_count);
    if let Some(ref mut ag) = active_grid {
        ag.cells.reserve(cell_count);
    }

    // Iterate through all rows, skipping hidden ones.
    // Use view_row (sequential visible index) for grid positioning so that
    // collapsed rows don't leave gaps or write cells beyond the pivot region.
    for (row_idx, row_descriptor) in view.rows.iter().enumerate() {
        if !row_descriptor.visible {
            continue;
        }

        // Get the cells for this row
        if row_idx >= view.cells.len() {
            continue;
        }
        let row_cells = &view.cells[row_idx];

        for (col_idx, pivot_cell) in row_cells.iter().enumerate() {
            let grid_row = dest_row + row_descriptor.view_row as u32;
            let grid_col = dest_col + col_idx as u32;

            // Determine CellValue and style_index (shared between both grid writes)
            let cell_value = match &pivot_cell.value {
                pivot_engine::PivotCellValue::Empty => CellValue::Empty,
                pivot_engine::PivotCellValue::Number(n) => CellValue::Number(*n),
                pivot_engine::PivotCellValue::Text(s) => {
                    if s.is_empty() {
                        CellValue::Empty
                    } else {
                        CellValue::Text(s.clone())
                    }
                }
                pivot_engine::PivotCellValue::Boolean(b) => CellValue::Boolean(*b),
                pivot_engine::PivotCellValue::Error(e) => CellValue::Text(format!("#{}", e)),
            };

            // Build full cell style (fill, bold, borders, alignment, indent, number format)
            let style_idx = build_pivot_cell_style(pivot_cell, styles, &mut style_cache);

            // Write to both grids using unchecked insert (bounds set once after loop)
            if let Some(ag) = active_grid.as_deref_mut() {
                ag.set_cell_unchecked(grid_row, grid_col, Cell {
                    ast: None,
                    value: cell_value.clone(),
                    style_index: style_idx,
                    rich_text: None,
                });
            }
            grid.set_cell_unchecked(grid_row, grid_col, Cell {
                ast: None,
                value: cell_value,
                style_index: style_idx,
                rich_text: None,
            });

            // Collect merge regions for spanned cells
            if pivot_cell.col_span > 1 || pivot_cell.row_span > 1 {
                merge_regions.push(MergedRegion {
                    start_row: grid_row,
                    start_col: grid_col,
                    end_row: grid_row + (pivot_cell.row_span as u32).max(1) - 1,
                    end_col: grid_col + (pivot_cell.col_span as u32).max(1) - 1,
                });
            }
        }
    }

    // Update bounds once for the entire region (instead of per-cell)
    if view.row_count > 0 && view.col_count > 0 {
        let end_row = dest_row + view.row_count as u32 - 1;
        let end_col = dest_col + view.col_count as u32 - 1;
        grid.update_bounds(end_row, end_col);
        if let Some(ag) = active_grid.as_deref_mut() {
            ag.update_bounds(end_row, end_col);
        }
    }

    log_debug!(
        "PIVOT",
        "write_pivot_to_grid: wrote {} rows to grid ({} merge regions)",
        view.rows.iter().filter(|r| r.visible).count(),
        merge_regions.len()
    );

    merge_regions
}

/// Checks whether a destination cell overlaps with any existing pivot table region.
/// Returns an error message if the destination falls inside a protected pivot region.
pub(crate) fn check_pivot_overlap(
    state: &AppState,
    sheet_index: usize,
    destination: (u32, u32),
) -> Result<(), String> {
    let (dest_row, dest_col) = destination;
    let regions = state.protected_regions.lock().unwrap();
    for region in regions.iter() {
        // Any GENERATED output region is off limits, not just another pivot's.
        // Dropping a pivot on top of a BI refresh target or a grid report is the
        // same failure: two writers own the same cells and the loser's output is
        // silently overwritten on the next refresh.
        if !matches!(region.region_type.as_str(), "pivot" | "bi" | "report") {
            continue;
        }
        if region.sheet_index == sheet_index
            && dest_row >= region.start_row
            && dest_row <= region.end_row
            && dest_col >= region.start_col
            && dest_col <= region.end_col
        {
            let what = match region.region_type.as_str() {
                "pivot" => "an existing pivot table",
                "bi" => "a model refresh region",
                _ => "a report region",
            };
            return Err(format!(
                "Cannot create pivot table: destination cell is inside {} ({})",
                what, region.id
            ));
        }
    }
    Ok(())
}

/// Every pivot table's rectangle on one sheet, inclusive, as a SNAPSHOT.
///
/// The lock is taken and released here, so the caller can hold nothing else
/// while asking — the discipline the insights commands already follow for the
/// hidden-row sets, and the reason this returns owned rectangles rather than a
/// guard: Tauri dispatches on a thread pool, and a caller that held the grid
/// locks across this would be inventing a new lock order.
///
/// Only `"pivot"` regions, deliberately. A `"bi"` region is a model REFRESH
/// target — a block of query results, which is an ordinary rectangle of numbers
/// and a perfectly reasonable thing to analyse — and a `"report"` region is
/// someone else's output, not a cross-tabulation.
pub(crate) fn pivot_rects_on_sheet(state: &AppState, sheet_index: usize) -> Vec<(u32, u32, u32, u32)> {
    let regions = match state.protected_regions.lock() {
        Ok(r) => r,
        Err(poisoned) => poisoned.into_inner(),
    };
    regions
        .iter()
        .filter(|r| r.region_type == "pivot" && r.sheet_index == sheet_index)
        .map(|r| (r.start_row, r.start_col, r.end_row, r.end_col))
        .collect()
}

/// Snapshot the workbook's sheet names.
///
/// Callers that need to resolve a sheet name while holding `pivot_tables` must
/// take this FIRST: `delete_sheet` locks `sheet_names` and then `pivot_tables`,
/// so resolving under `pivot_tables` is the reverse order and two concurrent
/// commands could deadlock. Snapshotting sidesteps the ordering entirely.
pub(crate) fn sheet_names_snapshot(state: &AppState) -> Vec<String> {
    state
        .sheet_names
        .read()
        .map(|names| names.clone())
        .unwrap_or_default()
}

/// Index of `name` within a [`sheet_names_snapshot`], or `None`.
///
/// Pivot definitions anchor both their destination and their source by sheet
/// name (never a raw index, which a sheet move would silently repoint).
pub(crate) fn index_of_sheet(sheet_names: &[String], name: &str) -> Option<usize> {
    // CASE-INSENSITIVE, like every sheet-name comparison in the product: the
    // lexer uppercases bare identifiers, so `Data` and `data` are one name to a
    // formula and must be one name here.
    //
    // An exact match missed an anchor whose spelling had drifted from its tab —
    // a case-only rename is legal and updates no pivot definition — and callers
    // fall back to sheet 0 on a miss, so the pivot silently rebuilt its cache
    // from an unrelated sheet.
    sheet_names.iter().position(|n| n.eq_ignore_ascii_case(name))
}

/// Reject a pivot whose output would land on its own source data.
///
/// Nothing checked this before: `check_pivot_overlap` compares the destination
/// only against OTHER generated regions, so a pivot pointed at a cell inside its
/// own source range would begin overwriting the rows it reads. The next refresh
/// then aggregates its own output — the classic self-referential corruption,
/// with no cycle detection anywhere to catch it (the dependency graph is
/// cell→cell and never sees a pivot's read set).
///
/// Only meaningful when both live on the same sheet.
pub(crate) fn check_pivot_source_destination_overlap(
    source_sheet: usize,
    source_start: (u32, u32),
    source_end: (u32, u32),
    dest_sheet: usize,
    destination: (u32, u32),
) -> Result<(), String> {
    if source_sheet != dest_sheet {
        return Ok(());
    }
    let (dest_row, dest_col) = destination;
    let (sr, sc) = source_start;
    let (er, ec) = source_end;
    // Normalize, so a caller passing the corners in either order still works.
    let (r0, r1) = if sr <= er { (sr, er) } else { (er, sr) };
    let (c0, c1) = if sc <= ec { (sc, ec) } else { (ec, sc) };

    if dest_row >= r0 && dest_row <= r1 && dest_col >= c0 && dest_col <= c1 {
        return Err(
            "Cannot create pivot table: the destination is inside the source range, so the \
             pivot would overwrite the data it reads. Choose a destination outside the source \
             (or put it on another sheet)."
                .to_string(),
        );
    }
    Ok(())
}

/// Updates the pivot region tracking for a pivot table.
pub(crate) fn update_pivot_region(
    state: &AppState,
    pivot_id: PivotId,
    sheet_index: usize,
    destination: (u32, u32),
    view: &PivotView,
) {
    let mut regions = state.protected_regions.lock().unwrap();

    // Remove any existing region for this pivot
    regions.retain(|r| !(r.region_type == "pivot" && r.owner_id == pivot_id));

    let (dest_row, dest_col) = destination;
    
    // Calculate region size - use actual view size or minimum reserved size for empty pivots
    let (end_row, end_col) = if view.row_count > 0 && view.col_count > 0 {
        // Count all rows in the view (headers + data)
        let total_rows = view.row_count as u32;
        let total_cols = view.col_count as u32;
        (
            dest_row + total_rows.saturating_sub(1),
            dest_col + total_cols.saturating_sub(1),
        )
    } else {
        // Empty pivot - reserve minimum space for placeholder
        (
            dest_row + EMPTY_PIVOT_ROWS - 1,
            dest_col + EMPTY_PIVOT_COLS - 1,
        )
    };
    
    regions.push(ProtectedRegion {
        id: format!("pivot-{}", pivot_id),
        region_type: "pivot".to_string(),
        owner_id: pivot_id,
        sheet_index,
        start_row: dest_row,
        start_col: dest_col,
        end_row,
        end_col,
    });
    
    log_debug!(
        "PIVOT",
        "updated pivot region: id={} sheet={} ({},{}) to ({},{}) empty={}",
        pivot_id,
        sheet_index,
        dest_row,
        dest_col,
        end_row,
        end_col,
        view.row_count == 0
    );
}

/// The refusal a GRID pivot gets when its destination is a canvas sheet. One
/// wording for the pre-effect gates (`ensure_pivot_destination_writable`) and
/// the write-site backstop (`update_pivot_in_grid`), so a caller cannot tell
/// which of the two caught it -- and the message names the canvas.
pub(crate) const GRID_PIVOT_CANVAS_ACTION: &str = "write a grid pivot table";

// ============================================================================
// CANVAS PIVOTS (M6): a real pivot in the canvas's hidden grid
// ============================================================================
//
// THE RULE, both halves: a pivot carrying a `canvas_frame` lives ONLY on a
// canvas, and a pivot without one NEVER on a canvas. A canvas pivot's output is
// written into the canvas's hidden grid like any pivot's (so `=Canvas1!C5`,
// GETPIVOTDATA, slicers and pivot charts all find real cells); the canvas shows
// it through the frame, not as cells.
//
// Its anchor is not the user's to choose: the hidden grid is carved into
// column BLOCKS of `CANVAS_PIVOT_BLOCK_COLS`, each canvas pivot owns one, and
// `allocate_canvas_pivot_anchor` hands out the first free one. That is what
// keeps two pivots on one canvas from ever writing over each other -- which on
// a canvas nobody could SEE happen.

/// Width, in columns, of one canvas pivot's block in the canvas's hidden grid.
/// A canvas pivot wider than this is refused at the write, never clipped and
/// never allowed to spill into its neighbour's block.
pub(crate) const CANVAS_PIVOT_BLOCK_COLS: u32 = 1024;
/// How many blocks a canvas holds: 16 x 1024 = 16,384 columns, the whole
/// Excel-sized grid (A..XFD).
pub(crate) const CANVAS_PIVOT_MAX_BLOCKS: u32 = 16;

/// The anchor for a NEW pivot on canvas `sheet_index`: row 0, the first column
/// of the first block whose column band holds no generated output region
/// (`pivot` / `bi` / `report`) on that sheet.
///
/// Whole BANDS are checked, not just the anchor cell (`check_pivot_overlap`
/// tests the anchor only): a block is taken if anything reaches into it.
///
/// LOCKS: `protected_regions` alone. The caller must hold nothing that is
/// ordered after it (`pivot_tables` is ordered BEFORE it, so do not hold that
/// either -- the create doors call this holding nothing).
pub(crate) fn allocate_canvas_pivot_anchor(
    state: &AppState,
    sheet_index: usize,
) -> Result<(u32, u32), String> {
    let regions = state
        .protected_regions
        .lock()
        .map_err(|e| format!("protected_regions lock poisoned: {}", e))?;
    for block in 0..CANVAS_PIVOT_MAX_BLOCKS {
        let first = block * CANVAS_PIVOT_BLOCK_COLS;
        let last = first + CANVAS_PIVOT_BLOCK_COLS - 1;
        let taken = regions.iter().any(|r| {
            matches!(r.region_type.as_str(), "pivot" | "bi" | "report")
                && r.sheet_index == sheet_index
                && r.start_col <= last
                && r.end_col >= first
        });
        if !taken {
            return Ok((0, first));
        }
    }
    Err(format!(
        "Cannot create pivot table: this canvas already holds the maximum of {} pivot tables. \
         Delete one, or put the pivot on another canvas.",
        CANVAS_PIVOT_MAX_BLOCKS
    ))
}

/// A canvas pivot's view must fit the block its anchor is in. `Err` -- LOUD,
/// naming the width -- when it would reach past the block's last column: a
/// silent clip would show the user a pivot with columns missing, and writing
/// on would overwrite the next canvas pivot's cells. Pure; no locks.
pub(crate) fn ensure_canvas_pivot_fits_block(
    pivot_id: PivotId,
    destination: (u32, u32),
    view: &PivotView,
) -> Result<(), String> {
    let offset = (destination.1 % CANVAS_PIVOT_BLOCK_COLS) as u64;
    let width = view.col_count as u64;
    if offset + width > CANVAS_PIVOT_BLOCK_COLS as u64 {
        return Err(format!(
            "Cannot show pivot table {} on the canvas: it is {} columns wide, and a canvas pivot \
             holds at most {} columns. Remove a column field or filter the pivot to fewer columns.",
            pivot_id,
            view.col_count,
            CANVAS_PIVOT_BLOCK_COLS as u64 - offset
        ));
    }
    Ok(())
}

/// The refusal a FRAMED pivot gets when its destination is NOT a canvas: its
/// anchor is a canvas block (column 1024*n), and writing it into a worksheet
/// would drop a pivot nobody asked for far to the right of the user's data.
pub(crate) fn ensure_canvas_destination(
    state: &AppState,
    pivot_id: PivotId,
    dest_sheet_idx: usize,
) -> Result<(), String> {
    let is_canvas = {
        let kinds = state
            .sheet_kinds
            .read()
            .map_err(|e| format!("sheet_kinds lock poisoned: {}", e))?;
        crate::sheets::is_canvas_sheet(&kinds, dest_sheet_idx)
    };
    if is_canvas {
        Ok(())
    } else {
        Err(format!(
            "Cannot write pivot table {} to sheet {}: it has a canvas frame, and a canvas pivot \
             lives only on a canvas sheet (this one is a worksheet).",
            pivot_id, dest_sheet_idx
        ))
    }
}

/// Does `pivot_id` carry a canvas frame? `false` for an unknown pivot.
///
/// LOCKS: `pivot_tables` ALONE, released on return. Callers must not hold it
/// (it is `Persisted`, so even a read guard is exclusive).
pub(crate) fn pivot_is_framed(pivot_state: &PivotState, pivot_id: PivotId) -> bool {
    pivot_state
        .pivot_tables
        .read()
        .map(|tables| tables.get(&pivot_id).is_some_and(|(def, _)| def.canvas_frame.is_some()))
        .unwrap_or(false)
}

/// Refuse an operation that only makes sense for a GRID pivot (`action` reads
/// as a verb phrase) when the pivot has a canvas frame: its anchor belongs to
/// the canvas block allocator, and the user moves the BOX instead
/// (`update_pivot_properties` with `canvas_frame`). Run before the caller's
/// effect, so the refusal leaves the document clean.
pub(crate) fn ensure_pivot_not_framed(
    pivot_state: &PivotState,
    pivot_id: PivotId,
    action: &str,
) -> Result<(), String> {
    if pivot_is_framed(pivot_state, pivot_id) {
        Err(format!(
            "Cannot {} pivot table {}: it is shown on a canvas, where its cells are placed by the \
             canvas. Move or resize its box on the canvas instead.",
            action, pivot_id
        ))
    } else {
        Ok(())
    }
}

/// Resolve `pivot_id`'s destination and refuse when it is the wrong KIND for
/// the pivot -- a frameless (grid) pivot aimed at a canvas, or a framed
/// (canvas) pivot aimed at a worksheet. The pre-effect half of the rule
/// `update_pivot_in_grid` enforces at the write: a pivot command that will
/// rewrite the grid calls this BEFORE it mints its `DocumentEffect`, so a
/// refusal leaves the document clean.
///
/// LOCKS: `pivot_tables` is taken alone to clone the definition and released
/// before the resolver runs; then `sheet_kinds` alone. The caller must hold
/// none of them.
pub(crate) fn ensure_pivot_destination_writable(
    state: &AppState,
    pivot_state: &PivotState,
    pivot_id: PivotId,
) -> Result<(), String> {
    let definition = {
        let tables = pivot_state
            .pivot_tables
            .read()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        match tables.get(&pivot_id) {
            Some((def, _)) => def.clone(),
            // The caller's own existence check owns the "not found" refusal.
            None => return Ok(()),
        }
    };
    let dest = resolve_dest_sheet_index(state, &definition);
    if definition.canvas_frame.is_some() {
        ensure_canvas_destination(state, pivot_id, dest)
    } else {
        crate::sheets::ensure_not_canvas_in_state(state, dest, GRID_PIVOT_CANVAS_ACTION)
    }
}

/// Clears the old pivot region and writes the new view to the grid.
/// Also syncs to state.grid if needed.
///
/// `framed` is the pivot's `definition.canvas_frame.is_some()`, passed in by
/// the caller rather than read here: some callers write BEFORE the definition
/// is in `pivot_tables` (the `.calp` refresh writes in its phase B and inserts
/// the definitions in phase C), and some hold definitions that are not the
/// stored ones.
///
/// `Err` -- having written NOTHING -- when the destination is the wrong kind
/// for the pivot (a grid pivot on a canvas, a canvas pivot on a worksheet) or
/// when a canvas pivot's view is wider than its block. Every caller must then
/// skip what follows a successful write: `update_pivot_region` (which would
/// move the pivot's protection off its real cells), `store_view`, and the undo
/// record.
pub(crate) fn update_pivot_in_grid(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    pivot_id: PivotId,
    dest_sheet_idx: usize,
    destination: (u32, u32),
    view: &PivotView,
    framed: bool,
) -> Result<(), String> {
    // THE KIND RULE, at the one funnel every pivot write passes. A GRID pivot
    // never materializes into a canvas's hidden grid: its cells would be real
    // (formulas could read them) and invisible (a canvas paints no cells). A
    // CANVAS pivot never materializes anywhere else, and never wider than its
    // block. The creation doors and `ensure_pivot_destination_writable` refuse
    // up front; this catches the rest (a destination that changed after that
    // check, or a caller with no pre-check). Read ALONE, before any other lock.
    let kind_check = if framed {
        ensure_canvas_destination(state, pivot_id, dest_sheet_idx)
            .and_then(|()| ensure_canvas_pivot_fits_block(pivot_id, destination, view))
    } else {
        crate::sheets::ensure_not_canvas_in_state(state, dest_sheet_idx, GRID_PIVOT_CANVAS_ACTION)
    };
    if let Err(refusal) = kind_check {
        log_warn!(
            "PIVOT",
            "pivot {:?} (framed={}) not written to sheet {}: {}",
            pivot_id,
            framed,
            dest_sheet_idx,
            refusal
        );
        return Err(refusal);
    }

    // Get old region before writing new data
    let old_region = get_pivot_region(state, pivot_id);

    // CANONICAL LOCK ORDER: `grid`, then `grids`, then everything else
    // (the style registry included). The recalculation pass holds both grid
    // locks and then takes `style_registry` on a background thread.
    let mut active_grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut styles = state.style_registry.write(effect).unwrap();
    if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
        // Clear old pivot area first if it exists
        if let Some(ref region) = old_region {
            if region.sheet_index == dest_sheet_idx {
                clear_pivot_region_from_grid(
                    dest_grid,
                    region.start_row,
                    region.start_col,
                    region.end_row,
                    region.end_col,
                );
            }
        }

        // Check if this is the active sheet — if so, write to both grids in one pass
        let active_sheet = *state.active_sheet.read().unwrap();
        let is_active = dest_sheet_idx == active_sheet;

        let pivot_merges = if is_active {
            // Clear old region from active grid too
            if let Some(ref region) = old_region {
                if region.sheet_index == dest_sheet_idx {
                    active_grid.clear_region(
                        region.start_row,
                        region.start_col,
                        region.end_row,
                        region.end_col,
                    );
                }
            }

            // Single-pass write to both grids (eliminates second iteration + clones)
            let merges = write_pivot_to_grid(dest_grid, Some(&mut active_grid), view, destination, &mut styles);
            active_grid.recalculate_bounds();
            log_debug!("PIVOT", "wrote pivot to both grids in single pass (active sheet)");
            merges
        } else {
            // Not the active sheet — write to sheet grid only
            write_pivot_to_grid(dest_grid, None, view, destination, &mut styles)
        };
        let (dest_row, dest_col) = destination;
        let new_end_row = dest_row + view.row_count.max(1) as u32 - 1;
        let new_end_col = dest_col + view.col_count.max(1) as u32 - 1;

        // THE DESTINATION SHEET'S merge set: `merged_regions` is the ACTIVE
        // sheet's mirror, so a pivot on any other sheet (a canvas pivot
        // refiltered by a slicer while the user is on Sheet1, or any
        // cross-sheet pivot) used to put its merges on the sheet the user was
        // looking at -- merging cells there that the pivot never wrote -- and
        // leave its own sheet unmerged. `with_sheet_merges_mut` picks the
        // mirror or `all_merged_regions[dest]`. Taken after grid -> grids ->
        // styles, as before.
        crate::report::with_sheet_merges_mut(state, effect, dest_sheet_idx, |merged| {
            // Remove merges in old pivot region (only when it was on this
            // sheet -- the cells were cleared under the same condition above).
            if let Some(ref region) = old_region {
                if region.sheet_index == dest_sheet_idx {
                    merged.retain(|m| {
                        !(m.start_row >= region.start_row && m.end_row <= region.end_row
                            && m.start_col >= region.start_col && m.end_col <= region.end_col)
                    });
                }
            }
            // Also remove merges in new pivot region (in case of overlap)
            merged.retain(|m| {
                !(m.start_row >= dest_row && m.end_row <= new_end_row
                    && m.start_col >= dest_col && m.end_col <= new_end_col)
            });

            // Add new pivot merge regions
            for mr in pivot_merges {
                merged.insert(mr);
            }
        });
    }
    Ok(())
}

/// Auto-fit column widths for a pivot table based on cell content.
/// Scans all visible cells in the view and sets each column width to fit
/// the longest formatted value, using a character-based width estimate.
///
/// RETURNS WHAT IT OVERWROTE, and that return value is not decoration.
///
/// This function writes straight into `column_widths` / `all_column_widths`,
/// which are persisted document state, and for the whole life of the pivot
/// feature it recorded NOTHING on the undo stack. So undoing a pivot change put
/// the pivot back and left the columns at their pivot-fitted width for ever —
/// ledgered as BUG-0014 and, worse, SUPPRESSED in the undo oracle behind a
/// blanket `sheets[0].colWidths.` / `sheets[1].colWidths.` prefix, which hid
/// every OTHER column-width undo defect on the first two sheets along with it.
///
/// The caller records the returned previous values in the SAME undo transaction
/// as the pivot mutation that caused the fit (`record_pivot_definition_undo`),
/// because Excel undoes a pivot field change and its column resize as one step,
/// not two.
///
/// `None` for a column means "there was no explicit width" — the restore has to
/// REMOVE the entry rather than write a default, or the column comes back
/// pinned at a width the user never set.
pub(crate) fn auto_fit_pivot_columns(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    dest_sheet_idx: usize,
    destination: (u32, u32),
    view: &PivotView,
) -> Vec<(u32, Option<f64>)> {
    if view.col_count == 0 || view.row_count == 0 {
        return Vec::new();
    }

    let (_dest_row, dest_col) = destination;

    // Approximate pixel width per character (Segoe UI ~12px font).
    // Average character width for proportional text is ~6.2px at 12px font size.
    // The renderer uses CELL_PADDING_X = 6 on each side (12px total).
    const CHAR_WIDTH: f64 = 6.2;
    const CELL_PADDING: f64 = 12.0;
    const MIN_WIDTH: f64 = 40.0;
    const MAX_WIDTH: f64 = 400.0;

    // Find max display text length per column, including formatted numbers
    let mut max_len: Vec<usize> = vec![0; view.col_count];

    for (row_idx, row_desc) in view.rows.iter().enumerate() {
        if !row_desc.visible {
            continue;
        }
        if row_idx >= view.cells.len() {
            continue;
        }
        let row_cells = &view.cells[row_idx];
        for (col_idx, cell) in row_cells.iter().enumerate() {
            if col_idx >= max_len.len() {
                break;
            }
            // Get the display text: use formatted number if available,
            // fall back to formatted_value, then raw number string
            let display = if let Some(ref fmt) = cell.number_format {
                if !fmt.is_empty() {
                    if let pivot_engine::PivotCellValue::Number(n) = &cell.value {
                        engine::format_number(*n, &parse_number_format(fmt), &engine::LocaleSettings::invariant())
                    } else {
                        cell.formatted_value.clone()
                    }
                } else {
                    cell.formatted_value.clone()
                }
            } else if cell.formatted_value.is_empty() {
                // No number format and no formatted_value: use raw value string
                match &cell.value {
                    pivot_engine::PivotCellValue::Number(n) => {
                        // Format integers without decimal point
                        if n.fract() == 0.0 && n.abs() < 1e15 {
                            format!("{}", *n as i64)
                        } else {
                            format!("{}", n)
                        }
                    }
                    _ => cell.formatted_value.clone(),
                }
            } else {
                cell.formatted_value.clone()
            };
            let len = display.len();
            // Account for indent in compact layout (~20px per level = ~3.2 chars)
            let extra = (cell.indent_level as usize) * 3
                + if cell.is_expandable { 3 } else { 0 };
            let effective_len = len + extra;
            if effective_len > max_len[col_idx] {
                max_len[col_idx] = effective_len;
            }
        }
    }

    // Apply column widths to the DESTINATION sheet's store — the active-sheet
    // mirror only when the pivot's sheet IS the active one. (Writing the
    // mirror unconditionally resized whatever sheet the user was LOOKING at:
    // e.g. a subscribed pivot rendering on its own appended sheet resized the
    // subscriber's original sheet.)
    let fitted: Vec<(u32, f64)> = max_len
        .iter()
        .enumerate()
        .map(|(col_idx, &char_len)| {
            let grid_col = dest_col + col_idx as u32;
            let width = ((char_len as f64) * CHAR_WIDTH + CELL_PADDING)
                .max(MIN_WIDTH)
                .min(MAX_WIDTH);
            (grid_col, width)
        })
        .collect();
    let active = *state.active_sheet.read().unwrap();
    let mut previous: Vec<(u32, Option<f64>)> = Vec::with_capacity(fitted.len());
    if dest_sheet_idx == active {
        let mut widths = state.column_widths.write(effect).unwrap();
        for (col, w) in fitted {
            previous.push((col, widths.insert(col, w)));
        }
    } else {
        let mut all = state.all_column_widths.write(effect).unwrap();
        while all.len() <= dest_sheet_idx {
            all.push(std::collections::HashMap::new());
        }
        for (col, w) in fitted {
            previous.push((col, all[dest_sheet_idx].insert(col, w)));
        }
    }

    log_debug!(
        "PIVOT",
        "auto_fit_pivot_columns: set {} column widths (cols {}..{})",
        view.col_count,
        dest_col,
        dest_col + view.col_count as u32 - 1
    );

    previous
}

/// Looks up a value in a pivot table for GETPIVOTDATA.
/// Searches all pivot tables to find the one containing the referenced cell ON
/// THE REFERENCED SHEET, then queries it for the matching aggregated value.
///
/// `pivot_sheet` is the sheet the reference names (the formula's own sheet
/// when unqualified; `None` only with no multi-sheet context, where any pivot
/// at the cell answers). It is compared case-insensitively with the pivot's
/// destination sheet: the lexer upper-cases a bare sheet qualifier. A pivot
/// with no recorded destination sheet matches any sheet, as before.
///
/// Uses each data cell's `group_path` (which contains both row and column
/// field values) to match against the requested field/item pairs.
pub fn lookup_pivot_data(
    pivot_tables: &HashMap<PivotId, (PivotDefinition, PivotCache)>,
    pivot_views: &HashMap<PivotId, PivotView>,
    data_field: &str,
    pivot_sheet: Option<&str>,
    pivot_row: u32,
    pivot_col: u32,
    field_item_pairs: &[(&str, &str)],
) -> Option<f64> {
    let wanted_sheet = pivot_sheet.map(str::to_lowercase);
    // Find which pivot table contains the referenced cell
    let (pivot_id, view) = pivot_views.iter().find(|(_id, v)| {
        if let Some((def, _cache)) = pivot_tables.get(_id) {
            let on_sheet = match (&wanted_sheet, def.destination_sheet.as_deref()) {
                (Some(wanted), Some(dest)) => *wanted == dest.to_lowercase(),
                _ => true,
            };
            if !on_sheet {
                return false;
            }
            let (dest_row, dest_col) = def.destination;
            let end_row = dest_row + v.row_count as u32;
            let end_col = dest_col + v.col_count as u32;
            pivot_row >= dest_row && pivot_row < end_row
                && pivot_col >= dest_col && pivot_col < end_col
        } else {
            false
        }
    })?;

    let (definition, cache) = pivot_tables.get(pivot_id)?;

    // Find the value field by name (case-insensitive)
    let data_field_lower = data_field.to_lowercase();
    let vf_idx = definition.value_fields.iter().position(|vf| {
        vf.name.to_lowercase() == data_field_lower
    })?;

    // If no field/item pairs, return the grand total for this value field
    if field_item_pairs.is_empty() {
        for row_cells in &view.cells {
            for cell in row_cells {
                if cell.cell_type == pivot_engine::PivotCellType::GrandTotal {
                    if cell.value_field_index == Some(vf_idx) || definition.value_fields.len() == 1 {
                        if let pivot_engine::PivotCellValue::Number(n) = cell.value {
                            return Some(n);
                        }
                    }
                }
            }
        }
        return None;
    }

    // Build a field name lookup: source_index -> field name (from row and column fields)
    let mut field_name_by_index: HashMap<usize, String> = HashMap::new();
    for f in &definition.row_fields {
        field_name_by_index.insert(f.source_index, f.name.clone());
    }
    for f in &definition.column_fields {
        field_name_by_index.insert(f.source_index, f.name.clone());
    }

    // Search ALL data cells in the view for one whose group_path matches
    // all the requested field/item pairs AND the correct value field.
    for row_cells in &view.cells {
        for cell in row_cells {
            // Only consider data-area cells with a value_field_index
            let cell_vf = match cell.value_field_index {
                Some(idx) => idx,
                None => continue,
            };
            if cell_vf != vf_idx {
                continue;
            }

            // Check if this cell's group_path matches ALL field/item pairs
            let all_match = field_item_pairs.iter().all(|(req_field, req_item)| {
                cell.group_path.iter().any(|&(field_index, value_id)| {
                    // Get field name for this group_path entry
                    let field_name = field_name_by_index.get(&field_index)
                        .cloned()
                        .or_else(|| cache.field_name(field_index))
                        .unwrap_or_default();

                    if !field_name.eq_ignore_ascii_case(req_field) {
                        return false;
                    }

                    // Get value label and compare
                    let value_label = cache.get_value_label(field_index, value_id)
                        .unwrap_or_default();
                    value_label.eq_ignore_ascii_case(req_item)
                })
            });

            if all_match {
                if let pivot_engine::PivotCellValue::Number(n) = cell.value {
                    return Some(n);
                }
            }
        }
    }

    None
}

/// Resolves a grid cell position into GETPIVOTDATA formula arguments.
/// Returns None if the cell is not a data cell in any pivot table.
pub fn resolve_pivot_data_formula(
    pivot_tables: &HashMap<PivotId, (PivotDefinition, PivotCache)>,
    pivot_views: &HashMap<PivotId, PivotView>,
    grid_row: u32,
    grid_col: u32,
) -> Option<super::types::GetPivotDataFormulaResult> {
    // Find which pivot table contains this cell
    let (pivot_id, view) = pivot_views.iter().find(|(_id, v)| {
        if let Some((def, _)) = pivot_tables.get(_id) {
            let (dest_row, dest_col) = def.destination;
            let end_row = dest_row + v.row_count as u32;
            let end_col = dest_col + v.col_count as u32;
            grid_row >= dest_row && grid_row < end_row
                && grid_col >= dest_col && grid_col < end_col
        } else {
            false
        }
    })?;

    let (definition, cache) = pivot_tables.get(pivot_id)?;
    let (dest_row, dest_col) = definition.destination;

    // Get the view cell at this position
    let view_row = (grid_row - dest_row) as usize;
    let view_col = (grid_col - dest_col) as usize;

    let row_cells = view.cells.get(view_row)?;
    let cell = row_cells.get(view_col)?;

    // Only generate GETPIVOTDATA for data cells (including subtotals and grand totals)
    let is_data_cell = matches!(
        cell.cell_type,
        pivot_engine::PivotCellType::Data
            | pivot_engine::PivotCellType::RowSubtotal
            | pivot_engine::PivotCellType::ColumnSubtotal
            | pivot_engine::PivotCellType::GrandTotalRow
            | pivot_engine::PivotCellType::GrandTotalColumn
            | pivot_engine::PivotCellType::GrandTotal
    );
    if !is_data_cell {
        return None;
    }

    // Get the value field name
    let vf_idx = cell.value_field_index.unwrap_or(0);
    let data_field = definition
        .value_fields
        .get(vf_idx)
        .map(|vf| vf.name.clone())
        .unwrap_or_default();

    // Build field/item pairs from the cell's group_path
    let mut field_item_pairs: Vec<(String, String)> = Vec::new();
    for &(field_index, value_id) in &cell.group_path {
        // Get the field name from the definition (check row fields, then column fields)
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
            .unwrap_or_else(|| {
                cache
                    .field_name(field_index)
                    .unwrap_or_else(|| format!("Field{}", field_index + 1))
            });

        // Get the item value from the cache
        let item_value = cache
            .get_value_label(field_index, value_id)
            .unwrap_or_default();

        field_item_pairs.push((field_name, item_value));
    }

    Some(super::types::GetPivotDataFormulaResult {
        data_field,
        field_item_pairs,
    })
}

// ============================================================================
// FINALIZE PIVOT UPDATE (grid write + region update + formula recalc)
// ============================================================================

/// Counts non-empty cells in the new pivot region that lie OUTSIDE the current
/// (old) pivot region.  These are user-owned cells that the pivot would
/// overwrite.  Must be called BEFORE `update_pivot_in_grid` writes to the grid.
pub(crate) fn count_overwritten_cells(
    state: &AppState,
    pivot_id: PivotId,
    dest_sheet_idx: usize,
    destination: (u32, u32),
    view: &PivotView,
) -> u32 {
    if view.row_count == 0 || view.col_count == 0 {
        return 0;
    }

    let (dest_row, dest_col) = destination;
    // Only count visible rows – collapsed rows are not written to the grid
    let visible_row_count = view.rows.iter().filter(|r| r.visible).count() as u32;
    if visible_row_count == 0 {
        return 0;
    }
    let new_end_row = dest_row + visible_row_count - 1;
    let new_end_col = dest_col + view.col_count as u32 - 1;

    let old_region = get_pivot_region(state, pivot_id);

    let grids = state.grids.read().unwrap();
    let grid = match grids.get(dest_sheet_idx) {
        Some(g) => g,
        None => return 0,
    };

    let mut count = 0u32;
    for row in dest_row..=new_end_row {
        for col in dest_col..=new_end_col {
            // Skip cells inside the old pivot region – those belong to the pivot
            if let Some(ref old) = old_region {
                if row >= old.start_row && row <= old.end_row
                    && col >= old.start_col && col <= old.end_col
                {
                    continue;
                }
            }
            if let Some(cell) = grid.get_cell(row, col) {
                if !matches!(cell.value, CellValue::Empty) {
                    count += 1;
                }
            }
        }
    }

    count
}

/// A single saved cell: (row, col, cell_data).
/// Uses a flat struct instead of HashMap<(u32, u32), Cell> because serde_json
/// cannot serialize non-string map keys.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct SavedCell {
    pub row: u32,
    pub col: u32,
    pub cell: Cell,
}

/// Save cells that would be overwritten by a pivot expansion.
/// Returns a list of (row, col, cell) for cells outside the old pivot region
/// that have non-empty values.  Used by the undo system to restore these cells
/// when the user cancels the overwrite.
pub(crate) fn save_overwritten_cells(
    state: &AppState,
    pivot_id: PivotId,
    dest_sheet_idx: usize,
    destination: (u32, u32),
    view: &PivotView,
) -> Vec<SavedCell> {
    let mut saved = Vec::new();
    if view.row_count == 0 || view.col_count == 0 {
        return saved;
    }

    let (dest_row, dest_col) = destination;
    let visible_row_count = view.rows.iter().filter(|r| r.visible).count() as u32;
    if visible_row_count == 0 {
        return saved;
    }
    let new_end_row = dest_row + visible_row_count - 1;
    let new_end_col = dest_col + view.col_count as u32 - 1;

    let old_region = get_pivot_region(state, pivot_id);

    let grids = state.grids.read().unwrap();
    let grid = match grids.get(dest_sheet_idx) {
        Some(g) => g,
        None => return saved,
    };

    for row in dest_row..=new_end_row {
        for col in dest_col..=new_end_col {
            // Skip cells inside the old pivot region
            if let Some(ref old) = old_region {
                if row >= old.start_row && row <= old.end_row
                    && col >= old.start_col && col <= old.end_col
                {
                    continue;
                }
            }
            if let Some(cell) = grid.get_cell(row, col) {
                if !matches!(cell.value, CellValue::Empty) {
                    saved.push(SavedCell { row, col, cell: cell.clone() });
                }
            }
        }
    }

    saved
}

/// Everything a pivot write needs to reach the ONE shared cascade
/// (`recalc_after_active_sheet_bulk_rewrite` / `recalc_after_off_sheet_write`):
/// the control stores for GET.CONTROLVALUE and the user files for formulas that
/// read them. A command builds it from its own `State` handles; `None` in its
/// place (unit tests with no command around them) keeps the old active-sheet
/// pass.
#[derive(Clone, Copy)]
pub(crate) struct PivotRecalcStates<'a> {
    pub(crate) pane: &'a crate::pane_control::PaneControlState,
    pub(crate) ribbon: &'a crate::ribbon_filter::RibbonFilterState,
    pub(crate) user_files: &'a crate::persistence::UserFilesState,
}

/// Recalculate what reads a pivot block that was just (re)written on
/// `dest_sheet_idx`: the new rectangle PLUS the old one (a pivot that shrank or
/// moved leaves emptied cells behind, and a formula reading one of those is
/// exactly the reader that must drop to 0), seeded into the shared cascade with
/// the same two-branch shape `create_pivot_core` uses.
///
/// THE DEFECT THIS CLOSES. Every pivot mutation used to end in
/// `recalculate_sheet_formulas`, which re-evaluates the ACTIVE sheet only. A
/// pivot on any other sheet -- a canvas pivot refiltered by a slicer while the
/// user is on Sheet1, or the user on the canvas while Sheet1's
/// `='Canvas1'!C5` reads it -- left every reader on every other sheet stale.
///
/// GETPIVOTDATA: the active-sheet cascade evaluates with no pivot lookup wired
/// (`reevaluate_formula_cell` / `recalc_walked_cell` pass none), so every
/// GETPIVOTDATA it reaches -- on the active sheet AND on any sheet reading it
/// across a sheet boundary -- comes out of it as #REF!. On that branch the
/// cascade is therefore followed by `recalc_after_off_sheet_write(&[dest])`,
/// which re-evaluates the active sheet and every sheet that reads it through
/// `recalculate_sheet_values`, where the lookup IS wired: the pass ends on the
/// pivot's numbers. (Running only the active sheet's whole-sheet pass here --
/// the first version of this fix -- left Sheet2's `=GETPIVOTDATA(..;
/// Sheet1!E1)` at #REF!, where the old active-only pass had at least left it
/// alone; `a_cross_sheet_getpivotdata_survives_a_write_to_a_pivot_on_the_
/// active_sheet` pins it.) The off-sheet branch is that same call alone.
///
/// LOCKS: the caller must hold NONE (both cascade entry points take their own).
pub(crate) fn recalc_after_pivot_write(
    state: &AppState,
    pivot_state: &PivotState,
    states: Option<PivotRecalcStates<'_>>,
    dest_sheet_idx: usize,
    old_region: Option<&ProtectedRegion>,
    destination: (u32, u32),
    view: &PivotView,
) {
    let Some(states) = states else {
        recalculate_sheet_formulas(state, pivot_state, None);
        return;
    };
    let mut seeds = crate::pivot::commands::pivot_block_seeds(destination, view.row_count, view.col_count);
    if let Some(old) = old_region.filter(|r| r.sheet_index == dest_sheet_idx) {
        let new_block: std::collections::HashSet<(u32, u32)> = seeds.iter().copied().collect();
        for r in old.start_row..=old.end_row {
            for c in old.start_col..=old.end_col {
                if !new_block.contains(&(r, c)) {
                    seeds.push((r, c));
                }
            }
        }
    }
    let active_sheet = *state.active_sheet.read().unwrap();
    if dest_sheet_idx == active_sheet {
        let mut recalculated = Vec::new();
        crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
            state,
            states.user_files,
            states.pane,
            states.ribbon,
            &seeds,
            &mut recalculated,
        );
        // GETPIVOTDATA repair pass (see above): the active sheet and every
        // sheet reading it, re-evaluated WITH the pivot lookup.
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            states.user_files,
            pivot_state,
            states.pane,
            states.ribbon,
            &[dest_sheet_idx],
        );
    } else {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            states.user_files,
            pivot_state,
            states.pane,
            states.ribbon,
            &[dest_sheet_idx],
        );
    }
}

/// Combined helper that writes pivot cells to the grid, updates the protected
/// region, and recalculates every formula that reads the pivot's block -- on
/// ANY sheet, through the shared cascade (see [`recalc_after_pivot_write`]).
///
/// NOTE: This function does NOT compute the overwrite count.  Callers that
/// need it (Tauri commands) should call `count_overwritten_cells` **before**
/// this function — while `state.grids` is not yet locked.
///
/// Every pivot command that modifies cell values should call this instead of
/// calling `update_pivot_in_grid` + `update_pivot_region` separately.
///
/// The pivot's frame is read here from `pivot_tables`, taken ALONE before the
/// write: no caller holds it (the recalculation below takes it, and it is an
/// exclusive lock), and every caller has already put the definition it is
/// rendering into the store.
///
/// `Err` when the write was refused (the destination is the wrong kind for
/// the pivot, or a canvas pivot is wider than its block): nothing was written,
/// the region was NOT moved, and nothing was recalculated. Commands propagate
/// it with `?`, which also skips their `store_view` / undo record.
pub(crate) fn finalize_pivot_update(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    pivot_state: &PivotState,
    pivot_id: PivotId,
    dest_sheet_idx: usize,
    destination: (u32, u32),
    view: &PivotView,
    recalc_states: Option<PivotRecalcStates<'_>>,
) -> Result<(), String> {
    let framed = pivot_is_framed(pivot_state, pivot_id);
    let old_region = get_pivot_region(state, pivot_id);
    update_pivot_in_grid(state, effect, pivot_id, dest_sheet_idx, destination, view, framed)?;
    update_pivot_region(state, pivot_id, dest_sheet_idx, destination, view);
    recalc_after_pivot_write(
        state,
        pivot_state,
        recalc_states,
        dest_sheet_idx,
        old_region.as_ref(),
        destination,
        view,
    );
    Ok(())
}

/// Re-evaluate all formula cells on the active sheet when calculation mode is
/// "automatic".  This is intentionally a full-sheet recalculation (like the
/// Ctrl+= "Calculate Now" command) to keep the implementation simple.  Pivot
/// operations are infrequent enough that the cost is negligible.
pub(crate) fn recalculate_sheet_formulas(
    state: &AppState,
    pivot_state: &PivotState,
    control_states: Option<(&crate::pane_control::PaneControlState, &crate::ribbon_filter::RibbonFilterState)>,
) {
    // BACKGROUND: a pivot refresh triggers a sheet recalculation the user did
    // not personally start. It WRITES CELLS, so it gets the same fuel an
    // interactive edit does (see EvalSurface), and it is cancellable.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    // Only recalculate in automatic mode
    {
        let calc_mode = state.calculation_mode.lock().unwrap();
        if *calc_mode != "automatic" {
            return;
        }
    }

    // GET.CONTROLVALUE snapshot: built BEFORE the grid locks below (canonical
    // lock order). None (states unreachable at the call site) => those
    // formulas evaluate to #N/A for this pass (v1).
    let control_values =
        crate::control_values::build_control_values_from_states(state, control_states);

    // RECALC COMPANION. This pass re-derives cell VALUES from inputs that are
    // themselves persisted (formulas, literals, locale, control values), so it
    // must not dirty on its own account: the ENTRY command that made those
    // values stale already owns the flag, and dirtying here would make a
    // workbook holding NOW()/RAND() prompt to save merely for being looked at.
    // See CleanReason::RecalcCompanion.
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::RecalcCompanion,
    );
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    // Build pivot data lookup closure for GETPIVOTDATA evaluation
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let pivot_views = pivot_state.views.lock().unwrap();
    let pivot_data_fn = |data_field: &str, pivot_sheet: Option<&str>, pivot_row: u32, pivot_col: u32, pairs: &[(&str, &str)]| -> Option<f64> {
        lookup_pivot_data(&pivot_tables, &pivot_views, data_field, pivot_sheet, pivot_row, pivot_col, pairs)
    };

    // Collect all cells with formulas on the active sheet
    let formula_cells: Vec<_> = grid
        .cells
        .iter()
        .filter_map(|(&(row, col), cell)| {
            cell.formula_string().map(|f| (row, col, f))
        })
        .collect();

    if formula_cells.is_empty() {
        return;
    }

    let tables_map = state.tables.read().unwrap();
    let table_names_map = state.table_names.read().unwrap();
    let named_ranges_map = state.named_ranges.read().unwrap();
    let row_heights = state.row_heights.read().unwrap();
    let column_widths = state.column_widths.read().unwrap();

    // Empty user files map — pivot recalc doesn't need external file references
    let empty_user_files: HashMap<String, Vec<u8>> = HashMap::new();

    for (row, col, formula) in formula_cells {
        let eval_ctx = engine::EvalContext {
            cube_prefetch: None,
            current_row: Some(row),
            current_col: Some(col),
            row_heights: Some(row_heights.clone()),
            column_widths: Some(column_widths.clone()),
            hidden_rows: None,
            control_values: control_values.clone(),
        };

        let result = match parser::parse(&formula) {
            Ok(parsed) => {
                let resolved = if crate::ast_has_named_refs(&parsed) {
                    let mut visited = std::collections::HashSet::new();
                    crate::resolve_names_in_ast(&parsed, &named_ranges_map, active_sheet, &mut visited)
                } else {
                    parsed
                };

                let resolved = if crate::ast_has_table_refs(&resolved) {
                    let ctx = crate::TableRefContext {
                        tables: &tables_map,
                        table_names: &table_names_map,
                        sheet_names: &sheet_names,
                        current_sheet_index: active_sheet,
                        current_row: row,
                        current_col: col,
                    };
                    crate::resolve_table_refs_in_ast(&resolved, &ctx)
                } else {
                    resolved
                };

                let engine_ast = crate::convert_expr(&resolved);
                crate::evaluate_formula_with_pivot(
                    &grids,
                    &sheet_names,
                    active_sheet,
                    &engine_ast,
                    eval_ctx,
                    Some(&styles),
                    &empty_user_files,
                    Some(&pivot_data_fn),
                    // GATHER lookup is not threaded into pivot-internal recalc;
                    // GATHER cells refresh through update_cell/calculate_now.
                    None,
                )
            }
            Err(_) => CellValue::Error(engine::CellError::Value),
        };

        if let Some(cell) = grid.get_cell(row, col) {
            let mut updated = cell.clone();
            updated.value = result;
            grid.set_cell(row, col, updated.clone());

            // Keep grids vector in sync
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, col, updated);
            }
        }
    }
}