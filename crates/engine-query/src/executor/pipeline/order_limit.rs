//! ORDER BY / LIMIT / ROLLUP helpers: typed totals errors, grouping-id SQL,
//! sort-helper stripping, and Arrow-level ordering of assembled results.

use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;

use crate::error::QueryResult;
use crate::request::{OrderByClause, OrderTarget, GROUPING_ID_COLUMN};

/// Remove hidden `__order_N` sort-helper columns from result batches.
///
/// The main local-aggregation SQL projects `MIN(sort_col)` helper columns to
/// implement sort-by-column ordering (DataFusion cannot ORDER BY an
/// unprojected aggregate); they are internal and must not appear in results.
/// Typed error for query shapes that do not support ROLLUP totals yet.
///
/// The unsupported combinations are listed in the `TotalsMode` docs; erroring
/// is deliberate — silently returning detail-only rows (or wrong subtotals)
/// would corrupt pivot output.
pub(super) fn totals_unsupported(what: &str) -> crate::error::QueryError {
    crate::error::QueryError::InvalidQuery(format!(
        "totals (TotalsMode::Rollup) is not supported with {what} yet"
    ))
}

/// Render the trailing `__grouping_id` SELECT item for a local ROLLUP query.
///
/// `group_terms` are the qualified group-by SQL terms (e.g.
/// `dim_table."col"`) in request order. The bitmask follows the engine
/// contract — bit `i` (LSB = `group_by[0]`) set when that column is rolled
/// up — built from per-column `GROUPING(...)` calls so the bit order is
/// explicit. DataFusion rewrites `GROUPING()` over grouping sets into its
/// internal grouping-id column, so the calls cost nothing at execution time.
/// The `CAST` pins the result type to `Int32` per the contract. With no
/// group-by terms the single aggregate row is its own grand total: literal
/// `0`.
pub(super) fn grouping_id_select_sql(group_terms: &[String]) -> String {
    if group_terms.is_empty() {
        return format!("CAST(0 AS INT) AS \"{GROUPING_ID_COLUMN}\"");
    }
    let bits: Vec<String> = group_terms
        .iter()
        .enumerate()
        .map(|(i, term)| {
            if i == 0 {
                format!("GROUPING({term})")
            } else {
                format!("GROUPING({term}) * {}", 1u32 << i)
            }
        })
        .collect();
    format!(
        "CAST({} AS INT) AS \"{GROUPING_ID_COLUMN}\"",
        bits.join(" + ")
    )
}

pub(super) fn strip_order_helper_columns(
    batches: Vec<RecordBatch>,
) -> QueryResult<Vec<RecordBatch>> {
    let mut out = Vec::with_capacity(batches.len());
    for batch in batches {
        let schema = batch.schema();
        let keep: Vec<usize> = schema
            .fields()
            .iter()
            .enumerate()
            .filter(|(_, f)| !f.name().starts_with("__order_"))
            .map(|(i, _)| i)
            .collect();
        if keep.len() == schema.fields().len() {
            out.push(batch);
        } else {
            out.push(batch.project(&keep)?);
        }
    }
    Ok(out)
}

