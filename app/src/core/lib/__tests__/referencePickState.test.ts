//! FILENAME: app/src/core/lib/__tests__/referencePickState.test.ts
// PURPOSE: The reference-pick state leaf (D-PICK): ONE predicate under every
//          door (floatingHandles.ts, @api/editing, Core's press), the preview a
//          pick drag publishes, and the echo window of a finished pick.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerGridReferencePickProbe,
  floatingReferencePickActive,
  getFloatingReferencePickPreview,
  setFloatingReferencePickPreview,
  onFloatingReferencePickPreviewChanged,
  noteFinishedReferencePick,
  isReferencePickEcho,
  DOUBLE_CLICK_ECHO_MS,
  ECHO_RADIUS_PX,
  __resetReferencePickStateForTests,
} from "../referencePickState";
import * as floatingHandles from "../floatingHandles";
import * as editing from "../../../api/editing";
import * as gridOverlays from "../../../api/gridOverlays";
import { registerExternalFormulaTarget, __resetExternalEditForTests } from "../formulaEditTarget";

const cleanups: Array<() => void> = [];

beforeEach(() => {
  __resetReferencePickStateForTests();
  __resetExternalEditForTests();
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  __resetReferencePickStateForTests();
  __resetExternalEditForTests();
  vi.restoreAllMocks();
});

describe("one predicate, one probe", () => {
  it("floatingHandles and @api/editing hand out the SAME functions (no second copy to drift)", () => {
    expect(floatingHandles.floatingReferencePickActive).toBe(floatingReferencePickActive);
    expect(floatingHandles.registerGridReferencePickProbe).toBe(registerGridReferencePickProbe);
    expect(editing.isFormulaReferencePickActive).toBe(floatingReferencePickActive);
  });

  it("the facade re-exports the preview readers from this leaf", () => {
    expect(gridOverlays.getFloatingReferencePickPreview).toBe(getFloatingReferencePickPreview);
    expect(gridOverlays.onFloatingReferencePickPreviewChanged).toBe(onFloatingReferencePickPreviewChanged);
    // The writer is Core's alone.
    expect((gridOverlays as Record<string, unknown>).setFloatingReferencePickPreview).toBeUndefined();
    expect((editing as Record<string, unknown>).setFloatingReferencePickPreview).toBeUndefined();
  });

  it("the grid probe OR an external target expecting a reference", () => {
    let grid = false;
    cleanups.push(registerGridReferencePickProbe(() => grid));
    expect(floatingReferencePickActive()).toBe(false);
    grid = true;
    expect(floatingReferencePickActive()).toBe(true);
    grid = false;
    let expecting = true;
    cleanups.push(
      registerExternalFormulaTarget({
        isExpectingReference: () => expecting,
        insertReference: () => {},
      }),
    );
    expect(floatingReferencePickActive()).toBe(true);
    expecting = false;
    expect(floatingReferencePickActive()).toBe(false);
  });

  it("a throwing probe is logged and counts as false; a stale cleanup keeps the newer probe", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const offOld = registerGridReferencePickProbe(() => {
      throw new Error("probe");
    });
    expect(floatingReferencePickActive()).toBe(false);
    expect(error).toHaveBeenCalled();
    cleanups.push(registerGridReferencePickProbe(() => true));
    offOld();
    expect(floatingReferencePickActive()).toBe(true);
  });
});

describe("the pick drag's preview", () => {
  const range = { space: "object" as const, name: "Float2", startRow: 0, startCol: 0, endRow: 1, endCol: 1 };

  it("set and read back; listeners hear each change; null over null is silent", () => {
    const heard = vi.fn();
    cleanups.push(onFloatingReferencePickPreviewChanged(heard));
    expect(getFloatingReferencePickPreview()).toBeNull();
    setFloatingReferencePickPreview({ regionId: "fr-2", range });
    expect(getFloatingReferencePickPreview()).toEqual({ regionId: "fr-2", range });
    expect(heard).toHaveBeenCalledTimes(1);
    setFloatingReferencePickPreview(null);
    expect(getFloatingReferencePickPreview()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    setFloatingReferencePickPreview(null);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("an unsubscribed listener hears nothing; a throwing one does not stop the others", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gone = vi.fn();
    const stays = vi.fn();
    const off = onFloatingReferencePickPreviewChanged(gone);
    cleanups.push(
      onFloatingReferencePickPreviewChanged(() => {
        throw new Error("listener");
      }),
      onFloatingReferencePickPreviewChanged(stays),
    );
    off();
    setFloatingReferencePickPreview({ regionId: "fr-2", range });
    expect(gone).not.toHaveBeenCalled();
    expect(stays).toHaveBeenCalledTimes(1);
  });
});

describe("the echo window", () => {
  const T0 = 1_000_000;

  it("is 500 ms and 4 px", () => {
    expect(DOUBLE_CLICK_ECHO_MS).toBe(500);
    expect(ECHO_RADIUS_PX).toBe(4);
  });

  it("time edges: 499 ms is an echo, 501 ms is not", () => {
    noteFinishedReferencePick("fr-2", 100, 100, T0);
    expect(isReferencePickEcho("fr-2", 100, 100, T0)).toBe(true);
    expect(isReferencePickEcho("fr-2", 100, 100, T0 + 499)).toBe(true);
    expect(isReferencePickEcho("fr-2", 100, 100, T0 + 501)).toBe(false);
  });

  it("distance edges: 3.9 px is an echo, 4.1 px is not", () => {
    noteFinishedReferencePick("fr-2", 100, 100, T0);
    expect(isReferencePickEcho("fr-2", 103.9, 100, T0 + 10)).toBe(true);
    expect(isReferencePickEcho("fr-2", 100, 95.9, T0 + 10)).toBe(false);
    expect(isReferencePickEcho("fr-2", 104.1, 100, T0 + 10)).toBe(false);
  });

  it("another object, no pick at all, or no coordinates: never an echo", () => {
    expect(isReferencePickEcho("fr-2", 100, 100, T0)).toBe(false);
    noteFinishedReferencePick("fr-2", 100, 100, T0);
    expect(isReferencePickEcho("pivot-1", 100, 100, T0 + 10)).toBe(false);
    expect(isReferencePickEcho("fr-2", Number.NaN, Number.NaN, T0 + 10)).toBe(false);
    // A clock that went backwards is not inside the window.
    expect(isReferencePickEcho("fr-2", 100, 100, T0 - 10)).toBe(false);
  });

  it("the reset forgets the last pick", () => {
    noteFinishedReferencePick("fr-2", 100, 100, T0);
    __resetReferencePickStateForTests();
    expect(isReferencePickEcho("fr-2", 100, 100, T0 + 10)).toBe(false);
  });
});
