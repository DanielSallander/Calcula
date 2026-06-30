//! FILENAME: app/src/api/scriptSecurity.ts
// PURPOSE: Shared frontend gate for the global "Script Security" setting.
// CONTEXT: The setting (disabled/prompt/enabled) governs ALL user-authored code
//   execution, across THREE enforcement points:
//   1. run_script / notebook / MCP: gate in Rust via a backend sentinel error.
//   2. Workbook-embedded Worker surfaces (object scripts, custom chart marks,
//      custom chart transforms, JS UDF libraries): gate at `assertMountAllowed`
//      (`@api/scriptHost/mountGate`), called by `hostMountScript` BEFORE spawning
//      any worker — "disabled" stops every mount, "prompt" asks once per session
//      (the grant is cached and shared across surfaces). Object scripts ALSO gate
//      earlier at their own layer (a load-time batch gate +
//      `ObjectScriptManager.mountScript`) for an object-specific prompt + a soft,
//      no-error refusal; the host gate is the shared floor behind them.
//   3. Distributed (installed) 3rd-party extensions, which run in their own Worker
//      realm: gate at `ExtensionManager.loadExtension` — "disabled" blocks + lists
//      them; "prompt"/"enabled" defer to each extension's own trust + per-extension
//      consent. So "disabled" is a true lockdown: NO custom code runs anywhere.
//   This helper lets any surface gate quietly BEFORE mounting/executing, via the
//   non-throwing `script_execution_status` command. Lives in @api so multiple
//   extensions (ScriptableObjects, ...) and the shell share one gate (Independence
//   Through Boundaries).

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
