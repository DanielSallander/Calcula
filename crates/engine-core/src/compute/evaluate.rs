//! Expression evaluation against Arrow RecordBatches.
//!
//! Evaluates `Expression` trees against existing data by registering
//! the batch in a DataFusion `SessionContext` and executing SQL.

use std::sync::Arc;

use arrow::array::ArrayRef;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use crate::compute::expression::Expression;
use crate::error::EngineResult;
use crate::model::calculated_column::CalculatedColumn;

/// Evaluate a row-level expression against a `RecordBatch`, producing a new column.
///
/// The expression must not contain aggregate nodes. Uses DataFusion SQL
/// to evaluate the expression, handling type coercion and null propagation.
pub async fn evaluate_expression(
    batch: &RecordBatch,
    expression: &Expression,
) -> EngineResult<ArrayRef> {
    let ctx = SessionContext::new();
    ctx.register_batch("t", batch.clone())?;

    let expr_sql = expression.to_sql_string();
    let sql = format!("SELECT {expr_sql} AS result FROM t");
    let df = ctx.sql(&sql).await?;
    let batches = df.collect().await?;

    if batches.is_empty() || batches[0].num_rows() == 0 {
        // Return an empty array of the same length.
        let empty_batch = RecordBatch::new_empty(Arc::new(Schema::new(vec![Field::new(
            "result",
            DataType::Float64,
            true,
        )])));
        return Ok(empty_batch.column(0).clone());
    }

    // Concatenate all result batches if there are multiple.
    if batches.len() == 1 {
        Ok(batches[0].column(0).clone())
    } else {
        let schema = batches[0].schema();
        let combined = arrow::compute::concat_batches(&schema, &batches)?;
        Ok(combined.column(0).clone())
    }
}

