//! Fetched-batch handling: cached-table filtering, partitioned DataFusion
//! registration, and join-key value extraction for IN-filter propagation.

use std::sync::Arc;

use arrow::array::Array;
use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::common::TableReference;
use datafusion::datasource::MemTable;
use datafusion::prelude::SessionContext;

use engine_connectors::traits::InValueKind;
use engine_core::compute::sql_util::{quote_ident_double, sql_quote_literal};

use crate::error::QueryResult;

/// Apply filter conditions to a cached `RecordBatch` using DataFusion.
///
/// This ensures that in-memory tables respect the same filters that would have
/// been pushed to the source connector (e.g., context-pushed KEEP filters on
/// dimension tables). Without this, the full cached batch would be used, leading
/// to incorrect IN-filter propagation and wrong query results.
pub(super) async fn filter_cached_batch(
    batch: &RecordBatch,
    filters: &[engine_connectors::FilterCondition],
) -> crate::error::QueryResult<RecordBatch> {
    let filter_ctx = SessionContext::new();
    filter_ctx.register_batch("_cached", batch.clone())?;

    let mut conditions = Vec::new();
    let schema = batch.schema();
    for filter in filters {
        // Render the comparison value as a literal typed to match the column,
        // so DataFusion compares values numerically/temporally rather than
        // lexically. The previous `CAST(col AS TEXT) op '<value>'` form made
        // every comparison **lexical**, which silently broke ordering
        // predicates on numeric and date columns (e.g. `amount >= '30'`
        // dropped `100` because `"100" < "30"` as text). This matters for
        // row-level-security filters, which may use `>`, `>=`, `<`, `<=`.
        let rhs = literal_for_column(&schema, &filter.column, &filter.value);
        conditions.push(format!(
            "{} {} {}",
            quote_ident_double(&filter.column),
            filter.operator.as_sql(),
            rhs
        ));
    }

    let sql = format!("SELECT * FROM _cached WHERE {}", conditions.join(" AND "));
    let df = filter_ctx.sql(&sql).await?;
    let batches = df.collect().await?;

    if batches.is_empty() {
        Ok(RecordBatch::new_empty(batch.schema()))
    } else {
        Ok(concat_batches(&batch.schema(), &batches)?)
    }
}

/// Apply a DNF OR restriction `(g1) OR (g2) OR ...` (each group AND-combined)
/// to a cached batch, the local equivalent of the connector's `or_groups`.
/// Returns the batch unchanged when there are no groups or any group is empty
/// (an empty AND-group matches everything).
pub(super) async fn filter_cached_batch_or_groups(
    batch: &RecordBatch,
    groups: &[Vec<engine_connectors::FilterCondition>],
) -> crate::error::QueryResult<RecordBatch> {
    if groups.is_empty() || groups.iter().any(|g| g.is_empty()) {
        return Ok(batch.clone());
    }
    let filter_ctx = SessionContext::new();
    filter_ctx.register_batch("_cached", batch.clone())?;
    let schema = batch.schema();

    let group_sqls: Vec<String> = groups
        .iter()
        .map(|group| {
            let conds: Vec<String> = group
                .iter()
                .map(|f| {
                    let rhs = literal_for_column(&schema, &f.column, &f.value);
                    format!(
                        "{} {} {}",
                        quote_ident_double(&f.column),
                        f.operator.as_sql(),
                        rhs
                    )
                })
                .collect();
            format!("({})", conds.join(" AND "))
        })
        .collect();

    let sql = format!("SELECT * FROM _cached WHERE ({})", group_sqls.join(" OR "));
    let batches = filter_ctx.sql(&sql).await?.collect().await?;
    if batches.is_empty() {
        Ok(RecordBatch::new_empty(batch.schema()))
    } else {
        Ok(concat_batches(&batch.schema(), &batches)?)
    }
}

/// Render a filter value as a SQL literal typed to match `column`'s Arrow type
/// in `schema`.
///
/// For numeric and boolean columns the value is emitted **unquoted** (when it
/// parses as the matching kind) so DataFusion compares it numerically /
/// logically rather than lexically. Everything else — strings, dates,
/// timestamps, or a value that does not parse for a numeric/boolean column —
/// falls back to a safely-quoted string literal, which DataFusion coerces to
/// the column type (and which keeps string equality working as before).
fn literal_for_column(schema: &arrow::datatypes::Schema, column: &str, value: &str) -> String {
    let Ok(field) = schema.field_with_name(column) else {
        // Unknown column: quote defensively. The subsequent SQL will error on
        // the missing column rather than silently mis-filtering.
        return sql_quote_literal(value);
    };
    render_filter_literal(field.data_type(), value)
}

