// FILENAME: app/extensions/Distribution/lib/inspectorWindowEvents.ts
// PURPOSE: Cross-window event bridge between the main window and the Application
//          Inspector window, through the sanctioned @api/backend door (raw
//          @tauri-apps/api/event is banned in extensions).
// NOTE:     The wire names below still spell the window "package-inspector".
//           That string is a runtime identifier matched by
//           app/src-tauri/capabilities/package-inspector.json, so it is
//           deliberately left at its historical spelling.

import { emitTauriEvent, listenTauriEvent } from "@api/backend";

// ============================================================================
// Event names
// ============================================================================

/** Main -> inspector: open/focus a specific application (fields may be empty). */
const OPEN_PACKAGE = "package-inspector:open-package";
/** Inspector -> main: the window mounted and its listeners are live. */
const INSPECTOR_READY = "package-inspector:inspector-ready";
/**
 * The form-preview pair, exported because BOTH windows and the tests address
 * these channels by name (the same shape as `FormPreviewEvents` in
 * ScriptableObjects/lib/formPreviewBridge.ts).
 */
export const InspectorFormPreviewEvents = {
  /** Inspector -> main: run this application's form layout and paint it THERE. */
  REQUEST: "package-inspector:form-preview-request",
  /** Main -> inspector: what became of that request. */
  RESULT: "package-inspector:form-preview-result",
} as const;
const FORM_PREVIEW_REQUEST = InspectorFormPreviewEvents.REQUEST;
const FORM_PREVIEW_RESULT = InspectorFormPreviewEvents.RESULT;

/** The handover payload; empty fields mean "just open the window". */
export interface InspectorOpenPayload {
  registryPath: string;
  packageName: string;
  versionPin: string;
}

// ----------------------------------------------------------------------------
// Form preview (see lib/inspectorFormPreview.ts for who listens to what)
// ----------------------------------------------------------------------------

/**
 * WHY THIS CROSSES WINDOWS AT ALL. The Application Inspector is its own Tauri
 * window (`app/src/packageInspectorMain.tsx`, label "package-inspector") and
 * mounts NO Shell, so no extension is activated in it and nothing there listens
 * for `SCRIPT_FORM_REQUEST_EVENT`. A `previewFormLayout` called from inside the
 * inspector emitted a request no renderer could ever hear: nothing painted, no
 * "shown" ack came back, and the show died ten seconds later on its ack
 * timeout. The CALL has to happen where the renderer is, so only the ASK
 * crosses.
 */
export interface InspectorFormPreviewRequest {
  /** Correlates the reply; a result for a superseded ask is ignored. */
  requestId: string;
  /** The inspected application — also the preview's identity band. */
  packageName: string;
  /** The script's id within that application (part of the preview identity). */
  scriptId: string;
  scriptName: string;
  /** The emitted JavaScript exactly as the inspector read it from the .calp. */
  source: string;
}

export type InspectorFormPreviewOutcome =
  /** The dialog is up in the MAIN window. */
  | "shown"
  /** It closed there (Close, Escape, X, backdrop, a reset). */
  | "closed"
  /** Setup ran but never called `form.define`. */
  | "noLayout"
  /** The preview rung could draw no conclusion. */
  | "declined"
  /** The registry refused to open it (the shared modal slot, a mute). */
  | "refused"
  /** The run itself threw. */
  | "error";

export interface InspectorFormPreviewResult {
  requestId: string;
  packageName: string;
  scriptId: string;
  /** True only for "shown". Kept explicit so a reader never infers it. */
  shown: boolean;
  outcome: InspectorFormPreviewOutcome;
  /** The line the inspector renders. Empty only for "closed". */
  reason: string;
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

export function emitInspectorFormPreviewRequest(
  payload: InspectorFormPreviewRequest,
): Promise<void> {
  return emitTauriEvent(FORM_PREVIEW_REQUEST, payload);
}

export function emitInspectorFormPreviewResult(
  payload: InspectorFormPreviewResult,
): Promise<void> {
  return emitTauriEvent(FORM_PREVIEW_RESULT, payload);
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

export function onInspectorFormPreviewRequest(
  callback: (payload: InspectorFormPreviewRequest) => void,
): Promise<() => void> {
  return listenTauriEvent<InspectorFormPreviewRequest>(FORM_PREVIEW_REQUEST, callback);
}

export function onInspectorFormPreviewResult(
  callback: (payload: InspectorFormPreviewResult) => void,
): Promise<() => void> {
  return listenTauriEvent<InspectorFormPreviewResult>(FORM_PREVIEW_RESULT, callback);
}

