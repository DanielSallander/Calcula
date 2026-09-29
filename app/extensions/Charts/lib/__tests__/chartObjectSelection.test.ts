//! FILENAME: app/extensions/Charts/lib/__tests__/chartObjectSelection.test.ts
// PURPOSE: Charts' provider for the `@api/objectSelection` seam. A keyboard
//          (Tab on a canvas) or program selection must SELECT the chart and do
//          nothing else: in particular it must not arm the pending click that a
//          mouse press arms, or the next unrelated mouseup would walk the
//          sub-selection ladder (chart -> series). And while the ladder is
//          below chart level, Escape belongs to the chart (it steps up a rung).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

import {
  createChartObjectSelectionProvider,
  chartOwnsObjectKey,
  chartIdOfRegion,
  type ChartDeleteRefusal,
} from "../chartObjectSelection";
import {
  consumePendingClick,
  getCurrentChartId,
  getSubSelection,
  isChartSelected,
  resetSelectionHandlerState,
  selectChart,
  setPendingClick,
  setSubSelection,
} from "../../handlers/selectionHandler";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  selectObject,
  deselectAllObjects,
  objectOwnsKey,
} from "@api/objectSelection";
import type { GridRegion } from "@api/gridOverlays";

const region = (chartId: string): GridRegion =>
  ({
    id: `chart-${chartId}`,
    type: "chart",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: 100, height: 100 },
    data: { chartId },
  }) as GridRegion;

const deps = {
  emitSelection: vi.fn(),
  invalidateChart: vi.fn(),
  refresh: vi.fn(),
};

beforeEach(() => {
  resetSelectionHandlerState();
  resetObjectSelectionProviders();
  deps.emitSelection.mockClear();
  deps.invalidateChart.mockClear();
  deps.refresh.mockClear();
});

describe("select", () => {
  it("selects the chart at chart level and announces it", () => {
    const p = createChartObjectSelectionProvider(deps);
    p.select(region("c1"));
    expect(getCurrentChartId()).toBe("c1");
    expect(getSubSelection()).toEqual({ level: "chart" });
    expect(p.isSelected(region("c1"))).toBe(true);
    expect(p.isSelected(region("c2"))).toBe(false);
    expect(deps.emitSelection).toHaveBeenCalledTimes(1);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });

  it("does NOT arm a pending click (a mouse press would)", () => {
    const p = createChartObjectSelectionProvider(deps);
    p.select(region("c1"));
    expect(consumePendingClick()).toBeNull();
  });

  it("clears a pending click an earlier press left, so the next mouseup cannot complete it", () => {
    selectChart("c1");
    setPendingClick("c1", 10, 10);
    const p = createChartObjectSelectionProvider(deps);
    p.select(region("c1"));
    expect(consumePendingClick()).toBeNull();
    // Re-selecting the selected chart keeps its rung.
    expect(getCurrentChartId()).toBe("c1");
  });

  it("moves the selection to another chart and repaints the one it left", () => {
    const p = createChartObjectSelectionProvider(deps);
    p.select(region("c1"));
    p.select(region("c2"));
    expect(isChartSelected("c2")).toBe(true);
    expect(isChartSelected("c1")).toBe(false);
    expect(deps.invalidateChart).toHaveBeenCalledWith("c1");
  });

  it("ignores a region with no chart id", () => {
    const p = createChartObjectSelectionProvider(deps);
    p.select({ ...region("x"), data: {} } as GridRegion);
    expect(getCurrentChartId()).toBeNull();
    expect(chartIdOfRegion({ ...region("x"), data: undefined } as GridRegion)).toBeNull();
  });
});

describe("deselectAll", () => {
  it("deselects the chart and announces it", () => {
    const p = createChartObjectSelectionProvider(deps);
    p.select(region("c1"));
    deps.emitSelection.mockClear();
    p.deselectAll();
    expect(getCurrentChartId()).toBeNull();
    expect(deps.emitSelection).toHaveBeenCalledTimes(1);
    expect(deps.invalidateChart).toHaveBeenCalledWith("c1");
  });

  it("is silent when nothing is selected (another family's select calls it)", () => {
    const p = createChartObjectSelectionProvider(deps);
    p.deselectAll();
    expect(deps.emitSelection).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });
});

describe("ownsKey", () => {
  it("owns Escape only while the sub-selection is below chart level", () => {
    expect(chartOwnsObjectKey("Escape")).toBe(false); // nothing selected
    selectChart("c1");
    expect(chartOwnsObjectKey("Escape")).toBe(false); // chart level: the cycler's
    setSubSelection("c1", { level: "series", seriesIndex: 0 });
    expect(chartOwnsObjectKey("Escape")).toBe(true);
    setSubSelection("c1", { level: "dataPoint", seriesIndex: 0, categoryIndex: 2 });
    expect(chartOwnsObjectKey("Escape")).toBe(true);
  });

  it("never owns Tab", () => {
    selectChart("c1");
    setSubSelection("c1", { level: "series", seriesIndex: 0 });
    expect(chartOwnsObjectKey("Tab")).toBe(false);
  });
});

