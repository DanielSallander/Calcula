//! FILENAME: app/extensions/SelectVisibleCells/__tests__/selectVisibleCells.test.ts
// PURPOSE: Tests for visible cell selection logic (band/span computation).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockDispatchGridAction = vi.fn();
const mockSetSelection = vi.fn().mockImplementation((sel) => ({ type: "SET_SELECTION", payload: sel }));
const mockShowToast = vi.fn();

vi.mock("@api", () => ({
  registerMenuItem: vi.fn(),
  dispatchGridAction: (...args: unknown[]) => mockDispatchGridAction(...args),
  setSelection: (sel: unknown) => mockSetSelection(sel),
  showToast: (...args: unknown[]) => mockShowToast(...args),
  IconSelectVisibleCells: "icon-select-visible",
}));

let mockGridState: ReturnType<typeof makeGridState> | null = null;

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => mockGridState,
}));

// We need to test the selectVisibleCells function. Since it's not exported
// directly, we test via the extension's activate which registers a menu item.
// We'll capture the action callback from registerMenuItem.

import type { ExtensionContext } from "@api/contract";

// ============================================================================
// Test Helpers
// ============================================================================

function makeGridState(overrides: Record<string, unknown> = {}) {
  return {
    selection: {
      startRow: 0,
      startCol: 0,
      endRow: 9,
      endCol: 4,
    },
    dimensions: {
      hiddenRows: new Set<number>(),
      hiddenCols: new Set<number>(),
    },
    ...overrides,
  };
}

// Import the extension module to get access to activate
import extension from "../index";

let selectVisibleCellsFn: (() => void) | null = null;

