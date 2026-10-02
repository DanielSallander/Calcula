//! FILENAME: app/extensions/_shared/lib/buttonScriptRun.ts
// PURPOSE: The few NAME helpers the button surfaces still share on the page:
//          how a module's name becomes the identifier a button's `Name()`
//          calls, whose code a stored module is, and the one sentence for "a
//          button from an application named a macro that is not that
//          application's".
//
// WHAT USED TO LIVE HERE, AND WHERE IT IS NOW
//
// This file held THE ONE RULE for turning a button click into a program: the
// planners `planInlineButtonRun` (a button control's `onSelect`, with the
// user's own modules wrapped as callable functions and prepended) and
// `planStoredModuleRun` (a button cell's module, with its "Function to call"
// appended), the preamble builder and the module loader. The page composed the
// program and handed it to `run_script`, which lets a source no stored module
// carries through as an ad-hoc run.
//
// That was sound only while nothing an application shipped could sit on a
// button as code. Phase 4 of BUG-0257 lets an application's inline button code
// travel -- held, stamped, run only after an approval of its exact bytes -- so
// the page can no longer be what decides what a click runs. THE RULE NOW LIVES
// IN RUST, ported case for case: app/src-tauri/src/scripting/control_action.rs
// (`plan_own_inline`, `plan_held_inline`, `plan_cell_action`, behind the door
// `run_control_action`), with its tests in control_action_tests.rs and
// control_action_door_tests.rs. Every click goes through that door
// (extensions/_shared/lib/buttonClickDoor.ts). Do not re-add a planner here:
// a page that composes code is the route the door exists to close.
//
// The two defects the rule was written against still hold in Rust: a module
// that arrived in an application is NEVER composed with other code (a
// concatenated program equals no stored record, so a consent gate keyed on the
// record never saw it), and a module body is never spliced where it could close
// its wrapper early and land code at top level for an unrelated button.

import {
  isLocalOrigin,
  originPackageName,
  scriptOriginForStoredRecord,
} from "@api/scriptHost/scriptOrigin";

// ============================================================================
// The record a caller hands in
// ============================================================================

/**
 * One stored module script, as a provenance check sees it.
 *
 * `sourcePackage` is the field `core/calp/src/pull.rs` stamps on every module it
 * materializes out of a `.calp`; it is the ONLY authority on whether the code is
 * the user's or a publisher's, and it is read here through
 * `scriptOriginForStoredRecord` so this file cannot invent a second derivation.
 */
export interface ButtonScriptModule {
  id: string;
  name: string;
  /** Empty string when `loadError` is set -- never a lie about what it holds. */
  source: string;
  sourcePackage?: string | null;
  /** Why the record could not be READ, when it could not. */
  loadError?: string | null;
}

// ============================================================================
// Identifiers
// ============================================================================

/**
 * Sanitize a script module name into a valid JavaScript identifier.
 *
 * Must stay identical to the Properties Pane's copy
 * (Controls/PropertiesPane/CodePropertyInput.tsx), which is what generates the
 * `Name()` text a user's inline action contains, AND to the Rust door's
 * `sanitize_script_name` (scripting/control_action.rs), which is what resolves
 * it -- per UTF-16 code unit, so an emoji is two underscores. All three answer
 * the shared fixture (`_shared/lib/__tests__/buttonNameDrift.test.ts`).
 */
export function sanitizeScriptName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (sanitized && /^[0-9]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  return sanitized || "_unnamed";
}

// ============================================================================
// Provenance
// ============================================================================

/** True when the module arrived inside a distributed application. */
export function isDistributedModule(module: ButtonScriptModule): boolean {
  return !isLocalOrigin(
    scriptOriginForStoredRecord({ sourcePackage: module.sourcePackage ?? null }),
  );
}

/** The application a module arrived in, or null for the user's own code. */
export function moduleApplicationName(module: ButtonScriptModule): string | null {
  return originPackageName(
    scriptOriginForStoredRecord({ sourcePackage: module.sourcePackage ?? null }),
  );
}

// ============================================================================
// The one sentence
// ============================================================================

/**
 * THE ONE SENTENCE for "a button from an application named a macro that is not
 * that application's" -- the confused-deputy refusal. The macro-run seam says
 * it for a button CONTROL's held macro link (`runMacroByRef`'s
 * `requirePackage`, MacroRecorder/lib/macroLibrary.ts, phase 3 of BUG-0257);
 * the Rust door says it, byte for byte, for a button CELL
 * (`describe_macro_not_from_application`, scripting/control_action.rs --
 * drift-tested by `_shared/lib/__tests__/buttonSentenceDrift.test.ts`).
 * `owner` is the application the macro came with, or null for the user's own.
 * The remedy differs per kind of button, so the caller appends it.
 */
export function describeMacroNotFromApplication(
  fromApplication: string,
  macroName: string,
  owner: string | null,
): string {
  return (
    `This button came with the application "${fromApplication}", and the macro ` +
    `"${macroName}" it names ` +
    (owner === null ? "is one of your own" : `came with a different application, "${owner}"`) +
    `. A button from an application runs only that application's own macros, so it ` +
    "did not run."
  );
}