/// Apply ORDER BY / LIMIT to already-computed result batches.
///
/// Used by execution paths whose final result is assembled outside a single
/// SQL statement (pushed join aggregation, multi-fact-table combination,
/// window and QUERY-in-VAR measures, two-stage pre-aggregation, post-lookup
/// results). Sorting uses Arrow's lexicographic sort over the **result
/// columns**: dimension targets sort by the group-by output column, measure
/// targets by the measure column (both matched case-insensitively). Model
/// `sort_by_column` substitution does NOT apply here — the sort column is not
/// part of the result; the planner routes substitution-dependent orderings to
/// SQL-ordered paths. Sort keys missing from the result schema are skipped.
///
/// Null ordering matches PostgreSQL/DataFusion defaults: nulls last for
/// ascending keys, nulls first for descending keys.
///
/// `limit` is applied after sorting; `Some(0)` produces an empty result
/// (schema preserved). Batches with differing schemas (e.g. per-measure
/// outputs of window evaluation) are sorted individually.
pub(crate) fn apply_order_and_limit(
    batches: Vec<RecordBatch>,
    order_by: &[OrderByClause],
    limit: Option<usize>,
) -> QueryResult<Vec<RecordBatch>> {
    if (order_by.is_empty() && limit.is_none()) || batches.is_empty() {
        return Ok(batches);
    }

    // Sort. Batches sharing one schema are concatenated so ordering holds
    // across batch boundaries; heterogeneous batches are sorted individually.
    let sorted: Vec<RecordBatch> = if order_by.is_empty() {
        batches
    } else {
        let first_schema = batches[0].schema();
        if batches.len() > 1 && batches.iter().all(|b| b.schema() == first_schema) {
            let combined = concat_batches(&first_schema, &batches)?;
            vec![sort_batch(&combined, order_by)?]
        } else {
            batches
                .iter()
                .map(|b| sort_batch(b, order_by))
                .collect::<QueryResult<Vec<_>>>()?
        }
    };

    // Limit: take rows in order until the cap is reached.
    let Some(n) = limit else {
        return Ok(sorted);
    };
    let mut remaining = n;
    let mut limited = Vec::new();
    for batch in &sorted {
        if remaining == 0 {
            break;
        }
        let take = batch.num_rows().min(remaining);
        limited.push(batch.slice(0, take));
        remaining -= take;
    }
    if limited.is_empty() {
        // LIMIT 0 (or all batches empty): preserve the result schema.
        limited.push(sorted[0].slice(0, 0));
    }
    Ok(limited)
}

/// Sort a single batch by the order-by clauses, matching sort keys against
/// the batch's columns case-insensitively. Missing keys are skipped; when no
/// key resolves the batch is returned unchanged.
fn sort_batch(batch: &RecordBatch, order_by: &[OrderByClause]) -> QueryResult<RecordBatch> {
    use arrow::compute::{lexsort_to_indices, take, SortColumn, SortOptions};

    let schema = batch.schema();
    let mut sort_columns: Vec<SortColumn> = Vec::new();
    for clause in order_by {
        let name = match &clause.target {
            OrderTarget::Column(col) => col.column.as_str(),
            OrderTarget::Measure(measure) => measure.as_str(),
        };
        let Some((idx, _)) = schema
            .fields()
            .iter()
            .enumerate()
            .find(|(_, f)| f.name().eq_ignore_ascii_case(name))
        else {
            continue;
        };
        sort_columns.push(SortColumn {
            values: batch.column(idx).clone(),
            options: Some(SortOptions {
                descending: clause.descending,
                nulls_first: clause.descending,
            }),
        });
    }
    if sort_columns.is_empty() || batch.num_rows() == 0 {
        return Ok(batch.clone());
    }

    let indices = lexsort_to_indices(&sort_columns, None)?;
    let columns = batch
        .columns()
        .iter()
        .map(|c| take(c, &indices, None))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RecordBatch::try_new(schema, columns)?)
}

#[cfg(test)]
mod order_and_limit {
    use super::super::QueryExecutor;
    use super::*;
    use crate::planner::PushdownPlanner;
    use crate::registry::SourceBinding;
    use crate::registry::SourceRegistry;
    use crate::request::ColumnRef;
    use crate::request::{OrderByClause, QueryRequest};
    use arrow::array::Float64Array;
    use arrow::array::StringArray;
    use arrow::array::{Array, Int32Array};
    use arrow::datatypes::{DataType, Field, Schema};
    use engine_core::compute::measure::sum_measure;
    use engine_core::model::column::Column;
    use engine_core::model::table::{StorageMode, Table};
    use engine_core::model::DataModel;
    use engine_core::store::InMemoryCache;
    use engine_core::types::DataType as EngineDataType;
    use std::sync::Arc;

