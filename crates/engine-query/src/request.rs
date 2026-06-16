//! Query request types — the user-facing description of what to compute.

use engine_connectors::{FilterCondition, FilterOperator};
use engine_core::types::DataType;

pub use engine_connectors::GROUPING_ID_COLUMN;

/// What a result column represents, for host rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultColumnKind {
    /// A group-by dimension column (the axis).
    Dimension,
    /// A computed measure value column (including calculation-group columns).
    Measure,
    /// The `__grouping_id` bitmask column emitted by `TotalsMode::Rollup`.
    GroupingId,
    /// The integer ranking column appended by [`RankBy`].
    Rank,
}

/// Describes one column of a query result so a host need not re-derive it from
/// the column name.
///
/// Returned by `Engine::query_with_meta` alongside the `RecordBatch`es. The
/// engine owns every fact a host would otherwise reconstruct by string-matching
/// column names — the measure's `format_string`/`display_name`, the dimension's
/// `display_name`, which synthetic `"M [I]"` column came from which measure and
/// calculation item, and which column is the `__grouping_id` or rank column —
/// so the two host applications cannot drift on that mapping.
#[derive(Debug, Clone, PartialEq)]
pub struct ResultColumn {
    /// The exact result column name (as it appears in the `RecordBatch` schema).
    pub name: String,
    /// What this column represents.
    pub kind: ResultColumnKind,
    /// The column's engine data type, mapped best-effort from the Arrow result
    /// type (`None` for a type with no clean engine mapping). Note grouped
    /// string dimensions arrive dictionary-encoded; this reports the underlying
    /// `String` so the host need not inspect the encoding.
    pub data_type: Option<DataType>,
    /// For a [`Dimension`](ResultColumnKind::Dimension): the model table that
    /// owns the column.
    pub source_table: Option<String>,
    /// For a [`Dimension`](ResultColumnKind::Dimension): the model column name.
    pub source_column: Option<String>,
    /// For a [`Measure`](ResultColumnKind::Measure): the measure name (the
    /// **base** measure for a calculation-group column).
    pub measure: Option<String>,
    /// For a calculation-group [`Measure`](ResultColumnKind::Measure) column:
    /// the applied calculation item.
    pub calculation_item: Option<String>,
    /// Measure format string (e.g. `"#,##0.00"`), when the model defines one.
    pub format_string: Option<String>,
    /// Friendly display name from the model (measure or column), when defined.
    pub display_name: Option<String>,
    /// Model description for the measure/column, when defined.
    pub description: Option<String>,
    /// Whether the model marks the underlying measure/column hidden.
    pub is_hidden: bool,
    /// For a [`Measure`](ResultColumnKind::Measure): the name of the model KPI
    /// whose **base** measure this column is, when one is defined — so the host
    /// can render the KPI's status indicator. `None` when the measure is not a
    /// KPI base.
    pub kpi_name: Option<String>,
}

impl ResultColumn {
    /// Create a metadata entry with only the name + kind populated; the engine
    /// fills in the attribution fields. Hosts normally consume these via
    /// `Engine::query_with_meta` rather than constructing them.
    pub fn bare(name: impl Into<String>, kind: ResultColumnKind) -> Self {
        Self {
            name: name.into(),
            kind,
            data_type: None,
            source_table: None,
            source_column: None,
            measure: None,
            calculation_item: None,
            format_string: None,
            display_name: None,
            description: None,
            is_hidden: false,
            kpi_name: None,
        }
    }
}

/// A filter on a computed **measure value** (a `HAVING` clause): keep only the
/// result rows whose `measure` satisfies `operator value`.
///
/// The referenced `measure` must be one of the request's
/// [`measures`](QueryRequest::measures). Filters are applied **after**
/// aggregation and **before** `limit`, so `order_by` a measure + `limit` +
/// a measure filter expresses "top N rows whose measure exceeds a threshold".
/// A `NULL` measure value never satisfies a filter (the row is dropped), matching
/// SQL `HAVING` semantics. Not supported with `TotalsMode::Rollup` or a
/// calculation group (fails closed).
#[derive(Debug, Clone, PartialEq)]
pub struct MeasureFilter {
    /// The measure to filter on (must be in [`QueryRequest::measures`]).
    pub measure: String,
    /// Comparison operator.
    pub operator: FilterOperator,
    /// The numeric threshold the measure value is compared against.
    pub value: f64,
}

impl MeasureFilter {
    /// Create a measure-value filter `measure operator value`.
    pub fn new(measure: impl Into<String>, operator: FilterOperator, value: f64) -> Self {
        Self {
            measure: measure.into(),
            operator,
            value,
        }
    }
}

