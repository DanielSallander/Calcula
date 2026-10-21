//! FILENAME: app/extensions/Pivot/handlers/pivotContextMenu.ts
// PURPOSE: Registers the full pivot dimension context menu (16 items) in the grid right-click menu.
// CONTEXT: Items are visible only when the right-clicked cell is inside a pivot region.
//          Dimension-specific items (Sort, Filter, Subtotal, etc.) are additionally
//          restricted to RowHeader/ColumnHeader cells via cached view data.
//
//          A VALUE cell (data or value-area total) gets Excel's value items
//          first (`valueCellMenuItems`, WP-A S10): Copy (canvas box only),
//          Number Format, Sort (greyed, BUG-0459), Remove "<field>",
//          Summarize Values By (range pivots only), Show Values As, Show
//          Details, Value Field Settings. On a data-model pivot the items the
//          model transport cannot carry are greyed with the reason.
//
//          Every async action reports a failure to the USER (`reportMenuFailure`,
//          a toast) -- never to the console alone (BUG-0096, BUG-0456). An item
//          that cannot act where it was opened is shown DISABLED with a reason
//          (`disabledReason`) rather than doing nothing when clicked.

import {
  gridExtensions,
  showDialog,
  showToast,
  closeTaskPane,
  openTaskPane,
  markTaskPaneManuallyClosed,
  clearTaskPaneManuallyClosed,
  getTaskPaneManuallyClosed,
  type GridContextMenuItem,
  type GridMenuContext,
} from "@api";
import { emitAppEvent } from "@api/events";
import { pivotCellItemKey } from "@api/pivotMembers";
import { PivotEvents } from "../../_shared/lib/pivotEvents";

import {
  isInPivotRegion,
  isDimensionHeader,
  getPivotIdFromContext,
  getFieldNameForCell,
  getItemLabelForCell,
  getClickedCellData,
  expandTargetFor,
  expandDisabledReason,
  entireFieldTargetFor,
  entireFieldDisabledReason,
  getCachedCellData,
  isCanvasPivotContext,
  isValueCell,
  valueFieldIndexFor,
  valueFieldNameFor,
} from "./pivotContextMenuHelpers";
import { isModelPivot, openPivotPaneForPivot } from "./selectionHandler";
import { CommandRegistry } from "@api/commands";
import { PIVOT_CANVAS_COPY_CELLS_COMMAND } from "../lib/pivotCanvasCellCommands";
import { runPivotDrillThrough } from "../lib/pivotCellDoubleClick";
import { editPivotValueField } from "../lib/valueFieldEdits";
import { requestValueFieldDialog, type ValueFieldDialogKind } from "../lib/valueFieldDialogRequest";
import { NEEDS_BASE_FIELD, SHOW_VALUES_AS_OPTIONS } from "../lib/showValuesAsOptions";
import type { AggregationType } from "../components/types";

import {
  refreshPivotCache,
  deletePivotTable,
  sortPivotField,
  applyPivotFilter,
  getPivotFieldUniqueValues,
  expandCollapseLevel,
  expandCollapseAll,
  ungroupPivotField,
  removePivotHierarchy,
  updatePivotFields,
  getPivotFieldInfo,
  updatePivotProperties,
  type PivotCellData,
  type PivotRegionInfo,
} from "../lib/pivot-api";
import { setPivotItemExpandedAt } from "../lib/pivotChromeActions";

import { deleteCachedPivotView } from "../lib/pivotViewStore";

import {
  PIVOT_GROUP_DIALOG_ID,
  PIVOT_FIELD_SETTINGS_DIALOG_ID,
  PIVOT_OPTIONS_DIALOG_ID,
  PIVOT_DRILL_BEHAVIOR_DIALOG_ID,
  PIVOT_PANE_ID,
} from "../manifest";
import { confirmAsync, promptAsync } from "@api/dialogs";

// ============================================================================
// Failure reporting
// ============================================================================

