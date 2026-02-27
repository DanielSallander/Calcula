//! FILENAME: app/extensions/Pivot/handlers/pivotContextMenu.ts
// PURPOSE: Registers the full pivot dimension context menu (16 items) in the grid right-click menu.
// CONTEXT: Items are visible only when the right-clicked cell is inside a pivot region.
//          Dimension-specific items (Sort, Filter, Subtotal, etc.) are additionally
//          restricted to RowHeader/ColumnHeader cells via cached view data.

import {
  gridExtensions,
  showDialog,
  closeTaskPane,
  openTaskPane,
  markTaskPaneManuallyClosed,
  clearTaskPaneManuallyClosed,
  getTaskPaneManuallyClosed,
  type GridContextMenuItem,
  type GridMenuContext,
} from "../../../src/api";

import {
  isInPivotRegion,
  isDimensionHeader,
  getPivotIdFromContext,
  getFieldNameForCell,
  getFieldIndexForCell,
  getItemLabelForCell,
  getClickedCellData,
  getCachedCellData,
} from "./pivotContextMenuHelpers";

import {
  refreshPivotCache,
  deletePivotTable,
  sortPivotField,
  applyPivotFilter,
  getPivotFieldUniqueValues,
  expandCollapseLevel,
  expandCollapseAll,
  setPivotItemExpanded,
  ungroupPivotField,
  removePivotHierarchy,
  updatePivotFields,
  getPivotFieldInfo,
  updatePivotProperties,
} from "../lib/pivot-api";

import { deleteCachedPivotView } from "../lib/pivotViewStore";

import {
  PIVOT_GROUP_DIALOG_ID,
  PIVOT_FIELD_SETTINGS_DIALOG_ID,
  PIVOT_OPTIONS_DIALOG_ID,
  PIVOT_PANE_ID,
} from "../manifest";

// ============================================================================
// Context Menu Item IDs
// ============================================================================

const CONTEXT_ITEM_IDS = [
  "pivot:copy",
  "pivot:formatCells",
  "pivot:refresh",
  "pivot:delete",
  "pivot:rename",
  "pivot:sort",
  "pivot:filter",
  "pivot:subtotal",
  "pivot:expandCollapse",
  "pivot:group",
  "pivot:ungroup",
  "pivot:move",
  "pivot:removeField",
  "pivot:fieldSettings",
  "pivot:pivotOptions",
  "pivot:hideFieldList",
];

// ============================================================================
// Registration
// ============================================================================

/**
 * Register all pivot table items in the grid right-click context menu.
 * Returns a cleanup function to unregister them.
 */
