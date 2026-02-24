//! FILENAME: app/extensions/Sorting/lib/sortHelpers.ts
// PURPOSE: Helper functions for the Sort dialog.
// CONTEXT: Detects sort range, reads column headers, and scans for unique colors.

import {
  detectDataRegion,
  getViewportCells,
  indexToCol,
  getStyle,
} from "../../../src/api/lib";
import type { Selection } from "../../../src/api/types";

// ============================================================================
// Range Detection
// ============================================================================

/**
 * Detect the sort range from the current selection.
 * If the selection is a single cell, expands to the contiguous data region.
 * Otherwise, uses the selection bounds directly.
 */
export async function detectSortRange(
  selection: Selection,
): Promise<{ startRow: number; startCol: number; endRow: number; endCol: number } | null> {
  const sr = Math.min(selection.startRow, selection.endRow);
  const sc = Math.min(selection.startCol, selection.endCol);
  const er = Math.max(selection.startRow, selection.endRow);
  const ec = Math.max(selection.startCol, selection.endCol);

  // Single cell: auto-detect region
  if (sr === er && sc === ec) {
    const region = await detectDataRegion(sr, sc);
    if (!region) return null;
    return {
      startRow: region[0],
      startCol: region[1],
      endRow: region[2],
      endCol: region[3],
    };
  }

  // Multi-cell selection: use as-is
  return { startRow: sr, startCol: sc, endRow: er, endCol: ec };
}

// ============================================================================
// Column Headers
// ============================================================================

/**
 * Get display names for columns in a range.
 * If hasHeaders is true, reads the first row values as header names.
 * Falls back to column letters (A, B, C...) for empty headers or when hasHeaders is false.
 */
export async function getColumnDisplayNames(
  startRow: number,
  startCol: number,
  endCol: number,
  hasHeaders: boolean,
): Promise<string[]> {
  const colCount = endCol - startCol + 1;
  const headers: string[] = [];

  if (hasHeaders) {
    const cells = await getViewportCells(startRow, startCol, startRow, endCol);
    const cellMap = new Map(cells.map((c) => [c.col, c.display]));

    for (let col = startCol; col <= endCol; col++) {
      const display = cellMap.get(col);
      if (display && display.trim().length > 0) {
        headers.push(display.trim());
      } else {
        // Fallback to column letter for empty header cells
        headers.push(`Column ${indexToCol(col)}`);
      }
    }
  } else {
    for (let col = startCol; col <= endCol; col++) {
      headers.push(`Column ${indexToCol(col)}`);
    }
  }

  return headers;
}

/**
 * Get row display names for left-to-right sorting.
 * Reads the first column values or falls back to row numbers.
 */
export async function getRowDisplayNames(
  startRow: number,
  endRow: number,
  startCol: number,
  hasHeaders: boolean,
): Promise<string[]> {
  const names: string[] = [];

  if (hasHeaders) {
    const cells = await getViewportCells(startRow, startCol, endRow, startCol);
    const cellMap = new Map(cells.map((c) => [c.row, c.display]));

    for (let row = startRow; row <= endRow; row++) {
      const display = cellMap.get(row);
      if (display && display.trim().length > 0) {
        names.push(display.trim());
      } else {
        names.push(`Row ${row + 1}`);
      }
    }
  } else {
    for (let row = startRow; row <= endRow; row++) {
      names.push(`Row ${row + 1}`);
    }
  }

  return names;
}

// ============================================================================
// Color Scanning
// ============================================================================

/**
 * Scan a column for unique background or font colors.
 * Returns an array of distinct CSS color strings found in the column.
 */
export async function getUniqueColorsInColumn(
  startRow: number,
  endRow: number,
  col: number,
  type: "cellColor" | "fontColor",
): Promise<string[]> {
  const cells = await getViewportCells(startRow, col, endRow, col);
  const colorSet = new Set<string>();

  for (const cell of cells) {
    if (cell.styleIndex === 0 && type === "cellColor") {
      // Default style - skip transparent/no background
      continue;
    }

    try {
      const style = await getStyle(cell.styleIndex);
      const color = type === "cellColor" ? style.backgroundColor : style.textColor;

      // Skip default/transparent colors
      if (
        color &&
        color !== "transparent" &&
        color !== "rgba(0, 0, 0, 0)" &&
        color !== "#000000" // Skip default black text
      ) {
        colorSet.add(color.toLowerCase());
      }
    } catch {
      // Skip cells with invalid style indices
    }
  }

  return Array.from(colorSet);
}
