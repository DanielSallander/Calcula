//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasStacking.test.ts
// PURPOSE: The canvas's stacking resolver (M8 part A): an object's z on the
//          ACTIVE canvas is its ref's index in the layout's zOrder; a ref the
//          zOrder does not list has no z (and Core paints it ON TOP); a
//          worksheet, or a canvas with an empty zOrder, has no opinion at all.
//          And the wiring: activate() registers the resolver with Core, and a
//          CANVAS_LAYOUT_CHANGED repaints in the new order.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CanvasLayout, CanvasObjectRef, SheetsResult } from "@api";

const getSheets = vi.fn<() => Promise<SheetsResult>>();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getSheetProvenance: vi.fn(async () => []),
}));

let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

import {
  floatingHitOrder,
  hasStackingOrder,
  onRegionChange,
  registerRegionStacking,
  setGridRegions,
  stackedFloatingRegions,
  effectiveZ,
  type GridRegion,
} from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { AppEvents, emitAppEvent } from "@api/events";
import { applyCanvasLayout, refreshCanvasSheets, resetCanvasSheetStore } from "../lib/canvasSheetStore";
import { canvasRegionZ, resetCanvasStacking, zOrderIndex } from "../lib/canvasStacking";

const CANVAS = 1;

function layout(zOrder?: CanvasObjectRef[]): CanvasLayout {
  return { ...defaultCanvasLayout(), ...(zOrder ? { zOrder } : {}) };
}

function sheets(zOrder?: CanvasObjectRef[]): SheetsResult {
  return {
    activeIndex: CANVAS,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      { index: CANVAS, name: "Page", visibility: "visible", sheetId: "cv-1", kind: "canvas", canvasLayout: layout(zOrder) },
    ],
  };
}

function floating(id: string, type: string, data: Record<string, unknown>): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x: 0, y: 0, width: 100, height: 100 }, data };
}

/** A family whose ref is { kind, id: data.id }. */
function family(type: string, kind: string): ObjectSelectionProvider {
  return {
    types: [type],
    isSelected: () => false,
    select: () => {},
    deselectAll: () => {},
    refOf: (r) => (typeof r.data?.id === "string" ? { kind, id: r.data.id } : null),
  };
}

const chart = (id: string) => floating(`chart-${id}`, "chart", { id });
const slicer = (id: string) => floating(`slicer-${id}`, "slicer", { id });
const ids = (rs: GridRegion[]) => rs.map((r) => r.id);

const cleanups: Array<() => void> = [];

async function onCanvasWith(zOrder?: CanvasObjectRef[]): Promise<void> {
  getSheets.mockResolvedValueOnce(sheets(zOrder));
  await refreshCanvasSheets();
  gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: CANVAS } };
}

