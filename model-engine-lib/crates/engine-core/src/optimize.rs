//! Automatic ingest-time optimization of Arrow `RecordBatch` data.
//!
//! Applies cheap, safe transformations that reduce memory usage without
//! affecting query correctness or adding per-query overhead:
//!
//! - **Integer narrowing**: Downcast `Int64`/`UInt64` columns to the
//!   narrowest integer type that fits the observed min/max values.
//! - **Dictionary encoding**: Wrap low-cardinality `Utf8` columns in
//!   `DictionaryArray<Int32, Utf8>` for better memory density.
//! - **Timestamp narrowing**: Convert `Timestamp` columns to `Date32`
//!   when every value falls on a day boundary (midnight).
//!
//! Designed to run once per ingest (after connector fetch, before cache
//! store) with near-zero cost relative to the network fetch.

use std::collections::HashSet;
use std::sync::Arc;

use arrow::array::{Array, ArrayRef, AsArray, PrimitiveArray};
use arrow::compute::cast;
use arrow::compute::kernels::aggregate::{max, min};
use arrow::datatypes::{
    ArrowPrimitiveType, DataType, Field, Int64Type, Schema, TimeUnit, TimestampMicrosecondType,
    TimestampMillisecondType, TimestampNanosecondType, TimestampSecondType, UInt64Type,
};
use arrow::error::ArrowError;
use arrow::record_batch::RecordBatch;

/// Configuration for the batch optimizer.
#[derive(Debug, Clone)]
pub struct OptimizerConfig {
    /// Downcast Int64/UInt64 to narrower widths when values fit.
    pub narrow_integers: bool,

    /// Dictionary-encode low-cardinality string columns.
    pub dictionary_encode_strings: bool,

    /// Apply dictionary encoding when (distinct / sampled) is below this.
    /// 0.5 means: encode if fewer than half the sampled values are unique.
    pub dictionary_ratio_threshold: f64,

    /// Skip analysis on batches smaller than this row count.
    /// Below ~1k rows the overhead outweighs the savings.
    pub min_rows_to_analyze: usize,

    /// Convert Timestamp to Date32 when every value lands on midnight.
    pub narrow_dates: bool,

    /// Cap on rows scanned for string distinct-counting. Sample-based
    /// with early-exit; full scan adds no real accuracy for this decision.
    pub string_sample_size: usize,
}

impl Default for OptimizerConfig {
    fn default() -> Self {
        Self {
            narrow_integers: true,
            dictionary_encode_strings: true,
            dictionary_ratio_threshold: 0.5,
            min_rows_to_analyze: 1024,
            narrow_dates: true,
            string_sample_size: 8192,
        }
    }
}

/// Statistics about what changed during optimization.
#[derive(Debug, Default, Clone)]
pub struct OptimizationStats {
    /// Number of columns analyzed.
    pub columns_analyzed: usize,
    /// Number of integer columns that were narrowed.
    pub integers_narrowed: usize,
    /// Number of string columns that were dictionary-encoded.
    pub strings_dictionarized: usize,
    /// Number of timestamp columns converted to Date32.
    pub timestamps_to_date: usize,
    /// Original batch size in bytes.
    pub original_size_bytes: usize,
    /// Optimized batch size in bytes.
    pub optimized_size_bytes: usize,
}

impl OptimizationStats {
    /// Fraction of bytes saved, between 0.0 and 1.0.
    pub fn savings_ratio(&self) -> f64 {
        if self.original_size_bytes == 0 {
            return 0.0;
        }
        1.0 - (self.optimized_size_bytes as f64 / self.original_size_bytes as f64)
    }

    /// Returns `true` if any optimization was applied.
    pub fn any_applied(&self) -> bool {
        self.integers_narrowed > 0 || self.strings_dictionarized > 0 || self.timestamps_to_date > 0
    }
}

