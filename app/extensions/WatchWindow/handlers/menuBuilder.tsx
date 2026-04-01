//! FILENAME: app/extensions/WatchWindow/handlers/menuBuilder.ts
// PURPOSE: Registers Formulas menu item and grid context menu item for Watch Window.
// CONTEXT: Called from the extension's register function.

import React from "react";
import {
  registerMenuItem,
  showDialog,
  gridExtensions,
  GridMenuGroups,
} from "../../../src/api";
import type { GridMenuContext } from "../../../src/api";
import { addWatch, removeWatch, refreshWatches, getItems } from "../lib/watchStore";

const DIALOG_ID = "watch-window";

// ---------------------------------------------------------------------------
// SVG icon for the Formulas menu
// ---------------------------------------------------------------------------

function WatchIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <circle cx={8} cy={8} r={6} stroke="currentColor" strokeWidth={1.2} />
      <path d="M8 4.5V8L10.5 10" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Formulas menu item
// ---------------------------------------------------------------------------

export function registerWatchWindowMenuItem(): void {
  registerMenuItem("formulas", {
    id: "formulas:watchWindow:separator",
    label: "",
    separator: true,
  });

  registerMenuItem("formulas", {
    id: "formulas:watchWindow",
    label: "Watch Window",
    icon: <WatchIcon />,
    action: () => {
      showDialog(DIALOG_ID);
    },
  });
}

// ---------------------------------------------------------------------------
// Grid context menu item: "Add Watch"
// ---------------------------------------------------------------------------

export function registerWatchWindowContextMenu(): void {
  gridExtensions.registerContextMenuItems([
    {
      id: "watch:addWatch",
      label: "Add Watch",
      group: GridMenuGroups.DATA,
      order: 80,
      visible: (ctx: GridMenuContext) => !!ctx.clickedCell,
      onClick: async (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return;
        const { row, col } = ctx.clickedCell;

        // Get sheet info for the context
        const sheetIndex = ctx.sheetIndex;
        const sheetName = ctx.sheetName;

        addWatch(sheetIndex, sheetName, row, col);
        await refreshWatches();

        // Open the Watch Window dialog
        showDialog(DIALOG_ID);
      },
    },
    {
      id: "watch:removeWatch",
      label: "Remove Watch",
      group: GridMenuGroups.DATA,
      order: 81,
      visible: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return false;
        const { row, col } = ctx.clickedCell;
        const items = getItems();
        return items.some(
          (w) =>
            w.sheetIndex === ctx.sheetIndex &&
            w.row === row &&
            w.col === col,
        );
      },
      onClick: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return;
        const { row, col } = ctx.clickedCell;
        const items = getItems();
        const item = items.find(
          (w) =>
            w.sheetIndex === ctx.sheetIndex &&
            w.row === row &&
            w.col === col,
        );
        if (item) {
          removeWatch(item.id);
        }
      },
    },
  ]);
}
