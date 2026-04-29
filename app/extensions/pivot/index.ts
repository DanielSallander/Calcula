//! FILENAME: app/extensions/pivot/index.ts
// PURPOSE: Pivot table extension entry point.
// CONTEXT: Registers all pivot functionality with the extension system.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  TaskPaneExtensions,
  OverlayExtensions,
  AppEvents,
  gridCommands,
  registerFormulaReferenceInterceptor,
  registerMenuItem,
  notifyMenusChanged,
  columnToLetter,
} from "@api";
import { emitAppEvent } from "@api/events";

import { PivotEvents } from "./lib/pivotEvents";
import type { PivotProgressEvent } from "./lib/pivotEvents";
import { listenTauriEvent } from "@api/backend";

import {
  addGridRegions,
  getGridRegions,
  removeGridRegionsByType,
  replaceGridRegionsByType,
  requestOverlayRedraw,
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnsWidth,
  overlayGetRowsHeight,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  type GridRegion,
  type OverlayRenderContext,
} from "@api/gridOverlays";

import {
  PivotManifest,
  PivotPaneDefinition,
  PivotDialogDefinition,
  PivotGroupDialogDefinition,
  PivotFieldSettingsDialogDefinition,
  PivotOptionsDialogDefinition,
  PivotFilterOverlayDefinition,
  PivotHeaderFilterOverlayDefinition,
  PIVOT_PANE_ID,
  PIVOT_DIALOG_ID,
  PIVOT_GROUP_DIALOG_ID,
  PIVOT_FILTER_OVERLAY_ID,
  PIVOT_HEADER_FILTER_OVERLAY_ID,
} from "./manifest";

import { handlePivotCreated } from "./handlers/pivotCreatedHandler";
import { handleOpenFilterMenu } from "./handlers/filterMenuHandler";
import { handleOpenHeaderFilterMenu } from "./handlers/headerFilterMenuHandler";
import { registerPivotContextMenuItems } from "./handlers/pivotContextMenu";
import {
  handleSelectionChange,
  updateCachedRegions,
  resetSelectionHandlerState,
  forceRecheck,
  getCachedRegions,
  findPivotRegionAtCell,
  shiftCachedRegionsForColInsert,
  shiftCachedRegionsForRowInsert,
  shiftCachedRegionsForColDelete,
  shiftCachedRegionsForRowDelete,
} from "./handlers/selectionHandler";
import type { PivotRegionData } from "./types";
import { getPivotRegionsForSheet, getPivotAtCell, getPivotDataFormula, getPivotView, togglePivotGroup, getPivotCellWindow, cancelPivotOperation, getAllPivotTables, refreshPivotCache, relocatePivot } from "./lib/pivot-api";
import type { PivotViewResponse } from "./lib/pivot-api";
import {
  cachePivotView,
  setCachedPivotView,
  getCachedPivotView,
  deleteCachedPivotView,
  isCacheFresh,
  consumeFreshFlag,
  getCellWindowCache,
  ensureCellWindow,
  isLoading,
  getLoadingState,
  setLoading,
  clearLoading,
  restorePreviousView,
  markUserCancelled,
} from "./lib/pivotViewStore";
import { drawPivotCell, DEFAULT_PIVOT_THEME, createPivotTheme } from "./rendering/pivot";
import type { PivotCellDrawResult, PivotTheme } from "./rendering/pivot";
import { getThemeOverridesForStyle, DEFAULT_PIVOT_STYLE_ID } from "./components/PivotTableStylesGallery";

// Re-export cache accessors so existing consumers (e.g., context menu) keep working
export { cachePivotView, getCachedPivotView };

// ============================================================================
// Per-Pivot Style Theme Tracking
// ============================================================================

/** Maps pivotId -> styleId (selected in the Design tab gallery). */
const pivotStyleMap = new Map<number, string>();

/** Maps styleId -> resolved PivotTheme (cached to avoid recomputing each frame). */
const resolvedThemeCache = new Map<string, PivotTheme>();

/** Get the PivotTheme for a given pivot, based on its selected style. */
function getThemeForPivot(pivotId: number): PivotTheme {
  const styleId = pivotStyleMap.get(pivotId) || DEFAULT_PIVOT_STYLE_ID;
  if (!styleId) return DEFAULT_PIVOT_THEME;

  let theme = resolvedThemeCache.get(styleId);
  if (!theme) {
    const overrides = getThemeOverridesForStyle(styleId);
    theme = createPivotTheme(overrides);
    resolvedThemeCache.set(styleId, theme);
  }
  return theme;
}

// ============================================================================
// Expand/Collapse Icon Bounds (populated during overlay rendering)
// ============================================================================

interface StoredIconBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  gridRow: number;
  gridCol: number;
  isExpanded: boolean;
  isRow: boolean;
  pivotId: number;
}

/** Map of icon bounds keyed by "pivotId-gridRow-gridCol", updated every render. */
const overlayIconBounds = new Map<string, StoredIconBounds>();

/** Extra pixels around icon bounds for easier click targeting (12px icon -> 20px hit area). */
const ICON_HIT_PADDING = 4;

interface StoredHeaderFilterBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  zone: 'row' | 'column';
  pivotId: number;
}

/** Map of header filter button bounds keyed by "pivotId-zone", updated every render. */
const overlayHeaderFilterBounds = new Map<string, StoredHeaderFilterBounds>();

interface StoredFilterDropdownBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  fieldIndex: number;
  pivotId: number;
  gridRow: number;
  gridCol: number;
}

/** Map of filter dropdown button bounds keyed by "pivotId-fieldIndex", updated every render. */
const overlayFilterDropdownBounds = new Map<string, StoredFilterDropdownBounds>();

/** Map of cancel button bounds keyed by pivotId, updated every render. */
const overlayCancelBounds = new Map<number, { x: number; y: number; width: number; height: number }>();

/** Clear all stored icon bounds (called at start of each render cycle). */
function clearOverlayIconBounds(): void {
  overlayIconBounds.clear();
  overlayHeaderFilterBounds.clear();
  overlayFilterDropdownBounds.clear();
  overlayCancelBounds.clear();
}

/** Cache of pivot region bounds keyed by pivotId, for coordinate conversion in click handlers. */
const gridRegionsCache = new Map<number, { startRow: number; startCol: number; endRow: number; endCol: number }>();

/** Cached reference to the grid canvas element, captured during overlay rendering. */
let cachedCanvasElement: HTMLCanvasElement | null = null;

/** Currently hovered filter dropdown field index (for hover highlight). -1 = none. */
let hoveredFilterFieldIndex = -1;

/**
 * Previous region bounds per pivotId, used during transitions.
 * When a pivot collapses, the overlay's white background is extended to cover
 * max(old, new) bounds so stale cells from the frontend cache aren't visible
 * while refreshCells() is still in flight.
 */
const transitionBounds = new Map<number, { endRow: number; endCol: number }>();
let transitionCleanupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-entry guard for refreshPivotRegions.
 * When refreshPivotRegions(true) dispatches "grid:refresh", the pivot extension's
 * own grid:refresh listener would trigger another refreshPivotRegions(false) call.
 * This flag prevents that redundant second call from executing.
 */
let isRefreshingPivotRegions = false;

/**
 * Version counter for structural changes (row/column insert/delete).
 * Incremented on each sync shift. When refreshPivotRegions completes, it
 * checks whether the version has changed since it started. If so, the
 * fetched data may be stale (from before the structural change), so it
 * is discarded and the sync-shifted regions are preserved.
 */
let structuralVersion = 0;


/**
 * Fetch and cache pivot view data for all non-empty pivot regions.
 * Skips the IPC call if the cache already has data for the pivot (e.g., from
 * a preceding updatePivotFields or togglePivotGroup call that cached the result).
 */
