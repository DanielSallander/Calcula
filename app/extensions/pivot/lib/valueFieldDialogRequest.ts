//! FILENAME: app/extensions/Pivot/lib/valueFieldDialogRequest.ts
// PURPOSE: "Open the pane's value-field modal" -- the value-cell context
//          menu's Number Format... / Value Field Settings... (and the Show
//          Values As choices that need a base) open the SAME modal the field
//          list opens from a Values chip, on the field the cell shows.
// CONTEXT: The value-field dialog contract (owner WP-A, consumer WP-C):
//          `requestValueFieldDialog` is the ONE public door. It
//            1. stores the request as PENDING for its pivot,
//            2. calls the single host hook `openPivotPaneForPivot`
//               (handlers/selectionHandler.ts), which opens whatever pane hosts
//               the pivot's editor, and
//            3. emits `PIVOT_OPEN_VALUE_FIELD_DIALOG`.
//          The listener lives INSIDE the PivotEditor component: on mount and
//          on the event it TAKES the pending request for its own pivot and
//          opens the modal. A pending request therefore survives until the
//          editor mounts (the pane may open asynchronously), and the event
//          reaches an editor that is already mounted. WP-C re-points only the
//          canvas branch of `openPivotPaneForPivot`; the listener moves with
//          the PivotEditor component wherever it is mounted.

//
//          The host hook is imported LAZILY: PivotEditor imports this module
//          for the take side, and a static import of selectionHandler here
//          would tie the editor component to the selection handler (and,
//          through the extension manifest, back to the editor itself).

import { emitAppEvent } from "@api/events";
import { PivotEvents } from "../../_shared/lib/pivotEvents";

/** Which modal: Value Field Settings, or the value field's Number Format. */
export type ValueFieldDialogKind = "settings" | "numberFormat";

/** A request for a value-field modal. `valueFieldIndex` indexes the pivot's VALUE fields (calculated fields not counted). */
export interface ValueFieldDialogRequest {
  pivotId: string;
  valueFieldIndex: number;
  dialog: ValueFieldDialogKind;
}

/** The pending request per pivot (the newest wins). */
const pending = new Map<string, ValueFieldDialogRequest>();

/**
 * Ask for a value-field modal: store it as pending, open the pane that hosts
 * the pivot's editor (the ONE host hook), then announce it. Rejects (and drops
 * the request) when the pane cannot be opened, so a stale request never pops
 * a modal later.
 */
export async function requestValueFieldDialog(req: ValueFieldDialogRequest): Promise<void> {
  const entry: ValueFieldDialogRequest = { ...req };
  pending.set(req.pivotId, entry);
  try {
    const { openPivotPaneForPivot } = await import("../handlers/selectionHandler");
    await openPivotPaneForPivot(req.pivotId);
  } catch (err) {
    if (pending.get(req.pivotId) === entry) pending.delete(req.pivotId);
    throw err;
  }
  emitAppEvent(PivotEvents.PIVOT_OPEN_VALUE_FIELD_DIALOG, entry);
}

/** Take (and forget) the pending request for `pivotId`, or null. */
export function takePendingValueFieldDialog(pivotId: string): ValueFieldDialogRequest | null {
  const req = pending.get(pivotId) ?? null;
  if (req) pending.delete(pivotId);
  return req;
}

/**
 * The position in an editor's Values zone of the pivot's `valueFieldIndex`-th
 * VALUE field: the Values zone interleaves calculated fields, which the index
 * does not count. -1 when there is no such field.
 */
export function valuesZoneIndexOf(
  values: ReadonlyArray<{ isCalculated?: boolean }>,
  valueFieldIndex: number,
): number {
  if (!Number.isInteger(valueFieldIndex) || valueFieldIndex < 0) return -1;
  let seen = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i].isCalculated) continue;
    if (seen === valueFieldIndex) return i;
    seen++;
  }
  return -1;
}

/** Test hook: forget every pending request. */
export function __resetValueFieldDialogRequestsForTests(): void {
  pending.clear();
}
