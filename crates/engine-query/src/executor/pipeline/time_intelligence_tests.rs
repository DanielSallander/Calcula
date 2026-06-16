//! End-to-end pipeline tests for time-intelligence measures (YTD/QTD/MTD/
//! PRIORYEAR/PRIORPERIOD) over a small in-memory star schema: a 2-year
//! monthly fact table joined to a marked date table.
//!
//! These tests exercise the full route: parse → plan (forced local) →
//! window-measure detection → time-intelligence lowering → two-stage window
//! execution — with exact value assertions.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, Date32Array, Float64Array, Int32Array, Int64Array, StringArray};
use arrow::compute::concat_batches;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use engine_connectors::{FilterCondition, FilterOperator};
use engine_core::compute::expression::{self as expr, ComparisonOp, Expression, FilterPredicate};
use engine_core::compute::measure::{expression_measure, Measure};
use engine_core::compute::parser::parse_measure_expression;
use engine_core::error::EngineError;
use engine_core::model::column::Column;
use engine_core::model::context::{ContextDefinition, ContextOp};
use engine_core::model::table::{StorageMode, Table};
use engine_core::model::{
    DataModel, DateRole, Hierarchy, HierarchyLevel, RaggedBehavior, Relationship,
};
use engine_core::store::InMemoryCache;
use engine_core::types::DataType as EngineDataType;

use super::QueryExecutor;
use crate::error::{QueryError, QueryResult};
use crate::planner::PushdownPlanner;
use crate::registry::{SourceBinding, SourceRegistry};
use crate::request::{ColumnRef, HierarchyGroupBy, QueryRequest, TotalsMode, GROUPING_ID_COLUMN};

/// Build the model: `fact_sales(date_id, region, amount)` →
/// `dim_date(date_id, year, quarter, month)` with `dim_date` marked as the
/// date table. `measure_source` is parsed as the single measure `m`.
///
/// `mark` controls whether the date table is marked (the missing-prereq
/// tests leave it unmarked).
fn model_with_measure(measure_source: &str, mark: bool) -> DataModel {
    let dim_date = Table::new(
        "dim_date",
        vec![
            Column::new("date_id", EngineDataType::Int64),
            // Real calendar key (first of each month) for the filter-context path.
            Column::new("datekey", EngineDataType::Date).with_date_role(DateRole::DateKey),
            Column::new("year", EngineDataType::Int64).with_date_role(DateRole::Year),
            Column::new("quarter", EngineDataType::Int64).with_date_role(DateRole::Quarter),
            Column::new("month", EngineDataType::Int64).with_date_role(DateRole::Month),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);

    let fact = Table::new(
        "fact_sales",
        vec![
            Column::new("date_id", EngineDataType::Int64),
            Column::new("region", EngineDataType::String),
            Column::new("amount", EngineDataType::Float64),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);

    let mut builder = DataModel::builder()
        .add_table(dim_date)
        .add_table(fact)
        .add_relationship(Relationship::many_to_one(
            "sales_date",
            "fact_sales",
            "date_id",
            "dim_date",
            "date_id",
        ))
        .add_measure(expression_measure(
            "m",
            parse_measure_expression(measure_source).unwrap(),
        ));
    if mark {
        builder = builder.mark_date_table("dim_date");
    }
    builder.build().unwrap()
}

/// Options for the flexible fixture builder.
#[derive(Default)]
struct FixtureOpts {
    /// Named context definitions to register (so USING(...) resolves).
    contexts: Vec<ContextDefinition>,
    /// Add an `is_holiday` boolean column (no DateRole) to `dim_date`.
    with_is_holiday: bool,
    /// Storage mode for the date table (defaults to InMemory).
    date_storage: Option<StorageMode>,
}

/// Build the fixture model from a pre-built measure expression, allowing extra
/// named contexts, an extra non-DateRole date-table column, and a date-table
/// storage-mode override. The date table is always marked.
fn model_with_measure_expr(measure: Measure, opts: &FixtureOpts) -> DataModel {
    let mut dim_cols = vec![
        Column::new("date_id", EngineDataType::Int64),
        Column::new("datekey", EngineDataType::Date).with_date_role(DateRole::DateKey),
        Column::new("year", EngineDataType::Int64).with_date_role(DateRole::Year),
        Column::new("quarter", EngineDataType::Int64).with_date_role(DateRole::Quarter),
        Column::new("month", EngineDataType::Int64).with_date_role(DateRole::Month),
    ];
    if opts.with_is_holiday {
        // No DateRole: a plain dimension attribute on the date table.
        dim_cols.push(Column::new("is_holiday", EngineDataType::Boolean));
    }
    let dim_date = Table::new("dim_date", dim_cols)
        .unwrap()
        .with_storage_mode(opts.date_storage.clone().unwrap_or(StorageMode::InMemory));

    let fact = Table::new(
        "fact_sales",
        vec![
            Column::new("date_id", EngineDataType::Int64),
            Column::new("region", EngineDataType::String),
            Column::new("amount", EngineDataType::Float64),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);

    let mut builder = DataModel::builder()
        .add_table(dim_date)
        .add_table(fact)
        .add_relationship(Relationship::many_to_one(
            "sales_date",
            "fact_sales",
            "date_id",
            "dim_date",
            "date_id",
        ))
        .add_measure(measure)
        .mark_date_table("dim_date");
    for ctx in &opts.contexts {
        builder = builder.add_context(ctx.clone());
    }
    builder.build().unwrap()
}

/// `dim_date` batch including an `is_holiday` column. Mirrors `dim_date_batch`
/// but adds a boolean flag (March of each year flagged as a holiday month).
fn dim_date_batch_with_holiday() -> RecordBatch {
    use arrow::array::BooleanArray;
    let mut date_id = Vec::new();
    let mut datekey = Vec::new();
    let mut year = Vec::new();
    let mut quarter = Vec::new();
    let mut month = Vec::new();
    let mut is_holiday = Vec::new();
    for y in [2023i64, 2024] {
        for m in 1i64..=12 {
            date_id.push(y * 100 + m);
            datekey.push(first_of_month_days(y, m));
            year.push(y);
            quarter.push((m - 1) / 3 + 1);
            month.push(m);
            is_holiday.push(m == 3);
        }
    }
    let schema = Arc::new(Schema::new(vec![
        Field::new("date_id", DataType::Int64, true),
        Field::new("datekey", DataType::Date32, true),
        Field::new("year", DataType::Int64, true),
        Field::new("quarter", DataType::Int64, true),
        Field::new("month", DataType::Int64, true),
        Field::new("is_holiday", DataType::Boolean, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(date_id)),
            Arc::new(Date32Array::from(datekey)),
            Arc::new(Int64Array::from(year)),
            Arc::new(Int64Array::from(quarter)),
            Arc::new(Int64Array::from(month)),
            Arc::new(BooleanArray::from(is_holiday)),
        ],
    )
    .unwrap()
}

/// Plan + execute against a fully prepared model + role filters + an explicit
/// `dim_date` batch (so fixtures with extra columns supply their own).
async fn run_model(
    model: &DataModel,
    dim_batch: RecordBatch,
    role_filters: &[FilterPredicate],
    request: QueryRequest,
) -> QueryResult<Vec<RecordBatch>> {
    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim_batch).unwrap();
    cache.store("fact_sales", fact_batch()).unwrap();

    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));

    let plan = PushdownPlanner::plan(request_ref(&request), model, &registry, role_filters)?;
    QueryExecutor::execute(
        &plan,
        model,
        &registry,
        Some(&cache),
        None,
        None,
        role_filters,
    )
    .await
}

/// Helper to borrow a request (keeps `run_model` call sites tidy).
fn request_ref(r: &QueryRequest) -> &QueryRequest {
    r
}

/// SUM(fact_sales[amount]) as an expression.
fn sum_amount() -> Expression {
    expr::agg(
        engine_core::compute::aggregate::AggregateOp::Sum,
        expr::qualified_col("fact_sales", "amount"),
    )
}

/// Days since the Unix epoch (1970-01-01) for `y-m-d` (Arrow `Date32`), via
/// Howard Hinnant's `days_from_civil` algorithm (no chrono dependency).
fn days_from_civil(y: i64, m: i64, d: i64) -> i32 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    (era * 146097 + doe - 719468) as i32
}

/// Days since the Unix epoch for the first day of `y-m` (Arrow `Date32`).
fn first_of_month_days(y: i64, m: i64) -> i32 {
    days_from_civil(y, m, 1)
}

/// 24 monthly dim rows (2023-01 .. 2024-12); `date_id = year * 100 + month`,
/// and `datekey` = the first day of each month (a real `Date32` calendar key).
fn dim_date_batch() -> RecordBatch {
    let mut date_id = Vec::new();
    let mut datekey = Vec::new();
    let mut year = Vec::new();
    let mut quarter = Vec::new();
    let mut month = Vec::new();
    for y in [2023i64, 2024] {
        for m in 1i64..=12 {
            date_id.push(y * 100 + m);
            datekey.push(first_of_month_days(y, m));
            year.push(y);
            quarter.push((m - 1) / 3 + 1);
            month.push(m);
        }
    }
    let schema = Arc::new(Schema::new(vec![
        Field::new("date_id", DataType::Int64, true),
        Field::new("datekey", DataType::Date32, true),
        Field::new("year", DataType::Int64, true),
        Field::new("quarter", DataType::Int64, true),
        Field::new("month", DataType::Int64, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(date_id)),
            Arc::new(Date32Array::from(datekey)),
            Arc::new(Int64Array::from(year)),
            Arc::new(Int64Array::from(quarter)),
            Arc::new(Int64Array::from(month)),
        ],
    )
    .unwrap()
}

/// One fact row per month per region. Per-month amounts:
/// - east: 2023 month m → `10 * m`; 2024 month m → `m`.
/// - west: double the east amount.
fn fact_batch() -> RecordBatch {
    let mut date_id = Vec::new();
    let mut region = Vec::new();
    let mut amount = Vec::new();
    for y in [2023i64, 2024] {
        for m in 1i64..=12 {
            let east = if y == 2023 { (10 * m) as f64 } else { m as f64 };
            for (r, a) in [("east", east), ("west", east * 2.0)] {
                date_id.push(y * 100 + m);
                region.push(r);
                amount.push(a);
            }
        }
    }
    let schema = Arc::new(Schema::new(vec![
        Field::new("date_id", DataType::Int64, true),
        Field::new("region", DataType::Utf8, true),
        Field::new("amount", DataType::Float64, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(date_id)),
            Arc::new(StringArray::from(region)),
            Arc::new(Float64Array::from(amount)),
        ],
    )
    .unwrap()
}

/// Plan + execute a request against the in-memory fixture.
async fn run(
    measure_source: &str,
    mark: bool,
    request: QueryRequest,
) -> QueryResult<Vec<RecordBatch>> {
    let model = model_with_measure(measure_source, mark);

    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim_date_batch()).unwrap();
    cache.store("fact_sales", fact_batch()).unwrap();

    // Bind tables so the planner accepts them; the in-memory cache serves
    // the data, so no connector is ever contacted.
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));

    let plan = PushdownPlanner::plan(&request, &model, &registry, &[])?;
    QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[]).await
}

fn request(group_by: &[(&str, &str)]) -> QueryRequest {
    QueryRequest {
        measures: vec!["m".into()],
        group_by: group_by
            .iter()
            .map(|(t, c)| ColumnRef::new(*t, *c))
            .collect(),
        ..Default::default()
    }
}

/// A request with `group_by` and `(column, op, value)` filter conditions.
fn request_with_filters(
    group_by: &[(&str, &str)],
    filters: &[(&str, FilterOperator, &str)],
) -> QueryRequest {
    QueryRequest {
        measures: vec!["m".into()],
        group_by: group_by
            .iter()
            .map(|(t, c)| ColumnRef::new(*t, *c))
            .collect(),
        filters: filters
            .iter()
            .map(|(col, op, val)| FilterCondition::new(*col, *op, *val))
            .collect(),
        ..Default::default()
    }
}

/// Read the single measure value from a one-row result (no group_by).
fn scalar_measure(batches: &[RecordBatch]) -> Option<f64> {
    let combined = concat_batches(&batches[0].schema(), batches).unwrap();
    assert_eq!(combined.num_rows(), 1, "expected exactly one result row");
    measure_column(&combined, "m")[0]
}