    /// In-memory single-table model: regions + months (with sort-by) +
    /// amounts. Per-region totals: East 15.0, West 20.0, South 30.0.
    /// Per-month totals: Jan 15.0, Feb 20.0, Mar 30.0 (alphabetically
    /// Feb < Jan < Mar, but month_number orders Jan, Feb, Mar).
    fn fixture() -> (DataModel, InMemoryCache, SourceRegistry) {
        let table = Table::new(
            "fact_sales",
            vec![
                Column::new("region", EngineDataType::String),
                Column::new("month_name", EngineDataType::String).with_sort_by("month_number"),
                Column::new("month_number", EngineDataType::Int32),
                Column::new("amount", EngineDataType::Float64),
            ],
        )
        .unwrap()
        .with_storage_mode(StorageMode::InMemory);

        let model = DataModel::builder()
            .add_table(table)
            .add_measure(sum_measure("Total", "fact_sales", "amount"))
            .build()
            .unwrap();

        let schema = Arc::new(Schema::new(vec![
            Field::new("region", DataType::Utf8, true),
            Field::new("month_name", DataType::Utf8, true),
            Field::new("month_number", DataType::Int32, true),
            Field::new("amount", DataType::Float64, true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec!["West", "East", "South", "East"])),
                Arc::new(StringArray::from(vec!["Feb", "Jan", "Mar", "Jan"])),
                Arc::new(Int32Array::from(vec![2, 1, 3, 1])),
                Arc::new(Float64Array::from(vec![20.0, 10.0, 30.0, 5.0])),
            ],
        )
        .unwrap();
        let mut cache = InMemoryCache::new();
        cache.store("fact_sales", batch).unwrap();

        // Bind the table so the planner accepts it; the in-memory cache
        // serves the data, so no connector is ever contacted.
        let mut registry = SourceRegistry::new();
        registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));

        (model, cache, registry)
    }

    /// Plan + execute a request against the in-memory fixture.
    async fn run(request: QueryRequest) -> Vec<RecordBatch> {
        let (model, cache, registry) = fixture();
        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();
        QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None)
            .await
            .unwrap()
    }

    /// Extract a column as strings (casting through Utf8 to be robust
    /// against dictionary/view encodings of grouped output).
    fn string_column(batches: &[RecordBatch], name: &str) -> Vec<String> {
        let combined = concat_batches(&batches[0].schema(), batches).unwrap();
        let idx = combined.schema().index_of(name).unwrap();
        let cast = arrow::compute::cast(combined.column(idx), &DataType::Utf8).unwrap();
        let arr = cast.as_any().downcast_ref::<StringArray>().unwrap();
        (0..arr.len()).map(|i| arr.value(i).to_string()).collect()
    }

    #[tokio::test]
    async fn order_by_dimension_ascending() {
        let batches = run(QueryRequest {
            measures: vec!["Total".into()],
            group_by: vec![ColumnRef::new("fact_sales", "region")],
            order_by: vec![OrderByClause::column("fact_sales", "region")],
            ..Default::default()
        })
        .await;
        assert_eq!(string_column(&batches, "region"), ["East", "South", "West"]);
    }

    #[tokio::test]
    async fn order_by_dimension_descending() {
        let batches = run(QueryRequest {
            measures: vec!["Total".into()],
            group_by: vec![ColumnRef::new("fact_sales", "region")],
            order_by: vec![OrderByClause::column_desc("fact_sales", "region")],
            ..Default::default()
        })
        .await;
        assert_eq!(string_column(&batches, "region"), ["West", "South", "East"]);
    }

    #[tokio::test]
    async fn top_n_by_measure_descending_with_limit() {
        let batches = run(QueryRequest {
            measures: vec!["Total".into()],
            group_by: vec![ColumnRef::new("fact_sales", "region")],
            order_by: vec![OrderByClause::measure_desc("Total")],
            limit: Some(2),
            ..Default::default()
        })
        .await;
        // Totals: South 30.0, West 20.0, East 15.0 — top 2.
        assert_eq!(string_column(&batches, "region"), ["South", "West"]);
    }

    /// No explicit order_by: the engine defaults to ordering by the
    /// group-by columns — and `month_name` sorts by `month_number`, so
    /// rows come back Jan, Feb, Mar (not alphabetical Feb, Jan, Mar).
    #[tokio::test]
    async fn default_group_by_ordering_applies_sort_by_column() {
        let batches = run(QueryRequest {
            measures: vec!["Total".into()],
            group_by: vec![ColumnRef::new("fact_sales", "month_name")],
            ..Default::default()
        })
        .await;
        assert_eq!(string_column(&batches, "month_name"), ["Jan", "Feb", "Mar"]);
    }

    #[tokio::test]
    async fn explicit_order_by_respects_sort_by_column_descending() {
        let batches = run(QueryRequest {
            measures: vec!["Total".into()],
            group_by: vec![ColumnRef::new("fact_sales", "month_name")],
            order_by: vec![OrderByClause::column_desc("fact_sales", "month_name")],
            ..Default::default()
        })
        .await;
        assert_eq!(string_column(&batches, "month_name"), ["Mar", "Feb", "Jan"]);
    }

    #[tokio::test]
    async fn limit_zero_returns_empty_result() {
        let batches = run(QueryRequest {
            measures: vec!["Total".into()],
            group_by: vec![ColumnRef::new("fact_sales", "region")],
            limit: Some(0),
            ..Default::default()
        })
        .await;
        let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
        assert_eq!(rows, 0);
    }

    // --- apply_order_and_limit (Arrow-level fallback) ---

    /// Two-column result batch: region (Utf8) + Total (Float64).
    fn result_batch(rows: &[(&str, f64)]) -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![
            Field::new("region", DataType::Utf8, true),
            Field::new("Total", DataType::Float64, true),
        ]));
        RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(
                    rows.iter().map(|(r, _)| *r).collect::<Vec<_>>(),
                )),
                Arc::new(Float64Array::from(
                    rows.iter().map(|(_, t)| *t).collect::<Vec<_>>(),
                )),
            ],
        )
        .unwrap()
    }

    fn regions(batches: &[RecordBatch]) -> Vec<String> {
        string_column(batches, "region")
    }

    #[test]
    fn apply_order_and_limit_sorts_by_measure_desc_and_limits() {
        let batch = result_batch(&[("East", 15.0), ("South", 30.0), ("West", 20.0)]);
        let out = apply_order_and_limit(
            vec![batch],
            &[OrderByClause::measure_desc("Total")],
            Some(2),
        )
        .unwrap();
        assert_eq!(regions(&out), ["South", "West"]);
    }

    #[test]
    fn apply_order_and_limit_sorts_across_batches_with_same_schema() {
        let b1 = result_batch(&[("West", 20.0), ("East", 15.0)]);
        let b2 = result_batch(&[("South", 30.0)]);
        let out = apply_order_and_limit(
            vec![b1, b2],
            &[OrderByClause::column("fact_sales", "region")],
            None,
        )
        .unwrap();
        assert_eq!(regions(&out), ["East", "South", "West"]);
    }

    #[test]
    fn apply_order_and_limit_missing_sort_key_is_skipped() {
        let batch = result_batch(&[("West", 20.0), ("East", 15.0)]);
        let out = apply_order_and_limit(
            vec![batch],
            &[OrderByClause::column("dim", "no_such_column")],
            Some(1),
        )
        .unwrap();
        // Ordering unchanged (key not in result), limit still applied.
        assert_eq!(regions(&out), ["West"]);
    }

    #[test]
    fn apply_order_and_limit_limit_zero_preserves_schema() {
        let batch = result_batch(&[("West", 20.0)]);
        let schema = batch.schema();
        let out = apply_order_and_limit(vec![batch], &[OrderByClause::measure("Total")], Some(0))
            .unwrap();
        let rows: usize = out.iter().map(|b| b.num_rows()).sum();
        assert_eq!(rows, 0);
        assert_eq!(out[0].schema(), schema);
    }

    #[test]
    fn apply_order_and_limit_noop_without_order_or_limit() {
        let batch = result_batch(&[("West", 20.0), ("East", 15.0)]);
        let out = apply_order_and_limit(vec![batch], &[], None).unwrap();
        assert_eq!(regions(&out), ["West", "East"]);
    }
}

