//! FILENAME: app/extensions/Charts/lib/chartRangeBinding.ts
// PURPOSE: Turn the Insert/Edit Chart dialog's range text ("Sheet1!A1:D10")
//          into the DataRangeRef the chart stores -- bound to the sheet the
//          text NAMES -- and back again for display.
// CONTEXT: The dialog used to throw the sheet prefix away: whatever sheet was
//          typed, the range was stored against the ACTIVE sheet's index. That
//          was invisible while every chart lived on its data's sheet, and it is
//          fatal on a CANVAS sheet, which has no cells: a chart placed there
//          must name the worksheet its data is on.
//
//          The rules, in one place so the dialog and its tests agree:
//            - "Sheet!A1:B5" binds to the sheet of that name (case-insensitive,
//              quotes and '' escapes understood), storing BOTH its index and
//              its stable `sheetId` -- the name is only what the user types.
//            - A name that is not a sheet, or that is a CANVAS, is refused with
//              a sentence saying why.
//            - No prefix on a worksheet: the current sheet, exactly as before.
//            - No prefix on a canvas: refused -- a canvas has no cells, so the
//              reader must say which sheet holds the data.
//          Pure: the caller supplies the sheet list (one `getSheets()`).

import type { SheetInfo } from "@api/lib";
import type { DataRangeRef } from "../types";

/** The corners of an A1 range, 0-based and inclusive. */
export interface A1Corners {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** What the dialog knows when it binds the text. */
export interface RangeBindingContext {
  /** The workbook's sheets (empty until the dialog's `getSheets()` returns). */
  sheets: readonly SheetInfo[];
  /** The ACTIVE sheet's index (the chart's placement sheet). */
  currentSheetIndex: number;
  /**
   * The ACTIVE sheet's name, when known. Lets a prefix naming the active sheet
   * bind before the sheet list has arrived (the auto-detected range is always
   * qualified by it); the id follows once the list is in.
   */
  currentSheetName?: string | null;
  /** True when the active sheet is a canvas (no cells). */
  currentIsCanvas: boolean;
}

/**
 * The outcome of binding the text. `message` is the inline sentence to show;
 * null means "nothing to say yet" (an empty field, or a sheet list that has not
 * arrived to resolve the typed name against).
 */
export type RangeBinding =
  | { ok: true; ref: DataRangeRef; sheet: SheetInfo | null }
  | { ok: false; message: string | null };

export const RANGE_FORMAT_MESSAGE = "Invalid range format. Use a range like Sheet1!A1:D10.";
export const CANVAS_NEEDS_SHEET_MESSAGE =
  "A canvas sheet has no cells. Include the sheet the data is on, for example Sheet1!A1:D10.";

/** The sentence for a typed name that is a canvas. */
export function canvasSourceMessage(sheetName: string): string {
  return `"${sheetName}" is a canvas sheet, which has no cells. Choose a range on a worksheet, for example Sheet1!A1:D10.`;
}

/** The sentence for a typed name no sheet answers to. */
export function unknownSheetMessage(sheetName: string): string {
  return `There is no sheet named "${sheetName}".`;
}

/**
 * Split "Sheet1!A1:D10" / "'My Sheet'!A1:D10" / "A1:D10" into the sheet name
 * (unquoted, '' unescaped; null when there is no prefix) and the range part.
 */
export function splitSheetQualifiedRange(text: string): { sheetName: string | null; range: string } {
  const trimmed = text.trim();
  const bang = trimmed.lastIndexOf("!");
  if (bang === -1) return { sheetName: null, range: trimmed };
  let name = trimmed.substring(0, bang).trim();
  if (name.length >= 2 && name.startsWith("'") && name.endsWith("'")) {
    name = name.substring(1, name.length - 1).replace(/''/g, "'");
  }
  return { sheetName: name, range: trimmed.substring(bang + 1).trim() };
}

/** Column letters -> 0-based index. */
function lettersToCol(letters: string): number {
  let col = 0;
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  return col - 1;
}

/** 0-based column index -> letters. */
function colToLetters(index: number): string {
  let col = "";
  let n = index;
  while (n >= 0) {
    col = String.fromCharCode(65 + (n % 26)) + col;
    n = Math.floor(n / 26) - 1;
  }
  return col;
}

/**
 * Parse the RANGE part ("A1:D10", "$A$1:$D$10") -- two corners, as the dialog
 * has always required. Corners are normalized (top-left first). Null when the
 * text is not a two-corner range.
 */
export function parseA1Corners(range: string): A1Corners | null {
  const ref = range.replace(/\$/g, "").trim().toUpperCase();
  const match = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match) return null;
  const r1 = parseInt(match[2], 10);
  const r2 = parseInt(match[4], 10);
  if (!Number.isFinite(r1) || !Number.isFinite(r2) || r1 < 1 || r2 < 1) return null;
  const c1 = lettersToCol(match[1]);
  const c2 = lettersToCol(match[3]);
  return {
    startRow: Math.min(r1, r2) - 1,
    startCol: Math.min(c1, c2),
    endRow: Math.max(r1, r2) - 1,
    endCol: Math.max(c1, c2),
  };
}

