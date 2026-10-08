//! FILENAME: app/extensions/Slicer/lib/slicerPageFilters.ts
// PURPOSE: Publish each page's active MODEL-slicer filters on the feature-
//   neutral @api/pageFilters seam, so the objects that query the model on the
//   same sheet or canvas -- design-query charts (Card, KPI, Gauge, any chart
//   on a DSL source) -- follow the page's slicers the way every visual on a
//   Power BI page does (owner decision 5, 2026-10-08).
// CONTEXT: A model slicer already filters the BI PIVOTS of its page through
//   slicerFilterBridge's "biConnection" route -- a backend write per pivot,
//   inside the click's undo step. A design-query chart has nothing on the
//   backend to write: its data lives in the chart and is re-queried on read.
//   So the slicer does not push to charts at all; it SAYS what it keeps, here,
//   and the chart side merges that into its query when it builds it and
//   re-runs it when the seam announces a change. Neither extension imports the
//   other (the Seam Rule).
//
//   WHAT IS PUBLISHED: one filter per model slicer that has a selection, for
//   every "biConnection" connection it carries (the same connections the
//   bridge resolves to pivots, so a chart and a pivot on one page can never be
//   filtered by different slicers). The page is the slicer's own sheet index.
//   A slicer with NO selection (`selectedItems === null`, "every item")
//   publishes nothing -- the absence of a filter, never a list of every item.
//   Table and pivot slicers publish nothing: a table slicer filters cells, a
//   pivot slicer filters ITS pivot (whose PivotChart follows), and neither
//   speaks for a model.
//
//   WHEN: on every store notification (SLICER_DATA_CHANGED: every re-read, an
//   undo, a pull, a reset on File > New) and on every committed selection
//   (SLICER_SELECTION_CHANGED). That is many republishes per gesture; the seam
//   diffs per page and announces only what moved, so a plain sheet switch
//   (which re-reads every slicer's items) re-queries no chart.

import { publishPageFilters, type PageFilterInput } from "@api/pageFilters";
import { getAllSlicers } from "./slicerStore";
import { SlicerEvents } from "./slicerEvents";
import type { Slicer } from "./slicerTypes";

/** The publisher key this extension owns on the seam. */
export const SLICER_PAGE_FILTER_PUBLISHER = "slicer";

/**
 * The page filters `slicers` hold, pure. One per (model slicer with a
 * selection, model connection it carries); duplicates of one connection on one
 * slicer collapse.
 */
export function modelSlicerPageFilters(slicers: readonly Slicer[]): PageFilterInput[] {
  const out: PageFilterInput[] = [];
  for (const slicer of slicers) {
    if (slicer.selectedItems === null || slicer.selectedItems === undefined) continue;
    const seen = new Set<string>();
    for (const conn of slicer.connectedSources ?? []) {
      if (conn.sourceType !== "biConnection") continue;
      const connectionId = String(conn.sourceId);
      if (seen.has(connectionId)) continue;
      seen.add(connectionId);
      out.push({
        sourceId: slicer.id,
        sourceName: slicer.name,
        sheetIndex: slicer.sheetIndex,
        connectionId,
        field: slicer.fieldName,
        includedItems: [...slicer.selectedItems],
        filterLevel: slicer.filterLevel ?? 1,
      });
    }
  }
  return out;
}

/** Publish what the store holds now. */
export function publishSlicerPageFilters(): void {
  publishPageFilters(SLICER_PAGE_FILTER_PUBLISHER, modelSlicerPageFilters(getAllSlicers()));
}

/**
 * Keep the seam in step with the store for as long as the extension is
 * active. Publishes once now; the cleanup WITHDRAWS every filter this
 * extension published (a deactivated Slicer extension filters nothing, and a
 * chart must not keep following a slicer that is no longer there).
 */
export function installSlicerPageFilterPublisher(): () => void {
  const publish = () => publishSlicerPageFilters();
  window.addEventListener(SlicerEvents.SLICER_DATA_CHANGED, publish);
  window.addEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, publish);
  publish();
  return () => {
    window.removeEventListener(SlicerEvents.SLICER_DATA_CHANGED, publish);
    window.removeEventListener(SlicerEvents.SLICER_SELECTION_CHANGED, publish);
    publishPageFilters(SLICER_PAGE_FILTER_PUBLISHER, []);
  };
}
