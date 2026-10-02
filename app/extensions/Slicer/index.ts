//! FILENAME: app/extensions/Slicer/index.ts
// PURPOSE: Slicer extension entry point.
// CONTEXT: Registers all slicer functionality with the extension system:
//          grid overlays, event handlers, dialog, contextual ribbon tab.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  AppEvents,
  registerSlicerStoreService,
  isPointerClaimed,
} from "@api";
import {
  setSlicerItemRenderer,
  setSlicerStyleOverride,
} from "./rendering/customRenderers";
import {
  getGridRegions,
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
  deselectSlicer,
  dropSlicerFromSelection,
  broadcastSelectedSlicers,
} from "./handlers/selectionHandler";

import {
  handleSlicerContextMenu,
  closeSlicerContextMenu,
} from "./handlers/slicerContextMenu";

import {
  refreshCache,
  refreshCacheAndReapplyChangedFilters,
  resetStore,
  getSlicerById,
  getAllSlicers,
  createSlicerAsync,
  deleteSlicerAsync,
  commitSlicerGeometryAsync,
  updateSlicerSelectionAsync,
  getCachedItems,
  updateCachedSlicerPosition,
  updateCachedSlicerBounds,
  refreshSlicerItems,
  isSlicerGestureLanding,
  type SlicerGeometryWrite,
} from "./lib/slicerStore";
import {
  coMovedMemberRect,
  refuseUndoWhileAGestureLands,
  registerObjectGeometryProvider,
} from "@api/objectGeometry";
import { createSlicerGeometryProvider } from "./lib/slicerGeometry";

import {
  renderSlicer,
  hitTestSlicer,
  slicerZoneAt,
  getScrollOffset,
  setScrollOffset,
  getMaxScrollOffset,
  resetScrollOffsets,
} from "./rendering/slicerRenderer";
import { SlicerEvents } from "./lib/slicerEvents";
import { slicerBackend } from "./lib/slicerBackend";
import {
  armPendingSlicerClick,
  clearPendingSlicerClick,
  takePendingSlicerClick,
} from "./lib/slicerPendingClick";
import { registerSlicerObjectSelection } from "./lib/slicerObjectSelection";
import {
  clientToSlicerCanvas,
  slicerAtCanvasPoint,
  slicerCanvasBounds,
} from "./lib/slicerCanvasGeometry";
import { beginSlicerContentPress, resetSlicerContentPress } from "./lib/slicerItemDrag";
import { installSlicerKeys } from "./lib/slicerKeys";
import { leaveSlicerKeyFocus } from "./lib/slicerKeyFocus";

// ============================================================================
// Module State
// ============================================================================

let cleanupFunctions: Array<() => void> = [];

/** Cached reference to grid container for coordinate conversion. */
let gridContainer: HTMLElement | null = null;

// The pending click (armed on floatingObject:selected, consumed on mouseup)
// lives in lib/slicerPendingClick.ts, so the rule that only a real mouse press
// may arm it is testable.

/**
 * Snapshot of all selected slicers' positions at drag start.
 * Used to compute deltas for multi-move.
 */
