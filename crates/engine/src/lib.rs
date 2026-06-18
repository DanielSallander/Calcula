//! # Calcula Engine
//!
//! Unified API for the Calcula analytical engine library.
//!
//! This crate re-exports key types from `engine-core`, `engine-connectors`,
//! and `engine-query`, and provides a high-level [`Engine`] struct that
//! coordinates data model management, source registration, and query
//! execution.
//!
//! # Example
//!
//! ```rust,no_run
//! use bi_engine::*;
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let model = DataModel::builder()
//!     .add_table(Table::new("Sales", vec![
//!         Column::new("id", DataType::Int64),
//!         Column::new("amount", DataType::Float64),
//!     ])?)
//!     .add_measure(sum_measure("Revenue", "Sales", "amount"))
//!     .build()?;
//!
//! let mut engine = Engine::new(model);
//! let target = ConnectionTarget::new("localhost", "db").with_port(5432);
//! let auth = AuthMethod::UsernamePassword {
//!     username: "user".into(),
//!     password: "pass".into(),
//! };
//! let pg_idx = engine.add_postgres(target, auth).await?;
//! engine.bind_table("Sales", pg_idx, SourceBinding::new("public", "sales"));
//!
//! let results = engine.query(QueryRequest {
//!     measures: vec!["Revenue".into()],
//!     ..Default::default()
//! }).await?;
//! # Ok(())
//! # }
//! ```
//!
//! # Time intelligence
//!
//! Mark a date table and assign [`DateRole`]s to its columns to enable
//! `YTD`/`QTD`/`MTD`/`PRIORYEAR`/`PRIORPERIOD` measures. The functions use
//! **query-axis semantics**: the date table's role columns must be in the
//! query's `group_by` (Year plus a finer column for YTD), and the engine
//! lowers the measure onto a SQL window function over that axis.
//!
//! ```rust
//! use bi_engine::*;
//!
//! # fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let model = DataModel::builder()
//!     .add_table(Table::new("dim_date", vec![
//!         Column::new("date_id", DataType::Int64),
//!         Column::new("year", DataType::Int32).with_date_role(DateRole::Year),
//!         Column::new("month", DataType::Int32).with_date_role(DateRole::Month),
//!     ])?)
//!     .add_table(Table::new("fact_sales", vec![
//!         Column::new("date_id", DataType::Int64),
//!         Column::new("amount", DataType::Float64),
//!     ])?)
//!     .add_relationship(Relationship::many_to_one(
//!         "sales_date", "fact_sales", "date_id", "dim_date", "date_id",
//!     ))
//!     .mark_date_table("dim_date")
//!     .add_measure(expression_measure(
//!         "Revenue YTD",
//!         parse_measure_expression("YTD(SUM(fact_sales[amount]))")?,
//!     ))
//!     .build()?;
//!
//! // Query with group_by = [dim_date.year, dim_date.month] → running
//! // total per month that resets at each year boundary. PRIORYEAR works
//! // the same way: PRIORYEAR(SUM(fact_sales[amount])) reads the value of
//! // the same month one year earlier (blank for the first year).
//! # let _ = model;
//! # Ok(())
//! # }
//! ```

mod auto_tier;
mod disk_cache;
mod model_io;
mod query_cache;
mod refresh;

#[cfg(test)]
mod calc_group_tests;
#[cfg(test)]
mod detail_tests;
#[cfg(test)]
mod disk_cache_tests;
#[cfg(test)]
mod having_tests;
#[cfg(test)]
mod meta_tests;
#[cfg(test)]
mod rank_tests;
#[cfg(test)]
mod topn_tests;
#[cfg(test)]
mod in_filter_tests;
#[cfg(test)]
mod security_tests;
#[cfg(test)]
mod context_column_tests;
#[cfg(test)]
mod test_fixtures;

use std::sync::Arc;
use std::time::Instant;

use arrow::record_batch::RecordBatch;
use parking_lot::Mutex;

use auto_tier::AutoTierState;

pub use auto_tier::AutoTierConfig;
pub use query_cache::{QueryCacheConfig, QueryCacheStats};
pub use refresh::{RefreshFailure, RefreshReport, SourceQueryPolicy};

/// Cancellation token for [`Engine::query_with_cancellation`] (re-exported
/// from `tokio_util` so hosts don't need a direct dependency).
pub use tokio_util::sync::CancellationToken;

// --- Re-exports from engine-core ---

pub use engine_core::catalog::{function_catalog, FunctionInfo};
pub use engine_core::compute::aggregate::AggregateOp;
pub use engine_core::compute::context::{
    ContextResolver, EvaluationContext, FilterSource, ResolvedFilter, ResolvedInFilter,
};
pub use engine_core::compute::expression::{
    self, expand_global_variables, infer_fact_table, ArithmeticOp, ComparisonOp, DateGranularity,
    Expression, FilterPredicate, InPredicate, RelationshipPath,
};
pub use engine_core::compute::measure::{
    average_measure, count_measure, distinct_count_measure, expression_measure, sum_measure,
    Measure, MeasureGroup,
};
pub use engine_core::compute::measure_engine::MeasureEngine;
pub use engine_core::compute::parser::{
    parse_context, parse_global, parse_measure, parse_measure_expression, parse_table_variable,
};
pub use engine_core::compute::plan::{
    ExecutionPlan, PlanDuration, PlanNode, PlanOperation, PlanProperty, PlanValue,
};
pub use engine_core::compute::script::{
    ScriptFunction, ScriptFunctionBuilder, ScriptParam, ScriptSandboxConfig, ScriptType,
};
pub use engine_core::compute::udf::{
    create_udf, ColumnarValue, ScalarUDF, UdfRegistry, Volatility,
};
pub use engine_core::error::{EngineError, EngineResult};
pub use engine_core::model::schema::MODEL_FORMAT_VERSION;
pub use engine_core::model::{
    CalculatedColumn, CalculationGroup, CalculationItem, Cardinality, ClearTarget, Column,
    ContextColumn, ContextDefinition, ContextOp, DataModel, DataModelBuilder, DateRole,
    FilterPropagation, GlobalVariable, Hierarchy, HierarchyLevel, IncrementalRefresh, JoinCondition,
    JoinOperator, Kpi, KpiStatus, KpiTarget, RaggedBehavior, RefreshStrategy, Relationship,
    SecurityRole, StatusBand, StorageMode, Table, TableVariable,
};
pub use engine_core::optimize::{OptimizationStats, OptimizerConfig};
pub use engine_core::store::{ColumnStore, InMemoryCache, TableData};
pub use engine_core::types::{DataType, TableColumn, Value};

// --- Re-exports from engine-connectors ---

pub use engine_connectors::auth::{
    AuthMethod, AuthMethodKind, ConnectionSpec, ConnectionTarget, ConnectorAuth,
};
pub use engine_connectors::postgres::PostgresConnector;
pub use engine_connectors::sqlserver::SqlServerConnector;
pub use engine_connectors::traits::{
    AggregateExpr, AggregateFunction, Connector, FetchRequest, FilterCondition, FilterOperator,
    OrderByExpr, OrderByTarget, SourceTable,
};
pub use engine_connectors::{ConnectorError, ConnectorResult};

// --- Re-exports from engine-query ---

pub use engine_query::error::{QueryError, QueryResult};
pub use engine_query::csv_connector::CsvConnector;
pub use engine_query::in_memory_connector::InMemoryConnector;
pub use engine_query::parquet_connector::ParquetConnector;
pub use engine_query::registry::{AnyConnector, SourceBinding, SourceRegistry};
pub use engine_query::request::{
    CalculationGroupApplication, ColumnRef, DetailRequest, HierarchyGroupBy, InFilter,
    LookupColumn, MeasureFilter, OrderByClause, OrderTarget, QueryRequest, RankBy, ResultColumn,
    ResultColumnKind, TopN, TotalsMode, GROUPING_ID_COLUMN,
};
pub use engine_query::{
    effective_group_by, HierarchyLevelSpec, HierarchySpec, LookupSpec, PushdownPlanner,
    QueryExecutor, QueryPlan,
};

// ---------------------------------------------------------------------------

/// High-level engine facade coordinating model, sources, and queries.
///
/// The `Engine` owns a [`DataModel`], a [`SourceRegistry`], and an
/// [`InMemoryCache`] for tables configured with [`StorageMode::InMemory`].
/// Default threshold for inline IN-filter values before switching to temp tables.
const DEFAULT_MAX_INLINE_IN_VALUES: usize = 1000;

/// Maximum number of source fetches that run concurrently during bulk
/// refresh and auto-tier pre-warm operations. Bounded so that a model with
/// many tables does not open an unbounded number of simultaneous source
/// queries.
const MAX_CONCURRENT_FETCHES: usize = 4;

pub struct Engine {
    model: DataModel,
    registry: SourceRegistry,
    cache: InMemoryCache,
    /// Maximum number of IN-filter values to inline in SQL before switching
    /// to a temp-table strategy. Default: 1000.
    max_inline_in_values: usize,
    /// Configuration for automatic batch optimization on ingest.
    optimizer_config: OptimizerConfig,
    /// Configuration for automatic dimension caching.
    auto_tier_config: AutoTierConfig,
    /// Runtime state for auto-tiering (which tables are cached/rejected).
    /// Mutated only by `&mut self` paths ([`Engine::query_auto_tier`],
    /// [`Engine::auto_tier_remaining`]), so no interior mutability is needed.
    auto_tier_state: AutoTierState,
    /// LRU cache for query results.
    ///
    /// Behind a [`Mutex`] so the `&self` query paths can record hits and
    /// store results while the engine is shared across tasks
    /// (`Arc<Engine>`). Lock discipline: guards are held for synchronous
    /// cache operations only and are always dropped before any `.await`.
    query_cache: Mutex<query_cache::QueryCache>,
    /// Host policy for executing model-supplied `SourceQuery` poll SQL.
    source_query_policy: SourceQueryPolicy,
    /// Report from the most recent [`Engine::refresh_stale`] run.
    last_refresh_report: Option<RefreshReport>,
    /// Host-registered **native** scalar UDFs (see [`Engine::register_udf`]).
    /// Rebuilt (copy-on-write) on registration. This is the host's set; it is
    /// never threaded into queries directly — [`Engine::effective_udfs`] is.
    udfs: Arc<UdfRegistry>,
    /// Effective registry = native UDFs + compiled model script functions.
    /// Rebuilt whenever the model, the native set, or the sandbox config
    /// changes. This is the registry threaded into every query path and into
    /// [`Engine::validate_request_udfs`], so calls to model scripts resolve.
    effective_udfs: Arc<UdfRegistry>,
    /// Host policy: resource limits for the script sandbox. Conservative by
    /// default. Never part of the model (a malicious model cannot raise its
    /// own budget).
    script_sandbox_config: ScriptSandboxConfig,
    /// The active security roles, if any. Set by the host **after**
    /// authenticating the user (see [`Engine::set_active_role`] /
    /// [`Engine::set_active_roles`]). With one role, every query is restricted to
    /// the rows that role permits; with several, to the **union** (a row visible
    /// if *any* active role permits it). Empty = unrestricted by RLS. This is
    /// host-controlled session state, never part of any model.
    active_roles: Vec<String>,
    /// The current user identity, if set (DAX `USERNAME()`). Host-controlled
    /// session state set after authentication. A dynamic role predicate
    /// (`column = USERNAME()`) resolves to this; a query with such a predicate
    /// and no identity set **fails closed**. Folded into the query-cache key so a
    /// result computed for one user is never served to another.
    user_identity: Option<String>,
    /// Host-supplied custom data, if set (DAX `CUSTOMDATA()`). Like
    /// [`user_identity`](Self::user_identity) but for an arbitrary host string
    /// (e.g. a tenant id); also folded into the cache key.
    custom_data: Option<String>,
    /// Error captured by the most recent effective-registry rebuild, if any
    /// (currently only a native-vs-script name collision —
    /// [`Engine::new`] is infallible, so the error is deferred and surfaced
    /// on the next query or by [`Engine::validate_scripts`]). The model
    /// builder already rejects bad script bodies and built-in collisions at
    /// `build()` time, so this is the one error the rebuild can produce.
    script_build_error: Option<EngineError>,
}

/// Clone a deferred script-build [`EngineError`] so it can be returned from
/// multiple call sites.
///
/// [`EngineError`] is not `Clone` (its Arrow / DataFusion `#[from]` variants
/// wrap non-clonable errors), but a deferred script-build error is only ever
/// one of a few owned, string-bearing variants. This reconstructs those;
/// anything unexpected degrades to [`EngineError::InvalidData`] with the
/// formatted message rather than panicking.
fn clone_script_error(err: &EngineError) -> EngineError {
    match err {
        EngineError::ScriptError {
            function,
            position,
            message,
        } => EngineError::ScriptError {
            function: function.clone(),
            position: *position,
            message: message.clone(),
        },
        EngineError::DuplicateName(s) => EngineError::DuplicateName(s.clone()),
        EngineError::InvalidIdentifier { name, reason } => EngineError::InvalidIdentifier {
            name: name.clone(),
            reason: reason.clone(),
        },
        other => EngineError::InvalidData(other.to_string()),
    }
}

/// Re-map a script UDF runtime failure into a typed
/// [`EngineError::ScriptError`].
///
/// A sandbox abort (operation budget, recursion/string/array/map limit, type
/// error) raised inside a compiled script UDF surfaces from DataFusion as a
/// [`DataFusionError`] carrying an internal marker. This recovers the typed
/// error at the query boundary so hosts see a clear, named `ScriptError`
/// instead of an opaque DataFusion message. Non-script errors pass through
/// unchanged.
fn map_script_error<T>(result: QueryResult<T>) -> QueryResult<T> {
    if let Err(crate::QueryError::DataFusion(e)) = &result {
        if let Some(se) = engine_core::compute::script_error_from_datafusion(e) {
            return Err(crate::QueryError::Engine(se));
        }
    }
    result
}

/// Convert a role [`FilterPredicate`] to a request [`FilterCondition`].
fn predicate_to_filter_condition(p: &FilterPredicate) -> FilterCondition {
    use engine_core::compute::expression::ComparisonOp;
    let operator = match p.operator {
        ComparisonOp::Equal => FilterOperator::Equal,
        ComparisonOp::NotEqual => FilterOperator::NotEqual,
        ComparisonOp::GreaterThan => FilterOperator::GreaterThan,
        ComparisonOp::GreaterThanOrEqual => FilterOperator::GreaterThanOrEqual,
        ComparisonOp::LessThan => FilterOperator::LessThan,
        ComparisonOp::LessThanOrEqual => FilterOperator::LessThanOrEqual,
    };
    FilterCondition::new(p.column.clone(), operator, p.value.clone())
}

/// Whether `lhs op rhs` holds for a measure-value filter.
fn measure_filter_passes(lhs: f64, op: FilterOperator, rhs: f64) -> bool {
    match op {
        FilterOperator::Equal => lhs == rhs,
        FilterOperator::NotEqual => lhs != rhs,
        FilterOperator::GreaterThan => lhs > rhs,
        FilterOperator::LessThan => lhs < rhs,
        FilterOperator::GreaterThanOrEqual => lhs >= rhs,
        FilterOperator::LessThanOrEqual => lhs <= rhs,
    }
}

/// Keep only the result rows whose measure columns satisfy every `MeasureFilter`
/// (a post-aggregation `HAVING`). A `NULL` measure value never passes, matching
/// SQL semantics. The measure column is matched by name (case-insensitive) and
/// cast to `f64` for comparison.
fn apply_measure_value_filters(
    batches: &[RecordBatch],
    filters: &[MeasureFilter],
) -> QueryResult<Vec<RecordBatch>> {
    use arrow::array::{Array, BooleanArray, Float64Array};

    let mut out = Vec::with_capacity(batches.len());
    for batch in batches {
        let rows = batch.num_rows();
        let mut keep = vec![true; rows];
        for mf in filters {
            let idx = batch
                .schema()
                .fields()
                .iter()
                .position(|f| f.name().eq_ignore_ascii_case(&mf.measure))
                .ok_or_else(|| {
                    QueryError::InvalidQuery(format!(
                        "measure-value filter references measure '{}', which is not a result \
                         column",
                        mf.measure
                    ))
                })?;
            let casted =
                arrow::compute::cast(batch.column(idx), &arrow::datatypes::DataType::Float64)
                    .map_err(|e| {
                        QueryError::InvalidQuery(format!(
                            "measure-value filter on '{}' requires a numeric measure: {e}",
                            mf.measure
                        ))
                    })?;
            let values = casted
                .as_any()
                .downcast_ref::<Float64Array>()
                .expect("cast to Float64 yields a Float64Array");
            for (i, k) in keep.iter_mut().enumerate() {
                if *k {
                    *k = !values.is_null(i)
                        && measure_filter_passes(values.value(i), mf.operator, mf.value);
                }
            }
        }
        let mask = BooleanArray::from(keep);
        out.push(arrow::compute::filter_record_batch(batch, &mask)?);
    }
    Ok(out)
}

