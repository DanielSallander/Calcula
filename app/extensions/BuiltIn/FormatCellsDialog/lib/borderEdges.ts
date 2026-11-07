//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/lib/borderEdges.ts
// PURPOSE: What the Border tab shows for each OUTER edge of a range, and for its
//          two INSIDE lines: the one line every cell along that edge (every
//          inner boundary) draws, or MIXED when they differ.
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
//
//          THE INSIDE LINES (BUG-0726) are read the same way. They were loaded
//          from the top-left cell's bottom and right sides, so A1:B3 with only
//          A1 bordered at the bottom showed Inside Horizontal ON, and a click
//          meant to draw the line between every row turned it OFF everywhere.
//          Excel greys a mixed inside line exactly as it greys a mixed outer
//          edge: the Border tab's preview draws it as a grey dotted line
//          (#C0C0C0) where a uniform line is solid black [LIVE, Excel 16,
//          2026-11-06, lane uiforms probe3: A1:B3 with A1's bottom only, with
//          B2's top only, and A1:B3 with A2's right only; COM's
//          `Borders(xlInsideHorizontal)` is no guide -- it reads the top-left
//          cell's own side (probe1)]. Each inner BOUNDARY is one line, the two
//          cell sides that meet there taken together: B2's top alone draws the
//          B1|B2 line, as it does on the grid.

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

// ============================================================================
// The inside lines (BUG-0726)
// ============================================================================

export type InsideKey = "borderInsideHorizontal" | "borderInsideVertical";

/** The most inner boundaries read cell by cell: a full row of columns' worth. */
export const INSIDE_READ_LIMIT = 16384;

/**
 * The line ONE inner boundary draws, from the two cell sides that meet there:
 * `first` is the upper (left) cell's bottom (right), `second` the lower
 * (right) cell's top (left). Either side alone draws the boundary -- the grid
 * strokes whichever is set, and Excel keeps one line per boundary, so B2's top
 * alone is the B1|B2 line [LIVE, probe3 "B2topOnly"]. Two sides that are both
 * set and DIFFER are two lines the cells disagree about: MIXED.
 */
export function boundaryLine(first: BorderSide, second: BorderSide): BorderSide {
  if (first.style === "none") return second;
  if (second.style === "none") return first;
  return sameLine(first, second) ? first : { ...MIXED_SIDE };
}

/** How many inner boundaries of `rect` run in `key`'s direction. */
function insideBoundaryCount(rect: EdgeRect, key: InsideKey): number {
  const rows = rect.endRow - rect.startRow + 1;
  const cols = rect.endCol - rect.startCol + 1;
  return key === "borderInsideHorizontal" ? (rows - 1) * cols : rows * (cols - 1);
}

/**
 * The line `rect`'s inside lines in one direction show: the one line every
 * inner boundary draws, or MIXED. "none" when `rect` has no inside in that
 * direction (one row, or one column). A boundary INSIDE a merged cell is no
 * boundary. Bounded like the outer edges: past INSIDE_READ_LIMIT boundaries
 * (a whole column's million rows) the first and the last boundary decide --
 * never the top-left cell alone.
 */
