// FILENAME: app/extensions/ModelEditor/lib/crossWindowEvents.ts
// PURPOSE: Cross-window event bridge between the main window and the Model
//          Editor window, through the sanctioned @api/backend door (raw
//          @tauri-apps/api/event is banned in extensions).

import { emitTauriEvent, listenTauriEvent } from "@api/backend";

// ============================================================================
// Event names
// ============================================================================

/** Main -> editor: focus an already-open editor on a specific connection. */
const OPEN_WITH_CONNECTION = "model-editor:open-with-connection";
/** Editor -> main: the model changed (main recalcs CUBE + refreshes panes). */
const MODEL_CHANGED = "model-editor:model-changed";
/** Editor -> main: the editor window mounted and its listeners are live. */
const EDITOR_READY = "model-editor:editor-ready";

// ============================================================================
// Emitters
// ============================================================================

export function emitOpenWithConnection(connectionId: string | null): Promise<void> {
  return emitTauriEvent(OPEN_WITH_CONNECTION, { connectionId });
}

export function emitModelChanged(connectionId: string): Promise<void> {
  return emitTauriEvent(MODEL_CHANGED, { connectionId });
}

export function emitEditorReady(): Promise<void> {
  return emitTauriEvent(EDITOR_READY, {});
}

// ============================================================================
// Listeners (each returns an unlisten function)
// ============================================================================

export function onOpenWithConnection(
  callback: (payload: { connectionId: string | null }) => void,
): Promise<() => void> {
  return listenTauriEvent(OPEN_WITH_CONNECTION, callback);
}

export function onModelChanged(
  callback: (payload: { connectionId: string }) => void,
): Promise<() => void> {
  return listenTauriEvent(MODEL_CHANGED, callback);
}

export function onEditorReady(callback: () => void): Promise<() => void> {
  return listenTauriEvent(EDITOR_READY, callback);
}
