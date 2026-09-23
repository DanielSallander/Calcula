//! FILENAME: app/extensions/Charts/components/ChartFilterDropdown.tsx
// PURPOSE: The body of the Chart Design "Filter" popover — show or hide each
//          series and each category of the selected chart.
// CONTEXT: This used to be a whole dropdown: its own trigger (a unicode triangle glyph in a
//          hand-rolled button), its own `position: fixed; z-index: 10000`
//          layer, its own document-level Escape and outside-click listeners,
//          and a dozen hardcoded Office colours. In the Clusters grammar the
//          trigger is the band's "Filter" Button and the layer is an @api
//          `Popover card` owned by the Data cluster, which already handles
//          positioning, Escape, outside presses and focus return. What is left
//          here is the part only Charts knows: the list.
//
//          THE FILTER MODEL IS UNCHANGED. `spec.filters` holds the indices that
//          are HIDDEN (`hiddenSeries`, `hiddenCategories`), in authoring
//          space, and every change goes out through `onFiltersChange` with both
//          arrays — the Data cluster writes it with one `updateSpec`.
//
//          The series colour dot is categorical colour DATA (the painted
//          series colour) and carries `data-colour-data`; everything else
//          paints with @api/layout tokens.

import React, { useCallback } from "react";
import { css } from "@emotion/css";
import {
  Button,
  Checkbox,
  Chip,
  MenuHeading,
  MenuSeparator,
  StatusText,
  LT,
  FONT_FAMILY,
  GAP_XS,
} from "@api/layout";
import type { ChartFilters, ParsedChartData, ChartSpec } from "../types";

// ============================================================================
// Styles (tokens only)
// ============================================================================

const body = css`
  display: flex;
  flex-direction: column;
  min-width: 220px;
  max-width: 320px;
  font-family: ${FONT_FAMILY};
  color: ${LT.text};
`;

const headingRow = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${GAP_XS}px;
  padding-right: 2px;
`;

const list = css`
  display: flex;
  flex-direction: column;
  padding: 0 6px;
`;

const nameRow = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
`;

const nameText = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const swatch = css`
  display: inline-block;
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 2px;
`;

const footer = css`
  display: flex;
  padding: 2px 2px 0;
`;

// ============================================================================
// Model helpers
// ============================================================================

/** More categories than this are not listed (the list would be unusable). */
const MAX_LISTED_CATEGORIES = 50;

/** What the Data cluster's "N of M" chip says about the active filter. */
export interface ChartFilterSummary {
  /** Hidden series + hidden categories. */
  hidden: number;
  /** Visible items across the filtered dimension(s), or null when unknown. */
  shown: number | null;
  /** All items across the filtered dimension(s), or null when unknown. */
  total: number | null;
  /** "series", "categories" or "items" (both dimensions are filtered). */
  noun: string;
}

/**
 * Summarise a chart's filter for the band chip, or null when nothing is
 * hidden. Counts only the dimension(s) that are actually filtered, so hiding
 * 9 of 12 months reads "3 of 12" rather than a sum that mixes in the series.
 * `shown`/`total` are null when the chart's data has not been read yet.
 */
export function summarizeChartFilters(
  filters: ChartFilters | undefined,
  unfilteredData: ParsedChartData | undefined,
): ChartFilterSummary | null {
  const hiddenSeries = new Set(filters?.hiddenSeries ?? []).size;
  const hiddenCategories = new Set(filters?.hiddenCategories ?? []).size;
  const hidden = hiddenSeries + hiddenCategories;
  if (hidden === 0) return null;

  const noun =
    hiddenSeries > 0 && hiddenCategories > 0 ? "items" : hiddenSeries > 0 ? "series" : "categories";
  if (!unfilteredData) return { hidden, shown: null, total: null, noun };

  let total = 0;
  if (hiddenSeries > 0) total += unfilteredData.series.length;
  if (hiddenCategories > 0) total += unfilteredData.categories.length;
  return { hidden, shown: Math.max(0, total - hidden), total, noun };
}

// ============================================================================
// Component
// ============================================================================

export interface ChartFilterDropdownProps {
  spec: ChartSpec;
  unfilteredData: ParsedChartData | undefined;
  onFiltersChange: (filters: ChartFilters) => void;
}

/**
 * The filter list: a "Series" group and a "Categories" group of checkboxes
 * (checked = shown), each with a "Select all" chip while something in it is
 * hidden, and "Clear filters" while anything is. Rendered inside the Data
 * cluster's card Popover.
 */
