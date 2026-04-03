//! FILENAME: app/extensions/TimelineSlicer/index.ts
// PURPOSE: Timeline slicer extension entry point.
// CONTEXT: Registers all timeline slicer functionality with the extension system:
//          grid overlays, event handlers, dialogs, contextual ribbon tab.

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
  TimelineSlicerManifest,
  InsertTimelineDialogDefinition,
  TimelineSettingsDialogDefinition,
} from "./manifest";

import {
  selectTimeline,
  handleSelectionChange,
  resetSelectionHandlerState,
  getSelectedTimelineIds,
  isTimelineSelected,
  broadcastSelectedTimelines,
} from "./handlers/selectionHandler";

import {
  handleTimelineContextMenu,
  closeTimelineContextMenu,
} from "./handlers/timelineSlicerContextMenu";

import {
  refreshCache,
  resetStore,
  getTimelineById,
  getAllTimelines,
  updateTimelinePositionAsync,
  updateTimelineSelectionAsync,
  getCachedTimelineData,
  updateCachedTimelinePosition,
  updateCachedTimelineBounds,
  refreshTimelineData,
} from "./lib/timelineSlicerStore";

import {
  renderTimelineSlicer,
  hitTestTimeline,
  getTimelineHitDetail,
  getTimelineCursor,
  getScrollOffset,
  setScrollOffset,
  getMaxScrollOffset,
  resetScrollOffsets,
} from "./rendering/timelineSlicerRenderer";
import { applyTimelineFilter } from "./lib/timelineSlicerFilterBridge";
import { TimelineSlicerEvents } from "./lib/timelineSlicerEvents";
import type { TimelineLevel } from "./lib/timelineSlicerTypes";

// ============================================================================
// Module State
// ============================================================================

let cleanupFunctions: Array<() => void> = [];
let gridContainer: HTMLElement | null = null;
let pendingClick: { timelineId: number; deferNarrow?: boolean } | null = null;
let lastMousedownCtrl = false;
let dragStartPositions: Map<number, { x: number; y: number }> | null = null;

