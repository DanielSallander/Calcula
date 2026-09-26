//! FILENAME: app/src/api/__tests__/objectSelectionSet.test.ts
// PURPOSE: The canvas SELECTION SET (M8): one selection across object
//          families, read in paint order; members a single-select family
//          cannot hold are held by the set; add / remove / clear / notify; and
//          PRESS PARITY -- what a press on an object means for the set
//          (`noteObjectPress`), exercised with doubles of real family semantics.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  addToObjectSelection,
  clearObjectSelection,
  clearSetHeldObjects,
  getPrimaryObjectRegion,
  getSelectedObjectRegion,
  getSelectedObjectRegions,
  getSetHeldObjectRegions,
  isObjectInSelection,
  noteObjectPress,
  notifyObjectSelectionChanged,
  objectLabelOf,
  onObjectSelectionChanged,
  registerObjectSelectionProvider,
  removeFromObjectSelection,
  resetObjectSelectionProviders,
  selectObject,
  setObjectSelectionSet,
  type ObjectSelectionProvider,
} from "../objectSelection";
import { registerGridOverlay, setGridRegions, type GridRegion } from "../gridOverlays";

function region(id: string, type: string, x = 0): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y: 0, width: 10, height: 10 } };
}

/**
 * A SINGLE-select family (Chart, Floating Range, pivot box): `select`
 * replaces its one object, and every change is announced at its chokepoint.
 */
function singleFamily(type: string) {
  let selected: string | null = null;
  const provider: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => r.id === selected,
    select: vi.fn((r: GridRegion) => {
      if (selected === r.id) return;
      selected = r.id;
      notifyObjectSelectionChanged();
    }),
    deselectAll: vi.fn(() => {
      if (selected === null) return;
      selected = null;
      notifyObjectSelectionChanged();
    }),
    labelOf: (r) => `${type} ${r.id}`,
  };
  return {
    provider,
    get selected() {
      return selected;
    },
    /** What the family's own CLICK handler does on a press: replace. */
    click(r: GridRegion) {
      provider.select(r);
    },
  };
}

/** A MULTI-select family (Controls, Slicer, Timeline), with Ctrl-toggle clicks. */
function multiFamily(type: string) {
  const selected = new Set<string>();
  const provider: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => selected.has(r.id),
    select: vi.fn((r: GridRegion) => {
      selected.clear();
      selected.add(r.id);
      notifyObjectSelectionChanged();
    }),
    deselectAll: vi.fn(() => {
      if (selected.size === 0) return;
      selected.clear();
      notifyObjectSelectionChanged();
    }),
    addToSelection: vi.fn((r: GridRegion) => {
      selected.add(r.id);
      notifyObjectSelectionChanged();
    }),
    removeFromSelection: vi.fn((r: GridRegion) => {
      selected.delete(r.id);
      notifyObjectSelectionChanged();
    }),
  };
  return {
    provider,
    selected,
    /** The family's own click: Ctrl toggles, a plain click on a member keeps. */
    click(r: GridRegion, ctrl = false) {
      if (ctrl) {
        if (selected.has(r.id)) selected.delete(r.id);
        else selected.add(r.id);
        notifyObjectSelectionChanged();
      } else if (!selected.has(r.id)) {
        provider.select(r);
      }
    },
  };
}

const cleanups: Array<() => void> = [];
let charts: ReturnType<typeof singleFamily>;
let slicers: ReturnType<typeof multiFamily>;
let pivots: ReturnType<typeof singleFamily>;
const c1 = region("c1", "chart", 0);
const c2 = region("c2", "chart", 20);
const s1 = region("s1", "slicer", 40);
const s2 = region("s2", "slicer", 60);
const p1 = region("p1", "pivot-visual", 80);

beforeEach(() => {
  resetObjectSelectionProviders();
  charts = singleFamily("chart");
  slicers = multiFamily("slicer");
  pivots = singleFamily("pivot-visual");
  cleanups.push(
    registerGridOverlay({ type: "pivot-visual", render: () => {}, priority: 12 }),
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "slicer", render: () => {}, priority: 16 }),
    registerObjectSelectionProvider(charts.provider),
    registerObjectSelectionProvider(slicers.provider),
    registerObjectSelectionProvider(pivots.provider),
  );
  setGridRegions([s2, c2, p1, s1, c1]);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  setGridRegions([]);
  vi.useRealTimers();
});

const ids = (rs: readonly GridRegion[]) => rs.map((r) => r.id);

// ============================================================================
// The set
// ============================================================================