async function refreshPivotViewCache(regions: PivotRegionData[], allowCachedHit = false): Promise<void> {
  for (const r of regions) {
    if (!r.isEmpty) {
      // Skip fetch if the cache was JUST populated by updatePivotFields
      // or togglePivotGroup in this same refresh cycle (fresh flag set).
      if (isCacheFresh(r.pivotId)) {
        const existing = getCachedPivotView(r.pivotId);
        consumeFreshFlag(r.pivotId);
        console.log(`[PERF][pivot] refreshPivotViewCache pivot_id=${r.pivotId} SKIPPED (fresh cache v${existing?.version})`);
        continue;
      }
      // On sheet switch, reuse existing cached view to avoid IPC delay.
      // The pivot data hasn't changed — we just navigated away and back.
      if (allowCachedHit) {
        const existing = getCachedPivotView(r.pivotId);
        if (existing) {
          console.log(`[PERF][pivot] refreshPivotViewCache pivot_id=${r.pivotId} REUSED (cached v${existing.version})`);
          continue;
        }
      }
      try {
        const view = await getPivotView(r.pivotId);
        setCachedPivotView(r.pivotId, view);
      } catch (e) {
        console.error(`[Pivot Extension] Failed to fetch view for pivot ${r.pivotId}:`, e);
      }
    } else {
      deleteCachedPivotView(r.pivotId);
    }
  }
}

// ============================================================================
// Pivot Placeholder Overlay Renderer
// ============================================================================

/**
 * Draw a white background over the pivot region to hide underlying grid lines.
 * Called for ALL pivot regions (both empty and populated).
 *
 * During transitions (collapse/expand), the white background is extended to cover
 * max(current, previous) bounds so stale cells aren't briefly visible.
 */
// drawPivotBackground removed — grid cells now have proper backgrounds from the backend.

// ============================================================================
// Loading Overlay
// ============================================================================

/** Draw a loading overlay on top of the (dimmed) previous pivot view. */
function drawLoadingOverlay(overlayCtx: OverlayRenderContext, pivotId: number): void {
  const loadingState = getLoadingState(pivotId);
  if (!loadingState) return;

  const { ctx, region } = overlayCtx;
  const startX = overlayGetColumnX(overlayCtx, region.startCol);
  const startY = overlayGetRowY(overlayCtx, region.startRow);
  const endY = overlayGetRowY(overlayCtx, region.endRow + 1);
  const width = overlayGetColumnsWidth(overlayCtx, region.startCol, region.endCol);
  const height = endY - startY;

  if (width <= 0 || height <= 0) return;

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    ctx.canvas.width / (window.devicePixelRatio || 1) - rowHeaderWidth,
    ctx.canvas.height / (window.devicePixelRatio || 1) - colHeaderHeight,
  );
  ctx.clip();

  // Semi-transparent overlay to dim the previous view
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.fillRect(startX, startY, width, height);

  // Indeterminate progress bar (3px, animated at top of pivot)
  const BAR_HEIGHT = 3;
  const elapsed = performance.now() - loadingState.startedAt;
  const barWidth = width * 0.3;
  const period = 1500; // ms for one full sweep
  const progress = (elapsed % period) / period;
  // Smooth ease-in-out using sine
  const eased = 0.5 - 0.5 * Math.cos(progress * Math.PI * 2);
  const barX = startX + (width - barWidth) * eased;

  ctx.fillStyle = "#5B9BD5";
  ctx.fillRect(barX, startY, barWidth, BAR_HEIGHT);

  // Build stage text with step indicator, e.g. "Calculating... (2/4)"
  const { stage, stageIndex, totalStages } = loadingState;
  const stepText = totalStages > 0
    ? `${stage} (${stageIndex + 1}/${totalStages})`
    : stage;

  // Position text and cancel button just below the progress bar (fixed at top)
  const textY = startY + BAR_HEIGHT + 16;
  const centerX = startX + width / 2;

  ctx.fillStyle = "#555555";
  ctx.font = "13px Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(stepText, centerX, textY);

  // Cancel button (shown after 1s to avoid flicker for fast operations)
  if (elapsed > 1000) {
    const btnWidth = 70;
    const btnHeight = 24;
    const btnX = centerX - btnWidth / 2;
    const btnY = textY + 14;

    // Button background
    ctx.fillStyle = "#e5e7eb";
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnWidth, btnHeight, 4);
    ctx.fill();
    ctx.stroke();

    // Button text
    ctx.fillStyle = "#374151";
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Cancel", btnX + btnWidth / 2, btnY + btnHeight / 2);

    // Store bounds for click handler
    overlayCancelBounds.set(pivotId, { x: btnX, y: btnY, width: btnWidth, height: btnHeight });
  }

  ctx.restore();

  // Schedule next animation frame to keep the bar moving
  requestAnimationFrame(() => {
    if (isLoading(pivotId)) {
      requestOverlayRedraw();
    }
  });
}

/**
 * Draw styled pivot cells for a non-empty pivot region.
 * This renders the pivot data with Excel-like styling (no grid lines,
 * banded rows, bold headers, hierarchy indentation, expand/collapse icons).
 */
