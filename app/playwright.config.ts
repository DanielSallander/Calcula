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
 *   yarn e2e              -- functional E2E tests only
 *   yarn e2e:visual       -- visual regression tests only
 *   yarn e2e:all          -- both functional and visual tests
 *   yarn e2e:manual       -- skip auto-launch; connect to already-running app
 *   yarn e2e:report       -- open the HTML report from last run
 *
 * Update visual baselines:
 *   yarn e2e:visual:update -- regenerate golden screenshots
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Store golden baselines alongside the test files
      maxDiffPixelRatio: 0.005,
      threshold: 0.2,
      animations: "disabled",
    },
  },
  fullyParallel: false,          // serial — single app instance
  retries: 0,
  workers: 1,                    // one worker — single CDP connection
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "./e2e/results/results.json" }],
  ],

  // Snapshot paths: baselines stored next to test files in __screenshots__/
  snapshotPathTemplate: "{testDir}/{testFileDir}/__screenshots__/{testFileName}/{arg}{ext}",

  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",

  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "functional",
      testDir: "./e2e/tests",
      testMatch: "**/*.spec.ts",
    },
    {
      name: "visual",
      testDir: "./e2e/visual",
      testMatch: "**/*.spec.ts",
    },
  ],
});
