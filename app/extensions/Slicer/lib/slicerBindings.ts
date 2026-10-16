//! FILENAME: app/extensions/Slicer/lib/slicerBindings.ts
// PURPOSE: A slicer's BOUND properties (@api/objectBindings, D-BIND): the two
//          properties a slicer offers to bind (its header text and whether the
//          header shows), the slicer as it is SHOWN -- its stored record with
//          every resolved binding applied -- and the registration that tells
//          the seam which regions are slicers.
// CONTEXT: One spelling per fact (D invariant 1). The store keeps the LITERAL
//          (what the Slicer Settings dialog and the ribbon edit); a binding's
//          value exists only in the copy the renderer and the hit test read.
//          Both read `shownSlicer`, because PAINT == HIT (BUG-0258): a header
//          hidden by a binding must also stop catching presses, or a click on
//          the first item would land on a header that is not painted.
//
//          Rust owns evaluation; this module never evaluates and never writes.
//          It does not import the store (the store imports `shownSlicer` for
//          its region sync), so its install takes the store's two answers as
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

/** The `GridRegion.type` a slicer is published as (slicerStore.syncSlicerRegions). */
export const SLICER_REGION_TYPE = "slicer";

/** The script object type a slicer's per-instance script is attached as (@api/scriptableObjects). */
export const SLICER_SCRIPT_OBJECT_TYPE = "slicer";

/**
 * What a slicer offers to bind -- the catalog's two slicer rows
 * (`/headerText` Text, `/showHeader` Boolean). The registry drops any pointer
 * the catalog does not know, so a row added here without a catalog row is
 * never offered.
 */
export const SLICER_BINDABLE_PROPERTIES: readonly BindablePropertyDescriptor[] = Object.freeze([
  { pointer: "/headerText", label: "Header text", group: "Header" },
  { pointer: "/showHeader", label: "Show header", group: "Header" },
]);

/** A slicer's binding ref: its id is the slicer's EntityId string, the same id the store keys by. */
export function slicerBindingRef(slicerId: string): ObjectBindingRef {
  return { kind: "slicer", id: slicerId };
}

/**
 * The slicer as it is SHOWN: a copy of the stored record with every resolved
 * binding applied (a pending value or a non-text error keeps the literal;
 * `@api/objectBindings` overlay rules). Returns the very input when nothing
 * on this slicer is bound, so an unbound slicer costs one map lookup.
 * Idempotent: showing a shown slicer changes nothing.
 */
export function shownSlicer<T extends { id: string }>(slicer: T): T {
  return overlayResolved(slicerBindingRef(slicer.id), "", slicer);
}

/** The ref of the slicer a region draws, or null for a region that carries no slicer id. */
export function slicerRefOfRegion(region: GridRegion): ObjectBindingRef | null {
  const id = region.data?.slicerId;
  return typeof id === "string" && id.length > 0 ? slicerBindingRef(id) : null;
}

/** Whether a bindings change concerns any slicer (a reload concerns every object). */
export function bindingsChangeTouchesSlicers(change: ObjectBindingsChange): boolean {
  return change.reload || change.objects.some((o) => o.kind === "slicer");
}

/** What the install needs from the slicer extension (injected: no store import here). */
export interface SlicerBindingsDeps {
  /** Whether a slicer with this id is in the store (a script instance id that names none has no ref). */
  slicerExists(slicerId: string): boolean;
  /**
   * Re-publish the slicer regions: a bound `showHeader` changes the grip a
   * header-less slicer shows (slicerStore.syncSlicerRegions).
   */
  resyncRegions(): void;
  /** Repaint the overlays -- `requestOverlayRedraw`, never GRID_REFRESH (the seam's feedback-loop rule). */
  redraw(): void;
}

/**
 * Register the slicer kind with the seam and repaint when a slicer's bound
 * value changes. Returns the uninstall.
 */
export function installSlicerBindings(deps: SlicerBindingsDeps): () => void {
  const unregister = registerBindableProperties({
    kind: "slicer",
    regionTypes: [SLICER_REGION_TYPE],
    instanceTypes: [SLICER_SCRIPT_OBJECT_TYPE],
    refOf: (region) => slicerRefOfRegion(region),
    refForInstance: (instanceId) =>
      typeof instanceId === "string" && instanceId.length > 0 && deps.slicerExists(instanceId)
        ? slicerBindingRef(instanceId)
        : null,
    // The header's two Family rows, then the object's visual-container fields
    // (WP-C D-FORMAT, the format provider's `bindingPath`): ONE registration
    // per kind. Without a region (a script's instance) only the header rows.
    properties: (_ref, region) => appendContainerBindableDescriptors(SLICER_BINDABLE_PROPERTIES.map((d) => ({ ...d })), region),
  });
  const unsubscribe = onBindingsChanged((change) => {
    if (!bindingsChangeTouchesSlicers(change)) return;
    deps.resyncRegions();
    deps.redraw();
  });
  return () => {
    unsubscribe();
    unregister();
  };
}
