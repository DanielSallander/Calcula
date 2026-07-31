//! FILENAME: app/src/api/scriptHost/__tests__/lifecycleVerdict.test.ts
// PURPOSE: Pin the sandboxed save/close verdict: which replies cancel, and —
//          the critical case — that a hung or broken script CANNOT hold Ctrl+S
//          or the close button hostage (deadline + default-ALLOW).

import { describe, it, expect, vi } from "vitest";
import {
  callWorkbookBeforeLifecycle,
  normalizeLifecycleVerdict,
  raceLifecycleVerdict,
} from "../host";
import { buildWorkerContext, getExposedHandler } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";

// ============================================================================
// Verdict normalization (what a handler's return value MEANS)
// ============================================================================

describe("normalizeLifecycleVerdict", () => {
  it("cancels on false, \"cancel\", and { cancel: true }", () => {
    expect(normalizeLifecycleVerdict(false)).toEqual({ cancel: true });
    expect(normalizeLifecycleVerdict("cancel")).toEqual({ cancel: true });
    expect(normalizeLifecycleVerdict({ cancel: true })).toEqual({ cancel: true });
  });

  it("carries a string reason through, and only a string", () => {
    expect(normalizeLifecycleVerdict({ cancel: true, reason: "D21 is empty" })).toEqual({
      cancel: true,
      reason: "D21 is empty",
    });
    expect(normalizeLifecycleVerdict({ cancel: true, reason: 42 })).toEqual({ cancel: true });
  });

  it("ALLOWS on everything else — a handler that forgets to return must not "
    + "cancel the user's save", () => {
    for (const reply of [
      undefined,
      null,
      true,
      0,
      "",
      "block",
      {},
      { cancel: false },
      { cancel: "true" },
      [],
    ]) {
      expect(normalizeLifecycleVerdict(reply), JSON.stringify(reply) ?? "undefined").toBeNull();
    }
  });
});

// ============================================================================
// The deadline: default-ALLOW is the whole point
// ============================================================================

describe("raceLifecycleVerdict", () => {
  it("returns the script's cancellation when it answers in time", async () => {
    const verdict = await raceLifecycleVerdict(
      async () => ({ cancel: true, reason: "not signed off" }),
      "Audit",
      "save",
      50,
    );
    expect(verdict).toEqual({ cancel: true, reason: "not signed off" });
  });

  it("ALLOWS when the script never answers (a hung script cannot block Ctrl+S)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    const verdict = await raceLifecycleVerdict(
      () => new Promise<never>(() => {}), // never settles
      "Hung script",
      "save",
      25,
    );
    expect(verdict).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("Hung script");
    expect(String(warn.mock.calls[0][0])).toContain("allowing the save");
    warn.mockRestore();
  });

  it("ALLOWS a close the script answers too late (the app can always be closed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verdict = await raceLifecycleVerdict(
      () => new Promise((resolve) => setTimeout(() => resolve({ cancel: true }), 200)),
      "Slow script",
      "close",
      20,
    );
    expect(verdict).toBeNull();
    expect(String(warn.mock.calls[0][0])).toContain("allowing the close");
    warn.mockRestore();
  });

  it("ALLOWS when the relay rejects (a crashed worker cannot veto)", async () => {
    const verdict = await raceLifecycleVerdict(
      async () => {
        throw new Error("worker gone");
      },
      "Crashed",
      "save",
      50,
    );
    expect(verdict).toBeNull();
  });
});

describe("callWorkbookBeforeLifecycle", () => {
  it("allows when the script is not mounted", async () => {
    expect(await callWorkbookBeforeLifecycle("no-such-script", "save", {})).toBeNull();
    expect(await callWorkbookBeforeLifecycle("no-such-script", "close", {})).toBeNull();
  });
});

// ============================================================================
// The worker side: several handlers, first cancel wins, one broken handler
// cannot make a workbook unsaveable
// ============================================================================

