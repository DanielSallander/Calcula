//! FILENAME: app/extensions/CellTypes/types/button.ts
// PURPOSE: The "calcula.button" cell type — a cell that renders as a button
//          and fires an action on click: a registered command or a workbook
//          script. The cell's value is the label (params.label as fallback).
// PARAMS:  label (string), action: { kind: "command", commandId } |
//          { kind: "script", scriptId, functionName? }.
// SECURITY: A CLICK NAMES THE BUTTON AND NOTHING ELSE (phase 4 of BUG-0257).
//          The Rust button door `run_control_action`
//          (app/src-tauri/src/scripting/control_action.rs) reads this cell's
//          params from ITS OWN store and decides: a script action runs the
//          bound module's stored source UNCHANGED (or, for the user's own
//          module only, with its "Function to call" appended -- a composition
//          refused for a module that came with an application); a button from
//          an application (`fromApplication`, BUG-0260) runs only its own
//          application's modules, and a Calcula command only when BOTH halves
//          say yes, and only after approval: Rust's (the command is on
//          Calcula's list -- empty today --, approved under its own key
//          `button-commands:<application>`, the private-sheet rule) and the
//          page's (the command's LIVE registration opts in with
//          `distributableTrigger` and is not shadowed -- see
//          ../lib/buttonCommandRun.ts); a checkout's HELD action
//          never runs; the module's approval and the working-copy private-sheet
//          rule are asked of the final source; and every run and refusal of an
//          application's code is written to the audit trail -- by Rust, except
//          the refusals only the page can make (a command's live registration).
//          The page used to decide all of that from the
//          params it had cached (the deleted `planStoredModuleRun`) and
//          compose the program itself; it now says what the door answered,
//          once (extensions/_shared/lib/buttonClickDoor.ts). Two things only
//          the page can do: run an extension COMMAND (the door answers
//          `command`: the user's own, or an application's after the page's
//          half and Rust's second question, `authorize_button_command`), and
//          run a macro that runs only as an OBJECT
//          SCRIPT -- the Macro Recorder's default target, which the door's
//          interpreter cannot run (no `api`) -- through the macro-run seam
//          (the door answers `macro`; owner decision B, follow-up F6). That
//          run names this cell as its `buttonCell` trigger, which the Rust run
//          gate verifies against its own store, and the approval of the
//          application's code is asked of it like every other route.
//
//          THE PERSON'S CLICK (owner decision B, 2026-09-30): `onClick` below
//          is the pointer gesture (Core's mouse-down handler is the only caller
//          of the cell click interceptors), so it -- and nothing it calls --
//          mints the one-time explicit-run pass for the macro the door names:
//          an APPROVED application macro then changes cells for that one run.
//
//          ON RELEASE (BUG-0258 design phase 4, the owner's answer "on release,
//          and sliding off cancels"): the press only claims the button cell; the
//          action runs when that press is RELEASED on this same cell, and a
//          press that slides off runs nothing (Core's press session,
//          src/core/lib/cellPressRelease.ts). While held over the cell the
//          button looks pressed (`isCellPressed`).

import type { CellTypeDefinition, CellTypeRenderContext } from "@api/cellTypes";
import { actOnCellRelease, isCellPressed } from "@api/cellClickInterceptors";
import { mintExplicitMacroRun } from "@api/explicitMacroRun";
import {
  hasMacroRunProvider,
  requireMacroRunProvider,
  type MacroRunOutcome,
} from "@api/macroRunService";
import type { ScriptRunTrigger } from "@api/workbookScripts";
import { recordButtonRefusal } from "@api/heldButtonCode";
import {
  clickButtonThroughDoor,
  describeLinkedRunFailure,
  type ButtonGesturePass,
} from "../../_shared/lib/buttonClickDoor";
import { runButtonCellCommand } from "../lib/buttonCommandRun";

/**
 * The TRUE state-vector index of the sheet the clicked button cell is on. A
 * click reaches a button cell only on the ACTIVE sheet (the cell-type index is
 * the active sheet's), so that is the sheet the click names to the door.
 */
async function activeSheetIndex(): Promise<number> {
  const { getGridStateSnapshot } = await import("../../../src/api/grid");
  return getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? 0;
}

export const BUTTON_TYPE_ID = "calcula.button";

/** How dark a PRESSED button cell's face goes (a black wash, 0..1; a floating button's too). */
export const BUTTON_CELL_PRESSED_SHADE = 0.12;

