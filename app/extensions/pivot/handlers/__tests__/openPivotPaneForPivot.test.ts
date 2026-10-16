//! FILENAME: app/extensions/Pivot/handlers/__tests__/openPivotPaneForPivot.test.ts
// PURPOSE: Two selection-handler pieces the value-cell menu (WP-A S10) stands on:
//          - `isModelPivot(pivotId)` is SYNCHRONOUS and reads the cached
//            region's `isModel` (transported since WP-A S1); undefined for a
//            pivot with no cached region -- callers never guess;
//          - `openPivotPaneForPivot(pivotId)`, the ONE host hook of the
//            value-field dialog contract: on a canvas (WP-C ruling R4) it
//            selects the box and opens the ONE object pane on its FIELDS tab
//            as a door -- no `pivot-editor` pane, no pivot-editor flag; on a
//            worksheet it reads the pivot at its anchor and shows the
//            field-list pane, a pane closed by hand opened anyway; a pivot not
//            on the sheet rejects.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  surface: "grid" as string,
  manuallyClosed: ["pivot-pane"] as string[],
  regions: [] as Array<Record<string, unknown>>,
  paneOpens: true,
  openObjectPane: vi.fn(),
}));

vi.mock("@api", () => ({
  openTaskPane: vi.fn(),
  closeTaskPane: vi.fn(),
  // Stateful like the real service: a pane closed by hand stays closed until cleared.
  getTaskPaneManuallyClosed: () => [...h.manuallyClosed],
  clearTaskPaneManuallyClosed: vi.fn((id: string) => {
    h.manuallyClosed = h.manuallyClosed.filter((x) => x !== id);
  }),
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  emitAppEvent: vi.fn(),
}));
vi.mock("@api/pivot", () => ({ pivot: { getAtCell: vi.fn(async () => null) } }));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => ({ surface: h.surface }) }));
vi.mock("@api/gridOverlays", () => ({ requestOverlayRedraw: vi.fn(), getGridRegions: () => h.regions }));
vi.mock("@api/objectPane", () => ({
  openObjectPane: (req: unknown) => {
    h.openObjectPane(req);
    return h.paneOpens;
  },
}));
vi.mock("@api/objectSelection", () => ({ notifyObjectSelectionChanged: vi.fn() }));
vi.mock("../../manifest", () => ({
  PIVOT_PANE_ID: "pivot-pane",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));

import { openTaskPane, clearTaskPaneManuallyClosed } from "@api";
import { pivot } from "@api/pivot";
import {
  isModelPivot,
  openPivotPaneForPivot,
  updateCachedRegions,
  getSelectedVisualPivotId,
  resetSelectionHandlerState,
} from "../selectionHandler";
import type { PivotRegionData } from "../../types";

function region(pivotId: string, isModel: boolean, startRow = 3, startCol = 2): PivotRegionData {
  return { pivotId, name: pivotId, startRow, startCol, endRow: startRow + 5, endCol: startCol + 3, isEmpty: false, isModel } as PivotRegionData;
}

const INFO = {
  pivotId: "range",
  isEmpty: false,
  sourceFields: [],
  filterZones: [],
  fieldConfiguration: { rowFields: [], columnFields: [], valueFields: [], filterFields: [], layout: {} },
};

beforeEach(() => {
  resetSelectionHandlerState();
  vi.clearAllMocks();
  h.surface = "grid";
  h.manuallyClosed = ["pivot-pane"];
  h.regions = [];
  h.paneOpens = true;
});

/** A published canvas box of `pivotId` (what the frame store publishes). */
function box(pivotId: string): Record<string, unknown> {
  return {
    id: `pivot-visual-${pivotId}`,
    type: "pivot-visual",
    startRow: 0,
    startCol: 0,
    endRow: 5,
    endCol: 3,
    floating: { x: 10, y: 10, width: 300, height: 200 },
    data: { pivotId },
  };
}

describe("isModelPivot", () => {
  it("reads the cached region's isModel; undefined for a pivot with no cached region", () => {
    updateCachedRegions([region("range", false), region("model", true, 20)]);
    expect(isModelPivot("range")).toBe(false);
    expect(isModelPivot("model")).toBe(true);
    expect(isModelPivot("elsewhere")).toBeUndefined();
  });

  it("follows the region cache (no stale answer after the regions change)", () => {
    updateCachedRegions([region("range", false)]);
    expect(isModelPivot("range")).toBe(false);
    updateCachedRegions([]);
    expect(isModelPivot("range")).toBeUndefined();
  });
});

describe("openPivotPaneForPivot", () => {
  it("worksheet: reads the pivot at its anchor and shows the field-list pane, even one closed by hand", async () => {
    updateCachedRegions([region("range", false, 7, 4)]);
    vi.mocked(pivot.getAtCell).mockResolvedValueOnce(INFO as never);
    await openPivotPaneForPivot("range");
    expect(clearTaskPaneManuallyClosed).toHaveBeenCalledWith("pivot-pane");
    expect(pivot.getAtCell).toHaveBeenCalledWith(7, 4);
    expect(openTaskPane).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openTaskPane).mock.calls[0][0]).toBe("pivot-pane");
    expect((vi.mocked(openTaskPane).mock.calls[0][1] as { pivotId: string }).pivotId).toBe("range");
  });

  it("worksheet: a pivot the backend cannot read rejects, opening nothing", async () => {
    updateCachedRegions([region("range", false)]);
    await expect(openPivotPaneForPivot("range")).rejects.toThrow("could not be read");
    expect(openTaskPane).not.toHaveBeenCalled();
  });

  it("canvas (ruling R4): selects the box and opens the ONE object pane on its Fields tab as a DOOR -- no pivot-editor pane, no pivot-editor flag", async () => {
    h.surface = "canvas";
    updateCachedRegions([region("range", false, 0, 0)]);
    h.regions = [box("other"), box("range")];
    await openPivotPaneForPivot("range");
    expect(getSelectedVisualPivotId()).toBe("range");
    expect(h.openObjectPane).toHaveBeenCalledTimes(1);
    expect(h.openObjectPane).toHaveBeenCalledWith({ region: h.regions[1], tab: "fields", reason: "command" });
    // The worksheet pane is not the canvas box's: neither opened nor un-closed.
    expect(clearTaskPaneManuallyClosed).not.toHaveBeenCalled();
    expect(openTaskPane).not.toHaveBeenCalled();
    expect(pivot.getAtCell).not.toHaveBeenCalled();
  });

  it("canvas: a box that is not published on the page, or an object pane that cannot open, REJECTS (the dialog request is then dropped)", async () => {
    h.surface = "canvas";
    updateCachedRegions([region("range", false, 0, 0)]);
    await expect(openPivotPaneForPivot("range")).rejects.toThrow("not on this page");
    h.regions = [box("range")];
    h.paneOpens = false;
    await expect(openPivotPaneForPivot("range")).rejects.toThrow("could not be opened");
    expect(openTaskPane).not.toHaveBeenCalled();
  });

  it("a pivot not on this sheet rejects and changes nothing", async () => {
    updateCachedRegions([region("range", false)]);
    await expect(openPivotPaneForPivot("other")).rejects.toThrow("not on this sheet");
    expect(clearTaskPaneManuallyClosed).not.toHaveBeenCalled();
    expect(pivot.getAtCell).not.toHaveBeenCalled();
  });
});