/// Optimize a `RecordBatch` for memory efficiency.
///
/// Returns the optimized batch and statistics about what changed.
/// If the batch is too small to benefit (below `config.min_rows_to_analyze`),
/// it is returned unchanged.
///
/// # Errors
///
/// Returns `ArrowError` if an internal Arrow cast operation fails (should
/// not happen given the min/max checks, but propagated for safety).
pub fn optimize_batch(
    batch: &RecordBatch,
    config: &OptimizerConfig,
) -> Result<(RecordBatch, OptimizationStats), ArrowError> {
    let mut stats = OptimizationStats {
        original_size_bytes: batch_memory_size(batch),
        ..Default::default()
    };

    if batch.num_rows() < config.min_rows_to_analyze {
        stats.optimized_size_bytes = stats.original_size_bytes;
        return Ok((batch.clone(), stats));
    }

    let mut new_columns: Vec<ArrayRef> = Vec::with_capacity(batch.num_columns());
    let mut new_fields: Vec<Field> = Vec::with_capacity(batch.num_columns());

    for (i, column) in batch.columns().iter().enumerate() {
        let original_field = batch.schema().field(i).clone();
        stats.columns_analyzed += 1;

        let (optimized, optimized_field) =
            optimize_column(column, &original_field, config, &mut stats)?;

        new_columns.push(optimized);
        new_fields.push(optimized_field);
    }

    let new_schema = Arc::new(Schema::new(new_fields));
    let new_batch = RecordBatch::try_new(new_schema, new_columns)?;

    stats.optimized_size_bytes = batch_memory_size(&new_batch);
    Ok((new_batch, stats))
}

/// Compute the memory size of a `RecordBatch` in bytes.
fn batch_memory_size(batch: &RecordBatch) -> usize {
    batch
        .columns()
        .iter()
        .map(|c| c.get_array_memory_size())
        .sum()
}

fn optimize_column(
    column: &ArrayRef,
    field: &Field,
    config: &OptimizerConfig,
    stats: &mut OptimizationStats,
) -> Result<(ArrayRef, Field), ArrowError> {
    match column.data_type() {
        DataType::Int64 if config.narrow_integers => narrow_int64(column, field, stats),
        DataType::UInt64 if config.narrow_integers => narrow_uint64(column, field, stats),
        DataType::Utf8 if config.dictionary_encode_strings => {
            dictionary_encode_string(column, field, config, stats)
        }
        DataType::LargeUtf8 if config.dictionary_encode_strings => {
            dictionary_encode_large_string(column, field, config, stats)
        }
        DataType::Timestamp(_, _) if config.narrow_dates => {
            try_narrow_timestamp_to_date(column, field, stats)
        }
        _ => Ok((column.clone(), field.clone())),
    }
}

// --- Integer narrowing ---

fn narrow_int64(
    column: &ArrayRef,
    field: &Field,
    stats: &mut OptimizationStats,
) -> Result<(ArrayRef, Field), ArrowError> {
    let array = column.as_primitive::<Int64Type>();
    let min_val = min(array);
    let max_val = max(array);

    let target = match (min_val, max_val) {
        (Some(lo), Some(hi)) => choose_signed_target(lo, hi),
        _ => DataType::Int64, // All-null — leave unchanged.
    };

    if target == DataType::Int64 {
        return Ok((column.clone(), field.clone()));
    }

    let narrowed = cast(column, &target)?;
    let new_field = Field::new(field.name(), target, field.is_nullable());
    stats.integers_narrowed += 1;
    Ok((narrowed, new_field))
}

fn choose_signed_target(min_v: i64, max_v: i64) -> DataType {
    if min_v >= i8::MIN as i64 && max_v <= i8::MAX as i64 {
        DataType::Int8
    } else if min_v >= i16::MIN as i64 && max_v <= i16::MAX as i64 {
        DataType::Int16
    } else if min_v >= i32::MIN as i64 && max_v <= i32::MAX as i64 {
        DataType::Int32
    } else {
        DataType::Int64
    }
}

fn narrow_uint64(
    column: &ArrayRef,
    field: &Field,
    stats: &mut OptimizationStats,
) -> Result<(ArrayRef, Field), ArrowError> {
    let array = column.as_primitive::<UInt64Type>();
    let max_val = max(array);

    let target = match max_val {
        Some(hi) => choose_unsigned_target(hi),
        None => DataType::UInt64,
    };

    if target == DataType::UInt64 {
        return Ok((column.clone(), field.clone()));
    }

    let narrowed = cast(column, &target)?;
    let new_field = Field::new(field.name(), target, field.is_nullable());
    stats.integers_narrowed += 1;
    Ok((narrowed, new_field))
}

