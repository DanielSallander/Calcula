//! FILENAME: app/extensions/_shared/lib/buttonClickDoor.ts
// PURPOSE: THE ONE CLICK of every button surface -- a floating button control
//          (Controls/index.ts runFloatingButtonClick), an in-cell button
//          control (Controls/Button/interceptors.ts executeButtonAction) and a
//          button CELL (CellTypes/types/button.ts): ask the Rust button door
//          what the click runs, and say each answer exactly once.
// CONTEXT: Phase 4 of BUG-0257 (M6). The rule that turns a click into a program
//          used to live in this folder (`buttonScriptRun.ts`'s planners): the
//          page read a button's code, composed the user's own modules around
//          it -- or appended a "Function to call" to a cell's module -- and sent
//          the result to `run_script`, which lets a source no stored module
//          carries through as an ad-hoc run. That was sound only while nothing
//          an application shipped could sit on a button as code. Phase 4 lets
//          an application's inline button code travel, held and run only after
//          an approval of its exact bytes, so the decision moved to Rust:
//          `run_control_action` (app/src-tauri/src/scripting/control_action.rs)
//          reads the button from its own store, plans, gates, audits and runs.
//
//          The page names the BUTTON and nothing else (`@api/workbookScripts`
//          runControlAction), and handles each of the door's six answers ONCE:
//
//            ran      -- the run's own notices, a repaint, or its error said;
//            refused  -- the door's sentence, toasted. Rust has ALREADY written
//                        the audit row whenever the button or the code it asked
//                        for came with an application, so nothing is recorded
//                        here (a second row would be a second, false refusal);
//            link     -- the surface's macro-link route (button controls only);
//            macro    -- the macro-run seam, for a button CELL whose action is a
//                        macro that runs only as an object script (owner
//                        decision B, follow-up F6; button cells only);
//            command  -- a button cell's command (button cells only: only the
//                        page can run an extension command): the user's own,
//                        or -- with the application named -- one that came
//                        with an application and passed Rust's command gate
//                        (plan_M8 S1), which the surface must not run as the
//                        user's own;
//            nothing  -- the surface says why, its own way.
//
//          A door failure (Script Security disabled, the prompt declined, a
//          backend error) is said too. No answer is ever silent.
//
//          THE PERSON'S CLICK (owner decision B, 2026-09-30): an APPROVED
//          application macro a person runs from a button gets cell access for
//          that one run. What proves the person is the one-time pass
//          (`@api/explicitMacroRun`), and WHERE it is minted is the whole proof:
//          only in the pointer GESTURE handlers -- the floating button's release
//          (Controls/index.ts `handleButtonPress`), the in-cell button's click
//          (Controls/Button/interceptors.ts `buttonClickInterceptor`) and the
//          button cell's click (CellTypes/types/button.ts `onClick`). The macro a
//          click runs is known only once the door has answered, so the handler
//          hands DOWN a `ButtonGesturePass` -- its own mint, for whichever macro
//          the answer names -- and the macro route calls it once, right before
//          the run. Every other caller of these routes passes none, and the
//          macro then runs restricted. A census
//          (src/api/__tests__/explicitMacroRun.test.ts) pins the mint sites and
//          who can reach them.

import {
  runControlAction,
  type ControlActionButton,
  type ControlActionOutcome,
  type UnavailableButtonModule,
} from "@api/workbookScripts";
import { showToast } from "@api/notifications";
import type { ExplicitMacroRun } from "@api/explicitMacroRun";

/**
 * A PERSON'S CLICK, as the pointer gesture handler that heard it hands it
 * down: given the macro the click turns out to run, the one-time explicit-run
 * pass for exactly that macro (owner decision B). Made ONLY by a gesture
 * handler, as `(macroId) => mintExplicitMacroRun("button", macroId)`; called
 * at most once per click, by the route that is about to run the macro, and
 * never kept. A route handed none runs the macro restricted.
 */
export type ButtonGesturePass = (macroId: string) => ExplicitMacroRun;

// ============================================================================
// Notices
// ============================================================================

/**
 * Module ids already reported as uncallable, so repeated clicking does not
 * re-toast the same explanation: one notice per module per session, across
 * every button surface.
 */
