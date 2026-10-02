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
  unregisterMenuItem,
  notifyMenusChanged,
  registerPivotStoreService,
  getBiConnectionService,
  openTaskPane,
  clearTaskPaneManuallyClosed,
  addTaskPaneContextKey,
  IconInsertPivot,
  registerCommitGuard,
  showToast,
  registerAutoFitContributor,
  getActiveGridTheme,
} from "@api";
import type { AutoFitColumnContribution, AutoFitRowContribution } from "@api";
import { emitAppEvent, onAppEvent } from "@api/events";
import { drawObjectScriptBadgeIfPresent } from "@api/objectScriptBadge";

import { PivotEvents } from "../_shared/lib/pivotEvents";
import type { PivotProgressEvent } from "../_shared/lib/pivotEvents";
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
  onFloatingHoverChanged,
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
  DrillThroughBehaviorDialogDefinition,
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
  recheckSelectionAfterSheetChange,
  getCachedRegions,
  findPivotRegionAtCell,
  shiftCachedRegionsForColInsert,
  shiftCachedRegionsForRowInsert,
  shiftCachedRegionsForColDelete,
  shiftCachedRegionsForRowDelete,
  ensureDesignTabRegistered,
  setJustCreatedPivot,
  getSelectedVisualPivotId,
} from "./handlers/selectionHandler";
import type { PivotRegionData, PivotEditorViewData, BiPivotModelInfo } from "./types";
import { getPivotRegionsForSheet, getPivotAtCell, getPivotView, getPivotCellWindow, getAllPivotTables, refreshPivotCache, relocatePivot, getPivotHierarchies } from "./lib/pivot-api";
import { getPivotViewCell } from "./lib/pivotChromeActions";
import {
  overlayIconBounds,
  overlayHeaderFilterBounds,
  overlayFilterDropdownBounds,
  overlayCancelBounds,
  ICON_HIT_PADDING,
  clearOverlayIconBounds,
  claimPivotCellChrome,
} from "./lib/pivotCellChrome";
import { runPivotCellDoubleClick } from "./lib/pivotCellDoubleClick";
import {
  publishPivotRegions,
  removePivotVisualRegions,
  resetPivotVisualRegionState,
  currentFrameGeneration,
} from "./lib/pivotVisualRegions";
import { prunePivotVisualRecords, resetPivotVisualHits, getPivotVisualRecord } from "./lib/pivotVisualHits";
import { resetPivotVisualScrolls } from "./lib/pivotVisualScroll";
import {
  clearPivotVisualHoverUnlessHovered,
  installPivotVisual,
  updatePivotVisualHoverAt,
} from "./lib/pivotVisualOverlay";
import {
  notePivotCreated,
  adoptCreatedCanvasPivot,
  resetCreatedPivotTracking,
} from "./lib/pivotVisualSelection";
import {
  paintPivotPlaceholderContent,
  paintPivotLoadingIndicator,
} from "./rendering/pivotStatusPainters";
import { pivotBackend } from "./lib/pivotBackend";
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
  applyBackendProgress,
} from "./lib/pivotViewStore";
import {
  prepareWritebackContexts,
  resolveWritebackCell,
  submitWritebackValue,
  handleWritebackModelChanged,
  resetWritebackEditingState,
} from "./lib/writebackEditing";
import {
  drawPivotCell,
  DEFAULT_PIVOT_THEME,
  createPivotTheme,
  measurePivotColumnRequiredWidth,
  DEFAULT_PIVOT_CELL_HEIGHT,
} from "./rendering/pivot";
import type { PivotCellDrawResult, PivotTheme, PivotColumnMeasureSource } from "./rendering/pivot";
import {
  getThemeOverridesForStyle,
  DEFAULT_PIVOT_STYLE_ID,
  getPivotStylePreview,
  setPivotStylePreview,
} from "./lib/pivotStyles";

// Re-export cache accessors so existing consumers (e.g., context menu) keep working
export { cachePivotView, getCachedPivotView };

// ============================================================================
// Per-Pivot Style Theme Tracking
// ============================================================================

/** Maps pivotId -> styleId (selected in the Design tab gallery). */
const pivotStyleMap = new Map<string, string>();

/** Maps styleId -> resolved PivotTheme (cached to avoid recomputing each frame). */
const resolvedThemeCache = new Map<string, PivotTheme>();

