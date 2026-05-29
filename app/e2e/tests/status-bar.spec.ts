/**
 * Status Bar & Aggregations E2E tests.
 *
 * Tests the status bar aggregation widget that displays SUM, AVG, COUNT
 * when a multi-cell range with numeric data is selected.
 *
 * Uses cells in columns R-S, rows 1-10 to avoid collision with other tests.
 */
import { test, expect } from "../fixtures";
import {
  takeStatusBarScreenshot,
  softly,
} from "../helpers/screenshots";

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

    // Select the range R1:R3
    await grid.selectRange("R1", "R3");
    // Wait for debounce (150ms) + backend round-trip
    await grid.page.waitForTimeout(600);

    await softly(takeStatusBarScreenshot(appPage, "aggregation-sum-avg-count"));

    // Check that the status bar displays aggregation values
    // The widget renders spans with "Sum: ", "Average: ", "Count: " labels
    const statusBarText = await appPage.evaluate(() => {
      // Find the green status bar at the bottom
      const bars = document.querySelectorAll("div");
      for (const bar of bars) {
        const style = window.getComputedStyle(bar);
        if (style.backgroundColor === "rgb(33, 115, 70)") {
          return bar.textContent ?? "";
        }
      }
      return "";
    });

    // Should contain aggregation info for 10+20+30
    expect(statusBarText).toContain("Sum");
    expect(statusBarText).toContain("60");
    expect(statusBarText).toContain("Average");
    expect(statusBarText).toContain("20");
  });

  test("hides aggregations for single cell selection", async ({
    appPage,
    grid,
  }) => {
    await grid.setCellValueDirect("R5", "100");
    await grid.page.waitForTimeout(300);

    // Click a single cell
    await grid.clickCell("R5");
    await grid.page.waitForTimeout(600);

    const statusBarText = await appPage.evaluate(() => {
      const bars = document.querySelectorAll("div");
      for (const bar of bars) {
        const style = window.getComputedStyle(bar);
        if (style.backgroundColor === "rgb(33, 115, 70)") {
          return bar.textContent ?? "";
        }
      }
      return "";
    });

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

    // Select range
    await grid.selectRange("S1", "S2");
    await grid.page.waitForTimeout(600);

    // Check initial sum = 20
    let statusBarText = await appPage.evaluate(() => {
      const bars = document.querySelectorAll("div");
      for (const bar of bars) {
        const style = window.getComputedStyle(bar);
        if (style.backgroundColor === "rgb(33, 115, 70)") {
          return bar.textContent ?? "";
        }
      }
      return "";
    });
    expect(statusBarText).toContain("20");

    // Update S2 to 25 (sum should become 30)
    await grid.setCellValueDirect("S2", "25");
    await grid.page.waitForTimeout(300);

    // Re-select to trigger aggregation refresh
    await grid.selectRange("S1", "S2");
    await grid.page.waitForTimeout(600);

    statusBarText = await appPage.evaluate(() => {
      const bars = document.querySelectorAll("div");
      for (const bar of bars) {
        const style = window.getComputedStyle(bar);
        if (style.backgroundColor === "rgb(33, 115, 70)") {
          return bar.textContent ?? "";
        }
      }
      return "";
    });
    expect(statusBarText).toContain("30");

    await softly(takeStatusBarScreenshot(appPage, "aggregation-updated"));
  });

  test("shows count for text-only range", async ({ appPage, grid }) => {
    await grid.setCellValueDirect("S4", "Alpha");
    await grid.setCellValueDirect("S5", "Beta");
    await grid.setCellValueDirect("S6", "Gamma");
    await grid.page.waitForTimeout(300);

    await grid.selectRange("S4", "S6");
    await grid.page.waitForTimeout(600);

    const statusBarText = await appPage.evaluate(() => {
      const bars = document.querySelectorAll("div");
      for (const bar of bars) {
        const style = window.getComputedStyle(bar);
        if (style.backgroundColor === "rgb(33, 115, 70)") {
          return bar.textContent ?? "";
        }
      }
      return "";
    });

    // Text cells: should show Count but not Sum/Average
    expect(statusBarText).toContain("Count");
    expect(statusBarText).not.toContain("Sum");

    await softly(takeStatusBarScreenshot(appPage, "text-range"));
  });
});
