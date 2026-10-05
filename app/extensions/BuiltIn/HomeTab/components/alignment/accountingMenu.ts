//! FILENAME: app/extensions/BuiltIn/HomeTab/components/alignment/accountingMenu.ts
// PURPOSE: What Excel's Accounting Number Format split button (CONTRACT 3.7)
//          writes: the locale preset on its icon half, the six fixed-currency
//          presets of its menu, and "More Accounting Formats..." (Format Cells
//          on the Number tab's Accounting category).
// CONTEXT: The data and behaviour behind AccountingSplitButton.tsx, kept out of
//          the component file so that file exports only the component.
//
//          Every row writes a PRESET KEYWORD, never a format code. The backend
//          (`apply_formatting`, commands/styles.rs HOME_ACCOUNTING_PRESETS)
//          turns each keyword into a typed Accounting format whose negatives
//          follow the user's REGION (parentheses in en-US, a minus at the left
//          edge elsewhere -- rust-format lane), and the renderer lays the
//          symbol out on the correct side. A code written here would be a
//          second, locale-blind copy of that knowledge.
//
//          Writes go through the Home tab's own formatting door
//          (`state.applyFormat`), which refuses while something else owns the
//          selection and refreshes the ribbon; a refusal that is THROWN reaches
//          the user through alertAsync.

import { CommandRegistry, CoreCommands } from "@api/commands";
import { alertAsync } from "@api/dialogs";
import type { HomeTabState } from "../homeItemProps";

/** The button's name (and the refusal action) when the catalog entry carries
 *  none. Excel's own words. */
export const ACCOUNTING_LABEL = "Accounting Number Format";

/** What the icon half writes: Accounting with the locale's currency symbol. */
export const ACCOUNTING_LOCALE_PRESET = "accounting";

/** One currency row of the menu. */
export interface AccountingMenuRow {
  /** The preset keyword `applyFormatting({ numberFormat })` accepts. */
  preset: string;
  /** Excel's words, symbol first. */
  label: string;
  /** Test-id suffix: the row is `fmt-<itemId>-<slug>`. */
  slug: string;
}

/** Excel's currency rows, in Excel's order (CONTRACT 3.7). */
export const ACCOUNTING_MENU_ROWS: readonly AccountingMenuRow[] = [
  { preset: "accounting_usd", label: "$ English (United States)", slug: "usd" },
  { preset: "accounting_gbp", label: "£ English (United Kingdom)", slug: "gbp" },
  { preset: "accounting_eur_before", label: "€ Euro (€ 123)", slug: "eurBefore" },
  { preset: "accounting_eur_after", label: "€ Euro (123 €)", slug: "eurAfter" },
  { preset: "accounting_cny", label: "¥ Chinese (PRC)", slug: "cny" },
  { preset: "accounting_chf", label: "CHF French (Switzerland)", slug: "chf" },
];

/** The last row: Format Cells, Number tab, Accounting category. */
export const MORE_ACCOUNTING_FORMATS = {
  label: "More Accounting Formats...",
  slug: "more",
} as const;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Write one Accounting preset through the Home tab's door. Never throws. */
export async function applyAccounting(state: HomeTabState, preset: string, action: string): Promise<void> {
  try {
    await state.applyFormat({ numberFormat: preset }, action);
  } catch (err) {
    void alertAsync(messageOf(err));
  }
}

/** More Accounting Formats...: the FORMAT_CELLS command, the ONE door to the
 *  dialog (it refuses while something else owns the selection), opened on the
 *  Number tab with the Accounting category chosen. Never throws. */
export async function openMoreAccountingFormats(): Promise<void> {
  try {
    await CommandRegistry.execute(CoreCommands.FORMAT_CELLS, { tab: "number", category: "accounting" });
  } catch (err) {
    void alertAsync(messageOf(err));
  }
}
