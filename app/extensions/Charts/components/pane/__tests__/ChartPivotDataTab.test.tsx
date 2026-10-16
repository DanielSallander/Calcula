//! FILENAME: app/extensions/Charts/components/pane/__tests__/ChartPivotDataTab.test.tsx
// PURPOSE: The object pane's Data tab for a PIVOT-SOURCED chart (WP-C S9c):
//          it names the PivotTable (read-only), its subtotal / grand-total
//          toggles write `data` as ONE update_chart in ONE "Edit chart data"
//          undo step, and "Select PivotTable" takes the reader to the
//          PivotTable -- a box on a canvas page is selected and the object pane
//          opens on its Fields; a worksheet PivotTable is selected at its
//          anchor cell after the sheet switch (lib/selectSourcePivot).
// CONTEXT: The real tab, chart store and undo transaction (backend doubled
//          into one ordered log); the routes of selectSourcePivot run on
//          injected seams.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const log: string[] = [];

vi.mock("../../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../src/core/lib/tauri-api")>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: () => Promise.resolve() }));

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import type { ObjectPaneTabContext } from "@api/objectPane";
import { getChartById, loadChartsFromBackend, resetChartStore } from "../../../lib/chartStore";
import { chartsBackend } from "../../../lib/chartsBackend";
import { CHART_DATA_UNDO_LABEL } from "../../../lib/chartDataCommit";
import { selectSourcePivot, type SelectSourcePivotDeps } from "../../../lib/selectSourcePivot";
import { ChartPivotDataTab, GRAND_TOTAL_AUTOMATIC_HINT } from "../ChartPivotDataTab";
import type { ChartSpec } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const spec = {
  mark: "bar",
  data: { type: "pivot", pivotId: "p-7" },
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Sum of Sales", sourceIndex: 0, color: null }],
  title: "AWPivot",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: true, position: "bottom" },
  palette: "default",
} as unknown as ChartSpec;

const invokeBackend = vi.fn();
let host: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const ctx: ObjectPaneTabContext = {
  region: { id: "chart-c1", type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
  readOnly: false,
  readOnlyReason: null,
  activeTabId: "data",
};

async function mount(props: Partial<React.ComponentProps<typeof ChartPivotDataTab>> = {}): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(ChartPivotDataTab, {
        ctx,
        chartId: "c1",
        getChart: getChartById,
        pivotName: async () => "AWPivot",
        selectPivot: async () => null,
        ...props,
      }),
    );
  });
  await settle();
}

beforeEach(async () => {
  log.length = 0;
  resetChartStore();
  setGridRegions([]);
  chartsBackend.set(invokeBackend);
  invokeBackend.mockReset();
  invokeBackend.mockResolvedValueOnce([
    {
      id: "c1",
      sheetIndex: 2,
      specJson: JSON.stringify({ chartId: "c1", name: "Chart 1", sheetIndex: 2, x: 10, y: 20, width: 400, height: 300, spec }),
    },
  ]);
  await loadChartsFromBackend({ stampSheetIds: false });
  invokeBackend.mockReset();
  invokeBackend.mockImplementation((cmd: string) => {
    log.push(cmd);
    return new Promise((resolve) => setTimeout(() => resolve(undefined), 0));
  });
  log.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetChartStore();
  setGridRegions([]);
});

