//! FILENAME: app/extensions/TimelineSlicer/lib/timelineBindings.ts
// PURPOSE: A timeline's BOUND properties (@api/objectBindings, D-BIND): the two
//          properties a timeline offers to bind (its header text and whether
//          the header shows), the timeline as it is SHOWN -- its stored record
//          with every resolved binding applied -- and the registration that
//          tells the seam which regions are timelines.
// CONTEXT: The Slicer's twin (Slicer/lib/slicerBindings.ts). The store keeps
//          the LITERAL (what the Timeline Settings dialog edits); a binding's
//          value exists only in the copy the renderer and the zone table read.
//          Both read `shownTimeline`, because what is painted is what a press
//          hits (lib/timelineZones.ts): a header hidden by a binding must move
//          the year strip, the tiles and the level row for the zones too.
//
//          Rust owns evaluation; this module never evaluates and never writes.
//          It does not import the store (the store imports `shownTimeline` for
//          its region sync), so its install takes the store's answers as
//          arguments.

import {
  onBindingsChanged,
  overlayResolved,
  registerBindableProperties,
  type BindablePropertyDescriptor,
  type ObjectBindingRef,
  type ObjectBindingsChange,
} from "@api/objectBindings";
import type { GridRegion } from "@api/gridOverlays";
import { appendContainerBindableDescriptors } from "@api/objectFormat";

/** The `GridRegion.type` a timeline is published as (timelineSlicerStore.syncTimelineRegions). */
export const TIMELINE_REGION_TYPE = "timeline-slicer";

/** The script object type a timeline's per-instance script is attached as (@api/scriptableObjects). */
export const TIMELINE_SCRIPT_OBJECT_TYPE = "timeline";

/**
 * What a timeline offers to bind -- the catalog's two timelineSlicer rows
 * (`/headerText` Text, `/showHeader` Boolean). The registry drops any pointer
 * the catalog does not know.
 */
export const TIMELINE_BINDABLE_PROPERTIES: readonly BindablePropertyDescriptor[] = Object.freeze([
  { pointer: "/headerText", label: "Header text", group: "Header" },
  { pointer: "/showHeader", label: "Show header", group: "Header" },
]);

/** A timeline's binding ref: its id is the timeline's EntityId string, the id the store keys by. */
export function timelineBindingRef(timelineId: string): ObjectBindingRef {
  return { kind: "timelineSlicer", id: timelineId };
}

/**
 * The timeline as it is SHOWN: a copy of the stored record with every
 * resolved binding applied (a pending value or a non-text error keeps the
 * literal). Returns the very input when nothing on this timeline is bound.
 * Idempotent.
 */
export function shownTimeline<T extends { id: string }>(timeline: T): T {
  return overlayResolved(timelineBindingRef(timeline.id), "", timeline);
}

/** The ref of the timeline a region draws, or null for a region that carries no timeline id. */
export function timelineRefOfRegion(region: GridRegion): ObjectBindingRef | null {
  const id = region.data?.timelineId;
  return typeof id === "string" && id.length > 0 ? timelineBindingRef(id) : null;
}

/** Whether a bindings change concerns any timeline (a reload concerns every object). */
export function bindingsChangeTouchesTimelines(change: ObjectBindingsChange): boolean {
  return change.reload || change.objects.some((o) => o.kind === "timelineSlicer");
}

/** What the install needs from the timeline extension (injected: no store import here). */
export interface TimelineBindingsDeps {
  /** Whether a timeline with this id is in the store. */
  timelineExists(timelineId: string): boolean;
  /** Re-publish the timeline regions: a bound `showHeader` changes the grip. */
  resyncRegions(): void;
  /** Repaint the overlays -- `requestOverlayRedraw`, never GRID_REFRESH. */
  redraw(): void;
}

/**
 * Register the timelineSlicer kind with the seam and repaint when a
 * timeline's bound value changes. Returns the uninstall.
 */
export function installTimelineBindings(deps: TimelineBindingsDeps): () => void {
  const unregister = registerBindableProperties({
    kind: "timelineSlicer",
    regionTypes: [TIMELINE_REGION_TYPE],
    instanceTypes: [TIMELINE_SCRIPT_OBJECT_TYPE],
    refOf: (region) => timelineRefOfRegion(region),
    refForInstance: (instanceId) =>
      typeof instanceId === "string" && instanceId.length > 0 && deps.timelineExists(instanceId)
        ? timelineBindingRef(instanceId)
        : null,
    // The header's two Family rows, then the object's visual-container fields
    // (WP-C D-FORMAT, the format provider's `bindingPath`): ONE registration
    // per kind. Without a region (a script's instance) only the header rows.
    properties: (_ref, region) => appendContainerBindableDescriptors(TIMELINE_BINDABLE_PROPERTIES.map((d) => ({ ...d })), region),
  });
  const unsubscribe = onBindingsChanged((change) => {
    if (!bindingsChangeTouchesTimelines(change)) return;
    deps.resyncRegions();
    deps.redraw();
  });
  return () => {
    unsubscribe();
    unregister();
  };
}
