//! FILENAME: app/extensions/Pivot/rendering/pivotVisualRenderer.ts
// PURPOSE: Paint a CANVAS pivot inside its designer-sized box (the frame), the
//          way a Power BI matrix sits in its visual: the view is clipped to the
//          box, the overflow scrolls, and the header rows / row-label columns
//          stay put while the body moves.
// CONTEXT: A canvas pivot is a real pivot written into the canvas's hidden grid
//          (row 0, a column block of its own). The Core never paints cells on a
//          canvas surface, so this is the ONLY place the pivot becomes visible
//          there. Everything here is pure geometry plus one paint entry point:
//
//          - NO offscreen buffer. The grid context already carries
//            setTransform(dpr * zoom), so drawing straight into it under a clip
//            and a translate stays sharp at every dpr and zoom; a buffer blitted
//            at a fractional device offset would blur the text.
//          - `renderPivotView` is called with `clear: false` -- its clearRect
//            would cut a transparent hole through the page under the box.
//          - The interactive bounds it returns are already box-local AFTER the
//            scroll (a scrolled cell's x is `offset - scrollLeft`). Mapping them
//            to canvas coordinates adds the box origin and nothing else;
//            subtracting the scroll again would count it twice.

import type { PivotViewResponse, PivotRowData } from "../lib/pivot-api";
import type { PivotInteractiveBounds } from "@api/pivotTypes";
import { renderPivotView, buildAxisOffsets, DEFAULT_PIVOT_CELL_HEIGHT } from "./pivot";
import type { PivotTheme } from "./pivot";
// The offset searches and the scroll bars are shared with the floating grid
// (FloatingRange), which scrolls with the same arithmetic.
import { firstEndingAfter, lastStartingBefore, indexAt } from "../../_shared/lib/offsetSearch";
import { paintScrollIndicators } from "../../_shared/lib/scrollIndicators";

// ============================================================================
// Geometry
// ============================================================================

/** Row/column layout of one view inside its box (box-local, unscrolled). */
export interface PivotVisualGeometry {
  rowCount: number;
  colCount: number;
  /** Pixel height per view row; 0 = hidden (collapsed or filtered away). */
  rowHeights: number[];
  colWidths: number[];
  /** Prefix sums: `rowOffsets[i]` = top of row i; `rowOffsets[rowCount]` = content height. */
  rowOffsets: Float64Array;
  colOffsets: Float64Array;
  /** Header rows kept fixed at the top (0 when the frame does not freeze headers). */
  frozenRowCount: number;
  /** Row-label columns kept fixed at the left (0 when not frozen). */
  frozenColCount: number;
}

/** The session scroll origin of one box, in box-local px. */
export interface PivotVisualScroll {
  left: number;
  top: number;
}

/** Where the geometry reads cell sizes from (the canvas's own hidden grid). */
export interface PivotVisualSizeSource {
  columnWidth(viewCol: number): number;
  rowHeight(viewRow: number): number;
}

/** Number of view rows, windowed or not. */
export function viewRowCount(view: PivotViewResponse): number {
  return view.isWindowed === true ? (view.totalRowCount ?? view.rows.length) : view.rows.length;
}

/** Number of view columns. */
export function viewColCount(view: PivotViewResponse): number {
  return Math.max(view.colCount ?? 0, view.rows[0]?.cells.length ?? 0);
}

/** Whether view row i is shown (windowed: its descriptor; else the row itself). */
export function isViewRowVisible(view: PivotViewResponse, i: number): boolean {
  if (view.isWindowed === true) {
    return view.rowDescriptors?.[i]?.visible ?? true;
  }
  return view.rows[i]?.visible ?? true;
}

/**
 * Build the box geometry for `view`. `frozenHeaders` freezes the header rows
 * (`columnHeaderRowCount`, which already INCLUDES the report-filter rows at
 * the top) and the row-label columns (`rowLabelColCount`).
 */
