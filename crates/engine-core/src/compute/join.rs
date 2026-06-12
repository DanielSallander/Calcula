//! Relationship traversal: joining tables and cross-table aggregation via DataFusion.

use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::functions_aggregate::count::{count, count_distinct};
use datafusion::functions_aggregate::min_max::{max, min};
use datafusion::functions_aggregate::sum::sum;
use datafusion::logical_expr::col;
use datafusion::prelude::{DataFrame, JoinType as DfJoinType, SessionContext};

use crate::compute::aggregate::AggregateOp;
use crate::compute::sql_util::quote_ident_double;
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

/// Strategy for how a relationship should be materialized in SQL queries.
///
/// Different relationship cardinalities and query needs require different SQL
/// patterns to avoid row explosion (duplicate fact rows inflating aggregation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinStrategy {
    /// Standard INNER JOIN. Safe when the relationship guarantees no row
    /// explosion from the fact side (ManyToOne or OneToOne with equi-join).
    DirectJoin,
    /// Semi-join via `EXISTS` subquery. Used for filter propagation from a
    /// dimension to a fact table without retrieving dimension columns. Works
    /// for all cardinalities without duplicating fact rows.
    SemiJoin,
    /// Two-stage approach: pre-aggregate the fact table by join key columns,
    /// then join the pre-aggregated result to the dimension. Used when GROUP BY
    /// references columns from a ManyToMany or non-equi dimension table.
    PreAggregateJoin,
}

/// Determine the join strategy for a relationship given the query's needs.
///
/// - If the dimension's columns are **not** needed in GROUP BY (filter-only),
///   a [`SemiJoin`](JoinStrategy::SemiJoin) is used for unsafe relationships
///   to avoid row explosion, while safe relationships use [`DirectJoin`](JoinStrategy::DirectJoin).
/// - If the dimension's columns **are** needed in GROUP BY and the relationship
///   is safe ([`is_safe_for_direct_join`](Relationship::is_safe_for_direct_join)),
///   a [`DirectJoin`](JoinStrategy::DirectJoin) is used.
/// - Otherwise (GROUP BY needed + unsafe relationship), a
///   [`PreAggregateJoin`](JoinStrategy::PreAggregateJoin) is used.
pub fn determine_join_strategy(
    relationship: &Relationship,
    needs_group_by_columns: bool,
) -> JoinStrategy {
    if !needs_group_by_columns {
        if relationship.is_safe_for_direct_join() {
            // ManyToOne equi-join: direct JOIN is correct even for filter-only.
            JoinStrategy::DirectJoin
        } else {
            JoinStrategy::SemiJoin
        }
    } else if relationship.is_safe_for_direct_join() {
        JoinStrategy::DirectJoin
    } else {
        JoinStrategy::PreAggregateJoin
    }
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

    // For unsafe relationships (ManyToMany, non-equi), use two-stage
    // pre-aggregation to avoid row explosion.
    if !relationship.is_safe_for_direct_join() {
        return aggregate_over_relationship_pre_agg(
            fact_data,
            dimension_data,
            relationship,
            aggregate_column,
            operation,
            group_by_column,
        )
        .await;
    }

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
        // Statistical aggregates: use DataFusion built-in functions.
        AggregateOp::Median => {
            use datafusion::functions_aggregate::median::median;
            median(col(aggregate_column))
        }
        AggregateOp::StdevSample => {
            use datafusion::functions_aggregate::stddev::stddev;
            stddev(col(aggregate_column))
        }
        AggregateOp::StdevPop => {
            use datafusion::functions_aggregate::stddev::stddev;
            stddev(col(aggregate_column)) // approximate — sample stddev
        }
        AggregateOp::VarSample => {
            use datafusion::functions_aggregate::variance::var_sample;
            var_sample(col(aggregate_column))
        }
        AggregateOp::VarPop => {
            use datafusion::functions_aggregate::variance::var_sample;
            var_sample(col(aggregate_column)) // approximate — sample variance
        }
        AggregateOp::AnyValue => min(col(aggregate_column)),
        AggregateOp::Mode => min(col(aggregate_column)), // approximate
    };

    let result_df = joined_df.aggregate(vec![group_expr], vec![agg_expr])?;
    let batches = result_df.collect().await?;

    collect_batches(batches)
}

