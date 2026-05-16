//! FILENAME: app/src/core/lib/gridRenderer/layout/dimensions-scale.test.ts
// PURPOSE: Scale and stress tests for dimension calculations

import { describe, it, expect } from "vitest";
import { getColumnWidth, getRowHeight, getColumnX, getRowY } from "./dimensions";
import type { GridConfig, DimensionOverrides, InsertionAnimation } from "../../../types";
import { createEmptyDimensionOverrides } from "../../../types";

// ============================================================================
// Test helpers
// ============================================================================

function makeConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 24,
    rowHeaderWidth: 50,
    colHeaderHeight: 24,
    totalRows: 1000,
    totalCols: 1000,
    minColumnWidth: 20,
    minRowHeight: 10,
    outlineBarWidth: 0,
    outlineBarHeight: 0,
    ...overrides,
  } as GridConfig;
}

function makeDims(overrides?: Partial<DimensionOverrides>): DimensionOverrides {
  return { ...createEmptyDimensionOverrides(), ...overrides };
}

// ============================================================================
// 1000 custom column widths - getColumnX accumulation
// ============================================================================

describe("getColumnX with 1000 custom column widths", () => {
  it("accumulates 1000 custom widths correctly", () => {
    const config = makeConfig();
    const dims = makeDims();
    for (let c = 0; c < 1000; c++) {
      dims.columnWidths.set(c, 50 + c); // widths: 50, 51, 52, ...
    }

    // Expected X for col 1000 starting from col 0:
    // rowHeaderWidth + sum(50..1049) = 50 + sum(i=0..999)(50+i)
    // sum = 1000*50 + (999*1000/2) = 50000 + 499500 = 549500
    const expectedX = 50 + 549500;
    expect(getColumnX(1000, config, dims, 0, 0)).toBe(expectedX);
  });

  it("accumulates correctly from a non-zero startCol", () => {
    const config = makeConfig();
    const dims = makeDims();
    for (let c = 0; c < 1000; c++) {
      dims.columnWidths.set(c, 80);
    }

    // col 500 from startCol 200: rowHeaderWidth + 300 * 80 = 50 + 24000 = 24050
    expect(getColumnX(500, config, dims, 200, 0)).toBe(50 + 300 * 80);
  });
});

// ============================================================================
// 1000 custom row heights - getRowY accumulation
// ============================================================================

describe("getRowY with 1000 custom row heights", () => {
  it("accumulates 1000 custom heights correctly", () => {
    const config = makeConfig();
    const dims = makeDims();
    for (let r = 0; r < 1000; r++) {
      dims.rowHeights.set(r, 20 + r);
    }

    // Expected Y for row 1000: colHeaderHeight + sum(20..1019)
    // sum = 1000*20 + (999*1000/2) = 20000 + 499500 = 519500
    const expectedY = 24 + 519500;
    expect(getRowY(1000, config, dims, 0, 0)).toBe(expectedY);
  });

  it("accumulates correctly from a non-zero startRow", () => {
    const config = makeConfig();
    const dims = makeDims();
    for (let r = 0; r < 1000; r++) {
      dims.rowHeights.set(r, 30);
    }

    expect(getRowY(800, config, dims, 300, 0)).toBe(24 + 500 * 30);
  });
});

// ============================================================================
// Alternating hidden/visible columns (500 hidden out of 1000)
// ============================================================================

describe("alternating hidden/visible columns", () => {
  it("skips every other column (500 hidden out of 1000)", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const hiddenCols = new Set<number>();
    for (let c = 0; c < 1000; c += 2) {
      hiddenCols.add(c); // hide even columns
    }
    const dims = makeDims({ hiddenCols });

    // col 1000 from 0: only 500 odd columns visible, each 100px wide
    // X = 50 + 500 * 100 = 50050
    expect(getColumnX(1000, config, dims, 0, 0)).toBe(50 + 500 * 100);
  });

  it("getColumnWidth returns 0 for hidden and default for visible", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const hiddenCols = new Set<number>();
    for (let c = 0; c < 1000; c += 2) {
      hiddenCols.add(c);
    }
    const dims = makeDims({ hiddenCols });

    expect(getColumnWidth(0, config, dims)).toBe(0);
    expect(getColumnWidth(1, config, dims)).toBe(100);
    expect(getColumnWidth(998, config, dims)).toBe(0);
    expect(getColumnWidth(999, config, dims)).toBe(100);
  });
});

