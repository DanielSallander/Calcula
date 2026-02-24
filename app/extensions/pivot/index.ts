//! FILENAME: app/extensions/pivot/index.ts
// PURPOSE: Pivot table extension entry point.
// CONTEXT: Registers all pivot functionality with the extension system.

import {
  ExtensionRegistry,
  TaskPaneExtensions,
  DialogExtensions,
  OverlayExtensions,
  onAppEvent,
  AppEvents,
  emitAppEvent,
  registerEditGuard,
  registerCellClickInterceptor,
} from "../../src/api";

import { PivotEvents } from "./lib/pivotEvents";

import {
  registerGridOverlay,
  setGridRegions,
  removeGridRegionsByType,
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
} from "../../src/api/gridOverlays";

import {
  PivotManifest,
  PivotPaneDefinition,
  PivotDialogDefinition,
  PivotGroupDialogDefinition,
  PivotFilterOverlayDefinition,
  PIVOT_PANE_ID,
  PIVOT_DIALOG_ID,
  PIVOT_GROUP_DIALOG_ID,
  PIVOT_FILTER_OVERLAY_ID,
} from "./manifest";

import { handlePivotCreated } from "./handlers/pivotCreatedHandler";
import { handleOpenFilterMenu } from "./handlers/filterMenuHandler";
import { registerPivotContextMenuItems } from "./handlers/pivotContextMenu";
import {
  handleSelectionChange,
  updateCachedRegions,
  resetSelectionHandlerState,
  forceRecheck,
} from "./handlers/selectionHandler";
import type { PivotRegionData } from "./types";
import { getPivotRegionsForSheet, getPivotAtCell, getPivotView, togglePivotGroup } from "./lib/pivot-api";
import type { PivotViewResponse } from "./lib/pivot-api";
import { drawPivotCell, DEFAULT_PIVOT_THEME } from "./rendering/pivot";
import type { PivotCellDrawResult } from "./rendering/pivot";

// ============================================================================
// Pivot View Data Cache
// ============================================================================

/** Cache of the latest PivotViewResponse for each pivot table. */
const pivotViewCache = new Map<number, PivotViewResponse>();

/**
 * Store a PivotViewResponse in the cache for use by the overlay renderer.
 */
export function cachePivotView(pivotId: number, view: PivotViewResponse): void {
  pivotViewCache.set(pivotId, view);
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
  pivotId: number;
}

/** Map of icon bounds keyed by "pivotId-gridRow-gridCol", updated every render. */
const overlayIconBounds = new Map<string, StoredIconBounds>();

/** Clear all stored icon bounds (called at start of each render cycle). */
function clearOverlayIconBounds(): void {
  overlayIconBounds.clear();
}

/** Cache of pivot region bounds keyed by pivotId, for coordinate conversion in click handlers. */
const gridRegionsCache = new Map<number, { startRow: number; startCol: number; endRow: number; endCol: number }>();

/** Cached reference to the grid canvas element, captured during overlay rendering. */
let cachedCanvasElement: HTMLCanvasElement | null = null;

/**
 * Fetch and cache pivot view data for all non-empty pivot regions.
 */
async function refreshPivotViewCache(regions: PivotRegionData[]): Promise<void> {
  for (const r of regions) {
    if (!r.isEmpty) {
      try {
        const view = await getPivotView(r.pivotId);
        pivotViewCache.set(r.pivotId, view);
      } catch (e) {
        console.error(`[Pivot Extension] Failed to fetch view for pivot ${r.pivotId}:`, e);
      }
    } else {
      pivotViewCache.delete(r.pivotId);
    }
  }
}

// ============================================================================
// Pivot Placeholder Overlay Renderer
// ============================================================================

/**
 * Draw a white background over the pivot region to hide underlying grid lines.
 * Called for ALL pivot regions (both empty and populated).
 */
function drawPivotBackground(overlayCtx: OverlayRenderContext): void {
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

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(startX, startY, regionWidth, regionHeight);

  ctx.strokeStyle = "#d0d0d0";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(
    Math.floor(startX) + 0.5,
    Math.floor(startY) + 0.5,
    regionWidth - 1,
    regionHeight - 1,
  );

  ctx.restore();
}

