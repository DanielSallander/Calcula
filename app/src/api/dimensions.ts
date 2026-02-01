//! FILENAME: app/src/api/dimensions.ts
// PURPOSE: Shared dimension calculation utilities for grid rendering.
// CONTEXT: Provides pure functions for calculating column widths, row heights,
// and pixel positions. Used by both the overlay system and standalone canvases
// (like pivot tables) to eliminate code duplication.

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Function type for retrieving dimension values.
 * Allows flexible backing stores (Map, array, or computed).
 */
export type DimensionGetter = (index: number) => number;

/**
 * Configuration for basic dimension lookups.
 * Used when you only need width/height calculations without positions.
 */
export interface DimensionLookupConfig {
  /** Default width for columns without custom widths */
  defaultCellWidth: number;
  /** Default height for rows without custom heights */
  defaultCellHeight: number;
  /** Custom column widths (Map-based) */
  columnWidths: Map<number, number>;
  /** Custom row heights (Map-based) */
  rowHeights: Map<number, number>;
}

/**
 * Configuration for position calculations on the main grid canvas.
 * Extends DimensionLookupConfig with scroll and header information.
 */
export interface GridPositionConfig extends DimensionLookupConfig {
  /** Width of the row header area (leftmost column with row numbers) */
  rowHeaderWidth: number;
  /** Height of the column header area (top row with column letters) */
  colHeaderHeight: number;
  /** Horizontal scroll offset in pixels */
  scrollX: number;
  /** Vertical scroll offset in pixels */
  scrollY: number;
}

/**
 * Configuration for position calculations with frozen pane support.
 * Used by components that render their own canvas (like pivot tables).
 */
export interface FreezePanePositionConfig {
  /** Function to get column width by index */
  getColumnWidth: DimensionGetter;
  /** Function to get row height by index */
  getRowHeight: DimensionGetter;
  /** Horizontal scroll offset in pixels */
  scrollX: number;
  /** Vertical scroll offset in pixels */
  scrollY: number;
  /** Number of frozen columns (0 = none) */
  frozenColCount: number;
  /** Number of frozen rows (0 = none) */
  frozenRowCount: number;
  /** Pre-calculated total width of frozen columns */
  frozenWidth: number;
  /** Pre-calculated total height of frozen rows */
  frozenHeight: number;
}

// ============================================================================
// Dimension Getter Factories
// ============================================================================

/**
 * Create a dimension getter from a Map with a default fallback.
 * Used for column widths and row heights stored in Map<number, number>.
 */
export function createDimensionGetterFromMap(
  defaultValue: number,
  dimensions: Map<number, number>
): DimensionGetter {
  return (index: number): number => {
    return dimensions.get(index) ?? defaultValue;
  };
}

/**
 * Create a dimension getter from an array with a default fallback.
 * Used for column widths and row heights stored in number[].
 */
export function createDimensionGetterFromArray(
  defaultValue: number,
  dimensions: number[]
): DimensionGetter {
  return (index: number): number => {
    return dimensions[index] ?? defaultValue;
  };
}

// ============================================================================
// Core Pure Functions - Single Dimension Lookups
// ============================================================================

/**
 * Get the width of a column from a Map-based store.
 * @param col - Column index (0-based)
 * @param defaultWidth - Default width if not in map
 * @param columnWidths - Map of column index to width
 */
export function getColumnWidth(
  col: number,
  defaultWidth: number,
  columnWidths: Map<number, number>
): number {
  return columnWidths.get(col) ?? defaultWidth;
}

/**
 * Get the height of a row from a Map-based store.
 * @param row - Row index (0-based)
 * @param defaultHeight - Default height if not in map
 * @param rowHeights - Map of row index to height
 */
export function getRowHeight(
  row: number,
  defaultHeight: number,
  rowHeights: Map<number, number>
): number {
  return rowHeights.get(row) ?? defaultHeight;
}

/**
 * Get the width of a column using a dimension getter.
 * @param col - Column index (0-based)
 * @param getWidth - Function that returns width for a column index
 */
export function getColumnWidthWithGetter(
  col: number,
  getWidth: DimensionGetter
): number {
  return getWidth(col);
}

/**
 * Get the height of a row using a dimension getter.
 * @param row - Row index (0-based)
 * @param getHeight - Function that returns height for a row index
 */
export function getRowHeightWithGetter(
  row: number,
  getHeight: DimensionGetter
): number {
  return getHeight(row);
}

