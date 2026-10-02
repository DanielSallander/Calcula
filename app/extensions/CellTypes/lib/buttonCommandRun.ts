//! FILENAME: app/extensions/CellTypes/lib/buttonCommandRun.ts
// PURPOSE: THE ONE COMMAND PATH of a button cell (Cell Type: Button). The
//          Rust button door (`run_control_action`) decides whose button was
//          clicked and answers `command` -- with no application for the user's
//          own button, or WITH the application the button came with once Rust's
//          half of the rule said yes. Running an extension command is the one
//          thing only the page can do, so this file runs it, for both.
// CONTEXT: plan_M8 Task A (BUG-0257 phase 5). An application's button runs a
//          Calcula command only when TWO independent yeses agree:
//
//            RUST'S -- the command is on `DISTRIBUTABLE_BUTTON_COMMANDS`
//              (app/src-tauri/src/button_cells.rs; empty today), approved under
//              `button-commands:<application>`, and the working-copy
//              private-sheet rule allows it. The door asked all three before it
//              answered; every refusal there is already on the audit trail.
//            THE PAGE'S -- only the page can see the command's LIVE
//              registration: (i) it must exist, (ii) it must opt in
//              (`distributableTrigger: true`, read off the live object at THIS
//              click, never remembered: a later registration may shadow an id),
//              (ii-b) the live registration must be the ORIGINAL
//              (`isCommandShadowed`): no registration standing over another
//              under that id, none registered after the original was taken
//              back, and no flag set on it in place. That global
//              `window.__CALCULA_EXTENSION_REGISTRY__` hands getCommand,
//              unregisterCommand and registerCommand to any main-realm code, so
//              a shadow could set the flag itself; the registry therefore keeps
//              the first registration of every id and freezes a flagged command
//              as it is registered. This is defence in depth -- Rust's list
//              bounds the ids, and main-realm code can already act on the page
//              -- but it is what makes the run row's "approved application run"
//              true. And (iii) its `isEnabled` must say yes. Each refusal is said
//              and recorded here (`audit_button_refusal`) -- Rust did not make it.
//
//          Then (iv) `authorize_button_command` asks Rust again, from its own
//          store, and writes the always-on run row; its refusal is Rust's and
//          already recorded, so the page only says it. And (v) the command runs
//          -- only after that answer arrived, and it is the very object the page
//          judged.
//
//          The user's OWN button runs its command without any approval, as it
//          always has -- but its `isEnabled` is now asked too (the button path
//          used to skip what `executeCommandAnywhere` checks), and it never asks
//          `authorize_button_command` (Rust has no application to authorize).
//
//          Only the EXTENSION registry is asked -- what the button dialog
//          offers: `executeCommandAnywhere` would widen a button, which can
//          arrive inside a distributed workbook, to every CommandRegistry
//          command.

import { ExtensionRegistry, type CommandContext, type CommandDefinition } from "@api/extensions";
import {
  authorizeButtonCommand,
  describeApplicationCommandRefusal,
  judgeApplicationCommand,
  recordButtonRefusal,
  type RefusedButtonCommand,
} from "@api/heldButtonCode";
import { showToast } from "@api/notifications";

/** The button cell a click named to the door: the TRUE sheet index and its cell. */
export interface ButtonCommandCell {
  sheetIndex: number;
  row: number;
  col: number;
}

/**
 * What the AUTHOR is told under the command picker (ButtonActionDialog): what
 * this button's command does once the workbook is published as an
 * application. Read off the chosen command's live registration -- the object
 * the click reads.
 */
export function describeButtonCommandReach(command: { distributableTrigger?: unknown } | null | undefined): string {
  return command?.distributableTrigger === true
    ? "In an application you publish, subscribers can run this after they approve it."
    : "Only in this workbook: in an application you publish, this button's command is removed when it arrives.";
}

/**
 * What a click on an application's button says when the PAGE refuses its
 * command. Composed here, not in @api: every other click sentence is the Rust
 * door's own, and these are the refusals only the page can make (the command's
 * live registration). The reason clause is the one the approval screen and
 * Code in This File use too.
 */