#[cfg(test)]
mod totals {
    use super::super::QueryExecutor;
    use super::*;
    use crate::error::QueryError;
    use crate::planner::PushdownPlanner;
    use crate::registry::SourceBinding;
    use crate::registry::SourceRegistry;
    use crate::request::ColumnRef;
    use crate::request::{LookupColumn, OrderByClause, QueryRequest, TotalsMode};
    use arrow::array::{Array, Int32Array};
    use arrow::array::{Float64Array, Int64Array, StringArray};
    use arrow::datatypes::{DataType, Field, Schema};
    use engine_core::compute::aggregate::AggregateOp;
    use engine_core::compute::expression as expr;
    use engine_core::compute::measure::{
        average_measure, distinct_count_measure, expression_measure, sum_measure, Measure,
    };
    use engine_core::model::column::Column;
    use engine_core::model::table::{StorageMode, Table};
    use engine_core::model::DataModel;
    use engine_core::store::InMemoryCache;
    use engine_core::types::DataType as EngineDataType;
    use std::sync::Arc;

    /// In-memory single-table model with non-additive measures.
    ///
    /// Data is shaped so subtotal levels differ from sums of detail rows:
    /// customer `c1` buys both products in East and `c2` appears in both
    /// East and West, so DISTINCTCOUNT subtotals are smaller than the sum
    /// of the detail counts, and AVG subtotals are not averages of the
    /// detail averages.
    ///
    /// ```text
    /// region product customer amount
    /// East   A       c1       10
    /// East   B       c1       20
    /// East   B       c2       30
    /// West   A       c2       40
    /// West   A       c3       50
    /// ```
    fn fixture() -> (DataModel, InMemoryCache, SourceRegistry) {
        let table = Table::new(
            "fact_sales",
            vec![
                Column::new("region", EngineDataType::String),
                Column::new("product", EngineDataType::String),
                Column::new("customer", EngineDataType::String),
                Column::new("amount", EngineDataType::Float64),
            ],
        )
        .unwrap()
        .with_storage_mode(StorageMode::InMemory);

        let model = DataModel::builder()
            .add_table(table)
            .add_measure(sum_measure("Total", "fact_sales", "amount"))
            .add_measure(distinct_count_measure(
                "Customers",
                "fact_sales",
                "customer",
            ))
            .add_measure(average_measure("AvgAmount", "fact_sales", "amount"))
            .build()
            .unwrap();

        let schema = Arc::new(Schema::new(vec![
            Field::new("region", DataType::Utf8, true),
            Field::new("product", DataType::Utf8, true),
            Field::new("customer", DataType::Utf8, true),
            Field::new("amount", DataType::Float64, true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec![
                    "East", "East", "East", "West", "West",
                ])),
                Arc::new(StringArray::from(vec!["A", "B", "B", "A", "A"])),
                Arc::new(StringArray::from(vec!["c1", "c1", "c2", "c2", "c3"])),
                Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0, 50.0])),
            ],
        )
        .unwrap();
        let mut cache = InMemoryCache::new();
        cache.store("fact_sales", batch).unwrap();

        // Bind the table so the planner accepts it; the in-memory cache
        // serves the data, so no connector is ever contacted.
        let mut registry = SourceRegistry::new();
        registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));

        (model, cache, registry)
    }

    /// Plan + execute a request against the in-memory fixture.
    async fn run(request: QueryRequest) -> QueryResult<Vec<RecordBatch>> {
        let (model, cache, registry) = fixture();
        let plan = PushdownPlanner::plan(&request, &model, &registry)?;
        QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None).await
    }

    /// Combine batches and extract a nullable string column by name.
    fn opt_string_column(combined: &RecordBatch, name: &str) -> Vec<Option<String>> {
        let idx = combined.schema().index_of(name).unwrap();
        let cast = arrow::compute::cast(combined.column(idx), &DataType::Utf8).unwrap();
        let arr = cast.as_any().downcast_ref::<StringArray>().unwrap();
        (0..arr.len())
            .map(|i| (!arr.is_null(i)).then(|| arr.value(i).to_string()))
            .collect()
    }

    fn f64_column(combined: &RecordBatch, name: &str) -> Vec<f64> {
        let idx = combined.schema().index_of(name).unwrap();
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        (0..arr.len()).map(|i| arr.value(i)).collect()
    }

    fn i64_column(combined: &RecordBatch, name: &str) -> Vec<i64> {
        let idx = combined.schema().index_of(name).unwrap();
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap();
        (0..arr.len()).map(|i| arr.value(i)).collect()
    }

    fn grouping_ids(combined: &RecordBatch) -> Vec<i32> {
        let idx = combined.schema().index_of(GROUPING_ID_COLUMN).unwrap();
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap();
        (0..arr.len()).map(|i| arr.value(i)).collect()
    }

    /// Two-dimension rollup: detail rows + per-region subtotals + grand
    /// total, each level recomputed (not summed from details), correct
    /// `__grouping_id` bitmask, default ordering with subtotals after
    /// their group's detail rows.
    #[tokio::test]
    async fn rollup_two_dims_recomputes_each_level() {
        let batches = run(QueryRequest {
            measures: vec!["Total".into(), "Customers".into(), "AvgAmount".into()],
            group_by: vec![
                ColumnRef::new("fact_sales", "region"),
                ColumnRef::new("fact_sales", "product"),
            ],
            totals: TotalsMode::Rollup,
            ..Default::default()
        })
        .await
        .unwrap();
        let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

        // Contract: trailing Int32 column named __grouping_id.
        let schema = combined.schema();
        let last = schema.field(schema.fields().len() - 1);
        assert_eq!(last.name(), GROUPING_ID_COLUMN);
        assert_eq!(last.data_type(), &DataType::Int32);

        // Default ordering (region, product ascending, nulls last) puts
        // each region's subtotal after its detail rows and the grand
        // total last.
        let some = |s: &str| Some(s.to_string());
        assert_eq!(
            opt_string_column(&combined, "region"),
            [
                some("East"),
                some("East"),
                some("East"),
                some("West"),
                some("West"),
                None
            ]
        );
        assert_eq!(
            opt_string_column(&combined, "product"),
            [some("A"), some("B"), None, some("A"), None, None]
        );
        // Bitmask: bit 0 = region (group_by[0]), bit 1 = product.
        // Detail = 0; region subtotal rolls up product = 2; grand = 3.
        assert_eq!(grouping_ids(&combined), [0, 0, 2, 0, 2, 3]);

        // SUM is additive — sanity check.
        assert_eq!(
            f64_column(&combined, "Total"),
            [10.0, 50.0, 60.0, 90.0, 90.0, 150.0]
        );

        // DISTINCTCOUNT must be recomputed per level: East subtotal is
        // 2 distinct customers (c1, c2), NOT the detail sum 1 + 2 = 3;
        // the grand total is 3 (c1, c2, c3), NOT 2 + 2 = 4.
        assert_eq!(i64_column(&combined, "Customers"), [1, 2, 2, 2, 2, 3]);

        // AVG must be recomputed per level: East subtotal is
        // (10+20+30)/3 = 20, NOT the average of detail averages
        // (10 + 25) / 2 = 17.5; grand total is 150/5 = 30.
        assert_eq!(
            f64_column(&combined, "AvgAmount"),
            [10.0, 25.0, 20.0, 45.0, 45.0, 30.0]
        );
    }

    #[tokio::test]
    async fn rollup_single_dim_adds_grand_total() {
        let batches = run(QueryRequest {
            measures: vec!["Total".into(), "Customers".into()],
            group_by: vec![ColumnRef::new("fact_sales", "region")],
            totals: TotalsMode::Rollup,
            ..Default::default()
        })
        .await
        .unwrap();
        let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

        let some = |s: &str| Some(s.to_string());
        assert_eq!(
            opt_string_column(&combined, "region"),
            [some("East"), some("West"), None]
        );
        assert_eq!(grouping_ids(&combined), [0, 0, 1]);
        assert_eq!(f64_column(&combined, "Total"), [60.0, 90.0, 150.0]);
        // Grand total: 3 distinct customers, not 2 + 2.
        assert_eq!(i64_column(&combined, "Customers"), [2, 2, 3]);
    }

    /// Totals with an empty group_by: the single aggregate row is both
    /// detail and grand total — `__grouping_id` is 0 (no bits exist).
    #[tokio::test]
    async fn rollup_with_empty_group_by_returns_single_grand_total_row() {
        let batches = run(QueryRequest {
            measures: vec!["Total".into()],
            totals: TotalsMode::Rollup,
            ..Default::default()
        })
        .await
        .unwrap();
        let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

        assert_eq!(combined.num_rows(), 1);
        let schema = combined.schema();
        let last = schema.field(schema.fields().len() - 1);
        assert_eq!(last.name(), GROUPING_ID_COLUMN);
        assert_eq!(last.data_type(), &DataType::Int32);
        assert_eq!(grouping_ids(&combined), [0]);
        assert_eq!(f64_column(&combined, "Total"), [150.0]);
    }

    /// `limit` applies to the combined result including subtotal rows:
    /// ordering by the measure descending puts the grand total first.
    #[tokio::test]
    async fn rollup_limit_applies_after_totals_rows_are_included() {
        let batches = run(QueryRequest {
            measures: vec!["Total".into()],
            group_by: vec![ColumnRef::new("fact_sales", "region")],
            order_by: vec![OrderByClause::measure_desc("Total")],
            limit: Some(1),
            totals: TotalsMode::Rollup,
            ..Default::default()
        })
        .await
        .unwrap();
        let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

        assert_eq!(combined.num_rows(), 1);
        assert_eq!(grouping_ids(&combined), [1]);
        assert_eq!(f64_column(&combined, "Total"), [150.0]);
    }

    #[tokio::test]
    async fn totals_with_window_measure_errors_cleanly() {
        let (model, cache, registry) = fixture();
        let window_measure = expression_measure(
            "RunningTotal",
            expr::Expression::Window {
                inner: Box::new(expr::agg(
                    AggregateOp::Sum,
                    expr::qualified_col("fact_sales", "amount"),
                )),
                function: AggregateOp::Sum,
                order_by: vec![("fact_sales".into(), "region".into())],
                partition_by: vec![],
                frame: None,
            },
        );
        let model = {
            let mut builder = DataModel::builder();
            for table in model.tables() {
                builder = builder.add_table(table.clone());
            }
            builder.add_measure(window_measure).build().unwrap()
        };

        let request = QueryRequest {
            measures: vec!["RunningTotal".into()],
            group_by: vec![ColumnRef::new("fact_sales", "region")],
            totals: TotalsMode::Rollup,
            ..Default::default()
        };
        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();
        let err = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None)
            .await
            .unwrap_err();
        match err {
            QueryError::InvalidQuery(msg) => {
                assert!(msg.contains("window measures"), "unexpected message: {msg}");
            }
            other => panic!("expected InvalidQuery, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn totals_with_lookups_errors_cleanly() {
        let err = run(QueryRequest {
            measures: vec!["Total".into()],
            group_by: vec![ColumnRef::new("fact_sales", "region")],
            lookups: vec![LookupColumn::new("fact_sales", "customer")],
            totals: TotalsMode::Rollup,
            ..Default::default()
        })
        .await
        .unwrap_err();
        match err {
            QueryError::InvalidQuery(msg) => {
                assert!(msg.contains("lookup columns"), "unexpected message: {msg}");
            }
            other => panic!("expected InvalidQuery, got {other:?}"),
        }
    }

    /// Direct executor call with lookups + totals (bypassing the planner
    /// gate) is also rejected.
    #[tokio::test]
    async fn executor_rejects_totals_with_lookup_specs() {
        let (model, cache, registry) = fixture();
        let measures = vec![Measure::simple(
            "Total",
            "fact_sales",
            "amount",
            AggregateOp::Sum,
        )];
        let specs = vec![crate::planner::LookupSpec {
            table: "fact_sales".into(),
            column: "customer".into(),
            key_column: "region".into(),
            resolution_sql: "MIN(fact_sales.\"customer\")".into(),
        }];
        let err = QueryExecutor::execute_local_aggregation(
            &[],
            &measures,
            &[ColumnRef::new("fact_sales", "region")],
            &specs,
            &[],
            None,
            TotalsMode::Rollup,
            None,
            &model,
            &registry,
            Some(&cache),
            None,
            None,
            None,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, QueryError::InvalidQuery(_)));
    }
}
