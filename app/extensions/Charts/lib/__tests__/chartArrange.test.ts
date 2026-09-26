//! FILENAME: app/extensions/Charts/lib/__tests__/chartArrange.test.ts
// PURPOSE: Charts' side of the canvas ARRANGE work (M8 parts C and D):
//          - ownsKey("Arrow"): a selected chart at chart level NUDGES; a chart
//            walked down to a series (or a chart whose cues own Left/Right)
//            keeps its arrows;
//          - the multi-selection press rule (C6): the first plain click on an
//            already-selected chart that is one of SEVERAL selected objects
//            only narrows the selection -- it must not also arm the ladder's
//            pending click;
//          - BUG-0156: the pointer paths divide by the zoom (logical canvas px);
//          - the geometry provider: preview writes nothing, commit LANDS the
//            debounced save, and a refused commit rolls back and REJECTS
//            without a chart dialog (the seam shows one toast for everyone).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

const alertAsync = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => alertAsync(m, o) }));

let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

import {
  chartOwnsObjectKey,
  createChartObjectSelectionProvider,
  pressArmsChartLadder,
  pressArmsPendingChartClick,
} from "../chartObjectSelection";
import { resetSelectionHandlerState, selectChart, setSubSelection } from "../../handlers/selectionHandler";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { chartCanvasToClient, clientToChartCanvas, insideChartCanvas } from "../chartPointer";
import { createChartGeometryProvider } from "../chartGeometry";
import { getChartById, loadChartsFromBackend, resetChartStore } from "../chartStore";
import { chartsBackend } from "../chartsBackend";

beforeEach(() => {
  resetSelectionHandlerState();
  resetObjectSelectionProviders();
  gridSnapshot = null;
  alertAsync.mockClear();
});

// ============================================================================
// ownsKey("Arrow")
// ============================================================================

describe("a chart owns the arrows only below chart level (or while its cues step)", () => {
  it("nothing selected, or chart level without cues: the arrows are free -- the chart nudges", () => {
    expect(chartOwnsObjectKey("Arrow")).toBe(false);
    selectChart("c1");
    expect(chartOwnsObjectKey("Arrow")).toBe(false);
  });

  it("a SERIES (or a point) walks with the arrows: the chart owns them", () => {
    selectChart("c1");
    setSubSelection("c1", { level: "series", seriesIndex: 0 });
    expect(chartOwnsObjectKey("Arrow")).toBe(true);
    setSubSelection("c1", { level: "dataPoint", seriesIndex: 0, categoryIndex: 1 });
    expect(chartOwnsObjectKey("Arrow")).toBe(true);
  });

  it("chart level on a chart with insight cues: plain Left/Right step the cues, so no nudge", () => {
    selectChart("c1");
    expect(chartOwnsObjectKey("Arrow", () => 3)).toBe(true);
    expect(chartOwnsObjectKey("Arrow", () => 0)).toBe(false);
  });

  it("the provider answers through its injected cue count", () => {
    const p = createChartObjectSelectionProvider({
      emitSelection: vi.fn(),
      invalidateChart: vi.fn(),
      refresh: vi.fn(),
      cueCountOf: () => 2,
    });
    selectChart("c1");
    expect(p.ownsKey?.("Arrow")).toBe(true);
  });
});

// ============================================================================
// C6: the pending click inside a multi-selection
// ============================================================================

describe("pressArmsChartLadder (C6)", () => {
  it("a worksheet keeps its behaviour: an already-selected chart always arms the ladder", () => {
    expect(pressArmsChartLadder({ onCanvas: false, selectedCount: 5, additive: true })).toBe(true);
  });

  it("on a canvas: armed only for a plain press when the chart is the ONLY selected object", () => {
    expect(pressArmsChartLadder({ onCanvas: true, selectedCount: 1, additive: false })).toBe(true);
    expect(pressArmsChartLadder({ onCanvas: true, selectedCount: 3, additive: false })).toBe(false);
    expect(pressArmsChartLadder({ onCanvas: true, selectedCount: 1, additive: true })).toBe(false);
  });

  it("reads the live selection set and surface at press time", () => {
    const fam = (type: string): ObjectSelectionProvider => {
      const held = new Set<string>();
      return {
        types: [type],
        isSelected: (r) => held.has(r.id),
        select: (r) => {
          held.clear();
          held.add(r.id);
        },
        deselectAll: () => held.clear(),
      };
    };
    registerObjectSelectionProvider(fam("chart"));
    registerObjectSelectionProvider(fam("slicer"));
    const r = (id: string, type: string): GridRegion => ({
      id,
      type,
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: { x: 0, y: 0, width: 10, height: 10 },
    });
    gridSnapshot = { surface: "canvas" };
    // The set is read over the PUBLISHED regions.
    setGridRegions([r("chart-c1", "chart"), r("slicer-s1", "slicer")]);
    setObjectSelectionSet([r("chart-c1", "chart"), r("slicer-s1", "slicer")]);
    // In a multi-selection the first click only narrows.
    expect(pressArmsPendingChartClick({ ctrlKey: false, shiftKey: false })).toBe(false);
    setObjectSelectionSet([r("chart-c1", "chart")]);
    expect(pressArmsPendingChartClick({ ctrlKey: false, shiftKey: false })).toBe(true);
    setGridRegions([]);
  });

  it("the press handler is gated on it (source wiring)", () => {
    const src = readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
    const at = src.indexOf("if (isChartSelected(chartId)) {");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 900);
    expect(block).toContain("if (pressArmsPendingChartClick(detail)) {");
    expect(block.indexOf("pressArmsPendingChartClick")).toBeLessThan(block.indexOf("setPendingClick("));
  });
});

