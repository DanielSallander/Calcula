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

// ============================================================================
// Public API
// ============================================================================

/**
 * Read cell data from the grid for a chart spec and parse it into
 * categories + numeric series ready for rendering.
 */
export async function readChartData(spec: ChartSpec): Promise<ParsedChartData> {
  const { data, hasHeaders, seriesOrientation, categoryIndex, series } = spec;

  // Fetch all cells in the data range
  const cells = await getViewportCells(
    data.startRow,
    data.startCol,
    data.endRow,
    data.endCol,
  );

  // Build a 2D grid of display values
  const numRows = data.endRow - data.startRow + 1;
  const numCols = data.endCol - data.startCol + 1;
  const grid: string[][] = Array.from({ length: numRows }, () =>
    Array(numCols).fill(""),
  );

  for (const cell of cells) {
    const r = cell.row - data.startRow;
    const c = cell.col - data.startCol;
    if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
      grid[r][c] = cell.display;
    }
  }

  if (seriesOrientation === "columns") {
    return parseColumnOriented(grid, numRows, numCols, hasHeaders, categoryIndex, series);
  } else {
    return parseRowOriented(grid, numRows, numCols, hasHeaders, categoryIndex, series);
  }
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
