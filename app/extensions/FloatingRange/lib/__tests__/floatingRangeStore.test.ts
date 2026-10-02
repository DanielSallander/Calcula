//! FILENAME: app/extensions/FloatingRange/lib/__tests__/floatingRangeStore.test.ts
// PURPOSE: Store tests — fromInfo normalization at the backend boundary,
//          active-sheet region-sync filtering (the sheet-blind-regions hazard),
//          and the 300 ms debounced geometry persistence.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The bindings module reaches Tauri; the store must be testable without it.
// The mock also carries the MAX constants frDimensions imports.
vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
    id,
    backingSheetId: "backing",
    hostSheetId: "host",
    x: (patch.x as number) ?? 0,
    y: (patch.y as number) ?? 0,
    rotation: 0,
    pinToGrid: false,
    rowCount: (patch.rowCount as number) ?? 1,
    colCount: (patch.colCount as number) ?? 1,
    colWidths: {},
    rowHeights: {},
    name: "Float1",
    backingSheetIndex: 1,
    hostSheetIndex: 0,
  })),
}));

import { updateFloatingRange, type FloatingRangeInfo } from "@api/floatingRanges";
import { getGridRegions, type GridRegion } from "@api/gridOverlays";
import { setDesignMode } from "@api/designMode";
import {
  registerLayoutSurfaceProvider,
  notifyLayoutSurfaceChanged,
  type LayoutSurface,
} from "@api/layoutSurface";
import {
  fromInfo,
  toInfo,
  upsertFromInfo,
  resetFloatingRangeStore,
  setFrActiveSheetIndex,
  syncFloatingRangeRegions,
  moveFloatingRange,
  flushPendingFloatingRangeSaves,
  getFloatingRangeById,
  frGeometryEditable,
  frObjectEditable,
  installFrRegionResyncs,
  FLOATING_RANGE_REGION_TYPE,
} from "../floatingRangeStore";
import {
  selectFloatingRange,
  deselectAllFloatingRanges,
  isFloatingRangeSelected,
  resetFrSelection,
} from "../frSelection";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  deselectAllObjects,
} from "@api/objectSelection";
import { setFrEditingRange } from "../frEditingRange";
import {
  FR_ROW_HDR_W,
  FR_TITLE_H,
  FR_COL_HDR_H,
  FR_DEFAULT_COL_W,
  FR_DEFAULT_ROW_H,
} from "../frDimensions";

function makeInfo(overrides: Partial<FloatingRangeInfo> = {}): FloatingRangeInfo {
  return {
    id: "fr-uuid-1",
    backingSheetId: "sheet-backing",
    hostSheetId: "sheet-host",
    x: 100,
    y: 50,
    rotation: 0,
    pinToGrid: false,
    rowCount: 2,
    colCount: 3,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float1",
    backingSheetIndex: 2,
    hostSheetIndex: 0,
    ...overrides,
  };
}

/** The published region data of range `id` on the active sheet. */
function regionData(id: string): Record<string, unknown> {
  const region = getGridRegions().find((r) => r.id === `fr-${id}`);
  expect(region, `range ${id} is published`).toBeDefined();
  return region!.data as Record<string, unknown>;
}

beforeEach(() => {
  resetFloatingRangeStore();
  resetFrSelection();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  resetFloatingRangeStore();
  resetFrSelection();
});

// ============================================================================
// fromInfo — the single normalization boundary
// ============================================================================

