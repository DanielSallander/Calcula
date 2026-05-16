//! FILENAME: app/src/core/lib/__tests__/interceptor-interactions.test.ts
// PURPOSE: Tests for interactions between multiple interceptor systems and extensions.

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
import {
  registerCellDoubleClickInterceptor,
  checkCellDoubleClickInterceptors,
  type CellDoubleClickInterceptorFn,
} from "../cellDoubleClickInterceptors";
import {
  registerStyleInterceptor,
  applyStyleInterceptors,
  getStyleInterceptors,
  hasStyleInterceptors,
  type BaseStyleInfo,
} from "../../../../src/api/styleInterceptors";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

function regClick(fn: CellClickInterceptorFn): void {
  cleanups.push(registerCellClickInterceptor(fn));
}

function regDblClick(fn: CellDoubleClickInterceptorFn): void {
  cleanups.push(registerCellDoubleClickInterceptor(fn));
}

function regCursor(fn: CellCursorInterceptorFn): void {
  cleanups.push(registerCellCursorInterceptor(fn));
}

function regStyle(id: string, fn: Parameters<typeof registerStyleInterceptor>[1], priority?: number): void {
  cleanups.push(registerStyleInterceptor(id, fn, priority));
}

const baseStyle: BaseStyleInfo = { styleIndex: 0 };
const clickEvent: CellClickEvent = { clientX: 100, clientY: 100 };
const dblClickEvent = { clientX: 100, clientY: 100 };

// ============================================================================
// Click interceptor from Checkbox + custom interceptor
// ============================================================================

describe("click interceptors from multiple extensions", () => {
  it("Checkbox interceptor handles checkbox cells, custom handles others", async () => {
    const checkboxCells = new Set(["1,0", "2,0", "3,0"]);

    // Checkbox extension interceptor
    regClick(async (row, col) => {
      if (checkboxCells.has(`${row},${col}`)) return true;
      return false;
    });
    // Custom interceptor for hyperlinks
    regClick(async (row, col) => {
      if (row === 5 && col === 2) return true;
      return false;
    });

    expect(await checkCellClickInterceptors(1, 0, clickEvent)).toBe(true);
    expect(await checkCellClickInterceptors(5, 2, clickEvent)).toBe(true);
    expect(await checkCellClickInterceptors(9, 9, clickEvent)).toBe(false);
  });

  it("first interceptor returning true short-circuits", async () => {
    const secondCalled = vi.fn();

    regClick(async () => true);
    regClick(async () => { secondCalled(); return true; });

    await checkCellClickInterceptors(0, 0, clickEvent);
    expect(secondCalled).not.toHaveBeenCalled();
  });

  it("interceptor receiving event data can use ctrlKey", async () => {
    regClick(async (_r, _c, event) => {
      return !!event.ctrlKey;
    });

    expect(await checkCellClickInterceptors(0, 0, { ...clickEvent, ctrlKey: true })).toBe(true);
    expect(await checkCellClickInterceptors(0, 0, { ...clickEvent, ctrlKey: false })).toBe(false);
  });
});

// ============================================================================
// Double-click interceptor priority
// ============================================================================

describe("double-click interceptor priority", () => {
  it("first registered interceptor gets first chance", async () => {
    const order: string[] = [];

    regDblClick(async () => { order.push("A"); return false; });
    regDblClick(async () => { order.push("B"); return true; });
    regDblClick(async () => { order.push("C"); return true; });

    const result = await checkCellDoubleClickInterceptors(0, 0, dblClickEvent);
    expect(result).toBe(true);
    expect(order).toEqual(["A", "B"]);
  });

  it("no interceptor handling returns false (enters edit mode)", async () => {
    regDblClick(async () => false);
    regDblClick(async () => false);

    expect(await checkCellDoubleClickInterceptors(0, 0, dblClickEvent)).toBe(false);
  });
});

// ============================================================================
// Cursor interceptor returning different cursor types
// ============================================================================

describe("cursor interceptors", () => {
  it("returns pointer for checkbox cells", () => {
    regCursor((row, col) => {
      if (row >= 1 && row <= 5 && col === 0) return "pointer";
      return null;
    });

    expect(getCellCursorOverride(2, 0)).toBe("pointer");
    expect(getCellCursorOverride(0, 5)).toBeNull();
  });

  it("first non-null cursor wins", () => {
    regCursor(() => null);
    regCursor(() => "crosshair");
    regCursor(() => "pointer");

    expect(getCellCursorOverride(0, 0)).toBe("crosshair");
  });

  it("different cells get different cursors", () => {
    regCursor((row) => {
      if (row === 0) return "not-allowed";
      return null;
    });
    regCursor((_row, col) => {
      if (col === 0) return "pointer";
      return null;
    });

    expect(getCellCursorOverride(0, 0)).toBe("not-allowed");
    expect(getCellCursorOverride(5, 0)).toBe("pointer");
    expect(getCellCursorOverride(5, 5)).toBeNull();
  });

  it("throwing cursor interceptor is caught", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    regCursor(() => { throw new Error("Cursor error"); });
    regCursor(() => "help");

    expect(getCellCursorOverride(0, 0)).toBe("help");
    expect(consoleSpy).toHaveBeenCalledOnce();

    consoleSpy.mockRestore();
  });
});

// ============================================================================
// Interceptor that sometimes returns true, sometimes false
// ============================================================================

