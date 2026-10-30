//! FILENAME: app/src/api/scriptHost/__tests__/schedulerStaleAddress.test.ts
// PURPOSE: A scheduled job whose exposed method is NOT there is a FAILED run,
//          never a silent success (rev4B#1), through the REAL broker registry.
// CONTEXT: A job addresses its method by (objectType, instanceId, handler). A
//          named-range script is bound by the name's TEXT, so a job saved with
//          the old name of a renamed name called nothing: the lenient door
//          (`hostCallExposed`) answered `undefined`, the tick reported ok:true,
//          and the transparency panel showed a healthy job that never ran.
//          scheduler.test.ts covers the tick's bookkeeping with the broker
//          mocked; this file keeps the broker real, so it is the broker's own
//          answer to a stale address that is under test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invokeBackend = vi.fn();
vi.mock("../../backend", () => ({ invokeBackend: (...a: unknown[]) => invokeBackend(...a) }));
vi.mock("../host", () => ({ isScriptDebugPaused: () => false }));

import {
  clearExposed,
  registerExposed,
  registerMountedHandle,
  rekeyExposed,
  hostCallExposed,
  hostCallOwnExposed,
  listExposed,
  type ScriptHandle,
} from "../broker";
import * as scheduler from "../scheduler";

function handle(scriptId: string, instanceId: string): ScriptHandle {
  return {
    scriptId,
    scriptName: scriptId,
    objectType: "namedRange",
    instanceId,
    tier: "restricted",
    origin: { kind: "local" },
    grants: new Set(),
    declared: new Set(),
  } as unknown as ScriptHandle;
}

/** The `complete` report of `jobId`. */
function completeFor(jobId: string): Record<string, unknown> | undefined {
  const call = invokeBackend.mock.calls.find(
    (c) =>
      c[0] === "script_scheduler" &&
      (c[1] as { request: { op: string; jobId?: string } }).request.op === "complete" &&
      (c[1] as { request: { jobId?: string } }).request.jobId === jobId,
  );
  return call ? (call[1] as { request: Record<string, unknown> }).request : undefined;
}

describe("a scheduled job through the real exposed-method registry", () => {
  // ONE module graph: the scheduler must call into the SAME broker registry
  // this file registers into, so the modules are not reset between tests
  // (the pump is stopped in afterEach, which is all the state it keeps).
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    invokeBackend.mockReset();
    clearExposed();
  });

  afterEach(() => {
    scheduler.stopSchedulerPump();
    for (const off of cleanups.splice(0)) off();
    clearExposed();
    vi.useRealTimers();
  });

  /** A backend that hands out `due` once, then nothing. */
  function backendWithDue(due: unknown[]): void {
    let handedOut = false;
    invokeBackend.mockImplementation((cmd: string, payload: { request: { op: string } }) => {
      if (cmd !== "script_scheduler") return Promise.resolve(undefined);
      const op = payload.request.op;
      if (op === "due") {
        if (handedOut) return Promise.resolve([]);
        handedOut = true;
        return Promise.resolve(due);
      }
      if (op === "list") return Promise.resolve([{ id: "sched-1" }]);
      return Promise.resolve({ nextRunMs: 0 });
    });
  }

  it("a job that names a method its script does not expose there is a FAILED run, with the address", async () => {
    // The script mounted under the RENAMED name and exposes refresh() there.
    const tax = handle("s1", "Tax");
    const refresh = vi.fn();
    cleanups.push(registerMountedHandle(tax));
    cleanups.push(registerExposed(tax, "refresh", refresh, false));
    backendWithDue([
      // Saved before the rename: still the old name.
      { id: "sched-1", scriptId: "s1", surface: "object-script", objectType: "namedRange", instanceId: "Rate", handler: "refresh" },
    ]);
    await scheduler.syncPump();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(refresh).not.toHaveBeenCalled();
    const complete = completeFor("sched-1");
    expect(complete, "a run that called nothing reported a healthy run").toMatchObject({ ok: false });
    expect(String(complete?.error)).toContain("refresh()");
    expect(String(complete?.error)).toContain('"Rate"');
  });

  it("a job runs the method its OWN script exposes under its address, and reports success", async () => {
    const tax = handle("s1", "Tax");
    const refresh = vi.fn();
    cleanups.push(registerMountedHandle(tax));
    cleanups.push(registerExposed(tax, "refresh", refresh, false));
    backendWithDue([
      { id: "sched-1", scriptId: "s1", surface: "object-script", objectType: "namedRange", instanceId: "Tax", handler: "refresh" },
    ]);
    await scheduler.syncPump();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(completeFor("sched-1")).toMatchObject({ ok: true });
  });

  it("a job never runs ANOTHER script's method that happens to sit at its address", async () => {
    const other = handle("s-other", "Tax");
    const refresh = vi.fn();
    cleanups.push(registerMountedHandle(other));
    cleanups.push(registerExposed(other, "refresh", refresh, false));
    backendWithDue([
      { id: "sched-1", scriptId: "s1", surface: "object-script", objectType: "namedRange", instanceId: "Tax", handler: "refresh" },
    ]);
    await scheduler.syncPump();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(refresh).not.toHaveBeenCalled();
    expect(completeFor("sched-1")).toMatchObject({ ok: false });
  });
});

