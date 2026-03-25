//! Relationship traversal: joining tables and cross-table aggregation via DataFusion.

use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::functions_aggregate::count::{count, count_distinct};
use datafusion::functions_aggregate::min_max::{max, min};
use datafusion::functions_aggregate::sum::sum;
use datafusion::logical_expr::col;
use datafusion::prelude::{DataFrame, JoinType as DfJoinType, SessionContext};

use crate::compute::aggregate::AggregateOp;
use crate::error::EngineResult;
use crate::model::relationship::Relationship;
use crate::store::TableData;

/// The type of join to perform when traversing a relationship.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinType {
    /// Inner join: only rows with matches on both sides.
    Inner,
    /// Left join: all rows from the "from" table, nulls for non-matching "to" rows.
    Left,
}

/// Join two tables following a relationship, producing a combined `RecordBatch`.
///
/// The `from_data` corresponds to `relationship.from_table()` and `to_data`
/// corresponds to `relationship.to_table()`.
pub async fn join_tables(
    from_data: &TableData,
    to_data: &TableData,
    relationship: &Relationship,
    join_type: JoinType,
) -> EngineResult<RecordBatch> {
    let (_ctx, joined_df) =
        build_joined_dataframe(from_data, to_data, relationship, join_type).await?;

    let batches = joined_df.collect().await?;

    if batches.is_empty() {
        let schema = from_data.to_record_batch()?.schema();
        return Ok(RecordBatch::new_empty(schema));
    }

    let schema = batches[0].schema();
    let combined = concat_batches(&schema, &batches)?;
    Ok(combined)
}

/// Aggregate a fact table column grouped by a dimension table column,
/// traversing a relationship.
///
/// This is the quintessential star-schema query, e.g.:
/// `SUM(Sales.amount) GROUP BY Products.category`
///
/// Returns a `RecordBatch` with the group column and the aggregate result column.
pub async fn aggregate_over_relationship(
    fact_data: &TableData,
    dimension_data: &TableData,
    relationship: &Relationship,
    aggregate_column: &str,
    operation: AggregateOp,
    group_by_column: &str,
) -> EngineResult<RecordBatch> {
    // Validate columns exist on the correct tables.
    fact_data.table().column(aggregate_column)?;
    dimension_data.table().column(group_by_column)?;

    let (_ctx, joined_df) =
        build_joined_dataframe(fact_data, dimension_data, relationship, JoinType::Inner).await?;

    // The dimension table is registered as "to_t", so qualify the group-by
    // column to avoid ambiguity when both tables share column names.
    let group_expr = col(format!("to_t.{group_by_column}").as_str());

    let agg_expr = match operation {
        AggregateOp::Sum => sum(col(aggregate_column)),
        AggregateOp::Count => count(col(aggregate_column)),
        AggregateOp::Min => min(col(aggregate_column)),
        AggregateOp::Max => max(col(aggregate_column)),
        AggregateOp::DistinctCount => count_distinct(col(aggregate_column)),
        AggregateOp::CountRows => {
            use datafusion::prelude::lit as df_lit;
            count(df_lit(1))
        }
        AggregateOp::Average => {
            // Use sum/count for average to ensure Float64 output,
            // matching the approach in aggregate.rs.
            return aggregate_average_over_relationship(
                fact_data,
                dimension_data,
                relationship,
                aggregate_column,
                group_by_column,
            )
            .await;
        }
    };

    let result_df = joined_df.aggregate(vec![group_expr], vec![agg_expr])?;
    let batches = result_df.collect().await?;

    collect_batches(batches)
}

