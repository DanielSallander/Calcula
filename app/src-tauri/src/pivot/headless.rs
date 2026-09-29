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
    BiPivotModelInfo, BiValueFieldRef, CalculatedFieldDef, LayoutConfig,
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
        data_as_of: None,
        perspectives,
        // Connection-level metadata has no pivot, hence no selection.
        selected_perspective: None,
        cultures,
        // The strategy rides with the model it describes, so the report, chart
        // and pivot editors get it in the fetch they already make.
        strategy: crate::insights::describe::strategy_for_design(engine.model()),
    }))
}

/// A dimension of a design query: the field-assignment half of `BiFieldRef`
/// (table, column, lookup flag, the items to hide) plus the INCLUSION form a
/// design query can say and a pivot never stores -- `Field = ("a", "b")`.
/// Mirrored by `DesignQueryFieldRef` in
/// `app/extensions/_shared/dsl/pivotLayout/designQuery.ts`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignQueryFieldRef {
    pub table: String,
    pub column: String,
    #[serde(default)]
    pub is_lookup: bool,
    /// Items to hide (`NOT IN (...)`), on any zone.
    #[serde(default)]
    pub hidden_items: Option<Vec<String>>,
    /// Items to KEEP (`= (...)`): every other item of the field in the query's
    /// result is hidden. The frontend cannot invert it -- there is no pivot
    /// whose item list it could invert against -- so it sent nothing, and the
    /// query ran UNFILTERED (BUG-0197); the result's own items invert it here.
    #[serde(default)]
    pub included_items: Option<Vec<String>>,
}

impl DesignQueryFieldRef {
    /// True when this ref is a calculation-group placement (pseudo table).
    fn is_calc_group(&self) -> bool {
        self.table == crate::pivot::types::CALC_GROUP_TABLE
    }

    /// The items to hide, or none.
    fn hidden(&self) -> &[String] {
        self.hidden_items.as_deref().unwrap_or(&[])
    }
}