/// Materialize calculated columns by appending them to a `RecordBatch`.
///
/// Evaluates each calculated column's expression and appends the result
/// as a new column to the batch.
pub async fn materialize_calculated_columns(
    batch: &RecordBatch,
    calculated_columns: &[CalculatedColumn],
) -> EngineResult<RecordBatch> {
    if calculated_columns.is_empty() {
        return Ok(batch.clone());
    }

    // Build all calculated columns in a single DataFusion query for efficiency.
    let ctx = SessionContext::new();
    ctx.register_batch("t", batch.clone())?;

    // SELECT *, expr1 AS name1, expr2 AS name2, ... FROM t
    let mut select_parts: Vec<String> = vec!["*".to_string()];
    for cc in calculated_columns {
        let expr_sql = cc.expression().to_sql_string();
        select_parts.push(format!("{expr_sql} AS \"{}\"", cc.name()));
    }

    let sql = format!("SELECT {} FROM t", select_parts.join(", "));
    let df = ctx.sql(&sql).await?;
    let batches = df.collect().await?;

    if batches.is_empty() {
        // Build an empty batch with the extended schema.
        let mut fields: Vec<Field> = batch
            .schema()
            .fields()
            .iter()
            .map(|f| f.as_ref().clone())
            .collect();
        for cc in calculated_columns {
            fields.push(Field::new(cc.name(), cc.data_type().to_arrow(), true));
        }
        return Ok(RecordBatch::new_empty(Arc::new(Schema::new(fields))));
    }

    if batches.len() == 1 {
        Ok(batches[0].clone())
    } else {
        let schema = batches[0].schema();
        let combined = arrow::compute::concat_batches(&schema, &batches)?;
        Ok(combined)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::expression::{self as expr};
    use crate::model::column::Column;
    use crate::model::table::Table;
    use crate::store::TableData;
    use crate::types::{DataType as EngineDataType, Value};

    fn sales_data() -> RecordBatch {
        let table = Table::new(
            "Sales",
            vec![
                Column::new("price", EngineDataType::Float64),
                Column::new("quantity", EngineDataType::Int64),
                Column::new("cost", EngineDataType::Float64),
            ],
        )
        .unwrap();
        let mut data = TableData::new(table);
        data.insert_rows(vec![
            vec![Value::Float64(10.0), Value::Int64(5), Value::Float64(7.0)],
            vec![Value::Float64(20.0), Value::Int64(3), Value::Float64(15.0)],
            vec![Value::Float64(15.0), Value::Int64(2), Value::Float64(10.0)],
        ])
        .unwrap();
        data.to_record_batch().unwrap()
    }

    #[tokio::test]
    async fn evaluate_multiplication() {
        let batch = sales_data();
        let expression = expr::col("price").multiply(expr::col("quantity"));
        let result = evaluate_expression(&batch, &expression).await.unwrap();

        assert_eq!(result.len(), 3);
        let values: Vec<f64> = result
            .as_any()
            .downcast_ref::<arrow::array::Float64Array>()
            .unwrap()
            .values()
            .to_vec();
        assert_eq!(values, vec![50.0, 60.0, 30.0]);
    }

    #[tokio::test]
    async fn evaluate_subtraction() {
        let batch = sales_data();
        let expression = expr::col("price").subtract(expr::col("cost"));
        let result = evaluate_expression(&batch, &expression).await.unwrap();

        let values: Vec<f64> = result
            .as_any()
            .downcast_ref::<arrow::array::Float64Array>()
            .unwrap()
            .values()
            .to_vec();
        assert_eq!(values, vec![3.0, 5.0, 5.0]);
    }

    #[tokio::test]
    async fn evaluate_with_literal() {
        let batch = sales_data();
        let expression = expr::col("price").multiply(expr::lit(1.1));
        let result = evaluate_expression(&batch, &expression).await.unwrap();

        let values: Vec<f64> = result
            .as_any()
            .downcast_ref::<arrow::array::Float64Array>()
            .unwrap()
            .values()
            .to_vec();
        // 10*1.1=11, 20*1.1=22, 15*1.1=16.5
        assert!((values[0] - 11.0).abs() < 0.01);
        assert!((values[1] - 22.0).abs() < 0.01);
        assert!((values[2] - 16.5).abs() < 0.01);
    }

    #[tokio::test]
    async fn evaluate_with_nulls() {
        let table = Table::new(
            "Sales",
            vec![
                Column::new("price", EngineDataType::Float64),
                Column::new("cost", EngineDataType::Float64),
            ],
        )
        .unwrap();
        let mut data = TableData::new(table);
        data.insert_rows(vec![
            vec![Value::Float64(10.0), Value::Float64(7.0)],
            vec![Value::Float64(20.0), Value::Null],
            vec![Value::Null, Value::Float64(5.0)],
        ])
        .unwrap();
        let batch = data.to_record_batch().unwrap();

        let expression = expr::col("price").subtract(expr::col("cost"));
        let result = evaluate_expression(&batch, &expression).await.unwrap();

        assert_eq!(result.len(), 3);
        assert_eq!(result.null_count(), 2); // null propagates
    }

    #[tokio::test]
    async fn materialize_single_calculated_column() {
        let batch = sales_data();
        let cc = CalculatedColumn::new(
            "revenue",
            "Sales",
            expr::col("price").multiply(expr::col("quantity")),
            EngineDataType::Float64,
        );

        let result = materialize_calculated_columns(&batch, &[cc]).await.unwrap();

        // Original 3 columns + 1 calculated
        assert_eq!(result.num_columns(), 4);
        assert_eq!(result.num_rows(), 3);
        assert_eq!(result.schema().field(3).name(), "revenue");
    }

    #[tokio::test]
    async fn materialize_multiple_calculated_columns() {
        let batch = sales_data();
        let cc1 = CalculatedColumn::new(
            "revenue",
            "Sales",
            expr::col("price").multiply(expr::col("quantity")),
            EngineDataType::Float64,
        );
        let cc2 = CalculatedColumn::new(
            "profit",
            "Sales",
            expr::col("price").subtract(expr::col("cost")),
            EngineDataType::Float64,
        );

        let result = materialize_calculated_columns(&batch, &[cc1, cc2])
            .await
            .unwrap();

        assert_eq!(result.num_columns(), 5);
        assert_eq!(result.schema().field(3).name(), "revenue");
        assert_eq!(result.schema().field(4).name(), "profit");
    }

    #[tokio::test]
    async fn materialize_empty_list_returns_original() {
        let batch = sales_data();
        let result = materialize_calculated_columns(&batch, &[]).await.unwrap();
        assert_eq!(result.num_columns(), batch.num_columns());
        assert_eq!(result.num_rows(), batch.num_rows());
    }
}