fn choose_unsigned_target(max_v: u64) -> DataType {
    if max_v <= u8::MAX as u64 {
        DataType::UInt8
    } else if max_v <= u16::MAX as u64 {
        DataType::UInt16
    } else if max_v <= u32::MAX as u64 {
        DataType::UInt32
    } else {
        DataType::UInt64
    }
}

// --- String dictionary encoding ---

fn dictionary_encode_string(
    column: &ArrayRef,
    field: &Field,
    config: &OptimizerConfig,
    stats: &mut OptimizationStats,
) -> Result<(ArrayRef, Field), ArrowError> {
    let array = column.as_string::<i32>();
    let total_rows = array.len();
    let sample_size = config.string_sample_size.min(total_rows);

    let max_distinct_allowed = (sample_size as f64 * config.dictionary_ratio_threshold) as usize;

    let mut distinct: HashSet<&str> = HashSet::with_capacity(max_distinct_allowed + 16);
    for i in 0..sample_size {
        if array.is_valid(i) {
            distinct.insert(array.value(i));
            if distinct.len() > max_distinct_allowed {
                return Ok((column.clone(), field.clone()));
            }
        }
    }

    let dict_type = DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8));
    let encoded = cast(column, &dict_type)?;
    let new_field = Field::new(field.name(), dict_type, field.is_nullable());
    stats.strings_dictionarized += 1;
    Ok((encoded, new_field))
}

fn dictionary_encode_large_string(
    column: &ArrayRef,
    field: &Field,
    config: &OptimizerConfig,
    stats: &mut OptimizationStats,
) -> Result<(ArrayRef, Field), ArrowError> {
    let array = column.as_string::<i64>();
    let total_rows = array.len();
    let sample_size = config.string_sample_size.min(total_rows);

    let max_distinct_allowed = (sample_size as f64 * config.dictionary_ratio_threshold) as usize;

    let mut distinct: HashSet<&str> = HashSet::with_capacity(max_distinct_allowed + 16);
    for i in 0..sample_size {
        if array.is_valid(i) {
            distinct.insert(array.value(i));
            if distinct.len() > max_distinct_allowed {
                return Ok((column.clone(), field.clone()));
            }
        }
    }

    let dict_type = DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::LargeUtf8));
    let encoded = cast(column, &dict_type)?;
    let new_field = Field::new(field.name(), dict_type, field.is_nullable());
    stats.strings_dictionarized += 1;
    Ok((encoded, new_field))
}

// --- Timestamp narrowing ---

fn try_narrow_timestamp_to_date(
    column: &ArrayRef,
    field: &Field,
    stats: &mut OptimizationStats,
) -> Result<(ArrayRef, Field), ArrowError> {
    let all_midnight = match column.data_type() {
        DataType::Timestamp(TimeUnit::Nanosecond, _) => {
            all_values_at_midnight::<TimestampNanosecondType>(
                column.as_primitive::<TimestampNanosecondType>(),
                86_400_000_000_000,
            )
        }
        DataType::Timestamp(TimeUnit::Microsecond, _) => {
            all_values_at_midnight::<TimestampMicrosecondType>(
                column.as_primitive::<TimestampMicrosecondType>(),
                86_400_000_000,
            )
        }
        DataType::Timestamp(TimeUnit::Millisecond, _) => {
            all_values_at_midnight::<TimestampMillisecondType>(
                column.as_primitive::<TimestampMillisecondType>(),
                86_400_000,
            )
        }
        DataType::Timestamp(TimeUnit::Second, _) => all_values_at_midnight::<TimestampSecondType>(
            column.as_primitive::<TimestampSecondType>(),
            86_400,
        ),
        _ => false,
    };

    if !all_midnight {
        return Ok((column.clone(), field.clone()));
    }

    let date_array = cast(column, &DataType::Date32)?;
    let new_field = Field::new(field.name(), DataType::Date32, field.is_nullable());
    stats.timestamps_to_date += 1;
    Ok((date_array, new_field))
}

fn all_values_at_midnight<T>(array: &PrimitiveArray<T>, units_per_day: i64) -> bool
where
    T: ArrowPrimitiveType<Native = i64>,
{
    if array.is_empty() || array.null_count() == array.len() {
        return false;
    }
    for i in 0..array.len() {
        if array.is_valid(i) && array.value(i) % units_per_day != 0 {
            return false;
        }
    }
    true
}

// --- Sort on load ---

