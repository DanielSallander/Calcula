//! FILENAME: app/src/core/lib/__tests__/cellContextMenuInterceptors.test.ts
// PURPOSE: Tests for the cell context-menu (right-click) interceptor registry —
//          the Wave-4 twin of cellDoubleClickInterceptors, gating the grid's
//          context menu instead of edit-mode entry.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerCellContextMenuInterceptor,
  checkCellContextMenuInterceptors,
  cellContextMenuInterceptorCount,
  type CellContextMenuInterceptorFn,
  type CellContextMenuEvent,
} from "../cellContextMenuInterceptors";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];
const evt: CellContextMenuEvent = { clientX: 100, clientY: 200 };

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

// ============================================================================
// Tests
// ============================================================================

describe("registerCellContextMenuInterceptor", () => {
  it("returns a cleanup function that unregisters the interceptor", async () => {
    const cleanup = registerCellContextMenuInterceptor(async () => true);

    expect(await checkCellContextMenuInterceptors(0, 0, evt)).toBe(true);

    cleanup();
    expect(await checkCellContextMenuInterceptors(0, 0, evt)).toBe(false);
  });

  it("counts registrations — the grid's fast-path check", () => {
    expect(cellContextMenuInterceptorCount()).toBe(0);
    const cleanup = registerCellContextMenuInterceptor(async () => false);
    cleanups.push(cleanup);
    expect(cellContextMenuInterceptorCount()).toBe(1);
    cleanup();
    expect(cellContextMenuInterceptorCount()).toBe(0);
  });
});

describe("checkCellContextMenuInterceptors", () => {
  it("returns false when no interceptors are registered", async () => {
    expect(await checkCellContextMenuInterceptors(0, 0, evt)).toBe(false);
  });

  it("returns false when all interceptors return false", async () => {
    cleanups.push(registerCellContextMenuInterceptor(async () => false));
    cleanups.push(registerCellContextMenuInterceptor(async () => false));
    expect(await checkCellContextMenuInterceptors(0, 0, evt)).toBe(false);
  });

  it("returns true (suppress the menu) when any interceptor returns true", async () => {
    cleanups.push(registerCellContextMenuInterceptor(async () => false));
    cleanups.push(registerCellContextMenuInterceptor(async () => true));
    expect(await checkCellContextMenuInterceptors(1, 2, evt)).toBe(true);
  });

  it("stops at the first true result", async () => {
    const later = vi.fn<CellContextMenuInterceptorFn>(async () => false);
    cleanups.push(registerCellContextMenuInterceptor(async () => true));
    cleanups.push(registerCellContextMenuInterceptor(later));

    await checkCellContextMenuInterceptors(0, 0, evt);
    expect(later).not.toHaveBeenCalled();
  });

  it("passes row, col, and event to the interceptor", async () => {
    const spy = vi.fn<CellContextMenuInterceptorFn>(async () => false);
    cleanups.push(registerCellContextMenuInterceptor(spy));

    const rcEvt: CellContextMenuEvent = { clientX: 42, clientY: 99 };
    await checkCellContextMenuInterceptors(5, 8, rcEvt);
    expect(spy).toHaveBeenCalledWith(5, 8, rcEvt);
  });

  it("a throwing interceptor is skipped — it must never eat the user's menu", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(
      registerCellContextMenuInterceptor(async () => {
        throw new Error("boom");
      })
    );
    cleanups.push(registerCellContextMenuInterceptor(async () => false));

    expect(await checkCellContextMenuInterceptors(0, 0, evt)).toBe(false);
    consoleSpy.mockRestore();
  });
});
