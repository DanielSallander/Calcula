//! FILENAME: app/extensions/ScriptEditor/lib/scriptApi.ts
// PURPOSE: TypeScript bindings for the Tauri script engine commands.
// CONTEXT: Uses the API facade (src/api/backend.ts) for sandboxed backend access.

import { invokeBackend } from "../../../src/api/backend";
import type { RunScriptRequest, RunScriptResponse } from "../types";

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
