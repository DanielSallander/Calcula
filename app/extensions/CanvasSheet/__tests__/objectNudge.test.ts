//! FILENAME: app/extensions/CanvasSheet/__tests__/objectNudge.test.ts
// PURPOSE: The canvas arrow-key NUDGE (M8 part D): the step rules (snap to the
//          NEXT grid multiple, 1 px, Shift 10 px, Alt bypasses the snap), the
//          group's page clamp, the guard (a worksheet, an unfocused grid, a
//          subscribed canvas, an empty selection, or an inner selection that
//          owns the arrows -- a floating range's cell, a chart's series -- all
//          leave the arrows alone), and the BURST: every keystroke previews,
//          and the burst commits ONCE, as one undo step, at the key's release
//          (or after the idle timeout when the release never arrives).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CanvasLayout, CanvasObjectRef, SheetsResult } from "@api";

const getSheets = vi.fn<() => Promise<SheetsResult>>();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
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

let gridFocused = true;
vi.mock("@api/keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/keybindings")>()),
  isGridFocused: () => gridFocused,
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
  type ObjectSelectionKey,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import {
  registerObjectGeometryProvider,
  resetObjectGeometryProviders,
  type ObjectGeometryChange,
} from "@api/objectGeometry";
import { registerLayoutSurfaceProvider } from "@api/layoutSurface";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { refreshCanvasProvenance, refreshCanvasSheets, resetCanvasSheetStore } from "../lib/canvasSheetStore";
import { canvasLayoutSurfaceProvider } from "../lib/layoutSurfaceProvider";
import {
  NUDGE_HELD_GRACE_MS,
  NUDGE_IDLE_MS,
  NUDGE_ROWS,
  clampGroupDelta,
  commitNudgeBurst,
  hasPendingNudge,
  nudgeApplies,
  nudgeCommandId,
  nudgeDelta,
  nudgeSelection,
  resetCanvasObjectNudge,
} from "../lib/objectNudge";

// ============================================================================
// Pure step rules
// ============================================================================

const SNAP = { snapToGrid: true, gridSize: 16 };
const FREE = { snapToGrid: false, gridSize: 16 };

describe("nudgeDelta", () => {
  it("snap on: to the NEXT grid multiple in that direction (an off-grid object lands on the grid)", () => {
    expect(nudgeDelta("right", { x: 100, y: 0 }, SNAP)).toEqual({ dx: 12, dy: 0 }); // 100 -> 112
    expect(nudgeDelta("left", { x: 100, y: 0 }, SNAP)).toEqual({ dx: -4, dy: 0 }); // 100 -> 96
    expect(nudgeDelta("down", { x: 0, y: 96 }, SNAP)).toEqual({ dx: 0, dy: 16 }); // on grid: one pitch
    expect(nudgeDelta("up", { x: 0, y: 96 }, SNAP)).toEqual({ dx: 0, dy: -16 });
  });

  it("snap off: 1 px, or 10 px with Shift", () => {
    expect(nudgeDelta("right", { x: 100, y: 0 }, FREE)).toEqual({ dx: 1, dy: 0 });
    expect(nudgeDelta("up", { x: 0, y: 50 }, FREE, { shift: true })).toEqual({ dx: 0, dy: -10 });
    // No surface at all (not a canvas): the free step too.
    expect(nudgeDelta("left", { x: 3, y: 0 }, null)).toEqual({ dx: -1, dy: 0 });
  });

  it("Alt bypasses the snap: 1 px even with snap on (never rounded back to the grid)", () => {
    expect(nudgeDelta("right", { x: 96, y: 0 }, SNAP, { alt: true })).toEqual({ dx: 1, dy: 0 });
    expect(nudgeDelta("right", { x: 96, y: 0 }, SNAP, { alt: true, shift: true })).toEqual({ dx: 10, dy: 0 });
  });
});