/// Render a filter comparison value as a SQL literal appropriate to the column's
/// Arrow type: an unquoted numeric/boolean literal where that parses (so
/// DataFusion compares numerically / logically), otherwise a safely-quoted
/// string (which DataFusion coerces to the column type, keeping string equality
/// correct).
///
/// **Recurses through `Dictionary` encoding** — a dictionary-encoded integer key
/// must still compare numerically, not lexically (`'100' > '50'` is false). And
/// `Boolean` renders as an unquoted `true`/`false` (`"active" = 'true'` is a
/// DataFusion type error). Shared by the cached-batch filter path
/// ([`literal_for_column`]) and the in-memory / CSV connectors so the two cannot
/// drift.
pub(crate) fn render_filter_literal(data_type: &arrow::datatypes::DataType, value: &str) -> String {
    use arrow::datatypes::DataType;
    match data_type {
        DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32
        | DataType::UInt64 => {
            if value.parse::<i64>().is_ok() {
                value.to_string()
            } else {
                sql_quote_literal(value)
            }
        }
        DataType::Float16 | DataType::Float32 | DataType::Float64 => {
            if value.parse::<f64>().is_ok() {
                value.to_string()
            } else {
                sql_quote_literal(value)
            }
        }
        DataType::Decimal128(_, _) | DataType::Decimal256(_, _) => {
            // Numeric literal (DataFusion parses it into the decimal type);
            // fall back to a quoted literal if it is not a bare number.
            if value.parse::<f64>().is_ok() {
                value.to_string()
            } else {
                sql_quote_literal(value)
            }
        }
        DataType::Boolean => match value.to_ascii_lowercase().as_str() {
            "true" | "false" => value.to_ascii_lowercase(),
            _ => sql_quote_literal(value),
        },
        // A dictionary-encoded column compares as its decoded value type.
        DataType::Dictionary(_, value_type) => render_filter_literal(value_type, value),
        // Strings, dates, timestamps, etc.: a quoted literal.
        _ => sql_quote_literal(value),
    }
}

/// Minimum number of rows per partition when re-chunking fetched batches for
/// multi-partition registration. Matches DataFusion's default batch size so
/// small tables stay in a single partition (identical scan behavior to the
/// previous single-batch registration).
const MIN_PARTITION_ROWS: usize = 8192;

/// Split `batches` into up to `max_partitions` partition groups for
/// multi-partition `MemTable` registration.
///
/// DataFusion parallelizes partial aggregation and join probes per partition,
/// so a single-partition table executes on one core regardless of
/// `target_partitions`. Re-chunking uses zero-copy [`RecordBatch::slice`] —
/// no row data is copied. Inputs with fewer than [`MIN_PARTITION_ROWS`] rows
/// per would-be partition stay in a single partition to avoid scheduling
/// overhead on tiny tables.
fn partition_batches(batches: Vec<RecordBatch>, max_partitions: usize) -> Vec<Vec<RecordBatch>> {
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    let partition_count = (total_rows / MIN_PARTITION_ROWS).clamp(1, max_partitions.max(1));
    if partition_count <= 1 {
        return vec![batches];
    }

    // Distribute rows evenly: fill each partition up to `rows_per_partition`
    // rows, slicing batches at partition boundaries (zero-copy).
    let rows_per_partition = total_rows.div_ceil(partition_count);
    let mut partitions: Vec<Vec<RecordBatch>> = vec![Vec::new(); partition_count];
    let mut current = 0;
    let mut current_rows = 0;

    for batch in batches {
        let rows = batch.num_rows();
        let mut offset = 0;
        while offset < rows {
            if current_rows >= rows_per_partition && current + 1 < partition_count {
                current += 1;
                current_rows = 0;
            }
            let take = if current + 1 < partition_count {
                (rows - offset).min(rows_per_partition - current_rows)
            } else {
                // The last partition takes everything that remains.
                rows - offset
            };
            partitions[current].push(batch.slice(offset, take));
            offset += take;
            current_rows += take;
        }
    }

    // Drop partitions that received no batches (possible with skewed row
    // counts); `MemTable` accepts any partition count.
    partitions.retain(|p| !p.is_empty());
    partitions
}

