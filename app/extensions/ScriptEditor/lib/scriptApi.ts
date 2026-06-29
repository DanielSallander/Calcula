//! FILENAME: app/extensions/ScriptEditor/lib/scriptApi.ts
// PURPOSE: TypeScript bindings for the Tauri script engine commands.
// CONTEXT: Uses the API facade (src/api/backend.ts) for sandboxed backend access.

import { scriptEditorBackend } from "./scriptEditorBackend";
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
 * Handle the security-level gate around a script execution call.
 * When the level is "prompt", the backend refuses with a sentinel error until
 * the user approves script execution once for the session; this helper shows
 * the confirmation, grants the session approval, and retries.
 */
export async function withScriptSecurityPrompt<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SCRIPT_PROMPT_REQUIRED")) {
      const ok = window.confirm(
        "This workbook wants to run a script.\n\n" +
        "Allow script execution for this session?\n" +
        "(Script Security is set to 'prompt'. Set it to 'enabled' or 'disabled' to stop asking.)",
      );
      if (ok) {
        await scriptEditorBackend.invoke<void>("grant_script_session_approval");
        return run();
      }
    }
    throw err;
  }
}

/**
 * Execute a JavaScript source string against the current spreadsheet data.
 * The script runs in an isolated QuickJS runtime with access to the Calcula API.
 * Honors the Script Security level: refuses when "disabled", confirms once
 * per session when "prompt".
 *
 * @param source - The script source code
 * @param filename - Display name for error messages (defaults to "script.js")
 * @returns The execution result (success with output, or error with message)
 */
export async function runScript(
  source: string,
  filename: string = "script.js",
  cellBookmarksJson?: string,
  viewBookmarksJson?: string,
): Promise<RunScriptResponse> {
  const request: RunScriptRequest & {
    cellBookmarksJson?: string;
    viewBookmarksJson?: string;
  } = {
    source,
    filename,
    cellBookmarksJson,
    viewBookmarksJson,
  };
  return withScriptSecurityPrompt(() =>
    scriptEditorBackend.invoke<RunScriptResponse>("run_script", { request }),
  );
}

// ============================================================================
// Security Settings
// ============================================================================

/**
 * Get the current script security level.
 * @returns "disabled" | "prompt" | "enabled"
 */
export async function getScriptSecurityLevel(): Promise<string> {
  return scriptEditorBackend.invoke<string>("get_script_security_level");
}

/**
 * Set the script security level.
 * @param level - "disabled" | "prompt" | "enabled"
 */
export async function setScriptSecurityLevel(level: string): Promise<void> {
  return scriptEditorBackend.invoke<void>("set_script_security_level", { level });
}

// ============================================================================
// Script Module CRUD
// ============================================================================

/** List all saved script modules (id + name only). */
export async function listScripts(): Promise<ScriptSummary[]> {
  return scriptEditorBackend.invoke<ScriptSummary[]>("list_scripts");
}

/** Get a single script module by ID (includes source code). */
export async function getScript(id: string): Promise<WorkbookScript> {
  return scriptEditorBackend.invoke<WorkbookScript>("get_script", { id });
}

/** Save (create or update) a script module. */
export async function saveScript(script: WorkbookScript): Promise<void> {
  return scriptEditorBackend.invoke<void>("save_script", { script });
}

/** Delete a script module by ID. */
export async function deleteScript(id: string): Promise<void> {
  return scriptEditorBackend.invoke<void>("delete_script", { id });
}

/** Rename a script module. */
export async function renameScript(
  id: string,
  newName: string,
): Promise<void> {
  return scriptEditorBackend.invoke<void>("rename_script", { id, newName });
}
