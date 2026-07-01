import { describe, it, expect, vi, beforeEach } from "vitest";

const registerGridOverlay = vi.fn().mockReturnValue(() => {});
const addGridRegions = vi.fn();
const removeGridRegionsByType = vi.fn();
const requestOverlayRedraw = vi.fn();

vi.mock("@api/gridOverlays", () => ({
  registerGridOverlay: (...a: unknown[]) => registerGridOverlay(...a),
  addGridRegions: (...a: unknown[]) => addGridRegions(...a),
  removeGridRegionsByType: (...a: unknown[]) => removeGridRegionsByType(...a),
  requestOverlayRedraw: (...a: unknown[]) => requestOverlayRedraw(...a),
  overlaySheetToCanvas: () => ({ canvasX: 0, canvasY: 0 }),
}));

import { installPlayOverlay, hitPill } from "../playOverlay";
import { playbackEngine } from "../../lib/animationEngine";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hitPill", () => {
  it("is true only inside the bounds", () => {
    const b = { x: 10, y: 20, width: 100, height: 26 };
    expect(hitPill(b, 10, 20)).toBe(true);
    expect(hitPill(b, 60, 33)).toBe(true);
    expect(hitPill(b, 110, 46)).toBe(true);
    expect(hitPill(b, 9, 33)).toBe(false);
    expect(hitPill(b, 60, 47)).toBe(false);
    expect(hitPill(undefined, 0, 0)).toBe(false);
  });
});

describe("installPlayOverlay", () => {
  it("registers an overlay and shows/hides the region with driver presence", async () => {
    await playbackEngine.clearDriver(); // frameCount = 0
    const cleanup = installPlayOverlay();
    expect(registerGridOverlay).toHaveBeenCalledTimes(1);
    expect(registerGridOverlay.mock.calls[0][0].type).toBe("animation-play");
    // No driver yet -> no region added.
    expect(addGridRegions).not.toHaveBeenCalled();

    // Load a driver (frameCount > 0) -> region appears (movable:false floating region).
    await playbackEngine.setClockCellDriver({ sheetIndex: 0, row: 0, col: 1, from: 0, to: 10, step: 1 });
    expect(addGridRegions).toHaveBeenCalledTimes(1);
    const region = addGridRegions.mock.calls[0][0][0];
    expect(region.type).toBe("animation-play");
    expect(region.data.movable).toBe(false);
    expect(region.floating).toMatchObject({ width: 172, height: 26 });

    // Clear the driver -> region removed.
    await playbackEngine.clearDriver();
    expect(removeGridRegionsByType).toHaveBeenCalledWith("animation-play");

    cleanup();
  });

  it("toggles playback on a floatingObject:selected for its region type", async () => {
    await playbackEngine.clearDriver();
    const cleanup = installPlayOverlay();
    const pause = vi.spyOn(playbackEngine, "pause");
    const play = vi.spyOn(playbackEngine, "play");

    // Wrong region type is ignored.
    window.dispatchEvent(new CustomEvent("floatingObject:selected", { detail: { regionType: "chart" } }));
    expect(play).not.toHaveBeenCalled();

    // Our region type toggles (idle -> play).
    window.dispatchEvent(new CustomEvent("floatingObject:selected", { detail: { regionType: "animation-play" } }));
    expect(play).toHaveBeenCalledTimes(1);

    pause.mockRestore();
    play.mockRestore();
    cleanup();
  });
});
