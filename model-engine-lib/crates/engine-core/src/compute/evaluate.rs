//! Expression evaluation against Arrow RecordBatches.
//!
//! Evaluates `Expression` trees against existing data by registering
//! the batch in a DataFusion `SessionContext` and executing SQL.

use std::sync::Arc;

use arrow::array::ArrayRef;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::compute::expression::Expression;
use crate::compute::sql_util::quote_ident_double;
use crate::compute::udf::{session_context_with_udfs, UdfRegistry};
use crate::error::{EngineError, EngineResult};
use crate::model::calculated_column::CalculatedColumn;

/// Evaluate a row-level expression against a `RecordBatch`, producing a new column.
///
/// The expression must not contain aggregate nodes. Uses DataFusion SQL
/// to evaluate the expression, handling type coercion and null propagation.
///
/// Expressions containing UDF calls require
/// [`evaluate_expression_with_udfs`]; this function evaluates with an empty
/// registry, so calls fail with a DataFusion "invalid function" error.
pub async fn evaluate_expression(
    batch: &RecordBatch,
    expression: &Expression,
) -> EngineResult<ArrayRef> {
    evaluate_expression_with_udfs(batch, expression, &UdfRegistry::new()).await
}

/// Evaluate a row-level expression with host-registered UDFs available.
///
/// Like [`evaluate_expression`], but `Expression::Call` nodes resolve
/// against `udfs`.
pub async fn evaluate_expression_with_udfs(
    batch: &RecordBatch,
    expression: &Expression,
    udfs: &UdfRegistry,
) -> EngineResult<ArrayRef> {
    let ctx = session_context_with_udfs(udfs);
    ctx.register_batch("t", batch.clone())?;

    let expr_sql = expression.to_sql_string()?;
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
///
/// Calculated columns containing UDF calls require
/// [`materialize_calculated_columns_with_udfs`]; this function evaluates
/// with an empty registry.
pub async fn materialize_calculated_columns(
    batch: &RecordBatch,
    calculated_columns: &[CalculatedColumn],
) -> EngineResult<RecordBatch> {
    materialize_calculated_columns_with_udfs(batch, calculated_columns, &UdfRegistry::new()).await
}

/// Materialize calculated columns with host-registered UDFs available.
///
/// Like [`materialize_calculated_columns`], but `Expression::Call` nodes in
/// the column expressions resolve against `udfs`.
pub async fn materialize_calculated_columns_with_udfs(
    batch: &RecordBatch,
    calculated_columns: &[CalculatedColumn],
    udfs: &UdfRegistry,
) -> EngineResult<RecordBatch> {
    if calculated_columns.is_empty() {
        return Ok(batch.clone());
    }

    // Generated PATH columns are computed in Rust FIRST (a recursive
    // parent-walk row-level SQL cannot express) and appended to the batch, so
    // ordinary expression columns below may reference them (e.g.
    // PATHLENGTH(t[Path])).
    let mut batch = batch.clone();
    let (path_cols, calculated_columns): (Vec<_>, Vec<_>) = calculated_columns
        .iter()
        .cloned()
        .partition(|cc| cc.path().is_some());
    for cc in &path_cols {
        let spec = cc.path().expect("partitioned on path().is_some()");
        let path_array = compute_path_column(&batch, &spec.id_column, &spec.parent_column)
            .map_err(|reason| EngineError::InvalidCalculatedColumn {
                name: cc.name().to_string(),
                reason,
            })?;
        let mut fields: Vec<Field> = batch
            .schema()
            .fields()
            .iter()
            .map(|f| f.as_ref().clone())
            .collect();
        fields.push(Field::new(cc.name(), DataType::Utf8, true));
        let mut columns = batch.columns().to_vec();
        columns.push(Arc::new(path_array));
        batch = RecordBatch::try_new(Arc::new(Schema::new(fields)), columns)?;
    }
    // THISROW columns (aggregates over ITERATE, optionally with anchor-row
    // references) materialize LAST via a self-join rewrite, over a batch that
    // already carries the path + plain expression columns.
    let (thisrow_cols, expr_cols): (Vec<_>, Vec<_>) = calculated_columns
        .into_iter()
        .partition(|cc| cc.expression().has_aggregate() || cc.expression().has_this_row());

    let result = if expr_cols.is_empty() {
        batch
    } else {
        // Build all plain expression columns in a single DataFusion query.
        let ctx = session_context_with_udfs(udfs);
        ctx.register_batch("t", batch.clone())?;

        // SELECT *, expr1 AS name1, expr2 AS name2, ... FROM t
        let mut select_parts: Vec<String> = vec!["*".to_string()];
        for cc in &expr_cols {
            let expr_sql = cc.expression().to_sql_string()?;
            select_parts.push(format!("{expr_sql} AS {}", quote_ident_double(cc.name())));
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
            for cc in &expr_cols {
                fields.push(Field::new(cc.name(), cc.data_type().to_arrow(), true));
            }
            RecordBatch::new_empty(Arc::new(Schema::new(fields)))
        } else if batches.len() == 1 {
            batches[0].clone()
        } else {
            let schema = batches[0].schema();
            arrow::compute::concat_batches(&schema, &batches)?
        }
    };

    if thisrow_cols.is_empty() {
        return Ok(result);
    }
    materialize_thisrow_columns(&result, &thisrow_cols, udfs).await
}

/// Materialize THISROW calculated columns onto `batch` via a self-join:
///
/// ```sql
/// SELECT t.*, <outer expr with __tr_agg_N placeholders> AS "Name", ...
/// FROM t
/// LEFT JOIN (
///     SELECT __anchor."__tr_rid" AS "__tr_rid",
///            AGG(<iterated expr; refs -> __scan, THISROW -> __anchor>) AS "__tr_agg_N", ...
///     FROM t AS __anchor CROSS JOIN t AS __scan
///     GROUP BY __anchor."__tr_rid"
/// ) AS __tr ON __tr."__tr_rid" = t."__tr_rid"
/// ORDER BY t."__tr_rid"
/// ```
///
/// `__tr_rid` is a synthetic per-row id appended (and afterwards dropped) so
/// the per-anchor aggregates join back to their rows and the original row
/// order is preserved. Inherently O(N^2) over the host table — the THISROW
/// contract (documented) targets dimension-sized tables.
async fn materialize_thisrow_columns(
    batch: &RecordBatch,
    cols: &[CalculatedColumn],
    udfs: &UdfRegistry,
) -> EngineResult<RecordBatch> {
    use crate::compute::expression::{
        extract_thisrow_aggregates, DataFusionDialect, SqlRenderer, TableAliasQualifier,
    };

    // 1. Append the synthetic row id.
    let n = batch.num_rows();
    let mut fields: Vec<Field> = batch
        .schema()
        .fields()
        .iter()
        .map(|f| f.as_ref().clone())
        .collect();
    fields.push(Field::new("__tr_rid", DataType::Int64, false));
    let mut columns = batch.columns().to_vec();
    columns.push(Arc::new(arrow::array::Int64Array::from_iter_values(
        0..n as i64,
    )));
    let with_rid = RecordBatch::try_new(Arc::new(Schema::new(fields)), columns)?;

    let ctx = session_context_with_udfs(udfs);
    ctx.register_batch("t", with_rid)?;

    // 2. Extract each column's aggregates (globally numbered placeholders)
    //    and render: aggregate internals against the __scan alias with
    //    THISROW against __anchor; the outer expression bare (placeholders
    //    resolve to the joined sub-select, everything else to t).
    // Rendering is scoped so the non-Send renderer (borrowing a dyn
    // qualifier) is dropped before the first await.
    let (outer_selects, agg_selects) = {
        let scan_qualifier = TableAliasQualifier { alias: "__scan" };
        let agg_renderer =
            SqlRenderer::new(DataFusionDialect, &scan_qualifier).with_thisrow_alias("__anchor");
        let mut all_aggs: Vec<Expression> = Vec::new();
        let mut outer_selects: Vec<String> = Vec::new();
        for cc in cols {
            let outer = extract_thisrow_aggregates(cc.expression(), &mut all_aggs);
            let outer_sql = outer.to_sql_string()?;
            outer_selects.push(format!("{outer_sql} AS {}", quote_ident_double(cc.name())));
        }
        let mut agg_selects: Vec<String> = Vec::new();
        for (i, agg) in all_aggs.iter().enumerate() {
            let agg_sql = agg_renderer.render(agg)?;
            agg_selects.push(format!("{agg_sql} AS \"__tr_agg_{i}\""));
        }
        (outer_selects, agg_selects)
    };

    let sql = format!(
        "SELECT t.*, {outer} FROM t LEFT JOIN (\
         SELECT __anchor.\"__tr_rid\" AS \"__tr_rid\", {aggs} \
         FROM t AS __anchor CROSS JOIN t AS __scan \
         GROUP BY __anchor.\"__tr_rid\") AS __tr \
         ON __tr.\"__tr_rid\" = t.\"__tr_rid\" ORDER BY t.\"__tr_rid\"",
        outer = outer_selects.join(", "),
        aggs = agg_selects.join(", "),
    );
    let df = ctx.sql(&sql).await?;
    let batches = df.collect().await?;

    // 3. Drop the synthetic row id from the result.
    let strip_rid = |b: &RecordBatch| -> EngineResult<RecordBatch> {
        let schema = b.schema();
        let keep: Vec<usize> = (0..schema.fields().len())
            .filter(|&i| schema.field(i).name() != "__tr_rid")
            .collect();
        Ok(b.project(&keep)?)
    };

    if batches.is_empty() {
        let mut fields: Vec<Field> = batch
            .schema()
            .fields()
            .iter()
            .map(|f| f.as_ref().clone())
            .collect();
        for cc in cols {
            fields.push(Field::new(cc.name(), cc.data_type().to_arrow(), true));
        }
        return Ok(RecordBatch::new_empty(Arc::new(Schema::new(fields))));
    }
    if batches.len() == 1 {
        strip_rid(&batches[0])
    } else {
        let schema = batches[0].schema();
        let combined = arrow::compute::concat_batches(&schema, &batches)?;
        strip_rid(&combined)
    }
}

/// Maximum parent-chain depth for `PATH(...)` — beyond this, treat as a cycle.
const MAX_PATH_DEPTH: usize = 512;

/// Compute a `PATH(id, parent)` column over a batch: for each row, the
/// `|`-separated root-first chain of ids from the root ancestor down to the
/// row itself. NULL parent = root; a parent id with no matching row ends the
/// chain (treated as the root's parent); a cycle or a chain deeper than
/// [`MAX_PATH_DEPTH`] is an error. Ids render via their string form.
fn compute_path_column(
    batch: &RecordBatch,
    id_column: &str,
    parent_column: &str,
) -> Result<arrow::array::StringArray, String> {
    use datafusion::common::ScalarValue;

    let id_idx = batch
        .schema()
        .index_of(id_column)
        .map_err(|_| format!("PATH id column '{id_column}' not found"))?;
    let parent_idx = batch
        .schema()
        .index_of(parent_column)
        .map_err(|_| format!("PATH parent column '{parent_column}' not found"))?;
    let id_arr = batch.column(id_idx);
    let parent_arr = batch.column(parent_idx);

    let scalar_key = |arr: &std::sync::Arc<dyn arrow::array::Array>,
                      row: usize|
     -> Result<Option<String>, String> {
        let mut sv = ScalarValue::try_from_array(arr, row).map_err(|e| e.to_string())?;
        if let ScalarValue::Dictionary(_, inner) = sv {
            sv = *inner;
        }
        if sv.is_null() {
            return Ok(None);
        }
        Ok(Some(match sv {
            ScalarValue::Utf8(Some(s)) | ScalarValue::LargeUtf8(Some(s)) => s,
            ScalarValue::Int8(Some(v)) => v.to_string(),
            ScalarValue::Int16(Some(v)) => v.to_string(),
            ScalarValue::Int32(Some(v)) => v.to_string(),
            ScalarValue::Int64(Some(v)) => v.to_string(),
            ScalarValue::UInt32(Some(v)) => v.to_string(),
            ScalarValue::UInt64(Some(v)) => v.to_string(),
            other => {
                return Err(format!(
                    "PATH id/parent columns must be integer or text (got {:?})",
                    other.data_type()
                ));
            }
        }))
    };

    // id -> parent map over the whole table.
    let mut parent_of: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    for row in 0..batch.num_rows() {
        if let Some(id) = scalar_key(id_arr, row)? {
            parent_of.insert(id, scalar_key(parent_arr, row)?);
        }
    }

    let mut out: Vec<Option<String>> = Vec::with_capacity(batch.num_rows());
    for row in 0..batch.num_rows() {
        let Some(id) = scalar_key(id_arr, row)? else {
            out.push(None);
            continue;
        };
        let mut chain = vec![id.clone()];
        let mut current = id.clone();
        loop {
            let Some(Some(parent)) = parent_of.get(&current) else {
                break; // root (NULL parent) or dangling parent id
            };
            if chain.len() >= MAX_PATH_DEPTH || chain.contains(parent) {
                return Err(format!(
                    "PATH cycle or chain deeper than {MAX_PATH_DEPTH} at id '{id}'"
                ));
            }
            chain.push(parent.clone());
            current = parent.clone();
        }
        chain.reverse();
        out.push(Some(chain.join("|")));
    }
    Ok(arrow::array::StringArray::from(out))
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

    /// `double(x) = x * 2` over Float64, registered as "double".
    fn registry_with_double() -> UdfRegistry {
        use crate::compute::udf::{create_udf, ColumnarValue, Volatility};
        use arrow::array::Float64Array;

        let double = create_udf(
            "double",
            vec![DataType::Float64],
            DataType::Float64,
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
        );
        let mut registry = UdfRegistry::new();
        registry.register(double, 1).unwrap();
        registry
    }

    #[tokio::test]
    async fn evaluate_expression_with_udfs_resolves_call() {
        let batch = sales_data();
        let expression = expr::call("double", vec![expr::col("price")]);
        let result = evaluate_expression_with_udfs(&batch, &expression, &registry_with_double())
            .await
            .unwrap();

        let values: Vec<f64> = result
            .as_any()
            .downcast_ref::<arrow::array::Float64Array>()
            .unwrap()
            .values()
            .to_vec();
        assert_eq!(values, vec![20.0, 40.0, 30.0]);
    }

    #[tokio::test]
    async fn evaluate_expression_without_udfs_fails_on_call() {
        let batch = sales_data();
        let expression = expr::call("double", vec![expr::col("price")]);
        assert!(evaluate_expression(&batch, &expression).await.is_err());
    }

    #[tokio::test]
    async fn materialize_calculated_columns_with_udfs_resolves_call() {
        let batch = sales_data();
        let cc = CalculatedColumn::new(
            "double_price",
            "Sales",
            expr::call("double", vec![expr::col("price")]),
            EngineDataType::Float64,
        );

        let result =
            materialize_calculated_columns_with_udfs(&batch, &[cc], &registry_with_double())
                .await
                .unwrap();

        assert_eq!(result.num_columns(), 4);
        assert_eq!(result.schema().field(3).name(), "double_price");
        let values: Vec<f64> = result
            .column(3)
            .as_any()
            .downcast_ref::<arrow::array::Float64Array>()
            .unwrap()
            .values()
            .to_vec();
        assert_eq!(values, vec![20.0, 40.0, 30.0]);
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
