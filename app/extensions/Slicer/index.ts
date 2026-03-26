//! FILENAME: app/extensions/Slicer/index.ts
// PURPOSE: Slicer extension entry point.
// CONTEXT: Registers all slicer functionality with the extension system:
//          grid overlays, event handlers, dialog, contextual ribbon tab.

import {
  ExtensionRegistry,
  DialogExtensions,
  onAppEvent,
  AppEvents,
} from "../../src/api";
import {
  registerGridOverlay,
  type OverlayRenderContext,
} from "../../src/api/gridOverlays";
import { getGridStateSnapshot } from "../../src/api/state";

import {
  SlicerManifest,
  InsertSlicerDialogDefinition,
} from "./manifest";

import {
  selectSlicer,
  handleSelectionChange,
  resetSelectionHandlerState,
} from "./handlers/selectionHandler";

import {
  refreshCache,
  resetStore,
  getSlicerById,
  updateSlicerPositionAsync,
  updateSlicerSelectionAsync,
  getCachedItems,
} from "./lib/slicerStore";

import { renderSlicer, hitTestSlicer, getSlicerHitDetail } from "./rendering/slicerRenderer";
import { applySlicerFilter } from "./lib/slicerFilterBridge";
import { SlicerEvents } from "./lib/slicerEvents";

// ============================================================================
// Module State
// ============================================================================

let cleanupFunctions: Array<() => void> = [];

/** Cached reference to grid container for coordinate conversion. */
let gridContainer: HTMLElement | null = null;

/** Pending click: set on floatingObject:selected, consumed on mouseup. */
let pendingClick: { slicerId: number } | null = null;

// ============================================================================
// Extension Lifecycle
// ============================================================================

/**
 * Register the slicer extension.
 * Call this during application initialization.
 */
export function registerSlicerExtension(): void {
  console.log("[Slicer Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(SlicerManifest);

  // Register dialog
  DialogExtensions.registerDialog(InsertSlicerDialogDefinition);

  // Register grid overlay renderer for slicer panels
  cleanupFunctions.push(
    registerGridOverlay({
      type: "slicer",
      render: (ctx: OverlayRenderContext) => {
        renderSlicer(ctx);
      },
      hitTest: hitTestSlicer,
      priority: 15, // Above selection and table borders
    }),
  );

  // -----------------------------------------------------------------------
  // Floating object events (selection, move, resize)
  // -----------------------------------------------------------------------

  // Handle floating object selection (mousedown on slicer body)
  // Sets a pending click that will be processed on mouseup.
  const handleFloatingSelected = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "slicer") return;

    const slicerId = detail.data?.slicerId as number;
    if (slicerId == null) return;

    // Select the slicer (shows contextual ribbon tab)
    selectSlicer(slicerId);

    // Set pending click — processed on mouseup if not a drag
    pendingClick = { slicerId };
  };
  window.addEventListener("floatingObject:selected", handleFloatingSelected);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:selected", handleFloatingSelected);
  });

  // Handle floating object move completion (drag ended)
  const handleMoveComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "slicer") return;

    // Clear pending click — this was a drag, not a click
    pendingClick = null;

    const slicerId = detail.data?.slicerId as number;
    if (slicerId == null) return;

    const slicer = getSlicerById(slicerId);
    if (!slicer) return;

    updateSlicerPositionAsync(
      slicerId,
      detail.x,
      detail.y,
      slicer.width,
      slicer.height,
    ).catch(console.error);
  };
  window.addEventListener("floatingObject:moveComplete", handleMoveComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:moveComplete", handleMoveComplete);
  });

  // Handle floating object resize completion
  const handleResizeComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "slicer") return;

    const slicerId = detail.data?.slicerId as number;
    if (slicerId == null) return;

    updateSlicerPositionAsync(
      slicerId,
      detail.x,
      detail.y,
      detail.width,
      detail.height,
    ).catch(console.error);
  };
  window.addEventListener("floatingObject:resizeComplete", handleResizeComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:resizeComplete", handleResizeComplete);
  });

  // -----------------------------------------------------------------------
  // Mouseup handler: process deferred slicer clicks
  // -----------------------------------------------------------------------

  const handleMouseUp = (e: MouseEvent) => {
    if (!pendingClick) return;

    const { slicerId } = pendingClick;
    pendingClick = null;

    // Compute canvas coordinates directly from this mouseup event
    if (!gridContainer) {
      gridContainer = document.querySelector("canvas")?.parentElement ?? null;
    }
    if (!gridContainer) return;

    const rect = gridContainer.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    console.log("[Slicer] mouseup click at canvas (%d, %d) for slicer %d", canvasX, canvasY, slicerId);
    handleSlicerClickAt(slicerId, canvasX, canvasY, e.ctrlKey || e.metaKey);
  };
  window.addEventListener("mouseup", handleMouseUp);
  cleanupFunctions.push(() => {
    window.removeEventListener("mouseup", handleMouseUp);
  });

  // -----------------------------------------------------------------------
  // Grid selection changes (deselect slicer when user clicks on a cell)
  // -----------------------------------------------------------------------

  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange),
  );

  // -----------------------------------------------------------------------
  // Sheet change (refresh visible slicers)
  // -----------------------------------------------------------------------

  cleanupFunctions.push(
    onAppEvent(AppEvents.SHEET_CHANGED, () => {
      refreshCache().catch(console.error);
    }),
  );

  // -----------------------------------------------------------------------
  // Filter bridge: apply filters when slicer selection changes
  // -----------------------------------------------------------------------

  const handleSelectionChanged = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const slicerId = detail?.slicerId as number;
    if (slicerId == null) return;

    const slicer = getSlicerById(slicerId);
    if (slicer) {
      applySlicerFilter(slicer).catch(console.error);
    }
  };
  window.addEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, handleSelectionChanged);
  cleanupFunctions.push(() => {
    window.removeEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, handleSelectionChanged);
  });

  // -----------------------------------------------------------------------
  // Initial cache load
  // -----------------------------------------------------------------------

  refreshCache().catch(console.error);

  console.log("[Slicer Extension] Registered successfully");
}