/** Track period-drag state for range selection. */
let periodDragState: {
  timelineId: number;
  startPeriodIndex: number;
  currentPeriodIndex: number;
} | null = null;

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[TimelineSlicer Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(TimelineSlicerManifest);

  // Register dialogs
  context.ui.dialogs.register(InsertTimelineDialogDefinition);
  context.ui.dialogs.register(TimelineSettingsDialogDefinition);

  // Register grid overlay renderer
  cleanupFunctions.push(
    context.grid.overlays.register({
      type: "timeline-slicer",
      render: (ctx: OverlayRenderContext) => {
        renderTimelineSlicer(ctx);
      },
      hitTest: hitTestTimeline,
      getCursor: getTimelineCursor,
      priority: 16, // Above slicers
    }),
  );

  // -----------------------------------------------------------------------
  // Floating object events (selection, move, resize)
  // -----------------------------------------------------------------------

  const handleMousedownModifiers = (e: MouseEvent) => {
    lastMousedownCtrl = e.ctrlKey || e.metaKey;
  };
  window.addEventListener("mousedown", handleMousedownModifiers, true);
  cleanupFunctions.push(() => {
    window.removeEventListener("mousedown", handleMousedownModifiers, true);
  });

  // Handle floating object selection
  const handleFloatingSelected = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "timeline-slicer") return;

    const timelineId = detail.data?.timelineId as number;
    if (timelineId == null) return;

    const alreadySelected = isTimelineSelected(timelineId);
    const wasMultiSelected = getSelectedTimelineIds().size > 1;

    if (alreadySelected && wasMultiSelected && !lastMousedownCtrl) {
      broadcastSelectedTimelines();
    } else {
      selectTimeline(timelineId, lastMousedownCtrl);
    }

    // Snapshot positions for multi-move
    dragStartPositions = new Map();
    for (const id of getSelectedTimelineIds()) {
      const t = getTimelineById(id);
      if (t) dragStartPositions.set(id, { x: t.x, y: t.y });
    }

    pendingClick = {
      timelineId,
      deferNarrow: alreadySelected && wasMultiSelected && !lastMousedownCtrl,
    };
  };
  window.addEventListener("floatingObject:selected", handleFloatingSelected);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:selected", handleFloatingSelected);
  });

  // Handle floating object move completion
  const handleMoveComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "timeline-slicer") return;

    pendingClick = null;

    const primaryId = detail.data?.timelineId as number;
    if (primaryId == null) return;

    const primaryStart = dragStartPositions?.get(primaryId);
    if (!primaryStart) {
      const tl = getTimelineById(primaryId);
      if (tl) {
        updateTimelinePositionAsync(primaryId, detail.x, detail.y, tl.width, tl.height).catch(console.error);
      }
    } else {
      const dx = detail.x - primaryStart.x;
      const dy = detail.y - primaryStart.y;

      for (const [id, startPos] of dragStartPositions!) {
        const tl = getTimelineById(id);
        if (!tl) continue;
        const newX = Math.max(0, startPos.x + dx);
        const newY = Math.max(0, startPos.y + dy);
        updateTimelinePositionAsync(id, newX, newY, tl.width, tl.height).catch(console.error);
      }
    }

    dragStartPositions = null;
    broadcastSelectedTimelines();
  };
  window.addEventListener("floatingObject:moveComplete", handleMoveComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:moveComplete", handleMoveComplete);
  });

  // Handle floating object move preview
  const handleMovePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "timeline-slicer") return;

    const primaryId = detail.data?.timelineId as number;
    if (primaryId == null) return;

    const primaryStart = dragStartPositions?.get(primaryId);
    if (!primaryStart) {
      updateCachedTimelinePosition(primaryId, detail.x, detail.y);
    } else {
      const dx = detail.x - primaryStart.x;
      const dy = detail.y - primaryStart.y;
      for (const [id, startPos] of dragStartPositions!) {
        updateCachedTimelinePosition(id, Math.max(0, startPos.x + dx), Math.max(0, startPos.y + dy));
      }
    }

    requestOverlayRedraw();
  };
  window.addEventListener("floatingObject:movePreview", handleMovePreview);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:movePreview", handleMovePreview);
  });

  // Handle resize preview
  const handleResizePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "timeline-slicer") return;

    const timelineId = detail.data?.timelineId as number;
    if (timelineId == null) return;

    updateCachedTimelineBounds(timelineId, detail.x, detail.y, detail.width, detail.height);
    requestOverlayRedraw();
  };
  window.addEventListener("floatingObject:resizePreview", handleResizePreview);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:resizePreview", handleResizePreview);
  });

  // Handle resize completion
  const handleResizeComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "timeline-slicer") return;

    const timelineId = detail.data?.timelineId as number;
    if (timelineId == null) return;

    updateTimelinePositionAsync(timelineId, detail.x, detail.y, detail.width, detail.height).catch(console.error);
  };
  window.addEventListener("floatingObject:resizeComplete", handleResizeComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:resizeComplete", handleResizeComplete);
  });

  // -----------------------------------------------------------------------
  // Mouseup handler: process deferred clicks (period selection, level buttons)
  // -----------------------------------------------------------------------

  const handleMouseUp = (e: MouseEvent) => {
    // Finish any period drag
    if (periodDragState) {
      finishPeriodDrag();
      periodDragState = null;
      return;
    }

    if (!pendingClick) return;

    const { timelineId, deferNarrow } = pendingClick;
    pendingClick = null;
    dragStartPositions = null;

    if (deferNarrow) {
      selectTimeline(timelineId, false);
    }

    if (!gridContainer) {
      gridContainer = document.querySelector("[data-grid-area]") as HTMLElement | null;
    }
    if (!gridContainer) return;

    const rect = gridContainer.getBoundingClientRect();
    const gridState = getGridStateSnapshot();
    const zoom = gridState?.zoom ?? 1.0;
    const canvasX = (e.clientX - rect.left) / zoom;
    const canvasY = (e.clientY - rect.top) / zoom;

    handleTimelineClickAt(timelineId, canvasX, canvasY);
  };
  window.addEventListener("mouseup", handleMouseUp);
  cleanupFunctions.push(() => {
    window.removeEventListener("mouseup", handleMouseUp);
  });

  // -----------------------------------------------------------------------
  // Mousemove handler: period drag for range selection
  // -----------------------------------------------------------------------

  const handleMouseMove = (e: MouseEvent) => {
    if (!periodDragState) return;

    if (!gridContainer) {
      gridContainer = document.querySelector("[data-grid-area]") as HTMLElement | null;
    }
    if (!gridContainer) return;

    const rect = gridContainer.getBoundingClientRect();
    const gridState = getGridStateSnapshot();
    if (!gridState) return;

    const zoom = gridState.zoom ?? 1.0;
    const canvasX = (e.clientX - rect.left) / zoom;

    const tl = getTimelineById(periodDragState.timelineId);
    if (!tl) return;

    const data = getCachedTimelineData(periodDragState.timelineId);
    if (!data || data.periods.length === 0) return;

    const scrollX = gridState.viewport.scrollX;
    const headerWidth = gridState.config.rowHeaderWidth;
    const scrollY = gridState.viewport.scrollY;
    const headerHeight = gridState.config.colHeaderHeight;
    const bounds = {
      x: tl.x - scrollX + headerWidth,
      y: tl.y - scrollY + headerHeight,
      width: tl.width,
      height: tl.height,
    };

    const hit = getTimelineHitDetail(canvasX, (e.clientY - rect.top) / zoom, bounds, periodDragState.timelineId);
    if (hit?.type === "period" && hit.periodIndex != null) {
      periodDragState.currentPeriodIndex = hit.periodIndex;

      // Live preview: update selection
      const startIdx = Math.min(periodDragState.startPeriodIndex, periodDragState.currentPeriodIndex);
      const endIdx = Math.max(periodDragState.startPeriodIndex, periodDragState.currentPeriodIndex);
      const startPeriod = data.periods[startIdx];
      const endPeriod = data.periods[endIdx];

      if (startPeriod && endPeriod) {
        // Update locally for visual feedback
        tl.selectionStart = startPeriod.startDate;
        tl.selectionEnd = endPeriod.endDate;
        // Mark periods as selected for rendering
        for (const p of data.periods) {
          p.isSelected = p.index >= startIdx && p.index <= endIdx;
        }
        requestOverlayRedraw();
      }
    }
  };
  window.addEventListener("mousemove", handleMouseMove);
  cleanupFunctions.push(() => {
    window.removeEventListener("mousemove", handleMouseMove);
  });

  // -----------------------------------------------------------------------
  // Context menu
  // -----------------------------------------------------------------------

  const handleContextMenu = (e: MouseEvent) => {
    if (!gridContainer) {
      gridContainer = document.querySelector("[data-grid-area]") as HTMLElement | null;
    }
    handleTimelineContextMenu(e, gridContainer);
  };
  window.addEventListener("contextmenu", handleContextMenu, true);
  cleanupFunctions.push(() => {
    window.removeEventListener("contextmenu", handleContextMenu, true);
  });

  // -----------------------------------------------------------------------
  // Mouse wheel: scroll timeline horizontally
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
    const timelines = getAllTimelines().filter((t) => t.sheetIndex === activeSheet);
    const scrollX = gridState.viewport.scrollX;
    const scrollY = gridState.viewport.scrollY;
    const headerWidth = gridState.config.rowHeaderWidth;
    const headerHeight = gridState.config.colHeaderHeight;

    for (let i = timelines.length - 1; i >= 0; i--) {
      const tl = timelines[i];
      const bx = tl.x - scrollX + headerWidth;
      const by = tl.y - scrollY + headerHeight;

      if (
        canvasX >= bx && canvasX <= bx + tl.width &&
        canvasY >= by && canvasY <= by + tl.height
      ) {
        const maxScroll = getMaxScrollOffset(tl.id);
        if (maxScroll <= 0) return;

        e.preventDefault();
        e.stopPropagation();

        const current = getScrollOffset(tl.id);
        // Use deltaX for horizontal scroll, fall back to deltaY
        const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        setScrollOffset(tl.id, current + delta);
        requestOverlayRedraw();
        return;
      }
    }
  };
  window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
  cleanupFunctions.push(() => {
    window.removeEventListener("wheel", handleWheel, true);
  });

  // -----------------------------------------------------------------------
  // Grid selection changes
  // -----------------------------------------------------------------------

  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange),
  );

  // -----------------------------------------------------------------------
  // Sheet change
  // -----------------------------------------------------------------------

  cleanupFunctions.push(
    context.events.on(AppEvents.SHEET_CHANGED, () => {
      refreshCache().catch(console.error);
    }),
  );

  // -----------------------------------------------------------------------
  // Filter bridge: apply filters when timeline selection changes
  // -----------------------------------------------------------------------

  const handleSelectionChanged = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const timelineId = detail?.timelineId as number;
    if (timelineId == null) return;

    const tl = getTimelineById(timelineId);
    if (tl) {
      applyTimelineFilter(tl).catch(console.error);
    }
  };
  window.addEventListener(
    TimelineSlicerEvents.TIMELINE_SELECTION_CHANGED,
    handleSelectionChanged,
  );
  cleanupFunctions.push(() => {
    window.removeEventListener(
      TimelineSlicerEvents.TIMELINE_SELECTION_CHANGED,
      handleSelectionChanged,
    );
  });

  // -----------------------------------------------------------------------
  // Refresh on pivot changes
  // -----------------------------------------------------------------------

  const handlePivotRefresh = () => {
    refreshCache().then(() => requestOverlayRedraw()).catch(console.error);
  };
  window.addEventListener("pivot:refresh", handlePivotRefresh);
  cleanupFunctions.push(() => {
    window.removeEventListener("pivot:refresh", handlePivotRefresh);
  });

  // -----------------------------------------------------------------------
  // Initial cache load
  // -----------------------------------------------------------------------

  refreshCache().catch(console.error);

  console.log("[TimelineSlicer Extension] Registered successfully");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[TimelineSlicer Extension] Unregistering...");

  for (const cleanup of cleanupFunctions) {
    cleanup();
  }
  cleanupFunctions = [];

  resetSelectionHandlerState();
  closeTimelineContextMenu();
  resetStore();
  resetScrollOffsets();
  gridContainer = null;
  pendingClick = null;
  dragStartPositions = null;
  periodDragState = null;

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(TimelineSlicerManifest.id);

  console.log("[TimelineSlicer Extension] Unregistered");
}

