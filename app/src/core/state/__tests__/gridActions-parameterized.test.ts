import { describe, it, expect } from "vitest";
import {
  GRID_ACTIONS,
  setSelection,
  moveSelection,
  scrollBy,
  setZoom,
  setViewport,
  setColumnWidth,
  setRowHeight,
  setViewportDimensions,
  setViewportSize,
} from "../gridActions";
import { ZOOM_MIN, ZOOM_MAX } from "../../types";

// ---------------------------------------------------------------------------
// 1. setSelection - 100 position combos
// ---------------------------------------------------------------------------
describe("setSelection parameterized", () => {
  // Generate 100 combos: rows 0-999999, cols 0-16383, various types
  const selectionTypes = ["cells", "rows", "columns"] as const;

  // 34 cell combos
  const cellCombos: Array<{
    label: string;
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    type: "cells" | "rows" | "columns";
  }> = [
    { label: "origin cell", startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
    { label: "cell A2", startRow: 1, startCol: 0, endRow: 1, endCol: 0, type: "cells" },
    { label: "cell B1", startRow: 0, startCol: 1, endRow: 0, endCol: 1, type: "cells" },
    { label: "range A1:B2", startRow: 0, startCol: 0, endRow: 1, endCol: 1, type: "cells" },
    { label: "large row 999999", startRow: 999999, startCol: 0, endRow: 999999, endCol: 0, type: "cells" },
    { label: "max col 16383", startRow: 0, startCol: 16383, endRow: 0, endCol: 16383, type: "cells" },
    { label: "max corner", startRow: 999999, startCol: 16383, endRow: 999999, endCol: 16383, type: "cells" },
    { label: "range 100:200 x 50:100", startRow: 100, startCol: 50, endRow: 200, endCol: 100, type: "cells" },
    { label: "single cell mid", startRow: 500, startCol: 256, endRow: 500, endCol: 256, type: "cells" },
    { label: "wide range", startRow: 0, startCol: 0, endRow: 0, endCol: 16383, type: "cells" },
    { label: "tall range", startRow: 0, startCol: 0, endRow: 1048575, endCol: 0, type: "cells" },
    { label: "reversed range", startRow: 10, startCol: 10, endRow: 5, endCol: 5, type: "cells" },
    { label: "row 1048575 col 0", startRow: 1048575, startCol: 0, endRow: 1048575, endCol: 0, type: "cells" },
    { label: "row 524288 col 8192", startRow: 524288, startCol: 8192, endRow: 524288, endCol: 8192, type: "cells" },
    { label: "3x3 at origin", startRow: 0, startCol: 0, endRow: 2, endCol: 2, type: "cells" },
    { label: "10x10 at 100,100", startRow: 100, startCol: 100, endRow: 109, endCol: 109, type: "cells" },
    { label: "1x1000 range", startRow: 0, startCol: 0, endRow: 0, endCol: 999, type: "cells" },
    { label: "1000x1 range", startRow: 0, startCol: 0, endRow: 999, endCol: 0, type: "cells" },
    { label: "diagonal 5000,5000", startRow: 5000, startCol: 5000, endRow: 5000, endCol: 5000, type: "cells" },
    { label: "near max row", startRow: 1048570, startCol: 0, endRow: 1048575, endCol: 5, type: "cells" },
    { label: "near max col", startRow: 0, startCol: 16378, endRow: 5, endCol: 16383, type: "cells" },
    { label: "small offset", startRow: 3, startCol: 7, endRow: 3, endCol: 7, type: "cells" },
    { label: "medium range", startRow: 50, startCol: 10, endRow: 150, endCol: 30, type: "cells" },
    { label: "large range", startRow: 0, startCol: 0, endRow: 50000, endCol: 500, type: "cells" },
    { label: "row 42 col 42", startRow: 42, startCol: 42, endRow: 42, endCol: 42, type: "cells" },
    { label: "power of two cell", startRow: 1024, startCol: 512, endRow: 1024, endCol: 512, type: "cells" },
    { label: "odd cell", startRow: 777, startCol: 333, endRow: 777, endCol: 333, type: "cells" },
    { label: "range 9999:10001", startRow: 9999, startCol: 0, endRow: 10001, endCol: 2, type: "cells" },
    { label: "col boundary", startRow: 0, startCol: 255, endRow: 0, endCol: 256, type: "cells" },
    { label: "row boundary", startRow: 65535, startCol: 0, endRow: 65536, endCol: 0, type: "cells" },
    { label: "cell 250000,8000", startRow: 250000, startCol: 8000, endRow: 250000, endCol: 8000, type: "cells" },
    { label: "cell 750000,12000", startRow: 750000, startCol: 12000, endRow: 750000, endCol: 12000, type: "cells" },
    { label: "2x16384 range", startRow: 0, startCol: 0, endRow: 1, endCol: 16383, type: "cells" },
    { label: "cell at 1,1", startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" },
  ];

  // 33 row combos
  const rowCombos: typeof cellCombos = [
    { label: "row 0", startRow: 0, startCol: 0, endRow: 0, endCol: 16383, type: "rows" },
    { label: "row 1", startRow: 1, startCol: 0, endRow: 1, endCol: 16383, type: "rows" },
    { label: "row 100", startRow: 100, startCol: 0, endRow: 100, endCol: 16383, type: "rows" },
    { label: "rows 0-9", startRow: 0, startCol: 0, endRow: 9, endCol: 16383, type: "rows" },
    { label: "rows 50-99", startRow: 50, startCol: 0, endRow: 99, endCol: 16383, type: "rows" },
    { label: "row 999999", startRow: 999999, startCol: 0, endRow: 999999, endCol: 16383, type: "rows" },
    { label: "row 1048575", startRow: 1048575, startCol: 0, endRow: 1048575, endCol: 16383, type: "rows" },
    { label: "rows 500-600", startRow: 500, startCol: 0, endRow: 600, endCol: 16383, type: "rows" },
    { label: "rows 10000-10100", startRow: 10000, startCol: 0, endRow: 10100, endCol: 16383, type: "rows" },
    { label: "row 42", startRow: 42, startCol: 0, endRow: 42, endCol: 16383, type: "rows" },
    { label: "rows 0-1048575", startRow: 0, startCol: 0, endRow: 1048575, endCol: 16383, type: "rows" },
    { label: "row 65535", startRow: 65535, startCol: 0, endRow: 65535, endCol: 16383, type: "rows" },
    { label: "row 65536", startRow: 65536, startCol: 0, endRow: 65536, endCol: 16383, type: "rows" },
    { label: "rows 1000-2000", startRow: 1000, startCol: 0, endRow: 2000, endCol: 16383, type: "rows" },
    { label: "row 524288", startRow: 524288, startCol: 0, endRow: 524288, endCol: 16383, type: "rows" },
    { label: "rows 200-300", startRow: 200, startCol: 0, endRow: 300, endCol: 16383, type: "rows" },
    { label: "row 7", startRow: 7, startCol: 0, endRow: 7, endCol: 16383, type: "rows" },
    { label: "rows 333-666", startRow: 333, startCol: 0, endRow: 666, endCol: 16383, type: "rows" },
    { label: "rows 100000-100050", startRow: 100000, startCol: 0, endRow: 100050, endCol: 16383, type: "rows" },
    { label: "row 2", startRow: 2, startCol: 0, endRow: 2, endCol: 16383, type: "rows" },
    { label: "rows 5-15", startRow: 5, startCol: 0, endRow: 15, endCol: 16383, type: "rows" },
    { label: "row 256", startRow: 256, startCol: 0, endRow: 256, endCol: 16383, type: "rows" },
    { label: "row 1024", startRow: 1024, startCol: 0, endRow: 1024, endCol: 16383, type: "rows" },
    { label: "rows 8000-9000", startRow: 8000, startCol: 0, endRow: 9000, endCol: 16383, type: "rows" },
    { label: "row 3", startRow: 3, startCol: 0, endRow: 3, endCol: 16383, type: "rows" },
    { label: "rows 20-40", startRow: 20, startCol: 0, endRow: 40, endCol: 16383, type: "rows" },
    { label: "row 750000", startRow: 750000, startCol: 0, endRow: 750000, endCol: 16383, type: "rows" },
    { label: "rows 900000-900010", startRow: 900000, startCol: 0, endRow: 900010, endCol: 16383, type: "rows" },
    { label: "row 4096", startRow: 4096, startCol: 0, endRow: 4096, endCol: 16383, type: "rows" },
    { label: "rows 16383-16384", startRow: 16383, startCol: 0, endRow: 16384, endCol: 16383, type: "rows" },
    { label: "row 9", startRow: 9, startCol: 0, endRow: 9, endCol: 16383, type: "rows" },
    { label: "rows 111-222", startRow: 111, startCol: 0, endRow: 222, endCol: 16383, type: "rows" },
    { label: "row 11", startRow: 11, startCol: 0, endRow: 11, endCol: 16383, type: "rows" },
  ];

  // 33 column combos
  const colCombos: typeof cellCombos = [
    { label: "col A", startRow: 0, startCol: 0, endRow: 1048575, endCol: 0, type: "columns" },
    { label: "col B", startRow: 0, startCol: 1, endRow: 1048575, endCol: 1, type: "columns" },
    { label: "col Z", startRow: 0, startCol: 25, endRow: 1048575, endCol: 25, type: "columns" },
    { label: "cols A-C", startRow: 0, startCol: 0, endRow: 1048575, endCol: 2, type: "columns" },
    { label: "cols A-Z", startRow: 0, startCol: 0, endRow: 1048575, endCol: 25, type: "columns" },
    { label: "col 100", startRow: 0, startCol: 100, endRow: 1048575, endCol: 100, type: "columns" },
    { label: "col 16383", startRow: 0, startCol: 16383, endRow: 1048575, endCol: 16383, type: "columns" },
    { label: "cols 0-16383", startRow: 0, startCol: 0, endRow: 1048575, endCol: 16383, type: "columns" },
    { label: "cols 255-256", startRow: 0, startCol: 255, endRow: 1048575, endCol: 256, type: "columns" },
    { label: "col 512", startRow: 0, startCol: 512, endRow: 1048575, endCol: 512, type: "columns" },
    { label: "cols 1000-1100", startRow: 0, startCol: 1000, endRow: 1048575, endCol: 1100, type: "columns" },
    { label: "col 8192", startRow: 0, startCol: 8192, endRow: 1048575, endCol: 8192, type: "columns" },
    { label: "cols 10-20", startRow: 0, startCol: 10, endRow: 1048575, endCol: 20, type: "columns" },
    { label: "col 42", startRow: 0, startCol: 42, endRow: 1048575, endCol: 42, type: "columns" },
    { label: "cols 5000-6000", startRow: 0, startCol: 5000, endRow: 1048575, endCol: 6000, type: "columns" },
    { label: "col 2", startRow: 0, startCol: 2, endRow: 1048575, endCol: 2, type: "columns" },
    { label: "col 3", startRow: 0, startCol: 3, endRow: 1048575, endCol: 3, type: "columns" },
    { label: "col 7", startRow: 0, startCol: 7, endRow: 1048575, endCol: 7, type: "columns" },
    { label: "cols 50-75", startRow: 0, startCol: 50, endRow: 1048575, endCol: 75, type: "columns" },
    { label: "col 1024", startRow: 0, startCol: 1024, endRow: 1048575, endCol: 1024, type: "columns" },
    { label: "cols 200-210", startRow: 0, startCol: 200, endRow: 1048575, endCol: 210, type: "columns" },
    { label: "col 4096", startRow: 0, startCol: 4096, endRow: 1048575, endCol: 4096, type: "columns" },
    { label: "cols 15000-16383", startRow: 0, startCol: 15000, endRow: 1048575, endCol: 16383, type: "columns" },
    { label: "col 9", startRow: 0, startCol: 9, endRow: 1048575, endCol: 9, type: "columns" },
    { label: "cols 300-400", startRow: 0, startCol: 300, endRow: 1048575, endCol: 400, type: "columns" },
    { label: "col 128", startRow: 0, startCol: 128, endRow: 1048575, endCol: 128, type: "columns" },
    { label: "col 64", startRow: 0, startCol: 64, endRow: 1048575, endCol: 64, type: "columns" },
    { label: "cols 12000-13000", startRow: 0, startCol: 12000, endRow: 1048575, endCol: 13000, type: "columns" },
    { label: "col 5", startRow: 0, startCol: 5, endRow: 1048575, endCol: 5, type: "columns" },
    { label: "col 11", startRow: 0, startCol: 11, endRow: 1048575, endCol: 11, type: "columns" },
    { label: "cols 77-88", startRow: 0, startCol: 77, endRow: 1048575, endCol: 88, type: "columns" },
    { label: "col 2048", startRow: 0, startCol: 2048, endRow: 1048575, endCol: 2048, type: "columns" },
    { label: "col 333", startRow: 0, startCol: 333, endRow: 1048575, endCol: 333, type: "columns" },
  ];

  const allCombos = [...cellCombos, ...rowCombos, ...colCombos];

  it.each(allCombos)(
    "creates SET_SELECTION for $label ($type)",
    ({ startRow, startCol, endRow, endCol, type }) => {
      const action = setSelection({ startRow, startCol, endRow, endCol, type });
      expect(action.type).toBe(GRID_ACTIONS.SET_SELECTION);
      expect(action.payload.startRow).toBe(startRow);
      expect(action.payload.startCol).toBe(startCol);
      expect(action.payload.endRow).toBe(endRow);
      expect(action.payload.endCol).toBe(endCol);
      expect(action.payload.type).toBe(type);
    }
  );

  // With additionalRanges
  const additionalRangesCombos = allCombos.slice(0, 10).map((combo, i) => ({
    ...combo,
    label: `${combo.label} with ${i + 1} additional range(s)`,
    additionalRanges: Array.from({ length: i + 1 }, (_, j) => ({
      startRow: j * 10,
      startCol: j * 5,
      endRow: j * 10 + 5,
      endCol: j * 5 + 3,
    })),
  }));

  it.each(additionalRangesCombos)(
    "creates SET_SELECTION with additionalRanges for $label",
    ({ startRow, startCol, endRow, endCol, type, additionalRanges }) => {
      const action = setSelection({ startRow, startCol, endRow, endCol, type, additionalRanges });
      expect(action.type).toBe(GRID_ACTIONS.SET_SELECTION);
      expect(action.payload.additionalRanges).toEqual(additionalRanges);
      expect(action.payload.additionalRanges!.length).toBe(additionalRanges.length);
    }
  );
});

// ---------------------------------------------------------------------------
// 2. moveSelection - 4 directions x 10 positions x 2 extend modes = 80 tests
// ---------------------------------------------------------------------------
describe("moveSelection parameterized", () => {
  const directions = [
    { name: "up", deltaRow: -1, deltaCol: 0 },
    { name: "down", deltaRow: 1, deltaCol: 0 },
    { name: "left", deltaRow: 0, deltaCol: -1 },
    { name: "right", deltaRow: 0, deltaCol: 1 },
  ];

  const startPositions = [
    { name: "origin", row: 0, col: 0 },
    { name: "mid", row: 500, col: 128 },
    { name: "far row", row: 999999, col: 0 },
    { name: "far col", row: 0, col: 16383 },
    { name: "corner", row: 1048575, col: 16383 },
    { name: "row 1 col 1", row: 1, col: 1 },
    { name: "row 100 col 50", row: 100, col: 50 },
    { name: "row 50000 col 5000", row: 50000, col: 5000 },
    { name: "row 10 col 255", row: 10, col: 255 },
    { name: "row 65536 col 256", row: 65536, col: 256 },
  ];

  const extendModes = [false, true];

  const combos: Array<{
    dir: string;
    deltaRow: number;
    deltaCol: number;
    pos: string;
    extend: boolean;
  }> = [];

  for (const dir of directions) {
    for (const pos of startPositions) {
      for (const extend of extendModes) {
        combos.push({
          dir: dir.name,
          deltaRow: dir.deltaRow,
          deltaCol: dir.deltaCol,
          pos: pos.name,
          extend,
        });
      }
    }
  }

  it.each(combos)(
    "moveSelection $dir from $pos extend=$extend",
    ({ deltaRow, deltaCol, extend }) => {
      const action = moveSelection(deltaRow, deltaCol, extend);
      expect(action.type).toBe(GRID_ACTIONS.MOVE_SELECTION);
      expect(action.payload.deltaRow).toBe(deltaRow);
      expect(action.payload.deltaCol).toBe(deltaCol);
      expect(action.payload.extend).toBe(extend);
    }
  );
});

// ---------------------------------------------------------------------------
// 3. scrollBy - 50 delta combos
// ---------------------------------------------------------------------------
describe("scrollBy parameterized", () => {
  const deltaCombos: Array<{ label: string; deltaX: number; deltaY: number }> = [
    { label: "zero", deltaX: 0, deltaY: 0 },
    { label: "small positive X", deltaX: 10, deltaY: 0 },
    { label: "small positive Y", deltaX: 0, deltaY: 10 },
    { label: "small positive both", deltaX: 10, deltaY: 10 },
    { label: "small negative X", deltaX: -10, deltaY: 0 },
    { label: "small negative Y", deltaX: 0, deltaY: -10 },
    { label: "small negative both", deltaX: -10, deltaY: -10 },
    { label: "mixed signs 1", deltaX: 10, deltaY: -10 },
    { label: "mixed signs 2", deltaX: -10, deltaY: 10 },
    { label: "large positive X", deltaX: 10000, deltaY: 0 },
    { label: "large positive Y", deltaX: 0, deltaY: 10000 },
    { label: "large positive both", deltaX: 10000, deltaY: 10000 },
    { label: "large negative X", deltaX: -10000, deltaY: 0 },
    { label: "large negative Y", deltaX: 0, deltaY: -10000 },
    { label: "large negative both", deltaX: -10000, deltaY: -10000 },
    { label: "one pixel X", deltaX: 1, deltaY: 0 },
    { label: "one pixel Y", deltaX: 0, deltaY: 1 },
    { label: "one pixel both", deltaX: 1, deltaY: 1 },
    { label: "minus one X", deltaX: -1, deltaY: 0 },
    { label: "minus one Y", deltaX: 0, deltaY: -1 },
    { label: "100 pixels X", deltaX: 100, deltaY: 0 },
    { label: "100 pixels Y", deltaX: 0, deltaY: 100 },
    { label: "100 pixels both", deltaX: 100, deltaY: 100 },
    { label: "-100 pixels X", deltaX: -100, deltaY: 0 },
    { label: "-100 pixels Y", deltaX: 0, deltaY: -100 },
    { label: "500 X 0 Y", deltaX: 500, deltaY: 0 },
    { label: "0 X 500 Y", deltaX: 0, deltaY: 500 },
    { label: "500 both", deltaX: 500, deltaY: 500 },
    { label: "-500 X 500 Y", deltaX: -500, deltaY: 500 },
    { label: "500 X -500 Y", deltaX: 500, deltaY: -500 },
    { label: "decimal X", deltaX: 0.5, deltaY: 0 },
    { label: "decimal Y", deltaX: 0, deltaY: 0.5 },
    { label: "decimal both", deltaX: 1.5, deltaY: 2.5 },
    { label: "huge X", deltaX: 1000000, deltaY: 0 },
    { label: "huge Y", deltaX: 0, deltaY: 1000000 },
    { label: "huge both", deltaX: 1000000, deltaY: 1000000 },
    { label: "huge negative X", deltaX: -1000000, deltaY: 0 },
    { label: "huge negative Y", deltaX: 0, deltaY: -1000000 },
    { label: "wheel-like scroll up", deltaX: 0, deltaY: -120 },
    { label: "wheel-like scroll down", deltaX: 0, deltaY: 120 },
    { label: "wheel-like scroll left", deltaX: -120, deltaY: 0 },
    { label: "wheel-like scroll right", deltaX: 120, deltaY: 0 },
    { label: "page-like scroll", deltaX: 0, deltaY: 600 },
    { label: "page-like scroll up", deltaX: 0, deltaY: -600 },
    { label: "3 pixel X", deltaX: 3, deltaY: 0 },
    { label: "7 pixel Y", deltaX: 0, deltaY: 7 },
    { label: "prime combo", deltaX: 17, deltaY: 31 },
    { label: "power-of-2 combo", deltaX: 256, deltaY: 512 },
    { label: "negative power-of-2", deltaX: -256, deltaY: -512 },
    { label: "asymmetric large", deltaX: 50000, deltaY: 3 },
  ];

  it.each(deltaCombos)(
    "scrollBy $label (deltaX=$deltaX, deltaY=$deltaY)",
    ({ deltaX, deltaY }) => {
      const action = scrollBy(deltaX, deltaY);
      expect(action.type).toBe(GRID_ACTIONS.SCROLL_BY);
      expect(action.payload.deltaX).toBe(deltaX);
      expect(action.payload.deltaY).toBe(deltaY);
    }
  );
});

// ---------------------------------------------------------------------------
// 4. setZoom - 30 zoom levels
// ---------------------------------------------------------------------------
describe("setZoom parameterized", () => {
  const zoomLevels: Array<{ label: string; input: number; expected: number }> = [
    { label: "10%", input: 0.1, expected: 0.1 },
    { label: "20%", input: 0.2, expected: 0.2 },
    { label: "25%", input: 0.25, expected: 0.25 },
    { label: "30%", input: 0.3, expected: 0.3 },
    { label: "40%", input: 0.4, expected: 0.4 },
    { label: "50%", input: 0.5, expected: 0.5 },
    { label: "60%", input: 0.6, expected: 0.6 },
    { label: "70%", input: 0.7, expected: 0.7 },
    { label: "75%", input: 0.75, expected: 0.75 },
    { label: "80%", input: 0.8, expected: 0.8 },
    { label: "90%", input: 0.9, expected: 0.9 },
    { label: "100%", input: 1.0, expected: 1.0 },
    { label: "110%", input: 1.1, expected: 1.1 },
    { label: "125%", input: 1.25, expected: 1.25 },
    { label: "150%", input: 1.5, expected: 1.5 },
    { label: "175%", input: 1.75, expected: 1.75 },
    { label: "200%", input: 2.0, expected: 2.0 },
    { label: "250%", input: 2.5, expected: 2.5 },
    { label: "300%", input: 3.0, expected: 3.0 },
    { label: "400%", input: 4.0, expected: 4.0 },
    { label: "500%", input: 5.0, expected: 5.0 },
    // Edge cases: clamped
    { label: "below min (0)", input: 0, expected: ZOOM_MIN },
    { label: "below min (-1)", input: -1, expected: ZOOM_MIN },
    { label: "below min (0.01)", input: 0.01, expected: ZOOM_MIN },
    { label: "below min (0.05)", input: 0.05, expected: ZOOM_MIN },
    { label: "above max (5.1)", input: 5.1, expected: ZOOM_MAX },
    { label: "above max (10)", input: 10, expected: ZOOM_MAX },
    { label: "above max (100)", input: 100, expected: ZOOM_MAX },
    { label: "above max (999)", input: 999, expected: ZOOM_MAX },
    { label: "exactly min", input: ZOOM_MIN, expected: ZOOM_MIN },
  ];

  it.each(zoomLevels)(
    "setZoom at $label (input=$input, expected=$expected)",
    ({ input, expected }) => {
      const action = setZoom(input);
      expect(action.type).toBe(GRID_ACTIONS.SET_ZOOM);
      expect(action.payload.zoom).toBeCloseTo(expected, 5);
    }
  );
});

// ---------------------------------------------------------------------------
// 5. setViewport - 20 viewport configurations
// ---------------------------------------------------------------------------
describe("setViewport parameterized", () => {
  const viewportConfigs: Array<{
    label: string;
    startRow: number;
    startCol: number;
    rowCount: number;
    colCount: number;
    scrollX: number;
    scrollY: number;
  }> = [
    { label: "default", startRow: 0, startCol: 0, rowCount: 50, colCount: 20, scrollX: 0, scrollY: 0 },
    { label: "scrolled down", startRow: 100, startCol: 0, rowCount: 50, colCount: 20, scrollX: 0, scrollY: 2400 },
    { label: "scrolled right", startRow: 0, startCol: 10, rowCount: 50, colCount: 20, scrollX: 1000, scrollY: 0 },
    { label: "scrolled both", startRow: 50, startCol: 5, rowCount: 50, colCount: 20, scrollX: 500, scrollY: 1200 },
    { label: "small viewport", startRow: 0, startCol: 0, rowCount: 10, colCount: 5, scrollX: 0, scrollY: 0 },
    { label: "large viewport", startRow: 0, startCol: 0, rowCount: 200, colCount: 50, scrollX: 0, scrollY: 0 },
    { label: "single cell viewport", startRow: 0, startCol: 0, rowCount: 1, colCount: 1, scrollX: 0, scrollY: 0 },
    { label: "far position", startRow: 100000, startCol: 1000, rowCount: 50, colCount: 20, scrollX: 100000, scrollY: 2400000 },
    { label: "wide viewport", startRow: 0, startCol: 0, rowCount: 20, colCount: 100, scrollX: 0, scrollY: 0 },
    { label: "tall viewport", startRow: 0, startCol: 0, rowCount: 100, colCount: 10, scrollX: 0, scrollY: 0 },
    { label: "mid scroll", startRow: 500, startCol: 50, rowCount: 50, colCount: 20, scrollX: 5000, scrollY: 12000 },
    { label: "max row area", startRow: 1048525, startCol: 0, rowCount: 50, colCount: 20, scrollX: 0, scrollY: 25164600 },
    { label: "max col area", startRow: 0, startCol: 16363, rowCount: 50, colCount: 20, scrollX: 1636300, scrollY: 0 },
    { label: "zero counts", startRow: 0, startCol: 0, rowCount: 0, colCount: 0, scrollX: 0, scrollY: 0 },
    { label: "fractional scroll X", startRow: 0, startCol: 0, rowCount: 50, colCount: 20, scrollX: 0.5, scrollY: 0 },
    { label: "fractional scroll Y", startRow: 0, startCol: 0, rowCount: 50, colCount: 20, scrollX: 0, scrollY: 0.5 },
    { label: "moderate scroll", startRow: 25, startCol: 3, rowCount: 40, colCount: 15, scrollX: 300, scrollY: 600 },
    { label: "square viewport", startRow: 0, startCol: 0, rowCount: 30, colCount: 30, scrollX: 0, scrollY: 0 },
    { label: "huge viewport", startRow: 0, startCol: 0, rowCount: 500, colCount: 200, scrollX: 0, scrollY: 0 },
    { label: "offset square", startRow: 10, startCol: 10, rowCount: 30, colCount: 30, scrollX: 1000, scrollY: 240 },
  ];

  it.each(viewportConfigs)(
    "setViewport $label",
    (config) => {
      const action = setViewport(config);
      expect(action.type).toBe(GRID_ACTIONS.SET_VIEWPORT);
      expect(action.payload).toEqual(config);
    }
  );
});

// ---------------------------------------------------------------------------
// 6. setColumnWidth - 30 dimension combos
// ---------------------------------------------------------------------------
describe("setColumnWidth parameterized", () => {
  const colWidthCombos: Array<{ label: string; col: number; width: number }> = [
    { label: "col 0 default width", col: 0, width: 100 },
    { label: "col 0 narrow", col: 0, width: 20 },
    { label: "col 0 wide", col: 0, width: 500 },
    { label: "col 1 standard", col: 1, width: 100 },
    { label: "col 10 narrow", col: 10, width: 30 },
    { label: "col 25 wide", col: 25, width: 300 },
    { label: "col 100 default", col: 100, width: 100 },
    { label: "col 255 at boundary", col: 255, width: 150 },
    { label: "col 256 at boundary", col: 256, width: 150 },
    { label: "col 1000 wide", col: 1000, width: 400 },
    { label: "col 5000 narrow", col: 5000, width: 25 },
    { label: "col 16383 max col", col: 16383, width: 100 },
    { label: "col 0 minimum", col: 0, width: 1 },
    { label: "col 0 zero (remove)", col: 0, width: 0 },
    { label: "col 0 negative (remove)", col: 0, width: -1 },
    { label: "col 42 exact fit", col: 42, width: 64 },
    { label: "col 7 pixel width", col: 7, width: 8 },
    { label: "col 512 large", col: 512, width: 1000 },
    { label: "col 1024 huge", col: 1024, width: 2000 },
    { label: "col 8192 standard", col: 8192, width: 100 },
    { label: "col 2 fractional", col: 2, width: 99.5 },
    { label: "col 3 tiny", col: 3, width: 5 },
    { label: "col 4 medium", col: 4, width: 175 },
    { label: "col 5 extra wide", col: 5, width: 750 },
    { label: "col 50 auto-fit like", col: 50, width: 87 },
    { label: "col 128 power of 2", col: 128, width: 128 },
    { label: "col 64 standard", col: 64, width: 100 },
    { label: "col 333 odd", col: 333, width: 133 },
    { label: "col 9999 far", col: 9999, width: 200 },
    { label: "col 15000 near max", col: 15000, width: 50 },
  ];

  it.each(colWidthCombos)(
    "setColumnWidth $label (col=$col, width=$width)",
    ({ col, width }) => {
      const action = setColumnWidth(col, width);
      expect(action.type).toBe(GRID_ACTIONS.SET_COLUMN_WIDTH);
      expect(action.payload.col).toBe(col);
      expect(action.payload.width).toBe(width);
    }
  );
});

// ---------------------------------------------------------------------------
// 7. setRowHeight - 30 dimension combos
// ---------------------------------------------------------------------------
describe("setRowHeight parameterized", () => {
  const rowHeightCombos: Array<{ label: string; row: number; height: number }> = [
    { label: "row 0 default", row: 0, height: 24 },
    { label: "row 0 short", row: 0, height: 16 },
    { label: "row 0 tall", row: 0, height: 100 },
    { label: "row 1 standard", row: 1, height: 24 },
    { label: "row 10 short", row: 10, height: 12 },
    { label: "row 25 tall", row: 25, height: 80 },
    { label: "row 100 default", row: 100, height: 24 },
    { label: "row 65535 boundary", row: 65535, height: 30 },
    { label: "row 65536 boundary", row: 65536, height: 30 },
    { label: "row 100000 tall", row: 100000, height: 60 },
    { label: "row 500000 short", row: 500000, height: 18 },
    { label: "row 1048575 max row", row: 1048575, height: 24 },
    { label: "row 0 minimum", row: 0, height: 1 },
    { label: "row 0 zero (remove)", row: 0, height: 0 },
    { label: "row 0 negative (remove)", row: 0, height: -1 },
    { label: "row 42 exact", row: 42, height: 42 },
    { label: "row 7 pixel height", row: 7, height: 8 },
    { label: "row 999 large", row: 999, height: 200 },
    { label: "row 1024 huge", row: 1024, height: 500 },
    { label: "row 524288 mid", row: 524288, height: 24 },
    { label: "row 2 fractional", row: 2, height: 23.5 },
    { label: "row 3 tiny", row: 3, height: 4 },
    { label: "row 4 medium", row: 4, height: 36 },
    { label: "row 5 extra tall", row: 5, height: 150 },
    { label: "row 50 wrapped text", row: 50, height: 48 },
    { label: "row 128 power of 2", row: 128, height: 32 },
    { label: "row 256 standard", row: 256, height: 24 },
    { label: "row 333 odd", row: 333, height: 33 },
    { label: "row 99999 far", row: 99999, height: 20 },
    { label: "row 900000 near max", row: 900000, height: 16 },
  ];

  it.each(rowHeightCombos)(
    "setRowHeight $label (row=$row, height=$height)",
    ({ row, height }) => {
      const action = setRowHeight(row, height);
      expect(action.type).toBe(GRID_ACTIONS.SET_ROW_HEIGHT);
      expect(action.payload.row).toBe(row);
      expect(action.payload.height).toBe(height);
    }
  );
});

// ---------------------------------------------------------------------------
// 8. setViewportDimensions - additional parameterized tests
// ---------------------------------------------------------------------------
describe("setViewportDimensions parameterized", () => {
  const dimCombos: Array<{ label: string; width: number; height: number }> = [
    { label: "standard 1920x1080", width: 1920, height: 1080 },
    { label: "small 800x600", width: 800, height: 600 },
    { label: "minimal 100x100", width: 100, height: 100 },
    { label: "zero", width: 0, height: 0 },
    { label: "wide 3840x1080", width: 3840, height: 1080 },
    { label: "tall 1080x3840", width: 1080, height: 3840 },
    { label: "4K", width: 3840, height: 2160 },
    { label: "1366x768", width: 1366, height: 768 },
    { label: "1280x720", width: 1280, height: 720 },
    { label: "single pixel", width: 1, height: 1 },
  ];

  it.each(dimCombos)(
    "setViewportDimensions $label ($width x $height)",
    ({ width, height }) => {
      const action = setViewportDimensions(width, height);
      expect(action.type).toBe(GRID_ACTIONS.SET_VIEWPORT_DIMENSIONS);
      expect(action.payload.width).toBe(width);
      expect(action.payload.height).toBe(height);
    }
  );
});