function drawStyledPivotView(overlayCtx: OverlayRenderContext, pivotView: PivotViewResponse): void {
  const t0 = performance.now();
  const { ctx, region } = overlayCtx;
  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);
  const canvasWidth = ctx.canvas.width / (window.devicePixelRatio || 1);
  const canvasHeight = ctx.canvas.height / (window.devicePixelRatio || 1);

  const pivotId = (region.data?.pivotId as number) ?? 0;
  const theme = getThemeForPivot(pivotId);

  // Pre-compute whether each zone has active filters (for header filter icon)
  const rowHasActiveFilter = pivotView.rowFieldSummaries?.some(f => f.hasActiveFilter) ?? false;
  const colHasActiveFilter = pivotView.columnFieldSummaries?.some(f => f.hasActiveFilter) ?? false;

  // ---------------------------------------------------------------------------
  // WINDOWED MODE SUPPORT
  // For large pivots, the response contains rowDescriptors (lightweight, all rows)
  // plus cells for only the first window. Additional cells are fetched on scroll.
  // ---------------------------------------------------------------------------
  const isWindowed = pivotView.isWindowed === true;
  const cellCache = isWindowed ? getCellWindowCache(pivotId) : undefined;

  // ---------------------------------------------------------------------------
  // PERF FIX: Pre-compute column X positions and widths (columns are few).
  // This avoids calling overlayGetColumnX per cell which loops from col 0 each time.
  // ---------------------------------------------------------------------------
  const numCols = isWindowed
    ? (pivotView.colCount ?? pivotView.rows[0]?.cells.length ?? 0)
    : (pivotView.rows[0]?.cells.length ?? 0);
  const colXPositions: number[] = new Array(numCols);
  const colWidthValues: number[] = new Array(numCols);
  for (let j = 0; j < numCols; j++) {
    const gridCol = region.startCol + j;
    colXPositions[j] = overlayGetColumnX(overlayCtx, gridCol);
    colWidthValues[j] = overlayGetColumnWidth(overlayCtx, gridCol);
  }

  // ---------------------------------------------------------------------------
  // PERF FIX: Compute row Y positions incrementally instead of O(row) per cell.
  // overlayGetRowY loops from row 0 to the target row each time - with 19000 rows
  // and 46 visible cells that's 874,000 iterations. Instead, compute Y for the
  // first row once (O(startRow)), then accumulate heights: O(totalRows) total.
  // ---------------------------------------------------------------------------
  const numRows = isWindowed
    ? (pivotView.totalRowCount ?? pivotView.rows.length)
    : pivotView.rows.length;
  const rowYPositions: number[] = new Array(numRows);
  const rowHeightValues: number[] = new Array(numRows);
  let runningY = overlayGetRowY(overlayCtx, region.startRow);
  for (let i = 0; i < numRows; i++) {
    const gridRow = region.startRow + i;
    const h = overlayGetRowHeight(overlayCtx, gridRow);
    rowYPositions[i] = runningY;
    rowHeightValues[i] = h;
    runningY += h;
  }
  // runningY now equals the Y position just past the last row (used for separator lines)
  const regionEndY = runningY;
  const regionStartY = rowYPositions[0] ?? 0;

  const tPrecompute = performance.now() - t0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    canvasWidth - rowHeaderWidth,
    canvasHeight - colHeaderHeight,
  );
  ctx.clip();

  let cellsDrawn = 0;
  let cellsSkipped = 0;
  let firstMissingRow = -1;
  let lastMissingRow = -1;

  for (let i = 0; i < numRows; i++) {
    // For windowed mode, use row descriptors for visibility; for non-windowed, use rows directly
    const isVisible = isWindowed
      ? (pivotView.rowDescriptors?.[i]?.visible ?? true)
      : (pivotView.rows[i]?.visible ?? true);
    if (!isVisible) continue;

    const gridRow = region.startRow + i;
    const y = rowYPositions[i];
    const height = rowHeightValues[i];

    // Skip rows completely outside visible area
    if (y + height < colHeaderHeight) continue;
    if (y > canvasHeight) break; // Rows are sequential, no more visible rows after this

    // Get the row data: from cell cache (windowed) or directly from response
    const row = isWindowed
      ? (cellCache?.getRow(i) ?? null)
      : (pivotView.rows[i] ?? null);

    if (!row || !row.cells) {
      // Windowed: cells not yet loaded — draw placeholder background
      if (isWindowed) {
        if (firstMissingRow < 0) firstMissingRow = i;
        lastMissingRow = i;
        for (let j = 0; j < numCols; j++) {
          const x = colXPositions[j];
          const width = colWidthValues[j];
          if (x + width < rowHeaderWidth || x > canvasWidth) continue;
          ctx.fillStyle = '#f8f8f8';
          ctx.fillRect(x, y, width, height);
        }
      }
      continue;
    }

    // Collect FilterDropdown cells to draw them last (on top of neighboring cells)
    const deferredFilterDropdowns: Array<{
      cell: typeof row.cells[0]; x: number; y: number; width: number; height: number;
      i: number; j: number; gridRow: number; gridCol: number;
    }> = [];

    for (let j = 0; j < row.cells.length; j++) {
      const cell = row.cells[j];
      const gridCol = region.startCol + j;
      const x = colXPositions[j];
      // Support colSpan: sum widths of spanned columns (e.g., FilterDropdown spanning row label cols)
      const span = cell.colSpan && cell.colSpan > 1 ? cell.colSpan : 1;
      let width = colWidthValues[j];
      for (let s = 1; s < span && j + s < colWidthValues.length; s++) {
        width += colWidthValues[j + s];
      }

      // Skip cells completely outside visible area
      if (x + width < rowHeaderWidth || x > canvasWidth) { cellsSkipped++; continue; }

      // Defer FilterDropdown cells to draw them on top of neighboring cells
      if (cell.cellType === 'FilterDropdown') {
        deferredFilterDropdowns.push({ cell, x, y, width, height, i, j, gridRow, gridCol });
        continue;
      }

      cellsDrawn++;
      // Determine active filter state for header filter cells
      const cellHasActiveFilter =
        cell.cellType === 'RowLabelHeader' ? rowHasActiveFilter :
        cell.cellType === 'ColumnLabelHeader' ? colHasActiveFilter :
        false;

      const cellResult: PivotCellDrawResult = drawPivotCell(ctx, cell, x, y, width, height, i, j, theme, {
        hasActiveFilter: cellHasActiveFilter,
      });

      // Store expand/collapse icon bounds for click handling
      if (cellResult.iconBounds) {
        const key = `${pivotId}-${gridRow}-${gridCol}`;
        overlayIconBounds.set(key, {
          x: cellResult.iconBounds.x,
          y: cellResult.iconBounds.y,
          width: cellResult.iconBounds.width,
          height: cellResult.iconBounds.height,
          gridRow,
          gridCol,
          isExpanded: cellResult.iconBounds.isExpanded,
          isRow: cellResult.iconBounds.isRow,
          pivotId,
        });
      }

      // Store filter dropdown button bounds for click handling
      if (cellResult.filterButtonBounds) {
        const fdKey = `${pivotId}-${cellResult.filterButtonBounds.fieldIndex}`;
        overlayFilterDropdownBounds.set(fdKey, {
          x: cellResult.filterButtonBounds.x,
          y: cellResult.filterButtonBounds.y,
          width: cellResult.filterButtonBounds.width,
          height: cellResult.filterButtonBounds.height,
          fieldIndex: cellResult.filterButtonBounds.fieldIndex,
          pivotId,
          gridRow: gridRow,
          gridCol: gridCol,
        });
      }

      // Store header filter button bounds for click handling
      if (cellResult.headerFilterBounds) {
        const hfKey = `${pivotId}-${cellResult.headerFilterBounds.zone}`;
        overlayHeaderFilterBounds.set(hfKey, {
          x: cellResult.headerFilterBounds.x,
          y: cellResult.headerFilterBounds.y,
          width: cellResult.headerFilterBounds.width,
          height: cellResult.headerFilterBounds.height,
          zone: cellResult.headerFilterBounds.zone,
          pivotId,
        });
      }
    }

    // Draw deferred FilterDropdown cells on top of neighboring cells
    for (const fd of deferredFilterDropdowns) {
      cellsDrawn++;
      const fdFieldIndex = fd.cell.filterFieldIndex ?? -1;
      const isHoveredFd = fdFieldIndex === hoveredFilterFieldIndex;
      // Check if this filter field has active filtering (hidden items)
      const filterRowMeta = pivotView.filterRows?.find(
        (fr) => fr.fieldIndex === fdFieldIndex
      );
      const hasActiveFdFilter = filterRowMeta
        ? filterRowMeta.selectedValues.length < filterRowMeta.uniqueValues.length
        : false;
      const cellResult: PivotCellDrawResult = drawPivotCell(ctx, fd.cell, fd.x, fd.y, fd.width, fd.height, fd.i, fd.j, theme, {
        isHoveredFilterButton: isHoveredFd,
        hasActiveFilterDropdown: hasActiveFdFilter,
      });
      if (cellResult.filterButtonBounds) {
        const fdKey = `${pivotId}-${cellResult.filterButtonBounds.fieldIndex}`;
        overlayFilterDropdownBounds.set(fdKey, {
          x: cellResult.filterButtonBounds.x,
          y: cellResult.filterButtonBounds.y,
          width: cellResult.filterButtonBounds.width,
          height: cellResult.filterButtonBounds.height,
          fieldIndex: cellResult.filterButtonBounds.fieldIndex,
          pivotId,
          gridRow: fd.gridRow,
          gridCol: fd.gridCol,
        });
      }
    }
  }

  // Trigger async fetch for missing rows in windowed mode
  if (isWindowed && firstMissingRow >= 0) {
    const version = pivotView.version;
    ensureCellWindow(
      pivotId,
      version,
      firstMissingRow,
      lastMissingRow - firstMissingRow + 1,
      getPivotCellWindow,
      () => requestOverlayRedraw()
    );
  }

  // Draw separator line between row labels and data columns
  const rowLabelColCount = pivotView.rowLabelColCount || 0;
  if (rowLabelColCount > 0) {
    const sepX = colXPositions[rowLabelColCount] ?? overlayGetColumnX(overlayCtx, region.startCol + rowLabelColCount);
    if (sepX > rowHeaderWidth && sepX < canvasWidth) {
      ctx.strokeStyle = theme.borderColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.floor(sepX) + 0.5, Math.max(regionStartY, colHeaderHeight));
      ctx.lineTo(Math.floor(sepX) + 0.5, Math.min(regionEndY, canvasHeight));
      ctx.stroke();
    }
  }

  // Draw separator line below header rows
  const headerRowCount = pivotView.columnHeaderRowCount || 0;
  if (headerRowCount > 0 && headerRowCount < numRows) {
    const sepY = rowYPositions[headerRowCount];
    if (sepY > colHeaderHeight && sepY < canvasHeight) {
      ctx.strokeStyle = theme.headerBorderColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const regionX = colXPositions[0] ?? 0;
      const regionEndX = colXPositions[numCols - 1] !== undefined
        ? colXPositions[numCols - 1] + colWidthValues[numCols - 1]
        : overlayGetColumnX(overlayCtx, region.startCol + numCols);
      ctx.moveTo(Math.max(regionX, rowHeaderWidth), Math.floor(sepY) - 0.5);
      ctx.lineTo(Math.min(regionEndX, canvasWidth), Math.floor(sepY) - 0.5);
      ctx.stroke();
    }
  }

  ctx.restore();

  const drawMs = performance.now() - t0;
  console.log(
    `[PERF][pivot] drawStyledPivotView rows=${numRows} cols=${numCols} | drawn=${cellsDrawn} skipped=${cellsSkipped} | precompute=${tPrecompute.toFixed(1)}ms render=${drawMs.toFixed(1)}ms`
  );
}

