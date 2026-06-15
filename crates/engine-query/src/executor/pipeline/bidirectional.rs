//! Reverse (fact → dimension) filter propagation for relationships marked
//! [`FilterPropagation::Both`].
//!
//! The standard two-phase fetch (see `local_aggregation.rs`) propagates
//! filters in one direction only: a filtered dimension's join keys become an
//! IN filter on the fact table. For a relationship explicitly marked `Both`,
//! this module adds the reverse direction at fetch level: when the fact side
//! carries filters (query filters on the fact table, pushed context filters,
//! or IN filters propagated from *other* filtered dimensions), the filtered
//! fact's distinct join-key values are applied as an IN filter on the
//! dimension's fetch. Dimension-side aggregates (e.g. `DISTINCTCOUNT` over a
//! dimension attribute, evaluated by the multi-fact-table path with no join
//! to the fact) then reflect only members related to the filtered fact rows
//! — Power BI's bidirectional behavior.
//!
//! # Scope and cost (v1 contract)
//!
//! - Activates **only** when `propagation == Both` on the active
//!   relationship; `Auto` / `None` keep the previous behavior exactly.
//! - Only single-condition equality relationships participate (the same
//!   restriction as the forward IN-list propagation).
//! - The propagation source is always a measure (fact) table; the target is
//!   any other table in the fetch set on the opposite side of the `Both`
//!   relationship.
//! - **One round only**: reverse-filtered dimensions do not re-propagate to
//!   other tables. Multi-hop bidirectional chains are not transitive in v1.
//! - An unfiltered fact propagates nothing — no extra fetch is issued.
//! - A fact filtered down to zero rows applies **no** reverse filter (SQL
//!   cannot render an empty IN list, and connectors skip empty IN filters);
//!   the dimension stays unfiltered in that edge case.
//! - Cost: for a connector-backed fact this is one **extra narrow fetch**
//!   per `Both` relationship (a single-column projection of the join key
//!   under the fact's accumulated filters; values are deduplicated locally
//!   by [`extract_column_values`]). For a cache-served fact the keys are
//!   computed locally from the already-filtered cached batches — no fetch.
//!   Oversized key lists on the dimension fetch reuse the connectors'
//!   existing temp-table strategy (`max_inline_in_values`).
//!
//! Pushed single-statement plans (`PushedAggregation`,
//! `PushedJoinAggregation`) need none of this: their `INNER JOIN` already
//! filters both ways within the statement (see `planner/pushdown/mod.rs`).

use std::collections::HashMap;

use arrow::array::{Array, BooleanArray, StringArray};
use arrow::record_batch::RecordBatch;
use tokio_util::sync::CancellationToken;

use engine_connectors::traits::InValueKind;
use engine_connectors::{FetchRequest, InFilterCondition};
use engine_core::model::{DataModel, FilterPropagation};

use crate::error::{QueryError, QueryResult};
use crate::executor::cancel::race_cancelled;
use crate::registry::SourceRegistry;

use super::fetch::extract_column_values;

/// A reverse-propagated IN filter targeting a dimension fetch, produced for
/// a [`FilterPropagation::Both`] relationship.
pub(super) struct BidirectionalFilter {
    /// The IN filter to apply to the dimension (column = the dimension-side
    /// join key, values = the filtered fact's distinct key values).
    pub in_filter: InFilterCondition,
    /// The measure (fact) table the keys were extracted from, for plan
    /// reporting.
    pub via_fact: String,
}