const reportedUnavailableModules = new Set<string>();

/**
 * Tell the user, once per module, why a module a button's code named is not
 * callable -- above all the case that matters most: it came with an
 * application, so it is never mixed into other code. A click that finds `X()`
 * undefined and says nothing is indistinguishable from a broken button.
 */
export function reportUnavailableButtonModules(unavailable: readonly UnavailableButtonModule[]): void {
  for (const entry of unavailable) {
    console.warn(`[buttons] Script module "${entry.name}" not callable: ${entry.message}`);
    if (reportedUnavailableModules.has(entry.id)) continue;
    reportedUnavailableModules.add(entry.id);
    showToast(entry.message, { variant: entry.reason === "distributed" ? "info" : "warning" });
  }
}

/** Test seam: forget which notices have already been shown. */
export function resetButtonModuleNoticesForTest(): void {
  reportedUnavailableModules.clear();
}

// ============================================================================
// The answers
// ============================================================================

/** The sentence for a click the door could not answer, or whose code stopped with an error. */
export function describeButtonRunFailure(message: string): string {
  return `Button script couldn't run: ${message}`;
}

/** The sentinels the Rust run gate starts a refusal with: "the gate said no". */
const RUN_GATE_REFUSALS: readonly string[] = [
  "DISTRIBUTED_SCRIPT_NOT_CONSENTED",
  "APPLICATION_CODE_BESIDE_PRIVATE_SHEETS",
  "APPLICATION_CODE_TRIGGER_MISMATCH",
  // Owner decision B, F10: an application's module macro no person started
  // (a link reached without a person's click carries no pass).
  "APPLICATION_MACRO_NOT_STARTED_BY_YOU",
];

/**
 * The toast for a macro a button ran through the macro-run seam that did not
 * complete -- in the gate's own words when the gate spoke ("did not run"), as
 * a failure otherwise. One sentence for both seam routes: a button control's
 * link (Controls/lib/applicationMacroLink.ts) and a button cell's object-script
 * macro (CellTypes/types/button.ts).
 *
 * A message that already NAMES the macro is the runner's own sentence, and it
 * already says what happened -- "stopped before it finished ... Every change
 * it had made was undone, so nothing was changed", "was not run: ...", "did not
 * start: ...", "was still running after 10 seconds" -- so it is said as it is
 * (review of M6b). Wrapped, it read `"X" failed: "X" stopped ... nothing was
 * changed`: the name twice, and "failed" beside "nothing was changed".
 */
export function describeLinkedRunFailure(name: string, message: string): string {
  if (message.startsWith(`"${name}" `)) return message;
  return RUN_GATE_REFUSALS.some((s) => message.includes(s))
    ? `"${name}" did not run: ${message}`
    : `"${name}" failed: ${message}`;
}

/** What a surface does with the answers only it can act on. */
export interface ButtonClickHandlers {
  /** The button links a macro (button CONTROLS): run it through the link route. */
  link?: () => Promise<void>;
  /**
   * The button cell's action is a macro that runs only as an object script
   * (button CELLS): run it through the macro-run seam. `application` is the
   * button's stamp (null for a button of the user's own).
   */
  macro?: (macroId: string, application: string | null) => Promise<void>;
  /**
   * A button CELL's command. `application` is null for the user's own, which
   * runs through the extension registry; a string is the application the
   * button came with -- Rust's command gate said yes, and the page's own half
   * (the live registration, then `authorize_button_command`) is the surface's.
   */
  command?: (commandId: string, application: string | null) => Promise<void>;
  /** Nothing on the button to run; `message` is the door's reason, when it gave one. */
  nothing: (message: string | null) => void | Promise<void>;
}

