//! End-to-end pipeline tests for time-intelligence measures (YTD/QTD/MTD/
//! PRIORYEAR/PRIORPERIOD) over a small in-memory star schema: a 2-year
//! monthly fact table joined to a marked date table.
//!
//! These tests exercise the full route: parse → plan (forced local) →
//! window-measure detection → time-intelligence lowering → two-stage window
//! execution — with exact value assertions.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::compute::concat_batches;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use engine_core::compute::measure::expression_measure;
use engine_core::compute::parser::parse_measure_expression;
use engine_core::error::EngineError;
use engine_core::model::column::Column;
use engine_core::model::table::{StorageMode, Table};
use engine_core::model::{DataModel, DateRole, Relationship};
use engine_core::store::InMemoryCache;
use engine_core::types::DataType as EngineDataType;

use super::QueryExecutor;
use crate::error::{QueryError, QueryResult};
use crate::planner::PushdownPlanner;
use crate::registry::{SourceBinding, SourceRegistry};
use crate::request::{ColumnRef, QueryRequest, TotalsMode};

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

/// 24 monthly dim rows (2023-01 .. 2024-12); `date_id = year * 100 + month`.
fn dim_date_batch() -> RecordBatch {
    let mut date_id = Vec::new();
    let mut year = Vec::new();
    let mut quarter = Vec::new();
    let mut month = Vec::new();
    for y in [2023i64, 2024] {
        for m in 1i64..=12 {
            date_id.push(y * 100 + m);
            year.push(y);
            quarter.push((m - 1) / 3 + 1);
            month.push(m);
        }
    }
    let schema = Arc::new(Schema::new(vec![
        Field::new("date_id", DataType::Int64, true),
        Field::new("year", DataType::Int64, true),
        Field::new("quarter", DataType::Int64, true),
        Field::new("month", DataType::Int64, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(date_id)),
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
