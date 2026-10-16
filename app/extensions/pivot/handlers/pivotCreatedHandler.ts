//! FILENAME: app/extensions/pivot/handlers/pivotCreatedHandler.ts
// PURPOSE: Handles pivot:created events to open the pivot editor pane.
// CONTEXT: When a new pivot table is created, this handler loads the source fields
// and opens the pivot editor task pane.
// ARCHITECTURE: Uses api/pivot facade and api UI functions (The Facade Rule).
// Extensions must NEVER import from shell or core directly.

import { pivot } from "@api/pivot";
import { openTaskPane, clearTaskPaneManuallyClosed } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { PIVOT_PANE_ID } from "../manifest";
import type { SourceField, PivotEditorViewData } from "../types";
import { setJustCreatedPivot, ensureDesignTabRegistered } from "./selectionHandler";

/** Whether the ACTIVE sheet is a canvas page (a pivot made there is a box). */
export function isCanvasSurface(): boolean {
  return getGridStateSnapshot()?.surface === "canvas";
}

/**
 * Handle the pivot:created event.
 * Loads source fields and opens the pivot editor pane -- on a WORKSHEET. A
 * pivot made on a CANVAS is a box whose field list lives in the ONE object
 * pane (WP-C D-PANE): it opens on the box's Fields tab once the box is
 * published (lib/pivotVisualSelection.ts `adoptCreatedCanvasPivot`), never as
 * a stacked `pivot-editor` pane.
 */
export async function handlePivotCreated(detail: { pivotId: string }): Promise<void> {
  const { pivotId } = detail;

  console.log("[Pivot Extension] Pivot created:", pivotId);

  if (isCanvasSurface()) {
    // The Design ribbon tab still shows at once; the pane is the object pane's.
    ensureDesignTabRegistered();
    return;
  }

  // Clear manually closed state for pivot pane when a new pivot is created
  clearTaskPaneManuallyClosed(PIVOT_PANE_ID);

  // Prevent the selection handler from closing the pane before regions are cached
  setJustCreatedPivot(true);

  // Show the Design ribbon tab immediately — don't wait for selection handler
  ensureDesignTabRegistered();

  try {
    const sourceData = await pivot.getSourceData(pivotId, [], 1);

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

    openTaskPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
  } catch (error) {
    // getSourceData failed — this may be a BI pivot (empty cache).
    // Try to fetch full pivot info (includes biModel for BI pivots).
    console.warn("[Pivot Extension] getSourceData failed, trying getAtCell:", error);

    try {
      const regions = await pivot.getRegionsForSheet();
      console.log("[Pivot Extension] getRegionsForSheet returned", regions.length, "regions");
      const region = regions.find((r) => r.pivotId === pivotId);
      console.log("[Pivot Extension] found region for pivotId", pivotId, ":", region);
      if (region) {
        const pivotInfo = await pivot.getAtCell(region.startRow, region.startCol);
        console.log("[Pivot Extension] getAtCell returned biModel:", pivotInfo?.biModel ? `${pivotInfo.biModel.tables.length} tables, ${pivotInfo.biModel.measures.length} measures` : "null");
        if (pivotInfo && pivotInfo.biModel) {
          const paneData: PivotEditorViewData = {
            pivotId,
            sourceFields: [],
            initialRows: [],
            initialColumns: [],
            initialValues: [],
            initialFilters: [],
            initialLayout: {},
            biModel: pivotInfo.biModel,
          };
          openTaskPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
          return;
        }
      }
    } catch (innerError) {
      console.warn("[Pivot Extension] getAtCell fallback also failed:", innerError);
    }

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
    openTaskPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
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