/// Boundary-based aggregation for unsafe (ManyToMany/non-equi) relationships.
///
/// Computes boundary values (MAX/MIN) per group from the dimension,
/// then CROSS JOINs fact with boundaries and filters by the boundary condition.
async fn aggregate_over_relationship_pre_agg(
    fact_data: &TableData,
    dimension_data: &TableData,
    relationship: &Relationship,
    aggregate_column: &str,
    operation: AggregateOp,
    group_by_column: &str,
) -> EngineResult<RecordBatch> {
    let from_batch = fact_data.to_record_batch()?;
    let to_batch = dimension_data.to_record_batch()?;

    let ctx = SessionContext::new();
    ctx.register_batch("from_t", from_batch)?;
    ctx.register_batch("to_t", to_batch)?;

    // Step 1: Compute boundary values per group from dimension.
    let group_by_quoted = quote_ident_double(group_by_column);
    let mut bounds_select = vec![format!("to_t.{group_by_quoted}")];
    let mut where_conditions: Vec<String> = Vec::new();

    for (ci, cond) in relationship.conditions().iter().enumerate() {
        let dim_col = quote_ident_double(cond.to_column());
        let fact_col = quote_ident_double(cond.from_column());
        let boundary_agg = cond.operator().boundary_aggregate();
        // Internal alias generated here — not model-derived, safe to embed.
        let boundary_alias = format!("__b_{ci}");

        bounds_select.push(format!(
            "{boundary_agg}(to_t.{dim_col}) AS \"{boundary_alias}\""
        ));

        let op = cond.operator().as_sql();
        where_conditions.push(format!(
            "from_t.{fact_col} {op} __bounds.\"{boundary_alias}\""
        ));
    }

    let bounds_sql = format!(
        "SELECT {} FROM to_t GROUP BY to_t.{group_by_quoted}",
        bounds_select.join(", ")
    );

    let bounds_df = ctx.sql(&bounds_sql).await?;
    let bounds_batches = bounds_df.collect().await?;
    let bounds_result = collect_batches(bounds_batches)?;
    ctx.register_batch("__bounds", bounds_result)?;

    // Step 2: CROSS JOIN fact × bounds, filter by boundary.
    let agg_col_quoted = quote_ident_double(aggregate_column);
    let agg_sql = match operation {
        AggregateOp::Sum => format!("SUM(from_t.{agg_col_quoted})"),
        AggregateOp::Count => format!("COUNT(from_t.{agg_col_quoted})"),
        AggregateOp::CountRows => "COUNT(*)".to_string(),
        AggregateOp::Min => format!("MIN(from_t.{agg_col_quoted})"),
        AggregateOp::Max => format!("MAX(from_t.{agg_col_quoted})"),
        AggregateOp::Average => format!("AVG(from_t.{agg_col_quoted})"),
        AggregateOp::DistinctCount => {
            format!("COUNT(DISTINCT from_t.{agg_col_quoted})")
        }
        _ => format!("{operation}(from_t.{agg_col_quoted})"),
    };

    let main_sql = format!(
        "SELECT __bounds.{group_by_quoted}, {agg_sql} AS {agg_alias} FROM from_t CROSS JOIN __bounds WHERE {} GROUP BY __bounds.{group_by_quoted}",
        where_conditions.join(" AND "),
        agg_alias = quote_ident_double(&format!("{operation}({aggregate_column})"))
    );

    let main_df = ctx.sql(&main_sql).await?;
    let main_batches = main_df.collect().await?;
    collect_batches(main_batches)
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

    if relationship.is_equi_only() {
        // Fast path: use DataFusion's native equi-join API.
        let from_df = ctx.table("from_t").await?;
        let to_df = ctx.table("to_t").await?;
        let df_join_type = match join_type {
            JoinType::Inner => DfJoinType::Inner,
            JoinType::Left => DfJoinType::Left,
        };
        let from_cols: Vec<&str> = relationship
            .conditions()
            .iter()
            .map(|c| c.from_column())
            .collect();
        let to_cols: Vec<&str> = relationship
            .conditions()
            .iter()
            .map(|c| c.to_column())
            .collect();
        let joined = from_df.join(to_df, df_join_type, &from_cols, &to_cols, None)?;
        Ok((ctx, joined))
    } else {
        // Non-equi path: build SQL with the full ON clause.
        let join_keyword = match join_type {
            JoinType::Inner => "INNER",
            JoinType::Left => "LEFT",
        };
        let on_clause = relationship.build_on_clause("from_t", "to_t", true);
        let sql = format!("SELECT * FROM from_t {join_keyword} JOIN to_t ON {on_clause}");
        let joined = ctx.sql(&sql).await?;
        Ok((ctx, joined))
    }
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

    // --- Non-equi join tests ---

    use crate::model::relationship::{JoinCondition, JoinOperator};

    /// Create a "Periods" table with start_date and end_date (Int64 for simplicity).
    fn periods_table() -> Table {
        Table::new(
            "Periods",
            vec![
                Column::new("period", DataType::String),
                Column::new("start_id", DataType::Int64),
                Column::new("end_id", DataType::Int64),
            ],
        )
        .unwrap()
    }

    fn populated_periods() -> TableData {
        let mut data = TableData::new(periods_table());
        data.insert_rows(vec![
            // Period "P1" covers product IDs 101..=102
            vec![
                Value::String("P1".into()),
                Value::Int64(101),
                Value::Int64(102),
            ],
            // Period "P2" covers product IDs 102..=103
            vec![
                Value::String("P2".into()),
                Value::Int64(102),
                Value::Int64(103),
            ],
        ])
        .unwrap();
        data
    }

    #[tokio::test]
    async fn non_equi_between_join() {
        let sales = populated_sales();
        let periods = populated_periods();

        // Sales.product_id BETWEEN Periods.start_id AND Periods.end_id
        let rel = Relationship::many_to_many(
            "Sales_Periods",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("product_id", "start_id", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("product_id", "end_id", JoinOperator::LessThanOrEqual),
            ],
        );

        let result = join_tables(&sales, &periods, &rel, JoinType::Inner)
            .await
            .unwrap();

        // Sales rows: pid=101, pid=102, pid=101, pid=103
        // P1 covers 101..=102 → matches pid=101(×2), pid=102(×1) → 3 rows
        // P2 covers 102..=103 → matches pid=102(×1), pid=103(×1) → 2 rows
        // Total: 5 rows
        assert_eq!(result.num_rows(), 5);
    }

    #[tokio::test]
    async fn non_equi_left_join() {
        // One sale with product_id=999 won't match any period.
        let mut sales = TableData::new(sales_table());
        sales
            .insert_rows(vec![
                vec![Value::Int64(1), Value::Int64(101), Value::Float64(10.0)],
                vec![Value::Int64(2), Value::Int64(999), Value::Float64(20.0)],
            ])
            .unwrap();

        let periods = populated_periods();

        let rel = Relationship::many_to_many(
            "Sales_Periods",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("product_id", "start_id", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("product_id", "end_id", JoinOperator::LessThanOrEqual),
            ],
        );

        let result = join_tables(&sales, &periods, &rel, JoinType::Left)
            .await
            .unwrap();

        // pid=101 matches P1 → 1 row
        // pid=999 matches nothing → 1 row (nulls for period cols)
        // Total: 2 rows
        assert_eq!(result.num_rows(), 2);
    }

    // --- determine_join_strategy tests ---

    #[test]
    fn strategy_direct_join_for_many_to_one_equi_with_group_by() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id");
        assert_eq!(
            determine_join_strategy(&rel, true),
            JoinStrategy::DirectJoin
        );
    }

    #[test]
    fn strategy_direct_join_for_many_to_one_equi_filter_only() {
        let rel = Relationship::many_to_one("R", "Sales", "pid", "Products", "id");
        assert_eq!(
            determine_join_strategy(&rel, false),
            JoinStrategy::DirectJoin
        );
    }

    #[test]
    fn strategy_semi_join_for_many_to_many_filter_only() {
        let rel = Relationship::many_to_many(
            "R",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("date", "start", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("date", "end", JoinOperator::LessThanOrEqual),
            ],
        );
        assert_eq!(determine_join_strategy(&rel, false), JoinStrategy::SemiJoin);
    }

    #[test]
    fn strategy_pre_aggregate_for_many_to_many_with_group_by() {
        let rel = Relationship::many_to_many(
            "R",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("date", "start", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("date", "end", JoinOperator::LessThanOrEqual),
            ],
        );
        assert_eq!(
            determine_join_strategy(&rel, true),
            JoinStrategy::PreAggregateJoin
        );
    }

    #[test]
    fn strategy_semi_join_for_many_to_many_equi_filter_only() {
        // ManyToMany even with equi-join is not safe for direct join.
        let rel = Relationship::many_to_many("R", "A", "B", vec![JoinCondition::equal("x", "y")]);
        assert_eq!(determine_join_strategy(&rel, false), JoinStrategy::SemiJoin);
    }

    #[test]
    fn strategy_pre_aggregate_for_one_to_many_with_group_by() {
        use crate::model::relationship::Cardinality;
        let rel = Relationship::new("R", "A", "x", "B", "y", Cardinality::OneToMany);
        assert_eq!(
            determine_join_strategy(&rel, true),
            JoinStrategy::PreAggregateJoin
        );
    }

    // --- Pre-aggregate join correctness tests ---

    /// Test that SUM over a non-equi (BETWEEN) relationship gives correct values.
    ///
    /// Without pre-aggregation, the direct JOIN would duplicate fact rows:
    /// - pid=101 (amount=10) matches P1 → counted once for P1
    /// - pid=102 (amount=20) matches P1 AND P2 → counted TWICE if direct JOIN
    /// - pid=101 (amount=30) matches P1 → counted once for P1
    /// - pid=103 (amount=15) matches P2 → counted once for P2
    ///
    /// With pre-aggregation:
    /// Stage 1 groups by product_id: {101→40, 102→20, 103→15}
    /// Stage 2 joins to periods and re-aggregates:
    ///   P1 (101..=102): SUM(40, 20) = 60
    ///   P2 (102..=103): SUM(20, 15) = 35
    #[tokio::test]
    async fn pre_aggregate_sum_over_non_equi_join() {
        let sales = populated_sales();
        let periods = populated_periods();

        let rel = Relationship::many_to_many(
            "Sales_Periods",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("product_id", "start_id", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("product_id", "end_id", JoinOperator::LessThanOrEqual),
            ],
        );

        let result = aggregate_over_relationship(
            &sales,
            &periods,
            &rel,
            "amount",
            AggregateOp::Sum,
            "period",
        )
        .await
        .unwrap();

        assert_eq!(result.num_rows(), 2);

        let periods_col: Vec<&str> = (0..result.num_rows())
            .map(|i| {
                result
                    .column(0)
                    .as_any()
                    .downcast_ref::<arrow::array::StringArray>()
                    .unwrap()
                    .value(i)
            })
            .collect();

        let sums: Vec<f64> = (0..result.num_rows())
            .map(|i| {
                let col = result.column(1);
                datafusion::common::ScalarValue::try_from_array(col, i)
                    .ok()
                    .and_then(|s| match s {
                        datafusion::common::ScalarValue::Float64(v) => v,
                        datafusion::common::ScalarValue::Int64(v) => v.map(|n| n as f64),
                        _ => None,
                    })
                    .unwrap_or(0.0)
            })
            .collect();

        for (period, total) in periods_col.iter().zip(sums.iter()) {
            match *period {
                // P1 covers 101..=102: amounts for pid=101 (10+30=40) + pid=102 (20) = 60
                "P1" => assert!(
                    (*total - 60.0).abs() < 0.01,
                    "P1 expected 60.0, got {total}"
                ),
                // P2 covers 102..=103: amounts for pid=102 (20) + pid=103 (15) = 35
                "P2" => assert!(
                    (*total - 35.0).abs() < 0.01,
                    "P2 expected 35.0, got {total}"
                ),
                other => panic!("Unexpected period: {other}"),
            }
        }
    }

    /// Test that COUNT over a non-equi relationship gives correct values.
    #[tokio::test]
    async fn pre_aggregate_count_over_non_equi_join() {
        let sales = populated_sales();
        let periods = populated_periods();

        let rel = Relationship::many_to_many(
            "Sales_Periods",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("product_id", "start_id", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("product_id", "end_id", JoinOperator::LessThanOrEqual),
            ],
        );

        let result = aggregate_over_relationship(
            &sales,
            &periods,
            &rel,
            "amount",
            AggregateOp::Count,
            "period",
        )
        .await
        .unwrap();

        assert_eq!(result.num_rows(), 2);

        let periods_col: Vec<&str> = (0..result.num_rows())
            .map(|i| {
                result
                    .column(0)
                    .as_any()
                    .downcast_ref::<arrow::array::StringArray>()
                    .unwrap()
                    .value(i)
            })
            .collect();

        let counts: Vec<i64> = (0..result.num_rows())
            .map(|i| {
                let col = result.column(1);
                datafusion::common::ScalarValue::try_from_array(col, i)
                    .ok()
                    .and_then(|s| match s {
                        datafusion::common::ScalarValue::Int64(v) => v,
                        datafusion::common::ScalarValue::UInt64(v) => v.map(|n| n as i64),
                        _ => None,
                    })
                    .unwrap_or(0)
            })
            .collect();

        for (period, cnt) in periods_col.iter().zip(counts.iter()) {
            match *period {
                // P1 covers 101..=102: 3 sales rows (pid=101 ×2, pid=102 ×1)
                // Pre-agg: pid=101→count=2, pid=102→count=1. Stage 2 SUM: 2+1=3
                "P1" => assert_eq!(*cnt, 3, "P1 expected 3, got {cnt}"),
                // P2 covers 102..=103: 2 sales rows (pid=102 ×1, pid=103 ×1)
                // Pre-agg: pid=102→count=1, pid=103→count=1. Stage 2 SUM: 1+1=2
                "P2" => assert_eq!(*cnt, 2, "P2 expected 2, got {cnt}"),
                other => panic!("Unexpected period: {other}"),
            }
        }
    }

    /// Regression test: ManyToOne equi-join still produces the same results
    /// (no regression from pre-aggregate changes).
    #[tokio::test]
    async fn many_to_one_sum_unchanged_after_refactor() {
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

        let sums: Vec<f64> = (0..result.num_rows())
            .map(|i| {
                let col = result.column(1);
                datafusion::common::ScalarValue::try_from_array(col, i)
                    .ok()
                    .and_then(|s| match s {
                        datafusion::common::ScalarValue::Float64(v) => v,
                        datafusion::common::ScalarValue::Int64(v) => v.map(|n| n as f64),
                        _ => None,
                    })
                    .unwrap_or(0.0)
            })
            .collect();

        for (cat, total) in categories.iter().zip(sums.iter()) {
            match *cat {
                "A" => assert!((*total - 55.0).abs() < 0.01, "A expected 55.0, got {total}"),
                "B" => assert!((*total - 20.0).abs() < 0.01, "B expected 20.0, got {total}"),
                other => panic!("Unexpected category: {other}"),
            }
        }
    }
}
