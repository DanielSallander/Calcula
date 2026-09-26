//! FILENAME: app/extensions/CanvasSheet/__tests__/zOrderStore.test.ts
// PURPOSE: The canvas's STACKING and LOCK commands (M8 part C): bring forward
//          / send backward / to front / to back work on the EFFECTIVE stack
//          and always write the FULL ref list -- so an object inserted later
//          (missing from zOrder, painted on top) keeps its place -- and the
//          new order is what Core then PAINTS and HIT-TESTS, through the real
//          @api helpers and the canvas's own stacking resolver. Lock / unlock
//          write the full `locked` list. And the page's @api/objectStacking
//          service: it owns the order only on a canvas, and refuses a
//          subscribed one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CanvasLayout, CanvasLayoutPatch, CanvasObjectRef, SheetsResult } from "@api";

const getSheets = vi.fn<() => Promise<SheetsResult>>();
const setCanvasLayout = vi.fn<(patch: CanvasLayoutPatch, index?: number) => Promise<CanvasLayout>>();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
  setCanvasLayout: (patch: CanvasLayoutPatch, index?: number) => setCanvasLayout(patch, index),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

const provenance = vi.fn(async () => [] as Array<{ sheetId: string; role: string }>);
vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getSheetProvenance: () => provenance(),
}));

let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

const toasts: string[] = [];
vi.mock("@api/notifications", () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import {
  floatingHitOrder,
  registerRegionStacking,
  setGridRegions,
  stackedFloatingRegions,
  type GridRegion,
} from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { defaultCanvasLayout } from "@api/canvasSheet";
import {
  getCanvasSheetSnapshot,
  refreshCanvasProvenance,
  refreshCanvasSheets,
  resetCanvasSheetStore,
} from "../lib/canvasSheetStore";
import { canvasRegionZ, resetCanvasStacking } from "../lib/canvasStacking";
import { allLocked, restackKeys, restackObjects, setObjectsLocked } from "../lib/zOrderStore";
import { canvasStackingService } from "../lib/stackingService";

// ============================================================================
// Pure
// ============================================================================

describe("restackKeys", () => {
  const order = ["a", "b", "c", "d"];
  it("one object: forward / backward one step, to the front / back", () => {
    const b = new Set(["b"]);
    expect(restackKeys(order, b, "bringForward")).toEqual(["a", "c", "b", "d"]);
    expect(restackKeys(order, b, "sendBackward")).toEqual(["b", "a", "c", "d"]);
    expect(restackKeys(order, b, "bringToFront")).toEqual(["a", "c", "d", "b"]);
    expect(restackKeys(order, b, "sendToBack")).toEqual(["b", "a", "c", "d"]);
  });

  it("a selected run moves as a block, keeping its own order", () => {
    expect(restackKeys(order, new Set(["b", "c"]), "bringForward")).toEqual(["a", "d", "b", "c"]);
    expect(restackKeys(order, new Set(["c", "d"]), "sendBackward")).toEqual(["a", "c", "d", "b"]);
    expect(restackKeys(order, new Set(["a", "c"]), "bringToFront")).toEqual(["b", "d", "a", "c"]);
  });

  it("already at the top / bottom: nothing moves", () => {
    expect(restackKeys(order, new Set(["d"]), "bringForward")).toEqual(order);
    expect(restackKeys(order, new Set(["a"]), "sendBackward")).toEqual(order);
  });
});

// ============================================================================
// Against the store and Core's real stacking helpers
// ============================================================================

const CANVAS = 1;

function layout(over: Partial<CanvasLayout> = {}): CanvasLayout {
  return { ...defaultCanvasLayout(), ...over };
}

async function onCanvas(over: Partial<CanvasLayout> = {}): Promise<void> {
  getSheets.mockResolvedValueOnce({
    activeIndex: CANVAS,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      { index: CANVAS, name: "Page", visibility: "visible", sheetId: "cv-1", kind: "canvas", canvasLayout: layout(over) },
    ],
  });
  await refreshCanvasSheets();
  gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: CANVAS } };
}

function floating(id: string, type: string, key: string): GridRegion {
  return {
    id,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: 100, height: 100 },
    data: { key },
  };
}

function family(type: string, kind: string): ObjectSelectionProvider {
  return {
    types: [type],
    isSelected: () => false,
    select: () => {},
    deselectAll: () => {},
    refOf: (r) => ({ kind, id: String(r.data?.key) }),
  };
}

const c1 = floating("chart-c1", "chart", "c1");
const s1 = floating("slicer-s1", "slicer", "s1");
const c2 = floating("chart-c2", "chart", "c2");
const ids = (rs: GridRegion[]) => rs.map((r) => r.id);
const ref = (kind: string, id: string): CanvasObjectRef => ({ kind, id });

