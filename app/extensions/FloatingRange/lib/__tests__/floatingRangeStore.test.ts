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
import { getGridRegions } from "@api/gridOverlays";
import { setDesignMode } from "@api/designMode";
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
  FLOATING_RANGE_REGION_TYPE,
} from "../floatingRangeStore";
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

beforeEach(() => {
  resetFloatingRangeStore();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  resetFloatingRangeStore();
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

  it("gates move/resize on DESIGN MODE — the button rule, not the shape rule", () => {
    // In run mode a floating range is a working surface: cells select and
    // edit, but a drag that relocates the object is layout work. Core
    // consults these two flags before starting either gesture, so this IS
    // the gate (owner decision 2026-08-13).
    upsertFromInfo(
      makeInfo({ id: "d", name: "Float1", hostSheetIndex: 0, rowCount: 1, colCount: 1 }),
    );
    setFrActiveSheetIndex(0);
    try {
      setDesignMode(false);
      syncFloatingRangeRegions();
      expect(getGridRegions().find((r) => r.id === "fr-d")!.data).toMatchObject({
        movable: false,
        resizable: false,
      });

      setDesignMode(true);
      syncFloatingRangeRegions();
      expect(getGridRegions().find((r) => r.id === "fr-d")!.data).toMatchObject({
        movable: true,
        resizable: true,
      });
    } finally {
      setDesignMode(false);
    }
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