/// Read an Int64 key column (tolerating any castable numeric type).
fn int_column(batch: &RecordBatch, name: &str) -> Vec<i64> {
    let idx = batch.schema().index_of(name).unwrap();
    let cast = arrow::compute::cast(batch.column(idx), &DataType::Int64).unwrap();
    let arr = cast.as_any().downcast_ref::<Int64Array>().unwrap();
    (0..arr.len()).map(|i| arr.value(i)).collect()
}

/// Read the measure column as Option<f64> (NULL-aware).
fn measure_column(batch: &RecordBatch, name: &str) -> Vec<Option<f64>> {
    let idx = batch.schema().index_of(name).unwrap();
    let cast = arrow::compute::cast(batch.column(idx), &DataType::Float64).unwrap();
    let arr = cast.as_any().downcast_ref::<Float64Array>().unwrap();
    (0..arr.len())
        .map(|i| (!arr.is_null(i)).then(|| arr.value(i)))
        .collect()
}

/// Collect `(year, month) -> measure` from result batches.
fn by_year_month(batches: &[RecordBatch]) -> HashMap<(i64, i64), Option<f64>> {
    let combined = concat_batches(&batches[0].schema(), batches).unwrap();
    let years = int_column(&combined, "year");
    let months = int_column(&combined, "month");
    let values = measure_column(&combined, "m");
    years
        .into_iter()
        .zip(months)
        .zip(values)
        .map(|((y, m), v)| ((y, m), v))
        .collect()
}

#[tokio::test]
async fn ytd_running_total_resets_at_year_boundary() {
    let batches = run(
        "YTD(SUM(fact_sales[amount]))",
        true,
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .unwrap();

    let result = by_year_month(&batches);
    assert_eq!(result.len(), 24, "one row per (year, month)");
    for m in 1i64..=12 {
        // Both regions summed per month: east + west = 3 × east amount.
        // 2023 east = 10m → monthly total 30m → YTD = 30 * m(m+1)/2.
        let expected_2023 = 30.0 * (m * (m + 1) / 2) as f64;
        assert_eq!(result[&(2023, m)], Some(expected_2023), "YTD(2023, {m})");
        // 2024 east = m → monthly total 3m → YTD = 3 * m(m+1)/2.
        // January 2024 = 3.0 proves the reset (not 2340 + 3).
        let expected_2024 = 3.0 * (m * (m + 1) / 2) as f64;
        assert_eq!(result[&(2024, m)], Some(expected_2024), "YTD(2024, {m})");
    }
}

#[tokio::test]
async fn ytd_partitions_by_non_date_dimension() {
    let batches = run(
        "YTD(SUM(fact_sales[amount]))",
        true,
        request(&[
            ("dim_date", "year"),
            ("dim_date", "month"),
            ("fact_sales", "region"),
        ]),
    )
    .await
    .unwrap();

    let combined = concat_batches(&batches[0].schema(), batches.as_slice()).unwrap();
    let years = int_column(&combined, "year");
    let months = int_column(&combined, "month");
    let values = measure_column(&combined, "m");
    let regions = {
        let idx = combined.schema().index_of("region").unwrap();
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        (0..arr.len())
            .map(|i| arr.value(i).to_string())
            .collect::<Vec<_>>()
    };

    let mut result: HashMap<(i64, i64, String), Option<f64>> = HashMap::new();
    for i in 0..years.len() {
        result.insert((years[i], months[i], regions[i].clone()), values[i]);
    }
    assert_eq!(result.len(), 48, "one row per (year, month, region)");

    // Region partitions the running total: east 2023 YTD = 10 * m(m+1)/2,
    // west exactly double — never mixed.
    for m in 1i64..=12 {
        let east = 10.0 * (m * (m + 1) / 2) as f64;
        assert_eq!(result[&(2023, m, "east".into())], Some(east));
        assert_eq!(result[&(2023, m, "west".into())], Some(east * 2.0));
    }
}

#[tokio::test]
async fn qtd_resets_at_quarter_boundary() {
    let batches = run(
        "QTD(SUM(fact_sales[amount]))",
        true,
        request(&[
            ("dim_date", "year"),
            ("dim_date", "quarter"),
            ("dim_date", "month"),
        ]),
    )
    .await
    .unwrap();

    let result = by_year_month(&batches);
    assert_eq!(result.len(), 24);
    for m in 1i64..=12 {
        // Months of the current quarter up to m: quarter starts at q0 = 3*((m-1)/3)+1.
        let q0 = 3 * ((m - 1) / 3) + 1;
        // 2023 monthly total = 30m → QTD = 30 * (q0 + … + m).
        let expected: f64 = 30.0 * (q0..=m).sum::<i64>() as f64;
        assert_eq!(result[&(2023, m)], Some(expected), "QTD(2023, {m})");
    }
    // April starts Q2: QTD(2023-04) = 30*4 = 120, not Q1's 180 + 120.
    assert_eq!(result[&(2023, 4)], Some(120.0));
}

#[tokio::test]
async fn prioryear_returns_prior_year_value_with_null_first_year() {
    let batches = run(
        "PRIORYEAR(SUM(fact_sales[amount]))",
        true,
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .unwrap();

    let result = by_year_month(&batches);
    assert_eq!(result.len(), 24);
    for m in 1i64..=12 {
        // First year on the axis has no prior year → NULL/blank.
        assert_eq!(result[&(2023, m)], None, "PRIORYEAR(2023, {m})");
        // 2024 (monthly total 3m) reads 2023's value for the SAME month: 30m.
        assert_eq!(
            result[&(2024, m)],
            Some(30.0 * m as f64),
            "PRIORYEAR(2024, {m})"
        );
    }
}

#[tokio::test]
async fn priorperiod_shifts_quarters_across_year_boundary() {
    let batches = run(
        "PRIORPERIOD(SUM(fact_sales[amount]), -1, QUARTER)",
        true,
        request(&[("dim_date", "year"), ("dim_date", "quarter")]),
    )
    .await
    .unwrap();

    let combined = concat_batches(&batches[0].schema(), batches.as_slice()).unwrap();
    let years = int_column(&combined, "year");
    let quarters = int_column(&combined, "quarter");
    let values = measure_column(&combined, "m");
    let mut result: HashMap<(i64, i64), Option<f64>> = HashMap::new();
    for i in 0..years.len() {
        result.insert((years[i], quarters[i]), values[i]);
    }
    assert_eq!(result.len(), 8, "one row per (year, quarter)");

    // Quarterly totals: 2023 Qq = 30 * (sum of months in q); months sums:
    // Q1: 1+2+3=6, Q2: 15, Q3: 24, Q4: 33.
    let q2023 = |q: i64| 30.0 * [6.0, 15.0, 24.0, 33.0][(q - 1) as usize];
    let q2024 = |q: i64| 3.0 * [6.0, 15.0, 24.0, 33.0][(q - 1) as usize];

    assert_eq!(result[&(2023, 1)], None, "nothing before 2023 Q1");
    assert_eq!(result[&(2023, 2)], Some(q2023(1)));
    // Year boundary: 2024 Q1's prior period is 2023 Q4.
    assert_eq!(result[&(2024, 1)], Some(q2023(4)));
    assert_eq!(result[&(2024, 2)], Some(q2024(1)));
}

#[tokio::test]
async fn ytd_without_date_table_is_a_typed_actionable_error() {
    let err = run(
        "YTD(SUM(fact_sales[amount]))",
        false, // date table NOT marked
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .unwrap_err();

    let QueryError::Engine(EngineError::TimeIntelligence { function, reason }) = &err else {
        panic!("expected typed TimeIntelligence error, got {err:?}");
    };
    assert_eq!(function, "YTD");
    assert!(reason.contains("mark_date_table"), "got: {reason}");
}

#[tokio::test]
async fn ytd_without_finer_date_column_is_a_typed_error() {
    let err = run(
        "YTD(SUM(fact_sales[amount]))",
        true,
        request(&[("dim_date", "year")]),
    )
    .await
    .unwrap_err();

    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected typed TimeIntelligence error, got {err:?}");
    };
    assert!(reason.contains("finer than Year"), "got: {reason}");
}

#[tokio::test]
async fn ytd_missing_year_axis_is_a_typed_error() {
    let err = run(
        "YTD(SUM(fact_sales[amount]))",
        true,
        request(&[("dim_date", "month")]),
    )
    .await
    .unwrap_err();

    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected typed TimeIntelligence error, got {err:?}");
    };
    assert!(
        reason.contains("Year column 'dim_date[year]'"),
        "got: {reason}"
    );
}

#[tokio::test]
async fn ytd_with_rollup_totals_is_rejected() {
    let mut req = request(&[("dim_date", "year"), ("dim_date", "month")]);
    req.totals = TotalsMode::Rollup;

    let err = run("YTD(SUM(fact_sales[amount]))", true, req)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("window measures"),
        "time intelligence rides the window totals gate; got: {err}"
    );
}

// ===========================================================================
// Filter-context time intelligence: date columns NOT on the query axis.
// ===========================================================================

#[tokio::test]
async fn filter_context_ytd_uses_max_date_in_context() {
    // No date column in group_by, but a date filter year=2024 & month<=6.
    // As-of = 2024-06; YTD(2024) over months 1..=6: monthly total 3m →
    // 3 * (1+2+3+4+5+6) = 63.
    let batches = run(
        "YTD(SUM(fact_sales[amount]))",
        true,
        request_with_filters(
            &[],
            &[
                ("year", FilterOperator::Equal, "2024"),
                ("month", FilterOperator::LessThanOrEqual, "6"),
            ],
        ),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&batches), Some(63.0));
}

#[tokio::test]
async fn filter_context_ytd_different_as_of_changes_value() {
    // Same measure, tighter context (month<=3): YTD = 3 * (1+2+3) = 18.
    let batches = run(
        "YTD(SUM(fact_sales[amount]))",
        true,
        request_with_filters(
            &[],
            &[
                ("year", FilterOperator::Equal, "2024"),
                ("month", FilterOperator::LessThanOrEqual, "3"),
            ],
        ),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&batches), Some(18.0));
}

#[tokio::test]
async fn filter_context_ytd_no_date_filter_uses_absolute_max() {
    // No date filter at all → as-of = absolute max date (2024-12).
    // YTD(2024) = whole 2024 = 3 * (1+..+12) = 3 * 78 = 234.
    let batches = run("YTD(SUM(fact_sales[amount]))", true, request(&[]))
        .await
        .unwrap();
    assert_eq!(scalar_measure(&batches), Some(234.0));
}

#[tokio::test]
async fn filter_context_prioryear_reads_prior_year() {
    // Context year=2024 → window = whole 2024; PRIORYEAR shifts back to 2023.
    // 2023 whole year = 30 * 78 = 2340.
    let batches = run(
        "PRIORYEAR(SUM(fact_sales[amount]))",
        true,
        request_with_filters(&[], &[("year", FilterOperator::Equal, "2024")]),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&batches), Some(2340.0));
}

#[tokio::test]
async fn filter_context_sameperiodlastyear_equals_prioryear() {
    // SAMEPERIODLASTYEAR must produce the same value as PRIORYEAR.
    let batches = run(
        "SAMEPERIODLASTYEAR(SUM(fact_sales[amount]))",
        true,
        request_with_filters(&[], &[("year", FilterOperator::Equal, "2024")]),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&batches), Some(2340.0));
}

#[tokio::test]
async fn filter_context_prioryear_first_year_is_blank() {
    // Context year=2023 → PRIORYEAR shifts to 2022, which has no data → blank.
    let batches = run(
        "PRIORYEAR(SUM(fact_sales[amount]))",
        true,
        request_with_filters(&[], &[("year", FilterOperator::Equal, "2023")]),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&batches), None, "no prior-year data → NULL");
}

