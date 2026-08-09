/**
 * Screenshot helpers for visual regression testing.
 *
 * Provides utilities for taking consistent, labeled screenshots at defined
 * checkpoints. Screenshots are compared against golden baselines using
 * Playwright's built-in toHaveScreenshot().
 *
 * Usage in tests:
 *   import { takeCheckpoint, takeGridScreenshot, takeDialogScreenshot } from "../helpers/screenshots";
 *
 *   await takeCheckpoint(page, "empty-grid-default");
 *   await takeGridScreenshot(page, "after-data-entry");
 *   await takeDialogScreenshot(page, "format-cells-dialog", ".dialog-container");
 */
import { type Page, type Locator, expect } from "@playwright/test";
import { readGridGeometry, cellRangeRectFrom, parseCellRef, type GridGeometry } from "./grid";
import { SCREENSHOT_DEFAULTS } from "./screenshotGates";

// ============================================================================
// Selector resolution
//
// EVERY capture helper in this file resolves its target through `resolveOne`.
//
// The rule it enforces: a screenshot helper that cannot find what it was asked
// to photograph must FAIL, never return. Two helpers here used to do the
// opposite — `takeStatusBarScreenshot` returned silently when its selector
// matched nothing, and `takeRibbonScreenshot` fell back to a fixed page clip —
// so both phantom-passed for months against selectors that match zero nodes in
// the shipping app. A helper that silently succeeds is worse than no test: the
// suite reports coverage it does not have.
// ============================================================================

/**
 * Resolve the first of `selectors` that matches exactly one VISIBLE element.
 *
 * Throws with the full list of candidates and what each one matched when
 * nothing usable is found — the failure message must be enough to fix the
 * selector without re-running under a debugger.
 */
async function resolveOne(
  page: Page,
  description: string,
  selectors: string[]
): Promise<Locator> {
  const report: string[] = [];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count === 0) {
      report.push(`  ${selector} -> 0 nodes`);
      continue;
    }
    const first = locator.first();
    if (!(await first.isVisible())) {
      report.push(`  ${selector} -> ${count} node(s), none visible`);
      continue;
    }
    const box = await first.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      report.push(`  ${selector} -> ${count} node(s), zero-sized`);
      continue;
    }
    return first;
  }
  throw new Error(
    `[screenshot] cannot capture ${description}: no selector matched a visible, ` +
      `non-empty element.\n${report.join("\n")}\n` +
      `Fix the selector or add a data-testid to the component — do NOT let the ` +
      `helper return without asserting.`
  );
}

// ============================================================================
// Comparison gates
//
// DEFINED ONCE, in ./screenshotGates.ts, which also records how each number was
// measured and why it must not be loosened. playwright.config.ts imports the
// same constant as its project-wide `expect.toHaveScreenshot` default, so a
// capture written directly in a spec is held to exactly the gate a capture made
// through this helper is. The numbers previously lived in both files, synced by
// a comment — drift would have silently loosened one half of the suite.
// ============================================================================
const DEFAULT_SCREENSHOT_OPTIONS = SCREENSHOT_DEFAULTS;

/**
 * WHY REGION CAPTURES DO NOT HAVE THEIR OWN GATE.
 *
 * `takeGridRegionScreenshot` briefly carried a REGION_SCREENSHOT_OPTIONS
 * override of `maxDiffPixelRatio: 0.001`. That was written when the default
 * ratio was 0.005, where 0.001 was 5x TIGHTER and the override earned its
 * place. The default is now 0.0005, so the same override would LOOSEN the gate
 * by 2x on precisely the captures it existed to sharpen:
 *
 *   region 144x56 =   8064 px -> default 4 px budget, override would give 8
 *   region 320x120 = 38400 px -> default 19 px budget, override would give 38
 *
 * It was removed rather than re-tuned. The ratio-plus-cap default already
 * scales correctly: on a whole-grid shot the 200 px cap binds, and on a small
 * clip the 0.0005 ratio binds, which is exactly the behaviour the override was
 * hand-rolling. Region shots use DEFAULT_SCREENSHOT_OPTIONS.
 *
 * The scale argument that motivated region clipping in the first place still
 * holds and is the reason the helper exists: a note-indicator triangle is 66
 * device pixels. On a whole-grid 1232x556 shot that is 0.0096% of the frame,
 * under a 200 px budget — invisible at any threshold. Clipped to one cell it is
 * 0.82% of the frame against a 4 px budget, a ~16x margin.
 */

/**
 * Reset the app to a brand-new empty workbook via the Tauri `new_file` command.
 * This clears all sheets, data, and formatting — equivalent to File > New.
 * Use at the start of test groups that need a guaranteed clean slate.
 */