/// Compute reverse (fact → dimension) IN filters for every active
/// single-condition equality relationship marked [`FilterPropagation::Both`]
/// whose fact side is a filtered measure table and whose dimension side is
/// in the fetch set.
///
/// Returns a map keyed by lowercase dimension table name. Callers apply the
/// filters remotely (phase-2 connector fetches) or locally (cache-served and
/// phase-1 pre-fetched dimensions).
///
/// `inmemory_results` carries cache-served tables whose batches already had
/// their `FetchRequest` filters applied; for a cache-served fact, the
/// dimension-propagated IN filters in `in_filters_by_table` are additionally
/// applied locally here before key extraction (cached facts never receive
/// them remotely).
#[allow(clippy::too_many_arguments)]
pub(super) async fn compute_bidirectional_filters(
    fetches: &[(String, FetchRequest)],
    measure_table_names: &[&str],
    in_filters_by_table: &HashMap<String, Vec<InFilterCondition>>,
    inmemory_results: &[(String, Vec<RecordBatch>, usize, std::time::Duration)],
    model: &DataModel,
    registry: &SourceRegistry,
    max_inline_in_values: Option<usize>,
    token: &CancellationToken,
) -> QueryResult<HashMap<String, Vec<BidirectionalFilter>>> {
    let mut result: HashMap<String, Vec<BidirectionalFilter>> = HashMap::new();

    for &fact_name in measure_table_names {
        // The fact must itself be in the fetch set (measure tables always are).
        let Some((_, fact_request)) = fetches
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(fact_name))
        else {
            continue;
        };
        let fact_in_filters = in_filters_by_table
            .get(&fact_name.to_lowercase())
            .map(|v| v.as_slice())
            .unwrap_or(&[]);

        // Activation gate: an unfiltered fact propagates nothing. This also
        // guarantees no extra key fetch is issued for unfiltered facts.
        if fact_request.filters.is_empty() && fact_in_filters.is_empty() {
            continue;
        }

        // Keys are fetched lazily: only when at least one Both-relationship
        // dimension is found for this fact (cached per join column, since
        // multiple dimensions may join on different fact columns).
        let mut keys_by_column: HashMap<String, (Vec<String>, InValueKind)> = HashMap::new();

        for (dim_name, _) in fetches {
            if dim_name.eq_ignore_ascii_case(fact_name) {
                continue;
            }
            let Ok(rel) = model.find_relationship(fact_name, dim_name) else {
                continue;
            };
            if rel.propagation() != FilterPropagation::Both {
                continue;
            }
            // Reverse propagation shares the forward path's restriction:
            // only single-condition equality joins map to an IN list.
            if rel.conditions().len() != 1 || !rel.is_equi_only() {
                continue;
            }
            let (fact_key_col, dim_key_col) = if rel.from_table() == fact_name {
                (rel.from_column(), rel.to_column())
            } else {
                (rel.to_column(), rel.from_column())
            };

            let (values, kind) = match keys_by_column.get(fact_key_col) {
                Some(cached) => cached.clone(),
                None => {
                    let extracted = fetch_fact_keys(
                        fact_name,
                        fact_request,
                        fact_in_filters,
                        fact_key_col,
                        inmemory_results,
                        registry,
                        max_inline_in_values,
                        token,
                    )
                    .await?;
                    keys_by_column.insert(fact_key_col.to_string(), extracted.clone());
                    extracted
                }
            };

            // Documented edge: a fact filtered to zero rows applies no
            // reverse filter (connectors skip empty IN lists in SQL, and a
            // silently divergent local-only empty filter would be worse).
            if values.is_empty() {
                continue;
            }

            result
                .entry(dim_name.to_lowercase())
                .or_default()
                .push(BidirectionalFilter {
                    in_filter: InFilterCondition {
                        column: dim_key_col.to_string(),
                        values,
                        kind,
                    },
                    via_fact: fact_name.to_string(),
                });
        }
    }

    Ok(result)
}