#[tokio::test]
async fn filter_context_prioryear_gapped_context_fails_closed() {
    // Context = year=2024 EXCEPT June (month <> 6): an internal hole in the
    // window [Jan, Dec] 2024. A whole-window PRIORYEAR shift would span the hole
    // and silently include June 2023 (an over-count). It must fail closed — the
    // same guarantee the axis path gives via `check_period_shift_axis_contiguous`.
    let err = run(
        "PRIORYEAR(SUM(fact_sales[amount]))",
        true,
        request_with_filters(
            &[],
            &[
                ("year", FilterOperator::Equal, "2024"),
                ("month", FilterOperator::NotEqual, "6"),
            ],
        ),
    )
    .await
    .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected a typed TimeIntelligence error for a gapped context, got {err:?}");
    };
    assert!(reason.contains("not contiguous"), "got: {reason}");
}

#[tokio::test]
async fn filter_context_prioryear_partial_contiguous_context_is_exact() {
    // A PARTIAL but CONTIGUOUS context (year=2024, month<=6 → Jan..Jun) must
    // pass the contiguity guard and shift the whole window back one year:
    // PRIORYEAR = Jan..Jun 2023 over both regions = (east 10*(1..6)=210) +
    // (west = double = 420) = 630.
    let batches = run(
        "PRIORYEAR(SUM(fact_sales[amount]))",
        true,
        request_with_filters(
            &[],
            &[
                ("year", FilterOperator::Equal, "2024"),
                ("month", FilterOperator::LessThanOrEqual, "6"),
            ],
        ),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&batches), Some(630.0));
}

#[tokio::test]
async fn filter_context_ytd_composes_with_non_date_dimension() {
    // Per-region YTD with date range applied. Context year=2024, month<=6.
    // east months 1..6 = 1+2+3+4+5+6 = 21; west = double = 42.
    let batches = run(
        "YTD(SUM(fact_sales[amount]))",
        true,
        request_with_filters(
            &[("fact_sales", "region")],
            &[
                ("year", FilterOperator::Equal, "2024"),
                ("month", FilterOperator::LessThanOrEqual, "6"),
            ],
        ),
    )
    .await
    .unwrap();

    let combined = concat_batches(&batches[0].schema(), batches.as_slice()).unwrap();
    let values = measure_column(&combined, "m");
    let regions = {
        let idx = combined.schema().index_of("region").unwrap();
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        (0..arr.len())
            .map(|i| arr.value(i).to_string())
            .collect::<Vec<_>>()
    };
    let mut by_region: HashMap<String, Option<f64>> = HashMap::new();
    for i in 0..regions.len() {
        by_region.insert(regions[i].clone(), values[i]);
    }
    assert_eq!(by_region.len(), 2, "one row per region");
    assert_eq!(by_region["east"], Some(21.0));
    assert_eq!(by_region["west"], Some(42.0));
}

#[tokio::test]
async fn filter_context_average_inner_is_computed_over_the_range() {
    // In FILTER-CONTEXT mode YTD lowers to a single evaluation over the date
    // range, so AVERAGE is exact (unlike the AXIS path, which rejects it).
    // Context year=2024, month<=6 → YTD range = Jan..Jun 2024. east amounts
    // 1..6 → average 21/6 = 3.5; west is double → 42/6 = 7.0.
    let batches = run(
        "YTD(AVERAGE(fact_sales[amount]))",
        true,
        request_with_filters(
            &[("fact_sales", "region")],
            &[
                ("year", FilterOperator::Equal, "2024"),
                ("month", FilterOperator::LessThanOrEqual, "6"),
            ],
        ),
    )
    .await
    .unwrap();

    let combined = concat_batches(&batches[0].schema(), batches.as_slice()).unwrap();
    let values = measure_column(&combined, "m");
    let regions = {
        let idx = combined.schema().index_of("region").unwrap();
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        (0..arr.len())
            .map(|i| arr.value(i).to_string())
            .collect::<Vec<_>>()
    };
    let mut by_region: HashMap<String, Option<f64>> = HashMap::new();
    for i in 0..regions.len() {
        by_region.insert(regions[i].clone(), values[i]);
    }
    assert_eq!(by_region["east"], Some(3.5));
    assert_eq!(by_region["west"], Some(7.0));
}

#[tokio::test]
async fn filter_context_without_date_table_is_rejected() {
    // Date table not marked → typed actionable error even off the axis.
    let err = run(
        "YTD(SUM(fact_sales[amount]))",
        false,
        request(&[("fact_sales", "region")]),
    )
    .await
    .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected typed TimeIntelligence error, got {err:?}");
    };
    assert!(reason.contains("mark_date_table"), "got: {reason}");
}

// ===========================================================================
// Fix A: filter-context TI wrapped in a context op must FAIL CLOSED (not
// return a wrong number by dropping the context).
// ===========================================================================

/// `KEEP(YTD(SUM(amount)), region='east')` with no date on the axis must be a
/// typed error — the filter-context path cannot re-apply the region filter.
#[tokio::test]
async fn fix_a_filter_context_outer_keep_on_non_date_table_fails_closed() {
    let ti = expr::to_date(
        sum_amount(),
        engine_core::compute::expression::DateGranularity::Year,
    );
    let wrapped = expr::keep(
        ti,
        vec![FilterPredicate::new(
            "fact_sales",
            "region",
            ComparisonOp::Equal,
            "east",
        )],
    );
    let model = model_with_measure_expr(expression_measure("m", wrapped), &FixtureOpts::default());
    let err = run_model(&model, dim_date_batch(), &[], request(&[]))
        .await
        .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected typed TimeIntelligence error, got {err:?}");
    };
    assert!(
        reason.contains("does not compose with KEEP/USING/CLEAR/RESET"),
        "got: {reason}"
    );
}

/// An INNER KEEP — `YTD(SUM(KEEP(amount, region='east')))` lowered via a KEEP
/// inside the aggregate — also fails closed in the filter-context path.
#[tokio::test]
async fn fix_a_filter_context_inner_keep_fails_closed() {
    // SUM(KEEP(fact_sales[amount], region='east')) then YTD(...).
    let inner = expr::agg(
        engine_core::compute::aggregate::AggregateOp::Sum,
        expr::keep(
            expr::qualified_col("fact_sales", "amount"),
            vec![FilterPredicate::new(
                "fact_sales",
                "region",
                ComparisonOp::Equal,
                "east",
            )],
        ),
    );
    let ti = expr::to_date(
        inner,
        engine_core::compute::expression::DateGranularity::Year,
    );
    let model = model_with_measure_expr(expression_measure("m", ti), &FixtureOpts::default());
    let err = run_model(&model, dim_date_batch(), &[], request(&[]))
        .await
        .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected typed TimeIntelligence error, got {err:?}");
    };
    assert!(
        reason.contains("does not compose with KEEP/USING/CLEAR/RESET"),
        "got: {reason}"
    );
}

/// A USING(named context) that adds a non-date filter also fails closed.
#[tokio::test]
async fn fix_a_filter_context_using_fails_closed() {
    let ti = expr::to_date(
        sum_amount(),
        engine_core::compute::expression::DateGranularity::Year,
    );
    let wrapped = expr::using(ti, "ctx_east");
    let ctx = ContextDefinition::new(
        "ctx_east",
        vec![ContextOp::Keep(vec![FilterPredicate::new(
            "fact_sales",
            "region",
            ComparisonOp::Equal,
            "east",
        )])],
    );
    let opts = FixtureOpts {
        contexts: vec![ctx],
        ..Default::default()
    };
    let model = model_with_measure_expr(expression_measure("m", wrapped), &opts);
    let err = run_model(&model, dim_date_batch(), &[], request(&[]))
        .await
        .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected typed TimeIntelligence error, got {err:?}");
    };
    assert!(
        reason.contains("does not compose with KEEP/USING/CLEAR/RESET"),
        "got: {reason}"
    );
}

