//! Shared SQL-text construction for database connectors.
//!
//! PostgreSQL and SQL Server generate structurally identical SQL for plain
//! fetches, aggregate pushdown, inline IN lists, and temp-table filter
//! staging — they differ only in dialect details: identifier quoting,
//! bind-parameter placeholders, text-comparison casts, `LIMIT n` vs `TOP(n)`,
//! string-literal prefixes, and temp-table naming/DDL. Before this module
//! existed the two connectors duplicated the shared structure line-for-line,
//! and fixes applied to one silently missed the other (this happened with
//! escaping). The structure now lives here once, parameterized by
//! [`SqlDialect`].
//!
//! Only SQL **text** is built here. Execution concerns (connection pools,
//! pinned connections for temp-table visibility, row-to-Arrow conversion)
//! stay in each connector.
//!
//! The output of every builder is byte-identical to what the connectors
//! previously generated inline — the connectors' pinned SQL-string tests
//! enforce this.

use engine_core::compute::expression::{resolve_is_in_scope, Expression};
use engine_core::compute::sql_util::{quote_ident_bracket, quote_ident_double, sql_quote_literal};

use crate::error::ConnectorResult;
use crate::traits::{
    AggregateFunction, FetchRequest, FilterCondition, InFilterCondition, InValueKind,
    JoinAggregationRequest, OrderByTarget, QualifiedColumn, GROUPING_ID_COLUMN,
};

/// Dialect-specific SQL fragments.
///
/// Each method captures one point where PostgreSQL and SQL Server SQL text
/// diverges. Implementations delegate to the shared escaping helpers in
/// `engine_core::compute::sql_util` — they must never re-implement escaping.
pub(crate) trait SqlDialect {
    /// Default schema when a [`FetchRequest`] has no explicit schema
    /// (`"public"` for PostgreSQL, `"dbo"` for SQL Server).
    fn default_schema(&self) -> &'static str;

    /// Quote an identifier (`"name"` for PostgreSQL, `[name]` for SQL
    /// Server), escaping embedded quote characters.
    fn quote_ident(&self, name: &str) -> String;

    /// Bind-parameter placeholder for the 1-based parameter `index`
    /// (`$1` for PostgreSQL, `@P1` for SQL Server).
    fn placeholder(&self, index: usize) -> String;

    /// Wrap an already-quoted column for comparison against a text-typed
    /// value (`col::text` for PostgreSQL,
    /// `CAST(col AS NVARCHAR(MAX))` for SQL Server).
    fn text_filter_cast(&self, quoted_column: &str) -> String;

    /// Render an escaped single-quoted string literal (`'v'` for
    /// PostgreSQL, `N'v'` for SQL Server).
    fn string_literal(&self, value: &str) -> String;

    /// Row-limit fragment injected directly after `SELECT ` (empty for
    /// PostgreSQL, `TOP(n) ` for SQL Server).
    fn limit_prefix(&self, limit: Option<usize>) -> String;

    /// Row-limit fragment appended at the end of the statement
    /// (` LIMIT n` for PostgreSQL, empty for SQL Server).
    fn limit_suffix(&self, limit: Option<usize>) -> String;

    /// Column side of an inline `IN (...)` list for [`InValueKind::Text`]
    /// values.
    ///
    /// PostgreSQL leaves the column **uncast**: quoted literals are of
    /// "unknown" type and coerce to the column's actual type, keeping the
    /// predicate index-friendly. SQL Server keeps the
    /// `CAST(... AS NVARCHAR(MAX))` form for collation-sensitive text
    /// comparison.
    fn inline_in_text_column(&self, quoted_column: &str) -> String;

    /// Temp filter table name for a counter value (`_ef_N` for PostgreSQL,
    /// `#_ef_N` for SQL Server's session-local temp tables).
    fn temp_table_name(&self, id: u64) -> String;

    /// DDL creating a single-column (`val`) temp filter table.
    ///
    /// The column type follows the value kind: `BIGINT` for
    /// [`InValueKind::Integer`] so fact-table FK comparisons need no casts;
    /// the dialect's text type (`TEXT` / `NVARCHAR(MAX)`) otherwise.
    fn temp_table_ddl(&self, name: &str, kind: InValueKind) -> String;

    /// Name of the grouping-id function used with `GROUP BY ROLLUP`
    /// (`GROUPING` on PostgreSQL, `GROUPING_ID` on SQL Server).
    ///
    /// Both functions return an integer bitmask over their arguments with
    /// the **rightmost argument as the least-significant bit**. The engine
    /// contract wants `group_by[0]` as the LSB, so [`grouping_id_select`]
    /// passes the group-by columns in **reverse** order.
    fn grouping_id_function(&self) -> &'static str;
}

/// PostgreSQL dialect (`"ident"`, `$1`, `::text`, `LIMIT n`, `'literal'`).
pub(crate) struct PostgresDialect;

impl SqlDialect for PostgresDialect {
    fn default_schema(&self) -> &'static str {
        "public"
    }

    fn quote_ident(&self, name: &str) -> String {
        quote_ident_double(name)
    }

    fn placeholder(&self, index: usize) -> String {
        format!("${index}")
    }

    fn text_filter_cast(&self, quoted_column: &str) -> String {
        format!("{quoted_column}::text")
    }

    fn string_literal(&self, value: &str) -> String {
        sql_quote_literal(value)
    }

    fn limit_prefix(&self, _limit: Option<usize>) -> String {
        String::new()
    }

    fn limit_suffix(&self, limit: Option<usize>) -> String {
        limit.map(|n| format!(" LIMIT {n}")).unwrap_or_default()
    }

    fn inline_in_text_column(&self, quoted_column: &str) -> String {
        quoted_column.to_string()
    }

    fn temp_table_name(&self, id: u64) -> String {
        format!("_ef_{id}")
    }

    fn temp_table_ddl(&self, name: &str, kind: InValueKind) -> String {
        let col_type = match kind {
            InValueKind::Integer => "BIGINT",
            InValueKind::Text => "TEXT",
        };
        format!(
            "CREATE TEMP TABLE {} (val {col_type})",
            quote_ident_double(name)
        )
    }

    fn grouping_id_function(&self) -> &'static str {
        "GROUPING"
    }
}

/// SQL Server dialect (`[ident]`, `@P1`, `CAST(... AS NVARCHAR(MAX))`,
/// `TOP(n)`, `N'literal'`).
pub(crate) struct SqlServerDialect;

