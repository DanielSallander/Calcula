import { defineConfig } from "@playwright/test";
import { SCREENSHOT_DEFAULTS } from "./e2e/helpers/screenshotGates";

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
    // Comparison gates: ONE definition, in e2e/helpers/screenshotGates.ts, which
    // also records how the numbers were measured. This is the value that governs
    // any toHaveScreenshot() written directly in a spec — i.e. every assertion
    // that does NOT go through e2e/helpers/screenshots.ts, which spreads the
    // same constant. Do not inline the numbers here again.
    toHaveScreenshot: { ...SCREENSHOT_DEFAULTS },
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
    // A SINGLE ACTION MAY NOT HANG. Playwright's default `actionTimeout` is 0,
    // i.e. NO timeout: `locator.click()` waits for actionability forever and the
    // only bound is the test timeout.
    //
    // MEASURED 2026-08-11, and this is why the number is here rather than in a
    // comment somewhere: an `invariant` walk stopped at
    // `[step 47/75] ribbon.switch-tab` and printed NOTHING for the next twelve
    // minutes on a live, RESPONDING app. The action probes `isVisible({timeout:
    // 500})` and then calls a bare `.click()`, so a button that is visible but
    // never actionable (covered by an overlay, or never stable) parks there —
    // and `state-consistency.spec.ts` raises its own ceiling with
    // `test.setTimeout(1_500_000)`, so the hang had **25 minutes** to run in,
    // silently. A hang is invisible to an exit-status check, which is the one
    // failure mode this whole program keeps deleting.
    //
    // 30s is well above the slowest legitimate action measured in these suites
    // (the app's own heavy dialogs settle in single-digit seconds), so this
    // cannot turn a slow action into a false failure — it turns an INFINITE one
    // into a reported failure that names the locator.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: "functional",
      testDir: "./e2e/tests",
      testMatch: "**/*.spec.ts",
      // The monkey walk is NOT a functional test and must not run inside this
      // suite. Everything in ./e2e/tests shares one app instance and one
      // accumulating workbook, which is why `journey` exists as a separate
      // project: a spec that disturbs the whole document shifts unrelated
      // goldens. `state-consistency` is the largest such disturber in the tree
      // — it deep-resets the workbook (deleting every table, chart, pivot and
      // slicer earlier specs created), then applies up to 75 RANDOM mutating
      // actions, and roughly twenty specs run after it alphabetically. It has
      // had its own `invariant` project the whole time; it was simply also
      // being picked up here. It is also budgeted for an in-spec ddmin shrink
      // on failure, which is minutes, not the 30s this project assumes.
      testIgnore: "**/state-consistency.spec.ts",
    },
    {
      name: "visual",
      testDir: "./e2e/visual",
      testMatch: "**/*.spec.ts",
    },
    {
      // End-to-end JOURNEYS that deliberately disturb the whole document
      // (new_file, open_file, a frontend reload, or a real window close).
      //
      // They live outside ./e2e/tests on purpose. The functional specs share one
      // app instance AND one accumulating workbook -- `resetGrid` only clears
      // A1:Z1000, so every screenshot baseline encodes the residue of the specs
      // that ran before it. A spec that wipes or reopens the document therefore
      // shifts unrelated goldens, and one that closes the window ends the run.
      // Keeping them in their own project makes them explicit to invoke and
      // harmless to `yarn e2e`.
      name: "journey",
      testDir: "./e2e/journeys",
      testMatch: "**/*.spec.ts",
      // A real AutoRecover cycle is a 60s wait; a cold reload is up to 90s.
      timeout: 300_000,
    },
    {
      name: "invariant",
      testDir: "./e2e/tests",
      testMatch: "**/state-consistency.spec.ts",
      // Oracle checkpoints (digest + undo/redo round-trip + recalc +
      // periodic save/reload) add real time per run.
      timeout: 300_000,
    },
    {
      // Soak walks: long random action sequences with semantic oracles and
      // in-spec trace minimization. Driven by SOAK_* env vars; see
      // e2e/soak/soak-walk.spec.ts. Run via tests/soak/soak-runner.mjs.
      name: "soak",
      testDir: "./e2e/soak",
      testMatch: "**/*.spec.ts",
      timeout: Number(process.env.SOAK_TIMEOUT_MS ?? 1_800_000),
    },
    {
      // Real-user workflow scenarios with oracle checkpoints per phase.
      name: "scenario",
      testDir: "./e2e/scenarios",
      testMatch: "**/*.scenario.ts",
      timeout: 300_000,
    },
  ],
});