export async function resetToNewWorkbook(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    if (tauri?.core?.invoke) {
      await tauri.core.invoke("new_file", {});
      // `new_file` clears the backend's per-column/row overrides AND resets the
      // default geometry (persistence::reset_default_geometry). The FRONTEND
      // caches both: Spreadsheet.tsx re-reads dimensions only on mount or on
      // "dimensions:refresh", and SheetTabs.tsx reloads only on mount or on
      // "app:sheet-changed". Dispatching "grid:refresh" alone therefore repaints
      // the canvas with geometry the backend has already discarded — goldens
      // captured after this helper would encode ghost 100px/24px lines and a
      // phantom "Sheet2" tab, states the app can never actually be in. (The
      // product is unaffected: File > New does a full window.location.reload().)
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
      window.dispatchEvent(new Event("app:sheet-changed"));
      window.dispatchEvent(new Event("grid:refresh"));
    }
  });
  // Wait for the UI to fully re-render after the reset
  await page.waitForTimeout(1000);
  // Dismiss any dialogs that might appear
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
  }
  // Focus the spreadsheet and navigate to A1
  const container = page.locator("[data-focus-container='spreadsheet']");
  await container.focus();
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(300);
}

/**
 * Clear the grid by selecting all cells and deleting content + formatting.
 * Use this at the start of workflow tests to avoid stale data from prior tests
 * (all tests share the same app instance).
 *
 * IT CLEARS THE USED RANGE, NOT A FIXED BOX (see docs/design/open-decisions-2026-08.md
 * §3b). The fixed box was A1:Z1000 — columns 0-25 — and every spec that wrote
 * outside it left data that survived every subsequent reset for the rest of the
 * run. `charts.spec.ts` seeding column AA is the case that was actually found:
 * four values that no reset in the suite could reach, sitting in the workbook
 * while ninety specs ran over it.
 *
 * The union with the old box is deliberate. `get_used_range` is a bounding box
 * over cells that still HOLD something, so a cell that carries only formatting
 * (or one the backend has already forgotten but the frontend has not repainted)
 * can fall outside it; clearing at least the historical box means this helper
 * can only ever clear more than it used to, never less.
 *
 * WHAT IT STILL DOES NOT REACH, stated plainly rather than implied: charts,
 * shapes, images, pane controls, named ranges, styles, filters, sheets beyond
 * the active one, and every per-sheet display flag. Those need `new_file`,
 * which is exactly what the `journey` project exists to quarantine. A spec that
 * creates one of those objects is responsible for removing it — see the header
 * of `e2e/tests/charts.spec.ts` for the shape that takes.
 */
export async function resetGrid(page: Page): Promise<void> {
  // Dismiss any open dialogs/menus
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
  }

  // Focus the spreadsheet
  const container = page.locator("[data-focus-container='spreadsheet']");
  await container.focus();
  await page.waitForTimeout(100);

  // Select all cells (Ctrl+A) and delete content
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(200);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);

  // Clear all contents and formatting via Tauri API
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    if (tauri?.core?.invoke) {
      try {
        // The box the helper has always cleared, kept as a FLOOR.
        let endRow = 999;
        let endCol = 25;
        try {
          const used: {
            startRow: number; startCol: number; endRow: number; endCol: number; empty: boolean;
          } = await tauri.core.invoke("get_used_range", {});
          if (!used.empty) {
            endRow = Math.max(endRow, used.endRow);
            endCol = Math.max(endCol, used.endCol);
          }
        } catch {
          // Older backend without get_used_range: the floor still applies.
        }
        await tauri.core.invoke("clear_range_with_options", {
          params: { startRow: 0, startCol: 0, endRow, endCol, applyTo: "All" },
        });
        window.dispatchEvent(new Event("grid:refresh"));
      } catch {
        // Fallback: command may not exist, content Delete already ran
      }
    }
  });
  await page.waitForTimeout(300);

  // Navigate to A1
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(300);
}

/**
 * Wait for the grid to be fully rendered and stable.
 * Waits for: Canvas painted, no pending recalculations, no active animations.
 *
 * "No active animations" was aspirational until 2026-08-09 — the marching-ants
 * copy border marches forever and this function did nothing about it. It now
 * puts the app in reduced motion first (see `settleCanvasMotion`), which parks
 * that border at a fixed dash phase. That is done HERE, in the one function
 * every capture path already awaits, rather than in each of the four capture
 * helpers: a guarantee that has to be remembered in four places is a guarantee
 * that will be missing from the fifth.
 */
