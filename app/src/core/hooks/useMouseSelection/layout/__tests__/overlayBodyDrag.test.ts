//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayBodyDrag.test.ts
// PURPOSE: The generic content hand-over (a CONTENT zone from
//          OverlayRegistration.zoneAt). Proves an overlay with no zoneAt is
//          all frame -- selected and moved by its body -- and an overlay whose
//          zone says content has its in-body drag handed over (move skipped, a
//          generic floatingObject:bodyDragStart dispatched) -- with NO chart
//          knowledge in Core. Before M5 T6 this was the per-press body-drag
//          claim; the zone is now the only route.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createOverlayMoveHandlers, type OverlayMoveState } from "../overlayMoveHandlers";
import { registerGridOverlay, unregisterGridOverlay, setGridRegions, type GridRegion } from "../../../../../api/gridOverlays";
import type { GridConfig, Viewport } from "../../../../types";

const REGION: GridRegion = {
  id: "r1",
  type: "test-overlay",
  floating: { x: 100, y: 100, width: 200, height: 150 },
  data: {},
} as GridRegion;

const evt = { preventDefault: () => {}, ctrlKey: false } as unknown as React.MouseEvent<HTMLElement>;

function makeHandlers() {
  const setIsOverlayMoving = vi.fn();
  const overlayMoveStateRef = { current: null as OverlayMoveState | null };
  const handlers = createOverlayMoveHandlers({
    config: { rowHeaderWidth: 50, colHeaderHeight: 24 } as GridConfig,
    viewport: { scrollX: 0, scrollY: 0 } as Viewport,
    containerRef: { current: null },
    setIsOverlayMoving,
    setCursorStyle: vi.fn(),
    overlayMoveStateRef,
  });
  return { handlers, setIsOverlayMoving, overlayMoveStateRef };
}

// The floating region's canvas bounds are [150..350] x [124..274]; (200,200) is inside.
const IN = { x: 200, y: 200 };

const CONTENT_ZONE = () => ({ kind: "content" as const, cursor: "crosshair", part: "brush" });

beforeEach(() => setGridRegions([REGION]));
afterEach(() => { unregisterGridOverlay("test-overlay"); setGridRegions([]); });

describe("overlay content hand-over (a content zone)", () => {
  it("an overlay with no zoneAt is all frame: it starts a move", () => {
    registerGridOverlay({ type: "test-overlay", render: () => {} });
    const { handlers, setIsOverlayMoving, overlayMoveStateRef } = makeHandlers();
    const started = handlers.handleOverlayMoveMouseDown(IN.x, IN.y, evt);
    expect(started).toBe(true);
    expect(setIsOverlayMoving).toHaveBeenCalledWith(true);
    expect(overlayMoveStateRef.current).not.toBeNull(); // move seeded
  });

  it("a CONTENT zone hands the drag over (skips move, dispatches bodyDragStart)", () => {
    registerGridOverlay({ type: "test-overlay", render: () => {}, zoneAt: CONTENT_ZONE });
    const { handlers, setIsOverlayMoving, overlayMoveStateRef } = makeHandlers();
    const onStart = vi.fn();
    window.addEventListener("floatingObject:bodyDragStart", onStart);
    const claimed = handlers.handleOverlayMoveMouseDown(IN.x, IN.y, evt);
    window.removeEventListener("floatingObject:bodyDragStart", onStart);

    expect(claimed).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect((onStart.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ regionId: "r1", part: "brush" });
    expect(setIsOverlayMoving).not.toHaveBeenCalled(); // move NOT started
    expect(overlayMoveStateRef.current).toBeNull();    // no move state seeded
  });

  it("falls through to a move where the zone answers null (frame)", () => {
    registerGridOverlay({ type: "test-overlay", render: () => {}, zoneAt: () => null });
    const { handlers, setIsOverlayMoving } = makeHandlers();
    expect(handlers.handleOverlayMoveMouseDown(IN.x, IN.y, evt)).toBe(true);
    expect(setIsOverlayMoving).toHaveBeenCalledWith(true);
  });

  it("still dispatches floatingObject:selected in every case", () => {
    registerGridOverlay({ type: "test-overlay", render: () => {}, zoneAt: CONTENT_ZONE });
    const { handlers } = makeHandlers();
    const onSel = vi.fn();
    window.addEventListener("floatingObject:selected", onSel);
    handlers.handleOverlayMoveMouseDown(IN.x, IN.y, evt);
    window.removeEventListener("floatingObject:selected", onSel);
    expect(onSel).toHaveBeenCalledTimes(1);
  });
});