/// A request-level ranking of result rows by a measure value (DAX `RANKX`-style),
/// added to the result as an extra integer column.
///
/// Computed **after** aggregation — exactly like a `HAVING`
/// [`MeasureFilter`] — so it composes with `order_by` + `limit` for "top N by
/// measure". The engine runs the underlying grouped query, ranks each row by
/// `measure`, and appends `output_column`. By default rank `1` is the **largest**
/// measure value (descending), ties share a rank and the next rank skips
/// (standard competition ranking); set [`ascending`](Self::ascending) to make
/// `1` the smallest, or [`dense`](Self::dense) for gap-free ranks. With
/// [`partition_by`](Self::partition_by) the rank restarts within each group of
/// those columns (e.g. rank products *within each region*).
///
/// The referenced `measure` must be in [`QueryRequest::measures`]; every
/// `partition_by` column must be in [`QueryRequest::group_by`]; and
/// `output_column` must not collide with an existing result column. Not
/// supported with [`TotalsMode::Rollup`] or a calculation group (fails closed).
#[derive(Debug, Clone, PartialEq)]
pub struct RankBy {
    /// The measure to rank by (must be in [`QueryRequest::measures`]).
    pub measure: String,
    /// Name of the integer rank column appended to the result.
    pub output_column: String,
    /// Columns to rank *within* (the rank restarts per distinct combination).
    /// Each must be in [`QueryRequest::group_by`]. Empty = rank over all rows.
    pub partition_by: Vec<ColumnRef>,
    /// Gap-free ranking (`DENSE_RANK`): ties share a rank and the next rank is
    /// the next integer (1,1,2). Default `false` = standard ranking (1,1,3).
    pub dense: bool,
    /// Rank ascending (`1` = smallest value). Default `false` = descending
    /// (`1` = largest), the usual "top" sense.
    pub ascending: bool,
}

impl RankBy {
    /// Rank by `measure` descending (rank 1 = largest), standard ties, no
    /// partition, producing an integer column named `output_column`.
    pub fn new(measure: impl Into<String>, output_column: impl Into<String>) -> Self {
        Self {
            measure: measure.into(),
            output_column: output_column.into(),
            partition_by: Vec::new(),
            dense: false,
            ascending: false,
        }
    }

    /// Rank ascending (`1` = smallest value).
    pub fn ascending(mut self) -> Self {
        self.ascending = true;
        self
    }

    /// Use gap-free (`DENSE_RANK`) ranking.
    pub fn dense(mut self) -> Self {
        self.dense = true;
        self
    }

    /// Restart the ranking within each distinct combination of `columns`.
    pub fn within(mut self, columns: Vec<ColumnRef>) -> Self {
        self.partition_by = columns;
        self
    }
}

/// A request-level **TOP N** filter: keep only the top `limit` groups by a
/// measure value, with DAX `TOPN` **tie-inclusive** semantics — if several
/// groups tie at the `limit`-th measure value, **all** of them are kept, so the
/// result may contain more than `limit` rows. This is distinct from
/// [`QueryRequest::order_by`] + [`QueryRequest::limit`], which truncate to
/// exactly `limit` rows (breaking ties arbitrarily).
///
/// Computed after aggregation, like [`RankBy`] and measure-value filters.
/// Composition order: any measure-value filters apply **first** ("top 10 of the
/// groups that pass the threshold"), then TOP N, then `order_by` + `limit` (so a
/// host can order the tie-inclusive result and optionally cap it exactly).
///
/// Validation (fails closed): `measure` must be in [`QueryRequest::measures`];
/// each `partition_by` column must be in [`QueryRequest::group_by`] (the top-N
/// restarts per distinct combination); `output_column`, when set, must not
/// collide with an existing result column. Not supported with
/// [`TotalsMode::Rollup`] or a calculation group.
#[derive(Debug, Clone, PartialEq)]
pub struct TopN {
    /// The measure whose value ranks the groups (must be in
    /// [`QueryRequest::measures`]).
    pub measure: String,
    /// How many top groups to keep (tie-inclusive at the boundary value).
    pub limit: usize,
    /// Columns to take the top N *within* (the top-N restarts per distinct
    /// combination). Each must be in [`QueryRequest::group_by`]. Empty = top N
    /// over all groups.
    pub partition_by: Vec<ColumnRef>,
    /// Take the *bottom* N (`ascending` = smallest values). Default `false` =
    /// top N (largest values), the usual "top" sense.
    pub ascending: bool,
    /// When set, append an integer column of this name giving, per kept row, how
    /// many groups tie at the boundary value in its partition (so a host can see
    /// how far the tie-inclusive result exceeded `limit`).
    pub output_column: Option<String>,
}

impl TopN {
    /// Keep the top `limit` groups by `measure` (descending; ties at the
    /// boundary all kept), over all groups.
    pub fn new(measure: impl Into<String>, limit: usize) -> Self {
        Self {
            measure: measure.into(),
            limit,
            partition_by: Vec::new(),
            ascending: false,
            output_column: None,
        }
    }

    /// Take the *bottom* `limit` (smallest values).
    pub fn ascending(mut self) -> Self {
        self.ascending = true;
        self
    }

    /// Restart the top-N within each distinct combination of `columns`.
    pub fn within(mut self, columns: Vec<ColumnRef>) -> Self {
        self.partition_by = columns;
        self
    }

    /// Append an integer tie-count column named `name` to each kept row.
    pub fn with_tie_count(mut self, name: impl Into<String>) -> Self {
        self.output_column = Some(name.into());
        self
    }
}

