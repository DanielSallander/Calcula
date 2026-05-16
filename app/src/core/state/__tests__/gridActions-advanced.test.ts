import { describe, it, expect } from "vitest";
import {
  GRID_ACTIONS,
  setSelection,
  addToSelection,
  extendSelection,
  moveSelection,
  setViewport,
  updateScroll,
  scrollBy,
  scrollToCell,
  startEditing,
  stopEditing,
  updateEditing,
  setFormulaReferences,
  clearFormulaReferences,
  setSheetContext,
  setActiveSheet,
  setFreezeConfig,
  expandVirtualBounds,
  setVirtualBounds,
  resetVirtualBounds,
  setViewportSize,
  setViewportDimensions,
  setClipboard,
  clearClipboard,
  setZoom,
  setColumnWidth,
  setRowHeight,
} from "../gridActions";
import { gridReducer, getInitialState } from "../gridReducer";

/**
 * Helper: create a base state with known viewport dimensions so scroll logic is deterministic.
 */
function createTestState() {
  const state = getInitialState();
  // Give the viewport real pixel dimensions so scroll calculations work
  state.viewportDimensions = { width: 1000, height: 600 };
  return state;
}

// ---------------------------------------------------------------------------
// 1. Complex multi-range selection via addToSelection
// ---------------------------------------------------------------------------
describe("gridActions-advanced - multi-range selection", () => {
  it("ADD_TO_SELECTION accumulates the previous main selection as an additional range", () => {
    let state = createTestState();
    // Start with a normal selection at A1
    state = gridReducer(state, setSelection(0, 0, 0, 0));
    // Ctrl+Click on C3
    state = gridReducer(state, addToSelection(2, 2));

    expect(state.selection).not.toBeNull();
    expect(state.selection!.startRow).toBe(2);
    expect(state.selection!.startCol).toBe(2);
    // The original A1 selection should be in additionalRanges
    expect(state.selection!.additionalRanges).toHaveLength(1);
    expect(state.selection!.additionalRanges![0]).toEqual({
      startRow: 0, startCol: 0, endRow: 0, endCol: 0,
    });
  });

  it("ADD_TO_SELECTION stacks multiple ranges", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(0, 0, 0, 0));
    state = gridReducer(state, addToSelection(2, 2));
    state = gridReducer(state, addToSelection(5, 5, 7, 7));

    expect(state.selection!.additionalRanges).toHaveLength(2);
    // First additional range = original A1
    expect(state.selection!.additionalRanges![0]).toEqual({
      startRow: 0, startCol: 0, endRow: 0, endCol: 0,
    });
    // Second additional range = the C3 single cell
    expect(state.selection!.additionalRanges![1]).toEqual({
      startRow: 2, startCol: 2, endRow: 2, endCol: 2,
    });
    // Active selection is the latest range
    expect(state.selection!.startRow).toBe(5);
    expect(state.selection!.endRow).toBe(7);
  });

  it("ADD_TO_SELECTION with endRow/endCol creates a range, not a single cell", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(0, 0, 0, 0));
    state = gridReducer(state, addToSelection(3, 1, 6, 4));

    expect(state.selection!.startRow).toBe(3);
    expect(state.selection!.startCol).toBe(1);
    expect(state.selection!.endRow).toBe(6);
    expect(state.selection!.endCol).toBe(4);
  });

  it("ADD_TO_SELECTION clamps to grid boundaries", () => {
    let state = createTestState();
    const maxRow = state.config.totalRows - 1;
    const maxCol = state.config.totalCols - 1;
    state = gridReducer(state, setSelection(0, 0, 0, 0));
    state = gridReducer(state, addToSelection(maxRow + 100, maxCol + 100));

    expect(state.selection!.startRow).toBe(maxRow);
    expect(state.selection!.startCol).toBe(maxCol);
  });
});

