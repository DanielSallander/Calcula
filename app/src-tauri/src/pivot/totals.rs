//! FILENAME: app/src-tauri/src/pivot/totals.rs
//! Engine-evaluated totals for BI-backed pivots + measure column mapping.
//!
//! A BI pivot's cache holds PRE-AGGREGATED leaf rows (one per group
//! combination), so the pivot engine's additive roll-up produces wrong
//! subtotals/grand totals for non-additive measures — a "% of total" measure
//! rolls up to 0.9999999… instead of an exact 1, and AVERAGE/DISTINCTCOUNT
//! measures roll up plainly wrong. This module queries the BI engine once per
//! total grain (every row-prefix × column-prefix of the effective dimension
//! lists) and converts the results into `pivot_engine::TotalOverride`s that
//! the pivot engine splices over the rolled-up accumulator slots.
//!
//! v1 scope:
//! - Totals are only installed when no local filters are active; the pivot
//!   engine additionally gates application on an all-visible filter mask, so
//!   filtering later falls back to rolled-up totals until the next refresh.
//! - Calculation groups are skipped (their totals are force-hidden anyway).
//! - `TotalsMode::Rollup` (single-query rollup) is a future optimization: it
//!   fails closed on multi-fact models, lookups and calculation groups, so
//!   the per-grain point queries below are the universally valid form.

use std::collections::HashMap;

use arrow::record_batch::RecordBatch;
use engine::CellValue;
use pivot_engine::{CacheValue, PivotCache, TotalOverride, VALUE_ID_EMPTY};

use crate::log_info;
use crate::pivot::operations::arrow_cell_to_value;

/// Maps each measure result column reported by `query_with_meta` to its CACHE
/// column index, keyed by (base measure, calculation item).
///
/// The engine metadata indices are positions in the RESULT batches. The cache
/// normally has the same layout, but the values-only path prepends a synthetic
/// "Total" dimension column, shifting every result column right by
/// `dim_offset` — the offset must be applied here so the value-field mapping
/// points at the measures and not their left neighbours.
pub(crate) fn measure_value_col_idx(
    result_columns: &[bi_engine::ResultColumn],
    dim_offset: usize,
) -> HashMap<(String, Option<String>), usize> {
    result_columns
        .iter()
        .enumerate()
        .filter(|(_, rc)| matches!(rc.kind, bi_engine::ResultColumnKind::Measure))
        .filter_map(|(i, rc)| {
            rc.measure
                .clone()
                .map(|m| ((m, rc.calculation_item.clone()), i + dim_offset))
        })
        .collect()
}

/// One effective pivot dimension (row or column axis) of a BI pivot, with the
/// cache column its members are interned in.
pub(crate) struct GrainField {
    pub table: String,
    pub column: String,
    pub cache_idx: usize,
}

/// Everything needed to evaluate a BI pivot's total grains.
pub(crate) struct BiTotalsPlan {
    /// Effective row dimensions in axis order (GROUP fields + hierarchy levels).
    pub row_fields: Vec<GrainField>,
    /// Effective column dimensions in axis order.
    pub col_fields: Vec<GrainField>,
    /// Measure names to evaluate (same list as the main pivot query).
    pub measures: Vec<String>,
    /// Per value-field position: (base measure, calculation item) key used to
    /// locate the measure's column in each grain result.
    pub vf_keys: Vec<(String, Option<String>)>,
    /// The SAME level-tagged IN-lists the main pivot query carries.
    ///
    /// WHY THIS FIELD EXISTS. The grain queries used to be built with
    /// `filters: vec![]` and no scoped filters at all, so they described the
    /// WHOLE model while the pivot beside them was engine-filtered. A pinned
    /// (level-2+) slicer is exactly that situation, and it is the workaround
    /// BUG-0108 points users at:
    ///
    ///   - A pin CLEARS every host-side `hidden_items` for its field, which is
    ///     what makes the totals gate open at all (`request_filters_active`
    ///     is then false) and what makes `apply_total_overrides`' all-visible
    ///     mask check pass.
    ///   - An out-of-zone pinned field leaves a zero-mask `SlicerFilter`
    ///     behind so it stays in GROUP BY, which on refresh makes
    ///     `include_leaf` true.
    ///   - `apply_total_overrides` REPLACES an accumulator rather than adding
    ///     to it, and happily inserts a slot that did not exist.
    ///
    /// Together those three mean the unfiltered grain results overwrote the
    /// pin-filtered LEAF values: pinning a slicer made the pivot ignore that
    /// slicer completely. The fix is not to skip the totals — it is to ask the
    /// same question the main query asked.
    pub scoped_in_filters: Vec<bi_engine::ScopedInFilter>,
}

