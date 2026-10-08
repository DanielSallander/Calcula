//! FILENAME: app/extensions/CanvasSheet/lib/pageNavigator.ts
// PURPOSE: Buttons > Page Navigator: Power BI's page navigator -- a row of
//          buttons, one per report page, each going to its page, the page on
//          screen shown selected.
// CONTEXT: DECIDED IN THIS LANE (CONTRACT-CANVAS section 3 left it open):
//          Calcula builds the navigator as ONE NAVIGATE BUTTON PER PAGE, not as
//          a new object kind. Every piece already exists and already has the
//          properties Power BI's navigator needs:
//            - the declarative `navigate` action (@api/buttonControlService):
//              no code, so it works with Script Security off, on a subscribed
//              (read-only) canvas, and survives a pull (actions are not in
//              Rust's EXECUTABLE list, so a subscribe never strips them);
//            - Controls paints a navigate button whose page is on screen with
//              the pressed wash -- Power BI's "selected page" state;
//            - each button is an ordinary control: restyled, moved, deleted,
//              copied like any other.
//          The cost of a row of buttons over a single visual: a page added
//          later is not added to an existing navigator (Power BI's is live).
//          Inserting the navigator again lays out a fresh row.
//
//          WHICH PAGES. Every VISIBLE CANVAS, in tab order. A worksheet is not
//          a report page; a hidden page is not one a reader can go to (the
//          navigate action refuses it anyway). The page on screen is included
//          -- it is the one shown selected.
//
//          WHERE. The navigator is placed like any single insert
//          (lib/insertOnCanvas.ts `placeFor`): centred in the view, snapped,
//          kept on the page. It wraps to a new row at the page's right edge,
//          and it is the WHOLE WRAPPED BLOCK that is placed and kept on the
//          page -- placing one row and wrapping below it ran the last rows off
//          the bottom of a small page (a Tooltip page, 320 x 240). When even
//          the block cannot fit, the buttons get narrower (down to
//          PAGE_NAVIGATOR_MIN_BUTTON_WIDTH) so more fit on a row.
//
//          ONE UNDO STEP. Every button is created inside one frontend undo
//          transaction (@api/objectGeometry `runInUndoTransaction`), so Ctrl+Z
//          takes the whole navigator back. A refused button stops the row:
//          the ones made so far stay (they are in the same step), and the
//          refusal is said once.

import { getSheets, type SheetInfo } from "@api";
import { requireButtonControlProvider } from "@api/buttonControlService";
import { runInUndoTransaction } from "@api/objectGeometry";
import type { LayoutRect } from "@api/layoutSurface";
import { currentInsertView, insertRefusal, placeFor } from "./insertOnCanvas";
import { canvasLayoutSurface } from "./layoutSurfaceProvider";

/** One navigator button's size, in logical px (the blank button's). */
export const PAGE_NAVIGATOR_BUTTON = { width: 112, height: 32 } as const;

/** The gap between two navigator buttons, across and down, in logical px. */
export const PAGE_NAVIGATOR_GAP_PX = 8;

/** The narrowest a navigator button gets on a page too small for full width. */
export const PAGE_NAVIGATOR_MIN_BUTTON_WIDTH = 40;

/** The undo label of one Page Navigator insert. */
export const PAGE_NAVIGATOR_UNDO_LABEL = "Insert Page Navigator";

/** A page the navigator goes to: by stable id when there is one, always by name. */
export interface PageNavigatorTarget {
  sheetId?: string;
  sheetName: string;
}

/** Every visible canvas, in tab order (see the header). Pure; exported for tests. */
export function pageNavigatorTargets(sheets: readonly SheetInfo[]): PageNavigatorTarget[] {
  return [...sheets]
    .sort((a, b) => a.index - b.index)
    .filter((s) => s.kind === "canvas" && s.visibility === "visible")
    .map((s) => (s.sheetId ? { sheetId: s.sheetId, sheetName: s.name } : { sheetName: s.name }));
}

/**
 * The rects of `count` navigator buttons laid out from `origin`: left to
 * right, one gap apart, wrapping to a new row (one gap below) before a button
 * would cross the page's right edge. A row always holds at least one button.
 * Pure; exported for tests.
 */
