//! FILENAME: app/src-tauri/src/pivot/headless.rs
//! Headless "design query" execution.
//!
//! Runs a BI query straight from a compiled design-query spec and returns a
//! `PivotViewResponse` WITHOUT materializing anything into the grid or
//! persisting a pivot table. This powers chart "design query" data sources
//! (the data lives in the chart object, not in a pivot), and is intended to
//! also back paginated grid reports later.
//!
//! It reuses the same lower-level compute helpers as `update_bi_pivot_fields`
//! (`build_cache_from_arrow_batches`, `safe_calculate_pivot`, `view_to_response`,
//! `expand_bi_value_fields`, RLS via `apply_connection_role`) but skips the giant
//! pivot state / grid-write wrapper. Returning a `PivotViewResponse` lets the
//! frontend chart reader reuse the existing pivot→chart extraction verbatim.
//!
//! v1 supports the common design-query subset: ROWS, COLUMNS, VALUES, FILTERS
//! (via hidden-items), CALC. LOOKUP columns, hierarchies, calculation groups,
//! and measure-less / dimension-less queries are rejected with a clear message
//! and will be added in later slices.

use std::collections::HashMap;
use std::time::Duration;
use tauri::State;

use crate::bi::types::{BiState, ConnectionId};
use crate::pivot::commands::{expand_bi_value_fields, extract_bi_model_metadata};
use crate::pivot::operations::{build_cache_from_arrow_batches, safe_calculate_pivot};
use crate::pivot::types::{
    BiFieldRef, BiPivotModelInfo, BiValueFieldRef, CalculatedFieldDef, LayoutConfig,
    PivotViewResponse, ValueColumnRefDef,
};
use crate::pivot::utils::{apply_layout_config, view_to_response};

/// Return the BI model (tables / columns / measures / hierarchies / calc groups)
/// for a connection, in the same `BiPivotModelInfo` shape a pivot exposes. Used
/// by the chart "design query" editor + reader to build a DSL compile context
/// WITHOUT there being a pivot. Returns `None` if the connection has no model.
#[tauri::command]
pub async fn get_connection_bi_model(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
) -> Result<Option<BiPivotModelInfo>, String> {
    let engine_arc = {
        let connections = bi_state
            .connections
            .lock()
            .map_err(|e| format!("connections lock poisoned: {}", e))?;
        match connections.get(&connection_id) {
            Some(conn) => conn.engine.clone(),
            None => return Ok(None),
        }
    };
    let engine_arc = match engine_arc {
        Some(arc) => arc,
        None => return Ok(None),
    };
    let engine = engine_arc.lock().await;
    let (tables, measures, hierarchies, calculation_groups, perspectives, cultures) =
        extract_bi_model_metadata(&engine);
    Ok(Some(BiPivotModelInfo {
        connection_id,
        tables,
        measures,
        lookup_columns: Vec::new(),
        hierarchies,
        calculation_groups,
        applied_calculation_group: None,
        data_as_of: None,
        perspectives,
        // Connection-level metadata has no pivot, hence no selection.
        selected_perspective: None,
        cultures,
    }))
}

/// A compiled design-query spec. Mirrors the field-assignment subset of
/// `UpdateBiPivotFieldsRequest` but carries a `connectionId` (there is no pivot).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignQueryRequest {
    /// The BI connection whose model this query runs against.
    pub connection_id: ConnectionId,
    #[serde(default)]
    pub row_fields: Vec<BiFieldRef>,
    #[serde(default)]
    pub column_fields: Vec<BiFieldRef>,
    #[serde(default)]
    pub value_fields: Vec<BiValueFieldRef>,
    #[serde(default)]
    pub filter_fields: Vec<BiFieldRef>,
    #[serde(default)]
    pub calculated_fields: Option<Vec<CalculatedFieldDef>>,
    #[serde(default)]
    pub value_column_order: Option<Vec<ValueColumnRefDef>>,
    #[serde(default)]
    pub layout: Option<LayoutConfig>,
}

