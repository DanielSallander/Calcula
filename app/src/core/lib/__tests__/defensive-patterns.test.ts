//! FILENAME: app/src/core/lib/__tests__/defensive-patterns.test.ts
// PURPOSE: Verify defensive coding patterns hold across core registries.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerCommitGuard,
  checkCommitGuards,
  type CommitGuardFn,
} from "../commitGuards";
import {
  registerEditGuard,
  checkEditGuards,
  registerRangeGuard,
  checkRangeGuards,
  type EditGuardFn,
  type RangeGuardFn,
} from "../editGuards";
import {
  registerCellClickInterceptor,
  checkCellClickInterceptors,
  registerCellCursorInterceptor,
  getCellCursorOverride,
  type CellClickInterceptorFn,
  type CellCursorInterceptorFn,
} from "../cellClickInterceptors";
import {
  registerCellDoubleClickInterceptor,
  checkCellDoubleClickInterceptors,
  type CellDoubleClickInterceptorFn,
} from "../cellDoubleClickInterceptors";
import {
  registerFormulaReferenceInterceptor,
  checkFormulaReferenceInterceptors,
  type FormulaReferenceInterceptorFn,
} from "../formulaReferenceInterceptors";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];

function track(fn: () => void) {
  cleanups.push(fn);
}

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

const clickEvent = { clientX: 0, clientY: 0 };
const dblClickEvent = { clientX: 0, clientY: 0 };

// ============================================================================
// 1. All registry functions return unsubscribe functions
// ============================================================================

describe("registry functions return unsubscribe", () => {
  it("registerCommitGuard returns a function", () => {
    const unsub = registerCommitGuard(async () => null);
    expect(typeof unsub).toBe("function");
    track(unsub);
  });

  it("registerEditGuard returns a function", () => {
    const unsub = registerEditGuard(async () => null);
    expect(typeof unsub).toBe("function");
    track(unsub);
  });

  it("registerRangeGuard returns a function", () => {
    const unsub = registerRangeGuard(() => null);
    expect(typeof unsub).toBe("function");
    track(unsub);
  });

  it("registerCellClickInterceptor returns a function", () => {
    const unsub = registerCellClickInterceptor(async () => false);
    expect(typeof unsub).toBe("function");
    track(unsub);
  });

  it("registerCellCursorInterceptor returns a function", () => {
    const unsub = registerCellCursorInterceptor(() => null);
    expect(typeof unsub).toBe("function");
    track(unsub);
  });

  it("registerCellDoubleClickInterceptor returns a function", () => {
    const unsub = registerCellDoubleClickInterceptor(async () => false);
    expect(typeof unsub).toBe("function");
    track(unsub);
  });

  it("registerFormulaReferenceInterceptor returns a function", () => {
    const unsub = registerFormulaReferenceInterceptor(async () => null);
    expect(typeof unsub).toBe("function");
    track(unsub);
  });
});

// ============================================================================
// 2. Unsubscribe functions are idempotent
// ============================================================================

describe("unsubscribe is idempotent", () => {
  it("commitGuard unsubscribe can be called multiple times", async () => {
    const guard: CommitGuardFn = async () => ({ action: "block" });
    const unsub = registerCommitGuard(guard);
    unsub();
    unsub(); // second call should not throw
    unsub(); // third call should not throw
    const result = await checkCommitGuards(0, 0, "x");
    expect(result).toBeNull();
  });

  it("editGuard unsubscribe can be called multiple times", async () => {
    const guard: EditGuardFn = async () => ({ blocked: true });
    const unsub = registerEditGuard(guard);
    unsub();
    unsub();
    const result = await checkEditGuards(0, 0);
    expect(result).toBeNull();
  });

  it("rangeGuard unsubscribe can be called multiple times", () => {
    const guard: RangeGuardFn = () => ({ blocked: true });
    const unsub = registerRangeGuard(guard);
    unsub();
    unsub();
    const result = checkRangeGuards(0, 0, 5, 5);
    expect(result).toBeNull();
  });

  it("clickInterceptor unsubscribe can be called multiple times", async () => {
    const fn: CellClickInterceptorFn = async () => true;
    const unsub = registerCellClickInterceptor(fn);
    unsub();
    unsub();
    const result = await checkCellClickInterceptors(0, 0, clickEvent);
    expect(result).toBe(false);
  });

  it("cursorInterceptor unsubscribe can be called multiple times", () => {
    const fn: CellCursorInterceptorFn = () => "pointer";
    const unsub = registerCellCursorInterceptor(fn);
    unsub();
    unsub();
    expect(getCellCursorOverride(0, 0)).toBeNull();
  });

  it("doubleClickInterceptor unsubscribe can be called multiple times", async () => {
    const fn: CellDoubleClickInterceptorFn = async () => true;
    const unsub = registerCellDoubleClickInterceptor(fn);
    unsub();
    unsub();
    const result = await checkCellDoubleClickInterceptors(0, 0, dblClickEvent);
    expect(result).toBe(false);
  });

  it("formulaReferenceInterceptor unsubscribe can be called multiple times", async () => {
    const fn: FormulaReferenceInterceptorFn = async () => ({
      text: "=A1",
      highlightRow: 0,
      highlightCol: 0,
    });
    const unsub = registerFormulaReferenceInterceptor(fn);
    unsub();
    unsub();
    const result = await checkFormulaReferenceInterceptors(0, 0);
    expect(result).toBeNull();
  });
});

// ============================================================================
// 3. Registries handle concurrent modification (add during iteration)
// ============================================================================

