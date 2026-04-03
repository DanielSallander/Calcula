//! FILENAME: app/extensions/Print/lib/pageBreakOverlay.ts
// PURPOSE: Renders page break preview lines on the grid canvas.
// CONTEXT: Registered as a post-header overlay by the Print extension.
//          Shows dashed blue lines at automatic + manual page break positions.
//          Visualizes print area boundaries with a shaded region.
//          Supports dragging page break lines to reposition them.

import type { GridConfig, Viewport, DimensionOverrides } from "@api/types";
import {
  calculateColumnX,
  calculateRowY,
  createDimensionGetterFromMap,
} from "@api/dimensions";
import { getPageSetup, movePageBreak, colToIndex } from "@api/lib";
import type { PageSetup } from "@api/lib";

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
// Drag State
// ============================================================================

interface DragState {
  active: boolean;
  direction: "row" | "col";
  fromIndex: number;
  currentPixel: number;
}

let dragState: DragState | null = null;
let mouseListenersInstalled = false;

// Store last render params for coordinate calculations during drag
let lastConfig: GridConfig | null = null;
let lastViewport: Viewport | null = null;
let lastDimensions: DimensionOverrides | null = null;
let lastCanvasWidth = 0;
let lastCanvasHeight = 0;

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
// Print Area Parsing
// ============================================================================