// ============================================================================
// Core Pure Functions - Range Calculations
// ============================================================================

/**
 * Calculate the total width of a range of columns (inclusive).
 * @param startCol - First column index (0-based)
 * @param endCol - Last column index (inclusive)
 * @param getWidth - Function that returns width for a column index
 */
export function getColumnsWidthWithGetter(
  startCol: number,
  endCol: number,
  getWidth: DimensionGetter
): number {
  let width = 0;
  for (let col = startCol; col <= endCol; col++) {
    width += getWidth(col);
  }
  return width;
}

/**
 * Calculate the total height of a range of rows (inclusive).
 * @param startRow - First row index (0-based)
 * @param endRow - Last row index (inclusive)
 * @param getHeight - Function that returns height for a row index
 */
export function getRowsHeightWithGetter(
  startRow: number,
  endRow: number,
  getHeight: DimensionGetter
): number {
  let height = 0;
  for (let row = startRow; row <= endRow; row++) {
    height += getHeight(row);
  }
  return height;
}

/**
 * Calculate the total width of a range of columns using Map-based store.
 * @param startCol - First column index (0-based)
 * @param endCol - Last column index (inclusive)
 * @param defaultWidth - Default width if not in map
 * @param columnWidths - Map of column index to width
 */
export function getColumnsWidth(
  startCol: number,
  endCol: number,
  defaultWidth: number,
  columnWidths: Map<number, number>
): number {
  let width = 0;
  for (let col = startCol; col <= endCol; col++) {
    width += columnWidths.get(col) ?? defaultWidth;
  }
  return width;
}

/**
 * Calculate the total height of a range of rows using Map-based store.
 * @param startRow - First row index (0-based)
 * @param endRow - Last row index (inclusive)
 * @param defaultHeight - Default height if not in map
 * @param rowHeights - Map of row index to height
 */
export function getRowsHeight(
  startRow: number,
  endRow: number,
  defaultHeight: number,
  rowHeights: Map<number, number>
): number {
  let height = 0;
  for (let row = startRow; row <= endRow; row++) {
    height += rowHeights.get(row) ?? defaultHeight;
  }
  return height;
}

// ============================================================================
// Core Pure Functions - Position Calculations (Simple)
// ============================================================================

/**
 * Calculate the X pixel position of a column's left edge.
 * Simple version: sums widths from column 0, subtracts scroll offset.
 * @param col - Target column index (0-based)
 * @param rowHeaderWidth - Width of the row header area
 * @param scrollX - Horizontal scroll offset
 * @param getWidth - Function that returns width for a column index
 */
export function calculateColumnX(
  col: number,
  rowHeaderWidth: number,
  scrollX: number,
  getWidth: DimensionGetter
): number {
  let x = rowHeaderWidth;
  for (let c = 0; c < col; c++) {
    x += getWidth(c);
  }
  return x - scrollX;
}

/**
 * Calculate the Y pixel position of a row's top edge.
 * Simple version: sums heights from row 0, subtracts scroll offset.
 * @param row - Target row index (0-based)
 * @param colHeaderHeight - Height of the column header area
 * @param scrollY - Vertical scroll offset
 * @param getHeight - Function that returns height for a row index
 */
export function calculateRowY(
  row: number,
  colHeaderHeight: number,
  scrollY: number,
  getHeight: DimensionGetter
): number {
  let y = colHeaderHeight;
  for (let r = 0; r < row; r++) {
    y += getHeight(r);
  }
  return y - scrollY;
}

// ============================================================================
// Core Pure Functions - Position Calculations (With Frozen Panes)
// ============================================================================

/**
 * Calculate the X pixel position of a column's left edge with frozen pane support.
 * Frozen columns don't scroll; non-frozen columns start after frozen area.
 * @param col - Target column index (0-based)
 * @param config - Freeze pane position configuration
 */
export function calculateColumnXWithFreeze(
  col: number,
  config: FreezePanePositionConfig
): number {
  const { getColumnWidth, scrollX, frozenColCount, frozenWidth } = config;

  if (col < frozenColCount) {
    // Frozen column: sum widths from 0 to col, no scroll offset
    let x = 0;
    for (let c = 0; c < col; c++) {
      x += getColumnWidth(c);
    }
    return x;
  } else {
    // Non-frozen column: start at frozenWidth, sum from frozenColCount, apply scroll
    let x = frozenWidth;
    for (let c = frozenColCount; c < col; c++) {
      x += getColumnWidth(c);
    }
    return x - scrollX;
  }
}