/**
 * Draw placeholder text for empty pivot regions.
 * Shows the pivot table name in a bordered box at the top
 * and "Click in this area to work with the PivotTable report" centered.
 */
function drawPivotPlaceholderText(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  const startX = overlayGetColumnX(overlayCtx, region.startCol);
  const startY = overlayGetRowY(overlayCtx, region.startRow);
  const regionWidth = overlayGetColumnsWidth(overlayCtx, region.startCol, region.endCol);
  const regionHeight = overlayGetRowsHeight(overlayCtx, region.startRow, region.endRow);

  if (startX + regionWidth < rowHeaderWidth || startY + regionHeight < colHeaderHeight) {
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    ctx.canvas.width / (window.devicePixelRatio || 1) - rowHeaderWidth,
    ctx.canvas.height / (window.devicePixelRatio || 1) - colHeaderHeight,
  );
  ctx.clip();

  // Draw pivot name box at top center of region
  const pivotName = (region.data?.name as string) || "PivotTable";
  const nameBoxPadding = 8;
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  const nameWidth = ctx.measureText(pivotName).width;
  const nameBoxWidth = nameWidth + nameBoxPadding * 2;
  const nameBoxHeight = 24;
  const nameBoxX = startX + (regionWidth - nameBoxWidth) / 2;
  const nameBoxY = startY + 10;

  // Name box background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(nameBoxX, nameBoxY, nameBoxWidth, nameBoxHeight);
  // Name box border
  ctx.strokeStyle = "#b0b0b0";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(
    Math.floor(nameBoxX) + 0.5,
    Math.floor(nameBoxY) + 0.5,
    nameBoxWidth,
    nameBoxHeight,
  );
  // Name text
  ctx.fillStyle = "#333333";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(pivotName, nameBoxX + nameBoxWidth / 2, nameBoxY + nameBoxHeight / 2);

  // Draw centered instruction text below the name box
  const centerX = startX + regionWidth / 2;
  const centerY = startY + regionHeight / 2 + 10;

  if (regionWidth > 120 && regionHeight > 60) {
    ctx.fillStyle = "#888888";
    ctx.font = "12px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Click in this area to work with", centerX, centerY - 8);
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("the PivotTable report", centerX, centerY + 8);
  }

  ctx.restore();
}


// ============================================================================
// Pivot Region Management
// ============================================================================

/**
 * Fetch pivot regions from the backend and register them with the overlay system.
 * Also dispatches the PIVOT_REGIONS_UPDATED event for other components.
 */
async function refreshPivotRegions(triggerRepaint: boolean = false, allowCachedHit = false): Promise<void> {
  // Re-entry guard: when we dispatch "grid:refresh" below, the pivot extension's
  // own grid:refresh listener would call us again. Skip that redundant call.
  if (isRefreshingPivotRegions) return;
  isRefreshingPivotRegions = true;

  // Capture the structural version at the START of this refresh.
  // If a structural change (row/col insert/delete) happens while we are
  // awaiting IPC, the version will increment and our fetched data is stale.
  const versionAtStart = structuralVersion;

  const tTotal = performance.now();
  try {
    const t0 = performance.now();
    const regions = await getPivotRegionsForSheet();
    const regionsMs = performance.now() - t0;

    // If a structural change occurred while we were fetching, our region
    // data may be from before the shift.  Discard it — the sync shift
    // already placed the overlay at the correct position.
    if (structuralVersion !== versionAtStart) {
      console.log(
        `[pivot] refreshPivotRegions: discarding stale result (version ${versionAtStart} -> ${structuralVersion})`
      );
      return;
    }

    // Fetch and cache pivot view data for styled rendering
    const t1 = performance.now();
    await refreshPivotViewCache(regions, allowCachedHit);
    const cacheMs = performance.now() - t1;

    // Second staleness check after view cache refresh
    if (structuralVersion !== versionAtStart) {
      console.log(
        `[pivot] refreshPivotRegions: discarding stale result after view cache (version ${versionAtStart} -> ${structuralVersion})`
      );
      return;
    }

    // Save current region bounds as transition bounds before updating.
    // This allows the overlay renderer to draw a white background over the
    // max(old, new) area, preventing stale cells from briefly showing through.
    if (triggerRepaint) {
      for (const [pivotId, bounds] of gridRegionsCache.entries()) {
        transitionBounds.set(pivotId, { endRow: bounds.endRow, endCol: bounds.endCol });
      }
    }

    // Update grid regions cache for coordinate conversion in click handlers
    gridRegionsCache.clear();
    for (const r of regions) {
      gridRegionsCache.set(r.pivotId, {
        startRow: r.startRow,
        startCol: r.startCol,
        endRow: r.endRow,
        endCol: r.endCol,
      });
    }

    const gridRegions: GridRegion[] = regions.map((r: PivotRegionData) => ({
      id: `pivot-${r.pivotId}`,
      type: "pivot",
      startRow: r.startRow,
      startCol: r.startCol,
      endRow: r.endRow,
      endCol: r.endCol,
      data: { isEmpty: r.isEmpty, pivotId: r.pivotId, name: r.name },
    }));

    // Atomically replace pivot regions and always notify listeners so the overlay
    // redraws immediately with the freshly-cached pivotViewCache data.
    // The transition bounds mechanism covers the old (larger) region area with a
    // white fill, so stale cells underneath are hidden even before refreshCells()
    // completes from the grid:refresh below.
    replaceGridRegionsByType("pivot", gridRegions);

    // Notify other components (selection handler, etc.)
    emitAppEvent(PivotEvents.PIVOT_REGIONS_UPDATED, { regions });

    // Trigger a full grid refresh (cell data re-fetch + redraw) when pivot regions change.
    // This is needed because when a pivot table collapses/expands, cells outside the new
    // region need to be cleared from the canvas cell cache. The window "grid:refresh" event
    // triggers refreshCells() in GridCanvas, unlike AppEvents.GRID_REFRESH which only redraws.
    if (triggerRepaint) {
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      // Refresh styles so the frontend picks up new pivot cell styles from the backend
      window.dispatchEvent(new CustomEvent("styles:refresh"));
      // Also refresh column/row dimensions so auto-fit widths take effect
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));

      // Clear transition bounds after a short delay, giving refreshCells() time to
      // complete so the stale cells are gone before we stop extending the white fill.
      if (transitionCleanupTimer) clearTimeout(transitionCleanupTimer);
      transitionCleanupTimer = setTimeout(() => {
        transitionBounds.clear();
        transitionCleanupTimer = null;
        requestOverlayRedraw();
      }, 150);
    }

    const totalMs = performance.now() - tTotal;
    console.log(
      `[PERF][pivot] refreshPivotRegions repaint=${triggerRepaint} regions=${regions.length} | getRegions=${regionsMs.toFixed(1)}ms viewCache=${cacheMs.toFixed(1)}ms TOTAL=${totalMs.toFixed(1)}ms`
    );
  } catch (error) {
    console.error("[Pivot Extension] Failed to fetch pivot regions:", error);
    removeGridRegionsByType("pivot");
    emitAppEvent(PivotEvents.PIVOT_REGIONS_UPDATED, { regions: [] });
  } finally {
    isRefreshingPivotRegions = false;
  }
}

// ============================================================================
// Synchronous region shifting for structural changes
// ============================================================================
// When rows/columns are inserted or deleted, we shift the overlay regions
// synchronously (no IPC) so the pivot renders at the correct position
// immediately. The subsequent async refreshPivotRegions() confirms the
// exact bounds from the backend.

function shiftPivotRegionsForColInsert(col: number, count: number): void {
  structuralVersion++;
  const pivotRegions = getGridRegions().filter((r) => r.type === "pivot");
  const shifted = pivotRegions.map((r) => {
    if (r.startCol >= col) {
      return { ...r, startCol: r.startCol + count, endCol: r.endCol + count };
    } else if (r.endCol >= col) {
      return { ...r, endCol: r.endCol + count };
    }
    return r;
  });
  replaceGridRegionsByType("pivot", shifted);
  for (const [, bounds] of gridRegionsCache.entries()) {
    if (bounds.startCol >= col) {
      bounds.startCol += count;
      bounds.endCol += count;
    } else if (bounds.endCol >= col) {
      bounds.endCol += count;
    }
  }
}