impl SqlDialect for SqlServerDialect {
    fn default_schema(&self) -> &'static str {
        "dbo"
    }

    fn quote_ident(&self, name: &str) -> String {
        quote_ident_bracket(name)
    }

    fn placeholder(&self, index: usize) -> String {
        format!("@P{index}")
    }

    fn text_filter_cast(&self, quoted_column: &str) -> String {
        format!("CAST({quoted_column} AS NVARCHAR(MAX))")
    }

    fn string_literal(&self, value: &str) -> String {
        format!("N{}", sql_quote_literal(value))
    }

    fn limit_prefix(&self, limit: Option<usize>) -> String {
        limit.map(|n| format!("TOP({n}) ")).unwrap_or_default()
    }

    fn limit_suffix(&self, _limit: Option<usize>) -> String {
        String::new()
    }

    fn inline_in_text_column(&self, quoted_column: &str) -> String {
        self.text_filter_cast(quoted_column)
    }

    fn temp_table_name(&self, id: u64) -> String {
        format!("#_ef_{id}")
    }

    fn temp_table_ddl(&self, name: &str, kind: InValueKind) -> String {
        let col_type = match kind {
            InValueKind::Integer => "BIGINT",
            InValueKind::Text => "NVARCHAR(MAX)",
        };
        format!(
            "CREATE TABLE {} (val {col_type})",
            quote_ident_bracket(name)
        )
    }

    fn grouping_id_function(&self) -> &'static str {
        "GROUPING_ID"
    }
}

/// Render the quoted `schema.table` reference for a request, falling back to
/// the dialect's default schema.
fn table_reference(dialect: &impl SqlDialect, request: &FetchRequest) -> String {
    let schema_name = request
        .schema
        .as_deref()
        .unwrap_or_else(|| dialect.default_schema());
    format!(
        "{}.{}",
        dialect.quote_ident(schema_name),
        dialect.quote_ident(&request.table)
    )
}

