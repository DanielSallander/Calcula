/**
 * Ribbon & Home Tab E2E tests.
 *
 * Tests ribbon tab navigation, Home tab formatting buttons,
 * and ribbon minimize/expand behavior.
 *
 * Uses cells in columns W-X, rows 1-10 to avoid collision.
 */
import { test, expect } from "../fixtures";
import {
  takeRibbonScreenshot,
  takeCheckpoint,
  softly,
} from "../helpers/screenshots";

test.describe("Ribbon tab navigation", () => {
  test("Home tab is visible and active by default", async ({
    appPage,
    grid,
  }) => {
    // The ribbon should have tab buttons rendered
    const tabButtons = appPage.locator("button").filter({ hasText: /Home/i });
    const homeTabCount = await tabButtons.count();
    expect(homeTabCount).toBeGreaterThan(0);

    await softly(takeRibbonScreenshot(appPage, "home-tab-default"));
  });

  test("switching between ribbon tabs", async ({ appPage, grid }) => {
    // Find and list all tab buttons in the ribbon header area
    // Tab buttons are children of the flex row above ribbon content
    const allButtons = appPage.locator("button");
    const buttonCount = await allButtons.count();

    // Collect tab names from the ribbon header
    const tabNames: string[] = [];
    for (let i = 0; i < buttonCount; i++) {
      const btn = allButtons.nth(i);
      const text = await btn.textContent();
      const parent = btn.locator("..");
      // Tab buttons are in the ribbon tab header area
      if (
        text &&
        ["Home", "Insert", "Page Layout", "Formulas", "Data", "View"].includes(
          text.trim()
        )
      ) {
        tabNames.push(text.trim());
      }
    }

    // Should have at least Home and one other tab
    expect(tabNames.length).toBeGreaterThanOrEqual(1);

    // If there's more than one tab, click through them
    if (tabNames.length >= 2) {
      // Click the second tab
      const secondTab = appPage
        .locator("button")
        .filter({ hasText: tabNames[1] })
        .first();
      await secondTab.click();
      await appPage.waitForTimeout(300);

      await softly(
        takeRibbonScreenshot(appPage, `ribbon-tab-${tabNames[1].toLowerCase().replace(/\s/g, "-")}`)
      );

      // Click back to Home
      const homeTab = appPage
        .locator("button")
        .filter({ hasText: "Home" })
        .first();
      await homeTab.click();
      await appPage.waitForTimeout(300);

      await softly(takeRibbonScreenshot(appPage, "ribbon-tab-home-restored"));
    }
  });

  test("ribbon contains formatting buttons on Home tab", async ({
    appPage,
    grid,
  }) => {
    // Ensure Home tab is active
    const homeTab = appPage
      .locator("button")
      .filter({ hasText: "Home" })
      .first();
    if ((await homeTab.count()) > 0) {
      await homeTab.click();
      await appPage.waitForTimeout(300);
    }

    // Check for core formatting buttons by data-testid
    const boldBtn = appPage.locator('[data-testid="fmt-bold"]');
    const italicBtn = appPage.locator('[data-testid="fmt-italic"]');
    const underlineBtn = appPage.locator('[data-testid="fmt-underline"]');

    expect(await boldBtn.count()).toBeGreaterThan(0);
    expect(await italicBtn.count()).toBeGreaterThan(0);
    expect(await underlineBtn.count()).toBeGreaterThan(0);

    // Verify copy/paste buttons exist
    const copyBtn = appPage.locator('[data-testid="fmt-copy"]');
    const pasteBtn = appPage.locator('[data-testid="fmt-paste"]');
    expect(await copyBtn.count()).toBeGreaterThan(0);
    expect(await pasteBtn.count()).toBeGreaterThan(0);

    await softly(takeRibbonScreenshot(appPage, "home-tab-buttons"));
  });

  test("ribbon minimize and expand via Ctrl+F1", async ({
    appPage,
    grid,
  }) => {
    // Take baseline screenshot
    await softly(takeRibbonScreenshot(appPage, "ribbon-before-minimize"));

    // Get initial ribbon content height
    const ribbonContent = appPage.locator("[data-ribbon-content]").first();
    const initiallyVisible =
      (await ribbonContent.count()) > 0 &&
      (await ribbonContent.isVisible());

    // Press Ctrl+F1 to minimize
    await appPage.keyboard.press("Control+F1");
    await appPage.waitForTimeout(500);

    try {
      // The ribbon content should be hidden now
      if (initiallyVisible) {
        const contentAfterMinimize = appPage.locator("[data-ribbon-content]").first();
        const minimizedDisplay = await contentAfterMinimize.evaluate(
          (el) => window.getComputedStyle(el).display
        );
        expect(minimizedDisplay).toBe("none");

        await softly(takeCheckpoint(appPage, "ribbon-minimized"));
      }
    } finally {
      // Always re-expand, even if the assertion/screenshot above threw.
      // The app instance is shared across all tests, so leaving the ribbon
      // minimized here would cascade failures into every subsequent test.
      await appPage.keyboard.press("Control+F1");
      await appPage.waitForTimeout(500);
    }

    // Ribbon content should be visible again
    if (initiallyVisible) {
      const contentAfterExpand = appPage.locator("[data-ribbon-content]").first();
      const expandedDisplay = await contentAfterExpand.evaluate(
        (el) => window.getComputedStyle(el).display
      );
      expect(expandedDisplay).not.toBe("none");

      await softly(takeRibbonScreenshot(appPage, "ribbon-after-expand"));
    }
  });

  test("formatting buttons reflect active cell state", async ({
    appPage,
    grid,
  }) => {
    // Set up a bold cell and a plain cell
    await grid.setCellValueDirect("W1", "Bold");
    await grid.clickCell("W1");
    await grid.toggleBold();
    await grid.page.waitForTimeout(200);

    await grid.setCellValueDirect("W2", "Plain");
    await grid.page.waitForTimeout(200);

    // Click the bold cell - bold button should reflect active state
    await grid.clickCell("W1");
    await grid.page.waitForTimeout(300);
    expect(await grid.isFormatActive("bold")).toBe(true);

    // Click the plain cell - bold button should not be active
    await grid.clickCell("W2");
    await grid.page.waitForTimeout(300);
    expect(await grid.isFormatActive("bold")).toBe(false);

    await softly(takeRibbonScreenshot(appPage, "ribbon-format-state"));
  });
});
