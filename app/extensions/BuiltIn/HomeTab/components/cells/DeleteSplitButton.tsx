//! FILENAME: app/extensions/BuiltIn/HomeTab/components/cells/DeleteSplitButton.tsx
// PURPOSE: Excel's Delete split button for the Home tab's Cells group
//          (CONTRACT 3.12): the picture runs Delete (core.grid.delete, Excel's
//          main-half rule), the label and chevron open Excel's menu -- Delete
//          Cells..., Delete Sheet Rows, Delete Sheet Columns, Delete Sheet.
// CONTEXT: Rendered for the catalog item "deleteCells". The shape, faces and
//          menu mechanics are StructureSplitButton's, shared with Insert; this
//          file is the rows.
//
//          - Delete Cells... runs core.grid.deleteCells with NO args: the
//            Delete dialog (shift left / up / entire row / entire column), or
//            straight to rows / columns for a whole-row / whole-column
//            selection. Ctrl+- runs the same command, so its live chip is
//            shown on this row.
//          - Delete Sheet Rows / Columns run core.grid.deleteRow / deleteColumn
//            over every row / column the selection spans (Excel's rule).
//          - Delete Sheet runs core.sheet.delete: it refuses the last visible
//            sheet with Excel's sentence and asks first unless the sheet is a
//            blank active worksheet (Excel's rule; shell-sheets lane). No
//            chip: Excel binds no key to it.

import React from "react";
import { RibbonIcon } from "@api";
import { CoreCommands } from "@api/commands";
import type { HomeItemProps } from "../homeItemProps";
import { StructureSplitButton, type StructureMenuRow } from "./StructureSplitButton";

/** Excel's Delete menu, in its order, with its words and pictures. */
export const DELETE_MENU_ROWS: readonly StructureMenuRow[] = [
  {
    label: "Delete Cells...",
    slug: "cells",
    commandId: CoreCommands.DELETE_CELLS,
    icon: RibbonIcon.DeleteCells,
    showShortcut: true,
  },
  {
    label: "Delete Sheet Rows",
    slug: "rows",
    commandId: CoreCommands.DELETE_ROW,
    icon: RibbonIcon.DeleteRow,
    ruleAbove: true,
  },
  {
    label: "Delete Sheet Columns",
    slug: "columns",
    commandId: CoreCommands.DELETE_COLUMN,
    icon: RibbonIcon.DeleteColumn,
  },
  {
    label: "Delete Sheet",
    slug: "sheet",
    commandId: CoreCommands.SHEET_DELETE,
    icon: RibbonIcon.DeleteSheet,
    ruleAbove: true,
  },
];

/** Excel's Delete split button (catalog item "deleteCells"). */
export function DeleteSplitButton(props: HomeItemProps): React.ReactElement {
  return (
    <StructureSplitButton
      {...props}
      icon={RibbonIcon.DeleteCells}
      mainCommandId={CoreCommands.DELETE}
      rows={DELETE_MENU_ROWS}
    />
  );
}
