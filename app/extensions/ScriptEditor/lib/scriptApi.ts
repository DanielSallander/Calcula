//! FILENAME: app/extensions/ScriptEditor/lib/scriptApi.ts
// PURPOSE: TypeScript bindings for the Tauri script engine commands.
// CONTEXT: Uses the API facade (src/api/backend.ts) for sandboxed backend access.

import { invokeBackend } from "@api/backend";
import type {
  RunScriptRequest,
  RunScriptResponse,
  ScriptSummary,
  WorkbookScript,
} from "../types";

// ============================================================================
// Script Execution
// ============================================================================

/**
 * Execute a JavaScript source string against the current spreadsheet data.
 * The script runs in an isolated QuickJS runtime with access to the Calcula API.
 *
 * @param source - The script source code
 * @param filename - Display name for error messages (defaults to "script.js")
 * @returns The execution result (success with output, or error with message)
 */
export async function runScript(
  source: string,
  filename: string = "script.js",
): Promise<RunScriptResponse> {
  const request: RunScriptRequest = { source, filename };
  return invokeBackend<RunScriptResponse>("run_script", { request });
}

// ============================================================================
// Security Settings
// ============================================================================

/**
 * Get the current script security level.
 * @returns "disabled" | "prompt" | "enabled"
 */
export async function getScriptSecurityLevel(): Promise<string> {
  return invokeBackend<string>("get_script_security_level");
}

/**
 * Set the script security level.
 * @param level - "disabled" | "prompt" | "enabled"
 */
export async function setScriptSecurityLevel(level: string): Promise<void> {
  return invokeBackend<void>("set_script_security_level", { level });
}

// ============================================================================
// Script Module CRUD
// ============================================================================

/** List all saved script modules (id + name only). */
export async function listScripts(): Promise<ScriptSummary[]> {
  return invokeBackend<ScriptSummary[]>("list_scripts");
}

/** Get a single script module by ID (includes source code). */
export async function getScript(id: string): Promise<WorkbookScript> {
  return invokeBackend<WorkbookScript>("get_script", { id });
}

/** Save (create or update) a script module. */
export async function saveScript(script: WorkbookScript): Promise<void> {
  return invokeBackend<void>("save_script", { script });
}

/** Delete a script module by ID. */
export async function deleteScript(id: string): Promise<void> {
  return invokeBackend<void>("delete_script", { id });
}

/** Rename a script module. */
export async function renameScript(
  id: string,
  newName: string,
): Promise<void> {
  return invokeBackend<void>("rename_script", { id, newName });
}