export async function waitForGridStable(page: Page, timeoutMs = 3000): Promise<void> {
  // Wait for the spreadsheet container to be visible
  await page.waitForSelector("[data-focus-container='spreadsheet']", {
    state: "visible",
    timeout: timeoutMs,
  });

  // Stop canvas-painted motion before waiting for it to settle. Ordered first
  // so the two rAF ticks below are the frames that park the dash phase.
  await settleCanvasMotion(page);

  // Wait for any pending Tauri invocations to complete
  await page.waitForTimeout(500);

  // Wait for requestAnimationFrame cycle to complete (canvas repaint)
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  }));
}

/**
 * Wait until the rendered page stops changing, or `timeoutMs` elapses.
 *
 * `waitForGridStable` only waits a fixed 500ms + two rAF ticks, which is not
 * enough for work that finishes on a backend round-trip. Pivot refreshes, for
 * example, paint a "Preparing…/Calculating…/Updating grid… (n/4)" progress
 * indicator with a Cancel button onto the grid OVERLAY canvas — it is drawn
 * state, not a DOM node, so there is no selector to await. A checkpoint that
 * races it bakes that transient overlay into the golden, which then fails
 * nondeterministically forever after.
 *
 * Polls full-page screenshots and returns as soon as two consecutive samples
 * are byte-identical. On timeout it returns quietly rather than throwing: the
 * screenshot assertion that follows is the real check.
 *
 * DELIBERATELY NOT called from `waitForGridStable`. It polls full-page
 * screenshots in a loop, which is expensive on every capture, and it can only
 * ever confirm what it already waited for. The historical second reason —
 * "some grid goldens contain genuinely animated canvas chrome (the
 * marching-ants copy border) which never reaches two identical frames, so this
 * would burn the full timeout and still settle on an arbitrary frame" — no
 * longer holds: `waitForGridStable` now parks that border via reduced motion.
 * The cost argument stands on its own. Use this only where a transient overlay
 * is the risk.
 */
export async function waitForVisualStability(
  page: Page,
  { timeoutMs = 6000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous: Buffer | null = null;
  while (Date.now() < deadline) {
    const shot = await page.screenshot({ animations: "disabled" });
    if (previous && shot.equals(previous)) return;
    previous = shot;
    await page.waitForTimeout(intervalMs);
  }
}

/**
 * Take a full-page screenshot checkpoint for visual regression comparison.
 * This captures the entire application window including ribbon, grid, and status bar.
 *
 * Pass `target` to capture a single element (e.g. a centered modal dialog)
 * instead of the whole page. This is required for overlays that sit on top of
 * the grid canvas: masking the canvas on a full-page shot would paint the mask
 * rectangle over the overlay itself, hiding it. Capturing the element keeps the
 * same baseline filename so registry entries do not change.
 *
 * @param page - Playwright page
 * @param name - Unique checkpoint name (used as filename). Use kebab-case.
 * @param options - Override default comparison options
 */
export async function takeCheckpoint(
  page: Page,
  name: string,
  options?: {
    maxDiffPixelRatio?: number;
    threshold?: number;
    mask?: ReturnType<Page["locator"]>[];
    target?: Locator;
  }
): Promise<void> {
  await waitForGridStable(page);
  const { target, ...rest } = options ?? {};
  if (target) {
    // A `target` that matches nothing would make toHaveScreenshot time out with
    // a generic message; say what was actually asked for instead.
    if ((await target.count()) === 0) {
      throw new Error(
        `[screenshot] checkpoint "${name}" was given a target locator that ` +
          `matches 0 nodes — nothing to capture.`
      );
    }
    await expect(target).toHaveScreenshot(`${name}.png`, {
      ...DEFAULT_SCREENSHOT_OPTIONS,
      ...rest,
    });
    return;
  }
  await expect(page).toHaveScreenshot(`${name}.png`, {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...rest,
    fullPage: false,
  });
}

/** The composited grid: canvas + every DOM layer stacked on it. */
const GRID_CONTAINER_SELECTORS = ["[data-grid-area]"];

/**
 * The same thing MINUS the scrollbars — what a grid golden is actually about.
 *
 * `[data-grid-canvas-layer]` is `S.CanvasLayer` in Spreadsheet.tsx. It is inset
 * by `SCROLLBAR_SIZE` on the right and bottom BY DEFINITION (`right: Npx;
 * bottom: Npx` in Spreadsheet.styles.ts), and `[data-grid-area]`'s only other
 * children are the two scrollbars and the corner box, so framing this element
 * excludes the scrollbars exactly, with no measurement and no arithmetic here.
 *
 * The fallback to the grid area is deliberate and must stay: if the attribute
 * is ever dropped, the capture degrades to the old framing (a golden that fails
 * on a thumb) rather than throwing, and the fallback is announced on stderr.
 */
const GRID_CANVAS_LAYER_SELECTORS = ["[data-grid-canvas-layer]"];

/**
 * Put the app in REDUCED MOTION before a capture, and leave it there.
 *
 * WHAT THIS FIXES. `screenshotGates.ts` measured the marching-ants copy border
 * as the only non-deterministic element in either suite (77 px of run-to-run
 * noise across two cold runs of all 76 captures; everything else was
 * bit-identical). It is non-deterministic because its dash phase is advanced by
 * wall-clock delta in a `requestAnimationFrame` loop, so a capture photographs
 * whatever phase the loop happened to reach. Re-recording does not fix that —
 * the new baseline is just a different phase — which is why `paste-special` is
 * the one spec whose failures survive a re-record.
 *
 * WHY THIS LEVER. `animations: "disabled"` in SCREENSHOT_DEFAULTS is
 * Playwright's declaration that a capture must not race a moving picture, and
 * it is honoured for CSS animations and transitions. It cannot see motion
 * painted on a canvas. `document.documentElement.dataset.reducedMotion` is the
 * app's OWN switch for the same idea — `skinLoader.apply()` stamps it from the
 * OS `prefers-reduced-motion` query or the Settings > Appearance toggle — so
 * this is the app's accessibility preference, set the way a user with that
 * preference would have it, not a test-only backdoor. `GridCanvas` parks the
 * dash phase at 0 and stops scheduling frames while it is on; the border is
 * still drawn, so a copy golden still shows what was copied.
 *
 * IT IS NOT UNDONE. A screenshot helper that toggled a display preference on
 * and off around each shot would make the shots depend on ordering again, which
 * is the whole class of defect D5 is about. Reduced motion changes nothing else
 * in the product today (GridCanvas is its only consumer), so the suite simply
 * runs under it. `page.evaluate` is a no-op after the first call, but it is
 * cheap and unconditional on purpose: a page that reloaded mid-spec would
 * otherwise silently lose the flag.
 */
async function settleCanvasMotion(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
  });
}

