//! FILENAME: app/extensions/Protection/handlers/sheetTabGuard.ts
// PURPOSE: Modifies sheet tab context menu items when workbook is protected.
// CONTEXT: Disables Insert/Delete/Rename/Move sheet operations when workbook structure is locked.

import { sheetExtensions, showDialog, CommandRegistry, CoreCommands } from "@api";
import { isCurrentWorkbookProtected } from "../lib/protectionStore";

const PROTECTION_WARNING_DIALOG_ID = "protection-warning";

/** The core sheet-tab items this guard replaces while it is active. */
const OVERRIDDEN_ITEM_IDS = ["core:rename", "core:delete", "core:insertSheet"];

/**
 * Register sheet tab context menu overrides for workbook protection.
 * Re-registers the core menu items with a `disabled` callback that checks workbook protection.
 *
 * Returns the cleanup for deactivation, which puts back the items it replaced
 * (in place: the registry keeps an item's position when it is re-registered).
 * Without it the overrides outlived the extension, pointing at a warning
 * dialog that was no longer registered.
 */
export function registerSheetTabProtection(): () => void {
  const replaced = new Map(
    sheetExtensions
      .getContextMenuItems()
      .filter((item) => OVERRIDDEN_ITEM_IDS.includes(item.id))
      .map((item) => [item.id, item] as const),
  );

  // Override "Rename" - disable when workbook protected
  sheetExtensions.registerContextMenuItem({
    id: "core:rename",
    label: "Rename",
    disabled: () => isCurrentWorkbookProtected(),
    onClick: async (context) => {
      if (isCurrentWorkbookProtected()) {
        showDialog(PROTECTION_WARNING_DIALOG_ID, {
          message: "Workbook structure is protected. You cannot rename sheets.",
        });
        return;
      }
      // The Shell's rename COMMAND for the right-clicked sheet: it asks the one
      // rename prompt every door shares and renames through the tab strip.
      // This override used to carry the third copy of that prompt.
      await CommandRegistry.execute(CoreCommands.SHEET_RENAME, { index: context.index });
    },
  });

  // Override "Delete" - disable when workbook protected or only one sheet
  sheetExtensions.registerContextMenuItem({
    id: "core:delete",
    label: "Delete",
    disabled: (context) => context.totalSheets <= 1 || isCurrentWorkbookProtected(),
    separatorAfter: true,
    onClick: async (context) => {
      if (isCurrentWorkbookProtected()) {
        showDialog(PROTECTION_WARNING_DIALOG_ID, {
          message: "Workbook structure is protected. You cannot delete sheets.",
        });
        return;
      }
      if (context.totalSheets <= 1) return;
      window.dispatchEvent(new CustomEvent("sheet:requestDelete", {
        detail: { index: context.index },
      }));
    },
  });

  // Override "Insert Sheet" - disable when workbook protected
  sheetExtensions.registerContextMenuItem({
    id: "core:insertSheet",
    label: "Insert Sheet",
    disabled: () => isCurrentWorkbookProtected(),
    onClick: async (context) => {
      if (isCurrentWorkbookProtected()) {
        showDialog(PROTECTION_WARNING_DIALOG_ID, {
          message: "Workbook structure is protected. You cannot insert sheets.",
        });
        return;
      }
      // The Shell's insert COMMAND for the right-clicked sheet: Excel inserts
      // the new worksheet BEFORE it, as every other Insert Sheet door does.
      // This override used to dispatch `sheet:requestAdd`, which appended it.
      await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { index: context.index });
    },
  });

  return () => {
    for (const id of OVERRIDDEN_ITEM_IDS) {
      const original = replaced.get(id);
      if (original) sheetExtensions.registerContextMenuItem(original);
      else sheetExtensions.unregisterContextMenuItem(id);
    }
  };
}
