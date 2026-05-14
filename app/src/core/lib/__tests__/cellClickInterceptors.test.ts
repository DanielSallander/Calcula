//! FILENAME: app/src/core/lib/__tests__/cellClickInterceptors.test.ts
// PURPOSE: Tests for cell click and cursor interceptor registries.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerCellClickInterceptor,
  checkCellClickInterceptors,
  registerCellCursorInterceptor,
  getCellCursorOverride,
  type CellClickInterceptorFn,
  type CellClickEvent,
  type CellCursorInterceptorFn,
} from "../cellClickInterceptors";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];
const evt: CellClickEvent = { clientX: 100, clientY: 200 };

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

// ============================================================================
// Cell Click Interceptors
// ============================================================================

describe("registerCellClickInterceptor", () => {
  it("returns a cleanup function that unregisters the interceptor", async () => {
    const cleanup = registerCellClickInterceptor(async () => true);

    expect(await checkCellClickInterceptors(0, 0, evt)).toBe(true);

    cleanup();
    expect(await checkCellClickInterceptors(0, 0, evt)).toBe(false);
  });
});

describe("checkCellClickInterceptors", () => {
  it("returns false when no interceptors are registered", async () => {
    expect(await checkCellClickInterceptors(0, 0, evt)).toBe(false);
  });

  it("returns false when all interceptors return false", async () => {
    cleanups.push(registerCellClickInterceptor(async () => false));
    cleanups.push(registerCellClickInterceptor(async () => false));
    expect(await checkCellClickInterceptors(0, 0, evt)).toBe(false);
  });

  it("returns true when any interceptor returns true", async () => {
    cleanups.push(registerCellClickInterceptor(async () => false));
    cleanups.push(registerCellClickInterceptor(async () => true));
    expect(await checkCellClickInterceptors(1, 2, evt)).toBe(true);
  });

  it("stops at first true result", async () => {
    const later = vi.fn<CellClickInterceptorFn>(async () => false);
    cleanups.push(registerCellClickInterceptor(async () => true));
    cleanups.push(registerCellClickInterceptor(later));

    await checkCellClickInterceptors(0, 0, evt);
    expect(later).not.toHaveBeenCalled();
  });

  it("passes row, col, and event to the interceptor", async () => {
    const spy = vi.fn<CellClickInterceptorFn>(async () => false);
    cleanups.push(registerCellClickInterceptor(spy));

    const clickEvt: CellClickEvent = {
      clientX: 50,
      clientY: 75,
      ctrlKey: true,
    };
    await checkCellClickInterceptors(3, 7, clickEvt);
    expect(spy).toHaveBeenCalledWith(3, 7, clickEvt);
  });

  it("catches errors in interceptors and continues", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(
      registerCellClickInterceptor(async () => {
        throw new Error("boom");
      })
    );
    cleanups.push(registerCellClickInterceptor(async () => true));

    expect(await checkCellClickInterceptors(0, 0, evt)).toBe(true);
    consoleSpy.mockRestore();
  });
});

// ============================================================================
// Cell Cursor Interceptors
// ============================================================================

describe("registerCellCursorInterceptor", () => {
  it("returns a cleanup function that unregisters the interceptor", () => {
    const cleanup = registerCellCursorInterceptor(() => "pointer");
    expect(getCellCursorOverride(0, 0)).toBe("pointer");

    cleanup();
    expect(getCellCursorOverride(0, 0)).toBeNull();
  });
});

describe("getCellCursorOverride", () => {
  it("returns null when no interceptors are registered", () => {
    expect(getCellCursorOverride(0, 0)).toBeNull();
  });

  it("returns null when all interceptors return null", () => {
    cleanups.push(registerCellCursorInterceptor(() => null));
    expect(getCellCursorOverride(0, 0)).toBeNull();
  });

  it("returns the first non-null cursor", () => {
    cleanups.push(registerCellCursorInterceptor(() => null));
    cleanups.push(registerCellCursorInterceptor(() => "crosshair"));
    cleanups.push(registerCellCursorInterceptor(() => "pointer"));

    expect(getCellCursorOverride(0, 0)).toBe("crosshair");
  });

  it("passes row and col to the interceptor", () => {
    const spy = vi.fn<CellCursorInterceptorFn>(() => null);
    cleanups.push(registerCellCursorInterceptor(spy));
    getCellCursorOverride(4, 9);
    expect(spy).toHaveBeenCalledWith(4, 9);
  });

  it("catches errors and continues", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(
      registerCellCursorInterceptor(() => {
        throw new Error("fail");
      })
    );
    cleanups.push(registerCellCursorInterceptor(() => "grab"));

    expect(getCellCursorOverride(0, 0)).toBe("grab");
    consoleSpy.mockRestore();
  });

  it("is synchronous", () => {
    const result = getCellCursorOverride(0, 0);
    expect(result).not.toBeInstanceOf(Promise);
  });
});