/// Obtain the filtered fact table's distinct join-key values for one column.
///
/// Cache-served facts compute keys locally from the already-filtered cached
/// batches (after additionally applying the dimension-propagated IN filters,
/// which cached tables never receive remotely). Connector-backed facts issue
/// one extra narrow fetch: a single-column projection under the fact's
/// accumulated filters; deduplication happens locally in
/// [`extract_column_values`].
#[allow(clippy::too_many_arguments)]
async fn fetch_fact_keys(
    fact_name: &str,
    fact_request: &FetchRequest,
    fact_in_filters: &[InFilterCondition],
    fact_key_col: &str,
    inmemory_results: &[(String, Vec<RecordBatch>, usize, std::time::Duration)],
    registry: &SourceRegistry,
    max_inline_in_values: Option<usize>,
    token: &CancellationToken,
) -> QueryResult<(Vec<String>, InValueKind)> {
    if let Some((_, batches, _, _)) = inmemory_results
        .iter()
        .find(|(n, _, _, _)| n.eq_ignore_ascii_case(fact_name))
    {
        // Cache-served fact: `batches` already reflect the request's plain
        // filters (applied when the cache entry was resolved); apply the
        // IN filters propagated from other dimensions locally.
        let mut filtered = batches.clone();
        for in_filter in fact_in_filters {
            filtered =
                filter_batches_by_in_values(&filtered, &in_filter.column, &in_filter.values)?;
        }
        return Ok(extract_column_values(&filtered, fact_key_col));
    }

    // Connector-backed fact: narrow key-only fetch (extra round trip, single
    // column wide — one value per matching fact row; dedup happens locally).
    let connector = registry.connector_for(fact_name)?;
    let key_request = FetchRequest {
        schema: fact_request.schema.clone(),
        table: fact_request.table.clone(),
        columns: vec![fact_key_col.to_string()],
        filters: fact_request.filters.clone(),
        in_filters: fact_in_filters.to_vec(),
        max_inline_in_values,
        ..Default::default()
    };
    let batches = race_cancelled(token, async {
        Ok(connector.fetch_data(&key_request).await?)
    })
    .await?;
    Ok(extract_column_values(&batches, fact_key_col))
}

