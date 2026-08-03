//! FILENAME: app/src/api/scriptHost/__tests__/debugSession.test.ts
// PURPOSE: The host half of step-through debugging (task H1). The properties
//          under test are the ones a debugger must never get wrong:
//            - a session is entered explicitly, on a mounted script, and carries
//              the instrumentation flag ONLY for that mount;
//            - pause / resume / step state is what the editor renders;
//            - THE STATUS NEVER LIES: an event-driven script says it is waiting
//              for a named trigger, a completed one says it finished, a `setup`
//              that threw says so — none of them claim to be "running";
//            - a waiting script can be TRIGGERED from the session, or it would
//              be undebuggable (a recorded macro on a button is exactly this);
//            - A PAUSED SCRIPT NEVER BLOCKS SAVE OR CLOSE, and is never killed
//              by a deadline it is standing still in front of;
//            - stopping a session always resumes the script and drops the
//              instrumentation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";

// The mount path touches the backend for grants and snapshot seeds; none of
// that is under test here, and all of it is defensive against failure.
vi.mock("../../backend", () => ({
  invokeBackend: vi.fn().mockResolvedValue(null),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// A fake worker realm that answers the debug protocol.
// ============================================================================

class FakeWorker {
  static instances: FakeWorker[] = [];
  static last: FakeWorker | null = null;
  /**
   * Hooks the next mounted realm claims to register inside `setup`. The realm is
   * the only thing that knows this, so a test that wants an EVENT-DRIVEN script
   * (the recorded-macro shape) declares it here.
   */
  static hooksOnMount: string[] = [];
  /** Whether the mounted realm reports its own start/end of `setup`. */
  static reportActivity = true;
  /** When set, the realm reports `setup` throwing with this message. */
  static setupError: string | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];
  terminated = false;
  /** Set from the mount spec so tests can assert instrumentation was asked for. */
  debugSpec: { breakpoints: number[]; pauseOnEntry: boolean } | null = null;

  constructor() {
    FakeWorker.instances.push(this);
    FakeWorker.last = this;
  }

  postMessage(msg: H2W): void {
    this.received.push(msg);
    if (msg.t === "mount") {
      this.debugSpec = msg.spec.debug ?? null;
      if (msg.spec.debug) {
        this.emit({
          t: "debugReady",
          state: {
            instrumented: true,
            pausableLines: [2, 3, 4],
            snapshotLines: [9],
            promotedFunctions: ["setup"],
          },
        });
      }
      const debugging = !!msg.spec.debug && FakeWorker.reportActivity;
      if (debugging) this.activity(true, "setup");
      for (const hook of FakeWorker.hooksOnMount) {
        this.emit({ t: "hookRegistered", hook });
      }
      if (FakeWorker.setupError) {
        if (debugging) this.activity(false, "setup", FakeWorker.setupError);
        this.emit({ t: "mounted", ok: false, error: FakeWorker.setupError });
        return;
      }
      if (debugging) this.activity(false, "setup");
      this.emit({ t: "mounted", ok: true });
    }
    if (msg.t === "debugControl") {
      // A real realm resumes on any control that leaves the pause.
      this.emit({ t: "debugResumed" });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: W2H): void {
    this.onmessage?.({ data } as MessageEvent<W2H>);
  }

  /** Report the start/end of one execution, exactly as the realm does. */
  activity(running: boolean, label: string, error?: string): void {
    this.emit({
      t: "debugActivity",
      state: { running, label, ...(error ? { error } : {}) },
    });
  }

  /** Simulate the realm reaching a breakpoint. */
  pauseAt(line: number, reason: "breakpoint" | "step" | "pause" | "entry" = "breakpoint"): void {
    this.emit({
      t: "debugPaused",
      state: {
        line,
        reason,
        variables: [{ name: "total", type: "number", value: "7" }],
        callStack: [{ functionName: "setup", line }],
        waiting: 0,
      },
    });
  }

  controls(): string[] {
    return this.received.filter((m) => m.t === "debugControl").map((m) => (m as { action: string }).action);
  }

  /** Publish an exposed method, exactly as `context.expose(...)` does. */
  expose(name: string): void {
    this.emit({ t: "call", callId: 9001, method: "base.expose", args: [name, false] });
  }

  /** Relayed method calls the host pushed INTO the realm. */
  methodCalls(): Array<{ callId: number; methodName: string }> {
    return this.received
      .filter((m) => m.t === "methodCall")
      .map((m) => ({
        callId: (m as { callId: number }).callId,
        methodName: (m as { methodName: string }).methodName,
      }));
  }

  /** Events the host pushed INTO the realm (a fired trigger lands here). */
  events(): Array<{ hook: string; payload: unknown }> {
    return this.received
      .filter((m) => m.t === "event")
      .map((m) => ({ hook: (m as { hook: string }).hook, payload: (m as { payload: unknown }).payload }));
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");

let host: HostModule;

const DEFINITION = {
  id: "script-under-test",
  name: "Order validator",
  objectType: "workbook",
  instanceId: null,
  source: [
    "function setup(context) {",
    "  const total = 1;",
    "  const doubled = total * 2;",
    "  return doubled;",
    "}",
  ].join("\n"),
  accessLevel: "restricted",
  apiVersion: "1.0.0",
};

/**
 * The shape the macro recorder produces, and the shape the user hit the bug
 * with: `setup` registers a click handler and returns. There is NOTHING to run
 * until the button is clicked.
 */
const BUTTON_DEFINITION = {
  id: "recorded-macro",
  name: "Macro1",
  objectType: "button",
  instanceId: "btn-1",
  source: [
    "function setup(button) {",
    "  button.onClick(async () => {",
    "    await button.sheet.setCellValue(0, 0, 1);",
    "  });",
    "}",
  ].join("\n"),
  accessLevel: "restricted",
  apiVersion: "1.0.0",
};

async function mount(): Promise<void> {
  await host.hostMountScript({ ...DEFINITION });
}

/** Mount the event-driven (button + onClick) script and open a session on it. */
async function mountButtonAndDebug(): Promise<void> {
  FakeWorker.hooksOnMount = ["onClick"];
  await host.hostMountScript({ ...BUTTON_DEFINITION });
  await host.hostStartDebugSession(BUTTON_DEFINITION.id, [3]);
}

function resetFakeWorker(): void {
  FakeWorker.instances = [];
  FakeWorker.last = null;
  FakeWorker.hooksOnMount = [];
  FakeWorker.reportActivity = true;
  FakeWorker.setupError = null;
}

describe("debug sessions (host)", () => {
  beforeEach(async () => {
    resetFakeWorker();
    globalScope.Worker = FakeWorker as unknown as typeof Worker;
    vi.resetModules();
    host = await import("../host");
  });

  afterEach(() => {
    host.hostResetAll();
    globalScope.Worker = originalWorker;
  });

  it("refuses to open a session on a script that is not mounted", async () => {
    await expect(host.hostStartDebugSession("nobody")).rejects.toThrow(/not mounted/i);
    expect(host.getDebugSession("nobody")).toBeNull();
  });

  it("a normal mount carries NO debug spec — instrumentation is opt-in", async () => {
    await mount();
    expect(FakeWorker.last?.debugSpec).toBeNull();
    expect(host.listDebugSessions()).toEqual([]);
  });

  it("starting a session remounts the script WITH the breakpoints", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [2, 4], { pauseOnEntry: false });

    // A second worker: entering a session restarts the script.
    expect(FakeWorker.instances.length).toBe(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.last?.debugSpec).toEqual({ breakpoints: [2, 4], pauseOnEntry: false });

    const session = host.getDebugSession(DEFINITION.id);
    // This script's setup computes a value and returns; it registers nothing.
    // "finished" is the only honest answer — it is NOT still running.
    expect(session?.status).toBe("finished");
    expect(session?.ready?.instrumented).toBe(true);
    expect(session?.ready?.pausableLines).toEqual([2, 3, 4]);
  });

  it("normalizes breakpoint lines (dedupes, drops junk, sorts)", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [4, 2, 2, 0, -1, 3.5]);
    expect(FakeWorker.last?.debugSpec?.breakpoints).toEqual([2, 4]);
  });

  it("tracks pause and resume, and reports what the editor renders", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    const worker = FakeWorker.last!;

    const seen: Array<string | undefined> = [];
    const off = onDebugState((detail) => seen.push(detail.session?.status));

    worker.pauseAt(3);
    const paused = host.getDebugSession(DEFINITION.id);
    expect(paused?.status).toBe("paused");
    expect(paused?.paused?.line).toBe(3);
    expect(paused?.paused?.variables[0]).toEqual({ name: "total", type: "number", value: "7" });
    expect(host.isScriptDebugPaused(DEFINITION.id)).toBe(true);

    host.hostDebugControl(DEFINITION.id, "continue");
    expect(worker.controls()).toEqual(["continue"]);
    // The realm had already reported `setup` finished before the (late) pause,
    // so continuing returns it to rest, not to a phantom "running".
    expect(host.getDebugSession(DEFINITION.id)?.status).toBe("finished");
    expect(host.isScriptDebugPaused(DEFINITION.id)).toBe(false);
    expect(seen).toContain("paused");
    off();
  });

  it("reports RUNNING, naming what is running, while an execution is on the stack", async () => {
    await mountButtonAndDebug();
    const worker = FakeWorker.last!;
    expect(host.getDebugSession(BUTTON_DEFINITION.id)?.status).toBe("waiting");

    worker.activity(true, "onClick");
    const running = host.getDebugSession(BUTTON_DEFINITION.id);
    expect(running?.status).toBe("running");
    expect(running?.activity).toEqual({ label: "onClick" });

    worker.activity(false, "onClick");
    const done = host.getDebugSession(BUTTON_DEFINITION.id);
    expect(done?.status).toBe("waiting");
    expect(done?.activity).toBeNull();
    expect(done?.lastActivity).toEqual({ label: "onClick" });
  });

  it("records that the last execution THREW, without claiming it is still running", async () => {
    await mountButtonAndDebug();
    const worker = FakeWorker.last!;
    worker.activity(true, "onClick");
    worker.activity(false, "onClick", "Cannot read properties of undefined");

    const session = host.getDebugSession(BUTTON_DEFINITION.id);
    expect(session?.status).toBe("waiting");
    expect(session?.lastActivity?.error).toMatch(/Cannot read properties/);
  });

  it("relays every step action to the realm", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    const worker = FakeWorker.last!;
    worker.pauseAt(3);
    host.hostDebugControl(DEFINITION.id, "stepOver");
    worker.pauseAt(4, "step");
    host.hostDebugControl(DEFINITION.id, "stepInto");
    worker.pauseAt(2, "step");
    host.hostDebugControl(DEFINITION.id, "stepOut");
    expect(worker.controls()).toEqual(["stepOver", "stepInto", "stepOut"]);
  });

  it("moves breakpoints mid-session without remounting", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [2]);
    const before = FakeWorker.instances.length;

    host.hostSetDebugBreakpoints(DEFINITION.id, [3, 4]);

    expect(FakeWorker.instances.length).toBe(before); // no restart
    const sent = FakeWorker.last!.received.filter((m) => m.t === "debugBreakpoints");
    expect(sent).toEqual([{ t: "debugBreakpoints", lines: [3, 4] }]);
    expect(host.getDebugSession(DEFINITION.id)?.breakpoints).toEqual([3, 4]);
  });

  it("STOPPING A SESSION ALWAYS RESUMES the script, then remounts it clean", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    const paused = FakeWorker.last!;
    paused.pauseAt(3);
    expect(host.isScriptDebugPaused(DEFINITION.id)).toBe(true);

    await host.hostStopDebugSession(DEFINITION.id);

    // The stop reached the (still live) realm before the remount tore it down.
    expect(paused.controls()).toContain("stop");
    expect(host.getDebugSession(DEFINITION.id)).toBeNull();
    // ...and the script is running again, without instrumentation.
    expect(FakeWorker.last).not.toBe(paused);
    expect(FakeWorker.last?.debugSpec).toBeNull();
    expect(host.hostIsMounted(DEFINITION.id)).toBe(true);
  });

  it("keeps the session across a Save & Apply remount, un-paused", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    FakeWorker.last!.pauseAt(3);

    await host.hostMountScript({ ...DEFINITION, source: `${DEFINITION.source}\n// edited` });

    const session = host.getDebugSession(DEFINITION.id);
    expect(session).not.toBeNull();
    expect(session?.status).toBe("finished");
    expect(session?.paused).toBeNull();
    expect(FakeWorker.last?.debugSpec?.breakpoints).toEqual([3]);
  });

  it("marks the session detached when the script is unmounted", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    FakeWorker.last!.pauseAt(3);

    host.hostUnmountScript(DEFINITION.id);

    const session = host.getDebugSession(DEFINITION.id);
    expect(session?.status).toBe("detached");
    expect(session?.paused).toBeNull();
    expect(host.isScriptDebugPaused(DEFINITION.id)).toBe(false);
  });

  it("drops every session on workbook reset", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    host.hostResetAll();
    expect(host.listDebugSessions()).toEqual([]);
  });
});

