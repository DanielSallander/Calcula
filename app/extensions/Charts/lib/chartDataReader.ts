//! FILENAME: app/extensions/Charts/lib/chartDataReader.ts
// PURPOSE: Read cell data from the grid and parse it into chart-ready series.
// CONTEXT: Uses getViewportCells from the API to fetch data for a chart spec's
//          data range, then organizes it into categories and numeric series.

import { getViewportCells } from "@api/lib";
import { indexToCol } from "@api";

/**
 * Parse a display-formatted number string to a numeric value.
 * Handles currency symbols ($, EUR, GBP), thousands separators (comma, space, period),
 * percentage signs, parenthesized negatives, and other common formatting.
 */
function parseDisplayNumber(raw: string): number {
  if (!raw || raw.trim() === "" || raw === "-" || raw === "--") return NaN;

  let s = raw.trim();

  // Handle parenthesized negatives: (123) -> -123
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  // Handle leading minus
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }

  // Strip currency symbols and common prefixes/suffixes
  s = s.replace(/[$\u20AC\u00A3\u00A5\uFFE5\u20B9]/g, ""); // $, EUR, GBP, JPY, CNY, INR

  // Strip percentage (but remember it for later)
  const isPercent = s.endsWith("%");
  if (isPercent) {
    s = s.slice(0, -1);
  }

  // Strip spaces used as thousands separators (but keep decimal point/comma)
  // Also strip non-breaking spaces
  s = s.replace(/[\s\u00A0]/g, "");

  // Handle European decimal comma: if there's exactly one comma and it's followed by 1-2 digits at end
  // AND there are no periods, treat comma as decimal separator
  if (!s.includes(".") && /,\d{1,2}$/.test(s)) {
    s = s.replace(/,/, ".");
  }

  // Strip remaining commas (thousands separators)
  s = s.replace(/,/g, "");

  // Strip trailing units text (e.g., " units", " kg") - only keep numeric part
  s = s.replace(/[a-zA-Z\s]+$/, "");

  const num = parseFloat(s);
  if (isNaN(num)) return NaN;

  let result = negative ? -num : num;
  if (isPercent) result /= 100;
  return result;
}
import type {
  ChartSpec,
  ChartSeries,
  DataRangeRef,
  ParsedChartData,
  SeriesOrientation,
} from "../types";
import { isPivotDataSource } from "../types";
import { resolveDataSource, resolveSpecReferences } from "./dataSourceResolver";
import { applyTransforms } from "./chartTransforms";
import { readPivotChartData } from "./pivotChartDataReader";
import { applyChartFilters } from "./chartFilters";

// ============================================================================
// Public API
// ============================================================================

/**
 * Read cell data from the grid for a chart spec and parse it into
 * categories + numeric series ready for rendering.
 *
 * The spec.data field can be a DataRangeRef, an A1 reference string,
 * or a named range name. It is resolved to coordinates before reading.
 */
export async function readChartData(spec: ChartSpec): Promise<ParsedChartData> {
  const resolved = await readChartDataResolved(spec);
  return resolved.data;
}

/**
 * Read chart data AND resolve cell references in the spec (title, axis titles,
 * series names). Returns both the resolved spec and the parsed data.
 *
 * Use this when you need the resolved spec for rendering (e.g., "=A1" in title
 * resolves to the cell value).
 */
