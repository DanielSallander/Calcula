//! FILENAME: app/extensions/CanvasSheet/lib/canvasStacking.ts
// PURPOSE: The canvas's STACKING RESOLVER: a floating object's z on the active
//          canvas is its position in that canvas layout's `zOrder`.
// CONTEXT: Core owns one z-order for paint and every hit test
//          (@api/gridOverlays `stackedFloatingRegions` / `floatingHitOrder`)
//          and asks ONE registered resolver for a region's z. A canvas sheet
//          persists its paint order as `CanvasLayout.zOrder` -- a list of
//          `{ kind, id }` refs, bottom first -- and each family names its
//          objects in that shape through its object-selection provider
//          (`objectRefOf`, @api/objectSelection). This file joins the two.
//
//          The answers:
//            - a WORKSHEET (the active sheet is not a canvas): undefined, so
//              worksheets stack exactly as they always did;
//            - a canvas with an empty zOrder: undefined for every object, the
//              same historical order;
//            - an object whose ref IS listed: its index in zOrder;
//            - an object whose ref is NOT listed (just inserted, or a family
//              that cannot name it): undefined, and Core paints every such
//              object ABOVE the listed ones -- a new object appears on top, as
//              in Power BI, until something places it.
//
//          Duplicate refs in zOrder (the backend applies a patch verbatim) are
//          answered by their FIRST position. The ref -> index map is rebuilt
//          only when the layout object changes (the store replaces it on every
//          write), because the resolver is asked during paint and on every
//          pointer move.

import { getGridStateSnapshot } from "@api/grid";
import { objectRefOf } from "@api/objectSelection";
import { canvasObjectRefKey } from "@api/canvasSheet";
import type { GridRegion } from "@api/gridOverlays";
import type { CanvasLayout } from "@api";
import { canvasAt } from "./canvasSheetStore";

let indexedLayout: CanvasLayout | null = null;
let indexByKey = new Map<string, number>();

/** `zOrder` as `kind:id` -> first index. Pure; exported for tests. */
export function zOrderIndex(layout: CanvasLayout): Map<string, number> {
  const map = new Map<string, number>();
  (layout.zOrder ?? []).forEach((ref, i) => {
    const key = canvasObjectRefKey(ref);
    if (!map.has(key)) map.set(key, i);
  });
  return map;
}

function indexFor(layout: CanvasLayout): Map<string, number> {
  if (layout !== indexedLayout) {
    indexedLayout = layout;
    indexByKey = zOrderIndex(layout);
  }
  return indexByKey;
}

/**
 * The z of a FLOATING region on the ACTIVE canvas: its ref's index in the
 * layout's zOrder, or undefined (worksheet, empty zOrder, unlisted or unnamed
 * object). Registered with Core through `registerRegionStacking`.
 */
export function canvasRegionZ(region: GridRegion): number | undefined {
  if (!region.floating) return undefined;
  const entry = canvasAt(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
  if (!entry) return undefined;
  const zOrder = entry.layout.zOrder;
  if (!zOrder || zOrder.length === 0) return undefined;
  const ref = objectRefOf(region);
  if (!ref) return undefined;
  return indexFor(entry.layout).get(canvasObjectRefKey(ref));
}

/** Forget the cached index (extension deactivate, tests). */
export function resetCanvasStacking(): void {
  indexedLayout = null;
  indexByKey = new Map();
}