/**
 * Draw styled pivot cells for a non-empty pivot region.
 * This renders the pivot data with Excel-like styling (no grid lines,
 * banded rows, bold headers, hierarchy indentation, expand/collapse icons).
 */
function drawStyledPivotView(overlayCtx: OverlayRenderContext, pivotView: PivotViewResponse): void {
  const { ctx, region } = overlayCtx;
  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);
  const canvasWidth = ctx.canvas.width / (window.devicePixelRatio || 1);
  const canvasHeight = ctx.canvas.height / (window.devicePixelRatio || 1);

  const theme = DEFAULT_PIVOT_THEME;

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    canvasWidth - rowHeaderWidth,
    canvasHeight - colHeaderHeight,
  );
  ctx.clip();

  for (let i = 0; i < pivotView.rows.length; i++) {
    const row = pivotView.rows[i];
    if (!row.visible) continue;

    const gridRow = region.startRow + i;
    const y = overlayGetRowY(overlayCtx, gridRow);
    const height = overlayGetRowHeight(overlayCtx, gridRow);

    // Skip rows completely outside visible area
    if (y + height < colHeaderHeight || y > canvasHeight) continue;

    for (let j = 0; j < row.cells.length; j++) {
      const cell = row.cells[j];
      const gridCol = region.startCol + j;
      const x = overlayGetColumnX(overlayCtx, gridCol);
      const width = overlayGetColumnWidth(overlayCtx, gridCol);

      // Skip cells completely outside visible area
      if (x + width < rowHeaderWidth || x > canvasWidth) continue;

      const cellResult: PivotCellDrawResult = drawPivotCell(ctx, cell, x, y, width, height, i, j, theme);

      // Store expand/collapse icon bounds for click handling
      if (cellResult.iconBounds) {
        const pivotId = (region.data?.pivotId as number) ?? 0;
        const key = `${pivotId}-${gridRow}-${gridCol}`;
        overlayIconBounds.set(key, {
          x: cellResult.iconBounds.x,
          y: cellResult.iconBounds.y,
          width: cellResult.iconBounds.width,
          height: cellResult.iconBounds.height,
          gridRow,
          gridCol,
          isExpanded: cellResult.iconBounds.isExpanded,
          pivotId,
        });
      }
    }
  }

  // Draw separator line between row labels and data columns
  const rowLabelColCount = pivotView.rowLabelColCount || 0;
  if (rowLabelColCount > 0) {
    const separatorCol = region.startCol + rowLabelColCount;
    const sepX = overlayGetColumnX(overlayCtx, separatorCol);
    if (sepX > rowHeaderWidth && sepX < canvasWidth) {
      ctx.strokeStyle = theme.borderColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const regionY = overlayGetRowY(overlayCtx, region.startRow);
      const regionEndY = overlayGetRowY(overlayCtx, region.startRow + pivotView.rows.length);
      ctx.moveTo(Math.floor(sepX) + 0.5, Math.max(regionY, colHeaderHeight));
      ctx.lineTo(Math.floor(sepX) + 0.5, Math.min(regionEndY, canvasHeight));
      ctx.stroke();
    }
  }

  // Draw separator line below header rows
  const headerRowCount = pivotView.columnHeaderRowCount || 0;
  if (headerRowCount > 0) {
    const headerEndRow = region.startRow + headerRowCount;
    const sepY = overlayGetRowY(overlayCtx, headerEndRow);
    if (sepY > colHeaderHeight && sepY < canvasHeight) {
      ctx.strokeStyle = theme.headerBorderColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const regionX = overlayGetColumnX(overlayCtx, region.startCol);
      const regionEndX = overlayGetColumnX(overlayCtx, region.startCol + (pivotView.rows[0]?.cells.length || 0));
      ctx.moveTo(Math.max(regionX, rowHeaderWidth), Math.floor(sepY) - 0.5);
      ctx.lineTo(Math.min(regionEndX, canvasWidth), Math.floor(sepY) - 0.5);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * Draw placeholder text for empty pivot regions.
 * Shows "Click in this area to work with the PivotTable report".
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

  ctx.fillStyle = "#888888";
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const centerX = startX + regionWidth / 2;
  const centerY = startY + regionHeight / 2;

  if (regionWidth > 120 && regionHeight > 30) {
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
async function refreshPivotRegions(triggerRepaint: boolean = false): Promise<void> {
  try {
    const regions = await getPivotRegionsForSheet();

    // Fetch and cache pivot view data for styled rendering
    await refreshPivotViewCache(regions);

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
      data: { isEmpty: r.isEmpty, pivotId: r.pivotId },
    }));

    // Replace all pivot regions in the overlay system
    removeGridRegionsByType("pivot");
    setGridRegions(gridRegions);

    // Notify other components (selection handler, etc.)
    emitAppEvent(PivotEvents.PIVOT_REGIONS_UPDATED, { regions });

    // Only trigger grid repaint when NOT already inside a grid:refresh cycle
    if (triggerRepaint) {
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  } catch (error) {
    console.error("[Pivot Extension] Failed to fetch pivot regions:", error);
    removeGridRegionsByType("pivot");
    emitAppEvent(PivotEvents.PIVOT_REGIONS_UPDATED, { regions: [] });
  }
}

// Cleanup functions for event listeners
let cleanupFunctions: Array<() => void> = [];

/**
 * Register the pivot table extension.
 * Call this during application initialization.
 */
export function registerPivotExtension(): void {
  console.log("[Pivot Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(PivotManifest);

  // Register task pane view
  TaskPaneExtensions.registerView(PivotPaneDefinition);

  // Register dialogs
  DialogExtensions.registerDialog(PivotDialogDefinition);
  DialogExtensions.registerDialog(PivotGroupDialogDefinition);

  // Register context menu items for right-click in pivot regions
  cleanupFunctions.push(registerPivotContextMenuItems());

  // Register overlays
  OverlayExtensions.registerOverlay(PivotFilterOverlayDefinition);

  // Register edit guard - block editing in pivot regions
  cleanupFunctions.push(
    registerEditGuard(async (row, col) => {
      try {
        const pivotInfo = await getPivotAtCell(row, col);
        if (pivotInfo) {
          return { blocked: true, message: "You can't change this part of the PivotTable." };
        }
      } catch (error) {
        console.error("[Pivot Extension] Failed to check pivot region:", error);
      }
      return null;
    })
  );

  // Register click interceptor - handle expand/collapse icon clicks
  cleanupFunctions.push(
    registerCellClickInterceptor(async (row, col, event) => {
      // Check if click is within any stored expand/collapse icon bounds
      if (!cachedCanvasElement) return false;
      const canvas = cachedCanvasElement;

      const rect = canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;

      for (const bounds of overlayIconBounds.values()) {
        if (
          canvasX >= bounds.x &&
          canvasX <= bounds.x + bounds.width &&
          canvasY >= bounds.y &&
          canvasY <= bounds.y + bounds.height
        ) {
          // Found a matching icon - toggle expand/collapse
          const cachedView = pivotViewCache.get(bounds.pivotId);
          if (!cachedView) return false;

          // Find the pivot-relative row/col
          const pivotRowIndex = bounds.gridRow - (gridRegionsCache.get(bounds.pivotId)?.startRow ?? 0);
          const pivotColIndex = bounds.gridCol - (gridRegionsCache.get(bounds.pivotId)?.startCol ?? 0);

          const pivotRow = cachedView.rows[pivotRowIndex];
          if (!pivotRow) return false;
          const cell = pivotRow.cells[pivotColIndex];
          if (!cell) return false;

          const itemLabel = cell.formattedValue;
          const fieldIndex = pivotColIndex; // col position maps to row field index

          try {
            await togglePivotGroup({
              pivotId: bounds.pivotId,
              isRow: true,
              fieldIndex,
              value: itemLabel,
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
    registerCellClickInterceptor(async (row, col, event) => {
      try {
        const pivotInfo = await getPivotAtCell(row, col);
        if (!pivotInfo?.filterZones) return false;

        for (const zone of pivotInfo.filterZones) {
          if (zone.row === row && zone.col === col) {
            emitAppEvent(PivotEvents.PIVOT_OPEN_FILTER_MENU, {
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
    })
  );

  // Register grid overlay renderer for pivot placeholder regions
  cleanupFunctions.push(
    registerGridOverlay({
      type: "pivot",
      render: (ctx: OverlayRenderContext) => {
        // Clear icon bounds at start of each render cycle
        clearOverlayIconBounds();

        // Cache reference to the canvas element for use in click handlers
        cachedCanvasElement = ctx.ctx.canvas;

        // Always draw white background to hide underlying grid lines and cell text
        drawPivotBackground(ctx);

        if (ctx.region.data?.isEmpty) {
          drawPivotPlaceholderText(ctx);
        } else {
          // Draw styled pivot cells with Excel-like appearance
          const pivotId = ctx.region.data?.pivotId as number | undefined;
          if (pivotId !== undefined) {
            const cachedView = pivotViewCache.get(pivotId);
            if (cachedView) {
              drawStyledPivotView(ctx, cachedView);
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
      priority: 10,
    })
  );

  // Subscribe to events
  cleanupFunctions.push(
    onAppEvent<{ pivotId: number }>(PivotEvents.PIVOT_CREATED, handlePivotCreated)
  );

  cleanupFunctions.push(
    onAppEvent<{
      fieldIndex: number;
      fieldName: string;
      row: number;
      col: number;
      anchorX: number;
      anchorY: number;
    }>(PivotEvents.PIVOT_OPEN_FILTER_MENU, handleOpenFilterMenu)
  );

  // Subscribe to selection changes to show/hide the pivot editor pane
  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange)
  );

  // Subscribe to pivot region updates to cache region bounds locally
  cleanupFunctions.push(
    onAppEvent<{ regions: PivotRegionData[] }>(
      PivotEvents.PIVOT_REGIONS_UPDATED,
      (detail) => updateCachedRegions(detail.regions)
    )
  );

  // Listen for pivot:refresh events (from filter changes, field updates, etc.)
  // These need a repaint since the grid isn't already refreshing.
  const handlePivotRefresh = () => { refreshPivotRegions(true); };
  window.addEventListener("pivot:refresh", handlePivotRefresh);
  cleanupFunctions.push(() => window.removeEventListener("pivot:refresh", handlePivotRefresh));

  // Also refresh regions when grid refreshes (sheet switch, etc.)
  // Do NOT trigger another repaint (triggerRepaint=false) to avoid infinite loop.
  const handleGridRefreshForRegions = () => { refreshPivotRegions(false); };
  window.addEventListener("grid:refresh", handleGridRefreshForRegions);
  cleanupFunctions.push(() => window.removeEventListener("grid:refresh", handleGridRefreshForRegions));

  // Listen for task pane reopen requests (e.g., from View menu "Show" action)
  const handleReopenRequest = (e: Event) => {
    const detail = (e as CustomEvent<{ viewId: string }>).detail;
    if (detail?.viewId === PIVOT_PANE_ID) {
      forceRecheck();
    }
  };
  window.addEventListener("taskpane:requestReopen", handleReopenRequest);
  cleanupFunctions.push(() => window.removeEventListener("taskpane:requestReopen", handleReopenRequest));

  // Initial region load
  refreshPivotRegions(false);

  console.log("[Pivot Extension] Registered successfully");
}

/**
 * Unregister the pivot table extension.
 * Call this during application shutdown or hot reload.
 */
export function unregisterPivotExtension(): void {
  console.log("[Pivot Extension] Unregistering...");

  // Cleanup event listeners
  cleanupFunctions.forEach((fn) => fn());
  cleanupFunctions = [];

  // Reset handler state
  resetSelectionHandlerState();

  // Clear overlay regions
  removeGridRegionsByType("pivot");

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(PivotManifest.id);
  TaskPaneExtensions.unregisterView(PIVOT_PANE_ID);
  DialogExtensions.unregisterDialog(PIVOT_DIALOG_ID);
  DialogExtensions.unregisterDialog(PIVOT_GROUP_DIALOG_ID);
  OverlayExtensions.unregisterOverlay(PIVOT_FILTER_OVERLAY_ID);

  console.log("[Pivot Extension] Unregistered successfully");
}

// Re-export for convenience
export { PIVOT_PANE_ID, PIVOT_DIALOG_ID, PIVOT_GROUP_DIALOG_ID, PIVOT_FILTER_OVERLAY_ID };