// ============================================================================
// THE REPORTED BUG: an event-driven script said "Running" forever.
// ============================================================================

describe("an event-driven script is MOUNTED AND WAITING, never 'running'", () => {
  beforeEach(async () => {
    resetFakeWorker();
    globalScope.Worker = FakeWorker as unknown as typeof Worker;
    vi.resetModules();
    host = await import("../host");
  });

  afterEach(() => {
    host.hostResetAll();
    resetFakeWorker();
    globalScope.Worker = originalWorker;
  });

  it("says it is WAITING, and names the trigger it is waiting for", async () => {
    await mountButtonAndDebug();

    const session = host.getDebugSession(BUTTON_DEFINITION.id);
    expect(session?.status).toBe("waiting");
    expect(session?.activity).toBeNull();
    expect(session?.triggers).toHaveLength(1);
    expect(session?.triggers[0]).toMatchObject({
      id: "hook:onClick",
      kind: "hook",
      name: "onClick",
      fireable: true,
    });
    // The description has to be about the USER'S world, not the protocol's.
    expect(session?.triggers[0].description).toMatch(/click/i);
  });

  it("says FINISHED when setup registered nothing that can start it again", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    const session = host.getDebugSession(DEFINITION.id);
    expect(session?.status).toBe("finished");
    expect(session?.triggers).toEqual([]);
  });

  it("stays honest when instrumentation BAILED OUT and reports no activity", async () => {
    // The fallback path runs the ORIGINAL source: no yield points, so no
    // activity reports at all. `mounted` is the backstop that must still land
    // the session on a resting state rather than leaving it "starting" forever.
    FakeWorker.reportActivity = false;
    await mountButtonAndDebug();
    expect(host.getDebugSession(BUTTON_DEFINITION.id)?.status).toBe("waiting");
  });

  it("FIRES a hook trigger through the same door a real click uses", async () => {
    await mountButtonAndDebug();
    const worker = FakeWorker.last!;

    await host.hostDebugFireTrigger(BUTTON_DEFINITION.id, "hook:onClick");

    // Delivered as a normal hook event — same dispatcher, production payload
    // shape, no "simulated" marker the handler could branch on.
    expect(worker.events()).toEqual([{ hook: "onClick", payload: { x: 0, y: 0 } }]);
  });

  it("a fired handler can then pause at a breakpoint like any other execution", async () => {
    await mountButtonAndDebug();
    const worker = FakeWorker.last!;
    await host.hostDebugFireTrigger(BUTTON_DEFINITION.id, "hook:onClick");

    worker.activity(true, "onClick");
    worker.pauseAt(3);

    const session = host.getDebugSession(BUTTON_DEFINITION.id);
    expect(session?.status).toBe("paused");
    expect(session?.paused?.line).toBe(3);
    expect(host.isScriptDebugPaused(BUTTON_DEFINITION.id)).toBe(true);

    host.hostDebugControl(BUTTON_DEFINITION.id, "continue");
    worker.activity(false, "onClick");
    expect(host.getDebugSession(BUTTON_DEFINITION.id)?.status).toBe("waiting");
  });

  it("refuses to fire a trigger the script never registered", async () => {
    await mountButtonAndDebug();
    await expect(
      host.hostDebugFireTrigger(BUTTON_DEFINITION.id, "hook:onEdit"),
    ).rejects.toThrow(/not a trigger/i);
  });

  it("refuses to fire without a session (this is session-scoped, not a back door)", async () => {
    FakeWorker.hooksOnMount = ["onClick"];
    await host.hostMountScript({ ...BUTTON_DEFINITION });
    await expect(
      host.hostDebugFireTrigger(BUTTON_DEFINITION.id, "hook:onClick"),
    ).rejects.toThrow(/No debug session/i);
    expect(FakeWorker.last?.events()).toEqual([]);
  });

  it("lists a render hook but refuses to fire it (it can never suspend)", async () => {
    FakeWorker.hooksOnMount = ["onRender"];
    await host.hostMountScript({ ...BUTTON_DEFINITION });
    await host.hostStartDebugSession(BUTTON_DEFINITION.id, []);

    const trigger = host.getDebugSession(BUTTON_DEFINITION.id)?.triggers[0];
    expect(trigger?.name).toBe("onRender");
    expect(trigger?.fireable).toBe(false);
    expect(trigger?.reason).toMatch(/deadline/i);
    await expect(
      host.hostDebugFireTrigger(BUTTON_DEFINITION.id, "hook:onRender"),
    ).rejects.toThrow(/cannot be fired/i);
  });

  it("picks up a hook registered AFTER setup returned", async () => {
    await mountButtonAndDebug();
    expect(host.getDebugSession(BUTTON_DEFINITION.id)?.triggers).toHaveLength(1);

    FakeWorker.last!.emit({ t: "hookRegistered", hook: "onResize" });

    const names = host.getDebugSession(BUTTON_DEFINITION.id)?.triggers.map((t) => t.name);
    expect(names).toEqual(["onClick", "onResize"]);
  });

  it("keeps a FAILED session, with what setup threw, instead of vanishing", async () => {
    // The case the user actually meets: the script mounts fine, and it is the
    // instrumented remount that trips over the bug they are hunting.
    await mount();
    FakeWorker.setupError = "button is not defined";
    await expect(host.hostStartDebugSession(DEFINITION.id, [3])).rejects.toThrow(/not defined/);

    const session = host.getDebugSession(DEFINITION.id);
    expect(session?.status).toBe("failed");
    expect(session?.error).toMatch(/not defined/);
    expect(session?.activity).toBeNull();
  });

  it("Stop always unmounts the instrumented realm, even from a failed session", async () => {
    FakeWorker.setupError = null;
    await mount();
    FakeWorker.setupError = "boom";
    await expect(host.hostStartDebugSession(DEFINITION.id, [3])).rejects.toThrow(/boom/);
    expect(host.getDebugSession(DEFINITION.id)?.status).toBe("failed");

    await host.hostStopDebugSession(DEFINITION.id);
    expect(host.getDebugSession(DEFINITION.id)).toBeNull();
  });

  it("lists an EXPOSED METHOD as a trigger and fires it through hostCallExposed", async () => {
    await mountButtonAndDebug();
    const worker = FakeWorker.last!;
    worker.expose("recalcAll");
    // The expose call is relayed through the async broker; let it land.
    await new Promise((r) => setTimeout(r, 0));
    expect(worker.received.filter((m) => m.t === "callResult")).toEqual([
      { t: "callResult", callId: 9001, ok: true, value: undefined },
    ]);

    const trigger = host
      .getDebugSession(BUTTON_DEFINITION.id)
      ?.triggers.find((t) => t.kind === "method");
    expect(trigger).toMatchObject({ id: "method:recalcAll", name: "recalcAll", fireable: true });

    // The relay stays open until the realm answers; this test only cares that
    // it went out through the exposed-method door (teardown settles it).
    void host
      .hostDebugFireTrigger(BUTTON_DEFINITION.id, "method:recalcAll")
      .catch(() => undefined);
    expect(worker.methodCalls().map((m) => m.methodName)).toEqual(["recalcAll"]);
  });

  it("Stop from a PAUSED session leaves no instrumented realm behind", async () => {
    await mountButtonAndDebug();
    const paused = FakeWorker.last!;
    paused.activity(true, "onClick");
    paused.pauseAt(3);
    expect(host.isScriptDebugPaused(BUTTON_DEFINITION.id)).toBe(true);

    await host.hostStopDebugSession(BUTTON_DEFINITION.id);

    expect(paused.terminated).toBe(true);
    expect(host.getDebugSession(BUTTON_DEFINITION.id)).toBeNull();
    expect(host.isScriptDebugPaused(BUTTON_DEFINITION.id)).toBe(false);
    expect(FakeWorker.last?.debugSpec).toBeNull();
    expect(host.hostIsMounted(BUTTON_DEFINITION.id)).toBe(true);
  });
});

