//! FILENAME: app/src/core/lib/__tests__/lifecycleGuards.test.ts
// PURPOSE: Pin the cancellable-lifecycle contract: who can stop a save/close,
//          who cannot, and that a cancellation is never silent.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkLifecycleGuards,
  lifecycleCancelMessage,
  lifecycleGuardCount,
  registerLifecycleCancelReporter,
  registerLifecycleGuard,
  resetLifecycleGuards,
  type LifecycleAction,
  type LifecycleGuardResult,
} from "../lifecycleGuards";

const reported: Array<{ action: LifecycleAction; result: LifecycleGuardResult }> = [];

beforeEach(() => {
  resetLifecycleGuards();
  reported.length = 0;
  registerLifecycleCancelReporter((action, result) => reported.push({ action, result }));
});

afterEach(() => {
  resetLifecycleGuards();
});

describe("registerLifecycleGuard", () => {
  it("allows when nothing is registered", async () => {
    resetLifecycleGuards();
    expect(await checkLifecycleGuards("save", { path: "a.cala" })).toBeNull();
    expect(lifecycleGuardCount()).toBe(0);
  });

  it("returns the first objection and stops asking", async () => {
    const second = vi.fn(async () => null);
    registerLifecycleGuard(async () => ({ by: "Month-end check", reason: "D21 is empty" }));
    registerLifecycleGuard(second);

    const verdict = await checkLifecycleGuards("save", { path: "book.cala" });
    expect(verdict).toEqual({ by: "Month-end check", reason: "D21 is empty" });
    expect(second).not.toHaveBeenCalled();
  });

  it("passes the action and detail through to each guard", async () => {
    const seen: Array<[LifecycleAction, unknown]> = [];
    registerLifecycleGuard(async (action, detail) => {
      seen.push([action, detail]);
      return null;
    });
    await checkLifecycleGuards("save", { path: "x.cala" });
    await checkLifecycleGuards("close");
    expect(seen).toEqual([
      ["save", { path: "x.cala" }],
      ["close", {}],
    ]);
  });

  it("a guard that THROWS does not cancel — the user's operation wins", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerLifecycleGuard(async () => {
      throw new Error("boom");
    });
    const later = vi.fn(async () => null);
    registerLifecycleGuard(later);

    expect(await checkLifecycleGuards("save")).toBeNull();
    // ...and the guards AFTER the broken one still run.
    expect(later).toHaveBeenCalledOnce();
    expect(reported).toHaveLength(0);
    spy.mockRestore();
  });

  it("unregisters cleanly — a torn-down guard can never veto", async () => {
    const cleanup = registerLifecycleGuard(async () => ({ by: "Gone" }));
    expect(lifecycleGuardCount()).toBe(1);
    expect(await checkLifecycleGuards("close")).not.toBeNull();

    cleanup();
    expect(lifecycleGuardCount()).toBe(0);
    expect(await checkLifecycleGuards("close")).toBeNull();
  });
});

describe("cancellation is never silent", () => {
  it("reports every cancellation, attributed to the objector", async () => {
    registerLifecycleGuard(async () => ({ by: "Audit stamp", reason: "not signed off" }));
    await checkLifecycleGuards("save", { path: "q4.cala" });
    expect(reported).toEqual([
      { action: "save", result: { by: "Audit stamp", reason: "not signed off" } },
    ]);
  });

  it("does not report when nothing objected", async () => {
    registerLifecycleGuard(async () => null);
    await checkLifecycleGuards("save");
    expect(reported).toHaveLength(0);
  });

  it("falls back to the console when no reporter is registered", async () => {
    registerLifecycleCancelReporter(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerLifecycleGuard(async () => ({ by: "Closer" }));
    await checkLifecycleGuards("close");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("names the script and the operation in the message", () => {
    expect(lifecycleCancelMessage("save", { by: "Month-end", reason: "D21 is empty" })).toBe(
      'Script "Month-end" cancelled the save: D21 is empty',
    );
    expect(lifecycleCancelMessage("close", { by: "Month-end" })).toBe(
      'Script "Month-end" cancelled the close.',
    );
  });
});
