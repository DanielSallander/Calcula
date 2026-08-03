//! FILENAME: app/src/api/scriptHost/worker/__tests__/hookDispatchCompletion.test.ts
// PURPOSE: A hook dispatch has to be able to say WHEN IT IS OVER.
//
// CONTEXT: The debugger's status is built on it. `dispatchEvent` used to invoke
//          every handler and return immediately, discarding any promise a
//          handler produced, so nothing in the realm knew whether an async
//          handler was still running — and the session showed "Running" forever
//          regardless. It now settles with its handlers, which fixes a second
//          thing on the way: an ASYNC handler that rejected escaped the
//          try/catch entirely and became a silent unhandled rejection on a
//          production mount.
//
//          Handlers are still INVOKED SYNCHRONOUSLY, in order. That is load
//          bearing: the host relies on a dispatched event having reached every
//          handler by the time it returns.

import { describe, it, expect } from "vitest";
import { buildWorkerContext, dispatchEvent } from "../contextShims";
import type { MountSpec, W2H } from "../../protocol";

function buttonContext() {
  const spec: MountSpec = {
    protocolVersion: 1,
    scriptId: "s1",
    objectType: "button",
    instanceId: "btn-1",
    tier: "restricted",
    capabilities: [],
    apiVersion: "1.0",
    source: "",
    scriptName: "Macro1",
    snapshot: {},
  };
  const posted: W2H[] = [];
  const post = (msg: W2H): void => {
    posted.push(msg);
  };
  const { context, rt } = buildWorkerContext(spec, post);
  return { button: context as Record<string, unknown>, rt, posted, post };
}

type ClickRegistrar = (h: (payload: unknown) => unknown) => () => void;

describe("hook dispatch reports completion", () => {
  it("returns nothing for a purely synchronous handler (no promise, no cost)", () => {
    const { button, rt, post } = buttonContext();
    let ran = false;
    (button.onClick as ClickRegistrar)(() => {
      ran = true;
    });

    const result = dispatchEvent(rt, "onClick", { x: 0, y: 0 }, post);

    expect(ran).toBe(true);
    expect(result).toBeUndefined();
  });

  it("settles only when an ASYNC handler has finished", async () => {
    const { button, rt, post } = buttonContext();
    let release: (() => void) | null = null;
    let finished = false;
    (button.onClick as ClickRegistrar)(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            finished = true;
            resolve();
          };
        }),
    );

    const pending = dispatchEvent(rt, "onClick", { x: 0, y: 0 }, post);
    expect(pending).toBeInstanceOf(Promise);
    expect(finished).toBe(false);

    release!();
    await pending;
    expect(finished).toBe(true);
  });

  it("invokes every handler SYNCHRONOUSLY, in registration order", () => {
    const { button, rt, post } = buttonContext();
    const order: number[] = [];
    (button.onClick as ClickRegistrar)(() => {
      order.push(1);
    });
    (button.onClick as ClickRegistrar)(async () => {
      order.push(2);
    });
    (button.onClick as ClickRegistrar)(() => {
      order.push(3);
    });

    dispatchEvent(rt, "onClick", undefined, post);
    expect(order).toEqual([1, 2, 3]);
  });

  it("reports an ASYNC handler's rejection as a script error instead of losing it", async () => {
    const { button, rt, posted, post } = buttonContext();
    (button.onClick as ClickRegistrar)(async () => {
      throw new Error("setCellValue failed");
    });

    await dispatchEvent(rt, "onClick", undefined, post);

    const errors = posted.filter((m) => m.t === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ hook: "onClick", message: "setCellValue failed" });
  });

  it("one failing handler never stops the others", async () => {
    const { button, rt, posted, post } = buttonContext();
    let lastRan = false;
    (button.onClick as ClickRegistrar)(() => {
      throw new Error("sync boom");
    });
    (button.onClick as ClickRegistrar)(async () => {
      throw new Error("async boom");
    });
    (button.onClick as ClickRegistrar)(() => {
      lastRan = true;
    });

    await dispatchEvent(rt, "onClick", undefined, post);

    expect(lastRan).toBe(true);
    expect(posted.filter((m) => m.t === "error").map((m) => (m as { message: string }).message))
      .toEqual(["sync boom", "async boom"]);
  });

  it("does nothing for a hook nobody registered", () => {
    const { rt, post } = buttonContext();
    expect(dispatchEvent(rt, "onClick", undefined, post)).toBeUndefined();
  });
});