// ============================================================================
// All columns hidden except first and last
// ============================================================================

describe("all columns hidden except first and last", () => {
  it("only first and last columns contribute to width", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const hiddenCols = new Set<number>();
    for (let c = 1; c < 999; c++) {
      hiddenCols.add(c);
    }
    const dims = makeDims({ hiddenCols });

    // X at col 1000 from 0: col 0 = 100, cols 1-998 = 0, col 999 = 100
    // total = 50 + 100 + 0*998 + 100 = 250
    expect(getColumnX(1000, config, dims, 0, 0)).toBe(50 + 200);
  });

  it("X at col 500 equals X at col 1 (all middle columns hidden)", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const hiddenCols = new Set<number>();
    for (let c = 1; c < 999; c++) {
      hiddenCols.add(c);
    }
    const dims = makeDims({ hiddenCols });

    expect(getColumnX(500, config, dims, 0, 0)).toBe(getColumnX(1, config, dims, 0, 0));
  });
});

// ============================================================================
// Every column has a different custom width
// ============================================================================

describe("every column has a different custom width", () => {
  it("accumulates unique widths for 1000 columns", () => {
    const config = makeConfig();
    const dims = makeDims();
    for (let c = 0; c < 1000; c++) {
      dims.columnWidths.set(c, 10 + c * 0.5);
    }

    let expected = 50; // rowHeaderWidth
    for (let c = 0; c < 100; c++) {
      expected += 10 + c * 0.5;
    }
    expect(getColumnX(100, config, dims, 0, 0)).toBe(expected);
  });

  it("getColumnWidth returns the correct unique width for each", () => {
    const config = makeConfig();
    const dims = makeDims();
    for (let c = 0; c < 1000; c++) {
      dims.columnWidths.set(c, 30 + c);
    }

    expect(getColumnWidth(0, config, dims)).toBe(30);
    expect(getColumnWidth(500, config, dims)).toBe(530);
    expect(getColumnWidth(999, config, dims)).toBe(1029);
  });
});

// ============================================================================
// Insert/delete animation at 0%, 50%, 100% for columns and rows
// ============================================================================

describe("column insertion animation at different progress levels", () => {
  const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
  const dims = makeDims();
  const baseAnim: Omit<InsertionAnimation, "progress"> = {
    type: "column",
    index: 5,
    count: 3,
    targetSize: 100,
    direction: "insert",
  };

  it("at 0% progress, full negative offset applied", () => {
    const anim: InsertionAnimation = { ...baseAnim, progress: 0 };
    const withoutAnim = getColumnX(10, config, dims, 0, 0);
    const withAnim = getColumnX(10, config, dims, 0, 0, anim);
    // offset = (1-0) * 100 * 3 = 300, insert => x -= 300
    expect(withAnim).toBe(withoutAnim - 300);
  });

  it("at 50% progress, half offset applied", () => {
    const anim: InsertionAnimation = { ...baseAnim, progress: 0.5 };
    const withoutAnim = getColumnX(10, config, dims, 0, 0);
    const withAnim = getColumnX(10, config, dims, 0, 0, anim);
    expect(withAnim).toBe(withoutAnim - 150);
  });

  it("at 100% progress, no offset (animation complete)", () => {
    const anim: InsertionAnimation = { ...baseAnim, progress: 1 };
    const withoutAnim = getColumnX(10, config, dims, 0, 0);
    const withAnim = getColumnX(10, config, dims, 0, 0, anim);
    expect(withAnim).toBe(withoutAnim);
  });

  it("columns before insertion index are unaffected", () => {
    const anim: InsertionAnimation = { ...baseAnim, progress: 0 };
    const withoutAnim = getColumnX(3, config, dims, 0, 0);
    const withAnim = getColumnX(3, config, dims, 0, 0, anim);
    expect(withAnim).toBe(withoutAnim);
  });
});