/// Append a measure-value ranking column (`RANKX`-style) to the result rows.
///
/// Ranks each row by its `rank.measure` value (descending by default), within
/// the `rank.partition_by` groups, and appends an `Int64` `rank.output_column`.
/// A `NULL` measure value sorts last (worst rank). Standard competition ranking
/// (`1,1,3`) unless [`RankBy::dense`] (`1,1,2`). Implemented with Arrow only (no
/// DataFusion in the facade): the rows are partitioned by a string key built
/// from the partition columns, sorted within each partition by the measure, and
/// ranks assigned back in original row order.
#[allow(clippy::float_cmp)] // exact equality is the intended ranking tie test
fn apply_ranking(batches: &[RecordBatch], rank: &RankBy) -> QueryResult<Vec<RecordBatch>> {
    use arrow::array::{Array, Float64Array, Int64Array, StringArray};
    use arrow::datatypes::{DataType as ArrowType, Field, Schema};

    if batches.is_empty() {
        return Ok(Vec::new());
    }
    // Work on a single concatenated batch so ranks span all rows.
    let schema = batches[0].schema();
    let batch = arrow::compute::concat_batches(&schema, batches)?;
    let rows = batch.num_rows();

    if schema.index_of(&rank.output_column).is_ok()
        || schema
            .fields()
            .iter()
            .any(|f| f.name().eq_ignore_ascii_case(&rank.output_column))
    {
        return Err(QueryError::InvalidQuery(format!(
            "rank_by output column '{}' collides with an existing result column",
            rank.output_column
        )));
    }

    // Resolve a result column index by case-insensitive name.
    let resolve = |name: &str, what: &str| -> QueryResult<usize> {
        batch
            .schema()
            .fields()
            .iter()
            .position(|f| f.name().eq_ignore_ascii_case(name))
            .ok_or_else(|| {
                QueryError::InvalidQuery(format!(
                    "rank_by {what} '{name}' is not a result column"
                ))
            })
    };

    // Measure values as f64 (NULL preserved).
    let measure_idx = resolve(&rank.measure, "measure")?;
    let measure_f64 = arrow::compute::cast(batch.column(measure_idx), &ArrowType::Float64)
        .map_err(|e| {
            QueryError::InvalidQuery(format!(
                "rank_by measure '{}' must be numeric: {e}",
                rank.measure
            ))
        })?;
    let measure = measure_f64
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("cast to Float64 yields a Float64Array");

    // Partition key per row: the partition columns cast to text and joined.
    let partition_text: Vec<StringArray> = rank
        .partition_by
        .iter()
        .map(|c| {
            let idx = resolve(&c.column, "partition column")?;
            let utf8 = arrow::compute::cast(batch.column(idx), &ArrowType::Utf8).map_err(|e| {
                QueryError::InvalidQuery(format!(
                    "rank_by partition column '{}' could not be keyed: {e}",
                    c.column
                ))
            })?;
            Ok(utf8
                .as_any()
                .downcast_ref::<StringArray>()
                .expect("cast to Utf8 yields a StringArray")
                .clone())
        })
        .collect::<QueryResult<Vec<_>>>()?;
    // A partition key is the tuple of (nullable) string-cast partition values.
    // Keying on the structured `Vec<Option<String>>` is collision-free for any
    // value bytes — a flattened sentinel-joined string could merge two distinct
    // partitions when a value itself contains the sentinel byte.
    let key_of = |row: usize| -> Vec<Option<String>> {
        partition_text
            .iter()
            .map(|a| {
                if a.is_null(row) {
                    None
                } else {
                    Some(a.value(row).to_string())
                }
            })
            .collect()
    };

    // Group row indices by partition key.
    let mut partitions: std::collections::HashMap<Vec<Option<String>>, Vec<usize>> =
        std::collections::HashMap::new();
    for row in 0..rows {
        partitions.entry(key_of(row)).or_default().push(row);
    }

    let mut ranks = vec![0i64; rows];
    for indices in partitions.values() {
        // Sort the partition's rows by measure value; NULLs always last.
        let mut sorted = indices.clone();
        sorted.sort_by(|&a, &b| {
            match (measure.is_null(a), measure.is_null(b)) {
                (true, true) => std::cmp::Ordering::Equal,
                (true, false) => std::cmp::Ordering::Greater, // NULL last
                (false, true) => std::cmp::Ordering::Less,
                (false, false) => {
                    let (va, vb) = (measure.value(a), measure.value(b));
                    let ord = va.partial_cmp(&vb).unwrap_or(std::cmp::Ordering::Equal);
                    if rank.ascending {
                        ord
                    } else {
                        ord.reverse()
                    }
                }
            }
        });
        // Assign ranks with tie handling.
        let mut current_rank = 0i64;
        let mut prev: Option<(bool, f64)> = None; // (is_null, value)
        for (pos, &row) in sorted.iter().enumerate() {
            let cell = (measure.is_null(row), measure.value(row));
            let is_tie = prev.is_some_and(|(pn, pv)| {
                pn == cell.0 && (cell.0 || pv == cell.1)
            });
            if is_tie {
                // Same rank as the previous row (dense and standard agree on ties).
            } else if rank.dense {
                current_rank += 1;
            } else {
                current_rank = pos as i64 + 1;
            }
            ranks[row] = current_rank;
            prev = Some(cell);
        }
    }

    // Append the rank column.
    let mut columns: Vec<arrow::array::ArrayRef> = batch.columns().to_vec();
    columns.push(std::sync::Arc::new(Int64Array::from(ranks)));
    let mut fields: Vec<Field> = schema.fields().iter().map(|f| (**f).clone()).collect();
    fields.push(Field::new(&rank.output_column, ArrowType::Int64, false));
    let out = RecordBatch::try_new(std::sync::Arc::new(Schema::new(fields)), columns)?;
    Ok(vec![out])
}

/// Keep only the top `limit` GROUPS by a measure, **tie-inclusive** (every group
/// tied at the boundary value is kept — DAX `TOPN` semantics), per partition.
/// Arrow-only (no DataFusion). Distinct from `order_by` + `limit`, which
/// truncate to exactly `limit` rows. NULL measures sort last and are kept only
/// when the boundary value is itself NULL (i.e. fewer than `limit` non-NULL
/// groups exist). Optionally appends an `Int64` tie-count column.
#[allow(clippy::float_cmp)] // tie detection is exact f64 equality, by design.
fn apply_topn_with_ties(batches: &[RecordBatch], topn: &TopN) -> QueryResult<Vec<RecordBatch>> {
    use arrow::array::{Array, BooleanArray, Float64Array, Int64Array, StringArray};
    use arrow::datatypes::{DataType as ArrowType, Field, Schema};

    if batches.is_empty() {
        return Ok(Vec::new());
    }
    let schema = batches[0].schema();
    let batch = arrow::compute::concat_batches(&schema, batches)?;
    let rows = batch.num_rows();

    if let Some(out) = &topn.output_column {
        if schema
            .fields()
            .iter()
            .any(|f| f.name().eq_ignore_ascii_case(out))
        {
            return Err(QueryError::InvalidQuery(format!(
                "top_n output column '{out}' collides with an existing result column"
            )));
        }
    }

    let resolve = |name: &str, what: &str| -> QueryResult<usize> {
        batch
            .schema()
            .fields()
            .iter()
            .position(|f| f.name().eq_ignore_ascii_case(name))
            .ok_or_else(|| {
                QueryError::InvalidQuery(format!("top_n {what} '{name}' is not a result column"))
            })
    };

    let measure_idx = resolve(&topn.measure, "measure")?;
    let measure_f64 =
        arrow::compute::cast(batch.column(measure_idx), &ArrowType::Float64).map_err(|e| {
            QueryError::InvalidQuery(format!(
                "top_n measure '{}' must be numeric: {e}",
                topn.measure
            ))
        })?;
    let measure = measure_f64
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("cast to Float64 yields a Float64Array");

    let partition_text: Vec<StringArray> = topn
        .partition_by
        .iter()
        .map(|c| {
            let idx = resolve(&c.column, "partition column")?;
            let utf8 = arrow::compute::cast(batch.column(idx), &ArrowType::Utf8).map_err(|e| {
                QueryError::InvalidQuery(format!(
                    "top_n partition column '{}' could not be keyed: {e}",
                    c.column
                ))
            })?;
            Ok(utf8
                .as_any()
                .downcast_ref::<StringArray>()
                .expect("cast to Utf8 yields a StringArray")
                .clone())
        })
        .collect::<QueryResult<Vec<_>>>()?;
    let key_of = |row: usize| -> Vec<Option<String>> {
        partition_text
            .iter()
            .map(|a| {
                if a.is_null(row) {
                    None
                } else {
                    Some(a.value(row).to_string())
                }
            })
            .collect()
    };

    let mut partitions: std::collections::HashMap<Vec<Option<String>>, Vec<usize>> =
        std::collections::HashMap::new();
    for row in 0..rows {
        partitions.entry(key_of(row)).or_default().push(row);
    }

    let cell = |row: usize| -> (bool, f64) { (measure.is_null(row), measure.value(row)) };
    // Order rows by RANK (best first): higher value first (or lower if
    // `ascending`); a NULL measure is always worst (last).
    let cmp_rank = |a: usize, b: usize| -> std::cmp::Ordering {
        let (na, va) = cell(a);
        let (nb, vb) = cell(b);
        match (na, nb) {
            (true, true) => std::cmp::Ordering::Equal,
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            (false, false) => {
                let ord = va.partial_cmp(&vb).unwrap_or(std::cmp::Ordering::Equal);
                if topn.ascending {
                    ord
                } else {
                    ord.reverse()
                }
            }
        }
    };

    let mut keep = vec![false; rows];
    let mut tie_count = vec![0i64; rows];
    for indices in partitions.values() {
        if topn.limit == 0 {
            continue; // top-0 keeps nothing.
        }
        let mut sorted = indices.clone();
        sorted.sort_by(|&a, &b| cmp_rank(a, b));
        // Boundary = the limit-th best row (clamped to the partition size).
        let boundary_row = sorted[(topn.limit - 1).min(sorted.len() - 1)];
        let boundary = cell(boundary_row);
        let mut at_boundary = 0i64;
        for &row in indices {
            // Keep rows that rank at least as high as the boundary (ties kept).
            if cmp_rank(row, boundary_row) != std::cmp::Ordering::Greater {
                keep[row] = true;
            }
            let c = cell(row);
            if c.0 == boundary.0 && (c.0 || c.1 == boundary.1) {
                at_boundary += 1;
            }
        }
        for &row in indices {
            if keep[row] {
                tie_count[row] = at_boundary;
            }
        }
    }

    let mask = BooleanArray::from(keep.clone());
    let filtered = arrow::compute::filter_record_batch(&batch, &mask)?;

    if let Some(out_name) = &topn.output_column {
        let kept_counts: Vec<i64> = (0..rows).filter(|&r| keep[r]).map(|r| tie_count[r]).collect();
        let mut columns: Vec<arrow::array::ArrayRef> = filtered.columns().to_vec();
        columns.push(std::sync::Arc::new(Int64Array::from(kept_counts)));
        let mut fields: Vec<Field> = filtered
            .schema()
            .fields()
            .iter()
            .map(|f| (**f).clone())
            .collect();
        fields.push(Field::new(out_name, ArrowType::Int64, false));
        let out = RecordBatch::try_new(std::sync::Arc::new(Schema::new(fields)), columns)?;
        return Ok(vec![out]);
    }
    Ok(vec![filtered])
}

/// Map an Arrow result type back to the engine [`DataType`] best-effort,
/// unwrapping dictionary encoding (grouped string dimensions arrive
/// dictionary-encoded). Returns `None` for a type with no clean engine mapping.
fn arrow_to_engine_type(arrow: &arrow::datatypes::DataType) -> Option<DataType> {
    use arrow::datatypes::DataType as A;
    match arrow {
        A::Int32 => Some(DataType::Int32),
        A::Int64 => Some(DataType::Int64),
        A::Float64 | A::Float32 => Some(DataType::Float64),
        A::Decimal128(p, s) => Some(DataType::Decimal(*p, *s)),
        A::Utf8 | A::LargeUtf8 => Some(DataType::String),
        A::Boolean => Some(DataType::Boolean),
        A::Date32 | A::Date64 => Some(DataType::Date),
        A::Timestamp(_, _) => Some(DataType::Timestamp),
        // Grouped low-cardinality strings are dictionary-encoded — report the
        // underlying value type so the host need not inspect the encoding.
        A::Dictionary(_, value) => arrow_to_engine_type(value),
        _ => None,
    }
}

/// Build the per-column metadata describing a query result (see
/// [`ResultColumn`]). Classifies each result column by name against the request
/// and model: the `__grouping_id` bitmask, the rank column, measures (including
/// `"M [I]"` calculation-group columns), and group-by dimensions — attaching the
/// model's format string / display name / description for each.
fn build_result_metadata(
    model: &DataModel,
    request: &QueryRequest,
    schema: &arrow::datatypes::Schema,
) -> Vec<ResultColumn> {
    use engine_core::model::calculation_group::synthetic_measure_name;

    // Pre-compute the calculation-group synthetic name → (base measure, item)
    // mapping when a group is applied, so those value columns attribute back.
    let mut calc_map: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();
    if let Some(app) = &request.calculation_group {
        if let Ok(group) = model.calculation_group(&app.group) {
            for measure in &request.measures {
                for item in group.items() {
                    if app.items.is_empty()
                        || app.items.iter().any(|i| i.eq_ignore_ascii_case(item.name()))
                    {
                        calc_map.insert(
                            synthetic_measure_name(measure, item.name()),
                            (measure.clone(), item.name().to_string()),
                        );
                    }
                }
            }
        }
    }

    let rank_output = request.rank_by.as_ref().map(|r| r.output_column.as_str());
    let topn_output = request
        .top_n
        .as_ref()
        .and_then(|t| t.output_column.as_deref());

    schema
        .fields()
        .iter()
        .map(|field| {
            let name = field.name();
            let data_type = arrow_to_engine_type(field.data_type());

            // Grouping-id bitmask.
            if name == GROUPING_ID_COLUMN {
                let mut c = ResultColumn::bare(name, ResultColumnKind::GroupingId);
                c.data_type = data_type;
                return c;
            }
            // Rank column.
            if rank_output.is_some_and(|r| r.eq_ignore_ascii_case(name)) {
                let mut c = ResultColumn::bare(name, ResultColumnKind::Rank);
                c.data_type = data_type;
                return c;
            }
            // Top-N tie-count column (an integer measure-like column).
            if topn_output.is_some_and(|t| t.eq_ignore_ascii_case(name)) {
                let mut c = ResultColumn::bare(name, ResultColumnKind::Measure);
                c.data_type = data_type;
                return c;
            }
            // Calculation-group synthetic measure column.
            if let Some((base, item)) = calc_map
                .iter()
                .find(|(syn, _)| syn.as_str() == name)
                .map(|(_, v)| v.clone())
            {
                let mut c = ResultColumn::bare(name, ResultColumnKind::Measure);
                c.data_type = data_type;
                c.measure = Some(base.clone());
                c.calculation_item = Some(item);
                if let Ok(m) = model.measure(&base) {
                    c.format_string = m.format_string().map(str::to_string);
                    c.description = m.description().map(str::to_string);
                    c.is_hidden = m.is_hidden();
                }
                return c;
            }
            // A plain measure column. Match the measure name **exactly**:
            // measures are aliased with their exact name, so an exact match
            // identifies the real measure column, while a dimension column whose
            // name only *case-insensitively* coincides with a measure name (e.g.
            // dim `Tier` vs measure `TIER`) is correctly left to the dimension
            // branch below. (An exact name collision can't reach here — it fails
            // earlier at DataFusion as an ambiguous reference.)
            if let Some(measure_name) = request.measures.iter().find(|m| m.as_str() == name) {
                let mut c = ResultColumn::bare(name, ResultColumnKind::Measure);
                c.data_type = data_type;
                c.measure = Some(measure_name.clone());
                if let Ok(m) = model.measure(measure_name) {
                    c.format_string = m.format_string().map(str::to_string);
                    c.description = m.description().map(str::to_string);
                    c.is_hidden = m.is_hidden();
                }
                // A KPI whose base measure is this column lets the host render its
                // status indicator. Exact name match (consistent with the measure
                // attribution above).
                c.kpi_name = model
                    .kpis()
                    .iter()
                    .find(|k| k.base_measure() == measure_name.as_str())
                    .map(|k| k.name().to_string());
                return c;
            }
            // Otherwise a dimension: attribute it to a group-by column (the
            // result lowercases dimension names, so match case-insensitively).
            let mut c = ResultColumn::bare(name, ResultColumnKind::Dimension);
            c.data_type = data_type;
            if let Some(col_ref) = request
                .group_by
                .iter()
                .find(|g| g.column.eq_ignore_ascii_case(name))
            {
                c.source_table = Some(col_ref.table.clone());
                c.source_column = Some(col_ref.column.clone());
                if let Ok(column) = model
                    .table(&col_ref.table)
                    .and_then(|t| t.column(&col_ref.column))
                {
                    c.display_name = column.display_name().map(str::to_string);
                    c.description = column.description().map(str::to_string);
                    c.is_hidden = column.is_hidden();
                } else if let Some(cc) = model
                    .context_column(&col_ref.column)
                    .filter(|cc| cc.table().eq_ignore_ascii_case(&col_ref.table))
                {
                    // A context-driven calculated column is not a physical
                    // column; surface its description so the host can label the
                    // dynamic-segmentation axis.
                    c.description = cc.description().map(str::to_string);
                }
            }
            c
        })
        .collect()
}