describe("fromInfo normalization", () => {
  it("passes a well-formed info through faithfully", () => {
    const entry = fromInfo(makeInfo());
    expect(entry.id).toBe("fr-uuid-1");
    expect(entry.sheetIndex).toBe(0);
    expect(entry.backingSheetIndex).toBe(2);
    expect(entry.name).toBe("Float1");
    expect(entry.x).toBe(100);
    expect(entry.y).toBe(50);
    expect(entry.rows).toBe(2);
    expect(entry.cols).toBe(3);
    expect(entry.angle).toBe(0);
    expect(entry.pinToGrid).toBe(false);
  });

  it("clamps counts to at least 1 and truncates fractions", () => {
    const entry = fromInfo(makeInfo({ rowCount: 0, colCount: 2.9 }));
    expect(entry.rows).toBe(1);
    expect(entry.cols).toBe(2);
  });

  it("clamps geometry to finite non-negative numbers", () => {
    const entry = fromInfo(
      makeInfo({ x: -12, y: Number.NaN as unknown as number }),
    );
    expect(entry.x).toBe(0);
    expect(entry.y).toBe(0);
  });

  it("drops junk size-map entries and keeps valid ones", () => {
    const entry = fromInfo(
      makeInfo({
        colWidths: {
          0: 80,
          1: -5,
          2: Number.NaN,
        } as unknown as Record<number, number>,
        rowHeights: { 0: 32 },
      }),
    );
    expect(entry.colWidths).toEqual({ 0: 80 });
    expect(entry.rowHeights).toEqual({ 0: 32 });
  });

  it("falls back to a non-empty name", () => {
    const entry = fromInfo(makeInfo({ name: "" as unknown as string }));
    expect(entry.name).toBe("Float");
  });

  it("carries the three chrome flags through independently", () => {
    const entry = fromInfo(
      makeInfo({ showTitle: false, showColumnHeaders: true, showRowHeaders: false }),
    );
    expect(entry.showTitle).toBe(false);
    expect(entry.showColumnHeaders).toBe(true);
    expect(entry.showRowHeaders).toBe(false);
  });

  it("treats a MISSING chrome flag as shown, never as hidden", () => {
    // The backend defaults these to true, so `Boolean(undefined)` at this
    // boundary would strip the chrome off every range whose info predates the
    // field. `!== false` is the only reading that survives that.
    const bare = makeInfo();
    delete (bare as Partial<FloatingRangeInfo>).showTitle;
    delete (bare as Partial<FloatingRangeInfo>).showColumnHeaders;
    delete (bare as Partial<FloatingRangeInfo>).showRowHeaders;
    const entry = fromInfo(bare);
    expect(entry.showTitle).toBe(true);
    expect(entry.showColumnHeaders).toBe(true);
    expect(entry.showRowHeaders).toBe(true);
  });

  it("round-trips through toInfo (the provider seam's list shape)", () => {
    const info = makeInfo({ rowCount: 4, colCount: 2, x: 10, y: 20 });
    const roundTripped = toInfo(fromInfo(info));
    expect(roundTripped.id).toBe(info.id);
    expect(roundTripped.rowCount).toBe(4);
    expect(roundTripped.colCount).toBe(2);
    expect(roundTripped.hostSheetIndex).toBe(info.hostSheetIndex);
    expect(roundTripped.backingSheetIndex).toBe(info.backingSheetIndex);
    expect(roundTripped.name).toBe(info.name);
  });
});

// ============================================================================
// Region sync — active-sheet filter + derived frame size
// ============================================================================

