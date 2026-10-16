//! FILENAME: app/extensions/Pivot/lib/pivotCellNavigation.ts
// PURPOSE: One arrow-key step inside a canvas pivot box's cells (D-CELLS): up,
//          down, left or right from a view cell, skipping HIDDEN rows (a
//          collapsed group's or a filtered row's height is 0 in the box's
//          geometry), clamped at the edges. Pure -- the keys and the selection
//          store decide what the step means.

import type { PivotVisualGeometry } from "../rendering/pivotVisualRenderer";

export type PivotCellStep = "up" | "down" | "left" | "right";

/**
 * The view cell one step from (`row`, `col`). A vertical step lands on the
 * next row with a non-zero height; when there is none in that direction it
 * stays put (an edge). A horizontal step moves one column, clamped to the
 * view. A start outside the view is clamped into it first.
 */
export function stepPivotCell(
  g: Pick<PivotVisualGeometry, "rowCount" | "colCount" | "rowHeights">,
  row: number,
  col: number,
  dir: PivotCellStep,
): { row: number; col: number } {
  if (g.rowCount <= 0 || g.colCount <= 0) return { row: 0, col: 0 };
  const r = Math.min(Math.max(0, Math.floor(row)), g.rowCount - 1);
  const c = Math.min(Math.max(0, Math.floor(col)), g.colCount - 1);
  const shown = (i: number) => (g.rowHeights[i] ?? 0) > 0;
  switch (dir) {
    case "up":
      for (let i = r - 1; i >= 0; i--) if (shown(i)) return { row: i, col: c };
      return { row: r, col: c };
    case "down":
      for (let i = r + 1; i < g.rowCount; i++) if (shown(i)) return { row: i, col: c };
      return { row: r, col: c };
    case "left":
      return { row: r, col: Math.max(0, c - 1) };
    case "right":
      return { row: r, col: Math.min(g.colCount - 1, c + 1) };
  }
}