export function describeRefusedButtonCommand(application: string, commandId: string, why: RefusedButtonCommand): string {
  const remedy =
    why === "commandDisabled"
      ? ""
      : " To run a command yourself, give the button an action of your own (Insert > Cell Type > Button).";
  return (
    `This button came with the application '${application}' and asks to run the command "${commandId}", ` +
    `but ${describeApplicationCommandRefusal(why)}, so it did not run.${remedy}`
  );
}

/** The ONE CommandContext builder (@api/commandDispatch), loaded when a command runs. */
async function commandContext(): Promise<CommandContext> {
  const { buildCommandContext } = await import("@api/commandDispatch");
  return buildCommandContext();
}

/** The command's `isEnabled`, asked of the context it would run with. A check that throws is a no. */
function enabledIn(command: CommandDefinition, context: CommandContext): boolean {
  if (!command.isEnabled) return true;
  try {
    return Boolean(command.isEnabled(context));
  } catch (err) {
    console.warn(`[buttons] isEnabled of "${command.id}" threw; the command did not run:`, err);
    return false;
  }
}

/** Run `command` and say a failure. Never throws. */
async function execute(command: CommandDefinition, context: CommandContext): Promise<void> {
  try {
    await command.execute(context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`Button command failed: ${msg}`, { variant: "error" });
  }
}

/** The user's OWN button: no approval, but the command must be registered and enabled. */
async function runOwnCommand(commandId: string): Promise<void> {
  const command = ExtensionRegistry.getCommand(commandId);
  if (!command) {
    showToast(`Button command "${commandId}" is not registered`, { variant: "error" });
    return;
  }
  const context = await commandContext();
  if (!enabledIn(command, context)) {
    showToast(`Button command "${commandId}" is not available right now, so it did not run.`, {
      variant: "warning",
    });
    return;
  }
  await execute(command, context);
}

/** A refusal the PAGE made: said, and written to the audit trail (Rust did not make it). */
async function refuse(
  at: ButtonCommandCell,
  application: string,
  commandId: string,
  why: RefusedButtonCommand,
): Promise<void> {
  showToast(describeRefusedButtonCommand(application, commandId, why), {
    variant: why === "commandDisabled" ? "warning" : "error",
  });
  await recordButtonRefusal("cell", at.sheetIndex, at.row, at.col, `the command "${commandId}"`, why);
}

/** A button that came with `application`: the page's half, Rust's second question, then the run. */
async function runApplicationCommand(at: ButtonCommandCell, commandId: string, application: string): Promise<void> {
  // (i) / (ii) / (ii-b): the LIVE registration, judged by the one rule the
  // approval screen also applies.
  const live = ExtensionRegistry.getCommand(commandId);
  const refusal = judgeApplicationCommand(live, ExtensionRegistry.isCommandShadowed(commandId));
  if (refusal !== null || !live) {
    await refuse(at, application, commandId, refusal ?? "commandUnregistered");
    return;
  }
  // (iii) isEnabled, before Rust writes a run row for a command that would not run.
  const context = await commandContext();
  if (!enabledIn(live, context)) {
    await refuse(at, application, commandId, "commandDisabled");
    return;
  }
  // (iv) Rust's second question: the store, the list, the approval, the
  // private-sheet rule -- and the run row. Its refusal is already recorded.
  try {
    await authorizeButtonCommand(at.sheetIndex, at.row, at.col, commandId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showToast(`The command "${commandId}" did not run: ${message}`, { variant: "error" });
    return;
  }
  // (v) Only now, and the very object judged above.
  await execute(live, context);
}

/**
 * Run the command the button door answered for the button cell at `at`.
 * `application` is the door's answer: null for the user's own button, else the
 * application the button came with -- never the page's own reading of the
 * cell's cached params. Never throws on a refusal; every outcome is said.
 */
export async function runButtonCellCommand(
  at: ButtonCommandCell,
  commandId: string,
  application: string | null,
): Promise<void> {
  if (application === null) {
    await runOwnCommand(commandId);
    return;
  }
  await runApplicationCommand(at, commandId, application);
}
