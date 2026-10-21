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
//! (via hidden-items), CALC -- and, since CONTRACT-CANVAS 4.8, a MEASURE-ONLY
//! query (VALUES with no ROWS and no COLUMNS: a Card, Gauge or KPI), whose
//! filters run inside the engine query and whose view is one grand-total row.
//! LOOKUP columns, hierarchies, calculation groups and measure-less queries
//! are rejected with a clear message and will be added in later slices.

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
use crate::pivot::utils::{apply_layout_config, fill_group_members, view_to_response};

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
    /// The FILTER LEVEL an engine-routed filter applies at: 1 (absent) is an
    /// ordinary slicer, which a bare `CLEAR`/`RESET` removes; 2..=9 is a
    /// slicer PINNED above that range (`@api/reportFilters` carries it as
    /// `filterLevel`). Clamped to the engine's range. Only a filter that runs
    /// inside the engine query reads it -- a host-masked filter has no level.
    #[serde(default)]
    pub level: Option<u8>,
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

    fn same_column(&self, other: &DesignQueryFieldRef) -> bool {
        self.table == other.table && self.column == other.column
    }
}

/// One column of a [`DesignQueryTupleFilter`]: a model column named by its
/// table. Mirrored by the `fields` entries of `DesignQueryTupleFilter` in
/// `app/extensions/_shared/dsl/pivotLayout/designQuery.ts`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignQueryColumn {
    pub table: String,
    pub column: String,
}

/// An OR-of-AND filter (P4: a NON-rectangular cross-filter selection made on
/// another visual): keep a row whose `fields` equal, column by column, one of
/// the `tuples`. `tuples[i][j]` is the member KEY of `fields[j]` -- "" is the
/// blank member (ruling Q8). An EMPTY `tuples` keeps nothing. It always runs
/// INSIDE the engine query (`bi_engine::ScopedTupleFilter`), at `level`
/// (absent = 1, an ordinary slicer). Mirrored by `DesignQueryTupleFilter` in
/// `app/extensions/_shared/dsl/pivotLayout/designQuery.ts`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignQueryTupleFilter {
    pub fields: Vec<DesignQueryColumn>,
    #[serde(default)]
    pub tuples: Vec<Vec<String>>,
    #[serde(default)]
    pub level: Option<u8>,
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
    /// The canvas PAGE's model filters (`@api/reportFilters`, merged by the
    /// chart reader), kept apart from the query's own FILTERS: they always run
    /// INSIDE the engine query -- never a GROUP BY column, never a report's
    /// filter area -- so a non-additive measure under a slicer that keeps
    /// several items is the model's exact answer on every path.
    #[serde(default)]
    pub page_filter_fields: Vec<DesignQueryFieldRef>,
    /// The tuple (OR-of-AND) filters of a non-rectangular cross-filter
    /// selection (P4). Like `page_filter_fields` they run INSIDE the engine
    /// query; unlike them they have no host-mask fallback, so an engine
    /// refusal under one is an error, never an unfiltered answer.
    #[serde(default)]
    pub tuple_filters: Vec<DesignQueryTupleFilter>,
    #[serde(default)]
    pub calculated_fields: Option<Vec<CalculatedFieldDef>>,
    #[serde(default)]
    pub value_column_order: Option<Vec<ValueColumnRefDef>>,
    #[serde(default)]
    pub layout: Option<LayoutConfig>,
}

/// Where a design query's OWN `FILTERS` are applied.
///
/// THE DEFECT THIS SPLIT CLOSES. A grouped query used to put every FILTERS
/// column into GROUP BY and roll the groups back up host-side with SUM ("SUM
/// of pre-aggregated = identity", `expand_bi_value_fields`) -- identity only
/// when ONE group feeds each cell. Under a filter keeping two regions, an
/// AVERAGE bar read avg(East) + avg(West), a DISTINCTCOUNT double-counted, and
/// a high-cardinality slicer column (Customer) multiplied the result just to
/// roll it back up. Once page slicers reached grouped charts
/// (`@api/reportFilters`), every click on a canvas produced such numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FiltersRoute {
    /// A CHART (`run_design_query`): the filters run inside the engine query
    /// as level-tagged IN-lists. A chart draws no filter area, so nothing is
    /// lost, and every number is the model's own.
    Engine,
    /// A GRID REPORT: the filters stay GROUP BY columns placed as the pivot's
    /// filter fields, because the report renders them as its filter area
    /// (`report.rs`). A measure-only query is engine-routed either way.
    FilterArea,
}

/// Execute a design query headlessly and return the resulting pivot view.
#[tauri::command]
pub async fn run_design_query(
    state: State<'_, crate::AppState>,
    bi_state: State<'_, BiState>,
    request: DesignQueryRequest,
) -> Result<PivotViewResponse, String> {
    // The app locale for the display text and member labels (leaf lock:
    // taken, cloned and dropped before anything else).
    let display_locale = crate::pivot::utils::display_locale_of(&state);
    let (def, mut cache, view) = compute_design_query_view(&bi_state, &request).await?;
    let mut response = view_to_response(&view, &def, &mut cache, &display_locale);
    fill_group_members(&mut response, &design_query_field_keys(&def), &cache);
    Ok(response)
}