/// The AXIS path (date on group_by) is UNAFFECTED by the Fix A guard: a TI node
/// wrapped in a KEEP still routes through the window/axis lowering and succeeds
/// (it does NOT raise the filter-context "does not compose" error). The axis
/// path's running-total semantics are unchanged from before this fix — it does
/// not raise, and it returns one running-total row per (year, month).
#[tokio::test]
async fn fix_a_axis_path_with_keep_does_not_raise_fix_a_error() {
    let ti = expr::to_date(
        sum_amount(),
        engine_core::compute::expression::DateGranularity::Year,
    );
    let wrapped = expr::keep(
        ti,
        vec![FilterPredicate::new(
            "fact_sales",
            "region",
            ComparisonOp::Equal,
            "east",
        )],
    );
    let model = model_with_measure_expr(expression_measure("m", wrapped), &FixtureOpts::default());
    // The axis path (year+month on group_by) must NOT hit the filter-context
    // fail-closed guard — it composes along the axis exactly as before.
    let batches = run_model(
        &model,
        dim_date_batch(),
        &[],
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .expect("axis path must not raise the Fix A filter-context error");

    // Running total accumulates monotonically within each year (unchanged axis
    // semantics); the exact values are the v1 running-total contract.
    let result = by_year_month(&batches);
    assert_eq!(result.len(), 24, "one running-total row per (year, month)");
    // January 2024 resets the running total (proves the axis window ran).
    assert!(
        result[&(2024, 1)].unwrap() < result[&(2024, 12)].unwrap(),
        "running total grows within the year on the axis path"
    );
}

/// Item 7 regression: the KEEP filter wrapping an AXIS-mode window measure is
/// actually applied to the running total — previously it was silently dropped,
/// so `KEEP(YTD(SUM(amount)), region='east')` returned the all-region total.
#[tokio::test]
async fn axis_keep_filter_restricts_window_to_filtered_rows() {
    let ti = expr::to_date(
        sum_amount(),
        engine_core::compute::expression::DateGranularity::Year,
    );
    let wrapped = expr::keep(
        ti,
        vec![FilterPredicate::new(
            "fact_sales",
            "region",
            ComparisonOp::Equal,
            "east",
        )],
    );
    let model = model_with_measure_expr(expression_measure("m", wrapped), &FixtureOpts::default());
    let batches = run_model(
        &model,
        dim_date_batch(),
        &[],
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .unwrap();

    let result = by_year_month(&batches);
    // Fixture east amounts: 2023 month m → 10m; 2024 month m → m. YTD is a
    // running sum that resets each year, so the December value is the full-year
    // east total: 2023 → 10 * (1+…+12) = 780; 2024 → (1+…+12) = 78. These are
    // the EAST-ONLY totals — the all-region totals (east + west = 3×east) would
    // be 2340 and 234, which is what the dropped-KEEP bug produced.
    assert_eq!(
        result[&(2023, 12)],
        Some(780.0),
        "Dec 2023 YTD must be east-only (780), not all-region (2340)"
    );
    assert_eq!(
        result[&(2024, 12)],
        Some(78.0),
        "Dec 2024 YTD must be east-only (78), not all-region (234)"
    );
}

/// A window measure wrapped in context the axis path cannot apply (here a
/// CLEAR) fails closed rather than silently dropping it.
#[tokio::test]
async fn axis_window_with_unapplyable_context_fails_closed() {
    // YTD(SUM(amount)) wrapped in a RESET — the axis path cannot represent a
    // context reset on the stage-1 aggregate, so it must refuse.
    let ti = expr::to_date(
        sum_amount(),
        engine_core::compute::expression::DateGranularity::Year,
    );
    let wrapped = expr::reset(ti);
    let model = model_with_measure_expr(expression_measure("m", wrapped), &FixtureOpts::default());
    let err = run_model(
        &model,
        dim_date_batch(),
        &[],
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("cannot apply"), "got: {msg}");
}

/// A July-start fiscal calendar: the `year` role column rolls over in July, so
/// it diverges from the DateKey's Gregorian year. The filter-context path
/// (date not on the axis) computes calendar windows, which would disagree with
/// the axis path's role-column reset — so it must fail closed rather than return
/// a silently calendar-based (wrong-for-fiscal) window.
fn fiscal_dim_date_batch() -> RecordBatch {
    let mut date_id = Vec::new();
    let mut datekey = Vec::new();
    let mut year = Vec::new();
    let mut quarter = Vec::new();
    let mut month = Vec::new();
    for y in [2023i64, 2024] {
        for m in 1i64..=12 {
            date_id.push(y * 100 + m);
            datekey.push(first_of_month_days(y, m));
            // Fiscal year rolls over in July → July..Dec belong to next FY.
            year.push(if m >= 7 { y + 1 } else { y });
            quarter.push((m - 1) / 3 + 1);
            month.push(m);
        }
    }
    let schema = Arc::new(Schema::new(vec![
        Field::new("date_id", DataType::Int64, true),
        Field::new("datekey", DataType::Date32, true),
        Field::new("year", DataType::Int64, true),
        Field::new("quarter", DataType::Int64, true),
        Field::new("month", DataType::Int64, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(date_id)),
            Arc::new(Date32Array::from(datekey)),
            Arc::new(Int64Array::from(year)),
            Arc::new(Int64Array::from(quarter)),
            Arc::new(Int64Array::from(month)),
        ],
    )
    .unwrap()
}

#[tokio::test]
async fn filter_context_fiscal_ytd_uses_role_columns() {
    // Fiscal calendar (FY rolls over in July). YTD reads the period start from the
    // YEAR role column, not the Gregorian date key: as-of = Dec 2024 (fiscal year
    // 2025), so fiscal YTD spans Jul..Dec 2024 = 3*(7+8+9+10+11+12) = 171 — NOT
    // the calendar-year 234.
    let model = model_with_measure("YTD(SUM(fact_sales[amount]))", true);
    // request(&[]) → no date column on the axis → filter-context path.
    let batches = run_model(&model, fiscal_dim_date_batch(), &[], request(&[]))
        .await
        .unwrap();
    assert_eq!(scalar_measure(&batches), Some(171.0));
}

#[tokio::test]
async fn filter_context_fiscal_closingbalance_works() {
    // CLOSINGBALANCE pins to the last context day (Dec 2024) — a boundary day, so
    // it is calendar-agnostic and works on a fiscal calendar. east 12 + west 24 = 36.
    let model = model_with_measure("CLOSINGBALANCE(SUM(fact_sales[amount]))", true);
    let batches = run_model(&model, fiscal_dim_date_batch(), &[], request(&[]))
        .await
        .unwrap();
    assert_eq!(scalar_measure(&batches), Some(36.0));
}

#[tokio::test]
async fn filter_context_fiscal_prioryear_fails_closed() {
    // A period shift over a fiscal calendar needs fiscal-period arithmetic and is
    // not supported — fail closed rather than apply Gregorian-month math.
    let model = model_with_measure("PRIORYEAR(SUM(fact_sales[amount]))", true);
    let err = run_model(&model, fiscal_dim_date_batch(), &[], request(&[]))
        .await
        .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected a typed TimeIntelligence error for a fiscal period shift, got {err:?}");
    };
    assert!(
        reason.contains("fiscal") && reason.contains("period shift"),
        "got: {reason}"
    );
}

// ===========================================================================
// Fix B + RLS: non-DateRole date-table filters and role predicates on the date
// table survive the unfiltered-registration (only DateRole filters are dropped).
// ===========================================================================

/// A request filter on a non-DateRole date-table column (`is_holiday`) is
/// respected: filter-context YTD over only holiday months, not all months.
#[tokio::test]
async fn fix_b_non_date_role_filter_on_date_table_is_respected() {
    // is_holiday = true keeps only March of each year (datekey months == 3).
    // No date filter → as-of = absolute max date present AFTER the holiday
    // filter = 2024-03. YTD(2024) range = [2024-01-01, 2024-03-31]; but the
    // registered date table is restricted to March only, so the fact join only
    // sees March 2024. 2024 March monthly total = 3 * 3 = 9.
    let model = model_with_measure_expr(
        expression_measure(
            "m",
            expr::to_date(
                sum_amount(),
                engine_core::compute::expression::DateGranularity::Year,
            ),
        ),
        &FixtureOpts {
            with_is_holiday: true,
            ..Default::default()
        },
    );
    let req = request_with_filters(&[], &[("is_holiday", FilterOperator::Equal, "true")]);
    let batches = run_model(&model, dim_date_batch_with_holiday(), &[], req)
        .await
        .unwrap();
    // Only March 2024 survives: 2024 east March = 3, west = 6 → total 9.
    assert_eq!(scalar_measure(&batches), Some(9.0));
}

/// A SecurityRole predicate ON THE DATE TABLE restricts a filter-context TI
/// query — it is NOT silently dropped by the unfiltered registration
/// (fail-open closed). Role: `is_holiday = true` on dim_date.
#[tokio::test]
async fn fix_b_role_predicate_on_date_table_restricts_filter_context_ti() {
    let model = model_with_measure_expr(
        expression_measure(
            "m",
            expr::to_date(
                sum_amount(),
                engine_core::compute::expression::DateGranularity::Year,
            ),
        ),
        &FixtureOpts {
            with_is_holiday: true,
            ..Default::default()
        },
    );
    // Active role restricts dim_date to holiday months only.
    let role = vec![FilterPredicate::new(
        "dim_date",
        "is_holiday",
        ComparisonOp::Equal,
        "true",
    )];
    let batches = run_model(&model, dim_date_batch_with_holiday(), &role, request(&[]))
        .await
        .unwrap();
    // With the role enforced, only March rows survive → as-of = 2024-03,
    // YTD restricted to March → 2024 March total = 9 (NOT the full-year 234).
    let v = scalar_measure(&batches);
    assert_eq!(
        v,
        Some(9.0),
        "role on the date table must restrict; got {v:?}"
    );
    assert_ne!(v, Some(234.0), "role must NOT be bypassed (full year)");
}

// ===========================================================================
// Fix C: filter-context TI requires the date table in-memory; a DirectQuery
// (non-cached) date table fails closed instead of returning a wrong/blank value.
// ===========================================================================

#[tokio::test]
async fn fix_c_direct_query_date_table_fails_closed() {
    let model = model_with_measure_expr(
        expression_measure(
            "m",
            expr::to_date(
                sum_amount(),
                engine_core::compute::expression::DateGranularity::Year,
            ),
        ),
        &FixtureOpts {
            date_storage: Some(StorageMode::DirectQuery),
            ..Default::default()
        },
    );
    // No cache entry for a DirectQuery date table → planner must refuse.
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = request(&[]);
    let err = PushdownPlanner::plan(&req, &model, &registry, &[]).unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected typed TimeIntelligence error, got {err:?}");
    };
    assert!(
        reason.contains("requires the date table") && reason.contains("in-memory"),
        "got: {reason}"
    );
}

#[tokio::test]
async fn prioryear_with_gapped_year_axis_fails_closed() {
    // A fact whose year axis is 2023 and 2025 — 2024 is missing entirely. The
    // axis-mode period shift is a positional LAG over the years *present*, so a
    // bare LAG(1) would read 2023 as the "prior year" of 2025, which is wrong:
    // 2024 has no data, so the true prior-year value is blank. The engine must
    // fail closed (a typed TimeIntelligence error) rather than return the
    // nearest-present-year value as if it were the prior year.
    let model = model_with_measure("PRIORYEAR(SUM(fact_sales[amount]))", true);

    let dim = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("datekey", DataType::Date32, true),
            Field::new("year", DataType::Int64, true),
            Field::new("quarter", DataType::Int64, true),
            Field::new("month", DataType::Int64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![202301i64, 202501])),
            Arc::new(Date32Array::from(vec![
                first_of_month_days(2023, 1),
                first_of_month_days(2025, 1),
            ])),
            // 2023 and 2025 — note the 2024 gap.
            Arc::new(Int64Array::from(vec![2023i64, 2025])),
            Arc::new(Int64Array::from(vec![1i64, 1])),
            Arc::new(Int64Array::from(vec![1i64, 1])),
        ],
    )
    .unwrap();
    let fact = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("region", DataType::Utf8, true),
            Field::new("amount", DataType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![202301i64, 202501])),
            Arc::new(StringArray::from(vec!["east", "east"])),
            Arc::new(Float64Array::from(vec![100.0, 200.0])),
        ],
    )
    .unwrap();

    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim).unwrap();
    cache.store("fact_sales", fact).unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));

    let req = request(&[("dim_date", "year")]);
    let plan = PushdownPlanner::plan(&req, &model, &registry, &[]).unwrap();
    let err = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected typed TimeIntelligence error for a gapped axis, got {err:?}");
    };
    assert!(reason.contains("gap"), "got: {reason}");
}

/// Build a model with several named measures (each parsed from source) over the
/// standard star fixture. The date table is marked when `mark` is true.
fn model_with_measures(measures: &[(&str, &str)], mark: bool) -> DataModel {
    let dim_date = Table::new(
        "dim_date",
        vec![
            Column::new("date_id", EngineDataType::Int64),
            Column::new("datekey", EngineDataType::Date).with_date_role(DateRole::DateKey),
            Column::new("year", EngineDataType::Int64).with_date_role(DateRole::Year),
            Column::new("quarter", EngineDataType::Int64).with_date_role(DateRole::Quarter),
            Column::new("month", EngineDataType::Int64).with_date_role(DateRole::Month),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);
    let fact = Table::new(
        "fact_sales",
        vec![
            Column::new("date_id", EngineDataType::Int64),
            Column::new("region", EngineDataType::String),
            Column::new("amount", EngineDataType::Float64),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);
    let mut builder = DataModel::builder()
        .add_table(dim_date)
        .add_table(fact)
        .add_relationship(Relationship::many_to_one(
            "sales_date",
            "fact_sales",
            "date_id",
            "dim_date",
            "date_id",
        ));
    for (name, src) in measures {
        builder = builder.add_measure(expression_measure(
            *name,
            parse_measure_expression(src).unwrap(),
        ));
    }
    if mark {
        builder = builder.mark_date_table("dim_date");
    }
    builder.build().unwrap()
}

/// Plan + execute a request naming arbitrary measures over the standard fixture.
async fn run_measures(
    model: &DataModel,
    measure_names: &[&str],
    group_by: &[(&str, &str)],
) -> QueryResult<Vec<RecordBatch>> {
    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim_date_batch()).unwrap();
    cache.store("fact_sales", fact_batch()).unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = QueryRequest {
        measures: measure_names.iter().map(|s| s.to_string()).collect(),
        group_by: group_by
            .iter()
            .map(|(t, c)| ColumnRef::new(*t, *c))
            .collect(),
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, model, &registry, &[])?;
    QueryExecutor::execute(&plan, model, &registry, Some(&cache), None, None, &[]).await
}

#[tokio::test]
async fn two_window_measures_join_on_the_axis() {
    // Two window measures sharing the (year, month) axis are joined into one
    // [year, month, ytd, py] table — not returned as disjoint blocks.
    let model = model_with_measures(
        &[
            ("ytd", "YTD(SUM(fact_sales[amount]))"),
            ("py", "PRIORYEAR(SUM(fact_sales[amount]))"),
        ],
        true,
    );
    let batches = run_measures(
        &model,
        &["ytd", "py"],
        &[("dim_date", "year"), ("dim_date", "month")],
    )
    .await
    .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

    assert_eq!(combined.num_rows(), 24, "one joined row per (year, month)");
    assert!(
        combined.schema().index_of("ytd").is_ok(),
        "ytd column present"
    );
    assert!(
        combined.schema().index_of("py").is_ok(),
        "py column present"
    );

    let years = int_column(&combined, "year");
    let months = int_column(&combined, "month");
    let ytd = measure_column(&combined, "ytd");
    let py = measure_column(&combined, "py");
    let mut ytd_map = HashMap::new();
    let mut py_map = HashMap::new();
    for i in 0..combined.num_rows() {
        ytd_map.insert((years[i], months[i]), ytd[i]);
        py_map.insert((years[i], months[i]), py[i]);
    }
    // 2024 monthly total = 3m (east m + west 2m). YTD(Dec) = 3*(1+…+12) = 234.
    assert_eq!(ytd_map[&(2024, 12)], Some(234.0));
    // PRIORYEAR(2024, Dec) = 2023 Dec total = 30*12 = 360.
    assert_eq!(py_map[&(2024, 12)], Some(360.0));
    // 2023 has no prior year → py is NULL.
    assert_eq!(py_map[&(2023, 6)], None);
}

#[tokio::test]
async fn three_window_measures_join_on_the_axis() {
    // Three measures → the third join exercises the COALESCE-of-prior-groups ON
    // clause. All share the (year, month) axis.
    let model = model_with_measures(
        &[
            ("ytd", "YTD(SUM(fact_sales[amount]))"),
            ("py", "PRIORYEAR(SUM(fact_sales[amount]))"),
            (
                "run",
                "WINDOW(SUM(fact_sales[amount]), SUM, ORDERBY(dim_date[month]), PARTITIONBY(dim_date[year]))",
            ),
        ],
        true,
    );
    let batches = run_measures(
        &model,
        &["ytd", "py", "run"],
        &[("dim_date", "year"), ("dim_date", "month")],
    )
    .await
    .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    assert_eq!(combined.num_rows(), 24);
    for c in ["ytd", "py", "run"] {
        assert!(combined.schema().index_of(c).is_ok(), "{c} column present");
    }
    let years = int_column(&combined, "year");
    let months = int_column(&combined, "month");
    let run = measure_column(&combined, "run");
    let mut run_map = HashMap::new();
    for i in 0..combined.num_rows() {
        run_map.insert((years[i], months[i]), run[i]);
    }
    // Running SUM within 2024 to December = 3*(1+…+12) = 234.
    assert_eq!(run_map[&(2024, 12)], Some(234.0));
}

#[tokio::test]
async fn window_measures_not_uniquely_keyed_fail_closed() {
    // Both measures' running axis (month) is finer than the group-by (year
    // only), so the projected result is NOT uniquely keyed by year — joining
    // them would multiply rows. Fail closed instead.
    let model = model_with_measures(
        &[
            (
                "a",
                "WINDOW(SUM(fact_sales[amount]), SUM, ORDERBY(dim_date[month]))",
            ),
            (
                "b",
                "WINDOW(SUM(fact_sales[amount]), SUM, ORDERBY(dim_date[month]))",
            ),
        ],
        true,
    );
    let err = run_measures(&model, &["a", "b"], &[("dim_date", "year")])
        .await
        .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("uniquely keyed"), "got: {msg}");
}

