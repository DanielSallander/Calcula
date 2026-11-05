//! FILENAME: app/src/core/components/Spreadsheet/useGridTouch.ts
// PURPOSE: Wire the touch bridge (core/lib/touchBridge.ts, BUG-0276) to the
//          grid area: decide, for a touch at a point, whether a drag there
//          drags something (an object, a handle, a grip, a header, the fill
//          handle) or pans the sheet, and pan through the grid's own wheel door.
// CONTEXT: Kept out of Spreadsheet.tsx so the classification is testable
//          without mounting the grid (`classifyTouchPress` takes every fact as an
//          argument). The hit tests are the SAME functions the mouse door uses
//          -- findFloatingRegionAt / floatingHandleAt / floatingGripAt /
//          createFillHandleCursorChecker, in zoom-corrected container
//          coordinates -- so "a drag here drags the object" means exactly "a
//          mouse press here would grab it".

import { useEffect, useRef } from "react";
import type { DimensionOverrides, GridConfig, Selection, Viewport } from "../../types";
import { installTouchBridge, type TouchPressKind } from "../../lib/touchBridge";
import { findPointerClaim } from "../../lib/pointerClaims";
import { findFloatingRegionAt } from "../../hooks/useMouseSelection/layout/overlayMoveHandlers";
import { createFillHandleCursorChecker } from "../../hooks/useMouseSelection/utils/fillHandleUtils";
import { floatingHandleAt } from "../../lib/floatingHandles";
import { floatingGripAt, currentGripZoom } from "../../lib/floatingGrip";
import { getLiveGridRegions } from "../../../api/gridOverlays";
import { rowHeaderGutter, colHeaderGutter } from "../../lib/gridRenderer/layout/headerVisibility";

/** The grid facts a touch classification reads. */
export interface GridTouchState {
  config: GridConfig;
  viewport: Viewport;
  dimensions: DimensionOverrides;
  selection: Selection | null;
  zoom: number;
  /** The grid canvas (objects, cells and headers are all painted on it). */
  canvas: HTMLCanvasElement | null;
}

/**
 * Drag or pan, for a touch at container point (x, y) -- already divided by the
 * zoom, the basis every mouse hit test uses. `onCanvas` is false when the touch
 * landed on DOM stacked over the canvas (a scrollbar, a DOM layer): that DOM's
 * own mouse handlers then get the drag, as the mouse's would.
 */
export function classifyTouchPress(x: number, y: number, onCanvas: boolean, s: GridTouchState): TouchPressKind {
  if (!onCanvas) return "drag";
  const gutters = { rowHeaderWidth: rowHeaderGutter(s.config), colHeaderHeight: colHeaderGutter(s.config) };
  // Headers and the corner: select columns / rows by dragging, resize at a
  // border -- the mouse's gestures there (Excel's touch too).
  if (x < gutters.rowHeaderWidth || y < gutters.colHeaderHeight) return "drag";
  const scroll = { scrollX: s.viewport.scrollX || 0, scrollY: s.viewport.scrollY || 0 };
  // An object's handles and grip sit partly OUTSIDE its rectangle, so they are
  // asked first, in the mouse door's order.
  if (floatingHandleAt(x, y, gutters, scroll)) return "drag";
  if (floatingGripAt(x, y, gutters, scroll, currentGripZoom(), getLiveGridRegions())) return "drag";
  if (findFloatingRegionAt(x, y, s.config, s.viewport)) return "drag";
  const overFill = createFillHandleCursorChecker({
    config: s.config,
    viewport: s.viewport,
    dimensions: s.dimensions,
    selection: s.selection,
  });
  if (overFill(x, y)) return "drag";
  return "pan";
}

/**
 * Install the touch bridge on the grid area while it is mounted. `getState` is
 * read at each touch, so the classification always sees the live viewport.
 */
export function useGridTouch(
  containerRef: React.RefObject<HTMLDivElement | null>,
  getState: () => GridTouchState,
): void {
  const stateRef = useRef(getState);
  useEffect(() => {
    stateRef.current = getState;
  });

  useEffect(() => {
    const area = containerRef.current;
    if (!area) return;
    return installTouchBridge(area, {
      // A claimed element (an on-grid form, a cell editor) keeps the browser's
      // own touch handling, exactly as the mouse door leaves it its clicks.
      isNative: (target) => findPointerClaim(target) !== null,
      classify: (clientX, clientY, target) => {
        const s = stateRef.current();
        const rect = area.getBoundingClientRect();
        const z = s.zoom || 1;
        const onCanvas = s.canvas !== null && target === s.canvas;
        return classifyTouchPress((clientX - rect.left) / z, (clientY - rect.top) / z, onCanvas, s);
      },
      // The content follows the finger: a finger moving right scrolls LEFT. In
      // sheet pixels, so the zoom divides. Through the grid's wheel door, which
      // already knows split panes and the scroll limits.
      pan: (dx, dy, clientX, clientY) => {
        const z = stateRef.current().zoom || 1;
        const view = area.ownerDocument?.defaultView ?? window;
        const Ctor = view.WheelEvent ?? WheelEvent;
        area.dispatchEvent(
          new Ctor("wheel", {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            deltaX: -dx / z,
            deltaY: -dy / z,
            deltaMode: 0,
          }),
        );
      },
    });
  }, [containerRef]);
}
