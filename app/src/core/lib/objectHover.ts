//! FILENAME: app/src/core/lib/objectHover.ts
// PURPOSE: Core's notion of HOVER over floating objects, and of a floating
//          GESTURE in progress (a Core move past its threshold, or a Core
//          resize). Two facts, each with change listeners, and nothing else.
// CONTEXT: BUG-0258 design phase 5. The six-dot grip (core/lib/floatingGrip.ts)
//          shows on an object with no header or title while the pointer is
//          over it, and on no object while one is being dragged. Before this
//          module there was no hover state in Core at all: the grid area bound
//          no mouseleave, and each family that wanted a hover highlight (the
//          canvas pivot box's +/- buttons) kept its own and could never be told
//          that the pointer had left the grid, that the grid scrolled under a
//          still pointer, or that the sheet changed.
//
//          WHO WRITES IT (all Core):
//            - the hover: useMouseSelection's hover pass, on every grid-area
//              mousemove that is not a drag (the object under the pointer, in
//              the order the press takes it: a live handle, a grip, a body);
//              the grid area's mouseleave, a scroll, a sheet switch and a
//              published region list that no longer holds the hovered object
//              clear it (Spreadsheet.tsx);
//            - the gesture: the move handlers when a frame press passes its
//              3px threshold (and again at its release), the resize handlers
//              around a resize.
//          WHO READS IT: the grip's visibility rule and painter, and -- through
//          the @api/gridOverlays re-export of the hover half -- a family that
//          must clear a highlight of its own when Core's hover leaves it.
//
//          A LEAF, with no imports, on purpose: @api/gridOverlays re-exports
//          from it, and a re-export from a module that imports the selection
//          seam (floatingGrip.ts, floatingHandles.ts) would load
//          @api/objectSelection through a cycle whenever the facade loads --
//          the split-instance defect the handle metrics hit (see
//          floatingHandleMetrics.ts).
//
//          Listeners fire ONLY on a change, so a pointer moving inside one
//          object costs nothing, and a listener that throws is logged and does
//          not stop the others (the layoutSurface precedent).

type HoverListener = (hoveredId: string | null, previousId: string | null) => void;
type GestureListener = (active: boolean) => void;

let hoveredId: string | null = null;
const hoverListeners = new Set<HoverListener>();

let gestureActive = false;
const gestureListeners = new Set<GestureListener>();

/** The id of the floating region the pointer is over, or null. */
export function getHoveredFloatingRegionId(): string | null {
  return hoveredId;
}

/**
 * Record the floating region under the pointer (null: none). Listeners run
 * only when the id CHANGES.
 */
export function setHoveredFloatingRegion(id: string | null): void {
  if (id === hoveredId) return;
  const previous = hoveredId;
  hoveredId = id;
  for (const l of [...hoverListeners]) {
    try {
      l(id, previous);
    } catch (err) {
      console.error("[objectHover] hover listener threw:", err);
    }
  }
}

/** No floating region is hovered (the pointer left the grid, it scrolled, the sheet changed). */
export function clearFloatingHover(): void {
  setHoveredFloatingRegion(null);
}

/** Subscribe to hover changes: `(hoveredId, previousId)`. Returns the unsubscribe. */
export function onFloatingHoverChanged(listener: HoverListener): () => void {
  hoverListeners.add(listener);
  return () => {
    hoverListeners.delete(listener);
  };
}

/**
 * Record whether a Core floating gesture (a move past its threshold, a
 * resize) is in progress. Listeners run only on a change.
 */
export function setFloatingGestureActive(active: boolean): void {
  if (active === gestureActive) return;
  gestureActive = active;
  for (const l of [...gestureListeners]) {
    try {
      l(active);
    } catch (err) {
      console.error("[objectHover] gesture listener threw:", err);
    }
  }
}

/** Whether a Core floating gesture is in progress. */
export function isFloatingGestureActive(): boolean {
  return gestureActive;
}

/** Subscribe to gesture changes. Returns the unsubscribe. */
export function onFloatingGestureChanged(listener: GestureListener): () => void {
  gestureListeners.add(listener);
  return () => {
    gestureListeners.delete(listener);
  };
}

/** Test hook: no hover, no gesture, no listeners. */
export function resetObjectHoverForTests(): void {
  hoveredId = null;
  gestureActive = false;
  hoverListeners.clear();
  gestureListeners.clear();
}
