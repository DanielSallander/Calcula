//! FILENAME: app/extensions/ScriptableObjects/lib/consentButtonActions.ts
// PURPOSE: "Button actions" on the application approval screen (M6, phase 4 of
//          BUG-0257): every piece of the application's held inline button code,
//          listed by the hash of its exact bytes with every place it sits, and
//          -- when the code is nothing but a call of one of the application's
//          macros -- which macro a click runs.
// CONTEXT: A subscribe or refresh holds an application's static inline button
//          code, and the Rust door (`scripting::control_action`) runs it only
//          after an approval of exactly those bytes: `buttonAction:<sha256>` in
//          the application's bare record. The listing and the approvability rule
//          are @api's (`listHeldButtonActions`, `heldInlineVerdict`); this
//          module adds what the SCREEN says about each item.
//
//          THE CALL NOTE FOLLOWS THE DOOR, NOT A GUESS. The door resolves a held
//          `Name()` ONLY among the application's own modules
//          (`plan_held_inline`): one answer runs that module's stored source,
//          two answers are refused, a module that runs as an object script is
//          refused by name (owner decision Q1: link the macro instead), and no
//          answer runs the code as written. The whitespace a call may carry is
//          the door's explicit class (space, tab, CR, LF) -- not JavaScript's
//          `\s`, which also matches U+FEFF -- pinned against the fixture the
//          Rust tests read (scripting/fixtures/button_names.json).

import type { HeldButtonAction } from "@api/heldButtonCode";
import { parseModuleScriptRuntime } from "@api/workbookScripts";
import { sanitizeScriptName } from "../../_shared/lib/buttonScriptRun";
import type { PackageMacro } from "./packageConsentSet";

/** One place a button action sits, as the screen names it. */
export interface ConsentButtonActionLocation {
  /** "Dashboard!B4" */
  cell: string;
  /** What the button says; may be empty. */
  caption: string;
}

/** One button action on the approval screen. */
export interface ConsentButtonAction {
  /** `buttonAction:<sha256>` -- what Allow records. */
  id: string;
  hash: string;
  /** The exact bytes, shown verbatim. */
  source: string;
  locations: ConsentButtonActionLocation[];
  /** The application's macro a click runs, when the code is exactly a call of one. */
  runsMacro: string | null;
  /** Why a click is refused even after this approval, when the door says so up front. */
  refusedBecause: string | null;
}

/** The whitespace a `Name()` invocation may carry: space, tab, CR, LF -- the door's class. */
const CALL_SPACE = "[ \\t\\r\\n]*";
const SINGLE_CALL = new RegExp(`^${CALL_SPACE}([A-Za-z_$][A-Za-z0-9_$]*)${CALL_SPACE}\\(${CALL_SPACE}\\)${CALL_SPACE};?${CALL_SPACE}$`);

/**
 * The module name inline code INVOKES, when that is all it does -- one complete
 * zero-argument call -- exactly as `control_action::single_module_call_name`
 * reads it. Null for anything else.
 */
export function buttonCallName(code: string): string | null {
  const match = SINGLE_CALL.exec(code);
  return match ? match[1] : null;
}

/**
 * What a click on `source` does with the application's macros, by the door's
 * rule. `covered` are the macros this approval records; `unapprovable` are the
 * application's macros it cannot (their id is claimed by something else), which
 * the door still resolves a `Name()` to -- and then refuses, unapproved.
 */
export function describeButtonActionCall(
  source: string,
  covered: readonly PackageMacro[],
  unapprovable: readonly PackageMacro[],
): { runsMacro: string | null; refusedBecause: string | null } {
  const called = buttonCallName(source);
  if (called === null) return { runsMacro: null, refusedBecause: null };
  const all = [...covered, ...unapprovable];
  const candidates = all.filter((m) => sanitizeScriptName(m.name) === called);
  if (candidates.length > 1) {
    return {
      runsMacro: null,
      refusedBecause:
        `it calls ${called}(), which names ${candidates.length} of the application's macros, ` +
        "so a click cannot tell which one to run and is refused",
    };
  }
  const target = candidates[0];
  if (!target) return { runsMacro: null, refusedBecause: null };
  if (parseModuleScriptRuntime(target.description ?? null) === "objectScript") {
    return {
      runsMacro: null,
      refusedBecause:
        `it calls the macro ${target.name} by name, and ${target.name} runs as an object script, ` +
        "which a button can reach only by linking the macro (Properties > Macro) -- so a click is refused",
    };
  }
  if (!covered.some((m) => m.id === target.id)) {
    return {
      runsMacro: null,
      refusedBecause: `it runs the macro ${target.name}, which this approval cannot cover, so a click is refused`,
    };
  }
  return { runsMacro: target.name, refusedBecause: null };
}

/** One application's button actions as the screen shows them. */
export function toConsentButtonActions(
  actions: readonly HeldButtonAction[],
  covered: readonly PackageMacro[],
  unapprovable: readonly PackageMacro[],
): ConsentButtonAction[] {
  return actions.map((action) => ({
    id: action.id,
    hash: action.hash,
    source: action.source,
    locations: action.locations.map((l) => ({ cell: l.cell, caption: l.caption })),
    ...describeButtonActionCall(action.source, covered, unapprovable),
  }));
}

/** How one location reads on the screen: `Dashboard!B4 "Run report"`. */
export function describeButtonActionLocation(location: ConsentButtonActionLocation): string {
  return location.caption ? `${location.cell} "${location.caption}"` : location.cell;
}