describe("SelectVisibleCells", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGridState = makeGridState();

    // Capture the action function from registerMenuItem
    const { registerMenuItem } = await import("@api");
    const registerMenuItemMock = vi.mocked(registerMenuItem);
    registerMenuItemMock.mockClear();

    // Activate extension to register the menu item
    extension.activate({} as ExtensionContext);

    // Extract the action callback
    const call = registerMenuItemMock.mock.calls.find(
      (c) => (c[1] as { id: string }).id === "edit:selectVisibleCells",
    );
    if (call) {
      selectVisibleCellsFn = (call[1] as { action: () => void }).action;
    }
  });

  it("registers a menu item with correct id", async () => {
    const { registerMenuItem } = await import("@api");
    expect(registerMenuItem).toHaveBeenCalledWith(
      "edit",
      expect.objectContaining({
        id: "edit:selectVisibleCells",
        label: "Select Visible Cells",
        shortcut: "Alt+;",
      }),
    );
  });

  it("shows warning toast when no selection exists", () => {
    mockGridState = null;
    selectVisibleCellsFn!();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No selection", type: "warning" }),
    );
  });

  it("selects all cells when no rows/cols are hidden", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
    });

    selectVisibleCellsFn!();

    expect(mockDispatchGridAction).toHaveBeenCalled();
    const selAction = mockSetSelection.mock.calls[0][0];
    expect(selAction.startRow).toBe(0);
    expect(selAction.startCol).toBe(0);
    expect(selAction.endRow).toBe(3);
    expect(selAction.endCol).toBe(2);
    // No additional ranges needed since all cells are visible
    expect(selAction.additionalRanges).toBeUndefined();
  });

  it("splits into row bands when rows are hidden", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 5, endCol: 1 },
      dimensions: {
        hiddenRows: new Set([2, 3]),
        hiddenCols: new Set<number>(),
      },
    });

    selectVisibleCellsFn!();

    const selAction = mockSetSelection.mock.calls[0][0];
    // Should produce: rows 0-1 (band 1) and rows 4-5 (band 2)
    // Primary: 0-1, cols 0-1
    expect(selAction.startRow).toBe(0);
    expect(selAction.endRow).toBe(1);
    // Additional: 4-5, cols 0-1
    expect(selAction.additionalRanges).toHaveLength(1);
    expect(selAction.additionalRanges[0]).toEqual({
      startRow: 4, startCol: 0, endRow: 5, endCol: 1,
    });
  });

  it("splits into column spans when columns are hidden", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 1, endCol: 4 },
      dimensions: {
        hiddenRows: new Set<number>(),
        hiddenCols: new Set([2]),
      },
    });

    selectVisibleCellsFn!();

    const selAction = mockSetSelection.mock.calls[0][0];
    // Cols 0-1 (span 1) and cols 3-4 (span 2), rows 0-1
    expect(selAction.startCol).toBe(0);
    expect(selAction.endCol).toBe(1);
    expect(selAction.additionalRanges).toHaveLength(1);
    expect(selAction.additionalRanges[0]).toEqual({
      startRow: 0, startCol: 3, endRow: 1, endCol: 4,
    });
  });

  it("creates cross-product of row bands x col spans", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 4, endCol: 4 },
      dimensions: {
        hiddenRows: new Set([2]),
        hiddenCols: new Set([2]),
      },
    });

    selectVisibleCellsFn!();

    const selAction = mockSetSelection.mock.calls[0][0];
    // 2 row bands (0-1, 3-4) x 2 col spans (0-1, 3-4) = 4 ranges
    // Primary = first, additionalRanges = 3
    expect(selAction.additionalRanges).toHaveLength(3);
  });

  it("shows info toast when all cells are hidden", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
      dimensions: {
        hiddenRows: new Set([0, 1]),
        hiddenCols: new Set<number>(),
      },
    });

    selectVisibleCellsFn!();

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No visible cells in selection", type: "info" }),
    );
    expect(mockDispatchGridAction).not.toHaveBeenCalled();
  });

  it("shows info toast when visible < total", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 3, endCol: 0 },
      dimensions: {
        hiddenRows: new Set([1]),
        hiddenCols: new Set<number>(),
      },
    });

    selectVisibleCellsFn!();

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("3 visible cell(s)"),
        type: "info",
      }),
    );
  });

  it("does not show toast when all cells are visible", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
    });

    selectVisibleCellsFn!();

    // showToast should NOT be called (all visible)
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("handles reversed selection coordinates", () => {
    mockGridState = makeGridState({
      selection: { startRow: 5, startCol: 3, endRow: 0, endCol: 0 },
      dimensions: {
        hiddenRows: new Set([2]),
        hiddenCols: new Set<number>(),
      },
    });

    selectVisibleCellsFn!();

    // Should normalize to min/max and still work
    expect(mockDispatchGridAction).toHaveBeenCalled();
    const selAction = mockSetSelection.mock.calls[0][0];
    expect(selAction.startRow).toBe(0);
    expect(selAction.additionalRanges).toHaveLength(1);
  });

  it("handles single hidden row at start", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 3, endCol: 0 },
      dimensions: {
        hiddenRows: new Set([0]),
        hiddenCols: new Set<number>(),
      },
    });

    selectVisibleCellsFn!();

    const selAction = mockSetSelection.mock.calls[0][0];
    // Only one band: rows 1-3
    expect(selAction.startRow).toBe(1);
    expect(selAction.endRow).toBe(3);
    expect(selAction.additionalRanges).toBeUndefined();
  });

  it("handles multiple consecutive hidden rows", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 7, endCol: 0 },
      dimensions: {
        hiddenRows: new Set([2, 3, 4]),
        hiddenCols: new Set<number>(),
      },
    });

    selectVisibleCellsFn!();

    const selAction = mockSetSelection.mock.calls[0][0];
    // Band 1: 0-1, Band 2: 5-7
    expect(selAction.startRow).toBe(0);
    expect(selAction.endRow).toBe(1);
    expect(selAction.additionalRanges).toHaveLength(1);
    expect(selAction.additionalRanges[0].startRow).toBe(5);
    expect(selAction.additionalRanges[0].endRow).toBe(7);
  });
});
