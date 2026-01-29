//! FILENAME: app/src/shell/MenuBar/MenuBar.events.ts
// PURPOSE: Re-exports from the API layer for backward compatibility.
// CONTEXT: New code should import directly from "../../api/events" instead.

import {
  AppEvents,
  emitAppEvent,
  restoreFocusToGrid as apiRestoreFocusToGrid,
  type AppEventType,
} from "../../api/events";

// Re-export AppEvents as MenuEvents for backward compatibility
export const MenuEvents = {
  CUT: AppEvents.CUT,
  COPY: AppEvents.COPY,
  PASTE: AppEvents.PASTE,
  FIND: AppEvents.FIND,
  REPLACE: AppEvents.REPLACE,
  FREEZE_CHANGED: AppEvents.FREEZE_CHANGED,
  CELLS_MERGED: AppEvents.CELLS_MERGED,
  CELLS_UNMERGED: AppEvents.CELLS_UNMERGED,
  PIVOT_CREATED: AppEvents.PIVOT_CREATED,
} as const;

// Re-export emitAppEvent as emitMenuEvent for backward compatibility
export function emitMenuEvent(eventName: string, detail?: unknown): void {
  emitAppEvent(eventName as AppEventType, detail);
}

// Re-export restoreFocusToGrid
export const restoreFocusToGrid = apiRestoreFocusToGrid;