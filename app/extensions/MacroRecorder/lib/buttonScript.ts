//! FILENAME: app/extensions/MacroRecorder/lib/buttonScript.ts
// PURPOSE: "Add a button that runs this macro" — LINK a button to the one
//          canonical macro, by id. Not a copy of the macro's body: a reference.
// CONTEXT: This is the step that makes a recording AUTOMATION rather than a
//          transcript, and the model it uses is VBA's: a macro lives ONCE (a
//          module script in the workbook store, `macro-<slug>`), and a button
//          LINKS to it. Clicking the button runs the CURRENT macro, so editing
//          the macro is reflected on every button that links it — with no re-save
//          of any button.
//
//          WHAT THE BUTTON CARRIES. A single `macroRef` control property = the
//          macro's module id. Twelve bytes, not code. There is no per-button
//          object script, no mounted realm, no copied body — so nothing can
//          drift from the macro, and nothing can be edited on the button that the
//          macro does not have. The old model stored a SEPARATE copy of the body
//          on the button (an object script keyed by the control's instanceId);
//          that copy silently diverged the first time the macro was edited, which
//          is the exact failure this rewrite removes.
//
//          HOW THE CLICK RUNS IT. Controls reads `macroRef` at click time and
//          resolves+runs the macro through the @api/macroRunService seam, which
//          the Macro Recorder registers (see index.ts). That runs the macro
//          through the SAME `runMacroModule` path Developer ▸ Macros… ▸ Run uses
//          — one execution path, one set of guarantees.
//
//          THE BUTTON ITSELF is still built by the Controls extension through the
//          feature-neutral @api/buttonControlService seam, which owns the
//          geometry/fill/pin defaults and returns the instanceId. The recorder
//          never re-derives any of that; it says only WHAT it wants (a button
//          here, linking that macro) and never HOW.

import { requireButtonControlProvider } from "@api/buttonControlService";
import { getDesignMode } from "@api/designMode";

/**
 * The sentence to append to a "button created" message when Design Mode is on.
 *
 * In design mode a click SELECTS a control instead of running it, so a user who
 * has been placing controls would click their new macro button and see nothing
 * happen. Empty string when there is nothing to warn about, so callers can
 * concatenate unconditionally.
 */
export function designModeHint(): string {
  return getDesignMode()
    ? " Design Mode is on, so clicking selects the button — turn it off (Developer ▸ Design Mode) to run the macro."
    : "";
}

export interface LinkMacroButtonOptions {
  /** The canonical macro's module id (`macro-<slug>`) the button will LINK. */
  macroId: string;
  /** Macro name — becomes the button label. */
  name: string;
  sheetIndex: number;
  row: number;
  col: number;
}

export interface LinkMacroButtonResult {
  /** The control's instance id, as the Controls extension assigned it. */
  instanceId: string;
}

/**
 * Create a button that LINKS the given macro by id.
 *
 * The button holds only a `macroRef` = `macroId`; no body is copied. A click
 * resolves and runs the CURRENT macro through @api/macroRunService, so editing
 * the macro is reflected here with no re-save.
 *
 * Throws if no button provider is registered (the Controls extension is not
 * loaded) — a caller that cannot place a real, visible button must say so rather
 * than report a success the grid does not show.
 */
export async function linkMacroButton(
  options: LinkMacroButtonOptions,
): Promise<LinkMacroButtonResult> {
  const buttons = requireButtonControlProvider();
  const { macroId, name, sheetIndex, row, col } = options;

  const handle = await buttons.createButton({
    sheetIndex,
    row,
    col,
    label: name,
    tooltip: `Runs the recorded macro "${name}"`,
    // The link itself. No onSelect: the click path runs the macro by id, and an
    // inline onSelect would run a second, empty action alongside it.
    macroRef: macroId,
  });

  return { instanceId: handle.instanceId };
}
