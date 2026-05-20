import { defineConfig } from "@playwright/test";

/**
 * Playwright E2E configuration for Calcula (Tauri + WebView2).
 *
 * How it works:
 *   1. A global-setup script launches `cargo tauri dev` with WebView2
 *      remote-debugging enabled (CDP on port 9222).
 *   2. Each test file uses the custom fixture in e2e/fixtures.ts which
 *      connects Playwright to the running WebView2 via CDP.
 *   3. A global-teardown script kills the Tauri process.
 *
 * Usage:
 *   npm run e2e           -- full automatic run (launches app, tests, teardown)
 *   npm run e2e:headed    -- same but keeps the app visible (it already is, but
 *                            Playwright traces are collected)
 *   npm run e2e:manual    -- skip auto-launch; connect to an already-running
 *                            Calcula instance that was started with CDP enabled
 */
export default defineConfig({
  testDir: "./e2e/tests",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,          // serial — single app instance
  retries: 0,
  workers: 1,                    // one worker — single CDP connection
  reporter: [["list"], ["html", { open: "never" }]],

  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",

  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
