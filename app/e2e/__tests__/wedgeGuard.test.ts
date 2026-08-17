//! FILENAME: app/e2e/__tests__/wedgeGuard.test.ts
// PURPOSE: Pin the wedge guard's decision logic without needing a wedged app.
//
// WHY THIS EXISTS AT ALL. The guard's whole value is what it does in a state
// that is, by construction, rare and hard to reproduce — on 2026-08-16 it took
// 5.4 hours to occur once and has not recurred since across a full 156-test
// journey run. A guard that has never been made to fire is a guard nobody knows
// the state of, and this one cannot be exercised by running the suite: a healthy
// app never triggers it. So the decision logic is tested here, deterministically,
// against a fake page.
//
// THE THREE PROPERTIES THAT MATTER, and why each is a real risk:
//   1. A healthy backend is never latched. If it were, the guard would fail
//      every test in the suite — infinitely worse than the disease it treats.
//   2. ONE slow answer does not latch. A guard that trips on a single slow
//      command would red an entire run over ordinary machine noise; the
//      two-consecutive rule is what makes it safe to run before every test.
//   3. Once latched, later tests fail IMMEDIATELY rather than probing again.
//      That is the whole economic point: 5.4 hours becomes minutes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// POINT THE GUARD'S STATE AT A TEMP DIRECTORY BEFORE ANYTHING IMPORTS IT.
//
// This test writes and deletes the guard's marker. Against the REAL path that
// makes it a unit test capable of redding a live E2E run: a run in progress
// would see the marker, consider itself latched, and fail every remaining test.
// `E2E_WEDGE_STATE_DIR` is read at module load, so it must be set before the
// dynamic `import()` in `freshGuard()` first resolves `wedgeMarker.ts`.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-guard-test-"));
process.env.E2E_WEDGE_STATE_DIR = STATE_DIR;

const APP_WEDGED_MARKER = path.join(STATE_DIR, "APP-WEDGED.txt");

/** A stand-in for Playwright's `Page`, with only what the guard touches. */
function fakePage(verdicts: Array<"ok" | "hang">): { evaluate: (fn: unknown, arg: unknown) => Promise<unknown> } {
  let call = 0;
  return {
    evaluate: async () => {
      const v = verdicts[Math.min(call, verdicts.length - 1)];
      call += 1;
      // The real page-side race resolves to one of these two strings; a hang
      // resolves to "backend-wedged" via the in-page timer rather than pending
      // forever, which is exactly what the guard relies on.
      return v === "ok" ? "ok" : "backend-wedged";
    },
  };
}

async function freshGuard() {
  vi.resetModules();
  return await import("../wedgeGuard");
}

const PROBE_COUNT_FILE = path.join(STATE_DIR, ".wedge-probe-count");

function clearMarker(): void {
  for (const f of [APP_WEDGED_MARKER, PROBE_COUNT_FILE]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* nothing to clear */ }
  }
}