/// Register `batches` as an in-memory table, preserving them as multiple
/// `MemTable` partitions instead of concatenating into one giant batch.
///
/// Functionally equivalent to [`SessionContext::register_batch`] (same
/// table-name semantics — callers pass lowercase names), but avoids the full
/// extra copy made by `concat_batches` and lets DataFusion parallelize across
/// `target_partitions` cores. An empty batch list registers nothing (matching
/// the previous skip-on-empty behavior); zero-row batches register an empty
/// table with the correct schema.
///
/// **Dotted model table names** (imports historically named tables
/// `"<schema>.<table>"`, e.g. `BI.fact_sales`) are registered as a
/// schema-qualified reference — the in-memory schema is created on demand —
/// because the generated SQL interpolates the name UNQUOTED, which DataFusion
/// parses as `schema.table`. A bare registration of the dotted string would
/// therefore never resolve ("table 'datafusion.bi.fact_sales' not found").
/// Names with no dot (or several) register bare, exactly as before.
pub(super) fn register_partitioned_table(
    ctx: &SessionContext,
    name: &str,
    batches: Vec<RecordBatch>,
) -> QueryResult<()> {
    let Some(first) = batches.first() else {
        return Ok(());
    };
    let schema = first.schema();
    let target_partitions = ctx.copied_config().target_partitions();
    let partitions = partition_batches(batches, target_partitions);
    let table = MemTable::try_new(schema, partitions)?;
    ctx.register_table(model_table_reference(ctx, name)?, Arc::new(table))?;
    Ok(())
}

/// The [`TableReference`] under which a model table is registered — see
/// [`register_partitioned_table`]. For a single-dotted name this creates the
/// in-memory schema on demand and returns a schema-qualified reference so the
/// unquoted SQL form (`bi.fact_sales`) resolves; anything else stays bare.
fn model_table_reference(ctx: &SessionContext, name: &str) -> QueryResult<TableReference> {
    let mut parts = name.split('.');
    if let (Some(schema_part), Some(table_part), None) = (parts.next(), parts.next(), parts.next())
    {
        if !schema_part.is_empty() && !table_part.is_empty() {
            let default_catalog = ctx
                .copied_config()
                .options()
                .catalog
                .default_catalog
                .clone();
            if let Some(catalog) = ctx.catalog(&default_catalog) {
                if catalog.schema(schema_part).is_none() {
                    catalog.register_schema(
                        schema_part,
                        Arc::new(datafusion::catalog_common::memory::MemorySchemaProvider::new()),
                    )?;
                }
                return Ok(TableReference::partial(
                    schema_part.to_string(),
                    table_part.to_string(),
                ));
            }
        }
    }
    Ok(TableReference::bare(name))
}

/// Whether an Arrow type is an integer family type (including
/// dictionary-encoded integer variants).
///
/// Used to classify IN-filter values: integer join keys are rendered by
/// connectors as unquoted numeric literals so the fact-table FK index stays
/// usable.
fn is_integer_arrow_type(data_type: &arrow::datatypes::DataType) -> bool {
    use arrow::datatypes::DataType as AT;
    match data_type {
        AT::Int8
        | AT::Int16
        | AT::Int32
        | AT::Int64
        | AT::UInt8
        | AT::UInt16
        | AT::UInt32
        | AT::UInt64 => true,
        AT::Dictionary(_, value_type) => is_integer_arrow_type(value_type),
        _ => false,
    }
}

