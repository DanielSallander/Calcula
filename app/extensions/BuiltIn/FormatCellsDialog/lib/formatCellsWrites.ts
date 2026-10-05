//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/lib/formatCellsWrites.ts
// PURPOSE: Decide what Format Cells' OK writes: a pure plan of backend calls,
//          from what the dialog LOADED (the baseline) and what it shows now.
// CONTEXT: Survey D5. OK used to send every property of the active cell to
//          every selected cell (`applyFormatting` with all ~30 fields), so:
//            - a selection with mixed fonts, colours or formats came back
//              UNIFORM after an OK that changed only, say, Bold;
//            - an EMPTY active cell wrote the dialog's own defaults --
//              `fontFamily: "system-ui"` -- over the whole range (BUG-0062's
//              symptom by another door);
//            - a theme colour was flattened to the hex it resolved to;
//            - the Border tab's Outline set all four sides of EVERY cell, which
//              on a range is All Borders.
//          Excel writes only what the user changed, and on a range its Border
//          tab's Top / Bottom / Left / Right are the range's OUTER edges, with
//          two more buttons for the lines inside it. That is the model here.
//
//          The plan is executed by FormatCellsDialog.tsx inside ONE undo
//          transaction, so however many calls it takes, OK is one undo step.

import type { FillParam } from "@api";
import type { FormattingOptions } from "@api/types";
import type { BorderSide, FormatCellsSnapshot } from "../hooks/useFormatCellsState";

/** The selection, normalised (start <= end). */
export interface FormatCellsRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** `applyFormatting(rows, cols, formatting)`. */
export interface FormatCall {
  kind: "format";
  rows: number[];
  cols: number[];
  formatting: FormattingOptions;
}

/** `applyBorderPreset(rect, preset, style, color, width)` over the selection. */
export interface PresetCall {
  kind: "preset";
  preset: "none" | "outside" | "insideHorizontal" | "insideVertical";
  style: "solid" | "dashed" | "dotted" | "double";
  color: string;
  width: number;
}

export type FormatCellsWriteCall = FormatCall | PresetCall;

export interface FormatCellsPlan {
  /** In order. Empty when nothing changed. */
  calls: FormatCellsWriteCall[];
  /** `setCellProtection` arguments, or null when protection did not change. */
  protection: { locked: boolean; formulaHidden: boolean } | null;
}

/** The plain properties OK may write, each compared on its own. */
const PLAIN_KEYS = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "fontSize",
  "fontFamily",
  "textColor",
  "textAlign",
  "verticalAlign",
  "numberFormat",
  "wrapText",
  "shrinkToFit",
  "textRotation",
  "indent",
] as const;

/** The Fill tab's properties: touching any of them writes the fill. */
const FILL_KEYS = [
  "fillMode",
  "backgroundColor",
  "gradientColor1",
  "gradientColor2",
  "gradientDirection",
  "patternType",
  "patternFgColor",
  "patternBgColor",
] as const;

const NO_BORDER: BorderSide = { style: "none", color: "#000000" };

/** The fill a snapshot describes, as `applyFormatting` takes it. */
export function buildFillParam(s: FormatCellsSnapshot): FillParam | undefined {
  switch (s.fillMode) {
    case "solid":
      return { type: "solid", color: s.backgroundColor };
    case "gradient":
      return { type: "gradient", color1: s.gradientColor1, color2: s.gradientColor2, direction: s.gradientDirection };
    case "pattern":
      return { type: "pattern", patternType: s.patternType, fgColor: s.patternFgColor, bgColor: s.patternBgColor };
    case "none":
      return { type: "none" };
    default:
      return undefined;
  }
}

function sameSide(a: BorderSide, b: BorderSide): boolean {
  // Two "none" sides are the same line whatever colour they remember.
  if (a.style === "none" && b.style === "none") return true;
  return a.style === b.style && a.color.toLowerCase() === b.color.toLowerCase();
}

/** A border side as `applyBorderPreset` spells a line: style word + weight. */
function presetLine(side: BorderSide): Pick<PresetCall, "style" | "color" | "width"> {
  switch (side.style) {
    case "medium":
      return { style: "solid", color: side.color, width: 2 };
    case "thick":
      return { style: "solid", color: side.color, width: 3 };
    case "dashed":
    case "dotted":
    case "double":
      return { style: side.style, color: side.color, width: 1 };
    case "none":
      return { style: "solid", color: side.color, width: 0 };
    default:
      return { style: "solid", color: side.color, width: 1 };
  }
}

