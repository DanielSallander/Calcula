import { describe, it, expect } from "vitest";
import {
  createDimensionGetterFromMap,
  getColumnWidth,
  getRowHeight,
  getColumnsWidth,
  getRowsHeight,
  calculateColumnX,
  calculateRowY,
  calculateColumnXWithFreeze,
  calculateRowYWithFreeze,
  calculateFrozenWidth,
  calculateFrozenHeight,
  buildFreezePaneConfig,
  buildFreezePaneConfigFromMaps,
  getColumnsWidthWithGetter,
  getRowsHeightWithGetter,
} from "../dimensions";
import type { FreezePanePositionConfig } from "../dimensions";

describe("dimensions - interactions", () => {
  // ==========================================================================
  // Dimension calculations with 500+ custom widths
  // ==========================================================================

  describe("large-scale custom dimensions (500+)", () => {
    it("handles 500 custom column widths correctly", () => {
      const widths = new Map<number, number>();
      for (let i = 0; i < 500; i++) {
        widths.set(i, 50 + (i % 10) * 10); // Widths from 50 to 140
      }

      // Spot-check specific columns
      expect(getColumnWidth(0, 100, widths)).toBe(50);
      expect(getColumnWidth(9, 100, widths)).toBe(140);
      expect(getColumnWidth(499, 100, widths)).toBe(50 + (499 % 10) * 10);

      // Column beyond custom range falls back to default
      expect(getColumnWidth(500, 100, widths)).toBe(100);
    });

    it("sums 500 custom widths for range calculation", () => {
      const widths = new Map<number, number>();
      let expectedTotal = 0;
      for (let i = 0; i < 500; i++) {
        const w = 80 + (i % 5) * 20; // 80, 100, 120, 140, 160 repeating
        widths.set(i, w);
        expectedTotal += w;
      }

      const total = getColumnsWidth(0, 499, 100, widths);
      expect(total).toBe(expectedTotal);
    });

    it("calculateColumnX sums 500 preceding columns", () => {
      const widths = new Map<number, number>();
      for (let i = 0; i < 500; i++) {
        widths.set(i, 60);
      }
      const getter = createDimensionGetterFromMap(100, widths);

      // Col 500: rowHeaderWidth(50) + 500*60 - scrollX(0) = 30050
      expect(calculateColumnX(500, 50, 0, getter)).toBe(30050);
    });

    it("mix of custom and default widths over large range", () => {
      const widths = new Map<number, number>();
      // Only every 10th column is custom
      for (let i = 0; i < 1000; i += 10) {
        widths.set(i, 200);
      }

      // Range 0..99: 10 custom (200) + 90 default (100)
      const total = getColumnsWidth(0, 99, 100, widths);
      expect(total).toBe(10 * 200 + 90 * 100);
    });

    it("large row height map with hidden row simulation", () => {
      const heights = new Map<number, number>();
      // 600 rows, every 3rd row is "tall"
      for (let i = 0; i < 600; i++) {
        if (i % 3 === 0) heights.set(i, 48);
      }

      // Rows 0..5: rows 0,3 = 48, rows 1,2,4,5 = 24
      const total = getRowsHeight(0, 5, 24, heights);
      expect(total).toBe(2 * 48 + 4 * 24);
    });
  });

  // ==========================================================================
  // Frozen pane + custom dimension interaction
  // ==========================================================================

  describe("frozen pane + custom dimensions", () => {
    it("frozen columns with varying widths", () => {
      const widths = new Map<number, number>([
        [0, 50],  // narrow frozen col
        [1, 200], // wide frozen col
        [2, 120], // first non-frozen col
      ]);
      const getter = createDimensionGetterFromMap(100, widths);
      const frozenWidth = calculateFrozenWidth(2, getter);

      expect(frozenWidth).toBe(250); // 50 + 200

      const config: FreezePanePositionConfig = {
        getColumnWidth: getter,
        getRowHeight: () => 24,
        scrollX: 30,
        scrollY: 0,
        frozenColCount: 2,
        frozenRowCount: 0,
        frozenWidth,
        frozenHeight: 0,
      };

      // Frozen col 0: no scroll
      expect(calculateColumnXWithFreeze(0, config)).toBe(0);
      // Frozen col 1: sum of col 0
      expect(calculateColumnXWithFreeze(1, config)).toBe(50);
      // Non-frozen col 2: frozenWidth(250) - scrollX(30) = 220
      expect(calculateColumnXWithFreeze(2, config)).toBe(220);
      // Non-frozen col 3: frozenWidth(250) + 120 - scrollX(30) = 340
      expect(calculateColumnXWithFreeze(3, config)).toBe(340);
    });

    it("frozen rows with varying heights", () => {
      const heights = new Map<number, number>([
        [0, 40], // header row
        [1, 30], // subheader row
      ]);
      const getter = createDimensionGetterFromMap(24, heights);
      const frozenHeight = calculateFrozenHeight(2, getter);

      expect(frozenHeight).toBe(70); // 40 + 30

      const config: FreezePanePositionConfig = {
        getColumnWidth: () => 100,
        getRowHeight: getter,
        scrollX: 0,
        scrollY: 50,
        frozenColCount: 0,
        frozenRowCount: 2,
        frozenWidth: 0,
        frozenHeight,
      };

      // Frozen rows ignore scroll
      expect(calculateRowYWithFreeze(0, config)).toBe(0);
      expect(calculateRowYWithFreeze(1, config)).toBe(40);
      // Non-frozen row 2: frozenHeight(70) - scrollY(50) = 20
      expect(calculateRowYWithFreeze(2, config)).toBe(20);
    });

    it("both frozen rows and columns simultaneously", () => {
      const config = buildFreezePaneConfig({
        colWidths: [60, 80, 100, 120],
        rowHeights: [30, 40, 24, 24],
        defaultCellWidth: 100,
        defaultCellHeight: 24,
        scrollX: 20,
        scrollY: 10,
        frozenColCount: 2,
        frozenRowCount: 2,
      });

      expect(config.frozenWidth).toBe(140); // 60 + 80
      expect(config.frozenHeight).toBe(70); // 30 + 40

      // Frozen col in frozen area
      expect(calculateColumnXWithFreeze(0, config)).toBe(0);
      // Non-frozen col
      expect(calculateColumnXWithFreeze(2, config)).toBe(140 - 20); // 120

      // Frozen row
      expect(calculateRowYWithFreeze(1, config)).toBe(30);
      // Non-frozen row
      expect(calculateRowYWithFreeze(2, config)).toBe(70 - 10); // 60
    });

    it("zero frozen panes behaves like simple positioning", () => {
      const config = buildFreezePaneConfigFromMaps({
        columnWidths: new Map([[0, 150]]),
        rowHeights: new Map(),
        defaultCellWidth: 100,
        defaultCellHeight: 24,
        scrollX: 30,
        scrollY: 10,
        frozenColCount: 0,
        frozenRowCount: 0,
      });

      expect(config.frozenWidth).toBe(0);
      expect(config.frozenHeight).toBe(0);

      // All columns are non-frozen, so scroll applies
      // col 0: frozenWidth(0) + 0 - scrollX(30) = -30
      expect(calculateColumnXWithFreeze(0, config)).toBe(-30);
      // col 1: 0 + 150 - 30 = 120
      expect(calculateColumnXWithFreeze(1, config)).toBe(120);
    });
  });

  // ==========================================================================
  // Position calculation with mix of hidden + custom + default
  // ==========================================================================

  describe("mixed hidden + custom + default dimensions", () => {
    it("hidden rows (height=0) mixed with custom and default", () => {
      const heights = new Map<number, number>([
        [0, 30],
        [1, 0],  // hidden
        [2, 50],
        [3, 0],  // hidden
        // row 4 = default 24
      ]);

      const total = getRowsHeight(0, 4, 24, heights);
      expect(total).toBe(30 + 0 + 50 + 0 + 24);
    });

    it("calculateRowY with hidden rows via zero-height getter", () => {
      const heights = new Map<number, number>([
        [0, 0],  // hidden
        [1, 0],  // hidden
        [2, 24], // visible
      ]);
      const getter = createDimensionGetterFromMap(24, heights);

      // Row 3: colHeader(24) + 0 + 0 + 24 - scrollY(0) = 48
      expect(calculateRowY(3, 24, 0, getter)).toBe(48);
    });

    it("calculateColumnX with some columns hidden (width=0)", () => {
      const widths = new Map<number, number>([
        [0, 100],
        [1, 0],  // hidden
        [2, 0],  // hidden
        [3, 150],
      ]);
      const getter = createDimensionGetterFromMap(100, widths);

      // Col 4: rowHeader(50) + 100 + 0 + 0 + 150 - scrollX(0) = 300
      expect(calculateColumnX(4, 50, 0, getter)).toBe(300);
    });

    it("range width calculation ignores hidden columns (width=0 in map)", () => {
      const widths = new Map<number, number>([
        [2, 0], // hidden
        [4, 0], // hidden
      ]);

      // cols 0..5: 100 + 100 + 0 + 100 + 0 + 100 = 400
      expect(getColumnsWidth(0, 5, 100, widths)).toBe(400);
    });

    it("frozen pane with hidden columns inside frozen area", () => {
      const widths = new Map<number, number>([
        [0, 80],
        [1, 0],  // hidden frozen column
      ]);
      const getter = createDimensionGetterFromMap(100, widths);
      const frozenWidth = calculateFrozenWidth(2, getter);

      // Hidden frozen column still counts (width=0)
      expect(frozenWidth).toBe(80);
    });
  });

  // ==========================================================================
  // Column header override + dimension interaction
  // ==========================================================================

  describe("column header + dimension interaction", () => {
    it("custom colHeaderHeight affects row Y calculations", () => {
      const getter = () => 24;

      // With standard header
      expect(calculateRowY(0, 24, 0, getter)).toBe(24);
      // With taller header
      expect(calculateRowY(0, 48, 0, getter)).toBe(48);
      // Row 5 with tall header
      expect(calculateRowY(5, 48, 0, getter)).toBe(48 + 5 * 24);
    });

    it("custom rowHeaderWidth affects column X calculations", () => {
      const getter = () => 100;

      // Standard header width
      expect(calculateColumnX(0, 50, 0, getter)).toBe(50);
      // Wide header
      expect(calculateColumnX(0, 120, 0, getter)).toBe(120);
      // Col 3 with wide header
      expect(calculateColumnX(3, 120, 0, getter)).toBe(120 + 300);
    });

    it("scroll offset interacts correctly with header sizes", () => {
      const getter = () => 100;

      // Large scroll should push content left/up, headers stay at their offset
      expect(calculateColumnX(0, 50, 500, getter)).toBe(50 - 500);
      expect(calculateRowY(0, 24, 300, getter)).toBe(24 - 300);
    });
  });

  // ==========================================================================
  // Batch dimension updates
  // ==========================================================================

  describe("batch dimension updates", () => {
    it("replacing all entries in a map is reflected immediately", () => {
      const widths = new Map<number, number>();
      const getter = createDimensionGetterFromMap(100, widths);

      expect(getter(5)).toBe(100); // default

      // Simulate batch update
      for (let i = 0; i < 50; i++) {
        widths.set(i, 75);
      }

      expect(getter(5)).toBe(75); // getter reads live map
      expect(getter(50)).toBe(100); // still default
    });

    it("clearing a map reverts all to defaults", () => {
      const widths = new Map<number, number>([[0, 200], [1, 300]]);
      const getter = createDimensionGetterFromMap(100, widths);

      expect(getter(0)).toBe(200);
      widths.clear();
      expect(getter(0)).toBe(100);
    });

    it("buildFreezePaneConfigFromMaps with dynamically updated maps", () => {
      const colWidths = new Map<number, number>([[0, 60]]);
      const rowHeights = new Map<number, number>();

      const config = buildFreezePaneConfigFromMaps({
        columnWidths: colWidths,
        rowHeights,
        defaultCellWidth: 100,
        defaultCellHeight: 24,
        scrollX: 0,
        scrollY: 0,
        frozenColCount: 1,
        frozenRowCount: 0,
      });

      expect(config.frozenWidth).toBe(60);
      // Note: frozenWidth is calculated at build time, not live
      // But the getter still reads from the map
      colWidths.set(0, 120);
      expect(config.getColumnWidth(0)).toBe(120);
      // frozenWidth is stale - this is expected behavior
      expect(config.frozenWidth).toBe(60);
    });

    it("getColumnsWidthWithGetter handles empty range (start > end)", () => {
      // When start > end, the loop doesn't execute
      expect(getColumnsWidthWithGetter(5, 3, () => 100)).toBe(0);
    });

    it("getRowsHeightWithGetter handles single-row range", () => {
      expect(getRowsHeightWithGetter(7, 7, () => 42)).toBe(42);
    });

    it("calculateFrozenWidth with large frozen count", () => {
      const getter = (c: number) => 80 + c;
      // 20 frozen columns: sum of 80+0, 80+1, ..., 80+19
      const expected = 20 * 80 + (19 * 20) / 2; // 1600 + 190 = 1790
      expect(calculateFrozenWidth(20, getter)).toBe(expected);
    });
  });
});
