//! FILENAME: app/extensions/Charts/lib/chartFilters.ts
// PURPOSE: Apply non-destructive chart filters to parsed chart data.
// CONTEXT: Filters hide series and/or categories without removing them from
//          the data source. Called in the data pipeline after transforms.

import type { ParsedChartData, ChartFilters } from "../types";

/**
 * Keep only the categories whose label is in `keep` (selection-as-filter, S4).
 * Aligns every series' values to the kept categories. An empty/undefined keep
 * set is a no-op (full data) — matching the "empty selection = all" semantics.
 * Pure; does not mutate the input.
 */
export function applySelectionKeep(
  data: ParsedChartData,
  keep: readonly string[] | undefined,
): ParsedChartData {
  if (!keep || keep.length === 0) return data;
  const keepSet = new Set(keep);
  const keptIdx = data.categories
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => keepSet.has(c))
    .map(({ i }) => i);
  if (keptIdx.length === data.categories.length) return data; // nothing dropped
  // None of the kept labels exist in the current data (stale selection after a
  // grid edit, or the category was hidden by a positional filter). Treat as a
  // no-op (full data) rather than blanking the chart.
  if (keptIdx.length === 0) return data;
  return {
    ...data,
    categories: keptIdx.map((i) => data.categories[i]),
    series: data.series.map((s) => ({ ...s, values: keptIdx.map((i) => s.values[i]) })),
  };
}

/**
 * Apply non-destructive filters to parsed chart data.
 * Removes hidden series and hidden categories from the data.
 * Returns a new ParsedChartData with filtered content.
 */
export function applyChartFilters(
  data: ParsedChartData,
  filters: ChartFilters | undefined,
): ParsedChartData {
  if (!filters) return data;

  const { hiddenSeries, hiddenCategories } = filters;
  const hasSeriesFilter = hiddenSeries && hiddenSeries.length > 0;
  const hasCategoryFilter = hiddenCategories && hiddenCategories.length > 0;

  if (!hasSeriesFilter && !hasCategoryFilter) return data;

  let filteredSeries = data.series;
  let filteredCategories = data.categories;

  // Filter series
  if (hasSeriesFilter) {
    const hiddenSet = new Set(hiddenSeries);
    filteredSeries = data.series.filter((_, i) => !hiddenSet.has(i));
  }

  // Filter categories
  if (hasCategoryFilter) {
    const hiddenCatSet = new Set(hiddenCategories);
    const visibleCatIndices = data.categories
      .map((_, i) => i)
      .filter((i) => !hiddenCatSet.has(i));

    filteredCategories = visibleCatIndices.map((i) => data.categories[i]);

    // Also filter the values array in each series to match
    filteredSeries = filteredSeries.map((s) => ({
      ...s,
      values: visibleCatIndices.map((i) => s.values[i]),
    }));
  }

  return {
    categories: filteredCategories,
    series: filteredSeries,
  };
}
