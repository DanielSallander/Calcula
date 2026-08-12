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
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { GridHelper } from "./helpers/grid";
import { APP_DIED_MARKER } from "./appDiedMarker";

const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Re-exported for the specs and helpers that already import it from here.
 * The path itself lives in `./appDiedMarker` so that all THREE stages of the
 * mechanism -- clear, write, read -- take it from one place.
 */
export { APP_DIED_MARKER };

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

/** How many `app.exe` processes exist right now. -1 when the query itself failed. */
function countAppProcesses(): number {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "@(Get-Process app -ErrorAction SilentlyContinue).Count"',
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
    ).trim();
    return /^\d+$/.test(out) ? Number(out) : -1;
  } catch {
    return -1;
  }
}

/**
 * THE APPLICATION GOING AWAY IS NOT A TEST RESULT, AND IT USED TO LOOK LIKE ONE.
 *
 * Every spec in a project shares ONE app instance and ONE worker. When that app
 * dies mid-run — a `Stop-Process -Force` from another launcher, a `tauri dev`
 * file-watcher rebuild triggered by an edit under `src-tauri`, a real abort —
 * this fixture can no longer connect. Playwright's answer is to fail the test
 * and restart the worker, which tries again, fails again, and keeps going:
 * MEASURED on 2026-08-11, a run whose app was killed at test 166 of ~550
 * carried on to produce **hundreds of 1 ms "failures"**, none of which were
 * about the product. The report is then indistinguishable from a catastrophic
 * regression, and the run has to be thrown away by hand — after it has burnt
 * another half hour.
 *
 * So the harness says it out loud, once, in the place that knows: the connect
 * that failed. It records WHETHER AN `app.exe` EXISTS AT ALL, because that is
 * what separates the two very different situations:
 *
 *   0 processes  -> the app is gone. Nothing after this line is a test result.
 *   >=1          -> the app is up but its CDP port is not answering (a restart
 *                   in progress, or a second instance launched without
 *                   `--remote-debugging-port`), which is a different fix.
 *
 * A marker file is left for `global-teardown.ts` so the run ENDS with the
 * statement too — a banner at the bottom of the log, where the reader is
 * looking, rather than one line lost among the failures.
 *
 * IT DOES NOT SKIP AND IT DOES NOT SWALLOW. A crash caused by the product must
 * still fail the suite; turning these into skips would hide exactly the thing
 * this program exists to catch. What changes is that the failure now NAMES its
 * cause instead of presenting as an assertion.
 */
/**
 * The message, as a PURE function of the two facts that decide it.
 *
 * Split out from the side-effecting reporter so it has a unit tier: the whole
 * value of this guard is the WORDING (it is what a reader will act on), and a
 * guard whose wording nothing checks is one edit away from going back to
 * "connect failed". `e2e/__tests__/appGoneMessage.test.ts` pins all three arms.
 */
export function describeUnreachableApp(
  appProcessCount: number,
  cause: unknown,
  cdpPort: number = CDP_PORT,
  attempts: number = MAX_RETRIES,
): string {
  const verdict =
    appProcessCount === 0
      ? "NO app.exe IS RUNNING — the application is gone. Nothing reported after " +
        "this point is a test result; re-launch and re-run."
      : appProcessCount > 0
        ? `${appProcessCount} app.exe process(es) are running but CDP port ${cdpPort} is not ` +
          "answering — the app is probably restarting (a `tauri dev` rebuild after " +
          "an edit under src-tauri), or an instance was launched without " +
          "--remote-debugging-port."
        : "could not query the process list, so whether the app is running is unknown.";

  return (
    `[e2e] CANNOT REACH THE APPLICATION on CDP port ${cdpPort} after ${attempts} attempts.\n` +
    `      ${verdict}\n` +
    `      Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`
  );
}

function reportAppGone(cause: unknown): Error {
  const apps = countAppProcesses();
  const message = describeUnreachableApp(apps, cause);

  try {
    fs.mkdirSync(path.dirname(APP_DIED_MARKER), { recursive: true });
    fs.writeFileSync(
      APP_DIED_MARKER,
      `${new Date().toISOString()}\napp.exe processes: ${apps}\n${message}\n`,
      "utf-8",
    );
  } catch {
    // A marker we cannot write must not replace the error we can throw.
  }
  console.error(message);
  return new Error(message);
}

async function connectWithRetry(): Promise<Browser> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw reportAppGone(error);
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
    // Worker-scoped: this setup does a cold-WebView2 waitForSelector of up to 60s
    // (above). Give the FIXTURE a timeout comfortably beyond that so the inner 60s
    // is the binding limit — otherwise the 30s test-default timeout aborts the cold
    // first-render before 60s, flaking the first test after a cargo-tauri-dev launch.
    { scope: "worker", timeout: 90_000 },
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

    // DISMISS TOASTS LEFT BY THE PREVIOUS TEST. One app instance serves every
    // spec, and a toast lives 5s by default — long enough to outlive the test
    // that raised it. The stack is fixed at the bottom-right ABOVE the grid, so
    // a leftover toast physically covers cells there: the next test's
    // `clickCell` lands on the toast, focus never reaches the grid, and the
    // keystrokes go nowhere. That is exactly how macro-live-edit failed after
    // macro-link-model (which ends by raising three of them) — an empty cell
    // and a failure that looks like a dropped keystroke.
    await sharedPage.evaluate(() => {
      document
        .querySelectorAll<HTMLElement>("[data-toast] button")
        .forEach((b) => b.click());
    });
    await sharedPage.waitForTimeout(100);

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
