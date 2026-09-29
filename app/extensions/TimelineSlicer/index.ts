//! FILENAME: app/extensions/TimelineSlicer/index.ts
// PURPOSE: Timeline slicer extension entry point.
// CONTEXT: Registers all timeline slicer functionality with the extension system:
//          grid overlays, event handlers, dialogs, contextual ribbon tab.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  AppEvents,
  registerTimelineStoreService,
  isPointerClaimed,
} from "@api";
import {
  getGridRegions,
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
  deselectTimeline,
  handleSelectionChange,
  resetSelectionHandlerState,
  getSelectedTimelineIds,
  isTimelineSelected,
  dropTimelineFromSelection,
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
  createTimelineAsync,
  deleteTimelineAsync,
  commitTimelineGeometryAsync,
  updateTimelineSelectionAsync,
  getCachedTimelineData,
  updateCachedTimelinePosition,
  updateCachedTimelineBounds,
  refreshTimelineData,
  refreshCacheAndReconcile,
  isTimelineGestureLanding,
  type TimelineGeometryWrite,
} from "./lib/timelineSlicerStore";
import {
  coMovedMemberRect,
  refuseUndoWhileAGestureLands,
  registerObjectGeometryProvider,
} from "@api/objectGeometry";
import { createTimelineGeometryProvider } from "./lib/timelineGeometry";

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
import { timelineBackend } from "./lib/timelineBackend";
import { TimelineSlicerEvents } from "./lib/timelineSlicerEvents";
import type { TimelineLevel } from "./lib/timelineSlicerTypes";
import {
  armPendingTimelineClick,
  clearPendingTimelineClick,
  takePendingTimelineClick,
} from "./lib/timelinePendingClick";
import { registerTimelineObjectSelection } from "./lib/timelineObjectSelection";
import { timelineAtCanvasPoint, timelineCanvasBounds } from "./lib/timelineCanvasGeometry";

// ============================================================================
// Module State
// ============================================================================

