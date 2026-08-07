//! FILENAME: app/src/shell/dirtyStateBridge.ts
// PURPOSE: Bridge the backend's workbook dirty-state announcement onto the @api
// event bus, so the title-bar asterisk tracks a mutation that never touched the
// frontend.
//
// THE DEFECT THIS CLOSES
// ----------------------
// `updateWindowTitle()` (core/lib/file-api.ts) re-reads `is_file_modified` and
// rewrites `document.title`, but Layout.tsx only calls it on six FRONTEND-
// originated events (CELLS_UPDATED, ROWS/COLUMNS_INSERTED/DELETED,
// DIRTY_STATE_CHANGED). A backend-only mutation -- an MCP tool, a script, a
// package pull, a writeback submission -- set `is_modified` and emitted none of
// them, so the flag was true and the asterisk absent. The close prompt and
// AutoRecover both worked; only the ambient signal was missing.
//
// WHY THE BACKEND SIDE IS ONE EVENT AND NOT 355
// ---------------------------------------------
// The emitter is `document_effect::DirtyFlag`, which announces on the
// clean<->dirty TRANSITION from inside the flag itself. Asking every mutating
// command to remember an emit is the exact failure mode the dirty-flag census
// existed to end -- 256 of 746 commands had already forgotten the far more
// consequential `is_modified` write. See the module doc on `DirtyFlag`.
//
// This file is the single frontend re-emitter, mirroring the "bi:model-changed"
// bridge: one backend emitter, one bridge, so subscribers see each transition
// once.

import { listenTauriEvent } from "../api/backend";
import { emitAppEvent, AppEvents } from "../api/events";

/**
 * The Tauri event `document_effect::DirtyFlag` emits on every clean<->dirty
 * transition. Must stay in sync with `DIRTY_STATE_EVENT` in
 * `app/src-tauri/src/document_effect.rs`.
 */
export const BACKEND_DIRTY_STATE_EVENT = "document:dirty-changed";

/** Payload of {@link BACKEND_DIRTY_STATE_EVENT} (Rust `DirtyStatePayload`). */
export interface BackendDirtyStatePayload {
  isDirty?: boolean;
}

/**
 * Re-emit backend dirty transitions as {@link AppEvents.DIRTY_STATE_CHANGED}.
 *
 * Returns the promise of an unlisten function so a caller can tear the bridge
 * down; `bootstrapShell` installs it for the lifetime of the window and does
 * not. Resolves to `undefined` when there is no Tauri runtime (test contexts),
 * which is a no-op rather than an error: in-app mutations still re-title
 * through their own frontend events.
 */
export function bridgeDirtyStateAnnouncement(): Promise<(() => void) | undefined> {
  return listenTauriEvent<BackendDirtyStatePayload>(
    BACKEND_DIRTY_STATE_EVENT,
    (payload) => {
      emitAppEvent(AppEvents.DIRTY_STATE_CHANGED, {
        // The backend only announces real transitions, so an absent or
        // malformed payload still means "something changed" -- default to dirty
        // rather than swallow it. `updateWindowTitle()` re-reads the
        // authoritative flag anyway, so this value is a hint, not the source.
        isDirty: payload?.isDirty ?? true,
      });
    },
  ).catch(() => undefined);
}
