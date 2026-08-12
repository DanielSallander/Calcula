//! FILENAME: app/e2e/__tests__/captureEnvironment.test.ts
// PURPOSE: The guard's VALUE IS ITS WORDING, so the wording is pinned.
// CONTEXT: `describeCaptureEnvironmentMismatch` exists to convert "forty grid
//          goldens failed and nobody knows why" into one sentence naming the
//          display. A guard whose message nothing checks decays into
//          "screenshot comparison failed" on the first refactor — which is how
//          this corpus came to have two mutually incompatible halves in the
//          first place. Each arm is driven to FAIL here, not just to pass.

import { describe, it, expect } from "vitest";
import {
  CAPTURE_ENVIRONMENT,
  describeCaptureEnvironmentMismatch,
} from "../captureEnvironment";

/** A reading that matches the corpus exactly. */
const matching = {
  devicePixelRatio: CAPTURE_ENVIRONMENT.devicePixelRatio,
  gridCanvasLayer: { ...CAPTURE_ENVIRONMENT.gridCanvasLayer },
  viewport: { ...CAPTURE_ENVIRONMENT.viewport },
  compositedCanvasLayers: CAPTURE_ENVIRONMENT.compositedCanvasLayers,
};

describe("capture environment guard", () => {
  it("says nothing when the display matches the corpus", () => {
    expect(describeCaptureEnvironmentMismatch(matching)).toBeNull();
  });

  it("names the DEVICE PIXEL RATIO, the hairline, and the scale to go back to", () => {
    const msg = describeCaptureEnvironmentMismatch({ ...matching, devicePixelRatio: 1 });
    expect(msg).not.toBeNull();
    // The number that is wrong, and the number it should be.
    expect(msg).toContain("devicePixelRatio is 1");
    expect(msg).toContain(String(CAPTURE_ENVIRONMENT.devicePixelRatio));
    // The MECHANISM, so the reader does not have to rediscover it.
    expect(msg).toContain("hairline");
    expect(msg).toContain("226,226,226");
    expect(msg).toContain("241,241,241");
    // The consequence, stated so the failures are not mistaken for regressions.
    expect(msg).toContain("EVERY GRID GOLDEN WILL FAIL");
    // The two ways out.
    expect(msg).toContain("200%");
    expect(msg).toContain("e2e/captureEnvironment.ts");
  });

  it("names a WINDOW size change separately — it is a different fix", () => {
    const msg = describeCaptureEnvironmentMismatch({
      ...matching,
      gridCanvasLayer: { width: 2498, height: 1342 },
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("2498x1342");
    expect(msg).toContain(
      `${CAPTURE_ENVIRONMENT.gridCanvasLayer.width}x${CAPTURE_ENVIRONMENT.gridCanvasLayer.height}`,
    );
    expect(msg).toContain("SIZE");
    // The specific trap that produced this exact number on this machine.
    expect(msg).toContain("device scale factor");
    // It must NOT also blame the dpr, which is correct in this reading.
    expect(msg).not.toContain("devicePixelRatio is");
  });

  it("reports BOTH when both are wrong, rather than stopping at the first", () => {
    const msg = describeCaptureEnvironmentMismatch({
      devicePixelRatio: 1,
      gridCanvasLayer: { width: 2498, height: 1342 },
      viewport: { width: 2560, height: 1600 },
    });
    expect(msg).toContain("devicePixelRatio is 1");
    expect(msg).toContain("2498x1342");
  });

  it("does not complain about a missing grid layer — a dialog capture has none", () => {
    // `takeDialogScreenshot` runs on pages where the grid may not be mounted.
    // Treating "absent" as "wrong size" would fail every dialog golden.
    expect(
      describeCaptureEnvironmentMismatch({ ...matching, gridCanvasLayer: null }),
    ).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // THE THIRD AXIS — a COMPOSITED CANVAS, which is what BUG-0028 was.
  //
  // The dpr and colour-profile arms above are both properties of the DISPLAY.
  // This one is a property of the COMPOSITOR, and it is the only axis of the
  // three that the app itself can flip at runtime: reading the grid canvas back
  // often enough (the `rendering` capture seam does) makes Chromium drop GPU
  // acceleration for it, which un-composites the canvas, which un-composites
  // every overlay drawn over it, which switches those overlays' text from
  // grayscale back to LCD antialiasing.
  // ---------------------------------------------------------------------------

  it("names a COMPOSITED CANVAS, the antialiasing it changes, and the ledger id", () => {
    const msg = describeCaptureEnvironmentMismatch({
      ...matching,
      compositedCanvasLayers: 1,
    });
    expect(msg).not.toBeNull();
    // What was read, and what the corpus assumes.
    expect(msg).toContain("1 canvas(es) are COMPOSITED");
    expect(msg).toContain(String(CAPTURE_ENVIRONMENT.compositedCanvasLayers));
    // The MECHANISM, in the order it actually runs.
    expect(msg).toContain("overlay");
    expect(msg).toContain("LCD");
    expect(msg).toContain("GRAYSCALE");
    // The ledger entry, so the next reader finds the measurement.
    expect(msg).toContain("BUG-0028");
    // The remedy, and the one that must NOT be reached for.
    expect(msg).toContain("--disable-accelerated-2d-canvas");
    expect(msg).toContain("do NOT re-record");
    // It must not also blame the display, which is correct in this reading.
    expect(msg).not.toContain("devicePixelRatio is");
  });

  it("treats an UNREADABLE layer tree as a failure, not as agreement", () => {
    // A guard that cannot run is not a guard that passed. `null` is what the
    // helper returns when no CDP session or no LayerTree domain is available.
    const msg = describeCaptureEnvironmentMismatch({
      ...matching,
      compositedCanvasLayers: null,
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("could not be read");
    expect(msg).toContain("unverified");
  });

  it("stays silent when the reading simply does not carry the axis", () => {
    // `takeDialogScreenshot` and `takeRibbonScreenshot` call the guard on a
    // reading assembled without a CDP session in some callers' tests; an ABSENT
    // field is not the same claim as an unreadable layer tree, and must not be
    // reported as one.
    const { compositedCanvasLayers, ...withoutAxis } = matching;
    void compositedCanvasLayers;
    expect(describeCaptureEnvironmentMismatch(withoutAxis)).toBeNull();
  });
});