describe("a paused script never blocks the user", () => {
  beforeEach(async () => {
    FakeWorker.instances = [];
    globalScope.Worker = FakeWorker as unknown as typeof Worker;
    vi.resetModules();
    host = await import("../host");
  });

  afterEach(() => {
    host.hostResetAll();
    globalScope.Worker = originalWorker;
  });

  it("DOES NOT BLOCK SAVE: the verdict is skipped, immediately, while paused", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    const worker = FakeWorker.last!;
    worker.pauseAt(3);
    const before = worker.received.length;

    const start = Date.now();
    const verdict = await host.callWorkbookBeforeLifecycle(DEFINITION.id, "save", {
      reason: "user",
    } as never);

    expect(verdict).toBeNull(); // null == allow
    // Not even relayed: a suspended realm cannot answer, and the user's Ctrl+S
    // must not wait 3s to learn that.
    expect(worker.received.length).toBe(before);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("DOES NOT BLOCK CLOSE either", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    FakeWorker.last!.pauseAt(3);
    await expect(
      host.callWorkbookBeforeLifecycle(DEFINITION.id, "close", { reason: "user" } as never),
    ).resolves.toBeNull();
  });

  it("does not block a cell commit", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    const worker = FakeWorker.last!;
    worker.pauseAt(3);
    const before = worker.received.length;

    await expect(
      host.callRangeBeforeCommit(DEFINITION.id, { row: 0, col: 0, value: "x" }),
    ).resolves.toBeNull();
    expect(worker.received.length).toBe(before);
  });

  it("resumes normal verdict collection once the script continues", async () => {
    await mount();
    await host.hostStartDebugSession(DEFINITION.id, [3]);
    const worker = FakeWorker.last!;
    worker.pauseAt(3);
    host.hostDebugControl(DEFINITION.id, "continue");

    const pending = host.callWorkbookBeforeLifecycle(DEFINITION.id, "save", {
      reason: "user",
    } as never);
    // Now it IS relayed (and answered by the fake realm below).
    const relayed = worker.received.find((m) => m.t === "methodCall");
    expect(relayed).toBeDefined();
    worker.emit({
      t: "methodResult",
      callId: (relayed as { callId: number }).callId,
      ok: true,
      value: { cancel: true, reason: "unsaved draft" },
    });
    await expect(pending).resolves.toEqual({ cancel: true, reason: "unsaved draft" });
  });
});

