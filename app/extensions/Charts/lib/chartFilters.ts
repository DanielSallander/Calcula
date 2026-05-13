//! FILENAME: app/extensions/Charts/lib/chartFilters.ts
// PURPOSE: Apply non-destructive chart filters to parsed chart data.
// CONTEXT: Filters hide series and/or categories without removing them from
//          the data source. Called in the data pipeline after transforms.

import type { ParsedChartData, ChartFilters } from "../types";

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
