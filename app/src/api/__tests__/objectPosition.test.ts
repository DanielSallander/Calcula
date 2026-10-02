//! FILENAME: app/src/api/__tests__/objectPosition.test.ts
// PURPOSE: The Size and Position seam (BUG-0258 design phase 5b,
//          @api/objectPosition): what an object may do (the same three refusals
//          Core's drag applies, in order, plus a provider that cannot resize),
//          the last-wins opener with a stale cleanup that removes nothing, the
//          menu row every family adds, and the grip menu's item registry
//          (order, visibility, enabledness, throwing predicates, one object).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GridRegion } from "../gridOverlays";
import { registerObjectGeometryProvider, resetObjectGeometryProviders } from "../objectGeometry";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../layoutSurface";
import { setDesignMode } from "../designMode";
import {
  SIZE_AND_POSITION_COMMAND,
  SIZE_AND_POSITION_ITEM_ID,
  SIZE_AND_POSITION_LABEL,
  SIZE_POSITION_DESIGN_MODE,
  SIZE_POSITION_FIXED_SIZE,
  SIZE_POSITION_IMMOVABLE,
  SIZE_POSITION_LOCKED,
  SIZE_POSITION_NOT_INSTALLED,
  SIZE_POSITION_NO_PROVIDER,
  SIZE_POSITION_SUBSCRIBED,
  hasSizeAndPositionOpener,
  objectGripMenuItems,
  openSizeAndPosition,
  registerObjectGripMenuItem,
  registerSizeAndPositionOpener,
  resetObjectPosition,
  sizeAndPositionAvailability,
  sizeAndPositionMenuEntry,
} from "../objectPosition";

function region(type: string, id = `${type}-1`, data: Record<string, unknown> = {}, floating = true): GridRegion {
  return {
    id,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    data,
    ...(floating ? { floating: { x: 64, y: 32, width: 200, height: 100 } } : {}),
  };
}

let surface: LayoutSurface | null = null;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  resetObjectPosition();
  resetObjectGeometryProviders();
  setDesignMode(false);
  surface = null;
  cleanups.push(registerLayoutSurfaceProvider({ get: () => surface }));
  cleanups.push(registerObjectGeometryProvider({ types: ["slicer"], commit: async () => {} }));
  cleanups.push(
    registerObjectGeometryProvider({ types: ["floating-range"], canResize: () => false, commit: async () => {} }),
  );
  cleanups.push(registerObjectGeometryProvider({ types: ["floating-control"], commit: async () => {} }));
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setDesignMode(false);
  vi.restoreAllMocks();
});

function canvas(over: Partial<LayoutSurface> = {}): LayoutSurface {
  return { snapToGrid: true, gridSize: 16, showGrid: true, page: { width: 1280, height: 720 }, editable: true, ...over };
}

