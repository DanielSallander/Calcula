/**
 * Status Bar & Aggregations E2E tests.
 *
 * Tests the status bar aggregation widget that displays SUM, AVG, COUNT
 * when a multi-cell range with numeric data is selected.
 *
 * Uses cells in columns R-S, rows 1-10 to avoid collision with other tests.
 *
 * GOLDEN DETERMINISM
 *
 * The status bar renders live SELECTION aggregates, so its pixels are a
 * function of what is selected when the shutter fires. Every capture below is
 * therefore taken only after the test has (a) written its own values and
 * (b) selected its own range, and only after the textual assertions for that
 * state have passed — so a drifted selection fails as a functional assertion
 * instead of being baked into the baseline.
 *
 * (These goldens did not exist before: takeStatusBarScreenshot's selector
 * matched zero nodes and the helper returned silently, so all four call sites
 * had been no-ops since May and __screenshots__/status-bar.spec.ts was empty.)
 */
import { test, expect } from "../fixtures";
import {
  takeStatusBarScreenshot,
  softly,
} from "../helpers/screenshots";
import type { Page } from "@playwright/test";

/**
 * Read the status bar's text.
 *
 * Every read in this file used to scan every <div> on the page for
 * `backgroundColor === "rgb(33, 115, 70)"` and return `""` when none matched.
 * That is a silent pass generator: the negative assertions here
 * (`not.toContain("Sum")`) are satisfied by the empty string, so a restyled or
 * deleted status bar would have made those tests PASS. Target the testid and
 * throw when it is not there.  (definition below)
 */

/**
 * Select a rectangular range deterministically.
 *
 * `GridHelper.selectRange` drives a real mouse drag over canvas coordinates and
 * inherits every flake in that path (off-screen columns, the Name Box jump that
 * sometimes does not commit, ambient selection drift). For a golden whose whole
 * content is a function of the selection, that is fatal: the shot silently
 * records "Ready" instead of the aggregates.
 *
 * `app:navigate-to-cell` carries endRow/endCol and is the app's own
 * select-and-scroll path (useSpreadsheet -> setSelection + scrollToCell).
 */
async function selectRangeExactly(
  page: Page,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<void> {
  await page.evaluate(
    (r) => {
      window.dispatchEvent(
        new CustomEvent("app:navigate-to-cell", {
          detail: {
            row: r.startRow,
            col: r.startCol,
            endRow: r.endRow,
            endCol: r.endCol,
            select: true,
          },
        })
      );
    },
    { startRow, startCol, endRow, endCol }
  );
  // Aggregation is debounced (150ms) and then does a backend round-trip.
  await page.waitForTimeout(800);
}

async function readStatusBarText(page: Page): Promise<string> {
  const bar = page.locator('[data-testid="status-bar"]');
  if ((await bar.count()) === 0) {
    throw new Error(
      "[status-bar] no [data-testid='status-bar'] in the DOM — the status bar " +
        "is missing, not merely empty."
    );
  }
  return (await bar.first().textContent()) ?? "";
}

test.describe("Status bar aggregations", () => {
  test("shows sum, average, and count for numeric range", async ({
    appPage,
    grid,
  }) => {
    // Set up numeric data
    await grid.setCellValueDirect("R1", "10");
    await grid.setCellValueDirect("R2", "20");
    await grid.setCellValueDirect("R3", "30");
    await grid.page.waitForTimeout(300);

    // Select R1:R3 (0-based rows 0-2, col 17)
    await selectRangeExactly(appPage, 0, 17, 2, 17);

    // Check that the status bar displays aggregation values
    // The widget renders spans with "Sum: ", "Average: ", "Count: " labels
    const statusBarText = await readStatusBarText(appPage);

    // Should contain aggregation info for 10+20+30
    expect(statusBarText).toContain("Sum");
    expect(statusBarText).toContain("60");
    expect(statusBarText).toContain("Average");
    expect(statusBarText).toContain("20");

    // Selection is now known-good (R1:R3 over 10/20/30): the golden is stable.
    await softly(takeStatusBarScreenshot(appPage, "aggregation-sum-avg-count"));
  });

  test("hides aggregations for single cell selection", async ({
    appPage,
    grid,
  }) => {
    await grid.setCellValueDirect("R5", "100");
    await grid.page.waitForTimeout(300);

    // Select the single cell R5 (0-based row 4, col 17)
    await selectRangeExactly(appPage, 4, 17, 4, 17);

    const statusBarText = await readStatusBarText(appPage);

    // Single cell: no aggregation should show (no "Sum:")
    expect(statusBarText).not.toContain("Sum");
  });

  test("updates aggregations when data changes", async ({
    appPage,
    grid,
  }) => {
    await grid.setCellValueDirect("S1", "5");
    await grid.setCellValueDirect("S2", "15");
    await grid.page.waitForTimeout(300);

    // Select S1:S2 (0-based rows 0-1, col 18)
    await selectRangeExactly(appPage, 0, 18, 1, 18);

    // Check initial sum = 20
    let statusBarText = await readStatusBarText(appPage);
    expect(statusBarText).toContain("20");

    // Update S2 to 25 (sum should become 30)
    await grid.setCellValueDirect("S2", "25");
    await grid.page.waitForTimeout(300);

    // Re-select to trigger aggregation refresh
    await selectRangeExactly(appPage, 0, 18, 1, 18);

    statusBarText = await readStatusBarText(appPage);
    expect(statusBarText).toContain("30");

    await softly(takeStatusBarScreenshot(appPage, "aggregation-updated"));
  });

  test("shows count for text-only range", async ({ appPage, grid }) => {
    await grid.setCellValueDirect("S4", "Alpha");
    await grid.setCellValueDirect("S5", "Beta");
    await grid.setCellValueDirect("S6", "Gamma");
    await grid.page.waitForTimeout(300);

    // Select S4:S6 (0-based rows 3-5, col 18)
    await selectRangeExactly(appPage, 3, 18, 5, 18);

    const statusBarText = await readStatusBarText(appPage);

    // Text cells: should show Count but not Sum/Average
    expect(statusBarText).toContain("Count");
    expect(statusBarText).not.toContain("Sum");

    await softly(takeStatusBarScreenshot(appPage, "text-range"));
  });
});