/**
 * Scroll a cell range into view, and return the geometry it is visible under.
 *
 * A region capture is only meaningful if the cells it frames are on screen, and
 * the specs cannot be trusted to have put them there: `GridHelper.navigateTo`
 * drives the Name Box, and OBSERVED ACROSS RUNS it sometimes commits the jump
 * and sometimes leaves `scrollX` at 0 with the target 300px off the right edge.
 * A capture that inherits that coin flip is either a hard error or — worse — a
 * golden of blank grid.
 *
 * `app:navigate-to-cell` is the app's own scroll-to-cell path (useSpreadsheet
 * dispatches scrollToCell and refreshes the cells). `select: false` keeps the
 * caller's selection, so scrolling here cannot change what the golden shows.
 * Bottom-right first, then top-left, so a range that fits ends up fully framed.
 */
/**
 * Move the selection OFF the range about to be photographed.
 *
 * WHY THIS EXISTS — measured, not theorised. The active-cell highlight is
 * painted after the cell decorations, and it covers the top-right corner of the
 * cell, which is exactly where Review paints its annotation triangles. Probed
 * against the running app on an isolated cell carrying a note:
 *
 *     note cell SELECTED     -> 15 red px in the clip
 *     note cell NOT selected -> 15 red px  ... selected: 0
 *
 * i.e. selecting the cell erases the indicator completely. Every spec here
 * reaches its capture via `navigateTo(topLeftCell)`, which selects that cell,
 * so every single-cell feature golden was a picture of the selection border
 * with the feature painted underneath it. That is how goldens named
 * `...-cell-with-indicator` came to hold one stray pixel of indicator colour.
 *
 * Parking six rows below the range keeps the viewport in the same
 * neighbourhood (so re-framing does not trigger a long scroll, which would
 * change the row-header width and the geometry with it) while putting the
 * selection chrome far outside a clip that extends only `padding` px past the
 * range.
 */
async function parkSelectionAwayFrom(
  page: Page,
  from: string,
  to: string
): Promise<void> {
  const a = parseCellRef(from);
  const b = parseCellRef(to);
  const parkRow = Math.max(a.row, b.row) + 6;
  const parkCol = Math.min(a.col, b.col);
  await page.evaluate(
    ({ row, col }) => {
      window.dispatchEvent(
        new CustomEvent("app:navigate-to-cell", {
          detail: { row, col, select: true },
        })
      );
    },
    { row: parkRow, col: parkCol }
  );
  await page.waitForTimeout(300);
}

