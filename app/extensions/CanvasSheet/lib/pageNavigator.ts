//! FILENAME: app/extensions/CanvasSheet/lib/pageNavigator.ts
// PURPOSE: Buttons > Page Navigator: Power BI's page navigator -- ONE live
//          control that shows a button per report page, goes to that page on a
//          press, and shows the page on screen selected.
// CONTEXT: The navigator is ONE control of type "pageNavigator", owned by the
//          Controls extension and created through its feature-neutral seam,
//          `@api/buttonControlService` `createPageNavigator` (the Seam Rule).
//          This module says only WHERE it goes and how big its box is; the
//          provider decides its recipe (colours, pin/embed, gap...).
//
//          LIVE. Its items are never stored: Controls derives them at paint,
//          hit-test, press and pane time from the `@api/reportPages` snapshot,
//          so a page added, renamed, moved, hidden, deleted or pulled later
//          shows up in an existing navigator without inserting it again. One
//          control means one anchor, one selection, one move, one delete and
//          one undo step ("Insert Page Navigator").
//
//          HOW BIG. The box is the seam's NATURAL size for the pages the
//          navigator lists right now (`pageNavigatorNaturalSize` over
//          `selectReportPages` with the default filter: visible, non-Tooltip
//          canvases), CLAMPED to the page on each axis. The box is fixed; the
//          items divide it equally, so a long page list on a small page (a
//          Tooltip page, 320 x 240) never runs off the page -- the items get
//          narrower instead. No size constant is re-typed here.
//
//          WHERE. Placed like any single insert (lib/insertOnCanvas.ts
//          `placeFor`): centred in the view, snapped, kept on the page.

import { getSheets } from "@api";
import { pageNavigatorNaturalSize, requireButtonControlProvider } from "@api/buttonControlService";
import { runInUndoTransaction } from "@api/objectGeometry";
import { reportPagesFrom, selectReportPages } from "@api/reportPages";
import { currentInsertView, insertRefusal, placeFor } from "./insertOnCanvas";
import { canvasLayoutSurface } from "./layoutSurfaceProvider";

/** The undo label of one Page Navigator insert. */
export const PAGE_NAVIGATOR_UNDO_LABEL = "Insert Page Navigator";

/**
 * The box a new navigator listing `itemCount` pages gets: the seam's natural
 * size, clamped to `page` on each axis when there is a page (the box is
 * clamped; the items divide it). Pure; exported for tests.
 */
export function pageNavigatorDefaultSize(
  itemCount: number,
  page: { width: number; height: number } | null,
): { width: number; height: number } {
  const natural = pageNavigatorNaturalSize(itemCount);
  return {
    width: page ? Math.min(natural.width, page.width) : natural.width,
    height: page ? Math.min(natural.height, page.height) : natural.height,
  };
}

/** Insert a Page Navigator on the active canvas. Resolves when it is placed (or refused). */
export async function insertPageNavigator(): Promise<void> {
  let count: number;
  try {
    count = selectReportPages(reportPagesFrom(await getSheets())).length;
  } catch (err) {
    await insertRefusal("a page navigator", err);
    return;
  }
  const view = currentInsertView();
  if (!view) return;
  const page = canvasLayoutSurface(view.sheetIndex)?.page ?? null;
  // A navigator with no page to list yet is still inserted: it is live, and
  // the natural size of zero items is one item's room (never an invisible box).
  const place = placeFor(pageNavigatorDefaultSize(count, page));
  if (!place) return;

  try {
    await runInUndoTransaction(PAGE_NAVIGATOR_UNDO_LABEL, () =>
      requireButtonControlProvider().createPageNavigator({
        sheetIndex: place.sheetIndex,
        x: place.x,
        y: place.y,
        width: place.width,
        height: place.height,
      }),
    );
  } catch (err) {
    await insertRefusal("a page navigator", err);
  }
}
