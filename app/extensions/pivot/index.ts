//! FILENAME: app/extensions/pivot/index.ts
// PURPOSE: Pivot table extension entry point.
// CONTEXT: Registers all pivot functionality with the extension system.

import {
  ExtensionRegistry,
  TaskPaneExtensions,
  DialogExtensions,
  OverlayExtensions,
  AppEvents,
  onAppEvent,
  emitAppEvent,
  registerEditGuard,
  registerCellClickInterceptor,
  registerCellDoubleClickInterceptor,
} from "../../src/api";

import { PivotEvents } from "./lib/pivotEvents";

import {
  registerGridOverlay,
  addGridRegions,
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
} from "../../src/api/gridOverlays";

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
} from "./handlers/selectionHandler";
import type { PivotRegionData } from "./types";
import { getPivotRegionsForSheet, getPivotAtCell, getPivotView, togglePivotGroup } from "./lib/pivot-api";
import type { PivotViewResponse } from "./lib/pivot-api";
import {
  cachePivotView,
  setCachedPivotView,
  getCachedPivotView,
  deleteCachedPivotView,
  isCacheFresh,
  consumeFreshFlag,
} from "./lib/pivotViewStore";
import { drawPivotCell, DEFAULT_PIVOT_THEME } from "./rendering/pivot";
import type { PivotCellDrawResult } from "./rendering/pivot";

// Re-export cache accessors so existing consumers (e.g., context menu) keep working
export { cachePivotView, getCachedPivotView };

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

/** Clear all stored icon bounds (called at start of each render cycle). */
function clearOverlayIconBounds(): void {
  overlayIconBounds.clear();
  overlayHeaderFilterBounds.clear();
  overlayFilterDropdownBounds.clear();
}

/** Cache of pivot region bounds keyed by pivotId, for coordinate conversion in click handlers. */
const gridRegionsCache = new Map<number, { startRow: number; startCol: number; endRow: number; endCol: number }>();

/** Cached reference to the grid canvas element, captured during overlay rendering. */
let cachedCanvasElement: HTMLCanvasElement | null = null;

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
 * Fetch and cache pivot view data for all non-empty pivot regions.
 * Skips the IPC call if the cache already has data for the pivot (e.g., from
 * a preceding updatePivotFields or togglePivotGroup call that cached the result).
 */
