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
  updateCachedTimelinePosition,
  updateCachedTimelineBounds,
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

import { renderTimelineSlicer, hitTestTimeline } from "./rendering/timelineSlicerRenderer";
import {
  getScrollOffset,
  setScrollOffset,
  getMaxScrollOffset,
  resetScrollOffsets,
  timelineOverlayZoneAt,
} from "./lib/timelineView";
import {
  beginTimelineContentPress,
  resetTimelineContentPress,
} from "./lib/timelineRangeDrag";
import { timelineBackend } from "./lib/timelineBackend";
import { TimelineSlicerEvents } from "./lib/timelineSlicerEvents";
import {
  armPendingTimelineClick,
  clearPendingTimelineClick,
  takePendingTimelineClick,
} from "./lib/timelinePendingClick";
import { registerTimelineObjectSelection } from "./lib/timelineObjectSelection";
import { installTimelineKeys } from "./lib/timelineKeys";
import { leaveTimelineKeyFocus } from "./lib/timelineKeyFocus";
import {
  clientToTimelineCanvas,
  timelineAtCanvasPoint,
  timelineCanvasBounds,
} from "./lib/timelineCanvasGeometry";

// ============================================================================
// Module State
// ============================================================================

let cleanupFunctions: Array<() => void> = [];
let gridContainer: HTMLElement | null = null;
// The pending click (armed on floatingObject:selected, consumed by that
// press's mouseup or taken by a content press on bodyDragStart) lives in
// lib/timelinePendingClick.ts, so the rule that only a real mouse press may
// arm it is testable.
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

  // Register grid overlay renderer. Its `zoneAt` is the ONE answer Core
  // derives the press, the pointer and the meaning of Ctrl/Shift from
  // (lib/timelineView.ts over the zone table in lib/timelineZones.ts): the
  // month tiles, the range-end markers, the clear and level buttons and the
  // scrollbar are CONTENT -- Core selects the timeline as a plain press, hands
  // the press to `floatingObject:bodyDragStart` below and never moves it --
  // while the header, the year-label strip and the empty space are FRAME,
  // where Core moves the timeline (Core's 'move' pointer) unless it is locked
  // or on a subscribed page ('default') (BUG-0258).
  cleanupFunctions.push(
    context.grid.overlays.register({
      type: "timeline-slicer",
      render: (ctx: OverlayRenderContext) => {
        renderTimelineSlicer(ctx);
      },
      hitTest: hitTestTimeline,
      zoneAt: timelineOverlayZoneAt,
      priority: 16, // Above slicers
    }),
  );

  // No resize-flag resync: Core's selection handles are live only on a
  // SELECTED timeline and only where Core paints them (core/lib/
  // floatingHandles.ts), so an unselected timeline's months never lose a press
  // to a corner nobody can see (BUG-0258 design phase 3).

  // Keyboard / programmatic selection (@api/objectSelection): a canvas sheet's
  // Tab cycling selects timelines through this, never through the mouse route
  // below, which arms a pending click the next mouseup anywhere would complete.
  cleanupFunctions.push(registerTimelineObjectSelection());

  // The keyboard INSIDE a selected timeline (M8 S8, lib/timelineKeys.ts):
  // Enter goes in, Left / Right move a focus ring between the periods,
  // Shift+arrows preview a range, Enter or Space commits it as ONE undo step,
  // Escape drops the preview and then leaves. One window-capture keydown for
  // the extension's life; it claims nothing until Enter went in (except Alt+C
  // on a single selected, filtered timeline).
  cleanupFunctions.push(installTimelineKeys());

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

  // Ctrl comes from Core's press (`floatingObject:selected` detail.ctrlKey),
  // never from a capture mousedown of our own: Core zeroes it on the CONTENT
  // -- Ctrl/Shift there are the content's -- so a Ctrl or Shift press on the
  // month tiles never toggles the timeline out of the selection.

  // Mouseup: complete a click on the FRAME. Bound by the press that arms the
  // pending click (handleFloatingSelected, below) and unbound by the first
  // mouseup after it -- that press's own release -- so it lives exactly as
  // long as the press it completes (the census in
  // core/lib/globalInputListeners.ts calls it session-scoped, and that is a
  // claim about its lifetime). The frame does nothing on a click but select
  // the timeline -- which the press already did -- so all that is left is
  // narrowing a kept multi-selection to the timeline pressed. Every period,
  // range-end and button click is the content gesture's (bodyDragStart
  // below, which TAKES the pending click), and a frame drag is Core's move,
  // which clears it (moveComplete).
  const handleMouseUp = () => {
    window.removeEventListener("mouseup", handleMouseUp);
    const pendingClick = takePendingTimelineClick();
    if (!pendingClick) return;
    dragStartPositions = null;
    if (pendingClick.deferNarrow) {
      selectTimeline(pendingClick.timelineId, false);
    }
  };
  cleanupFunctions.push(() => {
    window.removeEventListener("mouseup", handleMouseUp);
  });

  // Handle floating object selection
  const handleFloatingSelected = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "timeline-slicer") return;

    const timelineId = detail.data?.timelineId as string;
    if (timelineId == null) return;

    const alreadySelected = isTimelineSelected(timelineId);
    const wasMultiSelected = getSelectedTimelineIds().size > 1;
    // The OBJECT-selection Ctrl: Core's, false on a content press.
    const ctrl = detail.ctrlKey === true;

    if (alreadySelected && wasMultiSelected && !ctrl) {
      broadcastSelectedTimelines();
    } else {
      selectTimeline(timelineId, ctrl);
    }

    // Snapshot positions for multi-move
    dragStartPositions = new Map();
    for (const id of getSelectedTimelineIds()) {
      const t = getTimelineById(id);
      if (t) dragStartPositions.set(id, { x: t.x, y: t.y });
    }

    // A press on the object's GRIP (Core's chrome, BUG-0258 design phase 5) is
    // a frame press that never acts: it selects and may move the timeline,
    // and its click opens the grip's menu -- no pending click, nothing
    // narrowed here (the Slicer's rule).
    if (detail.part === "grip") return;

    armPendingTimelineClick({
      timelineId,
      deferNarrow: alreadySelected && wasMultiSelected && !ctrl,
    });
    // For THIS press only: its release completes the click and unbinds.
    // (Binding the same listener twice is a no-op.)
    window.addEventListener("mouseup", handleMouseUp);
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
  // Content press: a range drag, a button, the scrollbar (BUG-0258)
  // -----------------------------------------------------------------------

  // Core dispatches this for a press the registration's `zoneAt` answered
  // CONTENT -- after the press selected the timeline (a plain press: the
  // modifiers are the content's) and whatever the lock or the subscription,
  // so a locked timeline and a subscribed canvas page still filter (owner
  // decision 2026-09-29). The chart brush's shape (Charts/index.ts): the
  // press is the content's, so the pending click it armed is TAKEN here --
  // its mouseup must not also be read as a click on the frame -- and a kept
  // multi-selection it deferred still narrows, at the release. The RAW Shift
  // arrives here, and only here: it extends the range. lib/timelineRangeDrag.ts
  // owns the rest: its window listeners live only while the gesture does,
  // and it commits ONCE, at release.
  const handleBodyDragStart = (e: Event) => {
    const detail = (e as CustomEvent).detail as {
      regionId?: unknown;
      regionType?: string;
      data?: { timelineId?: unknown };
      canvasX?: number;
      canvasY?: number;
      shiftKey?: unknown;
    };
    if (detail?.regionType !== "timeline-slicer") return;
    const timelineId = detail.data?.timelineId;
    if (typeof timelineId !== "string" || timelineId.length === 0) return;
    if (typeof detail.regionId !== "string" || detail.regionId.length === 0) return;
    if (typeof detail.canvasX !== "number" || typeof detail.canvasY !== "number") return;

    const pending = takePendingTimelineClick();
    dragStartPositions = null;
    const narrow = pending?.timelineId === timelineId && pending.deferNarrow === true;

    beginTimelineContentPress({
      timelineId,
      regionId: detail.regionId,
      canvasX: detail.canvasX,
      canvasY: detail.canvasY,
      extend: detail.shiftKey === true,
      boundsOf: () => {
        const tl = getTimelineById(timelineId);
        return tl ? timelineCanvasBounds(tl) : null;
      },
      clientToCanvas: clientToTimelineCanvas,
      onRelease: narrow ? () => selectTimeline(timelineId, false) : undefined,
    });
  };
  window.addEventListener("floatingObject:bodyDragStart", handleBodyDragStart);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:bodyDragStart", handleBodyDragStart);
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
      // The keyboard leaves a timeline the sheet switch took off screen.
      leaveTimelineKeyFocus();
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
  resetTimelineContentPress();
  gridContainer = null;
  clearPendingTimelineClick();
  dragStartPositions = null;

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(TimelineSlicerManifest.id);

  console.log("[TimelineSlicer Extension] Unregistered");
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
