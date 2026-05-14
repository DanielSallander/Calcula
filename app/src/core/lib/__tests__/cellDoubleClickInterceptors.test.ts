//! FILENAME: app/src/core/lib/__tests__/cellDoubleClickInterceptors.test.ts
// PURPOSE: Tests for the cell double-click interceptor registry.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerCellDoubleClickInterceptor,
  checkCellDoubleClickInterceptors,
  type CellDoubleClickInterceptorFn,
  type CellDoubleClickEvent,
} from "../cellDoubleClickInterceptors";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];
const evt: CellDoubleClickEvent = { clientX: 100, clientY: 200 };

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

// ============================================================================
// Tests
// ============================================================================

describe("registerCellDoubleClickInterceptor", () => {
  it("returns a cleanup function that unregisters the interceptor", async () => {
    const cleanup = registerCellDoubleClickInterceptor(async () => true);

    expect(await checkCellDoubleClickInterceptors(0, 0, evt)).toBe(true);

    cleanup();
    expect(await checkCellDoubleClickInterceptors(0, 0, evt)).toBe(false);
  });
});

describe("checkCellDoubleClickInterceptors", () => {
  it("returns false when no interceptors are registered", async () => {
    expect(await checkCellDoubleClickInterceptors(0, 0, evt)).toBe(false);
  });

  it("returns false when all interceptors return false", async () => {
    cleanups.push(registerCellDoubleClickInterceptor(async () => false));
    cleanups.push(registerCellDoubleClickInterceptor(async () => false));
    expect(await checkCellDoubleClickInterceptors(0, 0, evt)).toBe(false);
  });

  it("returns true when any interceptor returns true", async () => {
    cleanups.push(registerCellDoubleClickInterceptor(async () => false));
    cleanups.push(registerCellDoubleClickInterceptor(async () => true));
    expect(await checkCellDoubleClickInterceptors(1, 2, evt)).toBe(true);
  });

  it("stops at first true result", async () => {
    const later = vi.fn<CellDoubleClickInterceptorFn>(async () => false);
    cleanups.push(registerCellDoubleClickInterceptor(async () => true));
    cleanups.push(registerCellDoubleClickInterceptor(later));

    await checkCellDoubleClickInterceptors(0, 0, evt);
    expect(later).not.toHaveBeenCalled();
  });

  it("passes row, col, and event to the interceptor", async () => {
    const spy = vi.fn<CellDoubleClickInterceptorFn>(async () => false);
    cleanups.push(registerCellDoubleClickInterceptor(spy));

    const dblEvt: CellDoubleClickEvent = { clientX: 42, clientY: 99 };
    await checkCellDoubleClickInterceptors(5, 8, dblEvt);
    expect(spy).toHaveBeenCalledWith(5, 8, dblEvt);
  });

  it("catches errors in interceptors and continues", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(
      registerCellDoubleClickInterceptor(async () => {
        throw new Error("boom");
      })
    );
    cleanups.push(registerCellDoubleClickInterceptor(async () => true));

    expect(await checkCellDoubleClickInterceptors(0, 0, evt)).toBe(true);
    consoleSpy.mockRestore();
  });
});