function shiftPivotRegionsForRowInsert(row: number, count: number): void {
  structuralVersion++;
  const pivotRegions = getGridRegions().filter((r) => r.type === "pivot");
  const shifted = pivotRegions.map((r) => {
    if (r.startRow >= row) {
      return { ...r, startRow: r.startRow + count, endRow: r.endRow + count };
    } else if (r.endRow >= row) {
      return { ...r, endRow: r.endRow + count };
    }
    return r;
  });
  replaceGridRegionsByType("pivot", shifted);
  for (const [, bounds] of gridRegionsCache.entries()) {
    if (bounds.startRow >= row) {
      bounds.startRow += count;
      bounds.endRow += count;
    } else if (bounds.endRow >= row) {
      bounds.endRow += count;
    }
  }
}

function shiftPivotRegionsForColDelete(col: number, count: number): void {
  structuralVersion++;
  const pivotRegions = getGridRegions().filter((r) => r.type === "pivot");
  const shifted: GridRegion[] = [];
  for (const r of pivotRegions) {
    if (r.startCol >= col + count) {
      shifted.push({ ...r, startCol: r.startCol - count, endCol: r.endCol - count });
    } else if (r.startCol >= col) {
      // Region starts within deleted range — shift start to col, shrink
      shifted.push({ ...r, startCol: col, endCol: Math.max(col, r.endCol - count) });
    } else if (r.endCol >= col + count) {
      shifted.push({ ...r, endCol: r.endCol - count });
    } else if (r.endCol >= col) {
      shifted.push({ ...r, endCol: col - 1 });
    } else {
      shifted.push(r);
    }
  }
  replaceGridRegionsByType("pivot", shifted);
  gridRegionsCache.clear();
  for (const r of shifted) {
    const pivotId = Number(r.id.replace("pivot-", ""));
    if (!isNaN(pivotId)) {
      gridRegionsCache.set(pivotId, {
        startRow: r.startRow,
        startCol: r.startCol,
        endRow: r.endRow,
        endCol: r.endCol,
      });
    }
  }
}

function shiftPivotRegionsForRowDelete(row: number, count: number): void {
  structuralVersion++;
  const pivotRegions = getGridRegions().filter((r) => r.type === "pivot");
  const shifted: GridRegion[] = [];
  for (const r of pivotRegions) {
    if (r.startRow >= row + count) {
      shifted.push({ ...r, startRow: r.startRow - count, endRow: r.endRow - count });
    } else if (r.startRow >= row) {
      shifted.push({ ...r, startRow: row, endRow: Math.max(row, r.endRow - count) });
    } else if (r.endRow >= row + count) {
      shifted.push({ ...r, endRow: r.endRow - count });
    } else if (r.endRow >= row) {
      shifted.push({ ...r, endRow: row - 1 });
    } else {
      shifted.push(r);
    }
  }
  replaceGridRegionsByType("pivot", shifted);
  gridRegionsCache.clear();
  for (const r of shifted) {
    const pivotId = Number(r.id.replace("pivot-", ""));
    if (!isNaN(pivotId)) {
      gridRegionsCache.set(pivotId, {
        startRow: r.startRow,
        startCol: r.startCol,
        endRow: r.endRow,
        endCol: r.endCol,
      });
    }
  }
}

// Cleanup functions for event listeners
let cleanupFunctions: Array<() => void> = [];

