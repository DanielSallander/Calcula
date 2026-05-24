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
} as const;

// ============================================================================
// Payloads
// ============================================================================

export interface OpenWithScriptPayload {
  scriptId?: string;
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

// ============================================================================
// Listen Functions
// ============================================================================

export function onOpenWithScript(
  callback: (payload: OpenWithScriptPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<OpenWithScriptPayload>(ObjectScriptEditorEvents.OPEN_WITH_SCRIPT, callback);
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