describe("rekeyExposed: a live mount's methods follow its re-bound instance", () => {
  beforeEach(() => clearExposed());
  afterEach(() => clearExposed());

  it("moves the owner's methods to the new address and leaves another owner's alone", () => {
    const mine = handle("s1", "Rate");
    const theirs = handle("s2", "Rate");
    const refresh = vi.fn(() => "mine");
    const other = vi.fn(() => "theirs");
    registerExposed(mine, "refresh", refresh, false);
    registerExposed(theirs, "other", other, false);

    // The host re-binds the mount (the rename), then re-keys its exposures.
    mine.instanceId = "Tax";
    expect(rekeyExposed(mine, "Rate")).toBe(1);

    expect(hostCallExposed("namedRange", "Tax", "refresh", []), "reachable under the new name").toBe("mine");
    expect(hostCallExposed("namedRange", "Rate", "refresh", []), "gone from the old name").toBeUndefined();
    expect(hostCallExposed("namedRange", "Rate", "other", []), "another script's method stays").toBe("theirs");
  });

  // rev6B#1. The cleanup `registerExposed` returns (run by the unmount: Save &
  // Apply's remount, a disable, a delete) deleted the key it was REGISTERED
  // under. After a rename re-keyed the entry it deleted nothing, so the entry
  // outlived its script: a scheduled job passed the strict door's owner check
  // and relayed into a terminated worker (a 30 s timeout instead of "does not
  // expose"), and listExposed() kept showing it.
  // SABOTAGE: make the cleanup delete only the key it was registered under
  // (the pre-round-8 body) -- `left` still lists Tax:refresh, and the strict
  // door runs it.
  it("the mount's cleanup withdraws an exposure a rename re-keyed", () => {
    const rate = handle("s-rate", "Rate");
    const cleanup = registerExposed(rate, "refresh", () => "ran", false);
    rate.instanceId = "Tax";
    expect(rekeyExposed(rate, "Rate")).toBe(1);

    cleanup();

    const left = listExposed().filter((e) => e.ownerScriptId === "s-rate");
    expect(left, "nothing of the unmounted script stays listed").toEqual([]);
    expect(
      () => hostCallOwnExposed("s-rate", "namedRange", "Tax", "refresh", []),
      "a job of the unmounted script is a failed run, not a relay into a dead worker",
    ).toThrow(/does not expose refresh\(\)/);
  });

  it("the cleanup still never deletes a SUCCESSOR's entry (a remount under the same address)", () => {
    const first = handle("s-rate", "Tax");
    const cleanupFirst = registerExposed(first, "refresh", () => "first", false);
    const second = handle("s-rate", "Tax");
    registerExposed(second, "refresh", () => "second", false);
    cleanupFirst();
    expect(hostCallExposed("namedRange", "Tax", "refresh", [])).toBe("second");
  });

  // ONE backend step can move several scripts onto each other's addresses --
  // Insert Rows above two stacked scripted controls moves control-0-5-2 to
  // control-0-6-2 AND control-0-6-2 to control-0-7-2 -- and each is re-keyed
  // on its own announcement. Re-keying the first overwrote the second's entry
  // at control-0-6-2, so the second's own re-key found nothing: its methods
  // were gone and its scheduled jobs failed every tick.
  // SABOTAGE: drop the parking in `rekeyExposed` (overwrite the occupant) --
  // the lower control's method is not found at control-0-7-2.
  it("re-keys that land on each other's addresses lose nothing, whatever the order, swaps included", () => {
    const upper = { ...handle("s-upper", "control-0-5-2"), objectType: "shape" } as ScriptHandle;
    const lower = { ...handle("s-lower", "control-0-6-2"), objectType: "shape" } as ScriptHandle;
    const cleanupUpper = registerExposed(upper, "refresh", () => "upper", false);
    registerExposed(lower, "refresh", () => "lower", false);

    // The backend's order: the upper control first, onto the lower one's cell.
    upper.instanceId = "control-0-6-2";
    rekeyExposed(upper, "control-0-5-2");
    lower.instanceId = "control-0-7-2";
    rekeyExposed(lower, "control-0-6-2");

    expect(hostCallOwnExposed("s-upper", "shape", "control-0-6-2", "refresh", [])).toBe("upper");
    expect(hostCallOwnExposed("s-lower", "shape", "control-0-7-2", "refresh", [])).toBe("lower");
    expect(hostCallExposed("shape", "control-0-5-2", "refresh", []), "the vacated cell answers nothing").toBeUndefined();

    // A swap (a sheet move rotates whole sheets): each lands on the other's.
    upper.instanceId = "control-0-7-2";
    rekeyExposed(upper, "control-0-6-2");
    lower.instanceId = "control-0-6-2";
    rekeyExposed(lower, "control-0-7-2");
    expect(hostCallOwnExposed("s-upper", "shape", "control-0-7-2", "refresh", [])).toBe("upper");
    expect(hostCallOwnExposed("s-lower", "shape", "control-0-6-2", "refresh", [])).toBe("lower");

    // A displaced entry is withdrawn by its own cleanup while it waits.
    lower.instanceId = "control-0-7-2";
    rekeyExposed(lower, "control-0-6-2"); // lands on upper: upper is parked
    cleanupUpper();
    upper.instanceId = "control-0-8-2";
    expect(rekeyExposed(upper, "control-0-7-2"), "nothing of the unmounted upper script is left to move").toBe(0);
    expect(listExposed().map((e) => `${e.ownerScriptId}@${e.instanceId}`)).toEqual(["s-lower@control-0-7-2"]);
  });
});
