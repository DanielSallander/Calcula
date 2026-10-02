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
import { objectOwnsKey, objectRefOf, resetObjectSelectionProviders } from "@api/objectSelection";
import {
  createPivotVisualSelectionProvider,
  registerPivotVisualSelection,
} from "../pivotVisualSelection";
import { PIVOT_VISUAL_REGION_TYPE } from "../pivotVisualRegions";
import { notePivotBoxMenuOpened, setPivotChromePressLive } from "../pivotVisualMenuState";

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

// BUG-0270 review: the generic object Delete (ObjectPosition
// lib/selectedObjectKeys.ts) now reaches a canvas pivot box -- it stands down
// only while a family owns Delete. The box's right-click menu takes no focus,
// so the grid keeps the keyboard while it is open: Delete there deleted the
// whole PivotTable BEHIND the menu. The menu and a held chrome press (a +/-, a
// filter button) own Delete exactly as they own Escape.
describe("ownsKey: the box's menu and a held chrome press own Escape AND Delete", () => {
  afterEach(() => setPivotChromePressLive(false));

  it("Delete and Escape are owned while the box's right-click menu is open, and not once it closed", () => {
    const p = createPivotVisualSelectionProvider();
    expect(p.ownsKey!("Delete"), "control: no menu").toBe(false);
    const release = notePivotBoxMenuOpened();
    try {
      expect(p.ownsKey!("Delete"), "Delete with the box's menu open deleted the PivotTable behind it").toBe(true);
      expect(p.ownsKey!("Escape")).toBe(true);
      expect(p.ownsKey!("Arrow"), "the arrows are not the menu's").toBe(false);
      expect(p.ownsKey!("Tab")).toBe(false);
    } finally {
      release();
    }
    expect(p.ownsKey!("Delete")).toBe(false);
    expect(p.ownsKey!("Escape")).toBe(false);
  });

  it("Delete is owned while a chrome press is held", () => {
    const p = createPivotVisualSelectionProvider();
    setPivotChromePressLive(true);
    expect(p.ownsKey!("Delete"), "Delete during a held +/- press deleted the PivotTable under it").toBe(true);
    setPivotChromePressLive(false);
    expect(p.ownsKey!("Delete")).toBe(false);
  });

  it("reaches objectOwnsKey through the seam -- the question the generic Delete asks", () => {
    const off = registerPivotVisualSelection();
    const release = notePivotBoxMenuOpened();
    try {
      expect(objectOwnsKey("Delete")).toBe(true);
    } finally {
      release();
      off();
    }
    expect(objectOwnsKey("Delete")).toBe(false);
  });
});