// ===========================================================================
// Compound time intelligence: arithmetic over time-intelligence terms
// (YoY = YTD - PRIORYEAR, YoY% = DIVIDE(YTD - PRIORYEAR, PRIORYEAR)).
// ===========================================================================

#[tokio::test]
async fn compound_yoy_delta_subtracts_prior_year() {
    let batches = run(
        "YTD(SUM(fact_sales[amount])) - PRIORYEAR(SUM(fact_sales[amount]))",
        true,
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .unwrap();
    let result = by_year_month(&batches);
    assert_eq!(result.len(), 24, "one row per (year, month)");
    // 2024: monthly total = 3m. YTD(Dec) = 3*78 = 234. PRIORYEAR(Dec) = 2023
    // Dec monthly total = 360. Delta = 234 - 360 = -126.
    assert_eq!(result[&(2024, 12)], Some(-126.0));
    // 2023 has no prior year → PRIORYEAR is NULL → the delta is NULL.
    assert_eq!(result[&(2023, 6)], None);
}

#[tokio::test]
async fn compound_yoy_percent_uses_safe_divide() {
    let batches = run(
        "DIVIDE(YTD(SUM(fact_sales[amount])) - PRIORYEAR(SUM(fact_sales[amount])), \
         PRIORYEAR(SUM(fact_sales[amount])))",
        true,
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .unwrap();
    let result = by_year_month(&batches);
    // (234 - 360) / 360 = -0.35.
    let v = result[&(2024, 12)].expect("2024 Dec value");
    assert!((v - (-0.35)).abs() < 1e-9, "expected -0.35, got {v}");
}

#[tokio::test]
async fn compound_ti_with_bare_aggregate_fails_closed() {
    // The second term is a bare aggregate, not a time-intelligence term — it
    // cannot be evaluated over the joined leaf columns. Fail closed.
    let err = run(
        "YTD(SUM(fact_sales[amount])) - SUM(fact_sales[amount])",
        true,
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("unsupported sub-expression"), "got: {msg}");
}

#[tokio::test]
async fn compound_ti_wrapped_in_keep_fails_closed() {
    // An outer KEEP around the whole compound is not yet distributed into the
    // leaves, so it must fail closed rather than be silently ignored.
    let ytd = expr::to_date(
        sum_amount(),
        engine_core::compute::expression::DateGranularity::Year,
    );
    let py = expr::period_shift(
        sum_amount(),
        -1,
        engine_core::compute::expression::DateGranularity::Year,
    );
    let wrapped = expr::keep(
        ytd.subtract(py),
        vec![FilterPredicate::new(
            "fact_sales",
            "region",
            ComparisonOp::Equal,
            "east",
        )],
    );
    let model = model_with_measure_expr(expression_measure("m", wrapped), &FixtureOpts::default());
    let err = run_model(
        &model,
        dim_date_batch(),
        &[],
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("cannot yet be wrapped"), "got: {msg}");
}

#[tokio::test]
async fn window_measure_combines_with_normal_measure_on_the_axis() {
    // A window/TI measure (YTD) sits beside a plain aggregate (total) in one
    // request: the two are computed on separate paths and FULL OUTER JOINed on
    // the (year, month) axis into a single [year, month, ytd, total] table.
    // 2024 month m: monthly total = 3m; YTD = 3 * m(m+1)/2.
    let model = model_with_measures(
        &[
            ("ytd", "YTD(SUM(fact_sales[amount]))"),
            ("total", "SUM(fact_sales[amount])"),
        ],
        true,
    );
    let batches = run_measures(
        &model,
        &["ytd", "total"],
        &[("dim_date", "year"), ("dim_date", "month")],
    )
    .await
    .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    assert_eq!(combined.num_rows(), 24, "one joined row per (year, month)");
    assert!(combined.schema().index_of("ytd").is_ok());
    assert!(combined.schema().index_of("total").is_ok());

    let years = int_column(&combined, "year");
    let months = int_column(&combined, "month");
    let ytd = measure_column(&combined, "ytd");
    let total = measure_column(&combined, "total");
    let mut ytd_map = HashMap::new();
    let mut total_map = HashMap::new();
    for i in 0..combined.num_rows() {
        ytd_map.insert((years[i], months[i]), ytd[i]);
        total_map.insert((years[i], months[i]), total[i]);
    }
    // 2024 December: ytd = 3*78 = 234; plain total = 3*12 = 36.
    assert_eq!(ytd_map[&(2024, 12)], Some(234.0));
    assert_eq!(total_map[&(2024, 12)], Some(36.0));
    // 2024 January: ytd = total = 3.
    assert_eq!(ytd_map[&(2024, 1)], Some(3.0));
    assert_eq!(total_map[&(2024, 1)], Some(3.0));
}

/// Read a (possibly dictionary-encoded) string column as plain `String`s.
fn string_column(batch: &RecordBatch, name: &str) -> Vec<String> {
    let idx = batch.schema().index_of(name).unwrap();
    let cast = arrow::compute::cast(batch.column(idx), &DataType::Utf8).unwrap();
    let arr = cast.as_any().downcast_ref::<StringArray>().unwrap();
    (0..arr.len()).map(|i| arr.value(i).to_string()).collect()
}

#[tokio::test]
async fn rank_measure_ranks_groups_by_aggregate_descending() {
    // Per-region total amount: east = 858, west = 1716 (west is double east).
    // RANK / ROW_NUMBER order DESCENDING (largest = rank 1) → west 1, east 2.
    let model = model_with_measures(
        &[
            ("rnk", "RANK(ORDERBY(fact_sales[amount]))"),
            ("rn", "ROW_NUMBER(ORDERBY(fact_sales[amount]))"),
        ],
        true,
    );
    let batches = run_measures(&model, &["rnk", "rn"], &[("fact_sales", "region")])
        .await
        .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    let regions = string_column(&combined, "region");
    let rnk = measure_column(&combined, "rnk");
    let rn = measure_column(&combined, "rn");
    let mut rank_by: HashMap<String, Option<f64>> = HashMap::new();
    let mut rn_by: HashMap<String, Option<f64>> = HashMap::new();
    for i in 0..combined.num_rows() {
        rank_by.insert(regions[i].clone(), rnk[i]);
        rn_by.insert(regions[i].clone(), rn[i]);
    }
    assert_eq!(rank_by["west"], Some(1.0), "west ranks 1 (highest total)");
    assert_eq!(rank_by["east"], Some(2.0), "east ranks 2");
    assert_eq!(rn_by["west"], Some(1.0));
    assert_eq!(rn_by["east"], Some(2.0));
}

#[tokio::test]
async fn rank_vs_dense_rank_tie_handling() {
    // Three regions, two tied at 100: RANK gaps (1,1,3); DENSE_RANK doesn't (1,1,2).
    let model = model_with_measures(
        &[
            ("rnk", "RANK(ORDERBY(fact_sales[amount]))"),
            ("drnk", "DENSE_RANK(ORDERBY(fact_sales[amount]))"),
        ],
        true,
    );
    let fact = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("region", DataType::Utf8, true),
            Field::new("amount", DataType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![202401, 202401, 202401])),
            Arc::new(StringArray::from(vec!["a", "b", "c"])),
            Arc::new(Float64Array::from(vec![100.0, 100.0, 50.0])),
        ],
    )
    .unwrap();
    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim_date_batch()).unwrap();
    cache.store("fact_sales", fact).unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = QueryRequest {
        measures: vec!["rnk".into(), "drnk".into()],
        group_by: vec![ColumnRef::new("fact_sales", "region")],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    let regions = string_column(&combined, "region");
    let rnk = measure_column(&combined, "rnk");
    let drnk = measure_column(&combined, "drnk");
    let mut rk: HashMap<String, Option<f64>> = HashMap::new();
    let mut dr: HashMap<String, Option<f64>> = HashMap::new();
    for i in 0..combined.num_rows() {
        rk.insert(regions[i].clone(), rnk[i]);
        dr.insert(regions[i].clone(), drnk[i]);
    }
    assert_eq!(rk["a"], Some(1.0));
    assert_eq!(rk["b"], Some(1.0));
    assert_eq!(rk["c"], Some(3.0), "RANK skips to 3 after the tie");
    assert_eq!(dr["a"], Some(1.0));
    assert_eq!(dr["b"], Some(1.0));
    assert_eq!(dr["c"], Some(2.0), "DENSE_RANK does not skip");
}

#[tokio::test]
async fn rank_measure_null_order_key_ranks_last() {
    // A region with fact rows but an all-NULL amount aggregates to SUM = NULL.
    // It must rank LAST (DESC NULLS LAST), not first — a blank at rank 1 would be
    // a silently-wrong number contrary to RANKX semantics.
    let model = model_with_measures(&[("rnk", "RANK(ORDERBY(fact_sales[amount]))")], true);
    let fact = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("region", DataType::Utf8, true),
            Field::new("amount", DataType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![202401, 202401, 202401])),
            Arc::new(StringArray::from(vec!["east", "east", "nullreg"])),
            Arc::new(Float64Array::from(vec![Some(100.0), Some(200.0), None])),
        ],
    )
    .unwrap();
    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim_date_batch()).unwrap();
    cache.store("fact_sales", fact).unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = QueryRequest {
        measures: vec!["rnk".into()],
        group_by: vec![ColumnRef::new("fact_sales", "region")],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    let regions = string_column(&combined, "region");
    let rnk = measure_column(&combined, "rnk");
    let mut rk: HashMap<String, Option<f64>> = HashMap::new();
    for i in 0..combined.num_rows() {
        rk.insert(regions[i].clone(), rnk[i]);
    }
    assert_eq!(rk["east"], Some(1.0), "east (SUM 300) ranks 1");
    assert_eq!(rk["nullreg"], Some(2.0), "all-NULL amount ranks LAST, not first");
}

