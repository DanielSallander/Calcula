//! FILENAME: app/src/api/pivotPresets.ts
// PURPOSE: A PRESET an opener can hand the Create PivotTable dialog
//          (`pivot:createDialog`, dialog data `preset`): the form the new pivot
//          is laid out in before anyone sees it. Today one preset exists, the
//          Canvas tab's TABLE visual (Canvas contract §2, §4.6): Power BI's
//          Table is a flat list -- every field a column of rows, no column
//          axis -- which in pivot terms is TABULAR form with repeated row
//          labels and no column field.
// CONTEXT: The opener (CanvasSheet) may not import the Pivot extension, and the
//          dialog data is `unknown` to the dialog, so the shape and its reader
//          live here, in @api, where both sides meet. The Pivot extension
//          applies it (CreatePivotDialog: create first, exactly as before, then
//          lay the pivot out through the ordinary `updateLayout`, before the
//          field list is opened on it).
//
// WHAT `noColumnFields` MEANS, precisely. A new pivot has no fields at all, and
// the dialog places none; the field list puts a text field in Rows and a number
// in Values by default. So "no column field" holds at creation BY CONSTRUCTION
// and the dialog has nothing to do for it. It is carried so the intent is
// stated where it is asked for -- nothing stops a reader dragging a field to
// Columns later, and enforcing that would need a per-pivot "table visual" flag
// the backend does not have (reported to the integrator, not invented here).

import type { LayoutConfig, ReportLayout } from "./pivotTypes";

/** What an opener may ask the new pivot to look like. */
export interface PivotCreatePreset {
  /** The report layout the pivot starts in. */
  layout?: ReportLayout;
  /** The pivot is a flat table: nothing goes to Columns (see the header). */
  noColumnFields?: boolean;
}

/** The Canvas tab's Table visual: tabular, no column field. */
export const TABLE_VISUAL_PIVOT_PRESET: Readonly<PivotCreatePreset> = Object.freeze({
  layout: "tabular",
  noColumnFields: true,
});

const LAYOUTS: readonly ReportLayout[] = ["compact", "outline", "tabular"];

/**
 * Read a preset from dialog data. Accepted only when every field present is
 * one this build understands and at least one is present -- a malformed
 * preset is ignored whole (the pivot is created as it always was), never
 * half-applied.
 */
export function readPivotCreatePreset(raw: unknown): PivotCreatePreset | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const preset: PivotCreatePreset = {};
  if (r.layout !== undefined) {
    if (typeof r.layout !== "string" || !(LAYOUTS as readonly string[]).includes(r.layout)) return null;
    preset.layout = r.layout as ReportLayout;
  }
  if (r.noColumnFields !== undefined) {
    if (typeof r.noColumnFields !== "boolean") return null;
    preset.noColumnFields = r.noColumnFields;
  }
  return Object.keys(preset).length > 0 ? preset : null;
}

/**
 * The layout request a preset asks for, or null when it asks for none. Tabular
 * repeats its row labels: a flat table shows the value of every column on
 * every row, as Power BI's Table does.
 */
export function pivotPresetLayout(preset: PivotCreatePreset | null): LayoutConfig | null {
  if (!preset?.layout) return null;
  return preset.layout === "tabular"
    ? { reportLayout: "tabular", repeatRowLabels: true }
    : { reportLayout: preset.layout };
}