export function layoutPageNavigator(
  count: number,
  origin: { x: number; y: number },
  page: { width: number; height: number } | null,
  width: number = PAGE_NAVIGATOR_BUTTON.width,
): LayoutRect[] {
  const { height } = PAGE_NAVIGATOR_BUTTON;
  const step = width + PAGE_NAVIGATOR_GAP_PX;
  const right = page ? page.width : Number.POSITIVE_INFINITY;
  const out: LayoutRect[] = [];
  let x = origin.x;
  let y = origin.y;
  for (let i = 0; i < count; i++) {
    if (i > 0 && x + width > right) {
      x = origin.x;
      y += height + PAGE_NAVIGATOR_GAP_PX;
    }
    out.push({ x, y, width, height });
    x += step;
  }
  return out;
}

/** How many buttons of `width` fit across `page` (at least one; all of them off a page). */
function perRow(count: number, page: { width: number } | null, width: number): number {
  const n = Math.max(1, count);
  if (!page) return n;
  const across = Math.floor((page.width + PAGE_NAVIGATOR_GAP_PX) / (width + PAGE_NAVIGATOR_GAP_PX));
  return Math.max(1, Math.min(n, across));
}

/**
 * The bounding size of `count` buttons of `width` once wrapped at the page's
 * right edge -- the box the insert places and keeps on the page. Pure;
 * exported for tests.
 */
export function pageNavigatorBlockSize(
  count: number,
  page: { width: number; height: number } | null,
  width: number = PAGE_NAVIGATOR_BUTTON.width,
): { width: number; height: number } {
  const n = Math.max(1, count);
  const across = perRow(n, page, width);
  const rows = Math.ceil(n / across);
  return {
    width: across * width + (across - 1) * PAGE_NAVIGATOR_GAP_PX,
    height: rows * PAGE_NAVIGATOR_BUTTON.height + (rows - 1) * PAGE_NAVIGATOR_GAP_PX,
  };
}

/**
 * The button width that lets `count` buttons fit on `page`: the full width
 * when the wrapped block fits, else the widest narrower one that does, never
 * below PAGE_NAVIGATOR_MIN_BUTTON_WIDTH (a page that cannot hold even those
 * gets the narrowest, and the block is pinned to its top). Pure; exported for
 * tests.
 */
export function pageNavigatorButtonWidth(count: number, page: { width: number; height: number } | null): number {
  if (!page) return PAGE_NAVIGATOR_BUTTON.width;
  const widest = Math.min(PAGE_NAVIGATOR_BUTTON.width, Math.max(PAGE_NAVIGATOR_MIN_BUTTON_WIDTH, page.width));
  for (let w = widest; w >= PAGE_NAVIGATOR_MIN_BUTTON_WIDTH; w--) {
    if (pageNavigatorBlockSize(count, page, w).height <= page.height) return w;
  }
  return PAGE_NAVIGATOR_MIN_BUTTON_WIDTH;
}

/** Insert a Page Navigator on the active canvas. Resolves when it is placed (or refused). */
export async function insertPageNavigator(): Promise<void> {
  let targets: PageNavigatorTarget[];
  try {
    targets = pageNavigatorTargets((await getSheets()).sheets);
  } catch (err) {
    await insertRefusal("a page navigator", err);
    return;
  }
  if (targets.length === 0) return;
  const view = currentInsertView();
  if (!view) return;
  const page = canvasLayoutSurface(view.sheetIndex)?.page ?? null;
  const buttonWidth = pageNavigatorButtonWidth(targets.length, page);
  // The WHOLE wrapped block is placed and kept on the page (see the header).
  const place = placeFor(pageNavigatorBlockSize(targets.length, page, buttonWidth));
  if (!place) return;
  const rects = layoutPageNavigator(targets.length, { x: place.x, y: place.y }, page, buttonWidth);

  let refused: unknown = null;
  try {
    await runInUndoTransaction(PAGE_NAVIGATOR_UNDO_LABEL, async () => {
      const provider = requireButtonControlProvider();
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const rect = rects[i];
        try {
          await provider.createButton({
            sheetIndex: place.sheetIndex,
            label: target.sheetName,
            tooltip: `Go to ${target.sheetName}`,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            action: { kind: "navigate", ...target },
          });
        } catch (err) {
          refused = err;
          return;
        }
      }
    });
  } catch (err) {
    refused = refused ?? err;
  }
  if (refused !== null) await insertRefusal("a page navigator", refused);
}
