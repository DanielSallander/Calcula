/**
 * Custom Playwright fixture that connects to the running Calcula WebView2
 * instance via CDP instead of launching a new browser.
 *
 * Usage in tests:
 *   import { test, expect } from "../fixtures";
 */
import { test as base, expect, type Page, chromium } from "@playwright/test";
import { GridHelper } from "./helpers/grid";

const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);

type CalcFixtures = {
  /** The WebView2 page connected via CDP. */
  appPage: Page;
  /** Helper for interacting with the canvas-based grid. */
  grid: GridHelper;
};

export const test = base.extend<CalcFixtures>({
  // eslint-disable-next-line no-empty-pattern
  appPage: async ({}, use) => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const contexts = browser.contexts();

    // WebView2 exposes one default context with one page.
    const context = contexts[0];
    if (!context) throw new Error("No browser context found — is Calcula running?");

    const pages = context.pages();
    let page = pages[0];
    if (!page) {
      page = await context.waitForEvent("page", { timeout: 10_000 });
    }

    // Wait for the app to be fully loaded.
    await page.waitForSelector("[data-focus-container='spreadsheet']", {
      timeout: 30_000,
    });

    // Give the grid a moment to finish its initial render.
    await page.waitForTimeout(500);

    await use(page);

    // Don't close the browser — it's the live app, not a test browser.
    // Just disconnect Playwright's CDP session.
    browser.close();
  },

  grid: async ({ appPage }, use) => {
    const helper = new GridHelper(appPage);
    await use(helper);
  },
});

export { expect };
