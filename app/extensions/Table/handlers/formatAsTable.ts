//! FILENAME: app/extensions/Table/handlers/formatAsTable.ts
// PURPOSE: Home > Format as Table: the command `table.formatAsTable { styleId }`
//          (ExtensionCommands.FORMAT_AS_TABLE) and the Format-menu item whose custom
//          content is the table-style gallery.
// CONTEXT: Nothing outside this extension could reach a table style -- the
//          gallery, the catalogue and the write were internal, and the only
//          host was the contextual Table Design tab, which exists only INSIDE
//          a table. So Excel's way of MAKING a table in a style did not exist.
//
//          EXCEL'S RULE, and this command's:
//            - the active cell is inside a table -> that table takes the style
//              (no dialog), announced with TABLE_DEFINITIONS_UPDATED exactly as
//              the Table Design gallery does, so every listener re-reads it;
//            - otherwise -> Create Table opens (range detected around the active
//              cell, "My table has headers" on) with the style's NAME in its
//              data, and the new table is born in that style.
//
//          WHO CALLS IT. The gallery below (the Format menu and, through the
//          kit's RegisteredMenuButton, the Home tab's Format as Table hero:
//          menu "format" > item "format:formatAsTable"), the keyboard and
//          macros. `styleId` is a gallery id (`table-medium-2`) or the name a
//          table stores and scripts speak (`TableStyleMedium2`); anything else
//          is refused in words -- a typo must not open Create Table in the
//          default style and look like success.
//
//          The selection it reads is Core's, so it refuses (once, with the
//          shared message) while another surface owns the selection (BUG-0185).
//          It asks the cell-target question with capability "table", which no
//          owner admits: on a floating grid's cells the owner answers why (a
//          floating grid is already a table-like object; P3, spec 1.3).

import React from "react";
import type { ExtensionContext } from "@api/contract";
import { ExtensionCommands, showDialog, showToast, AppEvents, IconInsertTable } from "@api";
import { emitAppEvent } from "@api/events";
import { getGridStateSnapshot } from "@api/grid";
import { resolveCellTarget } from "@api/cellTarget";
import { getTableAtCell } from "../lib/tableStore";
import { applyTableStyleAsync, resolveTableStyleId, tableStyleNameForId } from "../lib/tableStyles";
import { TABLE_DIALOG_ID } from "../lib/dialogIds";
import { FormatAsTableGallery } from "../components/FormatAsTableGallery";

/** The Format-menu item the Home tab's Format as Table hero hosts (CONTRACT 3.9). */
export const FORMAT_AS_TABLE_MENU_ITEM_ID = "format:formatAsTable";

/** What a caller passes to `table.formatAsTable`. */
export interface FormatAsTableArgs {
  /** A gallery id (`table-light-9`) or a stored style name (`TableStyleLight9`). */
  styleId: string;
}

/**
 * Format as Table. Resolves true when it restyled a table or opened Create
 * Table, false when it refused (an owned selection, an unknown style, a
 * restyle the backend declined -- each already said in a toast). Never rejects.
 */
export async function formatAsTable(args: FormatAsTableArgs | undefined): Promise<boolean> {
  if (resolveCellTarget("Format as Table", "table") === null) return false;

  const styleId = resolveTableStyleId(args?.styleId);
  if (!styleId) {
    showToast(`Format as Table: there is no table style named "${String(args?.styleId ?? "")}".`, {
      variant: "warning",
    });
    return false;
  }

  // Excel asks about the ACTIVE cell: the selection's end, not its anchor.
  const selection = getGridStateSnapshot()?.selection;
  const table = selection ? getTableAtCell(selection.endRow, selection.endCol) : null;

  if (!table) {
    showDialog(TABLE_DIALOG_ID, { styleName: tableStyleNameForId(styleId) });
    return true;
  }

  try {
    const updated = await applyTableStyleAsync(table.id, styleId);
    if (!updated) {
      showToast("Format as Table: the table style could not be applied.", { variant: "error" });
      return false;
    }
  } catch (err) {
    const reason = err instanceof Error && err.message ? err.message : String(err);
    showToast(`Format as Table: the table style could not be applied -- ${reason}`, { variant: "error" });
    return false;
  }
  emitAppEvent(AppEvents.TABLE_DEFINITIONS_UPDATED);
  return true;
}

/**
 * Register the command and the Format-menu item. Returns the cleanup for
 * deactivation: a command left behind would run against a store that
 * deactivation has just emptied, and a menu item would host a gallery whose
 * picks reach no handler.
 */
export function registerFormatAsTable(context: ExtensionContext): () => void {
  context.commands.register(ExtensionCommands.FORMAT_AS_TABLE, (args?: unknown) =>
    formatAsTable(args as FormatAsTableArgs | undefined),
  );

  // After Conditional Formatting in the Format menu, as Excel's Styles group
  // reads (Conditional Formatting, Format as Table, Cell Styles). `order` 1
  // keeps it there whichever extension activates (or re-activates) first.
  context.ui.menus.registerItem("format", {
    id: FORMAT_AS_TABLE_MENU_ITEM_ID,
    label: "Format as Table",
    icon: IconInsertTable,
    order: 1,
    customContent: (onClose: () => void) => React.createElement(FormatAsTableGallery, { onClose }),
  });

  return () => {
    context.commands.unregister(ExtensionCommands.FORMAT_AS_TABLE);
    context.ui.menus.unregisterItem("format", FORMAT_AS_TABLE_MENU_ITEM_ID);
  };
}
