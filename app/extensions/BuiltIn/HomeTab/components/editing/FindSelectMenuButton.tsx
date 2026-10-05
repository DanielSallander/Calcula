//! FILENAME: app/extensions/BuiltIn/HomeTab/components/editing/FindSelectMenuButton.tsx
// PURPOSE: Excel's Find & Select hero for the Home tab's Editing group
//          (CONTRACT 3.18): Find..., Replace..., Go To..., Go To Special...,
//          then the five quick rows -- Formulas, Notes, Conditional
//          Formatting, Constants, Data Validation -- that select the matching
//          cells directly.
// CONTEXT: Rendered for the catalog item "findSelect". Find and Replace are
//          the Find & Replace dialog's commands (Ctrl+F / Ctrl+H); Go To is
//          the GoToSpecial extension's Go To dialog (F5 / Ctrl+G); Go To
//          Special... is the View menu's `view.goToSpecial`; the quick rows run
//          `goToSpecial.select { criteria }`, the SAME search and selection the
//          Go To Special dialog's OK runs (the whole sheet from one cell,
//          inside the selection otherwise; "No cells were found." when nothing
//          matches). Each criteria is typed as @api/grid's GoToSpecialCriteria,
//          so a misspelling is a compile error, and the test checks each one
//          against the GoToSpecial extension's own validator.
//
//          ON A CANVAS SHEET the rows that search the active sheet's cells are
//          greyed -- Go To Special... (as the View menu greys it) and the five
//          quick rows (`goToSpecial.select` refuses there). Find, Replace and
//          GO TO stay live. CONTRACT 3.18 / the lane brief say "every row but
//          Find/Replace"; Go To is kept live on purpose: its owner (GoToSpecial
//          index.ts) deliberately does NOT refuse on a canvas, because a
//          reference can name a cell on another sheet -- F5, Ctrl+G and Edit >
//          Go To... all work there -- and a ribbon row greyed where every other
//          door to the same command works would be the one door that lies.
//          The set is one constant (FIND_SELECT_ROWS_ON_CANVAS) if the owner
//          decides otherwise.
//
//          Excel's deferred extras (CONTRACT 0.1 item 2: Select Objects and
//          Selection Pane...) are left OUT, not shown disabled.

import React from "react";
import { RibbonIcon } from "@api";
import { CoreCommands, ExtensionCommands } from "@api/commands";
import { useGridState, type GoToSpecialCriteria } from "@api/grid";
import {
  MenuButton,
  CommandButton,
  MenuItem,
  MenuSeparator,
  MENU_ICON_BLANK,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
} from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import { MENU_ROW_ICON_SIZE, runCommand } from "../runCommand";

/** Excel's five quick rows, in its order: label, the criteria
 *  `goToSpecial.select` takes, and the row's test-id suffix. */
export const FIND_SELECT_QUICK_ROWS: ReadonlyArray<{
  label: string;
  criteria: GoToSpecialCriteria;
  slug: string;
}> = [
  { label: "Formulas", criteria: "formulas", slug: "formulas" },
  { label: "Notes", criteria: "notes", slug: "notes" },
  { label: "Conditional Formatting", criteria: "conditionalFormats", slug: "conditionalFormatting" },
  { label: "Constants", criteria: "constants", slug: "constants" },
  { label: "Data Validation", criteria: "dataValidation", slug: "dataValidation" },
];

/** The rows (by test-id suffix) that stay live on a canvas sheet. See
 *  "ON A CANVAS SHEET" above for why Go To is one of them. */
export const FIND_SELECT_ROWS_ON_CANVAS: ReadonlySet<string> = new Set(["find", "replace", "goTo"]);

/** The menu's rows. Mounted only while the menu is open. */
function FindSelectMenuRows({ testId }: { testId: string }): React.ReactElement {
  const onCanvas = useGridState().surface === "canvas";
  const greyed = (slug: string) => onCanvas && !FIND_SELECT_ROWS_ON_CANVAS.has(slug);

  return (
    <>
      <MenuItem
        icon={<RibbonIcon.Find size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-find`}
        shortcutCommandId={CoreCommands.FIND}
        disabled={greyed("find")}
        onSelect={() => void runCommand(CoreCommands.FIND)}
      >
        Find...
      </MenuItem>
      <MenuItem
        icon={<RibbonIcon.Replace size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-replace`}
        shortcutCommandId={CoreCommands.REPLACE}
        disabled={greyed("replace")}
        onSelect={() => void runCommand(CoreCommands.REPLACE)}
      >
        Replace...
      </MenuItem>
      <MenuItem
        icon={<RibbonIcon.GoTo size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-goTo`}
        shortcutCommandId={ExtensionCommands.GO_TO}
        disabled={greyed("goTo")}
        onSelect={() => void runCommand(ExtensionCommands.GO_TO)}
      >
        Go To...
      </MenuItem>
      <MenuItem
        icon={MENU_ICON_BLANK}
        testId={`${testId}-goToSpecial`}
        disabled={greyed("goToSpecial")}
        onSelect={() => void runCommand(ExtensionCommands.GO_TO_SPECIAL)}
      >
        Go To Special...
      </MenuItem>
      <MenuSeparator />
      {FIND_SELECT_QUICK_ROWS.map(({ label, criteria, slug }) => (
        <MenuItem
          key={slug}
          icon={MENU_ICON_BLANK}
          testId={`${testId}-${slug}`}
          disabled={greyed(slug)}
          onSelect={() => void runCommand(ExtensionCommands.GO_TO_SPECIAL_SELECT, { criteria })}
        >
          {label}
        </MenuItem>
      ))}
    </>
  );
}

export function FindSelectMenuButton({ item, band }: HomeItemProps): React.ReactElement {
  const tip = itemTooltip(item);
  const testId = `fmt-${item.id}`;

  return (
    <MenuButton
      trigger={
        <CommandButton
          icon={<RibbonIcon.Find size={band ? HERO_ICON_SIZE : ICON_SIZE_SM} />}
          label={item.shortLabel ?? item.label}
          chevron
          // Agrees with Sort & Filter beside it: Excel's "Find & / Select v".
          labelLines={2}
          tooltip={tip.tooltip}
          shortcut={tip.shortcut}
          commandId={tip.commandId}
          data-testid={testId}
        />
      }
    >
      <FindSelectMenuRows testId={testId} />
    </MenuButton>
  );
}
