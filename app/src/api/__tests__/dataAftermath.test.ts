/**
 * FILENAME: app/src/api/__tests__/dataAftermath.test.ts
 * PURPOSE: The order is load-bearing, the cube round-trip must be FORCED, and
 *          the repaint must be the event that actually refetches.
 *
 * CONTEXT: this sequence drifted once already, between two Distribution call
 * sites, in the direction that loses data on screen. It is now shared with
 * BusinessIntelligence's "view as" role change. Two traps it must not fall
 * into again:
 *   - plain `calculateNow()` leaves CUBE cells alone unless a cube formula was
 *     TYPED this session, so a workbook the user merely opened keeps values
 *     computed under the previous role;
 *   - `AppEvents.GRID_REFRESH` only REDRAWS what the canvas already holds. The
 *     bare `grid:refresh` event is the one that refetches cell data. A fix
 *     that emits the wrong one looks correct in review and changes nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];
const calculateNow = vi.fn(async () => {
  calls.push("calculateNow");
  return [];
});
const recalcWithCube = vi.fn(async () => {
  calls.push("recalcWithCube");
  return [];
});
const refreshCache = vi.fn(async () => {
  calls.push("pivot.refreshCache");
});
const emitAppEvent = vi.fn((name: string) => {
  calls.push(`emit:${name}`);
});

vi.mock("../../core/lib/tauri-api", () => ({
  calculateNow: () => calculateNow(),
  recalcWithCube: () => recalcWithCube(),
}));
vi.mock("../events", () => ({
  emitAppEvent: (name: string) => emitAppEvent(name),
  AppEvents: { SHEET_CHANGED: "app:sheet-changed" },
}));
vi.mock("../pivot", () => ({
  pivot: {
    getAll: async () => [{ id: "p1" }, { id: "p2" }],
    refreshCache: (id: string) => refreshCache(id),
  },
}));

import { announceUnderlyingDataChanged } from "../dataAftermath";

describe("announceUnderlyingDataChanged", () => {
  beforeEach(() => {
    calls.length = 0;
    calculateNow.mockClear();
    recalcWithCube.mockClear();
    refreshCache.mockClear();
    emitAppEvent.mockClear();
  });

  it("forces the cube round-trip when asked, instead of a plain recalc", async () => {
    await announceUnderlyingDataChanged({ forceCube: true });
    expect(recalcWithCube).toHaveBeenCalledTimes(1);
    expect(calculateNow).not.toHaveBeenCalled();
  });

  it("uses a plain recalc when not asked", async () => {
    await announceUnderlyingDataChanged();
    expect(calculateNow).toHaveBeenCalledTimes(1);
    expect(recalcWithCube).not.toHaveBeenCalled();
  });

  it("refreshes pivots BEFORE recalculating — they write the cells formulas read", async () => {
    await announceUnderlyingDataChanged({ forceCube: true });
    const lastPivot = calls.lastIndexOf("pivot.refreshCache");
    const recalc = calls.indexOf("recalcWithCube");
    expect(lastPivot).toBeGreaterThanOrEqual(0);
    expect(recalc).toBeGreaterThan(lastPivot);
  });

  it("dispatches the BARE grid:refresh, which refetches — not the redraw-only app event", async () => {
    const seen: string[] = [];
    const listener = (e: Event): void => {
      seen.push(e.type);
    };
    window.addEventListener("grid:refresh", listener);
    try {
      await announceUnderlyingDataChanged({ forceCube: true });
    } finally {
      window.removeEventListener("grid:refresh", listener);
    }
    expect(seen).toContain("grid:refresh");
  });

  it("one pivot that will not refresh costs neither the recalc nor the repaint", async () => {
    refreshCache.mockImplementationOnce(async () => {
      calls.push("pivot.refreshCache");
      throw new Error("that pivot is broken");
    });
    const seen: string[] = [];
    const listener = (): void => {
      seen.push("refresh");
    };
    window.addEventListener("grid:refresh", listener);
    try {
      await announceUnderlyingDataChanged({ forceCube: true });
    } finally {
      window.removeEventListener("grid:refresh", listener);
    }
    expect(recalcWithCube).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });
});