#[tokio::test]
async fn rank_measure_mixed_case_group_by_column_resolves() {
    // A MIXED-CASE group-by column must resolve: stage 2 now references the
    // original case stage 1 emits. Previously this hard-errored FieldNotFound.
    let fact = Table::new(
        "fact_sales",
        vec![
            Column::new("Region", EngineDataType::String),
            Column::new("amount", EngineDataType::Float64),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);
    let model = DataModel::builder()
        .add_table(fact)
        .add_measure(expression_measure(
            "rnk",
            parse_measure_expression("RANK(ORDERBY(fact_sales[amount]))").unwrap(),
        ))
        .build()
        .unwrap();
    let mut cache = InMemoryCache::new();
    cache
        .store(
            "fact_sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("Region", DataType::Utf8, true),
                    Field::new("amount", DataType::Float64, true),
                ])),
                vec![
                    Arc::new(StringArray::from(vec!["east", "east", "west"])),
                    Arc::new(Float64Array::from(vec![100.0, 200.0, 1000.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = QueryRequest {
        measures: vec!["rnk".into()],
        group_by: vec![ColumnRef::new("fact_sales", "Region")],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    assert!(
        combined.schema().index_of("Region").is_ok(),
        "the mixed-case dimension column is preserved in the result"
    );
    let regions = string_column(&combined, "Region");
    let rnk = measure_column(&combined, "rnk");
    let mut rk: HashMap<String, Option<f64>> = HashMap::new();
    for i in 0..combined.num_rows() {
        rk.insert(regions[i].clone(), rnk[i]);
    }
    assert_eq!(rk["west"], Some(1.0));
    assert_eq!(rk["east"], Some(2.0));
}

#[tokio::test]
async fn rank_measure_partitions_by_a_group_by_column() {
    // Rank regions WITHIN each year. Per (year, region): 2023 east=780/west=1560,
    // 2024 east=78/west=156 → within each year west=1, east=2.
    let model = model_with_measures(
        &[(
            "rnk",
            "RANK(ORDERBY(fact_sales[amount]), PARTITIONBY(dim_date[year]))",
        )],
        true,
    );
    let batches = run_measures(
        &model,
        &["rnk"],
        &[("dim_date", "year"), ("fact_sales", "region")],
    )
    .await
    .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    let years = int_column(&combined, "year");
    let regions = string_column(&combined, "region");
    let rnk = measure_column(&combined, "rnk");
    let mut by_cell: HashMap<(i64, String), Option<f64>> = HashMap::new();
    for i in 0..combined.num_rows() {
        by_cell.insert((years[i], regions[i].clone()), rnk[i]);
    }
    assert_eq!(by_cell[&(2023, "west".into())], Some(1.0));
    assert_eq!(by_cell[&(2023, "east".into())], Some(2.0));
    assert_eq!(by_cell[&(2024, "west".into())], Some(1.0));
    assert_eq!(by_cell[&(2024, "east".into())], Some(2.0));
}

#[tokio::test]
async fn rank_measure_combines_with_an_ordinary_measure() {
    // A RANK measure sits beside the plain Revenue it ranks by, in one query.
    let model = model_with_measures(
        &[
            ("rev", "SUM(fact_sales[amount])"),
            ("rnk", "RANK(ORDERBY(fact_sales[amount]))"),
        ],
        true,
    );
    let batches = run_measures(&model, &["rev", "rnk"], &[("fact_sales", "region")])
        .await
        .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    let regions = string_column(&combined, "region");
    let rev = measure_column(&combined, "rev");
    let rnk = measure_column(&combined, "rnk");
    let mut by: HashMap<String, (Option<f64>, Option<f64>)> = HashMap::new();
    for i in 0..combined.num_rows() {
        by.insert(regions[i].clone(), (rev[i], rnk[i]));
    }
    assert_eq!(by["west"], (Some(1716.0), Some(1.0)));
    assert_eq!(by["east"], (Some(858.0), Some(2.0)));
}

#[tokio::test]
async fn rank_measure_order_by_dimension_fails_closed() {
    // ORDER BY a DIMENSION attribute (dim_date[year]) resolves the measure's
    // fact to dim_date — a dimension, not a fact. Ranking by SUM(year) would be
    // nonsensical, so this fails closed rather than returning a wrong number.
    let model = model_with_measures(&[("rnk", "RANK(ORDERBY(dim_date[year]))")], true);
    let err = run_measures(&model, &["rnk"], &[("fact_sales", "region")])
        .await
        .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("is a dimension here"), "got: {msg}");
}

#[tokio::test]
async fn rank_measure_without_group_by_fails_closed() {
    // A ranking measure ranks the group-by rows; with no group_by axis there is
    // nothing to rank → typed error rather than a meaningless single row.
    let model = model_with_measures(&[("rnk", "RANK(ORDERBY(fact_sales[amount]))")], true);
    let err = run_measures(&model, &["rnk"], &[]).await.unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("group_by axis"), "got: {msg}");
}

#[tokio::test]
async fn rank_measure_partition_by_non_group_by_column_fails_closed() {
    let model = model_with_measures(
        &[(
            "rnk",
            "RANK(ORDERBY(fact_sales[amount]), PARTITIONBY(dim_date[year]))",
        )],
        true,
    );
    // year is not in the group_by → fail closed.
    let err = run_measures(&model, &["rnk"], &[("fact_sales", "region")])
        .await
        .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("PARTITION BY"), "got: {msg}");
}

#[tokio::test]
async fn window_plus_normal_null_dimension_group_does_not_split() {
    // A NULL group-by member must join to itself across the window and normal
    // sides (null-safe join key), not split into two half-blank rows.
    let model = model_with_measures(
        &[
            ("ytd", "YTD(SUM(fact_sales[amount]))"),
            ("total", "SUM(fact_sales[amount])"),
        ],
        true,
    );
    // 2024-01: a NULL-region fact (amount 5) and an east fact (amount 1).
    let fact = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("region", DataType::Utf8, true),
            Field::new("amount", DataType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![202401, 202401])),
            Arc::new(StringArray::from(vec![None, Some("east")])),
            Arc::new(Float64Array::from(vec![5.0, 1.0])),
        ],
    )
    .unwrap();
    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim_date_batch()).unwrap();
    cache.store("fact_sales", fact).unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = QueryRequest {
        measures: vec!["ytd".into(), "total".into()],
        group_by: vec![
            ColumnRef::new("dim_date", "year"),
            ColumnRef::new("dim_date", "month"),
            ColumnRef::new("fact_sales", "region"),
        ],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

    let region = combined.column(combined.schema().index_of("region").unwrap());
    let ytd = measure_column(&combined, "ytd");
    let total = measure_column(&combined, "total");
    let null_rows: Vec<usize> = (0..combined.num_rows())
        .filter(|&i| region.is_null(i))
        .collect();
    assert_eq!(
        null_rows.len(),
        1,
        "the NULL-region group must be ONE combined row, not split"
    );
    let r = null_rows[0];
    assert_eq!(ytd[r], Some(5.0), "NULL-region YTD present");
    assert_eq!(total[r], Some(5.0), "NULL-region total present on the same row");
}

// ===========================================================================
// DATESINPERIOD: trailing-window time intelligence (filter-context only).
// As-of date in the fixture = the max DateKey = 2024-12-01.
// ===========================================================================

#[tokio::test]
async fn dates_in_period_trailing_12_months_is_full_2024() {
    // Trailing 12 months ending 2024-12-01 = all of 2024. 2024 monthly total
    // = 3m (east m + west 2m); sum over 2024 = 3 * 78 = 234.
    let v = run(
        "DATESINPERIOD(SUM(fact_sales[amount]), -12, MONTH)",
        true,
        request(&[]),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&v), Some(234.0));
}

#[tokio::test]
async fn dates_in_period_trailing_one_year_equals_twelve_months() {
    let v = run(
        "DATESINPERIOD(SUM(fact_sales[amount]), -1, YEAR)",
        true,
        request(&[]),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&v), Some(234.0));
}

#[tokio::test]
async fn dates_in_period_trailing_3_months() {
    // Last 3 months ending 2024-12-01 = Oct, Nov, Dec = 3*(10+11+12) = 99.
    let v = run(
        "DATESINPERIOD(SUM(fact_sales[amount]), -3, MONTH)",
        true,
        request(&[]),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&v), Some(99.0));
}

// ===========================================================================
// CLOSINGBALANCE / OPENINGBALANCE: semi-additive balance pinned to a single
// boundary date of the context (filter-context only).
// ===========================================================================

#[tokio::test]
async fn closing_balance_pins_to_last_date_in_context() {
    // No date filter → context = the full calendar; last day = 2024-12-01.
    // CLOSINGBALANCE = the December-2024 value = 3*12 = 36 (NOT a sum over time).
    let v = run(
        "CLOSINGBALANCE(SUM(fact_sales[amount]))",
        true,
        request(&[]),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&v), Some(36.0));
}

#[tokio::test]
async fn opening_balance_pins_to_first_date_in_context() {
    // First day = 2023-01-01 → January-2023 value = 30*1 = 30.
    let v = run(
        "OPENINGBALANCE(SUM(fact_sales[amount]))",
        true,
        request(&[]),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&v), Some(30.0));
}

#[tokio::test]
async fn closing_balance_respects_the_date_filter() {
    // Restricted to 2023 → last day = 2023-12-01 → December-2023 = 30*12 = 360.
    let v = run(
        "CLOSINGBALANCE(SUM(fact_sales[amount]))",
        true,
        request_with_filters(&[], &[("year", FilterOperator::Equal, "2023")]),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&v), Some(360.0));
}

#[tokio::test]
async fn closing_balance_on_date_axis_fails_closed() {
    // A per-row balance over a date axis is the deferred LAST/FIRST primitive;
    // a date column on the axis must fail closed, never silently mis-compute.
    let err = run(
        "CLOSINGBALANCE(SUM(fact_sales[amount]))",
        true,
        request(&[("dim_date", "year"), ("dim_date", "month")]),
    )
    .await
    .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected typed TimeIntelligence error, got {err:?}");
    };
    assert!(reason.contains("axis"), "got: {reason}");
}

#[tokio::test]
async fn dates_in_period_composes_with_non_date_dimension() {
    // Trailing 12 months (all 2024) split by region: east = sum(m) = 78,
    // west = sum(2m) = 156.
    let batches = run(
        "DATESINPERIOD(SUM(fact_sales[amount]), -12, MONTH)",
        true,
        request(&[("fact_sales", "region")]),
    )
    .await
    .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    let region = combined
        .column(combined.schema().index_of("region").unwrap())
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let vals = measure_column(&combined, "m");
    let mut by_region = HashMap::new();
    for i in 0..combined.num_rows() {
        by_region.insert(region.value(i).to_string(), vals[i]);
    }
    assert_eq!(by_region["east"], Some(78.0));
    assert_eq!(by_region["west"], Some(156.0));
}

#[tokio::test]
async fn dates_in_period_on_axis_fails_closed() {
    let err = run(
        "DATESINPERIOD(SUM(fact_sales[amount]), -12, MONTH)",
        true,
        request(&[("dim_date", "month")]),
    )
    .await
    .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected TimeIntelligence error, got {err:?}");
    };
    assert!(
        reason.contains("not supported with a date column on the query axis"),
        "got: {reason}"
    );
}

#[tokio::test]
async fn parallelperiod_shifts_filter_context_window_back_one_month() {
    // Context filtered to June 2024 (single month). PARALLELPERIOD(-1, MONTH)
    // shifts the window back one month → May 2024 = 3 * 5 = 15.
    let v = run(
        "PARALLELPERIOD(SUM(fact_sales[amount]), -1, MONTH)",
        true,
        request_with_filters(
            &[],
            &[
                ("year", FilterOperator::Equal, "2024"),
                ("month", FilterOperator::Equal, "6"),
            ],
        ),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&v), Some(15.0));
}

#[tokio::test]
async fn parallelperiod_shifts_filter_context_window_back_one_quarter() {
    // Context filtered to Q2 2024 (months 4–6). PARALLELPERIOD(-1, QUARTER)
    // shifts the window back one quarter → Q1 2024 = 3 * (1+2+3) = 18.
    let v = run(
        "PARALLELPERIOD(SUM(fact_sales[amount]), -1, QUARTER)",
        true,
        request_with_filters(
            &[],
            &[
                ("year", FilterOperator::Equal, "2024"),
                ("quarter", FilterOperator::Equal, "2"),
            ],
        ),
    )
    .await
    .unwrap();
    assert_eq!(scalar_measure(&v), Some(18.0));
}

#[tokio::test]
async fn dates_in_period_positive_interval_fails_closed() {
    let err = run(
        "DATESINPERIOD(SUM(fact_sales[amount]), 12, MONTH)",
        true,
        request(&[]),
    )
    .await
    .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected TimeIntelligence error, got {err:?}");
    };
    assert!(reason.contains("negative interval"), "got: {reason}");
}

