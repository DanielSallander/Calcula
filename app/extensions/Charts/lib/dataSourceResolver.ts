//! FILENAME: app/extensions/Charts/lib/dataSourceResolver.ts
// PURPOSE: Resolve a DataSource (string or DataRangeRef) into a concrete DataRangeRef.
// CONTEXT: Allows ChartSpec.data to be an A1 reference string ("Sheet1!A1:D10"),
//          a named range name ("SalesData"), or an explicit DataRangeRef object.
//          This resolver normalizes all forms into DataRangeRef for data reading.
//
//          WHICH SHEET A RANGE LIVES ON (canvas sheets, M4). A chart placed on
//          a canvas has no cells under it, so its data always lives on ANOTHER
//          sheet -- and the resolved `sheetIndex` is what every read now goes
//          to (chartDataReader reads through `getRangeCellsTyped(..., sheetIndex)`,
//          never the active sheet). A DataRangeRef carries the sheet two ways:
//
//            - `sheetId`, the workbook's stable sheet uuid. WINS when present:
//              mapped to the live index through ONE `getSheets()` call, cached
//              and dropped on every sheet-collection event. An id that no
//              longer names a sheet is an ERROR ("the chart's source sheet no
//              longer exists") -- never a fall back to the index or to a name,
//              either of which would chart some other sheet's cells in silence.
//            - `sheetIndex`, read only when there is no id (a ref written by a
//              script or an MCP client, or authored before ids existed; the
//              store stamps the id at create and at load).
//
//          A sheet-qualified A1 string keeps resolving BY NAME, as before; an
//          unqualified one means the ACTIVE sheet, which is what the reader
//          used to read for every chart before it learned to read by sheet.

import {
  getNamedRange,
  getSheets,
} from "@api";
import { getRangeCellsTyped } from "@api/lib";
import { getGridStateSnapshot } from "@api/grid";
import type { ChartSpec, DataSource, DataRangeRef } from "../types";
import { isDataRangeRef, isPivotDataSource, isDesignQueryDataSource } from "../types";
import { loadSheetIdMap, peekSheetIndexForId } from "./sheetIdMap";
import { splitSheetQualifiedRange } from "./chartRangeBinding";

// ============================================================================
// Sheet identity: the stable sheet id -> the live sheet index
// ============================================================================

/** The message a ref with a dead sheet id resolves to. Exported for the tests and the UI. */
export const SOURCE_SHEET_MISSING_MESSAGE =
  "The chart's source sheet no longer exists. Choose a new data range for this chart (Select Data).";

/** Thrown when a DataRangeRef's `sheetId` no longer names a sheet in the workbook. */
export class SourceSheetMissingError extends Error {
  readonly sheetId: string;
  constructor(sheetId: string) {
    super(SOURCE_SHEET_MISSING_MESSAGE);
    this.name = "SourceSheetMissingError";
    this.sheetId = sheetId;
  }
}

/**
 * Put the LIVE sheet index on a DataRangeRef: its `sheetId` mapped through the
 * current sheet list (sheetIdMap.ts -- one cached `getSheets()`) when it has
 * one, its own `sheetIndex` when it does not. The returned ref keeps its id.
 * Throws {@link SourceSheetMissingError} for an id that no longer names a
 * sheet -- never a fall back to the index, never to a name.
 */
export async function resolveRangeRefSheet(ref: DataRangeRef): Promise<DataRangeRef> {
  const id = ref.sheetId;
  if (typeof id !== "string" || id === "") return ref;
  const map = await loadSheetIdMap();
  const live = map.byId.get(id);
  if (live === undefined) throw new SourceSheetMissingError(id);
  return live === ref.sheetIndex ? ref : { ...ref, sheetIndex: live };
}

/**
 * The sheet a coordinate data source reads, answered SYNCHRONOUSLY from the
 * cache (the cell-change listener cannot await). Null means "not known right
 * now" -- not a DataRangeRef, an id the cache does not hold yet (it is warmed
 * in the background), or an id whose sheet is gone -- and a caller deciding
 * whether to invalidate must treat null as "yes".
 */
export function peekRangeRefSheetIndex(source: DataSource): number | null {
  if (!isDataRangeRef(source)) return null;
  const id = source.sheetId;
  if (typeof id !== "string" || id === "") return source.sheetIndex;
  const live = peekSheetIndexForId(id);
  return typeof live === "number" ? live : null;
}

