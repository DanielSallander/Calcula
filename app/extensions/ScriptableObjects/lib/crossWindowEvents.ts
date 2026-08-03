//! FILENAME: app/extensions/ScriptableObjects/lib/crossWindowEvents.ts
// PURPOSE: Cross-window event bridge for the Object Script Editor.
// CONTEXT: Uses Tauri events to communicate between the main window
//          and the separate Object Script Editor window.

import { emitTauriEvent, listenTauriEvent } from "@api/backend";
import type { UnlistenFn } from "@api/backend";
import type { ObjectScriptDefinition, ScriptableObjectType } from "@api/scriptableObjects";

// ============================================================================
// Event Names
// ============================================================================

export const ObjectScriptEditorEvents = {
  /** Main -> Editor: initial script ID to open (passed when opening editor) */
  OPEN_WITH_SCRIPT: "objscript:open-with-script",
  /**
   * Main -> Editor: an AI-authored DRAFT to review. Deliberately separate from
   * OPEN_WITH_SCRIPT: that channel carries the id of a SAVED script the editor
   * resolves through `loadAllObjectScripts`, and a draft has no saved record to
   * resolve — reusing it would show "no script" instead of the code to review.
   * The whole draft travels on the wire because the editor window cannot reach
   * the backend's process-local draft store.
   */
  OPEN_WITH_DRAFT: "objscript:open-with-draft",
  /**
   * Main -> Editor: open a MODULE MACRO (`macro-<slug>`) for editing. Separate
   * from OPEN_WITH_SCRIPT for the same reason OPEN_WITH_DRAFT is: that channel
   * resolves an id through `loadAllObjectScripts` (the OBJECT-script store), and
   * a recorded macro is a MODULE script that store knows nothing about. The
   * editor fetches the authoritative record itself via `getWorkbookScript(id)`;
   * the payload carries a light preview so the tab can name it before the fetch.
   */
  OPEN_WITH_MODULE_MACRO: "objscript:open-with-module-macro",
  /** Editor -> Main: request to save, register, and mount a script */
  SAVE_AND_APPLY: "objscript:save-and-apply",
  /** Editor -> Main: request to register a new script */
  REGISTER_SCRIPT: "objscript:register-script",
  /** Editor -> Main: request to toggle access level on a script */
  TOGGLE_ACCESS: "objscript:toggle-access",
  /** Main -> Editor: console output from a running object script */
  CONSOLE_OUTPUT: "objscript:console-output",
  /** Main -> Editor: error from a running object script */
  SCRIPT_ERROR: "objscript:script-error",
  /** Main -> Editor: scripts list has changed (external update) */
  SCRIPTS_CHANGED: "objscript:scripts-changed",
  /** Editor -> Main: editor window was closed */
  EDITOR_CLOSED: "objscript:editor-closed",
  /**
   * Editor -> Main: the editor window has mounted and REGISTERED its open-event
   * listeners, so an open payload sent now will be received.
   *
   * Without this the main window could only guess when the editor was ready — it
   * emitted the open event on a fixed timer after `tauri://created`, and a cold
   * window whose React tree mounted later than the timer simply LOST the event
   * and showed an empty editor. The main window now waits for this signal (with
   * the timer only as a fallback) before delivering, so opening a macro/script in
   * a freshly-created window is deterministic rather than timing-dependent.
   */
  EDITOR_READY: "objscript:editor-ready",
} as const;

// ============================================================================
// Payloads
// ============================================================================

export interface OpenWithScriptPayload {
  scriptId?: string;
}

/**
 * One AI-authored object script awaiting human review.
 *
 * Mirrors `ScriptDraft` in `app/src-tauri/src/mcp/drafts.rs` field for field
 * (Rust snake_case -> TypeScript camelCase via the struct-level serde rename).
 * `mounted` is on the wire on purpose: the backend states the invariant rather
 * than leaving every consumer to assume it, and this side asserts it.
 */
export interface ScriptDraft {
  /** Draft id — NOT an object-script id. The editor assigns that on save. */
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  description: string | null;
  source: string;
  /** Capability ids the source declares via `// @capability` pragmas. */
  declaredCapabilities: string[];
  createdAt: string;
  /** Always false. A draft that claims otherwise is not a draft. */
  mounted: boolean;
}

export interface OpenWithDraftPayload {
  draft: ScriptDraft;
}

/**
 * One recorded macro (a MODULE script) handed to the editor to open. Only the id
 * is authoritative — the editor re-reads the record with `getWorkbookScript(id)`
 * so it always edits the live source, never a stale copy on the wire. `name`,
 * `source` and `description` are a best-effort preview for the tab while the
 * fetch is in flight (and a fallback if the record has since been deleted).
 */
