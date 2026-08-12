//! FILENAME: app/e2e/webview2Args.mjs
// PURPOSE: THE single definition of the WebView2 browser arguments every E2E
//          launch must use. Imported by BOTH launch paths.
// CONTEXT: There are two ways the app gets started for a suite —
//          `e2e/global-setup.ts` (automatic) and
//          `scratchpad/launch-vba-batch.ps1` -> `e2e/launch-app.mjs` (manual,
//          E2E_MANUAL=1) — and until now each carried its own copy of the
//          argument string. They had already drifted, invisibly and in the worst
//          possible direction:
//
//            global-setup.ts   --remote-debugging-port=N --force-color-profile=sRGB
//            launch-vba-batch  --remote-debugging-port=N --force-color-profile=sRGB
//            launch-app.mjs    --remote-debugging-port=N          <-- CLOBBERED
//
//          `launch-app.mjs` spread `process.env` and then reassigned
//          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, so the PowerShell launcher's
//          carefully documented colour-profile pin was discarded by the very
//          script it called. Every manual run — which is how this program's
//          suites are actually run — captured through the display profile
//          anyway. The pin was in the tree, in two files, with a paragraph
//          explaining why it was load-bearing, and it reached the app in
//          neither manual case.
//
// ============================================================================
// WHY EACH FLAG IS HERE. Both make a capture a function of the PAGE and nothing
// else. Neither is cosmetic; each one, when absent, invalidates the whole
// golden corpus at once and looks like a product regression.
// ============================================================================
//
// --force-color-profile=sRGB
//   Without it WebView2 rasterizes through the DISPLAY's colour profile, so a
//   golden encodes the monitor. Measured 2026-08-11: `StatusBar.tsx` is a
//   hard-coded `#217346` = rgb(33,115,70); goldens recorded on the wide-gamut
//   profile hold rgb(63,112,75). Fitting the two corpora against each other
//   recovers a textbook wide-gamut -> sRGB matrix (red row 1.379, -0.377,
//   -0.003 in linear light): NEUTRALS are bit-identical, saturated colour moves
//   by far more than the comparator gate.
//
// ============================================================================
// WHY THERE IS NO `--force-device-scale-factor` HERE. It was added, MEASURED,
// and removed — the measurement is the point and it must not be redone.
// ============================================================================
// The device pixel ratio really is the second, larger cause of the golden
// churn. `drawGridLines` (src/core/lib/gridRenderer/rendering/grid.ts) is the
// only stroke in the renderer at `lineWidth = 1 / deviceScale` — a true
// 1-DEVICE-pixel hairline, which is what makes the grid look like Excel's on a
// high-DPI screen — and `GridCanvas.draw` sets that transform to
// `devicePixelRatio * zoom`. A `toHaveScreenshot` capture is taken at CSS
// scale, so the hairline resolves to:
//
//     dpr = 1  ->  full coverage of #e2e2e2   ->  226,226,226
//     dpr = 2  ->  ~48% coverage over white   ->  241,241,241
//
// ~39,400 pixels of every grid golden against a 200-pixel budget. The two
// committed corpora sit on opposite sides of it: every functional golden holds
// 241, every visual golden holds 226.
//
// `--force-device-scale-factor=1` looked like the matching pin. IT IS NOT, and
// the reason is specific: Tauri sizes its window in LOGICAL units, so the CSS
// viewport is already scale-independent at 1280x800 and the grid layer is
// 1218x542 on a 100% display and on a 200% display alike. Forcing the scale
// factor to 1 makes CSS equal PHYSICAL, so on this 200% machine the viewport
// became 2560x1600 and the grid layer 2498x1342 — measured, not predicted.
// That does not stabilise the corpus, it invalidates every golden's SIZE.
//
//     no flag  ->  dpr 2, viewport 1280x800, grid layer 1218x542   (the corpus)
//     dsf=1    ->  dpr 1, viewport 2560x1600, grid layer 2498x1342 (nothing)
//
// So the LAYOUT is already pinned and only the hairline is not, and no browser
// flag can pin the hairline without unpinning the layout. The dpr is therefore
// treated as what it is — a property of the display the corpus was recorded on
// — and it is ASSERTED instead of forced: see `e2e/captureEnvironment.ts`,
// which fails one capture with a sentence instead of failing forty with a
// mystery.

/** The flags that make a screenshot reproducible. Order is not significant. */
export const DETERMINISTIC_CAPTURE_FLAGS = [
  "--force-color-profile=sRGB",
];

/**
 * The full WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS value for a launch.
 *
 * @param {number|string} cdpPort remote-debugging port
 * @param {string} [extra] anything a caller wants to add (kept last)
 */
export function webview2BrowserArguments(cdpPort, extra = "") {
  return [`--remote-debugging-port=${cdpPort}`, ...DETERMINISTIC_CAPTURE_FLAGS, extra]
    .filter(Boolean)
    .join(" ");
}