/**
 * Unregister the slicer extension.
 */
export function unregisterSlicerExtension(): void {
  console.log("[Slicer Extension] Unregistering...");

  for (const cleanup of cleanupFunctions) {
    cleanup();
  }
  cleanupFunctions = [];

  resetSelectionHandlerState();
  resetStore();
  gridContainer = null;
  pendingClick = null;

  console.log("[Slicer Extension] Unregistered");
}

// ============================================================================
// Internal: Slicer Click Handling
// ============================================================================

/**
 * Handle a click on a slicer at specific canvas coordinates.
 * Called from the mouseup handler with coordinates from the mouse event.
 */
function handleSlicerClickAt(
  slicerId: number,
  canvasX: number,
  canvasY: number,
  ctrlHeld: boolean,
): void {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return;

  // Get scroll offset and header sizes from the grid state snapshot
  const gridState = getGridStateSnapshot();
  if (!gridState) return;

  const scrollX = gridState.viewport.scrollX;
  const scrollY = gridState.viewport.scrollY;
  const headerWidth = gridState.config.rowHeaderWidth;
  const headerHeight = gridState.config.colHeaderHeight;

  // Convert slicer sheet-space position to canvas-space
  const bounds = {
    x: slicer.x - scrollX + headerWidth,
    y: slicer.y - scrollY + headerHeight,
    width: slicer.width,
    height: slicer.height,
  };

  const hit = getSlicerHitDetail(canvasX, canvasY, bounds, slicerId);
  console.log("[Slicer] hitDetail: %o, bounds: %o, canvas: (%d, %d)", hit, bounds, canvasX, canvasY);
  if (!hit) return;

  switch (hit.type) {
    case "clearButton":
      // Clear filter (all selected)
      updateSlicerSelectionAsync(slicerId, null).catch(console.error);
      break;

    case "item":
      handleItemClick(slicerId, hit.itemIndex!, hit.itemValue!, ctrlHeld);
      break;

    case "header":
    case "body":
      // Just selection (already handled above via selectSlicer)
      break;
  }
}

/**
 * Handle click on a slicer item.
 * Click = exclusive select (only that item).
 * Ctrl+click = toggle (additive).
 */
function handleItemClick(
  slicerId: number,
  _itemIndex: number,
  itemValue: string,
  ctrlHeld: boolean,
): void {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return;

  const items = getCachedItems(slicerId);
  if (!items) return;

  if (ctrlHeld) {
    // Toggle this item in the current selection
    if (slicer.selectedItems === null) {
      // All selected -> deselect this one item (select all except this one)
      const allValues = items.map((i) => i.value);
      const newSelection = allValues.filter((v) => v !== itemValue);
      updateSlicerSelectionAsync(slicerId, newSelection).catch(console.error);
    } else {
      const isCurrentlySelected = slicer.selectedItems.includes(itemValue);
      if (isCurrentlySelected) {
        // Deselect this item
        const newSelection = slicer.selectedItems.filter((v) => v !== itemValue);
        if (newSelection.length === 0) {
          // Can't deselect all - keep at least this one
          return;
        }
        updateSlicerSelectionAsync(slicerId, newSelection).catch(console.error);
      } else {
        // Add this item to selection
        const newSelection = [...slicer.selectedItems, itemValue];
        // If all items are now selected, set to null (all selected)
        if (newSelection.length >= items.length) {
          updateSlicerSelectionAsync(slicerId, null).catch(console.error);
        } else {
          updateSlicerSelectionAsync(slicerId, newSelection).catch(console.error);
        }
      }
    }
  } else {
    // Exclusive select: only this item
    if (
      slicer.selectedItems !== null &&
      slicer.selectedItems.length === 1 &&
      slicer.selectedItems[0] === itemValue
    ) {
      // Clicking the only selected item again -> select all (clear filter)
      updateSlicerSelectionAsync(slicerId, null).catch(console.error);
    } else {
      updateSlicerSelectionAsync(slicerId, [itemValue]).catch(console.error);
    }
  }
}
