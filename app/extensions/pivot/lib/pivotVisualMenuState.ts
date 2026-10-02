//! FILENAME: app/extensions/Pivot/lib/pivotVisualMenuState.ts
// PURPOSE: The facts the canvas pivot box's object-selection provider needs
//          about who owns Escape right now: a box's right-click menu while it
//          is open, and a chrome press (a +/-, a filter button, Cancel) while
//          it is held (pivotChromePress.ts; it cancels on Escape). Its own
//          module, with no imports, so the provider does not pull the menu's
//          @api dependencies -- or the chrome press's route to the pivot IPC
//          module -- into everything that imports it.

let openMenus = 0;
let chromePressLive = false;

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
