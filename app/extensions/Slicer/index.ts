//! FILENAME: app/extensions/Slicer/index.ts
// PURPOSE: Slicer extension entry point.
// CONTEXT: Registers all slicer functionality with the extension system:
//          grid overlays, event handlers, dialog, contextual ribbon tab.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  AppEvents,
} from "@api";
import {
  requestOverlayRedraw,
  type OverlayRenderContext,
} from "@api/gridOverlays";
import { getGridStateSnapshot } from "@api/state";

import {
  SlicerManifest,
  InsertSlicerDialogDefinition,
  SlicerSettingsDialogDefinition,
  SlicerComputedPropsDialogDefinition,
  SlicerConnectionsDialogDefinition,
} from "./manifest";

import {
  selectSlicer,
  handleSelectionChange,
  resetSelectionHandlerState,
  getSelectedSlicerIds,
  isSlicerSelected,
  broadcastSelectedSlicers,
} from "./handlers/selectionHandler";

import {
  handleSlicerContextMenu,
  closeSlicerContextMenu,
} from "./handlers/slicerContextMenu";

import {
  refreshCache,
  resetStore,
  getSlicerById,
  getAllSlicers,
  updateSlicerPositionAsync,
  updateSlicerSelectionAsync,
  getCachedItems,
  updateCachedSlicerPosition,
  updateCachedSlicerBounds,
  refreshSlicerItems,
} from "./lib/slicerStore";

import {
  renderSlicer,
  hitTestSlicer,
  getSlicerHitDetail,
  getSlicerCursor,
  getScrollOffset,
  setScrollOffset,
  getMaxScrollOffset,
  resetScrollOffsets,
} from "./rendering/slicerRenderer";
import { applySlicerFilter } from "./lib/slicerFilterBridge";
import { SlicerEvents } from "./lib/slicerEvents";

// ============================================================================
// Module State
// ============================================================================

let cleanupFunctions: Array<() => void> = [];

/** Cached reference to grid container for coordinate conversion. */
let gridContainer: HTMLElement | null = null;

/** Pending click: set on floatingObject:selected, consumed on mouseup.
 *  deferNarrow: when true, mouseup should narrow multi-selection to this single slicer. */
let pendingClick: { slicerId: number; deferNarrow?: boolean } | null = null;

/** Track last mousedown modifier state (since floatingObject:selected doesn't carry it). */
let lastMousedownCtrl = false;

/**
 * Snapshot of all selected slicers' positions at drag start.
 * Used to compute deltas for multi-move.
 */
