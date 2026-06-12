//! Query request types — the user-facing description of what to compute.

use engine_connectors::FilterCondition;

pub use engine_connectors::GROUPING_ID_COLUMN;

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
/// Requests with `totals = Rollup` return a typed `InvalidQuery` error when
/// combined with (support may be added later):
///
/// - lookup columns ([`QueryRequest::lookups`]),
/// - window measures (`WINDOW` / `OFFSET` / `INDEX`),
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
