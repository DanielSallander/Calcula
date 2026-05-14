//! FILENAME: app/src/core/lib/__tests__/editGuards.test.ts
// PURPOSE: Tests for the edit guard and range guard registries.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerEditGuard,
  checkEditGuards,
  registerRangeGuard,
  checkRangeGuards,
  type EditGuardFn,
  type RangeGuardFn,
} from "../editGuards";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

// ============================================================================
// Edit Guards
// ============================================================================

describe("registerEditGuard", () => {
  it("returns a cleanup function that unregisters the guard", async () => {
    const guard: EditGuardFn = async () => ({
      blocked: true,
      message: "no",
    });
    const cleanup = registerEditGuard(guard);

    expect(await checkEditGuards(0, 0)).toEqual({
      blocked: true,
      message: "no",
    });

    cleanup();
    expect(await checkEditGuards(0, 0)).toBeNull();
  });
});

describe("checkEditGuards", () => {
  it("returns null when no guards are registered", async () => {
    expect(await checkEditGuards(0, 0)).toBeNull();
  });

  it("returns null when all guards return null", async () => {
    cleanups.push(registerEditGuard(async () => null));
    cleanups.push(registerEditGuard(async () => null));
    expect(await checkEditGuards(0, 0)).toBeNull();
  });

  it("returns null when guard returns blocked: false", async () => {
    cleanups.push(registerEditGuard(async () => ({ blocked: false })));
    expect(await checkEditGuards(0, 0)).toBeNull();
  });

  it("returns the first blocking result", async () => {
    cleanups.push(registerEditGuard(async () => null));
    cleanups.push(
      registerEditGuard(async () => ({ blocked: true, message: "locked" }))
    );

    expect(await checkEditGuards(1, 2)).toEqual({
      blocked: true,
      message: "locked",
    });
  });

  it("passes row and col to the guard", async () => {
    const spy = vi.fn<EditGuardFn>(async () => null);
    cleanups.push(registerEditGuard(spy));
    await checkEditGuards(7, 13);
    expect(spy).toHaveBeenCalledWith(7, 13);
  });

  it("catches errors in guards and continues", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(
      registerEditGuard(async () => {
        throw new Error("fail");
      })
    );
    cleanups.push(
      registerEditGuard(async () => ({ blocked: true, message: "ok" }))
    );

    const result = await checkEditGuards(0, 0);
    expect(result).toEqual({ blocked: true, message: "ok" });
    consoleSpy.mockRestore();
  });

  it("stops at first blocking result", async () => {
    const later = vi.fn<EditGuardFn>(async () => null);
    cleanups.push(
      registerEditGuard(async () => ({ blocked: true, message: "first" }))
    );
    cleanups.push(registerEditGuard(later));

    await checkEditGuards(0, 0);
    expect(later).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Range Guards
// ============================================================================

describe("registerRangeGuard", () => {
  it("returns a cleanup function that unregisters the guard", () => {
    const guard: RangeGuardFn = () => ({ blocked: true, message: "no" });
    const cleanup = registerRangeGuard(guard);

    expect(checkRangeGuards(0, 0, 5, 5)).toEqual({
      blocked: true,
      message: "no",
    });

    cleanup();
    expect(checkRangeGuards(0, 0, 5, 5)).toBeNull();
  });
});

describe("checkRangeGuards", () => {
  it("returns null when no guards are registered", () => {
    expect(checkRangeGuards(0, 0, 10, 10)).toBeNull();
  });

  it("returns null when all guards return null", () => {
    cleanups.push(registerRangeGuard(() => null));
    expect(checkRangeGuards(0, 0, 5, 5)).toBeNull();
  });

  it("returns the first blocking result", () => {
    cleanups.push(registerRangeGuard(() => null));
    cleanups.push(
      registerRangeGuard(() => ({ blocked: true, message: "range locked" }))
    );

    expect(checkRangeGuards(0, 0, 3, 3)).toEqual({
      blocked: true,
      message: "range locked",
    });
  });

  it("passes all four coordinates to the guard", () => {
    const spy = vi.fn<RangeGuardFn>(() => null);
    cleanups.push(registerRangeGuard(spy));
    checkRangeGuards(1, 2, 10, 20);
    expect(spy).toHaveBeenCalledWith(1, 2, 10, 20);
  });

  it("catches errors in guards and continues", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(
      registerRangeGuard(() => {
        throw new Error("fail");
      })
    );
    cleanups.push(
      registerRangeGuard(() => ({ blocked: true, message: "ok" }))
    );

    expect(checkRangeGuards(0, 0, 1, 1)).toEqual({
      blocked: true,
      message: "ok",
    });
    consoleSpy.mockRestore();
  });

  it("is synchronous (returns directly, not a promise)", () => {
    const result = checkRangeGuards(0, 0, 1, 1);
    // Should not be a Promise
    expect(result).not.toBeInstanceOf(Promise);
  });
});