/** A "ran" answer: the run's notices first, then its error -- or a repaint. */
function voiceRan(outcome: Extract<ControlActionOutcome, { kind: "ran" }>): void {
  reportUnavailableButtonModules(outcome.unavailable ?? []);
  const result = outcome.result;
  if (result.type === "error") {
    // Degraded-mode transparency: a button whose code stopped must SHOW it.
    console.error(`[buttons] Button script error: ${result.message}`);
    showToast(describeButtonRunFailure(result.message), { variant: "error" });
    return;
  }
  // Repaint after EVERY successful run (review of M6b). `cellsModified` is the
  // backend's count of cells IT wrote, and a script changes the grid through
  // paths it does not tally, so it is no gate; and neither is
  // Application.screenUpdating left off -- Excel turns screen updating back on
  // when a macro ends, and a button has no way to resume it (the notebook
  // does), so a run that ended with it off left the grid showing the cells as
  // they were before the run, its own writes included.
  window.dispatchEvent(new CustomEvent("grid:refresh"));
}

/**
 * A "refused" answer: the door's own sentence. NOT recorded here: the door
 * already wrote the row (`ButtonCodeRefused` / `ApplicationCodeRefused`) for
 * every refusal that concerns an application.
 */
function voiceRefused(outcome: Extract<ControlActionOutcome, { kind: "refused" }>): void {
  // A working copy's held cell action is held by design, not an error.
  showToast(outcome.message, { variant: outcome.reason === "heldInWorkingCopy" ? "info" : "error" });
}

/** An answer this surface can never get (a link on a cell, a macro or a command on a control). */
function voiceImpossible(button: ControlActionButton, kind: string): void {
  const what = button.kind === "cell" ? "button cell" : "button control";
  showToast(
    describeButtonRunFailure(`the button door answered "${kind}" for a ${what}, which cannot happen, so nothing ran.`),
    { variant: "error" },
  );
}

/**
 * WHOSE BUTTON the door said it is, on a `macro` or a `command` answer: a
 * string names the application the button came with, `null` is the user's
 * own. Rust ALWAYS sends the field (`Option<String>`, never skipped), so an
 * answer without it -- a wire drift, a field someone later marks
 * `skip_serializing_if`, a mocked door -- is one Calcula does not understand,
 * and `undefined` here. It is NEVER read as "the user's own": that route skips
 * every check an application's command or macro gets (the live registration,
 * `authorize_button_command`, the run row).
 */
function whoseButton(outcome: object): string | null | undefined {
  if (!("application" in outcome)) return undefined;
  const application = (outcome as { application?: unknown }).application;
  return application === null || typeof application === "string" ? application : undefined;
}

/** A `macro` or `command` answer that did not say whose button it is: nothing runs. */
function voiceUnattributed(button: ControlActionButton, kind: string): void {
  const what = button.kind === "cell" ? "button cell" : "button control";
  showToast(
    describeButtonRunFailure(
      `the button door answered "${kind}" for a ${what} but did not say whose button it is, so nothing ran.`,
    ),
    { variant: "error" },
  );
}

/**
 * Click `button`: ask the door, then answer once. Never throws -- every
 * failure is a toast.
 */
export async function clickButtonThroughDoor(button: ControlActionButton, on: ButtonClickHandlers): Promise<void> {
  let outcome: ControlActionOutcome;
  try {
    outcome = await runControlAction(button);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[buttons] The button door failed:", err);
    showToast(describeButtonRunFailure(message), { variant: "error" });
    return;
  }
  try {
    switch (outcome.kind) {
      case "ran":
        voiceRan(outcome);
        return;
      case "refused":
        voiceRefused(outcome);
        return;
      case "link":
        if (on.link) await on.link();
        else voiceImpossible(button, outcome.kind);
        return;
      case "macro": {
        if (!on.macro) {
          voiceImpossible(button, outcome.kind);
          return;
        }
        const application = whoseButton(outcome);
        if (application === undefined) voiceUnattributed(button, outcome.kind);
        else await on.macro(outcome.macroId, application);
        return;
      }
      case "command": {
        if (!on.command) {
          voiceImpossible(button, outcome.kind);
          return;
        }
        const application = whoseButton(outcome);
        if (application === undefined) voiceUnattributed(button, outcome.kind);
        else await on.command(outcome.commandId, application);
        return;
      }
      case "nothing":
        await on.nothing(outcome.message ?? null);
        return;
      default: {
        const unknown: never = outcome;
        voiceImpossible(button, String((unknown as { kind?: unknown }).kind));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[buttons] Answering the button door failed:", err);
    showToast(describeButtonRunFailure(message), { variant: "error" });
  }
}
