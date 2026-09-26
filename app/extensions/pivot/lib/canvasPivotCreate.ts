//! FILENAME: app/extensions/Pivot/lib/canvasPivotCreate.ts
// PURPOSE: The CANVAS half of the Create PivotTable dialog: read the placement
//          a canvas insert hands the dialog, choose a frame when none was
//          handed, resolve the typed source to a WORKSHEET (never a canvas),
//          and find a sensible default source.
// CONTEXT: A pivot on a canvas sheet is a REAL pivot written into the canvas's
//          hidden grid; the frame is the designer-sized box its view is shown
//          in (logical page px), and the backend allocates the hidden-grid
//          anchor itself. The create doors' rules
//          (app/src-tauri/src/pivot/commands.rs): on a canvas `canvasFrame` is
//          REQUIRED and `destinationCell` is ignored, and the range/table door
//          REQUIRES an explicit `sourceSheet` that is not a canvas -- the
//          default, "the active sheet", would be the canvas itself, which has no
//          data. This module says the same things FIRST, in the reader's terms,
//          so a canvas source is a sentence in the dialog, never a thrown error.
//
//          Worksheet mode never calls into this module.

import { indexToCol } from "@api";
import type { CanvasPivotPlacement } from "../../_shared/lib/canvasPivotFrame";

// ============================================================================
// Placement and frame
// ============================================================================
//
// The frame RULE (default size, centring, snap, page clamp) is shared with the
// Business Intelligence extension's "PivotTable from Model" flows, so it lives
// in _shared/lib/canvasPivotFrame.ts; this module re-exports it for the dialog.

export {
  CANVAS_PIVOT_DEFAULT_SIZE,
  canvasFrameOf,
  defaultCanvasPivotPlacement,
  type CanvasPivotPlacement,
  type CanvasPivotView,
} from "../../_shared/lib/canvasPivotFrame";

/**
 * Read the `placement` an opener handed the dialog (the Canvas tab's Insert
 * group hands `{ sheetIndex, x, y, width, height }`). Accepted only when every
 * field is a finite number, the sheet index is a whole non-negative number and
 * the box has an area -- a partial rectangle is ignored, never half-applied.
 */
export function readCanvasPivotPlacement(raw: unknown): CanvasPivotPlacement | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  for (const field of ["sheetIndex", "x", "y", "width", "height"] as const) {
    const v = p[field];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  const sheetIndex = p.sheetIndex as number;
  if (!Number.isInteger(sheetIndex) || sheetIndex < 0) return null;
  if ((p.width as number) <= 0 || (p.height as number) <= 0) return null;
  return {
    sheetIndex,
    x: p.x as number,
    y: p.y as number,
    width: p.width as number,
    height: p.height as number,
  };
}


// ============================================================================
// Source
// ============================================================================

/** The sheet facts the source rules need (a `getSheets()` row). */
export interface CanvasSourceSheet {
  index: number;
  name: string;
  /** "canvas" for a canvas sheet; absent or "worksheet" for a worksheet. */
  kind?: string;
  visibility?: string;
}

