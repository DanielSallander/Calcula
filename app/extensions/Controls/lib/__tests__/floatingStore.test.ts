//! FILENAME: app/extensions/Controls/lib/__tests__/floatingStore.test.ts
// PURPOSE: Tests for the floating controls store (CRUD, z-order, grouping).

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies
vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  replaceGridRegionsByType: vi.fn(),
}));

vi.mock("../designMode", () => ({
  getDesignMode: vi.fn(() => false),
}));

import {
  makeFloatingControlId,
  addFloatingControl,
  removeFloatingControl,
  getFloatingControl,
  getAllFloatingControls,
  getFloatingControlsForSheet,
  moveFloatingControl,
  resizeFloatingControl,
  resetFloatingStore,
  bringToFront,
  sendToBack,
  bringForward,
  sendBackward,
  groupControls,
  ungroupControls,
  getGroupForControl,
  getGroupMembers,
  getGroupBounds,
  moveGroupControls,
  resizeGroupControls,
  getAllGroups,
  type FloatingControl,
} from "../floatingStore";

// ============================================================================
// Helpers
// ============================================================================

function makeCtrl(id: string, opts?: Partial<FloatingControl>): FloatingControl {
  return {
    id,
    sheetIndex: 0,
    row: 0,
    col: 0,
    x: 0,
    y: 0,
    width: 80,
    height: 28,
    controlType: "button",
    ...opts,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("floatingStore", () => {
  beforeEach(() => {
    resetFloatingStore();
  });

  describe("makeFloatingControlId", () => {
    it("generates expected format", () => {
      expect(makeFloatingControlId(0, 5, 3)).toBe("control-0-5-3");
      expect(makeFloatingControlId(2, 0, 0)).toBe("control-2-0-0");
    });
  });

  describe("CRUD operations", () => {
    it("adds and retrieves a control", () => {
      addFloatingControl(makeCtrl("c1", { x: 10, y: 20 }));
      const ctrl = getFloatingControl("c1");
      expect(ctrl).not.toBeNull();
      expect(ctrl!.x).toBe(10);
      expect(ctrl!.y).toBe(20);
    });

    it("returns null for non-existent control", () => {
      expect(getFloatingControl("nope")).toBeNull();
    });

    it("replaces control with same id", () => {
      addFloatingControl(makeCtrl("c1", { x: 10 }));
      addFloatingControl(makeCtrl("c1", { x: 99 }));
      expect(getAllFloatingControls()).toHaveLength(1);
      expect(getFloatingControl("c1")!.x).toBe(99);
    });

    it("removes a control", () => {
      addFloatingControl(makeCtrl("c1"));
      removeFloatingControl("c1");
      expect(getFloatingControl("c1")).toBeNull();
      expect(getAllFloatingControls()).toHaveLength(0);
    });

    it("removing non-existent control is a no-op", () => {
      addFloatingControl(makeCtrl("c1"));
      removeFloatingControl("c999");
      expect(getAllFloatingControls()).toHaveLength(1);
    });
  });

  describe("getFloatingControlsForSheet", () => {
    it("filters by sheet index", () => {
      addFloatingControl(makeCtrl("c1", { sheetIndex: 0 }));
      addFloatingControl(makeCtrl("c2", { sheetIndex: 1 }));
      addFloatingControl(makeCtrl("c3", { sheetIndex: 0 }));

      expect(getFloatingControlsForSheet(0)).toHaveLength(2);
      expect(getFloatingControlsForSheet(1)).toHaveLength(1);
      expect(getFloatingControlsForSheet(5)).toHaveLength(0);
    });
  });

  describe("move and resize", () => {
    it("moves a control", () => {
      addFloatingControl(makeCtrl("c1", { x: 0, y: 0 }));
      moveFloatingControl("c1", 50, 75);
      expect(getFloatingControl("c1")!.x).toBe(50);
      expect(getFloatingControl("c1")!.y).toBe(75);
    });

    it("moving non-existent control is a no-op", () => {
      moveFloatingControl("nope", 50, 75);
      // no error
    });

    it("resizes a control", () => {
      addFloatingControl(makeCtrl("c1", { x: 0, y: 0, width: 80, height: 28 }));
      resizeFloatingControl("c1", 10, 20, 200, 100);
      const ctrl = getFloatingControl("c1")!;
      expect(ctrl.x).toBe(10);
      expect(ctrl.y).toBe(20);
      expect(ctrl.width).toBe(200);
      expect(ctrl.height).toBe(100);
    });
  });

  describe("z-order", () => {
    beforeEach(() => {
      addFloatingControl(makeCtrl("a"));
      addFloatingControl(makeCtrl("b"));
      addFloatingControl(makeCtrl("c"));
    });

    function ids(): string[] {
      return getAllFloatingControls().map((c) => c.id);
    }

    it("bringToFront moves control to end", () => {
      bringToFront("a");
      expect(ids()).toEqual(["b", "c", "a"]);
    });

    it("sendToBack moves control to start", () => {
      sendToBack("c");
      expect(ids()).toEqual(["c", "a", "b"]);
    });

    it("bringForward moves one step up", () => {
      bringForward("a");
      expect(ids()).toEqual(["b", "a", "c"]);
    });

    it("bringForward at top is a no-op", () => {
      bringForward("c");
      expect(ids()).toEqual(["a", "b", "c"]);
    });

    it("sendBackward moves one step down", () => {
      sendBackward("c");
      expect(ids()).toEqual(["a", "c", "b"]);
    });

    it("sendBackward at bottom is a no-op", () => {
      sendBackward("a");
      expect(ids()).toEqual(["a", "b", "c"]);
    });
  });

  describe("grouping", () => {
    beforeEach(() => {
      addFloatingControl(makeCtrl("c1", { x: 10, y: 10, width: 50, height: 30 }));
      addFloatingControl(makeCtrl("c2", { x: 100, y: 100, width: 50, height: 30 }));
      addFloatingControl(makeCtrl("c3", { x: 200, y: 200, width: 50, height: 30 }));
    });

    it("creates a group of 2+ controls", () => {
      const gid = groupControls(["c1", "c2"]);
      expect(gid).toMatch(/^group-/);
      expect(getGroupForControl("c1")).toBe(gid);
      expect(getGroupForControl("c2")).toBe(gid);
      expect(getGroupMembers(gid)).toEqual(["c1", "c2"]);
    });

    it("throws when grouping fewer than 2 controls", () => {
      expect(() => groupControls(["c1"])).toThrow("Cannot group fewer than 2");
      expect(() => groupControls([])).toThrow();
    });

    it("ungrouping dissolves the group", () => {
      const gid = groupControls(["c1", "c2"]);
      const members = ungroupControls(gid);
      expect(members).toEqual(["c1", "c2"]);
      expect(getGroupForControl("c1")).toBeNull();
      expect(getGroupForControl("c2")).toBeNull();
      expect(getAllGroups()).toHaveLength(0);
    });

    it("ungrouping non-existent group returns empty", () => {
      expect(ungroupControls("no-such-group")).toEqual([]);
    });

    it("re-grouping removes from old group first", () => {
      const g1 = groupControls(["c1", "c2"]);
      const g2 = groupControls(["c2", "c3"]);
      // c2 moved to g2, g1 dissolved (< 2 members)
      expect(getGroupForControl("c1")).toBeNull();
      expect(getGroupForControl("c2")).toBe(g2);
      expect(getGroupForControl("c3")).toBe(g2);
    });

    it("removing a grouped control dissolves group if < 2 remain", () => {
      groupControls(["c1", "c2"]);
      removeFloatingControl("c1");
      expect(getGroupForControl("c2")).toBeNull();
      expect(getAllGroups()).toHaveLength(0);
    });

    it("getGroupBounds computes bounding box", () => {
      const gid = groupControls(["c1", "c2"]);
      const bounds = getGroupBounds(gid);
      expect(bounds).toEqual({
        x: 10,
        y: 10,
        width: 140, // 100+50 - 10
        height: 120, // 100+30 - 10
      });
    });

    it("getGroupBounds returns null for empty/missing group", () => {
      expect(getGroupBounds("nope")).toBeNull();
    });

    it("moveGroupControls moves all members by delta", () => {
      const gid = groupControls(["c1", "c2"]);
      moveGroupControls(gid, 5, 10);
      expect(getFloatingControl("c1")!.x).toBe(15);
      expect(getFloatingControl("c1")!.y).toBe(20);
      expect(getFloatingControl("c2")!.x).toBe(105);
      expect(getFloatingControl("c2")!.y).toBe(110);
    });

    it("moveGroupControls clamps to 0", () => {
      const gid = groupControls(["c1", "c2"]);
      moveGroupControls(gid, -999, -999);
      expect(getFloatingControl("c1")!.x).toBe(0);
      expect(getFloatingControl("c1")!.y).toBe(0);
    });

    it("resizeGroupControls scales proportionally", () => {
      const gid = groupControls(["c1", "c2"]);
      const oldBounds = { x: 10, y: 10, width: 140, height: 120 };
      const newBounds = { x: 10, y: 10, width: 280, height: 240 };
      resizeGroupControls(gid, oldBounds, newBounds);
      // c1 was at relative (0,0) -> stays at (10,10), width doubles
      expect(getFloatingControl("c1")!.x).toBe(10);
      expect(getFloatingControl("c1")!.width).toBe(100);
      // c2 was at relative (90, 90) -> (10 + 90*2, 10 + 90*2)
      expect(getFloatingControl("c2")!.x).toBe(190);
    });

    it("z-order with groups moves all group members", () => {
      addFloatingControl(makeCtrl("solo"));
      const gid = groupControls(["c1", "c2"]);
      // Order: c1, c2, c3, solo
      bringToFront("c1");
      const ids = getAllFloatingControls().map((c) => c.id);
      // c1 and c2 (group) moved to end
      expect(ids[ids.length - 1]).toBe("c2");
      expect(ids[ids.length - 2]).toBe("c1");
    });
  });

  describe("resetFloatingStore", () => {
    it("clears all controls and groups", () => {
      addFloatingControl(makeCtrl("c1"));
      addFloatingControl(makeCtrl("c2"));
      groupControls(["c1", "c2"]);

      resetFloatingStore();

      expect(getAllFloatingControls()).toHaveLength(0);
      expect(getAllGroups()).toHaveLength(0);
    });
  });
});
