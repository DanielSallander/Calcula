//! FILENAME: app/src/core/lib/__tests__/formulaReferenceInterceptors.test.ts
// PURPOSE: Tests for the formula reference interceptor registry.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerFormulaReferenceInterceptor,
  checkFormulaReferenceInterceptors,
  type FormulaReferenceInterceptorFn,
  type FormulaReferenceOverride,
} from "../formulaReferenceInterceptors";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];

function override(text: string): FormulaReferenceOverride {
  return { text, highlightRow: 0, highlightCol: 0 };
}

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

// ============================================================================
// Tests
// ============================================================================

describe("registerFormulaReferenceInterceptor", () => {
  it("returns a cleanup function that unregisters the interceptor", async () => {
    const cleanup = registerFormulaReferenceInterceptor(async () =>
      override("GETPIVOTDATA(...)")
    );

    const result = await checkFormulaReferenceInterceptors(0, 0);
    expect(result).toEqual(override("GETPIVOTDATA(...)"));

    cleanup();
    expect(await checkFormulaReferenceInterceptors(0, 0)).toBeNull();
  });
});

describe("checkFormulaReferenceInterceptors", () => {
  it("returns null when no interceptors are registered", async () => {
    expect(await checkFormulaReferenceInterceptors(0, 0)).toBeNull();
  });

  it("returns null when all interceptors return null", async () => {
    cleanups.push(registerFormulaReferenceInterceptor(async () => null));
    cleanups.push(registerFormulaReferenceInterceptor(async () => null));
    expect(await checkFormulaReferenceInterceptors(0, 0)).toBeNull();
  });

  it("returns the first non-null override", async () => {
    cleanups.push(registerFormulaReferenceInterceptor(async () => null));
    cleanups.push(
      registerFormulaReferenceInterceptor(async () => ({
        text: "FIRST",
        highlightRow: 1,
        highlightCol: 2,
      }))
    );
    cleanups.push(
      registerFormulaReferenceInterceptor(async () => ({
        text: "SECOND",
        highlightRow: 3,
        highlightCol: 4,
      }))
    );

    const result = await checkFormulaReferenceInterceptors(5, 10);
    expect(result).toEqual({ text: "FIRST", highlightRow: 1, highlightCol: 2 });
  });

  it("stops at first non-null result", async () => {
    const later = vi.fn<FormulaReferenceInterceptorFn>(async () => null);
    cleanups.push(
      registerFormulaReferenceInterceptor(async () => override("X"))
    );
    cleanups.push(registerFormulaReferenceInterceptor(later));

    await checkFormulaReferenceInterceptors(0, 0);
    expect(later).not.toHaveBeenCalled();
  });

  it("passes row and col to the interceptor", async () => {
    const spy = vi.fn<FormulaReferenceInterceptorFn>(async () => null);
    cleanups.push(registerFormulaReferenceInterceptor(spy));

    await checkFormulaReferenceInterceptors(12, 34);
    expect(spy).toHaveBeenCalledWith(12, 34);
  });

  it("catches errors in interceptors and continues", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(
      registerFormulaReferenceInterceptor(async () => {
        throw new Error("boom");
      })
    );
    cleanups.push(
      registerFormulaReferenceInterceptor(async () => override("OK"))
    );

    const result = await checkFormulaReferenceInterceptors(0, 0);
    expect(result).toEqual(override("OK"));
    consoleSpy.mockRestore();
  });
});
