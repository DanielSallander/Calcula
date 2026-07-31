//! FILENAME: app/src/api/scriptHost/__tests__/scheduler.test.ts
// PURPOSE: Tests for the renderer half of the persistent scheduler (the
//          `schedule` capability) plus the capability's plumbing through the
//          shared vocabulary.
// CONTEXT: The AUTHORITY lives in Rust (scripting/scheduler.rs), and so do the
//          tests for the guarantees it owns — persistence round-trip, grant
//          re-check on every fire, the 30s floor, no self-overlap, cancel, and
//          a revoked capability halting a job already saved in the workbook.
//          What is testable HERE is the half the renderer owns: that the tick
//          reports mounted scripts (the gate Rust cannot see), that it always
//          closes the loop with `complete` so a failure can never leave a job
//          wedged behind Rust's overlap guard, and that a connector job runs
//          the connector feed cycle rather than a bare exposed-method call.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invokeBackend = vi.fn();
const callExposedMethod = vi.fn();
const refreshScriptConnector = vi.fn();
const listMountedHandles = vi.fn();

vi.mock("../../backend", () => ({ invokeBackend: (...a: unknown[]) => invokeBackend(...a) }));
vi.mock("../../scriptableObjects", () => ({
  callExposedMethod: (...a: unknown[]) => callExposedMethod(...a),
}));
vi.mock("../../scriptConnectors", () => ({
  refreshScriptConnector: (...a: unknown[]) => refreshScriptConnector(...a),
}));
vi.mock("../broker", () => ({ listMountedHandles: () => listMountedHandles() }));

import { ALL_CAPABILITY_IDS, CAPABILITY_ID_SET, isCapabilityId } from "../capabilityIds";
import { ALLOWLIST } from "../allowlist";
import { describeCapability, RUST_MIRRORED_CAPABILITIES } from "../capabilities";
import { vScheduleEvery, vScheduleAt, vScheduleCancel } from "../validators";
import { SCRIPT_SURFACES } from "../../scriptSurfaces";

/** The op of the Nth script_scheduler call. */
function opsCalled(): string[] {
  return invokeBackend.mock.calls
    .filter((c) => c[0] === "script_scheduler")
    .map((c) => (c[1] as { request: { op: string } }).request.op);
}

/** The request payload of the first call with `op`. */
function requestFor(op: string): Record<string, unknown> | undefined {
  const call = invokeBackend.mock.calls.find(
    (c) => c[0] === "script_scheduler" && (c[1] as { request: { op: string } }).request.op === op,
  );
  return call ? (call[1] as { request: Record<string, unknown> }).request : undefined;
}

describe("the `schedule` capability is threaded through the shared vocabulary", () => {
  it("is a recognized capability id", () => {
    expect(ALL_CAPABILITY_IDS).toContain("schedule");
    expect(CAPABILITY_ID_SET.has("schedule")).toBe(true);
    expect(isCapabilityId("schedule")).toBe(true);
  });

  it("is Rust-mirrored, because the grant is re-checked at every firing", () => {
    // This is the load-bearing entry: a job persists in the workbook, so the
    // ONLY way a revoke can stop it is for the authoritative Rust store to know
    // about the grant. Dropping this line would leave revoked jobs firing.
    expect(RUST_MIRRORED_CAPABILITIES.has("schedule")).toBe(true);
  });

  it("has consent text that names both the authority and its honest limit", () => {
    const text = describeCapability("schedule");
    // The novel authority: it starts itself.
    expect(text).toMatch(/without you starting it/i);
    // The honest limit: no headless runtime. A user who reads this must not
    // come away believing their workbook runs while the app is closed.
    expect(text).toMatch(/while Calcula is open/i);
  });

  it("gates all four broker methods behind the capability", () => {
    for (const m of ["cap.scheduleEvery", "cap.scheduleAt", "cap.scheduleList", "cap.scheduleCancel"]) {
      expect(ALLOWLIST[m], `${m} must have an ALLOWLIST row`).toBeDefined();
      expect(ALLOWLIST[m].capability).toBe("schedule");
    }
    // Registration mutates persistent state; listing does not.
    expect(ALLOWLIST["cap.scheduleEvery"].class).toBe("mutate");
    expect(ALLOWLIST["cap.scheduleList"].class).toBe("read");
  });

  it("is reachable from every author-declared-ceiling surface", () => {
    const objectScript = SCRIPT_SURFACES.find((s) => s.id === "object-script");
    expect(objectScript?.capabilities).toContain("schedule");
    const ext = SCRIPT_SURFACES.find((s) => s.id === "extension-worker");
    expect(ext?.capabilities).toContain("schedule");
    // ...and NOT silently added to surfaces with a hard-coded empty ceiling.
    const mark = SCRIPT_SURFACES.find((s) => s.id === "chart-mark");
    expect(mark?.capabilities).not.toContain("schedule");
  });
});