describe("sizeAndPositionAvailability: Core's drag rule, in order", () => {
  it("a worksheet object with a provider: moves and resizes, no page", () => {
    expect(sizeAndPositionAvailability(region("slicer"))).toEqual({
      provided: true,
      move: true,
      resize: true,
      reason: null,
      sizeReason: null,
      page: null,
    });
  });

  it("no provider, or a cell-anchored region: nothing, with the reason", () => {
    for (const r of [region("unknown-family"), region("slicer", "s", {}, false)]) {
      const a = sizeAndPositionAvailability(r);
      expect(a).toMatchObject({ provided: false, move: false, resize: false, reason: SIZE_POSITION_NO_PROVIDER });
    }
  });

  it("a SUBSCRIBED page: nothing (the layout is the publisher's), the page still reported", () => {
    surface = canvas({ editable: false });
    expect(sizeAndPositionAvailability(region("slicer"))).toMatchObject({
      provided: true,
      move: false,
      resize: false,
      reason: SIZE_POSITION_SUBSCRIBED,
      page: { width: 1280, height: 720 },
    });
  });

  it("a LOCKED object: nothing, 'unlock it'", () => {
    surface = canvas({ isLocked: (r) => r.id === "slicer-1" });
    expect(sizeAndPositionAvailability(region("slicer"))).toMatchObject({ move: false, resize: false, reason: SIZE_POSITION_LOCKED });
    // Another object on the same page is not locked.
    expect(sizeAndPositionAvailability(region("slicer", "slicer-2")).move).toBe(true);
  });

  it("movable: false (a run-mode button): nothing -- 'turn on Design Mode' while it is off", () => {
    const button = region("floating-control", "ctl-1", { movable: false });
    expect(sizeAndPositionAvailability(button)).toMatchObject({ provided: true, move: false, reason: SIZE_POSITION_DESIGN_MODE });
    setDesignMode(true);
    expect(sizeAndPositionAvailability(button).reason).toBe(SIZE_POSITION_IMMOVABLE);
  });

  it("subscribed is said before locked, and locked before movable: the first thing to change", () => {
    surface = canvas({ editable: false, isLocked: () => true });
    const button = region("floating-control", "ctl-1", { movable: false });
    expect(sizeAndPositionAvailability(button).reason).toBe(SIZE_POSITION_SUBSCRIBED);
    surface = canvas({ isLocked: () => true });
    expect(sizeAndPositionAvailability(button).reason).toBe(SIZE_POSITION_LOCKED);
  });

  it("a provider that cannot resize (a floating grid): moves, does not resize, says why", () => {
    surface = canvas();
    expect(sizeAndPositionAvailability(region("floating-range"))).toEqual({
      provided: true,
      move: true,
      resize: false,
      reason: null,
      sizeReason: SIZE_POSITION_FIXED_SIZE,
      page: { width: 1280, height: 720 },
    });
  });

  it("a lock answer that throws counts as unlocked (the surface rule), never as a refusal", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    surface = canvas({
      isLocked: () => {
        throw new Error("broken");
      },
    });
    expect(sizeAndPositionAvailability(region("slicer")).move).toBe(true);
  });
});

describe("the opener: last wins, a stale cleanup removes nothing", () => {
  it("opens nothing without one", () => {
    expect(hasSizeAndPositionOpener()).toBe(false);
    expect(openSizeAndPosition(region("slicer"))).toBe(false);
  });

  it("the newest opener gets the region (and the anchor)", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerSizeAndPositionOpener(first);
    registerSizeAndPositionOpener(second);
    const r = region("slicer");
    const anchor = { x: 1, y: 2, width: 24, height: 24 };
    expect(openSizeAndPosition(r, anchor)).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(r, anchor);

    // The FIRST registration's cleanup is stale: it must not remove the second.
    offFirst();
    expect(hasSizeAndPositionOpener()).toBe(true);
    expect(openSizeAndPosition(r)).toBe(true);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("the live cleanup removes it; an opener that throws reports false (logged)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const off = registerSizeAndPositionOpener(() => {
      throw new Error("boom");
    });
    expect(openSizeAndPosition(region("slicer"))).toBe(false);
    off();
    expect(hasSizeAndPositionOpener()).toBe(false);
  });
});

