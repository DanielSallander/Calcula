//! FILENAME: app/e2e/helpers/screenshotGates.ts
// PURPOSE: THE single source of truth for the visual comparator gates.
// CONTEXT: Imported by BOTH `playwright.config.ts` (as the project-wide
//          `expect.toHaveScreenshot` default) and `e2e/helpers/screenshots.ts`
//          (spread into every helper capture). Nothing else may declare these
//          numbers.
//
// WHY IT IS ITS OWN MODULE. The two consumers previously carried their own
// copies of `threshold` / `maxDiffPixels` / `maxDiffPixelRatio`, "kept in sync"
// by a comment in each pointing at the other. That is not a mechanism: nothing
// failed if they drifted, and the two are not interchangeable —
//
//   * the CONFIG value governs every `toHaveScreenshot()` written directly in a
//     spec, i.e. exactly the assertions that do NOT go through the helper; and
//   * the HELPER value governs everything that does.
//
// so a drift would have silently loosened one half of the suite while the other
// stayed tight, and the reviewer reading either file would have seen the right
// number. One module, two importers, no sync to forget.
//
// ============================================================================
// HOW THE NUMBERS WERE MEASURED — do not change without redoing this
// ============================================================================
// `threshold` is pixelmatch's YIQ colour-distance gate, NOT a per-channel
// tolerance: a pixel is COUNTED as different only when its squared YIQ distance
// exceeds 35215 * threshold^2. It is the setting that decides whether the suite
// can see the grid at all.
//
// Measured on the default skin (re-measure if the skin changes): gridlines paint
// #f1f1f1 on white (ΔY 14) and the faintest hairline #f5f5f5 (ΔY 10).
// pixelmatch stops seeing them above threshold 0.053 and 0.038 respectively. At
// the old 0.2 an ENTIRELY ERASED gridline scored literally 0 differing pixels —
// no grid-geometry change could ever fail. At 0.02 the same defect scores 520
// (vertical) / 1193 (horizontal) / 1042 (shifted 1px). 0.02 keeps ~2x margin on
// the faintest line the renderer paints. Run-to-run noise at 0.02 was 0 pixels
// on 74 of 76 captures.
//
// The pixel budget is the second half of the gate:
// min(maxDiffPixels, maxDiffPixelRatio * imagePixels). The old 0.005 ratio
// allowed 3425 pixels on a grid capture — six whole gridlines' worth — so a
// tighter threshold alone would still have passed single-line defects. 200 sits
// at the geometric mean of the measured noise ceiling (77 px: the marching-ants
// copy border, the only non-deterministic thing in either suite over two cold
// runs of all 76 captures — everything else was bit-identical) and the smallest
// single-line defect (520 px). On small captures the ratio binds: ~15 px on a
// status-bar strip, ~9 px on a region crop.
//
// DO NOT LOOSEN THESE TO MAKE A SHOT PASS. A shot that cannot hold this gate is
// capturing something non-deterministic; fix the capture.
// ============================================================================

/** The comparator gates. Effective budget = min(maxDiffPixels, ratio * px). */
export const SCREENSHOT_COMPARATOR_GATES = {
  /** Hard cap: 200 px on a full-grid capture. */
  maxDiffPixels: 200,
  /** Scales the cap down on small crops: 0.05% of the image. */
  maxDiffPixelRatio: 0.0005,
  /** YIQ colour-distance gate — must stay below 0.038 to see a gridline. */
  threshold: 0.02,
} as const;

/** The gates plus the capture-time settings every screenshot shares. */
export const SCREENSHOT_DEFAULTS = {
  ...SCREENSHOT_COMPARATOR_GATES,
  animations: "disabled",
} as const;
