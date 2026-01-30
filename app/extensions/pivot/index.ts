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
} from "../../src/api";

import {
  registerGridOverlay,
  setGridRegions,
  removeGridRegionsByType,
  type GridRegion,
  type OverlayRenderContext,
} from "../../src/api/gridOverlays";

import {
  PivotManifest,
  PivotPaneDefinition,
  PivotDialogDefinition,
  PivotFilterOverlayDefinition,
  PIVOT_PANE_ID,
  PIVOT_DIALOG_ID,
  PIVOT_FILTER_OVERLAY_ID,
} from "./manifest";

import { handlePivotCreated } from "./handlers/pivotCreatedHandler";
import { handleOpenFilterMenu } from "./handlers/filterMenuHandler";
import {
  handleSelectionChange,
  updateCachedRegions,
  resetSelectionHandlerState,
} from "./handlers/selectionHandler";
import type { PivotRegionData } from "./types";
import { getPivotRegionsForSheet } from "./lib/pivot-api";

// ============================================================================
// Pivot Placeholder Overlay Renderer
// ============================================================================

/** Helper: get column width from config/dimensions */
function getColWidth(col: number, config: { defaultCellWidth?: number }, dims: { columnWidths: Map<number, number> }): number {
  return dims.columnWidths.get(col) ?? config.defaultCellWidth ?? 100;
}

/** Helper: get row height from config/dimensions */
function getRowHt(row: number, config: { defaultCellHeight?: number }, dims: { rowHeights: Map<number, number> }): number {
  return dims.rowHeights.get(row) ?? config.defaultCellHeight ?? 24;
}

/**
 * Draw pivot table placeholder for empty pivot regions.
 * Shows a white rectangle with a light border to indicate the reserved area.
 */
function drawPivotPlaceholder(overlayCtx: OverlayRenderContext): void {
  const { ctx, region, config, viewport, dimensions } = overlayCtx;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  // Calculate pixel positions for the region
  let startX = rowHeaderWidth;
  for (let col = 0; col < region.startCol; col++) {
    startX += getColWidth(col, config, dimensions);
  }
  startX -= viewport.scrollX;

  let startY = colHeaderHeight;
  for (let row = 0; row < region.startRow; row++) {
    startY += getRowHt(row, config, dimensions);
  }
  startY -= viewport.scrollY;

  // Calculate width and height of the region
  let regionWidth = 0;
  for (let col = region.startCol; col <= region.endCol; col++) {
    regionWidth += getColWidth(col, config, dimensions);
  }

  let regionHeight = 0;
  for (let row = region.startRow; row <= region.endRow; row++) {
    regionHeight += getRowHt(row, config, dimensions);
  }

  // Only draw if visible
  if (startX + regionWidth < rowHeaderWidth || startY + regionHeight < colHeaderHeight) {
    return;
  }

  // Clip to cell area (not headers)
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    ctx.canvas.width / (window.devicePixelRatio || 1) - rowHeaderWidth,
    ctx.canvas.height / (window.devicePixelRatio || 1) - colHeaderHeight,
  );
  ctx.clip();

  // Draw white background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(startX, startY, regionWidth, regionHeight);

  // Draw light gray border
  ctx.strokeStyle = "#d0d0d0";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(
    Math.floor(startX) + 0.5,
    Math.floor(startY) + 0.5,
    regionWidth - 1,
    regionHeight - 1,
  );

  // Draw "PivotTable" text in center (like Excel's placeholder)
  ctx.fillStyle = "#888888";
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const centerX = startX + regionWidth / 2;
  const centerY = startY + regionHeight / 2;

  // Only draw text if there's enough space
  if (regionWidth > 80 && regionHeight > 30) {
    ctx.fillText("PivotTable", centerX, centerY - 8);
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("Drag fields to build", centerX, centerY + 8);
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
    emitAppEvent(AppEvents.PIVOT_REGIONS_UPDATED, { regions });

    // Only trigger grid repaint when NOT already inside a grid:refresh cycle
    if (triggerRepaint) {
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  } catch (error) {
    console.error("[Pivot Extension] Failed to fetch pivot regions:", error);
    removeGridRegionsByType("pivot");
    emitAppEvent(AppEvents.PIVOT_REGIONS_UPDATED, { regions: [] });
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

  // Register overlays
  OverlayExtensions.registerOverlay(PivotFilterOverlayDefinition);

  // Register grid overlay renderer for pivot placeholder regions
  cleanupFunctions.push(
    registerGridOverlay({
      type: "pivot",
      render: (ctx: OverlayRenderContext) => {
        if (ctx.region.data?.isEmpty) {
          drawPivotPlaceholder(ctx);
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
    onAppEvent<{ pivotId: number }>(AppEvents.PIVOT_CREATED, handlePivotCreated)
  );

  cleanupFunctions.push(
    onAppEvent<{
      fieldIndex: number;
      fieldName: string;
      row: number;
      col: number;
      anchorX: number;
      anchorY: number;
    }>(AppEvents.PIVOT_OPEN_FILTER_MENU, handleOpenFilterMenu)
  );

  // Subscribe to selection changes to show/hide the pivot editor pane
  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange)
  );

  // Subscribe to pivot region updates to cache region bounds locally
  cleanupFunctions.push(
    onAppEvent<{ regions: PivotRegionData[] }>(
      AppEvents.PIVOT_REGIONS_UPDATED,
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
  OverlayExtensions.unregisterOverlay(PIVOT_FILTER_OVERLAY_ID);

  console.log("[Pivot Extension] Unregistered successfully");
}

// Re-export for convenience
export { PIVOT_PANE_ID, PIVOT_DIALOG_ID, PIVOT_FILTER_OVERLAY_ID };
