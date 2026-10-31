//! FILENAME: app/src/api/scriptHost/__tests__/extensionScheduledJobs.test.ts
// PURPOSE: A sandboxed extension's scheduled job can CALL something (BUG-0616 #3).
// CONTEXT: Excel's Application.OnTime calls a named procedure. A worker
//          extension could schedule (`capabilities.schedule.every/at`, which
//          store a method NAME) but had no door to publish a method under that
//          name -- its docs pointed at a `context.expose` that does not exist --
//          so every job it set up failed at every firing with "does not expose".
//          The door added is the narrowest one that makes the feature work:
//          `capabilities.schedule.expose(name, fn)` -> `ext.scheduleExpose`,
//          within the DECLARED `schedule` ceiling but asking no consent (the
//          job's creation asks; ext2, round 11), audited in the broker ring
//          like every broker call, and held on the extension's OWN mount -- never in
//          the cross-script exposed-method registry -- so only the scheduler's
//          firing of a job THIS extension owns can reach it.
// COVERS:  the REAL extension worker host and the REAL scheduler tick; the
//          worker is a fake that plays the add-in, and the Rust scheduler is a
//          double that hands a job back as `due` the way scripting/scheduler.rs
//          does (owner fields exactly as the host registered them).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WX2H } from "../extensionProtocol";

const backendCalls: Array<{ cmd: string; request: Record<string, unknown> | undefined }> = [];
/** The jobs Rust hands back as due on the next tick (then nothing). */
let dueOnce: unknown[] = [];

vi.mock("../../backend", () => ({
  invokeBackend: async (cmd: string, payload?: { request?: Record<string, unknown> }) => {
    backendCalls.push({ cmd, request: payload?.request });
    if (cmd !== "script_scheduler") return undefined;
    const op = payload?.request?.op;
    if (op === "due") {
      const due = dueOnce;
      dueOnce = [];
      return due;
    }
    if (op === "list") return [{ id: "job-1" }];
    if (op === "every") return { id: "job-1", handler: payload?.request?.handler };
    return { cancelled: true };
  },
}));
vi.mock("../../notifications", () => ({ showToast: vi.fn() }));

type HostMessage = { t: string; [k: string]: unknown };

