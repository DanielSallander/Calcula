//! FILENAME: app/src/api/scriptHost/worker/__tests__/extensionAppEventDispatch.test.ts
// PURPOSE: An async app-event handler's failure must reach the host, not vanish.
//
// CONTEXT: `dispatchAppEvent` used to do `void fn(payload)`, so an ASYNC
//          handler's throw became a rejected promise the surrounding try/catch
//          could not see — and every privileged call in the extension realm
//          goes through brokerCall, which returns a Promise, so any handler
//          that does real work IS async. With no unhandledrejection listener in
//          the realm, the rejection was observed by nothing: a sync throw
//          produced `[ext:…] uncaught:` on the host console, an async one
//          produced nothing anywhere. The object-script twin closed the same
//          hazard in contextShims.ts `dispatchEvent` (its own test is
//          hookDispatchCompletion.test.ts); this file pins the extension twin.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildExtensionContext } from "../extensionWorkerContext";
import type { WX2H } from "../../extensionProtocol";

type EventRegistrar = (name: string, cb: (payload: unknown) => unknown) => () => void;

function extensionContext() {
  const posted: WX2H[] = [];
  const built = buildExtensionContext(
    (msg) => posted.push(msg),
    { name: "Test Ext", version: "1.0.0", provenance: "distributed" },
    {},
  );
  const ctx = built.context as { events: { onAppEvent: EventRegistrar } };
  const register = (cb: (payload: unknown) => unknown): number => {
    ctx.events.onAppEvent("test:event", cb);
    const reg = posted.filter((m): m is Extract<WX2H, { t: "register" }> => m.t === "register").at(-1);
    if (!reg || reg.reg.kind !== "event") throw new Error("event registration did not post");
    return reg.reg.handlerId;
  };
  const errors = (): Array<Extract<WX2H, { t: "error" }>> =>
    posted.filter((m): m is Extract<WX2H, { t: "error" }> => m.t === "error");
  return { runtime: built.runtime, register, errors };
}

describe("extension app-event dispatch reports async failures", () => {
  it("runs a synchronous handler and returns nothing (no promise, no error)", () => {
    const { runtime, register, errors } = extensionContext();
    let ran = false;
    const handlerId = register(() => {
      ran = true;
    });

    const result = runtime.dispatchAppEvent(handlerId, { a: 1 });

    expect(ran).toBe(true);
    expect(result).toBeUndefined();
    expect(errors()).toEqual([]);
  });

  it("reports an ASYNC handler's rejection like a synchronous throw — the defect this file exists for", async () => {
    const { runtime, register, errors } = extensionContext();
    const handlerId = register(async () => {
      throw new Error("brokered write failed");
    });

    await runtime.dispatchAppEvent(handlerId, undefined);

    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ t: "error", message: "brokered write failed" });
    expect(errors()[0].stack).toBeDefined();
  });

  it("still reports a SYNCHRONOUS throw (the path that always worked)", () => {
    const { runtime, register, errors } = extensionContext();
    const handlerId = register(() => {
      throw new Error("sync boom");
    });

    runtime.dispatchAppEvent(handlerId, undefined);

    expect(errors()).toHaveLength(1);
    expect(errors()[0].message).toBe("sync boom");
  });

  it("settles only when an async handler has finished, and a clean handler posts no error", async () => {
    const { runtime, register, errors } = extensionContext();
    let release: (() => void) | null = null;
    let finished = false;
    const handlerId = register(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            finished = true;
            resolve();
          };
        }),
    );

    const pending = runtime.dispatchAppEvent(handlerId, undefined);
    expect(pending).toBeInstanceOf(Promise);
    expect(finished).toBe(false);

    release!();
    await pending;
    expect(finished).toBe(true);
    expect(errors()).toEqual([]);
  });

  it("stringifies a non-Error rejection reason instead of losing it", async () => {
    const { runtime, register, errors } = extensionContext();
    const handlerId = register(() => Promise.reject("plain string reason"));

    await runtime.dispatchAppEvent(handlerId, undefined);

    expect(errors()).toHaveLength(1);
    expect(errors()[0].message).toBe("plain string reason");
    expect(errors()[0].stack).toBeUndefined();
  });

  it("does nothing for a handler nobody registered", () => {
    const { runtime, errors } = extensionContext();
    expect(runtime.dispatchAppEvent(999, undefined)).toBeUndefined();
    expect(errors()).toEqual([]);
  });

  it("reports a poisoned thenable (throwing `then` getter) instead of throwing past dispatch", () => {
    // A distributed extension is untrusted by definition. `.then` access and
    // Promise.resolve() both run synchronously during collection; if either
    // throws it must land in the error channel, not escape onmessage as a sync
    // throw the unhandledrejection backstop can never see.
    const { runtime, register, errors } = extensionContext();
    const handlerId = register(() => ({
      get then(): never {
        throw new Error("poisoned thenable");
      },
    }));

    expect(() => runtime.dispatchAppEvent(handlerId, undefined)).not.toThrow();
    expect(errors().map((e) => e.message)).toEqual(["poisoned thenable"]);
  });

  it("couples its returned promise to the handler: a rejection AFTER a tick is reported by the time the dispatch settles", async () => {
    // Pins the settle-coupling contract itself: an implementation that reports
    // rejections but returns an already-resolved promise passes every
    // same-microtask test and fails only this one.
    const { runtime, register, errors } = extensionContext();
    const handlerId = register(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("late boom");
    });

    const pending = runtime.dispatchAppEvent(handlerId, undefined);
    expect(errors()).toEqual([]);

    await pending;
    expect(errors().map((e) => e.message)).toEqual(["late boom"]);
  });
});

describe("the extension realm's unhandledrejection backstop", () => {
  // extensionBootstrap.ts hardens ambient globals at import time, so no unit
  // test can import and drive it — this guard reads the source instead (the
  // repo's idiom for unexecutable wiring, cf. the leak-don't-drop pin in
  // notebook_executor.rs). What it holds: the listener exists, registers at
  // module top level, and is UNCONDITIONAL — the object-script twin's listener
  // (worker/bootstrap.ts) is debug-gated, and "match the twin" is the exact
  // refactor that would silently reopen this hole.
  // import.meta.url is not a file: URL under the jsdom transform, so resolve
  // from cwd — tolerating both the app dir (the canonical runner) and the repo
  // root, so a differently-rooted invocation cannot turn this guard into ENOENT.
  const REL = join("src", "api", "scriptHost", "worker", "extensionBootstrap.ts");
  const bootstrapPath = [join(process.cwd(), REL), join(process.cwd(), "app", REL)].find((p) =>
    existsSync(p),
  );
  if (!bootstrapPath) throw new Error("extensionBootstrap.ts not found from " + process.cwd());
  const source = readFileSync(bootstrapPath, "utf8");

  it("is registered at module top level and posts t:\"error\" with no gate", () => {
    const listener = source.match(
      /^self\.addEventListener\("unhandledrejection",[\s\S]*?\n\}\);/m,
    );
    expect(
      listener,
      "extensionBootstrap.ts no longer registers a top-level unhandledrejection listener — " +
        "an async failure nothing collects is silent on a production mount again",
    ).not.toBeNull();
    const body = listener![0];
    expect(body).toContain('t: "error"');
    expect(body, "the backstop must be unconditional: no gate, no early return").not.toMatch(
      /\bif\s*\(|\breturn\b/,
    );
  });
});