// ---------------------------------------------------------------------------
// 2. Extend selection in all 4 directions
// ---------------------------------------------------------------------------
describe("gridActions-advanced - extend selection", () => {
  it("EXTEND_SELECTION downward", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(5, 5, 5, 5));
    state = gridReducer(state, extendSelection(10, 5));

    expect(state.selection!.startRow).toBe(5);
    expect(state.selection!.endRow).toBe(10);
    expect(state.selection!.startCol).toBe(5);
    expect(state.selection!.endCol).toBe(5);
  });

  it("EXTEND_SELECTION upward", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(5, 5, 5, 5));
    state = gridReducer(state, extendSelection(2, 5));

    expect(state.selection!.startRow).toBe(5);
    expect(state.selection!.endRow).toBe(2);
  });

  it("EXTEND_SELECTION to the right", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(5, 5, 5, 5));
    state = gridReducer(state, extendSelection(5, 10));

    expect(state.selection!.startCol).toBe(5);
    expect(state.selection!.endCol).toBe(10);
  });

  it("EXTEND_SELECTION to the left", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(5, 5, 5, 5));
    state = gridReducer(state, extendSelection(5, 1));

    expect(state.selection!.startCol).toBe(5);
    expect(state.selection!.endCol).toBe(1);
  });

  it("EXTEND_SELECTION is a no-op when selection is null", () => {
    let state = createTestState();
    state.selection = null;
    const after = gridReducer(state, extendSelection(3, 3));
    expect(after.selection).toBeNull();
  });

  it("EXTEND_SELECTION clamps to grid boundaries", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(0, 0, 0, 0));
    state = gridReducer(state, extendSelection(-10, -10));

    expect(state.selection!.endRow).toBe(0);
    expect(state.selection!.endCol).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Move selection with boundary clamping
// ---------------------------------------------------------------------------
describe("gridActions-advanced - move selection boundaries", () => {
  it("MOVE_SELECTION clamps at row 0 when moving up from origin", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(0, 0, 0, 0));
    state = gridReducer(state, moveSelection(-1, 0));

    expect(state.selection!.startRow).toBe(0);
    expect(state.selection!.endRow).toBe(0);
  });

  it("MOVE_SELECTION clamps at col 0 when moving left from origin", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(0, 0, 0, 0));
    state = gridReducer(state, moveSelection(0, -1));

    expect(state.selection!.startCol).toBe(0);
    expect(state.selection!.endCol).toBe(0);
  });

  it("MOVE_SELECTION clamps at maxRow", () => {
    let state = createTestState();
    const maxRow = state.config.totalRows - 1;
    state = gridReducer(state, setSelection(maxRow, 0, maxRow, 0));
    state = gridReducer(state, moveSelection(1, 0));

    expect(state.selection!.endRow).toBe(maxRow);
  });

  it("MOVE_SELECTION clamps at maxCol", () => {
    let state = createTestState();
    const maxCol = state.config.totalCols - 1;
    state = gridReducer(state, setSelection(0, maxCol, 0, maxCol));
    state = gridReducer(state, moveSelection(0, 1));

    expect(state.selection!.endCol).toBe(maxCol);
  });

  it("MOVE_SELECTION creates origin selection when selection is null", () => {
    let state = createTestState();
    state.selection = null;
    state = gridReducer(state, moveSelection(1, 0));

    expect(state.selection).toEqual({
      startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells",
    });
  });

  it("MOVE_SELECTION with extend grows the range", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(5, 5, 5, 5));
    state = gridReducer(state, moveSelection(3, 2, true));

    expect(state.selection!.startRow).toBe(5);
    expect(state.selection!.startCol).toBe(5);
    expect(state.selection!.endRow).toBe(8);
    expect(state.selection!.endCol).toBe(7);
  });

  it("MOVE_SELECTION without extend collapses to single cell", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(5, 5, 10, 10));
    state = gridReducer(state, moveSelection(1, 0));

    // Moves from endRow/endCol position
    expect(state.selection!.startRow).toBe(11);
    expect(state.selection!.startCol).toBe(10);
    expect(state.selection!.endRow).toBe(11);
    expect(state.selection!.endCol).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 4. Selection type variations
