//! FILENAME: app/extensions/Pivot/handlers/pivotContextMenu.ts
// PURPOSE: Registers pivot-specific items in the grid right-click context menu.
// CONTEXT: Items are visible only when the right-clicked cell is inside a pivot region.
//          Uses cached region bounds for synchronous visibility checks.

import {
  gridExtensions,
  emitAppEvent,
  AppEvents,
  showDialog,
  type GridContextMenuItem,
  type GridMenuContext,
} from "../../../src/api";
import { findPivotRegionAtCell } from "./selectionHandler";
import {
  getPivotAtCell,
  getPivotView,
  expandCollapseAll,
  expandCollapseLevel,
  ungroupPivotField,
  refreshPivotCache,
  deletePivotTable,
  drillThroughToSheet,
  type PivotRegionInfo,
  type PivotCellData,
} from "../lib/pivot-api";
import { PIVOT_GROUP_DIALOG_ID } from "../manifest";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a cell is inside a cached pivot region and return the pivotId.
 * Returns null if the cell is not in any pivot region.
 */
function getPivotIdFromContext(ctx: GridMenuContext): number | null {
  if (!ctx.clickedCell) return null;
  const region = findPivotRegionAtCell(ctx.clickedCell.row, ctx.clickedCell.col);
  return region ? region.pivotId : null;
}

/**
 * Check if a context menu is inside a pivot region (synchronous, uses cached bounds).
 */
function isInPivotRegion(ctx: GridMenuContext): boolean {
  return getPivotIdFromContext(ctx) !== null;
}

/**
 * Get the pivot cell data for the clicked cell.
 * Returns null if the cell is not in a pivot or has no view data.
 */
