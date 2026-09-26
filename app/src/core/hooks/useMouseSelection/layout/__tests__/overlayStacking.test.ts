//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayStacking.test.ts
// PURPOSE: The ONE z-order reaches Core's pointer: the body press
//          (`checkOverlayBody` / `handleOverlayMoveMouseDown`), the right-click
//          gate (`findFloatingRegionAt`) and the resize-handle scan
//          (`checkOverlayResizeHandle` / `handleOverlayResizeMouseDown`), driven
//          through the REAL handlers.
// CONTEXT: Before M8 the body press walked REVERSE publication order and the
//          handle scan FORWARD publication order, while paint went by overlay
//          priority -- three different "topmost" answers. With a stacking order
//          in force (a canvas's zOrder) all of them walk `floatingHitOrder`, and
//          a handle of an object covered by another is not grabbable through it.
//          Each z case has a POSITIVE CONTROL showing the same geometry answers
//          differently without z, so a pass cannot come from a no-op.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";
import { createOverlayMoveHandlers, findFloatingRegionAt, type OverlayMoveState } from "../overlayMoveHandlers";
import { createOverlayResizeHandlers } from "../overlayResizeHandlers";
import {
  registerGridOverlay,
  registerRegionStacking,
  setGridRegions,
  type GridRegion,
} from "../../../../../api/gridOverlays";
import type { GridConfig, Viewport } from "../../../../types";

const CONFIG = { rowHeaderWidth: 50, colHeaderHeight: 24 } as GridConfig;
const VIEWPORT = { scrollX: 0, scrollY: 0 } as Viewport;
const RHW = 50;
const CHH = 24;

function floating(id: string, type: string, box: { x: number; y: number; width: number; height: number }, z?: number): GridRegion {
  return {
    id,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: box,
    data: {},
    ...(z === undefined ? {} : { z }),
  };
}

function press(): React.MouseEvent<HTMLElement> {
  return {
    button: 0,
    ctrlKey: false,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

function moveHandlers() {
  return createOverlayMoveHandlers({
    config: CONFIG,
    viewport: VIEWPORT,
    containerRef: { current: null },
    setIsOverlayMoving: vi.fn(),
    setCursorStyle: vi.fn(),
    overlayMoveStateRef: { current: null } as React.MutableRefObject<OverlayMoveState | null>,
  });
}

function resizeHandlers() {
  const stateRef: { current: { region: GridRegion } | null } = { current: null };
  const h = createOverlayResizeHandlers({
    config: CONFIG,
    viewport: VIEWPORT,
    containerRef: { current: null },
    setIsOverlayResizing: vi.fn(),
    setCursorStyle: vi.fn(),
    overlayResizeStateRef: stateRef,
  } as unknown as Parameters<typeof createOverlayResizeHandlers>[0]);
  return { h, stateRef };
}

/** Which region a left press at a canvas point selects. */
function pressedRegionId(x: number, y: number): string | null {
  const seen: string[] = [];
  const on = (e: Event) => seen.push((e as CustomEvent).detail.regionId);
  window.addEventListener("floatingObject:selected", on);
  moveHandlers().handleOverlayMoveMouseDown(x, y, press());
  window.removeEventListener("floatingObject:selected", on);
  return seen[0] ?? null;
}

const cleanups: Array<() => void> = [];
beforeEach(() => {
  cleanups.push(
    registerGridOverlay({ type: "pivot-visual", render: () => {}, priority: 12 }),
    registerGridOverlay({ type: "timeline-slicer", render: () => {}, priority: 16 }),
  );
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

// A pivot box (priority 12) and a timeline (16) overlapping in [200..300] x [150..250].
const BOX = { x: 100, y: 100, width: 200, height: 150 };
const TL = { x: 200, y: 150, width: 200, height: 150 };
const OVERLAP = { x: RHW + 250, y: CHH + 200 };

describe("the body press and the right-click gate walk the ONE hit order", () => {
  it("POSITIVE CONTROL -- without z: the LAST published region wins (historical)", () => {
    setGridRegions([floating("tl", "timeline-slicer", TL), floating("box", "pivot-visual", BOX)]);
    expect(pressedRegionId(OVERLAP.x, OVERLAP.y)).toBe("box");
    expect(findFloatingRegionAt(OVERLAP.x, OVERLAP.y, CONFIG, VIEWPORT)?.id).toBe("box");
  });

  it("with z: z beats BOTH overlay priority and publication order", () => {
    // The box is published last AND has the lower priority; z puts the
    // timeline on top, and the press reaches the timeline.
    setGridRegions([floating("tl", "timeline-slicer", TL, 1), floating("box", "pivot-visual", BOX, 0)]);
    expect(pressedRegionId(OVERLAP.x, OVERLAP.y)).toBe("tl");
    expect(findFloatingRegionAt(OVERLAP.x, OVERLAP.y, CONFIG, VIEWPORT)?.id).toBe("tl");
    expect(moveHandlers().checkOverlayBody(OVERLAP.x, OVERLAP.y)?.region.id).toBe("tl");
  });

  it("with z from the resolver: a re-published family does not jump to the top", () => {
    cleanups.push(registerRegionStacking((r) => ({ tl: 0, box: 1 })[r.id]));
    setGridRegions([floating("tl", "timeline-slicer", TL), floating("box", "pivot-visual", BOX)]);
    expect(pressedRegionId(OVERLAP.x, OVERLAP.y)).toBe("box");
    // The timeline re-synced on a drag frame and moved to the array end --
    // without z, that alone would hand it the press.
    setGridRegions([floating("box", "pivot-visual", BOX), floating("tl", "timeline-slicer", TL)]);
    expect(pressedRegionId(OVERLAP.x, OVERLAP.y)).toBe("box");
  });
});

describe("the resize-handle scan walks the ONE hit order", () => {
  // Three objects sharing a top-left corner: the handle there belongs to one.
  // Published a, b, c -- the forward scan picks a, a reverse scan would pick c,
  // and z puts b on top, so only the stacking order can answer b.
  const A = { x: 100, y: 100, width: 200, height: 150 };
  const B = { x: 100, y: 100, width: 120, height: 90 };
  const C = { x: 100, y: 100, width: 160, height: 110 };
  const CORNER = { x: RHW + 100 + 2, y: CHH + 100 + 2 };

  it("POSITIVE CONTROL -- without z: the FIRST published region's handle (historical)", () => {
    setGridRegions([floating("a", "pivot-visual", A), floating("b", "timeline-slicer", B), floating("c", "pivot-visual", C)]);
    const { h, stateRef } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(CORNER.x, CORNER.y)?.id).toBe("a");
    expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, press())).toBe(true);
    expect(stateRef.current?.region.id).toBe("a");
  });

  it("with z: the topmost object's handle -- neither the first nor the last published", () => {
    setGridRegions([
      floating("a", "pivot-visual", A, 0),
      floating("b", "timeline-slicer", B, 2),
      floating("c", "pivot-visual", C, 1),
    ]);
    const { h, stateRef } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(CORNER.x, CORNER.y)?.id).toBe("b");
    expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, press())).toBe(true);
    expect(stateRef.current?.region.id).toBe("b");
  });
});

