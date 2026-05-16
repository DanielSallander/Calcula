//! FILENAME: app/extensions/Controls/lib/__tests__/controls-lifecycle.test.ts
// PURPOSE: Detect memory leaks in controls store lifecycle patterns.
// CONTEXT: Verifies add/remove cycles, group/ungroup cleanup, and sheet-scoped removal.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies (same pattern as floatingStore.test.ts)
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
  resetFloatingStore,
  groupControls,
  ungroupControls,
  getAllGroups,
  getGroupForControl,
  getGroupMembers,
  makeFloatingControlId,
  type FloatingControl,
} from "../floatingStore";

// ============================================================================
// Helpers
// ============================================================================

function makeControl(
  sheetIndex: number,
  row: number,
  col: number,
  overrides?: Partial<FloatingControl>,
): FloatingControl {
  return {
    id: makeFloatingControlId(sheetIndex, row, col),
    sheetIndex,
    row,
    col,
    x: col * 100,
    y: row * 24,
    width: 80,
    height: 24,
    controlType: "button",
    ...overrides,
  };
}

// ============================================================================
// Add/Remove Lifecycle
// ============================================================================

describe("Controls add/remove lifecycle", () => {
  beforeEach(() => {
    resetFloatingStore();
  });

  it("add then remove 500 controls leaves store empty", () => {
    const ids: string[] = [];

    for (let i = 0; i < 500; i++) {
      const ctrl = makeControl(0, i, 0);
      addFloatingControl(ctrl);
      ids.push(ctrl.id);
    }

    expect(getAllFloatingControls().length).toBe(500);

    for (const id of ids) {
      removeFloatingControl(id);
    }

    expect(getAllFloatingControls().length).toBe(0);
  });

  it("removing non-existent control is safe", () => {
    addFloatingControl(makeControl(0, 0, 0));
    removeFloatingControl("nonexistent-id");
    expect(getAllFloatingControls().length).toBe(1);
    resetFloatingStore();
  });

  it("rapid add/remove cycles do not leak", () => {
    for (let cycle = 0; cycle < 200; cycle++) {
      const ctrl = makeControl(0, 0, 0);
      addFloatingControl(ctrl);
      removeFloatingControl(ctrl.id);
    }

    expect(getAllFloatingControls().length).toBe(0);
  });

  it("re-adding same ID replaces existing control", () => {
    const ctrl1 = makeControl(0, 0, 0, { width: 100 });
    const ctrl2 = makeControl(0, 0, 0, { width: 200 });

    addFloatingControl(ctrl1);
    addFloatingControl(ctrl2);

    const all = getAllFloatingControls();
    expect(all.length).toBe(1);
    expect(all[0].width).toBe(200);

    resetFloatingStore();
  });
});

// ============================================================================
// Group/Ungroup/Delete Lifecycle
// ============================================================================