// ---------------------------------------------------------------------------
describe("gridActions-advanced - selection types", () => {
  it("SET_SELECTION with type columns does not scroll", () => {
    let state = createTestState();
    state.viewport = { ...state.viewport, scrollX: 0, scrollY: 0 };
    state = gridReducer(state, setSelection(0, 2, 1048575, 4, "columns"));

    expect(state.selection!.type).toBe("columns");
    // Viewport scroll should not change for column selection
    expect(state.viewport.scrollX).toBe(0);
    expect(state.viewport.scrollY).toBe(0);
  });

  it("SET_SELECTION with type rows does not scroll", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(5, 0, 10, 16383, "rows"));

    expect(state.selection!.type).toBe("rows");
    expect(state.viewport.scrollX).toBe(0);
    expect(state.viewport.scrollY).toBe(0);
  });

  it("SET_SELECTION select-all does not scroll", () => {
    let state = createTestState();
    const maxRow = state.config.totalRows - 1;
    const maxCol = state.config.totalCols - 1;
    state = gridReducer(state, setSelection(0, 0, maxRow, maxCol));

    expect(state.viewport.scrollX).toBe(0);
    expect(state.viewport.scrollY).toBe(0);
  });

  it("SET_SELECTION for columns does not expand virtual bounds", () => {
    let state = createTestState();
    const boundsBefore = { ...state.virtualBounds };
    state = gridReducer(state, setSelection(0, 2, 1048575, 4, "columns"));

    expect(state.virtualBounds).toEqual(boundsBefore);
  });

  it("EXTEND_SELECTION preserves selection type", () => {
    let state = createTestState();
    state = gridReducer(state, setSelection(0, 2, 1048575, 2, "columns"));
    state = gridReducer(state, extendSelection(1048575, 5));

    expect(state.selection!.type).toBe("columns");
  });
});

// ---------------------------------------------------------------------------
// 5. Viewport updates with scroll clamping
// ---------------------------------------------------------------------------
describe("gridActions-advanced - viewport scroll", () => {
  it("UPDATE_SCROLL clamps negative scroll to zero", () => {
    let state = createTestState();
    state = gridReducer(state, updateScroll(-100, -200));

    expect(state.viewport.scrollX).toBe(0);
    expect(state.viewport.scrollY).toBe(0);
  });

  it("SCROLL_BY with negative delta clamps to zero", () => {
    let state = createTestState();
    state = gridReducer(state, scrollBy(-999, -999));

    expect(state.viewport.scrollX).toBe(0);
    expect(state.viewport.scrollY).toBe(0);
  });

  it("SET_VIEWPORT_SIZE updates row and col counts", () => {
    let state = createTestState();
    state = gridReducer(state, setViewportSize(100, 40));

    expect(state.viewport.rowCount).toBe(100);
    expect(state.viewport.colCount).toBe(40);
  });

  it("SET_VIEWPORT_DIMENSIONS stores pixel dimensions", () => {
    let state = createTestState();
    state = gridReducer(state, setViewportDimensions(1920, 1080));

    expect(state.viewportDimensions.width).toBe(1920);
    expect(state.viewportDimensions.height).toBe(1080);
  });
});

