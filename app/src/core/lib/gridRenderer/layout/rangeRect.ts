//! FILENAME: app/src/core/lib/gridRenderer/layout/rangeRect.ts
// PURPOSE: Freeze-pane-aware cell-range -> canvas-pixel geometry.
// CONTEXT: The spill border has always placed its rectangle correctly in frozen
//          and split panes; the extension-facing overlay helpers
//          (`overlayGetColumnX` & co. in @api/gridOverlays) subtract the scroll
//          offset from EVERY column and row, so a rectangle drawn with them
//          lands in the wrong place once panes are frozen. This module is the
//          spill border's math lifted out so both the spill border and the
//          @api `rangeToCanvasRect` helper (@api/gridLayers) use ONE copy.
//          It is a Core primitive: it knows cells, pixels and panes, nothing
//          about any feature.

import type { FreezeConfig, DimensionOverrides, GridConfig, Viewport } from "../../../types";
import { calculateFreezePaneLayout } from "./viewport";
import { getColumnWidth, getRowHeight } from "./dimensions";
import { rowHeaderGutter, colHeaderGutter } from "./headerVisibility";

/** A visible canvas rectangle for a cell range, with which edges were cut. */
export interface RangeCanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * An edge is CLIPPED when the range continues past it (scrolled under a
   * header, under the frozen panes, or off the canvas). A painter that draws a
   * perimeter skips clipped edges so a partly visible range does not look
   * like a smaller range that ends at the viewport edge.
   */
  clippedLeft: boolean;
  clippedTop: boolean;
  clippedRight: boolean;
  clippedBottom: boolean;
}

/** Left edge of a column in canvas pixels, honouring frozen columns. */
export function columnXWithFreeze(
  col: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  viewport: Viewport,
  freezeConfig?: FreezeConfig | null,
  splitBarSize: number = 0
): number {
  const rowHeaderWidth = rowHeaderGutter(config);
  const freezeCol = freezeConfig?.freezeCol ?? 0;

  if (freezeCol > 0 && col < freezeCol) {
    let x = rowHeaderWidth;
    for (let c = 0; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    return x;
  } else if (freezeCol > 0) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const scrollX = viewport.scrollX || 0;
    let x = rowHeaderWidth + layout.frozenColsWidth + splitBarSize;
    for (let c = freezeCol; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    x -= scrollX;
    return x;
  } else {
    const scrollX = viewport.scrollX || 0;
    let x = rowHeaderWidth;
    for (let c = 0; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    return x - scrollX;
  }
}

/** Top edge of a row in canvas pixels, honouring frozen rows. */
export function rowYWithFreeze(
  row: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  viewport: Viewport,
  freezeConfig?: FreezeConfig | null,
  splitBarSize: number = 0
): number {
  const colHeaderHeight = colHeaderGutter(config);
  const freezeRow = freezeConfig?.freezeRow ?? 0;

  if (freezeRow > 0 && row < freezeRow) {
    let y = colHeaderHeight;
    for (let r = 0; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    return y;
  } else if (freezeRow > 0) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const scrollY = viewport.scrollY || 0;
    let y = colHeaderHeight + layout.frozenRowsHeight + splitBarSize;
    for (let r = freezeRow; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    y -= scrollY;
    return y;
  } else {
    const scrollY = viewport.scrollY || 0;
    let y = colHeaderHeight;
    for (let r = 0; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    return y - scrollY;
  }
}

/**
 * One axis of the range: the visible [start, end) span and which ends were cut.
 *
 * `frozenCount` lines are pinned; the rest scroll. A range wholly in the
 * scrolling part must never paint over the pinned part, so its lower bound is
 * the pinned edge (plus the split bar). A range that STARTS pinned and ends in
 * the scrolling part keeps at least its pinned piece even when its scrolling
 * piece has scrolled away under the pinned lines.
 */
function visibleSpan(
  start: number,
  end: number,
  rawStart: number,
  rawEnd: number,
  headerSize: number,
  frozenCount: number,
  frozenSize: number,
  splitBarSize: number,
  canvasSize: number
): { lo: number; hi: number; cutLo: boolean; cutHi: boolean } | null {
  let lowerBound = headerSize;
  let hiPos = rawEnd;
  if (frozenCount > 0 && start >= frozenCount) {
    lowerBound = headerSize + frozenSize + splitBarSize;
  } else if (frozenCount > 0 && start < frozenCount && end >= frozenCount) {
    const pinnedEdge = headerSize + frozenSize;
    if (hiPos < pinnedEdge) hiPos = pinnedEdge;
  }
  const lo = Math.max(rawStart, lowerBound);
  const hi = Math.min(hiPos, canvasSize);
  if (!(lo < hi)) return null;
  return {
    lo,
    hi,
    cutLo: rawStart < lowerBound,
    cutHi: hiPos > canvasSize || hiPos !== rawEnd,
  };
}

/**
 * The visible canvas rectangle of a cell range (inclusive bounds, any order),
 * honouring frozen panes and a split bar, clipped below the headers and to the
 * canvas. `null` when nothing of the range is on screen (scrolled away, or
 * every row/column of it hidden).
 */
export function rangeToCanvasRect(
  range: { startRow: number; startCol: number; endRow: number; endCol: number },
  config: GridConfig,
  dimensions: DimensionOverrides,
  viewport: Viewport,
  canvasWidth: number,
  canvasHeight: number,
  freezeConfig?: FreezeConfig | null,
  splitBarSize: number = 0
): RangeCanvasRect | null {
  const startRow = Math.min(range.startRow, range.endRow);
  const endRow = Math.max(range.startRow, range.endRow);
  const startCol = Math.min(range.startCol, range.endCol);
  const endCol = Math.max(range.startCol, range.endCol);

  const freezeRow = freezeConfig?.freezeRow ?? 0;
  const freezeCol = freezeConfig?.freezeCol ?? 0;
  const layout =
    freezeConfig && (freezeRow > 0 || freezeCol > 0)
      ? calculateFreezePaneLayout(freezeConfig, config, dimensions)
      : { frozenColsWidth: 0, frozenRowsHeight: 0 };

  const x1 = columnXWithFreeze(startCol, config, dimensions, viewport, freezeConfig, splitBarSize);
  const x2 =
    columnXWithFreeze(endCol, config, dimensions, viewport, freezeConfig, splitBarSize) +
    getColumnWidth(endCol, config, dimensions);
  const y1 = rowYWithFreeze(startRow, config, dimensions, viewport, freezeConfig, splitBarSize);
  const y2 =
    rowYWithFreeze(endRow, config, dimensions, viewport, freezeConfig, splitBarSize) +
    getRowHeight(endRow, config, dimensions);

  const xs = visibleSpan(
    startCol, endCol, x1, x2,
    rowHeaderGutter(config), freezeCol, layout.frozenColsWidth, splitBarSize, canvasWidth
  );
  if (!xs) return null;
  const ys = visibleSpan(
    startRow, endRow, y1, y2,
    colHeaderGutter(config), freezeRow, layout.frozenRowsHeight, splitBarSize, canvasHeight
  );
  if (!ys) return null;

  return {
    x: xs.lo,
    y: ys.lo,
    width: xs.hi - xs.lo,
    height: ys.hi - ys.lo,
    clippedLeft: xs.cutLo,
    clippedTop: ys.cutLo,
    clippedRight: xs.cutHi,
    clippedBottom: ys.cutHi,
  };
}
