//! FILENAME: app/src/api/__tests__/objectSelectionDelete.test.ts
// PURPOSE: DELETE of a canvas MULTI-selection acts on EVERY selected object --
//          the members each family holds AND the members the selection set
//          holds for a single-select family (a second chart) -- as ONE undo
//          step (open-items 2.af row 1).
// CONTEXT: Each family's Delete acted only on what that family held itself,
//          and the keybinding dispatcher runs ONE winner per key: with a chart,
//          a second chart and a control selected, Delete removed one chart and
//          left the rest. The seam (`deleteSelectedObjects`) groups the
//          selection by family and asks each family's provider to delete its
//          share (`deleteObjects`), inside one frontend undo transaction; a
//          member whose family cannot delete through the seam stays selected
//          and is named in ONE toast.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const log: string[] = [];
const toasts: string[] = [];
vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));
vi.mock("../notifications", () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import {
  deleteSelectedObjects,
  getSelectedObjectRegions,
  getSetHeldObjectRegions,
  notifyObjectSelectionChanged,
  objectSelectionSpansFamilies,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  type ObjectSelectionProvider,
} from "../objectSelection";
import { resetObjectGeometryProviders } from "../objectGeometry";
import { registerGridOverlay, getGridRegions, setGridRegions, type GridRegion } from "../gridOverlays";

function region(id: string, type: string, x = 0): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y: 0, width: 10, height: 10 } };
}

/** Remove regions from the live list (what a family's delete does to its publication). */
function unpublish(ids: readonly string[]): void {
  setGridRegions(getGridRegions().filter((r) => !ids.includes(r.id)));
}

/** A SINGLE-select family (Chart): one object; the set holds the rest. */
function singleFamily(type: string, canDelete: boolean) {
  let selected: string | null = null;
  const deleted: string[][] = [];
  const provider: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => r.id === selected,
    select: (r) => {
      selected = r.id;
      notifyObjectSelectionChanged();
    },
    deselectAll: () => {
      if (selected === null) return;
      selected = null;
      notifyObjectSelectionChanged();
    },
    labelOf: (r) => `${type} ${r.id}`,
  };
  if (canDelete) {
    provider.deleteObjects = async (regions) => {
      log.push(`delete:${type}:${regions.map((r) => r.id).join(",")}`);
      deleted.push(regions.map((r) => r.id));
      if (regions.some((r) => r.id === selected)) selected = null;
      unpublish(regions.map((r) => r.id));
    };
  }
  return { provider, deleted };
}

/** A MULTI-select family (Controls): holds several itself. */
function multiFamily(type: string) {
  const selected = new Set<string>();
  const deleted: string[][] = [];
  const provider: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => selected.has(r.id),
    select: (r) => {
      selected.clear();
      selected.add(r.id);
    },
    deselectAll: () => selected.clear(),
    addToSelection: (r) => {
      selected.add(r.id);
    },
    removeFromSelection: (r) => {
      selected.delete(r.id);
    },
    deleteObjects: async (regions) => {
      log.push(`delete:${type}:${regions.map((r) => r.id).join(",")}`);
      deleted.push(regions.map((r) => r.id));
      for (const r of regions) selected.delete(r.id);
      unpublish(regions.map((r) => r.id));
    },
    labelOf: (r) => `${type} ${r.id}`,
  };
  return { provider, deleted, selected };
}

const cleanups: Array<() => void> = [];
let charts: ReturnType<typeof singleFamily>;
let controls: ReturnType<typeof multiFamily>;
let slicers: ReturnType<typeof singleFamily>;
const c1 = region("c1", "chart", 0);
const c2 = region("c2", "chart", 20);
const k1 = region("k1", "floating-control", 40);
const k2 = region("k2", "floating-control", 60);
const s1 = region("s1", "slicer", 80);

