// FILENAME: app/extensions/Distribution/lib/inspectorWindowEvents.ts
// PURPOSE: Cross-window event bridge between the main window and the Package
//          Inspector window, through the sanctioned @api/backend door (raw
//          @tauri-apps/api/event is banned in extensions).

import { emitTauriEvent, listenTauriEvent } from "@api/backend";

// ============================================================================
// Event names
// ============================================================================

/** Main -> inspector: open/focus a specific package (fields may be empty). */
const OPEN_PACKAGE = "package-inspector:open-package";
/** Inspector -> main: the window mounted and its listeners are live. */
const INSPECTOR_READY = "package-inspector:inspector-ready";

/** The handover payload; empty fields mean "just open the window". */
export interface InspectorOpenPayload {
  registryPath: string;
  packageName: string;
  versionPin: string;
}

// ============================================================================
// Emitters
// ============================================================================

export function emitOpenPackage(payload: InspectorOpenPayload | null): Promise<void> {
  return emitTauriEvent(OPEN_PACKAGE, payload ?? { registryPath: "", packageName: "", versionPin: "" });
}

export function emitInspectorReady(): Promise<void> {
  return emitTauriEvent(INSPECTOR_READY, {});
}

// ============================================================================
// Listeners (each returns an unlisten function)
// ============================================================================

export function onOpenPackage(
  callback: (payload: InspectorOpenPayload) => void,
): Promise<() => void> {
  return listenTauriEvent(OPEN_PACKAGE, callback);
}

export function onInspectorReady(callback: () => void): Promise<() => void> {
  return listenTauriEvent(INSPECTOR_READY, callback);
}