/** The text of a thrown value (an Error's message, else the value itself). */
function failureText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tell the user a menu action failed (BUG-0096: never a console-only catch).
 * The console line stays for diagnosis; the toast is what the user sees.
 */
function reportMenuFailure(label: string, err: unknown): void {
  console.error(`[PivotMenu] ${label} failed:`, err);
  showToast(`${label} failed: ${failureText(err)}`, { variant: "error" });
}

/** Wrap an item's action so ANY failure reaches the user, named by `label`. */
function menuAction(
  label: string,
  run: (ctx: GridMenuContext) => void | Promise<void>,
): (ctx: GridMenuContext) => Promise<void> {
  return async (ctx) => {
    try {
      await run(ctx);
    } catch (err) {
      reportMenuFailure(label, err);
    }
  };
}

/**
 * The clicked dimension header, its pivot and its field's source index, read
 * from the backend. Throws (so the action's failure toast says why) instead of
 * returning silently when the cell can no longer be read or is not an item.
 */
async function clickedHeader(ctx: GridMenuContext): Promise<{
  pivotInfo: PivotRegionInfo;
  cell: PivotCellData;
  fieldIndex: number;
}> {
  const cellData = await getClickedCellData(ctx);
  if (!cellData) throw new Error("the PivotTable cell under the pointer could not be read");
  const { pivotInfo, cell } = cellData;
  if (cell.cellType !== "RowHeader" && cell.cellType !== "ColumnHeader") {
    throw new Error("the cell under the pointer is not a PivotTable item");
  }
  const fieldIndex = cell.groupPath?.[cell.groupPath.length - 1]?.[0];
  if (fieldIndex === undefined) throw new Error("the PivotTable item under the pointer names no field");
  return { pivotInfo, cell, fieldIndex };
}

/** The pivot under the menu, or a thrown refusal (never a silent return). */
function pivotIdOrThrow(ctx: GridMenuContext): string {
  const pivotId = getPivotIdFromContext(ctx);
  if (pivotId === null) throw new Error("no PivotTable is under the pointer");
  return pivotId;
}

/**
 * Expand (`expand` true) or collapse the item an Expand / Collapse leaf
 * targets: the clicked header, or for a value cell the row item governing it.
 * The item is disabled with a reason where this cannot act, so the refusals
 * here only answer a click that raced a view change -- with the same reason.
 */
async function expandOrCollapse(ctx: GridMenuContext, expand: boolean): Promise<void> {
  const target = expandTargetFor(ctx);
  const reason = expandDisabledReason(ctx, expand);
  if (!target || reason !== null) {
    showToast(reason ?? `Nothing to ${expand ? "expand" : "collapse"} here.`, { variant: "info" });
    return;
  }
  const sent = await setPivotItemExpandedAt(target.pivotId, target.header, target.isRow, expand);
  if (!sent) {
    showToast(expand ? "Already expanded." : "Already collapsed.", { variant: "info" });
  }
}

/** Expand or collapse every item of the field an Entire Field leaf targets. */
async function expandOrCollapseField(ctx: GridMenuContext, expand: boolean): Promise<void> {
  const target = entireFieldTargetFor(ctx);
  if (!target) {
    showToast(entireFieldDisabledReason(ctx, expand) ?? "No field here.", { variant: "info" });
    return;
  }
  await expandCollapseLevel({
    pivotId: target.pivotId,
    isRow: target.isRow,
    fieldIndex: target.fieldIndex,
    expand,
  });
  window.dispatchEvent(new Event("pivot:refresh"));
}

// ============================================================================
// Value-cell items (Excel's menu on a PivotTable value)
// ============================================================================

/** Why a value item cannot act: the cell's value field is not known. */
export const VALUE_FIELD_UNKNOWN_REASON = "The value field this cell shows cannot be determined.";

/**
 * Why Number Format / Show Values As / Value Field Settings are greyed on a
 * data-model pivot: the model transport cannot carry a value field's format or
 * Show Values As (`BiValueFieldRef` is a measure name and a custom name, and
 * `update_bi_pivot_fields` takes the model's format), so the edit would be a
 * silent no-op. Also the answer when the pivot's kind is not known.
 */