/// Render the SELECT column list for a plain (non-aggregate) fetch.
/// Empty `columns` means `*`.
fn select_columns_clause(dialect: &impl SqlDialect, columns: &[String]) -> String {
    if columns.is_empty() {
        "*".to_string()
    } else {
        columns
            .iter()
            .map(|c| dialect.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Render the SELECT list for an aggregate query: group-by columns followed
/// by one aggregate expression per [`crate::traits::AggregateExpr`], plus a
/// trailing grouping-id column when the request asks for ROLLUP totals.
fn aggregate_select_clause(dialect: &impl SqlDialect, request: &FetchRequest) -> String {
    let mut select_parts: Vec<String> = request
        .group_by
        .iter()
        .map(|c| dialect.quote_ident(c))
        .collect();

    for agg in &request.aggregates {
        let func = agg.function.as_sql();
        let col = &agg.column;
        let default_alias = format!("{}_{}", func.to_lowercase(), col);
        let alias = agg.alias.as_deref().unwrap_or(&default_alias);
        if agg.function == AggregateFunction::CountDistinct {
            select_parts.push(format!(
                "{func}(DISTINCT {}) AS {}",
                dialect.quote_ident(col),
                dialect.quote_ident(alias)
            ));
        } else if agg.function == AggregateFunction::CountAll {
            select_parts.push(format!("COUNT(*) AS {}", dialect.quote_ident(alias)));
        } else {
            select_parts.push(format!(
                "{func}({}) AS {}",
                dialect.quote_ident(col),
                dialect.quote_ident(alias)
            ));
        }
    }

    if request.rollup_totals {
        select_parts.push(grouping_id_select(dialect, &request.group_by));
    }

    select_parts.join(", ")
}

/// Render the trailing grouping-id SELECT item for a ROLLUP totals query.
///
/// Both PostgreSQL's `GROUPING(...)` and SQL Server's `GROUPING_ID(...)`
/// treat the **rightmost** argument as the least-significant bit, while the
/// engine contract puts `group_by[0]` at the LSB — so the group-by columns
/// are passed in reverse order. With no group-by columns the single
/// aggregate row is its own grand total and the grouping id is a literal
/// `0` (no bits exist to set).
fn grouping_id_select(dialect: &impl SqlDialect, group_by: &[String]) -> String {
    let alias = dialect.quote_ident(GROUPING_ID_COLUMN);
    if group_by.is_empty() {
        return format!("0 AS {alias}");
    }
    let args: Vec<String> = group_by
        .iter()
        .rev()
        .map(|c| dialect.quote_ident(c))
        .collect();
    format!(
        "{}({}) AS {alias}",
        dialect.grouping_id_function(),
        args.join(", ")
    )
}

/// Append ` GROUP BY ...` when the request has group-by columns — as
/// ` GROUP BY ROLLUP (...)` when the request asks for ROLLUP totals.
fn push_group_by(dialect: &impl SqlDialect, sql: &mut String, request: &FetchRequest) {
    if !request.group_by.is_empty() {
        let group_clause: Vec<String> = request
            .group_by
            .iter()
            .map(|c| dialect.quote_ident(c))
            .collect();
        if request.rollup_totals {
            sql.push_str(" GROUP BY ROLLUP (");
            sql.push_str(&group_clause.join(", "));
            sql.push(')');
        } else {
            sql.push_str(" GROUP BY ");
            sql.push_str(&group_clause.join(", "));
        }
    }
}

/// Append ` ORDER BY ...` when the request has order-by entries.
///
/// Rendered after `GROUP BY` and before any suffix row limit, so PostgreSQL
/// produces `... GROUP BY ... ORDER BY ... LIMIT n` while SQL Server's
/// `TOP(n)` prefix combines with the ORDER BY into a deterministic top-N.
fn push_order_by(dialect: &impl SqlDialect, sql: &mut String, request: &FetchRequest) {
    if request.order_by.is_empty() {
        return;
    }
    let parts: Vec<String> = request
        .order_by
        .iter()
        .map(|entry| {
            let expr = match &entry.target {
                OrderByTarget::Column(column) => dialect.quote_ident(column),
                OrderByTarget::MinColumn(column) => {
                    format!("MIN({})", dialect.quote_ident(column))
                }
                OrderByTarget::Alias(alias) => dialect.quote_ident(alias),
            };
            if entry.descending {
                format!("{expr} DESC")
            } else {
                expr
            }
        })
        .collect();
    sql.push_str(" ORDER BY ");
    sql.push_str(&parts.join(", "));
}

/// Build WHERE conditions from filter conditions.
///
/// - [`InValueKind::Integer`] (re-validated via
///   [`FilterCondition::effective_kind`]): the value is an unquoted numeric
///   literal compared against the **uncast** column, so a comparison on an
///   (typically indexed) integer column stays sargable on both dialects. The
///   value is validated as `i128`, so no untrusted string is ever inlined.
/// - [`InValueKind::Text`] (or failed integer validation): the value is a
///   bound parameter and the column is text-cast, so an arbitrary column type
///   compares safely against the bound string (the historical behavior).
pub(crate) fn build_filter_conditions(
    dialect: &impl SqlDialect,
    filters: &[FilterCondition],
    params: &mut Vec<String>,
) -> Vec<String> {
    filters
        .iter()
        .map(|filter| {
            let quoted_column = dialect.quote_ident(&filter.column);
            match filter.effective_kind() {
                InValueKind::Integer => format!(
                    "{quoted_column} {} {}",
                    filter.operator.as_sql(),
                    filter.value
                ),
                InValueKind::Text => {
                    params.push(filter.value.clone());
                    format!(
                        "{} {} {}",
                        dialect.text_filter_cast(&quoted_column),
                        filter.operator.as_sql(),
                        dialect.placeholder(params.len())
                    )
                }
            }
        })
        .collect()
}

/// Build an inline `col IN (...)` condition.
///
/// - [`InValueKind::Integer`] (re-validated via
///   [`InFilterCondition::effective_kind`]): values render as unquoted
///   numeric literals against the **uncast** column, so the (typically
///   indexed) FK comparison stays sargable on both dialects.
/// - [`InValueKind::Text`] (or failed integer validation): values are
///   escaped string literals; the column side is dialect-specific (see
///   [`SqlDialect::inline_in_text_column`]).
pub(crate) fn build_inline_in(dialect: &impl SqlDialect, in_filter: &InFilterCondition) -> String {
    let column = dialect.quote_ident(&in_filter.column);
    match in_filter.effective_kind() {
        InValueKind::Integer => format!("{column} IN ({})", in_filter.values.join(", ")),
        InValueKind::Text => {
            let quoted: Vec<String> = in_filter
                .values
                .iter()
                .map(|v| dialect.string_literal(v))
                .collect();
            format!(
                "{} IN ({})",
                dialect.inline_in_text_column(&column),
                quoted.join(", ")
            )
        }
    }
}

/// Build a `col IN (SELECT val FROM temp)` condition against a temp filter
/// table.
///
/// - [`InValueKind::Integer`]: `BIGINT` temp column — the FK is compared
///   directly, no cast on either side.
/// - [`InValueKind::Text`]: the temp column is concretely text-typed, so the
///   column side needs the dialect's text cast (unlike the inline IN list).
pub(crate) fn temp_in_condition(
    dialect: &impl SqlDialect,
    column: &str,
    temp_name: &str,
    kind: InValueKind,
) -> String {
    let quoted_column = dialect.quote_ident(column);
    let temp_ref = dialect.quote_ident(temp_name);
    match kind {
        InValueKind::Integer => format!("{quoted_column} IN (SELECT val FROM {temp_ref})"),
        InValueKind::Text => format!(
            "{} IN (SELECT val FROM {})",
            dialect.text_filter_cast(&quoted_column),
            temp_ref
        ),
    }
}

/// Build the multi-row `INSERT` statements populating a temp filter table,
/// chunked at 1000 rows each (the SQL Server table value constructor maximum;
/// values are inlined literals, so bind-parameter limits do not apply).
///
/// Integer values must already be validated by the caller (via
/// [`InFilterCondition::effective_kind`]); text values are escaped through
/// the dialect's string literal rendering.
pub(crate) fn temp_table_insert_statements(
    dialect: &impl SqlDialect,
    name: &str,
    values: &[String],
    kind: InValueKind,
) -> Vec<String> {
    values
        .chunks(1000)
        .map(|chunk| {
            let rows: Vec<String> = chunk
                .iter()
                .map(|v| match kind {
                    InValueKind::Integer => format!("({v})"),
                    InValueKind::Text => format!("({})", dialect.string_literal(v)),
                })
                .collect();
            format!(
                "INSERT INTO {} (val) VALUES {}",
                dialect.quote_ident(name),
                rows.join(", ")
            )
        })
        .collect()
}

/// Build the `DROP TABLE IF EXISTS` statement for a temp filter table.
pub(crate) fn temp_table_drop_sql(dialect: &impl SqlDialect, name: &str) -> String {
    format!("DROP TABLE IF EXISTS {}", dialect.quote_ident(name))
}

/// An always-false SQL predicate, used to render an IN filter whose value set
/// is **empty**. `x IN ()` is logically the empty set (matches nothing), so an
/// empty IN filter must restrict the result to zero rows — NOT be dropped.
/// Dropping it (the historical behavior) silently returned the whole table,
/// which is a correctness bug for a zero-match dimension filter and a
/// row-level-security leak when a role's dimension predicate matches no rows.
/// `1 = 0` is valid on PostgreSQL, SQL Server, and DataFusion alike.
pub(crate) const FALSE_PREDICATE: &str = "1 = 0";

/// Build conditions from a request's filters and (inline) IN filters,
/// appending bound values to `params`.
///
/// An IN filter with no values renders as [`FALSE_PREDICATE`] (matches
/// nothing), never skipped. Condition ordering is filters first, IN filters
/// after.
fn request_conditions(
    dialect: &impl SqlDialect,
    request: &FetchRequest,
    params: &mut Vec<String>,
) -> Vec<String> {
    let mut conditions = build_filter_conditions(dialect, &request.filters, params);
    for in_filter in &request.in_filters {
        if in_filter.values.is_empty() {
            conditions.push(FALSE_PREDICATE.to_string());
        } else {
            conditions.push(build_inline_in(dialect, in_filter));
        }
    }
    if let Some(or_clause) = build_or_groups(dialect, &request.or_groups, params) {
        conditions.push(or_clause);
    }
    conditions
}

/// Render a DNF OR restriction `(g1) OR (g2) OR ...` (each group AND-combined),
/// appending bound values to `params`. Returns `None` (no clause) when there
/// are no groups or any group is empty (an empty AND-group matches everything,
/// making the whole OR always true).
fn build_or_groups(
    dialect: &impl SqlDialect,
    or_groups: &[Vec<FilterCondition>],
    params: &mut Vec<String>,
) -> Option<String> {
    if or_groups.is_empty() || or_groups.iter().any(|g| g.is_empty()) {
        return None;
    }
    let groups: Vec<String> = or_groups
        .iter()
        .map(|group| {
            let conds = build_filter_conditions(dialect, group, params);
            format!("({})", conds.join(" AND "))
        })
        .collect();
    Some(format!("({})", groups.join(" OR ")))
}

/// Build a complete aggregate (`GROUP BY`) query from a request.
///
/// Returns `(sql, params)`; filter values are bound via the dialect's
/// placeholders while IN-filter values are inlined (escaped) literals.
pub(crate) fn build_aggregate_sql(
    dialect: &impl SqlDialect,
    request: &FetchRequest,
) -> (String, Vec<String>) {
    let mut sql = format!(
        "SELECT {}{} FROM {}",
        dialect.limit_prefix(request.limit),
        aggregate_select_clause(dialect, request),
        table_reference(dialect, request)
    );

    let mut params: Vec<String> = Vec::new();
    let conditions = request_conditions(dialect, request, &mut params);
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }

    push_group_by(dialect, &mut sql, request);
    push_order_by(dialect, &mut sql, request);
    sql.push_str(&dialect.limit_suffix(request.limit));

    (sql, params)
}

/// Build an aggregate query with externally pre-built WHERE conditions
/// (the temp-table fetch path, where conditions mix placeholders, inline IN
/// lists, and temp-table subqueries).
pub(crate) fn build_aggregate_sql_with_conditions(
    dialect: &impl SqlDialect,
    request: &FetchRequest,
    conditions: &[String],
) -> String {
    let mut sql = format!(
        "SELECT {}{} FROM {}",
        dialect.limit_prefix(request.limit),
        aggregate_select_clause(dialect, request),
        table_reference(dialect, request)
    );

    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }

    push_group_by(dialect, &mut sql, request);
    push_order_by(dialect, &mut sql, request);
    sql.push_str(&dialect.limit_suffix(request.limit));

    sql
}

/// Build a complete plain (non-aggregate) `SELECT` query from a request.
///
/// Returns `(sql, params)`; see [`build_aggregate_sql`] for the
/// parameterization rules.
pub(crate) fn build_select_sql(
    dialect: &impl SqlDialect,
    request: &FetchRequest,
) -> (String, Vec<String>) {
    let mut sql = format!(
        "SELECT {}{} FROM {}",
        dialect.limit_prefix(request.limit),
        select_columns_clause(dialect, &request.columns),
        table_reference(dialect, request)
    );

    let mut params: Vec<String> = Vec::new();
    let conditions = request_conditions(dialect, request, &mut params);
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }

    push_order_by(dialect, &mut sql, request);
    sql.push_str(&dialect.limit_suffix(request.limit));

    (sql, params)
}

