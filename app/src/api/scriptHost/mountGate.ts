//! FILENAME: app/src/api/scriptHost/mountGate.ts
// PURPOSE: The universal Script-Security gate for the worker-realm mount chokepoint.
// CONTEXT: The WORKBOOK-EMBEDDED worker-realm surfaces all mount through
//   hostMountScript (host.ts) — object scripts (buttons/shapes/slicers/…), custom
//   chart marks, custom chart transforms, and JS UDF libraries. This module is the
//   enforcement point that makes the global "Script Security" setting
//   (disabled/prompt/enabled) govern them: hostMountScript calls assertMountAllowed
//   BEFORE spawning any worker, so "disabled" blocks every such mount and "prompt"
//   asks once per session (the grant is cached by grantScriptSessionApproval, so N
//   marks in one install batch yield one confirm). Extracted into its own light
//   module (depends only on @api/scriptSecurity) so the gate decision is
//   unit-testable without host.ts's heavy worker/render/broker import graph.
//   NOTE: distributed (installed) 3rd-party EXTENSIONS run in a SEPARATE worker
//   realm (extensionWorkerHost) and are gated by the same setting at their own
//   chokepoint — ExtensionManager.loadExtension ("disabled" blocks them too;
//   "prompt"/"enabled" defer to each extension's per-extension consent). Together
//   the two chokepoints make "disabled" a true lockdown over ALL worker-realm code.
//   See docs/design/wave3-scripting-security.md.

import { ensureScriptsAllowed } from "../scriptSecurity";

/** Thrown by hostMountScript when the Script Security setting blocks a mount. */
export class ScriptSecurityBlockedError extends Error {
  constructor(scriptName: string) {
    super(`Script "${scriptName}" was blocked by the Script Security setting.`);
    this.name = "ScriptSecurityBlockedError";
  }
}

/**
 * Gate a worker-realm mount on the global Script Security setting. Resolves if the
 * mount may proceed ("enabled", or "prompt" with a session grant); throws
 * ScriptSecurityBlockedError if it must not ("disabled", or "prompt" declined) —
 * thrown BEFORE any worker is spawned. Callers degrade gracefully on the throw:
 * custom chart marks/transforms roll back to the previously-installed library (a
 * referencing chart falls back to its built-in painter), and a blocked UDF library
 * simply isn't registered, so =MYFUNC() resolves to #NAME?. Object scripts gate
 * earlier (at their own load/mount layer) and so reach here already allowed.
 */
export async function assertMountAllowed(scriptName: string): Promise<void> {
  const allowed = await ensureScriptsAllowed(
    `Allow custom code "${scriptName}" to run? It can read and change workbook data.`,
  );
  if (!allowed) throw new ScriptSecurityBlockedError(scriptName);
}