async function ensureRangeVisible(
  page: Page,
  from: string,
  to: string,
  canvasBox: { x: number; y: number; width: number; height: number }
): Promise<GridGeometry> {
  const a = parseCellRef(from);
  const b = parseCellRef(to);
  const topLeft = { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) };
  const bottomRight = { row: Math.max(a.row, b.row), col: Math.max(a.col, b.col) };

  const fits = (geo: GridGeometry): boolean => {
    const r = cellRangeRectFrom(from, to, geo);
    return (
      r.x >= -0.5 &&
      r.y >= -0.5 &&
      r.x + r.width <= canvasBox.width + 0.5 &&
      r.y + r.height <= canvasBox.height + 0.5
    );
  };

  let geo = await readGridGeometry(page);
  for (let attempt = 0; attempt < 3 && !fits(geo); attempt++) {
    for (const target of [bottomRight, topLeft]) {
      await page.evaluate(
        ({ row, col }) => {
          window.dispatchEvent(
            new CustomEvent("app:navigate-to-cell", {
              detail: { row, col, select: false },
            })
          );
        },
        target
      );
      await page.waitForTimeout(350);
    }
    geo = await readGridGeometry(page);
  }
  return geo;
}

/**
 * Take a screenshot of the whole grid area (excludes ribbon and status bar).
 *
 * WHAT THIS CAPTURES, AND WHY IT IS THE CONTAINER AND NOT THE CANVAS
 *
 * This used to grab `page.locator("canvas").first()`. The grid is drawn on a
 * SINGLE canvas — verified against the running app, which has exactly one
 * <canvas> node in the main window — so all the extension chrome (Review's
 * note/comment triangles via registerCellDecoration, the grouping outline bar
 * via the post-header overlay, grid layers, region overlays) really does land
 * on those same pixels. The premise that a second "overlay canvas" existed is
 * false; there is nothing to stitch.
 *
 * The container is still the right target, because DOM layers sit ON TOP of
 * that canvas inside `[data-grid-area]` and a canvas-element capture drops
 * them:
 *   - the InlineEditor (a real <input>, rendered as a sibling of the canvas
 *     inside CanvasLayer) — so every "editing mode" golden was previously a
 *     picture of the grid WITHOUT the editor that the shot exists to show.
 * Capturing the composited DOM layer composites all of it, positioned exactly
 * as the user sees it, with no image stitching.
 *
 * ============================================================================
 * THE SCROLLBARS ARE OUT OF FRAME, AND THAT IS THE POINT (D5, 2026-08-09)
 * ============================================================================
 * This used to frame `[data-grid-area]`, which INCLUDES the row/column
 * scrollbars and the corner box. Eleven goldens across the functional suite
 * differed from their baseline by nothing but a scrollbar thumb.
 *
 * The thumb is a function of the USED RANGE, and the used range is shared
 * state that specs leak into each other on purpose: they park fixtures in far
 * columns to avoid colliding (`status-bar` at R:S, `edge-cases` at AE:AH,
 * `scrolling` at row 5000). The data is off-screen and irrelevant to the shot;
 * the thumb it produces is not. The `grid` fixture does no per-test cleanup, so
 * whichever specs ran earlier decide how tall the thumb in your capture is.
 *
 * Three fixes were on the table. Resetting the grid before every capture, and
 * abandoning the far-column parking convention, both cost a re-record AND a
 * rule every future spec has to remember. This one costs the SAME re-record
 * once and then holds by construction, so the choice was "once, structurally"
 * versus "once, per spec, forever".
 *
 * WHAT IS GIVEN UP: the suite no longer watches scrollbar geometry at all. That
 * is the right trade because no grid-rendering assertion in the suite is about
 * a scrollbar — they are about cells, chrome and layout — and a scrollbar
 * thumb photographed as a side effect is coverage nobody chose and nobody can
 * interpret when it fails. If scrollbar geometry deserves coverage it deserves
 * a test that says so: use `takeRegionScreenshot` clipped to the scrollbar, or
 * assert `useScrollbarMetrics`'s numbers directly, where the assertion can name
 * the used range it expects instead of inheriting one.
 *
 * NOTHING ELSE MOVES. `[data-grid-canvas-layer]` is the same rectangle minus a
 * 14px strip on the right and bottom; the headers, the frozen panes, the
 * grouping outline bar and the inline editor are all inside it (CanvasLayer is
 * `overflow: hidden`, so nothing can paint outside it in the first place).
 * `takeGridRegionScreenshot` already anchored on the canvas and was never
 * affected.
 *
 * SCALE CAVEAT — read before adding a new feature golden here. A whole-grid
 * shot is 1232x556 = 685k pixels, so the `maxDiffPixels: 200` cap is what binds
 * (the 0.0005 ratio would allow 342). A note-indicator triangle is 66 device
 * pixels — a third of the budget, and that is the BEST case, where the triangle
 * is the only thing that moved. Its presence or absence cannot be relied on to
 * fail this assertion. For a golden that is supposed to prove a specific piece
 * of chrome rendered, use `takeGridRegionScreenshot` and clip to the cells that
 * own it; whole-grid shots prove layout and data, not chrome.
 */