/** Find a sheet by name, case-insensitively (the resolver's own rule). */
export function findSheetByName(sheets: readonly SheetInfo[], name: string): SheetInfo | undefined {
  const wanted = name.toLowerCase();
  return sheets.find((s) => s.name.toLowerCase() === wanted);
}

/** Whether a sheet is a canvas (absent kind = a worksheet). */
export function isCanvasSheet(sheet: SheetInfo | undefined | null): boolean {
  return !!sheet && sheet.kind === "canvas";
}

/**
 * Bind the dialog's range text to a DataRangeRef. See the module header for
 * the rules.
 */
export function bindRangeText(text: string, ctx: RangeBindingContext): RangeBinding {
  if (text.trim() === "") return { ok: false, message: null };
  const { sheetName, range } = splitSheetQualifiedRange(text);
  const corners = parseA1Corners(range);
  if (!corners) return { ok: false, message: RANGE_FORMAT_MESSAGE };

  if (sheetName !== null && sheetName !== "") {
    if (ctx.sheets.length === 0) {
      // The sheet list has not arrived yet. A prefix naming the ACTIVE sheet
      // (which the dialog knows without the list) binds to it now, id to
      // follow; any other name has nothing to resolve against -- and nothing
      // wrong to report either, yet.
      const current = ctx.currentSheetName;
      if (!ctx.currentIsCanvas && current && current.toLowerCase() === sheetName.toLowerCase()) {
        return { ok: true, ref: { sheetIndex: ctx.currentSheetIndex, ...corners }, sheet: null };
      }
      return { ok: false, message: null };
    }
    const sheet = findSheetByName(ctx.sheets, sheetName);
    if (!sheet) return { ok: false, message: unknownSheetMessage(sheetName) };
    if (isCanvasSheet(sheet)) return { ok: false, message: canvasSourceMessage(sheet.name) };
    const ref: DataRangeRef = { sheetIndex: sheet.index, ...corners };
    if (typeof sheet.sheetId === "string" && sheet.sheetId !== "") ref.sheetId = sheet.sheetId;
    return { ok: true, ref, sheet };
  }

  // No prefix: the current sheet -- which on a canvas has no cells to chart.
  if (ctx.currentIsCanvas) return { ok: false, message: CANVAS_NEEDS_SHEET_MESSAGE };
  const current = ctx.sheets.find((s) => s.index === ctx.currentSheetIndex) ?? null;
  if (current && isCanvasSheet(current)) return { ok: false, message: CANVAS_NEEDS_SHEET_MESSAGE };
  const ref: DataRangeRef = { sheetIndex: ctx.currentSheetIndex, ...corners };
  if (current && typeof current.sheetId === "string" && current.sheetId !== "") ref.sheetId = current.sheetId;
  return { ok: true, ref, sheet: current };
}

/** "A1:D10" for 0-based corners. */
export function cornersToA1(c: A1Corners): string {
  return `${colToLetters(c.startCol)}${c.startRow + 1}:${colToLetters(c.endCol)}${c.endRow + 1}`;
}

/** "Sheet1!A1:D10", quoting (and '' escaping) a name that needs it. */
export function formatSheetQualifiedRange(sheetName: string, range: string): string {
  if (/[^a-zA-Z0-9_]/.test(sheetName)) {
    return `'${sheetName.replace(/'/g, "''")}'!${range}`;
  }
  return `${sheetName}!${range}`;
}

/**
 * The text the dialog shows for a stored DataRangeRef: the range qualified by
 * the reference's OWN sheet -- found by id first, then by index -- never the
 * sheet the dialog happens to be opened on. A ref whose id names no sheet any
 * more (its sheet was deleted) shows the bare range, so nothing claims a sheet
 * the data is not on. `fallbackSheetName` is used only when the sheet list is
 * not to hand (empty).
 */
export function rangeRefDisplayText(
  ref: DataRangeRef,
  sheets: readonly SheetInfo[],
  fallbackSheetName: string | null,
): string {
  const range = cornersToA1(ref);
  if (sheets.length === 0) {
    return fallbackSheetName ? formatSheetQualifiedRange(fallbackSheetName, range) : range;
  }
  const hasId = typeof ref.sheetId === "string" && ref.sheetId !== "";
  const sheet = hasId
    ? sheets.find((s) => s.sheetId === ref.sheetId)
    : sheets.find((s) => s.index === ref.sheetIndex);
  return sheet ? formatSheetQualifiedRange(sheet.name, range) : range;
}
