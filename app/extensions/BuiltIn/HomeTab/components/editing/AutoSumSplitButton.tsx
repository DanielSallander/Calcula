//! FILENAME: app/extensions/BuiltIn/HomeTab/components/editing/AutoSumSplitButton.tsx
// PURPOSE: Excel's AutoSum split button for the Home tab's Editing group
//          (CONTRACT 3.14): the sigma half runs AutoSum with SUM; the chevron
//          opens Excel's menu -- Sum, Average, Count Numbers, Max, Min, then
//          More Functions... (the fx dialog).
// CONTEXT: Rendered for the catalog item "autoSum". Every row runs the AutoSum
//          extension's `autosum.insert { fn }` -- the command Alt+= runs --
//          which guesses the range, opens the edit or writes the totals in one
//          undo step, and refuses (protected sheet, canvas, several areas, an
//          object holding the selection) on its own. More Functions... runs
//          `core.formula.insertFunction`, the fx dialog's own door, which works
//          with the formula bar hidden. The ribbon decides none of that
//          (runCommand.ts).
//
//          THE ICON FACE ON EVERY SURFACE. Excel's Editing group shows AutoSum,
//          Fill and Clear as icon-only splits until the window is very wide
//          (the owner's crop, scratchpad excel/editing.png), and the group sits
//          beside two 61px heroes in a two-row grid with no room for a label.
//          The label is the control's NAME (aria-label + tooltip), so nothing
//          is lost to a screen reader.

import React from "react";
import { RibbonIcon } from "@api";
import { CoreCommands, ExtensionCommands } from "@api/commands";
import { SplitMenuButton, MenuItem, MenuSeparator, MENU_ICON_BLANK, ICON_SIZE_SM } from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import { MENU_ROW_ICON_SIZE, runCommand } from "../runCommand";

/** The functions AutoSum accepts (its `{ fn }`), as Excel's menu names them,
 *  in Excel's order. `slug` is the row's test-id suffix. */
export const AUTOSUM_MENU_ROWS = [
  { fn: "SUM", label: "Sum", slug: "sum" },
  { fn: "AVERAGE", label: "Average", slug: "average" },
  { fn: "COUNT", label: "Count Numbers", slug: "countNumbers" },
  { fn: "MAX", label: "Max", slug: "max" },
  { fn: "MIN", label: "Min", slug: "min" },
] as const;

export type AutoSumFunction = (typeof AUTOSUM_MENU_ROWS)[number]["fn"];

/** Run AutoSum with `fn` (the sigma half and the five rows). */
function runAutoSum(fn: AutoSumFunction): void {
  void runCommand(ExtensionCommands.AUTOSUM, { fn });
}

export function AutoSumSplitButton({ item }: HomeItemProps): React.ReactElement {
  const tip = itemTooltip(item);
  const testId = `fmt-${item.id}`;

  return (
    <SplitMenuButton
      face="icon"
      icon={<RibbonIcon.AutoSum size={ICON_SIZE_SM} />}
      label={item.label}
      tooltip={tip.tooltip}
      // The LIVE Alt+= binding: the catalog's "(Alt+=)" is split off by
      // itemTooltip, and while home-core's ITEM_COMMAND_IDS has no entry for
      // this item the chip still resolves through the command the half runs,
      // so a rebound key is never contradicted by a stale literal.
      commandId={tip.commandId ?? ExtensionCommands.AUTOSUM}
      data-testid={testId}
      onClick={() => runAutoSum("SUM")}
      chevronTestId={`${testId}-options`}
      menuLabel={item.label}
    >
      {AUTOSUM_MENU_ROWS.map((row) => (
        <MenuItem
          key={row.fn}
          // Excel pictures only Sum; the others keep its column so the labels
          // line up.
          icon={row.fn === "SUM" ? <RibbonIcon.AutoSum size={MENU_ROW_ICON_SIZE} /> : MENU_ICON_BLANK}
          testId={`${testId}-${row.slug}`}
          // Alt+= is AutoSum with NO fn, i.e. SUM: its chip belongs on Sum
          // only -- on Average it would promise an average.
          shortcutCommandId={row.fn === "SUM" ? ExtensionCommands.AUTOSUM : undefined}
          onSelect={() => runAutoSum(row.fn)}
        >
          {row.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        icon={MENU_ICON_BLANK}
        testId={`${testId}-moreFunctions`}
        shortcutCommandId={CoreCommands.INSERT_FUNCTION}
        onSelect={() => void runCommand(CoreCommands.INSERT_FUNCTION)}
      >
        More Functions...
      </MenuItem>
    </SplitMenuButton>
  );
}