export async function insideLineSide(rect: EdgeRect, key: InsideKey, reader: EdgeReader): Promise<BorderSide> {
  const horizontal = key === "borderInsideHorizontal";
  const firstSide = horizontal ? "borderBottom" : "borderRight";
  const secondSide = horizontal ? "borderTop" : "borderLeft";
  const count = insideBoundaryCount(rect, key);
  if (count <= 0) return { style: "none", color: "#000000" };

  if (count > INSIDE_READ_LIMIT) {
    // The first boundary (below / right of the top-left cell) and the last
    // (above / left of the bottom-right cell).
    const lineAt = async (r: number, c: number): Promise<BorderSide> => {
      const [a, b] = await Promise.all([
        reader.styleAt(r, c),
        horizontal ? reader.styleAt(r + 1, c) : reader.styleAt(r, c + 1),
      ]);
      return boundaryLine(sideOfStyle(a[firstSide]), sideOfStyle(b[secondSide]));
    };
    const first = await lineAt(rect.startRow, rect.startCol);
    const last = horizontal
      ? await lineAt(rect.endRow - 1, rect.endCol)
      : await lineAt(rect.endRow, rect.endCol - 1);
    return uniformSide([first, last]);
  }

  // Every position's style index (a merged cell's covers its span) and, for a
  // merged cell, which merge holds it: a boundary between two positions of the
  // same merge lies inside one cell.
  const cells = await reader.cells(rect);
  const width = rect.endCol - rect.startCol + 1;
  const at = (r: number, c: number) => (r - rect.startRow) * width + (c - rect.startCol);
  const styleIndexAt = new Map<number, number>();
  const mergeAt = new Map<number, number>();
  cells.forEach((cell, n) => {
    const r1 = cell.row + Math.max(1, cell.rowSpan ?? 1) - 1;
    const c1 = cell.col + Math.max(1, cell.colSpan ?? 1) - 1;
    const merged = r1 > cell.row || c1 > cell.col;
    for (let r = Math.max(cell.row, rect.startRow); r <= Math.min(r1, rect.endRow); r++) {
      for (let c = Math.max(cell.col, rect.startCol); c <= Math.min(c1, rect.endCol); c++) {
        styleIndexAt.set(at(r, c), cell.styleIndex ?? 0);
        if (merged) mergeAt.set(at(r, c), n);
      }
    }
  });
  const styles = new Map<number, Promise<StyleData>>();
  const styleOf = (index: number): Promise<StyleData> => {
    let s = styles.get(index);
    if (!s) {
      s = reader.style(index);
      styles.set(index, s);
    }
    return s;
  };
  // A position the read skipped holds no cell and no row/column format: the
  // default style (index 0), as for the outer edges.
  const indexAt = (r: number, c: number) => styleIndexAt.get(at(r, c)) ?? 0;

  const lines: BorderSide[] = [];
  const rLast = horizontal ? rect.endRow - 1 : rect.endRow;
  const cLast = horizontal ? rect.endCol : rect.endCol - 1;
  for (let r = rect.startRow; r <= rLast; r++) {
    for (let c = rect.startCol; c <= cLast; c++) {
      const r2 = horizontal ? r + 1 : r;
      const c2 = horizontal ? c : c + 1;
      const m1 = mergeAt.get(at(r, c));
      if (m1 !== undefined && m1 === mergeAt.get(at(r2, c2))) continue;
      const [a, b] = await Promise.all([styleOf(indexAt(r, c)), styleOf(indexAt(r2, c2))]);
      lines.push(boundaryLine(sideOfStyle(a[firstSide]), sideOfStyle(b[secondSide])));
    }
  }
  return uniformSide(lines);
}

// ============================================================================
// The preview
// ============================================================================

/** Excel's mixed-line grey in the Border preview (sample DATA: the preview is a
 *  white cell sample, whatever the skin) [LIVE, probe3/probe4 pixels]. */
export const MIXED_LINE_COLOR = "#c0c0c0";

/** How the Border tab's preview draws one line: a real line in its own style
 *  and colour, a MIXED one as Excel's grey dotted line, or nothing. */
export function previewLine(side: BorderSide): { color: string; width: string; style: string } | null {
  if (side.mixed) return { color: MIXED_LINE_COLOR, width: "2px", style: "dotted" };
  if (side.style === "none") return null;
  const width = side.style === "medium" ? "2px" : side.style === "thick" ? "3px" : "1px";
  const style =
    side.style === "dashed" ? "dashed" : side.style === "dotted" ? "dotted" : side.style === "double" ? "double" : "solid";
  return { color: side.color, width, style };
}

/** Both inside lines of `rect` (each "none" where `rect` has no inside that way). */
export async function insideLineSides(rect: EdgeRect, reader: EdgeReader): Promise<Record<InsideKey, BorderSide>> {
  const [borderInsideHorizontal, borderInsideVertical] = await Promise.all([
    insideLineSide(rect, "borderInsideHorizontal", reader),
    insideLineSide(rect, "borderInsideVertical", reader),
  ]);
  return { borderInsideHorizontal, borderInsideVertical };
}
