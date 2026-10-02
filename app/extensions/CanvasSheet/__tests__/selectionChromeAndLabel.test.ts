//! FILENAME: app/extensions/CanvasSheet/__tests__/selectionChromeAndLabel.test.ts
// PURPOSE: The two things the canvas derives from the selection:
//          (1) the LOCK MARK of a selected locked object -- and NO selection
//              frame of its own: Core paints the outline and handles of every
//              selected floating object, family-held or held by the set
//              (core/lib/gridRenderer/rendering/floatingObjectChrome.ts,
//              BUG-0258 design phase 3), so a set-held member is no longer
//              framed by the canvas (it used to be, in a copy of the chart's
//              frame);
//          (2) the Name Box label: the object's name for one, "N objects" for
//              several, nothing for none -- and nothing at all on a worksheet.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state: { surface: "grid" | "canvas"; zoom: number } = { surface: "canvas", zoom: 1 };
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => state,
}));

// The canvas layout's locks, as the lock mark reads them (lib/canvasLocks.ts).
const lockedIds = new Set<string>();
vi.mock("../lib/canvasLocks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLockedOnActiveCanvas: (r: { id: string }) => lockedIds.has(r.id),
}));

import { paintSelectionChrome, SELECTION_CHROME_COLOUR } from "../lib/selectionChrome";
import { FLOATING_SELECTION_COLOUR } from "@api/gridOverlays";
import {
  canvasSelectionLabel,
  CANVAS_OBJECT_LABEL_SOURCE,
  installCanvasObjectLabel,
  objectCountLabel,
} from "../lib/objectLabel";
import {
  addToObjectSelection,
  clearObjectSelection,
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { getObjectLabel, resetObjectLabelRegistry } from "@api/objectSelectionLabel";
import { registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";
import type { GridLayerContext } from "@api";

function region(id: string, type: string, x: number, name?: string): GridRegion {
  return {
    id,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x, y: 10, width: 100, height: 50 },
    data: name ? { name } : {},
  };
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
    labelOf: (r) => (typeof r.data?.name === "string" ? (r.data.name as string) : null),
  };
  return provider;
}

const c1 = region("c1", "chart", 0, "Sales");
const c2 = region("c2", "chart", 200, "Costs");
const cleanups: Array<() => void> = [];

beforeEach(() => {
  state.surface = "canvas";
  resetObjectSelectionProviders();
  resetObjectLabelRegistry();
  cleanups.push(
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerObjectSelectionProvider(singleFamily("chart")),
  );
  setGridRegions([c1, c2]);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  resetObjectLabelRegistry();
  setGridRegions([]);
});

/** A recording 2D context: every strokeRect / fillRect / path stroke, with its colour. */
function recordingContext() {
  const calls: Array<{ op: string; args: number[]; style: string }> = [];
  const ctx = {
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    setLineDash: () => {},
    beginPath: () => {},
    arc: () => {},
    stroke() {
      calls.push({ op: "stroke", args: [], style: String(this.strokeStyle) });
    },
    strokeRect(...args: number[]) {
      calls.push({ op: "strokeRect", args, style: String(this.strokeStyle) });
    },
    fillRect(...args: number[]) {
      calls.push({ op: "fillRect", args, style: String(this.fillStyle) });
    },
  };
  const context = {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
    viewport: { scrollX: 50, scrollY: 0 },
    dimensions: {},
    canvasWidth: 1000,
    canvasHeight: 800,
    freezeConfig: null,
  } as unknown as GridLayerContext;
  return { context, calls };
}

describe("the canvas's selection layer: the lock mark, and no frame of its own", () => {
  it("a SET-held member is no longer framed by the canvas (Core paints every selected object's chrome)", () => {
    addToObjectSelection(c1); // the chart family holds c1
    addToObjectSelection(c2); // ...so the set holds c2
    const { context, calls } = recordingContext();
    paintSelectionChrome(context);
    expect(calls, "the canvas painted a frame or handles for a set-held member").toEqual([]);
  });

  it("a selected LOCKED object still gets its padlock, in Core's one selection colour", () => {
    addToObjectSelection(c1);
    addToObjectSelection(c2);
    lockedIds.add("c2");
    cleanups.push(() => lockedIds.clear());
    const { context, calls } = recordingContext();
    paintSelectionChrome(context);
    // The plate (white) and the padlock body (the chrome colour), for c2 only;
    // nothing framed.
    expect(calls.filter((c) => c.op === "strokeRect")).toEqual([]);
    const fills = calls.filter((c) => c.op === "fillRect");
    expect(fills.map((c) => c.style)).toEqual(["#ffffff", SELECTION_CHROME_COLOUR]);
    // c2's page x 200, scrolled by 50: the mark sits inside its top-right corner.
    expect(fills[1].args[0]).toBeGreaterThan(150);
    expect(fills[1].args[0]).toBeLessThan(250);
    expect(SELECTION_CHROME_COLOUR).toBe(FLOATING_SELECTION_COLOUR);
  });

  it("paints nothing on a worksheet", () => {
    addToObjectSelection(c1);
    addToObjectSelection(c2);
    state.surface = "grid";
    const sheet = recordingContext();
    paintSelectionChrome(sheet.context);
    expect(sheet.calls).toEqual([]);
  });
});

describe("the Name Box label", () => {
  it("is the object's name for one, 'N objects' for several, null for none (pure)", () => {
    expect(canvasSelectionLabel([])).toBeNull();
    expect(canvasSelectionLabel([c1])).toEqual({ text: "Sales", count: 1 });
    expect(canvasSelectionLabel([c1, c2])).toEqual({ text: "2 objects", count: 2 });
    expect(canvasSelectionLabel([region("x", "chart", 0)])).toBeNull();
    expect(objectCountLabel(1)).toBe("1 object");
  });

  it("follows the selection set live, and withdraws on a clear", () => {
    cleanups.push(...installCanvasObjectLabel());
    expect(getObjectLabel().text).toBe("");
    addToObjectSelection(c1);
    expect(getObjectLabel()).toMatchObject({ source: CANVAS_OBJECT_LABEL_SOURCE, text: "Sales", count: 1 });
    addToObjectSelection(c2);
    expect(getObjectLabel()).toMatchObject({ text: "2 objects", count: 2 });
    clearObjectSelection();
    expect(getObjectLabel().text).toBe("");
  });

  it("publishes nothing on a worksheet", () => {
    state.surface = "grid";
    cleanups.push(...installCanvasObjectLabel());
    addToObjectSelection(c1);
    expect(getObjectLabel().text).toBe("");
  });

  it("follows a RENAME (a region re-published with its new name)", () => {
    cleanups.push(...installCanvasObjectLabel());
    addToObjectSelection(c1);
    setGridRegions([{ ...c1, data: { name: "Revenue" } }, c2]);
    expect(getObjectLabel().text).toBe("Revenue");
  });
});
