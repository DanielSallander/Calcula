//! FILENAME: app/src/api/range.ts
// PURPOSE: Lightweight Range abstraction for extension authors.
// CONTEXT: Wraps (row, col) coordinates with convenience methods for
//          navigation, set operations, iteration, and data access via Tauri.

import { columnToLetter, letterToColumn } from "./types";
import type { CellData, FormattingOptions, FormattingResult } from "./types";
import { getCell, updateCellsBatch, applyFormatting, applyBorderPreset } from "./lib";
import type { CellUpdateInput } from "./lib";
import { navigateToCell, navigateToRange, borderAround } from "./grid";

// ============================================================================
// Address Parsing Helpers
// ============================================================================

/**
 * Parse a cell or range address string into row/col coordinates.
 * Supports: "A1", "A1:B5", "Sheet1!A1:B5"
 * All returned indices are 0-based.
 */
function parseAddress(address: string): {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  sheet?: string;
} {
  let work = address.trim();
  let sheet: string | undefined;

  // Strip sheet prefix: "Sheet1!A1:B5" -> "A1:B5"
  const bangIdx = work.indexOf("!");
  if (bangIdx !== -1) {
    sheet = work.substring(0, bangIdx).replace(/^'+|'+$/g, "");
    work = work.substring(bangIdx + 1);
  }

  // Strip any $ signs used for absolute references
  work = work.replace(/\$/g, "");

  const parts = work.split(":");
  const first = parseSingleCellRef(parts[0]);

  if (parts.length === 1) {
    return { startRow: first.row, startCol: first.col, endRow: first.row, endCol: first.col, sheet };
  }

  const second = parseSingleCellRef(parts[1]);
  return {
    startRow: Math.min(first.row, second.row),
    startCol: Math.min(first.col, second.col),
    endRow: Math.max(first.row, second.row),
    endCol: Math.max(first.col, second.col),
    sheet,
  };
}

/**
 * Parse a single cell reference like "A1" or "BC42" into { row, col }.
 * Returns 0-based indices.
 */
function parseSingleCellRef(ref: string): { row: number; col: number } {
  const match = ref.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) {
    throw new Error(`Invalid cell reference: "${ref}"`);
  }
  const col = letterToColumn(match[1].toUpperCase());
  const row = parseInt(match[2], 10) - 1; // 1-based to 0-based
  return { row, col };
}

// ============================================================================
// CellRange Class
// ============================================================================

/**
 * A lightweight, immutable range abstraction that wraps cell coordinates and
 * provides convenience methods for navigation, set operations, iteration,
 * and data access (via Tauri backend calls).
 *
 * All row/col indices are 0-based.
 */
export class CellRange {
  constructor(
    public readonly startRow: number,
    public readonly startCol: number,
    public readonly endRow: number,
    public readonly endCol: number,
  ) {}

  // --------------------------------------------------------------------------
  // Factory Methods
  // --------------------------------------------------------------------------

  /** Create a single-cell range. */
  static fromCell(row: number, col: number): CellRange {
    return new CellRange(row, col, row, col);
  }

  /**
   * Create a range from an address string.
   * Supports "A1", "A1:B5", "$A$1:$B$5", "Sheet1!A1:B5".
   * Note: the sheet component is parsed but not stored on the range.
   */
  static fromAddress(address: string): CellRange {
    const parsed = parseAddress(address);
    return new CellRange(parsed.startRow, parsed.startCol, parsed.endRow, parsed.endCol);
  }

  // --------------------------------------------------------------------------
  // Properties
  // --------------------------------------------------------------------------

  /** Number of rows in the range. */
  get rowCount(): number {
    return this.endRow - this.startRow + 1;
  }

  /** Number of columns in the range. */
  get colCount(): number {
    return this.endCol - this.startCol + 1;
  }

  /** Total number of cells in the range. */
  get cellCount(): number {
    return this.rowCount * this.colCount;
  }

  /** True if the range covers exactly one cell. */
  get isSingleCell(): boolean {
    return this.startRow === this.endRow && this.startCol === this.endCol;
  }

