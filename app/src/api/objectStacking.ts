//! FILENAME: app/src/api/objectStacking.ts
// PURPOSE: The OBJECT STACKING seam: restack floating objects -- bring
//          forward, send backward, bring to front, send to back -- through
//          whoever owns the paint order of the page they sit on.
// CONTEXT: A canvas sheet persists ONE paint order for every family
//          (`CanvasLayout.zOrder`; Core paints and hit-tests by it through
//          @api/gridOverlays' stacking resolver). Controls also keeps an
//          intra-family order of its own -- the order of its store array,
//          session-only -- behind its right-click "Order" submenu. On a canvas
//          the two would compete: a "Bring to Front" that reorders the array
//          changes nothing the canvas paints, and the canvas's order would
//          silently win.
//
//          So the page owner registers ONE service here, and a family's own
//          restack command asks it first: when the service orders the object,
//          the family routes the command through it instead of reordering its
//          private list. Worksheets have no service answer (`ordersRegion`
//          false), so a family's own order stays exactly what it was there.
//
//          Seams point one way: this module imports nothing from extensions.

import type { GridRegion } from "./gridOverlays";

/** A restack command, in the vocabulary every Office app uses. */
export type ObjectStackingCommand = "bringForward" | "sendBackward" | "bringToFront" | "sendToBack";

/** The page owner's stacking service. */
export interface ObjectStackingService {
  /** Whether this service owns the paint order of the object behind `region`. */
  ordersRegion(region: GridRegion): boolean;
  /**
   * Apply `command` to the objects behind `regions` (as one block, keeping
   * their relative order). Resolves true when the new order was stored.
   */
  restack(command: ObjectStackingCommand, regions: readonly GridRegion[]): Promise<boolean>;
}

let service: ObjectStackingService | null = null;

/**
 * Register THE stacking service. Last registration wins; the cleanup removes
 * only what is still this service (a stale cleanup cannot remove a newer one).
 */
export function registerObjectStackingService(next: ObjectStackingService): () => void {
  service = next;
  return () => {
    if (service === next) service = null;
  };
}

/**
 * The service that orders `region`, or null -- no service registered, or the
 * one registered does not own this object's page (a worksheet).
 */
export function getObjectStackingService(region: GridRegion): ObjectStackingService | null {
  if (!service) return null;
  try {
    return service.ordersRegion(region) ? service : null;
  } catch (err) {
    console.error("[objectStacking] ordersRegion threw:", err);
    return null;
  }
}

/** Test hook: forget the registered service. */
export function resetObjectStackingService(): void {
  service = null;
}
