//! FILENAME: app/extensions/BusinessIntelligence/lib/modelPivot.ts
// PURPOSE: Shared "create a PivotTable from a model connection" flow.
// CONTEXT: Used by ModelDialog (right after creating a connection),
//          ConnectionsPane ("New Pivot" action), and CreateModelPivotDialog
//          (Model > PivotTable from Model...). Creates the pivot at the given
//          destination and opens the Pivot editor pane via the IoC service
//          registered by the Pivot extension (extensions must not import each
//          other directly).

import { columnToLetter, getPivotStoreService } from "@api";
import { pivot } from "@api/pivot";
import type { BiPivotModelInfo } from "@api/pivot";
import { getModelInfo } from "../../_shared/lib/bi-api";
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
  const response = await pivot.createFromBiModel({
    destinationCell: cellAddress,
    destinationSheet: destination.sheetIndex,
    connectionId,
  });

  const pivotId = response.pivotId;
  window.dispatchEvent(new Event("grid:refresh"));

  const biModel = toBiPivotModelInfo(info, connectionId);
  getPivotStoreService()?.openBiPivotEditor(pivotId, biModel);
  return pivotId;
}