describe("the menu row every family adds", () => {
  it("is enabled when a dialog can open, and runs the opener with THIS region", () => {
    const open = vi.fn();
    registerSizeAndPositionOpener(open);
    const r = region("slicer");
    const entry = sizeAndPositionMenuEntry(r);
    expect(entry).toMatchObject({ id: SIZE_AND_POSITION_ITEM_ID, label: SIZE_AND_POSITION_LABEL, disabled: false, reason: null });
    entry.run();
    expect(open).toHaveBeenCalledWith(r, undefined);
  });

  it("a LOCKED object's row stays enabled (the dialog opens read-only) and carries the reason", () => {
    registerSizeAndPositionOpener(vi.fn());
    surface = canvas({ isLocked: () => true });
    expect(sizeAndPositionMenuEntry(region("slicer"))).toMatchObject({ disabled: false, reason: SIZE_POSITION_LOCKED });
  });

  it("is disabled, and runs nothing, with no provider or no dialog installed", () => {
    const open = vi.fn();
    const none = sizeAndPositionMenuEntry(region("slicer"));
    expect(none).toMatchObject({ disabled: true, reason: SIZE_POSITION_NOT_INSTALLED });
    none.run();
    registerSizeAndPositionOpener(open);
    const unowned = sizeAndPositionMenuEntry(region("unknown-family"));
    expect(unowned).toMatchObject({ disabled: true, reason: SIZE_POSITION_NO_PROVIDER });
    unowned.run();
    expect(open).not.toHaveBeenCalled();
  });

  it("the command id is the item id's spelling and not a cell command", () => {
    expect(SIZE_AND_POSITION_COMMAND).toBe("object.sizeAndPosition");
  });
});

describe("the grip menu's items", () => {
  it("are ordered by `order`, then by registration; invisible ones are left out", () => {
    const r = region("slicer");
    registerObjectGripMenuItem({ id: "c", label: "C", order: 30, run: () => {} });
    registerObjectGripMenuItem({ id: "a", label: "A", order: 10, run: () => {} });
    registerObjectGripMenuItem({ id: "b", label: "B", order: 10, run: () => {} });
    registerObjectGripMenuItem({ id: "hidden", label: "H", order: 0, visible: () => false, run: () => {} });
    expect(objectGripMenuItems(r).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("visible/enabled are asked for THIS region; run acts on THIS region", async () => {
    const seen: string[] = [];
    registerObjectGripMenuItem({
      id: "canvas-only",
      label: "Canvas only",
      visible: (r) => r.data?.onCanvas === true,
      enabled: (r) => r.id !== "slicer-locked",
      run: (r) => {
        seen.push(r.id);
      },
    });
    expect(objectGripMenuItems(region("slicer", "slicer-ws"))).toEqual([]);
    const items = objectGripMenuItems(region("slicer", "slicer-cv", { onCanvas: true }));
    expect(items.map((i) => [i.id, i.enabled])).toEqual([["canvas-only", true]]);
    expect(objectGripMenuItems(region("slicer", "slicer-locked", { onCanvas: true }))[0].enabled).toBe(false);
    items[0].run();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["slicer-cv"]);
  });

  it("a predicate that throws hides (visible) or disables (enabled) the item; a failing run is logged, never thrown", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    registerObjectGripMenuItem({
      id: "bad-visible",
      label: "x",
      visible: () => {
        throw new Error("v");
      },
      run: () => {},
    });
    registerObjectGripMenuItem({
      id: "bad-enabled",
      label: "y",
      enabled: () => {
        throw new Error("e");
      },
      run: async () => {
        throw new Error("r");
      },
    });
    const items = objectGripMenuItems(region("slicer"));
    expect(items.map((i) => [i.id, i.enabled])).toEqual([["bad-enabled", false]]);
    expect(() => items[0].run()).not.toThrow();
    await new Promise((res) => setTimeout(res, 0));
    expect(log.mock.calls.some((c) => String(c[0]).includes("bad-enabled") && String(c[0]).includes("failed"))).toBe(true);
  });

  it("registering an id again replaces it; the replaced registration's cleanup removes nothing", () => {
    const offOld = registerObjectGripMenuItem({ id: "x", label: "Old", run: () => {} });
    const offNew = registerObjectGripMenuItem({ id: "x", label: "New", run: () => {} });
    expect(objectGripMenuItems(region("slicer")).map((i) => i.label)).toEqual(["New"]);
    offOld();
    expect(objectGripMenuItems(region("slicer")).map((i) => i.label)).toEqual(["New"]);
    offNew();
    expect(objectGripMenuItems(region("slicer"))).toEqual([]);
  });
});