describe("the selection set", () => {
  it("setObjectSelectionSet selects across families; the extra chart is SET-held; read back in PAINT order", () => {
    setObjectSelectionSet([c1, s1, c2, s2, p1]);
    // Paint order: pivot (12) < chart (15) < slicer (16), then publication order.
    expect(ids(getSelectedObjectRegions())).toEqual(["p1", "c2", "c1", "s2", "s1"]);
    // Charts hold ONE; the other chart is the set's. Slicers hold both.
    expect([charts.selected]).toEqual(["c1"]);
    expect([...slicers.selected].sort()).toEqual(["s1", "s2"]);
    expect(ids(getSetHeldObjectRegions())).toEqual(["c2"]);
    expect(slicers.provider.addToSelection).toHaveBeenCalledWith(s2);
  });

  it("the primary is the named one, and a family's primary member is the one it holds", () => {
    setObjectSelectionSet([c1, c2, s1], c2);
    expect(charts.selected).toBe("c2");
    expect(getPrimaryObjectRegion()?.id).toBe("c2");
    expect(ids(getSetHeldObjectRegions())).toEqual(["c1"]);
  });

  it("families with no member are deselected", () => {
    pivots.click(p1);
    setObjectSelectionSet([c1]);
    expect(pivots.selected).toBeNull();
    expect(pivots.provider.deselectAll).toHaveBeenCalled();
  });

  it("addToObjectSelection: the family selects it when it holds nothing, adds it when it can hold several, else the set holds it", () => {
    addToObjectSelection(c1);
    expect(charts.selected).toBe("c1");
    addToObjectSelection(s1);
    addToObjectSelection(s2);
    expect([...slicers.selected].sort()).toEqual(["s1", "s2"]);
    addToObjectSelection(c2);
    expect(charts.selected).toBe("c1");
    expect(ids(getSetHeldObjectRegions())).toEqual(["c2"]);
    expect(isObjectInSelection(c2)).toBe(true);
    expect(getPrimaryObjectRegion()?.id).toBe("c2");
    expect(getSelectedObjectRegions()).toHaveLength(4);
  });

  it("removeFromObjectSelection: a set-held member just leaves; a multi family removes one; a single family PROMOTES its next member", () => {
    setObjectSelectionSet([c1, c2, s1, s2], c1);
    removeFromObjectSelection(s1);
    expect([...slicers.selected]).toEqual(["s2"]);
    // c1 is the chart family's; c2 the set's. Removing c1 hands c2 to Charts,
    // so the chart's contextual UI keeps addressing a selected chart.
    removeFromObjectSelection(c1);
    expect(charts.selected).toBe("c2");
    expect(getSetHeldObjectRegions()).toEqual([]);
    removeFromObjectSelection(c2);
    expect(charts.selected).toBeNull();
    expect(ids(getSelectedObjectRegions())).toEqual(["s2"]);
  });

  it("clearObjectSelection empties every family AND the set", () => {
    setObjectSelectionSet([c1, c2, s1, p1]);
    clearObjectSelection();
    expect(getSelectedObjectRegions()).toEqual([]);
    expect(charts.selected).toBeNull();
    expect(slicers.selected.size).toBe(0);
  });

  it("selectObject selects ONE object and drops what the set held", () => {
    setObjectSelectionSet([c1, c2, s1]);
    selectObject(s2);
    expect(ids(getSelectedObjectRegions())).toEqual(["s2"]);
  });

  it("clearSetHeldObjects forgets the set's members and leaves the families alone", () => {
    setObjectSelectionSet([c1, c2], c1);
    clearSetHeldObjects();
    expect(ids(getSelectedObjectRegions())).toEqual(["c1"]);
  });

  it("the primary defaults to the LAST member", () => {
    setObjectSelectionSet([c1, c2]);
    expect(charts.selected).toBe("c2");
    expect(getPrimaryObjectRegion()?.id).toBe("c2");
  });

  it("getSelectedObjectRegion counts a set-held member (Escape must apply to it)", () => {
    setObjectSelectionSet([c1, c2], c1);
    charts.provider.deselectAll();
    expect(getSelectedObjectRegion([c1, c2])?.id).toBe("c2");
  });

  it("objectLabelOf asks the owning provider; no provider, no label", () => {
    expect(objectLabelOf(c1)).toBe("chart c1");
    expect(objectLabelOf(s1)).toBeNull();
    expect(objectLabelOf(region("x", "unowned"))).toBeNull();
  });
});