export async function readChartDataResolved(spec: ChartSpec): Promise<{
  spec: ChartSpec;
  data: ParsedChartData;
  /** Data before chart filters applied (for filter dropdown to show all options). */
  unfilteredData: ParsedChartData;
}> {
  // Resolve cell references (=A1, =Sheet1!B5) in string fields
  const resolvedSpec = await resolveSpecReferences(spec);

  // Handle pivot data source: read directly from pivot view
  if (isPivotDataSource(resolvedSpec.data)) {
    let parsedData = await readPivotChartData(resolvedSpec.data);

    // Apply data transforms if specified
    if (resolvedSpec.transform && resolvedSpec.transform.length > 0) {
      parsedData = applyTransforms(parsedData, resolvedSpec.transform);
    }

    const unfilteredData = parsedData;

    // Apply chart filters (hide series/categories)
    parsedData = applyChartFilters(parsedData, resolvedSpec.filters);

    return { spec: resolvedSpec, data: parsedData, unfilteredData };
  }

  // Standard cell range data source
  const { hasHeaders, seriesOrientation, categoryIndex, series } = resolvedSpec;

  // Resolve the data source to concrete coordinates
  const dataRef = await resolveDataSource(resolvedSpec.data);

  // Fetch all cells in the data range
  const cells = await getViewportCells(
    dataRef.startRow,
    dataRef.startCol,
    dataRef.endRow,
    dataRef.endCol,
  );

  // Build a 2D grid of display values
  const numRows = dataRef.endRow - dataRef.startRow + 1;
  const numCols = dataRef.endCol - dataRef.startCol + 1;
  const grid: string[][] = Array.from({ length: numRows }, () =>
    Array(numCols).fill(""),
  );

  for (const cell of cells) {
    const r = cell.row - dataRef.startRow;
    const c = cell.col - dataRef.startCol;
    if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
      grid[r][c] = cell.display;
    }
  }

  let parsedData = seriesOrientation === "columns"
    ? parseColumnOriented(grid, numRows, numCols, hasHeaders, categoryIndex, series)
    : parseRowOriented(grid, numRows, numCols, hasHeaders, categoryIndex, series);

  // Apply data transforms if specified
  if (resolvedSpec.transform && resolvedSpec.transform.length > 0) {
    parsedData = applyTransforms(parsedData, resolvedSpec.transform);
  }

  const unfilteredData = parsedData;

  // Apply chart filters (hide series/categories)
  parsedData = applyChartFilters(parsedData, resolvedSpec.filters);

  return { spec: resolvedSpec, data: parsedData, unfilteredData };
}

/**
 * Auto-detect series from a data range.
 * Called when creating a new chart to suggest default series mapping.
 */
export async function autoDetectSeries(
  dataRange: DataRangeRef,
  hasHeaders: boolean,
): Promise<{
  categoryIndex: number;
  series: ChartSeries[];
  orientation: SeriesOrientation;
}> {
  const cells = await getViewportCells(
    dataRange.startRow,
    dataRange.startCol,
    dataRange.endRow,
    dataRange.endCol,
  );

  const numRows = dataRange.endRow - dataRange.startRow + 1;
  const numCols = dataRange.endCol - dataRange.startCol + 1;
  const grid: string[][] = Array.from({ length: numRows }, () =>
    Array(numCols).fill(""),
  );

  for (const cell of cells) {
    const r = cell.row - dataRange.startRow;
    const c = cell.col - dataRange.startCol;
    if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
      grid[r][c] = cell.display;
    }
  }

  // Default: columns orientation, first column as category
  const orientation: SeriesOrientation = "columns";
  const categoryIndex = 0;

  const dataStartRow = hasHeaders ? 1 : 0;
  const series: ChartSeries[] = [];

  for (let col = 0; col < numCols; col++) {
    if (col === categoryIndex) continue;

    // Check if this column has any numeric data
    let hasNumeric = false;
    for (let row = dataStartRow; row < numRows; row++) {
      const val = parseDisplayNumber(grid[row][col]);
      if (!isNaN(val)) {
        hasNumeric = true;
        break;
      }
    }
    if (!hasNumeric) continue;

    const name = hasHeaders && grid[0][col]
      ? grid[0][col]
      : indexToCol(dataRange.startCol + col);

    series.push({
      name,
      sourceIndex: col,
      color: null,
    });
  }

  return { categoryIndex, series, orientation };
}

/**
 * Re-derive series definitions for a specific orientation.
 * Used when switching between rows and columns orientation on an existing chart.
 */
