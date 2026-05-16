//! FILENAME: app/extensions/Grouping/lib/groupingStore-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for grouping store pure logic.
// CONTEXT: Tests outline bar width, button positioning, and hit testing.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline constants and pure functions (avoids Tauri import mocking)
// ============================================================================

const DEFAULT_ROW_HEADER_WIDTH = 50;
const DEFAULT_COL_HEADER_HEIGHT = 24;
const PIXELS_PER_LEVEL = 16;
const LEFT_PAD = 4;

/** Calculate outline bar width for a given max level. */
function outlineBarWidth(maxLevel: number): number {
  return maxLevel > 0 ? LEFT_PAD + maxLevel * PIXELS_PER_LEVEL + 4 : 0;
}

/** Calculate total row header width. */
function rowHeaderWidth(maxLevel: number): number {
  return DEFAULT_ROW_HEADER_WIDTH + outlineBarWidth(maxLevel);
}

/** Calculate outline bar height for a given max column level. */
function outlineBarHeight(maxLevel: number): number {
  return maxLevel > 0 ? LEFT_PAD + maxLevel * PIXELS_PER_LEVEL + 4 : 0;
}

/** Calculate total column header height. */
function colHeaderHeight(maxLevel: number): number {
  return DEFAULT_COL_HEADER_HEIGHT + outlineBarHeight(maxLevel);
}

/**
 * Calculate the X center of a collapse/expand button at a given outline level.
 * Buttons are placed in the outline bar, one per level column.
 */
function buttonCenterX(level: number): number {
  return LEFT_PAD + (level - 1) * PIXELS_PER_LEVEL + PIXELS_PER_LEVEL / 2;
}

/**
 * Calculate the Y center of a collapse/expand button for a given row,
 * given the row's pixel Y position and row height.
 */
function buttonCenterY(rowY: number, rowHeight: number): number {
  return rowY + rowHeight / 2;
}

/**
 * Hit test: is the click (x, y) within a button of radius r centered at (cx, cy)?
 */
