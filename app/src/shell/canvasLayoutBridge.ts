//! FILENAME: app/src/shell/canvasLayoutBridge.ts
// PURPOSE: Bridge the backend's canvas-layout announcement onto the @api event
// bus, so every surface that draws a canvas sheet's layout (the snap grid, the
// page, the scroll extent, the Canvas ribbon tab) follows the authority however
// the authority was moved.
//
// WHY A BRIDGE
// ------------
// A canvas sheet's layout (page size, snap grid, background, stacking) is
// BACKEND state (`sheet_kinds`, `.cala` v9), written through ONE door,
// `sheets.rs::set_canvas_layout`. The Canvas ribbon tab reaches that door, but
// so do a script row, an MCP tool and a `.calp` refresh -- and without this
// bridge a layout moved by any of those would leave the page painted at its
// old size and the snap grid at its old pitch. Same shape as
// `sheetDisplayFlagsBridge.ts`: one emitter, one bridge, each change seen once.
//
// The Rust payload names the sheet and carries the RESULT of the patch, and it
// is deliberately NOT forwarded: the app event carries nothing and the canvas
// sheet extension answers it by re-reading `get_sheets`. A payload would be a
// second copy of the authority that a subscriber could act on after it had
// gone stale.

import { listenTauriEvent } from "../api/backend";
import { emitAppEvent, AppEvents } from "../api/events";

/**
 * The Tauri event `sheets.rs::set_canvas_layout` emits after every write. Must
 * stay in sync with `CANVAS_LAYOUT_EVENT` in `app/src-tauri/src/sheets.rs`.
 */
export const BACKEND_CANVAS_LAYOUT_EVENT = "sheet:canvas-layout-changed";

/**
 * Re-emit backend canvas-layout changes as
 * {@link AppEvents.CANVAS_LAYOUT_CHANGED}.
 *
 * Returns the promise of an unlisten function; `bootstrapShell` installs it for
 * the lifetime of the window. Resolves to `undefined` when there is no Tauri
 * runtime (test contexts), which is a no-op rather than an error.
 */
export function bridgeCanvasLayoutAnnouncement(): Promise<(() => void) | undefined> {
  return listenTauriEvent(BACKEND_CANVAS_LAYOUT_EVENT, () => {
    emitAppEvent(AppEvents.CANVAS_LAYOUT_CHANGED);
  }).catch(() => undefined);
}
