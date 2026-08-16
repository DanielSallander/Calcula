// @vitest-environment node
//
// ^ NOT decoration. The suite default is jsdom, and jsdom's `TextEncoder` does
// not produce a real `Uint8Array`; esbuild asserts that invariant on load and
// refuses to start, so this file cannot build anything under jsdom. It needs no
// DOM -- it reads emitted JavaScript.
//
//! FILENAME: app/e2e/__tests__/bootErrorMarkerSurvivesBuild.test.ts
// PURPOSE: FAIL if a production `vite build` drops the markers the startup
//          guard's `boot-error` arm identifies the root error boundary by.
//
// WHY, verbatim from the pass that shipped that arm and recorded its own hole:
//   "The `boot-error` arm keys on `data-testid` -- nothing verifies it survives a
//    production `vite build`. A future strip step would silently return the guard
//    to reading a crashed boot as healthy, with no test failing."
//
// `bootErrorSignals.test.ts` closes the semantic half (the probe still finds the
// REAL component in a REAL DOM, by either signal, independently). This file
// closes the toolchain half, and it does it by BUILDING rather than by reading
// the config and reasoning about it: an attribute can be removed by a Babel
// plugin inside `@vitejs/plugin-react`, by an esbuild option, by a `define`, or
// by a plugin in a preset three levels deep. Only the output settles it.
//
// IT IS A REAL PRODUCTION BUILD, THROUGH THE REAL CONFIG. `configFile` points at
// `app/vite.config.ts`, `mode` is `production` and `minify` is on; only the
// ENTRY is swapped, for one synthetic module that imports the boundary, so the
// build is the app's pipeline applied to the file under discussion instead of to
// all 1,420 modules. Measured on this machine: ~140 ms.
//
// PROVED BY SABOTAGE, not by reasoning (2026-08-15). A `data-testid`-stripping
// plugin inserted into `vite.config.ts` with `enforce: "pre"` took the minified
// chunk from 2,653 to 2,617 bytes and made the attribute assertion below fail,
// while the role and text assertions stayed green -- which is also the live
// proof that the fallback signal is independent of the attribute. NOTE the first
// sabotage attempt was a NO-OP (it ran after `@vitejs/plugin-react` had already
// turned the JSX into `jsx("div", { "data-testid": ... })`, so its regex matched
// nothing) and the test passed. A sabotage that is a no-op passes; that one was
// discarded and re-done until it actually changed the output.

import { describe, it, expect } from "vitest";
import { build, type Rollup } from "vite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BOOT_ERROR_SIGNALS } from "../pageState";

const APP_ROOT = process.cwd();
const BOUNDARY = path
  .join(APP_ROOT, "src/shell/RootErrorBoundary/RootErrorBoundary.tsx")
  .replace(/\\/g, "/");

/**
 * Build the boundary the way `npm run build` would, and hand back the emitted
 * JavaScript. Nothing is written to disk (`write: false`) so the app's real
 * `dist/` is never touched by a test run.
 */
async function buildBoundary(): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-boot-marker-"));
  try {
    const entry = path.join(tmp, "entry.tsx");
    fs.writeFileSync(
      entry,
      `import { RootErrorBoundary } from "${BOUNDARY}";\nexport default RootErrorBoundary;\n`,
      "utf8",
    );
    const result = await build({
      root: APP_ROOT,
      configFile: path.join(APP_ROOT, "vite.config.ts"),
      mode: "production",
      logLevel: "silent",
      build: {
        write: false,
        minify: "esbuild",
        outDir: path.join(tmp, "out"),
        rollupOptions: {
          input: entry,
          // React is the app's own runtime dependency and contributes nothing to
          // the question; externalising it keeps the build at ~140 ms.
          external: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
          output: { format: "es" },
        },
      },
    });
    const bundles = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
    let code = "";
    for (const bundle of bundles) {
      for (const chunk of bundle.output ?? []) {
        if (chunk.type === "chunk") code += chunk.code;
      }
    }
    return code;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("a production build keeps the markers the startup guard reads", () => {
  // One build, shared by every assertion below. 30s of headroom over the ~140 ms
  // measured, because a cold esbuild/rollup start on a busy machine is slower
  // and a flaky guard gets switched off.
  let code = "";

  it(
    "builds the boundary through the app's own production config",
    async () => {
      code = await buildBoundary();
      // THE CENSUS MUST NOT BE VACUOUS. An empty or trivially small bundle would
      // make every assertion below pass while proving nothing -- an
      // evidence-free golden, which this programme has already paid for once.
      expect(
        code.length,
        "the production build emitted (almost) nothing, so the marker assertions " +
          "below are asserting against an empty string and would pass forever.",
      ).toBeGreaterThan(500);
      // ...and it must really be the boundary, minified.
      expect(code).toContain("could not start");
    },
    30_000,
  );

  it("keeps the `data-testid` the barrier looks for first", () => {
    expect(
      code.includes(BOOT_ERROR_SIGNALS.testId),
      `a production build no longer emits \`${BOOT_ERROR_SIGNALS.testId}\`. Something in ` +
        "the build pipeline is stripping test attributes. The startup guard's boot-error " +
        "arm still works (it falls back to role+text, and says so in its banner), but the " +
        "primary signal is gone and every other `data-testid` in the E2E suite is gone " +
        "with it. See app/e2e/pageState.ts.",
    ).toBe(true);
  });

  it("keeps the role+text fallback, which no attribute stripper can reach", () => {
    // These two are the reason the guard survives the failure above. `role` is
    // an accessibility contract and the signature is the panel's own copy.
    expect(
      code.includes(`"${BOOT_ERROR_SIGNALS.role}"`) ||
        code.includes(`'${BOOT_ERROR_SIGNALS.role}'`),
      "the production build no longer emits the panel's `role`, so the startup guard's " +
        "fallback signal is gone: with the `data-testid` also stripped the guard would " +
        "read a crashed boot as a healthy mount -- silently, which is the whole thing " +
        "this test exists to prevent.",
    ).toBe(true);
    expect(
      code.includes(BOOT_ERROR_SIGNALS.textSignature),
      `the failure panel's text no longer contains "${BOOT_ERROR_SIGNALS.textSignature}". ` +
        "If the wording was deliberately changed, change `BOOT_ERROR_SIGNALS.textSignature` " +
        "in app/e2e/pageState.ts to match -- do not delete this assertion.",
    ).toBe(true);
  });
});