describe("an occluded handle is not grabbable in z-mode", () => {
  // `lower`'s bottom-right corner (sheet 300, 250) lies INSIDE `upper`'s body.
  const LOWER = { x: 100, y: 100, width: 200, height: 150 };
  const UPPER = { x: 250, y: 200, width: 200, height: 150 };
  const HIDDEN_CORNER = { x: RHW + 300, y: CHH + 250 };
  const VISIBLE_CORNER = { x: RHW + 100, y: CHH + 100 };

  it("POSITIVE CONTROL -- without z the forward scan grabs it through the object on top", () => {
    setGridRegions([floating("lower", "pivot-visual", LOWER), floating("upper", "timeline-slicer", UPPER)]);
    const { h, stateRef } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(HIDDEN_CORNER.x, HIDDEN_CORNER.y)?.id).toBe("lower");
    expect(h.handleOverlayResizeMouseDown(HIDDEN_CORNER.x, HIDDEN_CORNER.y, press())).toBe(true);
    expect(stateRef.current?.region.id).toBe("lower");
  });

  it("with z: the covered handle is refused, and the press falls to the body of the object on top", () => {
    setGridRegions([floating("lower", "pivot-visual", LOWER, 0), floating("upper", "timeline-slicer", UPPER, 1)]);
    const { h, stateRef } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(HIDDEN_CORNER.x, HIDDEN_CORNER.y)).toBeNull();
    expect(h.handleOverlayResizeMouseDown(HIDDEN_CORNER.x, HIDDEN_CORNER.y, press())).toBe(false);
    expect(stateRef.current).toBeNull();
    expect(pressedRegionId(HIDDEN_CORNER.x, HIDDEN_CORNER.y)).toBe("upper");
  });

  it("with z: a handle of the lower object that is NOT covered stays grabbable", () => {
    setGridRegions([floating("lower", "pivot-visual", LOWER, 0), floating("upper", "timeline-slicer", UPPER, 1)]);
    const { h, stateRef } = resizeHandlers();
    expect(h.handleOverlayResizeMouseDown(VISIBLE_CORNER.x, VISIBLE_CORNER.y, press())).toBe(true);
    expect(stateRef.current?.region.id).toBe("lower");
  });

  it("with z: an object that cannot be resized still occludes what is beneath it", () => {
    const upper = { ...floating("upper", "timeline-slicer", UPPER, 1), data: { resizable: false } };
    setGridRegions([floating("lower", "pivot-visual", LOWER, 0), upper]);
    const { h } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(HIDDEN_CORNER.x, HIDDEN_CORNER.y)).toBeNull();
  });
});
