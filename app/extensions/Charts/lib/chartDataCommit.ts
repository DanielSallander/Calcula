//! FILENAME: app/extensions/Charts/lib/chartDataCommit.ts
// PURPOSE: ONE funnel for the object pane's chart DATA edits (the range Data
//          tab and the PivotTable Data tab, WP-C S9c): validate the merged
//          spec, write the patch as ONE `updateChartSpec`, repaint, and land
//          the store's debounced save INSIDE one labelled undo step.
// CONTEXT: `updateChartSpec` only SCHEDULES a 300 ms save. Without the
//          `flushPendingChartSaves()` awaited inside `runInUndoTransaction`, the
//          `update_chart` write and its undo record would land after the
//          transaction closed -- a separate unlabelled step, or two edits merged
//          into one (review R1-4 / R2-7; the chartGeometry.ts precedent and the
//          element card's `applySpecPatch`).
//
//          The patch is validated against the chart schema BEFORE anything is
//          written, on the spec as it would be stored (explicit `undefined`
//          keys -- how a patch clears a stale field through the deep merge --
//          dropped, as the JSON the backend receives drops them). A refusal is
//          thrown as the reader's sentence and nothing is written.

import { AppEvents, emitAppEvent } from "@api/events";
import { runInUndoTransaction } from "@api/objectGeometry";
import type { ChartSpec, DataRangeRef } from "../types";
import { flushPendingChartSaves, mergeSpecPreview, syncChartRegions, updateChartSpec } from "./chartStore";
import { invalidateChartCache } from "../rendering/chartRenderer";
import { validateChartSpec } from "./chartSpecValidate";
import { ChartEvents } from "./chartEvents";

/** The undo step a chart data edit records (the design-query commit uses the same words). */
export const CHART_DATA_UNDO_LABEL = "Edit chart data";

/**
 * A DataRangeRef as a COMPLETE replacement for the stored one. The store deep
 * merges objects field by field, so a new reference without a `sheetId` would
 * otherwise keep the OLD reference's id -- and read the old sheet. The
 * explicit `undefined` clears it.
 */
export function replacementRangeRef(ref: DataRangeRef): DataRangeRef {
  return {
    sheetIndex: ref.sheetIndex,
    sheetId: typeof ref.sheetId === "string" && ref.sheetId !== "" ? ref.sheetId : undefined,
    startRow: ref.startRow,
    startCol: ref.startCol,
    endRow: ref.endRow,
    endCol: ref.endCol,
  };
}

/** Why the spec `patch` would make is not a valid chart, or null. */
export function chartDataPatchRefusal(chartId: string, patch: Partial<ChartSpec>): string | null {
  const merged = mergeSpecPreview(chartId, patch);
  if (merged === null) return "The chart no longer exists.";
  const asStored = JSON.parse(JSON.stringify(merged)) as unknown;
  const violations = validateChartSpec(asStored);
  if (violations.length === 0) return null;
  return (
    `This chart's data settings are not valid:\n${violations.slice(0, 5).join("\n")}` +
    (violations.length > 5 ? `\n(+${violations.length - 5} more)` : "")
  );
}

/**
 * Write `patch` to chart `chartId` as ONE undo step labelled `label`. Throws
 * (writing nothing) when the merged spec is refused by the schema.
 */
export async function commitChartDataPatch(
  chartId: string,
  patch: Partial<ChartSpec>,
  label: string = CHART_DATA_UNDO_LABEL,
): Promise<void> {
  const refusal = chartDataPatchRefusal(chartId, patch);
  if (refusal !== null) throw new Error(refusal);
  await runInUndoTransaction(label, async () => {
    updateChartSpec(chartId, patch);
    // Bump the render version -- without this the grid keeps compositing the
    // stale cached raster and the edit never shows.
    invalidateChartCache(chartId);
    syncChartRegions();
    emitAppEvent(ChartEvents.CHART_UPDATED, { chartId });
    emitAppEvent(AppEvents.GRID_REFRESH);
    await flushPendingChartSaves();
  });
}