/// Build a plain `SELECT` with externally pre-built WHERE conditions
/// (the temp-table fetch path).
pub(crate) fn build_select_sql_with_conditions(
    dialect: &impl SqlDialect,
    request: &FetchRequest,
    conditions: &[String],
) -> String {
    let mut sql = format!(
        "SELECT {}{} FROM {}",
        dialect.limit_prefix(request.limit),
        select_columns_clause(dialect, &request.columns),
        table_reference(dialect, request)
    );

    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }

    push_order_by(dialect, &mut sql, request);
    sql.push_str(&dialect.limit_suffix(request.limit));

    sql
}

/// A [`SqlDialect`] that can additionally render engine `Expression` trees —
/// the capability required to push a JOIN + aggregation / compound-measure /
/// context-column query to a source.
///
/// Only connectors that have an `engine_core` [`Dialect`] implement this
/// (PostgreSQL today). Because the shared [`build_join_aggregation_sql`] is
/// generic over `ExpressionDialect`, a connector that does *not* implement it
/// is structurally incapable of being handed a pushed join-aggregation, and the
/// planner's capability gate routes such queries to local aggregation.
///
/// [`Dialect`]: engine_core::compute::expression::Dialect
pub(crate) trait ExpressionDialect: SqlDialect {
    /// Render an (already ISINSCOPE-resolved) `Expression` to this dialect's
    /// SQL, qualifying column references through the connector `table_map` and
    /// using `group_by` for any CLEAR-to-window translation.
    fn render_join_expression(
        &self,
        expr: &Expression,
        table_map: &[(String, String)],
        group_by: &[QualifiedColumn],
    ) -> ConnectorResult<String>;
}