import { isGenerateGetPivotDataEnabled, setGenerateGetPivotData } from "./lib/getPivotDataToggle";
import { getLocaleSettings } from "@api/locale";

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[Pivot Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(PivotManifest);

  // Register task pane view
  context.ui.taskPanes.register(PivotPaneDefinition);

  // Register dialogs
  context.ui.dialogs.register(PivotDialogDefinition);
  context.ui.dialogs.register(PivotGroupDialogDefinition);
  context.ui.dialogs.register(PivotFieldSettingsDialogDefinition);
  context.ui.dialogs.register(PivotOptionsDialogDefinition);

  // Register context menu items for right-click in pivot regions
  cleanupFunctions.push(registerPivotContextMenuItems());

  // Register overlays
  context.ui.overlays.register(PivotFilterOverlayDefinition);
  context.ui.overlays.register(PivotHeaderFilterOverlayDefinition);

  // Register edit guard - block editing in pivot regions (synchronous using cached regions)
  cleanupFunctions.push(
    context.grid.editGuards.register(async (row, col) => {
      const region = findPivotRegionAtCell(row, col);
      if (region) {
        return { blocked: true, message: "You can't change this part of the PivotTable." };
      }
      return null;
    })
  );

  // Register formula reference interceptor for GETPIVOTDATA generation
  cleanupFunctions.push(
    registerFormulaReferenceInterceptor(async (row, col) => {
      if (!isGenerateGetPivotDataEnabled()) return null;

      // Quick check: is this cell in a cached pivot region?
      const region = findPivotRegionAtCell(row, col);
      if (!region) return null;

      // Ask the backend for the GETPIVOTDATA formula arguments
      const result = await getPivotDataFormula(row, col);
      if (!result) return null;

      // Build the GETPIVOTDATA formula text using locale-aware separator.
      // The editing pipeline will delocalize the formula before storing it,
      // so we must use the locale's list separator (e.g., ";" for Swedish).
      const locale = await getLocaleSettings();
      const sep = locale.listSeparator;
      const cellRef = "$" + columnToLetter(col) + "$" + (row + 1);
      let formula = `GETPIVOTDATA("${result.dataField}"${sep}${cellRef}`;
      for (const [fieldName, itemValue] of result.fieldItemPairs) {
        formula += `${sep}"${fieldName}"${sep}"${itemValue}"`;
      }
      formula += ")";

      return {
        text: formula,
        highlightRow: row,
        highlightCol: col,
      };
    })
  );

  // Register "Generate GetPivotData" toggle in the Formulas menu
  registerMenuItem("formulas", {
    id: "pivot.generateGetPivotData",
    label: "Generate GetPivotData",
    get checked() { return isGenerateGetPivotDataEnabled(); },
    action: () => {
      setGenerateGetPivotData(!isGenerateGetPivotDataEnabled());
      notifyMenusChanged();
    },
  });

  // Register structural command guards - block insert/delete that would affect pivot regions
  const pivotStructuralGuardMessage = "We can't make this change for the selected cells because it will affect a PivotTable. Use the field list to change the report. If you are trying to insert or delete cells, move the PivotTable and try again.";

  // Insert row: only block if the insertion point is strictly inside the pivot
  // (inserting at startRow shifts the whole pivot down — that's safe)
  cleanupFunctions.push(
    gridCommands.registerGuard(["insertRow"], (selection) => {
      if (!selection) return true;
      const regions = getCachedRegions();
      if (regions.length === 0) return true;

      const minRow = Math.min(selection.startRow, selection.endRow);
      const maxRow = Math.max(selection.startRow, selection.endRow);

      for (const region of regions) {
        // Block if any part of the selection is strictly inside the pivot range
        if (minRow <= region.endRow && maxRow > region.startRow) {
          return pivotStructuralGuardMessage;
        }
      }
      return true;
    })
  );

  // Delete row: block any overlap with the pivot region (deleting any pivot row is destructive)
  cleanupFunctions.push(
    gridCommands.registerGuard(["deleteRow"], (selection) => {
      if (!selection) return true;
      const regions = getCachedRegions();
      if (regions.length === 0) return true;

      const minRow = Math.min(selection.startRow, selection.endRow);
      const maxRow = Math.max(selection.startRow, selection.endRow);

      for (const region of regions) {
        if (minRow <= region.endRow && maxRow >= region.startRow) {
          return pivotStructuralGuardMessage;
        }
      }
      return true;
    })
  );

  // Insert column: only block if the insertion point is strictly inside the pivot
  // (inserting at startCol shifts the whole pivot right — that's safe)
  cleanupFunctions.push(
    gridCommands.registerGuard(["insertColumn"], (selection) => {
      if (!selection) return true;
      const regions = getCachedRegions();
      if (regions.length === 0) return true;

      const minCol = Math.min(selection.startCol, selection.endCol);
      const maxCol = Math.max(selection.startCol, selection.endCol);

      for (const region of regions) {
        // Block if any part of the selection is strictly inside the pivot range
        if (minCol <= region.endCol && maxCol > region.startCol) {
          return pivotStructuralGuardMessage;
        }
      }
      return true;
    })
  );

  // Delete column: block any overlap with the pivot region (deleting any pivot column is destructive)
  cleanupFunctions.push(
    gridCommands.registerGuard(["deleteColumn"], (selection) => {
      if (!selection) return true;
      const regions = getCachedRegions();
      if (regions.length === 0) return true;

      const minCol = Math.min(selection.startCol, selection.endCol);
      const maxCol = Math.max(selection.startCol, selection.endCol);

      for (const region of regions) {
        if (minCol <= region.endCol && maxCol >= region.startCol) {
          return pivotStructuralGuardMessage;
        }
      }
      return true;
    })
  );

  // Register range guard - block operations that PARTIALLY overlap pivot regions.
  // Full containment is allowed (e.g., selecting the entire pivot and moving it).
  cleanupFunctions.push(
    context.grid.rangeGuards.register((startRow, startCol, endRow, endCol) => {
      const regions = getCachedRegions();
      for (const region of regions) {
        const rowOverlap = startRow <= region.endRow && endRow >= region.startRow;
        const colOverlap = startCol <= region.endCol && endCol >= region.startCol;
        if (rowOverlap && colOverlap) {
          // Allow if the range fully contains the pivot region (enables move)
          const fullyContained =
            startRow <= region.startRow && endRow >= region.endRow &&
            startCol <= region.startCol && endCol >= region.endCol;
          if (!fullyContained) {
            return { blocked: true, message: pivotStructuralGuardMessage };
          }
        }
      }
      return null;
    })
  );

  // Register click interceptor - handle cancel button clicks during loading
  cleanupFunctions.push(
    context.grid.cellClicks.registerClickInterceptor(async (_row, _col, event) => {
      if (!cachedCanvasElement || overlayCancelBounds.size === 0) return false;

      const rect = cachedCanvasElement.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;

      for (const [pivotId, bounds] of overlayCancelBounds.entries()) {
        if (
          canvasX >= bounds.x &&
          canvasX <= bounds.x + bounds.width &&
          canvasY >= bounds.y &&
          canvasY <= bounds.y + bounds.height
        ) {
          // Immediately restore previous view on the frontend (instant feedback)
          // Mark as user-cancelled so the in-flight result is suppressed
          markUserCancelled(pivotId);
          clearLoading(pivotId);
          restorePreviousView(pivotId);
          overlayCancelBounds.delete(pivotId);
          requestOverlayRedraw();

          // Also tell the backend to cancel (best-effort, may arrive too late)
          cancelPivotOperation(pivotId).catch((err) => {
            console.warn("[Pivot Extension] Cancel failed:", err);
          });
          return true;
        }
      }
      return false;
    })
  );

  // Register click interceptor - handle expand/collapse icon clicks
  cleanupFunctions.push(
    context.grid.cellClicks.registerClickInterceptor(async (row, col, event) => {
      // Check if click is within any stored expand/collapse icon bounds
      if (!cachedCanvasElement) return false;
      const canvas = cachedCanvasElement;

      const rect = canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;

      for (const bounds of overlayIconBounds.values()) {
        if (
          canvasX >= bounds.x - ICON_HIT_PADDING &&
          canvasX <= bounds.x + bounds.width + ICON_HIT_PADDING &&
          canvasY >= bounds.y - ICON_HIT_PADDING &&
          canvasY <= bounds.y + bounds.height + ICON_HIT_PADDING
        ) {
          // Found a matching icon - toggle expand/collapse
          const cachedView = getCachedPivotView(bounds.pivotId);
          if (!cachedView) return false;

          // Find the pivot-relative row/col
          const pivotRowIndex = bounds.gridRow - (gridRegionsCache.get(bounds.pivotId)?.startRow ?? 0);
          const pivotColIndex = bounds.gridCol - (gridRegionsCache.get(bounds.pivotId)?.startCol ?? 0);

          const pivotRow = cachedView.rows[pivotRowIndex];
          if (!pivotRow) return false;
          const cell = pivotRow.cells[pivotColIndex];
          if (!cell) return false;

          const itemLabel = cell.formattedValue;
          // In compact layout, all row headers share col 0 but have different indent levels.
          // Use indentLevel to determine the correct field index.
          // For columns, indentLevel carries the column field depth directly.
          const fieldIndex = bounds.isRow
            ? (cell.indentLevel || pivotColIndex)
            : cell.indentLevel;

          try {
            await togglePivotGroup({
              pivotId: bounds.pivotId,
              isRow: bounds.isRow,
              fieldIndex,
              value: itemLabel,
              // Send full group path so that toggling "Female under Gothenburg"
              // doesn't affect "Female under Stockholm"
              groupPath: cell.groupPath,
            });
            // Trigger refresh to reload pivot data
            window.dispatchEvent(new CustomEvent("pivot:refresh"));
          } catch (error) {
            console.error("[Pivot Extension] Failed to toggle expand/collapse:", error);
          }
          return true;
        }
      }
      return false;
    })
  );

  // Register click interceptor - handle filter dropdown clicks
  cleanupFunctions.push(
    context.grid.cellClicks.registerClickInterceptor(async (_row, _col, event) => {
      if (!cachedCanvasElement) return false;

      const rect = cachedCanvasElement.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;

      for (const bounds of overlayFilterDropdownBounds.values()) {
        if (
          canvasX >= bounds.x &&
          canvasX <= bounds.x + bounds.width &&
          canvasY >= bounds.y &&
          canvasY <= bounds.y + bounds.height
        ) {
          try {
            const pivotInfo = await getPivotAtCell(bounds.gridRow, bounds.gridCol);
            if (!pivotInfo?.filterZones) return false;

            for (const zone of pivotInfo.filterZones) {
              if (zone.fieldIndex === bounds.fieldIndex) {
                context.events.emit(PivotEvents.PIVOT_OPEN_FILTER_MENU, {
                  fieldIndex: zone.fieldIndex,
                  fieldName: zone.fieldName,
                  row: zone.row,
                  col: zone.col,
                  anchorX: event.clientX,
                  anchorY: event.clientY,
                });
                return true;
              }
            }
          } catch (error) {
            console.error("[Pivot Extension] Failed to check pivot filter:", error);
          }
          return false;
        }
      }
      return false;
    })
  );

  // Register click interceptor - handle header filter button clicks (Row Labels / Column Labels)
  cleanupFunctions.push(
    context.grid.cellClicks.registerClickInterceptor(async (_row, _col, event) => {
      if (!cachedCanvasElement) return false;

      const rect = cachedCanvasElement.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;

      for (const bounds of overlayHeaderFilterBounds.values()) {
        if (
          canvasX >= bounds.x &&
          canvasX <= bounds.x + bounds.width &&
          canvasY >= bounds.y &&
          canvasY <= bounds.y + bounds.height
        ) {
          // Found a matching header filter button - open header filter dropdown
          context.events.emit(PivotEvents.PIVOT_OPEN_HEADER_FILTER_MENU, {
            pivotId: bounds.pivotId,
            zone: bounds.zone,
            anchorX: event.clientX,
            anchorY: event.clientY + 2,
          });
          return true;
        }
      }
      return false;
    })
  );

  // Register double-click interceptor - toggle hierarchy on header double-click,
  // and silently block edit mode for all pivot cells.
  cleanupFunctions.push(
    context.grid.cellClicks.registerDoubleClickInterceptor(async (row, col, event) => {
      // Check if double-click is on a +/- icon -> just consume it (no toggle).
      // The single-click interceptor already handled the toggle; if we toggled
      // again here the state would flip back (double-toggle bug).
      if (cachedCanvasElement) {
        const rect = cachedCanvasElement.getBoundingClientRect();
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;

        for (const bounds of overlayIconBounds.values()) {
          if (
            canvasX >= bounds.x - ICON_HIT_PADDING &&
            canvasX <= bounds.x + bounds.width + ICON_HIT_PADDING &&
            canvasY >= bounds.y - ICON_HIT_PADDING &&
            canvasY <= bounds.y + bounds.height + ICON_HIT_PADDING
          ) {
            // Consume the double-click without toggling again
            return true;
          }
        }
      }

      // Check if double-click is on an expandable row header -> toggle hierarchy
      for (const [pivotId, regionBounds] of gridRegionsCache.entries()) {
        if (
          row >= regionBounds.startRow && row <= regionBounds.endRow &&
          col >= regionBounds.startCol && col <= regionBounds.endCol
        ) {
          const cachedView = getCachedPivotView(pivotId);
          if (!cachedView) return true; // In a pivot region, block edit

          const pivotRowIndex = row - regionBounds.startRow;
          const pivotColIndex = col - regionBounds.startCol;
          const pivotRow = cachedView.rows[pivotRowIndex];
          if (!pivotRow) return true;
          const cell = pivotRow.cells[pivotColIndex];
          if (!cell) return true;

          // If this cell is an expandable row header, toggle it
          if (cell.cellType === "RowHeader" && cell.isExpandable) {
            try {
              await togglePivotGroup({
                pivotId,
                isRow: true,
                fieldIndex: cell.indentLevel || pivotColIndex,
                value: cell.formattedValue,
              });
              window.dispatchEvent(new CustomEvent("pivot:refresh"));
            } catch (error) {
              console.error("[Pivot Extension] Failed to toggle hierarchy on double-click:", error);
            }
          }

          // Any cell in a pivot region: consume double-click (no edit mode)
          return true;
        }
      }

      return false;
    })
  );

  // Register grid overlay renderer for pivot placeholder regions
  // renderBelowSelection: true ensures the core selection highlight draws ON TOP
  // of pivot cells, making selection look identical to regular grid cells.
  cleanupFunctions.push(
    context.grid.overlays.register({
      type: "pivot",
      render: (ctx: OverlayRenderContext) => {
        // Clear icon bounds at start of each render cycle
        clearOverlayIconBounds();

        // Cache reference to the canvas element for use in click handlers
        cachedCanvasElement = ctx.ctx.canvas;

        // Grid cells now have proper backgrounds/styles from the backend.
        // No white background fill needed — the grid renderer handles it.

        if (ctx.region.data?.isEmpty) {
          drawPivotPlaceholderText(ctx);
        } else {
          // Draw styled pivot cells with Excel-like appearance
          const pivotId = ctx.region.data?.pivotId as number | undefined;
          if (pivotId !== undefined) {
            const cachedView = getCachedPivotView(pivotId);
            if (cachedView) {
              drawStyledPivotView(ctx, cachedView);
            }
            // Draw loading overlay on top of the (dimmed) previous view
            if (isLoading(pivotId)) {
              drawLoadingOverlay(ctx, pivotId);
            }
          }
        }
      },
      hitTest: (hitCtx) => {
        return (
          hitCtx.row >= hitCtx.region.startRow &&
          hitCtx.row <= hitCtx.region.endRow &&
          hitCtx.col >= hitCtx.region.startCol &&
          hitCtx.col <= hitCtx.region.endCol
        );
      },
      getCursor: (hitCtx) => {
        const { canvasX, canvasY } = hitCtx;

        // Check expand/collapse icon bounds
        for (const bounds of overlayIconBounds.values()) {
          if (
            canvasX >= bounds.x - ICON_HIT_PADDING &&
            canvasX <= bounds.x + bounds.width + ICON_HIT_PADDING &&
            canvasY >= bounds.y - ICON_HIT_PADDING &&
            canvasY <= bounds.y + bounds.height + ICON_HIT_PADDING
          ) {
            return "pointer";
          }
        }

        // Check header filter button bounds
        for (const bounds of overlayHeaderFilterBounds.values()) {
          if (
            canvasX >= bounds.x &&
            canvasX <= bounds.x + bounds.width &&
            canvasY >= bounds.y &&
            canvasY <= bounds.y + bounds.height
          ) {
            return "pointer";
          }
        }

        // Check filter dropdown bounds
        for (const bounds of overlayFilterDropdownBounds.values()) {
          if (
            canvasX >= bounds.x &&
            canvasX <= bounds.x + bounds.width &&
            canvasY >= bounds.y &&
            canvasY <= bounds.y + bounds.height
          ) {
            return "pointer";
          }
        }

        // Check cancel button bounds
        for (const bounds of overlayCancelBounds.values()) {
          if (
            canvasX >= bounds.x &&
            canvasX <= bounds.x + bounds.width &&
            canvasY >= bounds.y &&
            canvasY <= bounds.y + bounds.height
          ) {
            return "pointer";
          }
        }

        return null;
      },
      priority: 10,
      renderBelowSelection: true,
    })
  );

  // Track filter dropdown hover state for visual highlight via document-level
  // mousemove (the core cursor system handles pointer cursor via getCursor above)
  const handleDocMouseMove = (event: MouseEvent) => {
    if (!cachedCanvasElement) return;
    const isOverCanvas = event.target === cachedCanvasElement || cachedCanvasElement.contains(event.target as Node);

    if (!isOverCanvas) {
      // Clear filter dropdown hover when mouse leaves canvas
      if (hoveredFilterFieldIndex !== -1) {
        hoveredFilterFieldIndex = -1;
        requestOverlayRedraw();
      }
      return;
    }

    const rect = cachedCanvasElement.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    // Track filter dropdown hover for visual highlight
    let newHoveredFilterFieldIndex = -1;
    for (const bounds of overlayFilterDropdownBounds.values()) {
      if (
        canvasX >= bounds.x &&
        canvasX <= bounds.x + bounds.width &&
        canvasY >= bounds.y &&
        canvasY <= bounds.y + bounds.height
      ) {
        newHoveredFilterFieldIndex = bounds.fieldIndex;
        break;
      }
    }

    // Trigger repaint when filter dropdown hover state changes
    if (newHoveredFilterFieldIndex !== hoveredFilterFieldIndex) {
      hoveredFilterFieldIndex = newHoveredFilterFieldIndex;
      requestOverlayRedraw();
    }
  };
  document.addEventListener("mousemove", handleDocMouseMove);
  cleanupFunctions.push(() => {
    document.removeEventListener("mousemove", handleDocMouseMove);
  });

  // Subscribe to events
  cleanupFunctions.push(
    context.events.on<{ pivotId: number }>(PivotEvents.PIVOT_CREATED, handlePivotCreated)
  );

  cleanupFunctions.push(
    context.events.on<{
      fieldIndex: number;
      fieldName: string;
      row: number;
      col: number;
      anchorX: number;
      anchorY: number;
      pivotId?: number;
    }>(PivotEvents.PIVOT_OPEN_FILTER_MENU, handleOpenFilterMenu)
  );

  // Subscribe to header filter menu events (Row Labels / Column Labels)
  cleanupFunctions.push(
    context.events.on<{
      pivotId: number;
      zone: 'row' | 'column';
      anchorX: number;
      anchorY: number;
    }>(PivotEvents.PIVOT_OPEN_HEADER_FILTER_MENU, handleOpenHeaderFilterMenu)
  );

  // Subscribe to selection changes to show/hide the pivot editor pane
  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange)
  );

  // Subscribe to pivot region updates to cache region bounds locally
  cleanupFunctions.push(
    context.events.on<{ regions: PivotRegionData[] }>(
      PivotEvents.PIVOT_REGIONS_UPDATED,
      (detail) => updateCachedRegions(detail.regions)
    )
  );

  // Listen for backend progress events (Tauri events emitted during async pivot operations)
  listenTauriEvent<PivotProgressEvent>(PivotEvents.PIVOT_PROGRESS, (payload) => {
    setLoading(payload.pivotId, payload.stage, payload.stageIndex, payload.totalStages);
    requestOverlayRedraw();
  }).then((unlisten) => {
    cleanupFunctions.push(unlisten);
  });

  // Listen for pivot:refresh events (from filter changes, field updates, etc.)
  // These need a repaint since the grid isn't already refreshing.
  const handlePivotRefresh = () => { refreshPivotRegions(true); };
  window.addEventListener("pivot:refresh", handlePivotRefresh);
  cleanupFunctions.push(() => window.removeEventListener("pivot:refresh", handlePivotRefresh));

  // Listen for external loading events (from filter/slicer bridges)
  const handleSetLoading = (e: Event) => {
    const { pivotId, stage } = (e as CustomEvent).detail ?? {};
    if (pivotId != null) {
      setLoading(pivotId, stage ?? "Applying filter...", 0, 1);
      requestOverlayRedraw();
    }
  };
  const handleClearLoading = (e: Event) => {
    const { pivotId } = (e as CustomEvent).detail ?? {};
    if (pivotId != null) {
      clearLoading(pivotId);
      requestOverlayRedraw();
    }
  };
  window.addEventListener("pivot:set-loading", handleSetLoading);
  window.addEventListener("pivot:clear-loading", handleClearLoading);
  cleanupFunctions.push(() => {
    window.removeEventListener("pivot:set-loading", handleSetLoading);
    window.removeEventListener("pivot:clear-loading", handleClearLoading);
  });

  // Listen for cell move operations — relocate any pivot tables that were fully contained
  const handleCellsMoved = async (e: Event) => {
    const { sourceStartRow, sourceStartCol, sourceEndRow, sourceEndCol, targetRow, targetCol } =
      (e as CustomEvent).detail;
    const regions = getCachedRegions();
    for (const region of regions) {
      const fullyContained =
        region.startRow >= sourceStartRow && region.endRow <= sourceEndRow &&
        region.startCol >= sourceStartCol && region.endCol <= sourceEndCol;
      if (fullyContained) {
        const newRow = region.startRow + (targetRow - sourceStartRow);
        const newCol = region.startCol + (targetCol - sourceStartCol);
        console.log(`[Pivot Extension] Relocating pivot ${region.pivotId} to (${newRow},${newCol})`);
        try {
          await relocatePivot(region.pivotId, newRow, newCol);
        } catch (err) {
          console.error(`[Pivot Extension] Failed to relocate pivot ${region.pivotId}:`, err);
        }
      }
    }
    // Refresh to pick up new positions
    refreshPivotRegions(true);
  };
  window.addEventListener("cells:moved", handleCellsMoved);
  cleanupFunctions.push(() => window.removeEventListener("cells:moved", handleCellsMoved));

  // When a table's definition changes (resize, expand, etc.), refresh any
  // pivot tables that are linked to that table so their source range stays in sync.
  const handleTableDefsUpdated = async () => {
    try {
      const allPivots = await getAllPivotTables();
      const tableLinked = allPivots.filter((p) => p.sourceTableName);
      for (const p of tableLinked) {
        await refreshPivotCache(p.id);
      }
      if (tableLinked.length > 0) {
        refreshPivotRegions(true);
      }
    } catch (err) {
      console.error("[Pivot Extension] Failed to refresh table-linked pivots:", err);
    }
  };
  window.addEventListener("app:table-definitions-updated", handleTableDefsUpdated);
  cleanupFunctions.push(() => window.removeEventListener("app:table-definitions-updated", handleTableDefsUpdated));

  // Also refresh regions when grid refreshes (sheet switch, etc.)
  // Do NOT trigger another repaint (triggerRepaint=false) to avoid infinite loop.
  const handleGridRefreshForRegions = () => { refreshPivotRegions(false); };
  window.addEventListener("grid:refresh", handleGridRefreshForRegions);
  cleanupFunctions.push(() => window.removeEventListener("grid:refresh", handleGridRefreshForRegions));

  // Refresh pivot regions when the active sheet changes (e.g., after creating a
  // pivot on a new sheet). Without this, the placeholder overlay never appears
  // because the sheet switch happens after the initial region load.
  // Use allowCachedHit=true so returning to a sheet with an already-cached pivot
  // renders instantly instead of waiting for an IPC round-trip.
  cleanupFunctions.push(
    context.events.on(AppEvents.SHEET_CHANGED, () => {
      refreshPivotRegions(false, /* allowCachedHit */ true);
    })
  );

  // Shift pivot overlay regions synchronously when rows/columns are
  // inserted or deleted. The sync shift uses the same arithmetic as the
  // backend so positions are guaranteed correct. We do NOT call
  // refreshPivotRegions() here because a concurrent in-progress refresh
  // could return stale (pre-shift) data and overwrite our shift. The
  // structuralVersion counter ensures any already-in-flight refresh
  // discards its results when it finally completes.
  cleanupFunctions.push(
    context.events.on<{ col: number; count: number }>(AppEvents.COLUMNS_INSERTED, (e) => {
      shiftPivotRegionsForColInsert(e.col, e.count);
      shiftCachedRegionsForColInsert(e.col, e.count);
    })
  );
  cleanupFunctions.push(
    context.events.on<{ row: number; count: number }>(AppEvents.ROWS_INSERTED, (e) => {
      shiftPivotRegionsForRowInsert(e.row, e.count);
      shiftCachedRegionsForRowInsert(e.row, e.count);
    })
  );
  cleanupFunctions.push(
    context.events.on<{ col: number; count: number }>(AppEvents.COLUMNS_DELETED, (e) => {
      shiftPivotRegionsForColDelete(e.col, e.count);
      shiftCachedRegionsForColDelete(e.col, e.count);
    })
  );
  cleanupFunctions.push(
    context.events.on<{ row: number; count: number }>(AppEvents.ROWS_DELETED, (e) => {
      shiftPivotRegionsForRowDelete(e.row, e.count);
      shiftCachedRegionsForRowDelete(e.row, e.count);
    })
  );

  // Listen for task pane reopen requests (e.g., from View menu "Show" action)
  const handleReopenRequest = (e: Event) => {
    const detail = (e as CustomEvent<{ viewId: string }>).detail;
    if (detail?.viewId === PIVOT_PANE_ID) {
      forceRecheck();
    }
  };
  window.addEventListener("taskpane:requestReopen", handleReopenRequest);
  cleanupFunctions.push(() => window.removeEventListener("taskpane:requestReopen", handleReopenRequest));

  // Track pivot style changes from the Design tab
  cleanupFunctions.push(
    context.events.on<{ pivotId: number; layout: { styleId?: string } }>(
      PivotEvents.PIVOT_LAYOUT_STATE,
      (detail) => {
        if (detail.layout.styleId !== undefined) {
          const prev = pivotStyleMap.get(detail.pivotId);
          if (prev !== detail.layout.styleId) {
            pivotStyleMap.set(detail.pivotId, detail.layout.styleId);
            requestOverlayRedraw();
          }
        }
      }
    )
  );
  cleanupFunctions.push(
    context.events.on<{ pivotId: number; layout: { styleId?: string } }>(
      PivotEvents.PIVOT_LAYOUT_CHANGED,
      (detail) => {
        if (detail.layout.styleId !== undefined) {
          pivotStyleMap.set(detail.pivotId, detail.layout.styleId);
          requestOverlayRedraw();
        }
      }
    )
  );

  // Initial region load
  refreshPivotRegions(false);

  console.log("[Pivot Extension] Registered successfully");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[Pivot Extension] Unregistering...");

  // Cleanup event listeners
  cleanupFunctions.forEach((fn) => fn());
  cleanupFunctions = [];

  // Reset handler state
  resetSelectionHandlerState();

  // Clear transition state
  transitionBounds.clear();
  if (transitionCleanupTimer) {
    clearTimeout(transitionCleanupTimer);
    transitionCleanupTimer = null;
  }

  // Clear style tracking
  pivotStyleMap.clear();
  resolvedThemeCache.clear();

  // Clear overlay regions
  removeGridRegionsByType("pivot");

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(PivotManifest.id);
  TaskPaneExtensions.unregisterView(PIVOT_PANE_ID);
  OverlayExtensions.unregisterOverlay(PIVOT_FILTER_OVERLAY_ID);
  OverlayExtensions.unregisterOverlay(PIVOT_HEADER_FILTER_OVERLAY_ID);

  console.log("[Pivot Extension] Unregistered successfully");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.pivot",
    name: "Pivot Tables",
    version: "1.0.0",
    description: "PivotTable functionality for Calcula with styled rendering and interactive expand/collapse.",
  },
  activate,
  deactivate,
};

export default extension;

// Re-export for convenience
export { PIVOT_PANE_ID, PIVOT_DIALOG_ID, PIVOT_GROUP_DIALOG_ID, PIVOT_FILTER_OVERLAY_ID, PIVOT_HEADER_FILTER_OVERLAY_ID };