/// A multi-select (`IN`-list) slicer: keep only rows whose `column` is one of
/// `values` — `column IN (v1, v2, ...)`.
///
/// This is the multi-value form of a slicer (e.g. `Region IN ('East', 'West')`).
/// The filter applies to whichever table owns `column` (matched by name) and is
/// pushed to the source; a slicer on a dimension column restricts the related
/// fact through the engine's relationship propagation, exactly like a scalar
/// [`FilterCondition`] does. Values are compared by the column's type
/// (integer columns compare numerically; everything else as text, escaped and
/// quoted). An **empty** `values` list matches nothing (an empty result), never
/// everything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InFilter {
    /// The column to slice on.
    pub column: String,
    /// The set of values to keep (string representations).
    pub values: Vec<String>,
}

impl InFilter {
    /// Create an `IN`-list slicer `column IN (values)`.
    pub fn new(
        column: impl Into<String>,
        values: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            column: column.into(),
            values: values.into_iter().map(Into::into).collect(),
        }
    }
}

/// A reference to a specific column in a table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnRef {
    /// Table name as it appears in the data model.
    pub table: String,
    /// Column name.
    pub column: String,
}

impl ColumnRef {
    /// Create a new column reference.
    pub fn new(table: impl Into<String>, column: impl Into<String>) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
        }
    }
}

/// Group a query by the levels of a model-defined hierarchy.
///
/// The hierarchy's level columns — in drill order, up to `depth` — are
/// **appended** to the request's explicit [`QueryRequest::group_by`] columns
/// by the planner. From that point on they behave exactly like ordinary
/// group-by columns: they participate in projection, joins, pushdown
/// decisions, default ordering, ROLLUP totals, and lookup-key inference.
///
/// `depth` is the **number of levels to include**, counted from the top of
/// the drill path: `1..=levels.len()`. For a `Year → Quarter → Month`
/// hierarchy named `"Calendar"`:
///
/// - `depth: 1` groups by `Year`,
/// - `depth: 2` groups by `Year, Quarter`,
/// - `depth: 3` groups by `Year, Quarter, Month`.
///
/// `depth: 0` and depths beyond the number of levels are rejected at
/// planning time, as is an explicit `group_by` column that duplicates one of
/// the included level columns (the levels are appended automatically — do
/// not list them yourself).
///
/// The hierarchy's [`RaggedBehavior`](engine_core::model::RaggedBehavior)
/// (from the model) is applied to the result; level cells equal to a level's
/// `stopper_value` are treated as NULL-equivalent under every behavior.
///
/// # Example
///
/// ```ignore
/// // Drill two levels into the Calendar hierarchy: Revenue by Year, Quarter.
/// let request = QueryRequest {
///     measures: vec!["Revenue".into()],
///     hierarchy_group_by: Some(HierarchyGroupBy::new("Calendar", 2)),
///     ..Default::default()
/// };
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HierarchyGroupBy {
    /// Name of a hierarchy defined in the `DataModel`.
    pub hierarchy: String,
    /// Number of levels to include, from the top: `1..=levels.len()`.
    pub depth: usize,
}

impl HierarchyGroupBy {
    /// Group by the first `depth` levels of the named hierarchy.
    pub fn new(hierarchy: impl Into<String>, depth: usize) -> Self {
        Self {
            hierarchy: hierarchy.into(),
            depth,
        }
    }
}

/// A column to look up post-aggregation instead of grouping by.
///
/// When a query uses lookup columns, they are not included in the GROUP BY
/// clause. Instead, after aggregation, the engine joins back to the dimension
/// table and resolves the lookup column using the column's resolution
/// expression (or `MIN(column)` by default).
#[derive(Debug, Clone)]
pub struct LookupColumn {
    /// Table name containing the lookup column.
    pub table: String,
    /// Column name to look up.
    pub column: String,
    /// Key column to join on. If `None`, auto-inferred from `group_by`
    /// columns in the same table (must be exactly one).
    pub key_column: Option<String>,
}

impl LookupColumn {
    /// Create a new lookup column with auto-inferred key.
    pub fn new(table: impl Into<String>, column: impl Into<String>) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            key_column: None,
        }
    }

    /// Create a new lookup column with an explicit key column.
    pub fn with_key(
        table: impl Into<String>,
        column: impl Into<String>,
        key_column: impl Into<String>,
    ) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            key_column: Some(key_column.into()),
        }
    }
}

/// The sort key of an [`OrderByClause`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrderTarget {
    /// Order by a group-by dimension column.
    ///
    /// The column must be one of the request's `group_by` columns. If the
    /// model declares a `sort_by_column` for it (e.g. `MonthName` sorted by
    /// `MonthNumber`), the engine orders by the sort column's value instead
    /// of the display value.
    ///
    /// # Example
    ///
    /// ```ignore
    /// // Order rows by the month dimension (January, February, ... when
    /// // dim_date.month_name has sort_by_column = "month_number").
    /// OrderTarget::Column(ColumnRef::new("dim_date", "month_name"))
    /// ```
    Column(ColumnRef),
    /// Order by a measure's result value, referenced by measure name.
    ///
    /// The name must be one of the request's `measures`. Combined with
    /// `descending: true` and a `limit`, this expresses TOP-N queries.
    ///
    /// # Example
    ///
    /// ```ignore
    /// // Top-10 products by revenue:
    /// // order_by: [OrderByClause::measure_desc("Revenue")], limit: Some(10)
    /// OrderTarget::Measure("Revenue".to_string())
    /// ```
    Measure(String),
}

