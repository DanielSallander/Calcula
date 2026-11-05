//! FILENAME: app/extensions/_shared/lib/dialogTheme.ts
// PURPOSE: The colours a hand-built modal dialog paints with -- every one a
//          theme custom property, so the dialog follows the app's light and dark
//          skins.
// CONTEXT: BUG-0376: three styles dialogs (Conditional Formatting's QuickCFDialog
//          and NewRuleDialog, Table's CreateTableDialog) hard-coded their colours
//          -- the CF two always light, Create Table always dark -- so each was
//          wrong in one theme. They paint with these instead.
//
//          The custom properties are the skin's dialog tokens (core/theme/
//          tokens.ts `DIALOG_*`, valued in both baselines) and the semantic
//          tones of @api/layout's LT. Each is written with its LIGHT value as
//          the fallback, for the reason @api/layout/theme.ts gives: a bare
//          `var(--x)` inside a shorthand such as `border: 1px solid var(--x)`
//          invalidates the whole declaration when `--x` is missing.
//
//          COLOUR DATA (a format preview, a swatch) is not chrome and does not
//          come from here: mark its element `data-colour-data`.

import { LT } from "@api/layout";

export const DIALOG_THEME = {
  overlay: "var(--dialog-overlay-bg, rgba(0, 0, 0, 0.5))",
  bg: "var(--dialog-bg, #ffffff)",
  border: "var(--dialog-border, #d1d5db)",
  shadow: "var(--dialog-shadow, 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04))",
  title: "var(--dialog-title-text, #111827)",
  text: LT.text,
  textSecondary: LT.textSecondary,
  /** A list or panel inside the dialog (category list, option panel). */
  panelBg: "var(--dialog-details-bg, #f9fafb)",
  divider: "var(--dialog-category-border, #e5e7eb)",
  selectedBg: "var(--dialog-function-selected-bg, #dbeafe)",
  inputBg: "var(--dialog-input-bg, #ffffff)",
  inputBorder: "var(--dialog-input-border, #d1d5db)",
  inputText: "var(--dialog-input-text, #111827)",
  buttonBg: "var(--dialog-button-bg, #ffffff)",
  buttonBorder: "var(--dialog-button-border, #d1d5db)",
  buttonText: "var(--dialog-button-text, #374151)",
  /** The default (OK / Create) button. */
  primaryBg: "var(--dialog-insert-bg, #10b981)",
  primaryText: "var(--dialog-insert-text, #ffffff)",
  errorFg: LT.dangerFg,
  errorBg: LT.dangerBg,
} as const;
