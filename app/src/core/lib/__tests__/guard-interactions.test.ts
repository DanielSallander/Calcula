//! FILENAME: app/src/core/lib/__tests__/guard-interactions.test.ts
// PURPOSE: Tests for interactions between multiple guard systems and extensions.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerEditGuard,
  checkEditGuards,
  registerRangeGuard,
  checkRangeGuards,
  type EditGuardFn,
  type RangeGuardFn,
} from "../editGuards";
import {
  registerCommitGuard,
  checkCommitGuards,
  type CommitGuardFn,
} from "../commitGuards";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

function reg(guard: EditGuardFn): void {
  cleanups.push(registerEditGuard(guard));
}

function regRange(guard: RangeGuardFn): void {
  cleanups.push(registerRangeGuard(guard));
}

function regCommit(guard: CommitGuardFn): void {
  cleanups.push(registerCommitGuard(guard));
}

// ============================================================================
// Multiple edit guards from different extensions
// ============================================================================

describe("multiple edit guards from different extensions", () => {
  it("Protection guard blocks locked cells", async () => {
    const lockedCells = new Set(["0,0", "1,1", "2,2"]);
    const protectionGuard: EditGuardFn = async (row, col) => {
      if (lockedCells.has(`${row},${col}`)) {
        return { blocked: true, message: "Cell is protected" };
      }
      return null;
    };
    reg(protectionGuard);

    expect(await checkEditGuards(0, 0)).toEqual({
      blocked: true,
      message: "Cell is protected",
    });
    expect(await checkEditGuards(3, 3)).toBeNull();
  });

  it("Table guard blocks header row edits", async () => {
    const tableGuard: EditGuardFn = async (row, _col) => {
      if (row === 0) return { blocked: true, message: "Cannot edit table header" };
      return null;
    };
    reg(tableGuard);

    expect(await checkEditGuards(0, 5)).toEqual({
      blocked: true,
      message: "Cannot edit table header",
    });
    expect(await checkEditGuards(1, 5)).toBeNull();
  });

  it("Protection + Table + custom guard all coexist", async () => {
    // Protection: blocks row 0, col 0
    reg(async (row, col) => {
      if (row === 0 && col === 0) return { blocked: true, message: "Protected" };
      return null;
    });
    // Table: blocks row 5 (formula row)
    reg(async (row, _col) => {
      if (row === 5) return { blocked: true, message: "Table formula row" };
      return null;
    });
    // Custom: blocks col 10+
    reg(async (_row, col) => {
      if (col >= 10) return { blocked: true, message: "Read-only columns" };
      return null;
    });

    expect(await checkEditGuards(0, 0)).toEqual({ blocked: true, message: "Protected" });
    expect(await checkEditGuards(5, 3)).toEqual({ blocked: true, message: "Table formula row" });
    expect(await checkEditGuards(1, 15)).toEqual({ blocked: true, message: "Read-only columns" });
    expect(await checkEditGuards(1, 1)).toBeNull();
  });
});

// ============================================================================
// First-blocking-wins behavior with 5+ guards
// ============================================================================