describe("syncFloatingRangeRegions", () => {
  it("publishes only the active sheet's floating ranges", () => {
    upsertFromInfo(makeInfo({ id: "a", hostSheetIndex: 0 }));
    upsertFromInfo(makeInfo({ id: "b", hostSheetIndex: 1, name: "Float2" }));

    setFrActiveSheetIndex(0);
    syncFloatingRangeRegions();
    let regions = getGridRegions().filter(
      (r) => r.type === FLOATING_RANGE_REGION_TYPE,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].id).toBe("fr-a");

    setFrActiveSheetIndex(1);
    syncFloatingRangeRegions();
    regions = getGridRegions().filter(
      (r) => r.type === FLOATING_RANGE_REGION_TYPE,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].id).toBe("fr-b");
    expect(regions[0].data?.name).toBe("Float2");
  });

  it("derives the frame size from counts x sizes + chrome (never stored)", () => {
    upsertFromInfo(
      makeInfo({ id: "c", hostSheetIndex: 0, rowCount: 2, colCount: 3 }),
    );
    setFrActiveSheetIndex(0);
    syncFloatingRangeRegions();

    const region = getGridRegions().find((r) => r.id === "fr-c");
    expect(region).toBeDefined();
    expect(region!.floating!.width).toBeCloseTo(
      FR_ROW_HDR_W + 3 * FR_DEFAULT_COL_W,
      5,
    );
    expect(region!.floating!.height).toBeCloseTo(
      FR_TITLE_H + FR_COL_HDR_H + 2 * FR_DEFAULT_ROW_H,
      5,
    );
    expect(region!.data).toMatchObject({
      frId: "c",
      rows: 2,
      cols: 3,
    });
  });

  it("SHRINKS the published region by exactly the chrome it hides", () => {
    // The region rect is the object's hit box, its move box and its resize
    // box. If hiding a strip did not shrink it, the object would keep an
    // invisible band of empty pixels that still swallows clicks.
    upsertFromInfo(
      makeInfo({
        id: "e",
        hostSheetIndex: 0,
        rowCount: 2,
        colCount: 3,
        showTitle: false,
        showColumnHeaders: false,
        showRowHeaders: false,
      }),
    );
    setFrActiveSheetIndex(0);
    syncFloatingRangeRegions();

    const region = getGridRegions().find((r) => r.id === "fr-e");
    expect(region!.floating!.width).toBeCloseTo(3 * FR_DEFAULT_COL_W, 5);
    expect(region!.floating!.height).toBeCloseTo(2 * FR_DEFAULT_ROW_H, 5);
  });

  it("removes only the strips that are hidden", () => {
    upsertFromInfo(
      makeInfo({
        id: "f",
        hostSheetIndex: 0,
        rowCount: 2,
        colCount: 3,
        showTitle: false,
        showColumnHeaders: true,
        showRowHeaders: false,
      }),
    );
    setFrActiveSheetIndex(0);
    syncFloatingRangeRegions();

    const region = getGridRegions().find((r) => r.id === "fr-f");
    expect(region!.floating!.width).toBeCloseTo(3 * FR_DEFAULT_COL_W, 5);
    expect(region!.floating!.height).toBeCloseTo(
      FR_COL_HDR_H + 2 * FR_DEFAULT_ROW_H,
      5,
    );
  });

  it("on a WORKSHEET a range moves without Design Mode, and resizes only when selected", () => {
    // Owner decision 2026-09-27, replacing the 2026-08-13 button rule: the
    // title bar is the frame, not the working surface, so it moves the range
    // in every mode on every sheet kind. The handles exist only on a SELECTED
    // range, so an unselected one's corner boxes never take a cell click.
    upsertFromInfo(
      makeInfo({ id: "d", name: "Float1", hostSheetIndex: 0, rowCount: 1, colCount: 1 }),
    );
    setFrActiveSheetIndex(0);
    try {
      setDesignMode(false);
      syncFloatingRangeRegions();
      expect(regionData("d")).toMatchObject({ movable: true, resizable: false, bodyGrab: false });

      selectFloatingRange("d");
      syncFloatingRangeRegions();
      expect(regionData("d")).toMatchObject({ movable: true, resizable: true });

      setDesignMode(true);
      syncFloatingRangeRegions();
      expect(regionData("d")).toMatchObject({
        movable: true,
        resizable: true,
        // A title is shown, so even Design Mode leaves the body to the cells.
        bodyGrab: false,
      });
    } finally {
      setDesignMode(false);
    }
  });

  it("asks Core for its four CORNER handles only (the edge midpoints are the yellow balls)", () => {
    // Core's selection handles are eight by default and its resize scan runs
    // BEFORE the range's own zone answer, so a Core midpoint would take every
    // press meant for a ball (which scales the CELLS, not the counts).
    // `handles: "corners"` is how a region asks for the corners only
    // (core/lib/floatingHandles.ts `floatingHandleMode`).
    upsertFromInfo(makeInfo({ id: "d", name: "Float1", hostSheetIndex: 0, rowCount: 3, colCount: 3 }));
    setFrActiveSheetIndex(0);
    syncFloatingRangeRegions();
    expect(regionData("d").handles).toBe("corners");
    selectFloatingRange("d");
    syncFloatingRangeRegions();
    expect(regionData("d")).toMatchObject({ resizable: true, handles: "corners" });
  });

  it("asks Core for a HOVER GRIP exactly when its title is hidden (BUG-0258 design phase 5)", () => {
    // A title-less grid has only its 4px border band to be moved by: Core
    // shows the six-dot grip (core/lib/floatingGrip.ts) on a region that
    // publishes `grip: "hover"` while it is hovered or selected. A titled
    // grid moves by its title and publishes no grip flag at all.
    upsertFromInfo(makeInfo({ id: "t", hostSheetIndex: 0, showTitle: true }));
    upsertFromInfo(makeInfo({ id: "n", hostSheetIndex: 0, showTitle: false, name: "Float2" }));
    setFrActiveSheetIndex(0);
    syncFloatingRangeRegions();
    expect(regionData("t"), "a TITLED grid asks for a grip").not.toHaveProperty("grip");
    expect(regionData("n").grip).toBe("hover");
    // ...and the border band stays: the title-less grid is still frame at its edge.
    expect(regionData("n")).toMatchObject({ movable: true, handles: "corners" });
  });

  it("honors per-column width overrides in the derived width", () => {
    upsertFromInfo(
      makeInfo({
        id: "d",
        hostSheetIndex: 0,
        rowCount: 1,
        colCount: 2,
        colWidths: { 0: 100 },
      }),
    );
    setFrActiveSheetIndex(0);
    syncFloatingRangeRegions();
    const region = getGridRegions().find((r) => r.id === "fr-d");
    expect(region!.floating!.width).toBeCloseTo(
      FR_ROW_HDR_W + 100 + FR_DEFAULT_COL_W,
      5,
    );
  });
});

