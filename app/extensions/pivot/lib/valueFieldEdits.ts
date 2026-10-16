//! FILENAME: app/extensions/Pivot/lib/valueFieldEdits.ts
// PURPOSE: The value-cell context menu's HEADLESS value-field edits (Remove
//          "<field>", Summarize Values By, Show Values As) -- each one sends
//          the pivot's whole fields request back with only that one value
//          field changed, through the SAME recipe the field-list editor uses
//          (lib/pivotFieldsRequest.ts).
// CONTEXT: `update_pivot_fields` REPLACES every zone it is sent, the value
//          fields, the calculated fields and the value column order alike
//          (app/src-tauri/src/pivot/commands.rs), so a headless edit must send
//          back everything the pivot has: its rows, columns and filters (item
//          filters are never echoed -- an absent list KEEPS, biFieldsRequest.ts),
//          every other value field with its format and Show Values As, and its
//          calculated fields at their place in the column order. That is what
//          `buildPivotPaneData` + `mergeCalculatedIntoValues` seed the editor
//          with, so the menu reads the pivot exactly as the editor would.
//
//          Refusals are TOASTS and send nothing -- never a silent no-op:
//            - the cell's value-field index names no value field of the
//              definition, or names one by another name (a calculation group
//              expands a measure into several value fields, so the index the
//              view carries no longer lines up with the editor's list);
//            - Show Values As on a data-model pivot: the model transport
//              cannot carry it (`BiValueFieldRef` is a measure name and a
//              custom name), so the request would change nothing. The menu
//              item is disabled there already; this is the second line.

import { showToast } from "@api/notifications";
import { emitAppEvent } from "@api/events";
import { getDefaultAggregation, type AggregationType, type ShowValuesAs, type ZoneField } from "../components/types";
import { getPivotAtCell } from "./pivot-api";
import { getCachedPivotView } from "./pivotViewStore";
import {
  buildPivotFieldsRequest,
  mergeCalculatedIntoValues,
  replaceValueField,
  sendPivotFieldsUpdate,
  type PivotFieldsBiContext,
  type PivotZones,
} from "./pivotFieldsRequest";
import { PivotEvents } from "../../_shared/lib/pivotEvents";
import { SHOW_VALUES_AS_OPTIONS } from "./showValuesAsOptions";
import { buildPivotPaneData, getCachedRegions } from "../handlers/selectionHandler";
import type { PivotRegionInfo } from "@api/pivot";

/** One headless edit of a value field. */
export type ValueFieldEdit =
  | { kind: "remove" }
  | { kind: "summarize"; aggregation: AggregationType }
  | { kind: "showValuesAs"; showValuesAs: ShowValuesAs }
  /**
   * The field's number format OVERRIDE (an Excel code); null = none, so a
   * data-model pivot shows the model's format again (it is re-adopted by the
   * query the send runs) and a range pivot shows General. The Format pane's
   * Data format card (pivotObjectFormat.ts) -- undoable, unlike
   * `set_pivot_number_format`, because it rides the fields update.
   */
  | { kind: "numberFormat"; numberFormat: string | null };

/** The refusal shown when Show Values As is asked of a data-model pivot. */
export const MODEL_SHOW_VALUES_AS_REFUSAL = "Show Values As is not available on a data-model PivotTable yet.";

/** A refusal: the user is told why, and nothing is sent. */
function refuse(message: string): void {
  showToast(message, { variant: "info" });
}

/** A value field's name for a message (a model measure's outer `[...]` stripped). */
function fieldLabel(field: ZoneField): string {
  const name = field.customName || field.name;
  const m = /^\[(.*)\]$/.exec(name.trim());
  return m ? m[1] : name;
}

/** The model-request context of a data-model pivot, read from its metadata (null for a range pivot). */
export function pivotBiContextOf(info: PivotRegionInfo, zones: ZoneField[]): PivotFieldsBiContext | null {
  const model = info.biModel;
  if (!model) return null;
  const lookupColumns = new Set<string>(model.lookupColumns ?? []);
  // The editor's own fallback: a placed field flagged LOOKUP is one.
  for (const f of zones) if (f.isLookup) lookupColumns.add(f.name);
  return {
    calcGroupNames: new Set((model.calculationGroups ?? []).map((g) => g.name)),
    biTableNames: model.tables.map((t) => t.name),
    lookupColumns,
  };
}

/** The override a value field carries now (an ADOPTED model format is not one). */
function overrideOf(field: ZoneField): string | null {
  return field.numberFormatFromModel ? null : field.numberFormat ?? null;
}

/**
 * The edit, applied and sent. Answers the REFUSAL sentence (nothing sent), or
 * null when it was sent -- or when it changes nothing and so needs no send (a
 * number format equal to the field's own override). Rejects with the backend's
 * error when the send fails.
 */
