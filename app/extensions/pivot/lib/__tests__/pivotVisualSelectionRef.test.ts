//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualSelectionRef.test.ts
// PURPOSE: A canvas pivot box's IDENTITY for the canvas layout (M8): the
//          object-selection provider names it `{ kind: "pivot", id: pivotId }`
//          -- the shape a canvas's zOrder stores, so the stacking resolver can
//          find the box's place in it.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@api", () => ({
  openTaskPane: vi.fn(),
  closeTaskPane: vi.fn(),
  getTaskPaneManuallyClosed: () => [],
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  emitAppEvent: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("@api/pivot", () => ({
  pivot: { getAtCell: vi.fn() },
}));

vi.mock("../../manifest", () => ({
  PIVOT_PANE_ID: "pivot-pane",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));

import type { GridRegion } from "@api/gridOverlays";
import { objectRefOf, resetObjectSelectionProviders } from "@api/objectSelection";
import {
  createPivotVisualSelectionProvider,
  registerPivotVisualSelection,
} from "../pivotVisualSelection";
import { PIVOT_VISUAL_REGION_TYPE } from "../pivotVisualRegions";

function region(pivotId: string, type = PIVOT_VISUAL_REGION_TYPE): GridRegion {
  return {
    id: `pivot-visual-${pivotId}`,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: 400, height: 300 },
    data: { pivotId, name: "PivotTable1" },
  };
}

afterEach(() => resetObjectSelectionProviders());

describe("refOf: a canvas pivot box's identity", () => {
  it("is { kind: 'pivot', id: pivotId }", () => {
    expect(createPivotVisualSelectionProvider().refOf?.(region("p-1"))).toEqual({ kind: "pivot", id: "p-1" });
  });

  it("is null for a region without a pivot id, or of another type", () => {
    const p = createPivotVisualSelectionProvider();
    expect(p.refOf?.({ ...region("p-1"), data: {} })).toBeNull();
    // A worksheet pivot's cell region is not a box: it has no canvas identity.
    expect(p.refOf?.(region("p-1", "pivot"))).toBeNull();
  });

  it("reaches objectRefOf through the seam", () => {
    const off = registerPivotVisualSelection();
    expect(objectRefOf(region("p-2"))).toEqual({ kind: "pivot", id: "p-2" });
    off();
    expect(objectRefOf(region("p-2"))).toBeNull();
  });
});

describe("the canvas selection set (M8)", () => {
  it("labelOf is the pivot's name; a worksheet pivot's cell region has none", () => {
    const p = createPivotVisualSelectionProvider();
    expect(p.labelOf!(region("p-1"))).toBe("PivotTable1");
    expect(p.labelOf!(region("p-1", "pivot"))).toBeNull();
    expect(p.labelOf!({ ...region("p-1"), data: { pivotId: "p-1" } })).toBeNull();
  });

  it("selectPivotVisual / deselectPivotVisual -- the box's chokepoints -- announce a CHANGE to the set", async () => {
    const { onObjectSelectionChanged } = await import("@api/objectSelection");
    const { selectPivotVisual, deselectPivotVisual, resetSelectionHandlerState } = await import(
      "../../handlers/selectionHandler"
    );
    resetSelectionHandlerState();
    const seen = vi.fn();
    const off = onObjectSelectionChanged(seen);
    selectPivotVisual("p-1", { openPane: false });
    expect(seen).toHaveBeenCalledTimes(1);
    selectPivotVisual("p-1", { openPane: false }); // already selected
    expect(seen).toHaveBeenCalledTimes(1);
    deselectPivotVisual();
    expect(seen).toHaveBeenCalledTimes(2);
    deselectPivotVisual(); // nothing selected
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    resetSelectionHandlerState();
  });
});