/** The table facts the source rules need (a `getTableByName()` result). */
export interface CanvasSourceTable {
  name: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** The outcome of resolving the typed source: what to send, or the sentence to show. */
export type CanvasPivotSource =
  | { ok: true; sourceRange: string; sourceSheet: number; sourceTableName?: string }
  | { ok: false; message: string };

export const CANVAS_SOURCE_EMPTY_MESSAGE = "Please enter a source data range.";
export const CANVAS_SOURCE_NEEDS_SHEET_MESSAGE =
  "A canvas sheet has no cells. Include the sheet the data is on, for example Sheet1!A1:D100, or type a table name.";
export const CANVAS_SOURCE_RANGE_FORMAT_MESSAGE = "Invalid range format. Use a range like Sheet1!A1:D100.";
/** The hint under the source field on a canvas. */
export const CANVAS_SOURCE_HINT =
  "A canvas has no cells: include the sheet the data is on (e.g., Sheet1!A1:D100), or type a table name.";
/** Shown instead of the hint when no worksheet has any data to default to. */
export const CANVAS_SOURCE_NO_DATA_NOTE =
  "No worksheet has data yet. Type the range with its sheet (e.g., Sheet1!A1:D100) or a table name.";

/** The sentence for a typed sheet that is a canvas. */
export function canvasSourceIsCanvasMessage(sheetName: string): string {
  return `"${sheetName}" is a canvas sheet, which has no cells. Choose a range on a worksheet, for example Sheet1!A1:D100.`;
}

/** The sentence for a typed sheet name no sheet answers to. */
export function unknownSourceSheetMessage(sheetName: string): string {
  return `There is no sheet named "${sheetName}".`;
}

/** The sentence for an unprefixed name that is not a table. */
export function unknownSourceTableMessage(name: string): string {
  return `There is no table named "${name}". Type a table name, or a range with its sheet, for example Sheet1!A1:D100.`;
}

// The two range forms the create door parses (`parse_range`, pivot/utils.rs):
// two cell corners, or two whole columns. `$` is not understood there, so it
// is stripped before the range is sent.
const CELL_RANGE = /^[A-Z]{1,3}\d+:[A-Z]{1,3}\d+$/;
const COLUMN_RANGE = /^[A-Z]{1,3}:[A-Z]{1,3}$/;

function normalizeRange(text: string): string | null {
  const range = text.replace(/\$/g, "").trim().toUpperCase();
  return CELL_RANGE.test(range) || COLUMN_RANGE.test(range) ? range : null;
}

/** "Sheet1!A1:D10", quoting (and '' escaping) a sheet name that needs it. */
export function qualifySourceRange(sheetName: string, range: string): string {
  if (/[^a-zA-Z0-9_]/.test(sheetName)) {
    return `'${sheetName.replace(/'/g, "''")}'!${range}`;
  }
  return `${sheetName}!${range}`;
}

/**
 * Split "Sheet1!A1:D10" / "'My Sheet'!A1:D10" into the sheet name (unquoted,
 * '' unescaped) and the rest; `sheetName` is null when there is no prefix.
 */
export function splitSheetPrefix(text: string): { sheetName: string | null; rest: string } {
  const trimmed = text.trim();
  const bang = trimmed.lastIndexOf("!");
  if (bang === -1) return { sheetName: null, rest: trimmed };
  let name = trimmed.substring(0, bang).trim();
  if (name.length >= 2 && name.startsWith("'") && name.endsWith("'")) {
    name = name.substring(1, name.length - 1).replace(/''/g, "'");
  }
  return { sheetName: name, rest: trimmed.substring(bang + 1).trim() };
}

function isCanvas(sheet: CanvasSourceSheet): boolean {
  return sheet.kind === "canvas";
}

function cornersToA1(c: { startRow: number; startCol: number; endRow: number; endCol: number }): string {
  return `${indexToCol(c.startCol)}${c.startRow + 1}:${indexToCol(c.endCol)}${c.endRow + 1}`;
}

/**
 * Resolve the canvas dialog's source text to what the create door needs.
 *   - "Sheet!A1:D10": that sheet (case-insensitive, as the backend resolves
 *     names) -- refused when no sheet has that name or it is a CANVAS.
 *   - "Table1": that table, on its own sheet, linked by name so the pivot
 *     follows the table as it grows.
 *   - A bare range: refused -- on a canvas there is no "current sheet" whose
 *     cells it could mean.
 * `findTable` is `getTableByName` (workbook-wide); a lookup that throws is
 * treated as "no such table".
 */
export async function resolveCanvasPivotSource(
  text: string,
  sheets: readonly CanvasSourceSheet[],
  findTable: (name: string) => Promise<CanvasSourceTable | null>,
): Promise<CanvasPivotSource> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: CANVAS_SOURCE_EMPTY_MESSAGE };

  const { sheetName, rest } = splitSheetPrefix(trimmed);
  if (sheetName !== null) {
    if (sheetName === "") return { ok: false, message: CANVAS_SOURCE_NEEDS_SHEET_MESSAGE };
    const wanted = sheetName.toLowerCase();
    const sheet = sheets.find((s) => s.name.toLowerCase() === wanted);
    if (!sheet) return { ok: false, message: unknownSourceSheetMessage(sheetName) };
    if (isCanvas(sheet)) return { ok: false, message: canvasSourceIsCanvasMessage(sheet.name) };
    const range = normalizeRange(rest);
    if (!range) return { ok: false, message: CANVAS_SOURCE_RANGE_FORMAT_MESSAGE };
    return { ok: true, sourceRange: qualifySourceRange(sheet.name, range), sourceSheet: sheet.index };
  }

  // No sheet prefix: a range has no sheet to be on, so it must be a table.
  if (normalizeRange(trimmed)) return { ok: false, message: CANVAS_SOURCE_NEEDS_SHEET_MESSAGE };
  let found: CanvasSourceTable | null = null;
  try {
    found = await findTable(trimmed);
  } catch {
    found = null;
  }
  if (!found) return { ok: false, message: unknownSourceTableMessage(trimmed) };
  const table = found;
  const sheet = sheets.find((s) => s.index === table.sheetIndex);
  if (!sheet) return { ok: false, message: unknownSourceTableMessage(trimmed) };
  if (isCanvas(sheet)) return { ok: false, message: canvasSourceIsCanvasMessage(sheet.name) };
  return {
    ok: true,
    sourceRange: qualifySourceRange(sheet.name, cornersToA1(table)),
    sourceSheet: sheet.index,
    sourceTableName: table.name,
  };
}

/** A used-range / current-region answer (the `getUsedRange` / `getCurrentRegion` shape). */
export interface CanvasSourceRegion {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  empty: boolean;
}

/** The reads `findDefaultCanvasSource` makes, injected so tests need no backend. */
export interface DefaultCanvasSourceReads {
  getUsedRange(sheetIndex: number): Promise<CanvasSourceRegion>;
  getCurrentRegion(row: number, col: number, sheetIndex: number): Promise<CanvasSourceRegion>;
}

/**
 * The source a canvas dialog starts with: on the FIRST visible worksheet that
 * holds any data, the block of data around its first used cell (Excel's
 * current region), or its whole used range when that cell stands alone.
 * Null when no worksheet has data -- the dialog then says so instead of
 * guessing. A read that fails skips that sheet.
 */
export async function findDefaultCanvasSource(
  sheets: readonly CanvasSourceSheet[],
  reads: DefaultCanvasSourceReads,
): Promise<string | null> {
  const ordered = [...sheets].sort((a, b) => a.index - b.index);
  for (const sheet of ordered) {
    if (isCanvas(sheet)) continue;
    if (sheet.visibility !== undefined && sheet.visibility !== "visible") continue;
    let used: CanvasSourceRegion;
    try {
      used = await reads.getUsedRange(sheet.index);
    } catch {
      continue;
    }
    if (!used || used.empty) continue;
    let region: CanvasSourceRegion = used;
    try {
      const around = await reads.getCurrentRegion(used.startRow, used.startCol, sheet.index);
      if (around && !around.empty) region = around;
    } catch {
      // Keep the used range.
    }
    return qualifySourceRange(sheet.name, cornersToA1(region));
  }
  return null;
}
