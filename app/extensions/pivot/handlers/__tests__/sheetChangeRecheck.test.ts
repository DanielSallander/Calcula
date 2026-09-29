//! FILENAME: app/extensions/Pivot/handlers/__tests__/sheetChangeRecheck.test.ts
// PURPOSE: The contextual pivot tabs follow the SHEET, not only the cell's
//          coordinates. Found live 2026-09-29 (e2e fixall-pivot CTX):
//          `handleSelectionChange` skips the cell it checked last, keyed on row
//          and column alone, so coming back to B2 on a pivot's sheet from B2 on
//          another sheet asked nothing -- the Pivot Table tab did not show for
//          the pivot under the active cell. The extension now re-derives once
//          the new sheet's regions are cached (recheckSelectionAfterSheetChange).

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const h = vi.hoisted(() => ({
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  snapshot: null as null | { selection: { endRow: number; endCol: number } },
}));

vi.mock("@api", () => ({
  openTaskPane: vi.fn(),
  closeTaskPane: vi.fn(),
  getTaskPaneManuallyClosed: () => [] as string[],
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: (...a: unknown[]) => h.registerPanel(...a),
  unregisterPanel: (...a: unknown[]) => h.unregisterPanel(...a),
  emitAppEvent: vi.fn(),
}));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => h.snapshot }));
vi.mock("@api/pivot", () => ({ pivot: { getAtCell: vi.fn(async () => null) } }));
vi.mock("../../manifest", () => ({
  PIVOT_PANE_ID: "pivot-pane",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));

import {
  updateCachedRegions,
  handleSelectionChange,
  getActivePivotId,
  recheckSelectionAfterSheetChange,
} from "../selectionHandler";
import type { PivotRegionData } from "../../types";

const PIVOT = { pivotId: "p1", name: "p1", startRow: 0, startCol: 0, endRow: 5, endCol: 3, isEmpty: false } as PivotRegionData;

/** Are the contextual tabs registered right now, per the calls made? */
function tabsShown(): boolean {
  const events = [
    ...h.registerPanel.mock.invocationCallOrder.map((n) => ({ n, on: true })),
    ...h.unregisterPanel.mock.invocationCallOrder.map((n) => ({ n, on: false })),
  ].sort((a, b) => a.n - b.n);
  return events.length > 0 ? events[events.length - 1].on : false;
}

beforeEach(() => {
  updateCachedRegions([]);
  vi.clearAllMocks();
  h.snapshot = null;
});

describe("the pivot tabs after a sheet switch", () => {
  it("B2 on a pivot's sheet, reached from B2 on a sheet with none, shows the tabs once the regions are cached", () => {
    // Sheet1: no pivot; the cursor sits at B2.
    handleSelectionChange({ endRow: 1, endCol: 1 });
    expect(tabsShown()).toBe(false);

    // The pivot's sheet: its regions arrive, the cursor is at B2 again.
    updateCachedRegions([PIVOT]);
    handleSelectionChange({ endRow: 1, endCol: 1 });
    expect(tabsShown(), "precondition: the same-cell skip alone asks nothing").toBe(false);

    h.snapshot = { selection: { endRow: 1, endCol: 1 } };
    recheckSelectionAfterSheetChange();
    expect(getActivePivotId()).toBe("p1");
    expect(tabsShown(), "the pivot under B2 on this sheet got no tab").toBe(true);
  });

  it("B2 on a sheet with no pivot, reached from the pivot's B2, closes the tabs", () => {
    updateCachedRegions([PIVOT]);
    handleSelectionChange({ endRow: 1, endCol: 1 });
    expect(tabsShown()).toBe(true);

    // Another sheet whose only region lies elsewhere; B2 again.
    updateCachedRegions([{ ...PIVOT, pivotId: "p2", startRow: 20, endRow: 25 }]);
    h.snapshot = { selection: { endRow: 1, endCol: 1 } };
    recheckSelectionAfterSheetChange();
    expect(getActivePivotId()).toBeNull();
    expect(tabsShown(), "the other sheet's pivot tab stayed up").toBe(false);
  });

  it("the SHEET_CHANGED handler re-derives AFTER the new sheet's regions are cached", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
    const at = src.indexOf("context.events.on(AppEvents.SHEET_CHANGED");
    expect(at, "the extension no longer listens for SHEET_CHANGED").toBeGreaterThan(0);
    const block = src.slice(at, at + 500);
    expect(block).toMatch(/refreshPivotRegions\([^)]*\)\.then\(\(\) => recheckSelectionAfterSheetChange\(\)\)/);
  });
});
