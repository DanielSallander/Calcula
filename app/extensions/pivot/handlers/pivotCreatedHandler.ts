//! FILENAME: app/extensions/pivot/handlers/pivotCreatedHandler.ts
// PURPOSE: Handles pivot:created events to open the pivot editor pane.
// CONTEXT: When a new pivot table is created, this handler loads the source fields
// and opens the pivot editor task pane.

import { getPivotSourceData } from "../../../src/api";
import { useTaskPaneStore } from "../../../src/shell/task-pane";
import { PIVOT_PANE_ID } from "../manifest";
import type { SourceField, PivotEditorViewData } from "../types";
import { setJustCreatedPivot } from "./selectionHandler";

/**
 * Handle the pivot:created event.
 * Loads source fields and opens the pivot editor pane.
 */
export async function handlePivotCreated(detail: { pivotId: number }): Promise<void> {
  const { pivotId } = detail;

  console.log("[Pivot Extension] Pivot created:", pivotId);

  // Clear manually closed state for pivot pane when a new pivot is created
  useTaskPaneStore.getState().clearManuallyClosed(PIVOT_PANE_ID);

  // Prevent the selection handler from closing the pane before regions are cached
  setJustCreatedPivot(true);

  try {
    const sourceData = await getPivotSourceData(pivotId, [], 1);

    const sourceFields: SourceField[] = sourceData.headers.map((name, index) => ({
      index,
      name,
      isNumeric: isLikelyNumericField(name),
    }));

    const paneData: PivotEditorViewData = {
      pivotId,
      sourceFields,
      initialRows: [],
      initialColumns: [],
      initialValues: [],
      initialFilters: [],
      initialLayout: {},
    };

    useTaskPaneStore.getState().openPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
  } catch (error) {
    console.error("[Pivot Extension] Failed to load pivot source fields:", error);

    // Open with empty data so user can still see the pane
    const paneData: PivotEditorViewData = {
      pivotId,
      sourceFields: [],
      initialRows: [],
      initialColumns: [],
      initialValues: [],
      initialFilters: [],
      initialLayout: {},
    };
    useTaskPaneStore.getState().openPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
  }
}

/**
 * Simple heuristic to determine if a field name suggests numeric data.
 */
function isLikelyNumericField(name: string): boolean {
  const lowerName = name.toLowerCase();
  const numericKeywords = [
    "amount", "price", "cost", "total", "sum", "count", "qty", "quantity",
    "revenue", "sales", "profit", "margin", "rate", "percent", "percentage",
    "number", "num", "value", "score", "points", "balance", "fee", "tax",
    "discount", "weight", "height", "width", "size", "age", "year", "month",
    "day", "hours", "minutes", "seconds", "duration", "distance", "speed",
  ];

  return numericKeywords.some((keyword) => lowerName.includes(keyword));
}
