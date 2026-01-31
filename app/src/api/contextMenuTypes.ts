//! FILENAME: app/src/api/contextMenuTypes.ts
// PURPOSE: Type definitions for context menu events
// CONTEXT: Shared types between Core (emitter) and Shell (renderer)

import type { GridMenuContext } from "./extensions";

/**
 * Payload for CONTEXT_MENU_REQUEST event.
 * Core emits this; Shell listens and renders the menu.
 */
export interface ContextMenuRequestPayload {
  /** Screen position where the menu should appear */
  position: { x: number; y: number };
  /** Context information for menu item filtering */
  context: GridMenuContext;
}