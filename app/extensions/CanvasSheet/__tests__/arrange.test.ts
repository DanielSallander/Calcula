//! FILENAME: app/extensions/CanvasSheet/__tests__/arrange.test.ts
// PURPOSE: ALIGN and DISTRIBUTE on a canvas (M8 part C): the pure geometry --
//          every edge and centre line, align-to-PAGE for a single object, equal
//          gaps, the page clamp, locked and unmovable objects staying put --
//          and the command: the selection's moves go through the
//          object-geometry seam as ONE commit under the command's own label.

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

const undoLog: string[] = [];
vi.mock("../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/lib/tauri-api")>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    undoLog.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    undoLog.push("commit");
  }),
}));

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import {
  registerObjectGeometryProvider,
  resetObjectGeometryProviders,
  type ObjectGeometryChange,
} from "@api/objectGeometry";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { refreshCanvasSheets, resetCanvasSheetStore } from "../lib/canvasSheetStore";
import {
  alignItems,
  alignSelectedObjects,
  distributeItems,
  distributeSelectedObjects,
  type ArrangeItem,
} from "../lib/arrange";

// ============================================================================
// Pure geometry
// ============================================================================

function item(id: string, x: number, y: number, width: number, height: number, movable = true): ArrangeItem {
  return { id, rect: { x, y, width, height }, movable };
}

const PAGE = { width: 1000, height: 600 };
/** Three objects; bounds x 100..500, y 50..350. */
const THREE = [item("a", 100, 50, 100, 100), item("b", 250, 200, 50, 150), item("c", 400, 100, 100, 40)];

const xy = (m: Map<string, { x: number; y: number }>) =>
  Object.fromEntries(Array.from(m, ([k, r]) => [k, [r.x, r.y]]));

describe("alignItems: to the SELECTION's bounds", () => {
  it("left / center / right line the x up on the bounds' edge or centre line", () => {
    expect(xy(alignItems(THREE, "left", PAGE))).toEqual({ b: [100, 200], c: [100, 100] });
    // centre line of 100..500 is 300.
    expect(xy(alignItems(THREE, "center", PAGE))).toEqual({ a: [250, 50], b: [275, 200], c: [250, 100] });
    expect(xy(alignItems(THREE, "right", PAGE))).toEqual({ a: [400, 50], b: [450, 200] });
  });

  it("top / middle / bottom line the y up (bounds y 50..350, middle 200)", () => {
    expect(xy(alignItems(THREE, "top", PAGE))).toEqual({ b: [250, 50], c: [400, 50] });
    expect(xy(alignItems(THREE, "middle", PAGE))).toEqual({ a: [100, 150], b: [250, 125], c: [400, 180] });
    expect(xy(alignItems(THREE, "bottom", PAGE))).toEqual({ a: [100, 250], c: [400, 310] });
  });

  it("ONE object aligns to the PAGE", () => {
    const one = [item("a", 100, 50, 100, 100)];
    expect(xy(alignItems(one, "right", PAGE))).toEqual({ a: [900, 50] });
    expect(xy(alignItems(one, "center", PAGE))).toEqual({ a: [450, 50] });
    expect(xy(alignItems(one, "bottom", PAGE))).toEqual({ a: [100, 500] });
    // No page (a worksheet): one object has nothing to align to.
    expect(alignItems(one, "right", null).size).toBe(0);
  });

  it("a LOCKED / unmovable object stays put but still counts for the bounds", () => {
    const withLocked = [item("anchor", 40, 0, 10, 10, false), item("b", 250, 200, 50, 150)];
    // The locked anchor defines the left edge; only b moves.
    expect(xy(alignItems(withLocked, "left", PAGE))).toEqual({ b: [40, 200] });
  });

  it("results are whole px and kept on the page", () => {
    const odd = [item("a", 0, 0, 101, 10), item("b", 0, 20, 50, 10)];
    // centre of 0..101 is 50.5: a 50-wide b goes to 25.5 -> 26 (whole px).
    expect(xy(alignItems(odd, "center", PAGE))).toEqual({ b: [26, 20] });
    // An object already hanging off the page (the page was made smaller) is
    // brought back on it by any arrange that moves it: page right edge 1000,
    // so a 100-wide object's x is clamped to 900.
    const off = [item("a", 950, 0, 100, 10), item("b", 0, 50, 50, 10)];
    expect(xy(alignItems(off, "top", PAGE))).toEqual({ a: [900, 0], b: [0, 0] });
  });
});

