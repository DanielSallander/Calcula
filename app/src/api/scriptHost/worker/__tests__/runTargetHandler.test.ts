//! FILENAME: app/src/api/scriptHost/worker/__tests__/runTargetHandler.test.ts
// PURPOSE: The worker half of run-at-cursor (VBA F5). A top-level function is
//          registered as a run-target under the host-only prefix, and the thunk
//          that stands for it is ARITY-BOUND against the live `fn.length`:
//            - 0 args -> fn()
//            - 1 arg  -> fn(context.api)   (the conventional macro `fn(api)`)
//            - >1 args -> a clear throw, never a wrong-arity call.
//          The base.expose relay is what makes the host list it as a trigger.

import { describe, it, expect } from "vitest";
import { buildWorkerContext, registerRunTargetHandler, getExposedHandler } from "../contextShims";
import { RUN_TARGET_EXPOSED_PREFIX } from "../../protocol";
import type { MountSpec, W2H } from "../../protocol";

function ctx(api: unknown) {
  const spec: MountSpec = {
    protocolVersion: 1,
    scriptId: "s1",
    objectType: "workbook",
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0",
    source: "",
    scriptName: "Macro1",
    snapshot: {},
  };
  const posted: W2H[] = [];
  const { context, rt } = buildWorkerContext(spec, (m) => posted.push(m));
  // The macro convention is `fn(api)` where api === context.api; the real
  // context wires this from the mount. Stub it for the arity test.
  (context as Record<string, unknown>).api = api;
  return { context: context as { api: unknown }, rt, posted };
}

describe("registerRunTargetHandler (VBA F5 arity binding)", () => {
  it("registers under the host-only run-target prefix and relays base.expose (non-public)", () => {
    const { context, rt, posted } = ctx({});
    registerRunTargetHandler(rt, "doThing", () => 42, context);
    const exposedName = `${RUN_TARGET_EXPOSED_PREFIX}doThing`;
    expect(getExposedHandler(rt, exposedName)).toBeTypeOf("function");
    const exposeCall = posted.find(
      (m) => m.t === "call" && (m as { method: string }).method === "base.expose",
    ) as { args: unknown[] } | undefined;
    expect(exposeCall?.args).toEqual([exposedName, false]);
  });

  it("a 0-arg function is called with no arguments", async () => {
    const { context, rt } = ctx({ marker: "API" });
    let seen: unknown[] | null = null;
    registerRunTargetHandler(rt, "noArgs", (...a: unknown[]) => {
      seen = a;
      return "ok";
    }, context);
    const handler = getExposedHandler(rt, `${RUN_TARGET_EXPOSED_PREFIX}noArgs`)!;
    await expect(handler()).resolves.toBe("ok");
    expect(seen).toEqual([]);
  });

  it("a 1-arg function is called with context.api (the fn(api) macro shape)", async () => {
    const api = { marker: "API" };
    const { context, rt } = ctx(api);
    let received: unknown = null;
    registerRunTargetHandler(rt, "withApi", (a: unknown) => {
      received = a;
    }, context);
    await getExposedHandler(rt, `${RUN_TARGET_EXPOSED_PREFIX}withApi`)!();
    expect(received).toBe(api);
  });

  it("a >1-arg function throws a clear message and is never wrong-arity-called", async () => {
    const { context, rt } = ctx({});
    let called = false;
    registerRunTargetHandler(rt, "twoArgs", (_a: unknown, _b: unknown) => {
      called = true;
    }, context);
    await expect(
      getExposedHandler(rt, `${RUN_TARGET_EXPOSED_PREFIX}twoArgs`)!(),
    ).rejects.toThrow(/takes 2 — call it from setup/i);
    expect(called).toBe(false);
  });
});
