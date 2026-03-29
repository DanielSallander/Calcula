//! FILENAME: app/extensions/Print/lib/pageBreakOverlay.ts
// PURPOSE: Renders page break preview lines on the grid canvas.
// CONTEXT: Registered as a post-header overlay by the Print extension.
//          Shows dashed blue lines at automatic + manual page break positions.

import type { GridConfig, Viewport, DimensionOverrides } from "../../../src/api/types";
import {
  calculateColumnX,
  calculateRowY,
  createDimensionGetterFromMap,
} from "../../../src/api/dimensions";
import { getPageSetup } from "../../../src/api/lib";
import type { PageSetup } from "../../../src/api/lib";

// ============================================================================
// State
// ============================================================================

let pageBreakPreviewEnabled = false;
let cachedPageSetup: PageSetup | null = null;
let cachedGridBoundsRow = 0;
let cachedGridBoundsCol = 0;

/** Row/col indices where page breaks occur. */
let computedRowBreaks: number[] = [];
let computedColBreaks: number[] = [];

// ============================================================================
// Paper sizes in px (at 96 DPI)
// ============================================================================

const PAPER_SIZES_PX: Record<string, { width: number; height: number }> = {
  a4: { width: 794, height: 1123 },
  a3: { width: 1123, height: 1587 },
  letter: { width: 816, height: 1056 },
  legal: { width: 816, height: 1346 },
  tabloid: { width: 1056, height: 1632 },
};

function inchesToPx(inches: number): number {
  return inches * 96;
}

// ============================================================================
// Break Computation
// ============================================================================

/**
 * Compute automatic page break positions based on page setup and column/row dimensions.
 * Returns arrays of row and column indices where breaks should be drawn.
 */
function computeBreakPositions(
  pageSetup: PageSetup,
  maxRow: number,
  maxCol: number,
  getColWidth: (col: number) => number,
  getRowHeight: (row: number) => number,
): { rowBreaks: number[]; colBreaks: number[] } {
  const paper = PAPER_SIZES_PX[pageSetup.paperSize] || PAPER_SIZES_PX.a4;
  const isLandscape = pageSetup.orientation === "landscape";
  const pageW = isLandscape ? paper.height : paper.width;
  const pageH = isLandscape ? paper.width : paper.height;

  const mLeft = inchesToPx(pageSetup.marginLeft);
  const mRight = inchesToPx(pageSetup.marginRight);
  const mTop = inchesToPx(pageSetup.marginTop);
  const mBottom = inchesToPx(pageSetup.marginBottom);

  const scalePct = pageSetup.scale || 100;
  const contentWidth = (pageW - mLeft - mRight);
  const contentHeight = (pageH - mTop - mBottom);

  // Manual breaks
  const manualRowSet = new Set(pageSetup.manualRowBreaks ?? []);
  const manualColSet = new Set(pageSetup.manualColBreaks ?? []);

  // Compute column breaks
  const colBreaks: number[] = [];
  let accW = 0;
  for (let c = 0; c <= maxCol; c++) {
    const w = getColWidth(c) * scalePct / 100;
    if (accW + w > contentWidth && c > 0) {
      colBreaks.push(c);
      accW = 0;
    }
    if (manualColSet.has(c) && c > 0 && !colBreaks.includes(c)) {
      colBreaks.push(c);
      accW = 0;
    }
    accW += w;
  }

  // Compute row breaks
  const rowBreaks: number[] = [];
  let accH = 0;
  for (let r = 0; r <= maxRow; r++) {
    const h = getRowHeight(r) * scalePct / 100;
    if (accH + h > contentHeight && r > 0) {
      rowBreaks.push(r);
      accH = 0;
    }
    if (manualRowSet.has(r) && r > 0 && !rowBreaks.includes(r)) {
      rowBreaks.push(r);
      accH = 0;
    }
    accH += h;
  }

  return { rowBreaks, colBreaks };
}

// ============================================================================
// Public API
// ============================================================================

