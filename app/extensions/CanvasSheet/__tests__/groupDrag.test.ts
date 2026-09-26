//! FILENAME: app/extensions/CanvasSheet/__tests__/groupDrag.test.ts
// PURPOSE: The canvas GROUP DRAG (M8 part C5): dragging one member of a
//          multi-selection moves the members nobody else moves -- a set-held
//          second chart, the other family's objects -- by the lead's (snapped)
//          delta, kept on the page, previewed per frame and committed ONCE; a
//          family that co-moves its own selection is left to it; locked
//          members stay; and the whole gesture -- the lead family's own
//          persist included -- is ONE undo step (one begin, one commit, the
//          commit after every write and every debounced flush).

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

const log: string[] = [];
vi.mock("../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/lib/tauri-api")>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import {
  registerObjectGeometryProvider,
  resetObjectGeometryProviders,
  runInUndoTransaction,
  type ObjectGeometryChange,
  type ObjectGeometryProvider,
} from "@api/objectGeometry";
import { registerLayoutSurfaceProvider } from "@api/layoutSurface";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { refreshCanvasSheets, resetCanvasSheetStore } from "../lib/canvasSheetStore";
import { canvasLayoutSurfaceProvider } from "../lib/layoutSurfaceProvider";
import {
  GROUP_DRAG_UNDO_LABEL,
  handleGroupDragComplete,
  handleGroupDragPress,
  handleGroupDragPreview,
  installCanvasGroupDrag,
  resetCanvasGroupDrag,
} from "../lib/groupDrag";

const CANVAS = 1;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function onCanvas(locked?: CanvasObjectRef[]): Promise<void> {
  const layout: CanvasLayout = {
    ...defaultCanvasLayout(),
    pageWidth: 1000,
    pageHeight: 600,
    ...(locked ? { locked } : {}),
  };
  getSheets.mockResolvedValueOnce({
    activeIndex: CANVAS,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      { index: CANVAS, name: "Page", visibility: "visible", sheetId: "cv-1", kind: "canvas", canvasLayout: layout },
    ],
  });
  await refreshCanvasSheets();
  gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: CANVAS } };
}

function region(id: string, type: string, x: number, y: number): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y, width: 100, height: 50 }, data: { key: id } };
}

const c1 = region("c1", "chart", 100, 100);
const c2 = region("c2", "chart", 300, 100);
const s1 = region("s1", "slicer", 100, 300);
const s2 = region("s2", "slicer", 300, 300);

/** A single-select family (Charts): no addToSelection, so a 2nd member is set-held. */
function chartSelection(): ObjectSelectionProvider {
  let current: string | null = null;
  return {
    types: ["chart"],
    isSelected: (r) => r.id === current,
    select: (r) => {
      current = r.id;
    },
    deselectAll: () => {
      current = null;
    },
    refOf: (r) => ({ kind: "chart", id: r.id }),
  };
}

/** A multi-select family (Slicer). */
function slicerSelection(): ObjectSelectionProvider {
  const held = new Set<string>();
  return {
    types: ["slicer"],
    isSelected: (r) => held.has(r.id),
    select: (r) => {
      held.clear();
      held.add(r.id);
    },
    deselectAll: () => held.clear(),
    addToSelection: (r) => {
      held.add(r.id);
    },
    removeFromSelection: (r) => {
      held.delete(r.id);
    },
    refOf: (r) => ({ kind: "slicer", id: r.id }),
  };
}

const previews: Record<string, ObjectGeometryChange[][]> = {};
const commits: Record<string, ObjectGeometryChange[][]> = {};

function geometry(type: string, coMoves: boolean): ObjectGeometryProvider {
  return {
    types: [type],
    coMovesOwnSelection: coMoves,
    preview: (changes) => {
      (previews[type] ??= []).push([...changes]);
    },
    commit: async (changes) => {
      await tick();
      (commits[type] ??= []).push([...changes]);
      log.push(`commit:${type}:${changes.map((c) => c.region.id).join(",")}`);
    },
    flush: async () => {
      await tick();
      log.push(`flush:${type}`);
    },
  };
}

const ev = (type: string, detail: Record<string, unknown>) => new CustomEvent(type, { detail });
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  resetCanvasSheetStore();
  resetObjectSelectionProviders();
  resetObjectGeometryProviders();
  resetCanvasGroupDrag();
  getSheets.mockReset();
  gridSnapshot = null;
  log.length = 0;
  for (const k of Object.keys(previews)) delete previews[k];
  for (const k of Object.keys(commits)) delete commits[k];
  cleanups.push(
    registerObjectSelectionProvider(chartSelection()),
    registerObjectSelectionProvider(slicerSelection()),
    registerObjectGeometryProvider(geometry("chart", false)),
    registerObjectGeometryProvider(geometry("slicer", true)),
    registerLayoutSurfaceProvider(canvasLayoutSurfaceProvider),
  );
  setGridRegions([c1, c2, s1, s2]);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

const moved = (changes: ObjectGeometryChange[] | undefined) => (changes ?? []).map((c) => [c.region.id, c.x, c.y]);

