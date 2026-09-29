//! FILENAME: app/extensions/Pivot/lib/pivotVisualMenuState.ts
// PURPOSE: Whether a canvas pivot box's right-click menu is open -- the one
//          fact the box's object-selection provider needs (the open menu owns
//          Escape). Its own module, with no imports, so the provider does not
//          pull the menu's @api dependencies into everything that imports it.

let openMenus = 0;

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