// ===========================================================================
// Totals (ROLLUP) × filter-context time intelligence (Phase 1).
//
// A filter-context TI measure (YTD/QTD/MTD, DATESINPERIOD, CLOSING/OPENING-
// BALANCE) lowers to an ordinary `Keep(Clear(inner),[range])` aggregate, so
// `GROUP BY ROLLUP` recomputes it correctly per level: each subtotal / grand
// total is the measure RE-EVALUATED over the rolled-up row set, never a sum of
// detail values. The result carries the trailing `__grouping_id` bitmask.
// ===========================================================================

/// Read a ROLLUP-by-region result into `(region, grouping_id) → value` for the
/// named measure. `region` is `None` for a rolled-up (subtotal / grand-total)
/// row; `grouping_id` is `0` for detail rows and `1` when `region` is rolled up.
fn rollup_region_map(
    batches: &[RecordBatch],
    measure: &str,
) -> HashMap<(Option<String>, i32), Option<f64>> {
    let combined = concat_batches(&batches[0].schema(), batches).unwrap();
    let region = combined
        .column(combined.schema().index_of("region").unwrap())
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap()
        .clone();
    let gid = {
        let idx = combined.schema().index_of(GROUPING_ID_COLUMN).unwrap();
        arrow::compute::cast(combined.column(idx), &DataType::Int32)
            .unwrap()
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap()
            .clone()
    };
    let vals = measure_column(&combined, measure);
    let mut map = HashMap::new();
    for i in 0..combined.num_rows() {
        let r = if region.is_null(i) {
            None
        } else {
            Some(region.value(i).to_string())
        };
        map.insert((r, gid.value(i)), vals[i]);
    }
    map
}

/// Plan + execute a multi-measure ROLLUP request with `(column, op, value)`
/// filters over the standard star fixture.
async fn run_measures_rollup(
    model: &DataModel,
    measure_names: &[&str],
    group_by: &[(&str, &str)],
    filters: &[(&str, FilterOperator, &str)],
) -> QueryResult<Vec<RecordBatch>> {
    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim_date_batch()).unwrap();
    cache.store("fact_sales", fact_batch()).unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = QueryRequest {
        measures: measure_names.iter().map(|s| s.to_string()).collect(),
        group_by: group_by
            .iter()
            .map(|(t, c)| ColumnRef::new(*t, *c))
            .collect(),
        filters: filters
            .iter()
            .map(|(c, op, v)| FilterCondition::new(*c, *op, *v))
            .collect(),
        totals: TotalsMode::Rollup,
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, model, &registry, &[])?;
    QueryExecutor::execute(&plan, model, &registry, Some(&cache), None, None, &[]).await
}

#[tokio::test]
async fn rollup_ytd_by_region_recomputes_grand_total() {
    // YTD(SUM(amount)) BY region WITH ROLLUP, context year=2024 (as-of Dec).
    // Per region = whole-2024 total: east 78, west 156. The rolled-up grand total
    // re-evaluates YTD over BOTH regions = 234 (gid=1), not a stale value.
    let mut req = request_with_filters(
        &[("fact_sales", "region")],
        &[("year", FilterOperator::Equal, "2024")],
    );
    req.totals = TotalsMode::Rollup;
    let batches = run("YTD(SUM(fact_sales[amount]))", true, req).await.unwrap();
    let map = rollup_region_map(&batches, "m");
    assert_eq!(map.len(), 3, "two region detail rows + one grand total");
    assert_eq!(map[&(Some("east".into()), 0)], Some(78.0));
    assert_eq!(map[&(Some("west".into()), 0)], Some(156.0));
    assert_eq!(map[&(None, 1)], Some(234.0));
}

#[tokio::test]
async fn rollup_qtd_beside_ordinary_measure() {
    // A filter-context TI measure composes with an ordinary measure under ROLLUP:
    // both sides roll up and the join carries one __grouping_id. Sales (ordinary)
    // over 2024 = 78/156/234; QTD as-of Dec = Q4 (Oct+Nov+Dec) = 33/66/99.
    let model = model_with_measures(
        &[
            ("Sales", "SUM(fact_sales[amount])"),
            ("QTD", "QTD(SUM(fact_sales[amount]))"),
        ],
        true,
    );
    let batches = run_measures_rollup(
        &model,
        &["Sales", "QTD"],
        &[("fact_sales", "region")],
        &[("year", FilterOperator::Equal, "2024")],
    )
    .await
    .unwrap();
    let sales = rollup_region_map(&batches, "Sales");
    let qtd = rollup_region_map(&batches, "QTD");
    assert_eq!(sales[&(Some("east".into()), 0)], Some(78.0));
    assert_eq!(sales[&(Some("west".into()), 0)], Some(156.0));
    assert_eq!(sales[&(None, 1)], Some(234.0));
    assert_eq!(qtd[&(Some("east".into()), 0)], Some(33.0));
    assert_eq!(qtd[&(Some("west".into()), 0)], Some(66.0));
    assert_eq!(qtd[&(None, 1)], Some(99.0));
}

#[tokio::test]
async fn rollup_ytd_distinctcount_recomputes_per_level() {
    // The cardinal-sin guard: a NON-ADDITIVE inner must be recomputed per level,
    // never summed. East customers {c1,c2}, West {c2,c3} (c2 shared). YTD over a
    // single in-context month → east=2, west=2, grand=3 (c1,c2,c3), NOT 2+2=4.
    let dim_date = Table::new(
        "dim_date",
        vec![
            Column::new("date_id", EngineDataType::Int64),
            Column::new("datekey", EngineDataType::Date).with_date_role(DateRole::DateKey),
            Column::new("year", EngineDataType::Int64).with_date_role(DateRole::Year),
            Column::new("quarter", EngineDataType::Int64).with_date_role(DateRole::Quarter),
            Column::new("month", EngineDataType::Int64).with_date_role(DateRole::Month),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);
    let fact = Table::new(
        "fact_sales",
        vec![
            Column::new("date_id", EngineDataType::Int64),
            Column::new("region", EngineDataType::String),
            Column::new("customer", EngineDataType::String),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);
    let model = DataModel::builder()
        .add_table(dim_date)
        .add_table(fact)
        .add_relationship(Relationship::many_to_one(
            "sales_date",
            "fact_sales",
            "date_id",
            "dim_date",
            "date_id",
        ))
        .add_measure(expression_measure(
            "m",
            parse_measure_expression("YTD(DISTINCTCOUNT(fact_sales[customer]))").unwrap(),
        ))
        .mark_date_table("dim_date")
        .build()
        .unwrap();

    let dim = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("datekey", DataType::Date32, true),
            Field::new("year", DataType::Int64, true),
            Field::new("quarter", DataType::Int64, true),
            Field::new("month", DataType::Int64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![202401i64])),
            Arc::new(Date32Array::from(vec![first_of_month_days(2024, 1)])),
            Arc::new(Int64Array::from(vec![2024i64])),
            Arc::new(Int64Array::from(vec![1i64])),
            Arc::new(Int64Array::from(vec![1i64])),
        ],
    )
    .unwrap();
    let fact_rows = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("region", DataType::Utf8, true),
            Field::new("customer", DataType::Utf8, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![202401i64, 202401, 202401, 202401])),
            Arc::new(StringArray::from(vec!["east", "east", "west", "west"])),
            Arc::new(StringArray::from(vec!["c1", "c2", "c2", "c3"])),
        ],
    )
    .unwrap();

    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim).unwrap();
    cache.store("fact_sales", fact_rows).unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = QueryRequest {
        measures: vec!["m".into()],
        group_by: vec![ColumnRef::new("fact_sales", "region")],
        totals: TotalsMode::Rollup,
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap();
    let map = rollup_region_map(&batches, "m");
    assert_eq!(map[&(Some("east".into()), 0)], Some(2.0));
    assert_eq!(map[&(Some("west".into()), 0)], Some(2.0));
    assert_eq!(
        map[&(None, 1)],
        Some(3.0),
        "grand DISTINCTCOUNT recomputed (c1,c2,c3), not 2+2"
    );
}

#[tokio::test]
async fn rollup_closingbalance_by_region() {
    // CLOSINGBALANCE(SUM(amount)) pins to the last context day (Dec 2024): east
    // Dec=12, west Dec=24. The grand total re-evaluates the balance over BOTH
    // regions on the boundary day = 36 — NOT a sum that assumes additivity.
    let mut req = request_with_filters(
        &[("fact_sales", "region")],
        &[("year", FilterOperator::Equal, "2024")],
    );
    req.totals = TotalsMode::Rollup;
    let batches = run("CLOSINGBALANCE(SUM(fact_sales[amount]))", true, req)
        .await
        .unwrap();
    let map = rollup_region_map(&batches, "m");
    assert_eq!(map[&(Some("east".into()), 0)], Some(12.0));
    assert_eq!(map[&(Some("west".into()), 0)], Some(24.0));
    assert_eq!(map[&(None, 1)], Some(36.0));
}

#[tokio::test]
async fn filter_context_compound_yoy_by_region() {
    // A compound filter-context measure (no totals): YoY = YTD − PRIORYEAR with
    // the date NOT on the axis. Each leaf evaluates against the date context, so
    // PRIORYEAR must see the prior year (the date table stays un-pre-filtered).
    // east 78−780 = −702, west 156−1560 = −1404.
    let model = model_with_measures(
        &[(
            "yoy",
            "YTD(SUM(fact_sales[amount])) - PRIORYEAR(SUM(fact_sales[amount]))",
        )],
        true,
    );
    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim_date_batch()).unwrap();
    cache.store("fact_sales", fact_batch()).unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = QueryRequest {
        measures: vec!["yoy".into()],
        group_by: vec![ColumnRef::new("fact_sales", "region")],
        filters: vec![FilterCondition::new("year", FilterOperator::Equal, "2024")],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    let region = combined
        .column(combined.schema().index_of("region").unwrap())
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap()
        .clone();
    let vals = measure_column(&combined, "yoy");
    let mut by_region: HashMap<String, Option<f64>> = HashMap::new();
    for i in 0..combined.num_rows() {
        by_region.insert(region.value(i).to_string(), vals[i]);
    }
    assert_eq!(by_region["east"], Some(-702.0));
    assert_eq!(by_region["west"], Some(-1404.0));
}

#[tokio::test]
async fn rollup_compound_yoy_by_region() {
    // Compound YoY (YTD − PRIORYEAR) × ROLLUP: both leaves are composable
    // filter-context families, so each rolls up and the arithmetic is applied per
    // level. Context year=2024: YTD = 2024, PRIORYEAR = 2023.
    // east 78−780 = −702, west 156−1560 = −1404, grand 234−2340 = −2106.
    let model = model_with_measures(
        &[(
            "yoy",
            "YTD(SUM(fact_sales[amount])) - PRIORYEAR(SUM(fact_sales[amount]))",
        )],
        true,
    );
    let batches = run_measures_rollup(
        &model,
        &["yoy"],
        &[("fact_sales", "region")],
        &[("year", FilterOperator::Equal, "2024")],
    )
    .await
    .unwrap();
    let map = rollup_region_map(&batches, "yoy");
    assert_eq!(map[&(Some("east".into()), 0)], Some(-702.0));
    assert_eq!(map[&(Some("west".into()), 0)], Some(-1404.0));
    assert_eq!(map[&(None, 1)], Some(-2106.0));
}

#[tokio::test]
async fn rollup_prioryear_by_region_recomputes() {
    // PeriodShift × ROLLUP (Phase 2): PRIORYEAR shifts the whole 2024 window back
    // to 2023. east 2023 = 10*(1..12) = 780, west = 1560; the rolled-up grand
    // total re-evaluates over BOTH regions = 2340 (gid=1).
    let mut req = request_with_filters(
        &[("fact_sales", "region")],
        &[("year", FilterOperator::Equal, "2024")],
    );
    req.totals = TotalsMode::Rollup;
    let batches = run("PRIORYEAR(SUM(fact_sales[amount]))", true, req)
        .await
        .unwrap();
    let map = rollup_region_map(&batches, "m");
    assert_eq!(map[&(Some("east".into()), 0)], Some(780.0));
    assert_eq!(map[&(Some("west".into()), 0)], Some(1560.0));
    assert_eq!(map[&(None, 1)], Some(2340.0));
}

