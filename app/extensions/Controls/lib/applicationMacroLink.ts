//! FILENAME: app/extensions/Controls/lib/applicationMacroLink.ts
// PURPOSE: THE ONE CLICK RULE for a button control's macro LINK -- the author's
//          own live `macroRef`, or the `heldMacroRef` an application's button
//          keeps for it -- shared by the floating button (index.ts
//          runFloatingButtonClick) and the in-cell button (Button/interceptors.ts
//          executeButtonAction). Phase 3 of BUG-0257. Since phase 4 both reach
//          it only when the Rust button door (`run_control_action`) answers
//          `link` for the click (lib/controlClick.ts).
// CONTEXT: A button that came with an application keeps its link to that
//          application's macro HELD, stamped `heldFrom` (Rust admission:
//          app/src-tauri/src/held_button_code.rs -- at a checkout every link,
//          at a subscribe or refresh only a link to a macro that pull landed).
//          Phase 3 lets that link RUN, and only like this:
//
//            1. A LIVE `macroRef` is the author's own link and wins, exactly as
//               the Rust gate reads it (`verify_trigger`): it runs as before.
//            2. Otherwise a HELD `macroRef` runs through the macro-run seam with
//               `requirePackage` = the stamp's application, so the id can only
//               resolve to THAT application's macro -- never the user's own
//               `macro-report` that happens to share the id (the confused deputy
//               the pull strip used to guard against by removing every link).
//            3. An unreadable stamp vouches for nothing: refused, not guessed.
//
//          Every run carries the BUTTON (`trigger`) to the Rust run gate, which
//          reads its own store before an application's code runs, requires the
//          application's hash-keyed approval (a changed macro asks again), keeps
//          the working-copy private-sheet rule, and writes the always-on
//          ApplicationCodeRun / ApplicationCodeRefused row naming the button.
//          A refusal decided HERE, before Rust is asked, is written to the same
//          trail through `recordButtonRefusal` -- the backend reads the
//          application from the button's own stamp, never from this page.
//
//          A PERSON'S CLICK also carries the one-time explicit-run pass (owner
//          decision B, 2026-09-30: "an APPROVED application macro that the user
//          runs EXPLICITLY -- a button click ... -- gets the same CELL access in
//          either runtime"), minted by the pointer gesture handler, never here:
//          a recorded (object-script) application macro then changes cells for
//          that one run, exactly as a module macro already could.
//
//          ONE HELPER, BECAUSE THE TWO PATHS DRIFTED BEFORE: the in-cell path
//          never read `macroRef` at all, so a linked button did nothing when it
//          sat in a cell. A census in __tests__/applicationMacroLink.test.ts pins
//          that both paths call this and neither calls `runMacroByRef` itself.

import {
  hasMacroRunProvider,
  requireMacroRunProvider,
  type MacroRunOutcome,
} from "@api/macroRunService";
import type { ScriptRunTrigger } from "@api/workbookScripts";
import { MACRO_REF_PROPERTY } from "@api/buttonControlService";
import {
  HELD_FROM_PROPERTY,
  HELD_MACRO_REF_PROPERTY,
  parseHeldFrom,
  recordButtonRefusal,
} from "@api/heldButtonCode";
import { showToast } from "@api/notifications";
import { describeLinkedRunFailure, type ButtonGesturePass } from "../../_shared/lib/buttonClickDoor";
import { macroRunnerUnavailableDiagnosis, orphanMacroDiagnosis } from "./buttonClickDiagnosis";

/** The toast for a link run that did not complete (one sentence, shared with button cells). */
export { describeLinkedRunFailure };

/** A control property as the backend stores it. */
interface StoredProperty {
  valueType: string;
  value: string;
}

/** The link a click on this control follows, or null when it has none. */
export type ButtonMacroLink =
  /** The author's own live `macroRef`. */
  | { kind: "own"; macroId: string }
  /** An application's held link, with the application its stamp names. */
  | { kind: "application"; macroId: string; application: string }
  /** A held link whose stamp cannot be read: it vouches for nothing. */
  | { kind: "unreadableStamp"; macroId: string };

