//! FILENAME: app/e2e/wedgeMarker.ts
// PURPOSE: THE one path of the "the application stopped ANSWERING" marker file.
// CONTEXT: The sibling of `appDiedMarker.ts`, for the other half of the same
//          problem, and a LEAF for the same reason: `global-setup.ts` runs in
//          Node before the test runner exists and must be able to clear this
//          path without importing `fixtures.ts` and dragging the Playwright
//          fixture graph in with it.
//
//          WHY A SECOND MARKER RATHER THAN REUSING APP-DIED. They are different
//          facts with different remedies, and conflating them is what left the
//          expensive case invisible. §3bx built APP-DIED for an app that is
//          GONE: CDP refuses, `connectWithRetry` exhausts its three attempts in
//          ~3 s, and hundreds of tests "fail" in 1 ms each. This marker is for
//          an app that is PRESENT AND USELESS: the process is up, CDP answers,
//          the React tree is mounted and `[data-focus-container='spreadsheet']`
//          is visible — every existing health check says "healthy" — while the
//          Rust backend never returns from a Tauri command.
//
//          Measured 2026-08-16: that state cost one journey run 64 consecutive
//          failures, every one a full 300 s timeout, 5.4 hours, and the run was
//          abandoned at test 101 of 157. Left alone it would have run ~11.8 h.
//          Not one of those 64 carried any attribution: `page.evaluate` has no
//          timeout in Playwright's API, so a command that never returns simply
//          parks the test until the per-test budget expires, with no error text
//          and nothing naming the app as the cause.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Directory holding the guard's cross-process state (the marker and the
 * pre-latch probe counter).
 *
 * `E2E_WEDGE_STATE_DIR` exists so the guard's own unit tests can point this at a
 * temp directory. Without it those tests write and delete the REAL marker, and
 * running them while an E2E run is in progress would latch that run's guard and
 * fail every remaining test — a unit test able to red a live suite. Unset in
 * every normal run, which is when this resolves to `e2e/results`.
 */
export const WEDGE_STATE_DIR =
  process.env.E2E_WEDGE_STATE_DIR ?? path.join(HERE, "results");

/**
 * Written by `e2e/fixtures.ts` when the backend is proved unresponsive, cleared
 * by `global-setup.ts` at the start of every run, read by `global-teardown.ts`
 * so the run ends with a banner naming the condition instead of a failure count
 * that implies 64 independent defects.
 */
export const APP_WEDGED_MARKER = path.join(WEDGE_STATE_DIR, "APP-WEDGED.txt");

/**
 * The pre-latch consecutive-bad-probe count. On disk rather than in a module
 * variable because Playwright rebuilds the worker after every failed test, and a
 * rebuilt worker re-imports the module — see the long note in `wedgeGuard.ts`.
 */
export const WEDGE_PROBE_COUNT_FILE = path.join(WEDGE_STATE_DIR, ".wedge-probe-count");
