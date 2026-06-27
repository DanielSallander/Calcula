//! FILENAME: app/src/api/workbookScripts.ts
// PURPOSE: Public contract for listing the workbook's saved script modules.
// CONTEXT: Lets extensions (e.g. Controls, which links shapes to scripts)
//   discover scripts without importing the ScriptEditor extension's internals.

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

/** List all saved workbook script modules (id + name only). */
export async function listWorkbookScripts(): Promise<ScriptSummary[]> {
  return invokeBackend<ScriptSummary[]>("list_scripts");
}
