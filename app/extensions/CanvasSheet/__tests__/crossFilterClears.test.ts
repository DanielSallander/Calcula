//! FILENAME: app/extensions/CanvasSheet/__tests__/crossFilterClears.test.ts
// PURPOSE: The two gestures that CLEAR a page's cross-filter selections (P4
//          S10), as clicking the empty canvas and pressing Escape do in Power
//          BI: a plain click on the empty page (no drag past the threshold, no
//          Shift/Ctrl, not in Edit interactions), and Escape with nothing
//          selected and no inner selection. Escape keeps today's behaviour with
//          an object selected (it deselects; the selections stay), ends Edit
//          interactions while that is on, and does not even APPLY when there is
//          nothing to clear (so it never swallows the key).
// CONTEXT: The selections are the real @api/reportFilters store; the canvas
//          store and the Edit interactions flag are doubled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  editing: false,
  exit: vi.fn(),
  selectedId: null as string | null,
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas", zoom: 1 }),
}));
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  currentFloatingHitGeometry: () => ({ rowHeaderWidth: 0, colHeaderHeight: 0, scrollX: 0, scrollY: 0 }),
  requestOverlayRedraw: vi.fn(),
}));
vi.mock("@api/keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/keybindings")>()),
  isGridFocused: () => true,
}));
vi.mock("../lib/canvasSheetStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/canvasSheetStore")>()),
  getCanvasSheetSnapshot: () => ({
    activeIndex: 1,
    active: { index: 1, sheetId: "cv-1", name: "Dashboard", layout: {} },
    activeSubscribed: false,
    version: 1,
  }),
}));
vi.mock("../lib/editInteractions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/editInteractions")>()),
  isEditInteractionsActive: () => h.editing,
  exitEditInteractions: () => h.exit(),
}));

import { clearCrossFilters, getCrossFilters, setCrossFilter } from "@api/reportFilters";
import {
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
} from "@api/objectSelection";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { BACKGROUND_POINTER_DOWN_EVENT, endMarquee, handleBackgroundPointerDown } from "../lib/marquee";
import { escapeApplies, runCanvasEscape } from "../lib/objectCycling";

const chart: GridRegion = {
  id: "c1",
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 0, y: 0, width: 100, height: 60 },
};

function select(page: string, id: string): void {
  setCrossFilter({
    source: { kind: "chart", id },
    sourceName: id,
    pageSheetId: page,
    connectionId: "c1",
    fields: ["Sales.Region"],
    tuples: [["North"]],
  });
}

function press(detail: Record<string, unknown>): void {
  handleBackgroundPointerDown(new CustomEvent(BACKGROUND_POINTER_DOWN_EVENT, { detail }));
}

function release(clientX: number, clientY: number): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX, clientY }));
}

let area: HTMLDivElement;
let offProvider: () => void = () => {};

beforeEach(() => {
  h.editing = false;
  h.exit.mockClear();
  h.selectedId = null;
  clearCrossFilters();
  resetObjectSelectionProviders();
  offProvider = registerObjectSelectionProvider({
    types: ["chart"],
    isSelected: (r) => r.id === h.selectedId,
    select: (r) => {
      h.selectedId = r.id;
      notifyObjectSelectionChanged();
    },
    deselectAll: () => {
      h.selectedId = null;
      notifyObjectSelectionChanged();
    },
  });
  setGridRegions([chart]);
  area = document.createElement("div");
  area.setAttribute("data-grid-area", "");
  document.body.appendChild(area);
  select("cv-1", "bar");
  select("cv-2", "other");
});

afterEach(() => {
  endMarquee(false);
  offProvider();
  setGridRegions([]);
  clearCrossFilters();
  area.remove();
});

describe("a click on the empty page", () => {
  it("clears the page's cross-filter selections on release (and only that page's)", () => {
    press({ x: 500, y: 400, button: 0 });
    expect(getCrossFilters("cv-1")).toHaveLength(1);
    release(500, 400);
    expect(getCrossFilters("cv-1")).toHaveLength(0);
    expect(getCrossFilters("cv-2")).toHaveLength(1);
  });

  it("a drag past the threshold draws a band and clears nothing", () => {
    press({ x: 500, y: 400, button: 0 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 540, clientY: 440, buttons: 1 }));
    release(540, 440);
    expect(getCrossFilters("cv-1")).toHaveLength(1);
  });

  it("a Shift or Ctrl click keeps them", () => {
    press({ x: 500, y: 400, button: 0, shiftKey: true });
    release(500, 400);
    press({ x: 500, y: 400, button: 0, ctrlKey: true });
    release(500, 400);
    expect(getCrossFilters("cv-1")).toHaveLength(1);
  });

  it("keeps them while Edit interactions is on", () => {
    h.editing = true;
    press({ x: 500, y: 400, button: 0 });
    release(500, 400);
    expect(getCrossFilters("cv-1")).toHaveLength(1);
  });

  it("a secondary press keeps them", () => {
    press({ x: 500, y: 400, button: 2 });
    release(500, 400);
    expect(getCrossFilters("cv-1")).toHaveLength(1);
  });
});

describe("Escape", () => {
  it("with nothing selected, clears the page's selections", () => {
    expect(escapeApplies()).toBe(true);
    runCanvasEscape();
    expect(getCrossFilters("cv-1")).toHaveLength(0);
    expect(getCrossFilters("cv-2")).toHaveLength(1);
  });

  it("with nothing selected and nothing to clear, does not apply (the key is not swallowed)", () => {
    clearCrossFilters("cv-1");
    expect(escapeApplies()).toBe(false);
  });

  it("with an object selected, deselects as before and keeps the selections", () => {
    h.selectedId = "c1";
    expect(escapeApplies()).toBe(true);
    runCanvasEscape();
    expect(h.selectedId).toBeNull();
    expect(getCrossFilters("cv-1")).toHaveLength(1);
  });

  it("while Edit interactions is on, ends the mode and nothing else", () => {
    h.editing = true;
    h.selectedId = "c1";
    expect(escapeApplies()).toBe(true);
    runCanvasEscape();
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.selectedId).toBe("c1");
    expect(getCrossFilters("cv-1")).toHaveLength(1);
  });
});
