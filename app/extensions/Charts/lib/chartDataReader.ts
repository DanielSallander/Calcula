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
import { resolveParams } from "./chartParams";
import { getPointSelection } from "../handlers/chartPointSelection";
import type { FormulaValue } from "./chartFormula";
import { readPivotChartData } from "./pivotChartDataReader";
import { applyChartFilters } from "./chartFilters";
import { parseDisplayNumber, detectCategoryField } from "./chartFieldTypes";
import { lowerEncoding } from "./lowerEncoding";

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
export async function readChartDataResolved(spec: ChartSpec, depth = 0, chartId?: string): Promise<{
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

  // Concatenation: read each child chart independently and tile them. The
  // container has no data of its own, so this short-circuits the single-source
  // read entirely. Takes precedence over facet/repeat. Bounded by depth so a
  // nested/cyclic concat spec can't recurse without limit.
  if (resolvedSpec.concat && resolvedSpec.concat.charts.length > 0 && depth < MAX_CONCAT_DEPTH) {
    const concat = await assembleConcat(
      resolvedSpec.concat.charts,
      (child) => readChartDataResolved(child, depth + 1),
      diagnostics,
    );
    const empty: ParsedChartData = { categories: [], series: [] };
    return { spec: resolvedSpec, data: { ...empty, concat }, unfilteredData: empty, diagnostics };
  }

  // Resolve named parameters once (literal or live cell value); injected into
  // filter/calculate expression scopes below. Empty map when none are declared.
  const params = await resolveParams(resolvedSpec);

  // Live point-selection (ephemeral) for THIS chart, attached to the returned
  // data so conditional encoding's `inSelection` can highlight. Only the top-
  // level grid chart has a chartId; previews/export/concat children get none.
  const selection = chartId ? getPointSelection(chartId) : undefined;

  // Handle pivot data source: read directly from pivot view
  if (isPivotDataSource(resolvedSpec.data)) {
    let parsedData = await readPivotChartData(resolvedSpec.data);

    // Apply data transforms if specified
    if (resolvedSpec.transform && resolvedSpec.transform.length > 0) {
      // Pre-resolve lookup sources (async) so the sync pipeline can join by index.
      const lookupData = await resolveLookupSources(resolvedSpec.transform);
      parsedData = applyTransforms(parsedData, resolvedSpec.transform, diagnostics, lookupData, undefined, params);
    }

    const unfilteredData = parsedData;

    // Apply chart filters (hide series/categories)
    parsedData = applyChartFilters(parsedData, resolvedSpec.filters);

    const pivotData = withCategoryField(parsedData);
    return {
      spec: resolvedSpec,
      data: selection ? { ...pivotData, selection } : pivotData,
      unfilteredData,
      diagnostics,
    };
  }

  // Standard cell range data source
  const { hasHeaders, seriesOrientation } = resolvedSpec;

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

  // Compile an encoding spec to the series model now that we know the headers.
  const headers = seriesOrientation === "columns"
    ? (grid[0] ?? [])
    : grid.map((row) => row[0] ?? "");
  const lowered = resolvedSpec.encoding ? lowerEncoding(resolvedSpec, headers) : resolvedSpec;

  let parsedData = seriesOrientation === "columns"
    ? parseColumnOriented(grid, numRows, numCols, hasHeaders, lowered.categoryIndex, lowered.series)
    : parseRowOriented(grid, numRows, numCols, hasHeaders, lowered.categoryIndex, lowered.series);

  // Long-format view of the source columns, for the pivot transform.
  const tidyData = buildTidyData(grid, numRows, numCols, hasHeaders, seriesOrientation);

  // Resolve lookup sources once (async); reused by the top-level transform run
  // AND by every facet panel so faceting never re-reads ranges.
  const lookupData = lowered.transform && lowered.transform.length > 0
    ? await resolveLookupSources(lowered.transform)
    : new Map<number, ParsedChartData>();

  // Apply data transforms if specified. Lookups are resolved against the lowered
  // transforms so encoding (which may prepend a pivot) keeps indices aligned.
  if (lowered.transform && lowered.transform.length > 0) {
    parsedData = applyTransforms(parsedData, lowered.transform, diagnostics, lookupData, tidyData, params);
  }

  const unfilteredData = parsedData;

  // Apply chart filters (hide series/categories)
  parsedData = applyChartFilters(parsedData, lowered.filters);

  // Faceting: one panel per distinct value of facet.field (partitions long rows,
  // re-running transforms per panel). Unsupported specs return undefined → the
  // top-level data renders as a single chart.
  const facets = lowered.facet?.field
    ? partitionByFacet(grid, numRows, numCols, hasHeaders, seriesOrientation, lowered.facet.field, lowered, lookupData, params)
    : undefined;

  let finalData = withCategoryField(parsedData);
  if (facets) finalData = { ...finalData, facets };
  if (selection) finalData = { ...finalData, selection };
  return {
    spec: lowered,
    data: finalData,
    unfilteredData,
    diagnostics,
  };
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

/** Upper bound on facet panels — guards against cardinality explosion. */
export const MAX_FACETS = 50;

/** Upper bound on concat panels — bounds the number of child reads. */
export const MAX_CONCAT_PANELS = 50;

/** Max concat nesting depth — guards against deeply nested / cyclic specs. */
export const MAX_CONCAT_DEPTH = 4;

/**
 * Read a concat container's children into renderable panels. Each child is read
 * independently via the injected `readChild` (in production a recursive
 * readChartDataResolved). Uses allSettled so ONE failing child (bad range,
 * malformed spec) is dropped rather than failing the whole dashboard — the rest
 * still render. Children beyond {@link MAX_CONCAT_PANELS} are ignored. Child
 * diagnostics from successful reads are appended to `diagnostics`.
 *
 * Pure given `readChild` (no IO of its own) — unit-tested with a fake reader.
 */
export async function assembleConcat(
  charts: ChartSpec[],
  readChild: (child: ChartSpec) => Promise<{ spec: ChartSpec; data: ParsedChartData; diagnostics: TransformDiagnostic[] }>,
  diagnostics: TransformDiagnostic[],
): Promise<Array<{ spec: ChartSpec; data: ParsedChartData }>> {
  const children = charts.slice(0, MAX_CONCAT_PANELS);
  const results = await Promise.allSettled(children.map((child) => readChild(child)));
  const concat: Array<{ spec: ChartSpec; data: ParsedChartData }> = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      concat.push({ spec: r.value.spec, data: r.value.data });
      diagnostics.push(...r.value.diagnostics);
    }
    // Rejected children are dropped: one bad panel must not blank the dashboard.
  }
  return concat;
}

