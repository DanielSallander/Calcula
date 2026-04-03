//! FILENAME: app/extensions/Charts/lib/dataSourceResolver.ts
// PURPOSE: Resolve a DataSource (string or DataRangeRef) into a concrete DataRangeRef.
// CONTEXT: Allows ChartSpec.data to be an A1 reference string ("Sheet1!A1:D10"),
//          a named range name ("SalesData"), or an explicit DataRangeRef object.
//          This resolver normalizes all forms into DataRangeRef for data reading.

import {
  getNamedRange,
  getSheets,
} from "@api";
import { getViewportCells } from "@api/lib";
import type { ChartSpec, DataSource, DataRangeRef } from "../types";
import { isDataRangeRef, isPivotDataSource } from "../types";

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve a DataSource to a concrete DataRangeRef.
 *
 * Accepts:
 * - A `DataRangeRef` object — returned as-is.
 * - An A1 reference string like `"Sheet1!A1:D10"` — parsed to coordinates.
 * - A named range name like `"SalesData"` — resolved via the backend.
 *
 * @throws Error if the reference cannot be resolved.
 */
export async function resolveDataSource(
  source: DataSource,
  fallbackSheetIndex?: number,
): Promise<DataRangeRef> {
  // Already resolved
  if (isDataRangeRef(source)) {
    return source;
  }

  // Pivot data sources are handled separately by pivotChartDataReader
  if (isPivotDataSource(source)) {
    throw new Error("PivotDataSource should be handled by pivotChartDataReader, not resolveDataSource.");
  }

  const ref = source.trim();
  if (!ref) {
    throw new Error("Empty data source reference.");
  }

  // Try parsing as A1 reference first
  const parsed = parseA1Reference(ref);
  if (parsed) {
    // Resolve sheet name to index if present
    const sheetIndex = parsed.sheetName
      ? await resolveSheetIndex(parsed.sheetName)
      : (fallbackSheetIndex ?? 0);

    return {
      sheetIndex,
      startRow: parsed.startRow,
      startCol: parsed.startCol,
      endRow: parsed.endRow,
      endCol: parsed.endCol,
    };
  }

  // Try resolving as a named range
  const namedRange = await getNamedRange(ref);
  if (namedRange) {
    const rangeCoords = parseRefersToFormula(namedRange.refersTo);
    if (rangeCoords) {
      const sheetIndex = rangeCoords.sheetName
        ? await resolveSheetIndex(rangeCoords.sheetName)
        : (namedRange.sheetIndex ?? fallbackSheetIndex ?? 0);

      return {
        sheetIndex,
        startRow: rangeCoords.startRow,
        startCol: rangeCoords.startCol,
        endRow: rangeCoords.endRow,
        endCol: rangeCoords.endCol,
      };
    }
    throw new Error(
      `Named range "${ref}" refers to "${namedRange.refersTo}" which is not a simple cell range.`,
    );
  }

  throw new Error(
    `Cannot resolve data source "${ref}". Expected an A1 reference (e.g., "Sheet1!A1:D10") or a named range name.`,
  );
}

// ============================================================================
// A1 Reference Parser
// ============================================================================