export interface ButtonAction {
  kind: "command" | "script";
  commandId?: string;
  scriptId?: string;
  functionName?: string;
}

function renderButton(context: CellTypeRenderContext): boolean {
  const { ctx, row, col, cellLeft, cellTop, cellRight, cellBottom, value, params, styleIndex, styleCache } =
    context;

  const cellWidth = cellRight - cellLeft;
  const cellHeight = cellBottom - cellTop;
  if (cellWidth < 12 || cellHeight < 10) {
    return true;
  }

  const inset = 2;
  const btnLeft = cellLeft + inset;
  const btnTop = cellTop + inset;
  const btnWidth = cellWidth - inset * 2;
  const btnHeight = cellHeight - inset * 2;
  const radius = Math.min(4, btnHeight / 3);
  // A press held on this button (its release claim): it looks pushed in -- a
  // darker face, no raised shading, the label one pixel down and right --
  // until the release runs it or the pointer slides off.
  const pressed = isCellPressed(row, col);

  // Face + border
  ctx.beginPath();
  ctx.roundRect(btnLeft + 0.5, btnTop + 0.5, btnWidth - 1, btnHeight - 1, radius);
  ctx.fillStyle = "#f5f5f5";
  ctx.fill();
  if (pressed) {
    ctx.fillStyle = "#000000";
    ctx.globalAlpha = BUTTON_CELL_PRESSED_SHADE;
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#b5b5b5";
  ctx.stroke();

  if (!pressed) {
    // Subtle bottom shading for a raised look
    ctx.beginPath();
    ctx.moveTo(btnLeft + radius, btnTop + btnHeight - 1);
    ctx.lineTo(btnLeft + btnWidth - radius, btnTop + btnHeight - 1);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.12)";
    ctx.stroke();
  }

  // Label (value wins; params.label is the fallback for empty cells)
  const label =
    value !== "" ? value : typeof params.label === "string" && params.label ? params.label : "Button";
  const style = styleCache.get(styleIndex) ?? styleCache.get(0);
  const fontSize = Math.min(style?.fontSize || 11, btnHeight - 4);
  const fontFamily = style?.fontFamily || "sans-serif";
  ctx.font = `${style?.bold ? "bold" : "normal"} ${fontSize}px ${fontFamily}`;
  ctx.fillStyle = style?.textColor || "#303030";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const maxTextWidth = btnWidth - 8;
  let text = label;
  if (ctx.measureText(text).width > maxTextWidth) {
    while (text.length > 1 && ctx.measureText(text + "…").width > maxTextWidth) {
      text = text.slice(0, -1);
    }
    text += "…";
  }
  const textOffset = pressed ? 1 : 0;
  ctx.fillText(text, btnLeft + btnWidth / 2 + textOffset, btnTop + btnHeight / 2 + 0.5 + textOffset);
  return true;
}

/** The button cell a click named to the door: the TRUE sheet index and its cell. */
interface ClickedButtonCell {
  sheetIndex: number;
  row: number;
  col: number;
}

/**
 * The door answered `macro`: this cell's action is a macro that runs only as an
 * object script (owner decision B, follow-up F6). Run it through the macro-run
 * seam -- the same route a button control's link takes -- naming THIS cell as
 * the run's `buttonCell` trigger (the Rust run gate checks that the button cell
 * there runs exactly this macro, under the stamp `application` names) and, as
 * a person clicked it, with the pass their gesture mints for this macro. When
 * the button came with an application, the macro must be that application's
 * (`requirePackage`); the door has already refused one that is not.
 *
 * Never silent, never throws: every outcome is a toast or a repaint.
 */