beforeEach(() => {
  log.length = 0;
  toasts.length = 0;
  resetObjectSelectionProviders();
  resetObjectGeometryProviders();
  charts = singleFamily("chart", true);
  controls = multiFamily("floating-control");
  // A family that has not (yet) learned to delete through the seam.
  slicers = singleFamily("slicer", false);
  cleanups.push(
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "floating-control", render: () => {}, priority: 20 }),
    registerGridOverlay({ type: "slicer", render: () => {}, priority: 16 }),
    registerObjectSelectionProvider(charts.provider),
    registerObjectSelectionProvider(controls.provider),
    registerObjectSelectionProvider(slicers.provider),
  );
  setGridRegions([c1, c2, k1, k2, s1]);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  setGridRegions([]);
});

describe("deleteSelectedObjects", () => {
  it("deletes EVERY selected object -- the set-held second chart too -- as ONE undo step", async () => {
    setObjectSelectionSet([c1, c2, k1], c1);
    expect(getSetHeldObjectRegions().map((r) => r.id)).toEqual(["c2"]);

    const outcome = await deleteSelectedObjects("Delete Objects");

    expect(charts.deleted.flat().sort(), "the set-held second chart was not deleted").toEqual(["c1", "c2"]);
    expect(controls.deleted.flat()).toEqual(["k1"]);
    // One begin, every family's delete inside it, one commit.
    expect(log[0]).toBe("begin:Delete Objects");
    expect(log[log.length - 1]).toBe("commit");
    expect(log.filter((l) => l.startsWith("begin")).length).toBe(1);
    expect(outcome).toEqual({ acted: 3, unsupported: 0, failed: 0 });
    expect(getSelectedObjectRegions()).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("a member whose family cannot delete through the seam stays SELECTED and is named once", async () => {
    setObjectSelectionSet([c1, s1, k2], c1);
    const outcome = await deleteSelectedObjects();
    expect(charts.deleted.flat()).toEqual(["c1"]);
    expect(controls.deleted.flat()).toEqual(["k2"]);
    expect(outcome).toEqual({ acted: 2, unsupported: 1, failed: 0 });
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["s1"]);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("slicer s1");
  });

  it("a family whose delete throws: its members stay, the others are deleted, one toast", async () => {
    controls.provider.deleteObjects = async () => {
      throw new Error("The sheet is protected.");
    };
    setObjectSelectionSet([c1, k1], c1);
    const outcome = await deleteSelectedObjects();
    expect(charts.deleted.flat()).toEqual(["c1"]);
    expect(outcome).toEqual({ acted: 1, unsupported: 0, failed: 1 });
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["k1"]);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("The sheet is protected.");
  });

  it("a family that refuses PART of its share: what landed is deleted, only what is still there is kept and named", async () => {
    // Two controls; the family deletes the first and is refused on the second.
    controls.provider.deleteObjects = async (regions) => {
      unpublish([regions[0].id]);
      throw new Error("The sheet is protected.");
    };
    setObjectSelectionSet([c1, k1, k2], c1);
    const outcome = await deleteSelectedObjects();
    expect(outcome, "a member that WAS deleted was counted as refused").toEqual({ acted: 2, unsupported: 0, failed: 1 });
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["k2"]);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("floating-control k2");
    expect(toasts[0], "a deleted member was named as not deleted").not.toContain("floating-control k1");
    expect(toasts[0]).toContain("The sheet is protected.");
  });

  it("nothing selected: nothing happens (no transaction, no toast)", async () => {
    const outcome = await deleteSelectedObjects();
    expect(outcome).toEqual({ acted: 0, unsupported: 0, failed: 0 });
    expect(log).toEqual([]);
  });
});

describe("objectSelectionSpansFamilies", () => {
  it("true for members of two families, and for a set-held member", () => {
    setObjectSelectionSet([c1, k1], c1);
    expect(objectSelectionSpansFamilies()).toBe(true);
    setObjectSelectionSet([c1, c2], c1);
    expect(objectSelectionSpansFamilies(), "a second chart is set-held").toBe(true);
  });

  it("false for one object, and for several one family holds itself (its own Delete acts on all)", () => {
    setObjectSelectionSet([c1], c1);
    expect(objectSelectionSpansFamilies()).toBe(false);
    setObjectSelectionSet([k1, k2], k1);
    expect(objectSelectionSpansFamilies()).toBe(false);
  });
});