async function refreshPivotViewCache(regions: PivotRegionData[]): Promise<void> {
  for (const r of regions) {
    if (!r.isEmpty) {
      // Only skip the fetch if the cache was JUST populated by updatePivotFields
      // or togglePivotGroup in this same refresh cycle (fresh flag set).
      // Other refresh paths (filters, dialogs, context menu) must always re-fetch.
      if (isCacheFresh(r.pivotId)) {
        const existing = getCachedPivotView(r.pivotId);
        consumeFreshFlag(r.pivotId);
        console.log(`[PERF][pivot] refreshPivotViewCache pivot_id=${r.pivotId} SKIPPED (fresh cache v${existing?.version})`);
        continue;
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
function drawPivotBackground(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  const startX = overlayGetColumnX(overlayCtx, region.startCol);
  const startY = overlayGetRowY(overlayCtx, region.startRow);

  // During transitions, extend the white fill to cover the old (larger) region
  // so stale cached cells aren't visible while refreshCells is in flight.
  const pivotId = region.data?.pivotId as number | undefined;
  let fillEndRow = region.endRow;
  let fillEndCol = region.endCol;
  if (pivotId !== undefined) {
    const prev = transitionBounds.get(pivotId);
    if (prev) {
      fillEndRow = Math.max(fillEndRow, prev.endRow);
      fillEndCol = Math.max(fillEndCol, prev.endCol);
    }
  }

  const fillWidth = overlayGetColumnsWidth(overlayCtx, region.startCol, fillEndCol);
  const fillHeight = overlayGetRowsHeight(overlayCtx, region.startRow, fillEndRow);

  if (startX + fillWidth < rowHeaderWidth || startY + fillHeight < colHeaderHeight) {
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

  // White fill over extended area (covers stale cells during transition)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(startX, startY, fillWidth, fillHeight);

  // Border only around the actual current region
  const regionWidth = overlayGetColumnsWidth(overlayCtx, region.startCol, region.endCol);
  const regionHeight = overlayGetRowsHeight(overlayCtx, region.startRow, region.endRow);
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
  const t0 = performance.now();
  const { ctx, region } = overlayCtx;
  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);
  const canvasWidth = ctx.canvas.width / (window.devicePixelRatio || 1);
  const canvasHeight = ctx.canvas.height / (window.devicePixelRatio || 1);

  const theme = DEFAULT_PIVOT_THEME;

  // Pre-compute whether each zone has active filters (for header filter icon)
  const rowHasActiveFilter = pivotView.rowFieldSummaries?.some(f => f.hasActiveFilter) ?? false;
  const colHasActiveFilter = pivotView.columnFieldSummaries?.some(f => f.hasActiveFilter) ?? false;

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
      if (x + width < rowHeaderWidth || x > canvasWidth) { cellsSkipped++; continue; }

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
          isRow: cellResult.iconBounds.isRow,
          pivotId,
        });
      }

      // Store filter dropdown button bounds for click handling
      if (cellResult.filterButtonBounds) {
        const pivotId = (region.data?.pivotId as number) ?? 0;
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
        const pivotId = (region.data?.pivotId as number) ?? 0;
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

  const drawMs = performance.now() - t0;
  console.log(
    `[PERF][pivot] drawStyledPivotView rows=${pivotView.rows.length} cols=${pivotView.rows[0]?.cells.length ?? 0} | drawn=${cellsDrawn} skipped=${cellsSkipped} | render=${drawMs.toFixed(1)}ms`
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
async function refreshPivotRegions(triggerRepaint: boolean = false): Promise<void> {
  // Re-entry guard: when we dispatch "grid:refresh" below, the pivot extension's
  // own grid:refresh listener would call us again. Skip that redundant call.
  if (isRefreshingPivotRegions) return;
  isRefreshingPivotRegions = true;

  const tTotal = performance.now();
  try {
    const t0 = performance.now();
    const regions = await getPivotRegionsForSheet();
    const regionsMs = performance.now() - t0;

    // Fetch and cache pivot view data for styled rendering
    const t1 = performance.now();
    await refreshPivotViewCache(regions);
    const cacheMs = performance.now() - t1;

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
  DialogExtensions.registerDialog(PivotFieldSettingsDialogDefinition);
  DialogExtensions.registerDialog(PivotOptionsDialogDefinition);

  // Register context menu items for right-click in pivot regions
  cleanupFunctions.push(registerPivotContextMenuItems());

  // Register overlays
  OverlayExtensions.registerOverlay(PivotFilterOverlayDefinition);
  OverlayExtensions.registerOverlay(PivotHeaderFilterOverlayDefinition);

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
    registerCellClickInterceptor(async (_row, _col, event) => {
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
        }
      }
      return false;
    })
  );

  // Register click interceptor - handle header filter button clicks (Row Labels / Column Labels)
  cleanupFunctions.push(
    registerCellClickInterceptor(async (_row, _col, event) => {
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
          emitAppEvent(PivotEvents.PIVOT_OPEN_HEADER_FILTER_MENU, {
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
    registerCellDoubleClickInterceptor(async (row, col, event) => {
      // Check if double-click is on a +/- icon → just consume it (no toggle).
      // The single-click interceptor already handled the toggle; if we toggled
      // again here the state would flip back (double-toggle bug).
      if (cachedCanvasElement) {
        const rect = cachedCanvasElement.getBoundingClientRect();
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;

        for (const bounds of overlayIconBounds.values()) {
          if (
            canvasX >= bounds.x &&
            canvasX <= bounds.x + bounds.width &&
            canvasY >= bounds.y &&
            canvasY <= bounds.y + bounds.height
          ) {
            // Consume the double-click without toggling again
            return true;
          }
        }
      }

      // Check if double-click is on an expandable row header → toggle hierarchy
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
            const cachedView = getCachedPivotView(pivotId);
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
      renderBelowSelection: true,
    })
  );

  // Track cursor state to avoid redundant style changes
  let currentCursorOverride = false;

  // Add mousemove handler for cursor changes on expand/collapse icon hover
  const handleCanvasMouseMove = (event: MouseEvent) => {
    if (!cachedCanvasElement) return;
    const rect = cachedCanvasElement.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    let isOverInteractive = false;
    for (const bounds of overlayIconBounds.values()) {
      if (
        canvasX >= bounds.x &&
        canvasX <= bounds.x + bounds.width &&
        canvasY >= bounds.y &&
        canvasY <= bounds.y + bounds.height
      ) {
        isOverInteractive = true;
        break;
      }
    }

    if (!isOverInteractive) {
      for (const bounds of overlayHeaderFilterBounds.values()) {
        if (
          canvasX >= bounds.x &&
          canvasX <= bounds.x + bounds.width &&
          canvasY >= bounds.y &&
          canvasY <= bounds.y + bounds.height
        ) {
          isOverInteractive = true;
          break;
        }
      }
    }

    if (!isOverInteractive) {
      for (const bounds of overlayFilterDropdownBounds.values()) {
        if (
          canvasX >= bounds.x &&
          canvasX <= bounds.x + bounds.width &&
          canvasY >= bounds.y &&
          canvasY <= bounds.y + bounds.height
        ) {
          isOverInteractive = true;
          break;
        }
      }
    }

    if (isOverInteractive && !currentCursorOverride) {
      cachedCanvasElement.style.cursor = "pointer";
      currentCursorOverride = true;
    } else if (!isOverInteractive && currentCursorOverride) {
      cachedCanvasElement.style.cursor = "";
      currentCursorOverride = false;
    }
  };

  // Attach the mousemove handler to the document (canvas may not exist yet)
  // We use document-level listener and check if event target is the canvas
  const handleDocMouseMove = (event: MouseEvent) => {
    if (cachedCanvasElement && (event.target === cachedCanvasElement || cachedCanvasElement.contains(event.target as Node))) {
      handleCanvasMouseMove(event);
    } else if (currentCursorOverride && cachedCanvasElement) {
      cachedCanvasElement.style.cursor = "";
      currentCursorOverride = false;
    }
  };
  document.addEventListener("mousemove", handleDocMouseMove);
  cleanupFunctions.push(() => {
    document.removeEventListener("mousemove", handleDocMouseMove);
    if (cachedCanvasElement && currentCursorOverride) {
      cachedCanvasElement.style.cursor = "";
    }
  });

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

  // Subscribe to header filter menu events (Row Labels / Column Labels)
  cleanupFunctions.push(
    onAppEvent<{
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

  // Refresh pivot regions when the active sheet changes (e.g., after creating a
  // pivot on a new sheet). Without this, the placeholder overlay never appears
  // because the sheet switch happens after the initial region load.
  cleanupFunctions.push(
    onAppEvent(AppEvents.SHEET_CHANGED, () => {
      refreshPivotRegions(false);
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

  // Clear transition state
  transitionBounds.clear();
  if (transitionCleanupTimer) {
    clearTimeout(transitionCleanupTimer);
    transitionCleanupTimer = null;
  }

  // Clear overlay regions
  removeGridRegionsByType("pivot");

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(PivotManifest.id);
  TaskPaneExtensions.unregisterView(PIVOT_PANE_ID);
  DialogExtensions.unregisterDialog(PIVOT_DIALOG_ID);
  DialogExtensions.unregisterDialog(PIVOT_GROUP_DIALOG_ID);
  OverlayExtensions.unregisterOverlay(PIVOT_FILTER_OVERLAY_ID);
  OverlayExtensions.unregisterOverlay(PIVOT_HEADER_FILTER_OVERLAY_ID);

  console.log("[Pivot Extension] Unregistered successfully");
}

// Re-export for convenience
export { PIVOT_PANE_ID, PIVOT_DIALOG_ID, PIVOT_GROUP_DIALOG_ID, PIVOT_FILTER_OVERLAY_ID, PIVOT_HEADER_FILTER_OVERLAY_ID };