async function runCellMacro(
  at: ClickedButtonCell,
  macroId: string,
  application: string | null,
  gesture: ButtonGesturePass,
): Promise<void> {
  const { showToast } = await import("../../../src/api/notifications");
  if (!hasMacroRunProvider()) {
    showToast(
      `This button runs the recorded macro "${macroId}", but the Macro Recorder extension is not ` +
        "loaded, so nothing can run it. Enable it and try again.",
      { variant: "error" },
    );
    return;
  }
  // The cell the click named to the door -- the trigger kind agrees with the
  // door's kind ("cell"), and Rust verifies it on both of its questions.
  const trigger: ScriptRunTrigger = { kind: "buttonCell", sheetIndex: at.sheetIndex, row: at.row, col: at.col };
  let outcome: MacroRunOutcome;
  try {
    // The person's pass, for THIS macro, minted now -- right before the run.
    const explicitRun = gesture(macroId);
    outcome = await requireMacroRunProvider().runMacroByRef(macroId, {
      ...(application !== null ? { requirePackage: application } : {}),
      trigger,
      explicitRun,
    });
  } catch (err) {
    showToast(`The button could not run "${macroId}": ${err instanceof Error ? err.message : String(err)}`, {
      variant: "error",
    });
    return;
  }
  switch (outcome.status) {
    case "ran":
      // The macro drives the grid through paths this page does not tally.
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      return;
    case "notFound":
      showToast(
        `This button runs the macro "${outcome.macroId}", which no longer exists in this workbook, so ` +
          "nothing ran. Give the button an action of your own (Insert > Cell Type > Button).",
        { variant: "warning" },
      );
      return;
    case "failed":
      // A Rust-gate refusal is already on the audit trail -- the gate wrote it.
      showToast(describeLinkedRunFailure(outcome.name, outcome.message), { variant: "error" });
      return;
    case "refused":
      // Decided on this side of the wire, so this side records it.
      showToast(
        `${outcome.message} To run a macro of your own from this button, give it an action of your own ` +
          "(Insert > Cell Type > Button).",
        { variant: "error" },
      );
      await recordButtonRefusal(
        "cell",
        at.sheetIndex,
        at.row,
        at.col,
        `the macro "${outcome.name}"`,
        "macroNotFromApplication",
      );
      return;
  }
}

/**
 * Click the button cell at `at`: the door decides from its own store, and each
 * answer is said once. The params the page has cached are never consulted.
 * `gesture` is the person's click from `onClick`, its only caller.
 */
async function runButtonCell(at: ClickedButtonCell, gesture: ButtonGesturePass): Promise<void> {
  await clickButtonThroughDoor(
    { kind: "cell", sheetIndex: at.sheetIndex, row: at.row, col: at.col },
    {
      macro: (macroId, application) => runCellMacro(at, macroId, application, gesture),
      // Whose button it is, is the door's answer -- never the cached params.
      command: (commandId, application) => runButtonCellCommand(at, commandId, application),
      nothing: async (message) => {
        // A button cell with no action it can run: the door names why (one of
        // the user's own, or one that came with an application).
        if (!message) return;
        const { showToast } = await import("../../../src/api/notifications");
        showToast(message, { variant: "info" });
      },
    },
  );
}

export const buttonCellType: CellTypeDefinition = {
  id: BUTTON_TYPE_ID,
  render: renderButton,
  editor: "none",
  onClick: async ({ row, col }) => {
    const { getDesignMode } = await import("../../../src/api/designMode");
    if (getDesignMode()) {
      return false; // Design mode: click selects/edits, run mode fires.
    }
    // Select the cell so keyboard focus follows the press (a Windows button
    // takes the focus on the press, and keeps it when the press slides off).
    const { dispatchGridAction } = await import("../../../src/api/gridDispatch");
    const { setSelection } = await import("../../../src/api/grid");
    dispatchGridAction(
      setSelection({ startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" })
    );
    // The sheet is read ONCE, at the press: the door reads THAT button, and
    // any refusal it records names it, whatever the user switches to while the
    // action awaits (a release on another sheet runs nothing at all). What the
    // button runs -- or that its action is held in a working copy (BUG-0260) --
    // the door reads from its own store.
    const sheetIndex = await activeSheetIndex();
    // THE PERSON'S CLICK (owner decision B): this handler is reached only from
    // Core's mouse-down (the cell click interceptors), and the claim it answers
    // with runs only at that press's RELEASE on this cell (Core's press
    // session) -- so the one-time explicit-run pass is minted HERE, at the
    // release, for whichever macro the door's answer names -- and nowhere
    // below (census: src/api/__tests__/explicitMacroRun.test.ts).
    return actOnCellRelease(
      row,
      col,
      () => runButtonCell({ sheetIndex, row, col }, (macroId) => mintExplicitMacroRun("button", macroId)),
      { pressedLook: true },
    );
  },
  getCursor: () => "pointer",
  displayText: (value, params) =>
    value !== "" ? value : typeof params.label === "string" ? params.label : "",
};