/// A single ORDER BY entry of a [`QueryRequest`].
///
/// Entries are applied in order: the first clause is the primary sort key,
/// later clauses break ties.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderByClause {
    /// What to sort by — a group-by dimension column or a measure result.
    pub target: OrderTarget,
    /// Sort direction; `false` is ascending.
    pub descending: bool,
}

impl OrderByClause {
    /// Order ascending by a group-by dimension column.
    pub fn column(table: impl Into<String>, column: impl Into<String>) -> Self {
        Self {
            target: OrderTarget::Column(ColumnRef::new(table, column)),
            descending: false,
        }
    }

    /// Order descending by a group-by dimension column.
    pub fn column_desc(table: impl Into<String>, column: impl Into<String>) -> Self {
        Self {
            target: OrderTarget::Column(ColumnRef::new(table, column)),
            descending: true,
        }
    }

    /// Order ascending by a measure's result value.
    pub fn measure(name: impl Into<String>) -> Self {
        Self {
            target: OrderTarget::Measure(name.into()),
            descending: false,
        }
    }

    /// Order descending by a measure's result value (TOP-N queries).
    pub fn measure_desc(name: impl Into<String>) -> Self {
        Self {
            target: OrderTarget::Measure(name.into()),
            descending: true,
        }
    }
}

/// Whether a grouped query result includes subtotal rows.
///
/// # Result contract for [`TotalsMode::Rollup`]
///
/// The result gains a **trailing `Int32` column** named
/// [`GROUPING_ID_COLUMN`] (`"__grouping_id"`): a bitmask where bit `i`
/// (least-significant bit = `group_by[0]`) is **set** when `group_by[i]` is
/// rolled up (aggregated away) in that row. Detail rows are `0`; the grand
/// total has all bits set. This matches SQL `GROUPING_ID` semantics and
/// disambiguates subtotal `NULL`s from real `NULL` dimension values.
///
/// For `group_by` `[a, b]` the result contains the detail rows
/// (`__grouping_id` = 0) plus subtotal rows per group-by prefix: per-`a`
/// subtotals with `b` rolled up (`__grouping_id` = 2) and the grand total
/// with both rolled up (`__grouping_id` = 3) — i.e. SQL `ROLLUP` semantics —
/// computed in **one** query over a single scan/fetch of the fact table.
/// Every subtotal level is *recomputed at that level*, never summed from
/// detail rows, so non-additive measures (DISTINCTCOUNT, AVG, ...) are
/// correct in subtotal rows.
///
/// With an **empty** `group_by`, the result is the single grand-total row
/// with `__grouping_id` = 0 (there are no bits to set — the lone aggregate
/// row is both detail and grand total).
///
/// # Ordering and limit
///
/// The default ordering is unchanged: when `order_by` is empty, rows sort by
/// the group-by columns ascending, which places subtotal rows (whose
/// rolled-up dimensions are `NULL`) after the detail rows of their group in
/// the engine-ordered paths (`NULL`s last for ascending keys; pushed SQL
/// follows the source's `NULL` ordering, as it already does for real `NULL`
/// dimension values). Hosts that want a specific pivot layout typically
/// order by `__grouping_id` and the dimension columns themselves.
/// [`QueryRequest::limit`] applies to the combined result *after* subtotal
/// rows are included.
///
/// # Unsupported combinations
///
/// Filter-context time-intelligence measures **do** compose with `Rollup`:
/// `YTD`/`QTD`/`MTD`, `DATESINPERIOD`, `CLOSINGBALANCE`/`OPENINGBALANCE`,
/// `PRIORYEAR`/`PRIORPERIOD`/`PARALLELPERIOD`, and compound forms (YoY =
/// `YTD − PRIORYEAR`) — evaluated when the date is *not* on the group-by axis —
/// lower to ordinary aggregates, so each subtotal / grand total is the measure
/// re-evaluated over the rolled-up row set. They also compose with a ragged
/// hierarchy group-by. Axis-mode running windows and ranking still fail closed.
///
/// Requests with `totals = Rollup` return a typed `InvalidQuery` error when
/// combined with (support may be added later):
///
/// - lookup columns ([`QueryRequest::lookups`]),
/// - axis-mode window/running measures (`WINDOW` / `OFFSET` / `INDEX`, or any
///   time intelligence with a date column on the group-by axis), and ranking
///   (`RANK` / `ROW_NUMBER` / `DENSE_RANK`),
/// - QUERY-in-VAR measures (two-stage `QUERY(...)` bindings),
/// - measures spanning multiple fact tables in one request,
/// - GROUP BY dimensions reached through unsafe (many-to-many / non-equi)
///   relationships, or measures whose `USERELATIONSHIP` override targets a
///   group-by dimension through such a relationship,
/// - more than 31 `group_by` columns (the bitmask is `Int32`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TotalsMode {
    /// No subtotal rows — detail rows only (the default).
    #[default]
    None,
    /// Add SQL `ROLLUP` subtotal rows: for `group_by` `[a, b]`, the detail
    /// rows plus subtotal rows per prefix (`[a]`, then `[]` — the grand
    /// total), all computed in one query. See the type-level docs for the
    /// `__grouping_id` result contract.
    Rollup,
}

