//! FILENAME: app/e2e/__tests__/e2eIsTypeChecked.test.ts
// PURPOSE: Keep the E2E harness inside the type gate.
//
// FOUND 2026-08-15, while closing the startup guard's `data-testid` fragility:
// `npm run check-types` compiled `src/`, `extensions/` and `scripts/` and NOT
// ONE of the 212 TypeScript files under `app/e2e/`. Playwright and vitest both
// transpile with esbuild, which strips types WITHOUT checking them, so a type
// error anywhere in the harness -- fixtures, helpers, the collection guard, the
// app-died marker, the startup barrier -- was invisible until it threw at
// runtime, inside a run whose entire purpose is to say whether the PRODUCT is
// broken.
//
// The gate now runs `tsconfig.e2e.json` too. This file is what stops that from
// being quietly unwired: a project nothing references is one edit from being
// decorative, and its absence is silent -- the same instrument (a source-text
// pin) `hmrDisabledForE2E.test.ts` and `startupBarrierWired.test.ts` use, for
// the same reason.
//
// It asserts the WIRING, not the result. Whether the harness type-checks is what
// `npm run check-types` answers, in seconds, on every gate run; re-running tsc
// from inside vitest would add ~20 s to the unit suite to answer a question the
// gate already answers.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const APP_ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");

describe("the E2E harness is inside the type gate", () => {
  it("has a type-check project of its own", () => {
    expect(
      existsSync(join(APP_ROOT, "tsconfig.e2e.json")),
      "app/tsconfig.e2e.json is gone, so nothing type-checks app/e2e/ at all.",
    ).toBe(true);
  });

  it("`npm run check-types` actually runs it", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.["check-types"] ?? "";
    expect(
      script.includes("tsconfig.e2e.json"),
      "check-types no longer compiles tsconfig.e2e.json. The harness is back outside " +
        "the type gate: esbuild strips its types without checking them, so the next " +
        "type error there surfaces as a mid-run throw in a suite that is supposed to " +
        "be reporting on the product.",
    ).toBe(true);
    // The app project must still be there too -- "replaced" is as bad as "removed".
    expect(script).toContain("tsconfig.check.json");
  });

  it("the project actually covers the harness rather than an empty glob", () => {
    // A tsconfig whose `include` matches nothing type-checks nothing and exits 0
    // forever -- an evidence-free green, which this programme has already paid
    // for once (75 visual baselines that could not fail).
    const cfg = read("tsconfig.e2e.json");
    expect(cfg).toContain("e2e/**/*.ts");
    // The startup guard is the reason this was noticed; if the project ever
    // stops covering it, the pin should say so in those words.
    expect(existsSync(join(APP_ROOT, "e2e/startupGuard.ts"))).toBe(true);
  });

  it("does not drag Node globals into the app's own program", () => {
    // The two projects are separate because their `types` differ. If the app
    // project ever gained `node`, a `process.env` read would type-check its way
    // into the WebView bundle.
    const appCfg = read("tsconfig.app.json");
    expect(appCfg).not.toContain('"node"');
  });
});