interface ParsedA1 {
  sheetName?: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Parse an A1-style reference string into row/col coordinates.
 * Supports: "A1:D10", "Sheet1!A1:D10", "'My Sheet'!A1:D10", "A1" (single cell).
 * Dollar signs ($) are stripped (absolute references treated same as relative).
 */
function parseA1Reference(ref: string): ParsedA1 | null {
  let remaining = ref;
  let sheetName: string | undefined;

  // Extract sheet name if present (before the !)
  const bangIndex = remaining.lastIndexOf("!");
  if (bangIndex !== -1) {
    sheetName = remaining.substring(0, bangIndex);
    remaining = remaining.substring(bangIndex + 1);

    // Strip surrounding quotes from sheet name
    if (sheetName.startsWith("'") && sheetName.endsWith("'")) {
      sheetName = sheetName.substring(1, sheetName.length - 1);
    }
  }

  // Strip dollar signs
  remaining = remaining.replace(/\$/g, "").trim().toUpperCase();

  // Match: COL ROW : COL ROW  or  COL ROW (single cell)
  const rangeMatch = remaining.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  if (!rangeMatch) return null;

  const startCol = letterToCol(rangeMatch[1]);
  const startRow = parseInt(rangeMatch[2], 10) - 1;
  const endCol = rangeMatch[3] ? letterToCol(rangeMatch[3]) : startCol;
  const endRow = rangeMatch[4] ? parseInt(rangeMatch[4], 10) - 1 : startRow;

  if (startRow < 0 || endRow < 0) return null;

  return {
    sheetName,
    startRow: Math.min(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    endCol: Math.max(startCol, endCol),
  };
}

/**
 * Parse a "refers to" formula from a named range definition.
 * These have the form "=Sheet1!$A$1:$B$10" or "=$A$1:$B$10".
 */
function parseRefersToFormula(refersTo: string): ParsedA1 | null {
  let formula = refersTo.trim();
  if (formula.startsWith("=")) {
    formula = formula.substring(1);
  }
  return parseA1Reference(formula);
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert column letters (A, B, ..., AA, AB, ...) to 0-based index. */
function letterToCol(letters: string): number {
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col - 1;
}

/** Resolve a sheet name to its 0-based index. */
async function resolveSheetIndex(sheetName: string): Promise<number> {
  const result = await getSheets();
  const normalized = sheetName.toLowerCase();
  const sheet = result.sheets.find(
    (s) => s.name.toLowerCase() === normalized,
  );
  if (sheet) return sheet.index;
  throw new Error(`Sheet "${sheetName}" not found.`);
}

// ============================================================================
// Cell Reference Resolution (for spec string fields)
// ============================================================================

/**
 * Check if a string value is a cell reference (starts with "=" followed by a cell ref).
 * Examples: "=A3", "=Sheet1!B5", "='My Sheet'!C1"
 */
function isCellReference(value: string): boolean {
  if (!value.startsWith("=")) return false;
  const ref = value.substring(1).trim();
  const parsed = parseA1Reference(ref);
  // Must be a single cell (not a range)
  return parsed !== null && parsed.startRow === parsed.endRow && parsed.startCol === parsed.endCol;
}

/**
 * Resolve a cell reference string to the display value of that cell.
 * Input: "=A3" or "=Sheet1!B5"
 * Returns: the cell's display text, or null if the cell is empty.
 */
async function resolveCellValue(
  ref: string,
  fallbackSheetIndex: number,
): Promise<string | null> {
  const cellRef = ref.substring(1).trim();
  const parsed = parseA1Reference(cellRef);
  if (!parsed) return null;

  const sheetIndex = parsed.sheetName
    ? await resolveSheetIndex(parsed.sheetName)
    : fallbackSheetIndex;

  const cells = await getViewportCells(
    parsed.startRow,
    parsed.startCol,
    parsed.startRow,
    parsed.startCol,
  );

  // getViewportCells uses the active sheet; for cross-sheet we'd need
  // a sheet-aware fetch. For now this works for same-sheet references.
  if (cells.length > 0) {
    return cells[0].display || null;
  }
  return null;
}

/**
 * Resolve a string field that may be a cell reference.
 * If it starts with "=" and is a valid cell ref, fetches the cell value.
 * Otherwise returns the original string unchanged.
 */
async function resolveStringField(
  value: string | null,
  fallbackSheetIndex: number,
): Promise<string | null> {
  if (!value || !isCellReference(value)) return value;
  return resolveCellValue(value, fallbackSheetIndex);
}

/**
 * Resolve all cell references in a ChartSpec's string fields.
 * Fields that support cell references:
 * - `title` ("=A1" reads the chart title from cell A1)
 * - `xAxis.title` / `yAxis.title`
 * - `series[].name`
 *
 * Returns a new spec with resolved values. The original spec is not modified.
 */
export async function resolveSpecReferences(spec: ChartSpec): Promise<ChartSpec> {
  // Determine the sheet index for resolving relative refs
  const sheetIndex = isDataRangeRef(spec.data) ? spec.data.sheetIndex : 0;

  // Resolve in parallel for performance
  const [title, xAxisTitle, yAxisTitle, ...seriesNames] = await Promise.all([
    resolveStringField(spec.title, sheetIndex),
    resolveStringField(spec.xAxis.title, sheetIndex),
    resolveStringField(spec.yAxis.title, sheetIndex),
    ...spec.series.map((s) => resolveStringField(s.name, sheetIndex)),
  ]);

  // Only create a new object if something changed
  const titleChanged = title !== spec.title;
  const xChanged = xAxisTitle !== spec.xAxis.title;
  const yChanged = yAxisTitle !== spec.yAxis.title;
  const seriesChanged = seriesNames.some((name, i) => name !== spec.series[i].name);

  if (!titleChanged && !xChanged && !yChanged && !seriesChanged) {
    return spec;
  }

  return {
    ...spec,
    title: title,
    xAxis: xChanged ? { ...spec.xAxis, title: xAxisTitle } : spec.xAxis,
    yAxis: yChanged ? { ...spec.yAxis, title: yAxisTitle } : spec.yAxis,
    series: seriesChanged
      ? spec.series.map((s, i) => ({
          ...s,
          name: seriesNames[i] ?? s.name,
        }))
      : spec.series,
  };
}