export async function autoDetectSeriesForOrientation(
  dataRange: DataRangeRef,
  hasHeaders: boolean,
  orientation: SeriesOrientation,
): Promise<{
  categoryIndex: number;
  series: ChartSeries[];
}> {
  const cells = await getViewportCells(
    dataRange.startRow,
    dataRange.startCol,
    dataRange.endRow,
    dataRange.endCol,
  );

  const numRows = dataRange.endRow - dataRange.startRow + 1;
  const numCols = dataRange.endCol - dataRange.startCol + 1;
  const grid: string[][] = Array.from({ length: numRows }, () =>
    Array(numCols).fill(""),
  );

  for (const cell of cells) {
    const r = cell.row - dataRange.startRow;
    const c = cell.col - dataRange.startCol;
    if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
      grid[r][c] = cell.display;
    }
  }

  const categoryIndex = 0;
  const series: ChartSeries[] = [];

  if (orientation === "columns") {
    const dataStartRow = hasHeaders ? 1 : 0;
    for (let col = 0; col < numCols; col++) {
      if (col === categoryIndex) continue;
      let hasNumeric = false;
      for (let row = dataStartRow; row < numRows; row++) {
        if (!isNaN(parseDisplayNumber(grid[row][col]))) { hasNumeric = true; break; }
      }
      if (!hasNumeric) continue;
      const name = hasHeaders && grid[0][col] ? grid[0][col] : indexToCol(dataRange.startCol + col);
      series.push({ name, sourceIndex: col, color: null });
    }
  } else {
    const dataStartCol = hasHeaders ? 1 : 0;
    for (let row = 0; row < numRows; row++) {
      if (row === categoryIndex) continue;
      let hasNumeric = false;
      for (let col = dataStartCol; col < numCols; col++) {
        if (!isNaN(parseDisplayNumber(grid[row][col]))) { hasNumeric = true; break; }
      }
      if (!hasNumeric) continue;
      const name = hasHeaders && grid[row][0] ? grid[row][0] : `Row ${dataRange.startRow + row + 1}`;
      series.push({ name, sourceIndex: row, color: null });
    }
  }

  return { categoryIndex, series };
}

// ============================================================================
// Internal Parsers
// ============================================================================

function parseColumnOriented(
  grid: string[][],
  numRows: number,
  numCols: number,
  hasHeaders: boolean,
  categoryIndex: number,
  seriesDefs: ChartSeries[],
): ParsedChartData {
  const dataStartRow = hasHeaders ? 1 : 0;

  // Extract category labels
  const categories: string[] = [];
  for (let row = dataStartRow; row < numRows; row++) {
    categories.push(grid[row][categoryIndex] || `Row ${row + 1}`);
  }

  // Extract series values
  const series = seriesDefs.map((def) => {
    const values: number[] = [];
    for (let row = dataStartRow; row < numRows; row++) {
      const raw = grid[row][def.sourceIndex];
      const num = parseDisplayNumber(raw);
      values.push(isNaN(num) ? 0 : num);
    }
    return {
      name: def.name,
      values,
      color: def.color,
    };
  });

  return { categories, series };
}

function parseRowOriented(
  grid: string[][],
  numRows: number,
  numCols: number,
  hasHeaders: boolean,
  categoryIndex: number,
  seriesDefs: ChartSeries[],
): ParsedChartData {
  const dataStartCol = hasHeaders ? 1 : 0;

  // Extract category labels
  const categories: string[] = [];
  for (let col = dataStartCol; col < numCols; col++) {
    categories.push(grid[categoryIndex][col] || `Col ${col + 1}`);
  }

  // Extract series values
  const series = seriesDefs.map((def) => {
    const values: number[] = [];
    for (let col = dataStartCol; col < numCols; col++) {
      const raw = grid[def.sourceIndex][col];
      const num = parseDisplayNumber(raw);
      values.push(isNaN(num) ? 0 : num);
    }
    return {
      name: def.name,
      values,
      color: def.color,
    };
  });

  return { categories, series };
}
