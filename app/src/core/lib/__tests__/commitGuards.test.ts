//! FILENAME: app/src/core/lib/__tests__/commitGuards.test.ts
// PURPOSE: Tests for the commit guard registry.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerCommitGuard,
  checkCommitGuards,
  type CommitGuardFn,
} from "../commitGuards";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];

function reg(guard: CommitGuardFn) {
  cleanups.push(registerCommitGuard(guard));
}

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

// ============================================================================
// Tests
// ============================================================================

describe("registerCommitGuard", () => {
  it("returns a cleanup function that unregisters the guard", async () => {
    const guard: CommitGuardFn = async () => ({ action: "block" });
    const cleanup = registerCommitGuard(guard);

    // Guard is active
    expect(await checkCommitGuards(0, 0, "x")).toEqual({ action: "block" });

    cleanup();

    // Guard is gone
    expect(await checkCommitGuards(0, 0, "x")).toBeNull();
  });

  it("allows the same guard to be registered only once (Set semantics)", async () => {
    const calls: number[] = [];
    const guard: CommitGuardFn = async () => {
      calls.push(1);
      return null;
    };
    cleanups.push(registerCommitGuard(guard));
    cleanups.push(registerCommitGuard(guard)); // duplicate, Set ignores

    await checkCommitGuards(0, 0, "v");
    expect(calls).toHaveLength(1);
  });
});

describe("checkCommitGuards", () => {
  it("returns null when no guards are registered", async () => {
    expect(await checkCommitGuards(5, 3, "hello")).toBeNull();
  });

  it("returns null when all guards return null (no objection)", async () => {
    reg(async () => null);
    reg(async () => null);
    expect(await checkCommitGuards(0, 0, "v")).toBeNull();
  });

  it("returns null when all guards return allow", async () => {
    reg(async () => ({ action: "allow" }));
    reg(async () => ({ action: "allow" }));
    expect(await checkCommitGuards(0, 0, "v")).toBeNull();
  });

  it("returns the first blocking result", async () => {
    reg(async () => null);
    reg(async () => ({ action: "block" }));
    reg(async () => ({ action: "retry" })); // should not be reached

    const result = await checkCommitGuards(1, 2, "bad");
    expect(result).toEqual({ action: "block" });
  });

  it("returns retry result", async () => {
    reg(async () => ({ action: "retry" }));
    expect(await checkCommitGuards(0, 0, "v")).toEqual({ action: "retry" });
  });

  it("passes row, col, and value to the guard", async () => {
    const spy = vi.fn<CommitGuardFn>(async () => null);
    reg(spy);

    await checkCommitGuards(10, 20, "test value");
    expect(spy).toHaveBeenCalledWith(10, 20, "test value");
  });

  it("catches errors in guards and continues", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    reg(async () => {
      throw new Error("boom");
    });
    reg(async () => ({ action: "retry" }));

    const result = await checkCommitGuards(0, 0, "v");
    expect(result).toEqual({ action: "retry" });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("stops at first non-allow result, skipping later guards", async () => {
    const laterGuard = vi.fn<CommitGuardFn>(async () => null);
    reg(async () => ({ action: "block" }));
    reg(laterGuard);

    await checkCommitGuards(0, 0, "v");
    expect(laterGuard).not.toHaveBeenCalled();
  });
});
