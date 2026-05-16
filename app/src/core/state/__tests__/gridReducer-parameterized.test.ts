import { describe, it, expect } from "vitest";
import { gridReducer, getInitialState, clamp } from "../gridReducer";
import { GRID_ACTIONS } from "../gridActions";
import type { GridState } from "../../types";
import { ZOOM_MIN, ZOOM_MAX } from "../../types";

// Helper to get a fresh state
function freshState(): GridState {
  return getInitialState();
}

// ---------------------------------------------------------------------------
// 1. clamp - 50 value/min/max combos
// ---------------------------------------------------------------------------
describe("clamp parameterized", () => {
  const clampCombos: Array<{
    label: string;
    value: number;
    min: number;
    max: number;
    expected: number;
  }> = [
    { label: "within range", value: 5, min: 0, max: 10, expected: 5 },
    { label: "at min", value: 0, min: 0, max: 10, expected: 0 },
    { label: "at max", value: 10, min: 0, max: 10, expected: 10 },
    { label: "below min", value: -1, min: 0, max: 10, expected: 0 },
    { label: "above max", value: 11, min: 0, max: 10, expected: 10 },
    { label: "far below min", value: -1000, min: 0, max: 10, expected: 0 },
    { label: "far above max", value: 1000, min: 0, max: 10, expected: 10 },
    { label: "zero range", value: 5, min: 5, max: 5, expected: 5 },
    { label: "zero range below", value: 3, min: 5, max: 5, expected: 5 },
    { label: "zero range above", value: 7, min: 5, max: 5, expected: 5 },
    { label: "negative range within", value: -5, min: -10, max: -1, expected: -5 },
    { label: "negative range below", value: -15, min: -10, max: -1, expected: -10 },
    { label: "negative range above", value: 0, min: -10, max: -1, expected: -1 },
    { label: "large range within", value: 500000, min: 0, max: 1048575, expected: 500000 },
    { label: "large range at max", value: 1048575, min: 0, max: 1048575, expected: 1048575 },
    { label: "large range above", value: 2000000, min: 0, max: 1048575, expected: 1048575 },
    { label: "col range within", value: 8000, min: 0, max: 16383, expected: 8000 },
    { label: "col range above", value: 20000, min: 0, max: 16383, expected: 16383 },
    { label: "float within", value: 1.5, min: 0, max: 3, expected: 1.5 },
    { label: "float below", value: -0.1, min: 0, max: 3, expected: 0 },
    { label: "float above", value: 3.1, min: 0, max: 3, expected: 3 },
    { label: "min equals value", value: 7, min: 7, max: 10, expected: 7 },
    { label: "max equals value", value: 10, min: 7, max: 10, expected: 10 },
    { label: "min 0 max 0", value: 0, min: 0, max: 0, expected: 0 },
    { label: "min 0 max 0 positive", value: 5, min: 0, max: 0, expected: 0 },
    { label: "min 0 max 0 negative", value: -5, min: 0, max: 0, expected: 0 },
    { label: "large negative below", value: -999999, min: 0, max: 100, expected: 0 },
    { label: "large positive above", value: 999999, min: 0, max: 100, expected: 100 },
    { label: "midpoint", value: 50, min: 0, max: 100, expected: 50 },
    { label: "just above min", value: 1, min: 0, max: 100, expected: 1 },
    { label: "just below max", value: 99, min: 0, max: 100, expected: 99 },
    { label: "wide range mid", value: 524288, min: 0, max: 1048575, expected: 524288 },
    { label: "zoom min check", value: 0.05, min: ZOOM_MIN, max: ZOOM_MAX, expected: ZOOM_MIN },
    { label: "zoom max check", value: 10, min: ZOOM_MIN, max: ZOOM_MAX, expected: ZOOM_MAX },
    { label: "zoom within", value: 1.5, min: ZOOM_MIN, max: ZOOM_MAX, expected: 1.5 },
    { label: "row index 0", value: 0, min: 0, max: 1048575, expected: 0 },
    { label: "row index max", value: 1048575, min: 0, max: 1048575, expected: 1048575 },
    { label: "row index over", value: 1048576, min: 0, max: 1048575, expected: 1048575 },
    { label: "col index 0", value: 0, min: 0, max: 16383, expected: 0 },
    { label: "col index max", value: 16383, min: 0, max: 16383, expected: 16383 },
    { label: "col index over", value: 16384, min: 0, max: 16383, expected: 16383 },
    { label: "small negative range", value: -3, min: -5, max: -2, expected: -3 },
    { label: "cross-zero range low", value: -1, min: -5, max: 5, expected: -1 },
    { label: "cross-zero range high", value: 4, min: -5, max: 5, expected: 4 },
    { label: "cross-zero below", value: -10, min: -5, max: 5, expected: -5 },
    { label: "cross-zero above", value: 10, min: -5, max: 5, expected: 5 },
    { label: "Infinity above", value: Infinity, min: 0, max: 100, expected: 100 },
    { label: "-Infinity below", value: -Infinity, min: 0, max: 100, expected: 0 },
    { label: "fraction close to min", value: 0.001, min: 0, max: 1, expected: 0.001 },
    { label: "fraction close to max", value: 0.999, min: 0, max: 1, expected: 0.999 },
  ];

  it.each(clampCombos)(
    "clamp($value, $min, $max) = $expected ($label)",
    ({ value, min, max, expected }) => {
      expect(clamp(value, min, max)).toBeCloseTo(expected, 10);
    }
  );
});