/// Extract unique string values from a named column across Arrow record
/// batches, classifying the source column type for SQL rendering.
///
/// Values are cast to strings for use in IN filter lists; null values are
/// excluded. The returned [`InValueKind`] is [`InValueKind::Integer`] when
/// the source column is an integer family type (including dictionary-encoded
/// integers — the Utf8 cast unpacks the dictionary, so values are plain
/// decimal strings either way) **and** every extracted value parses as
/// `i128`; otherwise [`InValueKind::Text`]. Connectors re-validate before
/// rendering unquoted literals, so a wrong `Integer` classification can cost
/// performance but never correctness.
pub(super) fn extract_column_values(
    batches: &[RecordBatch],
    column_name: &str,
) -> (Vec<String>, InValueKind) {
    let mut values = std::collections::HashSet::new();
    let mut all_integer_typed = true;
    let mut found_column = false;
    for batch in batches {
        let Ok(idx) = batch.schema().index_of(column_name) else {
            continue;
        };
        let array = batch.column(idx);
        found_column = true;
        // Batches of one table share a schema, but classify every batch
        // defensively: any non-integer occurrence downgrades to Text.
        if !is_integer_arrow_type(array.data_type()) {
            all_integer_typed = false;
        }
        let Ok(string_array) = arrow::compute::cast(array, &arrow::datatypes::DataType::Utf8)
        else {
            continue;
        };
        let str_arr = string_array
            .as_any()
            .downcast_ref::<arrow::array::StringArray>();
        if let Some(str_arr) = str_arr {
            for i in 0..str_arr.len() {
                if !str_arr.is_null(i) {
                    values.insert(str_arr.value(i).to_string());
                }
            }
        }
    }
    let values: Vec<String> = values.into_iter().collect();
    // Defensive validation: Integer kind requires every value to be a clean
    // decimal integer. Data integrity over speed — downgrade to Text if any
    // value fails to parse.
    let kind =
        if found_column && all_integer_typed && values.iter().all(|v| v.parse::<i128>().is_ok()) {
            InValueKind::Integer
        } else {
            InValueKind::Text
        };
    (values, kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{Int32Array, Int64Array, StringArray};
    use arrow::datatypes::{DataType, Field, Schema};
    use engine_core::compute::aggregate::AggregateOp;
    use engine_core::compute::measure::Measure;
    use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
    use engine_core::model::DataModel;
    use engine_core::store::InMemoryCache;

    use crate::registry::SourceRegistry;
    use crate::request::TotalsMode;

    use super::super::QueryExecutor;

    #[test]
    fn extract_column_values_from_string_column() {
        let schema = Arc::new(Schema::new(vec![Field::new("name", DataType::Utf8, true)]));
        let batch = RecordBatch::try_new(
            schema,
            vec![Arc::new(StringArray::from(vec![
                Some("Alice"),
                Some("Bob"),
                None,
                Some("Alice"),
            ]))],
        )
        .unwrap();

        let (values, kind) = extract_column_values(&[batch], "name");
        assert_eq!(values.len(), 2); // Deduplicated, nulls excluded
        assert!(values.contains(&"Alice".to_string()));
        assert!(values.contains(&"Bob".to_string()));
        assert_eq!(kind, InValueKind::Text);
    }

    #[test]
    fn extract_column_values_from_int_column() {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, true)]));
        let batch = RecordBatch::try_new(
            schema,
            vec![Arc::new(Int32Array::from(vec![
                Some(1),
                Some(2),
                Some(3),
                None,
                Some(1),
            ]))],
        )
        .unwrap();

        let (values, kind) = extract_column_values(&[batch], "id");
        assert_eq!(values.len(), 3); // 1, 2, 3 — deduplicated, null excluded
        assert_eq!(kind, InValueKind::Integer);
        // Every extracted value is a clean decimal integer string.
        assert!(values.iter().all(|v| v.parse::<i128>().is_ok()));
    }

    #[test]
    fn extract_column_values_from_dictionary_int_column_is_integer() {
        use arrow::array::{DictionaryArray, Int64Array, Int8Array};

        let keys = Int8Array::from(vec![Some(0), Some(1), None, Some(0)]);
        let dict_values = Int64Array::from(vec![100, 200]);
        let dict = DictionaryArray::new(keys, Arc::new(dict_values) as arrow::array::ArrayRef);
        let schema = Arc::new(Schema::new(vec![Field::new(
            "key",
            dict.data_type().clone(),
            true,
        )]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(dict)]).unwrap();

        let (values, kind) = extract_column_values(&[batch], "key");
        assert_eq!(kind, InValueKind::Integer);
        assert_eq!(values.len(), 2); // 100, 200 — deduplicated, null excluded
        assert!(values.contains(&"100".to_string()));
        assert!(values.contains(&"200".to_string()));
    }

    #[test]
    fn extract_column_values_from_dictionary_string_column_is_text() {
        use arrow::array::{DictionaryArray, Int32Array as Keys};

        let keys = Keys::from(vec![0, 1, 0]);
        let dict_values = StringArray::from(vec!["red", "blue"]);
        let dict = DictionaryArray::new(keys, Arc::new(dict_values) as arrow::array::ArrayRef);
        let schema = Arc::new(Schema::new(vec![Field::new(
            "color",
            dict.data_type().clone(),
            true,
        )]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(dict)]).unwrap();

        let (values, kind) = extract_column_values(&[batch], "color");
        assert_eq!(kind, InValueKind::Text);
        assert_eq!(values.len(), 2);
    }

    #[test]
    fn extract_column_values_numeric_looking_strings_stay_text() {
        // A Utf8 column whose values happen to be numeric must remain Text:
        // classification follows the source Arrow type, not value shape.
        let schema = Arc::new(Schema::new(vec![Field::new("code", DataType::Utf8, true)]));
        let batch = RecordBatch::try_new(
            schema,
            vec![Arc::new(StringArray::from(vec!["1", "2", "3"]))],
        )
        .unwrap();

        let (values, kind) = extract_column_values(&[batch], "code");
        assert_eq!(values.len(), 3);
        assert_eq!(kind, InValueKind::Text);
    }

    #[test]
    fn extract_column_values_missing_column() {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(Int32Array::from(vec![1, 2, 3]))]).unwrap();

        let (values, kind) = extract_column_values(&[batch], "nonexistent");
        assert!(values.is_empty());
        assert_eq!(kind, InValueKind::Text);
    }

    #[test]
    fn extract_column_values_empty_batches() {
        let (values, kind) = extract_column_values(&[], "id");
        assert!(values.is_empty());
        assert_eq!(kind, InValueKind::Text);
    }

    /// Build a single-column Int64 batch with values `start..start + len`.
    fn int64_batch(start: i64, len: usize) -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, false)]));
        RecordBatch::try_new(
            schema,
            vec![Arc::new(Int64Array::from_iter_values(
                start..start + len as i64,
            ))],
        )
        .unwrap()
    }

    #[test]
    fn partition_batches_small_input_stays_single_partition() {
        let batch = int64_batch(0, 100);
        let parts = partition_batches(vec![batch], 8);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].len(), 1);
        assert_eq!(parts[0][0].num_rows(), 100);
    }

    #[test]
    fn partition_batches_rechunks_single_large_batch() {
        let parts = partition_batches(vec![int64_batch(0, 40_000)], 4);
        assert_eq!(parts.len(), 4);
        // Total rows preserved, evenly distributed (ceil(40_000 / 4) max).
        let total: usize = parts.iter().flatten().map(|b| b.num_rows()).sum();
        assert_eq!(total, 40_000);
        for part in &parts {
            let rows: usize = part.iter().map(|b| b.num_rows()).sum();
            assert!(rows <= 10_000);
        }
        // Row order preserved across partitions in sequence.
        let all: Vec<RecordBatch> = parts.into_iter().flatten().collect();
        let combined = concat_batches(&all[0].schema(), &all).unwrap();
        let col = combined
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap();
        assert_eq!(col.value(0), 0);
        assert_eq!(col.value(39_999), 39_999);
    }

    #[test]
    fn partition_batches_respects_max_partitions() {
        let parts = partition_batches(vec![int64_batch(0, 100_000)], 3);
        assert_eq!(parts.len(), 3);
        let total: usize = parts.iter().flatten().map(|b| b.num_rows()).sum();
        assert_eq!(total, 100_000);
    }

    #[test]
    fn partition_batches_slices_share_buffers() {
        let batch = int64_batch(0, 20_000);
        let base_ptr = batch.column(0).to_data().buffers()[0].as_ptr() as usize;
        let end_ptr = base_ptr + 20_000 * std::mem::size_of::<i64>();

        let parts = partition_batches(vec![batch], 2);
        assert_eq!(parts.len(), 2);
        for slice in parts.iter().flatten() {
            // Zero-copy: every slice's value buffer points into the original
            // allocation instead of a fresh copy.
            let ptr = slice.column(0).to_data().buffers()[0].as_ptr() as usize;
            assert!(
                ptr >= base_ptr && ptr < end_ptr,
                "slice buffer was copied instead of shared"
            );
        }
    }

    #[test]
    fn partition_batches_groups_existing_batches() {
        let batches: Vec<RecordBatch> = (0..4).map(|i| int64_batch(i * 8192, 8192)).collect();
        let parts = partition_batches(batches, 2);
        assert_eq!(parts.len(), 2);
        let rows: Vec<usize> = parts
            .iter()
            .map(|p| p.iter().map(|b| b.num_rows()).sum())
            .collect();
        assert_eq!(rows, vec![16_384, 16_384]);
    }

    #[test]
    fn partition_batches_empty_input_single_empty_partition() {
        let parts = partition_batches(vec![], 8);
        assert_eq!(parts.len(), 1);
        assert!(parts[0].is_empty());
    }

    #[test]
    fn partition_batches_zero_row_batch_preserved() {
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, false)]));
        let batch = RecordBatch::new_empty(schema.clone());
        let parts = partition_batches(vec![batch], 8);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].len(), 1);
        assert_eq!(parts[0][0].num_rows(), 0);
        assert_eq!(parts[0][0].schema(), schema);
    }

    #[tokio::test]
    async fn register_partitioned_table_preserves_rows_and_sums() {
        let ctx = SessionContext::new();
        let n = 20_000i64;
        register_partitioned_table(&ctx, "t", vec![int64_batch(0, n as usize)]).unwrap();

        let df = ctx.sql("SELECT COUNT(*) AS c, SUM(v) AS s FROM t").await;
        let out = df.unwrap().collect().await.unwrap();
        let combined = concat_batches(&out[0].schema(), &out).unwrap();
        let count = combined
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap()
            .value(0);
        let sum = combined
            .column(1)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap()
            .value(0);
        assert_eq!(count, n);
        assert_eq!(sum, n * (n - 1) / 2);
    }

    #[tokio::test]
    async fn register_partitioned_table_empty_list_registers_nothing() {
        let ctx = SessionContext::new();
        register_partitioned_table(&ctx, "t", vec![]).unwrap();
        assert!(ctx.sql("SELECT * FROM t").await.is_err());
    }

    #[tokio::test]
    async fn register_partitioned_table_zero_rows_keeps_schema() {
        let ctx = SessionContext::new();
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, false)]));
        register_partitioned_table(&ctx, "t", vec![RecordBatch::new_empty(schema)]).unwrap();

        let out = ctx
            .sql("SELECT v FROM t")
            .await
            .unwrap()
            .collect()
            .await
            .unwrap();
        let rows: usize = out.iter().map(|b| b.num_rows()).sum();
        assert_eq!(rows, 0);
    }

    #[tokio::test]
    async fn cache_served_table_skips_optimization_and_aggregates() {
        use arrow::array::Float64Array;
        use engine_core::model::column::Column;
        use engine_core::model::table::{StorageMode, Table};
        use engine_core::types::DataType as EngineDataType;

        // Model: one in-memory fact table.
        let table = Table::new(
            "fact_sales",
            vec![
                Column::new("id", EngineDataType::Int64),
                Column::new("amount", EngineDataType::Float64),
            ],
        )
        .unwrap()
        .with_storage_mode(StorageMode::InMemory);
        let model = DataModel::builder().add_table(table).build().unwrap();

        // Cache holds the batch (pre-optimized at refresh time in production).
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, true),
            Field::new("amount", DataType::Float64, true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int64Array::from(vec![1, 2, 3])),
                Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0])),
            ],
        )
        .unwrap();
        let mut cache = InMemoryCache::new();
        cache.store("fact_sales", batch).unwrap();

        // No connector registered: the table must be served from the cache.
        let registry = SourceRegistry::new();
        let fetches = vec![(
            "fact_sales".to_string(),
            engine_connectors::FetchRequest {
                table: "fact_sales".to_string(),
                ..Default::default()
            },
        )];
        let measures = vec![Measure::simple(
            "Total",
            "fact_sales",
            "amount",
            AggregateOp::Sum,
        )];

        let mut plan = PlanNode::new(PlanOperation::LocalAggregation, "test");
        let batches = QueryExecutor::execute_local_aggregation(
            &fetches,
            &measures,
            &[],
            &[],
            &[],
            None,
            TotalsMode::None,
            None,
            &model,
            &registry,
            Some(&cache),
            None,
            None,
            &[],
            Some(&mut plan),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();

        // Result: SUM(amount) = 60.0.
        let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
        let total = combined
            .column(0)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap()
            .value(0);
        assert!((total - 60.0).abs() < 1e-9);

        // The fetch node reports the cache source and the optimization skip.
        let fetch_node = plan
            .children
            .iter()
            .find(|n| n.label == "Cache: fact_sales")
            .expect("cache fetch plan node");
        let prop = |key: &str| {
            fetch_node
                .properties
                .iter()
                .find(|p| p.key == key)
                .map(|p| &p.value)
        };
        match prop("source") {
            Some(PlanValue::Text(s)) => assert_eq!(s, "in_memory_cache"),
            other => panic!("unexpected source property: {other:?}"),
        }
        match prop("optimization") {
            Some(PlanValue::Text(s)) => assert_eq!(s, "cached (pre-optimized)"),
            other => panic!("unexpected optimization property: {other:?}"),
        }
    }
}
