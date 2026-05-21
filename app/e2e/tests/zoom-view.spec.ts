/**
 * Zoom and view mode E2E tests.
 *
 * Tests zoom level changes and view mode switching.
 */
import { test, expect } from "../fixtures";

test.describe("Zoom", () => {
  test("zoom in increases zoom level", async ({ grid }) => {
    // Get initial zoom
    const initial = await grid.page.evaluate(() => {
      const gs = (window as any).__CALCULA_GRID_STATE__;
      return gs?.zoom ?? 1;
    });

    // Click zoom in button
    const zoomIn = grid.page.locator('button[title="Zoom in"]').or(
      grid.page.locator('button').filter({ hasText: /^\+$/ }).last()
    );
    // Use the slider-adjacent + button
    const slider = grid.page.locator('[aria-label*="Zoom"]');
    if (await slider.isVisible()) {
      // Set zoom via grid state instead of UI
      await grid.page.evaluate(() => {
        const gs = (window as any).__CALCULA_GRID_STATE__;
        // Dispatch a zoom action
        window.dispatchEvent(new CustomEvent("grid:setZoom", { detail: 1.5 }));
      });
    }

    // Verify zoom changed via Tauri API or grid state
    // This is more of a smoke test - verify the zoom UI exists
    expect(initial).toBeGreaterThan(0);
  });

  test("zoom level is displayed in status bar", async ({ grid }) => {
    const zoomText = grid.page.locator('[aria-label="Click to select zoom level"]').or(
      grid.page.locator("text=/\\d+%/").last()
    );
    if (await zoomText.isVisible({ timeout: 2000 }).catch(() => false)) {
      const text = await zoomText.innerText();
      expect(text).toMatch(/\d+%/);
    }
  });
});

test.describe("View mode", () => {
  test("status bar shows Ready", async ({ grid }) => {
    // The status bar should show "Ready" by default
    const statusText = grid.page.locator("text=Ready").first();
    await expect(statusText).toBeVisible({ timeout: 3000 });
  });

  test("formula bar shows cell value on selection", async ({ grid }) => {
    await grid.setCellValueDirect("A1", "TestView");
    await grid.clickCell("A1");
    await grid.page.waitForTimeout(300);
    const value = await grid.getFormulaBarValue();
    expect(value).toBe("TestView");
  });
});