let cleanupFunctions: Array<() => void> = [];
let gridContainer: HTMLElement | null = null;
// The pending click (armed on floatingObject:selected, consumed on mouseup)
// lives in lib/timelinePendingClick.ts, so the rule that only a real mouse
// press may arm it is testable.
let lastMousedownCtrl = false;
let dragStartPositions: Map<string, { x: number; y: number }> | null = null;

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[TimelineSlicer Extension] Registering...");

  // Bind the capability-scoped backend door for lib/store/component code that
  // runs outside ExtensionContext (A3). Must happen before any backend call.
  timelineBackend.set(context.invokeBackend);

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(TimelineSlicerManifest);

  // A keyboard Ctrl+Z / Ctrl+Y while a timeline selection's filter LANDS is
  // refused by the backend (W4); the keyboard says why, once.
  cleanupFunctions.push(refuseUndoWhileAGestureLands(isTimelineGestureLanding));

  // Register the timeline store service so scriptable timeline (date-range
  // slicer) contexts can read/write the selected range without importing this
  // extension.
  registerTimelineStoreService({
    getTimelineById(id: string) {
      const t = getTimelineById(id);
      if (!t) return undefined;
      return {
        name: t.name,
        selectionStart: t.selectionStart ?? null,
        selectionEnd: t.selectionEnd ?? null,
        fieldName: t.fieldName,
        level: String(t.level ?? ""),
        sourceType: String(t.sourceType ?? ""),
      };
    },
    getSelection(timelineId: string) {
      const t = getTimelineById(timelineId);
      return { start: t?.selectionStart ?? null, end: t?.selectionEnd ?? null };
    },
    async setSelection(timelineId: string, start: string | null, end: string | null) {
      await updateTimelineSelectionAsync(timelineId, start, end);
    },
  });

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

  // Keyboard / programmatic selection (@api/objectSelection): a canvas sheet's
  // Tab cycling selects timelines through this, never through the mouse route
  // below, which arms a pending click the next mouseup anywhere would complete.
  cleanupFunctions.push(registerTimelineObjectSelection());

  // Move / resize timelines WITHOUT a pointer gesture (@api/objectGeometry):
  // the canvas's align, distribute, nudge and group drag.
  cleanupFunctions.push(
    registerObjectGeometryProvider(
      createTimelineGeometryProvider({ afterCommit: () => broadcastSelectedTimelines() }),
    ),
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

    const timelineId = detail.data?.timelineId as string;
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

    armPendingTimelineClick({
      timelineId,
      deferNarrow: alreadySelected && wasMultiSelected && !lastMousedownCtrl,
    });
  };
  window.addEventListener("floatingObject:selected", handleFloatingSelected);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:selected", handleFloatingSelected);
  });

  // Where a timeline this drag CO-MOVES goes (a member of the selection, not
  // the pressed lead): the rule a Core-led canvas group drag applies
  // (@api/objectGeometry `coMovedMemberRect`) -- its press-time position
  // shifted by the lead's snapped delta, KEPT ON THE PAGE on a canvas, and a
  // LOCKED member stays put. It used to be clamped at 0 only.
  const coMovedTimelineAt = (
    tl: { id: string; sheetIndex: number; width: number; height: number },
    startPos: { x: number; y: number },
    dx: number,
    dy: number,
  ): { x: number; y: number } => {
    const region = getGridRegions().find((r) => r.id === `timeline-slicer-${tl.id}`) ?? null;
    const at = coMovedMemberRect(
      tl.sheetIndex,
      { x: startPos.x, y: startPos.y, width: tl.width, height: tl.height },
      { dx, dy },
      region,
    );
    return { x: at.x, y: at.y };
  };

  // Handle floating object move completion
  const handleMoveComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "timeline-slicer") return;

    clearPendingTimelineClick();

    const primaryId = detail.data?.timelineId as string;
    if (primaryId == null) return;

    // Every timeline this drag moved, persisted as ONE undo step (a canvas
    // group drag's open transaction is joined). A refusal (a protected sheet)
    // puts them back where the workbook has them and says so once.
    const writes: TimelineGeometryWrite[] = [];
    const primaryStart = dragStartPositions?.get(primaryId);
    if (!primaryStart) {
      const tl = getTimelineById(primaryId);
      if (tl) {
        writes.push({ timelineId: primaryId, x: detail.x, y: detail.y, width: tl.width, height: tl.height });
      }
    } else {
      const dx = detail.x - primaryStart.x;
      const dy = detail.y - primaryStart.y;

      for (const [id, startPos] of dragStartPositions!) {
        const tl = getTimelineById(id);
        if (!tl) continue;
        // The lead is where Core put it; every other member follows the
        // Core-led group-drag rule.
        const at = id === primaryId ? { x: detail.x, y: detail.y } : coMovedTimelineAt(tl, startPos, dx, dy);
        writes.push({ timelineId: id, x: at.x, y: at.y, width: tl.width, height: tl.height });
      }
    }

    dragStartPositions = null;
    void commitTimelineGeometryAsync(writes, writes.length > 1 ? "Move Timelines" : "Move Timeline").then(() => {
      broadcastSelectedTimelines();
    });
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

    const primaryId = detail.data?.timelineId as string;
    if (primaryId == null) return;

    const primaryStart = dragStartPositions?.get(primaryId);
    if (!primaryStart) {
      updateCachedTimelinePosition(primaryId, detail.x, detail.y);
    } else {
      const dx = detail.x - primaryStart.x;
      const dy = detail.y - primaryStart.y;
      for (const [id, startPos] of dragStartPositions!) {
        const tl = getTimelineById(id);
        if (!tl) continue;
        const at = id === primaryId ? { x: detail.x, y: detail.y } : coMovedTimelineAt(tl, startPos, dx, dy);
        updateCachedTimelinePosition(id, at.x, at.y);
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

    const timelineId = detail.data?.timelineId as string;
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

    const timelineId = detail.data?.timelineId as string;
    if (timelineId == null) return;

    void commitTimelineGeometryAsync(
      [{ timelineId, x: detail.x, y: detail.y, width: detail.width, height: detail.height }],
      "Resize Timeline",
    );
  };
  window.addEventListener("floatingObject:resizeComplete", handleResizeComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:resizeComplete", handleResizeComplete);
  });

  // -----------------------------------------------------------------------
  // Mouseup handler: process deferred clicks (period selection, level buttons)
  // -----------------------------------------------------------------------

  const handleMouseUp = (e: MouseEvent) => {
    const pendingClick = takePendingTimelineClick();
    if (!pendingClick) return;

    const { timelineId, deferNarrow } = pendingClick;
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

  // No period DRAG. A period is selected by the pending click, which completes
  // on MOUSEUP -- and it used to arm a "range drag" right there, with no
  // button held: hovering afterwards grew the selection, and the NEXT mouseup
  // anywhere (a click on a cell) committed it -- re-applying a period the user
  // had just undone (found live 2026-09-29, e2e fixall-pivot WF-D3). A press
  // on a timeline is Core's floating-object press (select, and move on drag),
  // so a drag-to-select range needs Core to leave the period strip to the
  // timeline first; recorded in docs/design/open-items.md.

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
    // This handler hit-tests by CLIENT POINT against the canvas, so it cannot
    // tell "the pointer is over my geometry" from "the pointer is over an
    // element some surface stacked on the grid put there". The DOM already
    // answered that; see core/lib/pointerClaims.ts.
    if (isPointerClaimed(e)) return;
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

    // The PAINTED gutters, and the topmost object decides: a timeline covered
    // by another object does not scroll behind it.
    const tl = timelineAtCanvasPoint(canvasX, canvasY);
    if (!tl) return;

    const maxScroll = getMaxScrollOffset(tl.id);
    if (maxScroll <= 0) return;

    e.preventDefault();
    e.stopPropagation();

    const current = getScrollOffset(tl.id);
    // Use deltaX for horizontal scroll, fall back to deltaY
    const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
    setScrollOffset(tl.id, current + delta);
    requestOverlayRedraw();
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
  // An application pull, refresh or detach can add or replace timelines
  // (they travel in the .calp as timeline_slicers.json): re-read.
  cleanupFunctions.push(
    context.events.on(AppEvents.PACKAGE_UPDATED, () => {
      refreshCache().catch(console.error);
    }),
  );

  // The filter a timeline selection puts on its pivots is applied by
  // `updateTimelineSelectionAsync` itself, as part of the same gesture (one
  // undo step for the pivots, one overwrite question). It used to be applied
  // here, fire-and-forget, from TIMELINE_SELECTION_CHANGED -- outside every
  // undo step and never asked about (BUG-0200).

  // -----------------------------------------------------------------------
  // Timeline deleted: deselect the deleted timeline so the contextual
  // ribbon tab is removed.
  // -----------------------------------------------------------------------

  // §3cd: the event now comes from `refreshCache`'s id diff rather than from
  // the frontend delete route, so it fires for a BACKEND CASCADE too -- delete
  // the pivot a timeline is sourced from, or the sheet it sits on, and this is
  // what takes the contextual tab down.
  const handleTimelineDeleted = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const deletedId = detail?.timelineId as string | undefined;
    if (deletedId != null) {
      dropTimelineFromSelection(deletedId);
    }
  };
  window.addEventListener(TimelineSlicerEvents.TIMELINE_DELETED, handleTimelineDeleted);
  cleanupFunctions.push(() => {
    window.removeEventListener(TimelineSlicerEvents.TIMELINE_DELETED, handleTimelineDeleted);
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

  // §3cd: the `slicer` DOMAIN covers BOTH slicer families -- `ObjectKind::Slicer`
  // and `ObjectKind::TimelineSlicer` map to it in object_deps.rs, because a
  // timeline whose pivot is gone is the same ghost overlay a canvas slicer is.
  // The Shell translator fans that domain out to "timelineslicers:refresh" as
  // well as "slicers:refresh"; until this listener existed, the domain's promise
  // held only by accident, because every route that announced "slicer" happened
  // to announce "pivot" too.
  //
  // It is also how an UNDO or REDO of a timeline selection reaches here, and a
  // plain re-read left the pivots filtered by the range just undone (a level-1
  // mask records no undo of its own): the re-read RECONCILES, re-deriving the
  // masks of every timeline the change moved and recording nothing.
  const handleTimelineRefresh = () => {
    refreshCacheAndReconcile().then(() => requestOverlayRedraw()).catch(console.error);
  };
  window.addEventListener("timelineslicers:refresh", handleTimelineRefresh);
  cleanupFunctions.push(() => {
    window.removeEventListener("timelineslicers:refresh", handleTimelineRefresh);
  });

  // -----------------------------------------------------------------------
  // Initial cache load
  // -----------------------------------------------------------------------

  refreshCache().catch(console.error);

  // Expose lifecycle functions for E2E invariant testing
  (window as any).__CALCULA_TIMELINE__ = {
    createTimelineAsync,
    deleteTimelineAsync,
    selectTimeline,
    deselectTimeline,
    getAllTimelines,
  };

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
  clearPendingTimelineClick();
  dragStartPositions = null;

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(TimelineSlicerManifest.id);

  console.log("[TimelineSlicer Extension] Unregistered");
}

// ============================================================================
// Internal: Timeline Click Handling
// ============================================================================

function handleTimelineClickAt(
  timelineId: string,
  canvasX: number,
  canvasY: number,
): void {
  const tl = getTimelineById(timelineId);
  if (!tl) return;

  // Timeline sheet-space position -> canvas space, with the gutters Core
  // PAINTED (a canvas shows none; the stored config still says 22 x 20).
  const bounds = timelineCanvasBounds(tl);
  if (!bounds) return;

  const hit = getTimelineHitDetail(canvasX, canvasY, bounds, timelineId);
  if (!hit) return;

  switch (hit.type) {
    case "clearButton":
      if (tl.selectionStart !== null) {
        updateTimelineSelectionAsync(timelineId, null, null, { askBeforeOverwrite: true }).catch(console.error);
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

function handlePeriodClick(timelineId: string, periodIndex: number): void {
  const data = getCachedTimelineData(timelineId);
  if (!data || periodIndex >= data.periods.length) return;

  const period = data.periods[periodIndex];

  // Single-period selection -- and NO drag state: this runs on the mouseup
  // that completed the click (see the note where the mousemove handler was).
  updateTimelineSelectionAsync(
    timelineId,
    period.startDate,
    period.endDate,
    { askBeforeOverwrite: true },
  ).catch(console.error);
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
