//! FILENAME: app/src/api/__tests__/objectSelectionWorksheetPress.test.ts
// PURPOSE: PRESS PARITY ON A WORKSHEET (BUG-0270 review, finding 2): a plain
//          press on a floating object deselects every OTHER family, so a chart
//          clicked before a slicer is no longer selected beside it; a
//          Ctrl/Shift press keeps them -- a deliberate multi-selection -- and
//          Delete then removes that selection WHOLE, on a worksheet as on a
//          canvas (`shouldActOnWholeObjectSelection`).
// CONTEXT: Before this, Core called the seam's press hook on a canvas only.
//          On a worksheet a chart and a slicer clicked in turn both stayed
//          selected (no family deselects on another family's press), Charts'
//          own door owned Delete, and Delete removed the chart clicked EARLIER
//          and left the slicer just clicked -- a second Delete and a second
//          undo step for one selection. Doubles of real family semantics; the
//          Core half (the press handler calls this hook on a worksheet) is
//          core/hooks/useMouseSelection/layout/__tests__/overlayZones.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let surface: "grid" | "canvas" = "grid";
vi.mock("../../core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ surface, sheetContext: { activeSheetIndex: 0 } }),
}));

import {
  getSelectedObjectRegions,
  noteWorksheetObjectPress,
  notifyObjectSelectionChanged,
  objectSelectionSpansFamilies,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  shouldActOnWholeObjectSelection,
  type ObjectSelectionProvider,
} from "../objectSelection";
import { registerGridOverlay, setGridRegions, unregisterGridOverlay, type GridRegion } from "../gridOverlays";

function region(id: string, type: string, x = 0): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y: 0, width: 10, height: 10 } };
}

/** A family that holds several (Slicer's, Controls' shape); `click` is its own press handler. */
function family(type: string) {
  const selected = new Set<string>();
  const provider: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => selected.has(r.id),
    select: (r) => {
      selected.clear();
      selected.add(r.id);
      notifyObjectSelectionChanged();
    },
    deselectAll: vi.fn(() => {
      if (selected.size === 0) return;
      selected.clear();
      notifyObjectSelectionChanged();
    }),
    addToSelection: (r) => {
      selected.add(r.id);
      notifyObjectSelectionChanged();
    },
  };
  return {
    provider,
    selected,
    /** The family's own press: a plain press replaces, Ctrl adds. */
    click(r: GridRegion, ctrl = false) {
      if (!ctrl) selected.clear();
      selected.add(r.id);
      notifyObjectSelectionChanged();
    },
  };
}

const chart = region("chart-c1", "chart", 0);
const slicer = region("slicer-s1", "slicer", 20);
const shape = region("ctrl-1", "floating-control", 40);
const shape2 = region("ctrl-2", "floating-control", 60);

let charts: ReturnType<typeof family>;
let slicers: ReturnType<typeof family>;
let controls: ReturnType<typeof family>;

beforeEach(() => {
  surface = "grid";
  resetObjectSelectionProviders();
  charts = family("chart");
  slicers = family("slicer");
  controls = family("floating-control");
  registerGridOverlay({ type: "chart", render: () => {}, priority: 15 });
  registerGridOverlay({ type: "slicer", render: () => {}, priority: 14 });
  registerGridOverlay({ type: "floating-control", render: () => {}, priority: 13 });
  registerObjectSelectionProvider(charts.provider);
  registerObjectSelectionProvider(slicers.provider);
  registerObjectSelectionProvider(controls.provider);
  setGridRegions([chart, slicer, shape, shape2]);
});

afterEach(() => {
  resetObjectSelectionProviders();
  setGridRegions([]);
  unregisterGridOverlay("chart");
  unregisterGridOverlay("slicer");
  unregisterGridOverlay("floating-control");
});

/** What Core does for a press on a worksheet: the hook, then the family's own click. */
function pressOnWorksheet(r: GridRegion, f: ReturnType<typeof family>, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  noteWorksheetObjectPress(r, mods);
  f.click(r, mods.ctrlKey === true || mods.shiftKey === true);
}

describe("a PLAIN press on a worksheet selects one family's object", () => {
  it("a chart clicked before a slicer is deselected by the slicer's press", () => {
    pressOnWorksheet(chart, charts);
    pressOnWorksheet(slicer, slicers);
    expect(
      getSelectedObjectRegions().map((r) => r.id),
      "the chart clicked EARLIER stayed selected beside the slicer: Delete would delete the chart",
    ).toEqual(["slicer-s1"]);
    expect(objectSelectionSpansFamilies()).toBe(false);
  });

  it("the pressed family itself is not deselected (its own handler decides: a group, a chart's next rung)", () => {
    pressOnWorksheet(shape, controls);
    controls.selected.add("ctrl-2"); // the family's own multi-selection (a group)
    noteWorksheetObjectPress(shape);
    expect(controls.provider.deselectAll, "the pressed family was deselected by its own press").not.toHaveBeenCalled();
    expect([...controls.selected].sort()).toEqual(["ctrl-1", "ctrl-2"]);
  });

  it("a press on a member of a deliberate multi-selection narrows to its family (no cross-family drag on a worksheet)", () => {
    pressOnWorksheet(chart, charts);
    pressOnWorksheet(slicer, slicers, { ctrlKey: true });
    expect(getSelectedObjectRegions().map((r) => r.id).sort(), "fixture: Ctrl kept both").toEqual(["chart-c1", "slicer-s1"]);
    pressOnWorksheet(chart, charts);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["chart-c1"]);
  });
});

describe("a Ctrl or Shift press keeps the other families' objects (a deliberate multi-selection)", () => {
  for (const mods of [{ ctrlKey: true }, { shiftKey: true }]) {
    it(`${JSON.stringify(mods)}: the chart stays selected beside the slicer`, () => {
      pressOnWorksheet(chart, charts);
      pressOnWorksheet(slicer, slicers, mods);
      expect(charts.provider.deselectAll).not.toHaveBeenCalled();
      expect(getSelectedObjectRegions().map((r) => r.id).sort()).toEqual(["chart-c1", "slicer-s1"]);
    });
  }
});

describe("Delete acts on a multi-selection WHOLE on a worksheet too", () => {
  it("a deliberate selection spanning families is a whole-selection Delete (each family's door hands it over)", () => {
    setObjectSelectionSet([chart, slicer], slicer);
    expect(
      shouldActOnWholeObjectSelection(),
      "on a worksheet a Ctrl+click selection of a chart and a slicer lost the slicer to the chart's own Delete",
    ).toBe(true);
  });

  it("control: one family's objects stay with that family's own door (a chart's title rung, Controls' group delete)", () => {
    setObjectSelectionSet([shape, shape2], shape);
    expect(shouldActOnWholeObjectSelection()).toBe(false);
    setObjectSelectionSet([chart], chart);
    expect(shouldActOnWholeObjectSelection()).toBe(false);
  });

  it("control: a canvas answers the same", () => {
    surface = "canvas";
    setObjectSelectionSet([chart, slicer], slicer);
    expect(shouldActOnWholeObjectSelection()).toBe(true);
  });
});
