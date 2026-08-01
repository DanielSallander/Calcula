//! FILENAME: app/src/api/scriptHost/__tests__/debugSession.test.ts
// PURPOSE: The host half of step-through debugging (task H1). The properties
//          under test are the ones a debugger must never get wrong:
//            - a session is entered explicitly, on a mounted script, and carries
//              the instrumentation flag ONLY for that mount;
//            - pause / resume / step state is what the editor renders;
//            - A PAUSED SCRIPT NEVER BLOCKS SAVE OR CLOSE;
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

async function mount(): Promise<void> {
  await host.hostMountScript({ ...DEFINITION });
}

describe("debug sessions (host)", () => {
  beforeEach(async () => {
    FakeWorker.instances = [];
    FakeWorker.last = null;
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
    expect(session?.status).toBe("running");
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
    expect(host.getDebugSession(DEFINITION.id)?.status).toBe("running");
    expect(host.isScriptDebugPaused(DEFINITION.id)).toBe(false);
    expect(seen).toContain("paused");
    off();
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
    expect(session?.status).toBe("running");
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

/** Subscribe to the host's debug-state app event. */
function onDebugState(
  cb: (detail: { scriptId: string; session: { status: string } | null }) => void,
): () => void {
  const handler = (e: Event): void => cb((e as CustomEvent).detail);
  window.addEventListener("objectscript:debug-state", handler);
  return () => window.removeEventListener("objectscript:debug-state", handler);
}
