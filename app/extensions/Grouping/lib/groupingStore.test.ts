//! FILENAME: app/extensions/Grouping/lib/groupingStore.test.ts
// PURPOSE: Tests for grouping store pure logic and outline bar layout calculations.
// CONTEXT: Tests outline bar width/height computation, viewport equality,
//          button positioning, and bracket positioning without backend dependencies.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline copies of pure functions from groupingStore.ts
// ============================================================================

const DEFAULT_ROW_HEADER_WIDTH = 50;
const DEFAULT_COL_HEADER_HEIGHT = 24;
const PIXELS_PER_LEVEL = 16;
const LEFT_PAD = 4;

function computeOutlineBarWidth(maxRowLevel: number): number {
  return maxRowLevel > 0 ? LEFT_PAD + maxRowLevel * PIXELS_PER_LEVEL + 4 : 0;
}

function computeRowHeaderWidth(maxRowLevel: number): number {
  return DEFAULT_ROW_HEADER_WIDTH + computeOutlineBarWidth(maxRowLevel);
}

function computeOutlineBarHeight(maxColLevel: number): number {
  return maxColLevel > 0 ? LEFT_PAD + maxColLevel * PIXELS_PER_LEVEL + 4 : 0;
}

function computeColHeaderHeight(maxColLevel: number): number {
  return DEFAULT_COL_HEADER_HEIGHT + computeOutlineBarHeight(maxColLevel);
}

// ============================================================================
// Inline copies from outlineBarRenderer.ts
// ============================================================================

const BUTTON_SIZE = 13;

function buttonPosForLevel(level: number): number {
  return LEFT_PAD + (level - 1) * PIXELS_PER_LEVEL + PIXELS_PER_LEVEL / 2;
}

function bracketPosForLevel(level: number): number {
  return LEFT_PAD + (level - 1) * PIXELS_PER_LEVEL + 2;
}

// ============================================================================
// Inline copy of viewportEqual from groupingStore.ts
// ============================================================================

interface Viewport {
  startRow: number;
  startCol: number;
  rowCount: number;
  colCount: number;
  scrollX: number;
  scrollY: number;
}

function viewportEqual(a: Viewport, b: Viewport): boolean {
  return (
    a.startRow === b.startRow &&
    a.startCol === b.startCol &&
    a.rowCount === b.rowCount &&
    a.colCount === b.colCount
  );
}

// ============================================================================
// Tests: Outline Bar Width/Height Calculation
// ============================================================================

describe("computeOutlineBarWidth", () => {
  it("returns 0 for no outline levels", () => {
    expect(computeOutlineBarWidth(0)).toBe(0);
  });

  it("returns correct width for 1 level", () => {
    const expected = LEFT_PAD + 1 * PIXELS_PER_LEVEL + 4; // 4 + 16 + 4 = 24
    expect(computeOutlineBarWidth(1)).toBe(expected);
  });

  it("returns correct width for 2 levels", () => {
    const expected = LEFT_PAD + 2 * PIXELS_PER_LEVEL + 4; // 4 + 32 + 4 = 40
    expect(computeOutlineBarWidth(2)).toBe(expected);
  });

  it("returns correct width for 3 levels", () => {
    const expected = LEFT_PAD + 3 * PIXELS_PER_LEVEL + 4; // 4 + 48 + 4 = 56
    expect(computeOutlineBarWidth(3)).toBe(expected);
  });

  it("increases linearly with level count", () => {
    const w1 = computeOutlineBarWidth(1);
    const w2 = computeOutlineBarWidth(2);
    const w3 = computeOutlineBarWidth(3);
    expect(w2 - w1).toBe(PIXELS_PER_LEVEL);
    expect(w3 - w2).toBe(PIXELS_PER_LEVEL);
  });
});

