//! FILENAME: app/extensions/BuiltIn/HomeTab/components/editing/FillMenuButton.tsx
// PURPOSE: Excel's Fill menu button for the Home tab's Editing group
//          (CONTRACT 3.15): Down, Right, Up, Left, Series..., Flash Fill.
// CONTEXT: Rendered for the catalog item "fill". The four directions are
//          Core's grid commands (Ctrl+D / Ctrl+R and their two siblings: one
//          row or column copies its neighbour, several copy their own first),
//          Series... is the FillSeries extension's dialog and Flash Fill the
//          FlashFill extension's command (Ctrl+E). Each owner refuses on its
//          own (protected sheet, canvas, an object holding the selection); a
//          thrown refusal reaches the user through runCommand.
//
//          A DIRECTION IS GREYED where Excel greys it -- one row in row 1 for
//          Down, and so on (editingRules.ts `fillHasSource`, measured live) --
//          because there the command has nothing to copy and does nothing.
//          The rule is read from the CURRENT selection while the menu is open:
//          the rows live in FillMenuRows, which mounts only when the menu
//          opens (a closed Popover renders nothing), so a closed Fill button
//          does not re-render on every selection change of a large sheet.
//
//          Excel's deferred extras (CONTRACT 0.1 item 4: Across Worksheets...
//          and Justify) are left OUT, not shown disabled.

import React from "react";
import { RibbonIcon, type RibbonIconProps } from "@api";
import { CoreCommands, ExtensionCommands } from "@api/commands";
import { useGridState } from "@api/grid";
import { cellTargetFor } from "@api/cellTarget";
import { MenuButton, IconButton, MenuItem, MENU_ICON_BLANK, ICON_SIZE_SM } from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import { fillHasSource, fillSourceView, type FillDirection } from "./editingRules";
import { MENU_ROW_ICON_SIZE, runCommand } from "../runCommand";

/** Excel's four direction rows, in its order, with the command each runs. */
const DIRECTION_ROWS: ReadonlyArray<{
  direction: FillDirection;
  label: string;
  commandId: string;
  /** The row's drawing (a RibbonIcon component, drawn at 20px). */
  picture: React.ComponentType<RibbonIconProps>;
}> = [
  { direction: "down", label: "Down", commandId: CoreCommands.FILL_DOWN, picture: RibbonIcon.FillDown },
  { direction: "right", label: "Right", commandId: CoreCommands.FILL_RIGHT, picture: RibbonIcon.FillRight },
  { direction: "up", label: "Up", commandId: CoreCommands.FILL_UP, picture: RibbonIcon.FillUp },
  { direction: "left", label: "Left", commandId: CoreCommands.FILL_LEFT, picture: RibbonIcon.FillLeft },
];

/** The menu's rows. Mounted only while the menu is open. */
function FillMenuRows({ testId }: { testId: string }): React.ReactElement {
  const gridState = useGridState();
  // WHICH cells the fill acts on: a floating grid's own selection when it
  // holds the selection (Core's is then HIDDEN, usually A1, where Down is
  // always grey -- found live 2026-10-17, floating-grid-home FG9), else
  // Core's. Asked without announcing; the command itself refuses aloud.
  const view = fillSourceView(cellTargetFor("content", "Fill"), gridState.selection, gridState.config);

  return (
    <>
      {DIRECTION_ROWS.map(({ direction, label, commandId, picture }) => (
        <MenuItem
          key={direction}
          icon={React.createElement(picture, { size: MENU_ROW_ICON_SIZE })}
          testId={`${testId}-${direction}`}
          // Ctrl+D and Ctrl+R are the only two with a key (Excel's too).
          shortcutCommandId={commandId}
          disabled={view !== "refused" && !fillHasSource(direction, view.selection, view.totalRows, view.totalCols)}
          onSelect={() => void runCommand(commandId)}
        >
          {label}
        </MenuItem>
      ))}
      <MenuItem
        icon={MENU_ICON_BLANK}
        testId={`${testId}-series`}
        onSelect={() => void runCommand(ExtensionCommands.FILL_SERIES)}
      >
        Series...
      </MenuItem>
      <MenuItem
        icon={<RibbonIcon.Lightning size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-flashFill`}
        shortcutCommandId={ExtensionCommands.FLASH_FILL}
        onSelect={() => void runCommand(ExtensionCommands.FLASH_FILL)}
      >
        Flash Fill
      </MenuItem>
    </>
  );
}

export function FillMenuButton({ item }: HomeItemProps): React.ReactElement {
  const tip = itemTooltip(item);
  const testId = `fmt-${item.id}`;

  return (
    <MenuButton
      trigger={
        <IconButton
          icon={<RibbonIcon.FillDown size={ICON_SIZE_SM} />}
          label={item.label}
          chevron
          tooltip={tip.tooltip}
          shortcut={tip.shortcut}
          commandId={tip.commandId}
          data-testid={testId}
        />
      }
    >
      <FillMenuRows testId={testId} />
    </MenuButton>
  );
}
