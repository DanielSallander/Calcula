//! FILENAME: app/extensions/Pivot/handlers/__tests__/activePivotReconciliation.test.ts
// PURPOSE: The pivot member of the BUG-0026 class — a contextual ribbon tab
//          that is a function of a cached id, on a workbook where the object
//          behind that id can be deleted by a backend cascade.
//
// WHAT WAS ALREADY RIGHT, AND WHAT WAS NOT. `updateCachedRegions` did close the
//          Analyze/Design tabs — but only when the sheet had NO pivot regions
//          left at all. That covers "delete the last pivot" and misses "delete
//          the one the user is inside while another survives", which is the
//          same shape BUG-0026 had on the slicer: the tab addresses a specific
//          object, so the question is whether THAT object still exists, not
//          whether any object does.
//
//          The miss is not theoretical. `handleSelectionChange` runs only when
//          the CURSOR moves and short-circuits on the cell it checked last, so
//          deleting the pivot under a stationary cursor changes neither the
//          cursor nor the cache — the tabs simply stay, with every button on
//          them addressing a pivot that is gone. Deleting the SHEET a pivot
//          lived on, or having an AI client delete it over MCP, reaches here
//          the same way: the `pivot` domain triggers `refreshPivotRegions`,
//          which emits PIVOT_REGIONS_UPDATED into this function.
//
// VACUITY, and the regression it guards. The obvious "fix" — close the tabs
//          whenever there is no active pivot — is WRONG, and the case below
//          that proves it is `a freshly created pivot keeps its tabs`:
//          `ensureDesignTabRegistered` turns them on from the create handler
//          BEFORE any selection has set an active id, so a naive condition
//          would unregister the tabs of the pivot the user just made.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRegisterPanel = vi.fn();
const mockUnregisterPanel = vi.fn();
const mockAddContextKey = vi.fn();
const mockRemoveContextKey = vi.fn();
const mockCloseTaskPane = vi.fn();

vi.mock("@api", () => ({
  openTaskPane: vi.fn(),
  closeTaskPane: (...a: unknown[]) => mockCloseTaskPane(...a),
  getTaskPaneManuallyClosed: () => [] as string[],
  addTaskPaneContextKey: (...a: unknown[]) => mockAddContextKey(...a),
  removeTaskPaneContextKey: (...a: unknown[]) => mockRemoveContextKey(...a),
  registerPanel: (...a: unknown[]) => mockRegisterPanel(...a),
  unregisterPanel: (...a: unknown[]) => mockUnregisterPanel(...a),
  emitAppEvent: vi.fn(),
}));

vi.mock("@api/pivot", () => ({
  pivot: { getAtCell: vi.fn(async () => null) },
}));

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
  ensureDesignTabRegistered,
  getActivePivotId,
} from "../selectionHandler";
import type { PivotRegionData } from "../../types";

function region(pivotId: string, startRow: number): PivotRegionData {
  return {
    pivotId,
    name: pivotId,
    startRow,
    startCol: 0,
    endRow: startRow + 5,
    endCol: 3,
    isEmpty: false,
  } as PivotRegionData;
}

/** Are the contextual tabs registered right now, per the calls made? */
function tabsAreRegistered(): boolean {
  const events = [
    ...mockRegisterPanel.mock.invocationCallOrder.map((n) => ({ n, on: true })),
    ...mockUnregisterPanel.mock.invocationCallOrder.map((n) => ({ n, on: false })),
  ].sort((a, b) => a.n - b.n);
  return events.length > 0 ? events[events.length - 1].on : false;
}

/**
 * Put the cursor inside a pivot, which is what sets the active id.
 * `handleSelectionChange` debounces its backend probe, but the branch under
 * test — set the active id, register the tabs — is synchronous.
 */
function selectInside(r: PivotRegionData): void {
  handleSelectionChange({ endRow: r.startRow + 1, endCol: r.startCol + 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Leave the module in a known state: no regions, nothing registered.
  updateCachedRegions([]);
  vi.clearAllMocks();
});

describe("the contextual pivot tabs follow the ACTIVE pivot, not the pivot count", () => {
  it("deleting the pivot the cursor is in closes the tabs while another survives", () => {
    const a = region("pivot-a", 0);
    const b = region("pivot-b", 20);
    updateCachedRegions([a, b]);
    selectInside(a);
    expect(getActivePivotId()).toBe("pivot-a");
    expect(tabsAreRegistered(), "precondition: the pivot tabs are showing").toBe(true);

    // The backend deleted pivot-a. The cursor has not moved.
    updateCachedRegions([b]);

    expect(getActivePivotId()).toBeNull();
    expect(tabsAreRegistered(), "the tabs outlived the pivot they address").toBe(false);
    expect(mockRemoveContextKey).toHaveBeenCalledWith("pivot");
    expect(mockCloseTaskPane).toHaveBeenCalledWith("pivot-pane");
  });

  it("a pivot that survives keeps its tabs when a DIFFERENT one is deleted", () => {
    const a = region("pivot-a", 0);
    const b = region("pivot-b", 20);
    updateCachedRegions([a, b]);
    selectInside(a);
    vi.clearAllMocks();

    updateCachedRegions([a]); // pivot-b went, the active one did not

    expect(getActivePivotId()).toBe("pivot-a");
    expect(mockUnregisterPanel).not.toHaveBeenCalled();
    expect(mockRemoveContextKey).not.toHaveBeenCalled();
  });

  it("the last pivot going still closes the tabs (the case that already worked)", () => {
    const a = region("pivot-a", 0);
    updateCachedRegions([a]);
    selectInside(a);
    expect(tabsAreRegistered()).toBe(true);

    updateCachedRegions([]);

    expect(tabsAreRegistered()).toBe(false);
  });

  it("a freshly created pivot keeps its tabs — the naive condition would kill them", () => {
    // THE REGRESSION GUARD. The create handler registers the tabs before any
    // selection exists, so `activePivotId` is null while the tabs are legitimately
    // on screen. Reconciling on "no active id" instead of "the active id is gone"
    // would unregister the tabs of the pivot the user just made.
    ensureDesignTabRegistered();
    expect(tabsAreRegistered()).toBe(true);
    expect(getActivePivotId()).toBeNull();

    updateCachedRegions([region("pivot-new", 0)]);

    expect(
      tabsAreRegistered(),
      "the just-created pivot's tabs were closed by the reconciliation",
    ).toBe(true);
  });
});
