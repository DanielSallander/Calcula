//! FILENAME: app/extensions/Slicer/lib/slicerModelVisuals.ts
// PURPOSE: The Slicer family's provider for @api/modelVisuals (P4, G4, S8):
//          every slicer of the workbook, with whether it reads a model and the
//          part it can play in cross-filtering.
// CONTEXT: Edit interactions (CanvasSheet), a ribbon filter's "Selected
//          visuals" and the script host ask @api/modelVisuals which visuals
//          exist and what each can do; none of them may import Slicer (the
//          Seam Rule), so Slicer lists its own here (spec 2.2).
//
//          - A MODEL slicer: a source (its selection is a page filter whose
//            reach a pair can set to None) and a target (the other visuals'
//            selections dim its items with no data, slicerVisualConstraints.ts),
//            never a highlight -- a slicer cannot paint one, and as a source
//            the seam turns its highlight into a filter.
//          - A TABLE or PIVOT slicer filters cells (a table's AutoFilter, its
//            Report Connections pivots): connectionId null, no role, "Filters
//            cells, not the model".
//
//          Pure over the slicer store and the page list; `list()` is synchronous.

import { registerModelVisualProvider, type ModelVisualInfo } from "@api/modelVisuals";
import { getReportPagesSnapshot, sheetIdAt, type ReportPagesSnapshot } from "@api/reportPages";
import { getAllSlicers } from "./slicerStore";
import { isModelSlicer } from "./slicerVisualConstraints";
import type { Slicer } from "./slicerTypes";

/** Why a table or pivot slicer plays no part (its disabled None icon's title). */
export const NON_MODEL_SLICER_REASON = "Filters cells, not the model";

/** What the visual is, for menus and tooltips. */
export const SLICER_VISUAL_LABEL = "Slicer";

/** The cross-filter view of ONE slicer. Pure. */
export function slicerModelVisualInfo(slicer: Slicer, pages: ReportPagesSnapshot): ModelVisualInfo {
  const base = {
    ref: { kind: "slicer" as const, id: String(slicer.id) },
    name: slicer.name || String(slicer.id),
    sheetIndex: slicer.sheetIndex,
    sheetId: sheetIdAt(pages, slicer.sheetIndex),
    label: SLICER_VISUAL_LABEL,
  };
  const connectionId = String(slicer.cacheSourceId ?? "");
  if (isModelSlicer(slicer) && connectionId !== "") {
    return { ...base, connectionId, role: { source: true, target: true, canHighlight: false, reason: null } };
  }
  return {
    ...base,
    connectionId: null,
    role: { source: false, target: false, canHighlight: false, reason: NON_MODEL_SLICER_REASON },
  };
}

/** Every slicer the store holds, as @api/modelVisuals lists it. */
export function listSlicerModelVisuals(): ModelVisualInfo[] {
  const pages = getReportPagesSnapshot();
  return getAllSlicers().map((s) => slicerModelVisualInfo(s, pages));
}

/** Register the Slicer provider. Returns its unregister function. */
export function registerSlicerModelVisuals(): () => void {
  return registerModelVisualProvider({ kind: "slicer", list: listSlicerModelVisuals });
}