interface PrintAreaBounds {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function parsePrintArea(printArea: string): PrintAreaBounds | null {
  if (!printArea || !printArea.trim()) return null;
  const match = printArea.trim().match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return {
    startCol: colToIndex(match[1].toUpperCase()),
    startRow: parseInt(match[2]) - 1,
    endCol: colToIndex(match[3].toUpperCase()),
    endRow: parseInt(match[4]) - 1,
  };
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
// Drag Helpers
// ============================================================================

const DRAG_HIT_TOLERANCE = 6; // px

/** Find the row index at a given canvas Y coordinate. */
function canvasYToRow(
  canvasY: number,
  colHeaderHeight: number,
  scrollY: number,
  getRowH: (row: number) => number,
  maxRow: number,
): number {
  let accY = colHeaderHeight - scrollY;
  for (let r = 0; r <= maxRow; r++) {
    const h = getRowH(r);
    if (canvasY < accY + h) return r;
    accY += h;
  }
  return maxRow;
}

/** Find the col index at a given canvas X coordinate. */
function canvasXToCol(
  canvasX: number,
  rowHeaderWidth: number,
  scrollX: number,
  getColW: (col: number) => number,
  maxCol: number,
): number {
  let accX = rowHeaderWidth - scrollX;
  for (let c = 0; c <= maxCol; c++) {
    const w = getColW(c);
    if (canvasX < accX + w) return c;
    accX += w;
  }
  return maxCol;
}

function installMouseListeners(): void {
  if (mouseListenersInstalled) return;
  mouseListenersInstalled = true;

  const canvas = document.querySelector("canvas");
  if (!canvas) return;

  canvas.addEventListener("mousedown", handleMouseDown, true);
  canvas.addEventListener("mousemove", handleMouseMove, true);
  canvas.addEventListener("mouseup", handleMouseUp, true);
}

function uninstallMouseListeners(): void {
  if (!mouseListenersInstalled) return;
  mouseListenersInstalled = false;

  const canvas = document.querySelector("canvas");
  if (!canvas) return;

  canvas.removeEventListener("mousedown", handleMouseDown, true);
  canvas.removeEventListener("mousemove", handleMouseMove, true);
  canvas.removeEventListener("mouseup", handleMouseUp, true);
}

function handleMouseDown(e: MouseEvent): void {
  if (!pageBreakPreviewEnabled || !cachedPageSetup || !lastConfig || !lastViewport || !lastDimensions) return;

  const canvas = e.target as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const canvasX = e.clientX - rect.left;
  const canvasY = e.clientY - rect.top;

  const rowHeaderWidth = lastConfig.rowHeaderWidth || 50;
  const colHeaderHeight = lastConfig.colHeaderHeight || 24;
  const defaultColWidth = lastConfig.defaultColumnWidth || 100;
  const defaultRowHeight = lastConfig.defaultRowHeight || 24;

  const getColW = createDimensionGetterFromMap(defaultColWidth, lastDimensions.columnWidths);
  const getRowH = createDimensionGetterFromMap(defaultRowHeight, lastDimensions.rowHeights);

  const manualRowSet = new Set(cachedPageSetup.manualRowBreaks ?? []);
  const manualColSet = new Set(cachedPageSetup.manualColBreaks ?? []);

  // Check if click is near a manual row break line
  for (const r of computedRowBreaks) {
    if (!manualRowSet.has(r)) continue;
    const y = calculateRowY(r, colHeaderHeight, lastViewport.scrollY, getRowH);
    if (Math.abs(canvasY - y) <= DRAG_HIT_TOLERANCE && canvasX > rowHeaderWidth) {
      e.preventDefault();
      e.stopPropagation();
      dragState = { active: true, direction: "row", fromIndex: r, currentPixel: canvasY };
      canvas.style.cursor = "ns-resize";
      return;
    }
  }

  // Check if click is near a manual col break line
  for (const c of computedColBreaks) {
    if (!manualColSet.has(c)) continue;
    const x = calculateColumnX(c, rowHeaderWidth, lastViewport.scrollX, getColW);
    if (Math.abs(canvasX - x) <= DRAG_HIT_TOLERANCE && canvasY > colHeaderHeight) {
      e.preventDefault();
      e.stopPropagation();
      dragState = { active: true, direction: "col", fromIndex: c, currentPixel: canvasX };
      canvas.style.cursor = "ew-resize";
      return;
    }
  }
}

function handleMouseMove(e: MouseEvent): void {
  if (!pageBreakPreviewEnabled || !cachedPageSetup || !lastConfig || !lastViewport || !lastDimensions) return;

  const canvas = e.target as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const canvasX = e.clientX - rect.left;
  const canvasY = e.clientY - rect.top;

  if (dragState && dragState.active) {
    // Update drag position
    if (dragState.direction === "row") {
      dragState.currentPixel = canvasY;
    } else {
      dragState.currentPixel = canvasX;
    }
    window.dispatchEvent(new Event("app:grid-refresh"));
    return;
  }

  // Hover cursor feedback
  const rowHeaderWidth = lastConfig.rowHeaderWidth || 50;
  const colHeaderHeight = lastConfig.colHeaderHeight || 24;
  const defaultColWidth = lastConfig.defaultColumnWidth || 100;
  const defaultRowHeight = lastConfig.defaultRowHeight || 24;

  const getColW = createDimensionGetterFromMap(defaultColWidth, lastDimensions.columnWidths);
  const getRowH = createDimensionGetterFromMap(defaultRowHeight, lastDimensions.rowHeights);

  const manualRowSet = new Set(cachedPageSetup.manualRowBreaks ?? []);
  const manualColSet = new Set(cachedPageSetup.manualColBreaks ?? []);

  let nearBreak = false;

  for (const r of computedRowBreaks) {
    if (!manualRowSet.has(r)) continue;
    const y = calculateRowY(r, colHeaderHeight, lastViewport.scrollY, getRowH);
    if (Math.abs(canvasY - y) <= DRAG_HIT_TOLERANCE && canvasX > rowHeaderWidth) {
      canvas.style.cursor = "ns-resize";
      nearBreak = true;
      break;
    }
  }

  if (!nearBreak) {
    for (const c of computedColBreaks) {
      if (!manualColSet.has(c)) continue;
      const x = calculateColumnX(c, rowHeaderWidth, lastViewport.scrollX, getColW);
      if (Math.abs(canvasX - x) <= DRAG_HIT_TOLERANCE && canvasY > colHeaderHeight) {
        canvas.style.cursor = "ew-resize";
        nearBreak = true;
        break;
      }
    }
  }

  if (!nearBreak) {
    // Don't override cursor if we're not near a break
    // (leave it to the core handler)
  }
}

function handleMouseUp(e: MouseEvent): void {
  if (!dragState || !dragState.active) return;

  const canvas = e.target as HTMLCanvasElement;
  canvas.style.cursor = "";

  if (!lastConfig || !lastViewport || !lastDimensions) {
    dragState = null;
    return;
  }

  const rowHeaderWidth = lastConfig.rowHeaderWidth || 50;
  const colHeaderHeight = lastConfig.colHeaderHeight || 24;
  const defaultColWidth = lastConfig.defaultColumnWidth || 100;
  const defaultRowHeight = lastConfig.defaultRowHeight || 24;

  const getColW = createDimensionGetterFromMap(defaultColWidth, lastDimensions.columnWidths);
  const getRowH = createDimensionGetterFromMap(defaultRowHeight, lastDimensions.rowHeights);

  const maxRow = cachedGridBoundsRow;
  const maxCol = cachedGridBoundsCol;

  let toIndex: number;
  if (dragState.direction === "row") {
    toIndex = canvasYToRow(dragState.currentPixel, colHeaderHeight, lastViewport.scrollY, getRowH, maxRow);
  } else {
    toIndex = canvasXToCol(dragState.currentPixel, rowHeaderWidth, lastViewport.scrollX, getColW, maxCol);
  }

  const fromIndex = dragState.fromIndex;
  const direction = dragState.direction;
  dragState = null;

  if (toIndex !== fromIndex && toIndex > 0) {
    movePageBreak(direction, fromIndex, toIndex)
      .then(() => refreshPageBreakData())
      .then(() => window.dispatchEvent(new Event("app:grid-refresh")))
      .catch((err) => console.error("[Print] Move page break failed:", err));
  } else {
    window.dispatchEvent(new Event("app:grid-refresh"));
  }
}

// ============================================================================
// Public API
// ============================================================================

/** Toggle page break preview on/off. Returns the new state. */
export function togglePageBreakPreview(): boolean {
  pageBreakPreviewEnabled = !pageBreakPreviewEnabled;
  if (pageBreakPreviewEnabled) {
    refreshPageBreakData();
    installMouseListeners();
  } else {
    uninstallMouseListeners();
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
    refreshPageBreakData().then(() => {
      // Trigger a redraw now that page setup data is available
      window.dispatchEvent(new Event("app:grid-refresh"));
    });
    installMouseListeners();
  } else {
    uninstallMouseListeners();
  }
}

/** Refresh page break data from backend. Call after page setup changes. */
export async function refreshPageBreakData(): Promise<void> {
  try {
    cachedPageSetup = await getPageSetup();
    console.log("[PageBreakOverlay] Page setup loaded:", cachedPageSetup);
  } catch (err) {
    console.error("[PageBreakOverlay] Failed to load page setup:", err);
    cachedPageSetup = null;
  }
}

/**
 * Post-header overlay renderer that draws page break lines and print area shading.
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
  if (!pageBreakPreviewEnabled || !cachedPageSetup) {
    if (pageBreakPreviewEnabled) {
      console.log("[PageBreakOverlay] Render skipped: cachedPageSetup is null");
    }
    return;
  }

  console.log("[PageBreakOverlay] Rendering with page setup, viewport:", viewport.startRow, viewport.startCol);

  // Cache render params for mouse handlers
  lastConfig = config;
  lastViewport = viewport;
  lastDimensions = dimensions;
  lastCanvasWidth = canvasWidth;
  lastCanvasHeight = canvasHeight;

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const defaultColWidth = config.defaultColumnWidth || 100;
  const defaultRowHeight = config.defaultRowHeight || 24;

  const getColW = createDimensionGetterFromMap(defaultColWidth, dimensions.columnWidths);
  const getRowH = createDimensionGetterFromMap(defaultRowHeight, dimensions.rowHeights);

  // Determine grid bounds (estimate from viewport)
  const maxRow = Math.max(viewport.startRow + viewport.rowCount + 50, cachedGridBoundsRow);
  const maxCol = Math.max(viewport.startCol + viewport.colCount + 20, cachedGridBoundsCol);
  cachedGridBoundsRow = maxRow;
  cachedGridBoundsCol = maxCol;

  // Compute breaks
  const { rowBreaks, colBreaks } = computeBreakPositions(
    cachedPageSetup, maxRow, maxCol, getColW, getRowH,
  );

  computedRowBreaks = rowBreaks;
  computedColBreaks = colBreaks;

  console.log("[PageBreakOverlay] Computed breaks - rows:", rowBreaks, "cols:", colBreaks,
    "maxRow:", maxRow, "maxCol:", maxCol,
    "colW sample:", getColW(0), getColW(1), "rowH sample:", getRowH(0), getRowH(1),
    "canvasSize:", canvasWidth, "x", canvasHeight,
    "rowHeaderWidth:", rowHeaderWidth, "colHeaderHeight:", colHeaderHeight);

  const manualRowSet = new Set(cachedPageSetup.manualRowBreaks ?? []);
  const manualColSet = new Set(cachedPageSetup.manualColBreaks ?? []);

  ctx.save();

  // Draw print area boundary (shaded region outside print area)
  const printArea = parsePrintArea(cachedPageSetup.printArea);
  if (printArea) {
    const paLeft = calculateColumnX(printArea.startCol, rowHeaderWidth, viewport.scrollX, getColW);
    const paRight = calculateColumnX(printArea.endCol + 1, rowHeaderWidth, viewport.scrollX, getColW);
    const paTop = calculateRowY(printArea.startRow, colHeaderHeight, viewport.scrollY, getRowH);
    const paBottom = calculateRowY(printArea.endRow + 1, colHeaderHeight, viewport.scrollY, getRowH);

    ctx.fillStyle = "rgba(128, 128, 128, 0.15)";

    // Top region (above print area)
    if (paTop > colHeaderHeight) {
      ctx.fillRect(rowHeaderWidth, colHeaderHeight, canvasWidth - rowHeaderWidth, paTop - colHeaderHeight);
    }
    // Bottom region (below print area)
    if (paBottom < canvasHeight) {
      ctx.fillRect(rowHeaderWidth, paBottom, canvasWidth - rowHeaderWidth, canvasHeight - paBottom);
    }
    // Left region (left of print area, between top and bottom)
    if (paLeft > rowHeaderWidth) {
      const regionTop = Math.max(paTop, colHeaderHeight);
      const regionBottom = Math.min(paBottom, canvasHeight);
      ctx.fillRect(rowHeaderWidth, regionTop, paLeft - rowHeaderWidth, regionBottom - regionTop);
    }
    // Right region (right of print area, between top and bottom)
    if (paRight < canvasWidth) {
      const regionTop = Math.max(paTop, colHeaderHeight);
      const regionBottom = Math.min(paBottom, canvasHeight);
      ctx.fillRect(paRight, regionTop, canvasWidth - paRight, regionBottom - regionTop);
    }

    // Draw print area border
    ctx.strokeStyle = "#0066cc";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(
      Math.max(paLeft, rowHeaderWidth),
      Math.max(paTop, colHeaderHeight),
      Math.min(paRight, canvasWidth) - Math.max(paLeft, rowHeaderWidth),
      Math.min(paBottom, canvasHeight) - Math.max(paTop, colHeaderHeight),
    );
  }

  // Draw title rows indicator (highlighted strip)
  if (cachedPageSetup.printTitlesRows) {
    const match = cachedPageSetup.printTitlesRows.match(/^(\d+):(\d+)$/);
    if (match) {
      const titleStartRow = parseInt(match[1]) - 1;
      const titleEndRow = parseInt(match[2]) - 1;
      const tTop = calculateRowY(titleStartRow, colHeaderHeight, viewport.scrollY, getRowH);
      const tBottom = calculateRowY(titleEndRow + 1, colHeaderHeight, viewport.scrollY, getRowH);
      if (tBottom > colHeaderHeight && tTop < canvasHeight) {
        ctx.fillStyle = "rgba(0, 120, 212, 0.08)";
        ctx.fillRect(
          rowHeaderWidth,
          Math.max(tTop, colHeaderHeight),
          canvasWidth - rowHeaderWidth,
          Math.min(tBottom, canvasHeight) - Math.max(tTop, colHeaderHeight),
        );
        // Draw dashed border for title rows
        ctx.strokeStyle = "#0078d4";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(
          rowHeaderWidth,
          Math.max(tTop, colHeaderHeight),
          canvasWidth - rowHeaderWidth,
          Math.min(tBottom, canvasHeight) - Math.max(tTop, colHeaderHeight),
        );
      }
    }
  }

  // Draw title columns indicator (highlighted strip)
  if (cachedPageSetup.printTitlesCols) {
    const match = cachedPageSetup.printTitlesCols.match(/^([A-Z]+):([A-Z]+)$/i);
    if (match) {
      const titleStartCol = colToIndex(match[1].toUpperCase());
      const titleEndCol = colToIndex(match[2].toUpperCase());
      const tLeft = calculateColumnX(titleStartCol, rowHeaderWidth, viewport.scrollX, getColW);
      const tRight = calculateColumnX(titleEndCol + 1, rowHeaderWidth, viewport.scrollX, getColW);
      if (tRight > rowHeaderWidth && tLeft < canvasWidth) {
        ctx.fillStyle = "rgba(0, 120, 212, 0.08)";
        ctx.fillRect(
          Math.max(tLeft, rowHeaderWidth),
          colHeaderHeight,
          Math.min(tRight, canvasWidth) - Math.max(tLeft, rowHeaderWidth),
          canvasHeight - colHeaderHeight,
        );
        // Draw dashed border for title columns
        ctx.strokeStyle = "#0078d4";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(
          Math.max(tLeft, rowHeaderWidth),
          colHeaderHeight,
          Math.min(tRight, canvasWidth) - Math.max(tLeft, rowHeaderWidth),
          canvasHeight - colHeaderHeight,
        );
      }
    }
  }

  // Draw horizontal page break lines (at row positions)
  for (const r of rowBreaks) {
    const isManual = manualRowSet.has(r);

    // If dragging this break, draw at drag position instead
    if (dragState && dragState.active && dragState.direction === "row" && dragState.fromIndex === r) {
      ctx.strokeStyle = "#cc3300";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(rowHeaderWidth, dragState.currentPixel);
      ctx.lineTo(canvasWidth, dragState.currentPixel);
      ctx.stroke();
      continue;
    }

    const y = calculateRowY(r, colHeaderHeight, viewport.scrollY, getRowH);
    if (y < colHeaderHeight || y > canvasHeight) continue;

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
    const isManual = manualColSet.has(c);

    // If dragging this break, draw at drag position instead
    if (dragState && dragState.active && dragState.direction === "col" && dragState.fromIndex === c) {
      ctx.strokeStyle = "#cc3300";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(dragState.currentPixel, colHeaderHeight);
      ctx.lineTo(dragState.currentPixel, canvasHeight);
      ctx.stroke();
      continue;
    }

    const x = calculateColumnX(c, rowHeaderWidth, viewport.scrollX, getColW);
    if (x < rowHeaderWidth || x > canvasWidth) continue;

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
