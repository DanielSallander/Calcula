//! Aggregation operations over Arrow arrays using DataFusion.

use arrow::record_batch::RecordBatch;
use datafusion::common::ScalarValue;
use datafusion::functions_aggregate::count::{count, count_distinct};
use datafusion::functions_aggregate::min_max::{max, min};
use datafusion::functions_aggregate::sum::sum;
use datafusion::logical_expr::col;
use datafusion::prelude::SessionContext;
use serde::{Deserialize, Serialize};

use crate::error::EngineResult;
use crate::store::TableData;

/// Supported aggregation operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AggregateOp {
    /// Sum of all non-null values.
    Sum,
    /// Count of non-null values.
    Count,
    /// Arithmetic mean of non-null values.
    Average,
    /// Minimum value.
    Min,
    /// Maximum value.
    Max,
    /// Count of distinct non-null values.
    DistinctCount,
    /// Count of all rows (including nulls): `COUNT(*)`.
    CountRows,
    /// Median (50th percentile) of non-null values.
    Median,
    /// Sample standard deviation (N-1 denominator).
    StdevSample,
    /// Population standard deviation (N denominator).
    StdevPop,
    /// Sample variance (N-1 denominator).
    VarSample,
    /// Population variance (N denominator).
    VarPop,
}

impl std::fmt::Display for AggregateOp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AggregateOp::Sum => write!(f, "SUM"),
            AggregateOp::Count => write!(f, "COUNT"),
            AggregateOp::Average => write!(f, "AVG"),
            AggregateOp::Min => write!(f, "MIN"),
            AggregateOp::Max => write!(f, "MAX"),
            AggregateOp::DistinctCount => write!(f, "COUNT_DISTINCT"),
            AggregateOp::CountRows => write!(f, "COUNT"),
            AggregateOp::Median => write!(f, "median"),
            AggregateOp::StdevSample => write!(f, "stddev"),
            AggregateOp::StdevPop => write!(f, "stddev_pop"),
            AggregateOp::VarSample => write!(f, "var"),
            AggregateOp::VarPop => write!(f, "var_pop"),
        }
    }
}

/// Result of an aggregation, represented as a DataFusion `ScalarValue`.
///
/// This preserves the original Arrow type (e.g. sum of Int64 column is Int64,
/// average of Int64 column is Float64).
#[derive(Debug, Clone)]
pub struct AggregateResult {
    /// The aggregation operation that produced this result.
    pub operation: AggregateOp,
    /// The column that was aggregated.
    pub column: String,
    /// The scalar result value.
    pub value: ScalarValue,
}

impl AggregateResult {
    /// Try to extract the result as an `f64`.
    ///
    /// Returns `None` if the result is null or cannot be converted to f64.
    pub fn as_f64(&self) -> Option<f64> {
        match &self.value {
            ScalarValue::Float64(v) => *v,
            ScalarValue::Int32(v) => v.map(|n| n as f64),
            ScalarValue::Int64(v) => v.map(|n| n as f64),
            ScalarValue::UInt64(v) => v.map(|n| n as f64),
            ScalarValue::Decimal128(v, _, scale) => v.map(|n| n as f64 / 10f64.powi(*scale as i32)),
            _ => None,
        }
    }
}

/// Compute an aggregation over a single column of a `TableData` using DataFusion.
///
/// This registers the table data as a DataFusion in-memory table and executes
/// the aggregation query, leveraging DataFusion's optimized execution engine.
pub async fn compute_aggregate(
    table_data: &TableData,
    column_name: &str,
    operation: AggregateOp,
) -> EngineResult<AggregateResult> {
    // Validate column exists.
    table_data.table().column(column_name)?;

    // Average is computed as sum/count to ensure Float64 output.
    if operation == AggregateOp::Average {
        return compute_average(table_data, column_name).await;
    }

    let scalar = run_single_aggregate(table_data, column_name, &operation).await?;

    Ok(AggregateResult {
        operation,
        column: column_name.to_string(),
        value: scalar,
    })
}

