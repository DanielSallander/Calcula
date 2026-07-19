//! Tie-inclusive TOP-N over a materialized QUERY intermediate batch.
//!
//! Implements the `QUERY(... TOP n BY alias [ASC])` clause (see
//! [`QueryTop`](crate::compute::expression::QueryTop)): after the grouped
//! materialization, only the rows ranking in the first `limit` positions by
//! the ranked column are kept — **tie-inclusive** (every row tied with the
//! boundary value survives, mirroring DAX `TOPN` and the request-level
//! `top_n`), and **per partition** when the query was re-evaluated per outer
//! group (the injected outer group-by columns form the partition).

use std::cmp::Ordering;
use std::collections::HashMap;

use arrow::array::{Array, Float64Array, Int32Array, Int64Array, UInt64Array};
use arrow::compute::take;
use arrow::record_batch::RecordBatch;
use arrow::util::display::array_value_to_string;

use crate::compute::expression::QueryTop;
use crate::error::{EngineError, EngineResult};

/// Apply a [`QueryTop`] spec to a materialized QUERY batch.
///
/// `partition_columns` are the batch's OUTPUT column names that partition the
/// ranking — the outer group-by columns injected into the QUERY's group-by
/// (empty = one global partition). The ranked column must be numeric.
/// NULL ranked values sort last (kept only when the boundary itself is NULL).
/// Row order within the result preserves the input order.
pub fn apply_query_top(
    batch: &RecordBatch,
    top: &QueryTop,
    partition_columns: &[String],
) -> EngineResult<RecordBatch> {
    let limit = top.limit as usize;
    // Build-time validation rejects limit 0; re-check defensively (a zero
    // limit would underflow the boundary index below).
    if limit == 0 {
        return Err(EngineError::InvalidExpression(
            "QUERY TOP: the row count must be at least 1".to_string(),
        ));
    }
    let by_idx = batch
        .schema()
        .fields()
        .iter()
        .position(|f| f.name().eq_ignore_ascii_case(&top.by))
        .ok_or_else(|| {
            EngineError::InvalidExpression(format!(
                "QUERY TOP: ranked column '{}' is not in the materialized output",
                top.by
            ))
        })?;
    // Nothing to trim (and only one global partition): the whole batch ranks
    // within the limit. Validation above still ran.
    if batch.num_rows() <= limit && partition_columns.is_empty() {
        return Ok(batch.clone());
    }
    let by_array = batch.column(by_idx);
    let values: Vec<Option<f64>> = if let Some(a) = by_array.as_any().downcast_ref::<Float64Array>()
    {
        (0..a.len())
            .map(|i| (!a.is_null(i)).then(|| a.value(i)))
            .collect()
    } else if let Some(a) = by_array.as_any().downcast_ref::<Int64Array>() {
        (0..a.len())
            .map(|i| (!a.is_null(i)).then(|| a.value(i) as f64))
            .collect()
    } else if let Some(a) = by_array.as_any().downcast_ref::<Int32Array>() {
        (0..a.len())
            .map(|i| (!a.is_null(i)).then(|| a.value(i) as f64))
            .collect()
    } else if let Some(a) = by_array.as_any().downcast_ref::<UInt64Array>() {
        (0..a.len())
            .map(|i| (!a.is_null(i)).then(|| a.value(i) as f64))
            .collect()
    } else {
        return Err(EngineError::InvalidExpression(format!(
            "QUERY TOP: ranked column '{}' must be numeric, got {:?}",
            top.by,
            by_array.data_type()
        )));
    };

    // Partition rows by the (stringified) injected outer group-by values.
    let partition_arrays: Vec<&dyn Array> = partition_columns
        .iter()
        .map(|name| {
            batch
                .schema()
                .fields()
                .iter()
                .position(|f| f.name().eq_ignore_ascii_case(name))
                .map(|i| batch.column(i).as_ref())
                .ok_or_else(|| {
                    EngineError::InvalidExpression(format!(
                        "QUERY TOP: partition column '{name}' is not in the materialized output"
                    ))
                })
        })
        .collect::<EngineResult<_>>()?;

    let mut partitions: HashMap<String, Vec<usize>> = HashMap::new();
    for row in 0..batch.num_rows() {
        let mut key = String::new();
        for arr in &partition_arrays {
            if arr.is_null(row) {
                key.push_str("\u{1}<null>");
            } else {
                key.push('\u{1}');
                key.push_str(&array_value_to_string(*arr, row).unwrap_or_default());
            }
        }
        partitions.entry(key).or_default().push(row);
    }

    // Rank comparator: by value in rank direction, NULLs last.
    let cmp = |a: &Option<f64>, b: &Option<f64>| -> Ordering {
        match (a, b) {
            (Some(x), Some(y)) => {
                let o = x.partial_cmp(y).unwrap_or(Ordering::Equal);
                if top.ascending {
                    o
                } else {
                    o.reverse()
                }
            }
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        }
    };

    let mut kept: Vec<usize> = Vec::new();
    for rows in partitions.values() {
        if rows.len() <= limit {
            kept.extend(rows.iter().copied());
            continue;
        }
        let mut sorted: Vec<usize> = rows.clone();
        sorted.sort_by(|&a, &b| cmp(&values[a], &values[b]));
        // Tie-inclusive boundary: the limit-th ranked value; keep every row
        // that does not rank strictly after it.
        let boundary = values[sorted[limit - 1]];
        kept.extend(
            sorted
                .into_iter()
                .take_while(|&i| cmp(&values[i], &boundary) != Ordering::Greater),
        );
    }
    kept.sort_unstable();

    let indices = UInt64Array::from(kept.iter().map(|&i| i as u64).collect::<Vec<u64>>());
    let columns = batch
        .columns()
        .iter()
        .map(|c| take(c.as_ref(), &indices, None))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RecordBatch::try_new(batch.schema(), columns)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::StringArray;
    use arrow::datatypes::{DataType, Field, Schema};
    use std::sync::Arc;

    fn batch(names: Vec<&str>, groups: Vec<&str>, amounts: Vec<Option<f64>>) -> RecordBatch {
        RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("name", DataType::Utf8, true),
                Field::new("grp", DataType::Utf8, true),
                Field::new("a", DataType::Float64, true),
            ])),
            vec![
                Arc::new(StringArray::from(names)),
                Arc::new(StringArray::from(groups)),
                Arc::new(Float64Array::from(amounts)),
            ],
        )
        .unwrap()
    }

    fn spec(limit: u32, ascending: bool) -> QueryTop {
        QueryTop {
            by: "a".into(),
            limit,
            ascending,
        }
    }

    fn kept_names(b: &RecordBatch) -> Vec<String> {
        let n = b.column(0).as_any().downcast_ref::<StringArray>().unwrap();
        (0..b.num_rows()).map(|i| n.value(i).to_string()).collect()
    }

    #[test]
    fn top_n_keeps_highest_and_is_tie_inclusive() {
        // amounts: bikes 130, helmets 60, tires 60, gloves 20 → TOP 2 keeps
        // bikes + BOTH 60s (tie at the boundary).
        let b = batch(
            vec!["bikes", "helmets", "tires", "gloves"],
            vec!["x", "x", "x", "x"],
            vec![Some(130.0), Some(60.0), Some(60.0), Some(20.0)],
        );
        let out = apply_query_top(&b, &spec(2, false), &[]).unwrap();
        assert_eq!(kept_names(&out), vec!["bikes", "helmets", "tires"]);
    }

    #[test]
    fn bottom_n_via_ascending() {
        let b = batch(
            vec!["bikes", "helmets", "gloves"],
            vec!["x", "x", "x"],
            vec![Some(130.0), Some(60.0), Some(20.0)],
        );
        let out = apply_query_top(&b, &spec(1, true), &[]).unwrap();
        assert_eq!(kept_names(&out), vec!["gloves"]);
    }

    #[test]
    fn partitioned_top_n_ranks_within_each_group() {
        // grp p: 3 rows; grp q: 2 rows. TOP 1 per partition.
        let b = batch(
            vec!["a1", "a2", "a3", "b1", "b2"],
            vec!["p", "p", "p", "q", "q"],
            vec![Some(1.0), Some(5.0), Some(3.0), Some(9.0), Some(2.0)],
        );
        let out = apply_query_top(&b, &spec(1, false), &["grp".to_string()]).unwrap();
        assert_eq!(kept_names(&out), vec!["a2", "b1"]);
    }

    #[test]
    fn null_ranked_values_sort_last() {
        let b = batch(
            vec!["a", "b", "c"],
            vec!["x", "x", "x"],
            vec![None, Some(2.0), Some(1.0)],
        );
        let out = apply_query_top(&b, &spec(2, false), &[]).unwrap();
        assert_eq!(kept_names(&out), vec!["b", "c"]);
    }

    #[test]
    fn missing_by_column_is_a_typed_error() {
        let b = batch(vec!["a"], vec!["x"], vec![Some(1.0)]);
        let bad = QueryTop {
            by: "nope".into(),
            limit: 1,
            ascending: false,
        };
        assert!(apply_query_top(&b, &bad, &[]).is_err());
    }
}
