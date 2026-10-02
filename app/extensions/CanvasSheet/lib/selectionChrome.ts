//! FILENAME: app/extensions/CanvasSheet/lib/selectionChrome.ts
// PURPOSE: Paint the canvas's LOCK MARK: a padlock on every selected object
//          the canvas layout locks, so the reason a selected object will not
//          move or resize is on the object itself.
// CONTEXT: This layer used to paint, as well, the selection frame of every
//          member the canvas SELECTION SET held on its family's behalf (a
//          second chart, a second floating range), because every family
//          painted its own selected object's chrome and a set-held member would
//          otherwise have looked unselected. Core now paints the selection
//          outline and handles of EVERY selected floating object, family-held
//          or set-held, from the one geometry its resize hit test reads
//          (core/lib/gridRenderer/rendering/floatingObjectChrome.ts, BUG-0258
//          design phase 3), so the canvas paints no frame of its own.
//
//          One grid layer at "over-selection": after Core's selection chrome,
//          so the padlock sits over the outline of a locked object (which Core
//          paints with NO handles). The layer runs on EVERY frame of every
//          sheet, so it checks the surface before it reads the selection.

import type { GridLayerContext } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { FLOATING_SELECTION_COLOUR, type GridRegion } from "@api/gridOverlays";
import { getSelectedObjectRegions } from "@api/objectSelection";
import { isLockedOnActiveCanvas } from "./canvasLocks";

/** The id of the chrome layer. */
export const CANVAS_SELECTION_CHROME_LAYER_ID = "canvas-sheet-selection-chrome";

/** The selection colour: Core's ONE floating-object chrome colour. */
export const SELECTION_CHROME_COLOUR = FLOATING_SELECTION_COLOUR;
/** The inset of the lock mark from the object's top-right corner. */
export const SELECTION_HANDLE_SIZE = 6;

/**
 * Paint the lock marks of the ACTIVE canvas's selected LOCKED objects.
 * `regions` (the selected regions) is injectable for tests; it defaults to
 * the live selection.
 */
export function paintSelectionChrome(context: GridLayerContext, regions?: readonly GridRegion[]): void {
  const state = getGridStateSnapshot();
  if (!state || state.surface !== "canvas") return;
  const selected = regions ?? getSelectedObjectRegions();
  paintLockMarks(context, selected.filter(isLockedOnActiveCanvas));
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