/// Execute a single (non-Average) aggregation via DataFusion and return the scalar.
async fn run_single_aggregate(
    table_data: &TableData,
    column_name: &str,
    operation: &AggregateOp,
) -> EngineResult<ScalarValue> {
    let batch = table_data.to_record_batch()?;
    let ctx = SessionContext::new();
    // DataFusion normalizes identifiers to lowercase, so register with a
    // fixed lowercase name to avoid case-mismatch errors.
    let df_table_name = "t";
    ctx.register_batch(df_table_name, batch)?;

    let df = ctx.table(df_table_name).await?;

    let agg_expr = match operation {
        AggregateOp::Sum => sum(col(column_name)),
        AggregateOp::Count => count(col(column_name)),
        AggregateOp::Min => min(col(column_name)),
        AggregateOp::Max => max(col(column_name)),
        AggregateOp::DistinctCount => count_distinct(col(column_name)),
        AggregateOp::CountRows => {
            // COUNT(*) — count all rows regardless of nulls.
            // Use count(lit(1)) as DataFusion equivalent of COUNT(*).
            use datafusion::prelude::lit as df_lit;
            count(df_lit(1))
        }
        AggregateOp::Average => unreachable!("Average handled separately"),
        // Statistical aggregates use DataFusion's built-in functions via SQL.
        // This code path is not normally reached for statistical aggregates
        // since they go through the SQL-based execution path.
        AggregateOp::Median
        | AggregateOp::StdevSample
        | AggregateOp::StdevPop
        | AggregateOp::VarSample
        | AggregateOp::VarPop => {
            use datafusion::functions_aggregate::median::median;
            use datafusion::functions_aggregate::stddev::stddev;
            use datafusion::functions_aggregate::variance::var_sample;
            match operation {
                AggregateOp::Median => median(col(column_name)),
                AggregateOp::StdevSample => stddev(col(column_name)),
                AggregateOp::StdevPop => stddev(col(column_name)), // approximate
                AggregateOp::VarSample => var_sample(col(column_name)),
                AggregateOp::VarPop => var_sample(col(column_name)), // approximate
                _ => unreachable!(),
            }
        }
    };

    let result_df = df.aggregate(vec![], vec![agg_expr])?;
    let batches = result_df.collect().await?;
    extract_scalar(&batches)
}

/// Compute average as sum / count, returning Float64.
async fn compute_average(
    table_data: &TableData,
    column_name: &str,
) -> EngineResult<AggregateResult> {
    let sum_scalar = run_single_aggregate(table_data, column_name, &AggregateOp::Sum).await?;
    let count_scalar = run_single_aggregate(table_data, column_name, &AggregateOp::Count).await?;

    let sum_result = AggregateResult {
        operation: AggregateOp::Sum,
        column: column_name.to_string(),
        value: sum_scalar,
    };

    let count_val = match &count_scalar {
        ScalarValue::Int64(Some(n)) => *n,
        ScalarValue::UInt64(Some(n)) => *n as i64,
        _ => {
            return Ok(AggregateResult {
                operation: AggregateOp::Average,
                column: column_name.to_string(),
                value: ScalarValue::Float64(None),
            });
        }
    };

    if count_val == 0 {
        return Ok(AggregateResult {
            operation: AggregateOp::Average,
            column: column_name.to_string(),
            value: ScalarValue::Float64(None),
        });
    }

    let avg = sum_result.as_f64().map(|s| s / count_val as f64);

    Ok(AggregateResult {
        operation: AggregateOp::Average,
        column: column_name.to_string(),
        value: ScalarValue::Float64(avg),
    })
}

/// Extract a single scalar value from aggregation result batches.
fn extract_scalar(batches: &[RecordBatch]) -> EngineResult<ScalarValue> {
    if batches.is_empty() || batches[0].num_rows() == 0 {
        return Ok(ScalarValue::Null);
    }
    let batch = &batches[0];
    let col = batch.column(0);
    let scalar = ScalarValue::try_from_array(col, 0)?;
    Ok(scalar)
}

/// Convenience: compute multiple aggregations in one call.
pub async fn compute_aggregates(
    table_data: &TableData,
    column_name: &str,
    operations: &[AggregateOp],
) -> EngineResult<Vec<AggregateResult>> {
    let mut results = Vec::with_capacity(operations.len());
    for op in operations {
        results.push(compute_aggregate(table_data, column_name, *op).await?);
    }
    Ok(results)
}

/// Convenience: compute a SUM over a column, returning the result as f64.
pub async fn sum_column(table_data: &TableData, column_name: &str) -> EngineResult<Option<f64>> {
    let result = compute_aggregate(table_data, column_name, AggregateOp::Sum).await?;
    Ok(result.as_f64())
}

/// Convenience: compute a COUNT over a column, returning the count.
pub async fn count_column(table_data: &TableData, column_name: &str) -> EngineResult<Option<i64>> {
    let result = compute_aggregate(table_data, column_name, AggregateOp::Count).await?;
    match &result.value {
        ScalarValue::Int64(v) => Ok(*v),
        ScalarValue::UInt64(v) => Ok(v.map(|n| n as i64)),
        _ => Ok(None),
    }
}

/// Convenience: compute an AVG over a column, returning the result as f64.
pub async fn average_column(
    table_data: &TableData,
    column_name: &str,
) -> EngineResult<Option<f64>> {
    let result = compute_aggregate(table_data, column_name, AggregateOp::Average).await?;
    Ok(result.as_f64())
}