describe("clampGroupDelta: the GROUP stays on the page, keeping its layout", () => {
  const page = { width: 500, height: 300 };
  it("stops the group at the page edge as one", () => {
    const rects = [
      { x: 380, y: 10, width: 100, height: 20 },
      { x: 300, y: 50, width: 50, height: 20 },
    ];
    // Bounds right edge 480: a +50 step can only take 20.
    expect(clampGroupDelta(rects, { dx: 50, dy: 0 }, page)).toEqual({ dx: 20, dy: 0 });
    expect(clampGroupDelta(rects, { dx: 0, dy: -30 }, page)).toEqual({ dx: 0, dy: -10 });
    expect(clampGroupDelta(rects, { dx: 5, dy: 5 }, null)).toEqual({ dx: 5, dy: 5 });
  });
});

describe("the bindings", () => {
  it("12 rows: plain / Shift / Alt for each arrow, each its own command", () => {
    expect(NUDGE_ROWS).toHaveLength(12);
    expect(new Set(NUDGE_ROWS.map(nudgeCommandId)).size).toBe(12);
    expect(NUDGE_ROWS.map((r) => `${r.prefix}${r.key}`)).toContain("Shift+ArrowLeft");
    expect(NUDGE_ROWS.map((r) => `${r.prefix}${r.key}`)).toContain("Alt+ArrowDown");
  });
});

// ============================================================================
// Guard and burst, against the store and the seams
// ============================================================================

const CANVAS = 1;

async function onCanvas(over: Partial<CanvasLayout> = {}): Promise<void> {
  getSheets.mockResolvedValueOnce({
    activeIndex: CANVAS,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      {
        index: CANVAS,
        name: "Page",
        visibility: "visible",
        sheetId: "cv-1",
        kind: "canvas",
        canvasLayout: { ...defaultCanvasLayout(), pageWidth: 1000, pageHeight: 600, snapToGrid: false, ...over },
      },
    ],
  });
  await refreshCanvasSheets();
  gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: CANVAS } };
}

function region(id: string, type: string, x: number, y: number): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y, width: 100, height: 50 }, data: { key: id } };
}

let ownsArrow = false;
function family(type: string): ObjectSelectionProvider {
  const held = new Set<string>();
  return {
    types: [type],
    isSelected: (r) => held.has(r.id),
    select: (r) => {
      held.clear();
      held.add(r.id);
    },
    deselectAll: () => held.clear(),
    addToSelection: (r) => {
      held.add(r.id);
    },
    ownsKey: (key: ObjectSelectionKey) => key === "Arrow" && ownsArrow,
    refOf: (r) => ({ kind: type, id: r.id }),
  };
}

const previews: ObjectGeometryChange[][] = [];
const commits: ObjectGeometryChange[][] = [];
const cleanups: Array<() => void> = [];
const a = region("a", "shape", 100, 100);
const b = region("b", "shape", 300, 100);

beforeEach(() => {
  resetCanvasSheetStore();
  resetObjectSelectionProviders();
  resetObjectGeometryProviders();
  resetCanvasObjectNudge();
  getSheets.mockReset();
  provenance.mockReset();
  provenance.mockResolvedValue([]);
  gridSnapshot = null;
  gridFocused = true;
  ownsArrow = false;
  log.length = 0;
  previews.length = 0;
  commits.length = 0;
  cleanups.push(
    registerObjectSelectionProvider(family("shape")),
    registerObjectGeometryProvider({
      types: ["shape"],
      preview: (changes) => {
        previews.push([...changes]);
      },
      commit: async (changes) => {
        commits.push([...changes]);
      },
    }),
    registerLayoutSurfaceProvider(canvasLayoutSurfaceProvider),
  );
  setGridRegions([a, b]);
});

