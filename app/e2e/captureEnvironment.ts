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
//
// ---------------------------------------------------------------------------
// MEASURED 2026-08-18: THESE TWO ASSUMPTIONS CANNOT BOTH HOLD ON A 2560x1440
// PANEL, so on that hardware the corpus is unreproducible and EVERY grid golden
// fails before a pixel is compared.
// ---------------------------------------------------------------------------
// `devicePixelRatio: 2` requires 200% scaling. Scaling divides the LOGICAL
// desktop, and Tauri sizes its window in logical units — so the two demands pull
// against each other on a panel that is not tall enough:
//
//   100%  dpr 1  screen 2560x1440  viewport 1280x800  grid 1218x542  <- SIZE ok, DPR wrong
//   200%  dpr 2  screen 1280x720   viewport 1280x700  grid 1218x442  <- DPR ok, SIZE wrong
//
// At 200% the whole logical desktop is 720 tall (672 after the taskbar) and the
// corpus needs an 800-tall viewport. Note the WIDTH is exactly 1280 in both
// modes: this is not a window-config problem that can be tuned around, it is the
// panel. The corpus was recorded somewhere with more logical height at 200% —
// 3840x2160 gives 1920x1080, which fits easily.
//
// So a machine like this has exactly two honest options: record on a panel that
// can host 1280x800 at 200%, or re-record the corpus at dpr 1 and change the
// `devicePixelRatio` below to 1 in the same commit. There is no third setting
// that satisfies the current values.

/** The display configuration every committed golden was captured under. */
export const CAPTURE_ENVIRONMENT = {
  /**
   * `window.devicePixelRatio` at capture time.
   *
   * **1 as of 2026-08-18**, when the whole corpus was re-recorded at 100%.
   *
   * WHY IT MOVED, because "we changed machines" is not the reason and the real
   * one constrains any future change. The previous value, 2, came from a display
   * whose 200% logical desktop was 1472x920 (GDI DESKTOPHORZRES 2944 / HORZRES
   * 1472) — tall enough to host the 1280x800 window the corpus also assumes. On a
   * 2560x1440 panel, 200% gives a logical desktop of 1280x720, so `dpr: 2` and
   * `viewport: 1280x800` became MUTUALLY EXCLUSIVE and every grid golden failed
   * before a pixel was compared. See the block at the top of this file for the
   * measurement.
   *
   * So the corpus now holds the dpr-1 hairline (226,226,226) rather than the
   * dpr-2 one (241,241,241), across all three trees. The GEOMETRY is unchanged —
   * 1280x800 / 1218x542 are identical at either scaling, because Tauri sizes its
   * window in logical units — which is what made this a safe move to make: the
   * only thing that legitimately differs between the old corpus and the new is
   * the hairline.
   */
  devicePixelRatio: 1,
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
  /**
   * How many COMPOSITED layers may carry the `Canvas` compositing reason.
   *
   * ZERO, and it is forced -- `--disable-accelerated-2d-canvas` in
   * `webview2Args.mjs`, where the measurement lives. This is the third axis of
   * the same kind as the two above, and the one that made four goldens a
   * function of how long the app had been running (BUG-0028):
   *
   *   an accelerated 2D canvas is its own composited layer
   *     -> every DOM overlay that OVERLAPS it is composited too (`Overlap`)
   *       -> Chromium will not use LCD text on a layer it cannot prove opaque
   *         -> the overlay's text is GRAYSCALE-antialiased while the rest of
   *            the window stays LCD.
   *
   * Measured 2026-08-12: the open File menu's text held 0 chromatic pixels with
   * the canvas accelerated and 1,575 without, in the same 165x310 region, on
   * one app, three seconds apart -- the only thing between the two readings
   * being 120 `getImageData` calls, which is what Chromium's expensive-canvas
   * heuristic watches for. The app makes those calls itself, through the
   * `rendering` capture seam.
   *
   * UNLIKE the dpr, this one cannot be read off the committed bytes: LCD text
   * is a property of each composited LAYER, not of the frame, so one capture
   * holds both kinds at once and a per-file census over the corpus cannot
   * express it (see the head of `goldenCorpus.ts`). It is therefore asserted
   * against the RUN, here, which is the only place the question is answerable.
   */
  compositedCanvasLayers: 0,
} as const;

export interface CaptureEnvironmentReading {
  devicePixelRatio: number;
  gridCanvasLayer: { width: number; height: number } | null;
  viewport: { width: number; height: number };
  /**
   * Layers in the compositor whose reason includes `Canvas`.
   *
   * `null` means the layer tree could not be read at all (no CDP session, or
   * the `LayerTree` domain refused). That is reported as its own failure rather
   * than passed over: a guard that cannot run must say so, not return quietly.
   */
  compositedCanvasLayers?: number | null;
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
        `Move the app back to a ${CAPTURE_ENVIRONMENT.devicePixelRatio * 100}% ` +
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

  if (reading.compositedCanvasLayers === null) {
    problems.push(
      `the compositor's layer tree could not be read, so the TEXT ANTIALIASING ` +
        `condition this corpus assumes is unverified.\n` +
        `    A guard that cannot run must say so rather than pass. Check that the ` +
        `capture helper can open a CDP session and enable the LayerTree domain; ` +
        `if the suite has genuinely moved off Chromium, this axis needs a new ` +
        `instrument, not a deletion.`,
    );
  } else if (
    reading.compositedCanvasLayers !== undefined &&
    reading.compositedCanvasLayers !== CAPTURE_ENVIRONMENT.compositedCanvasLayers
  ) {
    problems.push(
      `${reading.compositedCanvasLayers} canvas(es) are COMPOSITED, but the corpus ` +
        `assumes ${CAPTURE_ENVIRONMENT.compositedCanvasLayers}.\n` +
        `    An accelerated 2D canvas gets its own composited layer, every DOM ` +
        `overlay that OVERLAPS it is then composited too, and Chromium will not ` +
        `use LCD (subpixel) text on a layer it cannot prove opaque — so every ` +
        `menu, dropdown and dialog drawn over the grid switches from LCD to ` +
        `GRAYSCALE antialiasing while the rest of the window does not. Measured: ` +
        `~2,900 differing pixels in one dropdown against a 200-pixel budget, with ` +
        `nothing about the product changed. This is BUG-0028.\n` +
        `    --disable-accelerated-2d-canvas (e2e/webview2Args.mjs) is what keeps ` +
        `this at 0. If it is reaching the WebView and a canvas is composited ` +
        `anyway, the flag has stopped working and the corpus is no longer ` +
        `reproducible — fix the launcher, do NOT re-record.`,
    );
  }

  if (problems.length === 0) return null;
  return (
    `[screenshot] THE CAPTURE ENVIRONMENT DOES NOT MATCH THE GOLDEN CORPUS.\n` +
    problems.map((p) => `  - ${p}`).join("\n")
  );
}