/// Sort a `RecordBatch` by the specified column name (ascending, nulls last).
///
/// Used to sort cached tables by their primary join/filter key, which improves:
/// - Hash join probe locality (grouped key values → better cache behavior)
/// - Dictionary encoding effectiveness (sorted strings → longer runs)
/// - Filter scan efficiency when predicates target the sort column
///
/// Returns the batch unchanged if the column is not found (graceful no-op).
///
/// # Errors
///
/// Returns `ArrowError` if the Arrow sort or take operation fails.
pub fn sort_batch_by_column(
    batch: &RecordBatch,
    column_name: &str,
) -> Result<RecordBatch, ArrowError> {
    let col_idx = match batch.schema().index_of(column_name) {
        Ok(idx) => idx,
        Err(_) => return Ok(batch.clone()),
    };

    if batch.num_rows() <= 1 {
        return Ok(batch.clone());
    }

    let sort_column = arrow::compute::SortColumn {
        values: batch.column(col_idx).clone(),
        options: Some(arrow::compute::SortOptions {
            descending: false,
            nulls_first: false,
        }),
    };

    let indices = arrow::compute::lexsort_to_indices(&[sort_column], None)?;

    let sorted_columns: Vec<ArrayRef> = batch
        .columns()
        .iter()
        .map(|col| arrow::compute::take(col.as_ref(), &indices, None))
        .collect::<Result<Vec<_>, _>>()?;

    RecordBatch::try_new(batch.schema(), sorted_columns)
}