export const MODEL_PIVOT_REASON = "Not available on a data-model PivotTable yet.";

/** Why Sort on a value cell is greyed (BUG-0459: values_hierarchy is read by no code). */
export const SORT_BY_VALUE_REASON = "Sorting by values is not available yet.";

/** Why Copy is greyed when the canvas cell copy is not installed. */
export const COPY_UNAVAILABLE_REASON = "Copying PivotTable cells is not available yet.";

/** The aggregations "Summarize Values By" offers (Excel's list). */
const SUMMARIZE_CHOICES: ReadonlyArray<{ aggregation: AggregationType; label: string }> = [
  { aggregation: "sum", label: "Sum" },
  { aggregation: "count", label: "Count" },
  { aggregation: "average", label: "Average" },
  { aggregation: "max", label: "Max" },
  { aggregation: "min", label: "Min" },
  { aggregation: "product", label: "Product" },
];

/** A value item's reason to be greyed: the cell names no value field. */
function valueItemReason(ctx: GridMenuContext): string | null {
  return valueFieldIndexFor(ctx) === null ? VALUE_FIELD_UNKNOWN_REASON : null;
}

/**
 * The reason of an item that also cannot act on a data-model pivot (or one
 * whose kind is not known yet -- never guessed).
 */
function modelGatedReason(ctx: GridMenuContext): string | null {
  const reason = valueItemReason(ctx);
  if (reason !== null) return reason;
  const pivotId = getPivotIdFromContext(ctx);
  return pivotId !== null && isModelPivot(pivotId) === false ? null : MODEL_PIVOT_REASON;
}

/** Whether Summarize Values By shows: a value cell of a pivot known to be a RANGE pivot. */
function summarizeVisible(ctx: GridMenuContext): boolean {
  if (!isValueCell(ctx)) return false;
  const pivotId = getPivotIdFromContext(ctx);
  return pivotId !== null && isModelPivot(pivotId) === false;
}

/** The pivot and value field a value item acts on, or a thrown reason. */
function valueTarget(ctx: GridMenuContext): { pivotId: string; valueFieldIndex: number } {
  const pivotId = pivotIdOrThrow(ctx);
  const valueFieldIndex = valueFieldIndexFor(ctx);
  if (valueFieldIndex === null) throw new Error(VALUE_FIELD_UNKNOWN_REASON);
  return { pivotId, valueFieldIndex };
}

/** Open a value-field modal for the clicked cell's value field. */
async function openValueFieldDialog(ctx: GridMenuContext, dialog: ValueFieldDialogKind): Promise<void> {
  const { pivotId, valueFieldIndex } = valueTarget(ctx);
  await requestValueFieldDialog({ pivotId, valueFieldIndex, dialog });
}

/**
 * The items a VALUE cell (a data cell or a value-area total) gets, leading the
 * pivot group (order < 20), on a worksheet pivot and a canvas pivot box alike
 * -- except Copy, which is the canvas box's own (a worksheet has Core's Copy).
 * Every item that cannot act is shown DISABLED with a reason.
 */