async function applyPivotValueFieldEdit(
  pivotId: string,
  valueFieldIndex: number,
  edit: ValueFieldEdit,
): Promise<string | null> {
  const region = getCachedRegions().find((r) => r.pivotId === pivotId);
  if (!region) return "The PivotTable is not on this sheet.";
  const info = await getPivotAtCell(region.startRow, region.startCol);
  if (!info || String(info.pivotId) !== String(pivotId)) return "The PivotTable could not be read.";
  if (edit.kind === "showValuesAs" && info.biModel) return MODEL_SHOW_VALUES_AS_REFUSAL;

  const pane = buildPivotPaneData(info);
  let values = mergeCalculatedIntoValues(pane.initialValues, pane.initialCalculatedFields, pane.initialValueColumnOrder);

  // The i-th NON-calculated entry is the i-th value field of the definition.
  let position = -1;
  let seen = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i].isCalculated) continue;
    if (seen === valueFieldIndex) {
      position = i;
      break;
    }
    seen++;
  }
  if (position < 0) return "That value field is no longer in the PivotTable.";
  const target = values[position];
  // Cross-check with the names the view's indexes point into: a mismatch is a
  // calculation group's expansion (or a view older than the definition).
  const viewNames = getCachedPivotView(pivotId)?.valueFieldNames;
  if (viewNames && viewNames[valueFieldIndex] !== target.name) {
    return "This value field cannot be changed from here; use the PivotTable Fields pane.";
  }

  if (edit.kind === "remove") {
    values.splice(position, 1);
  } else if (edit.kind === "summarize") {
    if ((target.aggregation ?? getDefaultAggregation(target.isNumeric)) === edit.aggregation) {
      return `"${fieldLabel(target)}" is already summarized that way.`;
    }
    // A default name follows the aggregation ("Sum of Units" -> "Max of Units");
    // replaceValueField carries that rename into the calculated fields.
    values = replaceValueField(values, position, { ...target, aggregation: edit.aggregation });
  } else if (edit.kind === "numberFormat") {
    const next = edit.numberFormat === null || edit.numberFormat.trim() === "" ? null : edit.numberFormat;
    if (overrideOf(target) === next) return null;
    // An override is the USER's from here on (never an adopted model format):
    // the request carries it, and clearing it lets the model's come back.
    values = replaceValueField(values, position, {
      ...target,
      numberFormat: next ?? undefined,
      numberFormatFromModel: false,
    });
  } else {
    const current = (target.showValuesAs as ShowValuesAs | undefined) ?? "normal";
    if (current === edit.showValuesAs) {
      const label = SHOW_VALUES_AS_OPTIONS.find((o) => o.value === edit.showValuesAs)?.label ?? edit.showValuesAs;
      return `"${fieldLabel(target)}" already shows ${label}.`;
    }
    // The headless choices need no base: a base kept from the previous
    // calculation would send the old calculation's rule (showAsRuleFor).
    values = replaceValueField(values, position, { ...target, showValuesAs: edit.showValuesAs, baseField: undefined, baseItem: undefined });
  }

  const { request } = buildPivotFieldsRequest(pivotId, {
    rows: pane.initialRows,
    columns: pane.initialColumns,
    values,
    filters: pane.initialFilters,
  });
  await sendPivotFieldsUpdate(
    request,
    new Map(),
    pivotBiContextOf(info, [...pane.initialRows, ...pane.initialColumns, ...pane.initialFilters]),
  );
  // An open field-list editor of this pivot re-seeds its zones: its next
  // request REPLACES the fields, and would otherwise send this edit back
  // out (BUG-0466).
  emitAppEvent(PivotEvents.PIVOT_FIELDS_EDITED_ELSEWHERE, { pivotId });
  window.dispatchEvent(new Event("pivot:refresh"));
  return null;
}

/**
 * Apply `edit` to the `valueFieldIndex`-th VALUE field of `pivotId` (the index
 * a value cell's `valueFieldIndex` carries; calculated fields not counted) and
 * send the pivot's fields request. Refuses with a toast (sending nothing) when
 * the pivot or the field cannot be named with certainty; rejects with the
 * backend's error when the send fails (the caller's menu action toasts it).
 */
export async function editPivotValueField(pivotId: string, valueFieldIndex: number, edit: ValueFieldEdit): Promise<void> {
  const refusal = await applyPivotValueFieldEdit(pivotId, valueFieldIndex, edit);
  if (refusal !== null) refuse(refusal);
}

/**
 * Set (or, with null, clear) the number format OVERRIDE of the
 * `valueFieldIndex`-th value field -- the Format pane's Data format door.
 * Unlike `editPivotValueField` a refusal REJECTS with its sentence (the card
 * toasts it); an unchanged format sends nothing.
 */
export async function setPivotValueFieldFormat(
  pivotId: string,
  valueFieldIndex: number,
  numberFormat: string | null,
): Promise<void> {
  const refusal = await applyPivotValueFieldEdit(pivotId, valueFieldIndex, { kind: "numberFormat", numberFormat });
  if (refusal !== null) throw new Error(refusal);
}

/**
 * The pivot's four zones as its definition holds them NOW, built exactly as
 * the field-list editor is seeded (`buildPivotPaneData` +
 * `mergeCalculatedIntoValues`, calculated fields at their place in the column
 * order) -- what an open editor re-seeds from after a field edit made
 * elsewhere (`PivotEvents.PIVOT_FIELDS_EDITED_ELSEWHERE`, BUG-0466). Null when
 * the pivot is not on the active sheet or cannot be read.
 */
export async function readPivotEditorZones(pivotId: string): Promise<PivotZones | null> {
  const region = getCachedRegions().find((r) => r.pivotId === pivotId);
  if (!region) return null;
  const info = await getPivotAtCell(region.startRow, region.startCol);
  if (!info || String(info.pivotId) !== String(pivotId)) return null;
  const pane = buildPivotPaneData(info);
  return {
    rows: pane.initialRows,
    columns: pane.initialColumns,
    values: mergeCalculatedIntoValues(pane.initialValues, pane.initialCalculatedFields, pane.initialValueColumnOrder),
    filters: pane.initialFilters,
  };
}