// ---------------------------------------------------------------------------
// 6. Formula reference actions during edit mode
// ---------------------------------------------------------------------------
describe("gridActions-advanced - formula references", () => {
  it("SET_FORMULA_REFERENCES stores references", () => {
    let state = createTestState();
    const refs = [
      { range: { startRow: 0, startCol: 0, endRow: 2, endCol: 2 }, color: "#FF0000", colorIndex: 0 },
      { range: { startRow: 5, startCol: 5, endRow: 5, endCol: 5 }, color: "#00FF00", colorIndex: 1 },
    ];
    state = gridReducer(state, setFormulaReferences(refs as any));

    expect(state.formulaReferences).toHaveLength(2);
    expect(state.formulaReferences[0].color).toBe("#FF0000");
  });

  it("CLEAR_FORMULA_REFERENCES empties the array", () => {
    let state = createTestState();
    const refs = [
      { range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, color: "#FF0000", colorIndex: 0 },
    ];
    state = gridReducer(state, setFormulaReferences(refs as any));
    state = gridReducer(state, clearFormulaReferences());

    expect(state.formulaReferences).toEqual([]);
  });

  it("STOP_EDITING also clears formula references", () => {
    let state = createTestState();
    const refs = [
      { range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, color: "#FF0000", colorIndex: 0 },
    ];
    state = gridReducer(state, setFormulaReferences(refs as any));
    state = gridReducer(state, startEditing({ row: 0, col: 0, value: "=A1+B2" }));
    state = gridReducer(state, stopEditing());

    expect(state.formulaReferences).toEqual([]);
    expect(state.editing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Editing lifecycle
// ---------------------------------------------------------------------------
describe("gridActions-advanced - editing", () => {
  it("START_EDITING sets editing state", () => {
    let state = createTestState();
    state = gridReducer(state, startEditing({ row: 3, col: 2, value: "hello" }));

    expect(state.editing).toEqual({ row: 3, col: 2, value: "hello" });
  });

  it("UPDATE_EDITING modifies value in place", () => {
    let state = createTestState();
    state = gridReducer(state, startEditing({ row: 0, col: 0, value: "" }));
    state = gridReducer(state, updateEditing("=SUM(A1:A10)"));

    expect(state.editing!.value).toBe("=SUM(A1:A10)");
  });

  it("UPDATE_EDITING is no-op when not editing", () => {
    let state = createTestState();
    const before = { ...state };
    state = gridReducer(state, updateEditing("test"));

    expect(state.editing).toBeNull();
  });

  it("STOP_EDITING clears editing state", () => {
    let state = createTestState();
    state = gridReducer(state, startEditing({ row: 0, col: 0, value: "test" }));
    state = gridReducer(state, stopEditing());

    expect(state.editing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Sheet context switching
// ---------------------------------------------------------------------------
describe("gridActions-advanced - sheet context", () => {
  it("SET_SHEET_CONTEXT updates both index and name", () => {
    let state = createTestState();
    state = gridReducer(state, setSheetContext(2, "Revenue"));

    expect(state.sheetContext.activeSheetIndex).toBe(2);
    expect(state.sheetContext.activeSheetName).toBe("Revenue");
  });

  it("SET_ACTIVE_SHEET updates sheet context", () => {
    let state = createTestState();
    state = gridReducer(state, setActiveSheet(4, "Sheet5"));

    expect(state.sheetContext.activeSheetIndex).toBe(4);
    expect(state.sheetContext.activeSheetName).toBe("Sheet5");
  });

  it("SET_CLIPBOARD stores source sheet index", () => {
    let state = createTestState();
    state = gridReducer(state, setSheetContext(1, "Sheet2"));
    const sel = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" as const };
    state = gridReducer(state, setClipboard("copy", sel, 1));

    expect(state.clipboard.mode).toBe("copy");
    expect(state.clipboard.sourceSheetIndex).toBe(1);
  });

  it("SET_CLIPBOARD defaults source sheet to active sheet", () => {
    let state = createTestState();
    state = gridReducer(state, setSheetContext(3, "Sheet4"));
    const sel = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" as const };
    state = gridReducer(state, setClipboard("cut", sel));

    expect(state.clipboard.sourceSheetIndex).toBe(3);
  });

  it("CLEAR_CLIPBOARD resets mode and selection", () => {
    let state = createTestState();
    const sel = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" as const };
    state = gridReducer(state, setClipboard("copy", sel));
    state = gridReducer(state, clearClipboard());

    expect(state.clipboard.mode).toBe("none");
    expect(state.clipboard.selection).toBeNull();
    expect(state.clipboard.sourceSheetIndex).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Virtual bounds interactions with selection
// ---------------------------------------------------------------------------
describe("gridActions-advanced - virtual bounds", () => {
  it("EXPAND_VIRTUAL_BOUNDS grows when target is near edge", () => {
    let state = createTestState();
    const initialMaxRow = state.virtualBounds.maxRow;
    // Target at the boundary should trigger expansion
    state = gridReducer(state, expandVirtualBounds(initialMaxRow, 0));

    expect(state.virtualBounds.maxRow).toBeGreaterThan(initialMaxRow);
  });

  it("EXPAND_VIRTUAL_BOUNDS does not shrink bounds", () => {
    let state = createTestState();
    state = gridReducer(state, setVirtualBounds({ maxRow: 500, maxCol: 100 }));
    // Expanding to a small target should not shrink
    state = gridReducer(state, expandVirtualBounds(10, 10));

    expect(state.virtualBounds.maxRow).toBeGreaterThanOrEqual(500);
    expect(state.virtualBounds.maxCol).toBeGreaterThanOrEqual(100);
  });

  it("SET_VIRTUAL_BOUNDS overwrites bounds directly", () => {
    let state = createTestState();
    state = gridReducer(state, setVirtualBounds({ maxRow: 999, maxCol: 77 }));

    expect(state.virtualBounds).toEqual({ maxRow: 999, maxCol: 77 });
  });

  it("RESET_VIRTUAL_BOUNDS returns to defaults", () => {
    let state = createTestState();
    state = gridReducer(state, setVirtualBounds({ maxRow: 9999, maxCol: 999 }));
    state = gridReducer(state, resetVirtualBounds());

    expect(state.virtualBounds.maxRow).toBe(199);
    expect(state.virtualBounds.maxCol).toBe(51);
  });

  it("SET_SELECTION for cells expands virtual bounds when needed", () => {
    let state = createTestState();
    const initialMaxRow = state.virtualBounds.maxRow;
    // Select a cell near the virtual bounds edge
    state = gridReducer(state, setSelection(initialMaxRow - 5, 0, initialMaxRow - 5, 0));

    expect(state.virtualBounds.maxRow).toBeGreaterThan(initialMaxRow);
  });
});

// ---------------------------------------------------------------------------
// 10. Freeze config and dimension actions
// ---------------------------------------------------------------------------
describe("gridActions-advanced - freeze and dimensions", () => {
  it("SET_FREEZE_CONFIG stores freeze row and col", () => {
    let state = createTestState();
    state = gridReducer(state, setFreezeConfig(3, 2));

    expect(state.freezeConfig.freezeRow).toBe(3);
    expect(state.freezeConfig.freezeCol).toBe(2);
  });

  it("SET_FREEZE_CONFIG with null unfreezes", () => {
    let state = createTestState();
    state = gridReducer(state, setFreezeConfig(3, 2));
    state = gridReducer(state, setFreezeConfig(null, null));

    expect(state.freezeConfig.freezeRow).toBeNull();
    expect(state.freezeConfig.freezeCol).toBeNull();
  });

  it("SET_COLUMN_WIDTH with width > 0 sets the width", () => {
    let state = createTestState();
    state = gridReducer(state, setColumnWidth(5, 200));

    expect(state.dimensions.columnWidths.get(5)).toBe(200);
  });

  it("SET_COLUMN_WIDTH with width <= 0 removes the override", () => {
    let state = createTestState();
    state = gridReducer(state, setColumnWidth(5, 200));
    state = gridReducer(state, setColumnWidth(5, 0));

    expect(state.dimensions.columnWidths.has(5)).toBe(false);
  });

  it("SET_ROW_HEIGHT with height > 0 sets the height", () => {
    let state = createTestState();
    state = gridReducer(state, setRowHeight(10, 50));

    expect(state.dimensions.rowHeights.get(10)).toBe(50);
  });

  it("SET_ROW_HEIGHT with height <= 0 removes the override", () => {
    let state = createTestState();
    state = gridReducer(state, setRowHeight(10, 50));
    state = gridReducer(state, setRowHeight(10, -1));

    expect(state.dimensions.rowHeights.has(10)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. Zoom action clamping
// ---------------------------------------------------------------------------
describe("gridActions-advanced - zoom edge cases", () => {
  it("setZoom(0) clamps to ZOOM_MIN", () => {
    const action = setZoom(0);
    expect(action.payload.zoom).toBe(0.1);
  });

  it("setZoom(Infinity) clamps to ZOOM_MAX", () => {
    const action = setZoom(Infinity);
    expect(action.payload.zoom).toBe(5.0);
  });

  it("SET_ZOOM updates state zoom", () => {
    let state = createTestState();
    state = gridReducer(state, setZoom(2.0));
    expect(state.zoom).toBe(2.0);
  });
});

// ---------------------------------------------------------------------------
// 12. Unknown action returns same state
// ---------------------------------------------------------------------------
describe("gridActions-advanced - unknown action", () => {
  it("returns the same state for an unknown action type", () => {
    const state = createTestState();
    const result = gridReducer(state, { type: "UNKNOWN_ACTION" } as any);
    expect(result).toBe(state);
  });
});
