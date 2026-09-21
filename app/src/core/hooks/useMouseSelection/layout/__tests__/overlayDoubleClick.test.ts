//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayDoubleClick.test.ts
// PURPOSE: The double-click seam for floating objects
//          (OverlayRegistration.onDoubleClick, @api/gridOverlays) as Core offers
//          it: the owner is consulted with plain coordinates, its answer is
//          reported, and a gesture that belongs to something STACKED ON the grid
//          never reaches it at all.
//
// CONTEXT: The gap this closes is structural, not cosmetic. Core resolves no
//          cell over a floating overlay, and the cell double-click interceptors
//          are consulted only `if (cell)` — so the existing seam could not be
//          reached over a chart, a slicer or a Floating Range by any means.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createOverlayMoveHandlers, type OverlayMoveState } from "../overlayMoveHandlers";
import {
  registerGridOverlay,
  unregisterGridOverlay,
  setGridRegions,
  type GridRegion,
  type OverlayHitTestContext,
} from "../../../../../api/gridOverlays";
import { claimPointer } from "../../../../lib/pointerClaims";
import type { GridConfig, Viewport } from "../../../../types";

const REGION: GridRegion = {
  id: "r1",
  type: "test-overlay",
  floating: { x: 100, y: 100, width: 200, height: 150 },
  data: { frId: "fr-1" },
} as GridRegion;

/** Canvas bounds are [150..350] x [124..274]; (200,200) is inside the body. */
const IN = { x: 200, y: 200 };

function makeHandlers() {
  const overlayMoveStateRef = { current: null as OverlayMoveState | null };
  return createOverlayMoveHandlers({
    config: { rowHeaderWidth: 50, colHeaderHeight: 24 } as GridConfig,
    viewport: { scrollX: 0, scrollY: 0 } as Viewport,
    containerRef: { current: null },
    setIsOverlayMoving: vi.fn(),
    setCursorStyle: vi.fn(),
    overlayMoveStateRef,
  });
}

/** A double-click whose target is a plain element outside any claim. */
function dblClickOn(target: EventTarget | null): React.MouseEvent<HTMLElement> {
  return { target, button: 0, preventDefault: vi.fn() } as unknown as React.MouseEvent<HTMLElement>;
}

beforeEach(() => setGridRegions([REGION]));
afterEach(() => {
  unregisterGridOverlay("test-overlay");
  setGridRegions([]);
  document.body.innerHTML = "";
});

describe("the overlay double-click seam", () => {
  it("hands the gesture to the owner, with the region and its canvas bounds", () => {
    const seen: OverlayHitTestContext[] = [];
    registerGridOverlay({
      type: "test-overlay",
      render: () => {},
      onDoubleClick: (ctx) => {
        seen.push(ctx);
        return true;
      },
    });

    const handlers = makeHandlers();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);

    expect(handlers.handleOverlayDoubleClick(REGION, IN.x, IN.y, dblClickOn(canvas))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].region.id).toBe("r1");
    expect(seen[0].canvasX).toBe(IN.x);
    expect(seen[0].canvasY).toBe(IN.y);
    expect(seen[0].floatingCanvasBounds).toEqual({ x: 150, y: 124, width: 200, height: 150 });
  });

  it("reports a declined gesture as not handled", () => {
    const onDoubleClick = vi.fn(() => false);
    registerGridOverlay({ type: "test-overlay", render: () => {}, onDoubleClick });
    const handlers = makeHandlers();

    expect(handlers.handleOverlayDoubleClick(REGION, IN.x, IN.y, dblClickOn(null))).toBe(false);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for an overlay that registers no handler", () => {
    registerGridOverlay({ type: "test-overlay", render: () => {} });
    const handlers = makeHandlers();

    expect(handlers.handleOverlayDoubleClick(REGION, IN.x, IN.y, dblClickOn(null))).toBe(false);
  });

  it("never consults the owner when the pointer was CLAIMED", () => {
    // A surface an extension stacked on the grid (a shape's hit rectangle, an
    // embedded form's card) already took this gesture: core/lib/pointerClaims.ts.
    const onDoubleClick = vi.fn(() => true);
    registerGridOverlay({ type: "test-overlay", render: () => {}, onDoubleClick });
    const handlers = makeHandlers();

    const card = document.createElement("div");
    claimPointer(card, "placement-1");
    const inner = document.createElement("span");
    card.appendChild(inner);
    document.body.appendChild(card);

    expect(handlers.handleOverlayDoubleClick(REGION, IN.x, IN.y, dblClickOn(inner))).toBe(false);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it("never consults the owner inside an on-canvas editor", () => {
    // The Floating Range's own <textarea> is stacked over the canvas, carries no
    // claim attribute, and sits INSIDE the overlay's rect: geometry alone would
    // re-offer the user's word-select as a double-click on the cell underneath.
    const onDoubleClick = vi.fn(() => true);
    registerGridOverlay({ type: "test-overlay", render: () => {}, onDoubleClick });
    const handlers = makeHandlers();

    for (const tag of ["input", "textarea", "select"]) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      expect(handlers.handleOverlayDoubleClick(REGION, IN.x, IN.y, dblClickOn(el))).toBe(false);
    }
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it("does not disturb the mousedown paths that share the geometry", () => {
    // Control: registering onDoubleClick must not make a press behave differently.
    registerGridOverlay({ type: "test-overlay", render: () => {}, onDoubleClick: () => true });
    const handlers = makeHandlers();
    const onStart = vi.fn();
    window.addEventListener("floatingObject:bodyDragStart", onStart);
    const started = handlers.handleOverlayMoveMouseDown(
      IN.x,
      IN.y,
      { preventDefault: () => {}, ctrlKey: false, button: 0 } as unknown as React.MouseEvent<HTMLElement>,
    );
    window.removeEventListener("floatingObject:bodyDragStart", onStart);

    expect(started).toBe(true);
    expect(onStart).not.toHaveBeenCalled(); // no claimsBodyDrag => a move, as before
  });
});
