//! FILENAME: app/extensions/Controls/lib/__tests__/controls-data-integrity.test.ts
// PURPOSE: Data integrity tests for floating controls store.

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

// Mock gridOverlays before importing the store
vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  replaceGridRegionsByType: vi.fn(),
}));

// Mock designMode
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
  type FloatingControl,
} from "../floatingStore";

function makeControl(id: string, sheet = 0, x = 0, y = 0, w = 100, h = 50): FloatingControl {
  return {
    id,
    sheetIndex: sheet,
    row: 0,
    col: 0,
    x,
    y,
    width: w,
    height: h,
    controlType: "button",
  };
}

beforeEach(() => {
  resetFloatingStore();
});

// ============================================================================
// Move/resize doesn't affect other controls
// ============================================================================

describe("move/resize isolation", () => {
  it("moving one control does not affect other controls", () => {
    addFloatingControl(makeControl("ctrl-1", 0, 10, 20));
    addFloatingControl(makeControl("ctrl-2", 0, 100, 200));

    const ctrl2Before = { ...getFloatingControl("ctrl-2")! };

    moveFloatingControl("ctrl-1", 500, 600);

    const ctrl2After = getFloatingControl("ctrl-2")!;
    expect(ctrl2After.x).toBe(ctrl2Before.x);
    expect(ctrl2After.y).toBe(ctrl2Before.y);
  });

  it("resizing one control does not affect other controls", () => {
    addFloatingControl(makeControl("ctrl-1", 0, 10, 20, 100, 50));
    addFloatingControl(makeControl("ctrl-2", 0, 200, 200, 150, 75));

    const ctrl2Before = { ...getFloatingControl("ctrl-2")! };

    resizeFloatingControl("ctrl-1", 10, 20, 300, 300);

    const ctrl2After = getFloatingControl("ctrl-2")!;
    expect(ctrl2After.x).toBe(ctrl2Before.x);
    expect(ctrl2After.y).toBe(ctrl2Before.y);
    expect(ctrl2After.width).toBe(ctrl2Before.width);
    expect(ctrl2After.height).toBe(ctrl2Before.height);
  });
});

// ============================================================================
// Group operations don't modify ungrouped controls
// ============================================================================

describe("group operations isolation", () => {
  it("grouping controls does not modify ungrouped controls", () => {
    addFloatingControl(makeControl("ctrl-1", 0, 10, 20));
    addFloatingControl(makeControl("ctrl-2", 0, 50, 60));
    addFloatingControl(makeControl("ctrl-3", 0, 100, 200));

    const ctrl3Before = { ...getFloatingControl("ctrl-3")! };

    groupControls(["ctrl-1", "ctrl-2"]);

    const ctrl3After = getFloatingControl("ctrl-3")!;
    expect(ctrl3After).toEqual(ctrl3Before);
    expect(getGroupForControl("ctrl-3")).toBeNull();
  });

  it("ungrouping does not modify the controls themselves", () => {
    addFloatingControl(makeControl("ctrl-1", 0, 10, 20));
    addFloatingControl(makeControl("ctrl-2", 0, 50, 60));

    const groupId = groupControls(["ctrl-1", "ctrl-2"]);

    const ctrl1Before = { ...getFloatingControl("ctrl-1")! };
    const ctrl2Before = { ...getFloatingControl("ctrl-2")! };

    ungroupControls(groupId);

    expect(getFloatingControl("ctrl-1")!.x).toBe(ctrl1Before.x);
    expect(getFloatingControl("ctrl-2")!.x).toBe(ctrl2Before.x);
  });
});

// ============================================================================
// Z-order operations preserve all controls (no items lost or duplicated)
// ============================================================================

describe("z-order preservation", () => {
  it("bringToFront preserves all controls without duplication", () => {
    addFloatingControl(makeControl("a"));
    addFloatingControl(makeControl("b"));
    addFloatingControl(makeControl("c"));
    addFloatingControl(makeControl("d"));

    bringToFront("a");

    const all = getAllFloatingControls();
    const ids = all.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(new Set(ids).size).toBe(4);
    // "a" should be last (highest z-order)
    expect(all[all.length - 1].id).toBe("a");
  });

  it("sendToBack preserves all controls without duplication", () => {
    addFloatingControl(makeControl("a"));
    addFloatingControl(makeControl("b"));
    addFloatingControl(makeControl("c"));

    sendToBack("c");

    const all = getAllFloatingControls();
    const ids = all.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
    expect(all[0].id).toBe("c");
  });

  it("bringForward preserves all controls without duplication", () => {
    addFloatingControl(makeControl("a"));
    addFloatingControl(makeControl("b"));
    addFloatingControl(makeControl("c"));

    bringForward("a");

    const all = getAllFloatingControls();
    const ids = all.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("sendBackward preserves all controls without duplication", () => {
    addFloatingControl(makeControl("a"));
    addFloatingControl(makeControl("b"));
    addFloatingControl(makeControl("c"));

    sendBackward("c");

    const all = getAllFloatingControls();
    const ids = all.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("repeated z-order operations don't lose or duplicate controls", () => {
    addFloatingControl(makeControl("a"));
    addFloatingControl(makeControl("b"));
    addFloatingControl(makeControl("c"));
    addFloatingControl(makeControl("d"));
    addFloatingControl(makeControl("e"));

    bringToFront("a");
    sendToBack("e");
    bringForward("b");
    sendBackward("d");
    bringToFront("c");
    sendToBack("a");

    const all = getAllFloatingControls();
    const ids = all.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c", "d", "e"]);
    expect(new Set(ids).size).toBe(5);
  });
});

// ============================================================================
// Sheet filtering returns copies, not references
// ============================================================================

describe("sheet filtering returns copies", () => {
  it("getFloatingControlsForSheet returns new array each call", () => {
    addFloatingControl(makeControl("ctrl-1", 0));
    addFloatingControl(makeControl("ctrl-2", 0));
    addFloatingControl(makeControl("ctrl-3", 1));

    const sheet0a = getFloatingControlsForSheet(0);
    const sheet0b = getFloatingControlsForSheet(0);

    expect(sheet0a).toEqual(sheet0b);
    expect(sheet0a).not.toBe(sheet0b);
    expect(sheet0a.length).toBe(2);
  });

  it("getAllFloatingControls returns a copy, not the internal array", () => {
    addFloatingControl(makeControl("ctrl-1"));
    addFloatingControl(makeControl("ctrl-2"));

    const all1 = getAllFloatingControls();
    const all2 = getAllFloatingControls();

    expect(all1).toEqual(all2);
    expect(all1).not.toBe(all2);

    // Mutating the returned array should not affect internal state
    all1.push(makeControl("ctrl-fake"));
    expect(getAllFloatingControls().length).toBe(2);
  });
});