class FakeWorker {
  static last: FakeWorker | null = null;
  listeners = new Map<string, Set<(e: unknown) => void>>();
  received: HostMessage[] = [];
  handlers = new Map<number, (...args: unknown[]) => unknown>();
  constructor() {
    FakeWorker.last = this;
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  postMessage(msg: HostMessage): void {
    this.received.push(msg);
    if (msg.t === "deactivate") queueMicrotask(() => this.emit({ t: "deactivated" }));
    if (msg.t === "invokeHandler") {
      const fn = this.handlers.get(msg.handlerId as number);
      const reqId = msg.reqId as number;
      void (async () => {
        if (!fn) {
          this.emit({ t: "handlerResult", reqId, ok: false, error: { code: "UnknownMethod", message: "handler not found" } });
          return;
        }
        try {
          const value = await fn(...(msg.args as unknown[]));
          this.emit({ t: "handlerResult", reqId, ok: true, value });
        } catch (e) {
          this.emit({ t: "handlerResult", reqId, ok: false, error: { code: "HostError", message: String(e) } });
        }
      })();
    }
  }
  terminate(): void {}
  emit(data: WX2H): void {
    for (const cb of this.listeners.get("message") ?? []) cb({ data } as unknown as MessageEvent<WX2H>);
  }
  call(callId: number, method: string, args: unknown[]): void {
    this.emit({ t: "call", callId, method, args });
  }
  result(callId: number): HostMessage | undefined {
    return this.received.find((m) => m.t === "callResult" && m.callId === callId);
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

const EXT_ID = "test.ticker";
const SCRIPT_ID = `extension:${EXT_ID}`;
const MANIFEST = { id: EXT_ID, name: "Ticker", version: "1.0.0", workerSupport: true, capabilities: ["schedule"] };

/** The job Rust hands back for this extension's schedule (owner as the host registered it). */
const JOB = { id: "job-1", scriptId: SCRIPT_ID, surface: "extension-worker", objectType: EXT_ID, instanceId: null, handler: "refresh" };

describe("a sandboxed extension's scheduled job calls the method it published (BUG-0616 #3)", () => {
  let host: typeof import("../extensionWorkerHost");
  let scheduler: typeof import("../scheduler");
  let caps: typeof import("../capabilities");
  let audit: typeof import("../auditRing");
  let broker: typeof import("../broker");

  beforeEach(async () => {
    vi.resetModules();
    backendCalls.length = 0;
    dueOnce = [];
    globalScope.Worker = FakeWorker;
    host = await import("../extensionWorkerHost");
    scheduler = await import("../scheduler");
    caps = await import("../capabilities");
    audit = await import("../auditRing");
    broker = await import("../broker");
    caps.resetAllGrants();
    audit.clearAudit();
  });

  afterEach(async () => {
    scheduler.stopSchedulerPump();
    vi.useRealTimers();
    await host.resetWorkerExtensions();
    globalScope.Worker = originalWorker;
  });

  async function mount(manifest: Record<string, unknown> = MANIFEST): Promise<FakeWorker> {
    const pending = host.mountWorkerExtension("/* bundle */", String(manifest.name), manifest as never);
    await Promise.resolve();
    const worker = FakeWorker.last as FakeWorker;
    worker.emit({ t: "manifest", manifest: manifest as never });
    await Promise.resolve();
    await Promise.resolve();
    worker.emit({ t: "activated", ok: true });
    await pending;
    return worker;
  }

  /** A broker call from the "add-in", settled. */
  async function call(worker: FakeWorker, callId: number, method: string, args: unknown[]): Promise<HostMessage> {
    worker.call(callId, method, args);
    await vi.waitFor(() => expect(worker.result(callId)).toBeDefined());
    return worker.result(callId) as HostMessage;
  }

  /** One scheduler tick that hands JOB out; answers the `complete` report. */
  async function fire(): Promise<Record<string, unknown> | undefined> {
    dueOnce = [JOB];
    vi.useFakeTimers();
    await scheduler.syncPump();
    await vi.advanceTimersByTimeAsync(11_000);
    vi.useRealTimers();
    // The tick's first firing imports the host (its debugger-pause check), which
    // takes a while cold.
    await vi.waitFor(
      () => expect(backendCalls.some((c) => c.request?.op === "complete")).toBe(true),
      { timeout: 20_000 },
    );
    return backendCalls.find((c) => c.request?.op === "complete")?.request;
  }

  it("REPRODUCTION: a job the extension scheduled, with nothing published, fails every firing", async () => {
    caps.recordCapabilityGrant(SCRIPT_ID, "schedule");
    const worker = await mount();
    const scheduled = await call(worker, 1, "cap.scheduleEvery", [60, "refresh"]);
    expect(scheduled.ok, JSON.stringify(scheduled)).toBe(true);
    // The owner the host registered the job under -- what Rust hands back.
    const every = backendCalls.find((c) => c.request?.op === "every")?.request;
    expect(every).toMatchObject({ scriptId: SCRIPT_ID, surface: "extension-worker", objectType: EXT_ID, handler: "refresh" });

    const complete = await fire();
    expect(complete).toMatchObject({ jobId: "job-1", ok: false });
    expect(String(complete?.error)).toMatch(/does not publish refresh\(\)/);
  });

  // SABOTAGE: drop the extension-worker branch from the scheduler's tick ->
  // the firing goes to hostCallOwnExposed, finds nothing, and the job FAILS.
  it("published with ext.scheduleExpose, the job RUNS the extension's function and reports success", async () => {
    caps.recordCapabilityGrant(SCRIPT_ID, "schedule");
    const worker = await mount();
    let ran = 0;
    worker.handlers.set(7, () => {
      ran += 1;
    });
    const exposed = await call(worker, 1, "ext.scheduleExpose", ["refresh", 7]);
    expect(exposed.ok, JSON.stringify(exposed)).toBe(true);

    const complete = await fire();
    expect(complete).toMatchObject({ jobId: "job-1", ok: true });
    expect(ran).toBe(1);
    // AUDITED like every broker call.
    expect(audit.getAuditTail().some((e) => e.method === "ext.scheduleExpose" && e.ok)).toBe(true);
  });

  it("a job whose function THROWS is a failed run, with the reason", async () => {
    caps.recordCapabilityGrant(SCRIPT_ID, "schedule");
    const worker = await mount();
    worker.handlers.set(7, () => {
      throw new Error("feed down");
    });
    await call(worker, 1, "ext.scheduleExpose", ["refresh", 7]);
    const complete = await fire();
    expect(complete).toMatchObject({ ok: false });
    expect(String(complete?.error)).toContain("feed down");
  });

  it("withdrawn (handlerId null + its slot), the name is gone and the job fails again", async () => {
    caps.recordCapabilityGrant(SCRIPT_ID, "schedule");
    const worker = await mount();
    worker.handlers.set(7, () => undefined);
    await call(worker, 1, "ext.scheduleExpose", ["refresh", 7]);
    const withdrawn = await call(worker, 2, "ext.scheduleExpose", ["refresh", null, 7]);
    expect(withdrawn.ok, JSON.stringify(withdrawn)).toBe(true);
    const complete = await fire();
    expect(complete).toMatchObject({ ok: false });
  });

  // ext2 (round 11): the withdraw closure used to send [name, null], and the
  // host deleted the name whoever owned it -- so withdrawing an OLDER expose
  // orphaned a NEWER one under the same name, and every later firing failed.
  // SABOTAGE: delete the name unconditionally on a withdrawal -> the newer
  // registration is gone and the call below rejects.
  it("withdrawing an OLDER registration leaves a NEWER one under the same name in place", async () => {
    caps.recordCapabilityGrant(SCRIPT_ID, "schedule");
    const worker = await mount();
    let ran = "";
    worker.handlers.set(7, () => {
      ran += "old";
    });
    worker.handlers.set(8, () => {
      ran += "new";
    });
    await call(worker, 1, "ext.scheduleExpose", ["refresh", 7]);
    await call(worker, 2, "ext.scheduleExpose", ["refresh", 8]);
    await call(worker, 3, "ext.scheduleExpose", ["refresh", null, 7]);
    await host.callExtensionJobHandler(SCRIPT_ID, EXT_ID, "refresh");
    expect(ran).toBe("new");
    // POSITIVE CONTROL: withdrawing the CURRENT one does remove it.
    await call(worker, 4, "ext.scheduleExpose", ["refresh", null, 8]);
    await expect(host.callExtensionJobHandler(SCRIPT_ID, EXT_ID, "refresh")).rejects.toThrow(/does not publish/);
  });

  // ext2 (round 11): exposing asked for the `schedule` consent, so an add-in
  // that publishes from `activate` raised a prompt at every launch even with
  // no job. Publishing grants nothing; creating the JOB is what asks.
  // SABOTAGE: put `capability: "schedule"` back on the ext.scheduleExpose row
  // -> the call below is refused (no grant) instead of succeeding.
  it("publishing asks for NO consent (the job does); an ungranted add-in can publish but not schedule", async () => {
    // Play the consent dialog: count every prompt and answer it "deny".
    const events = await import("../../events");
    const prompts: string[] = [];
    const stop = events.onAppEvent<{ requestId: string; capability: string }>(
      "scriptable-objects:capability-request",
      (p) => {
        prompts.push(p.capability);
        caps.resolveCapabilityRequest(p.requestId, "deny");
      },
    );
    try {
      const worker = await mount();
      worker.handlers.set(7, () => undefined);
      const exposed = await call(worker, 1, "ext.scheduleExpose", ["refresh", 7]);
      expect(prompts, "publishing a name must not raise a consent prompt").toEqual([]);
      expect(exposed.ok, JSON.stringify(exposed)).toBe(true);
      expect(caps.getGrantSet(SCRIPT_ID).has("schedule")).toBe(false);
      // POSITIVE CONTROL: creating the job still asks, and a decline refuses it.
      const scheduled = await call(worker, 2, "cap.scheduleEvery", [60, "refresh"]);
      expect(prompts).toEqual(["schedule"]);
      expect(scheduled.ok).toBe(false);
      expect(backendCalls.some((c) => c.request?.op === "every")).toBe(false);
    } finally {
      stop();
    }
  });

  // SABOTAGE: drop the `mw.handle.scriptId === scriptId` check in
  // callExtensionJobHandler -> another owner's job reaches the function.
  it("ONLY its own jobs reach it: not another owner's job, not the cross-script registry", async () => {
    caps.recordCapabilityGrant(SCRIPT_ID, "schedule");
    const worker = await mount();
    let ran = 0;
    worker.handlers.set(7, () => {
      ran += 1;
    });
    await call(worker, 1, "ext.scheduleExpose", ["refresh", 7]);
    // POSITIVE CONTROL: the owner's own job reaches it.
    await host.callExtensionJobHandler(SCRIPT_ID, EXT_ID, "refresh");
    expect(ran).toBe(1);
    // A job owned by anything else -- the same address, another script id.
    await expect(host.callExtensionJobHandler("extension:other", EXT_ID, "refresh")).rejects.toThrow(/does not publish/);
    await expect(host.callExtensionJobHandler("script-abc", EXT_ID, "refresh")).rejects.toThrow(/does not publish/);
    // The cross-script registry never saw it: no script can call it, and the
    // transparency list of exposed methods does not claim it.
    expect(broker.hostCallExposed(EXT_ID, null, "refresh", [])).toBeUndefined();
    expect(broker.listExposed().some((e) => e.methodName === "refresh")).toBe(false);
    expect(ran).toBe(1);
  });

  // SABOTAGE: drop the declared-ceiling check in the ext.scheduleExpose arm ->
  // an undeclared add-in publishes.
  it("needs the `schedule` capability DECLARED: an extension that did not declare it is refused", async () => {
    const worker = await mount({ ...MANIFEST, capabilities: [] });
    worker.handlers.set(7, () => undefined);
    const refused = await call(worker, 1, "ext.scheduleExpose", ["refresh", 7]);
    expect(refused.ok).toBe(false);
    expect((refused.error as { code: string }).code).toBe("PermissionDenied");
    await expect(host.callExtensionJobHandler(SCRIPT_ID, EXT_ID, "refresh")).rejects.toThrow(/does not publish/);
  });

  it("rejects a malformed registration (a name is required, a slot is a positive integer)", async () => {
    caps.recordCapabilityGrant(SCRIPT_ID, "schedule");
    const worker = await mount();
    for (const [i, args] of [
      ["", 7],
      ["refresh", 0],
      ["refresh", 1.5],
      ["refresh", "7"],
      // A withdrawal must name the slot it registered.
      ["refresh", null],
      ["refresh", null, 0],
      ["refresh", 7, 8],
    ].entries()) {
      const r = await call(worker, 10 + i, "ext.scheduleExpose", args);
      expect(r.ok, JSON.stringify(args)).toBe(false);
      expect((r.error as { code: string }).code).toBe("ValidationError");
    }
  });
});
