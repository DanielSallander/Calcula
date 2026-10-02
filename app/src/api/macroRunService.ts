//! FILENAME: app/src/api/macroRunService.ts
// PURPOSE: The feature-neutral seam through which any extension can RUN a
//          recorded macro by its module id, without knowing the Macro Recorder
//          exists or how a macro is stored and executed.
// CONTEXT: Inversion of Control, the same shape buttonControlService.ts,
//          autoFilterService.ts and printService.ts use. This is the LINK
//          mechanism at the heart of the "a button links a macro, it does not
//          copy it" model:
//
//            - A macro lives ONCE, as a module script (`macro-<slug>`) in the
//              workbook script store — the canonical thing the editor edits.
//            - A button that "runs a macro" carries only a 12-byte `macroRef`
//              control property: the macro's module id. No copied body, anywhere.
//            - On a click, Controls resolves that id THROUGH THIS SEAM and runs
//              whatever the macro currently is. Because the macro is loaded at
//              click time, editing the macro is reflected on every button that
//              links it with zero re-save — the link-not-copy guarantee falls out
//              for free.
//
// WHY A SEAM AND NOT A DIRECT CALL. The run path (load the module, route on its
// runtime marker to either the QuickJS module runtime or a transient unlocked
// object-script mount) lives inside the Macro Recorder extension. Controls must
// not import another extension's internals (the Facade Rule), and @api owns
// nothing about macros except this one contract. The Macro Recorder registers
// the provider at activation; Controls calls `requireMacroRunProvider()`.
//
// THE OUTCOME IS NEVER SILENT. `runMacroByRef` reports exactly one of four
// states, and the caller surfaces each. `notFound` — the macro a button links no
// longer exists (deleted locally, or missing on a subscriber that received a
// .calp without it) — is the recurring silent-dead-button failure this whole
// feature has fought, so it is a first-class outcome the caller MUST voice, not
// an exception it can swallow.

import type { ScriptRunTrigger } from "./workbookScripts";
import type { ExplicitMacroRun } from "./explicitMacroRun";

/** What running a macro-by-ref did. Exactly one of four states, all explicit. */
export type MacroRunOutcome =
  /** The macro ran to completion. `name` is its display name for a toast. */
  | { status: "ran"; name: string }
  /**
   * No macro with this id exists in the workbook. The button links a macro that
   * was deleted, or a .calp arrived without it. NEVER a silent no-op — the caller
   * tells the user the id is gone and how to fix it.
   */
  | { status: "notFound"; macroId: string }
  /** The macro exists and started, but its own code threw. `message` is why. */
  | { status: "failed"; name: string; message: string }
  /**
   * The macro exists but was NOT started, because the caller required it to be
   * a particular application's (`requirePackage`) and it is not: it is the
   * user's own (`owner: null`) or another application's. The confused-deputy
   * refusal of phase 3 of BUG-0257 -- a button from an application runs only
   * that application's macros, never one of the user's that happens to share
   * the id. `message` says so in words.
   */
  | { status: "refused"; macroId: string; name: string; message: string; owner: string | null };

/** How a macro-by-ref run is asked for. Every field is optional. */
export interface MacroRunOptions {
  /**
   * The application the macro MUST have come with. PRESENT = the record's
   * `sourcePackage` has to equal it exactly, or the run is `refused` before
   * anything executes; an EMPTY string is a refusal too (fail closed). Absent =
   * no such requirement (Developer ▸ Macros, the command line, a button of the
   * user's own).
   */
  requirePackage?: string;
  /** The button a click ran this for; forwarded to the Rust run gate. */
  trigger?: ScriptRunTrigger;
  /**
   * The pass the door a PERSON used minted for this run (owner decision B;
   * explicitMacroRun.ts) -- Developer ▸ Macros ▸ Run, a person's click on a
   * button that runs the macro (with the button's `trigger` beside it, which
   * the host requires and Rust verifies) and a `run` line typed at the command
   * line. It is what lets an APPROVED application macro written as an object
   * script change cells when someone runs it themselves, and what lets an
   * application's MODULE macro run at all (follow-up F10). Minted by that door,
   * never by this seam and never by a script's `api.runMacro` (host.ts
   * `executeRunMacro` passes no options at all); the provider FORWARDS it and
   * never creates one. Absent = an application's object-script macro gets no
   * cell access, and an application's module macro is refused by Rust.
   */
  explicitRun?: ExplicitMacroRun;
}

/** What the Macro Recorder provides: run one macro by its module id. */
export interface MacroRunProvider {
  runMacroByRef(macroId: string, options?: MacroRunOptions): Promise<MacroRunOutcome>;
}

let provider: MacroRunProvider | null = null;

/**
 * Register the macro runner. Called once by the Macro Recorder extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the provider if it is
 * still the one that was registered — so a re-activation followed by the OLD
 * cleanup running cannot blank out the live provider.
 */
export function registerMacroRunProvider(next: MacroRunProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** Whether macro-by-ref execution is currently available. */
export function hasMacroRunProvider(): boolean {
  return provider !== null;
}

/**
 * The registered provider.
 *
 * THROWS when none is registered (the Macro Recorder is disabled or failed to
 * load). Refusing loudly is the point: a button that links a macro is useless
 * without the extension that can run one, and a silent no-op on the click is the
 * exact failure this seam exists to prevent. The caller turns the throw into a
 * message the user can read.
 */
export function requireMacroRunProvider(): MacroRunProvider {
  if (!provider) {
    throw new Error(
      "This button links a recorded macro, but the Macro Recorder extension is not loaded, so nothing can run it. Enable it and try again.",
    );
  }
  return provider;
}

/** Test/reset hook: forget the registered provider. */
export function resetMacroRunProvider(): void {
  provider = null;
}
