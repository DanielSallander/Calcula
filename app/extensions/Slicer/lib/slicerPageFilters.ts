//! FILENAME: app/extensions/Slicer/lib/slicerPageFilters.ts
// PURPOSE: Publish each page's active MODEL-slicer filters on the feature-
//   neutral @api/reportFilters seam, so the objects that query the model on the
//   same sheet or canvas -- design-query charts (Card, KPI, Gauge, any chart
//   on a DSL source) and `[Measure]` bindings -- follow the page's slicers the
//   way every visual on a Power BI page does (owner decision 5, 2026-10-08).
// CONTEXT: A model slicer already filters the BI PIVOTS of its page through
//   slicerFilterBridge's "biConnection" route -- a backend write per pivot,
//   inside the click's undo step. A design-query chart has nothing on the
//   backend to write: its data lives in the chart and is re-queried on read.
//   So the slicer does not push to charts at all; it SAYS what it keeps, here,
//   and the chart side resolves that into its query when it builds it and
//   re-runs it when the seam announces a change. Neither extension imports the
//   other (the Seam Rule).
//
//   WHAT IS PUBLISHED: one filter per model slicer that has a selection, for
//   every "biConnection" connection it carries (the same connections the
//   bridge resolves to pivots, so a chart and a pivot on one page can never be
//   filtered by different slicers). Its scope is the slicer's own PAGE, by
//   SHEET ID (P4: an index shifts when a sheet moves), and its `sourceRef` is
//   the slicer object, so Edit interactions can say "this slicer does not
//   filter that chart". A slicer with NO selection (`selectedItems === null`,
//   "every item") publishes nothing -- the absence of a filter, never a list of
//   every item. Table and pivot slicers publish nothing: a table slicer
//   filters cells, a pivot slicer filters ITS pivot (whose PivotChart
//   follows), and neither speaks for a model. The kept items are member KEYS.
//
//   THE SHEET ID comes from @api/reportPages' live page list, which
//   `startReportFilters` starts. A slicer whose sheet has no id in it yet
//   (the first read has not answered) is published on the next page-list
//   change -- never under a guessed id.
//
//   WHEN: on every store notification (SLICER_DATA_CHANGED: every re-read, an
//   undo, a pull, a reset on File > New), on every committed selection
//   (SLICER_SELECTION_CHANGED) and on every page-list change (a sheet moved,
//   the first read arrived). That is many republishes per gesture; the seam
//   diffs and announces only what moved, so a plain sheet switch (which
//   re-reads every slicer's items) re-queries no chart.

import { publishReportFilters, startReportFilters, type ReportFilterInput } from "@api/reportFilters";
import { getReportPagesSnapshot, onReportPagesChanged } from "@api/reportPages";
import { getAllSlicers } from "./slicerStore";
import { SlicerEvents } from "./slicerEvents";
import type { Slicer } from "./slicerTypes";

/** The publisher key this extension owns on the seam. */
export const SLICER_PAGE_FILTER_PUBLISHER = "slicer";

/**
 * The page filters `slicers` hold, pure. One per (model slicer with a
 * selection, model connection it carries); duplicates of one connection on one
 * slicer collapse. `sheetIdByIndex` names each slicer's page by id; a slicer
 * whose sheet has no id there is left out (published once the id is known).
 */
export function modelSlicerPageFilters(
  slicers: readonly Slicer[],
  sheetIdByIndex: ReadonlyMap<number, string>,
): ReportFilterInput[] {
  const out: ReportFilterInput[] = [];
  for (const slicer of slicers) {
    if (slicer.selectedItems === null || slicer.selectedItems === undefined) continue;
    const sheetId = sheetIdByIndex.get(slicer.sheetIndex);
    if (!sheetId) continue;
    const seen = new Set<string>();
    for (const conn of slicer.connectedSources ?? []) {
      if (conn.sourceType !== "biConnection") continue;
      const connectionId = String(conn.sourceId);
      if (seen.has(connectionId)) continue;
      seen.add(connectionId);
      out.push({
        sourceId: slicer.id,
        sourceName: slicer.name,
        sourceRef: { kind: "slicer", id: slicer.id },
        scope: { kind: "page", sheetId },
        connectionId,
        field: slicer.fieldName,
        includedKeys: [...slicer.selectedItems],
        filterLevel: slicer.filterLevel ?? 1,
      });
    }
  }
  return out;
}

/** Publish what the store holds now. */
export function publishSlicerPageFilters(): void {
  publishReportFilters(
    SLICER_PAGE_FILTER_PUBLISHER,
    modelSlicerPageFilters(getAllSlicers(), getReportPagesSnapshot().sheetIdByIndex),
  );
}

/**
 * Keep the seam in step with the store for as long as the extension is
 * active. Starts the seam (and with it the page list), publishes once now;
 * the cleanup WITHDRAWS every filter this extension published (a deactivated
 * Slicer extension filters nothing, and a chart must not keep following a
 * slicer that is no longer there).
 */
export function installSlicerPageFilterPublisher(): () => void {
  const stopSeam = startReportFilters();
  const publish = () => publishSlicerPageFilters();
  window.addEventListener(SlicerEvents.SLICER_DATA_CHANGED, publish);
  window.addEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, publish);
  const offPages = onReportPagesChanged(publish);
  publish();
  return () => {
    window.removeEventListener(SlicerEvents.SLICER_DATA_CHANGED, publish);
    window.removeEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, publish);
    offPages();
    publishReportFilters(SLICER_PAGE_FILTER_PUBLISHER, []);
    stopSeam();
  };
}
