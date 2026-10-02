//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayStacking.test.ts
// PURPOSE: The ONE z-order reaches Core's pointer: the body press
//          (`checkOverlayBody` / `handleOverlayMoveMouseDown`), the right-click
//          gate (`findFloatingRegionAt`) and the resize-handle scan
//          (`checkOverlayResizeHandle` / `handleOverlayResizeMouseDown`), driven
//          through the REAL handlers.
// CONTEXT: Before M8 the body press walked REVERSE publication order and the
//          handle scan FORWARD publication order, while paint went by overlay
//          priority -- three different "topmost" answers. With a stacking order
//          in force (a canvas's zOrder) all of them walk `floatingHitOrder`.
//          Each z case has a POSITIVE CONTROL showing the same geometry answers
//          differently without z, so a pass cannot come from a no-op.
//
//          HANDLES (BUG-0258 design phase 3). Resize handles exist only on a
//          SELECTED object and Core paints them ABOVE every object
//          (core/lib/floatingHandles.ts), so the handle scan walks
//          `floatingHitOrder` in BOTH modes (the topmost selected object's
//          handle wins; without z that is the LAST published, no longer the
//          first) and no object's body occludes a handle: a selected object's
//          handle painted over an object stacked above it is grabbable there,
//          and an UNSELECTED object's corner is no handle at all -- the old
//          occlusion rule existed for exactly those invisible corners.

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
import { selectForHandles } from "./helpers/selectForHandles";

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
/** The objects whose handles are live (selected); every test sets its own. */
const selected = new Set<string>();
beforeEach(() => {
  selected.clear();
  cleanups.push(
    registerGridOverlay({ type: "pivot-visual", render: () => {}, priority: 12 }),
    registerGridOverlay({ type: "timeline-slicer", render: () => {}, priority: 16 }),
    selectForHandles(["pivot-visual", "timeline-slicer"], (r) => selected.has(r.id)),
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
  // Three SELECTED objects sharing a top-left corner: the handle there belongs
  // to one. Published a, b, c -- the old forward scan picked a, the hit order
  // without z picks c (the last published is on top), and z puts b on top, so
  // only the stacking order can answer b.
  const A = { x: 100, y: 100, width: 200, height: 150 };
  const B = { x: 100, y: 100, width: 120, height: 90 };
  const C = { x: 100, y: 100, width: 160, height: 110 };
  const CORNER = { x: RHW + 100 + 2, y: CHH + 100 + 2 };

  it("POSITIVE CONTROL -- without z: the topmost (LAST published) selected object's handle", () => {
    ["a", "b", "c"].forEach((id) => selected.add(id));
    setGridRegions([floating("a", "pivot-visual", A), floating("b", "timeline-slicer", B), floating("c", "pivot-visual", C)]);
    const { h, stateRef } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(CORNER.x, CORNER.y)?.region.id).toBe("c");
    expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, press())).toBe(true);
    expect(stateRef.current?.region.id).toBe("c");
  });

  it("with z: the topmost object's handle -- neither the first nor the last published", () => {
    ["a", "b", "c"].forEach((id) => selected.add(id));
    setGridRegions([
      floating("a", "pivot-visual", A, 0),
      floating("b", "timeline-slicer", B, 2),
      floating("c", "pivot-visual", C, 1),
    ]);
    const { h, stateRef } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(CORNER.x, CORNER.y)?.region.id).toBe("b");
    expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, press())).toBe(true);
    expect(stateRef.current?.region.id).toBe("b");
  });

  it("only SELECTED objects take part: an unselected one on top has no handle, the selected one beneath does", () => {
    selected.add("a");
    setGridRegions([
      floating("a", "pivot-visual", A, 0),
      floating("b", "timeline-slicer", B, 2),
      floating("c", "pivot-visual", C, 1),
    ]);
    const { h } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(CORNER.x, CORNER.y)?.region.id).toBe("a");
  });
});

describe("a selected object's handles are topmost (painted above every object, hit before any body)", () => {
  // `lower`'s bottom-right corner (sheet 300, 250) lies INSIDE `upper`'s body.
  const LOWER = { x: 100, y: 100, width: 200, height: 150 };
  const UPPER = { x: 250, y: 200, width: 200, height: 150 };
  const HIDDEN_CORNER = { x: RHW + 300, y: CHH + 250 };
  const VISIBLE_CORNER = { x: RHW + 100, y: CHH + 100 };

  it("an UNSELECTED lower object's corner under the upper object is no handle: the press falls to the body on top (both modes)", () => {
    for (const zs of [[undefined, undefined], [0, 1]] as const) {
      setGridRegions([floating("lower", "pivot-visual", LOWER, zs[0]), floating("upper", "timeline-slicer", UPPER, zs[1])]);
      const { h, stateRef } = resizeHandlers();
      expect(h.checkOverlayResizeHandle(HIDDEN_CORNER.x, HIDDEN_CORNER.y), `z = ${String(zs)}`).toBeNull();
      expect(h.handleOverlayResizeMouseDown(HIDDEN_CORNER.x, HIDDEN_CORNER.y, press())).toBe(false);
      expect(stateRef.current).toBeNull();
      expect(pressedRegionId(HIDDEN_CORNER.x, HIDDEN_CORNER.y)).toBe("upper");
    }
  });

  it("a SELECTED lower object's handle painted over the upper object is grabbable there (both modes)", () => {
    selected.add("lower");
    for (const zs of [[undefined, undefined], [0, 1]] as const) {
      setGridRegions([floating("lower", "pivot-visual", LOWER, zs[0]), floating("upper", "timeline-slicer", UPPER, zs[1])]);
      const { h, stateRef } = resizeHandlers();
      expect(h.checkOverlayResizeHandle(HIDDEN_CORNER.x, HIDDEN_CORNER.y)?.region.id, `z = ${String(zs)}`).toBe("lower");
      expect(h.handleOverlayResizeMouseDown(HIDDEN_CORNER.x, HIDDEN_CORNER.y, press())).toBe(true);
      expect(stateRef.current?.region.id).toBe("lower");
    }
  });

  it("with z: a handle of the selected lower object that is NOT covered is grabbable too", () => {
    selected.add("lower");
    setGridRegions([floating("lower", "pivot-visual", LOWER, 0), floating("upper", "timeline-slicer", UPPER, 1)]);
    const { h, stateRef } = resizeHandlers();
    expect(h.handleOverlayResizeMouseDown(VISIBLE_CORNER.x, VISIBLE_CORNER.y, press())).toBe(true);
    expect(stateRef.current?.region.id).toBe("lower");
  });

  it("the body press still walks the stacking order: without a live handle the object on top takes the press", () => {
    selected.add("upper");
    const upper = { ...floating("upper", "timeline-slicer", UPPER, 1), data: { resizable: false } };
    setGridRegions([floating("lower", "pivot-visual", LOWER, 0), upper]);
    const { h } = resizeHandlers();
    expect(h.checkOverlayResizeHandle(HIDDEN_CORNER.x, HIDDEN_CORNER.y)).toBeNull();
    expect(pressedRegionId(HIDDEN_CORNER.x, HIDDEN_CORNER.y)).toBe("upper");
  });
});