/// Apply a model-defined **calculation group** to a query's measures.
///
/// A calculation group (see
/// [`CalculationGroup`](engine_core::model::CalculationGroup)) is a set of
/// named *calculation items* — measure templates that transform whichever
/// measure they are applied to (via the `SELECTEDMEASURE()` placeholder). When
/// set on a [`QueryRequest`], the engine cross-applies the selected items to
/// the request's [`measures`](QueryRequest::measures), replacing those
/// measures with the resulting **synthetic** measures for this one query.
///
/// # Result contract — ordering and naming
///
/// For requested measures `[M1, M2, ...]` (in `QueryRequest::measures` order)
/// and selected items `[I1, I2, ...]` (in [`items`](Self::items) order; an
/// **empty** list means *all* items in the group, in declaration order), the
/// result has `measures.len() * items.len()` value columns, ordered
/// **measures-outer / items-inner**:
///
/// ```text
/// M1[I1], M1[I2], ..., M2[I1], M2[I2], ...
/// ```
///
/// Each value column is named `"{measure} [{item}]"` — e.g. applying a group
/// with items `Current`, `YTD`, `PY` to `Revenue` yields the columns
/// `"Revenue [Current]"`, `"Revenue [YTD]"`, `"Revenue [PY]"`. The synthetic
/// measures are ordinary measures and compose with `group_by`, `filters`,
/// `order_by`, etc. exactly like a plain multi-measure request.
///
/// # Errors
///
/// The query fails with a typed error when the named group does not exist, a
/// selected item is not in the group, a requested measure does not exist, or a
/// synthetic name would collide with an existing model measure.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CalculationGroupApplication {
    /// Name of a calculation group defined in the `DataModel`.
    pub group: String,
    /// Names of the calculation items to apply, in the order their columns
    /// should appear (items-inner). An **empty** list applies *all* items in
    /// the group, in declaration order.
    pub items: Vec<String>,
}

impl CalculationGroupApplication {
    /// Apply the named calculation group's items (all of them when `items` is
    /// empty) to the request's measures.
    pub fn new(group: impl Into<String>, items: Vec<String>) -> Self {
        Self {
            group: group.into(),
            items,
        }
    }
}

