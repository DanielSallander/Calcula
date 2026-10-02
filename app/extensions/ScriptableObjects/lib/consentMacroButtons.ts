//! FILENAME: app/extensions/ScriptableObjects/lib/consentMacroButtons.ts
// PURPOSE: "Buttons that run this macro" for the application consent screen
//          (phase 3 of BUG-0257): under each macro the screen approves, the
//          buttons THAT APPLICATION put in this workbook to run it, by cell and
//          caption.
// CONTEXT: Since phase 3 a button control from an application keeps its link to
//          the application's macro (held, stamped) and a click runs it once the
//          application's code is approved -- the approval this screen gives. So
//          the screen says which buttons that approval arms. The listing is the
//          backend's (`list_controls_referencing_macro`, through the one @api
//          wrapper), which reads the application off this machine's own stamps.
//
//          FILTERED TO THE APPLICATION. A row whose button came with ANOTHER
//          application, or is the user's own (no stamp), or carries a stamp that
//          cannot be read, is not this application's button and is not listed
//          under its macro: approving application P arms only P's buttons.
//
//          DISCLOSURE, NOT A GATE. A listing that fails leaves that macro with no
//          button list (logged); the approval itself is unchanged, and the run
//          gate is Rust's either way.

import {
  buttonRunningMacroCell,
  listButtonsRunningMacro,
  type ButtonRunningMacro,
} from "@api/heldButtonCode";

/** One button under a macro on the consent screen. */
export interface ConsentMacroButton {
  /** "Dashboard!B2" */
  cell: string;
  /** What the button says; may be empty. */
  caption: string;
  /** A button CONTROL or a button CELL. */
  kind: "control" | "cell";
}

/** The buttons of application `pkg` among the rows the backend listed for one macro. */
export function applicationButtons(
  pkg: string,
  rows: readonly ButtonRunningMacro[],
): ConsentMacroButton[] {
  return rows
    .filter((row) => typeof row.application === "string" && row.application === pkg)
    .map((row) => ({
      cell: buttonRunningMacroCell(row),
      caption: typeof row.caption === "string" ? row.caption : "",
      kind: row.kind,
    }));
}

/**
 * For each macro id, the buttons application `pkg` brought to run it. Macros
 * with none are omitted. `list` is injectable for the unit tier.
 */
export async function collectMacroButtons(
  pkg: string,
  macroIds: readonly string[],
  list: (macroId: string) => Promise<ButtonRunningMacro[]> = listButtonsRunningMacro,
): Promise<Record<string, ConsentMacroButton[]>> {
  const out: Record<string, ConsentMacroButton[]> = {};
  for (const id of macroIds) {
    let rows: ButtonRunningMacro[];
    try {
      rows = await list(id);
    } catch (e) {
      console.warn(`[ScriptableObjects] Could not list the buttons that run "${id}":`, e);
      continue;
    }
    const buttons = applicationButtons(pkg, rows);
    if (buttons.length > 0) out[id] = buttons;
  }
  return out;
}

/** How one button reads on the screen: `Dashboard!B2 "Run report"`. */
export function describeConsentMacroButton(button: ConsentMacroButton): string {
  const caption = button.caption ? ` "${button.caption}"` : "";
  const kind = button.kind === "cell" ? " (button cell)" : "";
  return `${button.cell}${caption}${kind}`;
}
