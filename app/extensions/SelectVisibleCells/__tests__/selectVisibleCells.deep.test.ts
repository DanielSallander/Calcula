//! FILENAME: app/extensions/SelectVisibleCells/__tests__/selectVisibleCells.deep.test.ts
// PURPOSE: Deep tests for visible cell selection - large ranges, edge cases, patterns.

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

import type { ExtensionContext } from "@api/contract";
import extension from "../index";

// ============================================================================
// Helpers
// ============================================================================

function makeGridState(overrides: Record<string, unknown> = {}) {
  return {
    selection: { startRow: 0, startCol: 0, endRow: 9, endCol: 4 },
    dimensions: {
      hiddenRows: new Set<number>(),
      hiddenCols: new Set<number>(),
    },
    ...overrides,
  };
}

let selectVisibleCellsFn: (() => void) | null = null;

function getSelAction() {
  return mockSetSelection.mock.calls[0][0];
}

/** Count total visible cells from primary + additional ranges */
function countVisibleCells(sel: {
  startRow: number; endRow: number; startCol: number; endCol: number;
  additionalRanges?: Array<{ startRow: number; endRow: number; startCol: number; endCol: number }>;
}): number {
  let total = (sel.endRow - sel.startRow + 1) * (sel.endCol - sel.startCol + 1);
  if (sel.additionalRanges) {
    for (const r of sel.additionalRanges) {
      total += (r.endRow - r.startRow + 1) * (r.endCol - r.startCol + 1);
    }
  }
  return total;
}

function totalRanges(sel: { additionalRanges?: unknown[] }): number {
  return 1 + (sel.additionalRanges?.length ?? 0);
}

// ============================================================================
// Tests
// ============================================================================