/// A request to compute measures, optionally grouped by dimensions and filtered.
///
/// This is the primary input to the query planner. Measures and dimensions
/// reference names defined in the `DataModel`.
///
/// # Result ordering
///
/// When `order_by` is non-empty, results are sorted by the given clauses.
/// When `order_by` is **empty** and `group_by` is **non-empty**, results are
/// ordered by the group-by columns in declaration order (ascending) — pivot
/// output is always deterministic. Dimension ordering respects each column's
/// model-declared `sort_by_column` in the SQL-ordered execution paths (e.g.
/// `MonthName` rows sort by `MonthNumber`); see [`OrderTarget::Column`].
/// Scalar queries (no `group_by`, no `order_by`) are returned as computed.
///
/// `limit` caps the number of result rows after ordering. `Some(0)` is
/// allowed and produces an empty result.
///
/// New fields may be added over time; construct with struct-update syntax to
/// stay forward-compatible:
///
/// ```ignore
/// let request = QueryRequest {
///     measures: vec!["Revenue".into()],
///     group_by: vec![ColumnRef::new("dim_product", "category")],
///     order_by: vec![OrderByClause::measure_desc("Revenue")],
///     limit: Some(10),
///     ..Default::default()
/// };
/// ```
#[derive(Debug, Clone, Default)]
pub struct QueryRequest {
    /// Measure names to compute (must exist in the `DataModel`).
    pub measures: Vec<String>,
    /// Dimension columns to group by.
    pub group_by: Vec<ColumnRef>,
    /// Filter conditions to apply.
    pub filters: Vec<FilterCondition>,
    /// Columns to look up post-aggregation instead of grouping by.
    ///
    /// These columns are NOT in `group_by`. After aggregation, the engine
    /// joins back to the dimension table and resolves each lookup column
    /// using its resolution expression (from the model) or `MIN(column)`
    /// by default.
    pub lookups: Vec<LookupColumn>,
    /// ORDER BY clauses for the result rows.
    ///
    /// Each [`OrderTarget::Column`] must reference one of the `group_by`
    /// columns; each [`OrderTarget::Measure`] must reference one of the
    /// `measures`. When empty and `group_by` is non-empty, the engine
    /// defaults to ordering by the group-by columns (ascending).
    pub order_by: Vec<OrderByClause>,
    /// Maximum number of result rows, applied after ordering.
    ///
    /// `Some(0)` is allowed and produces an empty result. `None` (default)
    /// returns all rows. When [`QueryRequest::totals`] is
    /// [`TotalsMode::Rollup`], the limit applies to the combined result
    /// including the subtotal rows.
    pub limit: Option<usize>,
    /// Whether to add subtotal rows to the grouped result.
    ///
    /// [`TotalsMode::Rollup`] produces, for `group_by` `[a, b]`, the detail
    /// rows plus subtotal rows per prefix (`[a]` and `[]` — the grand
    /// total) in **one** query, with a trailing [`GROUPING_ID_COLUMN`]
    /// bitmask column identifying each row's level. See [`TotalsMode`] for
    /// the full result contract and unsupported combinations.
    pub totals: TotalsMode,
    /// Group by the levels of a model-defined hierarchy.
    ///
    /// When set, the hierarchy's level columns (in drill order, up to the
    /// requested depth) are appended to `group_by` by the planner and then
    /// behave like ordinary group-by columns — including for ROLLUP totals
    /// (each level becomes a drill subtotal) and default ordering. See
    /// [`HierarchyGroupBy`] for the depth semantics and validation rules.
    pub hierarchy_group_by: Option<HierarchyGroupBy>,
    /// Apply a model-defined calculation group to this request's
    /// [`measures`](Self::measures).
    ///
    /// When set, the engine cross-applies the selected calculation items to
    /// the requested measures and computes the resulting synthetic measures
    /// instead — producing `measures.len() * items.len()` value columns,
    /// ordered measures-outer / items-inner, each named `"{measure} [{item}]"`.
    /// See [`CalculationGroupApplication`] for the full ordering and naming
    /// contract. `None` (default) leaves the requested measures unchanged.
    pub calculation_group: Option<CalculationGroupApplication>,
    /// Filter result rows by computed measure values (a `HAVING` clause).
    ///
    /// Applied after aggregation and before [`limit`](Self::limit), so it
    /// composes with `order_by` + `limit` to express top-N-over-threshold. Each
    /// filter's measure must be in [`measures`](Self::measures). Empty (default)
    /// applies no measure filter. See [`MeasureFilter`].
    pub measure_filters: Vec<MeasureFilter>,
    /// Multi-select (`IN`-list) slicers, ANDed with [`filters`](Self::filters).
    ///
    /// Each entry keeps only rows whose column is one of the listed values
    /// (`column IN (...)`). Applied at fetch time and pushed to the source.
    /// Empty (default) applies no IN slicer. See [`InFilter`].
    pub in_filters: Vec<InFilter>,
    /// A cross-column **OR** slicer: keep rows matching **any** of these
    /// conditions, ANDed with [`filters`](Self::filters).
    ///
    /// E.g. `[status = 'open', priority > 5]` keeps rows where `status = 'open'
    /// OR priority > 5`. All conditions must reference columns of a **single**
    /// table (the fact, or one dimension whose match restricts the fact);
    /// conditions spanning different tables fail closed. Empty (default) applies
    /// no OR slicer.
    pub or_filters: Vec<FilterCondition>,
    /// Append a measure-value ranking column to the result (DAX `RANKX`-style).
    ///
    /// Computed after aggregation (like [`measure_filters`](Self::measure_filters)),
    /// so it composes with `order_by` + `limit` for "top N by measure". `None`
    /// (default) adds no ranking. See [`RankBy`].
    pub rank_by: Option<RankBy>,
    /// Keep only the top N groups by a measure, with DAX `TOPN` tie-inclusive
    /// semantics (all groups tied at the Nth value are kept — distinct from
    /// `order_by` + `limit`, which truncate exactly). Computed after aggregation
    /// and after [`measure_filters`](Self::measure_filters), before `order_by` +
    /// `limit`. `None` (default) applies no top-N. See [`TopN`].
    pub top_n: Option<TopN>,
}

