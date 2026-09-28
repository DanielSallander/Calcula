//! FILENAME: app/src/api/__tests__/gridOverlaysPointMode.test.ts
// PURPOSE: During cross-sheet point mode the grid paints and hits NONE of the
//          published object regions -- they belong to the edit's sheet, not to
//          the one on screen -- while a family reading regions for its own STATE
//          still sees them all.
// CONTEXT: A point-mode switch emits no SHEET_CHANGED (the edit must survive
//          it), so no object family re-filters. Before `getLiveGridRegions`, a
//          canvas's objects painted over Sheet1 and caught the click meant to
//          pick Sheet1!E2.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getGridRegions,
  getLiveGridRegions,
  hitTestOverlays,
  topFloatingRegionAt,
  registerGridOverlay,
  removeGridRegionsByType,
  replaceGridRegionsByType,
  type GridRegion,
} from "../gridOverlays";
import {
  setExternalSessionParked,
  __resetExternalEditForTests,
} from "../../core/lib/formulaEditTarget";
import { createFakeExternalEdit } from "../../core/lib/__tests__/helpers/fakeExternalEdit";

const TYPE = "pointModeProbe";
const REGION: GridRegion = {
  id: "probe-1",
  type: TYPE,
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 0, y: 0, width: 100, height: 50 },
};
const GEO = { rowHeaderWidth: 0, colHeaderHeight: 0, scrollX: 0, scrollY: 0 };

let unregister: () => void;

beforeEach(() => {
  unregister = registerGridOverlay({ type: TYPE, render: () => undefined, hitTest: () => true });
  replaceGridRegionsByType(TYPE, [REGION]);
});

afterEach(() => {
  removeGridRegionsByType(TYPE);
  unregister();
  __resetExternalEditForTests();
});

function park(): void {
  const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=" });
  fake.register();
  setExternalSessionParked(0);
}

describe("the live region view in cross-sheet point mode", () => {
  it("off point mode, the live view IS the published list and every hit test answers", () => {
    expect(getLiveGridRegions()).toContain(REGION);
    expect(hitTestOverlays(10, 10, 0, 0, 0, 0, 0, 0)).toBe(REGION);
    expect(topFloatingRegionAt(10, 10, GEO)).toBe(REGION);
  });

  it("parked: nothing is painted or hit, but the published list is intact for STATE readers", () => {
    park();
    expect(getLiveGridRegions()).toEqual([]);
    expect(hitTestOverlays(10, 10, 0, 0, 0, 0, 0, 0)).toBeNull();
    // The DEFAULT list of the shared hit helper is the live one: every family's
    // right-click / wheel lookup that relies on it is suppressed with it.
    expect(topFloatingRegionAt(10, 10, GEO)).toBeNull();
    expect(getGridRegions()).toContain(REGION);
  });

  it("the way back restores everything", () => {
    park();
    setExternalSessionParked(2);
    expect(getLiveGridRegions()).toContain(REGION);
    expect(hitTestOverlays(10, 10, 0, 0, 0, 0, 0, 0)).toBe(REGION);
    expect(topFloatingRegionAt(10, 10, GEO)).toBe(REGION);
  });
});