#[tokio::test]
async fn rollup_prioryear_gapped_context_fails_closed() {
    // A whole-window shift over a GAPPED context (Jun excluded) is ill-defined at
    // every rollup level identically — the global contiguity guard fails the whole
    // query closed, rather than silently over-counting June 2023 in any subtotal.
    let mut req = request_with_filters(
        &[("fact_sales", "region")],
        &[
            ("year", FilterOperator::Equal, "2024"),
            ("month", FilterOperator::NotEqual, "6"),
        ],
    );
    req.totals = TotalsMode::Rollup;
    let err = run("PRIORYEAR(SUM(fact_sales[amount]))", true, req)
        .await
        .unwrap_err();
    let QueryError::Engine(EngineError::TimeIntelligence { reason, .. }) = &err else {
        panic!("expected a TimeIntelligence contiguity error, got {err:?}");
    };
    assert!(reason.contains("not contiguous"), "got: {reason}");
}

#[tokio::test]
async fn rollup_axis_ytd_still_fails_closed() {
    // YTD with the date on the GROUP-BY axis is the AXIS route — a running window
    // whose subtotal value is ill-defined — so ROLLUP stays fail-closed.
    let mut req = request(&[("dim_date", "year"), ("dim_date", "month")]);
    req.totals = TotalsMode::Rollup;
    let err = run("YTD(SUM(fact_sales[amount]))", true, req)
        .await
        .unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got: {err:?}");
    assert!(err.to_string().contains("totals"), "got: {err}");
}

// ===========================================================================
// Hierarchy (ragged) × filter-context time intelligence (Phase 3).
//
// A filter-context TI measure groups on the hierarchy's TRANSFORMED level
// expression (RepeatParent COALESCE / stopper NULLIF / ShowAsLeaf CASE), and
// HideMembers drops blank-level rows post-aggregation — exactly like an ordinary
// measure, because the lowered TI form is an ordinary aggregate.
// ===========================================================================

/// `fact_sales(date_id, country, state, city, amount)` → marked `dim_date`, with
/// a 3-level `Geo` hierarchy (country → optional state → city) and a single TI
/// measure. Queried at depth 2 (country, state) so `state` is the ragged level.
fn geo_ti_model(behavior: RaggedBehavior, measure_src: &str) -> DataModel {
    let dim_date = Table::new(
        "dim_date",
        vec![
            Column::new("date_id", EngineDataType::Int64),
            Column::new("datekey", EngineDataType::Date).with_date_role(DateRole::DateKey),
            Column::new("year", EngineDataType::Int64).with_date_role(DateRole::Year),
            Column::new("quarter", EngineDataType::Int64).with_date_role(DateRole::Quarter),
            Column::new("month", EngineDataType::Int64).with_date_role(DateRole::Month),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);
    let fact = Table::new(
        "fact_sales",
        vec![
            Column::new("date_id", EngineDataType::Int64),
            Column::new("country", EngineDataType::String),
            Column::new("state", EngineDataType::String),
            Column::new("city", EngineDataType::String),
            Column::new("amount", EngineDataType::Float64),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);
    DataModel::builder()
        .add_table(dim_date)
        .add_table(fact)
        .add_relationship(Relationship::many_to_one(
            "sales_date",
            "fact_sales",
            "date_id",
            "dim_date",
            "date_id",
        ))
        .add_measure(expression_measure(
            "m",
            parse_measure_expression(measure_src).unwrap(),
        ))
        .add_hierarchy(
            Hierarchy::new(
                "Geo",
                "fact_sales",
                vec![
                    HierarchyLevel::new("country"),
                    HierarchyLevel::new("state").with_optional(true),
                    HierarchyLevel::new("city"),
                ],
            )
            .with_ragged_behavior(behavior),
        )
        .mark_date_table("dim_date")
        .build()
        .unwrap()
}

/// Run the Geo-hierarchy TI request. One fact month (Jan 2024), so YTD = the
/// month total. `France/IDF=40, USA/WA=10, USA/<blank state>=30`.
async fn run_geo_ti(
    model: &DataModel,
    depth: usize,
    rollup: bool,
) -> QueryResult<Vec<RecordBatch>> {
    let dim = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("datekey", DataType::Date32, true),
            Field::new("year", DataType::Int64, true),
            Field::new("quarter", DataType::Int64, true),
            Field::new("month", DataType::Int64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![202401i64])),
            Arc::new(Date32Array::from(vec![first_of_month_days(2024, 1)])),
            Arc::new(Int64Array::from(vec![2024i64])),
            Arc::new(Int64Array::from(vec![1i64])),
            Arc::new(Int64Array::from(vec![1i64])),
        ],
    )
    .unwrap();
    let fact = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("country", DataType::Utf8, true),
            Field::new("state", DataType::Utf8, true),
            Field::new("city", DataType::Utf8, true),
            Field::new("amount", DataType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![202401i64, 202401, 202401])),
            Arc::new(StringArray::from(vec!["France", "USA", "USA"])),
            Arc::new(StringArray::from(vec![Some("IDF"), Some("WA"), None])),
            Arc::new(StringArray::from(vec!["Paris", "Seattle", "DC"])),
            Arc::new(Float64Array::from(vec![40.0, 10.0, 30.0])),
        ],
    )
    .unwrap();
    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim).unwrap();
    cache.store("fact_sales", fact).unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = QueryRequest {
        measures: vec!["m".into()],
        hierarchy_group_by: Some(HierarchyGroupBy::new("Geo", depth)),
        totals: if rollup {
            TotalsMode::Rollup
        } else {
            TotalsMode::None
        },
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, model, &registry, &[])?;
    QueryExecutor::execute(&plan, model, &registry, Some(&cache), None, None, &[]).await
}

/// `(country, state) -> m` map; a NULL (blank / rolled-up) level reads as `"*"`.
fn geo_map(batches: &[RecordBatch]) -> HashMap<(String, String), f64> {
    let combined = concat_batches(&batches[0].schema(), batches).unwrap();
    let read = |name: &str| {
        let idx = combined.schema().index_of(name).unwrap();
        arrow::compute::cast(combined.column(idx), &DataType::Utf8)
            .unwrap()
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap()
            .clone()
    };
    let country = read("country");
    let state = read("state");
    let m = measure_column(&combined, "m");
    let cell = |a: &StringArray, i: usize| {
        if a.is_null(i) {
            "*".to_string()
        } else {
            a.value(i).to_string()
        }
    };
    let mut map = HashMap::new();
    for i in 0..combined.num_rows() {
        map.insert(
            (cell(&country, i), cell(&state, i)),
            m[i].unwrap_or(f64::NAN),
        );
    }
    map
}

#[tokio::test]
async fn hierarchy_repeat_parent_with_ytd_groups_on_filled_values() {
    // RepeatParent fills the blank state with the country. YTD (date not on the
    // axis) groups on the TRANSFORMED level COALESCE(state, country), so the USA
    // row with no state groups under state="USA" (not its own blank group).
    let model = geo_ti_model(RaggedBehavior::RepeatParent, "YTD(SUM(fact_sales[amount]))");
    let map = geo_map(&run_geo_ti(&model, 2, false).await.unwrap());
    assert_eq!(map[&("France".into(), "IDF".into())], 40.0);
    assert_eq!(map[&("USA".into(), "WA".into())], 10.0);
    assert_eq!(
        map[&("USA".into(), "USA".into())],
        30.0,
        "blank state filled with the country via the hierarchy transform"
    );
    assert_eq!(map.len(), 3);
}

#[tokio::test]
async fn hierarchy_hide_members_with_ytd_drops_blank_branch() {
    // HideMembers: the YTD is computed, then the row whose state is blank is
    // dropped post-aggregation (the transform + filter ride the lowered aggregate).
    let model = geo_ti_model(RaggedBehavior::HideMembers, "YTD(SUM(fact_sales[amount]))");
    let map = geo_map(&run_geo_ti(&model, 2, false).await.unwrap());
    assert_eq!(map.len(), 2, "the blank-state USA branch is hidden");
    assert_eq!(map[&("France".into(), "IDF".into())], 40.0);
    assert_eq!(map[&("USA".into(), "WA".into())], 10.0);
    assert!(!map.contains_key(&("USA".into(), "*".into())));
}

#[tokio::test]
async fn hierarchy_compound_yoy_repeat_parent() {
    // Compound YoY (YTD − PRIORYEAR) × ragged hierarchy: each leaf applies the
    // RepeatParent transform (blank state → country), so the USA blank-state row
    // groups under state="USA". 2024 = 40/10/30, 2023 = 20/5/15 → YoY = 20/5/15.
    let model = geo_ti_model(
        RaggedBehavior::RepeatParent,
        "YTD(SUM(fact_sales[amount])) - PRIORYEAR(SUM(fact_sales[amount]))",
    );
    let dim = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("datekey", DataType::Date32, true),
            Field::new("year", DataType::Int64, true),
            Field::new("quarter", DataType::Int64, true),
            Field::new("month", DataType::Int64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![202301i64, 202401])),
            Arc::new(Date32Array::from(vec![
                first_of_month_days(2023, 1),
                first_of_month_days(2024, 1),
            ])),
            Arc::new(Int64Array::from(vec![2023i64, 2024])),
            Arc::new(Int64Array::from(vec![1i64, 1])),
            Arc::new(Int64Array::from(vec![1i64, 1])),
        ],
    )
    .unwrap();
    let fact = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("date_id", DataType::Int64, true),
            Field::new("country", DataType::Utf8, true),
            Field::new("state", DataType::Utf8, true),
            Field::new("city", DataType::Utf8, true),
            Field::new("amount", DataType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![
                202401i64, 202401, 202401, 202301, 202301, 202301,
            ])),
            Arc::new(StringArray::from(vec![
                "France", "USA", "USA", "France", "USA", "USA",
            ])),
            Arc::new(StringArray::from(vec![
                Some("IDF"),
                Some("WA"),
                None,
                Some("IDF"),
                Some("WA"),
                None,
            ])),
            Arc::new(StringArray::from(vec![
                "Paris", "Seattle", "DC", "Paris", "Seattle", "DC",
            ])),
            Arc::new(Float64Array::from(vec![40.0, 10.0, 30.0, 20.0, 5.0, 15.0])),
        ],
    )
    .unwrap();
    let mut cache = InMemoryCache::new();
    cache.store("dim_date", dim).unwrap();
    cache.store("fact_sales", fact).unwrap();
    let mut registry = SourceRegistry::new();
    registry.bind("dim_date", 0, SourceBinding::new("public", "dim_date"));
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));
    let req = QueryRequest {
        measures: vec!["m".into()],
        hierarchy_group_by: Some(HierarchyGroupBy::new("Geo", 2)),
        filters: vec![FilterCondition::new("year", FilterOperator::Equal, "2024")],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap();
    let map = geo_map(&batches);
    assert_eq!(map[&("France".into(), "IDF".into())], 20.0);
    assert_eq!(map[&("USA".into(), "WA".into())], 5.0);
    assert_eq!(
        map[&("USA".into(), "USA".into())],
        15.0,
        "blank state filled with country; YoY computed per level"
    );
}

#[tokio::test]
async fn hierarchy_repeat_parent_with_ytd_and_rollup() {
    // RepeatParent × ROLLUP × YTD together: detail rows on the filled levels plus
    // a country subtotal (state rolled up → "*") that re-evaluates YTD over the
    // rolled-up rows, and a grand total.
    let model = geo_ti_model(RaggedBehavior::RepeatParent, "YTD(SUM(fact_sales[amount]))");
    let map = geo_map(&run_geo_ti(&model, 2, true).await.unwrap());
    // Detail (filled state).
    assert_eq!(map[&("France".into(), "IDF".into())], 40.0);
    assert_eq!(map[&("USA".into(), "WA".into())], 10.0);
    assert_eq!(map[&("USA".into(), "USA".into())], 30.0);
    // Country subtotals (state rolled up) — recomputed, not summed from a stale value.
    assert_eq!(map[&("France".into(), "*".into())], 40.0);
    assert_eq!(map[&("USA".into(), "*".into())], 40.0);
    // Grand total.
    assert_eq!(map[&("*".into(), "*".into())], 80.0);
}
