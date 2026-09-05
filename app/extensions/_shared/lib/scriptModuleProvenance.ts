//! FILENAME: app/extensions/_shared/lib/scriptModuleProvenance.ts
// PURPOSE: What a PICKER says about where a stored script module came from —
//          shared by every surface that lets a user bind a control to a module
//          (the `calcula.button` action dialog, the Properties Pane's script
//          select, and the OnSelect autocomplete).
//
// WHY THIS FILE EXISTS
//
// `ScriptSummary` carries `sourcePackage` precisely so that pickers can tell a
// publisher's module from the user's own (app/src/api/workbookScripts.ts). The
// pickers dropped it on the floor: every option rendered `{s.name}` and nothing
// else, so
//
//   * nothing on the dialog said the button would run code a publisher wrote;
//   * two modules named "Report" from two applications were two identical
//     options, distinguishable only by clicking each and seeing what ran;
//   * "Function to call" was offered for a distributed module even though
//     `planStoredModuleRun` (buttonScriptRun.ts) REFUSES that composition at
//     click time — the user learned of the refusal only when the button did
//     nothing.
//
// The Macro Library already sets the standard (MacroRecorder's
// `macroProvenanceTag` / `describeMacroProvenance`): a provenance tag on the row
// and a sentence naming the guarantee before any action is offered. Those
// helpers live inside the MacroRecorder extension, which a sibling extension
// may not import, so the picker-facing equivalents live here. They are NOT a
// second derivation of provenance: every answer goes through
// `scriptOriginForStoredRecord`, the one reading of the `sourcePackage` stamp
// that the run planners and the Rust consent gate agree on.

import {
  isLocalOrigin,
  originPackageName,
  scriptOriginForStoredRecord,
} from "@api/scriptHost/scriptOrigin";

/**
 * The fields a picker row needs. A `ScriptSummary` satisfies it directly; the
 * Properties Pane's narrowed `{ id, name }` rows must be widened to carry the
 * stamp through — a row without it is presented as the user's own code.
 */
export interface ScriptPickerEntry {
  id: string;
  name: string;
  /** The `.calp` application the module arrived in; absent/null for local. */
  sourcePackage?: string | null;
}

/** The application a picker entry arrived in, or null for the user's own code. */
export function scriptEntryApplication(entry: ScriptPickerEntry): string | null {
  const origin = scriptOriginForStoredRecord({ sourcePackage: entry.sourcePackage ?? null });
  return isLocalOrigin(origin) ? null : originPackageName(origin);
}

/** True when the entry's module arrived inside a distributed application. */
export function isDistributedScriptEntry(entry: ScriptPickerEntry): boolean {
  return scriptEntryApplication(entry) !== null;
}

/**
 * The option text for a picker row: the module's name, and for a distributed
 * module the application it came from — so two "Report"s from two applications
 * read as two different things, and a publisher's module is never listed as if
 * the user wrote it.
 */
export function scriptPickerLabel(entry: ScriptPickerEntry): string {
  const app = scriptEntryApplication(entry);
  return app === null ? entry.name : `${entry.name} — from application "${app}"`;
}

/**
 * The one-line note shown once a DISTRIBUTED module is the chosen one. Null for
 * the user's own code, which needs no note (local is the baseline).
 *
 * It names the route's actual guarantee, not a generic one: the module runs as
 * its stored source, unchanged (`planStoredModuleRun` runs the record verbatim
 * and refuses any composition), and only after the user has approved the
 * application — `require_distributed_module_consent`
 * (app/src-tauri/src/scripting/commands.rs) refuses it otherwise.
 */
export function describeDistributedScriptChoice(entry: ScriptPickerEntry): string | null {
  const app = scriptEntryApplication(entry);
  if (app === null) return null;
  return (
    `"${entry.name}" was published by the application "${app}" — you did not ` +
    "write it. It will run exactly as published, never edited or combined with " +
    "other code, and only if you have approved that application."
  );
}

/**
 * Why the "Function to call" field is withheld for a distributed module, in
 * the words of the refusal the run planner would otherwise hand back at click
 * time. Null for the user's own code, where the field is offered as before.
 */
export function describeWithheldFunctionField(entry: ScriptPickerEntry): string | null {
  const app = scriptEntryApplication(entry);
  if (app === null) return null;
  return (
    `Function to call is not available for a module from the application "${app}": ` +
    "appending a call to published code would run code you have not approved, " +
    "so the module runs as published instead."
  );
}

/**
 * The description line for an autocomplete suggestion that inserts `Name()`.
 * For a distributed module it says whose code the call runs and on what terms;
 * for the user's own it is the plain "run this module" line.
 */
export function describeScriptSuggestion(entry: ScriptPickerEntry): string {
  const app = scriptEntryApplication(entry);
  if (app === null) return `Run script module "${entry.name}"`;
  return (
    `Run script module "${entry.name}" from the application "${app}" — ` +
    "exactly as published, and only if you have approved that application"
  );
}