export interface ModuleMacroPayload {
  /** The macro's module id (`macro-<slug>`). */
  macroId: string;
  name: string;
  source: string;
  description: string | null;
}

export interface SaveAndApplyPayload {
  script: ObjectScriptDefinition;
}

export interface RegisterScriptPayload {
  script: ObjectScriptDefinition;
}

export interface ToggleAccessPayload {
  script: ObjectScriptDefinition;
}

export interface ConsoleOutputPayload {
  scriptId: string;
  level: string;
  args: unknown[];
}

export interface ScriptErrorPayload {
  scriptId: string;
  scriptName: string;
  error: string;
  stack?: string;
}

export interface ScriptsChangedPayload {
  scripts: ObjectScriptDefinition[];
}

// ============================================================================
// Emit Functions
// ============================================================================

export async function emitOpenWithScript(scriptId?: string): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.OPEN_WITH_SCRIPT, { scriptId } satisfies OpenWithScriptPayload);
}

export async function emitOpenWithDraft(draft: ScriptDraft): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.OPEN_WITH_DRAFT, { draft } satisfies OpenWithDraftPayload);
}

export async function emitOpenWithModuleMacro(payload: ModuleMacroPayload): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.OPEN_WITH_MODULE_MACRO, payload);
}

export async function emitSaveAndApply(script: ObjectScriptDefinition): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.SAVE_AND_APPLY, { script } satisfies SaveAndApplyPayload);
}

export async function emitRegisterScript(script: ObjectScriptDefinition): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.REGISTER_SCRIPT, { script } satisfies RegisterScriptPayload);
}

export async function emitToggleAccess(script: ObjectScriptDefinition): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.TOGGLE_ACCESS, { script } satisfies ToggleAccessPayload);
}

export async function emitConsoleOutput(payload: ConsoleOutputPayload): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.CONSOLE_OUTPUT, payload);
}

export async function emitScriptError(payload: ScriptErrorPayload): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.SCRIPT_ERROR, payload);
}

export async function emitScriptsChanged(scripts: ObjectScriptDefinition[]): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.SCRIPTS_CHANGED, { scripts } satisfies ScriptsChangedPayload);
}

export async function emitEditorClosed(): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.EDITOR_CLOSED);
}

/** Editor -> Main: announce that open-event listeners are registered. */
export async function emitEditorReady(): Promise<void> {
  await emitTauriEvent(ObjectScriptEditorEvents.EDITOR_READY);
}

// ============================================================================
// Listen Functions
// ============================================================================

export function onOpenWithScript(
  callback: (payload: OpenWithScriptPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<OpenWithScriptPayload>(ObjectScriptEditorEvents.OPEN_WITH_SCRIPT, callback);
}

export function onOpenWithDraft(
  callback: (payload: OpenWithDraftPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<OpenWithDraftPayload>(ObjectScriptEditorEvents.OPEN_WITH_DRAFT, callback);
}

export function onOpenWithModuleMacro(
  callback: (payload: ModuleMacroPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<ModuleMacroPayload>(
    ObjectScriptEditorEvents.OPEN_WITH_MODULE_MACRO,
    callback,
  );
}

export function onSaveAndApply(
  callback: (payload: SaveAndApplyPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<SaveAndApplyPayload>(ObjectScriptEditorEvents.SAVE_AND_APPLY, callback);
}

export function onRegisterScript(
  callback: (payload: RegisterScriptPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<RegisterScriptPayload>(ObjectScriptEditorEvents.REGISTER_SCRIPT, callback);
}

export function onToggleAccess(
  callback: (payload: ToggleAccessPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<ToggleAccessPayload>(ObjectScriptEditorEvents.TOGGLE_ACCESS, callback);
}

export function onConsoleOutput(
  callback: (payload: ConsoleOutputPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<ConsoleOutputPayload>(ObjectScriptEditorEvents.CONSOLE_OUTPUT, callback);
}

export function onScriptError(
  callback: (payload: ScriptErrorPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<ScriptErrorPayload>(ObjectScriptEditorEvents.SCRIPT_ERROR, callback);
}

export function onScriptsChanged(
  callback: (payload: ScriptsChangedPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<ScriptsChangedPayload>(ObjectScriptEditorEvents.SCRIPTS_CHANGED, callback);
}

export function onEditorClosed(
  callback: () => void,
): Promise<UnlistenFn> {
  return listenTauriEvent(ObjectScriptEditorEvents.EDITOR_CLOSED, callback);
}

/** Main: listen for the editor announcing its listeners are registered. */
export function onEditorReady(callback: () => void): Promise<UnlistenFn> {
  return listenTauriEvent(ObjectScriptEditorEvents.EDITOR_READY, callback);
}