/// Filter record batches to rows whose `column` value (cast to text) is in
/// `values`. Null values are excluded, matching SQL `IN` semantics.
///
/// This is the local equivalent of pushing an [`InFilterCondition`] into a
/// source fetch, used for cache-served and already-fetched (phase-1) tables.
/// Batches lacking the column are returned unchanged (defensive, mirrors
/// [`extract_column_values`]).
pub(super) fn filter_batches_by_in_values(
    batches: &[RecordBatch],
    column: &str,
    values: &[String],
) -> QueryResult<Vec<RecordBatch>> {
    let allowed: std::collections::HashSet<&str> = values.iter().map(String::as_str).collect();
    let mut filtered = Vec::with_capacity(batches.len());
    for batch in batches {
        let Ok(idx) = batch.schema().index_of(column) else {
            filtered.push(batch.clone());
            continue;
        };
        let as_string = arrow::compute::cast(batch.column(idx), &arrow::datatypes::DataType::Utf8)?;
        let str_arr = as_string
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| {
                // Unreachable in practice: a successful cast to Utf8 always
                // yields a StringArray.
                QueryError::InvalidQuery(format!(
                    "internal: cast of column '{column}' to Utf8 did not produce a StringArray"
                ))
            })?;
        let mask: BooleanArray = (0..str_arr.len())
            .map(|i| Some(!str_arr.is_null(i) && allowed.contains(str_arr.value(i))))
            .collect();
        filtered.push(arrow::compute::filter_record_batch(batch, &mask)?);
    }
    Ok(filtered)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use arrow::array::{Float64Array, Int64Array};
    use arrow::datatypes::{DataType, Field, Schema};

    use engine_connectors::{FilterCondition, FilterOperator};
    use engine_core::model::{Column, Relationship, Table};
    use engine_core::types::DataType as EngineDataType;

    use super::*;

    fn fact_batch(rows: &[(i64, i64, f64)]) -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![
            Field::new("product_id", DataType::Int64, true),
            Field::new("customer_id", DataType::Int64, true),
            Field::new("amount", DataType::Float64, true),
        ]));
        RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int64Array::from_iter_values(rows.iter().map(|r| r.0))),
                Arc::new(Int64Array::from_iter_values(rows.iter().map(|r| r.1))),
                Arc::new(Float64Array::from_iter_values(rows.iter().map(|r| r.2))),
            ],
        )
        .unwrap()
    }

    fn test_model(propagation: FilterPropagation) -> DataModel {
        let fact = Table::new(
            "fact_sales",
            vec![
                Column::new("product_id", EngineDataType::Int64),
                Column::new("customer_id", EngineDataType::Int64),
                Column::new("amount", EngineDataType::Float64),
            ],
        )
        .unwrap();
        let products = Table::new(
            "dim_products",
            vec![
                Column::new("id", EngineDataType::Int64),
                Column::new("name", EngineDataType::String),
            ],
        )
        .unwrap();
        DataModel::builder()
            .add_table(fact)
            .add_table(products)
            .add_relationship(
                Relationship::many_to_one(
                    "Sales_Products",
                    "fact_sales",
                    "product_id",
                    "dim_products",
                    "id",
                )
                .with_propagation(propagation),
            )
            .build()
            .unwrap()
    }

    fn fetch_entries(fact_filtered: bool) -> Vec<(String, FetchRequest)> {
        let mut fact_request = FetchRequest {
            table: "fact_sales".to_string(),
            ..Default::default()
        };
        if fact_filtered {
            fact_request.filters.push(FilterCondition::new(
                "customer_id",
                FilterOperator::Equal,
                "10",
            ));
        }
        vec![
            ("fact_sales".to_string(), fact_request),
            (
                "dim_products".to_string(),
                FetchRequest {
                    table: "dim_products".to_string(),
                    ..Default::default()
                },
            ),
        ]
    }

    /// Cached fact batches as they exist after cache resolution: the plain
    /// request filters are already applied.
    fn cached_fact(rows: &[(i64, i64, f64)]) -> Vec<(String, Vec<RecordBatch>, usize, Duration)> {
        vec![(
            "fact_sales".to_string(),
            vec![fact_batch(rows)],
            rows.len(),
            Duration::ZERO,
        )]
    }

    #[tokio::test]
    async fn both_relationship_with_filtered_fact_produces_integer_in_filter() {
        let model = test_model(FilterPropagation::Both);
        let fetches = fetch_entries(true);
        // Filtered fact (customer 10) references products 1 and 2 only.
        let inmemory = cached_fact(&[(1, 10, 100.0), (2, 10, 50.0)]);

        let filters = compute_bidirectional_filters(
            &fetches,
            &["fact_sales"],
            &HashMap::new(),
            &inmemory,
            &model,
            &SourceRegistry::new(),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        let dim_filters = filters.get("dim_products").expect("reverse filter");
        assert_eq!(dim_filters.len(), 1);
        let bf = &dim_filters[0];
        assert_eq!(bf.via_fact, "fact_sales");
        assert_eq!(bf.in_filter.column, "id");
        // Typed key extraction: Int64 join keys classify as Integer so
        // connectors render them uncast (index-friendly).
        assert_eq!(bf.in_filter.kind, InValueKind::Integer);
        let mut values = bf.in_filter.values.clone();
        values.sort();
        assert_eq!(values, vec!["1".to_string(), "2".to_string()]);
    }

    #[tokio::test]
    async fn unfiltered_fact_propagates_nothing_and_issues_no_fetch() {
        let model = test_model(FilterPropagation::Both);
        // Fact has no filters and no propagated IN filters. The registry is
        // empty and the fact is NOT cache-served: any attempted key fetch
        // would fail with SourceNotRegistered — an empty result proves no
        // fetch was issued.
        let fetches = fetch_entries(false);

        let filters = compute_bidirectional_filters(
            &fetches,
            &["fact_sales"],
            &HashMap::new(),
            &[],
            &model,
            &SourceRegistry::new(),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert!(filters.is_empty());
    }

    #[tokio::test]
    async fn auto_relationship_never_reverse_propagates() {
        let model = test_model(FilterPropagation::Auto);
        let fetches = fetch_entries(true);
        let inmemory = cached_fact(&[(1, 10, 100.0)]);

        let filters = compute_bidirectional_filters(
            &fetches,
            &["fact_sales"],
            &HashMap::new(),
            &inmemory,
            &model,
            &SourceRegistry::new(),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert!(filters.is_empty());
    }

    #[tokio::test]
    async fn fact_filtered_to_zero_rows_applies_no_reverse_filter() {
        let model = test_model(FilterPropagation::Both);
        let fetches = fetch_entries(true);
        // Cached fact resolved to zero rows under its filters.
        let inmemory = cached_fact(&[]);

        let filters = compute_bidirectional_filters(
            &fetches,
            &["fact_sales"],
            &HashMap::new(),
            &inmemory,
            &model,
            &SourceRegistry::new(),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert!(filters.is_empty());
    }

    #[tokio::test]
    async fn fact_filtered_only_by_propagated_in_filters_triggers_reverse() {
        let model = test_model(FilterPropagation::Both);
        // The fact request itself has no plain filters; the filter pressure
        // comes transitively from another dimension's IN propagation.
        let fetches = fetch_entries(false);
        let inmemory = cached_fact(&[(1, 10, 100.0), (2, 10, 50.0), (3, 20, 70.0)]);
        let mut in_filters = HashMap::new();
        in_filters.insert(
            "fact_sales".to_string(),
            vec![InFilterCondition {
                column: "customer_id".to_string(),
                values: vec!["10".to_string()],
                kind: InValueKind::Integer,
            }],
        );

        let filters = compute_bidirectional_filters(
            &fetches,
            &["fact_sales"],
            &in_filters,
            &inmemory,
            &model,
            &SourceRegistry::new(),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        let dim_filters = filters.get("dim_products").expect("reverse filter");
        let mut values = dim_filters[0].in_filter.values.clone();
        values.sort();
        // Customer 10 rows reference products 1 and 2; product 3 (customer
        // 20) is excluded by the locally applied IN filter.
        assert_eq!(values, vec!["1".to_string(), "2".to_string()]);
    }

    #[test]
    fn filter_batches_by_in_values_filters_integer_column() {
        let batch = fact_batch(&[(1, 10, 100.0), (2, 10, 50.0), (3, 20, 70.0)]);
        let filtered =
            filter_batches_by_in_values(&[batch], "customer_id", &["10".to_string()]).unwrap();
        let rows: usize = filtered.iter().map(|b| b.num_rows()).sum();
        assert_eq!(rows, 2);
    }

    #[test]
    fn filter_batches_by_in_values_excludes_nulls() {
        use arrow::array::StringArray;
        let schema = Arc::new(Schema::new(vec![Field::new("name", DataType::Utf8, true)]));
        let batch = RecordBatch::try_new(
            schema,
            vec![Arc::new(StringArray::from(vec![
                Some("Bike"),
                None,
                Some("Helmet"),
            ]))],
        )
        .unwrap();
        let filtered = filter_batches_by_in_values(
            &[batch],
            "name",
            &["Bike".to_string(), "Glove".to_string()],
        )
        .unwrap();
        let rows: usize = filtered.iter().map(|b| b.num_rows()).sum();
        assert_eq!(rows, 1);
    }

    #[test]
    fn filter_batches_by_in_values_missing_column_leaves_batch_unchanged() {
        let batch = fact_batch(&[(1, 10, 100.0)]);
        let filtered =
            filter_batches_by_in_values(&[batch], "nonexistent", &["1".to_string()]).unwrap();
        let rows: usize = filtered.iter().map(|b| b.num_rows()).sum();
        assert_eq!(rows, 1);
    }
}