/// Compute average over relationship as sum/count per group.
async fn aggregate_average_over_relationship(
    fact_data: &TableData,
    dimension_data: &TableData,
    relationship: &Relationship,
    aggregate_column: &str,
    group_by_column: &str,
) -> EngineResult<RecordBatch> {
    let (_ctx, joined_df) =
        build_joined_dataframe(fact_data, dimension_data, relationship, JoinType::Inner).await?;

    let group_expr = col(format!("to_t.{group_by_column}").as_str());

    let result_df = joined_df.aggregate(
        vec![group_expr],
        vec![sum(col(aggregate_column)), count(col(aggregate_column))],
    )?;

    // Compute average from sum/count per row.
    let batches = result_df.collect().await?;
    let batch = collect_batches(batches)?;

    // Build average column from sum and count columns.
    use arrow::array::Float64Array;
    use arrow::datatypes::{DataType, Field, Schema};
    use std::sync::Arc;

    let group_col = batch.column(0).clone();
    let sum_col = batch.column(1);
    let count_col = batch.column(2);

    let sum_f64: Vec<Option<f64>> = (0..batch.num_rows())
        .map(|i| {
            let s = datafusion::common::ScalarValue::try_from_array(sum_col, i).ok()?;
            match s {
                datafusion::common::ScalarValue::Float64(v) => v,
                datafusion::common::ScalarValue::Int32(v) => v.map(|n| n as f64),
                datafusion::common::ScalarValue::Int64(v) => v.map(|n| n as f64),
                _ => None,
            }
        })
        .collect();

    let count_i64: Vec<Option<i64>> = (0..batch.num_rows())
        .map(|i| {
            let s = datafusion::common::ScalarValue::try_from_array(count_col, i).ok()?;
            match s {
                datafusion::common::ScalarValue::Int64(v) => v,
                datafusion::common::ScalarValue::UInt64(v) => v.map(|n| n as i64),
                _ => None,
            }
        })
        .collect();

    let avg_values: Vec<Option<f64>> = sum_f64
        .iter()
        .zip(count_i64.iter())
        .map(|(s, c)| match (s, c) {
            (Some(s_val), Some(c_val)) if *c_val > 0 => Some(s_val / *c_val as f64),
            _ => None,
        })
        .collect();

    let avg_array = Float64Array::from(avg_values);

    let group_field = batch.schema().field(0).clone();
    let avg_field = Field::new(format!("AVG({aggregate_column})"), DataType::Float64, true);
    let schema = Arc::new(Schema::new(vec![group_field, avg_field]));

    let result = RecordBatch::try_new(schema, vec![group_col, Arc::new(avg_array)])?;
    Ok(result)
}

/// Register both tables in a DataFusion context and join them.
async fn build_joined_dataframe(
    from_data: &TableData,
    to_data: &TableData,
    relationship: &Relationship,
    join_type: JoinType,
) -> EngineResult<(SessionContext, DataFrame)> {
    let from_batch = from_data.to_record_batch()?;
    let to_batch = to_data.to_record_batch()?;

    let ctx = SessionContext::new();
    ctx.register_batch("from_t", from_batch)?;
    ctx.register_batch("to_t", to_batch)?;

    let from_df = ctx.table("from_t").await?;
    let to_df = ctx.table("to_t").await?;

    let df_join_type = match join_type {
        JoinType::Inner => DfJoinType::Inner,
        JoinType::Left => DfJoinType::Left,
    };

    let joined = from_df.join(
        to_df,
        df_join_type,
        &[relationship.from_column()],
        &[relationship.to_column()],
        None,
    )?;

    Ok((ctx, joined))
}