describe("SelectVisibleCells Deep", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGridState = makeGridState();

    const { registerMenuItem } = await import("@api");
    const registerMenuItemMock = vi.mocked(registerMenuItem);
    registerMenuItemMock.mockClear();

    extension.activate({} as ExtensionContext);

    const call = registerMenuItemMock.mock.calls.find(
      (c) => (c[1] as { id: string }).id === "edit:selectVisibleCells",
    );
    if (call) {
      selectVisibleCellsFn = (call[1] as { action: () => void }).action;
    }
  });

  // --------------------------------------------------------------------------
  // 100 hidden rows with visible gaps
  // --------------------------------------------------------------------------

  it("handles 100 hidden rows with gaps at rows 0, 50, 99", () => {
    const hidden = new Set<number>();
    for (let r = 0; r < 100; r++) {
      if (r !== 0 && r !== 50 && r !== 99) hidden.add(r);
    }
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 99, endCol: 0 },
      dimensions: { hiddenRows: hidden, hiddenCols: new Set<number>() },
    });

    selectVisibleCellsFn!();

    const sel = getSelAction();
    // 3 visible rows -> 3 bands (each a single row)
    expect(totalRanges(sel)).toBe(3);
    expect(countVisibleCells(sel)).toBe(3);
  });

  // --------------------------------------------------------------------------
  // Alternating (checkerboard) hidden/visible rows
  // --------------------------------------------------------------------------

  it("handles alternating hidden/visible rows (every other row hidden, 20 rows)", () => {
    const hidden = new Set<number>();
    for (let r = 0; r < 20; r++) {
      if (r % 2 === 1) hidden.add(r);
    }
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 19, endCol: 0 },
      dimensions: { hiddenRows: hidden, hiddenCols: new Set<number>() },
    });

    selectVisibleCellsFn!();

    const sel = getSelAction();
    // 10 visible rows, each isolated -> 10 bands
    expect(totalRanges(sel)).toBe(10);
    expect(countVisibleCells(sel)).toBe(10);
  });

  it("handles alternating hidden/visible columns (every other col hidden)", () => {
    const hiddenCols = new Set<number>();
    for (let c = 0; c < 10; c++) {
      if (c % 2 === 1) hiddenCols.add(c);
    }
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 9 },
      dimensions: { hiddenRows: new Set<number>(), hiddenCols },
    });

    selectVisibleCellsFn!();

    const sel = getSelAction();
    // 5 visible cols, each isolated -> 5 col spans x 1 row band = 5 ranges
    expect(totalRanges(sel)).toBe(5);
    expect(countVisibleCells(sel)).toBe(5);
  });

  // --------------------------------------------------------------------------
  // All rows hidden
  // --------------------------------------------------------------------------

  it("shows info toast when all rows in range are hidden", () => {
    const hidden = new Set<number>();
    for (let r = 0; r < 50; r++) hidden.add(r);
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 49, endCol: 2 },
      dimensions: { hiddenRows: hidden, hiddenCols: new Set<number>() },
    });

    selectVisibleCellsFn!();

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No visible cells in selection", type: "info" }),
    );
    expect(mockDispatchGridAction).not.toHaveBeenCalled();
  });

  it("shows info toast when all columns in range are hidden", () => {
    const hiddenCols = new Set<number>([0, 1, 2, 3, 4]);
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 5, endCol: 4 },
      dimensions: { hiddenRows: new Set<number>(), hiddenCols },
    });

    selectVisibleCellsFn!();

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No visible cells in selection" }),
    );
  });

  // --------------------------------------------------------------------------
  // All rows visible
  // --------------------------------------------------------------------------

  it("produces a single range when no rows or cols are hidden (large range)", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 999, endCol: 25 },
    });

    selectVisibleCellsFn!();

    const sel = getSelAction();
    expect(totalRanges(sel)).toBe(1);
    expect(sel.additionalRanges).toBeUndefined();
    expect(countVisibleCells(sel)).toBe(1000 * 26);
  });

  // --------------------------------------------------------------------------
  // Large range (10K rows) with scattered hidden
  // --------------------------------------------------------------------------

  it("handles 10K rows with every 100th row hidden", () => {
    const hidden = new Set<number>();
    for (let r = 0; r < 10000; r++) {
      if (r % 100 === 50) hidden.add(r);
    }
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 9999, endCol: 0 },
      dimensions: { hiddenRows: hidden, hiddenCols: new Set<number>() },
    });

    selectVisibleCellsFn!();

    const sel = getSelAction();
    // 100 hidden rows -> 100 gaps -> each splits into 2 parts but adjacent
    // bands merge, so we get 200 bands (before + after each gap)
    // Actually: each hidden row at position 50, 150, 250... splits one band
    // into two. So 100 hidden rows = 100+1 = ... but they're in different bands.
    // First band: 0-49, then 51-149, then 151-249, etc.
    // Wait - row 50 hidden, row 150 hidden, etc. Band: 0-49 (50 rows), 51-149 (99 rows),
    // 151-249 (99 rows), ... , 9951-9999 (49 rows). Total bands: 100+1 = 101? No.
    // Gaps at 50, 150, 250...9950 => 100 gaps => 101 bands
    expect(totalRanges(sel)).toBe(101);
    expect(countVisibleCells(sel)).toBe(10000 - 100);
  });

  it("handles 10K rows with first 5000 hidden", () => {
    const hidden = new Set<number>();
    for (let r = 0; r < 5000; r++) hidden.add(r);
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 9999, endCol: 0 },
      dimensions: { hiddenRows: hidden, hiddenCols: new Set<number>() },
    });

    selectVisibleCellsFn!();

    const sel = getSelAction();
    expect(totalRanges(sel)).toBe(1);
    expect(sel.startRow).toBe(5000);
    expect(sel.endRow).toBe(9999);
    expect(countVisibleCells(sel)).toBe(5000);
  });

  // --------------------------------------------------------------------------
  // Cross-product of many row bands and col spans
  // --------------------------------------------------------------------------

  it("generates correct cross-product for 3 row bands x 3 col spans", () => {
    // rows: 0,1 visible, 2 hidden, 3,4 visible, 5 hidden, 6,7 visible
    // cols: 0 visible, 1 hidden, 2,3 visible, 4 hidden, 5 visible
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 7, endCol: 5 },
      dimensions: {
        hiddenRows: new Set([2, 5]),
        hiddenCols: new Set([1, 4]),
      },
    });

    selectVisibleCellsFn!();

    const sel = getSelAction();
    // 3 row bands x 3 col spans = 9 ranges
    expect(totalRanges(sel)).toBe(9);
  });

  // --------------------------------------------------------------------------
  // Single cell selection
  // --------------------------------------------------------------------------

  it("handles single visible cell selection", () => {
    mockGridState = makeGridState({
      selection: { startRow: 5, startCol: 3, endRow: 5, endCol: 3 },
    });

    selectVisibleCellsFn!();

    const sel = getSelAction();
    expect(sel.startRow).toBe(5);
    expect(sel.endRow).toBe(5);
    expect(sel.startCol).toBe(3);
    expect(sel.endCol).toBe(3);
    expect(sel.additionalRanges).toBeUndefined();
  });

  it("handles single hidden cell selection", () => {
    mockGridState = makeGridState({
      selection: { startRow: 5, startCol: 3, endRow: 5, endCol: 3 },
      dimensions: { hiddenRows: new Set([5]), hiddenCols: new Set<number>() },
    });

    selectVisibleCellsFn!();

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No visible cells in selection" }),
    );
  });

  // --------------------------------------------------------------------------
  // Hidden at boundaries only
  // --------------------------------------------------------------------------

  it("handles hidden first and last row only", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 9, endCol: 0 },
      dimensions: { hiddenRows: new Set([0, 9]), hiddenCols: new Set<number>() },
    });

    selectVisibleCellsFn!();

    const sel = getSelAction();
    expect(totalRanges(sel)).toBe(1);
    expect(sel.startRow).toBe(1);
    expect(sel.endRow).toBe(8);
  });

  it("handles hidden first and last column only", () => {
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 5 },
      dimensions: { hiddenRows: new Set<number>(), hiddenCols: new Set([0, 5]) },
    });

    selectVisibleCellsFn!();

    const sel = getSelAction();
    expect(totalRanges(sel)).toBe(1);
    expect(sel.startCol).toBe(1);
    expect(sel.endCol).toBe(4);
  });

  // --------------------------------------------------------------------------
  // Toast message content
  // --------------------------------------------------------------------------

  it("toast shows correct hidden count for large range", () => {
    const hidden = new Set<number>();
    for (let r = 0; r < 50; r++) hidden.add(r * 2); // hide even rows 0-98
    mockGridState = makeGridState({
      selection: { startRow: 0, startCol: 0, endRow: 99, endCol: 0 },
      dimensions: { hiddenRows: hidden, hiddenCols: new Set<number>() },
    });

    selectVisibleCellsFn!();

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("50 visible cell(s)"),
      }),
    );
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("50 hidden"),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // No selection in state
  // --------------------------------------------------------------------------

  it("handles state with null selection field", () => {
    mockGridState = makeGridState({ selection: null });
    selectVisibleCellsFn!();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No selection", type: "warning" }),
    );
  });
});
