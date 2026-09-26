//! FILENAME: app/extensions/CanvasSheet/__tests__/selectionChromeAndLabel.test.ts
// PURPOSE: The two things the canvas derives from the selection SET:
//          (1) the frames of the members the set holds for a single-select
//              family (a second chart) -- painted in the families' frame style,
//              only on a canvas, only for SET-held members (a family paints its
//              own);
//          (2) the Name Box label: the object's name for one, "N objects" for
//              several, nothing for none -- and nothing at all on a worksheet.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state: { surface: "grid" | "canvas"; zoom: number } = { surface: "canvas", zoom: 1 };
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => state,
}));

import { paintSelectionChrome, SELECTION_CHROME_COLOUR } from "../lib/selectionChrome";
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

/** A recording 2D context: every strokeRect / fillRect call, with its colour. */
function recordingContext() {
  const calls: Array<{ op: string; args: number[]; style: string }> = [];
  const ctx = {
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    setLineDash: () => {},
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

describe("set-held selection chrome", () => {
  it("frames ONLY the member the set holds (the family paints its own), at page - scroll", () => {
    addToObjectSelection(c1); // the chart family holds c1
    addToObjectSelection(c2); // ...so the set holds c2
    const { context, calls } = recordingContext();
    paintSelectionChrome(context);
    const frames = calls.filter((c) => c.op === "strokeRect");
    expect(frames).toHaveLength(1);
    // c2 at page x 200, scrolled by 50, inset by 1 for the 2px frame.
    expect(frames[0].args).toEqual([151, 11, 98, 48]);
    expect(frames[0].style).toBe(SELECTION_CHROME_COLOUR);
    // Four corner handles, in the same colour.
    expect(calls.filter((c) => c.op === "fillRect")).toHaveLength(4);
  });

  it("paints nothing with no set-held member, and nothing on a worksheet", () => {
    addToObjectSelection(c1);
    const one = recordingContext();
    paintSelectionChrome(one.context);
    expect(one.calls).toEqual([]);

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
