//! FILENAME: app/extensions/Tablix/index.ts
// PURPOSE: Tablix extension entry point.
// CONTEXT: Registers all tablix functionality with the extension system.

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
} from '../../src/api';

import { TablixEvents } from './lib/tablixEvents';

import {
  registerGridOverlay,
  setGridRegions,
  removeGridRegionsByType,
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnsWidth,
  overlayGetRowsHeight,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  type GridRegion,
  type OverlayRenderContext,
} from '../../src/api/gridOverlays';

import {
  TablixManifest,
  TablixPaneDefinition,
  TablixDialogDefinition,
  TablixFilterOverlayDefinition,
  TABLIX_PANE_ID,
  TABLIX_DIALOG_ID,
  TABLIX_FILTER_OVERLAY_ID,
} from './manifest';

import { getTablixRegionsForSheet, getTablixAtCell } from './lib/tablix-api';
import type { TablixRegionData } from './types';

// ============================================================================
// Tablix Placeholder Overlay Renderer
// ============================================================================

/**
 * Draw tablix placeholder for empty tablix regions.
 * Shows a white rectangle with a light border to indicate the reserved area.
 */
function drawTablixPlaceholder(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  const startX = overlayGetColumnX(overlayCtx, region.startCol);
  const startY = overlayGetRowY(overlayCtx, region.startRow);
  const regionWidth = overlayGetColumnsWidth(overlayCtx, region.startCol, region.endCol);
  const regionHeight = overlayGetRowsHeight(overlayCtx, region.startRow, region.endRow);

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
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(startX, startY, regionWidth, regionHeight);

  // Draw light gray border
  ctx.strokeStyle = '#d0d0d0';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(
    Math.floor(startX) + 0.5,
    Math.floor(startY) + 0.5,
    regionWidth - 1,
    regionHeight - 1,
  );

  // Draw "Tablix" text in center
  ctx.fillStyle = '#888888';
  ctx.font = '12px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const centerX = startX + regionWidth / 2;
  const centerY = startY + regionHeight / 2;

  if (regionWidth > 80 && regionHeight > 30) {
    ctx.fillText('Tablix', centerX, centerY - 8);
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText('Drag fields to build', centerX, centerY + 8);
  }

  ctx.restore();
}

// ============================================================================
// Tablix Region Management
// ============================================================================

/**
 * Fetch tablix regions from the backend and register them with the overlay system.
 */