export function buildPivotVisualGeometry(
  view: PivotViewResponse,
  frozenHeaders: boolean,
  sizes: PivotVisualSizeSource,
): PivotVisualGeometry {
  const rowCount = viewRowCount(view);
  const colCount = viewColCount(view);

  const colWidths: number[] = new Array(colCount);
  for (let j = 0; j < colCount; j++) {
    colWidths[j] = Math.max(0, sizes.columnWidth(j));
  }
  const rowHeights: number[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    rowHeights[i] = isViewRowVisible(view, i) ? Math.max(0, sizes.rowHeight(i)) : 0;
  }

  return {
    rowCount,
    colCount,
    rowHeights,
    colWidths,
    rowOffsets: buildAxisOffsets(rowHeights, rowCount, DEFAULT_PIVOT_CELL_HEIGHT),
    colOffsets: buildAxisOffsets(colWidths, colCount, 0),
    frozenRowCount: frozenHeaders ? Math.min(view.columnHeaderRowCount || 0, rowCount) : 0,
    frozenColCount: frozenHeaders ? Math.min(view.rowLabelColCount || 0, colCount) : 0,
  };
}

/** Size of the fixed header band / row-label band. */
export function frozenExtent(g: PivotVisualGeometry): { frozenWidth: number; frozenHeight: number } {
  return {
    frozenWidth: g.colOffsets[g.frozenColCount] ?? 0,
    frozenHeight: g.rowOffsets[g.frozenRowCount] ?? 0,
  };
}

/** Full content size of the view. */
export function contentExtent(g: PivotVisualGeometry): { width: number; height: number } {
  return {
    width: g.colOffsets[g.colCount] ?? 0,
    height: g.rowOffsets[g.rowCount] ?? 0,
  };
}

/**
 * How far the box can scroll. Freezing does not change it: the scrollable
 * viewport is `box - frozen` and the scrollable content is `content - frozen`,
 * so the difference is `content - box` either way.
 */
export function maxScrollOf(
  g: PivotVisualGeometry,
  boxWidth: number,
  boxHeight: number,
): { maxLeft: number; maxTop: number } {
  const c = contentExtent(g);
  return {
    maxLeft: Math.max(0, Math.ceil(c.width - boxWidth)),
    maxTop: Math.max(0, Math.ceil(c.height - boxHeight)),
  };
}

/** Clamp a scroll origin into [0, max] on both axes (a resize or a refilter can shrink max). */
export function clampVisualScroll(
  g: PivotVisualGeometry,
  boxWidth: number,
  boxHeight: number,
  s: PivotVisualScroll,
): PivotVisualScroll {
  const { maxLeft, maxTop } = maxScrollOf(g, boxWidth, boxHeight);
  const clamp = (v: number, max: number) => (Number.isFinite(v) ? Math.min(Math.max(0, v), max) : 0);
  return { left: clamp(s.left, maxLeft), top: clamp(s.top, maxTop) };
}

/**
 * The scrolling BODY range visible in the box (frozen rows/columns are always
 * painted in full and are not part of it). Empty ranges come back with
 * end < start, which the renderer skips.
 */
export function visibleCellRange(
  g: PivotVisualGeometry,
  s: PivotVisualScroll,
  boxWidth: number,
  boxHeight: number,
): { startRow: number; endRow: number; startCol: number; endCol: number } {
  const { frozenWidth, frozenHeight } = frozenExtent(g);
  // Body row r is at y = rowOffsets[r] - top; visible when it ends below the
  // frozen band and starts above the box bottom.
  const startRow = firstEndingAfter(g.rowOffsets, g.frozenRowCount, g.rowCount, s.top + frozenHeight);
  const endRow = lastStartingBefore(g.rowOffsets, g.frozenRowCount, g.rowCount, s.top + boxHeight);
  const startCol = firstEndingAfter(g.colOffsets, g.frozenColCount, g.colCount, s.left + frozenWidth);
  const endCol = lastStartingBefore(g.colOffsets, g.frozenColCount, g.colCount, s.left + boxWidth);
  return { startRow, endRow, startCol, endCol };
}

/**
 * The view cell under a BOX-LOCAL point -- the inverse of the frozen + scroll
 * geometry the renderer paints with. Null outside the content.
 */
