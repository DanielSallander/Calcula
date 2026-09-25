//! FILENAME: app/extensions/CanvasSheet/lib/layoutSurfaceProvider.ts
// PURPOSE: Answer Core's layout-surface question for a canvas sheet: does a
//          dragged object snap, to what pitch, where does the page end, and
//          may objects move at all.
// CONTEXT: Core owns the pointer gesture for every floating object and asks
//          ONE provider (`@api/layoutSurface`) at the one point every family's
//          geometry passes through. A worksheet answers null, which leaves its
//          objects exactly as free as they always were.
//
//          EDITABLE. A canvas is editable unless it is SUBSCRIBED from an
//          application: a pulled report page is the publisher's layout, and a
//          subscriber who could drag its charts around would be editing a copy
//          the next refresh silently puts back. Detaching the sheet makes it
//          the user's own and editable again. Design mode is NOT part of the
//          rule: it is a session-only flag that starts off, and gating on it
//          would leave the charts on a new canvas immovable while the same
//          chart on a worksheet moves freely. (Floating ranges still follow
//          design mode through their own region data, as they do everywhere.)

import type { LayoutSurface, LayoutSurfaceProvider } from "@api/layoutSurface";
import { canvasAt, isSubscribedCanvas } from "./canvasSheetStore";

/** The layout surface of sheet `index`, or null for a worksheet. Pure over the store. */
export function canvasLayoutSurface(index: number): LayoutSurface | null {
  const entry = canvasAt(index);
  if (!entry) return null;
  const { layout } = entry;
  return {
    snapToGrid: layout.snapToGrid,
    gridSize: layout.gridSizePx,
    showGrid: layout.showGrid,
    page: { width: layout.pageWidth, height: layout.pageHeight },
    editable: !isSubscribedCanvas(index),
  };
}

export const canvasLayoutSurfaceProvider: LayoutSurfaceProvider = {
  get: canvasLayoutSurface,
};