describe("the pivot-sourced chart's Data tab", () => {
  it("names the PivotTable it reads", async () => {
    await mount();
    expect(host.querySelector('[data-testid="chart-pivot-source"]')?.textContent).toBe("PivotTable AWPivot");
    expect(host.textContent).toContain("Source: PivotTable AWPivot");
  });

  it("the subtotal toggle writes data.includeSubtotals: one update_chart inside 'Edit chart data'", async () => {
    await mount();
    const toggle = host.querySelector('[data-testid="chart-pivot-subtotals"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    act(() => toggle.click());
    await settle();
    expect(log).toEqual([`begin:${CHART_DATA_UNDO_LABEL}`, "update_chart", "commit"]);
    expect(getChartById("c1")!.spec.data).toEqual({ type: "pivot", pivotId: "p-7", includeSubtotals: true });
    expect((host.querySelector('[data-testid="chart-pivot-subtotals"]') as HTMLInputElement).checked).toBe(true);
  });

  it("the grand total says it is automatic until the chart chooses, then writes the choice", async () => {
    await mount();
    expect(host.querySelector('[data-testid="chart-pivot-grandtotal-automatic"]')?.textContent).toBe(GRAND_TOTAL_AUTOMATIC_HINT);
    act(() => (host.querySelector('[data-testid="chart-pivot-grandtotal"]') as HTMLInputElement).click());
    await settle();
    expect(getChartById("c1")!.spec.data).toEqual({ type: "pivot", pivotId: "p-7", includeGrandTotal: true });
    expect(host.querySelector('[data-testid="chart-pivot-grandtotal-automatic"]')).toBeNull();
  });

  it("Select PivotTable asks for the chart's PivotTable and shows a refusal", async () => {
    const selectPivot = vi.fn(async () => "The PivotTable this chart reads could not be found.");
    await mount({ selectPivot });
    act(() => (host.querySelector('[data-testid="chart-pivot-select"]') as HTMLButtonElement).click());
    await settle();
    expect(selectPivot).toHaveBeenCalledWith("p-7");
    expect(host.querySelector('[data-testid="chart-pivot-data-message"]')?.textContent).toContain("could not be found");
    expect(log).toEqual([]);
  });

  it("on a subscribed page the toggles are disabled; Select PivotTable (navigation) is not", async () => {
    await act(async () => {
      root.render(
        React.createElement(ChartPivotDataTab, {
          ctx: { ...ctx, readOnly: true, readOnlyReason: "Subscribed." },
          chartId: "c1",
          getChart: getChartById,
          pivotName: async () => "AWPivot",
          selectPivot: async () => null,
        }),
      );
    });
    await settle();
    expect((host.querySelector("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect((host.querySelector('[data-testid="chart-pivot-select"]') as HTMLButtonElement).disabled).toBe(false);
  });
});

// ============================================================================
// selectSourcePivot's routes
// ============================================================================

function box(pivotId: string): GridRegion {
  return {
    id: `pivot-visual-${pivotId}`,
    type: "pivot-visual",
    startRow: 0,
    startCol: 0,
    endRow: 3,
    endCol: 2,
    floating: { x: 10, y: 10, width: 300, height: 200 },
    data: { pivotId, name: "AWPivot" },
  };
}

function fakeDeps(over: Partial<SelectSourcePivotDeps> = {}): SelectSourcePivotDeps & { calls: string[] } {
  const calls: string[] = [];
  let regions: GridRegion[] = [];
  const listeners = new Set<() => void>();
  const deps: SelectSourcePivotDeps & { calls: string[] } = {
    calls,
    regions: () => regions,
    onRegionsChanged: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    canSelect: () => true,
    select: (r) => {
      calls.push(`select:${r.id}`);
      return true;
    },
    openFields: (r) => {
      calls.push(`openFields:${r.id}`);
      return true;
    },
    activeSheetIndex: () => 0,
    pivotSheetIndex: async () => 0,
    activeSheetPivots: async () => [],
    activateSheet: async (i) => {
      calls.push(`activate:${i}`);
    },
    selectCell: (row, col) => {
      calls.push(`cell:${row},${col}`);
    },
    timeoutMs: 50,
    ...over,
  };
  (deps as unknown as { publish: (r: GridRegion[]) => void }).publish = (r) => {
    regions = r;
    listeners.forEach((cb) => cb());
  };
  return deps;
}

describe("selectSourcePivot", () => {
  it("a box on this page: selected, and the object pane opens on its Fields", async () => {
    const deps = fakeDeps({ regions: () => [box("p-7")] });
    expect(await selectSourcePivot("p-7", deps)).toBeNull();
    expect(deps.calls).toEqual(["select:pivot-visual-p-7", "openFields:pivot-visual-p-7"]);
  });

  it("a box on ANOTHER canvas page: the page is shown first, then the box is selected once it is published", async () => {
    const deps = fakeDeps({
      activeSheetIndex: () => 0,
      pivotSheetIndex: async () => 2,
      activeSheetPivots: async () => [{ pivotId: "p-7", startRow: 0, startCol: 0, isBox: true }],
    });
    const done = selectSourcePivot("p-7", deps);
    await new Promise((r) => setTimeout(r, 0));
    (deps as unknown as { publish: (r: GridRegion[]) => void }).publish([box("p-7")]);
    expect(await done).toBeNull();
    expect(deps.calls).toEqual(["activate:2", "select:pivot-visual-p-7", "openFields:pivot-visual-p-7"]);
  });

  it("a worksheet PivotTable: its sheet is shown and its anchor cell selected", async () => {
    const deps = fakeDeps({
      activeSheetIndex: () => 2,
      pivotSheetIndex: async () => 0,
      activeSheetPivots: async () => [{ pivotId: "p-7", startRow: 4, startCol: 1, isBox: false }],
    });
    expect(await selectSourcePivot("p-7", deps)).toBeNull();
    expect(deps.calls).toEqual(["activate:0", "cell:4,1"]);
  });

  it("no sheet switch when the PivotTable's sheet is already shown", async () => {
    const deps = fakeDeps({
      activeSheetIndex: () => 0,
      pivotSheetIndex: async () => 0,
      activeSheetPivots: async () => [{ pivotId: "p-7", startRow: 2, startCol: 3, isBox: false }],
    });
    expect(await selectSourcePivot("p-7", deps)).toBeNull();
    expect(deps.calls).toEqual(["cell:2,3"]);
  });

  it("a PivotTable that is gone is refused with a sentence, and nothing moves", async () => {
    const deps = fakeDeps({ pivotSheetIndex: async () => null });
    expect(await selectSourcePivot("p-7", deps)).toBe("The PivotTable this chart reads could not be found.");
    expect(deps.calls).toEqual([]);
  });

  it("a region of another family naming the same id is not taken for the box", async () => {
    const other = { ...box("p-7"), id: "chart-x", type: "chart" };
    const deps = fakeDeps({
      regions: () => [other],
      canSelect: (r) => r.type !== "chart",
      pivotSheetIndex: async () => 0,
      activeSheetPivots: async () => [{ pivotId: "p-7", startRow: 0, startCol: 0, isBox: false }],
    });
    expect(await selectSourcePivot("p-7", deps)).toBeNull();
    expect(deps.calls).toEqual(["cell:0,0"]);
  });
});
