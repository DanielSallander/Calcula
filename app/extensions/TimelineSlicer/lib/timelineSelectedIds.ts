//! FILENAME: app/extensions/TimelineSlicer/lib/timelineSelectedIds.ts
// PURPOSE: The ids of the timelines the family has selected -- the STATE
//          behind handlers/selectionHandler.ts, in a module with no imports.
// CONTEXT: A module with no imports, so anything may read the selection
//          without pulling in the selection handler (which imports the store,
//          the manifest and the ribbon components). The store once read it to
//          publish `resizable` = selected (BUG-0258 phase 1); Core now gates
//          every floating object's resize handles on the selection itself
//          (core/lib/floatingHandles.ts), so today the selection handler and
//          the live journeys read it. Only the selection handler writes it.

const selected = new Set<string>();

/** The live set. The selection handler is its only writer. */
export function timelineSelectedIdSet(): Set<string> {
  return selected;
}

/** Whether the timeline family holds this timeline selected. */
export function isTimelineIdSelected(timelineId: string): boolean {
  return selected.has(timelineId);
}
