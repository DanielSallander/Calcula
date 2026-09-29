//! FILENAME: app/extensions/CanvasSheet/__tests__/marquee.test.ts
// PURPOSE: The canvas MARQUEE: a plain press on the empty page deselects; a
//          drag from there selects every object the band TOUCHES, across
//          families; a click inside the 3px dead zone is a deselect and nothing
//          more; Shift/Ctrl adds; a secondary press and a worksheet are left
//          alone; Escape clears the whole resulting set; the session listeners
//          are in the global input census.
// CONTEXT: The families are doubles registered through the REAL
//          object-selection seam (one single-select "chart" family, one
//          multi-select "slicer" family), so the set behaviour under test is
//          the real one. The pointer travels through real window mouse events
//          against a real `[data-grid-area]` element (jsdom rect at 0,0).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state: { surface: "grid" | "canvas"; zoom: number } = { surface: "canvas", zoom: 1 };
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => state,
}));
const geo = { rowHeaderWidth: 0, colHeaderHeight: 0, scrollX: 0, scrollY: 0 };
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  currentFloatingHitGeometry: () => geo,
  requestOverlayRedraw: vi.fn(),
}));
vi.mock("@api/keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/keybindings")>()),
  isGridFocused: () => true,
}));

import {
  BACKGROUND_POINTER_DOWN_EVENT,
  bandRect,
  currentMarqueeBand,
  endMarquee,
  handleBackgroundPointerDown,
  pastThreshold,
  regionsTouchingBand,
} from "../lib/marquee";
import { escapeApplies, installCanvasObjectKeyboard, CANVAS_DESELECT_OBJECT_COMMAND } from "../lib/objectCycling";
import {
  getSelectedObjectRegions,
  getSetHeldObjectRegions,
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";
import { CommandRegistry } from "@api/commands";
import fs from "node:fs";
import path from "node:path";

function region(id: string, type: string, x: number, y: number, width = 100, height = 60): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y, width, height } };
}

function singleFamily(type: string) {
  let selected: string | null = null;
  const provider: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => r.id === selected,
    select: (r) => {
      selected = r.id;
      notifyObjectSelectionChanged();
    },
    deselectAll: () => {
      if (selected === null) return;
      selected = null;
      notifyObjectSelectionChanged();
    },
  };
  return { provider, get selected() { return selected; } };
}

function multiFamily(type: string) {
  const selected = new Set<string>();
  const provider: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => selected.has(r.id),
    select: (r) => {
      selected.clear();
      selected.add(r.id);
      notifyObjectSelectionChanged();
    },
    deselectAll: () => {
      selected.clear();
      notifyObjectSelectionChanged();
    },
    addToSelection: (r) => {
      selected.add(r.id);
      notifyObjectSelectionChanged();
    },
    removeFromSelection: (r) => {
      selected.delete(r.id);
      notifyObjectSelectionChanged();
    },
  };
  return { provider, selected };
}

// Page layout (sheet px):  c1 (0,0)  c2 (300,0)  s1 (0,200)  far (900,600)
const c1 = region("c1", "chart", 0, 0);
const c2 = region("c2", "chart", 300, 0);
const s1 = region("s1", "slicer", 0, 200);
const far = region("far", "chart", 900, 600);

let charts: ReturnType<typeof singleFamily>;
let slicers: ReturnType<typeof multiFamily>;
let area: HTMLDivElement;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  state.surface = "canvas";
  state.zoom = 1;
  geo.scrollX = 0;
  geo.scrollY = 0;
  resetObjectSelectionProviders();
  charts = singleFamily("chart");
  slicers = multiFamily("slicer");
  cleanups.push(
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "slicer", render: () => {}, priority: 16 }),
    registerObjectSelectionProvider(charts.provider),
    registerObjectSelectionProvider(slicers.provider),
  );
  setGridRegions([c1, c2, s1, far]);
  area = document.createElement("div");
  area.setAttribute("data-grid-area", "");
  document.body.appendChild(area);
});

afterEach(() => {
  endMarquee(false);
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  setGridRegions([]);
  area.remove();
});

const ids = (rs: readonly GridRegion[]) => rs.map((r) => r.id);