afterEach(() => {
  resetCanvasObjectNudge();
  vi.useRealTimers();
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("nudgeApplies: the guard", () => {
  it("applies on an editable canvas, grid focused, with a selection", async () => {
    await onCanvas();
    setObjectSelectionSet([a]);
    expect(nudgeApplies()).toBe(true);
  });

  it("never on a worksheet", () => {
    setObjectSelectionSet([a]);
    gridSnapshot = { surface: "worksheet", sheetContext: { activeSheetIndex: 0 } };
    expect(nudgeApplies()).toBe(false);
  });

  it("not with nothing selected, not with the grid unfocused", async () => {
    await onCanvas();
    expect(nudgeApplies()).toBe(false);
    setObjectSelectionSet([a]);
    gridFocused = false;
    expect(nudgeApplies()).toBe(false);
  });

  it("not while an INNER selection owns the arrows (a floating range's cell, a chart's series)", async () => {
    await onCanvas();
    setObjectSelectionSet([a]);
    ownsArrow = true;
    expect(nudgeApplies()).toBe(false);
  });

  it("not on a SUBSCRIBED canvas (the layout is the publisher's)", async () => {
    await onCanvas();
    setObjectSelectionSet([a]);
    provenance.mockResolvedValue([{ sheetId: "cv-1", role: "subscribed" }]);
    await refreshCanvasProvenance();
    expect(nudgeApplies()).toBe(false);
  });
});

describe("the burst", () => {
  it("previews every keystroke and commits ONCE, as one undo step, at the key's release", async () => {
    await onCanvas();
    setObjectSelectionSet([a, b]);
    nudgeSelection("right");
    nudgeSelection("right");
    nudgeSelection("down", { shift: true });
    expect(previews).toHaveLength(3);
    expect(previews.at(-1)!.map((c) => [c.region.id, c.x, c.y])).toEqual([
      ["a", 102, 110],
      ["b", 302, 110],
    ]);
    expect(commits).toHaveLength(0);
    expect(hasPendingNudge()).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown" }));
    await vi.waitFor(() => expect(log.at(-1)).toBe("commit"));
    expect(commits).toHaveLength(1);
    expect(commits[0].map((c) => [c.region.id, c.x, c.y])).toEqual([
      ["a", 102, 110],
      ["b", 302, 110],
    ]);
    // Each change carries where the object was when the burst began.
    expect(commits[0][0].from).toEqual({ x: 100, y: 100, width: 100, height: 50 });
    expect(log).toEqual(["begin:Nudge", "commit"]);
    expect(hasPendingNudge()).toBe(false);
  });

  it("snap on: each keystroke goes to the next grid multiple", async () => {
    await onCanvas({ snapToGrid: true, gridSizePx: 16 });
    setObjectSelectionSet([a]);
    nudgeSelection("right"); // 100 -> 112
    nudgeSelection("right"); // 112 -> 128
    nudgeSelection("left", { alt: true }); // Alt: 1 px, 127
    await commitNudgeBurst();
    expect(commits[0].map((c) => c.x)).toEqual([127]);
  });

  it("a held key whose release never arrives commits after the grace period; a held key keeps the burst open", async () => {
    vi.useFakeTimers();
    await onCanvas();
    setObjectSelectionSet([a]);
    nudgeSelection("left");
    // The key is still held: the idle timeout alone does not end the burst.
    await vi.advanceTimersByTimeAsync(NUDGE_IDLE_MS + 10);
    expect(commits).toHaveLength(0);
    // Auto-repeat keeps it alive...
    nudgeSelection("left");
    await vi.advanceTimersByTimeAsync(NUDGE_IDLE_MS + 10);
    expect(commits).toHaveLength(0);
    // ...and a release that never came is given up on.
    await vi.advanceTimersByTimeAsync(NUDGE_HELD_GRACE_MS + NUDGE_IDLE_MS);
    expect(commits).toHaveLength(1);
    expect(commits[0][0].x).toBe(98);
  });

  it("the page clamp: a burst stops at the page edge", async () => {
    await onCanvas();
    const edge = region("e", "shape", 895, 0);
    setGridRegions([edge]);
    setObjectSelectionSet([edge]);
    for (let i = 0; i < 20; i++) nudgeSelection("right", { shift: true });
    await commitNudgeBurst();
    expect(commits[0][0].x).toBe(900);
  });

  it("a LOCKED object does not move", async () => {
    await onCanvas({ locked: [{ kind: "shape", id: "a" } as CanvasObjectRef] });
    setObjectSelectionSet([a, b]);
    nudgeSelection("down");
    await commitNudgeBurst();
    expect(commits[0].map((c) => c.region.id)).toEqual(["b"]);
  });
});
