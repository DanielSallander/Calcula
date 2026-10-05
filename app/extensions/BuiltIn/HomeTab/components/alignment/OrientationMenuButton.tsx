//! FILENAME: app/extensions/BuiltIn/HomeTab/components/alignment/OrientationMenuButton.tsx
// PURPOSE: Excel's Orientation menu for the Home tab's Alignment group
//          (CONTRACT 3.6): a small icon button with a chevron that opens five
//          check rows -- Angle Counterclockwise, Angle Clockwise, Vertical Text,
//          Rotate Text Up, Rotate Text Down -- and, after a separator, Format
//          Cell Alignment.
// CONTEXT: Rendered for the catalog item "orientation" (HomeItemProps; the
//          dispatcher in HomeTabGroupComponent looks it up by id). Built on
//          @api/layout's MenuButton, so the menu has the full popup keyboard
//          model. What the rows hold and run -- and why a rotation is followed
//          by a grow-only AutoFit in the same undo step -- is orientationMenu.ts.
//
//          The check follows the ACTIVE cell's `textRotation` as the ribbon
//          last read it (`state.currentStyle`), and the four angle rows are
//          disabled while that cell has an indent, as in Excel. The button
//          itself has NO pressed state (Excel's Orientation has none), so the
//          trigger never carries aria-pressed.

import React from "react";
import { RibbonIcon, type RibbonIconKey } from "@api";
import { IconButton, MenuButton, MenuItem, MenuSeparator, ICON_SIZE_SM } from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import {
  ORIENTATION_ROWS,
  FORMAT_CELL_ALIGNMENT,
  chooseOrientation,
  openFormatCellAlignment,
} from "./orientationMenu";

/** The button's name when the catalog entry carries none. */
export const ORIENTATION_LABEL = "Orientation";

/** Menu row pictures are drawn on the 20px grid. */
const MENU_ICON_SIZE = 20;

function rowIcon(key: RibbonIconKey): React.ReactNode {
  return React.createElement(RibbonIcon[key], { size: MENU_ICON_SIZE });
}

/**
 * Excel's Orientation menu button. The same 28px icon-and-chevron control in
 * the band and in a panel (Excel's is a small button in the band too, never a
 * hero), so `band` changes nothing here.
 */
export function OrientationMenuButton({ item, state }: HomeItemProps): React.ReactElement {
  const style = state.currentStyle;
  const rotation = style?.textRotation ?? "none";
  const indented = (style?.indent ?? 0) > 0;
  const label = item.label || ORIENTATION_LABEL;
  const tip = itemTooltip(item);

  return (
    <MenuButton
      trigger={
        <IconButton
          icon={<RibbonIcon.TextOrientation size={ICON_SIZE_SM} />}
          label={label}
          chevron
          tooltip={tip.tooltip || label}
          shortcut={tip.shortcut}
          commandId={tip.commandId}
          data-testid={`fmt-${item.id}`}
        />
      }
    >
      {ORIENTATION_ROWS.map((row) => {
        const checked = rotation === row.value;
        return (
          <MenuItem
            key={row.value}
            role="menuitemcheckbox"
            checked={checked}
            disabled={row.angle && indented}
            icon={rowIcon(row.icon)}
            testId={`fmt-${item.id}-${row.slug}`}
            onSelect={() => void chooseOrientation(state, row, checked)}
          >
            {row.label}
          </MenuItem>
        );
      })}
      <MenuSeparator />
      <MenuItem
        icon={rowIcon(FORMAT_CELL_ALIGNMENT.icon)}
        testId={`fmt-${item.id}-${FORMAT_CELL_ALIGNMENT.slug}`}
        onSelect={() => void openFormatCellAlignment()}
      >
        {FORMAT_CELL_ALIGNMENT.label}
      </MenuItem>
    </MenuButton>
  );
}
