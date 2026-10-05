//! FILENAME: app/extensions/BuiltIn/HomeTab/components/cells/StructureSplitButton.tsx
// PURPOSE: The one shape of Excel's Insert and Delete split buttons (Home >
//          Cells): the picture runs the main-half rule, the label and chevron
//          open a four-row menu -- the Cells... dialog, Sheet Rows, Sheet
//          Columns, then the Sheet. InsertSplitButton and DeleteSplitButton are
//          this component with their own rows.
// CONTEXT: CONTRACT 3.11 / 3.12 (2026-10-04). Built on @api/layout's
//          SplitMenuButton, so the menu has the full popup keyboard model.
//          In the ribbon band it is Excel's LARGE split (face "hero": the 30px
//          picture on top, "Insert v" on ONE line below -- Excel's large Cells
//          group, and the same line count as the Format hero beside it, since
//          a two-line hero's picture sits 6px higher than a one-line hero's);
//          everywhere else -- the sidebar, a collapsed group's launcher flyout
//          -- it is the medium split, [icon Insert][v] in one 28px row.
//
//          WHY ONE COMPONENT. Insert and Delete differ only in their words,
//          their pictures and their command ids; Excel draws them identically,
//          down to where the menu's rules fall. Two hand-written copies would
//          drift on the first fix made to one of them.
//
//          THE MENU'S RULES are Excel 365's, read off its own menu (scratchpad
//          excel-icons/menu-Insert-1.png and menu-Delete-1.png): a rule under
//          the Cells... row and another over the Sheet row, so the dialog, the
//          whole-line commands and the sheet command read as three groups.
//          CONTRACT 3.11 lists only the second; the first is Excel's.
//
//          NOTHING HERE DECIDES. The main half runs core.grid.insert /
//          core.grid.delete -- Excel's main-half rule (whole rows -> rows, whole
//          columns -> columns, otherwise cells, the shift picked from the
//          range's shape), owned by the InsertDeleteCells extension -- and the
//          rows run the commands the sheet-tab menu, the grid's right-click
//          menu and the keyboard run. Each refuses on its own (a protected
//          sheet, a table or PivotTable in the way, the last visible sheet);
//          a thrown refusal reaches the user through runCommand.

import React from "react";
import type { RibbonIconProps } from "@api";
import { SplitMenuButton, MenuItem, MenuSeparator, HERO_ICON_SIZE, ICON_SIZE_SM } from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import { MENU_ROW_ICON_SIZE, runCommand } from "../runCommand";

/** One row of an Insert / Delete menu. */
export interface StructureMenuRow {
  /** The row's words, as Excel's menu says them. */
  label: string;
  /** Test-id suffix: `fmt-<itemId>-<slug>`. */
  slug: "cells" | "rows" | "columns" | "sheet";
  /** The command it runs, with NO args (the Cells... row's dialog). */
  commandId: string;
  /** Its picture (a RibbonIcon component), drawn at 20px. */
  icon: React.ComponentType<RibbonIconProps>;
  /** Show the live binding of `commandId` on the row: only where a key runs
   *  EXACTLY this row (Ctrl+Plus / Ctrl+- the Cells... dialog, Shift+F11
   *  Insert Sheet), never a key that merely resembles it. */
  showShortcut?: boolean;
  /** A rule (MenuSeparator) goes above this row. */
  ruleAbove?: boolean;
}

export interface StructureSplitButtonProps extends HomeItemProps {
  /** The picture of the main half (InsertCells / DeleteCells). */
  icon: React.ComponentType<RibbonIconProps>;
  /** The command the main half runs (Excel's main-half rule). */
  mainCommandId: string;
  /** The menu's rows, in Excel's order. */
  rows: readonly StructureMenuRow[];
}

/** Excel's Insert / Delete split button (see the file header). */
export function StructureSplitButton({
  item,
  band,
  icon,
  mainCommandId,
  rows,
}: StructureSplitButtonProps): React.ReactElement {
  const MainIcon = icon;
  const tip = itemTooltip(item);
  const testId = `fmt-${item.id}`;
  // 30px in the band's hero slot; outside the band the medium split fits its
  // icon to 20px, and the attribute says so too (the surfaces test reads it).
  const iconSize = band ? HERO_ICON_SIZE : ICON_SIZE_SM;

  return (
    <SplitMenuButton
      face={band ? "hero" : "labelled"}
      labelLines={1}
      icon={<MainIcon size={iconSize} />}
      label={item.label}
      tooltip={tip.tooltip}
      // The chip resolves through the command THIS HALF runs, never through
      // the catalog's mapping: Ctrl+Plus / Ctrl+- run the DIALOG (the Cells...
      // row, where their chip is shown), and the main-half rule has no key of
      // its own, so the half honestly shows none. A mapping that pointed the
      // item at INSERT_CELLS would otherwise promise the wrong command here.
      commandId={mainCommandId}
      data-testid={testId}
      onClick={() => void runCommand(mainCommandId)}
      chevronTestId={`${testId}-options`}
      menuLabel={item.label}
    >
      {rows.map((row) => (
        <React.Fragment key={row.slug}>
          {row.ruleAbove && <MenuSeparator />}
          <MenuItem
            icon={<row.icon size={MENU_ROW_ICON_SIZE} />}
            testId={`${testId}-${row.slug}`}
            shortcutCommandId={row.showShortcut ? row.commandId : undefined}
            onSelect={() => void runCommand(row.commandId)}
          >
            {row.label}
          </MenuItem>
        </React.Fragment>
      ))}
    </SplitMenuButton>
  );
}
