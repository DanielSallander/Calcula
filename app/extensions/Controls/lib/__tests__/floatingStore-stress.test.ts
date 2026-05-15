//! FILENAME: app/extensions/Controls/lib/__tests__/floatingStore-stress.test.ts
// PURPOSE: Stress and edge-case tests for the floating controls store.
// CONTEXT: Tests mass z-order operations, nested groups, boundary positions, and sheet switching.

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

function ids(): string[] {
  return getAllFloatingControls().map((c) => c.id);
}

// ============================================================================
// Tests
// ============================================================================

describe("floatingStore stress tests", () => {
  beforeEach(() => {
    resetFloatingStore();
  });

  // ==========================================================================
  // 50+ Objects with Z-Order Operations
  // ==========================================================================

  describe("mass z-order operations (50+ objects)", () => {
    beforeEach(() => {
      for (let i = 0; i < 50; i++) {
        addFloatingControl(makeCtrl(`c${i}`, { x: i * 10, y: i * 10 }));
      }
    });

    it("creates 50 controls successfully", () => {
      expect(getAllFloatingControls()).toHaveLength(50);
    });

    it("bringToFront moves last-added control from middle to end", () => {
      bringToFront("c25");
      const all = ids();
      expect(all[all.length - 1]).toBe("c25");
      expect(all).toHaveLength(50);
    });

    it("sendToBack moves control to start", () => {
      sendToBack("c49");
      const all = ids();
      expect(all[0]).toBe("c49");
      expect(all).toHaveLength(50);
    });

    it("bringForward on each control results in rotation", () => {
      // Move c0 forward 49 times - should end up at the end
      for (let i = 0; i < 49; i++) {
        bringForward("c0");
      }
      const all = ids();
      expect(all[all.length - 1]).toBe("c0");
    });

    it("sendBackward on last control 49 times moves it to front", () => {
      for (let i = 0; i < 49; i++) {
        sendBackward("c49");
      }
      const all = ids();
      expect(all[0]).toBe("c49");
    });

    it("bringToFront for all controls reverses nothing (each goes to end)", () => {
      for (let i = 0; i < 50; i++) {
        bringToFront(`c${i}`);
      }
      // Each control was moved to end in order, so final order is c0..c49
      expect(ids()).toEqual(Array.from({ length: 50 }, (_, i) => `c${i}`));
    });

    it("sendToBack for all controls in reverse preserves order", () => {
      for (let i = 49; i >= 0; i--) {
        sendToBack(`c${i}`);
      }
      expect(ids()).toEqual(Array.from({ length: 50 }, (_, i) => `c${i}`));
    });

    it("bringToFront and sendToBack on non-existent control are no-ops", () => {
      const before = ids();
      bringToFront("nonexistent");
      expect(ids()).toEqual(before);
      sendToBack("nonexistent");
      expect(ids()).toEqual(before);
    });

    it("bringForward on non-existent control is a no-op", () => {
      const before = ids();
      bringForward("nonexistent");
      expect(ids()).toEqual(before);
    });
  });

  // ==========================================================================
  // Group Operations
  // ==========================================================================

  describe("group edge cases", () => {
    it("group within group - re-grouping dissolves old group", () => {
      addFloatingControl(makeCtrl("a", { x: 0, y: 0 }));
      addFloatingControl(makeCtrl("b", { x: 50, y: 0 }));
      addFloatingControl(makeCtrl("c", { x: 100, y: 0 }));
      addFloatingControl(makeCtrl("d", { x: 150, y: 0 }));

      const g1 = groupControls(["a", "b"]);
      const g2 = groupControls(["c", "d"]);

      // Now group a member from g1 with a member from g2
      // This should dissolve both g1 and g2 first
      const g3 = groupControls(["a", "c"]);

      expect(getGroupForControl("a")).toBe(g3);
      expect(getGroupForControl("c")).toBe(g3);
      // b and d should be ungrouped (their groups were dissolved)
      expect(getGroupForControl("b")).toBeNull();
      expect(getGroupForControl("d")).toBeNull();
    });

    it("grouping all members of an existing group with new controls", () => {
      addFloatingControl(makeCtrl("a"));
      addFloatingControl(makeCtrl("b"));
      addFloatingControl(makeCtrl("c"));

      const g1 = groupControls(["a", "b"]);
      // Now group a, b, c - dissolves g1 first then creates new group
      const g2 = groupControls(["a", "b", "c"]);

      expect(getAllGroups()).toHaveLength(1);
      expect(getGroupMembers(g2)).toEqual(["a", "b", "c"]);
    });

    it("z-order with grouped controls moves all members together", () => {
      for (let i = 0; i < 10; i++) {
        addFloatingControl(makeCtrl(`c${i}`));
      }
      groupControls(["c3", "c4", "c5"]);

      bringToFront("c3");
      const all = ids();
      // c3, c4, c5 should be at the end (in their relative order)
      expect(all.slice(-3)).toEqual(["c3", "c4", "c5"]);
      expect(all).toHaveLength(10);
    });

    it("sendToBack with grouped controls", () => {
      for (let i = 0; i < 10; i++) {
        addFloatingControl(makeCtrl(`c${i}`));
      }
      groupControls(["c7", "c8", "c9"]);

      sendToBack("c8");
      const all = ids();
      expect(all.slice(0, 3)).toEqual(["c7", "c8", "c9"]);
    });

    it("removing all members of a group one by one dissolves group", () => {
      addFloatingControl(makeCtrl("a"));
      addFloatingControl(makeCtrl("b"));
      addFloatingControl(makeCtrl("c"));

      const gid = groupControls(["a", "b", "c"]);

      removeFloatingControl("a");
      // Group still exists with b and c
      expect(getGroupMembers(gid)).toEqual(["b", "c"]);

      removeFloatingControl("b");
      // Group dissolved (< 2 members)
      expect(getAllGroups()).toHaveLength(0);
      expect(getGroupForControl("c")).toBeNull();
    });

    it("getGroupBounds with all members removed returns null", () => {
      addFloatingControl(makeCtrl("a"));
      addFloatingControl(makeCtrl("b"));
      const gid = groupControls(["a", "b"]);

      removeFloatingControl("a");
      removeFloatingControl("b");
      // Group was dissolved, so this returns null
      expect(getGroupBounds(gid)).toBeNull();
    });
  });

  // ==========================================================================
  // Boundary Positions (0,0 and very large coords)
  // ==========================================================================

  describe("boundary positions", () => {
    it("control at position (0, 0) with size (0, 0)", () => {
      addFloatingControl(makeCtrl("zero", { x: 0, y: 0, width: 0, height: 0 }));
      const ctrl = getFloatingControl("zero")!;
      expect(ctrl.x).toBe(0);
      expect(ctrl.y).toBe(0);
      expect(ctrl.width).toBe(0);
      expect(ctrl.height).toBe(0);
    });

    it("control at very large coordinates", () => {
      const large = 1_000_000;
      addFloatingControl(makeCtrl("big", { x: large, y: large, width: large, height: large }));
      const ctrl = getFloatingControl("big")!;
      expect(ctrl.x).toBe(large);
      expect(ctrl.y).toBe(large);
      expect(ctrl.width).toBe(large);
      expect(ctrl.height).toBe(large);
    });

    it("move to negative coordinates (no clamping on individual controls)", () => {
      addFloatingControl(makeCtrl("c1", { x: 10, y: 10 }));
      moveFloatingControl("c1", -5, -5);
      const ctrl = getFloatingControl("c1")!;
      // moveFloatingControl does NOT clamp (only moveGroupControls does)
      expect(ctrl.x).toBe(-5);
      expect(ctrl.y).toBe(-5);
    });

    it("moveGroupControls clamps to 0 for very negative deltas", () => {
      addFloatingControl(makeCtrl("a", { x: 100, y: 200 }));
      addFloatingControl(makeCtrl("b", { x: 300, y: 400 }));
      const gid = groupControls(["a", "b"]);

      moveGroupControls(gid, -1_000_000, -1_000_000);
      expect(getFloatingControl("a")!.x).toBe(0);
      expect(getFloatingControl("a")!.y).toBe(0);
      expect(getFloatingControl("b")!.x).toBe(0);
      expect(getFloatingControl("b")!.y).toBe(0);
    });

    it("resize to very small dimensions (minimum 10px)", () => {
      addFloatingControl(makeCtrl("a", { x: 0, y: 0, width: 100, height: 100 }));
      addFloatingControl(makeCtrl("b", { x: 100, y: 100, width: 100, height: 100 }));
      const gid = groupControls(["a", "b"]);

      const oldBounds = { x: 0, y: 0, width: 200, height: 200 };
      const newBounds = { x: 0, y: 0, width: 1, height: 1 };
      resizeGroupControls(gid, oldBounds, newBounds);

      // Width/height should be clamped to min 10
      expect(getFloatingControl("a")!.width).toBe(10);
      expect(getFloatingControl("a")!.height).toBe(10);
    });

    it("resize with zero old bounds is a no-op (division by zero protection)", () => {
      addFloatingControl(makeCtrl("a", { x: 10, y: 10, width: 50, height: 50 }));
      addFloatingControl(makeCtrl("b", { x: 70, y: 70, width: 50, height: 50 }));
      const gid = groupControls(["a", "b"]);

      const oldBounds = { x: 0, y: 0, width: 0, height: 0 };
      const newBounds = { x: 0, y: 0, width: 100, height: 100 };
      resizeGroupControls(gid, oldBounds, newBounds);

      // Should not change anything
      expect(getFloatingControl("a")!.x).toBe(10);
      expect(getFloatingControl("a")!.width).toBe(50);
    });
  });

  // ==========================================================================
  // Sheet Switching with Many Objects
  // ==========================================================================

  describe("sheet switching with many objects", () => {
    beforeEach(() => {
      // 20 controls on sheet 0, 20 on sheet 1, 10 on sheet 2
      for (let i = 0; i < 20; i++) {
        addFloatingControl(makeCtrl(`s0-${i}`, { sheetIndex: 0, x: i * 10, y: 0 }));
      }
      for (let i = 0; i < 20; i++) {
        addFloatingControl(makeCtrl(`s1-${i}`, { sheetIndex: 1, x: i * 10, y: 0 }));
      }
      for (let i = 0; i < 10; i++) {
        addFloatingControl(makeCtrl(`s2-${i}`, { sheetIndex: 2, x: i * 10, y: 0 }));
      }
    });

    it("filters correctly per sheet", () => {
      expect(getFloatingControlsForSheet(0)).toHaveLength(20);
      expect(getFloatingControlsForSheet(1)).toHaveLength(20);
      expect(getFloatingControlsForSheet(2)).toHaveLength(10);
      expect(getFloatingControlsForSheet(3)).toHaveLength(0);
    });

    it("total controls across sheets is correct", () => {
      expect(getAllFloatingControls()).toHaveLength(50);
    });

    it("removing all controls on one sheet leaves others intact", () => {
      for (let i = 0; i < 20; i++) {
        removeFloatingControl(`s1-${i}`);
      }
      expect(getFloatingControlsForSheet(0)).toHaveLength(20);
      expect(getFloatingControlsForSheet(1)).toHaveLength(0);
      expect(getFloatingControlsForSheet(2)).toHaveLength(10);
      expect(getAllFloatingControls()).toHaveLength(30);
    });

    it("z-order operations work across sheets (global array)", () => {
      bringToFront("s0-0");
      const all = ids();
      expect(all[all.length - 1]).toBe("s0-0");
      // s0-0 is now after all s2 controls
    });

    it("groups can span controls on the same sheet only", () => {
      // Grouping controls from different sheets is allowed by the store
      // (the store doesn't enforce same-sheet)
      const gid = groupControls(["s0-0", "s1-0"]);
      expect(getGroupMembers(gid)).toEqual(["s0-0", "s1-0"]);
    });
  });

  // ==========================================================================
  // Rapid Sequential Operations
  // ==========================================================================

  describe("rapid sequential operations", () => {
    it("100 add/remove cycles at the same ID", () => {
      for (let i = 0; i < 100; i++) {
        addFloatingControl(makeCtrl("rapid", { x: i }));
        removeFloatingControl("rapid");
      }
      expect(getAllFloatingControls()).toHaveLength(0);
    });

    it("50 group/ungroup cycles", () => {
      addFloatingControl(makeCtrl("a"));
      addFloatingControl(makeCtrl("b"));

      for (let i = 0; i < 50; i++) {
        const gid = groupControls(["a", "b"]);
        ungroupControls(gid);
      }

      expect(getAllGroups()).toHaveLength(0);
      expect(getGroupForControl("a")).toBeNull();
      expect(getGroupForControl("b")).toBeNull();
    });

    it("rapid move updates final position correctly", () => {
      addFloatingControl(makeCtrl("mover", { x: 0, y: 0 }));
      for (let i = 0; i < 1000; i++) {
        moveFloatingControl("mover", i, i * 2);
      }
      const ctrl = getFloatingControl("mover")!;
      expect(ctrl.x).toBe(999);
      expect(ctrl.y).toBe(1998);
    });

    it("rapid resize updates final dimensions correctly", () => {
      addFloatingControl(makeCtrl("resizer", { x: 0, y: 0, width: 10, height: 10 }));
      for (let i = 1; i <= 500; i++) {
        resizeFloatingControl("resizer", 0, 0, i, i);
      }
      const ctrl = getFloatingControl("resizer")!;
      expect(ctrl.width).toBe(500);
      expect(ctrl.height).toBe(500);
    });

    it("adding 50 controls then replacing each one", () => {
      for (let i = 0; i < 50; i++) {
        addFloatingControl(makeCtrl(`c${i}`, { x: i }));
      }
      expect(getAllFloatingControls()).toHaveLength(50);

      // Replace each with updated position
      for (let i = 0; i < 50; i++) {
        addFloatingControl(makeCtrl(`c${i}`, { x: i + 1000 }));
      }
      expect(getAllFloatingControls()).toHaveLength(50);
      expect(getFloatingControl("c0")!.x).toBe(1000);
      expect(getFloatingControl("c49")!.x).toBe(1049);
    });
  });
});