/** Get the PivotTheme for a given pivot: the style the gallery is HOVERING
 *  (a transient preview that never reaches the backend, the undo stack or the
 *  dirty flag) wins over the pivot's own selected style. */
function getThemeForPivot(pivotId: string): PivotTheme {
  const styleId = getPivotStylePreview(pivotId) ?? (pivotStyleMap.get(pivotId) || DEFAULT_PIVOT_STYLE_ID);
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
// In-cell chrome bounds (populated during overlay rendering)
// ============================================================================
// The +/- icons, report filter combos, Row/Column Labels buttons and the
// loading Cancel, as painted, live in lib/pivotCellChrome.ts together with the
// ONE cell click interceptor that reads them (a release claim: the chrome acts
// on the RELEASE over the same chrome, BUG-0258 design phase 4).

/** Cache of pivot region bounds keyed by pivotId, for coordinate conversion in click handlers. */
const gridRegionsCache = new Map<string, { startRow: number; startCol: number; endRow: number; endCol: number }>();

/**
 * Last-rendered pixel height per view row, keyed by pivotId (refreshed every
 * overlay paint). Auto-fit measurement uses these to size the in-cell arrow
 * buttons exactly like the draw pass (btnSize = rowHeight - margins).
 */
const overlayRowHeightsCache = new Map<string, number[]>();

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
const transitionBounds = new Map<string, { endRow: number; endCol: number }>();
let transitionCleanupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-entry guard for refreshPivotRegions.
 * When refreshPivotRegions(true) dispatches "grid:refresh", the pivot extension's
 * own grid:refresh listener would trigger another refreshPivotRegions(false) call.
 * This flag prevents that redundant second call from executing.
 */
let isRefreshingPivotRegions = false;

/**
 * Cached BI connection status per pivot ID.
 * Updated during refreshPivotRegions. Used by the overlay to draw a connection badge.
 * null = not a BI pivot, true = connected, false = disconnected.
 */
const biConnectionStatus = new Map<string, boolean | null>();

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
function drawLoadingOverlay(overlayCtx: OverlayRenderContext, pivotId: string): void {
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

  // Dim, progress bar, stage text and (after 1s) the Cancel button -- the same
  // painter the canvas pivot box uses, so the two cannot drift apart.
  const cancelBounds = paintPivotLoadingIndicator(
    ctx,
    { x: startX, y: startY, width, height },
    loadingState,
  );
  if (cancelBounds) {
    // Store bounds for click handler
    overlayCancelBounds.set(pivotId, cancelBounds);
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
 * Update the BI connection status cache for all pivot regions.
 * Called from refreshPivotRegions (non-blocking).
 */
function updateBiConnectionStatus(regions: PivotRegionData[]): void {
  // Fire-and-forget: fetch connections and check which pivots are BI-connected.
  // The connection service is registered by the BusinessIntelligence extension.
  const biService = getBiConnectionService();
  if (!biService) return;
  biService.getConnections().then(conns => {
    const connMap = new Map(conns.map(c => [c.id, c.isConnected]));

    // For each pivot region, check if it has BI metadata via getPivotAtCell
    for (const region of regions) {
      // Quick check: try to get BI info for this pivot
      getPivotAtCell(region.startRow, region.startCol).then(info => {
        if (info?.biModel) {
          const connected = connMap.get(info.biModel.connectionId) ?? false;
          const prev = biConnectionStatus.get(region.pivotId);
          biConnectionStatus.set(region.pivotId, connected);
          // Redraw if status changed
          if (prev !== connected) {
            requestOverlayRedraw();
          }
        } else {
          biConnectionStatus.set(region.pivotId, null); // not a BI pivot
        }
      }).catch(() => {
        biConnectionStatus.set(region.pivotId, null);
      });
    }
  }).catch(() => {});
}

/**
 * Draw a small connection status badge in the top-right area of a BI pivot.
 * Green = connected, orange = disconnected. Non-BI pivots show nothing.
 */
function drawBiConnectionBadge(overlayCtx: OverlayRenderContext, pivotId: string): void {
  const status = biConnectionStatus.get(pivotId);
  if (status === null || status === undefined) return; // not a BI pivot

  const { ctx: canvas, region } = overlayCtx;
  // Use the overlay helpers to find the top-right corner of the pivot
  const colX = overlayGetColumnX(overlayCtx, region.endCol);
  const colW = overlayGetColumnWidth(overlayCtx, region.endCol);
  const rowY = overlayGetRowY(overlayCtx, region.startRow);

  const dotRadius = 4;
  const padding = 6;
  const x = colX + colW - dotRadius - padding;
  const y = rowY + dotRadius + padding;

  canvas.save();
  canvas.beginPath();
  canvas.arc(x, y, dotRadius, 0, Math.PI * 2);
  canvas.fillStyle = status ? '#4caf50' : '#ff9800';
  canvas.fill();
  canvas.strokeStyle = '#fff';
  canvas.lineWidth = 1.5;
  canvas.stroke();
  canvas.restore();
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

  const pivotId = (region.data?.pivotId as string) ?? "";
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

  // Keep the latest row heights available to auto-fit measurement
  overlayRowHeightsCache.set(pivotId, rowHeightValues);

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

  // Stroke the region perimeter in the grid's gridline color: the cell
  // background fills above painted over the boundary gridlines, and core
  // skips gridlines inside overlay regions — without this the pivot floats
  // borderless against its neighbors (Excel keeps the gridline visible).
  if (numCols > 0 && numRows > 0) {
    const gridTheme = getActiveGridTheme();
    const regionX0 = colXPositions[0];
    const regionX1 = colXPositions[numCols - 1] + colWidthValues[numCols - 1];
    ctx.strokeStyle = gridTheme.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.floor(regionX0) + 0.5, regionStartY);
    ctx.lineTo(Math.floor(regionX0) + 0.5, regionEndY);
    ctx.moveTo(Math.floor(regionX1) + 0.5, regionStartY);
    ctx.lineTo(Math.floor(regionX1) + 0.5, regionEndY);
    ctx.moveTo(regionX0, Math.floor(regionStartY) + 0.5);
    ctx.lineTo(regionX1, Math.floor(regionStartY) + 0.5);
    ctx.moveTo(regionX0, Math.floor(regionEndY) + 0.5);
    ctx.lineTo(regionX1, Math.floor(regionEndY) + 0.5);
    ctx.stroke();
  }

  ctx.restore();

  const drawMs = performance.now() - t0;
  console.log(
    `[PERF][pivot] drawStyledPivotView rows=${numRows} cols=${numCols} | drawn=${cellsDrawn} skipped=${cellsSkipped} | precompute=${tPrecompute.toFixed(1)}ms render=${drawMs.toFixed(1)}ms`
  );
}

// ============================================================================
// Auto-fit measurement (double-click best-fit on column/row header edges)
// ============================================================================

/** Build a measurement row source for a cached pivot view (windowed-aware). */
function buildColumnMeasureSource(
  pivotId: string,
  view: PivotViewResponse,
  colIndex: number
): PivotColumnMeasureSource {
  const isWindowed = view.isWindowed === true;
  const cache = isWindowed ? getCellWindowCache(pivotId) : undefined;
  const rowHeights = overlayRowHeightsCache.get(pivotId);
  return {
    rowCount: isWindowed ? (view.totalRowCount ?? view.rows.length) : view.rows.length,
    getRow: isWindowed
      ? (i) => cache?.getRow(i) ?? null
      : (i) => view.rows[i] ?? null,
    // Windowed pivots may span a million view rows but hold only a few
    // fetched windows — scan just those; maxContentSample covers the rest
    availableRowIndices: isWindowed && cache
      ? () => cache.getLoadedRowIndices()
      : undefined,
    maxContentSample: view.columns?.[colIndex]?.maxContentSample,
    getRowHeight: (i) => rowHeights?.[i] ?? DEFAULT_PIVOT_CELL_HEIGHT,
  };
}

/**
 * Column contribution for the core best-fit: pivot cells are repainted by the
 * overlay with themed fonts and in-cell chrome (dropdown buttons, indent,
 * expand icons), so the pivot claims its rows and reports the width the
 * overlay actually needs.
 */
function measurePivotAutoFitColumn(
  col: number,
  measureCtx: CanvasRenderingContext2D
): AutoFitColumnContribution | null {
  const claimedRowRanges: Array<{ startRow: number; endRow: number }> = [];
  let requiredWidth: number | undefined;

  for (const region of getGridRegions()) {
    if (region.type !== "pivot" || region.data?.isEmpty) continue;
    if (col < region.startCol || col > region.endCol) continue;
    const pivotId = region.data?.pivotId as string | undefined;
    const view = pivotId ? getCachedPivotView(pivotId) : undefined;
    // Without a cached view the core grid-cell measurement is the best
    // available answer — leave the cells unclaimed
    if (!pivotId || !view) continue;

    claimedRowRanges.push({ startRow: region.startRow, endRow: region.endRow });
    const colIndex = col - region.startCol;
    const width = measurePivotColumnRequiredWidth(
      measureCtx,
      buildColumnMeasureSource(pivotId, view, colIndex),
      colIndex,
      getThemeForPivot(pivotId)
    );
    if (width !== null && (requiredWidth === undefined || width > requiredWidth)) {
      requiredWidth = width;
    }
  }

  if (claimedRowRanges.length === 0) return null;
  return { claimedRowRanges, requiredWidth };
}

/**
 * Row contribution for the core best-fit: pivot rows keep at least their
 * laid-out default height so the in-cell dropdown buttons stay usable;
 * larger themed fonts raise it.
 */
function measurePivotAutoFitRow(row: number): AutoFitRowContribution | null {
  const claimedColRanges: Array<{ startCol: number; endCol: number }> = [];
  let requiredHeight: number | undefined;

  for (const region of getGridRegions()) {
    if (region.type !== "pivot" || region.data?.isEmpty) continue;
    if (row < region.startRow || row > region.endRow) continue;
    const pivotId = region.data?.pivotId as string | undefined;
    if (!pivotId || !getCachedPivotView(pivotId)) continue;

    claimedColRanges.push({ startCol: region.startCol, endCol: region.endCol });
    const theme = getThemeForPivot(pivotId);
    const height = Math.max(DEFAULT_PIVOT_CELL_HEIGHT, Math.ceil(theme.fontSize * 1.2) + 4);
    if (requiredHeight === undefined || height > requiredHeight) {
      requiredHeight = height;
    }
  }

  if (claimedColRanges.length === 0) return null;
  return { claimedColRanges, requiredHeight };
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

  // Name box + "Click in this area" hint -- shared with the canvas pivot box.
  paintPivotPlaceholderContent(
    ctx,
    { x: startX, y: startY, width: regionWidth, height: regionHeight },
    (region.data?.name as string) || "PivotTable",
  );

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
  // A canvas pivot box's frame saved while this fetch is in flight must win
  // over the pre-save frame the fetch will bring back (pivotVisualRegions).
  const frameGenerationAtStart = currentFrameGeneration();

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

    // Atomically replace pivot regions and always notify listeners so the overlay
    // redraws immediately with the freshly-cached pivotViewCache data.
    // The transition bounds mechanism covers the old (larger) region area with a
    // white fill, so stale cells underneath are hidden even before refreshCells()
    // completes from the grid:refresh below.
    //
    // A CANVAS pivot (one with a `canvasFrame`) publishes a floating
    // `pivot-visual` region INSTEAD of the cell-anchored `pivot` one: the Core
    // paints no cell region on a canvas, but would keep its bottom-right
    // resize handle live somewhere on the page.
    const published = publishPivotRegions(regions, frameGenerationAtStart);
    prunePivotVisualRecords(new Set(published.visual.map((r) => String(r.data?.pivotId ?? ""))));
    if (published.cell.length === 0) {
      // Only the worksheet overlay's paint clears its bound maps; with no
      // worksheet pivot on this sheet it never paints, so clear them here.
      clearOverlayIconBounds();
    }

    // Update BI connection status for overlay badges (non-blocking)
    updateBiConnectionStatus(regions);

    // Rebuild writeback editability contexts so edit guards stay synchronous (non-blocking)
    prepareWritebackContexts(regions);

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
    removePivotVisualRegions();
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
    const pivotId = r.id.replace("pivot-", "");
    if (pivotId) {
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
    const pivotId = r.id.replace("pivot-", "");
    if (pivotId) {
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

/** Cache for pivot field names (used by scriptable objects store service). */
const pivotFieldsCache = new Map<string, { rows: string[]; columns: string[]; values: string[]; filters: string[] }>();

import { isGenerateGetPivotDataEnabled, setGenerateGetPivotData } from "./lib/getPivotDataToggle";
import { getPivotDataPick } from "./lib/getPivotDataPick";

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  pivotBackend.set(context.invokeBackend);
  console.log("[Pivot Extension] Registering...");

  // Register pivot store service for scriptable objects
  registerPivotStoreService({
    getPivotFields(pivotId: string) {
      // Use getPivotHierarchies which returns field info async, but
      // since the interface expects sync, we return a cached/empty default
      // and the actual data is fetched when scripts call getFields()
      const empty = { rows: [] as string[], columns: [] as string[], values: [] as string[], filters: [] as string[] };
      // Fire async fetch — result will be available on next call
      getPivotHierarchies(pivotId)
        .then((info) => {
          // Cache in a module-level map if needed
          pivotFieldsCache.set(pivotId, {
            rows: (info as { rowFields?: Array<{ name: string }> }).rowFields?.map((f) => f.name) ?? [],
            columns: (info as { columnFields?: Array<{ name: string }> }).columnFields?.map((f) => f.name) ?? [],
            values: (info as { dataFields?: Array<{ name: string }> }).dataFields?.map((f) => f.name) ?? [],
            filters: (info as { filterFields?: Array<{ name: string }> }).filterFields?.map((f) => f.name) ?? [],
          });
        })
        .catch(() => {});
      return pivotFieldsCache.get(pivotId) ?? empty;
    },
    async refreshPivot(pivotId: string) {
      await refreshPivotCache(pivotId);
    },
    openBiPivotEditor(pivotId: string, biModel: BiPivotModelInfo) {
      clearTaskPaneManuallyClosed(PIVOT_PANE_ID);
      addTaskPaneContextKey("pivot");
      ensureDesignTabRegistered();

      const paneData: PivotEditorViewData = {
        pivotId,
        sourceFields: [],
        initialRows: [],
        initialColumns: [],
        initialValues: [],
        initialFilters: [],
        initialLayout: {},
        biModel,
      };
      openTaskPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
      setJustCreatedPivot(true);
    },
  });

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(PivotManifest);

  // Register task pane view
  context.ui.taskPanes.register(PivotPaneDefinition);

  // Register dialogs
  context.ui.dialogs.register(PivotDialogDefinition);
  context.ui.dialogs.register(PivotGroupDialogDefinition);
  context.ui.dialogs.register(PivotFieldSettingsDialogDefinition);
  context.ui.dialogs.register(PivotOptionsDialogDefinition);
  context.ui.dialogs.register(DrillThroughBehaviorDialogDefinition);

  // Register context menu items for right-click in pivot regions
  cleanupFunctions.push(registerPivotContextMenuItems());

  // Register overlays
  context.ui.overlays.register(PivotFilterOverlayDefinition);
  context.ui.overlays.register(PivotHeaderFilterOverlayDefinition);

  // Register edit guard - block editing in pivot regions (synchronous using cached regions).
  // Exception: writeback-editable cells (a writeback column placed as LOOKUP,
  // on a leaf data row with a complete key) may open the editor — the commit
  // guard below routes the value to the model instead of the grid.
  cleanupFunctions.push(
    context.grid.editGuards.register(async (row, col) => {
      const region = findPivotRegionAtCell(row, col);
      if (region) {
        if (resolveWritebackCell(region.pivotId, row, col)) return null;
        return { blocked: true, message: "You can't change this part of the PivotTable." };
      }
      return null;
    })
  );

  // Commit interception for writeback cells: the typed value goes to the BI
  // model via biWritebackSetValue and NEVER into the grid — the pivot owns
  // those cells. On success the pivot refreshes so the projected value renders.
  cleanupFunctions.push(
    registerCommitGuard(async (row, col, value) => {
      const region = findPivotRegionAtCell(row, col);
      if (!region) return null;
      const target = resolveWritebackCell(region.pivotId, row, col);
      // Non-writeback pivot cells never reach a commit (the edit guard blocks
      // the editor), so only writeback targets are handled here.
      if (!target) return null;
      try {
        await submitWritebackValue(target, value);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        showToast(msg, { type: "error" });
        // Keep the editor open so the user can correct the value.
        return { action: "retry" };
      }
      // Same refresh path the context menu's Refresh uses.
      refreshPivotCache(region.pivotId)
        .then(() => window.dispatchEvent(new Event("pivot:refresh")))
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("superseded") && !msg.includes("cancelled")) {
            showToast(`Value saved, but the pivot refresh failed: ${msg}`, { type: "warning" });
          }
        });
      // Always cancel the raw grid write — the value lives in the model.
      return { action: "block" };
    })
  );

  // Register formula reference interceptor for GETPIVOTDATA generation
  cleanupFunctions.push(
    registerFormulaReferenceInterceptor((row, col) => getPivotDataPick(row, col))
  );

  // Register "Generate GetPivotData" toggle in the Formulas menu
  registerMenuItem("formulas", {
    id: "pivot.generateGetPivotData",
    label: "Generate GetPivotData",
    icon: IconInsertPivot,
    get checked() { return isGenerateGetPivotDataEnabled(); },
    action: () => {
      setGenerateGetPivotData(!isGenerateGetPivotDataEnabled());
      notifyMenusChanged();
    },
  });
  // Its OWN item back on deactivate (wave E, Y14): the Formulas menu is Tracing's.
  cleanupFunctions.push(() => unregisterMenuItem("formulas", "pivot.generateGetPivotData"));

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
            // Single-cell exception: the editor may open on a writeback-editable
            // cell (this guard runs before the edit guard in the editing path).
            // Commits there are intercepted, so no raw write can follow.
            if (
              startRow === endRow &&
              startCol === endCol &&
              resolveWritebackCell(region.pivotId, startRow, startCol)
            ) {
              continue;
            }
            return { blocked: true, message: pivotStructuralGuardMessage };
          }
        }
      }
      return null;
    })
  );

  // ONE cell click interceptor for the in-cell chrome -- the loading Cancel,
  // the +/- icons, the report filter combos and the Row/Column Labels buttons.
  // A press on the chrome is CLAIMED for its RELEASE over the same piece of
  // chrome, and sliding off cancels (BUG-0258 design phase 4; Core holds the
  // press, lib/pivotCellChrome.ts says what the chrome is and does). It used
  // to be four interceptors that acted on the PRESS.
  cleanupFunctions.push(
    context.grid.cellClicks.registerClickInterceptor((_row, _col, event) =>
      claimPivotCellChrome(event, {
        canvas: () => cachedCanvasElement,
        regionOrigin: (pivotId) => gridRegionsCache.get(pivotId),
      }),
    )
  );

  // Register double-click interceptor - toggle hierarchy on header double-click,
  // and silently block edit mode for all pivot cells.
  cleanupFunctions.push(
    context.grid.cellClicks.registerDoubleClickInterceptor((row, col, event) => {
      // Check if double-click is on a +/- icon -> just consume it (no toggle).
      // Its first click already toggled at its RELEASE (the chrome's release
      // claim) and its second release was dropped by the double-click guard
      // (lib/pivotChromeRepeat.ts, the canvas box's own); toggling here as
      // well would flip the state again.
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

          // Writeback-editable cells open the grid editor on double-click:
          // don't consume, so the core editing path (whose range/edit guards
          // also allow these cells) starts edit mode.
          if (resolveWritebackCell(pivotId, row, col)) return false;

          const cell = getPivotViewCell(pivotId, pivotRowIndex, pivotColIndex);
          if (!cell) return true;

          // Expandable row header: toggle. Data / total cell: drill through.
          // One implementation, shared with the canvas pivot box's double-click.
          runPivotCellDoubleClick(pivotId, cell, row, col, pivotColIndex);

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
          const pivotId = ctx.region.data?.pivotId as string | undefined;
          if (pivotId !== undefined) {
            const cachedView = getCachedPivotView(pivotId);
            if (cachedView) {
              drawStyledPivotView(ctx, cachedView);
            }
            // Draw loading overlay on top of the (dimmed) previous view
            if (isLoading(pivotId)) {
              drawLoadingOverlay(ctx, pivotId);
            }
            // Transparency: badge a pivot that has a script attached (design
            // mode) -- e.g. a "script" drill-through. Same affordance charts and
            // slicers use.
            drawObjectScriptBadgeIfPresent(
              ctx.ctx,
              "pivot",
              pivotId,
              overlayGetColumnX(ctx, ctx.region.startCol),
              overlayGetRowY(ctx, ctx.region.startRow),
              overlayGetColumnsWidth(ctx, ctx.region.startCol, ctx.region.endCol),
            );
            // Connection status badge is shown in the task pane only
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
      getCellCursor: (hitCtx) => {
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

  // CANVAS pivots: a floating `pivot-visual` box per canvas pivot -- painted
  // clipped and scrolled inside its frame, movable/resizable through Core,
  // with its chrome reached as CONTENT in its zone answer (the cellClicks
  // interceptors above are never asked over a floating object), its own
  // double-click, object selection (Tab / Escape on the canvas) and wheel.
  cleanupFunctions.push(
    ...installPivotVisual({ getTheme: getThemeForPivot }, (registration) =>
      context.grid.overlays.register(registration),
    ),
  );

  // Double-click best-fit must size pivot columns/rows for the overlay-drawn
  // content (themed fonts + in-cell chrome), not the underlying grid cells
  cleanupFunctions.push(
    registerAutoFitContributor({
      id: "pivot",
      measureColumn: measurePivotAutoFitColumn,
      measureRow: measurePivotAutoFitRow,
    })
  );

  // Track filter dropdown hover state for visual highlight via document-level
  // mousemove (the core cursor system handles pointer cursor via getCellCursor above)
  const handleDocMouseMove = (event: MouseEvent) => {
    // A canvas pivot box's chrome highlight follows the pointer from here --
    // set over the TOPMOST box's chrome, cleared everywhere else. Its zone
    // answer (the pointer Core shows) is pure and writes nothing.
    updatePivotVisualHoverAt(event.clientX, event.clientY, event.target);
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

  // ...and CLEARED when Core's floating-object hover leaves every canvas pivot
  // box without a mousemove to say so: the pointer left the grid, the grid
  // scrolled, the sheet changed (BUG-0258 design phase 5, core/lib/objectHover.ts).
  cleanupFunctions.push(
    onFloatingHoverChanged((hoveredRegionId) => clearPivotVisualHoverUnlessHovered(hoveredRegionId)),
  );

  // Subscribe to events
  cleanupFunctions.push(
    context.events.on<{ pivotId: string }>(PivotEvents.PIVOT_CREATED, handlePivotCreated)
  );
  // A pivot created on a canvas starts as the SELECTED box (see
  // adoptCreatedCanvasPivot), so a click on the empty page deselects it.
  cleanupFunctions.push(
    context.events.on<{ pivotId: string }>(PivotEvents.PIVOT_CREATED, (detail) => {
      if (detail?.pivotId) notePivotCreated(String(detail.pivotId));
    })
  );

  cleanupFunctions.push(
    context.events.on<{
      fieldIndex: number;
      fieldName: string;
      row: number;
      col: number;
      anchorX: number;
      anchorY: number;
      pivotId?: string;
    }>(PivotEvents.PIVOT_OPEN_FILTER_MENU, handleOpenFilterMenu)
  );

  // Subscribe to header filter menu events (Row Labels / Column Labels)
  cleanupFunctions.push(
    context.events.on<{
      pivotId: string;
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
      (detail) => {
        updateCachedRegions(detail.regions);
        adoptCreatedCanvasPivot(detail.regions ?? []);
      }
    )
  );

  // Listen for backend progress events (Tauri events emitted during async pivot
  // operations). applyBackendProgress — NOT setLoading — because the LAST event
  // of an operation is emitted just before the command returns and arrives after
  // pivot-api has already cleared the indicator; starting a new loading state
  // from it arms a spinner nothing will ever clear. See its doc comment.
  listenTauriEvent<PivotProgressEvent>(PivotEvents.PIVOT_PROGRESS, (payload) => {
    if (!applyBackendProgress(payload.pivotId, payload.stage, payload.stageIndex, payload.totalStages)) {
      return;
    }
    requestOverlayRedraw();
  }).then((unlisten) => {
    cleanupFunctions.push(unlisten);
  });

  // Listen for pivot:refresh events (from filter changes, field updates, etc.)
  // These need a repaint since the grid isn't already refreshing.
  const handlePivotRefresh = () => { refreshPivotRegions(true); };
  window.addEventListener("pivot:refresh", handlePivotRefresh);
  cleanupFunctions.push(() => window.removeEventListener("pivot:refresh", handlePivotRefresh));

  // BI model changed (Model Editor): writeback column definitions may have
  // changed — drop the cached metas and rebuild editability contexts.
  cleanupFunctions.push(
    onAppEvent<{ connectionId?: string }>("bi:model-changed", (detail) => {
      handleWritebackModelChanged(detail?.connectionId);
    })
  );

  // (§3cd) An OUT-OF-BAND MCP pivot create/edit/delete no longer emits a
  // bespoke "pivots:refresh" Tauri event; it announces the `pivot` DOMAIN, which
  // the Shell translator fans out to the "pivot:refresh" handler above. The AI's
  // pivot delete now also announces `slicer` + `ribbonFilter` -- deleting a pivot
  // cascades into the slicers, the timelines and the ribbon filters bound to it.

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
  cleanupFunctions.push(
    onAppEvent(AppEvents.TABLE_DEFINITIONS_UPDATED, handleTableDefsUpdated),
  );

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
      // THEN re-derive the contextual tabs for the cell the new sheet shows:
      // the selection handler's same-cell skip cannot tell B2 here from B2
      // on the sheet just left.
      void refreshPivotRegions(false, /* allowCachedHit */ true).then(() => recheckSelectionAfterSheetChange());
    })
  );

  // A pull, refresh or push of a .calp application can replace pivots and the
  // canvas frames they are shown in; re-read regions AND views (no cache hit).
  cleanupFunctions.push(
    context.events.on(AppEvents.PACKAGE_UPDATED, () => {
      refreshPivotRegions(true);
    })
  );

  // A canvas pivot box's scroll is a session VIEWING state keyed by pivot id;
  // a different document starts every box at its top-left again.
  for (const event of [AppEvents.AFTER_NEW, AppEvents.AFTER_OPEN]) {
    cleanupFunctions.push(
      context.events.on(event, () => {
        resetPivotVisualScrolls();
      })
    );
  }

  // Shift pivot overlay regions synchronously when rows/columns are
  // inserted or deleted. The sync shift uses the same arithmetic as the
  // backend so positions are guaranteed correct. We do NOT call
  // refreshPivotRegions() here because a concurrent in-progress refresh
  // could return stale (pre-shift) data and overwrite our shift. The
  // structuralVersion counter ensures any already-in-flight refresh
  // discards its results when it finally completes.
  cleanupFunctions.push(
    context.events.on<{ sheetIndex: number; startCol: number; count: number }>(AppEvents.COLUMNS_INSERTED, (e) => {
      shiftPivotRegionsForColInsert(e.startCol, e.count);
      shiftCachedRegionsForColInsert(e.startCol, e.count);
    })
  );
  cleanupFunctions.push(
    context.events.on<{ sheetIndex: number; startRow: number; count: number }>(AppEvents.ROWS_INSERTED, (e) => {
      shiftPivotRegionsForRowInsert(e.startRow, e.count);
      shiftCachedRegionsForRowInsert(e.startRow, e.count);
    })
  );
  cleanupFunctions.push(
    context.events.on<{ sheetIndex: number; startCol: number; count: number }>(AppEvents.COLUMNS_DELETED, (e) => {
      shiftPivotRegionsForColDelete(e.startCol, e.count);
      shiftCachedRegionsForColDelete(e.startCol, e.count);
    })
  );
  cleanupFunctions.push(
    context.events.on<{ sheetIndex: number; startRow: number; count: number }>(AppEvents.ROWS_DELETED, (e) => {
      shiftPivotRegionsForRowDelete(e.startRow, e.count);
      shiftCachedRegionsForRowDelete(e.startRow, e.count);
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
    context.events.on<{ pivotId: string; layout: { styleId?: string } }>(
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
    context.events.on<{ pivotId: string; layout: { styleId?: string } }>(
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

  // Expose lifecycle functions for E2E invariant testing
  (window as any).__CALCULA_PIVOT__ = {
    getCachedRegions,
    findPivotRegionAtCell,
    handleSelectionChange,
    // Canvas pivot boxes: what the box last painted (canvas-space box, session
    // scroll, first body row) -- read-only, for journey assertions.
    getVisualState: (pivotId: string) => {
      const record = getPivotVisualRecord(pivotId);
      if (!record) return null;
      return {
        box: { ...record.box },
        scroll: { ...record.scroll },
        selected: getSelectedVisualPivotId() === pivotId,
      };
    },
  };

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
  resetWritebackEditingState();

  // Clear transition state
  transitionBounds.clear();
  if (transitionCleanupTimer) {
    clearTimeout(transitionCleanupTimer);
    transitionCleanupTimer = null;
  }

  // Clear style tracking
  pivotStyleMap.clear();
  resolvedThemeCache.clear();
  setPivotStylePreview(null, null);

  // Clear overlay regions
  removeGridRegionsByType("pivot");
  removePivotVisualRegions();
  resetPivotVisualRegionState();
  resetPivotVisualHits();
  resetPivotVisualScrolls();
  resetCreatedPivotTracking();

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
