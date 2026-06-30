//! FILENAME: app/src/api/scriptSecurity.ts
// PURPOSE: Shared frontend gate for the global "Script Security" setting.
// CONTEXT: The setting (disabled/prompt/enabled) governs ALL user-authored
//   script execution. The run_script / notebook paths gate via a backend
//   sentinel error; the OBJECT-SCRIPT surface (buttons, shapes, slicers, ...)
//   gates here instead, at its single mount chokepoint
//   `ObjectScriptManager.mountScript`. EVERY object-script mount path funnels
//   through that chokepoint — workbook open, cross-window save-and-apply, the
//   manual toggle in the Object Scripts pane, code-editor remount, and
//   component/shape template stamping — so a "disabled" setting now stops them
//   all and "prompt" asks once per session before any object script runs.
//   This helper lets any surface gate quietly BEFORE mounting/executing, via the
//   non-throwing `script_execution_status` command. Lives in @api so multiple
//   extensions (ScriptableObjects, ...) share one gate (Independence Through
//   Boundaries).

import { invokeBackend } from "./backend";

export type ScriptExecutionStatus = "allowed" | "disabled" | "needsApproval";

/** The current script-execution gate state. */
export async function getScriptExecutionStatus(): Promise<ScriptExecutionStatus> {
  return invokeBackend<ScriptExecutionStatus>("script_execution_status");
}

/** Grant once-per-session script execution approval (after the user confirms). */
export async function grantScriptSessionApproval(): Promise<void> {
  await invokeBackend<void>("grant_script_session_approval");
}

/**
 * Ensure user scripts may run, honoring the Script Security setting BEFORE
 * mounting/executing. Returns true if allowed.
 *  - "enabled" (or an already-granted "prompt"): true, no UI.
 *  - "disabled": false, no UI.
 *  - "prompt" (not yet granted): ask once; grant + true on confirm, else false.
 *
 * @param promptMessage - shown when confirmation is needed.
 */
export async function ensureScriptsAllowed(promptMessage: string): Promise<boolean> {
  const status = await getScriptExecutionStatus();
  if (status === "allowed") return true;
  if (status === "disabled") return false;
  const ok = window.confirm(
    `${promptMessage}\n\n(Script Security is set to 'prompt'. Set it to 'enabled' or ` +
      `'disabled' in Settings to stop asking.)`,
  );
  if (ok) {
    await grantScriptSessionApproval();
    return true;
  }
  return false;
}
