//! FILENAME: app/src/api/moduleScriptBackend.ts
// PURPOSE: Stable @api wrappers for the standalone module-script Tauri commands
//          (list_scripts / get_script). Like notebooks, these had no facade
//          binding, so the Code-in-This-File inspector could not enumerate
//          module scripts without reaching into backend command names directly.
// CONTEXT: Module scripts (persistence::SavedScript / runtime WorkbookScript)
//          are reusable named script modules that execute in the isolated Rust
//          QuickJS surface (grid-only, no privileged capabilities). Read-only
//          subset (list + load); authoring stays in the ScriptEditor extension.

import { invoke } from "@tauri-apps/api/core";

/** Where a module script lives: workbook-global or attached to one sheet.
 *  Internally tagged enum mirror of Rust ScriptScope (tag = "type"). */
export type ModuleScriptScope =
  | { type: "workbook" }
  | { type: "sheet"; name: string };

/** Lightweight module-script listing row. */
export interface ModuleScriptSummary {
  id: string;
  name: string;
  scope: ModuleScriptScope;
}

/** A module script with its full source. `sourcePackage` is the .calp it was
 *  distributed from (absent for local). */
export interface ModuleScriptData {
  id: string;
  name: string;
  description?: string | null;
  source: string;
  scope: ModuleScriptScope;
  sourcePackage?: string | null;
}

/** List all module scripts in the open workbook (lightweight summaries). */
export async function listModuleScripts(): Promise<ModuleScriptSummary[]> {
  return invoke<ModuleScriptSummary[]>("list_scripts");
}

/** Load a module script by id, including its source. */
export async function getModuleScript(id: string): Promise<ModuleScriptData> {
  return invoke<ModuleScriptData>("get_script", { id });
}

/** Human one-liner for where a module script resides. */
export function describeModuleScriptScope(scope: ModuleScriptScope): string {
  return scope.type === "sheet" ? `Sheet "${scope.name}"` : "Workbook-global";
}
