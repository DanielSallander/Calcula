//! FILENAME: app/extensions/Animation/overlay/__tests__/playOverlay.test.ts
// PURPOSE: Pin the two properties D4 turned on: the play pill is a DOM overlay
//          that claims NO grid coordinates, and the product has a route to
//          unload a driver.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const registerOverlay = vi.fn();
const unregisterOverlay = vi.fn();
const showOverlay = vi.fn();
const hideOverlay = vi.fn();

vi.mock("@api/ui", () => ({
  registerOverlay: (...a: unknown[]) => registerOverlay(...a),
  unregisterOverlay: (...a: unknown[]) => unregisterOverlay(...a),
  showOverlay: (...a: unknown[]) => showOverlay(...a),
  hideOverlay: (...a: unknown[]) => hideOverlay(...a),
}));

import { installPlayOverlay, PLAY_PILL_OVERLAY_ID } from "../playOverlay";
import { PlayPill } from "../PlayPill";
import { playbackEngine } from "../../lib/animationEngine";
// The REAL registry, deliberately unmocked: a mock could only prove that a
// function nobody calls was not called. Reading the live region list proves the
// pill is absent from the thing the grid actually hit-tests.
import { getGridRegions } from "@api/gridOverlays";
import { animationBackend } from "../../lib/animationBackend";

const CLOCK_DRIVER = { sheetIndex: 0, row: 0, col: 1, from: 0, to: 10, step: 1 };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await playbackEngine.clearDriver();
});

describe("installPlayOverlay", () => {
  it("registers a DOM overlay, and shows/hides it with driver presence", async () => {
    await playbackEngine.clearDriver(); // frameCount = 0
    const cleanup = installPlayOverlay();

    expect(registerOverlay).toHaveBeenCalledTimes(1);
    const def = registerOverlay.mock.calls[0][0] as { id: string; component: unknown };
    expect(def.id).toBe(PLAY_PILL_OVERLAY_ID);
    expect(def.component).toBe(PlayPill);
    // No driver yet -> the pill is not shown.
    expect(showOverlay).not.toHaveBeenCalled();

    await playbackEngine.setClockCellDriver(CLOCK_DRIVER);
    expect(showOverlay).toHaveBeenCalledTimes(1);
    expect(showOverlay.mock.calls[0][0]).toBe(PLAY_PILL_OVERLAY_ID);

    // Playing / stepping must not re-show it once per state change.
    playbackEngine.setFps(20);
    expect(showOverlay).toHaveBeenCalledTimes(1);

    await playbackEngine.clearDriver();
    expect(hideOverlay).toHaveBeenCalledWith(PLAY_PILL_OVERLAY_ID);

    cleanup();
    expect(unregisterOverlay).toHaveBeenCalledWith(PLAY_PILL_OVERLAY_ID);
  });

  it("hides the pill and unregisters on cleanup while a driver is still loaded", async () => {
    const cleanup = installPlayOverlay();
    await playbackEngine.setClockCellDriver(CLOCK_DRIVER);
    hideOverlay.mockClear();

    cleanup();

    expect(hideOverlay).toHaveBeenCalledWith(PLAY_PILL_OVERLAY_ID);
    expect(unregisterOverlay).toHaveBeenCalledWith(PLAY_PILL_OVERLAY_ID);
  });

  /**
   * THE REGRESSION THIS WHOLE CHANGE EXISTS FOR (§2q / D4). The pill used to be
   * a floating GRID REGION anchored at a fixed sheet position, so it sat on
   * A1:C2 and swallowed the click. If anyone re-anchors it to the grid, this
   * fails: the region list is what Core hit-tests, so anything in it competes
   * with the cells.
   */
  it("claims no grid region — a loaded driver adds nothing the grid hit-tests", async () => {
    const before = getGridRegions().length;
    const cleanup = installPlayOverlay();
    await playbackEngine.setClockCellDriver(CLOCK_DRIVER);

    const regions = getGridRegions();
    expect(regions.length).toBe(before);
    expect(regions.some((r) => r.type.includes("animation"))).toBe(false);

    cleanup();
  });
});

describe("the product route to unload a driver", () => {
  it("clearDriver restores the model first, then unloads", async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "anim_snapshot") return { success: true, error: null };
      return { updatedCells: [], error: null };
    });
    animationBackend.set(invoke);

    await playbackEngine.setClockCellDriver(CLOCK_DRIVER);
    // Step once so a snapshot is on file and a transient frame has been applied.
    await playbackEngine.step(1);
    expect(invoke.mock.calls.map((c) => c[0])).toContain("anim_snapshot");
    expect(invoke.mock.calls.map((c) => c[0])).toContain("anim_apply_frame");

    await playbackEngine.clearDriver();

    // Restored (the transient guarantee) AND unloaded (the new route).
    expect(invoke.mock.calls.map((c) => c[0])).toContain("anim_restore");
    expect(playbackEngine.getState().frameCount).toBe(0);
    expect(playbackEngine.getState().status).toBe("idle");
    expect(playbackEngine.getExportSource()).toBeNull();
  });
});
