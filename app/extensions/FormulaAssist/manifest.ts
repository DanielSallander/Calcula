//! FILENAME: app/extensions/FormulaAssist/manifest.ts
// PURPOSE: The extension's identity and the handful of string ids that more
//          than one file in it has to spell the same way.
// CONTEXT: A command id, an overlay id and a keybinding id are all reached by
//          STRING — `commands.execute("formulaAssist.open")` compiles whatever
//          you type, and a typo is a control that silently does nothing. The
//          repo has already paid for that twice (see
//          FORMULA_BAR_TOGGLE_EXPANDED_COMMAND in api/keybindings.ts, and the
//          invoke()-drift guard). So they are written ONCE, here, and every
//          other file in this folder imports them.
//
//          The keybinding is CTRL+SHIFT+I. It shipped for an afternoon as
//          Ctrl+Shift+G on the reasoning that Controls' Ungroup binding fires
//          only while a floating control is selected, so the two never both
//          answer one keystroke. That is true and it is not the point: the
//          user-visible result was still one key doing two unrelated things
//          depending on a selection they were not thinking about, and neither
//          extension can see the other well enough to explain it. Searching
//          `DEFAULT_KEYBINDINGS` is not sufficient either — Controls binds a
//          raw `document` listener in capture phase, so a clash can exist
//          nowhere the registry can see it.

import type { ExtensionManifest } from "@api/contract";

/** The command a menu item, a keybinding and the AI chat all execute. */
export const FORMULA_ASSIST_OPEN_COMMAND = "formulaAssist.open";

/** The overlay the popover renders into. */
export const FORMULA_ASSIST_OVERLAY_ID = "formula-assist";

/** The keybinding registry id (not the combo — the user may rebind it). */
export const FORMULA_ASSIST_KEYBINDING_ID = "ext.formulaAssist.open";

/**
 * The default combo.
 *
 * NOT Ctrl+Shift+F, which is Excel-parity Format Cells. NOT Ctrl+Shift+G
 * either, which this first shipped as and which is Ungroup: the Controls
 * extension binds it with a capture-phase `document` listener that fires only
 * while a floating control is selected. That is the worst kind of clash —
 * the same key does two different things depending on a selection the user was
 * not thinking about, and neither feature can see the other to say so.
 *
 * Ctrl+Shift+I is free in Calcula (checked against every registered combo and
 * every raw ctrl+shift keydown handler) and carries no Excel meaning, so taking
 * it blocks no parity feature later.
 */
export const FORMULA_ASSIST_COMBO = "Ctrl+Shift+I";

/** The grid context-menu entry that pre-fills the intent for a broken cell. */
export const FORMULA_ASSIST_CONTEXT_MENU_ID = "formulaAssist.fixThisFormula";

/** The Formulas-menu entry. */
export const FORMULA_ASSIST_MENU_ITEM_ID = "formulaAssist.menu";

export const formulaAssistManifest: ExtensionManifest = {
  id: "calcula.formula-assist",
  name: "Formula Assist",
  version: "1.0.0",
  description:
    "Ask for a formula in your own words. Calcula's engine checks the answer and shows you the computed result before anything is written.",
};
