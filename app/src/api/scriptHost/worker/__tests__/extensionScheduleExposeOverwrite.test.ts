//! FILENAME: app/src/api/scriptHost/worker/__tests__/extensionScheduleExposeOverwrite.test.ts
// PURPOSE: `schedule.expose` under a name already exposed REPLACES the earlier
//          function in the worker too, not only on the host (rev11 nit).
//
// CONTEXT: The host's slot for a name points at the newest registration
//          (`ext.scheduleExpose`, extensionWorkerHost.ts), so the earlier
//          function can never be reached by a job again -- but the worker kept
//          it in its handler table until that registration's own withdraw ran,
//          which an extension that simply re-exposes never calls. Every
//          re-expose pinned one more closure for the life of the worker.

import { describe, it, expect } from "vitest";
import { buildExtensionContext } from "../extensionWorkerContext";
import type { WX2H } from "../../extensionProtocol";

type Handler = (...args: unknown[]) => unknown;
interface ScheduleApi {
  expose(name: string, fn: Handler): Promise<() => Promise<void>>;
}

function extensionContext() {
  const posted: WX2H[] = [];
  const built = buildExtensionContext(
    (msg) => posted.push(msg),
    { name: "Test Ext", version: "1.0.0", provenance: "distributed" },
    {},
  );
  const schedule = (built.context as { capabilities: { schedule: ScheduleApi } }).capabilities.schedule;
  const lastCall = (): Extract<WX2H, { t: "call" }> => {
    const call = posted.filter((m): m is Extract<WX2H, { t: "call" }> => m.t === "call").at(-1);
    if (!call || call.method !== "ext.scheduleExpose") throw new Error("expose did not post");
    return call;
  };
  /** Expose and let the host answer; resolves to the handler id it was sent with. */
  const expose = async (
    name: string,
    fn: Handler,
    accept = true,
  ): Promise<{ handlerId: number; withdraw?: () => Promise<void> }> => {
    const promise = schedule.expose(name, fn);
    const call = lastCall();
    const handlerId = (call.args as [string, number])[1];
    if (accept) {
      built.runtime.settleCall(call.callId, true, undefined, undefined as never);
      return { handlerId, withdraw: await promise };
    }
    built.runtime.settleCall(call.callId, false, undefined, { code: "PermissionDenied", message: "no" } as never);
    await promise.catch(() => undefined);
    return { handlerId };
  };
  /** Invoke a handler id the way the host does; answers whether it was found. */
  let nextReq = 1;
  const invoke = async (handlerId: number): Promise<boolean> => {
    const reqId = nextReq++;
    await built.runtime.invokeHandler(reqId, handlerId, []);
    const result = posted
      .filter((m): m is Extract<WX2H, { t: "handlerResult" }> => m.t === "handlerResult")
      .find((m) => m.reqId === reqId);
    return result?.ok === true;
  };
  return { expose, invoke };
}

describe("schedule.expose over a name already exposed", () => {
  it("frees the overwritten function at once, and the newer one stays callable", async () => {
    const { expose, invoke } = extensionContext();
    const first = await expose("tick", () => "first");
    const second = await expose("tick", () => "second");
    expect(await invoke(second.handlerId), "precondition: the newer function is live").toBe(true);
    expect(
      await invoke(first.handlerId),
      "the overwritten function was kept in the worker until its own withdraw",
    ).toBe(false);
  });

  it("withdrawing the OLDER registration leaves the newer one in place", async () => {
    const { expose, invoke } = extensionContext();
    const first = await expose("tick", () => "first");
    const second = await expose("tick", () => "second");
    void first.withdraw?.();
    expect(await invoke(second.handlerId)).toBe(true);
  });

  it("another name is not touched", async () => {
    const { expose, invoke } = extensionContext();
    const a = await expose("tick", () => "a");
    await expose("tock", () => "b");
    expect(await invoke(a.handlerId)).toBe(true);
  });

  it("a REFUSED re-expose leaves the earlier function live, and frees its own", async () => {
    const { expose, invoke } = extensionContext();
    const first = await expose("tick", () => "first");
    const refused = await expose("tick", () => "refused", false);
    expect(await invoke(first.handlerId), "the host kept the earlier registration").toBe(true);
    expect(await invoke(refused.handlerId)).toBe(false);
    // And a later accepted re-expose still frees the earlier one.
    const third = await expose("tick", () => "third");
    expect(await invoke(third.handlerId)).toBe(true);
    expect(await invoke(first.handlerId)).toBe(false);
  });
});