function nonEmpty(value: string | undefined | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Which link a click follows. Pure, so the precedence is testable on its own:
 * the live link first (the author's own, as Rust reads it), then the held one.
 */
export function resolveButtonMacroLink(
  properties: Record<string, StoredProperty> | null | undefined,
): ButtonMacroLink | null {
  if (!properties) return null;
  const live = nonEmpty(properties[MACRO_REF_PROPERTY]?.value);
  if (live) return { kind: "own", macroId: live };
  const held = nonEmpty(properties[HELD_MACRO_REF_PROPERTY]?.value);
  if (!held) return null;
  const application = parseHeldFrom(properties[HELD_FROM_PROPERTY]?.value)?.application ?? "";
  return application
    ? { kind: "application", macroId: held, application }
    : { kind: "unreadableStamp", macroId: held };
}

/** Voice one outcome of a link run. Never silent. */
async function voiceOutcome(
  outcome: MacroRunOutcome,
  sheetIndex: number,
  row: number,
  col: number,
): Promise<void> {
  switch (outcome.status) {
    case "ran":
      // The macro drives the grid through paths Controls does not tally, so
      // refetch unconditionally -- the same reason the inline path refreshes.
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      return;
    case "notFound": {
      const diag = orphanMacroDiagnosis(outcome.macroId);
      showToast(diag.message, { variant: diag.variant });
      return;
    }
    case "failed":
      // A Rust-gate refusal (not approved, private sheets, a claim storage does
      // not back) is already on the audit trail -- the gate wrote it.
      showToast(describeLinkedRunFailure(outcome.name, outcome.message), { variant: "error" });
      return;
    case "refused":
      // Decided on this side of the wire, so this side records it.
      showToast(
        `${outcome.message} To run a macro of your own from this button, replace the ` +
          "application's code in the Properties pane (Design Mode).",
        { variant: "error" },
      );
      await recordButtonRefusal(
        "control",
        sheetIndex,
        row,
        col,
        `the macro "${outcome.name}"`,
        "macroNotFromApplication",
      );
      return;
  }
}

/**
 * Run the macro a button control LINKS, if it links one.
 *
 * Returns `true` when the control carries a link (live or held) and the click
 * was therefore this helper's to answer -- whatever happened, it was voiced --
 * and `false` when it carries none, so the caller goes on to its inline /
 * object-script / held-inline-code paths. Never throws: a failure is a toast.
 *
 * `sheetIndex` is the TRUE state-vector index of the button's sheet: it travels
 * as the click's claim and Rust reads that cell of its store to verify it.
 *
 * `gesture` is THE PERSON'S CLICK (owner decision B): handed down by the
 * pointer gesture handler that heard it (index.ts `handleButtonPress`,
 * Button/interceptors.ts `buttonClickInterceptor`), and called ONCE, right
 * before the run, for the macro the link names -- so an APPROVED application
 * macro a person clicked may change cells for that one run. Without it the
 * macro runs restricted. ONLY a person's gesture may reach this helper with
 * one: no command, @api seam, script path, replay or AI tool may call it (a
 * census in src/api/__tests__/explicitMacroRun.test.ts pins its one caller,
 * lib/controlClick.ts, and who reaches that).
 */
export async function runButtonMacroLink(
  sheetIndex: number,
  row: number,
  col: number,
  properties: Record<string, StoredProperty> | null | undefined,
  gesture?: ButtonGesturePass,
): Promise<boolean> {
  const link = resolveButtonMacroLink(properties);
  if (!link) return false;

  if (link.kind === "unreadableStamp") {
    showToast(
      `This button links the macro "${link.macroId}", but its record of which application ` +
        "it came with cannot be read, so there is no way to tell whether that macro is the " +
        "application's. It did not run.",
      { variant: "error" },
    );
    await recordButtonRefusal("control", sheetIndex, row, col, `the macro "${link.macroId}"`, "stampUnreadable");
    return true;
  }

  if (!hasMacroRunProvider()) {
    // Nothing can run a macro: the Macro Recorder is not loaded. The specific
    // remedy, rather than a generic error.
    const diag = macroRunnerUnavailableDiagnosis(
      `This button links the recorded macro "${link.macroId}", but the Macro Recorder ` +
        "extension is not loaded, so nothing can run it. Enable it and try again.",
    );
    showToast(diag.message, { variant: diag.variant });
    return true;
  }

  const trigger: ScriptRunTrigger = { kind: "buttonControl", sheetIndex, row, col };
  let outcome: MacroRunOutcome;
  try {
    // The person's pass, minted by their gesture for THIS macro, now -- after
    // every refusal above, so a click that runs nothing mints nothing. The
    // host grants cell access only with the button trigger beside it, which
    // Rust verifies on both of its questions (`verify_trigger`).
    const explicitRun = gesture?.(link.macroId);
    outcome =
      link.kind === "application"
        ? await requireMacroRunProvider().runMacroByRef(link.macroId, {
            requirePackage: link.application,
            trigger,
            ...(explicitRun ? { explicitRun } : {}),
          })
        : await requireMacroRunProvider().runMacroByRef(link.macroId, {
            trigger,
            ...(explicitRun ? { explicitRun } : {}),
          });
  } catch (err) {
    showToast(
      `The button could not run "${link.macroId}": ${err instanceof Error ? err.message : String(err)}`,
      { variant: "error" },
    );
    return true;
  }
  await voiceOutcome(outcome, sheetIndex, row, col);
  return true;
}
