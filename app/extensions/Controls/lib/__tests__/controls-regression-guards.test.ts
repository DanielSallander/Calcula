//! FILENAME: app/extensions/Controls/lib/__tests__/controls-regression-guards.test.ts
// PURPOSE: Regression guards for floating controls store edge cases.
// CONTEXT: Documents known bugs with z-order, grouping, and resize boundary handling.

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
  resetFloatingStore,
  sendBackward,
  bringForward,
  getAllFloatingControls,
  groupControls,
  ungroupControls,
  getGroupForControl,
  resizeFloatingControl,
  getFloatingControl,
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

describe("REGRESSION: Controls store edge cases", () => {
  beforeEach(() => {
    resetFloatingStore();
  });

  // --------------------------------------------------------------------------
  // Guard: sendBackward with non-existent ID
  // --------------------------------------------------------------------------

  describe("sendBackward with non-existent ID", () => {
    it("does not throw when ID does not exist", () => {
      addFloatingControl(makeCtrl("c1"));
      addFloatingControl(makeCtrl("c2"));
      expect(() => sendBackward("nonexistent")).not.toThrow();
    });

    it("KNOWN BUG: sendBackward with non-existent ID swaps last two controls", () => {
      // This documents a bug: getZOrderIds for a non-existent ID returns [id],
      // the Set lookup fails to find minIdx, so minIdx stays at length,
      // but the splice logic still runs and corrupts the array.
      addFloatingControl(makeCtrl("c1"));
      addFloatingControl(makeCtrl("c2"));
      const before = getAllFloatingControls().map((c) => c.id);
      sendBackward("nonexistent");
      const after = getAllFloatingControls().map((c) => c.id);
      // Currently the order gets corrupted - document this as a known bug.
      // When this assertion changes, the bug has been fixed.
      expect(after).not.toEqual(before);
    });
  });

  // --------------------------------------------------------------------------
  // Guard: group dissolve restores individual z-order
  // --------------------------------------------------------------------------

  describe("group dissolve restores z-order", () => {
    it("ungrouping preserves relative z-order of members", () => {
      addFloatingControl(makeCtrl("c1"));
      addFloatingControl(makeCtrl("c2"));
      addFloatingControl(makeCtrl("c3"));

      const groupId = groupControls(["c1", "c2"]);
      expect(getGroupForControl("c1")).toBe(groupId);
      expect(getGroupForControl("c2")).toBe(groupId);

      // Dissolve the group
      const members = ungroupControls(groupId);
      expect(members).toContain("c1");
      expect(members).toContain("c2");

      // After ungrouping, controls should still exist and be independent
      expect(getGroupForControl("c1")).toBeNull();
      expect(getGroupForControl("c2")).toBeNull();

      // All three controls should still be in the store
      const all = getAllFloatingControls();
      expect(all.length).toBe(3);
    });

    it("ungrouping a non-existent group returns empty array", () => {
      const result = ungroupControls("no-such-group");
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Guard: resize to 0 width/height enforces minimum
  // --------------------------------------------------------------------------

  describe("resize to zero or negative dimensions", () => {
    it("resize to width=0 is accepted (no minimum enforced at store level)", () => {
      // Document current behavior: the store does NOT enforce minimums.
      // This is a known gap - the UI layer should prevent this.
      addFloatingControl(makeCtrl("c1", { width: 80, height: 28 }));
      resizeFloatingControl("c1", 0, 0, 0, 0);
      const ctrl = getFloatingControl("c1");
      expect(ctrl).not.toBeNull();
      // Document the actual behavior: store allows 0 dimensions
      expect(ctrl!.width).toBe(0);
      expect(ctrl!.height).toBe(0);
    });

    it("resize to negative dimensions is accepted at store level", () => {
      // Document: store does not validate. UI must prevent negative sizes.
      addFloatingControl(makeCtrl("c1", { width: 80, height: 28 }));
      resizeFloatingControl("c1", 0, 0, -10, -10);
      const ctrl = getFloatingControl("c1");
      expect(ctrl!.width).toBe(-10);
      expect(ctrl!.height).toBe(-10);
    });

    it("resize non-existent control is a no-op", () => {
      resizeFloatingControl("nonexistent", 0, 0, 50, 50);
      // Should not throw, just do nothing
      expect(getFloatingControl("nonexistent")).toBeNull();
    });
  });
});
