//! FILENAME: app/extensions/Charts/lib/chartDataReader.ts
// PURPOSE: Read cell data from the grid and parse it into chart-ready series.
// CONTEXT: Uses getViewportCells from the API to fetch data for a chart spec's
//          data range, then organizes it into categories and numeric series.

import { getViewportCells } from "../../../src/api/lib";
import { indexToCol } from "../../../src/api";
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

    return { spec: resolvedSpec, data: parsedData };
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

  return { spec: resolvedSpec, data: parsedData };
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
      const val = parseFloat(grid[row][col]);
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
      const num = parseFloat(raw);
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
      const num = parseFloat(raw);
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