describe("a group drag led by a SLICER (a family that co-moves its own selection)", () => {
  it("moves the charts -- the held one AND the set-held one -- by the lead's delta; the other slicer is Slicer's", async () => {
    await onCanvas();
    setObjectSelectionSet([c1, c2, s1, s2], s1);

    handleGroupDragPress(ev("floatingObject:selected", { regionId: "s1" }));
    handleGroupDragPreview(ev("floatingObject:movePreview", { regionId: "s1", x: 120, y: 310 }));
    expect(moved(previews.chart?.at(-1))).toEqual([
      ["c1", 120, 110],
      ["c2", 320, 110],
    ]);
    expect(previews.slicer).toBeUndefined();

    // The lead family persists its own move FIRST (it is an earlier listener),
    // joining the transaction the first preview opened.
    const familyWrite = runInUndoTransaction("Move Slicers", async () => {
      await tick();
      log.push("slicer family write");
    });
    await handleGroupDragComplete(ev("floatingObject:moveComplete", { regionId: "s1", x: 140, y: 320 }));
    await familyWrite;

    expect(moved(commits.chart?.[0])).toEqual([
      ["c1", 140, 120],
      ["c2", 340, 120],
    ]);
    expect(commits.slicer).toBeUndefined();
    // ONE undo step: one begin (at the first preview), one commit -- LAST,
    // after the family's own write and every provider's flush.
    expect(log.filter((l) => l.startsWith("begin"))).toEqual([`begin:${GROUP_DRAG_UNDO_LABEL}`]);
    expect(log.filter((l) => l === "commit")).toHaveLength(1);
    expect(log.at(-1)).toBe("commit");
    expect(log).toContain("slicer family write");
    expect(log.indexOf("flush:chart")).toBeLessThan(log.indexOf("commit"));
  });
});

describe("a group drag led by a CHART (a single-select family)", () => {
  it("moves the set-held second chart and both slicers, kept on the page", async () => {
    await onCanvas();
    setObjectSelectionSet([c1, c2, s1, s2], c1);
    handleGroupDragPress(ev("floatingObject:selected", { regionId: "c1" }));
    handleGroupDragPreview(ev("floatingObject:movePreview", { regionId: "c1", x: 500, y: 100 }));
    // delta +400: c2 would reach 700 (fits: 700 + 100 <= 1000); s2 700 too.
    await handleGroupDragComplete(ev("floatingObject:moveComplete", { regionId: "c1", x: 700, y: 100 }));
    // delta +600: c2 900 and s2 900 hit the page's right edge (1000 - 100).
    expect(moved(commits.chart?.[0])).toEqual([["c2", 900, 100]]);
    expect(moved(commits.slicer?.[0])).toEqual([
      ["s1", 700, 300],
      ["s2", 900, 300],
    ]);
    expect(log.filter((l) => l === "commit")).toHaveLength(1);
  });

  it("a LOCKED member stays put", async () => {
    await onCanvas([{ kind: "slicer", id: "s2" }]);
    setObjectSelectionSet([c1, c2, s1, s2], c1);
    handleGroupDragPress(ev("floatingObject:selected", { regionId: "c1" }));
    handleGroupDragPreview(ev("floatingObject:movePreview", { regionId: "c1", x: 110, y: 100 }));
    await handleGroupDragComplete(ev("floatingObject:moveComplete", { regionId: "c1", x: 110, y: 100 }));
    expect(moved(commits.slicer?.[0])).toEqual([["s1", 110, 300]]);
  });
});

describe("what a group drag is NOT", () => {
  it("a single selected object opens no transaction and moves nothing else", async () => {
    await onCanvas();
    setObjectSelectionSet([c1], c1);
    handleGroupDragPress(ev("floatingObject:selected", { regionId: "c1" }));
    handleGroupDragPreview(ev("floatingObject:movePreview", { regionId: "c1", x: 150, y: 100 }));
    await handleGroupDragComplete(ev("floatingObject:moveComplete", { regionId: "c1", x: 150, y: 100 }));
    expect(log).toEqual([]);
    expect(previews).toEqual({});
  });

  it("a worksheet is left alone", async () => {
    setObjectSelectionSet([c1, s1], c1);
    handleGroupDragPress(ev("floatingObject:selected", { regionId: "c1" }));
    handleGroupDragPreview(ev("floatingObject:movePreview", { regionId: "c1", x: 150, y: 100 }));
    await handleGroupDragComplete(ev("floatingObject:moveComplete", { regionId: "c1", x: 150, y: 100 }));
    expect(log).toEqual([]);
  });
});

describe("wiring", () => {
  it("installCanvasGroupDrag follows Core's floating-object events on window", async () => {
    await onCanvas();
    cleanups.push(...installCanvasGroupDrag());
    setObjectSelectionSet([c1, s1], c1);
    window.dispatchEvent(ev("floatingObject:selected", { regionId: "c1" }));
    window.dispatchEvent(ev("floatingObject:movePreview", { regionId: "c1", x: 130, y: 100 }));
    window.dispatchEvent(ev("floatingObject:moveComplete", { regionId: "c1", x: 130, y: 100 }));
    await vi.waitFor(() => expect(log.at(-1)).toBe("commit"));
    expect(moved(commits.slicer?.[0])).toEqual([["s1", 130, 300]]);
  });
});
