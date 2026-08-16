//! FILENAME: app/e2e/__tests__/startupBarrierWired.test.ts
// PURPOSE: Keep the startup guard PLUGGED IN. `startupGuard.test.ts` proves the
//          detector fires and the sentence is right; this file proves the four
//          halves are still connected to each other, because a guard that is
//          correct and unwired is decorative -- and its absence is silent.
//
// CONTEXT: BUG-0082 / open-decisions §32. The mechanism spans four files by
//          necessity, exactly as the "the application went away" marker spans
//          three (§3bx):
//
//            global-setup.ts   CLEARS the marker, and RUNS the barrier -- in the
//                              manual branch too, which is where every measured
//                              occurrence happened.
//            startupBarrier.ts reads the live page and throws before test one.
//            fixtures.ts       RECORDS the same state when a worker finds it
//                              later.
//            collectionGuard.ts READS the marker and fails the run.
//
//          Any one of those going missing restores the old behaviour -- N
//          product-looking failures -- and nothing else in the tree would
//          notice. These are source-text pins, the same instrument
//          `hmrDisabledForE2E.test.ts` uses for the same reason.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");

describe("the startup barrier is wired into global-setup", () => {
  const setup = read("e2e/global-setup.ts");

  it("clears the marker so a banner can only be about THIS run", () => {
    expect(
      setup.includes("clearStartupFailure()"),
      "global-setup.ts never clears the startup-failure marker, so one dead run " +
        "would condemn every later one until someone deleted the file by hand.",
    ).toBe(true);
  });

  it("runs the barrier in BOTH the auto-launch and the manual branch", () => {
    const calls = setup.match(/await assertAppMounted\(/g) ?? [];
    expect(
      calls.length,
      "global-setup.ts must call assertAppMounted twice: once in the E2E_MANUAL " +
        "branch (which returns early -- and manual mode is how soak/invariant/" +
        "visual are driven, i.e. every BUG-0082 occurrence) and once after the " +
        "auto-launch waits.",
    ).toBe(2);
  });

  it("gates the run on it BEFORE the first test rather than reporting afterwards", () => {
    // The barrier's whole advantage over the fixture diagnosis is position: a
    // throw from global-setup runs zero tests, so there is no number to misread.
    const manualIdx = setup.indexOf('process.env.E2E_MANUAL === "1"');
    const firstCall = setup.indexOf("await assertAppMounted(");
    expect(manualIdx).toBeGreaterThan(-1);
    expect(firstCall).toBeGreaterThan(manualIdx);
  });
});

describe("the fixture records the same state when it finds it late", () => {
  const fixtures = read("e2e/fixtures.ts");

  it("imports and calls recordStartupFailure", () => {
    expect(fixtures.includes('from "./startupGuard"')).toBe(true);
    expect(
      /recordStartupFailure\(message\)/.test(fixtures),
      "fixtures.ts diagnoses an unmounted app and then keeps it to itself: " +
        "without the marker the run still ends with a number instead of a banner.",
    ).toBe(true);
  });

  it("records ONLY the unmounted arm, never the mounted one", () => {
    // A mounted app missing the spreadsheet container is a PRODUCT question.
    // Recording that as a harness failure would be the same lie in the other
    // direction: it would excuse a real regression.
    expect(fixtures).toContain(
      "if (probe.rootChildCount <= 0 && probe.bootErrorText === null)",
    );
  });

  it("excludes a rendered root error boundary from the harness marker", () => {
    // BUG-0083's boundary renders INTO `#root`, so `rootChildCount` alone can no
    // longer separate "the frontend never ran" from "the frontend ran and the
    // product threw". The marker triggers a banner that says THESE ARE NOT TEST
    // RESULTS AND NOT A PRODUCT FAILURE; printing that over a genuine boot crash
    // would exonerate the code that broke. The fixture must read the boundary.
    expect(fixtures).toContain("probe.bootErrorText");
  });

  it("reads the page through the SHARED probe, not a private copy of it", () => {
    // The fixture and the barrier each had their own inline page reading, and
    // they had already drifted: the fixture read four fields to the barrier's
    // ten, and only one of the two trimmed the boundary text. Two copies that
    // happen to agree are not one source of truth, and the drift is silent --
    // the half that is not updated goes on calling a crashed boot a healthy
    // mount.
    expect(fixtures).toContain('from "./pageState"');
    expect(fixtures).toContain("readPageState");
    expect(fixtures).toContain("BOOT_ERROR_SIGNALS");
  });
});

describe("the barrier reads the root error boundary, not just #root's count", () => {
  const barrier = read("e2e/startupBarrier.ts");

  it("probes for the boundary in the page state it collects", () => {
    // Without this the guard's ONLY mount signal is `#root.childElementCount`,
    // which BUG-0083's failure panel satisfies -- so a crashed boot is waved
    // through and re-emerges as N spreadsheet-selector timeouts.
    expect(barrier).toContain("readPageState");
    expect(barrier).toContain("BOOT_ERROR_SIGNALS");
  });
});

describe("the boot-error marker does not rest on ONE strippable attribute", () => {
  // THE FRAGILITY THIS CLOSES, in the words of the pass that shipped it: "the
  // `boot-error` arm keys on `data-testid` -- nothing verifies it survives a
  // production `vite build`. A future strip step would silently return the guard
  // to reading a crashed boot as healthy, with no test failing."
  const pageState = read("e2e/pageState.ts");

  it("carries a second, non-attribute signal", () => {
    expect(pageState).toContain("root-error-boundary");
    // `role` is an accessibility contract and text is content: neither is what
    // an attribute-stripping build step removes.
    expect(pageState).toContain('role: "alert"');
    expect(pageState).toContain('textSignature: "failed to start"');
  });

  it("reports WHICH signal fired, so a lost attribute is loud", () => {
    expect(pageState).toContain("bootErrorSignal");
    expect(read("e2e/startupGuard.ts")).toContain('p.bootErrorSignal === "role+text"');
  });

  it("its unreadable-page fallback reports null, not an empty string", () => {
    // "" would be a CLAIM that a boundary is present and said nothing.
    expect(pageState).toContain("bootErrorText: null,");
  });
});

describe("the ONE guard reporter carries the startup arm", () => {
  const guard = read("e2e/collectionGuard.ts");

  it("reads the marker and fails the run", () => {
    expect(guard.includes("readStartupFailure()")).toBe(true);
    expect(guard.includes("startupFailureBanner(")).toBe(true);
  });

  it("checks it BEFORE the collection comparison's own early returns", () => {
    // `collected === null` (a run aborted in global-setup) and
    // `COLLECTION_GUARD=off` both return undefined. If the startup arm sat after
    // either, the exact runs it exists for would slip past it.
    const startup = guard.indexOf("readStartupFailure()");
    const off = guard.indexOf('process.env.COLLECTION_GUARD === "off"', guard.indexOf("async onEnd"));
    const collectedNull = guard.indexOf("this.collected === null");
    expect(startup).toBeGreaterThan(-1);
    expect(startup).toBeLessThan(off);
    expect(startup).toBeLessThan(collectedNull);
  });

  it("stays first in the config's reporter list", () => {
    const config = read("playwright.config.ts");
    const reporters = config.slice(config.indexOf("reporter: ["));
    expect(reporters.indexOf("collectionGuard")).toBeLessThan(reporters.indexOf('["list"]'));
  });
});