// ============================================================================
// Internal: Timeline Click Handling
// ============================================================================

function handleTimelineClickAt(
  timelineId: number,
  canvasX: number,
  canvasY: number,
): void {
  const tl = getTimelineById(timelineId);
  if (!tl) return;

  const gridState = getGridStateSnapshot();
  if (!gridState) return;

  const scrollX = gridState.viewport.scrollX;
  const scrollY = gridState.viewport.scrollY;
  const headerWidth = gridState.config.rowHeaderWidth;
  const headerHeight = gridState.config.colHeaderHeight;

  const bounds = {
    x: tl.x - scrollX + headerWidth,
    y: tl.y - scrollY + headerHeight,
    width: tl.width,
    height: tl.height,
  };

  const hit = getTimelineHitDetail(canvasX, canvasY, bounds, timelineId);
  if (!hit) return;

  switch (hit.type) {
    case "clearButton":
      if (tl.selectionStart !== null) {
        updateTimelineSelectionAsync(timelineId, null, null).catch(console.error);
      }
      break;

    case "levelButton":
      if (hit.level) {
        import("./lib/timelineSlicerStore").then(({ updateTimelineAsync }) => {
          updateTimelineAsync(timelineId, { level: hit.level }).then(() => {
            requestOverlayRedraw();
          }).catch(console.error);
        });
      }
      break;

    case "period":
      if (hit.periodIndex != null) {
        handlePeriodClick(timelineId, hit.periodIndex);
      }
      break;

    case "header":
    case "body":
      break;
  }
}

