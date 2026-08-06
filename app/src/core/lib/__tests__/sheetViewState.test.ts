//! FILENAME: app/src/core/lib/__tests__/sheetViewState.test.ts
// The zoom FACTOR <-> PERCENT boundary, and the per-sheet view hydration.
//
// Zoom used to be frontend-only session state held as a render factor, while
// the script contract (`Calcula.getZoom()` / `api.setZoom`) and Excel's file
// format both speak percent. That mismatch was the "factor-vs-percent
// split-brain": `getZoom()` answered 1.0 on a 150%-zoomed workbook. There is
// now exactly ONE conversion site — this module — and these tests pin it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const getSheetZoom = vi.fn();
const setSheetZoom = vi.fn();
const getSplitWindow = vi.fn();
const getFreezePanes = vi.fn();

vi.mock("../tauri-api", () => ({
  getSheetZoom: (...a: unknown[]) => getSheetZoom(...a),
  setSheetZoom: (...a: unknown[]) => setSheetZoom(...a),
  getSplitWindow: (...a: unknown[]) => getSplitWindow(...a),
  getFreezePanes: (...a: unknown[]) => getFreezePanes(...a),
}));

import {
  ZOOM_PERCENT_MIN,
  ZOOM_PERCENT_MAX,
  zoomFactorToPercent,
  zoomPercentToFactor,
  loadSheetViewState,
  persistSheetZoom,
} from "../sheetViewState";
import { ZOOM_MIN, ZOOM_MAX } from "../../types";

beforeEach(() => {
  getSheetZoom.mockReset().mockResolvedValue(100);
  setSheetZoom.mockReset().mockResolvedValue(undefined);
  getSplitWindow.mockReset().mockResolvedValue({ splitRow: null, splitCol: null });
  getFreezePanes.mockReset().mockResolvedValue({ freezeRow: null, freezeCol: null });
});

describe("zoom factor <-> percent", () => {
  it.each([
    [1, 100],
    [1.5, 150],
    [0.6, 60],
    [0.25, 25],
    [4, 400],
    [0.1, 10],
  ])("factor %s is percent %s", (factor, percent) => {
    expect(zoomFactorToPercent(factor)).toBe(percent);
    expect(zoomPercentToFactor(percent)).toBeCloseTo(factor, 10);
  });

  it("clamps to the shared band rather than emitting a value the backend rejects", () => {
    expect(zoomFactorToPercent(50)).toBe(ZOOM_PERCENT_MAX);
    expect(zoomFactorToPercent(0.001)).toBe(ZOOM_PERCENT_MIN);
    expect(zoomPercentToFactor(5000)).toBe(ZOOM_PERCENT_MAX / 100);
    expect(zoomPercentToFactor(0)).toBe(ZOOM_PERCENT_MIN / 100);
  });

  it("survives garbage instead of poisoning the grid with NaN", () => {
    expect(zoomFactorToPercent(Number.NaN)).toBe(100);
    expect(zoomFactorToPercent(Number.POSITIVE_INFINITY)).toBe(100);
    expect(zoomPercentToFactor(Number.NaN)).toBe(1);
  });

  it("rounds to whole percents, the unit the file and Excel store", () => {
    expect(zoomFactorToPercent(0.6666)).toBe(67);
    expect(zoomFactorToPercent(1.234)).toBe(123);
  });
});

describe("one legal zoom band", () => {
  // The band used to disagree with itself: the reducer allowed 500% while the
  // script API capped at 400, so a user could reach a zoom that `api.setZoom`
  // would reject and that could not be saved at all.
  it("the reducer's factor band is exactly the persisted percent band", () => {
    expect(ZOOM_MIN * 100).toBe(ZOOM_PERCENT_MIN);
    expect(ZOOM_MAX * 100).toBe(ZOOM_PERCENT_MAX);
  });
});

describe("loadSheetViewState", () => {
  it("reads zoom, split AND freeze in the units the reducer wants", async () => {
    getSheetZoom.mockResolvedValue(60);
    getSplitWindow.mockResolvedValue({ splitRow: 12, splitCol: null });
    getFreezePanes.mockResolvedValue({ freezeRow: 1, freezeCol: 2 });

    const view = await loadSheetViewState();

    expect(view.zoomFactor).toBeCloseTo(0.6, 10);
    expect(view.splitRow).toBe(12);
    expect(view.splitCol).toBeNull();
    // A freeze is NOT a split: both come back, separately.
    expect(view.freezeRow).toBe(1);
    expect(view.freezeCol).toBe(2);
  });

  it("falls back to an unzoomed, unsplit sheet when the backend cannot answer", async () => {
    // Losing a zoom is bad; refusing to draw the sheet is worse.
    getSheetZoom.mockRejectedValue(new Error("command not found"));
    getSplitWindow.mockRejectedValue(new Error("command not found"));
    getFreezePanes.mockRejectedValue(new Error("command not found"));

    const view = await loadSheetViewState();

    expect(view.zoomFactor).toBe(1);
    expect(view.splitRow).toBeNull();
    expect(view.splitCol).toBeNull();
    expect(view.freezeRow).toBeNull();
    expect(view.freezeCol).toBeNull();
  });

  it("treats a missing split field as no split, not as undefined", async () => {
    getSplitWindow.mockResolvedValue({});
    const view = await loadSheetViewState();
    expect(view.splitRow).toBeNull();
    expect(view.splitCol).toBeNull();
  });
});

describe("persistSheetZoom", () => {
  it("writes the PERCENT, never the factor", async () => {
    await persistSheetZoom(1.5);
    expect(setSheetZoom).toHaveBeenCalledWith(150);
  });

  it("does not break interactive zooming when the write fails", async () => {
    setSheetZoom.mockRejectedValue(new Error("locked"));
    await expect(persistSheetZoom(1.25)).resolves.toBeUndefined();
  });
});
