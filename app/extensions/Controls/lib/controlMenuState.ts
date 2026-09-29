//! FILENAME: app/extensions/Controls/lib/controlMenuState.ts
// PURPOSE: Whether a floating control's right-click menu is open -- so Escape
//          is THE MENU's while it is.
// CONTEXT: The menu (components/ControlContextMenu.tsx) closes itself on
//          Escape from a `document` capture listener. On a canvas, the
//          canvas's Escape binding (CanvasSheet lib/objectCycling.ts) runs
//          earlier -- in the keybinding dispatcher's WINDOW-capture listener --
//          and stops the key, so the menu never heard it: Escape deselected the
//          control and left its menu open, offering Delete / Order / Edit
//          Script for an object that was no longer selected (BUG-0196, control
//          part). The binding asks the object's family first (`objectOwnsKey`,
//          @api/objectSelection); Controls' provider answers from here. The
//          Floating Range's worked example: FloatingRange/lib/frContextMenu.ts.
//
//          A COUNT, not a flag: a re-open mounts the new menu before the old
//          one's cleanup runs.

let openMenus = 0;

/** Whether a floating control's context menu is open right now. */
export function isControlMenuOpen(): boolean {
  return openMenus > 0;
}

/**
 * The menu component marks itself open while mounted (`useEffect(() =>
 * noteControlMenuMounted(), [])`). Returns the release, which is idempotent.
 */
export function noteControlMenuMounted(): () => void {
  openMenus++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openMenus = Math.max(0, openMenus - 1);
  };
}
