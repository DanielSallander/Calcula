//! FILENAME: app/extensions/Charts/lib/chartDataReader.ts
// PURPOSE: Read cell data from the grid and parse it into chart-ready series.
// CONTEXT: Uses getViewportCells from the API to fetch data for a chart spec's
//          data range, then organizes it into categories and numeric series.

import { getViewportCells } from "@api/lib";
import { indexToCol } from "@api";

import type {
  ChartSpec,
  ChartSeries,
  DataRangeRef,
  DataSource,
  ParsedChartData,
  SeriesOrientation,
  TransformSpec,
  TransformDiagnostic,
  TidyData,
  TidyField,
} from "../types";
import { isPivotDataSource } from "../types";
import { resolveDataSource, resolveSpecReferences } from "./dataSourceResolver";
import { applyTransforms } from "./chartTransforms";
import { readPivotChartData } from "./pivotChartDataReader";
import { applyChartFilters } from "./chartFilters";
import { parseDisplayNumber, detectCategoryField } from "./chartFieldTypes";

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
  /** Non-fatal issues from the transform pipeline (for the spec editor). */
  diagnostics: TransformDiagnostic[];
}> {
  // Resolve cell references (=A1, =Sheet1!B5) in string fields
  const resolvedSpec = await resolveSpecReferences(spec);
  const diagnostics: TransformDiagnostic[] = [];

  // Pre-resolve any lookup transforms' secondary sources (async) so the
  // synchronous transform pipeline can join them by index.
  const lookupData = await resolveLookupSources(resolvedSpec.transform);

  // Handle pivot data source: read directly from pivot view
  if (isPivotDataSource(resolvedSpec.data)) {
    let parsedData = await readPivotChartData(resolvedSpec.data);

    // Apply data transforms if specified
    if (resolvedSpec.transform && resolvedSpec.transform.length > 0) {
      parsedData = applyTransforms(parsedData, resolvedSpec.transform, diagnostics, lookupData);
    }

    const unfilteredData = parsedData;

    // Apply chart filters (hide series/categories)
    parsedData = applyChartFilters(parsedData, resolvedSpec.filters);

    return { spec: resolvedSpec, data: withCategoryField(parsedData), unfilteredData, diagnostics };
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

  // Long-format view of the source columns, for the pivot transform.
  const tidyData = buildTidyData(grid, numRows, numCols, hasHeaders, seriesOrientation);

  // Apply data transforms if specified
  if (resolvedSpec.transform && resolvedSpec.transform.length > 0) {
    parsedData = applyTransforms(parsedData, resolvedSpec.transform, diagnostics, lookupData, tidyData);
  }

  const unfilteredData = parsedData;

  // Apply chart filters (hide series/categories)
  parsedData = applyChartFilters(parsedData, resolvedSpec.filters);

  return { spec: resolvedSpec, data: withCategoryField(parsedData), unfilteredData, diagnostics };
}

/**
 * Read every `lookup` transform's secondary source into a ParsedChartData,
 * keyed by the transform's index. Done before the synchronous transform
 * pipeline so the join itself stays pure. Failures are left unset — applyLookup
 * surfaces a diagnostic for those.
 */
async function resolveLookupSources(
  transforms: TransformSpec[] | undefined,
): Promise<Map<number, ParsedChartData>> {
  const map = new Map<number, ParsedChartData>();
  if (!transforms) return map;
  for (let i = 0; i < transforms.length; i++) {
    const t = transforms[i];
    if (t.type === "lookup") {
      try {
        map.set(i, await readLookupRange(t.from));
      } catch {
        // Leave unset; applyLookup reports a "could not be loaded" diagnostic.
      }
    }
  }
  return map;
}

/**
 * Read a lookup table range as a ParsedChartData: columns orientation, header
 * row, first column as the join key (categories), remaining columns as series.
 */
async function readLookupRange(from: DataSource): Promise<ParsedChartData> {
  const ref = await resolveDataSource(from);
  const detected = await autoDetectSeries(ref, true);

  const cells = await getViewportCells(ref.startRow, ref.startCol, ref.endRow, ref.endCol);
  const numRows = ref.endRow - ref.startRow + 1;
  const numCols = ref.endCol - ref.startCol + 1;
  const grid: string[][] = Array.from({ length: numRows }, () => Array(numCols).fill(""));
  for (const cell of cells) {
    const r = cell.row - ref.startRow;
    const c = cell.col - ref.startCol;
    if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
      grid[r][c] = cell.display;
    }
  }

  return parseColumnOriented(grid, numRows, numCols, true, detected.categoryIndex, detected.series);
}

/**
 * Attach a typed categoryField when the (post-transform) category labels are
 * all numeric or all dates — enabling a quantitative/temporal X axis for
 * scatter/bubble. Computed here, after transforms/filters, so the values always
 * align with the final categories (transforms rebuild categories and drop any
 * stale typing).
 */
function withCategoryField(d: ParsedChartData): ParsedChartData {
  const categoryField = detectCategoryField(d.categories);
  return categoryField ? { ...d, categoryField } : d;
}

/**
 * Build a long-format view of the source range — one field per source column
 * (columns orientation) or per source row (rows orientation), named by its
 * header. Used by the pivot transform to reshape long tables into wide series.
 */
function buildTidyData(
  grid: string[][],
  numRows: number,
  numCols: number,
  hasHeaders: boolean,
  orientation: SeriesOrientation,
): TidyData {
  const fields: TidyField[] = [];

  if (orientation === "columns") {
    const dataStartRow = hasHeaders ? 1 : 0;
    for (let c = 0; c < numCols; c++) {
      const header = hasHeaders ? (grid[0]?.[c] ?? "").trim() : "";
      const values: string[] = [];
      for (let r = dataStartRow; r < numRows; r++) values.push(grid[r]?.[c] ?? "");
      fields.push({ name: header || `Column ${c + 1}`, values });
    }
  } else {
    const dataStartCol = hasHeaders ? 1 : 0;
    for (let r = 0; r < numRows; r++) {
      const header = hasHeaders ? (grid[r]?.[0] ?? "").trim() : "";
      const values: string[] = [];
      for (let c = dataStartCol; c < numCols; c++) values.push(grid[r]?.[c] ?? "");
      fields.push({ name: header || `Row ${r + 1}`, values });
    }
  }

  return { fields };
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
