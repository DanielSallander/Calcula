//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frMove.test.ts
// PURPOSE: A pointer move of a floating range is ONE write and therefore ONE
//          undo step, however long the user pauses mid-drag; a preview with no
//          completion leaves no position the backend does not have.
// CONTEXT: Preview frames used to persist through the store's 300 ms
//          debounce, so a human drag that paused wrote one "Move floating
//          range" undo entry per pause -- a defect a test driver's fast mouse
//          never shows (fr-move diagnosis, problem 5). Driven with Core's own
//          events, exactly as overlayMoveHandlers.ts dispatches them.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    rowCount: 1,
    colCount: 1,
    colWidths: {},
    rowHeights: {},
    name: "Float1",
    backingSheetIndex: 1,
    hostSheetIndex: 0,
  })),
}));

import { updateFloatingRange, type FloatingRangeInfo } from "@api/floatingRanges";
import { installFrMovePersistence } from "../frMove";
import {
  upsertFromInfo,
  resetFloatingRangeStore,
  getFloatingRangeById,
  setFrActiveSheetIndex,
  FLOATING_RANGE_REGION_TYPE,
} from "../floatingRangeStore";

const ID = "fr-a";

function info(): FloatingRangeInfo {
  return {
    id: ID,
    backingSheetId: "backing",
    hostSheetId: "host",
    x: 100,
    y: 50,
    rotation: 0,
    pinToGrid: false,
    rowCount: 2,
    colCount: 2,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float1",
    backingSheetIndex: 1,
    hostSheetIndex: 0,
  } as FloatingRangeInfo;
}

/** Core's move events, as overlayMoveHandlers.ts dispatches them. */
function core(type: "movePreview" | "moveComplete", x: number, y: number): void {
  window.dispatchEvent(
    new CustomEvent(`floatingObject:${type}`, {
      detail: {
        regionId: `fr-${ID}`,
        regionType: FLOATING_RANGE_REGION_TYPE,
        data: { frId: ID },
        x,
        y,
      },
    }),
  );
}

let uninstall: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetFloatingRangeStore();
  setFrActiveSheetIndex(0);
  upsertFromInfo(info());
  uninstall = installFrMovePersistence();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  resetFloatingRangeStore();
  vi.useRealTimers();
});

describe("a pointer move of a floating range", () => {
  it("writes NOTHING while previewing, even across pauses, and exactly once at completion", async () => {
    core("movePreview", 110, 60);
    // The range is SHOWN where the pointer has it...
    expect(getFloatingRangeById(ID)).toMatchObject({ x: 110, y: 60 });
    // ...and a human pause longer than the old 300 ms debounce writes nothing.
    await vi.advanceTimersByTimeAsync(400);
    core("movePreview", 150, 70);
    await vi.advanceTimersByTimeAsync(400);
    expect(updateFloatingRange).not.toHaveBeenCalled();

    core("moveComplete", 160, 80);
    // Landed at once (no debounce wait), so Ctrl+Z right after the drag finds it.
    await vi.advanceTimersByTimeAsync(0);
    expect(updateFloatingRange).toHaveBeenCalledTimes(1);
    expect(updateFloatingRange).toHaveBeenCalledWith(ID, { x: 160, y: 80 });

    // Nothing else trails behind it.
    await vi.advanceTimersByTimeAsync(1000);
    expect(updateFloatingRange).toHaveBeenCalledTimes(1);
  });

  it("puts a preview that was never completed back at mouseup (sub-threshold jitter on a worksheet)", async () => {
    core("movePreview", 102, 51);
    expect(getFloatingRangeById(ID)).toMatchObject({ x: 102, y: 51 });
    window.dispatchEvent(new MouseEvent("mouseup"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getFloatingRangeById(ID)).toMatchObject({ x: 100, y: 50 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(updateFloatingRange).not.toHaveBeenCalled();
  });

  it("a completion that arrives AFTER the mouseup (a latched mouseup Core replays) still lands", async () => {
    core("movePreview", 140, 90);
    window.dispatchEvent(new MouseEvent("mouseup"));
    await vi.advanceTimersByTimeAsync(0);
    core("moveComplete", 144, 96);
    await vi.advanceTimersByTimeAsync(0);
    expect(getFloatingRangeById(ID)).toMatchObject({ x: 144, y: 96 });
    expect(updateFloatingRange).toHaveBeenCalledTimes(1);
    expect(updateFloatingRange).toHaveBeenCalledWith(ID, { x: 144, y: 96 });
  });

  it("ignores another family's move events", async () => {
    window.dispatchEvent(
      new CustomEvent("floatingObject:moveComplete", {
        detail: { regionId: "chart-1", regionType: "chart", data: { chartId: 1 }, x: 5, y: 5 },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(updateFloatingRange).not.toHaveBeenCalled();
    expect(getFloatingRangeById(ID)).toMatchObject({ x: 100, y: 50 });
  });
});
