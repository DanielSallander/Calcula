//! FILENAME: app/extensions/Pivot/handlers/pivotContextMenuHelpers.ts
// PURPOSE: Helper functions for pivot context menu visibility and dynamic labels.
// CONTEXT: Provides synchronous helpers that use cached pivot view data,
//          plus async helpers for click handlers.
//
//          Every cell is read WINDOWED-AWARE (`getPivotViewRow`): a pivot of
//          more than 500 rows carries cells for its first window only, the
//          rest live in the cell-window cache, so reading `view.rows[viewRow]`
//          answered nothing past the first window and every header item did
//          nothing there (BUG-0455). Bounds are the view's row COUNT
//          (`viewRowCount`), never `view.rows.length`.
//
//          Captions NAME an item by `pivotCellDisplayText` (its member label,
//          else formattedValue, else the value in the app locale), so an
//          unformatted numeric header is never "" (BUG-0454). Actions that
//          FILTER or TOGGLE an item send `pivotCellItemKey` instead (identity).

import type { GridMenuContext } from "@api";
import { pivotCellDisplayText } from "@api/pivotMembers";
import { getGridStateSnapshot } from "@api/grid";
import { findPivotRegionAtCell } from "./selectionHandler";
import { getCachedPivotView } from "../lib/pivotViewStore";
import {
  getPivotAtCell,
  getPivotView,
  isTotalCell,
  type PivotRegionInfo,
  type PivotCellData,
  type PivotRowData,
  type PivotViewResponse,
} from "../lib/pivot-api";
import { getPivotViewRow, governingRowHeader } from "../lib/pivotChromeActions";
import { viewRowCount } from "../rendering/pivotVisualRenderer";
import type { PivotRegionData } from "../types";

// ============================================================================
// Synchronous helpers (use cached data, safe for `visible` callbacks)
// ============================================================================

/**
 * Check if a cell is inside a cached pivot region and return the pivotId.
 * Returns null if the cell is not in any pivot region.
 */