export async function takeGridScreenshot(
  page: Page,
  name: string,
  options?: {
    maxDiffPixelRatio?: number;
    threshold?: number;
  }
): Promise<void> {
  await waitForGridStable(page);
  if ((await page.locator(GRID_CANVAS_LAYER_SELECTORS[0]).count()) === 0) {
    // Loud, but not fatal: the shot still happens, framed the old way. Silence
    // here would mean the scrollbar thumbs quietly came back and the next
    // person re-recorded eleven goldens again without knowing why.
    console.warn(
      `[screenshot] "${name}": ${GRID_CANVAS_LAYER_SELECTORS[0]} matched nothing, ` +
        `falling back to ${GRID_CONTAINER_SELECTORS[0]} — the scrollbars are back ` +
        `IN frame and this golden can fail on a thumb. Restore the attribute on ` +
        `S.CanvasLayer in app/src/core/components/Spreadsheet/Spreadsheet.tsx.`
    );
  }
  const grid = await resolveOne(
    page,
    "the grid area (scrollbars excluded)",
    [...GRID_CANVAS_LAYER_SELECTORS, ...GRID_CONTAINER_SELECTORS]
  );
  await expect(grid).toHaveScreenshot(`grid-${name}.png`, {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...options,
  });
}

/**
 * Take a screenshot of the grid CLIPPED to a cell range — the capture to use
 * when a golden is meant to prove that a specific piece of chrome rendered.
 *
 * Rationale: the pixel budget is min(maxDiffPixels, maxDiffPixelRatio * px), so
 * on a large image it is a FLAT allowance that the feature must singlehandedly
 * blow through. Photographing the whole grid to assert a 6x6px triangle, a
 * trace arrow or an outline bracket leaves the feature at ~0.01% of the frame
 * and a third of the 200 px budget, so the golden can pass whether or not the
 * feature painted. Clipping to the cells that own the chrome shrinks the image
 * until the ratio binds instead (a 1-cell clip has a 4 px budget), which the
 * feature trips by more than an order of magnitude.
 *
 * The clip is a PAGE clip in viewport coordinates, so it composites canvas
 * pixels and DOM overlays exactly like `takeGridScreenshot` does.
 *
 * @param range - inclusive cell range, e.g. `{ from: "W1", to: "X3" }`
 * @param padding - extra CSS px around the range (default 8). Keep it small:
 *                  padding is dead pixels that dilute the assertion again.
 * @param includeHeaders - extend the clip left and up to the canvas edge so the
 *                  row/column headers are in frame. Required for chrome that
 *                  paints in the header margin rather than over the cells —
 *                  the grouping outline bar is the case that matters, since it
 *                  is drawn at x < rowHeaderWidth and a cell-only clip would
 *                  frame everything EXCEPT the feature under test.
 * @param keepSelection - leave the selection where the caller put it. Default
 *                  false, i.e. the selection is parked away from the range
 *                  first, because the active-cell highlight paints OVER cell
 *                  chrome (see parkSelectionAwayFrom — it erases annotation
 *                  indicators outright). Set true only for a golden whose
 *                  subject genuinely is the selection rectangle.
 */