describe("distributeItems: EQUAL gaps, 3+ objects", () => {
  it("horizontal: the outermost stay, the middle one leaves equal gaps", () => {
    // a 100..200, c 400..500; b is 50 wide: span 400, sizes 250, gaps 75 -> b at 275.
    const plan = distributeItems(THREE, "horizontal", PAGE);
    expect(xy(plan)).toEqual({ b: [275, 200] });
    const b = plan.get("b")!;
    expect(b.x - 200).toBe(400 - (b.x + 50));
  });

  it("vertical: ordered by centre, equal gaps between neighbours", () => {
    // By centre y: a (100), c (120), b (275). Span 50..350 = 300, sizes 100+40+150=290,
    // gap 5: a 50..150, c at 155, b 200 (the last, stays).
    expect(xy(distributeItems(THREE, "vertical", PAGE))).toEqual({ c: [400, 155] });
  });

  it("fewer than three objects: nothing moves", () => {
    expect(distributeItems(THREE.slice(0, 2), "horizontal", PAGE).size).toBe(0);
  });

  it("a locked object between keeps its place (it still holds its slot)", () => {
    const four = [
      item("a", 0, 0, 100, 10),
      item("locked", 100, 0, 100, 10, false),
      item("b", 300, 0, 100, 10),
      item("z", 900, 0, 100, 10),
    ];
    // gap (1000 - 400) / 3 = 200: slots 0, 300, 600, 900 -- locked stays at 100.
    expect(xy(distributeItems(four, "horizontal", PAGE))).toEqual({ b: [600, 0] });
  });
});

// ============================================================================
// The command, through the seam
// ============================================================================

const CANVAS = 1;

function layout(locked?: CanvasObjectRef[]): CanvasLayout {
  return { ...defaultCanvasLayout(), pageWidth: 1000, pageHeight: 600, ...(locked ? { locked } : {}) };
}

async function onCanvas(locked?: CanvasObjectRef[]): Promise<void> {
  getSheets.mockResolvedValueOnce({
    activeIndex: CANVAS,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      { index: CANVAS, name: "Page", visibility: "visible", sheetId: "cv-1", kind: "canvas", canvasLayout: layout(locked) },
    ],
  });
  await refreshCanvasSheets();
  gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: CANVAS } };
}

function region(id: string, type: string, x: number, y: number, data: Record<string, unknown> = {}): GridRegion {
  return {
    id,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x, y, width: 100, height: 50 },
    data: { id, ...data },
  };
}

function family(type: string, kind: string): ObjectSelectionProvider {
  return {
    types: [type],
    isSelected: () => false,
    select: () => {},
    deselectAll: () => {},
    refOf: (r) => ({ kind, id: String(r.data?.id) }),
  };
}

const commits: Record<string, ObjectGeometryChange[][]> = {};
const cleanups: Array<() => void> = [];

beforeEach(() => {
  resetCanvasSheetStore();
  resetObjectSelectionProviders();
  resetObjectGeometryProviders();
  getSheets.mockReset();
  gridSnapshot = null;
  undoLog.length = 0;
  for (const k of Object.keys(commits)) delete commits[k];
  for (const [type, kind] of [
    ["chart", "chart"],
    ["slicer", "slicer"],
  ] as const) {
    cleanups.push(registerObjectSelectionProvider(family(type, kind)));
    cleanups.push(
      registerObjectGeometryProvider({
        types: [type],
        commit: async (changes) => {
          (commits[type] ??= []).push([...changes]);
        },
      }),
    );
  }
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("alignSelectedObjects / distributeSelectedObjects", () => {
  it("commits the moves of every family as ONE undo step labelled by the command", async () => {
    await onCanvas();
    const regions = [region("c1", "chart", 100, 50), region("s1", "slicer", 300, 80), region("c2", "chart", 200, 200)];
    const moved = await alignSelectedObjects("top", regions);
    expect(moved).toBe(2);
    expect(undoLog).toEqual(["begin:Align Top", "commit"]);
    expect(commits.chart?.[0].map((c) => [c.region.id, c.x, c.y])).toEqual([["c2", 200, 50]]);
    expect(commits.slicer?.[0].map((c) => [c.region.id, c.x, c.y])).toEqual([["s1", 300, 50]]);
    // `from` is where each object was: a provider can put it back exactly.
    expect(commits.slicer?.[0][0].from).toEqual({ x: 300, y: 80, width: 100, height: 50 });
  });

  it("a LOCKED object and a movable:false one stay put", async () => {
    await onCanvas([{ kind: "chart", id: "c1" }]);
    const regions = [
      region("c1", "chart", 500, 50),
      region("s1", "slicer", 300, 80, { movable: false }),
      region("c2", "chart", 400, 200),
    ];
    await alignSelectedObjects("left", regions);
    // Only c2 moves -- to the bounds' left edge, which the unmovable s1 sets
    // (the locked c1 at 500 stays where it is).
    expect(commits.chart?.[0].map((c) => [c.region.id, c.x])).toEqual([["c2", 300]]);
    expect(commits.slicer).toBeUndefined();
  });

  it("nothing moves on a SUBSCRIBED canvas, nor on a worksheet", async () => {
    const regions = [region("c1", "chart", 100, 50), region("c2", "chart", 200, 200)];
    expect(await alignSelectedObjects("left", regions)).toBe(0);
    expect(await distributeSelectedObjects("horizontal", [...regions, region("c3", "chart", 900, 0)])).toBe(0);
    expect(undoLog).toEqual([]);
  });
});