/// A request for the **raw fact rows** behind a pivot cell (drillthrough /
/// detail-rows).
///
/// Unlike [`QueryRequest`], a `DetailRequest` performs **no aggregation**: it
/// returns the underlying detail-table rows that a measure cell aggregated
/// over, as a `SELECT columns ... WHERE ... ORDER BY ... LIMIT n`. The host (a
/// spreadsheet) issues one when a user double-clicks a cell to inspect the
/// transactions behind it.
///
/// # Security
///
/// Because this exposes raw rows, **row-level security is enforced even more
/// strictly than for aggregates** — a missing restriction is a direct data
/// leak rather than a wrong total. The active role's predicates are sealed
/// onto the detail fetch, a role (or cell filter) on a related dimension is
/// propagated to the detail table the same way it is for aggregation (only
/// the detail rows that join to permitted dimension rows are returned), and a
/// role on a dimension reachable only through a relationship the engine cannot
/// enforce (non-equi / many-to-many / composite-key / inactive / multi-hop)
/// **fails closed** with
/// [`RowLevelSecurityNotEnforceable`](engine_core::error::EngineError::RowLevelSecurityNotEnforceable)
/// rather than returning under-restricted rows.
///
/// # Filters target the detail table OR a related dimension
///
/// A [`FilterCondition`] names only a column, not a table. Each filter is
/// matched to the table whose model definition owns that column. Filters on
/// the detail table are applied to the detail fetch directly; filters on a
/// related dimension are propagated to the detail table by fetching the
/// dimension (restricted by the filter), extracting its join keys, and adding
/// an `IN (...)` filter on the detail table's join column — exactly the
/// dimension→fact propagation the aggregation path uses. A cell-coordinate
/// filter that lands on a dimension reached through a non-propagatable
/// relationship cannot restrict the detail rows and is rejected at execution
/// time.
///
/// # Dimension attributes ([`dimension_columns`](Self::dimension_columns))
///
/// In addition to the detail-table columns, a drillthrough may request
/// **dimension attributes** — columns on a dimension related to the detail
/// table — to display alongside the raw rows (e.g. `Product.name` next to a
/// fact's `product_id`). Each requested attribute is resolved by a single-hop,
/// active, single-column **equi** relationship between the detail table and the
/// dimension (the same propagatable shape used for filters and RLS); snowflake
/// / multi-hop attributes are out of scope and rejected. The attributes are
/// looked up by a many-to-one `LEFT JOIN` applied **after** the detail rows are
/// fetched, RLS-restricted, and limited — so the join is small, never drops or
/// duplicates detail rows, and never re-introduces a role-excluded row. See
/// [`dimension_columns`](Self::dimension_columns) for the naming convention and
/// the security guarantees.
///
/// # Limit is mandatory
///
/// DirectQuery fact tables are effectively unbounded, so a drillthrough must
/// always cap its result: [`limit`](DetailRequest::limit) is a required field
/// (there is intentionally no `Default`). `limit == 0` is a valid request that
/// returns an empty result.
///
/// New fields may be added over time; construct with
/// [`DetailRequest::new`] plus struct-update syntax to stay
/// forward-compatible:
///
/// ```ignore
/// // The 50 raw Sales rows behind the "West / 2024" cell.
/// let request = DetailRequest {
///     columns: vec!["order_id".into(), "amount".into()],
///     filters: vec![/* region = West, year = 2024 (on dimensions) */],
///     ..DetailRequest::new("Sales", 50)
/// };
/// ```
#[derive(Debug, Clone)]
pub struct DetailRequest {
    /// The detail (fact) table whose raw rows to return.
    ///
    /// Must be a table the model defines. It is resolved to a connector + a
    /// source binding via the registry, or served from the in-memory cache
    /// when present. A table that is neither bound nor cached yields
    /// [`SourceNotRegistered`](crate::error::QueryError::SourceNotRegistered).
    pub table: String,
    /// Detail-table columns to return. **Empty means all columns** (`SELECT
    /// *`). Each named column must exist on the detail table. These are always
    /// detail-table columns; dimension attributes are requested separately via
    /// [`dimension_columns`](Self::dimension_columns).
    pub columns: Vec<String>,
    /// Dimension attributes to look up and append to each detail row.
    ///
    /// Each [`ColumnRef`] names a column (`column`) on a dimension table
    /// (`table`) that is related to the detail table by a **single-hop,
    /// active, single-column equi** relationship — the same propagatable shape
    /// used for filters and row-level security. The attribute is resolved by a
    /// many-to-one `LEFT JOIN` from the (already fetched, RLS-restricted, and
    /// limited) detail rows to the dimension on the relationship's key columns.
    /// Because the join is many-to-one and a `LEFT JOIN`, it is a pure lookup:
    /// it never drops a detail row, never duplicates one, and a detail row
    /// whose foreign key matches no dimension row keeps the row with `NULL`
    /// attributes.
    ///
    /// # Result column ordering and naming
    ///
    /// The result columns are the requested detail columns (or **all** detail
    /// columns when [`columns`](Self::columns) is empty) **first**, in their
    /// requested order, then the requested dimension attributes, in the order
    /// listed here. Each attribute is named by its bare `column` name; if that
    /// name would **collide** with a detail column or with another selected
    /// attribute, it is instead qualified as `"{table}.{column}"` (the model
    /// table name, a literal dot, the column name). The final schema always has
    /// unique column names.
    ///
    /// # Errors / scope
    ///
    /// Requesting an attribute on a table that is not single-hop active
    /// single-equi related to the detail table — including snowflake /
    /// multi-hop attributes (a dimension of a dimension) and non-equi /
    /// many-to-many / composite-key / inactive relationships — is rejected with
    /// [`InvalidQuery`](crate::error::QueryError::InvalidQuery). An unknown
    /// dimension table or an attribute column not present on the dimension is
    /// likewise a typed error. The feature is fail-closed: there is no silent
    /// partial or wrong join.
    ///
    /// # Security
    ///
    /// The attributes returned are guaranteed to belong only to dimension rows
    /// the active role permits. The detail rows are already restricted (by the
    /// existing dimension→detail propagation) to permitted dimension keys, and
    /// the dimension fetch additionally applies the active role's predicates on
    /// that dimension. The `LEFT JOIN` therefore can only attach attributes of
    /// permitted dimension rows, and never re-introduces a row the role
    /// excluded or changes the detail row set.
    pub dimension_columns: Vec<ColumnRef>,
    /// Context-driven calculated columns to compute per detail row.
    ///
    /// Each [`ColumnRef`] must name a [`ContextColumn`](engine_core::model::ContextColumn)
    /// defined on the **detail table**. Its scalar measure is resolved once from
    /// this request's filter context (exactly as in the aggregation path, so the
    /// per-row segment label matches the segmented cell the user drilled from),
    /// and the resulting row-level CASE is computed for each returned detail row
    /// and appended as an output column named by the context column.
    ///
    /// v1 supports only context columns whose row-level expression references
    /// the **host (detail) table's** own columns; a cross-table reference is
    /// rejected with [`InvalidQuery`](crate::error::QueryError::InvalidQuery).
    /// A scalar that resolves to `NULL` under the filters fails closed.
    pub context_columns: Vec<ColumnRef>,
    /// Cell-coordinate and slicer filters.
    ///
    /// Each [`FilterCondition`] is matched to the table that owns its named
    /// column. Filters on the **detail table** are applied directly; filters
    /// on a **related dimension** are propagated to the detail table (see the
    /// type-level docs). A filter whose column is not found on the detail
    /// table or any single-hop propagatable dimension is rejected.
    pub filters: Vec<FilterCondition>,
    /// ORDER BY clauses, by **detail-table columns only**.
    ///
    /// Each clause must be an [`OrderTarget::Column`] naming a detail-table
    /// column; an [`OrderTarget::Measure`] target is rejected (a drillthrough
    /// computes no measures). When empty, row order is source-defined.
    pub order_by: Vec<OrderByClause>,
    /// Mandatory cap on the number of returned rows, applied after ordering.
    ///
    /// `0` is allowed and returns an empty result. There is no default —
    /// every drillthrough must state its cap explicitly because DirectQuery
    /// fact tables are unbounded.
    pub limit: usize,
}

