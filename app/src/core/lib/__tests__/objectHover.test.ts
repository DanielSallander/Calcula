//! FILENAME: app/src/core/lib/__tests__/objectHover.test.ts
// PURPOSE: Core's floating-object HOVER and GESTURE facts (core/lib/objectHover.ts;
//          BUG-0258 design phase 5): each listener hears exactly ONE call per
//          change -- never a call for a "change" to the same value (the grid
//          repaints on these, and the hook sets the hover on EVERY mousemove);
//          clear works; a throwing listener does not stop the others; the
//          facade re-exports the hover half from this leaf.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  clearFloatingHover,
  getHoveredFloatingRegionId,
  isFloatingGestureActive,
  onFloatingGestureChanged,
  onFloatingHoverChanged,
  resetObjectHoverForTests,
  setFloatingGestureActive,
  setHoveredFloatingRegion,
} from "../objectHover";
import * as facade from "../../../api/gridOverlays";

afterEach(() => {
  resetObjectHoverForTests();
  vi.restoreAllMocks();
});

describe("the hover", () => {
  it("enter / move inside / leave: exactly one listener call per CHANGE, with the previous id", () => {
    const calls: Array<[string | null, string | null]> = [];
    onFloatingHoverChanged((id, prev) => calls.push([id, prev]));
    setHoveredFloatingRegion("slicer-1");
    setHoveredFloatingRegion("slicer-1"); // a move inside the same object
    setHoveredFloatingRegion("slicer-1");
    setHoveredFloatingRegion("chart-2");
    setHoveredFloatingRegion(null);
    setHoveredFloatingRegion(null);
    expect(calls).toEqual([
      ["slicer-1", null],
      ["chart-2", "slicer-1"],
      [null, "chart-2"],
    ]);
    expect(getHoveredFloatingRegionId()).toBeNull();
  });

  it("clearFloatingHover clears, and announces only when something was hovered", () => {
    const cb = vi.fn();
    onFloatingHoverChanged(cb);
    clearFloatingHover();
    expect(cb).not.toHaveBeenCalled();
    setHoveredFloatingRegion("a");
    clearFloatingHover();
    expect(getHoveredFloatingRegionId()).toBeNull();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("the unsubscribe stops the calls; a throwing listener is logged and the others still run", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    onFloatingHoverChanged(bad);
    const off = onFloatingHoverChanged(good);
    setHoveredFloatingRegion("a");
    expect(good).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    off();
    setHoveredFloatingRegion("b");
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("@api/gridOverlays re-exports the hover half from this leaf (one state, not a copy)", () => {
    setHoveredFloatingRegion("x");
    expect(facade.getHoveredFloatingRegionId()).toBe("x");
    const cb = vi.fn();
    facade.onFloatingHoverChanged(cb);
    setHoveredFloatingRegion(null);
    expect(cb).toHaveBeenCalledWith(null, "x");
  });
});

describe("the gesture flag", () => {
  it("one listener call per change; setting the same value is silent", () => {
    const calls: boolean[] = [];
    onFloatingGestureChanged((a) => calls.push(a));
    setFloatingGestureActive(false);
    setFloatingGestureActive(true);
    setFloatingGestureActive(true);
    setFloatingGestureActive(false);
    expect(calls).toEqual([true, false]);
    expect(isFloatingGestureActive()).toBe(false);
  });
});