/// Determine the best sort column for a table based on its relationships.
///
/// Heuristic:
/// - If the table is the "from" (fact/many) side of a relationship, sort by
///   the first equi-join FK column (most-used join key).
/// - If the table is the "to" (dimension/one) side, sort by the first equi-join
///   PK column.
/// - If the table appears in multiple relationships, prefer the "from" side
///   (fact tables benefit more from sorting).
/// - Returns `None` if no equi-join relationships exist for this table.
pub fn infer_sort_column<'a>(
    table_name: &str,
    relationships: &'a [crate::model::Relationship],
) -> Option<&'a str> {
    // Prefer "from" side (fact table FK) — most impactful for join performance.
    for rel in relationships {
        if rel.from_table() == table_name {
            if let Some(cond) = rel
                .conditions()
                .iter()
                .find(|c| c.operator() == crate::model::JoinOperator::Equal)
            {
                return Some(cond.from_column());
            }
        }
    }

    // Fall back to "to" side (dimension PK).
    for rel in relationships {
        if rel.to_table() == table_name {
            if let Some(cond) = rel
                .conditions()
                .iter()
                .find(|c| c.operator() == crate::model::JoinOperator::Equal)
            {
                return Some(cond.to_column());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{
        Int64Array, StringArray, TimestampMicrosecondArray, TimestampMillisecondArray, UInt64Array,
    };

    fn cfg() -> OptimizerConfig {
        OptimizerConfig {
            min_rows_to_analyze: 1, // Allow tiny test batches.
            ..Default::default()
        }
    }

    fn make_batch(fields: Vec<Field>, columns: Vec<ArrayRef>) -> RecordBatch {
        let schema = Arc::new(Schema::new(fields));
        RecordBatch::try_new(schema, columns).unwrap()
    }

    // --- Integer narrowing tests ---

    #[test]
    fn narrows_int64_to_int8() {
        let col: ArrayRef = Arc::new(Int64Array::from(vec![1i64, 2, 3, -10, 100]));
        let batch = make_batch(vec![Field::new("x", DataType::Int64, false)], vec![col]);

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Int8);
        assert_eq!(stats.integers_narrowed, 1);
    }

    #[test]
    fn narrows_int64_to_int16() {
        let col: ArrayRef = Arc::new(Int64Array::from(vec![0i64, 1000, -500]));
        let batch = make_batch(vec![Field::new("x", DataType::Int64, false)], vec![col]);

        let (out, _) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Int16);
    }

    #[test]
    fn narrows_int64_to_int32() {
        let col: ArrayRef = Arc::new(Int64Array::from(vec![0i64, 100_000]));
        let batch = make_batch(vec![Field::new("x", DataType::Int64, false)], vec![col]);

        let (out, _) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Int32);
    }

    #[test]
    fn leaves_large_int64_alone() {
        let col: ArrayRef = Arc::new(Int64Array::from(vec![0i64, i64::MAX]));
        let batch = make_batch(vec![Field::new("x", DataType::Int64, false)], vec![col]);

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Int64);
        assert_eq!(stats.integers_narrowed, 0);
    }

    #[test]
    fn narrows_uint64_to_uint8() {
        let col: ArrayRef = Arc::new(UInt64Array::from(vec![0u64, 50, 200]));
        let batch = make_batch(vec![Field::new("x", DataType::UInt64, false)], vec![col]);

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::UInt8);
        assert_eq!(stats.integers_narrowed, 1);
    }

    #[test]
    fn narrows_uint64_to_uint16() {
        let col: ArrayRef = Arc::new(UInt64Array::from(vec![0u64, 1000]));
        let batch = make_batch(vec![Field::new("x", DataType::UInt64, false)], vec![col]);

        let (out, _) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::UInt16);
    }

    #[test]
    fn all_null_int64_unchanged() {
        let col: ArrayRef = Arc::new(Int64Array::from(vec![None, None, None]));
        let batch = make_batch(vec![Field::new("x", DataType::Int64, true)], vec![col]);

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Int64);
        assert_eq!(stats.integers_narrowed, 0);
    }

    // --- String dictionary encoding tests ---

    #[test]
    fn dict_encodes_low_cardinality_strings() {
        let values: Vec<&str> = (0..2000)
            .map(|i| if i % 2 == 0 { "SE" } else { "NO" })
            .collect();
        let col: ArrayRef = Arc::new(StringArray::from(values));
        let batch = make_batch(
            vec![Field::new("country", DataType::Utf8, false)],
            vec![col],
        );

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert!(matches!(
            out.schema().field(0).data_type(),
            DataType::Dictionary(_, _)
        ));
        assert_eq!(stats.strings_dictionarized, 1);
    }

    #[test]
    fn leaves_high_cardinality_strings_alone() {
        let values: Vec<String> = (0..2000).map(|i| format!("user_{i}")).collect();
        let col: ArrayRef = Arc::new(StringArray::from(
            values.iter().map(String::as_str).collect::<Vec<_>>(),
        ));
        let batch = make_batch(
            vec![Field::new("user_id", DataType::Utf8, false)],
            vec![col],
        );

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Utf8);
        assert_eq!(stats.strings_dictionarized, 0);
    }

    #[test]
    fn dict_encodes_with_nulls() {
        let values: Vec<Option<&str>> = (0..2000)
            .map(|i| {
                if i % 10 == 0 {
                    None
                } else if i % 2 == 0 {
                    Some("A")
                } else {
                    Some("B")
                }
            })
            .collect();
        let col: ArrayRef = Arc::new(StringArray::from(values));
        let batch = make_batch(vec![Field::new("status", DataType::Utf8, true)], vec![col]);

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert!(matches!(
            out.schema().field(0).data_type(),
            DataType::Dictionary(_, _)
        ));
        assert_eq!(stats.strings_dictionarized, 1);
    }

    // --- Timestamp narrowing tests ---

    #[test]
    fn converts_midnight_timestamps_to_date() {
        // 2024-01-01 and 2024-01-02 as ms since epoch.
        let col: ArrayRef = Arc::new(TimestampMillisecondArray::from(vec![
            1_704_067_200_000i64,
            1_704_153_600_000,
        ]));
        let batch = make_batch(
            vec![Field::new(
                "d",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                false,
            )],
            vec![col],
        );

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Date32);
        assert_eq!(stats.timestamps_to_date, 1);
    }

    #[test]
    fn leaves_non_midnight_timestamps_alone() {
        // 2024-01-01 00:00:00 and 2024-01-01 12:30:00 in ms.
        let col: ArrayRef = Arc::new(TimestampMillisecondArray::from(vec![
            1_704_067_200_000i64,
            1_704_067_200_000 + 45_000_000, // +12.5 hours
        ]));
        let batch = make_batch(
            vec![Field::new(
                "ts",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                false,
            )],
            vec![col],
        );

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(
            out.schema().field(0).data_type(),
            &DataType::Timestamp(TimeUnit::Millisecond, None)
        );
        assert_eq!(stats.timestamps_to_date, 0);
    }

    #[test]
    fn converts_microsecond_timestamps_to_date() {
        let col: ArrayRef = Arc::new(TimestampMicrosecondArray::from(vec![
            1_704_067_200_000_000i64,
            1_704_153_600_000_000,
        ]));
        let batch = make_batch(
            vec![Field::new(
                "d",
                DataType::Timestamp(TimeUnit::Microsecond, None),
                false,
            )],
            vec![col],
        );

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Date32);
        assert_eq!(stats.timestamps_to_date, 1);
    }

    // --- Edge cases ---

    #[test]
    fn skips_small_batches() {
        let col: ArrayRef = Arc::new(Int64Array::from(vec![1i64, 2, 3]));
        let batch = make_batch(vec![Field::new("x", DataType::Int64, false)], vec![col]);

        let config = OptimizerConfig::default(); // min_rows_to_analyze = 1024
        let (out, stats) = optimize_batch(&batch, &config).unwrap();
        // Should return unchanged.
        assert_eq!(out.schema().field(0).data_type(), &DataType::Int64);
        assert_eq!(stats.columns_analyzed, 0);
    }

    #[test]
    fn multi_column_batch() {
        let int_col: ArrayRef = Arc::new(Int64Array::from(vec![1i64; 2000]));
        let str_col: ArrayRef = Arc::new(StringArray::from(vec!["active"; 2000]));
        let ts_col: ArrayRef = Arc::new(TimestampMillisecondArray::from(vec![
            1_704_067_200_000i64;
            2000
        ]));

        let batch = make_batch(
            vec![
                Field::new("id", DataType::Int64, false),
                Field::new("status", DataType::Utf8, false),
                Field::new(
                    "date",
                    DataType::Timestamp(TimeUnit::Millisecond, None),
                    false,
                ),
            ],
            vec![int_col, str_col, ts_col],
        );

        let (out, stats) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Int8);
        assert!(matches!(
            out.schema().field(1).data_type(),
            DataType::Dictionary(_, _)
        ));
        assert_eq!(out.schema().field(2).data_type(), &DataType::Date32);
        assert_eq!(stats.integers_narrowed, 1);
        assert_eq!(stats.strings_dictionarized, 1);
        assert_eq!(stats.timestamps_to_date, 1);
        assert_eq!(stats.columns_analyzed, 3);
        assert!(stats.savings_ratio() > 0.0);
    }

    #[test]
    fn preserves_row_count() {
        let col: ArrayRef = Arc::new(Int64Array::from(vec![5i64; 5000]));
        let batch = make_batch(vec![Field::new("x", DataType::Int64, false)], vec![col]);

        let (out, _) = optimize_batch(&batch, &cfg()).unwrap();
        assert_eq!(out.num_rows(), 5000);
    }

    #[test]
    fn config_disables_integer_narrowing() {
        let col: ArrayRef = Arc::new(Int64Array::from(vec![1i64, 2, 3]));
        let batch = make_batch(vec![Field::new("x", DataType::Int64, false)], vec![col]);

        let config = OptimizerConfig {
            narrow_integers: false,
            min_rows_to_analyze: 1,
            ..Default::default()
        };
        let (out, stats) = optimize_batch(&batch, &config).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Int64);
        assert_eq!(stats.integers_narrowed, 0);
    }

    #[test]
    fn config_disables_dictionary_encoding() {
        let values: Vec<&str> = (0..2000).map(|_| "same").collect();
        let col: ArrayRef = Arc::new(StringArray::from(values));
        let batch = make_batch(vec![Field::new("s", DataType::Utf8, false)], vec![col]);

        let config = OptimizerConfig {
            dictionary_encode_strings: false,
            min_rows_to_analyze: 1,
            ..Default::default()
        };
        let (out, stats) = optimize_batch(&batch, &config).unwrap();
        assert_eq!(out.schema().field(0).data_type(), &DataType::Utf8);
        assert_eq!(stats.strings_dictionarized, 0);
    }

    // --- Sort on load tests ---

    #[test]
    fn sort_batch_by_int_column() {
        use arrow::array::Int32Array;

        let ids: ArrayRef = Arc::new(Int32Array::from(vec![3, 1, 4, 1, 5]));
        let names: ArrayRef = Arc::new(StringArray::from(vec!["c", "a", "d", "a2", "e"]));
        let batch = make_batch(
            vec![
                Field::new("id", DataType::Int32, false),
                Field::new("name", DataType::Utf8, false),
            ],
            vec![ids, names],
        );

        let sorted = sort_batch_by_column(&batch, "id").unwrap();
        let sorted_ids = sorted
            .column(0)
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap();
        assert_eq!(sorted_ids.values(), &[1, 1, 3, 4, 5]);
        // Corresponding names should follow.
        let sorted_names = sorted
            .column(1)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        assert_eq!(sorted_names.value(0), "a");
        assert_eq!(sorted_names.value(1), "a2");
    }

    #[test]
    fn sort_batch_by_string_column() {
        use arrow::array::Int32Array;

        let ids: ArrayRef = Arc::new(Int32Array::from(vec![1, 2, 3]));
        let cats: ArrayRef = Arc::new(StringArray::from(vec!["Z", "A", "M"]));
        let batch = make_batch(
            vec![
                Field::new("id", DataType::Int32, false),
                Field::new("category", DataType::Utf8, false),
            ],
            vec![ids, cats],
        );

        let sorted = sort_batch_by_column(&batch, "category").unwrap();
        let sorted_cats = sorted
            .column(1)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        assert_eq!(sorted_cats.value(0), "A");
        assert_eq!(sorted_cats.value(1), "M");
        assert_eq!(sorted_cats.value(2), "Z");
    }

    #[test]
    fn sort_batch_missing_column_is_noop() {
        use arrow::array::Int32Array;

        let ids: ArrayRef = Arc::new(Int32Array::from(vec![3, 1, 2]));
        let batch = make_batch(vec![Field::new("id", DataType::Int32, false)], vec![ids]);

        let sorted = sort_batch_by_column(&batch, "nonexistent").unwrap();
        let sorted_ids = sorted
            .column(0)
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap();
        // Unchanged order.
        assert_eq!(sorted_ids.values(), &[3, 1, 2]);
    }

    #[test]
    fn sort_batch_with_nulls() {
        use arrow::array::Int32Array;

        let ids: ArrayRef = Arc::new(Int32Array::from(vec![Some(3), None, Some(1), None]));
        let batch = make_batch(vec![Field::new("id", DataType::Int32, true)], vec![ids]);

        let sorted = sort_batch_by_column(&batch, "id").unwrap();
        let sorted_ids = sorted
            .column(0)
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap();
        // Nulls last: 1, 3, null, null.
        assert_eq!(sorted_ids.value(0), 1);
        assert_eq!(sorted_ids.value(1), 3);
        assert!(sorted_ids.is_null(2));
        assert!(sorted_ids.is_null(3));
    }

    #[test]
    fn sort_single_row_is_noop() {
        use arrow::array::Int32Array;

        let ids: ArrayRef = Arc::new(Int32Array::from(vec![42]));
        let batch = make_batch(vec![Field::new("id", DataType::Int32, false)], vec![ids]);

        let sorted = sort_batch_by_column(&batch, "id").unwrap();
        assert_eq!(sorted.num_rows(), 1);
    }

    #[test]
    fn infer_sort_column_from_fact_table() {
        use crate::model::Relationship;

        let rel =
            Relationship::many_to_one("Sales_Products", "Sales", "product_id", "Products", "id");
        let rels = vec![rel];

        // Fact table (from side) → sort by FK.
        assert_eq!(infer_sort_column("Sales", &rels), Some("product_id"));
    }

    #[test]
    fn infer_sort_column_from_dimension_table() {
        use crate::model::Relationship;

        let rel =
            Relationship::many_to_one("Sales_Products", "Sales", "product_id", "Products", "id");
        let rels = vec![rel];

        // Dimension table (to side) → sort by PK.
        assert_eq!(infer_sort_column("Products", &rels), Some("id"));
    }

    #[test]
    fn infer_sort_column_prefers_from_side() {
        use crate::model::Relationship;

        // A table that is both "from" in one rel and "to" in another.
        let rel1 = Relationship::many_to_one(
            "Orders_Customers",
            "Orders",
            "customer_id",
            "Customers",
            "id",
        );
        let rel2 =
            Relationship::many_to_one("LineItems_Orders", "LineItems", "order_id", "Orders", "id");
        let rels = vec![rel1, rel2];

        // "Orders" is from in rel1 → prefers FK column.
        assert_eq!(infer_sort_column("Orders", &rels), Some("customer_id"));
    }

    #[test]
    fn infer_sort_column_no_relationships() {
        assert_eq!(infer_sort_column("Orphan", &[]), None);
    }
}