/// Take at most `limit` rows total across `batches`, preserving order. `None`
/// returns all rows.
fn truncate_batches_to_limit(batches: Vec<RecordBatch>, limit: Option<usize>) -> Vec<RecordBatch> {
    let Some(mut remaining) = limit else {
        return batches;
    };
    let mut out = Vec::with_capacity(batches.len());
    for batch in batches {
        if remaining == 0 {
            break;
        }
        if batch.num_rows() <= remaining {
            remaining -= batch.num_rows();
            out.push(batch);
        } else {
            out.push(batch.slice(0, remaining));
            remaining = 0;
        }
    }
    out
}

/// Build the effective UDF registry = native UDFs + compiled model script
/// functions, under the given sandbox config.
///
/// Native UDFs are cloned in first. Each model [`ScriptFunction`] is then
/// compiled and registered, with its `version` set to the function's
/// [`identity_version`](engine_core::compute::script::ScriptFunction::identity_version)
/// (a stable hash of body + parameter/return types) so the registry's
/// `identity_hash()` — already part of the query-cache key — automatically
/// changes when a script is edited.
///
/// Returns the new registry plus an optional error. The model builder already
/// guarantees each script compiles and does not collide with a built-in, so
/// the only error here is a **name collision between a model script and a
/// native UDF**: the script is skipped (native UDFs win) and the collision is
/// reported. On any error the returned registry still contains every
/// non-colliding function, so the engine remains usable for unrelated queries.
fn build_effective_registry(
    model: &DataModel,
    native: &UdfRegistry,
    config: &ScriptSandboxConfig,
) -> (Arc<UdfRegistry>, Option<EngineError>) {
    let mut effective = native.clone();
    let mut first_error: Option<EngineError> = None;

    for function in model.script_functions() {
        // A script name that collides with a native UDF is ambiguous — the
        // native one is already registered. Report it (deferred) rather than
        // silently shadowing either way.
        if native.get(function.name()).is_some() {
            if first_error.is_none() {
                first_error = Some(EngineError::ScriptError {
                    function: function.name().to_string(),
                    position: None,
                    message: "name collides with a host-registered native UDF; \
                              rename the script or unregister the native UDF"
                        .to_string(),
                });
            }
            continue;
        }

        match engine_core::compute::script::compile_script_function(function, config) {
            Ok(udf) => {
                // Version = identity of the script's behavior, so editing a
                // body changes the registry identity and every cache key.
                if let Err(e) = effective.register(udf, function.identity_version()) {
                    // A compiled UDF's name is the (already validated) script
                    // name; registration failure here would be a logic bug,
                    // but surface it rather than panicking.
                    if first_error.is_none() {
                        first_error = Some(e);
                    }
                }
            }
            Err(e) => {
                // The model builder should have caught this; keep going and
                // report the first failure.
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
    }

    (Arc::new(effective), first_error)
}

impl Engine {
    /// Create a new engine with the given data model.
    ///
    /// Uses the default memory budget (256 MB) for the in-memory cache.
    ///
    /// The model's [`ScriptFunction`]s are compiled eagerly into the
    /// effective UDF registry under a conservative default
    /// [`ScriptSandboxConfig`]. The model builder already rejected bad bodies
    /// and built-in collisions, so the only error this can hit is a script
    /// whose name collides with a host-registered native UDF — and no native
    /// UDFs are registered yet at construction, so that cannot happen here.
    /// `Engine::new` is therefore infallible; any later collision (after
    /// `register_udf` / `set_model`) is surfaced on the next query and by
    /// [`Engine::validate_scripts`].
    pub fn new(model: DataModel) -> Self {
        Self::build(model, InMemoryCache::new())
    }

    /// Create a new engine with a custom memory budget for in-memory tables.
    pub fn with_memory_budget(model: DataModel, budget_bytes: usize) -> Self {
        Self::build(model, InMemoryCache::with_budget(budget_bytes))
    }

    /// Shared constructor: assemble the engine and build the effective UDF
    /// registry from the model's script functions.
    fn build(model: DataModel, cache: InMemoryCache) -> Self {
        let native = Arc::new(UdfRegistry::new());
        let config = ScriptSandboxConfig::default();
        let (effective, script_build_error) = build_effective_registry(&model, &native, &config);
        Self {
            model,
            registry: SourceRegistry::new(),
            cache,
            max_inline_in_values: DEFAULT_MAX_INLINE_IN_VALUES,
            optimizer_config: OptimizerConfig::default(),
            auto_tier_config: AutoTierConfig::default(),
            auto_tier_state: AutoTierState::default(),
            query_cache: Mutex::new(query_cache::QueryCache::new(QueryCacheConfig::default())),
            source_query_policy: SourceQueryPolicy::default(),
            last_refresh_report: None,
            udfs: native,
            effective_udfs: effective,
            script_sandbox_config: config,
            script_build_error,
            active_roles: Vec::new(),
            user_identity: None,
            custom_data: None,
        }
    }

    /// Set a custom optimizer configuration for batch ingest.
    ///
    /// The optimizer runs automatically when tables are refreshed into
    /// the in-memory cache, applying type narrowing, dictionary encoding,
    /// and timestamp-to-date conversion.
    pub fn set_optimizer_config(&mut self, config: OptimizerConfig) {
        self.optimizer_config = config;
    }

    /// Returns the current optimizer configuration.
    pub fn optimizer_config(&self) -> &OptimizerConfig {
        &self.optimizer_config
    }

    /// Set the maximum number of IN-filter values to inline in SQL.
    ///
    /// When a relationship filter propagation produces more values than this
    /// threshold, the connector uses a server-side temp table instead of an
    /// inline `IN (...)` list. Default: 1000.
    pub fn set_max_inline_in_values(&mut self, max: usize) {
        self.max_inline_in_values = max;
    }

    /// Returns the current maximum inline IN-filter values threshold.
    pub fn max_inline_in_values(&self) -> usize {
        self.max_inline_in_values
    }

    /// Set the query-result cache configuration.
    ///
    /// When enabled, query results are cached and served from memory
    /// when the same query is re-executed within the TTL. The cache is
    /// invalidated on model changes and data refreshes.
    pub fn set_query_cache_config(&mut self, config: QueryCacheConfig) {
        self.query_cache.lock().set_config(config);
    }

    /// Returns the current query cache configuration.
    pub fn query_cache_config(&self) -> QueryCacheConfig {
        self.query_cache.lock().config().clone()
    }

    /// Returns query cache statistics (hits, misses, entries, memory usage).
    pub fn query_cache_stats(&self) -> QueryCacheStats {
        self.query_cache.lock().stats()
    }

    /// Clear all cached query results.
    ///
    /// Takes `&self`: the result cache uses interior mutability, so hosts
    /// holding the engine in an `Arc` can invalidate it without exclusive
    /// access. Queries running concurrently are unaffected (a result they
    /// store afterwards is keyed under the old cache version and can never
    /// be served).
    pub fn clear_query_cache(&self) {
        self.query_cache.lock().invalidate_all();
    }

    /// Register a PostgreSQL data source and return its connector index.
    ///
    /// The connection target (host, port, database) and authentication method
    /// are separate, enabling models to store only the target while auth
    /// resolves from the user's environment.
    pub async fn add_postgres(
        &mut self,
        target: ConnectionTarget,
        auth: AuthMethod,
    ) -> ConnectorResult<usize> {
        let connector = PostgresConnector::connect(target, auth).await?;
        let idx = self
            .registry
            .add_connector(AnyConnector::Postgres(connector));
        Ok(idx)
    }

    /// Register a SQL Server data source and return its connector index.
    ///
    /// See [`add_postgres`](Self::add_postgres) for rationale on the
    /// target/auth separation.
    pub async fn add_sqlserver(
        &mut self,
        target: ConnectionTarget,
        auth: AuthMethod,
    ) -> ConnectorResult<usize> {
        let connector = SqlServerConnector::connect(target, auth).await?;
        let idx = self
            .registry
            .add_connector(AnyConnector::SqlServer(connector));
        Ok(idx)
    }

    /// Register an in-process [`InMemoryConnector`] (canned Arrow batches) and
    /// return its connector index.
    ///
    /// Unlike [`add_postgres`](Self::add_postgres) /
    /// [`add_sqlserver`](Self::add_sqlserver), this connector has no
    /// connection target or credentials — it serves data already held in
    /// memory. Useful for tests and for simple file-less sources where the
    /// host loads data itself but still wants the connector seam (e.g. so that
    /// incremental refresh can push the volatile-row `WHERE` to the same
    /// fetch path a real database would use). Synchronous (no I/O).
    pub fn add_in_memory_source(&mut self, connector: InMemoryConnector) -> usize {
        self.registry
            .add_connector(AnyConnector::InMemory(connector))
    }

    /// Register a CSV file source (a directory of `<table>.csv` files) and
    /// return its connector index.
    ///
    /// The `target.database` field is the **directory** holding the CSV files;
    /// `target.default_schema` (default `"public"`) is the cosmetic source
    /// schema. CSV is local, so the only applicable [`AuthMethod`] is
    /// [`AuthMethod::Integrated`] (the process's own file-system access);
    /// credential methods are rejected. Synchronous (the directory is validated;
    /// files are read lazily per query). See [`CsvConnector`].
    pub fn add_csv_source(
        &mut self,
        target: ConnectionTarget,
        auth: AuthMethod,
    ) -> ConnectorResult<usize> {
        let connector = CsvConnector::from_target(target, auth)?;
        let idx = self.registry.add_connector(AnyConnector::Csv(connector));
        Ok(idx)
    }

    /// Register an Apache Parquet file source (a directory of `<table>.parquet`
    /// files) and return its connector index.
    ///
    /// The `target.database` field is the **directory** holding the Parquet
    /// files; `target.default_schema` (default `"public"`) is the cosmetic
    /// source schema. Parquet is local, so the only applicable [`AuthMethod`] is
    /// [`AuthMethod::Integrated`] (the process's own file-system access);
    /// credential methods are rejected. Unlike CSV, Parquet embeds its schema,
    /// so introspection is exact. Synchronous (the directory is validated; files
    /// are read lazily per query). See [`ParquetConnector`].
    pub fn add_parquet_source(
        &mut self,
        target: ConnectionTarget,
        auth: AuthMethod,
    ) -> ConnectorResult<usize> {
        let connector = ParquetConnector::from_target(target, auth)?;
        let idx = self.registry.add_connector(AnyConnector::Parquet(connector));
        Ok(idx)
    }

    /// Register a host-provided scalar UDF, replacing any UDF with the same
    /// name.
    ///
    /// Measures and calculated columns may then call it by name:
    /// `SUM(pct_of(Sales[amount], Sales[total]))`. UDFs execute **locally
    /// only** — expressions calling them are never pushed down to data
    /// sources.
    ///
    /// Register UDFs **before** querying: [`Engine::query`] fails with
    /// [`EngineError::UnknownFunction`] when a requested measure calls an
    /// unregistered name.
    ///
    /// `version` is the host's cache-identity for the (opaque) function
    /// body: bump it whenever the function's behavior changes, so cached
    /// query results computed with the old behavior are not served.
    /// Registration always invalidates the query-result cache.
    ///
    /// UDF names must be lowercase (`[a-z_][a-z0-9_]{0,63}`) because
    /// DataFusion resolves unquoted SQL function identifiers in lowercase;
    /// measure text may spell calls in any case.
    ///
    /// # Examples
    ///
    /// ```
    /// use std::sync::Arc;
    ///
    /// use arrow::array::Float64Array;
    /// use arrow::datatypes::DataType as ArrowDataType;
    /// use bi_engine::{
    ///     create_udf, Column, ColumnarValue, DataModel, DataType, Engine, Table, Volatility,
    /// };
    ///
    /// # fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// let model = DataModel::builder()
    ///     .add_table(Table::new(
    ///         "Sales",
    ///         vec![
    ///             Column::new("amount", DataType::Float64),
    ///             Column::new("total", DataType::Float64),
    ///         ],
    ///     )?)
    ///     .build()?;
    /// let mut engine = Engine::new(model);
    ///
    /// // pct_of(part, whole) = part / whole * 100, NULL-safe.
    /// let pct_of = create_udf(
    ///     "pct_of",
    ///     vec![ArrowDataType::Float64, ArrowDataType::Float64],
    ///     ArrowDataType::Float64,
    ///     Volatility::Immutable,
    ///     Arc::new(|args: &[ColumnarValue]| {
    ///         let arrays = ColumnarValue::values_to_arrays(args)?;
    ///         let part = arrays[0]
    ///             .as_any()
    ///             .downcast_ref::<Float64Array>()
    ///             .expect("Float64 enforced by the UDF signature");
    ///         let whole = arrays[1]
    ///             .as_any()
    ///             .downcast_ref::<Float64Array>()
    ///             .expect("Float64 enforced by the UDF signature");
    ///         let out: Float64Array = part
    ///             .iter()
    ///             .zip(whole.iter())
    ///             .map(|(p, w)| match (p, w) {
    ///                 (Some(p), Some(w)) if w != 0.0 => Some(p / w * 100.0),
    ///                 _ => None,
    ///             })
    ///             .collect();
    ///         Ok(ColumnarValue::Array(Arc::new(out)))
    ///     }),
    /// );
    /// engine.register_udf(pct_of, 1)?;
    ///
    /// // Measure text can now call it (in any case):
    /// let measure = bi_engine::parse_measure("SUM(PCT_OF(Sales[amount], Sales[total]))")?;
    /// assert_eq!(engine.registered_udfs(), vec!["pct_of".to_string()]);
    /// # let _ = measure;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::InvalidIdentifier`] when the UDF's name is not
    /// lowercase `[a-z_][a-z0-9_]{0,63}`.
    pub fn register_udf(&mut self, udf: ScalarUDF, version: u64) -> EngineResult<()> {
        let mut registry = (*self.udfs).clone();
        registry.register(udf, version)?;
        self.udfs = Arc::new(registry);
        // Rebuild the effective registry (native + model scripts) so the new
        // native UDF is visible to queries and any native-vs-script collision
        // is re-evaluated.
        self.rebuild_effective_udfs();
        // The new/replaced function may compute different values than
        // whatever produced the cached results; this also bumps the model
        // version that feeds the query-cache key.
        self.query_cache.lock().invalidate_all();
        Ok(())
    }

    /// Names of all registered (native) UDFs, sorted.
    pub fn registered_udfs(&self) -> Vec<String> {
        self.udfs.names()
    }

    /// Set the host's script sandbox resource limits.
    ///
    /// This is **host policy** (like the source-query policy): it bounds how
    /// much work a single script evaluation may do (operation budget,
    /// recursion depth, string/array size). It is **not** part of any model —
    /// a malicious model can never raise its own budget.
    ///
    /// Setting it recompiles every model script function under the new limits
    /// (compilation cost only; nothing executes) and invalidates the query
    /// cache. Returns any deferred script error (e.g. a native-vs-script name
    /// collision) so the host learns about it eagerly; the engine remains
    /// usable for unrelated queries regardless.
    ///
    /// # Examples
    ///
    /// A model-defined script function `markup(cost, rate)` becomes callable
    /// from a measure with **no** native UDF registered — the engine compiles
    /// the script into its effective UDF registry. This builds an `Engine`
    /// without any connectors:
    ///
    /// ```
    /// use bi_engine::{
    ///     parse_measure, Column, DataModel, DataType, Engine, Measure, ScriptFunction,
    ///     ScriptSandboxConfig, ScriptType, Table,
    /// };
    ///
    /// # fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// // markup(cost, rate) = cost * rate — a sandboxed Rhai script.
    /// let markup = ScriptFunction::builder("markup")
    ///     .param("cost", ScriptType::Float)
    ///     .param("rate", ScriptType::Float)
    ///     .returns(ScriptType::Float)
    ///     .body("cost * rate")
    ///     .build();
    ///
    /// let model = DataModel::builder()
    ///     .add_table(Table::new(
    ///         "Sales",
    ///         vec![
    ///             Column::new("cost", DataType::Float64),
    ///             Column::new("rate", DataType::Float64),
    ///         ],
    ///     )?)
    ///     .add_script_function(markup)
    ///     .add_measure(Measure::new(
    ///         "MarkupTotal",
    ///         // The measure calls the model script by name — no native UDF
    ///         // registration is required.
    ///         parse_measure("SUM(markup(Sales[cost], Sales[rate]))")?,
    ///     ))
    ///     .build()?;
    ///
    /// let mut engine = Engine::new(model);
    /// // Host policy: keep scripts on a conservative budget.
    /// engine.set_script_sandbox_config(ScriptSandboxConfig::default())?;
    ///
    /// // The script is compiled and callable; no native UDFs are registered.
    /// assert!(engine.registered_udfs().is_empty());
    /// assert!(engine.validate_scripts().is_ok());
    /// # Ok(())
    /// # }
    /// ```
    pub fn set_script_sandbox_config(&mut self, config: ScriptSandboxConfig) -> EngineResult<()> {
        self.script_sandbox_config = config;
        self.rebuild_effective_udfs();
        self.query_cache.lock().invalidate_all();
        match &self.script_build_error {
            Some(e) => Err(clone_script_error(e)),
            None => Ok(()),
        }
    }

    /// Returns the current script sandbox configuration (host policy).
    pub fn script_sandbox_config(&self) -> ScriptSandboxConfig {
        self.script_sandbox_config
    }

    /// Verify that every model script function compiled into the effective
    /// registry without error.
    ///
    /// Returns the deferred error captured by the last effective-registry
    /// rebuild — currently only a name collision between a model script and a
    /// host-registered native UDF (model-build already rejected bad bodies
    /// and built-in collisions). Hosts that want to fail fast can call this
    /// after [`Engine::new`] / [`Engine::set_model`] / [`Engine::register_udf`];
    /// otherwise the same error surfaces on the next query.
    pub fn validate_scripts(&self) -> EngineResult<()> {
        match &self.script_build_error {
            Some(e) => Err(clone_script_error(e)),
            None => Ok(()),
        }
    }

    /// Set (or clear) the active security role.
    ///
    /// The host calls this **after** authenticating the user, passing the name
    /// of a [`SecurityRole`] defined in the model. From then on every query is
    /// restricted to the rows that role permits — applied as a sealed
    /// pre-aggregation filter that no measure-context operation (RESET / CLEAR
    /// / ALL-style) can remove, and that restricts a fact table even when the
    /// role-filtered dimension is not otherwise in the query. Passing `None`
    /// clears the role, returning to unrestricted (no-RLS) queries.
    ///
    /// Changing the active role invalidates the query-result cache (a result
    /// computed under one role must never be served to another).
    ///
    /// A non-existent role name is **not** rejected here — it is caught at
    /// query time with [`EngineError::SecurityRoleNotFound`], so a typo can
    /// never silently degrade into an unrestricted query.
    ///
    /// # Security model — read this
    ///
    /// Client-side RLS in an embedded library is **advisory**. It constrains
    /// queries that go *through* this engine; a host that holds direct source
    /// credentials can query the database around it. The source database's own
    /// grants therefore remain the real authority. v1 also restricts a single
    /// role at a time (no multi-role union), supports only static
    /// `column op value` predicates AND-combined (no OR / IN-list, no dynamic
    /// `USERNAME()`-style identity filters), and enforces a dimension → fact
    /// restriction only over a single-hop active single-column equi
    /// relationship. When a role filters a dimension that could restrict a
    /// queried fact but reaches it only through a relationship the engine
    /// cannot enforce (non-equi / many-to-many / composite-key / inactive /
    /// multi-hop), the query **fails closed** with
    /// [`EngineError::RowLevelSecurityNotEnforceable`] rather than returning
    /// under-restricted rows.
    ///
    /// # Example
    ///
    /// Build a model with a `WestOnly` role over a star schema, then activate
    /// it. Once active, `Revenue` is restricted to West rows on every query —
    /// even queries that never mention `Geography` (the restriction propagates
    /// dimension → fact). This example builds the engine over in-memory data
    /// with no connectors; the [`query`](Self::query) call (elided here, since
    /// it needs data loaded) would then return only the West total.
    ///
    /// ```
    /// use bi_engine::{
    ///     Column, ComparisonOp, DataModel, DataType, Engine, Relationship, SecurityRole,
    ///     StorageMode, Table, sum_measure,
    /// };
    ///
    /// # fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// let model = DataModel::builder()
    ///     .add_table(
    ///         Table::new("Sales", vec![
    ///             Column::new("geo_id", DataType::Int64),
    ///             Column::new("amount", DataType::Float64),
    ///         ])?
    ///         .with_storage_mode(StorageMode::InMemory),
    ///     )
    ///     .add_table(
    ///         Table::new("Geography", vec![
    ///             Column::new("id", DataType::Int64),
    ///             Column::new("region", DataType::String),
    ///         ])?
    ///         .with_storage_mode(StorageMode::InMemory),
    ///     )
    ///     .add_relationship(Relationship::many_to_one(
    ///         "Sales_Geo", "Sales", "geo_id", "Geography", "id",
    ///     ))
    ///     .add_measure(sum_measure("Revenue", "Sales", "amount"))
    ///     .add_security_role(
    ///         SecurityRole::new("WestOnly")
    ///             .with_filter("Geography", "region", ComparisonOp::Equal, "West"),
    ///     )
    ///     .build()?;
    ///
    /// let mut engine = Engine::new(model);
    /// // Host authenticated the user as a West-region analyst:
    /// engine.set_active_role(Some("WestOnly".into()));
    /// assert_eq!(engine.active_role(), Some("WestOnly"));
    /// // A bare `SUM(Sales[amount])` query would now return only the West
    /// // total, with Geography pulled in behind the scenes to restrict Sales.
    ///
    /// engine.set_active_role(None); // back to unrestricted
    /// assert_eq!(engine.active_role(), None);
    /// # Ok(())
    /// # }
    /// ```
    pub fn set_active_role(&mut self, role: Option<String>) {
        self.set_active_roles(role.into_iter().collect());
    }

    /// Set (or clear) the active security **roles**. With several roles a row is
    /// visible if **any** of them permits it (the union).
    ///
    /// v1 union support: all roles must restrict a single common table with one
    /// predicate each (e.g. several `Region = '…'` roles), and that table must be
    /// enforceable (single-hop equi to the fact). A union spanning different
    /// tables, a role with multiple predicates, or a non-enforceable table fails
    /// closed at query time (`QueryError::InvalidQuery` /
    /// `RowLevelSecurityNotEnforceable`) — never a silent unrestricted result.
    pub fn set_active_roles(&mut self, roles: Vec<String>) {
        if self.active_roles != roles {
            self.active_roles = roles;
            // A result computed under one role set must never be served to
            // another — invalidate every cached result on any change.
            self.query_cache.lock().invalidate_all();
        }
    }

    /// Returns the name of the first active security role, if any. With multiple
    /// active roles use [`active_roles`](Self::active_roles).
    pub fn active_role(&self) -> Option<&str> {
        self.active_roles.first().map(String::as_str)
    }

    /// Returns all active security roles (empty when RLS is off).
    pub fn active_roles(&self) -> &[String] {
        &self.active_roles
    }

    /// Set (or clear) the current **user identity** (DAX `USERNAME()`) for
    /// dynamic row-level security.
    ///
    /// A dynamic role predicate (`column = USERNAME()`, built with
    /// [`FilterPredicate::username`](engine_core::compute::expression::FilterPredicate::username))
    /// resolves to this value at query time. A query under such a role with **no**
    /// identity set fails closed ([`EngineError::RowLevelSecurityNotEnforceable`])
    /// — never an unrestricted result. The identity is part of the query-cache
    /// key, so a result computed for one user is never served to another;
    /// changing it invalidates the cache.
    pub fn set_user_identity(&mut self, identity: Option<String>) {
        if self.user_identity != identity {
            self.user_identity = identity;
            self.query_cache.lock().invalidate_all();
        }
    }

    /// The current user identity, if set.
    pub fn user_identity(&self) -> Option<&str> {
        self.user_identity.as_deref()
    }

    /// Set (or clear) the host-supplied **custom data** (DAX `CUSTOMDATA()`) for
    /// dynamic row-level security (e.g. a tenant id). Resolves a dynamic role
    /// predicate built with
    /// [`FilterPredicate::custom_data`](engine_core::compute::expression::FilterPredicate::custom_data).
    /// Same fail-closed and cache-key semantics as
    /// [`set_user_identity`](Self::set_user_identity).
    pub fn set_custom_data(&mut self, data: Option<String>) {
        if self.custom_data != data {
            self.custom_data = data;
            self.query_cache.lock().invalidate_all();
        }
    }

    /// The host-supplied custom data, if set.
    pub fn custom_data(&self) -> Option<&str> {
        self.custom_data.as_deref()
    }

    /// Substitute each **dynamic** role predicate (`USERNAME()`/`CUSTOMDATA()`)
    /// with the concrete runtime identity, returning OWNED static predicates.
    ///
    /// **Fails closed** ([`EngineError::RowLevelSecurityNotEnforceable`]) when a
    /// predicate needs an identity that is not set — so a dynamic predicate is
    /// never rendered as its placeholder and never silently dropped. Static
    /// predicates are returned unchanged. This is the single substitution point
    /// upstream of every role-filter consumer (the planner, the executor, and the
    /// multi-role union).
    fn substitute_identity_in_predicates(
        &self,
        predicates: &[FilterPredicate],
    ) -> QueryResult<Vec<FilterPredicate>> {
        use engine_core::compute::expression::DynamicValue;
        predicates
            .iter()
            .map(|p| match p.dynamic {
                None => Ok(p.clone()),
                Some(kind) => {
                    let (identity, label, setter) = match kind {
                        DynamicValue::Username => {
                            (self.user_identity.as_deref(), "USERNAME()", "set_user_identity")
                        }
                        DynamicValue::CustomData => {
                            (self.custom_data.as_deref(), "CUSTOMDATA()", "set_custom_data")
                        }
                    };
                    let value = identity.ok_or_else(|| {
                        QueryError::Engine(EngineError::RowLevelSecurityNotEnforceable {
                            table: p.table.clone(),
                            reason: format!(
                                "the active role has a dynamic {label} row filter on '{}', but no \
                                 runtime identity is set; call Engine::{setter} before querying",
                                p.table
                            ),
                        })
                    })?;
                    Ok(FilterPredicate::new(
                        p.table.clone(),
                        p.column.clone(),
                        p.operator,
                        value,
                    ))
                }
            })
            .collect()
    }

    /// A stable cache-key fragment for the security context — the active role set
    /// (order-independent) **and** the runtime identity (`USERNAME()` /
    /// `CUSTOMDATA()`) — or `None` when there is no role and no identity.
    ///
    /// A result computed under one (roles, identity) context must never be served
    /// to another, so this fragment is part of the query-cache key. Components are
    /// **length-prefixed** so the encoding is collision-free regardless of
    /// contents: a role name or identity containing the field separator can no
    /// longer alias a different context.
    fn role_cache_key(&self) -> Option<String> {
        if self.active_roles.is_empty()
            && self.user_identity.is_none()
            && self.custom_data.is_none()
        {
            return None;
        }
        use std::fmt::Write;
        let mut roles = self.active_roles.clone();
        roles.sort();
        let mut key = String::new();
        for r in &roles {
            let _ = write!(key, "r{}:{};", r.len(), r);
        }
        if let Some(u) = &self.user_identity {
            let _ = write!(key, "u{}:{};", u.len(), u);
        }
        if let Some(c) = &self.custom_data {
            let _ = write!(key, "c{}:{};", c.len(), c);
        }
        Some(key)
    }

    /// Verify the active role (if any) names a role the model defines.
    ///
    /// Called by every query entry point before planning, right after
    /// [`validate_request_udfs`](Self::validate_request_udfs). A missing role
    /// is a hard [`EngineError::SecurityRoleNotFound`] error rather than a
    /// silent no-RLS run, so a typo can never leak data.
    pub(crate) fn validate_active_role(&self) -> QueryResult<()> {
        for name in &self.active_roles {
            let role = self.model.security_role(name).map_err(QueryError::Engine)?;
            // Dynamic predicates need a runtime identity; verify substitution
            // succeeds (fail closed up front if an identity is unset) so every
            // query path is guarded uniformly before any planning.
            self.substitute_identity_in_predicates(role.table_filters())?;
        }
        Ok(())
    }

    /// Fail closed when more than one role is active on a query path that does
    /// not yet implement the union (auto-refresh, auto-tier, explain,
    /// drillthrough). The main `query` path handles the union itself.
    fn reject_multi_role(&self) -> QueryResult<()> {
        if self.active_roles.len() > 1 {
            return Err(QueryError::InvalidQuery(
                "multiple active security roles (role union) are supported on query() / \
                 query_with_cancellation only in this version; this path requires a single \
                 active role"
                    .into(),
            ));
        }
        Ok(())
    }

    /// Rewrite a multi-role query into a single-table OR slicer.
    ///
    /// The union "a row is visible if any active role permits it" is, when every
    /// role restricts the **same** table with **one** predicate, exactly an
    /// `OR`-list slicer on that table — which is sealed (request-level, never
    /// stripped by a measure context op) and restricts the fact through the same
    /// enforceable single-hop propagation as a single role. This validates that
    /// shape, verifies the table is enforceable by planning one role (reusing the
    /// RLS relevance/`RowLevelSecurityNotEnforceable` gate), and returns the
    /// request with `or_filters` injected. Unsupported shapes fail closed.
    fn build_role_union_request(&self, request: QueryRequest) -> QueryResult<QueryRequest> {
        if request.calculation_group.is_some() {
            return Err(QueryError::InvalidQuery(
                "multi-role union is not supported together with a calculation group".into(),
            ));
        }
        if !request.or_filters.is_empty() {
            return Err(QueryError::InvalidQuery(
                "multi-role union is not supported together with a user OR filter (`or_filters`)"
                    .into(),
            ));
        }

        let mut conditions: Vec<FilterCondition> = Vec::new();
        let mut union_table: Option<String> = None;
        for name in &self.active_roles {
            let role = self.model.security_role(name).map_err(QueryError::Engine)?;
            // Resolve dynamic predicates to the runtime identity up front (fail
            // closed if unset) so the union never carries a placeholder value.
            let preds = self.substitute_identity_in_predicates(role.table_filters())?;
            if preds.is_empty() {
                // A role with no filters permits every row → the union permits
                // every row → no restriction at all.
                return Ok(request);
            }
            if preds.len() != 1 {
                return Err(QueryError::InvalidQuery(format!(
                    "multi-role union (v1) supports one predicate per role; role '{name}' has {} \
                     — model it as a single-predicate role, or activate one role at a time",
                    preds.len()
                )));
            }
            let predicate = &preds[0];
            match &union_table {
                None => union_table = Some(predicate.table.clone()),
                Some(t) if !t.eq_ignore_ascii_case(&predicate.table) => {
                    return Err(QueryError::InvalidQuery(format!(
                        "multi-role union (v1) requires all active roles to filter the same \
                         table; got '{t}' and '{}'",
                        predicate.table
                    )));
                }
                _ => {}
            }
            conditions.push(predicate_to_filter_condition(predicate));
        }

        // Enforceability: the union table must restrict the fact for THIS query.
        // Reuse the single-role RLS gate by planning one role; if the planner
        // refuses (RowLevelSecurityNotEnforceable for a non-single-hop-equi
        // table), refuse too rather than risk leaving the fact unrestricted.
        // The predicates are substituted (concrete identity) before planning.
        if let Some(name) = self.active_roles.first() {
            let role = self.model.security_role(name).map_err(QueryError::Engine)?;
            let preds = self.substitute_identity_in_predicates(role.table_filters())?;
            PushdownPlanner::plan(&request, &self.model, &self.registry, &preds)?;
        }

        let mut rewritten = request;
        rewritten.or_filters = conditions;
        Ok(rewritten)
    }

    /// Resolve a calculation-group application against the current model.
    ///
    /// When `request.calculation_group` is set, this expands the named group's
    /// selected items across the request's measures into ephemeral synthetic
    /// measures (measures-outer / items-inner, each named `"{measure} [{item}]"`),
    /// builds an **overlay** model = the current model plus those synthetic
    /// measures, and rewrites the request to ask for the synthetic measure
    /// names with `calculation_group` cleared. The overlay is per-query and
    /// never written back to the persistent model.
    ///
    /// Returns `Ok(Some((overlay_model, expanded_request)))` when an
    /// application is present, or `Ok(None)` when it is not (the caller plans
    /// against `self.model` and the original request unchanged).
    ///
    /// # Errors
    ///
    /// Wraps [`EngineError`] in [`QueryError::Engine`] for an unknown group,
    /// unknown item, unknown measure, or a synthetic-name collision with an
    /// existing model measure.
    fn resolve_calculation_group(
        &self,
        request: &QueryRequest,
    ) -> QueryResult<Option<(DataModel, QueryRequest)>> {
        let Some(application) = &request.calculation_group else {
            return Ok(None);
        };

        // Expand the application into synthetic measures + their ordered names
        // (measures-outer / items-inner). Errors (unknown group/item/measure,
        // name collision) are surfaced as typed engine errors.
        let (synthetic, names) = engine_core::model::calculation_group::expand_calculation_group(
            &self.model,
            &request.measures,
            &application.group,
            &application.items,
        )
        .map_err(QueryError::Engine)?;

        // Cheap overlay: clone the model and append the synthetic measures
        // (they are derived from already-validated parts, so no full
        // re-validation — only a name-collision check).
        let overlay = self
            .model
            .with_overlay_measures(synthetic)
            .map_err(QueryError::Engine)?;

        // Rewrite the request to ask for the synthetic measures by name, with
        // the application cleared (it has been expanded).
        let expanded = QueryRequest {
            measures: names,
            calculation_group: None,
            ..request.clone()
        };

        Ok(Some((overlay, expanded)))
    }

    /// Resolve the active role to its filter predicates (an empty slice when
    /// no role is active). Caller must have run
    /// [`validate_active_role`](Self::validate_active_role) first; an unknown
    /// role here degrades safely to an empty slice (no enforcement), but
    /// validation guarantees that case never reaches a query.
    fn active_role_filters(&self) -> QueryResult<Vec<FilterPredicate>> {
        // Single-role enforcement. The multi-role union is handled separately
        // (see `build_role_union_request`) and never reaches a path that calls
        // this, so returning a single role's predicates here is safe. Dynamic
        // predicates are substituted to the runtime identity (fail closed if
        // unset) so every consumer sees concrete, owned static predicates.
        let preds: &[FilterPredicate] = match self.active_roles.first() {
            Some(name) if self.active_roles.len() == 1 => self
                .model
                .security_role(name)
                .map(|r| r.table_filters())
                .unwrap_or(&[]),
            _ => &[],
        };
        self.substitute_identity_in_predicates(preds)
    }

    /// Rebuild the effective UDF registry from the current model, native
    /// UDFs, and sandbox config, capturing any deferred script error.
    fn rebuild_effective_udfs(&mut self) {
        let (effective, error) =
            build_effective_registry(&self.model, &self.udfs, &self.script_sandbox_config);
        self.effective_udfs = effective;
        self.script_build_error = error;
    }

    /// Verify that every UDF called by the request's measures is registered
    /// (in the **effective** registry: native UDFs + model script functions).
    ///
    /// Called by the query entry points before planning so an unregistered
    /// (or typo'd) function name fails fast with a clear
    /// [`EngineError::UnknownFunction`] instead of a DataFusion error
    /// mid-execution. Unknown measure names are skipped here — the planner
    /// reports those with its own error.
    ///
    /// Also surfaces any deferred script-build error (a model script colliding
    /// with a native UDF name) before query execution, so a query never runs
    /// against a half-built registry.
    pub(crate) fn validate_request_udfs(&self, request: &QueryRequest) -> QueryResult<()> {
        if let Some(e) = &self.script_build_error {
            return Err(QueryError::Engine(clone_script_error(e)));
        }
        for measure_name in &request.measures {
            let Ok(measure) = self.model.measure(measure_name) else {
                continue;
            };
            // Measure references are expanded so calls inside referenced
            // measures are covered too. Expansion failures (e.g. a missing
            // reference) are reported by model validation / the planner.
            let expression = if expression::has_measure_ref(measure.expression()) {
                match expression::expand_measure_refs(measure.expression(), &self.model) {
                    Ok(expanded) => std::borrow::Cow::Owned(expanded),
                    Err(_) => continue,
                }
            } else {
                std::borrow::Cow::Borrowed(measure.expression())
            };
            for name in expression.call_names() {
                if self.effective_udfs.get(name).is_none() {
                    return Err(QueryError::Engine(EngineError::UnknownFunction {
                        name: name.to_string(),
                        referenced_by: format!("measure '{measure_name}'"),
                    }));
                }
            }
        }
        Ok(())
    }

    /// Validate a candidate measure definition (source text) against the live
    /// model **without rebuilding it** — editor-time feedback for measure
    /// authoring (Calcula Studio).
    ///
    /// Parses `text` (a [`ParseError`](EngineError) carrying the source position
    /// on a syntax error), then validates the parsed measure against the model:
    /// circular / unknown measure references, unknown qualified columns
    /// (`Table[Column]`), and unregistered UDF calls. Much cheaper than
    /// reconstructing the whole model on every keystroke (it checks only the
    /// candidate). Returns `Ok(())` if the measure would be accepted on those
    /// axes.
    ///
    /// This is a fast pre-check, not a full guarantee: relationship reachability
    /// and bare (unqualified) column references are not validated here —
    /// [`add_measure`](Self::add_measure) / query planning remain the final
    /// authority. `name` may match an existing measure (validating an edit) or
    /// be new.
    pub fn validate_measure_text(&self, name: &str, text: &str) -> QueryResult<()> {
        let expr = parse_measure_expression(text).map_err(QueryError::Engine)?;
        let candidate = Measure::new(name, expr);

        // Structural checks against the model (measure refs + qualified columns).
        self.model
            .validate_candidate_measure(&candidate)
            .map_err(QueryError::Engine)?;

        // UDF calls must be registered (needs the engine's effective UDF set).
        if let Some(e) = &self.script_build_error {
            return Err(QueryError::Engine(clone_script_error(e)));
        }
        for call in candidate.expression().call_names() {
            if self.effective_udfs.get(call).is_none() {
                return Err(QueryError::Engine(EngineError::UnknownFunction {
                    name: call.to_string(),
                    referenced_by: format!("measure '{name}'"),
                }));
            }
        }
        Ok(())
    }

    /// Bind a model table name to a registered connector and source location.
    pub fn bind_table(
        &mut self,
        model_table: impl Into<String>,
        connector_index: usize,
        binding: SourceBinding,
    ) {
        self.registry.bind(model_table, connector_index, binding);
    }

    /// Execute a query against the model using registered data sources.
    ///
    /// The query planner decides what to push down and what to compute locally.
    /// Tables configured for in-memory storage are served from the cache.
    /// If query caching is enabled, repeated identical queries are served
    /// from the result cache.
    ///
    /// # Result ordering
    ///
    /// Results honor [`QueryRequest::order_by`] and [`QueryRequest::limit`].
    /// When `order_by` is empty and `group_by` is non-empty, rows are ordered
    /// by the group-by columns in declaration order (ascending), so grouped
    /// (pivot) output is always deterministic — previously row order was
    /// whatever the source or DataFusion happened to return. Dimension
    /// ordering respects each column's model-declared `sort_by_column` in the
    /// SQL-ordered execution paths (pushed single-table aggregation and local
    /// aggregation); see [`QueryRequest`] for details.
    ///
    /// # Totals (ROLLUP subtotals)
    ///
    /// When [`QueryRequest::totals`] is [`TotalsMode::Rollup`], the result
    /// contains the detail rows plus subtotal rows per group-by prefix and a
    /// grand total — all computed in **one** query (one fact-table
    /// scan/fetch; each subtotal level is recomputed at that level, so
    /// non-additive measures like DISTINCTCOUNT and AVG are correct). The
    /// result gains a trailing `Int32` column named [`GROUPING_ID_COLUMN`]
    /// (`"__grouping_id"`): a bitmask with bit `i` (LSB = `group_by[0]`) set
    /// when `group_by[i]` is rolled up in that row — `0` for detail rows,
    /// all bits set for the grand total. Subtotal `NULL` dimension values
    /// are thereby distinguishable from real `NULL`s. With an empty
    /// `group_by` the result is the single grand-total row with
    /// `__grouping_id` = 0. Ordering defaults are unchanged (subtotal rows
    /// sort after their group's detail rows under the default ascending
    /// group-by ordering); `limit` applies after subtotal rows are included.
    /// See [`TotalsMode`] for the unsupported query shapes (lookups, window
    /// measures, QUERY-in-VAR, multi-fact-table requests, unsafe group-by
    /// relationships), which return a typed error rather than wrong totals.
    ///
    /// # Hierarchy drill-down
    ///
    /// Set [`QueryRequest::hierarchy_group_by`] to group by the levels of a
    /// model-defined [`Hierarchy`]: the level columns (in drill order, up to
    /// the requested depth) are appended to `group_by` and behave like
    /// ordinary group-by columns from there — including for ROLLUP totals
    /// (each level becomes a drill subtotal) and default ordering. The
    /// hierarchy's [`RaggedBehavior`] is applied to the result; level cells
    /// equal to a level's `stopper_value` are treated as NULL-equivalent.
    /// See [`HierarchyGroupBy`] for depth semantics and validation rules.
    ///
    /// ```rust,no_run
    /// # use bi_engine::*;
    /// # async fn example(engine: Engine) -> Result<(), Box<dyn std::error::Error>> {
    /// // Drill two levels into the Geography hierarchy:
    /// // Revenue by country, state (state blanks per the model's RaggedBehavior).
    /// let batches = engine
    ///     .query(QueryRequest {
    ///         measures: vec!["Revenue".into()],
    ///         hierarchy_group_by: Some(HierarchyGroupBy::new("Geography", 2)),
    ///         ..Default::default()
    ///     })
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Concurrency
    ///
    /// Takes `&self`: the engine is `Send + Sync`, so hosts can share it as
    /// `Arc<Engine>` and run multiple queries concurrently. This and
    /// [`query_explained`](Self::query_explained) /
    /// [`query_with_cancellation`](Self::query_with_cancellation) are the
    /// concurrent-safe query paths; [`query_auto_refresh`](Self::query_auto_refresh)
    /// and [`query_auto_tier`](Self::query_auto_tier) mutate the in-memory
    /// table cache and therefore keep `&mut self`.
    pub async fn query(&self, request: QueryRequest) -> QueryResult<Vec<RecordBatch>> {
        self.query_with_cancellation(request, CancellationToken::new())
            .await
    }

    /// Execute a query and return the results **with per-column metadata**.
    ///
    /// Identical execution to [`query`](Self::query), plus a [`ResultColumn`]
    /// for each result column describing what it is — dimension vs. measure vs.
    /// `__grouping_id` vs. rank — and attaching the model facts a host would
    /// otherwise re-derive by string-matching column names: the measure's
    /// `format_string` / `display_name` / `description`, the dimension's source
    /// `Table[Column]` and `display_name`, and (for a calculation group) which
    /// base measure and item produced each `"M [I]"` column. Centralizing this
    /// keeps Calcula and Calcula Studio from drifting on the mapping.
    ///
    /// The metadata is derived from the executed request and the result schema,
    /// so it reflects calculation-group expansion and the appended rank column.
    /// An empty result still yields metadata (from the result schema).
    pub async fn query_with_meta(
        &self,
        request: QueryRequest,
    ) -> QueryResult<(Vec<RecordBatch>, Vec<ResultColumn>)> {
        let batches = self.query(request.clone()).await?;
        let meta = match batches.first() {
            Some(batch) => build_result_metadata(&self.model, &request, batch.schema().as_ref()),
            // No batch at all (not even an empty one) → no schema to describe.
            None => Vec::new(),
        };
        Ok((batches, meta))
    }

    /// Execute a query that can be cancelled from another task.
    ///
    /// Like [`query`](Self::query), but stops with [`QueryError::Cancelled`]
    /// when `token` is cancelled. Cancellation is cooperative: the token is
    /// checked at execution phase boundaries (before fetches, before local
    /// registration, before each measure-evaluation block, before the final
    /// SQL) and raced against the long-lived awaits (connector fetches,
    /// DataFusion execution), so a slow DirectQuery fetch is abandoned
    /// promptly.
    ///
    /// # Limitation
    ///
    /// Cancelling drops the in-flight connector futures, which stops the
    /// client-side work — but the database server may continue executing an
    /// already-submitted statement to completion. Cancellation releases the
    /// caller; it does not guarantee the source stops working.
    ///
    /// ```rust,no_run
    /// # use std::sync::Arc;
    /// # use bi_engine::*;
    /// # async fn example(engine: Arc<Engine>, request: QueryRequest)
    /// # -> Result<(), Box<dyn std::error::Error>> {
    /// let token = CancellationToken::new();
    /// let cancel_handle = token.clone();
    /// let task = tokio::spawn({
    ///     let engine = Arc::clone(&engine);
    ///     async move { engine.query_with_cancellation(request, token).await }
    /// });
    /// // ... user navigates away:
    /// cancel_handle.cancel();
    /// assert!(matches!(task.await?, Err(QueryError::Cancelled)));
    /// # Ok(())
    /// # }
    /// ```
    pub async fn query_with_cancellation(
        &self,
        request: QueryRequest,
        token: CancellationToken,
    ) -> QueryResult<Vec<RecordBatch>> {
        // A pre-cancelled token never executes anything (not even a cache
        // lookup) — the caller already walked away from the result.
        if token.is_cancelled() {
            return Err(QueryError::Cancelled);
        }

        // Fail fast (with a clear error) on unregistered UDF calls and an
        // unknown active role.
        self.validate_request_udfs(&request)?;
        self.validate_active_role()?;

        // Measure-value ranking (RANKX) is the OUTERMOST post-aggregation step:
        // run the underlying query (which may itself apply a HAVING filter),
        // append the rank column, then apply the row limit. Handled before
        // caching/planning so it composes with every execution path.
        if request.rank_by.is_some() {
            return self.query_with_ranking(request, token).await;
        }

        // Top-N groups (tie-inclusive, DAX `TOPN`) is an outer post-aggregation
        // step like RANKX: run the underlying query (which may apply a HAVING
        // filter first), keep the top-N groups by measure, then re-apply the row
        // limit. Handled before caching/planning so it composes with every path.
        if request.top_n.is_some() {
            return self.query_with_topn(request, token).await;
        }

        // Measure-value filters (HAVING) are handled here — before caching and
        // planning — so they compose uniformly with every execution path. Run
        // the underlying query without them (and without the row limit), then
        // filter the result rows by measure value and apply the limit. The inner
        // query is cached normally; the filtered result is cheap to recompute.
        if !request.measure_filters.is_empty() {
            return self.query_with_measure_filters(request, token).await;
        }

        // Multi-role row-level-security union: rewrite the role set into an
        // equivalent sealed single-table OR slicer (`or_filters`) and plan
        // WITHOUT roles. The OR rides the same enforceable single-hop propagation
        // as a single role; unsupported shapes (cross-table roles, multi-predicate
        // roles, a non-enforceable table) fail closed inside the builder.
        let request = if self.active_roles.len() > 1 {
            self.build_role_union_request(request)?
        } else {
            request
        };

        // Resolve any calculation-group application up front (a typed error
        // for an unknown group/item/measure or a synthetic-name collision).
        // When present this yields an overlay model (self.model + ephemeral
        // synthetic measures) and an expanded request asking for those
        // synthetic measures by name; otherwise planning uses self.model and
        // the original request unchanged.
        let overlay = self.resolve_calculation_group(&request)?;
        let (model, effective_request) = match &overlay {
            Some((overlay_model, expanded)) => (overlay_model, expanded),
            None => (&self.model, &request),
        };

        // Check the query cache first. The guard is dropped before any
        // await: key computation and lookup are synchronous. The active role
        // is part of the key — a result computed under one role must never be
        // served to another. The key is computed from the ORIGINAL request
        // (which carries the calculation-group application), so different
        // applications never share a cache entry.
        let (cache_key, cache_version, cached) = {
            let mut query_cache = self.query_cache.lock();
            let version = query_cache.model_version();
            let key = query_cache::query_cache_key(
                &request,
                version,
                self.effective_udfs.identity_hash(),
                self.role_cache_key().as_deref(),
            );
            let cached = query_cache.get(key);
            (key, version, cached)
        };
        if let Some(cached) = cached {
            return Ok(cached);
        }

        let role_filters = self.active_role_filters()?;
        // Resolve host-only context-driven calculated columns' scalars so the
        // planner can push their CASE into the source GROUP BY (single-fact,
        // pushable shape, supporting connector). Empty for any other query —
        // the planner then aggregates locally and the executor resolves the
        // scalar itself.
        let context_column_cases = self
            .resolve_pushable_context_columns(&request, &token)
            .await?;
        let plan = if context_column_cases.is_empty() {
            PushdownPlanner::plan(effective_request, model, &self.registry, &role_filters)?
        } else {
            PushdownPlanner::plan_with_context_columns(
                effective_request,
                model,
                &self.registry,
                &role_filters,
                &context_column_cases,
            )?
        };
        let batches = map_script_error(
            QueryExecutor::execute_with_cancellation(
                &plan,
                model,
                &self.registry,
                Some(&self.cache),
                Some(self.max_inline_in_values),
                Some(self.effective_udfs.as_ref()),
                &role_filters,
                &token,
            )
            .await,
        )?;

        // Store the result unless the cache version moved while executing
        // (a concurrent `clear_query_cache`): a stale-keyed entry could
        // never be served, but skipping it avoids dead weight in the LRU.
        {
            let mut query_cache = self.query_cache.lock();
            if query_cache.model_version() == cache_version {
                query_cache.put(cache_key, batches.clone());
            }
        }
        Ok(batches)
    }

    /// Evaluate a query carrying a measure-value ranking (`RANKX`-style).
    ///
    /// Runs the underlying query with the ranking removed and **no** row limit
    /// (so every group is ranked), appends the rank column, then applies the
    /// limit — composing `order_by` + `limit` + rank into "top N by measure".
    /// The inner query (including any HAVING measure filter) is evaluated by
    /// [`query_with_cancellation`](Self::query_with_cancellation); only the rank
    /// append + limit are added here. Unsupported combinations (ROLLUP totals,
    /// calculation groups) fail closed rather than mislead.
    async fn query_with_ranking(
        &self,
        request: QueryRequest,
        token: CancellationToken,
    ) -> QueryResult<Vec<RecordBatch>> {
        // Safe: the caller (`query_with_cancellation`) only routes here when set.
        let rank = request
            .rank_by
            .clone()
            .expect("query_with_ranking is only called when rank_by is set");

        if request.totals == TotalsMode::Rollup {
            return Err(QueryError::InvalidQuery(
                "rank_by is not supported with ROLLUP totals (ranking would order subtotal and \
                 grand-total rows among the details); request the ranked detail and the totals \
                 separately"
                    .into(),
            ));
        }
        if request.calculation_group.is_some() {
            return Err(QueryError::InvalidQuery(
                "rank_by is not supported together with a calculation group; apply the ranking in \
                 a separate request"
                    .into(),
            ));
        }
        if !request
            .measures
            .iter()
            .any(|m| m.eq_ignore_ascii_case(&rank.measure))
        {
            return Err(QueryError::InvalidQuery(format!(
                "rank_by references measure '{}', which is not in the request's measures",
                rank.measure
            )));
        }
        for pc in &rank.partition_by {
            if !request
                .group_by
                .iter()
                .any(|g| g.column.eq_ignore_ascii_case(&pc.column))
            {
                return Err(QueryError::InvalidQuery(format!(
                    "rank_by partition column '{}' must be one of the request's group_by columns",
                    pc.column
                )));
            }
        }

        let mut inner = request.clone();
        inner.rank_by = None;
        let limit = inner.limit.take();
        let batches = Box::pin(self.query_with_cancellation(inner, token)).await?;

        let ranked = apply_ranking(&batches, &rank)?;
        Ok(truncate_batches_to_limit(ranked, limit))
    }

    /// Evaluate a query carrying measure-value filters (a `HAVING` clause).
    ///
    /// Runs the underlying query with the filters removed and **no** row limit
    /// (so every group that could pass is present and already ordered), then
    /// keeps only the rows whose measures satisfy the filters and applies the
    /// limit — composing `order_by` + `limit` + filters into top-N-over-
    /// threshold. Unsupported combinations (ROLLUP totals, calculation groups)
    /// fail closed rather than mislead.
    async fn query_with_measure_filters(
        &self,
        request: QueryRequest,
        token: CancellationToken,
    ) -> QueryResult<Vec<RecordBatch>> {
        if request.totals == TotalsMode::Rollup {
            return Err(QueryError::InvalidQuery(
                "measure-value filters are not supported with ROLLUP totals (a measure filter \
                 would drop subtotal/grand-total rows by their aggregate value); request the \
                 filtered detail and the totals separately"
                    .into(),
            ));
        }
        if request.calculation_group.is_some() {
            return Err(QueryError::InvalidQuery(
                "measure-value filters are not supported together with a calculation group; \
                 apply the filter in a separate request"
                    .into(),
            ));
        }
        for mf in &request.measure_filters {
            if !request
                .measures
                .iter()
                .any(|m| m.eq_ignore_ascii_case(&mf.measure))
            {
                return Err(QueryError::InvalidQuery(format!(
                    "measure-value filter references measure '{}', which is not in the request's \
                     measures",
                    mf.measure
                )));
            }
        }

        let mut inner = request.clone();
        inner.measure_filters = Vec::new();
        let limit = inner.limit.take();
        let batches = Box::pin(self.query_with_cancellation(inner, token)).await?;

        let filtered = apply_measure_value_filters(&batches, &request.measure_filters)?;
        Ok(truncate_batches_to_limit(filtered, limit))
    }

    /// Evaluate a query carrying a top-N filter (DAX `TOPN`, tie-inclusive).
    ///
    /// Runs the underlying query with the top-N removed and **no** row limit
    /// (every group present and already ordered), keeps the top-N groups by
    /// measure — every group tied at the boundary value included — then applies
    /// the limit. The inner query (including any HAVING measure filter) is
    /// evaluated by [`query_with_cancellation`](Self::query_with_cancellation), so
    /// measure filters apply **before** the top-N. Unsupported combinations
    /// (ROLLUP totals, calculation groups) fail closed rather than mislead.
    async fn query_with_topn(
        &self,
        request: QueryRequest,
        token: CancellationToken,
    ) -> QueryResult<Vec<RecordBatch>> {
        // Safe: the caller (`query_with_cancellation`) only routes here when set.
        let topn = request
            .top_n
            .clone()
            .expect("query_with_topn is only called when top_n is set");

        if request.totals == TotalsMode::Rollup {
            return Err(QueryError::InvalidQuery(
                "top_n is not supported with ROLLUP totals (it would rank subtotal/grand-total \
                 rows among the details); request the top-N detail and the totals separately"
                    .into(),
            ));
        }
        if request.calculation_group.is_some() {
            return Err(QueryError::InvalidQuery(
                "top_n is not supported together with a calculation group; apply the top-N in a \
                 separate request"
                    .into(),
            ));
        }
        if !request
            .measures
            .iter()
            .any(|m| m.eq_ignore_ascii_case(&topn.measure))
        {
            return Err(QueryError::InvalidQuery(format!(
                "top_n references measure '{}', which is not in the request's measures",
                topn.measure
            )));
        }
        for pc in &topn.partition_by {
            if !request
                .group_by
                .iter()
                .any(|g| g.column.eq_ignore_ascii_case(&pc.column))
            {
                return Err(QueryError::InvalidQuery(format!(
                    "top_n partition column '{}' must be one of the request's group_by columns",
                    pc.column
                )));
            }
        }

        let mut inner = request.clone();
        inner.top_n = None;
        let limit = inner.limit.take();
        let batches = Box::pin(self.query_with_cancellation(inner, token)).await?;

        let topped = apply_topn_with_ties(&batches, &topn)?;
        Ok(truncate_batches_to_limit(topped, limit))
    }

    /// Return the **raw fact rows** behind a pivot cell (drillthrough /
    /// detail-rows).
    ///
    /// Given a [`DetailRequest`], this fetches the detail (fact) table's rows
    /// filtered to the cell's coordinates and slicers, with **no aggregation**
    /// — a `SELECT columns ... WHERE ... ORDER BY ... LIMIT n`. Hosts call it
    /// when a user double-clicks a cell to inspect the underlying
    /// transactions.
    ///
    /// # Row-level security
    ///
    /// Drillthrough exposes raw rows, so RLS is enforced even more strictly
    /// than for aggregates. The active role's predicates on the detail table
    /// are sealed onto the detail fetch; a role (or a cell-coordinate filter)
    /// on a related **dimension** is propagated to the detail table so only
    /// rows joined to permitted dimension rows are returned; and a role on a
    /// dimension reachable only through a relationship the engine cannot
    /// enforce (non-equi / many-to-many / composite-key / inactive /
    /// multi-hop) **fails closed** with
    /// [`EngineError::RowLevelSecurityNotEnforceable`] rather than returning
    /// under-restricted rows. With no active role, rows are unrestricted (up
    /// to the limit).
    ///
    /// A role that filters a table genuinely unreachable from the detail table
    /// is an irrelevant no-op (it restricts nothing the drillthrough can
    /// observe). The common case — drilling into a fact with roles on its
    /// dimensions — is enforced directly; v1 only enforces the detail table
    /// itself and its single-hop equi dimensions, so drilling *into* a
    /// dimension table while a role filters a sibling or snowflake dimension
    /// fails closed rather than risk an unenforced restriction.
    ///
    /// # Output columns
    ///
    /// `columns` returns columns of the detail table only; v1 does not join
    /// back to dimensions to surface dimension attributes (a host that needs
    /// `Geography.region` in the output resolves it separately).
    ///
    /// # Caching
    ///
    /// Drillthrough results are **never** stored in the query-result cache:
    /// they are interactive, one-off, and per-cell, so caching them would add
    /// no hit-rate while widening the surface for a cache-key/role-isolation
    /// mistake. (The detail table's own data is still served from the
    /// in-memory cache when present — only the drillthrough *result* is
    /// uncached.)
    ///
    /// `request.limit` is mandatory and applies after ordering; `limit == 0`
    /// is a valid request that returns an empty result.
    ///
    /// # Errors
    ///
    /// - [`QueryError::SourceNotRegistered`] if the detail table is neither
    ///   bound to a source nor cached.
    /// - [`QueryError::Engine`] wrapping
    ///   [`EngineError::SecurityRoleNotFound`] for an unknown active role, or
    ///   [`EngineError::RowLevelSecurityNotEnforceable`] on a fail-closed
    ///   refusal.
    /// - [`QueryError::InvalidQuery`] when a filter or ORDER BY clause cannot
    ///   be mapped to the detail table or a propagatable dimension.
    ///
    /// Takes `&self`: like [`query`](Self::query), this is concurrency-safe.
    pub async fn query_rows(&self, request: DetailRequest) -> QueryResult<Vec<RecordBatch>> {
        self.query_rows_with_cancellation(request, CancellationToken::new())
            .await
    }

    /// Return the raw detail rows behind a pivot cell, cancellable from another
    /// task.
    ///
    /// Like [`query_rows`](Self::query_rows), but stops with
    /// [`QueryError::Cancelled`] when `token` is cancelled. Cancellation is
    /// cooperative: it is checked before any work and raced against the
    /// connector fetches.
    pub async fn query_rows_with_cancellation(
        &self,
        request: DetailRequest,
        token: CancellationToken,
    ) -> QueryResult<Vec<RecordBatch>> {
        // A pre-cancelled token never executes anything.
        if token.is_cancelled() {
            return Err(QueryError::Cancelled);
        }

        // Mirror the query preamble: validate the active role (an unknown role
        // is a hard error, never a silent no-RLS run). There are no measures
        // in a DetailRequest, so no UDF validation is needed.
        self.validate_active_role()?;
        // Drillthrough returns raw fact rows; the multi-role union rewrite is
        // only wired through the aggregate `query` path. Fail closed rather
        // than emit unrestricted detail rows under multiple active roles.
        self.reject_multi_role()?;
        let role_filters = self.active_role_filters()?;

        // Resolve any context-driven calculated columns requested as detail
        // outputs: their scalar measures are evaluated from this request's
        // filter context (via the normal RLS-aware query path), so the per-row
        // segment label matches the segmented cell the user drilled from.
        let context_column_exprs = self
            .resolve_detail_context_columns(&request, &token)
            .await?;

        // Drillthrough results are intentionally NOT cached (see the doc
        // comment): interactive, one-off, per-cell. Go straight to execution.
        QueryExecutor::execute_detail(
            &request,
            &self.model,
            &self.registry,
            Some(&self.cache),
            Some(self.max_inline_in_values),
            &role_filters,
            &context_column_exprs,
            &token,
        )
        .await
    }

    /// Resolve the context-driven calculated columns requested in a
    /// [`DetailRequest`] into row-level expressions with their scalar measures
    /// substituted to literals.
    ///
    /// Each scalar is computed by an inner ungrouped query over this request's
    /// filter context — the same value the aggregation path would resolve — so
    /// the drillthrough segment labels match the cell. Fails closed on a
    /// non-context column, a cross-table reference (deferred for drillthrough),
    /// a non-simple-aggregate or context-op scalar measure, or a `NULL` scalar.
    async fn resolve_detail_context_columns(
        &self,
        request: &DetailRequest,
        token: &CancellationToken,
    ) -> QueryResult<Vec<(ColumnRef, Expression)>> {
        use engine_core::compute::expression::{expand_measure_refs, expr_literal_from_arrow};

        let mut resolved: Vec<(ColumnRef, Expression)> = Vec::new();
        for col_ref in &request.context_columns {
            let cc = self
                .model
                .context_column(&col_ref.column)
                .filter(|cc| cc.table().eq_ignore_ascii_case(&col_ref.table))
                .ok_or_else(|| {
                    QueryError::InvalidQuery(format!(
                        "'{}[{}]' is not a context-driven calculated column on the detail table",
                        col_ref.table, col_ref.column
                    ))
                })?;
            // Inline references to other context columns on the host (a cycle
            // fails closed), then enforce the drillthrough constraints on the
            // self-contained expression.
            let inlined = self
                .model
                .inline_context_column_refs(
                    cc.table(),
                    cc.expression(),
                    &mut vec![cc.name().to_lowercase()],
                )
                .map_err(QueryError::Engine)?;
            // v1: drillthrough supports only host-table-only context columns.
            for (t, _) in inlined.qualified_column_references() {
                if !t.eq_ignore_ascii_case(cc.table()) {
                    return Err(QueryError::InvalidQuery(format!(
                        "drillthrough does not yet support the cross-table context column '{}'; \
                         request it in an aggregation query instead",
                        cc.name()
                    )));
                }
            }

            let mut env: std::collections::HashMap<String, Expression> =
                std::collections::HashMap::new();
            for m_name in inlined.measure_references() {
                let measure = self.model.measure(m_name).map_err(QueryError::Engine)?;
                let expanded = expand_measure_refs(measure.expression(), &self.model)
                    .map_err(QueryError::Engine)?;
                if expanded.has_context_ops() || expanded.as_simple_aggregate().is_none() {
                    return Err(QueryError::InvalidQuery(format!(
                        "context-driven calculated column '{}' references measure '[{m_name}]', \
                         which must be a single aggregate over one table with no context operations",
                        cc.name()
                    )));
                }
                // Resolve the scalar under the cell's filter context.
                let inner = QueryRequest {
                    measures: vec![m_name.to_string()],
                    filters: request.filters.clone(),
                    ..Default::default()
                };
                let batches = Box::pin(self.query_with_cancellation(inner, token.clone())).await?;
                let lit = match batches.iter().find(|b| b.num_rows() > 0) {
                    Some(b) => expr_literal_from_arrow(b.column(0).as_ref(), 0)
                        .map_err(QueryError::Engine)?,
                    None => Expression::Blank,
                };
                if matches!(lit, Expression::Blank) {
                    return Err(QueryError::InvalidQuery(format!(
                        "context-driven calculated column '{}': its scalar measure '[{m_name}]' \
                         resolved to NULL under the filters, so the segmentation is undefined",
                        cc.name()
                    )));
                }
                env.insert(m_name.to_string(), lit);
            }
            resolved.push((col_ref.clone(), inlined.substitute_measure_refs(&env)));
        }
        Ok(resolved)
    }

    /// Names (lowercased) of every table in `fact`'s relationship-connected
    /// component, `fact` included — an undirected BFS over the model's
    /// relationships. A scalar measure aggregating over a table in this set can
    /// be cross-filtered by the fact's filter context in the local path, so
    /// [`resolve_pushable_context_columns`](Self::resolve_pushable_context_columns)
    /// declines to push such a context column (see its body).
    fn fact_connected_tables(&self, fact: &str) -> std::collections::HashSet<String> {
        let mut seen = std::collections::HashSet::new();
        seen.insert(fact.to_lowercase());
        let mut frontier = vec![fact.to_string()];
        while let Some(t) = frontier.pop() {
            for r in self.model.relationships() {
                let other = if r.from_table().eq_ignore_ascii_case(&t) {
                    Some(r.to_table())
                } else if r.to_table().eq_ignore_ascii_case(&t) {
                    Some(r.from_table())
                } else {
                    None
                };
                if let Some(o) = other {
                    if seen.insert(o.to_lowercase()) {
                        frontier.push(o.to_string());
                    }
                }
            }
        }
        seen
    }

    /// Resolve a query's host-only context-driven calculated columns into
    /// row-level expressions (scalar measures substituted to literals) **only
    /// when the whole query is shaped so the planner can push their `CASE`
    /// into the source `GROUP BY`** — single fact, simple pushable measures,
    /// all grouping on that fact, a connector that renders expressions.
    ///
    /// This is purely an optimization: a non-empty result lets the planner
    /// build a `PushedJoinAggregation`; an empty result (the default for any
    /// query that is not unambiguously pushable, or any context column that is
    /// cross-table / resolves to `NULL` / references a non-aggregate scalar)
    /// makes the planner aggregate locally — the long-standing path that
    /// resolves the same scalar itself. Because deferral reproduces the local
    /// result exactly, pushdown never changes an answer; it only moves the work.
    async fn resolve_pushable_context_columns(
        &self,
        request: &QueryRequest,
        token: &CancellationToken,
    ) -> QueryResult<Vec<(ColumnRef, Expression)>> {
        use engine_core::compute::expression::{expand_measure_refs, expr_literal_from_arrow};

        // Cheap, conservative shape gate. Any feature that forces (or merely
        // complicates) local aggregation defers to it — the planner and
        // executor own those paths. Pushdown handles only the plain
        // group-by/aggregate query.
        if !request.in_filters.is_empty()
            || !request.or_filters.is_empty()
            || !request.measure_filters.is_empty()
            || !request.lookups.is_empty()
            || request.rank_by.is_some()
            || request.top_n.is_some()
            || request.hierarchy_group_by.is_some()
            || request.calculation_group.is_some()
            || request.totals != TotalsMode::None
            || request.measures.is_empty()
        {
            return Ok(Vec::new());
        }

        // Context columns referenced on the group-by axis.
        let ctx_cols: Vec<&ColumnRef> = request
            .group_by
            .iter()
            .filter(|c| {
                self.model
                    .context_column(&c.column)
                    .is_some_and(|cc| cc.table().eq_ignore_ascii_case(&c.table))
            })
            .collect();
        if ctx_cols.is_empty() {
            return Ok(Vec::new());
        }

        // Single fact: every measure's home table is the same, non-empty table.
        let mut fact: Option<String> = None;
        for m in &request.measures {
            let mt = self.model.measure(m).map_err(QueryError::Engine)?.table();
            if mt.is_empty() {
                return Ok(Vec::new());
            }
            match &fact {
                None => fact = Some(mt.to_string()),
                Some(f) if f.eq_ignore_ascii_case(mt) => {}
                Some(_) => return Ok(Vec::new()),
            }
        }
        let Some(fact) = fact else {
            return Ok(Vec::new());
        };

        // All grouping (context columns included) lives on the fact, and the
        // fact's connector can render expression GROUP BY entries.
        if !request
            .group_by
            .iter()
            .all(|c| c.table.eq_ignore_ascii_case(&fact))
        {
            return Ok(Vec::new());
        }
        // In-memory facts are served locally (DataFusion), never pushed; and
        // their cache binding may carry a placeholder connector index. Defer.
        if self.model.table(&fact).is_ok_and(Table::is_in_memory) {
            return Ok(Vec::new());
        }
        let pushable = self
            .registry
            .connector_for(&fact)
            .map(AnyConnector::supports_expression_pushdown)
            .unwrap_or(false);
        if !pushable {
            return Ok(Vec::new());
        }

        // Tables in the fact's relationship-connected component. A scalar
        // measure aggregating over such a table can be cross-filtered by the
        // fact's filter context in the trusted local path (bidirectional
        // `FilterPropagation::Both` reverse-propagation, multi-hop), which the
        // inner scalar query below does NOT replicate (it fetches only the
        // scalar's own table). Pushing it would bake a different scalar into the
        // CASE than local computes — a silently-wrong segmentation. So any
        // scalar over a fact-connected table (other than the fact itself) defers
        // the whole query to local. A *disconnected* as-of reference (the
        // canonical pattern) is unaffected — its scalar is filtered only by its
        // own columns, identically on both paths.
        let fact_connected = self.fact_connected_tables(&fact);

        // Resolve each context column's row-level CASE. Any column that is not
        // self-contained-on-the-host, or whose scalar measure is not a single
        // aggregate / resolves to NULL, aborts pushdown for the whole query
        // (the local path supports those cases and produces the same result).
        let mut resolved: Vec<(ColumnRef, Expression)> = Vec::new();
        for col_ref in &ctx_cols {
            let cc = self
                .model
                .context_column(&col_ref.column)
                .filter(|cc| cc.table().eq_ignore_ascii_case(&col_ref.table))
                .ok_or_else(|| {
                    QueryError::InvalidQuery(format!(
                        "'{}[{}]' is not a context-driven calculated column",
                        col_ref.table, col_ref.column
                    ))
                })?;
            let inlined = self
                .model
                .inline_context_column_refs(
                    cc.table(),
                    cc.expression(),
                    &mut vec![cc.name().to_lowercase()],
                )
                .map_err(QueryError::Engine)?;
            // Pushdown v1: host-table-only context columns. A cross-table
            // reference defers the whole query to the local path.
            if inlined
                .qualified_column_references()
                .iter()
                .any(|(t, _)| !t.eq_ignore_ascii_case(cc.table()))
            {
                return Ok(Vec::new());
            }

            let mut env: std::collections::HashMap<String, Expression> =
                std::collections::HashMap::new();
            for m_name in inlined.measure_references() {
                let measure = self.model.measure(m_name).map_err(QueryError::Engine)?;
                let expanded = expand_measure_refs(measure.expression(), &self.model)
                    .map_err(QueryError::Engine)?;
                if expanded.has_context_ops() || expanded.as_simple_aggregate().is_none() {
                    return Ok(Vec::new());
                }
                // The scalar's source table must be the fact or fully
                // disconnected from it; a fact-connected scalar table can be
                // cross-filtered by the local path but not by the inner query
                // below, so pushing it would diverge — defer to local.
                let scalar_table = measure.table();
                if !scalar_table.eq_ignore_ascii_case(&fact)
                    && fact_connected.contains(&scalar_table.to_lowercase())
                {
                    return Ok(Vec::new());
                }
                let inner = QueryRequest {
                    measures: vec![m_name.to_string()],
                    filters: request.filters.clone(),
                    ..Default::default()
                };
                let batches = Box::pin(self.query_with_cancellation(inner, token.clone())).await?;
                let lit = match batches.iter().find(|b| b.num_rows() > 0) {
                    Some(b) => {
                        expr_literal_from_arrow(b.column(0).as_ref(), 0).map_err(QueryError::Engine)?
                    }
                    None => Expression::Blank,
                };
                if matches!(lit, Expression::Blank) {
                    return Ok(Vec::new());
                }
                env.insert(m_name.to_string(), lit);
            }
            resolved.push(((*col_ref).clone(), inlined.substitute_measure_refs(&env)));
        }
        Ok(resolved)
    }

    /// Execute a query, automatically refreshing any stale in-memory tables first.
    ///
    /// This is equivalent to calling [`Engine::refresh_stale`] followed by
    /// [`Engine::query`]. Tables whose cached data has exceeded their configured
    /// `refresh_interval` are re-fetched from their source before the query runs.
    ///
    /// Returns both the query results and the list of tables that were
    /// refreshed. The query proceeds even when some refreshes failed; the
    /// full [`RefreshReport`] (including failures) is available via
    /// [`Engine::last_refresh_report`].
    ///
    /// Takes `&mut self` because the refresh step replaces in-memory table
    /// data; [`query`](Self::query) is the concurrent-safe (`&self`) path.
    pub async fn query_auto_refresh(
        &mut self,
        request: QueryRequest,
    ) -> QueryResult<(Vec<RecordBatch>, Vec<String>)> {
        self.validate_request_udfs(&request)?;
        self.validate_active_role()?;
        // Multi-role union is implemented only on the concurrent `query` path
        // (it rewrites the request before planning). This path uses the raw
        // per-role filters, which are empty under multi-role — fail closed
        // rather than run with no row-level restriction.
        self.reject_multi_role()?;

        let refreshed = self
            .refresh_stale()
            .await
            .map_err(crate::QueryError::Engine)?
            .refreshed;

        // Resolve any calculation-group application (overlay model + expanded
        // request); plan against the original model/request otherwise.
        let overlay = self.resolve_calculation_group(&request)?;
        let (model, effective_request) = match &overlay {
            Some((overlay_model, expanded)) => (overlay_model, expanded),
            None => (&self.model, &request),
        };

        // Check query cache (after refresh — stale data was already
        // invalidated). The guard is dropped before any await. The active
        // role is part of the key (cross-role isolation). The key uses the
        // ORIGINAL request, which carries the calculation-group application.
        let (cache_key, cached) = {
            let mut query_cache = self.query_cache.lock();
            let key = query_cache::query_cache_key(
                &request,
                query_cache.model_version(),
                self.effective_udfs.identity_hash(),
                self.role_cache_key().as_deref(),
            );
            let cached = query_cache.get(key);
            (key, cached)
        };
        if let Some(cached) = cached {
            return Ok((cached, refreshed));
        }

        let role_filters = self.active_role_filters()?;
        let plan = PushdownPlanner::plan(effective_request, model, &self.registry, &role_filters)?;
        let batches = map_script_error(
            QueryExecutor::execute(
                &plan,
                model,
                &self.registry,
                Some(&self.cache),
                Some(self.max_inline_in_values),
                Some(self.effective_udfs.as_ref()),
                &role_filters,
            )
            .await,
        )?;

        self.query_cache.lock().put(cache_key, batches.clone());
        Ok((batches, refreshed))
    }

    /// Execute a query and return results with an execution plan.
    ///
    /// Like [`Engine::query`], but also returns an [`ExecutionPlan`] describing
    /// each phase of execution with timing and decision metadata.
    pub async fn query_explained(
        &self,
        request: QueryRequest,
    ) -> QueryResult<(Vec<RecordBatch>, ExecutionPlan)> {
        self.validate_request_udfs(&request)?;
        self.validate_active_role()?;
        // Explain reports the single-role plan; the multi-role union rewrite is
        // only applied on the `query` path. Fail closed here.
        self.reject_multi_role()?;

        let start = Instant::now();

        // Resolve any calculation-group application (overlay model + expanded
        // request); plan against the original model/request otherwise.
        let overlay = self.resolve_calculation_group(&request)?;
        let (model, effective_request) = match &overlay {
            Some((overlay_model, expanded)) => (overlay_model, expanded),
            None => (&self.model, &request),
        };

        let role_filters = self.active_role_filters()?;
        // Mirror the `query` path: resolve pushable context-column CASEs so the
        // explain output reports the same plan the query would actually run.
        let token = CancellationToken::new();
        let context_column_cases = self
            .resolve_pushable_context_columns(&request, &token)
            .await?;
        let (query_plan, pushdown_node) = PushdownPlanner::plan_explained(
            effective_request,
            model,
            &self.registry,
            &role_filters,
            &context_column_cases,
        )?;
        let (batches, exec_node) = map_script_error(
            QueryExecutor::execute_explained(
                &query_plan,
                model,
                &self.registry,
                Some(&self.cache),
                Some(self.max_inline_in_values),
                Some(self.effective_udfs.as_ref()),
                &role_filters,
            )
            .await,
        )?;

        let total_duration = start.elapsed();

        // Build summary.
        let measures_str = request.measures.join(", ");
        let summary = if request.group_by.is_empty() {
            format!("Query: [{measures_str}]")
        } else {
            let dims: Vec<String> = request
                .group_by
                .iter()
                .map(|c| format!("{}.{}", c.table, c.column))
                .collect();
            format!("Query: [{measures_str}] grouped by [{}]", dims.join(", "))
        };

        let root = PlanNode::new(PlanOperation::Planning, "Query Execution")
            .with_duration(total_duration)
            .with_child(pushdown_node)
            .with_child(exec_node);

        let plan = ExecutionPlan {
            summary,
            total_duration: total_duration.into(),
            root,
        };

        Ok((batches, plan))
    }

    /// Returns a reference to the in-memory cache for inspection.
    pub fn cache(&self) -> &InMemoryCache {
        &self.cache
    }

    /// Replace the data model, keeping the source registry and cache intact.
    ///
    /// Existing table bindings remain valid as long as the new model contains
    /// the same table names. Cached in-memory tables are preserved.
    ///
    /// The new model's script functions are compiled into the effective UDF
    /// registry under the host's current [`ScriptSandboxConfig`]. Returns any
    /// deferred script error (a script colliding with a native UDF name) so
    /// the host can react eagerly; the same error otherwise surfaces on the
    /// next query. The model itself was already validated when it was built /
    /// loaded, so its scripts are known to compile.
    pub fn set_model(&mut self, model: DataModel) -> EngineResult<()> {
        self.model = model;
        self.rebuild_effective_udfs();
        self.query_cache.lock().invalidate_all();
        match &self.script_build_error {
            Some(e) => Err(clone_script_error(e)),
            None => Ok(()),
        }
    }

    /// Returns a reference to the data model.
    pub fn model(&self) -> &DataModel {
        &self.model
    }

    /// Returns a reference to the source registry.
    pub fn registry(&self) -> &SourceRegistry {
        &self.registry
    }

    /// Returns a mutable reference to the source registry.
    pub fn registry_mut(&mut self) -> &mut SourceRegistry {
        &mut self.registry
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow::array::Float64Array;
    use arrow::datatypes::DataType as ArrowDataType;

    use crate::test_fixtures::make_test_batch;
    use crate::{
        create_udf, parse_measure, sum_measure, CancellationToken, Column, ColumnarValue,
        DataModel, DataType, Engine, EngineError, Measure, QueryError, QueryRequest, ScalarUDF,
        SourceBinding, StorageMode, Table, Volatility,
    };

    #[test]
    fn engine_new_creates_empty_registry() {
        let model = DataModel::builder()
            .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
            .build()
            .unwrap();

        let engine = Engine::new(model);
        assert_eq!(engine.model().tables().len(), 1);
        assert!(!engine.registry().has_table("Sales"));
    }

    // --- UDF registration and query-time validation ---

    /// `double(x) = x * 2` over Float64.
    fn double_udf() -> ScalarUDF {
        create_udf(
            "double",
            vec![ArrowDataType::Float64],
            ArrowDataType::Float64,
            Volatility::Immutable,
            Arc::new(|args: &[ColumnarValue]| {
                let arrays = ColumnarValue::values_to_arrays(args)?;
                let input = arrays[0]
                    .as_any()
                    .downcast_ref::<Float64Array>()
                    .expect("Float64 enforced by the UDF signature");
                let out: Float64Array = input.iter().map(|v| v.map(|x| x * 2.0)).collect();
                Ok(ColumnarValue::Array(Arc::new(out)))
            }),
        )
    }

    /// Model with measure `Doubled = SUM(double(Sales[amount]))`.
    fn model_with_udf_measure() -> DataModel {
        DataModel::builder()
            .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
            .add_measure(Measure::new(
                "Doubled",
                parse_measure("SUM(double(Sales[amount]))").unwrap(),
            ))
            .build()
            .unwrap()
    }

    #[test]
    fn register_udf_lists_and_replaces() {
        let mut engine = Engine::new(model_with_udf_measure());
        assert!(engine.registered_udfs().is_empty());

        engine.register_udf(double_udf(), 1).unwrap();
        assert_eq!(engine.registered_udfs(), vec!["double".to_string()]);

        // Same name re-registers (replaces), no duplicate.
        engine.register_udf(double_udf(), 2).unwrap();
        assert_eq!(engine.registered_udfs(), vec!["double".to_string()]);
    }

    #[test]
    fn register_udf_rejects_invalid_name() {
        let mut engine = Engine::new(model_with_udf_measure());
        let bad = create_udf(
            "Bad Name",
            vec![],
            ArrowDataType::Float64,
            Volatility::Immutable,
            Arc::new(|_| {
                Ok(ColumnarValue::Array(Arc::new(Float64Array::from(
                    Vec::<f64>::new(),
                ))))
            }),
        );
        assert!(matches!(
            engine.register_udf(bad, 1),
            Err(EngineError::InvalidIdentifier { .. })
        ));
    }

    #[tokio::test]
    async fn query_with_unregistered_udf_fails_with_clear_error() {
        let engine = Engine::new(model_with_udf_measure());

        let err = engine
            .query(QueryRequest {
                measures: vec!["Doubled".into()],
                ..Default::default()
            })
            .await
            .unwrap_err();

        match err {
            QueryError::Engine(EngineError::UnknownFunction {
                name,
                referenced_by,
            }) => {
                assert_eq!(name, "double");
                assert!(referenced_by.contains("Doubled"));
            }
            other => panic!("expected UnknownFunction, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn query_after_registration_passes_udf_validation() {
        let mut engine = Engine::new(model_with_udf_measure());
        engine.register_udf(double_udf(), 1).unwrap();

        // UDF validation passes; the query then fails on the (intentionally)
        // missing source binding — NOT on the function name.
        let err = engine
            .query(QueryRequest {
                measures: vec!["Doubled".into()],
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert!(
            matches!(err, QueryError::SourceNotRegistered(_)),
            "expected SourceNotRegistered, got {err:?}"
        );
    }

    #[test]
    fn register_udf_changes_cache_identity_and_bumps_model_version() {
        let mut engine = Engine::new(model_with_udf_measure());
        let hash0 = engine.udfs.identity_hash();
        let version0 = engine.query_cache.lock().model_version();

        engine.register_udf(double_udf(), 1).unwrap();
        let hash1 = engine.udfs.identity_hash();
        assert_ne!(hash0, hash1, "registering a UDF must change the identity");
        assert!(
            engine.query_cache.lock().model_version() > version0,
            "registration must invalidate the query cache"
        );

        // Re-registering with a bumped version changes the identity again —
        // and with it every query-cache key.
        engine.register_udf(double_udf(), 2).unwrap();
        let hash2 = engine.udfs.identity_hash();
        assert_ne!(hash1, hash2);

        let request = QueryRequest {
            measures: vec!["Doubled".into()],
            ..Default::default()
        };
        assert_ne!(
            crate::query_cache::query_cache_key(&request, 0, hash1, None),
            crate::query_cache::query_cache_key(&request, 0, hash2, None),
            "query-cache key must change when the UDF version changes"
        );
    }

    // --- Concurrency and cancellation ---

    /// Engine over one in-memory table (`Products`, served from the cache —
    /// no connector registered) with `TotalPrice = SUM(Products[price])`.
    /// Prices: 9.99 + 19.99 + 29.99 = 59.97.
    fn make_concurrent_engine() -> Engine {
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("price", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_measure(sum_measure("TotalPrice", "Products", "price"))
            .build()
            .unwrap();

        let mut engine = Engine::new(model);
        // Bind so the planner accepts the table; the in-memory cache serves
        // the data, so the (nonexistent) connector is never contacted.
        engine.bind_table("Products", 0, SourceBinding::new("public", "products"));
        engine.cache.store("Products", make_test_batch()).unwrap();
        engine
    }

    fn total_price_request() -> QueryRequest {
        QueryRequest {
            measures: vec!["TotalPrice".into()],
            ..Default::default()
        }
    }

    /// Extract the single scalar result of a `TotalPrice` query.
    fn scalar_total(batches: &[arrow::record_batch::RecordBatch]) -> f64 {
        batches[0]
            .column(0)
            .as_any()
            .downcast_ref::<Float64Array>()
            .expect("TotalPrice is Float64")
            .value(0)
    }

    #[test]
    fn engine_is_send_and_sync() {
        // Compile-time assertion: `query(&self)` is only useful across tasks
        // if the engine can be shared (`Arc<Engine>`) between threads.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Engine>();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_queries_through_shared_engine() {
        let engine = Arc::new(make_concurrent_engine());

        let first = tokio::spawn({
            let engine = Arc::clone(&engine);
            async move { engine.query(total_price_request()).await }
        });
        let second = tokio::spawn({
            let engine = Arc::clone(&engine);
            async move { engine.query(total_price_request()).await }
        });

        let first = first.await.unwrap().unwrap();
        let second = second.await.unwrap().unwrap();
        assert!((scalar_total(&first) - 59.97).abs() < 1e-9);
        assert!((scalar_total(&second) - 59.97).abs() < 1e-9);
    }

    #[tokio::test]
    async fn pre_cancelled_token_returns_cancelled_without_executing() {
        let engine = make_concurrent_engine();

        let token = CancellationToken::new();
        token.cancel();
        let err = engine
            .query_with_cancellation(total_price_request(), token)
            .await
            .unwrap_err();

        // The in-memory model would produce a successful result if execution
        // had proceeded (and no connector exists to fetch from), so a
        // `Cancelled` error proves the query stopped before doing any work.
        assert!(matches!(err, QueryError::Cancelled), "got: {err:?}");
    }

    #[tokio::test]
    async fn query_with_cancellation_uncancelled_token_completes() {
        let engine = make_concurrent_engine();

        let batches = engine
            .query_with_cancellation(total_price_request(), CancellationToken::new())
            .await
            .unwrap();
        assert!((scalar_total(&batches) - 59.97).abs() < 1e-9);
    }

    // --- Model script function integration (effective registry) ---

    use crate::{ScriptFunction, ScriptSandboxConfig, ScriptType};
    use arrow::datatypes::{Field, Schema as ArrowSchema};
    use arrow::record_batch::RecordBatch;

    /// `markup(cost, rate) -> Float` returning `cost * rate`.
    fn markup_script() -> ScriptFunction {
        ScriptFunction::builder("markup")
            .param("cost", ScriptType::Float)
            .param("rate", ScriptType::Float)
            .returns(ScriptType::Float)
            .body("cost * rate")
            .build()
    }

    /// In-memory `Sales(cost, rate, region)` with a measure
    /// `MarkupTotal = SUM(markup(Sales[cost], Sales[rate]))` and the script
    /// `markup` registered in the model.
    fn make_script_engine() -> Engine {
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("cost", DataType::Float64),
                        Column::new("rate", DataType::Float64),
                        Column::new("region", DataType::String),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_script_function(markup_script())
            .add_measure(Measure::new(
                "MarkupTotal",
                parse_measure("SUM(markup(Sales[cost], Sales[rate]))").unwrap(),
            ))
            .build()
            .unwrap();

        let mut engine = Engine::new(model);
        engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
        engine.cache.store("Sales", sales_markup_batch()).unwrap();
        engine
    }

    /// cost = [10, 20, 5], rate = [1.5, 2.0, 3.0], region = [a, a, b].
    /// markup = [15, 40, 15]; total = 70; by region a=55, b=15.
    fn sales_markup_batch() -> RecordBatch {
        let schema = Arc::new(ArrowSchema::new(vec![
            Field::new("cost", ArrowDataType::Float64, true),
            Field::new("rate", ArrowDataType::Float64, true),
            Field::new("region", ArrowDataType::Utf8, true),
        ]));
        RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Float64Array::from(vec![10.0, 20.0, 5.0])),
                Arc::new(Float64Array::from(vec![1.5, 2.0, 3.0])),
                Arc::new(arrow::array::StringArray::from(vec!["a", "a", "b"])),
            ],
        )
        .unwrap()
    }

    #[tokio::test]
    async fn model_script_measure_grand_total() {
        let engine = make_script_engine();
        let batches = engine
            .query(QueryRequest {
                measures: vec!["MarkupTotal".into()],
                ..Default::default()
            })
            .await
            .unwrap();
        let total = batches[0]
            .column(0)
            .as_any()
            .downcast_ref::<Float64Array>()
            .expect("MarkupTotal is Float64")
            .value(0);
        assert!((total - 70.0).abs() < 1e-9, "got {total}");
    }

    #[tokio::test]
    async fn model_script_measure_grouped() {
        let engine = make_script_engine();
        let batches = engine
            .query(QueryRequest {
                measures: vec!["MarkupTotal".into()],
                group_by: vec![crate::ColumnRef::new("Sales", "region")],
                ..Default::default()
            })
            .await
            .unwrap();
        // Two groups (a, b). Sum the measure column to verify totals
        // independent of row order; also check each value is present.
        let batch = &batches[0];
        let measure_idx = batch.num_columns() - 1;
        let vals = batch
            .column(measure_idx)
            .as_any()
            .downcast_ref::<Float64Array>()
            .expect("measure column Float64");
        let mut got: Vec<f64> = (0..vals.len()).map(|i| vals.value(i)).collect();
        got.sort_by(|x, y| x.partial_cmp(y).unwrap());
        assert_eq!(got.len(), 2);
        assert!((got[0] - 15.0).abs() < 1e-9, "region b = 15");
        assert!((got[1] - 55.0).abs() < 1e-9, "region a = 55");
    }

    #[test]
    fn model_script_appears_in_effective_registry_not_native() {
        let engine = make_script_engine();
        // The script is in the effective registry but is NOT a native UDF.
        assert!(engine.registered_udfs().is_empty());
        assert!(engine.effective_udfs.get("markup").is_some());
        assert!(engine.validate_scripts().is_ok());
    }

    #[tokio::test]
    async fn call_to_unknown_script_errors_unknown_function() {
        // Model references `mystery(...)` which is neither a built-in, a
        // native UDF, nor a model script → UnknownFunction at query time.
        let model = DataModel::builder()
            .add_table(
                Table::new("Sales", vec![Column::new("cost", DataType::Float64)])
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory),
            )
            .add_measure(Measure::new(
                "Mystery",
                parse_measure("SUM(mystery(Sales[cost]))").unwrap(),
            ))
            .build()
            .unwrap();
        let engine = Engine::new(model);
        let err = engine
            .query(QueryRequest {
                measures: vec!["Mystery".into()],
                ..Default::default()
            })
            .await
            .unwrap_err();
        match err {
            QueryError::Engine(EngineError::UnknownFunction { name, .. }) => {
                assert_eq!(name, "mystery");
            }
            other => panic!("expected UnknownFunction, got {other:?}"),
        }
    }

    #[test]
    fn editing_script_body_changes_cache_key_via_identity_hash() {
        let engine = make_script_engine();
        let hash_before = engine.effective_udfs.identity_hash();

        // Same model but with an edited script body.
        let edited = ScriptFunction::builder("markup")
            .param("cost", ScriptType::Float)
            .param("rate", ScriptType::Float)
            .returns(ScriptType::Float)
            .body("cost * rate * 1.1")
            .build();
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("cost", DataType::Float64),
                        Column::new("rate", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_script_function(edited)
            .add_measure(Measure::new(
                "MarkupTotal",
                parse_measure("SUM(markup(Sales[cost], Sales[rate]))").unwrap(),
            ))
            .build()
            .unwrap();
        let mut engine2 = engine;
        engine2.set_model(model).unwrap();
        let hash_after = engine2.effective_udfs.identity_hash();
        assert_ne!(
            hash_before, hash_after,
            "editing a script body must change the registry identity hash"
        );

        // And therefore the query-cache key for the same request.
        let request = QueryRequest {
            measures: vec!["MarkupTotal".into()],
            ..Default::default()
        };
        assert_ne!(
            crate::query_cache::query_cache_key(&request, 0, hash_before, None),
            crate::query_cache::query_cache_key(&request, 0, hash_after, None),
        );
    }

    #[test]
    fn script_colliding_with_native_udf_name_is_rejected_at_rebuild() {
        // Register a native UDF `markup`, then set a model whose script is
        // also named `markup` → the effective-registry rebuild reports the
        // collision (surfaced from set_model).
        let plain_model = DataModel::builder()
            .add_table(Table::new("Sales", vec![Column::new("cost", DataType::Float64)]).unwrap())
            .build()
            .unwrap();
        let mut engine = Engine::new(plain_model);

        let native_markup = create_udf(
            "markup",
            vec![ArrowDataType::Float64],
            ArrowDataType::Float64,
            Volatility::Immutable,
            Arc::new(|args: &[ColumnarValue]| {
                let arrays = ColumnarValue::values_to_arrays(args)?;
                Ok(ColumnarValue::Array(arrays[0].clone()))
            }),
        );
        engine.register_udf(native_markup, 1).unwrap();

        let script_model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("cost", DataType::Float64),
                        Column::new("rate", DataType::Float64),
                    ],
                )
                .unwrap(),
            )
            .add_script_function(markup_script())
            .build()
            .unwrap();

        let err = engine.set_model(script_model).unwrap_err();
        match err {
            EngineError::ScriptError {
                function, message, ..
            } => {
                assert_eq!(function, "markup");
                assert!(message.contains("native UDF"), "got: {message}");
            }
            other => panic!("expected ScriptError, got {other:?}"),
        }
        // The deferred error also surfaces from validate_scripts.
        assert!(engine.validate_scripts().is_err());
    }

    #[tokio::test]
    async fn script_op_budget_abort_surfaces_as_script_error_not_hang() {
        // A model script with an infinite loop, queried with a tiny op
        // budget — must abort with ScriptError, not hang.
        let model = DataModel::builder()
            .add_table(
                Table::new("Sales", vec![Column::new("cost", DataType::Float64)])
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory),
            )
            .add_script_function(
                ScriptFunction::builder("spin")
                    .param("x", ScriptType::Float)
                    .returns(ScriptType::Float)
                    .body("loop {}")
                    .build(),
            )
            .add_measure(Measure::new(
                "Spun",
                parse_measure("SUM(spin(Sales[cost]))").unwrap(),
            ))
            .build()
            .unwrap();

        let mut engine = Engine::new(model);
        engine
            .set_script_sandbox_config(ScriptSandboxConfig {
                max_operations: 5_000,
                ..ScriptSandboxConfig::default()
            })
            .unwrap();
        engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
        let schema = Arc::new(ArrowSchema::new(vec![Field::new(
            "cost",
            ArrowDataType::Float64,
            true,
        )]));
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(Float64Array::from(vec![1.0, 2.0]))])
                .unwrap();
        engine.cache.store("Sales", batch).unwrap();

        let err = engine
            .query(QueryRequest {
                measures: vec!["Spun".into()],
                ..Default::default()
            })
            .await
            .unwrap_err();
        // The query boundary re-maps the sandbox abort into a typed
        // ScriptError naming the offending function (proves it aborted, not
        // hung, and that hosts get a clear error rather than an opaque
        // DataFusion message).
        match err {
            crate::QueryError::Engine(EngineError::ScriptError {
                function, message, ..
            }) => {
                assert_eq!(function, "spin");
                assert!(
                    message.contains("operation") || message.contains("Number of operations"),
                    "expected an op-budget message, got: {message}"
                );
            }
            other => panic!("expected QueryError::Engine(ScriptError), got: {other:?}"),
        }
    }

    #[test]
    fn set_script_sandbox_config_recompiles_and_is_host_policy() {
        let mut engine = make_script_engine();
        // Default config is conservative.
        assert_eq!(
            engine.script_sandbox_config().max_operations,
            ScriptSandboxConfig::default().max_operations
        );
        // Tightening the budget recompiles scripts (no error for a benign
        // body) and the new policy is observable.
        engine
            .set_script_sandbox_config(ScriptSandboxConfig {
                max_operations: 42,
                ..ScriptSandboxConfig::default()
            })
            .unwrap();
        assert_eq!(engine.script_sandbox_config().max_operations, 42);
    }
}
