import { describe, it, expect } from "vitest";
import {
  createDimensionGetterFromMap,
  createDimensionGetterFromArray,
  getColumnWidth,
  getRowHeight,
  getColumnWidthWithGetter,
  getRowHeightWithGetter,
  getColumnsWidthWithGetter,
  getRowsHeightWithGetter,
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
} from "../dimensions";

describe("dimensions", () => {
  // ==========================================================================
  // Dimension Getter Factories
  // ==========================================================================

  describe("createDimensionGetterFromMap", () => {
    it("returns custom value when present in map", () => {
      const map = new Map([[2, 150]]);
      const getter = createDimensionGetterFromMap(100, map);
      expect(getter(2)).toBe(150);
    });

    it("returns default value when not in map", () => {
      const map = new Map<number, number>();
      const getter = createDimensionGetterFromMap(100, map);
      expect(getter(5)).toBe(100);
    });
  });

  describe("createDimensionGetterFromArray", () => {
    it("returns array value when present", () => {
      const getter = createDimensionGetterFromArray(100, [80, 120, 90]);
      expect(getter(1)).toBe(120);
    });

    it("returns default value for out-of-bounds index", () => {
      const getter = createDimensionGetterFromArray(100, [80]);
      expect(getter(5)).toBe(100);
    });
  });

  // ==========================================================================
  // Single Dimension Lookups
  // ==========================================================================

  describe("getColumnWidth / getRowHeight", () => {
    it("returns custom width from map", () => {
      const widths = new Map([[3, 200]]);
      expect(getColumnWidth(3, 100, widths)).toBe(200);
    });

    it("returns default width when not in map", () => {
      expect(getColumnWidth(0, 100, new Map())).toBe(100);
    });

    it("returns custom row height from map", () => {
      const heights = new Map([[1, 40]]);
      expect(getRowHeight(1, 24, heights)).toBe(40);
    });

    it("returns default row height when not in map", () => {
      expect(getRowHeight(99, 24, new Map())).toBe(24);
    });
  });

  describe("getColumnWidthWithGetter / getRowHeightWithGetter", () => {
    it("delegates to the getter function", () => {
      expect(getColumnWidthWithGetter(3, () => 77)).toBe(77);
      expect(getRowHeightWithGetter(5, (r) => r * 10)).toBe(50);
    });
  });

  // ==========================================================================
  // Range Calculations
  // ==========================================================================

  describe("getColumnsWidthWithGetter", () => {
    it("sums widths over a range", () => {
      const getter = (c: number) => (c === 1 ? 150 : 100);
      expect(getColumnsWidthWithGetter(0, 2, getter)).toBe(350); // 100+150+100
    });

    it("returns single width for start === end", () => {
      expect(getColumnsWidthWithGetter(3, 3, () => 80)).toBe(80);
    });
  });

  describe("getRowsHeightWithGetter", () => {
    it("sums heights over a range", () => {
      expect(getRowsHeightWithGetter(0, 3, () => 24)).toBe(96);
    });
  });

  describe("getColumnsWidth (Map-based)", () => {
    it("uses map values and defaults", () => {
      const widths = new Map([[1, 200]]);
      expect(getColumnsWidth(0, 2, 100, widths)).toBe(400); // 100+200+100
    });
  });

  describe("getRowsHeight (Map-based)", () => {
    it("uses map values and defaults", () => {
      const heights = new Map([[0, 50]]);
      expect(getRowsHeight(0, 2, 24, heights)).toBe(98); // 50+24+24
    });
  });

  // ==========================================================================
  // Position Calculations (Simple)
  // ==========================================================================

  describe("calculateColumnX", () => {
    it("returns rowHeaderWidth for column 0 with no scroll", () => {
      expect(calculateColumnX(0, 50, 0, () => 100)).toBe(50);
    });

    it("sums widths of preceding columns", () => {
      expect(calculateColumnX(2, 50, 0, () => 100)).toBe(250); // 50 + 100 + 100
    });

    it("subtracts scrollX", () => {
      expect(calculateColumnX(2, 50, 30, () => 100)).toBe(220);
    });
  });

  describe("calculateRowY", () => {
    it("returns colHeaderHeight for row 0 with no scroll", () => {
      expect(calculateRowY(0, 24, 0, () => 20)).toBe(24);
    });

    it("subtracts scrollY", () => {
      expect(calculateRowY(3, 24, 10, () => 20)).toBe(74); // 24 + 60 - 10
    });
  });

  // ==========================================================================
  // Position Calculations (With Frozen Panes)
  // ==========================================================================

  describe("calculateColumnXWithFreeze", () => {
    const config = {
      getColumnWidth: () => 100,
      getRowHeight: () => 24,
      scrollX: 50,
      scrollY: 0,
      frozenColCount: 2,
      frozenRowCount: 0,
      frozenWidth: 200,
      frozenHeight: 0,
    };

    it("frozen column ignores scroll", () => {
      expect(calculateColumnXWithFreeze(0, config)).toBe(0);
      expect(calculateColumnXWithFreeze(1, config)).toBe(100);
    });

    it("non-frozen column starts at frozenWidth and applies scroll", () => {
      // col 2: frozenWidth(200) + 0 cols after frozen - scrollX(50) = 150
      expect(calculateColumnXWithFreeze(2, config)).toBe(150);
      // col 3: frozenWidth(200) + 100 - scrollX(50) = 250
      expect(calculateColumnXWithFreeze(3, config)).toBe(250);
    });
  });

  describe("calculateRowYWithFreeze", () => {
    const config = {
      getColumnWidth: () => 100,
      getRowHeight: () => 30,
      scrollX: 0,
      scrollY: 20,
      frozenColCount: 0,
      frozenRowCount: 2,
      frozenWidth: 0,
      frozenHeight: 60,
    };

    it("frozen row ignores scroll", () => {
      expect(calculateRowYWithFreeze(0, config)).toBe(0);
      expect(calculateRowYWithFreeze(1, config)).toBe(30);
    });

    it("non-frozen row applies scroll", () => {
      // row 2: frozenHeight(60) + 0 - scrollY(20) = 40
      expect(calculateRowYWithFreeze(2, config)).toBe(40);
    });
  });

  // ==========================================================================
  // Frozen Dimension Helpers
  // ==========================================================================

  describe("calculateFrozenWidth / calculateFrozenHeight", () => {
    it("sums widths of frozen columns", () => {
      expect(calculateFrozenWidth(3, () => 100)).toBe(300);
    });

    it("returns 0 for no frozen columns", () => {
      expect(calculateFrozenWidth(0, () => 100)).toBe(0);
    });

    it("sums heights of frozen rows", () => {
      expect(calculateFrozenHeight(2, () => 30)).toBe(60);
    });
  });

  // ==========================================================================
  // Config Builders
  // ==========================================================================

  describe("buildFreezePaneConfig", () => {
    it("builds config from arrays with correct frozen dimensions", () => {
      const config = buildFreezePaneConfig({
        colWidths: [80, 120],
        rowHeights: [30, 40],
        defaultCellWidth: 100,
        defaultCellHeight: 24,
        scrollX: 10,
        scrollY: 5,
        frozenColCount: 1,
        frozenRowCount: 1,
      });

      expect(config.scrollX).toBe(10);
      expect(config.scrollY).toBe(5);
      expect(config.frozenColCount).toBe(1);
      expect(config.frozenRowCount).toBe(1);
      expect(config.frozenWidth).toBe(80);  // col 0 width
      expect(config.frozenHeight).toBe(30); // row 0 height
      expect(config.getColumnWidth(0)).toBe(80);
      expect(config.getColumnWidth(1)).toBe(120);
      expect(config.getColumnWidth(5)).toBe(100); // default
      expect(config.getRowHeight(0)).toBe(30);
      expect(config.getRowHeight(5)).toBe(24); // default
    });
  });

  describe("buildFreezePaneConfigFromMaps", () => {
    it("builds config from maps with correct frozen dimensions", () => {
      const config = buildFreezePaneConfigFromMaps({
        columnWidths: new Map([[0, 80]]),
        rowHeights: new Map([[0, 30]]),
        defaultCellWidth: 100,
        defaultCellHeight: 24,
        scrollX: 0,
        scrollY: 0,
        frozenColCount: 1,
        frozenRowCount: 1,
      });

      expect(config.frozenWidth).toBe(80);
      expect(config.frozenHeight).toBe(30);
      expect(config.getColumnWidth(0)).toBe(80);
      expect(config.getColumnWidth(1)).toBe(100); // default
    });
  });
});