/// Concatenate result batches into a single RecordBatch.
fn collect_batches(batches: Vec<RecordBatch>) -> EngineResult<RecordBatch> {
    if batches.is_empty() {
        // Return an empty batch — caller should handle schema if needed.
        return Ok(RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
            arrow::datatypes::Schema::empty(),
        )));
    }
    let schema = batches[0].schema();
    let combined = concat_batches(&schema, &batches)?;
    Ok(combined)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::column::Column;
    use crate::model::table::Table;
    use crate::types::{DataType, Value};

    fn sales_table() -> Table {
        Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap()
    }

    fn products_table() -> Table {
        Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("name", DataType::String),
                Column::new("category", DataType::String),
            ],
        )
        .unwrap()
    }

    fn sales_products_relationship() -> Relationship {
        Relationship::many_to_one("Sales_Products", "Sales", "product_id", "Products", "id")
    }

    fn populated_sales() -> TableData {
        let mut data = TableData::new(sales_table());
        data.insert_rows(vec![
            vec![Value::Int64(1), Value::Int64(101), Value::Float64(10.0)],
            vec![Value::Int64(2), Value::Int64(102), Value::Float64(20.0)],
            vec![Value::Int64(3), Value::Int64(101), Value::Float64(30.0)],
            vec![Value::Int64(4), Value::Int64(103), Value::Float64(15.0)],
        ])
        .unwrap();
        data
    }

    fn populated_products() -> TableData {
        let mut data = TableData::new(products_table());
        data.insert_rows(vec![
            vec![
                Value::Int64(101),
                Value::String("Widget".into()),
                Value::String("A".into()),
            ],
            vec![
                Value::Int64(102),
                Value::String("Gadget".into()),
                Value::String("B".into()),
            ],
            vec![
                Value::Int64(103),
                Value::String("Doohickey".into()),
                Value::String("A".into()),
            ],
        ])
        .unwrap();
        data
    }

    #[tokio::test]
    async fn inner_join_produces_correct_batch() {
        let sales = populated_sales();
        let products = populated_products();
        let rel = sales_products_relationship();

        let result = join_tables(&sales, &products, &rel, JoinType::Inner)
            .await
            .unwrap();

        // All 4 sales rows match a product.
        assert_eq!(result.num_rows(), 4);
        // Columns from both tables: id, product_id, amount, id, name, category
        assert!(result.num_columns() >= 5);
    }

    #[tokio::test]
    async fn left_join_retains_all_from_rows() {
        let mut sales = TableData::new(sales_table());
        sales
            .insert_rows(vec![
                vec![Value::Int64(1), Value::Int64(101), Value::Float64(10.0)],
                vec![Value::Int64(2), Value::Int64(999), Value::Float64(20.0)], // No matching product
            ])
            .unwrap();

        let products = populated_products();
        let rel = sales_products_relationship();

        let result = join_tables(&sales, &products, &rel, JoinType::Left)
            .await
            .unwrap();

        // Left join keeps both sales rows.
        assert_eq!(result.num_rows(), 2);
    }

    #[tokio::test]
    async fn join_with_no_matches_returns_empty() {
        let mut sales = TableData::new(sales_table());
        sales
            .insert_rows(vec![vec![
                Value::Int64(1),
                Value::Int64(999),
                Value::Float64(10.0),
            ]])
            .unwrap();

        let products = populated_products();
        let rel = sales_products_relationship();

        let result = join_tables(&sales, &products, &rel, JoinType::Inner)
            .await
            .unwrap();

        assert_eq!(result.num_rows(), 0);
    }

    #[tokio::test]
    async fn join_with_duplicate_keys() {
        // Two sales rows map to product 101.
        let sales = populated_sales();
        let products = populated_products();
        let rel = sales_products_relationship();

        let result = join_tables(&sales, &products, &rel, JoinType::Inner)
            .await
            .unwrap();

        // Sales: id=1→101, id=2→102, id=3→101, id=4→103 → 4 rows.
        assert_eq!(result.num_rows(), 4);
    }

    #[tokio::test]
    async fn aggregate_sum_grouped_by_dimension() {
        let sales = populated_sales();
        let products = populated_products();
        let rel = sales_products_relationship();

        let result = aggregate_over_relationship(
            &sales,
            &products,
            &rel,
            "amount",
            AggregateOp::Sum,
            "category",
        )
        .await
        .unwrap();

        // Category A: 10 + 30 + 15 = 55, Category B: 20
        assert_eq!(result.num_rows(), 2);
        assert_eq!(result.num_columns(), 2);

        // Extract and verify values.
        let categories: Vec<&str> = (0..result.num_rows())
            .map(|i| {
                result
                    .column(0)
                    .as_any()
                    .downcast_ref::<arrow::array::StringArray>()
                    .unwrap()
                    .value(i)
            })
            .collect();
        let amounts: Vec<f64> = (0..result.num_rows())
            .map(|i| {
                result
                    .column(1)
                    .as_any()
                    .downcast_ref::<arrow::array::Float64Array>()
                    .unwrap()
                    .value(i)
            })
            .collect();

        for (cat, amt) in categories.iter().zip(amounts.iter()) {
            match *cat {
                "A" => assert!((amt - 55.0).abs() < f64::EPSILON),
                "B" => assert!((amt - 20.0).abs() < f64::EPSILON),
                other => panic!("Unexpected category: {other}"),
            }
        }
    }

    #[tokio::test]
    async fn aggregate_count_over_relationship() {
        let sales = populated_sales();
        let products = populated_products();
        let rel = sales_products_relationship();

        let result = aggregate_over_relationship(
            &sales,
            &products,
            &rel,
            "amount",
            AggregateOp::Count,
            "category",
        )
        .await
        .unwrap();

        assert_eq!(result.num_rows(), 2);
    }

    #[tokio::test]
    async fn aggregate_with_nulls() {
        let mut sales = TableData::new(sales_table());
        sales
            .insert_rows(vec![
                vec![Value::Int64(1), Value::Int64(101), Value::Float64(10.0)],
                vec![Value::Int64(2), Value::Int64(101), Value::Null],
                vec![Value::Int64(3), Value::Int64(102), Value::Float64(30.0)],
            ])
            .unwrap();

        let products = populated_products();
        let rel = sales_products_relationship();

        let result = aggregate_over_relationship(
            &sales,
            &products,
            &rel,
            "amount",
            AggregateOp::Sum,
            "category",
        )
        .await
        .unwrap();

        // Category A: 10 (null skipped), Category B: 30
        assert_eq!(result.num_rows(), 2);
    }

    #[tokio::test]
    async fn aggregate_invalid_column_returns_error() {
        let sales = populated_sales();
        let products = populated_products();
        let rel = sales_products_relationship();

        // Invalid aggregate column.
        let result = aggregate_over_relationship(
            &sales,
            &products,
            &rel,
            "nonexistent",
            AggregateOp::Sum,
            "category",
        )
        .await;
        assert!(result.is_err());

        // Invalid group column.
        let result = aggregate_over_relationship(
            &sales,
            &products,
            &rel,
            "amount",
            AggregateOp::Sum,
            "nonexistent",
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn aggregate_average_over_relationship() {
        let sales = populated_sales();
        let products = populated_products();
        let rel = sales_products_relationship();

        let result = aggregate_over_relationship(
            &sales,
            &products,
            &rel,
            "amount",
            AggregateOp::Average,
            "category",
        )
        .await
        .unwrap();

        // Category A: (10+30+15)/3 ≈ 18.33, Category B: 20/1 = 20
        assert_eq!(result.num_rows(), 2);

        let categories: Vec<&str> = (0..result.num_rows())
            .map(|i| {
                result
                    .column(0)
                    .as_any()
                    .downcast_ref::<arrow::array::StringArray>()
                    .unwrap()
                    .value(i)
            })
            .collect();
        let avgs: Vec<f64> = (0..result.num_rows())
            .map(|i| {
                result
                    .column(1)
                    .as_any()
                    .downcast_ref::<arrow::array::Float64Array>()
                    .unwrap()
                    .value(i)
            })
            .collect();

        for (cat, avg) in categories.iter().zip(avgs.iter()) {
            match *cat {
                "A" => assert!((avg - 55.0 / 3.0).abs() < 0.01),
                "B" => assert!((avg - 20.0).abs() < f64::EPSILON),
                other => panic!("Unexpected category: {other}"),
            }
        }
    }
}