describe("first-blocking-wins behavior", () => {
  it("first registered guard that blocks wins", async () => {
    const callOrder: string[] = [];

    reg(async () => { callOrder.push("A"); return null; });
    reg(async () => { callOrder.push("B"); return { blocked: true, message: "B blocks" }; });
    reg(async () => { callOrder.push("C"); return { blocked: true, message: "C blocks" }; });
    reg(async () => { callOrder.push("D"); return null; });
    reg(async () => { callOrder.push("E"); return { blocked: true, message: "E blocks" }; });

    const result = await checkEditGuards(0, 0);
    expect(result).toEqual({ blocked: true, message: "B blocks" });
    // C, D, E should not be called
    expect(callOrder).toEqual(["A", "B"]);
  });

  it("all guards run when none blocks", async () => {
    const callOrder: string[] = [];
    for (const label of ["A", "B", "C", "D", "E"]) {
      reg(async () => { callOrder.push(label); return null; });
    }

    const result = await checkEditGuards(0, 0);
    expect(result).toBeNull();
    expect(callOrder).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("blocked=false does not block", async () => {
    reg(async () => ({ blocked: false }));
    reg(async () => ({ blocked: true, message: "Second" }));

    const result = await checkEditGuards(0, 0);
    expect(result).toEqual({ blocked: true, message: "Second" });
  });
});

// ============================================================================
// Guard registration order matters
// ============================================================================

describe("guard registration order", () => {
  it("later-registered guard runs after earlier one", async () => {
    const order: number[] = [];
    reg(async () => { order.push(1); return null; });
    reg(async () => { order.push(2); return null; });
    reg(async () => { order.push(3); return null; });

    await checkEditGuards(0, 0);
    expect(order).toEqual([1, 2, 3]);
  });

  it("removing first guard shifts priority to second", async () => {
    const guardA: EditGuardFn = async () => ({ blocked: true, message: "A" });
    const guardB: EditGuardFn = async () => ({ blocked: true, message: "B" });

    const cleanupA = registerEditGuard(guardA);
    cleanups.push(cleanupA);
    cleanups.push(registerEditGuard(guardB));

    expect(await checkEditGuards(0, 0)).toEqual({ blocked: true, message: "A" });

    cleanupA();
    expect(await checkEditGuards(0, 0)).toEqual({ blocked: true, message: "B" });
  });
});

// ============================================================================
// Guard that throws vs guard that returns null
// ============================================================================

describe("guard error handling", () => {
  it("throwing guard is caught, next guard runs", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    reg(async () => { throw new Error("Guard crashed"); });
    reg(async () => ({ blocked: true, message: "Fallback" }));

    const result = await checkEditGuards(0, 0);
    expect(result).toEqual({ blocked: true, message: "Fallback" });
    expect(consoleSpy).toHaveBeenCalledOnce();

    consoleSpy.mockRestore();
  });

  it("throwing guard does not block editing by itself", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    reg(async () => { throw new Error("Boom"); });

    const result = await checkEditGuards(0, 0);
    expect(result).toBeNull();

    consoleSpy.mockRestore();
  });

  it("range guard that throws is caught gracefully", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    regRange(() => { throw new Error("Range guard error"); });
    regRange(() => ({ blocked: true, message: "After throw" }));

    const result = checkRangeGuards(0, 0, 5, 5);
    expect(result).toEqual({ blocked: true, message: "After throw" });

    consoleSpy.mockRestore();
  });
});

// ============================================================================
// Mix of sync and async guards (edit guards are all async by signature)
// ============================================================================

describe("mix of sync-like and truly async guards", () => {
  it("immediately resolving guard works alongside delayed guard", async () => {
    // "Sync-like" - resolves immediately
    reg(async () => null);
    // Truly async - involves a delay
    reg(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return { blocked: true, message: "Delayed block" };
    });

    const result = await checkEditGuards(0, 0);
    expect(result).toEqual({ blocked: true, message: "Delayed block" });
  });

  it("slow guard blocks before faster guard runs", async () => {
    const order: string[] = [];
    reg(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("slow");
      return { blocked: true, message: "Slow wins" };
    });
    reg(async () => {
      order.push("fast");
      return { blocked: true, message: "Fast" };
    });

    const result = await checkEditGuards(0, 0);
    expect(result).toEqual({ blocked: true, message: "Slow wins" });
    expect(order).toEqual(["slow"]); // Fast never runs
  });
});

// ============================================================================
// Guard unregistration doesn't affect other guards
// ============================================================================

describe("guard unregistration isolation", () => {
  it("unregistering one guard leaves others intact", async () => {
    const guardA: EditGuardFn = async () => null;
    const guardB: EditGuardFn = async () => ({ blocked: true, message: "B" });
    const guardC: EditGuardFn = async () => ({ blocked: true, message: "C" });

    const cleanA = registerEditGuard(guardA);
    cleanups.push(registerEditGuard(guardB));
    cleanups.push(registerEditGuard(guardC));

    cleanA(); // Remove A

    const result = await checkEditGuards(0, 0);
    expect(result).toEqual({ blocked: true, message: "B" });
  });

  it("double unregistration is safe", async () => {
    const guard: EditGuardFn = async () => ({ blocked: true, message: "X" });
    const cleanup = registerEditGuard(guard);
    cleanups.push(cleanup);

    cleanup();
    cleanup(); // Should not throw

    expect(await checkEditGuards(0, 0)).toBeNull();
  });

  it("unregistering commit guard leaves edit guards unaffected", async () => {
    reg(async () => ({ blocked: true, message: "Edit blocked" }));
    const commitCleanup = registerCommitGuard(async () => ({ action: "block" }));

    commitCleanup();

    // Edit guard should still work
    expect(await checkEditGuards(0, 0)).toEqual({ blocked: true, message: "Edit blocked" });
    // Commit guard should be gone
    expect(await checkCommitGuards(0, 0, "test")).toBeNull();
  });
});