export function viewCellAtLocal(
  g: PivotVisualGeometry,
  s: PivotVisualScroll,
  localX: number,
  localY: number,
): { viewRow: number; viewCol: number } | null {
  if (localX < 0 || localY < 0) return null;
  const { frozenWidth, frozenHeight } = frozenExtent(g);

  const viewRow = localY < frozenHeight
    ? indexAt(g.rowOffsets, 0, g.frozenRowCount, localY)
    : indexAt(g.rowOffsets, g.frozenRowCount, g.rowCount, localY + s.top);
  const viewCol = localX < frozenWidth
    ? indexAt(g.colOffsets, 0, g.frozenColCount, localX)
    : indexAt(g.colOffsets, g.frozenColCount, g.colCount, localX + s.left);

  if (viewRow < 0 || viewCol < 0) return null;
  return { viewRow, viewCol };
}

// ============================================================================
// Paint
// ============================================================================

/** The box in CANVAS coordinates (logical px, rounded). */
export interface PivotVisualBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PivotVisualHover {
  filterFieldIndex?: number | null;
  iconKey?: string | null;
  headerFilterKey?: string | null;
}

export interface PivotVisualPaintArgs {
  ctx: CanvasRenderingContext2D;
  view: PivotViewResponse;
  geometry: PivotVisualGeometry;
  box: PivotVisualBox;
  /** Already clamped (see clampVisualScroll). */
  scroll: PivotVisualScroll;
  theme: PivotTheme;
  /** Windowed views: the cell-window cache; null = not fetched yet. */
  getRow?: (viewRow: number) => PivotRowData | null;
  onMissingRows?: (firstRow: number, lastRow: number) => void;
  hover?: PivotVisualHover;
}

export interface PivotVisualPaintResult {
  /** Box-local bounds (after scroll). Add the box origin to reach canvas coordinates. */
  bounds: PivotInteractiveBounds;
}

/**
 * Paint the view inside the box: clip to the box, translate to its origin,
 * fill the background, render the frozen/scrolling quadrants, then the scroll
 * indicators. Nothing is drawn outside `box`.
 */
export function paintPivotVisual(args: PivotVisualPaintArgs): PivotVisualPaintResult {
  const { ctx, view, geometry: g, box, scroll, theme } = args;

  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.translate(box.x, box.y);

  // The box is opaque: the page must not show through between cells.
  ctx.fillStyle = theme.valueBackground || "#ffffff";
  ctx.fillRect(0, 0, box.width, box.height);

  const range = visibleCellRange(g, scroll, box.width, box.height);
  const { interactiveBounds } = renderPivotView(
    ctx,
    view,
    box.width,
    box.height,
    {
      ...range,
      rowHeights: g.rowHeights,
      colWidths: g.colWidths,
      scrollLeft: scroll.left,
      scrollTop: scroll.top,
      frozenRowCount: g.frozenRowCount,
      frozenColCount: g.frozenColCount,
      hoveredFilterFieldIndex: args.hover?.filterFieldIndex ?? null,
      hoveredIconKey: args.hover?.iconKey ?? null,
      hoveredHeaderFilterKey: args.hover?.headerFilterKey ?? null,
      clear: false,
      rowCount: g.rowCount,
      getRow: args.getRow,
      onMissingRows: args.onMissingRows,
      rowOffsets: g.rowOffsets,
    },
    theme,
  );

  // Box-local after the translate above, so the bars' box starts at 0,0.
  const { frozenWidth, frozenHeight } = frozenExtent(g);
  paintScrollIndicators(ctx, {
    box: { x: 0, y: 0, width: box.width, height: box.height },
    scroll,
    maxScroll: maxScrollOf(g, box.width, box.height),
    content: contentExtent(g),
    frozen: { width: frozenWidth, height: frozenHeight },
  });

  ctx.restore();
  return { bounds: interactiveBounds };
}

/** Box outline colour (visible on the page even when the view is empty). */
const BOX_BORDER = "#c8c8c8";

/**
 * The box chrome drawn OUTSIDE the content clip: a thin outline so the box is
 * visible on the page, selected or not. A SELECTED box's outline and its
 * resize handles are Core's (core/lib/gridRenderer/rendering/
 * floatingObjectChrome.ts), painted from the one geometry Core's resize hit
 * test reads -- and not at all in consume mode or on a locked box, where no
 * handle is live (BUG-0258 design phase 3).
 */
export function paintPivotVisualFrame(ctx: CanvasRenderingContext2D, box: PivotVisualBox): void {
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = BOX_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, Math.max(0, box.width - 1), Math.max(0, box.height - 1));
  ctx.restore();
}
