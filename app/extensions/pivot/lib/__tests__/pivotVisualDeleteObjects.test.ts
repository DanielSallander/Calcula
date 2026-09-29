//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualDeleteObjects.test.ts
// PURPOSE: A4 (wave B). The canvas pivot box's object-selection provider had no
//          `deleteObjects`, so a canvas multi-selection Delete kept the boxes
//          and named them. It now deletes them the way the pivot's own menu
//          does -- resolving once the deletes landed, REJECTING with the
//          backend's reason on a refusal (the seam contract) -- and repaints.

import { describe, it, expect, vi } from "vitest";

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
vi.mock("@api/pivot", () => ({ pivot: { getAtCell: vi.fn() } }));
vi.mock("../../manifest", () => ({
  PIVOT_PANE_ID: "pivot-pane",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));

import type { GridRegion } from "@api/gridOverlays";
import { createPivotVisualSelectionProvider } from "../pivotVisualSelection";
import { PIVOT_VISUAL_REGION_TYPE } from "../pivotVisualRegions";

function region(pivotId: string): GridRegion {
  return {
    id: `pivot-visual-${pivotId}`,
    type: PIVOT_VISUAL_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: 400, height: 300 },
    data: { pivotId, name: "PivotTable1" },
  };
}

describe("the pivot box provider's deleteObjects", () => {
  it("deletes every box it is handed through the pivot's own delete, then repaints", async () => {
    const deleted: string[] = [];
    const provider = createPivotVisualSelectionProvider({
      deletePivot: async (id) => {
        deleted.push(id);
      },
    });
    const refreshed = vi.fn();
    window.addEventListener("pivot:refresh", refreshed);
    try {
      expect(provider.deleteObjects, "the pivot box family cannot take part in a canvas-wide Delete").toBeTypeOf("function");
      await provider.deleteObjects!([region("p1"), region("p2")]);
    } finally {
      window.removeEventListener("pivot:refresh", refreshed);
    }
    expect(deleted).toEqual(["p1", "p2"]);
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it("the extension registers the provider WITH the pivot's delete (the overlay wiring)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../pivotVisualOverlay.ts"), "utf8");
    expect(src).toMatch(/registerPivotVisualSelection\(\{\s*[\s\S]*?deletePivot:/);
    expect(src).toMatch(/deletePivot: async \(pivotId\) => \{\s*await deletePivotTable\(pivotId\);/);
  });

  it("REJECTS with the backend's reason when a delete is refused (the others still go)", async () => {
    const deleted: string[] = [];
    const provider = createPivotVisualSelectionProvider({
      deletePivot: async (id) => {
        if (id === "p2") throw new Error("Sheet is protected.");
        deleted.push(id);
      },
    });
    await expect(provider.deleteObjects!([region("p1"), region("p2")])).rejects.toThrow("Sheet is protected.");
    expect(deleted).toEqual(["p1"]);
  });
});