describe("Controls group/ungroup/delete lifecycle", () => {
  beforeEach(() => {
    resetFloatingStore();
  });

  it("group then ungroup then delete 100 controls leaves no residual state", () => {
    // Create 200 controls in pairs for grouping
    const controlIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const ctrl = makeControl(0, i, 0);
      addFloatingControl(ctrl);
      controlIds.push(ctrl.id);
    }

    // Group pairs (100 groups of 2)
    const groupIds: string[] = [];
    for (let i = 0; i < 200; i += 2) {
      const gid = groupControls([controlIds[i], controlIds[i + 1]]);
      groupIds.push(gid);
    }

    expect(getAllGroups().length).toBe(100);

    // Ungroup all
    for (const gid of groupIds) {
      ungroupControls(gid);
    }

    expect(getAllGroups().length).toBe(0);

    // Verify no control has a group reference
    for (const id of controlIds) {
      expect(getGroupForControl(id)).toBeNull();
    }

    // Delete all controls
    for (const id of controlIds) {
      removeFloatingControl(id);
    }

    expect(getAllFloatingControls().length).toBe(0);
  });

  it("deleting a grouped control auto-dissolves group when < 2 members", () => {
    const ctrl1 = makeControl(0, 0, 0);
    const ctrl2 = makeControl(0, 1, 0);
    addFloatingControl(ctrl1);
    addFloatingControl(ctrl2);

    const gid = groupControls([ctrl1.id, ctrl2.id]);
    expect(getAllGroups().length).toBe(1);

    // Remove one member
    removeFloatingControl(ctrl1.id);

    // Group should be auto-dissolved
    expect(getAllGroups().length).toBe(0);
    expect(getGroupForControl(ctrl2.id)).toBeNull();

    // Clean up
    removeFloatingControl(ctrl2.id);
    expect(getAllFloatingControls().length).toBe(0);
  });

  it("re-grouping controls removes them from old groups first", () => {
    const ctrls = [0, 1, 2, 3].map((i) => {
      const c = makeControl(0, i, 0);
      addFloatingControl(c);
      return c;
    });

    const g1 = groupControls([ctrls[0].id, ctrls[1].id]);
    const g2 = groupControls([ctrls[1].id, ctrls[2].id]);

    // g1 should have been dissolved since ctrls[1] was taken out
    // (ctrls[0] alone can't form a group)
    expect(getGroupForControl(ctrls[0].id)).toBeNull();
    expect(getGroupForControl(ctrls[1].id)).toBe(g2);
    expect(getGroupForControl(ctrls[2].id)).toBe(g2);

    resetFloatingStore();
  });
});

// ============================================================================
// Sheet-Scoped Cleanup
// ============================================================================

describe("Sheet-scoped controls cleanup", () => {
  beforeEach(() => {
    resetFloatingStore();
  });

  it("removing all controls for a sheet leaves other sheets intact", () => {
    // Add controls across 3 sheets
    for (let sheet = 0; sheet < 3; sheet++) {
      for (let i = 0; i < 50; i++) {
        addFloatingControl(makeControl(sheet, i, 0));
      }
    }

    expect(getAllFloatingControls().length).toBe(150);

    // Remove all controls on sheet 1
    const sheet1Controls = getFloatingControlsForSheet(1);
    for (const ctrl of sheet1Controls) {
      removeFloatingControl(ctrl.id);
    }

    expect(getAllFloatingControls().length).toBe(100);
    expect(getFloatingControlsForSheet(0).length).toBe(50);
    expect(getFloatingControlsForSheet(1).length).toBe(0);
    expect(getFloatingControlsForSheet(2).length).toBe(50);
  });

  it("removing sheet controls also cleans up groups", () => {
    const c1 = makeControl(0, 0, 0);
    const c2 = makeControl(0, 1, 0);
    const c3 = makeControl(1, 0, 0); // Different sheet

    addFloatingControl(c1);
    addFloatingControl(c2);
    addFloatingControl(c3);

    groupControls([c1.id, c2.id]);
    expect(getAllGroups().length).toBe(1);

    // Remove all sheet 0 controls
    for (const ctrl of getFloatingControlsForSheet(0)) {
      removeFloatingControl(ctrl.id);
    }

    // Group should be dissolved (both members removed)
    expect(getAllGroups().length).toBe(0);

    // Sheet 1 control should remain
    expect(getAllFloatingControls().length).toBe(1);
    expect(getFloatingControl(c3.id)).not.toBeNull();

    resetFloatingStore();
  });

  it("resetFloatingStore clears everything", () => {
    for (let i = 0; i < 100; i++) {
      addFloatingControl(makeControl(0, i, 0));
    }
    const ids = getAllFloatingControls().map((c) => c.id);
    groupControls([ids[0], ids[1]]);

    resetFloatingStore();

    expect(getAllFloatingControls().length).toBe(0);
    expect(getAllGroups().length).toBe(0);
    expect(getGroupForControl(ids[0])).toBeNull();
  });
});
