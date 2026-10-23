//! FILENAME: app/src/api/macroModules.ts
// PURPOSE: Create a macro module the user can run: `createStarterMacro` stores
//          the worked example (`buildMacroStarterSource`) under the first free
//          `MacroN` name -- or a name the caller chose, made unique -- and
//          returns its identity so the caller can open it.
// CONTEXT: 2026-10-22, Developer > New Macro. Creation lives in @api and not in
//          an extension because three doors reach it and no two of them may
//          import each other: the Macro Recorder's menu command and its Macros
//          dialog (main window), and the Object Script Editor's welcome panel
//          and "+ Add Script... > Macro" (the editor's OWN Tauri window, which
//          has no extension host at all -- it can reach the backend and @api,
//          nothing else). The Facade Rule forbids MacroRecorder importing
//          ScriptableObjects and vice versa, so the one thing both need sits on
//          the shared side of the fence. It is a pure backend write over the
//          existing store wrappers: `saveWorkbookScript` announces
//          `workbook:module-scripts-changed` to every window and marks the file
//          modified, so the Macros dialog, the editor's module list and the
//          title-bar asterisk all follow without this module knowing them.
//
//          The record carries NO `sourcePackage`: it is the user's own code,
//          and a value there would make it read as distributed -- read-only in
//          the Macros dialog and subject to the application code gate.

import { listWorkbookScripts, saveWorkbookScript } from "./workbookScripts";
import {
  buildStarterMacroDescription,
  macroScriptId,
  nextDefaultMacroName,
  uniqueMacroName,
} from "./macroNaming";
import { buildMacroStarterSource, macroStarterFunctionName } from "./scriptHost/macroStarter";

/** What `createStarterMacro` made: enough to list it, open it and run it. */
export interface CreatedStarterMacro {
  /** The module id (`macro-<slug>`), the handle every seam takes. */
  id: string;
  /** The name as the Macros dialog lists it. */
  name: string;
  /** The starter's work function -- what Run (F5) in the editor starts. */
  functionName: string;
}

/**
 * Store a new macro from the worked example and return its identity.
 *
 * Without a name the macro is called `Macro1`, `Macro2`, ... -- the first in
 * Excel's series whose name AND id are both free. With one, the name is kept
 * when free and suffixed `(2)`, `(3)`, ... otherwise, exactly as the recorder
 * names a recording. The save is the ONLY side effect and it comes first, so a
 * failure leaves nothing half-made; the caller decides what to open or show.
 */
export async function createStarterMacro(
  options?: { name?: string },
): Promise<CreatedStarterMacro> {
  const existing = await listWorkbookScripts();
  const names = existing.map((s) => s.name);
  const ids = existing.map((s) => s.id);
  const requested = options?.name?.trim();
  const name = requested ? uniqueMacroName(requested, names) : nextDefaultMacroName(names, ids);
  const id = macroScriptId(name, ids);
  await saveWorkbookScript({
    id,
    name,
    description: buildStarterMacroDescription(new Date().toISOString()),
    source: buildMacroStarterSource(name),
    scope: { type: "workbook" },
    // `sourcePackage` deliberately absent: this is the user's own code.
  });
  return { id, name, functionName: macroStarterFunctionName(name) };
}