export async function takeGridRegionScreenshot(
  page: Page,
  name: string,
  range: { from: string; to: string },
  options?: {
    maxDiffPixelRatio?: number;
    threshold?: number;
    padding?: number;
    includeHeaders?: boolean;
    keepSelection?: boolean;
  }
): Promise<void> {
  await waitForGridStable(page);
  const {
    padding = 4,
    includeHeaders = false,
    keepSelection = false,
    ...compare
  } = options ?? {};

  const grid = await resolveOne(page, "the grid area", GRID_CONTAINER_SELECTORS);
  const gridBox = await grid.boundingBox();
  if (!gridBox) {
    throw new Error(`[screenshot] grid area has no bounding box for "${name}"`);
  }
  // The canvas is inset inside the grid area by the scrollbars; cell
  // coordinates are relative to the CANVAS, so anchor on it.
  const canvasBox = await page.locator("canvas").first().boundingBox();
  if (!canvasBox) {
    throw new Error(`[screenshot] grid canvas has no bounding box for "${name}"`);
  }

  // Park BEFORE framing: parking dispatches a navigate that can scroll, so the
  // range has to be re-framed afterwards, not before.
  if (!keepSelection) {
    await parkSelectionAwayFrom(page, range.from, range.to);
  }

  const geo = await ensureRangeVisible(page, range.from, range.to, canvasBox);
  const rect = cellRangeRectFrom(range.from, range.to, geo);

  // Off-canvas AFTER the helper has done its own scrolling means the range
  // genuinely cannot be framed (too large for the viewport, or hidden). Capture
  // it anyway and the golden is a picture of blank grid — the silent pass this
  // helper exists to prevent — so fail with the numbers needed to fix the spec.
  const onCanvas =
    rect.x >= -1 &&
    rect.y >= -1 &&
    rect.x + rect.width <= canvasBox.width + 1 &&
    rect.y + rect.height <= canvasBox.height + 1;
  if (!onCanvas) {
    throw new Error(
      `[screenshot] range ${range.from}:${range.to} is not fully on screen for "${name}" ` +
        `even after scrolling to it.\n` +
        `  range rect (canvas-relative) = x:${rect.x.toFixed(1)} y:${rect.y.toFixed(1)} ` +
        `w:${rect.width.toFixed(1)} h:${rect.height.toFixed(1)}\n` +
        `  canvas = w:${canvasBox.width} h:${canvasBox.height}\n` +
        `  scroll = x:${geo.scrollX} y:${geo.scrollY} zoom:${geo.zoom}\n` +
        `Use a smaller range, or check that the rows/columns are not hidden.`
    );
  }

  // Padding is a nicety, not part of the assertion — clamp it to the canvas
  // rather than failing when the range happens to touch an edge.
  const clampX = (v: number) =>
    Math.min(Math.max(v, canvasBox.x), canvasBox.x + canvasBox.width);
  const clampY = (v: number) =>
    Math.min(Math.max(v, canvasBox.y), canvasBox.y + canvasBox.height);

  const x = includeHeaders ? canvasBox.x : clampX(canvasBox.x + rect.x - padding);
  const y = includeHeaders ? canvasBox.y : clampY(canvasBox.y + rect.y - padding);
  const width = clampX(canvasBox.x + rect.x + rect.width + padding) - x;
  const height = clampY(canvasBox.y + rect.y + rect.height + padding) - y;

  await expect(page).toHaveScreenshot(`grid-${name}.png`, {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...compare,
    clip: { x, y, width, height },
  });
}

/**
 * Take a screenshot of a specific dialog or overlay.
 *
 * @param page - Playwright page
 * @param name - Unique checkpoint name
 * @param selector - CSS selector for the dialog container
 */
export async function takeDialogScreenshot(
  page: Page,
  name: string,
  selector: string,
  options?: {
    maxDiffPixelRatio?: number;
    threshold?: number;
  }
): Promise<void> {
  // Wait for dialog to fully render. waitForSelector THROWS on a miss, which is
  // the behaviour every helper in this file must have; resolveOne then also
  // rejects a matched-but-zero-sized dialog.
  await page.waitForSelector(selector, { state: "visible", timeout: 5000 });
  await page.waitForTimeout(300);

  const element = await resolveOne(page, `dialog "${name}"`, [selector]);
  await expect(element).toHaveScreenshot(`dialog-${name}.png`, {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...options,
  });
}

/**
 * Wrap a screenshot assertion so that a missing baseline (first run) logs a
 * warning instead of failing the test.  Real pixel-diff failures still throw.
 *
 * Usage:
 *   await softly(takeGridScreenshot(page, "my-shot"));
 */
export async function softly(promise: Promise<void>): Promise<void> {
  try {
    await promise;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("snapshot doesn't exist")) {
      console.log(`[screenshot] baseline missing, actual written: ${msg.split("\n")[0]}`);
      return;
    }
    throw e;
  }
}

/**
 * Take a screenshot of a specific region defined by coordinates.
 * Useful for capturing specific parts of the canvas.
 *
 * @param page - Playwright page
 * @param name - Unique checkpoint name
 * @param clip - Region to capture { x, y, width, height }
 */
export async function takeRegionScreenshot(
  page: Page,
  name: string,
  clip: { x: number; y: number; width: number; height: number },
  options?: {
    maxDiffPixelRatio?: number;
    threshold?: number;
  }
): Promise<void> {
  await waitForGridStable(page);
  // A clip that is empty or lies outside the viewport photographs nothing and
  // would still "pass" against a baseline recorded from the same nothing.
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  if (
    clip.width <= 0 ||
    clip.height <= 0 ||
    clip.x < 0 ||
    clip.y < 0 ||
    clip.x + clip.width > viewport.width ||
    clip.y + clip.height > viewport.height
  ) {
    throw new Error(
      `[screenshot] region "${name}" clip ${JSON.stringify(clip)} is empty or ` +
        `outside the ${viewport.width}x${viewport.height} viewport.`
    );
  }
  await expect(page).toHaveScreenshot(`region-${name}.png`, {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...options,
    clip,
  });
}

