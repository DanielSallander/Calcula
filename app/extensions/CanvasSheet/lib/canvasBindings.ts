//! FILENAME: app/extensions/CanvasSheet/lib/canvasBindings.ts
// PURPOSE: A canvas PAGE's bound properties (@api/objectBindings, D-BIND): the
//          two page colours a page offers to bind (its background and its
//          wallpaper), the layout as it is SHOWN -- the stored layout with
//          every resolved binding applied -- and the registration of the
//          "canvasPage" kind.
// CONTEXT: One spelling per fact (D invariant 1). The store keeps the LITERAL
//          layout (what the Canvas tab's Page group edits through
//          `set_canvas_layout`); a binding's value exists only in the copy the
//          page painter reads (lib/pagePainter.ts). A page's binding id is its
//          SheetId -- stable across insert/delete/move, unlike the index.
//
//          The page is a grid LAYER, not a published region: a pane that asks
//          about the page describes it with `canvasPageRegion(...)`
//          (@api/canvasSheet), and `refOf` turns that into the ref here.
//
//          Rust owns evaluation; this module never evaluates and never writes.

import {
  onBindingsChanged,
  overlayResolved,
  registerBindableProperties,
  type BindablePropertyDescriptor,
  type ObjectBindingRef,
  type ObjectBindingsChange,
} from "@api/objectBindings";
import type { GridRegion } from "@api/gridOverlays";
import type { CanvasLayout } from "@api";
import { CANVAS_PAGE_REGION_TYPE } from "@api/canvasSheet";
import { canvasAt, type CanvasSheetEntry } from "./canvasSheetStore";

/**
 * What a canvas page offers to bind -- the catalog's two canvasPage rows
 * (`/background`, `/wallpaper`, both Color). The registry drops any pointer
 * the catalog does not know.
 */
export const CANVAS_PAGE_BINDABLE_PROPERTIES: readonly BindablePropertyDescriptor[] = Object.freeze([
  { pointer: "/background", label: "Page background", group: "Page" },
  { pointer: "/wallpaper", label: "Wallpaper", group: "Page" },
]);

/** A canvas page's binding ref: its id is the page's SheetId string. */
export function canvasPageBindingRef(sheetId: string): ObjectBindingRef {
  return { kind: "canvasPage", id: sheetId };
}

/**
 * The page's layout as it is SHOWN: a copy of the stored layout with every
 * resolved binding applied (a pending value or an error keeps the literal --
 * both rows are colours, never text). Returns the very layout when the page
 * has no id or nothing on it is bound.
 */
export function shownCanvasLayout(entry: Pick<CanvasSheetEntry, "sheetId" | "layout">): CanvasLayout {
  if (!entry.sheetId) return entry.layout;
  return overlayResolved(canvasPageBindingRef(entry.sheetId), "", entry.layout);
}

/**
 * The ref of the page a region describes: its `data.sheetId` when the caller
 * knew it, else the SheetId of the canvas at its `data.sheetIndex`. Null for
 * any other region, for a worksheet index, and for a page whose id is not
 * known yet.
 */
export function canvasPageRefOfRegion(
  region: GridRegion,
  entryAt: (index: number) => Pick<CanvasSheetEntry, "sheetId"> | null = canvasAt,
): ObjectBindingRef | null {
  if (region.type !== CANVAS_PAGE_REGION_TYPE) return null;
  const sheetId = region.data?.sheetId;
  if (typeof sheetId === "string" && sheetId.length > 0) return canvasPageBindingRef(sheetId);
  const index = region.data?.sheetIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  const id = entryAt(index)?.sheetId;
  return id ? canvasPageBindingRef(id) : null;
}

/** Whether a bindings change concerns any canvas page (a reload concerns every object). */
export function bindingsChangeTouchesPages(change: ObjectBindingsChange): boolean {
  return change.reload || change.objects.some((o) => o.kind === "canvasPage");
}

/**
 * Register the canvasPage kind with the seam and repaint the page when a
 * page's bound colour changes (`redraw` is `requestOverlayRedraw`, which
 * repaints the grid layers too -- never GRID_REFRESH, the seam's
 * feedback-loop rule). Returns the uninstall.
 */
export function installCanvasPageBindings(redraw: () => void): () => void {
  const unregister = registerBindableProperties({
    kind: "canvasPage",
    regionTypes: [CANVAS_PAGE_REGION_TYPE],
    refOf: (region) => canvasPageRefOfRegion(region),
    properties: () => CANVAS_PAGE_BINDABLE_PROPERTIES.map((d) => ({ ...d })),
  });
  const unsubscribe = onBindingsChanged((change) => {
    if (bindingsChangeTouchesPages(change)) redraw();
  });
  return () => {
    unsubscribe();
    unregister();
  };
}