describe("schedule validators (cheap pre-flight in front of the Rust gate)", () => {
  it("enforces the 30s floor", () => {
    expect(vScheduleEvery([29, "tick"])).toMatch(/at least 30/);
    expect(vScheduleEvery([30, "tick"])).toBe(true);
    expect(vScheduleEvery([900, "tick", { label: "Daily" }])).toBe(true);
  });

  it("rejects a cadence that is not a finite number", () => {
    expect(vScheduleEvery([Number.NaN, "tick"])).toMatch(/finite/);
    expect(vScheduleEvery([Number.POSITIVE_INFINITY, "tick"])).toMatch(/finite/);
    expect(vScheduleEvery(["900", "tick"])).toMatch(/finite/);
    expect(vScheduleEvery([400 * 24 * 3600, "tick"])).toMatch(/at most one year/);
  });

  it("requires a handler name — the whole invocation surface of a job", () => {
    expect(vScheduleEvery([60, ""])).toMatch(/handler/);
    expect(vScheduleEvery([60, 123])).toMatch(/handler/);
  });

  it("accepts only a 24-hour local HH:MM for the daily cadence", () => {
    expect(vScheduleAt(["06:30", "tick"])).toBe(true);
    expect(vScheduleAt(["00:00", "tick"])).toBe(true);
    expect(vScheduleAt(["23:59", "tick"])).toBe(true);
    expect(vScheduleAt(["24:00", "tick"])).toMatch(/HH:MM/);
    expect(vScheduleAt(["6:30", "tick"])).toMatch(/HH:MM/);
    expect(vScheduleAt(["06:60", "tick"])).toMatch(/HH:MM/);
    expect(vScheduleAt(["morning", "tick"])).toMatch(/HH:MM/);
  });

  it("requires a job id to cancel", () => {
    expect(vScheduleCancel(["sched-1"])).toBe(true);
    expect(vScheduleCancel([""])).toMatch(/jobId/);
  });
});

