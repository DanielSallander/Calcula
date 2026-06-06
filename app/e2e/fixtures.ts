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
  /** GridHelper that skips per-test cleanup — for serial workflow tests. */
  gridPersistent: GridHelper;
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

      // A prior worker may have left a Script Editor window open (separate
      // Tauri WebviewWindow). If multiple pages exist, find the main window
      // — the one with the spreadsheet container — not the Script Editor.
      const allPages = context.pages();
      if (allPages.length > 1) {
        for (const candidate of allPages) {
          const hasSpreadsheet = await candidate
            .waitForSelector("[data-focus-container='spreadsheet']", {
              state: "visible",
              timeout: 500,
            })
            .then(() => true)
            .catch(() => false);
          if (hasSpreadsheet) {
            page = candidate;
            break;
          }
        }
      }

      // Dismiss any dialogs left over from prior workers (all share the same app).
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Escape");
        await new Promise((r) => setTimeout(r, 50));
      }

      // Wait for the app to be fully loaded.
      // After a cold Rust build the React app may take 20-30s to render inside
      // WebView2, so use a generous timeout.  The invariant project sets its
      // test timeout to 120s, so 60s here is safe.
      await page.waitForSelector("[data-focus-container='spreadsheet']", {
        state: "visible",
        timeout: 60_000,
      });

      await use(page);
    },
    { scope: "worker" },
  ],

  // ---- Test-scoped: lightweight reset per test ----
  appPage: async ({ sharedPage }, use) => {
    // Close any open dialogs/menus left over from a prior test by pressing
    // Escape multiple times (DialogContainer listens on capture phase).
    for (let i = 0; i < 5; i++) {
      await sharedPage.keyboard.press("Escape");
      await sharedPage.waitForTimeout(50);
    }

    // Close any visible dialog close/cancel buttons (handles Script Editor, etc.)
    try {
      const closeBtn = sharedPage.locator(
        '[data-testid="dialog-close"], .dialog-close, [aria-label="Close"]'
      ).first();
      if (await closeBtn.isVisible({ timeout: 200 })) {
        await closeBtn.click({ timeout: 500 });
        await sharedPage.waitForTimeout(100);
      }
    } catch { /* no dialog open */ }

    // Close any open task panes via store reset
    await sharedPage.evaluate(() => {
      try {
        const store = (window as any).__CALCULA_TASKPANE_STORE__;
        if (store) store.getState().reset();
      } catch { /* store not available */ }
    });

    // Restore the ribbon to its expanded state. The ribbon minimize/expand
    // state (Ctrl+F1) is local React state shared by the single app instance,
    // so a prior test that left the ribbon minimized would shift every
    // subsequent screenshot down by ~92px AND hide the ribbon's formatting
    // buttons (fmt-copy, fmt-bold, ...), breaking unrelated functional tests.
    // If the ribbon content is hidden, dispatch the toggle event to re-expand.
    await sharedPage.evaluate(() => {
      const content = document.querySelector("[data-ribbon-content]");
      if (content && window.getComputedStyle(content).display === "none") {
        window.dispatchEvent(new CustomEvent("app:ribbon-toggle-minimize"));
      }
    });
    await sharedPage.waitForTimeout(100);

    // Navigate to A1 and ensure the spreadsheet has focus
    await sharedPage.keyboard.press("Escape");
    await sharedPage.waitForTimeout(50);
    const container = sharedPage.locator("[data-focus-container='spreadsheet']");

    // Always reset selection/scroll to A1 — prior tests may leave the grid
    // scrolled elsewhere. Control+Home is unreliable here because WebView2
    // swallows the combo before it reaches the grid's key handler, leaving the
    // grid scrolled to the bottom. Use the Name Box (a real DOM input) which
    // reliably selects A1 and scrolls it to the top-left of the viewport.
    const nameBox = sharedPage.locator('input[aria-label="Name Box"]');
    await nameBox.click();
    await nameBox.fill("A1");
    await sharedPage.keyboard.press("Enter");
    await sharedPage.waitForTimeout(150);
    await container.focus();
    await sharedPage.waitForTimeout(100);

    await use(sharedPage);
  },

  grid: async ({ appPage }, use) => {
    const helper = new GridHelper(appPage);
    await use(helper);
  },

  gridPersistent: async ({ sharedPage }, use) => {
    const helper = new GridHelper(sharedPage);
    await use(helper);
  },
});

export { expect };
