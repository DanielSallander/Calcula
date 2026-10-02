//! FILENAME: app/extensions/CanvasSheet/__tests__/gripMenuItems.test.ts
// PURPOSE: What a canvas adds to an object's grip menu (BUG-0258 design phase
//          5b, lib/gripMenuItems.ts), through the REAL @api/objectPosition
//          registry: Bring Forward, Send Backward and Lock, in that order, for
//          an object on the active canvas -- each acting on THAT object (the
//          one whose grip was clicked), never on the whole selection; none of
//          them on a worksheet; disabled on a subscribed page; Lock disabled
//          for an object already locked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  snapshot: { active: null as unknown, activeSubscribed: false },
  locked: false,
  restack: vi.fn(async (_c: string, _r?: unknown[]) => true),
  lock: vi.fn(async (_l: boolean, _r?: unknown[]) => true),
}));

vi.mock("../lib/canvasSheetStore", () => ({
  getCanvasSheetSnapshot: () => h.snapshot,
  subscribeCanvasSheets: () => () => {},
}));
vi.mock("../lib/zOrderStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/zOrderStore")>()),
  allLocked: () => h.locked,
  restackObjects: (c: string, r?: unknown[]) => h.restack(c, r),
  setObjectsLocked: (l: boolean, r?: unknown[]) => h.lock(l, r),
}));
vi.mock("@api/objectSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectSelection")>()),
  objectRefOf: (r: { data?: Record<string, unknown> }) =>
    typeof r.data?.chartId === "string" ? { kind: "chart", id: r.data.chartId } : null,
}));

import type { GridRegion } from "@api/gridOverlays";
import { objectGripMenuItems, resetObjectPosition } from "@api/objectPosition";
import { CANVAS_GRIP_ITEM_IDS, installCanvasGripMenuItems } from "../lib/gripMenuItems";

const CHART: GridRegion = {
  id: "chart-c1",
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: { chartId: "c1" },
  floating: { x: 64, y: 64, width: 320, height: 200 },
};

let cleanups: Array<() => void> = [];

beforeEach(() => {
  resetObjectPosition();
  h.snapshot = { active: { index: 2, name: "Canvas1", layout: {} }, activeSubscribed: false };
  h.locked = false;
  h.restack.mockClear();
  h.lock.mockClear();
  cleanups = installCanvasGripMenuItems();
});

afterEach(() => {
  cleanups.forEach((c) => c());
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("the canvas's grip-menu items", () => {
  it("Bring Forward, Send Backward, Lock -- in that order, enabled -- for an object on the active canvas", () => {
    expect(objectGripMenuItems(CHART).map((i) => [i.id, i.label, i.enabled])).toEqual([
      [CANVAS_GRIP_ITEM_IDS.bringForward, "Bring Forward", true],
      [CANVAS_GRIP_ITEM_IDS.sendBackward, "Send Backward", true],
      [CANVAS_GRIP_ITEM_IDS.lock, "Lock", true],
    ]);
  });

  it("each acts on THAT object -- never on the whole selection", async () => {
    const [forward, backward, lock] = objectGripMenuItems(CHART);
    forward.run();
    await settle();
    expect(h.restack).toHaveBeenCalledWith("bringForward", [CHART]);
    backward.run();
    await settle();
    expect(h.restack).toHaveBeenLastCalledWith("sendBackward", [CHART]);
    lock.run();
    await settle();
    expect(h.lock).toHaveBeenCalledWith(true, [CHART]);
  });

  it("none of them on a worksheet (no page, no zOrder, no lock), nor for an object the page cannot name", () => {
    h.snapshot = { active: null, activeSubscribed: false };
    expect(objectGripMenuItems(CHART)).toEqual([]);
    h.snapshot = { active: { index: 2, name: "Canvas1", layout: {} }, activeSubscribed: false };
    expect(objectGripMenuItems({ ...CHART, data: {} })).toEqual([]);
  });

  it("disabled on a subscribed page; Lock disabled for an object already locked", () => {
    h.snapshot = { active: { index: 2, name: "Canvas1", layout: {} }, activeSubscribed: true };
    expect(objectGripMenuItems(CHART).map((i) => i.enabled)).toEqual([false, false, false]);
    h.snapshot = { active: { index: 2, name: "Canvas1", layout: {} }, activeSubscribed: false };
    h.locked = true;
    expect(objectGripMenuItems(CHART).map((i) => i.enabled)).toEqual([true, true, false]);
  });

  it("the cleanups take every item away", () => {
    cleanups.forEach((c) => c());
    cleanups = [];
    expect(objectGripMenuItems(CHART)).toEqual([]);
  });
});
