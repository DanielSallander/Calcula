import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * Panel placement freedom: any panel can be toggled between sidebar and
 * ribbon. The Animation panel (formerly sidebar-locked) is the proving case:
 * moved to the ribbon, its driver/transport/export sections render inline in
 * the fixed-height band while the saved-animations list demotes to a launcher
 * flyout; the band never grows or spills over the grid.
 */

const PANEL_ID = "animation.timeline";

/** Deterministically reset the Animation panel's placement (setup/teardown). */
async function setPlacement(page: Page, placement: "sidebar" | "ribbon"): Promise<void> {
  await page.evaluate((p) => {
    const reg = (window as unknown as {
      __CALCULA_PANEL_REGISTRY__: { setPlacement: (id: string, placement: string) => void };
    }).__CALCULA_PANEL_REGISTRY__;
    reg.setPlacement("animation.timeline", p);
  }, placement);
}

/**
 * Make a ribbon section's content reachable: inline content is returned as-is;
 * width-demoted sections are opened via their launcher button first.
 */
async function ensureRibbonSectionVisible(page: Page, contentTestId: string, sectionKey: string): Promise<void> {
  const content = page.locator(`[data-testid="${contentTestId}"]`);
  if (await content.isVisible().catch(() => false)) return;
  await page.locator(`[data-testid="section-launcher-${PANEL_ID}.${sectionKey}"]`).click();
  await expect(content).toBeVisible({ timeout: 5000 });
}

test.describe("Panel placement freedom", () => {
  test("Animation moves to the ribbon: band height unchanged, transport operable, list demotes to a launcher flyout", async ({ grid }) => {
    const page = grid.page;

    try {
      await setPlacement(page, "sidebar");

      // Driver model: A1 swept 0..4 -> 5 frames.
      await grid.setCellValueDirect("A1", "3");

      // Open the panel in the sidebar and configure the driver there.
      await grid.openMenu("View");
      await grid.clickMenuItem("Animation Timeline");
      await expect(page.locator('[data-testid="anim-driver-cell"]')).toBeVisible({ timeout: 8000 });
      await page.locator('[data-testid="anim-driver-cell"]').fill("A1");
      await page.locator('[data-testid="anim-from"]').fill("0");
      await page.locator('[data-testid="anim-to"]').fill("4");
      await page.locator('[data-testid="anim-step"]').fill("1");
      await page.locator('[data-testid="anim-set-driver"]').click();
      await expect(page.locator('[data-testid="anim-frame"]')).toHaveText("1 / 5", { timeout: 5000 });

      // Baseline: the ribbon band's height before Animation is hosted in it.
      const bandBefore = await page.locator("[data-ribbon-content]").boundingBox();
      expect(bandBefore).not.toBeNull();

      // Move to the ribbon through the real user flow: right-click the
      // activity bar icon -> "Move to Ribbon".
      await page.getByRole("button", { name: "Animation", exact: true }).click({ button: "right" });
      await page.getByRole("button", { name: /Move to Ribbon/ }).click();

      // The panel is now a ribbon tab; activate it.
      const animationTab = page.getByRole("button", { name: "Animation", exact: true });
      await expect(animationTab).toBeVisible({ timeout: 5000 });
      await animationTab.click();

      // The fixed-height band must not grow to host the panel.
      const bandAfter = await page.locator("[data-ribbon-content]").boundingBox();
      expect(bandAfter).not.toBeNull();
      expect(Math.abs(bandAfter!.height - bandBefore!.height)).toBeLessThanOrEqual(1);

      // Transport renders in the band and is operable (driver survived the move).
      await ensureRibbonSectionVisible(page, "anim-frame", "playback");
      await expect(page.locator('[data-testid="anim-frame"]')).toHaveText("1 / 5");
      await page.locator('button[title="Step forward"]').click();
      await expect(page.locator('[data-testid="anim-frame"]')).toHaveText("2 / 5", { timeout: 5000 });
      await page.locator('button[title="Stop (reset)"]').click();

      // The unbounded saved-animations list demotes to a launcher whose flyout
      // hosts the full vertical list ("+ New" included).
      const savedLauncher = page.locator('[data-testid="anim-saved-list"]');
      await expect(savedLauncher).toBeVisible();
      await savedLauncher.click();
      const flyout = page.locator("[data-section-flyout]");
      await expect(flyout).toBeVisible({ timeout: 5000 });
      await expect(flyout.locator('[data-testid="anim-new"]')).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(flyout).not.toBeVisible();

      // Move back to the sidebar via the ribbon tab's context menu.
      await animationTab.click({ button: "right" });
      await page.getByRole("button", { name: /Move to Sidebar/ }).click();
      await expect(page.getByRole("button", { name: "Animation", exact: true })).toBeVisible({ timeout: 5000 });
    } finally {
      // Never leak a ribbon placement into other specs (it persists in
      // localStorage and animation.spec.ts expects the sidebar default).
      await setPlacement(page, "sidebar").catch(() => {});
    }
  });
});
