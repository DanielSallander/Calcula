//! FILENAME: app/extensions/BuiltIn/HomeTab/components/alignment/AccountingSplitButton.tsx
// PURPOSE: Excel's Accounting Number Format split button for the Home tab's
//          Number group (CONTRACT 3.7): the icon half applies Accounting in the
//          workbook locale's currency, the chevron opens Excel's currency list
//          -- six fixed currencies, a separator, "More Accounting Formats...".
// CONTEXT: Rendered for the catalog item "accountingFormat" (HomeItemProps;
//          the dispatcher in HomeTabGroupComponent looks it up by id). It lives
//          beside the Orientation menu because one lane built both; it belongs
//          to the Number group. What each part writes, and why it is a preset
//          keyword rather than a format code, is accountingMenu.ts.
//
//          No row has a picture in Excel's list, so no row reserves the icon
//          column (no MENU_ICON_BLANK): the symbols start beside the check
//          column, as Excel's do. No row is ever checked and the button has no
//          pressed state, also as in Excel.

import React from "react";
import { RibbonIcon } from "@api";
import { MenuItem, MenuSeparator, SplitMenuButton, ICON_SIZE_SM } from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import {
  ACCOUNTING_LABEL,
  ACCOUNTING_LOCALE_PRESET,
  ACCOUNTING_MENU_ROWS,
  MORE_ACCOUNTING_FORMATS,
  applyAccounting,
  openMoreAccountingFormats,
} from "./accountingMenu";

/**
 * Excel's Accounting Number Format split button: the icon face (`"icon"`),
 * 28px in the band and in a panel alike, so `band` changes nothing here.
 */
export function AccountingSplitButton({ item, state }: HomeItemProps): React.ReactElement {
  const label = item.label || ACCOUNTING_LABEL;
  const tip = itemTooltip(item);

  return (
    <SplitMenuButton
      face="icon"
      icon={<RibbonIcon.Accounting size={ICON_SIZE_SM} />}
      label={label}
      tooltip={tip.tooltip || label}
      shortcut={tip.shortcut}
      commandId={tip.commandId}
      data-testid={`fmt-${item.id}`}
      chevronTestId={`fmt-${item.id}-options`}
      menuLabel={label}
      onClick={() => void applyAccounting(state, ACCOUNTING_LOCALE_PRESET, label)}
    >
      {ACCOUNTING_MENU_ROWS.map((row) => (
        <MenuItem
          key={row.preset}
          testId={`fmt-${item.id}-${row.slug}`}
          onSelect={() => void applyAccounting(state, row.preset, label)}
        >
          {row.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        testId={`fmt-${item.id}-${MORE_ACCOUNTING_FORMATS.slug}`}
        onSelect={() => void openMoreAccountingFormats()}
      >
        {MORE_ACCOUNTING_FORMATS.label}
      </MenuItem>
    </SplitMenuButton>
  );
}
