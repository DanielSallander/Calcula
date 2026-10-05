//! FILENAME: app/extensions/BuiltIn/HomeTab/components/cells/InsertSplitButton.tsx
// PURPOSE: Excel's Insert split button for the Home tab's Cells group
//          (CONTRACT 3.11): the picture runs Insert (core.grid.insert, Excel's
//          main-half rule), the label and chevron open Excel's menu -- Insert
//          Cells..., Insert Sheet Rows, Insert Sheet Columns, Insert Sheet.
// CONTEXT: Rendered for the catalog item "insertCells". The shape, faces and
//          menu mechanics are StructureSplitButton's, shared with Delete; this
//          file is the rows.
//
//          - Insert Cells... runs core.grid.insertCells with NO args: the
//            Insert dialog (shift right / down / entire row / entire column),
//            or straight to rows / columns for a whole-row / whole-column
//            selection, as Excel's does. Ctrl+Plus runs the same command, so
//            its live chip is shown on this row.
//          - Insert Sheet Rows / Columns run core.grid.insertRow / insertColumn,
//            which act on every row / column the selection SPANS, whatever its
//            shape (Excel's rule; core-grid lane).
//          - Insert Sheet runs core.sheet.insert, which puts a new worksheet
//            BEFORE the active sheet and makes it active (Excel), through the
//            tab strip's own handler, as Shift+F11 does.

import React from "react";
import { RibbonIcon } from "@api";
import { CoreCommands } from "@api/commands";
import type { HomeItemProps } from "../homeItemProps";
import { StructureSplitButton, type StructureMenuRow } from "./StructureSplitButton";

/** Excel's Insert menu, in its order, with its words and pictures. */
export const INSERT_MENU_ROWS: readonly StructureMenuRow[] = [
  {
    label: "Insert Cells...",
    slug: "cells",
    commandId: CoreCommands.INSERT_CELLS,
    icon: RibbonIcon.InsertCells,
    showShortcut: true,
  },
  {
    label: "Insert Sheet Rows",
    slug: "rows",
    commandId: CoreCommands.INSERT_ROW,
    icon: RibbonIcon.InsertRow,
    ruleAbove: true,
  },
  {
    label: "Insert Sheet Columns",
    slug: "columns",
    commandId: CoreCommands.INSERT_COLUMN,
    icon: RibbonIcon.InsertColumn,
  },
  {
    label: "Insert Sheet",
    slug: "sheet",
    commandId: CoreCommands.SHEET_INSERT,
    icon: RibbonIcon.InsertSheet,
    showShortcut: true,
    ruleAbove: true,
  },
];

/** Excel's Insert split button (catalog item "insertCells"). */
export function InsertSplitButton(props: HomeItemProps): React.ReactElement {
  return (
    <StructureSplitButton
      {...props}
      icon={RibbonIcon.InsertCells}
      mainCommandId={CoreCommands.INSERT}
      rows={INSERT_MENU_ROWS}
    />
  );
}
