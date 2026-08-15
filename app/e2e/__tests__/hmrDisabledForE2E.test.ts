//! FILENAME: app/e2e/__tests__/hmrDisabledForE2E.test.ts
// PURPOSE: Keep the E2E app OFF the Vite hot-reload channel, in both launchers
//          and in the Vite config that honours them.
// CONTEXT: The app under test is a `tauri dev` build whose frontend is served by
//          the Vite dev server, and that server pushes to whatever is connected —
//          including a suite that is halfway through a capture.
//
//          MEASURED 2026-08-15 on an isolated app (CDP 9223) while another agent
//          saved `app/src/core/lib/events.ts`:
//
//            - Vite pushed `hmr update` for ~170 modules, and for several files
//              `page reload (circular import invalidate)`.
//            - React fast-refresh remounted the provider tree, so GridProvider's
//              `useReducer` restarted from `getInitialState()`: the selection
//              snapped from W7 back to A1 and `scrollX` from 286 to 0, about
//              2.5 s after the harness had deliberately parked them.
//            - There was NO navigation. `performance.timeOrigin` was unchanged
//              and a `window` marker installed before the update survived it, so
//              nothing in the page — and nothing in Playwright — could tell that
//              the app had been reset underneath the test.
//
//          A capture taken across that window is a photograph of the editor, not
//          of the product, and it is indistinguishable from a product change.
//          Cutting the channel made the same state hold still for 10 s and the
//          same capture come back byte-identical 8 times out of 8.
//
//          The fix is one line in `vite.config.ts` gated on an env var that only
//          the two E2E launchers set, so interactive development keeps HMR. This
//          test pins all three halves together: if a launcher stops setting the
//          flag, or the config stops reading it, the guard is gone and nothing
//          else would say so.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(APP_ROOT, rel), "utf8");

/** The env var the launchers set and the Vite config reads. */
export const E2E_ENV_FLAG = "CALCULA_E2E";

describe("the E2E app is not hot-reloadable", () => {
  it("vite.config.ts turns HMR off when the E2E flag is set", () => {
    const cfg = read("vite.config.ts");
    expect(
      cfg.includes(E2E_ENV_FLAG),
      `vite.config.ts does not mention ${E2E_ENV_FLAG}. Without it the E2E app stays ` +
        `on the hot-reload channel and any source save resets the grid mid-run.`,
    ).toBe(true);
    expect(
      /hmr\s*:/.test(cfg),
      "vite.config.ts declares no `hmr` option, so nothing can disable it for E2E.",
    ).toBe(true);
    // The gate must DISABLE on the flag, not enable on it.
    expect(
      /hmr\s*:[^,]*false/.test(cfg.replace(/\s+/g, " ")),
      "the `hmr` option never resolves to `false` — check the gate's polarity.",
    ).toBe(true);
  });

  it("both launchers set the flag on the tauri dev child", () => {
    for (const rel of ["e2e/global-setup.ts", "e2e/launch-app.mjs"]) {
      const src = read(rel);
      expect(
        new RegExp(`${E2E_ENV_FLAG}\\s*:`).test(src),
        `${rel} spawns \`tauri dev\` without ${E2E_ENV_FLAG}, so the Vite server it ` +
          `starts keeps HMR on and a source save can reset the app mid-suite.`,
      ).toBe(true);
    }
  });
});
