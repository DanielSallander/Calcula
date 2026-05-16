import { describe, it, expect } from "vitest";
import { clamp, gridReducer, getInitialState } from "../gridReducer";
import {
  setSelection,
  updateScroll,
  scrollBy,
  setVirtualBounds,
  setHiddenRows,
  setHiddenCols,
  setManuallyHiddenRows,
  setManuallyHiddenCols,
  setGroupHiddenRows,
  setGroupHiddenCols,
  setViewportDimensions,
  setShowFormulas,
  setDisplayZeros,
  setDisplayGridlines,
  setDisplayHeadings,
  setDisplayFormulaBar,
  setReferenceStyle,
  setViewMode,
  setAllDimensions,
  updateConfig,
  scrollToCell,
} from "../gridActions";

// ---------------------------------------------------------------------------
// 1. clamp with edge values
// ---------------------------------------------------------------------------
describe("gridReducer-advanced - clamp edge cases", () => {
  it("clamps Number.MIN_SAFE_INTEGER to min", () => {
    expect(clamp(Number.MIN_SAFE_INTEGER, 0, 100)).toBe(0);
  });

  it("clamps Number.MAX_SAFE_INTEGER to max", () => {
    expect(clamp(Number.MAX_SAFE_INTEGER, 0, 100)).toBe(100);
  });

  it("handles -Infinity", () => {
    expect(clamp(-Infinity, 0, 100)).toBe(0);
  });

  it("handles Infinity", () => {
    expect(clamp(Infinity, 0, 100)).toBe(100);
  });

  it("handles NaN - returns NaN (Math.max/min behavior)", () => {
    // NaN propagates through Math.max/Math.min
    expect(clamp(NaN, 0, 100)).toBeNaN();
  });

  it("handles zero range (min === max === 0)", () => {
    expect(clamp(5, 0, 0)).toBe(0);
    expect(clamp(-5, 0, 0)).toBe(0);
  });

  it("handles very large range", () => {
    const big = 1e15;
    expect(clamp(500, -big, big)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 2. Hidden rows/cols union logic
// ---------------------------------------------------------------------------
describe("gridReducer-advanced - hidden rows/cols", () => {
  function createState() {
    const state = getInitialState();
    state.viewportDimensions = { width: 1000, height: 600 };
    return state;
  }

  it("SET_HIDDEN_ROWS creates a Set of hidden rows", () => {
    let state = createState();
    state = gridReducer(state, setHiddenRows([1, 3, 5]));

    expect(state.dimensions.hiddenRows).toBeDefined();
    expect(state.dimensions.hiddenRows!.has(1)).toBe(true);
    expect(state.dimensions.hiddenRows!.has(3)).toBe(true);
    expect(state.dimensions.hiddenRows!.has(5)).toBe(true);
    expect(state.dimensions.hiddenRows!.has(2)).toBe(false);
  });

  it("SET_HIDDEN_COLS creates a Set of hidden cols", () => {
    let state = createState();
    state = gridReducer(state, setHiddenCols([0, 4]));

    expect(state.dimensions.hiddenCols!.has(0)).toBe(true);
    expect(state.dimensions.hiddenCols!.has(4)).toBe(true);
    expect(state.dimensions.hiddenCols!.size).toBe(2);
  });

  it("SET_MANUALLY_HIDDEN_ROWS unions with filter-hidden rows", () => {
    let state = createState();
    // First set some filter-hidden rows
    state = gridReducer(state, setHiddenRows([1, 2, 3]));
    // Then manually hide row 5
    state = gridReducer(state, setManuallyHiddenRows([5]));

    // Combined should have filter rows (1,2,3) + manual (5)
    expect(state.dimensions.hiddenRows!.has(1)).toBe(true);
    expect(state.dimensions.hiddenRows!.has(5)).toBe(true);
    expect(state.dimensions.manuallyHiddenRows!.has(5)).toBe(true);
  });

  it("SET_MANUALLY_HIDDEN_COLS unions with group-hidden cols", () => {
    let state = createState();
    state = gridReducer(state, setGroupHiddenCols([2, 3]));
    state = gridReducer(state, setManuallyHiddenCols([7]));

    expect(state.dimensions.hiddenCols!.has(2)).toBe(true);
    expect(state.dimensions.hiddenCols!.has(3)).toBe(true);
    expect(state.dimensions.hiddenCols!.has(7)).toBe(true);
  });

  it("SET_GROUP_HIDDEN_ROWS unions with manually-hidden and filter-hidden", () => {
    let state = createState();
    state = gridReducer(state, setHiddenRows([1])); // filter
    state = gridReducer(state, setManuallyHiddenRows([5])); // manual
    state = gridReducer(state, setGroupHiddenRows([10, 11])); // group

    expect(state.dimensions.hiddenRows!.has(1)).toBe(true);
    expect(state.dimensions.hiddenRows!.has(5)).toBe(true);
    expect(state.dimensions.hiddenRows!.has(10)).toBe(true);
    expect(state.dimensions.hiddenRows!.has(11)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Display toggles
// ---------------------------------------------------------------------------
describe("gridReducer-advanced - display toggles", () => {
  function createState() {
    return getInitialState();
  }

  it("SET_SHOW_FORMULAS toggles on", () => {
    let state = createState();
    expect(state.showFormulas).toBe(false);
    state = gridReducer(state, setShowFormulas(true));
    expect(state.showFormulas).toBe(true);
  });

  it("SET_DISPLAY_ZEROS toggles off", () => {
    let state = createState();
    expect(state.displayZeros).toBe(true);
    state = gridReducer(state, setDisplayZeros(false));
    expect(state.displayZeros).toBe(false);
  });

  it("SET_DISPLAY_GRIDLINES toggles off", () => {
    let state = createState();
    state = gridReducer(state, setDisplayGridlines(false));
    expect(state.displayGridlines).toBe(false);
  });

  it("SET_DISPLAY_HEADINGS toggles off", () => {
    let state = createState();
    state = gridReducer(state, setDisplayHeadings(false));
    expect(state.displayHeadings).toBe(false);
  });

  it("SET_DISPLAY_FORMULA_BAR toggles off", () => {
    let state = createState();
    state = gridReducer(state, setDisplayFormulaBar(false));
    expect(state.displayFormulaBar).toBe(false);
  });

  it("SET_REFERENCE_STYLE switches to R1C1", () => {
    let state = createState();
    expect(state.referenceStyle).toBe("A1");
    state = gridReducer(state, setReferenceStyle("R1C1"));
    expect(state.referenceStyle).toBe("R1C1");
  });

  it("SET_VIEW_MODE switches to pageLayout", () => {
    let state = createState();
    expect(state.viewMode).toBe("normal");
    state = gridReducer(state, setViewMode("pageLayout"));
    expect(state.viewMode).toBe("pageLayout");
  });
});

// ---------------------------------------------------------------------------
// 4. UPDATE_CONFIG partial merging
// ---------------------------------------------------------------------------
describe("gridReducer-advanced - config updates", () => {
  it("UPDATE_CONFIG merges partial config without overwriting other fields", () => {
    let state = getInitialState();
    const originalWidth = state.config.defaultCellWidth;
    state = gridReducer(state, updateConfig({ defaultCellHeight: 30 }));

    expect(state.config.defaultCellHeight).toBe(30);
    expect(state.config.defaultCellWidth).toBe(originalWidth);
  });
});

// ---------------------------------------------------------------------------
// 5. SET_ALL_DIMENSIONS
// ---------------------------------------------------------------------------
describe("gridReducer-advanced - set all dimensions", () => {
  it("SET_ALL_DIMENSIONS replaces both column and row overrides", () => {
    let state = getInitialState();
    const cols = new Map([[0, 150], [5, 200]]);
    const rows = new Map([[3, 40]]);
    state = gridReducer(state, setAllDimensions(cols, rows));

    expect(state.dimensions.columnWidths.get(0)).toBe(150);
    expect(state.dimensions.columnWidths.get(5)).toBe(200);
    expect(state.dimensions.rowHeights.get(3)).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// 6. SCROLL_TO_CELL
// ---------------------------------------------------------------------------
describe("gridReducer-advanced - scroll to cell", () => {
  it("SCROLL_TO_CELL to origin does not scroll (already visible)", () => {
    let state = getInitialState();
    state.viewportDimensions = { width: 1000, height: 600 };
    const before = { ...state.viewport };
    state = gridReducer(state, scrollToCell(0, 0));

    expect(state.viewport.scrollX).toBe(before.scrollX);
    expect(state.viewport.scrollY).toBe(before.scrollY);
  });

  it("SCROLL_TO_CELL expands virtual bounds when target is far", () => {
    let state = getInitialState();
    state.viewportDimensions = { width: 1000, height: 600 };
    const initialMaxRow = state.virtualBounds.maxRow;
    state = gridReducer(state, scrollToCell(initialMaxRow + 50, 0));

    expect(state.virtualBounds.maxRow).toBeGreaterThan(initialMaxRow);
  });
});

// ---------------------------------------------------------------------------
// 7. getInitialState
// ---------------------------------------------------------------------------
describe("gridReducer-advanced - getInitialState", () => {
  it("returns a valid initial state with default selection at origin", () => {
    const state = getInitialState();
    expect(state.selection).not.toBeNull();
    expect(state.selection!.startRow).toBe(0);
    expect(state.selection!.startCol).toBe(0);
    expect(state.selection!.type).toBe("cells");
  });

  it("initial state has no editing", () => {
    expect(getInitialState().editing).toBeNull();
  });

  it("initial state has default zoom of 1.0", () => {
    expect(getInitialState().zoom).toBe(1.0);
  });

  it("initial state has normal view mode", () => {
    expect(getInitialState().viewMode).toBe("normal");
  });

  it("initial state has A1 reference style", () => {
    expect(getInitialState().referenceStyle).toBe("A1");
  });
});
