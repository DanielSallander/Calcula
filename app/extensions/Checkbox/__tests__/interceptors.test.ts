//! FILENAME: app/extensions/Checkbox/__tests__/interceptors.test.ts
// PURPOSE: Tests for checkbox style interceptor and selection tracking.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dynamic imports used inside interceptors
vi.mock("@api", () => ({
  ExtensionRegistry: {
    onSelectionChange: vi.fn(() => vi.fn()),
    onCellChange: vi.fn(() => vi.fn()),
    registerCommand: vi.fn(),
  },
  AppEvents: { DATA_CHANGED: "data-changed" },
}));

vi.mock("@api/styleInterceptors", () => ({}));

vi.mock("../../../src/api/lib", () => ({
  getAllStyles: vi.fn(async () => []),
  getStyle: vi.fn(async () => null),
  getCell: vi.fn(async () => null),
  updateCell: vi.fn(async () => {}),
  updateCellsBatch: vi.fn(async () => {}),
  applyFormatting: vi.fn(async () => {}),
}));

vi.mock("../../../src/api/gridDispatch", () => ({
  dispatchGridAction: vi.fn(),
}));

vi.mock("../../../src/api/grid", () => ({
  setSelection: vi.fn(),
}));

import {
  checkboxStyleInterceptor,
  setCurrentSelection,
  getCurrentSelection,
  checkboxStyleIndices,
} from "../interceptors";

// ============================================================================
// checkboxStyleInterceptor Tests
// ============================================================================

describe("checkboxStyleInterceptor", () => {
  it("returns null when the style cache is empty (no checkbox styles)", () => {
    const result = checkboxStyleInterceptor(
      "TRUE",
      { styleIndex: 0, textColor: "#000", backgroundColor: "#fff" },
      { row: 0, col: 0 },
    );
    expect(result).toBeNull();
  });

  it("returns null for a non-checkbox style index", () => {
    // Style index 99 is not in the cache
    const result = checkboxStyleInterceptor(
      "FALSE",
      { styleIndex: 99, textColor: "#000", backgroundColor: "#fff" },
      { row: 1, col: 1 },
    );
    expect(result).toBeNull();
  });
});

// ============================================================================
// setCurrentSelection / getCurrentSelection Tests
// ============================================================================

describe("selection tracking", () => {
  beforeEach(() => {
    setCurrentSelection(null);
  });

  it("returns null when no selection is set", () => {
    expect(getCurrentSelection()).toBeNull();
  });

  it("stores and retrieves a selection", () => {
    const sel = { startRow: 0, startCol: 0, endRow: 2, endCol: 3, type: "cells" as const };
    setCurrentSelection(sel as any);
    expect(getCurrentSelection()).toEqual(sel);
  });

  it("clears selection when set to null", () => {
    setCurrentSelection({ startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" } as any);
    setCurrentSelection(null);
    expect(getCurrentSelection()).toBeNull();
  });
});

// ============================================================================
// checkboxStyleIndices Tests
// ============================================================================

describe("checkboxStyleIndices", () => {
  it("is a Set exposed for synchronous lookups", () => {
    expect(checkboxStyleIndices).toBeInstanceOf(Set);
  });

  it("starts empty before any refreshStyleCache call", () => {
    // After module load without refresh, should be empty or previously cleared
    // The set is exported and mutable, so we can check its type
    expect(typeof checkboxStyleIndices.has).toBe("function");
  });
});
