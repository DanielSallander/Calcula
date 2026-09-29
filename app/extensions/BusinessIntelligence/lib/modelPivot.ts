//! FILENAME: app/extensions/BusinessIntelligence/lib/modelPivot.ts
// PURPOSE: Shared "create a PivotTable from a model connection" flow.
// CONTEXT: Used by ModelDialog (right after creating a connection),
//          ConnectionsPane ("New Pivot" action), and CreateModelPivotDialog
//          (Model > PivotTable from Model...). Creates the pivot at the given
//          destination and opens the Pivot editor pane via the IoC service
//          registered by the Pivot extension (extensions must not import each
//          other directly).
//
//          On a CANVAS sheet the destination cell means nothing: the backend
//          requires a frame (the box the pivot is shown in) and allocates the
//          hidden-grid anchor itself, so the frame comes from the shared canvas
//          rule and no cell is sent that the reader could mistake for a place.
//
//          Every door that creates "at the selection" asks
//          modelPivotDestinationAtSelection (below) for its destination: on a
//          worksheet the pivot lands at Core's active cell, which is HIDDEN
//          while something else owns the selection (a floating grid's selected
//          cell), so the door refuses there -- once, with a toast.

import { columnToLetter, getPivotStoreService } from "@api";
import { pivot } from "@api/pivot";
import type { BiPivotModelInfo } from "@api/pivot";
import { getModelInfo } from "../../_shared/lib/bi-api";
import { canvasPivotFrameFor } from "../../_shared/lib/canvasPivotFrame";
import { getGridStateSnapshot } from "@api/grid";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import type { CanvasFrameConfig } from "@api/pivot";
import type { BiModelInfo } from "../types";

/** Convert BiModelInfo (from a BI connection) to BiPivotModelInfo (for the pivot field list). */
export function toBiPivotModelInfo(
  info: BiModelInfo,
  connectionId: string,
): BiPivotModelInfo {
  const numericTypes = new Set([
    "integer",
    "int",
    "bigint",
    "float",
    "double",
    "decimal",
    "numeric",
    "real",
    "smallint",
  ]);
  return {
    connectionId,
    tables: info.tables.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        isNumeric: numericTypes.has(c.dataType.toLowerCase()),
      })),
    })),
    measures: info.measures.map((m) => ({
      name: m.name,
      table: m.table,
      sourceColumn: "",
      aggregation: "sum" as const,
    })),
    hierarchies: info.hierarchies,
  };
}

export interface ModelPivotDestination {
  row: number;
  col: number;
  sheetIndex?: number;
}

/** The name a refused "PivotTable from Model" door gives its action. */
export const MODEL_PIVOT_ACTION = "PivotTable from Model";

/**
 * The sheet a pivot created with `sheetIndex` lands on, and the canvas frame it
 * gets there (undefined on a worksheet). No sheet named means the ACTIVE sheet
 * (the backend's default) -- which is exactly when a canvas is most likely:
 * the user is looking at it. One answer for createModelPivot and for the
 * doors' refusal, so the two cannot disagree about what a canvas is.
 */
function resolveDestinationSheet(sheetIndex: number | undefined): {
  sheetIndex: number | undefined;
  canvasFrame: CanvasFrameConfig | undefined;
} {
  const sheet = sheetIndex ?? getGridStateSnapshot()?.sheetContext.activeSheetIndex;
  return { sheetIndex: sheet, canvasFrame: sheet !== undefined ? canvasPivotFrameFor(sheet) : undefined };
}

/** What a "create at the selection" door reads of the grid (useGridState / getGridStateSnapshot). */
export interface SelectionAnchorGrid {
  selection: { startRow: number; startCol: number } | null;
  sheetContext?: { activeSheetIndex: number };
}

/**
 * THE DOORS' QUESTION: the destination a model pivot created "at the
 * selection" gets -- Core's active cell on the active sheet -- or null when
 * the door must not act: something other than Core's grid owns the selection,
 * so that cell is HIDDEN (under a floating grid's selected cell), and the
 * refusal has been announced ONCE (@api/selectionOwner; BUG-0185 class).
 *
 * On a CANVAS the cell is never used -- createModelPivot sends the canvas
 * frame instead -- so there is no hidden cell to write to and the door is not
 * refused.
 */
export function modelPivotDestinationAtSelection(
  grid: SelectionAnchorGrid | null | undefined,
): ModelPivotDestination | null {
  const sheetIndex = grid?.sheetContext?.activeSheetIndex;
  const onCanvas = resolveDestinationSheet(sheetIndex).canvasFrame !== undefined;
  if (!onCanvas && refuseIfSelectionOwned(MODEL_PIVOT_ACTION)) return null;
  const sel = grid?.selection ?? null;
  return { row: sel ? sel.startRow : 0, col: sel ? sel.startCol : 0, sheetIndex };
}

/**
 * What a "create at the selection" door SHOWS as its destination: the active
 * cell on a worksheet ("Cell C3"), or -- on a CANVAS, where no cell is used
 * and the pivot goes into a frame (createModelPivot sends the canvas frame) --
 * the frame. One answer with modelPivotDestinationAtSelection and
 * createModelPivot (resolveDestinationSheet), so the dialog cannot name a
 * cell the pivot does not go to (W23).
 */
export function modelPivotDestinationLabel(grid: SelectionAnchorGrid | null | undefined): string {
  const sheetIndex = grid?.sheetContext?.activeSheetIndex;
  if (resolveDestinationSheet(sheetIndex).canvasFrame !== undefined) {
    return "a new pivot box on this canvas";
  }
  const sel = grid?.selection ?? null;
  return `Cell ${columnToLetter(sel ? sel.startCol : 0)}${(sel ? sel.startRow : 0) + 1}`;
}

/**
 * Create a pivot table from a model connection at the destination cell and
 * open the Pivot editor pane on it. `modelInfo` may be passed when the caller
 * already fetched it; otherwise it is loaded from the connection.
 */
export async function createModelPivot(
  connectionId: string,
  destination: ModelPivotDestination,
  modelInfo?: BiModelInfo,
): Promise<string> {
  const info = modelInfo ?? (await getModelInfo(connectionId));
  if (!info) {
    throw new Error("No model loaded for this connection.");
  }

  const cellAddress = `${columnToLetter(destination.col)}${destination.row + 1}`;
  const { sheetIndex, canvasFrame } = resolveDestinationSheet(destination.sheetIndex);
  const response = await pivot.createFromBiModel({
    destinationCell: canvasFrame ? "A1" : cellAddress,
    destinationSheet: sheetIndex,
    connectionId,
    ...(canvasFrame ? { canvasFrame } : {}),
  });

  const pivotId = response.pivotId;
  window.dispatchEvent(new Event("grid:refresh"));

  const biModel = toBiPivotModelInfo(info, connectionId);
  getPivotStoreService()?.openBiPivotEditor(pivotId, biModel);
  return pivotId;
}