/// The `field_keys` of a design-query view: every placed field, which
/// [`apply_design_query_zones`] named "Table.Column" on its own cache column
/// (a design query places no calculation group and no synthetic field).
pub(crate) fn design_query_field_keys(def: &pivot_engine::PivotDefinition) -> Vec<(usize, String)> {
    crate::pivot::utils::placed_field_keys(def, |_| true)
}

/// What `run_bi_pivot_filtered_view` is asked (P4): a BI pivot, and the
/// selection made on OTHER visuals of its page that the pivot must show --
/// engine-routed field filters and tuple (OR-of-AND) filters.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiPivotFilteredViewRequest {
    pub pivot_id: pivot_engine::PivotId,
    #[serde(default)]
    pub page_filter_fields: Vec<DesignQueryFieldRef>,
    #[serde(default)]
    pub tuple_filters: Vec<DesignQueryTupleFilter>,
}

/// The refusal of a pivot whose grid needs more rows than one response sends.
pub(crate) const FILTERED_VIEW_WINDOWED_REFUSAL: &str =
    "This PivotTable uses more rows than one screen holds, which a visual's selection cannot filter yet.";

/// A PAINT-ONLY view of a BI pivot under a selection made on another visual
/// (P4 cross-filter): the pivot's own query -- rebuilt from its stored
/// definition exactly as a refresh rebuilds it, with its slicer filters and
/// its pinned (level 2-9) engine filters -- plus the selection, run as a
/// headless design query. It WRITES NOTHING: no pivot store, no cells, no
/// undo step, no dirty flag. The response names the REAL pivot and its
/// version for staleness pairing only; its `group_path`s index a TRANSIENT
/// cache, so the frontend keeps it out of the pivot view store and never
/// hands one to a command that acts on the real pivot.
#[tauri::command]
pub async fn run_bi_pivot_filtered_view(
    state: State<'_, crate::AppState>,
    bi_state: State<'_, BiState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    request: BiPivotFilteredViewRequest,
) -> Result<PivotViewResponse, String> {
    let display_locale = crate::pivot::utils::display_locale_of(&state);
    bi_pivot_filtered_view(&bi_state, &pivot_state, &request, &display_locale).await
}

/// The body of [`run_bi_pivot_filtered_view`], over plain references.
pub(crate) async fn bi_pivot_filtered_view(
    bi_state: &BiState,
    pivot_state: &crate::pivot::types::PivotState,
    request: &BiPivotFilteredViewRequest,
    display_locale: &engine::LocaleSettings,
) -> Result<PivotViewResponse, String> {
    let pivot_id = request.pivot_id;
    // Lock order as `refresh_bi_pivot_unrecorded`: pivot_tables, then
    // bi_metadata -- both READ, cloned, released before any engine work.
    let (real_def, bi_request, connection_id) = {
        let pivot_tables = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
        let (definition, cache) =
            pivot_tables.get(&pivot_id).ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
        let bi_meta = pivot_state.bi_metadata.read().map_err(|e| e.to_string())?;
        let meta = bi_meta.get(&pivot_id).ok_or_else(|| format!("Pivot {} is not a BI-backed pivot", pivot_id))?;
        let bi_request = crate::pivot::commands::bi_request_from_definition(pivot_id, definition, cache, meta);
        (definition.clone(), bi_request, meta.connection_id)
    };

    let mut query =
        crate::pivot::commands::design_query_from_bi_pivot(&bi_request, connection_id, &real_def.engine_filters)?;
    query.page_filter_fields.extend(request.page_filter_fields.iter().cloned());
    query.tuple_filters = request.tuple_filters.clone();

    let (mut def, mut cache, mut view) = compute_design_query_view_for_report(bi_state, &query).await?;
    // The real pivot's value formats. A format the pivot ADOPTED from the
    // model is left out of the rebuilt request (only a user override rides
    // it), and nothing on the design-query path re-adopts it -- so without
    // this a cross-filter repainted every value cell in General.
    let formats_changed = carry_value_formats(&mut def, &real_def);
    if !(def.row_fields.is_empty() && def.column_fields.is_empty()) {
        // The real pivot's LOOK: its layout and each field's display settings
        // (sort, subtotals, collapsed members, grouping), by field name. The
        // rebuilt request carries none of them ("keep current layout").
        carry_display_settings(&mut def, &real_def);
        view = safe_calculate_pivot(&def, &mut cache);
    } else if formats_changed {
        view = safe_calculate_pivot(&def, &mut cache);
    }
    let mut response = view_to_response(&view, &def, &mut cache, display_locale);
    if response.is_windowed {
        return Err(FILTERED_VIEW_WINDOWED_REFUSAL.to_string());
    }
    fill_group_members(&mut response, &design_query_field_keys(&def), &cache);
    response.pivot_id = pivot_id;
    response.version = real_def.version;
    Ok(response)
}