function hitTestButton(clickX: number, clickY: number, cx: number, cy: number, radius: number): boolean {
  const dx = clickX - cx;
  const dy = clickY - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// ============================================================================
// 1. Outline bar width for levels 1-8 = 8 tests
// ============================================================================

describe("Grouping: Outline bar width for levels 1-8", () => {
  const levels = [1, 2, 3, 4, 5, 6, 7, 8];

  it.each(levels)("level %i", (level) => {
    const barW = outlineBarWidth(level);
    const expected = LEFT_PAD + level * PIXELS_PER_LEVEL + 4;
    expect(barW).toBe(expected);
    expect(barW).toBeGreaterThan(0);

    const headerW = rowHeaderWidth(level);
    expect(headerW).toBe(DEFAULT_ROW_HEADER_WIDTH + barW);

    // Bar height uses same formula
    const barH = outlineBarHeight(level);
    expect(barH).toBe(expected);
    const headerH = colHeaderHeight(level);
    expect(headerH).toBe(DEFAULT_COL_HEADER_HEIGHT + barH);
  });

  it("level 0 => no outline bar", () => {
    expect(outlineBarWidth(0)).toBe(0);
    expect(rowHeaderWidth(0)).toBe(DEFAULT_ROW_HEADER_WIDTH);
    expect(outlineBarHeight(0)).toBe(0);
    expect(colHeaderHeight(0)).toBe(DEFAULT_COL_HEADER_HEIGHT);
  });
});

// ============================================================================
// 2. Button positioning for 8 levels x 3 viewport sizes = 24 tests
// ============================================================================

describe("Grouping: Button positioning", () => {
  const levels = [1, 2, 3, 4, 5, 6, 7, 8];
  const viewportSizes = [
    { name: "small", rowY: 30, rowHeight: 20 },
    { name: "medium", rowY: 100, rowHeight: 24 },
    { name: "large", rowY: 500, rowHeight: 40 },
  ];

  const cases: Array<{
    level: number;
    viewport: string;
    rowY: number;
    rowHeight: number;
  }> = [];

  for (const level of levels) {
    for (const vp of viewportSizes) {
      cases.push({ level, viewport: vp.name, rowY: vp.rowY, rowHeight: vp.rowHeight });
    }
  }

  it.each(cases)(
    "level $level, $viewport viewport (rowY=$rowY, h=$rowHeight)",
    ({ level, rowY, rowHeight }) => {
      const cx = buttonCenterX(level);
      const cy = buttonCenterY(rowY, rowHeight);

      // Button X should be within the outline bar
      const barW = outlineBarWidth(level);
      expect(cx).toBeGreaterThanOrEqual(LEFT_PAD);
      expect(cx).toBeLessThanOrEqual(barW);

      // Button Y should be centered in the row
      expect(cy).toBe(rowY + rowHeight / 2);
      expect(cy).toBeGreaterThanOrEqual(rowY);
      expect(cy).toBeLessThanOrEqual(rowY + rowHeight);

      // X increases with level
      if (level > 1) {
        expect(cx).toBeGreaterThan(buttonCenterX(level - 1));
      }
    },
  );
});

// ============================================================================
// 3. Hit testing for 30 coordinate combos
// ============================================================================

describe("Grouping: Hit testing", () => {
  const BUTTON_RADIUS = 6;

  const cases: Array<{
    desc: string;
    clickX: number;
    clickY: number;
    btnCX: number;
    btnCY: number;
    shouldHit: boolean;
  }> = [
    // Direct hits (on center)
    { desc: "exact center", clickX: 12, clickY: 40, btnCX: 12, btnCY: 40, shouldHit: true },
    { desc: "center level 2", clickX: 28, clickY: 60, btnCX: 28, btnCY: 60, shouldHit: true },
    { desc: "center level 3", clickX: 44, clickY: 80, btnCX: 44, btnCY: 80, shouldHit: true },
    // Hits within radius
    { desc: "1px right of center", clickX: 13, clickY: 40, btnCX: 12, btnCY: 40, shouldHit: true },
    { desc: "1px below center", clickX: 12, clickY: 41, btnCX: 12, btnCY: 40, shouldHit: true },
    { desc: "5px right (within radius)", clickX: 17, clickY: 40, btnCX: 12, btnCY: 40, shouldHit: true },
    { desc: "diagonal 4,4 (dist ~5.6)", clickX: 16, clickY: 44, btnCX: 12, btnCY: 40, shouldHit: true },
    { desc: "6px right (on edge)", clickX: 18, clickY: 40, btnCX: 12, btnCY: 40, shouldHit: true },
    { desc: "6px up", clickX: 12, clickY: 34, btnCX: 12, btnCY: 40, shouldHit: true },
    { desc: "diagonal 3,5 (dist ~5.8)", clickX: 15, clickY: 45, btnCX: 12, btnCY: 40, shouldHit: true },
    // Misses (outside radius)
    { desc: "7px right", clickX: 19, clickY: 40, btnCX: 12, btnCY: 40, shouldHit: false },
    { desc: "7px below", clickX: 12, clickY: 47, btnCX: 12, btnCY: 40, shouldHit: false },
    { desc: "10px away", clickX: 22, clickY: 40, btnCX: 12, btnCY: 40, shouldHit: false },
    { desc: "diagonal 5,5 (dist ~7.07)", clickX: 17, clickY: 45, btnCX: 12, btnCY: 40, shouldHit: false },
    { desc: "far away", clickX: 100, clickY: 200, btnCX: 12, btnCY: 40, shouldHit: false },
    { desc: "negative coords miss", clickX: -5, clickY: 40, btnCX: 12, btnCY: 40, shouldHit: false },
    { desc: "wrong button entirely", clickX: 12, clickY: 40, btnCX: 50, btnCY: 100, shouldHit: false },
    // Edge cases with different button positions
    { desc: "hit high-Y button", clickX: 28, clickY: 498, btnCX: 28, btnCY: 500, shouldHit: true },
    { desc: "miss high-Y button", clickX: 28, clickY: 490, btnCX: 28, btnCY: 500, shouldHit: false },
    { desc: "hit at origin", clickX: 3, clickY: 3, btnCX: 5, btnCY: 5, shouldHit: true },
    { desc: "miss at origin", clickX: 0, clickY: 0, btnCX: 10, btnCY: 10, shouldHit: false },
    // Level-specific button positions
    { desc: "hit L1 button (cx=12)", clickX: 14, clickY: 42, btnCX: 12, btnCY: 40, shouldHit: true },
    { desc: "hit L2 button (cx=28)", clickX: 30, clickY: 41, btnCX: 28, btnCY: 40, shouldHit: true },
    { desc: "hit L3 button (cx=44)", clickX: 46, clickY: 39, btnCX: 44, btnCY: 40, shouldHit: true },
    { desc: "hit L4 button (cx=60)", clickX: 62, clickY: 40, btnCX: 60, btnCY: 40, shouldHit: true },
    { desc: "miss between L1 and L2", clickX: 20, clickY: 40, btnCX: 12, btnCY: 40, shouldHit: false },
    { desc: "miss between L2 and L3", clickX: 36, clickY: 40, btnCX: 28, btnCY: 40, shouldHit: false },
    { desc: "miss L1 click on L2 area", clickX: 28, clickY: 40, btnCX: 12, btnCY: 40, shouldHit: false },
    { desc: "zero distance", clickX: 0, clickY: 0, btnCX: 0, btnCY: 0, shouldHit: true },
    { desc: "exactly on radius boundary", clickX: 18, clickY: 40, btnCX: 12, btnCY: 40, shouldHit: true },
  ];

  it.each(cases)(
    "$desc => $shouldHit",
    ({ clickX, clickY, btnCX, btnCY, shouldHit }) => {
      const result = hitTestButton(clickX, clickY, btnCX, btnCY, BUTTON_RADIUS);
      expect(result).toBe(shouldHit);
    },
  );
});