/// A compiled design-query spec. Mirrors the field-assignment subset of
/// `UpdateBiPivotFieldsRequest` but carries a `connectionId` (there is no pivot).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignQueryRequest {
    /// The BI connection whose model this query runs against.
    pub connection_id: ConnectionId,
    #[serde(default)]
    pub row_fields: Vec<DesignQueryFieldRef>,
    #[serde(default)]
    pub column_fields: Vec<DesignQueryFieldRef>,
    #[serde(default)]
    pub value_fields: Vec<BiValueFieldRef>,
    #[serde(default)]
    pub filter_fields: Vec<DesignQueryFieldRef>,
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
        .any(|f| f.is_calc_group())
    {
        return Err(
            "Calculation groups aren't supported in design queries yet. \
             Remove the calculation group from the query."
                .to_string(),
        );
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
    let group_fields: Vec<&DesignQueryFieldRef> = request
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
    // Through the shared mapper, so a design query gets the same actionable
    // security message the pivot path does ("the role chosen in \"View as\"
    // denies it …") rather than a raw engine string.
    .map_err(|e| crate::bi::commands::friendly_bi_query_error("BI query failed", &e))?;

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

    let mut def = pivot_engine::PivotDefinition::new(pivot_id, (0, 0), (0, 0));
    apply_design_query_zones(&mut def, request, &field_to_cache_idx, &cache);

    // Value fields: map each measure to its engine-reported cache column.
    // No synthetic dimension on this path, so the cache offset is 0.
    let value_col_idx = crate::pivot::totals::measure_value_col_idx(&result_columns, 0);
    def.value_fields =
        expand_bi_value_fields(&request.value_fields, &[], measure_start, &value_col_idx);

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

/// The query's ROWS, COLUMNS and FILTERS as the transient definition's
/// fields, each on its cache column (`field_to_cache_idx`), each with every
/// item filter the query says:
///
/// - `hidden_items` (`NOT IN`) on any zone. Only FILTERS carried one: a
///   ROWS / COLUMNS `NOT IN` ran with every item.
/// - `included_items` (`= (...)`): every item of the field in the query's
///   result (`cache`) that the list does not name is hidden -- the same
///   inversion the pivot editor makes when it has the field's item list, with
///   the same exact-match rule. It ran UNFILTERED (BUG-0197). The BLANK item
///   ("(blank)", a NULL member) is hidden too unless the list names it -- the
///   item list never shows it, so the inversion alone kept every blank row.
pub(crate) fn apply_design_query_zones(
    def: &mut pivot_engine::PivotDefinition,
    request: &DesignQueryRequest,
    field_to_cache_idx: &HashMap<(String, String), usize>,
    cache: &pivot_engine::PivotCache,
) {
    let field_of = |f: &DesignQueryFieldRef| -> pivot_engine::PivotField {
        let idx = *field_to_cache_idx
            .get(&(f.table.clone(), f.column.clone()))
            .unwrap_or(&0);
        let mut field = pivot_engine::PivotField::new(idx, format!("{}.{}", f.table, f.column));
        field.hidden_items = f.hidden().to_vec();
        if let Some(ref included) = f.included_items {
            for (_value_id, label) in cache.get_unique_values_for_filter(idx) {
                if !included.contains(&label) && !field.hidden_items.contains(&label) {
                    field.hidden_items.push(label);
                }
            }
            // The blank item too, unless the list names it: blanks are never
            // interned, so the item list above never shows one, and
            // `Region = ("East")` kept every row whose Region was blank (a
            // NULL member) in each total.
            let names_blank = included.iter().any(|l| pivot_engine::is_blank_item_label(l));
            if !names_blank && cache.has_blank_values(idx) {
                field.hidden_items.push(pivot_engine::BLANK_ITEM_LABEL.to_string());
            }
        }
        field
    };
    def.row_fields = request.row_fields.iter().map(field_of).collect();
    def.column_fields = request.column_fields.iter().map(field_of).collect();
    def.filter_fields = request
        .filter_fields
        .iter()
        .map(|f| pivot_engine::PivotFilter {
            field: field_of(f),
            condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
        })
        .collect();
}

#[cfg(test)]
mod design_query_filter_tests {
    use super::*;

    /// A query result as the cache holds it: Region (0), Year (1), Revenue (2).
    fn result_cache() -> pivot_engine::PivotCache {
        let mut grid = engine::grid::Grid::new();
        let rows: [[&str; 3]; 5] = [
            ["Region", "Year", "Revenue"],
            ["East", "2023", "10"],
            ["West", "2023", "20"],
            ["North", "2024", "30"],
            ["East", "2024", "40"],
        ];
        for (r, row) in rows.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                let cell = match v.parse::<f64>() {
                    Ok(n) if r > 0 => engine::Cell::new_number(n),
                    _ => engine::Cell::new_text(v.to_string()),
                };
                grid.set_cell(r as u32, c as u32, cell);
            }
        }
        crate::pivot::operations::build_cache_from_grid(&grid, (0, 0), (4, 2), true).expect("the cache").0
    }

    fn fref(table: &str, column: &str) -> DesignQueryFieldRef {
        DesignQueryFieldRef {
            table: table.to_string(),
            column: column.to_string(),
            is_lookup: false,
            hidden_items: None,
            included_items: None,
        }
    }

    fn request(rows: Vec<DesignQueryFieldRef>, filters: Vec<DesignQueryFieldRef>) -> DesignQueryRequest {
        DesignQueryRequest {
            connection_id: ConnectionId::ZERO,
            row_fields: rows,
            column_fields: Vec::new(),
            value_fields: Vec::new(),
            filter_fields: filters,
            calculated_fields: None,
            value_column_order: None,
            layout: None,
        }
    }

    fn columns() -> HashMap<(String, String), usize> {
        HashMap::from([
            (("Geo".to_string(), "Region".to_string()), 0),
            (("Time".to_string(), "Year".to_string()), 1),
        ])
    }

    fn sorted(mut items: Vec<String>) -> Vec<String> {
        items.sort();
        items
    }

    /// `FILTERS: Geo.Region = ("East")`: every other region is hidden.
    #[test]
    fn an_inclusion_filter_hides_every_item_it_does_not_name() {
        let cache = result_cache();
        let mut region = fref("Geo", "Region");
        region.included_items = Some(vec!["East".to_string()]);
        let mut def = pivot_engine::PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));

        apply_design_query_zones(&mut def, &request(vec![fref("Time", "Year")], vec![region]), &columns(), &cache);

        assert_eq!(
            sorted(def.filter_fields[0].field.hidden_items.clone()),
            vec!["North".to_string(), "West".to_string()],
            "an inclusion filter ran unfiltered"
        );
        assert_eq!(def.row_fields[0].source_index, 1, "fixture: Year is the result's second column");
    }

    /// `ROWS: Geo.Region NOT IN ("West")` hides West on the ROW field.
    #[test]
    fn a_row_fields_exclusion_list_is_applied() {
        let cache = result_cache();
        let mut region = fref("Geo", "Region");
        region.hidden_items = Some(vec!["West".to_string()]);
        let mut def = pivot_engine::PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));

        apply_design_query_zones(&mut def, &request(vec![region], Vec::new()), &columns(), &cache);

        assert_eq!(def.row_fields[0].hidden_items, vec!["West".to_string()], "a row's NOT IN ran unfiltered");
    }

    /// The end-to-end effect: the computed view of `= ("East")` totals East only.
    #[test]
    fn an_inclusion_filter_changes_the_computed_totals() {
        let mut cache = result_cache();
        let mut region = fref("Geo", "Region");
        region.included_items = Some(vec!["East".to_string()]);
        let mut def = pivot_engine::PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));
        apply_design_query_zones(&mut def, &request(vec![fref("Time", "Year")], vec![region]), &columns(), &cache);
        def.value_fields
            .push(pivot_engine::ValueField::new(2, "Revenue".to_string(), pivot_engine::AggregationType::Sum));

        let view = safe_calculate_pivot(&def, &mut cache);

        let grand_total = view
            .cells
            .iter()
            .flatten()
            .find(|c| c.cell_type == pivot_engine::PivotCellType::GrandTotal)
            .and_then(|c| match c.value {
                pivot_engine::PivotCellValue::Number(n) => Some(n),
                _ => None,
            });
        assert_eq!(
            grand_total,
            Some(50.0),
            "East is 10 + 40; every region totals 100"
        );
    }

    /// The query result with a row whose Region is BLANK (a NULL member: the
    /// BI engine's arrow nulls become `CellValue::Empty`, as an empty cell
    /// does here). East 10 + 40, West 20, blank 30.
    fn result_cache_with_a_blank_region() -> pivot_engine::PivotCache {
        let mut grid = engine::grid::Grid::new();
        let rows: [[&str; 3]; 5] = [
            ["Region", "Year", "Revenue"],
            ["East", "2023", "10"],
            ["West", "2023", "20"],
            ["", "2024", "30"],
            ["East", "2024", "40"],
        ];
        for (r, row) in rows.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                if v.is_empty() {
                    continue;
                }
                let cell = match v.parse::<f64>() {
                    Ok(n) if r > 0 => engine::Cell::new_number(n),
                    _ => engine::Cell::new_text(v.to_string()),
                };
                grid.set_cell(r as u32, c as u32, cell);
            }
        }
        crate::pivot::operations::build_cache_from_grid(&grid, (0, 0), (4, 2), true).expect("the cache").0
    }

    fn grand_total_with_region(included: &[&str]) -> Option<f64> {
        let mut cache = result_cache_with_a_blank_region();
        let mut region = fref("Geo", "Region");
        region.included_items = Some(included.iter().map(|s| s.to_string()).collect());
        let mut def = pivot_engine::PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));
        apply_design_query_zones(&mut def, &request(vec![fref("Time", "Year")], vec![region]), &columns(), &cache);
        def.value_fields
            .push(pivot_engine::ValueField::new(2, "Revenue".to_string(), pivot_engine::AggregationType::Sum));
        let view = safe_calculate_pivot(&def, &mut cache);
        view.cells
            .iter()
            .flatten()
            .find(|c| c.cell_type == pivot_engine::PivotCellType::GrandTotal)
            .and_then(|c| match c.value {
                pivot_engine::PivotCellValue::Number(n) => Some(n),
                _ => None,
            })
    }

    /// `Region = ("East")` keeps East ONLY -- not the blank members too. The
    /// inversion listed the result's interned items, and a blank is never
    /// interned, so the blank-Region rows stayed in every total.
    #[test]
    fn an_inclusion_filter_also_hides_the_blank_item() {
        assert_eq!(grand_total_with_region(&["East"]), Some(50.0), "Region = (\"East\") kept the blank-Region row");
    }

    /// Naming the blank item keeps it, whatever the case of its label.
    #[test]
    fn an_inclusion_that_names_the_blank_item_keeps_it() {
        assert_eq!(grand_total_with_region(&["East", "(blank)"]), Some(80.0), "East 50 + blank 30");
        assert_eq!(grand_total_with_region(&["(Blank)"]), Some(30.0), "the blank item alone");
    }
}