let dragStartPositions: Map<number, { x: number; y: number }> | null = null;

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[Slicer Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(SlicerManifest);

  // Register dialogs
  context.ui.dialogs.register(InsertSlicerDialogDefinition);
  context.ui.dialogs.register(SlicerSettingsDialogDefinition);
  context.ui.dialogs.register(SlicerComputedPropsDialogDefinition);
  context.ui.dialogs.register(SlicerConnectionsDialogDefinition);

  // Register grid overlay renderer for slicer panels
  cleanupFunctions.push(
    context.grid.overlays.register({
      type: "slicer",
      render: (ctx: OverlayRenderContext) => {
        renderSlicer(ctx);
      },
      hitTest: hitTestSlicer,
      getCursor: getSlicerCursor,
      priority: 15, // Above selection and table borders
    }),
  );

  // -----------------------------------------------------------------------
  // Floating object events (selection, move, resize)
  // -----------------------------------------------------------------------

  // Capture modifier key state on mousedown (before floatingObject:selected fires).
  // We use a window-level capture listener so it fires before the Core's handler.
  const handleMousedownModifiers = (e: MouseEvent) => {
    lastMousedownCtrl = e.ctrlKey || e.metaKey;
  };
  window.addEventListener("mousedown", handleMousedownModifiers, true);
  cleanupFunctions.push(() => {
    window.removeEventListener("mousedown", handleMousedownModifiers, true);
  });

  // Handle floating object selection (mousedown on slicer body)
  // Sets a pending click that will be processed on mouseup.
  const handleFloatingSelected = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "slicer") return;

    const slicerId = detail.data?.slicerId as number;
    if (slicerId == null) return;

    const alreadySelected = isSlicerSelected(slicerId);
    const wasMultiSelected = getSelectedSlicerIds().size > 1;

    // If this slicer is already part of a multi-selection and it's a plain
    // click (no Ctrl), DON'T narrow the selection yet — the user may be
    // about to drag the group.  We'll narrow to single on mouseup instead.
    if (alreadySelected && wasMultiSelected && !lastMousedownCtrl) {
      // Keep multi-selection intact for potential multi-drag.
      // Ensure the ribbon tab is still showing.
      broadcastSelectedSlicers();
    } else {
      selectSlicer(slicerId, lastMousedownCtrl);
    }

    // Snapshot positions of ALL selected slicers for potential multi-move
    dragStartPositions = new Map();
    for (const id of getSelectedSlicerIds()) {
      const s = getSlicerById(id);
      if (s) dragStartPositions.set(id, { x: s.x, y: s.y });
    }

    // Set pending click — processed on mouseup if not a drag.
    // deferNarrow = true when we deferred narrowing the multi-selection.
    pendingClick = { slicerId, deferNarrow: alreadySelected && wasMultiSelected && !lastMousedownCtrl };
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

    const primaryId = detail.data?.slicerId as number;
    if (primaryId == null) return;

    const primaryStart = dragStartPositions?.get(primaryId);
    if (!primaryStart) {
      // Single slicer move (not multi-selected)
      const slicer = getSlicerById(primaryId);
      if (slicer) {
        updateSlicerPositionAsync(primaryId, detail.x, detail.y, slicer.width, slicer.height)
          .catch(console.error);
      }
    } else {
      // Multi-move: compute delta from primary slicer and apply to all selected
      const dx = detail.x - primaryStart.x;
      const dy = detail.y - primaryStart.y;

      for (const [id, startPos] of dragStartPositions!) {
        const slicer = getSlicerById(id);
        if (!slicer) continue;
        const newX = Math.max(0, startPos.x + dx);
        const newY = Math.max(0, startPos.y + dy);
        updateSlicerPositionAsync(id, newX, newY, slicer.width, slicer.height)
          .catch(console.error);
      }
    }

    dragStartPositions = null;
    // Re-broadcast so the ribbon tab picks up final positions
    broadcastSelectedSlicers();
  };
  window.addEventListener("floatingObject:moveComplete", handleMoveComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:moveComplete", handleMoveComplete);
  });

  // Handle floating object move preview (smooth drag animation)
  // NOTE: Do NOT clear pendingClick here! The Core dispatches movePreview for
  // every mousemove (even <3px). Only moveComplete (which requires >3px movement)
  // should clear it, so that simple clicks still reach the mouseup handler.
  const handleMovePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "slicer") return;

    const primaryId = detail.data?.slicerId as number;
    if (primaryId == null) return;

    const primaryStart = dragStartPositions?.get(primaryId);
    if (!primaryStart) {
      // Single slicer move
      updateCachedSlicerPosition(primaryId, detail.x, detail.y);
    } else {
      // Multi-move: apply same delta to all selected slicers
      const dx = detail.x - primaryStart.x;
      const dy = detail.y - primaryStart.y;

      for (const [id, startPos] of dragStartPositions!) {
        const newX = Math.max(0, startPos.x + dx);
        const newY = Math.max(0, startPos.y + dy);
        updateCachedSlicerPosition(id, newX, newY);
      }
    }

    requestOverlayRedraw();
  };
  window.addEventListener("floatingObject:movePreview", handleMovePreview);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:movePreview", handleMovePreview);
  });

  // Handle floating object resize preview (smooth resize animation)
  const handleResizePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "slicer") return;

    const slicerId = detail.data?.slicerId as number;
    if (slicerId == null) return;

    updateCachedSlicerBounds(slicerId, detail.x, detail.y, detail.width, detail.height);
    requestOverlayRedraw();
  };
  window.addEventListener("floatingObject:resizePreview", handleResizePreview);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:resizePreview", handleResizePreview);
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

    const { slicerId, deferNarrow } = pendingClick;
    pendingClick = null;
    dragStartPositions = null;

    // If we deferred narrowing a multi-selection to this single slicer
    // (because the user might have been about to drag the group), do it now.
    if (deferNarrow) {
      selectSlicer(slicerId, false);
    }

    // Compute canvas coordinates directly from this mouseup event
    if (!gridContainer) {
      gridContainer = document.querySelector("[data-grid-area]") as HTMLElement | null;
    }
    if (!gridContainer) return;

    const rect = gridContainer.getBoundingClientRect();
    // Divide by zoom to convert CSS pixels to logical canvas coordinates
    // (the core's mouse handling does the same division)
    const gridState = getGridStateSnapshot();
    const zoom = gridState?.zoom ?? 1.0;
    const canvasX = (e.clientX - rect.left) / zoom;
    const canvasY = (e.clientY - rect.top) / zoom;

    handleSlicerClickAt(slicerId, canvasX, canvasY, e.ctrlKey || e.metaKey);
  };
  window.addEventListener("mouseup", handleMouseUp);
  cleanupFunctions.push(() => {
    window.removeEventListener("mouseup", handleMouseUp);
  });

  // -----------------------------------------------------------------------
  // Context menu: right-click on slicer
  // -----------------------------------------------------------------------

  const handleContextMenu = (e: MouseEvent) => {
    if (!gridContainer) {
      gridContainer = document.querySelector("[data-grid-area]") as HTMLElement | null;
    }
    handleSlicerContextMenu(e, gridContainer);
  };
  // Use capture phase to intercept before the grid's context menu handler
  window.addEventListener("contextmenu", handleContextMenu, true);
  cleanupFunctions.push(() => {
    window.removeEventListener("contextmenu", handleContextMenu, true);
  });

  // -----------------------------------------------------------------------
  // Mouse wheel: scroll slicer item list
  // -----------------------------------------------------------------------

  const handleWheel = (e: WheelEvent) => {
    if (!gridContainer) {
      gridContainer = document.querySelector("[data-grid-area]") as HTMLElement | null;
    }
    if (!gridContainer) return;

    const rect = gridContainer.getBoundingClientRect();
    const gridState = getGridStateSnapshot();
    if (!gridState) return;

    const zoom = gridState.zoom ?? 1.0;
    const canvasX = (e.clientX - rect.left) / zoom;
    const canvasY = (e.clientY - rect.top) / zoom;

    const activeSheet = gridState.sheetContext.activeSheetIndex;
    const slicers = getAllSlicers().filter((s) => s.sheetIndex === activeSheet);
    const scrollX = gridState.viewport.scrollX;
    const scrollY = gridState.viewport.scrollY;
    const headerWidth = gridState.config.rowHeaderWidth;
    const headerHeight = gridState.config.colHeaderHeight;

    for (let i = slicers.length - 1; i >= 0; i--) {
      const slicer = slicers[i];
      const bx = slicer.x - scrollX + headerWidth;
      const by = slicer.y - scrollY + headerHeight;

      if (
        canvasX >= bx && canvasX <= bx + slicer.width &&
        canvasY >= by && canvasY <= by + slicer.height
      ) {
        // Only scroll if the slicer has overflowing content
        const maxScroll = getMaxScrollOffset(slicer.id);
        if (maxScroll <= 0) return;

        e.preventDefault();
        e.stopPropagation();

        const current = getScrollOffset(slicer.id);
        setScrollOffset(slicer.id, current + e.deltaY);
        requestOverlayRedraw();
        return;
      }
    }
  };
  // Use capture phase so we intercept before the grid scrolls
  window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
  cleanupFunctions.push(() => {
    window.removeEventListener("wheel", handleWheel, true);
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
    context.events.on(AppEvents.SHEET_CHANGED, () => {
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
      applySlicerFilter(slicer).then(() => {
        // Cross-slicer filtering: refresh items for sibling slicers
        // (same source) so they show updated has_data state.
        // Siblings are slicers that share at least one connected source
        const slicerConnectedKeys = new Set(
          (slicer.connectedSources ?? []).map((c) => `${c.sourceType}:${c.sourceId}`),
        );
        const siblings = getAllSlicers().filter(
          (s) =>
            s.id !== slicerId &&
            (s.connectedSources ?? []).some((c) =>
              slicerConnectedKeys.has(`${c.sourceType}:${c.sourceId}`),
            ),
        );
        return Promise.all(
          siblings.map((s) => refreshSlicerItems(s.id)),
        );
      }).then(() => {
        requestOverlayRedraw();
      }).catch(console.error);
    }
  };
  window.addEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, handleSelectionChanged);
  cleanupFunctions.push(() => {
    window.removeEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, handleSelectionChanged);
  });

  // -----------------------------------------------------------------------
  // Cross-filter: refresh slicer items when a ribbon filter selection changes
  // -----------------------------------------------------------------------

  const handleRibbonFilterChanged = async () => {
    // Refresh items for all slicers so has_data is updated
    const slicers = getAllSlicers();
    await Promise.all(slicers.map((s) => refreshSlicerItems(s.id)));
    requestOverlayRedraw();
  };
  window.addEventListener("ribbonFilter:selectionChanged", handleRibbonFilterChanged);
  cleanupFunctions.push(() => {
    window.removeEventListener("ribbonFilter:selectionChanged", handleRibbonFilterChanged);
  });

  // -----------------------------------------------------------------------
  // Slicer computed property refresh (triggered when cell changes affect slicers)
  // -----------------------------------------------------------------------

  const handleSlicerRefresh = () => {
    refreshCache().then(() => {
      requestOverlayRedraw();
    }).catch(console.error);
  };
  window.addEventListener("slicers:refresh", handleSlicerRefresh);
  cleanupFunctions.push(() => {
    window.removeEventListener("slicers:refresh", handleSlicerRefresh);
  });

  // -----------------------------------------------------------------------
  // Initial cache load
  // -----------------------------------------------------------------------

  refreshCache().catch(console.error);

  console.log("[Slicer Extension] Registered successfully");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[Slicer Extension] Unregistering...");

  for (const cleanup of cleanupFunctions) {
    cleanup();
  }
  cleanupFunctions = [];

  resetSelectionHandlerState();
  closeSlicerContextMenu();
  resetStore();
  resetScrollOffsets();
  gridContainer = null;
  pendingClick = null;
  dragStartPositions = null;

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(SlicerManifest.id);

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
  if (!hit) return;

  switch (hit.type) {
    case "clearButton":
      // Clear filter (all selected) — only if a filter is active
      if (slicer.selectedItems !== null) {
        updateSlicerSelectionAsync(slicerId, null).catch(console.error);
      }
      break;

    case "selectAll":
      // Toggle all selected
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
 * Behavior depends on the slicer's selectionMode:
 * - "standard": click = exclusive, Ctrl+click = toggle
 * - "single": click = exclusive only, Ctrl+click ignored
 * - "multi": click = toggle (like Ctrl+click in standard mode)
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

  const mode = slicer.selectionMode ?? "standard";

  // Determine if this is a toggle (multi-select) action
  const isToggle =
    mode === "multi" || (mode === "standard" && ctrlHeld);

  if (isToggle) {
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
          if (slicer.forceSelection) {
            // Force selection: can't deselect last item
            return;
          }
          // All deselected -> select all (clear filter)
          updateSlicerSelectionAsync(slicerId, null).catch(console.error);
        } else {
          updateSlicerSelectionAsync(slicerId, newSelection).catch(console.error);
        }
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
      if (slicer.forceSelection) {
        // Force selection: can't clear when only one item selected
        return;
      }
      // Clicking the only selected item again -> select all (clear filter)
      updateSlicerSelectionAsync(slicerId, null).catch(console.error);
    } else {
      updateSlicerSelectionAsync(slicerId, [itemValue]).catch(console.error);
    }
  }
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.slicer",
    name: "Slicer",
    version: "1.0.0",
    description: "Interactive slicer panels for filtering tables and pivot tables.",
  },
  activate,
  deactivate,
};

export default extension;
