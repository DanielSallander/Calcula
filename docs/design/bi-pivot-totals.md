# BI Pivot Totals: Engine-Evaluated Subtotals and Grand Totals

Status: v1 shipped (2026-07-17)

## The two bugs this fixes

**1. Values-only BI pivots showed shifted measure values.** A BI pivot with
measures but no dimensions rebuilds its cache with a synthetic "Total"
dimension prepended (`build_cache_with_synthetic_dim`), shifting every result
column right by one. The metadata-driven value-field mapping introduced with
calculation groups (`query_with_meta` column identity) used raw result-column
indices without that offset, so measure k displayed measure k-1's column:
Revenue read the synthetic text column (rendered 0) and "% of total" read
Revenue. Fix: `measure_value_col_idx(result_columns, dim_offset)` in
`app/src-tauri/src/pivot/totals.rs`, shared with the headless DSL path
(offset 0 there).

**2. Rolled-up totals are wrong for non-additive measures.** A BI pivot cache
holds PRE-AGGREGATED rows (one per leaf group), and the pivot engine's
`compute_aggregates` rolls subtotal/grand-total slots up by SUMMING those rows
("SUM of pre-aggregated = identity" — true only for leaf cells). A "% of
total" measure therefore showed a grand total of 0.9999999992999998 (float
accumulation of Σ group ratios); AVERAGE/DISTINCTCOUNT-style measures roll up
plainly wrong. Power BI semantics require every total cell to be evaluated in
its own filter context.

## Architecture

Two layers, meeting at `PivotCache::total_overrides`:

- **pivot-engine** (`core/pivot-engine/src/cache.rs`): `TotalOverride`
  { row_key, col_key, values } — full-length ValueId keys padded with
  `VALUE_ID_EMPTY` beyond the grain depth (exactly the shape of subtotal/
  grand-total accumulator keys). At the end of `compute_aggregates`,
  `apply_total_overrides` overwrites the matching accumulator slots with
  single-value accumulators. Because the splice happens below every read path,
  data cells, show-values-as, visual calcs and sorting all see the corrected
  totals with zero changes. Guards: skipped entirely while any record is
  filtered out (overrides describe the UNFILTERED set; clearing filters
  re-applies them), and per-entry when the key shape doesn't match the current
  axis layout (stale entries).

- **app** (`app/src-tauri/src/pivot/totals.rs`, wired into
  `update_bi_pivot_fields`): after the main query, one point query per total
  grain — every (row-prefix depth d, column-prefix depth e) of the effective
  dimension lists (GROUP fields + hierarchy levels; attributes excluded). The
  full-depth leaf grain is included only when filter/slicer dims were in the
  main query's GROUP BY (then even leaf cells are roll-ups). Results are keyed
  back to cache ValueIds via the read-only `PivotCache::find_value_id`;
  measure columns are matched by (measure, calculation item) from
  `query_with_meta` metadata, dimension columns by (source_table,
  source_column) with positional fallback.

## v1 boundaries

- **Local filters**: totals queries are only issued when no hidden items are
  active (request + preserved page-filter/slicer state), and the engine gate
  falls back to rolled-up totals the moment a local filter hides a record.
  Filtered pivots behave exactly as before this feature.
- **Calculation groups**: skipped — their totals are force-hidden anyway
  (`update_bi_pivot_fields` forces show_grand_totals off for calc groups).
  With engine-evaluated totals this could be relaxed later.
- **NULL members**: a grain row with a NULL member is skipped; NULL interns as
  `VALUE_ID_EMPTY`, indistinguishable from subtotal padding (a pre-existing
  engine-wide conflation for blank members).
- **Grain cap**: > 24 grains (deeply nested hierarchies) keeps rolled-up
  totals, logged.
- **Values-only pivots** need no overrides: the single cache row IS the
  engine's grand-total evaluation.

## Future work

- `TotalsMode::Rollup` (bi_engine native, single query, per-level
  recomputation) can replace the per-grain point queries — but it fails
  closed on multi-fact models, lookups and calculation groups, so the point
  queries remain the universal fallback.
- Pushing page-filter/slicer hidden items as engine-side `filters` (supported
  without group_by membership) would extend exact totals to filtered pivots;
  requires the pivot-engine gate to compare mask state against the filter
  context the overrides were computed under.
- Headless DSL/design-query results still roll up totals client-side where
  they render any.
