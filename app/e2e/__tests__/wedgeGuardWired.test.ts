//! FILENAME: app/e2e/__tests__/wedgeGuardWired.test.ts
// PURPOSE: Keep the BUG-0098 wedge guard PLUGGED IN. `wedgeGuard.test.ts` and
//          `wedgeInstrumentation.test.ts` prove the detector works and the
//          sentence it prints is right; neither of them reads `fixtures.ts`, so
//          both stay green if the one call that makes the guard run is deleted.
//          This file is the wiring half, modelled on
//          `startupBarrierWired.test.ts` and written for the same reason its
//          header gives: a guard that is correct and unwired is decorative, and
//          its absence is silent.
//
// CONTEXT: BUG-0098 / open-items.md 2.5. On 2026-08-16 a journey run failed 64
//          consecutive tests over 5.4 hours, every one on timeout, none on an
//          assertion, while CDP kept answering and the grid container stayed
//          visible. The guard that now catches that races a real
//          `invoke("get_cell")` against a 5 s budget, latches after two bad
//          probes, and then fails the rest of the run in ~0 ms. All of that
//          value is carried by ONE line — the `checkForWedge` call in the
//          `appPage` fixture — and 16 passing tests do not touch it.
//
//          POSITION MATTERS, not just presence. The probe has to come BEFORE
//          the fixture's page operations: those are the things that hang when
//          the backend has stopped answering, so a probe placed after them
//          waits out their timeouts first and the run costs hours anyway. That
//          is the failure this bug IS, so the order is asserted, not assumed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");

describe("the wedge guard is wired into the test fixtures", () => {
  const fixtures = read("e2e/fixtures.ts");

  it("imports checkForWedge from the guard module", () => {
    expect(
      /from "\.\/wedgeGuard"/.test(fixtures),
      "fixtures.ts no longer imports from ./wedgeGuard, so nothing probes the " +
        "backend between tests and a mid-run wedge is invisible again.",
    ).toBe(true);
    expect(fixtures).toContain("checkForWedge");
  });

  it("calls it, and acts on the answer instead of discarding it", () => {
    const calls = fixtures.match(/await checkForWedge\(/g) ?? [];
    expect(
      calls.length,
      "fixtures.ts must await checkForWedge in BOTH entry fixtures: appPage and " +
        "gridPersistent. They are independent by design — gridPersistent does " +
        "not depend on appPage, because its purpose is skipping appPage's " +
        "per-test reset — so one probe cannot cover the other, and a fixture " +
        "without one is a hole a wedged backend runs straight through.",
    ).toBe(2);
    // A probe whose verdict is dropped is the same as no probe. Both fixtures
    // must turn a non-null reason into a thrown failure.
    const throws = fixtures.match(/if \(wedged\) throw new Error\(wedged\)/g) ?? [];
    expect(
      throws.length,
      "a fixture computes the wedge verdict and never throws it, so its tests " +
        "would still run and still time out.",
    ).toBe(2);
  });

  it("covers gridPersistent, the fixture that bypasses appPage entirely", () => {
    // workflow-dashboard.spec.ts (7 tests) is the only caller, and it was the
    // one journey file a wedged backend could still burn in full.
    const fixtureIdx = fixtures.indexOf("gridPersistent: async (");
    expect(fixtureIdx).toBeGreaterThan(-1);
    expect(
      /gridPersistent: async \(\{ sharedPage \}, use, testInfo\)/.test(fixtures),
      "gridPersistent must take testInfo — checkForWedge names the test in its " +
        "verdict, and a fixture that does not take testInfo cannot pass it.",
    ).toBe(true);
    const probeAfter = fixtures.indexOf("await checkForWedge(", fixtureIdx);
    expect(
      probeAfter,
      "gridPersistent does not probe. It does not go through appPage, so " +
        "nothing else probes for it.",
    ).toBeGreaterThan(-1);
    // ...and before it hands the helper to the test.
    expect(probeAfter).toBeLessThan(fixtures.indexOf("await use(helper)", fixtureIdx));
  });

  it("probes BEFORE the page operations that would hang on a wedged backend", () => {
    const probeIdx = fixtures.indexOf("await checkForWedge(");
    const escapeIdx = fixtures.indexOf('sharedPage.keyboard.press("Escape")');
    expect(probeIdx).toBeGreaterThan(-1);
    expect(escapeIdx).toBeGreaterThan(-1);
    expect(
      probeIdx,
      "the wedge probe must come first in the appPage fixture. Moved after the " +
        "Escape/cleanup operations it stops being a fast fail: those are the " +
        "calls that hang when the backend stops answering, so the run pays " +
        "their timeouts on every test exactly as it did for 5.4 hours.",
    ).toBeLessThan(escapeIdx);
  });
});

describe("global-setup resets the guard so a verdict is about THIS run", () => {
  const setup = read("e2e/global-setup.ts");

  it("clears the latch counter", () => {
    expect(
      setup.includes("resetWedgeCounter()"),
      "global-setup.ts never resets the wedge counter. It is stored on disk (a " +
        "Playwright worker is rebuilt after every failed test and cannot hold " +
        "it in memory), so one wedged run would leave the count behind and the " +
        "next run could latch on its first probe.",
    ).toBe(true);
  });

  it("clears the marker file", () => {
    expect(
      setup.includes("APP_WEDGED_MARKER"),
      "global-setup.ts never unlinks APP_WEDGED_MARKER, so a stale marker from " +
        "a previous run would condemn this one.",
    ).toBe(true);
    expect(/unlinkSync\(APP_WEDGED_MARKER\)/.test(setup)).toBe(true);
  });
});