// ============================================================================
// Geometry on a LAYOUT SURFACE (a canvas) — owner decision 2026-09-27
// ============================================================================

describe("geometry flags on a layout surface", () => {
  /** The canvas's answer for sheet 0, mutable per test. */
  let surface: LayoutSurface | null;
  let unregister: (() => void) | null = null;

  function canvas(over: Partial<LayoutSurface> = {}): LayoutSurface {
    return {
      snapToGrid: true,
      gridSize: 16,
      showGrid: true,
      page: { width: 1280, height: 720 },
      editable: true,
      ...over,
    };
  }

  beforeEach(() => {
    surface = canvas();
    unregister = registerLayoutSurfaceProvider({ get: (i) => (i === 0 ? surface : null) });
    setFrActiveSheetIndex(0);
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
    setDesignMode(false);
  });

  it("an EDITABLE canvas with Design Mode OFF: movable, not resizable until selected, no body grab", () => {
    // THE owner's finding: the title-bar drag did nothing on a canvas because
    // the store published `movable: designMode`.
    upsertFromInfo(makeInfo({ id: "a", hostSheetIndex: 0 }));
    setDesignMode(false);
    syncFloatingRangeRegions();
    expect(regionData("a")).toMatchObject({ movable: true, resizable: false, bodyGrab: false });
  });

  it("a SUBSCRIBED canvas refuses everything, even in Design Mode on a selected range", () => {
    // This also closes the edge-scale hole: that gesture reads `resizable`
    // and never asks Core.
    surface = canvas({ editable: false });
    upsertFromInfo(makeInfo({ id: "a", hostSheetIndex: 0, showTitle: false }));
    selectFloatingRange("a");
    setDesignMode(true);
    syncFloatingRangeRegions();
    expect(regionData("a")).toMatchObject({ movable: false, resizable: false, bodyGrab: false });
  });

  it("a range the canvas LOCKS is neither movable nor resizable; its neighbour is", () => {
    surface = canvas({ isLocked: (r: GridRegion) => r.data?.frId === "d" });
    upsertFromInfo(makeInfo({ id: "d", hostSheetIndex: 0 }));
    upsertFromInfo(makeInfo({ id: "e", hostSheetIndex: 0, name: "Float2" }));
    selectFloatingRange("d");
    syncFloatingRangeRegions();
    expect(regionData("d")).toMatchObject({ movable: false, resizable: false });
    expect(regionData("e")).toMatchObject({ movable: true });
  });

  it("bodyGrab is Design Mode AND no title AND geometry editable — nothing else", () => {
    upsertFromInfo(makeInfo({ id: "t", hostSheetIndex: 0, showTitle: true }));
    upsertFromInfo(makeInfo({ id: "n", hostSheetIndex: 0, showTitle: false, name: "Float2" }));
    setDesignMode(false);
    syncFloatingRangeRegions();
    expect(regionData("t").bodyGrab).toBe(false);
    expect(regionData("n").bodyGrab).toBe(false);

    setDesignMode(true);
    syncFloatingRangeRegions();
    expect(regionData("t").bodyGrab).toBe(false);
    expect(regionData("n").bodyGrab).toBe(true);

    surface = canvas({ editable: false });
    syncFloatingRangeRegions();
    expect(regionData("n").bodyGrab).toBe(false);
  });

  it("re-publishes on its own when the SURFACE, the SELECTION or DESIGN MODE changes", () => {
    // A range can sync before the canvas store knows its sheet is a canvas,
    // and lock / subscribe / detach all change the answer later: without the
    // subscriptions the flag waits for some unrelated sync.
    const uninstall = installFrRegionResyncs();
    try {
      upsertFromInfo(makeInfo({ id: "a", hostSheetIndex: 0, showTitle: false }));
      syncFloatingRangeRegions();
      expect(regionData("a")).toMatchObject({ movable: true, resizable: false });

      selectFloatingRange("a");
      expect(regionData("a").resizable).toBe(true);
      deselectAllFloatingRanges();
      expect(regionData("a").resizable).toBe(false);

      setDesignMode(true);
      expect(regionData("a").bodyGrab).toBe(true);

      surface = canvas({ editable: false });
      notifyLayoutSurfaceChanged();
      expect(regionData("a")).toMatchObject({ movable: false, bodyGrab: false });
    } finally {
      uninstall();
    }
  });

  it("resizable stands down while one of the range's cells is EDITED, re-published on the editor's signal", () => {
    // Core's corner boxes read the published flag, not the extension's live
    // check, so the flag itself must follow the editor (owner, 2026-09-27: no
    // handle over the cell the user is typing in). The editor announces
    // itself through frEditingRange (proved in frEditorSession.test.ts).
    const uninstall = installFrRegionResyncs();
    try {
      upsertFromInfo(makeInfo({ id: "a", hostSheetIndex: 0 }));
      upsertFromInfo(makeInfo({ id: "b", hostSheetIndex: 0, name: "Float2" }));
      selectFloatingRange("a");
      expect(regionData("a").resizable).toBe(true);

      setFrEditingRange("a");
      expect(regionData("a")).toMatchObject({ resizable: false, movable: true });
      // Only the EDITED range's handles stand down.
      setFrEditingRange("b");
      expect(regionData("a").resizable).toBe(true);
      setFrEditingRange(null);
      expect(regionData("a").resizable).toBe(true);
    } finally {
      setFrEditingRange(null);
      uninstall();
    }
  });

  it("a range the canvas selection SET holds -- the second grid of a multi-selection -- is resizable too, like every family's set-held member", () => {
    // The family holds ONE range (no addToSelection), so a second selected
    // grid is held by the set (@api/objectSelection). Core outlines it; its
    // four corners are live only if the store says `resizable`.
    const uninstall = installFrRegionResyncs();
    const offProvider = registerObjectSelectionProvider({
      types: [FLOATING_RANGE_REGION_TYPE],
      isSelected: (r) => isFloatingRangeSelected(r.data?.frId as string),
      select: (r) => selectFloatingRange(r.data?.frId as string),
      deselectAll: () => deselectAllFloatingRanges(),
    });
    try {
      upsertFromInfo(makeInfo({ id: "a", hostSheetIndex: 0 }));
      upsertFromInfo(makeInfo({ id: "b", hostSheetIndex: 0, name: "Float2" }));
      setFrActiveSheetIndex(0);
      syncFloatingRangeRegions();
      const ra = getGridRegions().find((r) => r.id === "fr-a")!;
      const rb = getGridRegions().find((r) => r.id === "fr-b")!;
      setObjectSelectionSet([ra, rb], rb);
      expect(isFloatingRangeSelected("a"), "precondition: the SET holds a, not the family").toBe(false);
      expect(isFloatingRangeSelected("b")).toBe(true);
      expect(regionData("b").resizable).toBe(true);
      expect(regionData("a").resizable, "a set-held grid gets the outline but no handles").toBe(true);

      deselectAllObjects();
      expect(regionData("a").resizable).toBe(false);
      expect(regionData("b").resizable).toBe(false);
    } finally {
      offProvider();
      resetObjectSelectionProviders();
      uninstall();
    }
  });

  it("frGeometryEditable / frObjectEditable: one answer per range for every geometry door", () => {
    upsertFromInfo(makeInfo({ id: "a", hostSheetIndex: 0 }));
    upsertFromInfo(makeInfo({ id: "w", hostSheetIndex: 1, name: "Float2" }));

    // Editable canvas; a worksheet (no surface) always.
    expect(frGeometryEditable("a")).toBe(true);
    expect(frObjectEditable("a")).toBe(true);
    expect(frGeometryEditable("w")).toBe(true);
    expect(frObjectEditable("w")).toBe(true);

    // A lock freezes GEOMETRY only: the range can still be authored.
    surface = canvas({ isLocked: (r: GridRegion) => r.data?.frId === "a" });
    expect(frGeometryEditable("a")).toBe(false);
    expect(frObjectEditable("a")).toBe(true);

    // A subscribed canvas is the publisher's: nothing.
    surface = canvas({ editable: false });
    expect(frGeometryEditable("a")).toBe(false);
    expect(frObjectEditable("a")).toBe(false);
    expect(frGeometryEditable("w")).toBe(true);

    expect(frGeometryEditable("missing")).toBe(false);
    expect(frObjectEditable("missing")).toBe(false);
  });
});