/** The active sheet's index as Core knows it, 0 before the grid has mounted. */
function activeSheetIndexFallback(): number {
  return getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve a DataSource to a concrete DataRangeRef.
 *
 * Accepts:
 * - A `DataRangeRef` object -- its sheet resolved id-first (see
 *   {@link resolveRangeRefSheet}).
 * - An A1 reference string like `"Sheet1!A1:D10"` -- parsed to coordinates; the
 *   sheet by NAME, or the active sheet when unqualified.
 * - A named range name like `"SalesData"` -- resolved via the backend.
 *
 * @throws Error if the reference cannot be resolved (including a DataRangeRef
 *   whose source sheet was deleted).
 */
export async function resolveDataSource(
  source: DataSource,
  fallbackSheetIndex?: number,
): Promise<DataRangeRef> {
  if (isDataRangeRef(source)) {
    return resolveRangeRefSheet(source);
  }

  // Aggregated sources (pivot view / design query) are handled by their own
  // readers, not by range resolution.
  if (isPivotDataSource(source) || isDesignQueryDataSource(source)) {
    throw new Error("Aggregated data sources (pivot / design query) are handled by their readers, not resolveDataSource.");
  }

  const ref = source.trim();
  if (!ref) {
    throw new Error("Empty data source reference.");
  }

  // Try parsing as A1 reference first
  const parsed = parseA1Reference(ref);
  if (parsed) {
    // Resolve sheet name to index if present. Unqualified means the ACTIVE
    // sheet -- the sheet every chart read before reads learned their sheet.
    const sheetIndex = parsed.sheetName
      ? await resolveSheetIndex(parsed.sheetName)
      : (fallbackSheetIndex ?? activeSheetIndexFallback());

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
        : (namedRange.sheetIndex ?? fallbackSheetIndex ?? activeSheetIndexFallback());

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
  // The sheet prefix through the range binding's own splitter: the name is
  // unquoted AND its doubled quotes unescaped. This parser used to strip the
  // quotes only, so a chart over a sheet named Rock'!Roll asked for a sheet
  // called Rock''!Roll and never plotted, not even for its publisher (found
  // live 2026-09-29, e2e fixall-calp R5).
  const split = splitSheetQualifiedRange(ref);
  const sheetName = split.sheetName ?? undefined;
  let remaining = split.range;

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
 *
 * Reads the sheet the reference NAMES; an unqualified reference reads
 * `fallbackSheetIndex`, and with no fallback the active sheet (the backend's
 * default for an absent index).
 */
async function resolveCellValue(
  ref: string,
  fallbackSheetIndex: number | undefined,
): Promise<string | null> {
  const cellRef = ref.substring(1).trim();
  const parsed = parseA1Reference(cellRef);
  if (!parsed) return null;

  const sheetIndex = parsed.sheetName
    ? await resolveSheetIndex(parsed.sheetName)
    : fallbackSheetIndex;

  // Sparse: a cell that does not exist is simply absent from the result.
  const cells = await getRangeCellsTyped(
    parsed.startRow,
    parsed.startCol,
    parsed.startRow,
    parsed.startCol,
    sheetIndex,
  );

  if (cells.length > 0) {
    return cells[0].display || null;
  }
  return null;
}

/**
 * The chart a param belongs to, as far as its bound cell is concerned: the
 * sheet it is PLACED on, and its spec (whose data names the sheet it reads).
 */
export interface ParamCellHost {
  sheetIndex: number;
  spec: ChartSpec;
}

/**
 * Where a param's bound cell is: a cell on a sheet; "invalid" when the text
 * is not one unqualified cell (the S7c rule: the read keeps the default, a
 * write-back is skipped); "noSheet" when the chart is on a canvas and its data
 * does not come from a sheet (a pivot, a model query), so there is no sheet
 * for an unqualified cell to be on.
 */
export type ParamCellLocation =
  | { kind: "cell"; sheetIndex: number; row: number; col: number }
  | { kind: "invalid" }
  | { kind: "noSheet" };

/**
 * WHICH SHEET a param's unqualified cell ("=B1") is on -- the sheet the chart
 * reads its cells from:
 *
 *   - a chart on a WORKSHEET: that sheet, its own (the long-standing rule --
 *     it used to be spelled "the active sheet", which is the sheet a chart is
 *     showing on while you click it; naming it keeps a chart on a sheet that
 *     is NOT active reading its own cell);
 *   - a chart on a CANVAS, which has no cells: the sheet its DATA comes from,
 *     the rule an unqualified `=A1` title already follows
 *     ({@link specReferenceSheet}). It used to read the canvas, find nothing,
 *     and keep the literal default forever, and its write-back was refused;
 *   - a canvas chart whose data has no sheet: "noSheet".
 *
 * `host` null (a preview, an export -- no placed chart) keeps the historical
 * rule: the ACTIVE sheet. A sheet list that cannot be read counts the host as
 * a worksheet (the old behaviour, never a guess at another sheet).
 */
export async function locateParamCell(
  cellRef: string,
  host: ParamCellHost | null,
): Promise<ParamCellLocation> {
  const target = parseParamCellTarget(cellRef);
  if (!target) return { kind: "invalid" };
  if (!host) return { kind: "cell", sheetIndex: activeSheetIndexFallback(), ...target };
  let hostIsCanvas = false;
  try {
    const map = await loadSheetIdMap();
    hostIsCanvas = map.sheets.find((sh) => sh.index === host.sheetIndex)?.kind === "canvas";
  } catch {
    hostIsCanvas = false;
  }
  if (!hostIsCanvas) return { kind: "cell", sheetIndex: host.sheetIndex, ...target };
  const dataSheet = await specReferenceSheet(host.spec);
  if (typeof dataSheet !== "number" || dataSheet === host.sheetIndex) return { kind: "noSheet" };
  return { kind: "cell", sheetIndex: dataSheet, ...target };
}

/**
 * Resolve a param's single-cell reference to its display value, on the sheet
 * {@link locateParamCell} names. Unqualified only: a sheet-qualified ref
 * (containing "!") or a range returns null so the caller falls back to the
 * literal default, as does a canvas chart with no data sheet. Accepts "=B1" or
 * "B1". The scoped invalidation keys the param cell on the same sheet
 * (lib/chartInvalidation.ts `paramCellSheetIndex`).
 */
export async function resolveParamCell(
  cellRef: string,
  host: ParamCellHost | null = null,
): Promise<string | null> {
  const at = await locateParamCell(cellRef, host);
  if (at.kind !== "cell") return null;
  // Sparse: a cell that does not exist is simply absent from the result.
  const cells = await getRangeCellsTyped(at.row, at.col, at.row, at.col, at.sheetIndex);
  return cells.length > 0 ? cells[0].display || null : null;
}

/**
 * Parse a single unqualified cell target ("=B1" or "B1") to {row, col}
 * (0-based). Returns null for a range, a sheet-qualified ref, or an invalid ref
 * — the caller skips the write (writeback is single-cell only, S7c). WHICH
 * sheet the cell is on is {@link locateParamCell}'s answer.
 */
export function parseParamCellTarget(cellRef: string): { row: number; col: number } | null {
  const body = (cellRef.startsWith("=") ? cellRef.slice(1) : cellRef).trim();
  if (body === "" || body.includes("!")) return null;
  const parsed = parseA1Reference(body);
  if (!parsed || parsed.startRow !== parsed.endRow || parsed.startCol !== parsed.endCol) return null;
  return { row: parsed.startRow, col: parsed.startCol };
}

/**
 * Resolve a string field that may be a cell reference.
 * If it starts with "=" and is a valid cell ref, fetches the cell value.
 * Otherwise returns the original string unchanged.
 */
async function resolveStringField(
  value: string | null,
  fallbackSheetIndex: number | undefined,
): Promise<string | null> {
  if (!value || !isCellReference(value)) return value;
  return resolveCellValue(value, fallbackSheetIndex);
}

/**
 * The sheet an UNQUALIFIED `=A1` in a title / axis title / series name reads:
 * the sheet the chart's data resolves to, so a chart on a canvas titled `=A1`
 * reads A1 of its data sheet rather than of the empty canvas. Undefined (the
 * active sheet) for an aggregated source, or when the data cannot resolve --
 * the data read reports that failure itself.
 */
async function specReferenceSheet(spec: ChartSpec): Promise<number | undefined> {
  if (!isDataRangeRef(spec.data) && typeof spec.data !== "string") return undefined;
  try {
    return (await resolveDataSource(spec.data)).sheetIndex;
  } catch {
    return undefined;
  }
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
  const fields: Array<string | null | undefined> = [
    spec.title,
    spec.xAxis?.title,
    spec.yAxis?.title,
    ...(spec.series ?? []).map((s) => s.name),
  ];
  // Nothing to resolve -> no sheet lookup at all (the common case).
  if (!fields.some((v) => typeof v === "string" && isCellReference(v))) return spec;

  // The sheet an unqualified reference reads (the chart's data sheet).
  const sheetIndex = await specReferenceSheet(spec);

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
