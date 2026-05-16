//! FILENAME: app/src/core/state/__tests__/gridState-defaults.test.ts
// PURPOSE: Tests for grid state initialization and default value chains.

import { describe, it, expect } from "vitest";
import { getInitialState } from "../gridReducer";
import {
  DEFAULT_GRID_CONFIG,
  ZOOM_DEFAULT,
  DEFAULT_VIRTUAL_BOUNDS,
  DEFAULT_FREEZE_CONFIG,
  DEFAULT_SPLIT_CONFIG,
} from "../../types/types";

// ============================================================================
// getInitialState returns all expected fields
// ============================================================================

describe("getInitialState - all fields present", () => {
  it("returns an object with all top-level GridState keys", () => {
    const state = getInitialState();
    const expectedKeys = [
      "selection", "editing", "viewport", "config", "viewportDimensions",
      "virtualBounds", "formulaReferences", "dimensions", "clipboard",
      "sheetContext", "freezeConfig", "splitConfig", "splitViewport",
      "viewMode", "zoom", "showFormulas", "displayZeros", "displayGridlines",
      "displayHeadings", "displayFormulaBar", "referenceStyle",
    ];
    for (const key of expectedKeys) {
      expect(key in state).toBe(true);
    }
  });

  it("no top-level field is undefined", () => {
    const state = getInitialState();
    for (const [key, value] of Object.entries(state)) {
      expect(value).not.toBeUndefined();
    }
  });
});

// ============================================================================
// Default selection is at origin
// ============================================================================

describe("getInitialState - selection at origin", () => {
  it("selection starts at row 0, col 0", () => {
    const { selection } = getInitialState();
    expect(selection.startRow).toBe(0);
    expect(selection.startCol).toBe(0);
  });

  it("selection end is also at origin (single cell)", () => {
    const { selection } = getInitialState();
    expect(selection.endRow).toBe(0);
    expect(selection.endCol).toBe(0);
  });

  it("selection type is cells", () => {
    const { selection } = getInitialState();
    expect(selection.type).toBe("cells");
  });
});

// ============================================================================
// Default zoom is 100% (1.0)
// ============================================================================

describe("getInitialState - zoom", () => {
  it("zoom equals ZOOM_DEFAULT constant", () => {
    const state = getInitialState();
    expect(state.zoom).toBe(ZOOM_DEFAULT);
  });

  it("ZOOM_DEFAULT is 1.0 (100%)", () => {
    expect(ZOOM_DEFAULT).toBe(1.0);
  });
});

// ============================================================================
// Default viewport is defined
// ============================================================================

describe("getInitialState - viewport", () => {
  it("viewport has all required fields", () => {
    const { viewport } = getInitialState();
    expect(typeof viewport.startRow).toBe("number");
    expect(typeof viewport.startCol).toBe("number");
    expect(typeof viewport.rowCount).toBe("number");
    expect(typeof viewport.colCount).toBe("number");
    expect(typeof viewport.scrollX).toBe("number");
    expect(typeof viewport.scrollY).toBe("number");
  });

  it("viewport starts at origin", () => {
    const { viewport } = getInitialState();
    expect(viewport.startRow).toBe(0);
    expect(viewport.startCol).toBe(0);
    expect(viewport.scrollX).toBe(0);
    expect(viewport.scrollY).toBe(0);
  });

  it("viewport has positive row and column count", () => {
    const { viewport } = getInitialState();
    expect(viewport.rowCount).toBeGreaterThan(0);
    expect(viewport.colCount).toBeGreaterThan(0);
  });
});

// ============================================================================
// All dimension maps are empty initially
// ============================================================================

describe("getInitialState - dimensions empty", () => {
  it("columnWidths map is empty", () => {
    const { dimensions } = getInitialState();
    expect(dimensions.columnWidths.size).toBe(0);
  });

  it("rowHeights map is empty", () => {
    const { dimensions } = getInitialState();
    expect(dimensions.rowHeights.size).toBe(0);
  });

  it("all hidden sets are empty", () => {
    const { dimensions } = getInitialState();
    expect(dimensions.hiddenRows.size).toBe(0);
    expect(dimensions.hiddenCols.size).toBe(0);
    expect(dimensions.manuallyHiddenRows.size).toBe(0);
    expect(dimensions.manuallyHiddenCols.size).toBe(0);
    expect(dimensions.groupHiddenRows.size).toBe(0);
    expect(dimensions.groupHiddenCols.size).toBe(0);
  });
});

// ============================================================================
// Other default values
// ============================================================================

describe("getInitialState - other defaults", () => {
  it("editing is null (no cell being edited)", () => {
    expect(getInitialState().editing).toBeNull();
  });

  it("clipboard mode is none", () => {
    const { clipboard } = getInitialState();
    expect(clipboard.mode).toBe("none");
    expect(clipboard.selection).toBeNull();
    expect(clipboard.sourceSheetIndex).toBeNull();
  });

  it("config matches DEFAULT_GRID_CONFIG", () => {
    expect(getInitialState().config).toEqual(DEFAULT_GRID_CONFIG);
  });

  it("virtualBounds matches DEFAULT_VIRTUAL_BOUNDS", () => {
    expect(getInitialState().virtualBounds).toEqual(DEFAULT_VIRTUAL_BOUNDS);
  });

  it("freezeConfig matches DEFAULT_FREEZE_CONFIG", () => {
    expect(getInitialState().freezeConfig).toEqual(DEFAULT_FREEZE_CONFIG);
  });

  it("splitConfig matches DEFAULT_SPLIT_CONFIG", () => {
    expect(getInitialState().splitConfig).toEqual(DEFAULT_SPLIT_CONFIG);
  });

  it("viewMode is normal", () => {
    expect(getInitialState().viewMode).toBe("normal");
  });

  it("showFormulas is false", () => {
    expect(getInitialState().showFormulas).toBe(false);
  });

  it("display flags default to true", () => {
    const state = getInitialState();
    expect(state.displayZeros).toBe(true);
    expect(state.displayGridlines).toBe(true);
    expect(state.displayHeadings).toBe(true);
    expect(state.displayFormulaBar).toBe(true);
  });

  it("referenceStyle defaults to A1", () => {
    expect(getInitialState().referenceStyle).toBe("A1");
  });

  it("formulaReferences is empty array", () => {
    expect(getInitialState().formulaReferences).toEqual([]);
  });

  it("sheetContext starts at sheet 0 named Sheet1", () => {
    const { sheetContext } = getInitialState();
    expect(sheetContext.activeSheetIndex).toBe(0);
    expect(sheetContext.activeSheetName).toBe("Sheet1");
  });
});
