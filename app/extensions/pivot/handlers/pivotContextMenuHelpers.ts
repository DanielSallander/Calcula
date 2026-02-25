//! FILENAME: app/extensions/Pivot/handlers/pivotContextMenuHelpers.ts
// PURPOSE: Helper functions for pivot context menu visibility and dynamic labels.
// CONTEXT: Provides synchronous helpers that use cached pivot view data,
//          plus async helpers for click handlers.

import type { GridMenuContext } from "../../../src/api";
import { findPivotRegionAtCell } from "./selectionHandler";
import { getCachedPivotView } from "../index";
import {
  getPivotAtCell,
  getPivotView,
  type PivotRegionInfo,
  type PivotCellData,
  type PivotViewResponse,
} from "../lib/pivot-api";
import type { PivotRegionData } from "../types";

// ============================================================================
// Synchronous helpers (use cached data, safe for `visible` callbacks)
// ============================================================================

/**
 * Check if a cell is inside a cached pivot region and return the pivotId.
 * Returns null if the cell is not in any pivot region.
 */
export function getPivotIdFromContext(ctx: GridMenuContext): number | null {
  if (!ctx.clickedCell) return null;
  const region = findPivotRegionAtCell(ctx.clickedCell.row, ctx.clickedCell.col);
  return region ? region.pivotId : null;
}

/**
 * Check if a context menu is inside a pivot region (synchronous, uses cached bounds).
 */
export function isInPivotRegion(ctx: GridMenuContext): boolean {
  return getPivotIdFromContext(ctx) !== null;
}

/**
 * Get the cached cell data for the clicked cell (synchronous).
 * Returns null if the cell is not in a pivot, no cached view exists,
 * or the coordinates are out of bounds.
 */
export function getCachedCellData(ctx: GridMenuContext): {
  region: PivotRegionData;
  cell: PivotCellData;
  viewRow: number;
  viewCol: number;
} | null {
  if (!ctx.clickedCell) return null;

  const region = findPivotRegionAtCell(ctx.clickedCell.row, ctx.clickedCell.col);
  if (!region) return null;

  const view = getCachedPivotView(region.pivotId);
  if (!view) return null;

  const viewRow = ctx.clickedCell.row - region.startRow;
  const viewCol = ctx.clickedCell.col - region.startCol;

  if (viewRow >= 0 && viewRow < view.rows.length) {
    const row = view.rows[viewRow];
    if (viewCol >= 0 && viewCol < row.cells.length) {
      return { region, cell: row.cells[viewCol], viewRow, viewCol };
    }
  }

  return null;
}

/**
 * Synchronous check: is the clicked cell a dimension header (RowHeader or ColumnHeader)?
 * Uses cached pivot view data.
 */
export function isDimensionHeader(ctx: GridMenuContext): boolean {
  if (!isInPivotRegion(ctx)) return false;
  const cached = getCachedCellData(ctx);
  if (!cached) return false;
  return cached.cell.cellType === "RowHeader" || cached.cell.cellType === "ColumnHeader";
}

/**
 * Get the field name for the clicked dimension header cell (synchronous).
 * Returns null if not a dimension header or no cached data.
 *
 * For RowHeader/ColumnHeader cells, the field name is derived from the
 * pivot's field configuration using the groupPath.
 */
