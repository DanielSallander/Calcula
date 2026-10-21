//! FILENAME: app/extensions/ControlsPane/lib/filterReportPublisher.ts
// PURPOSE: Publish every ribbon filter's kept members on the feature-neutral
//          @api/reportFilters seam, ONCE per filter, with the SCOPE its
//          Report connections give it -- so the visuals that query the model
//          themselves (design-query charts, cards, KPIs, gauges, `[Measure]`
//          bindings) follow a ribbon filter the way its BI pivots already do.
// CONTEXT: P4 (G2-B). The pivots keep their proven backend route
//          (filterPaneFilterBridge: one backend command per selection gesture,
//          inside its undo step). A chart has nothing on the backend to write:
//          it reads the seam when it builds its query and re-runs it when the
//          seam announces a change. This file only SAYS what each filter keeps
//          and where; neither side imports the other (the Seam Rule).
//
//          SCOPE per connection mode:
//            workbook ("All pages")       -> { kind: "all" }
//            bySheet  ("Selected pages")  -> { kind: "pages", sheetIds }, the
//                persisted sheet INDICES mapped to sheet ids through
//                @api/reportPages' live `sheetIdByIndex` (DC-4). An index with
//                no id there yet is left out and published on the next
//                page-list change -- never under a guessed id.
//            manual   ("Selected visuals") -> { kind: "visuals", targets }:
//                the connected pivots as pivot refs, then `connectedVisuals`.
//          A filter with no selection (`selectedItems === null`, "every item")
//          publishes nothing: the absence of a filter, never a list of every
//          item. A scope that names nothing (no pages, no visuals) is dropped
//          by the seam itself. An ADVANCED filter publishes its materialised
//          selection like any other: the condition is applied by turning it
//          into the matching member KEYS (FilterDropdown's AdvancedFilterPanel),
//          which is exactly what its pivots receive, so a chart beside them
//          agrees.
//
//          WHEN. The store sets a gesture's selection OPTIMISTICALLY before the
//          backend step runs, and rolls it back on a refusal without saying so.
//          So a selection is taken from the store only when the store has SAID
//          it: FILTER_SELECTION_CHANGED (dispatched after the gesture's backend
//          step resolved) carries it, and the store-wide events (refreshed,
//          created, updated, deleted) re-read it -- except while a selection
//          gesture is still landing, when every filter keeps the selection
//          this publisher last took. A page-list change republishes what is
//          held. The seam diffs, so a republish that moved nothing announces
//          nothing.

import { publishReportFilters, startReportFilters, type ReportFilterInput, type ReportFilterScope, type VisualRef } from "@api/reportFilters";
import { getReportPagesSnapshot, onReportPagesChanged } from "@api/reportPages";
import { FilterPaneEvents } from "./filterPaneEvents";
import { getAllFilters, isRibbonFilterChangeLanding } from "./filterPaneStore";
import type { RibbonFilter } from "./filterPaneTypes";

/** The publisher key this extension owns on the seam. */
export const RIBBON_FILTER_PUBLISHER = "ribbonFilter";

/** The part of a ribbon filter that decides what it publishes. */
export type PublishedRibbonFilter = Pick<
  RibbonFilter,
  | "id"
  | "name"
  | "connectionId"
  | "fieldName"
  | "connectionMode"
  | "connectedPivots"
  | "connectedSheets"
  | "connectedVisuals"
  | "selectedItems"
  | "filterLevel"
>;

/** The scope a filter's Report connections give it, pure. */
export function ribbonFilterScope(
  filter: Pick<RibbonFilter, "connectionMode" | "connectedPivots" | "connectedSheets" | "connectedVisuals">,
  sheetIdByIndex: ReadonlyMap<number, string>,
): ReportFilterScope {
  switch (filter.connectionMode) {
    case "workbook":
      return { kind: "all" };
    case "bySheet": {
      const sheetIds: string[] = [];
      for (const index of filter.connectedSheets ?? []) {
        const id = sheetIdByIndex.get(index);
        if (id && !sheetIds.includes(id)) sheetIds.push(id);
      }
      return { kind: "pages", sheetIds };
    }
    case "manual":
    default: {
      const targets: VisualRef[] = [
        ...(filter.connectedPivots ?? []).map((id): VisualRef => ({ kind: "pivot", id })),
        ...(filter.connectedVisuals ?? []),
      ];
      return { kind: "visuals", targets };
    }
  }
}

