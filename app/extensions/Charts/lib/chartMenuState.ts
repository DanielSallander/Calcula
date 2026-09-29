//! FILENAME: app/extensions/Charts/lib/chartMenuState.ts
// PURPOSE: Whether one of Charts' right-click menus (the chart menu or the axis
//          menu) is open -- so Escape is THE MENU's while it is.
// CONTEXT: Both menus close themselves on Escape from a `document` capture
//          listener. Two other listeners heard the same key first and acted
//          on the object BEHIND the menu (BUG-0196, chart part):
//            - on a canvas, the canvas's Escape binding (CanvasSheet
//              lib/objectCycling.ts) runs in the keybinding dispatcher's
//              WINDOW-capture listener and stops the key -- the menu never
//              heard it, and the chart was deselected under an open menu. The
//              binding asks the chart's family first (`objectOwnsKey`), and
//              the chart's selection provider answers from here;
//            - on any sheet, Charts' own element-walk listener (index.ts
//              `handleChartNavKey`, registered at activation and so earlier on
//              the same `document` capture path) stepped the chart up a rung
//              or deselected it while the menu closed.
//          The Floating Range solved the identical case the same way
//          (FloatingRange/lib/frContextMenu.ts `isFrContextMenuOpen`).
//
//          A COUNT, not a flag: a re-open mounts the new menu before the old
//          one's cleanup runs.

let openMenus = 0;

/** Whether a chart or axis context menu is open right now. */
export function isChartMenuOpen(): boolean {
  return openMenus > 0;
}

/**
 * A menu component marks itself open while mounted (`useEffect(() =>
 * noteChartMenuMounted(), [])`). Returns the release, which is idempotent.
 */
export function noteChartMenuMounted(): () => void {
  openMenus++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openMenus = Math.max(0, openMenus - 1);
  };
}