/** Toggle page break preview on/off. Returns the new state. */
export function togglePageBreakPreview(): boolean {
  pageBreakPreviewEnabled = !pageBreakPreviewEnabled;
  if (pageBreakPreviewEnabled) {
    refreshPageBreakData();
  }
  return pageBreakPreviewEnabled;
}

/** Get current page break preview state. */
export function isPageBreakPreviewEnabled(): boolean {
  return pageBreakPreviewEnabled;
}

/** Set page break preview state explicitly. */
export function setPageBreakPreviewEnabled(enabled: boolean): void {
  pageBreakPreviewEnabled = enabled;
  if (enabled) {
    refreshPageBreakData();
  }
}

/** Refresh page break data from backend. Call after page setup changes. */
export async function refreshPageBreakData(): Promise<void> {
  try {
    cachedPageSetup = await getPageSetup();
  } catch {
    cachedPageSetup = null;
  }
}

/**
 * Post-header overlay renderer that draws page break lines.
 * Registered via registerPostHeaderOverlay.
 */
export function renderPageBreakOverlay(
  ctx: CanvasRenderingContext2D,
  config: GridConfig,
  viewport: Viewport,
  dimensions: DimensionOverrides,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (!pageBreakPreviewEnabled || !cachedPageSetup) return;

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const defaultColWidth = config.defaultColumnWidth || 100;
  const defaultRowHeight = config.defaultRowHeight || 24;

  const getColW = createDimensionGetterFromMap(dimensions.columnWidths, defaultColWidth);
  const getRowH = createDimensionGetterFromMap(dimensions.rowHeights, defaultRowHeight);

  // Determine grid bounds (estimate from viewport)
  const maxRow = Math.max(viewport.startRow + viewport.visibleRows + 50, cachedGridBoundsRow);
  const maxCol = Math.max(viewport.startCol + viewport.visibleCols + 20, cachedGridBoundsCol);
  cachedGridBoundsRow = maxRow;
  cachedGridBoundsCol = maxCol;

  // Compute breaks
  const { rowBreaks, colBreaks } = computeBreakPositions(
    cachedPageSetup, maxRow, maxCol, getColW, getRowH,
  );

  computedRowBreaks = rowBreaks;
  computedColBreaks = colBreaks;

  const manualRowSet = new Set(cachedPageSetup.manualRowBreaks ?? []);
  const manualColSet = new Set(cachedPageSetup.manualColBreaks ?? []);

  ctx.save();

  // Draw horizontal page break lines (at row positions)
  for (const r of rowBreaks) {
    const y = calculateRowY(r, colHeaderHeight, viewport.scrollY, getRowH);
    if (y < colHeaderHeight || y > canvasHeight) continue;

    const isManual = manualRowSet.has(r);
    ctx.strokeStyle = isManual ? "#0066cc" : "#4488cc";
    ctx.lineWidth = isManual ? 2 : 1.5;
    ctx.setLineDash(isManual ? [6, 3] : [4, 4]);

    ctx.beginPath();
    ctx.moveTo(rowHeaderWidth, y);
    ctx.lineTo(canvasWidth, y);
    ctx.stroke();
  }

  // Draw vertical page break lines (at column positions)
  for (const c of colBreaks) {
    const x = calculateColumnX(c, rowHeaderWidth, viewport.scrollX, getColW);
    if (x < rowHeaderWidth || x > canvasWidth) continue;

    const isManual = manualColSet.has(c);
    ctx.strokeStyle = isManual ? "#0066cc" : "#4488cc";
    ctx.lineWidth = isManual ? 2 : 1.5;
    ctx.setLineDash(isManual ? [6, 3] : [4, 4]);

    ctx.beginPath();
    ctx.moveTo(x, colHeaderHeight);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();
  }

  ctx.setLineDash([]);
  ctx.restore();
}

/** Get the computed page break positions (for use by other components). */
export function getComputedBreaks(): { rowBreaks: number[]; colBreaks: number[] } {
  return { rowBreaks: computedRowBreaks, colBreaks: computedColBreaks };
}