describe("registries handle concurrent modification", () => {
  it("commitGuard: registering during check does not crash", async () => {
    const innerGuard: CommitGuardFn = async () => ({ action: "block" });
    const outerGuard: CommitGuardFn = async () => {
      track(registerCommitGuard(innerGuard));
      return null;
    };
    track(registerCommitGuard(outerGuard));
    // Should not throw even though iteration is modified.
    // The inner guard may fire (Set allows additions during iteration),
    // so the result can be either null or block.
    const result = await checkCommitGuards(0, 0, "x");
    expect(result === null || result?.action === "block").toBe(true);
  });

  it("editGuard: registering during check does not crash", async () => {
    const innerGuard: EditGuardFn = async () => ({ blocked: true });
    const outerGuard: EditGuardFn = async () => {
      track(registerEditGuard(innerGuard));
      return null;
    };
    track(registerEditGuard(outerGuard));
    const result = await checkEditGuards(0, 0);
    // The inner guard may or may not fire depending on Set iteration order,
    // but it must not throw
    expect(result === null || result?.blocked === true).toBe(true);
  });

  it("clickInterceptor: unsubscribing during check does not crash", async () => {
    let unsub: (() => void) | null = null;
    const fn: CellClickInterceptorFn = async () => {
      unsub?.();
      return false;
    };
    unsub = registerCellClickInterceptor(fn);
    track(unsub);
    // Should not throw when the interceptor removes itself during iteration
    const result = await checkCellClickInterceptors(0, 0, clickEvent);
    expect(typeof result).toBe("boolean");
  });
});

// ============================================================================
// 4. No function mutates its input arguments
// ============================================================================

describe("no input mutation", () => {
  it("checkCommitGuards does not mutate the value string", async () => {
    const value = "hello";
    const guard: CommitGuardFn = async (_r, _c, v) => {
      // Guard receives the value but should not be able to mutate caller's reference
      expect(v).toBe(value);
      return null;
    };
    track(registerCommitGuard(guard));
    await checkCommitGuards(0, 0, value);
    expect(value).toBe("hello");
  });

  it("checkCellClickInterceptors does not mutate the event object", async () => {
    const event = Object.freeze({ clientX: 10, clientY: 20 });
    const fn: CellClickInterceptorFn = async (_r, _c, e) => {
      // Attempting to mutate a frozen object would throw
      expect(() => {
        (e as any).clientX = 999;
      }).toThrow();
      return false;
    };
    track(registerCellClickInterceptor(fn));
    await checkCellClickInterceptors(0, 0, event);
    expect(event.clientX).toBe(10);
  });

  it("checkCellDoubleClickInterceptors does not mutate the event object", async () => {
    const event = Object.freeze({ clientX: 10, clientY: 20 });
    const fn: CellDoubleClickInterceptorFn = async (_r, _c, e) => {
      expect(() => {
        (e as any).clientX = 999;
      }).toThrow();
      return false;
    };
    track(registerCellDoubleClickInterceptor(fn));
    await checkCellDoubleClickInterceptors(0, 0, event);
    expect(event.clientX).toBe(10);
  });
});

// ============================================================================
// 5. All public async functions reject rather than throwing synchronously
// ============================================================================

describe("async functions reject rather than throwing synchronously", () => {
  it("checkCommitGuards rejects on guard error, not sync throw", async () => {
    const badGuard: CommitGuardFn = async () => {
      throw new Error("boom");
    };
    track(registerCommitGuard(badGuard));
    // The function should catch the error internally and return null (not rethrow)
    const result = await checkCommitGuards(0, 0, "x");
    expect(result).toBeNull();
  });

  it("checkEditGuards catches guard errors gracefully", async () => {
    const badGuard: EditGuardFn = async () => {
      throw new Error("boom");
    };
    track(registerEditGuard(badGuard));
    const result = await checkEditGuards(0, 0);
    expect(result).toBeNull();
  });

  it("checkCellClickInterceptors catches interceptor errors gracefully", async () => {
    const badFn: CellClickInterceptorFn = async () => {
      throw new Error("boom");
    };
    track(registerCellClickInterceptor(badFn));
    const result = await checkCellClickInterceptors(0, 0, clickEvent);
    expect(result).toBe(false);
  });

  it("checkCellDoubleClickInterceptors catches errors gracefully", async () => {
    const badFn: CellDoubleClickInterceptorFn = async () => {
      throw new Error("boom");
    };
    track(registerCellDoubleClickInterceptor(badFn));
    const result = await checkCellDoubleClickInterceptors(0, 0, dblClickEvent);
    expect(result).toBe(false);
  });

  it("checkFormulaReferenceInterceptors catches errors gracefully", async () => {
    const badFn: FormulaReferenceInterceptorFn = async () => {
      throw new Error("boom");
    };
    track(registerFormulaReferenceInterceptor(badFn));
    const result = await checkFormulaReferenceInterceptors(0, 0);
    expect(result).toBeNull();
  });

  it("getCellCursorOverride catches sync errors gracefully", () => {
    const badFn: CellCursorInterceptorFn = () => {
      throw new Error("boom");
    };
    track(registerCellCursorInterceptor(badFn));
    const result = getCellCursorOverride(0, 0);
    expect(result).toBeNull();
  });

  it("checkRangeGuards catches sync errors gracefully", () => {
    const badGuard: RangeGuardFn = () => {
      throw new Error("boom");
    };
    track(registerRangeGuard(badGuard));
    const result = checkRangeGuards(0, 0, 5, 5);
    expect(result).toBeNull();
  });
});