/// Execute a design query headlessly and return the resulting pivot view.
#[tauri::command]
pub async fn run_design_query(
    bi_state: State<'_, BiState>,
    request: DesignQueryRequest,
) -> Result<PivotViewResponse, String> {
    let (def, mut cache, view) = compute_design_query_view(&bi_state, &request).await?;
    Ok(view_to_response(&view, &def, &mut cache))
}

/// Compile + run a design query and compute its pivot view — WITHOUT writing to
/// the grid or persisting anything. Shared by `run_design_query` (charts, which
/// serialize the view to a response) and the report commands (which materialize
/// the same view into grid cells via `write_pivot_to_grid`).
pub(crate) async fn compute_design_query_view(
    bi_state: &BiState,
    request: &DesignQueryRequest,
) -> Result<
    (
        pivot_engine::PivotDefinition,
        pivot_engine::PivotCache,
        pivot_engine::PivotView,
    ),
    String,
> {
    // ---- Bounded-v1 validation -------------------------------------------
    if request.value_fields.is_empty() {
        return Err("A design query needs at least one measure (VALUES).".to_string());
    }
    if request.row_fields.is_empty() && request.column_fields.is_empty() {
        return Err("A design query needs at least one dimension (ROWS or COLUMNS).".to_string());
    }
    if request
        .row_fields
        .iter()
        .chain(request.column_fields.iter())
        .chain(request.filter_fields.iter())
        .any(|f| f.is_lookup)
    {
        return Err("LOOKUP columns are not supported in design queries yet.".to_string());
    }

    let connection_id = request.connection_id;

    // ---- Resolve the engine for this connection --------------------------
    let engine_arc = {
        let connections = bi_state
            .connections
            .lock()
            .map_err(|e| format!("connections lock poisoned: {}", e))?;
        let conn = connections
            .get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        conn.engine.clone().ok_or("No BI model loaded for this connection.")?
    };

    // ---- Gather referenced tables (dimensions + measures) ----------------
    let mut referenced_tables: Vec<String> = Vec::new();
    for f in request
        .row_fields
        .iter()
        .chain(request.column_fields.iter())
        .chain(request.filter_fields.iter())
    {
        if !referenced_tables.contains(&f.table) {
            referenced_tables.push(f.table.clone());
        }
    }
    // Add each measure's home table (usually the fact table) so it is warmed too.
    {
        let engine = engine_arc.lock().await;
        let (_tables, measures, _hier, _calc_groups, _perspectives, _cultures) =
            extract_bi_model_metadata(&engine);
        for vf in &request.value_fields {
            if let Some(m) = measures.iter().find(|m| m.name == vf.measure_name) {
                if !m.table.is_empty() && !referenced_tables.contains(&m.table) {
                    referenced_tables.push(m.table.clone());
                }
            }
        }
    }
    let table_refs: Vec<&str> = referenced_tables.iter().map(|s| s.as_str()).collect();

    // ---- Ensure the connection + tables are warm (offline-first) ---------
    let all_warm = crate::bi::commands::bi_tables_cache_warm(bi_state, connection_id, &table_refs).await;
    if !all_warm {
        crate::bi::commands::auto_connect_bi_connection(bi_state, connection_id).await?;
        crate::bi::commands::auto_bind_tables_on_connection(bi_state, connection_id, &table_refs).await?;
    }
    {
        // One-time refresh of any in-memory table never refreshed this session.
        // Non-fatal, matching update_bi_pivot_fields: not all tables are
        // in-memory (source-bound tables answer via query pushdown), so a
        // TableNotInMemory here is expected — the query below is the real
        // arbiter of whether data is reachable.
        let mut engine = engine_arc.lock().await;
        for table_name in &referenced_tables {
            if engine.needs_refresh(table_name, Duration::from_secs(0)) {
                if let Err(e) = engine.refresh_table(table_name).await {
                    crate::log_info!(
                        "PIVOT",
                        "design query: refresh_table('{}') skipped: {}",
                        table_name,
                        e
                    );
                }
            }
        }
    }

    // ---- Build the BI engine QueryRequest --------------------------------
    // Filtering is applied post-query by the pivot engine (via hidden-items on
    // the filter fields), so filter columns are included as GROUP BY, not as
    // engine filters (matching update_bi_pivot_fields).
    let query_measures: Vec<String> =
        request.value_fields.iter().map(|v| v.measure_name.clone()).collect();
    let group_fields: Vec<&BiFieldRef> = request
        .row_fields
        .iter()
        .chain(request.column_fields.iter())
        .chain(request.filter_fields.iter())
        .collect();
    let query_group_by: Vec<bi_engine::ColumnRef> = group_fields
        .iter()
        .map(|f| bi_engine::ColumnRef::new(&f.table, &f.column))
        .collect();
    let query_request = bi_engine::QueryRequest {
        measures: query_measures.clone(),
        group_by: query_group_by,
        filters: vec![],
        ..Default::default()
    };

    // ---- Run the query (with this connection's RLS role) -----------------
    let (batches, result_columns) = {
        let mut engine = engine_arc.lock().await;
        crate::bi::commands::apply_connection_role(&mut engine, bi_state, connection_id);
        engine.query_with_meta(query_request).await
    }
    .map_err(|e| format!("BI query failed: {}", e))?;

    // ---- Build the transient pivot cache + definition --------------------
    let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7()); // throwaway id — never stored
    let mut cache = build_cache_from_arrow_batches(pivot_id, &batches)?;

    // Cache column layout: [GROUP BY cols] [measure cols] [lookup cols].
    // v1 has no lookups/hierarchies/synthetic columns, so the mapping is a
    // straight enumeration of the group fields, then measures right after.
    let num_group_by = group_fields.len();
    let mut field_to_cache_idx: HashMap<(String, String), usize> = HashMap::new();
    for (i, f) in group_fields.iter().enumerate() {
        field_to_cache_idx.insert((f.table.clone(), f.column.clone()), i);
    }
    let measure_start = num_group_by;

    let field_pf = |f: &BiFieldRef| -> pivot_engine::PivotField {
        let idx = *field_to_cache_idx
            .get(&(f.table.clone(), f.column.clone()))
            .unwrap_or(&0);
        pivot_engine::PivotField::new(idx, format!("{}.{}", f.table, f.column))
    };

    let mut def = pivot_engine::PivotDefinition::new(pivot_id, (0, 0), (0, 0));
    def.row_fields = request.row_fields.iter().map(field_pf).collect();
    def.column_fields = request.column_fields.iter().map(field_pf).collect();

    // Value fields: map each measure to its engine-reported cache column.
    // No synthetic dimension on this path, so the cache offset is 0.
    let value_col_idx = crate::pivot::totals::measure_value_col_idx(&result_columns, 0);
    def.value_fields =
        expand_bi_value_fields(&request.value_fields, &[], measure_start, &value_col_idx);

    // Filter fields carry their hidden-items directly from the compiled DSL.
    def.filter_fields = request
        .filter_fields
        .iter()
        .map(|f| {
            let mut field = field_pf(f);
            field.hidden_items = f.hidden_items.clone();
            pivot_engine::PivotFilter {
                field,
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            }
        })
        .collect();

    if let Some(ref layout_config) = request.layout {
        apply_layout_config(&mut def.layout, layout_config);
    }
    if let Some(ref calc_fields) = request.calculated_fields {
        def.calculated_fields = calc_fields
            .iter()
            .map(|cf| pivot_engine::CalculatedField {
                name: cf.name.clone(),
                formula: cf.formula.clone(),
                number_format: cf.number_format.clone(),
            })
            .collect();
    }
    if let Some(ref order) = request.value_column_order {
        def.value_column_order = order
            .iter()
            .map(|r| match r {
                ValueColumnRefDef::Value { index } => pivot_engine::ValueColumnRef::Value(*index),
                ValueColumnRefDef::Calculated { index } => {
                    pivot_engine::ValueColumnRef::Calculated(*index)
                }
            })
            .collect();
    }

    // ---- Compute the view (no grid write, no persistence) ----------------
    let view = safe_calculate_pivot(&def, &mut cache);
    Ok((def, cache, view))
}
