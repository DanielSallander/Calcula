//! FILENAME: app/src/shell/MenuBar/MenuBar.events.ts
// PURPOSE: UI Utilities for the MenuBar.
// CONTEXT: Purely for DOM/Focus management. No business logic or event definitions.

import { restoreFocusToGrid as apiRestoreFocusToGrid } from "../../api/events";

/**
 * Helper to return focus to the grid after a menu action.
 * This is a UI utility, not a business event.
 */
export const restoreFocusToGrid = apiRestoreFocusToGrid;