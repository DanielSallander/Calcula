//! FILENAME: app/extensions/CanvasSheet/lib/selectionChrome.ts
// PURPOSE: Paint the selection frame of every object the canvas SELECTION SET
//          holds on its family's behalf -- the second chart, the second
//          floating range, a pivot box that deselected itself when another
//          family was Ctrl+clicked.
// CONTEXT: Each family paints its own selected object's chrome, in its own
//          renderer. Chart, Floating Range and the pivot box hold ONE selected
//          object each, so in a multi-selection their other members are held by
//          the set (@api/objectSelection `getSetHeldObjectRegions`) and would
//          otherwise look unselected. This layer draws their frames in the SAME
//          visual language the families use -- a 2px object-chrome blue frame
//          inset by 1px, with 6px corner squares inside the corners (the
//          chart's frame) -- so a mixed selection reads as one selection.
//
//          One grid layer at "over-selection": after every floating object, so
//          a set-held member's frame is never hidden under the object above it.
//          The layer runs on EVERY frame of every sheet, so it checks the
//          surface before it reads the set.

import type { GridLayerContext } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import type { GridRegion } from "@api/gridOverlays";
import { getSelectedObjectRegions, getSetHeldObjectRegions } from "@api/objectSelection";
import { isLockedOnActiveCanvas } from "./canvasLocks";

/** The id of the chrome layer. */
export const CANVAS_SELECTION_CHROME_LAYER_ID = "canvas-sheet-selection-chrome";

/** The object-chrome blue of the chart, floating-range and control frames. */
export const SELECTION_CHROME_COLOUR = "#0e639c";
/** Frame width, as the families draw it. */
export const SELECTION_FRAME_WIDTH = 2;
/** Corner-handle size, as the families draw it. */
export const SELECTION_HANDLE_SIZE = 6;

/**
 * Paint the frames of the set-held members of the ACTIVE canvas. `regions`
 * is injectable for tests; it defaults to the live set.
 */
export function paintSelectionChrome(context: GridLayerContext, regions?: readonly GridRegion[]): void {
  const state = getGridStateSnapshot();
  if (!state || state.surface !== "canvas") return;
  // Every selected LOCKED object says so, whichever family paints its frame.
  if (regions === undefined) paintLockMarks(context, getSelectedObjectRegions().filter(isLockedOnActiveCanvas));
  const held = regions ?? getSetHeldObjectRegions();
  if (held.length === 0) return;

  const { ctx, viewport, config } = context;
  const gutterX = config.rowHeaderWidth ?? 0;
  const gutterY = config.colHeaderHeight ?? 0;
  const h = SELECTION_HANDLE_SIZE;

  ctx.setLineDash([]);
  for (const r of held) {
    const f = r.floating;
    if (!f) continue;
    const x = gutterX + f.x - viewport.scrollX;
    const y = gutterY + f.y - viewport.scrollY;
    ctx.strokeStyle = SELECTION_CHROME_COLOUR;
    ctx.lineWidth = SELECTION_FRAME_WIDTH;
    ctx.strokeRect(x + 1, y + 1, f.width - 2, f.height - 2);
    ctx.fillStyle = SELECTION_CHROME_COLOUR;
    ctx.fillRect(x, y, h, h);
    ctx.fillRect(x + f.width - h, y, h, h);
    ctx.fillRect(x, y + f.height - h, h, h);
    ctx.fillRect(x + f.width - h, y + f.height - h, h, h);
  }
}

/** The lock mark's size (a padlock inside the object's top-right corner). */
export const LOCK_MARK_SIZE = 12;
/** The plate under the lock mark, so it reads over any chart or picture. */
export const LOCK_MARK_PLATE = "#ffffff";

/**
 * A small padlock inside the top-right corner of every selected LOCKED object
 * (the canvas layout's `locked`), so the reason a selected object will not
 * move is on the object itself. Painted on a white plate so it reads over any
 * chart or picture.
 */
export function paintLockMarks(context: GridLayerContext, locked: readonly GridRegion[]): void {
  if (locked.length === 0) return;
  const { ctx, viewport, config } = context;
  const gutterX = config.rowHeaderWidth ?? 0;
  const gutterY = config.colHeaderHeight ?? 0;
  const s = LOCK_MARK_SIZE;
  ctx.setLineDash([]);
  for (const r of locked) {
    const f = r.floating;
    if (!f || f.width < s * 2 || f.height < s * 2) continue;
    const x = gutterX + f.x - viewport.scrollX + f.width - SELECTION_HANDLE_SIZE - s - 4;
    const y = gutterY + f.y - viewport.scrollY + SELECTION_HANDLE_SIZE + 4;
    ctx.fillStyle = LOCK_MARK_PLATE;
    ctx.fillRect(x - 2, y - 2, s + 4, s + 4);
    ctx.fillStyle = SELECTION_CHROME_COLOUR;
    // Body.
    ctx.fillRect(x + 1, y + s / 2, s - 2, s / 2);
    // Shackle.
    ctx.strokeStyle = SELECTION_CHROME_COLOUR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + s / 2, y + s / 2, s / 2 - 3, Math.PI, 0);
    ctx.stroke();
  }
}
