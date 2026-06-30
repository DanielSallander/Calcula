//! FILENAME: app/src/api/workbookScripts.ts
// PURPOSE: Public contract for the workbook script RUNTIME — listing, reading, and
//   running saved script modules.
// CONTEXT: Lets extensions (e.g. Controls, which runs scripts from button OnSelect)
//   use the script runtime WITHOUT importing the ScriptEditor extension's internals
//   (which route through a per-window channel only bound inside that extension /
//   the standalone editor window). These go straight through the gated backend door,
//   so they work in the main window regardless of which extensions are active.

import { invokeBackend } from "./backend";

/** Scope of a script: workbook-level or attached to a specific sheet. */
export type ScriptScope =
  | { type: "workbook" }
  | { type: "sheet"; name: string };

/** Lightweight script summary (id + name, no source). */
export interface ScriptSummary {
  id: string;
  name: string;
  scope?: ScriptScope;
}

/** A saved script module, including its source. */
export interface WorkbookScript {
  id: string;
  name: string;
  source: string;
  scope?: ScriptScope;
}

/** Successful script run. */
export interface ScriptRunSuccess {
  type: "success";
  output: string[];
  cellsModified: number;
  durationMs: number;
  /** Application.screenUpdating value at end of script. */
  screenUpdating?: boolean;
}

/** Failed script run. */
export interface ScriptRunError {
  type: "error";
  message: string;
  output: string[];
}

export type ScriptRunResult = ScriptRunSuccess | ScriptRunError;

/** List all saved workbook script modules (id + name only). */
export async function listWorkbookScripts(): Promise<ScriptSummary[]> {
  return invokeBackend<ScriptSummary[]>("list_scripts");
}

/** Get a single saved script module by id, including its source. */
export async function getWorkbookScript(id: string): Promise<WorkbookScript> {
  return invokeBackend<WorkbookScript>("get_script", { id });
}

/**
 * Handle the Script Security gate around a script run. When the level is "prompt"
 * the backend refuses with a SCRIPT_PROMPT_REQUIRED sentinel until the user
 * approves once for the session; this confirms, grants the session approval, and
 * retries. (Mirrors the ScriptEditor helper, but on the gated @api door.)
 */
async function withScriptSecurityPrompt<T>(run: () => Promise<T>): Promise<T> {
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
        await invokeBackend<void>("grant_script_session_approval");
        return run();
      }
    }
    throw err;
  }
}

/**
 * Run a JavaScript source string in the isolated QuickJS script runtime against
 * the current workbook. Honors the Script Security level (refuses when "disabled",
 * confirms once per session when "prompt").
 */
export async function runWorkbookScript(
  source: string,
  filename: string = "script.js",
): Promise<ScriptRunResult> {
  return withScriptSecurityPrompt(() =>
    invokeBackend<ScriptRunResult>("run_script", { request: { source, filename } }),
  );
}