impl DetailRequest {
    /// Create a drillthrough request for `table` capped at `limit` rows.
    ///
    /// Starts with all columns (`columns` empty), no filters, and no
    /// ordering. Set the other fields with struct-update syntax. `limit` is
    /// required (and may be `0` for an explicitly empty request).
    pub fn new(table: impl Into<String>, limit: usize) -> Self {
        Self {
            table: table.into(),
            columns: Vec::new(),
            dimension_columns: Vec::new(),
            context_columns: Vec::new(),
            filters: Vec::new(),
            order_by: Vec::new(),
            limit,
        }
    }

    /// Return only the given detail-table columns (replacing any previously
    /// set). An empty list means all columns.
    pub fn with_columns<I, S>(mut self, columns: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.columns = columns.into_iter().map(Into::into).collect();
        self
    }

    /// Append dimension attributes to look up and display alongside the detail
    /// rows (replacing any previously set). See
    /// [`dimension_columns`](Self::dimension_columns) for the relationship
    /// requirements, ordering, and naming convention.
    pub fn with_dimension_columns(mut self, columns: Vec<ColumnRef>) -> Self {
        self.dimension_columns = columns;
        self
    }

    /// Append context-driven calculated columns to compute per detail row
    /// (replacing any previously set). See [`context_columns`](Self::context_columns).
    pub fn with_context_columns(mut self, columns: Vec<ColumnRef>) -> Self {
        self.context_columns = columns;
        self
    }

    /// Replace the filter conditions.
    pub fn with_filters(mut self, filters: Vec<FilterCondition>) -> Self {
        self.filters = filters;
        self
    }

    /// Replace the ORDER BY clauses.
    pub fn with_order_by(mut self, order_by: Vec<OrderByClause>) -> Self {
        self.order_by = order_by;
        self
    }
}

impl QueryRequest {
    /// The effective ORDER BY for this request: the explicit `order_by`
    /// clauses, or — when `order_by` is empty and `group_by` is not — the
    /// group-by columns in declaration order, ascending (the engine's
    /// default deterministic ordering).
    pub fn effective_order_by(&self) -> Vec<OrderByClause> {
        if !self.order_by.is_empty() {
            return self.order_by.clone();
        }
        self.group_by
            .iter()
            .map(|col| OrderByClause::column(col.table.clone(), col.column.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_connectors::FilterOperator;

    #[test]
    fn detail_request_new_sets_table_and_limit_with_empty_defaults() {
        let request = DetailRequest::new("Sales", 100);
        assert_eq!(request.table, "Sales");
        assert_eq!(request.limit, 100);
        assert!(
            request.columns.is_empty(),
            "empty columns means all columns"
        );
        assert!(request.filters.is_empty());
        assert!(request.order_by.is_empty());
    }

    #[test]
    fn detail_request_zero_limit_is_a_valid_empty_request() {
        let request = DetailRequest::new("Sales", 0);
        assert_eq!(request.limit, 0);
    }

    #[test]
    fn detail_request_builders_replace_fields() {
        let filters = vec![FilterCondition::new("region", FilterOperator::Equal, "West")];
        let request = DetailRequest::new("Sales", 50)
            .with_columns(["order_id", "amount"])
            .with_filters(filters.clone())
            .with_order_by(vec![OrderByClause::column("Sales", "order_id")]);

        assert_eq!(request.columns, vec!["order_id", "amount"]);
        assert_eq!(request.filters.len(), 1);
        assert_eq!(request.filters[0].column, "region");
        assert_eq!(request.order_by.len(), 1);
        match &request.order_by[0].target {
            OrderTarget::Column(col) => {
                assert_eq!(col.table, "Sales");
                assert_eq!(col.column, "order_id");
            }
            other => panic!("expected a column order target, got {other:?}"),
        }
    }

    #[test]
    fn detail_request_with_columns_empty_means_all() {
        let request = DetailRequest::new("Sales", 10).with_columns(Vec::<String>::new());
        assert!(request.columns.is_empty());
    }
}
