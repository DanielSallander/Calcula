/**
 * Custom Playwright fixtures that connect to the running Calcula WebView2
 * instance via CDP instead of launching a new browser.
 *
 * The CDP connection is worker-scoped (created once per worker, shared across
 * all tests). This avoids the flaky "Target page, context or browser has been
 * closed" errors caused by rapid connect/disconnect cycles on WebView2.
 *
 * Usage in tests:
 *   import { test, expect } from "../fixtures";
 */
import { test as base, expect, type Page, type Browser, chromium } from "@playwright/test";
import { GridHelper } from "./helpers/grid";

const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Worker-scoped fixtures (shared across all tests in one worker)
// ---------------------------------------------------------------------------
type WorkerFixtures = {
  /** Single CDP connection to the WebView2 instance, reused across tests. */
  cdpBrowser: Browser;
  /** The single WebView2 page. */
  sharedPage: Page;
};

// ---------------------------------------------------------------------------
// Test-scoped fixtures (per test)
// ---------------------------------------------------------------------------
type TestFixtures = {
  /** The WebView2 page — same as sharedPage but ensures focus is reset. */
  appPage: Page;
  /** Helper for interacting with the canvas-based grid. */
  grid: GridHelper;
};

async function connectWithRetry(): Promise<Browser> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      console.log(`[e2e] CDP connect attempt ${attempt} failed, retrying in ${RETRY_DELAY_MS}ms...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw new Error("unreachable");
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // ---- Worker-scoped: one CDP connection for the entire test run ----
  cdpBrowser: [
    async ({}, use) => {
      const browser = await connectWithRetry();
      await use(browser);
      // Disconnect (not close) at the very end of the worker.
      await browser.close();
    },
    { scope: "worker" },
  ],

  sharedPage: [
    async ({ cdpBrowser }, use) => {
      const contexts = cdpBrowser.contexts();
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

      await use(page);
    },
    { scope: "worker" },
  ],

  // ---- Test-scoped: lightweight reset per test ----
  appPage: async ({ sharedPage }, use) => {
    // Ensure the spreadsheet has focus at the start of each test.
    const container = sharedPage.locator("[data-focus-container='spreadsheet']");
    await container.focus();
    await sharedPage.waitForTimeout(200);
    await use(sharedPage);
  },

  grid: async ({ appPage }, use) => {
    const helper = new GridHelper(appPage);
    await use(helper);
  },
});

export { expect };