describe("computeOutlineBarHeight", () => {
  it("returns 0 for no outline levels", () => {
    expect(computeOutlineBarHeight(0)).toBe(0);
  });

  it("matches width formula for same level count", () => {
    for (let lvl = 0; lvl <= 5; lvl++) {
      expect(computeOutlineBarHeight(lvl)).toBe(computeOutlineBarWidth(lvl));
    }
  });
});

describe("computeRowHeaderWidth", () => {
  it("returns default when no outline", () => {
    expect(computeRowHeaderWidth(0)).toBe(DEFAULT_ROW_HEADER_WIDTH);
  });

  it("adds outline bar width to default", () => {
    const outlineW = computeOutlineBarWidth(2);
    expect(computeRowHeaderWidth(2)).toBe(DEFAULT_ROW_HEADER_WIDTH + outlineW);
  });
});

describe("computeColHeaderHeight", () => {
  it("returns default when no outline", () => {
    expect(computeColHeaderHeight(0)).toBe(DEFAULT_COL_HEADER_HEIGHT);
  });

  it("adds outline bar height to default", () => {
    const outlineH = computeOutlineBarHeight(2);
    expect(computeColHeaderHeight(2)).toBe(DEFAULT_COL_HEADER_HEIGHT + outlineH);
  });
});

// ============================================================================
// Tests: Button and Bracket Positioning
// ============================================================================

describe("buttonPosForLevel", () => {
  it("positions level 1 button at center of first level slot", () => {
    const expected = LEFT_PAD + 0 * PIXELS_PER_LEVEL + PIXELS_PER_LEVEL / 2;
    expect(buttonPosForLevel(1)).toBe(expected);
    expect(buttonPosForLevel(1)).toBe(12); // 4 + 0 + 8 = 12
  });

  it("positions level 2 button at center of second slot", () => {
    const expected = LEFT_PAD + 1 * PIXELS_PER_LEVEL + PIXELS_PER_LEVEL / 2;
    expect(buttonPosForLevel(2)).toBe(expected);
    expect(buttonPosForLevel(2)).toBe(28); // 4 + 16 + 8 = 28
  });

  it("positions level 3 button", () => {
    expect(buttonPosForLevel(3)).toBe(44); // 4 + 32 + 8 = 44
  });

  it("increases by PIXELS_PER_LEVEL for each level", () => {
    for (let lvl = 1; lvl < 5; lvl++) {
      expect(buttonPosForLevel(lvl + 1) - buttonPosForLevel(lvl)).toBe(PIXELS_PER_LEVEL);
    }
  });
});

describe("bracketPosForLevel", () => {
  it("positions level 1 bracket near start of first slot", () => {
    expect(bracketPosForLevel(1)).toBe(LEFT_PAD + 2); // 4 + 0 + 2 = 6
  });

  it("positions level 2 bracket in second slot", () => {
    expect(bracketPosForLevel(2)).toBe(LEFT_PAD + PIXELS_PER_LEVEL + 2); // 4 + 16 + 2 = 22
  });

  it("bracket is always to the left of button center at same level", () => {
    for (let lvl = 1; lvl <= 5; lvl++) {
      expect(bracketPosForLevel(lvl)).toBeLessThan(buttonPosForLevel(lvl));
    }
  });

  it("increases by PIXELS_PER_LEVEL for each level", () => {
    for (let lvl = 1; lvl < 5; lvl++) {
      expect(bracketPosForLevel(lvl + 1) - bracketPosForLevel(lvl)).toBe(PIXELS_PER_LEVEL);
    }
  });
});

// ============================================================================
// Tests: Viewport Equality
// ============================================================================