/// Build a pushed JOIN + aggregation query from a [`JoinAggregationRequest`].
///
/// Assembles `SELECT <group-by cols, computed group-by CASEs, measures> FROM
/// fact JOIN dims… WHERE filters GROUP BY <cols, computed CASEs>`. Identifier
/// quoting and filter binding come from the [`SqlDialect`]; the measure and
/// computed-group-by `Expression`s are rendered through
/// [`ExpressionDialect::render_join_expression`]. Returns `(sql, bound_params)`.
///
/// `JoinAggregationRequest` carries only `filters` (no `in_filters`/`or_groups`
/// — those force local aggregation upstream), so this renders the full request
/// restriction contract; a future change adding disjunctive restriction to the
/// join path must thread it here or keep forcing local.
pub(crate) fn build_join_aggregation_sql(
    dialect: &impl ExpressionDialect,
    request: &JoinAggregationRequest,
) -> ConnectorResult<(String, Vec<String>)> {
    // (model, column) pairs for the group-by columns, used to resolve ISINSCOPE
    // in expressions before SQL generation.
    let group_by_pairs: Vec<(String, String)> = request
        .table_map
        .iter()
        .flat_map(|(model, _)| {
            request
                .group_by
                .iter()
                .filter(move |col| {
                    request
                        .table_map
                        .iter()
                        .any(|(m, s)| m.eq_ignore_ascii_case(model) && s == &col.table)
                })
                .map(move |col| (model.clone(), col.column.clone()))
        })
        .collect();

    let mut select_parts: Vec<String> = Vec::new();
    let mut group_by_parts: Vec<String> = Vec::new();

    for col in &request.group_by {
        let qualified = format!(
            "{}.{}",
            dialect.quote_ident(&col.table),
            dialect.quote_ident(&col.column)
        );
        select_parts.push(qualified.clone());
        group_by_parts.push(qualified);
    }

    // Computed GROUP BY expressions (context-driven calculated columns): the
    // SAME renderer as measures, but each goes into BOTH the SELECT (aliased)
    // and the GROUP BY (raw).
    for cg in &request.computed_group_by {
        let resolved = resolve_is_in_scope(&cg.expression, &group_by_pairs);
        let expr_sql =
            dialect.render_join_expression(&resolved, &request.table_map, &request.group_by)?;
        select_parts.push(format!("{expr_sql} AS {}", dialect.quote_ident(&cg.alias)));
        group_by_parts.push(expr_sql);
    }

    for m in &request.measures {
        let resolved = resolve_is_in_scope(&m.expression, &group_by_pairs);
        let expr_sql =
            dialect.render_join_expression(&resolved, &request.table_map, &request.group_by)?;
        select_parts.push(format!("{expr_sql} AS {}", dialect.quote_ident(&m.alias)));
    }

    let mut sql = format!(
        "SELECT {} FROM {}.{}",
        select_parts.join(", "),
        dialect.quote_ident(&request.fact_schema),
        dialect.quote_ident(&request.fact_table)
    );

    for join in &request.joins {
        sql.push_str(&format!(
            " JOIN {}.{} ON {}.{} = {}.{}",
            dialect.quote_ident(&join.dim_schema),
            dialect.quote_ident(&join.dim_table),
            dialect.quote_ident(&request.fact_table),
            dialect.quote_ident(&join.fact_column),
            dialect.quote_ident(&join.dim_table),
            dialect.quote_ident(&join.dim_column),
        ));
    }

    // WHERE clause. Filter values are bound as parameters (like
    // `build_aggregate_sql`) so a value can never terminate the SQL string.
    let mut params: Vec<String> = Vec::new();
    if !request.filters.is_empty() {
        let where_parts = build_filter_conditions(dialect, &request.filters, &mut params);
        sql.push_str(&format!(" WHERE {}", where_parts.join(" AND ")));
    }

    if !group_by_parts.is_empty() {
        sql.push_str(&format!(" GROUP BY {}", group_by_parts.join(", ")));
    }

    Ok((sql, params))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::{AggregateExpr, FilterOperator};

    /// Test helper: build an [`InFilterCondition`] from string values.
    fn in_filter(column: &str, values: &[&str], kind: InValueKind) -> InFilterCondition {
        InFilterCondition {
            column: column.into(),
            values: values.iter().map(|v| v.to_string()).collect(),
            kind,
        }
    }

    // -- Dialect primitives -------------------------------------------------

    #[test]
    fn default_schema_per_dialect() {
        assert_eq!(PostgresDialect.default_schema(), "public");
        assert_eq!(SqlServerDialect.default_schema(), "dbo");
    }

    #[test]
    fn quote_ident_per_dialect() {
        assert_eq!(
            PostgresDialect.quote_ident("evil\"name"),
            "\"evil\"\"name\""
        );
        assert_eq!(SqlServerDialect.quote_ident("evil]name"), "[evil]]name]");
    }

    #[test]
    fn placeholder_per_dialect() {
        assert_eq!(PostgresDialect.placeholder(1), "$1");
        assert_eq!(PostgresDialect.placeholder(12), "$12");
        assert_eq!(SqlServerDialect.placeholder(1), "@P1");
        assert_eq!(SqlServerDialect.placeholder(12), "@P12");
    }

    #[test]
    fn text_filter_cast_per_dialect() {
        assert_eq!(PostgresDialect.text_filter_cast("\"col\""), "\"col\"::text");
        assert_eq!(
            SqlServerDialect.text_filter_cast("[col]"),
            "CAST([col] AS NVARCHAR(MAX))"
        );
    }

    #[test]
    fn string_literal_per_dialect_escapes_quotes() {
        assert_eq!(PostgresDialect.string_literal("O'Brien"), "'O''Brien'");
        assert_eq!(SqlServerDialect.string_literal("O'Brien"), "N'O''Brien'");
    }

    #[test]
    fn limit_renders_as_suffix_on_postgres_and_prefix_on_sqlserver() {
        assert_eq!(PostgresDialect.limit_prefix(Some(10)), "");
        assert_eq!(PostgresDialect.limit_suffix(Some(10)), " LIMIT 10");
        assert_eq!(SqlServerDialect.limit_prefix(Some(10)), "TOP(10) ");
        assert_eq!(SqlServerDialect.limit_suffix(Some(10)), "");
        // No limit: both fragments empty on both dialects.
        assert_eq!(PostgresDialect.limit_suffix(None), "");
        assert_eq!(SqlServerDialect.limit_prefix(None), "");
    }

    #[test]
    fn inline_in_text_column_uncast_on_postgres_cast_on_sqlserver() {
        assert_eq!(PostgresDialect.inline_in_text_column("\"col\""), "\"col\"");
        assert_eq!(
            SqlServerDialect.inline_in_text_column("[col]"),
            "CAST([col] AS NVARCHAR(MAX))"
        );
    }

    #[test]
    fn temp_table_name_per_dialect() {
        assert_eq!(PostgresDialect.temp_table_name(7), "_ef_7");
        assert_eq!(SqlServerDialect.temp_table_name(7), "#_ef_7");
    }

    #[test]
    fn temp_table_ddl_per_dialect_and_kind() {
        assert_eq!(
            PostgresDialect.temp_table_ddl("_ef_0", InValueKind::Integer),
            "CREATE TEMP TABLE \"_ef_0\" (val BIGINT)"
        );
        assert_eq!(
            PostgresDialect.temp_table_ddl("_ef_0", InValueKind::Text),
            "CREATE TEMP TABLE \"_ef_0\" (val TEXT)"
        );
        assert_eq!(
            SqlServerDialect.temp_table_ddl("#_ef_0", InValueKind::Integer),
            "CREATE TABLE [#_ef_0] (val BIGINT)"
        );
        assert_eq!(
            SqlServerDialect.temp_table_ddl("#_ef_0", InValueKind::Text),
            "CREATE TABLE [#_ef_0] (val NVARCHAR(MAX))"
        );
    }

    // -- Shared builders ----------------------------------------------------

    #[test]
    fn build_filter_conditions_numbers_placeholders_sequentially() {
        let filters = vec![
            FilterCondition::new("status", FilterOperator::Equal, "active"),
            FilterCondition::new("region", FilterOperator::NotEqual, "north"),
        ];

        let mut params = Vec::new();
        let pg = build_filter_conditions(&PostgresDialect, &filters, &mut params);
        assert_eq!(pg[0], "\"status\"::text = $1");
        assert_eq!(pg[1], "\"region\"::text <> $2");
        assert_eq!(params, vec!["active".to_string(), "north".to_string()]);

        let mut params = Vec::new();
        let ss = build_filter_conditions(&SqlServerDialect, &filters, &mut params);
        assert_eq!(ss[0], "CAST([status] AS NVARCHAR(MAX)) = @P1");
        assert_eq!(ss[1], "CAST([region] AS NVARCHAR(MAX)) <> @P2");
        assert_eq!(params, vec!["active".to_string(), "north".to_string()]);
    }

    #[test]
    fn build_filter_conditions_integer_kind_is_sargable_uncast_literal() {
        // An integer-kind scalar filter renders as `col op <literal>` against
        // the UNcast column with no bind parameter, so a source index is
        // usable — the scalar analogue of the integer IN-list optimization.
        let filters = vec![
            FilterCondition::new("region_id", FilterOperator::Equal, "5")
                .with_kind(InValueKind::Integer),
            FilterCondition::new("qty", FilterOperator::GreaterThan, "100")
                .with_kind(InValueKind::Integer),
        ];

        let mut params = Vec::new();
        let pg = build_filter_conditions(&PostgresDialect, &filters, &mut params);
        assert_eq!(pg[0], "\"region_id\" = 5");
        assert_eq!(pg[1], "\"qty\" > 100");
        assert!(params.is_empty(), "integer literals are inlined, not bound");

        let mut params = Vec::new();
        let ss = build_filter_conditions(&SqlServerDialect, &filters, &mut params);
        assert_eq!(ss[0], "[region_id] = 5");
        assert_eq!(ss[1], "[qty] > 100");
        assert!(params.is_empty());
    }

    #[test]
    fn build_filter_conditions_integer_kind_falls_back_when_value_not_integer() {
        // Defense in depth: a value that does not parse as an integer is never
        // inlined unquoted — it falls back to the safe bound-parameter path.
        let filters = vec![
            FilterCondition::new("region_id", FilterOperator::Equal, "5; DROP")
                .with_kind(InValueKind::Integer),
        ];
        let mut params = Vec::new();
        let pg = build_filter_conditions(&PostgresDialect, &filters, &mut params);
        assert_eq!(pg[0], "\"region_id\"::text = $1");
        assert_eq!(params, vec!["5; DROP".to_string()]);
    }

    #[test]
    fn build_inline_in_text_kind_diverges_per_dialect() {
        let filter = in_filter("region", &["north", "south"], InValueKind::Text);
        assert_eq!(
            build_inline_in(&PostgresDialect, &filter),
            "\"region\" IN ('north', 'south')"
        );
        assert_eq!(
            build_inline_in(&SqlServerDialect, &filter),
            "CAST([region] AS NVARCHAR(MAX)) IN (N'north', N'south')"
        );
    }

    #[test]
    fn build_inline_in_integer_kind_is_uncast_on_both_dialects() {
        let filter = in_filter("product_id", &["1", "2", "3"], InValueKind::Integer);
        assert_eq!(
            build_inline_in(&PostgresDialect, &filter),
            "\"product_id\" IN (1, 2, 3)"
        );
        assert_eq!(
            build_inline_in(&SqlServerDialect, &filter),
            "[product_id] IN (1, 2, 3)"
        );
    }

    #[test]
    fn build_inline_in_hostile_integer_downgrades_to_text_on_both_dialects() {
        let filter = in_filter("id", &["1", "2); DROP TABLE t; --"], InValueKind::Integer);
        assert_eq!(
            build_inline_in(&PostgresDialect, &filter),
            "\"id\" IN ('1', '2); DROP TABLE t; --')"
        );
        assert_eq!(
            build_inline_in(&SqlServerDialect, &filter),
            "CAST([id] AS NVARCHAR(MAX)) IN (N'1', N'2); DROP TABLE t; --')"
        );
    }

    #[test]
    fn temp_in_condition_per_dialect_and_kind() {
        assert_eq!(
            temp_in_condition(&PostgresDialect, "fk", "_ef_0", InValueKind::Integer),
            "\"fk\" IN (SELECT val FROM \"_ef_0\")"
        );
        assert_eq!(
            temp_in_condition(&PostgresDialect, "fk", "_ef_0", InValueKind::Text),
            "\"fk\"::text IN (SELECT val FROM \"_ef_0\")"
        );
        assert_eq!(
            temp_in_condition(&SqlServerDialect, "fk", "#_ef_0", InValueKind::Integer),
            "[fk] IN (SELECT val FROM [#_ef_0])"
        );
        assert_eq!(
            temp_in_condition(&SqlServerDialect, "fk", "#_ef_0", InValueKind::Text),
            "CAST([fk] AS NVARCHAR(MAX)) IN (SELECT val FROM [#_ef_0])"
        );
    }

    #[test]
    fn temp_table_insert_statements_chunk_at_1000_rows() {
        let values: Vec<String> = (0..1001).map(|i| i.to_string()).collect();
        let statements =
            temp_table_insert_statements(&PostgresDialect, "_ef_0", &values, InValueKind::Integer);
        assert_eq!(statements.len(), 2);
        assert!(statements[0].starts_with("INSERT INTO \"_ef_0\" (val) VALUES (0), (1), "));
        assert_eq!(statements[1], "INSERT INTO \"_ef_0\" (val) VALUES (1000)");
    }

    #[test]
    fn temp_table_insert_statements_escape_text_values_per_dialect() {
        let values = vec!["O'Brien".to_string()];
        let pg =
            temp_table_insert_statements(&PostgresDialect, "_ef_0", &values, InValueKind::Text);
        assert_eq!(pg, vec!["INSERT INTO \"_ef_0\" (val) VALUES ('O''Brien')"]);

        let ss =
            temp_table_insert_statements(&SqlServerDialect, "#_ef_0", &values, InValueKind::Text);
        assert_eq!(ss, vec!["INSERT INTO [#_ef_0] (val) VALUES (N'O''Brien')"]);
    }

    #[test]
    fn temp_table_drop_sql_quotes_name_per_dialect() {
        assert_eq!(
            temp_table_drop_sql(&PostgresDialect, "_ef_3"),
            "DROP TABLE IF EXISTS \"_ef_3\""
        );
        assert_eq!(
            temp_table_drop_sql(&SqlServerDialect, "#_ef_3"),
            "DROP TABLE IF EXISTS [#_ef_3]"
        );
    }

    /// One shared input, two dialects: the full aggregate builder must
    /// produce the two known divergent SQL strings.
    #[test]
    fn same_fetch_request_produces_both_known_dialect_forms() {
        let request = FetchRequest {
            schema: Some("sales".into()),
            table: "orders".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Sum,
                alias: Some("total".into()),
            }],
            filters: vec![FilterCondition::new(
                "status",
                FilterOperator::Equal,
                "active",
            )],
            group_by: vec!["region".into()],
            limit: Some(10),
            ..Default::default()
        };

        let (pg_sql, pg_params) = build_aggregate_sql(&PostgresDialect, &request);
        assert_eq!(
            pg_sql,
            "SELECT \"region\", SUM(\"amount\") AS \"total\" FROM \"sales\".\"orders\" \
             WHERE \"status\"::text = $1 GROUP BY \"region\" LIMIT 10"
        );
        assert_eq!(pg_params, vec!["active".to_string()]);

        let (ss_sql, ss_params) = build_aggregate_sql(&SqlServerDialect, &request);
        assert_eq!(
            ss_sql,
            "SELECT TOP(10) [region], SUM([amount]) AS [total] FROM [sales].[orders] \
             WHERE CAST([status] AS NVARCHAR(MAX)) = @P1 GROUP BY [region]"
        );
        assert_eq!(ss_params, vec!["active".to_string()]);
    }

    /// ORDER BY + LIMIT pinned per dialect: PostgreSQL renders
    /// `ORDER BY ... LIMIT n` after GROUP BY, SQL Server combines
    /// `TOP(n)` with the trailing ORDER BY.
    #[test]
    fn build_aggregate_sql_with_order_by_and_limit_pinned_per_dialect() {
        use crate::traits::{OrderByExpr, OrderByTarget};

        let request = FetchRequest {
            schema: Some("sales".into()),
            table: "orders".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Sum,
                alias: Some("total".into()),
            }],
            group_by: vec!["region".into()],
            order_by: vec![
                OrderByExpr {
                    target: OrderByTarget::Column("region".into()),
                    descending: false,
                },
                OrderByExpr {
                    target: OrderByTarget::Alias("total".into()),
                    descending: true,
                },
            ],
            limit: Some(10),
            ..Default::default()
        };

        let (pg_sql, _) = build_aggregate_sql(&PostgresDialect, &request);
        assert_eq!(
            pg_sql,
            "SELECT \"region\", SUM(\"amount\") AS \"total\" FROM \"sales\".\"orders\" \
             GROUP BY \"region\" ORDER BY \"region\", \"total\" DESC LIMIT 10"
        );

        let (ss_sql, _) = build_aggregate_sql(&SqlServerDialect, &request);
        assert_eq!(
            ss_sql,
            "SELECT TOP(10) [region], SUM([amount]) AS [total] FROM [sales].[orders] \
             GROUP BY [region] ORDER BY [region], [total] DESC"
        );
    }

    /// Sort-by-column substitution renders as `MIN(sort_col)` in the pushed
    /// ORDER BY (the sort column is not in the GROUP BY clause).
    #[test]
    fn build_aggregate_sql_with_min_order_target_pinned_per_dialect() {
        use crate::traits::{OrderByExpr, OrderByTarget};

        let request = FetchRequest {
            schema: Some("dw".into()),
            table: "dim_date".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Sum,
                alias: Some("Revenue".into()),
            }],
            group_by: vec!["month_name".into()],
            order_by: vec![OrderByExpr {
                target: OrderByTarget::MinColumn("month_number".into()),
                descending: false,
            }],
            ..Default::default()
        };

        let (pg_sql, _) = build_aggregate_sql(&PostgresDialect, &request);
        assert_eq!(
            pg_sql,
            "SELECT \"month_name\", SUM(\"amount\") AS \"Revenue\" FROM \"dw\".\"dim_date\" \
             GROUP BY \"month_name\" ORDER BY MIN(\"month_number\")"
        );

        let (ss_sql, _) = build_aggregate_sql(&SqlServerDialect, &request);
        assert_eq!(
            ss_sql,
            "SELECT [month_name], SUM([amount]) AS [Revenue] FROM [dw].[dim_date] \
             GROUP BY [month_name] ORDER BY MIN([month_number])"
        );
    }

    #[test]
    fn build_select_sql_with_order_by_renders_before_limit() {
        use crate::traits::{OrderByExpr, OrderByTarget};

        let request = FetchRequest {
            schema: Some("s".into()),
            table: "t".into(),
            columns: vec!["id".into()],
            order_by: vec![OrderByExpr {
                target: OrderByTarget::Column("id".into()),
                descending: true,
            }],
            limit: Some(3),
            ..Default::default()
        };

        let (pg_sql, _) = build_select_sql(&PostgresDialect, &request);
        assert_eq!(
            pg_sql,
            "SELECT \"id\" FROM \"s\".\"t\" ORDER BY \"id\" DESC LIMIT 3"
        );

        let (ss_sql, _) = build_select_sql(&SqlServerDialect, &request);
        assert_eq!(ss_sql, "SELECT TOP(3) [id] FROM [s].[t] ORDER BY [id] DESC");
    }

    /// ROLLUP totals pinned per dialect: `GROUP BY ROLLUP (a, b)` plus a
    /// trailing grouping-id column. The grouping function's argument order is
    /// **reversed** relative to the group-by list because both PostgreSQL's
    /// `GROUPING` and SQL Server's `GROUPING_ID` put the rightmost argument
    /// in the least-significant bit, while the engine contract wants
    /// `group_by[0]` at the LSB.
    #[test]
    fn build_aggregate_sql_with_rollup_totals_pinned_per_dialect() {
        let request = FetchRequest {
            schema: Some("sales".into()),
            table: "orders".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Sum,
                alias: Some("total".into()),
            }],
            group_by: vec!["region".into(), "product".into()],
            rollup_totals: true,
            ..Default::default()
        };

        let (pg_sql, _) = build_aggregate_sql(&PostgresDialect, &request);
        assert_eq!(
            pg_sql,
            "SELECT \"region\", \"product\", SUM(\"amount\") AS \"total\", \
             GROUPING(\"product\", \"region\") AS \"__grouping_id\" \
             FROM \"sales\".\"orders\" GROUP BY ROLLUP (\"region\", \"product\")"
        );

        let (ss_sql, _) = build_aggregate_sql(&SqlServerDialect, &request);
        assert_eq!(
            ss_sql,
            "SELECT [region], [product], SUM([amount]) AS [total], \
             GROUPING_ID([product], [region]) AS [__grouping_id] \
             FROM [sales].[orders] GROUP BY ROLLUP ([region], [product])"
        );
    }

    /// Single-dimension ROLLUP: the grouping function takes one argument and
    /// the bitmask is just that column's grouping flag.
    #[test]
    fn build_aggregate_sql_with_rollup_single_dim_pinned_per_dialect() {
        let request = FetchRequest {
            schema: Some("s".into()),
            table: "t".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Avg,
                alias: Some("AvgAmount".into()),
            }],
            group_by: vec!["region".into()],
            rollup_totals: true,
            ..Default::default()
        };

        let (pg_sql, _) = build_aggregate_sql(&PostgresDialect, &request);
        assert_eq!(
            pg_sql,
            "SELECT \"region\", AVG(\"amount\") AS \"AvgAmount\", \
             GROUPING(\"region\") AS \"__grouping_id\" \
             FROM \"s\".\"t\" GROUP BY ROLLUP (\"region\")"
        );

        let (ss_sql, _) = build_aggregate_sql(&SqlServerDialect, &request);
        assert_eq!(
            ss_sql,
            "SELECT [region], AVG([amount]) AS [AvgAmount], \
             GROUPING_ID([region]) AS [__grouping_id] \
             FROM [s].[t] GROUP BY ROLLUP ([region])"
        );
    }

    /// ROLLUP totals without group-by columns: the lone aggregate row is its
    /// own grand total — a literal `0` grouping id, no GROUP BY clause.
    #[test]
    fn build_aggregate_sql_rollup_without_group_by_renders_literal_zero() {
        let request = FetchRequest {
            schema: Some("s".into()),
            table: "t".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Sum,
                alias: Some("total".into()),
            }],
            rollup_totals: true,
            ..Default::default()
        };

        let (pg_sql, _) = build_aggregate_sql(&PostgresDialect, &request);
        assert_eq!(
            pg_sql,
            "SELECT SUM(\"amount\") AS \"total\", 0 AS \"__grouping_id\" FROM \"s\".\"t\""
        );

        let (ss_sql, _) = build_aggregate_sql(&SqlServerDialect, &request);
        assert_eq!(
            ss_sql,
            "SELECT SUM([amount]) AS [total], 0 AS [__grouping_id] FROM [s].[t]"
        );
    }

    /// ROLLUP combines with ORDER BY and LIMIT: the limit caps the combined
    /// result (details + subtotal rows) on both dialects.
    #[test]
    fn build_aggregate_sql_rollup_with_order_by_and_limit() {
        use crate::traits::{OrderByExpr, OrderByTarget};

        let request = FetchRequest {
            schema: Some("s".into()),
            table: "t".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Sum,
                alias: Some("total".into()),
            }],
            group_by: vec!["region".into()],
            order_by: vec![OrderByExpr {
                target: OrderByTarget::Alias("total".into()),
                descending: true,
            }],
            limit: Some(5),
            rollup_totals: true,
            ..Default::default()
        };

        let (pg_sql, _) = build_aggregate_sql(&PostgresDialect, &request);
        assert_eq!(
            pg_sql,
            "SELECT \"region\", SUM(\"amount\") AS \"total\", \
             GROUPING(\"region\") AS \"__grouping_id\" FROM \"s\".\"t\" \
             GROUP BY ROLLUP (\"region\") ORDER BY \"total\" DESC LIMIT 5"
        );

        let (ss_sql, _) = build_aggregate_sql(&SqlServerDialect, &request);
        assert_eq!(
            ss_sql,
            "SELECT TOP(5) [region], SUM([amount]) AS [total], \
             GROUPING_ID([region]) AS [__grouping_id] FROM [s].[t] \
             GROUP BY ROLLUP ([region]) ORDER BY [total] DESC"
        );
    }

    #[test]
    fn build_aggregate_sql_uses_dialect_default_schema() {
        let request = FetchRequest {
            schema: None,
            table: "orders".into(),
            aggregates: vec![AggregateExpr {
                column: "id".into(),
                function: AggregateFunction::Count,
                alias: None,
            }],
            ..Default::default()
        };
        let (pg_sql, _) = build_aggregate_sql(&PostgresDialect, &request);
        assert!(pg_sql.contains("\"public\".\"orders\""), "{pg_sql}");
        let (ss_sql, _) = build_aggregate_sql(&SqlServerDialect, &request);
        assert!(ss_sql.contains("[dbo].[orders]"), "{ss_sql}");
    }

    #[test]
    fn build_aggregate_sql_default_alias_lowercases_function_name() {
        let request = FetchRequest {
            schema: Some("s".into()),
            table: "t".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Max,
                alias: None,
            }],
            ..Default::default()
        };
        let (sql, _) = build_aggregate_sql(&PostgresDialect, &request);
        assert_eq!(
            sql,
            "SELECT MAX(\"amount\") AS \"max_amount\" FROM \"s\".\"t\""
        );
    }

    #[test]
    fn build_select_sql_with_filters_in_filters_and_limit() {
        let request = FetchRequest {
            schema: Some("sales".into()),
            table: "orders".into(),
            columns: vec!["id".into(), "amount".into()],
            filters: vec![FilterCondition::new(
                "status",
                FilterOperator::Equal,
                "active",
            )],
            in_filters: vec![in_filter("region_id", &["1", "2"], InValueKind::Integer)],
            limit: Some(5),
            ..Default::default()
        };

        let (pg_sql, pg_params) = build_select_sql(&PostgresDialect, &request);
        assert_eq!(
            pg_sql,
            "SELECT \"id\", \"amount\" FROM \"sales\".\"orders\" \
             WHERE \"status\"::text = $1 AND \"region_id\" IN (1, 2) LIMIT 5"
        );
        assert_eq!(pg_params, vec!["active".to_string()]);

        let (ss_sql, ss_params) = build_select_sql(&SqlServerDialect, &request);
        assert_eq!(
            ss_sql,
            "SELECT TOP(5) [id], [amount] FROM [sales].[orders] \
             WHERE CAST([status] AS NVARCHAR(MAX)) = @P1 AND [region_id] IN (1, 2)"
        );
        assert_eq!(ss_params, vec!["active".to_string()]);
    }

    #[test]
    fn empty_in_filter_renders_false_predicate_not_skipped() {
        // An IN filter with no values means "match nothing" — it must render
        // as a false predicate (1 = 0), never be dropped (which would return
        // the whole table: a correctness bug and an RLS leak).
        let request = FetchRequest {
            schema: Some("sales".into()),
            table: "orders".into(),
            in_filters: vec![in_filter("region_id", &[], InValueKind::Integer)],
            ..Default::default()
        };
        let (pg_sql, _) = build_select_sql(&PostgresDialect, &request);
        assert!(
            pg_sql.contains("WHERE 1 = 0"),
            "empty IN must render WHERE 1 = 0, got: {pg_sql}"
        );
        let (pg_agg, _) = build_aggregate_sql(&PostgresDialect, &request);
        assert!(pg_agg.contains("1 = 0"), "aggregate path: {pg_agg}");
        let (ss_sql, _) = build_select_sql(&SqlServerDialect, &request);
        assert!(ss_sql.contains("WHERE 1 = 0"), "sqlserver: {ss_sql}");
    }

    #[test]
    fn empty_in_filter_combines_with_other_conditions() {
        let request = FetchRequest {
            schema: Some("sales".into()),
            table: "orders".into(),
            in_filters: vec![
                in_filter("a", &["1"], InValueKind::Integer),
                in_filter("b", &[], InValueKind::Integer),
            ],
            ..Default::default()
        };
        let (sql, _) = build_select_sql(&PostgresDialect, &request);
        assert!(
            sql.contains("\"a\" IN (1) AND 1 = 0"),
            "empty IN must AND with other conditions: {sql}"
        );
    }

    #[test]
    fn build_select_sql_empty_columns_render_star() {
        let request = FetchRequest {
            schema: Some("s".into()),
            table: "t".into(),
            ..Default::default()
        };
        let (pg_sql, params) = build_select_sql(&PostgresDialect, &request);
        assert_eq!(pg_sql, "SELECT * FROM \"s\".\"t\"");
        assert!(params.is_empty());
    }

    #[test]
    fn build_select_sql_with_conditions_uses_prebuilt_where() {
        let request = FetchRequest {
            schema: Some("s".into()),
            table: "t".into(),
            limit: Some(3),
            ..Default::default()
        };
        let conditions = vec![
            "\"fk\" IN (SELECT val FROM \"_ef_0\")".to_string(),
            "\"status\"::text = $1".to_string(),
        ];
        let sql = build_select_sql_with_conditions(&PostgresDialect, &request, &conditions);
        assert_eq!(
            sql,
            "SELECT * FROM \"s\".\"t\" WHERE \"fk\" IN (SELECT val FROM \"_ef_0\") \
             AND \"status\"::text = $1 LIMIT 3"
        );

        // Empty conditions: no WHERE clause at all.
        let sql = build_select_sql_with_conditions(&PostgresDialect, &request, &[]);
        assert_eq!(sql, "SELECT * FROM \"s\".\"t\" LIMIT 3");
    }

    #[test]
    fn build_aggregate_sql_with_conditions_appends_group_by_after_where() {
        let request = FetchRequest {
            schema: Some("dbo".into()),
            table: "sales".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Sum,
                alias: Some("total".into()),
            }],
            group_by: vec!["region".into()],
            ..Default::default()
        };
        let conditions = vec!["[fk] IN (SELECT val FROM [#_ef_0])".to_string()];
        let sql = build_aggregate_sql_with_conditions(&SqlServerDialect, &request, &conditions);
        assert_eq!(
            sql,
            "SELECT [region], SUM([amount]) AS [total] FROM [dbo].[sales] \
             WHERE [fk] IN (SELECT val FROM [#_ef_0]) GROUP BY [region]"
        );
    }

    /// Pin the shared join-aggregation SQL: group-by + JOIN + a measure
    /// Expression (rendered via PostgreSQL's `ExpressionDialect`) + a bound
    /// WHERE filter. The connector's `execute_join_aggregation` is now a thin
    /// wrapper over this builder, so this is its byte-for-byte oracle.
    #[test]
    fn build_join_aggregation_sql_pinned_for_postgres() {
        use crate::traits::{JoinAggregationRequest, JoinClause, MeasureExpr, QualifiedColumn};
        use engine_core::compute::aggregate::AggregateOp;
        use engine_core::compute::expression as ec_expr;

        let request = JoinAggregationRequest {
            fact_schema: "sales".into(),
            fact_table: "orders".into(),
            joins: vec![JoinClause {
                dim_schema: "sales".into(),
                dim_table: "products".into(),
                fact_column: "product_id".into(),
                dim_column: "id".into(),
            }],
            measures: vec![MeasureExpr {
                expression: ec_expr::agg(
                    AggregateOp::Sum,
                    ec_expr::qualified_col("Sales", "amount"),
                ),
                alias: "total".into(),
            }],
            group_by: vec![QualifiedColumn {
                table: "products".into(),
                column: "category".into(),
            }],
            computed_group_by: vec![],
            filters: vec![FilterCondition::new(
                "status",
                FilterOperator::Equal,
                "active",
            )],
            table_map: vec![("Sales".into(), "orders".into())],
        };

        let (sql, params) = build_join_aggregation_sql(&PostgresDialect, &request).unwrap();
        assert_eq!(
            sql,
            "SELECT \"products\".\"category\", SUM(\"orders\".\"amount\") AS \"total\" \
             FROM \"sales\".\"orders\" JOIN \"sales\".\"products\" \
             ON \"orders\".\"product_id\" = \"products\".\"id\" \
             WHERE \"status\"::text = $1 GROUP BY \"products\".\"category\""
        );
        assert_eq!(params, vec!["active".to_string()]);
    }
}
