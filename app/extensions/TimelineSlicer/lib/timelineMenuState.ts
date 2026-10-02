//! FILENAME: app/extensions/TimelineSlicer/lib/timelineMenuState.ts
// PURPOSE: Whether the timeline's right-click menu is open -- the one fact the
//          timeline's object-selection provider and its keyboard need about
//          the menu (a key then belongs to the menu the user is looking at,
//          never to the timeline behind it).
// CONTEXT: Its own module, with no imports (the Pivot box's
//          pivotVisualMenuState.ts precedent): the menu module imports the
//          provider's module (the region type, the id reader), so the provider
//          reading the menu module directly would close an import cycle.
//          handlers/timelineSlicerContextMenu.ts is the ONLY writer.

let menuOpen = false;

/** Whether the timeline's right-click menu is open. */
export function isTimelineContextMenuOpen(): boolean {
  return menuOpen;
}

/** The menu marks itself open when it renders and closed on every way it closes. */
export function setTimelineContextMenuOpen(open: boolean): void {
  menuOpen = open;
}