function workbookContext(): {
  ctx: Record<string, unknown>;
  relaySave: (payload: unknown) => Promise<unknown>;
  posted: W2H[];
} {
  const posted: W2H[] = [];
  const spec: MountSpec = {
    protocolVersion: 1,
    scriptId: "s1",
    objectType: "workbook",
    tier: "restricted",
    capabilities: [],
    apiVersion: "1.0.0",
    source: "",
    scriptName: "Test",
    snapshot: {},
  };
  const { context, rt } = buildWorkerContext(spec, (m) => posted.push(m));
  return {
    ctx: context,
    relaySave: (payload) =>
      Promise.resolve(
        (getExposedHandler(rt, "__workbook_onBeforeSave") as (p: unknown) => unknown)(payload),
      ),
    posted,
  };
}

describe("workbook.onBeforeSave (worker side)", () => {
  it("registers as a hook so the host wires the guard", () => {
    const { ctx, posted } = workbookContext();
    (ctx.onBeforeSave as (h: () => void) => void)(() => {});
    expect(posted).toContainEqual({ t: "hookRegistered", hook: "onBeforeSave" });
  });

  it("runs every handler and returns the FIRST cancel", async () => {
    const { ctx, relaySave } = workbookContext();
    const order: string[] = [];
    (ctx.onBeforeSave as (h: (p: unknown) => unknown) => void)(() => {
      order.push("a");
    });
    (ctx.onBeforeSave as (h: (p: unknown) => unknown) => void)(() => {
      order.push("b");
      return { cancel: true, reason: "nope" };
    });
    (ctx.onBeforeSave as (h: (p: unknown) => unknown) => void)(() => {
      order.push("c");
    });

    expect(await relaySave({ path: "x.cala" })).toEqual({ cancel: true, reason: "nope" });
    // Short-circuits: no reason to keep asking once the save is cancelled.
    expect(order).toEqual(["a", "b"]);
  });

  it("awaits async handlers and hands them the payload", async () => {
    const { ctx, relaySave } = workbookContext();
    let seen: unknown;
    (ctx.onBeforeSave as (h: (p: unknown) => unknown) => void)(async (payload) => {
      seen = payload;
      await Promise.resolve();
      return false;
    });
    expect(await relaySave({ path: "book.cala" })).toEqual({ cancel: true });
    expect(seen).toEqual({ path: "book.cala" });
  });

  it("returns null when no handler objects", async () => {
    const { ctx, relaySave } = workbookContext();
    (ctx.onBeforeSave as (h: (p: unknown) => unknown) => void)(() => undefined);
    expect(await relaySave({})).toBeNull();
  });

  it("a handler that THROWS reports the error but does not cancel", async () => {
    const { ctx, relaySave, posted } = workbookContext();
    (ctx.onBeforeSave as (h: (p: unknown) => unknown) => void)(() => {
      throw new Error("bad handler");
    });
    const later = vi.fn(() => undefined);
    (ctx.onBeforeSave as (h: (p: unknown) => unknown) => void)(later);

    expect(await relaySave({})).toBeNull();
    expect(later).toHaveBeenCalledOnce();
    expect(posted.some((m) => m.t === "error" && m.message === "bad handler")).toBe(true);
  });

  it("an unsubscribed handler stops being asked", async () => {
    const { ctx, relaySave } = workbookContext();
    const off = (ctx.onBeforeSave as (h: (p: unknown) => unknown) => () => void)(() => false);
    expect(await relaySave({})).toEqual({ cancel: true });
    off();
    expect(await relaySave({})).toBeNull();
  });

  it("onBeforeClose is a separate relay from onBeforeSave", async () => {
    const posted: W2H[] = [];
    const spec: MountSpec = {
      protocolVersion: 1,
      scriptId: "s1",
      objectType: "workbook",
      tier: "restricted",
      capabilities: [],
      apiVersion: "1.0.0",
      source: "",
      scriptName: "Test",
      snapshot: {},
    };
    const { context, rt } = buildWorkerContext(spec, (m) => posted.push(m));
    (context.onBeforeClose as (h: (p: unknown) => unknown) => void)(() => false);
    expect(getExposedHandler(rt, "__workbook_onBeforeSave")).toBeUndefined();
    const relay = getExposedHandler(rt, "__workbook_onBeforeClose") as (p: unknown) => unknown;
    expect(await relay({})).toEqual({ cancel: true });
  });
});