// ============================================================================
// BUG-0156: the pointer divides by the zoom
// ============================================================================

describe("clientToChartCanvas (BUG-0156)", () => {
  it("at zoom 1.5 a client point maps to LOGICAL canvas px, and back", () => {
    const rect = { left: 100, top: 40, width: 300, height: 150 };
    expect(clientToChartCanvas(250, 130, rect, 1.5)).toEqual({ x: 100, y: 60 });
    expect(chartCanvasToClient(100, 60, rect, 1.5)).toEqual({ x: 250, y: 130 });
    // The grid box is 300 SCREEN px wide: 200 logical px at 1.5.
    expect(insideChartCanvas({ x: 190, y: 50 }, rect, 1.5)).toBe(true);
    expect(insideChartCanvas({ x: 210, y: 50 }, rect, 1.5)).toBe(false);
  });

  it("zoom 1 is the identity offset; a bad zoom counts as 1", () => {
    const rect = { left: 10, top: 20 };
    expect(clientToChartCanvas(60, 70, rect, 1)).toEqual({ x: 50, y: 50 });
    expect(clientToChartCanvas(60, 70, rect, 0)).toEqual({ x: 50, y: 50 });
  });

  it("the live zoom is read when none is passed", () => {
    gridSnapshot = { zoom: 2 };
    expect(clientToChartCanvas(210, 20, { left: 10, top: 0 })).toEqual({ x: 100, y: 10 });
  });

  it("both pointer paths of Charts/index.ts go through it (no raw clientX - rect.left left)", () => {
    const src = readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
    expect(src).not.toMatch(/=\s*e\.clientX\s*-\s*rect\.left\s*;/);
    expect(src.match(/clientToChartCanvas\(e\.clientX, e\.clientY, rect/g)?.length).toBe(2);
    expect(src.match(/chartCanvasToClient\(canvasX, canvasY, rect\)/g)?.length).toBe(2);
  });
});

// ============================================================================
// The geometry provider
// ============================================================================

const baseSpec = {
  mark: "bar",
  data: "Sheet1!A1:D13",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Revenue", sourceIndex: 1, color: null }],
  title: "Persisted",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
};

const entry = (chartId: string) => ({
  id: chartId,
  sheetIndex: 0,
  specJson: JSON.stringify({ chartId, name: chartId, sheetIndex: 0, x: 10, y: 20, width: 400, height: 300, spec: baseSpec }),
});

const chartRegion = (chartId: string): GridRegion => ({
  id: `chart-${chartId}`,
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 10, y: 20, width: 400, height: 300 },
  data: { chartId, name: chartId },
});

describe("the chart geometry provider", () => {
  const invokeBackend = vi.fn();
  const deps = { invalidateChart: vi.fn(), refresh: vi.fn() };

  beforeEach(async () => {
    resetChartStore();
    invokeBackend.mockReset();
    chartsBackend.set(invokeBackend);
    invokeBackend.mockResolvedValueOnce([entry("c1")]);
    await loadChartsFromBackend();
    invokeBackend.mockReset();
  });

  it("preview moves the chart and writes NOTHING", async () => {
    const p = createChartGeometryProvider(deps);
    p.preview!([{ region: chartRegion("c1"), x: 50, y: 60, width: 400, height: 300 }]);
    expect(getChartById("c1")?.x).toBe(50);
    await new Promise((r) => setTimeout(r, 350));
    expect(invokeBackend).not.toHaveBeenCalled();
  });

  it("commit has LANDED the write when it resolves", async () => {
    invokeBackend.mockResolvedValue(undefined);
    const p = createChartGeometryProvider(deps);
    await p.commit([{ region: chartRegion("c1"), x: 70, y: 80, width: 400, height: 300 }]);
    expect(invokeBackend).toHaveBeenCalledTimes(1);
    expect(invokeBackend.mock.calls[0][0]).toBe("update_chart");
    expect(JSON.parse(invokeBackend.mock.calls[0][1].entry.specJson)).toMatchObject({ x: 70, y: 80 });
  });

  it("a REFUSED commit rolls the chart back and rejects -- no chart dialog", async () => {
    invokeBackend.mockRejectedValue(new Error("The sheet is protected."));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = createChartGeometryProvider(deps);
    await expect(
      p.commit([{ region: chartRegion("c1"), x: 70, y: 80, width: 400, height: 300 }]),
    ).rejects.toThrow("The sheet is protected.");
    errors.mockRestore();
    expect(getChartById("c1")).toMatchObject({ x: 10, y: 20 });
    expect(alertAsync).not.toHaveBeenCalled();
  });
});