/// Copy each value field's EFFECTIVE number format (a user override, or one
/// adopted from the model) from `real` onto the transient `def`, matched by
/// measure name and calculation item. Returns whether anything changed.
fn carry_value_formats(def: &mut pivot_engine::PivotDefinition, real: &pivot_engine::PivotDefinition) -> bool {
    let mut changed = false;
    for vf in def.value_fields.iter_mut() {
        let Some(old) = real.value_fields.iter().find(|o| o.name == vf.name && o.calc_item == vf.calc_item) else {
            continue;
        };
        if vf.number_format != old.number_format || vf.number_format_from_model != old.number_format_from_model {
            vf.number_format = old.number_format.clone();
            vf.number_format_from_model = old.number_format_from_model;
            changed = true;
        }
    }
    changed
}

/// Copy `real`'s layout and its fields' display settings onto the transient
/// definition `def` of the same pivot, matched by field name. Each field
/// keeps its own cache column and hidden items (those are the query's).
fn carry_display_settings(def: &mut pivot_engine::PivotDefinition, real: &pivot_engine::PivotDefinition) {
    def.layout = real.layout.clone();
    let real_fields: Vec<&pivot_engine::PivotField> = real
        .row_fields
        .iter()
        .chain(real.column_fields.iter())
        .chain(real.filter_fields.iter().map(|f| &f.field))
        .collect();
    let transient = def
        .row_fields
        .iter_mut()
        .chain(def.column_fields.iter_mut())
        .chain(def.filter_fields.iter_mut().map(|f| &mut f.field));
    for field in transient {
        let Some(old) = real_fields.iter().find(|o| o.name == field.name) else { continue };
        field.sort_order = old.sort_order;
        field.show_subtotals = old.show_subtotals;
        field.collapsed = old.collapsed;
        field.collapsed_items = old.collapsed_items.clone();
        field.show_all_items = old.show_all_items;
        field.grouping = old.grouping.clone();
        field.number_format = old.number_format.clone();
    }
}

/// Compile + run a design query for a CHART and compute its pivot view --
/// WITHOUT writing to the grid or persisting anything. Its FILTERS run inside
/// the engine query ([`FiltersRoute::Engine`]).
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
    compute_design_query_view_routed(bi_state, request, FiltersRoute::Engine).await
}

/// The same for a GRID REPORT (`report.rs`), which materializes the view into
/// cells and renders the query's FILTERS as a filter area
/// ([`FiltersRoute::FilterArea`]).
pub(crate) async fn compute_design_query_view_for_report(
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
    compute_design_query_view_routed(bi_state, request, FiltersRoute::FilterArea).await
}

/// Why one attempt at a design query failed.
enum QueryFailure {
    /// The engine refused a measure that CLEARs/RESETs a filter this request
    /// sends into the engine query (`is_contested_clear_refusal`).
    ContestedClear(String),
    Other(String),
}

impl From<String> for QueryFailure {
    fn from(message: String) -> Self {
        QueryFailure::Other(message)
    }
}

impl QueryFailure {
    fn message(self) -> String {
        match self {
            QueryFailure::ContestedClear(m) | QueryFailure::Other(m) => m,
        }
    }
}

/// True for the engine's typed refusal of a measure that removes (CLEAR /
/// RESET) a filter the REQUEST carries, where it cannot thread that removal
/// through the measure: a compound measure (`DIVIDE(SUM(x), SUM(x, RESET()))`),
/// an axis-spanning clear, a column reached through an unsafe join. Each is a
/// `QueryError::InvalidQuery` whose text says the measure "clears" the
/// filter -- the variant is the type, the verb is the only discriminator the
/// engine offers between its InvalidQuery cases (model-engine-lib
/// `local_aggregation.rs`, `scoped_filters.rs`). Such a measure is exactly
/// what the host-mask route answers correctly: it evaluates with NO request
/// filter, so the clear has nothing to remove, and the mask then keeps the
/// filtered items -- exact for a share whose numerator is additive.
fn is_contested_clear_refusal(error: &bi_engine::QueryError) -> bool {
    matches!(error, bi_engine::QueryError::InvalidQuery(message) if message.contains(" clears "))
}

async fn compute_design_query_view_routed(
    bi_state: &BiState,
    request: &DesignQueryRequest,
    route: FiltersRoute,
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
    let every_field = || {
        request
            .row_fields
            .iter()
            .chain(request.column_fields.iter())
            .chain(request.filter_fields.iter())
            .chain(request.page_filter_fields.iter())
    };
    if every_field().any(|f| f.is_calc_group()) {
        return Err(
            "Calculation groups aren't supported in design queries yet. \
             Remove the calculation group from the query."
                .to_string(),
        );
    }
    if every_field().any(|f| f.is_lookup) {
        return Err("LOOKUP columns are not supported in design queries yet.".to_string());
    }
    validate_tuple_filters(request)?;

    // A MEASURE-ONLY query (no ROWS, no COLUMNS) is a Card / Gauge / KPI read
    // straight from the model, as Power BI's are (CONTRACT-CANVAS 4.8): ONE
    // engine query with an empty group-by, its filters INSIDE that query,
    // giving a view of exactly one grand-total row.
    let measure_only = request.row_fields.is_empty() && request.column_fields.is_empty();
    let group_own_filters = !measure_only && route == FiltersRoute::FilterArea;
    let engine_fields: Vec<&DesignQueryFieldRef> = request
        .page_filter_fields
        .iter()
        .chain(request.filter_fields.iter().filter(|_| !group_own_filters))
        .collect();

    match compute_once(bi_state, request, &engine_fields, group_own_filters).await {
        // A tuple filter has no host-mask spelling: the mask route can only
        // hide whole items of one column, and dropping the tuple would answer
        // UNFILTERED while the reader believes the selection applies. The
        // visual shows this as its error state instead (BUG-0444 class).
        Err(QueryFailure::ContestedClear(refusal)) if !request.tuple_filters.is_empty() => {
            Err(tuple_refusal_message(&refusal))
        }
        Err(QueryFailure::ContestedClear(refusal)) if !engine_fields.is_empty() => {
            // The HOST-MASK ROUTE: every filter becomes a GROUP BY column the
            // pivot then masks, the engine evaluates with no request filter,
            // so the clearing measure has nothing to contest.
            crate::log_info!(
                "PIVOT",
                "design query: the engine refused filtered evaluation ({}); answering on the host-mask route",
                refusal
            );
            let masked = with_engine_filters_masked(request);
            compute_once(bi_state, &masked, &[], true).await.map_err(QueryFailure::message)
        }
        other => other.map_err(QueryFailure::message),
    }
}