async function refreshTablixRegions(triggerRepaint: boolean = false): Promise<void> {
  try {
    const regions = await getTablixRegionsForSheet();

    const gridRegions: GridRegion[] = regions.map((r: TablixRegionData) => ({
      id: `tablix-${r.tablixId}`,
      type: 'tablix',
      startRow: r.startRow,
      startCol: r.startCol,
      endRow: r.endRow,
      endCol: r.endCol,
      data: { isEmpty: r.isEmpty, tablixId: r.tablixId },
    }));

    removeGridRegionsByType('tablix');
    setGridRegions(gridRegions);

    emitAppEvent(TablixEvents.TABLIX_REGIONS_UPDATED, { regions });

    if (triggerRepaint) {
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  } catch (error) {
    console.error('[Tablix Extension] Failed to fetch tablix regions:', error);
    removeGridRegionsByType('tablix');
    emitAppEvent(TablixEvents.TABLIX_REGIONS_UPDATED, { regions: [] });
  }
}

// Cleanup functions for event listeners
let cleanupFunctions: Array<() => void> = [];

// ============================================================================
// Temporary handler stubs (will be replaced with full implementations)
// ============================================================================

/** Cached tablix regions for fast local bounds checking. */
let cachedRegions: TablixRegionData[] = [];
let lastCheckedSelection: { row: number; col: number } | null = null;
let checkInProgress = false;

function updateCachedRegions(regions: TablixRegionData[]): void {
  cachedRegions = regions;
}

function findTablixRegionAtCell(row: number, col: number): TablixRegionData | null {
  for (const region of cachedRegions) {
    if (
      row >= region.startRow &&
      row <= region.endRow &&
      col >= region.startCol &&
      col <= region.endCol
    ) {
      return region;
    }
  }
  return null;
}

// Import task pane APIs
import {
  openTaskPane,
  closeTaskPane,
  getTaskPaneManuallyClosed,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
} from '../../src/api';

function handleSelectionChange(
  selection: { endRow: number; endCol: number } | null,
): void {
  if (!selection) return;

  const row = selection.endRow;
  const col = selection.endCol;

  if (
    lastCheckedSelection &&
    lastCheckedSelection.row === row &&
    lastCheckedSelection.col === col
  ) {
    return;
  }

  if (checkInProgress) return;

  const localRegion = findTablixRegionAtCell(row, col);

  if (localRegion === null) {
    lastCheckedSelection = { row, col };
    removeTaskPaneContextKey('tablix');
    closeTaskPane(TABLIX_PANE_ID);
    return;
  }

  addTaskPaneContextKey('tablix');

  const manuallyClosed = getTaskPaneManuallyClosed();
  if (manuallyClosed.includes(TABLIX_PANE_ID)) {
    lastCheckedSelection = { row, col };
    return;
  }

  // Debounce and fetch full details
  setTimeout(() => {
    checkTablixAtSelection(row, col);
  }, 50);
}

async function checkTablixAtSelection(row: number, col: number): Promise<void> {
  checkInProgress = true;
  lastCheckedSelection = { row, col };

  try {
    const tablixInfo = await getTablixAtCell(row, col);

    if (tablixInfo) {
      const paneData = {
        tablixId: tablixInfo.tablixId,
        sourceFields: tablixInfo.sourceFields,
        initialRowGroups: tablixInfo.fieldConfiguration.rowGroups,
        initialColumnGroups: tablixInfo.fieldConfiguration.columnGroups,
        initialDataFields: tablixInfo.fieldConfiguration.dataFields,
        initialFilters: tablixInfo.fieldConfiguration.filterFields,
        initialLayout: tablixInfo.fieldConfiguration.layout,
      };

      openTaskPane(TABLIX_PANE_ID, paneData as unknown as Record<string, unknown>);
    } else {
      closeTaskPane(TABLIX_PANE_ID);
    }
  } catch (error) {
    console.error('[Tablix Extension] Failed to check tablix at selection:', error);
  } finally {
    checkInProgress = false;
  }
}

function handleTablixCreated(detail: { tablixId: number }): void {
  console.log('[Tablix Extension] Tablix created:', detail.tablixId);
  refreshTablixRegions(true);
}

function resetSelectionHandlerState(): void {
  cachedRegions = [];
  lastCheckedSelection = null;
  checkInProgress = false;
}

function forceRecheck(): void {
  const savedSelection = lastCheckedSelection;
  lastCheckedSelection = null;
  checkInProgress = false;
  if (savedSelection) {
    handleSelectionChange({ endRow: savedSelection.row, endCol: savedSelection.col });
  }
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register the tablix extension.
 * Call this during application initialization.
 */
export function registerTablixExtension(): void {
  console.log('[Tablix Extension] Registering...');

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(TablixManifest);

  // Register task pane view
  TaskPaneExtensions.registerView(TablixPaneDefinition);

  // Register dialogs
  DialogExtensions.registerDialog(TablixDialogDefinition);

  // Register overlays
  OverlayExtensions.registerOverlay(TablixFilterOverlayDefinition);

  // Register edit guard - block editing in tablix regions
  cleanupFunctions.push(
    registerEditGuard(async (row, col) => {
      try {
        const tablixInfo = await getTablixAtCell(row, col);
        if (tablixInfo) {
          return { blocked: true, message: "You can't change this part of the Tablix." };
        }
      } catch (error) {
        console.error('[Tablix Extension] Failed to check tablix region:', error);
      }
      return null;
    })
  );

  // Register click interceptor - handle filter dropdown clicks
  cleanupFunctions.push(
    registerCellClickInterceptor(async (row, col, event) => {
      try {
        const tablixInfo = await getTablixAtCell(row, col);
        if (!tablixInfo?.filterZones) return false;

        for (const zone of tablixInfo.filterZones) {
          if (zone.row === row && zone.col === col) {
            emitAppEvent(TablixEvents.TABLIX_OPEN_FILTER_MENU, {
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
        console.error('[Tablix Extension] Failed to check tablix filter:', error);
      }
      return false;
    })
  );

  // Register grid overlay renderer for tablix placeholder regions
  cleanupFunctions.push(
    registerGridOverlay({
      type: 'tablix',
      render: (ctx: OverlayRenderContext) => {
        if (ctx.region.data?.isEmpty) {
          drawTablixPlaceholder(ctx);
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
    onAppEvent<{ tablixId: number }>(TablixEvents.TABLIX_CREATED, handleTablixCreated)
  );

  // Subscribe to selection changes to show/hide the tablix editor pane
  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange)
  );

  // Subscribe to tablix region updates
  cleanupFunctions.push(
    onAppEvent<{ regions: TablixRegionData[] }>(
      TablixEvents.TABLIX_REGIONS_UPDATED,
      (detail) => updateCachedRegions(detail.regions)
    )
  );

  // Listen for tablix:refresh events
  const handleTablixRefresh = () => { refreshTablixRegions(true); };
  window.addEventListener('tablix:refresh', handleTablixRefresh);
  cleanupFunctions.push(() => window.removeEventListener('tablix:refresh', handleTablixRefresh));

  // Refresh regions when grid refreshes (sheet switch, etc.)
  const handleGridRefreshForRegions = () => { refreshTablixRegions(false); };
  window.addEventListener('grid:refresh', handleGridRefreshForRegions);
  cleanupFunctions.push(() => window.removeEventListener('grid:refresh', handleGridRefreshForRegions));

  // Listen for task pane reopen requests
  const handleReopenRequest = (e: Event) => {
    const detail = (e as CustomEvent<{ viewId: string }>).detail;
    if (detail?.viewId === TABLIX_PANE_ID) {
      forceRecheck();
    }
  };
  window.addEventListener('taskpane:requestReopen', handleReopenRequest);
  cleanupFunctions.push(() => window.removeEventListener('taskpane:requestReopen', handleReopenRequest));

  // Initial region load
  refreshTablixRegions(false);

  console.log('[Tablix Extension] Registered successfully');
}

/**
 * Unregister the tablix extension.
 * Call this during application shutdown or hot reload.
 */
export function unregisterTablixExtension(): void {
  console.log('[Tablix Extension] Unregistering...');

  cleanupFunctions.forEach((fn) => fn());
  cleanupFunctions = [];

  resetSelectionHandlerState();

  removeGridRegionsByType('tablix');

  ExtensionRegistry.unregisterAddIn(TablixManifest.id);
  TaskPaneExtensions.unregisterView(TABLIX_PANE_ID);
  DialogExtensions.unregisterDialog(TABLIX_DIALOG_ID);
  OverlayExtensions.unregisterOverlay(TABLIX_FILTER_OVERLAY_ID);

  console.log('[Tablix Extension] Unregistered successfully');
}

// Re-export for convenience
export { TABLIX_PANE_ID, TABLIX_DIALOG_ID, TABLIX_FILTER_OVERLAY_ID };
