//! FILENAME: app/e2e/captureEnvironment.ts
// PURPOSE: The display configuration the screenshot corpus was recorded under,
//          asserted ONCE per run instead of discovered as forty mystery diffs.
// CONTEXT: A golden is a function of the page AND of the display. The colour
//          profile half of that is forced (`webview2Args.mjs`). The DEVICE PIXEL
//          RATIO half cannot be forced without breaking something bigger, and
//          the measurement that says so is recorded there.
//
//          What dpr changes is exactly one thing, and it is the most-repeated
//          thing in a grid capture. `drawGridLines` strokes a true 1-DEVICE-pixel
//          hairline (`lineWidth = 1 / deviceScale`), which is what keeps the grid
//          crisp on a high-DPI screen, and a `toHaveScreenshot` capture is taken
//          at CSS scale:
//
//              dpr 1 -> the hairline fills one CSS pixel   -> 226,226,226
//              dpr 2 -> it covers about half of one        -> 241,241,241
//
//          That is ~39,400 pixels per grid golden against a 200-pixel budget. So
//          moving the app to a display with a different scale factor invalidates
//          the whole corpus at once — and it presents as dozens of unexplained
//          failures spread across a dozen specs, which is precisely how two
//          passes of this program were spent.
//
//          MEASURED 2026-08-11, and it is the evidence for the numbers below:
//          the committed `e2e/tests` corpus holds 241 and the committed
//          `e2e/visual` corpus holds 226, at the SAME 1218x542 size. Both are
//          the same window: Tauri sizes in LOGICAL units, so the CSS viewport is
//          1280x800 either way. The two corpora were recorded on two different
//          displays, and nothing said so.
//
// THIS FILE IS THE STATEMENT OF WHAT THE CORPUS ASSUMES. When the corpus is
// re-recorded on a different display, update it IN THE SAME COMMIT — that is the
// whole mechanism.

/** The display configuration every committed golden was captured under. */
export const CAPTURE_ENVIRONMENT = {
  /**
   * `window.devicePixelRatio` at capture time.
   *
   * 2 = the machine's 200% display. The `e2e/tests` and `e2e/scenarios` corpora
   * hold the dpr-2 hairline (241,241,241).
   */
  devicePixelRatio: 2,
  /**
   * The CSS size of `[data-grid-canvas-layer]`, i.e. the frame of every
   * `takeGridScreenshot` golden. Scale-independent (Tauri sizes logically), so a
   * mismatch here means the WINDOW changed, not the display.
   */
  gridCanvasLayer: { width: 1218, height: 542 },
  /** The CSS viewport. Same reasoning as above. */
  viewport: { width: 1280, height: 800 },
  /**
   * The COLOUR PROFILE the corpus was captured under.
   *
   * `"srgb"` = `--force-color-profile=sRGB` was in force, so a capture holds
   * the colours the app DECLARES: `#217346` as 33,115,70 and `#10b981` as
   * 16,185,129, bit-exact. `"display"` = the capture went through this
   * machine's wide-gamut display profile and holds 63,112,75 / 95,180,134
   * instead.
   *
   * Unlike the device pixel ratio, this one IS forced -- `webview2Args.mjs` is
   * the single definition and both launch paths import it. So a corpus on the
   * wrong side of this is either older than that fix (re-record it) or evidence
   * that the pin has been lost again (fix the launcher). `goldenCorpus.ts`
   * measures the committed bytes against this value and says which.
   *
   * MEASURED 2026-08-11: the whole corpus predated the pin reaching the manual
   * path, which is what 31 of the functional suite's 31 failures were.
   */
  colourProfile: "srgb",
} as const;

export interface CaptureEnvironmentReading {
  devicePixelRatio: number;
  gridCanvasLayer: { width: number; height: number } | null;
  viewport: { width: number; height: number };
}

/**
 * Compare a reading against the corpus's environment.
 *
 * Returns null when they agree, and otherwise the sentence a failing capture
 * should carry. PURE, so the wording — which is the entire value of the guard —
 * has a unit tier and cannot decay back into "screenshot comparison failed".
 */
export function describeCaptureEnvironmentMismatch(
  reading: CaptureEnvironmentReading,
): string | null {
  const problems: string[] = [];

  if (reading.devicePixelRatio !== CAPTURE_ENVIRONMENT.devicePixelRatio) {
    const hairline = reading.devicePixelRatio > 1 ? "241,241,241" : "226,226,226";
    const expected =
      CAPTURE_ENVIRONMENT.devicePixelRatio > 1 ? "241,241,241" : "226,226,226";
    problems.push(
      `devicePixelRatio is ${reading.devicePixelRatio}, but every committed golden was ` +
        `recorded at ${CAPTURE_ENVIRONMENT.devicePixelRatio}.\n` +
        `    The grid hairline is stroked at 1 DEVICE pixel and captured at CSS scale, so it ` +
        `paints ${hairline} here against ${expected} in the goldens — about 39,400 pixels of ` +
        `every grid capture, against a 200-pixel budget.\n` +
        `    EVERY GRID GOLDEN WILL FAIL, and none of those failures is about the product. ` +
        `Move the app back to a ${CAPTURE_ENVIRONMENT.devicePixelRatio === 2 ? "200%" : "100%"} ` +
        `display, or re-record the corpus and update e2e/captureEnvironment.ts in the same change.`,
    );
  }

  const layer = reading.gridCanvasLayer;
  if (
    layer &&
    (layer.width !== CAPTURE_ENVIRONMENT.gridCanvasLayer.width ||
      layer.height !== CAPTURE_ENVIRONMENT.gridCanvasLayer.height)
  ) {
    problems.push(
      `the grid canvas layer is ${layer.width}x${layer.height}, but the goldens are ` +
        `${CAPTURE_ENVIRONMENT.gridCanvasLayer.width}x${CAPTURE_ENVIRONMENT.gridCanvasLayer.height}.\n` +
        `    Every grid golden will fail on SIZE. The window is not the size the corpus was ` +
        `recorded at — check the e2e Tauri config, and check that no launch is forcing a ` +
        `device scale factor (that makes the CSS viewport equal the PHYSICAL one, which ` +
        `defeats Tauri's logical window sizing).`,
    );
  }

  if (problems.length === 0) return null;
  return (
    `[screenshot] THE CAPTURE ENVIRONMENT DOES NOT MATCH THE GOLDEN CORPUS.\n` +
    problems.map((p) => `  - ${p}`).join("\n")
  );
}