/// Grains beyond this count keep rolled-up totals (avoids surprise refresh
/// latency on connector-backed models with many nested dimensions).
const MAX_TOTAL_GRAINS: usize = 24;

/// Enumerates the (row_depth, col_depth) total grains of an n×m axis layout.
/// The full-depth leaf grain is the main query itself and is only included
/// when `include_leaf` (the main query grouped by extra filter/slicer dims,
/// making even leaf cells a roll-up).
pub(crate) fn enumerate_grains(
    row_count: usize,
    col_count: usize,
    include_leaf: bool,
) -> Vec<(usize, usize)> {
    let mut grains = Vec::new();
    for d in 0..=row_count {
        for e in 0..=col_count {
            if d == row_count && e == col_count && !include_leaf {
                continue;
            }
            grains.push((d, e));
        }
    }
    grains
}

/// Converts one grain's query result into total overrides.
///
/// Dimension result columns are matched by (source_table, source_column) from
/// the engine metadata with a positional fallback (group-by columns lead the
/// result in request order). Measure columns are matched by
/// (measure, calculation item). Rows with NULL members are skipped — a NULL
/// member interns as VALUE_ID_EMPTY, which is indistinguishable from the
/// subtotal padding, so writing it would clobber a subtotal slot.
pub(crate) fn overrides_from_grain_result(
    batches: &[RecordBatch],
    result_columns: &[bi_engine::ResultColumn],
    plan: &BiTotalsPlan,
    row_depth: usize,
    col_depth: usize,
    cache: &PivotCache,
) -> Vec<TotalOverride> {
    let n = plan.row_fields.len();
    let m = plan.col_fields.len();

    let grain_fields: Vec<&GrainField> = plan.row_fields[..row_depth]
        .iter()
        .chain(plan.col_fields[..col_depth].iter())
        .collect();
    let dim_col: Vec<usize> = grain_fields
        .iter()
        .enumerate()
        .map(|(j, gf)| {
            result_columns
                .iter()
                .position(|rc| {
                    matches!(rc.kind, bi_engine::ResultColumnKind::Dimension)
                        && rc
                            .source_table
                            .as_deref()
                            .is_some_and(|t| t.eq_ignore_ascii_case(&gf.table))
                        && rc
                            .source_column
                            .as_deref()
                            .is_some_and(|c| c.eq_ignore_ascii_case(&gf.column))
                })
                .unwrap_or(j)
        })
        .collect();
    let vf_col: Vec<Option<usize>> = plan
        .vf_keys
        .iter()
        .map(|(measure, item)| {
            result_columns.iter().position(|rc| {
                matches!(rc.kind, bi_engine::ResultColumnKind::Measure)
                    && rc.measure.as_deref() == Some(measure.as_str())
                    && rc.calculation_item == *item
            })
        })
        .collect();

    let mut out = Vec::new();
    for batch in batches {
        for row in 0..batch.num_rows() {
            let mut row_key = vec![VALUE_ID_EMPTY; n];
            let mut col_key = vec![VALUE_ID_EMPTY; m];
            let mut resolvable = true;
            for (j, gf) in grain_fields.iter().enumerate() {
                let Some(col) = batch.columns().get(dim_col[j]) else {
                    resolvable = false;
                    break;
                };
                let cell = arrow_cell_to_value(col.as_ref(), row);
                if matches!(cell, CellValue::Empty) {
                    resolvable = false;
                    break;
                }
                let Some(id) = cache.find_value_id(gf.cache_idx, &CacheValue::from(&cell))
                else {
                    resolvable = false;
                    break;
                };
                if id == VALUE_ID_EMPTY {
                    resolvable = false;
                    break;
                }
                if j < row_depth {
                    row_key[j] = id;
                } else {
                    col_key[j - row_depth] = id;
                }
            }
            if !resolvable {
                continue;
            }

            let values: Vec<Option<f64>> = vf_col
                .iter()
                .map(|col_idx| {
                    let ci = (*col_idx)?;
                    let col = batch.columns().get(ci)?;
                    match arrow_cell_to_value(col.as_ref(), row) {
                        CellValue::Number(v) => Some(v),
                        _ => None,
                    }
                })
                .collect();
            if values.iter().all(|v| v.is_none()) {
                continue;
            }
            out.push(TotalOverride {
                row_key,
                col_key,
                values,
            });
        }
    }
    out
}

