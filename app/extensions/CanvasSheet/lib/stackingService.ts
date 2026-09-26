//! FILENAME: app/extensions/CanvasSheet/lib/stackingService.ts
// PURPOSE: The canvas's answer to `@api/objectStacking`: on a canvas the PAGE
//          owns every object's paint order, so a family's own restack command
//          (Controls' right-click "Order" submenu) is routed here instead of
//          reordering that family's private list.
// CONTEXT: Controls keeps an intra-family order of its own (its store array,
//          session-only). On a canvas Core paints and hit-tests by the layout's
//          `zOrder` (lib/canvasStacking.ts), so reordering the array changed
//          nothing anyone could see -- two orders competing, the canvas's
//          silently winning. The seam lets Controls ask "does the page own this
//          object's order?" and hand the command over without importing this
//          extension.
//
//          A subscribed canvas owns the order but may not change it (the
//          layout is the publisher's): the command is refused with the same
//          note the Canvas tab shows.

import type { GridRegion } from "@api/gridOverlays";
import { getGridStateSnapshot } from "@api/grid";
import { showToast } from "@api/notifications";
import { objectRefOf } from "@api/objectSelection";
import type { ObjectStackingCommand, ObjectStackingService } from "@api/objectStacking";
import { getCanvasSheetSnapshot } from "./canvasSheetStore";
import { restackObjects } from "./zOrderStore";
import { SUBSCRIBED_NOTE } from "./canvasNotes";

export const canvasStackingService: ObjectStackingService = {
  ordersRegion(region: GridRegion): boolean {
    if (!region.floating) return false;
    if (getGridStateSnapshot()?.surface !== "canvas") return false;
    if (getCanvasSheetSnapshot().active === null) return false;
    return objectRefOf(region) !== null;
  },

  async restack(command: ObjectStackingCommand, regions: readonly GridRegion[]): Promise<boolean> {
    if (getCanvasSheetSnapshot().activeSubscribed) {
      showToast(SUBSCRIBED_NOTE, { type: "info" });
      return false;
    }
    return restackObjects(command, regions);
  },
};
