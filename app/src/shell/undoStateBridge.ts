//! FILENAME: app/src/shell/undoStateBridge.ts
// PURPOSE: Bridge the backend's undo/redo AVAILABILITY announcement onto the
// @api event bus, so the Undo and Redo affordances can be greyed out the way
// Excel greys them.
//
// THE DEFECT THIS CLOSES
// ----------------------
// The Home tab rendered `undo`/`redo` as plain buttons with no binding to
// `get_undo_state`, and the Edit menu items carried no enablement. Nothing in
// `app/src` or `app/extensions` read `canUndo` for a UI state at all
// (measured 2026-08-10, register §3ax(1)), so the app permanently invited the
// user to press an Undo it might not have — on a freshly opened workbook the
// press is simply swallowed, with no signal that nothing could have happened.
//
// WHY THE BACKEND SIDE IS ONE EVENT AND NOT ~100
// ----------------------------------------------
// The emitter is `undo_history::UndoHistory`, which announces from inside the
// store's own lock guard when `(can_undo, can_redo)` actually MOVES. There are
// about a hundred `undo_stack.lock()` sites across thirty files and every one
// of them can change availability; asking each to remember an emit is the
// failure mode the dirty-flag census exists to end. Same shape as
// `dirtyStateBridge.ts` and the `bi:model-changed` bridge: one backend emitter,
// one bridge, so subscribers see each transition once.
//
// WHY NOT JUST SUBSCRIBE TO THE DIRTY FLAG
// ----------------------------------------
// Because the two states are not in step, in both directions:
//   * undo back to depth 0 leaves the document dirty, so the NEXT edit moves
//     `canUndo` false -> true with no dirty transition to ride on;
//   * an edit after an undo clears the redo stack (`canRedo` true -> false)
//     while the document was already dirty and stays dirty.
// Either one leaves a ribbon button lying about what pressing it will do.
//
// THE PAYLOAD IS FORWARDED, and that is a deliberate difference from
// `sheetDisplayFlagsBridge.ts`, which carries none. There the payload would
// have been a partial copy of a four-flag authority that a subscriber could act
// on after it went stale. Here the payload IS the whole authority — two
// booleans, both produced by the transition being announced — and the consumer
// (`@api/undoState`) still seeds itself from `getUndoState()` on first
// subscription, so a listener that mounts between transitions starts correct
// rather than guessing.

import { listenTauriEvent } from "../api/backend";
import { emitAppEvent, AppEvents } from "../api/events";

/**
 * The Tauri event `undo_history::UndoHistory` emits on every availability
 * transition. Must stay in sync with `UNDO_STATE_EVENT` in
 * `app/src-tauri/src/undo_history.rs`.
 */
export const BACKEND_UNDO_STATE_EVENT = "document:undo-state-changed";

/** Payload of {@link BACKEND_UNDO_STATE_EVENT} (Rust `UndoAvailability`). */
export interface BackendUndoStatePayload {
  canUndo?: boolean;
  canRedo?: boolean;
}

/**
 * Re-emit backend undo-availability transitions as
 * {@link AppEvents.UNDO_STATE_CHANGED}.
 *
 * Returns the promise of an unlisten function so a caller can tear the bridge
 * down; `bootstrapShell` installs it for the lifetime of the window and does
 * not. Resolves to `undefined` when there is no Tauri runtime (test contexts),
 * which is a no-op rather than an error.
 *
 * A malformed payload FAILS SAFE — `true` on both — rather than being dropped
 * or defaulted to `false`. A wrongly-enabled button costs the user a press that
 * does nothing, which is exactly today's behaviour; a wrongly-disabled one
 * takes away an undo they really have, and there is no way for them to argue
 * with it.
 */
export function bridgeUndoStateAnnouncement(): Promise<(() => void) | undefined> {
  return listenTauriEvent<BackendUndoStatePayload>(
    BACKEND_UNDO_STATE_EVENT,
    (payload) => {
      emitAppEvent(AppEvents.UNDO_STATE_CHANGED, {
        canUndo: payload?.canUndo ?? true,
        canRedo: payload?.canRedo ?? true,
      });
    },
  ).catch(() => undefined);
}