const cleanups: Array<() => void> = [];

beforeEach(() => {
  resetCanvasSheetStore();
  resetCanvasStacking();
  resetObjectSelectionProviders();
  getSheets.mockReset();
  setCanvasLayout.mockReset();
  provenance.mockReset();
  provenance.mockResolvedValue([]);
  toasts.length = 0;
  gridSnapshot = null;
  // The backend merges the patch into the stored layout and returns it.
  setCanvasLayout.mockImplementation(async (patch) => ({ ...getCanvasSheetSnapshot().active!.layout, ...patch }));
  cleanups.push(
    registerObjectSelectionProvider(family("chart", "chart")),
    registerObjectSelectionProvider(family("slicer", "slicer")),
    registerRegionStacking(canvasRegionZ),
  );
  // Publication order c1, s1, c2 -- c2 was inserted later and is NOT in zOrder.
  setGridRegions([c1, s1, c2]);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("restackObjects: the FULL list, over the EFFECTIVE stack", () => {
  it("bring to front writes every object -- the unlisted later insert keeps its place -- and Core paints and hits in the new order", async () => {
    await onCanvas({ zOrder: [ref("chart", "c1"), ref("slicer", "s1")] });
    // Effective stack now: c1, s1, then the unlisted c2 on top.
    expect(ids(stackedFloatingRegions())).toEqual(["chart-c1", "slicer-s1", "chart-c2"]);

    expect(await restackObjects("bringToFront", [c1])).toBe(true);
    expect(setCanvasLayout).toHaveBeenCalledTimes(1);
    expect(setCanvasLayout.mock.calls[0][0]).toEqual({
      zOrder: [ref("slicer", "s1"), ref("chart", "c2"), ref("chart", "c1")],
    });
    expect(ids(stackedFloatingRegions())).toEqual(["slicer-s1", "chart-c2", "chart-c1"]);
    expect(ids(floatingHitOrder())).toEqual(["chart-c1", "chart-c2", "slicer-s1"]);
  });

  it("send backward on the unlisted top object moves it one step down", async () => {
    await onCanvas({ zOrder: [ref("chart", "c1"), ref("slicer", "s1")] });
    await restackObjects("sendBackward", [c2]);
    expect(setCanvasLayout.mock.calls[0][0]).toEqual({
      zOrder: [ref("chart", "c1"), ref("chart", "c2"), ref("slicer", "s1")],
    });
    expect(ids(floatingHitOrder())).toEqual(["slicer-s1", "chart-c2", "chart-c1"]);
  });

  it("a no-op (already on top, every object listed) writes nothing", async () => {
    await onCanvas({ zOrder: [ref("chart", "c1"), ref("slicer", "s1"), ref("chart", "c2")] });
    expect(await restackObjects("bringToFront", [c2])).toBe(false);
    expect(setCanvasLayout).not.toHaveBeenCalled();
  });

  it("an empty zOrder is filled in completely by the first restack", async () => {
    await onCanvas();
    await restackObjects("sendToBack", [c2]);
    expect(setCanvasLayout.mock.calls[0][0]).toEqual({
      zOrder: [ref("chart", "c2"), ref("chart", "c1"), ref("slicer", "s1")],
    });
  });

  it("not on a canvas: nothing is written", async () => {
    expect(await restackObjects("bringToFront", [c1])).toBe(false);
    expect(setCanvasLayout).not.toHaveBeenCalled();
  });
});

describe("lock / unlock", () => {
  it("writes the FULL locked list, and allLocked follows it", async () => {
    await onCanvas({ locked: [ref("slicer", "s1")] });
    expect(allLocked([c1])).toBe(false);
    await setObjectsLocked(true, [c1, s1]);
    expect(setCanvasLayout.mock.calls[0][0]).toEqual({ locked: [ref("slicer", "s1"), ref("chart", "c1")] });
    expect(allLocked([c1, s1])).toBe(true);
    await setObjectsLocked(false, [s1]);
    expect(setCanvasLayout.mock.calls[1][0]).toEqual({ locked: [ref("chart", "c1")] });
    expect(allLocked([c1, s1])).toBe(false);
  });
});

describe("the page's stacking service (@api/objectStacking)", () => {
  it("owns an object's order only on a canvas", async () => {
    expect(canvasStackingService.ordersRegion(c1)).toBe(false);
    await onCanvas();
    expect(canvasStackingService.ordersRegion(c1)).toBe(true);
  });

  it("refuses to restack a SUBSCRIBED canvas, and says why", async () => {
    await onCanvas();
    provenance.mockResolvedValue([{ sheetId: "cv-1", role: "subscribed" }]);
    await refreshCanvasProvenance();
    expect(await canvasStackingService.restack("bringToFront", [c1])).toBe(false);
    expect(setCanvasLayout).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
  });
});
