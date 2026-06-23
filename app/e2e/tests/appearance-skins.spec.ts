import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * E2E coverage for the App Appearance / Skins feature: switching the app skin
 * (Light <-> Dark) from the Settings panel re-skins the chrome (CSS variables)
 * AND the canvas grid theme, persists the choice, and the accessibility override
 * always wins. DISTINCT from the Office-style Document Theme.
 *
 * IMPORTANT: the active skin is app-global and persisted to localStorage, and all
 * functional tests share ONE app instance. So this spec forces Light at the start
 * of every test and restores Light + clears appearance state afterwards, otherwise
 * a leaked Dark skin would taint every later functional/visual test. We never call
 * __resetSkinLoaderForTests here — that would orphan the live canvas subscription.
 */

/** Read a CSS custom property off :root (trimmed, lowercased). */
function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(),
    name
  );
}

/** Reset to the Light skin with no persisted user choice / accessibility. */
async function resetAppearance(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = await (window as any).__calcImport(
      new URL("/src/api/index.ts", document.baseURI).href
    );
    api.setUserAccessibility?.({});
    api.setActiveSkin("calcula.light");
    localStorage.removeItem("calcula.appearance.skinId");
    localStorage.removeItem("calcula.appearance.a11y");
    localStorage.removeItem("calcula.appearance.managedCache");
  });
}

/** Open the Settings panel on the Appearance tab (idempotent — handles the
 *  shared activity-bar panel being closed or on another view/tab). */
async function openAppearanceTab(page: Page): Promise<void> {
  const tab = page.locator("button").filter({ hasText: /^Appearance$/ });
  const visible = await tab.isVisible().catch(() => false);
  if (!visible) {
    await page.locator('button[aria-label="Settings"]').click();
    await page.waitForTimeout(300);
  }
  await tab.waitFor({ state: "visible", timeout: 5000 });
  await tab.click();
  await page.waitForTimeout(200);
}

/** Close the Settings activity panel if it is open (so we don't shift layout for
 *  later tests). */
async function closeSettingsPanel(page: Page): Promise<void> {
  const tab = page.locator("button").filter({ hasText: /^Appearance$/ });
  if (await tab.isVisible().catch(() => false)) {
    await page.locator('button[aria-label="Settings"]').click();
    await page.waitForTimeout(150);
  }
}

test.describe("Appearance / Skins", () => {
  test.beforeEach(async ({ appPage }) => {
    await resetAppearance(appPage);
  });

  test.afterEach(async ({ appPage }) => {
    await resetAppearance(appPage);
    await closeSettingsPanel(appPage);
  });

  test("switching to Dark re-skins chrome + grid and persists", async ({ appPage }) => {
    const page = appPage;

    // Baseline is the Light skin.
    expect(await cssVar(page, "--grid-bg")).toBe("#ffffff");
    expect(await cssVar(page, "--text-primary")).toBe("#111827");

    await openAppearanceTab(page);

    // Switch to Dark via the skin card.
    await page.locator('button[title="Dark"]').click();
    await page.waitForTimeout(150);

    // Chrome CSS variables flipped to the dark baseline.
    expect(await cssVar(page, "--grid-bg")).toBe("#1e1e1e");
    expect(await cssVar(page, "--text-primary")).toBe("#e0e0e0");

    // Choice persisted, and the CANVAS grid theme resolves dark (proving the
    // separate GridTheme path — not just CSS — was applied).
    const state = await page.evaluate(async () => {
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href
      );
      const active = api.getActiveSkin();
      return {
        skinId: localStorage.getItem("calcula.appearance.skinId"),
        base: active.base,
        gridBg: api.getSkinGridTheme(active).cellBackground,
      };
    });
    expect(state.skinId).toBe("calcula.dark");
    expect(state.base).toBe("dark");
    expect(String(state.gridBg).toLowerCase()).toBe("#1e1e1e");

    // Switching back to Light via the UI restores the chrome.
    await page.locator('button[title="Light"]').click();
    await page.waitForTimeout(150);
    expect(await cssVar(page, "--grid-bg")).toBe("#ffffff");
  });

  test("the Dark choice is persisted to localStorage for next boot", async ({ appPage }) => {
    const page = appPage;

    await openAppearanceTab(page);
    await page.locator('button[title="Dark"]').click();
    await page.waitForTimeout(150);

    // The persisted id is what initSkinLoader() reads at the next launch
    // (boot-time re-application is covered by the skinLoader unit tests).
    const skinId = await page.evaluate(() => localStorage.getItem("calcula.appearance.skinId"));
    expect(skinId).toBe("calcula.dark");
  });

  test("high-contrast accessibility forces strong text over the skin", async ({ appPage }) => {
    const page = appPage;

    const result = await page.evaluate(async () => {
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href
      );
      api.setActiveSkin("calcula.light");
      api.setUserAccessibility({ highContrast: true });
      const read = (n: string) =>
        getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase();
      return { textPrimary: read("--text-primary"), gridText: read("--grid-text") };
    });

    // High contrast overrides the skin's text tokens with pure black on a light base.
    expect(result.textPrimary).toBe("#000000");
    expect(result.gridText).toBe("#000000");
  });
});