describe("wedge guard", () => {
  beforeEach(clearMarker);
  afterEach(clearMarker);

  it("never latches on a backend that answers", async () => {
    const guard = await freshGuard();
    const page = fakePage(["ok"]);
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await guard.checkForWedge(page as any, `test ${i}`)).toBeNull();
    }
    expect(fs.existsSync(APP_WEDGED_MARKER)).toBe(false);
  });

  it("does NOT latch on a single unanswered probe", async () => {
    const guard = await freshGuard();
    // One hang, then healthy again — ordinary machine noise, not a wedge.
    const page = fakePage(["hang", "ok", "ok"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await guard.checkForWedge(page as any, "first")).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await guard.checkForWedge(page as any, "second")).toBeNull();
    expect(
      fs.existsSync(APP_WEDGED_MARKER),
      "one slow answer must not red the rest of the run",
    ).toBe(false);
  });

  it("latches on two consecutive unanswered probes, and names the condition", async () => {
    const guard = await freshGuard();
    const page = fakePage(["hang"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await guard.checkForWedge(page as any, "first")).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reason = await guard.checkForWedge(page as any, "the one that latched");
    expect(reason).toBeTruthy();
    expect(reason).toContain("backend-wedged");
    expect(fs.existsSync(APP_WEDGED_MARKER)).toBe(true);

    const marker = fs.readFileSync(APP_WEDGED_MARKER, "utf-8");
    expect(marker).toContain("THE BACKEND STOPPED ANSWERING");
    expect(
      marker,
      "the marker must say the later failures are one fact, or the reader counts " +
        "them as independent defects — which is exactly what happened on 2026-08-16",
    ).toContain("SAME FACT");
    expect(marker).toContain("the one that latched");
  });

  it("fails later tests IMMEDIATELY once latched, without probing again", async () => {
    const guard = await freshGuard();
    const page = fakePage(["hang"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await guard.checkForWedge(page as any, "first");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await guard.checkForWedge(page as any, "second");

    // A page that would HANG if probed: proving the guard short-circuits.
    const wouldHang = {
      evaluate: async () => {
        throw new Error("the guard probed again after latching");
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reason = await guard.checkForWedge(wouldHang as any, "third");
    expect(reason).toBeTruthy();
    expect(reason).toContain("already proved unresponsive");
  });

  // THE ONE THAT MATTERS MOST, and the one an in-process test would miss.
  //
  // Playwright destroys and rebuilds the worker after every FAILED test, and a
  // rebuilt worker re-imports the module with fresh state. On a wedged app EVERY
  // test fails, so the module is re-imported between every pair of probes. A
  // module-level `let consecutiveBad` therefore resets to 0 each time and can
  // never reach 2 — the guard would never latch, and the run would still cost
  // its full 5.4 hours while printing "not latching yet" forever.
  //
  // `freshGuard()` calls `vi.resetModules()`, so re-importing between the two
  // probes reproduces the restart exactly. This test failed before the counter
  // was moved to disk.
  it("latches ACROSS a worker restart (the counter must outlive the module)", async () => {
    const page = fakePage(["hang"]);

    const first = await freshGuard(); // worker A
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await first.checkForWedge(page as any, "before restart")).toBeNull();

    const second = await freshGuard(); // worker B — fresh module, as Playwright rebuilds it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reason = await second.checkForWedge(page as any, "after restart");

    expect(
      reason,
      "the second consecutive bad probe must latch even though the module was " +
        "re-imported in between — otherwise the guard is a log line, not a guard",
    ).toBeTruthy();
    expect(fs.existsSync(APP_WEDGED_MARKER)).toBe(true);
  });

  it("a good probe clears the on-disk count, so restarts cannot accumulate", async () => {
    // Bad, then good, then bad across three "workers": the two bad probes are
    // not CONSECUTIVE and must not latch.
    const bad = fakePage(["hang"]);
    const good = fakePage(["ok"]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (await freshGuard()).checkForWedge(bad as any, "a")).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (await freshGuard()).checkForWedge(good as any, "b")).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (await freshGuard()).checkForWedge(bad as any, "c")).toBeNull();

    expect(
      fs.existsSync(APP_WEDGED_MARKER),
      "two NON-consecutive bad probes must not latch, or a long run accumulates " +
        "unrelated blips into a false wedge",
    ).toBe(false);
  });

  it("resetWedgeCounter clears a half-count so a run cannot inherit one", async () => {
    const bad = fakePage(["hang"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (await freshGuard()).checkForWedge(bad as any, "left over")).toBeNull();

    const guard = await freshGuard();
    guard.resetWedgeCounter(); // what global-setup does at the start of every run

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await guard.checkForWedge(bad as any, "first of the new run")).toBeNull();
    expect(fs.existsSync(APP_WEDGED_MARKER)).toBe(false);
  });

  it("can be switched off, and says so rather than going quiet", async () => {
    const prev = process.env.E2E_WEDGE_GUARD;
    process.env.E2E_WEDGE_GUARD = "off";
    try {
      const guard = await freshGuard();
      const page = fakePage(["hang"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await guard.checkForWedge(page as any, "a")).toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await guard.checkForWedge(page as any, "b")).toBeNull();
      expect(fs.existsSync(APP_WEDGED_MARKER)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.E2E_WEDGE_GUARD;
      else process.env.E2E_WEDGE_GUARD = prev;
    }
  });
});
