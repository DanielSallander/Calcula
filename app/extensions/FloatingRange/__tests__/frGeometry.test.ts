//! FILENAME: app/extensions/FloatingRange/__tests__/frGeometry.test.ts
// PURPOSE: The floating range's geometry provider (M8 part C): POSITION only
//          (its frame size is whole rows and columns); preview writes nothing;
//          commit schedules the debounced write and FLUSHES it, so it has
//          landed when the commit resolves; a refused write puts the range back
//          where the backend has it and REJECTS (no toast of its own -- the
//          seam reports once); and the drag's own debounced save no longer
//          swallows a refusal: it reverts and says so.

import { describe, it, expect, vi, beforeEach } from "vitest";

const updateFloatingRange = vi.fn(async (..._a: unknown[]) => ({}));
const listFloatingRanges = vi.fn(async () => [] as unknown[]);
vi.mock("@api/floatingRanges", () => ({
  listFloatingRanges: () => listFloatingRanges(),
  updateFloatingRange: (...a: unknown[]) => updateFloatingRange(...a),
}));

const toasts: string[] = [];
vi.mock("@api/notifications", () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import {
  flushPendingFloatingRangeSaves,
  getFloatingRangeById,
  moveFloatingRange,
  resetFloatingRangeStore,
  upsertFromInfo,
  FLOATING_RANGE_REGION_TYPE,
} from "../lib/floatingRangeStore";
import { createFloatingRangeGeometryProvider } from "../lib/frGeometry";
import type { FloatingRangeInfo } from "@api/floatingRanges";
import type { GridRegion } from "@api/gridOverlays";

function info(x: number, y: number): FloatingRangeInfo {
  return {
    id: "fr1",
    backingSheetId: "b",
    hostSheetId: "h",
    x,
    y,
    rotation: 0,
    pinToGrid: false,
    rowCount: 3,
    colCount: 2,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float1",
    backingSheetIndex: 3,
    hostSheetIndex: 0,
  };
}

const region: GridRegion = {
  id: "fr-fr1",
  type: FLOATING_RANGE_REGION_TYPE,
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 10, y: 20, width: 200, height: 90 },
  data: { frId: "fr1" },
};

beforeEach(() => {
  resetFloatingRangeStore();
  updateFloatingRange.mockReset();
  updateFloatingRange.mockResolvedValue({});
  listFloatingRanges.mockReset();
  listFloatingRanges.mockResolvedValue([info(10, 20)]);
  toasts.length = 0;
  upsertFromInfo(info(10, 20));
});

describe("the floating range geometry provider", () => {
  it("is position-only", () => {
    expect(createFloatingRangeGeometryProvider().canResize?.(region)).toBe(false);
  });

  it("preview moves the range and writes nothing", async () => {
    createFloatingRangeGeometryProvider().preview!([{ region, x: 50, y: 60, width: 200, height: 90 }]);
    expect(getFloatingRangeById("fr1")).toMatchObject({ x: 50, y: 60 });
    await new Promise((r) => setTimeout(r, 350));
    expect(updateFloatingRange).not.toHaveBeenCalled();
  });

  it("commit has LANDED the write when it resolves", async () => {
    await createFloatingRangeGeometryProvider().commit([{ region, x: 70, y: 80, width: 200, height: 90 }]);
    expect(updateFloatingRange).toHaveBeenCalledWith("fr1", { x: 70, y: 80 });
  });

  it("a REFUSED write puts the range back where the backend has it and rejects, with no toast of its own", async () => {
    updateFloatingRange.mockRejectedValue(new Error("The sheet is protected."));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      createFloatingRangeGeometryProvider().commit([{ region, x: 70, y: 80, width: 200, height: 90 }]),
    ).rejects.toThrow("The sheet is protected.");
    errors.mockRestore();
    expect(getFloatingRangeById("fr1")).toMatchObject({ x: 10, y: 20 });
    expect(toasts).toEqual([]);
  });
});

describe("the drag's own debounced save", () => {
  it("a refusal is no longer swallowed: the range reverts and the user is told once", async () => {
    updateFloatingRange.mockRejectedValue(new Error("The sheet is protected."));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    moveFloatingRange("fr1", 300, 300);
    await flushPendingFloatingRangeSaves();
    errors.mockRestore();
    expect(getFloatingRangeById("fr1")).toMatchObject({ x: 10, y: 20 });
    expect(toasts).toHaveLength(1);
  });

  it("a flush that finds nothing dirty still waits for a save in flight", async () => {
    let release!: () => void;
    updateFloatingRange.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({});
        }),
    );
    moveFloatingRange("fr1", 30, 30);
    const first = flushPendingFloatingRangeSaves();
    let second = false;
    const waiting = flushPendingFloatingRangeSaves().then(() => {
      second = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(second).toBe(false);
    release();
    await first;
    await waiting;
    expect(second).toBe(true);
  });
});
