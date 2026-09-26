//! FILENAME: app/extensions/CanvasSheet/__tests__/objectCycling.test.ts
// PURPOSE: The canvas keyboard: Tab / Shift+Tab step through the page's
//          objects in paint order and wrap; the guards keep the keys away from
//          worksheets, from an empty canvas and from an inner selection that
//          owns the key. (A press on the empty page is the marquee's since M8:
//          __tests__/marquee.test.ts pins what it does.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let surface: "grid" | "canvas" = "canvas";
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface }),
}));
let gridFocused = true;
vi.mock("@api/keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/keybindings")>()),
  isGridFocused: () => gridFocused,
}));

import {
  escapeApplies,
  stepCanvasObject,
  stepObject,
  tabApplies,
} from "../lib/objectCycling";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";

function region(id: string, type = "chart"): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x: 0, y: 0, width: 5, height: 5 } };
}

let selected: string | null = null;
let innerOwns = false;
const provider: ObjectSelectionProvider = {
  types: ["chart"],
  isSelected: (r) => r.id === selected,
  select: (r) => {
    selected = r.id;
  },
  deselectAll: () => {
    selected = null;
  },
  ownsKey: () => innerOwns,
};

const cleanups: Array<() => void> = [];
beforeEach(() => {
  surface = "canvas";
  gridFocused = true;
  selected = null;
  innerOwns = false;
  resetObjectSelectionProviders();
  cleanups.push(registerObjectSelectionProvider(provider), registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }));
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("stepObject (pure)", () => {
  const a = region("a"), b = region("b"), c = region("c");
  it("starts at the first going forward and at the last going back", () => {
    expect(stepObject([a, b, c], null, 1)?.id).toBe("a");
    expect(stepObject([a, b, c], null, -1)?.id).toBe("c");
  });
  it("wraps at both ends", () => {
    expect(stepObject([a, b, c], c, 1)?.id).toBe("a");
    expect(stepObject([a, b, c], a, -1)?.id).toBe("c");
  });
  it("answers null with nothing to cycle", () => {
    expect(stepObject([], null, 1)).toBeNull();
  });
});

describe("stepping the live canvas", () => {
  it("Tab walks the published objects and wraps", () => {
    setGridRegions([region("a"), region("b")]);
    expect(stepCanvasObject(1)?.id).toBe("a");
    expect(stepCanvasObject(1)?.id).toBe("b");
    expect(stepCanvasObject(1)?.id).toBe("a");
    expect(stepCanvasObject(-1)?.id).toBe("b");
    expect(selected).toBe("b");
  });
});

describe("the guards", () => {
  it("Tab applies on a focused canvas with objects", () => {
    setGridRegions([region("a")]);
    expect(tabApplies()).toBe(true);
  });
  it("Tab does NOT apply on a worksheet, without focus, on an empty canvas, or while an inner selection owns it", () => {
    setGridRegions([region("a")]);
    surface = "grid";
    expect(tabApplies()).toBe(false);
    surface = "canvas";
    gridFocused = false;
    expect(tabApplies()).toBe(false);
    gridFocused = true;
    innerOwns = true;
    expect(tabApplies()).toBe(false);
    innerOwns = false;
    setGridRegions([]);
    expect(tabApplies()).toBe(false);
  });
  it("Escape applies only while something is selected", () => {
    setGridRegions([region("a")]);
    expect(escapeApplies()).toBe(false);
    selected = "a";
    expect(escapeApplies()).toBe(true);
    innerOwns = true;
    expect(escapeApplies()).toBe(false);
  });
});

describe("Tab from a multi-selection", () => {
  it("steps to ONE object and drops the rest of the set", async () => {
    const { addToObjectSelection, getSelectedObjectRegions } = await import("@api/objectSelection");
    const a = region("a"), b = region("b"), c = region("c");
    setGridRegions([a, b, c]);
    selected = "a";
    addToObjectSelection(b); // the chart double holds one: b is held by the set
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["a", "b"]);
    stepCanvasObject(1);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["b"]);
  });
});