function handlePeriodClick(timelineId: number, periodIndex: number): void {
  const data = getCachedTimelineData(timelineId);
  if (!data || periodIndex >= data.periods.length) return;

  const period = data.periods[periodIndex];

  // Start period drag for range selection
  periodDragState = {
    timelineId,
    startPeriodIndex: periodIndex,
    currentPeriodIndex: periodIndex,
  };

  // Immediate single-period selection
  updateTimelineSelectionAsync(
    timelineId,
    period.startDate,
    period.endDate,
  ).catch(console.error);
}

function finishPeriodDrag(): void {
  if (!periodDragState) return;

  const { timelineId, startPeriodIndex, currentPeriodIndex } = periodDragState;
  const data = getCachedTimelineData(timelineId);
  if (!data) return;

  const startIdx = Math.min(startPeriodIndex, currentPeriodIndex);
  const endIdx = Math.max(startPeriodIndex, currentPeriodIndex);
  const startPeriod = data.periods[startIdx];
  const endPeriod = data.periods[endIdx];

  if (startPeriod && endPeriod) {
    updateTimelineSelectionAsync(
      timelineId,
      startPeriod.startDate,
      endPeriod.endDate,
    ).catch(console.error);
  }
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.timeline-slicer",
    name: "Timeline Slicer",
    version: "1.0.0",
    description: "Timeline slicer panels for date-based filtering of tables and pivot tables.",
  },
  activate,
  deactivate,
};

export default extension;
