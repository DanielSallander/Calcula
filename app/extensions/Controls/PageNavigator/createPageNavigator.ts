//! FILENAME: app/extensions/Controls/PageNavigator/createPageNavigator.ts
// PURPOSE: The Controls extension's driver for `createPageNavigator` on the
//          @api/buttonControlService seam: THE one place a Page Navigator is
//          made (WP-B, D-NAV).
// CONTEXT: A navigator is ONE control (`controlType: "pageNavigator"`), one
//          anchor, one undo-able object. Its items are NOT written anywhere:
//          they are derived live from @api/reportPages at paint, zone and
//          press, so a page added after the insert simply appears.
//
//          It mirrors `createButtonControlAt` (Controls/index.ts) for the
//          reason that function exists: a control is three coordinated writes
//          -- backend metadata with the RIGHT keys, the floating-store entry,
//          the overlay region sync -- and a caller that does only the first
//          gets a successful response and nothing on screen. Callers say WHERE
//          (the seam's request); this file decides HOW, from ONE recipe
//          (pageNavigatorRecipe.ts) whose every value is a string and whose
//          `pinToGrid` and `embedded` are written explicitly as "false".
//
//          SIZE. A request that names no size gets the NATURAL box for the
//          live page list (`pageNavigatorNaturalSize`, the seam's one source of
//          the item size and gap), or the seam's four-item default while the
//          page list has never been read. No size literal lives here.
//
//          The request is checked FIRST (`checkCreatePageNavigator`), so a
//          malformed request writes nothing and claims no anchor.

import {
  PAGE_NAVIGATOR_CONTROL_TYPE,
  PAGE_NAVIGATOR_DEFAULT_SIZE,
  PAGE_NAVIGATOR_NATURAL_ITEM,
  checkCreatePageNavigator,
  pageNavigatorNaturalSize,
  type ButtonControlHandle,
  type CreatePageNavigatorRequest,
  type PageNavigatorOrientation,
} from "@api/buttonControlService";
import { AppEvents, emitAppEvent } from "@api/events";
import { getGridStateSnapshot } from "@api/grid";
import { getColumnWidth, getRowHeight } from "@api/dimensions";
import { getReportPagesSnapshot, selectReportPages } from "@api/reportPages";
import { setControlMetadata } from "../lib/controlApi";
import { requestedSize, withControlAnchor } from "../lib/controlAnchors";
import { addFloatingControl, makeFloatingControlId, syncFloatingControlRegions } from "../lib/floatingStore";
import { invalidateFloatingButtonCache } from "../Button/floatingRenderer";
import { pageNavigatorRecipe } from "./pageNavigatorRecipe";

/**
 * The natural box for `count` items along `orientation`: the seam's horizontal
 * natural size, or its transpose for a vertical navigator (one item wide,
 * `count` items tall). Built from PAGE_NAVIGATOR_NATURAL_ITEM only.
 */
export function naturalPageNavigatorBox(
  count: number,
  orientation: PageNavigatorOrientation,
): { width: number; height: number } {
  if (orientation !== "vertical") return pageNavigatorNaturalSize(count);
  // The seam's rule for the item count: at least one item's room.
  const n = Math.max(1, Number.isFinite(count) ? Math.floor(count) : 1);
  return {
    width: PAGE_NAVIGATOR_NATURAL_ITEM.width,
    height: n * PAGE_NAVIGATOR_NATURAL_ITEM.height + (n - 1) * PAGE_NAVIGATOR_NATURAL_ITEM.gap,
  };
}

/**
 * The box a navigator gets when the request names no size: natural for the
 * pages it will list now (the default membership rule), or the seam's
 * four-item default while the page list has never been read.
 */
export function defaultPageNavigatorBox(orientation: PageNavigatorOrientation): { width: number; height: number } {
  const snapshot = getReportPagesSnapshot();
  if (snapshot.version === 0) {
    return orientation === "vertical"
      ? naturalPageNavigatorBox(4, "vertical")
      : { width: PAGE_NAVIGATOR_DEFAULT_SIZE.width, height: PAGE_NAVIGATOR_DEFAULT_SIZE.height };
  }
  return naturalPageNavigatorBox(selectReportPages(snapshot.pages).length, orientation);
}

/** Top-left of a cell in sheet pixels, walked per column / row (custom sizes make the grid irregular). */
function cellOrigin(row: number, col: number): { x: number; y: number } {
  const gridState = getGridStateSnapshot();
  const defaultCellWidth = gridState?.config?.defaultCellWidth ?? 100;
  const defaultCellHeight = gridState?.config?.defaultCellHeight ?? 24;
  const columnWidths = gridState?.dimensions?.columnWidths ?? new Map();
  const rowHeights = gridState?.dimensions?.rowHeights ?? new Map();
  let x = 0;
  for (let c = 0; c < col; c++) x += getColumnWidth(c, defaultCellWidth, columnWidths);
  let y = 0;
  for (let r = 0; r < row; r++) y += getRowHeight(r, defaultCellHeight, rowHeights);
  return { x, y };
}

/**
 * Create ONE Page Navigator at an anchor cell or at exactly `x`/`y`, and
 * return its handle. Throws the seam's sentence for a malformed request,
 * before anything is written.
 */
export async function createPageNavigatorAt(
  request: CreatePageNavigatorRequest,
): Promise<ButtonControlHandle> {
  const refusal = checkCreatePageNavigator(request);
  if (refusal) throw new Error(refusal);

  const { sheetIndex } = request;
  const orientation: PageNavigatorOrientation = request.orientation ?? "horizontal";
  const askedWidth = requestedSize("A page navigator's width", request.width);
  const askedHeight = requestedSize("A page navigator's height", request.height);

  return withControlAnchor(request, async ({ row, col }, position) => {
    const at = position ?? cellOrigin(row, col);
    const natural = defaultPageNavigatorBox(orientation);
    const rect = {
      x: at.x,
      y: at.y,
      width: askedWidth ?? natural.width,
      height: askedHeight ?? natural.height,
    };

    const recipe = pageNavigatorRecipe(rect, orientation);
    await setControlMetadata(sheetIndex, row, col, {
      controlType: PAGE_NAVIGATOR_CONTROL_TYPE,
      properties: Object.fromEntries(
        Object.entries(recipe).map(([key, value]) => [key, { valueType: "static" as const, value }]),
      ),
    });

    const controlId = makeFloatingControlId(sheetIndex, row, col);
    addFloatingControl({
      id: controlId,
      sheetIndex,
      row,
      col,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      controlType: PAGE_NAVIGATOR_CONTROL_TYPE,
    });

    // ONE invalidation entry point (it covers the navigator's settings cache),
    // then publish the region and repaint.
    invalidateFloatingButtonCache(controlId);
    syncFloatingControlRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);

    return {
      instanceId: controlId,
      sheetIndex,
      row,
      col,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
}
