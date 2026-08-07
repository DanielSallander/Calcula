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
      // Comparison gates. Keep in sync with DEFAULT_SCREENSHOT_OPTIONS in
      // e2e/helpers/screenshots.ts, which explains how they were measured.
      //
      // `threshold` is pixelmatch's YIQ colour-distance gate, NOT a per-channel
      // tolerance: a pixel counts as different only when its squared YIQ
      // distance exceeds 35215 * threshold^2. Calcula's gridlines are #f1f1f1
      // on white (ΔY 14), which pixelmatch stops seeing above 0.053 — at the
      // former 0.2 an entirely erased gridline scored 0 differing pixels and
      // no grid-geometry change could ever fail. Anything above ~0.038 blinds
      // the suite to the grid; measured run-to-run noise at 0.02 is 0 pixels
      // on 74 of 76 captures.
      //
      // Effective pixel budget is min(maxDiffPixels, maxDiffPixelRatio * px):
      // 200 px on a full grid capture, ~15 px on a status-bar strip.
      maxDiffPixels: 200,
      maxDiffPixelRatio: 0.0005,
      threshold: 0.02,
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