/// The error a visual shows when the engine refuses to evaluate it under a
/// selection made on ANOTHER visual that only a tuple filter can say.
pub(crate) fn tuple_refusal_message(refusal: &str) -> String {
    format!("This visual cannot apply the selection from another visual here: {}", refusal)
}

/// The tuple filters' own refusals, before any engine work: a column on a
/// calculation group (a pseudo table, not a model column) or on a LOOKUP
/// placement (resolved after aggregation, so it cannot narrow the rows).
/// Malformed tuples (wrong length, no columns, a column named twice) are the
/// engine's to refuse -- it owns the one rule for them.
fn validate_tuple_filters(request: &DesignQueryRequest) -> Result<(), String> {
    let lookup = |c: &DesignQueryColumn| {
        request
            .row_fields
            .iter()
            .chain(request.column_fields.iter())
            .chain(request.filter_fields.iter())
            .chain(request.page_filter_fields.iter())
            .any(|f| f.is_lookup && f.table == c.table && f.column == c.column)
    };
    for column in request.tuple_filters.iter().flat_map(|t| t.fields.iter()) {
        if column.table == crate::pivot::types::CALC_GROUP_TABLE {
            return Err(format!(
                "A selection cannot filter by the calculation group '{}'. Select a model column instead.",
                column.column
            ));
        }
        if lookup(column) {
            return Err(format!(
                "A selection cannot filter by the LOOKUP column {}.{}.",
                column.table, column.column
            ));
        }
    }
    Ok(())
}

/// `request` with every engine-routed filter folded into the query's own
/// FILTERS for the host-mask route: a filter on a column the query already
/// places (ROWS, COLUMNS or FILTERS) narrows it IN PLACE -- inclusions
/// intersected, exclusions united -- so no column is grouped twice; any other
/// becomes a FILTERS field. The query's own FILTERS need no folding: on this
/// route they are grouped and placed as filter fields wherever they ran before.
fn with_engine_filters_masked(request: &DesignQueryRequest) -> DesignQueryRequest {
    let mut out = request.clone();
    let incoming = std::mem::take(&mut out.page_filter_fields);
    for filter in incoming {
        let existing = out
            .row_fields
            .iter_mut()
            .chain(out.column_fields.iter_mut())
            .chain(out.filter_fields.iter_mut())
            .find(|f| f.same_column(&filter));
        match existing {
            Some(field) => {
                if let Some(kept) = filter.included_items {
                    field.included_items = Some(match field.included_items.take() {
                        Some(mine) => mine.into_iter().filter(|i| kept.contains(i)).collect(),
                        None => kept,
                    });
                }
                if let Some(hidden) = filter.hidden_items {
                    let mine = field.hidden_items.get_or_insert_with(Vec::new);
                    for h in hidden {
                        if !mine.contains(&h) {
                            mine.push(h);
                        }
                    }
                }
            }
            None => out.filter_fields.push(DesignQueryFieldRef { level: None, ..filter }),
        }
    }
    out
}

/// One attempt at a design query.
///
/// - `engine_fields` run INSIDE the engine query as level-tagged IN-lists
///   ([`engine_filters`]) and are never grouped by.
/// - `group_own_filters`: the query's own FILTERS are GROUP BY columns,
///   placed as the pivot's filter fields and masked host-side.
async fn compute_once(
    bi_state: &BiState,
    request: &DesignQueryRequest,
    engine_fields: &[&DesignQueryFieldRef],
    group_own_filters: bool,
) -> Result<
    (
        pivot_engine::PivotDefinition,
        pivot_engine::PivotCache,
        pivot_engine::PivotView,
    ),
    QueryFailure,