function pressAt(x: number, y: number, mods: { button?: number; shiftKey?: boolean; ctrlKey?: boolean } = {}): void {
  handleBackgroundPointerDown(
    new CustomEvent(BACKGROUND_POINTER_DOWN_EVENT, { detail: { x, y, button: 0, ...mods } }),
  );
}
/** A move DURING a drag: the primary button is held (`buttons: 1`). */
function moveTo(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons: 1 }));
}
/** A move with NO button held (the pointer merely passing over). */
function hoverTo(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons: 0 }));
}
function releaseAt(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y }));
}
function drag(from: [number, number], to: [number, number], mods = {}): void {
  pressAt(from[0], from[1], mods);
  moveTo((from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  moveTo(to[0], to[1]);
  releaseAt(to[0], to[1]);
}

describe("the geometry (pure)", () => {
  it("bandRect spans the two corners whichever way it was dragged", () => {
    expect(bandRect({ x: 50, y: 40 }, { x: 10, y: 90 })).toEqual({ x: 10, y: 40, width: 40, height: 50 });
  });

  it("an object is hit when it INTERSECTS the band -- a touch counts, containment is not required", () => {
    const band = { x: 90, y: 50, width: 20, height: 20 };
    // c1 is (0,0)-(100,60): the band clips its corner.
    expect(ids(regionsTouchingBand([c1, c2, s1], band))).toEqual(["c1"]);
    // Sharing only an edge still counts.
    expect(ids(regionsTouchingBand([c1], { x: 100, y: 60, width: 5, height: 5 }))).toEqual(["c1"]);
    // Cell-anchored regions never do.
    const cell: GridRegion = { id: "t", type: "table", startRow: 0, startCol: 0, endRow: 5, endCol: 5 };
    expect(regionsTouchingBand([cell], { x: 0, y: 0, width: 999, height: 999 })).toEqual([]);
  });

  it("the threshold is Core's: more than 3px in either axis", () => {
    expect(pastThreshold({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 0, y: -4 })).toBe(true);
  });
});

describe("the gesture", () => {
  it("a band across two families selects every object it touches, and nothing outside it", () => {
    drag([350, 250], [50, 30]);
    // c1 (corner), c2 (touched), s1 (touched); `far` is outside.
    expect(ids(getSelectedObjectRegions())).toEqual(["c1", "c2", "s1"]);
    // Two charts, one chart family: the second is held by the set (the canvas
    // paints its frame).
    expect(getSetHeldObjectRegions()).toHaveLength(1);
    expect(slicers.selected.has("s1")).toBe(true);
  });

  it("a plain click on the page (inside the 3px dead zone) deselects and selects nothing", () => {
    charts.provider.select(c1);
    // 2px right of c1's edge: a band drawn from this jitter WOULD touch c1.
    pressAt(102, 30);
    moveTo(100, 31);
    releaseAt(99, 31);
    expect(getSelectedObjectRegions()).toEqual([]);
    expect(currentMarqueeBand()).toBeNull();
  });

  it("the band shows only once the pointer passed the threshold", () => {
    pressAt(250, 250);
    moveTo(252, 251);
    expect(currentMarqueeBand()).toBeNull();
    moveTo(260, 270);
    expect(currentMarqueeBand()).toEqual({ x: 250, y: 250, width: 10, height: 20 });
  });

  it("a plain band REPLACES the selection", () => {
    charts.provider.select(far);
    drag([-10, 190], [20, 210]);
    expect(ids(getSelectedObjectRegions())).toEqual(["s1"]);
  });

  it("Shift ADDS what the band touches to the selection", () => {
    charts.provider.select(far);
    drag([-10, 190], [20, 210], { shiftKey: true });
    expect(ids(getSelectedObjectRegions())).toEqual(["far", "s1"]);
  });

  it("Ctrl adds as well; a Shift/Ctrl CLICK leaves the selection alone", () => {
    charts.provider.select(far);
    pressAt(700, 500, { ctrlKey: true });
    releaseAt(700, 500);
    expect(ids(getSelectedObjectRegions())).toEqual(["far"]);
    drag([290, -5], [310, 10], { ctrlKey: true });
    expect(ids(getSelectedObjectRegions())).toEqual(["c2", "far"]);
  });

  it("the band is in PAGE coordinates: the scroll is added", () => {
    geo.scrollX = 300;
    // Canvas x 0..20 is page x 300..320: c2, not c1.
    drag([0, -5], [20, 10]);
    expect(ids(getSelectedObjectRegions())).toEqual(["c2"]);
  });

  it("a secondary press leaves the selection alone and starts no band", () => {
    charts.provider.select(c1);
    pressAt(250, 250, { button: 2 });
    moveTo(400, 400);
    releaseAt(400, 400);
    expect(ids(getSelectedObjectRegions())).toEqual(["c1"]);
  });

  it("does nothing on a worksheet", () => {
    state.surface = "grid";
    charts.provider.select(c1);
    drag([250, 250], [-10, -10]);
    expect(ids(getSelectedObjectRegions())).toEqual(["c1"]);
  });

  it("Escape clears the WHOLE set, set-held members included", async () => {
    const offs = installCanvasObjectKeyboard("test");
    cleanups.push(...offs);
    drag([350, 250], [50, 30]);
    expect(getSelectedObjectRegions()).toHaveLength(3);
    expect(escapeApplies()).toBe(true);
    await CommandRegistry.execute(CANVAS_DESELECT_OBJECT_COMMAND);
    expect(getSelectedObjectRegions()).toEqual([]);
    expect(getSetHeldObjectRegions()).toEqual([]);
    expect(escapeApplies()).toBe(false);
  });

  // Found live 2026-09-29 (e2e fixall-canvas LIVE-2): after an instant
  // press-and-release on the empty page the band FOLLOWED the bare pointer,
  // and the next click (on an object) "released" it, selecting everything
  // between. A band exists only while the primary button is held.
  it("a move with NO button held ends the band: no band follows the pointer, and the next release selects nothing", () => {
    charts.provider.select(c1);
    pressAt(400, 20);
    expect(getSelectedObjectRegions(), "the press deselected, as a click does").toEqual([]);
    hoverTo(60, 60);
    expect(currentMarqueeBand(), "a band follows the pointer with no button held").toBeNull();
    releaseAt(60, 60);
    expect(getSelectedObjectRegions(), "a release after the hover applied a band").toEqual([]);
  });

  it("its session listeners are in the global input census", () => {
    // Read as TEXT: an extension may not import Core (the Facade Rule), and
    // the census's own drift test is what fails the build on a missing row;
    // this pins that the marquee's two rows say "session-scoped".
    const census = fs.readFileSync(path.resolve(__dirname, "../../../src/core/lib/globalInputListeners.ts"), "utf8");
    const rows = [
      ...census.matchAll(/file: "extensions\/CanvasSheet\/lib\/marquee\.ts", event: "(\w+)", verdict: "([\w-]+)"/g),
    ];
    expect(rows.map((m) => `${m[1]}:${m[2]}`).sort()).toEqual(["mousemove:session-scoped", "mouseup:session-scoped"]);
  });
});
