//! FILENAME: app/src/api/scriptHost/__tests__/hookNaming.test.ts
// PURPOSE: `mountedScriptHasHook` must answer TRUE for a hook that is wired and
//          firing — whichever of the two spellings the caller uses.
// CONTEXT: The host keeps forwarders under the BARE hook name the worker posts
//          ("onClick"). It qualifies with the objectType in exactly one place —
//          the `switch (`${objectType}.${hook}`)` in wireHookForwarder — which
//          is also the only readable index of hook names a caller has. So the
//          qualified form is the natural thing to write, and writing it used to
//          return a flat `false`.
//
//          THAT WAS NOT THEORETICAL. The run-mode button-click diagnosis in the
//          Controls extension asks `mountedScriptHasHook(id, "button.onClick")`
//          to decide whether a click had anywhere to go. It always got `false`,
//          so every SUCCESSFUL click on a recorded-macro button popped
//          "it never registered a click handler" while the macro ran perfectly.
//          A diagnosis added to explain silence had started accusing working
//          code — found by driving the real app, not by any unit test.
//
//          These tests mount a real host realm (a fake Worker speaking the real
//          protocol) so they assert the actual forwarder map, not a restatement
//          of the lookup.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";

// The mount path touches the backend for grants and snapshot seeds; none of it
// is under test here and all of it is defensive against failure.
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

/** A worker realm that registers the hooks the test asks for, then mounts. */
class FakeWorker {
  static hooksOnMount: string[] = [];
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];
  terminated = false;

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(msg: H2W): void {
    this.received.push(msg);
    if (msg.t !== "mount") return;
    for (const hook of FakeWorker.hooksOnMount) {
      this.emit({ t: "hookRegistered", hook });
    }
    this.emit({ t: "mounted", ok: true });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: W2H): void {
    this.onmessage?.({ data } as MessageEvent<W2H>);
  }

  /** Events the host pushed INTO the realm — i.e. the forwarder actually fired. */
  events(): Array<{ hook: string; payload: unknown }> {
    return this.received
      .filter((m) => m.t === "event")
      .map((m) => ({
        hook: (m as { hook: string }).hook,
        payload: (m as { payload: unknown }).payload,
      }));
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
let host: HostModule;

/** The recorded-macro shape: a button whose `setup` registers a click handler. */
const BUTTON = {
  id: "macro-control-0-11-3",
  name: "E2E Journey",
  objectType: "button",
  instanceId: "control-0-11-3",
  source: "function setup(button){ button.onClick(function(){}); }",
  accessLevel: "unlocked",
  apiVersion: "1.0.0",
};

describe("mountedScriptHasHook — hook naming", () => {
  beforeEach(async () => {
    FakeWorker.hooksOnMount = ["onClick"];
    FakeWorker.last = null;
    globalScope.Worker = FakeWorker as unknown as typeof Worker;
    vi.resetModules();
    host = await import("../host");
  });

  afterEach(() => {
    host.hostResetAll();
    globalScope.Worker = originalWorker;
  });

  it("answers TRUE for the bare hook name the worker registered", async () => {
    await host.hostMountScript({ ...BUTTON });
    expect(host.mountedScriptHasHook(BUTTON.id, "onClick")).toBe(true);
  });

  it("answers TRUE for the OBJECT-QUALIFIED name too (the Controls spelling)", async () => {
    await host.hostMountScript({ ...BUTTON });
    // This is the exact call runFloatingButtonClick makes. It returned false,
    // and the user was told their working button had no click handler.
    expect(host.mountedScriptHasHook(BUTTON.id, "button.onClick")).toBe(true);
  });

  it("the hook it reports is the one that actually forwards the click", async () => {
    await host.hostMountScript({ ...BUTTON });
    expect(host.mountedScriptHasHook(BUTTON.id, "button.onClick")).toBe(true);

    window.dispatchEvent(
      new CustomEvent("button:clicked", {
        detail: { instanceId: BUTTON.instanceId, x: 4, y: 5 },
      }),
    );

    const forwarded = FakeWorker.last?.events() ?? [];
    expect(forwarded).toEqual([{ hook: "onClick", payload: { x: 4, y: 5 } }]);
  });

  it("still answers FALSE for a hook that was never registered", async () => {
    await host.hostMountScript({ ...BUTTON });
    expect(host.mountedScriptHasHook(BUTTON.id, "onDoubleClick")).toBe(false);
    expect(host.mountedScriptHasHook(BUTTON.id, "button.onDoubleClick")).toBe(false);
    // A prefix belonging to a DIFFERENT object type is not this script's, so it
    // is not stripped — "shape.onClick" is not a claim about a button.
    expect(host.mountedScriptHasHook(BUTTON.id, "shape.onClick")).toBe(false);
  });

  it("answers FALSE for a script that is not mounted at all", () => {
    expect(host.mountedScriptHasHook("nobody", "onClick")).toBe(false);
    expect(host.mountedScriptHasHook("nobody", "button.onClick")).toBe(false);
  });
});