let dragStartPositions: Map<string, { x: number; y: number }> | null = null;

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[Slicer Extension] Registering...");

  // Bind the capability-scoped backend channel before any code can trigger a
  // backend call (lib-api/store/components route through this door) (A3).
  slicerBackend.set(context.invokeBackend);

  // Register slicer store service for scriptable objects
  registerSlicerStoreService({
    getSlicerById(id: string) {
      const s = getSlicerById(id);
      if (!s) return undefined;
      return {
        name: s.name,
        selectedItems: s.selectedItems,
        fieldName: s.fieldName,
        sourceType: s.sourceType,
        columns: s.columns,
      };
    },
    listSlicers() {
      // Identity only (B3 enumeration) — never selectedItems or the cached
      // item list, which are DATA and have their own read paths.
      return getAllSlicers().map((s) => ({
        id: s.id,
        name: s.name,
        sheetIndex: s.sheetIndex,
        fieldName: s.fieldName,
        sourceType: s.sourceType,
      }));
    },
    getSelectedItems(slicerId: string) {
      const s = getSlicerById(slicerId);
      return s?.selectedItems ?? [];
    },
    async setSelectedItems(slicerId: string, items: string[] | null) {
      await updateSlicerSelectionAsync(slicerId, items);
    },
    getCachedItems(slicerId: string) {
      const items = getCachedItems(slicerId);
      return items?.map((item) => ({ text: item.value, hasData: item.hasData }));
    },
    setItemRenderer(slicerId, renderer) {
      return setSlicerItemRenderer(slicerId, renderer);
    },
    setStyleProperty(slicerId, name, value) {
      setSlicerStyleOverride(slicerId, name, value);
    },
  });

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(SlicerManifest);

  // Register dialogs
  context.ui.dialogs.register(InsertSlicerDialogDefinition);
  context.ui.dialogs.register(SlicerSettingsDialogDefinition);
  context.ui.dialogs.register(SlicerComputedPropsDialogDefinition);
  context.ui.dialogs.register(SlicerConnectionsDialogDefinition);

  // Register grid overlay renderer for slicer panels. `zoneAt` is the ONE
  // answer Core derives the press, the pointer and Ctrl/Shift from (BUG-0258
  // design phase 4): the items, "Select all", the LIT clear button and the
  // scrollbar are CONTENT -- Core hands their press to the content gesture
  // below (floatingObject:bodyDragStart) and never moves the slicer from
  // them -- while the header, the gaps, the padding and a header-less
  // slicer's 4px band are frame, which moves it.
  cleanupFunctions.push(
    context.grid.overlays.register({
      type: "slicer",
      render: (ctx: OverlayRenderContext) => {
        renderSlicer(ctx);
      },
      hitTest: hitTestSlicer,
      zoneAt: slicerZoneAt,
      priority: 15, // Above selection and table borders
    }),
  );

  // Keyboard / programmatic selection (@api/objectSelection): a canvas sheet's
  // Tab cycling selects slicers through this, never through the mouse route
  // below, which arms a pending click the next mouseup anywhere would complete.
  cleanupFunctions.push(registerSlicerObjectSelection());

  // The keyboard INSIDE a selected slicer (M8 S7): Enter goes in, the arrows
  // move a focus ring between the items, Space applies, Escape leaves, Alt+C
  // clears. One window-capture keydown, gated like the floating grid's
  // (lib/slicerKeys.ts); it claims nothing until Enter went in.
  cleanupFunctions.push(installSlicerKeys());

  // A keyboard Ctrl+Z / Ctrl+Y while a click lands is refused with a sentence
  // (the backend refuses it silently): @api/objectGeometry.
  cleanupFunctions.push(refuseUndoWhileAGestureLands(isSlicerGestureLanding));

  // Move / resize slicers WITHOUT a pointer gesture (@api/objectGeometry): the
  // canvas's align, distribute, nudge and group drag.
  cleanupFunctions.push(
    registerObjectGeometryProvider(createSlicerGeometryProvider({ afterCommit: () => broadcastSelectedSlicers() })),
  );

  // -----------------------------------------------------------------------
  // Floating object events (selection, move, resize)
  // -----------------------------------------------------------------------

  // Handle floating object selection (Core's filtered press on a slicer).
  // Sets a pending click that will be processed on mouseup.
  //
  // The OBJECT-selection Ctrl is Core's (`detail.ctrlKey`): Core resolves the
  // zone before it selects anything and zeroes Ctrl/Shift on CONTENT, so a
  // Ctrl+click on an item toggles the ITEM (the content gesture below gets the
  // raw Ctrl) and never toggles the slicer out of its selection. The Slicer
  // used to record Ctrl from its own capture-phase mousedown, which saw the
  // raw key before Core decided whose it was -- a Ctrl+click on an item of a
  // selected slicer DESELECTED the slicer (BUG-0258 design phase 4).
  const handleFloatingSelected = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "slicer") return;

    const slicerId = detail.data?.slicerId as string;
    if (slicerId == null) return;

    const alreadySelected = isSlicerSelected(slicerId);
    const wasMultiSelected = getSelectedSlicerIds().size > 1;
    const ctrl = detail.ctrlKey === true;

    // If this slicer is already part of a multi-selection and it's a plain
    // click (no Ctrl), DON'T narrow the selection yet — the user may be
    // about to drag the group.  We'll narrow to single on mouseup instead.
    if (alreadySelected && wasMultiSelected && !ctrl) {
      // Keep multi-selection intact for potential multi-drag.
      // Ensure the ribbon tab is still showing.
      broadcastSelectedSlicers();
    } else {
      selectSlicer(slicerId, ctrl);
    }

    // Snapshot positions of ALL selected slicers for potential multi-move
    dragStartPositions = new Map();
    for (const id of getSelectedSlicerIds()) {
      const s = getSlicerById(id);
      if (s) dragStartPositions.set(id, { x: s.x, y: s.y });
    }

    // A press on the object's GRIP (Core's chrome, design phase 5) is a frame
    // press that never acts: it selects and may move the slicer, and its
    // click opens the grip's menu -- no pending click, nothing narrowed here.
    if (detail.part === "grip") return;

    // Set pending click — processed on mouseup if not a drag.
    // deferNarrow = true when we deferred narrowing the multi-selection.
    armPendingSlicerClick({
      slicerId,
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

  // Where a slicer this drag CO-MOVES goes (a member of the selection, not the
  // pressed lead): the rule a Core-led canvas group drag applies
  // (@api/objectGeometry `coMovedMemberRect`) -- its press-time position
  // shifted by the lead's snapped delta, KEPT ON THE PAGE on a canvas, and a
  // LOCKED member stays put. It used to be clamped at 0 only, so a slicer-led
  // drag pushed the other selected slicers off the page and moved locked ones.
  const coMovedSlicerAt = (
    slicer: { id: string; sheetIndex: number; width: number; height: number },
    startPos: { x: number; y: number },
    dx: number,
    dy: number,
  ): { x: number; y: number } => {
    const region = getGridRegions().find((r) => r.id === `slicer-${slicer.id}`) ?? null;
    const at = coMovedMemberRect(
      slicer.sheetIndex,
      { x: startPos.x, y: startPos.y, width: slicer.width, height: slicer.height },
      { dx, dy },
      region,
    );
    return { x: at.x, y: at.y };
  };

  // Handle floating object move completion (drag ended)
  const handleMoveComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "slicer") return;

    // Clear pending click — this was a drag, not a click
    clearPendingSlicerClick();

    const primaryId = detail.data?.slicerId as string;
    if (primaryId == null) return;

    // Every slicer this drag moved, persisted as ONE undo step (a canvas group
    // drag's open transaction is joined, so the whole gesture stays one step).
    // A refusal (a protected sheet) puts the slicers back where the workbook
    // has them and says so once -- never a moved-looking slicer the backend
    // refused.
    const writes: SlicerGeometryWrite[] = [];
    const primaryStart = dragStartPositions?.get(primaryId);
    if (!primaryStart) {
      // Single slicer move (not multi-selected)
      const slicer = getSlicerById(primaryId);
      if (slicer) {
        writes.push({ slicerId: primaryId, x: detail.x, y: detail.y, width: slicer.width, height: slicer.height });
      }
    } else {
      // Multi-move: compute delta from primary slicer and apply to all selected
      const dx = detail.x - primaryStart.x;
      const dy = detail.y - primaryStart.y;

      for (const [id, startPos] of dragStartPositions!) {
        const slicer = getSlicerById(id);
        if (!slicer) continue;
        // The lead is where Core put it; every other member follows the
        // Core-led group-drag rule.
        const at = id === primaryId ? { x: detail.x, y: detail.y } : coMovedSlicerAt(slicer, startPos, dx, dy);
        writes.push({ slicerId: id, x: at.x, y: at.y, width: slicer.width, height: slicer.height });
      }
    }

    dragStartPositions = null;
    void commitSlicerGeometryAsync(writes, writes.length > 1 ? "Move Slicers" : "Move Slicer").then(() => {
      // Re-broadcast so the ribbon tab picks up final (or reverted) positions
      broadcastSelectedSlicers();
    });
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

    const primaryId = detail.data?.slicerId as string;
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
        const slicer = getSlicerById(id);
        if (!slicer) continue;
        const at = id === primaryId ? { x: detail.x, y: detail.y } : coMovedSlicerAt(slicer, startPos, dx, dy);
        updateCachedSlicerPosition(id, at.x, at.y);
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

    const slicerId = detail.data?.slicerId as string;
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

    const slicerId = detail.data?.slicerId as string;
    if (slicerId == null) return;

    void commitSlicerGeometryAsync(
      [{ slicerId, x: detail.x, y: detail.y, width: detail.width, height: detail.height }],
      "Resize Slicer",
    );
  };
  window.addEventListener("floatingObject:resizeComplete", handleResizeComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:resizeComplete", handleResizeComplete);
  });

  // -----------------------------------------------------------------------
  // Mouseup handler: the FRAME click
  // -----------------------------------------------------------------------

  // Bound by the press that arms the pending click (handleFloatingSelected,
  // above) and unbound by the first mouseup after it -- that press's own
  // release -- so it lives exactly as long as the press it completes: the
  // census (core/lib/globalInputListeners.ts) calls it session-scoped, and
  // that is a claim about its lifetime. It used to be bound for the
  // extension's whole life. Core ends a frame move (moveComplete) before this
  // hears the release, wherever the release lands (overlayMoveHandlers.ts).
  //
  // The frame does nothing on a click but select the slicer -- which the
  // press already did -- so all that is left is narrowing a kept
  // multi-selection to the slicer pressed. Every item, "Select all", clear
  // button and scrollbar press is the content gesture's (bodyDragStart below,
  // which TAKES the pending click); it reads no point and commits nothing.
  const handleMouseUp = () => {
    window.removeEventListener("mouseup", handleMouseUp);
    const pendingClick = takePendingSlicerClick();
    if (!pendingClick) return;
    dragStartPositions = null;

    // If we deferred narrowing a multi-selection to this single slicer
    // (because the user might have been about to drag the group), do it now.
    if (pendingClick.deferNarrow) {
      selectSlicer(pendingClick.slicerId, false);
    }
  };
  cleanupFunctions.push(() => {
    window.removeEventListener("mouseup", handleMouseUp);
  });

  // -----------------------------------------------------------------------
  // Content press: an item click or run, a button, the scrollbar (BUG-0258)
  // -----------------------------------------------------------------------

  // Core dispatches this for a press the registration's `zoneAt` answered
  // CONTENT -- after the press selected the slicer (a plain press: the
  // modifiers are the content's) and whatever the lock or the subscription,
  // so a locked slicer and a subscribed canvas page still filter (owner
  // decision 2026-09-29). The timeline's shape (TimelineSlicer/index.ts): the
  // press is the content's, so the pending click it armed is TAKEN here -- its
  // mouseup must not also be read as a frame click -- and a kept
  // multi-selection it deferred still narrows, at the release. The RAW Ctrl
  // arrives here, and only here: a click toggles the item, a drag adds the
  // run. lib/slicerItemDrag.ts owns the rest: its window listeners live only
  // while the gesture does, and it commits ONCE, at release.
  const handleBodyDragStart = (e: Event) => {
    const detail = (e as CustomEvent).detail as {
      regionId?: unknown;
      regionType?: string;
      data?: { slicerId?: unknown };
      canvasX?: number;
      canvasY?: number;
      part?: unknown;
      ctrlKey?: unknown;
    };
    if (detail?.regionType !== "slicer") return;
    const slicerId = detail.data?.slicerId;
    if (typeof slicerId !== "string" || slicerId.length === 0) return;
    if (typeof detail.regionId !== "string" || detail.regionId.length === 0) return;
    if (typeof detail.canvasX !== "number" || typeof detail.canvasY !== "number") return;

    const pending = takePendingSlicerClick();
    dragStartPositions = null;
    const narrow = pending?.slicerId === slicerId && pending.deferNarrow === true;

    beginSlicerContentPress({
      slicerId,
      regionId: detail.regionId,
      canvasX: detail.canvasX,
      canvasY: detail.canvasY,
      part: typeof detail.part === "string" ? detail.part : undefined,
      additive: detail.ctrlKey === true,
      boundsOf: () => {
        const s = getSlicerById(slicerId);
        return s ? slicerCanvasBounds(s) : null;
      },
      clientToCanvas: clientToSlicerCanvas,
      onRelease: narrow ? () => selectSlicer(slicerId, false) : undefined,
    });
  };
  window.addEventListener("floatingObject:bodyDragStart", handleBodyDragStart);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:bodyDragStart", handleBodyDragStart);
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

    // The PAINTED gutters, and the topmost object decides: a slicer covered by
    // another object does not scroll behind it (lib/slicerCanvasGeometry.ts).
    const slicer = slicerAtCanvasPoint(canvasX, canvasY);
    if (!slicer) return;

    // Only scroll if the slicer has overflowing content
    const maxScroll = getMaxScrollOffset(slicer.id);
    if (maxScroll <= 0) return;

    e.preventDefault();
    e.stopPropagation();

    const current = getScrollOffset(slicer.id);
    setScrollOffset(slicer.id, current + e.deltaY);
    requestOverlayRedraw();
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
      // The keyboard was inside a slicer of the sheet just left (M8 S7).
      leaveSlicerKeyFocus();
      refreshCache().catch(console.error);
    }),
  );

  // -----------------------------------------------------------------------
  // Filter bridge: apply filters when slicer selection changes
  // -----------------------------------------------------------------------

  // The filter itself is applied by `updateSlicerSelectionAsync`, in the
  // click's ONE backend command and undo step (one Ctrl+Z restores slicer and
  // pivots). This listener only refreshes the cross-filtered items of the
  // siblings.
  const handleSelectionChanged = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const slicerId = detail?.slicerId as string;
    if (slicerId == null) return;

    const slicer = getSlicerById(slicerId);
    if (slicer) {
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
      Promise.all(siblings.map((s) => refreshSlicerItems(s.id)))
        .then(() => {
          requestOverlayRedraw();
        })
        .catch(console.error);
    }
  };
  window.addEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, handleSelectionChanged);
  cleanupFunctions.push(() => {
    window.removeEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, handleSelectionChanged);
  });

  // -----------------------------------------------------------------------
  // Slicer deleted: drop it out of the selection so the contextual ribbon tab
  // goes away with the last selected slicer. Without this, deleting a selected
  // slicer leaves the Options tab visible with no slicer to configure.
  //
  // §3cd: the event now comes from `refreshCache`'s id diff rather than from
  // the frontend delete route, so it fires for a BACKEND CASCADE too -- delete
  // the table a slicer filters and this is what takes the tab down. BUG-0026
  // was exactly that gap: three actions (table.create, slicer.create,
  // table.delete) left the Slicer tab on a workbook with zero slicers.
  // -----------------------------------------------------------------------

  const handleSlicerDeleted = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const deletedId = detail?.slicerId as string | undefined;
    if (deletedId != null) {
      dropSlicerFromSelection(deletedId);
    }
  };
  window.addEventListener(SlicerEvents.SLICER_DELETED, handleSlicerDeleted);
  cleanupFunctions.push(() => {
    window.removeEventListener(SlicerEvents.SLICER_DELETED, handleSlicerDeleted);
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

  // Also the UNDO/REDO fan-out ("slicer" domain): re-read, then re-apply the
  // PIVOT MASK of every ordinary (level-1) slicer whose selection the backend
  // changed -- an undone click restores the slicer, and a level-1 pivot mask
  // records no undo, so it follows the slicer here. Tables and pins are not
  // re-applied: their writes recorded undo in the click's own step.
  const handleSlicerRefresh = () => {
    refreshCacheAndReapplyChangedFilters().then(() => {
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

  // Expose slicer lifecycle functions for E2E invariant testing
  (window as any).__CALCULA_SLICER__ = {
    createSlicerAsync,
    deleteSlicerAsync,
    selectSlicer,
    deselectSlicer,
    getAllSlicers,
  };

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

  // A live item drag ends with no commit, and its preview goes with it (the
  // cleanups above already unbound Core's press events).
  resetSlicerContentPress();
  resetSelectionHandlerState();
  closeSlicerContextMenu();
  resetStore();
  resetScrollOffsets();
  gridContainer = null;
  clearPendingSlicerClick();
  dragStartPositions = null;

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(SlicerManifest.id);

  console.log("[Slicer Extension] Unregistered");
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