beforeEach(() => {
  resetCanvasSheetStore();
  resetCanvasStacking();
  resetObjectSelectionProviders();
  getSheets.mockReset();
  gridSnapshot = null;
  cleanups.push(
    registerObjectSelectionProvider(family("chart", "chart")),
    registerObjectSelectionProvider(family("slicer", "slicer")),
  );
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("canvasRegionZ", () => {
  it("a listed ref answers its index in zOrder", async () => {
    await onCanvasWith([
      { kind: "slicer", id: "s1" },
      { kind: "chart", id: "c1" },
    ]);
    expect(canvasRegionZ(slicer("s1"))).toBe(0);
    expect(canvasRegionZ(chart("c1"))).toBe(1);
  });

  it("an UNLISTED ref has no z (Core paints it above every listed one)", async () => {
    await onCanvasWith([{ kind: "chart", id: "c1" }]);
    expect(canvasRegionZ(chart("new"))).toBeUndefined();
    cleanups.push(registerRegionStacking(canvasRegionZ));
    expect(ids(stackedFloatingRegions([chart("new"), chart("c1")]))).toEqual(["chart-c1", "chart-new"]);
  });

  it("the same id under ANOTHER kind is a different object", async () => {
    await onCanvasWith([{ kind: "chart", id: "x" }]);
    expect(canvasRegionZ(slicer("x"))).toBeUndefined();
  });

  it("a worksheet has no opinion, even with a canvas elsewhere in the book", async () => {
    await onCanvasWith([{ kind: "chart", id: "c1" }]);
    gridSnapshot = { surface: "grid", sheetContext: { activeSheetIndex: 0 } };
    expect(canvasRegionZ(chart("c1"))).toBeUndefined();
  });

  it("a canvas with an EMPTY zOrder has no opinion: the historical order stands", async () => {
    await onCanvasWith();
    cleanups.push(registerRegionStacking(canvasRegionZ));
    const regions = [slicer("s1"), chart("c1")];
    expect(canvasRegionZ(chart("c1"))).toBeUndefined();
    expect(hasStackingOrder(regions)).toBe(false);
    expect(ids(floatingHitOrder(regions))).toEqual(["chart-c1", "slicer-s1"]);
  });

  it("a region nobody can name, or a cell-anchored one, has no z", async () => {
    await onCanvasWith([{ kind: "chart", id: "c1" }]);
    expect(canvasRegionZ(floating("x", "chart", {}))).toBeUndefined();
    expect(canvasRegionZ({ ...chart("c1"), floating: undefined })).toBeUndefined();
    expect(canvasRegionZ(floating("u", "unowned", { id: "c1" }))).toBeUndefined();
  });

  it("a duplicated ref answers its FIRST position", () => {
    const idx = zOrderIndex(
      layout([
        { kind: "chart", id: "c1" },
        { kind: "slicer", id: "s1" },
        { kind: "chart", id: "c1" },
      ]),
    );
    expect(idx.get("chart:c1")).toBe(0);
    expect(idx.get("slicer:s1")).toBe(1);
  });

  it("follows a layout write at once (the cached index is keyed on the layout)", async () => {
    await onCanvasWith([
      { kind: "chart", id: "c1" },
      { kind: "slicer", id: "s1" },
    ]);
    expect(canvasRegionZ(chart("c1"))).toBe(0);
    applyCanvasLayout(CANVAS, layout([
      { kind: "slicer", id: "s1" },
      { kind: "chart", id: "c1" },
    ]));
    expect(canvasRegionZ(chart("c1"))).toBe(1);
  });

  it("through Core: the saved order decides paint AND hit, whatever the publication order", async () => {
    await onCanvasWith([
      { kind: "chart", id: "c1" },
      { kind: "slicer", id: "s1" },
    ]);
    cleanups.push(registerRegionStacking(canvasRegionZ));
    // The chart was re-published last (a drag frame): without z it would be hit first.
    const regions = [slicer("s1"), chart("c1")];
    expect(ids(stackedFloatingRegions(regions))).toEqual(["chart-c1", "slicer-s1"]);
    expect(ids(floatingHitOrder(regions))).toEqual(["slicer-s1", "chart-c1"]);
  });
});

describe("activate() wiring", () => {
  it("registers the resolver with Core, and a CANVAS_LAYOUT_CHANGED repaints in the new order", async () => {
    getSheets.mockResolvedValue(sheets([
      { kind: "chart", id: "c1" },
      { kind: "slicer", id: "s1" },
    ]));
    gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: CANVAS } };
    const { default: extension } = await import("../index");
    extension.activate({} as never);
    cleanups.push(() => extension.deactivate?.());
    await vi.waitFor(() => expect(effectiveZ(chart("c1"))).toBe(0));

    const redraws = vi.fn();
    cleanups.push(onRegionChange(redraws));
    getSheets.mockResolvedValue(sheets([
      { kind: "slicer", id: "s1" },
      { kind: "chart", id: "c1" },
    ]));
    emitAppEvent(AppEvents.CANVAS_LAYOUT_CHANGED);
    await vi.waitFor(() => expect(effectiveZ(chart("c1"))).toBe(1));
    expect(redraws).toHaveBeenCalled();
  });
});