describe("the renderer tick", () => {
  let scheduler: typeof import("../scheduler");

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    invokeBackend.mockReset();
    callExposedMethod.mockReset().mockResolvedValue(undefined);
    refreshScriptConnector.mockReset().mockResolvedValue(undefined);
    listMountedHandles.mockReset().mockReturnValue([{ scriptId: "s1" }]);
    scheduler = await import("../scheduler");
  });

  afterEach(() => {
    scheduler.stopSchedulerPump();
    vi.useRealTimers();
  });

  /** Wire a backend that returns `due` once, then nothing. */
  function backendWithDue(due: unknown[], jobs: unknown[] = [{ id: "sched-1" }]): void {
    let handedOut = false;
    invokeBackend.mockImplementation((cmd: string, payload: { request: { op: string } }) => {
      if (cmd !== "script_scheduler") return Promise.resolve(undefined);
      const op = payload.request.op;
      if (op === "due") {
        if (handedOut) return Promise.resolve([]);
        handedOut = true;
        return Promise.resolve(due);
      }
      if (op === "list") return Promise.resolve(jobs);
      return Promise.resolve({ cancelled: true, nextRunMs: 0 });
    });
  }

  it("tells Rust which scripts are mounted — the gate Rust cannot see itself", async () => {
    // An unmounted script has no worker realm and no exposed method to call,
    // which is also what stops a workbook whose scripts were never consented
    // (and so never mounted) from starting jobs on open.
    listMountedHandles.mockReturnValue([{ scriptId: "a" }, { scriptId: "b" }]);
    backendWithDue([]);
    await scheduler.syncPump();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(requestFor("due")).toMatchObject({ mountedScriptIds: ["a", "b"] });
  });

  it("invokes the exposed method the job names, then reports completion", async () => {
    backendWithDue([
      { id: "sched-1", scriptId: "s1", surface: "object-script", objectType: "shape", instanceId: "i1", handler: "refresh" },
    ]);
    await scheduler.syncPump();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(callExposedMethod).toHaveBeenCalledWith("shape", "i1", "refresh");
    const complete = requestFor("complete");
    expect(complete).toMatchObject({ jobId: "sched-1", ok: true });
  });

  it("still reports completion when the handler THROWS", async () => {
    // The `complete` report is what releases Rust's self-overlap guard. If a
    // failing job skipped it, the job would stay flagged running and never fire
    // again until the 10-minute watchdog — i.e. one bad run would silently
    // retire the schedule.
    callExposedMethod.mockRejectedValue(new Error("boom"));
    backendWithDue([
      { id: "sched-1", scriptId: "s1", surface: "object-script", objectType: "shape", instanceId: null, handler: "refresh" },
    ]);
    await scheduler.syncPump();
    await vi.advanceTimersByTimeAsync(11_000);

    const complete = requestFor("complete");
    expect(complete).toMatchObject({ jobId: "sched-1", ok: false });
    expect(String(complete?.error)).toContain("boom");
  });

  it("runs a connector job through the connector FEED cycle, not a bare call", async () => {
    // A connector's refresh is fetch-every-table + hand rows to the Rust gate;
    // calling its exposed fetchTable alone would fetch data and drop it.
    backendWithDue([
      { id: "sched-2", scriptId: "s1", surface: "connector", objectType: "shape", instanceId: null, handler: "script:crm" },
    ]);
    await scheduler.syncPump();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(refreshScriptConnector).toHaveBeenCalledWith("script:crm");
    expect(callExposedMethod).not.toHaveBeenCalled();
    expect(requestFor("complete")).toMatchObject({ jobId: "sched-2", ok: true });
  });

  it("does not stack overlapping ticks when a run outlives the interval", async () => {
    let release: (() => void) | undefined;
    callExposedMethod.mockImplementation(
      () => new Promise<void>((r) => { release = r; }),
    );
    backendWithDue([
      { id: "sched-1", scriptId: "s1", surface: "object-script", objectType: "shape", instanceId: null, handler: "slow" },
    ]);
    await scheduler.syncPump();
    await vi.advanceTimersByTimeAsync(11_000);
    // The first run is in flight; several more intervals elapse.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(opsCalled().filter((o) => o === "due")).toHaveLength(1);

    release?.();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(opsCalled().filter((o) => o === "due").length).toBeGreaterThan(1);
  });

  it("does not run a timer for a workbook with no scheduled jobs", async () => {
    // A capability nobody used must cost nothing.
    backendWithDue([], []);
    await scheduler.syncPump();
    invokeBackend.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opsCalled()).toHaveLength(0);
  });
});

describe("the trusted-UI surface (transparency panel)", () => {
  let scheduler: typeof import("../scheduler");

  beforeEach(async () => {
    vi.resetModules();
    invokeBackend.mockReset().mockResolvedValue([]);
    scheduler = await import("../scheduler");
  });

  it("lists EVERY job in the workbook, not just one script's", async () => {
    // The user must be able to see everything that runs in their own file; a
    // per-script view would hide exactly the job they are looking for.
    await scheduler.listAllScheduledJobs();
    expect(requestFor("list")).toEqual({ op: "list" });
    expect(requestFor("list")).not.toHaveProperty("scriptId");
  });

  it("cancels without an owner check, so the user can always stop a job", async () => {
    invokeBackend.mockResolvedValue({ cancelled: true });
    await scheduler.cancelScheduledJob("sched-9");
    const req = requestFor("cancel");
    expect(req).toMatchObject({ jobId: "sched-9" });
    expect(req).not.toHaveProperty("scriptId");
  });

  it("can pause a job without forgetting it", async () => {
    invokeBackend.mockResolvedValue({ enabled: false });
    await scheduler.setScheduledJobEnabled("sched-9", false);
    expect(requestFor("setEnabled")).toMatchObject({ jobId: "sched-9", enabled: false });
  });

  it("scopes a SCRIPT's own cancel to that script", async () => {
    invokeBackend.mockResolvedValue({ cancelled: true });
    await scheduler.cancelScheduledJobForScript("s1", "sched-3");
    expect(requestFor("cancel")).toMatchObject({ scriptId: "s1", jobId: "sched-3" });
  });
});
