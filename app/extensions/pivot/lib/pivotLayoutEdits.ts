//! FILENAME: app/extensions/Pivot/lib/pivotLayoutEdits.ts
// PURPOSE: A pivot's report LAYOUT (grand totals, report layout, values
//          position, repeat labels, empty rows/columns) read and changed
//          WITHOUT a mounted field-list editor -- the canvas box's Format tab
//          Layout card opened straight from Ctrl+1, or the ribbon's Design
//          sections while no editor of that pivot is mounted.
// CONTEXT: The layout travels in the pivot's FIELDS request, which REPLACES
//          every zone it is sent (pivotFieldsRequest.ts). A headless change
//          therefore sends the pivot's whole fields request back exactly as
//          the value-cell menu's headless edits do (valueFieldEdits.ts): read
//          the pivot as the editor would be seeded, change the layout only,
//          send it through the ONE send recipe. While an editor of the pivot
//          IS mounted, the change goes to that editor instead
//          (PIVOT_LAYOUT_CHANGED; pivotPanelStore.updateSharedLayout), which
//          owns the send -- one sender, never two (pivotEditorPresence.ts).

import { emitAppEvent } from "@api/events";
import { PivotEvents } from "../../_shared/lib/pivotEvents";
import type { LayoutConfig } from "../components/types";
import { getPivotAtCell } from "./pivot-api";
import { buildPivotFieldsRequest, mergeCalculatedIntoValues, sendPivotFieldsUpdate } from "./pivotFieldsRequest";
import { pivotBiContextOf } from "./valueFieldEdits";
import { buildPivotPaneData, getCachedRegions } from "../handlers/selectionHandler";

/** The layout of `pivotId` as its definition holds it now, or null (not on this sheet / unreadable). */
export async function readPivotLayout(pivotId: string): Promise<LayoutConfig | null> {
  const region = getCachedRegions().find((r) => r.pivotId === pivotId);
  if (!region) return null;
  const info = await getPivotAtCell(region.startRow, region.startCol);
  if (!info || String(info.pivotId) !== String(pivotId)) return null;
  return { ...buildPivotPaneData(info).initialLayout };
}

/**
 * Apply `patch` to the pivot's layout and send its fields request (undoable,
 * the fields update's own step). The PivotTable style is NOT layout any more
 * (pivotStylePersist.ts): a `styleId` in `patch` is ignored. Announces the new
 * layout (PIVOT_LAYOUT_STATE) so the Design sections show it, and repaints.
 * Rejects with a sentence when the pivot cannot be read, or with the
 * backend's error.
 */
export async function editPivotLayoutHeadless(pivotId: string, patch: Partial<LayoutConfig>): Promise<LayoutConfig> {
  const layoutPatch: Partial<LayoutConfig> = { ...patch };
  delete layoutPatch.styleId;
  const region = getCachedRegions().find((r) => r.pivotId === pivotId);
  if (!region) throw new Error("The PivotTable is not on this sheet.");
  const info = await getPivotAtCell(region.startRow, region.startCol);
  if (!info || String(info.pivotId) !== String(pivotId)) throw new Error("The PivotTable could not be read.");
  const pane = buildPivotPaneData(info);
  const layout: LayoutConfig = { ...pane.initialLayout, ...layoutPatch };
  const { request } = buildPivotFieldsRequest(
    pivotId,
    {
      rows: pane.initialRows,
      columns: pane.initialColumns,
      values: mergeCalculatedIntoValues(pane.initialValues, pane.initialCalculatedFields, pane.initialValueColumnOrder),
      filters: pane.initialFilters,
    },
    layout,
  );
  await sendPivotFieldsUpdate(
    request,
    new Map(),
    pivotBiContextOf(info, [...pane.initialRows, ...pane.initialColumns, ...pane.initialFilters]),
  );
  emitAppEvent(PivotEvents.PIVOT_LAYOUT_STATE, { pivotId, layout });
  window.dispatchEvent(new Event("pivot:refresh"));
  return layout;
}
