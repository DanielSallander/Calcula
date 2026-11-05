//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/lib/borderEdges.ts
// PURPOSE: What the Border tab shows for each OUTER edge of a range: the one
//          line every cell along that edge draws, or MIXED when they differ.
// CONTEXT: BUG-0365. The dialog loaded a range's edges from its corner cells
//          (Top / Left from the top-left cell, Right from the top-right, Bottom
//          from the bottom-left), so A1:B3 with A3 bordered at the bottom and B3
//          not showed Bottom ON -- and clicking it, meaning to change that line,
//          turned it OFF across the whole edge. Excel greys a mixed edge: COM
//          reads `Range("A1:B3").Borders(xlEdgeBottom).LineStyle` back as Null
//          when the bottom cells differ [LIVE, Excel 16, 2026-11-04, lane
//          multiarea probe3], and the dialog's edge button shows that greyed
//          state; clicking it draws the chosen line along the whole edge.
//
//          Each edge is read WHOLE (the styled cells of its strip -- a position
//          the backend skips is the default style) when the strip has at most
//          EDGE_READ_LIMIT positions. A longer strip (a whole column's million
//          rows) is judged by its two ends: equal ends show that line, different
//          ends show MIXED -- never one corner's line for the whole edge.

import type { CellData, StyleData } from "@api";
import type { BorderSide } from "../hooks/useFormatCellsState";

/** The longest edge read cell by cell: one full row of columns. */
export const EDGE_READ_LIMIT = 16384;

/** The rectangle the dialog describes, normalised. */
export interface EdgeRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export type EdgeKey = "borderTop" | "borderBottom" | "borderLeft" | "borderRight";

/** How the loader reads the sheet: the styled cells of a strip, and a style. */
export interface EdgeReader {
  cells(strip: EdgeRect): Promise<CellData[]>;
  style(index: number): Promise<StyleData>;
  /** The style of ONE cell (an empty cell's is the default). */
  styleAt(row: number, col: number): Promise<StyleData>;
}

/** The Border tab's greyed state. Its line fields are never written. */
export const MIXED_SIDE: BorderSide = { style: "none", color: "#000000", mixed: true };

/** A style's side as the dialog holds it. */
export function sideOfStyle(side: StyleData["borderTop"] | undefined): BorderSide {
  return side ? { style: side.style as BorderSide["style"], color: side.color } : { style: "none", color: "#000000" };
}

/** Whether two sides are the same line ("none" in any colour is one line). */
export function sameLine(a: BorderSide, b: BorderSide): boolean {
  if (Boolean(a.mixed) !== Boolean(b.mixed)) return false;
  if (a.mixed && b.mixed) return true;
  if (a.style === "none" && b.style === "none") return true;
  return a.style === b.style && a.color.toLowerCase() === b.color.toLowerCase();
}

/** The one line all of `sides` draw, or MIXED. */
export function uniformSide(sides: readonly BorderSide[]): BorderSide {
  if (sides.length === 0) return { style: "none", color: "#000000" };
  const first = sides[0];
  return sides.every((s) => sameLine(s, first)) ? first : { ...MIXED_SIDE };
}

function stripOf(rect: EdgeRect, key: EdgeKey): EdgeRect {
  switch (key) {
    case "borderTop":
      return { startRow: rect.startRow, startCol: rect.startCol, endRow: rect.startRow, endCol: rect.endCol };
    case "borderBottom":
      return { startRow: rect.endRow, startCol: rect.startCol, endRow: rect.endRow, endCol: rect.endCol };
    case "borderLeft":
      return { startRow: rect.startRow, startCol: rect.startCol, endRow: rect.endRow, endCol: rect.startCol };
    case "borderRight":
      return { startRow: rect.startRow, startCol: rect.endCol, endRow: rect.endRow, endCol: rect.endCol };
  }
}

/** How many positions of `strip` the cell `c` (with its merge span) covers. */
function covered(c: CellData, strip: EdgeRect): number {
  const r0 = Math.max(c.row, strip.startRow);
  const r1 = Math.min(c.row + Math.max(1, c.rowSpan ?? 1) - 1, strip.endRow);
  const c0 = Math.max(c.col, strip.startCol);
  const c1 = Math.min(c.col + Math.max(1, c.colSpan ?? 1) - 1, strip.endCol);
  return r1 < r0 || c1 < c0 ? 0 : (r1 - r0 + 1) * (c1 - c0 + 1);
}

/** The line one edge of `rect` shows: uniform, or MIXED. */
export async function edgeSide(rect: EdgeRect, key: EdgeKey, reader: EdgeReader): Promise<BorderSide> {
  const strip = stripOf(rect, key);
  const length = (strip.endRow - strip.startRow + 1) * (strip.endCol - strip.startCol + 1);
  if (length > EDGE_READ_LIMIT) {
    const first = sideOfStyle((await reader.styleAt(strip.startRow, strip.startCol))[key]);
    const last = sideOfStyle((await reader.styleAt(strip.endRow, strip.endCol))[key]);
    return uniformSide([first, last]);
  }
  const cells = await reader.cells(strip);
  const styles = new Map<number, Promise<StyleData>>();
  const styleOf = (index: number): Promise<StyleData> => {
    let s = styles.get(index);
    if (!s) {
      s = reader.style(index);
      styles.set(index, s);
    }
    return s;
  };
  const sides: BorderSide[] = [];
  let seen = 0;
  for (const c of cells) {
    const n = covered(c, strip);
    if (n === 0) continue;
    seen += n;
    sides.push(sideOfStyle((await styleOf(c.styleIndex ?? 0))[key]));
  }
  // A position the read skipped holds no cell and no row/column format: it
  // shows the default style.
  if (seen < length) sides.push(sideOfStyle((await styleOf(0))[key]));
  return uniformSide(sides);
}

/** All four outer edges of `rect`. */
export async function outerEdgeSides(rect: EdgeRect, reader: EdgeReader): Promise<Record<EdgeKey, BorderSide>> {
  const [borderTop, borderBottom, borderLeft, borderRight] = await Promise.all([
    edgeSide(rect, "borderTop", reader),
    edgeSide(rect, "borderBottom", reader),
    edgeSide(rect, "borderLeft", reader),
    edgeSide(rect, "borderRight", reader),
  ]);
  return { borderTop, borderBottom, borderLeft, borderRight };
}