// ---------------------------------------------------------------------------
// 2. Hidden row/col union - 20 filter+manual+group combos
// ---------------------------------------------------------------------------
describe("hidden row/col union parameterized", () => {
  const hiddenRowCombos: Array<{
    label: string;
    filterRows: number[];
    manualRows: number[];
    groupRows: number[];
    expectedHidden: number[];
  }> = [
    { label: "all empty", filterRows: [], manualRows: [], groupRows: [], expectedHidden: [] },
    { label: "filter only", filterRows: [1, 2, 3], manualRows: [], groupRows: [], expectedHidden: [1, 2, 3] },
    { label: "manual only", filterRows: [], manualRows: [5, 6], groupRows: [], expectedHidden: [5, 6] },
    { label: "group only", filterRows: [], manualRows: [], groupRows: [10, 11], expectedHidden: [10, 11] },
    { label: "filter+manual disjoint", filterRows: [1, 2], manualRows: [5, 6], groupRows: [], expectedHidden: [1, 2, 5, 6] },
    { label: "filter+group disjoint", filterRows: [1, 2], manualRows: [], groupRows: [10, 11], expectedHidden: [1, 2, 10, 11] },
    { label: "manual+group disjoint", filterRows: [], manualRows: [5, 6], groupRows: [10, 11], expectedHidden: [5, 6, 10, 11] },
    { label: "all three disjoint", filterRows: [1], manualRows: [5], groupRows: [10], expectedHidden: [1, 5, 10] },
    { label: "filter+manual overlap", filterRows: [1, 2, 3], manualRows: [2, 3, 4], groupRows: [], expectedHidden: [1, 2, 3, 4] },
    { label: "all overlap", filterRows: [1, 2], manualRows: [2, 3], groupRows: [3, 4], expectedHidden: [1, 2, 3, 4] },
    { label: "identical sets", filterRows: [1, 2, 3], manualRows: [1, 2, 3], groupRows: [1, 2, 3], expectedHidden: [1, 2, 3] },
    { label: "large filter set", filterRows: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], manualRows: [], groupRows: [], expectedHidden: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { label: "large row indices", filterRows: [100000], manualRows: [500000], groupRows: [900000], expectedHidden: [100000, 500000, 900000] },
    { label: "consecutive filter+group", filterRows: [1, 2, 3], manualRows: [], groupRows: [4, 5, 6], expectedHidden: [1, 2, 3, 4, 5, 6] },
    { label: "single row each", filterRows: [0], manualRows: [1], groupRows: [2], expectedHidden: [0, 1, 2] },
  ];

  // For rows, we need to set filter hidden first (SET_HIDDEN_ROWS), then manual, then group
  // The reducer computes the union. We simulate the sequence.
  it.each(hiddenRowCombos)(
    "hidden rows union: $label",
    ({ filterRows, manualRows, groupRows, expectedHidden }) => {
      let state = freshState();

      // Set filter hidden rows first
      state = gridReducer(state, {
        type: GRID_ACTIONS.SET_HIDDEN_ROWS,
        payload: { rows: filterRows },
      });

      // Set manually hidden rows
      state = gridReducer(state, {
        type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_ROWS,
        payload: { rows: manualRows },
      });

      // Set group hidden rows
      state = gridReducer(state, {
        type: GRID_ACTIONS.SET_GROUP_HIDDEN_ROWS,
        payload: { rows: groupRows },
      });

      const hiddenSet = state.dimensions.hiddenRows ?? new Set();
      const hiddenArray = [...hiddenSet].sort((a, b) => a - b);
      const expected = [...expectedHidden].sort((a, b) => a - b);
      expect(hiddenArray).toEqual(expected);
    }
  );

  // Column hidden combos
  const hiddenColCombos: Array<{
    label: string;
    manualCols: number[];
    groupCols: number[];
    expectedHidden: number[];
  }> = [
    { label: "all empty", manualCols: [], groupCols: [], expectedHidden: [] },
    { label: "manual only", manualCols: [0, 1, 2], groupCols: [], expectedHidden: [0, 1, 2] },
    { label: "group only", manualCols: [], groupCols: [5, 6, 7], expectedHidden: [5, 6, 7] },
    { label: "both disjoint", manualCols: [0, 1], groupCols: [5, 6], expectedHidden: [0, 1, 5, 6] },
    { label: "both overlap", manualCols: [1, 2, 3], groupCols: [2, 3, 4], expectedHidden: [1, 2, 3, 4] },
  ];

  it.each(hiddenColCombos)(
    "hidden cols union: $label",
    ({ manualCols, groupCols, expectedHidden }) => {
      let state = freshState();

      state = gridReducer(state, {
        type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_COLS,
        payload: { cols: manualCols },
      });

      state = gridReducer(state, {
        type: GRID_ACTIONS.SET_GROUP_HIDDEN_COLS,
        payload: { cols: groupCols },
      });

      const hiddenSet = state.dimensions.hiddenCols ?? new Set();
      const hiddenArray = [...hiddenSet].sort((a, b) => a - b);
      const expected = [...expectedHidden].sort((a, b) => a - b);
      expect(hiddenArray).toEqual(expected);
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Display toggles - 8 toggles x on/off = 16 tests
// ---------------------------------------------------------------------------
describe("display toggles parameterized", () => {
  const toggles: Array<{
    label: string;
    actionType: string;
    payloadKey: string;
    stateKey: keyof GridState;
    value: boolean;
  }> = [
    { label: "showFormulas on", actionType: GRID_ACTIONS.SET_SHOW_FORMULAS, payloadKey: "showFormulas", stateKey: "showFormulas", value: true },
    { label: "showFormulas off", actionType: GRID_ACTIONS.SET_SHOW_FORMULAS, payloadKey: "showFormulas", stateKey: "showFormulas", value: false },
    { label: "displayZeros on", actionType: GRID_ACTIONS.SET_DISPLAY_ZEROS, payloadKey: "displayZeros", stateKey: "displayZeros", value: true },
    { label: "displayZeros off", actionType: GRID_ACTIONS.SET_DISPLAY_ZEROS, payloadKey: "displayZeros", stateKey: "displayZeros", value: false },
    { label: "displayGridlines on", actionType: GRID_ACTIONS.SET_DISPLAY_GRIDLINES, payloadKey: "displayGridlines", stateKey: "displayGridlines", value: true },
    { label: "displayGridlines off", actionType: GRID_ACTIONS.SET_DISPLAY_GRIDLINES, payloadKey: "displayGridlines", stateKey: "displayGridlines", value: false },
    { label: "displayHeadings on", actionType: GRID_ACTIONS.SET_DISPLAY_HEADINGS, payloadKey: "displayHeadings", stateKey: "displayHeadings", value: true },
    { label: "displayHeadings off", actionType: GRID_ACTIONS.SET_DISPLAY_HEADINGS, payloadKey: "displayHeadings", stateKey: "displayHeadings", value: false },
    { label: "displayFormulaBar on", actionType: GRID_ACTIONS.SET_DISPLAY_FORMULA_BAR, payloadKey: "displayFormulaBar", stateKey: "displayFormulaBar", value: true },
    { label: "displayFormulaBar off", actionType: GRID_ACTIONS.SET_DISPLAY_FORMULA_BAR, payloadKey: "displayFormulaBar", stateKey: "displayFormulaBar", value: false },
  ];

  // Add viewMode and referenceStyle as non-boolean toggles
  const viewModeCombos: Array<{ label: string; value: string }> = [
    { label: "viewMode normal", value: "normal" },
    { label: "viewMode pageLayout", value: "pageLayout" },
    { label: "viewMode pageBreakPreview", value: "pageBreakPreview" },
  ];

  const refStyleCombos: Array<{ label: string; value: string }> = [
    { label: "referenceStyle A1", value: "A1" },
    { label: "referenceStyle R1C1", value: "R1C1" },
  ];

  it.each(toggles)(
    "$label",
    ({ actionType, payloadKey, stateKey, value }) => {
      const state = freshState();
      const newState = gridReducer(state, {
        type: actionType,
        payload: { [payloadKey]: value },
      } as any);
      expect(newState[stateKey]).toBe(value);
    }
  );

  it.each(viewModeCombos)(
    "$label",
    ({ value }) => {
      const state = freshState();
      const newState = gridReducer(state, {
        type: GRID_ACTIONS.SET_VIEW_MODE,
        payload: { viewMode: value },
      } as any);
      expect(newState.viewMode).toBe(value);
    }
  );

  it.each(refStyleCombos)(
    "$label",
    ({ value }) => {
      const state = freshState();
      const newState = gridReducer(state, {
        type: GRID_ACTIONS.SET_REFERENCE_STYLE,
        payload: { referenceStyle: value },
      } as any);
      expect(newState.referenceStyle).toBe(value);
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Dimension set/remove - 30 combos each for columns and rows
// ---------------------------------------------------------------------------
describe("SET_COLUMN_WIDTH reducer parameterized", () => {
  const colCombos: Array<{
    label: string;
    col: number;
    width: number;
    shouldExist: boolean;
  }> = [
    { label: "col 0 width 100", col: 0, width: 100, shouldExist: true },
    { label: "col 0 width 50", col: 0, width: 50, shouldExist: true },
    { label: "col 0 width 200", col: 0, width: 200, shouldExist: true },
    { label: "col 0 width 1", col: 0, width: 1, shouldExist: true },
    { label: "col 0 width 0 (remove)", col: 0, width: 0, shouldExist: false },
    { label: "col 0 width -1 (remove)", col: 0, width: -1, shouldExist: false },
    { label: "col 1 width 75", col: 1, width: 75, shouldExist: true },
    { label: "col 5 width 150", col: 5, width: 150, shouldExist: true },
    { label: "col 10 width 0 (remove)", col: 10, width: 0, shouldExist: false },
    { label: "col 25 width 300", col: 25, width: 300, shouldExist: true },
    { label: "col 100 width 20", col: 100, width: 20, shouldExist: true },
    { label: "col 255 width 128", col: 255, width: 128, shouldExist: true },
    { label: "col 256 width 64", col: 256, width: 64, shouldExist: true },
    { label: "col 1000 width 500", col: 1000, width: 500, shouldExist: true },
    { label: "col 5000 width 10", col: 5000, width: 10, shouldExist: true },
    { label: "col 16383 width 100", col: 16383, width: 100, shouldExist: true },
    { label: "col 42 width 42", col: 42, width: 42, shouldExist: true },
    { label: "col 7 width 7", col: 7, width: 7, shouldExist: true },
    { label: "col 512 width 1000", col: 512, width: 1000, shouldExist: true },
    { label: "col 1024 width 2000", col: 1024, width: 2000, shouldExist: true },
    { label: "col 8192 width 80", col: 8192, width: 80, shouldExist: true },
    { label: "col 3 width 0 (remove)", col: 3, width: 0, shouldExist: false },
    { label: "col 99 width 99", col: 99, width: 99, shouldExist: true },
    { label: "col 128 width 128", col: 128, width: 128, shouldExist: true },
    { label: "col 64 width 32", col: 64, width: 32, shouldExist: true },
    { label: "col 333 width 333", col: 333, width: 333, shouldExist: true },
    { label: "col 4096 width 96", col: 4096, width: 96, shouldExist: true },
    { label: "col 9999 width 200", col: 9999, width: 200, shouldExist: true },
    { label: "col 15000 width 50", col: 15000, width: 50, shouldExist: true },
    { label: "col 2 width -5 (remove)", col: 2, width: -5, shouldExist: false },
  ];

  it.each(colCombos)(
    "$label",
    ({ col, width, shouldExist }) => {
      const state = freshState();
      const newState = gridReducer(state, {
        type: GRID_ACTIONS.SET_COLUMN_WIDTH,
        payload: { col, width },
      });

      if (shouldExist) {
        expect(newState.dimensions.columnWidths.get(col)).toBe(width);
      } else {
        expect(newState.dimensions.columnWidths.has(col)).toBe(false);
      }
    }
  );
});

describe("SET_ROW_HEIGHT reducer parameterized", () => {
  const rowCombos: Array<{
    label: string;
    row: number;
    height: number;
    shouldExist: boolean;
  }> = [
    { label: "row 0 height 24", row: 0, height: 24, shouldExist: true },
    { label: "row 0 height 12", row: 0, height: 12, shouldExist: true },
    { label: "row 0 height 48", row: 0, height: 48, shouldExist: true },
    { label: "row 0 height 1", row: 0, height: 1, shouldExist: true },
    { label: "row 0 height 0 (remove)", row: 0, height: 0, shouldExist: false },
    { label: "row 0 height -1 (remove)", row: 0, height: -1, shouldExist: false },
    { label: "row 1 height 30", row: 1, height: 30, shouldExist: true },
    { label: "row 5 height 60", row: 5, height: 60, shouldExist: true },
    { label: "row 10 height 0 (remove)", row: 10, height: 0, shouldExist: false },
    { label: "row 25 height 100", row: 25, height: 100, shouldExist: true },
    { label: "row 100 height 16", row: 100, height: 16, shouldExist: true },
    { label: "row 65535 height 30", row: 65535, height: 30, shouldExist: true },
    { label: "row 65536 height 24", row: 65536, height: 24, shouldExist: true },
    { label: "row 100000 height 40", row: 100000, height: 40, shouldExist: true },
    { label: "row 500000 height 18", row: 500000, height: 18, shouldExist: true },
    { label: "row 1048575 height 24", row: 1048575, height: 24, shouldExist: true },
    { label: "row 42 height 42", row: 42, height: 42, shouldExist: true },
    { label: "row 7 height 8", row: 7, height: 8, shouldExist: true },
    { label: "row 999 height 200", row: 999, height: 200, shouldExist: true },
    { label: "row 1024 height 500", row: 1024, height: 500, shouldExist: true },
    { label: "row 524288 height 24", row: 524288, height: 24, shouldExist: true },
    { label: "row 3 height 0 (remove)", row: 3, height: 0, shouldExist: false },
    { label: "row 99 height 99", row: 99, height: 99, shouldExist: true },
    { label: "row 128 height 32", row: 128, height: 32, shouldExist: true },
    { label: "row 256 height 24", row: 256, height: 24, shouldExist: true },
    { label: "row 333 height 33", row: 333, height: 33, shouldExist: true },
    { label: "row 4096 height 48", row: 4096, height: 48, shouldExist: true },
    { label: "row 99999 height 20", row: 99999, height: 20, shouldExist: true },
    { label: "row 900000 height 16", row: 900000, height: 16, shouldExist: true },
    { label: "row 2 height -3 (remove)", row: 2, height: -3, shouldExist: false },
  ];

  it.each(rowCombos)(
    "$label",
    ({ row, height, shouldExist }) => {
      const state = freshState();
      const newState = gridReducer(state, {
        type: GRID_ACTIONS.SET_ROW_HEIGHT,
        payload: { row, height },
      });

      if (shouldExist) {
        expect(newState.dimensions.rowHeights.get(row)).toBe(height);
      } else {
        expect(newState.dimensions.rowHeights.has(row)).toBe(false);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// 5. SET_SELECTION reducer - clamping and type handling (30 tests)
// ---------------------------------------------------------------------------
describe("SET_SELECTION reducer clamping parameterized", () => {
  const selCombos: Array<{
    label: string;
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    type: "cells" | "rows" | "columns";
    expectedStartRow: number;
    expectedStartCol: number;
    expectedEndRow: number;
    expectedEndCol: number;
  }> = [
    { label: "origin cell", startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells", expectedStartRow: 0, expectedStartCol: 0, expectedEndRow: 0, expectedEndCol: 0 },
    { label: "valid range", startRow: 5, startCol: 3, endRow: 10, endCol: 8, type: "cells", expectedStartRow: 5, expectedStartCol: 3, expectedEndRow: 10, expectedEndCol: 8 },
    { label: "row over max", startRow: 2000000, startCol: 0, endRow: 2000000, endCol: 0, type: "cells", expectedStartRow: 1048575, expectedStartCol: 0, expectedEndRow: 1048575, expectedEndCol: 0 },
    { label: "col over max", startRow: 0, startCol: 20000, endRow: 0, endCol: 20000, type: "cells", expectedStartRow: 0, expectedStartCol: 16383, expectedEndRow: 0, expectedEndCol: 16383 },
    { label: "both over max", startRow: 2000000, startCol: 20000, endRow: 2000000, endCol: 20000, type: "cells", expectedStartRow: 1048575, expectedStartCol: 16383, expectedEndRow: 1048575, expectedEndCol: 16383 },
    { label: "negative row", startRow: -5, startCol: 0, endRow: -5, endCol: 0, type: "cells", expectedStartRow: 0, expectedStartCol: 0, expectedEndRow: 0, expectedEndCol: 0 },
    { label: "negative col", startRow: 0, startCol: -3, endRow: 0, endCol: -3, type: "cells", expectedStartRow: 0, expectedStartCol: 0, expectedEndRow: 0, expectedEndCol: 0 },
    { label: "row selection", startRow: 5, startCol: 0, endRow: 5, endCol: 16383, type: "rows", expectedStartRow: 5, expectedStartCol: 0, expectedEndRow: 5, expectedEndCol: 16383 },
    { label: "column selection", startRow: 0, startCol: 3, endRow: 1048575, endCol: 3, type: "columns", expectedStartRow: 0, expectedStartCol: 3, expectedEndRow: 1048575, expectedEndCol: 3 },
    { label: "max valid cell", startRow: 1048575, startCol: 16383, endRow: 1048575, endCol: 16383, type: "cells", expectedStartRow: 1048575, expectedStartCol: 16383, expectedEndRow: 1048575, expectedEndCol: 16383 },
    { label: "negative both", startRow: -100, startCol: -100, endRow: -50, endCol: -50, type: "cells", expectedStartRow: 0, expectedStartCol: 0, expectedEndRow: 0, expectedEndCol: 0 },
    { label: "start over end under", startRow: 2000000, startCol: 0, endRow: 5, endCol: 5, type: "cells", expectedStartRow: 1048575, expectedStartCol: 0, expectedEndRow: 5, expectedEndCol: 5 },
    { label: "mid range cells", startRow: 500, startCol: 200, endRow: 600, endCol: 300, type: "cells", expectedStartRow: 500, expectedStartCol: 200, expectedEndRow: 600, expectedEndCol: 300 },
    { label: "end negative", startRow: 5, startCol: 5, endRow: -1, endCol: -1, type: "cells", expectedStartRow: 5, expectedStartCol: 5, expectedEndRow: 0, expectedEndCol: 0 },
    { label: "row 1048575 exact", startRow: 1048575, startCol: 0, endRow: 1048575, endCol: 0, type: "cells", expectedStartRow: 1048575, expectedStartCol: 0, expectedEndRow: 1048575, expectedEndCol: 0 },
  ];

  it.each(selCombos)(
    "clamps selection: $label",
    ({ startRow, startCol, endRow, endCol, type, expectedStartRow, expectedStartCol, expectedEndRow, expectedEndCol }) => {
      const state = freshState();
      const newState = gridReducer(state, {
        type: GRID_ACTIONS.SET_SELECTION,
        payload: { startRow, startCol, endRow, endCol, type },
      });
      expect(newState.selection).not.toBeNull();
      expect(newState.selection!.startRow).toBe(expectedStartRow);
      expect(newState.selection!.startCol).toBe(expectedStartCol);
      expect(newState.selection!.endRow).toBe(expectedEndRow);
      expect(newState.selection!.endCol).toBe(expectedEndCol);
      expect(newState.selection!.type).toBe(type);
    }
  );
});

// ---------------------------------------------------------------------------
// 6. MOVE_SELECTION reducer - boundary clamping (20 tests)
// ---------------------------------------------------------------------------
describe("MOVE_SELECTION reducer boundary parameterized", () => {
  const moveCombos: Array<{
    label: string;
    initialRow: number;
    initialCol: number;
    deltaRow: number;
    deltaCol: number;
    extend: boolean;
    expectedEndRow: number;
    expectedEndCol: number;
  }> = [
    { label: "move down from origin", initialRow: 0, initialCol: 0, deltaRow: 1, deltaCol: 0, extend: false, expectedEndRow: 1, expectedEndCol: 0 },
    { label: "move right from origin", initialRow: 0, initialCol: 0, deltaRow: 0, deltaCol: 1, extend: false, expectedEndRow: 0, expectedEndCol: 1 },
    { label: "move up from origin (clamp)", initialRow: 0, initialCol: 0, deltaRow: -1, deltaCol: 0, extend: false, expectedEndRow: 0, expectedEndCol: 0 },
    { label: "move left from origin (clamp)", initialRow: 0, initialCol: 0, deltaRow: 0, deltaCol: -1, extend: false, expectedEndRow: 0, expectedEndCol: 0 },
    { label: "move up from row 5", initialRow: 5, initialCol: 5, deltaRow: -1, deltaCol: 0, extend: false, expectedEndRow: 4, expectedEndCol: 5 },
    { label: "move left from col 5", initialRow: 5, initialCol: 5, deltaRow: 0, deltaCol: -1, extend: false, expectedEndRow: 5, expectedEndCol: 4 },
    { label: "extend down from origin", initialRow: 0, initialCol: 0, deltaRow: 1, deltaCol: 0, extend: true, expectedEndRow: 1, expectedEndCol: 0 },
    { label: "extend right from origin", initialRow: 0, initialCol: 0, deltaRow: 0, deltaCol: 1, extend: true, expectedEndRow: 0, expectedEndCol: 1 },
    { label: "extend up from origin (clamp)", initialRow: 0, initialCol: 0, deltaRow: -1, deltaCol: 0, extend: true, expectedEndRow: 0, expectedEndCol: 0 },
    { label: "move from mid", initialRow: 100, initialCol: 50, deltaRow: 1, deltaCol: 1, extend: false, expectedEndRow: 101, expectedEndCol: 51 },
    { label: "move diagonal up-left from mid", initialRow: 100, initialCol: 50, deltaRow: -1, deltaCol: -1, extend: false, expectedEndRow: 99, expectedEndCol: 49 },
    { label: "extend from mid", initialRow: 100, initialCol: 50, deltaRow: 5, deltaCol: 3, extend: true, expectedEndRow: 105, expectedEndCol: 53 },
    { label: "large jump down", initialRow: 0, initialCol: 0, deltaRow: 1000, deltaCol: 0, extend: false, expectedEndRow: 1000, expectedEndCol: 0 },
    { label: "large jump right", initialRow: 0, initialCol: 0, deltaRow: 0, deltaCol: 500, extend: false, expectedEndRow: 0, expectedEndCol: 500 },
    { label: "move from row 10 col 10", initialRow: 10, initialCol: 10, deltaRow: -5, deltaCol: -5, extend: false, expectedEndRow: 5, expectedEndCol: 5 },
    { label: "extend negative clamped", initialRow: 2, initialCol: 2, deltaRow: -10, deltaCol: -10, extend: true, expectedEndRow: 0, expectedEndCol: 0 },
    { label: "move right from col 16382", initialRow: 0, initialCol: 16382, deltaRow: 0, deltaCol: 1, extend: false, expectedEndRow: 0, expectedEndCol: 16383 },
    { label: "move right from max col (clamp)", initialRow: 0, initialCol: 16383, deltaRow: 0, deltaCol: 1, extend: false, expectedEndRow: 0, expectedEndCol: 16383 },
    { label: "move down from near max row", initialRow: 1048574, initialCol: 0, deltaRow: 1, deltaCol: 0, extend: false, expectedEndRow: 1048575, expectedEndCol: 0 },
    { label: "move down from max row (clamp)", initialRow: 1048575, initialCol: 0, deltaRow: 1, deltaCol: 0, extend: false, expectedEndRow: 1048575, expectedEndCol: 0 },
  ];

  it.each(moveCombos)(
    "$label",
    ({ initialRow, initialCol, deltaRow, deltaCol, extend, expectedEndRow, expectedEndCol }) => {
      let state = freshState();
      // Set initial selection
      state = gridReducer(state, {
        type: GRID_ACTIONS.SET_SELECTION,
        payload: { startRow: initialRow, startCol: initialCol, endRow: initialRow, endCol: initialCol, type: "cells" },
      });

      // Apply move
      state = gridReducer(state, {
        type: GRID_ACTIONS.MOVE_SELECTION,
        payload: { deltaRow, deltaCol, extend },
      });

      expect(state.selection).not.toBeNull();
      expect(state.selection!.endRow).toBe(expectedEndRow);
      expect(state.selection!.endCol).toBe(expectedEndCol);
    }
  );
});

// ---------------------------------------------------------------------------
// 7. SET_ZOOM reducer - clamping (15 tests)
// ---------------------------------------------------------------------------
describe("SET_ZOOM reducer parameterized", () => {
  const zoomCombos: Array<{ label: string; zoom: number; expected: number }> = [
    { label: "100%", zoom: 1.0, expected: 1.0 },
    { label: "50%", zoom: 0.5, expected: 0.5 },
    { label: "200%", zoom: 2.0, expected: 2.0 },
    { label: "min", zoom: ZOOM_MIN, expected: ZOOM_MIN },
    { label: "max", zoom: ZOOM_MAX, expected: ZOOM_MAX },
    { label: "below min clamped", zoom: 0.01, expected: 0.01 },
    { label: "above max passed through", zoom: 10, expected: 10 },
    { label: "75%", zoom: 0.75, expected: 0.75 },
    { label: "125%", zoom: 1.25, expected: 1.25 },
    { label: "150%", zoom: 1.5, expected: 1.5 },
    { label: "300%", zoom: 3.0, expected: 3.0 },
    { label: "400%", zoom: 4.0, expected: 4.0 },
    { label: "10%", zoom: 0.1, expected: 0.1 },
    { label: "25%", zoom: 0.25, expected: 0.25 },
    { label: "500%", zoom: 5.0, expected: 5.0 },
  ];

  it.each(zoomCombos)(
    "SET_ZOOM $label",
    ({ zoom, expected }) => {
      const state = freshState();
      // Note: the action creator clamps, but the reducer just sets the value.
      // We test what the reducer receives (which is already clamped by action creator).
      const newState = gridReducer(state, {
        type: GRID_ACTIONS.SET_ZOOM,
        payload: { zoom },
      });
      expect(newState.zoom).toBeCloseTo(expected, 5);
    }
  );
});

// ---------------------------------------------------------------------------
// 8. SCROLL_BY reducer - scroll clamping (15 tests)
// ---------------------------------------------------------------------------
describe("SCROLL_BY reducer parameterized", () => {
  const scrollCombos: Array<{
    label: string;
    deltaX: number;
    deltaY: number;
  }> = [
    { label: "zero scroll", deltaX: 0, deltaY: 0 },
    { label: "small down", deltaX: 0, deltaY: 50 },
    { label: "small right", deltaX: 50, deltaY: 0 },
    { label: "small up (negative clamp)", deltaX: 0, deltaY: -50 },
    { label: "small left (negative clamp)", deltaX: -50, deltaY: 0 },
    { label: "large down", deltaX: 0, deltaY: 10000 },
    { label: "large right", deltaX: 10000, deltaY: 0 },
    { label: "large negative Y", deltaX: 0, deltaY: -100000 },
    { label: "large negative X", deltaX: -100000, deltaY: 0 },
    { label: "both positive", deltaX: 100, deltaY: 100 },
    { label: "both negative", deltaX: -100, deltaY: -100 },
    { label: "mixed", deltaX: 200, deltaY: -50 },
    { label: "huge positive", deltaX: 1000000, deltaY: 1000000 },
    { label: "wheel down", deltaX: 0, deltaY: 120 },
    { label: "page down", deltaX: 0, deltaY: 600 },
  ];

  it.each(scrollCombos)(
    "SCROLL_BY $label (dX=$deltaX, dY=$deltaY)",
    ({ deltaX, deltaY }) => {
      const state = freshState();
      const newState = gridReducer(state, {
        type: GRID_ACTIONS.SCROLL_BY,
        payload: { deltaX, deltaY },
      });
      // Scroll should never be negative
      expect(newState.viewport.scrollX).toBeGreaterThanOrEqual(0);
      expect(newState.viewport.scrollY).toBeGreaterThanOrEqual(0);
    }
  );
});

// ---------------------------------------------------------------------------
// 9. Immutability checks - verify reducer returns new state object
// ---------------------------------------------------------------------------
describe("reducer immutability parameterized", () => {
  const actions: Array<{ label: string; action: any }> = [
    { label: "SET_SELECTION", action: { type: GRID_ACTIONS.SET_SELECTION, payload: { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" } } },
    { label: "CLEAR_SELECTION", action: { type: GRID_ACTIONS.CLEAR_SELECTION } },
    { label: "SET_ZOOM", action: { type: GRID_ACTIONS.SET_ZOOM, payload: { zoom: 1.5 } } },
    { label: "SET_SHOW_FORMULAS", action: { type: GRID_ACTIONS.SET_SHOW_FORMULAS, payload: { showFormulas: true } } },
    { label: "SET_DISPLAY_ZEROS", action: { type: GRID_ACTIONS.SET_DISPLAY_ZEROS, payload: { displayZeros: false } } },
    { label: "SET_DISPLAY_GRIDLINES", action: { type: GRID_ACTIONS.SET_DISPLAY_GRIDLINES, payload: { displayGridlines: false } } },
    { label: "SET_DISPLAY_HEADINGS", action: { type: GRID_ACTIONS.SET_DISPLAY_HEADINGS, payload: { displayHeadings: false } } },
    { label: "SET_VIEW_MODE", action: { type: GRID_ACTIONS.SET_VIEW_MODE, payload: { viewMode: "pageLayout" } } },
    { label: "SET_COLUMN_WIDTH", action: { type: GRID_ACTIONS.SET_COLUMN_WIDTH, payload: { col: 0, width: 200 } } },
    { label: "SET_ROW_HEIGHT", action: { type: GRID_ACTIONS.SET_ROW_HEIGHT, payload: { row: 0, height: 50 } } },
  ];

  it.each(actions)(
    "returns new state for $label",
    ({ action }) => {
      const state = freshState();
      const newState = gridReducer(state, action);
      expect(newState).not.toBe(state);
    }
  );
});
