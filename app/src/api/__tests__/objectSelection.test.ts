//! FILENAME: app/src/api/__tests__/objectSelection.test.ts
// PURPOSE: The object selection seam: one provider per region type, selecting
//          one family deselects the others, inner selections can claim keys,
//          and the cycling order is the renderer's paint order.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  deselectAllObjects,
  getSelectedObjectRegion,
  objectOwnsKey,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  selectableFloatingRegions,
  selectObject,
  type ObjectSelectionProvider,
} from "../objectSelection";
import { registerGridOverlay, setGridRegions, type GridRegion } from "../gridOverlays";

function region(id: string, type: string, floating = true): GridRegion {
  return {
    id,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    ...(floating ? { floating: { x: 0, y: 0, width: 10, height: 10 } } : {}),
  };
}

/** A family whose selection is a set of region ids. */
function family(types: string[], extra: Partial<ObjectSelectionProvider> = {}) {
  const selected = new Set<string>();
  const provider: ObjectSelectionProvider = {
    types,
    isSelected: (r) => selected.has(r.id),
    select: vi.fn((r: GridRegion) => {
      selected.clear();
      selected.add(r.id);
    }),
    deselectAll: vi.fn(() => selected.clear()),
    ...extra,
  };
  return { provider, selected };
}

const cleanups: Array<() => void> = [];
beforeEach(() => resetObjectSelectionProviders());
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("selecting", () => {
  it("selecting one family deselects every other family first", () => {
    const charts = family(["chart"]);
    const slicers = family(["slicer"]);
    cleanups.push(registerObjectSelectionProvider(charts.provider), registerObjectSelectionProvider(slicers.provider));
    selectObject(region("s1", "slicer"));
    expect(slicers.selected.has("s1")).toBe(true);
    vi.mocked(charts.provider.deselectAll).mockClear();
    selectObject(region("c1", "chart"));
    expect(charts.selected.has("c1")).toBe(true);
    expect(slicers.selected.size).toBe(0);
    // The owner is not told to deselect before its own select.
    expect(charts.provider.deselectAll).not.toHaveBeenCalled();
  });

  it("an unowned type selects nothing and deselects nothing", () => {
    const charts = family(["chart"]);
    cleanups.push(registerObjectSelectionProvider(charts.provider));
    charts.selected.add("c1");
    expect(selectObject(region("x", "unknown"))).toBe(false);
    expect(charts.selected.has("c1")).toBe(true);
  });

  it("deselectAllObjects reaches every family, and a throwing one does not stop the rest", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = family(["a"], { deselectAll: () => { throw new Error("boom"); } });
    const good = family(["b"]);
    good.selected.add("b1");
    cleanups.push(registerObjectSelectionProvider(bad.provider), registerObjectSelectionProvider(good.provider));
    deselectAllObjects();
    expect(good.selected.size).toBe(0);
    err.mockRestore();
  });

  it("getSelectedObjectRegion answers the first selected region", () => {
    const charts = family(["chart"]);
    cleanups.push(registerObjectSelectionProvider(charts.provider));
    const regions = [region("c1", "chart"), region("c2", "chart")];
    expect(getSelectedObjectRegion(regions)).toBeNull();
    charts.selected.add("c2");
    expect(getSelectedObjectRegion(regions)?.id).toBe("c2");
  });
});

describe("registration", () => {
  it("a stale cleanup does not remove a newer provider for the same type", () => {
    const first = family(["chart"]);
    const second = family(["chart"]);
    const offFirst = registerObjectSelectionProvider(first.provider);
    cleanups.push(registerObjectSelectionProvider(second.provider));
    offFirst();
    selectObject(region("c1", "chart"));
    expect(second.selected.has("c1")).toBe(true);
    expect(first.selected.size).toBe(0);
  });
});

describe("inner selections own keys", () => {
  it("objectOwnsKey is true while any family claims the key", () => {
    let inner = false;
    const fr = family(["floating-range"], { ownsKey: (k) => inner && k === "Escape" });
    cleanups.push(registerObjectSelectionProvider(fr.provider));
    expect(objectOwnsKey("Escape")).toBe(false);
    inner = true;
    expect(objectOwnsKey("Escape")).toBe(true);
    expect(objectOwnsKey("Tab")).toBe(false);
  });
});

describe("cycling order = paint order", () => {
  it("floating, selectable regions only, by overlay priority then publication order", () => {
    cleanups.push(
      registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
      registerGridOverlay({ type: "floating-control", render: () => {}, priority: 12 }),
      registerObjectSelectionProvider(family(["chart"]).provider),
      registerObjectSelectionProvider(family(["floating-control"]).provider),
    );
    const order = selectableFloatingRegions([
      region("c1", "chart"),
      region("k1", "floating-control"),
      region("t1", "table", false),
      region("c2", "chart"),
      region("x1", "no-provider"),
      region("k2", "floating-control"),
    ]).map((r) => r.id);
    expect(order).toEqual(["k1", "k2", "c1", "c2"]);
  });
});