  /** Returns the A1-style address string (e.g. "A1" or "A1:B5"). */
  get address(): string {
    const topLeft = columnToLetter(this.startCol) + (this.startRow + 1);
    if (this.isSingleCell) {
      return topLeft;
    }
    const bottomRight = columnToLetter(this.endCol) + (this.endRow + 1);
    return `${topLeft}:${bottomRight}`;
  }

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  /**
   * Return a new range shifted by the given row and column offsets.
   * The shape (size) of the range is preserved.
   */
  offset(rowOffset: number, colOffset: number): CellRange {
    return new CellRange(
      this.startRow + rowOffset,
      this.startCol + colOffset,
      this.endRow + rowOffset,
      this.endCol + colOffset,
    );
  }

  /**
   * Return a new range with the same top-left corner but resized to
   * the given number of rows and columns.
   */
  resize(rows: number, cols: number): CellRange {
    return new CellRange(
      this.startRow,
      this.startCol,
      this.startRow + rows - 1,
      this.startCol + cols - 1,
    );
  }

  /**
   * Return a single-cell range at the given offset within this range.
   * (0,0) is the top-left cell.
   */
  getCell(rowOffset: number, colOffset: number): CellRange {
    const row = this.startRow + rowOffset;
    const col = this.startCol + colOffset;
    if (row > this.endRow || col > this.endCol) {
      throw new Error(`Offset (${rowOffset}, ${colOffset}) is outside range ${this.address}`);
    }
    return CellRange.fromCell(row, col);
  }

  /**
   * Return a range spanning the entire row at the given offset within
   * this range. (0 = first row of the range.)
   */
  getRow(rowOffset: number): CellRange {
    const row = this.startRow + rowOffset;
    if (row > this.endRow) {
      throw new Error(`Row offset ${rowOffset} is outside range ${this.address}`);
    }
    return new CellRange(row, this.startCol, row, this.endCol);
  }

  /**
   * Return a range spanning the entire column at the given offset within
   * this range. (0 = first column of the range.)
   */
  getColumn(colOffset: number): CellRange {
    const col = this.startCol + colOffset;
    if (col > this.endCol) {
      throw new Error(`Column offset ${colOffset} is outside range ${this.address}`);
    }
    return new CellRange(this.startRow, col, this.endRow, col);
  }

  // --------------------------------------------------------------------------
  // Set Operations
  // --------------------------------------------------------------------------

  /** Check whether a cell at (row, col) falls within this range. */
  contains(row: number, col: number): boolean {
    return row >= this.startRow && row <= this.endRow && col >= this.startCol && col <= this.endCol;
  }

  /** Check whether this range overlaps with another range. */
  intersects(other: CellRange): boolean {
    return (
      this.startRow <= other.endRow &&
      this.endRow >= other.startRow &&
      this.startCol <= other.endCol &&
      this.endCol >= other.startCol
    );
  }

  /**
   * Return the overlapping region between this range and another,
   * or null if they do not overlap.
   */
  intersection(other: CellRange): CellRange | null {
    if (!this.intersects(other)) {
      return null;
    }
    return new CellRange(
      Math.max(this.startRow, other.startRow),
      Math.max(this.startCol, other.startCol),
      Math.min(this.endRow, other.endRow),
      Math.min(this.endCol, other.endCol),
    );
  }

  /** Return the bounding box that encompasses both ranges. */
  union(other: CellRange): CellRange {
    return new CellRange(
      Math.min(this.startRow, other.startRow),
      Math.min(this.startCol, other.startCol),
      Math.max(this.endRow, other.endRow),
      Math.max(this.endCol, other.endCol),
    );
  }

  // --------------------------------------------------------------------------
  // Iteration
  // --------------------------------------------------------------------------

  /**
   * Generator that yields every { row, col } in the range,
   * iterating row by row from top-left to bottom-right.
   */
  *cells(): Generator<{ row: number; col: number }> {
    for (let r = this.startRow; r <= this.endRow; r++) {
      for (let c = this.startCol; c <= this.endCol; c++) {
        yield { row: r, col: c };
      }
    }
  }