export function getFieldNameForCell(ctx: GridMenuContext): string | null {
  const cached = getCachedCellData(ctx);
  if (!cached) return null;

  const { cell, region } = cached;
  if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return null;

  // Use the cached view to look up field name via fieldConfiguration
  const view = getCachedPivotView(region.pivotId);
  if (!view) return null;

  // The groupPath gives us [fieldIndex, valueId] pairs.
  // The last entry's fieldIndex identifies which field this cell belongs to.
  const groupPath = cell.groupPath;
  if (!groupPath || groupPath.length === 0) return null;

  const fieldIndex = groupPath[groupPath.length - 1][0];

  // Look up the field name from column headers.
  // First, try looking in the column header rows for a matching header label.
  // The simplest approach: use the formattedValue of header cells in the first
  // row that spans this field index. But for a reliable lookup, we use the
  // view's column metadata.
  //
  // For RowHeader: the field index refers to row fields
  // For ColumnHeader: the field index refers to column fields
  //
  // We'll return the formattedValue of the cell itself as a fallback for
  // the "item" name, but for the "field" name we need the field config.
  // Since we don't have direct access to fieldConfiguration from the view,
  // we look in the column header row or use the cell's indent/position.

  // Heuristic: scan the column header rows for the field label
  // In compact layout, the first column header cell in the row label area
  // contains the field name. In tabular/outline, each column has its field name.
  if (cell.cellType === "RowHeader") {
    // For row headers, find the label from the column header row for this column
    for (const row of view.rows) {
      if (row.rowType === "ColumnHeader") {
        const headerCell = row.cells[cached.viewCol];
        if (headerCell && headerCell.formattedValue) {
          return headerCell.formattedValue;
        }
      }
    }
  }

  if (cell.cellType === "ColumnHeader") {
    // For column headers, the field name is typically in the row label area
    // at the same row level. Or we can use the first row label column header.
    for (const row of view.rows) {
      if (row.rowType === "ColumnHeader" && row.cells.length > 0) {
        // Look for the corner/label cell in the row label columns
        for (let c = 0; c < view.rowLabelColCount; c++) {
          const cornerCell = row.cells[c];
          if (
            cornerCell &&
            cornerCell.cellType === "Corner" &&
            cornerCell.formattedValue
          ) {
            return cornerCell.formattedValue;
          }
        }
      }
    }
  }

  // Fallback: return the cell's formatted value (this is the item label, not the field name)
  return cell.formattedValue || null;
}

/**
 * Get the field index for the clicked dimension header cell (synchronous).
 * Returns null if not a dimension header or no groupPath data.
 */
export function getFieldIndexForCell(ctx: GridMenuContext): number | null {
  const cached = getCachedCellData(ctx);
  if (!cached) return null;

  const { cell } = cached;
  if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return null;

  const groupPath = cell.groupPath;
  if (!groupPath || groupPath.length === 0) return null;

  return groupPath[groupPath.length - 1][0];
}

/**
 * Get the item label (specific value) for the clicked dimension cell (synchronous).
 */
export function getItemLabelForCell(ctx: GridMenuContext): string | null {
  const cached = getCachedCellData(ctx);
  if (!cached) return null;
  return cached.cell.formattedValue || null;
}

// ============================================================================
// Async helpers (for click handlers)
// ============================================================================

/**
 * Get full pivot cell data for the clicked cell (async - fetches from backend).
 * Returns null if the cell is not in a pivot or has no view data.
 */
export async function getClickedCellData(
  ctx: GridMenuContext,
): Promise<{
  pivotInfo: PivotRegionInfo;
  cell: PivotCellData;
  viewRow: number;
  viewCol: number;
} | null> {
  if (!ctx.clickedCell) return null;

  const pivotInfo = await getPivotAtCell(ctx.clickedCell.row, ctx.clickedCell.col);
  if (!pivotInfo) return null;

  try {
    const view = await getPivotView(pivotInfo.pivotId);
    const region = findPivotRegionAtCell(ctx.clickedCell.row, ctx.clickedCell.col);
    if (!region) return null;

    const viewRow = ctx.clickedCell.row - region.startRow;
    const viewCol = ctx.clickedCell.col - region.startCol;

    if (viewRow >= 0 && viewRow < view.rows.length) {
      const row = view.rows[viewRow];
      if (viewCol >= 0 && viewCol < row.cells.length) {
        return { pivotInfo, cell: row.cells[viewCol], viewRow, viewCol };
      }
    }
  } catch {
    // View not available, return null
  }

  return null;
}