/**
 * Take a screenshot of the ribbon (tab strip + content band).
 *
 * `[data-testid='ribbon']` is RibbonContainer's `S.RibbonFrame` — the tab strip
 * AND the content band, which is what a "ribbon" golden is supposed to show:
 * the active-tab highlight is the evidence that a tab switch happened, and the
 * band is the evidence of what that tab contains.
 *
 * `[data-ribbon-content]` is the fallback, but it is only the content band and
 * it is `display: none` while the ribbon is minimized — which is precisely when
 * some of these goldens are taken — so it must not be the primary target.
 *
 * There is no page-clip fallback any more. The old one clipped a fixed
 * 1280x180 rectangle off the top of the window, which (a) fired unconditionally
 * because all three of its selectors matched zero nodes in the shipping app,
 * and (b) is 17px TALLER than menu bar + tab strip + band, so every ribbon
 * golden also framed part of the formula bar and whatever cell content happened
 * to be in it. Those goldens churned on unrelated cell edits.
 */
/**
 * Move the mouse pointer off the ribbon before a ribbon capture.
 *
 * WHY THIS EXISTS — measured, not theorised. A re-record pass (2026-08-09)
 * rewrote `ribbon-home-tab-buttons` and `ribbon-ribbon-tab-home-restored` with
 * no product change behind them. Both diffs were the SAME 57x26 box at the top
 * left, 1465 px, max channel delta 13: a rounded grey HOVER background behind
 * the "Home" tab. The pointer was simply left where the previous action put it,
 * and `RibbonTabBar` paints `:hover` on whatever it is over.
 *
 * That is the same defect class as the marching ants and the active-cell
 * highlight (see `settleCanvasMotion`, `parkSelectionAwayFrom`): a capture that
 * photographs ambient state nobody chose. Re-recording cannot fix it — the next
 * spec that leaves the pointer somewhere else fails the new baseline just as
 * the old one failed. The pointer has to be somewhere DEFINITE instead.
 *
 * WHERE: the far bottom-left of the viewport — the status bar's "Ready" text,
 * which is inert. Deliberately NOT (0, 0): that is the File menu, and parking
 * on a menu trades a hovered tab for a hovered menu. Deliberately not the grid
 * canvas either, since that is what the grid helpers photograph.
 *
 * The three ribbon goldens this makes deterministic were RESTORED rather than
 * re-recorded: with the pointer parked, the app renders what the original
 * baselines already hold, so the fix costs no baseline at all.
 */
async function parkPointerAwayFromChrome(page: Page): Promise<void> {
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  await page.mouse.move(4, Math.max(0, viewport.height - 4));
}

export async function takeRibbonScreenshot(
  page: Page,
  name: string,
  options?: {
    maxDiffPixelRatio?: number;
    threshold?: number;
  }
): Promise<void> {
  await parkPointerAwayFromChrome(page);
  await page.waitForTimeout(300);
  const ribbon = await resolveOne(page, "the ribbon", [
    "[data-testid='ribbon']",
    "[data-ribbon-content]",
  ]);
  await expect(ribbon).toHaveScreenshot(`ribbon-${name}.png`, {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...options,
  });
}

/**
 * Take a screenshot of the status bar.
 *
 * The status bar shows LIVE SELECTION AGGREGATES (Sum/Average/Count from the
 * StatusBarAggregation extension) alongside the zoom slider and the calculation
 * mode. Its content is therefore a function of the current selection: a caller
 * that captures without first establishing a known selection over known values
 * bakes whatever the previous test left behind into the golden. Establish the
 * selection first — see status-bar.spec.ts.
 *
 * Previously this returned SILENTLY when its selector matched nothing, which it
 * always did (StatusBar.tsx renders a bare inline-styled <div> with neither a
 * testid nor a class). Every call had been a no-op since May and the golden
 * directory was empty. The component now carries `data-testid="status-bar"` and
 * a miss throws.
 */
export async function takeStatusBarScreenshot(
  page: Page,
  name: string,
  options?: {
    maxDiffPixelRatio?: number;
    threshold?: number;
  }
): Promise<void> {
  await page.waitForTimeout(200);
  const statusBar = await resolveOne(page, "the status bar", [
    "[data-testid='status-bar']",
  ]);
  await expect(statusBar).toHaveScreenshot(`statusbar-${name}.png`, {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...options,
  });
}
