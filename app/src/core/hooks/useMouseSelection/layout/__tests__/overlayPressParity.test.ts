//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayPressParity.test.ts
// PURPOSE: PRESS PARITY through Core's REAL press handler: on a CANVAS a plain
//          press on one family's object deselects every other family before the
//          family hears the press; Ctrl/Shift keeps the rest; a WORKSHEET keeps
//          its historical behaviour (the press touches no other family). And
//          the one click signal every family reads now carries Shift.
// CONTEXT: The surface comes from the grid state snapshot, mocked here; the
//          families are doubles registered through the real object-selection
//          seam, and their "click handler" is a real listener on the real
//          `floatingObject:selected` dispatch.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";

const snapshot: { surface: "grid" | "canvas"; sheetContext: { activeSheetIndex: number } } = {
  surface: "canvas",
  sheetContext: { activeSheetIndex: 0 },
};
vi.mock("../../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

import { createOverlayMoveHandlers, type OverlayMoveState } from "../overlayMoveHandlers";
import { setGridRegions, type GridRegion } from "../../../../../api/gridOverlays";
import {
  getSelectedObjectRegions,
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  type ObjectSelectionProvider,
} from "../../../../../api/objectSelection";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../../types";

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 50;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 24;

function region(id: string, type: string, x: number): GridRegion {
  return {
    id,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    data: {},
    floating: { x, y: 0, width: 100, height: 60 },
  };
}

const chart = region("chart-1", "chart", 0);
const slicer = region("slicer-1", "slicer", 200);

/** A family that holds one object; its CLICK handler (the real dispatch) selects. */
function family(type: string) {
  let selected: string | null = null;
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
  };
  const onPress = (e: Event) => {
    const d = (e as CustomEvent<{ regionType: string; regionId: string }>).detail;
    if (d.regionType === type) {
      selected = d.regionId;
      notifyObjectSelectionChanged();
    }
  };
  return {
    provider,
    onPress,
    get selected() {
      return selected;
    },
  };
}

let charts: ReturnType<typeof family>;
let slicers: ReturnType<typeof family>;
let details: Array<Record<string, unknown>>;
const onSelected = (e: Event) => details.push((e as CustomEvent).detail);
const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  snapshot.surface = "canvas";
  details = [];
  resetObjectSelectionProviders();
  charts = family("chart");
  slicers = family("slicer");
  cleanups.push(registerObjectSelectionProvider(charts.provider), registerObjectSelectionProvider(slicers.provider));
  window.addEventListener("floatingObject:selected", charts.onPress);
  window.addEventListener("floatingObject:selected", slicers.onPress);
  window.addEventListener("floatingObject:selected", onSelected);
  setGridRegions([chart, slicer]);
});

afterEach(() => {
  window.removeEventListener("floatingObject:selected", charts.onPress);
  window.removeEventListener("floatingObject:selected", slicers.onPress);
  window.removeEventListener("floatingObject:selected", onSelected);
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  setGridRegions([]);
  vi.useRealTimers();
});

function mouse(mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}): React.MouseEvent<HTMLElement> {
  return {
    button: 0,
    ctrlKey: mods.ctrlKey === true,
    shiftKey: mods.shiftKey === true,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

/** A full click on the region at sheet x (press, release, settle). */
function click(x: number, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
  const ref: { current: OverlayMoveState | null } = { current: null };
  const h = createOverlayMoveHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    containerRef: { current: null },
    setIsOverlayMoving: vi.fn(),
    setCursorStyle: vi.fn(),
    overlayMoveStateRef: ref as React.MutableRefObject<OverlayMoveState | null>,
  });
  expect(h.handleOverlayMoveMouseDown(RHW + x + 10, CHH + 10, mouse(mods))).toBe(true);
  h.handleOverlayMoveMouseUp();
  window.dispatchEvent(new MouseEvent("mouseup"));
  vi.runOnlyPendingTimers();
}

describe("press parity on a CANVAS", () => {
  it("a press on another family's object deselects the first", () => {
    click(0);
    expect(charts.selected).toBe("chart-1");
    click(200);
    expect(slicers.selected).toBe("slicer-1");
    expect(charts.selected).toBeNull();
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["slicer-1"]);
  });

  it("Ctrl adds: both families stay selected", () => {
    click(0);
    click(200, { ctrlKey: true });
    expect(charts.selected).toBe("chart-1");
    expect(slicers.selected).toBe("slicer-1");
  });

  it("Shift adds as well", () => {
    click(0);
    click(200, { shiftKey: true });
    expect(charts.selected).toBe("chart-1");
    expect(slicers.selected).toBe("slicer-1");
  });
});

describe("a WORKSHEET keeps its historical behaviour", () => {
  it("a press on one family's object leaves the other family's selection alone", () => {
    snapshot.surface = "grid";
    click(0);
    click(200);
    // Two families "selected" at once -- exactly what a worksheet always did.
    expect(charts.selected).toBe("chart-1");
    expect(slicers.selected).toBe("slicer-1");
  });
});

describe("the click signal", () => {
  it("floatingObject:selected carries shiftKey (and ctrlKey) for every family", () => {
    click(0, { shiftKey: true });
    click(200, { ctrlKey: true });
    expect(details[0]).toMatchObject({ regionId: "chart-1", shiftKey: true, ctrlKey: false });
    expect(details[1]).toMatchObject({ regionId: "slicer-1", shiftKey: false, ctrlKey: true });
  });
});
