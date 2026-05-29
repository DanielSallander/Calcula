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

// Default comparison options - tuned for Canvas rendering which can have
// minor anti-aliasing differences between runs.
const DEFAULT_SCREENSHOT_OPTIONS = {
  // Allow 0.5% of pixels to differ (anti-aliasing tolerance)
  maxDiffPixelRatio: 0.005,
  // Individual pixel color difference threshold (0-255 per channel)
  threshold: 0.2,
  // Animation settling time
  animations: "disabled" as const,
};

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
        await tauri.core.invoke("clear_range_with_options", {
          params: {
            startRow: 0, startCol: 0, endRow: 999, endCol: 25,
            applyTo: "All",
          },
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
 */
export async function waitForGridStable(page: Page, timeoutMs = 3000): Promise<void> {
  // Wait for the spreadsheet container to be visible
  await page.waitForSelector("[data-focus-container='spreadsheet']", {
    state: "visible",
    timeout: timeoutMs,
  });

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
 * Take a full-page screenshot checkpoint for visual regression comparison.
 * This captures the entire application window including ribbon, grid, and status bar.
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
  }
): Promise<void> {
  await waitForGridStable(page);
  await expect(page).toHaveScreenshot(`${name}.png`, {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...options,
    fullPage: false,
  });
}

/**
 * Take a screenshot of just the grid canvas area (excludes ribbon and status bar).
 * More focused comparison that ignores UI chrome changes.
 *
 * @param page - Playwright page
 * @param name - Unique checkpoint name
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
  const canvas = page.locator("canvas").first();
  await expect(canvas).toHaveScreenshot(`grid-${name}.png`, {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...options,
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
  // Wait for dialog to fully render
  await page.waitForSelector(selector, { state: "visible", timeout: 5000 });
  await page.waitForTimeout(300);

  const element = page.locator(selector).first();
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
  await expect(page).toHaveScreenshot(`region-${name}.png`, {
    ...DEFAULT_SCREENSHOT_OPTIONS,
    ...options,
    clip,
  });
}

/**
 * Take a screenshot of the ribbon/toolbar area only.
 */
export async function takeRibbonScreenshot(
  page: Page,
  name: string,
  options?: {
    maxDiffPixelRatio?: number;
    threshold?: number;
  }
): Promise<void> {
  await page.waitForTimeout(300);
  const ribbon = page.locator("[data-testid='ribbon'], .ribbon-container, .toolbar-container").first();
  // If a specific ribbon selector doesn't exist, fall back to taking top portion
  const exists = await ribbon.count();
  if (exists > 0) {
    await expect(ribbon).toHaveScreenshot(`ribbon-${name}.png`, {
      ...DEFAULT_SCREENSHOT_OPTIONS,
      ...options,
    });
  } else {
    // Capture top 150px of the page as ribbon area
    await expect(page).toHaveScreenshot(`ribbon-${name}.png`, {
      ...DEFAULT_SCREENSHOT_OPTIONS,
      ...options,
      clip: { x: 0, y: 0, width: 1280, height: 150 },
    });
  }
}

/**
 * Take a screenshot of the status bar area only.
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
  const statusBar = page.locator("[data-testid='status-bar'], .status-bar").first();
  const exists = await statusBar.count();
  if (exists > 0) {
    await expect(statusBar).toHaveScreenshot(`statusbar-${name}.png`, {
      ...DEFAULT_SCREENSHOT_OPTIONS,
      ...options,
    });
  }
}