describe("change notification", () => {
  it("a family's chokepoint notify reaches the listeners", () => {
    const seen = vi.fn();
    cleanups.push(onObjectSelectionChanged(seen));
    charts.click(c1);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("a set operation announces ONCE, however many families it touched", () => {
    const seen = vi.fn();
    setObjectSelectionSet([p1]);
    cleanups.push(onObjectSelectionChanged(seen));
    setObjectSelectionSet([c1, c2, s1, s2]);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener does not stop the others", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();
    cleanups.push(
      onObjectSelectionChanged(() => {
        throw new Error("boom");
      }),
      onObjectSelectionChanged(good),
    );
    notifyObjectSelectionChanged();
    expect(good).toHaveBeenCalled();
    err.mockRestore();
  });

  it("the unsubscribe stops the listener", () => {
    const seen = vi.fn();
    const off = onObjectSelectionChanged(seen);
    off();
    notifyObjectSelectionChanged();
    expect(seen).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Press parity
// ============================================================================

/** Core's order on a canvas press: the seam first, then the family's click. */
function press(r: GridRegion, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}, familyClick?: () => void) {
  noteObjectPress(r, mods);
  familyClick?.();
}

/** The press's mouseup, and the deferred settle after every other listener. */
function release(): void {
  window.dispatchEvent(new MouseEvent("mouseup"));
  vi.runOnlyPendingTimers();
}

describe("press parity (noteObjectPress)", () => {
  beforeEach(() => vi.useFakeTimers());

  it("a plain press on another family's object deselects the first family", () => {
    charts.click(c1);
    press(s1, {}, () => slicers.click(s1));
    release();
    expect(charts.selected).toBeNull();
    expect(ids(getSelectedObjectRegions())).toEqual(["s1"]);
  });

  it("Ctrl adds across families", () => {
    charts.click(c1);
    press(s1, { ctrlKey: true }, () => slicers.click(s1, true));
    release();
    expect(ids(getSelectedObjectRegions())).toEqual(["c1", "s1"]);
  });

  it("Shift adds too -- even to a family whose own click only knows Ctrl (the set keeps what it drops)", () => {
    slicers.click(s1);
    // The slicer family's own click ignores Shift and REPLACES s1 with s2.
    press(s2, { shiftKey: true }, () => slicers.click(s2));
    expect(ids(getSelectedObjectRegions())).toEqual(["s2", "s1"]);
    release();
    // After the gesture, the multi family takes it back into its own set.
    expect([...slicers.selected].sort()).toEqual(["s1", "s2"]);
    expect(getSetHeldObjectRegions()).toEqual([]);
  });

  it("Ctrl on a second chart: the single-select family replaces its chart, and the set holds the first", () => {
    charts.click(c1);
    press(c2, { ctrlKey: true }, () => charts.click(c2));
    release();
    expect(charts.selected).toBe("c2");
    expect(ids(getSelectedObjectRegions())).toEqual(["c2", "c1"]);
    expect(ids(getSetHeldObjectRegions())).toEqual(["c1"]);
  });

  it("a family that deselects itself on another family's press (the pivot box) is kept by an additive press", () => {
    pivots.click(p1);
    press(c1, { ctrlKey: true }, () => {
      pivots.provider.deselectAll(); // what the pivot box does on ANY other press
      charts.click(c1);
    });
    release();
    expect(ids(getSelectedObjectRegions())).toEqual(["p1", "c1"]);
    // Handed back to its family after the gesture.
    expect(pivots.selected).toBe("p1");
  });

  it("Ctrl on a member takes it OUT of the set at mouseup", () => {
    setObjectSelectionSet([c1, c2, s1], c1);
    press(c1, { ctrlKey: true }, () => {
      /* Charts arms its pending click on an already-selected chart: no change */
    });
    release();
    expect(ids(getSelectedObjectRegions())).toEqual(["c2", "s1"]);
    expect(charts.selected).toBe("c2");
  });

  it("a plain press on a member of a multi-selection KEEPS the set (a group drag may follow)...", () => {
    setObjectSelectionSet([c1, c2, s1], c1);
    press(c2, {}, () => charts.click(c2));
    // During the gesture the family replaced its chart; the set still has all three.
    expect(ids(getSelectedObjectRegions())).toEqual(["c2", "c1", "s1"]);
    window.dispatchEvent(new CustomEvent("floatingObject:moveComplete", { detail: { regionId: "c2" } }));
    release();
    expect(ids(getSelectedObjectRegions())).toEqual(["c2", "c1", "s1"]);
  });

  it("...and narrows to the pressed object at mouseup when nothing moved", () => {
    setObjectSelectionSet([c1, c2, s1], c1);
    press(s1, {}, () => slicers.click(s1));
    expect(getSelectedObjectRegions()).toHaveLength(3);
    release();
    expect(ids(getSelectedObjectRegions())).toEqual(["s1"]);
    expect(charts.selected).toBeNull();
  });

  it("the settle waits for the mouseup: nothing narrows while the button is down", () => {
    setObjectSelectionSet([c1, s1], c1);
    press(s1, {}, () => slicers.click(s1));
    vi.runOnlyPendingTimers();
    expect(getSelectedObjectRegions()).toHaveLength(2);
  });

  it("a press whose mouseup never came is dropped by the next press, not replayed", () => {
    setObjectSelectionSet([c1, s1], c1);
    press(s1, {}, () => slicers.click(s1)); // no release
    press(c2, { ctrlKey: true }, () => charts.click(c2));
    release();
    expect(ids(getSelectedObjectRegions())).toEqual(["c2", "c1", "s1"]);
  });
});