describe("column deletion animation at different progress levels", () => {
  const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
  const dims = makeDims();
  const baseAnim: Omit<InsertionAnimation, "progress"> = {
    type: "column",
    index: 5,
    count: 2,
    targetSize: 100,
    direction: "delete",
  };

  it("at 0% progress, full positive offset applied", () => {
    const anim: InsertionAnimation = { ...baseAnim, progress: 0 };
    const withoutAnim = getColumnX(10, config, dims, 0, 0);
    const withAnim = getColumnX(10, config, dims, 0, 0, anim);
    // offset = (1-0) * 100 * 2 = 200, delete => x += 200
    expect(withAnim).toBe(withoutAnim + 200);
  });

  it("at 50% progress, half offset applied", () => {
    const anim: InsertionAnimation = { ...baseAnim, progress: 0.5 };
    const withoutAnim = getColumnX(10, config, dims, 0, 0);
    const withAnim = getColumnX(10, config, dims, 0, 0, anim);
    expect(withAnim).toBe(withoutAnim + 100);
  });

  it("at 100% progress, no offset", () => {
    const anim: InsertionAnimation = { ...baseAnim, progress: 1 };
    const withoutAnim = getColumnX(10, config, dims, 0, 0);
    const withAnim = getColumnX(10, config, dims, 0, 0, anim);
    expect(withAnim).toBe(withoutAnim);
  });
});

describe("row insertion animation at different progress levels", () => {
  const config = makeConfig({ colHeaderHeight: 24, defaultCellHeight: 24 });
  const dims = makeDims();
  const baseAnim: Omit<InsertionAnimation, "progress"> = {
    type: "row",
    index: 10,
    count: 5,
    targetSize: 24,
    direction: "insert",
  };

  it("at 0% progress, full negative offset", () => {
    const anim: InsertionAnimation = { ...baseAnim, progress: 0 };
    const withoutAnim = getRowY(20, config, dims, 0, 0);
    const withAnim = getRowY(20, config, dims, 0, 0, anim);
    expect(withAnim).toBe(withoutAnim - 120); // 24 * 5 = 120
  });

  it("at 100% progress, no offset", () => {
    const anim: InsertionAnimation = { ...baseAnim, progress: 1 };
    const withoutAnim = getRowY(20, config, dims, 0, 0);
    const withAnim = getRowY(20, config, dims, 0, 0, anim);
    expect(withAnim).toBe(withoutAnim);
  });
});

describe("row deletion animation at different progress levels", () => {
  const config = makeConfig({ colHeaderHeight: 24, defaultCellHeight: 24 });
  const dims = makeDims();

  it("at 0% progress, full positive offset", () => {
    const anim: InsertionAnimation = {
      type: "row",
      index: 3,
      count: 2,
      targetSize: 24,
      progress: 0,
      direction: "delete",
    };
    const withoutAnim = getRowY(10, config, dims, 0, 0);
    const withAnim = getRowY(10, config, dims, 0, 0, anim);
    expect(withAnim).toBe(withoutAnim + 48); // 24 * 2
  });
});

// ============================================================================
// getColumnWidth/getRowHeight with frozen pane offsets
// ============================================================================

describe("getColumnWidth/getRowHeight with frozen pane offsets", () => {
  it("getColumnX with positive offsetX simulates frozen pane shift", () => {
    const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
    const dims = makeDims();
    // Frozen pane: offsetX represents the frozen region offset
    const frozenOffset = 200;
    // col 5 from startCol 3: 50 + 200 + 2*100 = 450
    expect(getColumnX(5, config, dims, 3, frozenOffset)).toBe(50 + 200 + 200);
  });

  it("getRowY with positive offsetY simulates frozen pane shift", () => {
    const config = makeConfig({ colHeaderHeight: 24, defaultCellHeight: 24 });
    const dims = makeDims();
    const frozenOffset = 96; // 4 rows frozen
    // row 8 from startRow 4: 24 + 96 + 4*24 = 216
    expect(getRowY(8, config, dims, 4, frozenOffset)).toBe(24 + 96 + 96);
  });

  it("frozen offset does not affect getColumnWidth itself", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const dims = makeDims();
    dims.columnWidths.set(5, 150);
    // getColumnWidth is offset-independent
    expect(getColumnWidth(5, config, dims)).toBe(150);
  });

  it("frozen offset does not affect getRowHeight itself", () => {
    const config = makeConfig({ defaultCellHeight: 24 });
    const dims = makeDims();
    dims.rowHeights.set(5, 48);
    expect(getRowHeight(5, config, dims)).toBe(48);
  });
});
