//! FILENAME: app/extensions/Pivot/lib/pivotDataFormats.ts
// PURPOSE: A pivot's value fields as the object pane's Data format rows
//          (WP-C D-FORMAT, 2.8.2), and the write behind a row.
// CONTEXT: A row's `format` is the USER's override only: a data-model pivot's
//          format ADOPTED from the model (`numberFormatFromModel`) is not one,
//          so it shows as the row's SOURCE format (the placeholder) with no
//          override -- and "Use source format" (null) clears the override, so
//          the model's format comes back on the query the write runs.
//
//          The write is the value field's number format through the pivot's
//          FIELDS update (valueFieldEdits.ts `setPivotValueFieldFormat`), not
//          `set_pivot_number_format`: the fields update records an undo step
//          (that command records none), carries the override in the model
//          request (`BiValueFieldRef.numberFormat`), re-adopts the model format
//          on a clear in the same query, and tells an open field-list editor
//          to re-seed (BUG-0466) -- one door, the one the value-cell menu uses.
//          It runs inside ONE "Number Format" undo transaction.

import type { DataFormatField } from "@api/objectFormat";
import { runInUndoTransaction } from "@api/objectGeometry";
import { getPivotAtCell } from "./pivot-api";
import { setPivotValueFieldFormat } from "./valueFieldEdits";
import { getCachedRegions } from "../handlers/selectionHandler";

/** The undo step a Data format change records (the chart's word too). */
export const PIVOT_DATA_FORMAT_UNDO_LABEL = "Number Format";

function bareMeasureName(name: string): string {
  const m = /^\[(.*)\]$/.exec(name.trim());
  return m ? m[1] : name;
}

/**
 * The value fields of `pivotId` (on the ACTIVE sheet) as Data format rows:
 * key = the value field's index in the definition, label = its custom name
 * or its field / measure name, format = the user's override, sourceFormat =
 * the model measure's format string (a data-model pivot), else the adopted
 * format. Rejects with a sentence when the pivot cannot be read.
 */
export async function pivotDataFormats(pivotId: string): Promise<DataFormatField[]> {
  const region = getCachedRegions().find((r) => r.pivotId === pivotId);
  if (!region) throw new Error("The PivotTable is not on this sheet.");
  const info = await getPivotAtCell(region.startRow, region.startCol);
  if (!info || String(info.pivotId) !== String(pivotId)) throw new Error("The PivotTable could not be read.");
  const measures = info.biModel?.measures ?? [];
  return info.fieldConfiguration.valueFields.map((f, i) => {
    const bare = bareMeasureName(f.name);
    const measure = info.biModel ? measures.find((m) => m.name === bare) : undefined;
    const adopted = f.numberFormatFromModel === true;
    return {
      key: String(i),
      label: f.customName || bare,
      format: adopted ? null : f.numberFormat ?? null,
      sourceFormat: measure?.formatString ?? (adopted ? f.numberFormat ?? null : null),
    };
  });
}

/** Set (null: clear) value field `valueFieldIndex`'s number format override, as ONE undo step. */
export async function setPivotDataFormat(pivotId: string, valueFieldIndex: number, format: string | null): Promise<void> {
  await runInUndoTransaction(PIVOT_DATA_FORMAT_UNDO_LABEL, () => setPivotValueFieldFormat(pivotId, valueFieldIndex, format));
}