export function registerPivotContextMenuItems(): () => void {
  const items: GridContextMenuItem[] = [

    // ------------------------------------------------------------------
    // 1. Copy
    // ------------------------------------------------------------------
    {
      id: "pivot:copy",
      label: "Copy",
      shortcut: "Ctrl+C",
      group: "pivot",
      order: 10,
      visible: isInPivotRegion,
      onClick: async (ctx) => {
        const cached = getCachedCellData(ctx);
        if (!cached) return;
        const text = cached.cell.formattedValue || "";
        try {
          await navigator.clipboard.writeText(text);
        } catch (e) {
          console.error("[PivotMenu] Failed to copy to clipboard:", e);
        }
      },
    },

    // ------------------------------------------------------------------
    // 2. Format Cells... (stub)
    // ------------------------------------------------------------------
    {
      id: "pivot:formatCells",
      label: "Format Cells...",
      group: "pivot",
      order: 20,
      visible: isInPivotRegion,
      disabled: true,
      separatorAfter: true,
      onClick: () => {
        console.warn("[PivotMenu] Format Cells dialog is not yet implemented.");
      },
    },

    // ------------------------------------------------------------------
    // 3. Refresh
    // ------------------------------------------------------------------
    {
      id: "pivot:refresh",
      label: "Refresh",
      group: "pivot",
      order: 30,
      visible: isInPivotRegion,
      onClick: async (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId === null) return;
        await refreshPivotCache(pivotId);
        window.dispatchEvent(new Event("pivot:refresh"));
      },
    },

    // ------------------------------------------------------------------
    // 4. Delete PivotTable
    // ------------------------------------------------------------------
    {
      id: "pivot:delete",
      label: "Delete PivotTable",
      group: "pivot",
      order: 40,
      visible: isInPivotRegion,
      separatorAfter: true,
      onClick: async (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId === null) return;
        // Clean up frontend cache before backend delete
        deleteCachedPivotView(pivotId);
        await deletePivotTable(pivotId);
        // Close task pane if the deleted pivot was being edited
        closeTaskPane(PIVOT_PANE_ID);
        // Refresh overlay regions + trigger grid cell re-fetch
        window.dispatchEvent(new Event("pivot:refresh"));
      },
    },

    // ------------------------------------------------------------------
    // 4b. Rename PivotTable
    // ------------------------------------------------------------------
    {
      id: "pivot:rename",
      label: "Rename PivotTable...",
      group: "pivot",
      order: 45,
      visible: isInPivotRegion,
      onClick: async (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId === null) return;
        const newName = window.prompt("Enter a new name for this PivotTable:");
        if (newName === null || newName.trim() === "") return;
        await updatePivotProperties({ pivotId, name: newName.trim() });
        window.dispatchEvent(new Event("pivot:refresh"));
      },
    },

    // ------------------------------------------------------------------
    // 5. Sort (sub-menu)
    // ------------------------------------------------------------------
    {
      id: "pivot:sort",
      label: "Sort",
      group: "pivot",
      order: 50,
      visible: isDimensionHeader,
      children: [
        {
          id: "pivot:sort:aToZ",
          label: "Sort A to Z",
          onClick: async (ctx) => {
            try {
              const cellData = await getClickedCellData(ctx);
              if (!cellData) return;
              const { pivotInfo, cell } = cellData;
              const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
              if (fieldIndex === undefined) return;
              await sortPivotField({
                pivotId: pivotInfo.pivotId,
                fieldIndex,
                sortBy: "ascending",
              });
              window.dispatchEvent(new Event("pivot:refresh"));
            } catch (e) {
              console.error("[PivotMenu] Failed to sort A to Z:", e);
            }
          },
        },
        {
          id: "pivot:sort:zToA",
          label: "Sort Z to A",
          onClick: async (ctx) => {
            try {
              const cellData = await getClickedCellData(ctx);
              if (!cellData) return;
              const { pivotInfo, cell } = cellData;
              const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
              if (fieldIndex === undefined) return;
              await sortPivotField({
                pivotId: pivotInfo.pivotId,
                fieldIndex,
                sortBy: "descending",
              });
              window.dispatchEvent(new Event("pivot:refresh"));
            } catch (e) {
              console.error("[PivotMenu] Failed to sort Z to A:", e);
            }
          },
        },
        {
          id: "pivot:sort:more",
          label: "More Sort Options...",
          disabled: true,
          onClick: () => {
            console.warn("[PivotMenu] More Sort Options dialog is not yet implemented.");
          },
        },
      ],
      onClick: () => {}, // Parent item - no direct action
    },

    // ------------------------------------------------------------------
    // 6. Filter (sub-menu)
    // ------------------------------------------------------------------
    {
      id: "pivot:filter",
      label: "Filter",
      group: "pivot",
      order: 60,
      visible: isDimensionHeader,
      separatorAfter: true,
      children: [
        {
          id: "pivot:filter:keepOnly",
          label: "Keep Only Selected Items",
          onClick: async (ctx) => {
            const cellData = await getClickedCellData(ctx);
            if (!cellData) return;
            const { pivotInfo, cell } = cellData;
            if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;

            const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
            if (fieldIndex === undefined) return;

            const itemLabel = cell.formattedValue;
            if (!itemLabel) return;

            // Get all unique values, then hide everything except the selected item
            try {
              const fieldValues = await getPivotFieldUniqueValues(pivotInfo.pivotId, fieldIndex);
              const selectedItems = [itemLabel];
              await applyPivotFilter({
                pivotId: pivotInfo.pivotId,
                fieldIndex,
                filters: {
                  manualFilter: { selectedItems },
                },
              });
              window.dispatchEvent(new Event("pivot:refresh"));
            } catch (e) {
              console.error("[PivotMenu] Failed to apply keep-only filter:", e);
            }
          },
        },
        {
          id: "pivot:filter:hide",
          label: "Hide Selected Items",
          onClick: async (ctx) => {
            const cellData = await getClickedCellData(ctx);
            if (!cellData) return;
            const { pivotInfo, cell } = cellData;
            if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;

            const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
            if (fieldIndex === undefined) return;

            const itemLabel = cell.formattedValue;
            if (!itemLabel) return;

            // Get all unique values, then remove the selected item
            try {
              const fieldValues = await getPivotFieldUniqueValues(pivotInfo.pivotId, fieldIndex);
              const selectedItems = fieldValues.uniqueValues.filter((v) => v !== itemLabel);
              await applyPivotFilter({
                pivotId: pivotInfo.pivotId,
                fieldIndex,
                filters: {
                  manualFilter: { selectedItems },
                },
              });
              window.dispatchEvent(new Event("pivot:refresh"));
            } catch (e) {
              console.error("[PivotMenu] Failed to apply hide filter:", e);
            }
          },
        },
        {
          id: "pivot:filter:top10",
          label: "Top 10...",
          disabled: true,
          onClick: () => {
            console.warn("[PivotMenu] Top 10 filter dialog is not yet implemented.");
          },
        },
      ],
      onClick: () => {}, // Parent item - no direct action
    },

    // ------------------------------------------------------------------
    // 7. Subtotal "FieldName" (toggle)
    // ------------------------------------------------------------------
    {
      id: "pivot:subtotal",
      label: (ctx: GridMenuContext) => {
        const fieldName = getFieldNameForCell(ctx);
        return fieldName ? `Subtotal "${fieldName}"` : "Subtotal";
      },
      group: "pivot",
      order: 70,
      visible: isDimensionHeader,
      separatorAfter: true,
      onClick: async (ctx) => {
        const cellData = await getClickedCellData(ctx);
        if (!cellData) return;
        const { pivotInfo, cell } = cellData;
        if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;

        const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
        if (fieldIndex === undefined) return;

        try {
          // Fetch current field info to read the current subtotal state
          const fieldInfo = await getPivotFieldInfo(pivotInfo.pivotId, fieldIndex);
          const currentShowSubtotals = fieldInfo.subtotals.automatic !== false;

          // Toggle: rebuild the field configuration with toggled showSubtotals
          const isRow = cell.cellType === "RowHeader";
          const config = pivotInfo.fieldConfiguration;
          const fields = isRow ? [...config.rowFields] : [...config.columnFields];

          // Find the field by source index
          const fieldInZone = fields.find((f) => f.sourceIndex === fieldIndex);
          if (!fieldInZone) return;

          // Build the update request: toggle showSubtotals
          const updatedFields = fields.map((f) => {
            if (f.sourceIndex === fieldIndex) {
              return {
                sourceIndex: f.sourceIndex,
                name: f.name,
                showSubtotals: !currentShowSubtotals,
              };
            }
            return {
              sourceIndex: f.sourceIndex,
              name: f.name,
            };
          });

          const updateRequest = isRow
            ? { pivotId: pivotInfo.pivotId, rowFields: updatedFields }
            : { pivotId: pivotInfo.pivotId, columnFields: updatedFields };

          await updatePivotFields(updateRequest);
          window.dispatchEvent(new Event("pivot:refresh"));
        } catch (e) {
          console.error("[PivotMenu] Failed to toggle subtotals:", e);
        }
      },
    },

    // ------------------------------------------------------------------
    // 8. Expand/Collapse (sub-menu)
    // ------------------------------------------------------------------
    {
      id: "pivot:expandCollapse",
      label: "Expand/Collapse",
      group: "pivot",
      order: 80,
      visible: isInPivotRegion,
      separatorAfter: true,
      children: [
        {
          id: "pivot:ec:expand",
          label: "Expand",
          onClick: async (ctx) => {
            try {
              const cellData = await getClickedCellData(ctx);
              if (!cellData) return;
              const { pivotInfo, cell } = cellData;
              if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;
              if (!cell.isExpandable || !cell.isCollapsed) return;

              const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
              if (fieldIndex === undefined) return;

              await setPivotItemExpanded({
                pivotId: pivotInfo.pivotId,
                fieldIndex,
                itemName: cell.formattedValue || "",
                isExpanded: true,
              });
              window.dispatchEvent(new Event("pivot:refresh"));
            } catch (e) {
              console.error("[PivotMenu] Failed to expand item:", e);
            }
          },
        },
        {
          id: "pivot:ec:collapse",
          label: "Collapse",
          onClick: async (ctx) => {
            try {
              const cellData = await getClickedCellData(ctx);
              if (!cellData) return;
              const { pivotInfo, cell } = cellData;
              if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;
              if (!cell.isExpandable || cell.isCollapsed) return;

              const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
              if (fieldIndex === undefined) return;

              await setPivotItemExpanded({
                pivotId: pivotInfo.pivotId,
                fieldIndex,
                itemName: cell.formattedValue || "",
                isExpanded: false,
              });
              window.dispatchEvent(new Event("pivot:refresh"));
            } catch (e) {
              console.error("[PivotMenu] Failed to collapse item:", e);
            }
          },
        },
        {
          id: "pivot:ec:expandField",
          label: "Expand Entire Field",
          onClick: async (ctx) => {
            try {
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
                expand: true,
              });
              window.dispatchEvent(new Event("pivot:refresh"));
            } catch (e) {
              console.error("[PivotMenu] Failed to expand entire field:", e);
            }
          },
        },
        {
          id: "pivot:ec:collapseField",
          label: "Collapse Entire Field",
          separatorAfter: true,
          onClick: async (ctx) => {
            try {
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
            } catch (e) {
              console.error("[PivotMenu] Failed to collapse entire field:", e);
            }
          },
        },
        {
          id: "pivot:ec:expandAll",
          label: "Expand All",
          onClick: async (ctx) => {
            const pivotId = getPivotIdFromContext(ctx);
            if (pivotId === null) return;
            await expandCollapseAll({ pivotId, expand: true });
            window.dispatchEvent(new Event("pivot:refresh"));
          },
        },
        {
          id: "pivot:ec:collapseAll",
          label: "Collapse All",
          onClick: async (ctx) => {
            const pivotId = getPivotIdFromContext(ctx);
            if (pivotId === null) return;
            await expandCollapseAll({ pivotId, expand: false });
            window.dispatchEvent(new Event("pivot:refresh"));
          },
        },
      ],
      onClick: () => {}, // Parent item - no direct action
    },

    // ------------------------------------------------------------------
    // 9. Group...
    // ------------------------------------------------------------------
    {
      id: "pivot:group",
      label: "Group...",
      group: "pivot",
      order: 90,
      visible: isDimensionHeader,
      onClick: async (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId === null) return;

        const cellData = await getClickedCellData(ctx);
        if (!cellData) return;
        const { cell } = cellData;
        if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;

        const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
        if (fieldIndex === undefined) return;

        showDialog(PIVOT_GROUP_DIALOG_ID, {
          pivotId,
          fieldIndex,
          isRow: cell.cellType === "RowHeader",
        });
      },
    },

    // ------------------------------------------------------------------
    // 10. Ungroup...
    // ------------------------------------------------------------------
    {
      id: "pivot:ungroup",
      label: "Ungroup...",
      group: "pivot",
      order: 100,
      visible: isDimensionHeader,
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
    // 11. Move (sub-menu, stubs)
    // ------------------------------------------------------------------
    {
      id: "pivot:move",
      label: (ctx: GridMenuContext) => {
        const itemLabel = getItemLabelForCell(ctx);
        return itemLabel ? `Move "${itemLabel}"` : "Move";
      },
      group: "pivot",
      order: 110,
      visible: isDimensionHeader,
      separatorAfter: true,
      children: [
        {
          id: "pivot:move:begin",
          label: (ctx: GridMenuContext) => {
            const itemLabel = getItemLabelForCell(ctx);
            return itemLabel ? `Move "${itemLabel}" to Beginning` : "Move to Beginning";
          },
          disabled: true,
          onClick: () => {
            console.warn("[PivotMenu] Move to Beginning requires manual sort backend support.");
          },
        },
        {
          id: "pivot:move:up",
          label: (ctx: GridMenuContext) => {
            const itemLabel = getItemLabelForCell(ctx);
            return itemLabel ? `Move "${itemLabel}" Up` : "Move Up";
          },
          disabled: true,
          onClick: () => {
            console.warn("[PivotMenu] Move Up requires manual sort backend support.");
          },
        },
        {
          id: "pivot:move:down",
          label: (ctx: GridMenuContext) => {
            const itemLabel = getItemLabelForCell(ctx);
            return itemLabel ? `Move "${itemLabel}" Down` : "Move Down";
          },
          disabled: true,
          onClick: () => {
            console.warn("[PivotMenu] Move Down requires manual sort backend support.");
          },
        },
        {
          id: "pivot:move:end",
          label: (ctx: GridMenuContext) => {
            const itemLabel = getItemLabelForCell(ctx);
            return itemLabel ? `Move "${itemLabel}" to End` : "Move to End";
          },
          disabled: true,
          onClick: () => {
            console.warn("[PivotMenu] Move to End requires manual sort backend support.");
          },
        },
      ],
      onClick: () => {}, // Parent item - no direct action
    },

    // ------------------------------------------------------------------
    // 12. Remove "FieldName"
    // ------------------------------------------------------------------
    {
      id: "pivot:removeField",
      label: (ctx: GridMenuContext) => {
        const fieldName = getFieldNameForCell(ctx);
        return fieldName ? `Remove "${fieldName}"` : "Remove Field";
      },
      group: "pivot",
      order: 120,
      visible: isDimensionHeader,
      separatorAfter: true,
      onClick: async (ctx) => {
        const cellData = await getClickedCellData(ctx);
        if (!cellData) return;
        const { pivotInfo, cell } = cellData;
        if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;

        const isRow = cell.cellType === "RowHeader";
        const config = pivotInfo.fieldConfiguration;
        const fields = isRow ? config.rowFields : config.columnFields;

        const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
        if (fieldIndex === undefined) return;

        // Find the position of this field in the hierarchy
        const position = fields.findIndex((f) => f.sourceIndex === fieldIndex);
        if (position === -1) return;

        try {
          await removePivotHierarchy({
            pivotId: pivotInfo.pivotId,
            axis: isRow ? "row" : "column",
            position,
          });
          window.dispatchEvent(new Event("pivot:refresh"));
        } catch (e) {
          console.error("[PivotMenu] Failed to remove field:", e);
        }
      },
    },

    // ------------------------------------------------------------------
    // 13. Field Settings...
    // ------------------------------------------------------------------
    {
      id: "pivot:fieldSettings",
      label: "Field Settings...",
      group: "pivot",
      order: 130,
      visible: isDimensionHeader,
      onClick: async (ctx) => {
        const cellData = await getClickedCellData(ctx);
        if (!cellData) return;
        const { pivotInfo, cell } = cellData;
        if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") return;

        const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
        if (fieldIndex === undefined) return;

        showDialog(PIVOT_FIELD_SETTINGS_DIALOG_ID, {
          pivotId: pivotInfo.pivotId,
          fieldIndex,
          axis: cell.cellType === "RowHeader" ? "row" : "column",
        });
      },
    },

    // ------------------------------------------------------------------
    // 14. PivotTable Options...
    // ------------------------------------------------------------------
    {
      id: "pivot:pivotOptions",
      label: "PivotTable Options...",
      group: "pivot",
      order: 140,
      visible: isInPivotRegion,
      onClick: async (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId === null) return;
        showDialog(PIVOT_OPTIONS_DIALOG_ID, { pivotId });
      },
    },

    // ------------------------------------------------------------------
    // 15. Hide Field List
    // ------------------------------------------------------------------
    {
      id: "pivot:hideFieldList",
      label: (ctx: GridMenuContext) => {
        const manuallyClosed = getTaskPaneManuallyClosed();
        return manuallyClosed.includes(PIVOT_PANE_ID)
          ? "Show Field List"
          : "Hide Field List";
      },
      group: "pivot",
      order: 150,
      visible: isInPivotRegion,
      onClick: (ctx) => {
        const manuallyClosed = getTaskPaneManuallyClosed();
        if (manuallyClosed.includes(PIVOT_PANE_ID)) {
          // Show the field list
          clearTaskPaneManuallyClosed(PIVOT_PANE_ID);
          const pivotId = getPivotIdFromContext(ctx);
          if (pivotId !== null) {
            openTaskPane(PIVOT_PANE_ID, { pivotId });
          }
        } else {
          // Hide the field list
          closeTaskPane(PIVOT_PANE_ID);
          markTaskPaneManuallyClosed(PIVOT_PANE_ID);
        }
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