export function ChartFilterDropdown({
  spec,
  unfilteredData,
  onFiltersChange,
}: ChartFilterDropdownProps): React.ReactElement {
  const filters = spec.filters ?? { hiddenSeries: [], hiddenCategories: [] };
  const hiddenSeriesSet = new Set(filters.hiddenSeries ?? []);
  const hiddenCategoriesSet = new Set(filters.hiddenCategories ?? []);
  const isFiltered = hiddenSeriesSet.size + hiddenCategoriesSet.size > 0;

  const allSeries = unfilteredData?.series ?? [];
  const allCategories = unfilteredData?.categories ?? [];
  const listCategories = allCategories.length > 0 && allCategories.length <= MAX_LISTED_CATEGORIES;

  const hiddenSeriesList = filters.hiddenSeries;
  const hiddenCategoriesList = filters.hiddenCategories;

  const toggleSeries = useCallback(
    (index: number) => {
      const next = new Set(hiddenSeriesList ?? []);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      onFiltersChange({
        hiddenSeries: Array.from(next),
        hiddenCategories: hiddenCategoriesList ?? [],
      });
    },
    [hiddenSeriesList, hiddenCategoriesList, onFiltersChange],
  );

  const toggleCategory = useCallback(
    (index: number) => {
      const next = new Set(hiddenCategoriesList ?? []);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      onFiltersChange({
        hiddenSeries: hiddenSeriesList ?? [],
        hiddenCategories: Array.from(next),
      });
    },
    [hiddenSeriesList, hiddenCategoriesList, onFiltersChange],
  );

  const selectAllSeries = useCallback(() => {
    onFiltersChange({ hiddenSeries: [], hiddenCategories: hiddenCategoriesList ?? [] });
  }, [hiddenCategoriesList, onFiltersChange]);

  const selectAllCategories = useCallback(() => {
    onFiltersChange({ hiddenSeries: hiddenSeriesList ?? [], hiddenCategories: [] });
  }, [hiddenSeriesList, onFiltersChange]);

  const clearAllFilters = useCallback(() => {
    onFiltersChange({ hiddenSeries: [], hiddenCategories: [] });
  }, [onFiltersChange]);

  if (allSeries.length === 0 && !listCategories) {
    return (
      <div className={body} data-testid="chart-filter-body">
        <StatusText>No series or categories to filter yet.</StatusText>
      </div>
    );
  }

  return (
    <div className={body} data-testid="chart-filter-body">
      {allSeries.length > 0 && (
        <>
          <div className={headingRow}>
            <MenuHeading>Series</MenuHeading>
            {hiddenSeriesSet.size > 0 && (
              <Chip onClick={selectAllSeries} testId="chart-filter-series-all">
                Select all
              </Chip>
            )}
          </div>
          <div className={list} role="group" aria-label="Series">
            {allSeries.map((series, i) => (
              <Checkbox
                key={`s-${i}`}
                checked={!hiddenSeriesSet.has(i)}
                onChange={() => toggleSeries(i)}
                testId={`chart-filter-series-${i}`}
                label={
                  <span className={nameRow}>
                    {series.color && (
                      <span
                        className={swatch}
                        style={{ background: series.color }}
                        data-colour-data=""
                        aria-hidden
                      />
                    )}
                    <span className={nameText}>{series.name || `Series ${i + 1}`}</span>
                  </span>
                }
              />
            ))}
          </div>
        </>
      )}

      {allSeries.length > 0 && listCategories && <MenuSeparator />}

      {listCategories && (
        <>
          <div className={headingRow}>
            <MenuHeading>Categories</MenuHeading>
            {hiddenCategoriesSet.size > 0 && (
              <Chip onClick={selectAllCategories} testId="chart-filter-categories-all">
                Select all
              </Chip>
            )}
          </div>
          <div className={list} role="group" aria-label="Categories">
            {allCategories.map((cat, i) => (
              <Checkbox
                key={`c-${i}`}
                checked={!hiddenCategoriesSet.has(i)}
                onChange={() => toggleCategory(i)}
                testId={`chart-filter-category-${i}`}
                label={<span className={nameText}>{cat || "(empty)"}</span>}
              />
            ))}
          </div>
        </>
      )}

      {isFiltered && (
        <>
          <MenuSeparator />
          <div className={footer}>
            <Button onClick={clearAllFilters} data-testid="chart-filter-clear">
              Clear filters
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