> {
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
        conn.engine
            .clone()
            .ok_or_else(|| "No BI model loaded for this connection.".to_string())?
    };

    // ---- The GROUP BY columns: ROWS, COLUMNS, and -- on the filter-area /
    // host-mask route -- the query's own FILTERS. Cache column layout:
    // [GROUP BY cols] [measure cols] (v1 has no lookups/hierarchies).
    let group_fields: Vec<&DesignQueryFieldRef> = request
        .row_fields
        .iter()
        .chain(request.column_fields.iter())
        .chain(request.filter_fields.iter().filter(|_| group_own_filters))
        .collect();

    // ---- Gather referenced tables (dimensions + measures) ----------------
    let mut referenced_tables: Vec<String> = Vec::new();
    for f in group_fields.iter().copied().chain(engine_fields.iter().copied()) {
        if !referenced_tables.contains(&f.table) {
            referenced_tables.push(f.table.clone());
        }
    }
    for c in request.tuple_filters.iter().flat_map(|t| t.fields.iter()) {
        if !referenced_tables.contains(&c.table) {
            referenced_tables.push(c.table.clone());
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
    let query_measures: Vec<String> =
        request.value_fields.iter().map(|v| v.measure_name.clone()).collect();
    let query_group_by: Vec<bi_engine::ColumnRef> = group_fields
        .iter()
        .map(|f| bi_engine::ColumnRef::new(&f.table, &f.column))
        .collect();
    let scoped_in_filters = engine_filters(bi_state, &engine_arc, connection_id, engine_fields).await?;
    let scoped_tuple_filters = engine_tuple_filters(&engine_arc, &request.tuple_filters).await;
    let query_request = bi_engine::QueryRequest {
        measures: query_measures.clone(),
        group_by: query_group_by,
        filters: vec![],
        scoped_in_filters,
        scoped_tuple_filters,
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
    .map_err(|e| {
        let message = crate::bi::commands::friendly_bi_query_error("BI query failed", &e);
        if is_contested_clear_refusal(&e) {
            QueryFailure::ContestedClear(message)
        } else {
            QueryFailure::Other(message)
        }
    })?;

    // ---- Build the transient pivot cache + definition --------------------
    let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7()); // throwaway id — never stored
    let mut cache = build_cache_from_arrow_batches(pivot_id, &batches)?;

    let num_group_by = group_fields.len();
    let mut field_to_cache_idx: HashMap<(String, String), usize> = HashMap::new();
    for (i, f) in group_fields.iter().enumerate() {
        field_to_cache_idx.insert((f.table.clone(), f.column.clone()), i);
    }
    let measure_start = num_group_by;

    let mut def = pivot_engine::PivotDefinition::new(pivot_id, (0, 0), (0, 0));
    // Only GROUPED fields have a cache column to place. An engine-routed
    // filter was applied inside the query: the cache holds the kept rows only
    // and there is no field to place (mapping one would point it at another
    // column). A query with nothing grouped is one grand-total row -- the
    // shape the chart reader takes as a Card's value.
    if !group_fields.is_empty() {
        apply_design_query_zones(&mut def, request, &field_to_cache_idx, &cache, group_own_filters);
    }

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
    let mut view = safe_calculate_pivot(&def, &mut cache);
    if group_fields.is_empty() {
        blank_measures_without_data(&mut view, &def, &batches);
    }
    Ok((def, cache, view))
}

/// A measure-only view's total for a measure the engine answered with NO
/// value -- no row kept (`includedItems: []`, a slicer that keeps nothing) or
/// only NULLs -- is BLANK, not 0. The pivot engine sums an empty set to 0,
/// which on a Card reads as "zero sales" when the truth is "nothing to
/// measure"; Power BI's card says "(Blank)" there, and so does ours now: the
/// cell's value is `Empty` and its text "". Only the GRAND-TOTAL row is
/// touched (it is the only row a measure-only view has), cell by cell through
/// `value_field_index`, so one measure's blank never blanks another's number.
///
/// The cache of a query with nothing grouped holds the measure columns alone,
/// at the result's own positions (no group-by, no lookups, no synthetic
/// column), so a value field's `source_index` IS its column in `batches`.
///
/// The parameter is `pivot_view`, not `view`, on purpose: the recalculation
/// census (`commands/bulk_rewrite_recalc_tests.rs`, NOT_A_GRID) exempts a
/// `cells` write by its RECEIVER's spelling, and a generic `view` would exempt
/// every future `view.cells` write in the crate along with this one.
fn blank_measures_without_data(
    pivot_view: &mut pivot_engine::PivotView,
    def: &pivot_engine::PivotDefinition,
    batches: &[arrow::record_batch::RecordBatch],
) {
    use arrow::array::Array;
    let has_value = |col: usize| {
        batches
            .iter()
            .any(|b| col < b.num_columns() && b.column(col).null_count() < b.column(col).len())
    };
    let total_rows: Vec<usize> = pivot_view
        .rows
        .iter()
        .filter(|r| r.row_type == pivot_engine::PivotRowType::GrandTotal)
        .map(|r| r.view_row)
        .collect();
    for row in total_rows {
        let Some(cells) = pivot_view.cells.get_mut(row) else { continue };
        for cell in cells.iter_mut() {
            let Some(vf) = cell.value_field_index.and_then(|k| def.value_fields.get(k)) else { continue };
            if !has_value(vf.source_index) {
                cell.value = pivot_engine::PivotCellValue::Empty;
                cell.formatted_value = String::new();
            }
        }
    }
}

/// The items an engine-routed filter KEEPS of one field, as an engine
/// IN-list -- or `None` when the field restricts nothing.
///
/// - `included_items` (`= (...)`): those items, minus any it also hides. An
///   EMPTY inclusion keeps nothing, and stays an empty list: the engine reads
///   an empty IN-list as "matches nothing", never "everything"
///   (`bi_engine::InFilter`).
/// - `hidden_items` alone (`NOT IN (...)`): every item of the column the model
///   lists (`all_values`, which offers the blank member as `(blank)`, last)
///   minus the hidden ones -- so the blank rows stay unless the list hides
///   them, exactly as the pivot's own `NOT IN` keeps them. The engine has no
///   level-tagged NOT-IN, and a SQL `<>` would drop NULLs, which is why the
///   complement is taken here instead.
/// - neither: `None`.
///
/// Items match EXACTLY, the pivot path's rule (`apply_design_query_zones`).
fn measure_only_kept_items(field: &DesignQueryFieldRef, all_values: Option<&[String]>) -> Option<Vec<String>> {
    let hidden = field.hidden();
    // The blank member is ONE member under either spelling (its key "" or the
    // header text "(blank)", ruling Q8): hiding one spelling hides it.
    let is_hidden = |v: &String| {
        hidden.contains(v)
            || (pivot_engine::is_blank_member_key(v) && hidden.iter().any(|h| pivot_engine::is_blank_member_key(h)))
    };
    match (&field.included_items, all_values) {
        (Some(included), _) => Some(included.iter().filter(|i| !is_hidden(i)).cloned().collect()),
        (None, Some(all)) if !hidden.is_empty() => Some(all.iter().filter(|v| !is_hidden(v)).cloned().collect()),
        _ => None,
    }
}

/// An item as the ENGINE's IN-list matches it on a column of `data_type`.
///
/// The items a filter carries are spelled the way the model's value list
/// spells them (`bi_get_column_values_core` -> `arrow_value_to_string`, f64
/// DISPLAY: `2024.0` is "2024") -- that is what a model slicer lists and
/// publishes. The engine matches a FLOAT64 column only in its own spelling
/// ("2024.0"), so "2024" matched nothing and every engine-routed Card under an
/// ordinary slicer click on a float column answered BLANK, with no error,
/// while a bar chart on the same page (host labels) kept working. A float item
/// is therefore re-spelled through `f64`'s round-trip form. The blank member
/// -- its key "" or the legacy "(blank)" -- is spelled the way the engine's
/// IN-list reads it (`bi::member::engine_in_value`, ruling Q8), and anything
/// that is not a number stays as written.
fn engine_spelling(data_type: Option<&bi_engine::DataType>, item: &str) -> String {
    if pivot_engine::is_blank_member_key(item) {
        return crate::bi::member::engine_in_value(item);
    }
    match data_type {
        Some(bi_engine::DataType::Float64) => match item.trim().parse::<f64>() {
            Ok(v) if v.is_finite() => format!("{:?}", v),
            _ => item.to_string(),
        },
        _ => item.to_string(),
    }
}

/// Engine-routed filters as the engine's level-tagged IN-lists, each
/// attributed to its table at its own level (`LEVEL_SLICER`, an ordinary
/// slicer, unless the field says it is pinned). The engine reads `(blank)` in
/// such a list as the BLANK member (NULL and empty), the same reading a
/// pinned slicer's list gets (`bi/blank_member_tests.rs`). A field that only
/// HIDES items needs the column's value list to take the complement of, read
/// through `bi_get_column_values_core` (role applied, so it lists what the
/// role may see). Every kept item is re-spelled for the column's type
/// ([`engine_spelling`]).
async fn engine_filters(
    bi_state: &BiState,
    engine_arc: &std::sync::Arc<tokio::sync::Mutex<bi_engine::Engine>>,
    connection_id: ConnectionId,
    fields: &[&DesignQueryFieldRef],
) -> Result<Vec<bi_engine::ScopedInFilter>, String> {
    let mut out = Vec::with_capacity(fields.len());
    for field in fields {
        let all_values = if field.included_items.is_none() && !field.hidden().is_empty() {
            Some(
                crate::bi::commands::bi_get_column_values_core(bi_state, connection_id, &field.table, &field.column)
                    .await?,
            )
        } else {
            None
        };
        let Some(kept) = measure_only_kept_items(field, all_values.as_deref()) else { continue };
        let data_type = {
            let engine = engine_arc.lock().await;
            engine
                .model()
                .table(&field.table)
                .ok()
                .and_then(|t| t.column(&field.column).ok())
                .map(|c| c.data_type().clone())
        };
        let kept: Vec<String> = kept.iter().map(|item| engine_spelling(data_type.as_ref(), item)).collect();
        let level = field
            .level
            .map(|l| l.clamp(bi_engine::LEVEL_SLICER, bi_engine::LEVEL_MAX))
            .unwrap_or(bi_engine::LEVEL_SLICER);
        out.push(bi_engine::ScopedInFilter {
            table: Some(field.table.clone()),
            filter: bi_engine::InFilter::new(field.column.clone(), kept),
            level,
        });
    }
    Ok(out)
}

/// A design query's tuple filters as the engine's level-tagged
/// `ScopedTupleFilter`s. Each key is re-spelled for its column's type exactly
/// as an IN-list item is ([`engine_spelling`]): a float key "2024" becomes
/// "2024.0", and the blank member's key "" becomes `BLANK_MEMBER_LABEL` --
/// a raw "" would match only empty-string rows, never NULL. Level: the
/// filter's own, clamped to the engine's range, else `LEVEL_SLICER`. The
/// tuples keep their order (the engine's query cache keys on it).
async fn engine_tuple_filters(
    engine_arc: &std::sync::Arc<tokio::sync::Mutex<bi_engine::Engine>>,
    filters: &[DesignQueryTupleFilter],
) -> Vec<bi_engine::ScopedTupleFilter> {
    if filters.is_empty() {
        return Vec::new();
    }
    let engine = engine_arc.lock().await;
    let data_type_of = |c: &DesignQueryColumn| {
        engine
            .model()
            .table(&c.table)
            .ok()
            .and_then(|t| t.column(&c.column).ok())
            .map(|col| col.data_type().clone())
    };
    filters
        .iter()
        .map(|filter| {
            let types: Vec<Option<bi_engine::DataType>> = filter.fields.iter().map(data_type_of).collect();
            bi_engine::ScopedTupleFilter {
                columns: filter
                    .fields
                    .iter()
                    .map(|c| bi_engine::TupleColumn::new(c.table.clone(), c.column.clone()))
                    .collect(),
                tuples: filter
                    .tuples
                    .iter()
                    .map(|tuple| {
                        tuple
                            .iter()
                            .enumerate()
                            .map(|(j, key)| engine_spelling(types.get(j).and_then(|t| t.as_ref()), key))
                            .collect()
                    })
                    .collect(),
                level: filter
                    .level
                    .map(|l| l.clamp(bi_engine::LEVEL_SLICER, bi_engine::LEVEL_MAX))
                    .unwrap_or(bi_engine::LEVEL_SLICER),
            }
        })
        .collect()
}

/// The query's ROWS, COLUMNS and -- when `place_filters` (they were grouped)
/// -- FILTERS as the transient definition's fields, each on its cache column
/// (`field_to_cache_idx`), each with every item filter the query says:
///
/// - `hidden_items` (`NOT IN`) on any zone. Only FILTERS carried one: a
///   ROWS / COLUMNS `NOT IN` ran with every item.
/// - `included_items` (`= (...)`): every item of the field in the query's
///   result (`cache`) that the list does not name is hidden -- the same
///   inversion the pivot editor makes when it has the field's item list, with
///   the same exact-match rule. It ran UNFILTERED (BUG-0197). The BLANK item
///   ("(blank)", a NULL member) is hidden too unless the list names it -- the
///   item list never shows it, so the inversion alone kept every blank row.
///
/// FILTERS that ran inside the engine query (`place_filters == false`) have
/// no cache column and are not placed.
pub(crate) fn apply_design_query_zones(
    def: &mut pivot_engine::PivotDefinition,
    request: &DesignQueryRequest,
    field_to_cache_idx: &HashMap<(String, String), usize>,
    cache: &pivot_engine::PivotCache,
    place_filters: bool,
) {
    let field_of = |f: &DesignQueryFieldRef| -> pivot_engine::PivotField {
        let idx = *field_to_cache_idx
            .get(&(f.table.clone(), f.column.clone()))
            .unwrap_or(&0);
        let mut field = pivot_engine::PivotField::new(idx, format!("{}.{}", f.table, f.column));
        field.hidden_items = f.hidden().to_vec();
        if let Some(ref included) = f.included_items {
            // An inclusion names a member by its KEY (what every member list,
            // slicer, page filter and cross-filter tuple hands out) -- which
            // for a decimal is "5.50" where the display spelling below is
            // "5.5" -- so compare on both, or the selected member is hidden.
            let field_cache = cache.fields.get(idx);
            for (value_id, label) in cache.get_unique_values_for_filter(idx) {
                let key = field_cache.map(|fc| fc.member_key(value_id));
                let is_included = included.contains(&label) || key.as_ref().is_some_and(|k| included.contains(k));
                if !is_included && !field.hidden_items.contains(&label) {
                    field.hidden_items.push(label);
                }
            }
            // The blank item too, unless the list names it: blanks are never
            // interned, so the item list above never shows one, and
            // `Region = ("East")` kept every row whose Region was blank (a
            // NULL member) in each total.
            let names_blank = included.iter().any(|l| pivot_engine::is_blank_member_key(l));
            if !names_blank && cache.has_blank_values(idx) {
                field.hidden_items.push(pivot_engine::BLANK_ITEM_LABEL.to_string());
            }
        }
        field
    };
    def.row_fields = request.row_fields.iter().map(field_of).collect();
    def.column_fields = request.column_fields.iter().map(field_of).collect();
    def.filter_fields = if place_filters {
        request
            .filter_fields
            .iter()
            .map(|f| pivot_engine::PivotFilter {
                field: field_of(f),
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            })
            .collect()
    } else {
        Vec::new()
    };
}

/// CONTRACT-CANVAS 4.8: the measure-only path, engine-backed. A CHILD module
/// so it drives `compute_design_query_view` directly.
#[cfg(test)]
#[path = "design_query_measure_only_tests.rs"]
mod design_query_measure_only_tests;

/// P4 S4b: tuple filters through design queries, and `group_members`.
#[cfg(test)]
#[path = "design_query_tuple_tests.rs"]
mod design_query_tuple_tests;

/// P4 S4b: the paint-only BI pivot view (`run_bi_pivot_filtered_view`).
#[cfg(test)]
#[path = "filtered_view_tests.rs"]
mod filtered_view_tests;

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
            level: None,
        }
    }

    fn request(rows: Vec<DesignQueryFieldRef>, filters: Vec<DesignQueryFieldRef>) -> DesignQueryRequest {
        DesignQueryRequest {
            connection_id: ConnectionId::ZERO,
            row_fields: rows,
            column_fields: Vec::new(),
            value_fields: Vec::new(),
            filter_fields: filters,
            page_filter_fields: Vec::new(),
            tuple_filters: Vec::new(),
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

        apply_design_query_zones(&mut def, &request(vec![fref("Time", "Year")], vec![region]), &columns(), &cache, true);

        assert_eq!(
            sorted(def.filter_fields[0].field.hidden_items.clone()),
            vec!["North".to_string(), "West".to_string()],
            "an inclusion filter ran unfiltered"
        );
        assert_eq!(def.row_fields[0].source_index, 1, "fixture: Year is the result's second column");
    }

    /// A Decimal(_, 2) column: every member list, slicer, page filter and
    /// cross-filter names a member by its KEY "5.50", where the cache's
    /// display spelling is "5.5". The inclusion `Price = ("5.50")` must keep
    /// 5.50 and hide the rest -- it used to hide exactly the member named.
    #[test]
    fn an_inclusion_of_a_decimal_member_key_keeps_that_member() {
        let mut grid = engine::grid::Grid::new();
        let rows: [[&str; 2]; 5] = [["Price", "Revenue"], ["5.5", "10"], ["10", "20"], ["5.5", "30"], ["7.25", "40"]];
        for (r, row) in rows.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                let cell = match v.parse::<f64>() {
                    Ok(n) if r > 0 => engine::Cell::new_number(n),
                    _ => engine::Cell::new_text(v.to_string()),
                };
                grid.set_cell(r as u32, c as u32, cell);
            }
        }
        let mut cache = crate::pivot::operations::build_cache_from_grid(&grid, (0, 0), (4, 1), true).expect("the cache").0;
        cache.fields[0].member_kind = pivot_engine::MemberKind::Decimal { scale: 2 };
        assert!(
            cache.get_unique_values_for_filter(0).iter().any(|(id, label)| label == "5.5" && cache.fields[0].member_key(*id) == "5.50"),
            "fixture: the display spelling and the key differ"
        );
        let mut price = fref("Sales", "Price");
        price.included_items = Some(vec!["5.50".to_string()]);
        let columns = HashMap::from([(("Sales".to_string(), "Price".to_string()), 0)]);
        let mut def = pivot_engine::PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));

        apply_design_query_zones(&mut def, &request(Vec::new(), vec![price]), &columns, &cache, true);

        assert_eq!(
            sorted(def.filter_fields[0].field.hidden_items.clone()),
            vec!["10".to_string(), "7.25".to_string()],
            "the inclusion hid the member it named"
        );
        def.value_fields
            .push(pivot_engine::ValueField::new(1, "Revenue".to_string(), pivot_engine::AggregationType::Sum));
        let view = safe_calculate_pivot(&def, &mut cache);
        let total = view.cells.iter().flatten().find_map(|c| match (c.cell_type, &c.value) {
            (pivot_engine::PivotCellType::GrandTotal, pivot_engine::PivotCellValue::Number(n)) => Some(*n),
            _ => None,
        });
        assert_eq!(total, Some(40.0), "Price = 5.50 totals 10 + 30");
    }

    /// `ROWS: Geo.Region NOT IN ("West")` hides West on the ROW field.
    #[test]
    fn a_row_fields_exclusion_list_is_applied() {
        let cache = result_cache();
        let mut region = fref("Geo", "Region");
        region.hidden_items = Some(vec!["West".to_string()]);
        let mut def = pivot_engine::PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));

        apply_design_query_zones(&mut def, &request(vec![region], Vec::new()), &columns(), &cache, true);

        assert_eq!(def.row_fields[0].hidden_items, vec!["West".to_string()], "a row's NOT IN ran unfiltered");
    }

    /// The end-to-end effect: the computed view of `= ("East")` totals East only.
    #[test]
    fn an_inclusion_filter_changes_the_computed_totals() {
        let mut cache = result_cache();
        let mut region = fref("Geo", "Region");
        region.included_items = Some(vec!["East".to_string()]);
        let mut def = pivot_engine::PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));
        apply_design_query_zones(&mut def, &request(vec![fref("Time", "Year")], vec![region]), &columns(), &cache, true);
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
        apply_design_query_zones(&mut def, &request(vec![fref("Time", "Year")], vec![region]), &columns(), &cache, true);
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
