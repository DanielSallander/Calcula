import { describe, it, expect } from "vitest";
import {
  GRID_ACTIONS,
  setSelection,
  addToSelection,
  clearSelection,
  extendSelection,
  moveSelection,
  setViewport,
  updateScroll,
  scrollBy,
  scrollToCell,
  scrollToPosition,
  startEditing,
  updateEditing,
  stopEditing,
  updateConfig,
  setViewportSize,
  setViewportDimensions,
  expandVirtualBounds,
  setVirtualBounds,
  resetVirtualBounds,
  setFormulaReferences,
  clearFormulaReferences,
  setColumnWidth,
  setRowHeight,
  setAllDimensions,
  setClipboard,
  clearClipboard,
  setSheetContext,
  setActiveSheet,
  setFreezeConfig,
  setHiddenRows,
  setHiddenCols,
  setManuallyHiddenRows,
  setManuallyHiddenCols,
  setGroupHiddenRows,
  setGroupHiddenCols,
  setZoom,
  setSplitConfig,
  setSplitViewport,
  setViewMode,
  setShowFormulas,
  setDisplayZeros,
  setDisplayGridlines,
  setDisplayHeadings,
  setDisplayFormulaBar,
  setReferenceStyle,
} from "../gridActions";

describe("gridActions - action creators", () => {
  // -- setSelection --
  describe("setSelection", () => {
    it("creates action from positional args", () => {
      const action = setSelection(1, 2, 3, 4);
      expect(action.type).toBe(GRID_ACTIONS.SET_SELECTION);
      expect(action.payload).toEqual({
        startRow: 1, startCol: 2, endRow: 3, endCol: 4, type: "cells",
      });
    });

    it("creates action from payload object", () => {
      const action = setSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 5, type: "rows" });
      expect(action.payload.type).toBe("rows");
      expect(action.payload.startRow).toBe(0);
      expect(action.payload.endRow).toBe(5);
    });

    it("defaults type to cells when not provided in payload", () => {
      const action = setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
      expect(action.payload.type).toBe("cells");
    });

    it("preserves additionalRanges from payload", () => {
      const additional = [{ startRow: 10, startCol: 10, endRow: 20, endCol: 20 }];
      const action = setSelection({
        startRow: 0, startCol: 0, endRow: 5, endCol: 5, additionalRanges: additional,
      });
      expect(action.payload.additionalRanges).toEqual(additional);
    });

    it("supports columns selection type via positional args", () => {
      const action = setSelection(0, 2, 99, 4, "columns");
      expect(action.payload.type).toBe("columns");
    });
  });

  // -- addToSelection --
  it("addToSelection creates correct action", () => {
    const action = addToSelection(5, 3, 10, 7);
    expect(action.type).toBe(GRID_ACTIONS.ADD_TO_SELECTION);
    expect(action.payload).toEqual({ row: 5, col: 3, endRow: 10, endCol: 7 });
  });

  it("addToSelection works without end coordinates", () => {
    const action = addToSelection(2, 4);
    expect(action.payload.endRow).toBeUndefined();
    expect(action.payload.endCol).toBeUndefined();
  });

  // -- simple actions --
  it("clearSelection", () => {
    expect(clearSelection().type).toBe(GRID_ACTIONS.CLEAR_SELECTION);
  });

  it("extendSelection", () => {
    const action = extendSelection(10, 20);
    expect(action.payload).toEqual({ row: 10, col: 20 });
  });

  it("moveSelection with defaults", () => {
    const action = moveSelection(1, 0);
    expect(action.payload).toEqual({ deltaRow: 1, deltaCol: 0, extend: false });
  });

  it("moveSelection with extend", () => {
    const action = moveSelection(-1, 0, true);
    expect(action.payload.extend).toBe(true);
  });

  // -- viewport actions --
  it("setViewport", () => {
    const vp = { scrollX: 10, scrollY: 20, startRow: 0, startCol: 0, rowCount: 50, colCount: 20 };
    const action = setViewport(vp);
    expect(action.type).toBe(GRID_ACTIONS.SET_VIEWPORT);
    expect(action.payload).toEqual(vp);
  });

  it("updateScroll", () => {
    const action = updateScroll(100, 200);
    expect(action.payload).toEqual({ scrollX: 100, scrollY: 200 });
  });

  it("scrollBy", () => {
    const action = scrollBy(50, -30);
    expect(action.payload).toEqual({ deltaX: 50, deltaY: -30 });
  });

  it("scrollToCell defaults center to false", () => {
    const action = scrollToCell(5, 10);
    expect(action.payload).toEqual({ row: 5, col: 10, center: false });
  });

  it("scrollToCell with center", () => {
    const action = scrollToCell(5, 10, true);
    expect(action.payload.center).toBe(true);
  });

  it("scrollToPosition", () => {
    const action = scrollToPosition(500, 1000);
    expect(action.payload).toEqual({ scrollX: 500, scrollY: 1000 });
  });

  // -- editing actions --
  it("startEditing", () => {
    const cell = { row: 3, col: 2, value: "hello" };
    const action = startEditing(cell);
    expect(action.payload).toEqual(cell);
  });

  it("updateEditing", () => {
    const action = updateEditing("new value");
    expect(action.payload).toEqual({ value: "new value" });
  });

  it("stopEditing", () => {
    expect(stopEditing().type).toBe(GRID_ACTIONS.STOP_EDITING);
  });

  // -- config --
  it("updateConfig", () => {
    const action = updateConfig({ defaultCellWidth: 120 });
    expect(action.payload).toEqual({ defaultCellWidth: 120 });
  });

  it("setViewportSize", () => {
    const action = setViewportSize(30, 15);
    expect(action.payload).toEqual({ rowCount: 30, colCount: 15 });
  });

  it("setViewportDimensions", () => {
    const action = setViewportDimensions(800, 600);
    expect(action.payload).toEqual({ width: 800, height: 600 });
  });

  // -- virtual bounds --
  it("expandVirtualBounds", () => {
    const action = expandVirtualBounds(500, 30);
    expect(action.payload).toEqual({ targetRow: 500, targetCol: 30 });
  });

  it("setVirtualBounds", () => {
    const action = setVirtualBounds({ maxRow: 1000, maxCol: 50 });
    expect(action.payload).toEqual({ maxRow: 1000, maxCol: 50 });
  });

  it("resetVirtualBounds", () => {
    expect(resetVirtualBounds().type).toBe(GRID_ACTIONS.RESET_VIRTUAL_BOUNDS);
  });

  // -- formula references --
  it("setFormulaReferences", () => {
    const refs = [{ range: { startRow: 0, startCol: 0, endRow: 5, endCol: 5 }, color: "red" }];
    const action = setFormulaReferences(refs as any);
    expect(action.payload).toEqual(refs);
  });

  it("clearFormulaReferences", () => {
    expect(clearFormulaReferences().type).toBe(GRID_ACTIONS.CLEAR_FORMULA_REFERENCES);
  });

  // -- dimensions --
  it("setColumnWidth", () => {
    const action = setColumnWidth(3, 150);
    expect(action.payload).toEqual({ col: 3, width: 150 });
  });

  it("setRowHeight", () => {
    const action = setRowHeight(7, 40);
    expect(action.payload).toEqual({ row: 7, height: 40 });
  });

  it("setAllDimensions", () => {
    const cols = new Map([[0, 100]]);
    const rows = new Map([[0, 30]]);
    const action = setAllDimensions(cols, rows);
    expect(action.payload.columnWidths).toBe(cols);
    expect(action.payload.rowHeights).toBe(rows);
  });

  // -- clipboard --
  it("setClipboard", () => {
    const sel = { startRow: 0, startCol: 0, endRow: 1, endCol: 1, type: "cells" as const };
    const action = setClipboard("copy", sel);
    expect(action.payload.mode).toBe("copy");
    expect(action.payload.selection).toEqual(sel);
  });

  it("clearClipboard", () => {
    expect(clearClipboard().type).toBe(GRID_ACTIONS.CLEAR_CLIPBOARD);
  });

  // -- sheet context --
  it("setSheetContext", () => {
    const action = setSheetContext(2, "Sheet3");
    expect(action.payload).toEqual({ activeSheetIndex: 2, activeSheetName: "Sheet3" });
  });

  it("setActiveSheet", () => {
    const action = setActiveSheet(1, "Sheet2");
    expect(action.payload).toEqual({ index: 1, name: "Sheet2" });
  });

  // -- freeze / hidden / zoom --
  it("setFreezeConfig", () => {
    const action = setFreezeConfig(3, 2);
    expect(action.payload).toEqual({ freezeRow: 3, freezeCol: 2 });
  });

  it("setHiddenRows", () => {
    const action = setHiddenRows([1, 3, 5]);
    expect(action.payload.rows).toEqual([1, 3, 5]);
  });

  it("setHiddenCols", () => {
    const action = setHiddenCols([0, 2]);
    expect(action.payload.cols).toEqual([0, 2]);
  });

  it("setManuallyHiddenRows", () => {
    const action = setManuallyHiddenRows([4]);
    expect(action.payload.rows).toEqual([4]);
  });

  it("setManuallyHiddenCols", () => {
    const action = setManuallyHiddenCols([6]);
    expect(action.payload.cols).toEqual([6]);
  });

  it("setGroupHiddenRows", () => {
    const action = setGroupHiddenRows([10, 11]);
    expect(action.payload.rows).toEqual([10, 11]);
  });

  it("setGroupHiddenCols", () => {
    const action = setGroupHiddenCols([3]);
    expect(action.payload.cols).toEqual([3]);
  });

  it("setZoom clamps to ZOOM_MIN", () => {
    const action = setZoom(0.01);
    expect(action.payload.zoom).toBeGreaterThanOrEqual(0.1);
  });

  it("setZoom clamps to ZOOM_MAX", () => {
    const action = setZoom(10);
    expect(action.payload.zoom).toBeLessThanOrEqual(5);
  });

  it("setZoom preserves valid zoom", () => {
    const action = setZoom(1.5);
    expect(action.payload.zoom).toBe(1.5);
  });

  // -- split / view --
  it("setSplitConfig", () => {
    const action = setSplitConfig(5, 3);
    expect(action.payload).toEqual({ splitRow: 5, splitCol: 3 });
  });

  it("setSplitViewport", () => {
    const vp = { scrollX: 0, scrollY: 100, startRow: 0, startCol: 0, rowCount: 20, colCount: 10 };
    const action = setSplitViewport(vp);
    expect(action.payload).toEqual(vp);
  });

  it("setViewMode", () => {
    const action = setViewMode("pageLayout");
    expect(action.payload.viewMode).toBe("pageLayout");
  });

  it("setShowFormulas", () => {
    expect(setShowFormulas(true).payload.showFormulas).toBe(true);
  });

  it("setDisplayZeros", () => {
    expect(setDisplayZeros(false).payload.displayZeros).toBe(false);
  });

  it("setDisplayGridlines", () => {
    expect(setDisplayGridlines(false).payload.displayGridlines).toBe(false);
  });

  it("setDisplayHeadings", () => {
    expect(setDisplayHeadings(false).payload.displayHeadings).toBe(false);
  });

  it("setDisplayFormulaBar", () => {
    expect(setDisplayFormulaBar(false).payload.displayFormulaBar).toBe(false);
  });

  it("setReferenceStyle", () => {
    expect(setReferenceStyle("R1C1").payload.referenceStyle).toBe("R1C1");
  });
});