function valueCellMenuItems(): GridContextMenuItem[] {
  const disabledBy = (reasonOf: (ctx: GridMenuContext) => string | null) => ({
    disabled: (ctx: GridMenuContext) => reasonOf(ctx) !== null,
    disabledReason: reasonOf,
  });
  const copyReason = (): string | null =>
    CommandRegistry.has(PIVOT_CANVAS_COPY_CELLS_COMMAND) ? null : COPY_UNAVAILABLE_REASON;

  return [
    {
      id: "pivot:copy",
      label: "Copy",
      shortcut: "Ctrl+C",
      group: "pivot",
      order: 2,
      visible: (ctx) => isCanvasPivotContext(ctx),
      separatorAfter: true,
      ...disabledBy(copyReason),
      onClick: menuAction("Copy", async () => {
        const reason = copyReason();
        if (reason !== null) throw new Error(reason);
        await CommandRegistry.execute(PIVOT_CANVAS_COPY_CELLS_COMMAND);
      }),
    },
    {
      id: "pivot:numberFormat",
      label: "Number Format...",
      group: "pivot",
      order: 4,
      visible: (ctx) => isValueCell(ctx),
      ...disabledBy(modelGatedReason),
      onClick: menuAction("Number Format", (ctx) => openValueFieldDialog(ctx, "numberFormat")),
    },
    {
      id: "pivot:sortByValue",
      label: "Sort",
      group: "pivot",
      order: 6,
      visible: (ctx) => isValueCell(ctx),
      disabled: true,
      disabledReason: SORT_BY_VALUE_REASON,
      children: [
        {
          id: "pivot:sortByValue:ascending",
          label: "Sort Smallest to Largest",
          disabled: true,
          disabledReason: SORT_BY_VALUE_REASON,
          onClick: () => showToast(SORT_BY_VALUE_REASON, { variant: "info" }),
        },
        {
          id: "pivot:sortByValue:descending",
          label: "Sort Largest to Smallest",
          disabled: true,
          disabledReason: SORT_BY_VALUE_REASON,
          onClick: () => showToast(SORT_BY_VALUE_REASON, { variant: "info" }),
        },
      ],
      onClick: () => {}, // Parent item - no direct action
    },
    {
      id: "pivot:removeValueField",
      label: (ctx: GridMenuContext) => {
        const name = valueFieldNameFor(ctx);
        return name ? `Remove "${name}"` : "Remove Value Field";
      },
      group: "pivot",
      order: 8,
      visible: (ctx) => isValueCell(ctx),
      separatorAfter: true,
      ...disabledBy(valueItemReason),
      onClick: menuAction("Remove value field", async (ctx) => {
        const { pivotId, valueFieldIndex } = valueTarget(ctx);
        await editPivotValueField(pivotId, valueFieldIndex, { kind: "remove" });
      }),
    },
    {
      id: "pivot:summarizeBy",
      label: "Summarize Values By",
      group: "pivot",
      order: 10,
      visible: summarizeVisible,
      ...disabledBy(valueItemReason),
      children: [
        ...SUMMARIZE_CHOICES.map(({ aggregation, label }, i): GridContextMenuItem => ({
          id: `pivot:summarizeBy:${aggregation}`,
          label,
          ...disabledBy(valueItemReason),
          separatorAfter: i === SUMMARIZE_CHOICES.length - 1,
          onClick: menuAction(`Summarize Values By ${label}`, async (ctx) => {
            const { pivotId, valueFieldIndex } = valueTarget(ctx);
            await editPivotValueField(pivotId, valueFieldIndex, { kind: "summarize", aggregation });
          }),
        })),
        {
          id: "pivot:summarizeBy:more",
          label: "More Options...",
          ...disabledBy(valueItemReason),
          onClick: menuAction("More Options", (ctx) => openValueFieldDialog(ctx, "settings")),
        },
      ],
      onClick: () => {}, // Parent item - no direct action
    },
    {
      id: "pivot:showValuesAs",
      label: "Show Values As",
      group: "pivot",
      order: 12,
      visible: (ctx) => isValueCell(ctx),
      separatorAfter: true,
      ...disabledBy(modelGatedReason),
      children: SHOW_VALUES_AS_OPTIONS.map(({ value, label }): GridContextMenuItem => {
        // A calculation relative to a base opens the settings dialog, where
        // the base field (and item) is chosen; the rest apply at once.
        const needsBase = NEEDS_BASE_FIELD.includes(value);
        return {
          id: `pivot:showValuesAs:${value}`,
          label: needsBase ? `${label}...` : label,
          ...disabledBy(modelGatedReason),
          onClick: menuAction(`Show Values As ${label}`, async (ctx) => {
            if (needsBase) {
              await openValueFieldDialog(ctx, "settings");
              return;
            }
            const { pivotId, valueFieldIndex } = valueTarget(ctx);
            await editPivotValueField(pivotId, valueFieldIndex, { kind: "showValuesAs", showValuesAs: value });
          }),
        };
      }),
      onClick: () => {}, // Parent item - no direct action
    },
    {
      id: "pivot:showDetails",
      label: "Show Details",
      group: "pivot",
      order: 14,
      visible: (ctx) => isValueCell(ctx),
      separatorAfter: true,
      ...disabledBy(valueItemReason),
      onClick: menuAction("Show Details", (ctx) => {
        const cached = getCachedCellData(ctx);
        if (!cached || !ctx.clickedCell) throw new Error("the PivotTable cell under the pointer could not be read");
        runPivotDrillThrough(cached.region.pivotId, cached.cell, ctx.clickedCell.row, ctx.clickedCell.col);
      }),
    },
    {
      id: "pivot:valueFieldSettings",
      label: "Value Field Settings...",
      group: "pivot",
      order: 16,
      visible: (ctx) => isValueCell(ctx),
      separatorAfter: true,
      ...disabledBy(modelGatedReason),
      onClick: menuAction("Value Field Settings", (ctx) => openValueFieldDialog(ctx, "settings")),
    },
  ];
}

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
    // 0. The value-cell items (Copy on a canvas box, Number Format, Sort,
    //    Remove, Summarize Values By, Show Values As, Show Details, Value
    //    Field Settings) -- they lead, as in Excel's menu on a value.
    // ------------------------------------------------------------------
    ...valueCellMenuItems(),

    // ------------------------------------------------------------------
    // 1. Format Cells... (stub)
    // ------------------------------------------------------------------
    {
      id: "pivot:formatCells",
      label: "Format Cells...",
      group: "pivot",
      order: 20,
      visible: isInPivotRegion,
      disabled: true,
      disabledReason: "Formatting PivotTable cells is not available yet.",
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
      onClick: menuAction("Refresh", async (ctx) => {
        const pivotId = pivotIdOrThrow(ctx);
        try {
          await refreshPivotCache(pivotId);
          window.dispatchEvent(new Event("pivot:refresh"));
        } catch (err) {
          const errStr = String(err);
          if (errStr.includes("Not connected") || errStr.includes("No connection")) {
            const shouldConnect = await confirmAsync(
              "This pivot table is not connected to a data source.\n\n" +
              "Open the Connections panel to connect?"
            );
            if (shouldConnect) {
              openTaskPane("connections-pane");
            }
            return;
          }
          throw err;
        }
      }),
    },

    // ------------------------------------------------------------------
    // 3b. Insert PivotChart
    // ------------------------------------------------------------------
    {
      id: "pivot:insertChart",
      label: "PivotChart...",
      group: "pivot",
      order: 35,
      visible: isInPivotRegion,
      separatorAfter: true,
      onClick: menuAction("PivotChart", (ctx) => {
        const pivotId = pivotIdOrThrow(ctx);
        showDialog("chart:createDialog", // Charts' public dialog id (string contract, not a code import)
           { pivotId });
      }),
    },

    // ------------------------------------------------------------------
    // Drill-through behavior (customize what a double-click drill returns)
    // ------------------------------------------------------------------
    {
      id: "pivot:drillBehavior",
      label: "Drill-through behavior...",
      group: "pivot",
      order: 36,
      visible: isInPivotRegion,
      onClick: menuAction("Drill-through behavior", (ctx) => {
        const pivotId = pivotIdOrThrow(ctx);
        showDialog(PIVOT_DRILL_BEHAVIOR_DIALOG_ID, { pivotId });
      }),
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
      onClick: menuAction("Delete PivotTable", async (ctx) => {
        const pivotId = pivotIdOrThrow(ctx);
        // Clean up frontend cache before backend delete
        deleteCachedPivotView(pivotId);
        await deletePivotTable(pivotId);
        // Close task pane if the deleted pivot was being edited
        closeTaskPane(PIVOT_PANE_ID);
        // Refresh overlay regions + trigger grid cell re-fetch
        window.dispatchEvent(new Event("pivot:refresh"));
      }),
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
      onClick: menuAction("Rename PivotTable", async (ctx) => {
        const pivotId = pivotIdOrThrow(ctx);
        const newName = await promptAsync("Enter a new name for this PivotTable:", {
          title: "Rename PivotTable",
        });
        if (newName === null || newName.trim() === "") return;
        await updatePivotProperties({ pivotId, name: newName.trim() });
        window.dispatchEvent(new Event("pivot:refresh"));
      }),
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
          onClick: menuAction("Sort A to Z", async (ctx) => {
            const { pivotInfo, fieldIndex } = await clickedHeader(ctx);
            await sortPivotField({
              pivotId: pivotInfo.pivotId,
              fieldIndex,
              sortBy: "ascending",
            });
            window.dispatchEvent(new Event("pivot:refresh"));
          }),
        },
        {
          id: "pivot:sort:zToA",
          label: "Sort Z to A",
          onClick: menuAction("Sort Z to A", async (ctx) => {
            const { pivotInfo, fieldIndex } = await clickedHeader(ctx);
            await sortPivotField({
              pivotId: pivotInfo.pivotId,
              fieldIndex,
              sortBy: "descending",
            });
            window.dispatchEvent(new Event("pivot:refresh"));
          }),
        },
        {
          id: "pivot:sort:more",
          label: "More Sort Options...",
          disabled: true,
          disabledReason: "More sort options are not available yet.",
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
          onClick: menuAction("Keep Only Selected Items", async (ctx) => {
            const { pivotInfo, cell, fieldIndex } = await clickedHeader(ctx);
            // The member KEY: a manual filter matches keys, never a label.
            // The blank member's key is "" (ruling Q8), so emptiness is only
            // "no name" when the cell names no member at all.
            const itemKey = pivotCellItemKey(cell);
            if (!itemKey && !cell.member) throw new Error("the item under the pointer has no name");
            await applyPivotFilter({
              pivotId: pivotInfo.pivotId,
              fieldIndex,
              filters: {
                manualFilter: { selectedItems: [itemKey] },
              },
            });
            window.dispatchEvent(new Event("pivot:refresh"));
          }),
        },
        {
          id: "pivot:filter:hide",
          label: "Hide Selected Items",
          onClick: menuAction("Hide Selected Items", async (ctx) => {
            const { pivotInfo, cell, fieldIndex } = await clickedHeader(ctx);
            const itemKey = pivotCellItemKey(cell);
            if (!itemKey && !cell.member) throw new Error("the item under the pointer has no name");

            // Every member KEY but the clicked one (keys, never labels).
            const fieldValues = await getPivotFieldUniqueValues(pivotInfo.pivotId, fieldIndex);
            const selectedItems = fieldValues.members.map((m) => m.key).filter((k) => k !== itemKey);
            await applyPivotFilter({
              pivotId: pivotInfo.pivotId,
              fieldIndex,
              filters: {
                manualFilter: { selectedItems },
              },
            });
            window.dispatchEvent(new Event("pivot:refresh"));
          }),
        },
        {
          id: "pivot:filter:top10",
          label: "Top 10...",
          disabled: true,
          disabledReason: "The Top 10 filter is not available yet.",
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
      onClick: menuAction("Subtotal", async (ctx) => {
        const { pivotInfo, cell, fieldIndex } = await clickedHeader(ctx);

        // Fetch current field info to read the current subtotal state
        const fieldInfo = await getPivotFieldInfo(pivotInfo.pivotId, fieldIndex);
        const currentShowSubtotals = fieldInfo.subtotals.automatic !== false;

        // Toggle: rebuild the field configuration with toggled showSubtotals
        const isRow = cell.cellType === "RowHeader";
        const config = pivotInfo.fieldConfiguration;
        const fields = isRow ? [...config.rowFields] : [...config.columnFields];

        // Find the field by source index
        const fieldInZone = fields.find((f) => f.sourceIndex === fieldIndex);
        if (!fieldInZone) throw new Error("the field is no longer in the PivotTable");

        // Build the update request: the whole zone (the command REPLACES a
        // zone it is given), with only the clicked field's subtotals
        // flipped. No field's item filter is sent: `update_pivot_fields`
        // keeps every setting it is not sent since BUG-0184 (it used to
        // rebuild each field, so toggling one field's subtotals cleared the
        // filters of every field in its zone), and an echoed list read at
        // click time could only race a filter changed since.
        const updatedFields = fields.map((f) =>
          f.sourceIndex === fieldIndex
            ? { sourceIndex: f.sourceIndex, name: f.name, showSubtotals: !currentShowSubtotals }
            : { sourceIndex: f.sourceIndex, name: f.name },
        );

        const updateRequest = isRow
          ? { pivotId: pivotInfo.pivotId, rowFields: updatedFields }
          : { pivotId: pivotInfo.pivotId, columnFields: updatedFields };

        await updatePivotFields(updateRequest);
        window.dispatchEvent(new Event("pivot:refresh"));
      }),
    },

    // ------------------------------------------------------------------
    // 8. Expand/Collapse (sub-menu)
    //    On a header the leaves act on that item; on a VALUE cell on the row
    //    item governing it (and Entire Field on that item's field). Where a
    //    leaf cannot act it is disabled with the reason.
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
          disabled: (ctx) => expandDisabledReason(ctx, true) !== null,
          disabledReason: (ctx) => expandDisabledReason(ctx, true),
          onClick: menuAction("Expand", (ctx) => expandOrCollapse(ctx, true)),
        },
        {
          id: "pivot:ec:collapse",
          label: "Collapse",
          disabled: (ctx) => expandDisabledReason(ctx, false) !== null,
          disabledReason: (ctx) => expandDisabledReason(ctx, false),
          onClick: menuAction("Collapse", (ctx) => expandOrCollapse(ctx, false)),
        },
        {
          id: "pivot:ec:expandField",
          label: "Expand Entire Field",
          disabled: (ctx) => entireFieldDisabledReason(ctx, true) !== null,
          disabledReason: (ctx) => entireFieldDisabledReason(ctx, true),
          onClick: menuAction("Expand Entire Field", (ctx) => expandOrCollapseField(ctx, true)),
        },
        {
          id: "pivot:ec:collapseField",
          label: "Collapse Entire Field",
          separatorAfter: true,
          disabled: (ctx) => entireFieldDisabledReason(ctx, false) !== null,
          disabledReason: (ctx) => entireFieldDisabledReason(ctx, false),
          onClick: menuAction("Collapse Entire Field", (ctx) => expandOrCollapseField(ctx, false)),
        },
        {
          id: "pivot:ec:expandAll",
          label: "Expand All",
          onClick: menuAction("Expand All", async (ctx) => {
            const pivotId = pivotIdOrThrow(ctx);
            await expandCollapseAll({ pivotId, expand: true });
            window.dispatchEvent(new Event("pivot:refresh"));
          }),
        },
        {
          id: "pivot:ec:collapseAll",
          label: "Collapse All",
          onClick: menuAction("Collapse All", async (ctx) => {
            const pivotId = pivotIdOrThrow(ctx);
            await expandCollapseAll({ pivotId, expand: false });
            window.dispatchEvent(new Event("pivot:refresh"));
          }),
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
      onClick: menuAction("Group", async (ctx) => {
        const pivotId = pivotIdOrThrow(ctx);
        const { cell, fieldIndex } = await clickedHeader(ctx);
        showDialog(PIVOT_GROUP_DIALOG_ID, {
          pivotId,
          fieldIndex,
          isRow: cell.cellType === "RowHeader",
        });
      }),
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
      onClick: menuAction("Ungroup", async (ctx) => {
        const { pivotInfo, fieldIndex } = await clickedHeader(ctx);
        await ungroupPivotField({
          pivotId: pivotInfo.pivotId,
          fieldIndex,
        });
        window.dispatchEvent(new Event("pivot:refresh"));
      }),
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
          disabledReason: "Moving items by hand is not available yet.",
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
          disabledReason: "Moving items by hand is not available yet.",
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
          disabledReason: "Moving items by hand is not available yet.",
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
          disabledReason: "Moving items by hand is not available yet.",
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
      onClick: menuAction("Remove field", async (ctx) => {
        const { pivotInfo, cell, fieldIndex } = await clickedHeader(ctx);

        const isRow = cell.cellType === "RowHeader";
        const config = pivotInfo.fieldConfiguration;
        const fields = isRow ? config.rowFields : config.columnFields;

        // Find the position of this field in the hierarchy
        const position = fields.findIndex((f) => f.sourceIndex === fieldIndex);
        if (position === -1) throw new Error("the field is no longer in the PivotTable");

        await removePivotHierarchy({
          pivotId: pivotInfo.pivotId,
          axis: isRow ? "row" : "column",
          position,
        });
        // An open field-list editor re-seeds, or its next edit would put the
        // removed field back (BUG-0466).
        emitAppEvent(PivotEvents.PIVOT_FIELDS_EDITED_ELSEWHERE, { pivotId: pivotInfo.pivotId });
        window.dispatchEvent(new Event("pivot:refresh"));
      }),
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
      onClick: menuAction("Field Settings", async (ctx) => {
        const { pivotInfo, cell, fieldIndex } = await clickedHeader(ctx);
        showDialog(PIVOT_FIELD_SETTINGS_DIALOG_ID, {
          pivotId: pivotInfo.pivotId,
          fieldIndex,
          axis: cell.cellType === "RowHeader" ? "row" : "column",
        });
      }),
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
      onClick: menuAction("PivotTable Options", (ctx) => {
        const pivotId = pivotIdOrThrow(ctx);
        showDialog(PIVOT_OPTIONS_DIALOG_ID, { pivotId });
      }),
    },

    // ------------------------------------------------------------------
    // 15. Hide Field List
    // ------------------------------------------------------------------
    {
      id: "pivot:hideFieldList",
      label: (ctx: GridMenuContext) => {
        // A canvas box's field list is the object pane's Fields tab (WP-C
        // D-PANE): the row is its door, never the worksheet pane's toggle.
        if (isCanvasPivotContext(ctx)) return "Show Field List";
        const manuallyClosed = getTaskPaneManuallyClosed();
        return manuallyClosed.includes(PIVOT_PANE_ID)
          ? "Show Field List"
          : "Hide Field List";
      },
      group: "pivot",
      order: 150,
      visible: isInPivotRegion,
      onClick: (ctx) => {
        if (isCanvasPivotContext(ctx)) {
          const pivotId = getPivotIdFromContext(ctx);
          if (pivotId !== null) {
            openPivotPaneForPivot(String(pivotId)).catch((err) => reportMenuFailure("Show Field List", err));
          }
          return;
        }
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
    // ------------------------------------------------------------------
    // 16. Edit Script
    // ------------------------------------------------------------------
    {
      id: "pivot:editScript",
      label: "Edit Script...",
      group: "pivot",
      order: 160,
      visible: isInPivotRegion,
      onClick: (ctx) => {
        const pivotId = getPivotIdFromContext(ctx);
        if (pivotId !== null) {
          emitAppEvent("scriptable-objects:edit-script", {
            objectType: "pivot",
            instanceId: String(pivotId),
            objectName: `Pivot ${pivotId}`,
          });
        }
      },
    },
  ];

  gridExtensions.registerContextMenuItems(items);

  // The ids are read from the items just registered, never from a hand list:
  // one kept beside them had drifted, and "Drill-Through Behavior..." outlived
  // every deactivate (wave E, Y14).
  const ownIds = items.map((item) => item.id);
  return () => {
    for (const id of ownIds) {
      gridExtensions.unregisterContextMenuItem(id);
    }
  };
}