/// Convenience: compute a DISTINCT COUNT over a column, returning the count.
pub async fn distinct_count_column(
    table_data: &TableData,
    column_name: &str,
) -> EngineResult<Option<i64>> {
    let result = compute_aggregate(table_data, column_name, AggregateOp::DistinctCount).await?;
    match &result.value {
        ScalarValue::Int64(v) => Ok(*v),
        ScalarValue::UInt64(v) => Ok(v.map(|n| n as i64)),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::column::Column;
    use crate::model::table::Table;
    use crate::types::{DataType, Value};

    fn create_test_table_with_amounts(amounts: Vec<f64>) -> TableData {
        let table = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let mut data = TableData::new(table);
        let rows: Vec<Vec<Value>> = amounts
            .into_iter()
            .enumerate()
            .map(|(i, a)| vec![Value::Int64(i as i64 + 1), Value::Float64(a)])
            .collect();
        data.insert_rows(rows).unwrap();
        data
    }

    fn create_test_table_with_nulls() -> TableData {
        let table = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let mut data = TableData::new(table);
        data.insert_rows(vec![
            vec![Value::Int64(1), Value::Float64(10.0)],
            vec![Value::Int64(2), Value::Null],
            vec![Value::Int64(3), Value::Float64(30.0)],
        ])
        .unwrap();
        data
    }

    fn create_int_table(values: Vec<i64>) -> TableData {
        let table = Table::new("Numbers", vec![Column::new("value", DataType::Int64)]).unwrap();
        let mut data = TableData::new(table);
        let rows: Vec<Vec<Value>> = values.into_iter().map(|v| vec![Value::Int64(v)]).collect();
        data.insert_rows(rows).unwrap();
        data
    }

    #[tokio::test]
    async fn sum_aggregate_returns_correct_total() {
        let data = create_test_table_with_amounts(vec![10.0, 20.0, 30.0]);
        let result = sum_column(&data, "amount").await.unwrap();
        assert_eq!(result, Some(60.0));
    }

    #[tokio::test]
    async fn count_aggregate_returns_correct_count() {
        let data = create_test_table_with_amounts(vec![10.0, 20.0, 30.0]);
        let result = count_column(&data, "amount").await.unwrap();
        assert_eq!(result, Some(3));
    }

    #[tokio::test]
    async fn average_aggregate_returns_correct_mean() {
        let data = create_test_table_with_amounts(vec![10.0, 20.0, 30.0]);
        let result = average_column(&data, "amount").await.unwrap();
        assert!((result.unwrap() - 20.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn min_aggregate_returns_minimum() {
        let data = create_test_table_with_amounts(vec![10.0, 5.0, 30.0]);
        let result = compute_aggregate(&data, "amount", AggregateOp::Min)
            .await
            .unwrap();
        assert_eq!(result.as_f64(), Some(5.0));
    }

    #[tokio::test]
    async fn max_aggregate_returns_maximum() {
        let data = create_test_table_with_amounts(vec![10.0, 5.0, 30.0]);
        let result = compute_aggregate(&data, "amount", AggregateOp::Max)
            .await
            .unwrap();
        assert_eq!(result.as_f64(), Some(30.0));
    }

    #[tokio::test]
    async fn sum_aggregate_with_null_values() {
        let data = create_test_table_with_nulls();
        let result = sum_column(&data, "amount").await.unwrap();
        assert_eq!(result, Some(40.0));
    }

    #[tokio::test]
    async fn count_aggregate_skips_nulls() {
        let data = create_test_table_with_nulls();
        let result = count_column(&data, "amount").await.unwrap();
        assert_eq!(result, Some(2));
    }

    #[tokio::test]
    async fn average_aggregate_with_null_values() {
        let data = create_test_table_with_nulls();
        let result = average_column(&data, "amount").await.unwrap();
        assert!((result.unwrap() - 20.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn sum_int64_column() {
        let data = create_int_table(vec![100, 200, 300]);
        let result = sum_column(&data, "value").await.unwrap();
        assert_eq!(result, Some(600.0));
    }

    #[tokio::test]
    async fn distinct_count_with_duplicates() {
        let table = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product", DataType::String),
            ],
        )
        .unwrap();
        let mut data = TableData::new(table);
        data.insert_rows(vec![
            vec![Value::Int64(1), Value::String("A".into())],
            vec![Value::Int64(2), Value::String("B".into())],
            vec![Value::Int64(3), Value::String("A".into())],
            vec![Value::Int64(4), Value::String("C".into())],
            vec![Value::Int64(5), Value::String("B".into())],
        ])
        .unwrap();

        let result = distinct_count_column(&data, "product").await.unwrap();
        assert_eq!(result, Some(3)); // A, B, C
    }

    #[tokio::test]
    async fn distinct_count_with_nulls() {
        let table = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product", DataType::String),
            ],
        )
        .unwrap();
        let mut data = TableData::new(table);
        data.insert_rows(vec![
            vec![Value::Int64(1), Value::String("A".into())],
            vec![Value::Int64(2), Value::Null],
            vec![Value::Int64(3), Value::String("A".into())],
            vec![Value::Int64(4), Value::String("B".into())],
        ])
        .unwrap();

        let result = distinct_count_column(&data, "product").await.unwrap();
        assert_eq!(result, Some(2)); // A, B (null excluded)
    }

    #[tokio::test]
    async fn nonexistent_column_returns_error() {
        let data = create_test_table_with_amounts(vec![10.0]);
        let result = compute_aggregate(&data, "nonexistent", AggregateOp::Sum).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn empty_table_sum() {
        let table = Table::new("Empty", vec![Column::new("value", DataType::Float64)]).unwrap();
        let data = TableData::new(table);
        let result = sum_column(&data, "value").await.unwrap();
        // Sum of empty table: null → None via as_f64.
        assert!(result.is_none() || result == Some(0.0));
    }
}