/// Builds the `QueryRequest` for ONE total grain.
///
/// Extracted from the loop below purely so it is testable: the loop needs a
/// live `bi_engine::Engine`, and the defect this guards against was invisible
/// precisely because nothing could look at the request that was being sent.
pub(crate) fn grain_request(
    plan: &BiTotalsPlan,
    group_by: Vec<bi_engine::ColumnRef>,
) -> bi_engine::QueryRequest {
    bi_engine::QueryRequest {
        measures: plan.measures.clone(),
        group_by,
        filters: vec![],
        // The pivot's own engine filters travel with every grain. Omitting
        // them computed each subtotal and grand total over the whole model
        // and spliced it over an engine-filtered pivot — see the field's
        // own doc comment for why that also corrupted the LEAF cells.
        scoped_in_filters: plan.scoped_in_filters.clone(),
        lookups: vec![],
        calculation_group: None,
        ..Default::default()
    }
}

/// Runs one point query per total grain and collects the resulting overrides.
/// Grains are evaluated coarse-to-fine so a (harmless) key collision resolves
/// in favour of the finer grain. Per-grain failures keep the rolled-up totals
/// for that grain only.
pub(crate) async fn query_bi_total_overrides(
    engine: &mut bi_engine::Engine,
    plan: &BiTotalsPlan,
    include_leaf: bool,
    cache: &PivotCache,
) -> Vec<TotalOverride> {
    let grains = enumerate_grains(plan.row_fields.len(), plan.col_fields.len(), include_leaf);
    if grains.is_empty() {
        return Vec::new();
    }
    if grains.len() > MAX_TOTAL_GRAINS {
        log_info!(
            "PIVOT",
            "BI totals: {} grains exceed cap {} — keeping rolled-up totals",
            grains.len(),
            MAX_TOTAL_GRAINS
        );
        return Vec::new();
    }

    let mut out = Vec::new();
    for (d, e) in grains {
        let group_by: Vec<bi_engine::ColumnRef> = plan.row_fields[..d]
            .iter()
            .chain(plan.col_fields[..e].iter())
            .map(|gf| bi_engine::ColumnRef::new(&gf.table, &gf.column))
            .collect();
        let request = grain_request(plan, group_by);
        match engine.query_with_meta(request).await {
            Ok((batches, result_columns)) => {
                out.extend(overrides_from_grain_result(
                    &batches,
                    &result_columns,
                    plan,
                    d,
                    e,
                    cache,
                ));
            }
            Err(err) => {
                log_info!(
                    "PIVOT",
                    "BI totals grain ({},{}) query failed — keeping rolled-up totals for it: {}",
                    d,
                    e,
                    err
                );
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{ArrayRef, Float64Array, StringArray};
    use arrow::datatypes::{DataType, Field, Schema};
    use pivot_engine::PivotId;
    use std::sync::Arc;

    fn dim_col(name: &str, table: &str, column: &str) -> bi_engine::ResultColumn {
        bi_engine::ResultColumn {
            name: name.to_string(),
            kind: bi_engine::ResultColumnKind::Dimension,
            data_type: None,
            source_table: Some(table.to_string()),
            source_column: Some(column.to_string()),
            measure: None,
            calculation_item: None,
            format_string: None,
            display_name: None,
            description: None,
            is_hidden: false,
            kpi_name: None,
        }
    }

    fn measure_col(measure: &str) -> bi_engine::ResultColumn {
        bi_engine::ResultColumn {
            name: measure.to_string(),
            kind: bi_engine::ResultColumnKind::Measure,
            data_type: None,
            source_table: None,
            source_column: None,
            measure: Some(measure.to_string()),
            calculation_item: None,
            format_string: None,
            display_name: None,
            description: None,
            is_hidden: false,
            kpi_name: None,
        }
    }

    #[test]
    fn measure_map_applies_synthetic_dim_offset() {
        // Values-only pivot: engine result is [Revenue, Pct] but the cache is
        // [Total, Revenue, Pct] — the offset must shift the mapping, otherwise
        // Revenue reads the synthetic "Total" text column (renders 0) and Pct
        // reads Revenue (the shifted-columns bug).
        let cols = vec![measure_col("Revenue"), measure_col("Pct")];
        let with_offset = measure_value_col_idx(&cols, 1);
        assert_eq!(with_offset.get(&("Revenue".to_string(), None)), Some(&1));
        assert_eq!(with_offset.get(&("Pct".to_string(), None)), Some(&2));

        // With real dimensions there is no synthetic column and no offset.
        let cols = vec![
            dim_col("Region", "Sales", "Region"),
            measure_col("Revenue"),
            measure_col("Pct"),
        ];
        let no_offset = measure_value_col_idx(&cols, 0);
        assert_eq!(no_offset.get(&("Revenue".to_string(), None)), Some(&1));
        assert_eq!(no_offset.get(&("Pct".to_string(), None)), Some(&2));
    }

    #[test]
    fn grain_enumeration_excludes_leaf_unless_requested() {
        assert_eq!(enumerate_grains(1, 0, false), vec![(0, 0)]);
        assert_eq!(enumerate_grains(1, 0, true), vec![(0, 0), (1, 0)]);
        assert_eq!(
            enumerate_grains(2, 1, false),
            vec![(0, 0), (0, 1), (1, 0), (1, 1), (2, 0)]
        );
        assert!(enumerate_grains(2, 1, true).contains(&(2, 1)));
    }

    fn test_cache() -> PivotCache {
        let pivot_id = PivotId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
        let mut cache = PivotCache::new(pivot_id, 3);
        cache.set_field_name(0, "Sales.Region".to_string());
        cache.set_field_name(1, "Revenue".to_string());
        cache.set_field_name(2, "Pct".to_string());
        cache.add_record(0, &[
            CellValue::Text("North".to_string()),
            CellValue::Number(100.0),
            CellValue::Number(0.1),
        ]);
        cache.add_record(1, &[
            CellValue::Text("South".to_string()),
            CellValue::Number(200.0),
            CellValue::Number(0.2),
        ]);
        cache
    }

    fn test_plan() -> BiTotalsPlan {
        BiTotalsPlan {
            row_fields: vec![GrainField {
                table: "Sales".to_string(),
                column: "Region".to_string(),
                cache_idx: 0,
            }],
            col_fields: vec![],
            measures: vec!["Revenue".to_string(), "Pct".to_string()],
            vf_keys: vec![
                ("Revenue".to_string(), None),
                ("Pct".to_string(), None),
            ],
            scoped_in_filters: vec![],
        }
    }

    #[test]
    fn grand_total_grain_maps_to_padded_key() {
        let cache = test_cache();
        let plan = test_plan();

        let schema = Arc::new(Schema::new(vec![
            Field::new("Revenue", DataType::Float64, true),
            Field::new("Pct", DataType::Float64, true),
        ]));
        let batch = arrow::record_batch::RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Float64Array::from(vec![Some(300.0)])) as ArrayRef,
                Arc::new(Float64Array::from(vec![Some(1.0)])) as ArrayRef,
            ],
        )
        .unwrap();
        let cols = vec![measure_col("Revenue"), measure_col("Pct")];

        let overrides = overrides_from_grain_result(&[batch], &cols, &plan, 0, 0, &cache);
        assert_eq!(overrides.len(), 1);
        assert_eq!(overrides[0].row_key, vec![VALUE_ID_EMPTY]);
        assert!(overrides[0].col_key.is_empty());
        assert_eq!(overrides[0].values, vec![Some(300.0), Some(1.0)]);
    }

    /// A plan carrying the pinned filters a real pinned pivot would have.
    fn pinned_plan() -> BiTotalsPlan {
        let mut plan = test_plan();
        plan.scoped_in_filters = vec![bi_engine::ScopedInFilter {
            table: Some("Sales".to_string()),
            filter: bi_engine::InFilter::new("Region", ["North"]),
            level: 2,
        }];
        plan
    }

    #[test]
    fn every_total_grain_carries_the_pivots_own_engine_filters() {
        // THE DEFECT. Each grain request was built with `filters: vec![]` and
        // no scoped filters at all, so every subtotal and grand total was
        // computed over the WHOLE model and then spliced over a pivot whose
        // leaf rows WERE engine-filtered. Pinning a slicer is the documented
        // workaround for BUG-0108, so the mitigation produced the wrong
        // numbers it was pointed at to avoid.
        let plan = pinned_plan();
        let grains = enumerate_grains(plan.row_fields.len(), plan.col_fields.len(), true);
        assert!(grains.len() >= 2, "need more than one grain to be meaningful");

        for (d, e) in grains {
            let group_by: Vec<bi_engine::ColumnRef> = plan.row_fields[..d]
                .iter()
                .chain(plan.col_fields[..e].iter())
                .map(|gf| bi_engine::ColumnRef::new(&gf.table, &gf.column))
                .collect();
            let req = grain_request(&plan, group_by);
            assert_eq!(
                req.scoped_in_filters.len(),
                1,
                "grain ({}, {}) dropped the pivot's engine filters",
                d,
                e
            );
            assert_eq!(req.scoped_in_filters[0].level, 2);
            assert_eq!(req.scoped_in_filters[0].table.as_deref(), Some("Sales"));
            assert_eq!(req.scoped_in_filters[0].filter.column, "Region");
            assert_eq!(req.scoped_in_filters[0].filter.values, vec!["North"]);
        }
    }

    #[test]
    fn the_leaf_grain_is_filtered_too_because_a_pin_makes_it_reachable() {
        // Why the leaf grain matters, and why this is worse than "totals are
        // wrong". An out-of-zone pinned field keeps a zero-mask `SlicerFilter`
        // so it stays in GROUP BY; on refresh that makes `include_leaf` TRUE,
        // so `enumerate_grains` emits the FULL-DEPTH grain. And
        // `apply_total_overrides` REPLACES an accumulator rather than adding
        // to it. An unfiltered full-depth grain therefore overwrote the
        // pin-filtered leaf cells: the pivot displayed all-rows numbers while
        // showing an active slicer.
        let plan = pinned_plan();
        let leaf = (plan.row_fields.len(), plan.col_fields.len());
        let with_leaf = enumerate_grains(leaf.0, leaf.1, true);
        assert!(
            with_leaf.contains(&leaf),
            "include_leaf must emit the full-depth grain — that is the grain a pin reaches"
        );

        let group_by: Vec<bi_engine::ColumnRef> = plan
            .row_fields
            .iter()
            .map(|gf| bi_engine::ColumnRef::new(&gf.table, &gf.column))
            .collect();
        let req = grain_request(&plan, group_by);
        assert!(
            !req.scoped_in_filters.is_empty(),
            "the leaf grain is unfiltered, so it will overwrite the pivot's own filtered leaves"
        );
    }

    #[test]
    fn an_unpinned_pivot_still_sends_no_filters() {
        // The fix must not invent a filter context. A pivot with no engine
        // filters is the ordinary case and its grains describe the whole
        // model, which is correct there: the totals gate only opens when no
        // host-side mask is active either.
        let req = grain_request(&test_plan(), vec![]);
        assert!(req.scoped_in_filters.is_empty());
        assert!(req.filters.is_empty());
    }

    #[test]
    fn the_totals_plan_is_populated_from_the_main_querys_filters() {
        // WIRING, which the three tests above cannot see: they prove the
        // request carries whatever the PLAN holds, not that the caller ever
        // puts anything in the plan. `update_bi_pivot_fields` builds
        // `scoped_in_filters` once and used to MOVE it into the main query —
        // so a plan built afterwards had nothing to copy and the field would
        // sit permanently empty while every test above still passed.
        let src = include_str!("commands.rs");
        assert!(
            src.contains("scoped_in_filters: scoped_in_filters.clone()"),
            "update_bi_pivot_fields no longer clones its engine filters into \
             BOTH the main query and the totals plan; the grain queries are \
             describing the unfiltered model again"
        );
        let occurrences = src.matches("scoped_in_filters: scoped_in_filters.clone()").count();
        assert_eq!(
            occurrences, 2,
            "expected exactly two sites — the main QueryRequest and the \
             BiTotalsPlan — found {}",
            occurrences
        );
    }

    #[test]
    fn member_grain_resolves_ids_and_skips_null_members() {
        let cache = test_cache();
        let plan = test_plan();

        // Metadata table name uses a different case — matching must be
        // case-insensitive. The NULL member row must be skipped (a NULL
        // interns as VALUE_ID_EMPTY, which would clobber a subtotal slot).
        // A NULL measure becomes None, keeping that cell's rolled-up value.
        let schema = Arc::new(Schema::new(vec![
            Field::new("Region", DataType::Utf8, true),
            Field::new("Revenue", DataType::Float64, true),
            Field::new("Pct", DataType::Float64, true),
        ]));
        let batch = arrow::record_batch::RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec![Some("South"), None])) as ArrayRef,
                Arc::new(Float64Array::from(vec![Some(200.0), Some(50.0)])) as ArrayRef,
                Arc::new(Float64Array::from(vec![None, Some(0.05)])) as ArrayRef,
            ],
        )
        .unwrap();
        let cols = vec![
            dim_col("Region", "SALES", "REGION"),
            measure_col("Revenue"),
            measure_col("Pct"),
        ];

        let overrides = overrides_from_grain_result(&[batch], &cols, &plan, 1, 0, &cache);
        assert_eq!(overrides.len(), 1);
        let south_id = cache
            .find_value_id(0, &CacheValue::from(&CellValue::Text("South".to_string())))
            .unwrap();
        assert_eq!(overrides[0].row_key, vec![south_id]);
        assert_eq!(overrides[0].values, vec![Some(200.0), None]);
    }

    #[test]
    fn unknown_member_rows_are_dropped() {
        let cache = test_cache();
        let plan = test_plan();

        let schema = Arc::new(Schema::new(vec![
            Field::new("Region", DataType::Utf8, true),
            Field::new("Revenue", DataType::Float64, true),
            Field::new("Pct", DataType::Float64, true),
        ]));
        let batch = arrow::record_batch::RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec![Some("West")])) as ArrayRef,
                Arc::new(Float64Array::from(vec![Some(1.0)])) as ArrayRef,
                Arc::new(Float64Array::from(vec![Some(1.0)])) as ArrayRef,
            ],
        )
        .unwrap();
        let cols = vec![
            dim_col("Region", "Sales", "Region"),
            measure_col("Revenue"),
            measure_col("Pct"),
        ];

        // "West" never appears in the leaf cache — the row can't be keyed.
        let overrides = overrides_from_grain_result(&[batch], &cols, &plan, 1, 0, &cache);
        assert!(overrides.is_empty());
    }
}