// ============================================================================
// Range guards with overlapping ranges from different extensions
// ============================================================================

describe("range guards with overlapping ranges", () => {
  it("Protection blocks range A, Table blocks range B, overlap is blocked by first", () => {
    // Protection: blocks rows 0-5, cols 0-5
    regRange((sr, sc, er, ec) => {
      if (sr <= 5 && sc <= 5 && er >= 0 && ec >= 0) {
        return { blocked: true, message: "Protected range" };
      }
      return null;
    });
    // Table: blocks rows 3-10, cols 3-10
    regRange((sr, sc, er, ec) => {
      if (sr <= 10 && sc <= 10 && er >= 3 && ec >= 3) {
        return { blocked: true, message: "Table range" };
      }
      return null;
    });

    // Overlap (3-5, 3-5) - Protection wins (registered first)
    expect(checkRangeGuards(3, 3, 5, 5)).toEqual({ blocked: true, message: "Protected range" });
    // Only Table range (row 6-10)
    expect(checkRangeGuards(6, 3, 10, 10)).toEqual({ blocked: true, message: "Table range" });
    // Outside both
    expect(checkRangeGuards(11, 11, 15, 15)).toBeNull();
  });

  it("multiple range guards can have granular messages", () => {
    regRange((sr) => {
      if (sr < 3) return { blocked: true, message: "Header area" };
      return null;
    });
    regRange((_sr, sc) => {
      if (sc > 20) return { blocked: true, message: "Beyond data range" };
      return null;
    });

    expect(checkRangeGuards(0, 0, 2, 5)).toEqual({ blocked: true, message: "Header area" });
    expect(checkRangeGuards(5, 25, 10, 30)).toEqual({ blocked: true, message: "Beyond data range" });
    expect(checkRangeGuards(5, 5, 10, 10)).toBeNull();
  });
});

// ============================================================================
// Commit guard + edit guard interaction
// ============================================================================

describe("commit guard + edit guard interaction", () => {
  it("edit guard blocks before commit guard is ever checked", async () => {
    const commitCalled = vi.fn();

    reg(async () => ({ blocked: true, message: "Edit blocked" }));
    regCommit(async () => {
      commitCalled();
      return { action: "block" };
    });

    // In real app flow: check edit guard first
    const editResult = await checkEditGuards(0, 0);
    expect(editResult?.blocked).toBe(true);

    // If edit is blocked, commit guard is never called
    if (!editResult?.blocked) {
      await checkCommitGuards(0, 0, "value");
    }
    expect(commitCalled).not.toHaveBeenCalled();
  });

  it("when edit guard allows, commit guard can still block", async () => {
    reg(async () => null); // Allows editing
    regCommit(async (_row, _col, value) => {
      if (Number(value) < 0) return { action: "block" };
      return null;
    });

    const editResult = await checkEditGuards(0, 0);
    expect(editResult).toBeNull();

    const commitResult = await checkCommitGuards(0, 0, "-5");
    expect(commitResult).toEqual({ action: "block" });
  });

  it("commit guard retry keeps cell in edit mode", async () => {
    regCommit(async (_row, _col, value) => {
      if (value === "") return { action: "retry" };
      return null;
    });

    expect(await checkCommitGuards(0, 0, "")).toEqual({ action: "retry" });
    expect(await checkCommitGuards(0, 0, "valid")).toBeNull();
  });

  it("multiple commit guards - first non-allow wins", async () => {
    const order: string[] = [];
    regCommit(async () => { order.push("validation"); return null; });
    regCommit(async () => { order.push("protection"); return { action: "block" }; });
    regCommit(async () => { order.push("custom"); return { action: "retry" }; });

    const result = await checkCommitGuards(0, 0, "test");
    expect(result).toEqual({ action: "block" });
    expect(order).toEqual(["validation", "protection"]);
  });

  it("edit guards and commit guards use independent registries", async () => {
    let editCount = 0;
    let commitCount = 0;

    reg(async () => { editCount++; return null; });
    regCommit(async () => { commitCount++; return null; });

    await checkEditGuards(0, 0);
    expect(editCount).toBe(1);
    expect(commitCount).toBe(0);

    await checkCommitGuards(0, 0, "val");
    expect(editCount).toBe(1);
    expect(commitCount).toBe(1);
  });
});
