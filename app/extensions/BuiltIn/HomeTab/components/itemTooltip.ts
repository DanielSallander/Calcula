//! FILENAME: app/extensions/BuiltIn/HomeTab/components/itemTooltip.ts
// PURPOSE: The @api Tooltip props (content, shortcut, commandId) for one Home
//          tab item.
// CONTEXT: The catalog's tooltips carry their shortcut as text — "Cut (Ctrl+X)"
//          — because they were written for a native `title`. The Clusters
//          Tooltip draws the shortcut as its own chip, so a tooltip that kept
//          the text AND got a chip would say the shortcut twice. This splits
//          the parenthesised shortcut off the text, and for a command the
//          keybinding registry knows, hands the Tooltip the COMMAND id instead
//          of the literal: the chip then shows the user's live binding, so a
//          rebound key is never contradicted by a stale tooltip.
//
//          The catalog itself is untouched (ALL_ITEMS is part of the persisted
//          layout's contract); this is a pure view over it.

import { CoreCommands, ExtensionCommands } from "@api/commands";
import type { HomeTabItem } from "../homeTabConfig";

/**
 * Item id -> the command it runs, for the items that run ONE command
 * (mirrors useHomeTabState.handleItemClick, and the main halves of the
 * version-2 splits). Tooltip resolves the chip through whichever keybinding
 * runs that command; a command with no binding simply shows no chip.
 *
 * Map an item to the command its FACE runs, never to a menu row's: a split
 * whose picture runs INSERT must not borrow INSERT_CELLS's Ctrl+Plus, because
 * Ctrl+Plus opens the dialog, not what the picture does. Menus and splits that
 * run no single command (Borders, Orientation, Accounting, Fill, Clear, Sort &
 * Filter, Find & Select, Format, Conditional Formatting, Format as Table, Cell
 * Styles) have no entry: their tooltip is Excel's words alone, as Excel's is.
 * The Format Cells dialog launchers name FORMAT_CELLS themselves (index.ts),
 * so their Ctrl+1 chip is live too.
 */
export const ITEM_COMMAND_IDS: Readonly<Record<string, string>> = {
  cut: CoreCommands.CUT,
  copy: CoreCommands.COPY,
  paste: CoreCommands.PASTE,
  formatPainter: CoreCommands.FORMAT_PAINTER,
  formatCells: CoreCommands.FORMAT_CELLS,
  // The Merge & Center split button's icon half. Unbound by default (Excel has
  // no merge shortcut), so it shows no chip; Ctrl+M is Merge Cells, and its
  // chip is on that row of the button's menu.
  mergeCells: CoreCommands.MERGE_CENTER,
  undo: CoreCommands.UNDO,
  redo: CoreCommands.REDO,
  find: CoreCommands.FIND,
  clearContents: CoreCommands.CLEAR_CONTENTS,
  clearFormatting: CoreCommands.CLEAR_FORMATTING,
  clearAll: CoreCommands.CLEAR_ALL,
  insertRow: CoreCommands.INSERT_ROW,
  insertColumn: CoreCommands.INSERT_COLUMN,
  deleteRow: CoreCommands.DELETE_ROW,
  deleteColumn: CoreCommands.DELETE_COLUMN,
  // Version 2 (Excel's Home tab). AutoSum's face runs AUTOSUM { fn: "SUM" },
  // bound to Alt+= -- the catalog's "(Alt+=)" becomes the live chip.
  autoSum: ExtensionCommands.AUTOSUM,
  // The Insert / Delete pictures run Excel's selection-shape rule (INSERT /
  // DELETE), which no key is bound to: Ctrl+Plus and Ctrl+- open the DIALOG.
  // So no chip, which is also what Excel's Insert and Delete tooltips show.
  insertCells: CoreCommands.INSERT,
  deleteCells: CoreCommands.DELETE,
};

/** A trailing "(Ctrl+X)" / "(Ctrl+Shift+=)" / "(Del)". Only a KEY COMBO is
 *  split off: "Percent Style (%)" and "Clear All (formatting + content +
 *  comments)" keep their parentheses, because those are part of the name. */
const SHORTCUT_SUFFIX = /^(.*?)\s*\(((?:Ctrl|Shift|Alt|Del)[^)]*)\)$/;

export interface ItemTooltipProps {
  /** Tooltip text; undefined when the item has none. */
  tooltip?: string;
  /** Literal shortcut chip, only when no commandId can resolve a live one. */
  shortcut?: string;
  /** Command whose live keybinding the chip shows. */
  commandId?: string;
}

/** The Tooltip props for a Home tab item. */
export function itemTooltip(item: HomeTabItem): ItemTooltipProps {
  const text = item.tooltip ?? item.label;
  const commandId = ITEM_COMMAND_IDS[item.id];
  const match = SHORTCUT_SUFFIX.exec(text);
  const tooltip = match ? match[1] : text;
  if (commandId) return { tooltip, commandId };
  return match ? { tooltip, shortcut: match[2] } : { tooltip };
}