/**
 * The report filters `filters` hold, pure: one per filter with a selection.
 * `selectionOf` names the selection to publish for a filter (the committed
 * one); by default the filter's own.
 */
export function ribbonFilterReportFilters(
  filters: readonly PublishedRibbonFilter[],
  sheetIdByIndex: ReadonlyMap<number, string>,
  selectionOf: (f: PublishedRibbonFilter) => readonly string[] | null = (f) => f.selectedItems,
): ReportFilterInput[] {
  const out: ReportFilterInput[] = [];
  for (const filter of filters) {
    const selection = selectionOf(filter);
    if (selection === null || selection === undefined) continue;
    out.push({
      sourceId: filter.id,
      sourceName: filter.name,
      sourceRef: null,
      scope: ribbonFilterScope(filter, sheetIdByIndex),
      connectionId: String(filter.connectionId),
      field: filter.fieldName,
      includedKeys: [...selection],
      filterLevel: filter.filterLevel ?? 1,
    });
  }
  return out;
}

/** The selection this publisher last took per filter id (see WHEN above). */
const committed = new Map<string, string[] | null>();

function copySelection(s: readonly string[] | null | undefined): string[] | null {
  return s === null || s === undefined ? null : [...s];
}

/** Re-read every filter's selection from the store, unless a gesture is landing. */
function takeSelectionsFromStore(): void {
  const filters = getAllFilters();
  const landing = isRibbonFilterChangeLanding();
  const live = new Set<string>();
  for (const f of filters) {
    live.add(f.id);
    if (landing && committed.has(f.id)) continue;
    committed.set(f.id, copySelection(f.selectedItems));
  }
  for (const id of [...committed.keys()]) if (!live.has(id)) committed.delete(id);
}

/** Publish what is held now. */
export function publishRibbonFilterReportFilters(): void {
  publishReportFilters(
    RIBBON_FILTER_PUBLISHER,
    ribbonFilterReportFilters(getAllFilters(), getReportPagesSnapshot().sheetIdByIndex, (f) =>
      committed.has(f.id) ? committed.get(f.id) ?? null : f.selectedItems,
    ),
  );
}

/**
 * Keep the seam in step with the ribbon filters for as long as the extension
 * is active. Starts the seam (and with it the page list) and publishes once;
 * the cleanup WITHDRAWS everything this publisher holds -- a deactivated pane
 * filters nothing.
 */
export function installRibbonFilterReportPublisher(): () => void {
  const stopSeam = startReportFilters();
  const onStoreChanged = () => {
    takeSelectionsFromStore();
    publishRibbonFilterReportFilters();
  };
  const onSelectionChanged = (e: Event) => {
    const detail = (e as CustomEvent<{ filterId?: string; selectedItems?: string[] | null }>).detail;
    if (detail && typeof detail.filterId === "string" && "selectedItems" in detail) {
      committed.set(detail.filterId, copySelection(detail.selectedItems));
    } else {
      // A bare "the selection moved" (the Save of Report connections sends
      // only the id): the store is settled, read it.
      takeSelectionsFromStore();
    }
    publishRibbonFilterReportFilters();
  };
  const storeEvents = [
    FilterPaneEvents.FILTERS_REFRESHED,
    FilterPaneEvents.FILTER_CREATED,
    FilterPaneEvents.FILTER_UPDATED,
    FilterPaneEvents.FILTER_DELETED,
  ];
  for (const evt of storeEvents) window.addEventListener(evt, onStoreChanged);
  window.addEventListener(FilterPaneEvents.FILTER_SELECTION_CHANGED, onSelectionChanged);
  const offPages = onReportPagesChanged(() => publishRibbonFilterReportFilters());
  onStoreChanged();
  return () => {
    for (const evt of storeEvents) window.removeEventListener(evt, onStoreChanged);
    window.removeEventListener(FilterPaneEvents.FILTER_SELECTION_CHANGED, onSelectionChanged);
    offPages();
    committed.clear();
    publishReportFilters(RIBBON_FILTER_PUBLISHER, []);
    stopSeam();
  };
}