/**
 * Calculate the Y pixel position of a row's top edge with frozen pane support.
 * Frozen rows don't scroll; non-frozen rows start after frozen area.
 * @param row - Target row index (0-based)
 * @param config - Freeze pane position configuration
 */
export function calculateRowYWithFreeze(
  row: number,
  config: FreezePanePositionConfig
): number {
  const { getRowHeight, scrollY, frozenRowCount, frozenHeight } = config;

  if (row < frozenRowCount) {
    // Frozen row: sum heights from 0 to row, no scroll offset
    let y = 0;
    for (let r = 0; r < row; r++) {
      y += getRowHeight(r);
    }
    return y;
  } else {
    // Non-frozen row: start at frozenHeight, sum from frozenRowCount, apply scroll
    let y = frozenHeight;
    for (let r = frozenRowCount; r < row; r++) {
      y += getRowHeight(r);
    }
    return y - scrollY;
  }
}

// ============================================================================
// Helper Functions - Frozen Dimension Calculations
// ============================================================================

/**
 * Calculate the total width of frozen columns.
 * @param frozenColCount - Number of frozen columns
 * @param getWidth - Function that returns width for a column index
 */
export function calculateFrozenWidth(
  frozenColCount: number,
  getWidth: DimensionGetter
): number {
  let width = 0;
  for (let c = 0; c < frozenColCount; c++) {
    width += getWidth(c);
  }
  return width;
}

/**
 * Calculate the total height of frozen rows.
 * @param frozenRowCount - Number of frozen rows
 * @param getHeight - Function that returns height for a row index
 */
export function calculateFrozenHeight(
  frozenRowCount: number,
  getHeight: DimensionGetter
): number {
  let height = 0;
  for (let r = 0; r < frozenRowCount; r++) {
    height += getHeight(r);
  }
  return height;
}

// ============================================================================
// Convenience - Position Config Builders
// ============================================================================

/**
 * Build a FreezePanePositionConfig from array-based dimensions.
 * Useful for pivot tables and other components using number[] for dimensions.
 */
export function buildFreezePaneConfig(options: {
  colWidths: number[];
  rowHeights: number[];
  defaultCellWidth: number;
  defaultCellHeight: number;
  scrollX: number;
  scrollY: number;
  frozenColCount: number;
  frozenRowCount: number;
}): FreezePanePositionConfig {
  const getColumnWidth = createDimensionGetterFromArray(
    options.defaultCellWidth,
    options.colWidths
  );
  const getRowHeight = createDimensionGetterFromArray(
    options.defaultCellHeight,
    options.rowHeights
  );

  const frozenWidth = calculateFrozenWidth(options.frozenColCount, getColumnWidth);
  const frozenHeight = calculateFrozenHeight(options.frozenRowCount, getRowHeight);

  return {
    getColumnWidth,
    getRowHeight,
    scrollX: options.scrollX,
    scrollY: options.scrollY,
    frozenColCount: options.frozenColCount,
    frozenRowCount: options.frozenRowCount,
    frozenWidth,
    frozenHeight,
  };
}

/**
 * Build a FreezePanePositionConfig from Map-based dimensions.
 * Useful when working with DimensionOverrides from the core types.
 */
export function buildFreezePaneConfigFromMaps(options: {
  columnWidths: Map<number, number>;
  rowHeights: Map<number, number>;
  defaultCellWidth: number;
  defaultCellHeight: number;
  scrollX: number;
  scrollY: number;
  frozenColCount: number;
  frozenRowCount: number;
}): FreezePanePositionConfig {
  const getColumnWidth = createDimensionGetterFromMap(
    options.defaultCellWidth,
    options.columnWidths
  );
  const getRowHeight = createDimensionGetterFromMap(
    options.defaultCellHeight,
    options.rowHeights
  );

  const frozenWidth = calculateFrozenWidth(options.frozenColCount, getColumnWidth);
  const frozenHeight = calculateFrozenHeight(options.frozenRowCount, getRowHeight);

  return {
    getColumnWidth,
    getRowHeight,
    scrollX: options.scrollX,
    scrollY: options.scrollY,
    frozenColCount: options.frozenColCount,
    frozenRowCount: options.frozenRowCount,
    frozenWidth,
    frozenHeight,
  };
}