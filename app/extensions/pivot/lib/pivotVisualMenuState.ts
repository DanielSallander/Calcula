//! FILENAME: app/extensions/Pivot/lib/pivotVisualMenuState.ts
// PURPOSE: The facts the canvas pivot box's object-selection provider needs
//          about who owns Escape right now: a box's right-click menu while it
//          is open, a chrome press (a +/-, a filter button, Cancel) while it
//          is held (pivotChromePress.ts; it cancels on Escape), and a CELL
//          press while its drag is held (pivotCellPress.ts; Escape ends the
//          drag and keeps the cells). Its own module, with no imports, so the
//          provider does not pull the menu's @api dependencies -- or the
//          presses' routes to the pivot IPC module -- into everything that
//          imports it.
//
//          The two presses are exclusive (a new one ends the other), and each
//          press module registers its own canceller here, so neither imports
//          the other.

let openMenus = 0;
let chromePressLive = false;
let cellPressLive = false;

/** Whether a pivot box's menu is open (it then owns Escape). */
export function isPivotBoxMenuOpen(): boolean {
  return openMenus > 0;
}

/** The menu marks itself open; returns the release (idempotent). */
export function notePivotBoxMenuOpened(): () => void {
  openMenus++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openMenus--;
  };
}

/** Whether a chrome press is held (it then owns Escape). */
export function isPivotChromePressLive(): boolean {
  return chromePressLive;
}

/** pivotChromePress.ts marks its press live at the press and not at its end. */
export function setPivotChromePressLive(live: boolean): void {
  chromePressLive = live;
}

/** Whether a cell press (a drag selecting a box's cells) is held (it then owns Escape). */
export function isPivotCellPressHeld(): boolean {
  return cellPressLive;
}

/** pivotCellPress.ts marks its press live at the press and not at its end. */
export function setPivotCellPressHeld(live: boolean): void {
  cellPressLive = live;
}

/** The two kinds of press a box's content can hold. */
export type PivotPressKind = "chrome" | "cell";

const pressCancellers = new Map<PivotPressKind, () => void>();

/** A press module registers how to end its live press without acting (once, at load). */
export function registerPivotPressCanceller(kind: PivotPressKind, cancel: () => void): void {
  pressCancellers.set(kind, cancel);
}

/** End the live press of `kind`, if its module is loaded and one is live. */
export function cancelPivotPress(kind: PivotPressKind): void {
  pressCancellers.get(kind)?.();
}
