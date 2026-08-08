//! FILENAME: app/src/shell/sheetDisplayFlagsBridge.ts
// PURPOSE: Bridge the backend's per-sheet display-flag announcement onto the
// @api event bus, so the RENDERER follows the authority however the authority
// was moved.
//
// THE DEFECT THIS CLOSES
// ----------------------
// `displayZeros`, `showFormulas`, `viewMode` and `displayHeadings` became real
// per-sheet backend state (`.cala` v6). What DRAWS them is frontend Core state,
// fed by the `DISPLAY_*_TOGGLED` app events the View menu emits. So the two
// halves only agreed when the change came from the View menu: anything that
// reached `set_sheet_display_flags` any other way -- a script, an MCP tool, a
// `.calp` materialisation, an E2E spec restoring state -- moved the authority
// and left the renderer painting the previous document.
//
// Measured on the running app (2026-08-08): after one journey spec restored the
// flags through that command, the whole rest of the run painted with the
// row/column headings switched OFF while `get_sheet_display_flags` reported them
// ON. Every canvas probe and every canvas click in that session was then off by
// the header size, because the renderer collapses the header gutters to 0/0 when
// the headings are hidden.
//
// WHY THE BACKEND SIDE IS ONE EVENT
// ---------------------------------
// The emitter is the setter itself (`sheets.rs::set_sheet_display_flags`), which
// is the single write door for all four flags. One emitter, one bridge, so
// subscribers see each change once -- the same shape as `dirtyStateBridge.ts`
// and the `bi:model-changed` bridge.
//
// The Rust payload is the RESULT of applying the patch, and it is deliberately
// NOT forwarded: the app event carries nothing and Core answers it by re-reading
// `get_sheet_display_flags`. A payload would be a second copy of the authority
// that a caller could act on after it had gone stale.

import { listenTauriEvent } from "../api/backend";
import { emitAppEvent, AppEvents } from "../api/events";

/**
 * The Tauri event `sheets.rs::set_sheet_display_flags` emits after every write.
 * Must stay in sync with `SHEET_DISPLAY_FLAGS_EVENT` in
 * `app/src-tauri/src/sheets.rs`.
 */
export const BACKEND_SHEET_DISPLAY_FLAGS_EVENT = "sheet:display-flags-changed";

/**
 * Re-emit backend display-flag changes as
 * {@link AppEvents.SHEET_DISPLAY_FLAGS_CHANGED}.
 *
 * Returns the promise of an unlisten function so a caller can tear the bridge
 * down; `bootstrapShell` installs it for the lifetime of the window and does
 * not. Resolves to `undefined` when there is no Tauri runtime (test contexts),
 * which is a no-op rather than an error: the View-menu route still drives Core
 * directly.
 */
export function bridgeSheetDisplayFlagsAnnouncement(): Promise<(() => void) | undefined> {
  return listenTauriEvent(BACKEND_SHEET_DISPLAY_FLAGS_EVENT, () => {
    emitAppEvent(AppEvents.SHEET_DISPLAY_FLAGS_CHANGED);
  }).catch(() => undefined);
}
