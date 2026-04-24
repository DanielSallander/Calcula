//! FILENAME: app/extensions/Charts/lib/seriesFormula.ts
// PURPOSE: Build Excel-style =SERIES(name, categories, values, order) formulas
//          from a chart's spec and resolve per-series cell range references.
// CONTEXT: Used when a chart series is selected to display the SERIES formula
//          in the formula bar and highlight the source data ranges on the sheet.

import { columnToLetter } from "@api";
import type { ChartSpec, DataRangeRef } from "../types";
import { isPivotDataSource } from "../types";
import { resolveDataSource } from "./dataSourceResolver";

// ============================================================================
// Types
// ============================================================================

/** Resolved cell range for a single component of a SERIES formula. */
export interface ResolvedRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  sheetName?: string;
}

/** All resolved references for a single series. */
export interface SeriesReferences {
  nameRef?: ResolvedRange;
  categoryRef?: ResolvedRange;
  valuesRef?: ResolvedRange;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build the =SERIES(name, categories, values, order) formula string
 * for a given series within a chart spec.
 *
 * @param spec - The chart specification
 * @param seriesIndex - 0-based index into spec.series[]
 * @param sheetName - Name of the sheet containing the chart's data
 * @returns The SERIES formula string (e.g., "=SERIES(Sheet1!$B$1,Sheet1!$A$2:$A$4,Sheet1!$B$2:$B$4,1)")
 */
export async function buildSeriesFormula(
  spec: ChartSpec,
  seriesIndex: number,
  sheetName: string,
): Promise<string> {
  const series = spec.series[seriesIndex];
  if (!series) return "";

  const order = seriesIndex + 1;

  // If we have stored per-series refs (from XLSX import), use them directly
  if (spec.seriesRefs && spec.seriesRefs[seriesIndex]) {
    const ref = spec.seriesRefs[seriesIndex];
    const nameArg = ref.nameRef || `"${escapeSeriesName(series.name)}"`;
    const catArg = ref.catRef || "";
    const valArg = ref.valRef || "";
    return `=SERIES(${nameArg},${catArg},${valArg},${order})`;
  }

  // Compute references from the data range + sourceIndex
  if (isPivotDataSource(spec.data)) {
    // Pivot charts don't have cell references
    return `=SERIES("${escapeSeriesName(series.name)}",,,${order})`;
  }

  try {
    const dataRef = await resolveDataSource(spec.data);
    const refs = computeSeriesRanges(spec, seriesIndex, dataRef, sheetName);

    const nameArg = refs.nameRef
      ? formatAbsoluteRef(refs.nameRef)
      : `"${escapeSeriesName(series.name)}"`;
    const catArg = refs.categoryRef ? formatAbsoluteRef(refs.categoryRef) : "";
    const valArg = refs.valuesRef ? formatAbsoluteRef(refs.valuesRef) : "";

    return `=SERIES(${nameArg},${catArg},${valArg},${order})`;
  } catch {
    return `=SERIES("${escapeSeriesName(series.name)}",,,${order})`;
  }
}

/**
 * Get the resolved cell ranges for a series (for highlighting on the grid).
 *
 * @param spec - The chart specification
 * @param seriesIndex - 0-based index into spec.series[]
 * @param sheetName - Name of the sheet containing the chart's data
 * @returns Resolved ranges for name, category, and values
 */
export async function getSeriesReferences(
  spec: ChartSpec,
  seriesIndex: number,
  sheetName: string,
): Promise<SeriesReferences> {
  const series = spec.series[seriesIndex];
  if (!series) return {};

  // If we have stored per-series refs, parse them
  if (spec.seriesRefs && spec.seriesRefs[seriesIndex]) {
    const ref = spec.seriesRefs[seriesIndex];
    return {
      nameRef: ref.nameRef ? parseA1ToRange(ref.nameRef) : undefined,
      categoryRef: ref.catRef ? parseA1ToRange(ref.catRef) : undefined,
      valuesRef: ref.valRef ? parseA1ToRange(ref.valRef) : undefined,
    };
  }

  // Compute from data range
  if (isPivotDataSource(spec.data)) return {};

  try {
    const dataRef = await resolveDataSource(spec.data);
    return computeSeriesRanges(spec, seriesIndex, dataRef, sheetName);
  } catch {
    return {};
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Compute the name, category, and value ranges for a series
 * based on the chart's data range and series orientation.
 */
function computeSeriesRanges(
  spec: ChartSpec,
  seriesIndex: number,
  dataRef: DataRangeRef,
  sheetName: string,
): SeriesReferences {
  const series = spec.series[seriesIndex];
  if (!series) return {};

  const { hasHeaders, seriesOrientation, categoryIndex } = spec;
  const sourceIndex = series.sourceIndex;

  if (seriesOrientation === "columns") {
    // Column-oriented: each column is a series
    const dataStartRow = hasHeaders ? dataRef.startRow + 1 : dataRef.startRow;
    const seriesCol = dataRef.startCol + sourceIndex;
    const catCol = dataRef.startCol + categoryIndex;

    return {
      nameRef: hasHeaders
        ? { startRow: dataRef.startRow, startCol: seriesCol, endRow: dataRef.startRow, endCol: seriesCol, sheetName }
        : undefined,
      categoryRef: {
        startRow: dataStartRow, startCol: catCol,
        endRow: dataRef.endRow, endCol: catCol,
        sheetName,
      },
      valuesRef: {
        startRow: dataStartRow, startCol: seriesCol,
        endRow: dataRef.endRow, endCol: seriesCol,
        sheetName,
      },
    };
  } else {
    // Row-oriented: each row is a series
    const dataStartCol = hasHeaders ? dataRef.startCol + 1 : dataRef.startCol;
    const seriesRow = dataRef.startRow + sourceIndex;
    const catRow = dataRef.startRow + categoryIndex;

    return {
      nameRef: hasHeaders
        ? { startRow: seriesRow, startCol: dataRef.startCol, endRow: seriesRow, endCol: dataRef.startCol, sheetName }
        : undefined,
      categoryRef: {
        startRow: catRow, startCol: dataStartCol,
        endRow: catRow, endCol: dataRef.endCol,
        sheetName,
      },
      valuesRef: {
        startRow: seriesRow, startCol: dataStartCol,
        endRow: seriesRow, endCol: dataRef.endCol,
        sheetName,
      },
    };
  }
}

/**
 * Format a ResolvedRange as an absolute A1-style reference.
 * E.g., { startRow: 0, startCol: 1, endRow: 3, endCol: 1, sheetName: "Sheet1" }
 *   -> "Sheet1!$B$1:$B$4"
 */
function formatAbsoluteRef(range: ResolvedRange): string {
  const startCol = `$${columnToLetter(range.startCol)}`;
  const startRow = `$${range.startRow + 1}`;
  const prefix = range.sheetName ? `${formatSheetName(range.sheetName)}!` : "";

  if (range.startRow === range.endRow && range.startCol === range.endCol) {
    return `${prefix}${startCol}${startRow}`;
  }

  const endCol = `$${columnToLetter(range.endCol)}`;
  const endRow = `$${range.endRow + 1}`;
  return `${prefix}${startCol}${startRow}:${endCol}${endRow}`;
}

/**
 * Format a sheet name for use in a reference, quoting if necessary.
 */
function formatSheetName(name: string): string {
  const needsQuoting = /[\s'![\]]/.test(name) || /^\d/.test(name);
  if (needsQuoting) {
    return `'${name.replace(/'/g, "''")}'`;
  }
  return name;
}

/**
 * Escape a series name for use inside a quoted SERIES formula argument.
 */
function escapeSeriesName(name: string): string {
  return name.replace(/"/g, '""');
}

/**
 * Parse an A1-style reference string into a ResolvedRange.
 * Handles: "A1", "A1:D10", "Sheet1!A1:D10", "'My Sheet'!A1:D10"
 */
function parseA1ToRange(ref: string): ResolvedRange | undefined {
  let remaining = ref;
  let sheetName: string | undefined;

  const bangIndex = remaining.lastIndexOf("!");
  if (bangIndex !== -1) {
    sheetName = remaining.substring(0, bangIndex);
    remaining = remaining.substring(bangIndex + 1);
    if (sheetName.startsWith("'") && sheetName.endsWith("'")) {
      sheetName = sheetName.substring(1, sheetName.length - 1).replace(/''/g, "'");
    }
  }

  remaining = remaining.replace(/\$/g, "").trim().toUpperCase();

  const rangeMatch = remaining.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  if (!rangeMatch) return undefined;

  const startCol = letterToColIndex(rangeMatch[1]);
  const startRow = parseInt(rangeMatch[2], 10) - 1;
  const endCol = rangeMatch[3] ? letterToColIndex(rangeMatch[3]) : startCol;
  const endRow = rangeMatch[4] ? parseInt(rangeMatch[4], 10) - 1 : startRow;

  if (startRow < 0 || startCol < 0) return undefined;

  return {
    startRow: Math.min(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    endCol: Math.max(startCol, endCol),
    sheetName,
  };
}

/** Convert column letters (e.g., "A", "BC") to 0-based index. */
function letterToColIndex(letters: string): number {
  let result = 0;
  for (let i = 0; i < letters.length; i++) {
    result = result * 26 + (letters.charCodeAt(i) - 64);
  }
  return result - 1;
}