describe("viewportEqual", () => {
  const base: Viewport = {
    startRow: 0,
    startCol: 0,
    rowCount: 50,
    colCount: 20,
    scrollX: 0,
    scrollY: 0,
  };

  it("returns true for identical viewports", () => {
    expect(viewportEqual(base, { ...base })).toBe(true);
  });

  it("returns false when startRow differs", () => {
    expect(viewportEqual(base, { ...base, startRow: 1 })).toBe(false);
  });

  it("returns false when startCol differs", () => {
    expect(viewportEqual(base, { ...base, startCol: 1 })).toBe(false);
  });

  it("returns false when rowCount differs", () => {
    expect(viewportEqual(base, { ...base, rowCount: 51 })).toBe(false);
  });

  it("returns false when colCount differs", () => {
    expect(viewportEqual(base, { ...base, colCount: 21 })).toBe(false);
  });

  it("ignores scrollX/scrollY differences (only row/col/count matter)", () => {
    expect(viewportEqual(base, { ...base, scrollX: 100, scrollY: 200 })).toBe(true);
  });
});

// ============================================================================
// Tests: Outline Level Button Layout
// ============================================================================

describe("outline level button layout", () => {
  const LEVEL_BTN_SIZE = 14;
  const LEVEL_BTN_GAP = 2;

  function levelButtonX(level: number): number {
    return (level - 1) * (LEVEL_BTN_SIZE + LEVEL_BTN_GAP) + 2;
  }

  it("positions first level button at x=2", () => {
    expect(levelButtonX(1)).toBe(2);
  });

  it("positions second level button with gap", () => {
    expect(levelButtonX(2)).toBe(2 + LEVEL_BTN_SIZE + LEVEL_BTN_GAP); // 2 + 14 + 2 = 18
  });

  it("positions third level button", () => {
    expect(levelButtonX(3)).toBe(2 + 2 * (LEVEL_BTN_SIZE + LEVEL_BTN_GAP)); // 2 + 32 = 34
  });

  it("buttons do not overlap", () => {
    for (let lvl = 1; lvl < 5; lvl++) {
      const x1 = levelButtonX(lvl);
      const x2 = levelButtonX(lvl + 1);
      expect(x2).toBeGreaterThanOrEqual(x1 + LEVEL_BTN_SIZE);
    }
  });

  it("all level buttons fit within the outline bar for that many levels", () => {
    for (let maxLevel = 1; maxLevel <= 5; maxLevel++) {
      const barWidth = computeOutlineBarWidth(maxLevel);
      const lastBtnRight = levelButtonX(maxLevel) + LEVEL_BTN_SIZE;
      // Level buttons go in the corner area, which is bar width.
      // They should fit within the outline bar width.
      expect(lastBtnRight).toBeLessThanOrEqual(barWidth);
    }
  });
});

// ============================================================================
// Tests: Hit Testing for Outline Buttons
// ============================================================================

describe("outline button hit testing", () => {
  function isClickOnToggleButton(
    clickX: number,
    clickY: number,
    buttonCenterX: number,
    buttonCenterY: number,
  ): boolean {
    const half = BUTTON_SIZE / 2;
    return (
      clickX >= buttonCenterX - half &&
      clickX <= buttonCenterX + half &&
      clickY >= buttonCenterY - half &&
      clickY <= buttonCenterY + half
    );
  }

  it("detects click on button center", () => {
    expect(isClickOnToggleButton(12, 50, 12, 50)).toBe(true);
  });

  it("detects click within button bounds", () => {
    const cx = 28;
    const cy = 100;
    const half = BUTTON_SIZE / 2;
    expect(isClickOnToggleButton(cx - half, cy - half, cx, cy)).toBe(true);
    expect(isClickOnToggleButton(cx + half, cy + half, cx, cy)).toBe(true);
  });

  it("rejects click outside button bounds", () => {
    const cx = 28;
    const cy = 100;
    const half = BUTTON_SIZE / 2;
    expect(isClickOnToggleButton(cx - half - 1, cy, cx, cy)).toBe(false);
    expect(isClickOnToggleButton(cx + half + 1, cy, cx, cy)).toBe(false);
    expect(isClickOnToggleButton(cx, cy - half - 1, cx, cy)).toBe(false);
    expect(isClickOnToggleButton(cx, cy + half + 1, cx, cy)).toBe(false);
  });
});