describe("conditional interceptor behavior", () => {
  it("interceptor toggles behavior based on state", async () => {
    let enabled = true;
    regClick(async () => enabled);

    expect(await checkCellClickInterceptors(0, 0, clickEvent)).toBe(true);
    enabled = false;
    expect(await checkCellClickInterceptors(0, 0, clickEvent)).toBe(false);
  });

  it("style interceptor conditionally applies", () => {
    regStyle("conditional", (cellValue) => {
      const num = Number(cellValue);
      if (num < 0) return { textColor: "red" };
      if (num > 100) return { textColor: "green" };
      return null;
    });

    const negative = applyStyleInterceptors("-5", baseStyle, { row: 0, col: 0 });
    expect(negative.textColor).toBe("red");

    const positive = applyStyleInterceptors("200", baseStyle, { row: 0, col: 0 });
    expect(positive.textColor).toBe("green");

    const normal = applyStyleInterceptors("50", baseStyle, { row: 0, col: 0 });
    expect(normal.textColor).toBeUndefined();
  });
});

// ============================================================================
// 10+ interceptors registered simultaneously
// ============================================================================

describe("10+ interceptors registered simultaneously", () => {
  it("all style interceptors accumulate changes in priority order", () => {
    for (let i = 0; i < 12; i++) {
      regStyle(`interceptor-${i}`, () => ({ fontSize: i + 10 }), i);
    }

    expect(getStyleInterceptors()).toHaveLength(12);

    // Last one (highest priority number = runs last) wins for fontSize
    const result = applyStyleInterceptors("x", baseStyle, { row: 0, col: 0 });
    expect(result.fontSize).toBe(21); // 11 + 10
  });

  it("all click interceptors are checked if none handles", async () => {
    let callCount = 0;
    for (let i = 0; i < 12; i++) {
      regClick(async () => { callCount++; return false; });
    }

    await checkCellClickInterceptors(0, 0, clickEvent);
    expect(callCount).toBe(12);
  });

  it("hasStyleInterceptors returns true with many interceptors", () => {
    for (let i = 0; i < 10; i++) {
      regStyle(`bulk-${i}`, () => null, i);
    }
    expect(hasStyleInterceptors()).toBe(true);
  });
});

// ============================================================================
// Style interceptor pipeline: Table + ConditionalFormatting + Bookmarks
// ============================================================================

describe("style interceptor pipeline", () => {
  it("interceptors compose: table sets bg, CF sets text color, bookmark adds border", () => {
    regStyle("table", (_val, _style, coords) => {
      if (coords.row % 2 === 0) return { backgroundColor: "#f0f0f0" };
      return null;
    }, 10);

    regStyle("cf", (cellValue) => {
      if (Number(cellValue) > 50) return { textColor: "#00ff00", bold: true };
      return null;
    }, 20);

    regStyle("bookmark", (_val, _style, coords) => {
      if (coords.row === 2 && coords.col === 3) return { borderLeftColor: "blue", borderLeftStyle: "solid" };
      return null;
    }, 30);

    const result = applyStyleInterceptors("75", baseStyle, { row: 2, col: 3 });
    expect(result.backgroundColor).toBe("#f0f0f0");
    expect(result.textColor).toBe("#00ff00");
    expect(result.bold).toBe(true);
    expect(result.borderLeftColor).toBe("blue");
  });

  it("higher priority interceptor can override lower priority", () => {
    regStyle("base-theme", () => ({ backgroundColor: "white" }), 0);
    regStyle("cf-override", () => ({ backgroundColor: "red" }), 100);

    const result = applyStyleInterceptors("x", baseStyle, { row: 0, col: 0 });
    expect(result.backgroundColor).toBe("red");
  });

  it("interceptor sees accumulated style from previous interceptors", () => {
    regStyle("first", () => ({ bold: true }), 0);
    regStyle("second", (_val, style) => {
      // Should see bold:true from first interceptor
      if (style.bold) return { italic: true };
      return null;
    }, 10);

    const result = applyStyleInterceptors("x", baseStyle, { row: 0, col: 0 });
    expect(result.bold).toBe(true);
    expect(result.italic).toBe(true);
  });

  it("throwing style interceptor does not break pipeline", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    regStyle("crasher", () => { throw new Error("Boom"); }, 0);
    regStyle("survivor", () => ({ textColor: "blue" }), 10);

    const result = applyStyleInterceptors("x", baseStyle, { row: 0, col: 0 });
    expect(result.textColor).toBe("blue");

    consoleSpy.mockRestore();
  });

  it("unregistering one style interceptor preserves others", () => {
    regStyle("keep-me", () => ({ bold: true }), 0);
    const cleanup = registerStyleInterceptor("remove-me", () => ({ italic: true }), 10);
    cleanups.push(cleanup);

    cleanup();

    const result = applyStyleInterceptors("x", baseStyle, { row: 0, col: 0 });
    expect(result.bold).toBe(true);
    expect(result.italic).toBeUndefined();
  });
});

// ============================================================================
// Interceptor performance
// ============================================================================

describe("interceptor performance", () => {
  it("100 style interceptor checks complete under 10ms", () => {
    regStyle("perf-test", (cellValue) => {
      if (Number(cellValue) > 50) return { backgroundColor: "yellow" };
      return null;
    });

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      applyStyleInterceptors(String(i), baseStyle, { row: i, col: 0 });
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(10);
  });

  it("100 cursor interceptor checks complete under 10ms", () => {
    regCursor((row) => row === 0 ? "pointer" : null);

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      getCellCursorOverride(i, 0);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(10);
  });
});