  /**
   * Call a function for every cell in the range.
   */
  forEachCell(callback: (row: number, col: number) => void): void {
    for (let r = this.startRow; r <= this.endRow; r++) {
      for (let c = this.startCol; c <= this.endCol; c++) {
        callback(r, c);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Data Operations (async - call Tauri backend)
  // --------------------------------------------------------------------------

  /**
   * Get the display value of a single cell.
   * Only meaningful for single-cell ranges; uses the top-left cell otherwise.
   */
  async getValue(): Promise<string | null> {
    const cell = await getCell(this.startRow, this.startCol);
    return cell ? cell.display : null;
  }

  /**
   * Get all cell data in this range.
   * Returns a Map keyed by "row,col" string for quick lookup.
   */
  async getValues(): Promise<Map<string, CellData>> {
    const results = new Map<string, CellData>();
    // Fetch cells individually. For large ranges this could be optimized
    // with a batch API in the future.
    const promises: Promise<void>[] = [];
    for (let r = this.startRow; r <= this.endRow; r++) {
      for (let c = this.startCol; c <= this.endCol; c++) {
        promises.push(
          getCell(r, c).then((cell) => {
            if (cell) {
              results.set(`${r},${c}`, cell);
            }
          }),
        );
      }
    }
    await Promise.all(promises);
    return results;
  }

  /**
   * Set the value of a single cell (top-left of the range).
   */
  async setValue(value: string): Promise<void> {
    await updateCellsBatch([{ row: this.startRow, col: this.startCol, value }]);
  }

  /**
   * Set values from a 2D array (rows x cols).
   * The array must match or be smaller than the range dimensions.
   */
  async setValues(values: string[][]): Promise<void> {
    const updates: CellUpdateInput[] = [];
    for (let r = 0; r < values.length && r < this.rowCount; r++) {
      const row = values[r];
      for (let c = 0; c < row.length && c < this.colCount; c++) {
        updates.push({
          row: this.startRow + r,
          col: this.startCol + c,
          value: row[c],
        });
      }
    }
    if (updates.length > 0) {
      await updateCellsBatch(updates);
    }
  }

  // --------------------------------------------------------------------------
  // Formatting Operations (async - call Tauri backend)
  // --------------------------------------------------------------------------

  /**
   * Apply formatting options to all cells in this range.
   */
  async applyFormatting(formatting: FormattingOptions): Promise<FormattingResult> {
    const rows: number[] = [];
    const cols: number[] = [];
    for (let r = this.startRow; r <= this.endRow; r++) {
      for (let c = this.startCol; c <= this.endCol; c++) {
        rows.push(r);
        cols.push(c);
      }
    }
    return applyFormatting(rows, cols, formatting);
  }

  /**
   * Apply a border preset to this range.
   */
  async applyBorderPreset(
    preset: string,
    style: string,
    color: string,
    width: number,
  ): Promise<FormattingResult> {
    return applyBorderPreset(
      this.startRow,
      this.startCol,
      this.endRow,
      this.endCol,
      preset,
      style,
      color,
      width,
    );
  }

  /**
   * Apply outside borders to this range.
   * Convenience method matching Excel's Range.BorderAround.
   *
   * @param style - Border line style (default "solid")
   * @param color - CSS hex color (default "#000000")
   * @param width - Border width (default 1)
   */
  async borderAround(
    style?: string,
    color?: string,
    width?: number,
  ): Promise<FormattingResult> {
    return borderAround(
      this.startRow,
      this.startCol,
      this.endRow,
      this.endCol,
      style,
      color,
      width,
    );
  }

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  /**
   * Scroll the grid so that this range is visible.
   * When select is true (default), the range is also selected.
   */
  scrollIntoView(select?: boolean): void {
    if (this.isSingleCell) {
      navigateToCell(this.startRow, this.startCol, select);
    } else {
      navigateToRange(this.startRow, this.startCol, this.endRow, this.endCol);
    }
  }

  // --------------------------------------------------------------------------
  // Equality & Serialization
  // --------------------------------------------------------------------------

  /** Check structural equality with another range. */
  equals(other: CellRange): boolean {
    return (
      this.startRow === other.startRow &&
      this.startCol === other.startCol &&
      this.endRow === other.endRow &&
      this.endCol === other.endCol
    );
  }

  /** String representation for debugging. */
  toString(): string {
    return `CellRange(${this.address})`;
  }
}
