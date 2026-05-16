//! FILENAME: app/extensions/Controls/lib/__tests__/controls-serialization.test.ts
// PURPOSE: Round-trip serialization tests for floating controls and groups.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies
vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  replaceGridRegionsByType: vi.fn(),
}));

vi.mock("../../designMode", () => ({
  getDesignMode: vi.fn(() => false),
}));

import {
  addFloatingControl,
  removeFloatingControl,
  getAllFloatingControls,
  getFloatingControl,
  resetFloatingStore,
  groupControls,
  getAllGroups,
  getGroupMembers,
  getGroupForControl,
  bringToFront,
  sendToBack,
  type FloatingControl,
  type ControlGroup,
} from "../floatingStore";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetFloatingStore();
});

/** Simulate a round-trip by serializing to JSON and rebuilding the store. */
function roundTripControls(): FloatingControl[] {
  const controls = getAllFloatingControls();
  const json = JSON.stringify(controls);
  const parsed = JSON.parse(json) as FloatingControl[];
  resetFloatingStore();
  for (const ctrl of parsed) {
    addFloatingControl(ctrl);
  }
  return getAllFloatingControls();
}

function makeControl(id: string, overrides?: Partial<FloatingControl>): FloatingControl {
  return {
    id,
    sheetIndex: 0,
    row: 0,
    col: 0,
    x: 100,
    y: 200,
    width: 80,
    height: 28,
    controlType: "button",
    ...overrides,
  };
}

// ============================================================================
// Single Control Round-Trip
// ============================================================================

describe("floating control serialization round-trip", () => {
  it("control with all properties survives round-trip", () => {
    const ctrl = makeControl("control-0-5-3", {
      sheetIndex: 2,
      row: 5,
      col: 3,
      x: 350.5,
      y: 420.75,
      width: 120,
      height: 40,
      controlType: "button",
    });
    addFloatingControl(ctrl);

    const result = roundTripControls();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(ctrl);
  });

  it("shape control survives round-trip", () => {
    const ctrl = makeControl("control-0-0-0", { controlType: "shape", width: 200, height: 150 });
    addFloatingControl(ctrl);
    const result = roundTripControls();
    expect(result[0].controlType).toBe("shape");
    expect(result[0].width).toBe(200);
  });

  it("image control survives round-trip", () => {
    const ctrl = makeControl("control-0-1-0", { controlType: "image", width: 300, height: 200 });
    addFloatingControl(ctrl);
    const result = roundTripControls();
    expect(result[0].controlType).toBe("image");
  });
});

// ============================================================================
// Group Serialization
// ============================================================================

describe("group serialization round-trip", () => {
  it("group with members serializes and can be restored", () => {
    const c1 = makeControl("ctrl-1", { x: 10, y: 10 });
    const c2 = makeControl("ctrl-2", { x: 50, y: 50 });
    const c3 = makeControl("ctrl-3", { x: 90, y: 90 });
    addFloatingControl(c1);
    addFloatingControl(c2);
    addFloatingControl(c3);

    const groupId = groupControls(["ctrl-1", "ctrl-2", "ctrl-3"]);

    // Serialize controls and groups
    const controlsJson = JSON.stringify(getAllFloatingControls());
    const groupsJson = JSON.stringify(getAllGroups());

    // Rebuild
    resetFloatingStore();
    const parsedControls = JSON.parse(controlsJson) as FloatingControl[];
    const parsedGroups = JSON.parse(groupsJson) as ControlGroup[];

    for (const ctrl of parsedControls) {
      addFloatingControl(ctrl);
    }
    for (const g of parsedGroups) {
      groupControls(g.memberIds);
    }

    expect(getAllFloatingControls()).toHaveLength(3);
    expect(getAllGroups()).toHaveLength(1);
    const restoredGroup = getAllGroups()[0];
    expect(restoredGroup.memberIds).toHaveLength(3);
    expect(restoredGroup.memberIds).toContain("ctrl-1");
    expect(restoredGroup.memberIds).toContain("ctrl-2");
    expect(restoredGroup.memberIds).toContain("ctrl-3");
  });

  it("group member data is preserved through serialization", () => {
    const c1 = makeControl("ctrl-a", { x: 10, y: 20, width: 100, height: 50 });
    const c2 = makeControl("ctrl-b", { x: 200, y: 300, width: 150, height: 75 });
    addFloatingControl(c1);
    addFloatingControl(c2);
    groupControls(["ctrl-a", "ctrl-b"]);

    const json = JSON.stringify(getAllFloatingControls());
    resetFloatingStore();
    const parsed = JSON.parse(json) as FloatingControl[];
    for (const ctrl of parsed) addFloatingControl(ctrl);

    const restored = getFloatingControl("ctrl-a");
    expect(restored).not.toBeNull();
    expect(restored!.x).toBe(10);
    expect(restored!.y).toBe(20);
    expect(restored!.width).toBe(100);
  });
});

// ============================================================================
// Z-Order Preservation
// ============================================================================

describe("z-order preservation through serialization", () => {
  it("insertion order is preserved after round-trip", () => {
    addFloatingControl(makeControl("a"));
    addFloatingControl(makeControl("b"));
    addFloatingControl(makeControl("c"));

    const result = roundTripControls();
    expect(result.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("bringToFront order is preserved after round-trip", () => {
    addFloatingControl(makeControl("a"));
    addFloatingControl(makeControl("b"));
    addFloatingControl(makeControl("c"));
    bringToFront("a"); // moves a to end

    const result = roundTripControls();
    expect(result.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("sendToBack order is preserved after round-trip", () => {
    addFloatingControl(makeControl("a"));
    addFloatingControl(makeControl("b"));
    addFloatingControl(makeControl("c"));
    sendToBack("c"); // moves c to start

    const result = roundTripControls();
    expect(result.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });
});

// ============================================================================
// Stress: 50 Controls
// ============================================================================

describe("large-scale controls round-trip", () => {
  it("50 controls round-trip without data loss", () => {
    for (let i = 0; i < 50; i++) {
      addFloatingControl(makeControl(`ctrl-${i}`, {
        sheetIndex: i % 3,
        row: i,
        col: i * 2,
        x: i * 10.5,
        y: i * 20.5,
        width: 50 + i,
        height: 25 + i,
        controlType: i % 2 === 0 ? "button" : "shape",
      }));
    }

    const before = JSON.stringify(getAllFloatingControls());
    const after = JSON.stringify(roundTripControls());
    expect(after).toBe(before);
    expect(getAllFloatingControls()).toHaveLength(50);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  it("empty store round-trips to empty", () => {
    const result = roundTripControls();
    expect(result).toHaveLength(0);
  });

  it("fractional coordinates are preserved", () => {
    addFloatingControl(makeControl("frac", { x: 0.123456789, y: 99.999, width: 80.5, height: 28.333 }));
    const result = roundTripControls();
    expect(result[0].x).toBe(0.123456789);
    expect(result[0].y).toBe(99.999);
    expect(result[0].width).toBe(80.5);
    expect(result[0].height).toBe(28.333);
  });
});
