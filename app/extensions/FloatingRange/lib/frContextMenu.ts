//! FILENAME: app/extensions/FloatingRange/lib/frContextMenu.ts
// PURPOSE: The item MODEL for a floating range's own right-click menu
//          (Add/Delete Row/Column, Size and Position…, Rename…, Properties…,
//          Delete).
// CONTEXT: These items used to be registered into `gridExtensions`, the
//          registry only `GridContextMenuHost` renders — and that host is only
//          opened by `AppEvents.CONTEXT_MENU_REQUEST`, which Core deliberately
//          does NOT emit for a right-click that lands on a floating object
//          ("Cell options on an object right-click are always wrong",
//          Spreadsheet.tsx). The items were therefore UNREACHABLE by
//          right-clicking the object they belong to: registered, ordered,
//          gated, and dead.
//
//          The working precedent is Charts / Slicer / TimelineSlicer: the
//          object's extension owns a capture-phase `contextmenu` listener and
//          shows its OWN overlay menu. That is what index.ts now does, and
//          this module is reduced to the part worth keeping — the item list —
//          so the menu component stays a renderer and the actions stay with
//          the lifecycle owner.
//
//          "Size and Position..." is the row EVERY object menu carries
//          (@api/objectPosition; BUG-0258 design phase 5b): the no-drag route
//          to place the grid. Its Width and Height stay disabled -- a range's
//          size is its rows and columns, which the four size items change.

import type { GridRegion } from "@api/gridOverlays";
import { SIZE_AND_POSITION_LABEL, sizeAndPositionMenuEntry } from "@api/objectPosition";

/** How many of these menus are mounted (0 or 1 in practice; a count, because
 *  a re-open mounts the new menu before the old one's cleanup runs). */
let openMenus = 0;

/**
 * Whether the range's right-click menu is open: Escape is then the MENU's
 * alone. Asked by the range's own keyboard (index.ts `handleFrKeyDown`) and by
 * its object-selection provider (`ownsKey`, which a canvas's Escape binding
 * consults before it clears the selection).
 */
export function isFrContextMenuOpen(): boolean {
  return openMenus > 0;
}

/** The menu component marks itself open while mounted; returns the release
 *  (idempotent). */
export function noteFrContextMenuMounted(): () => void {
  openMenus++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openMenus--;
  };
}

/** One entry in the floating-range object menu. */
export interface FrMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  /** Hidden entirely when false (never rendered greyed out). */
  enabled: boolean;
  separatorAfter?: boolean;
  /** Marks a destructive action so the menu can paint it as one. */
  destructive?: boolean;
  run(): void;
}

export interface FrContextMenuHandlers {
  addRow(frId: string): void;
  addColumn(frId: string): void;
  deleteLastRow(frId: string): void;
  deleteLastColumn(frId: string): void;
  rename(frId: string): void;
  properties(frId: string): void;
  deleteObject(frId: string): void;
  /** Window size lookup for the shrink-item gating (a 1-row FR cannot lose a row). */
  getCounts(frId: string): { rows: number; cols: number } | null;
  /**
   * Whether the range's SIZE may change (the store's `frGeometryEditable`, the
   * one answer every geometry door reads): false for a range its canvas locks
   * (or one on a subscribed canvas, whose menu does not open at all).
   */
  canEditGeometry(frId: string): boolean;
  /** The range's published region on the active sheet (null when it is not published). */
  regionOf(frId: string): GridRegion | null;
}

/**
 * Build the menu for one floating range. Evaluated at OPEN time, so the
 * shrink items reflect the window the object has right now, and the four
 * SIZE items are withheld while the range's geometry is frozen.
 */
export function buildFrContextMenu(
  frId: string,
  handlers: FrContextMenuHandlers,
): FrMenuItem[] {
  const counts = handlers.getCounts(frId);
  const geometry = handlers.canEditGeometry(frId);
  const region = handlers.regionOf(frId);
  const sizePos = region ? sizeAndPositionMenuEntry(region) : null;
  return [
    {
      id: "floatingRange.addRow",
      label: "Add Row",
      enabled: geometry,
      run: () => handlers.addRow(frId),
    },
    {
      id: "floatingRange.addColumn",
      label: "Add Column",
      enabled: geometry,
      run: () => handlers.addColumn(frId),
    },
    {
      id: "floatingRange.deleteLastRow",
      label: "Delete Last Row",
      enabled: geometry && (counts?.rows ?? 1) > 1,
      run: () => handlers.deleteLastRow(frId),
    },
    {
      id: "floatingRange.deleteLastColumn",
      label: "Delete Last Column",
      enabled: geometry && (counts?.cols ?? 1) > 1,
      separatorAfter: true,
      run: () => handlers.deleteLastColumn(frId),
    },
    {
      id: "floatingRange.sizeAndPosition",
      label: SIZE_AND_POSITION_LABEL,
      // Hidden only when no dialog can open for the range (not published, no
      // dialog installed); a LOCKED range still opens it, read-only.
      enabled: !!sizePos && !sizePos.disabled,
      separatorAfter: true,
      run: () => sizePos?.run(),
    },
    {
      id: "floatingRange.rename",
      label: "Rename…",
      enabled: true,
      run: () => handlers.rename(frId),
    },
    {
      id: "floatingRange.properties",
      label: "Properties…",
      enabled: true,
      separatorAfter: true,
      run: () => handlers.properties(frId),
    },
    {
      id: "floatingRange.delete",
      label: "Delete",
      shortcut: "Del",
      enabled: true,
      destructive: true,
      run: () => handlers.deleteObject(frId),
    },
  ];
}
