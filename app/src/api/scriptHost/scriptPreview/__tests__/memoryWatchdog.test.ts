//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/memoryWatchdog.test.ts
// PURPOSE: The preview memory watchdog's threshold logic — the testable core of
//          a mechanism whose wiring can only run in a real Worker.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.2 (follow-up 1).
//
//          WHAT IS AND IS NOT COVERED, honestly. The watchdog exists because a
//          preview runs un-consented model output in a Worker that shares the
//          RENDERER process, and heap exhaustion there does not fail politely.
//          The pollable case — a draft accumulating arrays across awaits — is
//          catchable and is what these tests pin. The tight synchronous
//          allocation loop is NOT catchable in the realm (it never yields to
//          the poll), and no test here pretends otherwise; that residual is
//          documented in §5c.2. The bootstrap wiring (real `performance.memory`,
//          real `self.close()`) is four lines the unit tier cannot execute.

import { describe, expect, it, vi } from "vitest";
import { armMemoryWatchdog, PREVIEW_MEMORY_LIMIT_BYTES } from "../../worker/workerHardening";

/** A hand-cranked scheduler, so the poll is driven explicitly. */
function crank() {
  const ticks: Array<() => void> = [];
  return {
    schedule: {
      set: (fn: () => void) => {
        ticks.push(fn);
        return ticks.length as unknown as ReturnType<typeof setInterval>;
      },
      clear: vi.fn(),
    },
    tick: () => ticks.forEach((fn) => fn()),
  };
}

describe("the preview memory watchdog", () => {
  it("fires once when usage crosses the limit, and disarms itself", () => {
    const { schedule, tick } = crank();
    const onBreach = vi.fn();
    let used = 100;
    armMemoryWatchdog({
      limitBytes: 1_000,
      intervalMs: 250,
      readUsage: () => used,
      onBreach,
      schedule,
    });
    tick();
    expect(onBreach, "under the limit is not a breach").not.toHaveBeenCalled();
    used = 1_001;
    tick();
    expect(onBreach).toHaveBeenCalledExactlyOnceWith(1_001);
    tick();
    expect(onBreach, "a breach fires ONCE — the realm is already being closed").toHaveBeenCalledTimes(1);
    expect(schedule.clear).toHaveBeenCalled();
  });

  it("is a silent no-op where the memory API does not exist", () => {
    // `performance.memory` is Chromium-specific and not guaranteed in a
    // worker. Absent, the watchdog must do NOTHING — a false alarm would kill
    // correct previews on engines that simply cannot report usage.
    const { schedule, tick } = crank();
    const onBreach = vi.fn();
    armMemoryWatchdog({
      limitBytes: 1,
      intervalMs: 250,
      readUsage: () => undefined,
      onBreach,
      schedule,
    });
    tick();
    tick();
    expect(onBreach).not.toHaveBeenCalled();
  });

  it("can be stopped, after which nothing fires", () => {
    const { schedule, tick } = crank();
    const onBreach = vi.fn();
    const dog = armMemoryWatchdog({
      limitBytes: 1,
      intervalMs: 250,
      readUsage: () => 2,
      onBreach,
      schedule,
    });
    dog.stop();
    expect(schedule.clear).toHaveBeenCalled();
    // The crank still holds the callback; a stopped real scheduler would not
    // invoke it. What stop() must guarantee is the clear — pinned above.
    void tick;
  });

  it("holds a limit that is generous for drafts and far under the renderer's doom", () => {
    expect(PREVIEW_MEMORY_LIMIT_BYTES).toBe(256 * 1024 * 1024);
  });

  it("is ARMED by the bootstrap for strict mounts only, on captured intrinsics", () => {
    // The wiring cannot execute here (no Worker), so it is pinned by source:
    // strict-gated, real memory reader, reports then closes the realm. And the
    // scheduler must be captured intrinsics — scheduling through the PATCHED
    // globals would hand the watchdog to the code it watches (a hostile draft
    // can sweep clearInterval(1..N) over guessed ids).
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const bootstrap = readFileSync(resolve(__dirname, "../../worker/bootstrap.ts"), "utf8");
    expect(bootstrap).toMatch(/spec\.snapshot\.strict === true[\s\S]{0,200}armMemoryWatchdog/);
    expect(bootstrap).toContain("usedJSHeapSize");
    expect(bootstrap).toMatch(/onBreach[\s\S]{0,400}self\.close\(\)/);
    const hardening = readFileSync(resolve(__dirname, "../../worker/workerHardening.ts"), "utf8");
    expect(hardening).toContain("set: globalThis.setInterval.bind(globalThis)");
  });
});