export function getPivotIdFromContext(ctx: GridMenuContext): string | null {
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
 * Whether the menu was opened on a CANVAS pivot box (the active sheet is a
 * canvas and the clicked cell is in a pivot region). The worksheet already
 * has Core's own cell items (Copy ...); a canvas box has only the pivot's.
 */
export function isCanvasPivotContext(ctx: GridMenuContext): boolean {
  return getGridStateSnapshot()?.surface === "canvas" && isInPivotRegion(ctx);
}

/** The cached cell under the menu, with the view and row it was read from. */
export interface CachedPivotMenuCell {
  region: PivotRegionData;
  view: PivotViewResponse;
  row: PivotRowData;
  cell: PivotCellData;
  viewRow: number;
  viewCol: number;
}

/**
 * Get the cached cell data for the clicked cell (synchronous, windowed-aware).
 * Returns null if the cell is not in a pivot, no cached view exists, the row
 * is not cached yet, or the coordinates are out of bounds.
 */
export function getCachedCellData(ctx: GridMenuContext): CachedPivotMenuCell | null {
  if (!ctx.clickedCell) return null;

  const region = findPivotRegionAtCell(ctx.clickedCell.row, ctx.clickedCell.col);
  if (!region) return null;

  const view = getCachedPivotView(region.pivotId);
  if (!view) return null;

  const viewRow = ctx.clickedCell.row - region.startRow;
  const viewCol = ctx.clickedCell.col - region.startCol;
  if (viewRow < 0 || viewRow >= viewRowCount(view) || viewCol < 0) return null;

  const row = getPivotViewRow(region.pivotId, view, viewRow);
  if (!row || viewCol >= row.cells.length) return null;
  const cell = row.cells[viewCol];
  if (!cell) return null;
  return { region, view, row, cell, viewRow, viewCol };
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
 * Whether the clicked cell shows a VALUE: a data cell, or a subtotal / grand
 * total cell in the value area. A total cell in the row-label columns (the
 * "Grand Total" label) or in a column-header row (the "Grand Total" column
 * caption) is a label, not a value.
 */
export function isValueCell(ctx: GridMenuContext): boolean {
  const cached = getCachedCellData(ctx);
  if (!cached) return false;
  const { cell, row, view, viewCol } = cached;
  if (cell.cellType === "Data") return true;
  if (!isTotalCell(cell.cellType)) return false;
  if (row.rowType === "ColumnHeader" || row.rowType === "FilterRow") return false;
  return viewCol >= (view.rowLabelColCount ?? 0);
}

/**
 * The value field (index into `view.valueFieldNames`) the clicked value cell
 * shows: the cell's own `valueFieldIndex`, or 0 when the pivot has exactly one
 * value field; null when it cannot be known (not a value cell, or several
 * value fields and the cell names none).
 */
export function valueFieldIndexFor(ctx: GridMenuContext): number | null {
  if (!isValueCell(ctx)) return null;
  const cached = getCachedCellData(ctx);
  if (!cached) return null;
  if (typeof cached.cell.valueFieldIndex === "number") return cached.cell.valueFieldIndex;
  const names = cached.view.valueFieldNames ?? [];
  return names.length === 1 ? 0 : null;
}

/** A value field's name for display: a model measure's outer `[...]` stripped. */
export function displayValueFieldName(name: string): string {
  const m = /^\[(.*)\]$/.exec(name.trim());
  return m ? m[1] : name;
}

/** The display name of the value field the clicked value cell shows, or null. */
export function valueFieldNameFor(ctx: GridMenuContext): string | null {
  const index = valueFieldIndexFor(ctx);
  if (index === null) return null;
  const cached = getCachedCellData(ctx);
  const name = cached?.view.valueFieldNames?.[index];
  return name ? displayValueFieldName(name) : null;
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

  const { cell, view } = cached;
  if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return null;

  // The groupPath gives us [fieldIndex, valueId] pairs.
  // The last entry's fieldIndex identifies which field this cell belongs to.
  const groupPath = cell.groupPath;
  if (!groupPath || groupPath.length === 0) return null;

  // Heuristic: scan the column header rows for the field label.
  // In compact layout, the first column header cell in the row label area
  // contains the field name. In tabular/outline, each column has its field name.
  // Column-header rows lead the view, so they are in its first window.
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

  // Fallback: the cell's own label (this is the item label, not the field name)
  return pivotCellDisplayText(cell) || null;
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
  return pivotCellDisplayText(cached.cell) || null;
}

// ============================================================================
// Expand / Collapse targets
// ============================================================================

/** The header an Expand / Collapse item acts on. */
export interface PivotExpandTarget {
  pivotId: string;
  header: PivotCellData;
  isRow: boolean;
}

/**
 * The header Expand / Collapse acts on: the clicked cell itself when it is a
 * row or column header; for a value cell the ROW item that governs its row
 * (Excel's rule: Expand on a value expands the row item it belongs to); null
 * anywhere else (a corner, a label total, a filter row, an uncached row).
 */
export function expandTargetFor(ctx: GridMenuContext): PivotExpandTarget | null {
  const cached = getCachedCellData(ctx);
  if (!cached) return null;
  const { cell, region, viewRow } = cached;
  if (cell.cellType === "RowHeader" || cell.cellType === "ColumnHeader") {
    return { pivotId: region.pivotId, header: cell, isRow: cell.cellType === "RowHeader" };
  }
  if (!isValueCell(ctx)) return null;
  const governing = governingRowHeader(region.pivotId, viewRow);
  return governing ? { pivotId: region.pivotId, header: governing.cell, isRow: true } : null;
}

/**
 * Why Expand (`expand` true) or Collapse cannot act here, or null when it can.
 * The menu shows the item DISABLED with this reason rather than letting a
 * click do nothing.
 */
export function expandDisabledReason(ctx: GridMenuContext, expand: boolean): string | null {
  const target = expandTargetFor(ctx);
  const verb = expand ? "expand" : "collapse";
  if (!target) return `Nothing to ${verb} here.`;
  const label = pivotCellDisplayText(target.header);
  if (!target.header.isExpandable) {
    return label ? `"${label}" has nothing to ${verb}.` : `Nothing to ${verb} here.`;
  }
  const collapsed = target.header.isCollapsed === true;
  if (expand && !collapsed) return "Already expanded.";
  if (!expand && collapsed) return "Already collapsed.";
  return null;
}

/** The field Expand / Collapse Entire Field acts on. */
export interface PivotFieldTarget {
  pivotId: string;
  isRow: boolean;
  /** The field's SOURCE index (the last entry of the header's group path). */
  fieldIndex: number;
}

/**
 * The field "Expand/Collapse Entire Field" acts on: the clicked header's
 * field, or -- on a value cell -- the field of the row item that governs it.
 */
export function entireFieldTargetFor(ctx: GridMenuContext): PivotFieldTarget | null {
  const target = expandTargetFor(ctx);
  if (!target) return null;
  const path = target.header.groupPath;
  if (!path || path.length === 0) return null;
  return { pivotId: target.pivotId, isRow: target.isRow, fieldIndex: path[path.length - 1][0] };
}

/** Why an Entire Field item cannot act here, or null when it can. */
export function entireFieldDisabledReason(ctx: GridMenuContext, expand: boolean): string | null {
  return entireFieldTargetFor(ctx) ? null : `No field to ${expand ? "expand" : "collapse"} here.`;
}

// ============================================================================
// Async helpers (for click handlers)
// ============================================================================

/**
 * Get full pivot cell data for the clicked cell (async - fetches from backend).
 * Returns null if the cell is not in a pivot or has no view data. Windowed-aware:
 * a row past the view's first window is read from the cell-window cache.
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

    if (viewRow >= 0 && viewRow < viewRowCount(view) && viewCol >= 0) {
      const row = getPivotViewRow(pivotInfo.pivotId, view, viewRow);
      const cell = row?.cells[viewCol];
      if (cell) {
        return { pivotInfo, cell, viewRow, viewCol };
      }
    }
  } catch {
    // View not available, return null
  }

  return null;
}
