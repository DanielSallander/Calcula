//! FILENAME: app/extensions/Slicer/lib/insertSlicerPlan.ts
// PURPOSE: The pure half of the Insert Slicers dialog: WHICH data sources it
//          offers (and how each is labelled), and WHERE the slicers it creates
//          go.
// CONTEXT: The dialog used to offer only the tables on the ACTIVE sheet, and to
//          stamp every pivot with the active sheet's index. On a canvas sheet —
//          a report page that holds no cells, so no table can live on it — that
//          listed zero tables, and every pivot claimed to live on the canvas.
//          A slicer's data source is addressed by ID (`cacheSourceId`), not by
//          sheet, so there was never a reason to hide another sheet's table:
//          the slicer goes on the active sheet, the table stays where it is.
//
//          Placement: a caller that has already decided WHERE (the canvas
//          sheet's Insert, from a snapped rectangle) passes
//          `dialogData.placement = { x, y, width?, height? }` in sheet pixels.
//          The slicers cascade side by side from that origin exactly as they
//          cascade from the old fixed (100, 100) origin without one.

import type { SlicerSourceType } from "./slicerTypes";

// ============================================================================
// Data sources
// ============================================================================

export interface BiModelTable {
  name: string;
  columns: Array<{ name: string; dataType: string; isNumeric: boolean }>;
}

export interface BiModelInfo {
  tables: BiModelTable[];
  measures: Array<{ name: string }>;
  lookupColumns?: string[];
}

/** One entry of the dialog's "Data source" list. */
export interface SlicerDataSource {
  type: SlicerSourceType;
  id: string;
  name: string;
  /** The sheet the SOURCE lives on — never where the slicer goes (always the
   *  active sheet). Null when the listing does not say, which is honest; the
   *  active sheet's index would be a guess dressed up as a fact. */
  sheetIndex: number | null;
  /** That sheet's name, for the label; null when unknown. */
  sheetName: string | null;
  fields: string[];
  /** BI model info for BI-backed pivots (fields organised by table). */
  biModel?: BiModelInfo;
}

/** The slice of a sheet listing this module reads (`getSheets().sheets`). */
export interface SheetNameEntry {
  index: number;
  name: string;
}

/** The slice of a table this module reads (`getAllTables()`). */
export interface TableListing {
  id: string;
  name: string;
  sheetIndex: number;
  columns: Array<{ name: string }>;
}

/** The slice of a pivot listing this module reads (`getAllPivotTables()`).
 *  `sheetIndex` is optional because the backend's listing does not carry one
 *  today; when a build adds it, labels pick it up with no change here. */
export interface PivotListing {
  id: string;
  name: string;
  sheetIndex?: unknown;
}

function sheetNameOf(sheets: readonly SheetNameEntry[], index: number | null): string | null {
  if (index === null) return null;
  return sheets.find((s) => s.index === index)?.name ?? null;
}

/**
 * Every table in the workbook, from EVERY sheet, each carrying its REAL sheet.
 * Order: the active sheet's tables first (the ones the dialog always offered,
 * in the order it offered them), then every other sheet's, sheet by sheet.
 */
export function tableSources(
  tables: readonly TableListing[],
  sheets: readonly SheetNameEntry[],
  activeSheetIndex: number,
): SlicerDataSource[] {
  const rank = (sheetIndex: number) => (sheetIndex === activeSheetIndex ? -1 : sheetIndex);
  return tables
    .map((table, i) => ({ table, i }))
    .sort((a, b) => rank(a.table.sheetIndex) - rank(b.table.sheetIndex) || a.i - b.i)
    .map(({ table }) => ({
      type: "table" as const,
      id: table.id,
      name: table.name,
      sheetIndex: table.sheetIndex,
      sheetName: sheetNameOf(sheets, table.sheetIndex),
      fields: table.columns.map((c) => c.name),
    }));
}

/** A pivot as a data source. Its sheet is the listing's, or null — never the
 *  active sheet's by assumption. */
export function pivotSource(
  pivot: PivotListing,
  fields: string[],
  sheets: readonly SheetNameEntry[],
  biModel?: BiModelInfo,
): SlicerDataSource {
  const sheetIndex =
    typeof pivot.sheetIndex === "number" && Number.isInteger(pivot.sheetIndex)
      ? pivot.sheetIndex
      : null;
  return {
    type: "pivot",
    id: pivot.id,
    name: pivot.name,
    sheetIndex,
    sheetName: sheetNameOf(sheets, sheetIndex),
    fields,
    ...(biModel ? { biModel } : {}),
  };
}

/** The dropdown label: name, kind, and the source's sheet when known. */
export function sourceLabel(source: SlicerDataSource): string {
  const kind =
    source.type === "table" ? "Table" : source.biModel ? "Data Model" : "PivotTable";
  return source.sheetName ? `${source.name} (${kind}, ${source.sheetName})` : `${source.name} (${kind})`;
}

// ============================================================================
// Placement
// ============================================================================

/** Where the caller wants the slicers, in sheet pixels on the ACTIVE sheet. */
export interface SlicerPlacement {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** The rectangle one created slicer gets. */
export interface SlicerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_SLICER_ORIGIN = { x: 100, y: 100 } as const;
export const DEFAULT_SLICER_WIDTH = 180;
export const DEFAULT_SLICER_HEIGHT = 240;
/** Horizontal gap between slicers created together. */
export const SLICER_CASCADE_GAP = 10;

function isNonNegativeFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function positiveOrUndefined(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Read `dialogData.placement`. Null when absent. A placement that is present
 * but unusable (no finite, non-negative x/y) is ignored with a warning: the
 * slicers then land at the default origin — visible, where a user can move
 * them — rather than at NaN, where nobody can.
 */
export function readSlicerPlacement(
  data: Record<string, unknown> | undefined,
): SlicerPlacement | null {
  const raw = data?.placement;
  if (raw === undefined || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (typeof raw !== "object" || !isNonNegativeFinite(p.x) || !isNonNegativeFinite(p.y)) {
    console.warn("[InsertSlicerDialog] Ignoring an unusable placement:", raw);
    return null;
  }
  return {
    x: p.x,
    y: p.y,
    width: positiveOrUndefined(p.width),
    height: positiveOrUndefined(p.height),
  };
}

/**
 * One rectangle per slicer to create, side by side from the origin — the
 * placement's when given, (100, 100) otherwise — each `width` wide with a
 * 10 px gap. Without a placement this is exactly the historical layout.
 */
export function slicerRects(count: number, placement: SlicerPlacement | null): SlicerRect[] {
  const width = placement?.width ?? DEFAULT_SLICER_WIDTH;
  const height = placement?.height ?? DEFAULT_SLICER_HEIGHT;
  const originX = placement?.x ?? DEFAULT_SLICER_ORIGIN.x;
  const originY = placement?.y ?? DEFAULT_SLICER_ORIGIN.y;
  const rects: SlicerRect[] = [];
  for (let i = 0; i < count; i++) {
    rects.push({ x: originX + i * (width + SLICER_CASCADE_GAP), y: originY, width, height });
  }
  return rects;
}