/**
 * Partition the long source rows by a categorical field's distinct values,
 * producing one ParsedChartData per value (a facet panel). The field is matched
 * by exact (trimmed) header name. Distinct values are taken in first-seen order
 * and capped at {@link MAX_FACETS}. Transforms run PER PANEL (Vega-Lite facet
 * semantics) over the panel's row subset, reusing the single pre-resolved
 * `lookupData` map (no async re-read). Returns `undefined` (→ caller renders a
 * single chart) when faceting is unsupported for this spec: pivot data source
 * (no grid), rows orientation, no header row, an unknown field, or no rows.
 *
 * Pure given its inputs (no IO) — unit-tested directly.
 */
export function partitionByFacet(
  grid: string[][],
  numRows: number,
  numCols: number,
  hasHeaders: boolean,
  orientation: SeriesOrientation,
  facetField: string,
  lowered: ChartSpec,
  lookupData: Map<number, ParsedChartData>,
  params?: ReadonlyMap<string, FormulaValue>,
): Array<{ value: string; data: ParsedChartData }> | undefined {
  // v1: needs a header row in columns orientation to reference the field by name.
  if (orientation !== "columns" || !hasHeaders) return undefined;

  const headerRow = grid[0] ?? [];
  const target = facetField.trim();
  const facetCol = headerRow.findIndex((h) => (h ?? "").trim() === target);
  if (facetCol < 0) return undefined;

  // Distinct facet values in first-seen (row) order, capped.
  const seen = new Set<string>();
  const order: string[] = [];
  for (let r = 1; r < numRows; r++) {
    const v = (grid[r]?.[facetCol] ?? "").trim();
    if (!seen.has(v)) {
      seen.add(v);
      order.push(v);
      if (order.length >= MAX_FACETS) break;
    }
  }
  if (order.length === 0) return undefined;

  const header = grid[0];
  // Per-panel transforms surface diagnostics on the full-data run already; keep
  // a throwaway sink here so the same warnings aren't reported once per panel.
  const sink: TransformDiagnostic[] = [];

  return order.map((value) => {
    // Header row + only the rows whose facet cell matches this value.
    const subGrid: string[][] = [header];
    for (let r = 1; r < numRows; r++) {
      if ((grid[r]?.[facetCol] ?? "").trim() === value) subGrid.push(grid[r]);
    }
    const subRows = subGrid.length;

    let parsed = parseColumnOriented(subGrid, subRows, numCols, hasHeaders, lowered.categoryIndex, lowered.series);
    if (lowered.transform && lowered.transform.length > 0) {
      const subTidy = buildTidyData(subGrid, subRows, numCols, hasHeaders, orientation);
      parsed = applyTransforms(parsed, lowered.transform, sink, lookupData, subTidy, params);
    }
    // NOTE: chart filters (hiddenCategories/hiddenSeries) are POSITIONAL indices
    // into the top-level chart's arrays — they don't map onto each panel's own
    // category/series set, so they are intentionally not applied per panel (v1).
    return { value: value || "(blank)", data: withCategoryField(parsed) };
  });
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