describe("through the seam", () => {
  it("registers for type 'chart' and answers selectObject / objectOwnsKey / deselectAllObjects", () => {
    const off = registerObjectSelectionProvider(createChartObjectSelectionProvider(deps));
    expect(selectObject(region("c9"))).toBe(true);
    expect(getCurrentChartId()).toBe("c9");
    expect(consumePendingClick()).toBeNull();
    setSubSelection("c9", { level: "series", seriesIndex: 1 });
    expect(objectOwnsKey("Escape")).toBe(true);
    deselectAllObjects();
    expect(getCurrentChartId()).toBeNull();
    off();
    expect(selectObject(region("c9"))).toBe(false);
  });
});

describe("refOf: the chart's canvas identity (M8)", () => {
  it("is { kind: 'chart', id: chartId }, and reaches objectRefOf through the seam", async () => {
    const { objectRefOf } = await import("@api/objectSelection");
    const provider = createChartObjectSelectionProvider(deps);
    expect(provider.refOf?.(region("c7"))).toEqual({ kind: "chart", id: "c7" });
    const off = registerObjectSelectionProvider(provider);
    expect(objectRefOf(region("c7"))).toEqual({ kind: "chart", id: "c7" });
    off();
    expect(objectRefOf(region("c7"))).toBeNull();
  });

  it("is null for a region that carries no chart id", () => {
    const provider = createChartObjectSelectionProvider(deps);
    expect(provider.refOf?.({ ...region("x"), data: {} })).toBeNull();
  });
});

describe("the canvas selection set (M8)", () => {
  it("selectChart / deselectChart -- the chart's chokepoints -- announce a CHANGE to the set, and only a change", async () => {
    const { onObjectSelectionChanged } = await import("@api/objectSelection");
    const { deselectChart } = await import("../../handlers/selectionHandler");
    const seen = vi.fn();
    const off = onObjectSelectionChanged(seen);
    selectChart("c1");
    expect(seen).toHaveBeenCalledTimes(1);
    selectChart("c1"); // already selected: the pending-click route, no change
    expect(seen).toHaveBeenCalledTimes(1);
    selectChart("c2");
    expect(seen).toHaveBeenCalledTimes(2);
    deselectChart();
    expect(seen).toHaveBeenCalledTimes(3);
    deselectChart();
    expect(seen).toHaveBeenCalledTimes(3);
    off();
  });

  it("labelOf is the name the chart region is published with", () => {
    const p = createChartObjectSelectionProvider(deps);
    expect(p.labelOf!({ ...region("c1"), data: { chartId: "c1", name: "Sales by Region" } })).toBe("Sales by Region");
    expect(p.labelOf!(region("c1"))).toBeNull();
  });

  it("is single-select: it offers no addToSelection, so the SET holds a second chart", async () => {
    const { addToObjectSelection, getSetHeldObjectRegions, getSelectedObjectRegions } = await import("@api/objectSelection");
    const { setGridRegions } = await import("@api/gridOverlays");
    const p = createChartObjectSelectionProvider(deps);
    expect(p.addToSelection).toBeUndefined();
    registerObjectSelectionProvider(p);
    setGridRegions([region("c1"), region("c2")]);
    addToObjectSelection(region("c1"));
    addToObjectSelection(region("c2"));
    expect(getCurrentChartId()).toBe("c1");
    expect(getSetHeldObjectRegions().map((r) => r.id)).toEqual(["chart-c2"]);
    expect(getSelectedObjectRegions()).toHaveLength(2);
    setGridRegions([]);
  });
});

describe("deleteObjects (a canvas-wide Delete's share, open-items 2.af row 1)", () => {
  it("hands EVERY chart it is given -- the set-held ones too -- to THE chart delete", async () => {
    const deleteCharts = vi.fn(async (): Promise<ChartDeleteRefusal[]> => []);
    const p = createChartObjectSelectionProvider({ ...deps, deleteCharts });
    await p.deleteObjects!([region("c1"), region("c2")]);
    expect(deleteCharts).toHaveBeenCalledWith(["c1", "c2"]);
  });

  it("REJECTS with the backend's reason when a chart delete was refused (the seam's contract)", async () => {
    // THE chart delete never rejects: it puts a refused chart back and
    // resolves. Resolving here too made the seam count the chart as deleted
    // and deselect the chart that came back (wave A review).
    const deleteCharts = vi.fn(
      async (): Promise<ChartDeleteRefusal[]> => [{ chartId: "c2", reason: "The sheet is protected." }],
    );
    const p = createChartObjectSelectionProvider({ ...deps, deleteCharts });
    await expect(p.deleteObjects!([region("c1"), region("c2")])).rejects.toThrow("The sheet is protected.");
  });

  it("without the delete injected the provider offers none (it stays out of the seam's delete)", () => {
    expect(createChartObjectSelectionProvider(deps).deleteObjects).toBeUndefined();
  });
});