// ============================================================================
// A paused script must not be killed by a clock it is standing still in front of.
// ============================================================================

describe("deadlines are suspended while a script is paused", () => {
  beforeEach(async () => {
    resetFakeWorker();
    globalScope.Worker = FakeWorker as unknown as typeof Worker;
    vi.resetModules();
    host = await import("../host");
  });

  afterEach(() => {
    vi.useRealTimers();
    host.hostResetAll();
    resetFakeWorker();
    globalScope.Worker = originalWorker;
  });

  it("a relayed method call that stops at a breakpoint is NOT timed out", async () => {
    await mountButtonAndDebug();
    const worker = FakeWorker.last!;
    worker.expose("recalcAll");
    await Promise.resolve();
    await Promise.resolve();

    vi.useFakeTimers();
    const call = host.hostDebugFireTrigger(BUTTON_DEFINITION.id, "method:recalcAll");
    let rejected: unknown = null;
    void call.catch((e: unknown) => {
      rejected = e;
    });
    const relayed = worker.methodCalls()[0];
    expect(relayed.methodName).toBe("recalcAll");

    // The user stops at a breakpoint inside it and reads the frame for a while.
    worker.activity(true, "recalcAll()");
    worker.pauseAt(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rejected).toBeNull();

    // Continue; the realm answers normally.
    host.hostDebugControl(BUTTON_DEFINITION.id, "continue");
    worker.emit({ t: "methodResult", callId: relayed.callId, ok: true, value: null });
    worker.activity(false, "recalcAll()");
    await expect(call).resolves.toBeUndefined();
  });

  it("the deadline is REARMED on resume — a hung script still times out", async () => {
    await mountButtonAndDebug();
    const worker = FakeWorker.last!;
    worker.expose("recalcAll");
    await Promise.resolve();
    await Promise.resolve();

    vi.useFakeTimers();
    const call = host.hostDebugFireTrigger(BUTTON_DEFINITION.id, "method:recalcAll");
    let rejection: Error | null = null;
    void call.catch((e: Error) => {
      rejection = e;
    });

    worker.activity(true, "recalcAll()");
    worker.pauseAt(3);
    await vi.advanceTimersByTimeAsync(120_000);
    host.hostDebugControl(BUTTON_DEFINITION.id, "continue");
    // ...and now the realm simply never answers.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(rejection).not.toBeNull();
    expect((rejection as unknown as Error).message).toMatch(/timed out/i);
  });
});

/** Subscribe to the host's debug-state app event. */
function onDebugState(
  cb: (detail: { scriptId: string; session: { status: string } | null }) => void,
): () => void {
  const handler = (e: Event): void => cb((e as CustomEvent).detail);
  window.addEventListener("objectscript:debug-state", handler);
  return () => window.removeEventListener("objectscript:debug-state", handler);
}