// ============================================================================
// Debounced geometry persistence
// ============================================================================

describe("debounced geometry saves", () => {
  it("coalesces a drag stream into one backend write after 300 ms", async () => {
    vi.useFakeTimers();
    upsertFromInfo(makeInfo({ id: "e", hostSheetIndex: 0 }));

    moveFloatingRange("e", 110, 60);
    moveFloatingRange("e", 120, 70);
    moveFloatingRange("e", 130, 80);

    expect(updateFloatingRange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(updateFloatingRange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updateFloatingRange).toHaveBeenCalledTimes(1);
    expect(updateFloatingRange).toHaveBeenCalledWith("e", { x: 130, y: 80 });

    // The store reflects the last position synchronously.
    expect(getFloatingRangeById("e")?.x).toBe(130);
    expect(getFloatingRangeById("e")?.y).toBe(80);
  });

  it("flushPendingFloatingRangeSaves persists immediately (BEFORE_SAVE)", async () => {
    vi.useFakeTimers();
    upsertFromInfo(makeInfo({ id: "f", hostSheetIndex: 0 }));

    moveFloatingRange("f", 200, 210);
    expect(updateFloatingRange).not.toHaveBeenCalled();

    await flushPendingFloatingRangeSaves();
    expect(updateFloatingRange).toHaveBeenCalledTimes(1);
    expect(updateFloatingRange).toHaveBeenCalledWith("f", { x: 200, y: 210 });

    // The timer was cancelled — nothing double-fires later.
    await vi.advanceTimersByTimeAsync(400);
    expect(updateFloatingRange).toHaveBeenCalledTimes(1);
  });

  it("clamps moves to non-negative sheet coordinates", () => {
    upsertFromInfo(makeInfo({ id: "g", hostSheetIndex: 0 }));
    moveFloatingRange("g", -50, -10);
    expect(getFloatingRangeById("g")?.x).toBe(0);
    expect(getFloatingRangeById("g")?.y).toBe(0);
  });
});