async function getClickedCellData(
  ctx: GridMenuContext,
): Promise<{ pivotInfo: PivotRegionInfo; cell: PivotCellData; viewRow: number; viewCol: number } | null> {
  if (!ctx.clickedCell) return null;

  const pivotInfo = await getPivotAtCell(ctx.clickedCell.row, ctx.clickedCell.col);
  if (!pivotInfo) return null;

  try {
    const view = await getPivotView(pivotInfo.pivotId);
    // Map grid coordinates to view coordinates
    // The pivot view starts at the pivot region's origin; we need to look up the
    // cell relative to the pivot region bounds.
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

// ============================================================================
// Context Menu Item IDs
// ============================================================================

const CONTEXT_ITEM_IDS = [
  "pivot:expandAll",
  "pivot:collapseAll",
  "pivot:expandField",
  "pivot:collapseField",
  "pivot:group",
  "pivot:ungroup",
  "pivot:showDetails",
  "pivot:refresh",
  "pivot:delete",
];

// ============================================================================
// Registration
// ============================================================================

/**
 * Register pivot table items in the grid right-click context menu.
 * Returns a cleanup function to unregister them.
 */
export function registerPivotContextMenuItems(): () => void {
  const items: GridContextMenuItem[] = [
    // ------------------------------------------------------------------
    // Expand / Collapse
    // ------------------------------------------------------------------
    {
      id: "pivot:expandField",
      label: "Expand Entire Field",
      group: "pivot",
      order: 100,
      visible: isInPivotRegion,
      onClick: async (ctx) => {
        const cellData = await getClickedCellData(ctx);
        if (!cellData) return;
        const { pivotInfo, cell } = cellData;

        // Only works on row/column header cells that are expandable
        if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;

        const isRow = cell.cellType === "RowHeader";
        // The groupPath's first entry gives us the field index
        const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
        if (fieldIndex === undefined) return;

        await expandCollapseLevel({
          pivotId: pivotInfo.pivotId,
          isRow,
          fieldIndex,
          expand: true,
        });
        window.dispatchEvent(new Event("pivot:refresh"));
      },
    },
    {
      id: "pivot:collapseField",
      label: "Collapse Entire Field",
      group: "pivot",
      order: 101,
      visible: isInPivotRegion,
      onClick: async (ctx) => {
        const cellData = await getClickedCellData(ctx);
        if (!cellData) return;
        const { pivotInfo, cell } = cellData;

        if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;

        const isRow = cell.cellType === "RowHeader";
        const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
        if (fieldIndex === undefined) return;

        await expandCollapseLevel({
          pivotId: pivotInfo.pivotId,
          isRow,
          fieldIndex,
          expand: false,
        });
        window.dispatchEvent(new Event("pivot:refresh"));
      },
    },
    {
      id: "pivot:expandAll",
      label: "Expand All",
      group: "pivot",
      order: 102,
      visible: isInPivotRegion,
      onClick: async (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId === null) return;
        await expandCollapseAll({ pivotId, expand: true });
        window.dispatchEvent(new Event("pivot:refresh"));
      },
    },
    {
      id: "pivot:collapseAll",
      label: "Collapse All",
      group: "pivot",
      order: 103,
      visible: isInPivotRegion,
      separatorAfter: true,
      onClick: async (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId === null) return;
        await expandCollapseAll({ pivotId, expand: false });
        window.dispatchEvent(new Event("pivot:refresh"));
      },
    },

    // ------------------------------------------------------------------
    // Grouping
    // ------------------------------------------------------------------
    {
      id: "pivot:group",
      label: "Group...",
      group: "pivot",
      order: 200,
      visible: isInPivotRegion,
      onClick: async (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId === null) return;

        // Determine which field to group based on clicked cell
        const cellData = await getClickedCellData(ctx);
        if (!cellData) return;
        const { cell } = cellData;

        // Grouping applies to row/column headers
        if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;

        const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
        if (fieldIndex === undefined) return;

        // Open the grouping dialog with context
        showDialog(PIVOT_GROUP_DIALOG_ID, {
          pivotId,
          fieldIndex,
          isRow: cell.cellType === "RowHeader",
        });
      },
    },
    {
      id: "pivot:ungroup",
      label: "Ungroup",
      group: "pivot",
      order: 201,
      visible: isInPivotRegion,
      separatorAfter: true,
      onClick: async (ctx) => {
        const cellData = await getClickedCellData(ctx);
        if (!cellData) return;
        const { pivotInfo, cell } = cellData;

        if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;

        const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
        if (fieldIndex === undefined) return;

        await ungroupPivotField({
          pivotId: pivotInfo.pivotId,
          fieldIndex,
        });
        window.dispatchEvent(new Event("pivot:refresh"));
      },
    },

    // ------------------------------------------------------------------
    // Drill-Through (Show Details)
    // ------------------------------------------------------------------
    {
      id: "pivot:showDetails",
      label: "Show Details",
      group: "pivot",
      order: 300,
      visible: isInPivotRegion,
      separatorAfter: true,
      onClick: async (ctx) => {
        const cellData = await getClickedCellData(ctx);
        if (!cellData) return;
        const { pivotInfo, cell } = cellData;

        // Only data cells, subtotals, and grand totals support drill-through
        if (
          cell.cellType !== "Data" &&
          cell.cellType !== "RowSubtotal" &&
          cell.cellType !== "ColumnSubtotal" &&
          cell.cellType !== "GrandTotal" &&
          cell.cellType !== "GrandTotalRow" &&
          cell.cellType !== "GrandTotalColumn"
        ) {
          return;
        }

        const groupPath = cell.groupPath ?? [];
        const result = await drillThroughToSheet({
          pivotId: pivotInfo.pivotId,
          groupPath,
        });

        // Navigate to the new sheet
        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: result.sheetIndex,
          sheetName: result.sheetName,
        });
        emitAppEvent(AppEvents.GRID_REFRESH);
      },
    },

    // ------------------------------------------------------------------
    // Refresh & Delete
    // ------------------------------------------------------------------
    {
      id: "pivot:refresh",
      label: "Refresh",
      group: "pivot",
      order: 400,
      visible: isInPivotRegion,
      onClick: async (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId === null) return;
        await refreshPivotCache(pivotId);
        window.dispatchEvent(new Event("pivot:refresh"));
      },
    },
    {
      id: "pivot:delete",
      label: "Delete PivotTable",
      group: "pivot",
      order: 401,
      visible: isInPivotRegion,
      onClick: async (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId === null) return;
        await deletePivotTable(pivotId);
        window.dispatchEvent(new Event("pivot:refresh"));
        emitAppEvent(AppEvents.GRID_REFRESH);
      },
    },
  ];

  gridExtensions.registerContextMenuItems(items);

  return () => {
    for (const id of CONTEXT_ITEM_IDS) {
      gridExtensions.unregisterContextMenuItem(id);
    }
  };
}