function span(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/**
 * The plan for one OK.
 *
 * `clearAll` is the Border tab's None preset: every border of the range is
 * cleared FIRST (one preset call), and the comparison for borders then starts
 * from "no borders", so a line the user drew after None is written and a
 * "none" the dialog shows is not written twice.
 *
 * Order: the clear, then one whole-range call for the plain properties, the
 * fill and the diagonals, then the outer edges (one `outside` preset when all
 * four became the same line -- Excel's Outline -- otherwise one call per edge),
 * then the inside lines.
 *
 * `touched` (review finding (k), 2026-10-04): the properties the USER set. A
 * touched property is written even when it equals the baseline -- the
 * baseline is the ACTIVE cell's style and the dialog has no "mixed" state, so
 * on A1:A2 with A1 bold and A2 plain the dialog shows Bold, and re-choosing it
 * is how the user makes both bold; that OK wrote nothing. After None (clear
 * all) a border is compared with "no borders", which is then exactly what the
 * range holds, so a touched side is written only when it differs from that.
 */
export function planFormatCellsWrites(
  baseline: FormatCellsSnapshot,
  current: FormatCellsSnapshot,
  rect: FormatCellsRect,
  clearAll: boolean,
  touched: ReadonlySet<keyof FormatCellsSnapshot> = new Set(),
): FormatCellsPlan {
  const calls: FormatCellsWriteCall[] = [];
  const rows = span(rect.startRow, rect.endRow);
  const cols = span(rect.startCol, rect.endCol);
  /** A border side the user chose, measured against a LOADED (not cleared) base. */
  const forcedSide = (key: keyof FormatCellsSnapshot): boolean => !clearAll && touched.has(key);

  if (clearAll) {
    calls.push({ kind: "preset", preset: "none", ...presetLine(NO_BORDER) });
  }
  // After a clear, every border starts from nothing.
  const borderBase: FormatCellsSnapshot = clearAll
    ? {
        ...baseline,
        borderTop: NO_BORDER,
        borderRight: NO_BORDER,
        borderBottom: NO_BORDER,
        borderLeft: NO_BORDER,
        borderInsideHorizontal: NO_BORDER,
        borderInsideVertical: NO_BORDER,
        borderDiagonalDown: NO_BORDER,
        borderDiagonalUp: NO_BORDER,
      }
    : baseline;

  // ---- The whole range: plain properties, fill, diagonals -----------------
  const formatting: Record<string, unknown> = {};
  for (const key of PLAIN_KEYS) {
    if (current[key] !== baseline[key] || touched.has(key)) formatting[key] = current[key];
  }
  const fill = buildFillParam(current);
  const fillTouched = FILL_KEYS.some((key) => touched.has(key));
  if (JSON.stringify(fill) !== JSON.stringify(buildFillParam(baseline)) || (fillTouched && fill !== undefined)) {
    // `fill` alone: the backend applies it after `backgroundColor`, so sending
    // the old background colour as well could only ever be overwritten.
    formatting.fill = fill;
  }
  if (!sameSide(current.borderDiagonalDown, borderBase.borderDiagonalDown) || forcedSide("borderDiagonalDown")) {
    formatting.borderDiagonalDown = { ...current.borderDiagonalDown };
  }
  if (!sameSide(current.borderDiagonalUp, borderBase.borderDiagonalUp) || forcedSide("borderDiagonalUp")) {
    formatting.borderDiagonalUp = { ...current.borderDiagonalUp };
  }
  if (Object.keys(formatting).length > 0) {
    calls.push({ kind: "format", rows, cols, formatting: formatting as FormattingOptions });
  }

  // ---- The outer edges -------------------------------------------------------
  const edges = [
    { key: "borderTop", rows: [rect.startRow], cols },
    { key: "borderBottom", rows: [rect.endRow], cols },
    { key: "borderLeft", rows, cols: [rect.startCol] },
    { key: "borderRight", rows, cols: [rect.endCol] },
  ] as const;
  const changedEdges = edges.filter((e) => !sameSide(current[e.key], borderBase[e.key]) || forcedSide(e.key));
  const outline = current.borderTop;
  const isOutline =
    changedEdges.length === 4 &&
    outline.style !== "none" &&
    edges.every((e) => sameSide(current[e.key], outline));
  if (isOutline) {
    calls.push({ kind: "preset", preset: "outside", ...presetLine(outline) });
  } else {
    for (const e of changedEdges) {
      calls.push({ kind: "format", rows: [...e.rows], cols: [...e.cols], formatting: { [e.key]: { ...current[e.key] } } });
    }
  }

  // ---- The inside lines (a range only) -----------------------------------------
  const multiRow = rect.endRow > rect.startRow;
  const multiCol = rect.endCol > rect.startCol;
  if (
    multiRow &&
    (!sameSide(current.borderInsideHorizontal, borderBase.borderInsideHorizontal) || forcedSide("borderInsideHorizontal"))
  ) {
    const line = current.borderInsideHorizontal;
    if (line.style !== "none") {
      calls.push({ kind: "preset", preset: "insideHorizontal", ...presetLine(line) });
    } else {
      // Off: both cells' sides of every inner row boundary, so no half of the
      // shared line survives on either side.
      calls.push({ kind: "format", rows: span(rect.startRow, rect.endRow - 1), cols, formatting: { borderBottom: { ...line } } });
      calls.push({ kind: "format", rows: span(rect.startRow + 1, rect.endRow), cols, formatting: { borderTop: { ...line } } });
    }
  }
  if (
    multiCol &&
    (!sameSide(current.borderInsideVertical, borderBase.borderInsideVertical) || forcedSide("borderInsideVertical"))
  ) {
    const line = current.borderInsideVertical;
    if (line.style !== "none") {
      calls.push({ kind: "preset", preset: "insideVertical", ...presetLine(line) });
    } else {
      calls.push({ kind: "format", rows, cols: span(rect.startCol, rect.endCol - 1), formatting: { borderRight: { ...line } } });
      calls.push({ kind: "format", rows, cols: span(rect.startCol + 1, rect.endCol), formatting: { borderLeft: { ...line } } });
    }
  }

  const protection =
    current.locked !== baseline.locked ||
    current.formulaHidden !== baseline.formulaHidden ||
    touched.has("locked") ||
    touched.has("formulaHidden")
      ? { locked: current.locked, formulaHidden: current.formulaHidden }
      : null;

  return { calls, protection };
}
